// Package executionrecord carries explicit batch ownership across execution adapters.
package executionrecord

import "context"

type Finish func(result any, executionErr error) error
type Recorder func(context.Context, string, string, string, any) (Finish, error)
type skipKey struct{}
type batchKey struct{}
type projectKey struct{}

func Skip(ctx context.Context) context.Context { return context.WithValue(ctx, skipKey{}, true) }
func Skipped(ctx context.Context) bool         { v, _ := ctx.Value(skipKey{}).(bool); return v }
func WithBatch(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, batchKey{}, id)
}
func Batch(ctx context.Context) string { v, _ := ctx.Value(batchKey{}).(string); return v }

func WithProject(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, projectKey{}, id)
}
func Project(ctx context.Context) string { v, _ := ctx.Value(projectKey{}).(string); return v }
