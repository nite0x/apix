package localservice

import (
	"context"
	"time"
)

type HealthCheck struct {
	Healthy   bool      `json:"healthy"`
	CheckedAt time.Time `json:"checked_at"`
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
	health := HealthCheck{Healthy: s.healthy(ctx, d.HealthURL), CheckedAt: time.Now().UTC()}
	logs, err := s.Logs(ctx, id, 0)
	if err != nil {
		return nil, err
	}
	if len(logs) > 100 {
		logs = logs[len(logs)-100:]
	}
	return &Details{Definition: d, Instance: instance, Health: health, Logs: logs}, nil
}
