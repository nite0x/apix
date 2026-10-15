package mcp

import (
	"context"
	"net/http"

	"github.com/apix/apix/runtime/internal/core"
	"github.com/apix/apix/runtime/internal/httpapi"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

type Server struct {
	executor *core.Executor
	mcp      *server.MCPServer
	http     *server.StreamableHTTPServer
}

func NewServer(executor *core.Executor) *Server {
	mcpServer := server.NewMCPServer(
		"apix",
		"0.1.0",
		server.WithToolCapabilities(true),
	)
	return &Server{
		executor: executor,
		mcp:      mcpServer,
		http:     server.NewStreamableHTTPServer(mcpServer),
	}
}

// RegisterHTTPTools wires the HTTP execution and management tools into MCP.
func (s *Server) RegisterHTTPTools(service *httpapi.HTTPService) {
	for _, def := range service.ExecutionTools() {
		def := def // capture
		toolName := def.Tool.Name

		s.mcp.AddTool(def.Tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args, ok := req.Params.Arguments.(map[string]any)
			if !ok {
				return mcp.NewToolResultError("tool arguments must be an object"), nil
			}
			input, sessionID, task := def.ExtractInput(args)
			if sessionID == "" {
				sessionID = "session-" + generateID()
			}

			output, err := s.executor.Execute(ctx, sessionID, task, toolName, input)
			if err != nil {
				result := mcp.NewToolResultStructuredOnly(map[string]any{"error": err.Error(), "session_id": sessionID, "result": output})
				result.IsError = true
				return result, nil
			}
			return mcp.NewToolResultStructuredOnly(output), nil
		})
	}

	for _, def := range service.ManagementTools() {
		def := def // capture

		s.mcp.AddTool(def.Tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args, ok := req.Params.Arguments.(map[string]any)
			if !ok {
				return mcp.NewToolResultError("tool arguments must be an object"), nil
			}
			result, err := def.Handle(ctx, args)
			if err != nil {
				return mcp.NewToolResultError(err.Error()), nil
			}
			return mcp.NewToolResultStructuredOnly(result), nil
		})
	}
}

// HTTPHandler exposes the MCP server over the Streamable HTTP transport.
// Mount it on a single route that accepts POST, GET, and DELETE (normally
// /mcp). The Runtime stays independent from any individual AI client.
func (s *Server) HTTPHandler() http.Handler {
	return s.http
}
