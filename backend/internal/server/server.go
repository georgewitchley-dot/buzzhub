// Package server wires the HTTP routes. The API contract matches the Node server exactly
// (paths, JSON shapes, cookies, headers), so the React client works against either backend
// while areas move over one at a time.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/zishang520/socket.io/v2/socket"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
)

// Config comes from the environment (the same names Railway already uses).
type Config struct {
	Port, DatabaseURL, PublicURL, StaticDir, MigrationsDir, JWTSecret, SetupCode string
	Production, TrustProxy                                                       bool
}

func ConfigFromEnv() Config {
	get := func(k, d string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		return d
	}
	return Config{
		Port: get("PORT", "8080"), DatabaseURL: os.Getenv("DATABASE_URL"), PublicURL: os.Getenv("PUBLIC_URL"),
		StaticDir: get("STATIC_DIR", "/app/client"), MigrationsDir: get("MIGRATIONS_DIR", "/app/migrations"),
		JWTSecret: os.Getenv("JWT_SECRET"), SetupCode: os.Getenv("SETUP_CODE"),
		Production: os.Getenv("NODE_ENV") == "production" || os.Getenv("APP_ENV") == "production",
		TrustProxy: get("TRUST_PROXY", "1") == "1",
	}
}

// App holds what every handler needs.
type App struct {
	cfg      Config
	log      *slog.Logger
	db       *store.Store
	sess     *auth.Sessions
	lockout  *auth.Lockout
	setupMu  sync.Mutex
	setup    string // first-run setup code (cleared once claimed)
	authRate *limiter
	pubRate  *limiter
	io       *socket.Server
	vapid    vapidKeys
	G        map[string]hookFn
	lims     limits
	jobs     []job
	menu     menuHookSet
	orders   orderHookSet
}

// New connects to Postgres and returns the root handler.
func New(ctx context.Context, cfg Config, log *slog.Logger) (http.Handler, error) {
	a := &App{cfg: cfg, log: log, lockout: auth.NewLockout(), G: map[string]hookFn{}, lims: newLimits(), authRate: newLimiter(15, time.Minute), pubRate: newLimiter(240, time.Minute)}
	if cfg.DatabaseURL == "" {
		return nil, errors.New("DATABASE_URL is not set")
	}
	db, err := store.Open(ctx, cfg.DatabaseURL, cfg.MigrationsDir)
	if err != nil {
		return nil, err
	}
	a.db = db
	secret := cfg.JWTSecret
	if len(secret) < 32 {
		if secret, err = db.Secret(ctx, "jwt", 48); err != nil {
			return nil, err
		}
	}
	a.sess = &auth.Sessions{Secret: []byte(secret), Secure: cfg.Production}
	if err := a.prepareSetup(ctx); err != nil {
		return nil, err
	}
	if err := a.loadVapid(ctx); err != nil {
		return nil, err
	}
	return a.routes(), nil
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "backend": "go"})
	})
	// first run + PIN sign-in
	mux.Handle("GET /api/setup/status", a.h(a.setupStatus))
	mux.Handle("POST /api/setup", a.limit(a.authRate, a.h(a.doSetup)))
	mux.Handle("POST /api/auth/login", a.limit(a.authRate, a.h(a.login)))
	mux.Handle("POST /api/auth/logout", a.h(a.logout))
	mux.Handle("GET /api/auth/me", a.h(a.me))
	// public
	mux.Handle("GET /api/public/business", a.limit(a.pubRate, a.h(a.publicBusiness)))
	mux.Handle("GET /api/public/logo", a.h(a.publicLogo))
	// staff
	mux.Handle("GET /api/staff/settings", a.staff("staff", a.getSettings))
	rt := &router{a: a, mux: mux}
	a.registerGuard(rt)
	for _, m := range modules {
		m(a, rt)
	}
	a.startJobs(context.Background())

	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotImplemented, map[string]any{"error": "This part of BuzzHub hasn't moved to the new server yet"})
	})
	mux.Handle("/socket.io/", a.setupRealtime())
	mux.Handle("/", spa(a.cfg.StaticDir))
	return securityHeaders(a.csrf(a.withLocation(mux)))
}

/* ---------- request plumbing ---------- */

type ctxKey int

const slugKey ctxKey = 1

var tokenPath = regexp.MustCompile(`^/api/(g|f|p|t|r|i|w|e|v)/([A-Za-z0-9_-]{16,40})`)

// withLocation picks the location for the request, in the same order as the Node server.
// (Token-addressed guest routes such as /api/g/:token are resolved when those routes move over.)
func (a *App) withLocation(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		slug := ""
		if m := tokenPath.FindStringSubmatch(r.URL.Path); m != nil {
			slug = a.slugForTokenPath(r.Context(), m[1], m[2])
		}
		if slug == "" {
			slug = "main"
			picks := []string{r.Header.Get("X-Location"), r.URL.Query().Get("l"), a.sess.LocOf(cookie(r, auth.SessionCookie)), a.sess.LocOf(cookie(r, auth.CustomerCookie)), cookie(r, "bh_loc")}
			for _, p := range picks {
				if p != "" && a.db.LocationExists(r.Context(), p) {
					slug = p
					break
				}
			}
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), slugKey, slug)))
	})
}

