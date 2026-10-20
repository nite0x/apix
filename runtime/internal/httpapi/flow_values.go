package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/apix/apix/runtime/internal/core"
	"github.com/apix/apix/runtime/internal/database"
)

var (
	flowPlaceholder      = regexp.MustCompile(`\{\{([^{}]+)\}\}`)
	flowOutputKey        = regexp.MustCompile(`^steps\.([^{}\s.]+)\.outputs\.([A-Za-z_][A-Za-z0-9_]*)$`)
	errFlowInput         = errors.New("flow input unavailable")
	errFlowOutputMissing = errors.New("step output unavailable")
	errFlowExtraction    = errors.New("output extraction failed")
)

// Qualified outputs are kept separate from legacy/global variables, so an
// environment value cannot impersonate a missing result from another step.
type flowOutput struct {
	Value  any
	Secret bool
}
type flowOutputs map[string]flowOutput

func flowStepStrings(step FlowStep) []string {
	values := []string{}
	if step.Type == "http" || step.Type == "" {
		values = append(values, step.Request.URL, step.Request.Body)
		for _, pair := range step.Request.Headers {
			if pair.Enabled {
				values = append(values, pair.Value)
			}
		}
		for _, pair := range step.Request.QueryParams {
			if pair.Enabled {
				values = append(values, pair.Value)
			}
		}
		for _, value := range step.Request.AuthConfig {
			if text, ok := value.(string); ok {
				values = append(values, text)
			}
		}
	}
	if step.SQL != nil {
		for _, value := range step.SQL.Params {
			if text, ok := value.(string); ok {
				values = append(values, text)
			}
		}
	}
	for _, assertion := range step.Config.Assertions {
		if assertion.Operator != "exists" {
			values = append(values, assertion.Expected)
		}
	}
	return values
}

func validateFlowReferences(steps []FlowStep) error {
	previous := map[string]FlowStep{}
	for _, step := range steps {
		for _, text := range flowStepStrings(step) {
			for _, token := range flowPlaceholder.FindAllStringSubmatch(text, -1) {
				key := strings.TrimSpace(token[1])
				if !strings.HasPrefix(key, "steps.") {
					continue
				}
				ref := flowOutputKey.FindStringSubmatch(key)
				if ref == nil {
					return fmt.Errorf("step %q has invalid output reference %q", step.Name, key)
				}
				source, ok := previous[ref[1]]
				if !ok {
					return fmt.Errorf("step %q references a missing or later step %q", step.Name, ref[1])
				}
				if step.Enabled && !source.Enabled {
					return fmt.Errorf("step %q references disabled step %q", step.Name, source.Name)
				}
				found := false
				for _, extractor := range source.Config.Extractors {
					if extractor.Name == ref[2] {
						found = true
						break
					}
				}
				if !found {
					return fmt.Errorf("step %q references undefined output %q", step.Name, key)
				}
			}
		}
		if step.SQL != nil && strings.Contains(step.SQL.SQL, "{{steps.") {
			return fmt.Errorf("step %q must bind output references through SQL params", step.Name)
		}
		previous[step.ID] = step
	}
	return nil
}

func resolveFlowText(text string, outputs flowOutputs) (string, error) {
	var problem error
	resolved := flowPlaceholder.ReplaceAllStringFunc(text, func(token string) string {
		key := strings.TrimSpace(flowPlaceholder.FindStringSubmatch(token)[1])
		if !strings.HasPrefix(key, "steps.") {
			return token
		}
		if !flowOutputKey.MatchString(key) {
			problem = errors.Join(problem, fmt.Errorf("%w: invalid output reference", errFlowInput))
			return token
		}
		output, ok := outputs[key]
		if !ok {
			problem = errors.Join(problem, fmt.Errorf("%w: %w: %s", errFlowInput, errFlowOutputMissing, key))
			return token
		}
		value, _ := stringify(output.Value)
		return value
	})
	return resolved, problem
}

