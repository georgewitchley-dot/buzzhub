package server

// Port of server/src/line.js: recipe cards / 86 / remakes / temperatures from the area screens,
// smart pickup times and rush mode, shift pulse, labor by area, tip-out at clock-out.

import (
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

func init() { modules = append(modules, (*App).registerLine) }

var lineRemakeReasons = []string{"Wrong order", "Cooked wrong", "Dropped", "Sent back", "Allergy", "Took too long", "Other"}

const lineFOH = "Front of house"

var (
	lineLastMu    sync.Mutex
	lineLastLevel = map[string]string{}
)

// lineKitchenPace: average ticket minutes over the last 3 hours and tickets cooking now.
func (c *C) lineKitchenPace() (M, error) {
	rows, err := c.All(`SELECT sent_at, ready_at FROM orders WHERE ready_at >= datetime('now','-3 hours') AND sent_at IS NOT NULL AND ready_at > sent_at AND status <> 'void'`)
	if err != nil {
		return nil, err
	}
	mins := []float64{}
	for _, r := range rows {
		if m := (kdsMs(r["ready_at"]) - kdsMs(r["sent_at"])) / 60000; m <= 120 {
			mins = append(mins, m)
		}
	}
	var avg any
	if len(mins) >= 3 {
		t := 0.0
		for _, m := range mins {
			t += m
		}
		avg = t / float64(len(mins))
	}
	cooking, err := c.N(`SELECT COUNT(*) c FROM orders WHERE status IN ('open','sent')`)
	if err != nil {
		return nil, err
	}
	late := kdsSetNum(c.S()["kds_late_minutes"], 12)
	lateNow, err := c.N(`SELECT COUNT(*) c FROM orders WHERE status IN ('open','sent') AND sent_at < datetime('now', ?)`, "-"+kdsJS(late)+" minutes")
	if err != nil {
		return nil, err
	}
	return M{"avgTicket": avg, "cooking": cooking, "lateNow": lateNow, "samples": len(mins)}, nil
}

// lineRushState: normal, busy (longer quotes) or paused (no online orders), automatic or by hand.
func (c *C) lineRushState() (M, error) {
	s := c.S()
	p, err := c.lineKitchenPace()
	if err != nil {
		return nil, err
	}
	with := func(m M) M {
		for k, v := range p {
			m[k] = v
		}
		return m
	}
	if s["online_paused_until"] != "" && s["online_paused_until"] > kdsNowSQL() {
		return with(M{"level": "paused", "manual": true, "until": s["online_paused_until"], "reason": "Paused by staff"}), nil
	}
	if s["rush_mode"] != "auto" {
		return with(M{"level": "normal"}), nil
	}
	cooking, lateNow := float64(i64(p["cooking"])), float64(i64(p["lateNow"]))
	reason := fmt.Sprintf("%d tickets cooking, %d late", i64(p["cooking"]), i64(p["lateNow"]))
	if cooking >= kdsSetNum(s["rush_pause_tickets"], 25) || lateNow >= kdsSetNum(s["rush_pause_late"], 8) {
		return with(M{"level": "paused", "reason": reason}), nil
	}
	if cooking >= kdsSetNum(s["rush_busy_tickets"], 12) || lateNow >= kdsSetNum(s["rush_busy_late"], 3) {
		return with(M{"level": "busy", "reason": reason}), nil
	}
	return with(M{"level": "normal"}), nil
}

// lineQuoteMinutes: minutes to promise an online customer.
func (c *C) lineQuoteMinutes() (M, error) {
	s := c.S()
	prep := kdsNumOr(s["online_prep_minutes"], 15)
	p, err := c.lineKitchenPace()
	if err != nil {
		return nil, err
	}
	rush, err := c.lineRushState()
	if err != nil {
		return nil, err
	}
	cooking := float64(i64(p["cooking"]))
	smart := s["smart_quotes"] == "1" && p["avgTicket"] != nil
	var m float64
	if smart {
		avg := p["avgTicket"].(float64)
		parallel := math.Max(1, kdsNumOr(s["kitchen_parallel"], 4))
		m = math.Max(prep*0.6, avg+math.Max(0, cooking-parallel)/parallel*avg*0.6)
	} else {
		m = prep + math.Min(30, cooking*2)
	}
	if rush["level"] == "busy" {
		m += kdsSetNum(s["rush_extra_minutes"], 15)
	}
	return M{"minutes": kdsOut(math.Min(180, math.Max(5, float64(roundJS(m/5)*5)))), "rush": rush["level"], "smart": smart}, nil
}

// lineShiftTipout: one shift's tip-out from the rules, for the person clocking out.
func (c *C) lineShiftTipout(userID any, shift store.Row) (any, error) {
	rules := []map[string]any{}
	for _, r := range kdsList(kdsPJ(c.S()["tipout_rules"], []any{})) {
		if m, ok := r.(map[string]any); ok && truthy(m["from"]) && truthy(m["to"]) && kdsNum(m["pct"]) > 0 {
			rules = append(rules, m)
		}
	}
	u, err := c.One(`SELECT tip_role FROM users WHERE id = ?`, userID)
	if err != nil {
		return nil, err
	}
	if u == nil || !truthy(u["tip_role"]) || shift == nil {
		return nil, nil
	}
	mine := []map[string]any{}
	for _, r := range rules {
		if r["from"] == u["tip_role"] {
			mine = append(mine, r)
		}
	}
	if len(mine) == 0 {
		return nil, nil
	}
	end := shift["clock_out"]
	if !truthy(end) {
		end = kdsNowSQL()
	}
	t, err := c.Get(`SELECT COALESCE(SUM(subtotal_cents - discount_cents),0) s, COALESCE(SUM(tip_cents),0) t FROM orders WHERE created_by = ? AND paid_at >= ? AND paid_at <= ? AND status <> 'void'`, userID, shift["clock_in"], end)
	if err != nil {
		return nil, err
	}
	tips := i64(t["t"]) + i64(shift["declared_tips_cents"])
	lines := []M{}
	var total int64
	for _, r := range mine {
		base := float64(i64(t["s"]))
		if r["base"] == "tips" {
			base = float64(tips)
		}
		cents := roundJS(base * kdsNum(r["pct"]) / 100)
		if cents <= 0 {
			continue
		}
		l := M{"to": r["to"], "pct": kdsNum(r["pct"]), "cents": cents}
		if v, ok := r["base"]; ok {
			l["base"] = v
		}
		lines = append(lines, l)
		total += cents
	}
	return M{"salesCents": t["s"], "tipsCents": tips, "lines": lines, "totalCents": total}, nil
}

func (c *C) lineLastShift(userID any) (store.Row, error) {
	return c.One(`SELECT * FROM shifts WHERE user_id = ? AND clock_out IS NOT NULL ORDER BY clock_out DESC LIMIT 1`, userID)
}

// lineUserArg reads a user passed to a hook (*auth.User or a row).
func lineUserArg(v any) *auth.User {
	switch u := v.(type) {
	case *auth.User:
		return u
	case map[string]any:
		return &auth.User{ID: i64(u["id"]), Name: str(u["name"]), Role: str(u["role"])}
	}
	return nil
}

func (c *C) lineAddPulse(user *auth.User, rating int64, note string) error {
	if c.S()["shift_pulse"] != "1" || user == nil {
		return nil
	}
	sh, err := c.One(`SELECT id FROM shifts WHERE user_id = ? AND clock_out IS NOT NULL ORDER BY clock_out DESC LIMIT 1`, user.ID)
	if err != nil {
		return err
	}
	var shID any
	if sh != nil {
		shID = orNil(sh["id"])
	}
	n := []rune(strings.TrimSpace(note))
	if len(n) > 300 {
		n = n[:300]
	}
	if _, err := c.Run(`INSERT INTO shift_pulse (user_id, shift_id, rating, note) VALUES (?,?,?,?)`, user.ID, shID, rating, orNil(string(n))); err != nil {
		return err
	}
	if rating <= 1 {
		body := fmt.Sprintf("Someone rated their shift %d/4", rating)
		if note != "" {
			body += ": " + note
		}
		c.a.pushToUsers(c.Ctx, c.Tx, []string{"manager", "owner"}, M{"title": "A rough shift", "body": body + ".", "tag": "pulse", "url": "/shifts"}, 0)
	}
	c.Notify("pulse")
	return nil
}

func (c *C) linePause(minutes int64, who *auth.User) error {
	until := ""
	if minutes > 0 {
		until = time.Now().UTC().Add(time.Duration(minutes) * time.Minute).Format("2006-01-02 15:04:05")
	}
	if err := c.Tx.SetSettings(c.Ctx, map[string]string{"online_paused_until": until}); err != nil {
		return err
	}
	c.Refresh()
	action, detail := "online.resume", ""
	if minutes > 0 {
		action, detail = "online.pause", fmt.Sprintf("%d min", minutes)
	}
	if err := c.AuditAs(who, action, detail, c.IP()); err != nil {
		return err
	}
	c.Notify("rush")
	return nil
}

func (a *App) registerLine(rt *router) {
	who := func(c *C) (*kdsWhoT, error) { return c.kdsWho(false) }

	/* ===== recipe cards on area screens ===== */
	rt.pub("GET /api/kds/card/{id}", func(c *C) error {
		if _, err := who(c); err != nil {
			return err
		}
		m, err := c.One(`SELECT * FROM menu_items WHERE id = ?`, c.kdsPID("id"))
		if err != nil {
			return err
		}
		if m == nil {
			return notFound("Not found")
		}
		recipe, err := c.All(`SELECT g.name, r.qty, g.unit FROM item_recipes r JOIN ingredients g ON g.id = r.ingredient_id WHERE r.item_id = ? ORDER BY g.name`, m["id"])
		if err != nil {
			return err
		}
		has, err := c.One(`SELECT 1 FROM assets WHERE key = ?`, "item:"+kdsJS(m["id"]))
		if err != nil {
			return err
		}
		var photo any
		if has != nil {
			photo = "/api/kds/card/" + kdsJS(m["id"]) + "/photo"
		}
		return c.JSON(M{"id": m["id"], "name": m["name"], "category": m["category"], "description": m["description"], "cookMinutes": m["cook_minutes"],
			"allergens": kdsPJ(m["allergens"], []any{}), "steps": kdsPJ(m["build_steps"], []any{}), "recipe": recipe, "photo": photo})
	})
	rt.pub("GET /api/kds/card/{id}/photo", func(c *C) error {
		// the <img> can't send headers, so the screen passes its token in the query
		if t := c.Q("t"); t != "" {
			c.R.Header.Set("X-Kds", t)
		}
		if _, err := who(c); err != nil {
			return err
		}
		var mime string
		var data []byte
		if err := c.Tx.QueryRow(c.Ctx, `SELECT mime, data FROM assets WHERE key = $1`, "item:"+kdsJS(kdsNum(c.Param("id")))).Scan(&mime, &data); err != nil {
			c.W.WriteHeader(http.StatusNotFound)
			return nil
		}
		c.W.Header().Set("Content-Type", mime)
		c.W.Header().Set("Cache-Control", "private, max-age=3600")
		_, _ = c.W.Write(data)
		return nil
	})

	/* ===== 86 from the line ===== */
	rt.pub("GET /api/kds/menu", func(c *C) error {
		w, err := who(c)
		if err != nil {
			return err
		}
		list := c.kdsStationList()
		mp := c.kdsStationMap()
		rows, err := c.All(`SELECT id, name, category, station, stock, active FROM menu_items WHERE active = 1 ORDER BY category NULLS FIRST, name`)
		if err != nil {
			return err
		}
		out := []M{}
		for _, i := range rows {
			if w.area == kdsAll || w.area == kdsExpo || w.area == kdsPack || kdsStationFor(i, list, mp) == w.area {
				out = append(out, M{"id": i["id"], "name": i["name"], "category": i["category"], "out": i["stock"] != nil && f64(i["stock"]) <= 0, "stock": i["stock"]})
			}
		}
		return c.JSON(out)
	})
	rt.pub("POST /api/kds/86", func(c *C) error {
		w, err := who(c)
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Ordered("itemId", valid.Int(), "out", valid.Bool()))
		if err != nil {
			return err
		}
		m, err := c.One(`SELECT * FROM menu_items WHERE id = ?`, b["itemId"])
		if err != nil {
			return err
		}
		if m == nil {
			return notFound("Not found")
		}
		out := b["out"] == true
		if out {
			_, err = c.Run(`UPDATE menu_items SET stock = 0 WHERE id = ?`, m["id"])
		} else {
			_, err = c.Run(`UPDATE menu_items SET stock = NULL WHERE id = ? AND (stock IS NULL OR stock <= 0)`, m["id"])
		}
		if err != nil {
			return err
		}
		reason, action := "back on from "+w.area, "item.back"
		if out {
			reason, action = "86 from "+w.area, "item.86"
		}
		var uid any
		if w.user != nil {
			uid = w.user.ID
		}
		if _, err := c.Run(`INSERT INTO stock_moves (item_id, delta, reason, user_id) VALUES (?, 0, ?, ?)`, m["id"], reason, uid); err != nil {
			return err
		}
		if err := c.AuditAs(w.user, action, fmt.Sprintf("%s (%s)", str(m["name"]), w.label()), c.IP()); err != nil {
			return err
		}
		c.Notify("menu")
		if out {
			c.a.pushToUsers(c.Ctx, c.Tx, []string{"staff", "manager", "owner"}, M{"title": "86 " + str(m["name"]), "body": fmt.Sprintf("%s marked %s sold out.", w.label(), str(m["name"])), "tag": "86-" + kdsJS(m["id"]), "url": "/menu"}, 0)
		}
		return c.OK()
	})

	/* ===== remakes ===== */
	reasons := make([]string, len(lineRemakeReasons))
	copy(reasons, lineRemakeReasons)
	rt.pub("POST /api/kds/remake", func(c *C) error {
		w, err := who(c)
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Ordered("orderItemId", valid.Int(), "qty", valid.Int().Min(1).Max(50).Optional(), "reason", valid.Enum(reasons...)))
		if err != nil {
			return err
		}
		oi, err := c.One(`SELECT oi.*, m.category, m.station FROM order_items oi LEFT JOIN menu_items m ON m.id = oi.item_id WHERE oi.id = ?`, b["orderItemId"])
		if err != nil {
			return err
		}
		if oi == nil {
			return notFound("Item not found")
		}
		o, err := c.One(`SELECT * FROM orders WHERE id = ?`, oi["order_id"])
		if err != nil {
			return err
		}
		if o == nil || str(o["status"]) == "void" {
			return notFound("Order not found")
		}
		qty := i64(oi["qty"])
		if truthy(b["qty"]) {
			qty = i64(b["qty"])
		}
		if qty > 50 {
			qty = 50
		}
		area := c.kdsStationOf(oi)
		itemID := oi["item_id"]
		if !truthy(itemID) {
			itemID = int64(0)
		}
		rc, err := c.Val(`SELECT SUM(r.qty * g.cost_cents) c FROM item_recipes r JOIN ingredients g ON g.id = r.ingredient_id WHERE r.item_id = ?`, itemID)
		if err != nil {
			return err
		}
		unit := f64(rc)
		if unit == 0 {
			unit = f64(oi["price_cents"]) * kdsNumOr(c.S()["food_cost_target"], 30) / 100
		}
		cost := roundJS(unit * float64(qty))
		reason := str(b["reason"])
		if _, err := c.Run(`INSERT INTO order_items (order_id, item_id, name, qty, price_cents, note, mods, course, fired_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, datetime('now'))`, o["id"], oi["item_id"], oi["name"], qty, "REMAKE: "+reason, oi["mods"], 1); err != nil {
			return err
		}
		if _, err := c.Run(`INSERT INTO remakes (order_id, order_item_id, item_id, name, qty, reason, area, cost_cents, by_label) VALUES (?,?,?,?,?,?,?,?,?)`, o["id"], oi["id"], oi["item_id"], oi["name"], qty, reason, area, cost, w.label()); err != nil {
			return err
		}
		if (kdsStatusIn(o, "ready", "paid") && !truthy(o["paid_at"])) || str(o["status"]) == "ready" {
			if _, err := c.Run(`UPDATE orders SET status = 'sent', ready_at = NULL WHERE id = ?`, o["id"]); err != nil {
				return err
			}
		}
		if err := c.AuditAs(w.user, "kds.remake", fmt.Sprintf("#%s %d %s: %s (%s)", kdsJS(o["number"]), qty, str(oi["name"]), reason, w.label()), c.IP()); err != nil {
			return err
		}
		c.Notify("orders")
		return c.JSON(M{"ok": true, "area": area})
	})
	rt.pub("GET /api/kds/remake-reasons", func(c *C) error {
		if _, err := who(c); err != nil {
			return err
		}
		return c.JSON(lineRemakeReasons)
	})
	rt.staff("GET /remakes", "manager", func(c *C) error {
		days := c.kdsDays(7, 1, 90)
		rows, err := c.All(`SELECT r.*, o.number FROM remakes r JOIN orders o ON o.id = r.order_id WHERE r.at >= ? ORDER BY r.at DESC, r.id DESC`, c.kdsSince(days))
		if err != nil {
			return err
		}
		by := func(k string) []M {
			idx := map[string]M{}
			out := []M{}
			for _, r := range rows {
				key := kdsJS(r[k])
				if !truthy(r[k]) {
					key = "Unknown"
				}
				a := idx[key]
				if a == nil {
					a = M{"key": key, "count": int64(0), "qty": int64(0), "costCents": int64(0)}
					idx[key] = a
					out = append(out, a)
				}
				a["count"] = i64(a["count"]) + 1
				a["qty"] = i64(a["qty"]) + i64(r["qty"])
				a["costCents"] = i64(a["costCents"]) + i64(r["cost_cents"])
			}
			sort.SliceStable(out, func(x, y int) bool { return i64(out[x]["count"]) > i64(out[y]["count"]) })
			return out
		}
		var cost int64
		for _, r := range rows {
			cost += i64(r["cost_cents"])
		}
		byDish := by("name")
		if len(byDish) > 10 {
			byDish = byDish[:10]
		}
		recent := rows
		if len(recent) > 20 {
			recent = recent[:20]
		}
		return c.JSON(M{"days": days, "total": len(rows), "costCents": cost, "byReason": by("reason"), "byDish": byDish, "byArea": by("area"), "recent": recent})
	})

	/* ===== temperatures on area screens ===== */
	rt.pub("GET /api/kds/temps", func(c *C) error {
		w, err := who(c)
		if err != nil {
			return err
		}
		units, err := c.All(`SELECT * FROM temp_units WHERE active = 1 AND area = ? ORDER BY name`, w.area)
		if err != nil {
			return err
		}
		out := []M{}
		for _, u := range units {
			last, err := c.One(`SELECT value, ok, at FROM temp_logs WHERE unit_id = ? ORDER BY id DESC LIMIT 1`, u["id"])
			if err != nil {
				return err
			}
			var l any
			if last != nil {
				l = last
			}
			out = append(out, M{"id": u["id"], "name": u["name"], "min": u["min_temp"], "max": u["max_temp"], "scale": u["scale"], "last": l})
		}
		return c.JSON(out)
	})
	rt.pub("POST /api/kds/temps/{unitId}", func(c *C) error {
		w, err := who(c)
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Ordered("value", valid.Number().Min(-60).Max(250), "corrective", valid.String().Trim().Max(200).Optional(), "by", valid.String().Trim().Max(30).Optional()))
		if err != nil {
			return err
		}
		u, err := c.One(`SELECT * FROM temp_units WHERE id = ? AND active = 1 AND area = ?`, c.kdsPID("unitId"), w.area)
		if err != nil {
			return err
		}
		if u == nil {
			return notFound("Not found")
		}
		v := f64(b["value"])
		ok := v >= f64(u["min_temp"]) && v <= f64(u["max_temp"])
		val, sc, mn, mx := kdsJS(b["value"]), kdsJS(u["scale"]), kdsJS(u["min_temp"]), kdsJS(u["max_temp"])
		if !ok && !truthy(b["corrective"]) {
			return failX(http.StatusConflict, fmt.Sprintf("%s°%s is outside %s–%s°%s. Say what you did about it.", val, sc, mn, mx, sc), M{"needsCorrective": true})
		}
		var note, uid any
		if w.user == nil {
			n := w.area + " screen"
			if truthy(b["by"]) {
				n = str(b["by"]) + ", " + n
			}
			note = n
		} else {
			uid = w.user.ID
		}
		okN := 0
		if ok {
			okN = 1
		}
		if _, err := c.Run(`INSERT INTO temp_logs (unit_id, value, ok, note, corrective, user_id) VALUES (?,?,?,?,?,?)`, u["id"], b["value"], okN, note, orNil(b["corrective"]), uid); err != nil {
			return err
		}
		if !ok {
			c.a.pushToUsers(c.Ctx, c.Tx, []string{"manager", "owner"}, M{"title": c.S()["business_name"] + ": " + str(u["name"]) + " out of range",
				"body": fmt.Sprintf("%s logged %s°%s (should be %s–%s). Action: %s", w.label(), val, sc, mn, mx, str(b["corrective"])), "tag": "house", "url": "/checklists"}, 0)
		}
		flag := ""
		if !ok {
			flag = " OUT OF RANGE"
		}
		if err := c.AuditAs(w.user, "temp.log", fmt.Sprintf("%s %s°%s%s (%s)", str(u["name"]), val, sc, flag, w.label()), c.IP()); err != nil {
			return err
		}
		c.Notify("checklists")
		return c.JSON(M{"ok": true, "inRange": ok})
	})
	areaSchema := func() *valid.ObjectS {
		return valid.Object(map[string]valid.Schema{"area": valid.String().Max(24).Nullable()})
	}
	rt.staff("PUT /temp-units/{id}/area", "manager", func(c *C) error {
		b, err := c.Body(areaSchema())
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE temp_units SET area = ? WHERE id = ?`, orNil(b["area"]), c.kdsPID("id")); err != nil {
			return err
		}
		c.Notify("checklists")
		return c.OK()
	})

	/* ===== smart pickup times + rush mode ===== */
	a.G["quoteMinutes"] = func(c *C, args ...any) (any, error) { return c.lineQuoteMinutes() }
	a.G["rushState"] = func(c *C, args ...any) (any, error) { return c.lineRushState() }
	pauseSchema := func() *valid.ObjectS {
		return valid.Object(map[string]valid.Schema{"minutes": valid.Int().Min(0).Max(240)})
	}
	rt.staff("GET /rush", "staff", func(c *C) error {
		r, err := c.lineRushState()
		if err != nil {
			return err
		}
		if r["quote"], err = c.lineQuoteMinutes(); err != nil {
			return err
		}
		return c.JSON(r)
	})
	pauseAnswer := func(c *C, user *auth.User) error {
		b, err := c.Body(pauseSchema())
		if err != nil {
			return err
		}
		if err := c.linePause(i64(b["minutes"]), user); err != nil {
			return err
		}
		r, err := c.lineRushState()
		if err != nil {
			return err
		}
		r["ok"] = true
		return c.JSON(r)
	}
	rt.staff("POST /rush/pause", "staff", func(c *C) error { return pauseAnswer(c, c.U) })
	rt.pub("POST /api/kds/pause", func(c *C) error {
		w, err := who(c)
		if err != nil {
			return err
		}
		return pauseAnswer(c, w.user)
	})
	a.every("rush-level", time.Minute, func(c *C) error {
		r, err := c.lineRushState()
		if err != nil {
			return nil
		}
		lvl := str(r["level"])
		lineLastMu.Lock()
		last := lineLastLevel[c.Slug()]
		lineLastLevel[c.Slug()] = lvl
		lineLastMu.Unlock()
		if last != "" && last != lvl && r["manual"] == nil {
			title := "Online orders paused: kitchen is behind"
			if lvl == "normal" {
				title = "Online orders back to normal"
			} else if lvl == "busy" {
				title = "Kitchen is busy: pickup times pushed back"
			}
			c.a.pushToUsers(c.Ctx, c.Tx, []string{"manager", "owner"}, M{"title": title, "body": str(r["reason"]), "tag": "rush", "url": "/kitchen"}, 0)
		}
		return nil
	})

	/* ===== shift pulse ===== */
	a.G["addPulse"] = func(c *C, args ...any) (any, error) {
		if len(args) < 2 {
			return nil, nil
		}
		note := ""
		if len(args) > 2 {
			note = str(args[2])
		}
		return nil, c.lineAddPulse(lineUserArg(args[0]), i64(args[1]), note)
	}
	rt.staff("POST /me/pulse", "staff", func(c *C) error {
		b, err := c.Body(valid.Ordered("rating", valid.Int().Min(1).Max(4), "note", valid.String().Max(300).Optional()))
		if err != nil {
			return err
		}
		if err := c.lineAddPulse(c.U, i64(b["rating"]), str(b["note"])); err != nil {
			return err
		}
		return c.OK()
	})
	rt.staff("GET /pulse", "manager", func(c *C) error {
		days := c.kdsDays(14, 7, 90)
		anon := c.S()["pulse_anonymous"] != "0"
		rows, err := c.All(`SELECT p.*, u.name FROM shift_pulse p JOIN users u ON u.id = p.user_id WHERE p.at >= ? ORDER BY p.at DESC, p.id DESC`, c.kdsSince(days))
		if err != nil {
			return err
		}
		tz := c.kdsTZ()
		type dayAgg struct {
			day    string
			n, sum int64
		}
		dm := map[string]*dayAgg{}
		dl := []*dayAgg{}
		counts := []int64{0, 0, 0, 0}
		var sum int64
		notes := []M{}
		for _, r := range rows {
			d := time.UnixMilli(int64(kdsMs(r["at"]))).In(tz).Format("2006-01-02")
			x := dm[d]
			if x == nil {
				x = &dayAgg{day: d}
				dm[d] = x
				dl = append(dl, x)
			}
			x.n++
			x.sum += i64(r["rating"])
			sum += i64(r["rating"])
			if k := i64(r["rating"]); k >= 1 && k <= 4 {
				counts[k-1]++
			}
			if truthy(r["note"]) && len(notes) < 15 {
				var name any
				if !anon {
					name = r["name"]
				}
				notes = append(notes, M{"rating": r["rating"], "note": r["note"], "at": r["at"], "name": name})
			}
		}
		sort.SliceStable(dl, func(a, b int) bool { return dl[a].day < dl[b].day })
		byDay := []M{}
		for _, d := range dl {
			byDay = append(byDay, M{"day": d.day, "n": d.n, "avg": kdsR1(float64(d.sum) / float64(d.n))})
		}
		var avg any
		if len(rows) > 0 {
			avg = kdsR1(float64(sum) / float64(len(rows)))
		}
		return c.JSON(M{"days": days, "anonymous": anon, "count": len(rows), "average": avg, "byDay": byDay, "counts": counts, "notes": notes})
	})

	/* ===== labor by area ===== */
	rt.staff("PUT /users/{id}/area", "manager", func(c *C) error {
		b, err := c.Body(areaSchema())
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE users SET area = ? WHERE id = ?`, orNil(b["area"]), c.kdsPID("id")); err != nil {
			return err
		}
		return c.OK()
	})
	rt.staff("GET /labor-by-area", "owner", func(c *C) error {
		days := c.kdsDays(7, 1, 90)
		today := c.kdsLocalToday()
		from, _ := c.kdsDayBounds(kdsAddDays(today, -(days - 1)))
		_, to := c.kdsDayBounds(today)
		list := c.kdsStationList()
		mp := c.kdsStationMap()
		type agg struct {
			area         string
			hours        float64
			labor, sales int64
			people       []string
		}
		names := append(append([]string{}, list...), lineFOH)
		areas := map[string]*agg{}
		order := []*agg{}
		for _, x := range names {
			if areas[x] == nil {
				g := &agg{area: x, people: []string{}}
				areas[x] = g
				order = append(order, g)
			}
		}
		shifts, err := c.All(`SELECT s.*, u.area, u.hourly_cents, u.name FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_in < ? AND COALESCE(s.clock_out, ?) > ? ORDER BY s.id`, to, to, from)
		if err != nil {
			return err
		}
		for _, s := range shifts {
			st := str(s["clock_in"])
			if st < from {
				st = from
			}
			en := str(s["clock_out"])
			if !truthy(s["clock_out"]) || en > to {
				en = kdsNowSQL()
			}
			hrs := math.Max(0, (kdsMs(en)-kdsMs(st))/3600000-f64(s["break_minutes"])/60)
			key := lineFOH
			if a := str(s["area"]); a != "" && areas[a] != nil {
				key = a
			}
			x := areas[key]
			x.hours += hrs
			x.labor += roundJS(hrs * f64(s["hourly_cents"]))
			if n := str(s["name"]); !kdsHas(x.people, n) {
				x.people = append(x.people, n)
			}
		}
		var total int64
		items, err := c.All(`SELECT oi.qty, oi.price_cents, m.category, m.station FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN menu_items m ON m.id = oi.item_id WHERE o.paid_at >= ? AND o.paid_at < ? AND o.status <> 'void'`, from, to)
		if err != nil {
			return err
		}
		for _, i := range items {
			cc := i64(i["qty"]) * i64(i["price_cents"])
			total += cc
			if x := areas[kdsStationFor(i, list, mp)]; x != nil {
				x.sales += cc
			}
		}
		areas[lineFOH].sales = total
		rows := []M{}
		var labor int64
		for _, x := range order {
			var p any
			if x.sales != 0 {
				p = float64(roundJS(float64(x.labor)/float64(x.sales)*1000)) / 10
			}
			rows = append(rows, M{"area": x.area, "hours": kdsR1(x.hours), "laborCents": x.labor, "salesCents": x.sales, "pct": p, "people": x.people})
			labor += x.labor
		}
		team, err := c.All(`SELECT id, name, area, tip_role FROM users WHERE active = 1 ORDER BY name`)
		if err != nil {
			return err
		}
		return c.JSON(M{"days": days, "areas": rows, "totalSalesCents": total, "totalLaborCents": labor, "team": team, "choices": names})
	})

	/* ===== tip-out at clock-out ===== */
	a.G["shiftTipout"] = func(c *C, args ...any) (any, error) {
		if c.S()["tipout_at_clockout"] == "0" || len(args) == 0 {
			return nil, nil
		}
		sh, err := c.lineLastShift(args[0])
		if err != nil {
			return nil, err
		}
		return c.lineShiftTipout(args[0], sh)
	}
}
