package executionenv

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
)

func wslCommand(ctx context.Context, distro, user string, args ...string) *exec.Cmd {
	argv := []string{"--distribution", distro}
	if user != "" {
		argv = append(argv, "--user", user)
	}
	argv = append(argv, "--cd", "~", "--exec")
	argv = append(argv, args...)
	cmd := exec.CommandContext(ctx, "wsl.exe", argv...)
	hideWindow(cmd)
	return cmd
}
func wslText(v []byte) string {
	if bytes.IndexByte(v, 0) >= 0 {
		words := []uint16{}
		for i := 0; i+1 < len(v); i += 2 {
			words = append(words, uint16(v[i])|uint16(v[i+1])<<8)
		}
		return strings.TrimPrefix(string(utf16.Decode(words)), "\ufeff")
	}
	return strings.TrimPrefix(string(v), "\ufeff")
}

// Discover lists distributions without starting stopped environments.
func Discover(ctx context.Context) ([]Environment, error) {
	out := []Environment{LocalInfo()}
	if runtime.GOOS != "windows" {
		return out, nil
	}
	list := exec.CommandContext(ctx, "wsl.exe", "--list", "--quiet")
	hideWindow(list)
	raw, err := list.Output()
	if err != nil {
		return out, fmt.Errorf("无法枚举 WSL，请确认已安装 WSL：%w", err)
	}
	runningCmd := exec.CommandContext(ctx, "wsl.exe", "--list", "--running", "--quiet")
	hideWindow(runningCmd)
	runningRaw, _ := runningCmd.Output()
	running := map[string]bool{}
	for _, v := range strings.Split(wslText(runningRaw), "\n") {
		running[strings.TrimSpace(v)] = true
	}
	for _, line := range strings.Split(wslText(raw), "\n") {
		d := strings.TrimSpace(line)
		if d == "" {
			continue
		}
		out = append(out, Environment{ID: WSLID(d, ""), Name: "WSL · " + d, Platform: "linux", Distribution: d, Running: running[d]})
	}
	return out, nil
}

var deployMu sync.Mutex
var deployed = map[string]string{}

func helper(ctx context.Context, id string) (string, string, string, error) {
	if runtime.GOOS != "windows" {
		return "", "", "", errors.New("WSL 执行环境需要 Windows 版 Apix；Linux 本机请使用本机环境")
	}
	distro, user, err := Parse(id)
	if err != nil {
		return "", "", "", err
	}
	deployMu.Lock()
	defer deployMu.Unlock()
	if p := deployed[id]; p != "" {
		return distro, user, p, nil
	}
	architecture, err := wslCommand(ctx, distro, user, "uname", "-m").Output()
	if err != nil {
		return "", "", "", fmt.Errorf("无法启动 WSL 发行版或用户：%w", err)
	}
	arch := map[string]string{"x86_64": "amd64", "aarch64": "arm64"}[strings.TrimSpace(string(architecture))]
	if arch == "" {
		return "", "", "", errors.New("WSL 执行助手仅支持 x86_64 和 aarch64")
	}
	exe, err := os.Executable()
	if err != nil {
		return "", "", "", err
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(exe), "executors", "linux-"+arch, "apix-executor"))
	if err != nil {
		return "", "", "", fmt.Errorf("安装包缺少 Linux 执行助手，请重新安装 Apix：%w", err)
	}
	sum := sha256.Sum256(data)
	version := hex.EncodeToString(sum[:])
	// All shell code is constant. Binary content is stdin; hash is a positional
	// argument, never interpolated with user-supplied command text.
	script := `set -eu
umask 077
dir="$HOME/.cache/apix/executors/$1"
mkdir -p "$dir"
tmp=$(mktemp "$dir/.install-XXXXXX")
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"
chmod 700 "$tmp"
mv -f "$tmp" "$dir/apix-executor"
printf '%s' "$dir/apix-executor"
`
	cmd := wslCommand(ctx, distro, user, "sh", "-c", script, "apix", version)
	cmd.Stdin = bytes.NewReader(data)
	output, err := cmd.Output()
	if err != nil {
		return "", "", "", fmt.Errorf("WSL 执行助手准备失败：%w", err)
	}
	p := strings.TrimSpace(string(output))
	if !strings.HasPrefix(p, "/") {
		return "", "", "", errors.New("WSL 助手返回的路径无效")
	}
	deployed[id] = p
	return distro, user, p, nil
}
func executorCommand(ctx context.Context, id, mode string) (*exec.Cmd, error) {
	d, u, p, err := helper(ctx, id)
	if err != nil {
		return nil, err
	}
	// Login setup is only used to obtain the user's toolchain environment. The
	// executable and argument array are carried separately in the JSON protocol.
	return wslCommand(ctx, d, u, "bash", "-lc", `exec "$1" "$2"`, "apix", p, mode), nil
}
func remoteOnce(ctx context.Context, id, mode string, request message) (message, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd, err := executorCommand(ctx, id, mode)
	if err != nil {
		return message{}, err
	}
	request.Protocol = Protocol
	data, _ := json.Marshal(request)
	cmd.Stdin = bytes.NewReader(append(data, '\n'))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		return message{}, fmt.Errorf("WSL 环境通信失败（请检查发行版、用户和登录配置）：%w: %.1024s", err, stderr.String())
	}
	var reply message
	if err = json.Unmarshal(output, &reply); err != nil {
		return reply, errors.New("WSL 登录脚本向 stdout 输出了额外内容，请保持非交互登录输出为空")
	}
	if reply.Protocol != Protocol {
		return reply, errors.New("WSL 执行助手版本不兼容")
	}
	if reply.Error != "" {
		return reply, errors.New(reply.Error)
	}
	return reply, nil
}
func remoteCheck(ctx context.Context, s Spec) (Environment, error) {
	reply, err := remoteOnce(ctx, s.EnvironmentID, "check", message{Spec: s})
	if err != nil {
		return reply.Info, err
	}
	d, _, _ := Parse(s.EnvironmentID)
	info := reply.Info
	info.ID = WSLID(d, info.User)
	info.Name = "WSL · " + d + " · " + info.User
	info.Distribution = d
	deployMu.Lock()
	deployed[info.ID] = deployed[s.EnvironmentID]
	deployMu.Unlock()
	return info, nil
}
func remoteProbe(ctx context.Context, id, address string) Health {
	reply, err := remoteOnce(ctx, id, "probe", message{Address: address})
	if err != nil {
		return Health{Error: err.Error(), Unavailable: true}
	}
	return reply.Health
}

