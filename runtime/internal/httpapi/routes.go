package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/apix/apix/runtime/internal/core"
)

// Routes registers HTTP frontend management endpoints under /api/http/.
//
// Collections:
//
//	GET    /api/http/collections          → list all
//	POST   /api/http/collections          → create
//	GET    /api/http/collections/:cid     → get one
//	PUT    /api/http/collections/:cid     → update
//	DELETE /api/http/collections/:cid     → delete
//
// Requests within a collection:
//
//	POST   /api/http/collections/:cid/requests          → add request
//	PUT    /api/http/collections/:cid/requests/:rid     → update request
//	DELETE /api/http/collections/:cid/requests/:rid     → delete request
func (s *HTTPService) Routes(r gin.IRouter) {
	col := r.Group("/collections")

	col.GET("", func(c *gin.Context) {
		c.JSON(http.StatusOK, s.store.list())
	})

	col.POST("", func(c *gin.Context) {
		var body struct {
			Name    string `json:"name" binding:"required"`
			BaseURL string `json:"base_url"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusCreated, s.store.create(body.Name, body.BaseURL))
	})

	col.GET("/:cid", func(c *gin.Context) {
		col, ok := s.store.get(c.Param("cid"))
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "collection not found"})
			return
		}
		c.JSON(http.StatusOK, col)
	})

	col.PUT("/:cid", func(c *gin.Context) {
		var body struct {
			Name    string `json:"name" binding:"required"`
			BaseURL string `json:"base_url"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		updated, err := s.store.update(c.Param("cid"), body.Name, body.BaseURL)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, updated)
	})

	col.DELETE("/:cid", func(c *gin.Context) {
		if !s.store.delete(c.Param("cid")) {
			c.JSON(http.StatusNotFound, gin.H{"error": "collection not found"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	// Requests nested under a collection
	req := col.Group("/:cid/requests")

	req.POST("", func(c *gin.Context) {
		var body Request
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		updated, err := s.store.addRequest(c.Param("cid"), body)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusCreated, updated)
	})

	req.PUT("/:rid", func(c *gin.Context) {
		var body Request
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		updated, err := s.store.updateRequest(c.Param("cid"), c.Param("rid"), body)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, updated)
	})

	req.DELETE("/:rid", func(c *gin.Context) {
		updated, err := s.store.deleteRequest(c.Param("cid"), c.Param("rid"))
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, updated)
	})
}

// ManualRoutes exposes direct request execution for the desktop UI.
func (s *HTTPService) ManualRoutes(r gin.IRouter) {
	r.POST("/manual", func(c *gin.Context) {
		var body struct {
			Method  string            `json:"method"`
			URL     string            `json:"url"`
			Body    string            `json:"body"`
			Headers map[string]string `json:"headers"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		headers := make(map[string]any, len(body.Headers))
		for key, value := range body.Headers {
			headers[key] = value
		}

		result, err := s.Execute(c.Request.Context(), "send_request", map[string]any{
			"method":  body.Method,
			"url":     body.URL,
			"body":    body.Body,
			"headers": headers,
		}, core.NewVariables())
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		c.JSON(http.StatusOK, result)
	})
}