func slugOf(r *http.Request) string {
	if s, ok := r.Context().Value(slugKey).(string); ok {
		return s
	}
	return "main"
}

// csrf: every state-changing API request must carry X-BuzzHub: 1 (browsers can't add custom
// headers cross-origin without a CORS preflight, which is never approved).
func (a *App) csrf(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api/stripe/webhook" && r.URL.Path != "/api/square/webhook" && r.Header.Get("X-BuzzHub") != "1" {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": "Bad request origin"})
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// HTTPError is returned by handlers to send a status and message.
type HTTPError struct {
	Status int
	Msg    string
	Extra  map[string]any
}

func (e *HTTPError) Error() string      { return e.Msg }
func fail(status int, msg string) error { return &HTTPError{Status: status, Msg: msg} }

// committedError answers with an error but keeps the transaction's changes.
type committedError struct{ HTTPError }

func (e *committedError) Error() string { return e.Msg }

// num turns a setting into a number the way JavaScript's Number() does for plain decimals.
func num(s string) any {
	var f float64
	if _, err := fmt.Sscan(strings.TrimSpace(s), &f); err != nil {
		return nil
	}
	return f
}

type handler func(w http.ResponseWriter, r *http.Request, tx *store.Tx) error

// h runs a handler inside a transaction for the request's location and turns errors into JSON.
func (a *App) h(fn handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var after error // an error answer whose database changes (like an audit entry) should still be kept
		var buf *bufWriter
		err := a.db.In(r.Context(), slugOf(r), func(tx *store.Tx) error {
			buf = newBuf() // reset on retry; nothing reaches the client before commit
			e := fn(buf, r, tx)
			var ce *committedError
			if errors.As(e, &ce) {
				after = &ce.HTTPError
				return nil
			}
			return e
		})
		if err == nil && after != nil {
			err = after
		}
		if err == nil {
			buf.flush(w)
			return
		}
		var he *HTTPError
		if errors.As(err, &he) {
			body := map[string]any{"error": he.Msg}
			for k, v := range he.Extra {
				body[k] = v
			}
			writeJSON(w, he.Status, body)
			return
		}
		a.log.Error("request failed", "path", r.URL.Path, "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "Server error"})
	})
}

type userKey struct{}

// staff requires a signed-in user with at least this role.
func (a *App) staff(minRole string, fn handler) http.Handler {
	return a.h(func(w http.ResponseWriter, r *http.Request, tx *store.Tx) error {
		u, err := a.sess.UserFromToken(r.Context(), tx, cookie(r, auth.SessionCookie))
		if err != nil {
			return fail(http.StatusUnauthorized, "Locked")
		}
		if auth.RoleRank[u.Role] < auth.RoleRank[minRole] {
			return fail(http.StatusForbidden, "Not allowed for your role")
		}
		w.Header().Set("Cache-Control", "no-store")
		return fn(w, r.WithContext(context.WithValue(r.Context(), userKey{}, u)), tx)
	})
}

func userOf(r *http.Request) *auth.User { u, _ := r.Context().Value(userKey{}).(*auth.User); return u }

func cookie(r *http.Request, name string) string {
	if c, err := r.Cookie(name); err == nil {
		return c.Value
	}
	return ""
}

// clientIP is the caller's address (first proxy hop trusted, as Node's "trust proxy 1").
func (a *App) clientIP(r *http.Request) string {
	if a.cfg.TrustProxy {
		if xf := r.Header.Get("X-Forwarded-For"); xf != "" {
			parts := strings.Split(xf, ",")
			return strings.TrimSpace(parts[len(parts)-1])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func readJSON(r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		return fail(http.StatusBadRequest, "Invalid input")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if w.Header().Get("Cache-Control") == "" {
		w.Header().Set("Cache-Control", "no-store")
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

/* ---------- rate limits (fixed window per IP, like express-rate-limit) ---------- */

type limiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string]*window
}
type window struct {
	start time.Time
	n     int
}

func newLimiter(limit int, per time.Duration) *limiter {
	return &limiter{limit: limit, window: per, hits: map[string]*window{}}
}
func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	wd := l.hits[key]
	if wd == nil || now.Sub(wd.start) >= l.window {
		if len(l.hits) > 50_000 {
			l.hits = map[string]*window{}
		}
		l.hits[key] = &window{start: now, n: 1}
		return true
	}
	wd.n++
	return wd.n <= l.limit
}
func (a *App) limit(l *limiter, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !l.allow(a.clientIP(r)) {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "Too many attempts. Slow down."})
			return
		}
		next.ServeHTTP(w, r)
	})
}

/* ---------- static front end ---------- */

// spa serves the built React app, falling back to index.html for client-side routes.
func spa(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			if strings.HasPrefix(r.URL.Path, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			files.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(dir, "index.html"))
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		next.ServeHTTP(w, r)
	})
}
