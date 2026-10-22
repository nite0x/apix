package app

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestDesktopControl(t *testing.T) {
	for _, input := range []string{"shutdown\n", "ignored\nshutdown\n", ""} {
		calls := 0
		watchDesktopControl(strings.NewReader(input), func() { calls++ })
		if calls != 1 {
			t.Fatalf("input %q: shutdown called %d times", input, calls)
		}
	}
}

func TestDesktopReady(t *testing.T) {
	var output bytes.Buffer
	if err := desktopReady(&output, "127.0.0.1:12345"); err != nil {
		t.Fatal(err)
	}
	var message map[string]string
	if err := json.Unmarshal(output.Bytes(), &message); err != nil || message["type"] != "ready" || message["url"] != "http://127.0.0.1:12345/" {
		t.Fatalf("invalid handshake: %s (%v)", &output, err)
	}
}
