package httpapi

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/apix/apix/runtime/internal/lifecycle"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type RecordQuery struct {
	Hidden                                            bool
	Query, Type, ExecutionType, Status, After, Before string
	Offset, Limit                                     int
}
type RecordPage struct {
	Items  []TestBatch `json:"items"`
	Total  int         `json:"total"`
	Offset int         `json:"offset"`
	Limit  int         `json:"limit"`
}
type CleanupPreview struct {
	Token       string    `json:"token"`
	BatchID     string    `json:"batch_id"`
	Name        string    `json:"name"`
	Runs        int       `json:"runs"`
	HTTPRecords int       `json:"http_records"`
	SQLRecords  int       `json:"sql_records"`
	ExpiresAt   time.Time `json:"expires_at"`
}
type cleanupPlan struct {
	BatchID     string   `json:"batch_id"`
	Source      string   `json:"source"`
	API         []string `json:"api"`
	SQL         []int64  `json:"sql"`
	Fingerprint string   `json:"fingerprint"`
}

func migrateRecordManagement(db *sql.DB) error {
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS execution_lifecycle(id TEXT PRIMARY KEY,hidden INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE IF NOT EXISTS cleanup_previews(token TEXT PRIMARY KEY,plan TEXT NOT NULL,expires_at TEXT NOT NULL)`,
	} {
		if _, err := db.Exec(q); err != nil {
			return err
		}
	}
	return nil
}
func (s *HTTPService) recordState(b *TestBatch) {
	_ = s.db.QueryRow(`SELECT hidden,pinned FROM execution_lifecycle WHERE id=?`, b.ID).Scan(&b.Hidden, &b.IsPinned)
}
func (s *HTTPService) ListRecords(project string, q RecordQuery) (*RecordPage, error) {
	var after, before time.Time
	var parseErr error
	if q.After != "" {
		after, parseErr = time.Parse(time.RFC3339Nano, q.After)
		if parseErr != nil {
			return nil, invalidTest("开始时间需为 RFC3339 格式")
		}
	}
	if q.Before != "" {
		before, parseErr = time.Parse(time.RFC3339Nano, q.Before)
		if parseErr != nil {
			return nil, invalidTest("结束时间需为 RFC3339 格式")
		}
	}
	if !after.IsZero() && !before.IsZero() && after.After(before) {
		return nil, invalidTest("开始时间不能晚于结束时间")
	}

	items, err := s.listAllTestBatches(project)
	if err != nil {
		return nil, err
	}
	out := []TestBatch{}
	for _, b := range items {
		s.recordState(&b)
		if b.Hidden != q.Hidden || q.Type != "" && q.Type != "all" && q.Type != b.Source && !(q.Type == "collection" && b.Source == "") || q.Status != "" && q.Status != b.Status {
			continue
		}
		if !after.IsZero() && b.CreatedAt.Before(after) || !before.IsZero() && b.CreatedAt.After(before) {
			continue
		}
		if q.ExecutionType != "" {
			if q.ExecutionType != "http" && q.ExecutionType != "sql" && q.ExecutionType != "mcp" && q.ExecutionType != "command" && q.ExecutionType != "service" {
				return nil, invalidTest("未知执行类型")
			}
			var found int
			if b.Source == "flow" {
				err = s.db.QueryRow(`SELECT count(*) FROM flow_run_steps WHERE flow_run_id=? AND type=?`, b.ID, q.ExecutionType).Scan(&found)
			} else {
				err = s.db.QueryRow(`SELECT count(*) FROM test_case_runs WHERE batch_id=? AND type=?`, b.ID, q.ExecutionType).Scan(&found)
			}
			if err != nil {
				return nil, err
			}
			if found == 0 {
				continue
			}
		}
		if q.Query != "" {
			var found int
			needle := "%" + strings.ToLower(q.Query) + "%"
			if strings.Contains(strings.ToLower(b.Name+" "+b.ID), strings.ToLower(q.Query)) {
				found = 1
			} else if b.Source == "flow" {
				err = s.db.QueryRow(`SELECT count(*) FROM flow_run_steps WHERE flow_run_id=? AND lower(name_snapshot||request_snapshot||COALESCE(sql_snapshot,'')||COALESCE(service_snapshot,'')) LIKE ?`, b.ID, needle).Scan(&found)
			} else {
				err = s.db.QueryRow(`SELECT count(*) FROM test_case_runs WHERE batch_id=? AND lower(name||request_snapshot||mcp_data||command_data||execution_data) LIKE ?`, b.ID, needle).Scan(&found)
			}
			if err != nil {
				return nil, err
			}
			if found == 0 {
				continue
			}
		}
		out = append(out, b)
	}
	if q.Limit <= 0 || q.Limit > 200 {
		q.Limit = 50
	}
	if q.Offset < 0 {
		q.Offset = 0
	}
	total := len(out)
	start := q.Offset
	if start > total {
		start = total
	}
	end := start + q.Limit
	if end > total {
		end = total
	}
	return &RecordPage{Items: out[start:end], Total: total, Offset: q.Offset, Limit: q.Limit}, nil
}
func (s *HTTPService) SetRecordState(id string, hidden, pinned *bool) error {
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	b, err := s.GetTestBatch(id)
	if err != nil {
		return err
	}
	if hidden != nil && (b.Status == "running" || b.Counts.Running > 0 || b.FinishedAt == nil || s.flow.services != nil && s.flow.services.OwnerBusy(b.ID)) {
		return fmt.Errorf("%w: 执行或清理尚未完成，不能隐藏", lifecycle.ErrProtected)
	}
	if hidden != nil {
		b.Hidden = *hidden
	}
	if pinned != nil {
		b.IsPinned = *pinned
	}
	_, err = s.db.Exec(`INSERT INTO execution_lifecycle(id,hidden,pinned) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET hidden=excluded.hidden,pinned=excluded.pinned`, id, b.Hidden, b.IsPinned)
	return err
}

// cleanupPlan is re-created at execution time under the lifecycle lock. A
// preview is not authorization to remove newly pinned or still-running data.
func (s *HTTPService) planCleanup(id string) (*cleanupPlan, *TestBatch, error) {
	b, err := s.GetTestBatch(id)
	if err != nil {
		return nil, nil, err
	}
	if b.Status == "running" || b.Counts.Running > 0 || b.FinishedAt == nil || b.IsPinned || s.flow.services != nil && s.flow.services.OwnerBusy(b.ID) {
		return nil, nil, fmt.Errorf("%w: 执行/清理未完成或整组已固定", lifecycle.ErrProtected)
	}
	p := &cleanupPlan{BatchID: id, Source: b.Source, API: []string{}, SQL: []int64{}}
	rows, err := s.db.Query(`SELECT id FROM api_runs WHERE session_id=? OR id IN(SELECT api_run_id FROM test_case_runs WHERE batch_id=? UNION SELECT api_run_id FROM flow_run_steps WHERE flow_run_id=?) ORDER BY id`, id, id, id)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return nil, nil, err
		}
		p.API = append(p.API, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, err
	}
	for _, apiID := range p.API {
		var n int
		err = s.db.QueryRow(`SELECT count(*) FROM api_runs a WHERE a.id=? AND (a.is_pinned=1 OR a.status='running' OR EXISTS(SELECT 1 FROM test_case_runs t WHERE t.api_run_id=a.id AND t.batch_id<>?) OR EXISTS(SELECT 1 FROM flow_run_steps f WHERE f.api_run_id=a.id AND f.flow_run_id<>?))`, apiID, id, id).Scan(&n)
		if err != nil {
			return nil, nil, err
		}
		if n > 0 {
			return nil, nil, fmt.Errorf("%w: 底层 HTTP 记录已固定、执行中或被其他批次引用", lifecycle.ErrProtected)
		}
	}
	if lifecycle.Exists(s.db, "database_executions") {
		rows, err := s.db.Query(`SELECT id FROM database_executions WHERE flow_run_id=? OR id IN(SELECT COALESCE(json_extract(execution_data,'$.execution_result.execution_id'),json_extract(execution_data,'$.execution_input.execution_id')) FROM test_case_runs WHERE batch_id=?) ORDER BY id`, id, id)
		if err != nil {
			return nil, nil, err
		}
		for rows.Next() {
			var v int64
			if err := rows.Scan(&v); err != nil {
				rows.Close()
				return nil, nil, err
			}
			p.SQL = append(p.SQL, v)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, nil, err
		}
		for _, sqlID := range p.SQL {
			var status string
			if err := s.db.QueryRow(`SELECT status FROM database_executions WHERE id=?`, sqlID).Scan(&status); err != nil {
				return nil, nil, err
			}
			if status == "running" {
				return nil, nil, fmt.Errorf("%w: SQL 执行未完成", lifecycle.ErrProtected)
			}
		}
	}
	raw, err := json.Marshal(b)
	if err != nil {
		return nil, nil, err
	}
	sum := sha256.Sum256(raw)
	p.Fingerprint = hex.EncodeToString(sum[:])
	return p, b, nil
}
func (s *HTTPService) PreviewCleanup(id string) (*CleanupPreview, error) {
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	p, b, err := s.planCleanup(id)
	if err != nil {
		return nil, err
	}
	v := &CleanupPreview{Token: uuid.NewString(), BatchID: id, Name: b.Name, Runs: b.Counts.Total, HTTPRecords: len(p.API), SQLRecords: len(p.SQL), ExpiresAt: time.Now().UTC().Add(10 * time.Minute)}
	_, err = s.db.Exec(`INSERT INTO cleanup_previews(token,plan,expires_at) VALUES(?,?,?)`, v.Token, marshalJSON(p), v.ExpiresAt.Format(time.RFC3339Nano))
	return v, err
}
func (s *HTTPService) CleanupRecord(token string) error {
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	return s.cleanupRecordLocked(token)
}
func (s *HTTPService) cleanupRecordLocked(token string) error {
	var raw, expires string
	if err := s.db.QueryRow(`SELECT plan,expires_at FROM cleanup_previews WHERE token=?`, token).Scan(&raw, &expires); err != nil {
		return err
	}
	if expires < time.Now().UTC().Format(time.RFC3339Nano) {
		return fmt.Errorf("%w: 清理预览已过期，请重新预览", lifecycle.ErrProtected)
	}
	var expected cleanupPlan
	if err := json.Unmarshal([]byte(raw), &expected); err != nil {
		return err
	}
	current, _, err := s.planCleanup(expected.BatchID)
	if err != nil {
		return err
	}
	if marshalJSON(current) != raw {
		return fmt.Errorf("%w: 记录状态已变化，请重新预览", lifecycle.ErrProtected)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	id := current.BatchID
	if current.Source == "flow" {
		if _, err = tx.Exec(`DELETE FROM flow_run_steps WHERE flow_run_id=?`, id); err != nil {
			return err
		}
		if _, err = tx.Exec(`DELETE FROM flow_runs WHERE id=?`, id); err != nil {
			return err
		}
	} else {
		if _, err = tx.Exec(`DELETE FROM test_case_runs WHERE batch_id=?`, id); err != nil {
			return err
		}
		if _, err = tx.Exec(`DELETE FROM test_batches WHERE id=?`, id); err != nil {
			return err
		}
	}
	for _, v := range current.API {
		if _, err = tx.Exec(`DELETE FROM api_runs WHERE id=?`, v); err != nil {
			return err
		}
	}
	for _, v := range current.SQL {
		if _, err = tx.Exec(`DELETE FROM database_executions WHERE id=?`, v); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(`DELETE FROM execution_lifecycle WHERE id=?`, id); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM cleanup_previews WHERE token=?`, token); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *HTTPService) recordManagementRoutes(r gin.IRouter) {
	r.GET("/execution-records", func(c *gin.Context) {
		q := RecordQuery{Hidden: c.Query("hidden") == "true", Query: c.Query("q"), Type: c.Query("type"), ExecutionType: c.Query("execution_type"), Status: c.Query("status"), After: c.Query("after"), Before: c.Query("before")}
		q.Limit, _ = strconv.Atoi(c.Query("limit"))
		q.Offset, _ = strconv.Atoi(c.Query("offset"))
		page, err := s.ListRecords(c.Query("project_id"), q)
		if err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(200, page)
	})
	r.PATCH("/execution-records/:id", func(c *gin.Context) {
		var in struct {
			Hidden *bool `json:"hidden"`
			Pinned *bool `json:"is_pinned"`
		}
		if err := c.ShouldBindJSON(&in); err != nil {
			writeBadRequest(c, err)
			return
		}
		if err := s.SetRecordState(c.Param("id"), in.Hidden, in.Pinned); err != nil {
			writeAPIError(c, err)
			return
		}
		c.Status(204)
	})
	r.POST("/execution-records/:id/cleanup-preview", func(c *gin.Context) {
		v, err := s.PreviewCleanup(c.Param("id"))
		if err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(200, v)
	})
	r.POST("/execution-records/cleanup", func(c *gin.Context) {
		var in struct {
			Token string `json:"token"`
		}
		if err := c.ShouldBindJSON(&in); err != nil {
			writeBadRequest(c, err)
			return
		}
		if err := s.CleanupRecord(in.Token); err != nil {
			writeAPIError(c, err)
			return
		}
		c.Status(204)
	})
}
