//go:build !windows

package localipc

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

func address(key string) (string, error) {
	// Keep below Unix socket path limits, even with a long database path.
	return filepath.Join(os.TempDir(), fmt.Sprintf("apix-%d", os.Getuid()), key+".sock"), nil
}

type lockedListener struct {
	net.Listener
	lock *os.File
}

func (l *lockedListener) Close() error {
	err := l.Listener.Close()
	_ = l.lock.Close()
	return err
}

func Listen(socket string) (net.Listener, error) {
	dir := filepath.Dir(socket)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 || !ok || stat.Uid != uint32(os.Getuid()) {
		return nil, errors.New("MCP socket directory must be private to the current user")
	}
	fd, err := unix.Open(socket+".lock", unix.O_CREAT|unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	lock := os.NewFile(uintptr(fd), socket+".lock")
	if err = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		lock.Close()
		return nil, fmt.Errorf("local MCP runtime already running: %w", err)
	}
	// Holding the per-database lock makes removal of a crashed socket safe.
	if info, err := os.Lstat(socket); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			lock.Close()
			return nil, errors.New("MCP socket path is occupied by a non-socket file")
		}
		if err := os.Remove(socket); err != nil {
			lock.Close()
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		lock.Close()
		return nil, err
	}
	l, err := net.Listen("unix", socket)
	if err != nil {
		lock.Close()
		return nil, err
	}
	if err := os.Chmod(socket, 0600); err != nil {
		l.Close()
		lock.Close()
		return nil, err
	}
	return &lockedListener{Listener: l, lock: lock}, nil
}

func Dial(ctx context.Context, socket string) (net.Conn, error) {
	if !filepath.IsAbs(socket) {
		return nil, errors.New("MCP requires an absolute local socket path")
	}
	return (&net.Dialer{}).DialContext(ctx, "unix", socket)
}
