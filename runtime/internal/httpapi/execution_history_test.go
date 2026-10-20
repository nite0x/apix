package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/apix/apix/runtime/internal/core"
	"github.com/apix/apix/runtime/internal/database"
	"github.com/apix/apix/runtime/internal/executionrecord"
	"github.com/apix/apix/runtime/internal/localservice"
)

func TestAllExecutionTypesShareOneBatch(t *testing.T) {
	s, _ := newTestRouter(t)
	db, err := database.New(s.db)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	services, err := localservice.New(s.db)
	if err != nil {
		t.Fatal(err)
	}
	defer services.Close()
	s.SetCapabilities(db, services)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("{}")) }))
	defer target.Close()
	batch, _ := s.BeginTestBatch("", "mixed executions")
	_, err = s.execution.Run(context.Background(), RunCommand{BatchID: batch.ID, InlineRequest: &RequestData{Method: "GET", URL: target.URL}}, core.NewVariables())
	if err != nil {
		t.Fatal(err)
	}
	// Failed executions must remain visible too, without requiring real external services.
	_, err = db.Execute(context.Background(), database.Command{BatchID: batch.ID, ConnectionID: "missing", Mode: "query", SQL: "SELECT 1"})
	if err == nil {
		t.Fatal("expected missing connection")
	}
	_, err = services.Start(executionrecord.WithBatch(context.Background(), batch.ID), "missing", "manual")
	if err == nil {
		t.Fatal("expected missing service")
	}
	_, err = s.RunTest(context.Background(), RunTestInput{BatchID: batch.ID, TestCase: &TestCase{Type: "mcp", Name: "MCP missing", MCPTestData: MCPTestData{}}}, nil)
	// Invalid test definitions are rejected before execution and do not reserve history.
	if err == nil {
		t.Fatal("expected invalid MCP request")
	}
	history, err := s.FinishTestBatch(batch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if history.Counts.Total != 3 || history.Counts.Errors != 2 || history.Counts.Unverified != 1 {
		t.Fatalf("%+v", history)
	}
	types := map[string]TestCaseRun{}
	for _, run := range history.Runs {
		types[run.Type] = run
	}
	if types["http"].APIRunID == nil || types["sql"].Input == nil || types["service"].Input == nil {
		t.Fatalf("%+v", history.Runs)
	}
	before, _ := db.ListExecutions(context.Background(), "")
	_, err = db.Execute(context.Background(), database.Command{BatchID: batch.ID, ConnectionID: "missing", Mode: "query", SQL: "SELECT 2"})
	if err == nil {
		t.Fatal("closed batch accepted SQL")
	}
	after, _ := db.ListExecutions(context.Background(), "")
	if len(before) != len(after) {
		t.Fatal("SQL ran before batch validation")
	}
}

func TestStandaloneExecutionsAutomaticallyCreateCompletedBatches(t *testing.T) {
	s, _ := newTestRouter(t)
	request := RequestData{Method: "GET", URL: "http://127.0.0.1:1/?token=private"}
	_, _ = s.execution.Run(context.Background(), RunCommand{InlineRequest: &request}, core.NewVariables())
	batches, err := s.ListTestBatches("")
	if err != nil || len(batches) != 1 {
		t.Fatalf("%+v %v", batches, err)
	}
	batch, err := s.GetTestBatch(batches[0].ID)
	if err != nil || batch.Status != "completed" || batch.Counts.Errors != 1 || len(batch.Runs) != 1 {
		t.Fatalf("%+v %v", batch, err)
	}
	data, _ := json.Marshal(batch)
	if strings.Contains(string(data), "private") {
		t.Fatalf("unredacted history: %s", data)
	}
}

func TestGenericExecutionReservationBlocksFinishAndPersistsCancelledResults(t *testing.T) {
	s, _ := newTestRouter(t)
	batch, _ := s.BeginTestBatch("", "reserved SQL")
	ctx, cancel := context.WithCancel(context.Background())
	finish, err := s.RecordExecution(ctx, "sql", "SQL", batch.ID, map[string]any{"password": "secret"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.FinishTestBatch(batch.ID); err == nil {
		t.Fatal("finished in-flight batch")
	}
	cancel()
	if err = finish(map[string]any{"token": "secret"}, errors.New("cancelled")); err != nil {
		t.Fatal(err)
	}
	result, err := s.FinishTestBatch(batch.ID)
	if err != nil || result.Counts.Errors != 1 {
		t.Fatalf("%+v %v", result, err)
	}
	data, _ := json.Marshal(result)
	if strings.Contains(string(data), "secret") {
		t.Fatal(string(data))
	}
}

func TestFlowRunsAppearAsSingleBatchesWithoutDuplicatedHTTP(t *testing.T) {
	s, _ := newTestRouter(t)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("{}")) }))
	defer target.Close()
	flow, err := s.SaveFlow(Flow{Name: "flow history", Steps: []FlowStep{{Type: "http", Name: "request", Enabled: true, Request: RequestData{Method: "GET", URL: target.URL}}}})
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.repo.createFlowRun(flow, nil, "manual", nil)
	if err != nil {
		t.Fatal(err)
	}
	s.flow.run(context.Background(), run.ID, nil)
	batches, err := s.ListTestBatches("")
	if err != nil || len(batches) != 1 || batches[0].Source != "flow" || batches[0].Counts.Total != 1 {
		t.Fatalf("%+v %v", batches, err)
	}
	batch, err := s.GetTestBatch(run.ID)
	if err != nil || batch.Status != "completed" || len(batch.Runs) != 1 || batch.Runs[0].APIRunID == nil {
		t.Fatalf("%+v %v", batch, err)
	}
	var count int
	if err = s.db.QueryRow("SELECT count(*) FROM test_case_runs").Scan(&count); err != nil || count != 0 {
		t.Fatalf("duplicate records %d: %v", count, err)
	}
}
