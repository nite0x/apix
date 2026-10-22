//go:build !windows

package executionenv

import "os/exec"

func hideWindow(cmd *exec.Cmd) {}
