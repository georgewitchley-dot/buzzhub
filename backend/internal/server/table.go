package server

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// Port of table.js: split a tab (tab members), my tables on the pad, table timeline, prep log feeding
// Use first, delivery route order, running late for bookings, server coaching, expo photo check.

func init() { modules = append(modules, (*App).registerTable) }

/* ---------- small helpers shared by table.go, seat.go, serve.go, flow.go ---------- */

// tableTZ is the location's time zone name (the Node default when unset).
func (c *C) tableTZ() string {
	if tz := c.S()["timezone"]; tz != "" {
		return tz
	}
	return "America/New_York"
}

// tableToday is localToday().
func (c *C) tableToday() string { return time.Now().In(loadTZ(c.tableTZ())).Format("2006-01-02") }

// tableDayBounds is ops.js dayBounds(date): the UTC start/end of a local calendar day.
func tableDayBounds(date, tz string) (string, string) {
	mid, err := time.Parse("2006-01-02T15:04:05", date+"T12:00:00")
	if err != nil {
		mid = time.Now().UTC()
	}
	_, off := mid.In(loadTZ(tz)).Zone()
	start := mid.Add(-12*time.Hour - time.Duration(off)*time.Second)
	end := start.Add(24 * time.Hour)
	return start.Format("2006-01-02 15:04:05"), end.Format("2006-01-02 15:04:05")
}

// tableMs is Date.parse of a SQLite timestamp, in ms.
func tableMs(v any) float64 {
	s := strings.Replace(str(v), " ", "T", 1)
	for _, f := range []string{"2006-01-02T15:04:05", "2006-01-02T15:04:05.000", "2006-01-02T15:04", "2006-01-02"} {
		if t, err := time.Parse(f, s); err == nil {
			return float64(t.UnixMilli())
		}
	}
	return math.NaN()
}

// tableMinutesSince is Math.round((Date.now() - ms(ts)) / 60000), or nil for no timestamp.
func tableMinutesSince(ts any) any {
	if !truthy(ts) {
		return nil
	}
	return roundJS((float64(nowMs()) - tableMs(ts)) / 60000)
}

// tableNumParam is Number(req.params.x) used as a lookup key (NaN finds nothing).
func tableNumParam(s string) any {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if strings.TrimSpace(s) == "" {
		return int64(0)
	}
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return int64(-1 << 62)
	}
	return tableNumAny(f)
}

// tableNumAny keeps integral floats as int64 (JSON numbers and SQL params).
func tableNumAny(f float64) any {
	if f == math.Trunc(f) && math.Abs(f) < 1<<53 {
		return int64(f)
	}
	return f
}

