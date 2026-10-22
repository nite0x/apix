// Package mcpbridge forwards a stdio client's tools to the single HTTP runtime.
package mcpbridge

import (
	"context"
	"encoding/json"
	"errors"
	mcpclient "github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/client/transport"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

func Connect(ctx context.Context, endpoint string) (*mcpclient.Client, *mcp.InitializeResult, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, nil, err
	}
	if u.Scheme != "http" || u.User != nil || u.Path != "/mcp" || u.RawQuery != "" || u.Fragment != "" {
		return nil, nil, errors.New("bridge requires a loopback HTTP /mcp endpoint")
	}
	host := u.Hostname()
	ip := net.ParseIP(host)
	if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return nil, nil, errors.New("bridge only connects to the local Windows runtime")
	}
	cli, err := mcpclient.NewStreamableHttpClient(endpoint, transport.WithHTTPBasicClient(&http.Client{Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}))
	if err != nil {
		return nil, nil, err
	}
	if err = cli.Start(ctx); err != nil {
		cli.Close()
		return nil, nil, err
	}
	init, err := cli.Initialize(ctx, mcp.InitializeRequest{Params: mcp.InitializeParams{ProtocolVersion: mcp.LATEST_PROTOCOL_VERSION, ClientInfo: mcp.Implementation{Name: "apix-stdio-bridge", Version: "1"}}})
	if err != nil {
		cli.Close()
		return nil, nil, err
	}
	if init.ServerInfo.Name != "apix" {
		cli.Close()
		return nil, nil, errors.New("endpoint is not an Apix runtime")
	}
	return cli, init, nil
}
func Serve(ctx context.Context, endpoint string, in io.Reader, out io.Writer) error {
	setup, cancel := context.WithTimeout(ctx, 10*time.Second)
	cli, info, err := Connect(setup, endpoint)
	cancel()
	if err != nil {
		return err
	}
	defer cli.Close()
	proxy := server.NewMCPServer("apix", info.ServerInfo.Version, server.WithToolCapabilities(true), server.WithInstructions(info.Instructions))
	refresh := func() error {
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		tools, err := cli.ListTools(ctx, mcp.ListToolsRequest{})
		if err != nil {
			return err
		}
		definitions := []server.ServerTool{}
		for _, tool := range tools.Tools {
			definitions = append(definitions, server.ServerTool{Tool: tool, Handler: func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				return cli.CallTool(ctx, request)
			}})
		}
		proxy.SetTools(definitions...)
		return nil
	}
	if err = refresh(); err != nil {
		return err
	}
	cli.OnNotification(func(n mcp.JSONRPCNotification) {
		if n.Method == "notifications/tools/list_changed" {
			go func() { _ = refresh() }()
		}
	})
	return server.NewStdioServer(proxy).Listen(ctx, in, out)
}
func Probe(ctx context.Context, endpoint string, out io.Writer) error {
	cli, info, err := Connect(ctx, endpoint)
	if err != nil {
		return err
	}
	defer cli.Close()
	tools, err := cli.ListTools(ctx, mcp.ListToolsRequest{})
	if err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(map[string]any{"server_name": info.ServerInfo.Name, "tools_count": len(tools.Tools)})
}
