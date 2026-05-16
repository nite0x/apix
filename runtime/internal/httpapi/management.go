package httpapi

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/mark3labs/mcp-go/mcp"
)

// ManagementTools declares all HTTP management tools in two groups:
//   - read tools that help Claude discover API definitions before send_request
//   - write tools used by Claude or the frontend to maintain the stored spec
func (s *HTTPService) ManagementTools() []ManagementToolDef {
	return []ManagementToolDef{
		// Read tools
		s.toolListProjects(),
		s.toolListCollections(),
		s.toolListAPIs(),
		s.toolGetAPI(),
		// Write tools
		s.toolCreateProject(),
		s.toolCreateCollection(),
		s.toolCreateAPI(),
	}
}

// Read tool implementations

func (s *HTTPService) toolListProjects() ManagementToolDef {
	return ManagementToolDef{
		Tool: mcp.NewTool("list_projects",
			mcp.WithDescription("List all projects. Call this first to get a project_id before listing collections or APIs."),
		),
		Handle: func(ctx context.Context, args map[string]any) (any, error) {
			if s.db == nil {
				return nil, fmt.Errorf("db not initialized")
			}
			rows, err := s.db.QueryContext(ctx,
				`SELECT id, name, description, created_at FROM projects ORDER BY created_at DESC`)
			if err != nil {
				return nil, err
			}
			defer rows.Close()

			type row struct {
				ID          string `json:"id"`
				Name        string `json:"name"`
				Description string `json:"description,omitempty"`
				CreatedAt   string `json:"created_at"`
			}
			var out []row
			for rows.Next() {
				var r row
				var desc sql.NullString
				if err := rows.Scan(&r.ID, &r.Name, &desc, &r.CreatedAt); err != nil {
					return nil, err
				}
				r.Description = desc.String
				out = append(out, r)
			}
			return out, nil
		},
	}
}

func (s *HTTPService) toolListCollections() ManagementToolDef {
	return ManagementToolDef{
		Tool: mcp.NewTool("list_collections",
			mcp.WithDescription("List all collections in a project."),
			mcp.WithString("project_id",
				mcp.Required(),
				mcp.Description("Project ID from list_projects"),
			),
		),
		Handle: func(ctx context.Context, args map[string]any) (any, error) {
			if s.db == nil {
				return nil, fmt.Errorf("db not initialized")
			}
			projectID, _ := args["project_id"].(string)
			if projectID == "" {
				return nil, fmt.Errorf("project_id is required")
			}

			rows, err := s.db.QueryContext(ctx,
				`SELECT id, name, description, sort_order
				 FROM collections WHERE project_id = ?
				 ORDER BY sort_order, created_at`, projectID)
			if err != nil {
				return nil, err
			}
			defer rows.Close()

			type row struct {
				ID          string `json:"id"`
				Name        string `json:"name"`
				Description string `json:"description,omitempty"`
				SortOrder   int    `json:"sort_order"`
			}
			var out []row
			for rows.Next() {
				var r row
				var desc sql.NullString
				if err := rows.Scan(&r.ID, &r.Name, &desc, &r.SortOrder); err != nil {
					return nil, err
				}
				r.Description = desc.String
				out = append(out, r)
			}
			return out, nil
		},
	}
}

func (s *HTTPService) toolListAPIs() ManagementToolDef {
	return ManagementToolDef{
		Tool: mcp.NewTool("list_apis",
			mcp.WithDescription(`List all APIs in a collection.
Returns method, path, name and risk for each API.
Use get_api to fetch full parameter and field definitions before calling send_request.`),
			mcp.WithString("collection_id",
				mcp.Required(),
				mcp.Description("Collection ID from list_collections"),
			),
		),
		Handle: func(ctx context.Context, args map[string]any) (any, error) {
			if s.db == nil {
				return nil, fmt.Errorf("db not initialized")
			}
			collectionID, _ := args["collection_id"].(string)
			if collectionID == "" {
				return nil, fmt.Errorf("collection_id is required")
			}

			rows, err := s.db.QueryContext(ctx,
				`SELECT id, name, method, path, description, risk, side_effect, need_confirmation
				 FROM apis WHERE collection_id = ?
				 ORDER BY method, path`, collectionID)
			if err != nil {
				return nil, err
			}
			defer rows.Close()

			type row struct {
				ID               string `json:"id"`
				Name             string `json:"name"`
				Method           string `json:"method"`
				Path             string `json:"path"`
				Description      string `json:"description,omitempty"`
				Risk             string `json:"risk"`
				SideEffect       bool   `json:"side_effect"`
				NeedConfirmation bool   `json:"need_confirmation"`
			}
			var out []row
			for rows.Next() {
				var r row
				var desc sql.NullString
				var sideEffect, needConfirm int
				if err := rows.Scan(&r.ID, &r.Name, &r.Method, &r.Path, &desc,
					&r.Risk, &sideEffect, &needConfirm); err != nil {
					return nil, err
				}
				r.Description = desc.String
				r.SideEffect = sideEffect == 1
				r.NeedConfirmation = needConfirm == 1
				out = append(out, r)
			}
			return out, nil
		},
	}
}

