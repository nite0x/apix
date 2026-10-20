package journal

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestDurableResultsEventsAndRecovery(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	path := filepath.Join(t.TempDir(), "runtime.log")
	s, err := New(db, path)
	if err != nil {
		t.Fatal(err)
	}
	id, err := s.Begin(context.Background(), "sql")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Finish(id, map[string]any{"row_count": 1}, nil); err != nil {
		t.Fatal(err)
	}
	s.Append("step.failed", "run", "step", map[string]any{"status": "failed", "error_code": "request_failed", "error_message": "token=secret-token-value"})
	events, err := s.Events(context.Background(), "run", 0, 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("events=%#v err=%v", events, err)
	}
	if strings.Contains(string(events[0].Payload), "secret-token") {
		t.Fatal("credentials entered event history")
	}
	if later, err := s.Events(context.Background(), "run", events[0].Sequence, 10); err != nil || len(later) != 0 {
		t.Fatal("cursor did not filter events")
	}
	interrupted, err := s.Begin(context.Background(), "service")
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = New(db, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	op, err := s.Get(context.Background(), id)
	if err != nil || op.Status != "succeeded" || !strings.Contains(string(op.Result), "row_count") {
		t.Fatalf("operation=%#v err=%v", op, err)
	}
	op, err = s.Get(context.Background(), interrupted)
	if err != nil || op.Status != "failed" || op.FinishedAt == nil {
		t.Fatalf("unfinished operation=%#v err=%v", op, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "secret-token-value") {
		t.Fatal("credentials entered log file")
	}
}
