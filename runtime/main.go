package main

import (
	"log"
	"os"

	"github.com/apix/apix/runtime/internal/app"
)

func main() {
	if err := app.Run(os.Args[1:]); err != nil {
		log.Fatal(err)
	}
}
