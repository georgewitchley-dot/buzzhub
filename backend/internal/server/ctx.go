package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// C is the per-request context the ported handlers use. It mirrors the helpers the Node
// handlers shared (parse, idParam, audit, notifyStaff, getSettings ...).
type C struct {
	a   *App
	W   http.ResponseWriter
	R   *http.Request
	Tx  *store.Tx
	Ctx context.Context
	U   *auth.User // signed-in staff, if any
	s   map[string]string
	raw any
	got bool
}

// Fn is a ported handler.
type Fn func(c *C) error

// do adapts an Fn into the transaction-wrapped handler type.
func (a *App) do(fn Fn) handler {
	return func(w http.ResponseWriter, r *http.Request, tx *store.Tx) error {
		return fn(&C{a: a, W: w, R: r, Tx: tx, Ctx: r.Context(), U: userOf(r)})
	}
}

/* ---------- responses ---------- */

func (c *C) JSON(v any) error             { writeJSON(c.W, http.StatusOK, v); return nil }
func (c *C) Status(code int, v any) error { writeJSON(c.W, code, v); return nil }
func (c *C) OK() error                    { return c.JSON(M{"ok": true}) }

// M is a JSON object.
type M = map[string]any

func bad(msg string) error       { return fail(http.StatusBadRequest, msg) }
func notFound(msg string) error  { return fail(http.StatusNotFound, msg) }
func conflict(msg string) error  { return fail(http.StatusConflict, msg) }
func forbidden(msg string) error { return fail(http.StatusForbidden, msg) }

// failX adds extra fields to the error body ({error, needsManager: true}).
func failX(status int, msg string, extra M) error {
	return &HTTPError{Status: status, Msg: msg, Extra: extra}
}

/* ---------- input ---------- */

// Raw is the decoded JSON body (nil when empty).
func (c *C) Raw() any {
	if !c.got {
		c.got = true
		if c.R.Body != nil {
			body := http.MaxBytesReader(nil, c.R.Body, 2<<20)
			dec := json.NewDecoder(body)
			_ = dec.Decode(&c.raw)
		}
	}
	return c.raw
}

// Body validates the JSON body with a schema, like parse(schema, req.body).
func (c *C) Body(s *valid.ObjectS) (valid.M, error) {
	m, err := valid.Obj(s, c.Raw())
	if err != nil {
		return nil, bad(err.Error())
	}
	return m, nil
}

// Query validates the query string (all values are strings, as in Express).
func (c *C) Query(s *valid.ObjectS) (valid.M, error) {
	q := map[string]any{}
	for k, v := range c.R.URL.Query() {
		if len(v) > 0 {
			q[k] = v[0]
		}
	}
	m, err := valid.Obj(s, q)
	if err != nil {
		return nil, bad(err.Error())
	}
	return m, nil
}

func (c *C) Q(name string) string     { return c.R.URL.Query().Get(name) }
func (c *C) Param(name string) string { return c.R.PathValue(name) }

// ID is idParam(req): a positive integer path parameter.
func (c *C) ID() (int64, error) { return c.IntParam("id") }
func (c *C) IntParam(name string) (int64, error) {
	n, err := strconv.ParseInt(c.R.PathValue(name), 10, 64)
	if err != nil || n < 1 {
		return 0, bad("Bad id")
	}
	return n, nil
}

func (c *C) IP() string { return c.a.clientIP(c.R) }

/* ---------- data ---------- */

func (c *C) All(q string, args ...any) ([]store.Row, error) { return c.Tx.All(c.Ctx, q, args...) }
func (c *C) Get(q string, args ...any) (store.Row, error)   { return c.Tx.Get(c.Ctx, q, args...) }
func (c *C) Val(q string, args ...any) (any, error)         { return c.Tx.Val(c.Ctx, q, args...) }
func (c *C) N(q string, args ...any) (int64, error)         { return c.Tx.N(c.Ctx, q, args...) }
func (c *C) Run(q string, args ...any) (store.Result, error) {
	return c.Tx.Run(c.Ctx, q, args...)
}

