package mcp

import (
	"context"
	"github.com/apix/apix/runtime/internal/journal"
	"github.com/apix/apix/runtime/internal/mcpclient"
)

// RegisterMCPClientTools exposes discovery; actual calls share run_test_case.
func (s *Server) RegisterMCPClientTools(client *mcpclient.Service, history *journal.Store) {
	s.addCapability("list_mcp_servers", "List configured external MCP test servers. Authentication headers are masked. Use run_test_case with type mcp for calls.", object(map[string]any{}), history, false, func(ctx context.Context, args map[string]any) (any, error) {
		items, err := client.List()
		return map[string]any{"items": items}, err
	})
	s.addCapability("discover_mcp_tools", "Connect to a configured external MCP server over Streamable HTTP and discover its tools and schemas. Does not invoke business tools.", object(map[string]any{"server_id": str()}, "server_id"), history, false, func(ctx context.Context, args map[string]any) (any, error) {
		return client.Discover(ctx, textArg(args, "server_id"))
	})
}
