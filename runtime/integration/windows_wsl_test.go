//go:build windows

// These acceptance tests are cross-compiled in WSL and run via WSL interop.
// They use a private Windows runtime/database and fixture services only.
package integration

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/apix/apix/runtime/internal/executionenv"
	"github.com/apix/apix/runtime/internal/localipc"
	mcpclient "github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var distro = flag.String("apix-wsl-distro", "", "WSL distribution for explicit Windows acceptance tests")

func TestWindowsServiceFixture(t *testing.T) {
	if os.Getenv("APIX_INTEGRATION_FIXTURE") != "1" {
		return
	}
	_ = http.ListenAndServe(os.Getenv("APIX_FIXTURE_ADDR"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "fixture healthy") }))
	os.Exit(0)
}
func freeAddress(t *testing.T) string {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	return address
}
func TestWindowsRuntimeManagesWindowsWSLAndStdioAI(t *testing.T) {
	if *distro == "" {
		t.Skip("requires -apix-wsl-distro; no user services are launched")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	runtimePath := filepath.Join(filepath.Dir(executable), "apix-runtime.exe")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	info, err := executionenv.Check(ctx, executionenv.Spec{EnvironmentID: executionenv.WSLID(*distro, ""), Program: "/usr/bin/python3", WorkDir: "/tmp"})
	if err != nil {
		t.Fatal(err)
	}
	endpoint := "http://" + freeAddress(t) + "/mcp"
	dir := t.TempDir()
	socket, err := localipc.Address(filepath.Join(dir, "apix.db"))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(runtimePath)
	cmd.Env = append(os.Environ(), "APIX_ADDR="+strings.TrimSuffix(strings.TrimPrefix(endpoint, "http://"), "/mcp"), "APIX_DB_PATH="+filepath.Join(dir, "apix.db"), "APIX_LOG_PATH="+filepath.Join(dir, "runtime.log"))
	log, err := os.Create(filepath.Join(dir, "startup.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	cmd.Stdout = log
	cmd.Stderr = log
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	t.Log("private runtime started", endpoint)
	healthClient := &http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil}}
	healthDeadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(healthDeadline) {
		response, e := healthClient.Get(strings.TrimSuffix(endpoint, "/mcp") + "/health")
		if e == nil {
			response.Body.Close()
			if response.StatusCode == 200 {
				err = nil
				break
			}
			err = fmt.Errorf("health status %d", response.StatusCode)
		} else {
			err = e
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		raw, _ := os.ReadFile(filepath.Join(dir, "startup.log"))
		t.Fatalf("Windows runtime health: %v; %s", err, raw)
	}
	var cli *mcpclient.Client
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		cli, err = mcpclient.NewStdioMCPClient(runtimePath, nil, "mcp-stdio", "--socket", socket)
		if err == nil {
			_, err = cli.Initialize(ctx, mcp.InitializeRequest{Params: mcp.InitializeParams{ProtocolVersion: mcp.LATEST_PROTOCOL_VERSION, ClientInfo: mcp.Implementation{Name: "acceptance", Version: "1"}}})
		}
		if err == nil {
			break
		}
		if cli != nil {
			cli.Close()
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		raw, _ := os.ReadFile(filepath.Join(dir, "startup.log"))
		t.Fatalf("%v\n%s", err, raw)
	}
	defer cli.Close()
	call := func(client *mcpclient.Client, name string, args map[string]any) map[string]any {
		t.Helper()
		req := mcp.CallToolRequest{}
		req.Params.Name = name
		req.Params.Arguments = args
		result, err := client.CallTool(ctx, req)
		if err != nil {
			t.Fatal(name, err)
		}
		if result.IsError {
			t.Fatalf("%s: %+v", name, result)
		}
		raw, _ := json.Marshal(result.StructuredContent)
		out := map[string]any{}
		if err = json.Unmarshal(raw, &out); err != nil {
			t.Fatal(name, err, string(raw))
		}
		if nested, ok := out["result"].(map[string]any); ok {
			return nested
		}
		return out
	}
	windowsAddress := freeAddress(t)
	native := call(cli, "save_service", map[string]any{"service": map[string]any{"name": "Acceptance Windows", "work_dir": dir, "command": executable, "args": []string{"-test.run=^TestWindowsServiceFixture$"}, "env": map[string]string{"APIX_INTEGRATION_FIXTURE": "1", "APIX_FIXTURE_ADDR": windowsAddress}, "health_url": "http://" + windowsAddress}})
	winID := native["id"].(string)
	defer func() {
		req := mcp.CallToolRequest{}
		req.Params.Name = "stop_service"
		req.Params.Arguments = map[string]any{"service_id": winID}
		_, _ = cli.CallTool(context.Background(), req)
	}()
	call(cli, "start_service", map[string]any{"service_id": winID})
	// Python fixture chooses a WSL-only port. Its child HTTP server remains in the
	// same managed process group; stopping must remove both processes.
	portProbe := executionenv.Spec{EnvironmentID: info.ID, Program: "/usr/bin/python3", Args: []string{"-c", "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()"}}
	var port strings.Builder
	p, err := executionenv.Start(ctx, portProbe, &port, &port)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.Wait(); err != nil {
		t.Fatal(err)
	}
	if err = p.Stop(); err != nil {
		t.Fatal(err)
	}
	linuxAddress := "127.0.0.1:" + strings.TrimSpace(port.String())
	script := "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-u','-m','http.server',sys.argv[1],'--bind','127.0.0.1']); print('WSL child ready',flush=True); p.wait()"
	saved := call(cli, "save_service", map[string]any{"service": map[string]any{"name": "Acceptance WSL", "environment_id": info.ID, "work_dir": "/tmp", "command": "/usr/bin/python3", "args": []string{"-u", "-c", script, strings.Split(linuxAddress, ":")[1]}, "health_url": "http://" + linuxAddress, "startup_timeout_ms": 30000}})
	linuxID := saved["id"].(string)
	defer func() {
		req := mcp.CallToolRequest{}
		req.Params.Name = "stop_service"
		req.Params.Arguments = map[string]any{"service_id": linuxID}
		_, _ = cli.CallTool(context.Background(), req)
	}()
	started := call(cli, "start_service", map[string]any{"service_id": linuxID})
	if started["environment_id"] != info.ID || started["status"] != "running" {
		t.Fatal(started)
	}
	reused := call(cli, "start_service", map[string]any{"service_id": linuxID})
	if reused["started"] != false || reused["pid"] != started["pid"] {
		t.Fatal("duplicate WSL launch", reused)
	}
	details := call(cli, "get_service_details", map[string]any{"service_id": linuxID})
	logs, _ := json.Marshal(details["logs"])
	if !strings.Contains(string(logs), "WSL child ready") {
		t.Fatal(string(logs))
	}
	// Start the packaged Windows stdio bridge from Linux. Both native and WSL
	// clients use the same Windows named pipe and runtime, without TCP MCP.
	bridgePath, err := executionenv.WSLPath(ctx, info.ID, runtimePath)
	if err != nil {
		t.Fatal(err)
	}
	_, user, _ := executionenv.Parse(info.ID)
	ai, err := mcpclient.NewStdioMCPClient("wsl.exe", nil, "--distribution", *distro, "--user", user, "--exec", bridgePath, "mcp-stdio", "--socket", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer ai.Close()
	_, err = ai.Initialize(ctx, mcp.InitializeRequest{Params: mcp.InitializeParams{ProtocolVersion: mcp.LATEST_PROTOCOL_VERSION, ClientInfo: mcp.Implementation{Name: "wsl-ai-acceptance", Version: "1"}}})
	if err != nil {
		t.Fatal(err)
	}
	batch := call(ai, "begin_test_batch", map[string]any{"name": "WSL command acceptance"})
	command := call(ai, "run_test_case", map[string]any{"batch_id": batch["id"], "test_case": map[string]any{
		"name": "WSL Python stdin and env", "type": "command", "command_request": map[string]any{
			"environment_id": info.ID, "program": "/usr/bin/python3", "args": []string{"-c", "import os,sys; print(os.environ['APIX_ACCEPTANCE_VALUE']); print(sys.stdin.read())"},
			"env": map[string]string{"APIX_ACCEPTANCE_VALUE": "literal 中文 $(value)"}, "stdin": "literal stdin", "timeout_seconds": 15,
		}, "expected_exit_code": 0, "assertions": []map[string]any{{"source": "stdout", "operator": "contains", "expected": "literal 中文 $(value)"}, {"source": "stdout", "operator": "contains", "expected": "literal stdin"}},
	}})
	if command["test_status"] != "passed" {
		t.Fatal(command)
	}
	commandResult, _ := command["command_result"].(map[string]any)
	if commandResult["environment_id"] != info.ID {
		t.Fatal(commandResult)
	}
	call(ai, "finish_test_batch", map[string]any{"batch_id": batch["id"]})
	same := call(ai, "get_service_status", map[string]any{"service_id": linuxID})
	if same["pid"] != started["pid"] {
		t.Fatal("bridge connected to a different instance")
	}
	call(ai, "stop_service", map[string]any{"service_id": linuxID})
	if executionenv.Probe(ctx, info.ID, "http://"+linuxAddress).Available {
		t.Fatal("WSL descendant survived stop")
	}
	call(ai, "stop_service", map[string]any{"service_id": winID})
	response, err := http.Get("http://" + windowsAddress)
	if err == nil {
		response.Body.Close()
		t.Fatal("Windows fixture survived stop")
	}
	// Kill the host with a running WSL fixture; control EOF must release it.
	call(cli, "start_service", map[string]any{"service_id": linuxID})
	_ = cmd.Process.Kill()
	deadline = time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if !executionenv.Probe(ctx, info.ID, "http://"+linuxAddress).Available {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("WSL service survived Windows runtime death")
}

func TestWindowsLoopback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "loopback-ok") }))
	defer server.Close()
	client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{Proxy: nil}}
	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatal(server.URL, err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	if string(data) != "loopback-ok" {
		t.Fatal(string(data))
	}
}

