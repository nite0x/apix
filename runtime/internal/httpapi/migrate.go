package httpapi

import (
	"database/sql"
	"fmt"
)

const httpSchemaVersion = 2

// MigrateSchema installs the current HTTP domain schema. Older HTTP schemas are
// deliberately destroyed instead of migrated: this project treats v2 as a clean
// model replacement with no compatibility layer.
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

	if err := rebuildHTTPSchema(db); err != nil {
		return err
	}
	s.initRepositories()
	return nil
}

func rebuildHTTPSchema(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	// Drop the replaced HTTP model, including any partially-created v2 schema.
	drops := []string{
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
