package httpapi

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
)

type ExecutionToolDef struct {
	Tool         mcp.Tool
	ExtractInput func(args map[string]any) (input map[string]any, sessionID, task string)
}

type ManagementToolDef struct {
	Tool   mcp.Tool
	Handle func(ctx context.Context, args map[string]any) (any, error)
}
