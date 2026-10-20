package mcp

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/apix/apix/runtime/internal/database"
	"github.com/apix/apix/runtime/internal/executionrecord"
	"github.com/apix/apix/runtime/internal/httpapi"
	"github.com/apix/apix/runtime/internal/journal"
	"github.com/apix/apix/runtime/internal/localservice"
	"github.com/mark3labs/mcp-go/mcp"
)

type toolHandler func(context.Context, map[string]any) (any, error)

func object(properties map[string]any, required ...string) map[string]any {
	schema := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}
func str() map[string]any                  { return map[string]any{"type": "string"} }
func integer() map[string]any              { return map[string]any{"type": "integer"} }
func boolean() map[string]any              { return map[string]any{"type": "boolean"} }
func array(items any) map[string]any       { return map[string]any{"type": "array", "items": items} }
func enum(values ...string) map[string]any { return map[string]any{"type": "string", "enum": values} }

func (s *Server) addCapability(name, description string, schema map[string]any, history *journal.Store, record bool, handler toolHandler) {
	data, _ := json.Marshal(schema)
	tool := mcp.NewTool(name, mcp.WithDescription(description), mcp.WithRawInputSchema(data))
	tool.InputSchema = mcp.ToolInputSchema{}
	s.mcp.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args, ok := req.Params.Arguments.(map[string]any)
		if !ok {
			if req.Params.Arguments == nil {
				args = map[string]any{}
			} else {
				return mcp.NewToolResultError("arguments must be an object"), nil
			}
		}
		// Validate basic required fields here as MCP schemas are discovery metadata;
		// individual capabilities validate their full command semantics.
		if required, ok := schema["required"].([]string); ok {
			for _, key := range required {
				if args[key] == nil {
					return mcp.NewToolResultError(key + " is required"), nil
				}
			}
		}
		operationID := ""
		if record && history != nil {
			var err error
			operationID, err = history.Begin(ctx, name)
			if err != nil {
				return mcp.NewToolResultError("cannot persist operation: " + err.Error()), nil
			}
		}
		out, err := handler(ctx, args)
		if operationID != "" {
			if persistErr := history.Finish(operationID, out, err); persistErr != nil && err == nil {
				err = fmt.Errorf("operation completed but recording failed: %w", persistErr)
			}
		}
		if err != nil {
			result := mcp.NewToolResultStructuredOnly(map[string]any{"operation_id": operationID, "error": err.Error(), "result": out})
			result.IsError = true
			return result, nil
		}
		if operationID != "" {
			return mcp.NewToolResultStructuredOnly(map[string]any{"operation_id": operationID, "result": out}), nil
		}
		return mcp.NewToolResultStructuredOnly(out), nil
	})
}

func decode(input any, target any) error {
	data, err := json.Marshal(input)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}
func textArg(args map[string]any, key string) string { v, _ := args[key].(string); return v }
func numberArg(args map[string]any, key string) (int64, error) {
	v := args[key]
	if v == nil {
		return 0, nil
	}
	switch n := v.(type) {
	case float64:
		if n != float64(int64(n)) {
			return 0, fmt.Errorf("%s must be an integer", key)
		}
		return int64(n), nil
	case int:
		return int64(n), nil
	case int64:
		return n, nil
	}
	return 0, fmt.Errorf("%s must be an integer", key)
}

