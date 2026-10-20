package lifecycle

import (
	"database/sql"
	"fmt"
	"strings"
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

// PurgeReferences must run under the lifecycle lock. Archived definitions still
// own their references; purge requires those references to be handled explicitly.
func PurgeReferences(db *sql.DB, kind, id string) error {
	if err := Check(db, kind, id, false); err != nil {
		return err
	}
	refs, err := References(db, kind, id)
	if err != nil {
		return err
	}
	if len(refs) > 0 {
		names := []string{}
		for _, r := range refs {
			names = append(names, r.Name+" / "+r.Step+" ("+r.ID+")")
		}
		return fmt.Errorf("%w: 彻底删除前请处理全部定义引用（包括已归档定义）：%s", ErrProtected, strings.Join(names, "；"))
	}
	return nil
}
