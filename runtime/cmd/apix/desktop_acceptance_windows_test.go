//go:build windows

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/net/websocket"
	"golang.org/x/sys/windows"
)

var desktopAcceptance = flag.Bool("apix-desktop-acceptance", false, "run the isolated Windows desktop acceptance test")
var desktopPreview = flag.String("apix-desktop-preview", "", "save a WebView2 screenshot")

// Explicitly enabled by test-windows-desktop.mjs; never uses installed data.
func TestDesktopLifecycle(t *testing.T) {
	if !*desktopAcceptance {
		t.Skip("run pnpm test:windows-desktop in Ubuntu WSL")
	}
	if err := checkWebViewRuntime(); err != nil {
		t.Fatal(err)
	}
	testBinary, _ := os.Executable()
	executable := filepath.Join(filepath.Dir(testBinary), "Apix.exe")
	backend := filepath.Join(filepath.Dir(testBinary), "apix-runtime.exe")
	local := t.TempDir()
	dataDir := filepath.Join(local, "Apix", "data")
	pidFile := filepath.Join(dataDir, "runtime.pid")
	address, debugAddress := freeDesktopAddress(t), freeDesktopAddress(t)
	environment := append(os.Environ(), "LOCALAPPDATA="+local, "APIX_ADDR="+address,
		"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port="+strings.Split(debugAddress, ":")[1]+" --remote-allow-origins=http://127.0.0.1")
	var running []*exec.Cmd
	t.Cleanup(func() {
		for _, command := range running {
			if command.ProcessState == nil {
				_ = command.Process.Kill()
				_ = command.Wait()
			}
		}
		raw, _ := os.ReadFile(pidFile)
		pid, _ := strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 32)
		if ownedProcess(uint32(pid), backend) {
			process, _ := os.FindProcess(int(pid))
			_ = process.Kill()
			_, _ = process.Wait()
		}
		// WebView2's browser process can hold profile files briefly after exit.
		for deadline := time.Now().Add(8 * time.Second); time.Now().Before(deadline); {
			if os.RemoveAll(local) == nil {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
	})
	run := func(args ...string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, executable, args...)
		command.Env = environment
		command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
		if err := command.Run(); err != nil {
			raw, _ := os.ReadFile(filepath.Join(dataDir, "startup.log"))
			t.Fatalf("Apix %v: %v; %s", args, err, raw)
		}
	}
	start := func() *exec.Cmd {
		t.Helper()
		command := exec.Command(executable)
		command.Env = environment
		command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
		running = append(running, command)
		return command
	}
	instance := desktopInstanceName(dataDir)
	run("--background")
	originalPID, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	if desktopWindow(instance, executable) != 0 {
		t.Fatal("--background created a desktop window")
	}
	command := start()
	var hwnd uintptr
	desktopEventually(t, "native WebView2 window", func() bool {
		hwnd = desktopWindow(instance, executable)
		return hwnd != 0
	})
	t.Log("native window opened")
	client := &http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	var socketURL string
	desktopEventually(t, "WebView2 page target", func() bool {
		response, err := client.Get("http://" + debugAddress + "/json/list")
		if err != nil {
			return false
		}
		defer response.Body.Close()
		var targets []struct {
			Type                 string
			URL                  string
			WebSocketDebuggerURL string
		}
		if json.NewDecoder(response.Body).Decode(&targets) != nil {
			return false
		}
		for _, target := range targets {
			if target.Type == "page" && target.URL == "http://"+address+"/" {
				socketURL = target.WebSocketDebuggerURL
				return socketURL != ""
			}
		}
		return false
	})
	socket, err := websocket.Dial(socketURL, "", "http://127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	nextID := 0
	cdp := func(method string, params any) json.RawMessage {
		t.Helper()
		nextID++
		_ = socket.SetDeadline(time.Now().Add(10 * time.Second))
		if err := websocket.JSON.Send(socket, map[string]any{"id": nextID, "method": method, "params": params}); err != nil {
			t.Fatal(err)
		}
		for {
			var response struct {
				ID     int
				Result json.RawMessage
				Error  json.RawMessage
			}
			if err := websocket.JSON.Receive(socket, &response); err != nil {
				t.Fatal(err)
			}
			if response.ID != nextID {
				continue
			}
			if len(response.Error) != 0 {
				t.Fatalf("CDP %s: %s", method, response.Error)
			}
			return response.Result
		}
	}
	evaluate := func(expression string) json.RawMessage {
		t.Helper()
		var response struct {
			Result           struct{ Value json.RawMessage }
			ExceptionDetails json.RawMessage
		}
		_ = json.Unmarshal(cdp("Runtime.evaluate", map[string]any{"expression": expression, "returnByValue": true, "awaitPromise": true}), &response)
		if len(response.ExceptionDetails) != 0 {
			t.Fatalf("JavaScript: %s", response.ExceptionDetails)
		}
		return response.Result.Value
	}
	desktopEventually(t, "rendered and connected workspace", func() bool {
		return string(evaluate("document.readyState === 'complete' && document.querySelector('#connection')?.textContent === '实时同步中' && document.querySelector('#error-banner')?.hidden")) == "true"
	})
	t.Log("WebView2 loaded the workspace and connected to the private Go backend")
	for _, route := range []string{"/requests", "/databases", "/mcp-tools", "/commands", "/ai-tools", "/"} {
		evaluate(fmt.Sprintf("document.querySelector('a[data-route][href=%q]').click()", route))
		desktopEventually(t, "route "+route, func() bool {
			return string(evaluate(fmt.Sprintf("location.pathname === %q && !!document.querySelector('a[data-route][aria-current=page][href=%q]')", route, route))) == "true"
		})
	}
	if preview := *desktopPreview; preview != "" {
		var shot struct{ Data string }
		_ = json.Unmarshal(cdp("Page.captureScreenshot", map[string]any{"format": "png"}), &shot)
		pixels, err := base64.StdEncoding.DecodeString(shot.Data)
		if err != nil || len(pixels) == 0 {
			t.Fatalf("screenshot: %v", err)
		}
		if err := os.WriteFile(preview, pixels, 0600); err != nil {
			t.Fatal(err)
		}
	}
	user32.NewProc("ShowWindow").Call(hwnd, 6) // SW_MINIMIZE
	run()
	desktopEventually(t, "existing window restored", func() bool {
		iconic, _, _ := user32.NewProc("IsIconic").Call(hwnd)
		return iconic == 0 && desktopWindow(instance, executable) == hwnd
	})
	run("--background")
	pid, _ := os.ReadFile(pidFile)
	if string(pid) != string(originalPID) {
		t.Fatal("reopening or --background started another backend")
	}
	closeWindow := func(cmd *exec.Cmd, window uintptr) {
		t.Helper()
		user32.NewProc("PostMessageW").Call(window, 0x0010, 0, 0) // WM_CLOSE
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("desktop did not exit after closing its window")
		}
	}
	_ = socket.Close()
	closeWindow(command, hwnd)
	response, err := client.Get("http://" + address + "/health")
	if err != nil {
		t.Fatalf("closing the window stopped the MCP backend: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("background health failed")
	}
	reopened := start()
	desktopEventually(t, "reopened window", func() bool {
		hwnd = desktopWindow(instance, executable)
		return hwnd != 0
	})
	closeWindow(reopened, hwnd)
	t.Log("single window, minimized restore, background mode, close and reopen passed; backend PID unchanged")
}

func freeDesktopAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	return address
}

func desktopEventually(t *testing.T, description string, check func() bool) {
	t.Helper()
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); {
		if check() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("timed out waiting for " + description)
}