// One is Get that treats "no row" as nil instead of an error.
func (c *C) One(q string, args ...any) (store.Row, error) {
	r, err := c.Tx.Get(c.Ctx, q, args...)
	if store.IsNoRows(err) {
		return nil, nil
	}
	return r, err
}

// S returns the location's settings (cached for the request; Refresh after saving).
func (c *C) S() map[string]string {
	if c.s == nil {
		s, err := c.Tx.Settings(c.Ctx)
		if err != nil {
			s = map[string]string{}
			for k, v := range store.Defaults {
				s[k] = v
			}
		}
		c.s = s
	}
	return c.s
}
func (c *C) Refresh() { c.s = nil }

// Audit records an action by the signed-in user.
func (c *C) Audit(action, detail string) error {
	if c.U != nil {
		return c.Tx.Audit(c.Ctx, &c.U.ID, &c.U.Name, action, detail, c.IP())
	}
	return c.Tx.Audit(c.Ctx, nil, nil, action, detail, c.IP())
}

// AuditAs records an action by someone else (nil = the system).
func (c *C) AuditAs(u *auth.User, action, detail string, ip string) error {
	if u != nil {
		return c.Tx.Audit(c.Ctx, &u.ID, &u.Name, action, detail, ip)
	}
	return c.Tx.Audit(c.Ctx, nil, nil, action, detail, ip)
}

func (c *C) Notify(scope string)               { c.a.notifyStaff(c.Tx, scope) }
func (c *C) Emit(room, event string, data any) { c.a.emitTo(c.Tx, room, event, data) }

func (c *C) Slug() string { return c.Tx.Slug }

// PublicBase is PUBLIC_URL or the request's own origin.
func (c *C) PublicBase() string {
	if p := strings.TrimRight(c.a.cfg.PublicURL, "/"); p != "" {
		return p
	}
	scheme := "http"
	if c.R.TLS != nil || (c.a.cfg.TrustProxy && c.R.Header.Get("X-Forwarded-Proto") == "https") {
		scheme = "https"
	}
	return scheme + "://" + c.R.Host
}

/* ---------- buffered responses: nothing is sent until the transaction commits ---------- */

type bufWriter struct {
	h      http.Header
	status int
	buf    bytes.Buffer
}

func newBuf() *bufWriter                 { return &bufWriter{h: http.Header{}} }
func (b *bufWriter) Header() http.Header { return b.h }
func (b *bufWriter) Write(p []byte) (int, error) {
	if b.status == 0 {
		b.status = http.StatusOK
	}
	return b.buf.Write(p)
}
func (b *bufWriter) WriteHeader(code int) {
	if b.status == 0 {
		b.status = code
	}
}
func (b *bufWriter) flush(w http.ResponseWriter) {
	for k, v := range b.h {
		w.Header()[k] = v
	}
	if b.status == 0 {
		b.status = http.StatusOK
	}
	w.WriteHeader(b.status)
	_, _ = w.Write(b.buf.Bytes())
}

/* ---------- small helpers ---------- */

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func firstName(n string) string {
	f := strings.Fields(n)
	if len(f) == 0 {
		return ""
	}
	r := []rune(f[0])
	if len(r) > 24 {
		r = r[:24]
	}
	return string(r)
}

func nowMs() int64 { return time.Now().UnixMilli() }

// str/i64/f64/boolean read validated or database values loosely, like JS.
func str(v any) string  { return store.Str(v) }
func i64(v any) int64   { return store.Int(v) }
func f64(v any) float64 { return store.Float(v) }
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case int64:
		return x != 0
	case int:
		return x != 0
	case float64:
		return x != 0
	}
	return true
}

// orNil returns nil for empty strings (JS's `x || null`).
func orNil(v any) any {
	if !truthy(v) {
		return nil
	}
	return v
}

/* ---------- shared hooks between modules (the Node server's G object) ---------- */

type hookFn func(c *C, args ...any) (any, error)

// G calls a hook another module registered; absent hooks return nil.
func (c *C) G(name string, args ...any) (any, error) {
	if f := c.a.G[name]; f != nil {
		return f(c, args...)
	}
	return nil, nil
}
func (c *C) Has(name string) bool { return c.a.G[name] != nil }
