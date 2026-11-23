// Package store is BuzzHub's Postgres layer.
//
// Each business location lives in its own Postgres schema: "public" for the main location and
// "loc_<slug>" for the others. This mirrors the Node app's one-SQLite-file-per-location design,
// so SQL stays the same shape and a location can be copied, backed up or removed on its own.
// Every unit of work runs in a transaction with search_path set to the location's schema, and
// buzzhub.tz set to the business time zone (used by the localdate()/localtoday() SQL functions).
package store

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed defaults.json
var defaultsJSON []byte

// Defaults are the settings every location starts with (shared with the Node server).
var Defaults = func() map[string]string {
	m := map[string]string{}
	if err := json.Unmarshal(defaultsJSON, &m); err != nil {
		panic(err)
	}
	return m
}()

// SlugRE matches a location slug.
var SlugRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,30}$`)

// Store wraps the connection pool.
type Store struct {
	Pool          *pgxpool.Pool
	migrationsDir string
	mu            sync.Mutex
	known         map[string]bool // schemas already migrated in this process
}

// Open connects and makes sure the main schema is up to date.
func Open(ctx context.Context, url, migrationsDir string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("database url: %w", err)
	}
	cfg.MaxConns = 20
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	for i := 0; ; i++ { // wait for Postgres on first boot (compose starts both at once)
		if err = pool.Ping(ctx); err == nil || i == 30 {
			break
		}
		time.Sleep(time.Second)
	}
	if err != nil {
		return nil, fmt.Errorf("can't reach Postgres: %w", err)
	}
	s := &Store{Pool: pool, migrationsDir: migrationsDir, known: map[string]bool{}}
	if err := s.Migrate(ctx, "main"); err != nil {
		return nil, err
	}
	return s, nil
}

// SchemaFor maps a location slug to its Postgres schema.
func SchemaFor(slug string) string {
	if slug == "" || slug == "main" {
		return "public"
	}
	return "loc_" + strings.ReplaceAll(slug, "-", "_")
}

// Migrate applies every migrations/*.sql file not yet applied to the location's schema.
func (s *Store) Migrate(ctx context.Context, slug string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	schema := SchemaFor(slug)
	if s.known[schema] {
		return nil
	}
	files, err := filepath.Glob(filepath.Join(s.migrationsDir, "*.sql"))
	if err != nil {
		return err
	}
	sort.Strings(files)
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// one migrator at a time across every server instance
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(4210921)`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `CREATE SCHEMA IF NOT EXISTS `+pgx.Identifier{schema}.Sanitize()); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('search_path', $1, true)`, schema); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	for _, f := range files {
		name := filepath.Base(f)
		var done bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1)`, name).Scan(&done); err != nil {
			return err
		}
		if done {
			continue
		}
		sql, err := os.ReadFile(f)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			return fmt.Errorf("migration %s on %s: %w", name, schema, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (name) VALUES ($1)`, name); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.known[schema] = true
	return nil
}

// LocationExists reports whether a slug is a known location (main always is).
func (s *Store) LocationExists(ctx context.Context, slug string) bool {
	if slug == "" || slug == "main" {
		return true
	}
	if !SlugRE.MatchString(slug) {
		return false
	}
	var ok bool
	_ = s.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM public.locations WHERE slug = $1)`, slug).Scan(&ok)
	return ok
}

// Tx is the transaction a unit of work runs in, scoped to one location.
type Tx struct {
	pgx.Tx
	Slug string
}

// In runs fn in a transaction scoped to the location. It commits if fn returns nil.
func (s *Store) In(ctx context.Context, slug string, fn func(tx *Tx) error) error {
	if slug == "" {
		slug = "main"
	}
	if err := s.Migrate(ctx, slug); err != nil {
		return err
	}
	ptx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer ptx.Rollback(ctx)
	schema := SchemaFor(slug)
	if _, err := ptx.Exec(ctx, `SELECT set_config('search_path', $1, true), set_config('buzzhub.tz', COALESCE((SELECT value FROM `+pgx.Identifier{schema, "settings"}.Sanitize()+` WHERE key = 'timezone'), $2), true)`, schema+", public", Defaults["timezone"]); err != nil {
		return err
	}
	if err := fn(&Tx{Tx: ptx, Slug: slug}); err != nil {
		return err
	}
	return ptx.Commit(ctx)
}

/* ---------- small helpers used everywhere ---------- */

// Int returns the first column of the first row as an int64 (0 when there are no rows).
func (t *Tx) Int(ctx context.Context, sql string, args ...any) (int64, error) {
	var n *int64
	err := t.QueryRow(ctx, sql, args...).Scan(&n)
	if errors.Is(err, pgx.ErrNoRows) || n == nil {
		return 0, nil
	}
	return *n, err
}

// Settings returns the location's settings merged over the defaults.
func (t *Tx) Settings(ctx context.Context) (map[string]string, error) {
	out := make(map[string]string, len(Defaults)+16)
	for k, v := range Defaults {
		out[k] = v
	}
	rows, err := t.Query(ctx, `SELECT key, value FROM settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		var v *string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		if v != nil {
			out[k] = *v
		} else {
			out[k] = ""
		}
	}
	return out, rows.Err()
}

// SetSettings upserts settings.
func (t *Tx) SetSettings(ctx context.Context, kv map[string]string) error {
	for k, v := range kv {
		if _, err := t.Exec(ctx, `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, k, v); err != nil {
			return err
		}
	}
	return nil
}

// Audit writes an audit-log entry (the same table and columns the Node server uses).
func (t *Tx) Audit(ctx context.Context, userID *int64, userName *string, action string, detail string, ip string) error {
	var d *string
	if detail != "" {
		if len(detail) > 500 {
			detail = detail[:500]
		}
		d = &detail
	}
	var ipp *string
	if ip != "" {
		ipp = &ip
	}
	_, err := t.Exec(ctx, `INSERT INTO audit (user_id, user_name, action, detail, ip) VALUES ($1, $2, $3, $4, $5)`, userID, userName, action, d, ipp)
	return err
}

// Now is the UTC text timestamp format every table uses.
func Now() string { return time.Now().UTC().Format("2006-01-02 15:04:05") }

// Secret returns a value from public.app_secrets, creating a random one the first time.
func (s *Store) Secret(ctx context.Context, name string, bytes int) (string, error) {
	if _, err := s.Pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS public.app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)`); err != nil {
		return "", err
	}
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	if _, err := s.Pool.Exec(ctx, `INSERT INTO public.app_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, name, hex.EncodeToString(b)); err != nil {
		return "", err
	}
	var v string
	err := s.Pool.QueryRow(ctx, `SELECT value FROM public.app_secrets WHERE name = $1`, name).Scan(&v)
	return v, err
}
