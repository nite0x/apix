// Package aiinstall connects local AI clients to the running Apix MCP endpoint.
package aiinstall

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/pelletier/go-toml/v2"
)

type Target struct {
	EnvironmentID string `json:"environment_id,omitempty"`
	bridge        string
	ID            string `json:"id"`
	Name          string `json:"name"`
	Home          string `json:"home"`
	config        string
	codex         string
	claude        string
}
type Client struct {
	EnvironmentID string            `json:"environment_id,omitempty"`
	Command       string            `json:"-"`
	Args          []string          `json:"-"`
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Path          string            `json:"path,omitempty"`
	Status        string            `json:"status"`
	Error         string            `json:"error,omitempty"`
	Snippet       string            `json:"snippet"`
	Links         map[string]string `json:"links,omitempty"`
	Connection    *Connection       `json:"connection,omitempty"`
}
type Result struct {
	Status     string      `json:"status"`
	Path       string      `json:"path"`
	Backup     string      `json:"backup,omitempty"`
	Connection *Connection `json:"connection,omitempty"`
}
type Installer struct {
	endpoint    string
	targets     []Target
	mu          sync.Mutex
	connections map[string]connectionCache
	probe       func(context.Context, Target, string) (probeResult, error)
}

func New(endpoint string) *Installer {
	home, _ := os.UserHomeDir()
	config := os.Getenv("XDG_CONFIG_HOME")
	if config == "" {
		config = filepath.Join(home, ".config")
	}
	if runtime.GOOS == "windows" {
		config = os.Getenv("APPDATA")
		if config == "" {
			config = filepath.Join(home, "AppData", "Roaming")
		}
	}
	if runtime.GOOS == "darwin" {
		config = filepath.Join(home, "Library", "Application Support")
	}
	name := map[string]string{"linux": "Linux", "darwin": "macOS", "windows": "Windows"}[runtime.GOOS]
	if os.Getenv("WSL_DISTRO_NAME") != "" {
		name = "Ubuntu / WSL"
	}
	return &Installer{endpoint: endpoint, targets: []Target{{ID: "local", Name: name, Home: home, config: config, codex: os.Getenv("CODEX_HOME"), claude: os.Getenv("CLAUDE_CONFIG_DIR")}}}
}

// Windows profiles are discovered only on WSL, without launching an AI client.
func (s *Installer) discoverWindows(ctx context.Context) {
	if runtime.GOOS != "linux" || os.Getenv("WSL_DISTRO_NAME") == "" {
		return
	}
	read := func(variable string) string {
		output, err := exec.CommandContext(ctx, "cmd.exe", "/d", "/c", "echo %"+variable+"%").Output()
		if err != nil {
			return ""
		}
		value := strings.TrimSpace(string(output))
		if strings.ContainsAny(value, "\r\n%") || len(value) < 3 || value[1] != ':' {
			return ""
		}
		converted, err := exec.CommandContext(ctx, "wslpath", "-u", value).Output()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(converted))
	}
	home := read("USERPROFILE")
	if home == "" || !filepath.IsAbs(home) {
		return
	}
	config := read("APPDATA")
	if config == "" {
		config = filepath.Join(home, "AppData", "Roaming")
	}
	s.targets = append(s.targets, Target{ID: "windows", Name: "Windows", Home: home, config: config, codex: read("CODEX_HOME"), claude: read("CLAUDE_CONFIG_DIR")})
}

func (s *Installer) target(id string) (Target, error) {
	for i, t := range s.targets {
		if t.ID == id {
			if wslTarget(t.ID) {
				return s.resolveWSL(i)
			}
			if t.Home != "" {
				return t, nil
			}
		}
	}
	return Target{}, errors.New("安装环境不可用，请刷新后重试")
}
func (s *Installer) client(t Target, id string) (Client, error) {
	if t.EnvironmentID != "" {
		return s.wslClient(t, id)
	}
	c := Client{ID: id, Status: "available"}
	entry := map[string]string{"url": s.endpoint}
	root := "mcpServers"
	switch id {
	case "codex":
		c.Name = "Codex"
		dir := t.codex
		if dir == "" {
			dir = filepath.Join(t.Home, ".codex")
		}
		c.Path = filepath.Join(dir, "config.toml")
		c.Snippet = "[mcp_servers.apix]\nurl = " + fmt.Sprintf("%q", s.endpoint) + "\n"
		return c, nil
	case "claude":
		c.Name = "Claude Code"
		c.Path = filepath.Join(t.Home, ".claude.json")
		if t.claude != "" {
			c.Path = filepath.Join(t.claude, ".claude.json")
		}
		entry["type"] = "http"
	case "cursor":
		c.Name = "Cursor"
		c.Path = filepath.Join(t.Home, ".cursor", "mcp.json")
	case "vscode":
		c.Name = "VS Code / Copilot"
		c.Path = filepath.Join(t.config, "Code", "User", "mcp.json")
		root = "servers"
		entry["type"] = "http"
	case "trae":
		c.Name = "TRAE"
		c.Status = "external"
		encoded, _ := json.Marshal(entry)
		query := url.Values{"type": {"http"}, "name": {"apix"}, "config": {base64.StdEncoding.EncodeToString(encoded)}}
		c.Links = map[string]string{"国际版": "trae://trae.ai-ide/mcp-import?" + query.Encode(), "国内版": "trae-cn://trae.ai-ide/mcp-import?" + query.Encode()}
	default:
		return Client{}, errors.New("不支持的 AI 工具")
	}
	snippet, _ := json.MarshalIndent(map[string]any{root: map[string]any{"apix": entry}}, "", "  ")
	c.Snippet = string(snippet)
	return c, nil
}