// tableJSNumber is Number(x) for a setting or query value (NaN when not a number; "" is 0).
func tableJSNumber(s string) float64 {
	t := strings.TrimSpace(s)
	if t == "" {
		return 0
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

// tableSlice is String.prototype.slice(0, n).
func tableSlice(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// tableB64 decodes base64 leniently, as Node's Buffer.from(x, 'base64') does.
func tableB64(s string) []byte {
	var b strings.Builder
	for _, ch := range s {
		if (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '+' || ch == '/' {
			b.WriteRune(ch)
		}
	}
	t := b.String()
	if len(t)%4 == 1 {
		t = t[:len(t)-1]
	}
	out, _ := base64.RawStdEncoding.DecodeString(t)
	return out
}

// tableDataPart is s.split(',')[1].
func tableDataPart(s string) string {
	p := strings.Split(s, ",")
	if len(p) < 2 {
		return ""
	}
	return p[1]
}

// tableEncURI is encodeURIComponent.
func tableEncURI(s string) string {
	const keep = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
	var b strings.Builder
	for _, by := range []byte(s) {
		if strings.IndexByte(keep, by) >= 0 {
			b.WriteByte(by)
		} else {
			fmt.Fprintf(&b, "%%%02X", by)
		}
	}
	return b.String()
}

// tableUser reads a *auth.User passed through a hook (nil otherwise).
func tableUser(v any) *auth.User {
	u, _ := v.(*auth.User)
	return u
}

// tableRow reads a row/object passed through a hook.
func tableRow(v any) M {
	switch x := v.(type) {
	case M:
		return x
	}
	return nil
}

// tableList reads a list of objects passed through a hook.
func tableList(v any) []M {
	switch x := v.(type) {
	case []M:
		return x
	case []any:
		out := make([]M, 0, len(x))
		for _, e := range x {
			if m, ok := e.(M); ok {
				out = append(out, m)
			}
		}
		return out
	}
	return nil
}

func tableUnit(c *C) string { return c.S()["unit_label"] }

/* ---------- KDS screen or signed-in staff (who) ---------- */

type tableWhoT struct {
	area string
	user *auth.User
}

func (c *C) tableWho() (tableWhoT, error) {
	if t := c.R.Header.Get("X-Kds"); t != "" {
		if p, ok := c.a.sess.VerifyDevice("kds", t); ok {
			ver := c.S()["kds_version"]
			if ver == "" {
				ver = "1"
			}
			if loc, _ := p["loc"].(string); loc == c.Slug() && str(p["v"]) == ver {
				return tableWhoT{area: str(p["area"])}, nil
			}
		}
		return tableWhoT{}, fail(401, "This kitchen screen is signed out.")
	}
	var user *auth.User
	if tok := cookie(c.R, auth.SessionCookie); tok != "" {
		if u, err := c.a.sess.UserFromToken(c.Ctx, c.Tx, tok); err == nil {
			user = u
		}
	}
	if user == nil {
		return tableWhoT{}, fail(401, "Sign in first")
	}
	area := c.Q("area")
	if area == "" {
		if m, ok := c.Raw().(map[string]any); ok && truthy(m["area"]) {
			area = str(m["area"])
		}
	}
	if area == "" {
		area = "All areas"
	}
	return tableWhoT{area: area, user: user}, nil
}

func tableLabel(w tableWhoT) string {
	if w.user != nil {
		return strings.Split(w.user.Name, " ")[0]
	}
	return w.area + " screen"
}

func tableDist(a, b, c, d float64) float64 {
	const R = 6371
	r := math.Pi / 180
	x := math.Pow(math.Sin((c-a)*r/2), 2) + math.Cos(a*r)*math.Cos(c*r)*math.Pow(math.Sin((d-b)*r/2), 2)
	return 2 * R * math.Asin(math.Sqrt(x))
}

/* ---------- hooks ---------- */

func (c *C) tableCode(tabID any) (string, error) {
	tab, err := c.Get(`SELECT * FROM tabs WHERE id = ?`, tabID)
	if err != nil {
		return "", err
	}
	if truthy(tab["code"]) {
		return str(tab["code"]), nil
	}
	const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"
	for {
		var b strings.Builder
		for i := 0; i < 4; i++ {
			n, _ := rand.Int(rand.Reader, big.NewInt(24))
			b.WriteByte(letters[n.Int64()])
		}
		code := b.String()
		hit, err := c.One(`SELECT 1 FROM tabs WHERE code = ? AND status <> 'closed'`, code)
		if err != nil {
			return "", err
		}
		if hit == nil {
			if _, err := c.Run(`UPDATE tabs SET code = ? WHERE id = ?`, code, tabID); err != nil {
				return "", err
			}
			return code, nil
		}
	}
}

func tableMemberFor(body any) any {
	m, ok := body.(map[string]any)
	if !ok {
		return nil
	}
	s, ok := m["member"].(string)
	if !ok {
		return nil
	}
	return orNil(tableSlice(strings.TrimSpace(s), 30))
}

func (c *C) tableTimeline() ([]M, error) {
	tables, err := c.All(`SELECT t.id, t.label, t.seated_at, g.party_size FROM tables t LEFT JOIN guests g ON g.id = t.guest_id WHERE t.status = 'seated'`)
	if err != nil {
		return nil, err
	}
	out := make([]M, 0, len(tables))
	for _, t := range tables {
		items, err := c.All(`SELECT oi.course, oi.fired_at, oi.done_at, o.served_at, o.status, o.created_at FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.table_id = ? AND o.status <> 'void' AND o.created_at >= COALESCE(?, datetime('now','-6 hours')) AND oi.price_cents >= 0`, t["id"], t["seated_at"])
		if err != nil {
			return nil, err
		}
		// [...new Set(courses)].sort(): JavaScript sorts these as strings
		keyOf := func(v any) string {
			if v == nil {
				return "null"
			}
			return str(v)
		}
		seen := map[string]bool{}
		keys := []string{}
		for _, i := range items {
			k := keyOf(i["course"])
			if !seen[k] {
				seen[k] = true
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		courses := make([]M, 0, len(keys))
		for _, k := range keys {
			var its []store.Row
			for _, i := range items {
				if keyOf(i["course"]) == k {
					its = append(its, i)
				}
			}
			all := func(f string) bool {
				for _, i := range its {
					if !truthy(i[f]) {
						return false
					}
				}
				return true
			}
			some := func(f string) bool {
				for _, i := range its {
					if truthy(i[f]) {
						return true
					}
				}
				return false
			}
			state := "held"
			if all("served_at") {
				state = "served"
			} else if all("done_at") {
				state = "ready"
			} else if some("fired_at") {
				state = "cooking"
			}
			courses = append(courses, M{"course": its[0]["course"], "state": state, "items": len(its)})
		}
		out = append(out, M{"id": t["id"], "label": t["label"], "party": t["party_size"], "minutes": tableMinutesSince(t["seated_at"]), "courses": courses, "ordered": len(items) > 0})
	}
	sort.SliceStable(out, func(a, b int) bool { return i64(out[b]["minutes"]) < i64(out[a]["minutes"]) })
	return out, nil
}

func (c *C) tableBookingLate(customerID, bookingID, minutes any) error {
	bk, err := c.One(`SELECT * FROM bookings WHERE id = ? AND customer_id = ? AND status = 'booked'`, bookingID, customerID)
	if err != nil {
		return err
	}
	if bk == nil {
		return notFound("Booking not found")
	}
	if _, err := c.Run(`UPDATE bookings SET late_minutes = ?, late_at = datetime('now') WHERE id = ?`, minutes, bk["id"]); err != nil {
		return err
	}
	cu, err := c.One(`SELECT name FROM customers WHERE id = ?`, customerID)
	if err != nil {
		return err
	}
	first, cname := "", "undefined"
	if cu != nil && cu["name"] != nil {
		cname = str(cu["name"])
		first = strings.Split(cname, " ")[0]
	}
	if first == "" {
		first = "A guest"
	}
	start := str(bk["start_local"])
	at := ""
	if len(start) > 11 {
		at = start[11:]
	}
	mins := str(minutes)
	c.a.pushToUsers(c.Ctx, c.Tx, []string{"staff", "manager", "owner"}, M{"title": first + " is running " + mins + " min late", "body": fmt.Sprintf("Booking at %s for %s.", at, str(bk["party_size"])), "tag": "late-" + str(bk["id"]), "url": "/bookings"}, 0)
	if err := c.AuditAs(nil, "booking.late", fmt.Sprintf("%s: %s min (%s)", cname, mins, start), ""); err != nil {
		return err
	}
	c.Notify("bookings")
	return nil
}

var tableEventVip = regexp.MustCompile(`(?i)event|vip`)

func (c *C) tablePhotoNeeded(o M) bool {
	m := c.S()["photo_check"]
	if m == "" {
		m = "off"
	}
	if m == "off" {
		return false
	}
	if m == "all" {
		return true
	}
	allergy := truthy(o["allergy"]) || truthy(o["allergy_note"])
	return ((m == "allergy" || m == "special") && allergy) || (m == "special" && (str(o["source"]) == "event" || tableEventVip.MatchString(str(o["order_notes"]))))
}

/* ---------- register ---------- */

var tableJpegRE = regexp.MustCompile(`^data:image/jpeg;base64,[A-Za-z0-9+/=]+$`)
var tableAddonRE = regexp.MustCompile(`(?i)drink|dessert|side|app|starter|beer|wine|cocktail`)
var tableDateRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func (a *App) registerTable(rt *router) {
	a.G["tabCode"] = func(c *C, args ...any) (any, error) { return c.tableCode(args[0]) }
	a.G["tabMemberFor"] = func(c *C, args ...any) (any, error) { return tableMemberFor(args[0]), nil }
	a.G["memberItems"] = func(c *C, args ...any) (any, error) {
		ids := []int64{}
		if len(args) < 2 || !truthy(args[1]) {
			return ids, nil
		}
		rows, err := c.All(`SELECT oi.id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.tab_id = ? AND o.tab_member = ? AND o.status <> 'void'`, tableRow(args[0])["id"], args[1])
		for _, r := range rows {
			ids = append(ids, i64(r["id"]))
		}
		return ids, err
	}
	a.G["tabMembers"] = func(c *C, args ...any) (any, error) {
		return c.All(`SELECT tab_member AS name, COUNT(*) rounds, SUM(total_cents) cents FROM orders WHERE tab_id = ? AND status <> 'void' AND tab_member IS NOT NULL GROUP BY tab_member`, tableRow(args[0])["id"])
	}
	a.G["tableTimeline"] = func(c *C, args ...any) (any, error) { return c.tableTimeline() }
	a.G["bookingLate"] = func(c *C, args ...any) (any, error) { return nil, c.tableBookingLate(args[0], args[1], args[2]) }
	a.G["photoNeeded"] = func(c *C, args ...any) (any, error) { return c.tablePhotoNeeded(tableRow(args[0])), nil }
	a.G["hasPlatePhoto"] = func(c *C, args ...any) (any, error) {
		r, err := c.One(`SELECT 1 FROM plate_photos WHERE order_id = ?`, args[0])
		return r != nil, err
	}

	/* ===== split a tab ===== */
	rt.pub("POST /api/t/{token}/tab/join", func(c *C) error {
		b, err := c.Body(valid.Ordered(
			"code", valid.String().Trim().Upper().RegexMsg(`^[A-Z]{4}$`, "Type the 4-letter tab code"),
			"name", valid.String().Trim().Min(1).Max(30)))
		if err != nil {
			return err
		}
		tab, err := c.One(`SELECT * FROM tabs WHERE code = ? AND status = 'open' AND opened_at > datetime('now','-24 hours')`, b["code"])
		if err != nil {
			return err
		}
		if tab == nil {
			return notFound("No open tab with that code")
		}
		if err := c.AuditAs(nil, "tab.join", fmt.Sprintf("%s joined %s's tab", str(b["name"]), str(tab["name"])), c.IP()); err != nil {
			return err
		}
		c.Notify("tabs")
		return c.JSON(M{"token": tab["token"], "member": b["name"]})
	}, a.publicLim())

	/* ===== my tables on the pad ===== */
	rt.staff("GET /pad/tables", "staff", func(c *C) error {
		rows, err := c.All(`SELECT t.id, t.label, t.seats, t.zone, t.status, t.server_id, t.seated_at, g.name guest_name, g.party_size, u.name server_name FROM tables t LEFT JOIN guests g ON g.id = t.guest_id LEFT JOIN users u ON u.id = t.server_id ORDER BY t.zone, t.id`)
		if err != nil {
			return err
		}
		openRows, err := c.All(`SELECT table_id, COUNT(*) n, SUM(total_cents) c, MAX(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) ready FROM orders WHERE table_id IS NOT NULL AND status IN ('open','sent','ready','held') AND paid_at IS NULL AND tab_id IS NULL GROUP BY table_id`)
		if err != nil {
			return err
		}
		open := map[int64]store.Row{}
		for _, r := range openRows {
			open[i64(r["table_id"])] = r
		}
		jt, err := c.seatJoinedTo()
		if err != nil {
			return err
		}
		out := make([]M, 0, len(rows))
		for _, t := range rows {
			m := M{}
			for k, v := range t {
				m[k] = v
			}
			id := i64(t["id"])
			with, err := c.seatJoinedWith(id)
			if err != nil {
				return err
			}
			all, err := c.seatJoinedSeats(t)
			if err != nil {
				return err
			}
			var jto any
			if l, ok := jt[id]; ok && truthy(l) {
				jto = l
			}
			o := open[id]
			m["joinedTo"], m["joinedWith"], m["seatsAll"] = jto, with, all
			m["mine"] = t["server_id"] != nil && i64(t["server_id"]) == c.U.ID
			m["openChecks"], m["openCents"], m["foodReady"] = int64(0), int64(0), false
			if o != nil {
				if truthy(o["n"]) {
					m["openChecks"] = o["n"]
				}
				if truthy(o["c"]) {
					m["openCents"] = o["c"]
				}
				m["foodReady"] = truthy(o["ready"])
			}
			m["seatedMinutes"] = tableMinutesSince(t["seated_at"])
			out = append(out, m)
		}
		return c.JSON(M{"me": c.U.ID, "tables": out})
	})

	/* ===== table timeline ===== */
	rt.staff("GET /table-timeline", "staff", func(c *C) error {
		t, err := c.tableTimeline()
		if err != nil {
			return err
		}
		return c.JSON(t)
	})

	/* ===== prep log ===== */
	rt.pub("GET /api/kds/prep-log", func(c *C) error {
		w, err := c.tableWho()
		if err != nil {
			return err
		}
		rows, err := c.All(`SELECT kind, ref_id, qty, by_label, lot_id, at FROM prep_log WHERE day = ? AND area = ?`, c.tableToday(), w.area)
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})
	rt.pub("POST /api/kds/prep-log", func(c *C) error {
		w, err := c.tableWho()
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Ordered(
			"kind", valid.Enum("item", "ingredient"),
			"refId", valid.Int(),
			"qty", valid.Number().Min(0).Max(1e6),
			"done", valid.Bool(),
			"by", valid.String().Trim().Max(30).Optional()))
		if err != nil {
			return err
		}
		day := c.tableToday()
		if b["done"] != true {
			row, err := c.One(`SELECT * FROM prep_log WHERE day = ? AND area = ? AND kind = ? AND ref_id = ?`, day, w.area, b["kind"], b["refId"])
			if err != nil {
				return err
			}
			if row != nil && truthy(row["lot_id"]) {
				if _, err := c.Run(`DELETE FROM ingredient_lots WHERE id = ? AND status = 'open'`, row["lot_id"]); err != nil {
					return err
				}
			}
			if _, err := c.Run(`DELETE FROM prep_log WHERE day = ? AND area = ? AND kind = ? AND ref_id = ?`, day, w.area, b["kind"], b["refId"]); err != nil {
				return err
			}
			c.Notify("lots")
			return c.OK()
		}
		q := `SELECT name FROM ingredients WHERE id = ?`
		if b["kind"] == "item" {
			q = `SELECT name FROM menu_items WHERE id = ?`
		}
		nr, err := c.One(q, b["refId"])
		if err != nil {
			return err
		}
		if nr == nil || !truthy(nr["name"]) {
			return notFound("Not found")
		}
		name := str(nr["name"])
		var lotID any
		if b["kind"] == "ingredient" && f64(b["qty"]) > 0 {
			before, err := c.Val(`SELECT MAX(id) m FROM ingredient_lots`)
			if err != nil {
				return err
			}
			if _, err := c.G("onReceive", b["refId"], b["qty"], "prep ("+w.area+")"); err != nil {
				return err
			}
			after, err := c.Val(`SELECT MAX(id) m FROM ingredient_lots`)
			if err != nil {
				return err
			}
			if i64(after) > i64(before) {
				lotID = i64(after)
			}
		}
		by := tableLabel(w)
		if w.user == nil && truthy(b["by"]) {
			by = str(b["by"])
		}
		if _, err := c.Run(`INSERT INTO prep_log (day, area, kind, ref_id, name, qty, by_label, lot_id) VALUES (?,?,?,?,?,?,?,?)
			ON CONFLICT (day, area, kind, ref_id) DO UPDATE SET name = excluded.name, qty = excluded.qty, by_label = excluded.by_label, lot_id = excluded.lot_id, at = excluded.at`,
			day, w.area, b["kind"], b["refId"], name, b["qty"], by, lotID); err != nil {
			return err
		}
		if err := c.AuditAs(w.user, "prep.done", fmt.Sprintf("%s %s (%s)", fmtJSNum(f64(b["qty"])), name, tableLabel(w)), c.IP()); err != nil {
			return err
		}
		c.Notify("lots")
		return c.JSON(M{"ok": true, "lot": lotID != nil})
	})

	/* ===== delivery route order ===== */
	rt.staff("GET /deliveries/route", "staff", func(c *C) error {
		s := c.S()
		var driverID any = c.U.ID
		if f := tableJSNumber(c.Q("driver")); f != 0 && !math.IsNaN(f) {
			driverID = tableNumAny(f)
		}
		if f64(driverID) != float64(c.U.ID) && c.U.Role != "manager" && c.U.Role != "owner" {
			return forbidden("Only your own route")
		}
		stops, err := c.All(`SELECT id, number, delivery_address, drop_lat, drop_lng, customer_name, contact_phone, out_at, status FROM orders WHERE fulfillment = 'delivery' AND driver_id = ? AND delivered_at IS NULL AND status <> 'void' ORDER BY id`, driverID)
		if err != nil {
			return err
		}
		var placed, rest []store.Row
		for _, o := range stops {
			if o["drop_lat"] != nil {
				placed = append(placed, o)
			} else {
				rest = append(rest, o)
			}
		}
		var cur []float64
		if s["biz_lat"] != "" {
			cur = []float64{tableJSNumber(s["biz_lat"]), tableJSNumber(s["biz_lng"])}
		} else if len(placed) > 0 {
			cur = []float64{f64(placed[0]["drop_lat"]), f64(placed[0]["drop_lng"])}
		}
		type stop struct {
			o   store.Row
			leg any
		}
		order := []stop{}
		km := 0.0
		left := append([]store.Row{}, placed...)
		for len(left) > 0 && cur != nil {
			bi, bd := 0, math.Inf(1)
			for i, o := range left {
				if d := tableDist(cur[0], cur[1], f64(o["drop_lat"]), f64(o["drop_lng"])); d < bd {
					bd, bi = d, i
				}
			}
			o := left[bi]
			left = append(left[:bi], left[bi+1:]...)
			km += bd
			order = append(order, stop{o, float64(roundJS(bd*10)) / 10})
			cur = []float64{f64(o["drop_lat"]), f64(o["drop_lng"])}
		}
		for _, o := range rest {
			order = append(order, stop{o, nil})
		}
		var maps any
		if n := len(order); n > 0 {
			u := "https://www.google.com/maps/dir/?api=1"
			if s["biz_lat"] != "" {
				u += "&origin=" + s["biz_lat"] + "," + s["biz_lng"]
			}
			u += "&destination=" + tableEncURI(str(order[n-1].o["delivery_address"]))
			if n > 1 {
				parts := []string{}
				for _, st := range order[:n-1] {
					parts = append(parts, tableEncURI(str(st.o["delivery_address"])))
				}
				u += "&waypoints=" + strings.Join(parts, "|")
			}
			maps = u + "&travelmode=driving"
		}
		out := make([]M, 0, len(order))
		for i, st := range order {
			o := st.o
			stt := str(o["status"])
			out = append(out, M{"stop": i + 1, "id": o["id"], "number": o["number"], "address": o["delivery_address"], "name": o["customer_name"], "phone": o["contact_phone"], "legKm": st.leg, "out": truthy(o["out_at"]), "ready": stt == "ready" || stt == "paid"})
		}
		return c.JSON(M{"driverId": driverID, "stops": out, "totalKm": float64(roundJS(km*10)) / 10, "mapsUrl": maps, "unplaced": len(rest)})
	})

	/* ===== server coaching ===== */
	rt.staff("GET /coaching", "manager", func(c *C) error {
		days := tableJSNumber(c.Q("days"))
		if days == 0 || math.IsNaN(days) {
			days = 30
		}
		days = math.Min(90, math.Max(1, days))
		noon, _ := time.Parse("2006-01-02T15:04:05", c.tableToday()+"T12:00:00")
		from := noon.Add(time.Duration(-(days - 1) * 86400000 * float64(time.Millisecond))).Format("2006-01-02")
		since, _ := tableDayBounds(from, c.tableTZ())
		rows, err := c.All(`SELECT o.id, o.created_by, u.name, o.subtotal_cents - o.discount_cents net, o.tip_cents, o.table_id FROM orders o JOIN users u ON u.id = o.created_by WHERE o.paid_at >= ? AND o.status <> 'void' AND o.created_by IS NOT NULL`, since)
		if err != nil {
			return err
		}
		type agg struct {
			n     int64
			addon bool
		}
		byOrder := map[int64]*agg{}
		if len(rows) > 0 {
			ids := make([]string, len(rows))
			for i, r := range rows {
				ids[i] = itoa(i64(r["id"]))
			}
			items, err := c.All(`SELECT oi.order_id, oi.qty, m.category FROM order_items oi LEFT JOIN menu_items m ON m.id = oi.item_id WHERE oi.order_id IN (` + strings.Join(ids, ",") + `) AND oi.price_cents > 0`)
			if err != nil {
				return err
			}
			for _, i := range items {
				k := i64(i["order_id"])
				x := byOrder[k]
				if x == nil {
					x = &agg{}
					byOrder[k] = x
				}
				x.n += i64(i["qty"])
				if tableAddonRE.MatchString(str(i["category"])) {
					x.addon = true
				}
			}
		}
		type person struct {
			userID                           int64
			name                             any
			checks, net, tips, items, addons int64
		}
		people := map[int64]*person{}
		var keys []int64
		for _, r := range rows {
			uid := i64(r["created_by"])
			p := people[uid]
			if p == nil {
				p = &person{userID: uid, name: r["name"]}
				people[uid] = p
				keys = append(keys, uid)
			}
			b := byOrder[i64(r["id"])]
			if b == nil {
				b = &agg{}
			}
			p.checks++
			p.net += i64(r["net"])
			p.tips += i64(r["tip_cents"])
			p.items += b.n
			if b.addon {
				p.addons++
			}
		}
		fm := func(p *person) M {
			out := M{"userId": p.userID, "name": p.name, "checks": p.checks, "salesCents": p.net, "avgCheckCents": int64(0), "itemsPerCheck": 0.0, "addonPct": int64(0), "tipPct": 0.0}
			if p.checks > 0 {
				ch := float64(p.checks)
				out["avgCheckCents"] = roundJS(float64(p.net) / ch)
				out["itemsPerCheck"] = float64(roundJS(float64(p.items)/ch*10)) / 10
				out["addonPct"] = roundJS(float64(p.addons) / ch * 100)
			}
			if p.net != 0 {
				out["tipPct"] = float64(roundJS(float64(p.tips)/float64(p.net)*1000)) / 10
			}
			return out
		}
		list := []M{}
		team := &person{userID: 0, name: "Team"}
		for _, k := range keys {
			p := people[k]
			if p.checks >= 1 {
				list = append(list, fm(p))
			}
			team.checks += p.checks
			team.net += p.net
			team.tips += p.tips
			team.items += p.items
			team.addons += p.addons
		}
		sort.SliceStable(list, func(a, b int) bool { return i64(list[b]["salesCents"]) < i64(list[a]["salesCents"]) })
		tm := fm(team)
		for _, p := range list {
			tips := []string{}
			if i64(p["checks"]) >= 5 {
				if f64(p["avgCheckCents"]) < f64(tm["avgCheckCents"])*0.85 {
					tips = append(tips, "Check average is below the team: suggest a starter or dessert")
				}
				if f64(p["addonPct"]) < f64(tm["addonPct"])-15 {
					tips = append(tips, "Fewer add-ons than the team: offer drinks and sides")
				}
				if f64(p["tipPct"]) < f64(tm["tipPct"])-3 {
					tips = append(tips, "Tips are lower than the team: check in at the table more")
				}
			}
			p["tips"] = tips
		}
		return c.JSON(M{"days": tableNumAny(days), "team": tm, "people": list})
	})

	/* ===== expo photo check ===== */
	rt.pub("POST /api/kds/plate-photo", func(c *C) error {
		w, err := c.tableWho()
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Ordered("orderId", valid.Int(), "photo", valid.String().Max(400000)))
		if err != nil {
			return err
		}
		if !tableJpegRE.MatchString(str(b["photo"])) {
			return bad("Bad photo")
		}
		o, err := c.One(`SELECT number FROM orders WHERE id = ?`, b["orderId"])
		if err != nil {
			return err
		}
		if o == nil {
			return notFound("Not found")
		}
		if _, err := c.Run(`INSERT INTO plate_photos (order_id, data, by_label) VALUES (?,?,?)`, b["orderId"], b["photo"], tableLabel(w)); err != nil {
			return err
		}
		if err := c.AuditAs(w.user, "plate.photo", fmt.Sprintf("#%s (%s)", str(o["number"]), tableLabel(w)), c.IP()); err != nil {
			return err
		}
		return c.OK()
	})
	rt.staff("GET /plate-photos", "manager", func(c *C) error {
		date := c.Q("date")
		if !tableDateRE.MatchString(date) {
			date = c.tableToday()
		}
		start, end := tableDayBounds(date, c.tableTZ())
		rows, err := c.All(`SELECT p.id, p.order_id, p.by_label, p.at, o.number, o.allergy_note, o.order_notes FROM plate_photos p JOIN orders o ON o.id = p.order_id WHERE p.at >= ? AND p.at < ? ORDER BY p.at DESC`, start, end)
		if err != nil {
			return err
		}
		for _, p := range rows {
			p["url"] = "/api/staff/plate-photos/" + str(p["id"])
		}
		return c.JSON(rows)
	})
	a.every("plate-photos-cleanup", 6*time.Hour, func(c *C) error {
		_ = c.Tx.Savepoint(c.Ctx, func() error {
			_, err := c.Run(`DELETE FROM plate_photos WHERE at < datetime('now','-60 days')`)
			return err
		})
		return nil
	})
	rt.staff("GET /plate-photos/{id}", "manager", func(c *C) error {
		p, err := c.One(`SELECT data FROM plate_photos WHERE id = ?`, tableNumParam(c.Param("id")))
		if err != nil {
			return err
		}
		if p == nil {
			return notFound("Not found")
		}
		c.W.Header().Set("Content-Type", "image/jpeg")
		c.W.Header().Set("Cache-Control", "private, max-age=3600")
		_, _ = c.W.Write(tableB64(tableDataPart(str(p["data"]))))
		return nil
	})
}
