package server

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
)

// The waitlist and pager core, ported from index.js.

var guestTokenRE = regexp.MustCompile(`^[A-Za-z0-9_-]{20,40}$`)

func newToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
func newGuestToken() string { return newToken(18) }

/* ---------- which location owns a token ---------- */

var tokenSlugs sync.Map // "table:token" -> slug

func (a *App) allSlugs(ctx context.Context) []string {
	out := []string{"main"}
	rows, err := a.db.Pool.Query(ctx, `SELECT slug FROM public.locations ORDER BY id`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var s string
		if rows.Scan(&s) == nil && s != "main" {
			out = append(out, s)
		}
	}
	return out
}

// slugForToken finds which location holds a token (guest pages, bills, receipts ...).
func (a *App) slugForToken(ctx context.Context, table, column, token string) string {
	if !tokenPathTok.MatchString(token) {
		return ""
	}
	key := table + ":" + token
	if v, ok := tokenSlugs.Load(key); ok {
		return v.(string)
	}
	for _, slug := range a.allSlugs(ctx) {
		var one int
		q := fmt.Sprintf(`SELECT 1 FROM %q.%q WHERE %q = $1 LIMIT 1`, store.SchemaFor(slug), table, column)
		if err := a.db.Pool.QueryRow(ctx, q, token).Scan(&one); err == nil {
			tokenSlugs.Store(key, slug)
			return slug
		}
	}
	return ""
}

var tokenPathTok = regexp.MustCompile(`^[A-Za-z0-9_-]{16,40}$`)

func (a *App) slugForTokenPath(ctx context.Context, kind, tok string) string {
	switch kind {
	case "p":
		return a.slugForToken(ctx, "bills", "token", tok)
	case "t":
		return a.slugForToken(ctx, "tables", "qr_token", tok)
	case "r":
		return a.slugForToken(ctx, "orders", "receipt_token", tok)
	case "i":
		return a.slugForToken(ctx, "invoices", "token", tok)
	case "e":
		return a.slugForToken(ctx, "tickets", "code", tok)
	case "v":
		return a.slugForToken(ctx, "room_bookings", "token", tok)
	case "w":
		if s := a.slugForToken(ctx, "customers", "card_token", tok); s != "" {
			return s
		}
		return a.slugForToken(ctx, "gift_cards", "wallet_token", tok)
	case "g":
		return a.slugForToken(ctx, "guests", "token", tok)
	}
	return a.slugForToken(ctx, "feedback", "token", tok)
}

func (a *App) guestByToken(ctx context.Context, tx *store.Tx, token string) (store.Row, error) {
	if !guestTokenRE.MatchString(token) {
		return nil, nil
	}
	r, err := tx.Get(ctx, `SELECT * FROM guests WHERE token = ?`, token)
	if store.IsNoRows(err) {
		return nil, nil
	}
	return r, err
}

/* ---------- queue + estimates ---------- */

func queueFor(ctx context.Context, tx *store.Tx, kind string) ([]int64, error) {
	rows, err := tx.All(ctx, `SELECT id FROM guests WHERE kind = ? AND status IN ('waiting','buzzed','acknowledged') ORDER BY created_at, id`, kind)
	if err != nil {
		return nil, err
	}
	ids := make([]int64, len(rows))
	for i, r := range rows {
		ids[i] = store.Int(r["id"])
	}
	return ids, nil
}

func indexOf(ids []int64, id int64) int {
	for i, x := range ids {
		if x == id {
			return i
		}
	}
	return -1
}

// Smart wait times: minutes per place in line, learned from the last 60 days.
type waitModel struct {
	at      time.Time
	buckets map[string]float64
	overall *float64
	samples int
}

var (
	waitModels   = map[string]*waitModel{}
	waitModelsMu sync.Mutex
)

func sizeBucket(n int64) string {
	switch {
	case n <= 2:
		return "s"
	case n <= 4:
		return "m"
	case n <= 6:
		return "l"
	}
	return "xl"
}
func partBucket(h int) string {
	if h >= 11 && h < 15 {
		return "lunch"
	}
	if h >= 17 && h < 22 {
		return "dinner"
	}
	return "other"
}
func median(a []float64) float64 {
	s := append([]float64(nil), a...)
	sort.Float64s(s)
	m := len(s) / 2
	if len(s)%2 == 1 {
		return s[m]
	}
	return (s[m-1] + s[m]) / 2
}

