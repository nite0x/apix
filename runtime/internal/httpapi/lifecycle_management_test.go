package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/apix/apix/runtime/internal/database"
	"github.com/apix/apix/runtime/internal/lifecycle"
	"github.com/apix/apix/runtime/internal/localservice"
	"github.com/apix/apix/runtime/internal/mcpclient"
)

func TestConnectionArchivesKeepIdentityCredentialsAndEnforceReferences(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	ctx := context.Background()
	db, err := database.New(s.db)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	password := "retained-password"
	conn, err := db.SaveConnection(ctx, database.ConnectionInput{Connection: database.Connection{Name: "DB", Host: "localhost", Database: "test", Username: "test"}, Password: &password})
	if err != nil {
		t.Fatal(err)
	}
	var original []byte
	if err := s.db.QueryRow(`SELECT password_encrypted FROM database_connection_settings WHERE connection_id=?`, conn.ID).Scan(&original); err != nil {
		t.Fatal(err)
	}
	if err := db.ArchiveConnection(ctx, conn.ID); err != nil {
		t.Fatal(err)
	}
	if items, _ := db.ListConnections(ctx); len(items) != 0 {
		t.Fatal("archived connection leaked to selector")
	}
	if items, _ := db.ListArchivedConnections(ctx, true); len(items) != 1 || items[0].ID != conn.ID {
		t.Fatal("archived connection missing")
	}
	if err := db.TestConnection(ctx, conn.ID); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatalf("archived test accepted: %v", err)
	}
	if err := db.RestoreConnection(ctx, conn.ID, ""); err != nil {
		t.Fatal(err)
	}
	var after []byte
	s.db.QueryRow(`SELECT password_encrypted FROM database_connection_settings WHERE connection_id=?`, conn.ID).Scan(&after)
	if string(original) != string(after) {
		t.Fatal("archive changed credentials")
	}
	if err := db.ArchiveConnection(ctx, conn.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.ClearCredentials(ctx, conn.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.RestoreConnection(ctx, conn.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := db.TestConnection(ctx, conn.ID); err == nil {
		t.Fatal("cleared credentials executed")
	}
	if _, err := db.SaveConnection(ctx, database.ConnectionInput{Connection: *conn, Password: &password}); err != nil {
		t.Fatal(err)
	}
	services, err := localservice.New(s.db)
	if err != nil {
		t.Fatal(err)
	}
	defer services.Close()
	d, err := services.PutDefinition(ctx, localservice.Definition{Name: "service", Command: "echo", WorkDir: t.TempDir(), HealthURL: "http://127.0.0.1:1"})
	if err != nil {
		t.Fatal(err)
	}
	flow := mustFlow(t, s)
	flow.Steps = []FlowStep{{Type: "service", Name: "disabled service", Enabled: false, Service: &ServiceStepConfig{ServiceID: d.ID, Action: "start"}}, httpStep("request", "GET", "http://localhost")}
	flow, err = s.repo.updateFlow(flow, flow.EditVersion)
	if err != nil {
		t.Fatal(err)
	}
	if err := services.ArchiveDefinition(ctx, d.ID); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("reference not protected", err)
	}
	s.repo.archiveFlow(flow.ID)
	if err := services.ArchiveDefinition(ctx, d.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.repo.restoreFlow(flow.ID); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("archived dependency restored flow", err)
	}
	if _, err := services.RestoreDefinition(ctx, d.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.repo.restoreFlow(flow.ID); err != nil {
		t.Fatal(err)
	}
}

func TestGroupRestoreDoesNotResurrectIndividuallyArchivedRequests(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	group := &APICollection{Name: "group"}
	s.repo.createCollection(group)
	active := &APIRequest{Name: "active", CollectionID: group.ID, Request: RequestData{URL: "http://localhost", Method: "GET"}}
	s.repo.createRequest(active)
	retired := &APIRequest{Name: "retired", CollectionID: group.ID, Request: active.Request}
	s.repo.createRequest(retired)
	s.repo.archiveRequest(retired.ID)
	s.repo.archiveCollection(group.ID)
	if _, err := s.repo.restoreRequest(retired.ID, "", ""); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("request restored into archived group", err)
	}
	if err := s.repo.restoreCollection(group.ID, ""); err != nil {
		t.Fatal(err)
	}
	list, err := s.repo.listRequests(group.ID)
	if err != nil || len(list) != 1 || list[0].ID != active.ID {
		t.Fatal("resurrected individual archive", list, err)
	}
	conflict := &APIRequest{Name: retired.Name, CollectionID: group.ID, Request: active.Request}
	s.repo.createRequest(conflict)
	if _, err := s.repo.restoreRequest(retired.ID, "", ""); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("silently overwrote name conflict", err)
	}
	restored, err := s.repo.restoreRequest(retired.ID, "", "renamed")
	if err != nil || restored.ID != retired.ID {
		t.Fatal(restored, err)
	}
}
func TestRecordHidePinPreviewAndCleanupAreSeparateAndAtomic(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer target.Close()
	b, _ := s.BeginTestBatch("", "clean me")
	out, err := s.RunTest(context.Background(), RunTestInput{BatchID: b.ID, TestCase: &TestCase{Name: "HTTP", Request: RequestData{Method: "GET", URL: target.URL}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.FinishTestBatch(b.ID)
	yes, no := true, false
	if err := s.SetRecordState(b.ID, &yes, nil); err != nil {
		t.Fatal(err)
	}
	visible, _ := s.ListTestBatches("")
	if len(visible) != 0 {
		t.Fatal("hidden listed")
	}
	if _, err := s.GetTestBatch(b.ID); err != nil {
		t.Fatal("hidden destroyed", err)
	}
	preview, err := s.PreviewCleanup(b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.repo.pinRun(out.RunID, true); err != nil {
		t.Fatal(err)
	}
	if err := s.CleanupRecord(preview.Token); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("pin race lost", err)
	}
	s.repo.pinRun(out.RunID, false)
	s.SetRecordState(b.ID, nil, &yes)
	if _, err := s.PreviewCleanup(b.ID); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("pinned batch cleanup", err)
	}
	s.SetRecordState(b.ID, nil, &no)
	preview, err = s.PreviewCleanup(b.ID)
	if err != nil || preview.HTTPRecords != 1 || preview.Runs != 1 {
		t.Fatal(preview, err)
	}
	if err := s.CleanupRecord(preview.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetTestBatch(b.ID); err == nil {
		t.Fatal("batch remained")
	}
	if _, err := s.repo.getRun(out.RunID); err == nil {
		t.Fatal("underlying response remained")
	}
	running, _ := s.BeginTestBatch("", "running")
	if err := s.SetRecordState(running.ID, &yes, nil); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("running hidden", err)
	}
}
func TestRecordsSearchAndPaginationIncludeBeyondLatestHundred(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	for i := 0; i < 105; i++ {
		b, err := s.BeginTestBatch("", fmt.Sprintf("batch %03d", i))
		if err != nil {
			t.Fatal(err)
		}
		s.FinishTestBatch(b.ID)
	}
	page, err := s.ListRecords("", RecordQuery{Offset: 100, Limit: 50})
	if err != nil || page.Total != 105 || len(page.Items) != 5 {
		t.Fatal(page, err)
	}
	page, err = s.ListRecords("", RecordQuery{Query: "batch 000"})
	if err != nil || len(page.Items) != 1 {
		t.Fatal(page, err)
	}
}
func TestMCPArchiveRestoreVerifiesEndpointAndPreservesCaseReferences(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	target, _ := mcpTestingTarget(t)
	client, err := mcpclient.New(s.db)
	if err != nil {
		t.Fatal(err)
	}
	s.SetMCPClient(client)
	server, err := client.Save(mcpclient.Server{Name: "server", URL: target.URL, TimeoutSeconds: 1})
	if err != nil {
		t.Fatal(err)
	}
	item, err := s.SaveTestCase(TestCase{Type: "mcp", Name: "saved MCP", MCPTestData: MCPTestData{MCPRequest: &mcpclient.Request{ServerID: server.ID, ToolName: "lookup", Arguments: map[string]any{}}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Archive(server.ID); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("referenced server archived", err)
	}
	s.ArchiveTestCase(item.ID)
	if err := client.Archive(server.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RestoreTestCase(item.ID); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("case restored without server", err)
	}
	restored, err := client.Restore(context.Background(), server.ID, "")
	if err != nil || restored.ID != server.ID {
		t.Fatal(restored, err)
	}
	item, err = s.RestoreTestCase(item.ID)
	if err != nil || !item.NeedsReview {
		t.Fatal("missing schema review flag", item, err)
	}
	if _, err := s.SaveTestCase(*item); err != nil {
		t.Fatal(err)
	}
}
