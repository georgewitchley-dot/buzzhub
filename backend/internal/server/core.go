package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"strings"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
)

func emailEnabled() bool {
	return os.Getenv("SMTP_HOST") != "" && os.Getenv("SMTP_USER") != "" && os.Getenv("SMTP_PASS") != ""
}

/* ---------- first-run setup ---------- */

func (a *App) prepareSetup(ctx context.Context) error {
	return a.db.In(ctx, "main", func(tx *store.Tx) error {
		n, err := tx.Int(ctx, `SELECT COUNT(*) FROM users`)
		if err != nil || n > 0 {
			return err
		}
		a.setup = a.cfg.SetupCode
		if a.setup == "" {
			v, _ := rand.Int(rand.Reader, big.NewInt(900000))
			a.setup = fmt.Sprint(100000 + v.Int64())
		}
		a.log.Info("BuzzHub first-run setup required", "setup_code", a.setup)
		return nil
	})
}

func (a *App) setupStatus(w http.ResponseWriter, r *http.Request, tx *store.Tx) error {
	n, err := tx.Int(r.Context(), `SELECT COUNT(*) FROM users`)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"needsSetup": n == 0})
	return nil
}

type setupBody struct {
	SetupCode    string `json:"setupCode"`
	BusinessName string `json:"businessName"`
	BusinessType string `json:"businessType"`
	OwnerName    string `json:"ownerName"`
	Pin          string `json:"pin"`
	Seed         *bool  `json:"seed"`
}

