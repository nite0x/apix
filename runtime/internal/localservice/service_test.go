package localservice

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	_ "modernc.org/sqlite"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// The test binary doubles as a real service process, including a child server.
func TestServiceHelper(t *testing.T) {
	split := -1
	for i, arg := range os.Args {
		if arg == "localservice-helper" {
			split = i
			break
		}
	}
	if split < 0 {
		return
	}
	mode, address := os.Args[split+1], os.Args[split+2]
	switch mode {
	case "exit":
		fmt.Fprint(os.Stderr, "intentional failure without newline")
		os.Exit(7)
	case "hang":
		for {
			time.Sleep(time.Second)
		}
	case "fork", "forkexit":
		cmd := exec.Command(os.Args[0], "-test.run=^TestServiceHelper$", "localservice-helper", "serve", address)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		fmt.Printf("child pid=%d\n", cmd.Process.Pid)
		if mode == "forkexit" {
			client := &http.Client{Timeout: time.Second}
			for {
				response, err := client.Get("http://" + address)
				if err == nil {
					response.Body.Close()
					os.Exit(0)
				}
				time.Sleep(10 * time.Millisecond)
			}
		}
		for {
			time.Sleep(time.Second)
		}
	default:
		fmt.Fprintln(os.Stdout, "helper ready")
		fmt.Fprintln(os.Stderr, "helper stderr")
		err := http.ListenAndServe(address, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
}
func newTestService(t *testing.T) (*Service, *sql.DB) {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	s, err := New(db)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
		db.Close()
	})
	return s, db
}
func definitionFor(t *testing.T, s *Service, mode string) *Definition {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	d, err := s.PutDefinition(context.Background(), Definition{Name: mode, WorkDir: t.TempDir(), Command: executable, Args: []string{"-test.run=^TestServiceHelper$", "localservice-helper", mode, address}, HealthURL: "http://" + address, StartupTimeoutMS: 4000})
	if err != nil {
		t.Fatal(err)
	}
	return d
}
func TestHealthyOwnershipLogsAndPersistence(t *testing.T) {
	s, db := newTestService(t)
	d := definitionFor(t, s, "serve")
	ctx := context.Background()
	started, err := s.Start(ctx, d.ID, "flow-1")
	if err != nil {
		t.Fatal(err)
	}
	if !started.Started || started.Status != "running" || started.PID == 0 {
		t.Fatalf("unexpected instance: %+v", started)
	}
	again, err := s.Start(ctx, d.ID, "flow-1")
	if err != nil || again.Started {
		t.Fatalf("same owner should be idempotent: %+v %v", again, err)
	}
	if _, err := s.Stop(ctx, d.ID, "flow-2"); err == nil {
		t.Fatal("different owner could stop service")
	}
	reused, err := s.Start(ctx, d.ID, "flow-2")
	if err != nil || reused.Started || reused.PID != started.PID || reused.Owner != "flow-1" {
		t.Fatalf("different owner should reuse without taking ownership: %+v %v", reused, err)
	}
	if result, err := s.Stop(ctx, d.ID, "flow-2"); err != nil || result.Status != "running" {
		t.Fatalf("stop should preserve a borrowed service: %+v %v", result, err)
	}
	if err := s.Cleanup(ctx, "flow-2"); err != nil {
		t.Fatal(err)
	}
	status, _ := s.Status(ctx, d.ID)
	if status.Status != "running" {
		t.Fatal("cleanup touched other owner's service")
	}
	if err := s.Cleanup(ctx, "flow-1"); err != nil {
		t.Fatal(err)
	}
	status, _ = s.Status(ctx, d.ID)
	if status.Status != "stopped" {
		t.Fatalf("cleanup status: %+v", status)
	}
	logs, err := s.Logs(ctx, d.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	stdout, stderr := false, false
	exitRecorded := false
	for _, line := range logs {
		stdout = stdout || line.Stream == "stdout"
		stderr = stderr || line.Stream == "stderr"
		exitRecorded = exitRecorded || strings.HasPrefix(line.Message, "process exited")
	}
	if !stdout || !stderr || !exitRecorded {
		t.Fatalf("missing process output: %+v", logs)
	}
	restored, err := New(db)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	definitions, err := restored.ListDefinitions(ctx)
	if err != nil || len(definitions) != 1 {
		t.Fatalf("definitions not persisted: %v %v", definitions, err)
	}
	persisted, err := restored.Logs(ctx, d.ID, 0)
	if err != nil || len(persisted) != len(logs) {
		t.Fatalf("logs not persisted: %d %v", len(persisted), err)
	}
	later, err := s.Logs(ctx, d.ID, logs[len(logs)-1].Sequence)
	if err != nil || len(later) != 0 {
		t.Fatalf("sequence filter: %v %v", later, err)
	}
}
func TestEarlyExitAndCancellation(t *testing.T) {
	for _, mode := range []string{"exit", "hang"} {
		t.Run(mode, func(t *testing.T) {
			s, _ := newTestService(t)
			d := definitionFor(t, s, mode)
			ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
			defer cancel()
			startedAt := time.Now()
			_, err := s.Start(ctx, d.ID, "run")
			if err == nil {
				t.Fatal("expected startup failure")
			}
			if time.Since(startedAt) > 3*time.Second {
				t.Fatal("startup did not terminate promptly")
			}
			status, _ := s.Status(context.Background(), d.ID)
			if status.Status != "failed" && status.Status != "stopped" {
				t.Fatalf("service remains active: %+v", status)
			}
			if mode == "exit" {
				logs, _ := s.Logs(context.Background(), d.ID, 0)
				found := false
				for _, line := range logs {
					found = found || strings.Contains(line.Message, "intentional failure without newline")
				}
				if !found {
					t.Fatalf("partial stderr lost: %+v", logs)
				}
			}
		})
	}
}
func TestStopKillsChildProcess(t *testing.T) {
	s, _ := newTestService(t)
	d := definitionFor(t, s, "fork")
	ctx := context.Background()
	if _, err := s.Start(ctx, d.ID, "run"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Stop(ctx, d.ID, "run"); err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(2 * time.Second)
	for s.healthy(ctx, d.HealthURL) && time.Now().Before(until) {
		time.Sleep(20 * time.Millisecond)
	}
	if s.healthy(ctx, d.HealthURL) {
		t.Fatal("descendant server survived stopping its parent")
	}
}
func TestReuseAlreadyAvailableHealthURL(t *testing.T) {
	s, db := newTestService(t)
	d := definitionFor(t, s, "serve")
	listener, err := net.Listen("tcp", strings.TrimPrefix(d.HealthURL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })}
	go server.Serve(listener)
	defer server.Close()
	result, err := s.Start(context.Background(), d.ID, "run")
	if err != nil || result.PID != 0 || result.Started || result.Owner != "external" || result.Status != "running" {
		t.Fatalf("did not reuse an existing service: %+v %v", result, err)
	}
	if err := s.Cleanup(context.Background(), "run"); err != nil {
		t.Fatal(err)
	}
	if result, err := s.Stop(context.Background(), d.ID, "run"); err != nil || result.Status != "running" {
		t.Fatalf("stop must not terminate external service: %+v %v", result, err)
	}
	restored, err := New(db)
	if err != nil {
		t.Fatal(err)
	}
	status, err := restored.Status(context.Background(), d.ID)
	if err != nil || status.Owner != "external" || status.Status != "running" {
		t.Fatalf("new manager did not discover external service: %+v %v", status, err)
	}
	if err := restored.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil || !s.healthy(context.Background(), d.HealthURL) {
		t.Fatalf("closing manager affected external service: %v", err)
	}
	server.Close()
	status, err = s.Status(context.Background(), d.ID)
	if err != nil || status.Status != "stopped" {
		t.Fatalf("external status did not refresh after shutdown: %+v %v", status, err)
	}
}

func TestConcurrentStartReusesSingleProcess(t *testing.T) {
	s, _ := newTestService(t)
	defer s.Close()
	d := definitionFor(t, s, "serve")
	type outcome struct {
		instance *Instance
		err      error
	}
	results := make(chan outcome, 2)
	for _, owner := range []string{"run-1", "run-2"} {
		go func(owner string) {
			instance, err := s.Start(context.Background(), d.ID, owner)
			results <- outcome{instance, err}
		}(owner)
	}
	first, second := <-results, <-results
	if first.err != nil || second.err != nil {
		t.Fatalf("concurrent starts: %v %v", first.err, second.err)
	}
	if first.instance.PID == 0 || first.instance.PID != second.instance.PID || first.instance.Owner != second.instance.Owner || first.instance.Started == second.instance.Started {
		t.Fatalf("concurrent callers did not share a single process: %+v %+v", first.instance, second.instance)
	}
}

func TestUnhealthyExistingServiceDoesNotLaunchAnotherProcess(t *testing.T) {
	s, _ := newTestService(t)
	d := definitionFor(t, s, "serve")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer server.Close()
	d.HealthURL = server.URL
	d, err := s.PutDefinition(context.Background(), *d)
	if err != nil {
		t.Fatal(err)
	}
	instance, err := s.Start(context.Background(), d.ID, "run")
	if err == nil || instance.PID != 0 || instance.Started || !strings.Contains(err.Error(), "unhealthy") {
		t.Fatalf("launched a duplicate for unhealthy service: %+v %v", instance, err)
	}
}

func TestServiceDetailsRoute(t *testing.T) {
	s, _ := newTestService(t)
	defer s.Close()
	d := definitionFor(t, s, "serve")
	if _, err := s.Start(context.Background(), d.ID, "manual"); err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	s.Routes(router.Group("/api"))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest("GET", "/api/services/"+d.ID, nil))
	var details Details
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &details) != nil {
		t.Fatalf("details response: %d %s", response.Code, response.Body.String())
	}
	if details.Definition.Command != d.Command || details.Definition.WorkDir != d.WorkDir || details.Instance.PID == 0 || !details.Health.Healthy || details.Health.CheckedAt.IsZero() || len(details.Logs) == 0 {
		t.Fatalf("incomplete details: %+v", details)
	}
	missing := httptest.NewRecorder()
	router.ServeHTTP(missing, httptest.NewRequest("GET", "/api/services/missing", nil))
	if missing.Code != 404 {
		t.Fatalf("missing service returned %d", missing.Code)
	}
}

