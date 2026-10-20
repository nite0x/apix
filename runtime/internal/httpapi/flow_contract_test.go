package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/apix/apix/runtime/internal/database"
)

type flowSQLFunc func(context.Context, database.Command) (*database.Result, error)

func (f flowSQLFunc) Execute(ctx context.Context, command database.Command) (*database.Result, error) {
	return f(ctx, command)
}

func saveFlowRun(t *testing.T, s *HTTPService, flow *Flow) (*Flow, *FlowRun) {
	t.Helper()
	for i := range flow.Steps {
		flow.Steps[i].Position = i
	}
	saved, err := s.repo.updateFlow(flow, flow.EditVersion)
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.repo.createFlowRun(saved, nil, "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	return saved, run
}

func loadFinishedFlow(t *testing.T, s *HTTPService, id string) *FlowRun {
	t.Helper()
	run, err := s.repo.getFlowRun(id)
	if err != nil {
		t.Fatal(err)
	}
	return run
}

func TestFlowFinallyUsesOutputsAfterAssertionFailureAndKeepsOriginalError(t *testing.T) {
	s := newTestService(t)
	paths := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		switch r.URL.Path {
		case "/create":
			fmt.Fprint(w, `{"id":42,"name":"actual"}`)
		case "/delete/42":
			w.WriteHeader(500)
		case "/release":
			w.WriteHeader(204)
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
	}))
	defer server.Close()
	flow := mustFlow(t, s)
	create := httpStep("create", "POST", server.URL+"/create")
	create.ID = "create-user"
	create.Config.Assertions = []FlowAssertion{{Source: "body", Path: "name", Operator: "equals", Expected: "expected"}}
	create.Config.Extractors = []FlowExtractor{
		{Name: "missing", Source: "body", Path: "absent", Required: true},
		{Name: "user_id", Source: "body", Path: "id", Required: true},
	}
	body := httpStep("must not run", "GET", server.URL+"/blocked")
	remove := httpStep("delete created user", "DELETE", server.URL+"/delete/{{steps.create-user.outputs.user_id}}")
	expected := 204
	remove.Config = FlowStepConfig{Phase: "finally", ExpectedStatus: &expected, FailurePolicy: "stop"}
	release := httpStep("release", "GET", server.URL+"/release")
	release.Config.Phase = "finally"
	flow.Steps = []FlowStep{create, body, remove, release}
	saved, run := saveFlowRun(t, s, flow)
	// Editing the source after queuing must not change the run's references.
	saved.Steps[0].Name = "renamed"
	if _, err := s.repo.updateFlow(saved, saved.EditVersion); err != nil {
		t.Fatal(err)
	}
	s.flow.run(context.Background(), run.ID, nil)
	final := loadFinishedFlow(t, s, run.ID)
	if !reflect.DeepEqual(paths, []string{"/create", "/delete/42", "/release"}) {
		t.Fatalf("execution order: %v", paths)
	}
	if final.Status != "failed" || final.ErrorCode != "assertion_failed" || !strings.Contains(final.ErrorMessage, "body name equals") {
		t.Fatalf("original failure overwritten: %#v", final)
	}
	if !strings.Contains(final.CleanupError, "delete created user") || final.Steps[1].Status != "cancelled" || final.Steps[3].Status != "succeeded" {
		t.Fatalf("cleanup did not continue: %#v", final)
	}
	if final.Steps[2].Phase != "finally" || final.Steps[0].NameSnapshot != "create" {
		t.Fatal("immutable phase/name snapshot missing")
	}
}

func TestFlowFinallyFailureFailsSuccessfulBody(t *testing.T) {
	s := newTestService(t)
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path == "/cleanup" {
			w.WriteHeader(503)
		}
	}))
	defer server.Close()
	flow := mustFlow(t, s)
	body := httpStep("body", "GET", server.URL)
	cleanup := httpStep("cleanup", "GET", server.URL+"/cleanup")
	status := 204
	cleanup.Config = FlowStepConfig{Phase: "finally", ExpectedStatus: &status}
	flow.Steps = []FlowStep{body, cleanup}
	_, run := saveFlowRun(t, s, flow)
	s.flow.run(context.Background(), run.ID, nil)
	final := loadFinishedFlow(t, s, run.ID)
	if final.Status != "failed" || final.ErrorCode != "cleanup_failed" || final.CleanupError == "" || hits.Load() != 2 {
		t.Fatalf("cleanup failure reported success: %#v hits=%d", final, hits.Load())
	}
}

