package mcp_test

import (
	"strings"
	"testing"
)

func TestCommandCasesThroughApixMCP(t *testing.T) {
	c := setupMVP(t)
	batch := c.call(t, "begin_test_batch", map[string]any{"name": "command through MCP"}, false)
	definition := map[string]any{"type": "command", "name": "python stdin", "command_request": map[string]any{"program": "python3", "args": []any{"-"}, "stdin": "import os,json\nprint(json.dumps({'ok':True,'token':os.environ['API_TOKEN']}))\n", "env": map[string]any{"API_TOKEN": "{{token}}"}, "timeout_seconds": 3}, "expected_exit_code": 0, "assertions": []any{map[string]any{"source": "stdout", "path": "ok", "operator": "equals", "expected": "true"}}}
	item := c.call(t, "save_test_case", map[string]any{"test_case": definition}, false)
	out := c.call(t, "run_test_case", map[string]any{"batch_id": batch["id"], "case_id": item["id"], "variables": map[string]any{"token": "runtime-command-secret"}}, false)
	if out["type"] != "command" || out["test_status"] != "passed" {
		t.Fatal(out)
	}
	result := out["command_result"].(map[string]any)
	if strings.Contains(result["stdout"].(string), "runtime-command-secret") {
		t.Fatal("MCP returned a command secret")
	}
	history := c.call(t, "finish_test_batch", map[string]any{"batch_id": batch["id"]}, false)
	if history["counts"].(map[string]any)["passed"] != float64(1) {
		t.Fatal(history)
	}
}
