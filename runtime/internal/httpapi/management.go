package httpapi

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
)

// ManagementTools exposes the same v2 request model used by the Web workspace.
// There is no MCP-only API schema or legacy persistence path.
func (s *HTTPService) ManagementTools() []ManagementToolDef {
	return []ManagementToolDef{
		s.toolListCollections(),
		s.toolCreateCollection(),
		s.toolListRequests(),
		s.toolGetRequest(),
		s.toolCreateRequest(),
	}
}

func (s *HTTPService) toolListCollections() ManagementToolDef {
	return ManagementToolDef{
		Tool: mcp.NewTool("list_collections",
			mcp.WithDescription("List saved API collections."),
			mcp.WithString("project_id", mcp.Description("Project ID; defaults to the local project"))),
		Handle: func(_ context.Context, args map[string]any) (any, error) {
			return s.repo.listCollections(valueOr(inputString(args, "project_id"), defaultProjectID))
		},
	}
}

func (s *HTTPService) toolCreateCollection() ManagementToolDef {
	return ManagementToolDef{
		Tool: mcp.NewTool("create_collection",
			mcp.WithDescription("Create an API collection."),
			mcp.WithString("name", mcp.Required()),
			mcp.WithString("project_id"),
			mcp.WithString("description")),
		Handle: func(_ context.Context, args map[string]any) (any, error) {
			name := inputString(args, "name")
			if name == "" {
				return nil, fmt.Errorf("name is required")
			}
			item := &APICollection{Name: name, ProjectID: valueOr(inputString(args, "project_id"), defaultProjectID), Description: inputString(args, "description")}
			if err := s.repo.createCollection(item); err != nil {
				return nil, err
			}
			return item, nil
		},
	}
}

func (s *HTTPService) toolListRequests() ManagementToolDef {
	return ManagementToolDef{
		Tool: mcp.NewTool("list_requests", mcp.WithDescription("List saved executable requests in a collection."),
			mcp.WithString("collection_id", mcp.Required())),
		Handle: func(_ context.Context, args map[string]any) (any, error) {
			id := inputString(args, "collection_id")
			if id == "" {
				return nil, fmt.Errorf("collection_id is required")
			}
			return s.repo.listRequests(id)
		},
	}
}

func (s *HTTPService) toolGetRequest() ManagementToolDef {
	return ManagementToolDef{
		Tool: mcp.NewTool("get_request", mcp.WithDescription("Get one saved executable request."), mcp.WithString("request_id", mcp.Required())),
		Handle: func(_ context.Context, args map[string]any) (any, error) {
			id := inputString(args, "request_id")
			if id == "" {
				return nil, fmt.Errorf("request_id is required")
			}
			return s.repo.getRequest(id)
		},
	}
}

func (s *HTTPService) toolCreateRequest() ManagementToolDef {
	return ManagementToolDef{
		Tool: mcp.NewTool("create_request", mcp.WithDescription("Create a saved executable HTTP request."),
			mcp.WithString("collection_id", mcp.Required()), mcp.WithString("name", mcp.Required()),
			mcp.WithString("method", mcp.Required()), mcp.WithString("url", mcp.Required()),
			mcp.WithString("body")),
		Handle: func(_ context.Context, args map[string]any) (any, error) {
			item := &APIRequest{CollectionID: inputString(args, "collection_id"), Name: inputString(args, "name"), SourceType: "manual",
				Request: RequestData{Method: inputString(args, "method"), URL: inputString(args, "url"), Body: inputString(args, "body")}}
			if item.CollectionID == "" || item.Name == "" || item.Request.Method == "" || item.Request.URL == "" {
				return nil, fmt.Errorf("collection_id, name, method and url are required")
			}
			if err := s.repo.createRequest(item); err != nil {
				return nil, err
			}
			return item, nil
		},
	}
}