func TestFlowFinallyRunsAfterCancellation(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	started, finished := make(chan struct{}), make(chan struct{})
	var cleaned atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/wait" {
			close(started)
			<-r.Context().Done()
			return
		}
		if r.Context().Err() != nil {
			t.Error("cleanup inherited cancellation")
		}
		cleaned.Store(true)
	}))
	defer server.Close()
	flow := mustFlow(t, s)
	body := httpStep("wait", "GET", server.URL+"/wait")
	cleanup := httpStep("cleanup", "GET", server.URL+"/cleanup")
	cleanup.Config.Phase = "finally"
	flow.Steps = []FlowStep{body, cleanup}
	_, run := saveFlowRun(t, s, flow)
	s.flow.eventSink = func(kind, runID, stepID string, payload any) {
		if kind == "flow_run.finished" {
			close(finished)
		}
	}
	if err := s.flow.StartRun(run.ID, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("body did not start")
	}
	if err := s.flow.Cancel(run.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		t.Fatal("cleanup did not finish")
	}
	final := loadFinishedFlow(t, s, run.ID)
	if !cleaned.Load() || final.Status != "cancelled" || final.Steps[1].Status != "succeeded" {
		t.Fatalf("cancel lost cleanup: %#v", final)
	}
}

func TestFlowMissingQualifiedOutputCannotUseGlobalFallback(t *testing.T) {
	for _, skip := range []bool{false, true} {
		t.Run(fmt.Sprint(skip), func(t *testing.T) {
			s := newTestService(t)
			paths := []string{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				paths = append(paths, r.URL.Path)
				fmt.Fprint(w, "{}")
			}))
			defer server.Close()
			flow := mustFlow(t, s)
			create := httpStep("create", "GET", server.URL+"/create")
			create.ID = "producer"
			create.Config.Extractors = []FlowExtractor{{Name: "id", Source: "body", Path: "id"}}
			remove := httpStep("remove", "DELETE", server.URL+"/{{steps.producer.outputs.id}}")
			remove.Config = FlowStepConfig{Phase: "finally", SkipIfMissingOutputs: skip}
			release := httpStep("release", "GET", server.URL+"/release")
			release.Config.Phase = "finally"
			flow.Steps = []FlowStep{create, remove, release}
			_, run := saveFlowRun(t, s, flow)
			s.flow.run(context.Background(), run.ID, map[string]string{"steps.producer.outputs.id": "fake", "id": "old"})
			final := loadFinishedFlow(t, s, run.ID)
			want := "failed"
			if skip {
				want = "skipped"
			}
			if final.Steps[1].Status != want || !reflect.DeepEqual(paths, []string{"/create", "/release"}) {
				t.Fatalf("missing output used a fallback: %#v %v", final, paths)
			}
			if skip && final.Status != "succeeded" || !skip && final.Status != "failed" {
				t.Fatalf("wrong cleanup outcome: %#v", final)
			}
		})
	}
}

