package aiinstall

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"os/exec"
	"runtime"
	"strings"
	"time"
	"unicode/utf16"

	mcpclient "github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/client/transport"
	"github.com/mark3labs/mcp-go/mcp"
)

//go:embed connection-windows.ps1
var windowsConnectionScript string

type Connection struct {
	Status      string    `json:"status"`
	ToolsCount  *int      `json:"tools_count,omitempty"`
	CheckedAt   time.Time `json:"checked_at"`
	DurationMS  int64     `json:"duration_ms"`
	Environment string    `json:"environment"`
	Error       string    `json:"error,omitempty"`
}
type connectionCache struct {
	fingerprint [32]byte
	result      Connection
}
type probeResult struct {
	ToolsCount int    `json:"tools_count"`
	ServerName string `json:"server_name"`
	Error      string `json:"error,omitempty"`
}

func (s *Installer) fingerprint(c Client) ([32]byte, error) {
	if c.Status == "external" {
		return sha256.Sum256([]byte(c.Snippet)), nil
	}
	before, after, exists, err := s.plan(c)
	if err != nil {
		return [32]byte{}, err
	}
	if !exists || !bytes.Equal(before, after) {
		return [32]byte{}, errors.New("请先安装 Apix 配置，再测试连接")
	}
	return sha256.Sum256(before), nil
}

func (s *Installer) testConnection(ctx context.Context, t Target, id string) Connection {
	started := time.Now()
	result := Connection{Status: "failed", Environment: t.Name, CheckedAt: started.UTC()}
	c, err := s.client(t, id)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	fingerprint, err := s.fingerprint(c)
	if err != nil {
		result.Status = "unconfigured"
		result.Error = err.Error()
		return result
	}
	timeout := 10 * time.Second
	if t.EnvironmentID != "" {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	probe := s.probe
	if probe == nil {
		probe = probeTarget
	}
	measured, err := probe(ctx, t, s.endpoint)
	result.CheckedAt = time.Now().UTC()
	result.DurationMS = time.Since(started).Milliseconds()
	if ctx.Err() != nil {
		result.Error = "连接测试超时或已取消，请确认 Apix 正在运行，且所选环境能访问 MCP 地址"
	} else if err != nil {
		result.Error = err.Error()
	} else if measured.ServerName != "apix" || measured.ToolsCount < 0 {
		result.Error = "MCP 返回的服务信息无效，请检查 Apix 地址"
	} else {
		result.Status = "connected"
		count := measured.ToolsCount
		result.ToolsCount = &count
	}
	s.mu.Lock()
	if s.connections == nil {
		s.connections = make(map[string]connectionCache)
	}
	s.connections[t.ID+"/"+id] = connectionCache{fingerprint: fingerprint, result: result}
	s.mu.Unlock()
	return result
}

func probeTarget(ctx context.Context, t Target, endpoint string) (probeResult, error) {
	if t.EnvironmentID != "" {
		return probeWSL(ctx, t, endpoint)
	}
	if t.ID == "windows" && runtime.GOOS == "linux" {
		return probeWindows(ctx, endpoint)
	}
	return probeHTTP(ctx, endpoint)
}

func probeHTTP(ctx context.Context, endpoint string) (probeResult, error) {
	client, err := mcpclient.NewStreamableHttpClient(endpoint, transport.WithHTTPBasicClient(&http.Client{
		Timeout:       8 * time.Second,
		Transport:     &http.Transport{Proxy: nil},
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}))
	if err != nil {
		return probeResult{}, errors.New("MCP 地址无效")
	}
	defer client.Close()
	if err = client.Start(ctx); err != nil {
		return probeResult{}, errors.New("无法建立 MCP 连接，请确认 Apix 正在运行")
	}
	initialized, err := client.Initialize(ctx, mcp.InitializeRequest{Params: mcp.InitializeParams{
		ProtocolVersion: mcp.LATEST_PROTOCOL_VERSION,
		ClientInfo:      mcp.Implementation{Name: "apix-workbench-connection-test", Version: "1.0.0"},
	}})
	if err != nil {
		return probeResult{}, errors.New("MCP 握手失败，请检查所选环境能否访问 Apix")
	}
	names := map[string]bool{}
	seen := map[mcp.Cursor]bool{}
	request := mcp.ListToolsRequest{}
	for page := 0; page < 100; page++ {
		tools, err := client.ListToolsByPage(ctx, request)
		if err != nil {
			return probeResult{}, errors.New("无法读取 MCP 工具列表")
		}
		for _, tool := range tools.Tools {
			if tool.Name == "" {
				return probeResult{}, errors.New("MCP 工具列表包含无效工具")
			}
			names[tool.Name] = true
		}
		if tools.NextCursor == "" {
			return probeResult{ServerName: initialized.ServerInfo.Name, ToolsCount: len(names)}, nil
		}
		if seen[tools.NextCursor] {
			return probeResult{}, errors.New("MCP 工具分页返回重复游标")
		}
		seen[tools.NextCursor] = true
		request.Params.Cursor = tools.NextCursor
	}
	return probeResult{}, errors.New("MCP 工具列表页数超出限制")
}

func probeWindows(ctx context.Context, endpoint string) (probeResult, error) {
	shell, err := exec.LookPath("powershell.exe")
	if err != nil {
		return probeResult{}, errors.New("无法启动 Windows 连接测试，请确认 WSL 的 Windows 互操作可用")
	}
	// Encode a fixed script and a JSON string literal, never interpolate shell input.
	endpointJSON, _ := json.Marshal(endpoint)
	script := "$apixEndpoint = " + string(endpointJSON) + "\n" + windowsConnectionScript
	units := utf16.Encode([]rune(script))
	encoded := make([]byte, len(units)*2)
	for i, unit := range units {
		binary.LittleEndian.PutUint16(encoded[i*2:], unit)
	}
	command := exec.CommandContext(ctx, shell, "-NoProfile", "-NonInteractive", "-EncodedCommand", base64.StdEncoding.EncodeToString(encoded))
	command.WaitDelay = time.Second
	output, err := command.Output()
	if err != nil {
		return probeResult{}, errors.New("Windows MCP 连接测试失败，请确认 Windows 能访问 Apix")
	}
	var result probeResult
	if json.Unmarshal(bytes.TrimSpace(bytes.TrimPrefix(output, []byte{0xef, 0xbb, 0xbf})), &result) != nil {
		return probeResult{}, errors.New("Windows 连接测试返回了无效结果")
	}
	if result.Error != "" {
		// Only fixed error messages from the embedded script are exposed.
		switch strings.TrimSpace(result.Error) {
		case "handshake":
			return probeResult{}, errors.New("Windows MCP 握手失败，请确认 Windows 能访问 Apix")
		case "tools":
			return probeResult{}, errors.New("Windows 无法读取 MCP 工具列表")
		default:
			return probeResult{}, errors.New("Windows MCP 连接测试失败")
		}
	}
	return result, nil
}
