package aiinstall

import (
	"bytes"
	"encoding/json"
	"github.com/apix/apix/runtime/internal/executionenv"
	"github.com/pelletier/go-toml/v2"
	"os"
	"path/filepath"
	"testing"
)

func TestWSLStdioInstallBackupConflictAndRemoval(t *testing.T) {
	for _, id := range []string{"codex", "claude", "cursor", "vscode"} {
		t.Run(id, func(t *testing.T) {
			s, _ := fixture(t)
			home := t.TempDir()
			target := Target{ID: executionenv.WSLID("Ubuntu", "user"), EnvironmentID: "local", Home: home, config: filepath.Join(home, ".config"), bridge: "/mnt/c/Users/中文 User/Apix/apix-runtime.exe"}
			client, err := s.client(target, id)
			if err != nil {
				t.Fatal(err)
			}
			original := []byte(`{"theme":"dark","mcpServers":{"existing":{"command":"keep"}},"servers":{"existing":{"command":"keep"}}}`)
			if id == "codex" {
				original = []byte("# keep comment\nmodel = \"existing\"\n[mcp_servers.other]\ncommand = \"keep\"\n")
			}
			put(t, client.Path, string(original))
			result, err := s.install(target, id)
			if err != nil || result.Backup == "" {
				t.Fatalf("%+v %v", result, err)
			}
			backup, _ := os.ReadFile(result.Backup)
			if !bytes.Equal(backup, original) {
				t.Fatal("changed backup")
			}
			data, _ := os.ReadFile(client.Path)
			if id == "codex" {
				var doc map[string]any
				if err = toml.Unmarshal(data, &doc); err != nil {
					t.Fatal(err)
				}
				entry := doc["mcp_servers"].(map[string]any)["apix"].(map[string]any)
				if !s.matches(client, entry) {
					t.Fatal(entry)
				}
			} else {
				var doc map[string]any
				if err = json.Unmarshal(data, &doc); err != nil {
					t.Fatal(err)
				}
				root := "mcpServers"
				if id == "vscode" {
					root = "servers"
				}
				if !s.matches(client, doc[root].(map[string]any)["apix"].(map[string]any)) {
					t.Fatal(doc)
				}
			}
			if _, err = s.install(target, id); err != nil {
				t.Fatal("not idempotent", err)
			}
			preview, _, _, _, err := s.removalPlan(target, id)
			if err != nil || !preview.CanRemove {
				t.Fatalf("%+v %v", preview, err)
			}
			if _, err = s.remove(target, id, preview.Fingerprint); err != nil {
				t.Fatal(err)
			}
			data, _ = os.ReadFile(client.Path)
			if !bytes.Contains(data, []byte("keep")) {
				t.Fatal("lost unrelated configuration")
			}
			put(t, client.Path, string(original))
			different := target
			different.bridge = "/mnt/c/Other/apix-runtime.exe"
			if _, err = s.install(different, id); err != nil {
				t.Fatal(err)
			}
			if _, err = s.install(target, id); err == nil {
				t.Fatal("overwrote conflicting bridge")
			}
		})
	}
}
