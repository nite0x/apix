package httpapi

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/apix/apix/runtime/internal/core"
	"github.com/apix/apix/runtime/internal/database"
	"github.com/apix/apix/runtime/internal/localservice"
)

func TestFlowMVPServiceHelper(t *testing.T) {
	for i, arg := range os.Args {
		if arg == "flow-mvp-helper" && i+1 < len(os.Args) {
			fmt.Println("flow service helper ready")
			if err := http.ListenAndServe(os.Args[i+1], http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(2)
			}
			os.Exit(0)
		}
	}
}

func flowMVPServiceDefinition(t *testing.T, services *localservice.Service) *localservice.Definition {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	definition, err := services.PutDefinition(context.Background(), localservice.Definition{
		Name: "flow cleanup helper", WorkDir: t.TempDir(), Command: executable,
		Args:      []string{"-test.run=^TestFlowMVPServiceHelper$", "flow-mvp-helper", address},
		HealthURL: "http://" + address, StartupTimeoutMS: 5000,
	})
	if err != nil {
		t.Fatal(err)
	}
	return definition
}

func TestFlowMVPRealServiceCleanupOnFailureAndCancellation(t *testing.T) {
	for _, scenario := range []string{"failure", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			s := newTestService(t)
			s.db.SetMaxOpenConns(1) // :memory: belongs to one connection; process log writes run concurrently.
			services, err := localservice.New(s.db)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := services.Close(); err != nil {
					t.Error(err)
				}
			})
			s.flow.services = services
			definition := flowMVPServiceDefinition(t, services)
			requestStarted := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(requestStarted)
				if scenario == "cancel" {
					<-r.Context().Done()
					return
				}
				w.WriteHeader(500)
			}))
			defer server.Close()
			flow := mustFlow(t, s)
			expected := 200
			request := httpStep("exercise failure", "GET", server.URL)
			request.Position = 1
			request.Config.ExpectedStatus = &expected
			flow.Steps = []FlowStep{
				{Type: "service", Name: "start helper", Enabled: true, Service: &ServiceStepConfig{ServiceID: definition.ID, Action: "start"}}, request,
			}
			saved, err := s.repo.updateFlow(flow, 1)
			if err != nil {
				t.Fatal(err)
			}
			run, err := s.repo.createFlowRun(saved, nil, "test", nil)
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan struct{})
			s.flow.eventSink = func(kind, runID, stepID string, payload any) {
				if kind == "flow_run.finished" {
					close(done)
				}
			}
			s.flow.StartRun(run.ID, nil)
			select {
			case <-requestStarted:
			case <-time.After(8 * time.Second):
				t.Fatal("service did not become healthy and reach HTTP step")
			}
			if scenario == "cancel" {
				if err := s.flow.Cancel(run.ID); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case <-done:
			case <-time.After(8 * time.Second):
				t.Fatal("flow cleanup did not finish")
			}
			final, err := s.repo.getFlowRun(run.ID)
			if err != nil {
				t.Fatal(err)
			}
			wantStatus := "failed"
			if scenario == "cancel" {
				wantStatus = "cancelled"
			}
			if final.Status != wantStatus || final.CleanupError != "" || final.Steps[0].Status != "succeeded" {
				t.Fatalf("unexpected flow result: %#v", final)
			}
			status, err := services.Status(context.Background(), definition.ID)
			if err != nil || status.Status != "stopped" {
				t.Fatalf("service remained alive after terminal event: %#v %v", status, err)
			}
			connection, err := net.DialTimeout("tcp", strings.TrimPrefix(definition.HealthURL, "http://"), time.Second)
			if err == nil {
				connection.Close()
				t.Fatal("helper still accepts connections after cleanup")
			}
		})
	}
}

