// Package executionenv runs programs in the host environment or a Windows-managed WSL distribution.
package executionenv

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const Protocol = 1

type Spec struct {
	EnvironmentID string            `json:"environment_id,omitempty"`
	Program       string            `json:"program"`
	Args          []string          `json:"args"`
	WorkDir       string            `json:"work_dir"`
	Env           map[string]string `json:"env,omitempty"`
	Stdin         string            `json:"stdin,omitempty"`
}
type Environment struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Platform     string `json:"platform"`
	Distribution string `json:"distribution,omitempty"`
	User         string `json:"user,omitempty"`
	Running      bool   `json:"running"`
	WorkDir      string `json:"work_dir,omitempty"`
	Program      string `json:"program,omitempty"`
	Home         string `json:"home,omitempty"`
	ConfigHome   string `json:"config_home,omitempty"`
	CodexHome    string `json:"codex_home,omitempty"`
	ClaudeHome   string `json:"claude_home,omitempty"`
}
type Health struct {
	Unavailable bool   `json:"unavailable,omitempty"`
	Healthy     bool   `json:"healthy"`
	Available   bool   `json:"available"`
	Error       string `json:"error,omitempty"`
}
type Process interface {
	PID() int
	Wait() error
	Stop() error
	ExitCode() int
}

func Local(id string) bool { return id == "" || id == "local" }
func WSLID(distro, user string) string {
	return "wsl:" + strings.ReplaceAll(url.PathEscape(distro), ":", "%3A") + ":" + strings.ReplaceAll(url.PathEscape(user), ":", "%3A")
}
func Parse(id string) (distro, user string, err error) {
	parts := strings.Split(id, ":")
	if len(parts) != 3 || parts[0] != "wsl" {
		return "", "", errors.New("运行环境无效")
	}
	distro, err = url.PathUnescape(parts[1])
	if err != nil {
		return
	}
	user, err = url.PathUnescape(parts[2])
	if err != nil {
		return
	}
	if distro == "" || strings.HasPrefix(distro, "-") || strings.ContainsAny(distro+user, "\x00\r\n") || strings.HasPrefix(user, "-") {
		err = errors.New("WSL 发行版或用户无效")
	}
	return
}
func Validate(s Spec) error {
	if !Local(s.EnvironmentID) {
		if _, _, err := Parse(s.EnvironmentID); err != nil {
			return err
		}
	}
	if strings.ContainsRune(s.WorkDir, 0) || strings.ContainsRune(s.Program, 0) {
		return errors.New("路径或程序不能包含空字符")
	}
	if s.WorkDir != "" {
		absolute := filepath.IsAbs(s.WorkDir)
		if !Local(s.EnvironmentID) {
			absolute = path.IsAbs(s.WorkDir)
		}
		if !absolute {
			return errors.New("工作目录需要是目标环境内的绝对路径")
		}
	}
	for _, arg := range s.Args {
		if strings.ContainsRune(arg, 0) {
			return errors.New("参数不能包含空字符")
		}
	}
	for k, v := range s.Env {
		if k == "" || strings.ContainsAny(k, "=\x00") || strings.ContainsRune(v, 0) {
			return errors.New("环境变量无效")
		}
	}
	return nil
}
func LocalInfo() Environment {
	home, _ := os.UserHomeDir()
	cwd, _ := os.Getwd()
	name := map[string]string{"windows": "Windows 本机", "linux": "Linux 本机", "darwin": "macOS 本机"}[runtime.GOOS]
	return Environment{ID: "local", Name: name, Platform: runtime.GOOS, Running: true, Home: home, WorkDir: cwd, ConfigHome: os.Getenv("XDG_CONFIG_HOME"), CodexHome: os.Getenv("CODEX_HOME"), ClaudeHome: os.Getenv("CLAUDE_CONFIG_DIR")}
}
func environment(s Spec) []string {
	values := map[string]string{}
	key := func(k string) string {
		if runtime.GOOS == "windows" {
			return strings.ToUpper(k)
		}
		return k
	}
	for _, entry := range os.Environ() {
		k, v, ok := strings.Cut(entry, "=")
		if ok {
			values[key(k)] = v
		}
	}
	// WSL's imported Windows PATH must never select a Windows tool for a Linux service.
	if os.Getenv("APIX_EXECUTOR") == "1" && runtime.GOOS == "linux" {
		paths := []string{}
		for _, p := range filepath.SplitList(values["PATH"]) {
			if p != "" && !strings.HasPrefix(p, "/mnt/") {
				paths = append(paths, p)
			}
		}
		values["PATH"] = strings.Join(paths, string(os.PathListSeparator))
	}
	for k, v := range s.Env {
		values[key(k)] = v
	}
	if s.WorkDir != "" {
		values["PWD"] = s.WorkDir
	}
	keys := []string{}
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := []string{}
	for _, k := range keys {
		out = append(out, k+"="+values[k])
	}
	return out
}
func localCommand(s Spec) (*exec.Cmd, error) {
	if err := Validate(s); err != nil {
		return nil, err
	}
	if s.WorkDir != "" {
		st, err := os.Stat(s.WorkDir)
		if err != nil || !st.IsDir() {
			return nil, errors.New("work_dir must be an existing directory")
		}
	}
	program := s.Program
	if program == "" {
		return nil, errors.New("启动程序不能为空")
	}
	env := environment(s)
	if !filepath.IsAbs(program) {
		if strings.ContainsRune(program, os.PathSeparator) {
			base := s.WorkDir
			if base == "" {
				base, _ = os.Getwd()
			}
			program = filepath.Join(base, program)
		} else {
			// Resolve against the target environment, including an explicitly configured PATH.
			search := ""
			for _, v := range env {
				k, p, ok := strings.Cut(v, "=")
				if ok && strings.EqualFold(k, "PATH") {
					search = p
				}
			}
			found := ""
			for _, dir := range filepath.SplitList(search) {
				if !filepath.IsAbs(dir) {
					continue
				}
				candidate := filepath.Join(dir, program)
				if runtime.GOOS == "windows" {
					extensions := []string{""}
					if filepath.Ext(program) == "" {
						extensions = append(extensions, ".exe", ".com", ".bat", ".cmd")
					}
					for _, ext := range extensions {
						if st, err := os.Stat(candidate + ext); err == nil && !st.IsDir() {
							found = candidate + ext
							break
						}
					}
				} else if st, err := os.Stat(candidate); err == nil && !st.IsDir() && st.Mode()&0111 != 0 {
					found = candidate
				}
				if found != "" {
					break
				}
			}
			if found == "" {
				return nil, fmt.Errorf("目标环境找不到启动程序 %q，请设置 PATH 或填写绝对路径", program)
			}
			program = found
		}
	}
	st, err := os.Stat(program)
	if err != nil || st.IsDir() {
		return nil, fmt.Errorf("目标环境中的启动程序不存在或不是文件: %s", program)
	}
	if runtime.GOOS != "windows" && st.Mode()&0111 == 0 {
		return nil, fmt.Errorf("目标环境中的启动程序没有执行权限: %s", program)
	}
	cmd := exec.Command(program, s.Args...)
	cmd.Dir = s.WorkDir
	cmd.Env = env
	cmd.Stdin = strings.NewReader(s.Stdin)
	cmd.WaitDelay = time.Second
	return cmd, nil
}
func Check(ctx context.Context, s Spec) (Environment, error) {
	if err := ctx.Err(); err != nil {
		return Environment{}, err
	}
	if err := Validate(s); err != nil {
		return Environment{}, err
	}
	if !Local(s.EnvironmentID) {
		return remoteCheck(ctx, s)
	}
	info := LocalInfo()
	if s.WorkDir != "" {
		st, err := os.Stat(s.WorkDir)
		if err != nil || !st.IsDir() {
			return info, errors.New("work_dir must be an existing directory")
		}
		info.WorkDir = s.WorkDir
	}
	if s.Program != "" {
		cmd, err := localCommand(s)
		if err != nil {
			return info, err
		}
		info.Program = cmd.Path
	}
	return info, nil
}
func Start(ctx context.Context, s Spec, stdout, stderr io.Writer) (Process, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !Local(s.EnvironmentID) {
		return remoteStart(ctx, s, stdout, stderr)
	}
	cmd, err := localCommand(s)
	if err != nil {
		return nil, err
	}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	tree, err := startProcess(cmd)
	if err != nil {
		return nil, err
	}
	return &localProcess{cmd: cmd, tree: tree}, nil
}

