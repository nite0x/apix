package httpapi

import (
	"database/sql"
	"fmt"
)

const httpSchemaVersion = 4

// MigrateSchema installs the current HTTP domain schema.
//
// The jump from v1 to v2 was a deliberate destructive replacement. From v2
// onward migrations preserve existing data. v2 adds Flow tables; v3 expands
// their step kinds and execution evidence. Fresh installs create the current
// schema in one pass. Unknown versions are rejected without replacing tables.
func (s *HTTPService) MigrateSchema(db *sql.DB) error {
	s.db = db

	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS schema_metadata (
		name       TEXT PRIMARY KEY,
		version    INTEGER NOT NULL,
		updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
	)`); err != nil {
		return err
	}

	var version int
	err := db.QueryRow(`SELECT version FROM schema_metadata WHERE name = 'http_domain'`).Scan(&version)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == nil && version == httpSchemaVersion {
		s.initRepositories()
		return nil
	}

	// Existing v2 installs are upgraded in place without dropping data.
	if err == nil && version == 2 {
		if err := migrateV2toV3(db); err != nil {
			return err
		}
		s.initRepositories()
		return nil
	}
	if err == nil && version == 3 {
		if err := migrateV3toV4(db); err != nil {
			return err
		}
		s.initRepositories()
		return nil
	}
	if err == nil && version != 1 {
		return fmt.Errorf("unsupported HTTP schema version %d; refusing to replace data", version)
	}

	// Fresh install or legacy (v1) schema: build the full model from scratch.
	if err := rebuildHTTPSchema(db); err != nil {
		return err
	}
	s.initRepositories()
	return nil
}

// migrateV2toV3 adds the Flow tables to an existing v2 database. It is
// non-destructive: no v2 table is dropped or rewritten.
func migrateV2toV3(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	for _, stmt := range flowSchemaStatements() {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("create flow schema: %w", err)
		}
	}
	if _, err := tx.Exec(`INSERT INTO schema_metadata(name, version, updated_at)
		VALUES ('http_domain', ?, datetime('now'))
		ON CONFLICT(name) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`, httpSchemaVersion); err != nil {
		return err
	}
	return tx.Commit()
}

// flowSchemaStatements returns the Flow domain schema. Every statement is
// idempotent (IF NOT EXISTS) so it is safe from both the fresh-install path and
// the incremental v2→v3 migration.
func flowSchemaStatements() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS flows (
			id             TEXT PRIMARY KEY,
			project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			name           TEXT NOT NULL,
			description    TEXT NOT NULL DEFAULT '',
			environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
			settings       TEXT NOT NULL DEFAULT '{}',
			variables      TEXT NOT NULL DEFAULT '[]',
			edit_version   INTEGER NOT NULL DEFAULT 1,
			created_by     TEXT,
			updated_by     TEXT,
			created_at     DATETIME NOT NULL,
			updated_at     DATETIME NOT NULL,
			archived_at    DATETIME
		)`,
		`CREATE INDEX IF NOT EXISTS idx_flows_project_updated ON flows(project_id, updated_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_flows_active ON flows(project_id, updated_at DESC) WHERE archived_at IS NULL`,
		`CREATE TABLE IF NOT EXISTS flow_steps (
			id                    TEXT PRIMARY KEY,
			flow_id               TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
			position              INTEGER NOT NULL,
			type                  TEXT NOT NULL CHECK (type IN ('http','sql','service')),
			name                  TEXT NOT NULL,
			enabled               INTEGER NOT NULL DEFAULT 1,
			source_api_request_id TEXT REFERENCES api_requests(id) ON DELETE SET NULL,
			request_data          TEXT NOT NULL,
			sql_data              TEXT,
			service_data          TEXT,
			config                TEXT NOT NULL DEFAULT '{}',
			created_at            DATETIME NOT NULL,
			updated_at            DATETIME NOT NULL,
			UNIQUE(flow_id, position)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_flow_steps_order ON flow_steps(flow_id, position)`,
		`CREATE TABLE IF NOT EXISTS flow_runs (
			id                 TEXT PRIMARY KEY,
			project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			flow_id            TEXT REFERENCES flows(id) ON DELETE SET NULL,
			flow_version       INTEGER NOT NULL,
			flow_name_snapshot TEXT NOT NULL,
			flow_snapshot      TEXT NOT NULL,
			environment_id     TEXT REFERENCES environments(id) ON DELETE SET NULL,
			trigger_type       TEXT NOT NULL CHECK (trigger_type IN ('manual','ai','test')),
			status             TEXT NOT NULL CHECK (
				status IN ('queued','running','paused','succeeded','failed','cancelled')
			),
			current_step       INTEGER NOT NULL DEFAULT 0,
			total_steps        INTEGER NOT NULL,
			variables_snapshot TEXT NOT NULL DEFAULT '{}',
			error_code         TEXT,
			error_message      TEXT,
			cleanup_error      TEXT,
			created_at         DATETIME NOT NULL,
			started_at         DATETIME,
			finished_at        DATETIME
		)`,
		`CREATE INDEX IF NOT EXISTS idx_flow_runs_flow ON flow_runs(flow_id, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_flow_runs_project ON flow_runs(project_id, created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS flow_run_steps (
			id               TEXT PRIMARY KEY,
			flow_run_id      TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
			flow_step_id     TEXT,
			position         INTEGER NOT NULL,
			name_snapshot    TEXT NOT NULL,
			request_snapshot TEXT NOT NULL,
			type             TEXT NOT NULL DEFAULT 'http',
			sql_snapshot     TEXT,
			service_snapshot TEXT,
			result           TEXT,
			assertions       TEXT NOT NULL DEFAULT '[]',
			status           TEXT NOT NULL CHECK (
				status IN ('pending','running','paused','succeeded','failed','skipped','cancelled')
			),
			api_run_id       TEXT REFERENCES api_runs(id) ON DELETE SET NULL,
			error_code       TEXT,
			error_message    TEXT,
			started_at       DATETIME,
			finished_at      DATETIME,
			UNIQUE(flow_run_id, position)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_flow_run_steps_order ON flow_run_steps(flow_run_id, position)`,
	}
}

