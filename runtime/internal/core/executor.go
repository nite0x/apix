package core

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
)

type Executor struct {
	sessions     *SessionManager
	rules        *RuleEngine
	events       *Events
	store        Store
	execute      func(context.Context, string, map[string]any, *Variables) (any, error)
	extract      func(string, any) map[string]*Variable
	pauseChans   map[string]chan PauseResult
	mu           sync.Mutex
	sessionLocks sync.Map
}

func NewExecutor(
	sessions *SessionManager,
	rules *RuleEngine,
	events *Events,
	store Store,
	execute func(context.Context, string, map[string]any, *Variables) (any, error),
	extract func(string, any) map[string]*Variable,
) *Executor {
	return &Executor{
		sessions:   sessions,
		rules:      rules,
		events:     events,
		store:      store,
		execute:    execute,
		extract:    extract,
		pauseChans: make(map[string]chan PauseResult),
	}
}

// Execute is the unified entry point for MCP tool calls.
func (e *Executor) Execute(
	ctx context.Context,
	sessionID string,
	task string,
	tool string,
	input map[string]any,
) (any, error) {
	// A Session owns mutable step/variable state. Parallel AI calls in the
	// same batch enter it serially; different batches remain independent.
	lock, _ := e.sessionLocks.LoadOrStore(sessionID, &sync.Mutex{})
	lock.(*sync.Mutex).Lock()
	defer lock.(*sync.Mutex).Unlock()
	independentTest := input["test_run_id"] != nil

	// 1. Get or create session
	session, existed := e.sessions.Get(sessionID)
	if !existed {
		session = e.sessions.GetOrCreate(sessionID, task, "mcp")
		e.events.Publish(session.ID, Event{
			Type:    EventSessionStart,
			Payload: session,
		})
	}

	// 2. Create step
	now := time.Now()
	step := &Step{
		ID:        uuid.New().String(),
		SessionID: session.ID,
		Index:     len(session.Steps),
		Type:      StepTypeRequest,
		Status:    StepPending,
		Tool:      tool,
		Input:     input,
		StartedAt: &now,
	}
	session.Steps = append(session.Steps, step)

	// 3. Push step:start
	e.events.Publish(session.ID, Event{
		Type:    EventStepStart,
		StepID:  step.ID,
		Payload: step,
	})

	// 4. Check pause rules (before execution)
	if rule := e.rules.CheckBefore(input, "production"); rule != nil {
		result, err := e.pauseAndWait(ctx, session, step, rule.ID)
		if err != nil {
			return nil, e.failStep(session, step, err.Error())
		}
		switch result.Action {
		case "skip":
			return nil, e.skipStep(session, step)
		case "stop":
			return nil, e.stopSession(session)
		case "continue":
			if result.ModifiedInput != nil {
				if modified, ok := result.ModifiedInput.(map[string]any); ok {
					input = modified
					step.Input = input
				}
			}
		}
	}

	// 5. Execute
	step.Status = StepRunning
	// Execution adapters use these identifiers to link protocol-level work to
	// the authoritative run record without maintaining a second history model.
	input["session_id"] = session.ID
	input["step_id"] = step.ID
	e.events.Publish(session.ID, Event{
		Type:    EventStepStart,
		StepID:  step.ID,
		Payload: step,
	})

	output, err := e.execute(ctx, tool, input, session.Variables)
	endTime := time.Now()
	step.EndedAt = &endTime
	step.DurationMs = endTime.Sub(now).Milliseconds()
	if reference := runReference(output); reference != nil {
		// api_runs owns HTTP request/response history. Steps retain only the
		// relationship so secrets and response bodies are never persisted twice.
		step.Input = reference
		step.Output = reference
	}

	if err != nil {
		return output, e.failStep(session, step, err.Error())
	}

	// 6. Check pause rules (after execution, e.g. 4xx)
	if rule := e.rules.CheckAfter(output); rule != nil {
		result, err := e.pauseAndWait(ctx, session, step, rule.ID)
		if err != nil || result.Action == "stop" {
			return output, e.stopSession(session)
		}
	}

	// 7. Extract variables
	extractedVars := e.extract(tool, output)
	if independentTest {
		extractedVars = nil
	}
	for name, v := range extractedVars {
		if v.Scope == "global" {
			session.Variables.Global[name] = v
		} else {
			session.Variables.Session[name] = v
		}
		e.events.Publish(session.ID, Event{
			Type:    EventVarExtracted,
			Payload: map[string]any{"name": name, "variable": v},
		})
	}

	// 8. Done
	step.Status = StepDone
	if step.Output == nil {
		step.Output = output
	}
	e.events.Publish(session.ID, Event{
		Type:    EventStepDone,
		StepID:  step.ID,
		Payload: step,
	})
	e.store.SaveStep(step)

	return output, nil
}