func (s *Server) RegisterCapabilities(http *httpapi.HTTPService, db *database.Service, services *localservice.Service, history *journal.Store) {
	s.registerTestTools(http, history)
	connection := object(map[string]any{"id": str(), "name": str(), "type": enum("mysql", "postgresql", "hologres"), "host": str(), "port": integer(), "database": str(), "username": str(), "password": str(), "ssl_mode": enum("disable", "prefer", "require", "verify-full")}, "name", "host", "database", "username")
	sqlCommand := object(map[string]any{"batch_id": str(), "connection_id": str(), "mode": enum("query", "exec"), "sql": str(), "params": array(map[string]any{}), "timeout_ms": integer(), "max_rows": integer()}, "connection_id", "mode", "sql")
	service := object(map[string]any{"id": str(), "name": str(), "work_dir": str(), "command": str(), "args": array(str()), "health_url": str(), "startup_timeout_ms": integer()}, "name", "work_dir", "command", "health_url")
	add := func(name, desc string, schema map[string]any, record bool, handler toolHandler) {
		s.addCapability(name, desc, schema, history, record, handler)
	}
	add("save_database_connection", "Save a MySQL, PostgreSQL or Hologres connection. New connections default to mysql; omitted type preserves the existing driver on updates. Default ports: mysql 3306, postgresql 5432, hologres 80. PostgreSQL/Hologres ssl_mode defaults to prefer. Passwords are encrypted locally and never returned. Omit password on updates to preserve it; use an empty string for an empty password.", object(map[string]any{"connection": connection}, "connection"), true, func(ctx context.Context, a map[string]any) (any, error) {
		var c database.ConnectionInput
		if err := decode(a["connection"], &c); err != nil {
			return nil, err
		}
		return db.SaveConnection(ctx, c)
	})
	add("list_database_connections", "List saved MySQL connection IDs without credentials.", object(map[string]any{}), false, func(ctx context.Context, a map[string]any) (any, error) {
		v, err := db.ListConnections(ctx)
		return map[string]any{"items": v}, err
	})
	add("test_database_connection", "Check that a saved MySQL connection can connect.", object(map[string]any{"connection_id": str()}, "connection_id"), true, func(ctx context.Context, a map[string]any) (any, error) {
		err := db.TestConnection(ctx, textArg(a, "connection_id"))
		return map[string]any{"connected": err == nil}, err
	})
	add("delete_database_connection", "Remove a saved connection from Apix. Does not delete the remote database or its data. Flows referencing this connection must be updated before running again.", object(map[string]any{"connection_id": str()}, "connection_id"), true, func(ctx context.Context, a map[string]any) (any, error) {
		err := db.DeleteConnection(ctx, textArg(a, "connection_id"))
		return map[string]any{"deleted": err == nil}, err
	})
	add("execute_sql", "Execute a parameterized statement using the saved connection type (MySQL, PostgreSQL or Hologres). query returns rows, exec returns rows_affected. Bind params with ? for MySQL, or native $1, $2 placeholders for PostgreSQL/Hologres. Truncated results have row_count=-1.", object(map[string]any{"command": sqlCommand, "batch_id": str()}, "command"), true, func(ctx context.Context, a map[string]any) (any, error) {
		var c database.Command
		if err := decode(a["command"], &c); err != nil {
			return nil, err
		}
		if id := textArg(a, "batch_id"); id != "" {
			c.BatchID = id
		}
		return db.Execute(ctx, c)
	})
	add("save_service", "Save a local service. command is an executable; args are separate arguments. health_url must become healthy before startup succeeds.", object(map[string]any{"service": service}, "service"), true, func(ctx context.Context, a map[string]any) (any, error) {
		var d localservice.Definition
		if err := decode(a["service"], &d); err != nil {
			return nil, err
		}
		return services.PutDefinition(ctx, d)
	})
	add("list_services", "List saved local service definitions.", object(map[string]any{}), false, func(ctx context.Context, a map[string]any) (any, error) {
		v, err := services.ListDefinitions(ctx)
		return map[string]any{"items": v}, err
	})
	serviceID := object(map[string]any{"service_id": str()}, "service_id")
	add("start_service", "Reuse an already running saved service first, including healthy external services. Otherwise start it under manual ownership and wait for health. started=false means reused; ownership is preserved. Flow cleans up only processes it starts.", object(map[string]any{"service_id": str(), "batch_id": str()}, "service_id"), true, func(ctx context.Context, a map[string]any) (any, error) {
		ctx = executionrecord.WithBatch(ctx, textArg(a, "batch_id"))
		return services.Start(ctx, textArg(a, "service_id"), "manual")
	})
	add("stop_service", "Stop a manually started service and its process tree. Flow-owned services are stopped through cancel_flow_run or Flow service steps.", object(map[string]any{"service_id": str(), "batch_id": str()}, "service_id"), true, func(ctx context.Context, a map[string]any) (any, error) {
		ctx = executionrecord.WithBatch(ctx, textArg(a, "batch_id"))
		return services.Stop(ctx, textArg(a, "service_id"), "manual")
	})
	add("get_service_status", "Get managed service status and process ownership.", serviceID, false, func(ctx context.Context, a map[string]any) (any, error) {
		return services.Status(ctx, textArg(a, "service_id"))
	})
	add("get_service_details", "Inspect a saved service's command, arguments, working directory, status, ownership, live health check and latest 100 captured log lines. External services have no managed PID or captured stdout/stderr.", serviceID, false, func(ctx context.Context, a map[string]any) (any, error) {
		return services.Details(ctx, textArg(a, "service_id"))
	})
	add("get_service_logs", "Read bounded, persistent service stdout/stderr logs after a sequence cursor.", object(map[string]any{"service_id": str(), "after": integer()}, "service_id"), false, func(ctx context.Context, a map[string]any) (any, error) {
		after, err := numberArg(a, "after")
		if err != nil {
			return nil, err
		}
		v, err := services.Logs(ctx, textArg(a, "service_id"), after)
		return map[string]any{"items": v}, err
	})
	add("save_flow", "Create or update a durable test Flow. Omit id to create; updates require edit_version from get_flow. Steps execute sequentially; config.phase=finally adds explicit cleanup after success, failure or cancellation. Reference named outputs as {{steps.STEP_ID.outputs.NAME}}. Services started by the run are always cleaned up. enabled defaults true, stop_on_error defaults true.", object(map[string]any{"flow": flowSchema(sqlCommand)}, "flow"), true, func(ctx context.Context, a map[string]any) (any, error) {
		var f httpapi.Flow
		f.Settings.StopOnError = true
		if err := decode(a["flow"], &f); err != nil {
			return nil, err
		}
		raw, _ := a["flow"].(map[string]any)
		if steps, ok := raw["steps"].([]any); ok {
			for i, v := range steps {
				if item, ok := v.(map[string]any); ok && i < len(f.Steps) {
					if _, present := item["enabled"]; !present {
						f.Steps[i].Enabled = true
					}
				}
			}
		}
		return http.SaveFlow(f)
	})
	add("list_flows", "List saved test flows.", object(map[string]any{"project_id": str()}), false, func(ctx context.Context, a map[string]any) (any, error) {
		v, err := http.ListFlows(textArg(a, "project_id"))
		return map[string]any{"items": v}, err
	})
	flowID := object(map[string]any{"flow_id": str()}, "flow_id")
	add("get_flow", "Get a saved Flow including its edit_version and typed steps.", flowID, false, func(ctx context.Context, a map[string]any) (any, error) { return http.GetFlow(textArg(a, "flow_id")) })
	add("run_flow", "Start an asynchronous test run and immediately return its id. Poll get_flow_run for steps, assertions and cleanup outcome. Closing the MCP connection does not cancel the run.", object(map[string]any{"flow_id": str(), "expected_flow_version": integer(), "variables": map[string]any{"type": "object", "additionalProperties": str()}}, "flow_id"), true, func(ctx context.Context, a map[string]any) (any, error) {
		version, err := numberArg(a, "expected_flow_version")
		if err != nil {
			return nil, err
		}
		vars := map[string]string{}
		if a["variables"] != nil {
			if err := decode(a["variables"], &vars); err != nil {
				return nil, err
			}
		}
		return http.StartFlow(textArg(a, "flow_id"), version, vars, "ai")
	})
	runID := object(map[string]any{"run_id": str()}, "run_id")
	add("get_flow_run", "Get a run's current state, typed step outcomes, assertion expected/actual values, and cleanup_error. Only terminal states mean cleanup has finished.", runID, false, func(ctx context.Context, a map[string]any) (any, error) { return http.GetFlowRun(textArg(a, "run_id")) })
	add("get_api_run", "Read the persisted HTTP request/response and transport error. Pass a Flow step's api_run_id or send_request's run_id.", object(map[string]any{"run_id": str()}, "run_id"), false, func(ctx context.Context, a map[string]any) (any, error) { return http.GetAPIRun(textArg(a, "run_id")) })
	add("list_flow_runs", "List recent runs for a saved flow.", object(map[string]any{"flow_id": str(), "limit": integer()}, "flow_id"), false, func(ctx context.Context, a map[string]any) (any, error) {
		limit, err := numberArg(a, "limit")
		if err != nil {
			return nil, err
		}
		v, err := http.ListFlowRuns(textArg(a, "flow_id"), int(limit))
		return map[string]any{"items": v}, err
	})
	add("cancel_flow_run", "Request cancellation. Poll get_flow_run until cancelled; service cleanup completes before the terminal state.", runID, true, func(ctx context.Context, a map[string]any) (any, error) {
		return http.CancelFlowRun(textArg(a, "run_id"))
	})
	add("resume_flow_step", "Resolve an existing pause rule without a page. The step must belong to the specified run.", object(map[string]any{"run_id": str(), "step_id": str(), "action": enum("continue", "skip", "stop")}, "run_id", "step_id", "action"), true, func(ctx context.Context, a map[string]any) (any, error) {
		return http.ResumeFlowStep(textArg(a, "run_id"), textArg(a, "step_id"), textArg(a, "action"))
	})
	add("get_run_events", "Read persistent structured runtime events. Use after as the last sequence received; run_id can be a Flow id or operation id.", object(map[string]any{"run_id": str(), "after": integer(), "limit": integer()}), false, func(ctx context.Context, a map[string]any) (any, error) {
		after, err := numberArg(a, "after")
		if err != nil {
			return nil, err
		}
		limit, err := numberArg(a, "limit")
		if err != nil {
			return nil, err
		}
		v, err := history.Events(ctx, textArg(a, "run_id"), after, int(limit))
		return map[string]any{"items": v}, err
	})
	add("get_operation", "Retrieve a persisted standalone MCP operation's result or error.", object(map[string]any{"operation_id": str()}, "operation_id"), false, func(ctx context.Context, a map[string]any) (any, error) {
		return history.Get(ctx, textArg(a, "operation_id"))
	})
	add("resume_request_step", "Resume a paused send_request call by step ID; useful when a legacy HTTP pause rule fires.", object(map[string]any{"step_id": str(), "action": enum("continue", "skip", "stop")}, "step_id", "action"), true, func(ctx context.Context, a map[string]any) (any, error) {
		err := s.executor.Resume(textArg(a, "step_id"), textArg(a, "action"), nil)
		return map[string]any{"accepted": err == nil}, err
	})
}

