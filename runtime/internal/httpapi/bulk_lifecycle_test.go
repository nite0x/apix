package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/apix/apix/runtime/internal/database"
	"github.com/apix/apix/runtime/internal/lifecycle"
	"github.com/apix/apix/runtime/internal/localservice"
	"github.com/apix/apix/runtime/internal/mcpclient"
)

func TestBulkLifecycleReportsFailuresAndCopiesWithoutCredentials(t *testing.T) {
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
	client, _ := mcpclient.New(s.db)
	s.SetMCPClient(client)
	password := "original-password"
	conn, err := db.SaveConnection(ctx, database.ConnectionInput{Connection: database.Connection{Name: "original", Host: "localhost", Database: "db", Username: "user"}, Password: &password})
	if err != nil {
		t.Fatal(err)
	}
	server, err := client.Save(mcpclient.Server{Name: "original MCP", URL: "http://127.0.0.1:1/mcp", Headers: map[string]string{"Authorization": "Bearer original-secret"}})
	if err != nil {
		t.Fatal(err)
	}
	item, _ := s.SaveTestCase(TestCase{Name: "case", Request: RequestData{Method: "GET", URL: "http://localhost"}})
	results, err := s.BatchLifecycle(ctx, []LifecycleOperation{{Kind: "database", ID: conn.ID, Action: "duplicate"}, {Kind: "mcp", ID: server.ID, Action: "duplicate"}, {Kind: "test_case", ID: item.ID, Action: "archive"}, {Kind: "test_case", ID: "missing", Action: "archive"}, {Kind: "test_case", ID: item.ID, Action: "restore"}})
	if err != nil || len(results) != 5 || results[0].NewID == conn.ID || results[0].NewID == "" || results[3].Status != "failed" || results[4].Status != "failed" {
		t.Fatal(results, err)
	}
	for _, i := range []int{0, 1, 2} {
		if results[i].Status != "succeeded" {
			t.Fatal(results)
		}
	}
	copied, _ := client.Get(results[1].NewID)
	if len(copied.Headers) != 0 {
		t.Fatal("copied MCP auth")
	}
	if err := db.TestConnection(ctx, results[0].NewID); err == nil || !strings.Contains(err.Error(), "凭据已清除") {
		t.Fatal("connection copy usable without filling credentials", err)
	}
	raw, _ := json.Marshal(results)
	if strings.Contains(string(raw), password) || strings.Contains(string(raw), "original-secret") {
		t.Fatal("batch leaked credentials")
	}
	if _, err := s.BatchLifecycle(ctx, make([]LifecycleOperation, 101)); err == nil {
		t.Fatal("unbounded batch accepted")
	}
}
func TestPermanentCaseAndFlowDeletionPreservesIndependentHistory(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	s.db.Exec(`PRAGMA foreign_keys=ON`)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer target.Close()
	ctx := context.Background()
	item, _ := s.SaveTestCase(TestCase{Name: "original case", Request: RequestData{Method: "GET", URL: target.URL}})
	if _, err := s.PreviewPurge("test_case", item.ID); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("active purge allowed", err)
	}
	batch, _ := s.BeginTestBatch("", "evidence")
	out, err := s.RunTest(ctx, RunTestInput{BatchID: batch.ID, CaseID: item.ID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.FinishTestBatch(batch.ID)
	s.ArchiveTestCase(item.ID)
	preview, err := s.PreviewPurge("test_case", item.ID)
	if err != nil || preview.HistoricalRecords != 1 {
		t.Fatal(preview, err)
	}
	if _, err := s.ApplyLifecycle(ctx, LifecycleOperation{Kind: "test_case", ID: item.ID, Action: "purge", Token: preview.Token}); err != nil {
		t.Fatal(err)
	}
	history, err := s.GetTestBatch(batch.ID)
	if err != nil || history.Runs[0].CaseID != nil || history.Runs[0].Name != "original case" || history.Runs[0].CaseVersion != 1 {
		t.Fatal("case history broken", history, err)
	}
	if _, err := s.repo.getRun(out.RunID); err != nil {
		t.Fatal(err)
	}
	flow := mustFlow(t, s)
	flow.Steps = []FlowStep{httpStep("request", "GET", target.URL)}
	flow, err = s.repo.updateFlow(flow, flow.EditVersion)
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.repo.createFlowRun(flow, nil, "manual", nil)
	if err != nil {
		t.Fatal(err)
	}
	s.flow.run(ctx, run.ID, nil)
	s.repo.archiveFlow(flow.ID)
	preview, err = s.PreviewPurge("flow", flow.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyLifecycle(ctx, LifecycleOperation{Kind: "flow", ID: flow.ID, Action: "purge", Token: preview.Token}); err != nil {
		t.Fatal(err)
	}
	preserved, err := s.GetFlowRun(run.ID)
	if err != nil || preserved.FlowID != nil || preserved.FlowNameSnapshot != flow.Name || len(preserved.Steps) != 1 || preserved.Steps[0].APIRunID == nil {
		t.Fatal("flow snapshot broken", preserved, err)
	}
	if _, err := s.GetTestBatch(run.ID); err != nil {
		t.Fatal("projected history broken", err)
	}
	if _, err := s.repo.getRun(*preserved.Steps[0].APIRunID); err != nil {
		t.Fatal(err)
	}
	rows, err := s.db.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Fatal("dangling foreign key")
	}
}
func TestRequestPurgeRequiresExplicitSourceDetachAndPreservesDrafts(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	s.db.Exec(`PRAGMA foreign_keys=ON`)
	col := &APICollection{Name: "group"}
	s.repo.createCollection(col)
	request := &APIRequest{Name: "source", CollectionID: col.ID, Request: RequestData{Method: "GET", URL: "http://localhost/original"}}
	s.repo.createRequest(request)
	item, err := s.SaveTestCase(TestCase{Name: "copy", APIRequestID: &request.ID, Request: request.Request})
	if err != nil {
		t.Fatal(err)
	}
	draft := &APIWorkingCopy{APIRequestID: &request.ID, Name: request.Name, Request: request.Request}
	if err := s.repo.createWorkingCopy(draft); err != nil {
		t.Fatal(err)
	}
	s.repo.archiveRequest(request.ID)
	if _, err := s.PreviewPurge("request", request.ID); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("definition references ignored", err)
	}
	if err := s.detachRequestSources(request.ID); err != nil {
		t.Fatal(err)
	}
	preview, err := s.PreviewPurge("request", request.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.purgeResource("request", request.ID, preview.Token); err != nil {
		t.Fatal(err)
	}
	saved, err := s.GetTestCase(item.ID)
	if err != nil || saved.APIRequestID != nil || saved.SourceStatus != "detached" || saved.Request.URL != request.Request.URL || saved.EditVersion <= item.EditVersion {
		t.Fatal("copy/source evidence lost", saved, err)
	}
	copy, err := s.repo.getWorkingCopy(draft.ID)
	if err != nil || copy.APIRequestID != nil || copy.Request.URL != request.Request.URL || copy.Status != "active" {
		t.Fatal("draft lost", copy, err)
	}
}
func TestPurgeRejectsArchivedDefinitionReferencesAndStalePreview(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	ctx := context.Background()
	db, _ := database.New(s.db)
	defer db.Close()
	s.SetCapabilities(db, nil)
	conn, _ := db.PutConnection(ctx, database.Connection{Name: "DB", Host: "localhost", Database: "db", Username: "user"})
	flow := mustFlow(t, s)
	flow.Steps = []FlowStep{{Name: "disabled", Type: "sql", Enabled: false, SQL: &database.Command{ConnectionID: conn.ID, Mode: "query", SQL: "SELECT 1"}}}
	flow, err := s.repo.updateFlow(flow, flow.EditVersion)
	if err != nil {
		t.Fatal(err)
	}
	s.repo.archiveFlow(flow.ID)
	if err := db.ArchiveConnection(ctx, conn.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PreviewPurge("database", conn.ID); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("archived reference ignored", err)
	}
	p, err := s.PreviewPurge("flow", flow.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.purgeResource("flow", flow.ID, p.Token); err != nil {
		t.Fatal(err)
	}
	p, err = s.PreviewPurge("database", conn.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RestoreConnection(ctx, conn.ID, ""); err != nil {
		t.Fatal(err)
	}
	items, _ := db.ListConnections(ctx)
	changed := items[0]
	changed.Host = "127.0.0.1"
	if _, err := db.PutConnection(ctx, changed); err != nil {
		t.Fatal(err)
	}
	db.ArchiveConnection(ctx, conn.ID)
	if err := s.purgeResource("database", conn.ID, p.Token); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("stale preview deleted changed configuration", err)
	}
	p, err = s.PreviewPurge("database", conn.ID)
	if err != nil {
		t.Fatal(err)
	}
	s.db.Exec(`UPDATE purge_previews SET expires_at=? WHERE token=?`, time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano), p.Token)
	if err := s.purgeResource("database", conn.ID, p.Token); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("expired preview accepted", err)
	}
	p, err = s.PreviewPurge("database", conn.ID)
	if err != nil {
		t.Fatal(err)
	}
	release := lifecycle.Lease(s.db, "database", conn.ID)
	if err := s.purgeResource("database", conn.ID, p.Token); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("running lease ignored", err)
	}
	release()
	if err := s.purgeResource("database", conn.ID, p.Token); err != nil {
		t.Fatal(err)
	}
}
func TestRetentionIsOptInAndSkipsPinnedRunningAndRecentlyFinishedGroups(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	now := time.Now().UTC()
	old := now.Add(-90 * 24 * time.Hour)
	ctx := context.Background()
	yes := true
	oldBatch := func(name string, finish bool) string {
		b, err := s.BeginTestBatch("", name)
		if err != nil {
			t.Fatal(err)
		}
		if finish {
			s.FinishTestBatch(b.ID)
		}
		if _, err := s.db.Exec(`UPDATE test_batches SET created_at=?,finished_at=CASE WHEN finished_at IS NULL THEN NULL ELSE ? END WHERE id=?`, old, old, b.ID); err != nil {
			t.Fatal(err)
		}
		return b.ID
	}
	clean := oldBatch("clean", true)
	hidden := oldBatch("hidden", true)
	s.SetRecordState(hidden, &yes, nil)
	pinned := oldBatch("pinned", true)
	s.SetRecordState(pinned, nil, &yes)
	running := oldBatch("running", false)
	recent := oldBatch("recent finish", true)
	s.db.Exec(`UPDATE test_batches SET finished_at=? WHERE id=?`, now, recent)
	policy, err := s.GetRetentionPolicy()
	if err != nil || policy.Enabled || policy.Days != 30 {
		t.Fatal("retention not opt in", policy, err)
	}
	report, err := s.RunRetention(ctx, now)
	if err != nil || report.Enabled || report.Removed != 0 {
		t.Fatal(report, err)
	}
	preview, err := s.PreviewRetention(30, now)
	if err != nil || preview.Eligible != 2 || preview.Protected != 2 {
		t.Fatal(preview, err)
	}
	if _, err := s.SetRetentionPolicy(true, 30); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetTestBatch(clean); err != nil {
		t.Fatal("saving policy deleted immediately", err)
	}
	report, err = s.RunRetention(ctx, now)
	if err != nil || report.Removed != 2 || report.Protected != 2 {
		t.Fatal(report, err)
	}
	for _, id := range []string{pinned, running, recent} {
		if _, err := s.GetTestBatch(id); err != nil {
			t.Fatal("protected group removed", id, err)
		}
	}
	clean = oldBatch("disabled before apply", true)
	p, err := s.PreviewCleanup(clean)
	if err != nil {
		t.Fatal(err)
	}
	s.SetRetentionPolicy(false, 30)
	if err := s.cleanupForRetention(p.Token, 30); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("disabled policy still deleted", err)
	}
	if err := s.MigrateSchema(s.db); err != nil {
		t.Fatal(err)
	}
	policy, err = s.GetRetentionPolicy()
	if err != nil || policy.Enabled || policy.LastReport == "" {
		t.Fatal("policy/report lost on migration", policy, err)
	}
}
func TestServiceAndDatabaseVersionConflictsDoNotOverwriteDefinitions(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	ctx := context.Background()
	db, _ := database.New(s.db)
	defer db.Close()
	conn, _ := db.PutConnection(ctx, database.Connection{Name: "DB", Host: "localhost", Database: "db", Username: "user"})
	first := *conn
	second := *conn
	first.Host = "127.0.0.1"
	if _, err := db.PutConnection(ctx, first); err != nil {
		t.Fatal(err)
	}
	second.Host = "other-host"
	if _, err := db.PutConnection(ctx, second); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("stale DB edit accepted", err)
	}
	items, _ := db.ListConnections(ctx)
	if items[0].Host != first.Host {
		t.Fatal("lost DB edit")
	}
	services, _ := localservice.New(s.db)
	defer services.Close()
	d, _ := services.PutDefinition(ctx, localservice.Definition{Name: "service", Command: "echo", WorkDir: t.TempDir(), HealthURL: "http://127.0.0.1:1"})
	copy := *d
	copy.Name = "updated"
	if _, err := services.PutDefinition(ctx, copy); err != nil {
		t.Fatal(err)
	}
	d.Name = "stale"
	if _, err := services.PutDefinition(ctx, *d); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("stale service edit accepted", err)
	}
}

