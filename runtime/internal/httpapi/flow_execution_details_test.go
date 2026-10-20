package httpapi

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/apix/apix/runtime/internal/database"
)

func TestFlowSQLHistoryKeepsExecutedParametersOnSuccessAndFailure(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "failure"}[failed], func(t *testing.T) {
			s := newTestService(t)
			s.flow.database = flowSQLFunc(func(ctx context.Context, command database.Command) (*database.Result, error) {
				if !reflect.DeepEqual(command.Params, []any{"42", "private-value"}) {
					t.Fatalf("incorrect driver input: %#v", command.Params)
				}
				if failed {
					return nil, errors.New("query refused")
				}
				return &database.Result{Columns: []string{"id"}, Rows: []map[string]any{{"id": 42}}, RowCount: 1}, nil
			})
			flow := mustFlow(t, s)
			flow.Variables = []FlowVariableDefinition{{Name: "private_value", Secret: true}}
			flow.Steps = []FlowStep{{Type: "sql", Name: "query", Enabled: true, SQL: &database.Command{ConnectionID: "db", Mode: "query", SQL: "SELECT id FROM users WHERE id=? AND private_value=?", Params: []any{"{{id}}", "{{private_value}}"}}}}
			_, run := saveFlowRun(t, s, flow)
			s.flow.run(context.Background(), run.ID, map[string]string{"id": "42", "private_value": "private-value"})
			final := loadFinishedFlow(t, s, run.ID)
			if failed != (final.Status == "failed") {
				t.Fatalf("unexpected status: %s", final.Status)
			}
			input := final.Steps[0].SQLSnapshot
			if input.SQL != flow.Steps[0].SQL.SQL || !reflect.DeepEqual(input.Params, []any{"42", "••••••"}) {
				t.Fatalf("missing or unsafe SQL input: %#v", input)
			}
			if strings.Contains(string(mustJSON(t, final)), "private-value") {
				t.Fatal("secret SQL input leaked")
			}
			definition, _, err := s.repo.flowRunSnapshot(run.ID)
			if err != nil || definition.Steps[0].SQL.Params[0] != "{{id}}" {
				t.Fatal("executing changed the immutable definition", err)
			}
		})
	}
}
