package mcpbridge

import (
	"context"
	"fmt"
	mcpclient "github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"net/http/httptest"
	"os"
	"strings"
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
