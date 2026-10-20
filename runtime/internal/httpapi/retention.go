package httpapi

import (
	"context"
	"fmt"
	"time"

	"github.com/apix/apix/runtime/internal/lifecycle"
	"github.com/gin-gonic/gin"
)

type RetentionPolicy struct {
	Enabled    bool   `json:"enabled"`
	Days       int    `json:"days"`
	LastRun    string `json:"last_run,omitempty"`
	LastReport string `json:"last_report,omitempty"`
}
type RetentionCandidate struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Eligible    bool   `json:"eligible"`
	Reason      string `json:"reason,omitempty"`
	Runs        int    `json:"runs"`
	HTTPRecords int    `json:"http_records"`
	SQLRecords  int    `json:"sql_records"`
}
type RetentionPreview struct {
	Days      int                  `json:"days"`
	Before    time.Time            `json:"before"`
	Eligible  int                  `json:"eligible"`
	Protected int                  `json:"protected"`
	Items     []RetentionCandidate `json:"items"`
}
type RetentionReport struct {
	Enabled   bool              `json:"enabled"`
	Removed   int               `json:"removed"`
	Protected int               `json:"protected"`
	Items     []LifecycleResult `json:"items"`
}

func (s *HTTPService) initRetention() error {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS retention_policy(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,days INTEGER NOT NULL DEFAULT 30,last_run TEXT NOT NULL DEFAULT '',last_report TEXT NOT NULL DEFAULT '')`); err != nil {
		return err
	}
	_, err := s.db.Exec(`INSERT OR IGNORE INTO retention_policy(id,enabled,days) VALUES(1,0,30)`)
	return err
}
func (s *HTTPService) GetRetentionPolicy() (*RetentionPolicy, error) {
	v := &RetentionPolicy{}
	err := s.db.QueryRow(`SELECT enabled,days,last_run,last_report FROM retention_policy WHERE id=1`).Scan(&v.Enabled, &v.Days, &v.LastRun, &v.LastReport)
	return v, err
}
func (s *HTTPService) SetRetentionPolicy(enabled bool, days int) (*RetentionPolicy, error) {
	if days < 1 || days > 3650 {
		return nil, fmt.Errorf("%w: 保留天数需为 1–3650", errValidation)
	}
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	if _, err := s.db.Exec(`UPDATE retention_policy SET enabled=?,days=? WHERE id=1`, enabled, days); err != nil {
		return nil, err
	}
	return s.GetRetentionPolicy()
}
func (s *HTTPService) PreviewRetention(days int, now time.Time) (*RetentionPreview, error) {
	if days < 1 || days > 3650 {
		return nil, fmt.Errorf("%w: 保留天数需为 1–3650", errValidation)
	}
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	items, err := s.listAllTestBatches("")
	if err != nil {
		return nil, err
	}
	v := &RetentionPreview{Days: days, Before: now.UTC().Add(-time.Duration(days) * 24 * time.Hour), Items: []RetentionCandidate{}}
	for _, b := range items {
		at := b.CreatedAt
		if b.FinishedAt != nil {
			at = *b.FinishedAt
		}
		if !at.Before(v.Before) {
			continue
		}
		entry := RetentionCandidate{ID: b.ID, Name: b.Name, Runs: b.Counts.Total}
		p, _, err := s.planCleanup(b.ID)
		if err != nil {
			entry.Reason = err.Error()
			v.Protected++
		} else {
			entry.Eligible = true
			entry.HTTPRecords = len(p.API)
			entry.SQLRecords = len(p.SQL)
			v.Eligible++
		}
		v.Items = append(v.Items, entry)
	}
	return v, nil
}
func (s *HTTPService) cleanupForRetention(token string, days int) error {
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	policy, err := s.GetRetentionPolicy()
	if err != nil {
		return err
	}
	if !policy.Enabled || policy.Days != days {
		return fmt.Errorf("%w: 保留策略已停用或修改", lifecycle.ErrProtected)
	}
	return s.cleanupRecordLocked(token)
}
func (s *HTTPService) RunRetention(ctx context.Context, now time.Time) (*RetentionReport, error) {
	policy, err := s.GetRetentionPolicy()
	if err != nil {
		return nil, err
	}
	report := &RetentionReport{Enabled: policy.Enabled, Items: []LifecycleResult{}}
	if !policy.Enabled {
		return report, nil
	}
	preview, err := s.PreviewRetention(policy.Days, now)
	if err != nil {
		return nil, err
	}
	report.Protected = preview.Protected
	for _, item := range preview.Items {
		if !item.Eligible {
			continue
		}
		r := LifecycleResult{Kind: "execution_record", ID: item.ID, Action: "retention_cleanup", Status: "succeeded"}
		err := ctx.Err()
		if err == nil {
			var p *CleanupPreview
			p, err = s.PreviewCleanup(item.ID)
			if err == nil {
				err = s.cleanupForRetention(p.Token, policy.Days)
			}
		}
		if err != nil {
			r.Status = "failed"
			r.Error = err.Error()
			report.Protected++
		} else {
			report.Removed++
		}
		report.Items = append(report.Items, r)
	}
	_, err = s.db.Exec(`UPDATE retention_policy SET last_run=?,last_report=? WHERE id=1`, now.UTC().Format(time.RFC3339Nano), marshalJSON(report))
	return report, err
}

// The policy is opt-in and durable. Saving a policy never immediately deletes
// data; the worker checks it at startup and once per hour, revalidating each group.
func (s *HTTPService) RunRetentionWorker(ctx context.Context) {
	run := func() { _, _ = s.RunRetention(ctx, time.Now()) }
	run()
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}
func (s *HTTPService) retentionRoutes(r gin.IRouter) {
	r.GET("/retention-policy", func(c *gin.Context) {
		v, err := s.GetRetentionPolicy()
		if err != nil {
			writeAPIError(c, err)
			return
		}
		c.JSON(200, v)
	})
	r.PUT("/retention-policy", func(c *gin.Context) {
		var in struct {
			Enabled bool `json:"enabled"`
			Days    int  `json:"days"`
		}
		if err := c.ShouldBindJSON(&in); err != nil {
			writeBadRequest(c, err)
			return
		}
		v, err := s.SetRetentionPolicy(in.Enabled, in.Days)
		if err != nil {
			writeBadRequest(c, err)
			return
		}
		c.JSON(200, v)
	})
	r.POST("/retention-policy/preview", func(c *gin.Context) {
		var in struct {
			Days int `json:"days"`
		}
		if err := c.ShouldBindJSON(&in); err != nil {
			writeBadRequest(c, err)
			return
		}
		v, err := s.PreviewRetention(in.Days, time.Now())
		if err != nil {
			writeBadRequest(c, err)
			return
		}
		c.JSON(200, v)
	})
}