func loadTZ(name string) *time.Location {
	if l, err := time.LoadLocation(name); err == nil {
		return l
	}
	return time.UTC
}

func parseTS(ts string) time.Time {
	t, _ := time.Parse("2006-01-02 15:04:05", ts)
	return t
}

func (c *C) waitModel() *waitModel {
	waitModelsMu.Lock()
	m := waitModels[c.Slug()]
	waitModelsMu.Unlock()
	if m != nil && time.Since(m.at) < 10*time.Minute {
		return m
	}
	tz := loadTZ(c.S()["timezone"])
	rows, err := c.All(`SELECT party_size, created_at, ahead_at_join, (julianday(seated_at) - julianday(created_at)) * 1440 wait
		FROM guests WHERE kind = 'table' AND seated_at IS NOT NULL AND ahead_at_join IS NOT NULL AND created_at > datetime('now','-60 days')`)
	nm := &waitModel{at: time.Now(), buckets: map[string]float64{}}
	if err == nil {
		b := map[string][]float64{}
		var all []float64
		for _, r := range rows {
			w := f64(r["wait"])
			if w < 0 || w > 240 {
				continue
			}
			per := w / float64(i64(r["ahead_at_join"])+1)
			all = append(all, per)
			h := parseTS(str(r["created_at"])).In(tz).Hour()
			sb, pb := sizeBucket(i64(r["party_size"])), partBucket(h)
			for _, k := range []string{sb + ":" + pb, sb + ":*", "*:" + pb} {
				b[k] = append(b[k], per)
			}
		}
		for k, v := range b {
			if len(v) >= 8 {
				nm.buckets[k] = median(v)
			}
		}
		if len(all) >= 8 {
			o := median(all)
			nm.overall = &o
		}
		nm.samples = len(all)
	}
	waitModelsMu.Lock()
	waitModels[c.Slug()] = nm
	waitModelsMu.Unlock()
	return nm
}

// estimate is smartEstimate: minutes for someone at pos (1 = next).
func (c *C) estimate(pos int, partySize int64) int64 {
	if pos <= 0 {
		return 0
	}
	s := c.S()
	fallback := f64(s["avg_turn_minutes"])
	if fallback == 0 {
		fallback = 10
	}
	if s["smart_waits"] != "1" {
		return int64(math.Max(1, float64(pos)*fallback))
	}
	m := c.waitModel()
	if partySize == 0 {
		partySize = 2
	}
	h := time.Now().In(loadTZ(s["timezone"])).Hour()
	sb, pb := sizeBucket(partySize), partBucket(h)
	per := fallback
	if v, ok := m.buckets[sb+":"+pb]; ok {
		per = v
	} else if v, ok := m.buckets[sb+":*"]; ok {
		per = v
	} else if v, ok := m.buckets["*:"+pb]; ok {
		per = v
	} else if m.overall != nil {
		per = *m.overall
	}
	return int64(math.Max(1, math.Round(float64(pos)*per)))
}

func (c *C) waitModelInfo() M {
	m := c.waitModel()
	var per any
	if m.overall != nil {
		per = math.Round(*m.overall*10) / 10
	}
	return M{"samples": m.samples, "learned": m.overall != nil, "perPlace": per}
}

/* ---------- what a guest's phone sees ---------- */

func (c *C) preorderWindow(g store.Row, pos int) M {
	s := c.S()
	if s["preorder_enabled"] != "1" || str(g["kind"]) != "table" {
		return M{"enabled": false, "open": false}
	}
	st := str(g["status"])
	if st != "waiting" && st != "buzzed" && st != "acknowledged" {
		return M{"enabled": true, "open": false, "closed": true}
	}
	est := c.estimate(pos, i64(g["party_size"]))
	openMin := int64(f64(s["preorder_open_minutes"]))
	open := i64(g["preorder_open"]) == 1 || st != "waiting" || est <= openMin
	opens := int64(0)
	if !open {
		opens = est - openMin
		if opens < 1 {
			opens = 1
		}
	}
	return M{"enabled": true, "open": open, "opensInMinutes": opens}
}

