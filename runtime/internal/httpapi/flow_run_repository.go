package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// createFlowRun snapshots the Flow and enqueues a run plus one pending
// flow_run_step per enabled step, all in a single transaction. The returned run
// is immutable with respect to later edits of the source Flow.
func (r *repository) createFlowRun(flow *Flow, envID *string, trigger string, variablesSnapshot map[string]any) (*FlowRun, error) {
	enabled := make([]FlowStep, 0, len(flow.Steps))
	for _, step := range flow.Steps {
		if step.Enabled {
			if (step.Type == "http" || step.Type == "") && strings.TrimSpace(step.Request.URL) == "" {
				return nil, fmt.Errorf("%w: step %q requires a url", errNoRunnableStep, step.Name)
			}
			enabled = append(enabled, step)
		}
	}
	if len(enabled) == 0 {
		return nil, errNoRunnableStep
	}
	if trigger == "" {
		trigger = "manual"
	}
	if variablesSnapshot == nil {
		variablesSnapshot = map[string]any{}
	}
	// Include defaults for inspection without changing the execution inputs.
	visibleVariables := map[string]any{}
	for _, def := range flow.Variables {
		if def.DefaultValue != "" {
			visibleVariables[def.Name] = def.DefaultValue
		}
	}
	for name, value := range variablesSnapshot {
		visibleVariables[name] = value
	}
	variablesSnapshot = visibleVariables

	snapshot := flowSnapshot{
		Name:        flow.Name,
		Description: flow.Description,
		Settings:    flow.Settings,
		Variables:   flow.Variables,
		Steps:       enabled,
	}

	now := time.Now().UTC()
	run := &FlowRun{
		ID:               uuid.NewString(),
		ProjectID:        flow.ProjectID,
		FlowID:           &flow.ID,
		FlowVersion:      flow.EditVersion,
		FlowNameSnapshot: flow.Name,
		EnvironmentID:    envID,
		TriggerType:      trigger,
		Status:           "queued",
		CurrentStep:      0,
		TotalSteps:       len(enabled),
		CreatedAt:        now,
		Variables:        variablesSnapshot,
	}

	tx, err := r.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.Exec(`INSERT INTO flow_runs
		(id, project_id, flow_id, flow_version, flow_name_snapshot, flow_snapshot, environment_id, trigger_type,
		status, current_step, total_steps, variables_snapshot, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, run.ID, run.ProjectID, run.FlowID, run.FlowVersion, run.FlowNameSnapshot,
		marshalJSON(snapshot), run.EnvironmentID, run.TriggerType, run.Status, run.CurrentStep, run.TotalSteps,
		marshalJSON(variablesSnapshot), run.CreatedAt); err != nil {
		return nil, err
	}
	run.Steps = make([]FlowRunStep, 0, len(enabled))
	for i, step := range enabled {
		stepID := step.ID
		runStep := FlowRunStep{
			Type:            step.Type,
			SQLSnapshot:     step.SQL,
			ServiceSnapshot: step.Service,
			ID:              uuid.NewString(),
			FlowRunID:       run.ID,
			FlowStepID:      &stepID,
			Position:        i,
			NameSnapshot:    step.Name,
			RequestSnapshot: step.Request,
			Status:          "pending",
		}
		if _, err := tx.Exec(`INSERT INTO flow_run_steps
			(id, flow_run_id, flow_step_id, position, name_snapshot, request_snapshot, status, type, sql_snapshot, service_snapshot)
			VALUES (?,?,?,?,?,?,?,?,?,?)`, runStep.ID, runStep.FlowRunID, runStep.FlowStepID, runStep.Position,
			runStep.NameSnapshot, marshalJSON(runStep.RequestSnapshot), runStep.Status, step.Type,
			marshalJSON(step.SQL), marshalJSON(step.Service)); err != nil {
			return nil, err
		}
		run.Steps = append(run.Steps, runStep)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return run, nil
}

func (r *repository) getFlowRun(id string) (*FlowRun, error) {
	run := &FlowRun{}
	var flowID, envID sql.NullString
	var snapshot, variables string
	var errCode, errMsg sql.NullString
	var started, finished sql.NullTime
	err := r.db.QueryRow(`SELECT id, project_id, flow_id, flow_version, flow_name_snapshot, flow_snapshot,
		environment_id, trigger_type, status, current_step, total_steps, variables_snapshot,
		error_code, error_message, created_at, started_at, finished_at, COALESCE(cleanup_error,'') FROM flow_runs WHERE id=?`, id).Scan(
		&run.ID, &run.ProjectID, &flowID, &run.FlowVersion, &run.FlowNameSnapshot, &snapshot,
		&envID, &run.TriggerType, &run.Status, &run.CurrentStep, &run.TotalSteps, &variables,
		&errCode, &errMsg, &run.CreatedAt, &started, &finished, &run.CleanupError)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if flowID.Valid {
		run.FlowID = &flowID.String
	}
	if envID.Valid {
		run.EnvironmentID = &envID.String
	}
	run.ErrorCode, run.ErrorMessage = errCode.String, errMsg.String
	_ = json.Unmarshal([]byte(variables), &run.Variables)
	if started.Valid {
		run.StartedAt = &started.Time
	}
	if finished.Valid {
		run.FinishedAt = &finished.Time
	}
	steps, err := r.listFlowRunSteps(id)
	if err != nil {
		return nil, err
	}
	run.Steps = steps
	return run, nil
}

func (r *repository) listFlowRunSteps(runID string) ([]FlowRunStep, error) {
	rows, err := r.db.Query(`SELECT id, flow_run_id, flow_step_id, position, name_snapshot, request_snapshot,
		status, api_run_id, error_code, error_message, started_at, finished_at, type, sql_snapshot, service_snapshot, result, assertions
		FROM flow_run_steps WHERE flow_run_id=? ORDER BY position`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]FlowRunStep, 0)
	for rows.Next() {
		var s FlowRunStep
		var flowStepID, apiRunID, errCode, errMsg sql.NullString
		var requestJSON string
		var sqlJSON, serviceJSON, resultJSON sql.NullString
		var assertionJSON string
		var started, finished sql.NullTime
		if err := rows.Scan(&s.ID, &s.FlowRunID, &flowStepID, &s.Position, &s.NameSnapshot, &requestJSON,
			&s.Status, &apiRunID, &errCode, &errMsg, &started, &finished, &s.Type, &sqlJSON, &serviceJSON, &resultJSON, &assertionJSON); err != nil {
			return nil, err
		}
		if flowStepID.Valid {
			s.FlowStepID = &flowStepID.String
		}
		if apiRunID.Valid {
			s.APIRunID = &apiRunID.String
		}
		s.ErrorCode, s.ErrorMessage = errCode.String, errMsg.String
		if started.Valid {
			s.StartedAt = &started.Time
		}
		if finished.Valid {
			s.FinishedAt = &finished.Time
		}
		_ = json.Unmarshal([]byte(requestJSON), &s.RequestSnapshot)
		_ = json.Unmarshal([]byte(sqlJSON.String), &s.SQLSnapshot)
		_ = json.Unmarshal([]byte(serviceJSON.String), &s.ServiceSnapshot)
		_ = json.Unmarshal([]byte(resultJSON.String), &s.Result)
		_ = json.Unmarshal([]byte(assertionJSON), &s.Assertions)
		out = append(out, s)
	}
	return out, rows.Err()
}

func (r *repository) listFlowRuns(flowID string, limit int) ([]FlowRun, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := r.db.Query(`SELECT id FROM flow_runs WHERE flow_id=? ORDER BY created_at DESC LIMIT ?`, flowID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]FlowRun, 0, len(ids))
	for _, id := range ids {
		run, err := r.getFlowRun(id)
		if err != nil {
			return nil, err
		}
		out = append(out, *run)
	}
	return out, nil
}

// ── run mutators (used by the executor) ──────────────

func (r *repository) setFlowRunStatus(id, status string) error {
	_, err := r.db.Exec(`UPDATE flow_runs SET status=? WHERE id=?`, status, id)
	return err
}

func (r *repository) startFlowRun(id string) error {
	result, err := r.db.Exec(`UPDATE flow_runs SET status='running', started_at=COALESCE(started_at, ?) WHERE id=? AND status='queued'`, time.Now().UTC(), id)
	if err != nil {
		return err
	}
	if n, err := result.RowsAffected(); err != nil {
		return err
	} else if n == 0 {
		return fmt.Errorf("flow run %s is not queued", id)
	}
	return nil
}

func (r *repository) setFlowRunCurrentStep(id string, current int) error {
	_, err := r.db.Exec(`UPDATE flow_runs SET current_step=? WHERE id=?`, current, id)
	return err
}

func (r *repository) finishFlowRun(id, status, errCode, errMsg string) error {
	_, err := r.db.Exec(`UPDATE flow_runs SET status=?, error_code=?, error_message=?, finished_at=? WHERE id=? AND status IN ('queued','running','paused')`,
		status, optionalString(errCode), optionalString(errMsg), time.Now().UTC(), id)
	return err
}

func (r *repository) setFlowRunStepStatus(stepRunID, status string, apiRunID *string, errCode, errMsg string, started, finished *time.Time) error {
	_, err := r.db.Exec(`UPDATE flow_run_steps SET status=?, api_run_id=COALESCE(?, api_run_id),
		error_code=?, error_message=?, started_at=COALESCE(?, started_at), finished_at=COALESCE(?, finished_at) WHERE id=?`,
		status, apiRunID, optionalString(errCode), optionalString(errMsg), started, finished, stepRunID)
	return err
}

func (r *repository) setFlowRunStepResult(id string, result any, assertions []AssertionResult) error {
	if assertions == nil {
		assertions = []AssertionResult{}
	}
	_, err := r.db.Exec(`UPDATE flow_run_steps SET result=?, assertions=? WHERE id=?`, marshalJSON(result), marshalJSON(assertions), id)
	return err
}

func (r *repository) setFlowRunCleanupError(id, message string) error {
	_, err := r.db.Exec(`UPDATE flow_runs SET cleanup_error=? WHERE id=?`, optionalString(message), id)
	return err
}

// cancelPendingFlowRunSteps marks any not-yet-started steps as cancelled.
func (r *repository) cancelPendingFlowRunSteps(runID string) error {
	_, err := r.db.Exec(`UPDATE flow_run_steps SET status='cancelled', finished_at=?
		WHERE flow_run_id=? AND status IN ('pending','running','paused')`, time.Now().UTC(), runID)
	return err
}

// flowRunSnapshot returns the immutable Flow snapshot and the (redacted)
// variables snapshot captured when the run was created.
func (r *repository) flowRunSnapshot(id string) (flowSnapshot, map[string]any, error) {
	var snapshotJSON, variablesJSON string
	err := r.db.QueryRow(`SELECT flow_snapshot, variables_snapshot FROM flow_runs WHERE id=?`, id).Scan(&snapshotJSON, &variablesJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return flowSnapshot{}, nil, errNotFound
	}
	if err != nil {
		return flowSnapshot{}, nil, err
	}
	var snapshot flowSnapshot
	if err := json.Unmarshal([]byte(snapshotJSON), &snapshot); err != nil {
		return flowSnapshot{}, nil, err
	}
	vars := map[string]any{}
	_ = json.Unmarshal([]byte(variablesJSON), &vars)
	return snapshot, vars, nil
}

// loadEnvironment returns the base_url and non-secret+secret variable values for
// substitution. Secret handling for persistence happens elsewhere; execution
// needs the real values to actually send requests.
func (r *repository) loadEnvironment(envID string) (string, map[string]string, error) {
	var baseURL string
	err := r.db.QueryRow(`SELECT base_url FROM environments WHERE id=?`, envID).Scan(&baseURL)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, errNotFound
	}
	if err != nil {
		return "", nil, err
	}
	rows, err := r.db.Query(`SELECT key, value FROM env_variables WHERE environment_id=?`, envID)
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()
	vars := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return "", nil, err
		}
		vars[k] = v
	}
	return baseURL, vars, rows.Err()
}

func (r *repository) flowRunStatus(id string) (string, error) {
	var status string
	err := r.db.QueryRow(`SELECT status FROM flow_runs WHERE id=?`, id).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errNotFound
	}
	return status, err
}
