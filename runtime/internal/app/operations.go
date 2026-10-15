package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/apix/apix/runtime/internal/journal"
	"github.com/gin-gonic/gin"
)

type recordedResponse struct {
	gin.ResponseWriter
	body      bytes.Buffer
	truncated bool
}

func (w *recordedResponse) Write(data []byte) (int, error) {
	if w.body.Len()+len(data) <= 256*1024 {
		_, _ = w.body.Write(data)
	} else {
		w.truncated = true
	}
	return w.ResponseWriter.Write(data)
}
func (w *recordedResponse) WriteString(data string) (int, error) { return w.Write([]byte(data)) }

func recordOperations(history *journal.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		path := c.Request.URL.Path
		tracked := c.Request.Method == "POST" && (path == "/api/database/execute" || strings.HasPrefix(path, "/api/services/") && (strings.HasSuffix(path, "/start") || strings.HasSuffix(path, "/stop")))
		if !tracked {
			c.Next()
			return
		}
		id, err := history.Begin(c.Request.Context(), c.Request.Method+" "+path)
		if err != nil {
			c.AbortWithStatusJSON(500, gin.H{"error": "cannot record operation"})
			return
		}
		c.Header("X-Apix-Operation-ID", id)
		writer := &recordedResponse{ResponseWriter: c.Writer}
		c.Writer = writer
		c.Next()
		var result any
		if writer.truncated {
			result = map[string]any{"truncated": true, "message": "response exceeded operation history limit"}
		} else if err := json.Unmarshal(writer.body.Bytes(), &result); err != nil {
			result = map[string]any{"http_status": writer.Status()}
		}
		var operationErr error
		if writer.Status() >= 400 {
			operationErr = fmt.Errorf("operation returned HTTP %d", writer.Status())
		}
		if err := history.Finish(id, result, operationErr); err != nil {
			history.Append("operation.recording_failed", id, "", nil)
		}
	}
}
