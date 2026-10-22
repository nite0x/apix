// Package journal keeps queryable runtime events and standalone tool outcomes.
package journal

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
)

type Store struct {
	db     *sql.DB
	logger *slog.Logger
	file   *os.File
}

type Event struct {
	Sequence int64           `json:"sequence"`
	Time     time.Time       `json:"time"`
	RunID    string          `json:"run_id"`
	StepID   string          `json:"step_id,omitempty"`
	Type     string          `json:"type"`
	Payload  json.RawMessage `json:"payload"`
}

type Operation struct {
	ID         string          `json:"operation_id"`
	Tool       string          `json:"tool"`
	Status     string          `json:"status"`
	StartedAt  time.Time       `json:"started_at"`
	FinishedAt *time.Time      `json:"finished_at,omitempty"`
	Result     json.RawMessage `json:"result,omitempty"`
	Error      string          `json:"error,omitempty"`
}

func New(db *sql.DB, path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	// Persist first: a desktop parent can disappear and close stderr while the
	// sidecar is still recording its shutdown and cleaning managed resources.
	s := &Store{db: db, file: f, logger: slog.New(slog.NewJSONHandler(io.MultiWriter(f, os.Stderr), nil))}
	for _, stmt := range []string{
		`CREATE TABLE IF NOT EXISTS runtime_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, run_id TEXT NOT NULL, step_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS idx_runtime_events_run ON runtime_events(run_id,sequence)`,
		`CREATE TABLE IF NOT EXISTS tool_operations(id TEXT PRIMARY KEY, tool TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, result TEXT, error TEXT NOT NULL DEFAULT '')`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			f.Close()
			return nil, err
		}
	}
	// An interrupted tool must not remain running after a runtime restart.
	_, err = db.Exec(`UPDATE tool_operations SET status='failed', finished_at=?, error='runtime restarted before operation completed' WHERE status='running'`, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		f.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.file.Close() }

// Append contains operational metadata only; request bodies and SQL parameters
// belong to results, never the runtime log.
func (s *Store) Append(kind, runID, stepID string, payload any) {
	payload = safeMetadata(payload)
	data, err := json.Marshal(payload)
	if err != nil {
		s.logger.Error("event encoding failed", "event", kind)
		return
	}
	_, err = s.db.Exec(`INSERT INTO runtime_events(time,run_id,step_id,type,payload) VALUES(?,?,?,?,?)`, time.Now().UTC().Format(time.RFC3339Nano), runID, stepID, kind, string(data))
	if err != nil {
		s.logger.Error("event persistence failed", "event", kind, "run_id", runID, "error", err.Error())
	}
	s.logger.Info(kind, "run_id", runID, "step_id", stepID, "detail", payload)
}

// Target URLs and SQL errors can contain secrets. Full errors belong to
// queryable step/operation results; runtime events carry metadata only.
func safeMetadata(payload any) any {
	values, ok := payload.(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]any{}
	for _, key := range []string{"status", "error_code", "name", "position", "type", "rule_id", "rule_name", "total_steps", "tool", "address", "mcp", "api_run_id"} {
		if value, present := values[key]; present {
			out[key] = value
		}
	}
	return out
}

func (s *Store) Events(ctx context.Context, runID string, after int64, limit int) ([]Event, error) {
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	if after < 0 {
		return nil, fmt.Errorf("after must be nonnegative")
	}
	rows, err := s.db.QueryContext(ctx, `SELECT sequence,time,run_id,step_id,type,payload FROM runtime_events WHERE (?='' OR run_id=?) AND sequence>? ORDER BY sequence LIMIT ?`, runID, runID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Event, 0)
	for rows.Next() {
		var e Event
		var ts, data string
		if err := rows.Scan(&e.Sequence, &ts, &e.RunID, &e.StepID, &e.Type, &data); err != nil {
			return nil, err
		}
		e.Time, _ = time.Parse(time.RFC3339Nano, ts)
		e.Payload = json.RawMessage(data)
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) Begin(ctx context.Context, tool string) (string, error) {
	id := uuid.NewString()
	_, err := s.db.ExecContext(ctx, `INSERT INTO tool_operations(id,tool,status,started_at) VALUES(?,?,'running',?)`, id, tool, time.Now().UTC().Format(time.RFC3339Nano))
	if err == nil {
		s.Append("tool.started", id, "", map[string]any{"tool": tool})
	}
	return id, err
}

func (s *Store) Finish(id string, result any, operationErr error) error {
	data, err := json.Marshal(result)
	if err != nil {
		return err
	}
	status, msg := "succeeded", ""
	if operationErr != nil {
		status, msg = "failed", operationErr.Error()
	}
	_, err = s.db.Exec(`UPDATE tool_operations SET status=?, finished_at=?, result=?, error=? WHERE id=?`, status, time.Now().UTC().Format(time.RFC3339Nano), string(data), msg, id)
	s.Append("tool.finished", id, "", map[string]any{"status": status})
	return err
}

func (s *Store) Get(ctx context.Context, id string) (*Operation, error) {
	var o Operation
	var start string
	var finish, result sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT id,tool,status,started_at,finished_at,result,error FROM tool_operations WHERE id=?`, id).Scan(&o.ID, &o.Tool, &o.Status, &start, &finish, &result, &o.Error)
	if err != nil {
		return nil, err
	}
	o.StartedAt, _ = time.Parse(time.RFC3339Nano, start)
	if finish.Valid {
		t, _ := time.Parse(time.RFC3339Nano, finish.String)
		o.FinishedAt = &t
	}
	if result.Valid {
		o.Result = json.RawMessage(result.String)
	}
	return &o, nil
}
