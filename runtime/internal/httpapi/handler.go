package httpapi

import (
	"strings"

	"github.com/apix/apix/runtime/internal/core"
)

func replaceVars(s string, vars *core.Variables) string {
	if vars == nil || s == "" {
		return s
	}
	for name, v := range vars.Global {
		if vs, ok := v.Value.(string); ok {
			s = strings.ReplaceAll(s, "{{"+name+"}}", vs)
		}
	}
	for name, v := range vars.Session {
		if vs, ok := v.Value.(string); ok {
			s = strings.ReplaceAll(s, "{{"+name+"}}", vs)
		}
	}
	return s
}

func getVar(vars *core.Variables, name string) string {
	if vars == nil {
		return ""
	}
	if v, ok := vars.Global[name]; ok {
		if s, ok := v.Value.(string); ok {
			return s
		}
	}
	return ""
}
