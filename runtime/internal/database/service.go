// Package database provides MySQL and PostgreSQL-compatible SQL execution.
package database

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/apix/apix/runtime/internal/lifecycle"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/apix/apix/runtime/internal/executionrecord"
	"github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
)

var (
	ErrInvalid  = errors.New("invalid database input")
	ErrNotFound = errors.New("database connection not found")
)

type Connection struct {
	EditVersion        int64  `json:"edit_version"`
	Archived           bool   `json:"archived"`
	CredentialsCleared bool   `json:"credentials_cleared"`
	ID                 string `json:"id"`
	Name               string `json:"name"`
	Type               string `json:"type"`
	Host               string `json:"host,omitempty"`
	Port               int    `json:"port,omitempty"`
	Database           string `json:"database,omitempty"`
	Username           string `json:"username,omitempty"`
	SSLMode            string `json:"ssl_mode,omitempty"`
}

// ConnectionInput accepts a password without ever returning it in Connection.
// Omitted passwords preserve the existing password on direct connection updates.
type ConnectionInput struct {
	Connection
	Password *string `json:"password"`
}

func (input *ConnectionInput) UnmarshalJSON(data []byte) error {
	type fields ConnectionInput
	var value fields
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return fmt.Errorf("%w: expected id, name, type, host, port, database, username, ssl_mode and password fields", ErrInvalid)
	}
	*input = ConnectionInput(value)
	return nil
}

type Command struct {
	BatchID      string `json:"batch_id,omitempty"`
	ConnectionID string `json:"connection_id"`
	Mode         string `json:"mode"`
	SQL          string `json:"sql"`
	Params       []any  `json:"params"`
	TimeoutMS    int    `json:"timeout_ms"`
	MaxRows      int    `json:"max_rows"`
}

type Result struct {
	ExecutionID int64            `json:"execution_id,omitempty"`
	Columns     []string         `json:"columns"`
	Rows        []map[string]any `json:"rows"`
	// RowCount is -1 when Truncated: an exact count is not available.
	RowCount     int   `json:"row_count"`
	RowsAffected int64 `json:"rows_affected"`
	DurationMS   int64 `json:"duration_ms"`
	Truncated    bool  `json:"truncated"`
}

type poolEntry struct {
	fingerprint [32]byte
	db          *sql.DB
}

type Service struct {
	record  executionrecord.Recorder
	store   *sql.DB
	mu      sync.Mutex
	pools   map[string]poolEntry
	closed  bool
	secrets secretStore
}

func New(db *sql.DB) (*Service, error) {
	if db == nil {
		return nil, errors.New("database metadata store is required")
	}
	if err := lifecycle.Init(db); err != nil {
		return nil, err
	}
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS database_connections (
		id TEXT PRIMARY KEY, name TEXT NOT NULL
	)`)
	if err != nil {
		return nil, fmt.Errorf("initialize database connections: %w", err)
	}
	var versionColumn int
	if err := db.QueryRow(`SELECT count(*) FROM pragma_table_info('database_connections') WHERE name='edit_version'`).Scan(&versionColumn); err != nil {
		return nil, err
	}
	if versionColumn == 0 {
		if _, err := db.Exec(`ALTER TABLE database_connections ADD COLUMN edit_version INTEGER NOT NULL DEFAULT 1`); err != nil {
			return nil, err
		}
	}
	// Retain legacy connection IDs and names, but discard the obsolete source.
	var legacy int
	if err := db.QueryRow(`SELECT count(*) FROM pragma_table_info('database_connections') WHERE name='dsn_env'`).Scan(&legacy); err != nil {
		return nil, err
	}
	if legacy > 0 {
		if _, err := db.Exec(`ALTER TABLE database_connections DROP COLUMN dsn_env`); err != nil {
			return nil, fmt.Errorf("migrate database connections: %w", err)
		}
	}
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS database_connection_settings (
		connection_id TEXT PRIMARY KEY REFERENCES database_connections(id) ON DELETE CASCADE,
		host TEXT NOT NULL, port INTEGER NOT NULL, database_name TEXT NOT NULL,
		username TEXT NOT NULL, password_encrypted BLOB NOT NULL
	)`)
	if err != nil {
		return nil, fmt.Errorf("initialize database connection settings: %w", err)
	}
	s := &Service{store: db, pools: make(map[string]poolEntry), secrets: secretStore{db: db}}
	if err := s.migrateDriverSettings(); err != nil {
		return nil, err
	}
	if err := s.initHistory(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Service) PutConnection(ctx context.Context, item Connection) (*Connection, error) {
	return s.SaveConnection(ctx, ConnectionInput{Connection: item})
}

