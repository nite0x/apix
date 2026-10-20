package httpapi

import (
	"errors"
	"github.com/apix/apix/runtime/internal/lifecycle"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

func (s *HTTPService) flowRoutes(r gin.IRouter) {
	g := r.Group("/flows")

	g.GET("", func(c *gin.Context) {
		includeArchived := c.Query("include_archived") == "true"
		items, err := s.repo.listFlowSummaries(valueOr(c.Query("project_id"), defaultProjectID), includeArchived)
		if err != nil {
			writeFlowError(c, s, "", err)
			return
		}
		c.JSON(http.StatusOK, items)
	})

	g.POST("", func(c *gin.Context) {
		var body struct {
			ProjectID string `json:"project_id"`
			Name      string `json:"name"`
		}
		_ = c.ShouldBindJSON(&body)
		flow, err := s.repo.createFlow(body.ProjectID, body.Name)
		if err != nil {
			writeFlowError(c, s, "", err)
			return
		}
		c.JSON(http.StatusCreated, flow)
	})

	g.GET("/:id", func(c *gin.Context) {
		flow, err := s.repo.getFlow(c.Param("id"))
		if err != nil {
			writeFlowError(c, s, c.Param("id"), err)
			return
		}
		c.JSON(http.StatusOK, flow)
	})

	g.PUT("/:id", func(c *gin.Context) {
		var in Flow
		if err := c.ShouldBindJSON(&in); err != nil {
			writeBadRequest(c, err)
			return
		}
		in.ID = c.Param("id")
		if in.EditVersion < 1 {
			writeBadRequest(c, errors.New("edit_version is required"))
			return
		}
		flow, err := s.repo.updateFlow(&in, in.EditVersion)
		if err != nil {
			writeFlowError(c, s, in.ID, err)
			return
		}
		c.JSON(http.StatusOK, flow)
	})

	g.PATCH("/:id", func(c *gin.Context) {
		var body struct {
			Name          *string `json:"name"`
			Description   *string `json:"description"`
			EnvironmentID *string `json:"environment_id"`
			HasEnv        bool    `json:"-"`
			EditVersion   int64   `json:"edit_version"`
		}
		raw := map[string]any{}
		if err := c.ShouldBindJSON(&raw); err != nil {
			writeBadRequest(c, err)
			return
		}
		// Re-bind typed fields (ShouldBindJSON consumes the body once).
		if v, ok := raw["name"].(string); ok {
			body.Name = &v
		}
		if v, ok := raw["description"].(string); ok {
			body.Description = &v
		}
		var envPtr **string
		if _, present := raw["environment_id"]; present {
			var env *string
			if v, ok := raw["environment_id"].(string); ok && v != "" {
				env = &v
			}
			envPtr = &env
		}
		if v, ok := raw["edit_version"].(float64); ok {
			body.EditVersion = int64(v)
		}
		if body.EditVersion < 1 {
			writeBadRequest(c, errors.New("edit_version is required"))
			return
		}
		flow, err := s.repo.patchFlow(c.Param("id"), body.Name, body.Description, envPtr, body.EditVersion)
		if err != nil {
			writeFlowError(c, s, c.Param("id"), err)
			return
		}
		c.JSON(http.StatusOK, flow)
	})

	g.DELETE("/:id", func(c *gin.Context) {
		if err := s.repo.archiveFlow(c.Param("id")); err != nil {
			writeFlowError(c, s, c.Param("id"), err)
			return
		}
		c.Status(http.StatusNoContent)
	})

	g.POST("/:id/restore", func(c *gin.Context) {
		var in struct {
			Name string `json:"name"`
		}
		if c.Request.ContentLength > 0 {
			if err := c.ShouldBindJSON(&in); err != nil {
				writeBadRequest(c, err)
				return
			}
		}
		summary, err := s.repo.restoreFlowAs(c.Param("id"), in.Name)
		if err != nil {
			writeFlowError(c, s, c.Param("id"), err)
			return
		}
		c.JSON(http.StatusOK, summary)
	})

	g.POST("/:id/duplicate", func(c *gin.Context) {
		flow, err := s.repo.duplicateFlow(c.Param("id"))
		if err != nil {
			writeFlowError(c, s, c.Param("id"), err)
			return
		}
		c.JSON(http.StatusCreated, flow)
	})

	// Flow-scoped run endpoints.
	g.POST("/:id/runs", func(c *gin.Context) {
		var body struct {
			ExpectedFlowVersion int64             `json:"expected_flow_version"`
			EnvironmentID       string            `json:"environment_id"`
			Variables           map[string]string `json:"variables"`
		}
		if c.Request.ContentLength != 0 {
			if err := c.ShouldBindJSON(&body); err != nil {
				writeBadRequest(c, err)
				return
			}
		}
		run, err := s.startFlow(c.Param("id"), body.ExpectedFlowVersion, body.EnvironmentID, body.Variables, "manual")
		if err != nil {
			writeFlowError(c, s, c.Param("id"), err)
			return
		}
		c.JSON(http.StatusAccepted, run)
	})

	g.GET("/:id/runs", func(c *gin.Context) {
		limit, _ := strconv.Atoi(c.Query("limit"))
		items, err := s.repo.listFlowRuns(c.Param("id"), limit)
		if err != nil {
			writeFlowError(c, s, c.Param("id"), err)
			return
		}
		c.JSON(http.StatusOK, items)
	})
}

func (s *HTTPService) flowRunRoutes(r gin.IRouter) {
	g := r.Group("/flow-runs")

	g.GET("/:id", func(c *gin.Context) {
		run, err := s.repo.getFlowRun(c.Param("id"))
		if err != nil {
			writeFlowError(c, s, "", err)
			return
		}
		c.JSON(http.StatusOK, run)
	})

	g.POST("/:id/cancel", func(c *gin.Context) {
		if err := s.flow.Cancel(c.Param("id")); err != nil {
			writeFlowError(c, s, "", err)
			return
		}
		run, err := s.repo.getFlowRun(c.Param("id"))
		if err != nil {
			writeFlowError(c, s, "", err)
			return
		}
		c.JSON(http.StatusOK, run)
	})

	g.POST("/:id/steps/:stepRunId/resume", func(c *gin.Context) {
		var body struct {
			Action string `json:"action"`
		}
		_ = c.ShouldBindJSON(&body)
		if err := s.flow.Resume(c.Param("stepRunId"), body.Action); err != nil {
			writeBadRequest(c, err)
			return
		}
		run, err := s.repo.getFlowRun(c.Param("id"))
		if err != nil {
			writeFlowError(c, s, "", err)
			return
		}
		c.JSON(http.StatusOK, run)
	})
}

// redactRunVariables strips secret variable values from the snapshot persisted
// with the run. Real values remain in memory for substitution only.
func redactRunVariables(defs []FlowVariableDefinition, input map[string]string) map[string]any {
	secret := map[string]bool{}
	for _, d := range defs {
		if d.Secret {
			secret[d.Name] = true
		}
	}
	out := map[string]any{}
	for name, value := range input {
		if secret[name] {
			out[name] = "••••••"
		} else {
			out[name] = value
		}
	}
	return out
}

func writeFlowConflict(c *gin.Context, s *HTTPService, flowID string) {
	summary, err := s.repo.flowSummary(flowID)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "flow version conflict"})
		return
	}
	c.JSON(http.StatusConflict, gin.H{
		"error": "flow version conflict",
		"current": gin.H{
			"id":           summary.ID,
			"edit_version": summary.EditVersion,
			"updated_at":   summary.UpdatedAt,
		},
	})
}

func writeFlowError(c *gin.Context, s *HTTPService, flowID string, err error) {
	switch {
	case errors.Is(err, lifecycle.ErrProtected):
		c.JSON(409, gin.H{"error": err.Error()})
	case errors.Is(err, errNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
	case errors.Is(err, errConflict):
		if flowID != "" && err.Error() == errConflict.Error() {
			writeFlowConflict(c, s, flowID)
			return
		}
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
	case errors.Is(err, errNoRunnableStep):
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
	case errors.Is(err, errValidation):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	}
}