func (s *HTTPService) toolGetAPI() ManagementToolDef {
	return ManagementToolDef{
		Tool: mcp.NewTool("get_api",
			mcp.WithDescription(`Get the full definition of an API: method, path, all parameters, request body fields, and response schemas.
Call this before send_request to understand what the API expects.`),
			mcp.WithString("api_id",
				mcp.Required(),
				mcp.Description("API ID from list_apis"),
			),
		),
		Handle: func(ctx context.Context, args map[string]any) (any, error) {
			if s.db == nil {
				return nil, fmt.Errorf("db not initialized")
			}
			apiID, _ := args["api_id"].(string)
			if apiID == "" {
				return nil, fmt.Errorf("api_id is required")
			}
			return s.loadFullAPI(ctx, apiID)
		},
	}
}

// loadFullAPI assembles the full API definition from the database.
func (s *HTTPService) loadFullAPI(ctx context.Context, apiID string) (any, error) {
	// 1. Base fields
	type apiBase struct {
		ID              string `json:"id"`
		Name            string `json:"name"`
		Method          string `json:"method"`
		Path            string `json:"path"`
		Description     string `json:"description,omitempty"`
		RequestBodyType string `json:"request_body_type"`
		Risk            string `json:"risk"`
		SideEffect      bool   `json:"side_effect"`
		NeedConfirm     bool   `json:"need_confirmation"`
		RetryStrategy   string `json:"retry_strategy"`
	}
	row := s.db.QueryRowContext(ctx,
		`SELECT id, name, method, path, description, request_body_type,
		        risk, side_effect, need_confirmation, retry_strategy
		 FROM apis WHERE id = ?`, apiID)

	var base apiBase
	var desc sql.NullString
	var sideEffect, needConfirm int
	if err := row.Scan(&base.ID, &base.Name, &base.Method, &base.Path, &desc,
		&base.RequestBodyType, &base.Risk, &sideEffect, &needConfirm, &base.RetryStrategy); err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("api %s not found", apiID)
		}
		return nil, err
	}
	base.Description = desc.String
	base.SideEffect = sideEffect == 1
	base.NeedConfirm = needConfirm == 1

	// 2. Params (query / path / header / cookie)
	type paramRow struct {
		ID          string `json:"id"`
		Location    string `json:"location"`
		Name        string `json:"name"`
		Type        string `json:"type"`
		Required    bool   `json:"required"`
		Description string `json:"description,omitempty"`
		Example     string `json:"example,omitempty"`
	}
	paramRows, err := s.db.QueryContext(ctx,
		`SELECT id, location, name, type, required, description, example
		 FROM api_params WHERE api_id = ? ORDER BY sort_order`, apiID)
	if err != nil {
		return nil, err
	}
	defer paramRows.Close()

	var params []paramRow
	for paramRows.Next() {
		var r paramRow
		var pdesc, pexample sql.NullString
		var req int
		if err := paramRows.Scan(&r.ID, &r.Location, &r.Name, &r.Type, &req, &pdesc, &pexample); err != nil {
			return nil, err
		}
		r.Required = req == 1
		r.Description = pdesc.String
		r.Example = pexample.String
		params = append(params, r)
	}

	// 3. Request body fields (response_id IS NULL)
	requestFields, err := s.loadFields(ctx, apiID, "")
	if err != nil {
		return nil, err
	}

	// 4. Responses and fields for each status code
	type responseRow struct {
		ID          string      `json:"id"`
		StatusCode  int         `json:"status_code"`
		Description string      `json:"description,omitempty"`
		ContentType string      `json:"content_type"`
		Fields      []fieldNode `json:"fields,omitempty"`
	}
	respRows, err := s.db.QueryContext(ctx,
		`SELECT id, status_code, description, content_type
		 FROM api_responses WHERE api_id = ? ORDER BY sort_order, status_code`, apiID)
	if err != nil {
		return nil, err
	}
	defer respRows.Close()

	var responses []responseRow
	for respRows.Next() {
		var r responseRow
		var rdesc sql.NullString
		if err := respRows.Scan(&r.ID, &r.StatusCode, &rdesc, &r.ContentType); err != nil {
			return nil, err
		}
		r.Description = rdesc.String
		r.Fields, err = s.loadFields(ctx, apiID, r.ID)
		if err != nil {
			return nil, err
		}
		responses = append(responses, r)
	}

	return map[string]any{
		"id":                base.ID,
		"name":              base.Name,
		"method":            base.Method,
		"path":              base.Path,
		"description":       base.Description,
		"request_body_type": base.RequestBodyType,
		"risk":              base.Risk,
		"side_effect":       base.SideEffect,
		"need_confirmation": base.NeedConfirm,
		"retry_strategy":    base.RetryStrategy,
		"params":            params,
		"request_fields":    requestFields,
		"responses":         responses,
	}, nil
}

