package server

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// Port of care.js (round 23): seat history, allergy hand-off, saved table combos, prep learns
// from waste, driver checkout, remake alerts, VIP profile, pacing by party size.

func init() { modules = append(modules, (*App).registerCare) }

// careMs parses a SQLite UTC timestamp to milliseconds (NaN-free: 0 when unparseable).
func careMs(v any) (float64, bool) {
	t, err := time.Parse("2006-01-02T15:04:05", strings.Replace(str(v), " ", "T", 1))
	if err != nil {
		t, err = time.Parse("2006-01-02T15:04", strings.Replace(str(v), " ", "T", 1))
		if err != nil {
			return 0, false
		}
	}
	return float64(t.UnixMilli()), true
}

func careBucket(n int64) string {
	switch {
	case n <= 2:
		return "1-2"
	case n <= 4:
		return "3-4"
	case n <= 8:
		return "5-8"
	}
	return "9+"
}

func careList(v any, def string) []any {
	s := str(v)
	if s == "" {
		s = def
	}
	return deskJList(s)
}

// allergyHandoff marks an order's allergy as handed over to the server.
func (c *C) careAllergyHandoff(orderID int64, by string) (store.Row, error) {
	o, err := c.One(`SELECT * FROM orders WHERE id = ?`, orderID)
	if err != nil {
		return nil, err
	}
	if o == nil {
		return nil, notFound("Not found")
	}
	if !truthy(o["allergy_note"]) {
		return nil, conflict("This order has no allergy")
	}
	who := by
	if who == "" {
		who = "Unknown"
	}
	if _, err := c.Run(`UPDATE orders SET allergy_handed_by = ?, allergy_handed_at = datetime('now') WHERE id = ?`, who, o["id"]); err != nil {
		return nil, err
	}
	lower := by
	if lower == "" {
		lower = "unknown"
	}
	if err := c.AuditAs(nil, "allergy.handoff", fmt.Sprintf("#%v: %s handed over by %s", o["number"], str(o["allergy_note"]), lower), ""); err != nil {
		return nil, err
	}
	c.Notify("orders")
	return o, nil
}

func (c *C) careComboOut(cb store.Row) (M, error) {
	ids := deskJList(cb["table_ids"])
	tables := []store.Row{}
	if len(ids) > 0 {
		parts := make([]string, len(ids))
		for i, x := range ids {
			parts[i] = fmt.Sprint(int64(valid.ToFloat(x)))
		}
		var err error
		if tables, err = c.All(`SELECT id, label, seats FROM tables WHERE id IN (` + strings.Join(parts, ",") + `)`); err != nil {
			return nil, err
		}
	}
	labels := []any{}
	for _, x := range ids {
		for _, t := range tables {
			if float64(i64(t["id"])) == valid.ToFloat(x) {
				if truthy(t["label"]) {
					labels = append(labels, t["label"])
				}
				break
			}
		}
	}
	var seats int64
	for _, t := range tables {
		if n := i64(t["seats"]); n != 0 {
			seats += n
		} else {
			seats += 4
		}
	}
	return M{"id": cb["id"], "name": cb["name"], "tableIds": ids, "labels": labels, "seats": seats}, nil
}

