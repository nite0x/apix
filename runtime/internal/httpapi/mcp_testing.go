package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/apix/apix/runtime/internal/mcpclient"
	"github.com/google/jsonschema-go/jsonschema"
)

func redactedMCPRequest(req *mcpclient.Request, secrets []string) *mcpclient.Request {
	if req == nil {
		return nil
	}
	data, _ := json.Marshal(mcpclient.Redact(req, secrets))
	var out mcpclient.Request
	_ = json.Unmarshal(data, &out)
	return &out
}

var mcpVariable = regexp.MustCompile(`\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}`)

func resolveMCPArguments(input map[string]any, variables map[string]string) (map[string]any, error) {
	raw, e := json.Marshal(input)
	if e != nil {
		return nil, e
	}
	var v any
	if e = json.Unmarshal(raw, &v); e != nil {
		return nil, e
	}
	var unresolved bool
	var walk func(any) any
	walk = func(v any) any {
		switch x := v.(type) {
		case map[string]any:
			for k, item := range x {
				x[k] = walk(item)
			}
		case []any:
			for i, item := range x {
				x[i] = walk(item)
			}
		case string:
			return mcpVariable.ReplaceAllStringFunc(x, func(match string) string {
				name := mcpVariable.FindStringSubmatch(match)[1]
				value, ok := variables[name]
				if !ok {
					unresolved = true
				}
				return value
			})
		}
		return v
	}
	out, _ := walk(v).(map[string]any)
	if unresolved {
		return nil, errors.New("缺少 MCP 运行变量")
	}
	return out, nil
}
func collectMCPSecrets(v any) []string {
	out := []string{}
	var walk func(any, bool)
	walk = func(item any, sensitive bool) {
		switch x := item.(type) {
		case map[string]any:
			for k, value := range x {
				walk(value, sensitive || mcpclient.Sensitive(k))
			}
		case []any:
			for _, value := range x {
				walk(value, sensitive)
			}
		case string:
			if sensitive && x != "" {
				out = append(out, x)
			}
		}
	}
	walk(v, false)
	return out
}
func mcpPath(v any, path string) (any, bool) {
	if path == "" {
		return v, v != nil
	}
	for _, part := range strings.Split(path, ".") {
		switch x := v.(type) {
		case map[string]any:
			var ok bool
			v, ok = x[part]
			if !ok {
				return nil, false
			}
		case []any:
			i, e := strconv.Atoi(part)
			if e != nil || i < 0 || i >= len(x) {
				return nil, false
			}
			v = x[i]
		default:
			return nil, false
		}
	}
	return v, true
}
func mcpText(value any) string {
	if s, ok := value.(string); ok {
		return s
	}
	raw, _ := json.Marshal(value)
	return string(raw)
}
func mcpOutputSchema(tool map[string]any, result any) error {
	schema, ok := tool["outputSchema"]
	if !ok || schema == nil {
		return errors.New("工具未声明 outputSchema")
	}
	raw, err := json.Marshal(schema)
	if err != nil {
		return err
	}
	var definition jsonschema.Schema
	if err = json.Unmarshal(raw, &definition); err != nil {
		return errors.New("outputSchema 无效")
	}
	resolved, err := definition.Resolve(nil)
	if err != nil {
		return errors.New("outputSchema 无法解析")
	}
	if err = resolved.Validate(result); err != nil {
		return errors.New("structuredContent 不符合 outputSchema")
	}
	return nil
}
func evaluateMCPAssertions(item *TestCase, result *mcpclient.Result) []AssertionResult {
	out := []AssertionResult{}
	if result.Response == nil {
		return out
	}
	add := func(kind, path, operator string, expected, actual any, passed bool) {
		out = append(out, AssertionResult{Kind: kind, Path: path, Operator: operator, Expected: expected, Actual: actual, Passed: passed})
	}
	if item.ExpectedIsError != nil {
		add("isError", "", "equals", *item.ExpectedIsError, result.Response.IsError, *item.ExpectedIsError == result.Response.IsError)
	}
	var response map[string]any
	raw, _ := json.Marshal(result.Response)
	_ = json.Unmarshal(raw, &response)
	response["isError"] = result.Response.IsError
	text := []string{}
	if blocks, ok := response["content"].([]any); ok {
		for _, block := range blocks {
			if b, ok := block.(map[string]any); ok && b["type"] == "text" {
				if value, ok := b["text"].(string); ok {
					text = append(text, value)
				}
			}
		}
	}
	for _, a := range item.Assertions {
		var source any
		switch a.Source {
		case "result":
			source = response
		case "structuredContent":
			source = result.Response.StructuredContent
		case "isError":
			source = result.Response.IsError
		case "text":
			source = strings.Join(text, "\n")
			if a.Path != "" {
				var parsed any
				if json.Unmarshal([]byte(source.(string)), &parsed) == nil {
					source = parsed
				}
			}
		}
		actual, found := mcpPath(source, a.Path)
		passed := false
		if found {
			switch a.Operator {
			case "equals":
				passed = mcpText(actual) == a.Expected
			case "not_equals":
				passed = mcpText(actual) != a.Expected
			case "contains":
				passed = strings.Contains(mcpText(actual), a.Expected)
			case "exists":
				passed = true
			}
		}
		add(a.Source, a.Path, a.Operator, a.Expected, actual, passed)
	}
	if item.ValidateOutputSchema {
		err := mcpOutputSchema(result.Tool, result.Response.StructuredContent)
		actual := "符合 outputSchema"
		if err != nil {
			actual = err.Error()
		}
		add("outputSchema", "", "valid", true, actual, err == nil)
	}
	return out
}
func (s *HTTPService) runMCPTest(ctx context.Context, item *TestCase, run *TestCaseRun, variables map[string]string) (*SendRequestResult, error) {
	request := *item.MCPRequest
	var result *mcpclient.Result
	arguments, err := resolveMCPArguments(request.Arguments, variables)
	secrets := collectMCPSecrets(arguments)
	for name, value := range variables {
		if mcpclient.Sensitive(name) && value != "" {
			secrets = append(secrets, value)
		}
	}
	if err != nil {
		result = &mcpclient.Result{ErrorKind: "input", ErrorMessage: err.Error()}
	} else if strings.Contains(marshalJSON(arguments), "••••") {
		result = &mcpclient.Result{ErrorKind: "input", ErrorMessage: "请替换脱敏字段后再执行"}
	} else if s.mcpClient == nil {
		result = &mcpclient.Result{ErrorKind: "connection", ErrorMessage: "MCP testing unavailable"}
	} else {
		request.Arguments = arguments
		result = s.mcpClient.Call(ctx, request)
	}
	secrets = append(secrets, result.Secrets...)
	run.MCPRequestSnapshot = redactedMCPRequest(&request, secrets)
	run.Assertions = evaluateMCPAssertions(item, result)
	run.Status = "unverified"
	if result.ErrorKind != "" {
		run.Status = "error"
		run.ErrorMessage = result.ErrorMessage
	} else if len(run.Assertions) > 0 {
		run.Status = "passed"
		for _, a := range run.Assertions {
			if !a.Passed {
				run.Status = "failed"
			}
		}
	}
	// Both text blocks containing JSON and arbitrary structured output are sanitized.
	for i, a := range run.Assertions {
		if mcpclient.Sensitive(a.Path) {
			run.Assertions[i].Actual = mcpclient.Mask
			run.Assertions[i].Expected = mcpclient.Mask
		} else {
			run.Assertions[i].Actual = mcpEvidencePreview(mcpclient.Redact(a.Actual, secrets))
			run.Assertions[i].Expected = mcpclient.Redact(a.Expected, secrets)
		}
	}
	for i, a := range run.AssertionDefinitions {
		if mcpclient.Sensitive(a.Path) {
			run.AssertionDefinitions[i].Expected = mcpclient.Mask
		} else {
			run.AssertionDefinitions[i].Expected = mcpText(mcpclient.Redact(a.Expected, secrets))
		}
	}
	run.MCPResult = mcpResultSnapshot(result, secrets)
	finished := time.Now().UTC()
	run.FinishedAt = &finished
	_, err = s.db.Exec(`UPDATE test_case_runs SET mcp_data=?,assertion_definitions=?,assertions=?,status=?,error_message=?,finished_at=? WHERE id=? AND status='running'`, marshalJSON(run.MCPRunData), marshalJSON(run.AssertionDefinitions), marshalJSON(run.Assertions), run.Status, run.ErrorMessage, finished, run.ID)
	if err != nil {
		return nil, fmt.Errorf("MCP 调用已结束，但测试结果保存失败: %w", err)
	}
	s.flow.emit("test_case.finished", run.BatchID, run.ID, map[string]any{"name": run.Name, "status": run.Status, "type": "mcp"})
	return &SendRequestResult{Type: "mcp", BatchID: run.BatchID, TestRunID: run.ID, CaseID: run.CaseID, TestStatus: run.Status, TestError: run.ErrorMessage, Assertions: run.Assertions, MCPResult: run.MCPResult, DurationMS: result.DurationMS}, nil
}