// Resolve into a copy: neither HTTP substitution nor SQL binding may mutate the
// immutable run definition or a different run's input slices/maps.
func resolveFlowStep(step FlowStep, outputs flowOutputs) (FlowStep, error) {
	raw, err := json.Marshal(step)
	if err != nil {
		return step, err
	}
	var copy FlowStep
	if err := json.Unmarshal(raw, &copy); err != nil {
		return step, err
	}
	resolve := func(value *string) error {
		resolved, err := resolveFlowText(*value, outputs)
		*value = resolved
		return err
	}
	if step.Type == "http" || step.Type == "" {
		if err := resolve(&copy.Request.URL); err != nil {
			return copy, err
		}
		if err := resolve(&copy.Request.Body); err != nil {
			return copy, err
		}
		for i := range copy.Request.Headers {
			if copy.Request.Headers[i].Enabled {
				if err := resolve(&copy.Request.Headers[i].Value); err != nil {
					return copy, err
				}
			}
		}
		for i := range copy.Request.QueryParams {
			if copy.Request.QueryParams[i].Enabled {
				if err := resolve(&copy.Request.QueryParams[i].Value); err != nil {
					return copy, err
				}
			}
		}
		for key, value := range copy.Request.AuthConfig {
			if text, ok := value.(string); ok {
				resolved, err := resolveFlowText(text, outputs)
				if err != nil {
					return copy, err
				}
				copy.Request.AuthConfig[key] = resolved
			}
		}
	}
	if copy.SQL != nil {
		for i, value := range copy.SQL.Params {
			text, ok := value.(string)
			if !ok {
				continue
			}
			tokens := flowPlaceholder.FindAllStringSubmatch(text, -1)
			if len(tokens) == 1 && tokens[0][0] == text && strings.HasPrefix(strings.TrimSpace(tokens[0][1]), "steps.") {
				key := strings.TrimSpace(tokens[0][1])
				if _, err := resolveFlowText(text, outputs); err != nil {
					return copy, err
				}
				copy.SQL.Params[i] = outputs[key].Value
			} else {
				resolved, err := resolveFlowText(text, outputs)
				if err != nil {
					return copy, err
				}
				copy.SQL.Params[i] = resolved
			}
		}
	}
	for i := range copy.Config.Assertions {
		if copy.Config.Assertions[i].Operator != "exists" {
			if err := resolve(&copy.Config.Assertions[i].Expected); err != nil {
				return copy, err
			}
		}
	}
	return copy, nil
}

func flowContinues(config FlowStepConfig, settings FlowSettings) bool {
	switch config.FailurePolicy {
	case "stop":
		return false
	case "continue":
		return true
	default:
		return config.ContinueOnError || !settings.StopOnError
	}
}

func flowResultValue(source, path string, apiRun *APIRun, result any) (any, bool) {
	if apiRun != nil {
		value, found := extractValue(FlowExtractor{Source: source, Path: path}, apiRun)
		if source == "body" && apiRun.ResponseTruncated {
			return nil, false
		}
		return value, found
	}
	sqlResult, ok := result.(*database.Result)
	if !ok || sqlResult == nil {
		return nil, false
	}
	switch source {
	case "row_count":
		return sqlResult.RowCount, !sqlResult.Truncated
	case "rows_affected":
		return sqlResult.RowsAffected, true
	case "rows":
		parts := strings.Split(path, ".")
		// Reuse the existing dot-path lookup while retaining the SQL value type.
		var current any = sqlResult.Rows
		for _, part := range parts {
			switch node := current.(type) {
			case []map[string]any:
				index, err := strconv.Atoi(part)
				if err != nil || index < 0 || index >= len(node) {
					return nil, false
				}
				current = node[index]
			case map[string]any:
				value, exists := node[part]
				if !exists {
					return nil, false
				}
				current = value
			default:
				return nil, false
			}
		}
		return current, true
	}
	return nil, false
}

func evaluateFlowAssertions(definitions []FlowAssertion, apiRun *APIRun, result any) ([]AssertionResult, error) {
	checks := make([]AssertionResult, 0, len(definitions))
	var problem error
	for _, assertion := range definitions {
		actual, found := flowResultValue(assertion.Source, assertion.Path, apiRun, result)
		text, _ := stringify(actual)
		passed := false
		switch assertion.Operator {
		case "exists":
			passed = found
		case "equals":
			passed = found && text == assertion.Expected
		case "not_equals":
			passed = found && text != assertion.Expected
		case "contains":
			passed = found && strings.Contains(text, assertion.Expected)
		}
		var visible any
		if found {
			visible = redactTestAssertionValue(assertion.Source, assertion.Path, text)
		}
		checks = append(checks, AssertionResult{Kind: assertion.Source, Path: assertion.Path, Operator: assertion.Operator, Expected: redactTestAssertionValue(assertion.Source, assertion.Path, assertion.Expected), Actual: visible, Passed: passed})
		if !passed {
			problem = errors.Join(problem, fmt.Errorf("%w: %s %s %s", errFlowAssertion, assertion.Source, assertion.Path, assertion.Operator))
		}
	}
	return checks, problem
}

// Retain partial outputs for cleanup even when another required output is
// missing or a business assertion fails.
func captureFlowOutputs(step FlowStep, apiRun *APIRun, result any, vars *core.Variables, outputs flowOutputs, definitions []FlowVariableDefinition) ([]FlowExtractedVariable, error) {
	visible := []FlowExtractedVariable{}
	var problem error
	for _, extractor := range step.Config.Extractors {
		value, found := flowResultValue(extractor.Source, extractor.Path, apiRun, result)
		if !found {
			if extractor.Required {
				problem = errors.Join(problem, fmt.Errorf("%w: required output %q not found", errFlowExtraction, extractor.Name))
			}
			continue
		}
		text, _ := stringify(value)
		secret := extractor.Secret
		for _, def := range definitions {
			if def.Name == extractor.Name && def.Secret {
				secret = true
			}
		}
		outputs["steps."+step.ID+".outputs."+extractor.Name] = flowOutput{Value: value, Secret: secret}
		// Keep {{name}} behavior for existing flows.
		vars.Global[extractor.Name] = &core.Variable{Name: extractor.Name, Value: text, Scope: "run", Source: "extractor"}
		if secret {
			text = "••••••"
		}
		visible = append(visible, FlowExtractedVariable{Name: extractor.Name, Value: text, Secret: secret, Source: extractor.Source, Path: extractor.Path})
	}
	return visible, problem
}