func TestFlowReusesManualServiceWithoutStoppingIt(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	services, err := localservice.New(s.db)
	if err != nil {
		t.Fatal(err)
	}
	defer services.Close()
	s.flow.services = services
	d := flowMVPServiceDefinition(t, services)
	started, err := services.Start(context.Background(), d.ID, "manual")
	if err != nil {
		t.Fatal(err)
	}
	flow := mustFlow(t, s)
	request := httpStep("use existing service", "GET", d.HealthURL)
	request.Position = 1
	flow.Steps = []FlowStep{
		{Type: "service", Name: "reuse", Enabled: true, Service: &ServiceStepConfig{ServiceID: d.ID, Action: "start"}},
		request,
		{Position: 2, Type: "service", Name: "release", Enabled: true, Service: &ServiceStepConfig{ServiceID: d.ID, Action: "stop"}},
	}
	saved, err := s.repo.updateFlow(flow, 1)
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.repo.createFlowRun(saved, nil, "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	s.flow.eventSink = func(kind, runID, stepID string, payload any) {
		if kind == "flow_run.finished" {
			close(done)
		}
	}
	s.flow.StartRun(run.ID, nil)
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("flow did not finish")
	}
	final, err := s.repo.getFlowRun(run.ID)
	if err != nil || final.Status != "succeeded" || final.CleanupError != "" {
		t.Fatalf("flow could not reuse service: %+v %v", final, err)
	}
	status, err := services.Status(context.Background(), d.ID)
	if err != nil || status.PID != started.PID || status.Owner != "manual" || status.Status != "running" {
		t.Fatalf("flow stopped or claimed manual service: %+v %v", status, err)
	}
}

func TestFlowMVPResultPersistenceFailureFailsRun(t *testing.T) {
	s := newTestService(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer server.Close()
	flow := mustFlow(t, s)
	flow.Steps = []FlowStep{httpStep("persist", "GET", server.URL)}
	saved, err := s.repo.updateFlow(flow, 1)
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.repo.createFlowRun(saved, nil, "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`CREATE TRIGGER deny_step_result BEFORE UPDATE OF result ON flow_run_steps BEGIN SELECT RAISE(FAIL,'simulated result write failure'); END`); err != nil {
		t.Fatal(err)
	}
	s.flow.run(context.Background(), run.ID, nil)
	final, err := s.repo.getFlowRun(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.Status != "failed" || final.Steps[0].Status != "failed" || !strings.Contains(final.ErrorMessage, "simulated result write failure") {
		t.Fatalf("persistence failure reported success: %#v", final)
	}
}

func TestFlowMVPStatePersistenceFailurePreventsUntrackedRequest(t *testing.T) {
	s := newTestService(t)
	hits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++; w.WriteHeader(200) }))
	defer server.Close()
	flow := mustFlow(t, s)
	flow.Steps = []FlowStep{httpStep("must be tracked", "POST", server.URL)}
	saved, err := s.repo.updateFlow(flow, 1)
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.repo.createFlowRun(saved, nil, "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`CREATE TRIGGER deny_step_running BEFORE UPDATE OF status ON flow_run_steps WHEN NEW.status='running' BEGIN SELECT RAISE(FAIL,'simulated running write failure'); END`); err != nil {
		t.Fatal(err)
	}
	s.flow.run(context.Background(), run.ID, nil)
	final, err := s.repo.getFlowRun(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if hits != 0 || final.Status != "failed" || final.ErrorCode != "persistence_failed" {
		t.Fatalf("untracked request executed: hits=%d run=%#v", hits, final)
	}
}

func TestFlowMVPStartRunRejectedAfterShutdown(t *testing.T) {
	s := newTestService(t)
	if err := s.flow.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := s.flow.StartRun("rejected", nil); err == nil || !strings.Contains(err.Error(), "shutting down") {
		t.Fatalf("shutdown rejection was silent: %v", err)
	}
	s.flow.mu.Lock()
	defer s.flow.mu.Unlock()
	if len(s.flow.cancels) != 0 {
		t.Fatal("rejected run retained cancellation state")
	}
}

func TestFlowMVPRejectsSecretDefaultsAndCrossTypePayloads(t *testing.T) {
	s := newTestService(t)
	flow := mustFlow(t, s)
	flow.Variables = []FlowVariableDefinition{{Name: "password", Secret: true, DefaultValue: "must-never-persist"}}
	if _, err := s.repo.updateFlow(flow, 1); err == nil {
		t.Fatal("secret default accepted")
	}
	var secretRows int
	if err := s.db.QueryRow(`SELECT count(*) FROM flows WHERE variables LIKE '%must-never-persist%'`).Scan(&secretRows); err != nil {
		t.Fatal(err)
	}
	if secretRows != 0 {
		t.Fatal("secret default was persisted")
	}
	flow.Variables = nil
	step := httpStep("wrong payload", "GET", "http://localhost")
	step.SQL = &database.Command{ConnectionID: "db", Mode: "exec", SQL: "DELETE FROM users"}
	flow.Steps = []FlowStep{step}
	if _, err := s.repo.updateFlow(flow, 1); err == nil {
		t.Fatal("HTTP step carrying SQL accepted")
	}
	flow.Steps = []FlowStep{{Type: "service", Enabled: true, Service: &ServiceStepConfig{ServiceID: "app", Action: "start"}, Request: RequestData{URL: "http://localhost"}}}
	if _, err := s.repo.updateFlow(flow, 1); err == nil {
		t.Fatal("service step carrying HTTP accepted")
	}
}

