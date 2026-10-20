package httpapi

import "time"

const (
	defaultProjectID = "default"
	defaultOwnerID   = "local"
)

type KeyValue struct {
	ID      string `json:"id,omitempty"`
	Name    string `json:"name"`
	Value   string `json:"value"`
	Enabled bool   `json:"enabled"`
}

type RequestData struct {
	Method      string         `json:"method"`
	URL         string         `json:"url"`
	QueryParams []KeyValue     `json:"query_params"`
	Headers     []KeyValue     `json:"headers"`
	BodyType    string         `json:"body_type"`
	Body        string         `json:"body,omitempty"`
	AuthConfig  map[string]any `json:"auth_config,omitempty"`
}

type APICollection struct {
	ID          string     `json:"id"`
	ProjectID   string     `json:"project_id"`
	ParentID    *string    `json:"parent_id,omitempty"`
	Name        string     `json:"name"`
	Description string     `json:"description,omitempty"`
	SortOrder   int        `json:"sort_order"`
	Status      string     `json:"status"`
	CreatedBy   string     `json:"created_by,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	ArchivedAt  *time.Time `json:"archived_at,omitempty"`
}

type APIRequest struct {
	ID           string      `json:"id"`
	CollectionID string      `json:"collection_id"`
	Name         string      `json:"name"`
	Description  string      `json:"description,omitempty"`
	Request      RequestData `json:"request"`
	SourceType   string      `json:"source_type"`
	Status       string      `json:"status"`
	SortOrder    int         `json:"sort_order"`
	CreatedBy    string      `json:"created_by,omitempty"`
	UpdatedBy    string      `json:"updated_by,omitempty"`
	CreatedAt    time.Time   `json:"created_at"`
	UpdatedAt    time.Time   `json:"updated_at"`
	ArchivedAt   *time.Time  `json:"archived_at,omitempty"`
}

type APIWorkingCopy struct {
	ID              string      `json:"id"`
	ProjectID       string      `json:"project_id"`
	OwnerID         string      `json:"owner_id"`
	APIRequestID    *string     `json:"api_request_id,omitempty"`
	EnvironmentID   *string     `json:"environment_id,omitempty"`
	Name            string      `json:"name,omitempty"`
	Request         RequestData `json:"request"`
	SourceType      string      `json:"source_type"`
	Status          string      `json:"status"`
	ContentHash     string      `json:"content_hash"`
	BaseContentHash *string     `json:"base_content_hash,omitempty"`
	EditVersion     int64       `json:"edit_version"`
	CreatedAt       time.Time   `json:"created_at"`
	UpdatedAt       time.Time   `json:"updated_at"`
	ExpiresAt       *time.Time  `json:"expires_at,omitempty"`
	DiscardedAt     *time.Time  `json:"discarded_at,omitempty"`
}

type APIRun struct {
	ID                string      `json:"id"`
	ProjectID         string      `json:"project_id"`
	APIRequestID      *string     `json:"api_request_id,omitempty"`
	WorkingCopyID     *string     `json:"working_copy_id,omitempty"`
	EnvironmentID     *string     `json:"environment_id,omitempty"`
	SessionID         string      `json:"session_id,omitempty"`
	StepID            string      `json:"step_id,omitempty"`
	BatchID           string      `json:"batch_id,omitempty"`
	TestRunID         string      `json:"test_run_id,omitempty"`
	FlowRunID         string      `json:"flow_run_id,omitempty"`
	FlowID            string      `json:"flow_id,omitempty"`
	TriggerType       string      `json:"trigger_type"`
	Status            string      `json:"status"`
	RequestSnapshot   RequestData `json:"request_snapshot"`
	ResponseStatus    *int        `json:"response_status,omitempty"`
	ResponseHeaders   any         `json:"response_headers,omitempty"`
	ResponseBody      any         `json:"response_body,omitempty"`
	ResponseSize      int64       `json:"response_size,omitempty"`
	ResponseTruncated bool        `json:"response_truncated"`
	DurationMS        int64       `json:"duration_ms,omitempty"`
	ErrorCode         string      `json:"error_code,omitempty"`
	ErrorMessage      string      `json:"error_message,omitempty"`
	IsPinned          bool        `json:"is_pinned"`
	StartedAt         time.Time   `json:"started_at"`
	FinishedAt        *time.Time  `json:"finished_at,omitempty"`
	ExpiresAt         *time.Time  `json:"expires_at,omitempty"`
}

type RunCommand struct {
	BatchID       string
	ProjectID     string
	APIRequestID  string
	WorkingCopyID string
	EnvironmentID string
	SessionID     string
	StepID        string
	TriggerType   string
	InlineRequest *RequestData
}
