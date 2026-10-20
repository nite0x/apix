package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/apix/apix/runtime/internal/database"
	"github.com/apix/apix/runtime/internal/lifecycle"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type LifecycleResource struct {
	Kind     string `json:"kind"`
	ID       string `json:"id"`
	Name     string `json:"name"`
	Summary  string `json:"summary"`
	Archived bool   `json:"archived"`
}
type LifecycleOperation struct {
	Kind         string `json:"kind"`
	ID           string `json:"id"`
	Action       string `json:"action"`
	Name         string `json:"name,omitempty"`
	CollectionID string `json:"collection_id,omitempty"`
	Token        string `json:"token,omitempty"`
}
type LifecycleResult struct {
	Kind   string `json:"kind"`
	ID     string `json:"id"`
	Action string `json:"action"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
	NewID  string `json:"new_id,omitempty"`
}
type PurgePreview struct {
	Token             string    `json:"token"`
	Kind              string    `json:"kind"`
	ID                string    `json:"id"`
	Name              string    `json:"name"`
	HistoricalRecords int       `json:"historical_records_preserved"`
	ExpiresAt         time.Time `json:"expires_at"`
}

func migrateBulkLifecycle(s *HTTPService) error {
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS purge_previews(token TEXT PRIMARY KEY,kind TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,expires_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS resource_source_links(owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,source_id TEXT NOT NULL,source_name TEXT NOT NULL,PRIMARY KEY(owner_kind,owner_id))`,
	} {
		if _, err := s.db.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}
func (s *HTTPService) LifecycleResources(kind, project string, archived bool) ([]LifecycleResource, error) {
	out := []LifecycleResource{}
	add := func(id, name, summary string) {
		out = append(out, LifecycleResource{Kind: kind, ID: id, Name: name, Summary: summary, Archived: archived})
	}
	switch kind {
	case "service":
		if s.flow.services == nil {
			return out, nil
		}
		items, err := s.flow.services.ListArchivedDefinitions(context.Background(), archived)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			add(item.ID, item.Name, item.Command+" · "+item.HealthURL)
		}
	case "database":
		db, ok := s.flow.database.(*database.Service)
		if !ok {
			return out, nil
		}
		items, err := db.ListArchivedConnections(context.Background(), archived)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			add(item.ID, item.Name, item.Type+" · "+item.Host+" / "+item.Database)
		}
	case "mcp":
		if s.mcpClient == nil {
			return out, nil
		}
		items, err := s.mcpClient.ListArchived(archived)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			add(item.ID, item.Name, item.URL)
		}
	case "test_case":
		items, err := s.listTestCases(project, archived)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			add(item.ID, item.Name, item.Type)
		}
	case "flow":
		items, err := s.repo.listFlowSummaries(project, true)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			if (item.ArchivedAt != nil) == archived {
				add(item.ID, item.Name, fmt.Sprintf("%d 个步骤", item.StepCount))
			}
		}
	case "collection":
		state := "active"
		if archived {
			state = "archived"
		}
		items, err := s.repo.listCollectionsState(valueOr(project, defaultProjectID), state)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			add(item.ID, item.Name, item.Description)
		}
	case "request":
		groups, err := s.repo.listCollectionsState(valueOr(project, defaultProjectID), "active")
		if err != nil {
			return nil, err
		}
		if archived {
			items, err := s.repo.archivedRequests(valueOr(project, defaultProjectID))
			if err != nil {
				return nil, err
			}
			for _, item := range items {
				add(item.ID, item.Name, item.Request.Method+" "+item.Request.URL)
			}
		} else {
			for _, g := range groups {
				items, err := s.repo.listRequests(g.ID)
				if err != nil {
					return nil, err
				}
				for _, item := range items {
					add(item.ID, item.Name, item.Request.Method+" "+item.Request.URL)
				}
			}
		}
	default:
		return nil, fmt.Errorf("%w: 未知资源类型", errValidation)
	}
	return out, nil
}

