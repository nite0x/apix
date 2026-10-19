package httpapi

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/apix/apix/runtime/internal/core"
	"github.com/apix/apix/runtime/internal/database"
)

var errFlowAssertion = errors.New("assertion failed")

func (fs *flowService) executeStep(ctx context.Context, run *FlowRun, step *FlowRunStep, config FlowStepConfig, vars *core.Variables) (*APIRun, any, []AssertionResult, error) {
	switch step.Type {
	case "", "http":
		envID := ""
		if run.EnvironmentID != nil {
			envID = *run.EnvironmentID
		}
		request := step.RequestSnapshot
		// The per-step context owns the timeout, including values above the
		// standalone HTTP client's 60-second default.
		executor := *fs.exec
		client := *fs.exec.client
		client.Timeout = 0
		executor.client = &client
		apiRun, err := executor.Run(ctx, RunCommand{
			ProjectID: run.ProjectID, EnvironmentID: envID, SessionID: run.ID, StepID: step.ID,
			TriggerType: run.TriggerType, InlineRequest: &request,
		}, vars)
		var assertions []AssertionResult
		if err == nil && config.ExpectedStatus != nil {
			var actual any
			passed := apiRun != nil && apiRun.ResponseStatus != nil && *apiRun.ResponseStatus == *config.ExpectedStatus
			if apiRun != nil && apiRun.ResponseStatus != nil {
				actual = *apiRun.ResponseStatus
			}
			assertions = append(assertions, AssertionResult{Kind: "http_status", Expected: *config.ExpectedStatus, Actual: actual, Passed: passed})
			if !passed {
				err = fmt.Errorf("%w: expected HTTP status %d, actual %v", errFlowAssertion, *config.ExpectedStatus, actual)
			}
		}
		if apiRun != nil && apiRun.Status == "succeeded" {
			checks, checkErr := evaluateFlowAssertions(config.Assertions, apiRun, nil)
			assertions = append(assertions, checks...)
			err = errors.Join(err, checkErr)
		}
		// Full response remains in the existing API run; avoid duplicating it.
		return apiRun, nil, assertions, err
	case "sql":
		if fs.database == nil {
			return nil, nil, nil, fmt.Errorf("database capability is not configured")
		}
		if step.SQLSnapshot == nil {
			return nil, nil, nil, fmt.Errorf("missing SQL step snapshot")
		}
		command, err := resolveSQLParameters(*step.SQLSnapshot, vars)
		if err != nil {
			return nil, nil, nil, err
		}
		result, err := fs.database.Execute(ctx, command)
		var assertions []AssertionResult
		if err == nil && config.ExpectedRows != nil {
			passed := result != nil && !result.Truncated && result.RowCount == *config.ExpectedRows
			var actual any
			if result != nil {
				actual = result.RowCount
			}
			assertions = append(assertions, AssertionResult{Kind: "sql_rows", Expected: *config.ExpectedRows, Actual: actual, Passed: passed})
			if !passed {
				if result != nil && result.Truncated {
					err = fmt.Errorf("%w: cannot assert row count: SQL result exceeded max_rows", errFlowAssertion)
				} else {
					err = fmt.Errorf("%w: expected SQL row count %d, actual %v", errFlowAssertion, *config.ExpectedRows, actual)
				}
			}
		}
		if result != nil && (err == nil || errors.Is(err, errFlowAssertion)) {
			checks, checkErr := evaluateFlowAssertions(config.Assertions, nil, result)
			assertions = append(assertions, checks...)
			err = errors.Join(err, checkErr)
		}
		if result == nil {
			return nil, nil, assertions, err
		}
		return nil, result, assertions, err
	case "service":
		if fs.services == nil {
			return nil, nil, nil, fmt.Errorf("service capability is not configured")
		}
		if step.ServiceSnapshot == nil {
			return nil, nil, nil, fmt.Errorf("missing service step snapshot")
		}
		command := step.ServiceSnapshot
		if command.Action == "start" {
			result, err := fs.services.Start(ctx, command.ServiceID, run.ID)
			return nil, result, nil, err
		}
		if command.Action == "stop" {
			result, err := fs.services.Stop(ctx, command.ServiceID, run.ID)
			return nil, result, nil, err
		}
		return nil, nil, nil, fmt.Errorf("unsupported service action %q", command.Action)
	default:
		return nil, nil, nil, fmt.Errorf("unsupported step type %q", step.Type)
	}
}

// Resolve only entire placeholder parameters; the SQL statement stays intact
// and the database driver binds values through positional placeholders.
func resolveSQLParameters(command database.Command, vars *core.Variables) (database.Command, error) {
	command.Params = append([]any(nil), command.Params...)
	for i, param := range command.Params {
		value, ok := param.(string)
		if !ok || !strings.HasPrefix(value, "{{") || !strings.HasSuffix(value, "}}") {
			continue
		}
		name := strings.TrimSpace(value[2 : len(value)-2])
		if !variableNameRe.MatchString(name) {
			return command, fmt.Errorf("invalid SQL variable parameter %q", value)
		}
		variable := vars.Session[name]
		if variable == nil {
			variable = vars.Global[name]
		}
		if variable == nil {
			return command, fmt.Errorf("SQL parameter variable %q is missing", name)
		}
		command.Params[i] = variable.Value
	}
	return command, nil
}
