package app

import (
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/apix/apix/runtime/internal/api"
	"github.com/apix/apix/runtime/internal/core"
	"github.com/apix/apix/runtime/internal/httpapi"
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
	db := store.NewSQLiteStore(sqlitePath())
	// 2. Core modules
	hub := core.NewHub()
	rules := core.NewRuleEngine(db)
	sessions := core.NewSessionManager(db)
	httpService := httpapi.New()
	if err := httpService.MigrateSchema(db.DB()); err != nil {
		log.Fatalf("http schema migration failed: %v", err)
	}
	httpService.SetHub(hub)
	httpService.SetRuleEngine(rules)
	executor := core.NewExecutor(sessions, rules, hub, db, httpService.Execute, httpService.ExtractVars)

	// 3. MCP server
	mcp := mcpserver.NewServer(executor)

	// 4. REST API, WebSocket, and Streamable HTTP MCP on localhost.
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.LoggerWithWriter(os.Stderr), gin.RecoveryWithWriter(os.Stderr))
	r.Use(func(c *gin.Context) {
		// Streamable MCP has its own strict Origin guard below. Keep the
		// legacy browser CORS policy away from /mcp.
		if c.Request.URL.Path == "/mcp" {
			c.Next()
			return
		}
		c.Header("Access-Control-Allow-Origin", "*")
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
	r.Any("/mcp", allowMCPOrigin(), gin.WrapH(mcp.HTTPHandler()))
	httpService.Routes(r.Group("/api"))

	// 6. One independent Runtime owns both transports. AI clients connect to
	// http://127.0.0.1:4317/mcp; desktop clients continue to use /api and /ws.
	log.Println("Apix Runtime listening on http://127.0.0.1:4317 (MCP: /mcp)")
	return r.Run("127.0.0.1:4317")
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
