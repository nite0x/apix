//go:build windows

package executionenv

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"
)

type processTree struct {
	mu  sync.Mutex
	job windows.Handle
	err error
}

func startProcess(cmd *exec.Cmd) (*processTree, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	if err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	// Suspend until job assignment so even immediately spawned children belong to it.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000004 | 0x08000000, HideWindow: true}
	if err = cmd.Start(); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	handle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|0x0800, false, uint32(cmd.Process.Pid))
	if err == nil {
		err = windows.AssignProcessToJobObject(job, handle)
	}
	if err == nil {
		status, _, _ := windows.NewLazySystemDLL("ntdll.dll").NewProc("NtResumeProcess").Call(uintptr(handle))
		if status != 0 {
			err = fmt.Errorf("resume process failed: NTSTATUS %#x", status)
		}
	}
	if handle != 0 {
		windows.CloseHandle(handle)
	}
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		windows.CloseHandle(job)
		return nil, err
	}
	return &processTree{job: job}, nil
}
func (p *processTree) stop() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.job == 0 {
		return p.err
	}
	p.err = windows.TerminateJobObject(p.job, 1)
	closeErr := windows.CloseHandle(p.job)
	if p.err == nil {
		p.err = closeErr
	}
	p.job = 0
	return p.err
}
