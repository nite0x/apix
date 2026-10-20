package httpapi

import "sort"

// Project flow history into batches without changing execution or cleanup.
func (s *HTTPService) getFlowBatch(id string) (*TestBatch, error) {
	run, err := s.repo.getFlowRun(id)
	if err != nil {
		return nil, err
	}
	batch := &TestBatch{ID: run.ID, Source: "flow", ProjectID: run.ProjectID, Name: run.FlowNameSnapshot,
		CreatedAt: run.CreatedAt, FinishedAt: run.FinishedAt, Status: "running", Runs: []TestCaseRun{}}
	if run.Status == "succeeded" || run.Status == "failed" || run.Status == "cancelled" {
		batch.Status = "completed"
	}
	for _, step := range run.Steps {
		status := "unverified"
		switch step.Status {
		case "pending", "running", "paused":
			status = "running"
		case "failed", "cancelled":
			status = "error"
			if step.ErrorCode == "assertion_failed" {
				status = "failed"
			}
		case "succeeded":
			if len(step.Assertions) > 0 {
				status = "passed"
			}
			for _, assertion := range step.Assertions {
				if !assertion.Passed {
					status = "failed"
				}
			}
		}
		started := run.CreatedAt
		if step.StartedAt != nil {
			started = *step.StartedAt
		}
		item := TestCaseRun{ID: step.ID, BatchID: run.ID, Type: step.Type, Name: step.NameSnapshot,
			RequestSnapshot: step.RequestSnapshot, APIRunID: step.APIRunID, Assertions: step.Assertions,
			Status: status, StartedAt: started, FinishedAt: step.FinishedAt, ErrorMessage: step.ErrorMessage}
		if step.SQLSnapshot != nil {
			item.Input = step.SQLSnapshot
		}
		if step.ServiceSnapshot != nil {
			item.Input = step.ServiceSnapshot
		}
		item.Result = step.Result
		if step.Status == "skipped" {
			item.ErrorMessage = "该步骤已跳过"
		}
		batch.Runs = append(batch.Runs, item)
		batch.Counts.Total++
		switch status {
		case "running":
			batch.Counts.Running++
		case "passed":
			batch.Counts.Passed++
		case "failed":
			batch.Counts.Failed++
		case "error":
			batch.Counts.Errors++
		default:
			batch.Counts.Unverified++
		}
	}
	return batch, nil
}

func (s *HTTPService) appendFlowBatches(project string, items []TestBatch) ([]TestBatch, error) {
	rows, err := s.db.Query(`WITH outcomes AS (
 SELECT flow_run_id, CASE
 WHEN status IN ('pending','running','paused') THEN 'running'
 WHEN status='failed' AND error_code='assertion_failed' THEN 'failed'
 WHEN status IN ('failed','cancelled') THEN 'error'
 WHEN status='succeeded' AND json_array_length(assertions)>0 THEN 'passed'
 ELSE 'unverified' END AS outcome
 FROM flow_run_steps
 )
 SELECT f.id,f.project_id,f.flow_name_snapshot,
 CASE WHEN f.status IN ('succeeded','failed','cancelled') THEN 'completed' ELSE 'running' END,
 f.created_at,f.finished_at,
 (SELECT count(*) FROM outcomes s WHERE s.flow_run_id=f.id),
 (SELECT count(*) FROM outcomes s WHERE s.flow_run_id=f.id AND outcome='running'),
 (SELECT count(*) FROM outcomes s WHERE s.flow_run_id=f.id AND outcome='passed'),
 (SELECT count(*) FROM outcomes s WHERE s.flow_run_id=f.id AND outcome='failed'),
 (SELECT count(*) FROM outcomes s WHERE s.flow_run_id=f.id AND outcome='error'),
 (SELECT count(*) FROM outcomes s WHERE s.flow_run_id=f.id AND outcome='unverified')
 FROM flow_runs f WHERE f.project_id=? ORDER BY f.created_at DESC,f.id LIMIT 100`, valueOr(project, defaultProjectID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		batch, err := scanTestBatch(rows)
		if err != nil {
			return nil, err
		}
		batch.Source = "flow"
		items = append(items, *batch)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].CreatedAt.Equal(items[j].CreatedAt) {
			return items[i].ID < items[j].ID
		}
		return items[i].CreatedAt.After(items[j].CreatedAt)
	})
	if len(items) > 100 {
		items = items[:100]
	}
	return items, nil
}
