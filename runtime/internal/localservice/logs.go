package localservice

import (
	"context"
	"io"
	"log"
	"strings"
	"sync"
	"time"
)

// Logs are bounded per service and retain global sequence IDs across restarts.
func (s *Service) log(id, stream, message string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if len(message) > 8192 {
		message = message[:8192] + " [truncated]"
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO local_service_logs(service_id,time,stream,message) VALUES(?,?,?,?)`, id, time.Now().UTC().Format(time.RFC3339Nano), stream, message); err != nil {
		log.Printf("localservice: unable to store log for %s: %v", id, err)
		return
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM local_service_logs WHERE service_id=? AND sequence NOT IN (SELECT sequence FROM local_service_logs WHERE service_id=? ORDER BY sequence DESC LIMIT 2000)`, id, id)
	if err != nil {
		log.Printf("localservice: unable to bound logs for %s: %v", id, err)
	}
}
func (s *Service) Logs(ctx context.Context, id string, after int64) ([]LogLine, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT sequence,time,stream,message FROM local_service_logs WHERE service_id=? AND sequence>? ORDER BY sequence LIMIT 2000`, id, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []LogLine{}
	for rows.Next() {
		var line LogLine
		var timestamp string
		if err := rows.Scan(&line.Sequence, &timestamp, &line.Stream, &line.Message); err != nil {
			return nil, err
		}
		line.Time, err = time.Parse(time.RFC3339Nano, timestamp)
		if err != nil {
			return nil, err
		}
		result = append(result, line)
	}
	return result, rows.Err()
}

type logWriter struct {
	s          *Service
	id, stream string
	mu         sync.Mutex
	pending    string
}

func (w *logWriter) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.pending += string(data)
	for {
		index := strings.IndexByte(w.pending, '\n')
		if index < 0 {
			break
		}
		w.s.log(w.id, w.stream, strings.TrimSuffix(w.pending[:index], "\r"))
		w.pending = w.pending[index+1:]
	}
	if len(w.pending) >= 8192 {
		w.s.log(w.id, w.stream, w.pending)
		w.pending = ""
	}
	return len(data), nil
}

var _ io.Writer = (*logWriter)(nil)

func (w *logWriter) flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.pending != "" {
		w.s.log(w.id, w.stream, w.pending)
		w.pending = ""
	}
}
