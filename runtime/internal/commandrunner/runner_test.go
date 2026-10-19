package commandrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The current Linux test binary is the only external program these tests launch.
func TestCommandHelper(t *testing.T) {
	if os.Getenv("APIX_COMMAND_HELPER") != "1" {
		return
	}
	index := -1
	for i, arg := range os.Args {
		if arg == "command-helper" {
			index = i
			break
		}
	}
	if index < 0 {
		os.Exit(99)
	}
	action := os.Args[index+1]
	switch action {
	case "echo":
		input, _ := io.ReadAll(os.Stdin)
		cwd, _ := os.Getwd()
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"args": os.Args[index+2:], "stdin": string(input), "cwd": cwd, "value": os.Getenv("COMMAND_VALUE")})
		fmt.Fprint(os.Stderr, "diagnostic")
	case "exit":
		code, _ := strconv.Atoi(os.Args[index+2])
		os.Exit(code)
	case "large":
		fmt.Fprint(os.Stdout, strings.Repeat("x", OutputLimit+1024))
		fmt.Fprint(os.Stderr, strings.Repeat("y", OutputLimit+1024))
	case "spawn":
		cmd := exec.Command(os.Args[0], "-test.run=^TestCommandHelper$", "command-helper", "wait")
		cmd.Env = os.Environ()
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			os.Exit(98)
		}
		fmt.Fprintln(os.Stdout, cmd.Process.Pid)
		time.Sleep(time.Minute)
	case "wait":
		time.Sleep(time.Minute)
	}
	os.Exit(0)
}
func helperRequest(action string, args ...string) Request {
	return Request{Program: os.Args[0], Args: append([]string{"-test.run=^TestCommandHelper$", "command-helper", action}, args...), Env: map[string]string{"APIX_COMMAND_HELPER": "1"}, TimeoutSeconds: 3}
}
func TestDirectArgumentsEnvironmentStdinAndNonzeroExit(t *testing.T) {
	runner := New()
	req := helperRequest("echo", "space inside", `$(not-a-command)`, `semi;colon`, "", `a\b`)
	req.WorkDir = t.TempDir()
	req.Stdin = "hello\nscript input"
	req.Env["COMMAND_VALUE"] = "value with spaces"
	result := runner.Run(context.Background(), req)
	if result.ErrorKind != "" || result.ExitCode == nil || *result.ExitCode != 0 || result.Stderr != "diagnostic" {
		t.Fatalf("%+v", result)
	}
	var data struct {
		Args              []string
		Stdin, Cwd, Value string
	}
	if err := json.Unmarshal([]byte(result.Stdout), &data); err != nil {
		t.Fatal(err)
	}
	if len(data.Args) != 5 || data.Args[1] != `$(not-a-command)` || data.Args[3] != "" || data.Cwd != req.WorkDir || data.Stdin != req.Stdin || data.Value != "value with spaces" {
		t.Fatalf("arguments were expanded or changed: %+v", data)
	}
	result = runner.Run(context.Background(), helperRequest("exit", "7"))
	if result.ErrorKind != "" || result.ExitCode == nil || *result.ExitCode != 7 {
		t.Fatalf("nonzero exit is a completed invocation: %+v", result)
	}
}
func TestOutputLimitsMissingProgramsAndShutdown(t *testing.T) {
	runner := New()
	out := runner.Run(context.Background(), helperRequest("large"))
	if out.ErrorKind != "" || !out.StdoutTruncated || !out.StderrTruncated || len(out.Stdout) != OutputLimit || len(out.Stderr) != OutputLimit {
		t.Fatalf("output capture: %s %d/%d", out.ErrorKind, len(out.Stdout), len(out.Stderr))
	}
	missing := runner.Run(context.Background(), Request{Program: "/definitely-not-an-apix-program"})
	if missing.ErrorKind != "start" || missing.ExitCode != nil {
		t.Fatalf("missing: %+v", missing)
	}
	req := helperRequest("echo")
	req.WorkDir = "/definitely-not-an-apix-directory"
	if out = runner.Run(context.Background(), req); out.ErrorKind != "start" {
		t.Fatalf("directory: %+v", out)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if out = runner.Run(ctx, helperRequest("echo")); out.ErrorKind != "cancelled" {
		t.Fatalf("cancelled call launched: %+v", out)
	}
	done := make(chan *Result, 1)
	go func() { done <- runner.Run(context.Background(), helperRequest("wait")) }()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		runner.mu.Lock()
		active := len(runner.active)
		runner.mu.Unlock()
		if active > 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	runner.Stop()
	if err := runner.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	if out = <-done; out.ErrorKind != "cancelled" {
		t.Fatalf("shutdown: %+v", out)
	}
	if out = runner.Run(context.Background(), helperRequest("echo")); out.ErrorKind != "cancelled" {
		t.Fatal("closed runner started a process")
	}
}
