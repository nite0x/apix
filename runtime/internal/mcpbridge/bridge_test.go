package mcpbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	mcpclient "github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestBridgeFixture(t *testing.T) {
	endpoint := os.Getenv("APIX_BRIDGE_FIXTURE")
	if endpoint == "" {
		return
	}
	if err := Serve(context.Background(), endpoint, os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	os.Exit(0)
}
func TestStdioBridgeDiscoversAndCallsSameRuntime(t *testing.T) {
	runtime := server.NewMCPServer("apix", "test", server.WithToolCapabilities(true))
	var calls atomic.Int32
	runtime.AddTool(mcp.NewTool("echo"), func(ctx context.Context, r mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		calls.Add(1)
		return mcp.NewToolResultText(r.GetString("value", "")), nil
	})
	httpServer := httptest.NewServer(server.NewStreamableHTTPServer(runtime))
	defer httpServer.Close()
	cli, err := mcpclient.NewStdioMCPClient(testExecutable(), []string{"APIX_BRIDGE_FIXTURE=" + httpServer.URL + "/mcp"}, "-test.run=^TestBridgeFixture$")
	if err != nil {
		t.Fatal(err)
	}
	defer cli.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	info, err := cli.Initialize(ctx, mcp.InitializeRequest{Params: mcp.InitializeParams{ProtocolVersion: mcp.LATEST_PROTOCOL_VERSION, ClientInfo: mcp.Implementation{Name: "test", Version: "1"}}})
	if err != nil || info.ServerInfo.Name != "apix" {
		t.Fatalf("%+v %v", info, err)
	}
	tools, err := cli.ListTools(ctx, mcp.ListToolsRequest{})
	if err != nil || len(tools.Tools) != 1 {
		t.Fatalf("%+v %v", tools, err)
	}
	request := mcp.CallToolRequest{}
	request.Params.Name = "echo"
	request.Params.Arguments = map[string]any{"value": "中文 literal $(text)"}
	result, err := cli.CallTool(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	text := result.Content[0].(mcp.TextContent).Text
	if calls.Load() != 1 || text != "中文 literal $(text)" {
		t.Fatalf("calls=%d result=%+v", calls.Load(), result)
	}
}
func TestBridgeRejectsRemoteAndRedirectEndpoints(t *testing.T) {
	for _, endpoint := range []string{"https://example.com/mcp", "http://192.168.1.1/mcp", "http://127.0.0.1/api", "http://127.0.0.1/mcp?x=1"} {
		if _, _, err := Connect(context.Background(), endpoint); err == nil {
			t.Fatal("accepted", endpoint)
		}
	}
	server := httptest.NewServer(server.NewStreamableHTTPServer(server.NewMCPServer("other", "1")))
	defer server.Close()
	if _, _, err := Connect(context.Background(), server.URL+"/mcp"); err == nil || !strings.Contains(err.Error(), "not an Apix") {
		t.Fatal(err)
	}
}

func testExecutable() string {
	p, err := os.Executable()
	if err != nil {
		panic(err)
	}
	return p
}

// switchableRuntime models replacing the entire MCP server (including sessions)
// at the same address, with an optional period where the listener is absent.
type switchableRuntime struct {
	mu      sync.RWMutex
	handler http.Handler
}

func (s *switchableRuntime) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	handler := s.handler
	s.mu.RUnlock()
	handler.ServeHTTP(w, r)
}

func (s *switchableRuntime) replace(handler http.Handler) {
	s.mu.Lock()
	s.handler = handler
	s.mu.Unlock()
}

func echoRuntime(value string) http.Handler {
	runtime := server.NewMCPServer("apix", value, server.WithToolCapabilities(true))
	runtime.AddTool(mcp.NewTool("echo"), func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return mcp.NewToolResultText(value), nil
	})
	if value != "first" {
		runtime.AddTool(mcp.NewTool("after_restart"), func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			return mcp.NewToolResultText(value), nil
		})
	}
	return server.NewStreamableHTTPServer(runtime, server.WithStateful(true))
}

