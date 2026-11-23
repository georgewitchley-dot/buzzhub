package server

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// Owner/manager two-step codes (TOTP), approved devices, manager approval for risky actions,
// refunds and security alerts (guard.js). Tokens and sealed secrets match the Node server.

const deviceCookie = "bh_device"
const trustCookie = "bh_2fa"

func (a *App) totpKey() []byte {
	h := sha256.Sum256([]byte("buzzhub-totp:" + string(a.sess.Secret)))
	return h[:]
}

// seal/open: AES-256-GCM, "iv.tag.ciphertext" in base64url (Node's layout).
func (a *App) seal(plain string) string {
	blk, _ := aes.NewCipher(a.totpKey())
	g, _ := cipher.NewGCM(blk)
	iv := make([]byte, 12)
	_, _ = rand.Read(iv)
	out := g.Seal(nil, iv, []byte(plain), nil)
	enc, tag := out[:len(out)-16], out[len(out)-16:]
	e := base64.RawURLEncoding.EncodeToString
	return e(iv) + "." + e(tag) + "." + e(enc)
}
func (a *App) open(box string) (string, error) {
	p := strings.Split(box, ".")
	if len(p) != 3 {
		return "", fmt.Errorf("bad box")
	}
	d := base64.RawURLEncoding.DecodeString
	iv, err1 := d(p[0])
	tag, err2 := d(p[1])
	enc, err3 := d(p[2])
	if err1 != nil || err2 != nil || err3 != nil {
		return "", fmt.Errorf("bad box")
	}
	blk, _ := aes.NewCipher(a.totpKey())
	g, _ := cipher.NewGCM(blk)
	out, err := g.Open(nil, iv, append(enc, tag...), nil)
	return string(out), err
}

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

func b32decode(s string) []byte {
	s = strings.ToUpper(strings.TrimRight(s, "="))
	clean := strings.Builder{}
	for _, ch := range s {
		if strings.ContainsRune("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", ch) {
			clean.WriteRune(ch)
		}
	}
	str := clean.String()
	// Node drops trailing partial bits; pad to a full block for Go's decoder then trim.
	n := len(str) * 5 / 8
	for len(str)%8 != 0 {
		str += "A"
	}
	b, _ := b32.DecodeString(str)
	if len(b) > n {
		b = b[:n]
	}
	return b
}

