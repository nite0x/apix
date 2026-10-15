package database

import (
	"database/sql"
	"errors"
)

// Access is serialized by Service.mu. key is used only by the Unix protector.
type secretStore struct {
	db  *sql.DB
	key []byte
}

func (s *secretStore) seal(id, password string) ([]byte, error) {
	return s.protect(id, append([]byte{1}, []byte(password)...))
}

func (s *secretStore) open(id string, ciphertext []byte) (string, error) {
	plaintext, err := s.unprotect(id, ciphertext)
	if err != nil {
		return "", err
	}
	if len(plaintext) == 0 || plaintext[0] != 1 {
		return "", errors.New("invalid encrypted password")
	}
	return string(plaintext[1:]), nil
}