func flowSchema(sqlCommand map[string]any) map[string]any {
	kv := object(map[string]any{"id": str(), "name": str(), "value": str(), "enabled": boolean()}, "name", "value")
	request := object(map[string]any{"method": str(), "url": str(), "query_params": array(kv), "headers": array(kv), "body_type": str(), "body": str(), "auth_config": map[string]any{"type": "object"}}, "method", "url")
	extractor := object(map[string]any{"name": str(), "source": enum("body", "header", "status", "rows", "row_count", "rows_affected"), "path": str(), "scope": enum("run"), "secret": boolean(), "required": boolean()}, "name", "source", "scope")
	assertion := object(map[string]any{"source": enum("body", "header", "status", "rows", "row_count", "rows_affected"), "path": str(), "operator": enum("equals", "not_equals", "contains", "exists"), "expected": str()}, "source", "operator")
	config := object(map[string]any{"phase": enum("finally"), "failure_policy": enum("stop", "continue"), "skip_if_missing_outputs": boolean(), "assertions": array(assertion), "timeout_ms": integer(), "continue_on_error": boolean(), "expected_status": integer(), "expected_rows": integer(), "extractors": array(extractor)})
	step := object(map[string]any{"id": str(), "position": integer(), "type": enum("http", "sql", "service"), "name": str(), "enabled": boolean(), "source_api_request_id": map[string]any{"type": []string{"string", "null"}}, "request": request, "sql": sqlCommand, "service": object(map[string]any{"service_id": str(), "action": enum("start", "stop")}, "service_id", "action"), "config": config}, "type", "name")
	variable := object(map[string]any{"name": str(), "default_value": str(), "required": boolean(), "secret": boolean(), "description": str()}, "name")
	return object(map[string]any{"id": str(), "project_id": str(), "name": str(), "description": str(), "edit_version": integer(), "environment_id": map[string]any{"type": []string{"string", "null"}}, "settings": object(map[string]any{"stop_on_error": boolean(), "request_timeout_ms": integer()}), "variables": array(variable), "steps": array(step)}, "name", "steps")
}
