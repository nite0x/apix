package executionenv

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
)

// ServeHelper is a private, versioned stdio protocol. It owns exactly one foreground
// execution; control EOF cleans up its Linux process group even if Windows dies.
func ServeHelper(mode string, in io.Reader, out io.Writer) error {
	if mode != "check" && mode != "probe" && mode != "run" && mode != "config" {
		return errors.New("unknown executor mode")
	}
	os.Setenv("APIX_EXECUTOR", "1")
	decoder := json.NewDecoder(io.LimitReader(in, 32<<20))
	var request message
	if err := decoder.Decode(&request); err != nil {
		return err
	}
	if request.Protocol != Protocol {
		return errors.New("executor protocol mismatch")
	}
	request.Spec.EnvironmentID = ""
	reply := message{Protocol: Protocol, Type: "result"}
	switch mode {
	case "config":
		v, err := configOperation(request.Config)
		reply.Config = v
		if err != nil {
			reply.Error = err.Error()
		}
		return encode(out, reply)
	case "check":
		info, err := Check(context.Background(), request.Spec)
		info.User = os.Getenv("USER")
		if v, e := exec.Command("id", "-un").Output(); e == nil {
			info.User = strings.TrimSpace(string(v))
		}
		reply.Info = info
		if err != nil {
			reply.Error = err.Error()
		}
		return encode(out, reply)
	case "probe":
		reply.Health = Probe(context.Background(), "", request.Address)
		return encode(out, reply)
	}
	var writeMu sync.Mutex
	send := func(m message) error { writeMu.Lock(); defer writeMu.Unlock(); return encode(out, m) }
	// Start acknowledgement precedes all logs, including very early child output.
	var gate sync.Mutex
	gate.Lock()
	stdout := &eventWriter{send: send, kind: "stdout", gate: &gate}
	stderr := &eventWriter{send: send, kind: "stderr", gate: &gate}
	proc, err := Start(context.Background(), request.Spec, stdout, stderr)
	if err != nil {
		gate.Unlock()
		return send(message{Type: "started", Error: err.Error()})
	}
	if err = send(message{Type: "started", PID: proc.PID()}); err != nil {
		gate.Unlock()
		_ = proc.Stop()
		_ = proc.Wait()
		return err
	}
	gate.Unlock()
	go func() {
		var control message
		// Closing or corrupting the control channel also releases only this execution.
		_ = decoder.Decode(&control)
		_ = proc.Stop()
	}()
	waitErr := proc.Wait()
	cleanupErr := proc.Stop()
	exit := message{Type: "exit", Code: proc.ExitCode()}
	if waitErr != nil {
		exit.Error = waitErr.Error()
	}
	if cleanupErr != nil {
		exit.CleanupError = cleanupErr.Error()
	}
	// The reader may remain blocked until this process exits; never wait on it.
	return send(exit)
}

type eventWriter struct {
	send func(message) error
	kind string
	gate *sync.Mutex
}

func (w *eventWriter) Write(data []byte) (int, error) {
	w.gate.Lock()
	defer w.gate.Unlock()
	// Bound frames independently from the service's bounded durable log storage.
	for start := 0; start < len(data); start += 8192 {
		end := start + 8192
		if end > len(data) {
			end = len(data)
		}
		if err := w.send(message{Type: w.kind, Data: data[start:end]}); err != nil {
			return start, fmt.Errorf("executor output: %w", err)
		}
	}
	return len(data), nil
}
