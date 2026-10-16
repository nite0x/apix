package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgproto3"
)

func TestDatabaseDriverSettingsAndMigration(t *testing.T) {
	s, metadata := testService(t)
	ctx := context.Background()
	password := " secret:@/?#中文'\\ "
	for _, kind := range []string{"mysql", "postgresql", "hologres"} {
		item, err := s.SaveConnection(ctx, ConnectionInput{Connection: Connection{Name: kind, Type: kind, Host: "::1", Database: "db/中文 ?", Username: "test:@user"}, Password: &password})
		if err != nil || item.Port != defaultPort(kind) {
			t.Fatalf("%s defaults: %+v %v", kind, item, err)
		}
		if kind != "mysql" {
			cfg, err := postgresConfig(*item, password)
			if err != nil || cfg.Host != "::1" || cfg.Database != item.Database || cfg.User != item.Username || cfg.Password != password || cfg.ConnectTimeout != 5*time.Second || cfg.TLSConfig == nil {
				t.Fatalf("PostgreSQL config lost fields: %v", err)
			}
			item.SSLMode = "require"
			if _, err := s.PutConnection(ctx, *item); err != nil {
				t.Fatal(err)
			}
		}
		// Legacy callers that omit the new fields must preserve driver, SSL and password.
		update := *item
		update.Type, update.SSLMode = "", ""
		saved, err := s.PutConnection(ctx, update)
		if err != nil || saved.Type != kind || saved.SSLMode != item.SSLMode {
			t.Fatalf("omitted driver settings changed: %+v %v", saved, err)
		}
		_, decrypted, err := s.connectionCredentials(ctx, item.ID)
		if err != nil || decrypted != password {
			t.Fatal("driver update lost the encrypted password")
		}
	}
	for _, input := range []Connection{
		{Name: "bad", Type: "sqlite", Host: "localhost", Database: "test", Username: "tester"},
		{Name: "bad", Type: "postgresql", SSLMode: "invalid", Host: "localhost", Database: "test", Username: "tester"},
	} {
		if _, err := s.PutConnection(ctx, input); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid driver input accepted: %v", err)
		}
	}
	for _, mode := range []string{"disable", "prefer", "require", "verify-full"} {
		cfg, err := postgresConfig(Connection{Host: "localhost", Port: 5432, Database: "test", Username: "tester", SSLMode: mode}, "")
		if err != nil {
			t.Fatal(err)
		}
		if mode == "disable" && cfg.TLSConfig != nil || mode != "disable" && cfg.TLSConfig == nil {
			t.Fatalf("wrong TLS behavior for %s", mode)
		}
		if mode == "verify-full" && (cfg.TLSConfig.InsecureSkipVerify || cfg.TLSConfig.ServerName != "localhost") {
			t.Fatal("verify-full must verify certificate and hostname")
		}
	}
	// Simulate the exact pre-driver schema with an existing encrypted credential.
	if _, err := metadata.Exec(`ALTER TABLE database_connection_settings DROP COLUMN driver_type; ALTER TABLE database_connection_settings DROP COLUMN ssl_mode`); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(metadata)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	items, err := restarted.ListConnections(ctx)
	if err != nil || len(items) != 3 {
		t.Fatalf("migration lost connections: %+v %v", items, err)
	}
	for _, item := range items {
		if item.Type != "mysql" {
			t.Fatal("old connections must retain the original MySQL behavior")
		}
		_, decrypted, err := restarted.connectionCredentials(ctx, item.ID)
		if err != nil || decrypted != password {
			t.Fatal("migration lost encrypted credentials")
		}
	}
}

