package executionenv

import (
	"context"
	"github.com/gin-gonic/gin"
	"time"
)

func Routes(r gin.IRouter) {
	r.GET("/execution-environments", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
		defer cancel()
		envs, err := Discover(ctx)
		warning := ""
		if err != nil {
			warning = err.Error()
		}
		c.JSON(200, gin.H{"items": envs, "warning": warning})
	})
	r.POST("/execution-environments/check", func(c *gin.Context) {
		var spec Spec
		if err := c.ShouldBindJSON(&spec); err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
		defer cancel()
		env, err := Check(ctx, spec)
		if err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, env)
	})
}
