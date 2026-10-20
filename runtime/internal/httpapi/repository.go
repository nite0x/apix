package httpapi

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/apix/apix/runtime/internal/lifecycle"
	"strings"
	"time"

	"github.com/google/uuid"
)

var (
	errNotFound = errors.New("not found")
	errConflict = errors.New("conflict")
)

type repository struct{ db *sql.DB }

func newRepository(db *sql.DB) *repository { return &repository{db: db} }

func contentHash(request RequestData) (string, error) {
	b, err := json.Marshal(request)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

func normalizeRequest(r *RequestData) {
	r.Method = strings.ToUpper(strings.TrimSpace(r.Method))
	if r.Method == "" {
		r.Method = "GET"
	}
	r.URL = strings.TrimSpace(r.URL)
	if r.QueryParams == nil {
		r.QueryParams = []KeyValue{}
	}
	if r.Headers == nil {
		r.Headers = []KeyValue{}
	}
	if r.BodyType == "" {
		if r.Body == "" {
			r.BodyType = "none"
		} else {
			r.BodyType = "json"
		}
	}
}

func marshalJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func optionalString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (r *repository) listCollections(projectID string) ([]APICollection, error) {
	rows, err := r.db.Query(`SELECT id, project_id, parent_id, name, COALESCE(description,''), sort_order,
		status, COALESCE(created_by,''), created_at, updated_at, archived_at
		FROM api_collections WHERE project_id = ? AND status = 'active'
		ORDER BY sort_order, created_at`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]APICollection, 0)
	for rows.Next() {
		var item APICollection
		var parent sql.NullString
		var archived sql.NullTime
		if err := rows.Scan(&item.ID, &item.ProjectID, &parent, &item.Name, &item.Description,
			&item.SortOrder, &item.Status, &item.CreatedBy, &item.CreatedAt, &item.UpdatedAt, &archived); err != nil {
			return nil, err
		}
		if parent.Valid {
			item.ParentID = &parent.String
		}
		if archived.Valid {
			item.ArchivedAt = &archived.Time
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *repository) createCollection(item *APICollection) error {
	if item.ID == "" {
		item.ID = uuid.NewString()
	}
	if item.ProjectID == "" {
		item.ProjectID = defaultProjectID
	}
	if item.Status == "" {
		item.Status = "active"
	}
	now := time.Now().UTC()
	item.CreatedAt, item.UpdatedAt = now, now
	_, err := r.db.Exec(`INSERT INTO api_collections
		(id, project_id, parent_id, name, description, sort_order, status, created_by, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, item.ID, item.ProjectID, item.ParentID,
		item.Name, optionalString(item.Description), item.SortOrder, item.Status,
		optionalString(item.CreatedBy), item.CreatedAt, item.UpdatedAt)
	return err
}

func (r *repository) updateCollection(item *APICollection) error {
	item.UpdatedAt = time.Now().UTC()
	result, err := r.db.Exec(`UPDATE api_collections SET parent_id=?, name=?, description=?, sort_order=?, updated_at=?
		WHERE id=? AND status='active'`, item.ParentID, item.Name, optionalString(item.Description), item.SortOrder, item.UpdatedAt, item.ID)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return errNotFound
	}
	return nil
}

func (r *repository) archiveCollection(id string) error {
	gate := lifecycle.For(r.db)
	gate.Lock()
	defer gate.Unlock()
	result, err := r.db.Exec(`UPDATE api_collections SET status='archived', archived_at=?, updated_at=? WHERE id=? AND status='active'`, time.Now().UTC(), time.Now().UTC(), id)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return errNotFound
	}
	return nil
}

func (r *repository) listRequests(collectionID string) ([]APIRequest, error) {
	rows, err := r.db.Query(`SELECT id FROM api_requests WHERE collection_id=? AND status='active' ORDER BY sort_order, updated_at DESC`, collectionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// The runtime uses a single SQLite connection. Release it before loading
	// each request, otherwise the nested query waits forever for this cursor.
	if err := rows.Close(); err != nil {
		return nil, err
	}
	out := make([]APIRequest, 0, len(ids))
	for _, id := range ids {
		item, err := r.getRequest(id)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	return out, nil
}

func (r *repository) getRequest(id string) (*APIRequest, error) {
	var item APIRequest
	var query, headers, auth string
	var body, desc, createdBy, updatedBy sql.NullString
	var archived sql.NullTime
	err := r.db.QueryRow(`SELECT id, collection_id, name, description, method, url, query_params, headers,
		body_type, body, auth_config, source_type, status, sort_order, created_by, updated_by,
		created_at, updated_at, archived_at FROM api_requests WHERE id=?`, id).Scan(
		&item.ID, &item.CollectionID, &item.Name, &desc, &item.Request.Method, &item.Request.URL,
		&query, &headers, &item.Request.BodyType, &body, &auth, &item.SourceType, &item.Status,
		&item.SortOrder, &createdBy, &updatedBy, &item.CreatedAt, &item.UpdatedAt, &archived)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	item.Description, item.Request.Body, item.CreatedBy, item.UpdatedBy = desc.String, body.String, createdBy.String, updatedBy.String
	_ = json.Unmarshal([]byte(query), &item.Request.QueryParams)
	_ = json.Unmarshal([]byte(headers), &item.Request.Headers)
	if auth != "" && auth != "null" {
		_ = json.Unmarshal([]byte(auth), &item.Request.AuthConfig)
	}
	if archived.Valid {
		item.ArchivedAt = &archived.Time
	}
	return &item, nil
}

func (r *repository) createRequest(item *APIRequest) error {
	normalizeRequest(&item.Request)
	if item.ID == "" {
		item.ID = uuid.NewString()
	}
	if item.Status == "" {
		item.Status = "active"
	}
	if item.SourceType == "" {
		item.SourceType = "manual"
	}
	now := time.Now().UTC()
	item.CreatedAt, item.UpdatedAt = now, now
	_, err := r.db.Exec(`INSERT INTO api_requests
		(id, collection_id, name, description, method, url, query_params, headers, body_type, body,
		auth_config, source_type, status, sort_order, created_by, updated_by, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, item.ID, item.CollectionID, item.Name,
		optionalString(item.Description), item.Request.Method, item.Request.URL, marshalJSON(item.Request.QueryParams),
		marshalJSON(item.Request.Headers), item.Request.BodyType, optionalString(item.Request.Body),
		marshalJSON(item.Request.AuthConfig), item.SourceType, item.Status, item.SortOrder,
		optionalString(item.CreatedBy), optionalString(item.UpdatedBy), item.CreatedAt, item.UpdatedAt)
	return err
}

func (r *repository) updateRequest(item *APIRequest) error {
	normalizeRequest(&item.Request)
	item.UpdatedAt = time.Now().UTC()
	result, err := r.db.Exec(`UPDATE api_requests SET collection_id=?, name=?, description=?, method=?, url=?,
		query_params=?, headers=?, body_type=?, body=?, auth_config=?, source_type=?, sort_order=?, updated_by=?, updated_at=?
		WHERE id=? AND status='active'`, item.CollectionID, item.Name, optionalString(item.Description),
		item.Request.Method, item.Request.URL, marshalJSON(item.Request.QueryParams), marshalJSON(item.Request.Headers),
		item.Request.BodyType, optionalString(item.Request.Body), marshalJSON(item.Request.AuthConfig), item.SourceType,
		item.SortOrder, optionalString(item.UpdatedBy), item.UpdatedAt, item.ID)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return errNotFound
	}
	return nil
}

func (r *repository) archiveRequest(id string) error {
	gate := lifecycle.For(r.db)
	gate.Lock()
	defer gate.Unlock()
	result, err := r.db.Exec(`UPDATE api_requests SET status='archived', archived_at=?, updated_at=? WHERE id=? AND status='active'`, time.Now().UTC(), time.Now().UTC(), id)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return errNotFound
	}
	return nil
}

func (r *repository) createWorkingCopy(item *APIWorkingCopy) error {
	normalizeRequest(&item.Request)
	hash, err := contentHash(item.Request)
	if err != nil {
		return err
	}
	if item.ID == "" {
		item.ID = uuid.NewString()
	}
	if item.ProjectID == "" {
		item.ProjectID = defaultProjectID
	}
	if item.OwnerID == "" {
		item.OwnerID = defaultOwnerID
	}
	if item.SourceType == "" {
		item.SourceType = "manual"
	}
	item.Status = "active"
	item.ContentHash = hash
	item.EditVersion = 1
	now := time.Now().UTC()
	item.CreatedAt, item.UpdatedAt = now, now
	if item.ExpiresAt == nil && item.APIRequestID == nil {
		expires := now.Add(7 * 24 * time.Hour)
		item.ExpiresAt = &expires
	}
	if item.APIRequestID != nil {
		base := hash
		item.BaseContentHash = &base
	}
	_, err = r.db.Exec(`INSERT INTO api_working_copies
		(id, project_id, owner_id, api_request_id, environment_id, name, request_data, source_type, status,
		content_hash, base_content_hash, edit_version, created_at, updated_at, expires_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, item.ID, item.ProjectID, item.OwnerID, item.APIRequestID,
		item.EnvironmentID, optionalString(item.Name), marshalJSON(item.Request), item.SourceType, item.Status,
		item.ContentHash, item.BaseContentHash, item.EditVersion, item.CreatedAt, item.UpdatedAt, item.ExpiresAt)
	return err
}

func (r *repository) getWorkingCopy(id string) (*APIWorkingCopy, error) {
	var item APIWorkingCopy
	var apiID, envID, base sql.NullString
	var name string
	var requestJSON string
	var expires, discarded sql.NullTime
	err := r.db.QueryRow(`SELECT id, project_id, owner_id, api_request_id, environment_id, COALESCE(name,''), request_data,
		source_type, status, content_hash, base_content_hash, edit_version, created_at, updated_at, expires_at, discarded_at
		FROM api_working_copies WHERE id=?`, id).Scan(&item.ID, &item.ProjectID, &item.OwnerID, &apiID, &envID, &name,
		&requestJSON, &item.SourceType, &item.Status, &item.ContentHash, &base, &item.EditVersion,
		&item.CreatedAt, &item.UpdatedAt, &expires, &discarded)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	item.Name = name
	if apiID.Valid {
		item.APIRequestID = &apiID.String
	}
	if envID.Valid {
		item.EnvironmentID = &envID.String
	}
	if base.Valid {
		item.BaseContentHash = &base.String
	}
	if expires.Valid {
		item.ExpiresAt = &expires.Time
	}
	if discarded.Valid {
		item.DiscardedAt = &discarded.Time
	}
	if err := json.Unmarshal([]byte(requestJSON), &item.Request); err != nil {
		return nil, err
	}
	return &item, nil
}

func (r *repository) updateWorkingCopy(item *APIWorkingCopy, expectedVersion int64) error {
	normalizeRequest(&item.Request)
	hash, err := contentHash(item.Request)
	if err != nil {
		return err
	}
	item.ContentHash = hash
	item.UpdatedAt = time.Now().UTC()
	result, err := r.db.Exec(`UPDATE api_working_copies SET name=?, request_data=?, environment_id=?, content_hash=?,
		edit_version=edit_version+1, updated_at=? WHERE id=? AND status='active' AND edit_version=?`,
		optionalString(item.Name), marshalJSON(item.Request), item.EnvironmentID, item.ContentHash, item.UpdatedAt, item.ID, expectedVersion)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return fmt.Errorf("working copy changed or not found")
	}
	item.EditVersion = expectedVersion + 1
	return nil
}

// saveWorkingCopy promotes a draft into a durable APIRequest. description is
// optional: a nil pointer leaves the stored description untouched so callers
// that do not manage descriptions (e.g. manual drafts) never clear them.
func (r *repository) saveWorkingCopy(id, collectionID, name string, description *string) (*APIWorkingCopy, error) {
	gate := lifecycle.For(r.db)
	gate.Lock()
	defer gate.Unlock()
	copy, err := r.getWorkingCopy(id)
	if err != nil {
		return nil, err
	}
	tx, err := r.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck
	now := time.Now().UTC()
	if copy.APIRequestID == nil {
		if collectionID == "" {
			return nil, fmt.Errorf("collection_id is required")
		}
		if name == "" {
			return nil, fmt.Errorf("name is required")
		}
		requestID := uuid.NewString()
		var desc any
		if description != nil {
			desc = optionalString(*description)
		}
		_, err = tx.Exec(`INSERT INTO api_requests
			(id, collection_id, name, description, method, url, query_params, headers, body_type, body, auth_config,
			source_type, status, created_at, updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, requestID, collectionID, name, desc, copy.Request.Method, copy.Request.URL,
			marshalJSON(copy.Request.QueryParams), marshalJSON(copy.Request.Headers), copy.Request.BodyType,
			optionalString(copy.Request.Body), marshalJSON(copy.Request.AuthConfig), copy.SourceType, "active", now, now)
		if err != nil {
			return nil, err
		}
		copy.APIRequestID = &requestID
		copy.Name = name
	} else {
		current, err := getActiveRequestData(tx, *copy.APIRequestID)
		if err != nil {
			return nil, err
		}
		currentHash, err := contentHash(current)
		if err != nil {
			return nil, err
		}
		if copy.BaseContentHash == nil || currentHash != *copy.BaseContentHash {
			return nil, fmt.Errorf("%w: saved request changed since this draft was opened", errConflict)
		}
		if name == "" {
			name = copy.Name
		}
		if description != nil {
			result, updateErr := tx.Exec(`UPDATE api_requests SET name=?, description=?, method=?, url=?, query_params=?, headers=?, body_type=?,
				body=?, auth_config=?, updated_at=? WHERE id=? AND status='active'`, name, optionalString(*description),
				copy.Request.Method, copy.Request.URL, marshalJSON(copy.Request.QueryParams), marshalJSON(copy.Request.Headers),
				copy.Request.BodyType, optionalString(copy.Request.Body), marshalJSON(copy.Request.AuthConfig), now, *copy.APIRequestID)
			err = updateErr
			if err == nil {
				affected, _ := result.RowsAffected()
				if affected == 0 {
					err = errNotFound
				}
			}
		} else {
			result, updateErr := tx.Exec(`UPDATE api_requests SET name=?, method=?, url=?, query_params=?, headers=?, body_type=?,
				body=?, auth_config=?, updated_at=? WHERE id=? AND status='active'`, name, copy.Request.Method, copy.Request.URL,
				marshalJSON(copy.Request.QueryParams), marshalJSON(copy.Request.Headers), copy.Request.BodyType,
				optionalString(copy.Request.Body), marshalJSON(copy.Request.AuthConfig), now, *copy.APIRequestID)
			err = updateErr
			if err == nil {
				affected, _ := result.RowsAffected()
				if affected == 0 {
					err = errNotFound
				}
			}
		}
		if err != nil {
			return nil, err
		}
		if name != "" {
			copy.Name = name
		}
	}
	_, err = tx.Exec(`UPDATE api_working_copies SET api_request_id=?, name=?, base_content_hash=content_hash,
		expires_at=NULL, edit_version=edit_version+1, updated_at=? WHERE id=? AND status='active'`, copy.APIRequestID, copy.Name, now, copy.ID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return r.getWorkingCopy(id)
}

func getActiveRequestData(tx *sql.Tx, id string) (RequestData, error) {
	var request RequestData
	var query, headers, auth string
	var body sql.NullString
	err := tx.QueryRow(`SELECT method, url, query_params, headers, body_type, body, auth_config
		FROM api_requests WHERE id=? AND status='active'`, id).Scan(
		&request.Method, &request.URL, &query, &headers, &request.BodyType, &body, &auth)
	if errors.Is(err, sql.ErrNoRows) {
		return RequestData{}, errNotFound
	}
	if err != nil {
		return RequestData{}, err
	}
	request.Body = body.String
	if err := json.Unmarshal([]byte(query), &request.QueryParams); err != nil {
		return RequestData{}, err
	}
	if err := json.Unmarshal([]byte(headers), &request.Headers); err != nil {
		return RequestData{}, err
	}
	if auth != "" && auth != "null" {
		if err := json.Unmarshal([]byte(auth), &request.AuthConfig); err != nil {
			return RequestData{}, err
		}
	}
	return request, nil
}

func (r *repository) discardWorkingCopy(id string) error {
	now := time.Now().UTC()
	result, err := r.db.Exec(`UPDATE api_working_copies SET status='discarded', discarded_at=?, updated_at=? WHERE id=? AND status='active'`, now, now, id)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return errNotFound
	}
	return nil
}

func (r *repository) insertRun(run *APIRun) error {
	_, err := r.db.Exec(`INSERT INTO api_runs
		(id, project_id, api_request_id, working_copy_id, environment_id, session_id, step_id, trigger_type,
		status, request_snapshot, is_pinned, started_at, expires_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, run.ID, run.ProjectID, run.APIRequestID, run.WorkingCopyID,
		run.EnvironmentID, optionalString(run.SessionID), optionalString(run.StepID), run.TriggerType, run.Status,
		marshalJSON(run.RequestSnapshot), run.IsPinned, run.StartedAt, run.ExpiresAt)
	return err
}

func (r *repository) finishRun(run *APIRun) error {
	storedBody := redactedJSONCopy(run.ResponseBody)
	_, err := r.db.Exec(`UPDATE api_runs SET status=?, response_status=?, response_headers=?, response_body=?,
		response_size=?, response_truncated=?, duration_ms=?, error_code=?, error_message=?, finished_at=? WHERE id=?`,
		run.Status, run.ResponseStatus, marshalJSON(run.ResponseHeaders), marshalJSON(storedBody), run.ResponseSize,
		run.ResponseTruncated, run.DurationMS, optionalString(run.ErrorCode), optionalString(run.ErrorMessage), run.FinishedAt, run.ID)
	return err
}

func redactedJSONCopy(value any) any {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var copied any
	if json.Unmarshal(encoded, &copied) != nil {
		return nil
	}
	redactJSONValue(copied)
	return copied
}

func (r *repository) getRun(id string) (*APIRun, error) {
	var run APIRun
	var apiID, wcID, envID sql.NullString
	var snapshot, headers, body string
	var responseStatus sql.NullInt64
	var finished, expires sql.NullTime
	var truncated, pinned int
	err := r.db.QueryRow(`SELECT id, project_id, api_request_id, working_copy_id, environment_id,
		COALESCE(session_id,''), COALESCE(step_id,''), trigger_type, status, request_snapshot,
		response_status, COALESCE(response_headers,'null'), COALESCE(response_body,'null'), COALESCE(response_size,0),
		response_truncated, COALESCE(duration_ms,0), COALESCE(error_code,''), COALESCE(error_message,''),
		is_pinned, started_at, finished_at, expires_at,
		COALESCE((SELECT id FROM test_batches WHERE id=api_runs.session_id),''),
		COALESCE((SELECT id FROM test_case_runs WHERE batch_id=api_runs.session_id AND (api_run_id=api_runs.id OR id=api_runs.step_id) LIMIT 1),''),
		COALESCE((SELECT id FROM flow_runs WHERE id=api_runs.session_id),''),
		COALESCE((SELECT flow_id FROM flow_runs WHERE id=api_runs.session_id),'')
		FROM api_runs WHERE id=?`, id).Scan(&run.ID, &run.ProjectID,
		&apiID, &wcID, &envID, &run.SessionID, &run.StepID, &run.TriggerType, &run.Status, &snapshot,
		&responseStatus, &headers, &body, &run.ResponseSize, &truncated, &run.DurationMS, &run.ErrorCode,
		&run.ErrorMessage, &pinned, &run.StartedAt, &finished, &expires, &run.BatchID, &run.TestRunID, &run.FlowRunID, &run.FlowID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if apiID.Valid {
		run.APIRequestID = &apiID.String
	}
	if wcID.Valid {
		run.WorkingCopyID = &wcID.String
	}
	if envID.Valid {
		run.EnvironmentID = &envID.String
	}
	if responseStatus.Valid {
		v := int(responseStatus.Int64)
		run.ResponseStatus = &v
	}
	run.ResponseTruncated = truncated == 1
	run.IsPinned = pinned == 1
	if finished.Valid {
		run.FinishedAt = &finished.Time
	}
	if expires.Valid {
		run.ExpiresAt = &expires.Time
	}
	_ = json.Unmarshal([]byte(snapshot), &run.RequestSnapshot)
	_ = json.Unmarshal([]byte(headers), &run.ResponseHeaders)
	_ = json.Unmarshal([]byte(body), &run.ResponseBody)
	// Older snapshots may predate URL/form redaction; apply the same policy on read.
	run.RequestSnapshot = redactRequest(run.RequestSnapshot)
	run.ResponseHeaders = redactedJSONCopy(run.ResponseHeaders)
	run.ResponseBody = redactedJSONCopy(run.ResponseBody)
	run.ErrorMessage = redactExecutionError(run.ErrorMessage)
	return &run, nil
}

func (r *repository) listRuns(projectID string, limit int) ([]APIRun, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := r.db.Query(`SELECT id FROM api_runs WHERE project_id=? ORDER BY started_at DESC LIMIT ?`, projectID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	var out []APIRun
	for _, id := range ids {
		run, err := r.getRun(id)
		if err != nil {
			return nil, err
		}
		out = append(out, *run)
	}
	return out, nil
}

func (r *repository) pinRun(id string, pinned bool) error {
	var expires any
	if !pinned {
		expires = time.Now().UTC().Add(30 * 24 * time.Hour)
	}
	result, err := r.db.Exec(`UPDATE api_runs SET is_pinned=?, expires_at=? WHERE id=?`, pinned, expires, id)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return errNotFound
	}
	return nil
}

func (r *repository) deleteRun(id string) error {
	result, err := r.db.Exec(`DELETE FROM api_runs WHERE id=? AND status NOT IN ('running','queued','paused') AND is_pinned=0 AND NOT EXISTS(SELECT 1 FROM test_case_runs WHERE api_run_id=api_runs.id) AND NOT EXISTS(SELECT 1 FROM flow_run_steps WHERE api_run_id=api_runs.id)`, id)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		if _, err := r.getRun(id); err != nil {
			return err
		}
		return fmt.Errorf("%w: 记录正在执行、已固定或被批次/流程详情引用，请按完整运行清理", lifecycle.ErrProtected)
	}
	return nil
}

// listRunSummaries reads only list metadata; response payloads are loaded on demand.
func (r *repository) listRunSummaries(projectID string, limit int) ([]APIRun, error) {
	if limit <= 0 || limit > 1000 {
		limit = 50
	}
	rows, err := r.db.Query(`SELECT id, request_snapshot, status, response_status,
    COALESCE(duration_ms,0), started_at, is_pinned, COALESCE(step_id,''),
    COALESCE((SELECT id FROM test_batches WHERE id=api_runs.session_id),''),
    COALESCE((SELECT id FROM test_case_runs WHERE batch_id=api_runs.session_id AND (api_run_id=api_runs.id OR id=api_runs.step_id) LIMIT 1),''),
    COALESCE((SELECT id FROM flow_runs WHERE id=api_runs.session_id),''),
    COALESCE((SELECT flow_id FROM flow_runs WHERE id=api_runs.session_id),'')
    FROM api_runs WHERE project_id=?
    ORDER BY started_at DESC,id DESC LIMIT ?`, projectID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []APIRun{}
	for rows.Next() {
		var item APIRun
		var snapshot string
		var status sql.NullInt64
		var pinned int
		if err := rows.Scan(&item.ID, &snapshot, &item.Status, &status, &item.DurationMS, &item.StartedAt, &pinned,
			&item.StepID, &item.BatchID, &item.TestRunID, &item.FlowRunID, &item.FlowID); err != nil {
			return nil, err
		}
		var request struct {
			Method string `json:"method"`
			URL    string `json:"url"`
		}
		if err := json.Unmarshal([]byte(snapshot), &request); err != nil {
			return nil, err
		}
		item.ProjectID = projectID
		item.RequestSnapshot = RequestData{Method: request.Method, URL: redactRequestURL(request.URL)}
		item.IsPinned = pinned != 0
		if status.Valid {
			value := int(status.Int64)
			item.ResponseStatus = &value
		}
		result = append(result, item)
	}
	return result, rows.Err()
}
