package aiinstall

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/pelletier/go-toml/v2"
)

func fixture(t *testing.T) (*Installer, Target) {
	t.Helper()
	home := t.TempDir()
	target := Target{ID: "local", Home: home, Name: "Test", config: filepath.Join(home, "config")}
	return &Installer{endpoint: "http://127.0.0.1:4317/mcp", targets: []Target{target}}, target
}
func put(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}
func TestInstallMergesBacksUpAndIsIdempotent(t *testing.T) {
	for _, id := range []string{"codex", "claude", "cursor", "vscode"} {
		t.Run(id, func(t *testing.T) {
			s, target := fixture(t)
			c, _ := s.client(target, id)
			original := `{"theme":"dark","precise":12345678901234567890,"mcpServers":{"existing":{"command":"keep"}},"servers":{"existing":{"command":"keep"}}}`
			if id == "codex" {
				original = "# Keep this comment\nmodel = \"example\"\n[mcp_servers.existing]\ncommand = \"keep\"\n"
			}
			put(t, c.Path, original)
			result, err := s.install(target, id)
			if err != nil || result.Status != "installed" || result.Backup == "" {
				t.Fatalf("%+v %v", result, err)
			}
			backup, _ := os.ReadFile(result.Backup)
			if string(backup) != original {
				t.Fatal("backup changed original")
			}
			updated, _ := os.ReadFile(c.Path)
			if !strings.Contains(string(updated), "keep") {
				t.Fatal("lost existing server")
			}
			if id == "codex" {
				if !strings.HasPrefix(string(updated), original) {
					t.Fatal("TOML comments/settings changed")
				}
				var doc map[string]any
				if err := toml.Unmarshal(updated, &doc); err != nil {
					t.Fatal(err)
				}
				if doc["mcp_servers"].(map[string]any)["apix"].(map[string]any)["url"] != s.endpoint {
					t.Fatal("missing MCP URL")
				}
			} else {
				if !strings.Contains(string(updated), "12345678901234567890") {
					t.Fatal("lost numeric precision")
				}
				var doc map[string]any
				if err := json.Unmarshal(updated, &doc); err != nil {
					t.Fatal(err)
				}
				root := "mcpServers"
				if id == "vscode" {
					root = "servers"
				}
				entry := doc[root].(map[string]any)["apix"].(map[string]any)
				if entry["url"] != s.endpoint {
					t.Fatal("missing MCP URL")
				}
				if id != "cursor" && entry["type"] != "http" {
					t.Fatal("wrong transport")
				}
			}
			again, err := s.install(target, id)
			if err != nil || again.Status != "configured" || again.Backup != "" {
				t.Fatalf("%+v %v", again, err)
			}
			actual, _ := os.ReadFile(c.Path)
			if string(actual) != string(updated) {
				t.Fatal("repeat install rewrote configuration")
			}
			info, _ := os.Stat(c.Path)
			if info.Mode().Perm() != 0600 {
				t.Fatal("permissions changed")
			}
		})
	}
}
func TestFreshInstallAndCustomHomes(t *testing.T) {
	s, target := fixture(t)
	target.codex = filepath.Join(target.Home, "custom-codex")
	target.claude = filepath.Join(target.Home, "custom-claude")
	for _, id := range []string{"codex", "claude", "cursor", "vscode"} {
		c, _ := s.client(target, id)
		result, err := s.install(target, id)
		if err != nil || result.Backup != "" || result.Status != "installed" {
			t.Fatalf("%s: %+v %v", id, result, err)
		}
		if _, err := os.Stat(c.Path); err != nil {
			t.Fatal(err)
		}
	}
	if c, _ := s.client(target, "codex"); !strings.HasPrefix(c.Path, target.codex) {
		t.Fatal("CODEX_HOME ignored")
	}
	if c, _ := s.client(target, "claude"); !strings.HasPrefix(c.Path, target.claude) {
		t.Fatal("CLAUDE_CONFIG_DIR ignored")
	}
}
func TestUnsafeConfigsRemainUntouched(t *testing.T) {
	for _, tc := range []struct{ id, content string }{
		{"cursor", `{"mcpServers":{"apix":{"url":"http://other/mcp"}}}`},
		{"claude", `{"mcpServers":{"apix":{"url":"http://127.0.0.1:4317/mcp"}}}`},
		{"cursor", `{"mcpServers":{"apix":{"url":"http://127.0.0.1:4317/mcp","disabled":true}}}`},
		{"cursor", `{"mcpServers":{"apix":{"url":"http://127.0.0.1:4317/mcp","type":"sse"}}}`},
		{"cursor", `{"mcpServers":[]}`},
		{"cursor", `null`},
		{"cursor", `// comment`},
		{"codex", "[broken"},
		{"codex", "[mcp_servers.apix]\nurl = \"http://other/mcp\""},
		{"codex", "[mcp_servers.apix]\nurl = \"http://127.0.0.1:4317/mcp\"\nenabled = false"},
		{"codex", "mcp_servers = {}"},
	} {
		t.Run(tc.id+tc.content, func(t *testing.T) {
			s, target := fixture(t)
			c, _ := s.client(target, tc.id)
			put(t, c.Path, tc.content)
			if _, err := s.install(target, tc.id); err == nil {
				t.Fatal("unsafe config accepted")
			}
			actual, _ := os.ReadFile(c.Path)
			if string(actual) != tc.content {
				t.Fatal("original changed")
			}
		})
	}
}
func TestSymlinkRefused(t *testing.T) {
	s, target := fixture(t)
	c, _ := s.client(target, "cursor")
	other := filepath.Join(target.Home, "original.json")
	put(t, other, "{}")
	if err := os.MkdirAll(filepath.Dir(c.Path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, c.Path); err != nil {
		t.Skip(err)
	}
	if _, err := s.install(target, "cursor"); err == nil {
		t.Fatal("symlink accepted")
	}
	original, _ := os.ReadFile(other)
	if string(original) != "{}" {
		t.Fatal("symlink target modified")
	}
}
func TestTRAEOfficialInstallLinks(t *testing.T) {
	s, target := fixture(t)
	c, _ := s.client(target, "trae")
	for name, link := range c.Links {
		parsed, err := url.Parse(link)
		if err != nil {
			t.Fatal(err)
		}
		if parsed.Host != "trae.ai-ide" || parsed.Path != "/mcp-import" || parsed.Query().Get("type") != "http" || parsed.Query().Get("name") != "apix" {
			t.Fatal(link)
		}
		if name == "国内版" && parsed.Scheme != "trae-cn" {
			t.Fatal(link)
		}
		decoded, err := base64.StdEncoding.DecodeString(parsed.Query().Get("config"))
		if err != nil {
			t.Fatal(err)
		}
		var entry map[string]string
		if json.Unmarshal(decoded, &entry) != nil || entry["url"] != s.endpoint {
			t.Fatal(string(decoded))
		}
	}
}
func TestRoutesValidateOriginTargetAndClient(t *testing.T) {
	gin.SetMode(gin.TestMode)
	s, _ := fixture(t)
	s.probe = func(context.Context, Target, string) (probeResult, error) {
		return probeResult{ServerName: "apix", ToolsCount: 1}, nil
	}
	r := gin.New()
	s.Routes(r)
	call := func(method, path, body, contentType, origin string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, "http://127.0.0.1:4317"+path, strings.NewReader(body))
		if contentType != "" {
			request.Header.Set("Content-Type", contentType)
		}
		if origin != "" {
			request.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, request)
		return w
	}
	request := httptest.NewRequest("GET", "http://evil.test/api/ai-tools", nil)
	denied := httptest.NewRecorder()
	r.ServeHTTP(denied, request)
	if denied.Code != 403 {
		t.Fatal("untrusted Host accepted")
	}
	w := call("GET", "/api/ai-tools", "", "", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "TRAE") || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Body.String())
	}
	for _, tc := range []struct {
		path, body, contentType, origin string
		code                            int
	}{
		{"/api/ai-tools/cursor/install", `{"target":"local"}`, "text/plain", "", 415},
		{"/api/ai-tools/cursor/install", `{"target":"local"}`, "application/json", "https://evil.test", 403},
		{"/api/ai-tools/cursor/install", `{"target":"unknown"}`, "application/json", "", 400},
		{"/api/ai-tools/cursor/install", `{}`, "application/json", "", 400},
		{"/api/ai-tools/unknown/install", `{"target":"local"}`, "application/json", "", 409},
		{"/api/ai-tools/cursor/install", `{"target":"local"}`, "application/json", "http://127.0.0.1:4317", 200},
	} {
		if w := call("POST", tc.path, tc.body, tc.contentType, tc.origin); w.Code != tc.code {
			t.Fatalf("%+v: %d %s", tc, w.Code, w.Body.String())
		}
	}
}

