package database

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

func testService(t *testing.T) (*Service, *sql.DB) {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	s, err := New(db)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close(); _ = db.Close() })
	return s, db
}

// Exercise the actual connector: DSN formatting alone hides charset entries
// incorrectly placed in Config.Params, because ParseDSN treats them specially.
func TestMySQLConnectionCharset(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	serverResult := make(chan error, 1)
	go func() {
		serverResult <- func() error {
			conn, err := listener.Accept()
			if err != nil {
				return err
			}
			defer conn.Close()
			if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
				return err
			}
			writePacket := func(sequence byte, payload []byte) error {
				_, err := conn.Write(append([]byte{byte(len(payload)), byte(len(payload) >> 8), byte(len(payload) >> 16), sequence}, payload...))
				return err
			}
			readPacket := func() ([]byte, error) {
				var header [4]byte
				if _, err := io.ReadFull(conn, header[:]); err != nil {
					return nil, err
				}
				payload := make([]byte, int(header[0])|int(header[1])<<8|int(header[2])<<16)
				_, err := io.ReadFull(conn, payload)
				return payload, err
			}
			// Protocol 10 greeting: protocol 4.1, secure connection, native password.
			greeting := append([]byte{10}, []byte("8.0.0-test\x00")...)
			greeting = append(greeting, 1, 0, 0, 0)
			greeting = append(greeting, []byte("12345678\x00")...)
			greeting = append(greeting, 0x08, 0x82, 45, 2, 0, 0x08, 0, 21)
			greeting = append(greeting, make([]byte, 10)...)
			greeting = append(greeting, []byte("abcdefghijkl\x00mysql_native_password\x00")...)
			if err := writePacket(0, greeting); err != nil {
				return err
			}
			if _, err := readPacket(); err != nil {
				return err
			}
			ok := []byte{0, 0, 0, 2, 0, 0, 0}
			if err := writePacket(2, ok); err != nil {
				return err
			}
			charsetSet := false
			for {
				packet, err := readPacket()
				if err != nil {
					return err
				}
				if len(packet) == 0 {
					return errors.New("empty MySQL command")
				}
				switch packet[0] {
				case 3: // COM_QUERY
					if string(packet[1:]) != "SET NAMES utf8mb4" {
						_ = writePacket(1, append([]byte{0xff, 0xa9, 0x04}, []byte("#HY000Unknown system variable 'charset'")...))
						return fmt.Errorf("unexpected initialization SQL: %q", packet[1:])
					}
					charsetSet = true
				case 14: // COM_PING
					if !charsetSet {
						return errors.New("connection pinged before setting utf8mb4")
					}
					return writePacket(1, ok)
				default:
					return fmt.Errorf("unexpected MySQL command: %d", packet[0])
				}
				if err := writePacket(1, ok); err != nil {
					return err
				}
			}
		}()
	}()
	s, _ := testService(t)
	address := listener.Addr().(*net.TCPAddr)
	item, err := s.PutConnection(context.Background(), Connection{Name: "charset", Host: "127.0.0.1", Port: address.Port, Database: "test", Username: "tester"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.TestConnection(context.Background(), item.ID); err != nil {
		t.Errorf("test connection: %v", err)
	}
	if err := <-serverResult; err != nil {
		t.Fatal(err)
	}
}

func TestConnectionConfigurationAndSecrets(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	password := "  secret:@/?#中文'  "
	item, err := s.SaveConnection(ctx, ConnectionInput{Connection: Connection{Name: "test", Host: "::1", Database: "test/db", Username: "tester"}, Password: &password})
	if err != nil {
		t.Fatal(err)
	}
	items, err := s.ListConnections(ctx)
	if err != nil || len(items) != 1 || items[0] != *item {
		t.Fatalf("items=%+v err=%v", items, err)
	}
	item.Name = "updated"
	if _, err := s.PutConnection(ctx, *item); err != nil {
		t.Fatal(err)
	}
	items, _ = s.ListConnections(ctx)
	if len(items) != 1 || items[0].Name != "updated" {
		t.Fatalf("upsert failed: %+v", items)
	}
	if err := s.TestConnection(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected missing, got %v", err)
	}
	cfg, err := s.connectionConfig(ctx, item.ID)
	if err != nil || cfg.Passwd != password || cfg.Addr != "[::1]:3306" || cfg.DBName != "test/db" || cfg.MultiStatements || cfg.InterpolateParams {
		t.Fatalf("direct configuration mismatch: err=%v", err)
	}
	encoded, err := json.Marshal(items)
	if err != nil || bytes.Contains(encoded, []byte("password")) || bytes.Contains(encoded, []byte("secret")) {
		t.Fatalf("public metadata leaked password: %s", encoded)
	}
	for _, connection := range []Connection{
		{Name: "bad"},
		{Name: "bad", Host: "mysql://localhost", Database: "test", Username: "tester"},
		{Name: "bad", Host: "localhost", Database: "test", Username: "tester", Port: -1},
		{Name: "bad", Host: "localhost", Database: "test", Username: "tester", Port: 65536},
	} {
		if _, err := s.PutConnection(ctx, connection); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid connection accepted: %v", err)
		}
	}
}

