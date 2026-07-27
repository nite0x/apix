package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func mustFlow(t *testing.T, s *HTTPService) *Flow {
	t.Helper()
	flow, err := s.repo.createFlow("default", "My flow")
	if err != nil {
		t.Fatalf("createFlow: %v", err)
	}
	return flow
}

func httpStep(name, method, url string) FlowStep {
	return FlowStep{
		Type:    "http",
		Name:    name,
		Enabled: true,
		Request: RequestData{Method: method, URL: url},
		Config:  FlowStepConfig{Extractors: []FlowExtractor{}},
	}
}

func TestFlowCreateListGetUpdate(t *testing.T) {
	s := newTestService(t)
	flow := mustFlow(t, s)
	if flow.Name != "My flow" || flow.EditVersion != 1 {
		t.Fatalf("unexpected new flow: %#v", flow)
	}

	flow.Name = "Checkout smoke test"
	flow.Steps = []FlowStep{httpStep("first", "GET", "https://example.com/a")}
	updated, err := s.repo.updateFlow(flow, 1)
	if err != nil {
		t.Fatalf("updateFlow: %v", err)
	}
	if updated.EditVersion != 2 {
		t.Fatalf("edit_version should increment, got %d", updated.EditVersion)
	}
	if len(updated.Steps) != 1 || updated.Steps[0].Position != 0 {
		t.Fatalf("unexpected steps: %#v", updated.Steps)
	}

	summaries, err := s.repo.listFlowSummaries("default", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(summaries) != 1 || summaries[0].StepCount != 1 || summaries[0].Name != "Checkout smoke test" {
		t.Fatalf("unexpected summaries: %#v", summaries)
	}
}

func TestFlowAggregateStepMutations(t *testing.T) {
	s := newTestService(t)
	flow := mustFlow(t, s)
	flow.Steps = []FlowStep{
		httpStep("a", "GET", "https://example.com/a"),
		httpStep("b", "POST", "https://example.com/b"),
	}
	updated, err := s.repo.updateFlow(flow, 1)
	if err != nil {
		t.Fatal(err)
	}
	// Reorder (swap), edit one, add one, delete none.
	updated.Steps[0].Position, updated.Steps[1].Position = 1, 0
	updated.Steps[0].Name = "a-renamed"
	updated.Steps = append(updated.Steps, httpStep("c", "DELETE", "https://example.com/c"))
	updated.Steps[2].Position = 2
	result, err := s.repo.updateFlow(updated, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Steps) != 3 {
		t.Fatalf("expected 3 steps, got %d", len(result.Steps))
	}
	// After normalization positions are 0..2 and b comes first.
	if result.Steps[0].Name != "b" || result.Steps[1].Name != "a-renamed" || result.Steps[2].Name != "c" {
		t.Fatalf("unexpected order: %v %v %v", result.Steps[0].Name, result.Steps[1].Name, result.Steps[2].Name)
	}
	for i, st := range result.Steps {
		if st.Position != i {
			t.Fatalf("position not normalized: %#v", result.Steps)
		}
	}

	// Delete down to one.
	result.Steps = result.Steps[:1]
	final, err := s.repo.updateFlow(result, 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(final.Steps) != 1 {
		t.Fatalf("expected 1 step after delete, got %d", len(final.Steps))
	}
}

func TestFlowEditVersionConflict(t *testing.T) {
	s := newTestService(t)
	flow := mustFlow(t, s)
	if _, err := s.repo.updateFlow(flow, 1); err != nil {
		t.Fatal(err)
	}
	// Stale version.
	_, err := s.repo.updateFlow(flow, 1)
	if !errors.Is(err, errConflict) {
		t.Fatalf("expected conflict, got %v", err)
	}
}

func TestFlowArchiveRestore(t *testing.T) {
	s := newTestService(t)
	flow := mustFlow(t, s)
	if err := s.repo.archiveFlow(flow.ID); err != nil {
		t.Fatal(err)
	}
	// Idempotent.
	if err := s.repo.archiveFlow(flow.ID); err != nil {
		t.Fatal(err)
	}
	summaries, _ := s.repo.listFlowSummaries("default", false)
	if len(summaries) != 0 {
		t.Fatalf("archived flow should be hidden, got %d", len(summaries))
	}
	all, _ := s.repo.listFlowSummaries("default", true)
	if len(all) != 1 {
		t.Fatalf("include_archived should show it, got %d", len(all))
	}
	if _, err := s.repo.restoreFlow(flow.ID); err != nil {
		t.Fatal(err)
	}
	summaries, _ = s.repo.listFlowSummaries("default", false)
	if len(summaries) != 1 {
		t.Fatalf("restored flow should reappear")
	}
}

func TestFlowDuplicateRegeneratesStepIDs(t *testing.T) {
	s := newTestService(t)
	flow := mustFlow(t, s)
	flow.Steps = []FlowStep{httpStep("a", "GET", "https://example.com/a")}
	updated, err := s.repo.updateFlow(flow, 1)
	if err != nil {
		t.Fatal(err)
	}
	copy, err := s.repo.duplicateFlow(updated.ID)
	if err != nil {
		t.Fatal(err)
	}
	if copy.ID == updated.ID {
		t.Fatal("duplicate must have a new flow id")
	}
	if copy.Name != "My flow copy" {
		t.Fatalf("unexpected duplicate name: %q", copy.Name)
	}
	if len(copy.Steps) != 1 || copy.Steps[0].ID == updated.Steps[0].ID {
		t.Fatalf("duplicate step id must be regenerated: %#v", copy.Steps)
	}
}

func TestFlowStepSnapshotSurvivesSourceDeletion(t *testing.T) {
	s := newTestService(t)
	collection := &APICollection{Name: "Users"}
	if err := s.repo.createCollection(collection); err != nil {
		t.Fatal(err)
	}
	req := &APIRequest{CollectionID: collection.ID, Name: "get", Request: RequestData{Method: "GET", URL: "https://example.com/u"}}
	if err := s.repo.createRequest(req); err != nil {
		t.Fatal(err)
	}
	flow := mustFlow(t, s)
	step := httpStep("from-api", "GET", "https://example.com/u")
	step.SourceAPIRequestID = &req.ID
	flow.Steps = []FlowStep{step}
	if _, err := s.repo.updateFlow(flow, 1); err != nil {
		t.Fatal(err)
	}
	if err := s.repo.archiveRequest(req.ID); err != nil {
		t.Fatal(err)
	}
	reloaded, err := s.repo.getFlow(flow.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(reloaded.Steps) != 1 || reloaded.Steps[0].Request.URL != "https://example.com/u" {
		t.Fatalf("step snapshot lost after source archive: %#v", reloaded.Steps)
	}
}

func TestSecretVariableRejectsDefault(t *testing.T) {
	s := newTestService(t)
	flow := mustFlow(t, s)
	flow.Variables = []FlowVariableDefinition{{Name: "api_key", Secret: true, DefaultValue: "leak"}}
	_, err := s.repo.updateFlow(flow, 1)
	if !errors.Is(err, errValidation) {
		t.Fatalf("expected validation error, got %v", err)
	}
}

func TestIncompleteStepCanBeSavedButNotRun(t *testing.T) {
	s := newTestService(t)
	flow := mustFlow(t, s)
	flow.Steps = []FlowStep{httpStep("New request", "GET", "")}

	saved, err := s.repo.updateFlow(flow, 1)
	if err != nil {
		t.Fatalf("incomplete authoring draft should be saveable: %v", err)
	}
	if len(saved.Steps) != 1 || saved.Steps[0].Request.URL != "" {
		t.Fatalf("unexpected saved draft: %#v", saved.Steps)
	}

	_, err = s.repo.createFlowRun(saved, nil, "manual", nil)
	if !errors.Is(err, errNoRunnableStep) {
		t.Fatalf("incomplete step should be rejected at run time, got %v", err)
	}
}

func TestFlowStepDefaultNameUsesRequestPath(t *testing.T) {
	cases := map[string]string{
		"https://api.example.com/users/42?expand=team": "/users/42",
		"{{base_url}}/users/{{user_id}}":               "/users/{{user_id}}",
		"":                                             "New request",
	}
	for input, want := range cases {
		if got := flowStepName(input); got != want {
			t.Fatalf("flowStepName(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestMigrateV2toV3PreservesData(t *testing.T) {
	s := newTestService(t)
	// Seed some v2 data.
	collection := &APICollection{Name: "Keep me"}
	if err := s.repo.createCollection(collection); err != nil {
		t.Fatal(err)
	}
	// Simulate a v2 database: remove flow tables and roll the recorded version back.
	for _, stmt := range []string{
		`DROP TABLE flow_run_steps`, `DROP TABLE flow_runs`, `DROP TABLE flow_steps`, `DROP TABLE flows`,
		`UPDATE schema_metadata SET version=2 WHERE name='http_domain'`,
	} {
		if _, err := s.db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	// Re-run migration: should take the non-destructive v2→v3 path.
	if err := s.MigrateSchema(s.db); err != nil {
		t.Fatal(err)
	}
	cols, err := s.repo.listCollections("default")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range cols {
		if c.Name == "Keep me" {
			found = true
		}
	}
	if !found {
		t.Fatal("v2 collection data was lost during v2→v3 migration")
	}
	// Flow tables usable again.
	if _, err := s.repo.createFlow("default", "post-migration"); err != nil {
		t.Fatalf("flow table not available after migration: %v", err)
	}
}

func TestFlowRunSequentialExecutionAndExtraction(t *testing.T) {
	s := newTestService(t)
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/login" {
			_, _ = w.Write([]byte(`{"data":{"id":"u-42"}}`))
			return
		}
		// Second step must have substituted the extracted id.
		if r.URL.Path != "/users/u-42" {
			t.Errorf("expected substituted path, got %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	flow := mustFlow(t, s)
	login := httpStep("login", "POST", server.URL+"/login")
	login.Config.Extractors = []FlowExtractor{{Name: "user_id", Source: "body", Path: "data.id", Scope: "run"}}
	fetch := httpStep("fetch", "GET", server.URL+"/users/{{user_id}}")
	flow.Steps = []FlowStep{login, fetch}
	updated, err := s.repo.updateFlow(flow, 1)
	if err != nil {
		t.Fatal(err)
	}

	run, err := s.repo.createFlowRun(updated, nil, "manual", nil)
	if err != nil {
		t.Fatal(err)
	}
	if run.FlowVersion != updated.EditVersion {
		t.Fatalf("run should snapshot flow version %d, got %d", updated.EditVersion, run.FlowVersion)
	}
	// Run synchronously for a deterministic assertion.
	s.flow.run(context.Background(), run.ID, nil)

	final, err := s.repo.getFlowRun(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.Status != "succeeded" {
		t.Fatalf("expected succeeded, got %s (%s)", final.Status, final.ErrorMessage)
	}
	if len(final.Steps) != 2 {
		t.Fatalf("expected 2 run steps, got %d", len(final.Steps))
	}
	for _, st := range final.Steps {
		if st.Status != "succeeded" {
			t.Fatalf("step %s not succeeded: %s", st.NameSnapshot, st.Status)
		}
		if st.APIRunID == nil {
			t.Fatalf("step %s missing api_run_id", st.NameSnapshot)
		}
	}
	if atomic.LoadInt32(&hits) != 2 {
		t.Fatalf("expected 2 upstream hits, got %d", hits)
	}
}

func TestFlowRunStopsOnErrorSnapshotStable(t *testing.T) {
	s := newTestService(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	flow := mustFlow(t, s)
	// First step points at an unroutable host to force a transport failure.
	bad := httpStep("bad", "GET", "http://127.0.0.1:1/nope")
	second := httpStep("second", "GET", server.URL+"/ok")
	flow.Steps = []FlowStep{bad, second}
	updated, err := s.repo.updateFlow(flow, 1)
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.repo.createFlowRun(updated, nil, "manual", nil)
	if err != nil {
		t.Fatal(err)
	}

	// Editing the flow after the run is created must not change the run snapshot.
	updated.Name = "changed after run"
	if _, err := s.repo.updateFlow(updated, updated.EditVersion); err != nil {
		t.Fatal(err)
	}

	s.flow.run(context.Background(), run.ID, nil)
	final, err := s.repo.getFlowRun(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.Status != "failed" {
		t.Fatalf("expected failed run, got %s", final.Status)
	}
	if final.FlowNameSnapshot != "My flow" {
		t.Fatalf("run name snapshot changed: %q", final.FlowNameSnapshot)
	}
	if final.Steps[0].Status != "failed" {
		t.Fatalf("first step should fail, got %s", final.Steps[0].Status)
	}
	if final.Steps[1].Status != "cancelled" {
		t.Fatalf("second step should be cancelled after stop_on_error, got %s", final.Steps[1].Status)
	}
}

func TestFlowCancelIdempotent(t *testing.T) {
	s := newTestService(t)
	flow := mustFlow(t, s)
	flow.Steps = []FlowStep{httpStep("a", "GET", "https://example.com/a")}
	updated, err := s.repo.updateFlow(flow, 1)
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.repo.createFlowRun(updated, nil, "manual", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.flow.Cancel(run.ID); err != nil {
		t.Fatal(err)
	}
	// Cancelling again is a no-op.
	if err := s.flow.Cancel(run.ID); err != nil {
		t.Fatal(err)
	}
	final, _ := s.repo.getFlowRun(run.ID)
	if final.Status != "cancelled" {
		t.Fatalf("expected cancelled, got %s", final.Status)
	}
}

func TestCreateFlowRunRejectsNoEnabledStep(t *testing.T) {
	s := newTestService(t)
	flow := mustFlow(t, s)
	disabled := httpStep("off", "GET", "https://example.com")
	disabled.Enabled = false
	flow.Steps = []FlowStep{disabled}
	updated, err := s.repo.updateFlow(flow, 1)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.repo.createFlowRun(updated, nil, "manual", nil)
	if !errors.Is(err, errNoRunnableStep) {
		t.Fatalf("expected errNoRunnableStep, got %v", err)
	}
}