func remapFlowReferences(step FlowStep, ids map[string]string) FlowStep {
	raw, _ := json.Marshal(step)
	text := string(raw)
	for oldID, newID := range ids {
		text = strings.ReplaceAll(text, "steps."+oldID+".outputs.", "steps."+newID+".outputs.")
	}
	var copy FlowStep
	_ = json.Unmarshal([]byte(text), &copy)
	return copy
}

func validFlowSource(kind string, sql *database.Command, source string) bool {
	if kind == "http" || kind == "" {
		return source == "body" || source == "header" || source == "status"
	}
	if kind != "sql" || sql == nil {
		return false
	}
	if sql.Mode == "query" {
		return source == "rows" || source == "row_count"
	}
	return source == "rows_affected"
}

func redactFlowMessage(message string, outputs flowOutputs) string {
	message = redactExecutionError(message)
	// Redact long values first when one secret is a prefix of another.
	secrets := []string{}
	for _, output := range outputs {
		if output.Secret {
			value, _ := stringify(output.Value)
			if value != "" {
				secrets = append(secrets, value)
			}
		}
	}
	sort.Slice(secrets, func(i, j int) bool { return len(secrets[i]) > len(secrets[j]) })
	for _, secret := range secrets {
		message = strings.ReplaceAll(message, secret, "••••••")
	}
	return message
}

func redactFlowEvidence(value any, outputs flowOutputs) any {
	if value == nil {
		return nil
	}
	// Copy evidence without changing structural metadata such as secret flags.
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var copy any
	if err := json.Unmarshal(raw, &copy); err != nil {
		return nil
	}
	var visit func(any) any
	visit = func(node any) any {
		switch item := node.(type) {
		case string:
			// This is evidence, not an error URL; preserve ordinary text.
			secrets := []string{}
			for _, output := range outputs {
				if output.Secret {
					text, _ := stringify(output.Value)
					if text != "" {
						secrets = append(secrets, text)
					}
				}
			}
			sort.Slice(secrets, func(i, j int) bool { return len(secrets[i]) > len(secrets[j]) })
			for _, secret := range secrets {
				item = strings.ReplaceAll(item, secret, "••••••")
			}
			return item
		case map[string]any:
			for key, child := range item {
				item[key] = visit(child)
			}
		case []any:
			for i, child := range item {
				item[i] = visit(child)
			}
		}
		return node
	}
	return visit(copy)
}

// Keep the executed SQL and typed parameters without persisting sensitive
// variables or changing the values sent to the database driver.
func flowSQLInputEvidence(command database.Command, template *database.Command, variables []FlowVariableDefinition, outputs flowOutputs) any {
	command.Params = append([]any(nil), command.Params...)
	if template != nil {
		for i, param := range template.Params {
			if i >= len(command.Params) {
				break
			}
			text, ok := param.(string)
			if !ok {
				continue
			}
			for _, token := range flowPlaceholder.FindAllStringSubmatch(text, -1) {
				name := strings.TrimSpace(token[1])
				secret := isSensitiveName(name) || outputs[name].Secret
				for key, output := range outputs {
					secret = secret || output.Secret && strings.HasSuffix(key, ".outputs."+name)
				}
				for _, variable := range variables {
					secret = secret || variable.Name == name && variable.Secret
				}
				if secret {
					command.Params[i] = "••••••"
					break
				}
			}
		}
	}
	return redactFlowEvidence(redactedJSONCopy(command), outputs)
}

func flowSQLEvidence(result any, extracted []FlowExtractedVariable) map[string]any {
	evidence, _ := redactedJSONCopy(result).(map[string]any)
	for _, variable := range extracted {
		if !variable.Secret {
			continue
		}
		if variable.Source != "rows" {
			evidence[variable.Source] = "••••••"
			continue
		}
		path := strings.Split(variable.Path, ".")
		var current any = evidence["rows"]
		for i, segment := range path {
			last := i == len(path)-1
			switch node := current.(type) {
			case []any:
				index, err := strconv.Atoi(segment)
				if err != nil || index < 0 || index >= len(node) {
					current = nil
					continue
				}
				if last {
					node[index] = "••••••"
				} else {
					current = node[index]
				}
			case map[string]any:
				if _, exists := node[segment]; !exists {
					current = nil
					continue
				}
				if last {
					node[segment] = "••••••"
				} else {
					current = node[segment]
				}
			default:
				current = nil
			}
		}
	}
	return evidence
}