func TestEncryptedPasswordsSurviveRestartAndUpdates(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "connections.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	s, err := New(db)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	password := "persisted-password:@/中文"
	input := ConnectionInput{Connection: Connection{ID: "direct", Name: "Direct", Host: "127.0.0.1", Port: 3306, Database: "test", Username: "tester"}, Password: &password}
	if _, err := s.SaveConnection(ctx, input); err != nil {
		t.Fatal(err)
	}
	var encrypted []byte
	if err := db.QueryRow(`SELECT password_encrypted FROM database_connection_settings WHERE connection_id='direct'`).Scan(&encrypted); err != nil {
		t.Fatal(err)
	}
	if len(encrypted) == 0 || bytes.Contains(encrypted, []byte(password)) {
		t.Fatal("password is not encrypted at rest")
	}
	if _, err := s.secrets.open("different-id", encrypted); err == nil {
		t.Fatal("password can be copied to another connection")
	}
	s.Close()
	s, err = New(db)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	cfg, err := s.connectionConfig(ctx, "direct")
	if err != nil || cfg.Passwd != password {
		t.Fatalf("password did not survive restart: %v", err)
	}
	input.Password = nil
	input.Host = "localhost"
	if _, err := s.SaveConnection(ctx, input); err != nil {
		t.Fatal(err)
	}
	cfg, err = s.connectionConfig(ctx, "direct")
	if err != nil || cfg.Passwd != password || cfg.Addr != "localhost:3306" {
		t.Fatalf("omitted password was not preserved: %v", err)
	}
	empty := ""
	input.Password = &empty
	if _, err := s.SaveConnection(ctx, input); err != nil {
		t.Fatal(err)
	}
	cfg, err = s.connectionConfig(ctx, "direct")
	if err != nil || cfg.Passwd != "" {
		t.Fatalf("empty password was not saved: %v", err)
	}
	if err := s.DeleteConnection(ctx, "direct"); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM database_connection_settings`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("deleted credentials remain: %v", err)
	}
}

func TestLegacyConnectionsRequireDirectConfiguration(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE database_connections(id TEXT PRIMARY KEY,name TEXT NOT NULL,dsn_env TEXT NOT NULL); INSERT INTO database_connections VALUES('legacy','Original','OLD_SECRET_SOURCE')`); err != nil {
		t.Fatal(err)
	}
	s, err := New(db)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	items, err := s.ListConnections(context.Background())
	if err != nil || len(items) != 1 || items[0].Name != "Original" || items[0].Host != "" {
		t.Fatalf("legacy identity lost: %v", err)
	}
	if err := s.TestConnection(context.Background(), "legacy"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("legacy connection should require reconfiguration: %v", err)
	}
	if _, err := s.PutConnection(context.Background(), Connection{ID: "legacy", Name: "Original", Host: "localhost", Database: "test", Username: "tester"}); err != nil {
		t.Fatal(err)
	}
}

func TestCommandValidation(t *testing.T) {
	valid := Command{ConnectionID: "test", Mode: "query", SQL: "SELECT 1"}
	if err := validate(&valid); err != nil || valid.TimeoutMS != 30000 || valid.MaxRows != 1000 {
		t.Fatalf("defaults: %+v %v", valid, err)
	}
	cases := []Command{
		{Mode: "query", SQL: "SELECT 1"},
		{ConnectionID: "test", Mode: "wrong", SQL: "SELECT 1"},
		{ConnectionID: "test", Mode: "exec", SQL: " "},
		{ConnectionID: "test", Mode: "query", SQL: "SELECT 1", TimeoutMS: -1},
		{ConnectionID: "test", Mode: "query", SQL: "SELECT 1", TimeoutMS: 300001},
		{ConnectionID: "test", Mode: "query", SQL: "SELECT 1", MaxRows: -1},
		{ConnectionID: "test", Mode: "query", SQL: "SELECT 1", MaxRows: 10001},
	}
	for _, cmd := range cases {
		if !errors.Is(validate(&cmd), ErrInvalid) {
			t.Fatalf("expected validation failure: %+v", cmd)
		}
	}
}

