package app

import (
	"context"
	"log"

	"github.com/gin-gonic/gin"
	"github.com/sentris/sentris/runtime/internal/api"
	"github.com/sentris/sentris/runtime/internal/core"
	"github.com/sentris/sentris/runtime/internal/httpapi"
	mcpserver "github.com/sentris/sentris/runtime/internal/mcp"
	"github.com/sentris/sentris/runtime/internal/store"
)

func Run(_ []string) error {
	// 1. Storage
	db := store.NewSQLiteStore("sentris.db")

	// 2. Core modules
	hub := core.NewHub()
	rules := core.NewRuleEngine(db)
	sessions := core.NewSessionManager(db)
	httpService := httpapi.New()
	if err := httpService.MigrateSchema(db.DB()); err != nil {
		log.Fatalf("http schema migration failed: %v", err)
	}
	executor := core.NewExecutor(sessions, rules, hub, db, httpService.Execute, httpService.ExtractVars)

	// 3. MCP server
	mcp := mcpserver.NewServer(executor)

	// 4. REST API + WebSocket on :4317
	gin.SetMode(gin.ReleaseMode)
	r := gin.Default()
	r.Use(func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
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
			"service": "sentris-runtime",
			"status":  "ok",
		})
	})

	// 5. Register HTTP endpoints for both MCP and the frontend.
	mcp.RegisterHTTPTools(httpService)
	httpService.Routes(r.Group("/api/http"))
	httpService.ManualRoutes(r)

	// 6. Start HTTP server
	go func() {
		log.Println("Sentris API listening on :4317")
		if err := r.Run(":4317"); err != nil {
			log.Fatal(err)
		}
	}()

	// 7. MCP Server (stdio, blocking — Claude Desktop connects here)
	log.Println("Sentris MCP Server starting...")
	return mcp.ServeStdio(context.Background())
}
