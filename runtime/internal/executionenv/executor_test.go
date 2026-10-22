package executionenv

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestExecutorFixture(t *testing.T) {
	if os.Getenv("APIX_EXECUTOR_FIXTURE") != "1" {
		return
	}
	mode := os.Args[len(os.Args)-1]
	switch mode {
	case "worker":
		err := ServeHelper("run", os.Stdin, os.Stdout)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		os.Exit(0)
	case "echo":
		var value map[string]any
		_ = json.NewDecoder(os.Stdin).Decode(&value)
		cwd, _ := os.Getwd()
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"args": os.Args[3 : len(os.Args)-1], "input": value, "cwd": cwd, "env": os.Getenv("APIX_VALUE")})
		fmt.Fprint(os.Stderr, "diagnostic")
		os.Exit(7)
	case "tree":
		command := exec.Command(testExecutable(), "-test.run=^TestExecutorFixture$", "--", "child")
		command.Env = os.Environ()
		if err := command.Start(); err != nil {
			os.Exit(3)
		}
		fmt.Fprintln(os.Stdout, command.Process.Pid)
		// Keep the tree root alive while its child serves. A bare select{}
		// triggers Go's deadlock detector before the child starts on macOS.
		_ = command.Wait()
	case "child":
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			os.Exit(4)
		}
		if err = os.WriteFile(os.Getenv("APIX_FIXTURE_URL"), []byte("http://"+listener.Addr().String()), 0600); err != nil {
			os.Exit(5)
		}
		_ = http.Serve(listener, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ok") }))
		os.Exit(0)
	}
	os.Exit(6)
}
func protocolProcess(t *testing.T, s Spec) (*remoteProcess, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	cmd := exec.Command(testExecutable(), "-test.run=^TestExecutorFixture$", "--", "worker")
	cmd.Env = append(os.Environ(), "APIX_EXECUTOR_FIXTURE=1")
	input, _ := cmd.StdinPipe()
	output, _ := cmd.StdoutPipe()
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(output)
	if err := encode(input, message{Protocol: Protocol, Spec: s}); err != nil {
		t.Fatal(err)
	}
	var ack message
	if err := decoder.Decode(&ack); err != nil {
		t.Fatal(err)
	}
	if ack.Error != "" {
		t.Fatal(ack.Error)
	}
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	proc := &remoteProcess{cmd: cmd, control: input, decoder: decoder, stdout: stdout, stderr: stderr, pid: ack.PID, done: make(chan struct{}), code: -1}
	go proc.read()
	t.Cleanup(func() {
		_ = proc.Stop()
		select {
		case <-proc.done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			t.Error("helper did not finish")
		}
	})
	return proc, stdout, stderr
}
func TestProtocolKeepsArgumentsInputExitAndOutput(t *testing.T) {
	dir := t.TempDir()
	args := []string{"space inside", "中文", "$(never-run)", "semi;colon", "", `a\b`}
	s := Spec{Program: testExecutable(), Args: append(append([]string{"-test.run=^TestExecutorFixture$", "--"}, args...), "echo"), WorkDir: dir, Env: map[string]string{"APIX_EXECUTOR_FIXTURE": "1", "APIX_VALUE": "value with spaces"}, Stdin: `{"script":"literal $ and newlines\\n"}`}
	p, stdout, stderr := protocolProcess(t, s)
	if err := p.Wait(); err == nil || p.ExitCode() != 7 {
		t.Fatalf("exit=%d err=%v", p.ExitCode(), err)
	}
	if err := p.Stop(); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Args     []string
		Input    map[string]any
		Cwd, Env string
	}
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(args, result.Args) || result.Cwd != dir || result.Env != "value with spaces" || result.Input["script"] != "literal $ and newlines\\n" {
		t.Fatalf("changed execution: %+v", result)
	}
	if stderr.String() != "diagnostic" {
		t.Fatal(stderr.String())
	}
}
func TestControlEOFStopsOwnedDescendants(t *testing.T) {
	if os.PathSeparator == '\\' {
		t.Skip("Linux helper process group test")
	}
	file := filepath.Join(t.TempDir(), "url")
	p, _, _ := protocolProcess(t, Spec{Program: testExecutable(), Args: []string{"-test.run=^TestExecutorFixture$", "--", "tree"}, Env: map[string]string{"APIX_EXECUTOR_FIXTURE": "1", "APIX_FIXTURE_URL": file}})
	var address string
	until := time.Now().Add(5 * time.Second)
	for time.Now().Before(until) {
		raw, _ := os.ReadFile(file)
		address = string(raw)
		if address != "" && Probe(context.Background(), "", address).Healthy {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if address == "" {
		t.Fatal("child did not start")
	}
	p.control.Close()
	select {
	case <-p.done:
	case <-time.After(5 * time.Second):
		t.Fatal("EOF did not release helper")
	}
	if p.cleanupErr != nil {
		t.Fatal(p.cleanupErr)
	}
	if Probe(context.Background(), "", address).Available {
		t.Fatal("descendant survived control EOF")
	}
}
func TestConfigCASBackupAndSymlinkProtection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	first := []byte("# keep comment\n")
	saved, err := Config(context.Background(), "", Configuration{Path: path, Write: true, Data: first})
	if err != nil || !saved.Exists {
		t.Fatal(err)
	}
	read, err := Config(context.Background(), "", Configuration{Path: path})
	if err != nil || !bytes.Equal(read.Data, first) {
		t.Fatal(err)
	}
	second := []byte("# keep comment\n[mcp_servers.apix]\n")
	saved, err = Config(context.Background(), "", Configuration{Path: path, Write: true, Exists: true, Expected: first, Data: second})
	if err != nil || saved.Backup == "" {
		t.Fatal(err)
	}
	backup, _ := os.ReadFile(saved.Backup)
	if !bytes.Equal(backup, first) {
		t.Fatal("backup changed")
	}
	if _, err = Config(context.Background(), "", Configuration{Path: path, Write: true, Exists: true, Expected: first, Data: []byte("overwrite")}); err == nil {
		t.Fatal("overwrote concurrent edit")
	}
	raw, _ := os.ReadFile(path)
	if !bytes.Equal(raw, second) {
		t.Fatal("changed file")
	}
	link := filepath.Join(filepath.Dir(path), "link")
	if err = os.Symlink(path, link); err == nil {
		if _, err = Config(context.Background(), "", Configuration{Path: link}); err == nil {
			t.Fatal("accepted symlink")
		}
	}
}
func TestEnvironmentPathsAndDiscovery(t *testing.T) {
	id := WSLID("Ubuntu Test:版本", "user")
	d, u, err := Parse(id)
	if err != nil || d != "Ubuntu Test:版本" || u != "user" {
		t.Fatal(id, d, u, err)
	}
	if err = Validate(Spec{EnvironmentID: id, WorkDir: "C:\\wrong"}); err == nil {
		t.Fatal("accepted Windows directory in Linux")
	}
	if err = Validate(Spec{EnvironmentID: id, WorkDir: "/home/user/project"}); err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{"wsl::user", "wsl:-d:user", "unknown", "wsl:Ubuntu:-root"} {
		if _, _, e := Parse(v); e == nil {
			t.Fatal("accepted", v)
		}
	}
	t.Setenv("APIX_EXECUTOR", "1")
	t.Setenv("PATH", "/usr/bin:/mnt/c/Windows:/home/user/.local/bin")
	env := environment(Spec{})
	if runtime.GOOS == "linux" && strings.Contains(strings.Join(env, "\n"), "PATH=/usr/bin:/mnt/c") {
		t.Fatal("imported Windows PATH")
	}
}

func testExecutable() string {
	p, err := os.Executable()
	if err != nil {
		panic(err)
	}
	return p
}

func TestChecksRejectMissingProgramsAndHealthKeepsRedirects(t *testing.T) {
	if _, err := Check(context.Background(), Spec{Program: filepath.Join(t.TempDir(), "missing")}); err == nil {
		t.Fatal("missing absolute executable passed inspection")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/health", http.StatusFound)
			return
		}
		fmt.Fprint(w, "ok")
	}))
	defer server.Close()
	if !Probe(context.Background(), "", server.URL).Healthy {
		t.Fatal("health redirects regressed")
	}
}
