package localservice

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type LogQuery struct {
	Source, Text, Level, After, Before string
	Limit, Offset                      int
}
type LogSource struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Archived bool   `json:"archived"`
	Deleted  bool   `json:"deleted"`
	Count    int    `json:"count"`
}
type StoredLog struct {
	LogLine
	ServiceID  string `json:"service_id"`
	SourceName string `json:"source_name"`
}

func (s *Service) LogSources(ctx context.Context) ([]LogSource, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT l.service_id,COALESCE(json_extract(d.data,'$.name'),m.name,l.service_id),COALESCE(m.archived,0),d.id IS NULL,count(*) FROM local_service_logs l LEFT JOIN local_service_definitions d ON d.id=l.service_id LEFT JOIN resource_lifecycle m ON m.kind='service' AND m.id=l.service_id GROUP BY l.service_id ORDER BY 2`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LogSource{}
	for rows.Next() {
		var v LogSource
		if err := rows.Scan(&v.ID, &v.Name, &v.Archived, &v.Deleted, &v.Count); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func logRange(q LogQuery) (string, []any, error) {
	where := "1=1"
	args := []any{}
	if q.Source != "" {
		where += " AND l.service_id=?"
		args = append(args, q.Source)
	}
	for _, field := range []struct{ value, op string }{{q.After, ">="}, {q.Before, "<="}} {
		if field.value != "" {
			if _, err := time.Parse(time.RFC3339Nano, field.value); err != nil {
				return "", nil, fmt.Errorf("时间需为 RFC3339 格式")
			}
			where += " AND julianday(l.time)" + field.op + "julianday(?)"
			args = append(args, field.value)
		}
	}
	if q.Text != "" {
		where += " AND instr(lower(l.message),lower(?))>0"
		args = append(args, q.Text)
	}
	if q.Level != "" {
		if q.Level != "stdout" && q.Level != "stderr" && q.Level != "manager" {
			return "", nil, fmt.Errorf("未知日志级别")
		}
		where += " AND l.stream=?"
		args = append(args, q.Level)
	}
	return where, args, nil
}
func (s *Service) QueryLogs(ctx context.Context, q LogQuery) ([]StoredLog, int, error) {
	where, args, err := logRange(q)
	if err != nil {
		return nil, 0, err
	}
	var count int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM local_service_logs l WHERE `+where, args...).Scan(&count); err != nil {
		return nil, 0, err
	}
	if q.Limit <= 0 || q.Limit > 200 {
		q.Limit = 100
	}
	if q.Offset < 0 {
		q.Offset = 0
	}
	args = append(args, q.Limit, q.Offset)
	rows, err := s.db.QueryContext(ctx, `SELECT l.sequence,l.time,l.stream,l.message,l.service_id,COALESCE(json_extract(d.data,'$.name'),m.name,l.service_id) FROM local_service_logs l LEFT JOIN local_service_definitions d ON d.id=l.service_id LEFT JOIN resource_lifecycle m ON m.kind='service' AND m.id=l.service_id WHERE `+where+` ORDER BY l.sequence DESC LIMIT ? OFFSET ?`, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []StoredLog{}
	for rows.Next() {
		var v StoredLog
		var timestamp string
		if err := rows.Scan(&v.Sequence, &timestamp, &v.Stream, &v.Message, &v.ServiceID, &v.SourceName); err != nil {
			return nil, 0, err
		}
		v.Time, err = time.Parse(time.RFC3339Nano, timestamp)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, v)
	}
	return out, count, rows.Err()
}
func (s *Service) logManagementRoutes(r gin.IRouter) {
	r.GET("/service-log-sources", func(c *gin.Context) {
		v, err := s.LogSources(c.Request.Context())
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, v)
	})
	r.GET("/service-logs", func(c *gin.Context) {
		q := LogQuery{Source: c.Query("source"), Text: c.Query("q"), Level: c.Query("level"), After: c.Query("after"), Before: c.Query("before")}
		q.Limit, _ = strconv.Atoi(c.Query("limit"))
		q.Offset, _ = strconv.Atoi(c.Query("offset"))
		v, total, err := s.QueryLogs(c.Request.Context(), q)
		if err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, gin.H{"items": v, "total": total, "per_service_limit": 2000, "message_limit_bytes": 8192})
	})
	r.POST("/service-logs/cleanup-preview", func(c *gin.Context) {
		var in struct {
			Source string `json:"source"`
			After  string `json:"after"`
			Before string `json:"before"`
		}
		if err := c.ShouldBindJSON(&in); err != nil || strings.TrimSpace(in.Source) == "" || in.Before == "" {
			c.JSON(400, gin.H{"error": "请选择日志来源和结束时间"})
			return
		}
		where, args, err := logRange(LogQuery{Source: in.Source, After: in.After, Before: in.Before})
		if err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		var count int
		var max int64
		if err := s.db.QueryRow(`SELECT count(*),COALESCE(max(sequence),0) FROM local_service_logs l WHERE `+where, args...).Scan(&count, &max); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		token := uuid.NewString()
		if _, err := s.db.Exec(`INSERT INTO log_cleanup_previews(token,source,after_time,before_time,max_sequence,expires_at) VALUES(?,?,?,?,?,?)`, token, in.Source, in.After, in.Before, max, time.Now().UTC().Add(10*time.Minute).Format(time.RFC3339Nano)); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, gin.H{"token": token, "count": count, "source": in.Source, "after": in.After, "before": in.Before})
	})
	r.POST("/service-logs/cleanup", func(c *gin.Context) {
		var in struct {
			Token string `json:"token"`
		}
		if err := c.ShouldBindJSON(&in); err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		var source, after, before, expires string
		var max int64
		tx, err := s.db.Begin()
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		defer tx.Rollback()
		if err := tx.QueryRow(`SELECT source,after_time,before_time,max_sequence,expires_at FROM log_cleanup_previews WHERE token=?`, in.Token).Scan(&source, &after, &before, &max, &expires); err != nil || expires < time.Now().UTC().Format(time.RFC3339Nano) {
			c.JSON(409, gin.H{"error": "清理预览不存在或已过期"})
			return
		}
		where, args, err := logRange(LogQuery{Source: source, After: after, Before: before})
		if err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		args = append(args, max)
		result, err := tx.Exec(`DELETE FROM local_service_logs AS l WHERE `+where+` AND l.sequence<=?`, args...)
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		if _, err := tx.Exec(`DELETE FROM log_cleanup_previews WHERE token=?`, in.Token); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		if err := tx.Commit(); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		n, _ := result.RowsAffected()
		c.JSON(200, gin.H{"deleted": n})
	})
}
