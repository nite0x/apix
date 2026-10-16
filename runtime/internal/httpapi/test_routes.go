package httpapi

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/gin-gonic/gin"
)

func writeTestError(c *gin.Context, err error) {
	if errors.Is(err, errInvalidTest) {
		writeBadRequest(c, err)
		return
	}
	writeAPIError(c, err)
}

func (s *HTTPService) testRoutes(r gin.IRouter) {
	b := r.Group("/test-batches")
	b.GET("", func(c *gin.Context) {
		items, err := s.ListTestBatches(c.Query("project_id"))
		if err != nil {
			writeTestError(c, err)
			return
		}
		c.JSON(200, items)
	})
	b.POST("", func(c *gin.Context) {
		var in struct {
			ProjectID string `json:"project_id"`
			Name      string `json:"name"`
		}
		if err := c.ShouldBindJSON(&in); err != nil {
			writeBadRequest(c, err)
			return
		}
		item, err := s.BeginTestBatch(in.ProjectID, in.Name)
		if err != nil {
			writeTestError(c, err)
			return
		}
		c.JSON(201, item)
	})
	b.GET("/:id", func(c *gin.Context) {
		item, err := s.GetTestBatch(c.Param("id"))
		if err != nil {
			writeTestError(c, err)
			return
		}
		c.JSON(200, item)
	})
	b.POST("/:id/finish", func(c *gin.Context) {
		item, err := s.FinishTestBatch(c.Param("id"))
		if err != nil {
			writeTestError(c, err)
			return
		}
		c.JSON(200, item)
	})
	b.POST("/:id/runs", func(c *gin.Context) {
		var in RunTestInput
		if err := c.ShouldBindJSON(&in); err != nil {
			writeBadRequest(c, err)
			return
		}
		in.BatchID = c.Param("id")
		item, err := s.RunTest(c.Request.Context(), in, nil)
		if err != nil {
			writeTestError(c, err)
			return
		}
		c.JSON(200, item)
	})
	t := r.Group("/test-cases")
	t.GET("", func(c *gin.Context) {
		items, err := s.ListTestCases(c.Query("project_id"))
		if err != nil {
			writeTestError(c, err)
			return
		}
		c.JSON(200, items)
	})
	t.POST("", func(c *gin.Context) {
		var in TestCase
		if err := c.ShouldBindJSON(&in); err != nil {
			writeBadRequest(c, err)
			return
		}
		in.ID = ""
		item, err := s.SaveTestCase(in)
		if err != nil {
			writeTestError(c, err)
			return
		}
		c.JSON(201, item)
	})
	t.GET("/:id", func(c *gin.Context) {
		item, err := s.GetTestCase(c.Param("id"))
		if err != nil {
			writeTestError(c, err)
			return
		}
		c.JSON(200, item)
	})
	t.PUT("/:id", func(c *gin.Context) {
		var in TestCase
		if err := c.ShouldBindJSON(&in); err != nil {
			writeBadRequest(c, err)
			return
		}
		in.ID = c.Param("id")
		item, err := s.SaveTestCase(in)
		if err != nil {
			writeTestError(c, err)
			return
		}
		c.JSON(200, item)
	})
	t.DELETE("/:id", func(c *gin.Context) {
		if err := s.ArchiveTestCase(c.Param("id")); err != nil {
			writeTestError(c, err)
			return
		}
		c.Status(204)
	})
}

// RunInlineTest adapts send_request without adding another HTTP executor.
func (s *HTTPService) RunInlineTest(ctx context.Context, args map[string]any, runner func(context.Context, map[string]any) (any, error)) (*SendRequestResult, error) {
	data, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	var in struct {
		BatchID        string            `json:"batch_id"`
		SessionID      string            `json:"session_id"`
		CaseName       string            `json:"case_name"`
		Method         string            `json:"method"`
		URL            string            `json:"url"`
		Body           string            `json:"body"`
		Headers        map[string]string `json:"headers"`
		ExpectedStatus *int              `json:"expected_status"`
		Assertions     []FlowAssertion   `json:"assertions"`
	}
	if err := json.Unmarshal(data, &in); err != nil {
		return nil, invalidTest(err.Error())
	}
	if in.SessionID != "" && in.SessionID != in.BatchID {
		return nil, invalidTest("session_id must match batch_id when testing")
	}
	request := RequestData{Method: in.Method, URL: in.URL, Body: in.Body}
	for name, value := range in.Headers {
		request.Headers = append(request.Headers, KeyValue{Name: name, Value: value, Enabled: true})
	}
	return s.RunTest(ctx, RunTestInput{BatchID: in.BatchID, TestCase: &TestCase{Name: in.CaseName, Request: request, ExpectedStatus: in.ExpectedStatus, Assertions: in.Assertions}}, runner)
}