// fieldNode is one node in the recursively nested field tree.
type fieldNode struct {
	ID          string      `json:"id"`
	Name        string      `json:"name,omitempty"`
	Type        string      `json:"type"`
	Format      string      `json:"format,omitempty"`
	Required    bool        `json:"required"`
	Description string      `json:"description,omitempty"`
	Example     string      `json:"example,omitempty"`
	EnumValues  string      `json:"enum_values,omitempty"`
	Constraints string      `json:"constraints,omitempty"`
	Children    []fieldNode `json:"children,omitempty"`
}

// loadFields reads fields from the database and builds a recursive tree.
// An empty responseID loads request body fields.
func (s *HTTPService) loadFields(ctx context.Context, apiID, responseID string) ([]fieldNode, error) {
	var rows *sql.Rows
	var err error
	if responseID == "" {
		rows, err = s.db.QueryContext(ctx,
			`SELECT id, name, type, format, required, description, example, enum_values, constraints, parent_id
			 FROM api_fields WHERE api_id = ? AND response_id IS NULL
			 ORDER BY sort_order`, apiID)
	} else {
		rows, err = s.db.QueryContext(ctx,
			`SELECT id, name, type, format, required, description, example, enum_values, constraints, parent_id
			 FROM api_fields WHERE api_id = ? AND response_id = ?
			 ORDER BY sort_order`, apiID, responseID)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	all := map[string]*rawField{}
	var order []string

	for rows.Next() {
		var f rawField
		var name, format, desc, example, enumVals, constraints, parentID sql.NullString
		var req int
		if err := rows.Scan(&f.ID, &name, &f.Type, &format, &req, &desc,
			&example, &enumVals, &constraints, &parentID); err != nil {
			return nil, err
		}
		f.Name = name.String
		f.Format = format.String
		f.Required = req == 1
		f.Description = desc.String
		f.Example = example.String
		f.EnumValues = enumVals.String
		f.Constraints = constraints.String
		f.parentID = parentID.String
		all[f.ID] = &f
		order = append(order, f.ID)
	}

	var roots []fieldNode
	for _, id := range order {
		f := all[id]
		if f.parentID == "" {
			roots = append(roots, buildFieldNode(f, all))
		}
	}
	return roots, nil
}

type rawField struct {
	fieldNode
	parentID string
}

func buildFieldNode(f *rawField, all map[string]*rawField) fieldNode {
	node := f.fieldNode
	for _, candidate := range all {
		if candidate.parentID == f.ID {
			node.Children = append(node.Children, buildFieldNode(candidate, all))
		}
	}
	return node
}

// Write tool implementations

func (s *HTTPService) toolCreateProject() ManagementToolDef {
	return ManagementToolDef{
		Tool: mcp.NewTool("create_project",
			mcp.WithDescription("Create a new project."),
			mcp.WithString("name",
				mcp.Required(),
				mcp.Description("Project name"),
			),
			mcp.WithString("description",
				mcp.Description("Project description (optional)"),
			),
		),
		Handle: func(ctx context.Context, args map[string]any) (any, error) {
			if s.db == nil {
				return nil, fmt.Errorf("db not initialized")
			}
			name, _ := args["name"].(string)
			if name == "" {
				return nil, fmt.Errorf("name is required")
			}
			desc, _ := args["description"].(string)
			id := uuid.New().String()
			now := time.Now().UTC().Format(time.RFC3339)
			_, err := s.db.ExecContext(ctx,
				`INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
				id, name, nullStr(desc), now, now)
			if err != nil {
				return nil, err
			}
			return map[string]any{"id": id, "name": name}, nil
		},
	}
}

func (s *HTTPService) toolCreateCollection() ManagementToolDef {
	return ManagementToolDef{
		Tool: mcp.NewTool("create_collection",
			mcp.WithDescription("Create a new collection inside a project."),
			mcp.WithString("project_id",
				mcp.Required(),
				mcp.Description("Project ID"),
			),
			mcp.WithString("name",
				mcp.Required(),
				mcp.Description("Collection name"),
			),
			mcp.WithString("description",
				mcp.Description("Collection description (optional)"),
			),
		),
		Handle: func(ctx context.Context, args map[string]any) (any, error) {
			if s.db == nil {
				return nil, fmt.Errorf("db not initialized")
			}
			projectID, _ := args["project_id"].(string)
			name, _ := args["name"].(string)
			if projectID == "" || name == "" {
				return nil, fmt.Errorf("project_id and name are required")
			}
			desc, _ := args["description"].(string)
			id := uuid.New().String()
			now := time.Now().UTC().Format(time.RFC3339)
			_, err := s.db.ExecContext(ctx,
				`INSERT INTO collections (id, project_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
				id, projectID, name, nullStr(desc), now, now)
			if err != nil {
				return nil, err
			}
			return map[string]any{"id": id, "name": name, "project_id": projectID}, nil
		},
	}
}

func (s *HTTPService) toolCreateAPI() ManagementToolDef {
	return ManagementToolDef{
		Tool: mcp.NewTool("create_api",
			mcp.WithDescription(`Create a new API definition in a collection.
Only stores the spec (method, path, description). Use send_request to actually call it.`),
			mcp.WithString("collection_id",
				mcp.Required(),
				mcp.Description("Collection ID"),
			),
			mcp.WithString("name",
				mcp.Required(),
				mcp.Description("Display name, e.g. User login"),
			),
			mcp.WithString("method",
				mcp.Required(),
				mcp.Description("HTTP method: GET POST PUT DELETE PATCH HEAD OPTIONS"),
			),
			mcp.WithString("path",
				mcp.Required(),
				mcp.Description("API path, e.g. /api/v1/auth/login"),
			),
			mcp.WithString("description",
				mcp.Description("API description (optional)"),
			),
			mcp.WithString("request_body_type",
				mcp.Description("Body format: json (default) / form / multipart / none"),
			),
		),
		Handle: func(ctx context.Context, args map[string]any) (any, error) {
			if s.db == nil {
				return nil, fmt.Errorf("db not initialized")
			}
			collectionID, _ := args["collection_id"].(string)
			name, _ := args["name"].(string)
			method, _ := args["method"].(string)
			path, _ := args["path"].(string)
			if collectionID == "" || name == "" || method == "" || path == "" {
				return nil, fmt.Errorf("collection_id, name, method and path are required")
			}
			desc, _ := args["description"].(string)
			bodyType, _ := args["request_body_type"].(string)
			if bodyType == "" {
				bodyType = "json"
			}
			id := uuid.New().String()
			now := time.Now().UTC().Format(time.RFC3339)
			_, err := s.db.ExecContext(ctx,
				`INSERT INTO apis
				 (id, collection_id, name, method, path, description, request_body_type, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id, collectionID, name, method, path, nullStr(desc), bodyType, now, now)
			if err != nil {
				return nil, err
			}
			return map[string]any{
				"id":            id,
				"name":          name,
				"method":        method,
				"path":          path,
				"collection_id": collectionID,
			}, nil
		},
	}
}

func nullStr(s string) sql.NullString {
	return sql.NullString{String: s, Valid: s != ""}
}