func (c *C) preorderFor(guestID int64) (any, error) {
	o, err := c.One(`SELECT * FROM orders WHERE guest_id = ? AND source = 'guest' AND status <> 'void' ORDER BY id DESC LIMIT 1`, guestID)
	if err != nil || o == nil {
		return nil, err
	}
	items, err := c.All(`SELECT name, qty, price_cents, note FROM order_items WHERE order_id = ?`, o["id"])
	if err != nil {
		return nil, err
	}
	return M{"number": o["number"], "status": o["status"], "items": items, "subtotalCents": o["subtotal_cents"], "taxCents": o["tax_cents"], "totalCents": o["total_cents"]}, nil
}

func (c *C) guestPublicView(g store.Row) (M, error) {
	s := c.S()
	id := i64(g["id"])
	queue, err := queueFor(c.Ctx, c.Tx, str(g["kind"]))
	if err != nil {
		return nil, err
	}
	pos := indexOf(queue, id) + 1
	var tableLabel, orderNumber, orderStatus any
	if g["table_id"] != nil {
		tableLabel, _ = c.Val(`SELECT label FROM tables WHERE id = ?`, g["table_id"])
	}
	if g["order_id"] != nil {
		if o, _ := c.One(`SELECT number, status FROM orders WHERE id = ?`, g["order_id"]); o != nil {
			orderNumber, orderStatus = orNil(o["number"]), orNil(o["status"])
		}
	}
	devs, _ := c.a.devicesForGuest(c.Ctx, c.Tx, id)
	pre := c.preorderWindow(g, pos)
	if pre["order"], err = c.preorderFor(id); err != nil {
		return nil, err
	}
	var position any
	if pos > 0 {
		position = pos
	}
	slug := c.Slug()
	var logo any
	if s["logo_version"] != "0" {
		logo = "/api/public/logo?l=" + slug + "&v=" + s["logo_version"]
	}
	view := M{
		"kind": g["kind"], "name": firstName(str(g["name"])), "partySize": g["party_size"], "status": g["status"],
		"position": position, "estMinutes": c.estimate(pos, i64(g["party_size"])), "lastMessage": g["last_message"],
		"buzzCount": g["buzz_count"], "headsUp": truthy(g["heads_up_at"]), "tableLabel": orNil(tableLabel),
		"orderNumber": orderNumber, "orderStatus": orderStatus, "joinedAt": g["created_at"],
		"hasEmail": truthy(g["email"]), "emailAlerts": truthy(g["email"]) && truthy(g["notify_email"]) && emailEnabled(),
		"emailAvailable": emailEnabled(), "customer": truthy(g["customer_id"]), "pushDevices": len(devs),
		"preorder": pre, "delivery": nil, "curbside": nil, "shelf": nil, "dropPhoto": false,
		"chat":     s["chat_enabled"] == "1",
		"business": M{"slug": slug, "name": s["business_name"], "accent": s["accent"], "unitLabel": s["unit_label"], "type": s["business_type"], "welcome": s["welcome_message"], "booking": s["booking_enabled"] == "1", "logo": logo},
	}
	for k, hook := range map[string]any{"delivery": "deliveryView", "curbside": "curbsideView", "shelf": "shelfView"} {
		if c.Has(hook.(string)) {
			arg := any(g)
			if k == "delivery" {
				arg = g["order_id"]
			}
			if view[k], err = c.G(hook.(string), arg); err != nil {
				return nil, err
			}
		}
	}
	if g["order_id"] != nil && c.Has("dropPhotoFor") {
		if view["dropPhoto"], err = c.G("dropPhotoFor", g["order_id"]); err != nil {
			return nil, err
		}
	}
	return view, nil
}

// pushGuest sends a guest's phone its fresh view.
func (a *App) pushGuest(ctx context.Context, tx *store.Tx, guestID int64) error {
	c := &C{a: a, Tx: tx, Ctx: ctx}
	return c.pushGuest(guestID)
}
func (c *C) pushGuest(guestID int64) error {
	g, err := c.One(`SELECT * FROM guests WHERE id = ?`, guestID)
	if err != nil || g == nil {
		return err
	}
	v, err := c.guestPublicView(g)
	if err != nil {
		return err
	}
	c.Emit("guest:"+itoa(guestID), "guest:update", v)
	return nil
}