func TestFlowSQLFieldsTypedOutputAndLegacyAliases(t *testing.T) {
	s := newTestService(t)
	calls := 0
	s.flow.database = flowSQLFunc(func(ctx context.Context, cmd database.Command) (*database.Result, error) {
		calls++
		if calls == 1 {
			return &database.Result{Columns: []string{"id", "name"}, RowCount: 1, Rows: []map[string]any{{"id": int64(42), "name": "Alice", "token": "hidden-token"}}}, nil
		}
		if cmd.Mode != "exec" || len(cmd.Params) != 1 || cmd.Params[0] != int64(42) {
			t.Errorf("typed SQL output was not bound: %#v", cmd)
		}
		return &database.Result{RowsAffected: 1}, nil
	})
	var requested atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/42/42" {
			t.Errorf("qualified/legacy variables not resolved: %s", r.URL.Path)
		}
		requested.Store(true)
		fmt.Fprint(w, `{"name":"Alice"}`)
	}))
	defer server.Close()
	flow := mustFlow(t, s)
	query := FlowStep{ID: "lookup", Type: "sql", Name: "lookup", Enabled: true, SQL: &database.Command{ConnectionID: "test", Mode: "query", SQL: "SELECT id,name FROM users"}}
	query.Config.Assertions = []FlowAssertion{
		{Source: "rows", Path: "0.name", Operator: "equals", Expected: "Alice"},
		{Source: "rows", Path: "0.id", Operator: "equals", Expected: "42"},
		{Source: "row_count", Operator: "equals", Expected: "1"},
	}
	query.Config.Extractors = []FlowExtractor{{Name: "id", Source: "rows", Path: "0.id", Required: true}, {Name: "name", Source: "rows", Path: "0.name", Required: true}}
	check := httpStep("check", "GET", server.URL+"/{{steps.lookup.outputs.id}}/{{id}}")
	check.Config.Assertions = []FlowAssertion{{Source: "body", Path: "name", Operator: "equals", Expected: "{{steps.lookup.outputs.name}}"}}
	remove := FlowStep{Type: "sql", Name: "cleanup", Enabled: true, SQL: &database.Command{ConnectionID: "test", Mode: "exec", SQL: "DELETE FROM users WHERE id=?", Params: []any{"{{steps.lookup.outputs.id}}"}}}
	remove.Config = FlowStepConfig{Phase: "finally", Assertions: []FlowAssertion{{Source: "rows_affected", Operator: "equals", Expected: "1"}}}
	flow.Steps = []FlowStep{query, check, remove}
	saved, run := saveFlowRun(t, s, flow)
	s.flow.run(context.Background(), run.ID, nil)
	final := loadFinishedFlow(t, s, run.ID)
	if final.Status != "succeeded" || calls != 2 || !requested.Load() || len(final.Steps[0].Assertions) != 3 {
		t.Fatalf("SQL/HTTP scenario failed: %#v", final)
	}
	raw, _ := json.Marshal(final)
	if strings.Contains(string(raw), "hidden-token") {
		t.Fatalf("SQL evidence exposed sensitive field: %s", raw)
	}
	if saved.Steps[2].SQL.Params[0] != "{{steps.lookup.outputs.id}}" {
		t.Fatal("definition mutated")
	}
	snapshot, _, _ := s.repo.flowRunSnapshot(run.ID)
	if snapshot.Steps[2].SQL.Params[0] != "{{steps.lookup.outputs.id}}" {
		t.Fatal("run snapshot mutated")
	}
}

func TestFlowSQLAssertionsEvaluateAllAndCaptureFailureOutput(t *testing.T) {
	s := newTestService(t)
	s.flow.database = flowSQLFunc(func(context.Context, database.Command) (*database.Result, error) {
		return &database.Result{RowCount: 1, Rows: []map[string]any{{"id": int64(8), "name": "actual"}}}, nil
	})
	var cleaned atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cleaned.Store(r.URL.Path == "/8")
	}))
	defer server.Close()
	flow := mustFlow(t, s)
	query := FlowStep{ID: "query", Type: "sql", Name: "query", Enabled: true, SQL: &database.Command{ConnectionID: "test", Mode: "query", SQL: "SELECT id,name FROM users"}}
	query.Config.Assertions = []FlowAssertion{
		{Source: "rows", Path: "0.name", Operator: "equals", Expected: "expected"},
		{Source: "rows", Path: "0.missing", Operator: "not_equals", Expected: "other"},
		{Source: "rows", Path: "0.id", Operator: "exists"},
	}
	query.Config.Extractors = []FlowExtractor{{Name: "id", Source: "rows", Path: "0.id", Required: true}}
	cleanup := httpStep("cleanup", "GET", server.URL+"/{{steps.query.outputs.id}}")
	cleanup.Config.Phase = "finally"
	flow.Steps = []FlowStep{query, cleanup}
	_, run := saveFlowRun(t, s, flow)
	s.flow.run(context.Background(), run.ID, nil)
	final := loadFinishedFlow(t, s, run.ID)
	if final.ErrorCode != "assertion_failed" || len(final.Steps[0].Assertions) != 3 || !final.Steps[0].Assertions[2].Passed || !cleaned.Load() {
		t.Fatalf("SQL failure lost evidence/cleanup output: %#v", final)
	}
}

