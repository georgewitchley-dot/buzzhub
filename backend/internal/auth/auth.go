// Package auth holds PIN checks, the login lockout, and session tokens. Tokens and cookies are
// byte-for-byte compatible with the Node server (HS256 JWT, same claims, same cookie names), so
// people stay signed in when traffic moves from one backend to the other.
package auth

import (
	"context"
	"errors"
	"math"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
)

const (
	SessionCookie  = "bh_session"
	CustomerCookie = "bh_customer"
	SessionHours   = 12
	CustomerDays   = 60
	bcryptCost     = 12
	maxFails       = 5
)

// RoleRank orders staff < manager < owner.
var RoleRank = map[string]int{"staff": 1, "manager": 2, "owner": 3}

/* ---------- PINs ---------- */

var pinRE = regexp.MustCompile(`^\d{4,8}$`)
var weak = map[string]bool{"0000": true, "1111": true, "2222": true, "3333": true, "4444": true, "5555": true, "6666": true, "7777": true, "8888": true, "9999": true,
	"1234": true, "4321": true, "0123": true, "1212": true, "6969": true, "1004": true, "2000": true, "2580": true, "00000": true, "12345": true, "000000": true, "111111": true,
	"123456": true, "654321": true, "123123": true}

// PinProblem explains why a PIN can't be used, or returns "".
func PinProblem(pin string) string {
	if !pinRE.MatchString(pin) {
		return "PIN must be 4–8 digits"
	}
	if weak[pin] {
		return "That PIN is too easy to guess"
	}
	same := true
	for i := 1; i < len(pin); i++ {
		if pin[i] != pin[0] {
			same = false
		}
	}
	if same {
		return "PIN cannot be one repeated digit"
	}
	return ""
}

// HashPin hashes a PIN (or password) with bcrypt, as the Node server does.
func HashPin(pin string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pin), bcryptCost)
	return string(b), err
}

// User is the signed-in staff member.
type User struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
}

type userRow struct {
	User
	PinHash        string
	SessionVersion int64
}

// FindUserByPin checks the PIN against every active user (no early exit, so timing doesn't
// reveal anything). PINs are unique, so at most one matches.
func FindUserByPin(ctx context.Context, tx *store.Tx, pin string) (*User, int64, error) {
	rows, err := tx.Query(ctx, `SELECT id, name, role, pin_hash, session_version FROM users WHERE active = 1`)
	if err != nil {
		return nil, 0, err
	}
	var all []userRow
	for rows.Next() {
		var u userRow
		if err := rows.Scan(&u.ID, &u.Name, &u.Role, &u.PinHash, &u.SessionVersion); err != nil {
			rows.Close()
			return nil, 0, err
		}
		all = append(all, u)
	}
	rows.Close()
	var match *userRow
	for i := range all {
		if bcrypt.CompareHashAndPassword([]byte(all[i].PinHash), []byte(pin)) == nil && match == nil {
			match = &all[i]
		}
	}
	if match == nil {
		return nil, 0, nil
	}
	u := match.User
	return &u, match.SessionVersion, nil
}

// PinInUse reports whether another active user already has this PIN.
func PinInUse(ctx context.Context, tx *store.Tx, pin string, exceptID int64) (bool, error) {
	rows, err := tx.Query(ctx, `SELECT id, pin_hash FROM users WHERE active = 1`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var h string
		if err := rows.Scan(&id, &h); err != nil {
			return false, err
		}
		if id != exceptID && bcrypt.CompareHashAndPassword([]byte(h), []byte(pin)) == nil {
			return true, nil
		}
	}
	return false, rows.Err()
}

/* ---------- login lockout (per IP, escalating) ---------- */

type attempt struct {
	fails, strikes        int
	lockedUntil, lastFail time.Time
}

// Lockout tracks failed PINs per IP: 5 misses lock the terminal for 30 s, then 2 m, 8 m, 32 m, up to 1 h.
type Lockout struct {
	mu sync.Mutex
	m  map[string]*attempt
}

func NewLockout() *Lockout {
	l := &Lockout{m: map[string]*attempt{}}
	go func() {
		for range time.Tick(10 * time.Minute) {
			l.mu.Lock()
			now := time.Now()
			for ip, a := range l.m {
				if a.lockedUntil.Before(now) && now.Sub(a.lastFail) > time.Hour {
					delete(l.m, ip)
				}
			}
			l.mu.Unlock()
		}
	}()
	return l
}