func bridgeClient(t *testing.T, endpoint string) *mcpclient.Client {
	t.Helper()
	cli, err := mcpclient.NewStdioMCPClient(testExecutable(), []string{"APIX_BRIDGE_FIXTURE=" + endpoint}, "-test.run=^TestBridgeFixture$")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cli.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := cli.Initialize(ctx, mcp.InitializeRequest{Params: mcp.InitializeParams{ProtocolVersion: mcp.LATEST_PROTOCOL_VERSION, ClientInfo: mcp.Implementation{Name: "restart-test", Version: "1"}}}); err != nil {
		t.Fatal(err)
	}
	return cli
}

func callEcho(ctx context.Context, cli *mcpclient.Client) (*mcp.CallToolResult, error) {
	request := mcp.CallToolRequest{}
	request.Params.Name = "echo"
	return cli.CallTool(ctx, request)
}

func assertEcho(t *testing.T, result *mcp.CallToolResult, err error, value string) {
	t.Helper()
	if err != nil || result == nil || result.IsError || len(result.Content) != 1 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if text, ok := result.Content[0].(mcp.TextContent); !ok || text.Text != value {
		t.Fatalf("result=%+v", result)
	}
}

func TestBridgeReinitializesExpiredSessionAndRefreshesTools(t *testing.T) {
	target := &switchableRuntime{handler: echoRuntime("first")}
	httpServer := httptest.NewServer(target)
	defer httpServer.Close()
	cli := bridgeClient(t, httpServer.URL+"/mcp")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := callEcho(ctx, cli)
	assertEcho(t, result, err, "first")
	// No waiting for the heartbeat: the next call must safely reinitialize
	// after a 404 from the new server, keeping the same stdio client.
	target.replace(echoRuntime("second"))
	result, err = callEcho(ctx, cli)
	assertEcho(t, result, err, "second")
	tools, err := cli.ListTools(ctx, mcp.ListToolsRequest{})
	if err != nil || len(tools.Tools) != 2 {
		t.Fatalf("catalog was not refreshed: %+v %v", tools, err)
	}
}

func TestBridgeSurvivesListenerDowntimeAndRepeatedRestarts(t *testing.T) {
	target := &switchableRuntime{handler: echoRuntime("first")}
	httpServer := httptest.NewServer(target)
	address := httpServer.Listener.Addr().String()
	endpoint := httpServer.URL + "/mcp"
	defer func() { httpServer.Close() }()
	cli := bridgeClient(t, endpoint)
	for i := 0; i < 2; i++ {
		httpServer.Close()
		answer := make(chan error, 1)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
			defer cancel()
			result, err := callEcho(ctx, cli)
			if err == nil && (result.IsError || result.Content[0].(mcp.TextContent).Text != "restarted") {
				err = fmt.Errorf("unexpected result: %+v", result)
			}
			answer <- err
		}()
		// Leave the actual TCP listener down through several retry attempts.
		time.Sleep(600 * time.Millisecond)
		target.replace(echoRuntime("restarted"))
		listener, err := net.Listen("tcp", address)
		if err != nil {
			t.Fatal(err)
		}
		httpServer = httptest.NewUnstartedServer(target)
		httpServer.Listener.Close()
		httpServer.Listener = listener
		httpServer.Start()
		if err := <-answer; err != nil {
			t.Fatalf("restart %d: %v", i, err)
		}
	}
}

func TestBridgeReconnectsWhileIdle(t *testing.T) {
	var initializations atomic.Int32
	target := &switchableRuntime{handler: echoRuntime("first")}
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		var message struct{ Method string }
		json.Unmarshal(body, &message)
		if message.Method == "initialize" {
			initializations.Add(1)
		}
		target.ServeHTTP(w, r)
	}))
	defer httpServer.Close()
	cli := bridgeClient(t, httpServer.URL+"/mcp")
	target.replace(echoRuntime("idle-restart"))
	deadline := time.Now().Add(6 * time.Second)
	for initializations.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if initializations.Load() != 2 {
		t.Fatalf("idle session did not recover: initializes=%d", initializations.Load())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, err := callEcho(ctx, cli)
	assertEcho(t, result, err, "idle-restart")
}

