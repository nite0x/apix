package httpapi

import (
	"context"
	"fmt"
	"time"

	"github.com/apix/apix/runtime/internal/executionrecord"
	"github.com/google/uuid"
)

type ExecutionData struct {
	Input  any `json:"execution_input,omitempty"`
	Result any `json:"execution_result,omitempty"`
}

// RecordExecution reserves before side effects, so closing a batch cannot race
// with SQL or service execution. Each standalone execution owns its own batch.
func (s *HTTPService) RecordExecution(ctx context.Context, kind, name, batchID string, input any) (executionrecord.Finish, error) {
	if executionrecord.Skipped(ctx) {
		return func(any, error) error { return nil }, nil
	}
	if batchID == "" {
		batchID = executionrecord.Batch(ctx)
	}
	for len(name) > 512 {
		chars := []rune(name)
		name = string(chars[:len(chars)-1])
	}
	ownsBatch := batchID == ""
	if !ownsBatch && executionrecord.Project(ctx) != "" {
		var project string
		if err := s.db.QueryRow("SELECT project_id FROM test_batches WHERE id=?", batchID).Scan(&project); err != nil {
			return nil, err
		}
		if project != executionrecord.Project(ctx) {
			return nil, invalidTest("execution does not belong to batch project")
		}
	}
	if ownsBatch {
		batch, err := s.BeginTestBatch(executionrecord.Project(ctx), name)
		if err != nil {
			return nil, err
		}
		batchID = batch.ID
	}
	id, started := uuid.NewString(), time.Now().UTC()
	data := ExecutionData{Input: redactedJSONCopy(input)}
	result, err := s.db.Exec(`INSERT INTO test_case_runs(id,batch_id,name,request_snapshot,status,started_at,type,execution_data)
 SELECT ?,?,?,'{}','running',?,?,? FROM test_batches WHERE id=? AND status='running'`, id, batchID, name, started, kind, marshalJSON(data), batchID)
	if err != nil {
		return nil, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n != 1 {
		return nil, fmt.Errorf("%w: batch is closed or missing", errConflict)
	}
	s.flow.emit("test_case.started", batchID, id, map[string]any{"name": name, "type": kind, "status": "running"})
	return func(output any, execErr error) error {
		status, message := "unverified", ""
		if execErr != nil {
			status, message = "error", redactExecutionError(execErr.Error())
		}
		data.Result = redactedJSONCopy(output)
		var apiID *string
		snapshot := RequestData{}
		if apiRun, ok := output.(*APIRun); ok && apiRun != nil {
			apiID, snapshot = &apiRun.ID, apiRun.RequestSnapshot
			data.Result = map[string]any{"duration_ms": apiRun.DurationMS, "response_status": apiRun.ResponseStatus}
		}
		_, err := s.db.Exec(`UPDATE test_case_runs SET execution_data=?,request_snapshot=?,api_run_id=?,status=?,error_message=?,finished_at=? WHERE id=? AND status='running'`,
			marshalJSON(data), marshalJSON(snapshot), apiID, status, message, time.Now().UTC(), id)
		if err != nil {
			return fmt.Errorf("execution completed but history could not be saved: %w", err)
		}
		s.flow.emit("test_case.finished", batchID, id, map[string]any{"name": name, "type": kind, "status": status})
		if ownsBatch {
			_, err = s.FinishTestBatch(batchID)
		}
		return err
	}, nil
}
