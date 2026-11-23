package server

import (
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestHealthAndSPA(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>app</html>"), 0o644)
	h := New(Config{StaticDir: dir}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, c := range []struct {
		path string
		code int
		body string
	}{
		{"/healthz", 200, `"ok":true`}, {"/pad", 200, "app"}, {"/api/staff/settings", 501, "hasn't moved"},
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", c.path, nil))
		if rec.Code != c.code || !contains(rec.Body.String(), c.body) {
			t.Errorf("%s: got %d %q", c.path, rec.Code, rec.Body.String())
		}
	}
}
func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || indexOf(s, sub) >= 0)
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