func (s *Service) SaveConnection(ctx context.Context, input ConnectionInput) (*Connection, error) {
	gate := lifecycle.For(s.store)
	gate.Lock()
	defer gate.Unlock()
	if err := lifecycle.Check(s.store, "database", input.ID, false); err != nil {
		return nil, err
	}
	if err := lifecycle.Active(s.store, "database", input.ID); err != nil {
		return nil, err
	}
	item := input.Connection
	item.Name = strings.TrimSpace(item.Name)
	item.Host = strings.TrimSpace(item.Host)
	item.Database = strings.TrimSpace(item.Database)
	item.Username = strings.TrimSpace(item.Username)
	item.Type = strings.ToLower(strings.TrimSpace(item.Type))
	item.SSLMode = strings.ToLower(strings.TrimSpace(item.SSLMode))
	s.mu.Lock()
	defer s.mu.Unlock()
	var currentVersion int64
	versionErr := s.store.QueryRowContext(ctx, `SELECT edit_version FROM database_connections WHERE id=?`, item.ID).Scan(&currentVersion)
	if versionErr != nil && !errors.Is(versionErr, sql.ErrNoRows) {
		return nil, versionErr
	}
	if versionErr == nil && item.EditVersion > 0 && item.EditVersion != currentVersion {
		return nil, fmt.Errorf("%w: 数据库连接已在其他窗口修改，请保留输入并重新读取", lifecycle.ErrProtected)
	}
	item.EditVersion = currentVersion + 1
	var storedType, storedSSL string
	err := s.store.QueryRowContext(ctx, `SELECT driver_type,ssl_mode FROM database_connection_settings WHERE connection_id=?`, item.ID).Scan(&storedType, &storedSSL)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if item.Type == "" {
		item.Type = storedType
		if item.Type == "" {
			item.Type = "mysql"
		}
	}
	if item.Type == "postgres" {
		item.Type = "postgresql"
	}
	if item.Type != "mysql" && item.Type != "postgresql" && item.Type != "hologres" {
		return nil, fmt.Errorf("%w: type must be mysql, postgresql or hologres", ErrInvalid)
	}
	if item.SSLMode == "" && item.Type == storedType {
		item.SSLMode = storedSSL
	}
	if item.Type == "mysql" {
		if item.SSLMode != "" {
			return nil, fmt.Errorf("%w: ssl_mode is only supported for PostgreSQL and Hologres", ErrInvalid)
		}
	} else {
		if item.SSLMode == "" {
			item.SSLMode = "prefer"
		}
		switch item.SSLMode {
		case "disable", "prefer", "require", "verify-full":
		default:
			return nil, fmt.Errorf("%w: ssl_mode must be disable, prefer, require or verify-full", ErrInvalid)
		}
	}
	if item.Name == "" {
		return nil, fmt.Errorf("%w: name is required", ErrInvalid)
	}
	if len(item.ID) > 128 || len(item.Name) > 256 || len(item.Host) > 253 || len(item.Database) > 256 || len(item.Username) > 256 || input.Password != nil && len(*input.Password) > 4096 {
		return nil, fmt.Errorf("%w: connection fields exceed maximum length", ErrInvalid)
	}
	if item.Port == 0 {
		item.Port = defaultPort(item.Type)
	}
	if item.Host == "" || strings.ContainsAny(item.Host, "/@?#\\ \t\r\n\x00") || strings.Contains(item.Host, ":") && net.ParseIP(item.Host) == nil || item.Database == "" || item.Username == "" || strings.ContainsRune(item.Database+item.Username, 0) || item.Port < 1 || item.Port > 65535 {
		return nil, fmt.Errorf("%w: host, port (1-65535), database and username are required", ErrInvalid)
	}
	if item.ID == "" {
		item.ID = uuid.NewString()
	}
	var encrypted []byte
	if input.Password == nil {
		err := s.store.QueryRowContext(ctx, `SELECT password_encrypted FROM database_connection_settings WHERE connection_id=?`, item.ID).Scan(&encrypted)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}
	if encrypted == nil {
		password := ""
		if input.Password != nil {
			password = *input.Password
		}
		var err error
		encrypted, err = s.secrets.seal(item.ID, password)
		if err != nil {
			return nil, errors.New("cannot encrypt database password")
		}
	}
	if input.Password != nil {
		item.CredentialsCleared = false
	} else if lifecycle.CredentialsCleared(s.store, item.ID) {
		item.CredentialsCleared = true
	}
	tx, err := s.store.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO database_connections(id,name,edit_version) VALUES(?,?,?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name,edit_version=excluded.edit_version`, item.ID, item.Name, item.EditVersion)
	if err != nil {
		return nil, fmt.Errorf("save database connection: %w", err)
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO database_connection_settings(connection_id,host,port,database_name,username,password_encrypted,driver_type,ssl_mode) VALUES(?,?,?,?,?,?,?,?)
			ON CONFLICT(connection_id) DO UPDATE SET host=excluded.host,port=excluded.port,database_name=excluded.database_name,username=excluded.username,password_encrypted=excluded.password_encrypted,driver_type=excluded.driver_type,ssl_mode=excluded.ssl_mode`, item.ID, item.Host, item.Port, item.Database, item.Username, encrypted, item.Type, item.SSLMode)
	if err != nil {
		return nil, fmt.Errorf("save database connection settings: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO resource_lifecycle(kind,id,name,archived,credentials_cleared) VALUES('database',?,?,0,?) ON CONFLICT(kind,id) DO UPDATE SET name=excluded.name,credentials_cleared=excluded.credentials_cleared`, item.ID, item.Name, item.CredentialsCleared); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if entry, ok := s.pools[item.ID]; ok {
		_ = entry.db.Close()
		delete(s.pools, item.ID)
	}
	if input.Password != nil {
		if _, err := s.store.ExecContext(ctx, `UPDATE resource_lifecycle SET credentials_cleared=0 WHERE kind='database' AND id=?`, item.ID); err != nil {
			return nil, err
		}
	}
	return &item, nil
}

// DeleteConnection removes only Apix metadata, never the remote database.
func (s *Service) DeleteConnection(ctx context.Context, id string) error {
	gate := lifecycle.For(s.store)
	gate.Lock()
	defer gate.Unlock()
	var exists int
	if err := s.store.QueryRowContext(ctx, `SELECT count(*) FROM database_connections WHERE id=?`, id).Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		return ErrNotFound
	}
	if err := lifecycle.Check(s.store, "database", id, true); err != nil {
		return err
	}
	if !lifecycle.Archived(s.store, "database", id) {
		return fmt.Errorf("%w: 请先归档数据库连接，再从已归档列表彻底删除", lifecycle.ErrProtected)
	}
	if err := lifecycle.PurgeReferences(s.store, "database", id); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.store.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `DELETE FROM database_connection_settings WHERE connection_id=?`, id); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `DELETE FROM database_connections WHERE id=?`, id)
	if err != nil {
		return fmt.Errorf("delete database connection: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if entry, ok := s.pools[id]; ok {
		_ = entry.db.Close()
		delete(s.pools, id)
	}
	return nil
}

