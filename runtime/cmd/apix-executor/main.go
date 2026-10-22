package main

import (
	"fmt"
	"github.com/apix/apix/runtime/internal/executionenv"
	"os"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: apix-executor check|probe|run")
		os.Exit(2)
	}
	if err := executionenv.ServeHelper(os.Args[1], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