func TestBridgeDoesNotReplayToolWhenResponseIsLost(t *testing.T) {
	var calls atomic.Int32
	runtime := server.NewMCPServer("apix", "test", server.WithToolCapabilities(true))
	runtime.AddTool(mcp.NewTool("echo"), func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		calls.Add(1) // Represent an already committed mutation.
		return mcp.NewToolResultText("committed"), nil
	})
	target := server.NewStreamableHTTPServer(runtime, server.WithStateful(true))
	var loseResponse atomic.Bool
	loseResponse.Store(true)
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		var message struct{ Method string }
		json.Unmarshal(body, &message)
		if message.Method == "tools/call" && loseResponse.Swap(false) {
			recorder := httptest.NewRecorder()
			target.ServeHTTP(recorder, r)
			connection, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				connection.Close() // Commit happened, but no response reached bridge.
			}
			return
		}
		target.ServeHTTP(w, r)
	}))
	defer httpServer.Close()
	cli := bridgeClient(t, httpServer.URL+"/mcp")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := callEcho(ctx, cli)
	if err == nil && (result == nil || !result.IsError || !strings.Contains(result.Content[0].(mcp.TextContent).Text, "outcome is unknown")) {
		t.Fatalf("lost response was not reported: %+v %v", result, err)
	}
	if err != nil && !strings.Contains(err.Error(), "outcome is unknown") {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("ambiguous tool was replayed %d times", calls.Load())
	}
	result, err = callEcho(ctx, cli)
	assertEcho(t, result, err, "committed")
	if calls.Load() != 2 {
		t.Fatalf("subsequent explicit tool was not executed once: %d", calls.Load())
	}
}

func TestBridgeCallCancellationDoesNotStopRecovery(t *testing.T) {
	// Exercise the same call handler with a short caller deadline while offline.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b := &bridge{ctx: ctx, changed: make(chan struct{}), wake: make(chan struct{}, 1)}
	short, stop := context.WithTimeout(ctx, 30*time.Millisecond)
	defer stop()
	start := time.Now()
	if _, err := b.call(short, mcp.CallToolRequest{}); err == nil {
		t.Fatal("offline call unexpectedly succeeded")
	}
	if time.Since(start) > time.Second || ctx.Err() != nil {
		t.Fatal("request cancellation affected bridge lifetime")
	}
}

func TestBridgeConcurrentCallsShareRecoveredSession(t *testing.T) {
	target := &switchableRuntime{handler: echoRuntime("first")}
	var initializations atomic.Int32
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		var message struct{ Method string }
		json.Unmarshal(body, &message)
		if message.Method == "initialize" {
			initializations.Add(1)
		}
		target.ServeHTTP(w, r)
	}))
	defer httpServer.Close()
	cli := bridgeClient(t, httpServer.URL+"/mcp")
	target.replace(echoRuntime("concurrent"))
	const count = 8
	results := make(chan error, count)
	for i := 0; i < count; i++ {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			result, err := callEcho(ctx, cli)
			if err == nil && (result.IsError || result.Content[0].(mcp.TextContent).Text != "concurrent") {
				err = fmt.Errorf("result=%+v", result)
			}
			results <- err
		}()
	}
	for i := 0; i < count; i++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if initializations.Load() != 2 {
		t.Fatalf("expected one shared replacement session, got %d initializations", initializations.Load())
	}
}

func TestBridgePreservesToolErrorsWithoutReconnect(t *testing.T) {
	var initializations, calls atomic.Int32
	runtime := server.NewMCPServer("apix", "test", server.WithToolCapabilities(true))
	runtime.AddTool(mcp.NewTool("echo"), func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		calls.Add(1)
		return mcp.NewToolResultError("invalid business input"), nil
	})
	target := server.NewStreamableHTTPServer(runtime, server.WithStateful(true))
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		var message struct{ Method string }
		json.Unmarshal(body, &message)
		if message.Method == "initialize" {
			initializations.Add(1)
		}
		target.ServeHTTP(w, r)
	}))
	defer httpServer.Close()
	cli := bridgeClient(t, httpServer.URL+"/mcp")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for i := 0; i < 2; i++ {
		result, err := callEcho(ctx, cli)
		if err != nil || result == nil || !result.IsError || result.Content[0].(mcp.TextContent).Text != "invalid business input" {
			t.Fatalf("business error changed: %+v %v", result, err)
		}
	}
	if initializations.Load() != 1 || calls.Load() != 2 {
		t.Fatalf("business error retried: initializes=%d calls=%d", initializations.Load(), calls.Load())
	}
}
