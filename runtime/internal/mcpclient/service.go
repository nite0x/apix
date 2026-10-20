// Package mcpclient connects to external MCP servers for independent tool tests.
package mcpclient

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/apix/apix/runtime/internal/lifecycle"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/apix/apix/runtime/internal/database"
	"github.com/google/uuid"
	"github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/client/transport"
	"github.com/mark3labs/mcp-go/mcp"
)

const Mask = "••••••"

var ErrNotFound = errors.New("MCP server not found")
var ErrConflict = errors.New("MCP server changed; reload before saving")

type Server struct {
	Archived       bool              `json:"archived"`
	DiscoveredAt   *time.Time        `json:"discovered_at,omitempty"`
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	URL            string            `json:"url"`
	Headers        map[string]string `json:"headers"`
	TimeoutSeconds int               `json:"timeout_seconds"`
	EditVersion    int64             `json:"edit_version"`
}
type Request struct {
	ServerID  string         `json:"server_id"`
	ToolName  string         `json:"tool_name"`
	Arguments map[string]any `json:"arguments"`
}
type Result struct {
	ErrorDetails string              `json:"error_details,omitempty"`
	Server       Server              `json:"server"`
	Tool         map[string]any      `json:"tool,omitempty"`
	Response     *mcp.CallToolResult `json:"response,omitempty"`
	ErrorKind    string              `json:"error_kind,omitempty"`
	ErrorMessage string              `json:"error_message,omitempty"`
	DurationMS   int64               `json:"duration_ms"`
	Secrets      []string            `json:"-"`
}
type Discovery struct {
	ServerName      string     `json:"server_name"`
	ProtocolVersion string     `json:"protocol_version"`
	Tools           []mcp.Tool `json:"tools"`
	DurationMS      int64      `json:"duration_ms"`
}
type Service struct {
	db          *sql.DB
	credentials *database.Credentials
}

