package mcp_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/apix/apix/runtime/internal/core"
	"github.com/apix/apix/runtime/internal/database"
	"github.com/apix/apix/runtime/internal/httpapi"
	"github.com/apix/apix/runtime/internal/journal"
	"github.com/apix/apix/runtime/internal/localservice"
	mcpserver "github.com/apix/apix/runtime/internal/mcp"
	testmcp "github.com/apix/apix/runtime/internal/mcpclient"
	"github.com/apix/apix/runtime/internal/store"
	"github.com/gin-gonic/gin"
	"github.com/go-sql-driver/mysql"
	mcpclient "github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"
)

type mvpClient struct {
	client   *mcpclient.Client
	context  context.Context
	executor *core.Executor
	registry *testmcp.Service
}

func setupMVP(t *testing.T) *mvpClient {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db := store.NewSQLiteStore(filepath.Join(t.TempDir(), "runtime.db"))
	db.DB().SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.DB().Close() })
	history, err := journal.New(db.DB(), filepath.Join(t.TempDir(), "runtime.log"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = history.Close() })
	dbs, err := database.New(db.DB())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbs.Close() })
	services, err := localservice.New(db.DB())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = services.Close() })
	sessions := core.NewSessionManager(db)
	rules := core.NewRuleEngine(db)
	events := core.NewEvents(nil)
	hs := httpapi.New()
	if err := hs.MigrateSchema(db.DB()); err != nil {
		t.Fatal(err)
	}
	registry, err := testmcp.New(db.DB())
	if err != nil {
		t.Fatal(err)
	}
	hs.SetMCPClient(registry)
	hs.SetCapabilities(dbs, services)
	hs.SetEventSink(history.Append)
	hs.SetRuleEngine(rules)

	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := hs.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	executor := core.NewExecutor(sessions, rules, events, db, hs.Execute, hs.ExtractVars)
	server := mcpserver.NewServer(executor)
	server.RegisterHTTPTools(hs)
	server.RegisterCapabilities(hs, dbs, services, history)
	server.RegisterMCPClientTools(registry, history)
	router := gin.New()
	router.Any("/mcp", gin.WrapH(server.HTTPHandler()))
	hs.Routes(router.Group("/api"))
	gateway := httptest.NewServer(router)
	t.Cleanup(gateway.Close)
	client, err := mcpclient.NewStreamableHttpClient(gateway.URL + "/mcp")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	t.Cleanup(cancel)
	if err := client.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Initialize(ctx, mcp.InitializeRequest{Params: mcp.InitializeParams{ProtocolVersion: mcp.LATEST_PROTOCOL_VERSION, ClientInfo: mcp.Implementation{Name: "mvp-integration", Version: "1"}}}); err != nil {
		t.Fatal(err)
	}
	return &mvpClient{client: client, context: ctx, executor: executor, registry: registry}
}

func (c *mvpClient) call(t *testing.T, name string, args map[string]any, wantError bool) map[string]any {
	t.Helper()
	r, err := c.client.CallTool(c.context, mcp.CallToolRequest{Params: mcp.CallToolParams{Name: name, Arguments: args}})
	if err != nil {
		t.Fatal(err)
	}
	if r.IsError != wantError {
		t.Fatalf("%s IsError=%v want=%v: %#v", name, r.IsError, wantError, r)
	}
	data, err := json.Marshal(r.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]any{}
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("%s missing structured result: %s", name, data)
	}
	return out
}
func result(t *testing.T, out map[string]any) map[string]any {
	t.Helper()
	v, ok := out["result"].(map[string]any)
	if !ok {
		t.Fatalf("no result: %#v", out)
	}
	return v
}
func (c *mvpClient) save(t *testing.T, steps []any) string {
	v := result(t, c.call(t, "save_flow", map[string]any{"flow": map[string]any{"name": "MVP integration", "steps": steps}}, false))
	return v["id"].(string)
}
func (c *mvpClient) run(t *testing.T, id string) string {
	return result(t, c.call(t, "run_flow", map[string]any{"flow_id": id}, false))["id"].(string)
}
func (c *mvpClient) wait(t *testing.T, id string) map[string]any {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		v := c.call(t, "get_flow_run", map[string]any{"run_id": id}, false)
		if v["status"] == "succeeded" || v["status"] == "failed" || v["status"] == "cancelled" {
			return v
		}
	}
	t.Fatal("run did not finish")
	return nil
}
func requestStep(url string, expected int) map[string]any {
	return map[string]any{"type": "http", "name": "HTTP check", "request": map[string]any{"method": "GET", "url": url}, "config": map[string]any{"expected_status": expected}}
}

