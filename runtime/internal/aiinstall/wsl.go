package aiinstall

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/apix/apix/runtime/internal/executionenv"
	"os"
	"path"
	"runtime"
	"strings"
	"sync"
	"time"
)

func (s *Installer) discoverWSL(ctx context.Context) {
	if runtime.GOOS != "windows" {
		return
	}
	envs, _ := executionenv.Discover(ctx)
	for _, env := range envs {
		if env.Distribution == "" {
			continue
		}
		found := false
		for _, t := range s.targets {
			d, _, _ := executionenv.Parse(t.ID)
			if d == env.Distribution {
				found = true
			}
		}
		if !found {
			s.targets = append(s.targets, Target{ID: env.ID, Name: env.Name})
		}
	}
}
func (s *Installer) resolveWSL(index int) (Target, error) {
	t := s.targets[index]
	if t.EnvironmentID != "" {
		return t, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	info, err := executionenv.Check(ctx, executionenv.Spec{EnvironmentID: t.ID})
	if err != nil {
		return t, err
	}
	t.EnvironmentID = info.ID
	t.Home = info.Home
	t.Name = info.Name
	t.config = info.ConfigHome
	if t.config == "" {
		t.config = path.Join(t.Home, ".config")
	}
	t.codex = info.CodexHome
	t.claude = info.ClaudeHome
	exe, err := os.Executable()
	if err != nil {
		return t, err
	}
	t.bridge, err = executionenv.WSLPath(ctx, info.ID, exe)
	if err != nil {
		return t, err
	}
	s.targets[index] = t
	return t, nil
}
func (s *Installer) readConfig(c Client) ([]byte, bool, error) {
	if c.EnvironmentID != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		result, err := executionenv.Config(ctx, c.EnvironmentID, executionenv.Configuration{Path: c.Path})
		return result.Data, result.Exists, err
	}
	info, err := os.Lstat(c.Path)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if !info.Mode().IsRegular() || info.Size() > 8<<20 {
		return nil, true, errors.New("配置必须是小于 8 MB 的普通文件；符号链接请手动配置")
	}
	data, err := os.ReadFile(c.Path)
	return data, true, err
}
func (s *Installer) writeWSL(c Client, original, updated []byte, exists bool, status string) (Result, error) {
	if exists && bytes.Equal(original, updated) {
		return Result{Status: "configured", Path: c.Path}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	v, err := executionenv.Config(ctx, c.EnvironmentID, executionenv.Configuration{Path: c.Path, Exists: exists, Expected: original, Data: updated, Write: true})
	if err != nil {
		return Result{}, err
	}
	return Result{Status: status, Path: c.Path, Backup: v.Backup}, nil
}
func (s *Installer) wslClient(t Target, id string) (Client, error) {
	c := Client{ID: id, Status: "available", EnvironmentID: t.EnvironmentID, Command: t.bridge, Args: []string{"mcp-stdio", "--url", s.endpoint}}
	entry := map[string]any{"command": c.Command, "args": c.Args}
	root := "mcpServers"
	switch id {
	case "codex":
		c.Name = "Codex"
		dir := t.codex
		if dir == "" {
			dir = path.Join(t.Home, ".codex")
		}
		c.Path = path.Join(dir, "config.toml")
		args, _ := json.Marshal(c.Args)
		c.Snippet = fmt.Sprintf("[mcp_servers.apix]\ncommand = %q\nargs = %s\n", c.Command, args)
		return c, nil
	case "claude":
		c.Name = "Claude Code"
		c.Path = path.Join(t.Home, ".claude.json")
		if t.claude != "" {
			c.Path = path.Join(t.claude, ".claude.json")
		}
		entry["type"] = "stdio"
	case "cursor":
		c.Name = "Cursor"
		c.Path = path.Join(t.Home, ".cursor", "mcp.json")
	case "vscode":
		c.Name = "VS Code / Copilot"
		c.Path = path.Join(t.config, "Code", "User", "mcp.json")
		root = "servers"
		entry["type"] = "stdio"
	case "trae":
		c.Name = "TRAE"
		c.Status = "external"
		c.Snippet = "WSL 内请使用支持 stdio 的客户端连接 Apix。Windows TRAE 请切换至 Windows 环境安装 HTTP MCP。"
		return c, nil
	default:
		return c, errors.New("不支持的 AI 工具")
	}
	raw, _ := json.MarshalIndent(map[string]any{root: map[string]any{"apix": entry}}, "", "  ")
	c.Snippet = string(raw)
	return c, nil
}
func probeWSL(ctx context.Context, t Target, endpoint string) (probeResult, error) {
	// Launch the actual Windows bridge from the selected Linux environment.
	// Disabled WSL interop therefore fails this test instead of giving a false pass.
	var out limitedOutput
	p, err := executionenv.Start(ctx, executionenv.Spec{EnvironmentID: t.EnvironmentID, Program: t.bridge, Args: []string{"mcp-probe", "--url", endpoint}}, &out, &out)
	if err != nil {
		return probeResult{}, err
	}
	done := make(chan error, 1)
	go func() { done <- p.Wait() }()
	select {
	case err = <-done:
	case <-ctx.Done():
		_ = p.Stop()
		return probeResult{}, ctx.Err()
	}
	stopErr := p.Stop()
	if err != nil || stopErr != nil || p.ExitCode() != 0 {
		return probeResult{}, fmt.Errorf("WSL 无法运行 Windows MCP 桥接，请检查 WSL 互操作和 Windows Apix：%s", out.data)
	}
	var result probeResult
	if err = json.Unmarshal(out.data, &result); err != nil {
		return result, errors.New("MCP 桥接返回无效结果")
	}
	return result, nil
}

type limitedOutput struct {
	mu   sync.Mutex
	data []byte
}

func (b *limitedOutput) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	if len(b.data) < 65536 {
		end := 65536 - len(b.data)
		if len(p) > end {
			p = p[:end]
		}
		b.data = append(b.data, p...)
	}
	return n, nil
}
func wslTarget(id string) bool { return strings.HasPrefix(id, "wsl:") }

func (s *Installer) matches(c Client, entry map[string]any) bool {
	if c.EnvironmentID == "" {
		return entry["url"] == s.endpoint && entry["command"] == nil
	}
	if entry["url"] != nil || entry["command"] != c.Command {
		return false
	}
	raw, _ := json.Marshal(entry["args"])
	want, _ := json.Marshal(c.Args)
	return string(raw) == string(want)
}
