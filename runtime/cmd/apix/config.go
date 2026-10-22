//go:build windows

package main

import (
	"fmt"
	"net"
	"strconv"
)

// APIX_ADDR permits isolated acceptance tests and explicit loopback overrides.
// Keep the installed app separate from the WSL development workspace on 4317.
func desktopAddress(value string) (string, error) {
	if value == "" {
		return "127.0.0.1:4319", nil
	}
	host, port, err := net.SplitHostPort(value)
	number, portErr := strconv.Atoi(port)
	if err != nil || portErr != nil || host != "127.0.0.1" || number < 1 || number > 65535 {
		return "", fmt.Errorf("APIX_ADDR 必须是 127.0.0.1:<1–65535>，当前值：%q", value)
	}
	return value, nil
}
