package localservice

import (
	"database/sql"
	"errors"
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
)

func (s *Service) Routes(r gin.IRouter) {
	g := r.Group("/services")
	respond := func(c *gin.Context, value any, err error) {
		if err != nil {
			code := http.StatusBadRequest
			if errors.Is(err, sql.ErrNoRows) {
				code = http.StatusNotFound
			}
			c.JSON(code, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, value)
	}
	g.GET("", func(c *gin.Context) { v, e := s.ListDefinitions(c.Request.Context()); respond(c, v, e) })
	g.GET("/:id", func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		v, e := s.Details(c.Request.Context(), c.Param("id"))
		respond(c, v, e)
	})
	g.PUT("", func(c *gin.Context) {
		var d Definition
		if e := c.ShouldBindJSON(&d); e != nil {
			respond(c, nil, e)
			return
		}
		v, e := s.PutDefinition(c.Request.Context(), d)
		respond(c, v, e)
	})
	g.DELETE("/:id", func(c *gin.Context) {
		err := s.DeleteDefinition(c.Request.Context(), c.Param("id"))
		respond(c, gin.H{"deleted": err == nil}, err)
	})
	for _, action := range []string{"start", "stop"} {
		action := action
		g.POST("/:id/"+action, func(c *gin.Context) {
			var input struct {
				Owner string `json:"owner"`
			}
			if c.Request.ContentLength != 0 {
				if e := c.ShouldBindJSON(&input); e != nil {
					respond(c, nil, e)
					return
				}
			}
			var v *Instance
			var e error
			if action == "start" {
				v, e = s.Start(c.Request.Context(), c.Param("id"), input.Owner)
			} else {
				v, e = s.Stop(c.Request.Context(), c.Param("id"), input.Owner)
			}
			respond(c, v, e)
		})
	}
	g.GET("/:id/status", func(c *gin.Context) { v, e := s.Status(c.Request.Context(), c.Param("id")); respond(c, v, e) })
	g.GET("/:id/logs", func(c *gin.Context) {
		var after int64
		if raw := c.Query("after"); raw != "" {
			var e error
			after, e = strconv.ParseInt(raw, 10, 64)
			if e != nil || after < 0 {
				respond(c, nil, errors.New("after must be a nonnegative sequence"))
				return
			}
		}
		v, e := s.Logs(c.Request.Context(), c.Param("id"), after)
		respond(c, v, e)
	})
}