// careJoinCombo joins a saved combo onto its first table, skipping busy tables.
func (c *C) careJoinCombo(comboID any, user *auth.User) ([]any, error) {
	joined := []any{}
	cb, err := c.One(`SELECT * FROM table_combos WHERE id = ?`, comboID)
	if err != nil || cb == nil {
		return joined, err
	}
	ids := deskJList(cb["table_ids"])
	if len(ids) == 0 {
		return joined, nil
	}
	main, err := c.One(`SELECT * FROM tables WHERE id = ?`, int64(valid.ToFloat(ids[0])))
	if err != nil || main == nil {
		return joined, err
	}
	gid := int64(-1)
	if truthy(main["guest_id"]) {
		gid = i64(main["guest_id"])
	}
	for _, x := range ids[1:] {
		t, err := c.One(`SELECT * FROM tables WHERE id = ? AND joined_to IS NULL AND (status = 'open' OR guest_id = ?) AND id NOT IN (SELECT table_id FROM orders WHERE table_id IS NOT NULL AND paid_at IS NULL AND status <> 'void')`, int64(valid.ToFloat(x)), gid)
		if err != nil {
			return nil, err
		}
		if t == nil {
			continue
		}
		if _, err := c.Run(`UPDATE tables SET joined_to = ?, status = 'seated', guest_id = ? WHERE id = ?`, main["id"], main["guest_id"], t["id"]); err != nil {
			return nil, err
		}
		joined = append(joined, t["label"])
	}
	if len(joined) > 0 {
		names := make([]string, len(joined))
		for i, l := range joined {
			names[i] = str(l)
		}
		if err := c.AuditAs(user, "table.combo_join", fmt.Sprintf("%s: %s %s + %s", str(cb["name"]), c.S()["unit_label"], str(main["label"]), strings.Join(names, ", ")), ""); err != nil {
			return nil, err
		}
		c.Notify("tables")
	}
	return joined, nil
}

// careWasteAdjust trims prep forecasts by what was thrown away as over-prepped on this weekday.
func (c *C) careWasteAdjust(items []M) ([]M, error) {
	if c.S()["prep_learn"] == "0" {
		return items, nil
	}
	d := deskDowOf(c.deskToday())
	rows, err := c.All(`SELECT item_id, qty, at FROM waste_log WHERE reason = 'over-prepped' AND item_id IS NOT NULL AND at > datetime('now','-29 days')`)
	if err != nil {
		return nil, err
	}
	left := map[int64]float64{}
	for _, r := range rows {
		ms, ok := careMs(r["at"])
		if !ok || int(time.UnixMilli(int64(ms)-5*3600_000).UTC().Weekday()) != d {
			continue
		}
		left[i64(r["item_id"])] += f64(r["qty"])
	}
	out := make([]M, 0, len(items))
	for _, i := range items {
		avg := left[i64(i["id"])] / 4
		fc := f64(i["forecast"])
		if avg == 0 || fc == 0 {
			out = append(out, i)
			continue
		}
		cut := math.Min(float64(roundJS(avg*0.75)), math.Floor(fc*0.3))
		if cut == 0 {
			out = append(out, i)
			continue
		}
		n := M{}
		for k, v := range i {
			n[k] = v
		}
		forecast := fc - cut
		target := math.Max(forecast, f64(i["par"]))
		n["forecast"], n["wasteCut"], n["target"], n["prep"] = forecast, cut, target, math.Max(0, target-f64(i["onHand"]))
		out = append(out, n)
	}
	return out, nil
}

func (c *C) careDriverCheckout(userID any, date string) (M, error) {
	start, end := deskDayBounds(date, c.deskTZ())
	u, err := c.One(`SELECT id, name FROM users WHERE id = ?`, userID)
	if err != nil {
		return nil, err
	}
	rows, err := c.All(`SELECT number, payment_method, prepaid, total_cents, tip_cents, fee_cents, delivered_at, out_at FROM orders WHERE driver_id = ? AND delivered_at >= ? AND delivered_at < ? AND status <> 'void' ORDER BY id`, userID, start, end)
	if err != nil {
		return nil, err
	}
	// SQLite's CAST reads the leading number of the text after '$'; take the same digits here.
	door, err := c.Val(`SELECT COALESCE(SUM(CAST(NULLIF(substring(replace(substr(detail, strpos(detail, '$') + 1), ',', '') from '^[0-9]*\.?[0-9]*'), '') AS DOUBLE PRECISION)),0) d FROM audit WHERE action = 'delivery.door_tip' AND user_id = ? AND ts >= ? AND ts < ?`, userID, start, end)
	if err != nil {
		return nil, err
	}
	var cashC, cashTips, tips, fees, hand int64
	mins := []float64{}
	orders := []M{}
	for _, r := range rows {
		cash := str(r["payment_method"]) == "cash" && !truthy(r["prepaid"])
		if cash {
			cashC += i64(r["total_cents"])
			cashTips += i64(r["tip_cents"])
			hand += i64(r["total_cents"]) - i64(r["tip_cents"])
		}
		tips += i64(r["tip_cents"])
		fees += i64(r["fee_cents"])
		if truthy(r["out_at"]) {
			a, _ := careMs(r["delivered_at"])
			b, _ := careMs(r["out_at"])
			mins = append(mins, (a-b)/60000)
		}
		orders = append(orders, M{"number": r["number"], "cents": r["total_cents"], "tip": r["tip_cents"], "cash": cash})
	}
	var avg any
	if len(mins) > 0 {
		s := 0.0
		for _, m := range mins {
			s += m
		}
		avg = roundJS(s / float64(len(mins)))
	}
	var user any
	if u != nil {
		user = u
	}
	return M{"date": date, "user": user, "deliveries": len(rows), "cashCollectedCents": cashC, "cashTipsCents": cashTips, "tipsCents": tips, "doorTipsCents": roundJS(f64(door) * 100),
		"feesCents": fees, "avgMinutes": avg, "cashToHandInCents": hand, "orders": orders}, nil
}