func (s *Service) ListConnections(ctx context.Context) ([]Connection, error) {
	return s.ListArchivedConnections(ctx, false)
}
func (s *Service) ListArchivedConnections(ctx context.Context, archived bool) ([]Connection, error) {
	rows, err := s.store.QueryContext(ctx, `SELECT c.id,c.name,COALESCE(d.host,''),COALESCE(d.port,0),COALESCE(d.database_name,''),COALESCE(d.username,''),COALESCE(d.driver_type,'mysql'),COALESCE(d.ssl_mode,''),COALESCE(l.credentials_cleared,0),c.edit_version FROM database_connections c LEFT JOIN database_connection_settings d ON c.id=d.connection_id LEFT JOIN resource_lifecycle l ON l.kind='database' AND l.id=c.id WHERE COALESCE(l.archived,0)=? ORDER BY c.name,c.id`, archived)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Connection, 0)
	for rows.Next() {
		var item Connection
		if err := rows.Scan(&item.ID, &item.Name, &item.Host, &item.Port, &item.Database, &item.Username, &item.Type, &item.SSLMode, &item.CredentialsCleared, &item.EditVersion); err != nil {
			return nil, err
		}
		item.Archived = archived
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) pool(ctx context.Context, id string) (*sql.DB, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, password, err := s.connectionCredentials(ctx, id)
	if err != nil {
		return nil, err
	}
	data, _ := json.Marshal(struct {
		Connection
		Password string
	}{item, password})
	fingerprint := sha256.Sum256(data)
	if s.closed {
		return nil, errors.New("database service is closed")
	}
	if entry, ok := s.pools[id]; ok {
		if entry.fingerprint == fingerprint {
			return entry.db, nil
		}
		_ = entry.db.Close()
		delete(s.pools, id)
	}
	connector, err := connectionConnector(item, password)
	if err != nil {
		return nil, err
	}
	db := sql.OpenDB(connector)
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(3 * time.Minute)
	s.pools[id] = poolEntry{fingerprint: fingerprint, db: db}
	return db, nil
}

