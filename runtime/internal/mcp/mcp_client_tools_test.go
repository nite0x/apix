package mcp_test

import (
	"context"
	"encoding/json"
	external "github.com/apix/apix/runtime/internal/mcpclient"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"net/http/httptest"
	"testing"
)

func TestExternalMCPToolTestsThroughApixMCP(t *testing.T) {
	c := setupMVP(t)
	srv := server.NewMCPServer("external", "1", server.WithToolCapabilities(true))
	srv.AddTool(mcp.NewTool("echo", mcp.WithString("name")), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return mcp.NewToolResultStructuredOnly(map[string]any{"name": req.GetArguments()["name"]}), nil
	})
	target := httptest.NewServer(server.NewStreamableHTTPServer(srv))
	defer target.Close()
	saved, err := c.registry.Save(external.Server{Name: "external", URL: target.URL})
	if err != nil {
		t.Fatal(err)
	}
	listed := c.call(t, "list_mcp_servers", map[string]any{}, false)
	if len(listed["items"].([]any)) != 1 {
		t.Fatal(listed)
	}
	found := c.call(t, "discover_mcp_tools", map[string]any{"server_id": saved.ID}, false)
	if len(found["tools"].([]any)) != 1 {
		t.Fatal(found)
	}
	batch := c.call(t, "begin_test_batch", map[string]any{"name": "MCP tests"}, false)
	definition := map[string]any{"type": "mcp", "name": "echo Ada", "mcp_request": map[string]any{"server_id": saved.ID, "tool_name": "echo", "arguments": map[string]any{"name": "{{name}}"}}, "expected_is_error": false, "assertions": []any{map[string]any{"source": "structuredContent", "path": "name", "operator": "equals", "expected": "Ada"}}}
	item := c.call(t, "save_test_case", map[string]any{"test_case": definition}, false)
	out := c.call(t, "run_test_case", map[string]any{"batch_id": batch["id"], "case_id": item["id"], "variables": map[string]any{"name": "Ada"}}, false)
	if out["type"] != "mcp" || out["test_status"] != "passed" {
		raw, _ := json.Marshal(out)
		t.Fatal(string(raw))
	}
	history := c.call(t, "finish_test_batch", map[string]any{"batch_id": batch["id"]}, false)
	if history["counts"].(map[string]any)["passed"] != float64(1) {
		t.Fatal(history)
	}
}