func New(db *sql.DB) (*Service, error) {
	if err := lifecycle.Init(db); err != nil {
		return nil, err
	}
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS mcp_servers(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,headers BLOB NOT NULL,timeout_seconds INTEGER NOT NULL,edit_version INTEGER NOT NULL DEFAULT 1,archived INTEGER NOT NULL DEFAULT 0)`)
	if err != nil {
		return nil, err
	}
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS mcp_discoveries(server_id TEXT PRIMARY KEY,discovered_at TEXT NOT NULL,tools TEXT NOT NULL)`)
	return &Service{db: db, credentials: database.NewCredentials(db)}, err
}
func validServer(v *Server) error {
	v.Name = strings.TrimSpace(v.Name)
	v.URL = strings.TrimSpace(v.URL)
	if v.Name == "" || len(v.Name) > 256 {
		return errors.New("服务器名称必填，最多 256 字节")
	}
	if len(v.URL) > 8192 {
		return errors.New("MCP 地址最多 8192 字节")
	}
	u, e := url.Parse(v.URL)
	if e != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return errors.New("请输入 HTTP/HTTPS MCP 地址，认证信息请放在请求头中")
	}
	for k := range u.Query() {
		if Sensitive(k) {
			return errors.New("认证信息请放在请求头中，不要放在 URL 查询参数中")
		}
	}
	if v.TimeoutSeconds == 0 {
		v.TimeoutSeconds = 30
	}
	if v.TimeoutSeconds < 1 || v.TimeoutSeconds > 300 {
		return errors.New("超时必须在 1–300 秒之间")
	}
	if len(v.Headers) > 32 {
		return errors.New("最多支持 32 个请求头")
	}
	normalized := map[string]string{}
	for k, value := range v.Headers {
		if k == "" || len(k) > 256 || strings.ContainsAny(value, "\r\n") || len(value) > 8192 {
			return errors.New("请求头无效")
		}
		for _, c := range k {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("!#$%&'*+-.^_`|~", c)) {
				return errors.New("请求头名称无效")
			}
		}
		k = http.CanonicalHeaderKey(k)
		if normalized[k] != "" {
			return errors.New("请求头名称重复")
		}
		switch strings.ToLower(k) {
		case "host", "content-length", "content-type", "accept", "mcp-session-id", "mcp-protocol-version":
			return errors.New("不能覆盖 MCP 协议请求头")
		}
		normalized[k] = value
	}
	v.Headers = normalized
	return nil
}
func (s *Service) load(id string, secrets bool) (*Server, error) {
	return s.loadAny(id, secrets, false)
}
func (s *Service) loadAny(id string, secrets, includeArchived bool) (*Server, error) {
	var v Server
	var encrypted []byte
	err := s.db.QueryRow(`SELECT id,name,url,headers,timeout_seconds,edit_version,archived FROM mcp_servers WHERE id=? AND (archived=0 OR ?)`, id, includeArchived).Scan(&v.ID, &v.Name, &v.URL, &encrypted, &v.TimeoutSeconds, &v.EditVersion, &v.Archived)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	text, err := s.credentials.Open("mcp:"+id, encrypted)
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal([]byte(text), &v.Headers); err != nil {
		return nil, err
	}
	if !secrets {
		for k := range v.Headers {
			v.Headers[k] = Mask
		}
	}
	var timestamp string
	if err := s.db.QueryRow(`SELECT discovered_at FROM mcp_discoveries WHERE server_id=?`, id).Scan(&timestamp); err == nil {
		if t, err := time.Parse(time.RFC3339Nano, timestamp); err == nil {
			v.DiscoveredAt = &t
		}
	}
	return &v, nil
}
func (s *Service) Get(id string) (*Server, error) { return s.load(id, false) }
func (s *Service) List() ([]Server, error)        { return s.ListArchived(false) }
func (s *Service) ListArchived(archived bool) ([]Server, error) {
	rows, err := s.db.Query(`SELECT id FROM mcp_servers WHERE archived=? ORDER BY name,id`, archived)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	out := []Server{}
	for _, id := range ids {
		v, e := s.loadAny(id, false, true)
		if e != nil {
			return nil, e
		}
		out = append(out, *v)
	}
	return out, nil
}
func (s *Service) Save(v Server) (*Server, error) {
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	if err := lifecycle.Check(s.db, "mcp", v.ID, false); err != nil {
		return nil, err
	}
	if err := validServer(&v); err != nil {
		return nil, err
	}
	fresh := v.ID == ""
	if fresh {
		v.ID = uuid.NewString()
		v.EditVersion = 1
	} else {
		old, err := s.load(v.ID, true)
		if err != nil {
			return nil, err
		}
		if v.EditVersion != old.EditVersion {
			return nil, ErrConflict
		}
		for k, value := range v.Headers {
			if value == Mask {
				previous, ok := old.Headers[k]
				if !ok {
					return nil, errors.New("请填写新增请求头的值")
				}
				v.Headers[k] = previous
			}
		}
	}
	for _, value := range v.Headers {
		if value == Mask {
			return nil, errors.New("请填写请求头的实际值")
		}
	}
	raw, _ := json.Marshal(v.Headers)
	encrypted, err := s.credentials.Seal("mcp:"+v.ID, string(raw))
	if err != nil {
		return nil, err
	}
	if fresh {
		_, err = s.db.Exec(`INSERT INTO mcp_servers(id,name,url,headers,timeout_seconds) VALUES(?,?,?,?,?)`, v.ID, v.Name, v.URL, encrypted, v.TimeoutSeconds)
	} else {
		var r sql.Result
		r, err = s.db.Exec(`UPDATE mcp_servers SET name=?,url=?,headers=?,timeout_seconds=?,edit_version=edit_version+1 WHERE id=? AND edit_version=? AND archived=0`, v.Name, v.URL, encrypted, v.TimeoutSeconds, v.ID, v.EditVersion)
		if err == nil {
			n, e := r.RowsAffected()
			if e != nil {
				return nil, e
			}
			if n != 1 {
				return nil, ErrConflict
			}
		}
	}
	if err != nil {
		return nil, err
	}
	return s.Get(v.ID)
}
func (s *Service) Archive(id string) error {
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	if err := lifecycle.Check(s.db, "mcp", id, true); err != nil {
		return err
	}
	r, err := s.db.Exec(`UPDATE mcp_servers SET archived=1,edit_version=edit_version+1 WHERE id=? AND archived=0`, id)
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err == nil && n == 0 {
		return ErrNotFound
	}
	return err
}

var mcpHTTPTransport = &http.Transport{Proxy: http.ProxyFromEnvironment, MaxIdleConns: 32, MaxIdleConnsPerHost: 2, IdleConnTimeout: 30 * time.Second}