// Called under s.mu so connection updates and secret access are serialized.
func (s *Service) connectionConfig(ctx context.Context, id string) (*mysql.Config, error) {
	item, password, err := s.connectionCredentials(ctx, id)
	if err != nil {
		return nil, err
	}
	return mysqlConfig(item, password)
}

func (s *Service) TestConnection(ctx context.Context, id string) error {
	release := lifecycle.Lease(s.store, "database", id)
	defer release()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	db, err := s.pool(ctx, id)
	if err != nil {
		return err
	}
	return db.PingContext(ctx)
}

func (s *Service) SetExecutionRecorder(record executionrecord.Recorder) { s.record = record }

func (s *Service) Execute(ctx context.Context, cmd Command) (result *Result, err error) {
	release := lifecycle.Lease(s.store, "database", cmd.ConnectionID)
	defer release()
	if err := validate(&cmd); err != nil {
		return nil, err
	}
	var historyID int64
	if s.record != nil && !executionrecord.Skipped(ctx) {
		finish, e := s.record(ctx, "sql", "SQL · "+cmd.ConnectionID, cmd.BatchID, cmd)
		if e != nil {
			return nil, e
		}
		defer func() {
			err = errors.Join(err, func() error {
				if result == nil {
					return finish(map[string]any{"execution_id": historyID}, err)
				}
				return finish(result, err)
			}())
		}()
	}

	ctx, cancel := context.WithTimeout(ctx, time.Duration(cmd.TimeoutMS)*time.Millisecond)
	defer cancel()
	started := time.Now()
	id, err := s.beginExecution(ctx, cmd, started)
	if err != nil {
		return nil, err
	}
	historyID = id
	defer func() { s.finishExecution(id, started, result, err) }()
	db, err := s.pool(ctx, cmd.ConnectionID)
	if err != nil {
		return nil, err
	}
	result, err = execute(ctx, db, cmd)
	if result != nil {
		result.ExecutionID = id
		result.DurationMS = time.Since(started).Milliseconds()
	}
	return result, err
}

func validate(cmd *Command) error {
	if strings.TrimSpace(cmd.ConnectionID) == "" || strings.TrimSpace(cmd.SQL) == "" {
		return fmt.Errorf("%w: connection_id and sql are required", ErrInvalid)
	}
	if cmd.Mode != "query" && cmd.Mode != "exec" {
		return fmt.Errorf("%w: mode must be query or exec", ErrInvalid)
	}
	if cmd.TimeoutMS == 0 {
		cmd.TimeoutMS = 30000
	}
	if cmd.TimeoutMS < 1 || cmd.TimeoutMS > 300000 {
		return fmt.Errorf("%w: timeout_ms must be between 1 and 300000", ErrInvalid)
	}
	if cmd.MaxRows == 0 {
		cmd.MaxRows = 1000
	}
	if cmd.MaxRows < 1 || cmd.MaxRows > 10000 {
		return fmt.Errorf("%w: max_rows must be between 1 and 10000", ErrInvalid)
	}
	return nil
}