// plan never changes a file. Existing conflicting entries are left for the user
// to review; appending to TOML preserves all existing comments and settings.
func (s *Installer) plan(c Client) (original, updated []byte, exists bool, err error) {
	original, exists, err = s.readConfig(c)
	if err != nil {
		return nil, nil, exists, err
	}
	conflict := errors.New("已有不同或停用的 apix 配置，请先在 AI 工具中检查；原文件未修改")
	if c.ID == "codex" {
		var doc map[string]any
		if err = toml.Unmarshal(original, &doc); err != nil {
			return nil, nil, exists, errors.New("现有 TOML 配置无效，请修复后重试")
		}
		if servers, ok := doc["mcp_servers"].(map[string]any); ok {
			if value, found := servers["apix"]; found {
				entry, ok := value.(map[string]any)
				if ok && s.matches(c, entry) && entry["enabled"] != false {
					return original, original, exists, nil
				}
				return nil, nil, exists, conflict
			}
		} else if _, found := doc["mcp_servers"]; found {
			return nil, nil, exists, errors.New("mcp_servers 必须是配置表")
		}
		updated = append(append([]byte{}, original...), []byte("\n"+c.Snippet)...)
		var check map[string]any
		if err = toml.Unmarshal(updated, &check); err != nil {
			return nil, nil, exists, errors.New("当前 TOML 布局无法安全合并，请复制配置手动添加")
		}
		return original, updated, exists, nil
	}
	doc := map[string]json.RawMessage{}
	if exists {
		if err = json.Unmarshal(original, &doc); err != nil || doc == nil {
			return nil, nil, exists, errors.New("现有配置不是有效的 JSON 对象（含注释的配置请手动合并）")
		}
	}
	root := "mcpServers"
	if c.ID == "vscode" {
		root = "servers"
	}
	servers := map[string]json.RawMessage{}
	if raw, found := doc[root]; found {
		if err = json.Unmarshal(raw, &servers); err != nil || servers == nil {
			return nil, nil, exists, errors.New(root + " 必须是 JSON 对象")
		}
	}
	if raw, found := servers["apix"]; found {
		var entry map[string]any
		if json.Unmarshal(raw, &entry) == nil && s.matches(c, entry) && entry["disabled"] != true && (c.EnvironmentID != "" || (c.ID == "cursor" && entry["type"] == nil) || entry["type"] == "http" || entry["type"] == "streamable-http") {
			return original, original, exists, nil
		}
		return nil, nil, exists, conflict
	}
	var addition map[string]map[string]json.RawMessage
	_ = json.Unmarshal([]byte(c.Snippet), &addition)
	servers["apix"] = addition[root]["apix"]
	doc[root], _ = json.Marshal(servers)
	updated, err = json.MarshalIndent(doc, "", "  ")
	updated = append(updated, '\n')
	return original, updated, exists, err
}

func (s *Installer) list(t Target) []Client {
	clients := make([]Client, 0, 5)
	for _, id := range []string{"codex", "claude", "cursor", "trae", "vscode"} {
		c, _ := s.client(t, id)
		if c.Status != "external" {
			before, after, exists, err := s.plan(c)
			if err != nil {
				c.Status = "blocked"
				c.Error = err.Error()
			} else if exists && bytes.Equal(before, after) {
				c.Status = "configured"
			}
		}
		if cached, ok := s.connections[t.ID+"/"+id]; ok && time.Since(cached.result.CheckedAt) < 5*time.Minute {
			if fingerprint, err := s.fingerprint(c); err == nil && fingerprint == cached.fingerprint {
				value := cached.result
				c.Connection = &value
			}
		}
		clients = append(clients, c)
	}
	return clients
}