type remoteProcess struct {
	output              io.ReadCloser
	cmd                 *exec.Cmd
	control             io.WriteCloser
	decoder             *json.Decoder
	stdout, stderr      io.Writer
	pid                 int
	done                chan struct{}
	mu                  sync.Mutex
	code                int
	waitErr, cleanupErr error
	stopping            bool
}

func remoteStart(ctx context.Context, s Spec, stdout, stderr io.Writer) (Process, error) {
	// A successful launch outlives the caller's request context. Explicit Stop,
	// control EOF, or host process death releases the Linux execution instead.
	setup, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	_, _, _, err := helper(setup, s.EnvironmentID)
	if err != nil {
		return nil, err
	}
	cmd, err := executorCommand(context.Background(), s.EnvironmentID, "run")
	if err != nil {
		return nil, err
	}
	input, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		return nil, err
	}
	var diagnostic bytes.Buffer
	cmd.Stderr = &diagnostic
	if err = cmd.Start(); err != nil {
		input.Close()
		return nil, err
	}
	p := &remoteProcess{cmd: cmd, control: input, output: output, decoder: json.NewDecoder(bufio.NewReader(output)), stdout: stdout, stderr: stderr, done: make(chan struct{}), code: -1}
	if err = encode(input, message{Protocol: Protocol, Type: "run", Spec: s}); err != nil {
		input.Close()
		_ = cmd.Wait()
		return nil, err
	}
	ack := make(chan message, 1)
	go func() {
		var m message
		if e := p.decoder.Decode(&m); e != nil {
			m.Error = "WSL 助手握手失败: " + e.Error()
		}
		ack <- m
	}()
	select {
	case first := <-ack:
		if first.Type != "started" || first.Error != "" {
			input.Close()
			_ = cmd.Wait()
			return nil, fmt.Errorf("WSL 启动失败: %s; %.1024s", first.Error, diagnostic.String())
		}
		p.pid = first.PID
	case <-setup.Done():
		input.Close()
		// EOF requests Linux cleanup; wait/reap asynchronously, never report success.
		go cmd.Wait()
		return nil, setup.Err()
	}
	go p.read()
	return p, nil
}
func (p *remoteProcess) read() {
	defer close(p.done)
	gotExit := false
	for {
		var m message
		if err := p.decoder.Decode(&m); err != nil {
			if !gotExit {
				p.waitErr = fmt.Errorf("WSL 执行助手失联，无法确认进程状态: %w", err)
				p.cleanupErr = p.waitErr
			}
			break
		}
		switch m.Type {
		case "stdout":
			if p.stdout != nil {
				_, _ = p.stdout.Write(m.Data)
			}
		case "stderr":
			if p.stderr != nil {
				_, _ = p.stderr.Write(m.Data)
			}
		case "exit":
			p.code = m.Code
			if m.Error != "" {
				p.waitErr = errors.New(m.Error)
				if m.Error == exec.ErrWaitDelay.Error() {
					p.waitErr = exec.ErrWaitDelay
				}
			}
			if m.CleanupError != "" {
				p.cleanupErr = errors.New(m.CleanupError)
			}
			gotExit = true
		}
	}
	p.control.Close()
	_ = p.cmd.Wait()
}
func (p *remoteProcess) PID() int      { return p.pid }
func (p *remoteProcess) Wait() error   { <-p.done; return p.waitErr }
func (p *remoteProcess) ExitCode() int { <-p.done; return p.code }
func (p *remoteProcess) Stop() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	select {
	case <-p.done:
		return p.cleanupErr
	default:
	}
	if p.stopping {
		return nil
	}
	p.stopping = true
	// Ask Linux to stop first. Only abandon a stalled transport after the deadline;
	// a missing acknowledgement is always an unconfirmed cleanup failure.
	go func() {
		timer := time.NewTimer(10 * time.Second)
		defer timer.Stop()
		select {
		case <-p.done:
			return
		case <-timer.C:
			// Closing a stalled transport bounds cancellation. read() records cleanup
			// as unconfirmed, rather than falsely treating a missing Linux reply as success.
			p.control.Close()
			if p.output != nil {
				p.output.Close()
			}
			_ = p.cmd.Process.Kill()
		}
	}()
	if err := encode(p.control, message{Type: "stop"}); err != nil {
		return fmt.Errorf("WSL 停止请求失败，进程状态待核实: %w", err)
	}
	return nil
}

// WSLPath converts a Windows installation path inside the selected distribution.
func WSLPath(ctx context.Context, id, windowsPath string) (string, error) {
	d, u, err := Parse(id)
	if err != nil {
		return "", err
	}
	raw, err := wslCommand(ctx, d, u, "wslpath", "-u", windowsPath).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(raw)), nil
}
