package database

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
)

func (s *Service) Routes(r gin.IRouter) {
	g := r.Group("/database")
	g.GET("/connections", func(c *gin.Context) {
		items, err := s.ListConnections(c.Request.Context())
		if err != nil {
			writeError(c, err)
			return
		}
		c.JSON(http.StatusOK, items)
	})
	g.PUT("/connections", func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32<<10)
		var item ConnectionInput
		if err := c.ShouldBindJSON(&item); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid connection JSON"})
			return
		}
		saved, err := s.SaveConnection(c.Request.Context(), item)
		if err != nil {
			writeError(c, err)
			return
		}
		c.JSON(http.StatusOK, saved)
	})
	g.POST("/connections/:id/test", func(c *gin.Context) {
		if err := s.TestConnection(c.Request.Context(), c.Param("id")); err != nil {
			writeError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	g.DELETE("/connections/:id", func(c *gin.Context) {
		if err := s.DeleteConnection(c.Request.Context(), c.Param("id")); err != nil {
			writeError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	})
	g.POST("/execute", func(c *gin.Context) {
		var cmd Command
		if err := c.ShouldBindJSON(&cmd); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid SQL command JSON"})
			return
		}
		result, err := s.Execute(c.Request.Context(), cmd)
		if err != nil {
			writeError(c, err)
			return
		}
		c.JSON(http.StatusOK, result)
	})
}

func writeError(c *gin.Context, err error) {
	status := http.StatusInternalServerError
	if errors.Is(err, ErrInvalid) {
		status = http.StatusBadRequest
	}
	if errors.Is(err, ErrNotFound) {
		status = http.StatusNotFound
	}
	c.JSON(status, gin.H{"error": err.Error()})
}
