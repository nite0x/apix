package mcp_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFlowQualifiedOutputsAndFinallyThroughMCP(t *testing.T) {
	c := setupMVP(t)
	cleaned := make(chan struct{}, 1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/create":
			fmt.Fprint(w, `{"id":42,"name":"actual"}`)
		case "/read/42":
			fmt.Fprint(w, "{}")
		case "/cleanup/42":
			cleaned <- struct{}{}
		default:
			t.Errorf("output reference not resolved: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer target.Close()
	producer := requestStep(target.URL+"/create", 200)
	producer["id"] = "producer"
	producer["config"] = map[string]any{
		"failure_policy": "continue",
		"assertions":     []any{map[string]any{"source": "body", "path": "name", "operator": "equals", "expected": "expected"}},
		"extractors":     []any{map[string]any{"name": "id", "source": "body", "path": "id", "scope": "run", "required": true}},
	}
	read := requestStep(target.URL+"/read/{{steps.producer.outputs.id}}", 200)
	cleanup := requestStep(target.URL+"/cleanup/{{steps.producer.outputs.id}}", 200)
	cleanup["config"] = map[string]any{"phase": "finally", "skip_if_missing_outputs": true, "expected_status": 200}
	id := c.save(t, []any{producer, read, cleanup})
	final := c.wait(t, c.run(t, id))
	steps := final["steps"].([]any)
	if final["status"] != "failed" || final["error_code"] != "assertion_failed" ||
		steps[1].(map[string]any)["status"] != "succeeded" ||
		steps[2].(map[string]any)["status"] != "succeeded" ||
		steps[2].(map[string]any)["phase"] != "finally" {
		t.Fatalf("MCP Flow contract lost config/results: %#v", final)
	}
	select {
	case <-cleaned:
	default:
		t.Fatal("explicit cleanup did not use producer output")
	}
}
