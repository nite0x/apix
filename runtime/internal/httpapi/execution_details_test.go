package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestRequestDetailsRedactPersistedAndLegacySnapshots(t *testing.T) {
	service := newTestService(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("token") != "url-private" || r.Header.Get("X-Api-Key") != "header-private" {
			t.Error("redaction changed the outgoing request")
		}
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), "password=form-private") {
			t.Error("redaction changed the outgoing body")
		}
		w.Header().Set("Set-Cookie", "private-cookie")
		_, _ = w.Write([]byte(`{"ok":true,"secret":"response-private"}`))
	}))
	defer upstream.Close()
	run, err := service.execution.Run(context.Background(), RunCommand{InlineRequest: &RequestData{
		Method: "POST", URL: upstream.URL + "?token=url-private&name=example", BodyType: "urlencoded", Body: "password=form-private&name=Ada",
		Headers: []KeyValue{{Name: "X-Api-Key", Value: "header-private", Enabled: true}},
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := service.repo.getRun(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(stored)
	if strings.Contains(string(data), "private") || !strings.Contains(string(data), "example") || !strings.Contains(string(data), "Ada") {
		t.Fatalf("unsafe or incomplete details: %s", data)
	}
	// Reading historical records must not expose credentials saved by older versions.
	legacy := RequestData{Method: "GET", URL: "http://user:pass@localhost/path?api_key=legacy-private", BodyType: "json", Body: `{"password":"legacy-private"}`}
	_, err = service.repo.db.Exec(`UPDATE api_runs SET request_snapshot=?,error_message=? WHERE id=?`, marshalJSON(legacy), `Get "http://localhost/path?token=legacy-private": connection refused`, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	stored, err = service.repo.getRun(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	data, _ = json.Marshal(stored)
	if strings.Contains(string(data), "legacy-private") || strings.Contains(string(data), "user:pass") {
		t.Fatalf("legacy details expose credentials: %s", data)
	}
	parsed, _ := url.Parse(stored.RequestSnapshot.URL)
	if parsed.Query().Get("api_key") != "••••••" {
		t.Fatal("query parameter was lost instead of masked")
	}
}

func TestRequestDetailsPreservePartialResponseAndBodyReadDuration(t *testing.T) {
	service := newTestService(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		w.Header().Set("X-Detail", "partial-response")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		time.Sleep(70 * time.Millisecond)
		_, _ = w.Write([]byte("partial body"))
	}))
	defer upstream.Close()
	run, err := service.execution.Run(context.Background(), RunCommand{InlineRequest: &RequestData{Method: "GET", URL: upstream.URL}}, nil)
	if err == nil || run == nil {
		t.Fatal("expected persisted response read failure")
	}
	stored, err := service.repo.getRun(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != "failed" || stored.ResponseStatus == nil || *stored.ResponseStatus != 200 || stored.ResponseBody != "partial body" || stored.DurationMS < 60 {
		t.Fatalf("lost partial response or body read duration: %#v", stored)
	}
	encoded, _ := json.Marshal(stored.ResponseHeaders)
	if !strings.Contains(string(encoded), "partial-response") {
		t.Fatal("lost response headers on read failure")
	}
}

func TestRequestDetailsMarkTruncatedResponse(t *testing.T) {
	service := newTestService(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", maxStoredResponseBytes+100)))
	}))
	defer upstream.Close()
	run, err := service.execution.Run(context.Background(), RunCommand{InlineRequest: &RequestData{Method: "GET", URL: upstream.URL}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := service.repo.getRun(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	body, ok := stored.ResponseBody.(string)
	if !ok || !stored.ResponseTruncated || len(body) != maxStoredResponseBytes || stored.ResponseSize != maxStoredResponseBytes+1 {
		t.Fatal("response truncation is not represented accurately")
	}
}
