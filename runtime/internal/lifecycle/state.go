package lifecycle

import (
	"database/sql"
	"fmt"
)

// This additive metadata table never replaces resource IDs, credentials or history.
func Init(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS resource_lifecycle(kind TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',archived INTEGER NOT NULL DEFAULT 0,credentials_cleared INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,id))`)
	return err
}
func Archived(db *sql.DB, kind, id string) bool {
	var archived bool
	_ = db.QueryRow(`SELECT archived FROM resource_lifecycle WHERE kind=? AND id=?`, kind, id).Scan(&archived)
	return archived
}
func Mark(db *sql.DB, kind, id, name string, archived bool) error {
	_, err := db.Exec(`INSERT INTO resource_lifecycle(kind,id,name,archived) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET name=excluded.name,archived=excluded.archived`, kind, id, name, archived)
	return err
}
func Active(db *sql.DB, kind, id string) error {
	if Archived(db, kind, id) {
		return fmt.Errorf("%w: 配置已归档，请先恢复", ErrProtected)
	}
	return nil
}
func CredentialsCleared(db *sql.DB, id string) bool {
	var cleared bool
	_ = db.QueryRow(`SELECT credentials_cleared FROM resource_lifecycle WHERE kind='database' AND id=?`, id).Scan(&cleared)
	return cleared
}
