package database

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// Use a local SQL engine behind the cached pool to exercise execution and
// durable history without requiring a remote database or its credentials.
func historyService(t *testing.T) (*Service, *sql.DB, string) {
	t.Helper()
	s, metadata := testService(t)
	item, err := s.PutConnection(context.Background(), Connection{Name: "History test", Host: "localhost", Database: "test", Username: "tester"})
	if err != nil {
		t.Fatal(err)
	}
	pool, err := s.pool(context.Background(), item.ID)
	if err != nil {
		t.Fatal(err)
	}
	_ = pool.Close()
	remote, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	entry := s.pools[item.ID]
	entry.db = remote
	s.pools[item.ID] = entry
	return s, metadata, item.ID
}

func TestSQLExecutionHistoryOutcomesAndRestart(t *testing.T) {
	s, metadata, id := historyService(t)
	ctx := context.Background()
	command := Command{ConnectionID: id, Mode: "query", SQL: "SELECT ? AS value UNION ALL SELECT 'second'", Params: []any{"中文 <script>"}, MaxRows: 1}
	result, err := s.Execute(ctx, command)
	if err != nil || !result.Truncated {
		t.Fatalf("query: %+v %v", result, err)
	}
	items, err := s.ListExecutions(ctx, "")
	if err != nil || len(items) != 1 {
		t.Fatalf("history: %+v %v", items, err)
	}
	item := items[0]
	if item.SQL != command.SQL || string(item.Params) != `["中文 \u003cscript\u003e"]` || item.ConnectionName != "History test" || item.Status != "succeeded" || !item.Truncated || item.RowCount != -1 || item.FinishedAt == nil {
		t.Fatalf("missing query snapshot: %+v", item)
	}
	queryID := item.ID
	snapshot, err := s.GetExecutionResult(ctx, queryID)
	if err != nil || !reflect.DeepEqual(snapshot, result) {
		t.Fatalf("query result snapshot: %+v %v", snapshot, err)
	}
	if _, err := s.Execute(ctx, Command{ConnectionID: id, Mode: "exec", SQL: "CREATE TABLE sample (id INTEGER)"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Execute(ctx, Command{ConnectionID: id, Mode: "exec", SQL: "INSERT INTO sample VALUES (1), (2)"}); err != nil {
		t.Fatal(err)
	}
	items, _ = s.ListExecutions(ctx, id)
	if items[0].RowsAffected != 2 || items[0].Status != "succeeded" || items[0].Mode != "exec" {
		t.Fatalf("write summary missing: %+v", items[0])
	}
	if _, err := s.Execute(ctx, Command{ConnectionID: id, Mode: "query", SQL: "SELECT * FROM absent_table"}); err == nil {
		t.Fatal("expected SQL failure")
	}
	// Cancellation must still finalize history, even though the request's
	// context is no longer usable for writing the metadata store.
	_, err = s.Execute(ctx, Command{ConnectionID: id, Mode: "query", SQL: "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n", TimeoutMS: 50})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected timeout: %v", err)
	}
	items, _ = s.ListExecutions(ctx, id)
	if len(items) != 5 || items[0].Status != "failed" || items[0].FinishedAt == nil || !strings.Contains(items[0].Error, "deadline") || !strings.Contains(items[1].Error, "absent_table") {
		t.Fatalf("failed executions missing: %+v", items)
	}
	// A connection deletion does not erase SQL history or its saved name.
	if err := s.DeleteConnection(ctx, id); err != nil {
		t.Fatal(err)
	}
	if _, err := s.beginExecution(ctx, Command{ConnectionID: "interrupted", Mode: "query", SQL: "SELECT 1"}, time.Now()); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(metadata)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	items, err = restarted.ListExecutions(ctx, id)
	if err != nil || len(items) != 5 || items[0].ConnectionName != "History test" {
		t.Fatalf("restart lost history: %+v %v", items, err)
	}
	snapshot, err = restarted.GetExecutionResult(ctx, queryID)
	if err != nil || !reflect.DeepEqual(snapshot, result) {
		t.Fatalf("restart lost query result: %+v %v", snapshot, err)
	}
	snapshot, err = restarted.GetExecutionResult(ctx, items[0].ID)
	if err != nil || snapshot != nil {
		t.Fatalf("failed query should not have a result: %+v %v", snapshot, err)
	}
	items, _ = restarted.ListExecutions(ctx, "interrupted")
	if len(items) != 1 || items[0].Status != "failed" || items[0].FinishedAt == nil || items[0].Error == "" {
		t.Fatalf("interrupted execution stayed running: %+v", items)
	}
}

func TestSQLHistoryPreservesFlowOwnershipOnSuccessAndFailure(t *testing.T) {
	s, metadata, id := historyService(t)
	ctx := context.Background()
	for _, runID := range []string{"flow-run-one", "flow-run-two"} {
		origin := WithFlowOrigin(ctx, "flow", runID, "step-"+runID)
		for _, statement := range []string{"SELECT 1 AS value", "SELECT * FROM absent_table"} {
			_, _ = s.Execute(origin, Command{ConnectionID: id, Mode: "query", SQL: statement})
		}
	}
	_, _ = s.Execute(ctx, Command{ConnectionID: id, Mode: "query", SQL: "SELECT 1 AS value"})
	// Reinitializing also exercises the idempotent migration without deleting history.
	if err := s.initHistory(); err != nil {
		t.Fatal(err)
	}
	items, err := s.ListExecutions(ctx, id)
	if err != nil || len(items) != 5 {
		t.Fatalf("history: %+v %v", items, err)
	}
	if items[0].FlowRunID != "" || items[0].StepID != "" || items[0].FlowID != "" {
		t.Fatal("standalone SQL was assigned an unrelated batch")
	}
	for i, item := range items[1:] {
		runID := "flow-run-two"
		if i >= 2 {
			runID = "flow-run-one"
		}
		if item.FlowID != "flow" || item.FlowRunID != runID || item.StepID != "step-"+runID {
			t.Fatalf("missing or incorrect SQL origin: %+v", item)
		}
	}
	var count int
	if err := metadata.QueryRow(`SELECT count(*) FROM database_executions`).Scan(&count); err != nil || count != 5 {
		t.Fatalf("persisted history: %d %v", count, err)
	}
}

func TestSQLHistoryRoutesAndLimit(t *testing.T) {
	s, _, id := historyService(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	s.Routes(r.Group("/api"))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/database/executions", nil))
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("empty history: %d %s", w.Code, w.Body.String())
	}
	body, _ := json.Marshal(Command{ConnectionID: id, Mode: "query", SQL: "SELECT ? AS value", Params: []any{"parameter"}})
	w = httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/database/execute", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("execute: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/database/executions?connection_id="+id, nil))
	var items []Execution
	if err := json.Unmarshal(w.Body.Bytes(), &items); err != nil || w.Code != 200 || len(items) != 1 || items[0].Status != "succeeded" || string(items[0].Params) != `["parameter"]` || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("history API: %d %s err=%v", w.Code, w.Body.String(), err)
	}
	if strings.Contains(w.Body.String(), `"rows"`) {
		t.Fatal("history polling must not include query rows")
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/database/executions/"+strconv.FormatInt(items[0].ID, 10)+"/result", nil))
	var detail struct {
		Result *Result `json:"result"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil || w.Code != 200 || detail.Result == nil || detail.Result.Rows[0]["value"] != "parameter" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("result API: %d %s err=%v", w.Code, w.Body.String(), err)
	}
	for path, status := range map[string]int{"invalid": 400, "0": 400, "-1": 400, "99999": 404} {
		w = httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("GET", "/api/database/executions/"+path+"/result", nil))
		if w.Code != status {
			t.Fatalf("result ID %s: got %d, want %d", path, w.Code, status)
		}
	}
	for i := 0; i < 105; i++ {
		if _, err := s.beginExecution(context.Background(), Command{ConnectionID: "other", Mode: "query", SQL: "SELECT 1"}, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	items, err := s.ListExecutions(context.Background(), "")
	if err != nil || len(items) != 100 || items[0].ID <= items[99].ID {
		t.Fatalf("recent history limit/order: %d %v", len(items), err)
	}
	items, err = s.ListExecutions(context.Background(), id)
	if err != nil || len(items) != 1 {
		t.Fatalf("connection filter must apply before limit: %d %v", len(items), err)
	}
}

func TestSQLResultMigrationAndEmptyResult(t *testing.T) {
	s, metadata, id := historyService(t)
	ctx := context.Background()
	if _, err := s.Execute(ctx, Command{ConnectionID: id, Mode: "query", SQL: "SELECT NULL AS nullable, '' AS empty WHERE 0"}); err != nil {
		t.Fatal(err)
	}
	items, _ := s.ListExecutions(ctx, id)
	snapshot, err := s.GetExecutionResult(ctx, items[0].ID)
	if err != nil || snapshot == nil || len(snapshot.Rows) != 0 || !reflect.DeepEqual(snapshot.Columns, []string{"nullable", "empty"}) {
		t.Fatalf("empty query lost its column names: %+v %v", snapshot, err)
	}
	if _, err := metadata.Exec(`ALTER TABLE database_executions DROP COLUMN result_json`); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(metadata)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	items, err = restarted.ListExecutions(ctx, id)
	if err != nil || len(items) != 1 || items[0].Status != "succeeded" {
		t.Fatalf("migration lost old history: %+v %v", items, err)
	}
	snapshot, err = restarted.GetExecutionResult(ctx, items[0].ID)
	if err != nil || snapshot != nil {
		t.Fatalf("legacy history should have no snapshot: %+v %v", snapshot, err)
	}
	// Migrated tables can save new snapshots with NULL and empty strings intact.
	result := &Result{Columns: []string{"nullable", "empty"}, Rows: []map[string]any{{"nullable": nil, "empty": ""}}, RowCount: 1}
	entry, err := restarted.beginExecution(ctx, Command{ConnectionID: id, Mode: "query", SQL: "SELECT NULL, ''"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	restarted.finishExecution(entry, time.Now(), result, nil)
	snapshot, err = restarted.GetExecutionResult(ctx, entry)
	if err != nil || !reflect.DeepEqual(snapshot, result) {
		t.Fatalf("migrated snapshot: %+v %v", snapshot, err)
	}
}
