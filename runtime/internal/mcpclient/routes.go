package mcpclient

import (
	"errors"
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
			c.JSON(code, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, v)
	}
	group.GET("", func(c *gin.Context) { v, e := s.List(); respond(c, v, e) })
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
