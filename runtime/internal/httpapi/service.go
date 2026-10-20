package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/apix/apix/runtime/internal/commandrunner"
	"github.com/apix/apix/runtime/internal/core"
	"github.com/apix/apix/runtime/internal/mcpclient"
	"github.com/mark3labs/mcp-go/mcp"
)

type HTTPService struct {
	commands          *commandrunner.Runner
	mcpClient         *mcpclient.Service
	db                *sql.DB
	repo              *repository
	execution         *executionService
	flow              *flowService
	testRunner        func(context.Context, map[string]any) (any, error)
	testBatchFinished func(*TestBatch)
}

func (s *HTTPService) SetMCPClient(client *mcpclient.Service) { s.mcpClient = client }

func (s *HTTPService) SetTestBatchFinished(finish func(*TestBatch)) { s.testBatchFinished = finish }

// SetTestRunner lets REST tests share the MCP executor and its pause rules.
func (s *HTTPService) SetTestRunner(runner func(context.Context, map[string]any) (any, error)) {
	s.testRunner = runner
}

// SendRequestResult is returned to MCP clients after a request completes.
// The api_runs record remains the durable source of truth; this result gives
// an AI the same immediate response without requiring a follow-up lookup.
type SendRequestResult struct {
	CommandResult any               `json:"command_result,omitempty"`
	Type          string            `json:"type,omitempty"`
	MCPResult     any               `json:"mcp_result,omitempty"`
	BatchID       string            `json:"batch_id,omitempty"`
	TestRunID     string            `json:"test_run_id,omitempty"`
	CaseID        *string           `json:"case_id,omitempty"`
	TestStatus    string            `json:"test_status,omitempty"`
	TestError     string            `json:"test_error,omitempty"`
	Assertions    []AssertionResult `json:"assertions,omitempty"`
	RunID         string            `json:"run_id"`
	Status        *int              `json:"status,omitempty"`
	Body          any               `json:"body"`
	Headers       any               `json:"headers,omitempty"`
	DurationMS    int64             `json:"duration_ms"`
	Truncated     bool              `json:"truncated"`
}

func (r SendRequestResult) RunReference() string { return r.RunID }
func (r SendRequestResult) HTTPStatus() int {
	if r.Status == nil {
		return 0
	}
	return *r.Status
}

var sendRequestOutputSchema = json.RawMessage(`{
  "type": "object",
  "required": ["run_id", "body", "duration_ms", "truncated"],
  "properties": {
    "run_id": {"type": "string"},
    "status": {"type": "integer"},
    "body": {},
    "headers": {},
    "duration_ms": {"type": "integer"},
    "truncated": {"type": "boolean"},
    "batch_id": {"type": "string"},
    "test_run_id": {"type": "string"},
    "case_id": {"type": "string"},
    "test_status": {"type": "string"},
    "test_error": {"type": "string"},
    "assertions": {"type": "array", "items": {"type": "object"}}
  }
}`)

func New() *HTTPService {
	return &HTTPService{commands: commandrunner.New()}
}

func (s *HTTPService) initRepositories() {
	s.repo = newRepository(s.db)
	s.execution = newExecutionService(s.repo)
	s.flow = newFlowService(s.repo, s.execution)
}

// SetRuleEngine lets durable Flow runs honor the same Pause Rules as MCP runs.
func (s *HTTPService) SetRuleEngine(rules *core.RuleEngine) {
	if s.flow != nil {
		s.flow.setRuleEngine(rules)
	}
}

