package httpapi

import (
	"fmt"
	"github.com/apix/apix/runtime/internal/lifecycle"
	"strings"
	"time"
)

func (r *repository) assertRequestExecutable(id string) error {
	var active bool
	err := r.db.QueryRow(`SELECT r.status='active' AND c.status='active' FROM api_requests r JOIN api_collections c ON c.id=r.collection_id WHERE r.id=?`, id).Scan(&active)
	if err != nil {
		return err
	}
	if !active {
		return fmt.Errorf("%w: 接口或所属分组已归档，请先恢复", lifecycle.ErrProtected)
	}
	return nil
}
func (r *repository) checkFlowDependencies(flow *Flow) error {
	for _, step := range flow.Steps {
		var count int
		var err error
		switch step.Type {
		case "service":
			if step.Service == nil {
				continue
			}
			if !lifecycle.Exists(r.db, "local_service_definitions") {
				continue
			} else {
				err = r.db.QueryRow(`SELECT count(*) FROM local_service_definitions WHERE id=?`, step.Service.ServiceID).Scan(&count)
			}
		case "sql":
			if step.SQL == nil {
				continue
			}
			if !lifecycle.Exists(r.db, "database_connections") {
				continue
			} else {
				err = r.db.QueryRow(`SELECT count(*) FROM database_connections WHERE id=?`, step.SQL.ConnectionID).Scan(&count)
			}
		default:
			continue
		}
		if err != nil {
			return err
		}
		kind, id := "", ""
		if step.Type == "service" {
			kind, id = "service", step.Service.ServiceID
		} else {
			kind, id = "database", step.SQL.ConnectionID
		}
		if count == 0 || lifecycle.Archived(r.db, kind, id) {
			return fmt.Errorf("%w: 步骤 %s (%s) 的 %s 依赖不存在或已归档", lifecycle.ErrProtected, step.Name, step.ID, step.Type)
		}
	}
	return nil
}
func (s *HTTPService) RestoreTestCase(id string) (*TestCase, error) {
	return s.RestoreTestCaseAs(id, "")
}
func (s *HTTPService) RestoreTestCaseAs(id, name string) (*TestCase, error) {
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	item, err := s.GetTestCase(id)
	if err != nil {
		return nil, err
	}
	if item.Type == "mcp" {
		if s.mcpClient == nil || item.MCPRequest == nil {
			return nil, invalidTest("MCP 服务器不可用")
		}
		if _, err := s.mcpClient.Get(item.MCPRequest.ServerID); err != nil {
			return nil, fmt.Errorf("%w: 请先恢复 MCP 服务器", lifecycle.ErrProtected)
		}
	}
	if name == "" {
		name = item.Name
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 512 {
		return nil, invalidTest("用例名称必填，最多512字节")
	}
	var conflict int
	if err := s.db.QueryRow(`SELECT count(*) FROM test_cases WHERE id<>? AND project_id=? AND archived=0 AND lower(trim(name))=lower(?)`, id, item.ProjectID, name).Scan(&conflict); err != nil {
		return nil, err
	}
	if conflict > 0 {
		return nil, fmt.Errorf("%w: 名称冲突，请改名后恢复", lifecycle.ErrProtected)
	}
	_, err = s.db.Exec(`UPDATE test_cases SET archived=0,name=?,edit_version=edit_version+1,updated_at=? WHERE id=? AND archived=1`, name, time.Now().UTC(), id)
	if err != nil {
		return nil, err
	}
	return s.GetTestCase(id)
}

func (r *repository) restoreCollection(id, name string) error {
	gate := lifecycle.For(r.db)
	gate.Lock()
	defer gate.Unlock()
	var original, project string
	var parent *string
	if err := r.db.QueryRow(`SELECT name,project_id,parent_id FROM api_collections WHERE id=?`, id).Scan(&original, &project, &parent); err != nil {
		return err
	}
	if name == "" {
		name = original
	}
	name = strings.TrimSpace(name)
	var n int
	if parent != nil {
		if err := r.db.QueryRow(`SELECT count(*) FROM api_collections WHERE id=? AND status='active'`, *parent).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("%w: 请先恢复父分组", lifecycle.ErrProtected)
		}
	}
	if err := r.db.QueryRow(`SELECT count(*) FROM api_collections WHERE project_id=? AND parent_id IS ? AND id<>? AND status='active' AND lower(trim(name))=lower(?)`, project, parent, id, name).Scan(&n); err != nil {
		return err
	}
	if name == "" || n > 0 {
		return fmt.Errorf("%w: 名称冲突，请改名后恢复", lifecycle.ErrProtected)
	}
	_, err := r.db.Exec(`UPDATE api_collections SET status='active',archived_at=NULL,name=?,updated_at=? WHERE id=?`, name, time.Now().UTC(), id)
	return err
}
func (r *repository) restoreRequest(id, collection, name string) (*APIRequest, error) {
	gate := lifecycle.For(r.db)
	gate.Lock()
	defer gate.Unlock()
	item, err := r.getRequest(id)
	if err != nil {
		return nil, err
	}
	if collection == "" {
		collection = item.CollectionID
	}
	if name == "" {
		name = item.Name
	}
	name = strings.TrimSpace(name)
	var n int
	if err := r.db.QueryRow(`SELECT count(*) FROM api_collections target JOIN api_collections source ON source.id=? WHERE target.id=? AND target.status='active' AND target.project_id=source.project_id`, item.CollectionID, collection).Scan(&n); err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, fmt.Errorf("%w: 请恢复所属分组或选择有效分组", lifecycle.ErrProtected)
	}
	if err := r.db.QueryRow(`SELECT count(*) FROM api_requests WHERE collection_id=? AND id<>? AND status='active' AND lower(trim(name))=lower(?)`, collection, id, name).Scan(&n); err != nil {
		return nil, err
	}
	if name == "" || n > 0 {
		return nil, fmt.Errorf("%w: 名称冲突，请改名后恢复", lifecycle.ErrProtected)
	}
	if _, err := r.db.Exec(`UPDATE api_requests SET status='active',archived_at=NULL,collection_id=?,name=?,updated_at=? WHERE id=?`, collection, name, time.Now().UTC(), id); err != nil {
		return nil, err
	}
	return r.getRequest(id)
}
func (r *repository) archivedRequests(project string) ([]APIRequest, error) {
	rows, err := r.db.Query(`SELECT r.id FROM api_requests r JOIN api_collections c ON c.id=r.collection_id WHERE c.project_id=? AND (r.status='archived' OR c.status='archived') ORDER BY r.updated_at DESC`, project)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	items := []APIRequest{}
	for _, id := range ids {
		item, err := r.getRequest(id)
		if err != nil {
			return nil, err
		}
		items = append(items, *item)
	}
	return items, nil
}