func TestParentExitRemovesDescendants(t *testing.T) {
	s, _ := newTestService(t)
	d := definitionFor(t, s, "forkexit")
	_, _ = s.Start(context.Background(), d.ID, "run")
	until := time.Now().Add(3 * time.Second)
	for time.Now().Before(until) {
		status, _ := s.Status(context.Background(), d.ID)
		if status.Status == "failed" && !s.healthy(context.Background(), d.HealthURL) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("parent exit left an active descendant or blocked output draining")
}

func TestStopKillsBeforeWaitingForBusyStore(t *testing.T) {
	s, db := newTestService(t)
	d := definitionFor(t, s, "serve")
	if _, err := s.Start(context.Background(), d.ID, "run"); err != nil {
		t.Fatal(err)
	}
	// Occupy the only SQLite connection. Process termination must not depend
	// on a definition lookup or successful log writes.
	connection, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	_, _ = s.Stop(ctx, d.ID, "run")
	stillHealthy := s.healthy(context.Background(), d.HealthURL)
	connection.Close()
	if stillHealthy {
		t.Fatal("database contention prevented process termination")
	}
	if _, err := s.Stop(context.Background(), d.ID, "run"); err != nil {
		t.Fatal(err)
	}
}

func TestEditAndDeleteDefinitionRoutes(t *testing.T) {
	s, db := newTestService(t)
	d := definitionFor(t, s, "serve")
	ctx := context.Background()
	router := gin.New()
	s.Routes(router.Group("/api"))
	remove := func() *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest("DELETE", "/api/services/"+d.ID, nil))
		return response
	}
	if _, err := s.Start(ctx, d.ID, "manual"); err != nil {
		t.Fatal(err)
	}
	d.Name = "Updated service"
	if _, err := s.PutDefinition(ctx, *d); err == nil {
		t.Fatal("edited a running service")
	}
	if response := remove(); response.Code != 400 {
		t.Fatalf("deleted running service: %d %s", response.Code, response.Body.String())
	}
	if status, err := s.Status(ctx, d.ID); err != nil || status.Status != "running" {
		t.Fatalf("delete affected running process: %+v %v", status, err)
	}
	if _, err := s.Stop(ctx, d.ID, "manual"); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(d)
	request := httptest.NewRequest("PUT", "/api/services", strings.NewReader(string(data)))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatalf("edit response: %d %s", response.Code, response.Body.String())
	}
	definitions, err := s.ListDefinitions(ctx)
	if err != nil || len(definitions) != 1 || definitions[0].ID != d.ID || definitions[0].Name != d.Name {
		t.Fatalf("edit did not update in place: %+v %v", definitions, err)
	}
	var before int
	if err := db.QueryRow(`SELECT COUNT(*) FROM local_service_logs WHERE service_id=?`, d.ID).Scan(&before); err != nil || before == 0 {
		t.Fatalf("missing test logs: %d %v", before, err)
	}
	if response := remove(); response.Code != 200 {
		t.Fatalf("delete response: %d %s", response.Code, response.Body.String())
	}
	if definitions, err := s.ListDefinitions(ctx); err != nil || len(definitions) != 0 {
		t.Fatalf("deleted service still listed: %+v %v", definitions, err)
	}
	if _, err := s.Start(ctx, d.ID, "manual"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("deleted definition could start: %v", err)
	}
	var after int
	if err := db.QueryRow(`SELECT COUNT(*) FROM local_service_logs WHERE service_id=?`, d.ID).Scan(&after); err != nil || after != before {
		t.Fatalf("delete removed historical logs: %d -> %d %v", before, after, err)
	}
	if response := remove(); response.Code != 404 {
		t.Fatalf("missing delete response: %d", response.Code)
	}
}

