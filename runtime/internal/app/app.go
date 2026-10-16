package app

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/apix/apix/runtime/internal/activity"
	"github.com/apix/apix/runtime/internal/api"
	"github.com/apix/apix/runtime/internal/core"
	"github.com/apix/apix/runtime/internal/database"
	"github.com/apix/apix/runtime/internal/httpapi"
	"github.com/apix/apix/runtime/internal/journal"
	"github.com/apix/apix/runtime/internal/localservice"
	mcpserver "github.com/apix/apix/runtime/internal/mcp"
	"github.com/apix/apix/runtime/internal/store"
	"github.com/gin-gonic/gin"
)

func Run(_ []string) error {
	// stdout is reserved for callers that embed this binary. Keep every normal
	// runtime log on stderr so it can never corrupt a protocol response.
	log.SetOutput(os.Stderr)
	gin.DefaultWriter = os.Stderr
	gin.DefaultErrorWriter = os.Stderr

	// 1. Storage
	dbPath := sqlitePath()
	if err := os.MkdirAll(filepath.Dir(dbPath), 0700); err != nil {
		return err
	}
	db := store.NewSQLiteStore(dbPath)
	db.DB().SetMaxOpenConns(1)
	defer db.DB().Close()
	logPath := os.Getenv("APIX_LOG_PATH")
	if logPath == "" {
		logPath = filepath.Join(filepath.Dir(dbPath), "runtime.log")
	}
	history, err := journal.New(db.DB(), logPath)
	if err != nil {
		return err
	}
	defer history.Close()
	databaseService, err := database.New(db.DB())
	if err != nil {
		return err
	}
	defer databaseService.Close()
	serviceManager, err := localservice.New(db.DB())
	if err != nil {
		return err
	}
	defer serviceManager.Close()
	// 2. Core modules
	hub := core.NewHub()
	hub.SetEventSink(func(event core.Event) {
		if strings.HasPrefix(string(event.Type), "flow_run.") || strings.HasPrefix(string(event.Type), "test_case.") || strings.HasPrefix(string(event.Type), "test_batch.") {
			return
		}
		// Session payloads include request bodies and variables; only log metadata.
		history.Append(string(event.Type), event.SessionID, event.StepID, nil)
	})
	rules := core.NewRuleEngine(db)
	sessions := core.NewSessionManager(db)
	httpService := httpapi.New()
	if err := httpService.MigrateSchema(db.DB()); err != nil {
		return fmt.Errorf("http schema migration failed: %w", err)
	}
	if err := httpService.RecoverInterruptedRuns(); err != nil {
		return err
	}
	httpService.SetCapabilities(databaseService, serviceManager)
	httpService.SetEventSink(history.Append)
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := httpService.Close(ctx); err != nil {
			log.Printf("flow shutdown: %v", err)
		}
	}()
	httpService.SetHub(hub)
	httpService.SetRuleEngine(rules)
	executor := core.NewExecutor(sessions, rules, hub, db, httpService.Execute, httpService.ExtractVars)

	// 3. MCP server
	mcp := mcpserver.NewServer(executor)

	// 4. REST API, WebSocket, and Streamable HTTP MCP on localhost.
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.LoggerWithWriter(os.Stderr), gin.RecoveryWithWriter(os.Stderr))
	r.Use(recordOperations(history))
	r.Use(func(c *gin.Context) {
		// Streamable MCP has its own strict Origin guard below. Keep the
		// legacy browser CORS policy away from /mcp.
		if c.Request.URL.Path == "/mcp" {
			c.Next()
			return
		}
		origin := c.GetHeader("Origin")
		if origin != "" && origin != "http://"+c.Request.Host && !allowedBrowserOrigin(origin) {
			c.AbortWithStatus(http.StatusForbidden)
			return
		}
		if origin != "" {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
		}
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	api.SetupRoutes(r, executor)
	api.SetupWebSocket(r, hub)
	r.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{
			"service": "apix-runtime",
			"status":  "ok",
		})
	})

	// 5. Register HTTP endpoints for both MCP and the frontend.
	mcp.RegisterHTTPTools(httpService)
	mcp.RegisterCapabilities(httpService, databaseService, serviceManager, history)
	r.Any("/mcp", allowMCPOrigin(), gin.WrapH(mcp.HTTPHandler()))
	httpService.Routes(r.Group("/api"))
	databaseService.Routes(r.Group("/api"))
	serviceManager.Routes(r.Group("/api"))
	activity.Routes(r, db.DB(), serviceManager, history)
	r.GET("/api/events", func(c *gin.Context) {
		after, e := strconv.ParseInt(valueOr(c.Query("after"), "0"), 10, 64)
		if e != nil {
			c.JSON(400, gin.H{"error": "invalid after"})
			return
		}
		events, e := history.Events(c.Request.Context(), c.Query("run_id"), after, 200)
		if e != nil {
			c.JSON(500, gin.H{"error": e.Error()})
			return
		}
		c.JSON(200, events)
	})
	r.GET("/api/operations/:id", func(c *gin.Context) {
		operation, e := history.Get(c.Request.Context(), c.Param("id"))
		if e != nil {
			c.JSON(404, gin.H{"error": "operation not found"})
			return
		}
		c.JSON(200, operation)
	})

	// 6. One independent Runtime owns both transports. AI clients connect to
	// http://127.0.0.1:4317/mcp; desktop clients continue to use /api and /ws.
	address := os.Getenv("APIX_ADDR")
	if address == "" {
		address = "127.0.0.1:4317"
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("invalid APIX_ADDR: %w", err)
	}
	if host != "localhost" && (net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback()) {
		return fmt.Errorf("APIX_ADDR must bind to loopback")
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server := &http.Server{Handler: r, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	serverErr := make(chan error, 1)
	go func() { serverErr <- server.Serve(listener) }()
	history.Append("runtime.started", "", "", map[string]any{"address": listener.Addr().String(), "mcp": "/mcp"})
	log.Printf("Activity monitor: http://%s/", listener.Addr().String())
	select {
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := httpService.Close(shutdown); err != nil {
			log.Printf("flow shutdown: %v", err)
		}
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
		}
		history.Append("runtime.stopped", "", "", nil)
		return nil
	case err := <-serverErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func valueOr(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
func allowedBrowserOrigin(origin string) bool {
	for _, value := range []string{"http://127.0.0.1:1420", "http://localhost:1420", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"} {
		if origin == value {
			return true
		}
	}
	for _, value := range strings.Split(os.Getenv("APIX_ALLOWED_ORIGINS"), ",") {
		if origin == strings.TrimSpace(value) {
			return true
		}
	}
	return false
}

// allowMCPOrigin rejects browser requests unless their exact Origin appears
// in APIX_MCP_ALLOWED_ORIGINS. Native MCP clients normally omit Origin and are
// allowed because the Runtime is bound to loopback only.
func allowMCPOrigin() gin.HandlerFunc {
	allowed := map[string]struct{}{}
	for _, value := range strings.Split(os.Getenv("APIX_MCP_ALLOWED_ORIGINS"), ",") {
		if origin := strings.TrimSpace(value); origin != "" {
			allowed[origin] = struct{}{}
		}
	}

	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" {
			if _, ok := allowed[origin]; !ok {
				c.AbortWithStatus(http.StatusForbidden)
				return
			}
		}
		c.Next()
	}
}

func sqlitePath() string {
	if path := os.Getenv("APIX_DB_PATH"); path != "" {
		return path
	}

	return "apix.db"
}