func TestFlowFailurePoliciesPreserveLegacyBehaviorAndFirstFailure(t *testing.T) {
	tests := []struct {
		name         string
		stop, legacy bool
		policy       string
		continues    bool
	}{
		{"legacy-stop", true, false, "", false},
		{"legacy-step-continue", true, true, "", true},
		{"legacy-flow-continue", false, false, "", true},
		{"explicit-stop", false, true, "stop", false},
		{"explicit-continue", true, false, "continue", true},
	}
	for _, item := range tests {
		t.Run(item.name, func(t *testing.T) {
			s := newTestService(t)
			var second atomic.Bool
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/second" {
					second.Store(true)
				}
				w.WriteHeader(500)
			}))
			defer server.Close()
			flow := mustFlow(t, s)
			flow.Settings.StopOnError = item.stop
			first := httpStep("first", "GET", server.URL+"/first")
			expected := 200
			first.Config = FlowStepConfig{ExpectedStatus: &expected, ContinueOnError: item.legacy, FailurePolicy: item.policy}
			next := httpStep("second", "GET", server.URL+"/second")
			next.Config.Assertions = []FlowAssertion{{Source: "header", Path: "X-Required", Operator: "exists"}}
			flow.Steps = []FlowStep{first, next}
			_, run := saveFlowRun(t, s, flow)
			s.flow.run(context.Background(), run.ID, nil)
			final := loadFinishedFlow(t, s, run.ID)
			if second.Load() != item.continues || final.Status != "failed" || !strings.Contains(final.ErrorMessage, "expected HTTP status") {
				t.Fatalf("policy or first failure changed: %#v", final)
			}
		})
	}
}

func TestFlowOutputReferencesValidationDuplicationAndRename(t *testing.T) {
	s := newTestService(t)
	flow := mustFlow(t, s)
	source := httpStep("source", "GET", "http://localhost/create")
	source.ID = "source"
	source.Config.Extractors = []FlowExtractor{{Name: "id", Source: "body", Path: "id"}}
	consumer := httpStep("consumer", "GET", "http://localhost/{{steps.source.outputs.id}}")
	flow.Steps = []FlowStep{source, consumer}
	saved, _ := saveFlowRun(t, s, flow)
	saved.Steps[0].Name = "renamed"
	saved, err := s.repo.updateFlow(saved, saved.EditVersion)
	if err != nil {
		t.Fatal(err)
	}
	copy, err := s.repo.duplicateFlow(saved.ID)
	if err != nil {
		t.Fatal(err)
	}
	if copy.Steps[0].ID == "source" || !strings.Contains(copy.Steps[1].Request.URL, "steps."+copy.Steps[0].ID+".outputs.id") {
		t.Fatalf("copy references original flow: %#v", copy)
	}
	if _, err := s.repo.updateFlow(copy, copy.EditVersion); err != nil {
		t.Fatalf("copy cannot be saved: %v", err)
	}
	for _, mutation := range []string{"disable", "delete-output", "move-after", "delete-step", "bad-format"} {
		t.Run(mutation, func(t *testing.T) {
			draft, _ := s.repo.getFlow(saved.ID)
			switch mutation {
			case "disable":
				draft.Steps[0].Enabled = false
			case "delete-output":
				draft.Steps[0].Config.Extractors = nil
			case "move-after":
				draft.Steps[0].Position, draft.Steps[1].Position = 1, 0
			case "delete-step":
				draft.Steps = draft.Steps[1:]
			case "bad-format":
				draft.Steps[1].Request.URL = "http://localhost/{{steps.source.id}}"
			}
			if _, err := s.repo.updateFlow(draft, draft.EditVersion); !errors.Is(err, errValidation) {
				t.Fatalf("invalid reference accepted: %v", err)
			}
			unchanged, _ := s.repo.getFlow(saved.ID)
			if unchanged.EditVersion != saved.EditVersion {
				t.Fatal("invalid edit changed stored flow")
			}
		})
	}
}

