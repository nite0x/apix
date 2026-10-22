package app

import (
	"bufio"
	"encoding/json"
	"io"
)

// stdout carries only this handshake in desktop mode; normal logs use stderr.
func desktopReady(output io.Writer, address string) error {
	return json.NewEncoder(output).Encode(map[string]string{
		"type": "ready", "url": "http://" + address + "/",
	})
}

func watchDesktopControl(input io.Reader, shutdown func()) {
	defer shutdown()
	scanner := bufio.NewScanner(input)
	for scanner.Scan() {
		if scanner.Text() == "shutdown" {
			return
		}
	}
}
