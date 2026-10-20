package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/apix/apix/runtime/internal/core"
)

func TestRequestHistoryResolvesExactExecutionBatch(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer target.Close()
	ctx := context.Background()
	want := map[string]APIRun{}
	// Identical requests in different batches must retain independent ownership.
	for _, name := range []string{"REST", "MCP"} {
		batch, err := s.BeginTestBatch("", name)
		if err != nil {
			t.Fatal(err)
		}
		var runner func(context.Context, map[string]any) (any, error)
		if name == "MCP" {
			runner = func(ctx context.Context, input map[string]any) (any, error) {
				// The core MCP executor assigns a different session step ID.
				input["step_id"] = "mcp-session-step"
				return s.Execute(ctx, "send_request", input, core.NewVariables())
			}
		}
		out, err := s.RunTest(ctx, RunTestInput{BatchID: batch.ID, TestCase: &TestCase{Name: name, Request: RequestData{Method: "GET", URL: target.URL}}}, runner)
		if err != nil {
			t.Fatal(err)
		}
		want[out.RunID] = APIRun{BatchID: batch.ID, TestRunID: out.TestRunID}
	}
	flow := mustFlow(t, s)
	flow.Steps = []FlowStep{httpStep("HTTP", "GET", target.URL)}
	flow, err := s.repo.updateFlow(flow, flow.EditVersion)
	if err != nil {
		t.Fatal(err)
	}
	flowRun, err := s.repo.createFlowRun(flow, nil, "manual", nil)
	if err != nil {
		t.Fatal(err)
	}
	apiRun, err := s.execution.Run(ctx, RunCommand{SessionID: flowRun.ID, StepID: flowRun.Steps[0].ID, InlineRequest: &flow.Steps[0].Request}, nil)
	if err != nil {
		t.Fatal(err)
	}
	want[apiRun.ID] = APIRun{FlowID: flow.ID, FlowRunID: flowRun.ID, StepID: flowRun.Steps[0].ID}
	standalone, err := s.execution.Run(ctx, RunCommand{SessionID: "unrelated-ai-session", InlineRequest: &flow.Steps[0].Request}, nil)
	if err != nil {
		t.Fatal(err)
	}
	want[standalone.ID] = APIRun{}
	check := func(got APIRun) {
		t.Helper()
		expected, ok := want[got.ID]
		if !ok || got.BatchID != expected.BatchID || got.TestRunID != expected.TestRunID || got.FlowID != expected.FlowID || got.FlowRunID != expected.FlowRunID || expected.FlowRunID != "" && got.StepID != expected.StepID {
			t.Fatalf("incorrect execution ownership: got %+v, want %+v", got, expected)
		}
	}
	for id := range want {
		got, err := s.repo.getRun(id)
		if err != nil {
			t.Fatal(err)
		}
		check(*got)
	}
	summaries, err := s.repo.listRunSummaries("default", 200)
	if err != nil || len(summaries) != len(want) {
		t.Fatalf("summaries: %v %v", summaries, err)
	}
	for _, got := range summaries {
		check(got)
		if got.ResponseBody != nil {
			t.Fatal("history summaries must not load response payloads")
		}
	}
}