func TestFlowMVPAssertionsAndContinue(t *testing.T) {
	s := newTestService(t)
	hits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++; w.WriteHeader(201) }))
	defer server.Close()
	flow := mustFlow(t, s)
	expected := 200
	first := httpStep("wrong status", "GET", server.URL)
	first.Config.ExpectedStatus = &expected
	first.Config.ContinueOnError = true
	second := httpStep("next", "GET", server.URL)
	second.Position = 1
	flow.Steps = []FlowStep{first, second}
	saved, err := s.repo.updateFlow(flow, 1)
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.repo.createFlowRun(saved, nil, "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	s.flow.run(context.Background(), run.ID, nil)
	final, err := s.repo.getFlowRun(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.Status != "failed" || hits != 2 || final.Steps[1].Status != "succeeded" {
		t.Fatalf("continued failure lost: %#v, hits=%d", final, hits)
	}
	assertions := final.Steps[0].Assertions
	if len(assertions) != 1 || assertions[0].Passed || assertions[0].Actual != float64(201) {
		t.Fatalf("wrong evidence: %#v", assertions)
	}
}

func TestFlowMVPStepTimeout(t *testing.T) {
	s := newTestService(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	flow := mustFlow(t, s)
	step := httpStep("timeout", "GET", server.URL)
	step.Config.TimeoutMS = 1000
	flow.Steps = []FlowStep{step}
	saved, err := s.repo.updateFlow(flow, 1)
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.repo.createFlowRun(saved, nil, "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	s.flow.run(context.Background(), run.ID, nil)
	final, err := s.repo.getFlowRun(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.Status != "failed" || time.Since(start) > 5*time.Second {
		t.Fatalf("timeout not applied: %#v", final)
	}
}

func TestFlowMVPAsyncCancelFinishesAfterCleanup(t *testing.T) {
	s := newTestService(t)
	services, err := localservice.New(s.db)
	if err != nil {
		t.Fatal(err)
	}
	defer services.Close()
	s.flow.services = services
	started := make(chan struct{})
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done() }))
	defer server.Close()
	var mu sync.Mutex
	events := []string{}
	s.flow.eventSink = func(kind, runID, stepID string, payload any) {
		mu.Lock()
		events = append(events, kind)
		mu.Unlock()
		if kind == "flow_run.finished" {
			close(done)
		}
	}
	flow := mustFlow(t, s)
	flow.Steps = []FlowStep{httpStep("cancel", "GET", server.URL)}
	saved, err := s.repo.updateFlow(flow, 1)
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.repo.createFlowRun(saved, nil, "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	s.flow.StartRun(run.ID, nil)
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("request did not start")
	}
	if err := s.flow.Cancel(run.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("cancellation did not finish")
	}
	final, err := s.repo.getFlowRun(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.Status != "cancelled" || final.FinishedAt == nil {
		t.Fatalf("wrong cancellation result: %#v", final)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(events) < 2 || events[len(events)-2] != "flow_run.cleanup_finished" || events[len(events)-1] != "flow_run.finished" {
		t.Fatalf("terminal event before cleanup: %v", events)
	}
}

func TestFlowMVPTypedSnapshotsAndSQLParameters(t *testing.T) {
	s := newTestService(t)
	flow := mustFlow(t, s)
	expected := 1
	flow.Steps = []FlowStep{
		{Type: "sql", Name: "query", Enabled: true, SQL: &database.Command{ConnectionID: "mysql", Mode: "query", SQL: "SELECT id FROM users WHERE id=?", Params: []any{"{{id}}"}}, Config: FlowStepConfig{ExpectedRows: &expected}},
		{Position: 1, Type: "service", Name: "start", Enabled: true, Service: &ServiceStepConfig{ServiceID: "app", Action: "start"}},
	}
	saved, err := s.repo.updateFlow(flow, 1)
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.repo.createFlowRun(saved, nil, "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := s.repo.getFlowRun(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Steps[0].SQLSnapshot == nil || loaded.Steps[1].ServiceSnapshot.ServiceID != "app" {
		t.Fatalf("typed snapshots lost: %#v", loaded.Steps)
	}
	vars := core.NewVariables()
	vars.Global["id"] = &core.Variable{Name: "id", Value: "x' OR 1=1"}
	resolved, err := resolveSQLParameters(*loaded.Steps[0].SQLSnapshot, vars)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.SQL != flow.Steps[0].SQL.SQL || resolved.Params[0] != "x' OR 1=1" || loaded.Steps[0].SQLSnapshot.Params[0] != "{{id}}" {
		t.Fatalf("SQL must retain bound values and original snapshot: %#v", resolved)
	}
	delete(vars.Global, "id")
	if _, err := resolveSQLParameters(*flow.Steps[0].SQL, vars); err == nil {
		t.Fatal("missing SQL variable silently accepted")
	}
}

func TestFlowMVPV3MigrationPreservesDefinitionsAndRuns(t *testing.T) {
	s := newTestService(t)
	flow := mustFlow(t, s)
	flow.Steps = []FlowStep{httpStep("existing", "GET", "http://localhost/existing")}
	saved, err := s.repo.updateFlow(flow, 1)
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.repo.createFlowRun(saved, nil, "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	// Reconstruct the old schema with real records, not an empty upgrade fixture.
	statements := []string{
		`CREATE TABLE flow_steps_v3 (
		 id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
		 position INTEGER NOT NULL, type TEXT NOT NULL CHECK(type IN ('http')),
		 name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
		 source_api_request_id TEXT REFERENCES api_requests(id) ON DELETE SET NULL,
		 request_data TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
		 created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, UNIQUE(flow_id,position))`,
		`INSERT INTO flow_steps_v3 SELECT id,flow_id,position,type,name,enabled,source_api_request_id,request_data,config,created_at,updated_at FROM flow_steps`,
		`DROP TABLE flow_steps`,
		`ALTER TABLE flow_steps_v3 RENAME TO flow_steps`,
		`CREATE INDEX idx_flow_steps_order ON flow_steps(flow_id,position)`,
		`ALTER TABLE flow_runs DROP COLUMN cleanup_error`,
		`ALTER TABLE flow_run_steps DROP COLUMN type`,
		`ALTER TABLE flow_run_steps DROP COLUMN sql_snapshot`,
		`ALTER TABLE flow_run_steps DROP COLUMN service_snapshot`,
		`ALTER TABLE flow_run_steps DROP COLUMN result`,
		`ALTER TABLE flow_run_steps DROP COLUMN assertions`,
		`UPDATE schema_metadata SET version=3 WHERE name='http_domain'`,
	}
	for _, stmt := range statements {
		if _, err := s.db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	var originalSnapshot string
	if err := s.db.QueryRow(`SELECT flow_snapshot FROM flow_runs WHERE id=?`, run.ID).Scan(&originalSnapshot); err != nil {
		t.Fatal(err)
	}
	if err := s.MigrateSchema(s.db); err != nil {
		t.Fatal(err)
	}
	loaded, err := s.repo.getFlow(saved.ID)
	if err != nil {
		t.Fatal(err)
	}
	history, err := s.repo.getFlowRun(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.EditVersion != saved.EditVersion || loaded.Steps[0].ID != saved.Steps[0].ID || history.Steps[0].Type != "http" || history.Steps[0].RequestSnapshot.URL != "http://localhost/existing" {
		t.Fatalf("migration changed records: %#v %#v", loaded, history)
	}
	var migratedSnapshot string
	_ = s.db.QueryRow(`SELECT flow_snapshot FROM flow_runs WHERE id=?`, run.ID).Scan(&migratedSnapshot)
	if originalSnapshot != migratedSnapshot {
		t.Fatal("old immutable snapshot rewritten")
	}
	loaded.Steps = append(loaded.Steps, FlowStep{Position: 1, Type: "service", Enabled: true, Service: &ServiceStepConfig{ServiceID: "app", Action: "start"}})
	if _, err := s.repo.updateFlow(loaded, loaded.EditVersion); err != nil {
		t.Fatalf("widened constraint failed: %v", err)
	}
}

func TestFlowMVPRejectsUnknownSchemaWithoutDeletingData(t *testing.T) {
	s := newTestService(t)
	flow := mustFlow(t, s)
	_, _ = s.db.Exec(`UPDATE schema_metadata SET version=99 WHERE name='http_domain'`)
	if err := s.MigrateSchema(s.db); err == nil || !strings.Contains(err.Error(), "refusing") {
		t.Fatalf("unexpected migration response: %v", err)
	}
	var name string
	if err := s.db.QueryRow(`SELECT name FROM flows WHERE id=?`, flow.ID).Scan(&name); err != nil {
		t.Fatal("unknown migration removed data", err)
	}
}
