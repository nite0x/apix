package mcpclient

import (
	"errors"
	"github.com/apix/apix/runtime/internal/lifecycle"
	"github.com/gin-gonic/gin"
)

func (s *Service) Routes(r gin.IRouter) {
	group := r.Group("/mcp-servers")
	respond := func(c *gin.Context, v any, err error) {
		if err != nil {
			code := 400
			if errors.Is(err, ErrNotFound) {
				code = 404
			}
			if errors.Is(err, ErrConflict) {
				code = 409
			}
			if errors.Is(err, lifecycle.ErrProtected) {
				code = 409
			}
			c.JSON(code, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, v)
	}
	group.GET("", func(c *gin.Context) { v, e := s.ListArchived(c.Query("archived") == "true"); respond(c, v, e) })
	group.GET("/:id", func(c *gin.Context) { v, e := s.loadAny(c.Param("id"), false, true); respond(c, v, e) })
	group.POST("/:id/restore", func(c *gin.Context) {
		var in struct {
			Name string `json:"name"`
		}
		if c.Request.ContentLength > 0 {
			if err := c.ShouldBindJSON(&in); err != nil {
				respond(c, nil, err)
				return
			}
		}
		v, e := s.Restore(c.Request.Context(), c.Param("id"), in.Name)
		respond(c, v, e)
	})
	group.POST("/:id/archive", func(c *gin.Context) {
		if err := s.Archive(c.Param("id")); err != nil {
			respond(c, nil, err)
			return
		}
		c.Status(204)
	})
	group.POST("", func(c *gin.Context) {
		var in Server
		if e := c.ShouldBindJSON(&in); e != nil {
			respond(c, nil, errors.New("连接配置无效"))
			return
		}
		in.ID = ""
		v, e := s.Save(in)
		respond(c, v, e)
	})
	group.PUT("/:id", func(c *gin.Context) {
		var in Server
		if e := c.ShouldBindJSON(&in); e != nil {
			respond(c, nil, errors.New("连接配置无效"))
			return
		}
		in.ID = c.Param("id")
		v, e := s.Save(in)
		respond(c, v, e)
	})
	group.DELETE("/:id", func(c *gin.Context) {
		if e := s.Archive(c.Param("id")); e != nil {
			respond(c, nil, e)
			return
		}
		c.Status(204)
	})
	group.POST("/:id/discover", func(c *gin.Context) { v, e := s.Discover(c.Request.Context(), c.Param("id")); respond(c, v, e) })
}
