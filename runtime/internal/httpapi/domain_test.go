package httpapi

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"testing"

	_ "modernc.org/sqlite"
)

func newTestService(t *testing.T) *HTTPService {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	service := New()
	if err := service.MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	return service
}

func TestMigrateSchemaReplacesLegacyHTTPDomain(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE collections(id TEXT PRIMARY KEY); CREATE TABLE apis(id TEXT PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	service := New()
	if err := service.MigrateSchema(db); err != nil {
		t.Fatal(err)
	}

	for _, oldName := range []string{"collections", "apis", "api_params", "api_executions"} {
		var count int
		if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?`, oldName).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("legacy table %s still exists", oldName)
		}
	}
	for _, newName := range []string{"api_collections", "api_requests", "api_working_copies", "api_runs"} {
		var count int
		if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?`, newName).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("new table %s was not created", newName)
		}
	}
}

func TestEmptyListsAreEncodedAsArrays(t *testing.T) {
	service := newTestService(t)

	collections, err := service.repo.listCollections(defaultProjectID)
	if err != nil {
		t.Fatal(err)
	}
	if collections == nil || len(collections) != 0 {
		t.Fatalf("expected an empty collections array, got %#v", collections)
	}

	requests, err := service.repo.listRequests("missing-collection")
	if err != nil {
		t.Fatal(err)
	}
	if requests == nil || len(requests) != 0 {
		t.Fatalf("expected an empty requests array, got %#v", requests)
	}
}

func TestWorkingCopySaveAndRunLifecycle(t *testing.T) {
	service := newTestService(t)
	collection := &APICollection{Name: "Users"}
	if err := service.repo.createCollection(collection); err != nil {
		t.Fatal(err)
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Fatalf("unexpected auth header %q", got)
		}
		w.Header().Set("Set-Cookie", "session=private")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"token":"response-secret"}`))
	}))
	defer upstream.Close()

	copy := &APIWorkingCopy{SourceType: "curl_import", Request: RequestData{
		Method: "GET", URL: upstream.URL, BodyType: "json", Body: `{"password":"private"}`,
		Headers: []KeyValue{{Name: "Authorization", Value: "Bearer secret", Enabled: true}},
	}}
	if err := service.repo.createWorkingCopy(copy); err != nil {
		t.Fatal(err)
	}
	if copy.APIRequestID != nil || copy.BaseContentHash != nil {
		t.Fatal("new imported copy must be unsaved")
	}

	run, err := service.execution.Run(context.Background(), RunCommand{WorkingCopyID: copy.ID, TriggerType: "manual"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != "succeeded" || run.ResponseStatus == nil || *run.ResponseStatus != http.StatusOK {
		t.Fatalf("unexpected run: %#v", run)
	}
	if run.RequestSnapshot.Headers[0].Value != "••••••" {
		t.Fatal("authorization value was persisted without redaction")
	}
	if run.RequestSnapshot.Body != `{"password":"••••••"}` {
		t.Fatal("password body field was persisted without redaction")
	}
	responseHeaders, ok := run.ResponseHeaders.(map[string][]string)
	if !ok || responseHeaders["Set-Cookie"][0] != "••••••" {
		t.Fatal("response cookie was persisted without redaction")
	}

	saved, err := service.repo.saveWorkingCopy(copy.ID, collection.ID, "Health")
	if err != nil {
		t.Fatal(err)
	}
	if saved.APIRequestID == nil || saved.BaseContentHash == nil || *saved.BaseContentHash != saved.ContentHash {
		t.Fatal("working copy was not marked saved")
	}

	saved.Request.URL += "/changed"
	if err := service.repo.updateWorkingCopy(saved, saved.EditVersion); err != nil {
		t.Fatal(err)
	}
	if saved.BaseContentHash == nil || *saved.BaseContentHash == saved.ContentHash {
		t.Fatal("saved request edit was not detected")
	}

	persisted, err := service.repo.getRun(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.RequestSnapshot.URL != upstream.URL {
		t.Fatal("run snapshot changed after editing the working copy")
	}
	persistedBody, ok := persisted.ResponseBody.(map[string]any)
	if !ok || persistedBody["token"] != "••••••" {
		t.Fatal("response token was persisted without redaction")
	}
}
