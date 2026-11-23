package store

import (
	"context"
	"os"
	"testing"
)

func TestTranslate(t *testing.T) {
	pkCache = map[string][]string{"settings": {"key"}, "prep_counts": {"date", "item_id"}}
	cases := map[string]string{
		"SELECT * FROM users WHERE id = ? AND name = 'a?b'":                        "SELECT * FROM users WHERE id = $1 AND name = 'a?b'",
		"SELECT MAX(a, b), MAX(c) FROM t":                                          "SELECT GREATEST(a, b), MAX(c) FROM t",
		"SELECT MIN(COALESCE(x, 0), MAX(y, 2)) FROM t":                             "SELECT LEAST(COALESCE(x, 0), GREATEST(y, 2)) FROM t",
		"SELECT * FROM t WHERE name LIKE ?":                                        "SELECT * FROM t WHERE name ILIKE $1",
		"SELECT date(created_at), datetime('now') FROM t":                          "SELECT sqlite_date(created_at), datetime('now') FROM t",
		"SELECT * FROM t ORDER BY name COLLATE NOCASE":                             "SELECT * FROM t ORDER BY lower(name)",
		"INSERT OR IGNORE INTO t (a, b) VALUES (?, ?)":                             "INSERT INTO t (a, b) VALUES ($1, $2) ON CONFLICT DO NOTHING",
		"INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)":               `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value"`,
		"INSERT OR REPLACE INTO prep_counts (date, item_id, qty) VALUES (?, ?, ?)": `INSERT INTO prep_counts (date, item_id, qty) VALUES ($1, $2, $3) ON CONFLICT ("date", "item_id") DO UPDATE SET "qty" = excluded."qty"`,
		"SELECT * FROM t WHERE x IS ? AND y IS NOT ?":                              "SELECT * FROM t WHERE x IS NOT DISTINCT FROM $1 AND y IS DISTINCT FROM $2",
		"SELECT CAST(x AS REAL) FROM t":                                            "SELECT CAST(x AS DOUBLE PRECISION) FROM t",
	}
	for in, want := range cases {
		if got := translate(in); got != want {
			t.Errorf("\n in:   %s\n got:  %s\n want: %s", in, got, want)
		}
	}
}

// Needs a Postgres: TEST_DATABASE_URL=postgres://... go test ./internal/store
func TestCompatFunctions(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	s, err := Open(ctx, url, "../../migrations")
	if err != nil {
		t.Fatal(err)
	}
	err = s.In(ctx, "main", func(tx *Tx) error {
		r, err := tx.Get(ctx, `SELECT datetime('2026-01-31 10:00:00', '+1 day') a, datetime('2026-01-31 10:00:00', '-90 minutes') b, date('2026-01-31 23:59:59') c,
			julianday('2026-01-02 00:00:00') - julianday('2026-01-01 12:00:00') d, strftime('%H', '2026-01-01 07:05:00') e, MAX(3, 9) f, instr('hello', 'll') g,
			datetime('now') > datetime('now','-1 hour') h, round(2.345::double precision, 2) i`)
		if err != nil {
			return err
		}
		want := Row{"a": "2026-02-01 10:00:00", "b": "2026-01-31 08:30:00", "c": "2026-01-31", "d": 0.5, "e": "07", "f": int64(9), "g": int64(3), "h": int64(1), "i": 2.35}
		for k, v := range want {
			if r[k] != v {
				t.Errorf("%s = %#v, want %#v", k, r[k], v)
			}
		}
		g, err := tx.Get(ctx, `SELECT GROUP_CONCAT(x) a, GROUP_CONCAT(x, ' / ') b, SUM(x > 1) c FROM (VALUES (1), (2), (3)) v(x)`)
		if err != nil {
			return err
		}
		if g["a"] != "1,2,3" || g["b"] != "1 / 2 / 3" || g["c"] != int64(2) {
			t.Errorf("aggregates: %#v", g)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
