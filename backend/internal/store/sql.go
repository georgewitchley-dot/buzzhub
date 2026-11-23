package store

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// Row is one result row keyed by column name, like a better-sqlite3 row object.
// Integers come back as int64, decimals as float64, text as string, NULL as nil,
// and Postgres booleans as 0/1 (SQLite has no booleans).
type Row = map[string]any

// Result is what Run returns: rows changed and the new row's id (for INSERTs into tables with an id).
type Result struct {
	Changes int64
	LastID  int64
}

/* ---------- SQLite → Postgres translation (cached per statement) ---------- */

var (
	transMu    sync.RWMutex
	transCache = map[string]string{}
	pkMu       sync.RWMutex
	pkCache    = map[string][]string{} // table -> primary key columns
	idTables   = map[string]bool{}     // tables with an "id" identity column
	colCache   = map[string][]string{}
)

var (
	reInsertOr   = regexp.MustCompile(`(?is)^\s*INSERT\s+OR\s+(IGNORE|REPLACE)\s+INTO\s+("?\w+"?)\s*\(([^)]*)\)`)
	reLike       = regexp.MustCompile(`(?i)\s(NOT\s+)?LIKE\s`)
	reNocase     = regexp.MustCompile(`(?i)([\w.]+)\s+COLLATE\s+NOCASE`)
	reAsReal     = regexp.MustCompile(`(?i)\bAS\s+REAL\b`)
	reDateFn     = regexp.MustCompile(`(?i)(^|[^\w.])date\s*\(`)
	reIsParam    = regexp.MustCompile(`(?i)\bIS\s+(NOT\s+)?\?`)
	reInsertHead = regexp.MustCompile(`(?is)^\s*INSERT\s+INTO\s+"?(\w+)"?`)
)

// Translate rewrites a SQLite statement for Postgres. Exported for tests.
func Translate(q string) string {
	transMu.RLock()
	if t, ok := transCache[q]; ok {
		transMu.RUnlock()
		return t
	}
	transMu.RUnlock()
	t := translate(q)
	transMu.Lock()
	transCache[q] = t
	transMu.Unlock()
	return t
}

func translate(q string) string {
	s := q
	s = reIsParam.ReplaceAllStringFunc(s, func(m string) string {
		if strings.Contains(strings.ToUpper(m), "NOT") {
			return "IS DISTINCT FROM ?"
		}
		return "IS NOT DISTINCT FROM ?"
	})
	s = reLike.ReplaceAllStringFunc(s, func(m string) string {
		return strings.Replace(strings.Replace(m, "LIKE", "ILIKE", 1), "like", "ILIKE", 1)
	})
	s = reNocase.ReplaceAllString(s, "lower($1)")
	s = reAsReal.ReplaceAllString(s, "AS DOUBLE PRECISION")
	s = reDateFn.ReplaceAllString(s, "${1}sqlite_date(")
	s = twoArgMinMax(s)
	if m := reInsertOr.FindStringSubmatchIndex(s); m != nil {
		kind := strings.ToUpper(s[m[2]:m[3]])
		table := strings.Trim(s[m[4]:m[5]], `"`)
		cols := splitCols(s[m[6]:m[7]])
		s = s[:m[0]] + "INSERT INTO " + s[m[4]:m[5]] + " (" + s[m[6]:m[7]] + ")" + s[m[1]:]
		if kind == "IGNORE" {
			s = strings.TrimRight(strings.TrimSpace(s), ";") + " ON CONFLICT DO NOTHING"
		} else {
			pk := pkOf(table)
			var sets []string
			for _, c := range cols {
				if !contains(pk, c) {
					sets = append(sets, fmt.Sprintf(`"%s" = excluded."%s"`, c, c))
				}
			}
			if len(pk) == 0 {
				s = strings.TrimRight(strings.TrimSpace(s), ";") + " ON CONFLICT DO NOTHING"
			} else if len(sets) == 0 {
				s = strings.TrimRight(strings.TrimSpace(s), ";") + " ON CONFLICT (" + quoteJoin(pk) + ") DO NOTHING"
			} else {
				s = strings.TrimRight(strings.TrimSpace(s), ";") + " ON CONFLICT (" + quoteJoin(pk) + ") DO UPDATE SET " + strings.Join(sets, ", ")
			}
		}
	}
	return placeholders(s)
}