var careGapCache sync.Map // slug -> careGaps

type careGaps struct {
	at time.Time
	by map[string]int64
}

func (c *C) carePartyGap(course int64, party int64) (any, error) {
	g, _ := careGapCache.Load(c.Slug())
	gc, _ := g.(careGaps)
	if time.Since(gc.at) > 10*time.Minute {
		rows, err := c.All(`SELECT oi.order_id, oi.course, oi.seat, oi.fired_at, oi.done_at FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.table_id IS NOT NULL AND o.created_at > datetime('now','-60 days') AND oi.course IS NOT NULL`)
		if err != nil {
			return nil, err
		}
		type cs struct{ f, d []float64 }
		type ord struct {
			seats map[int64]bool
			c     map[int64]*cs
		}
		per := map[int64]*ord{}
		order := []int64{}
		for _, r := range rows {
			id := i64(r["order_id"])
			o := per[id]
			if o == nil {
				o = &ord{map[int64]bool{}, map[int64]*cs{}}
				per[id] = o
				order = append(order, id)
			}
			if i64(r["seat"]) > 0 {
				o.seats[i64(r["seat"])] = true
			}
			k := i64(r["course"])
			x := o.c[k]
			if x == nil {
				x = &cs{}
				o.c[k] = x
			}
			if truthy(r["fired_at"]) {
				if m, ok := careMs(r["fired_at"]); ok {
					x.f = append(x.f, m)
				}
			}
			if truthy(r["done_at"]) {
				if m, ok := careMs(r["done_at"]); ok {
					x.d = append(x.d, m)
				}
			}
		}
		gaps := map[string][]float64{}
		for _, id := range order {
			o := per[id]
			n := int64(len(o.seats))
			if n == 0 {
				n = 2
			}
			b := careBucket(n)
			for k, x := range o.c {
				prev := o.c[k-1]
				if k < 2 || prev == nil || len(prev.d) == 0 || len(x.f) == 0 {
					continue
				}
				mn, mx := math.Inf(1), math.Inf(-1)
				for _, v := range x.f {
					mn = math.Min(mn, v)
				}
				for _, v := range prev.d {
					mx = math.Max(mx, v)
				}
				gap := (mn - mx) / 60000
				if gap > 0 && gap < 120 {
					key := fmt.Sprintf("%d:%s", k, b)
					gaps[key] = append(gaps[key], gap)
				}
			}
		}
		by := map[string]int64{}
		for k, l := range gaps {
			if len(l) < 3 {
				continue
			}
			sort.Float64s(l)
			by[k] = roundJS(l[len(l)/2])
		}
		gc = careGaps{time.Now(), by}
		careGapCache.Store(c.Slug(), gc)
	}
	if party == 0 {
		party = 2
	}
	if v, ok := gc.by[fmt.Sprintf("%d:%s", course, careBucket(party))]; ok {
		return v, nil
	}
	return nil, nil
}

