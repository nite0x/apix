// Package lifecycle coordinates definition changes with execution snapshots.
package lifecycle

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
)

var ErrProtected = errors.New("resource is protected")

type Reference struct {
	Kind     string `json:"kind"`
	ID       string `json:"id"`
	Name     string `json:"name"`
	StepID   string `json:"step_id,omitempty"`
	Step     string `json:"step,omitempty"`
	Archived bool   `json:"archived"`
	Running  bool   `json:"running"`
}
type State struct {
	sync.Mutex
	busy map[string]int
}

var states sync.Map

func For(db *sql.DB) *State {
	v, _ := states.LoadOrStore(db, &State{busy: map[string]int{}})
	return v.(*State)
}

// Lease reserves use before loading configuration. Mutations take the same lock.
func Lease(db *sql.DB, kind, id string) func() {
	s := For(db)
	key := kind + ":" + id
	s.Lock()
	s.busy[key]++
	s.Unlock()
	return func() {
		s.Lock()
		defer s.Unlock()
		s.busy[key]--
		if s.busy[key] == 0 {
			delete(s.busy, key)
		}
	}
}
func Exists(db *sql.DB, table string) bool {
	var n int
	return db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&n) == nil && n > 0
}

// References includes disabled steps and archived definitions. Historical snapshots
// only block changes while their execution (including cleanup) is unfinished.
func References(db *sql.DB, kind, id string) ([]Reference, error) {
	out := []Reference{}
	collect := func(query string, args ...any) error {
		rows, err := db.Query(query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var r Reference
			if err := rows.Scan(&r.Kind, &r.ID, &r.Name, &r.StepID, &r.Step, &r.Archived, &r.Running); err != nil {
				return err
			}
			out = append(out, r)
		}
		return rows.Err()
	}
	if (kind == "service" || kind == "database") && Exists(db, "flow_steps") {
		column, path := "service_data", "$.service_id"
		if kind == "database" {
			column, path = "sql_data", "$.connection_id"
		}
		if err := collect(`SELECT 'flow',f.id,f.name,s.id,s.name,f.archived_at IS NOT NULL,0 FROM flow_steps s JOIN flows f ON f.id=s.flow_id WHERE json_extract(s.`+column+`,?)=?`, path, id); err != nil {
			return nil, err
		}
		column = "service_snapshot"
		if kind == "database" {
			column = "sql_snapshot"
		}
		if err := collect(`SELECT 'flow_run',r.id,r.flow_name_snapshot,s.id,s.name_snapshot,0,1 FROM flow_run_steps s JOIN flow_runs r ON r.id=s.flow_run_id WHERE r.finished_at IS NULL AND json_extract(s.`+column+`,?)=?`, path, id); err != nil {
			return nil, err
		}
	}
	if kind == "mcp" && Exists(db, "test_cases") {
		if err := collect(`SELECT 'test_case',id,name,'','',archived,0 FROM test_cases WHERE type='mcp' AND json_extract(mcp_data,'$.mcp_request.server_id')=?`, id); err != nil {
			return nil, err
		}
		if err := collect(`SELECT 'test_run',id,name,'','',0,1 FROM test_case_runs WHERE status='running' AND json_extract(mcp_data,'$.mcp_request_snapshot.server_id')=?`, id); err != nil {
			return nil, err
		}
	}
	if kind == "request" && Exists(db, "test_cases") {
		if err := collect(`SELECT 'draft',id,name,'','',status<>'active',0 FROM api_working_copies WHERE api_request_id=?`, id); err != nil {
			return nil, err
		}
		if err := collect(`SELECT 'test_case',id,name,'','',archived,0 FROM test_cases WHERE api_request_id=?`, id); err != nil {
			return nil, err
		}
		if err := collect(`SELECT 'flow',f.id,f.name,s.id,s.name,f.archived_at IS NOT NULL,0 FROM flow_steps s JOIN flows f ON f.id=s.flow_id WHERE s.source_api_request_id=?`, id); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// Check must be called with For(db) locked. definitions=false permits edits
// between executions, while still protecting queued steps and in-flight calls.
func Check(db *sql.DB, kind, id string, definitions bool) error {
	if For(db).busy[kind+":"+id] > 0 {
		return fmt.Errorf("%w: %s 正在使用中，请等待执行完成", ErrProtected, id)
	}
	refs, err := References(db, kind, id)
	if err != nil {
		return err
	}
	names := []string{}
	for _, r := range refs {
		if r.Running || (definitions && !r.Archived) {
			names = append(names, r.Name+" / "+r.Step+" ("+r.ID+")")
		}
	}
	if len(names) > 0 {
		return fmt.Errorf("%w: 请先处理引用：%s", ErrProtected, strings.Join(names, "；"))
	}
	return nil
}