type readyWriter struct {
	mu    sync.Mutex
	data  strings.Builder
	ready chan string
	sent  bool
}

func (w *readyWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.data.Write(p)
	if !w.sent {
		for _, line := range strings.Split(w.data.String(), "\n") {
			if strings.HasPrefix(line, "http://") {
				w.ready <- strings.TrimSpace(line)
				w.sent = true
				break
			}
		}
	}
	return len(p), nil
}

const linuxTreeScript = "import subprocess,sys; child=subprocess.Popen([sys.executable,'-u','-c',\"import http.server; s=http.server.ThreadingHTTPServer(('127.0.0.1',0),http.server.SimpleHTTPRequestHandler); print('http://127.0.0.1:'+str(s.server_port),flush=True); s.serve_forever()\"]); child.wait()"

func startLinuxTree(t *testing.T, ctx context.Context, id string) (executionenv.Process, string) {
	t.Helper()
	out := &readyWriter{ready: make(chan string, 1)}
	p, err := executionenv.Start(ctx, executionenv.Spec{EnvironmentID: id, Program: "/usr/bin/python3", Args: []string{"-u", "-c", linuxTreeScript}}, out, out)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case address := <-out.ready:
		return p, address
	case <-ctx.Done():
		_ = p.Stop()
		t.Fatal(ctx.Err())
	}
	return nil, ""
}
func TestWindowsWSLExecutorLifecycle(t *testing.T) {
	if *distro == "" {
		t.Skip("requires -apix-wsl-distro")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	info, err := executionenv.Check(ctx, executionenv.Spec{EnvironmentID: executionenv.WSLID(*distro, ""), Program: "/usr/bin/python3", WorkDir: "/tmp"})
	if err != nil {
		t.Fatal(err)
	}
	p, address := startLinuxTree(t, ctx, info.ID)
	defer p.Stop()
	if !executionenv.Probe(ctx, info.ID, address).Healthy {
		t.Fatal("Linux child did not become healthy")
	}
	if err = p.Stop(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- p.Wait() }()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err = p.Stop(); err != nil {
		t.Fatal(err)
	}
	if executionenv.Probe(ctx, info.ID, address).Available {
		t.Fatal("Linux child survived stop")
	}
	// Actual Windows parent death must close WSL's control stream.
	exe, _ := os.Executable()
	worker := exec.Command(exe, "-test.run=^TestWindowsExecutorHostFixture$")
	worker.Env = append(os.Environ(), "APIX_EXECUTOR_HOST_FIXTURE="+info.ID)
	pipe, err := worker.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	worker.Stderr = os.Stderr
	if err = worker.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = worker.Process.Kill(); _ = worker.Wait() }()
	scan := bufio.NewScanner(pipe)
	read := make(chan string, 1)
	go func() {
		for scan.Scan() {
			if strings.HasPrefix(scan.Text(), "http://") {
				read <- scan.Text()
				return
			}
		}
		read <- ""
	}()
	select {
	case address = <-read:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if address == "" {
		t.Fatal("Windows fixture did not start Linux service")
	}
	_ = worker.Process.Kill()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if !executionenv.Probe(ctx, info.ID, address).Available {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("Linux child survived Windows parent termination")
}
func TestWindowsExecutorHostFixture(t *testing.T) {
	id := os.Getenv("APIX_EXECUTOR_HOST_FIXTURE")
	if id == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, address := startLinuxTree(t, ctx, id)
	fmt.Println(address)
	select {}
}

func TestWindowsWSLConfigurationRoundTrip(t *testing.T) {
	if *distro == "" {
		t.Skip("requires -apix-wsl-distro")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	info, err := executionenv.Check(ctx, executionenv.Spec{EnvironmentID: executionenv.WSLID(*distro, "")})
	if err != nil {
		t.Fatal(err)
	}
	directory := fmt.Sprintf("/tmp/apix-acceptance-config-%d", time.Now().UnixNano())
	config := directory + "/config.toml"
	defer func() {
		// The generated absolute path is constrained before recursive fixture cleanup.
		script := "import pathlib,shutil,sys; p=pathlib.Path(sys.argv[1]); assert p.parent==pathlib.Path('/tmp') and p.name.startswith('apix-acceptance-config-'); shutil.rmtree(p,ignore_errors=True)"
		p, err := executionenv.Start(context.Background(), executionenv.Spec{EnvironmentID: info.ID, Program: "/usr/bin/python3", Args: []string{"-c", script, directory}}, nil, nil)
		if err != nil {
			t.Error(err)
			return
		}
		_ = p.Wait()
		_ = p.Stop()
	}()
	original := []byte("# preserved comment\n")
	first, err := executionenv.Config(ctx, info.ID, executionenv.Configuration{Path: config, Write: true, Data: original})
	if err != nil || !first.Exists {
		t.Fatal(err)
	}
	next := []byte("# preserved comment\n[mcp_servers.apix]\ncommand = \"bridge\"\n")
	saved, err := executionenv.Config(ctx, info.ID, executionenv.Configuration{Path: config, Write: true, Exists: true, Expected: original, Data: next})
	if err != nil || saved.Backup == "" {
		t.Fatal(err)
	}
	backup, err := executionenv.Config(ctx, info.ID, executionenv.Configuration{Path: saved.Backup})
	if err != nil || string(backup.Data) != string(original) {
		t.Fatal("backup changed", err)
	}
	if _, err = executionenv.Config(ctx, info.ID, executionenv.Configuration{Path: config, Write: true, Exists: true, Expected: original, Data: []byte("overwrite")}); err == nil {
		t.Fatal("overwrote concurrent edit")
	}
	actual, err := executionenv.Config(ctx, info.ID, executionenv.Configuration{Path: config})
	if err != nil || string(actual.Data) != string(next) {
		t.Fatal("config changed", err)
	}
}
