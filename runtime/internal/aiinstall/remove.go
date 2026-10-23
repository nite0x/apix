package aiinstall

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/pelletier/go-toml/v2"
)

type RemovalPreview struct {
	Target       string `json:"target"`
	Client       string `json:"client"`
	Path         string `json:"path"`
	Fingerprint  string `json:"fingerprint,omitempty"`
	CanRemove    bool   `json:"can_remove"`
	Status       string `json:"status"`
	Difference   string `json:"difference,omitempty"`
	Instructions string `json:"instructions,omitempty"`
}

func fingerprintBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

var apixSection = regexp.MustCompile(`^[ \t]*\[mcp_servers\.apix\][ \t]*(#.*)?$`)

func (s *Installer) removalPlan(target Target, id string) (*RemovalPreview, Client, []byte, []byte, error) {
	c, err := s.client(target, id)
	if err != nil {
		return nil, c, nil, nil, err
	}
	v := &RemovalPreview{Target: target.ID, Client: c.Name, Path: c.Path, Status: "manual", Instructions: "在目标 AI 工具的 MCP 设置中，找到名为 apix 的 stdio 连接，移除后重新加载工具；请保留其他连接。手动操作不会自动标记为已验证移除。"}
	if c.Status == "external" {
		return v, c, nil, nil, nil
	}
	original, exists, err := s.readConfig(c)
	if err != nil {
		return nil, c, nil, nil, err
	}
	if !exists {
		v.Status = "absent"
		v.Instructions = "已验证配置文件不存在。"
		return v, c, nil, nil, nil
	}
	v.Fingerprint = fingerprintBytes(original)
	difference := ""
	blocked := func() (*RemovalPreview, Client, []byte, []byte, error) {
		v.Status = "modified"
		v.Difference = difference + " apix 项包含与当前安装模板不同的值或附加字段。预期：" + c.Snippet + "；请在工具中审阅当前 apix 项，自动移除已停止。"
		return v, c, original, nil, nil
	}
	if id == "codex" {
		var doc, want map[string]any
		if err := toml.Unmarshal(original, &doc); err != nil {
			return nil, c, nil, nil, errors.New("现有 TOML 无效，原文件未修改")
		}
		_ = toml.Unmarshal([]byte(c.Snippet), &want)
		servers, _ := doc["mcp_servers"].(map[string]any)
		entry, found := servers["apix"]
		if !found {
			v.Status = "absent"
			return v, c, original, nil, nil
		}
		expected := want["mcp_servers"].(map[string]any)["apix"]
		if !reflect.DeepEqual(entry, expected) {
			difference = entryDifferences(entry, expected)
			return blocked()
		}
		lines := strings.SplitAfter(string(original), "\n")
		inside, foundHeader := false, false
		var out strings.Builder
		for _, line := range lines {
			text := strings.TrimSpace(line)
			if strings.HasPrefix(text, "[") {
				if apixSection.MatchString(strings.TrimSuffix(line, "\n")) {
					inside = true
					foundHeader = true
					continue
				}
				inside = false
			}
			if inside && text != "" && !strings.HasPrefix(text, "#") {
				continue
			}
			out.WriteString(line)
		}
		if !foundHeader {
			return blocked()
		}
		updated := []byte(out.String())
		var verify map[string]any
		if err := toml.Unmarshal(updated, &verify); err != nil {
			return nil, c, nil, nil, err
		}
		if m, ok := verify["mcp_servers"].(map[string]any); ok {
			if _, found := m["apix"]; found {
				return blocked()
			}
		}
		v.Status = "ready"
		v.CanRemove = true
		return v, c, original, updated, nil
	}
	doc := map[string]json.RawMessage{}
	if err := json.Unmarshal(original, &doc); err != nil || doc == nil {
		return nil, c, nil, nil, errors.New("现有 JSON 无效，原文件未修改")
	}
	root := "mcpServers"
	if id == "vscode" {
		root = "servers"
	}
	servers := map[string]json.RawMessage{}
	if raw, found := doc[root]; found {
		if err := json.Unmarshal(raw, &servers); err != nil || servers == nil {
			return nil, c, nil, nil, errors.New("MCP 配置组无效，原文件未修改")
		}
	}
	entry, found := servers["apix"]
	if !found {
		v.Status = "absent"
		return v, c, original, nil, nil
	}
	var addition map[string]map[string]json.RawMessage
	_ = json.Unmarshal([]byte(c.Snippet), &addition)
	var actual, expected any
	_ = json.Unmarshal(entry, &actual)
	_ = json.Unmarshal(addition[root]["apix"], &expected)
	if !reflect.DeepEqual(actual, expected) {
		difference = entryDifferences(actual, expected)
		return blocked()
	}
	delete(servers, "apix")
	doc[root], _ = json.Marshal(servers)
	updated, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, c, nil, nil, err
	}
	updated = append(updated, '\n')
	v.Status = "ready"
	v.CanRemove = true
	return v, c, original, updated, nil
}
func (s *Installer) remove(target Target, id, fingerprint string) (Result, error) {
	preview, c, original, updated, err := s.removalPlan(target, id)
	if err != nil {
		return Result{}, err
	}
	if !preview.CanRemove || fingerprint == "" || preview.Fingerprint != fingerprint {
		return Result{}, errors.New("配置已变化或无法确认归属，请重新预览；原文件未修改")
	}
	if bytes.Equal(original, updated) {
		return Result{}, errors.New("未找到可移除的 Apix 配置")
	}
	result, err := s.writeConfig(c, original, updated, true, "removed")
	if err != nil {
		return Result{}, err
	}
	after, _, _, _, err := s.removalPlan(target, id)
	if err != nil || after.Status != "absent" {
		return result, fmt.Errorf("配置已写入，但尚未验证移除，请检查 %s", c.Path)
	}
	delete(s.connections, target.ID+"/"+id)
	return result, nil
}
func (s *Installer) removalRoutes(g *gin.RouterGroup) {
	g.POST("/:id/removal-preview", func(c *gin.Context) {
		var in struct {
			Target string `json:"target"`
		}
		if err := c.ShouldBindJSON(&in); err != nil || in.Target == "" {
			c.JSON(400, gin.H{"error": "请选择目标系统"})
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		target, err := s.target(in.Target)
		if err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		v, _, _, _, err := s.removalPlan(target, c.Param("id"))
		if err != nil {
			c.JSON(409, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, v)
	})
	g.POST("/:id/remove", func(c *gin.Context) {
		var in struct {
			Target      string `json:"target"`
			Fingerprint string `json:"fingerprint"`
		}
		if err := c.ShouldBindJSON(&in); err != nil || in.Target == "" {
			c.JSON(400, gin.H{"error": "请选择目标系统"})
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		target, err := s.target(in.Target)
		if err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		v, err := s.remove(target, c.Param("id"), in.Fingerprint)
		if err != nil {
			c.JSON(409, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, v)
	})
}

// Describe changed fields without echoing user credentials into a preview.
func entryDifferences(actual, expected any) string {
	a, _ := actual.(map[string]any)
	e, _ := expected.(map[string]any)
	keys := map[string]bool{}
	for k := range a {
		keys[k] = true
	}
	for k := range e {
		keys[k] = true
	}
	out := []string{}
	for k := range keys {
		av, aok := a[k]
		ev, eok := e[k]
		if reflect.DeepEqual(av, ev) && aok == eok {
			continue
		}
		change := "值已修改"
		if !aok {
			change = "当前缺少该字段"
		} else if !eok {
			change = "当前新增该字段"
		}
		out = append(out, k+": "+change)
	}
	sort.Strings(out)
	return strings.Join(out, "；")
}