func (s *HTTPService) ExecutionTools() []ExecutionToolDef {
	return []ExecutionToolDef{
		{
			Tool: mcp.NewTool("send_request",
				mcp.WithDescription(`Send an HTTP request to any URL and return the response.
Use this for all HTTP API calls.
Supports {{variable}} syntax in url and body — variables are auto-injected from previous responses.
For sequences: first GET/list to discover IDs, then use them in subsequent calls.
For API testing: call begin_test_batch first, then pass batch_id, case_name and expected_status/assertions for every input variant. Finish the batch after all calls return. Independent input tests do not require a Flow.`),
				mcp.WithString("method",
					mcp.Required(),
					mcp.Description("HTTP method: GET, POST, PUT, PATCH, DELETE"),
				),
				mcp.WithString("url",
					mcp.Required(),
					mcp.Description("Full URL including query params. Supports {{variable}} syntax."),
				),
				mcp.WithString("body",
					mcp.Description("JSON request body (optional)"),
				),
				mcp.WithObject("headers",
					mcp.Description("Additional request headers (optional)"),
				),
				mcp.WithString("session_id",
					mcp.Description("Session ID to group related calls. Use the same ID for a task sequence."),
				),
				mcp.WithString("task",
					mcp.Description("Brief description of the overall task (used for session labeling)"),
				),
				mcp.WithString("batch_id", mcp.Description("Explicit test batch from begin_test_batch. Related test calls must reuse it. Use a new batch for each new test task.")),
				mcp.WithString("case_name", mcp.Description("What this input is testing, for example missing email. Requires batch_id.")),
				mcp.WithNumber("expected_status", mcp.Description("Expected HTTP status (100–599). A matching 4xx is a passing test. Requires batch_id.")),
				mcp.WithArray("assertions", mcp.Description("Response assertions: {source: body|header|status, path: dot path or header name, operator: equals|not_equals|contains|exists, expected: string}. Requires batch_id.")),
				mcp.WithRawOutputSchema(sendRequestOutputSchema),
			),
			ExtractInput: func(args map[string]any) (input map[string]any, sessionID, task string) {
				sessionID, _ = args["session_id"].(string)
				task, _ = args["task"].(string)
				input = map[string]any{
					"method": args["method"],
					"url":    args["url"],
				}
				if body, ok := args["body"]; ok {
					input["body"] = body
				}
				if headers, ok := args["headers"]; ok {
					input["headers"] = headers
				}
				return
			},
		},
	}
}

func (s *HTTPService) Execute(ctx context.Context, tool string, input map[string]any, vars *core.Variables) (any, error) {
	switch tool {
	case "send_request":
		method, _ := input["method"].(string)
		requestURL, _ := input["url"].(string)
		body, _ := input["body"].(string)
		request := RequestData{Method: method, URL: requestURL, Body: body}
		if body != "" {
			request.BodyType = "json"
		}
		if headers, ok := input["headers"].(map[string]any); ok {
			for name, value := range headers {
				if text, ok := value.(string); ok {
					request.Headers = append(request.Headers, KeyValue{Name: name, Value: text, Enabled: true})
				}
			}
		}
		if testRequest, ok := input["test_request"].(RequestData); ok {
			request = testRequest
			request.Method, request.URL, request.Body = method, requestURL, body
			// Independent tests must not inherit IDs/tokens extracted by another
			// case. Only caller-supplied variables are used for this execution.
			vars = core.NewVariables()
			if values, ok := input["test_variables"].(map[string]string); ok {
				for name, value := range values {
					vars.Session[name] = &core.Variable{Name: name, Value: value}
				}
			}
		}
		run, err := s.execution.Run(ctx, RunCommand{
			ProjectID:     inputString(input, "project_id"),
			SessionID:     inputString(input, "session_id"),
			StepID:        inputString(input, "step_id"),
			TriggerType:   valueOr(inputString(input, "trigger_type"), "ai"),
			InlineRequest: &request,
		}, vars)
		if run == nil {
			return nil, err
		}
		result := SendRequestResult{
			RunID:      run.ID,
			Status:     run.ResponseStatus,
			Body:       run.ResponseBody,
			Headers:    run.ResponseHeaders,
			DurationMS: run.DurationMS,
			Truncated:  run.ResponseTruncated,
		}
		if input["test_request"] != nil && err != nil {
			err = fmt.Errorf("%s", redactExecutionError(err.Error()))
		}
		return result, err
	}
	return nil, fmt.Errorf("unknown HTTP tool %q", tool)
}

func inputString(input map[string]any, key string) string {
	value, _ := input[key].(string)
	return value
}

// ExtractVars automatically pulls common variables from responses for later steps.
func (s *HTTPService) ExtractVars(tool string, output any) map[string]*core.Variable {
	vars := make(map[string]*core.Variable)
	if tool != "send_request" {
		return vars
	}
	result, ok := output.(SendRequestResult)
	if !ok {
		return vars
	}
	body, ok := result.Body.(map[string]any)
	if !ok {
		return vars
	}
	if token, ok := body["token"].(string); ok && token != "" {
		vars["token"] = &core.Variable{
			Name:   "token",
			Value:  token,
			Scope:  "global",
			Source: "send_request",
		}
	}
	if id, ok := body["id"]; ok {
		vars["lastId"] = &core.Variable{
			Name:   "lastId",
			Value:  id,
			Scope:  "session",
			Source: "send_request",
		}
	}
	return vars
}
