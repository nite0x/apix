package mcp_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIndependentAPITestingThroughMCP(t *testing.T) {
	c := setupMVP(t)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("invalid") == "1" {
			w.WriteHeader(400)
		}
		fmt.Fprint(w, `{"error":{"code":"invalid"},"token":"test-only-token","id":1}`)
	}))
	defer target.Close()
	b := c.call(t, "begin_test_batch", map[string]any{"name": "用户接口校验"}, false)
	id := b["id"].(string)
	out := c.call(t, "send_request", map[string]any{"batch_id": id, "case_name": "无效参数", "method": "GET", "url": target.URL + "?invalid=1", "expected_status": 400, "assertions": []any{map[string]any{"source": "body", "path": "error.code", "operator": "equals", "expected": "invalid"}}}, false)
	if out["test_status"] != "passed" || out["batch_id"] != id || out["run_id"] == nil || out["test_run_id"] == nil {
		t.Fatalf("inline MCP result: %#v", out)
	}
	item := c.call(t, "save_test_case", map[string]any{"test_case": map[string]any{"name": "正常参数", "request": map[string]any{"method": "GET", "url": target.URL}, "expected_status": 200}}, false)
	caseID := item["id"].(string)
	for i := 0; i < 2; i++ {
		r := c.call(t, "run_test_case", map[string]any{"batch_id": id, "case_id": caseID}, false)
		if r["test_status"] != "passed" || r["case_id"] != caseID {
			t.Fatalf("saved case: %#v", r)
		}
	}
	batch := c.call(t, "finish_test_batch", map[string]any{"batch_id": id}, false)
	if batch["status"] != "completed" || batch["counts"].(map[string]any)["passed"] != float64(3) || len(batch["runs"].([]any)) != 3 {
		t.Fatalf("batch summary: %#v", batch)
	}
	session, ok := c.executor.GetSession(id)
	if !ok || session.Status != "done" || len(session.Steps) != 3 || len(session.Variables.Global) != 0 || len(session.Variables.Session) != 0 {
		t.Fatalf("test session lifecycle or variable isolation failed: %#v", session)
	}
	c.call(t, "send_request", map[string]any{"batch_id": id, "case_name": "closed", "method": "GET", "url": target.URL}, true)
	c.call(t, "send_request", map[string]any{"case_name": "missing batch", "method": "GET", "url": target.URL}, true)
	c.call(t, "run_test_case", map[string]any{"batch_id": id, "case_id": caseID}, true)
	// Saved definitions and execution history remain separate.
	c.call(t, "archive_test_case", map[string]any{"case_id": caseID}, false)
	history := c.call(t, "get_test_batch", map[string]any{"batch_id": id}, false)
	if len(history["runs"].([]any)) != 3 {
		t.Fatal("archiving lost history")
	}
}
