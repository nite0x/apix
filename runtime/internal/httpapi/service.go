package httpapi

import (
	"context"
	"database/sql"

	"github.com/apix/apix/runtime/internal/core"
	"github.com/mark3labs/mcp-go/mcp"
)

type HTTPService struct {
	db        *sql.DB
	repo      *repository
	execution *executionService
	flow      *flowService
}

func New() *HTTPService {
	return &HTTPService{}
}

func (s *HTTPService) initRepositories() {
	s.repo = newRepository(s.db)
	s.execution = newExecutionService(s.repo)
	s.flow = newFlowService(s.repo, s.execution)
}

// SetHub wires the WebSocket hub so Flow runs can broadcast flow_run.* events.
// Call after MigrateSchema.
func (s *HTTPService) SetHub(hub *core.Hub) {
	if s.flow != nil {
		s.flow.setHub(hub)
	}
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
For sequences: first GET/list to discover IDs, then use them in subsequent calls.`),
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
		run, err := s.execution.Run(ctx, RunCommand{
			SessionID:     inputString(input, "session_id"),
			StepID:        inputString(input, "step_id"),
			TriggerType:   "ai",
			InlineRequest: &request,
		}, vars)
		if run == nil {
			return nil, err
		}
		var status any
		if run.ResponseStatus != nil {
			status = *run.ResponseStatus
		}
		result := map[string]any{
			"run_id":   run.ID,
			"status":   status,
			"body":     run.ResponseBody,
			"duration": run.DurationMS,
			"headers":  run.ResponseHeaders,
		}
		return result, err
	}
	return nil, nil
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
	result, ok := output.(map[string]any)
	if !ok {
		return vars
	}
	body, ok := result["body"].(map[string]any)
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
