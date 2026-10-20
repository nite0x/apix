// Package activity embeds a local activity monitor in the runtime.
package activity

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/apix/apix/runtime/internal/journal"
	"github.com/apix/apix/runtime/internal/localservice"
	"github.com/gin-gonic/gin"
)

//go:embed web/*
var assets embed.FS

type monitor struct {
	db       *sql.DB
	services *localservice.Service
	history  *journal.Store
}
type serviceItem struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	HealthURL string `json:"health_url"`
	Status    string `json:"status"`
	PID       int    `json:"pid"`
	Owner     string `json:"owner"`
}
type requestItem struct {
	ID             string    `json:"id"`
	Method         string    `json:"method"`
	URL            string    `json:"url"`
	Status         string    `json:"status"`
	ResponseStatus *int      `json:"response_status"`
	DurationMS     int64     `json:"duration_ms"`
	Trigger        string    `json:"trigger"`
	StartedAt      time.Time `json:"started_at"`
	ErrorCode      string    `json:"error_code,omitempty"`
}
type serviceLog struct {
	localservice.LogLine
	ServiceID string `json:"service_id"`
}

func Routes(r gin.IRouter, db *sql.DB, services *localservice.Service, history *journal.Store) {
	m := &monitor{db: db, services: services, history: history}
	page, _ := assets.ReadFile("web/index.html")
	servePage := func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		c.Header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'")
		c.Header("X-Content-Type-Options", "nosniff")
		c.Data(http.StatusOK, "text/html; charset=utf-8", page)
	}
	r.GET("/", servePage)
	r.GET("/activity", servePage)
	r.GET("/services", servePage)
	r.GET("/requests", servePage)
	r.GET("/databases", servePage)
	r.GET("/flows", servePage)
	r.GET("/execution-records", servePage)
	r.GET("/tests", servePage)
	r.GET("/test-collections", servePage)
	r.GET("/mcp-tools", servePage)
	r.GET("/commands", servePage)
	r.GET("/logs", servePage)
	r.GET("/ai-tools", servePage)
	web, _ := fs.Sub(assets, "web")
	r.GET("/activity/assets/:name", func(c *gin.Context) {
		name := c.Param("name")
		if name != "execution-history.js" && name != "execution-history.css" && name != "execution-batch.js" && name != "command-tools.js" && name != "command-tools.css" && name != "mcp-tools.js" && name != "mcp-tools.css" && name != "ai-tools.js" && name != "ai-tools.css" && name != "request-api.js" && name != "request-library.js" && name != "request-history.js" && name != "workspace-tabs.js" && name != "app.js" && name != "request-detail.js" && name != "service-detail.js" && name != "databases.js" && name != "style.css" && name != "desktop.css" && name != "services.css" && name != "flows.js" && name != "flow-model.js" && name != "flows.css" && name != "testing.js" && name != "testing.css" && name != "manual-request.js" && name != "manual-request.css" && name != "service-editor.js" && name != "manual-tools.css" {
			c.Status(404)
			return
		}
		data, err := fs.ReadFile(web, name)
		if err != nil {
			c.Status(404)
			return
		}
		kind := "text/css; charset=utf-8"
		if strings.HasSuffix(name, ".js") {
			kind = "text/javascript; charset=utf-8"
		}
		c.Header("Cache-Control", "no-cache")
		c.Header("X-Content-Type-Options", "nosniff")
		c.Data(200, kind, data)
	})
	r.GET("/api/activity", m.snapshot)
}

