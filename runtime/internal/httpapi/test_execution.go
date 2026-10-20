package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/apix/apix/runtime/internal/lifecycle"
	"strings"
	"time"

	"github.com/apix/apix/runtime/internal/core"
	"github.com/google/uuid"
)

type RunTestInput struct {
	BatchID   string            `json:"batch_id"`
	CaseID    string            `json:"case_id,omitempty"`
	TestCase  *TestCase         `json:"test_case,omitempty"`
	Variables map[string]string `json:"variables,omitempty"`
}

// RunTest reserves its record before entering the ordinary execution adapter,
// including any MCP pause. HTTP history stays in api_runs. There is no inferred
// grouping by client connection, time, URL, or global current batch.
func (s *HTTPService) RunTest(ctx context.Context, in RunTestInput, runner func(context.Context, map[string]any) (any, error)) (*SendRequestResult, error) {
	if in.BatchID == "" {
		return nil, invalidTest("batch_id is required; call begin_test_batch first")
	}
	if (in.CaseID == "") == (in.TestCase == nil) {
		return nil, invalidTest("provide exactly one of case_id or test_case")
	}
	gate := lifecycle.For(s.db)
	gate.Lock()
	locked := true
	defer func() {
		if locked {
			gate.Unlock()
		}
	}()
	var item *TestCase
	var err error
	if in.CaseID != "" {
		item, err = s.GetTestCase(in.CaseID)
		if err != nil {
			return nil, err
		}
	} else {
		copy := *in.TestCase
		copy.ID = ""
		copy.EditVersion = 0
		item = &copy
	}
	if item.NeedsReview {
		return nil, fmt.Errorf("%w: MCP 工具列表已变化，请检查并重新保存用例", lifecycle.ErrProtected)
	}
	if item.Archived {
		return nil, fmt.Errorf("%w: 用例已归档，请先恢复", errConflict)
	}
	if err := validateTestCase(item); err != nil {
		return nil, err
	}
	if strings.Contains(marshalJSON(item), "••••") {
		return nil, invalidTest("replace redacted snapshot values before executing a test")
	}
	batch, err := scanTestBatch(s.db.QueryRow(`SELECT `+batchColumns+` FROM test_batches b WHERE b.id=?`, in.BatchID))
	if err != nil {
		return nil, err
	}
	if in.CaseID != "" && item.ProjectID != batch.ProjectID {
		return nil, invalidTest("test case does not belong to batch project")
	}
	if item.APIRequestID != nil {
		if err := s.repo.assertRequestInProject(*item.APIRequestID, batch.ProjectID); err != nil {
			return nil, invalidTest(err.Error())
		}
	}
	r := TestCaseRun{Type: item.Type, ID: uuid.NewString(), BatchID: batch.ID, Name: item.Name, CaseVersion: item.EditVersion, RequestSnapshot: redactRequest(item.Request), ExpectedStatus: item.ExpectedStatus, AssertionDefinitions: item.Assertions, Assertions: []AssertionResult{}, Status: "running", StartedAt: time.Now().UTC()}
	r.AssertionDefinitions = append([]FlowAssertion{}, item.Assertions...)
	for i, a := range r.AssertionDefinitions {
		r.AssertionDefinitions[i].Expected = redactTestAssertionValue(a.Source, a.Path, a.Expected)
	}
	if item.Type == "mcp" {
		r.MCPRequestSnapshot = redactedMCPRequest(item.MCPRequest, nil)
		r.ExpectedIsError = item.ExpectedIsError
		r.ValidateOutputSchema = item.ValidateOutputSchema
	}
	if item.Type == "command" {
		r.CommandRequestSnapshot = redactedCommandRequest(item.CommandRequest, commandSecrets(*item.CommandRequest, in.Variables))
		r.ExpectedExitCode = item.ExpectedExitCode
	}
	if in.CaseID != "" {
		r.CaseID = &item.ID
	}
	result, err := s.db.Exec(`INSERT INTO test_case_runs(id,batch_id,case_id,case_version,name,request_snapshot,expected_status,assertion_definitions,assertions,status,started_at,type,mcp_data,command_data)
 SELECT ?,?,?,?,?,?,?,?,'[]','running',?,?,?,? FROM test_batches WHERE id=? AND status='running'`, r.ID, r.BatchID, r.CaseID, r.CaseVersion, r.Name, marshalJSON(r.RequestSnapshot), r.ExpectedStatus, marshalJSON(r.AssertionDefinitions), r.StartedAt, r.Type, marshalJSON(r.MCPRunData), marshalJSON(r.CommandRunData), r.BatchID)
	if err != nil {
		return nil, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n != 1 {
		return nil, fmt.Errorf("%w: batch is closed", errConflict)
	}
	gate.Unlock()
	locked = false
	s.flow.emit("test_case.started", batch.ID, r.ID, map[string]any{"name": r.Name, "status": "running"})
	if item.Type == "command" {
		return s.runCommandTest(ctx, item, &r, in.Variables)
	}
	if item.Type == "mcp" {
		return s.runMCPTest(ctx, item, &r, in.Variables)
	}
	input := map[string]any{"method": item.Request.Method, "url": item.Request.URL, "body": item.Request.Body, "test_request": item.Request, "test_variables": in.Variables, "session_id": batch.ID, "step_id": r.ID, "test_run_id": r.ID, "project_id": batch.ProjectID}
	input["trigger_type"] = "test"
	if runner == nil {
		runner = s.testRunner
	}
	if runner == nil {
		runner = func(ctx context.Context, input map[string]any) (any, error) {
			return s.Execute(ctx, "send_request", input, core.NewVariables())
		}
	}
	output, execErr := runner(ctx, input)
	var response SendRequestResult
	if out, ok := output.(SendRequestResult); ok {
		response = out
	} else if output != nil {
		execErr = errors.Join(execErr, errors.New("unexpected request result"))
	}
	r.Status = "unverified"
	if response.RunID != "" {
		r.APIRunID = &response.RunID
		apiRun, loadErr := s.repo.getRun(response.RunID)
		if loadErr != nil {
			execErr = errors.Join(execErr, loadErr)
		} else {
			r.RequestSnapshot = apiRun.RequestSnapshot
			// Evaluate the live response, not a redacted historical body.
			apiRun.ResponseBody = response.Body
			apiRun.ResponseHeaders = response.Headers
			r.Assertions = evaluateTestAssertions(item, apiRun)
		}
	}
	if execErr != nil || response.RunID == "" {
		r.Status = "error"
		if execErr != nil {
			r.ErrorMessage = redactExecutionError(execErr.Error())
		} else {
			r.ErrorMessage = "request did not execute"
		}
	} else if len(r.Assertions) > 0 {
		r.Status = "passed"
		for _, a := range r.Assertions {
			if !a.Passed {
				r.Status = "failed"
			}
		}
	}
	finished := time.Now().UTC()
	r.FinishedAt = &finished
	_, err = s.db.Exec(`UPDATE test_case_runs SET request_snapshot=?,assertions=?,api_run_id=?,status=?,error_message=?,finished_at=? WHERE id=? AND status='running'`, marshalJSON(r.RequestSnapshot), marshalJSON(r.Assertions), r.APIRunID, r.Status, r.ErrorMessage, finished, r.ID)
	if err != nil {
		return nil, fmt.Errorf("request completed but test result could not be persisted: %w", err)
	}
	s.flow.emit("test_case.finished", batch.ID, r.ID, map[string]any{"name": r.Name, "status": r.Status, "api_run_id": response.RunID})
	response.BatchID, response.TestRunID, response.CaseID, response.TestStatus, response.Assertions = batch.ID, r.ID, r.CaseID, r.Status, r.Assertions
	// Transport failures are represented in the result, just like assertion
	// failures, so a batch can continue testing the remaining independent cases.
	response.TestError = r.ErrorMessage
	return &response, nil
}

func evaluateTestAssertions(item *TestCase, run *APIRun) []AssertionResult {
	results := []AssertionResult{}
	if item.ExpectedStatus != nil {
		var actual any
		if run.ResponseStatus != nil {
			actual = *run.ResponseStatus
		}
		results = append(results, AssertionResult{Kind: "status", Operator: "equals", Expected: *item.ExpectedStatus, Actual: actual, Passed: run.ResponseStatus != nil && *run.ResponseStatus == *item.ExpectedStatus})
	}
	for _, a := range item.Assertions {
		value, found := extractValue(FlowExtractor{Source: a.Source, Path: a.Path}, run)
		// A retained body prefix cannot establish a body assertion.
		if a.Source == "body" && run.ResponseTruncated {
			found = false
		}
		passed := false
		switch a.Operator {
		case "exists":
			passed = found
		case "equals":
			passed = found && value == a.Expected
		case "not_equals":
			passed = found && value != a.Expected
		case "contains":
			passed = found && strings.Contains(value, a.Expected)
		}
		var actual any
		if found {
			actual = value
		}
		if text, ok := actual.(string); ok {
			actual = redactTestAssertionValue(a.Source, a.Path, text)
		}
		results = append(results, AssertionResult{Kind: a.Source, Path: a.Path, Operator: a.Operator, Expected: redactTestAssertionValue(a.Source, a.Path, a.Expected), Actual: actual, Passed: passed})
	}
	return results
}

// Assertions evaluate the live value but persist the same redacted evidence
// policy as API history, including assertions against an entire JSON object.
func redactTestAssertionValue(source, path, value string) string {
	if source == "status" {
		return value
	}
	for _, segment := range strings.Split(path, ".") {
		if isSensitiveName(segment) {
			return "••••••"
		}
	}
	if source == "body" {
		var body any
		if json.Unmarshal([]byte(value), &body) == nil {
			switch body.(type) {
			case map[string]any, []any:
				if encoded, err := json.Marshal(redactedJSONCopy(body)); err == nil {
					return string(encoded)
				}
			}
		}
	}
	return value
}