// validatePurge is always called under the shared lifecycle lock.
func (s *HTTPService) validatePurge(kind, id string) (name, fingerprint string, history int, err error) {
	query, archivedQuery, historyQuery := "", "", ""
	switch kind {
	case "service":
		query = `SELECT json_extract(data,'$.name'),data FROM local_service_definitions WHERE id=?`
		archivedQuery = `SELECT COALESCE((SELECT archived FROM resource_lifecycle WHERE kind='service' AND id=?),0)`
		historyQuery = `SELECT (SELECT count(*) FROM local_service_logs WHERE service_id=?1)+(SELECT count(*) FROM test_case_runs WHERE type='service' AND json_extract(execution_data,'$.execution_input.service_id')=?1)+(SELECT count(*) FROM flow_run_steps WHERE json_extract(service_snapshot,'$.service_id')=?1)`
	case "database":
		query = `SELECT c.name,json_object('name',c.name,'host',d.host,'port',d.port,'database',d.database_name,'username',d.username,'driver',d.driver_type,'ssl',d.ssl_mode,'credentials',hex(d.password_encrypted)) FROM database_connections c LEFT JOIN database_connection_settings d ON d.connection_id=c.id WHERE c.id=?`
		archivedQuery = `SELECT COALESCE((SELECT archived FROM resource_lifecycle WHERE kind='database' AND id=?),0)`
		historyQuery = `SELECT count(*) FROM database_executions WHERE connection_id=?`
	case "mcp":
		query = `SELECT name,json_object('name',name,'url',url,'headers',hex(headers),'timeout',timeout_seconds,'version',edit_version) FROM mcp_servers WHERE id=?`
		archivedQuery = `SELECT archived FROM mcp_servers WHERE id=?`
		historyQuery = `SELECT count(*) FROM test_case_runs WHERE json_extract(mcp_data,'$.mcp_request_snapshot.server_id')=?`
	case "test_case":
		query = `SELECT name,json_object('name',name,'version',edit_version,'request',request_data,'mcp',mcp_data,'command',command_data,'assertions',assertions) FROM test_cases WHERE id=?`
		archivedQuery = `SELECT archived FROM test_cases WHERE id=?`
		historyQuery = `SELECT count(*) FROM test_case_runs WHERE case_id=?`
	case "flow":
		query = `SELECT name,json_object('name',name,'version',edit_version) FROM flows WHERE id=?`
		archivedQuery = `SELECT archived_at IS NOT NULL FROM flows WHERE id=?`
		historyQuery = `SELECT count(*) FROM flow_runs WHERE flow_id=?`
	case "request":
		query = `SELECT name,json_object('name',name,'method',method,'url',url,'query',query_params,'headers',headers,'body',body,'auth',auth_config,'collection',collection_id,'updated',updated_at) FROM api_requests WHERE id=?`
		archivedQuery = `SELECT status='archived' FROM api_requests WHERE id=?`
		historyQuery = `SELECT count(*) FROM api_runs WHERE api_request_id=?`
	case "collection":
		query = `SELECT name,json_object('name',name,'parent',parent_id,'updated',updated_at) FROM api_collections WHERE id=?`
		archivedQuery = `SELECT status='archived' FROM api_collections WHERE id=?`
		historyQuery = `SELECT 0 WHERE ? IS NOT NULL`
	default:
		err = fmt.Errorf("%w: 未知资源类型", errValidation)
		return
	}
	var raw string
	if err = s.db.QueryRow(query, id).Scan(&name, &raw); err != nil {
		return
	}
	var archived bool
	if err = s.db.QueryRow(archivedQuery, id).Scan(&archived); err != nil {
		return
	}
	if !archived {
		err = fmt.Errorf("%w: 请先归档资源，再彻底删除", lifecycle.ErrProtected)
		return
	}
	if err = lifecycle.PurgeReferences(s.db, kind, id); err != nil {
		return
	}
	var busy int
	switch kind {
	case "flow":
		err = s.db.QueryRow(`SELECT count(*) FROM flow_runs WHERE flow_id=? AND finished_at IS NULL`, id).Scan(&busy)
	case "test_case":
		err = s.db.QueryRow(`SELECT count(*) FROM test_case_runs WHERE case_id=? AND status='running'`, id).Scan(&busy)
	case "request":
		err = s.db.QueryRow(`SELECT count(*) FROM api_runs WHERE api_request_id=? AND status='running'`, id).Scan(&busy)
	case "collection":
		err = s.db.QueryRow(`SELECT (SELECT count(*) FROM api_requests WHERE collection_id=?)+(SELECT count(*) FROM api_collections WHERE parent_id=?)`, id, id).Scan(&busy)
	}
	if err != nil {
		return
	}
	if busy > 0 {
		err = fmt.Errorf("%w: 仍有运行占用或包含的接口/子分组，请先处理", lifecycle.ErrProtected)
		return
	}
	if historyQuery != "" {
		if err = s.db.QueryRow(historyQuery, id).Scan(&history); err != nil {
			return
		}
	}
	sum := sha256.Sum256([]byte(raw))
	fingerprint = hex.EncodeToString(sum[:])
	return
}
func (s *HTTPService) PreviewPurge(kind, id string) (*PurgePreview, error) {
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	name, fingerprint, history, err := s.validatePurge(kind, id)
	if err != nil {
		return nil, err
	}
	v := &PurgePreview{Kind: kind, ID: id, Name: name, Token: uuid.NewString(), HistoricalRecords: history, ExpiresAt: time.Now().UTC().Add(10 * time.Minute)}
	_, err = s.db.Exec(`INSERT INTO purge_previews(token,kind,id,fingerprint,expires_at) VALUES(?,?,?,?,?)`, v.Token, kind, id, fingerprint, v.ExpiresAt.Format(time.RFC3339Nano))
	return v, err
}
func (s *HTTPService) purgeResource(kind, id, token string) error {
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	var expected, expires string
	if err := s.db.QueryRow(`SELECT fingerprint,expires_at FROM purge_previews WHERE token=? AND kind=? AND id=?`, token, kind, id).Scan(&expected, &expires); err != nil {
		return fmt.Errorf("%w: 请先预览彻底删除范围", lifecycle.ErrProtected)
	}
	if expires < time.Now().UTC().Format(time.RFC3339Nano) {
		return fmt.Errorf("%w: 预览已过期，请重新预览", lifecycle.ErrProtected)
	}
	name, fingerprint, _, err := s.validatePurge(kind, id)
	if err != nil {
		return err
	}
	if fingerprint != expected {
		return fmt.Errorf("%w: 配置已变化，请重新预览", lifecycle.ErrProtected)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	exec := func(q string, args ...any) error { _, err := tx.Exec(q, args...); return err }
	switch kind {
	case "service":
		err = exec(`DELETE FROM local_service_definitions WHERE id=?`, id)
	case "database":
		if err = exec(`DELETE FROM database_connection_settings WHERE connection_id=?`, id); err == nil {
			err = exec(`DELETE FROM database_connections WHERE id=?`, id)
		}
	case "mcp":
		if err = exec(`DELETE FROM mcp_discoveries WHERE server_id=?`, id); err == nil {
			err = exec(`DELETE FROM mcp_servers WHERE id=?`, id)
		}
	case "test_case":
		if err = exec(`UPDATE test_case_runs SET case_id=NULL WHERE case_id=?`, id); err == nil {
			err = exec(`DELETE FROM test_cases WHERE id=?`, id)
		}
	case "flow":
		if err = exec(`UPDATE flow_runs SET flow_id=NULL WHERE flow_id=?`, id); err == nil {
			err = exec(`DELETE FROM flows WHERE id=?`, id)
		}
	case "request":
		err = exec(`DELETE FROM api_requests WHERE id=?`, id)
	case "collection":
		err = exec(`DELETE FROM api_collections WHERE id=?`, id)
	}
	if err != nil {
		return err
	}
	if err = exec(`INSERT INTO resource_lifecycle(kind,id,name,archived) VALUES(?,?,?,1) ON CONFLICT(kind,id) DO UPDATE SET name=excluded.name,archived=1`, kind, id, name); err != nil {
		return err
	}
	if err = exec(`DELETE FROM purge_previews WHERE token=?`, token); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *HTTPService) ApplyLifecycle(ctx context.Context, op LifecycleOperation) (string, error) {
	if op.ID == "" {
		return "", fmt.Errorf("%w: id 必填", errValidation)
	}
	if op.Action == "purge" {
		return "", s.purgeResource(op.Kind, op.ID, op.Token)
	}
	if op.Action == "detach_sources" && op.Kind == "request" {
		return "", s.detachRequestSources(op.ID)
	}
	switch op.Kind {
	case "service":
		if s.flow.services == nil {
			break
		}
		switch op.Action {
		case "archive":
			return "", s.flow.services.ArchiveDefinition(ctx, op.ID)
		case "restore":
			_, err := s.flow.services.RestoreDefinition(ctx, op.ID, op.Name)
			return "", err
		case "duplicate":
			d, err := s.flow.services.Details(ctx, op.ID)
			if err != nil {
				return "", err
			}
			copy := d.Definition
			copy.ID = ""
			copy.EditVersion = 0
			copy.Name += " · 副本"
			copy.Archived = false
			saved, err := s.flow.services.PutDefinition(ctx, copy)
			if err != nil {
				return "", err
			}
			return saved.ID, nil
		}
	case "database":
		db, ok := s.flow.database.(*database.Service)
		if !ok {
			break
		}
		switch op.Action {
		case "archive":
			return "", db.ArchiveConnection(ctx, op.ID)
		case "restore":
			return "", db.RestoreConnection(ctx, op.ID, op.Name)
		case "duplicate":
			for _, archived := range []bool{false, true} {
				items, err := db.ListArchivedConnections(ctx, archived)
				if err != nil {
					return "", err
				}
				for _, d := range items {
					if d.ID == op.ID {
						d.ID = ""
						d.EditVersion = 0
						d.Name += " · 副本"
						d.Archived = false
						d.CredentialsCleared = true
						saved, err := db.SaveConnection(ctx, database.ConnectionInput{Connection: d})
						if err != nil {
							return "", err
						}
						return saved.ID, nil
					}
				}
			}
			return "", errNotFound
		}
	case "mcp":
		if s.mcpClient == nil {
			break
		}
		switch op.Action {
		case "archive":
			return "", s.mcpClient.Archive(op.ID)
		case "restore":
			_, err := s.mcpClient.Restore(ctx, op.ID, op.Name)
			return "", err
		case "duplicate":
			items, err := s.mcpClient.ListArchived(false)
			if err != nil {
				return "", err
			}
			archived, err := s.mcpClient.ListArchived(true)
			if err != nil {
				return "", err
			}
			for _, d := range append(items, archived...) {
				if d.ID == op.ID {
					d.ID = ""
					d.EditVersion = 0
					d.Name += " · 副本"
					d.Headers = map[string]string{}
					d.Archived = false
					saved, err := s.mcpClient.Save(d)
					if err != nil {
						return "", err
					}
					return saved.ID, nil
				}
			}
			return "", errNotFound
		}
	case "test_case":
		switch op.Action {
		case "archive":
			if _, err := s.GetTestCase(op.ID); err != nil {
				return "", err
			}
			return "", s.ArchiveTestCase(op.ID)
		case "restore":
			_, err := s.RestoreTestCaseAs(op.ID, op.Name)
			return "", err
		case "duplicate":
			item, err := s.GetTestCase(op.ID)
			if err != nil {
				return "", err
			}
			item.ID = ""
			item.Name += " · 副本"
			item.Archived = false
			item.NeedsReview = false
			saved, err := s.SaveTestCase(*item)
			if err != nil {
				return "", err
			}
			return saved.ID, nil
		}
	case "flow":
		switch op.Action {
		case "archive":
			if _, err := s.repo.getFlow(op.ID); err != nil {
				return "", err
			}
			return "", s.repo.archiveFlow(op.ID)
		case "restore":
			_, err := s.repo.restoreFlowAs(op.ID, op.Name)
			return "", err
		case "duplicate":
			flow, err := s.repo.duplicateFlow(op.ID)
			if err != nil {
				return "", err
			}
			return flow.ID, nil
		}
	case "request":
		switch op.Action {
		case "archive":
			item, err := s.repo.getRequest(op.ID)
			if err != nil {
				return "", err
			}
			if item.Status == "archived" {
				return "", nil
			}
			return "", s.repo.archiveRequest(op.ID)
		case "restore":
			_, err := s.repo.restoreRequest(op.ID, op.CollectionID, op.Name)
			return "", err
		case "duplicate":
			item, err := s.repo.getRequest(op.ID)
			if err != nil {
				return "", err
			}
			item.ID = ""
			item.Name += " · 副本"
			item.Status = "active"
			item.ArchivedAt = nil
			if op.CollectionID != "" {
				item.CollectionID = op.CollectionID
			}
			if err := s.repo.createRequest(item); err != nil {
				return "", err
			}
			return item.ID, nil
		}
	case "collection":
		switch op.Action {
		case "archive":
			return "", s.repo.archiveCollection(op.ID)
		case "restore":
			return "", s.repo.restoreCollection(op.ID, op.Name)
		}
	}
	return "", fmt.Errorf("%w: 此资源不支持该操作", errValidation)
}
func (s *HTTPService) BatchLifecycle(ctx context.Context, ops []LifecycleOperation) ([]LifecycleResult, error) {
	if len(ops) == 0 || len(ops) > 100 {
		return nil, fmt.Errorf("%w: 每批需包含 1–100 项操作", errValidation)
	}
	out := []LifecycleResult{}
	seen := map[string]bool{}
	for _, op := range ops {
		r := LifecycleResult{Kind: op.Kind, ID: op.ID, Action: op.Action, Status: "succeeded"}
		key := op.Kind + ":" + op.ID
		err := ctx.Err()
		if seen[key] {
			err = fmt.Errorf("同一批次中的资源 ID 重复")
		}
		seen[key] = true
		if err == nil {
			r.NewID, err = s.ApplyLifecycle(ctx, op)
		}
		if err != nil {
			r.Status = "failed"
			r.Error = err.Error()
		}
		out = append(out, r)
	}
	return out, nil
}
func (s *HTTPService) detachRequestSources(id string) error {
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	item, err := s.repo.getRequest(id)
	if err != nil {
		return err
	}
	if item.Status != "archived" {
		return fmt.Errorf("%w: 请先归档来源接口", lifecycle.ErrProtected)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range []string{
		`INSERT OR REPLACE INTO resource_source_links(owner_kind,owner_id,source_id,source_name) SELECT 'test_case',id,api_request_id,? FROM test_cases WHERE api_request_id=?`,
		`INSERT OR REPLACE INTO resource_source_links(owner_kind,owner_id,source_id,source_name) SELECT 'flow_step',id,source_api_request_id,? FROM flow_steps WHERE source_api_request_id=?`,
		`INSERT OR REPLACE INTO resource_source_links(owner_kind,owner_id,source_id,source_name) SELECT 'draft',id,api_request_id,? FROM api_working_copies WHERE api_request_id=?`,
	} {
		if _, err := tx.Exec(q, item.Name, id); err != nil {
			return err
		}
	}
	for _, q := range []string{
		`UPDATE flows SET edit_version=edit_version+1,updated_at=datetime('now') WHERE id IN(SELECT flow_id FROM flow_steps WHERE source_api_request_id=?)`,
		`UPDATE test_cases SET api_request_id=NULL,edit_version=edit_version+1,updated_at=datetime('now') WHERE api_request_id=?`,
		`UPDATE flow_steps SET source_api_request_id=NULL WHERE source_api_request_id=?`,
		`UPDATE api_working_copies SET api_request_id=NULL,base_content_hash=NULL,edit_version=edit_version+1,updated_at=datetime('now') WHERE api_request_id=?`,
	} {
		if _, err := tx.Exec(q, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (s *HTTPService) bulkLifecycleRoutes(r gin.IRouter) {
	r.GET("/lifecycle/resources", func(c *gin.Context) {
		items, err := s.LifecycleResources(c.Query("kind"), c.Query("project_id"), c.Query("archived") == "true")
		if err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(200, items)
	})
	r.POST("/lifecycle/actions", func(c *gin.Context) {
		var in struct {
			Items []LifecycleOperation `json:"items"`
		}
		if err := c.ShouldBindJSON(&in); err != nil {
			writeBadRequest(c, err)
			return
		}
		items, err := s.BatchLifecycle(c.Request.Context(), in.Items)
		if err != nil {
			writeBadRequest(c, err)
			return
		}
		c.JSON(200, gin.H{"items": items})
	})
	r.POST("/lifecycle/:kind/:id/purge-preview", func(c *gin.Context) {
		v, err := s.PreviewPurge(c.Param("kind"), c.Param("id"))
		if err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(200, v)
	})
}
