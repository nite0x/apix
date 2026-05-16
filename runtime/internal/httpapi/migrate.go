package httpapi

import "database/sql"

// MigrateSchema prepares the HTTP data model and stores the shared database handle.
func (s *HTTPService) MigrateSchema(db *sql.DB) error {
	s.db = db
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS projects (
			id          TEXT     PRIMARY KEY,
			name        TEXT     NOT NULL,
			description TEXT,
			created_at  DATETIME NOT NULL DEFAULT (datetime('now')),
			updated_at  DATETIME NOT NULL DEFAULT (datetime('now'))
		)`,

		`CREATE TABLE IF NOT EXISTS environments (
			id          TEXT     PRIMARY KEY,
			project_id  TEXT     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			name        TEXT     NOT NULL,
			base_url    TEXT     NOT NULL DEFAULT '',
			env_type    TEXT     NOT NULL DEFAULT 'dev'
			              CHECK (env_type IN ('production', 'staging', 'dev')),
			sort_order  INTEGER  NOT NULL DEFAULT 0,
			created_at  DATETIME NOT NULL DEFAULT (datetime('now')),
			updated_at  DATETIME NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_environments_project ON environments (project_id)`,

		`CREATE TABLE IF NOT EXISTS env_variables (
			id             TEXT     PRIMARY KEY,
			environment_id TEXT     NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
			key            TEXT     NOT NULL,
			value          TEXT     NOT NULL DEFAULT '',
			is_secret      INTEGER  NOT NULL DEFAULT 0,
			created_at     DATETIME NOT NULL DEFAULT (datetime('now')),
			updated_at     DATETIME NOT NULL DEFAULT (datetime('now')),
			UNIQUE (environment_id, key)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_env_variables_env ON env_variables (environment_id)`,

		`CREATE TABLE IF NOT EXISTS collections (
			id          TEXT     PRIMARY KEY,
			project_id  TEXT     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			name        TEXT     NOT NULL,
			description TEXT,
			sort_order  INTEGER  NOT NULL DEFAULT 0,
			created_by  TEXT,
			created_at  DATETIME NOT NULL DEFAULT (datetime('now')),
			updated_at  DATETIME NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_collections_project ON collections (project_id)`,

		`CREATE TABLE IF NOT EXISTS apis (
			id                TEXT     PRIMARY KEY,
			collection_id     TEXT     NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
			name              TEXT     NOT NULL,
			method            TEXT     NOT NULL CHECK (method IN ('GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS')),
			path              TEXT     NOT NULL,
			description       TEXT,
			request_body_type TEXT     NOT NULL DEFAULT 'json'
			                    CHECK (request_body_type IN ('json', 'form', 'multipart', 'none')),
			intent            TEXT     NOT NULL DEFAULT '[]',
			risk              TEXT     NOT NULL DEFAULT 'LOW' CHECK (risk IN ('LOW', 'MEDIUM', 'HIGH')),
			need_confirmation INTEGER  NOT NULL DEFAULT 0,
			side_effect       INTEGER  NOT NULL DEFAULT 0,
			retry_strategy    TEXT     NOT NULL DEFAULT 'default'
			                    CHECK (retry_strategy IN ('default', 'disabled', 'idempotent')),
			context           TEXT     NOT NULL DEFAULT '[]',
			metadata          TEXT,
			created_by        TEXT,
			created_at        DATETIME NOT NULL DEFAULT (datetime('now')),
			updated_at        DATETIME NOT NULL DEFAULT (datetime('now')),
			UNIQUE (collection_id, method, path)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_apis_collection ON apis (collection_id)`,
		`CREATE INDEX IF NOT EXISTS idx_apis_risk       ON apis (risk)`,

		`CREATE TABLE IF NOT EXISTS api_params (
			id          TEXT    PRIMARY KEY,
			api_id      TEXT    NOT NULL REFERENCES apis(id) ON DELETE CASCADE,
			location    TEXT    NOT NULL DEFAULT 'query'
			              CHECK (location IN ('query', 'path', 'header', 'cookie')),
			name        TEXT    NOT NULL,
			type        TEXT    NOT NULL DEFAULT 'string'
			              CHECK (type IN ('string', 'integer', 'number', 'boolean')),
			required    INTEGER NOT NULL DEFAULT 0,
			description TEXT,
			example     TEXT,
			sort_order  INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE INDEX IF NOT EXISTS idx_api_params_api ON api_params (api_id)`,

		`CREATE TABLE IF NOT EXISTS api_responses (
			id           TEXT    PRIMARY KEY,
			api_id       TEXT    NOT NULL REFERENCES apis(id) ON DELETE CASCADE,
			status_code  INTEGER NOT NULL,
			description  TEXT,
			content_type TEXT    NOT NULL DEFAULT 'application/json',
			sort_order   INTEGER NOT NULL DEFAULT 0,
			UNIQUE (api_id, status_code)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_api_responses_api ON api_responses (api_id)`,

		// response_id IS NULL  -> request body field
		// response_id NOT NULL -> response body field for that status code
		// parent_id   IS NULL  -> root node for the current scope
		// name        IS NULL  -> array item node
		`CREATE TABLE IF NOT EXISTS api_fields (
			id          TEXT    PRIMARY KEY,
			api_id      TEXT    NOT NULL REFERENCES apis(id) ON DELETE CASCADE,
			response_id TEXT    REFERENCES api_responses(id) ON DELETE CASCADE,
			parent_id   TEXT    REFERENCES api_fields(id) ON DELETE CASCADE,
			name        TEXT,
			type        TEXT    NOT NULL DEFAULT 'string'
			              CHECK (type IN ('string', 'integer', 'number', 'boolean', 'object', 'array')),
			format      TEXT,
			required    INTEGER NOT NULL DEFAULT 0,
			description TEXT,
			example     TEXT,
			enum_values TEXT,
			constraints TEXT,
			sort_order  INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE INDEX IF NOT EXISTS idx_api_fields_api      ON api_fields (api_id)`,
		`CREATE INDEX IF NOT EXISTS idx_api_fields_response ON api_fields (response_id)`,
		`CREATE INDEX IF NOT EXISTS idx_api_fields_parent   ON api_fields (parent_id)`,

		// example_id is a logical foreign key to avoid a cycle with api_examples.
		`CREATE TABLE IF NOT EXISTS api_executions (
			id              TEXT     PRIMARY KEY,
			api_id          TEXT     REFERENCES apis(id) ON DELETE SET NULL,
			environment_id  TEXT     REFERENCES environments(id) ON DELETE SET NULL,
			example_id      TEXT,
			session_id      TEXT,
			step_id         TEXT,
			triggered_by    TEXT     NOT NULL DEFAULT 'manual'
			                  CHECK (triggered_by IN ('manual', 'ai')),
			req_method      TEXT     NOT NULL,
			req_url         TEXT     NOT NULL,
			req_headers     TEXT,
			req_body        TEXT,
			res_status      INTEGER,
			res_headers     TEXT,
			res_body        TEXT,
			res_duration_ms INTEGER,
			res_error       TEXT,
			created_at      DATETIME NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_executions_api     ON api_executions (api_id)`,
		`CREATE INDEX IF NOT EXISTS idx_executions_session ON api_executions (session_id)`,
		`CREATE INDEX IF NOT EXISTS idx_executions_example ON api_executions (example_id)`,
		`CREATE INDEX IF NOT EXISTS idx_executions_time    ON api_executions (created_at DESC)`,

		`CREATE TABLE IF NOT EXISTS api_examples (
			id                  TEXT     PRIMARY KEY,
			api_id              TEXT     NOT NULL REFERENCES apis(id) ON DELETE CASCADE,
			environment_id      TEXT     REFERENCES environments(id) ON DELETE SET NULL,
			name                TEXT     NOT NULL,
			description         TEXT,
			is_default          INTEGER  NOT NULL DEFAULT 0,
			path_params         TEXT,
			query_params        TEXT,
			headers             TEXT,
			body                TEXT,
			res_status          INTEGER,
			res_headers         TEXT,
			res_body            TEXT,
			source_execution_id TEXT     REFERENCES api_executions(id) ON DELETE SET NULL,
			sort_order          INTEGER  NOT NULL DEFAULT 0,
			created_by          TEXT,
			created_at          DATETIME NOT NULL DEFAULT (datetime('now')),
			updated_at          DATETIME NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_api_examples_api ON api_examples (api_id)`,
	}

	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			return err
		}
	}
	return nil
}
