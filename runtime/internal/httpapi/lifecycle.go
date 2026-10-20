package httpapi

import (
	"fmt"
	"github.com/apix/apix/runtime/internal/lifecycle"
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
		if count == 0 {
			return fmt.Errorf("%w: 步骤 %s (%s) 的 %s 依赖不存在或已归档", lifecycle.ErrProtected, step.Name, step.ID, step.Type)
		}
	}
	return nil
}
func (s *HTTPService) RestoreTestCase(id string) (*TestCase, error) {
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
	_, err = s.db.Exec(`UPDATE test_cases SET archived=0,edit_version=edit_version+1,updated_at=? WHERE id=? AND archived=1`, time.Now().UTC(), id)
	if err != nil {
		return nil, err
	}
	return s.GetTestCase(id)
}