func TestServiceReuseAndDetailsThroughMCP(t *testing.T) {
	c := setupMVP(t)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer target.Close()
	service := map[string]any{"id": "external", "name": "Existing service", "command": "must-not-be-launched", "work_dir": t.TempDir(), "health_url": target.URL}
	c.call(t, "save_service", map[string]any{"service": service}, false)
	instance := result(t, c.call(t, "start_service", map[string]any{"service_id": "external"}, false))
	if instance["started"] != false || instance["owner"] != "external" || instance["status"] != "running" {
		t.Fatalf("MCP did not reuse external service: %#v", instance)
	}
	details := c.call(t, "get_service_details", map[string]any{"service_id": "external"}, false)
	if details["definition"].(map[string]any)["command"] != "must-not-be-launched" || details["health"].(map[string]any)["healthy"] != true {
		t.Fatalf("MCP details incomplete: %#v", details)
	}
}

func TestMVPToolsStructuredResultsAndAssertions(t *testing.T) {
	c := setupMVP(t)
	advertised, err := c.client.ListTools(c.context, mcp.ListToolsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"send_request", "execute_sql", "save_service", "start_service", "get_service_details", "get_service_logs", "save_flow", "run_flow", "get_flow_run", "cancel_flow_run", "get_run_events", "get_operation"} {
		if !hasTool(advertised.Tools, name) {
			t.Fatalf("missing tool %s", name)
		}
	}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(201)
		_, _ = w.Write([]byte(`{"id":"abc"}`))
	}))
	defer target.Close()
	id := c.save(t, []any{requestStep(target.URL, 201)})
	runID := c.run(t, id)
	run := c.wait(t, runID)
	if run["status"] != "succeeded" {
		t.Fatalf("run: %#v", run)
	}
	steps := run["steps"].([]any)
	step := steps[0].(map[string]any)
	if step["api_run_id"] == nil || step["type"] != "http" || len(step["assertions"].([]any)) != 1 {
		t.Fatalf("missing evidence %#v", step)
	}
	events := c.call(t, "get_run_events", map[string]any{"run_id": runID}, false)["items"].([]any)
	if len(events) < 4 || events[len(events)-1].(map[string]any)["type"] != "flow_run.finished" {
		t.Fatalf("events: %#v", events)
	}
	id = c.save(t, []any{requestStep(target.URL, 200), requestStep(target.URL, 201)})
	run = c.wait(t, c.run(t, id))
	if run["status"] != "failed" {
		t.Fatalf("false pass %#v", run)
	}
	steps = run["steps"].([]any)
	assertion := steps[0].(map[string]any)["assertions"].([]any)[0].(map[string]any)
	if assertion["passed"] != false || assertion["expected"] != float64(200) || assertion["actual"] != float64(201) {
		t.Fatalf("assertion %#v", assertion)
	}
	if steps[1].(map[string]any)["status"] != "cancelled" {
		t.Fatal("subsequent step executed")
	}
	connection := c.call(t, "save_database_connection", map[string]any{"connection": map[string]any{"id": "direct", "name": "test", "host": "127.0.0.1", "port": 3306, "database": "test", "username": "tester", "password": "mcp-secret"}}, false)
	if connection["operation_id"] == nil {
		t.Fatal("no operation record")
	}
	savedOperation := c.call(t, "get_operation", map[string]any{"operation_id": connection["operation_id"]}, false)
	serialized, _ := json.Marshal(savedOperation)
	if strings.Contains(string(serialized), "mcp-secret") || strings.Contains(string(serialized), `"password"`) {
		t.Fatal("MCP history leaked password")
	}
	failure := c.call(t, "test_database_connection", map[string]any{"connection_id": "missing"}, true)
	op := c.call(t, "get_operation", map[string]any{"operation_id": failure["operation_id"]}, false)
	if op["status"] != "failed" || op["error"] == "" {
		t.Fatalf("failure not persisted: %#v", op)
	}
}

func TestDeleteDatabaseConnectionThroughMCP(t *testing.T) {
	c := setupMVP(t)
	c.call(t, "save_database_connection", map[string]any{"connection": map[string]any{"id": "delete-me", "name": "test", "host": "localhost", "database": "test", "username": "tester"}}, false)
	c.call(t, "delete_database_connection", map[string]any{"connection_id": "delete-me"}, true)
	c.call(t, "apply_resource_lifecycle", map[string]any{"items": []any{map[string]any{"kind": "database", "id": "delete-me", "action": "archive"}}}, false)
	deleted := result(t, c.call(t, "delete_database_connection", map[string]any{"connection_id": "delete-me"}, false))
	if deleted["deleted"] != true {
		t.Fatalf("delete result: %#v", deleted)
	}
	items := c.call(t, "list_database_connections", map[string]any{}, false)["items"].([]any)
	if len(items) != 0 {
		t.Fatalf("deleted connection is still listed: %#v", items)
	}
	c.call(t, "delete_database_connection", map[string]any{"connection_id": "delete-me"}, true)
}

