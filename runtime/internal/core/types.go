package core

import "time"

// ── Session ──────────────────────────────────────────

type Session struct {
	ID        string        `json:"id"`
	Type      SessionType   `json:"type"`
	Status    SessionStatus `json:"status"`
	Task      string        `json:"task"`
	Source    string        `json:"source"`
	Steps     []*Step       `json:"steps"`
	Variables *Variables    `json:"variables"`
	CreatedAt time.Time     `json:"created_at"`
	UpdatedAt time.Time     `json:"updated_at"`
}

type SessionType string
type SessionStatus string

const (
	SessionTypeAI     SessionType = "ai"
	SessionTypeManual SessionType = "manual"

	SessionRunning SessionStatus = "running"
	SessionPaused  SessionStatus = "paused"
	SessionDone    SessionStatus = "done"
	SessionError   SessionStatus = "error"
	SessionStopped SessionStatus = "stopped"
)

// ── Step ─────────────────────────────────────────────

type Step struct {
	ID         string     `json:"id"`
	SessionID  string     `json:"session_id"`
	Index      int        `json:"index"`
	Type       StepType   `json:"type"`
	Status     StepStatus `json:"status"`
	Tool       string     `json:"tool,omitempty"`
	Input      any        `json:"input,omitempty"`
	Output     any        `json:"output,omitempty"`
	Thought    string     `json:"thought,omitempty"`
	Error      string     `json:"error,omitempty"`
	RuleID     string     `json:"rule_id,omitempty"`
	DurationMs int64      `json:"duration_ms,omitempty"`
	StartedAt  *time.Time `json:"started_at,omitempty"`
	EndedAt    *time.Time `json:"ended_at,omitempty"`
}

type StepType string
type StepStatus string

const (
	StepTypeRequest StepType = "request"
	StepTypeThink   StepType = "think"
	StepTypeManual  StepType = "manual"

	StepPending StepStatus = "pending"
	StepRunning StepStatus = "running"
	StepDone    StepStatus = "done"
	StepError   StepStatus = "error"
	StepPaused  StepStatus = "paused"
	StepSkipped StepStatus = "skipped"
)

// ── Variables ────────────────────────────────────────

type Variables struct {
	Global  map[string]*Variable `json:"global"`
	Session map[string]*Variable `json:"session"`
}

func NewVariables() *Variables {
	return &Variables{
		Global:  make(map[string]*Variable),
		Session: make(map[string]*Variable),
	}
}

type Variable struct {
	Name      string     `json:"name"`
	Value     any        `json:"value"`
	Scope     string     `json:"scope"`
	Source    string     `json:"source"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

// ── Rules ────────────────────────────────────────────

type Rule struct {
	ID      string      `json:"id"`
	Name    string      `json:"name"`
	Enabled bool        `json:"enabled"`
	Trigger RuleTrigger `json:"trigger"`
	Match   RuleMatch   `json:"match"`
	Action  string      `json:"action"`
}

type RuleTrigger string

const (
	TriggerBefore RuleTrigger = "before"
	TriggerAfter  RuleTrigger = "after"
)

type RuleMatch struct {
	Method      string `json:"method,omitempty"`
	URLPattern  string `json:"url_pattern,omitempty"`
	Env         string `json:"env,omitempty"`
	StatusRange string `json:"status_range,omitempty"`
}

// ── WebSocket Events ─────────────────────────────────

type EventType string

const (
	EventSessionStart   EventType = "session:start"
	EventSessionDone    EventType = "session:done"
	EventSessionStopped EventType = "session:stopped"
	EventSessionError   EventType = "session:error"
	EventStepStart      EventType = "step:start"
	EventStepDone       EventType = "step:done"
	EventStepError      EventType = "step:error"
	EventStepPaused     EventType = "step:paused"
	EventStepSkipped    EventType = "step:skipped"
	EventThinkStart     EventType = "think:start"
	EventVarExtracted   EventType = "var:extracted"
)

type Event struct {
	Type      EventType `json:"type"`
	SessionID string    `json:"session_id"`
	StepID    string    `json:"step_id,omitempty"`
	Payload   any       `json:"payload,omitempty"`
}

// ── Pause ────────────────────────────────────────────

type PauseResult struct {
	Action        string `json:"action"` // continue | skip | stop
	ModifiedInput any    `json:"modified_input,omitempty"`
}

// ── Store interface ───────────────────────────────────

type Store interface {
	SaveSession(s *Session)
	GetSession(id string) (*Session, bool)
	ListSessions() []*Session
	SaveStep(s *Step)
	LoadRules() []*Rule
	SaveRules(rules []*Rule)
}
