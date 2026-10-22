package executionenv

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
)

const ConfigLimit = 8 << 20

type Configuration struct {
	Path     string `json:"path"`
	Exists   bool   `json:"exists"`
	Data     []byte `json:"data,omitempty"`
	Expected []byte `json:"expected,omitempty"`
	Backup   string `json:"backup,omitempty"`
	Write    bool   `json:"write,omitempty"`
}

func readConfig(path string) (Configuration, error) {
	result := Configuration{Path: path}
	if !filepath.IsAbs(path) {
		return result, errors.New("配置路径需要是绝对路径")
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	if !info.Mode().IsRegular() || info.Size() > ConfigLimit {
		return result, errors.New("配置必须是小于 8 MB 的普通文件；符号链接请手动管理")
	}
	result.Exists = true
	file, err := os.Open(path)
	if err != nil {
		return result, err
	}
	defer file.Close()
	result.Data, err = io.ReadAll(io.LimitReader(file, ConfigLimit+1))
	if len(result.Data) > ConfigLimit {
		return result, errors.New("配置文件过大")
	}
	return result, err
}
func configOperation(request Configuration) (Configuration, error) {
	current, err := readConfig(request.Path)
	if err != nil || !request.Write {
		return current, err
	}
	if len(request.Data) > ConfigLimit {
		return current, errors.New("配置文件过大")
	}
	if request.Exists != current.Exists || !bytes.Equal(request.Expected, current.Data) {
		return current, errors.New("配置刚刚被其他程序修改，请刷新后重试")
	}
	if bytes.Equal(request.Data, current.Data) && current.Exists {
		return current, nil
	}
	if err = os.MkdirAll(filepath.Dir(request.Path), 0700); err != nil {
		return current, err
	}
	if current.Exists {
		backup, err := os.CreateTemp(filepath.Dir(request.Path), filepath.Base(request.Path)+".apix-backup-*")
		if err != nil {
			return current, err
		}
		current.Backup = backup.Name()
		_, err = backup.Write(current.Data)
		closeErr := backup.Close()
		if err != nil {
			return current, err
		}
		if closeErr != nil {
			return current, closeErr
		}
	}
	tmp, err := os.CreateTemp(filepath.Dir(request.Path), ".apix-install-*")
	if err != nil {
		return current, err
	}
	defer os.Remove(tmp.Name())
	if current.Exists {
		info, e := os.Stat(request.Path)
		if e != nil {
			tmp.Close()
			return current, e
		}
		if e = tmp.Chmod(info.Mode().Perm()); e != nil {
			tmp.Close()
			return current, e
		}
	}
	_, err = tmp.Write(request.Data)
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err != nil {
		return current, err
	}
	if closeErr != nil {
		return current, closeErr
	}
	latest, err := readConfig(request.Path)
	if err != nil {
		return current, err
	}
	if latest.Exists != request.Exists || !bytes.Equal(latest.Data, request.Expected) {
		return current, errors.New("配置刚刚被其他程序修改；原文件未修改")
	}
	if err = os.Rename(tmp.Name(), request.Path); err != nil {
		return current, err
	}
	current.Data = request.Data
	current.Exists = true
	return current, nil
}
func Config(ctx context.Context, id string, request Configuration) (Configuration, error) {
	if Local(id) {
		return configOperation(request)
	}
	reply, err := remoteOnce(ctx, id, "config", message{Config: request})
	return reply.Config, err
}
