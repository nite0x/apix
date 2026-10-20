package httpapi

import (
	"github.com/apix/apix/runtime/internal/commandrunner"
	"github.com/apix/apix/runtime/internal/mcpclient"
	"time"
)

type CommandTestData struct {
	CommandRequest   *commandrunner.Request `json:"command_request,omitempty"`
	ExpectedExitCode *int                   `json:"expected_exit_code,omitempty"`
}
type CommandRunData struct {
	CommandRequestSnapshot *commandrunner.Request `json:"command_request_snapshot,omitempty"`
	ExpectedExitCode       *int                   `json:"expected_exit_code,omitempty"`
	CommandResult          any                    `json:"command_result,omitempty"`
}

type MCPTestData struct {
	MCPRequest           *mcpclient.Request `json:"mcp_request,omitempty"`
	ExpectedIsError      *bool              `json:"expected_is_error,omitempty"`
	ValidateOutputSchema bool               `json:"validate_output_schema,omitempty"`
}
type MCPRunData struct {
	MCPRequestSnapshot   *mcpclient.Request `json:"mcp_request_snapshot,omitempty"`
	ExpectedIsError      *bool              `json:"expected_is_error,omitempty"`
	ValidateOutputSchema bool               `json:"validate_output_schema,omitempty"`
	MCPResult            any                `json:"mcp_result,omitempty"`
}

// TestCase is an independent input/expectation pair, not a Flow step. The
// request is owned by the case so changing an API definition cannot change it.
type TestCase struct {
	Type string `json:"type"`
	MCPTestData
	CommandTestData
	ID             string          `json:"id"`
	ProjectID      string          `json:"project_id"`
	APIRequestID   *string         `json:"api_request_id,omitempty"`
	Name           string          `json:"name"`
	Description    string          `json:"description"`
	Request        RequestData     `json:"request"`
	ExpectedStatus *int            `json:"expected_status,omitempty"`
	Assertions     []FlowAssertion `json:"assertions"`
	EditVersion    int64           `json:"edit_version"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
}

type TestCounts struct {
	Total      int `json:"total"`
	Running    int `json:"running"`
	Passed     int `json:"passed"`
	Failed     int `json:"failed"`
	Errors     int `json:"errors"`
	Unverified int `json:"unverified"`
}

// Batch lifecycle is explicit. A completed batch may contain failing cases;
// counts describe the test outcome independently of lifecycle state.
type TestBatch struct {
	Source     string        `json:"source,omitempty"`
	ID         string        `json:"id"`
	ProjectID  string        `json:"project_id"`
	Name       string        `json:"name"`
	Status     string        `json:"status"`
	CreatedAt  time.Time     `json:"created_at"`
	FinishedAt *time.Time    `json:"finished_at,omitempty"`
	Counts     TestCounts    `json:"counts"`
	Runs       []TestCaseRun `json:"runs,omitempty"`
}

type TestCaseRun struct {
	ExecutionData
	Type string `json:"type"`
	MCPRunData
	CommandRunData
	ID                   string            `json:"id"`
	BatchID              string            `json:"batch_id"`
	CaseID               *string           `json:"case_id,omitempty"`
	CaseVersion          int64             `json:"case_version"`
	Name                 string            `json:"name"`
	RequestSnapshot      RequestData       `json:"request_snapshot"`
	ExpectedStatus       *int              `json:"expected_status,omitempty"`
	AssertionDefinitions []FlowAssertion   `json:"assertion_definitions"`
	Assertions           []AssertionResult `json:"assertions"`
	APIRunID             *string           `json:"api_run_id,omitempty"`
	Status               string            `json:"status"`
	ErrorMessage         string            `json:"error_message,omitempty"`
	StartedAt            time.Time         `json:"started_at"`
	FinishedAt           *time.Time        `json:"finished_at,omitempty"`
}