func hotp(secret string, counter int64) string {
	buf := make([]byte, 8)
	binary.BigEndian.PutUint64(buf, uint64(counter))
	m := hmac.New(sha1.New, b32decode(secret))
	m.Write(buf)
	h := m.Sum(nil)
	o := h[len(h)-1] & 15
	v := binary.BigEndian.Uint32(h[o:o+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", v%1000000)
}

// checkTotp returns the matched time step, or 0. Accepts ±1 step; no replays.
func checkTotp(secret, code string, lastStep int64) int64 {
	step := time.Now().Unix() / 30
	c := code
	for len(c) < 6 {
		c = "0" + c
	}
	if len(c) > 6 {
		c = c[:6]
	}
	for _, s := range []int64{step, step - 1, step + 1} {
		if s <= lastStep {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(hotp(secret, s)), []byte(c)) == 1 {
			return s
		}
	}
	return 0
}

var sixDigits = regexp.MustCompile(`^\d{6}$`)
var recoveryRE = regexp.MustCompile(`(?i)^[a-z0-9]{10}$`)

func (c *C) verifySecondFactor(u store.Row, code string) (string, error) {
	code = strings.NewReplacer(" ", "", "\t", "", "-", "").Replace(code)
	if sixDigits.MatchString(code) {
		sec, err := c.a.open(str(u["totp_secret"]))
		if err != nil {
			return "", nil
		}
		if s := checkTotp(sec, code, i64(u["totp_last_step"])); s > 0 {
			_, err := c.Run(`UPDATE users SET totp_last_step = ? WHERE id = ?`, s, u["id"])
			return "totp", err
		}
		return "", nil
	}
	if recoveryRE.MatchString(code) {
		rows, err := c.All(`SELECT * FROM recovery_codes WHERE user_id = ? AND used_at IS NULL`, u["id"])
		if err != nil {
			return "", err
		}
		for _, r := range rows {
			if bcrypt.CompareHashAndPassword([]byte(normalizeBcrypt(str(r["code_hash"]))), []byte(strings.ToLower(code))) == nil {
				_, err := c.Run(`UPDATE recovery_codes SET used_at = datetime('now') WHERE id = ?`, r["id"])
				return "recovery", err
			}
		}
	}
	return "", nil
}

func normalizeBcrypt(h string) string {
	if strings.HasPrefix(h, "$2y$") {
		return "$2a$" + h[4:]
	}
	return h
}

/* ---------- device identity ---------- */

var deviceIDRE = regexp.MustCompile(`^[A-Za-z0-9_-]{22,40}$`)

func (c *C) deviceID() string {
	id := cookie(c.R, deviceCookie)
	if !deviceIDRE.MatchString(id) {
		id = newToken(18)
		http.SetCookie(c.W, &http.Cookie{Name: deviceCookie, Value: id, Path: "/", HttpOnly: true, Secure: c.a.cfg.Production, SameSite: http.SameSiteStrictMode, MaxAge: 400 * 86400})
	}
	return id
}

func deviceLabel(ua string) string {
	has := func(s string) bool { return strings.Contains(ua, s) }
	os := "Device"
	switch {
	case has("iPad"):
		os = "iPad"
	case has("iPhone"):
		os = "iPhone"
	case has("Android"):
		os = "Android"
	case has("Mac OS X"):
		os = "Mac"
	case has("Windows"):
		os = "Windows PC"
	case has("CrOS"):
		os = "Chromebook"
	}
	br := ""
	switch {
	case has("Edg/"):
		br = "Edge"
	case has("Chrome/"):
		br = "Chrome"
	case has("Firefox/"):
		br = "Firefox"
	case has("Safari/"):
		br = "Safari"
	}
	if br != "" {
		return os + ", " + br
	}
	return os
}

func trunc(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func (c *C) deviceRow() (store.Row, error) {
	did := c.deviceID()
	d, err := c.One(`SELECT * FROM devices WHERE device_id = ?`, did)
	if err != nil {
		return nil, err
	}
	if d == nil {
		v, _ := rand.Int(rand.Reader, big.NewInt(9000))
		ua := c.R.UserAgent()
		if _, err := c.Run(`INSERT INTO devices (device_id, name, user_agent, ip, code) VALUES (?, ?, ?, ?, ?)`, did, deviceLabel(ua), trunc(ua, 200), c.IP(), fmt.Sprint(1000+v.Int64())); err != nil {
			return nil, err
		}
		if d, err = c.Get(`SELECT * FROM devices WHERE device_id = ?`, did); err != nil {
			return nil, err
		}
	}
	_, err = c.Run(`UPDATE devices SET last_seen = ?, ip = ? WHERE id = ?`, store.Now(), c.IP(), d["id"])
	return d, err
}

/* ---------- alerts to owners & managers ---------- */

func (c *C) alertOwners(title, body, tag string) {
	if tag == "" {
		tag = "security"
	}
	c.Emit("owners", "security", M{"type": "alert", "detail": body, "at": nowMs()})
	c.a.pushToUsers(c.Ctx, c.Tx, []string{"owner", "manager"}, M{"title": title, "body": body, "tag": tag, "url": "/security", "kind": "security"}, 0)
}

type failMark struct {
	t  time.Time
	ip string
}

var (
	recentFails   []failMark
	recentFailsMu sync.Mutex
)

func (c *C) onBadPin(ip string) {
	recentFailsMu.Lock()
	t := time.Now()
	recentFails = append(recentFails, failMark{t, ip})
	for len(recentFails) > 0 && t.Sub(recentFails[0].t) > 5*time.Minute {
		recentFails = recentFails[1:]
	}
	fromIP := 0
	for _, f := range recentFails {
		if f.ip == ip {
			fromIP++
		}
	}
	total := len(recentFails)
	recentFailsMu.Unlock()
	if fromIP == 3 || total == 6 {
		n, where := total, ""
		if fromIP >= 3 {
			n, where = fromIP, " from "+ip
		}
		c.alertOwners(c.S()["business_name"]+": wrong PINs", fmt.Sprintf("%d wrong PIN attempts in the last 5 minutes%s.", n, where), "badpin")
	}
}

/* ---------- the login gate ---------- */

type tokClaims = jwt.MapClaims

func (a *App) signJWT(claims jwt.MapClaims, ttl time.Duration) string {
	now := time.Now()
	claims["iat"] = now.Unix()
	if ttl > 0 {
		claims["exp"] = now.Add(ttl).Unix()
	}
	s, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(a.sess.Secret)
	return s
}
func (a *App) verifyJWT(tok string) (jwt.MapClaims, bool) {
	if tok == "" {
		return nil, false
	}
	cl := jwt.MapClaims{}
	if _, err := jwt.ParseWithClaims(tok, cl, func(t *jwt.Token) (any, error) { return a.sess.Secret, nil }, jwt.WithValidMethods([]string{"HS256"})); err != nil {
		return nil, false
	}
	return cl, true
}
func locClaim(cl jwt.MapClaims) string {
	if s, _ := cl["loc"].(string); s != "" {
		return s
	}
	return "main"
}

func (c *C) trustOK(uid int64) bool {
	cl, ok := c.a.verifyJWT(cookie(c.R, trustCookie))
	return ok && cl["typ"] == "2fa" && i64(cl["uid"]) == uid && locClaim(cl) == c.Slug()
}
func (c *C) grantTrust(uid int64) {
	tok := c.a.signJWT(jwt.MapClaims{"typ": "2fa", "loc": c.Slug(), "uid": uid}, 12*time.Hour)
	http.SetCookie(c.W, &http.Cookie{Name: trustCookie, Value: tok, Path: "/", HttpOnly: true, Secure: c.a.cfg.Production, SameSite: http.SameSiteStrictMode, MaxAge: 12 * 3600})
}

// authGate runs after a correct PIN. It returns true when the session may be issued;
// otherwise it has answered (or returns the error answer to send).
func (c *C) authGate(u store.Row, secondFactor string) (bool, error) {
	s := c.S()
	d, err := c.deviceRow()
	if err != nil {
		return false, err
	}
	uid := i64(u["id"])
	user := &auth.User{ID: uid, Name: str(u["name"]), Role: str(u["role"])}
	isMgr := auth.RoleRank[user.Role] >= auth.RoleRank["manager"]
	if truthy(u["totp_enabled"]) && isMgr && !c.trustOK(uid) {
		if secondFactor == "" {
			ticket := c.a.signJWT(jwt.MapClaims{"typ": "2fa-ticket", "loc": c.Slug(), "uid": uid}, 5*time.Minute)
			return false, c.JSON(M{"needs2fa": true, "ticket": ticket, "name": user.Name})
		}
		how, err := c.verifySecondFactor(u, secondFactor)
		if err != nil {
			return false, err
		}
		if how == "" {
			if err := c.AuditAs(user, "auth.2fa_fail", "", c.IP()); err != nil {
				return false, err
			}
			c.a.lockout.Fail(c.IP())
			return false, &committedError{HTTPError{Status: 401, Msg: "That code is not right. Check the time on your phone and try again.", Extra: M{"needs2fa": true}}}
		}
		if how == "recovery" {
			c.alertOwners(s["business_name"]+": recovery code used", user.Name+" signed in with a one-time recovery code.", "")
		}
		c.grantTrust(uid)
	}
	if str(d["status"]) == "blocked" {
		if err := c.AuditAs(user, "auth.blocked_device", str(d["name"]), c.IP()); err != nil {
			return false, err
		}
		return false, &committedError{HTTPError{Status: 403, Msg: "This device has been blocked by the owner."}}
	}
	if s["require_approved_devices"] == "1" && str(d["status"]) != "approved" {
		if user.Role == "owner" && truthy(u["totp_enabled"]) && (secondFactor != "" || c.trustOK(uid)) {
			if _, err := c.Run(`UPDATE devices SET status='approved', approved_by=? WHERE id=?`, uid, d["id"]); err != nil {
				return false, err
			}
			if err := c.AuditAs(user, "device.self_approve", str(d["name"]), c.IP()); err != nil {
				return false, err
			}
		} else {
			if err := c.AuditAs(user, "device.pending", fmt.Sprintf("%s (code %s)", str(d["name"]), str(d["code"])), c.IP()); err != nil {
				return false, err
			}
			c.alertOwners(s["business_name"]+": new device", fmt.Sprintf("%s is trying to sign in on a new %s. Code %s. Approve it in Security.", user.Name, str(d["name"]), str(d["code"])), "device")
			c.Notify("devices")
			return false, &committedError{HTTPError{Status: 403, Msg: "This device needs the owner's approval first.", Extra: M{"deviceApproval": true, "code": d["code"]}}}
		}
	}
	return true, nil
}

/* ---------- manager approval for risky actions ---------- */

var approvalActions = map[string]string{"void": "Void an order", "discount": "Give a big discount", "refund": "Refund an order", "cash_close": "Close the cash drawer", "nosale": "Open the cash drawer without a sale"}

// hasApproval returns the approver for this action from the X-Approval header, or nil.
func (c *C) hasApproval(action string) (*auth.User, error) {
	cl, ok := c.a.verifyJWT(c.R.Header.Get("X-Approval"))
	if !ok || c.U == nil || cl["typ"] != "approval" || locClaim(cl) != c.Slug() || cl["act"] != action || i64(cl["for"]) != c.U.ID {
		return nil, nil
	}
	r, err := c.One(`SELECT id, name, role FROM users WHERE id = ?`, i64(cl["by"]))
	if err != nil || r == nil {
		return nil, err
	}
	return &auth.User{ID: i64(r["id"]), Name: str(r["name"]), Role: str(r["role"])}, nil
}

// managerOr lets a request through for managers, or with a fresh approval for the action.
// It returns who approved (nil when the user is a manager themselves).
func (c *C) managerOr(action string) (*auth.User, error) {
	if auth.RoleRank[c.U.Role] >= auth.RoleRank["manager"] {
		return nil, nil
	}
	by, err := c.hasApproval(action)
	if err != nil {
		return nil, err
	}
	if by == nil {
		return nil, failX(403, "A manager needs to approve this", M{"needsApproval": action})
	}
	return by, nil
}

// approvedBy is " (approved by X)" or "".
func approvedNote(by *auth.User, format string) string {
	if by == nil {
		return ""
	}
	return fmt.Sprintf(format, by.Name)
}

var pushSubSchema = valid.Object(map[string]valid.Schema{
	"endpoint": valid.String().URL().Max(800).Refine(func(u string) bool { return strings.HasPrefix(u, "https://") }, "Must be https"),
	"keys":     valid.Object(map[string]valid.Schema{"p256dh": valid.String().Min(20).Max(200), "auth": valid.String().Min(8).Max(100)}),
})

func dollars(cents int64) string { return fmt.Sprintf("%.2f", float64(cents)/100) }

func (a *App) registerGuard(rt *router) {
	rt.pub("POST /api/auth/2fa", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{"ticket": valid.String().Max(600), "code": valid.String().Max(20)}))
		if err != nil {
			return err
		}
		cl, ok := a.verifyJWT(str(b["ticket"]))
		if !ok {
			return fail(401, "That took too long. Enter your PIN again.")
		}
		if cl["typ"] != "2fa-ticket" || locClaim(cl) != c.Slug() {
			return fail(401, "Enter your PIN again.")
		}
		u, err := c.One(`SELECT * FROM users WHERE id = ? AND active = 1`, i64(cl["uid"]))
		if err != nil {
			return err
		}
		if u == nil {
			return fail(401, "Enter your PIN again.")
		}
		if ok, err := c.authGate(u, str(b["code"])); !ok || err != nil {
			return err
		}
		a.lockout.Clear(c.IP())
		if _, err := c.Run(`UPDATE users SET last_login_at = ? WHERE id = ?`, store.Now(), u["id"]); err != nil {
			return err
		}
		if err := a.sess.Issue(c.W, c.Slug(), i64(u["id"]), i64(u["session_version"])); err != nil {
			return err
		}
		user := &auth.User{ID: i64(u["id"]), Name: str(u["name"]), Role: str(u["role"])}
		if err := c.AuditAs(user, "auth.login", "with two-step code", c.IP()); err != nil {
			return err
		}
		return c.JSON(M{"user": user})
	}, a.authLim())

	rt.staff("GET /security/me", "staff", func(c *C) error {
		u, err := c.Get(`SELECT totp_enabled FROM users WHERE id = ?`, c.U.ID)
		if err != nil {
			return err
		}
		left, _ := c.N(`SELECT COUNT(*) c FROM recovery_codes WHERE user_id = ? AND used_at IS NULL`, c.U.ID)
		alerts, _ := c.N(`SELECT COUNT(*) c FROM push_subs WHERE user_id = ?`, c.U.ID)
		return c.JSON(M{"twoStep": truthy(u["totp_enabled"]), "recoveryLeft": left, "phoneAlerts": alerts})
	})
	rt.staff("POST /security/2fa/setup", "manager", func(c *C) error {
		u, err := c.Get(`SELECT * FROM users WHERE id = ?`, c.U.ID)
		if err != nil {
			return err
		}
		if truthy(u["totp_enabled"]) {
			return conflict("Two-step sign-in is already on")
		}
		raw := make([]byte, 20)
		_, _ = rand.Read(raw)
		secret := b32.EncodeToString(raw)
		if _, err := c.Run(`UPDATE users SET totp_secret = ? WHERE id = ?`, a.seal(secret), u["id"]); err != nil {
			return err
		}
		label := url.PathEscape(c.S()["business_name"] + ":" + str(u["name"]))
		uri := "otpauth://totp/" + label + "?secret=" + secret + "&issuer=BuzzHub&algorithm=SHA1&digits=6&period=30"
		svg, err := qrSVG(uri, 1, "", "", false)
		if err != nil {
			return err
		}
		groups := []string{}
		for i := 0; i < len(secret); i += 4 {
			groups = append(groups, secret[i:min(i+4, len(secret))])
		}
		return c.JSON(M{"secret": strings.Join(groups, " "), "svg": svg})
	})
	rt.staff("POST /security/2fa/enable", "manager", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{"code": valid.String().RegexMsg(`^\d{6}$`, "Enter the 6-digit code")}))
		if err != nil {
			return err
		}
		u, err := c.Get(`SELECT * FROM users WHERE id = ?`, c.U.ID)
		if err != nil {
			return err
		}
		if u["totp_secret"] == nil || truthy(u["totp_enabled"]) {
			return conflict("Start setup first")
		}
		sec, err := a.open(str(u["totp_secret"]))
		if err != nil {
			return conflict("Start setup first")
		}
		step := checkTotp(sec, str(b["code"]), 0)
		if step == 0 {
			return bad("That code didn't match. Make sure your phone's clock is right.")
		}
		codes := make([]string, 8)
		for i := range codes {
			raw := make([]byte, 8)
			_, _ = rand.Read(raw)
			s := regexp.MustCompile(`[^a-z0-9]`).ReplaceAllString(strings.ToLower(base64.RawURLEncoding.EncodeToString(raw)), "")
			if len(s) > 10 {
				s = s[:10]
			}
			for len(s) < 10 {
				s += "7"
			}
			codes[i] = s
		}
		if _, err := c.Run(`UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?`, step, u["id"]); err != nil {
			return err
		}
		if _, err := c.Run(`DELETE FROM recovery_codes WHERE user_id = ?`, u["id"]); err != nil {
			return err
		}
		for _, code := range codes {
			h, _ := bcrypt.GenerateFromPassword([]byte(code), 10)
			if _, err := c.Run(`INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)`, u["id"], string(h)); err != nil {
				return err
			}
		}
		c.grantTrust(c.U.ID)
		if err := c.Audit("auth.2fa_on", ""); err != nil {
			return err
		}
		return c.JSON(M{"ok": true, "recoveryCodes": codes})
	})
	rt.staff("POST /security/2fa/disable", "manager", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{"code": valid.String().Max(20)}))
		if err != nil {
			return err
		}
		u, err := c.Get(`SELECT * FROM users WHERE id = ?`, c.U.ID)
		if err != nil {
			return err
		}
		if !truthy(u["totp_enabled"]) {
			return conflict("Two-step sign-in is off")
		}
		how, err := c.verifySecondFactor(u, str(b["code"]))
		if err != nil {
			return err
		}
		if how == "" {
			return bad("That code is not right")
		}
		if _, err := c.Run(`UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?`, u["id"]); err != nil {
			return err
		}
		if _, err := c.Run(`DELETE FROM recovery_codes WHERE user_id = ?`, u["id"]); err != nil {
			return err
		}
		if err := c.Audit("auth.2fa_off", ""); err != nil {
			return err
		}
		c.alertOwners(c.S()["business_name"]+": two-step turned off", str(u["name"])+" turned off two-step sign-in.", "")
		return c.OK()
	})
	rt.staff("POST /users/{id}/reset-2fa", "owner", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE users SET totp_enabled = 0, totp_secret = NULL, session_version = session_version + 1 WHERE id = ?`, id); err != nil {
			return err
		}
		if _, err := c.Run(`DELETE FROM recovery_codes WHERE user_id = ?`, id); err != nil {
			return err
		}
		if err := c.Audit("user.reset_2fa", fmt.Sprintf("#%d", id)); err != nil {
			return err
		}
		c.Emit("user:"+itoa(id), "force-lock", nil)
		return c.OK()
	})

	rt.staff("GET /security/devices", "manager", func(c *C) error {
		rows, err := c.All(`SELECT d.id, d.name, d.ip, d.status, d.code, d.created_at, d.last_seen, CASE WHEN d.device_id = ? THEN 1 ELSE 0 END AS this_device, u.name approved_by_name FROM devices d LEFT JOIN users u ON u.id = d.approved_by ORDER BY (d.status = 'pending') DESC, d.last_seen DESC NULLS LAST LIMIT 100`, cookie(c.R, deviceCookie))
		if err != nil {
			return err
		}
		return c.JSON(M{"requireApproved": c.S()["require_approved_devices"] == "1", "devices": rows})
	})
	rt.staff("POST /security/devices/{id}", "owner", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{"status": valid.Enum("approved", "blocked", "pending").Optional(), "name": valid.String().Trim().Min(1).Max(40).Optional()}))
		if err != nil {
			return err
		}
		id, err := c.ID()
		if err != nil {
			return err
		}
		d, err := c.One(`SELECT * FROM devices WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if d == nil {
			return notFound("Not found")
		}
		if _, err := c.Run(`UPDATE devices SET status = COALESCE(?, status), name = COALESCE(?, name), approved_by = CASE WHEN ? = 'approved' THEN ? ELSE approved_by END WHERE id = ?`, orNil(b["status"]), orNil(b["name"]), str(b["status"]), c.U.ID, d["id"]); err != nil {
			return err
		}
		act, name := str(b["status"]), str(b["name"])
		if act == "" {
			act = "rename"
		}
		if name == "" {
			name = str(d["name"])
		}
		if err := c.Audit("device."+act, name); err != nil {
			return err
		}
		c.Notify("devices")
		return c.OK()
	})
	rt.staff("POST /security/require-devices", "owner", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{"on": valid.Bool()}))
		if err != nil {
			return err
		}
		on := b["on"].(bool)
		if on {
			ua := c.R.UserAgent()
			if _, err := c.Run(`INSERT INTO devices (device_id, name, user_agent, ip, status, approved_by) VALUES (?, ?, ?, ?, 'approved', ?) ON CONFLICT(device_id) DO UPDATE SET status='approved', approved_by=excluded.approved_by`,
				c.deviceID(), deviceLabel(ua), trunc(ua, 200), c.IP(), c.U.ID); err != nil {
				return err
			}
		}
		v, detail := "0", "any device"
		if on {
			v, detail = "1", "approved devices only"
		}
		if err := c.Tx.SetSettings(c.Ctx, map[string]string{"require_approved_devices": v}); err != nil {
			return err
		}
		if err := c.Audit("settings.devices", detail); err != nil {
			return err
		}
		c.Notify("devices")
		return c.OK()
	})

	approvalKeys := []string{}
	for k := range approvalActions {
		approvalKeys = append(approvalKeys, k)
	}
	rt.staff("POST /approve", "staff", func(c *C) error {
		ip := c.IP()
		if wait := a.lockout.Blocked(ip); wait > 0 {
			return fail(429, fmt.Sprintf("Locked for %ds", wait))
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{"pin": valid.String().Regex(`^\d{4,8}$`), "action": valid.Enum("void", "discount", "refund", "cash_close", "nosale"), "ref": valid.String().Max(40).Optional()}))
		if err != nil {
			return err
		}
		action := str(b["action"])
		approver, _, err := auth.FindUserByPin(c.Ctx, c.Tx, str(b["pin"]))
		if err != nil {
			return err
		}
		if approver == nil {
			a.lockout.Fail(ip)
			c.onBadPin(ip)
			if err := c.Audit("approve.fail", approvalActions[action]); err != nil {
				return err
			}
			return &committedError{HTTPError{Status: 401, Msg: "Wrong PIN"}}
		}
		if auth.RoleRank[approver.Role] < auth.RoleRank["manager"] {
			return forbidden(approver.Name + " can't approve this. A manager or owner has to.")
		}
		a.lockout.Clear(ip)
		tok := a.signJWT(jwt.MapClaims{"typ": "approval", "loc": c.Slug(), "act": action, "by": approver.ID, "for": c.U.ID, "ref": orNil(b["ref"])}, 2*time.Minute)
		if err := c.Audit("approve.ok", approvalActions[action]+" approved by "+approver.Name); err != nil {
			return err
		}
		return c.JSON(M{"token": tok, "by": approver.Name})
	}, a.authLim())

	rt.staff("POST /orders/{id}/refund", "staff", func(c *C) error {
		by, err := c.managerOr("refund")
		if err != nil {
			return err
		}
		id, err := c.ID()
		if err != nil {
			return err
		}
		o, err := c.One(`SELECT * FROM orders WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if o == nil || o["paid_at"] == nil || str(o["status"]) == "void" {
			return conflict("Only paid orders can be refunded")
		}
		done, err := c.N(`SELECT COALESCE(SUM(amount_cents),0) c FROM refunds WHERE order_id = ?`, o["id"])
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{"amountCents": valid.Int().Min(1), "reason": valid.String().Trim().Min(1).Max(120)}))
		if err != nil {
			return err
		}
		amt := i64(b["amountCents"])
		if amt > i64(o["total_cents"])-done {
			return bad("You can refund at most " + dollars(i64(o["total_cents"])-done))
		}
		approver := c.U.ID
		if by != nil {
			approver = by.ID
		}
		if _, err := c.Run(`INSERT INTO refunds (order_id, amount_cents, reason, method, user_id, approved_by) VALUES (?, ?, ?, ?, ?, ?)`, o["id"], amt, b["reason"], o["payment_method"], c.U.ID, approver); err != nil {
			return err
		}
		if err := c.Audit("order.refund", fmt.Sprintf("#%v %s: %s%s", o["number"], dollars(amt), str(b["reason"]), approvedNote(by, " (approved by %s)"))); err != nil {
			return err
		}
		if amt >= 5000 {
			c.alertOwners(c.S()["business_name"]+": refund", fmt.Sprintf("%s refunded $%s on order #%v: %s", c.U.Name, dollars(amt), o["number"], str(b["reason"])), "refund")
		}
		c.Notify("orders")
		return c.OK()
	})

	rt.staff("POST /security/push", "manager", func(c *C) error {
		sub, err := c.Body(pushSubSchema)
		if err != nil {
			return err
		}
		keys := sub["keys"].(valid.M)
		if _, err := c.Run(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
			ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`, c.U.ID, sub["endpoint"], keys["p256dh"], keys["auth"]); err != nil {
			return err
		}
		if err := c.Audit("security.alerts_on", ""); err != nil {
			return err
		}
		return c.OK()
	})
	rt.staff("POST /security/push/test", "manager", func(c *C) error {
		return c.JSON(a.pushToUsers(c.Ctx, c.Tx, []string{c.U.Role}, M{"title": "BuzzHub security alerts", "body": "You'll get alerts like this on this phone.", "tag": "test", "url": "/security"}, c.U.ID))
	})
	a.G["alertOwners"] = func(c *C, args ...any) (any, error) {
		tag := ""
		if len(args) > 2 {
			tag = str(args[2])
		}
		c.alertOwners(str(args[0]), str(args[1]), tag)
		return nil, nil
	}
	_ = approvalKeys
}
