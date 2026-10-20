package database

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestConnectionManagementRoutes(t *testing.T) {
	s, metadata := testService(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	s.Routes(r.Group("/api"))
	call := func(method, path, body string, status int) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		req := httptest.NewRequest(method, "/api/database"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		if w.Code != status {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
		}
		return w
	}
	call("PUT", "/connections", `{"name":" ","dsn_env":"BAD"}`, 400)
	call("PUT", "/connections", `{"name":"bad","dsn_env":"user:password@host"}`, 400)
	call("PUT", "/connections", `{"name":"bad","host":"localhost","database":"test","username":"tester","dsn_env":"REMOVED"}`, 400)
	w := call("PUT", "/connections", `{"name":"测试库 <script>","host":"localhost","database":"test","username":"tester","password":"route-secret"}`, 200)
	if strings.Contains(w.Body.String(), "password") || strings.Contains(w.Body.String(), "route-secret") {
		t.Fatal("save response leaked password")
	}
	var item Connection
	if err := json.Unmarshal(w.Body.Bytes(), &item); err != nil || item.ID == "" {
		t.Fatalf("connection=%+v err=%v", item, err)
	}
	call("PUT", "/connections", `{"id":"keep","name":"keep","host":"localhost","database":"test","username":"tester","password":""}`, 200)
	call("POST", "/connections/missing/test", "", 404)
	// An open pool must be discarded on deletion, while metadata and other
	// connections stay intact. No remote MySQL is required for this check.
	pool, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	s.pools[item.ID] = poolEntry{db: pool}
	call("DELETE", "/connections/"+item.ID, "", 204)
	if err := pool.Ping(); err == nil {
		t.Fatal("deleted connection pool is still open")
	}
	if _, ok := s.pools[item.ID]; ok {
		t.Fatal("deleted pool remains cached")
	}
	var count int
	if err := metadata.QueryRow(`SELECT count(*) FROM database_connections WHERE id='keep'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("other connection was removed: count=%d err=%v", count, err)
	}
	call("DELETE", "/connections/"+item.ID, "", 404)
	call("POST", "/connections/"+item.ID+"/test", "", 404)
	call("POST", "/execute", `{"connection_id":"`+item.ID+`","mode":"query","sql":"SELECT 1"}`, 404)
	var items []Connection
	w = call("GET", "/connections", "", 200)
	if strings.Contains(w.Body.String(), "password") {
		t.Fatal("list response leaked password")
	}
	if err := json.Unmarshal(w.Body.Bytes(), &items); err != nil || len(items) != 1 || items[0].ID != "keep" {
		t.Fatalf("list after deletion: %s err=%v", w.Body.String(), err)
	}
	if err := s.DeleteConnection(context.Background(), "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing delete: %v", err)
	}
}