func (s *Installer) install(t Target, id string) (Result, error) {
	c, err := s.client(t, id)
	if err != nil {
		return Result{}, err
	}
	if c.Status == "external" {
		return Result{}, errors.New("请通过 TRAE 安装链接导入配置")
	}
	original, updated, exists, err := s.plan(c)
	if err != nil {
		return Result{}, err
	}
	return s.writeConfig(c, original, updated, exists, "installed")
}
func (s *Installer) writeConfig(c Client, original, updated []byte, exists bool, status string) (Result, error) {
	if c.EnvironmentID != "" {
		return s.writeWSL(c, original, updated, exists, status)
	}
	result := Result{Status: "configured", Path: c.Path}
	if exists && bytes.Equal(original, updated) {
		return result, nil
	}
	if err := os.MkdirAll(filepath.Dir(c.Path), 0700); err != nil {
		return Result{}, errors.New("无法创建配置目录，请检查访问权限")
	}
	// Exclusive backup creation ensures an earlier backup is never overwritten.
	if exists {
		backup, e := os.CreateTemp(filepath.Dir(c.Path), filepath.Base(c.Path)+".apix-backup-*")
		if e != nil {
			return Result{}, errors.New("无法备份配置，已取消安装")
		}
		result.Backup = backup.Name()
		_, e = backup.Write(original)
		closeErr := backup.Close()
		if e != nil || closeErr != nil {
			return Result{}, errors.New("备份失败，已取消安装")
		}
	}
	temporary, err := os.CreateTemp(filepath.Dir(c.Path), ".apix-install-*")
	if err != nil {
		return Result{}, errors.New("无法创建临时配置文件")
	}
	defer os.Remove(temporary.Name())
	_, err = temporary.Write(updated)
	if err == nil {
		err = temporary.Sync()
	}
	closeErr := temporary.Close()
	if err != nil || closeErr != nil {
		return Result{}, errors.New("写入配置失败，原文件未修改")
	}
	if exists {
		info, e := os.Lstat(c.Path)
		current, readErr := os.ReadFile(c.Path)
		if e != nil || !info.Mode().IsRegular() || readErr != nil || !bytes.Equal(current, original) {
			return Result{}, errors.New("配置刚刚被其他程序修改，请刷新后重试")
		}
		if err = os.Chmod(temporary.Name(), info.Mode().Perm()); err != nil {
			return Result{}, errors.New("无法保留配置文件权限")
		}
	} else if _, e := os.Lstat(c.Path); !os.IsNotExist(e) {
		return Result{}, errors.New("配置刚刚被其他程序创建，请刷新后重试")
	}
	if err = os.Rename(temporary.Name(), c.Path); err != nil {
		return Result{}, errors.New("无法替换配置文件，请检查权限或关闭占用该文件的程序")
	}
	result.Status = status
	return result, nil
}

func (s *Installer) Routes(r gin.IRouter) {
	discover := func(c *gin.Context) {
		if !wslTarget(c.Query("target")) && len(s.targets) > 1 && runtime.GOOS != "windows" {
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
		defer cancel()
		s.discoverWindows(ctx)
		s.discoverWSL(ctx)
	}
	// This file-writing API is restricted to the workbench's exact origin even
	// when the runtime allows additional origins for ordinary API operations.
	local := func(c *gin.Context) {
		host, _, hostErr := net.SplitHostPort(c.Request.Host)
		if hostErr != nil {
			host = c.Request.Host
		}
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			c.AbortWithStatus(403)
			return
		}
		origin := c.GetHeader("Origin")
		if (origin != "" && origin != "http://"+c.Request.Host) || c.GetHeader("Sec-Fetch-Site") == "cross-site" {
			c.AbortWithStatus(403)
			return
		}
		c.Header("Cache-Control", "no-store")
		c.Next()
	}
	group := r.Group("/api/ai-tools", local)
	s.removalRoutes(group)
	group.GET("", func(c *gin.Context) {
		s.mu.Lock()
		defer s.mu.Unlock()
		discover(c)
		id := c.DefaultQuery("target", "local")
		target, err := s.target(id)
		if err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, gin.H{"endpoint": s.endpoint, "targets": s.targets, "target": id, "clients": s.list(target)})
	})
	group.POST("/:id/test", func(c *gin.Context) {
		if !strings.HasPrefix(strings.ToLower(c.GetHeader("Content-Type")), "application/json") {
			c.JSON(415, gin.H{"error": "需要 application/json"})
			return
		}
		var input struct {
			Target string `json:"target"`
		}
		if err := c.ShouldBindJSON(&input); err != nil || input.Target == "" {
			c.JSON(400, gin.H{"error": "请选择安装环境"})
			return
		}
		s.mu.Lock()
		discover(c)
		target, err := s.target(input.Target)
		_, clientErr := s.client(target, c.Param("id"))
		s.mu.Unlock()
		if err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		if clientErr != nil {
			c.JSON(400, gin.H{"error": clientErr.Error()})
			return
		}
		c.JSON(200, s.testConnection(c.Request.Context(), target, c.Param("id")))
	})
	group.POST("/:id/install", func(c *gin.Context) {
		if !strings.HasPrefix(strings.ToLower(c.GetHeader("Content-Type")), "application/json") {
			c.JSON(415, gin.H{"error": "需要 application/json"})
			return
		}
		var input struct {
			Target string `json:"target"`
		}
		if err := c.ShouldBindJSON(&input); err != nil || input.Target == "" {
			c.JSON(400, gin.H{"error": "请选择安装环境"})
			return
		}
		s.mu.Lock()
		discover(c)
		target, err := s.target(input.Target)
		if err != nil {
			s.mu.Unlock()
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		result, err := s.install(target, c.Param("id"))
		s.mu.Unlock()
		if err != nil {
			c.JSON(409, gin.H{"error": err.Error()})
			return
		}
		connection := s.testConnection(c.Request.Context(), target, c.Param("id"))
		result.Connection = &connection
		c.JSON(200, result)
	})
}
