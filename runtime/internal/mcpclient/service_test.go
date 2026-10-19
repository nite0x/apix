package mcpclient

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	_ "modernc.org/sqlite"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testService(t *testing.T) (*Service, *sql.DB) {
	t.Helper()
	db, e := sql.Open("sqlite", filepath.Join(t.TempDir(), "apix.db"))
	if e != nil {
		t.Fatal(e)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	s, e := New(db)
	if e != nil {
		t.Fatal(e)
	}
	return s, db
}
func fixture(t *testing.T) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	calls := &atomic.Int32{}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-secret" {
			w.WriteHeader(401)
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(204)
			return
		}
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		var in struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params map[string]any  `json:"params"`
		}
		if json.NewDecoder(r.Body).Decode(&in) != nil {
			w.WriteHeader(400)
			return
		}
		if in.Method != "initialize" && r.Header.Get("Mcp-Session-Id") != "test-session" {
			t.Error("missing negotiated session")
			w.WriteHeader(400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if len(in.ID) == 0 {
			w.WriteHeader(202)
			return
		}
		var out any
		switch in.Method {
		case "initialize":
			w.Header().Set("Mcp-Session-Id", "test-session")
			out = map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "fixture", "version": "1"}}
		case "tools/list":
			if in.Params["cursor"] == "page2" {
				out = map[string]any{"tools": []any{map[string]any{"name": "protocol", "inputSchema": map[string]any{"type": "object"}}}}
			} else {
				out = map[string]any{"tools": []any{map[string]any{"name": "echo", "description": "fixture tool", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"name": map[string]any{"type": "string"}}}}}, "nextCursor": "page2"}
			}
		case "tools/call":
			calls.Add(1)
			if in.Params["name"] == "protocol" {
				json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": in.ID, "error": map[string]any{"code": -32602, "message": "test-secret invalid arguments"}})
				return
			}
			out = map[string]any{"content": []any{map[string]any{"type": "text", "text": "hello"}}, "structuredContent": in.Params["arguments"], "isError": false}
			w.Header().Set("Content-Type", "text/event-stream")
			b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": in.ID, "result": out})
			fmt.Fprintf(w, "event: message\ndata: %s\n\n", b)
			return
		default:
			w.WriteHeader(405)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": in.ID, "result": out})
	}))
	t.Cleanup(target.Close)
	return target, calls
}
func TestStreamableHTTPDiscoveryCallsAndCredentialStorage(t *testing.T) {
	s, db := testService(t)
	target, calls := fixture(t)
	saved, e := s.Save(Server{Name: "Fixture", URL: target.URL, Headers: map[string]string{"Authorization": "Bearer test-secret"}, TimeoutSeconds: 2})
	if e != nil {
		t.Fatal(e)
	}
	if saved.Headers["Authorization"] != Mask {
		t.Fatal("credential exposed")
	}
	var encrypted []byte
	if e = db.QueryRow("SELECT headers FROM mcp_servers WHERE id=?", saved.ID).Scan(&encrypted); e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(encrypted), "test-secret") {
		t.Fatal("unencrypted credential")
	}
	var seq int
	var name, path string
	if e = db.QueryRow("PRAGMA database_list").Scan(&seq, &name, &path); e != nil {
		t.Fatal(e)
	}
	keyBefore, e := os.ReadFile(path + ".credentials.key")
	if e != nil {
		t.Fatal(e)
	}
	restarted, e := New(db)
	if e != nil {
		t.Fatal(e)
	}
	info, e := restarted.Discover(context.Background(), saved.ID)
	if e != nil || len(info.Tools) != 2 || info.ServerName != "fixture" {
		t.Fatalf("discovery: %#v %v", info, e)
	}
	if calls.Load() != 0 {
		t.Fatal("discovery invoked tool")
	}
	result := s.Call(context.Background(), Request{ServerID: saved.ID, ToolName: "echo", Arguments: map[string]any{"name": "Ada"}})
	if result.ErrorKind != "" || result.Response == nil || result.Tool["name"] != "echo" || calls.Load() != 1 {
		t.Fatalf("call: %#v", result)
	}
	protocol := s.Call(context.Background(), Request{ServerID: saved.ID, ToolName: "protocol"})
	if protocol.ErrorKind != "protocol" || protocol.Response != nil || calls.Load() != 2 {
		t.Fatalf("protocol error/retry: %#v", protocol)
	}
	redacted, _ := json.Marshal(Redact(protocol, protocol.Secrets))
	if strings.Contains(string(redacted), "test-secret") {
		t.Fatal("protocol error leaked credential")
	}
	saved.Name = "Updated"
	updated, e := s.Save(*saved)
	if e != nil || updated.EditVersion != 2 {
		t.Fatalf("update %v %v", updated, e)
	}
	if _, e = s.Save(*saved); e != ErrConflict {
		t.Fatalf("stale write %v", e)
	}
	if _, e = s.Discover(context.Background(), saved.ID); e != nil {
		t.Fatal("masked credential was overwritten", e)
	}
	keyAfter, _ := os.ReadFile(path + ".credentials.key")
	if string(keyBefore) != string(keyAfter) {
		t.Fatal("credential key changed")
	}
	if e = s.Archive(saved.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Get(saved.ID); e != ErrNotFound {
		t.Fatal("archived server is visible")
	}
}
func TestConnectionValidationTimeoutAndRedaction(t *testing.T) {
	s, _ := testService(t)
	for _, url := range []string{"file:///tmp/test", "https://user:password@example.test/mcp", "https://example.test/mcp?token=secret", "https://example.test/mcp?api-key=secret"} {
		if _, e := s.Save(Server{Name: "bad", URL: url}); e == nil {
			t.Fatalf("accepted %s", url)
		}
	}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	}))
	defer target.Close()
	saved, e := s.Save(Server{Name: "Slow", URL: target.URL, TimeoutSeconds: 1})
	if e != nil {
		t.Fatal(e)
	}
	started := time.Now()
	result := s.Call(context.Background(), Request{ServerID: saved.ID, ToolName: "any"})
	if result.ErrorKind != "timeout" || time.Since(started) > 2*time.Second {
		t.Fatalf("timeout %#v %s", result, time.Since(started))
	}
	value := Redact(map[string]any{"content": []any{map[string]any{"text": `{"token":"hidden","ok":true}`}}, "other": "Bearer auth-secret"}, []string{"auth-secret"})
	raw, _ := json.Marshal(value)
	if strings.Contains(string(raw), "hidden") || strings.Contains(string(raw), "auth-secret") {
		t.Fatal("redaction failed", string(raw))
	}
}
