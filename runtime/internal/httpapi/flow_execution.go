package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/apix/apix/runtime/internal/core"
	"github.com/apix/apix/runtime/internal/database"
	"github.com/apix/apix/runtime/internal/localservice"
)

// flowService owns backend sequential execution of Flow runs. Runs execute in a
// goroutine so closing/refreshing the browser never interrupts them.
type flowService struct {
	repo *repository
	exec *executionService

	rules    *core.RuleEngine
	database interface {
		Execute(context.Context, database.Command) (*database.Result, error)
	}
	services  *localservice.Service
	eventSink func(eventType, runID, stepID string, payload any)
	wg        sync.WaitGroup
	closing   bool

	mu      sync.Mutex
	cancels map[string]context.CancelFunc
	pauses  map[string]chan core.PauseResult
}

func newFlowService(repo *repository, exec *executionService) *flowService {
	return &flowService{
		repo:    repo,
		exec:    exec,
		cancels: map[string]context.CancelFunc{},
		pauses:  map[string]chan core.PauseResult{},
	}
}

func (fs *flowService) setRuleEngine(rules *core.RuleEngine) { fs.rules = rules }

func (fs *flowService) emit(eventType, runID, stepID string, payload any) {
	if fs.eventSink != nil {
		fs.eventSink(eventType, runID, stepID, payload)
	}

}

// StartRun launches the run asynchronously. inputVars are the real (unredacted)
// caller-supplied variables used only in memory for substitution.
func (fs *flowService) StartRun(runID string, inputVars map[string]string) error {
	ctx, cancel := context.WithCancel(context.Background())
	fs.mu.Lock()
	if fs.closing {
		fs.mu.Unlock()
		cancel()
		return fmt.Errorf("runtime is shutting down; cannot start flow run")
	}
	if fs.cancels[runID] != nil {
		fs.mu.Unlock()
		cancel()
		return fmt.Errorf("flow run %s is already active", runID)
	}
	fs.cancels[runID] = cancel
	fs.wg.Add(1)
	fs.mu.Unlock()
	go func() { defer fs.wg.Done(); defer cancel(); fs.run(ctx, runID, inputVars) }()
	return nil
}

