package localipc

import (
	"context"
	"fmt"
	"net"
	"strings"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func userSID() (string, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}

func address(key string) (string, error) {
	sid, err := userSID()
	if err != nil {
		return "", err
	}
	return `\\.\pipe\apix-` + sid + "-" + key, nil
}

func Listen(socket string) (net.Listener, error) {
	sid, err := userSID()
	if err != nil {
		return nil, err
	}
	return winio.ListenPipe(socket, &winio.PipeConfig{
		SecurityDescriptor: fmt.Sprintf("D:P(A;;GA;;;%s)", sid),
		InputBufferSize:    65536, OutputBufferSize: 65536,
	})
}

func Dial(ctx context.Context, socket string) (net.Conn, error) {
	if !strings.HasPrefix(socket, `\\.\pipe\apix-`) {
		return nil, fmt.Errorf("MCP requires a local Apix named pipe")
	}
	return winio.DialPipeContext(ctx, socket)
}
