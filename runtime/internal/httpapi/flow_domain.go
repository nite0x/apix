package httpapi

import (
	"github.com/apix/apix/runtime/internal/database"
	"time"
)

// ── Flow definition ──────────────────────────────────

// Flow is the durable, editable process definition. It carries no run state.
type Flow struct {
	ID            string                   `json:"id"`
	ProjectID     string                   `json:"project_id"`
	Name          string                   `json:"name"`
	Description   string                   `json:"description"`
	EnvironmentID *string                  `json:"environment_id"`
	Settings      FlowSettings             `json:"settings"`
	Variables     []FlowVariableDefinition `json:"variables"`
	Steps         []FlowStep               `json:"steps"`
	EditVersion   int64                    `json:"edit_version"`
	CreatedBy     string                   `json:"created_by,omitempty"`
	UpdatedBy     string                   `json:"updated_by,omitempty"`
	CreatedAt     time.Time                `json:"created_at"`
	UpdatedAt     time.Time                `json:"updated_at"`
	ArchivedAt    *time.Time               `json:"archived_at"`
}

type FlowSettings struct {
	StopOnError      bool `json:"stop_on_error"`
	RequestTimeoutMS int  `json:"request_timeout_ms"`
}

func defaultFlowSettings() FlowSettings {
	return FlowSettings{StopOnError: true, RequestTimeoutMS: 60000}
}

type FlowVariableDefinition struct {
	Name         string `json:"name"`
	DefaultValue string `json:"default_value,omitempty"`
	Required     bool   `json:"required"`
	Secret       bool   `json:"secret"`
	Description  string `json:"description,omitempty"`
}

type FlowStep struct {
	ID                 string             `json:"id"`
	Position           int                `json:"position"`
	Type               string             `json:"type"`
	Name               string             `json:"name"`
	Enabled            bool               `json:"enabled"`
	SourceAPIRequestID *string            `json:"source_api_request_id"`
	Request            RequestData        `json:"request"`
	SQL                *database.Command  `json:"sql,omitempty"`
	Service            *ServiceStepConfig `json:"service,omitempty"`
	Config             FlowStepConfig     `json:"config"`
}

type FlowStepConfig struct {
	Assertions      []FlowAssertion `json:"assertions,omitempty"`
	ExpectedStatus  *int            `json:"expected_status,omitempty"`
	ExpectedRows    *int            `json:"expected_rows,omitempty"`
	TimeoutMS       int             `json:"timeout_ms,omitempty"`
	ContinueOnError bool            `json:"continue_on_error"`
	Extractors      []FlowExtractor `json:"extractors"`
}

// FlowAssertion compares a response value as text; body paths use dot notation.
type FlowAssertion struct {
	Source   string `json:"source"`
	Path     string `json:"path,omitempty"`
	Operator string `json:"operator"`
	Expected string `json:"expected,omitempty"`
}

type FlowExtractedVariable struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Secret bool   `json:"secret"`
	Source string `json:"source"`
	Path   string `json:"path,omitempty"`
}

type FlowHTTPResult struct {
	ExtractedVariables []FlowExtractedVariable `json:"extracted_variables"`
}

type ServiceStepConfig struct {
	ServiceID string `json:"service_id"`
	Action    string `json:"action"`
}

type AssertionResult struct {
	Path     string `json:"path,omitempty"`
	Operator string `json:"operator,omitempty"`
	Kind     string `json:"kind"`
	Expected any    `json:"expected"`
	Actual   any    `json:"actual"`
	Passed   bool   `json:"passed"`
}

type FlowExtractor struct {
	Name     string `json:"name"`
	Source   string `json:"source"` // body | header | status
	Path     string `json:"path,omitempty"`
	Scope    string `json:"scope"` // run
	Secret   bool   `json:"secret"`
	Required bool   `json:"required"`
}

// FlowSummary is the lightweight list projection used by the sidebar. It omits
// full step request payloads.
type FlowSummary struct {
	ID            string     `json:"id"`
	ProjectID     string     `json:"project_id"`
	Name          string     `json:"name"`
	Description   string     `json:"description"`
	EnvironmentID *string    `json:"environment_id"`
	StepCount     int        `json:"step_count"`
	EditVersion   int64      `json:"edit_version"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	ArchivedAt    *time.Time `json:"archived_at"`
}

// ── Flow run ─────────────────────────────────────────

type FlowRun struct {
	Variables        map[string]any `json:"variables,omitempty"`
	CleanupError     string         `json:"cleanup_error,omitempty"`
	ID               string         `json:"id"`
	ProjectID        string         `json:"project_id"`
	FlowID           *string        `json:"flow_id"`
	FlowVersion      int64          `json:"flow_version"`
	FlowNameSnapshot string         `json:"flow_name_snapshot"`
	EnvironmentID    *string        `json:"environment_id"`
	TriggerType      string         `json:"trigger_type"`
	Status           string         `json:"status"`
	CurrentStep      int            `json:"current_step"`
	TotalSteps       int            `json:"total_steps"`
	ErrorCode        string         `json:"error_code,omitempty"`
	ErrorMessage     string         `json:"error_message,omitempty"`
	CreatedAt        time.Time      `json:"created_at"`
	StartedAt        *time.Time     `json:"started_at"`
	FinishedAt       *time.Time     `json:"finished_at"`
	Steps            []FlowRunStep  `json:"steps,omitempty"`
}

type FlowRunStep struct {
	Type            string             `json:"type"`
	SQLSnapshot     *database.Command  `json:"sql_snapshot,omitempty"`
	ServiceSnapshot *ServiceStepConfig `json:"service_snapshot,omitempty"`
	Result          any                `json:"result,omitempty"`
	Assertions      []AssertionResult  `json:"assertions,omitempty"`
	ID              string             `json:"id"`
	FlowRunID       string             `json:"flow_run_id"`
	FlowStepID      *string            `json:"flow_step_id"`
	Position        int                `json:"position"`
	NameSnapshot    string             `json:"name_snapshot"`
	RequestSnapshot RequestData        `json:"request_snapshot"`
	Status          string             `json:"status"`
	APIRunID        *string            `json:"api_run_id"`
	ErrorCode       string             `json:"error_code,omitempty"`
	ErrorMessage    string             `json:"error_message,omitempty"`
	StartedAt       *time.Time         `json:"started_at"`
	FinishedAt      *time.Time         `json:"finished_at"`
}

// flowSnapshot is the immutable payload stored in flow_runs.flow_snapshot so a
// run can be replayed/inspected even after the source Flow changes or is
// deleted.
type flowSnapshot struct {
	Name        string                   `json:"name"`
	Description string                   `json:"description"`
	Settings    FlowSettings             `json:"settings"`
	Variables   []FlowVariableDefinition `json:"variables"`
	Steps       []FlowStep               `json:"steps"`
}