func (fs *flowService) Shutdown(ctx context.Context) error {
	fs.mu.Lock()
	fs.closing = true
	for _, cancel := range fs.cancels {
		cancel()
	}
	fs.mu.Unlock()
	done := make(chan struct{})
	go func() { fs.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Cancel requests cancellation of a run. It is idempotent.
func (fs *flowService) Cancel(runID string) error {
	status, err := fs.repo.flowRunStatus(runID)
	if err != nil {
		return err
	}
	// Completed runs simply return their current state.
	if status == "succeeded" || status == "failed" || status == "cancelled" {
		return nil
	}
	fs.mu.Lock()
	cancel := fs.cancels[runID]
	fs.mu.Unlock()
	if cancel != nil {
		cancel()
		return nil // The executor publishes the terminal state after cleanup.
	}
	// Completion can race with the first status read and remove the cancel
	// function. Do not replace an already-published terminal result.
	status, err = fs.repo.flowRunStatus(runID)
	if err != nil {
		return err
	}
	if status == "succeeded" || status == "failed" || status == "cancelled" {
		return nil
	}
	if err := fs.repo.cancelPendingFlowRunSteps(runID); err != nil {
		return err
	}
	if err := fs.repo.finishFlowRun(runID, "cancelled", "cancelled", "run cancelled by user"); err != nil {
		return err
	}
	fs.emit("flow_run.finished", runID, "", map[string]any{"status": "cancelled"})
	return nil
}

func (fs *flowService) clearCancel(runID string) {
	fs.mu.Lock()
	delete(fs.cancels, runID)
	fs.mu.Unlock()
}

func (fs *flowService) pauseAndWait(
	ctx context.Context,
	runID string,
	step *FlowRunStep,
	rule *core.Rule,
) (core.PauseResult, error) {
	ch := make(chan core.PauseResult, 1)
	fs.mu.Lock()
	fs.pauses[step.ID] = ch
	fs.mu.Unlock()
	defer func() {
		fs.mu.Lock()
		delete(fs.pauses, step.ID)
		fs.mu.Unlock()
	}()

	_ = fs.repo.setFlowRunStatus(runID, "paused")
	_ = fs.repo.setFlowRunStepStatus(step.ID, "paused", nil, "", "", nil, nil)
	fs.emit("flow_run.step_paused", runID, step.ID, map[string]any{
		"rule_id":   rule.ID,
		"rule_name": rule.Name,
	})

	select {
	case result := <-ch:
		_ = fs.repo.setFlowRunStatus(runID, "running")
		return result, nil
	case <-ctx.Done():
		return core.PauseResult{Action: "stop"}, ctx.Err()
	}
}

func (fs *flowService) Resume(stepID, action string) error {
	if action != "continue" && action != "skip" && action != "stop" {
		return fmt.Errorf("invalid resume action %q", action)
	}
	fs.mu.Lock()
	ch, ok := fs.pauses[stepID]
	fs.mu.Unlock()
	if !ok {
		return fmt.Errorf("step %s is not paused", stepID)
	}
	select {
	case ch <- core.PauseResult{Action: action}:
	default:
		return fmt.Errorf("step %s already has a pending resume action", stepID)
	}
	return nil
}

type flowStepOutcome struct {
	status            string
	code              string
	message           string
	persistenceFailed bool
}

func (fs *flowService) run(ctx context.Context, runID string, inputVars map[string]string) {
	defer fs.clearCancel(runID)
	run, err := fs.repo.getFlowRun(runID)
	if err != nil || run.Status == "succeeded" || run.Status == "failed" || run.Status == "cancelled" {
		return
	}
	snapshot, _, err := fs.repo.flowRunSnapshot(runID)
	if err != nil {
		_ = fs.repo.cancelPendingFlowRunSteps(runID)
		_ = fs.repo.finishFlowRun(runID, "failed", "snapshot_failed", err.Error())
		return
	}
	if err := fs.repo.startFlowRun(runID); err != nil {
		_ = fs.repo.cancelPendingFlowRunSteps(runID)
		_ = fs.repo.finishFlowRun(runID, "failed", "persistence_failed", err.Error())
		fs.emit("flow_run.finished", runID, "", map[string]any{"status": "failed", "error_code": "persistence_failed", "error_message": err.Error()})
		return
	}
	fs.emit("flow_run.started", runID, "", map[string]any{"total_steps": run.TotalSteps})
	vars := fs.buildVariables(run, snapshot, inputVars)
	outputs := flowOutputs{}
	finalStatus, finalCode, finalMessage := "succeeded", "", ""
	stopped, cleaning := false, false
	var cleanupErrors []error
	var cleanupCtx context.Context
	var cleanupCancel context.CancelFunc
	defer func() {
		if cleanupCancel != nil {
			cleanupCancel()
		}
	}()

	for _, rs := range run.Steps {
		definition := snapshot.Steps[rs.Position]
		finally := definition.Config.Phase == "finally"
		if finally && !cleaning {
			cleaning = true
			// Cancellation stops the body; cleanup has an independent total budget.
			cleanupCtx, cleanupCancel = context.WithTimeout(context.Background(), 30*time.Second)
			_ = fs.repo.setFlowRunStatus(runID, "running")
			fs.emit("flow_run.cleanup_started", runID, "", nil)
		}
		if !finally && (stopped || ctx.Err() != nil) {
			if ctx.Err() != nil {
				finalStatus = "cancelled"
			}
			finished := time.Now().UTC()
			reason := "not executed because an earlier step failed"
			if ctx.Err() != nil {
				reason = "run cancelled"
			}
			if err := fs.repo.setFlowRunStepStatus(rs.ID, "cancelled", nil, "not_executed", reason, nil, &finished); err != nil {
				if finalStatus == "succeeded" {
					finalStatus, finalCode, finalMessage = "failed", "persistence_failed", err.Error()
				}
			}
			fs.emit("flow_run.step_finished", runID, rs.ID, map[string]any{"status": "cancelled", "error_code": "not_executed", "error_message": reason})
			continue
		}
		stepParent := ctx
		if finally {
			stepParent = cleanupCtx
		}
		outcome := fs.runStep(stepParent, run, rs, definition, snapshot, vars, outputs)
		if finally {
			if outcome.status == "failed" || outcome.status == "cancelled" {
				cleanupErrors = append(cleanupErrors, fmt.Errorf("%s: %s", definition.Name, outcome.message))
			}
			// Cleanup always attempts the remaining steps, regardless of policy.
			continue
		}
		if outcome.status == "cancelled" {
			finalStatus, stopped = "cancelled", true
		} else if outcome.status == "failed" {
			// Preserve the first failure even when subsequent checks also fail.
			if finalStatus == "succeeded" {
				finalStatus, finalCode, finalMessage = "failed", outcome.code, outcome.message
			}
			stopped = outcome.persistenceFailed || !flowContinues(definition.Config, snapshot.Settings)
		}
	}
	// Existing service ownership cleanup runs after explicit finalizers, with a
	// fresh budget so a timed-out finalizer cannot prevent service release.
	if fs.services != nil {
		if !cleaning {
			fs.emit("flow_run.cleanup_started", runID, "", nil)
		}
		serviceCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		cleanupErr := fs.services.Cleanup(serviceCtx, runID)
		cancel()
		if cleanupErr != nil {
			cleanupErrors = append(cleanupErrors, cleanupErr)
		}
	}
	if cleaning || fs.services != nil {
		cleanupStatus := "succeeded"
		if cleanupErr := errors.Join(cleanupErrors...); cleanupErr != nil {
			cleanupStatus = "failed"
			message := redactFlowMessage(cleanupErr.Error(), outputs)
			if err := fs.repo.setFlowRunCleanupError(runID, message); err != nil {
				message += "; cleanup result could not be persisted"
			}
			if finalStatus == "succeeded" {
				finalStatus, finalCode, finalMessage = "failed", "cleanup_failed", message
			}
			fs.emit("flow_run.cleanup_finished", runID, "", map[string]any{"status": cleanupStatus, "error_message": message})
		} else {
			fs.emit("flow_run.cleanup_finished", runID, "", map[string]any{"status": cleanupStatus})
		}
	}
	if ctx.Err() != nil || finalStatus == "cancelled" {
		finalStatus = "cancelled"
		if finalCode == "" {
			finalCode, finalMessage = "cancelled", "run cancelled"
		}
	}
	// Also closes a step interrupted while waiting for a pause decision.
	if finalStatus != "succeeded" {
		_ = fs.repo.cancelPendingFlowRunSteps(runID)
	}
	if err := fs.repo.finishFlowRun(runID, finalStatus, finalCode, finalMessage); err != nil {
		finalStatus, finalCode, finalMessage = "failed", "persistence_failed", "could not persist final run status: "+err.Error()
	}
	fs.emit("flow_run.finished", runID, "", map[string]any{"status": finalStatus, "error_code": finalCode, "error_message": finalMessage})
}

func (fs *flowService) runStep(ctx context.Context, run *FlowRun, rs FlowRunStep, definition FlowStep, snapshot flowSnapshot, vars *core.Variables, outputs flowOutputs) flowStepOutcome {
	outcome := flowStepOutcome{status: "succeeded"}
	fail := func(code string, err error) {
		outcome.status, outcome.code, outcome.message = "failed", code, redactFlowMessage(err.Error(), outputs)
		if code == "persistence_failed" {
			outcome.persistenceFailed = true
		}
	}
	start := time.Now().UTC()
	if err := fs.repo.setFlowRunCurrentStep(run.ID, rs.Position); err != nil {
		fail("persistence_failed", err)
		return outcome
	}
	if err := fs.repo.setFlowRunStepStatus(rs.ID, "running", nil, "", "", &start, nil); err != nil {
		fail("persistence_failed", err)
		return outcome
	}
	fs.emit("flow_run.step_started", run.ID, rs.ID, map[string]any{"position": rs.Position, "name": rs.NameSnapshot, "type": rs.Type, "phase": definition.Config.Phase})
	var result any
	var assertions []AssertionResult
	var apiRunID *string
	resolved, resolveErr := resolveFlowStep(definition, outputs)
	if resolveErr != nil {
		fail("input_unavailable", resolveErr)
		if definition.Config.Phase == "finally" && definition.Config.SkipIfMissingOutputs && errors.Is(resolveErr, errFlowOutputMissing) {
			outcome.status, outcome.code = "skipped", "output_unavailable"
		}
	} else {
		rs.RequestSnapshot, rs.SQLSnapshot, rs.ServiceSnapshot = resolved.Request, resolved.SQL, resolved.Service
		if (rs.Type == "http" || rs.Type == "") && fs.rules != nil {
			input := map[string]any{"method": rs.RequestSnapshot.Method, "url": rs.RequestSnapshot.URL, "body": rs.RequestSnapshot.Body}
			if rule := fs.rules.CheckBefore(input, "production"); rule != nil {
				resumed, pauseErr := fs.pauseAndWait(ctx, run.ID, &rs, rule)
				if pauseErr != nil || resumed.Action == "stop" {
					outcome.status, outcome.code, outcome.message = "cancelled", "cancelled", "run stopped"
				} else if resumed.Action == "skip" {
					outcome.status, outcome.code, outcome.message = "skipped", "manual_skip", "step skipped by user"
				} else if err := fs.repo.setFlowRunStepStatus(rs.ID, "running", nil, "", "", nil, nil); err != nil {
					fail("persistence_failed", err)
				}
			}
		}
		if outcome.status == "succeeded" {
			timeoutMS := resolved.Config.TimeoutMS
			if timeoutMS == 0 {
				timeoutMS = snapshot.Settings.RequestTimeoutMS
			}
			if timeoutMS <= 0 {
				timeoutMS = 60000
			}
			stepCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMS)*time.Millisecond)
			apiRun, rawResult, checks, execErr := fs.executeStep(stepCtx, run, &rs, resolved.Config, vars)
			cancel()
			result, assertions = rawResult, checks
			if apiRun != nil {
				apiRunID = &apiRun.ID
			}
			if execErr != nil {
				code := "step_failed"
				if errors.Is(execErr, errFlowAssertion) {
					code = "assertion_failed"
				}
				if errors.Is(execErr, context.DeadlineExceeded) {
					code = "timeout"
				}
				if apiRun != nil && apiRun.ErrorCode == "timeout" {
					code = "timeout"
				}
				fail(code, execErr)
			}
			// Even a failed assertion/partial extraction may leave a created
			// resource; capture every available output for explicit cleanup.
			if apiRun != nil && apiRun.ResponseStatus != nil || definition.Type == "sql" && rawResult != nil {
				visible, extractErr := captureFlowOutputs(resolved, apiRun, rawResult, vars, outputs, snapshot.Variables)
				if extractErr != nil && outcome.status == "succeeded" {
					fail("extractor_failed", extractErr)
				}
				if apiRun != nil {
					result = FlowHTTPResult{ExtractedVariables: visible}
				} else {
					evidence := flowSQLEvidence(rawResult, visible)
					evidence["extracted_variables"] = visible
					result = evidence
				}
				for _, variable := range visible {
					fs.emit("flow_run.variable_extracted", run.ID, rs.ID, map[string]any{"name": variable.Name, "step_id": definition.ID})
				}
			}
			if ctx.Err() != nil {
				if errors.Is(ctx.Err(), context.DeadlineExceeded) {
					fail("timeout", ctx.Err())
				} else {
					outcome.status, outcome.code, outcome.message = "cancelled", "cancelled", "run cancelled"
				}
			}
			// Keep existing post-request pause behavior.
			if outcome.status == "succeeded" && apiRun != nil && apiRun.ResponseStatus != nil && fs.rules != nil {
				if rule := fs.rules.CheckAfter(map[string]any{"status": *apiRun.ResponseStatus}); rule != nil {
					resumed, pauseErr := fs.pauseAndWait(ctx, run.ID, &rs, rule)
					if pauseErr != nil || resumed.Action == "stop" {
						outcome.status, outcome.code, outcome.message = "cancelled", "cancelled", "run stopped"
					}
				}
			}
		}
	}
	result = redactFlowEvidence(result, outputs)
	// Assertions can mention a secret through a qualified output reference.
	for i := range assertions {
		assertions[i].Expected = redactFlowEvidence(assertions[i].Expected, outputs)
		assertions[i].Actual = redactFlowEvidence(assertions[i].Actual, outputs)
	}
	if err := fs.repo.setFlowRunStepResult(rs.ID, result, assertions); err != nil {
		fail("persistence_failed", err)
	}
	finished := time.Now().UTC()
	if err := fs.repo.setFlowRunStepStatus(rs.ID, outcome.status, apiRunID, outcome.code, outcome.message, nil, &finished); err != nil {
		fail("persistence_failed", err)
	}
	fs.emit("flow_run.step_finished", run.ID, rs.ID, map[string]any{"status": outcome.status, "api_run_id": apiRunID, "result": result, "assertions": assertions, "error_code": outcome.code, "error_message": outcome.message, "phase": definition.Config.Phase})
	return outcome
}

