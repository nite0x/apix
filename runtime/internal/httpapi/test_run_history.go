package httpapi

import "time"

type TestRunSummary struct {
	ID         string     `json:"id"`
	BatchID    string     `json:"batch_id"`
	BatchName  string     `json:"batch_name"`
	Type       string     `json:"type"`
	Name       string     `json:"name"`
	Target     string     `json:"target"`
	Status     string     `json:"status"`
	DurationMS int64      `json:"duration_ms"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

func (s *HTTPService) ListTestRuns(project, kind string) ([]TestRunSummary, error) {
	if kind != "mcp" && kind != "command" {
		return nil, invalidTest("type must be mcp or command")
	}
	rows, err := s.db.Query(`SELECT r.id,r.batch_id,b.name,r.type,r.name,r.status,r.started_at,r.finished_at,
 CASE WHEN r.type='command' THEN COALESCE(json_extract(r.command_data,'$.command_request_snapshot.program'),'')
 ELSE COALESCE(json_extract(r.mcp_data,'$.mcp_request_snapshot.tool_name'),'') END,
 COALESCE(json_extract(r.command_data,'$.command_result.duration_ms'),json_extract(r.mcp_data,'$.mcp_result.duration_ms'),0)
 FROM test_case_runs r JOIN test_batches b ON b.id=r.batch_id
 WHERE b.project_id=? AND r.type=? ORDER BY r.started_at DESC,r.id DESC LIMIT 200`, valueOr(project, defaultProjectID), kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []TestRunSummary{}
	for rows.Next() {
		var item TestRunSummary
		if err := rows.Scan(&item.ID, &item.BatchID, &item.BatchName, &item.Type, &item.Name, &item.Status, &item.StartedAt, &item.FinishedAt, &item.Target, &item.DurationMS); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *HTTPService) GetTestRun(id string) (*TestCaseRun, error) {
	return scanTestRun(s.db.QueryRow(`SELECT id,batch_id,case_id,case_version,name,request_snapshot,expected_status,assertion_definitions,assertions,api_run_id,status,error_message,started_at,finished_at,type,mcp_data,command_data,execution_data FROM test_case_runs WHERE id=?`, id))
}