func TestExecutionParameterizationAndRowLimits(t *testing.T) {
	_, db := testService(t)
	ctx := context.Background()
	if _, err := db.Exec(`CREATE TABLE values_under_test(id INTEGER, name TEXT)`); err != nil {
		t.Fatal(err)
	}
	value := "x'); DROP TABLE values_under_test; --"
	result, err := execute(ctx, db, Command{Mode: "exec", SQL: `INSERT INTO values_under_test VALUES(?,?)`, Params: []any{1, value}})
	if err != nil || result.RowsAffected != 1 {
		t.Fatalf("insert: %+v %v", result, err)
	}
	result, err = execute(ctx, db, Command{Mode: "query", SQL: `SELECT id,name FROM values_under_test WHERE name=?`, Params: []any{value}, MaxRows: 1})
	if err != nil || result.RowCount != 1 || result.Truncated || result.Rows[0]["name"] != value {
		t.Fatalf("parameterized query: %+v %v", result, err)
	}
	if _, err := db.Exec(`INSERT INTO values_under_test VALUES(2,'second')`); err != nil {
		t.Fatal(err)
	}
	result, err = execute(ctx, db, Command{Mode: "query", SQL: `SELECT id,name FROM values_under_test ORDER BY id`, MaxRows: 1})
	if err != nil || !result.Truncated || result.RowCount != -1 || len(result.Rows) != 1 {
		t.Fatalf("truncated count must not look exact: %+v %v", result, err)
	}
	result, err = execute(ctx, db, Command{Mode: "query", SQL: `SELECT id,name FROM values_under_test WHERE id=999`, MaxRows: 1})
	if err != nil || result.RowCount != 0 || result.Rows == nil || result.Columns == nil {
		t.Fatalf("empty: %+v %v", result, err)
	}
	if _, err := execute(ctx, db, Command{Mode: "query", SQL: `SELECT id,id FROM values_under_test`, MaxRows: 1}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("duplicate columns must not overwrite data: %v", err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := execute(canceled, db, Command{Mode: "query", SQL: `SELECT * FROM values_under_test`, MaxRows: 1}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
}

// Set APIX_TEST_MYSQL_DSN to run this test against a real disposable MySQL
// database. The configured user must be able to create and drop tables.
func TestMySQLIntegration(t *testing.T) {
	if os.Getenv("APIX_TEST_MYSQL_DSN") == "" {
		t.Skip("APIX_TEST_MYSQL_DSN is not set")
	}
	s, _ := testService(t)
	ctx := context.Background()
	fixture, err := mysql.ParseDSN(os.Getenv("APIX_TEST_MYSQL_DSN"))
	if err != nil {
		t.Fatal("invalid integration fixture DSN")
	}
	host, port, err := net.SplitHostPort(fixture.Addr)
	if err != nil || fixture.Net != "tcp" {
		t.Fatal("integration fixture must use TCP")
	}
	portNumber, _ := strconv.Atoi(port)
	connection, err := s.SaveConnection(ctx, ConnectionInput{Connection: Connection{Name: "integration", Host: host, Port: portNumber, Database: fixture.DBName, Username: fixture.User}, Password: &fixture.Passwd})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.TestConnection(ctx, connection.ID); err != nil {
		t.Fatal(err)
	}
	table := "apix_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	command := func(mode, statement string, params ...any) (*Result, error) {
		return s.Execute(ctx, Command{ConnectionID: connection.ID, Mode: mode, SQL: statement, Params: params, MaxRows: 1})
	}
	if _, err := command("exec", "CREATE TABLE "+table+" (id INT PRIMARY KEY, name VARCHAR(255))"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := command("exec", "DROP TABLE "+table); err != nil {
			t.Errorf("cleanup: %v", err)
		}
	})
	value := "a' OR 1=1 --"
	if result, err := command("exec", "INSERT INTO "+table+" VALUES (?,?), (?,?)", 1, value, 2, "second"); err != nil || result.RowsAffected != 2 {
		t.Fatalf("insert: %+v %v", result, err)
	}
	result, err := command("query", "SELECT id,name FROM "+table+" WHERE name=?", value)
	if err != nil || result.RowCount != 1 || result.Truncated || result.Rows[0]["name"] != value {
		t.Fatalf("query: %+v %v", result, err)
	}
	result, err = command("query", "SELECT id FROM "+table+" ORDER BY id")
	if err != nil || !result.Truncated || result.RowCount != -1 {
		t.Fatalf("limit: %+v %v", result, err)
	}
	_, err = s.Execute(ctx, Command{ConnectionID: connection.ID, Mode: "query", SQL: "SELECT SLEEP(2)", TimeoutMS: 50})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("remote query must obey timeout: %v", err)
	}
	if err := s.TestConnection(ctx, connection.ID); err != nil {
		t.Fatalf("pool must remain usable after cancellation: %v", err)
	}
}