func execute(ctx context.Context, db *sql.DB, cmd Command) (*Result, error) {
	result := &Result{Columns: []string{}, Rows: []map[string]any{}}
	if cmd.Mode == "exec" {
		res, err := db.ExecContext(ctx, cmd.SQL, cmd.Params...)
		if err != nil {
			return nil, err
		}
		result.RowsAffected, err = res.RowsAffected()
		return result, err
	}
	rows, err := db.QueryContext(ctx, cmd.SQL, cmd.Params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result.Columns, err = rows.Columns()
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	for _, column := range result.Columns {
		if seen[column] {
			return nil, fmt.Errorf("%w: duplicate column %q; use unique SQL aliases", ErrInvalid, column)
		}
		seen[column] = true
	}
	for rows.Next() {
		if len(result.Rows) == cmd.MaxRows {
			result.Truncated = true
			result.RowCount = -1
			break
		}
		values := make([]any, len(result.Columns))
		pointers := make([]any, len(values))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, err
		}
		row := make(map[string]any, len(values))
		for i, value := range values {
			if bytes, ok := value.([]byte); ok {
				value = string(bytes)
			}
			row[result.Columns[i]] = value
		}
		result.Rows = append(result.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if !result.Truncated {
		result.RowCount = len(result.Rows)
	}
	return result, nil
}

func (s *Service) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	var errs []error
	for id, entry := range s.pools {
		if err := entry.db.Close(); err != nil {
			errs = append(errs, err)
		}
		delete(s.pools, id)
	}
	return errors.Join(errs...)
}

func (s *Service) ArchiveConnection(ctx context.Context, id string) error {
	gate := lifecycle.For(s.store)
	gate.Lock()
	defer gate.Unlock()
	if err := lifecycle.Check(s.store, "database", id, true); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var name string
	if err := s.store.QueryRowContext(ctx, `SELECT name FROM database_connections WHERE id=?`, id).Scan(&name); err != nil {
		return err
	}
	if _, err := s.store.ExecContext(ctx, `UPDATE database_connections SET edit_version=edit_version+1 WHERE id=?`, id); err != nil {
		return err
	}
	if err := lifecycle.Mark(s.store, "database", id, name, true); err != nil {
		return err
	}
	if entry, ok := s.pools[id]; ok {
		_ = entry.db.Close()
		delete(s.pools, id)
	}
	return nil
}
func (s *Service) RestoreConnection(ctx context.Context, id, name string) error {
	gate := lifecycle.For(s.store)
	gate.Lock()
	defer gate.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	var original string
	if err := s.store.QueryRowContext(ctx, `SELECT name FROM database_connections WHERE id=?`, id).Scan(&original); err != nil {
		return err
	}
	if name == "" {
		name = original
	}
	name = strings.TrimSpace(name)
	var n int
	if err := s.store.QueryRowContext(ctx, `SELECT count(*) FROM database_connections c LEFT JOIN resource_lifecycle l ON l.kind='database' AND l.id=c.id WHERE c.id<>? AND COALESCE(l.archived,0)=0 AND lower(trim(c.name))=lower(?)`, id, name).Scan(&n); err != nil {
		return err
	}
	if name == "" || n > 0 {
		return fmt.Errorf("%w: 名称冲突，请改名后恢复", lifecycle.ErrProtected)
	}
	tx, err := s.store.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE database_connections SET name=?,edit_version=edit_version+1 WHERE id=?`, name, id); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE resource_lifecycle SET archived=0,name=? WHERE kind='database' AND id=?`, name, id); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Service) ClearCredentials(ctx context.Context, id string) error {
	gate := lifecycle.For(s.store)
	gate.Lock()
	defer gate.Unlock()
	if err := lifecycle.Check(s.store, "database", id, true); err != nil {
		return err
	}
	if !lifecycle.Archived(s.store, "database", id) {
		return fmt.Errorf("%w: 请先归档连接再清除凭据", lifecycle.ErrProtected)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.store.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE database_connection_settings SET password_encrypted=X'' WHERE connection_id=?`, id); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE resource_lifecycle SET credentials_cleared=1 WHERE kind='database' AND id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}
