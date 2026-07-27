package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func getReq(t *testing.T, router http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func methodJSON(t *testing.T, router http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestFlowRoutesLifecycle(t *testing.T) {
	_, router := newTestRouter(t)

	// Create.
	rec := methodJSON(t, router, http.MethodPost, "/flows", `{"name":"Checkout smoke"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	var flow Flow
	if err := json.Unmarshal(rec.Body.Bytes(), &flow); err != nil {
		t.Fatal(err)
	}
	if flow.ID == "" || flow.EditVersion != 1 {
		t.Fatalf("unexpected created flow: %#v", flow)
	}

	// List summaries.
	rec = getReq(t, router, "/flows?project_id=default")
	if rec.Code != http.StatusOK {
		t.Fatalf("list: expected 200, got %d", rec.Code)
	}

	// PUT full aggregate with two steps.
	body := `{"edit_version":1,"name":"Checkout smoke","description":"","settings":{"stop_on_error":true,"request_timeout_ms":60000},"variables":[],"steps":[
		{"type":"http","name":"a","enabled":true,"request":{"method":"GET","url":"https://example.com/a"},"config":{"continue_on_error":false,"extractors":[]}},
		{"type":"http","name":"b","enabled":true,"request":{"method":"POST","url":"https://example.com/b"},"config":{"continue_on_error":false,"extractors":[]}}
	]}`
	rec = methodJSON(t, router, http.MethodPut, "/flows/"+flow.ID, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("put: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var saved Flow
	_ = json.Unmarshal(rec.Body.Bytes(), &saved)
	if saved.EditVersion != 2 || len(saved.Steps) != 2 {
		t.Fatalf("unexpected saved flow: %#v", saved)
	}

	// Stale PUT returns 409 with the current version.
	rec = methodJSON(t, router, http.MethodPut, "/flows/"+flow.ID, body)
	if rec.Code != http.StatusConflict {
		t.Fatalf("stale put: expected 409, got %d: %s", rec.Code, rec.Body.String())
	}
	var conflict struct {
		Current struct {
			EditVersion int64 `json:"edit_version"`
		} `json:"current"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &conflict)
	if conflict.Current.EditVersion != 2 {
		t.Fatalf("409 should report current version 2, got %d", conflict.Current.EditVersion)
	}

	// PATCH rename.
	rec = methodJSON(t, router, http.MethodPatch, "/flows/"+flow.ID, `{"name":"Renamed","edit_version":2}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("patch: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// Start a run (async execution is fine; we only assert acceptance + shape).
	rec = methodJSON(t, router, http.MethodPost, "/flows/"+flow.ID+"/runs", `{"expected_flow_version":3}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("run: expected 202, got %d: %s", rec.Code, rec.Body.String())
	}
	var run FlowRun
	_ = json.Unmarshal(rec.Body.Bytes(), &run)
	if run.TotalSteps != 2 || run.FlowVersion != 3 {
		t.Fatalf("unexpected run: %#v", run)
	}

	// Delete (soft) then it disappears from the default list.
	rec = methodJSON(t, router, http.MethodDelete, "/flows/"+flow.ID, "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: expected 204, got %d", rec.Code)
	}
	rec = getReq(t, router, "/flows?project_id=default")
	var summaries []FlowSummary
	_ = json.Unmarshal(rec.Body.Bytes(), &summaries)
	if len(summaries) != 0 {
		t.Fatalf("archived flow should be hidden, got %d", len(summaries))
	}

	// Restore brings it back.
	rec = methodJSON(t, router, http.MethodPost, "/flows/"+flow.ID+"/restore", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("restore: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	rec = getReq(t, router, "/flows?project_id=default")
	_ = json.Unmarshal(rec.Body.Bytes(), &summaries)
	if len(summaries) != 1 {
		t.Fatalf("restored flow should reappear, got %d", len(summaries))
	}
}
