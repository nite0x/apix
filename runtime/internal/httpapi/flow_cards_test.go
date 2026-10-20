package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFlowCardsExtractAssertAndInspect(t *testing.T) {
	s := newTestService(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Trace", "trace-42")
		if r.URL.Path == "/login" {
			fmt.Fprint(w, `{"data":{"token":"secret-token","items":[{"id":42}]},"success":true}`)
			return
		}
		if r.URL.Path != "/orders/42" || r.Header.Get("Authorization") != "Bearer secret-token" {
			t.Errorf("variables did not reach next request: %s %s", r.URL.Path, r.Header.Get("Authorization"))
		}
		fmt.Fprint(w, `{"status":"created"}`)
	}))
	defer server.Close()
	flow := mustFlow(t, s)
	flow.Variables = []FlowVariableDefinition{{Name: "order_id", DefaultValue: "0"}}
	login := httpStep("登录", "POST", server.URL+"/login")
	expectedStatus := 200
	login.Config.ExpectedStatus = &expectedStatus
	login.Config.Assertions = []FlowAssertion{
		{Source: "body", Path: "success", Operator: "equals", Expected: "true"},
		{Source: "header", Path: "content-type", Operator: "contains", Expected: "json"},
		{Source: "body", Path: "data.items.0.id", Operator: "exists"},
	}
	login.Config.Extractors = []FlowExtractor{
		{Name: "token", Source: "body", Path: "data.token", Scope: "run", Required: true, Secret: true},
		{Name: "order_id", Source: "body", Path: "data.items.0.id", Scope: "run", Required: true},
		{Name: "trace", Source: "header", Path: "x-trace", Scope: "run"},
		{Name: "optional", Source: "body", Path: "missing", Scope: "run"},
	}
	order := httpStep("订单", "GET", server.URL+"/orders/{{order_id}}")
	order.Position = 1
	order.Request.Headers = []KeyValue{{Name: "Authorization", Value: "Bearer {{token}}", Enabled: true}}
	flow.Steps = []FlowStep{login, order}
	saved, err := s.repo.updateFlow(flow, flow.EditVersion)
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.repo.createFlowRun(saved, nil, "test", map[string]any{"order_id": "1"})
	if err != nil {
		t.Fatal(err)
	}
	s.flow.run(context.Background(), run.ID, map[string]string{"order_id": "1"})
	final, err := s.repo.getFlowRun(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.Status != "succeeded" || len(final.Steps[0].Assertions) != 4 {
		t.Fatalf("unexpected run: %#v", final)
	}
	for _, assertion := range final.Steps[0].Assertions {
		if !assertion.Passed {
			t.Fatalf("failed assertion: %#v", assertion)
		}
	}
	if final.Variables["order_id"] != "1" {
		t.Fatalf("input snapshot lost: %#v", final.Variables)
	}
	encoded, _ := json.Marshal(final.Steps[0].Result)
	if strings.Contains(string(encoded), "secret-token") || !strings.Contains(string(encoded), "trace-42") {
		t.Fatalf("extraction inspection is incomplete or leaks a secret: %s", encoded)
	}
	var result FlowHTTPResult
	if err := json.Unmarshal(encoded, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.ExtractedVariables) != 3 || !result.ExtractedVariables[0].Secret {
		t.Fatalf("unexpected extracted variables: %#v", result)
	}
}

func TestFlowCardsAssertionFailureAndContinue(t *testing.T) {
	for _, continueOnError := range []bool{false, true} {
		t.Run(fmt.Sprint(continueOnError), func(t *testing.T) {
			s := newTestService(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"value":"actual"}`) }))
			defer server.Close()
			flow := mustFlow(t, s)
			step := httpStep("assert", "GET", server.URL)
			step.Config.ContinueOnError = continueOnError
			step.Config.Assertions = []FlowAssertion{
				{Source: "body", Path: "value", Operator: "equals", Expected: "expected"},
				{Source: "body", Path: "absent", Operator: "not_equals", Expected: "other"},
				{Source: "status", Operator: "equals", Expected: "200"},
			}
			second := httpStep("next", "GET", server.URL)
			second.Position = 1
			flow.Steps = []FlowStep{step, second}
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
			if final.Status != "failed" || final.Steps[0].ErrorCode != "assertion_failed" {
				t.Fatalf("assertions did not fail run: %#v", final)
			}
			if len(final.Steps[0].Assertions) != 3 || !final.Steps[0].Assertions[2].Passed {
				t.Fatalf("did not evaluate all assertions: %#v", final.Steps[0].Assertions)
			}
			want := "cancelled"
			if continueOnError {
				want = "succeeded"
			}
			if final.Steps[1].Status != want {
				t.Fatalf("second step status %s, want %s", final.Steps[1].Status, want)
			}
		})
	}
}

func TestFlowCardsRequiredExtractionFailure(t *testing.T) {
	s := newTestService(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{}`) }))
	defer server.Close()
	flow := mustFlow(t, s)
	step := httpStep("extract", "GET", server.URL)
	step.Config.Extractors = []FlowExtractor{{Name: "missing", Source: "body", Path: "missing", Scope: "run", Required: true}}
	flow.Steps = []FlowStep{step}
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
	if final.Status != "failed" || final.Steps[0].ErrorCode != "extractor_failed" {
		t.Fatalf("unexpected run: %#v", final)
	}
}