func (a *App) doSetup(w http.ResponseWriter, r *http.Request, tx *store.Tx) error {
	ctx := r.Context()
	if n, err := tx.Int(ctx, `SELECT COUNT(*) FROM users`); err != nil {
		return err
	} else if n > 0 {
		return fail(http.StatusConflict, "Already set up")
	}
	var b setupBody
	if err := readJSON(r, &b); err != nil {
		return err
	}
	b.BusinessName, b.OwnerName = strings.TrimSpace(b.BusinessName), strings.TrimSpace(b.OwnerName)
	unit := map[string]string{"restaurant": "Table", "cafe": "Order", "service": "Appointment"}[b.BusinessType]
	switch {
	case b.SetupCode == "" || len(b.SetupCode) > 64:
		return fail(http.StatusBadRequest, "setupCode: Required")
	case b.BusinessName == "" || len([]rune(b.BusinessName)) > 60:
		return fail(http.StatusBadRequest, "businessName: Enter 1 to 60 characters")
	case unit == "":
		return fail(http.StatusBadRequest, "businessType: Pick restaurant, cafe or service")
	case b.OwnerName == "" || len([]rune(b.OwnerName)) > 40:
		return fail(http.StatusBadRequest, "ownerName: Enter 1 to 40 characters")
	}
	a.setupMu.Lock()
	code := a.setup
	a.setupMu.Unlock()
	if code == "" || subtle.ConstantTimeCompare([]byte(b.SetupCode), []byte(code)) != 1 {
		a.lockout.Fail(a.clientIP(r))
		return fail(http.StatusForbidden, "Wrong setup code. Check the server logs.")
	}
	if p := auth.PinProblem(b.Pin); p != "" {
		return fail(http.StatusBadRequest, p)
	}
	svc := b.BusinessType == "service"
	flag := func(v bool) string {
		if v {
			return "1"
		}
		return "0"
	}
	if err := tx.SetSettings(ctx, map[string]string{"business_name": b.BusinessName, "business_type": b.BusinessType, "unit_label": unit, "booking_enabled": flag(svc), "preorder_enabled": flag(!svc)}); err != nil {
		return err
	}
	hash, err := auth.HashPin(b.Pin)
	if err != nil {
		return err
	}
	var id, sv int64
	if err := tx.QueryRow(ctx, `INSERT INTO users (name, role, pin_hash) VALUES ($1, 'owner', $2) RETURNING id, session_version`, b.OwnerName, hash).Scan(&id, &sv); err != nil {
		return err
	}
	// Demo data (tables, menu) moves over with the menu and floor areas; until then setup starts empty.
	if err := tx.Audit(ctx, &id, &b.OwnerName, "setup.complete", b.BusinessName, a.clientIP(r)); err != nil {
		return err
	}
	a.setupMu.Lock()
	a.setup = ""
	a.setupMu.Unlock()
	if err := a.sess.Issue(w, tx.Slug, id, sv); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

/* ---------- PIN sign-in ---------- */

func (a *App) login(w http.ResponseWriter, r *http.Request, tx *store.Tx) error {
	ctx, ip := r.Context(), a.clientIP(r)
	if wait := a.lockout.Blocked(ip); wait > 0 {
		return &HTTPError{Status: http.StatusTooManyRequests, Msg: fmt.Sprintf("Terminal locked. Try again in %ds.", wait), Extra: map[string]any{"lockedFor": wait}}
	}
	var b struct {
		Pin string `json:"pin"`
	}
	if err := readJSON(r, &b); err != nil {
		return err
	}
	if !pinOK(b.Pin) {
		return fail(http.StatusBadRequest, "pin: Enter your 4–8 digit PIN")
	}
	u, sv, err := auth.FindUserByPin(ctx, tx, b.Pin)
	if err != nil {
		return err
	}
	if u == nil {
		remaining, locked := a.lockout.Fail(ip)
		if err := tx.Audit(ctx, nil, nil, "auth.fail", fmt.Sprintf("bad PIN (%d left)", remaining), ip); err != nil {
			return err
		}
		c := &C{a: a, W: w, R: r, Tx: tx, Ctx: ctx}
		c.Emit("owners", "security", map[string]any{"type": "bad_pin", "ip": ip, "at": nowMs()})
		c.onBadPin(ip)
		msg := "Wrong PIN"
		if locked > 0 {
			msg = fmt.Sprintf("Too many wrong PINs. Locked for %ds.", locked)
		}
		// Commit the audit entry, then answer 401.
		return &committedError{HTTPError{Status: http.StatusUnauthorized, Msg: msg, Extra: map[string]any{"remaining": remaining, "lockedFor": locked}}}
	}
	a.lockout.Clear(ip)
	c := &C{a: a, W: w, R: r, Tx: tx, Ctx: ctx}
	row, err := c.Get(`SELECT * FROM users WHERE id = ?`, u.ID)
	if err != nil {
		return err
	}
	if ok, err := c.authGate(row, ""); !ok || err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET last_login_at = $1 WHERE id = $2`, store.Now(), u.ID); err != nil {
		return err
	}
	if err := a.sess.Issue(w, tx.Slug, u.ID, sv); err != nil {
		return err
	}
	if err := tx.Audit(ctx, &u.ID, &u.Name, "auth.login", "", ip); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": u})
	return nil
}

func pinOK(p string) bool {
	if len(p) < 4 || len(p) > 8 {
		return false
	}
	for _, c := range p {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func (a *App) logout(w http.ResponseWriter, r *http.Request, tx *store.Tx) error {
	if u, err := a.sess.UserFromToken(r.Context(), tx, cookie(r, auth.SessionCookie)); err == nil {
		if err := tx.Audit(r.Context(), &u.ID, &u.Name, "auth.lock", "", a.clientIP(r)); err != nil {
			return err
		}
	}
	a.sess.Clear(w)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

func (a *App) me(w http.ResponseWriter, r *http.Request, tx *store.Tx) error {
	u, err := a.sess.UserFromToken(r.Context(), tx, cookie(r, auth.SessionCookie))
	if err != nil {
		return fail(http.StatusUnauthorized, "Locked")
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": u})
	return nil
}

/* ---------- public business info ---------- */

func (a *App) publicBusiness(w http.ResponseWriter, r *http.Request, tx *store.Tx) error {
	ctx := r.Context()
	s, err := tx.Settings(ctx)
	if err != nil {
		return err
	}
	waiting, err := tx.Int(ctx, `SELECT COUNT(*) FROM guests WHERE kind = 'table' AND status IN ('waiting','buzzed','acknowledged')`)
	if err != nil {
		return err
	}
	var logo any
	if s["logo_version"] != "0" {
		logo = fmt.Sprintf("/api/public/logo?l=%s&v=%s", tx.Slug, s["logo_version"])
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name": s["business_name"], "accent": s["accent"], "type": s["business_type"], "unitLabel": s["unit_label"], "selfCheckin": s["self_checkin"] == "1",
		"waiting": waiting, "avgTurn": num(s["avg_turn_minutes"]), "emailAlerts": emailEnabled(),
		"slug": tx.Slug, "preorder": s["preorder_enabled"] == "1", "booking": s["booking_enabled"] == "1", "logo": logo,
	})
	return nil
}

func (a *App) publicLogo(w http.ResponseWriter, r *http.Request, tx *store.Tx) error {
	var mime string
	var data []byte
	if err := tx.QueryRow(r.Context(), `SELECT mime, data FROM assets WHERE key = 'logo'`).Scan(&mime, &data); err != nil {
		w.WriteHeader(http.StatusNotFound)
		return nil
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("Content-Security-Policy", "default-src 'none'")
	_, _ = w.Write(data)
	return nil
}

/* ---------- settings ---------- */

func (a *App) getSettings(w http.ResponseWriter, r *http.Request, tx *store.Tx) error {
	s, err := tx.Settings(r.Context())
	if err != nil {
		return err
	}
	out := make(map[string]any, len(s)+1)
	for k, v := range s {
		out[k] = v
	}
	out["email_enabled"] = emailEnabled()
	writeJSON(w, http.StatusOK, out)
	return nil
}