func connect(ctx context.Context, v *Server) (*client.Client, *mcp.InitializeResult, error) {
	cli, err := client.NewStreamableHttpClient(v.URL, transport.WithHTTPHeaders(v.Headers), transport.WithHTTPBasicClient(&http.Client{Transport: mcpHTTPTransport, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}))
	if err != nil {
		return nil, nil, err
	}
	if err = cli.Start(ctx); err != nil {
		cli.Close()
		return nil, nil, err
	}
	initialized, err := cli.Initialize(ctx, mcp.InitializeRequest{Params: mcp.InitializeParams{ProtocolVersion: mcp.LATEST_PROTOCOL_VERSION, ClientInfo: mcp.Implementation{Name: "apix-mcp-testing", Version: "1.0.0"}}})
	if err != nil {
		cli.Close()
		return nil, nil, err
	}
	return cli, initialized, nil
}
func list(ctx context.Context, cli *client.Client) ([]mcp.Tool, error) {
	out := []mcp.Tool{}
	names := map[string]bool{}
	seen := map[mcp.Cursor]bool{}
	req := mcp.ListToolsRequest{}
	for page := 0; page < 100; page++ {
		result, err := cli.ListToolsByPage(ctx, req)
		if err != nil {
			return nil, err
		}
		for _, tool := range result.Tools {
			if tool.Name == "" || names[tool.Name] {
				return nil, errors.New("工具列表包含空名称或重复名称")
			}
			names[tool.Name] = true
		}
		out = append(out, result.Tools...)
		if len(out) > 10000 {
			return nil, errors.New("工具数量超过限制")
		}
		if result.NextCursor == "" {
			return out, nil
		}
		if seen[result.NextCursor] {
			return nil, errors.New("工具列表包含重复分页游标")
		}
		seen[result.NextCursor] = true
		req.Params.Cursor = result.NextCursor
	}
	return nil, errors.New("工具分页超过限制")
}
func (s *Service) Discover(ctx context.Context, id string) (*Discovery, error) {
	release := lifecycle.Lease(s.db, "mcp", id)
	defer release()
	v, err := s.load(id, true)
	if err != nil {
		return nil, err
	}
	return s.discoverServer(ctx, v, true)
}
func (s *Service) discoverServer(ctx context.Context, v *Server, persist bool) (*Discovery, error) {
	started := time.Now()
	ctx, cancel := context.WithTimeout(ctx, time.Duration(v.TimeoutSeconds)*time.Second)
	defer cancel()
	cli, info, err := connect(ctx, v)
	if err != nil {
		return nil, errors.New("MCP 握手失败，请检查地址、认证和超时设置")
	}
	defer cli.Close()
	tools, err := list(ctx, cli)
	if err != nil {
		return nil, errors.New("读取 MCP 工具列表失败或超时")
	}
	raw, err := json.Marshal(tools)
	if err != nil {
		return nil, err
	}
	if persist {
		if _, err = s.db.Exec(`INSERT INTO mcp_discoveries(server_id,discovered_at,tools) VALUES(?,?,?) ON CONFLICT(server_id) DO UPDATE SET discovered_at=excluded.discovered_at,tools=excluded.tools`, v.ID, time.Now().UTC().Format(time.RFC3339Nano), string(raw)); err != nil {
			return nil, err
		}
	}
	return &Discovery{ServerName: info.ServerInfo.Name, ProtocolVersion: info.ProtocolVersion, Tools: tools, DurationMS: time.Since(started).Milliseconds()}, nil
}
func (s *Service) Call(ctx context.Context, req Request) *Result {
	release := lifecycle.Lease(s.db, "mcp", req.ServerID)
	defer release()
	started := time.Now()
	out := &Result{}
	defer func() { out.DurationMS = time.Since(started).Milliseconds() }()
	v, err := s.load(req.ServerID, true)
	if err != nil {
		out.ErrorKind = "connection"
		out.ErrorMessage = "MCP 服务器不存在或凭据不可用"
		return out
	}
	out.Server = *v
	out.Server.Headers = map[string]string{}
	for k, value := range v.Headers {
		out.Server.Headers[k] = Mask
		if value != "" {
			out.Secrets = append(out.Secrets, value)
			if strings.HasPrefix(value, "Bearer ") {
				out.Secrets = append(out.Secrets, strings.TrimPrefix(value, "Bearer "))
			}
		}
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(v.TimeoutSeconds)*time.Second)
	defer cancel()
	fail := func(kind, message string) *Result {
		if ctx.Err() != nil {
			kind = "timeout"
			message = "MCP 调用超时或已取消"
		}
		out.ErrorKind = kind
		out.ErrorMessage = message
		return out
	}
	cli, _, err := connect(ctx, v)
	if err != nil {
		return fail("connection", "MCP 握手失败，请检查地址和认证")
	}
	defer cli.Close()
	tools, err := list(ctx, cli)
	if err != nil {
		return fail("protocol", "读取 MCP 工具列表失败")
	}
	for _, tool := range tools {
		if tool.Name == req.ToolName {
			raw, e := json.Marshal(tool)
			if e != nil {
				return fail("protocol", "工具定义无效")
			}
			if json.Unmarshal(raw, &out.Tool) != nil {
				return fail("protocol", "工具定义无效")
			}
			break
		}
	}
	if out.Tool == nil {
		return fail("protocol", "MCP 工具不存在，请刷新工具列表")
	}
	result, err := cli.CallTool(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{Name: req.ToolName, Arguments: req.Arguments}})
	if err != nil {
		out.ErrorDetails = err.Error()
		return fail("protocol", "MCP tools/call 返回协议错误或无效响应")
	}
	out.Response = result
	return out
}
func Sensitive(name string) bool {
	name = strings.NewReplacer("-", "", "_", "").Replace(strings.ToLower(name))
	if name == "key" {
		return true
	}
	for _, part := range []string{"password", "passwd", "secret", "token", "authorization", "apikey", "credential", "cookie", "privatekey", "accesskey"} {
		if strings.Contains(name, part) {
			return true
		}
	}
	return false
}

