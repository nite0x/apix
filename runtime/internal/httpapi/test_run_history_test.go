package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRunHistoryIsTypedBoundedAndLoadsDetailsOnDemand(t *testing.T) {
	s, router := newTestRouter(t)
	batch, err := s.BeginTestBatch("", "old batch")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for _, kind := range []string{"mcp", "command"} {
		command := `{"command_request_snapshot":{"program":"python3"},"command_result":{"duration_ms":12,"stdout":"persisted output"}}`
		mcp := `{"mcp_request_snapshot":{"server_id":"server","tool_name":"lookup"},"mcp_result":{"duration_ms":15,"text":"persisted tool result"}}`
		_, err := s.db.Exec(`INSERT INTO test_case_runs(id,batch_id,name,request_snapshot,type,mcp_data,command_data,status,started_at,finished_at) VALUES(?,?,?,'{}',?,?,?,'passed',?,?)`, kind+"-run", batch.ID, kind+" original", kind, mcp, command, now, now)
		if err != nil {
			t.Fatal(err)
		}
	}
	// The page must find runs even when their batch is outside the batch list's limit.
	for i := 0; i < 101; i++ {
		if _, err = s.BeginTestBatch("", "new empty batch"); err != nil {
			t.Fatal(err)
		}
	}
	for _, kind := range []string{"mcp", "command"} {
		request := httptest.NewRequest("GET", "/test-runs?type="+kind, nil)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(response.Code, response.Body.String())
		}
		var items []TestRunSummary
		if err := json.Unmarshal(response.Body.Bytes(), &items); err != nil {
			t.Fatal(err)
		}
		if len(items) != 1 || items[0].Type != kind || items[0].BatchID != batch.ID || items[0].Target == "" {
			t.Fatal(items)
		}
		if strings.Contains(response.Body.String(), "persisted") {
			t.Fatal("list eagerly exposed full output")
		}
		detail := httptest.NewRecorder()
		router.ServeHTTP(detail, httptest.NewRequest("GET", "/test-runs/"+items[0].ID, nil))
		if detail.Code != 200 || !strings.Contains(detail.Body.String(), "persisted") {
			t.Fatal(detail.Code, detail.Body.String())
		}
	}
	for _, path := range []string{"/test-runs?type=bad", "/test-runs/missing"} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		want := 400
		if strings.HasSuffix(path, "missing") {
			want = 404
		}
		if response.Code != want {
			t.Fatal(path, response.Code, response.Body.String())
		}
	}
}
