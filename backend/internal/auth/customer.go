package auth

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
)

// Customer accounts: a separate cookie and token type ("c"), 60 days, SameSite=Lax.

type Customer struct {
	ID    int64   `json:"id"`
	Name  string  `json:"name"`
	Email string  `json:"email"`
	Phone *string `json:"phone"`
}

type customerClaims struct {
	Typ string `json:"typ"`
	Loc string `json:"loc"`
	CID int64  `json:"cid"`
	SV  int64  `json:"sv"`
	jwt.RegisteredClaims
}

var repeated = regexp.MustCompile(`^(.)+$`)

// PasswordProblem returns why a customer password is too weak, or "".
func PasswordProblem(pw string) string {
	n := len([]rune(pw))
	if n < 8 {
		return "Use at least 8 characters"
	}
	if n > 128 {
		return "Password is too long"
	}
	r := []rune(pw)
	same := true
	for _, c := range r[1:] {
		if c != r[0] {
			same = false
			break
		}
	}
	switch strings.ToLower(pw) {
	case "password", "12345678", "qwertyui", "11111111":
		return "Pick a harder password"
	}
	if same {
		return "Pick a harder password"
	}
	_ = repeated
	return ""
}

func HashPassword(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pw), bcryptCost)
	return string(b), err
}

func CheckPassword(pw, hash string) bool {
	return bcrypt.CompareHashAndPassword([]byte(normalizeHash(hash)), []byte(pw)) == nil
}

var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("dummy-password-for-timing"), bcryptCost)

// BurnCompare equalises timing when the email doesn't exist.
func BurnCompare(pw string) { _ = bcrypt.CompareHashAndPassword(dummyHash, []byte(pw)) }

// normalizeHash accepts bcryptjs "$2b$"/"$2y$" hashes.
func normalizeHash(h string) string {
	if strings.HasPrefix(h, "$2y$") {
		return "$2a$" + h[4:]
	}
	return h
}

func (s *Sessions) IssueCustomer(w http.ResponseWriter, slug string, id, sv int64) error {
	now := time.Now()
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, customerClaims{Typ: "c", Loc: slug, CID: id, SV: sv,
		RegisteredClaims: jwt.RegisteredClaims{IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(CustomerDays * 24 * time.Hour))}}).SignedString(s.Secret)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{Name: CustomerCookie, Value: tok, Path: "/", HttpOnly: true, Secure: s.Secure, SameSite: http.SameSiteLaxMode, MaxAge: CustomerDays * 86400})
	return nil
}

func (s *Sessions) ClearCustomer(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: CustomerCookie, Value: "", Path: "/", HttpOnly: true, Secure: s.Secure, SameSite: http.SameSiteLaxMode, MaxAge: -1})
}

// CustomerFromToken returns the signed-in customer for this location, or nil.
func (s *Sessions) CustomerFromToken(ctx context.Context, tx *store.Tx, token string) *Customer {
	if token == "" {
		return nil
	}
	c := &customerClaims{}
	if _, err := jwt.ParseWithClaims(token, c, func(t *jwt.Token) (any, error) { return s.Secret, nil }, jwt.WithValidMethods([]string{"HS256"})); err != nil {
		return nil
	}
	loc := c.Loc
	if loc == "" {
		loc = "main"
	}
	if c.Typ != "c" || loc != tx.Slug {
		return nil
	}
	var cu Customer
	var sv int64
	if err := tx.QueryRow(ctx, `SELECT id, name, email, phone, session_version FROM customers WHERE id = $1`, c.CID).Scan(&cu.ID, &cu.Name, &cu.Email, &cu.Phone, &sv); err != nil || sv != c.SV {
		return nil
	}
	return &cu
}

// Device tokens: kiosks, screens, displays, clocks, KDS, boards and print helpers are paired with
// a token signed with "<secret>:<kind>" (same scheme as Node).
func (s *Sessions) SignDevice(kind string, claims jwt.MapClaims) (string, error) {
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(append(append([]byte{}, s.Secret...), []byte(":"+kind)...))
}

func (s *Sessions) VerifyDevice(kind, token string) (jwt.MapClaims, bool) {
	if token == "" {
		return nil, false
	}
	claims := jwt.MapClaims{}
	key := append(append([]byte{}, s.Secret...), []byte(":"+kind)...)
	if _, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) { return key, nil }, jwt.WithValidMethods([]string{"HS256"})); err != nil {
		return nil, false
	}
	return claims, true
}
