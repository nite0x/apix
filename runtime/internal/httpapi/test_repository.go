package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

func testSchemaStatements() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS test_batches (
		 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
		 status TEXT NOT NULL CHECK(status IN ('running','completed','interrupted')),
		 created_at DATETIME NOT NULL, finished_at DATETIME)`,
		`CREATE INDEX IF NOT EXISTS idx_test_batches_recent ON test_batches(project_id,created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS test_cases (
		 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
		 api_request_id TEXT REFERENCES api_requests(id) ON DELETE SET NULL,
		 name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', request_data TEXT NOT NULL,
		 expected_status INTEGER, assertions TEXT NOT NULL DEFAULT '[]', edit_version INTEGER NOT NULL DEFAULT 1,
		 archived INTEGER NOT NULL DEFAULT 0, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS idx_test_cases_recent ON test_cases(project_id,archived,updated_at DESC)`,
		`CREATE TABLE IF NOT EXISTS test_case_runs (
		 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES test_batches(id),
		 case_id TEXT REFERENCES test_cases(id), case_version INTEGER NOT NULL DEFAULT 0,
		 name TEXT NOT NULL, request_snapshot TEXT NOT NULL, expected_status INTEGER,
		 assertion_definitions TEXT NOT NULL DEFAULT '[]', assertions TEXT NOT NULL DEFAULT '[]',
		 api_run_id TEXT REFERENCES api_runs(id) ON DELETE SET NULL,
		 status TEXT NOT NULL CHECK(status IN ('running','passed','failed','error','unverified')),
		 error_message TEXT NOT NULL DEFAULT '', started_at DATETIME NOT NULL, finished_at DATETIME)`,
		`CREATE INDEX IF NOT EXISTS idx_test_case_runs_batch ON test_case_runs(batch_id,started_at,id)`,
		`CREATE INDEX IF NOT EXISTS idx_test_case_runs_case ON test_case_runs(case_id,started_at DESC)`,
	}
}

func migrateV4toV5(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, statement := range testSchemaStatements() {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`UPDATE schema_metadata SET version=5,updated_at=datetime('now') WHERE name='http_domain'`); err != nil {
		return err
	}
	return tx.Commit()
}

var errInvalidTest = errors.New("invalid test")

func invalidTest(message string) error { return fmt.Errorf("%w: %s", errInvalidTest, message) }

func validateTestCase(item *TestCase) error {
	item.Name = strings.TrimSpace(item.Name)
	if item.Name == "" || len(item.Name) > 512 {
		return invalidTest("case name is required (up to 512 bytes)")
	}
	normalizeRequest(&item.Request)
	if item.Request.URL == "" {
		return invalidTest("request.url is required")
	}
	if !map[string]bool{"GET": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true, "HEAD": true, "OPTIONS": true}[item.Request.Method] {
		return invalidTest("unsupported HTTP method")
	}
	if item.ExpectedStatus != nil && (*item.ExpectedStatus < 100 || *item.ExpectedStatus > 599) {
		return invalidTest("expected_status must be between 100 and 599")
	}
	if len(item.Assertions) > 100 {
		return invalidTest("at most 100 assertions are allowed")
	}
	for _, a := range item.Assertions {
		if a.Source != "status" && a.Source != "header" && a.Source != "body" {
			return invalidTest("assertion source must be status, header or body")
		}
		if a.Source == "header" && strings.TrimSpace(a.Path) == "" {
			return invalidTest("header assertion requires a path")
		}
		if a.Operator != "equals" && a.Operator != "not_equals" && a.Operator != "contains" && a.Operator != "exists" {
			return invalidTest("unsupported assertion operator")
		}
	}
	if item.Assertions == nil {
		item.Assertions = []FlowAssertion{}
	}
	if item.ProjectID == "" {
		item.ProjectID = defaultProjectID
	}
	return nil
}

func (s *HTTPService) SaveTestCase(item TestCase) (*TestCase, error) {
	if err := validateTestCase(&item); err != nil {
		return nil, err
	}
	if item.APIRequestID != nil {
		if err := s.repo.assertRequestInProject(*item.APIRequestID, item.ProjectID); err != nil {
			return nil, invalidTest(err.Error())
		}
	}
	now := time.Now().UTC()
	if item.ID == "" {
		item.ID, item.EditVersion, item.CreatedAt, item.UpdatedAt = uuid.NewString(), 1, now, now
		_, err := s.db.Exec(`INSERT INTO test_cases(id,project_id,api_request_id,name,description,request_data,expected_status,assertions,edit_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, item.ID, item.ProjectID, item.APIRequestID, item.Name, item.Description, marshalJSON(item.Request), item.ExpectedStatus, marshalJSON(item.Assertions), 1, now, now)
		if err != nil {
			return nil, err
		}
		return &item, nil
	}
	if item.EditVersion < 1 {
		return nil, invalidTest("edit_version is required when updating a case")
	}
	result, err := s.db.Exec(`UPDATE test_cases SET api_request_id=?,name=?,description=?,request_data=?,expected_status=?,assertions=?,edit_version=edit_version+1,updated_at=? WHERE id=? AND project_id=? AND edit_version=? AND archived=0`, item.APIRequestID, item.Name, item.Description, marshalJSON(item.Request), item.ExpectedStatus, marshalJSON(item.Assertions), now, item.ID, item.ProjectID, item.EditVersion)
	if err != nil {
		return nil, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if changed == 0 {
		if _, err := s.GetTestCase(item.ID); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("%w: test case changed; reload before saving", errConflict)
	}
	return s.GetTestCase(item.ID)
}

const testCaseColumns = `id,project_id,api_request_id,name,description,request_data,expected_status,assertions,edit_version,created_at,updated_at`

func scanTestCase(row interface{ Scan(...any) error }) (*TestCase, error) {
	var item TestCase
	var request, assertions string
	if err := row.Scan(&item.ID, &item.ProjectID, &item.APIRequestID, &item.Name, &item.Description, &request, &item.ExpectedStatus, &assertions, &item.EditVersion, &item.CreatedAt, &item.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errNotFound
		}
		return nil, err
	}
	if err := json.Unmarshal([]byte(request), &item.Request); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(assertions), &item.Assertions); err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *HTTPService) GetTestCase(id string) (*TestCase, error) {
	return scanTestCase(s.db.QueryRow(`SELECT `+testCaseColumns+` FROM test_cases WHERE id=? AND archived=0`, id))
}
func (s *HTTPService) ListTestCases(project string) ([]TestCase, error) {
	rows, err := s.db.Query(`SELECT `+testCaseColumns+` FROM test_cases WHERE project_id=? AND archived=0 ORDER BY updated_at DESC,id LIMIT 500`, valueOr(project, defaultProjectID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []TestCase{}
	for rows.Next() {
		item, err := scanTestCase(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *item)
	}
	return items, rows.Err()
}
func (s *HTTPService) ArchiveTestCase(id string) error {
	_, err := s.db.Exec(`UPDATE test_cases SET archived=1,updated_at=? WHERE id=?`, time.Now().UTC(), id)
	return err
}

func (s *HTTPService) BeginTestBatch(project, name string) (*TestBatch, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 512 {
		return nil, invalidTest("batch name is required (up to 512 bytes)")
	}
	item := &TestBatch{ID: uuid.NewString(), ProjectID: valueOr(project, defaultProjectID), Name: name, Status: "running", CreatedAt: time.Now().UTC()}
	_, err := s.db.Exec(`INSERT INTO test_batches(id,project_id,name,status,created_at) VALUES(?,?,?,'running',?)`, item.ID, item.ProjectID, item.Name, item.CreatedAt)
	return item, err
}

const batchColumns = `b.id,b.project_id,b.name,b.status,b.created_at,b.finished_at,
 (SELECT count(*) FROM test_case_runs r WHERE r.batch_id=b.id),
 (SELECT count(*) FROM test_case_runs r WHERE r.batch_id=b.id AND r.status='running'),
 (SELECT count(*) FROM test_case_runs r WHERE r.batch_id=b.id AND r.status='passed'),
 (SELECT count(*) FROM test_case_runs r WHERE r.batch_id=b.id AND r.status='failed'),
 (SELECT count(*) FROM test_case_runs r WHERE r.batch_id=b.id AND r.status='error'),
 (SELECT count(*) FROM test_case_runs r WHERE r.batch_id=b.id AND r.status='unverified')`

func scanTestBatch(row interface{ Scan(...any) error }) (*TestBatch, error) {
	var b TestBatch
	err := row.Scan(&b.ID, &b.ProjectID, &b.Name, &b.Status, &b.CreatedAt, &b.FinishedAt, &b.Counts.Total, &b.Counts.Running, &b.Counts.Passed, &b.Counts.Failed, &b.Counts.Errors, &b.Counts.Unverified)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNotFound
	}
	return &b, err
}
func (s *HTTPService) ListTestBatches(project string) ([]TestBatch, error) {
	rows, err := s.db.Query(`SELECT `+batchColumns+` FROM test_batches b WHERE b.project_id=? ORDER BY b.created_at DESC,b.id LIMIT 100`, valueOr(project, defaultProjectID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []TestBatch{}
	for rows.Next() {
		item, err := scanTestBatch(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *item)
	}
	return items, rows.Err()
}
func (s *HTTPService) GetTestBatch(id string) (*TestBatch, error) {
	b, err := scanTestBatch(s.db.QueryRow(`SELECT `+batchColumns+` FROM test_batches b WHERE b.id=?`, id))
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(`SELECT id,batch_id,case_id,case_version,name,request_snapshot,expected_status,assertion_definitions,assertions,api_run_id,status,error_message,started_at,finished_at FROM test_case_runs WHERE batch_id=? ORDER BY started_at,id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	b.Runs = []TestCaseRun{}
	for rows.Next() {
		var r TestCaseRun
		var request, defs, results string
		if err := rows.Scan(&r.ID, &r.BatchID, &r.CaseID, &r.CaseVersion, &r.Name, &request, &r.ExpectedStatus, &defs, &results, &r.APIRunID, &r.Status, &r.ErrorMessage, &r.StartedAt, &r.FinishedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(request), &r.RequestSnapshot); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(defs), &r.AssertionDefinitions); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(results), &r.Assertions); err != nil {
			return nil, err
		}
		b.Runs = append(b.Runs, r)
	}
	return b, rows.Err()
}

func (s *HTTPService) FinishTestBatch(id string) (*TestBatch, error) {
	// One SQLite statement arbitrates against concurrent reservations. A batch
	// cannot close while a request is in flight or waiting at a pause rule.
	result, err := s.db.Exec(`UPDATE test_batches SET status='completed',finished_at=? WHERE id=? AND status='running' AND NOT EXISTS(SELECT 1 FROM test_case_runs WHERE batch_id=? AND status='running')`, time.Now().UTC(), id, id)
	if err != nil {
		return nil, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	b, err := s.GetTestBatch(id)
	if err != nil {
		return nil, err
	}
	if n == 0 && b.Status != "completed" {
		return nil, fmt.Errorf("%w: batch has running cases or was interrupted", errConflict)
	}
	if n > 0 {
		if s.testBatchFinished != nil {
			s.testBatchFinished(b)
		}
		s.flow.emit("test_batch.finished", b.ID, "", map[string]any{"name": b.Name, "status": b.Status})
	}
	return b, nil
}
