//go:build !windows

package database

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"os"
)

var secretPrefix = []byte("aesgcm:v1:")

func (s *secretStore) aead() (cipher.AEAD, error) {
	if s.key == nil {
		var sequence int
		var name, path string
		if err := s.db.QueryRow(`PRAGMA database_list`).Scan(&sequence, &name, &path); err != nil {
			return nil, err
		}
		if path == "" {
			s.key = make([]byte, 32)
			if _, err := rand.Read(s.key); err != nil {
				s.key = nil
				return nil, err
			}
		} else {
			path += ".credentials.key"
			key, err := os.ReadFile(path)
			if errors.Is(err, os.ErrNotExist) {
				key = make([]byte, 32)
				if _, err = rand.Read(key); err != nil {
					return nil, err
				}
				file, createErr := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
				if errors.Is(createErr, os.ErrExist) {
					key, err = os.ReadFile(path)
				} else if createErr != nil {
					return nil, createErr
				} else {
					_, err = file.Write(key)
					closeErr := file.Close()
					if err == nil {
						err = closeErr
					}
				}
			}
			if err != nil {
				return nil, err
			}
			if len(key) != 32 {
				return nil, errors.New("invalid local credential key")
			}
			s.key = key
		}
	}
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (s *secretStore) protect(id string, plaintext []byte) ([]byte, error) {
	aead, err := s.aead()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return append(bytes.Clone(secretPrefix), aead.Seal(nonce, nonce, plaintext, []byte(id))...), nil
}

func (s *secretStore) unprotect(id string, ciphertext []byte) ([]byte, error) {
	if !bytes.HasPrefix(ciphertext, secretPrefix) {
		return nil, errors.New("unsupported password encryption")
	}
	aead, err := s.aead()
	if err != nil {
		return nil, err
	}
	ciphertext = ciphertext[len(secretPrefix):]
	if len(ciphertext) < aead.NonceSize()+aead.Overhead() {
		return nil, errors.New("invalid encrypted password")
	}
	return aead.Open(nil, ciphertext[:aead.NonceSize()], ciphertext[aead.NonceSize():], []byte(id))
}
