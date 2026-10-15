package app

import (
	"bytes"
	"context"
	"database/sql"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/apix/apix/runtime/internal/journal"
	"github.com/gin-gonic/gin"
	_ "modernc.org/sqlite"
)

func TestBrowserOrigins(t *testing.T) {
	t.Setenv("APIX_ALLOWED_ORIGINS", "https://example.test")
	for _, origin := range []string{"http://127.0.0.1:1420", "tauri://localhost", "https://example.test"} {
		if !allowedBrowserOrigin(origin) {
			t.Fatalf("rejected allowed origin %s", origin)
		}
	}
	for _, origin := range []string{"https://evil.test", "null", "http://localhost:1420.evil.test"} {
		if allowedBrowserOrigin(origin) {
			t.Fatalf("allowed unexpected origin %s", origin)
		}
	}
}
func TestRESTOperationHistory(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	history, err := journal.New(db, filepath.Join(t.TempDir(), "runtime.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer history.Close()
	r := gin.New()
	r.Use(recordOperations(history))
	r.POST("/api/database/execute", func(c *gin.Context) { c.JSON(200, gin.H{"row_count": 1}) })
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("POST", "/api/database/execute", bytes.NewBufferString(`{}`)))
	id := w.Header().Get("X-Apix-Operation-ID")
	if w.Code != 200 || id == "" {
		t.Fatalf("response=%d id=%s", w.Code, id)
	}
	op, err := history.Get(context.Background(), id)
	if err != nil || op.Status != "succeeded" || !bytes.Contains(op.Result, []byte("row_count")) {
		t.Fatalf("operation=%#v err=%v", op, err)
	}
}
