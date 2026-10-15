package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

var (
	// errNoRunnableStep is returned when a Flow exists but cannot be run
	// because it has no enabled step. Routes map it to HTTP 422.
	errNoRunnableStep = errors.New("flow has no runnable step")

	errValidation = errors.New("validation failed")

	variableNameRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	validMethods   = map[string]bool{
		"GET": true, "POST": true, "PUT": true, "DELETE": true,
		"PATCH": true, "HEAD": true, "OPTIONS": true,
	}
)

// ── validation ───────────────────────────────────────

func validateFlowMeta(name, description string) error {
	name = strings.TrimSpace(name)
	if len(name) < 1 || len(name) > 120 {
		return fmt.Errorf("name must be 1-120 characters")
	}
	if len(description) > 2000 {
		return fmt.Errorf("description must be at most 2000 characters")
	}
	return nil
}

func validateFlowVariables(vars []FlowVariableDefinition) error {
	seen := map[string]bool{}
	for _, v := range vars {
		if !variableNameRe.MatchString(v.Name) {
			return fmt.Errorf("invalid variable name %q", v.Name)
		}
		if seen[v.Name] {
			return fmt.Errorf("duplicate variable name %q", v.Name)
		}
		seen[v.Name] = true
		if v.Secret && v.DefaultValue != "" {
			return fmt.Errorf("secret variable %q must not carry a default value", v.Name)
		}
	}
	return nil
}

