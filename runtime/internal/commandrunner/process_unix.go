//go:build !windows

package commandrunner

import (
	"errors"
	"os/exec"
	"sync"
	"syscall"
)

type processTree struct {
	mu  sync.Mutex
	pid int
	err error
}

func startProcess(cmd *exec.Cmd) (*processTree, error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &processTree{pid: cmd.Process.Pid}, nil
}
func (p *processTree) stop() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.pid == 0 {
		return p.err
	}
	p.err = syscall.Kill(-p.pid, syscall.SIGKILL)
	if errors.Is(p.err, syscall.ESRCH) {
		p.err = nil
	}
	p.pid = 0
	return p.err
}
