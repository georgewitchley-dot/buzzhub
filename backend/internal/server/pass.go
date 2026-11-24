package server

// Port of server/src/pass.js: pass timer, screen-to-screen messages, batch timers, online order slots,
// pickup shelves, curbside ETA, who made it (cook on area screens), dish ratings, schedules by area.

import (
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

func init() { modules = append(modules, (*App).registerPass) }

var passDefaultQuick = []any{"Need 2 more fries", "Need hands here", "Behind, 5 minutes", "Fire the next course", "86 coming", "Pick up at the pass"}

func passLabel(w *kdsWhoT) string {
	if w.user != nil {
		return kdsFirst(w.user.Name)
	}
	return w.area
}

// passWhosOn is timeclock.js whosOn(), with the fields the kitchen modules use.
func (c *C) passWhosOn() ([]M, error) {
	start, _ := c.kdsDayBounds(c.kdsLocalToday())
	rows, err := c.All(`SELECT s.*, u.name, u.role, u.tip_role FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_out IS NULL ORDER BY s.clock_in`)
	if err != nil {
		return nil, err
	}
	out := []M{}
	for _, s := range rows {
		sched, err := c.One(`SELECT start_local, end_local, role_note FROM schedule WHERE user_id = ? AND substr(start_local,1,10) = ? ORDER BY start_local LIMIT 1`, s["user_id"], c.kdsLocalToday())
		if err != nil {
			return nil, err
		}
		pos := ""
		var end any
		if sched != nil && truthy(sched["role_note"]) {
			pos = str(sched["role_note"])
		} else if truthy(s["tip_role"]) {
			pos = str(s["tip_role"])
		}
		if sched != nil && len(str(sched["end_local"])) > 11 {
			end = str(sched["end_local"])[11:]
		}
		out = append(out, M{"userId": s["user_id"], "name": s["name"], "role": s["role"], "position": pos, "since": s["clock_in"], "onBreak": truthy(s["break_started"]),
			"breakSince": s["break_started"], "scheduledEnd": end, "overnight": str(s["clock_in"]) < start})
	}
	return out, nil
}

// passShelfList: shelves/cubbies from the setting: "A1-A6, B1-B6" or a count like "12".
func (c *C) passShelfList() []string {
	raw := strings.TrimSpace(c.S()["pickup_shelves"])
	out := []string{}
	if raw == "" {
		return out
	}
	if regexp.MustCompile(`^\d+$`).MatchString(raw) {
		n, _ := strconv.Atoi(raw)
		if n > 200 || len(raw) > 4 {
			n = 200
		}
		for i := 1; i <= n; i++ {
			out = append(out, strconv.Itoa(i))
		}
		return out
	}
	for _, part := range regexp.MustCompile(`[,\s]+`).Split(raw, -1) {
		if part == "" {
			continue
		}
		if pre, a, b, ok := passRange(part); ok {
			for i := a; i <= b && len(out) < 200; i++ {
				out = append(out, pre+strconv.Itoa(i))
			}
		} else {
			r := []rune(part)
			if len(r) > 8 {
				r = r[:8]
			}
			out = append(out, string(r))
		}
	}
	seen := map[string]bool{}
	uniq := []string{}
	for _, x := range out {
		if !seen[x] {
			seen[x] = true
			uniq = append(uniq, x)
		}
	}
	return uniq
}

// passRange matches /^([A-Za-z]*)(\d+)-\1?(\d+)$/ (Go has no backreferences).
func passRange(p string) (string, int, int, bool) {
	i := 0
	for i < len(p) && (p[i] >= 'a' && p[i] <= 'z' || p[i] >= 'A' && p[i] <= 'Z') {
		i++
	}
	pre := p[:i]
	j := i
	for j < len(p) && p[j] >= '0' && p[j] <= '9' {
		j++
	}
	if j == i || j >= len(p) || p[j] != '-' {
		return "", 0, 0, false
	}
	a, _ := strconv.Atoi(p[i:j])
	rest := p[j+1:]
	digits := func(s string) bool {
		if s == "" {
			return false
		}
		for k := 0; k < len(s); k++ {
			if s[k] < '0' || s[k] > '9' {
				return false
			}
		}
		return true
	}
	if pre != "" && strings.HasPrefix(rest, pre) && digits(rest[len(pre):]) {
		rest = rest[len(pre):]
	}
	if !digits(rest) {
		return "", 0, 0, false
	}
	b, _ := strconv.Atoi(rest)
	return pre, a, b, true
}

func (c *C) passShelvesInUse() ([]string, error) {
	rows, err := c.All(`SELECT shelf FROM orders WHERE shelf IS NOT NULL AND handed_at IS NULL AND status <> 'void' AND created_at > datetime('now','-8 hours') ORDER BY id`)
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, r := range rows {
		out = append(out, str(r["shelf"]))
	}
	return out, nil
}

// passKdsExtra: extra data for each area screen.
func (c *C) passKdsExtra(area string) (M, error) {
	s := c.S()
	ms, err := c.All(`SELECT * FROM kds_messages WHERE (to_area = ? OR to_area = 'All' OR from_area = ?) AND at > datetime('now','-45 minutes') ORDER BY id DESC LIMIT 12`, area, area)
	if err != nil {
		return nil, err
	}
	messages := []M{}
	for _, m := range ms {
		messages = append(messages, M{"id": m["id"], "from": m["from_area"], "to": m["to_area"], "body": m["body"], "by": m["by_label"], "at": m["at"], "acked": truthy(m["ack_at"]), "ackBy": m["ack_by"], "mine": str(m["from_area"]) == area})
	}
	ts, err := c.All(`SELECT * FROM kds_timers WHERE area = ? ORDER BY id`, area)
	if err != nil {
		return nil, err
	}
	timers := []M{}
	for _, t := range ts {
		timers = append(timers, M{"id": t["id"], "name": t["name"], "minutes": t["minutes"], "repeat": truthy(t["repeat"]), "dueAt": t["due_at"]})
	}
	on, err := c.passWhosOn()
	if err != nil {
		return nil, err
	}
	crew := []M{}
	for _, p := range on {
		if !p["onBreak"].(bool) {
			crew = append(crew, M{"id": p["userId"], "name": kdsFirst(str(p["name"]))})
		}
	}
	shelves := []string{}
	if s["pickup_shelves"] != "" {
		shelves = c.passShelfList()
	}
	used, err := c.passShelvesInUse()
	if err != nil {
		return nil, err
	}
	return M{"messages": messages, "timers": timers, "crew": crew, "passMinutes": kdsOut(kdsSetNum(s["pass_alert_minutes"], 0)), "shelves": shelves, "shelvesUsed": used,
		"quick": kdsPJ(s["kds_quick_messages"], passDefaultQuick)}, nil
}

// passCookFor: the cook picked on the area screen, if they are an active user.
func (c *C) passCookFor(body map[string]any) (any, error) {
	id := kdsNum(body["cookId"])
	if id == 0 || math.IsNaN(id) {
		return nil, nil
	}
	r, err := c.One(`SELECT id FROM users WHERE id = ? AND active = 1`, int64(id))
	if err != nil || r == nil {
		return nil, err
	}
	return orNil(r["id"]), nil
}

func passSlotStart(t float64) float64 { return math.Floor(t/900000) * 900000 }

func (c *C) passCap() float64 { return kdsSetNum(c.S()["slot_capacity"], 0) }

func (c *C) passCountIn(start float64) (int64, error) {
	return c.N(`SELECT COUNT(*) c FROM orders WHERE promised_at >= ? AND promised_at < ? AND status <> 'void'`, kdsSQLAt(start), kdsSQLAt(start+900000))
}

// passLocalToUtc: local "YYYY-MM-DD HH:MM" → UTC sql time, using the business time zone.
func (c *C) passLocalToUtc(local string) string {
	guess := kdsMs(local + ":00")
	if math.IsNaN(guess) {
		return "Invalid Date"
	}
	_, off := time.UnixMilli(int64(guess)).In(c.kdsTZ()).Zone()
	offMin := off / 60
	return kdsSQLAt(guess - float64(offMin)*60000)
}

// passSlotFor: when this online order will be ready: the first slot with room at or after the kitchen's quote, or the chosen time.
func (c *C) passSlotFor(scheduledFor any) (M, error) {
	cp := c.passCap()
	if truthy(scheduledFor) {
		at := kdsMs(c.passLocalToUtc(kdsJS(scheduledFor)))
		if cp != 0 && !math.IsNaN(cp) {
			n, err := c.passCountIn(passSlotStart(at))
			if err != nil {
				return nil, err
			}
			if float64(n) >= cp {
				return nil, conflict("That pickup time is full. Please pick another time.")
			}
		}
		return M{"promisedAt": kdsSQLAt(at), "minutes": roundJS((at - kdsNowMs()) / 60000)}, nil
	}
	q, err := c.lineQuoteMinutes()
	if err != nil {
		return nil, err
	}
	at := kdsNowMs() + f64(q["minutes"])*60000
	if cp != 0 && !math.IsNaN(cp) {
		start := passSlotStart(at)
		for k := 0; k < 96; k++ {
			n, err := c.passCountIn(start)
			if err != nil {
				return nil, err
			}
			if float64(n) < cp {
				break
			}
			start += 900000
		}
		if start > at {
			at = start
		}
	}
	m := roundJS((at - kdsNowMs()) / 60000)
	if m < 1 {
		m = 1
	}
	return M{"promisedAt": kdsSQLAt(at), "minutes": m}, nil
}

func (c *C) passEnRoute() ([]M, error) {
	rows, err := c.All(`SELECT o.id, o.number, o.eta_minutes, o.eta_km, o.eta_at, o.status, o.customer_name, g.name guest_name FROM orders o LEFT JOIN guests g ON g.id = o.guest_id WHERE o.eta_at > datetime('now','-10 minutes') AND o.arrived_at IS NULL AND o.handed_at IS NULL AND o.status <> 'void' ORDER BY o.eta_minutes NULLS FIRST`)
	if err != nil {
		return nil, err
	}
	out := []M{}
	for _, o := range rows {
		name := o["customer_name"]
		if !truthy(name) {
			name = o["guest_name"]
		}
		out = append(out, M{"id": o["id"], "number": o["number"], "name": name, "etaMinutes": o["eta_minutes"], "km": o["eta_km"], "ready": kdsStatusIn(o, "ready", "paid")})
	}
	return out, nil
}

func (c *C) passFeedbackDishes(f M) ([]M, error) {
	g, err := c.One(`SELECT * FROM guests WHERE id = ?`, f["guest_id"])
	if err != nil || g == nil {
		return []M{}, err
	}
	zero := func(v any) any {
		if !truthy(v) {
			return int64(0)
		}
		return v
	}
	since := g["seated_at"]
	if !truthy(since) {
		since = g["created_at"]
	}
	rows, err := c.All(`SELECT DISTINCT oi.item_id, oi.name FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status <> 'void' AND oi.price_cents > 0 AND (o.guest_id = ? OR o.id = ? OR (o.table_id = ? AND o.created_at BETWEEN ? AND COALESCE(?, datetime('now')))) LIMIT 12`,
		g["id"], zero(g["order_id"]), zero(g["table_id"]), since, g["closed_at"])
	if err != nil {
		return nil, err
	}
	rs, err := c.All(`SELECT name, liked FROM dish_ratings WHERE feedback_id = ?`, f["id"])
	if err != nil {
		return nil, err
	}
	mine := map[string]any{}
	for _, r := range rs {
		mine[str(r["name"])] = r["liked"]
	}
	out := []M{}
	for _, r := range rows {
		out = append(out, M{"itemId": r["item_id"], "name": r["name"], "liked": mine[str(r["name"])]})
	}
	return out, nil
}

func (a *App) registerPass(rt *router) {
	who := func(c *C) (*kdsWhoT, error) { return c.kdsWho(false) }

	a.G["kdsExtra"] = func(c *C, args ...any) (any, error) { return c.passKdsExtra(kdsJS(args[0])) }

	/* ===== screen-to-screen messages ===== */
	rt.pub("POST /api/kds/msg", func(c *C) error {
		w, err := who(c)
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Ordered("to", valid.String().Trim().Min(1).Max(24), "body", valid.String().Trim().Min(1).Max(120)))
		if err != nil {
			return err
		}
		ok := append(c.kdsStationList(), kdsExpo, kdsPack, kdsAll, "All")
		if !kdsHas(ok, str(b["to"])) {
			return bad("Pick an area")
		}
		if _, err := c.Run(`INSERT INTO kds_messages (from_area, to_area, body, by_label) VALUES (?,?,?,?)`, w.area, b["to"], b["body"], passLabel(w)); err != nil {
			return err
		}
		c.Notify("kds")
		return c.OK()
	})
	rt.pub("POST /api/kds/msg/{id}/ack", func(c *C) error {
		w, err := who(c)
		if err != nil {
			return err
		}
		by := passLabel(w)
		if w.user == nil {
			by += " (" + w.area + ")"
		}
		if _, err := c.Run(`UPDATE kds_messages SET ack_at = datetime('now'), ack_by = ? WHERE id = ? AND ack_at IS NULL`, by, c.kdsPID("id")); err != nil {
			return err
		}
		c.Notify("kds")
		return c.OK()
	})

	/* ===== batch timers ===== */
	rt.pub("POST /api/kds/timers", func(c *C) error {
		w, err := who(c)
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Ordered("name", valid.String().Trim().Min(1).Max(30), "minutes", valid.Number().Min(0.5).Max(240), "repeat", valid.Bool().Default(true)))
		if err != nil {
			return err
		}
		n, err := c.N(`SELECT COUNT(*) c FROM kds_timers WHERE area = ?`, w.area)
		if err != nil {
			return err
		}
		if n >= 8 {
			return bad("Up to 8 timers per area")
		}
		rep := 0
		if b["repeat"] == true {
			rep = 1
		}
		if _, err := c.Run(`INSERT INTO kds_timers (area, name, minutes, repeat, due_at) VALUES (?,?,?,?,?)`, w.area, b["name"], b["minutes"], rep, kdsSQLAt(kdsNowMs()+f64(b["minutes"])*60000)); err != nil {
			return err
		}
		return c.OK()
	})
	rt.pub("POST /api/kds/timers/{id}/{what}", func(c *C) error {
		w, err := who(c)
		if err != nil {
			return err
		}
		t, err := c.One(`SELECT * FROM kds_timers WHERE id = ? AND area = ?`, c.kdsPID("id"), w.area)
		if err != nil {
			return err
		}
		if t == nil {
			return notFound("Not found")
		}
		next := kdsSQLAt(kdsNowMs() + f64(t["minutes"])*60000)
		switch c.Param("what") {
		case "restart":
			_, err = c.Run(`UPDATE kds_timers SET due_at = ? WHERE id = ?`, next, t["id"])
		case "stop":
			_, err = c.Run(`UPDATE kds_timers SET due_at = NULL WHERE id = ?`, t["id"])
		case "done":
			if truthy(t["repeat"]) {
				_, err = c.Run(`UPDATE kds_timers SET due_at = ? WHERE id = ?`, next, t["id"])
			} else {
				_, err = c.Run(`UPDATE kds_timers SET due_at = NULL WHERE id = ?`, t["id"])
			}
		case "delete":
			_, err = c.Run(`DELETE FROM kds_timers WHERE id = ?`, t["id"])
		default:
			return notFound("Unknown")
		}
		if err != nil {
			return err
		}
		return c.OK()
	})

	/* ===== who made it ===== */
	a.G["cookFor"] = func(c *C, args ...any) (any, error) {
		b, _ := args[0].(map[string]any)
		return c.passCookFor(b)
	}

	/* ===== pass timer: food finished but not completed ===== */
	a.every("pass-check", 30*time.Second, func(c *C) error {
		s := c.S()
		lim := kdsSetNum(s["pass_alert_minutes"], 0)
		if lim == 0 || math.IsNaN(lim) || s["kds_expo"] != "1" {
			return nil
		}
		rows, err := c.All(`SELECT o.id, o.number, (SELECT MAX(done_at) FROM order_items WHERE order_id = o.id) last FROM orders o WHERE o.status IN ('open','sent') AND o.pass_alerted IS NULL AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = o.id AND done_at IS NULL AND (course <= 1 OR fired_at IS NOT NULL)) AND EXISTS (SELECT 1 FROM order_items WHERE order_id = o.id)`)
		if err != nil {
			return err
		}
		for _, o := range rows {
			if !truthy(o["last"]) || kdsNowMs()-kdsMs(o["last"]) < lim*60000 {
				continue
			}
			if _, err := c.Run(`UPDATE orders SET pass_alerted = datetime('now') WHERE id = ?`, o["id"]); err != nil {
				return err
			}
			c.a.pushToUsers(c.Ctx, c.Tx, []string{"staff", "manager", "owner"}, M{"title": fmt.Sprintf("#%s waiting at the pass", kdsJS(o["number"])),
				"body": fmt.Sprintf("Finished %d minutes ago. Run it out.", roundJS((kdsNowMs()-kdsMs(o["last"]))/60000)), "tag": "pass-" + kdsJS(o["id"]), "url": "/kitchen"}, 0)
		}
		return nil
	})

	/* ===== online order slots ===== */
	a.G["slotFor"] = func(c *C, args ...any) (any, error) {
		var sf any
		if len(args) > 0 {
			sf = args[0]
		}
		return c.passSlotFor(sf)
	}
	a.G["slotQuote"] = func(c *C, args ...any) (any, error) {
		r, err := c.passSlotFor(nil)
		if err != nil {
			return nil, err
		}
		return r["minutes"], nil
	}
	dateRE := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	rt.pub("GET /api/o/slots", func(c *C) error {
		d := c.Q("date")
		if d == "" {
			d = c.kdsLocalToday()
		}
		cp := c.passCap()
		if !dateRE.MatchString(d) || cp == 0 || math.IsNaN(cp) {
			return c.JSON(M{"capacity": kdsOut(cp), "full": []any{}})
		}
		start, end := c.kdsDayBounds(d)
		rows, err := c.All(`SELECT promised_at FROM orders WHERE promised_at >= ? AND promised_at < ? AND status <> 'void'`, start, end)
		if err != nil {
			return err
		}
		tz := c.kdsTZ()
		counts := map[string]int{}
		keys := []string{}
		for _, r := range rows {
			k := time.UnixMilli(int64(kdsMs(kdsSQLAt(passSlotStart(kdsMs(r["promised_at"])))))).In(tz).Format("15:04")
			if _, ok := counts[k]; !ok {
				keys = append(keys, k)
			}
			counts[k]++
		}
		full := []string{}
		for _, k := range keys {
			if float64(counts[k]) >= cp {
				full = append(full, k)
			}
		}
		return c.JSON(M{"capacity": cp, "full": full})
	}, a.publicLim())

	/* ===== pickup shelves ===== */
	a.G["shelfFree"] = func(c *C, args ...any) (any, error) {
		used, err := c.passShelvesInUse()
		if err != nil {
			return nil, err
		}
		out := []string{}
		for _, x := range c.passShelfList() {
			if !kdsHas(used, x) {
				out = append(out, x)
			}
		}
		return out, nil
	}
	rt.pub("POST /api/kds/shelf", func(c *C) error {
		w, err := who(c)
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Ordered("orderId", valid.Int(), "shelf", valid.String().Trim().Max(8).Nullable()))
		if err != nil {
			return err
		}
		o, err := c.One(`SELECT * FROM orders WHERE id = ?`, b["orderId"])
		if err != nil {
			return err
		}
		if o == nil {
			return notFound("Not found")
		}
		shelf := str(b["shelf"])
		if shelf != "" && !kdsHas(c.passShelfList(), shelf) {
			return bad("Unknown shelf")
		}
		if shelf != "" {
			used, err := c.passShelvesInUse()
			if err != nil {
				return err
			}
			if kdsHas(used, shelf) && str(o["shelf"]) != shelf {
				return conflict(fmt.Sprintf("Shelf %s already has an order", shelf))
			}
		}
		if _, err := c.Run(`UPDATE orders SET shelf = ? WHERE id = ?`, orNil(shelf), o["id"]); err != nil {
			return err
		}
		to := shelf
		if to == "" {
			to = "none"
		}
		if err := c.AuditAs(w.user, "order.shelf", fmt.Sprintf("#%s → %s (%s)", kdsJS(o["number"]), to, passLabel(w)), c.IP()); err != nil {
			return err
		}
		c.Notify("orders")
		if truthy(o["guest_id"]) {
			if err := c.pushGuest(i64(o["guest_id"])); err != nil {
				return err
			}
		}
		return c.OK()
	})
	rt.staff("POST /orders/{id}/shelf", "staff", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{"shelf": valid.String().Trim().Max(8).Nullable()}))
		if err != nil {
			return err
		}
		o, err := c.One(`SELECT * FROM orders WHERE id = ?`, c.kdsPID("id"))
		if err != nil {
			return err
		}
		if o == nil {
			return notFound("Not found")
		}
		if _, err := c.Run(`UPDATE orders SET shelf = ? WHERE id = ?`, orNil(b["shelf"]), o["id"]); err != nil {
			return err
		}
		c.Notify("orders")
		if truthy(o["guest_id"]) {
			if err := c.pushGuest(i64(o["guest_id"])); err != nil {
				return err
			}
		}
		return c.OK()
	})
	a.G["shelfView"] = func(c *C, args ...any) (any, error) {
		g, _ := args[0].(map[string]any)
		if g == nil || !truthy(g["order_id"]) {
			return nil, nil
		}
		o, err := c.One(`SELECT shelf, status FROM orders WHERE id = ?`, g["order_id"])
		if err != nil || o == nil || !truthy(o["shelf"]) {
			return nil, err
		}
		return M{"shelf": o["shelf"], "ready": kdsStatusIn(o, "ready", "paid")}, nil
	}

	/* ===== curbside ETA ===== */
	rt.pub("POST /api/g/{token}/eta", func(c *C) error {
		s := c.S()
		if s["curbside"] != "1" {
			return forbidden("Curbside pickup is off")
		}
		g, err := c.One(`SELECT * FROM guests WHERE token = ?`, c.Param("token"))
		if err != nil {
			return err
		}
		if g == nil || str(g["kind"]) != "order" || !truthy(g["order_id"]) {
			return notFound("Order not found")
		}
		b, err := c.Body(valid.Ordered("lat", valid.Number().Min(-90).Max(90), "lng", valid.Number().Min(-180).Max(180), "stop", valid.Bool().Optional()))
		if err != nil {
			return err
		}
		if b["stop"] == true {
			if _, err := c.Run(`UPDATE orders SET eta_minutes = NULL, eta_km = NULL, eta_at = NULL WHERE id = ?`, g["order_id"]); err != nil {
				return err
			}
			c.Notify("orders")
			return c.OK()
		}
		if s["biz_lat"] == "" || s["biz_lng"] == "" {
			return conflict("The business location is not set up")
		}
		m := passDist(kdsNum(s["biz_lat"]), kdsNum(s["biz_lng"]), f64(b["lat"]), f64(b["lng"]))
		km := float64(roundJS(m/100)) / 10
		var eta int64
		if m >= 150 {
			sp := 45.0
			if m < 3000 {
				sp = 25
			}
			eta = roundJS(m/1000/sp*60 + 1)
			if eta < 1 {
				eta = 1
			}
		}
		o, err := c.Get(`SELECT * FROM orders WHERE id = ?`, g["order_id"])
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE orders SET eta_minutes = ?, eta_km = ?, eta_at = datetime('now') WHERE id = ?`, eta, km, o["id"]); err != nil {
			return err
		}
		if m < 150 && !truthy(o["arrived_at"]) {
			if _, err := c.Run(`UPDATE orders SET arrived_at = datetime('now') WHERE id = ?`, o["id"]); err != nil {
				return err
			}
			c.a.pushToUsers(c.Ctx, c.Tx, []string{"staff", "manager", "owner"}, M{"title": fmt.Sprintf("#%s is here", kdsJS(o["number"])), "body": kdsFirst(str(g["name"])) + " just pulled up.", "tag": "here-" + kdsJS(o["id"]), "url": "/orders"}, 0)
		}
		c.Notify("orders")
		return c.JSON(M{"ok": true, "etaMinutes": eta, "km": km, "arrived": m < 150})
	}, a.publicLim())
	a.G["enRoute"] = func(c *C, args ...any) (any, error) { return c.passEnRoute() }

	/* ===== rate each dish ===== */
	a.G["feedbackDishes"] = func(c *C, args ...any) (any, error) {
		f, _ := args[0].(map[string]any)
		return c.passFeedbackDishes(f)
	}
	a.G["saveDishRatings"] = func(c *C, args ...any) (any, error) {
		f, _ := args[0].(map[string]any)
		var list []any
		if len(args) > 1 {
			list, _ = args[1].([]any)
		}
		dishes, err := c.passFeedbackDishes(f)
		if err != nil {
			return nil, err
		}
		allowed := map[string]any{}
		for _, d := range dishes {
			allowed[str(d["name"])] = d["itemId"]
		}
		for _, x := range list {
			d, _ := x.(map[string]any)
			name, ok := d["name"].(string)
			if !ok {
				continue
			}
			id, ok := allowed[name]
			lk := d["liked"]
			isNum := false
			switch lk.(type) {
			case float64, int64, int:
				isNum = true
			}
			if !ok || !isNum || (kdsNum(lk) != 0 && kdsNum(lk) != 1) {
				continue
			}
			if _, err := c.Run(`INSERT INTO dish_ratings (feedback_id, item_id, name, liked) VALUES (?,?,?,?) ON CONFLICT (feedback_id, name) DO UPDATE SET liked = excluded.liked`, f["id"], id, name, i64(lk)); err != nil {
				return nil, err
			}
		}
		return nil, nil
	}
	rt.staff("GET /dish-ratings", "staff", func(c *C) error {
		days := c.kdsDays(30, 7, 365)
		rows, err := c.All(`SELECT name, SUM(liked) up, COUNT(*) n FROM dish_ratings WHERE at >= ? GROUP BY name ORDER BY n DESC, name`, c.kdsSince(days))
		if err != nil {
			return err
		}
		out := []M{}
		for _, r := range rows {
			up, n := i64(r["up"]), i64(r["n"])
			out = append(out, M{"name": r["name"], "up": up, "down": n - up, "n": n, "pct": roundJS(float64(up) / float64(n) * 100)})
		}
		return c.JSON(M{"days": days, "dishes": out})
	})

	/* ===== who made it: speed and remakes per cook ===== */
	rt.staff("GET /cook-stats", "manager", func(c *C) error {
		days := c.kdsDays(7, 1, 90)
		since := c.kdsSince(days)
		items, err := c.All(`SELECT oi.done_by, u.name, oi.qty, (julianday(oi.done_at) - julianday(COALESCE(oi.fired_at, o.sent_at))) * 1440 m FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN users u ON u.id = oi.done_by WHERE oi.done_at >= ? AND oi.done_by IS NOT NULL ORDER BY oi.id`, since)
		if err != nil {
			return err
		}
		rmRows, err := c.All(`SELECT oi.done_by u, COUNT(*) n FROM remakes r JOIN order_items oi ON oi.id = r.order_item_id WHERE r.at >= ? AND oi.done_by IS NOT NULL GROUP BY oi.done_by`, since)
		if err != nil {
			return err
		}
		rm := map[int64]int64{}
		for _, r := range rmRows {
			rm[i64(r["u"])] = i64(r["n"])
		}
		type agg struct {
			id       int64
			name     any
			items, n int64
			minutes  float64
		}
		by := map[int64]*agg{}
		order := []*agg{}
		for _, i := range items {
			m := f64(i["m"])
			if m < 0 || m > 240 {
				continue
			}
			id := i64(i["done_by"])
			x := by[id]
			if x == nil {
				x = &agg{id: id, name: i["name"]}
				by[id] = x
				order = append(order, x)
			}
			x.items += i64(i["qty"])
			x.minutes += m
			x.n++
		}
		cooks := []M{}
		for _, x := range order {
			cooks = append(cooks, M{"userId": x.id, "name": x.name, "items": x.items, "avgMinutes": kdsR1(x.minutes / float64(x.n)), "remakes": rm[x.id], "remakePct": kdsR1(float64(rm[x.id]) / float64(x.n) * 100)})
		}
		sort.SliceStable(cooks, func(a, b int) bool { return i64(cooks[a]["items"]) > i64(cooks[b]["items"]) })
		return c.JSON(M{"days": days, "cooks": cooks})
	})

	/* ===== schedules by area: sales per area per weekday hour ===== */
	a.G["areaSalesByDow"] = func(c *C, args ...any) (any, error) {
		if len(args) < 3 {
			return nil, nil
		}
		list := c.kdsStationList()
		mp := c.kdsStationMap()
		out := map[string][][]int64{}
		for _, ar := range list {
			grid := make([][]int64, 7)
			for d := range grid {
				grid[d] = make([]int64, 24)
			}
			out[ar] = grid
		}
		off := kdsJS(args[1])
		rows, err := c.All(`SELECT substr(datetime(o.paid_at, '`+off+` minutes'),1,10) d, CAST(substr(datetime(o.paid_at, '`+off+` minutes'),12,2) AS INTEGER) hr, oi.qty * oi.price_cents c, m.category, m.station FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN menu_items m ON m.id = oi.item_id WHERE o.paid_at >= ? AND o.status <> 'void'`, args[0])
		if err != nil {
			return nil, err
		}
		today := kdsJS(args[2])
		for _, r := range rows {
			d := str(r["d"])
			if d >= today {
				continue
			}
			t, err := time.Parse("2006-01-02", d)
			hr := i64(r["hr"])
			if err != nil || hr < 0 || hr > 23 {
				continue
			}
			out[kdsStationFor(r, list, mp)][int(t.Weekday())][hr] += i64(r["c"])
		}
		return out, nil
	}
}

var _ = http.StatusOK
var _ store.Row

func passDist(a, b, c, d float64) float64 {
	const R = 6371000.0
	r := math.Pi / 180
	x := math.Pow(math.Sin((c-a)*r/2), 2) + math.Cos(a*r)*math.Cos(c*r)*math.Pow(math.Sin((d-b)*r/2), 2)
	return 2 * R * math.Asin(math.Sqrt(x))
}