func TestRemovalBacksUpOnlyRecognizedApixEntryAndDetectsConcurrentEdits(t *testing.T) {
	for _, id := range []string{"codex", "claude", "cursor", "vscode"} {
		t.Run(id, func(t *testing.T) {
			s, target := fixture(t)
			c, _ := s.client(target, id)
			original := `{"precise":12345678901234567890,"mcpServers":{"other":{"command":"keep"}},"servers":{"other":{"command":"keep"}}}`
			if id == "codex" {
				original = "# preserve comment\nmodel = \"keep\"\n[mcp_servers.other]\ncommand=\"keep\"\n"
			}
			put(t, c.Path, original)
			if _, err := s.install(target, id); err != nil {
				t.Fatal(err)
			}
			preview, _, _, _, err := s.removalPlan(target, id)
			if err != nil || !preview.CanRemove {
				t.Fatal(preview, err)
			}
			current, _ := os.ReadFile(c.Path)
			if err := os.WriteFile(c.Path, append(current, ' '), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := s.remove(target, id, preview.Fingerprint); err == nil {
				t.Fatal("ignored concurrent modification")
			}
			if err := os.WriteFile(c.Path, current, 0600); err != nil {
				t.Fatal(err)
			}
			result, err := s.remove(target, id, preview.Fingerprint)
			if err != nil || result.Status != "removed" || result.Backup == "" {
				t.Fatal(result, err)
			}
			after, _ := os.ReadFile(c.Path)
			if !strings.Contains(string(after), "keep") || strings.Contains(string(after), s.endpoint) {
				t.Fatal("lost other settings or retained apix", string(after))
			}
			if id != "codex" && !strings.Contains(string(after), "12345678901234567890") {
				t.Fatal("lost JSON number precision")
			}
		})
	}
	s, target := fixture(t)
	c, _ := s.client(target, "cursor")
	put(t, c.Path, `{"mcpServers":{"apix":{"url":"http://127.0.0.1:4317/mcp","headers":{"Authorization":"user-owned"}}}}`)
	p, _, _, _, err := s.removalPlan(target, "cursor")
	if err != nil || p.CanRemove || p.Status != "modified" {
		t.Fatal("user modified entry removable", p, err)
	}
}