// Redact is applied after live assertions, before any result is persisted or returned.
func Redact(value any, secrets []string) any {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return nil
	}
	var walk func(any) any
	walk = func(item any) any {
		switch x := item.(type) {
		case map[string]any:
			for k, v := range x {
				if Sensitive(k) {
					x[k] = Mask
				} else {
					x[k] = walk(v)
				}
			}
			return x
		case []any:
			for i, v := range x {
				x[i] = walk(v)
			}
			return x
		case string:
			var parsed any
			if (strings.HasPrefix(strings.TrimSpace(x), "{") || strings.HasPrefix(strings.TrimSpace(x), "[")) && json.Unmarshal([]byte(x), &parsed) == nil {
				b, _ := json.Marshal(walk(parsed))
				x = string(b)
			}
			for _, secret := range secrets {
				if secret != "" {
					x = strings.ReplaceAll(x, secret, Mask)
				}
			}
			return x
		default:
			return item
		}
	}
	sort.Slice(secrets, func(i, j int) bool { return len(secrets[i]) > len(secrets[j]) })
	return walk(v)
}
func ValidateRequest(req *Request) error {
	if req == nil || req.ServerID == "" || strings.TrimSpace(req.ToolName) == "" {
		return fmt.Errorf("mcp_request.server_id 和 tool_name 必填")
	}
	if len(req.ToolName) > 512 {
		return errors.New("工具名称过长")
	}
	raw, err := json.Marshal(req.Arguments)
	if err != nil || len(raw) > 256*1024 {
		return errors.New("调用参数必须是有效 JSON，最多 256 KB")
	}
	if req.Arguments == nil {
		req.Arguments = map[string]any{}
	}
	return nil
}

// Restore verifies the actual endpoint and discovers current tools before making
// the original identity available again. A failed handshake leaves it archived.
func (s *Service) Restore(ctx context.Context, id, name string) (*Server, error) {
	release := lifecycle.Lease(s.db, "mcp", id)
	defer release()
	v, err := s.loadAny(id, true, true)
	if err != nil {
		return nil, err
	}
	if !v.Archived {
		return s.Get(id)
	}
	if name != "" {
		v.Name = strings.TrimSpace(name)
	}
	if err := validServer(v); err != nil {
		return nil, err
	}
	var before string
	_ = s.db.QueryRow(`SELECT tools FROM mcp_discoveries WHERE server_id=?`, id).Scan(&before)
	discovery, err := s.discoverServer(ctx, v, false)
	if err != nil {
		return nil, err
	}
	gate := lifecycle.For(s.db)
	gate.Lock()
	defer gate.Unlock()
	var conflict int
	if err := s.db.QueryRow(`SELECT count(*) FROM mcp_servers WHERE archived=0 AND id<>? AND lower(trim(name))=lower(?)`, id, v.Name).Scan(&conflict); err != nil {
		return nil, err
	}
	if conflict > 0 {
		return nil, fmt.Errorf("%w: 名称冲突，请改名后恢复", lifecycle.ErrProtected)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	result, err := tx.Exec(`UPDATE mcp_servers SET archived=0,name=?,edit_version=edit_version+1 WHERE id=? AND archived=1 AND edit_version=?`, v.Name, id, v.EditVersion)
	if err != nil {
		return nil, err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return nil, ErrConflict
	}
	current, _ := json.Marshal(discovery.Tools)
	if _, err := tx.Exec(`INSERT INTO mcp_discoveries(server_id,discovered_at,tools) VALUES(?,?,?) ON CONFLICT(server_id) DO UPDATE SET discovered_at=excluded.discovered_at,tools=excluded.tools`, id, time.Now().UTC().Format(time.RFC3339Nano), string(current)); err != nil {
		return nil, err
	}
	// A rediscovered schema requires explicit review, never silently rewrite a case.
	if before != string(current) {
		var exists int
		if err := tx.QueryRow(`SELECT count(*) FROM pragma_table_info('test_cases') WHERE name='needs_review'`).Scan(&exists); err != nil {
			return nil, err
		}
		if exists > 0 {
			if _, err := tx.Exec(`UPDATE test_cases SET needs_review=1,edit_version=edit_version+1 WHERE type='mcp' AND json_extract(mcp_data,'$.mcp_request.server_id')=?`, id); err != nil {
				return nil, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.Get(id)
}
