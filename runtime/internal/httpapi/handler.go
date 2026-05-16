package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/sentris/sentris/runtime/internal/core"
)

func sendRequest(ctx context.Context, input map[string]any, vars *core.Variables) (any, error) {
	method, _ := input["method"].(string)
	url, _ := input["url"].(string)
	body, _ := input["body"].(string)
	headersRaw, _ := input["headers"].(map[string]any)

	if method == "" {
		return nil, fmt.Errorf("method is required")
	}
	if url == "" {
		return nil, fmt.Errorf("url is required")
	}

	url = replaceVars(url, vars)
	body = replaceVars(body, vars)

	var bodyReader io.Reader
	if body != "" {
		bodyReader = strings.NewReader(body)
	}

	req, err := http.NewRequestWithContext(ctx, strings.ToUpper(method), url, bodyReader)
	if err != nil {
		return nil, err
	}

	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}

	// Inject Authorization header if a token variable exists
	if token := getVar(vars, "token"); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	for k, v := range headersRaw {
		if vs, ok := v.(string); ok {
			req.Header.Set(k, replaceVars(vs, vars))
		}
	}

	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	duration := time.Since(start).Milliseconds()

	var parsedBody any
	if json.Unmarshal(respBody, &parsedBody) != nil {
		parsedBody = string(respBody)
	}

	return map[string]any{
		"status":   resp.StatusCode,
		"body":     parsedBody,
		"duration": duration,
		"headers":  resp.Header,
	}, nil
}

func replaceVars(s string, vars *core.Variables) string {
	if vars == nil || s == "" {
		return s
	}
	for name, v := range vars.Global {
		if vs, ok := v.Value.(string); ok {
			s = strings.ReplaceAll(s, "{{"+name+"}}", vs)
		}
	}
	for name, v := range vars.Session {
		if vs, ok := v.Value.(string); ok {
			s = strings.ReplaceAll(s, "{{"+name+"}}", vs)
		}
	}
	return s
}

func getVar(vars *core.Variables, name string) string {
	if vars == nil {
		return ""
	}
	if v, ok := vars.Global[name]; ok {
		if s, ok := v.Value.(string); ok {
			return s
		}
	}
	return ""
}
