package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/apix/apix/runtime/internal/core"
)

func TestAPITestingRoutesAndImmutableAttempts(t *testing.T) {
	s, router := newTestRouter(t)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Test", "yes")
		if strings.Contains(r.URL.RawQuery, "invalid") {
			w.WriteHeader(400)
		}
		fmt.Fprint(w, `{"error":{"code":"INVALID_EMAIL"}}`)
	}))
	defer target.Close()
	post := methodJSON(t, router, "POST", "/test-batches", `{"name":"参数校验"}`)
	if post.Code != 201 {
		t.Fatal(post.Body.String())
	}
	var batch TestBatch
	json.Unmarshal(post.Body.Bytes(), &batch)
	body := fmt.Sprintf(`{"name":"无效邮箱","request":{"method":"GET","url":%q},"expected_status":400,"assertions":[{"source":"header","path":"x-test","operator":"equals","expected":"yes"},{"source":"body","path":"error.code","operator":"equals","expected":"INVALID_EMAIL"}]}`, target.URL+"?invalid=1")
	post = methodJSON(t, router, "POST", "/test-cases", body)
	if post.Code != 201 {
		t.Fatal(post.Body.String())
	}
	var item TestCase
	json.Unmarshal(post.Body.Bytes(), &item)
	for i := 0; i < 2; i++ {
		post = methodJSON(t, router, "POST", "/test-batches/"+batch.ID+"/runs", fmt.Sprintf(`{"case_id":%q}`, item.ID))
		if post.Code != 200 {
			t.Fatal(post.Body.String())
		}
		var out SendRequestResult
		json.Unmarshal(post.Body.Bytes(), &out)
		if out.TestStatus != "passed" || out.Status == nil || *out.Status != 400 || len(out.Assertions) != 3 {
			t.Fatalf("expected 400 to pass: %s", post.Body.String())
		}
	}
	// Edits cannot rewrite old inputs or old expectations.
	item.Name = "修改后"
	item.Request.URL = target.URL
	expected := 201
	item.ExpectedStatus = &expected
	encoded, _ := json.Marshal(item)
	post = methodJSON(t, router, "PUT", "/test-cases/"+item.ID, string(encoded))
	if post.Code != 200 {
		t.Fatal(post.Body.String())
	}
	post = methodJSON(t, router, "PUT", "/test-cases/"+item.ID, string(encoded))
	if post.Code != 409 {
		t.Fatalf("lost optimistic concurrency: %d", post.Code)
	}
	post = methodJSON(t, router, "POST", "/test-batches/"+batch.ID+"/runs", fmt.Sprintf(`{"case_id":%q}`, item.ID))
	if !strings.Contains(post.Body.String(), `"test_status":"failed"`) {
		t.Fatal(post.Body.String())
	}
	closed, err := s.FinishTestBatch(batch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if closed.Counts.Passed != 2 || closed.Counts.Failed != 1 || len(closed.Runs) != 3 {
		t.Fatalf("counts: %#v", closed)
	}
	if closed.Runs[0].ID == closed.Runs[1].ID || closed.Runs[0].APIRunID == nil || *closed.Runs[0].APIRunID == *closed.Runs[1].APIRunID || closed.Runs[0].CaseVersion != 1 || closed.Runs[0].Name != "无效邮箱" || *closed.Runs[0].ExpectedStatus != 400 || closed.Runs[2].CaseVersion != 2 {
		t.Fatalf("history changed: %#v", closed.Runs)
	}
	methodJSON(t, router, "DELETE", "/test-cases/"+item.ID, "")
	if _, err := s.GetTestBatch(batch.ID); err != nil {
		t.Fatal(err)
	}
	post = methodJSON(t, router, "POST", "/test-batches/"+batch.ID+"/runs", `{"test_case":{"name":"late","request":{"method":"GET","url":"http://localhost"}}}`)
	if post.Code != 409 {
		t.Fatalf("closed batch accepted call: %d %s", post.Code, post.Body.String())
	}
	if _, err := s.FinishTestBatch(batch.ID); err != nil {
		t.Fatalf("finish not idempotent: %v", err)
	}
}