func cursor(c *gin.Context, key string) (int64, bool, error) {
	raw, present := c.GetQuery(key)
	if !present {
		return 0, false, nil
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 0 {
		return 0, true, &cursorError{key}
	}
	return n, true, nil
}

type cursorError struct{ key string }

func (e *cursorError) Error() string { return e.key + " must be a nonnegative integer" }

func (m *monitor) snapshot(c *gin.Context) {
	eventAfter, hasEvent, err := cursor(c, "event_after")
	if err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	serviceAfter, hasService, err := cursor(c, "service_after")
	if err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	defs, err := m.services.ListDefinitions(ctx)
	if err != nil {
		m.fail(c, err)
		return
	}
	services := make([]serviceItem, 0, len(defs))
	running := 0
	for _, d := range defs {
		state, e := m.services.Status(ctx, d.ID)
		if e != nil {
			m.fail(c, e)
			return
		}
		if state.Status == "running" {
			running++
		}
		services = append(services, serviceItem{ID: d.ID, Name: d.Name, HealthURL: safeURL(d.HealthURL), Status: state.Status, PID: state.PID, Owner: state.Owner})
	}
	sort.SliceStable(services, func(i, j int) bool {
		a, b := services[i].Status == "running", services[j].Status == "running"
		if a != b {
			return a
		}
		return services[i].Name < services[j].Name
	})
	requests, err := m.requests(ctx)
	if err != nil {
		m.fail(c, err)
		return
	}
	var maxEvent, maxService int64
	if err = m.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(sequence),0) FROM runtime_events`).Scan(&maxEvent); err != nil {
		m.fail(c, err)
		return
	}
	if err = m.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(sequence),0) FROM local_service_logs`).Scan(&maxService); err != nil {
		m.fail(c, err)
		return
	}
	resetEvent := !hasEvent || eventAfter > maxEvent
	resetService := !hasService || serviceAfter > maxService
	if resetEvent {
		eventAfter = 0
		_ = m.db.QueryRowContext(ctx, `SELECT COALESCE(MIN(sequence)-1,0) FROM (SELECT sequence FROM runtime_events ORDER BY sequence DESC LIMIT 100)`).Scan(&eventAfter)
	}
	events, err := m.history.Events(ctx, "", eventAfter, 200)
	if err != nil {
		m.fail(c, err)
		return
	}
	logs, err := m.serviceLogs(ctx, serviceAfter, resetService)
	if err != nil {
		m.fail(c, err)
		return
	}
	eventCursor := eventAfter
	for _, event := range events {
		if event.Sequence > eventCursor {
			eventCursor = event.Sequence
		}
	}
	serviceCursor := serviceAfter
	if resetService {
		serviceCursor = 0
	}
	for _, line := range logs {
		if line.Sequence > serviceCursor {
			serviceCursor = line.Sequence
		}
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"time": time.Now().UTC(), "services": services, "running_services": running, "requests": requests, "events": events, "service_logs": logs, "event_cursor": eventCursor, "service_cursor": serviceCursor, "reset_events": resetEvent, "reset_services": resetService, "more": eventCursor < maxEvent || serviceCursor < maxService})
}
func (m *monitor) fail(c *gin.Context, err error) {
	c.JSON(503, gin.H{"error": "活动数据暂时不可用，请稍后重试"})
}

func (m *monitor) requests(ctx context.Context) ([]requestItem, error) {
	rows, err := m.db.QueryContext(ctx, `SELECT id,request_snapshot,status,response_status,COALESCE(duration_ms,0),trigger_type,started_at,COALESCE(error_code,'') FROM api_runs ORDER BY started_at DESC,id DESC LIMIT 50`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []requestItem{}
	for rows.Next() {
		var item requestItem
		var snapshot string
		var code sql.NullInt64
		if err := rows.Scan(&item.ID, &snapshot, &item.Status, &code, &item.DurationMS, &item.Trigger, &item.StartedAt, &item.ErrorCode); err != nil {
			return nil, err
		}
		var request struct {
			Method string `json:"method"`
			URL    string `json:"url"`
		}
		if err := json.Unmarshal([]byte(snapshot), &request); err != nil {
			return nil, err
		}
		item.Method = request.Method
		item.URL = safeURL(request.URL)
		if code.Valid {
			v := int(code.Int64)
			item.ResponseStatus = &v
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
func (m *monitor) serviceLogs(ctx context.Context, after int64, recent bool) ([]serviceLog, error) {
	statement := `SELECT sequence,service_id,time,stream,message FROM local_service_logs WHERE sequence>? ORDER BY sequence LIMIT 200`
	if recent {
		statement = `SELECT sequence,service_id,time,stream,message FROM (SELECT sequence,service_id,time,stream,message FROM local_service_logs ORDER BY sequence DESC LIMIT 200) ORDER BY sequence`
		after = 0
	}
	var rows *sql.Rows
	var err error
	if recent {
		rows, err = m.db.QueryContext(ctx, statement)
	} else {
		rows, err = m.db.QueryContext(ctx, statement, after)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []serviceLog{}
	for rows.Next() {
		var line serviceLog
		var timestamp string
		if err := rows.Scan(&line.Sequence, &line.ServiceID, &timestamp, &line.Stream, &line.Message); err != nil {
			return nil, err
		}
		line.Time, err = time.Parse(time.RFC3339Nano, timestamp)
		if err != nil {
			return nil, err
		}
		out = append(out, line)
	}
	return out, rows.Err()
}
func safeURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "（无效 URL）"
	}
	parsed.User = nil
	query := parsed.Query()
	for name := range query {
		lower := strings.ToLower(name)
		if strings.Contains(lower, "token") || strings.Contains(lower, "password") || strings.Contains(lower, "secret") || strings.Contains(lower, "key") || lower == "authorization" {
			query.Set(name, "••••••")
		}
	}
	parsed.RawQuery = query.Encode()
	parsed.Fragment = ""
	return strings.ReplaceAll(parsed.String(), url.QueryEscape("••••••"), "••••••")
}
