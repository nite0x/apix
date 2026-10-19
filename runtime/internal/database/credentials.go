package database

import (
	"database/sql"
	"sync"
)

// Credentials reuses the local database key and platform protection for secrets.
type Credentials struct {
	mu    sync.Mutex
	store secretStore
}

func NewCredentials(db *sql.DB) *Credentials { return &Credentials{store: secretStore{db: db}} }
func (s *Credentials) Seal(id, value string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.store.seal(id, value)
}
func (s *Credentials) Open(id string, value []byte) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.store.open(id, value)
}
