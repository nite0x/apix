package mcp_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/apix/apix/runtime/internal/core"
	"github.com/apix/apix/runtime/internal/httpapi"
	"github.com/apix/apix/runtime/internal/mcp"
	"github.com/apix/apix/runtime/internal/store"
	"github.com/gin-gonic/gin"
	mcpclient "github.com/mark3labs/mcp-go/client"
	protocol "github.com/mark3labs/mcp-go/mcp"
)

func TestStreamableHTTPCallPersistsRunAndReturnsStructuredResult(t *testing.T) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	db := store.NewSQLiteStore(filepath.Join(t.TempDir(), "apix.db"))
	t.Cleanup(func() { _ = db.DB().Close() })

	events := core.NewEvents(nil)
	rules := core.NewRuleEngine(db)
	sessions := core.NewSessionManager(db)
	httpService := httpapi.New()
	if err := httpService.MigrateSchema(db.DB()); err != nil {
		t.Fatalf("migrate HTTP schema: %v", err)
	}

	httpService.SetRuleEngine(rules)
	executor := core.NewExecutor(sessions, rules, events, db, httpService.Execute, httpService.ExtractVars)
	mcpServer := mcp.NewServer(executor)
	mcpServer.RegisterHTTPTools(httpService)

	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/echo" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"source":"mcp-test"}`))
	}))
	t.Cleanup(target.Close)

	router := gin.New()
	router.Any("/mcp", gin.WrapH(mcpServer.HTTPHandler()))
	httpService.Routes(router.Group("/api"))
	gateway := httptest.NewServer(router)
	t.Cleanup(gateway.Close)

	client, err := mcpclient.NewStreamableHttpClient(gateway.URL + "/mcp")
	if err != nil {
		t.Fatalf("create Streamable HTTP client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	ctx := context.Background()
	if err := client.Start(ctx); err != nil {
		t.Fatalf("start Streamable HTTP client: %v", err)
	}
	if _, err := client.Initialize(ctx, protocol.InitializeRequest{Params: protocol.InitializeParams{
		ProtocolVersion: protocol.LATEST_PROTOCOL_VERSION,
		ClientInfo:      protocol.Implementation{Name: "apix-test", Version: "1.0.0"},
	}}); err != nil {
		t.Fatalf("initialize MCP: %v", err)
	}

	tools, err := client.ListTools(ctx, protocol.ListToolsRequest{})
	if err != nil {
		t.Fatalf("list MCP tools: %v", err)
	}
	if !hasTool(tools.Tools, "send_request") {
		t.Fatal("send_request was not advertised by the MCP server")
	}

	result, err := client.CallTool(ctx, protocol.CallToolRequest{Params: protocol.CallToolParams{
		Name: "send_request",
		Arguments: map[string]any{
			"method":     "GET",
			"url":        target.URL + "/echo",
			"session_id": "mcp-streamable-test",
			"task":       "Verify Streamable HTTP MCP",
		},
	}})
	if err != nil {
		t.Fatalf("call send_request: %v", err)
	}
	if result.IsError {
		t.Fatalf("send_request returned an MCP tool error: %#v", result.Content)
	}
	structured, ok := result.StructuredContent.(map[string]any)
	if !ok {
		t.Fatalf("expected structured content, got %#v", result.StructuredContent)
	}
	runID, ok := structured["run_id"].(string)
	if !ok || runID == "" {
		t.Fatalf("missing run_id in structured result: %#v", structured)
	}
	if got := structured["status"]; got != float64(http.StatusOK) {
		t.Fatalf("unexpected HTTP status in structured result: %#v", got)
	}

	response, err := http.Get(gateway.URL + "/api/runs/" + runID) // #nosec G107 -- local test server URL.
	if err != nil {
		t.Fatalf("fetch persisted run: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("fetch persisted run status: %s", response.Status)
	}
	var run map[string]any
	if err := json.NewDecoder(response.Body).Decode(&run); err != nil {
		t.Fatalf("decode persisted run: %v", err)
	}
	if run["trigger_type"] != "ai" || run["session_id"] != "mcp-streamable-test" {
		t.Fatalf("run was not linked to the MCP session: %#v", run)
	}

	session, ok := executor.GetSession("mcp-streamable-test")
	if !ok || len(session.Steps) != 1 || session.Steps[0].Status != core.StepDone {
		t.Fatalf("MCP session was not completed for App display: %#v", session)
	}
}

func hasTool(tools []protocol.Tool, name string) bool {
	for _, tool := range tools {
		if tool.Name == name {
			return true
		}
	}
	return false
}