var careAllergyTagRE = regexp.MustCompile(`(?i)allerg|free|vegan|celiac|dairy|lactose|nut|shellfish`)

func (a *App) registerCare(rt *router) {
	/* ===== 1. seat history ===== */
	rt.staff("GET /tables/{id}/seat/{seat}/history", "staff", func(c *C) error {
		tid := deskNum(c.Param("id"))
		t, err := c.One(`SELECT * FROM tables WHERE id = ?`, int64(tid))
		if err != nil {
			return err
		}
		if t == nil || math.IsNaN(tid) || tid != math.Trunc(tid) {
			return notFound("Not found")
		}
		since := t["seated_at"]
		if !truthy(since) {
			if since, err = c.Val(`SELECT datetime('now','-6 hours') d`); err != nil {
				return err
			}
		}
		seat := deskNum(c.Param("seat"))
		var rows []store.Row
		if !math.IsNaN(seat) {
			if rows, err = c.All(`SELECT oi.name, oi.qty, oi.price_cents, oi.note, oi.course, oi.fired_at, oi.done_at, oi.mods, o.number, o.created_at, o.paid_at, o.served_at
      FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.table_id = ? AND oi.seat = ? AND o.status <> 'void' AND o.created_at >= ? ORDER BY o.created_at, oi.id`, t["id"], seat, since); err != nil {
				return err
			}
		}
		var name any
		if c.Has("seatNames") {
			v, err := c.G("seatNames", t["id"])
			if err != nil {
				return err
			}
			key := c.Param("seat")
			switch m := v.(type) {
			case map[string]any:
				name = orNil(m[key])
			case map[string]string:
				name = orNil(m[key])
			case map[int64]string:
				name = orNil(m[int64(seat)])
			case map[int64]any:
				name = orNil(m[int64(seat)])
			}
		}
		items := []M{}
		var total int64
		for _, r := range rows {
			mods := []any{}
			for _, x := range careList(r["mods"], "[]") {
				if m, ok := x.(map[string]any); ok && truthy(m["name"]) {
					mods = append(mods, m["name"])
				}
			}
			state := "held"
			switch {
			case truthy(r["paid_at"]):
				state = "paid"
			case truthy(r["served_at"]) || truthy(r["done_at"]):
				state = "served"
			case truthy(r["fired_at"]) || r["course"] == nil || f64(r["course"]) <= 1:
				state = "cooking"
			}
			cents := i64(r["qty"]) * i64(r["price_cents"])
			total += cents
			items = append(items, M{"name": r["name"], "qty": r["qty"], "cents": cents, "note": r["note"], "mods": mods, "number": r["number"], "at": r["created_at"], "state": state})
		}
		var seatOut any = seat
		if !math.IsNaN(seat) {
			seatOut = int64(seat)
			if seat != math.Trunc(seat) {
				seatOut = seat
			}
		} else {
			seatOut = nil
		}
		return c.JSON(M{"seat": seatOut, "name": name, "items": items, "totalCents": total})
	})

	/* ===== 2. allergy hand-off ===== */
	a.G["allergyHandoff"] = func(c *C, args ...any) (any, error) {
		return c.careAllergyHandoff(i64(args[0]), str(args[1]))
	}
	rt.staff("POST /orders/{id}/allergy-handoff", "staff", func(c *C) error {
		id := deskNum(c.Param("id"))
		if math.IsNaN(id) {
			return notFound("Not found")
		}
		if _, err := c.careAllergyHandoff(int64(id), c.U.Name); err != nil {
			return err
		}
		return c.OK()
	})
	rt.staff("GET /allergy-handoffs", "manager", func(c *C) error {
		days := int(math.Min(90, math.Max(1, deskOr(c.Q("days"), 7))))
		rows, err := c.All(`SELECT o.number, o.allergy_note, o.allergy_checked_by, o.allergy_handed_by, o.allergy_handed_at, o.created_at, t.label table_label FROM orders o LEFT JOIN tables t ON t.id = o.table_id
      WHERE o.allergy_note IS NOT NULL AND o.created_at > datetime('now', ?) AND o.status <> 'void' ORDER BY o.created_at DESC LIMIT 200`, fmt.Sprintf("-%d days", days))
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})

	/* ===== 3. saved table combos ===== */
	rt.staff("GET /table-combos", "staff", func(c *C) error {
		rows, err := c.All(`SELECT * FROM table_combos ORDER BY name COLLATE "C"`)
		if err != nil {
			return err
		}
		out := []M{}
		for _, r := range rows {
			m, err := c.careComboOut(r)
			if err != nil {
				return err
			}
			out = append(out, m)
		}
		return c.JSON(out)
	})
	rt.staff("POST /table-combos", "manager", func(c *C) error {
		b, err := c.Body(valid.Ordered("name", valid.String().Trim().Min(1).Max(40), "tableIds", valid.Array(valid.Int()).Min(2).Max(10)))
		if err != nil {
			return err
		}
		r, err := c.Run(`INSERT INTO table_combos (name, table_ids) VALUES (?, ?)`, b["name"], deskJSON(b["tableIds"]))
		if err != nil {
			return err
		}
		if err := c.Audit("combo.create", str(b["name"])); err != nil {
			return err
		}
		cb, err := c.Get(`SELECT * FROM table_combos WHERE id = ?`, r.LastID)
		if err != nil {
			return err
		}
		m, err := c.careComboOut(cb)
		if err != nil {
			return err
		}
		return c.JSON(m)
	})
	rt.staff("DELETE /table-combos/{id}", "manager", func(c *C) error {
		id := int64(deskNum(c.Param("id")))
		if _, err := c.Run(`DELETE FROM table_combos WHERE id = ?`, id); err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE bookings SET combo_id = NULL WHERE combo_id = ?`, id); err != nil {
			return err
		}
		return c.OK()
	})
	rt.staff("PUT /bookings/{id}/combo", "staff", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{"comboId": valid.Int().Nullable()}))
		if err != nil {
			return err
		}
		bk, err := c.One(`SELECT * FROM bookings WHERE id = ?`, int64(deskNum(c.Param("id"))))
		if err != nil {
			return err
		}
		if bk == nil {
			return notFound("Not found")
		}
		var cb store.Row
		if truthy(b["comboId"]) {
			if cb, err = c.One(`SELECT * FROM table_combos WHERE id = ?`, b["comboId"]); err != nil {
				return err
			}
			if cb == nil {
				return notFound("That combo is gone")
			}
		}
		var first any
		name := "none"
		if cb != nil {
			if ids := deskJList(cb["table_ids"]); len(ids) > 0 {
				first = int64(valid.ToFloat(ids[0]))
			}
			name = str(cb["name"])
		}
		if _, err := c.Run(`UPDATE bookings SET combo_id = ?, table_id = COALESCE(?, table_id) WHERE id = ?`, b["comboId"], first, bk["id"]); err != nil {
			return err
		}
		if err := c.Audit("booking.combo", fmt.Sprintf("#%v: %s", bk["id"], name)); err != nil {
			return err
		}
		c.Notify("bookings")
		return c.OK()
	})
	a.G["joinCombo"] = func(c *C, args ...any) (any, error) {
		var u *auth.User
		if len(args) > 1 {
			u, _ = args[1].(*auth.User)
		}
		return c.careJoinCombo(args[0], u)
	}
	rt.staff("POST /table-combos/{id}/join", "staff", func(c *C) error {
		cb, err := c.One(`SELECT * FROM table_combos WHERE id = ?`, int64(deskNum(c.Param("id"))))
		if err != nil {
			return err
		}
		if cb == nil {
			return notFound("Not found")
		}
		var main any
		if ids := deskJList(cb["table_ids"]); len(ids) > 0 {
			main = ids[0]
		}
		joined, err := c.careJoinCombo(cb["id"], c.U)
		if err != nil {
			return err
		}
		return c.JSON(M{"ok": true, "mainId": main, "joined": joined})
	})
	a.G["bookingCombo"] = func(c *C, args ...any) (any, error) {
		g, _ := args[0].(store.Row)
		if g == nil || !truthy(g["booking_id"]) {
			return nil, nil
		}
		v, err := c.Val(`SELECT combo_id FROM bookings WHERE id = ?`, g["booking_id"])
		return orNil(v), err
	}

	/* ===== 6. prep learns from waste ===== */
	a.G["wasteAdjust"] = func(c *C, args ...any) (any, error) {
		switch l := args[0].(type) {
		case []M:
			return c.careWasteAdjust(l)
		case []any:
			items := make([]M, 0, len(l))
			for _, x := range l {
				if m, ok := x.(map[string]any); ok {
					items = append(items, m)
				}
			}
			return c.careWasteAdjust(items)
		}
		return args[0], nil
	}

	/* ===== 7. driver checkout ===== */
	dateQ := func(c *C) string {
		if d := c.Q("date"); deskDateRE.MatchString(d) {
			return d
		}
		return c.deskToday()
	}
	rt.staff("GET /me/driver-checkout", "staff", func(c *C) error {
		r, err := c.careDriverCheckout(c.U.ID, dateQ(c))
		if err != nil {
			return err
		}
		return c.JSON(r)
	})
	rt.staff("GET /driver-checkouts", "manager", func(c *C) error {
		date := dateQ(c)
		start, end := deskDayBounds(date, c.deskTZ())
		ids, err := c.All(`SELECT driver_id FROM orders WHERE driver_id IS NOT NULL AND delivered_at >= ? AND delivered_at < ? GROUP BY driver_id ORDER BY MIN(id)`, start, end)
		if err != nil {
			return err
		}
		drivers := []M{}
		for _, r := range ids {
			d, err := c.careDriverCheckout(r["driver_id"], date)
			if err != nil {
				return err
			}
			drivers = append(drivers, d)
		}
		return c.JSON(M{"date": date, "drivers": drivers})
	})

	/* ===== 8. remake alerts ===== */
	sweep := func(c *C) error {
		s := c.S()
		if s["remake_alerts"] == "0" {
			return nil
		}
		n := math.Max(2, deskNum(orNil(s["remake_alert_count"])))
		if !truthy(s["remake_alert_count"]) {
			n = 3
		}
		rows, err := c.All(`SELECT COALESCE(oi.name, r.name) dish, COUNT(*) c, GROUP_CONCAT(DISTINCT r.reason) reasons FROM remakes r LEFT JOIN order_items oi ON oi.id = r.order_item_id
        WHERE r.at > datetime('now','-60 minutes') AND r.name NOT LIKE 'Ticket #%' GROUP BY COALESCE(oi.name, r.name) HAVING COUNT(*) >= ?`, int64(n))
		if err != nil {
			return err
		}
		for _, r := range rows {
			dish := str(r["dish"])
			key := dish + ":" + time.Now().UTC().Format("2006-01-02T15")
			recent, err := c.One(`SELECT 1 FROM remake_alerts WHERE key LIKE ? AND at > datetime('now','-2 hours')`, dish+":%")
			if err != nil {
				return err
			}
			if recent != nil {
				continue
			}
			if _, err := c.Run(`INSERT OR IGNORE INTO remake_alerts (key) VALUES (?)`, key); err != nil {
				return err
			}
			body := fmt.Sprintf("%s came back %d times in the last hour (%s). Check the station.", dish, i64(r["c"]), str(r["reasons"]))
			if err := c.AuditAs(nil, "remake.alert", body, ""); err != nil {
				return err
			}
			c.Emit("staff", "security", M{"type": "fire", "detail": body})
			c.a.pushToUsers(c.Ctx, c.Tx, []string{"manager", "owner"}, M{"title": s["business_name"] + ": dish keeps coming back", "body": body, "tag": "remake-" + dish, "url": "/kitchen-speed"}, 0)
		}
		_, err = c.Run(`DELETE FROM remake_alerts WHERE at < datetime('now','-2 days')`)
		return err
	}
	// Node's h.remakeSweep sweeps every location; here it sweeps the caller's location.
	a.G["remakeSweep"] = func(c *C, args ...any) (any, error) { return nil, sweep(c) }
	a.every("remake-alerts", 2*time.Minute, sweep)

	/* ===== 9. VIP profile ===== */
	rt.staff("GET /customers/{id}/vip-card", "staff", func(c *C) error {
		cu, err := c.One(`SELECT id, name, phone, email, tags, notes, birthday, visits FROM customers WHERE id = ?`, int64(deskNum(c.Param("id"))))
		if err != nil {
			return err
		}
		if cu == nil {
			return notFound("Not found")
		}
		last, err := c.One(`SELECT id, number, created_at, total_cents FROM orders WHERE customer_id = ? AND status <> 'void' ORDER BY id DESC LIMIT 1`, cu["id"])
		if err != nil {
			return err
		}
		var lastOut any
		if last != nil {
			li, err := c.All(`SELECT qty, name FROM order_items WHERE order_id = ? AND price_cents > 0 ORDER BY id`, last["id"])
			if err != nil {
				return err
			}
			items := []any{}
			for _, i := range li {
				items = append(items, fmt.Sprintf("%v %s", i["qty"], str(i["name"])))
			}
			lastOut = M{"number": last["number"], "at": last["created_at"], "cents": last["total_cents"], "items": items}
		}
		favRows, err := c.All(`SELECT oi.name, SUM(oi.qty) n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.customer_id = ? AND o.status <> 'void' AND oi.price_cents > 0 GROUP BY oi.name ORDER BY n DESC, MIN(oi.id) LIMIT 3`, cu["id"])
		if err != nil {
			return err
		}
		fav := []any{}
		for _, r := range favRows {
			fav = append(fav, r["name"])
		}
		spend, err := c.N(`SELECT COALESCE(SUM(total_cents),0) c FROM orders WHERE customer_id = ? AND paid_at > datetime('now','-365 days') AND status <> 'void'`, cu["id"])
		if err != nil {
			return err
		}
		plan, err := c.Val(`SELECT p.name FROM memberships ms JOIN membership_plans p ON p.id = ms.plan_id WHERE ms.customer_id = ? AND ms.status = 'active' ORDER BY ms.id LIMIT 1`, cu["id"])
		if err != nil {
			return err
		}
		tags := careList(cu["tags"], "[]")
		allergies := []any{}
		for _, t := range tags {
			if careAllergyTagRE.MatchString(str(t)) {
				allergies = append(allergies, t)
			}
		}
		return c.JSON(M{"id": cu["id"], "name": cu["name"], "visits": cu["visits"], "notes": cu["notes"], "birthday": cu["birthday"], "tags": tags, "allergies": allergies,
			"plan": orNil(plan), "yearSpendCents": spend, "favourites": fav, "last": lastOut})
	})

	/* ===== 10. pacing by party size ===== */
	a.G["partyGap"] = func(c *C, args ...any) (any, error) {
		var party int64
		if len(args) > 1 {
			party = i64(args[1])
		}
		return c.carePartyGap(i64(args[0]), party)
	}
	a.G["partySizeAt"] = func(c *C, args ...any) (any, error) {
		ps, err := c.Val(`SELECT g.party_size FROM tables t JOIN guests g ON g.id = t.guest_id WHERE t.id = ?`, args[0])
		if err != nil {
			return nil, err
		}
		if truthy(ps) {
			return ps, nil
		}
		n, err := c.N(`SELECT COUNT(DISTINCT oi.seat) n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.table_id = ? AND o.paid_at IS NULL AND oi.seat > 0`, args[0])
		if err != nil {
			return nil, err
		}
		if n == 0 {
			n = 2
		}
		return n, nil
	}
}
