package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/apix/apix/runtime/internal/mcpclient"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func mcpTestingTarget(t *testing.T) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	calls := &atomic.Int32{}
	srv := server.NewMCPServer("test-tools", "1", server.WithToolCapabilities(true))
	tool := mcp.NewTool("lookup", mcp.WithObject("input"), mcp.WithRawOutputSchema(json.RawMessage(`{"type":"object","properties":{"name":{"type":"string"},"token":{"type":"string"}},"required":["name"]}`)))
	srv.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		calls.Add(1)
		args := req.GetArguments()
		if args["slow"] == true {
			select {
			case <-ctx.Done():
			case <-time.After(100 * time.Millisecond):
			}
		}
		if args["protocol"] == true {
			return nil, fmt.Errorf("protocol failure")
		}
		if args["invalid"] == true {
			return mcp.NewToolResultError("missing name"), nil
		}
		if args["bad_schema"] == true {
			return mcp.NewToolResultStructuredOnly(map[string]any{"name": 123}), nil
		}
		return mcp.NewToolResultStructured(map[string]any{"name": args["name"], "token": args["token"], "echo": args["token"]}, "lookup result"), nil
	})
	target := httptest.NewServer(server.NewStreamableHTTPServer(srv))
	t.Cleanup(target.Close)
	return target, calls
}
func TestMCPTestsShareBatchesAndKeepImmutableRedactedHistory(t *testing.T) {
	s, router := newTestRouter(t)
	client, e := mcpclient.New(s.db)
	if e != nil {
		t.Fatal(e)
	}
	s.SetMCPClient(client)
	client.Routes(router)
	target, calls := mcpTestingTarget(t)
	saved, e := client.Save(mcpclient.Server{Name: "Lookup MCP", URL: target.URL, TimeoutSeconds: 2})
	if e != nil {
		t.Fatal(e)
	}
	batch, e := s.BeginTestBatch("", "mixed tests")
	if e != nil {
		t.Fatal(e)
	}
	expected := false
	item := TestCase{Type: "mcp", Name: "normal", Assertions: []FlowAssertion{{Source: "structuredContent", Path: "name", Operator: "equals", Expected: "Ada"}, {Source: "structuredContent", Path: "token", Operator: "equals", Expected: "runtime-secret"}}}
	item.MCPRequest = &mcpclient.Request{ServerID: saved.ID, ToolName: "lookup", Arguments: map[string]any{"name": "Ada", "token": "{{token}}"}}
	item.ExpectedIsError = &expected
	item.ValidateOutputSchema = true
	itemSaved, e := s.SaveTestCase(item)
	if e != nil {
		t.Fatal(e)
	}
	encoded, _ := json.Marshal(RunTestInput{CaseID: itemSaved.ID, Variables: map[string]string{"token": "runtime-secret"}})
	response := methodJSON(t, router, "POST", "/test-batches/"+batch.ID+"/runs", string(encoded))
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	var out SendRequestResult
	json.Unmarshal(response.Body.Bytes(), &out)
	if out.TestStatus != "passed" || len(out.Assertions) != 4 || out.Type != "mcp" || calls.Load() != 1 {
		t.Fatalf("result: %s", response.Body.String())
	}
	if strings.Contains(response.Body.String(), "runtime-secret") {
		t.Fatal("response exposes secret")
	}
	// Saved cases remain templates; live values never replace their definitions.
	current, e := s.GetTestCase(itemSaved.ID)
	if e != nil || current.MCPRequest.Arguments["token"] != "{{token}}" {
		t.Fatalf("template changed %#v %v", current, e)
	}
	history, e := s.GetTestBatch(batch.ID)
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(history)
	if strings.Contains(string(raw), "runtime-secret") || len(history.Runs) != 1 || history.Runs[0].MCPResult == nil {
		t.Fatalf("history: %s", raw)
	}
	current.Name = "changed"
	current.MCPRequest.Arguments["name"] = "Grace"
	if _, e = s.SaveTestCase(*current); e != nil {
		t.Fatal(e)
	}
	if _, e = s.SaveTestCase(*current); e == nil {
		t.Fatal("missing optimistic conflict")
	}
	retried, e := s.RunTest(context.Background(), RunTestInput{BatchID: batch.ID, CaseID: itemSaved.ID, Variables: map[string]string{"token": "second-secret"}}, nil)
	if e != nil || retried.TestStatus != "failed" {
		t.Fatalf("retry %#v %v", retried, e)
	}
	// HTTP cases still use the same batch and counts.
	apiTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"ok":true}`) }))
	defer apiTarget.Close()
	status := 200
	_, e = s.RunTest(context.Background(), RunTestInput{BatchID: batch.ID, TestCase: &TestCase{Name: "HTTP", Request: RequestData{Method: "GET", URL: apiTarget.URL}, ExpectedStatus: &status}}, nil)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.ArchiveTestCase(itemSaved.ID); e != nil {
		t.Fatal(e)
	}
	if e = client.Archive(saved.ID); e != nil {
		t.Fatal(e)
	}
	finished, e := s.FinishTestBatch(batch.ID)
	if e != nil || finished.Counts.Passed != 2 || finished.Counts.Failed != 1 || len(finished.Runs) != 3 {
		t.Fatalf("mixed batch %#v %v", finished, e)
	}
	if finished.Runs[0].MCPRequestSnapshot.Arguments["name"] != "Ada" || finished.Runs[0].CaseVersion != 1 {
		t.Fatal("historical snapshot changed")
	}
	if _, e = s.RunTest(context.Background(), RunTestInput{BatchID: batch.ID, TestCase: &item}, nil); e == nil {
		t.Fatal("closed batch accepted a call")
	}
}
func TestMCPErrorsSchemaAndBatchLifecycle(t *testing.T) {
	s, _ := newTestRouter(t)
	client, e := mcpclient.New(s.db)
	if e != nil {
		t.Fatal(e)
	}
	s.SetMCPClient(client)
	target, calls := mcpTestingTarget(t)
	saved, e := client.Save(mcpclient.Server{Name: "fixture", URL: target.URL, TimeoutSeconds: 1})
	if e != nil {
		t.Fatal(e)
	}
	batch, _ := s.BeginTestBatch("", "errors")
	yes, no := true, false
	for _, test := range []struct {
		name     string
		args     map[string]any
		expected *bool
		schema   bool
		status   string
	}{{"business error expected", map[string]any{"invalid": true}, &yes, false, "passed"}, {"business error unexpected", map[string]any{"invalid": true}, &no, false, "failed"}, {"protocol error", map[string]any{"protocol": true}, &no, false, "error"}, {"schema mismatch", map[string]any{"bad_schema": true}, &no, true, "failed"}, {"no assertions", map[string]any{"name": "Ada"}, nil, false, "unverified"}, {"missing variable", map[string]any{"name": "{{missing}}"}, &no, false, "error"}} {
		t.Run(test.name, func(t *testing.T) {
			item := TestCase{Type: "mcp", Name: test.name}
			item.MCPRequest = &mcpclient.Request{ServerID: saved.ID, ToolName: "lookup", Arguments: test.args}
			item.ExpectedIsError = test.expected
			item.ValidateOutputSchema = test.schema
			out, e := s.RunTest(context.Background(), RunTestInput{BatchID: batch.ID, TestCase: &item}, nil)
			if e != nil || out.TestStatus != test.status {
				t.Fatalf("%#v %v", out, e)
			}
		})
	}
	if calls.Load() != 5 {
		t.Fatalf("calls should not retry or send unresolved variables: %d", calls.Load())
	}
	// Reserve before network work; finish cannot race a running MCP attempt.
	item := TestCase{Type: "mcp", Name: "slow"}
	item.MCPRequest = &mcpclient.Request{ServerID: saved.ID, ToolName: "lookup", Arguments: map[string]any{"slow": true, "name": "Ada"}}
	item.ExpectedIsError = &no
	result := make(chan error, 1)
	go func() {
		_, err := s.RunTest(context.Background(), RunTestInput{BatchID: batch.ID, TestCase: &item}, nil)
		result <- err
	}()
	deadline := time.Now().Add(time.Second)
	for calls.Load() != 6 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if _, e = s.FinishTestBatch(batch.ID); e == nil {
		t.Fatal("finished in-flight MCP batch")
	}
	if e = <-result; e != nil {
		t.Fatal(e)
	}
	// Startup recovery applies equally to MCP and HTTP runs.
	if _, e = s.db.Exec(`INSERT INTO test_case_runs(id,batch_id,name,request_snapshot,type,mcp_data,status,started_at) VALUES('interrupted',?,'MCP','{}','mcp','{}','running',?)`, batch.ID, time.Now().UTC()); e != nil {
		t.Fatal(e)
	}
	if e = s.RecoverInterruptedRuns(); e != nil {
		t.Fatal(e)
	}
	history, e := s.GetTestBatch(batch.ID)
	if e != nil || history.Status != "interrupted" || history.Counts.Running != 0 || history.Counts.Errors != 3 {
		t.Fatalf("recovery %#v %v", history, e)
	}
}
func TestMCPMigrationPreservesLegacyHTTPTests(t *testing.T) {
	s, _ := newTestRouter(t)
	item, e := s.SaveTestCase(TestCase{Name: "old HTTP", Request: RequestData{Method: "GET", URL: "http://example.test"}})
	if e != nil {
		t.Fatal(e)
	}
	for _, table := range []string{"test_cases", "test_case_runs"} {
		for _, column := range []string{"type", "mcp_data"} {
			if _, e = s.db.Exec("ALTER TABLE " + table + " DROP COLUMN " + column); e != nil {
				t.Fatal(e)
			}
		}
	}
	if _, e = s.db.Exec("UPDATE schema_metadata SET version=5 WHERE name='http_domain'"); e != nil {
		t.Fatal(e)
	}
	if e = s.MigrateSchema(s.db); e != nil {
		t.Fatal(e)
	}
	loaded, e := s.GetTestCase(item.ID)
	if e != nil || loaded.Type != "http" || loaded.Request.URL != item.Request.URL {
		t.Fatalf("migration %#v %v", loaded, e)
	}
	if e = s.MigrateSchema(s.db); e != nil {
		t.Fatal("migration not idempotent", e)
	}
}

func TestMCPLargeResultsKeepLiveAssertionsAndBoundedHistory(t *testing.T) {
	full := strings.Repeat("x", 300*1024)
	item := TestCase{Name: "large", Type: "mcp", Assertions: []FlowAssertion{{Source: "structuredContent", Path: "payload", Operator: "equals", Expected: full}}}
	result := &mcpclient.Result{Tool: map[string]any{"name": "large"}, Response: mcp.NewToolResultStructuredOnly(map[string]any{"payload": full})}
	assertions := evaluateMCPAssertions(&item, result)
	if len(assertions) != 1 || !assertions[0].Passed {
		t.Fatal("assertion was evaluated against a truncated result")
	}
	raw, _ := json.Marshal(mcpResultSnapshot(result, nil))
	if len(raw) > 256*1024 || !strings.Contains(string(raw), "snapshot_truncated") {
		t.Fatalf("unbounded snapshot %d", len(raw))
	}
	raw, _ = json.Marshal(mcpEvidencePreview(assertions[0].Actual))
	if len(raw) > 16384 {
		t.Fatal("unbounded assertion evidence")
	}
}
