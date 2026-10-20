package mcp

import (
	"context"
	"time"

	"github.com/apix/apix/runtime/internal/httpapi"
)

func (s *Server) registerLifecycleTools(http *httpapi.HTTPService) {
	add := func(name, description string, schema map[string]any, handler toolHandler) {
		s.addCapability(name, description, schema, nil, false, handler)
	}
	kind := enum("service", "database", "mcp", "request", "collection", "test_case", "flow")
	resource := object(map[string]any{"kind": kind, "id": str()}, "kind", "id")
	operation := object(map[string]any{"kind": kind, "id": str(), "action": enum("archive", "restore", "duplicate", "detach_sources", "purge"), "name": str(), "collection_id": str(), "token": str()}, "kind", "id", "action")
	add("list_resource_lifecycle", "List active or archived resources by kind. Archived resources retain their original IDs and history.", object(map[string]any{"kind": kind, "project_id": str(), "archived": boolean()}, "kind"), func(ctx context.Context, a map[string]any) (any, error) {
		archived, _ := a["archived"].(bool)
		items, err := http.LifecycleResources(textArg(a, "kind"), textArg(a, "project_id"), archived)
		return map[string]any{"items": items}, err
	})
	add("apply_resource_lifecycle", "Apply 1–100 explicit lifecycle operations and report every result. Process references before archiving/purging. Purge requires a matching unexpired token from preview_resource_purge. detach_sources explicitly preserves request copies and detaches their provenance links.", object(map[string]any{"items": array(operation)}, "items"), func(ctx context.Context, a map[string]any) (any, error) {
		var in struct {
			Items []httpapi.LifecycleOperation `json:"items"`
		}
		if err := decode(a, &in); err != nil {
			return nil, err
		}
		items, err := http.BatchLifecycle(ctx, in.Items)
		return map[string]any{"items": items}, err
	})
	add("preview_resource_purge", "Preview permanent deletion of one archived configuration. Refuses running use and all unhandled definition references, including archived definitions. Execution history and logs are preserved.", resource, func(ctx context.Context, a map[string]any) (any, error) {
		return http.PreviewPurge(textArg(a, "kind"), textArg(a, "id"))
	})
	add("list_execution_records", "Search all execution batches with filters and pagination. Hidden records can be listed explicitly and remain readable.", object(map[string]any{"q": str(), "type": enum("collection", "flow"), "execution_type": enum("http", "sql", "mcp", "command", "service"), "status": enum("running", "completed", "interrupted"), "after": str(), "before": str(), "hidden": boolean(), "offset": integer(), "limit": integer()}), func(ctx context.Context, a map[string]any) (any, error) {
		hidden, _ := a["hidden"].(bool)
		offset, err := numberArg(a, "offset")
		if err != nil {
			return nil, err
		}
		limit, err := numberArg(a, "limit")
		if err != nil {
			return nil, err
		}
		return http.ListRecords("", httpapi.RecordQuery{Hidden: hidden, Query: textArg(a, "q"), Type: textArg(a, "type"), ExecutionType: textArg(a, "execution_type"), Status: textArg(a, "status"), After: textArg(a, "after"), Before: textArg(a, "before"), Offset: int(offset), Limit: int(limit)})
	})
	add("set_execution_record_state", "Pin/unpin a whole batch or hide/restore a completed batch. Hiding does not delete data.", object(map[string]any{"id": str(), "hidden": boolean(), "is_pinned": boolean()}, "id"), func(ctx context.Context, a map[string]any) (any, error) {
		var hidden, pinned *bool
		if v, ok := a["hidden"].(bool); ok {
			hidden = &v
		}
		if v, ok := a["is_pinned"].(bool); ok {
			pinned = &v
		}
		err := http.SetRecordState(textArg(a, "id"), hidden, pinned)
		return map[string]any{"updated": err == nil}, err
	})
	add("preview_execution_cleanup", "Preview permanent cleanup of a complete finished batch and associated HTTP/SQL details. Pinned or running records are protected.", object(map[string]any{"id": str()}, "id"), func(ctx context.Context, a map[string]any) (any, error) { return http.PreviewCleanup(textArg(a, "id")) })
	add("cleanup_execution_records", "Permanently clean the exact group from a prior preview. Revalidates all protections; a token is single-use and expires after 10 minutes.", object(map[string]any{"token": str()}, "token"), func(ctx context.Context, a map[string]any) (any, error) {
		err := http.CleanupRecord(textArg(a, "token"))
		return map[string]any{"cleaned": err == nil}, err
	})
	add("get_retention_policy", "Read the opt-in retention policy and latest run report. Automatic cleanup is disabled by default.", object(map[string]any{}), func(ctx context.Context, a map[string]any) (any, error) { return http.GetRetentionPolicy() })
	add("preview_retention_policy", "Preview eligible and protected complete batches before enabling automatic retention. Does not delete anything.", object(map[string]any{"days": integer()}, "days"), func(ctx context.Context, a map[string]any) (any, error) {
		days, err := numberArg(a, "days")
		if err != nil {
			return nil, err
		}
		return http.PreviewRetention(int(days), time.Now())
	})
	add("set_retention_policy", "Save an explicit retention choice. Enable only when the user has selected automatic deletion. Saving does not immediately delete data; the hourly worker revalidates all protections.", object(map[string]any{"enabled": boolean(), "days": integer()}, "enabled", "days"), func(ctx context.Context, a map[string]any) (any, error) {
		enabled, _ := a["enabled"].(bool)
		days, err := numberArg(a, "days")
		if err != nil {
			return nil, err
		}
		return http.SetRetentionPolicy(enabled, int(days))
	})
}