// Preserve every definition, run and HTTP snapshot while widening the step CHECK.
// flow_run_steps has no foreign key to flow_steps, so rebuilding only this table
// does not delete execution history.
func migrateV3toV4(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	statements := []string{
		`CREATE TABLE flow_steps_v4 (
		 id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
		 position INTEGER NOT NULL, type TEXT NOT NULL CHECK(type IN ('http','sql','service')),
		 name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
		 source_api_request_id TEXT REFERENCES api_requests(id) ON DELETE SET NULL,
		 request_data TEXT NOT NULL, sql_data TEXT, service_data TEXT,
		 config TEXT NOT NULL DEFAULT '{}', created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
		 UNIQUE(flow_id, position))`,
		`INSERT INTO flow_steps_v4(id,flow_id,position,type,name,enabled,source_api_request_id,request_data,config,created_at,updated_at)
		 SELECT id,flow_id,position,type,name,enabled,source_api_request_id,request_data,config,created_at,updated_at FROM flow_steps`,
		`DROP TABLE flow_steps`,
		`ALTER TABLE flow_steps_v4 RENAME TO flow_steps`,
		`CREATE INDEX idx_flow_steps_order ON flow_steps(flow_id, position)`,
		`ALTER TABLE flow_runs ADD COLUMN cleanup_error TEXT`,
		`ALTER TABLE flow_run_steps ADD COLUMN type TEXT NOT NULL DEFAULT 'http'`,
		`ALTER TABLE flow_run_steps ADD COLUMN sql_snapshot TEXT`,
		`ALTER TABLE flow_run_steps ADD COLUMN service_snapshot TEXT`,
		`ALTER TABLE flow_run_steps ADD COLUMN result TEXT`,
		`ALTER TABLE flow_run_steps ADD COLUMN assertions TEXT NOT NULL DEFAULT '[]'`,
		`UPDATE schema_metadata SET version=4, updated_at=datetime('now') WHERE name='http_domain'`,
	}
	for _, stmt := range statements {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("upgrade flow schema: %w", err)
		}
	}
	return tx.Commit()
}