func splitCols(s string) []string {
	var out []string
	for _, c := range strings.Split(s, ",") {
		if c = strings.Trim(strings.TrimSpace(c), `"`); c != "" {
			out = append(out, c)
		}
	}
	return out
}
func quoteJoin(cols []string) string {
	q := make([]string, len(cols))
	for i, c := range cols {
		q[i] = `"` + c + `"`
	}
	return strings.Join(q, ", ")
}
func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// placeholders turns ? into $1, $2 … outside quotes.
func placeholders(s string) string {
	var b strings.Builder
	n := 0
	var quote byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		if quote != 0 {
			b.WriteByte(c)
			if c == quote {
				quote = 0
			}
			continue
		}
		if c == '\'' || c == '"' {
			quote = c
			b.WriteByte(c)
			continue
		}
		if c == '?' {
			n++
			fmt.Fprintf(&b, "$%d", n)
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

// twoArgMinMax: SQLite's scalar MAX(a, b)/MIN(a, b) are GREATEST/LEAST in Postgres.
func twoArgMinMax(s string) string {
	up := strings.ToUpper(s)
	var b strings.Builder
	i := 0
	for i < len(s) {
		j := -1
		for _, fn := range []string{"MAX(", "MIN("} {
			k := strings.Index(up[i:], fn)
			if k >= 0 && (j < 0 || i+k < j) {
				j = i + k
			}
		}
		if j < 0 {
			b.WriteString(s[i:])
			break
		}
		if j > 0 && (isWord(s[j-1]) || s[j-1] == '.') {
			b.WriteString(s[i : j+4])
			i = j + 4
			continue
		}
		depth, commas, end := 0, 0, -1
		var quote byte
		for k := j + 3; k < len(s); k++ {
			c := s[k]
			if quote != 0 {
				if c == quote {
					quote = 0
				}
				continue
			}
			switch c {
			case '\'', '"':
				quote = c
			case '(':
				depth++
			case ')':
				depth--
				if depth == 0 {
					end = k
				}
			case ',':
				if depth == 1 {
					commas++
				}
			}
			if end >= 0 {
				break
			}
		}
		b.WriteString(s[i:j])
		if end > 0 && commas >= 1 {
			if strings.EqualFold(s[j:j+3], "MAX") {
				b.WriteString("GREATEST(")
			} else {
				b.WriteString("LEAST(")
			}
			b.WriteString(twoArgMinMax(s[j+4 : end+1]))
			i = end + 1
			continue
		}
		b.WriteString(s[j : j+4])
		i = j + 4
	}
	return b.String()
}
func isWord(c byte) bool {
	return c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
}

/* ---------- schema facts used by the translator ---------- */

// LoadSchemaInfo reads primary keys and id columns (once, from the main schema).
func (s *Store) LoadSchemaInfo(ctx context.Context) error {
	rows, err := s.Pool.Query(ctx, `SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc
		JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
		WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' ORDER BY tc.table_name, kcu.ordinal_position`)
	if err != nil {
		return err
	}
	pk := map[string][]string{}
	for rows.Next() {
		var t, c string
		if err := rows.Scan(&t, &c); err != nil {
			rows.Close()
			return err
		}
		pk[t] = append(pk[t], c)
	}
	rows.Close()
	rows, err = s.Pool.Query(ctx, `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`)
	if err != nil {
		return err
	}
	ids := map[string]bool{}
	cols := map[string][]string{}
	for rows.Next() {
		var t, c string
		if err := rows.Scan(&t, &c); err != nil {
			rows.Close()
			return err
		}
		cols[t] = append(cols[t], c)
		if c == "id" {
			ids[t] = true
		}
	}
	rows.Close()
	pkMu.Lock()
	pkCache, idTables, colCache = pk, ids, cols
	pkMu.Unlock()
	return nil
}

func pkOf(table string) []string { pkMu.RLock(); defer pkMu.RUnlock(); return pkCache[table] }
func hasID(table string) bool    { pkMu.RLock(); defer pkMu.RUnlock(); return idTables[table] }

// Columns lists a table's columns (like PRAGMA table_info).
func Columns(table string) []string { pkMu.RLock(); defer pkMu.RUnlock(); return colCache[table] }

/* ---------- query helpers ---------- */

func normArgs(args []any) []any {
	out := make([]any, len(args))
	for i, a := range args {
		switch v := a.(type) {
		case bool: // SQLite stores booleans as 0/1
			if v {
				out[i] = int64(1)
			} else {
				out[i] = int64(0)
			}
		case int:
			out[i] = int64(v)
		default:
			out[i] = a
		}
	}
	return out
}

// All runs a query and returns every row.
func (t *Tx) All(ctx context.Context, q string, args ...any) ([]Row, error) {
	rows, err := t.Query(ctx, Translate(q), append([]any{pgx.QueryExecModeSimpleProtocol}, normArgs(args)...)...)
	if err != nil {
		return nil, fmt.Errorf("%w\nSQL: %s", err, oneLine(q))
	}
	defer rows.Close()
	fields := rows.FieldDescriptions()
	out := []Row{}
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return nil, err
		}
		r := make(Row, len(vals))
		for i, f := range fields {
			r[f.Name] = plain(vals[i])
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w\nSQL: %s", err, oneLine(q))
	}
	return out, nil
}

// Get returns the first row, or nil.
func (t *Tx) Get(ctx context.Context, q string, args ...any) (Row, error) {
	rows, err := t.All(ctx, q, args...)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

// Val returns the first column of the first row (nil when there is none).
func (t *Tx) Val(ctx context.Context, q string, args ...any) (any, error) {
	rows, err := t.Query(ctx, Translate(q), append([]any{pgx.QueryExecModeSimpleProtocol}, normArgs(args)...)...)
	if err != nil {
		return nil, fmt.Errorf("%w\nSQL: %s", err, oneLine(q))
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	v, err := rows.Values()
	if err != nil || len(v) == 0 {
		return nil, err
	}
	return plain(v[0]), nil
}

// N returns the first column as an int64 (0 for none/NULL).
func (t *Tx) N(ctx context.Context, q string, args ...any) (int64, error) {
	v, err := t.Val(ctx, q, args...)
	return Int(v), err
}

// Run executes a statement. INSERTs into tables with an id return it in LastID.
func (t *Tx) Run(ctx context.Context, q string, args ...any) (Result, error) {
	tq := Translate(q)
	if m := reInsertHead.FindStringSubmatch(tq); m != nil && hasID(m[1]) && !strings.Contains(strings.ToUpper(tq), "RETURNING") {
		rows, err := t.Query(ctx, strings.TrimRight(strings.TrimSpace(tq), ";")+" RETURNING id", append([]any{pgx.QueryExecModeSimpleProtocol}, normArgs(args)...)...)
		if err != nil {
			return Result{}, fmt.Errorf("%w\nSQL: %s", err, oneLine(q))
		}
		var res Result
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return Result{}, err
			}
			res.LastID, res.Changes = id, res.Changes+1
		}
		rows.Close()
		return res, rows.Err()
	}
	tag, err := t.Exec(ctx, tq, append([]any{pgx.QueryExecModeSimpleProtocol}, normArgs(args)...)...)
	if err != nil {
		return Result{}, fmt.Errorf("%w\nSQL: %s", err, oneLine(q))
	}
	return Result{Changes: tag.RowsAffected()}, nil
}

// Savepoint runs fn in a nested transaction (like better-sqlite3's db.transaction inside a request).
func (t *Tx) Savepoint(ctx context.Context, fn func() error) error {
	if _, err := t.Exec(ctx, "SAVEPOINT sp"); err != nil {
		return err
	}
	if err := fn(); err != nil {
		_, _ = t.Exec(ctx, "ROLLBACK TO SAVEPOINT sp")
		return err
	}
	_, err := t.Exec(ctx, "RELEASE SAVEPOINT sp")
	return err
}

func oneLine(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}

// plain converts driver values to the plain types the API returns.
func plain(v any) any {
	switch x := v.(type) {
	case bool:
		if x {
			return int64(1)
		}
		return int64(0)
	case int32:
		return int64(x)
	case int16:
		return int64(x)
	case float32:
		return float64(x)
	case pgtype.Numeric:
		if !x.Valid {
			return nil
		}
		if x.NaN {
			return nil
		}
		f, _ := x.Float64Value()
		if x.Exp >= 0 {
			bi := new(big.Int).Set(x.Int)
			bi.Mul(bi, new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(x.Exp)), nil))
			if bi.IsInt64() {
				return bi.Int64()
			}
		}
		if f.Valid {
			if f.Float64 == float64(int64(f.Float64)) && f.Float64 < 1e15 && f.Float64 > -1e15 {
				return int64(f.Float64)
			}
			return f.Float64
		}
		return nil
	}
	return v
}

// Int reads an int64 from a row value of any numeric/text type.
func Int(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int:
		return int64(x)
	case float64:
		return int64(x)
	case string:
		var n int64
		fmt.Sscan(x, &n)
		return n
	case nil:
		return 0
	}
	return 0
}

// Float reads a float64 from a row value.
func Float(v any) float64 {
	switch x := v.(type) {
	case int64:
		return float64(x)
	case float64:
		return x
	case string:
		var f float64
		fmt.Sscan(x, &f)
		return f
	}
	return 0
}

// Str reads a string ("" for NULL).
func Str(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case []byte:
		return string(x)
	case int64:
		return fmt.Sprint(x)
	case float64:
		return fmt.Sprint(x)
	}
	return fmt.Sprint(v)
}

// IsNoRows reports a missing row.
func IsNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
