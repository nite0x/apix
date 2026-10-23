package aiinstall

import (
	"encoding/json"
	"net"
	"net/url"
	"reflect"
	"strings"
)

// Upgrade only the old generated templates, never entries with custom fields,
// credentials or disabled settings. writeConfig still backs up before replacing.
func legacyEntry(c Client, entry map[string]any) bool {
	copy := make(map[string]any, len(entry))
	for k, v := range entry {
		copy[k] = v
	}
	kind := copy["type"]
	if kind != nil {
		if c.ID == "codex" {
			return false
		}
		delete(copy, "type")
	}
	if len(copy) == 1 && localURL(copy["url"]) {
		return kind == "http" || kind == "streamable-http" || (kind == nil && (c.ID == "codex" || c.ID == "cursor"))
	}
	if len(copy) != 2 || copy["command"] != c.Command || (kind != "stdio" && !(kind == nil && (c.ID == "codex" || c.ID == "cursor"))) {
		return false
	}
	raw, _ := json.Marshal(copy["args"])
	var args []string
	if json.Unmarshal(raw, &args) != nil || len(args) != len(c.Args) {
		return false
	}
	n := len(args)
	return n >= 3 && reflect.DeepEqual(args[:n-3], c.Args[:n-3]) && args[n-3] == "mcp-stdio" && args[n-2] == "--url" && localURL(args[n-1])
}

func localURL(value any) bool {
	text, ok := value.(string)
	if !ok {
		return false
	}
	u, err := url.Parse(text)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Path != "/mcp" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	ip := net.ParseIP(u.Hostname())
	return u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())
}

func upgradeTOML(original []byte, snippet string) ([]byte, bool) {
	lines := strings.SplitAfter(string(original), "\n")
	inside, replaced := false, false
	var out strings.Builder
	for _, line := range lines {
		text := strings.TrimSpace(line)
		if strings.HasPrefix(text, "[") {
			inside = apixSection.MatchString(strings.TrimSuffix(line, "\n"))
			if inside {
				out.WriteString(line)
				if !strings.HasSuffix(line, "\n") {
					out.WriteByte('\n')
				}
				out.WriteString(strings.TrimPrefix(snippet, "[mcp_servers.apix]\n"))
				replaced = true
				continue
			}
		}
		if inside && text != "" && !strings.HasPrefix(text, "#") {
			continue
		}
		out.WriteString(line)
	}
	return []byte(out.String()), replaced
}
