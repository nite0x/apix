package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/apix/apix/runtime/internal/core"
	"github.com/apix/apix/runtime/internal/executionrecord"
	"github.com/google/uuid"
)

const maxStoredResponseBytes = 256 * 1024

var errorURLPattern = regexp.MustCompile(`https?://[^\s"<>]+`)

type executionService struct {
	record executionrecord.Recorder
	repo   *repository
	client *http.Client
}

func newExecutionService(repo *repository) *executionService {
	return &executionService{repo: repo, client: &http.Client{Timeout: 60 * time.Second}}
}

func (s *executionService) Run(ctx context.Context, command RunCommand, vars *core.Variables) (out *APIRun, executionErr error) {
	projectID := command.ProjectID
	if projectID == "" {
		projectID = defaultProjectID
	}
	trigger := command.TriggerType
	if trigger == "" {
		trigger = "manual"
	}

	request, apiID, wcID, err := s.resolveRequest(command)
	if err != nil {
		return nil, err
	}
	normalizeRequest(&request)
	if request.URL == "" {
		return nil, fmt.Errorf("url is required")
	}

	if s.record != nil && command.TriggerType != "test" && !executionrecord.Skipped(ctx) {
		finish, err := s.record(executionrecord.WithProject(ctx, projectID), "http", request.Method+" "+redactRequestURL(request.URL), command.BatchID, redactRequest(request))
		if err != nil {
			return nil, err
		}
		defer func() { executionErr = errors.Join(executionErr, finish(out, executionErr)) }()
	}
	actual := substituteRequest(request, vars)
	snapshot := redactRequest(actual)
	now := time.Now().UTC()
	expires := now.Add(30 * 24 * time.Hour)
	run := &APIRun{
		ID: uuid.NewString(), ProjectID: projectID, APIRequestID: apiID, WorkingCopyID: wcID,
		SessionID: command.SessionID, StepID: command.StepID, TriggerType: trigger,
		Status: "running", RequestSnapshot: snapshot, StartedAt: now, ExpiresAt: &expires,
	}
	if command.EnvironmentID != "" {
		run.EnvironmentID = &command.EnvironmentID
	}
	if err := s.repo.insertRun(run); err != nil {
		return nil, err
	}

	status, headers, body, size, truncated, duration, execErr := s.perform(ctx, actual)
	finished := time.Now().UTC()
	run.FinishedAt = &finished
	run.DurationMS = duration
	if status != 0 {
		run.ResponseStatus = &status
		run.ResponseHeaders = redactHeaders(headers)
		run.ResponseBody = body
		run.ResponseSize = size
		run.ResponseTruncated = truncated
	}
	if execErr != nil {
		run.Status = "failed"
		run.ErrorCode = "request_failed"
		run.ErrorMessage = redactExecutionError(execErr.Error())
		var netErr net.Error
		if errors.As(execErr, &netErr) && netErr.Timeout() {
			run.Status = "timed_out"
			run.ErrorCode = "timeout"
		}
	} else {
		run.Status = "succeeded"
	}
	if err := s.repo.finishRun(run); err != nil {
		return nil, err
	}
	return run, execErr
}

func (s *executionService) resolveRequest(command RunCommand) (RequestData, *string, *string, error) {
	set := 0
	if command.APIRequestID != "" {
		set++
	}
	if command.WorkingCopyID != "" {
		set++
	}
	if command.InlineRequest != nil {
		set++
	}
	if set != 1 {
		return RequestData{}, nil, nil, fmt.Errorf("provide exactly one request source")
	}
	if command.WorkingCopyID != "" {
		copy, err := s.repo.getWorkingCopy(command.WorkingCopyID)
		if err != nil {
			return RequestData{}, nil, nil, err
		}
		if copy.Status != "active" {
			return RequestData{}, nil, nil, fmt.Errorf("working copy is not active")
		}
		return copy.Request, copy.APIRequestID, &copy.ID, nil
	}
	if command.APIRequestID != "" {
		request, err := s.repo.getRequest(command.APIRequestID)
		if err != nil {
			return RequestData{}, nil, nil, err
		}
		return request.Request, &request.ID, nil, nil
	}
	return *command.InlineRequest, nil, nil, nil
}

func (s *executionService) perform(ctx context.Context, data RequestData) (int, http.Header, any, int64, bool, int64, error) {
	u, err := url.Parse(data.URL)
	if err != nil {
		return 0, nil, nil, 0, false, 0, err
	}
	query := u.Query()
	for _, item := range data.QueryParams {
		if item.Enabled && item.Name != "" {
			query.Add(item.Name, item.Value)
		}
	}
	u.RawQuery = query.Encode()

	var reader io.Reader
	if data.Body != "" {
		reader = strings.NewReader(data.Body)
	}
	req, err := http.NewRequestWithContext(ctx, data.Method, u.String(), reader)
	if err != nil {
		return 0, nil, nil, 0, false, 0, err
	}
	for _, item := range data.Headers {
		if item.Enabled && item.Name != "" {
			req.Header.Add(item.Name, item.Value)
		}
	}
	if data.Body != "" && req.Header.Get("Content-Type") == "" {
		if data.BodyType == "json" {
			req.Header.Set("Content-Type", "application/json")
		} else if data.BodyType == "urlencoded" || data.BodyType == "x-www-form-urlencoded" || data.BodyType == "form" {
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		} else {
			req.Header.Set("Content-Type", "text/plain")
		}
	}
	applyAuth(req, data.AuthConfig)

	started := time.Now()
	response, err := s.client.Do(req)
	duration := time.Since(started).Milliseconds()
	if err != nil {
		return 0, nil, nil, 0, false, duration, err
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, maxStoredResponseBytes+1)
	raw, readErr := io.ReadAll(limited)
	duration = time.Since(started).Milliseconds()
	size := int64(len(raw))
	truncated := len(raw) > maxStoredResponseBytes
	if truncated {
		raw = raw[:maxStoredResponseBytes]
	}
	var body any
	if len(raw) > 0 && json.Unmarshal(raw, &body) != nil {
		body = string(raw)
	}
	return response.StatusCode, response.Header, body, size, truncated, duration, readErr
}

