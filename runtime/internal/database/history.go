package database

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"
)

var ErrExecutionNotFound = errors.New("SQL execution not found")

// Flow execution supplies its durable IDs without changing the SQL command.
type flowOrigin struct{ flowID, runID, stepID string }
type flowOriginKey struct{}

// WithFlowOrigin associates SQL history with the exact Flow run and step.
func WithFlowOrigin(ctx context.Context, flowID, runID, stepID string) context.Context {
	return context.WithValue(ctx, flowOriginKey{}, flowOrigin{flowID, runID, stepID})
}

// Execution keeps SQL history separate from runtime logs and database credentials.
type Execution struct {
	ID             int64           `json:"id"`
	ConnectionID   string          `json:"connection_id"`
	ConnectionName string          `json:"connection_name"`
	Mode           string          `json:"mode"`
	SQL            string          `json:"sql"`
	Params         json.RawMessage `json:"params"`
	Status         string          `json:"status"`
	StartedAt      time.Time       `json:"started_at"`
	FinishedAt     *time.Time      `json:"finished_at,omitempty"`
	DurationMS     int64           `json:"duration_ms"`
	RowCount       int             `json:"row_count"`
	RowsAffected   int64           `json:"rows_affected"`
	Truncated      bool            `json:"truncated"`
	Error          string          `json:"error,omitempty"`
	FlowID         string          `json:"flow_id,omitempty"`
	FlowRunID      string          `json:"flow_run_id,omitempty"`
	StepID         string          `json:"step_id,omitempty"`
}

func (s *Service) initHistory() error {
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS database_executions (
			id INTEGER PRIMARY KEY AUTOINCREMENT, connection_id TEXT NOT NULL,
			connection_name TEXT NOT NULL, mode TEXT NOT NULL, sql_text TEXT NOT NULL,
			params TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
			finished_at TEXT NOT NULL DEFAULT '', duration_ms INTEGER NOT NULL DEFAULT 0,
			row_count INTEGER NOT NULL DEFAULT 0, rows_affected INTEGER NOT NULL DEFAULT 0,
			truncated INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_database_executions_connection ON database_executions(connection_id,id DESC)`,
	} {
		if _, err := s.store.Exec(statement); err != nil {
			return fmt.Errorf("initialize SQL execution history: %w", err)
		}
	}
	var resultColumn int
	if err := s.store.QueryRow(`SELECT count(*) FROM pragma_table_info('database_executions') WHERE name='result_json'`).Scan(&resultColumn); err != nil {
		return err
	}
	if resultColumn == 0 {
		if _, err := s.store.Exec(`ALTER TABLE database_executions ADD COLUMN result_json TEXT NOT NULL DEFAULT ''`); err != nil {
			return fmt.Errorf("migrate SQL execution results: %w", err)
		}
	}
	for _, column := range []string{"flow_id", "flow_run_id", "step_id"} {
		var exists int
		if err := s.store.QueryRow(`SELECT count(*) FROM pragma_table_info('database_executions') WHERE name=?`, column).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			if _, err := s.store.Exec(`ALTER TABLE database_executions ADD COLUMN ` + column + ` TEXT NOT NULL DEFAULT ''`); err != nil {
				return fmt.Errorf("migrate SQL execution origin: %w", err)
			}
		}
	}
	_, err := s.store.Exec(`UPDATE database_executions SET status='failed',finished_at=?,error='Runtime 重启，执行结果未确认' WHERE status='running'`, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (s *Service) beginExecution(ctx context.Context, cmd Command, started time.Time) (int64, error) {
	params := cmd.Params
	if params == nil {
		params = []any{}
	}
	data, err := json.Marshal(params)
	if err != nil {
		return 0, fmt.Errorf("%w: SQL parameters cannot be encoded", ErrInvalid)
	}
	origin, _ := ctx.Value(flowOriginKey{}).(flowOrigin)
	result, err := s.store.ExecContext(ctx, `INSERT INTO database_executions(connection_id,connection_name,mode,sql_text,params,status,started_at,flow_id,flow_run_id,step_id)
		VALUES(?,COALESCE((SELECT name FROM database_connections WHERE id=?),?),?,?,?,'running',?,?,?,?)`,
		cmd.ConnectionID, cmd.ConnectionID, cmd.ConnectionID, cmd.Mode, cmd.SQL, string(data), started.UTC().Format(time.RFC3339Nano), origin.flowID, origin.runID, origin.stepID)
	if err != nil {
		return 0, fmt.Errorf("save SQL execution history: %w", err)
	}
	return result.LastInsertId()
}

func (s *Service) finishExecution(id int64, started time.Time, result *Result, executionErr error) {
	// A cancelled query still needs its final status persisted locally.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	status, message := "succeeded", ""
	if executionErr != nil {
		status, message = "failed", executionErr.Error()
	}
	var count int
	var affected int64
	var truncated bool
	var snapshot string
	if result != nil {
		count, affected, truncated = result.RowCount, result.RowsAffected, result.Truncated
		if executionErr == nil {
			data, err := json.Marshal(result)
			if err == nil {
				snapshot = string(data)
			} else {
				log.Printf("cannot encode SQL execution result id=%d", id)
			}
		}
	}
	_, err := s.store.ExecContext(ctx, `UPDATE database_executions SET status=?,finished_at=?,duration_ms=?,row_count=?,rows_affected=?,truncated=?,error=?,result_json=? WHERE id=?`,
		status, time.Now().UTC().Format(time.RFC3339Nano), time.Since(started).Milliseconds(), count, affected, truncated, message, snapshot, id)
	if err != nil {
		// Do not turn a completed write into an execution error that invites retries.
		log.Printf("cannot finalize SQL execution history id=%d", id)
	}
}

// Results are loaded separately so polling history never transfers every row.
// A nil result means this execution has no saved snapshot (including old history).
func (s *Service) GetExecutionResult(ctx context.Context, id int64) (*Result, error) {
	var snapshot string
	err := s.store.QueryRowContext(ctx, `SELECT result_json FROM database_executions WHERE id=?`, id).Scan(&snapshot)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrExecutionNotFound
	}
	if err != nil {
		return nil, err
	}
	if snapshot == "" {
		return nil, nil
	}
	var result Result
	if err := json.Unmarshal([]byte(snapshot), &result); err != nil {
		return nil, fmt.Errorf("decode SQL execution result: %w", err)
	}
	return &result, nil
}

func (s *Service) ListExecutions(ctx context.Context, connectionID string) ([]Execution, error) {
	rows, err := s.store.QueryContext(ctx, `SELECT id,connection_id,connection_name,mode,sql_text,params,status,started_at,finished_at,duration_ms,row_count,rows_affected,truncated,error,flow_id,flow_run_id,step_id
		FROM database_executions WHERE (?='' OR connection_id=?) ORDER BY id DESC LIMIT 100`, connectionID, connectionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Execution, 0)
	for rows.Next() {
		var item Execution
		var params, started, finished string
		if err := rows.Scan(&item.ID, &item.ConnectionID, &item.ConnectionName, &item.Mode, &item.SQL, &params, &item.Status, &started, &finished, &item.DurationMS, &item.RowCount, &item.RowsAffected, &item.Truncated, &item.Error, &item.FlowID, &item.FlowRunID, &item.StepID); err != nil {
			return nil, err
		}
		item.Params = json.RawMessage(params)
		item.StartedAt, _ = time.Parse(time.RFC3339Nano, started)
		if finished != "" {
			at, _ := time.Parse(time.RFC3339Nano, finished)
			item.FinishedAt = &at
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