func TestPostgreSQLConnectionSettingsThroughMCP(t *testing.T) {
	c := setupMVP(t)
	for _, kind := range []string{"postgresql", "hologres"} {
		connection := map[string]any{"id": kind, "type": kind, "name": kind, "host": "localhost", "database": "test", "username": "tester", "password": "pg-route-secret", "ssl_mode": "require"}
		saved := result(t, c.call(t, "save_database_connection", map[string]any{"connection": connection}, false))
		if saved["type"] != kind || saved["ssl_mode"] != "require" || saved["password"] != nil {
			t.Fatalf("PostgreSQL settings lost or password leaked: %#v", saved)
		}
		delete(connection, "type")
		delete(connection, "password")
		delete(connection, "ssl_mode")
		saved = result(t, c.call(t, "save_database_connection", map[string]any{"connection": connection}, false))
		if saved["type"] != kind || saved["ssl_mode"] != "require" {
			t.Fatalf("legacy update replaced PostgreSQL settings: %#v", saved)
		}
	}
	items := c.call(t, "list_database_connections", map[string]any{}, false)["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("PostgreSQL connections missing: %#v", items)
	}
}

func TestMVPProcessHelper(t *testing.T) {
	address := os.Getenv("APIX_MVP_HELPER_ADDR")
	if address == "" {
		return
	}
	mux := http.NewServeMux()
	if table := os.Getenv("APIX_MVP_MYSQL_TABLE"); table != "" {
		db, err := sql.Open("mysql", os.Getenv("APIX_TEST_MYSQL_DSN"))
		if err != nil {
			os.Exit(3)
		}
		defer db.Close()
		mux.HandleFunc("/users", func(w http.ResponseWriter, r *http.Request) {
			id := fmt.Sprintf("%d", time.Now().UnixNano())
			if _, err := db.ExecContext(r.Context(), "INSERT INTO "+table+"(id,name) VALUES(?,?)", id, "MCP integration"); err != nil {
				http.Error(w, "insert failed", 500)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(map[string]string{"id": id})
		})
	}
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("ok")) })
	mux.HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(20 * time.Second):
			_, _ = w.Write([]byte("ok"))
		}
	})
	fmt.Fprintln(os.Stdout, "MVP helper ready")
	if err := http.ListenAndServe(address, mux); err != nil {
		os.Exit(2)
	}
	os.Exit(0)
}

func TestMVPRealMySQLServiceHTTPFlow(t *testing.T) {
	dsn := os.Getenv("APIX_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("APIX_TEST_MYSQL_DSN required for real MySQL flow")
	}
	c := setupMVP(t)
	table := fmt.Sprintf("apix_mcp_%d", time.Now().UnixNano())
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	defer db.Exec("DROP TABLE IF EXISTS " + table)
	fixture, err := mysql.ParseDSN(dsn)
	if err != nil {
		t.Fatal("invalid integration fixture DSN")
	}
	host, port, err := net.SplitHostPort(fixture.Addr)
	if err != nil || fixture.Net != "tcp" {
		t.Fatal("integration fixture must use TCP")
	}
	portNumber, _ := strconv.Atoi(port)
	c.call(t, "save_database_connection", map[string]any{"connection": map[string]any{"id": "mysql", "name": "real MySQL", "host": host, "port": portNumber, "database": fixture.DBName, "username": fixture.User, "password": fixture.Passwd}}, false)
	c.call(t, "test_database_connection", map[string]any{"connection_id": "mysql"}, false)
	c.call(t, "execute_sql", map[string]any{"command": map[string]any{"connection_id": "mysql", "mode": "exec", "sql": "CREATE TABLE " + table + "(id VARCHAR(40) PRIMARY KEY,name VARCHAR(120))"}}, false)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	t.Setenv("APIX_MVP_HELPER_ADDR", address)
	t.Setenv("APIX_MVP_MYSQL_TABLE", table)
	exe, _ := os.Executable()
	c.call(t, "save_service", map[string]any{"service": map[string]any{"id": "mysql-service", "name": "MySQL-backed service", "work_dir": t.TempDir(), "command": exe, "args": []string{"-test.run=^TestMVPProcessHelper$"}, "health_url": "http://" + address + "/health", "startup_timeout_ms": 3000}}, false)
	steps := []any{
		map[string]any{"type": "service", "name": "start API", "service": map[string]any{"service_id": "mysql-service", "action": "start"}},
		map[string]any{"type": "http", "name": "create record", "request": map[string]any{"method": "POST", "url": "http://" + address + "/users"}, "config": map[string]any{"expected_status": 201, "extractors": []any{map[string]any{"name": "user_id", "source": "body", "path": "id", "scope": "run", "required": true}}}},
		map[string]any{"type": "sql", "name": "verify persisted record", "sql": map[string]any{"connection_id": "mysql", "mode": "query", "sql": "SELECT id,name FROM " + table + " WHERE id = ?", "params": []any{"{{user_id}}"}}, "config": map[string]any{"expected_rows": 1}},
		map[string]any{"type": "sql", "name": "delete test record", "sql": map[string]any{"connection_id": "mysql", "mode": "exec", "sql": "DELETE FROM " + table + " WHERE id = ?", "params": []any{"{{user_id}}"}}},
	}
	id := c.save(t, steps)
	for i := 0; i < 2; i++ {
		run := c.wait(t, c.run(t, id))
		if run["status"] != "succeeded" {
			t.Fatalf("real flow: %#v", run)
		}
		step := run["steps"].([]any)[2].(map[string]any)
		if step["result"].(map[string]any)["row_count"] != float64(1) {
			t.Fatalf("SQL result %#v", step)
		}
		status := c.call(t, "get_service_status", map[string]any{"service_id": "mysql-service"}, false)
		if status["status"] != "stopped" {
			t.Fatalf("service not cleaned up %#v", status)
		}
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
		t.Fatalf("test data not deleted count=%d err=%v", count, err)
	}
}

