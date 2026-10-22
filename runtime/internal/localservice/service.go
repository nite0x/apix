// Package localservice reuses healthy services and manages only processes it launches.
package localservice

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/apix/apix/runtime/internal/lifecycle"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/apix/apix/runtime/internal/executionenv"
	"github.com/apix/apix/runtime/internal/executionrecord"
	"github.com/google/uuid"
)

type Definition struct {
	EnvironmentID    string            `json:"environment_id,omitempty"`
	Env              map[string]string `json:"env,omitempty"`
	EditVersion      int64             `json:"edit_version"`
	Archived         bool              `json:"archived"`
	ID               string            `json:"id"`
	Name             string            `json:"name"`
	WorkDir          string            `json:"work_dir"`
	Command          string            `json:"command"`
	Args             []string          `json:"args"`
	HealthURL        string            `json:"health_url"`
	StartupTimeoutMS int               `json:"startup_timeout_ms"`
}
type Instance struct {
	EnvironmentID    string `json:"environment_id,omitempty"`
	EnvironmentError string `json:"environment_error,omitempty"`
	ServiceID        string `json:"service_id"`
	Owner            string `json:"owner"`
	Status           string `json:"status"`
	PID              int    `json:"pid"`
	Started          bool   `json:"started"`
}
type LogLine struct {
	Sequence int64     `json:"sequence"`
	Time     time.Time `json:"time"`
	Stream   string    `json:"stream"`
	Message  string    `json:"message"`
}
type process struct {
	instance Instance
	tree     executionenv.Process
	done     chan struct{}
	ready    chan struct{}
	stopping bool
}
type Service struct {
	record   executionrecord.Recorder
	db       *sql.DB
	mu       sync.Mutex
	running  map[string]*process
	borrowed map[string]map[string]*process
	closed   bool
}

func New(db *sql.DB) (*Service, error) {
	if db == nil {
		return nil, errors.New("localservice: database is required")
	}
	if err := lifecycle.Init(db); err != nil {
		return nil, err
	}
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS local_service_definitions (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS local_service_logs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, service_id TEXT NOT NULL, time TEXT NOT NULL, stream TEXT NOT NULL, message TEXT NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS local_service_logs_service ON local_service_logs(service_id,sequence)`,
		`CREATE TABLE IF NOT EXISTS log_cleanup_previews(token TEXT PRIMARY KEY,source TEXT NOT NULL,after_time TEXT NOT NULL,before_time TEXT NOT NULL,max_sequence INTEGER NOT NULL,expires_at TEXT NOT NULL)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			return nil, err
		}
	}
	return &Service{db: db, running: make(map[string]*process), borrowed: make(map[string]map[string]*process)}, nil
}