// Blocked returns the seconds left on a lock (0 = not locked).
func (l *Lockout) Blocked(ip string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.blocked(ip)
}
func (l *Lockout) blocked(ip string) int {
	a := l.m[ip]
	if a == nil {
		return 0
	}
	left := time.Until(a.lockedUntil)
	if left <= 0 {
		return 0
	}
	return int(math.Ceil(left.Seconds()))
}

// Fail records a miss and returns tries remaining and seconds locked.
func (l *Lockout) Fail(ip string) (remaining, lockedFor int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	a := l.m[ip]
	if a == nil {
		a = &attempt{}
		l.m[ip] = a
	}
	a.fails++
	if a.fails >= maxFails {
		a.strikes++
		d := time.Duration(30_000*math.Pow(4, float64(a.strikes-1))) * time.Millisecond
		if d > time.Hour {
			d = time.Hour
		}
		a.lockedUntil = time.Now().Add(d)
		a.fails = 0
	}
	a.lastFail = time.Now()
	lockedFor = l.blocked(ip)
	if lockedFor > 0 {
		return 0, lockedFor
	}
	return maxFails - a.fails, 0
}

// Clear forgets an IP's misses after a good PIN.
func (l *Lockout) Clear(ip string) { l.mu.Lock(); delete(l.m, ip); l.mu.Unlock() }

/* ---------- session tokens ---------- */

// Sessions signs and checks session tokens.
type Sessions struct {
	Secret []byte
	Secure bool // set the Secure flag on cookies (production)
}

type sessionClaims struct {
	Typ string `json:"typ"`
	Loc string `json:"loc"`
	UID int64  `json:"uid,omitempty"`
	CID int64  `json:"cid,omitempty"`
	SV  int64  `json:"sv"`
	jwt.RegisteredClaims
}

// Issue sets the staff session cookie.
func (s *Sessions) Issue(w http.ResponseWriter, slug string, userID, sessionVersion int64) error {
	now := time.Now()
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, sessionClaims{Typ: "s", Loc: slug, UID: userID, SV: sessionVersion,
		RegisteredClaims: jwt.RegisteredClaims{IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(SessionHours * time.Hour))}}).SignedString(s.Secret)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{Name: SessionCookie, Value: tok, Path: "/", HttpOnly: true, Secure: s.Secure, SameSite: http.SameSiteStrictMode, MaxAge: SessionHours * 3600})
	return nil
}

// Clear removes the staff session cookie.
func (s *Sessions) Clear(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: SessionCookie, Value: "", Path: "/", HttpOnly: true, Secure: s.Secure, SameSite: http.SameSiteStrictMode, MaxAge: -1})
}

func (s *Sessions) parse(token string) (*sessionClaims, error) {
	c := &sessionClaims{}
	_, err := jwt.ParseWithClaims(token, c, func(t *jwt.Token) (any, error) { return s.Secret, nil }, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil {
		return nil, err
	}
	if c.Loc == "" {
		c.Loc = "main"
	}
	return c, nil
}

// LocOf returns the location claim in any valid token, or "".
func (s *Sessions) LocOf(token string) string {
	if token == "" {
		return ""
	}
	c, err := s.parse(token)
	if err != nil {
		return ""
	}
	return c.Loc
}

// ErrNoSession means the request isn't signed in (or the session was revoked).
var ErrNoSession = errors.New("locked")

// UserFromToken checks a staff token against the user's current session version and role.
func (s *Sessions) UserFromToken(ctx context.Context, tx *store.Tx, token string) (*User, error) {
	if token == "" {
		return nil, ErrNoSession
	}
	c, err := s.parse(token)
	if err != nil || (c.Typ != "" && c.Typ != "s") || c.Loc != tx.Slug {
		return nil, ErrNoSession
	}
	var u User
	var sv, active int64
	if err := tx.QueryRow(ctx, `SELECT id, name, role, session_version, active FROM users WHERE id = $1`, c.UID).Scan(&u.ID, &u.Name, &u.Role, &sv, &active); err != nil || active == 0 || sv != c.SV {
		return nil, ErrNoSession
	}
	return &u, nil
}