// Assertions use the full live result; snapshots and evidence have explicit bounds.
func mcpEvidencePreview(value any) any {
	raw, _ := json.Marshal(value)
	if len(raw) <= 16384 {
		return value
	}
	return map[string]any{"snapshot_truncated": true, "preview": string(raw[:4096])}
}
func mcpResultSnapshot(result *mcpclient.Result, secrets []string) any {
	value := mcpclient.Redact(result, secrets)
	if root, ok := value.(map[string]any); ok {
		if details, ok := root["error_details"]; ok {
			root["error_details"] = mcpEvidencePreview(details)
		}
		if response, ok := root["response"].(map[string]any); ok && result.Response != nil {
			response["isError"] = result.Response.IsError
		}
		raw, _ := json.Marshal(value)
		if len(raw) > 256*1024 {
			root["snapshot_truncated"] = true
			if response, ok := root["response"]; ok {
				data, _ := json.Marshal(response)
				length := len(data)
				if length > 32768 {
					data = data[:32768]
				}
				root["response"] = map[string]any{"snapshot_truncated": true, "bytes": length, "preview": string(data)}
			}
			if tool, ok := root["tool"]; ok {
				data, _ := json.Marshal(tool)
				if len(data) > 65536 {
					root["tool"] = map[string]any{"name": result.Tool["name"], "snapshot_truncated": true}
				}
			}
		}
	}
	return value
}