func TestFlowSQLTruncationCannotProveExactCount(t *testing.T) {
	result := &database.Result{Truncated: true, RowCount: -1, Rows: []map[string]any{{"id": 1}}}
	checks, err := evaluateFlowAssertions([]FlowAssertion{
		{Source: "row_count", Operator: "equals", Expected: "-1"},
		{Source: "rows", Path: "0.id", Operator: "equals", Expected: "1"},
	}, nil, result)
	if !errors.Is(err, errFlowAssertion) || checks[0].Passed || !checks[1].Passed {
		t.Fatalf("invalid truncation semantics: %#v %v", checks, err)
	}
}

func TestFlowSQLFailureStillRunsCleanup(t *testing.T) {
	s := newTestService(t)
	s.flow.database = flowSQLFunc(func(context.Context, database.Command) (*database.Result, error) {
		return nil, errors.New("database temporarily unavailable")
	})
	var cleaned atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { cleaned.Store(true) }))
	defer server.Close()
	flow := mustFlow(t, s)
	query := FlowStep{Type: "sql", Name: "query", Enabled: true, SQL: &database.Command{ConnectionID: "test", Mode: "query", SQL: "SELECT id FROM users"}}
	cleanup := httpStep("cleanup", "GET", server.URL)
	cleanup.Config.Phase = "finally"
	flow.Steps = []FlowStep{query, cleanup}
	_, run := saveFlowRun(t, s, flow)
	s.flow.run(context.Background(), run.ID, nil)
	final := loadFinishedFlow(t, s, run.ID)
	if final.Status != "failed" || final.ErrorCode != "step_failed" || !cleaned.Load() {
		t.Fatalf("SQL transport failure lost cleanup: %#v", final)
	}
}

func TestFlowSQLSensitiveOutputMasksEvidenceAndRetainsTypedBinding(t *testing.T) {
	s := newTestService(t)
	calls := 0
	s.flow.database = flowSQLFunc(func(ctx context.Context, command database.Command) (*database.Result, error) {
		calls++
		if calls == 1 {
			return &database.Result{RowCount: 1, Rows: []map[string]any{{"id": int64(987654321)}}}, nil
		}
		if command.Params[0] != int64(987654321) {
			t.Errorf("masked value used for execution: %#v", command.Params)
		}
		return &database.Result{RowsAffected: 1}, nil
	})
	flow := mustFlow(t, s)
	query := FlowStep{ID: "secret-query", Type: "sql", Name: "query", Enabled: true, SQL: &database.Command{ConnectionID: "test", Mode: "query", SQL: "SELECT id FROM users"}}
	query.Config.Extractors = []FlowExtractor{{Name: "private_id", Source: "rows", Path: "0.id", Secret: true, Required: true}}
	cleanup := FlowStep{Type: "sql", Name: "remove", Enabled: true, SQL: &database.Command{ConnectionID: "test", Mode: "exec", SQL: "DELETE FROM users WHERE id=?", Params: []any{"{{steps.secret-query.outputs.private_id}}"}}}
	cleanup.Config.Phase = "finally"
	flow.Steps = []FlowStep{query, cleanup}
	_, run := saveFlowRun(t, s, flow)
	s.flow.run(context.Background(), run.ID, nil)
	final := loadFinishedFlow(t, s, run.ID)
	if final.Status != "succeeded" {
		t.Fatalf("secret output scenario failed: %#v", final)
	}
	raw, _ := json.Marshal(final)
	if strings.Contains(string(raw), "987654321") {
		t.Fatalf("secret SQL field leaked to Flow evidence: %s", raw)
	}
	var result struct {
		ExtractedVariables []FlowExtractedVariable `json:"extracted_variables"`
	}
	if err := json.Unmarshal(mustJSON(t, final.Steps[0].Result), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.ExtractedVariables) != 1 || !result.ExtractedVariables[0].Secret {
		t.Fatalf("secret metadata lost: %#v", result)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
