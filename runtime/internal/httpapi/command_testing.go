package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/gin-gonic/gin"
	"os"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/apix/apix/runtime/internal/commandrunner"
	"github.com/apix/apix/runtime/internal/mcpclient"
)

func commandSecrets(req commandrunner.Request, variables map[string]string) []string {
	values := map[string]any{}
	for name, value := range req.Env {
		values[name] = value
	}
	for name, value := range variables {
		values[name] = value
	}
	secrets := collectMCPSecrets(values)
	for _, entry := range os.Environ() {
		name, value, ok := strings.Cut(entry, "=")
		if ok && mcpclient.Sensitive(name) && value != "" {
			secrets = append(secrets, value)
		}
	}
	for i, arg := range req.Args {
		if !strings.HasPrefix(arg, "-") {
			continue
		}
		name, value, hasValue := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		if mcpclient.Sensitive(name) {
			if !hasValue && i+1 < len(req.Args) {
				value = req.Args[i+1]
			}
			if value != "" {
				secrets = append(secrets, value)
			}
		}
	}
	return secrets
}

// Keep output and stdin byte-for-byte except for redacted values. In particular,
// JSON field ordering, whitespace and trailing newlines are execution evidence.
func redactCommandJSON(data []byte) []byte {
	if !json.Valid(data) {
		return data
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || (trimmed[0] != '{' && trimmed[0] != '[') {
		return data
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	opening, err := decoder.Token()
	if err != nil {
		return data
	}
	object := opening == json.Delim('{')
	var out bytes.Buffer
	offset := 0
	for decoder.More() {
		name := ""
		if object {
			key, err := decoder.Token()
			if err != nil {
				return data
			}
			name, _ = key.(string)
		}
		var raw json.RawMessage
		if decoder.Decode(&raw) != nil {
			return data
		}
		end := int(decoder.InputOffset())
		start := end - len(raw)
		replacement := redactCommandJSON(raw)
		if object && mcpclient.Sensitive(name) {
			replacement, _ = json.Marshal(mcpclient.Mask)
		}
		out.Write(data[offset:start])
		out.Write(replacement)
		offset = end
	}
	out.Write(data[offset:])
	return out.Bytes()
}
func redactCommandText(text string, secrets []string) string {
	text = string(redactCommandJSON([]byte(text)))
	ordered := append([]string{}, secrets...)
	sort.Slice(ordered, func(i, j int) bool { return len(ordered[i]) > len(ordered[j]) })
	for _, secret := range ordered {
		if secret == "" {
			continue
		}
		encoded, _ := json.Marshal(secret)
		escaped := string(encoded[1 : len(encoded)-1])
		if escaped != secret {
			text = strings.ReplaceAll(text, escaped, mcpclient.Mask)
		}
		text = strings.ReplaceAll(text, secret, mcpclient.Mask)
	}
	return text
}
func commandEvidence(value any, secrets []string) any {
	if text, ok := value.(string); ok {
		return redactCommandText(text, secrets)
	}
	return mcpclient.Redact(value, secrets)
}
func redactedCommandRequest(req *commandrunner.Request, secrets []string) *commandrunner.Request {
	if req == nil {
		return nil
	}
	out := *req
	out.Program = redactCommandText(req.Program, secrets)
	out.WorkDir = redactCommandText(req.WorkDir, secrets)
	out.Stdin = redactCommandText(req.Stdin, secrets)
	out.Args = append([]string{}, req.Args...)
	for i, arg := range out.Args {
		out.Args[i] = redactCommandText(arg, secrets)
	}
	out.Env = map[string]string{}
	for name, value := range req.Env {
		if mcpclient.Sensitive(name) {
			out.Env[name] = mcpclient.Mask
		} else {
			out.Env[name] = redactCommandText(value, secrets)
		}
	}
	return &out
}
func resolveCommandRequest(req commandrunner.Request, variables map[string]string) (commandrunner.Request, error) {
	// Reuse the same explicit string substitution semantics as independent MCP tests.
	raw, _ := json.Marshal(req)
	var source map[string]any
	_ = json.Unmarshal(raw, &source)
	resolved, err := resolveMCPArguments(source, variables)
	if err != nil {
		return req, errors.New("缺少命令行运行变量")
	}
	raw, _ = json.Marshal(resolved)
	if err = json.Unmarshal(raw, &req); err != nil {
		return req, err
	}
	if strings.Contains(string(raw), "••••") {
		return req, errors.New("请替换脱敏字段后再执行")
	}
	return req, commandrunner.Validate(&req)
}
func evaluateCommandAssertions(item *TestCase, result *commandrunner.Result) []AssertionResult {
	out := []AssertionResult{}
	if result.ErrorKind != "" {
		return out
	}
	if item.ExpectedExitCode != nil {
		out = append(out, AssertionResult{Kind: "exit_code", Operator: "equals", Expected: *item.ExpectedExitCode, Actual: result.ExitCode, Passed: result.ExitCode != nil && *result.ExitCode == *item.ExpectedExitCode})
	}
	for _, a := range item.Assertions {
		var source any
		found := true
		switch a.Source {
		case "exit_code":
			if result.ExitCode != nil {
				source = *result.ExitCode
			} else {
				found = false
			}
		case "stdout":
			source = result.Stdout
			found = !result.StdoutTruncated
		case "stderr":
			source = result.Stderr
			found = !result.StderrTruncated
		}
		if found && a.Path != "" {
			var parsed any
			if json.Unmarshal([]byte(source.(string)), &parsed) != nil {
				found = false
			} else {
				source, found = mcpPath(parsed, a.Path)
			}
		}
		passed := false
		if found {
			switch a.Operator {
			case "equals":
				passed = mcpText(source) == a.Expected
			case "not_equals":
				passed = mcpText(source) != a.Expected
			case "contains":
				passed = strings.Contains(mcpText(source), a.Expected)
			case "exists":
				passed = true
			}
		}
		var actual any
		if found {
			actual = source
		}
		out = append(out, AssertionResult{Kind: a.Source, Path: a.Path, Operator: a.Operator, Expected: a.Expected, Actual: actual, Passed: passed})
	}
	return out
}
func (s *HTTPService) runCommandTest(ctx context.Context, item *TestCase, run *TestCaseRun, variables map[string]string) (*SendRequestResult, error) {
	request, err := resolveCommandRequest(*item.CommandRequest, variables)
	secrets := commandSecrets(request, variables)
	var result *commandrunner.Result
	if err != nil {
		result = &commandrunner.Result{ErrorKind: "input", ErrorMessage: err.Error()}
	} else {
		result = s.commands.Run(ctx, request)
	}
	run.CommandRequestSnapshot = redactedCommandRequest(&request, secrets)
	run.Assertions = evaluateCommandAssertions(item, result)
	run.Status = "unverified"
	if result.ErrorKind != "" {
		run.Status = "error"
		run.ErrorMessage = redactCommandText(result.ErrorMessage, secrets)
	} else if len(run.Assertions) > 0 {
		run.Status = "passed"
		for _, assertion := range run.Assertions {
			if !assertion.Passed {
				run.Status = "failed"
			}
		}
	}
	for i, a := range run.Assertions {
		if mcpclient.Sensitive(a.Path) {
			run.Assertions[i].Expected = mcpclient.Mask
			run.Assertions[i].Actual = mcpclient.Mask
		} else {
			run.Assertions[i].Expected = commandEvidence(a.Expected, secrets)
			run.Assertions[i].Actual = mcpEvidencePreview(commandEvidence(a.Actual, secrets))
		}
	}
	for i, a := range run.AssertionDefinitions {
		if mcpclient.Sensitive(a.Path) {
			run.AssertionDefinitions[i].Expected = mcpclient.Mask
		} else {
			run.AssertionDefinitions[i].Expected = mcpText(commandEvidence(a.Expected, secrets))
		}
	}
	snapshot := *result
	snapshot.Stdout = redactCommandText(result.Stdout, secrets)
	snapshot.Stderr = redactCommandText(result.Stderr, secrets)
	snapshot.WorkDir = redactCommandText(result.WorkDir, secrets)
	snapshot.ErrorMessage = redactCommandText(result.ErrorMessage, secrets)
	run.CommandResult = snapshot
	finished := time.Now().UTC()
	run.FinishedAt = &finished
	_, err = s.db.Exec(`UPDATE test_case_runs SET command_data=?,assertion_definitions=?,assertions=?,status=?,error_message=?,finished_at=? WHERE id=? AND status='running'`, marshalJSON(run.CommandRunData), marshalJSON(run.AssertionDefinitions), marshalJSON(run.Assertions), run.Status, run.ErrorMessage, finished, run.ID)
	if err != nil {
		return nil, fmt.Errorf("命令已执行，但测试结果保存失败: %w", err)
	}
	s.flow.emit("test_case.finished", run.BatchID, run.ID, map[string]any{"name": run.Name, "status": run.Status, "type": "command"})
	return &SendRequestResult{Type: "command", BatchID: run.BatchID, TestRunID: run.ID, CaseID: run.CaseID, TestStatus: run.Status, TestError: run.ErrorMessage, Assertions: run.Assertions, CommandResult: run.CommandResult, DurationMS: result.DurationMS, Truncated: result.StdoutTruncated || result.StderrTruncated}, nil
}

func (s *HTTPService) commandRoutes(r gin.IRouter) {
	r.GET("/commands/environment", func(c *gin.Context) {
		dir, err := os.Getwd()
		if err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(200, gin.H{"platform": runtime.GOOS, "work_dir": dir, "output_limit": commandrunner.OutputLimit})
	})
}
