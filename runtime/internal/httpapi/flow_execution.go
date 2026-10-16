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
// goroutine so closing/refreshing the desktop app never interrupts them.
type flowService struct {
	repo      *repository
	exec      *executionService
	hub       *core.Hub
	rules     *core.RuleEngine
	database  *database.Service
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

func (fs *flowService) setHub(hub *core.Hub)                 { fs.hub = hub }
func (fs *flowService) setRuleEngine(rules *core.RuleEngine) { fs.rules = rules }

func (fs *flowService) emit(eventType, runID, stepID string, payload any) {
	if fs.eventSink != nil {
		fs.eventSink(eventType, runID, stepID, payload)
	}
	if fs.hub == nil {
		return
	}
	fs.hub.Push(runID, core.Event{
		Type:    core.EventType(eventType),
		StepID:  stepID,
		Payload: payload,
	})
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
	finalStatus, finalCode, finalMessage := "succeeded", "", ""
	for _, rs := range run.Steps {
		if ctx.Err() != nil {
			finalStatus = "cancelled"
			break
		}
		config := snapshot.Steps[rs.Position].Config
		if err := fs.repo.setFlowRunCurrentStep(runID, rs.Position); err != nil {
			finalStatus, finalCode, finalMessage = "failed", "persistence_failed", err.Error()
			break
		}
		start := time.Now().UTC()
		if err := fs.repo.setFlowRunStepStatus(rs.ID, "running", nil, "", "", &start, nil); err != nil {
			finalStatus, finalCode, finalMessage = "failed", "persistence_failed", err.Error()
			break
		}
		fs.emit("flow_run.step_started", runID, rs.ID, map[string]any{"position": rs.Position, "name": rs.NameSnapshot, "type": rs.Type})
		if (rs.Type == "http" || rs.Type == "") && fs.rules != nil {
			input := map[string]any{"method": rs.RequestSnapshot.Method, "url": rs.RequestSnapshot.URL, "body": rs.RequestSnapshot.Body}
			if rule := fs.rules.CheckBefore(input, "production"); rule != nil {
				resumed, pauseErr := fs.pauseAndWait(ctx, runID, &rs, rule)
				if pauseErr != nil || resumed.Action == "stop" {
					finalStatus = "cancelled"
					break
				}
				if resumed.Action == "skip" {
					finished := time.Now().UTC()
					if err := fs.repo.setFlowRunStepStatus(rs.ID, "skipped", nil, "", "", nil, &finished); err != nil {
						finalStatus, finalCode, finalMessage = "failed", "persistence_failed", err.Error()
						break
					}
					fs.emit("flow_run.step_finished", runID, rs.ID, map[string]any{"status": "skipped"})
					continue
				}
				if err := fs.repo.setFlowRunStepStatus(rs.ID, "running", nil, "", "", nil, nil); err != nil {
					finalStatus, finalCode, finalMessage = "failed", "persistence_failed", err.Error()
					break
				}
			}
		}
		timeoutMS := config.TimeoutMS
		if timeoutMS == 0 {
			timeoutMS = snapshot.Settings.RequestTimeoutMS
		}
		if timeoutMS <= 0 {
			timeoutMS = 60000
		}
		stepCtx, cancelStep := context.WithTimeout(ctx, time.Duration(timeoutMS)*time.Millisecond)
		apiRun, result, assertions, execErr := fs.executeStep(stepCtx, run, &rs, config, vars)
		cancelStep()
		var apiRunID *string
		if apiRun != nil {
			apiRunID = &apiRun.ID
		}
		persistenceFailed := false
		stepStatus, stepCode, stepMessage := "succeeded", "", ""
		if execErr != nil {
			stepStatus, stepCode, stepMessage = "failed", "step_failed", execErr.Error()
			if errors.Is(execErr, errFlowAssertion) {
				stepCode = "assertion_failed"
			}
			if errors.Is(execErr, context.DeadlineExceeded) {
				stepCode = "timeout"
			}
		}
		if ctx.Err() != nil {
			stepStatus, stepCode, stepMessage = "cancelled", "cancelled", "run cancelled"
			finalStatus = "cancelled"
		}
		if stepStatus == "succeeded" && apiRun != nil {
			if fs.rules != nil && apiRun.ResponseStatus != nil {
				if rule := fs.rules.CheckAfter(map[string]any{"status": *apiRun.ResponseStatus}); rule != nil {
					resumed, pauseErr := fs.pauseAndWait(ctx, runID, &rs, rule)
					if pauseErr != nil || resumed.Action == "stop" {
						stepStatus, stepCode, stepMessage = "cancelled", "cancelled", "run stopped"
						finalStatus = "cancelled"
					}
				}
			}
			if stepStatus == "succeeded" {
				extracted, extractErr := fs.applyExtractors(config.Extractors, apiRun, vars)
				if extractErr != nil {
					stepStatus, stepCode, stepMessage = "failed", "extractor_failed", extractErr.Error()
				}
				for name := range extracted {
					fs.emit("flow_run.variable_extracted", runID, rs.ID, map[string]any{"name": name})
				}
				visible := make([]FlowExtractedVariable, 0, len(extracted))
				for _, extractor := range config.Extractors {
					value, ok := extracted[extractor.Name]
					if !ok {
						continue
					}
					secret := extractor.Secret
					for _, def := range snapshot.Variables {
						if def.Name == extractor.Name && def.Secret {
							secret = true
						}
					}
					if secret {
						value = "••••••"
					}
					visible = append(visible, FlowExtractedVariable{Name: extractor.Name, Value: value, Secret: secret, Source: extractor.Source, Path: extractor.Path})
				}
				result = FlowHTTPResult{ExtractedVariables: visible}
			}
		}
		if persistErr := fs.repo.setFlowRunStepResult(rs.ID, result, assertions); persistErr != nil {
			persistenceFailed = true
			stepStatus, stepCode, stepMessage = "failed", "persistence_failed", persistErr.Error()
		}
		finished := time.Now().UTC()
		if err := fs.repo.setFlowRunStepStatus(rs.ID, stepStatus, apiRunID, stepCode, stepMessage, nil, &finished); err != nil {
			stepStatus, stepCode, stepMessage = "failed", "persistence_failed", err.Error()
			persistenceFailed = true
		}
		fs.emit("flow_run.step_finished", runID, rs.ID, map[string]any{"status": stepStatus, "api_run_id": apiRunID, "result": result, "assertions": assertions, "error_code": stepCode, "error_message": stepMessage})
		if finalStatus == "cancelled" {
			break
		}
		if stepStatus == "failed" {
			finalStatus, finalCode, finalMessage = "failed", stepCode, stepMessage
			if persistenceFailed || (!config.ContinueOnError && snapshot.Settings.StopOnError) {
				break
			}
		}
	}
	if finalStatus == "cancelled" || ctx.Err() != nil {
		finalStatus, finalCode, finalMessage = "cancelled", "cancelled", "run cancelled"
	}
	if finalStatus != "succeeded" {
		_ = fs.repo.cancelPendingFlowRunSteps(runID)
	}
	// Cleanup uses a fresh context even when the run was cancelled.
	if fs.services != nil {
		fs.emit("flow_run.cleanup_started", runID, "", nil)
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		cleanupErr := fs.services.Cleanup(cleanupCtx, runID)
		cleanupCancel()
		if cleanupErr != nil {
			_ = fs.repo.setFlowRunCleanupError(runID, cleanupErr.Error())
			if finalStatus == "succeeded" {
				finalStatus, finalCode, finalMessage = "failed", "cleanup_failed", cleanupErr.Error()
			}
			fs.emit("flow_run.cleanup_finished", runID, "", map[string]any{"status": "failed", "error_message": cleanupErr.Error()})
		} else {
			fs.emit("flow_run.cleanup_finished", runID, "", map[string]any{"status": "succeeded"})
		}
	}
	if ctx.Err() != nil {
		finalStatus, finalCode, finalMessage = "cancelled", "cancelled", "run cancelled"
	}
	if err := fs.repo.finishFlowRun(runID, finalStatus, finalCode, finalMessage); err != nil {
		finalStatus, finalCode, finalMessage = "failed", "persistence_failed", "could not persist final run status: "+err.Error()
	}
	fs.emit("flow_run.finished", runID, "", map[string]any{"status": finalStatus, "error_code": finalCode, "error_message": finalMessage})
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

// applyExtractors pulls values from the API run into the run-scoped variables.
// A required extractor whose value is missing fails the step.
func (fs *flowService) applyExtractors(extractors []FlowExtractor, run *APIRun, vars *core.Variables) (map[string]string, error) {
	out := map[string]string{}
	for _, e := range extractors {
		value, ok := extractValue(e, run)
		if !ok {
			if e.Required {
				return out, fmt.Errorf("required value %q not found", e.Name)
			}
			continue
		}
		vars.Global[e.Name] = &core.Variable{Name: e.Name, Value: value, Scope: "run", Source: "extractor"}
		out[e.Name] = value
	}
	return out, nil
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