func (s *HTTPService) caseSourceStatus(item *TestCase) {
	if item.APIRequestID == nil {
		var source string
		if s.db.QueryRow(`SELECT source_id FROM resource_source_links WHERE owner_kind='test_case' AND owner_id=?`, item.ID).Scan(&source) == nil {
			item.SourceStatus = "detached"
		}
		return
	}
	item.SourceStatus = "deleted"
	_ = s.db.QueryRow(`SELECT CASE WHEN r.status='archived' THEN 'archived' WHEN c.status='archived' THEN 'collection_archived' ELSE 'active' END FROM api_requests r JOIN api_collections c ON c.id=r.collection_id WHERE r.id=?`, *item.APIRequestID).Scan(&item.SourceStatus)
}

func (r *repository) enrichFlow(flow *Flow) {
	flow.Dependencies = []FlowDependency{}
	for i := range flow.Steps {
		step := &flow.Steps[i]
		kind, id, table := "", "", ""
		if step.Service != nil {
			kind, id, table = "service", step.Service.ServiceID, "local_service_definitions"
		} else if step.SQL != nil {
			kind, id, table = "database", step.SQL.ConnectionID, "database_connections"
		}
		if kind != "" {
			d := FlowDependency{Kind: kind, ID: id, StepID: step.ID, Step: step.Name, Status: "deleted"}
			if lifecycle.Exists(r.db, table) {
				query := `SELECT name FROM database_connections WHERE id=?`
				if kind == "service" {
					query = `SELECT json_extract(data,'$.name') FROM local_service_definitions WHERE id=?`
				}
				if err := r.db.QueryRow(query, id).Scan(&d.Name); err == nil {
					d.Status = "active"
					if lifecycle.Archived(r.db, kind, id) {
						d.Status = "archived"
					}
				}
			}
			flow.Dependencies = append(flow.Dependencies, d)
		}
		if step.SourceAPIRequestID == nil {
			var source string
			if r.db.QueryRow(`SELECT source_id FROM resource_source_links WHERE owner_kind='flow_step' AND owner_id=?`, step.ID).Scan(&source) == nil {
				step.SourceStatus = "detached"
			}
		}
		if step.SourceAPIRequestID != nil {
			step.SourceStatus = "deleted"
			_ = r.db.QueryRow(`SELECT CASE WHEN a.status='archived' OR c.status='archived' THEN 'archived' ELSE 'active' END FROM api_requests a JOIN api_collections c ON c.id=a.collection_id WHERE a.id=?`, *step.SourceAPIRequestID).Scan(&step.SourceStatus)
		}
	}
}
