package httpapi

import (
	"context"
	"errors"
	"fmt"
	"github.com/apix/apix/runtime/internal/lifecycle"
	"time"

	"github.com/apix/apix/runtime/internal/database"
	"github.com/apix/apix/runtime/internal/localservice"
)

// SetCapabilities connects the same operations used by REST/MCP to Flow.
func (s *HTTPService) SetCapabilities(db *database.Service, services *localservice.Service) {
	if db == nil {
		s.flow.database = nil
	} else {
		s.flow.database = db
		db.SetExecutionRecorder(s.RecordExecution)
	}
	s.flow.services = services
	if services != nil {
		services.SetExecutionRecorder(s.RecordExecution)
	}
}
func (s *HTTPService) SetEventSink(sink func(string, string, string, any)) { s.flow.eventSink = sink }
func (s *HTTPService) Close(ctx context.Context) error {
	s.commands.Stop()
	flowErr := s.flow.Shutdown(ctx)
	return errors.Join(flowErr, s.commands.Wait(ctx))
}

func (s *HTTPService) ListFlows(project string) ([]FlowSummary, error) {
	return s.repo.listFlowSummaries(valueOr(project, defaultProjectID), false)
}
func (s *HTTPService) GetFlow(id string) (*Flow, error)       { return s.repo.getFlow(id) }
func (s *HTTPService) GetFlowRun(id string) (*FlowRun, error) { return s.repo.getFlowRun(id) }
func (s *HTTPService) GetAPIRun(id string) (*APIRun, error)   { return s.repo.getRun(id) }
func (s *HTTPService) ListFlowRuns(id string, limit int) ([]FlowRun, error) {
	return s.repo.listFlowRuns(id, limit)
}
func (s *HTTPService) CancelFlowRun(id string) (*FlowRun, error) {
	if err := s.flow.Cancel(id); err != nil {
		return nil, err
	}
	return s.repo.getFlowRun(id)
}
func (s *HTTPService) ResumeFlowStep(runID, stepID, action string) (*FlowRun, error) {
	run, err := s.repo.getFlowRun(runID)
	if err != nil {
		return nil, err
	}
	found := false
	for _, step := range run.Steps {
		if step.ID == stepID {
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("step does not belong to run")
	}
	if err := s.flow.Resume(stepID, action); err != nil {
		return nil, err
	}
	return s.repo.getFlowRun(runID)
}

func (s *HTTPService) SaveFlow(flow Flow) (*Flow, error) {
	if flow.ProjectID == "" {
		flow.ProjectID = defaultProjectID
	}
	if flow.Name == "" {
		flow.Name = "Untitled flow"
	}
	if flow.ID != "" {
		if flow.EditVersion < 1 {
			return nil, fmt.Errorf("edit_version is required when updating a flow")
		}
		return s.repo.updateFlow(&flow, flow.EditVersion)
	}
	if err := s.repo.validateFlowAggregate(&flow); err != nil {
		return nil, err
	}
	created, err := s.repo.createFlow(flow.ProjectID, flow.Name)
	if err != nil {
		return nil, err
	}
	flow.ID, flow.EditVersion = created.ID, created.EditVersion
	result, err := s.repo.updateFlow(&flow, created.EditVersion)
	if err != nil {
		_ = s.repo.archiveFlow(created.ID)
	}
	return result, err
}

func (s *HTTPService) StartFlow(id string, version int64, variables map[string]string, trigger string) (*FlowRun, error) {
	return s.startFlow(id, version, "", variables, trigger)
}

func (s *HTTPService) startFlow(id string, version int64, environment string, variables map[string]string, trigger string) (*FlowRun, error) {
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	flow, err := s.repo.getFlow(id)
	if err != nil {
		return nil, err
	}
	if flow.ArchivedAt != nil {
		return nil, fmt.Errorf("%w: 流程已归档，请先恢复", errConflict)
	}
	if err := s.repo.checkFlowDependencies(flow); err != nil {
		return nil, err
	}
	if version != 0 && flow.EditVersion != version {
		return nil, errConflict
	}
	if environment != "" {
		if err := s.repo.assertEnvironmentInProject(environment, flow.ProjectID); err != nil {
			return nil, fmt.Errorf("%w: %v", errValidation, err)
		}
		flow.EnvironmentID = &environment
	}
	available := map[string]string{}
	if flow.EnvironmentID != nil {
		_, envVars, err := s.repo.loadEnvironment(*flow.EnvironmentID)
		if err != nil {
			return nil, err
		}
		for key, value := range envVars {
			available[key] = value
		}
	}
	for _, def := range flow.Variables {
		if def.DefaultValue != "" {
			available[def.Name] = def.DefaultValue
		}
	}
	for key, value := range variables {
		available[key] = value
	}
	for _, def := range flow.Variables {
		if def.Required && available[def.Name] == "" {
			return nil, fmt.Errorf("%w: required variable %q is missing", errValidation, def.Name)
		}
	}
	run, err := s.repo.createFlowRun(flow, flow.EnvironmentID, trigger, redactRunVariables(flow.Variables, variables))
	if err != nil {
		return nil, err
	}
	if err := s.flow.StartRun(run.ID, variables); err != nil {
		_ = s.repo.cancelPendingFlowRunSteps(run.ID)
		_ = s.repo.finishFlowRun(run.ID, "failed", "runtime_stopping", err.Error())
		return nil, err
	}
	return run, nil
}

// RecoverInterruptedRuns deliberately fails unfinished work instead of silently
// retrying potentially mutating SQL/HTTP calls after a restart.
func (s *HTTPService) RecoverInterruptedRuns() error {
	now := time.Now().UTC()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, statement := range []string{
		`UPDATE flow_run_steps SET status='cancelled',finished_at=?,error_code='runtime_restarted',error_message='runtime restarted; execution was interrupted' WHERE status IN ('pending','running','paused')`,
		`UPDATE flow_runs SET status='failed',finished_at=?,error_code='runtime_restarted',error_message='runtime restarted; execution was interrupted' WHERE status IN ('queued','running','paused')`,
		`UPDATE api_runs SET status='failed',finished_at=?,error_code='runtime_restarted',error_message='runtime restarted; request was interrupted' WHERE status='running'`,
		`UPDATE test_case_runs SET status='error',finished_at=?,error_message='runtime restarted; test was interrupted' WHERE status='running'`,
		`UPDATE test_batches SET status='interrupted',finished_at=? WHERE status='running'`,
	} {
		if _, err := tx.Exec(statement, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}
