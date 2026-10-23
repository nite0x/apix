// Package localipc connects stdio bridges to the single local runtime without TCP.
package localipc

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net"
	"net/http"
	"path/filepath"
)

func Address(database string) (string, error) {
	absolute, err := filepath.Abs(database)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(filepath.Clean(absolute)))
	return address(fmt.Sprintf("%x", sum[:12]))
}

// HTTP framing is carried only over an OS-local socket/pipe. The URL is a
// synthetic SDK routing label: the dialer never resolves a host or opens TCP.
const Endpoint = "http://apix.local/mcp"

func HTTPClient(socket string) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return Dial(ctx, socket)
			},
		},
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
}