// Speak PostgreSQL's wire protocol, so this checks that Hologres does not send
// a MySQL handshake and that $1 values are bound rather than rewritten into SQL.
func TestPostgreSQLAndHologresWireExecution(t *testing.T) {
	for _, kind := range []string{"postgresql", "hologres"} {
		t.Run(kind, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			password := "wire-secret:@/中文"
			value := "中文'); DROP TABLE sample; --"
			serverResult := make(chan error, 1)
			go func() {
				serverResult <- func() error {
					conn, err := listener.Accept()
					if err != nil {
						return err
					}
					defer conn.Close()
					_ = conn.SetDeadline(time.Now().Add(8 * time.Second))
					backend := pgproto3.NewBackend(conn, conn)
					startup, err := backend.ReceiveStartupMessage()
					if err != nil {
						return err
					}
					message, ok := startup.(*pgproto3.StartupMessage)
					if !ok || message.Parameters["database"] != "test" || message.Parameters["user"] != "tester" {
						return fmt.Errorf("invalid PostgreSQL startup: %T", startup)
					}
					backend.Send(&pgproto3.AuthenticationCleartextPassword{})
					if err := backend.Flush(); err != nil {
						return err
					}
					auth, err := backend.Receive()
					if err != nil {
						return err
					}
					if response, ok := auth.(*pgproto3.PasswordMessage); !ok || response.Password != password {
						return errors.New("encrypted saved password was not used")
					}
					backend.Send(&pgproto3.AuthenticationOk{})
					for key, value := range map[string]string{"server_version": "14.0", "client_encoding": "UTF8", "standard_conforming_strings": "on"} {
						backend.Send(&pgproto3.ParameterStatus{Name: key, Value: value})
					}
					backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
					if err := backend.Flush(); err != nil {
						return err
					}
					var statement string
					var params [][]byte
					for {
						msg, err := backend.Receive()
						if err != nil {
							return err
						}
						switch msg := msg.(type) {
						case *pgproto3.Query:
							if strings.Contains(msg.String, "missing_column") {
								backend.Send(&pgproto3.ErrorResponse{Severity: "ERROR", Code: "42703", Message: "column missing_column does not exist"})
							} else {
								backend.Send(&pgproto3.EmptyQueryResponse{}) // driver Ping
							}
							backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
						case *pgproto3.Parse:
							statement = msg.Query
							backend.Send(&pgproto3.ParseComplete{})
						case *pgproto3.Bind:
							params = msg.Parameters
							if !strings.Contains(statement, "missing_column") && (len(params) != 1 || string(params[0]) != value || !strings.Contains(statement, "$1")) {
								return errors.New("SQL parameters were not bound separately")
							}
							backend.Send(&pgproto3.BindComplete{})
						case *pgproto3.Describe:
							if !strings.Contains(statement, "missing_column") {
								backend.Send(&pgproto3.RowDescription{Fields: []pgproto3.FieldDescription{{Name: []byte("value"), DataTypeOID: 25, DataTypeSize: -1, TypeModifier: -1}}})
							}
						case *pgproto3.Execute:
							if strings.Contains(statement, "missing_column") {
								backend.Send(&pgproto3.ErrorResponse{Severity: "ERROR", Code: "42703", Message: "column missing_column does not exist"})
							} else if strings.HasPrefix(statement, "UPDATE") {
								backend.Send(&pgproto3.CommandComplete{CommandTag: []byte("UPDATE 2")})
							} else {
								backend.Send(&pgproto3.DataRow{Values: params})
								backend.Send(&pgproto3.CommandComplete{CommandTag: []byte("SELECT 1")})
							}
						case *pgproto3.Sync:
							backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
						case *pgproto3.Terminate:
							return nil
						default:
							return fmt.Errorf("unexpected PostgreSQL message: %T", msg)
						}
						if err := backend.Flush(); err != nil {
							return err
						}
					}
				}()
			}()
			s, _ := testService(t)
			ctx := context.Background()
			item, err := s.SaveConnection(ctx, ConnectionInput{Connection: Connection{Name: kind, Type: kind, SSLMode: "disable", Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, Database: "test", Username: "tester"}, Password: &password})
			if err != nil {
				t.Fatal(err)
			}
			if err := s.TestConnection(ctx, item.ID); err != nil {
				t.Fatal(err)
			}
			result, err := s.Execute(ctx, Command{ConnectionID: item.ID, Mode: "query", SQL: "SELECT $1::text AS value", Params: []any{value}})
			if err != nil || result.RowCount != 1 || result.Rows[0]["value"] != value {
				t.Fatalf("PostgreSQL query: %+v %v", result, err)
			}
			result, err = s.Execute(ctx, Command{ConnectionID: item.ID, Mode: "exec", SQL: "UPDATE sample SET value=$1", Params: []any{value}})
			if err != nil || result.RowsAffected != 2 {
				t.Fatalf("PostgreSQL exec: %+v %v", result, err)
			}
			if _, err := s.Execute(ctx, Command{ConnectionID: item.ID, Mode: "query", SQL: "SELECT missing_column"}); err == nil {
				t.Fatal("expected PostgreSQL error")
			}
			history, err := s.ListExecutions(ctx, item.ID)
			if err != nil || len(history) != 3 || history[0].Status != "failed" || history[1].RowsAffected != 2 || history[2].SQL != "SELECT $1::text AS value" {
				t.Fatalf("PostgreSQL history: %+v %v", history, err)
			}
			_ = s.Close()
			if err := <-serverResult; err != nil {
				t.Fatal(err)
			}
		})
	}
}

// Ensure the migration is also safe when opening a database with only the
// original connection schema (the settings table is created by New).
func TestDriverMigrationWithLegacySchema(t *testing.T) {
	metadata, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer metadata.Close()
	metadata.SetMaxOpenConns(1)
	if _, err := metadata.Exec(`CREATE TABLE database_connections(id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO database_connections VALUES('old','Old')`); err != nil {
		t.Fatal(err)
	}
	s, err := New(metadata)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	items, err := s.ListConnections(context.Background())
	if err != nil || len(items) != 1 || items[0].Type != "mysql" {
		t.Fatalf("legacy metadata changed: %+v %v", items, err)
	}
}
