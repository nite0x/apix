package database

import (
	"bytes"
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

var secretPrefix = []byte("dpapi:v1:")

func blob(data []byte) windows.DataBlob {
	value := windows.DataBlob{Size: uint32(len(data))}
	if len(data) > 0 {
		value.Data = &data[0]
	}
	return value
}

func (s *secretStore) protect(id string, plaintext []byte) ([]byte, error) {
	input, entropy := blob(plaintext), blob([]byte("apix.database:"+id))
	var output windows.DataBlob
	if err := windows.CryptProtectData(&input, nil, &entropy, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(output.Data)))
	return append(bytes.Clone(secretPrefix), unsafe.Slice(output.Data, output.Size)...), nil
}

func (s *secretStore) unprotect(id string, ciphertext []byte) ([]byte, error) {
	if !bytes.HasPrefix(ciphertext, secretPrefix) {
		return nil, errors.New("unsupported password encryption")
	}
	input, entropy := blob(ciphertext[len(secretPrefix):]), blob([]byte("apix.database:"+id))
	var output windows.DataBlob
	if err := windows.CryptUnprotectData(&input, nil, &entropy, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(output.Data)))
	return bytes.Clone(unsafe.Slice(output.Data, output.Size)), nil
}