func rebuildHTTPSchema(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	// Drop the replaced HTTP model, including any partially-created schema.
	// Flow tables are dropped first because they reference api_requests/api_runs.
	drops := []string{
		`DROP TABLE IF EXISTS flow_run_steps`,
		`DROP TABLE IF EXISTS flow_runs`,
		`DROP TABLE IF EXISTS flow_steps`,
		`DROP TABLE IF EXISTS flows`,
		`DROP TABLE IF EXISTS api_examples`,
		`DROP TABLE IF EXISTS api_fields`,
		`DROP TABLE IF EXISTS api_responses`,
		`DROP TABLE IF EXISTS api_params`,
		`DROP TABLE IF EXISTS api_executions`,
		`DROP TABLE IF EXISTS apis`,
		`DROP TABLE IF EXISTS collections`,
		`DROP TABLE IF EXISTS api_runs`,
		`DROP TABLE IF EXISTS api_working_copies`,
		`DROP TABLE IF EXISTS api_requests`,
		`DROP TABLE IF EXISTS api_collections`,
	}
	for _, stmt := range drops {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("drop old HTTP schema: %w", err)
		}
	}

	stmts := []string{
		`CREATE TABLE IF NOT EXISTS projects (
			id          TEXT PRIMARY KEY,
			name        TEXT NOT NULL,
			description TEXT,
			created_at  DATETIME NOT NULL DEFAULT (datetime('now')),
			updated_at  DATETIME NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE TABLE IF NOT EXISTS environments (
			id          TEXT PRIMARY KEY,
			project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			name        TEXT NOT NULL,
			base_url    TEXT NOT NULL DEFAULT '',
			env_type    TEXT NOT NULL DEFAULT 'dev' CHECK (env_type IN ('production','staging','dev')),
			sort_order  INTEGER NOT NULL DEFAULT 0,
			created_at  DATETIME NOT NULL DEFAULT (datetime('now')),
			updated_at  DATETIME NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE TABLE IF NOT EXISTS env_variables (
			id             TEXT PRIMARY KEY,
			environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
			key            TEXT NOT NULL,
			value          TEXT NOT NULL DEFAULT '',
			is_secret      INTEGER NOT NULL DEFAULT 0,
			created_at     DATETIME NOT NULL DEFAULT (datetime('now')),
			updated_at     DATETIME NOT NULL DEFAULT (datetime('now')),
			UNIQUE (environment_id, key)
		)`,
		`CREATE TABLE api_collections (
			id          TEXT PRIMARY KEY,
			project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			parent_id   TEXT REFERENCES api_collections(id) ON DELETE CASCADE,
			name        TEXT NOT NULL,
			description TEXT,
			sort_order  INTEGER NOT NULL DEFAULT 0,
			status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
			created_by  TEXT,
			created_at  DATETIME NOT NULL,
			updated_at  DATETIME NOT NULL,
			archived_at DATETIME
		)`,
		`CREATE INDEX idx_api_collections_project ON api_collections(project_id, status, sort_order)`,
		`CREATE UNIQUE INDEX uq_api_collections_name ON api_collections(project_id, COALESCE(parent_id, ''), name) WHERE status = 'active'`,
		`CREATE TABLE api_requests (
			id            TEXT PRIMARY KEY,
			collection_id TEXT NOT NULL REFERENCES api_collections(id) ON DELETE CASCADE,
			name          TEXT NOT NULL,
			description   TEXT,
			method        TEXT NOT NULL CHECK (method IN ('GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS')),
			url           TEXT NOT NULL,
			query_params  TEXT NOT NULL DEFAULT '[]',
			headers       TEXT NOT NULL DEFAULT '[]',
			body_type     TEXT NOT NULL DEFAULT 'none' CHECK (body_type IN ('none','json','text','form','multipart','binary')),
			body          TEXT,
			auth_config   TEXT,
			source_type   TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual','curl_import','history_restore','duplicate')),
			status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
			sort_order    INTEGER NOT NULL DEFAULT 0,
			created_by    TEXT,
			updated_by    TEXT,
			created_at    DATETIME NOT NULL,
			updated_at    DATETIME NOT NULL,
			archived_at   DATETIME
		)`,
		`CREATE INDEX idx_api_requests_collection ON api_requests(collection_id, status, sort_order)`,
		`CREATE INDEX idx_api_requests_updated ON api_requests(updated_at DESC)`,
		`CREATE TABLE api_working_copies (
			id                TEXT PRIMARY KEY,
			project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			owner_id          TEXT NOT NULL,
			api_request_id    TEXT REFERENCES api_requests(id) ON DELETE CASCADE,
			environment_id    TEXT REFERENCES environments(id) ON DELETE SET NULL,
			name              TEXT,
			request_data      TEXT NOT NULL,
			source_type       TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual','curl_import','history_restore','duplicate')),
			status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','discarded','expired')),
			content_hash      TEXT NOT NULL,
			base_content_hash TEXT,
			edit_version      INTEGER NOT NULL DEFAULT 1,
			created_at        DATETIME NOT NULL,
			updated_at        DATETIME NOT NULL,
			expires_at        DATETIME,
			discarded_at      DATETIME
		)`,
		`CREATE INDEX idx_working_copies_recent ON api_working_copies(project_id, owner_id, updated_at DESC) WHERE status = 'active'`,
		`CREATE INDEX idx_working_copies_expiration ON api_working_copies(expires_at) WHERE status = 'active'`,
		`CREATE UNIQUE INDEX uq_working_copy_request_owner ON api_working_copies(owner_id, api_request_id) WHERE status = 'active' AND api_request_id IS NOT NULL`,
		`CREATE TABLE api_runs (
			id                 TEXT PRIMARY KEY,
			project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			api_request_id     TEXT REFERENCES api_requests(id) ON DELETE SET NULL,
			working_copy_id    TEXT REFERENCES api_working_copies(id) ON DELETE SET NULL,
			environment_id     TEXT REFERENCES environments(id) ON DELETE SET NULL,
			session_id         TEXT,
			step_id            TEXT,
			trigger_type       TEXT NOT NULL CHECK (trigger_type IN ('manual','retry','ai','test')),
			status             TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','timed_out','cancelled')),
			request_snapshot   TEXT NOT NULL,
			response_status    INTEGER,
			response_headers   TEXT,
			response_body      TEXT,
			response_size      INTEGER,
			response_truncated INTEGER NOT NULL DEFAULT 0,
			duration_ms        INTEGER,
			error_code         TEXT,
			error_message      TEXT,
			is_pinned          INTEGER NOT NULL DEFAULT 0,
			started_at         DATETIME NOT NULL,
			finished_at        DATETIME,
			expires_at         DATETIME
		)`,
		`CREATE INDEX idx_api_runs_request ON api_runs(api_request_id, started_at DESC)`,
		`CREATE INDEX idx_api_runs_working_copy ON api_runs(working_copy_id, started_at DESC)`,
		`CREATE INDEX idx_api_runs_project ON api_runs(project_id, started_at DESC)`,
		`CREATE INDEX idx_api_runs_expiration ON api_runs(expires_at) WHERE is_pinned = 0`,
		`INSERT OR IGNORE INTO projects(id, name, description) VALUES ('default', 'My APIs', 'Default local project')`,
	}
	stmts = append(stmts, flowSchemaStatements()...)
	for _, stmt := range stmts {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("create HTTP schema: %w", err)
		}
	}

	if _, err := tx.Exec(`INSERT INTO schema_metadata(name, version, updated_at)
		VALUES ('http_domain', ?, datetime('now'))
		ON CONFLICT(name) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`, httpSchemaVersion); err != nil {
		return err
	}
	return tx.Commit()
}
