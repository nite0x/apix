package httpapi

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/apix/apix/runtime/internal/core"
	"github.com/gin-gonic/gin"
)

// Routes exposes the v2 HTTP domain. It intentionally does not register any
// legacy /api/http routes.
func (s *HTTPService) Routes(r gin.IRouter) {
	s.collectionRoutes(r)
	s.requestRoutes(r)
	s.workingCopyRoutes(r)
	s.runRoutes(r)
	s.importRoutes(r)
}

func (s *HTTPService) collectionRoutes(r gin.IRouter) {
	g := r.Group("/collections")
	g.GET("", func(c *gin.Context) {
		projectID := valueOr(c.Query("project_id"), defaultProjectID)
		items, err := s.repo.listCollections(projectID)
		if err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, items)
	})
	g.POST("", func(c *gin.Context) {
		var item APICollection
		if err := c.ShouldBindJSON(&item); err != nil {
			writeBadRequest(c, err)
			return
		}
		if item.Name == "" {
			writeBadRequest(c, errors.New("name is required"))
			return
		}
		if err := s.repo.createCollection(&item); err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(http.StatusCreated, item)
	})
	g.PATCH("/:id", func(c *gin.Context) {
		var item APICollection
		if err := c.ShouldBindJSON(&item); err != nil {
			writeBadRequest(c, err)
			return
		}
		item.ID = c.Param("id")
		if item.Name == "" {
			writeBadRequest(c, errors.New("name is required"))
			return
		}
		if err := s.repo.updateCollection(&item); err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, item)
	})
	g.DELETE("/:id", func(c *gin.Context) {
		if err := s.repo.archiveCollection(c.Param("id")); err != nil {
			writeAPIError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	})
}

func (s *HTTPService) requestRoutes(r gin.IRouter) {
	g := r.Group("/requests")
	g.GET("", func(c *gin.Context) {
		collectionID := c.Query("collection_id")
		if collectionID == "" {
			writeBadRequest(c, errors.New("collection_id is required"))
			return
		}
		items, err := s.repo.listRequests(collectionID)
		if err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, items)
	})
	g.POST("", func(c *gin.Context) {
		var item APIRequest
		if err := c.ShouldBindJSON(&item); err != nil {
			writeBadRequest(c, err)
			return
		}
		if item.CollectionID == "" || item.Name == "" || item.Request.URL == "" {
			writeBadRequest(c, errors.New("collection_id, name and request.url are required"))
			return
		}
		if err := s.repo.createRequest(&item); err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(http.StatusCreated, item)
	})
	g.GET("/:id", func(c *gin.Context) {
		item, err := s.repo.getRequest(c.Param("id"))
		if err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, item)
	})
	g.PUT("/:id", func(c *gin.Context) {
		var item APIRequest
		if err := c.ShouldBindJSON(&item); err != nil {
			writeBadRequest(c, err)
			return
		}
		item.ID = c.Param("id")
		if item.CollectionID == "" || item.Name == "" || item.Request.URL == "" {
			writeBadRequest(c, errors.New("collection_id, name and request.url are required"))
			return
		}
		if err := s.repo.updateRequest(&item); err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, item)
	})
	g.DELETE("/:id", func(c *gin.Context) {
		if err := s.repo.archiveRequest(c.Param("id")); err != nil {
			writeAPIError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	})
}