func (r *repository) validateFlowAggregate(f *Flow) error {
	if err := validateFlowMeta(f.Name, f.Description); err != nil {
		return err
	}
	if err := validateFlowVariables(f.Variables); err != nil {
		return err
	}
	if f.Settings.RequestTimeoutMS != 0 && (f.Settings.RequestTimeoutMS < 1000 || f.Settings.RequestTimeoutMS > 300000) {
		return fmt.Errorf("request_timeout_ms must be between 1000 and 300000")
	}
	if f.EnvironmentID != nil {
		if err := r.assertEnvironmentInProject(*f.EnvironmentID, f.ProjectID); err != nil {
			return err
		}
	}
	stepIDs := map[string]bool{}
	for i := range f.Steps {
		step := &f.Steps[i]
		if step.ID != "" {
			if stepIDs[step.ID] {
				return fmt.Errorf("duplicate step id %q", step.ID)
			}
			stepIDs[step.ID] = true
		}
		if step.Type == "" {
			step.Type = "http"
		}
		if step.Type != "http" && step.Type != "sql" && step.Type != "service" {
			return fmt.Errorf("unsupported step type %q", step.Type)
		}
		if (step.Type != "sql" && step.SQL != nil) || (step.Type != "service" && step.Service != nil) {
			return fmt.Errorf("step %q carries a payload for a different step type", step.Name)
		}
		if step.Type != "http" && (strings.TrimSpace(step.Request.URL) != "" || step.Request.Body != "" || len(step.Request.Headers) > 0 || len(step.Request.QueryParams) > 0 || step.Request.AuthConfig != nil) {
			return fmt.Errorf("step %q carries an HTTP request payload for a different step type", step.Name)
		}
		if step.Config.TimeoutMS != 0 && (step.Config.TimeoutMS < 1000 || step.Config.TimeoutMS > 300000) {
			return fmt.Errorf("step timeout_ms must be between 1000 and 300000")
		}
		if step.Config.ExpectedStatus != nil && (*step.Config.ExpectedStatus < 100 || *step.Config.ExpectedStatus > 599 || step.Type != "http") {
			return fmt.Errorf("expected_status must be an HTTP status between 100 and 599")
		}
		if step.Config.ExpectedRows != nil && (*step.Config.ExpectedRows < 0 || step.Type != "sql" || step.SQL == nil || step.SQL.Mode != "query") {
			return fmt.Errorf("expected_rows requires a SQL query and a nonnegative count")
		}
		if step.Type != "http" && (len(step.Config.Extractors) > 0 || step.SourceAPIRequestID != nil) {
			return fmt.Errorf("extractors and source_api_request_id only apply to HTTP steps")
		}
		if step.Enabled && step.Type == "http" {
			method := strings.ToUpper(strings.TrimSpace(step.Request.Method))
			if !validMethods[method] {
				return fmt.Errorf("step %q has invalid method", step.Name)
			}
		}
		if step.Enabled && step.Type == "sql" {
			if step.SQL == nil || strings.TrimSpace(step.SQL.ConnectionID) == "" || strings.TrimSpace(step.SQL.SQL) == "" {
				return fmt.Errorf("SQL step %q requires connection_id and sql", step.Name)
			}
			if step.SQL.Mode != "query" && step.SQL.Mode != "exec" {
				return fmt.Errorf("SQL mode must be query or exec")
			}
		}
		if step.Enabled && step.Type == "service" {
			if step.Service == nil || strings.TrimSpace(step.Service.ServiceID) == "" || (step.Service.Action != "start" && step.Service.Action != "stop") {
				return fmt.Errorf("service step %q requires service_id and start or stop action", step.Name)
			}
		}
		if err := validateExtractors(step.Config.Extractors); err != nil {
			return err
		}
		if len(step.Config.Assertions) > 0 && step.Type != "http" {
			return fmt.Errorf("response assertions only apply to HTTP steps")
		}
		for _, assertion := range step.Config.Assertions {
			if assertion.Source != "body" && assertion.Source != "header" && assertion.Source != "status" {
				return fmt.Errorf("invalid assertion source %q", assertion.Source)
			}
			if assertion.Source == "header" && strings.TrimSpace(assertion.Path) == "" {
				return fmt.Errorf("header assertion requires a header name")
			}
			switch assertion.Operator {
			case "equals", "not_equals", "contains", "exists":
			default:
				return fmt.Errorf("invalid assertion operator %q", assertion.Operator)
			}
		}
		if step.SourceAPIRequestID != nil {
			if err := r.assertRequestInProject(*step.SourceAPIRequestID, f.ProjectID); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateExtractors(extractors []FlowExtractor) error {
	seen := map[string]bool{}
	for _, e := range extractors {
		if !variableNameRe.MatchString(e.Name) {
			return fmt.Errorf("invalid extractor name %q", e.Name)
		}
		if seen[e.Name] {
			return fmt.Errorf("duplicate extractor name %q", e.Name)
		}
		seen[e.Name] = true
		switch e.Source {
		case "body", "header", "status":
		default:
			return fmt.Errorf("extractor %q has invalid source", e.Name)
		}
		if e.Source == "header" && strings.TrimSpace(e.Path) == "" {
			return fmt.Errorf("extractor %q requires a header name", e.Name)
		}
		if e.Scope != "" && e.Scope != "run" {
			return fmt.Errorf("extractor %q must use run scope", e.Name)
		}
	}
	return nil
}

func (r *repository) assertEnvironmentInProject(envID, projectID string) error {
	if projectID == "" {
		projectID = defaultProjectID
	}
	var found string
	err := r.db.QueryRow(`SELECT id FROM environments WHERE id=? AND project_id=?`, envID, projectID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("environment does not belong to project")
	}
	return err
}

func (r *repository) assertRequestInProject(requestID, projectID string) error {
	if projectID == "" {
		projectID = defaultProjectID
	}
	var found string
	err := r.db.QueryRow(`SELECT r.id FROM api_requests r
		JOIN api_collections c ON c.id = r.collection_id
		WHERE r.id=? AND c.project_id=?`, requestID, projectID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("source api request does not belong to project")
	}
	return err
}

// ── flow normalization ───────────────────────────────

func normalizeFlowSteps(f *Flow) {
	sort.SliceStable(f.Steps, func(i, j int) bool {
		return f.Steps[i].Position < f.Steps[j].Position
	})
	for i := range f.Steps {
		step := &f.Steps[i]
		step.Position = i
		if step.ID == "" {
			step.ID = uuid.NewString()
		}
		if step.Type == "" {
			step.Type = "http"
		}
		if step.Config.Extractors == nil {
			step.Config.Extractors = []FlowExtractor{}
		}
		if step.Type == "http" {
			normalizeRequest(&step.Request)
			if strings.TrimSpace(step.Name) == "" || step.Name == "New request" {
				step.Name = flowStepName(step.Request.URL)
			}
		} else if strings.TrimSpace(step.Name) == "" {
			step.Name = step.Type + " step"
		}
	}
	if f.Variables == nil {
		f.Variables = []FlowVariableDefinition{}
	}
	if f.Steps == nil {
		f.Steps = []FlowStep{}
	}
	if f.Settings.RequestTimeoutMS == 0 {
		f.Settings.RequestTimeoutMS = 60000
	}
}

func flowStepName(requestURL string) string {
	value := strings.TrimSpace(requestURL)
	if value == "" {
		return "New request"
	}
	if parsed, err := url.Parse(value); err == nil && parsed.IsAbs() {
		if parsed.Path == "" {
			return "/"
		}
		return parsed.Path
	}
	if strings.HasPrefix(value, "{{") {
		if end := strings.Index(value, "}}"); end >= 0 {
			value = value[end+2:]
		}
	}
	if query := strings.Index(value, "?"); query >= 0 {
		value = value[:query]
	}
	if value == "" {
		return "/"
	}
	return value
}

// ── flow CRUD ─────────────────────────────────────────

func (r *repository) createFlow(projectID, name string) (*Flow, error) {
	if projectID == "" {
		projectID = defaultProjectID
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Untitled flow"
	}
	if err := validateFlowMeta(name, ""); err != nil {
		return nil, fmt.Errorf("%w: %v", errValidation, err)
	}
	flow := &Flow{
		ID:          uuid.NewString(),
		ProjectID:   projectID,
		Name:        name,
		Description: "",
		Settings:    defaultFlowSettings(),
		Variables:   []FlowVariableDefinition{},
		Steps:       []FlowStep{},
		EditVersion: 1,
	}
	now := time.Now().UTC()
	flow.CreatedAt, flow.UpdatedAt = now, now
	_, err := r.db.Exec(`INSERT INTO flows
		(id, project_id, name, description, environment_id, settings, variables, edit_version, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)`, flow.ID, flow.ProjectID, flow.Name, flow.Description, flow.EnvironmentID,
		marshalJSON(flow.Settings), marshalJSON(flow.Variables), flow.EditVersion, flow.CreatedAt, flow.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return flow, nil
}

func (r *repository) getFlow(id string) (*Flow, error) {
	flow := &Flow{}
	var env sql.NullString
	var settings, variables string
	var createdBy, updatedBy sql.NullString
	var archived sql.NullTime
	err := r.db.QueryRow(`SELECT id, project_id, name, description, environment_id, settings, variables,
		edit_version, created_by, updated_by, created_at, updated_at, archived_at FROM flows WHERE id=?`, id).Scan(
		&flow.ID, &flow.ProjectID, &flow.Name, &flow.Description, &env, &settings, &variables,
		&flow.EditVersion, &createdBy, &updatedBy, &flow.CreatedAt, &flow.UpdatedAt, &archived)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if env.Valid {
		flow.EnvironmentID = &env.String
	}
	flow.CreatedBy, flow.UpdatedBy = createdBy.String, updatedBy.String
	if archived.Valid {
		flow.ArchivedAt = &archived.Time
	}
	_ = json.Unmarshal([]byte(settings), &flow.Settings)
	_ = json.Unmarshal([]byte(variables), &flow.Variables)
	if flow.Variables == nil {
		flow.Variables = []FlowVariableDefinition{}
	}
	steps, err := r.listFlowSteps(id)
	if err != nil {
		return nil, err
	}
	flow.Steps = steps
	return flow, nil
}

func (r *repository) listFlowSteps(flowID string) ([]FlowStep, error) {
	rows, err := r.db.Query(`SELECT id, position, type, name, enabled, source_api_request_id, request_data, config, sql_data, service_data
		FROM flow_steps WHERE flow_id=? ORDER BY position`, flowID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	steps := make([]FlowStep, 0)
	for rows.Next() {
		var step FlowStep
		var source sql.NullString
		var requestJSON, configJSON string
		var sqlJSON, serviceJSON sql.NullString
		var enabled int
		if err := rows.Scan(&step.ID, &step.Position, &step.Type, &step.Name, &enabled, &source, &requestJSON, &configJSON, &sqlJSON, &serviceJSON); err != nil {
			return nil, err
		}
		step.Enabled = enabled == 1
		if source.Valid {
			step.SourceAPIRequestID = &source.String
		}
		_ = json.Unmarshal([]byte(requestJSON), &step.Request)
		_ = json.Unmarshal([]byte(configJSON), &step.Config)
		_ = json.Unmarshal([]byte(sqlJSON.String), &step.SQL)
		_ = json.Unmarshal([]byte(serviceJSON.String), &step.Service)
		if step.Config.Extractors == nil {
			step.Config.Extractors = []FlowExtractor{}
		}
		steps = append(steps, step)
	}
	return steps, rows.Err()
}

func (r *repository) listFlowSummaries(projectID string, includeArchived bool) ([]FlowSummary, error) {
	if projectID == "" {
		projectID = defaultProjectID
	}
	query := `SELECT f.id, f.project_id, f.name, f.description, f.environment_id, f.edit_version,
		f.created_at, f.updated_at, f.archived_at,
		(SELECT COUNT(*) FROM flow_steps s WHERE s.flow_id = f.id) AS step_count
		FROM flows f WHERE f.project_id=?`
	if !includeArchived {
		query += ` AND f.archived_at IS NULL`
	}
	query += ` ORDER BY f.updated_at DESC`
	rows, err := r.db.Query(query, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]FlowSummary, 0)
	for rows.Next() {
		var s FlowSummary
		var env sql.NullString
		var archived sql.NullTime
		if err := rows.Scan(&s.ID, &s.ProjectID, &s.Name, &s.Description, &env, &s.EditVersion,
			&s.CreatedAt, &s.UpdatedAt, &archived, &s.StepCount); err != nil {
			return nil, err
		}
		if env.Valid {
			s.EnvironmentID = &env.String
		}
		if archived.Valid {
			s.ArchivedAt = &archived.Time
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (r *repository) flowSummary(id string) (*FlowSummary, error) {
	var s FlowSummary
	var env sql.NullString
	var archived sql.NullTime
	err := r.db.QueryRow(`SELECT f.id, f.project_id, f.name, f.description, f.environment_id, f.edit_version,
		f.created_at, f.updated_at, f.archived_at,
		(SELECT COUNT(*) FROM flow_steps s WHERE s.flow_id = f.id) FROM flows f WHERE f.id=?`, id).Scan(
		&s.ID, &s.ProjectID, &s.Name, &s.Description, &env, &s.EditVersion, &s.CreatedAt, &s.UpdatedAt, &archived, &s.StepCount)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if env.Valid {
		s.EnvironmentID = &env.String
	}
	if archived.Valid {
		s.ArchivedAt = &archived.Time
	}
	return &s, nil
}

// updateFlow persists a full aggregate under optimistic concurrency. On version
// mismatch it returns errConflict; the caller re-reads the current summary.
func (r *repository) updateFlow(in *Flow, expectedVersion int64) (*Flow, error) {
	current, err := r.getFlow(in.ID)
	if err != nil {
		return nil, err
	}
	in.ProjectID = current.ProjectID
	if current.EditVersion != expectedVersion {
		return nil, errConflict
	}
	if err := r.validateFlowAggregate(in); err != nil {
		return nil, fmt.Errorf("%w: %v", errValidation, err)
	}
	normalizeFlowSteps(in)

	tx, err := r.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck
	now := time.Now().UTC()
	res, err := tx.Exec(`UPDATE flows SET name=?, description=?, environment_id=?, settings=?, variables=?,
		updated_by=?, edit_version=edit_version+1, updated_at=? WHERE id=? AND edit_version=?`,
		in.Name, in.Description, in.EnvironmentID, marshalJSON(in.Settings), marshalJSON(in.Variables),
		optionalString(in.UpdatedBy), now, in.ID, expectedVersion)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, errConflict
	}
	// Replace steps wholesale: simplest correct handling of add/update/delete
	// plus reorder without tripping the UNIQUE(flow_id, position) constraint.
	if _, err := tx.Exec(`DELETE FROM flow_steps WHERE flow_id=?`, in.ID); err != nil {
		return nil, err
	}
	for i := range in.Steps {
		step := &in.Steps[i]
		if _, err := tx.Exec(`INSERT INTO flow_steps
			(id, flow_id, position, type, name, enabled, source_api_request_id, request_data, config, created_at, updated_at, sql_data, service_data)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, step.ID, in.ID, step.Position, step.Type, step.Name,
			boolToInt(step.Enabled), step.SourceAPIRequestID, marshalJSON(step.Request), marshalJSON(step.Config), now, now, marshalJSON(step.SQL), marshalJSON(step.Service)); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return r.getFlow(in.ID)
}

// patchFlow updates only metadata (name/description/environment_id) under
// optimistic concurrency. Used by sidebar rename without loading the aggregate.
func (r *repository) patchFlow(id string, name, description *string, environmentID **string, expectedVersion int64) (*Flow, error) {
	current, err := r.getFlow(id)
	if err != nil {
		return nil, err
	}
	if current.EditVersion != expectedVersion {
		return nil, errConflict
	}
	newName := current.Name
	if name != nil {
		newName = strings.TrimSpace(*name)
	}
	newDesc := current.Description
	if description != nil {
		newDesc = *description
	}
	if err := validateFlowMeta(newName, newDesc); err != nil {
		return nil, fmt.Errorf("%w: %v", errValidation, err)
	}
	newEnv := current.EnvironmentID
	if environmentID != nil {
		newEnv = *environmentID
	}
	if newEnv != nil {
		if err := r.assertEnvironmentInProject(*newEnv, current.ProjectID); err != nil {
			return nil, fmt.Errorf("%w: %v", errValidation, err)
		}
	}
	now := time.Now().UTC()
	res, err := r.db.Exec(`UPDATE flows SET name=?, description=?, environment_id=?, edit_version=edit_version+1, updated_at=?
		WHERE id=? AND edit_version=?`, newName, newDesc, newEnv, now, id, expectedVersion)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, errConflict
	}
	return r.getFlow(id)
}

// archiveFlow soft-deletes a Flow. It is idempotent: archiving an already
// archived (or missing) Flow is a no-op that returns nil.
func (r *repository) archiveFlow(id string) error {
	now := time.Now().UTC()
	_, err := r.db.Exec(`UPDATE flows SET archived_at=?, updated_at=? WHERE id=? AND archived_at IS NULL`, now, now, id)
	return err
}

func (r *repository) restoreFlow(id string) (*FlowSummary, error) {
	now := time.Now().UTC()
	res, err := r.db.Exec(`UPDATE flows SET archived_at=NULL, updated_at=? WHERE id=?`, now, id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, errNotFound
	}
	return r.flowSummary(id)
}

func (r *repository) duplicateFlow(id string) (*Flow, error) {
	source, err := r.getFlow(id)
	if err != nil {
		return nil, err
	}
	tx, err := r.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck
	now := time.Now().UTC()
	newID := uuid.NewString()
	name := source.Name + " copy"
	if len(name) > 120 {
		name = name[:120]
	}
	if _, err := tx.Exec(`INSERT INTO flows
		(id, project_id, name, description, environment_id, settings, variables, edit_version, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)`, newID, source.ProjectID, name, source.Description, source.EnvironmentID,
		marshalJSON(source.Settings), marshalJSON(source.Variables), 1, now, now); err != nil {
		return nil, err
	}
	for _, step := range source.Steps {
		if _, err := tx.Exec(`INSERT INTO flow_steps
			(id, flow_id, position, type, name, enabled, source_api_request_id, request_data, config, created_at, updated_at, sql_data, service_data)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, uuid.NewString(), newID, step.Position, step.Type, step.Name,
			boolToInt(step.Enabled), step.SourceAPIRequestID, marshalJSON(step.Request), marshalJSON(step.Config), now, now, marshalJSON(step.SQL), marshalJSON(step.Service)); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return r.getFlow(newID)
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