func (s *Service) PutDefinition(ctx context.Context, d Definition) (*Definition, error) {
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	if err := lifecycle.Check(s.db, "service", d.ID, false); err != nil {
		return nil, err
	}
	if err := lifecycle.Active(s.db, "service", d.ID); err != nil {
		return nil, err
	}
	d.Archived = false
	if strings.TrimSpace(d.Name) == "" || strings.TrimSpace(d.Command) == "" {
		return nil, errors.New("name and executable command are required")
	}
	if d.WorkDir == "" {
		return nil, errors.New("work_dir is required")
	}
	d.WorkDir = d.spec().WorkDir
	if err := executionenv.Validate(d.spec()); err != nil {
		return nil, err
	}
	info, err := executionenv.Check(ctx, executionenv.Spec{EnvironmentID: d.EnvironmentID, WorkDir: d.WorkDir})
	if err != nil {
		return nil, err
	}
	d.EnvironmentID = info.ID
	u, err := url.Parse(d.HealthURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, errors.New("health_url must be an HTTP or HTTPS URL")
	}
	if d.StartupTimeoutMS == 0 {
		d.StartupTimeoutMS = 30000
	}
	if d.StartupTimeoutMS < 1 || d.StartupTimeoutMS > 300000 {
		return nil, errors.New("startup_timeout_ms must be between 1 and 300000")
	}
	if d.ID == "" {
		d.ID = uuid.NewString()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errors.New("service manager is closed")
	}
	if p := s.running[d.ID]; p != nil && (p.instance.Status == "starting" || p.instance.Status == "running" || p.instance.Status == "stopping" || p.instance.Status == "cleanup_failed") {
		return nil, errors.New("stop service before changing its definition")
	}
	current, loadErr := s.definition(ctx, d.ID)
	if loadErr == nil {
		if d.EditVersion > 0 && d.EditVersion != current.EditVersion {
			return nil, fmt.Errorf("%w: 服务配置已在其他窗口修改，请保留输入并重新读取", lifecycle.ErrProtected)
		}
		d.EditVersion = current.EditVersion + 1
	} else if errors.Is(loadErr, sql.ErrNoRows) {
		d.EditVersion = 1
	} else {
		return nil, loadErr
	}
	data, err := json.Marshal(d)
	if err != nil {
		return nil, err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO local_service_definitions(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, d.ID, string(data))
	if err == nil {
		err = lifecycle.Mark(s.db, "service", d.ID, d.Name, false)
	}
	return &d, err
}

// DeleteDefinition removes configuration while preserving historical logs.
func (s *Service) DeleteDefinition(ctx context.Context, id string) error {
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	if err := lifecycle.Check(s.db, "service", id, true); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("service manager is closed")
	}
	if p := s.running[id]; p != nil && (p.instance.Status == "starting" || p.instance.Status == "running" || p.instance.Status == "stopping" || p.instance.Status == "cleanup_failed") {
		return errors.New("stop service before deleting its definition")
	}
	d, err := s.definition(ctx, id)
	if err != nil {
		return err
	}
	if !d.Archived {
		return fmt.Errorf("%w: 请先归档服务配置，再从已归档列表彻底删除", lifecycle.ErrProtected)
	}
	if err := lifecycle.PurgeReferences(s.db, "service", id); err != nil {
		return err
	}
	if err := lifecycle.Mark(s.db, "service", id, d.Name, true); err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `DELETE FROM local_service_definitions WHERE id=?`, id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return sql.ErrNoRows
	}
	delete(s.running, id)
	for owner, services := range s.borrowed {
		delete(services, id)
		if len(services) == 0 {
			delete(s.borrowed, owner)
		}
	}
	return nil
}
func (s *Service) ListDefinitions(ctx context.Context) ([]Definition, error) {
	return s.ListArchivedDefinitions(ctx, false)
}
func (s *Service) ListArchivedDefinitions(ctx context.Context, archived bool) ([]Definition, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT d.data FROM local_service_definitions d LEFT JOIN resource_lifecycle l ON l.kind='service' AND l.id=d.id WHERE COALESCE(l.archived,0)=? ORDER BY d.id`, archived)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Definition{}
	for rows.Next() {
		var raw string
		var d Definition
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(raw), &d); err != nil {
			return nil, err
		}
		if d.EditVersion == 0 {
			d.EditVersion = 1
		}
		d.Archived = archived
		result = append(result, d)
	}
	return result, rows.Err()
}
func (s *Service) definition(ctx context.Context, id string) (Definition, error) {
	var d Definition
	var raw string
	err := s.db.QueryRowContext(ctx, `SELECT data FROM local_service_definitions WHERE id=?`, id).Scan(&raw)
	if err != nil {
		return d, err
	}
	err = json.Unmarshal([]byte(raw), &d)
	if d.EditVersion == 0 {
		d.EditVersion = 1
	}
	d.Archived = lifecycle.Archived(s.db, "service", id)
	return d, err
}
func (d Definition) spec() executionenv.Spec {
	directory := d.WorkDir
	// Existing host-only definitions allowed directories relative to the runtime.
	// Resolve them before applying the new target-aware path validation.
	if executionenv.Local(d.EnvironmentID) && directory != "" && !filepath.IsAbs(directory) {
		if absolute, err := filepath.Abs(directory); err == nil {
			directory = absolute
		}
	}
	return executionenv.Spec{EnvironmentID: d.EnvironmentID, Program: d.Command, Args: d.Args, WorkDir: directory, Env: d.Env}
}
func ownerName(owner string) string {
	if owner == "" {
		return "manual"
	}
	return owner
}
func (s *Service) SetExecutionRecorder(record executionrecord.Recorder) { s.record = record }

func (s *Service) recordAction(ctx context.Context, id, owner, action string, execute func(context.Context, string, string) (*Instance, error)) (result *Instance, err error) {
	if s.record == nil || executionrecord.Skipped(ctx) || ownerName(owner) != "manual" {
		return execute(ctx, id, owner)
	}
	finish, err := s.record(ctx, "service", action+" · "+id, "", map[string]any{"service_id": id, "action": action})
	if err != nil {
		return nil, err
	}
	result, err = execute(executionrecord.Skip(ctx), id, owner)
	return result, errors.Join(err, finish(result, err))
}
func (s *Service) Start(ctx context.Context, id, owner string) (*Instance, error) {
	release := lifecycle.Lease(s.db, "service", id)
	defer release()
	return s.recordAction(ctx, id, owner, "start", s.start)
}
func (s *Service) start(ctx context.Context, id, owner string) (*Instance, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	owner = ownerName(owner)
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, errors.New("service manager is closed")
	}
	// Read under the lifecycle lock so a deleted definition cannot launch a process.
	d, err := s.definition(ctx, id)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	if d.Archived {
		s.mu.Unlock()
		return nil, fmt.Errorf("%w: 服务配置已归档，请先恢复", lifecycle.ErrProtected)
	}
	if p := s.running[id]; p != nil && (p.instance.Status == "starting" || p.instance.Status == "running" || p.instance.Status == "stopping" || p.instance.Status == "cleanup_failed") {
		if p.instance.Status == "starting" {
			ready := p.ready
			s.mu.Unlock()
			select {
			case <-ready:
				return s.Start(ctx, id, owner)
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		if p.instance.Status != "running" {
			s.mu.Unlock()
			return nil, errors.New("service is stopping or awaiting process cleanup")
		}
		if p.instance.Owner != owner {
			if s.borrowed[owner] == nil {
				s.borrowed[owner] = make(map[string]*process)
			}
			s.borrowed[owner][id] = p
		}
		result := p.instance
		result.Started = false
		s.mu.Unlock()
		return &result, nil
	}
	p := &process{instance: Instance{ServiceID: id, Owner: owner, Status: "starting", EnvironmentID: d.EnvironmentID}, done: make(chan struct{}), ready: make(chan struct{})}
	s.running[id] = p
	// Reserve the service before network access, so concurrent starts cannot race.
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		close(p.ready)
		s.mu.Unlock()
	}()
	startupCtx, cancel := context.WithTimeout(ctx, time.Duration(d.StartupTimeoutMS)*time.Millisecond)
	defer cancel()
	healthy, available := s.probeEnvironment(startupCtx, d)
	if healthy {
		s.mu.Lock()
		p.instance.Status = "stopped"
		close(p.done)
		delete(s.running, id)
		canceled := s.closed || p.stopping || startupCtx.Err() != nil
		s.mu.Unlock()
		if canceled {
			return nil, errors.New("service start canceled")
		}
		s.log(id, "manager", "reused existing healthy service; lifecycle remains externally managed")
		return &Instance{ServiceID: id, Owner: "external", Status: "running", EnvironmentID: d.EnvironmentID}, nil
	}
	if available {
		s.mu.Lock()
		p.instance.Status = "failed"
		close(p.done)
		result := p.instance
		s.mu.Unlock()
		err := errors.New("an existing service responded at the health URL but is unhealthy; inspect it before starting another process")
		s.log(id, "manager", err.Error())
		return &result, err
	}
	s.mu.Lock()
	if s.closed || p.stopping || startupCtx.Err() != nil {
		p.instance.Status = "stopped"
		close(p.done)
		result := p.instance
		s.mu.Unlock()
		return &result, errors.New("service start canceled")
	}
	// The environment executor bounds pipe draining and owns process-tree cleanup.
	stdout := &logWriter{s: s, id: id, stream: "stdout"}
	stderr := &logWriter{s: s, id: id, stream: "stderr"}
	tree, err := executionenv.Start(startupCtx, d.spec(), stdout, stderr)
	if err != nil {
		p.instance.Status = "failed"
		close(p.done)
		result := p.instance
		s.mu.Unlock()
		s.log(id, "manager", "start failed: "+err.Error())
		return &result, err
	}
	p.tree = tree
	p.instance.PID = tree.PID()
	p.instance.Started = true
	s.mu.Unlock()
	s.log(id, "manager", fmt.Sprintf("started pid=%d owner=%s", tree.PID(), owner))
	go func() {
		waitErr := tree.Wait()
		// Remove descendants before flushing logs or waiting on the database.
		stopErr := tree.Stop()
		stdout.flush()
		stderr.flush()
		if waitErr != nil {
			s.log(id, "manager", "process exited: "+waitErr.Error())
		} else {
			s.log(id, "manager", "process exited")
		}
		if stopErr != nil {
			s.log(id, "manager", "process tree cleanup failed: "+stopErr.Error())
		}
		// Completion includes durable final output. Close() may close the SQLite
		// connection immediately after this signal, so logging must precede it.
		s.mu.Lock()
		if stopErr != nil {
			p.instance.Status = "cleanup_failed"
		} else if p.stopping {
			p.instance.Status = "stopped"
		} else {
			p.instance.Status = "failed"
		}
		close(p.done)
		s.mu.Unlock()
	}()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if s.healthyEnvironment(startupCtx, d) {
			s.mu.Lock()
			if p.instance.Status == "starting" && !p.stopping {
				p.instance.Status = "running"
				result := p.instance
				s.mu.Unlock()
				s.log(id, "manager", "health check passed")
				return &result, nil
			}
			s.mu.Unlock()
		}
		select {
		case <-p.done:
			result := s.snapshot(p)
			return result, errors.New("service exited before becoming ready; inspect service logs")
		case <-startupCtx.Done():
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
			_, stopErr := s.Stop(cleanupCtx, id, owner)
			cleanupCancel()
			result := s.snapshot(p)
			s.log(id, "manager", "startup failed: "+startupCtx.Err().Error())
			return result, errors.Join(fmt.Errorf("service health check: %w", startupCtx.Err()), stopErr)
		case <-ticker.C:
		}
	}
}
func (s *Service) healthy(ctx context.Context, address string) bool {
	healthy, _ := s.probe(ctx, address)
	return healthy
}
func (s *Service) probe(ctx context.Context, address string) (bool, bool) {
	h := executionenv.Probe(ctx, "local", address)
	return h.Healthy, h.Available
}
func (s *Service) probeEnvironment(ctx context.Context, d Definition) (bool, bool) {
	h := executionenv.Probe(ctx, d.EnvironmentID, d.HealthURL)
	return h.Healthy, h.Available
}
func (s *Service) healthyEnvironment(ctx context.Context, d Definition) bool {
	h, _ := s.probeEnvironment(ctx, d)
	return h
}
func (s *Service) Stop(ctx context.Context, id, owner string) (*Instance, error) {
	return s.recordAction(ctx, id, owner, "stop", s.stop)
}
func (s *Service) stop(ctx context.Context, id, owner string) (*Instance, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	s.mu.Lock()
	p := s.running[id]
	if p == nil {
		s.mu.Unlock()
		return s.Status(ctx, id)
	}
	if p.instance.Owner != ownerName(owner) {
		if s.borrowed[ownerName(owner)][id] == p {
			result := p.instance
			result.Started = false
			s.mu.Unlock()
			return &result, nil
		}
		s.mu.Unlock()
		return nil, errors.New("service is owned by another run")
	}
	if p.instance.Status == "stopped" || p.instance.Status == "failed" {
		result := p.instance
		result.Started = false
		s.mu.Unlock()
		return &result, nil
	}
	p.stopping = true
	p.instance.Status = "stopping"
	tree := p.tree
	s.mu.Unlock()
	if tree != nil {
		if err := tree.Stop(); err != nil {
			s.mu.Lock()
			p.instance.Status = "cleanup_failed"
			s.mu.Unlock()
			s.log(id, "manager", "stop failed: "+err.Error())
			return nil, err
		}
	}
	select {
	case <-p.done:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	s.log(id, "manager", "stopped")
	result := s.snapshot(p)
	if result.Status == "cleanup_failed" {
		return result, errors.New("process tree cleanup failed; inspect service logs")
	}
	return result, nil
}

func (s *Service) snapshot(p *process) *Instance {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := p.instance
	result.Started = false
	return &result
}
func (s *Service) Status(ctx context.Context, id string) (*Instance, error) {
	d, err := s.definition(ctx, id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	result := &Instance{ServiceID: id, Status: "stopped", EnvironmentID: d.EnvironmentID}
	if p := s.running[id]; p != nil {
		*result = p.instance
		result.Started = false
		if result.Status != "stopped" && result.Status != "failed" {
			s.mu.Unlock()
			return result, nil
		}
	}
	s.mu.Unlock()
	if !executionenv.Local(d.EnvironmentID) {
		environments, discoverErr := executionenv.Discover(ctx)
		dName, _, parseErr := executionenv.Parse(d.EnvironmentID)
		available := false
		for _, env := range environments {
			if env.Distribution == dName && env.Running {
				available = true
			}
		}
		if discoverErr != nil || parseErr != nil || !available {
			result.EnvironmentError = "WSL 环境未运行或不可用"
			return result, nil
		}
	}
	health := executionenv.Probe(ctx, d.EnvironmentID, d.HealthURL)
	if health.Unavailable {
		result.EnvironmentError = health.Error
	}
	healthy := health.Healthy
	// A start may have reserved or launched this service during the probe.
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.running[id]; p != nil && p.instance.Status != "stopped" && p.instance.Status != "failed" {
		*result = p.instance
		result.Started = false
	} else if healthy {
		*result = Instance{ServiceID: id, Owner: "external", Status: "running", EnvironmentID: d.EnvironmentID}
	}
	return result, nil
}
func (s *Service) Cleanup(ctx context.Context, owner string) error {
	s.mu.Lock()
	delete(s.borrowed, ownerName(owner))
	ids := []string{}
	for id, p := range s.running {
		if p.instance.Owner == ownerName(owner) && (p.instance.Status == "starting" || p.instance.Status == "running" || p.instance.Status == "stopping" || p.instance.Status == "cleanup_failed") {
			ids = append(ids, id)
		}
	}
	s.mu.Unlock()
	var result error
	for _, id := range ids {
		_, err := s.Stop(ctx, id, owner)
		result = errors.Join(result, err)
	}
	return result
}
func (s *Service) Close() error {
	s.mu.Lock()
	s.closed = true
	owners := map[string]bool{}
	for _, p := range s.running {
		owners[p.instance.Owner] = true
	}
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var result error
	for owner := range owners {
		result = errors.Join(result, s.Cleanup(ctx, owner))
	}
	return result
}

// ArchiveDefinition retires the Apix configuration; external processes keep running.
func (s *Service) ArchiveDefinition(ctx context.Context, id string) error {
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	if err := lifecycle.Check(s.db, "service", id, true); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.definition(ctx, id)
	if err != nil {
		return err
	}
	if p := s.running[id]; p != nil && (p.instance.Status == "starting" || p.instance.Status == "running" || p.instance.Status == "stopping" || p.instance.Status == "cleanup_failed") {
		return fmt.Errorf("%w: 请先停止服务或完成进程清理", lifecycle.ErrProtected)
	}
	d.EditVersion++
	raw, err := json.Marshal(d)
	if err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE local_service_definitions SET data=? WHERE id=?`, string(raw), id); err != nil {
		return err
	}
	return lifecycle.Mark(s.db, "service", id, d.Name, true)
}
func (s *Service) RestoreDefinition(ctx context.Context, id, name string) (*Definition, error) {
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.definition(ctx, id)
	if err != nil {
		return nil, err
	}
	if name != "" {
		d.Name = strings.TrimSpace(name)
	}
	var conflicts int
	err = s.db.QueryRowContext(ctx, `SELECT count(*) FROM local_service_definitions d LEFT JOIN resource_lifecycle l ON l.kind='service' AND l.id=d.id WHERE d.id<>? AND COALESCE(l.archived,0)=0 AND lower(trim(json_extract(d.data,'$.name')))=lower(?)`, id, d.Name).Scan(&conflicts)
	if err != nil {
		return nil, err
	}
	if conflicts > 0 || d.Name == "" {
		return nil, fmt.Errorf("%w: 名称冲突，请改名后恢复", lifecycle.ErrProtected)
	}
	d.Archived = false
	d.EditVersion++
	raw, err := json.Marshal(d)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE local_service_definitions SET data=? WHERE id=?`, string(raw), id); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE resource_lifecycle SET archived=0,name=? WHERE kind='service' AND id=?`, d.Name, id); err != nil {
		return nil, err
	}
	return &d, tx.Commit()
}

// OwnerBusy includes failed process cleanup even after the run published its
// terminal result. The owner must release its actual process tree first.
func (s *Service) OwnerBusy(owner string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.running {
		if p.instance.Owner == owner && (p.instance.Status == "starting" || p.instance.Status == "running" || p.instance.Status == "stopping" || p.instance.Status == "cleanup_failed") {
			return true
		}
	}
	return false
}