func TestSQLGroupCleanupUsesExactExecutionIdentityAndPreservesOtherGroups(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	ctx := context.Background()
	db, _ := database.New(s.db)
	defer db.Close()
	s.SetCapabilities(db, nil)
	conn, err := db.PutConnection(ctx, database.Connection{Name: "unreachable fixture", Host: "127.0.0.1", Port: 1, Database: "db", Username: "user"})
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for i := 0; i < 2; i++ {
		batch, _ := s.BeginTestBatch("", "same SQL")
		_, err := db.Execute(ctx, database.Command{BatchID: batch.ID, ConnectionID: conn.ID, Mode: "query", SQL: "SELECT 1", TimeoutMS: 100})
		if err == nil {
			t.Fatal("fixture unexpectedly reachable")
		}
		if _, err := s.FinishTestBatch(batch.ID); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, batch.ID)
	}
	page, err := s.ListRecords("", RecordQuery{ExecutionType: "sql"})
	if err != nil || page.Total != 2 {
		t.Fatal("SQL type filter lost batches", page, err)
	}
	page, err = s.ListRecords("", RecordQuery{ExecutionType: "http"})
	if err != nil || page.Total != 0 {
		t.Fatal("HTTP type filter matched SQL", page, err)
	}
	preview, err := s.PreviewCleanup(ids[0])
	if err != nil || preview.SQLRecords != 1 {
		t.Fatal("missing exact SQL identity", preview, err)
	}
	if err := s.CleanupRecord(preview.Token); err != nil {
		t.Fatal(err)
	}
	entries, err := db.ListExecutions(ctx, conn.ID)
	if err != nil || len(entries) != 1 {
		t.Fatal("deleted another batch SQL history", entries, err)
	}
	if _, err := s.GetTestBatch(ids[1]); err != nil {
		t.Fatal(err)
	}
}
func TestRetentionProtectsWholeBatchWhenAnUnderlyingHTTPRecordIsPinned(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer target.Close()
	batch, _ := s.BeginTestBatch("", "pinned response")
	out, err := s.RunTest(context.Background(), RunTestInput{BatchID: batch.ID, TestCase: &TestCase{Name: "HTTP", Request: RequestData{Method: "GET", URL: target.URL}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.FinishTestBatch(batch.ID)
	old := time.Now().UTC().Add(-90 * 24 * time.Hour)
	s.db.Exec(`UPDATE test_batches SET created_at=?,finished_at=? WHERE id=?`, old, old, batch.ID)
	s.repo.pinRun(out.RunID, true)
	s.SetRetentionPolicy(true, 30)
	report, err := s.RunRetention(context.Background(), time.Now())
	if err != nil || report.Removed != 0 || report.Protected != 1 {
		t.Fatal(report, err)
	}
	if _, err := s.repo.getRun(out.RunID); err != nil {
		t.Fatal("pinned response lost", err)
	}
}

func TestFailedMCPRestoreDoesNotLoseChangedSchemaReview(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	target, _ := mcpTestingTarget(t)
	client, _ := mcpclient.New(s.db)
	s.SetMCPClient(client)
	server, err := client.Save(mcpclient.Server{Name: "same name", URL: target.URL})
	if err != nil {
		t.Fatal(err)
	}
	item, err := s.SaveTestCase(TestCase{Type: "mcp", Name: "schema check", MCPTestData: MCPTestData{MCPRequest: &mcpclient.Request{ServerID: server.ID, ToolName: "lookup", Arguments: map[string]any{}}}})
	if err != nil {
		t.Fatal(err)
	}
	s.ArchiveTestCase(item.ID)
	client.Archive(server.ID)
	s.db.Exec(`INSERT INTO mcp_discoveries(server_id,discovered_at,tools) VALUES(?,?,?)`, server.ID, time.Now().UTC().Format(time.RFC3339Nano), "[]")
	if _, err := client.Save(mcpclient.Server{Name: "same name", URL: target.URL}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Restore(context.Background(), server.ID, ""); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("name conflict ignored", err)
	}
	var baseline string
	s.db.QueryRow(`SELECT tools FROM mcp_discoveries WHERE server_id=?`, server.ID).Scan(&baseline)
	if baseline != "[]" {
		t.Fatal("failed restore rewrote comparison baseline")
	}
	if _, err := client.Restore(context.Background(), server.ID, "renamed"); err != nil {
		t.Fatal(err)
	}
	item, err = s.RestoreTestCase(item.ID)
	if err != nil || !item.NeedsReview {
		t.Fatal("tool schema change went undetected", item, err)
	}
}
func TestRestoreFlowRenameResolvesConflictWithoutOverwritingAnotherFlow(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	first := mustFlow(t, s)
	s.repo.archiveFlow(first.ID)
	other := mustFlow(t, s)
	if _, err := s.repo.restoreFlow(first.ID); !errors.Is(err, lifecycle.ErrProtected) {
		t.Fatal("duplicate name restored", err)
	}
	restored, err := s.repo.restoreFlowAs(first.ID, "renamed flow")
	if err != nil || restored.Name != "renamed flow" {
		t.Fatal(restored, err)
	}
	unchanged, _ := s.repo.getFlow(other.ID)
	if unchanged.Name != other.Name {
		t.Fatal("overwrote another flow")
	}
}

func TestV7UpgradePreservesArchivedIDsCredentialsAndHistory(t *testing.T) {
	s := newTestService(t)
	s.db.SetMaxOpenConns(1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer target.Close()
	ctx := context.Background()
	db, _ := database.New(s.db)
	defer db.Close()
	secret := "migration-only-secret"
	conn, err := db.SaveConnection(ctx, database.ConnectionInput{Connection: database.Connection{Name: "existing DB", Host: "localhost", Database: "db", Username: "user"}, Password: &secret})
	if err != nil {
		t.Fatal(err)
	}
	var encrypted []byte
	s.db.QueryRow(`SELECT password_encrypted FROM database_connection_settings WHERE connection_id=?`, conn.ID).Scan(&encrypted)
	item, err := s.SaveTestCase(TestCase{Name: "existing case", Request: RequestData{Method: "GET", URL: target.URL}})
	if err != nil {
		t.Fatal(err)
	}
	batch, _ := s.BeginTestBatch("", "existing history")
	out, err := s.RunTest(ctx, RunTestInput{BatchID: batch.ID, CaseID: item.ID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.FinishTestBatch(batch.ID)
	s.ArchiveTestCase(item.ID)
	flow := mustFlow(t, s)
	s.repo.archiveFlow(flow.ID)
	for _, q := range []string{`ALTER TABLE test_cases DROP COLUMN needs_review`, `ALTER TABLE database_connections DROP COLUMN edit_version`, `UPDATE schema_metadata SET version=7 WHERE name='http_domain'`} {
		if _, err := s.db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	upgraded := New()
	if err := upgraded.MigrateSchema(s.db); err != nil {
		t.Fatal(err)
	}
	db2, err := database.New(s.db)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	var version int
	s.db.QueryRow(`SELECT version FROM schema_metadata WHERE name='http_domain'`).Scan(&version)
	if version != 8 {
		t.Fatal("schema version not advanced", version)
	}
	saved, err := upgraded.GetTestCase(item.ID)
	if err != nil || !saved.Archived || saved.ID != item.ID {
		t.Fatal("lost archive identity", saved, err)
	}
	savedFlow, err := upgraded.GetFlow(flow.ID)
	if err != nil || savedFlow.ArchivedAt == nil {
		t.Fatal(savedFlow, err)
	}
	history, err := upgraded.GetTestBatch(batch.ID)
	if err != nil || history.Runs[0].APIRunID == nil || *history.Runs[0].APIRunID != out.RunID {
		t.Fatal("lost history", history, err)
	}
	var after []byte
	s.db.QueryRow(`SELECT password_encrypted FROM database_connection_settings WHERE connection_id=?`, conn.ID).Scan(&after)
	if string(after) != string(encrypted) {
		t.Fatal("upgrade rewrote credentials")
	}
	connections, err := db2.ListConnections(ctx)
	if err != nil || len(connections) != 1 || connections[0].ID != conn.ID || connections[0].EditVersion != 1 {
		t.Fatal("connection migration lost identity", connections, err)
	}
	policy, _ := upgraded.GetRetentionPolicy()
	if policy.Enabled {
		t.Fatal("upgrade enabled automatic deletion")
	}
}