func TestDeleteDefinitionPreservesExternalService(t *testing.T) {
	s, _ := newTestService(t)
	d := definitionFor(t, s, "serve")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer server.Close()
	d.HealthURL = server.URL
	if _, err := s.PutDefinition(context.Background(), *d); err != nil {
		t.Fatal(err)
	}
	if instance, err := s.Start(context.Background(), d.ID, "manual"); err != nil || instance.Owner != "external" {
		t.Fatalf("external reuse: %+v %v", instance, err)
	}
	if err := s.DeleteDefinition(context.Background(), d.ID); err != nil {
		t.Fatal(err)
	}
	if !s.healthy(context.Background(), server.URL) {
		t.Fatal("delete stopped external service")
	}
}

func TestDeleteDefinitionRequiresCompletedCleanup(t *testing.T) {
	for _, status := range []string{"starting", "running", "stopping", "cleanup_failed"} {
		t.Run(status, func(t *testing.T) {
			s, _ := newTestService(t)
			d := definitionFor(t, s, "serve")
			// Model in-flight lifecycle states without starting an external process.
			s.running[d.ID] = &process{instance: Instance{Status: status}}
			err := s.DeleteDefinition(context.Background(), d.ID)
			delete(s.running, d.ID)
			if err == nil {
				t.Fatalf("deleted service with status %s", status)
			}
		})
	}
}