type localProcess struct {
	cmd  *exec.Cmd
	tree *processTree
}

func (p *localProcess) PID() int    { return p.cmd.Process.Pid }
func (p *localProcess) Wait() error { return p.cmd.Wait() }
func (p *localProcess) Stop() error { return p.tree.stop() }
func (p *localProcess) ExitCode() int {
	if p.cmd.ProcessState == nil {
		return -1
	}
	return p.cmd.ProcessState.ExitCode()
}
func Probe(ctx context.Context, id, address string) Health {
	if !Local(id) {
		return remoteProbe(ctx, id, address)
	}
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return Health{Error: err.Error()}
	}
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}}
	defer client.CloseIdleConnections()
	res, err := client.Do(req)
	if err != nil {
		return Health{Error: err.Error()}
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	return Health{Healthy: res.StatusCode >= 200 && res.StatusCode < 300, Available: true}
}

type message struct {
	Config       Configuration `json:"config,omitempty"`
	Protocol     int           `json:"protocol,omitempty"`
	Type         string        `json:"type"`
	Spec         Spec          `json:"spec,omitempty"`
	Address      string        `json:"address,omitempty"`
	Data         []byte        `json:"data,omitempty"`
	PID          int           `json:"pid,omitempty"`
	Code         int           `json:"code,omitempty"`
	Error        string        `json:"error,omitempty"`
	CleanupError string        `json:"cleanup_error,omitempty"`
	Info         Environment   `json:"info,omitempty"`
	Health       Health        `json:"health,omitempty"`
}

func encode(w io.Writer, v any) error { return json.NewEncoder(w).Encode(v) }
