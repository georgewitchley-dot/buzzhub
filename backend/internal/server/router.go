package server

import (
	"net/http"
	"strings"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
)

// router registers ported routes: public ones under /api and staff ones under /api/staff.
type router struct {
	a   *App
	mux *http.ServeMux
}

type mw = func(http.Handler) http.Handler

func split(pattern string) (string, string) {
	m, p, _ := strings.Cut(pattern, " ")
	return m, p
}

// pub registers "METHOD /api/path".
func (rt *router) pub(pattern string, fn Fn, mws ...mw) {
	var h http.Handler = rt.a.h(rt.a.do(fn))
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	rt.mux.Handle(pattern, h)
}

// staff registers "METHOD /path" under /api/staff for a minimum role.
func (rt *router) staff(pattern, role string, fn Fn, mws ...mw) {
	m, p := split(pattern)
	var h http.Handler = rt.a.staff(role, rt.a.do(fn))
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	rt.mux.Handle(m+" /api/staff"+p, h)
}

// limits (fixed windows per IP, like the Node server's express-rate-limit settings)
func (a *App) lim(l *limiter, msg string, skipTrusted bool) mw {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if skipTrusted && a.isTrustedDevice(r) {
				next.ServeHTTP(w, r)
				return
			}
			if !l.allow(a.clientIP(r)) {
				writeJSON(w, http.StatusTooManyRequests, M{"error": msg})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

type limits struct {
	api, public, order, join, cust *limiter
}

func newLimits() limits {
	return limits{
		api:    newLimiter(1200, time.Minute),
		public: newLimiter(240, time.Minute),
		order:  newLimiter(20, 10*time.Minute),
		join:   newLimiter(6, 10*time.Minute),
		cust:   newLimiter(20, 15*time.Minute),
	}
}

func (a *App) publicLim() mw {
	return a.lim(a.lims.public, "Too many requests, please try again later.", true)
}
func (a *App) orderLim() mw {
	return a.lim(a.lims.order, "Too many order changes. Please ask your server.", false)
}
func (a *App) joinLim() mw {
	return a.lim(a.lims.join, "Too many check-ins from this device. Please see the host.", false)
}
func (a *App) custLim() mw {
	return a.lim(a.lims.cust, "Too many attempts. Try again in a few minutes.", false)
}
func (a *App) authLim() mw { return a.lim(a.authRate, "Too many attempts. Slow down.", false) }

var deviceHeaders = [][2]string{{"X-Kiosk", "kiosk"}, {"X-Screen", "screen"}, {"X-Display", "display"}, {"X-Clock", "clock"}, {"X-Kds", "kds"}, {"X-Board", "board"}, {"X-Print", "print"}}

// isTrustedDevice: a signed-in terminal or a paired device skips the public rate limits.
func (a *App) isTrustedDevice(r *http.Request) bool {
	if t := cookie(r, auth.SessionCookie); t != "" && a.sess.LocOf(t) != "" {
		return true
	}
	for _, d := range deviceHeaders {
		if _, ok := a.sess.VerifyDevice(d[1], r.Header.Get(d[0])); ok {
			return true
		}
	}
	return false
}
