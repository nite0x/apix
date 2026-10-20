package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/apix/apix/runtime/internal/commandrunner"
	"github.com/apix/apix/runtime/internal/mcpclient"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCommandCasesShareBatchesAndRedactedImmutableHistory(t *testing.T) {
	s, router := newTestRouter(t)
	t.Cleanup(func() { _ = s.Close(context.Background()) })
	zero := 0
	item := TestCase{Type: "command", Name: "script", Assertions: []FlowAssertion{{Source: "stdout", Path: "name", Operator: "equals", Expected: "Ada"}, {Source: "stdout", Path: "token", Operator: "equals", Expected: "execution-only-secret"}, {Source: "stderr", Operator: "contains", Expected: "diagnostic"}}}
	item.CommandRequest = &commandrunner.Request{Program: "python3", Args: []string{"-"}, WorkDir: t.TempDir(), Env: map[string]string{"API_TOKEN": "{{token}}"}, Stdin: "import os,json,sys\nprint(json.dumps({'name':'Ada','token':os.environ['API_TOKEN']}))\nprint('diagnostic',file=sys.stderr)\n", TimeoutSeconds: 3}
	item.ExpectedExitCode = &zero
	saved, err := s.SaveTestCase(item)
	if err != nil {
		t.Fatal(err)
	}
	batch, err := s.BeginTestBatch("", "mixed command batch")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(RunTestInput{CaseID: saved.ID, Variables: map[string]string{"token": "execution-only-secret"}})
	response := methodJSON(t, router, "POST", "/test-batches/"+batch.ID+"/runs", string(raw))
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	var out SendRequestResult
	_ = json.Unmarshal(response.Body.Bytes(), &out)
	if out.Type != "command" || out.TestStatus != "passed" || len(out.Assertions) != 4 {
		t.Fatalf("%s", response.Body.String())
	}
	if strings.Contains(response.Body.String(), "execution-only-secret") {
		t.Fatal("live secret leaked")
	}
	original, err := s.GetTestCase(saved.ID)
	if err != nil || original.CommandRequest.Env["API_TOKEN"] != "{{token}}" {
		t.Fatalf("template was replaced %#v %v", original, err)
	}
	original.Name = "edited"
	original.CommandRequest.Stdin = "print('changed')\n"
	if _, err = s.SaveTestCase(*original); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SaveTestCase(*original); err == nil {
		t.Fatal("lost edit conflict")
	}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ok") }))
	defer target.Close()
	status := 200
	if _, err = s.RunTest(context.Background(), RunTestInput{BatchID: batch.ID, TestCase: &TestCase{Name: "HTTP", Request: RequestData{Method: "GET", URL: target.URL}, ExpectedStatus: &status}}, nil); err != nil {
		t.Fatal(err)
	}
	if err = s.ArchiveTestCase(saved.ID); err != nil {
		t.Fatal(err)
	}
	history, err := s.FinishTestBatch(batch.ID)
	if err != nil || history.Counts.Passed != 2 || len(history.Runs) != 2 {
		t.Fatalf("history %#v %v", history, err)
	}
	raw, _ = json.Marshal(history)
	if strings.Contains(string(raw), "execution-only-secret") || history.Runs[0].CommandRequestSnapshot.Stdin != item.CommandRequest.Stdin || history.Runs[0].CaseVersion != 1 {
		t.Fatalf("snapshot changed or leaked: %s", raw)
	}
	if _, err = s.RunTest(context.Background(), RunTestInput{BatchID: batch.ID, TestCase: &item}, nil); err == nil {
		t.Fatal("closed batch executed a command")
	}
}
func TestCommandErrorsExitExpectationsAndOutputTruncation(t *testing.T) {
	s, _ := newTestRouter(t)
	t.Cleanup(func() { _ = s.Close(context.Background()) })
	batch, _ := s.BeginTestBatch("", "command results")
	zero, seven := 0, 7
	for _, test := range []struct {
		name, program, script, status string
		expected                      *int
		assertions                    []FlowAssertion
	}{{"expected nonzero", "python3", "import sys;sys.exit(7)", "passed", &seven, nil}, {"unexpected nonzero", "python3", "import sys;sys.exit(7)", "failed", &zero, nil}, {"unverified nonzero", "python3", "import sys;sys.exit(7)", "unverified", nil, nil}, {"missing executable", "/definitely-not-apix", "", "error", &zero, nil}, {"missing variable", "python3", "print('{{missing}}')", "error", &zero, nil}, {"incomplete output", "python3", "print('x'*300000)", "failed", &zero, []FlowAssertion{{Source: "stdout", Operator: "contains", Expected: "xxx"}}}} {
		t.Run(test.name, func(t *testing.T) {
			item := TestCase{Type: "command", Name: test.name, Assertions: test.assertions}
			item.CommandRequest = &commandrunner.Request{Program: test.program, Args: []string{"-c", test.script}, TimeoutSeconds: 2}
			item.ExpectedExitCode = test.expected
			out, err := s.RunTest(context.Background(), RunTestInput{BatchID: batch.ID, TestCase: &item}, nil)
			if err != nil || out.TestStatus != test.status {
				t.Fatalf("%+v %v", out, err)
			}
		})
	}
	if _, err := s.FinishTestBatch(batch.ID); err != nil {
		t.Fatal(err)
	}
}
func TestCommandSchemaMigrationPreservesMCPAndHTTPCases(t *testing.T) {
	s, _ := newTestRouter(t)
	saved, err := s.SaveTestCase(TestCase{Name: "HTTP before commands", Request: RequestData{Method: "GET", URL: "http://example.test"}})
	if err != nil {
		t.Fatal(err)
	}
	client, err := mcpclient.New(s.db)
	if err != nil {
		t.Fatal(err)
	}
	s.SetMCPClient(client)
	server, err := client.Save(mcpclient.Server{Name: "retained MCP", URL: "http://example.test/mcp"})
	if err != nil {
		t.Fatal(err)
	}
	mcpCase := TestCase{Type: "mcp", Name: "MCP before commands"}
	mcpCase.MCPRequest = &mcpclient.Request{ServerID: server.ID, ToolName: "lookup", Arguments: map[string]any{"id": "old"}}
	mcpSaved, err := s.SaveTestCase(mcpCase)
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"test_cases", "test_case_runs"} {
		if _, err = s.db.Exec("ALTER TABLE " + table + " DROP COLUMN command_data"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = s.db.Exec("UPDATE schema_metadata SET version=6 WHERE name='http_domain'"); err != nil {
		t.Fatal(err)
	}
	if err = s.MigrateSchema(s.db); err != nil {
		t.Fatal(err)
	}
	loaded, err := s.GetTestCase(saved.ID)
	if err != nil || loaded.Type != "http" || loaded.Request.URL != saved.Request.URL {
		t.Fatalf("migration %+v %v", loaded, err)
	}
	if err = s.MigrateSchema(s.db); err != nil {
		t.Fatal(err)
	}
	mcpLoaded, err := s.GetTestCase(mcpSaved.ID)
	if err != nil || mcpLoaded.Type != "mcp" || mcpLoaded.MCPRequest.Arguments["id"] != "old" {
		t.Fatalf("MCP migration %+v %v", mcpLoaded, err)
	}
}

func TestCommandInFlightBatchAndRuntimeShutdown(t *testing.T) {
	s, _ := newTestRouter(t)
	batch, _ := s.BeginTestBatch("", "running command")
	marker := filepath.Join(t.TempDir(), "started")
	item := TestCase{Type: "command", Name: "wait"}
	item.CommandRequest = &commandrunner.Request{Program: "python3", Args: []string{"-c", "import pathlib,sys,time;pathlib.Path(sys.argv[1]).write_text('started');time.sleep(60)", marker}, TimeoutSeconds: 3}
	result := make(chan *SendRequestResult, 1)
	failure := make(chan error, 1)
	go func() {
		out, err := s.RunTest(context.Background(), RunTestInput{BatchID: batch.ID, TestCase: &item}, nil)
		result <- out
		failure <- err
	}()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("command did not start", err)
	}
	if _, err := s.FinishTestBatch(batch.ID); err == nil {
		t.Fatal("batch ended with a running command")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	out := <-result
	if err := <-failure; err != nil || out.TestStatus != "error" {
		t.Fatalf("shutdown %+v %v", out, err)
	}
	closed, err := s.FinishTestBatch(batch.ID)
	if err != nil || closed.Counts.Running != 0 || closed.Counts.Errors != 1 {
		t.Fatalf("shutdown history %+v %v", closed, err)
	}
}
func TestCommandInheritedAndArgumentSecretsAreRedacted(t *testing.T) {
	s, _ := newTestRouter(t)
	t.Cleanup(func() { _ = s.Close(context.Background()) })
	t.Setenv("APIX_TEST_PRIVATE_KEY", "ambient-secret")
	batch, _ := s.BeginTestBatch("", "secret masking")
	item := TestCase{Type: "command", Name: "secrets", Assertions: []FlowAssertion{{Source: "stdout", Operator: "contains", Expected: "argument-secret"}}}
	item.CommandRequest = &commandrunner.Request{Program: "python3", Args: []string{"-c", "import os,sys;print(os.environ['APIX_TEST_PRIVATE_KEY']);print(sys.argv[2])", "--token", "argument-secret"}}
	out, err := s.RunTest(context.Background(), RunTestInput{BatchID: batch.ID, TestCase: &item}, nil)
	if err != nil || out.TestStatus != "passed" {
		t.Fatalf("%+v %v", out, err)
	}
	history, err := s.FinishTestBatch(batch.ID)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(history)
	if strings.Contains(string(raw), "ambient-secret") || strings.Contains(string(raw), "argument-secret") {
		t.Fatalf("leaked credentials: %s", raw)
	}
}

func TestCommandRedactionPreservesOutputFormatting(t *testing.T) {
	input := "  {\n  \"ok\": true, \"token\": \"hidden-secret\", \"nested\": [{\"password\": \"private\", \"keep\": 1}]\n}\n"
	expected := "  {\n  \"ok\": true, \"token\": \"••••••\", \"nested\": [{\"password\": \"••••••\", \"keep\": 1}]\n}\n"
	if actual := redactCommandText(input, nil); actual != expected {
		t.Fatalf("format changed:\n%q\nwant:\n%q", actual, expected)
	}
	plain := "stdout with spaces  \nand newline\n"
	if actual := redactCommandText(plain, nil); actual != plain {
		t.Fatal("plain output changed", actual)
	}
	jsonOutput := "{ \"ok\": true, \"count\": 3 }\n"
	if actual := redactCommandText(jsonOutput, nil); actual != jsonOutput {
		t.Fatal("non-sensitive JSON changed", actual)
	}
}
