package activity

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/apix/apix/runtime/internal/httpapi"
	"github.com/apix/apix/runtime/internal/journal"
	"github.com/apix/apix/runtime/internal/localservice"
	"github.com/apix/apix/runtime/internal/store"
	"github.com/gin-gonic/gin"
)

func TestReadOnlyMonitorHistoryCursorsAndEmbeddedAssets(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := store.NewSQLiteStore(filepath.Join(t.TempDir(), "activity.db"))
	db.DB().SetMaxOpenConns(1)
	defer db.DB().Close()
	hs := httpapi.New()
	if err := hs.MigrateSchema(db.DB()); err != nil {
		t.Fatal(err)
	}
	services, err := localservice.New(db.DB())
	if err != nil {
		t.Fatal(err)
	}
	defer services.Close()
	history, err := journal.New(db.DB(), filepath.Join(t.TempDir(), "runtime.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer history.Close()
	_, err = services.PutDefinition(context.Background(), localservice.Definition{ID: "svc", Name: "Example <script>", Command: "not-executed", WorkDir: t.TempDir(), HealthURL: "http://127.0.0.1:18767/health"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 120; i++ {
		if _, err := db.DB().Exec(`INSERT INTO runtime_events(time,run_id,step_id,type,payload) VALUES(?,?,'','tool.finished','{}')`, time.Now().UTC().Format(time.RFC3339Nano), fmt.Sprint(i)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.DB().Exec(`INSERT INTO local_service_logs(service_id,time,stream,message) VALUES('svc',?,'stdout','<script>alert(1)</script>')`, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	snapshot := `{"method":"GET","url":"http://user:pass@localhost/hello?token=topsecret&name=example"}`
	if _, err := db.DB().Exec(`INSERT INTO api_runs(id,project_id,trigger_type,status,request_snapshot,is_pinned,started_at) VALUES('request','default','ai','running',?,0,?)`, snapshot, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	Routes(r, db.DB(), services, history)
	get := func(path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		return w
	}
	page := get("/")
	if page.Code != 200 || !strings.Contains(page.Body.String(), "实时日志") || page.Header().Get("Content-Security-Policy") == "" {
		t.Fatalf("page=%d", page.Code)
	}
	for _, path := range []string{"/", "/activity", "/services", "/requests", "/databases", "/flows", "/flows?id=example", "/execution-records", "/execution-records?batch=example", "/execution-records?run=example", "/tests", "/tests?batch=example", "/test-collections", "/test-collections?tab=records&batch=example", "/logs", "/logs?source=svc", "/ai-tools"} {
		w := get(path)
		if w.Code != 200 || !strings.Contains(w.Body.String(), `aria-label="主导航"`) || w.Header().Get("Content-Security-Policy") == "" {
			t.Fatalf("page route %s: %d", path, w.Code)
		}
	}
	for _, path := range []string{"/activity/assets/execution-history.js", "/activity/assets/execution-history.css", "/activity/assets/execution-batch.js", "/activity/assets/ai-tools.js", "/activity/assets/ai-tools.css", "/activity/assets/request-api.js", "/activity/assets/request-library.js", "/activity/assets/request-history.js", "/activity/assets/app.js", "/activity/assets/workspace-tabs.js", "/activity/assets/request-detail.js", "/activity/assets/service-detail.js", "/activity/assets/databases.js", "/activity/assets/style.css", "/activity/assets/desktop.css", "/activity/assets/services.css", "/activity/assets/flows.js", "/activity/assets/flow-model.js", "/activity/assets/flows.css", "/activity/assets/testing.js", "/activity/assets/testing.css", "/activity/assets/manual-request.js", "/activity/assets/manual-request.css", "/activity/assets/service-editor.js", "/activity/assets/manual-tools.css"} {
		if w := get(path); w.Code != 200 {
			t.Fatalf("missing embedded asset %s", path)
		}
	}
	if w := get("/activity/assets/missing"); w.Code != 404 {
		t.Fatalf("unexpected asset %d", w.Code)
	}
	w := get("/api/activity")
	if w.Code != 200 {
		t.Fatalf("snapshot %d %s", w.Code, w.Body.String())
	}
	var first struct {
		Events        []journal.Event `json:"events"`
		ServiceLogs   []serviceLog    `json:"service_logs"`
		Services      []serviceItem   `json:"services"`
		Requests      []requestItem   `json:"requests"`
		EventCursor   int64           `json:"event_cursor"`
		ServiceCursor int64           `json:"service_cursor"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if len(first.Events) != 100 || first.Events[0].Sequence != 21 || first.EventCursor != 120 {
		t.Fatalf("initial tail incorrect: %#v", first.Events)
	}
	if len(first.Services) != 1 || first.Services[0].Status != "stopped" || len(first.ServiceLogs) != 1 {
		t.Fatalf("services/logs missing: %s", w.Body.String())
	}
	if len(first.Requests) != 1 || strings.Contains(first.Requests[0].URL, "topsecret") || strings.Contains(first.Requests[0].URL, "user:pass") {
		t.Fatalf("unsafe request summary: %#v", first.Requests)
	}
	path := fmt.Sprintf("/api/activity?event_after=%d&service_after=%d", first.EventCursor, first.ServiceCursor)
	var next struct {
		Events      []journal.Event `json:"events"`
		ServiceLogs []serviceLog    `json:"service_logs"`
	}
	w = get(path)
	if err := json.Unmarshal(w.Body.Bytes(), &next); err != nil {
		t.Fatal(err)
	}
	if len(next.Events) != 0 || len(next.ServiceLogs) != 0 {
		t.Fatal("cursor repeated logs")
	}
	history.Append("tool.started", "new", "", map[string]any{"tool": "execute_sql"})
	w = get(path)
	if err := json.Unmarshal(w.Body.Bytes(), &next); err != nil {
		t.Fatal(err)
	}
	if len(next.Events) != 1 || next.Events[0].Sequence != 121 {
		t.Fatal("new event not delivered")
	}
	if w := get("/api/activity?event_after=-1"); w.Code != 400 {
		t.Fatal("negative cursor accepted")
	}
	if w := get("/api/activity?service_after=oops"); w.Code != 400 {
		t.Fatal("malformed cursor accepted")
	}
	w = get("/api/activity?event_after=9999&service_after=9999")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"reset_events":true`) {
		t.Fatal("did not recover from a restarted/replaced database")
	}
}
