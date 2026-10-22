// Package commandrunner executes one-shot programs without implicit shell expansion.
package commandrunner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"github.com/apix/apix/runtime/internal/executionenv"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const OutputLimit = 256 * 1024

type Request struct {
	EnvironmentID  string            `json:"environment_id,omitempty"`
	Program        string            `json:"program"`
	Args           []string          `json:"args"`
	WorkDir        string            `json:"work_dir"`
	Env            map[string]string `json:"env"`
	Stdin          string            `json:"stdin"`
	TimeoutSeconds int               `json:"timeout_seconds"`
}
type Result struct {
	EnvironmentID   string `json:"environment_id,omitempty"`
	ExitCode        *int   `json:"exit_code,omitempty"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	StdoutTruncated bool   `json:"stdout_truncated"`
	StderrTruncated bool   `json:"stderr_truncated"`
	DurationMS      int64  `json:"duration_ms"`
	Platform        string `json:"platform"`
	WorkDir         string `json:"work_dir"`
	ErrorKind       string `json:"error_kind,omitempty"`
	ErrorMessage    string `json:"error_message,omitempty"`
}

func Validate(req *Request) error {
	if req == nil || strings.TrimSpace(req.Program) == "" || strings.ContainsRune(req.Program, 0) || len(req.Program) > 8192 {
		return errors.New("command_request.program 必填，且不能包含空字符")
	}
	if req.TimeoutSeconds == 0 {
		req.TimeoutSeconds = 30
	}
	if req.TimeoutSeconds < 1 || req.TimeoutSeconds > 300 {
		return errors.New("命令超时必须为 1–300 秒")
	}
	if len(req.Args) > 256 || len(req.Env) > 128 || len(req.Stdin) > OutputLimit {
		return errors.New("最多 256 个参数、128 个环境变量和 256 KB 标准输入")
	}
	if len(req.WorkDir) > 8192 || strings.ContainsRune(req.WorkDir, 0) {
		return errors.New("工作目录无效")
	}
	if req.WorkDir != "" && !(executionenv.Local(req.EnvironmentID) && filepath.IsAbs(req.WorkDir) || !executionenv.Local(req.EnvironmentID) && strings.HasPrefix(req.WorkDir, "/")) && !strings.Contains(req.WorkDir, "{{") {
		return errors.New("工作目录需要是绝对路径")
	}
	if err := executionenv.Validate(executionenv.Spec{EnvironmentID: req.EnvironmentID, Program: req.Program}); err != nil {
		return err
	}
	total := 0
	for _, arg := range req.Args {
		if strings.ContainsRune(arg, 0) {
			return errors.New("参数不能包含空字符")
		}
		total += len(arg)
	}
	for name, value := range req.Env {
		if name == "" || strings.ContainsAny(name, "=\x00") || strings.ContainsRune(value, 0) {
			return errors.New("环境变量名称或值无效")
		}
		total += len(name) + len(value)
	}
	if total > OutputLimit {
		return errors.New("参数和环境变量合计最多 256 KB")
	}
	if req.Args == nil {
		req.Args = []string{}
	}
	if req.Env == nil {
		req.Env = map[string]string{}
	}
	return nil
}

type cappedBuffer struct {
	mu        sync.Mutex
	data      bytes.Buffer
	truncated bool
}

func (b *cappedBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(data)
	room := OutputLimit - b.data.Len()
	if len(data) > room {
		b.truncated = true
		data = data[:room]
	}
	_, _ = b.data.Write(data)
	return n, nil
}
func (b *cappedBuffer) snapshot() (string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	data := b.data.Bytes()
	return strings.ToValidUTF8(string(data), "�"), b.truncated
}

type Runner struct {
	mu     sync.Mutex
	closed bool
	next   uint64
	active map[uint64]context.CancelFunc
	wg     sync.WaitGroup
}

func New() *Runner { return &Runner{active: map[uint64]context.CancelFunc{}} }
func (r *Runner) Stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	for _, cancel := range r.active {
		cancel()
	}
}
func (r *Runner) Wait(ctx context.Context) error {
	done := make(chan struct{})
	go func() { r.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (r *Runner) Run(parent context.Context, req Request) *Result {
	started := time.Now()
	out := &Result{Platform: runtime.GOOS, WorkDir: req.WorkDir, EnvironmentID: req.EnvironmentID}
	if !executionenv.Local(req.EnvironmentID) {
		out.Platform = "linux"
	}
	defer func() { out.DurationMS = time.Since(started).Milliseconds() }()
	fail := func(kind string, err error) *Result { out.ErrorKind = kind; out.ErrorMessage = err.Error(); return out }
	if err := Validate(&req); err != nil {
		return fail("input", err)
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(req.TimeoutSeconds)*time.Second)
	defer cancel()
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return fail("cancelled", errors.New("Runtime 正在关闭，不能启动命令"))
	}
	r.next++
	id := r.next
	r.active[id] = cancel
	r.wg.Add(1)
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.active, id); r.mu.Unlock(); r.wg.Done() }()
	if ctx.Err() != nil {
		return fail("cancelled", errors.New("命令已取消，未启动进程"))
	}
	if req.WorkDir == "" && executionenv.Local(req.EnvironmentID) {
		dir, err := os.Getwd()
		if err != nil {
			return fail("start", err)
		}
		req.WorkDir = dir
	}
	if !executionenv.Local(req.EnvironmentID) {
		info, err := executionenv.Check(ctx, executionenv.Spec{EnvironmentID: req.EnvironmentID, WorkDir: req.WorkDir})
		if err != nil {
			return fail("environment", err)
		}
		req.EnvironmentID = info.ID
		out.EnvironmentID = info.ID
		if req.WorkDir == "" {
			req.WorkDir = info.WorkDir
		}
	}
	out.WorkDir = req.WorkDir
	stdout, stderr := &cappedBuffer{}, &cappedBuffer{}
	tree, err := executionenv.Start(ctx, executionenv.Spec{EnvironmentID: req.EnvironmentID, Program: req.Program, Args: req.Args, WorkDir: req.WorkDir, Env: req.Env, Stdin: req.Stdin}, stdout, stderr)
	if err != nil {
		return fail("start", fmt.Errorf("进程启动失败: %w", err))
	}
	// One process group/job belongs to this invocation; never signal other services.
	finished := make(chan struct{})
	watcherDone := make(chan struct{})
	go func() {
		defer close(watcherDone)
		select {
		case <-ctx.Done():
			_ = tree.Stop()
		case <-finished:
		}
	}()
	waitErr := tree.Wait()
	close(finished)
	<-watcherDone
	stopErr := tree.Stop()
	out.Stdout, out.StdoutTruncated = stdout.snapshot()
	out.Stderr, out.StderrTruncated = stderr.snapshot()
	code := tree.ExitCode()
	out.ExitCode = &code
	if ctx.Err() != nil {
		kind, message := "cancelled", "命令已取消，已清理本次进程树"
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			kind, message = "timeout", "命令执行超时，已清理本次进程树"
		}
		if stopErr != nil {
			message += "；进程树清理失败"
		}
		return fail(kind, errors.New(message))
	}
	if stopErr != nil {
		return fail("cleanup", errors.New("进程树清理失败"))
	}
	var exitErr *exec.ExitError
	if waitErr != nil && tree.ExitCode() < 0 && !errors.As(waitErr, &exitErr) && !errors.Is(waitErr, exec.ErrWaitDelay) {
		return fail("execution", fmt.Errorf("等待进程结束失败: %w", waitErr))
	}
	if out.ExitCode == nil || *out.ExitCode < 0 {
		return fail("signal", errors.New("进程被信号终止"))
	}
	// A lingering child may hold output pipes open after its parent exited. The
	// group is already stopped; capture is incomplete and cannot prove assertions.
	if errors.Is(waitErr, exec.ErrWaitDelay) {
		out.StdoutTruncated = true
		out.StderrTruncated = true
	}
	return out
}
