package aiinstall

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
)

func TestLegacyHTTPUpgradePreservesSettingsAndBacksUp(t *testing.T) {
	for _, id := range []string{"codex", "claude", "cursor", "vscode"} {
		t.Run(id, func(t *testing.T) {
			s, target := fixture(t)
			c, _ := s.client(target, id)
			root := "mcpServers"
			if id == "vscode" {
				root = "servers"
			}
			doc := map[string]any{"setting": "keep", root: map[string]any{"other": map[string]string{"command": "keep"}, "apix": map[string]string{"url": "http://127.0.0.1:4319/mcp", "type": "http"}}}
			original, _ := json.Marshal(doc)
			if id == "codex" {
				original = []byte("# keep\nmodel = 'keep'\n[mcp_servers.apix]\n# keep section comment\nurl = 'http://127.0.0.1:4319/mcp'\n[mcp_servers.other]\ncommand = 'keep'\n")
			}
			put(t, c.Path, string(original))
			if got := s.list(target); got[0].Status == "blocked" && id == "codex" {
				t.Fatal("legacy configuration was blocked")
			}
			result, err := s.install(target, id)
			if err != nil || result.Status != "installed" || result.Backup == "" {
				t.Fatalf("%+v %v", result, err)
			}
			backup, _ := os.ReadFile(result.Backup)
			if !bytes.Equal(backup, original) {
				t.Fatal("backup changed")
			}
			updated, _ := os.ReadFile(c.Path)
			if strings.Contains(string(updated), "http://") || !strings.Contains(string(updated), "keep") {
				t.Fatal(string(updated))
			}
			if result, err := s.install(target, id); err != nil || result.Status != "configured" {
				t.Fatal("upgrade was not idempotent", err)
			}
		})
	}
}

func TestLegacyWSLBridgeUpgrade(t *testing.T) {
	for _, id := range []string{"codex", "claude", "cursor", "vscode"} {
		t.Run(id, func(t *testing.T) {
			s, target := fixture(t)
			target.EnvironmentID = "local"
			target.bridge = "/mnt/c/Users/中文 User/Apix/apix-runtime.exe"
			target.bridgeArgs = nil
			c, _ := s.client(target, id)
			var doc map[string]any
			root := "mcpServers"
			if id == "codex" {
				root = "mcp_servers"
				_ = toml.Unmarshal([]byte(c.Snippet), &doc)
			} else {
				_ = json.Unmarshal([]byte(c.Snippet), &doc)
				if id == "vscode" {
					root = "servers"
				}
			}
			entry := doc[root].(map[string]any)["apix"].(map[string]any)
			entry["args"] = []string{"mcp-stdio", "--url", "http://127.0.0.1:4319/mcp"}
			var original []byte
			if id == "codex" {
				original, _ = toml.Marshal(doc)
			} else {
				original, _ = json.Marshal(doc)
			}
			put(t, c.Path, string(original))
			result, err := s.install(target, id)
			if err != nil || result.Status != "installed" || result.Backup == "" {
				t.Fatalf("%+v %v", result, err)
			}
			data, _ := os.ReadFile(c.Path)
			if strings.Contains(string(data), "--url") || !strings.Contains(string(data), "--socket") {
				t.Fatal(string(data))
			}
		})
	}
}

func TestUpgradeDoesNotChangeUnrelatedTOMLValues(t *testing.T) {
	s, target := fixture(t)
	c, _ := s.client(target, "codex")
	original := "model = '''\n[mcp_servers.apix]\nurl = 'this is model text'\n'''\n[mcp_servers.apix]\nurl = 'http://127.0.0.1:4319/mcp'\n"
	put(t, c.Path, original)
	if _, err := s.install(target, "codex"); err == nil {
		t.Fatal("ambiguous TOML migration was accepted")
	}
	data, _ := os.ReadFile(c.Path)
	if string(data) != original {
		t.Fatal("unrelated TOML text was changed")
	}
}

func TestWindowsClientCommandsRetainWSLUserAndLiteralArguments(t *testing.T) {
	s, target := fixture(t)
	target.bridge = "wsl.exe"
	target.bridgeArgs = []string{"--distribution", "Ubuntu", "--user", "test-user", "--exec", "/home/test-user/中文 Space/apix-runtime"}
	target.config = filepath.Join(target.Home, "AppData", "Roaming")
	for _, id := range []string{"codex", "claude", "cursor", "vscode"} {
		c, _ := s.client(target, id)
		if c.Command != "wsl.exe" || !strings.Contains(c.Snippet, "--user") || !strings.Contains(c.Snippet, "--socket") || strings.Contains(c.Snippet, "http://") {
			t.Fatal(c.Snippet)
		}
		if _, err := s.install(target, id); err != nil {
			t.Fatal(err)
		}
	}
}

func TestStdioTransportMismatchIsBlocked(t *testing.T) {
	s, target := fixture(t)
	c, _ := s.client(target, "claude")
	var doc map[string]map[string]map[string]any
	_ = json.Unmarshal([]byte(c.Snippet), &doc)
	doc["mcpServers"]["apix"]["type"] = "http"
	raw, _ := json.Marshal(doc)
	put(t, c.Path, string(raw))
	if _, err := s.install(target, "claude"); err == nil {
		t.Fatal("HTTP type with a stdio command was accepted")
	}
}
