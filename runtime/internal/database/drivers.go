package database

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"github.com/apix/apix/runtime/internal/lifecycle"
	"net"
	"net/url"
	"strconv"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func defaultPort(kind string) int {
	switch kind {
	case "hologres":
		return 80
	case "postgresql":
		return 5432
	default:
		return 3306
	}
}

func (s *Service) migrateDriverSettings() error {
	for _, column := range []struct{ name, definition string }{
		{"driver_type", "TEXT NOT NULL DEFAULT 'mysql'"},
		{"ssl_mode", "TEXT NOT NULL DEFAULT ''"},
	} {
		var count int
		if err := s.store.QueryRow(`SELECT count(*) FROM pragma_table_info('database_connection_settings') WHERE name=?`, column.name).Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			if _, err := s.store.Exec(`ALTER TABLE database_connection_settings ADD COLUMN ` + column.name + " " + column.definition); err != nil {
				return fmt.Errorf("migrate database driver settings: %w", err)
			}
		}
	}
	return nil
}

// Called under s.mu so connection updates and secret access are serialized.
func (s *Service) connectionCredentials(ctx context.Context, id string) (Connection, string, error) {
	if err := lifecycle.Active(s.store, "database", id); err != nil {
		return Connection{}, "", err
	}
	if lifecycle.CredentialsCleared(s.store, id) {
		return Connection{}, "", fmt.Errorf("%w: 凭据已清除，请重新填写密码", ErrInvalid)
	}
	var item Connection
	var encrypted []byte
	err := s.store.QueryRowContext(ctx, `SELECT c.id,c.name,COALESCE(d.host,''),COALESCE(d.port,0),COALESCE(d.database_name,''),COALESCE(d.username,''),COALESCE(d.driver_type,'mysql'),COALESCE(d.ssl_mode,''),d.password_encrypted
		FROM database_connections c LEFT JOIN database_connection_settings d ON c.id=d.connection_id WHERE c.id=?`, id).Scan(&item.ID, &item.Name, &item.Host, &item.Port, &item.Database, &item.Username, &item.Type, &item.SSLMode, &encrypted)
	if errors.Is(err, sql.ErrNoRows) {
		return item, "", ErrNotFound
	}
	if err != nil {
		return item, "", err
	}
	if item.Host == "" || len(encrypted) == 0 {
		return item, "", fmt.Errorf("%w: direct connection settings are missing", ErrInvalid)
	}
	password, err := s.secrets.open(id, encrypted)
	if err != nil {
		return item, "", errors.New("cannot decrypt database password for this local user")
	}
	return item, password, nil
}

func mysqlConfig(item Connection, password string) (*mysql.Config, error) {
	cfg := mysql.NewConfig()
	cfg.Net = "tcp"
	cfg.Addr = net.JoinHostPort(item.Host, strconv.Itoa(item.Port))
	cfg.DBName, cfg.User, cfg.Passwd = item.Database, item.Username, password
	cfg.ParseTime = true
	cfg.Timeout = 5 * time.Second
	// Params are server system variables; charset must use SET NAMES instead.
	if err := cfg.Apply(mysql.Charset("utf8mb4", "")); err != nil {
		return nil, fmt.Errorf("%w: cannot configure MySQL charset", ErrInvalid)
	}
	return cfg, nil
}

func postgresConfig(item Connection, password string) (*pgx.ConnConfig, error) {
	// URL encoding preserves spaces, quotes, separators and Unicode in credentials.
	address := &url.URL{Scheme: "postgresql", Host: net.JoinHostPort(item.Host, strconv.Itoa(item.Port)), Path: "/" + item.Database, User: url.UserPassword(item.Username, password)}
	query := url.Values{"sslmode": {item.SSLMode}, "connect_timeout": {"5"}}
	address.RawQuery = query.Encode()
	cfg, err := pgx.ParseConfig(address.String())
	if err != nil {
		// Driver parse errors can contain the connection URL and credentials.
		return nil, fmt.Errorf("%w: cannot configure PostgreSQL connection", ErrInvalid)
	}
	cfg.Password = password
	cfg.RuntimeParams["application_name"] = "apix-runtime"
	// Avoid server-side statement caches, including across Hologres gateways.
	// Bind native $1/$2 parameters through the extended protocol.
	cfg.DefaultQueryExecMode = pgx.QueryExecModeExec
	return cfg, nil
}

func connectionConnector(item Connection, password string) (driver.Connector, error) {
	if item.Type == "mysql" {
		cfg, err := mysqlConfig(item, password)
		if err != nil {
			return nil, err
		}
		connector, err := mysql.NewConnector(cfg)
		if err != nil {
			return nil, fmt.Errorf("%w: cannot configure MySQL connection", ErrInvalid)
		}
		return connector, nil
	}
	if item.Type != "postgresql" && item.Type != "hologres" {
		return nil, fmt.Errorf("%w: unsupported database type", ErrInvalid)
	}
	cfg, err := postgresConfig(item, password)
	if err != nil {
		return nil, err
	}
	return stdlib.GetConnector(*cfg), nil
}