func TestTestBatchReservesBeforeExecutorAndKeepsTransportErrors(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	b, err := s.BeginTestBatch("", "并行请求")
	if err != nil {
		t.Fatal(err)
	}
	started, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		_, err := s.RunTest(context.Background(), RunTestInput{BatchID: b.ID, TestCase: &TestCase{Name: "等待规则", Request: RequestData{Method: "GET", URL: "http://127.0.0.1:1"}}}, func(ctx context.Context, in map[string]any) (any, error) {
			close(started)
			<-release
			return s.Execute(ctx, "send_request", in, core.NewVariables())
		})
		done <- err
	}()
	<-started
	if _, err := s.FinishTestBatch(b.ID); err == nil {
		t.Fatal("closed batch while executor paused")
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	closed, err := s.FinishTestBatch(b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if closed.Counts.Errors != 1 || closed.Runs[0].APIRunID == nil {
		t.Fatalf("transport failure lost: %#v", closed)
	}
	if err := s.RecoverInterruptedRuns(); err != nil {
		t.Fatal(err)
	}
}

func TestIndependentTestsDoNotInheritVariablesAndDoNotInventPassingResults(t *testing.T) {
	s := newTestService(t)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("inherited token")
		}
		fmt.Fprint(w, `{"id":1}`)
	}))
	defer target.Close()
	b, _ := s.BeginTestBatch("", "独立测试")
	vars := core.NewVariables()
	vars.Global["token"] = &core.Variable{Value: "previous-case-token"}
	result, err := s.RunTest(context.Background(), RunTestInput{BatchID: b.ID, TestCase: &TestCase{Name: "无断言", Request: RequestData{Method: "GET", URL: target.URL}}}, func(ctx context.Context, in map[string]any) (any, error) {
		return s.Execute(ctx, "send_request", in, vars)
	})
	if err != nil || result.TestStatus != "unverified" {
		t.Fatalf("unverified: %#v %v", result, err)
	}
	for _, input := range []RunTestInput{{BatchID: b.ID}, {BatchID: b.ID, CaseID: "x", TestCase: &TestCase{}}, {BatchID: b.ID, TestCase: &TestCase{Name: "bad", Request: RequestData{URL: target.URL}, Assertions: []FlowAssertion{{Source: "body", Operator: "invalid"}}}}} {
		if _, err := s.RunTest(context.Background(), input, nil); err == nil {
			t.Fatal("accepted invalid case")
		}
	}
	if results := evaluateTestAssertions(&TestCase{Assertions: []FlowAssertion{{Source: "body", Operator: "contains", Expected: "prefix"}}}, &APIRun{ResponseBody: "prefix", ResponseTruncated: true}); results[0].Passed {
		t.Fatal("truncated body passed assertion")
	}
}

func TestTestingMigrationPreservesExistingHTTPHistory(t *testing.T) {
	s := newTestService(t)
	_, err := s.db.Exec(`INSERT INTO api_runs(id,project_id,trigger_type,status,request_snapshot,started_at) VALUES('keep','default','ai','succeeded','{}',datetime('now')); DROP TABLE test_case_runs; DROP TABLE test_cases; DROP TABLE test_batches; UPDATE schema_metadata SET version=4 WHERE name='http_domain'`)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.MigrateSchema(s.db); err != nil {
		t.Fatal(err)
	}
	if err := s.MigrateSchema(s.db); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetAPIRun("keep"); err != nil {
		t.Fatal("lost history", err)
	}
	b, err := s.BeginTestBatch("", "恢复")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RecoverInterruptedRuns(); err != nil {
		t.Fatal(err)
	}
	batch, err := s.GetTestBatch(b.ID)
	if err != nil || batch.Status != "interrupted" {
		t.Fatalf("unfinished batch not recovered: %#v %v", batch, err)
	}
}

func TestTestAssertionsEvaluateLiveSecretsWithoutDuplicatingThemInHistory(t *testing.T) {
	s := newTestService(t)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"token":"fake-test-response-secret"}`) }))
	defer target.Close()
	b, _ := s.BeginTestBatch("", "敏感响应断言")
	out, err := s.RunTest(context.Background(), RunTestInput{BatchID: b.ID, TestCase: &TestCase{Name: "token 存在且正确", Request: RequestData{Method: "GET", URL: target.URL}, Assertions: []FlowAssertion{{Source: "body", Path: "token", Operator: "equals", Expected: "fake-test-response-secret"}}}}, nil)
	if err != nil || out.TestStatus != "passed" {
		t.Fatalf("live assertion failed: %#v %v", out, err)
	}
	var evidence string
	if err := s.db.QueryRow(`SELECT assertion_definitions || assertions || request_snapshot FROM test_case_runs WHERE id=?`, out.TestRunID).Scan(&evidence); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(evidence, "fake-test-response-secret") {
		t.Fatal("secret duplicated in assertion evidence")
	}
}
