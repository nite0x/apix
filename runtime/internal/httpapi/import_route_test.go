package httpapi

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func newTestRouter(t *testing.T) (*HTTPService, *gin.Engine) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	// A plain ":memory:" DB is private per connection, so a transaction can land on
	// a fresh empty database. A shared-cache in-memory DSN keeps every pooled
	// connection pointed at the same tables without serializing to one connection
	// (which would deadlock listRequests' query-inside-cursor pattern).
	db, err := sql.Open("sqlite", "file:import_route_"+t.Name()+"?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	service := New()
	if err := service.MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	service.Routes(router)
	return service, router
}

func postJSON(t *testing.T, router http.Handler, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

// Importing a cURL command must yield a reviewable Working Copy draft — never a
// saved API. The draft carries the parsed request so the workspace editor can
// show and edit it before an explicit save.
func TestImportCurlCreatesReviewableDraftWithoutSaving(t *testing.T) {
	service, router := newTestRouter(t)

	body := `{"content":"curl -X POST https://api.example.com/users -H 'Content-Type: application/json' --data-raw '{\"name\":\"Ada\"}'"}`
	rec := postJSON(t, router, "/import/curl", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	var copy APIWorkingCopy
	if err := json.Unmarshal(rec.Body.Bytes(), &copy); err != nil {
		t.Fatal(err)
	}
	if copy.SourceType != "curl_import" {
		t.Fatalf("expected curl_import source, got %q", copy.SourceType)
	}
	if copy.APIRequestID != nil {
		t.Fatalf("import must not bind a saved request, got %v", *copy.APIRequestID)
	}
	if copy.Request.Method != "POST" || copy.Request.URL != "https://api.example.com/users" {
		t.Fatalf("unexpected parsed request: %#v", copy.Request)
	}
	if copy.Request.Body != `{"name":"Ada"}` || copy.Request.BodyType != "json" {
		t.Fatalf("unexpected body: %#v", copy.Request)
	}
	var contentType string
	for _, header := range copy.Request.Headers {
		if header.Name == "Content-Type" {
			contentType = header.Value
		}
	}
	if contentType != "application/json" {
		t.Fatalf("expected parsed Content-Type header, got %q", contentType)
	}

	// No durable request may exist until an explicit save.
	if _, err := service.repo.getWorkingCopy(copy.ID); err != nil {
		t.Fatalf("draft should be retrievable: %v", err)
	}
}

func TestImportRawHTTPCreatesDraft(t *testing.T) {
	_, router := newTestRouter(t)

	body := `{"content":"GET /health HTTP/1.1\nHost: 127.0.0.1:4317"}`
	rec := postJSON(t, router, "/import/curl", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	var copy APIWorkingCopy
	if err := json.Unmarshal(rec.Body.Bytes(), &copy); err != nil {
		t.Fatal(err)
	}
	if copy.Request.Method != "GET" || copy.Request.URL != "http://127.0.0.1:4317/health" {
		t.Fatalf("unexpected parsed request: %#v", copy.Request)
	}
	if copy.Request.BodyType != "none" {
		t.Fatalf("expected body_type none for a bodyless GET, got %q", copy.Request.BodyType)
	}
}

func TestImportRejectsInvalidInput(t *testing.T) {
	_, router := newTestRouter(t)

	for _, body := range []string{
		`{"content":"not a request"}`,
		`{"content":"curl https://example.com --data @secret.json"}`,
		`{"content":""}`,
	} {
		rec := postJSON(t, router, "/import/curl", body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for %q, got %d: %s", body, rec.Code, rec.Body.String())
		}
	}
}

// The full import→save path must promote a draft into a durable request that
// shows up in the catalog list consumed by Library, Search and Picker.
func TestImportThenSavePromotesDraftIntoCatalog(t *testing.T) {
	service, router := newTestRouter(t)

	collection := &APICollection{Name: "Imported"}
	if err := service.repo.createCollection(collection); err != nil {
		t.Fatal(err)
	}

	rec := postJSON(t, router, "/import/curl", `{"content":"curl https://api.example.com/items"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("import failed: %d %s", rec.Code, rec.Body.String())
	}
	var copy APIWorkingCopy
	if err := json.Unmarshal(rec.Body.Bytes(), &copy); err != nil {
		t.Fatal(err)
	}

	saveBody := `{"collection_id":"` + collection.ID + `","name":"List items"}`
	saveRec := postJSON(t, router, "/working-copies/"+copy.ID+"/save", saveBody)
	if saveRec.Code != http.StatusOK {
		t.Fatalf("save failed: %d %s", saveRec.Code, saveRec.Body.String())
	}

	requests, err := service.repo.listRequests(collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(requests) != 1 || requests[0].Name != "List items" || requests[0].Request.URL != "https://api.example.com/items" {
		t.Fatalf("expected one saved request, got %#v", requests)
	}
}

func TestImportPreservesNonJSONBodyTypes(t *testing.T) {
	for _, tc := range []struct{ name, content, bodyType string }{
		{"form", "curl -X POST https://example.test -H 'Content-Type: application/x-www-form-urlencoded' --data 'a=1&b=2'", "urlencoded"},
		{"text", "curl -X POST https://example.test -H 'Content-Type: text/plain' --data 'hello'", "raw"},
		{"inferred-json", "curl -X POST https://example.test --data '{\"ok\":true}'", "json"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, router := newTestRouter(t)
			payload, _ := json.Marshal(map[string]string{"content": tc.content})
			response := postJSON(t, router, "/import/curl", string(payload))
			if response.Code != http.StatusCreated {
				t.Fatalf("import failed: %d %s", response.Code, response.Body.String())
			}
			var copy APIWorkingCopy
			if err := json.Unmarshal(response.Body.Bytes(), &copy); err != nil {
				t.Fatal(err)
			}
			if copy.Request.BodyType != tc.bodyType {
				t.Fatalf("body type=%s want=%s", copy.Request.BodyType, tc.bodyType)
			}
		})
	}
}

func TestRunSummariesOmitPayloadsAndRedactURL(t *testing.T) {
	service, router := newTestRouter(t)
	run := &APIRun{ID: "summary-run", ProjectID: "default", TriggerType: "manual", Status: "succeeded",
		StartedAt: time.Now().UTC(), RequestSnapshot: RequestData{Method: "POST",
			URL: "http://user:private@example.test/check?token=private&name=visible", Body: "request-payload",
			Headers: []KeyValue{{Name: "Authorization", Value: "private", Enabled: true}}},
		ResponseBody: strings.Repeat("response-payload", 1000)}
	if err := service.repo.insertRun(run); err != nil {
		t.Fatal(err)
	}
	if err := service.repo.finishRun(run); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/runs?summary=true&limit=200", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("summary: %d %s", recorder.Code, recorder.Body.String())
	}
	for _, forbidden := range []string{"request-payload", "response-payload", "Authorization", "private"} {
		if strings.Contains(recorder.Body.String(), forbidden) {
			t.Fatalf("summary included payload or secret %s", forbidden)
		}
	}
	var summaries []APIRun
	if err := json.Unmarshal(recorder.Body.Bytes(), &summaries); err != nil {
		t.Fatal(err)
	}
	if len(summaries) != 1 || !strings.Contains(summaries[0].RequestSnapshot.URL, "name=visible") {
		t.Fatalf("unexpected summaries: %#v", summaries)
	}
}
