package httpapi

import (
	"context"
	"testing"
)

func TestInterruptedRunRecoveryAndClosedRuntimeRejection(t *testing.T) {
	s := newTestService(t)
	flow := mustFlow(t, s)
	flow.Steps = []FlowStep{httpStep("request", "GET", "http://127.0.0.1:1")}
	saved, err := s.repo.updateFlow(flow, flow.EditVersion)
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.repo.createFlowRun(saved, nil, "ai", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RecoverInterruptedRuns(); err != nil {
		t.Fatal(err)
	}
	recovered, err := s.GetFlowRun(run.ID)
	if err != nil || recovered.Status != "failed" || recovered.ErrorCode != "runtime_restarted" || recovered.Steps[0].Status != "cancelled" {
		t.Fatalf("recovery=%#v err=%v", recovered, err)
	}
	if _, err := s.GetFlow(flow.ID); err != nil {
		t.Fatal("recovery removed definition", err)
	}
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.StartFlow(flow.ID, saved.EditVersion, nil, "ai"); err == nil {
		t.Fatal("closed runtime accepted run")
	}
	var queued int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM flow_runs WHERE status='queued'`).Scan(&queued); err != nil || queued != 0 {
		t.Fatalf("orphaned queued runs=%d err=%v", queued, err)
	}
}

func TestStartFlowRejectsMissingRequiredVariables(t *testing.T) {
	s := newTestService(t)
	flow := mustFlow(t, s)
	flow.Variables = []FlowVariableDefinition{{Name: "user_id", Required: true}}
	flow.Steps = []FlowStep{httpStep("request", "GET", "http://127.0.0.1:1")}
	saved, err := s.repo.updateFlow(flow, flow.EditVersion)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.StartFlow(flow.ID, saved.EditVersion, nil, "ai"); err == nil {
		t.Fatal("missing required value accepted")
	}
	runs, err := s.ListFlowRuns(flow.ID, 10)
	if err != nil || len(runs) != 0 {
		t.Fatalf("invalid execution was persisted: %#v %v", runs, err)
	}
}