func (c *C) linkFor(g store.Row) string {
	return strings.TrimRight(c.a.cfg.PublicURL, "/") + "/b/" + str(g["token"])
}

type alertResult struct {
	Push  pushResult `json:"push"`
	Email any        `json:"email"`
}

// alertGuest sends an alert on every channel the guest turned on: live page, phone, email.
func (c *C) alertGuest(g store.Row, title, body, tag, kind string) alertResult {
	s := c.S()
	ev := "headsup"
	if kind == "buzz" {
		ev = "buzz"
	}
	c.Emit("guest:"+itoa(i64(g["id"])), ev, M{"message": body, "at": nowMs()})
	res := alertResult{Push: c.a.pushToGuest(c.Ctx, c.Tx, i64(g["id"]), M{"title": title, "body": body, "tag": tag, "url": "/b/" + str(g["token"]), "kind": kind})}
	if truthy(g["email"]) && truthy(g["notify_email"]) && emailEnabled() {
		ok, err := emailGuest(str(g["email"]), emailMsg{BusinessName: s["business_name"], Subject: title, Message: body, Link: c.linkFor(g), Accent: s["accent"]})
		if err != nil {
			c.a.log.Error("email failed", "err", err)
		}
		res.Email = M{"ok": ok && err == nil}
	}
	return res
}

// sendHeadsUp is the automatic "almost ready" alert.
func (c *C) sendHeadsUp(g store.Row, manual bool) (alertResult, error) {
	s := c.S()
	if _, err := c.Run(`UPDATE guests SET heads_up_at = ?, preorder_open = 1 WHERE id = ?`, store.Now(), g["id"]); err != nil {
		return alertResult{}, err
	}
	n, _ := c.N(`SELECT COUNT(*) c FROM menu_items WHERE active=1 AND guest_orderable=1`)
	unit := strings.ToLower(s["unit_label"])
	body := "Your " + unit + " is almost ready. Please stay nearby."
	if s["preorder_enabled"] == "1" && n > 0 {
		body = "Your " + unit + " is almost ready. Order drinks now and they'll be waiting when you sit down."
	}
	r := c.alertGuest(g, s["business_name"]+": almost your turn", body, "headsup", "headsup")
	extra := ""
	if manual {
		extra = " — sent by staff"
	}
	if err := c.AuditAs(nil, "guest.headsup", fmt.Sprintf("%s (#%d)%s", str(g["name"]), i64(g["id"]), extra), ""); err != nil {
		return r, err
	}
	return r, c.pushGuest(i64(g["id"]))
}

