package main

import (
	"context"
	"fmt"
	"github.com/apix/apix/runtime/internal/mcpbridge"
	"log"
	"os"
	"time"

	"github.com/apix/apix/runtime/internal/app"
)

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "mcp-stdio" || os.Args[1] == "mcp-probe") {
		if len(os.Args) != 4 || os.Args[2] != "--socket" {
			fmt.Fprintln(os.Stderr, "usage: apix-runtime mcp-stdio|mcp-probe --socket <local socket or named pipe>")
			os.Exit(2)
		}
		var err error
		if os.Args[1] == "mcp-stdio" {
			err = mcpbridge.Serve(context.Background(), os.Args[3], os.Stdin, os.Stdout)
		} else {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			err = mcpbridge.Probe(ctx, os.Args[3], os.Stdout)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	if err := app.Run(os.Args[1:]); err != nil {
		log.Fatal(err)
	}
}