func (s *HTTPService) workingCopyRoutes(r gin.IRouter) {
	g := r.Group("/working-copies")
	g.POST("", func(c *gin.Context) {
		var item APIWorkingCopy
		if err := c.ShouldBindJSON(&item); err != nil {
			writeBadRequest(c, err)
			return
		}
		if item.APIRequestID != nil && item.Request.URL == "" {
			request, err := s.repo.getRequest(*item.APIRequestID)
			if err != nil {
				writeAPIError(c, err)
				return
			}
			item.Request, item.Name = request.Request, request.Name
		}
		if err := s.repo.createWorkingCopy(&item); err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(http.StatusCreated, item)
	})
	g.GET("/:id", func(c *gin.Context) {
		item, err := s.repo.getWorkingCopy(c.Param("id"))
		if err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, item)
	})
	g.PUT("/:id", func(c *gin.Context) {
		var item APIWorkingCopy
		if err := c.ShouldBindJSON(&item); err != nil {
			writeBadRequest(c, err)
			return
		}
		item.ID = c.Param("id")
		if item.EditVersion < 1 {
			writeBadRequest(c, errors.New("edit_version is required"))
			return
		}
		if err := s.repo.updateWorkingCopy(&item, item.EditVersion); err != nil {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, item)
	})
	g.POST("/:id/save", func(c *gin.Context) {
		var body struct {
			CollectionID string `json:"collection_id"`
			Name         string `json:"name"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			writeBadRequest(c, err)
			return
		}
		item, err := s.repo.saveWorkingCopy(c.Param("id"), body.CollectionID, body.Name)
		if err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, item)
	})
	g.POST("/:id/discard", func(c *gin.Context) {
		if err := s.repo.discardWorkingCopy(c.Param("id")); err != nil {
			writeAPIError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	})
	// DELETE has the same explicit discard semantics; no hard delete is exposed.
	g.DELETE("/:id", func(c *gin.Context) {
		if err := s.repo.discardWorkingCopy(c.Param("id")); err != nil {
			writeAPIError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	})
}

func (s *HTTPService) runRoutes(r gin.IRouter) {
	g := r.Group("/runs")
	g.POST("", func(c *gin.Context) {
		var body struct {
			ProjectID     string `json:"project_id"`
			APIRequestID  string `json:"api_request_id"`
			WorkingCopyID string `json:"working_copy_id"`
			EnvironmentID string `json:"environment_id"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			writeBadRequest(c, err)
			return
		}
		if (body.APIRequestID == "") == (body.WorkingCopyID == "") {
			writeBadRequest(c, errors.New("provide exactly one of api_request_id or working_copy_id"))
			return
		}
		run, err := s.execution.Run(c.Request.Context(), RunCommand{ProjectID: body.ProjectID, APIRequestID: body.APIRequestID,
			WorkingCopyID: body.WorkingCopyID, EnvironmentID: body.EnvironmentID, TriggerType: "manual"}, core.NewVariables())
		if run == nil {
			writeAPIError(c, err)
			return
		}
		// A completed HTTP response is a successful run even for 4xx/5xx. Transport errors return 502 with the persisted run.
		if err != nil {
			c.JSON(http.StatusBadGateway, run)
			return
		}
		c.JSON(http.StatusCreated, run)
	})
	g.GET("", func(c *gin.Context) {
		limit, _ := strconv.Atoi(c.Query("limit"))
		items, err := s.repo.listRuns(valueOr(c.Query("project_id"), defaultProjectID), limit)
		if err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, items)
	})
	g.GET("/:id", func(c *gin.Context) {
		item, err := s.repo.getRun(c.Param("id"))
		if err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, item)
	})
	g.POST("/:id/pin", func(c *gin.Context) {
		var body struct {
			Pinned bool `json:"pinned"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			writeBadRequest(c, err)
			return
		}
		if err := s.repo.pinRun(c.Param("id"), body.Pinned); err != nil {
			writeAPIError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	})
	g.DELETE("/:id", func(c *gin.Context) {
		if err := s.repo.deleteRun(c.Param("id")); err != nil {
			writeAPIError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	})
}

func (s *HTTPService) importRoutes(r gin.IRouter) {
	r.POST("/import/curl", func(c *gin.Context) {
		var body struct {
			Content   string `json:"content" binding:"required"`
			ProjectID string `json:"project_id"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			writeBadRequest(c, err)
			return
		}
		parsed, err := ParseRequestText(body.Content)
		if err != nil {
			writeBadRequest(c, err)
			return
		}
		request := RequestData{Method: parsed.Method, URL: parsed.URL, Body: parsed.Body}
		if parsed.Body != "" {
			request.BodyType = "json"
		}
		for name, value := range parsed.Headers {
			request.Headers = append(request.Headers, KeyValue{Name: name, Value: value, Enabled: true})
		}
		item := APIWorkingCopy{ProjectID: valueOr(body.ProjectID, defaultProjectID), OwnerID: defaultOwnerID, SourceType: "curl_import", Request: request}
		if err := s.repo.createWorkingCopy(&item); err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(http.StatusCreated, item)
	})
}

func writeBadRequest(c *gin.Context, err error) {
	c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
}
func writeAPIError(c *gin.Context, err error) {
	if errors.Is(err, errNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
}
func valueOr(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
