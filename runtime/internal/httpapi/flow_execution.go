package httpapi

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/apix/apix/runtime/internal/core"
)

// flowService owns backend sequential execution of Flow runs. Runs execute in a
// goroutine so closing/refreshing the desktop app never interrupts them.
type flowService struct {
	repo  *repository
	exec  *executionService
	hub   *core.Hub
	rules *core.RuleEngine

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
func (fs *flowService) StartRun(runID string, inputVars map[string]string) {
	ctx, cancel := context.WithCancel(context.Background())
	fs.mu.Lock()
	fs.cancels[runID] = cancel
	fs.mu.Unlock()
	go fs.run(ctx, runID, inputVars)
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
	ch <- core.PauseResult{Action: action}
	return nil
}

func (fs *flowService) run(ctx context.Context, runID string, inputVars map[string]string) {
	defer fs.clearCancel(runID)

	run, err := fs.repo.getFlowRun(runID)
	if err != nil {
		return
	}
	snapshot, redactedVars, err := fs.repo.flowRunSnapshot(runID)
	if err != nil {
		return
	}
	_ = redactedVars

	if err := fs.repo.startFlowRun(runID); err != nil {
		return
	}
	fs.emit("flow_run.started", runID, "", map[string]any{"total_steps": run.TotalSteps})

	vars := fs.buildVariables(run, snapshot, inputVars)
	configByPosition := map[int]FlowStepConfig{}
	for i, step := range snapshot.Steps {
		configByPosition[i] = step.Config
	}

	finalStatus := "succeeded"
	finalErrCode, finalErrMsg := "", ""

	for _, rs := range run.Steps {
		if ctx.Err() != nil {
			finalStatus = "cancelled"
			break
		}
		config := configByPosition[rs.Position]
		_ = fs.repo.setFlowRunCurrentStep(runID, rs.Position)
		start := time.Now().UTC()
		_ = fs.repo.setFlowRunStepStatus(rs.ID, "running", nil, "", "", &start, nil)
		fs.emit("flow_run.step_started", runID, rs.ID, map[string]any{"position": rs.Position, "name": rs.NameSnapshot})

		if fs.rules != nil {
			input := map[string]any{
				"method": rs.RequestSnapshot.Method,
				"url":    rs.RequestSnapshot.URL,
				"body":   rs.RequestSnapshot.Body,
			}
			if rule := fs.rules.CheckBefore(input, "production"); rule != nil {
				result, pauseErr := fs.pauseAndWait(ctx, runID, &rs, rule)
				if pauseErr != nil || result.Action == "stop" {
					finalStatus = "cancelled"
					break
				}
				if result.Action == "skip" {
					finished := time.Now().UTC()
					_ = fs.repo.setFlowRunStepStatus(rs.ID, "skipped", nil, "", "", nil, &finished)
					fs.emit("flow_run.step_finished", runID, rs.ID, map[string]any{"status": "skipped"})
					continue
				}
				_ = fs.repo.setFlowRunStepStatus(rs.ID, "running", nil, "", "", nil, nil)
				fs.emit("flow_run.step_started", runID, rs.ID, map[string]any{"position": rs.Position, "resumed": true})
			}
		}

		envID := ""
		if run.EnvironmentID != nil {
			envID = *run.EnvironmentID
		}
		request := rs.RequestSnapshot
		apiRun, execErr := fs.exec.Run(ctx, RunCommand{
			ProjectID:     run.ProjectID,
			EnvironmentID: envID,
			SessionID:     run.ID,
			StepID:        rs.ID,
			TriggerType:   run.TriggerType,
			InlineRequest: &request,
		}, vars)

		finished := time.Now().UTC()
		var apiRunID *string
		if apiRun != nil {
			apiRunID = &apiRun.ID
		}

		stepStatus := "succeeded"
		stepErrCode, stepErrMsg := "", ""
		if execErr != nil {
			stepStatus = "failed"
			stepErrCode = "request_failed"
			stepErrMsg = execErr.Error()
		} else {
			if fs.rules != nil && apiRun != nil && apiRun.ResponseStatus != nil {
				if rule := fs.rules.CheckAfter(map[string]any{"status": *apiRun.ResponseStatus}); rule != nil {
					result, pauseErr := fs.pauseAndWait(ctx, runID, &rs, rule)
					if pauseErr != nil || result.Action == "stop" {
						finalStatus = "cancelled"
						break
					}
				}
			}
			extracted, extractErr := fs.applyExtractors(config.Extractors, apiRun, vars)
			if extractErr != nil {
				stepStatus = "failed"
				stepErrCode = "extractor_failed"
				stepErrMsg = extractErr.Error()
			}
			for name := range extracted {
				fs.emit("flow_run.variable_extracted", runID, rs.ID, map[string]any{"name": name})
			}
		}

		_ = fs.repo.setFlowRunStepStatus(rs.ID, stepStatus, apiRunID, stepErrCode, stepErrMsg, nil, &finished)
		fs.emit("flow_run.step_finished", runID, rs.ID, map[string]any{
			"status": stepStatus, "api_run_id": apiRunID, "error_message": stepErrMsg,
		})

		if stepStatus == "failed" {
			if config.ContinueOnError {
				continue
			}
			if snapshot.Settings.StopOnError {
				finalStatus = "failed"
				finalErrCode, finalErrMsg = stepErrCode, stepErrMsg
				break
			}
		}
	}

	if finalStatus == "cancelled" || ctx.Err() != nil {
		_ = fs.repo.cancelPendingFlowRunSteps(runID)
		_ = fs.repo.finishFlowRun(runID, "cancelled", "cancelled", "run cancelled")
		fs.emit("flow_run.finished", runID, "", map[string]any{"status": "cancelled"})
		return
	}
	if finalStatus == "failed" {
		_ = fs.repo.cancelPendingFlowRunSteps(runID)
	}
	_ = fs.repo.finishFlowRun(runID, finalStatus, finalErrCode, finalErrMsg)
	fs.emit("flow_run.finished", runID, "", map[string]any{"status": finalStatus})
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
		return fmt.Sprintf("%v", v), true
	}
}
