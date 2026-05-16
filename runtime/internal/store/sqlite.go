package store

import (
	"database/sql"
	"encoding/json"
	"log"
	"time"

	"github.com/sentris/sentris/runtime/internal/core"
	_ "modernc.org/sqlite"
)

type SQLiteStore struct {
	db *sql.DB
}

func NewSQLiteStore(path string) *SQLiteStore {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		log.Fatal(err)
	}
	db.Exec(`PRAGMA foreign_keys = ON`) //nolint:errcheck
	s := &SQLiteStore{db: db}
	s.migrate()
	return s
}

func (s *SQLiteStore) migrate() {
	// ── core ─────────────────────────────────────────────────────────
	s.db.Exec(`CREATE TABLE IF NOT EXISTS sessions (
		id         TEXT PRIMARY KEY,
		type       TEXT,
		status     TEXT,
		task       TEXT,
		source     TEXT,
		variables  TEXT,
		created_at DATETIME,
		updated_at DATETIME
	)`) //nolint:errcheck
	s.db.Exec(`CREATE TABLE IF NOT EXISTS steps (
		id          TEXT PRIMARY KEY,
		session_id  TEXT,
		idx         INTEGER,
		type        TEXT,
		status      TEXT,
		tool        TEXT,
		input       TEXT,
		output      TEXT,
		thought     TEXT,
		error       TEXT,
		rule_id     TEXT,
		duration_ms INTEGER,
		started_at  DATETIME,
		ended_at    DATETIME
	)`) //nolint:errcheck
	s.db.Exec(`CREATE TABLE IF NOT EXISTS rules (
		id   TEXT PRIMARY KEY,
		data TEXT
	)`) //nolint:errcheck

}

// DB exposes the underlying connection for HTTP schema migrations during startup.
func (s *SQLiteStore) DB() *sql.DB { return s.db }

func (s *SQLiteStore) SaveSession(sess *core.Session) {
	vars, _ := json.Marshal(sess.Variables)
	s.db.Exec(`INSERT OR REPLACE INTO sessions
		(id, type, status, task, source, variables, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		sess.ID, sess.Type, sess.Status, sess.Task, sess.Source,
		string(vars), sess.CreatedAt, time.Now(),
	)
}

func (s *SQLiteStore) GetSession(id string) (*core.Session, bool) {
	row := s.db.QueryRow(`SELECT id, type, status, task, source, variables, created_at, updated_at FROM sessions WHERE id = ?`, id)
	sess := &core.Session{}
	var vars string
	err := row.Scan(&sess.ID, &sess.Type, &sess.Status, &sess.Task, &sess.Source, &vars, &sess.CreatedAt, &sess.UpdatedAt)
	if err != nil {
		return nil, false
	}
	sess.Variables = core.NewVariables()
	json.Unmarshal([]byte(vars), sess.Variables) //nolint:errcheck
	return sess, true
}

func (s *SQLiteStore) ListSessions() []*core.Session {
	rows, err := s.db.Query(`SELECT id, type, status, task, source, created_at, updated_at FROM sessions ORDER BY created_at DESC LIMIT 50`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var list []*core.Session
	for rows.Next() {
		sess := &core.Session{Variables: core.NewVariables()}
		rows.Scan(&sess.ID, &sess.Type, &sess.Status, &sess.Task, &sess.Source, &sess.CreatedAt, &sess.UpdatedAt) //nolint:errcheck
		list = append(list, sess)
	}
	return list
}

func (s *SQLiteStore) SaveStep(step *core.Step) {
	input, _ := json.Marshal(step.Input)
	output, _ := json.Marshal(step.Output)
	s.db.Exec(`INSERT OR REPLACE INTO steps
		(id, session_id, idx, type, status, tool, input, output,
		 thought, error, rule_id, duration_ms, started_at, ended_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		step.ID, step.SessionID, step.Index, step.Type, step.Status,
		step.Tool, string(input), string(output),
		step.Thought, step.Error, step.RuleID, step.DurationMs,
		step.StartedAt, step.EndedAt,
	)
}

func (s *SQLiteStore) LoadRules() []*core.Rule {
	rows, err := s.db.Query(`SELECT data FROM rules`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var rules []*core.Rule
	for rows.Next() {
		var data string
		rows.Scan(&data) //nolint:errcheck
		var r core.Rule
		if json.Unmarshal([]byte(data), &r) == nil {
			rules = append(rules, &r)
		}
	}
	return rules
}

func (s *SQLiteStore) SaveRules(rules []*core.Rule) {
	s.db.Exec(`DELETE FROM rules`)
	for _, r := range rules {
		data, _ := json.Marshal(r)
		s.db.Exec(`INSERT INTO rules (id, data) VALUES (?, ?)`, r.ID, string(data))
	}
}
