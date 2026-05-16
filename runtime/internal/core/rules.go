package core

import (
	"path"
	"strconv"
	"strings"
	"sync"
)

type RuleEngine struct {
	mu    sync.RWMutex
	rules []*Rule
	store Store
}

func NewRuleEngine(store Store) *RuleEngine {
	re := &RuleEngine{store: store}
	re.rules = store.LoadRules()
	if len(re.rules) == 0 {
		re.loadDefaults()
	}
	return re
}

func (re *RuleEngine) loadDefaults() {
	defaults := []*Rule{
		{
			ID:      "r-delete",
			Name:    "Pause before DELETE",
			Enabled: true,
			Trigger: TriggerBefore,
			Match:   RuleMatch{Method: "DELETE"},
			Action:  "pause",
		},
	}
	re.rules = defaults
	re.store.SaveRules(defaults)
}

// CheckBefore checks rules before execution; returns matching rule or nil.
func (re *RuleEngine) CheckBefore(input map[string]any, env string) *Rule {
	re.mu.RLock()
	defer re.mu.RUnlock()

	for _, rule := range re.rules {
		if !rule.Enabled {
			continue
		}
		if rule.Trigger != TriggerBefore {
			continue
		}
		if re.matchHTTP(rule.Match, input, env) {
			return rule
		}
	}
	return nil
}

// CheckAfter checks rules after execution (e.g. 4xx responses).
func (re *RuleEngine) CheckAfter(output any) *Rule {
	re.mu.RLock()
	defer re.mu.RUnlock()

	for _, rule := range re.rules {
		if !rule.Enabled {
			continue
		}
		if rule.Trigger != TriggerAfter {
			continue
		}
		if rule.Match.StatusRange != "" {
			if status, ok := extractStatus(output); ok {
				if matchStatusRange(rule.Match.StatusRange, status) {
					return rule
				}
			}
		}
	}
	return nil
}

func (re *RuleEngine) GetRules() []*Rule {
	re.mu.RLock()
	defer re.mu.RUnlock()
	return re.rules
}

func (re *RuleEngine) UpdateRules(rules []*Rule) {
	re.mu.Lock()
	defer re.mu.Unlock()
	re.rules = rules
	re.store.SaveRules(rules)
}

func (re *RuleEngine) matchHTTP(match RuleMatch, input map[string]any, env string) bool {
	if match.Method != "" {
		method, _ := input["method"].(string)
		if !strings.EqualFold(match.Method, method) {
			return false
		}
	}
	if match.URLPattern != "" {
		url, _ := input["url"].(string)
		matched, _ := path.Match(match.URLPattern, url)
		if !matched {
			return false
		}
	}
	if match.Env != "" && match.Env != env {
		return false
	}
	return true
}

func extractStatus(output any) (int, bool) {
	if m, ok := output.(map[string]any); ok {
		if s, ok := m["status"]; ok {
			switch v := s.(type) {
			case int:
				return v, true
			case float64:
				return int(v), true
			case string:
				n, err := strconv.Atoi(v)
				if err == nil {
					return n, true
				}
			}
		}
	}
	return 0, false
}

func matchStatusRange(rangeStr string, status int) bool {
	switch rangeStr {
	case "4xx":
		return status >= 400 && status < 500
	case "5xx":
		return status >= 500 && status < 600
	case "2xx":
		return status >= 200 && status < 300
	}
	return false
}