func runReference(output any) map[string]any {
	if result, ok := output.(interface{ RunReference() string }); ok {
		if id := result.RunReference(); id != "" {
			return map[string]any{"api_run_id": id}
		}
	}
	values, ok := output.(map[string]any)
	if !ok {
		return nil
	}
	runID, ok := values["run_id"].(string)
	if !ok || runID == "" {
		return nil
	}
	return map[string]any{"api_run_id": runID}
}

// pauseAndWait suspends execution and blocks until the user acts in the App.
func (e *Executor) pauseAndWait(ctx context.Context, session *Session, step *Step, ruleID string) (PauseResult, error) {
	ch := make(chan PauseResult, 1)

	e.mu.Lock()
	e.pauseChans[step.ID] = ch
	e.mu.Unlock()

	defer func() {
		e.mu.Lock()
		delete(e.pauseChans, step.ID)
		e.mu.Unlock()
	}()

	step.Status = StepPaused
	step.RuleID = ruleID
	session.Status = SessionPaused

	e.events.Publish(session.ID, Event{
		Type:   EventStepPaused,
		StepID: step.ID,
		Payload: map[string]any{
			"step":    step,
			"rule_id": ruleID,
		},
	})

	select {
	case result := <-ch:
		session.Status = SessionRunning
		return result, nil
	case <-ctx.Done():
		return PauseResult{Action: "stop"}, ctx.Err()
	}
}

// Resume is called by the REST API to unblock a paused step.
func (e *Executor) Resume(stepID string, action string, modifiedInput any) error {
	if action != "continue" && action != "skip" && action != "stop" {
		return fmt.Errorf("invalid resume action %q", action)
	}
	e.mu.Lock()
	ch, ok := e.pauseChans[stepID]
	e.mu.Unlock()

	if !ok {
		return fmt.Errorf("step %s is not paused", stepID)
	}
	select {
	case ch <- PauseResult{Action: action, ModifiedInput: modifiedInput}:
	default:
		return fmt.Errorf("resume already pending for step %s", stepID)
	}
	return nil
}

func (e *Executor) failStep(session *Session, step *Step, errMsg string) error {
	if values, ok := step.Input.(map[string]any); ok && values["test_run_id"] != nil {
		step.Input = map[string]any{"test_run_id": values["test_run_id"]}
	}
	step.Status = StepError
	step.Error = errMsg
	session.Status = SessionError
	e.events.Publish(session.ID, Event{
		Type:    EventStepError,
		StepID:  step.ID,
		Payload: step,
	})
	e.store.SaveStep(step)
	return fmt.Errorf("%s", errMsg)
}

func (e *Executor) skipStep(session *Session, step *Step) error {
	step.Status = StepSkipped
	session.Status = SessionRunning
	e.events.Publish(session.ID, Event{
		Type:   EventStepSkipped,
		StepID: step.ID,
	})
	return fmt.Errorf("step skipped")
}

func (e *Executor) stopSession(session *Session) error {
	session.Status = SessionStopped
	e.events.Publish(session.ID, Event{
		Type: EventSessionStopped,
	})
	return fmt.Errorf("session stopped by user")
}

func (e *Executor) GetSessions() []*Session {
	return e.sessions.List()
}

// CompleteSession closes the compatibility session after its explicit test
// batch finishes; legacy clients should not show it as permanently running.
func (e *Executor) CompleteSession(id string, failed bool) {
	lock, _ := e.sessionLocks.LoadOrStore(id, &sync.Mutex{})
	lock.(*sync.Mutex).Lock()
	defer lock.(*sync.Mutex).Unlock()
	if _, ok := e.sessions.Get(id); !ok {
		return
	}
	status, event := SessionDone, EventSessionDone
	if failed {
		status, event = SessionError, EventSessionError
	}
	e.sessions.UpdateStatus(id, status)
	e.events.Publish(id, Event{Type: event})
}

func (e *Executor) GetSession(id string) (*Session, bool) {
	return e.sessions.Get(id)
}

func (e *Executor) GetRules() []*Rule {
	return e.rules.GetRules()
}

func (e *Executor) UpdateRules(rules []*Rule) {
	e.rules.UpdateRules(rules)
}
