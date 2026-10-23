package localipc

import (
	"context"
	"net/http"
	"path/filepath"
	"testing"
	"time"
)

func TestLocalListenerOwnershipAndRestart(t *testing.T) {
	database := filepath.Join(t.TempDir(), "apix.db")
	socket, err := Address(database)
	if err != nil {
		t.Fatal(err)
	}
	if again, _ := Address(database); again != socket {
		t.Fatal("MCP address changed across startup")
	}
	l, err := Listen(socket)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if duplicate, err := Listen(socket); err == nil {
		duplicate.Close()
		t.Fatal("duplicate runtime acquired the same MCP listener")
	}
	s := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })}
	defer s.Close()
	go s.Serve(l)
	client := HTTPClient(socket)
	defer client.CloseIdleConnections()
	client.Timeout = time.Second
	r, err := client.Get(Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != 204 {
		t.Fatal(r.Status)
	}
	s.Close()
	if l, err = Listen(socket); err != nil {
		t.Fatal("could not restart local MCP listener", err)
	}
	l.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if conn, err := Dial(ctx, socket); err == nil {
		conn.Close()
		t.Fatal("MCP listener survived shutdown")
	}
}
