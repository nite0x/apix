package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/apix/apix/runtime/internal/core"
	"github.com/apix/apix/runtime/internal/database"
	"github.com/apix/apix/runtime/internal/lifecycle"
	"github.com/apix/apix/runtime/internal/localservice"
)

func TestArchivedCasePreservesSnapshotAndRequiresRestore(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	entered, release := make(chan struct{}), make(chan struct{})
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-release; w.WriteHeader(204) }))
	defer target.Close()
	item, err := s.SaveTestCase(TestCase{Name: "snapshot", Request: RequestData{Method: "GET", URL: target.URL}})
	if err != nil {
		t.Fatal(err)
	}
	batch, _ := s.BeginTestBatch("", "regression")
	done := make(chan error, 1)
	go func() {
		_, err := s.RunTest(context.Background(), RunTestInput{BatchID: batch.ID, CaseID: item.ID}, nil)
		done <- err
	}()
	<-entered
	if err := s.ArchiveTestCase(item.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RunTest(context.Background(), RunTestInput{BatchID: batch.ID, CaseID: item.ID}, nil); !errors.Is(err, errConflict) {
		t.Fatalf("archived accepted: %v", err)
	}
	item.Name = "changed"
	if _, err := s.SaveTestCase(*item); err == nil {
		t.Fatal("archived case editable")
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	history, err := s.GetTestBatch(batch.ID)
	if err != nil || len(history.Runs) != 1 || history.Runs[0].Name != "snapshot" || history.Runs[0].CaseVersion != 1 {
		t.Fatalf("lost snapshot: %+v %v", history, err)
	}
	if err := s.repo.deleteRun(*history.Runs[0].APIRunID); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatalf("linked HTTP history removable: %v", err)
	}
	if _, err := s.repo.getRun(*history.Runs[0].APIRunID); err != nil {
		t.Fatal(err)
	}
	archived, err := s.listTestCases("", true)
	if err != nil || len(archived) != 1 {
		t.Fatalf("archive list: %v %v", archived, err)
	}
	restored, err := s.RestoreTestCase(item.ID)
	if err != nil || restored.ID != item.ID || restored.Archived {
		t.Fatalf("restore: %v %v", restored, err)
	}
}

func TestFlowArchiveAndDependencyProtectionIncludeDisabledAndRunningSnapshots(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	ctx := context.Background()
	db, err := database.New(s.db)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	services, err := localservice.New(s.db)
	if err != nil {
		t.Fatal(err)
	}
	defer services.Close()
	s.SetCapabilities(db, services)
	conn, err := db.PutConnection(ctx, database.Connection{Name: "DB", Host: "127.0.0.1", Port: 3306, Database: "example", Username: "user"})
	if err != nil {
		t.Fatal(err)
	}
	flow := mustFlow(t, s)
	flow.Steps = []FlowStep{{Name: "disabled SQL", Type: "sql", Enabled: false, SQL: &database.Command{ConnectionID: conn.ID, Mode: "query", SQL: "SELECT 1"}}, httpStep("HTTP", "GET", "http://127.0.0.1:1")}
	flow, err = s.repo.updateFlow(flow, flow.EditVersion)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.DeleteConnection(ctx, conn.ID); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatalf("disabled reference unprotected: %v", err)
	}
	if err := s.repo.archiveFlow(flow.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.StartFlow(flow.ID, 0, nil, "ai"); !errors.Is(err, errConflict) {
		t.Fatalf("archived flow ran: %v", err)
	}
	if _, err := s.repo.updateFlow(flow, flow.EditVersion); err == nil {
		t.Fatal("archived flow editable")
	}
	if err := db.DeleteConnection(ctx, conn.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.repo.restoreFlow(flow.ID); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatalf("missing restore dependency: %v", err)
	}
	// A queued run still reserves future dependencies after its source is archived.
	if _, err := db.PutConnection(ctx, *conn); err != nil {
		t.Fatal(err)
	}
	if _, err := s.repo.restoreFlow(flow.ID); err != nil {
		t.Fatal(err)
	}
	flow, _ = s.repo.getFlow(flow.ID)
	flow.Steps[0].Enabled = true
	flow, err = s.repo.updateFlow(flow, flow.EditVersion)
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.repo.createFlowRun(flow, nil, "manual", nil)
	if err != nil {
		t.Fatal(err)
	}
	s.repo.archiveFlow(flow.ID)
	if err := db.DeleteConnection(ctx, conn.ID); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatalf("future step unprotected: %v", err)
	}
	if err := s.repo.finishFlowRun(run.ID, "cancelled", "test", "test"); err != nil {
		t.Fatal(err)
	}
	if err := db.DeleteConnection(ctx, conn.ID); err != nil {
		t.Fatal(err)
	}
}

func TestArchivedRequestAndCollectionCannotExecuteDefinition(t *testing.T) {
	s := newTestService(t)
	col := &APICollection{Name: "collection", ProjectID: "default"}
	if err := s.repo.createCollection(col); err != nil {
		t.Fatal(err)
	}
	request := &APIRequest{Name: "request", CollectionID: col.ID, Request: RequestData{Method: "GET", URL: "http://127.0.0.1:1"}}
	if err := s.repo.createRequest(request); err != nil {
		t.Fatal(err)
	}
	if err := s.repo.archiveCollection(col.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.execution.Run(context.Background(), RunCommand{APIRequestID: request.ID}, core.NewVariables()); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatalf("archived collection executed: %v", err)
	}
	if _, err := s.db.Exec(`UPDATE api_collections SET status='active' WHERE id=?`, col.ID); err != nil {
		t.Fatal(err)
	}
	s.repo.archiveRequest(request.ID)
	if _, err := s.execution.Run(context.Background(), RunCommand{APIRequestID: request.ID}, nil); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatalf("archived request executed: %v", err)
	}
	// Saved copies are source associations and remain independently executable.
	item, err := s.SaveTestCase(TestCase{Name: "copy", APIRequestID: &request.ID, Request: request.Request})
	if err != nil {
		t.Fatal(err)
	}
	if item.Request.URL != request.Request.URL {
		t.Fatal("source content changed")
	}
}

func TestProtectedStandaloneRunIsNotDeleted(t *testing.T) {
	s := newTestService(t)
	now := time.Now().UTC()
	r := &APIRun{ID: "running", ProjectID: "default", Status: "running", TriggerType: "manual", StartedAt: now, RequestSnapshot: RequestData{Method: "GET", URL: "http://example.test"}}
	if err := s.repo.insertRun(r); err != nil {
		t.Fatal(err)
	}
	if err := s.repo.deleteRun(r.ID); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatalf("running delete: %v", err)
	}
}
