package localservice

import (
	"context"
	"github.com/apix/apix/runtime/internal/executionenv"
	"time"
)

type HealthCheck struct {
	Healthy       bool      `json:"healthy"`
	Error         string    `json:"error,omitempty"`
	EnvironmentID string    `json:"environment_id,omitempty"`
	CheckedAt     time.Time `json:"checked_at"`
}

type Details struct {
	Definition Definition  `json:"definition"`
	Instance   *Instance   `json:"instance"`
	Health     HealthCheck `json:"health"`
	Logs       []LogLine   `json:"logs"`
}

func (s *Service) Details(ctx context.Context, id string) (*Details, error) {
	d, err := s.definition(ctx, id)
	if err != nil {
		return nil, err
	}
	instance, err := s.Status(ctx, id)
	if err != nil {
		return nil, err
	}
	h := executionenv.Health{Error: instance.EnvironmentError}
	if instance.EnvironmentError == "" {
		h = executionenv.Probe(ctx, d.EnvironmentID, d.HealthURL)
	}
	health := HealthCheck{Healthy: h.Healthy, Error: h.Error, EnvironmentID: d.EnvironmentID, CheckedAt: time.Now().UTC()}
	logs, err := s.Logs(ctx, id, 0)
	if err != nil {
		return nil, err
	}
	if len(logs) > 100 {
		logs = logs[len(logs)-100:]
	}
	return &Details{Definition: d, Instance: instance, Health: health, Logs: logs}, nil
}