func (c *C) checkHeadsUps() error {
	s := c.S()
	limit := int64(f64(s["heads_up_minutes"]))
	if limit == 0 {
		return nil
	}
	queue, err := queueFor(c.Ctx, c.Tx, "table")
	if err != nil {
		return err
	}
	for i, id := range queue {
		g, err := c.One(`SELECT * FROM guests WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if g == nil || c.estimate(i+1, i64(g["party_size"])) > limit {
			continue
		}
		if str(g["status"]) == "waiting" && !truthy(g["heads_up_at"]) {
			if _, err := c.sendHeadsUp(g, false); err != nil {
				return err
			}
		}
	}
	return nil
}

// pushAllWaiting refreshes every waiting guest's phone (their place in line moved).
func (c *C) pushAllWaiting() error {
	rows, err := c.All(`SELECT id FROM guests WHERE status IN ('waiting','buzzed','acknowledged')`)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if err := c.pushGuest(i64(r["id"])); err != nil {
			return err
		}
	}
	return c.checkHeadsUps()
}

type newGuest struct {
	Kind, Name, Phone, Email, Notes, Source string
	NotifyEmail                             bool
	PartySize                               int64
	OrderID, CustomerID, BookingID          any
}

func (c *C) createGuest(n newGuest) (store.Row, error) {
	if n.Kind == "" {
		n.Kind = "table"
	}
	if n.Source == "" {
		n.Source = "staff"
	}
	if n.PartySize == 0 {
		n.PartySize = 1
	}
	queue, err := queueFor(c.Ctx, c.Tx, n.Kind)
	if err != nil {
		return nil, err
	}
	notify := 0
	if n.Email != "" && n.NotifyEmail {
		notify = 1
	}
	res, err := c.Run(`INSERT INTO guests (kind, name, phone, email, notify_email, party_size, notes, token, source, order_id, customer_id, booking_id, ahead_at_join) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		n.Kind, n.Name, orNil(n.Phone), orNil(n.Email), notify, n.PartySize, orNil(n.Notes), newGuestToken(), n.Source, n.OrderID, n.CustomerID, n.BookingID, len(queue))
	if err != nil {
		return nil, err
	}
	return c.Get(`SELECT * FROM guests WHERE id = ?`, res.LastID)
}

// fireHeldPreorder sends a guest's held pre-order to the kitchen/bar and attaches their table.
func (c *C) fireHeldPreorder(guestID int64, tableID any) (any, error) {
	o, err := c.One(`SELECT * FROM orders WHERE guest_id = ? AND source = 'guest' AND status = 'held' ORDER BY id DESC LIMIT 1`, guestID)
	if err != nil || o == nil {
		return nil, err
	}
	if _, err := c.Run(`UPDATE orders SET status = 'sent', sent_at = ?, table_id = COALESCE(?, table_id) WHERE id = ?`, store.Now(), orNil(tableID), o["id"]); err != nil {
		return nil, err
	}
	var label any
	if truthy(tableID) {
		label, _ = c.Val(`SELECT label FROM tables WHERE id=?`, tableID)
	}
	c.Emit("staff", "preorder:fired", M{"number": o["number"], "table": label})
	c.Notify("orders")
	return o["number"], nil
}

func (c *C) voidHeldPreorder(guestID int64) error {
	r, err := c.Run(`UPDATE orders SET status = 'void' WHERE guest_id = ? AND source = 'guest' AND status = 'held'`, guestID)
	if err == nil && r.Changes > 0 {
		c.Notify("orders")
	}
	return err
}

// buzzGuest pages a guest: their table or order is ready.
func (c *C) buzzGuest(g store.Row, message string, by *auth.User, ip string) (M, error) {
	s := c.S()
	var table, orderNum any
	if g["table_id"] != nil {
		table, _ = c.Val(`SELECT label FROM tables WHERE id = ?`, g["table_id"])
	}
	if g["order_id"] != nil {
		orderNum, _ = c.Val(`SELECT number FROM orders WHERE id = ?`, g["order_id"])
	}
	unit := strings.ToLower(s["unit_label"])
	msg := strings.TrimSpace(message)
	if msg == "" {
		if str(g["kind"]) == "order" {
			msg = "Order #" + str(orderNum) + " is ready for pickup!"
		} else {
			t := ""
			if table != nil {
				t = " (" + str(table) + ")"
			}
			msg = "Your " + unit + t + " is ready. Please come to the host stand."
		}
	}
	id := i64(g["id"])
	if _, err := c.Run(`UPDATE guests SET status = 'buzzed', buzz_count = buzz_count + 1, buzzed_at = ?, last_message = ? WHERE id = ?`, store.Now(), msg, id); err != nil {
		return nil, err
	}
	var fired any
	if str(g["kind"]) == "table" && g["table_id"] != nil {
		var err error
		if fired, err = c.fireHeldPreorder(id, g["table_id"]); err != nil {
			return nil, err
		}
	}
	title := s["business_name"] + ": your " + unit + " is ready"
	if str(g["kind"]) == "order" {
		title = s["business_name"] + ": order ready"
	}
	sent := c.alertGuest(g, title, msg, "buzz", "buzz")
	if err := c.pushGuest(id); err != nil {
		return nil, err
	}
	detail := fmt.Sprintf("%s (#%d) — %s", str(g["name"]), id, msg)
	if sent.Push.Sent > 0 {
		detail += fmt.Sprintf(" [phone alert to %d device(s)]", sent.Push.Sent)
	}
	if fired != nil {
		detail += fmt.Sprintf(" [pre-order #%v sent]", fired)
	}
	if err := c.AuditAs(by, "guest.buzz", detail, ip); err != nil {
		return nil, err
	}
	c.Notify("guests")
	return M{"message": msg, "push": sent.Push, "email": sent.Email, "preorderFired": fired}, nil
}
