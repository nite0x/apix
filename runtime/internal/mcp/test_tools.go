package mcp

import (
	"context"

	"github.com/apix/apix/runtime/internal/httpapi"
	"github.com/apix/apix/runtime/internal/journal"
)

func (s *Server) registerTestTools(http *httpapi.HTTPService, history *journal.Store) {
	add := func(name, desc string, schema map[string]any, handler toolHandler) {
		s.addCapability(name, desc, schema, history, false, handler)
	}
	batchID := object(map[string]any{"batch_id": str()}, "batch_id")
	caseID := object(map[string]any{"case_id": str()}, "case_id")
	project := object(map[string]any{"project_id": str()})
	assertion := object(map[string]any{"source": enum("status", "header", "body", "structuredContent", "text", "isError", "result", "exit_code", "stdout", "stderr"), "path": str(), "operator": enum("equals", "not_equals", "contains", "exists"), "expected": str()}, "source", "operator")
	pair := object(map[string]any{"id": str(), "name": str(), "value": str(), "enabled": boolean()}, "name", "value", "enabled")
	request := object(map[string]any{"method": enum("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"), "url": str(), "headers": array(pair), "query_params": array(pair), "body_type": str(), "body": str(), "auth_config": map[string]any{"type": "object"}}, "method", "url")
	definition := object(map[string]any{"id": str(), "project_id": str(), "api_request_id": str(), "type": enum("http", "mcp", "command"), "command_request": object(map[string]any{"program": str(), "args": array(str()), "work_dir": str(), "env": map[string]any{"type": "object", "additionalProperties": str()}, "stdin": str(), "timeout_seconds": integer()}, "program"), "expected_exit_code": integer(), "mcp_request": object(map[string]any{"server_id": str(), "tool_name": str(), "arguments": map[string]any{"type": "object"}}, "server_id", "tool_name"), "expected_is_error": boolean(), "validate_output_schema": boolean(), "name": str(), "description": str(), "request": request, "expected_status": integer(), "assertions": array(assertion), "edit_version": integer()}, "name")
	add("begin_test_batch", "Begin one explicit HTTP, SQL, service, MCP or command testing task and return its batch id. Reuse batch_id for all related send_request, execute_sql, start_service, stop_service or run_test_case calls, including different endpoints and input variants. Do not create a Flow for independent API tests. Finish only after all calls return.", object(map[string]any{"name": str(), "project_id": str()}, "name"), func(ctx context.Context, a map[string]any) (any, error) {
		return http.BeginTestBatch(textArg(a, "project_id"), textArg(a, "name"))
	})
	add("list_test_batches", "List the latest 100 test batches with pass/fail/error/unverified counts.", project, func(ctx context.Context, a map[string]any) (any, error) {
		items, err := http.ListTestBatches(textArg(a, "project_id"))
		return map[string]any{"items": items}, err
	})
	add("get_test_batch", "Read a batch and its named case attempts, input snapshots, assertion expected/actual values and api_run_id links. HTTP success alone does not mean a test passed.", batchID, func(ctx context.Context, a map[string]any) (any, error) {
		return http.GetTestBatch(textArg(a, "batch_id"))
	})
	add("finish_test_batch", "Close a test batch after all test calls return. Refuses while a case is running or paused. A completed batch can contain failed tests; inspect its counts.", batchID, func(ctx context.Context, a map[string]any) (any, error) {
		return http.FinishTestBatch(textArg(a, "batch_id"))
	})
	add("save_test_case", "Save a reusable independent request/input and its expected status or response assertions. Each input variant is a separate named case. Updates require id and edit_version; historical attempts keep their original snapshots. Use {{variables}} for credentials in headers/body instead of saving live secrets.", object(map[string]any{"test_case": definition}, "test_case"), func(ctx context.Context, a map[string]any) (any, error) {
		var item httpapi.TestCase
		if err := decode(a["test_case"], &item); err != nil {
			return nil, err
		}
		return http.SaveTestCase(item)
	})
	add("list_test_cases", "List all active saved HTTP, MCP or command test cases for reuse; use list_resource_lifecycle to list archived cases.", project, func(ctx context.Context, a map[string]any) (any, error) {
		items, err := http.ListTestCases(textArg(a, "project_id"))
		return map[string]any{"items": items}, err
	})
	add("get_test_case", "Read a saved test case and its current edit_version.", caseID, func(ctx context.Context, a map[string]any) (any, error) {
		return http.GetTestCase(textArg(a, "case_id"))
	})
	add("archive_test_case", "Remove a case from the reusable case list while preserving its execution history.", caseID, func(ctx context.Context, a map[string]any) (any, error) {
		err := http.ArchiveTestCase(textArg(a, "case_id"))
		return map[string]any{"archived": err == nil}, err
	})
	add("run_test_case", "Run a saved case in an explicit batch, or supply a temporary test_case instead of case_id. Each call creates an independent attempt; retries never overwrite history. Pass variables explicitly; cases do not inherit tokens or IDs from previous cases. For command cases, program and args are separate; no implicit shell. Use bash/python3/node with a script path, or explicit interpreter stdin. Read test_status (passed, failed, error, unverified).", object(map[string]any{"batch_id": str(), "case_id": str(), "test_case": definition, "variables": map[string]any{"type": "object", "additionalProperties": str()}}, "batch_id"), func(ctx context.Context, a map[string]any) (any, error) {
		var in httpapi.RunTestInput
		if err := decode(a, &in); err != nil {
			return nil, err
		}
		return http.RunTest(ctx, in, func(ctx context.Context, input map[string]any) (any, error) {
			return s.executor.Execute(ctx, in.BatchID, "API testing", "send_request", input)
		})
	})
}
