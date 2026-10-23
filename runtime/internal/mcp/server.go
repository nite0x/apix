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
	service.SetTestBatchFinished(func(batch *httpapi.TestBatch) {
		s.executor.CompleteSession(batch.ID, batch.Counts.Failed > 0 || batch.Counts.Errors > 0)
	})
	service.SetTestRunner(func(ctx context.Context, input map[string]any) (any, error) {
		batchID, _ := input["session_id"].(string)
		return s.executor.Execute(ctx, batchID, "API testing", "send_request", input)
	})
	for _, def := range service.ExecutionTools() {
		def := def // capture
		toolName := def.Tool.Name

		s.mcp.AddTool(def.Tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args, ok := req.Params.Arguments.(map[string]any)
			if !ok {
				return mcp.NewToolResultError("tool arguments must be an object"), nil
			}
			input, sessionID, task := def.ExtractInput(args)
			if args["batch_id"] != nil || args["case_name"] != nil || args["expected_status"] != nil || args["assertions"] != nil {
				batchID, _ := args["batch_id"].(string)
				result, err := service.RunInlineTest(ctx, args, func(ctx context.Context, input map[string]any) (any, error) {
					return s.executor.Execute(ctx, batchID, task, toolName, input)
				})
				if err != nil {
					return mcp.NewToolResultError(err.Error()), nil
				}
				return mcp.NewToolResultStructuredOnly(result), nil
			}
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

// HTTPHandler provides MCP framing for the private local IPC listener.
// The runtime stays independent from any individual stdio client.
func (s *Server) HTTPHandler() http.Handler {
	return s.http
}
