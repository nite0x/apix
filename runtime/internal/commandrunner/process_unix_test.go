//go:build !windows

package commandrunner

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestTimeoutAndCancellationTerminateDescendants(t *testing.T) {
	for _, test := range []struct {
		name, kind string
		timeout    int
		cancel     bool
	}{{"timeout", "timeout", 1, false}, {"cancel", "cancelled", 3, true}} {
		t.Run(test.name, func(t *testing.T) {
			runner := New()
			req := helperRequest("spawn")
			req.TimeoutSeconds = test.timeout
			ctx := context.Background()
			if test.cancel {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				timer := time.AfterFunc(500*time.Millisecond, cancel)
				defer timer.Stop()
				defer cancel()
			}
			result := runner.Run(ctx, req)
			if result.ErrorKind != test.kind {
				t.Fatalf("%+v", result)
			}
			pid, err := strconv.Atoi(strings.TrimSpace(result.Stdout))
			if err != nil {
				t.Fatal("helper did not start a descendant", result.Stdout)
			}
			deadline := time.Now().Add(time.Second)
			for time.Now().Before(deadline) {
				err = syscall.Kill(pid, 0)
				if err == syscall.ESRCH {
					return
				}
				stat, e := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
				if e != nil || strings.Contains(string(stat), ") Z ") {
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
			_ = syscall.Kill(pid, syscall.SIGKILL)
			t.Fatal("descendant survived cancellation")
		})
	}
}
