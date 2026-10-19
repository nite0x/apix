// demo-service is a small real MySQL-backed API for the standalone runtime example.
package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
)

func main() {
	log.SetOutput(os.Stderr)
	dsn := os.Getenv("APIX_MYSQL_DSN")
	if dsn == "" {
		log.Fatal("APIX_MYSQL_DSN is required")
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		log.Fatal("invalid MySQL DSN")
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		log.Fatal("MySQL connection failed")
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS apix_demo_users(id VARCHAR(36) PRIMARY KEY,name VARCHAR(120) NOT NULL)`); err != nil {
		log.Fatal("cannot create demo table")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /slow", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(20 * time.Second):
			_, _ = w.Write([]byte("done"))
		}
	})
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if err := db.PingContext(ctx); err != nil {
			http.Error(w, "database unavailable", 503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("POST /users", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" || len(body.Name) > 120 {
			http.Error(w, "name is required and at most 120 bytes", 400)
			return
		}
		id := uuid.NewString()
		if _, err := db.ExecContext(r.Context(), `INSERT INTO apix_demo_users(id,name) VALUES(?,?)`, id, body.Name); err != nil {
			http.Error(w, "insert failed", 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(map[string]string{"id": id, "name": body.Name})
		log.Printf("created demo user %s", id)
	})
	address := os.Getenv("APIX_DEMO_ADDR")
	if address == "" {
		address = "127.0.0.1:18767"
	}
	log.Printf("demo service listening on %s", address)
	server := &http.Server{Addr: address, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(server.ListenAndServe())
}