func TestMVPServiceFlowCancellationCleansProcess(t *testing.T) {
	c := setupMVP(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	t.Setenv("APIX_MVP_HELPER_ADDR", address)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	definition := map[string]any{"id": "helper", "name": "MVP helper", "work_dir": t.TempDir(), "command": exe, "args": []string{"-test.run=^TestMVPProcessHelper$"}, "health_url": "http://" + address + "/health", "startup_timeout_ms": 3000}
	c.call(t, "save_service", map[string]any{"service": definition}, false)
	id := c.save(t, []any{map[string]any{"type": "service", "name": "start", "service": map[string]any{"service_id": "helper", "action": "start"}}, requestStep("http://"+address+"/slow", 200)})
	runID := c.run(t, id)
	ready := false
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		run := c.call(t, "get_flow_run", map[string]any{"run_id": runID}, false)
		steps := run["steps"].([]any)
		if steps[1].(map[string]any)["status"] == "running" {
			ready = true
			break
		}
	}
	if !ready {
		t.Fatal("service did not start")
	}
	c.call(t, "cancel_flow_run", map[string]any{"run_id": runID}, false)
	run := c.wait(t, runID)
	if run["status"] != "cancelled" || run["cleanup_error"] != nil {
		t.Fatalf("cancel/cleanup: %#v", run)
	}
	status := c.call(t, "get_service_status", map[string]any{"service_id": "helper"}, false)
	if status["status"] != "stopped" {
		t.Fatalf("process remains: %#v", status)
	}
	logs := c.call(t, "get_service_logs", map[string]any{"service_id": "helper"}, false)["items"].([]any)
	if len(logs) == 0 {
		t.Fatal("service logs missing")
	}
}

func TestLifecycleToolsUseSameArchivePurgeAndRetentionProtections(t *testing.T) {
	c := setupMVP(t)
	saved := c.call(t, "save_test_case", map[string]any{"test_case": map[string]any{"name": "managed case", "request": map[string]any{"method": "GET", "url": "http://127.0.0.1:1"}}}, false)
	id := saved["id"].(string)
	listed := c.call(t, "list_resource_lifecycle", map[string]any{"kind": "test_case"}, false)
	if len(listed["items"].([]any)) != 1 {
		t.Fatal(listed)
	}
	c.call(t, "preview_resource_purge", map[string]any{"kind": "test_case", "id": id}, true)
	operations := map[string]any{"items": []any{map[string]any{"kind": "test_case", "id": id, "action": "archive"}, map[string]any{"kind": "test_case", "id": "missing", "action": "archive"}}}
	results := c.call(t, "apply_resource_lifecycle", operations, false)["items"].([]any)
	if results[0].(map[string]any)["status"] != "succeeded" || results[1].(map[string]any)["status"] != "failed" {
		t.Fatal(results)
	}
	batch := c.call(t, "begin_test_batch", map[string]any{"name": "archived case blocked"}, false)
	c.call(t, "run_test_case", map[string]any{"batch_id": batch["id"], "case_id": id}, true)
	preview := c.call(t, "preview_resource_purge", map[string]any{"kind": "test_case", "id": id}, false)
	c.call(t, "apply_resource_lifecycle", map[string]any{"items": []any{map[string]any{"kind": "test_case", "id": id, "action": "purge", "token": preview["token"]}}}, false)
	c.call(t, "get_test_case", map[string]any{"case_id": id}, true)
	policy := c.call(t, "get_retention_policy", map[string]any{}, false)
	if policy["enabled"] != false {
		t.Fatal("auto cleanup enabled by default", policy)
	}
	c.call(t, "preview_retention_policy", map[string]any{"days": 30}, false)
}
