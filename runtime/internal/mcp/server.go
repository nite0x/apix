package mcp

import (
	"context"
	"encoding/json"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/apix/apix/runtime/internal/core"
	"github.com/apix/apix/runtime/internal/httpapi"
)

type Server struct {
	executor *core.Executor
	mcp      *server.MCPServer
}

func NewServer(executor *core.Executor) *Server {
	return &Server{
		executor: executor,
		mcp: server.NewMCPServer(
			"apix",
			"0.1.0",
			server.WithToolCapabilities(true),
		),
	}
}

// RegisterHTTPTools wires the HTTP execution and management tools into MCP.
func (s *Server) RegisterHTTPTools(service *httpapi.HTTPService) {
	for _, def := range service.ExecutionTools() {
		def := def // capture
		toolName := def.Tool.Name

		s.mcp.AddTool(def.Tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			input, sessionID, task := def.ExtractInput(req.Params.Arguments)
			if sessionID == "" {
				sessionID = "session-" + generateID()
			}

			output, err := s.executor.Execute(ctx, sessionID, task, toolName, input)
			if err != nil {
				return mcp.NewToolResultText("error: " + err.Error()), nil
			}
			result, _ := json.Marshal(output)
			return mcp.NewToolResultText(string(result)), nil
		})
	}

	for _, def := range service.ManagementTools() {
		def := def // capture

		s.mcp.AddTool(def.Tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			result, err := def.Handle(ctx, req.Params.Arguments)
			if err != nil {
				return mcp.NewToolResultText("error: " + err.Error()), nil
			}
			data, _ := json.Marshal(result)
			return mcp.NewToolResultText(string(data)), nil
		})
	}
}

func (s *Server) ServeStdio(ctx context.Context) error {
	return server.ServeStdio(s.mcp)
}
