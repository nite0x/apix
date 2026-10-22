// Package mcpbridge forwards a stdio client's tools to the single HTTP runtime.
package mcpbridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	mcpclient "github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/client/transport"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
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
	cli, err := mcpclient.NewStreamableHttpClient(endpoint, transport.WithHTTPBasicClient(&http.Client{Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 2 * time.Second, KeepAlive: 30 * time.Second}).DialContext, IdleConnTimeout: 30 * time.Second}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}))
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

// A bridge keeps its stdio session and cached tool definitions alive while the
// Windows runtime restarts. Only the HTTP session is replaced.
type bridge struct {
	ctx      context.Context
	endpoint string
	proxy    *server.MCPServer

	mu      sync.Mutex
	client  *mcpclient.Client
	changed chan struct{}
	wake    chan struct{}
	refresh chan *mcpclient.Client
}

func Serve(ctx context.Context, endpoint string, in io.Reader, out io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	setup, stop := context.WithTimeout(ctx, 10*time.Second)
	cli, info, err := Connect(setup, endpoint)
	stop()
	if err != nil {
		return err
	}
	b := &bridge{
		ctx: ctx, endpoint: endpoint,
		proxy:   server.NewMCPServer("apix", info.ServerInfo.Version, server.WithToolCapabilities(true), server.WithInstructions(info.Instructions)),
		changed: make(chan struct{}), wake: make(chan struct{}, 1), refresh: make(chan *mcpclient.Client, 1),
	}
	setup, stop = context.WithTimeout(ctx, 10*time.Second)
	err = b.install(setup, cli)
	stop()
	if err != nil {
		cli.Close()
		return err
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		b.maintain()
	}()
	defer func() {
		cancel()
		<-done
	}()
	return server.NewStdioServer(b.proxy).Listen(ctx, in, out)
}

// install publishes a fully initialized session and complete catalog together.
// Only the maintenance goroutine (or initial setup) updates the catalog.
func (b *bridge) install(ctx context.Context, cli *mcpclient.Client) error {
	cli.OnNotification(func(n mcp.JSONRPCNotification) {
		if n.Method == "notifications/tools/list_changed" {
			select {
			case b.refresh <- cli:
			default:
			}
		}
	})
	if err := b.updateTools(ctx, cli); err != nil {
		return err
	}
	b.mu.Lock()
	b.client = cli
	close(b.changed)
	b.changed = make(chan struct{})
	b.mu.Unlock()
	return nil
}

func (b *bridge) updateTools(ctx context.Context, cli *mcpclient.Client) error {
	tools, err := cli.ListTools(ctx, mcp.ListToolsRequest{})
	if err != nil {
		return err
	}
	definitions := make([]server.ServerTool, 0, len(tools.Tools))
	for _, tool := range tools.Tools {
		// Resolve the current HTTP session for every invocation. Capturing cli
		// here would leave cached stdio handlers tied to the old runtime.
		definitions = append(definitions, server.ServerTool{Tool: tool, Handler: b.call})
	}
	b.proxy.SetTools(definitions...)
	return nil
}

func (b *bridge) current() (*mcpclient.Client, <-chan struct{}) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.client, b.changed
}

func (b *bridge) invalidate(cli *mcpclient.Client) {
	b.mu.Lock()
	if b.client != cli {
		b.mu.Unlock()
		return
	}
	b.client = nil
	close(b.changed)
	b.changed = make(chan struct{})
	b.mu.Unlock()
	select {
	case b.wake <- struct{}{}:
	default:
	}
	// Close cancels obsolete in-flight requests and is bounded by the SDK.
	cli.Close()
}

func (b *bridge) maintain() {
	defer func() {
		if cli, _ := b.current(); cli != nil {
			b.invalidate(cli)
		}
	}()
	delay := 250 * time.Millisecond
	for b.ctx.Err() == nil {
		cli, _ := b.current()
		if cli == nil {
			setup, cancel := context.WithTimeout(b.ctx, 10*time.Second)
			next, _, err := Connect(setup, b.endpoint)
			if err == nil {
				err = b.install(setup, next)
				if err != nil {
					next.Close()
				}
			}
			cancel()
			if err == nil {
				delay = 250 * time.Millisecond
				continue
			}
			select {
			case <-b.ctx.Done():
				return
			case <-time.After(delay):
			}
			delay = min(delay*2, 5*time.Second)
			continue
		}
		var refresh bool
		select {
		case <-b.ctx.Done():
			return
		case <-b.wake:
			continue
		case source := <-b.refresh:
			if source != cli {
				continue
			}
			refresh = true
		case <-time.After(2 * time.Second):
		}
		check, cancel := context.WithTimeout(b.ctx, 2*time.Second)
		var err error
		if refresh {
			err = b.updateTools(check, cli)
		} else {
			err = cli.Ping(check)
		}
		cancel()
		if err != nil {
			b.invalidate(cli)
		}
	}
}

func (b *bridge) call(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	// Waiting for recovery is bounded independently of tool execution time.
	ready, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for {
		if err := ready.Err(); err != nil {
			return nil, fmt.Errorf("Apix is unavailable; reconnecting in the background: %w", err)
		}
		cli, changed := b.current()
		if cli == nil {
			select {
			case <-b.ctx.Done():
				return nil, b.ctx.Err()
			case <-ready.Done():
			case <-changed:
			}
			continue
		}
		// A harmless preflight catches an idle restart / expired session before
		// dispatching a potentially mutating tool. Never replay tools/call.
		check, stop := context.WithTimeout(ready, 2*time.Second)
		err := cli.Ping(check)
		stop()
		if err != nil {
			if ready.Err() != nil {
				return nil, ready.Err()
			}
			b.invalidate(cli)
			continue
		}
		result, err := cli.CallTool(ctx, request)
		var transportError *transport.Error
		if err != nil && ctx.Err() == nil && errors.As(err, &transportError) {
			b.invalidate(cli)
			return nil, fmt.Errorf("Apix connection lost; tool outcome is unknown and the call was not replayed. Reconnecting for subsequent calls: %w", err)
		}
		return result, err
	}
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
