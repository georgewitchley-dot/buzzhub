package auth

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

func TestPinProblem(t *testing.T) {
	cases := map[string]bool{"4826": true, "12345678": true, "1234": false, "0000": false, "777777": false, "12": false, "123456789": false, "12a4": false}
	for pin, good := range cases {
		if (PinProblem(pin) == "") != good {
			t.Errorf("PinProblem(%q) = %q", pin, PinProblem(pin))
		}
	}
}

func TestLockoutEscalates(t *testing.T) {
	l := NewLockout()
	for i := 1; i <= 4; i++ {
		if rem, lock := l.Fail("1.2.3.4"); rem != 5-i || lock != 0 {
			t.Fatalf("fail %d: remaining %d locked %d", i, rem, lock)
		}
	}
	if _, lock := l.Fail("1.2.3.4"); lock < 29 || lock > 30 {
		t.Fatalf("first lock should be 30s, got %d", lock)
	}
	if l.Blocked("1.2.3.4") == 0 || l.Blocked("5.6.7.8") != 0 {
		t.Fatal("lock should apply to that IP only")
	}
	l.Clear("1.2.3.4")
	if l.Blocked("1.2.3.4") != 0 {
		t.Fatal("clear should unlock")
	}
}

// Node's bcryptjs writes $2a$/$2b$ hashes; Go must accept them.
func TestBcryptFromNode(t *testing.T) {
	h, _ := bcrypt.GenerateFromPassword([]byte("4826"), 4)
	node := strings.Replace(string(h), "$2a$", "$2b$", 1)
	if bcrypt.CompareHashAndPassword([]byte(node), []byte("4826")) != nil {
		t.Fatal("$2b$ hash should verify")
	}
}

func TestSessionCookieAndClaims(t *testing.T) {
	s := &Sessions{Secret: []byte(strings.Repeat("k", 40))}
	rec := httptest.NewRecorder()
	if err := s.Issue(rec, "main", 7, 3); err != nil {
		t.Fatal(err)
	}
	c := rec.Result().Cookies()[0]
	if c.Name != SessionCookie || !c.HttpOnly || c.MaxAge != SessionHours*3600 {
		t.Fatalf("cookie: %+v", c)
	}
	claims := jwt.MapClaims{}
	if _, err := jwt.ParseWithClaims(c.Value, claims, func(*jwt.Token) (any, error) { return s.Secret, nil }); err != nil {
		t.Fatal(err)
	}
	if claims["typ"] != "s" || claims["loc"] != "main" || claims["uid"].(float64) != 7 || claims["sv"].(float64) != 3 {
		t.Fatalf("claims: %v", claims)
	}
	if s.LocOf(c.Value) != "main" || s.LocOf("garbage") != "" {
		t.Fatal("LocOf")
	}
}