func substituteRequest(request RequestData, vars *core.Variables) RequestData {
	request.URL = replaceVars(request.URL, vars)
	request.Body = replaceVars(request.Body, vars)
	for i := range request.QueryParams {
		request.QueryParams[i].Value = replaceVars(request.QueryParams[i].Value, vars)
	}
	for i := range request.Headers {
		request.Headers[i].Value = replaceVars(request.Headers[i].Value, vars)
	}
	if getVar(vars, "token") != "" && !hasHeader(request.Headers, "Authorization") {
		request.Headers = append(request.Headers, KeyValue{Name: "Authorization", Value: "Bearer " + getVar(vars, "token"), Enabled: true})
	}
	return request
}

func hasHeader(headers []KeyValue, name string) bool {
	for _, item := range headers {
		if item.Enabled && strings.EqualFold(item.Name, name) {
			return true
		}
	}
	return false
}

func applyAuth(req *http.Request, auth map[string]any) {
	if auth == nil {
		return
	}
	typeName, _ := auth["type"].(string)
	switch typeName {
	case "bearer":
		if token, _ := auth["token"].(string); token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
	case "basic":
		username, _ := auth["username"].(string)
		password, _ := auth["password"].(string)
		req.SetBasicAuth(username, password)
	case "api_key":
		name, _ := auth["name"].(string)
		value, _ := auth["value"].(string)
		in, _ := auth["in"].(string)
		if in == "query" {
			query := req.URL.Query()
			query.Set(name, value)
			req.URL.RawQuery = query.Encode()
		} else if name != "" {
			req.Header.Set(name, value)
		}
	}
}

func redactRequest(request RequestData) RequestData {
	request.URL = redactRequestURL(request.URL)
	request.Headers = append([]KeyValue(nil), request.Headers...)
	request.QueryParams = append([]KeyValue(nil), request.QueryParams...)
	for i := range request.Headers {
		if isSensitiveName(request.Headers[i].Name) {
			request.Headers[i].Value = "••••••"
		}
	}
	for i := range request.QueryParams {
		if isSensitiveName(request.QueryParams[i].Name) {
			request.QueryParams[i].Value = "••••••"
		}
	}
	if request.BodyType == "json" && request.Body != "" {
		var value any
		if json.Unmarshal([]byte(request.Body), &value) == nil {
			redactJSONValue(value)
			if encoded, err := json.Marshal(value); err == nil {
				request.Body = string(encoded)
			}
		}
	}
	if request.BodyType == "urlencoded" || request.BodyType == "x-www-form-urlencoded" || request.BodyType == "form" {
		if values, err := url.ParseQuery(request.Body); err == nil {
			redactQuery(values)
			request.Body = values.Encode()
		}
	}
	if request.AuthConfig != nil {
		request.AuthConfig = map[string]any{"type": request.AuthConfig["type"], "redacted": true}
	}
	return request
}

func redactQuery(values url.Values) {
	for name := range values {
		if isSensitiveName(name) {
			values.Set(name, "••••••")
		}
	}
}

func redactRequestURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "（无效 URL）"
	}
	u.User = nil
	u.Fragment = ""
	query := u.Query()
	redactQuery(query)
	u.RawQuery = query.Encode()
	return u.String()
}

func redactExecutionError(message string) string {
	return errorURLPattern.ReplaceAllStringFunc(message, redactRequestURL)
}

func redactJSONValue(value any) {
	switch current := value.(type) {
	case map[string]any:
		for key, child := range current {
			if isSensitiveName(key) || strings.Contains(strings.ToLower(key), "password") || strings.Contains(strings.ToLower(key), "secret") {
				current[key] = "••••••"
				continue
			}
			redactJSONValue(child)
		}
	case []any:
		for _, child := range current {
			redactJSONValue(child)
		}
	}
}

func redactHeaders(headers http.Header) map[string][]string {
	out := make(map[string][]string, len(headers))
	for name, values := range headers {
		if isSensitiveName(name) {
			out[name] = []string{"••••••"}
		} else {
			out[name] = append([]string(nil), values...)
		}
	}
	return out
}

func isSensitiveName(name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	return name == "authorization" || name == "proxy-authorization" || name == "cookie" || name == "set-cookie" || name == "key" || name == "api_key" || strings.Contains(name, "api-key") || strings.Contains(name, "token") || strings.Contains(name, "password") || strings.Contains(name, "secret")
}
