package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
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

func TestConflictErrorsMapToHTTP409(t *testing.T) {
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	writeAPIError(context, errors.Join(errConflict, errors.New("saved request changed")))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("expected HTTP 409, got %d", recorder.Code)
	}
}

func TestArchivedCatalogEntitiesStayHiddenFromRefreshLists(t *testing.T) {
	service := newTestService(t)
	collection := &APICollection{Name: "Archived collection"}
	if err := service.repo.createCollection(collection); err != nil {
		t.Fatal(err)
	}
	request := &APIRequest{
		CollectionID: collection.ID,
		Name:         "Archived request",
		Request:      RequestData{Method: "GET", URL: "https://example.com/archived"},
	}
	if err := service.repo.createRequest(request); err != nil {
		t.Fatal(err)
	}

	if err := service.repo.archiveRequest(request.ID); err != nil {
		t.Fatal(err)
	}
	requests, err := service.repo.listRequests(collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(requests) != 0 {
		t.Fatalf("archived request reappeared in refresh list: %#v", requests)
	}

	if err := service.repo.archiveCollection(collection.ID); err != nil {
		t.Fatal(err)
	}
	collections, err := service.repo.listCollections(defaultProjectID)
	if err != nil {
		t.Fatal(err)
	}
	if len(collections) != 0 {
		t.Fatalf("archived collection reappeared in refresh list: %#v", collections)
	}
}

func TestSavedRequestEditRoundTripsAllFields(t *testing.T) {
	service := newTestService(t)
	collection := &APICollection{Name: "Users"}
	if err := service.repo.createCollection(collection); err != nil {
		t.Fatal(err)
	}

	original := &APIRequest{
		CollectionID: collection.ID,
		Name:         "List users",
		Description:  "Original description",
		Request: RequestData{
			Method: "POST", URL: "https://api.example.com/users",
			QueryParams: []KeyValue{{Name: "role", Value: "admin", Enabled: true}, {Name: "legacy", Value: "1", Enabled: false}},
			Headers:     []KeyValue{{Name: "X-Trace", Value: "on", Enabled: false}},
			BodyType:    "json", Body: `{"page":1}`,
			AuthConfig: map[string]any{"type": "bearer", "token": "{{token}}"},
		},
	}
	if err := service.repo.createRequest(original); err != nil {
		t.Fatal(err)
	}

	// Open a working copy bound to the saved request and edit every field group.
	// The HTTP layer seeds the draft from the request; mirror that here.
	copy := &APIWorkingCopy{APIRequestID: &original.ID, Request: original.Request}
	if err := service.repo.createWorkingCopy(copy); err != nil {
		t.Fatal(err)
	}
	copy.Request.URL = "https://api.example.com/users?v=2"
	copy.Request.QueryParams = append(copy.Request.QueryParams, KeyValue{Name: "status", Value: "active", Enabled: false})
	copy.Request.Headers = []KeyValue{{Name: "X-Trace", Value: "off", Enabled: false}, {Name: "Accept", Value: "application/json", Enabled: true}}
	copy.Request.Body = `{"page":2}`
	if err := service.repo.updateWorkingCopy(copy, copy.EditVersion); err != nil {
		t.Fatal(err)
	}

	newDesc := "Edited description"
	if _, err := service.repo.saveWorkingCopy(copy.ID, "", "List users v2", &newDesc); err != nil {
		t.Fatal(err)
	}

	reloaded, err := service.repo.getRequest(original.ID)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Name != "List users v2" {
		t.Fatalf("name did not persist: %q", reloaded.Name)
	}
	if reloaded.Description != newDesc {
		t.Fatalf("description did not persist losslessly: %q", reloaded.Description)
	}
	if reloaded.Request.URL != "https://api.example.com/users?v=2" {
		t.Fatalf("url edit lost: %q", reloaded.Request.URL)
	}
	if len(reloaded.Request.QueryParams) != 3 {
		t.Fatalf("query params lost: %#v", reloaded.Request.QueryParams)
	}
	var disabledKept bool
	for _, kv := range reloaded.Request.QueryParams {
		if kv.Name == "legacy" && !kv.Enabled {
			disabledKept = true
		}
	}
	if !disabledKept {
		t.Fatal("disabled query param was dropped on round-trip")
	}
	if reloaded.Request.Body != `{"page":2}` {
		t.Fatalf("body edit lost: %q", reloaded.Request.Body)
	}
	if reloaded.Request.AuthConfig["type"] != "bearer" || reloaded.Request.AuthConfig["token"] != "{{token}}" {
		t.Fatalf("auth config lost on round-trip: %#v", reloaded.Request.AuthConfig)
	}
}

func TestSaveWithNilDescriptionPreservesExisting(t *testing.T) {
	service := newTestService(t)
	collection := &APICollection{Name: "Users"}
	if err := service.repo.createCollection(collection); err != nil {
		t.Fatal(err)
	}
	request := &APIRequest{
		CollectionID: collection.ID, Name: "Keep desc", Description: "Keep me",
		Request: RequestData{Method: "GET", URL: "https://api.example.com/keep"},
	}
	if err := service.repo.createRequest(request); err != nil {
		t.Fatal(err)
	}
	copy := &APIWorkingCopy{APIRequestID: &request.ID, Name: request.Name, Request: request.Request}
	if err := service.repo.createWorkingCopy(copy); err != nil {
		t.Fatal(err)
	}
	if _, err := service.repo.saveWorkingCopy(copy.ID, "", "Keep desc", nil); err != nil {
		t.Fatal(err)
	}
	reloaded, err := service.repo.getRequest(request.ID)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Description != "Keep me" {
		t.Fatalf("nil description must not clear existing value, got %q", reloaded.Description)
	}
}

func TestUpdateWorkingCopyRejectsStaleEditVersion(t *testing.T) {
	service := newTestService(t)
	copy := &APIWorkingCopy{SourceType: "manual", Request: RequestData{Method: "GET", URL: "https://api.example.com/x"}}
	if err := service.repo.createWorkingCopy(copy); err != nil {
		t.Fatal(err)
	}
	staleVersion := copy.EditVersion
	copy.Request.URL = "https://api.example.com/x?v=2"
	if err := service.repo.updateWorkingCopy(copy, staleVersion); err != nil {
		t.Fatal(err)
	}
	// A second edit that reuses the now-stale version must be rejected, not applied.
	copy.Request.URL = "https://api.example.com/x?v=3"
	if err := service.repo.updateWorkingCopy(copy, staleVersion); err == nil {
		t.Fatal("stale edit_version was silently accepted")
	}
}

func TestSaveWorkingCopyRejectsStaleSavedRequest(t *testing.T) {
	service := newTestService(t)
	collection := &APICollection{Name: "Users"}
	if err := service.repo.createCollection(collection); err != nil {
		t.Fatal(err)
	}
	request := &APIRequest{
		CollectionID: collection.ID,
		Name:         "List users",
		Request:      RequestData{Method: "GET", URL: "https://api.example.com/users"},
	}
	if err := service.repo.createRequest(request); err != nil {
		t.Fatal(err)
	}

	first := &APIWorkingCopy{OwnerID: "editor-1", APIRequestID: &request.ID, Request: request.Request}
	second := &APIWorkingCopy{OwnerID: "editor-2", APIRequestID: &request.ID, Request: request.Request}
	if err := service.repo.createWorkingCopy(first); err != nil {
		t.Fatal(err)
	}
	if err := service.repo.createWorkingCopy(second); err != nil {
		t.Fatal(err)
	}

	first.Request.URL = "https://api.example.com/users?editor=1"
	if err := service.repo.updateWorkingCopy(first, first.EditVersion); err != nil {
		t.Fatal(err)
	}
	if _, err := service.repo.saveWorkingCopy(first.ID, "", request.Name, nil); err != nil {
		t.Fatal(err)
	}

	second.Request.URL = "https://api.example.com/users?editor=2"
	if err := service.repo.updateWorkingCopy(second, second.EditVersion); err != nil {
		t.Fatal(err)
	}
	if _, err := service.repo.saveWorkingCopy(second.ID, "", request.Name, nil); !errors.Is(err, errConflict) {
		t.Fatalf("expected stale draft conflict, got %v", err)
	}

	reloaded, err := service.repo.getRequest(request.ID)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Request.URL != first.Request.URL {
		t.Fatalf("stale save overwrote newer request: %q", reloaded.Request.URL)
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

	saved, err := service.repo.saveWorkingCopy(copy.ID, collection.ID, "Health", nil)
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

func TestURLEncodedBodySetsContentType(t *testing.T) {
	service := newTestService(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Content-Type"); got != "application/x-www-form-urlencoded" {
			t.Fatalf("unexpected content type %q", got)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != "name=Ada&role=admin" {
			t.Fatalf("unexpected body %q", body)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	status, _, _, _, _, _, err := service.execution.perform(context.Background(), RequestData{
		Method: "POST", URL: upstream.URL, BodyType: "urlencoded", Body: "name=Ada&role=admin",
	})
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusNoContent {
		t.Fatalf("unexpected status %d", status)
	}
}
