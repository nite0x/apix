package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/sentris/sentris/runtime/internal/core"
)

func SetupRoutes(r *gin.Engine, executor *core.Executor) {
	api := r.Group("/api")

	api.GET("/sessions", func(c *gin.Context) {
		c.JSON(http.StatusOK, executor.GetSessions())
	})

	api.GET("/sessions/:id", func(c *gin.Context) {
		s, ok := executor.GetSession(c.Param("id"))
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
			return
		}
		c.JSON(http.StatusOK, s)
	})

	api.POST("/steps/:id/resume", func(c *gin.Context) {
		var body struct {
			Action        string `json:"action"`
			ModifiedInput any    `json:"modified_input"`
		}
		if err := c.BindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if err := executor.Resume(c.Param("id"), body.Action, body.ModifiedInput); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	api.GET("/rules", func(c *gin.Context) {
		c.JSON(http.StatusOK, executor.GetRules())
	})

	api.PUT("/rules", func(c *gin.Context) {
		var rules []*core.Rule
		if err := c.BindJSON(&rules); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		executor.UpdateRules(rules)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
}