// buildVariables merges variables low→high: environment, flow defaults, run
// input, then extractor outputs are added during execution.
func (fs *flowService) buildVariables(run *FlowRun, snapshot flowSnapshot, inputVars map[string]string) *core.Variables {
	vars := core.NewVariables()
	set := func(name, value string) {
		vars.Global[name] = &core.Variable{Name: name, Value: value, Scope: "run", Source: "flow"}
	}
	if run.EnvironmentID != nil {
		if baseURL, envVars, err := fs.repo.loadEnvironment(*run.EnvironmentID); err == nil {
			if baseURL != "" {
				set("base_url", baseURL)
			}
			for k, v := range envVars {
				set(k, v)
			}
		}
	}
	for _, def := range snapshot.Variables {
		if def.DefaultValue != "" {
			set(def.Name, def.DefaultValue)
		}
	}
	for k, v := range inputVars {
		set(k, v)
	}
	return vars
}

func extractValue(e FlowExtractor, run *APIRun) (string, bool) {
	if run == nil {
		return "", false
	}
	switch e.Source {
	case "status":
		if run.ResponseStatus == nil {
			return "", false
		}
		return strconv.Itoa(*run.ResponseStatus), true
	case "header":
		headers, ok := run.ResponseHeaders.(map[string][]string)
		if !ok {
			// Persisted API runs decode JSON headers as map[string]any.
			if values, ok := run.ResponseHeaders.(map[string]any); ok {
				for name, value := range values {
					if strings.EqualFold(name, e.Path) {
						if list, ok := value.([]any); ok && len(list) > 0 {
							text, ok := list[0].(string)
							return text, ok
						}
					}
				}
			}
			return "", false
		}
		for name, values := range headers {
			if strings.EqualFold(name, e.Path) && len(values) > 0 {
				return values[0], true
			}
		}
		return "", false
	case "body":
		return extractFromBody(run.ResponseBody, e.Path)
	}
	return "", false
}

// extractFromBody walks a simple dot path (e.g. data.user.id). Numeric segments
// index into arrays. This is intentionally not full JSONPath.
func extractFromBody(body any, path string) (string, bool) {
	if path == "" {
		return stringify(body)
	}
	current := body
	for _, segment := range strings.Split(path, ".") {
		switch node := current.(type) {
		case map[string]any:
			next, ok := node[segment]
			if !ok {
				return "", false
			}
			current = next
		case []any:
			idx, err := strconv.Atoi(segment)
			if err != nil || idx < 0 || idx >= len(node) {
				return "", false
			}
			current = node[idx]
		default:
			return "", false
		}
	}
	return stringify(current)
}

func stringify(value any) (string, bool) {
	switch v := value.(type) {
	case nil:
		return "", false
	case string:
		return v, true
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64), true
	case bool:
		return strconv.FormatBool(v), true
	default:
		encoded, err := json.Marshal(v)
		return string(encoded), err == nil
	}
}
