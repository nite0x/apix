package aiinstall

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func mcpEndpoint(t *testing.T, n int) string {
	t.Helper()
	m := server.NewMCPServer("apix", "test", server.WithToolCapabilities(true))
	for _, name := range []string{"one", "two"}[:n] {
		m.AddTool(mcp.NewTool(name), func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			t.Error("connection testing must not call tools")
			return nil, nil
		})
	}
	h := server.NewStreamableHTTPServer(m)
	gateway := httptest.NewServer(h)
	t.Cleanup(gateway.Close)
	return gateway.URL
}
func TestProbeHandshakeAndToolDiscovery(t *testing.T) {
	for _, count := range []int{0, 2} {
		result, err := probeHTTP(context.Background(), mcpEndpoint(t, count))
		if err != nil || result.ServerName != "apix" || result.ToolsCount != count {
			t.Fatalf("%+v %v", result, err)
		}
	}
}
func TestProbePaginationAndFailures(t *testing.T) {
	for _, mode := range []string{"pages", "repeat", "handshake", "tools", "wrong-server"} {
		t.Run(mode, func(t *testing.T) {
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var message struct {
					ID     any            `json:"id"`
					Method string         `json:"method"`
					Params map[string]any `json:"params"`
				}
				_ = json.NewDecoder(r.Body).Decode(&message)
				w.Header().Set("Content-Type", "application/json")
				var result any
				switch message.Method {
				case "initialize":
					if mode == "handshake" {
						w.WriteHeader(503)
						return
					}
					name := "apix"
					if mode == "wrong-server" {
						name = "other"
					}
					result = map[string]any{"protocolVersion": mcp.LATEST_PROTOCOL_VERSION, "serverInfo": map[string]string{"name": name, "version": "test"}, "capabilities": map[string]any{"tools": map[string]any{}}}
				case "notifications/initialized":
					w.WriteHeader(202)
					return
				case "tools/list":
					if mode == "tools" {
						_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": message.ID, "error": map[string]any{"code": -32603, "message": "private details"}})
						return
					}
					next := "second"
					name := "one"
					if message.Params["cursor"] == "second" && mode != "repeat" {
						next = ""
						name = "two"
					}
					result = map[string]any{"tools": []map[string]any{{"name": name, "inputSchema": map[string]any{"type": "object"}}}, "nextCursor": next}
				default:
					t.Errorf("unexpected method %s", message.Method)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": message.ID, "result": result})
			}))
			defer gateway.Close()
			result, err := probeHTTP(context.Background(), gateway.URL)
			if mode == "pages" || mode == "wrong-server" {
				if err != nil || result.ToolsCount != 2 {
					t.Fatalf("%+v %v", result, err)
				}
			} else if err == nil {
				t.Fatal("expected connection failure")
			}
			if err != nil && strings.Contains(err.Error(), "private details") {
				t.Fatal("server error details leaked")
			}
		})
	}
}
func TestConnectionResultsCacheAndConfigurationChanges(t *testing.T) {
	s, target := fixture(t)
	s.endpoint = mcpEndpoint(t, 2)
	if _, err := s.install(target, "codex"); err != nil {
		t.Fatal(err)
	}
	connection := s.testConnection(context.Background(), target, "codex")
	if connection.Status != "connected" || connection.ToolsCount == nil || *connection.ToolsCount != 2 || connection.CheckedAt.IsZero() {
		t.Fatalf("%+v", connection)
	}
	if c := s.list(target)[0]; c.Connection == nil || c.Connection.Status != "connected" {
		t.Fatal("connection result missing on refresh")
	}
	c, _ := s.client(target, "codex")
	put(t, c.Path, "[mcp_servers.apix]\nurl = \"http://other/mcp\"\n")
	if c := s.list(target)[0]; c.Connection != nil {
		t.Fatal("changed config kept old success")
	}
	if result := s.testConnection(context.Background(), target, "codex"); result.Status != "unconfigured" || result.ToolsCount != nil {
		t.Fatalf("%+v", result)
	}
}
func TestConnectionTargetFailureRecoveryAndExpiry(t *testing.T) {
	s, target := fixture(t)
	target.ID = "windows"
	target.Name = "Windows"
	calls := 0
	s.probe = func(ctx context.Context, selected Target, endpoint string) (probeResult, error) {
		calls++
		if selected.ID != "windows" || endpoint != s.endpoint {
			t.Fatal("wrong target or URL")
		}
		if calls == 1 {
			return probeResult{}, errors.New("Windows 无法连接")
		}
		return probeResult{ServerName: "apix", ToolsCount: 0}, nil
	}
	if result := s.testConnection(context.Background(), target, "cursor"); result.Status != "unconfigured" || calls != 0 {
		t.Fatalf("%+v, calls=%d", result, calls)
	}
	if _, err := s.install(target, "cursor"); err != nil {
		t.Fatal(err)
	}
	failed := s.testConnection(context.Background(), target, "cursor")
	if failed.Status != "failed" || failed.ToolsCount != nil || failed.Environment != "Windows" {
		t.Fatalf("%+v", failed)
	}
	good := s.testConnection(context.Background(), target, "cursor")
	if good.Status != "connected" || good.ToolsCount == nil || *good.ToolsCount != 0 {
		t.Fatalf("%+v", good)
	}
	cache := s.connections["windows/cursor"]
	cache.result.CheckedAt = time.Now().Add(-6 * time.Minute)
	s.connections["windows/cursor"] = cache
	if c := s.list(target)[2]; c.Connection != nil {
		t.Fatal("expired connection result still shown")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result := s.testConnection(ctx, target, "cursor")
	if result.Status != "failed" || result.ToolsCount != nil {
		t.Fatalf("%+v", result)
	}
	s.probe = func(context.Context, Target, string) (probeResult, error) {
		return probeResult{ServerName: "other", ToolsCount: 2}, nil
	}
	if result := s.testConnection(context.Background(), target, "cursor"); result.Status != "failed" {
		t.Fatalf("%+v", result)
	}
}
func TestInstallAutomaticallyVerifiesAndFailureDoesNotUndoInstall(t *testing.T) {
	gin.SetMode(gin.TestMode)
	s, target := fixture(t)
	calls := 0
	s.probe = func(context.Context, Target, string) (probeResult, error) {
		calls++
		if !s.mu.TryLock() {
			t.Error("network probe held installer lock")
		} else {
			s.mu.Unlock()
		}
		if calls == 1 {
			return probeResult{}, errors.New("暂时无法连接")
		}
		return probeResult{ServerName: "apix", ToolsCount: 3}, nil
	}
	router := gin.New()
	s.Routes(router)
	call := func(path, body, origin, contentType string) *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", "http://127.0.0.1:4317/api/ai-tools/"+path, strings.NewReader(body))
		request.Header.Set("Content-Type", contentType)
		if origin != "" {
			request.Header.Set("Origin", origin)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}
	response := call("codex/install", `{"target":"local"}`, "", "application/json")
	var installed Result
	if json.Unmarshal(response.Body.Bytes(), &installed) != nil || response.Code != 200 || installed.Status != "installed" || installed.Connection == nil || installed.Connection.Status != "failed" || calls != 1 {
		t.Fatal(response.Body.String())
	}
	if c := s.list(target)[0]; c.Status != "configured" {
		t.Fatal("failed probe undid installation")
	}
	response = call("codex/test", `{"target":"local"}`, "", "application/json")
	var connection Connection
	if json.Unmarshal(response.Body.Bytes(), &connection) != nil || response.Code != 200 || connection.Status != "connected" || *connection.ToolsCount != 3 || calls != 2 {
		t.Fatal(response.Body.String())
	}
	for _, tc := range []struct {
		path, body, origin, contentType string
		code                            int
	}{
		{"codex/test", `{"target":"local"}`, "https://evil.test", "application/json", 403},
		{"codex/test", `{"target":"local"}`, "", "text/plain", 415},
		{"codex/test", `{}`, "", "application/json", 400},
		{"codex/test", `{"target":"absent"}`, "", "application/json", 400},
		{"absent/test", `{"target":"local"}`, "", "application/json", 400},
	} {
		if response := call(tc.path, tc.body, tc.origin, tc.contentType); response.Code != tc.code {
			t.Fatalf("%+v: %d", tc, response.Code)
		}
	}
	if calls != 2 {
		t.Fatal("invalid request triggered a probe")
	}
}
