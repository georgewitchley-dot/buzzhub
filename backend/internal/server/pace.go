package server

// Port of server/src/pace.js: curbside "I'm here", kitchen speed report, event menus for private rooms,
// break planner, declared tips.

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

func init() { modules = append(modules, (*App).registerPace) }

var paceDows = []string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}

func (c *C) paceLocal(sql any) time.Time {
	return time.UnixMilli(int64(kdsMs(sql))).In(c.kdsTZ())
}
func (c *C) paceLocalHM() string { return time.Now().In(c.kdsTZ()).Format("15:04") }

// paceHandOff: brought out to the car (also closes the pickup buzzer).
func (c *C) paceHandOff(o store.Row, user *auth.User) error {
	if _, err := c.Run(`UPDATE orders SET handed_at = datetime('now') WHERE id = ?`, o["id"]); err != nil {
		return err
	}
	if truthy(o["guest_id"]) {
		if _, err := c.Run(`UPDATE guests SET status = 'done', closed_at = COALESCE(closed_at, datetime('now')) WHERE id = ? AND kind = 'order' AND status IN ('waiting','buzzed','acknowledged')`, o["guest_id"]); err != nil {
			return err
		}
	}
	if err := c.AuditAs(user, "curbside.handed", "#"+kdsJS(o["number"]), c.IP()); err != nil {
		return err
	}
	c.Notify("orders")
	c.Notify("guests")
	if truthy(o["guest_id"]) {
		return c.pushGuest(i64(o["guest_id"]))
	}
	return nil
}

// paceEventsToday: today's private-room events that have a menu, for the area screens.
func (c *C) paceEventsToday() ([]M, error) {
	rows, err := c.All(`SELECT b.*, r.name room FROM room_bookings b JOIN rooms r ON r.id = b.room_id WHERE b.date = ? AND b.status = 'confirmed' ORDER BY b.start_time`, c.kdsLocalToday())
	if err != nil {
		return nil, err
	}
	out := []M{}
	for _, b := range rows {
		menu := kdsList(kdsPJ(b["menu"], []any{}))
		if len(menu) == 0 {
			continue
		}
		ids := []string{}
		for _, l := range menu {
			lm, _ := l.(map[string]any)
			ids = append(ids, kdsJS(kdsNum(lm["itemId"])))
		}
		in := strings.Join(ids, ",")
		if in == "" || strings.Contains(in, "NaN") {
			in = "0"
		}
		ms, err := c.All(`SELECT id, name, category, station FROM menu_items WHERE id IN (` + in + `)`)
		if err != nil {
			return nil, err
		}
		names := map[int64]store.Row{}
		for _, m := range ms {
			names[i64(m["id"])] = m
		}
		items := []M{}
		for _, l := range menu {
			lm, _ := l.(map[string]any)
			m := names[i64(kdsNum(lm["itemId"]))]
			if m == nil || !truthy(m["name"]) {
				continue
			}
			it := M{}
			for k, v := range m {
				it[k] = v
			}
			it["qty"] = lm["qty"]
			if n, ok := lm["note"]; ok {
				it["note"] = n
			}
			items = append(items, it)
		}
		out = append(out, M{"id": b["id"], "name": b["name"], "room": b["room"], "guests": b["guests"], "start": b["start_time"], "fireTime": b["fire_time"], "fired": truthy(b["fired_order_id"]), "items": items})
	}
	return out, nil
}

// paceFire sends a private-room event's menu to the kitchen as one order.
func (c *C) paceFire(bk store.Row, user *auth.User) (madeOrder, error) {
	lines := kdsList(kdsPJ(bk["menu"], []any{}))
	if len(lines) == 0 {
		return madeOrder{}, bad("Add the event menu first")
	}
	if truthy(bk["fired_order_id"]) {
		return madeOrder{}, conflict("Already sent to the kitchen")
	}
	room, err := c.One(`SELECT * FROM rooms WHERE id = ?`, bk["room_id"])
	if err != nil {
		return madeOrder{}, err
	}
	var tableID any
	roomName := "private room"
	if room != nil {
		if t := kdsList(kdsPJ(room["table_ids"], []any{})); len(t) > 0 && truthy(t[0]) {
			tableID = t[0]
		}
		if truthy(room["name"]) {
			roomName = str(room["name"])
		}
	}
	in := []any{}
	for _, l := range lines {
		lm, _ := l.(map[string]any)
		x := valid.M{"itemId": lm["itemId"], "qty": lm["qty"], "mods": []any{}}
		if n, ok := lm["note"]; ok {
			x["note"] = n
		}
		in = append(in, x)
	}
	priced, err := c.priceLines(in, false)
	if err != nil {
		return madeOrder{}, err
	}
	var by any
	if user != nil {
		by = user.ID
	}
	notes := fmt.Sprintf("%s guests, %s", kdsJS(bk["guests"]), roomName)
	if truthy(bk["occasion"]) {
		notes += ", " + str(bk["occasion"])
	}
	o, err := c.insertOrder(newOrder{Lines: priced, Status: "sent", Source: "event", TableID: tableID, CustomerName: "Event: " + str(bk["name"]), CreatedBy: by, Notes: notes})
	if err != nil {
		return madeOrder{}, err
	}
	if _, err := c.Run(`UPDATE room_bookings SET fired_order_id = ? WHERE id = ?`, o.ID, bk["id"]); err != nil {
		return madeOrder{}, err
	}
	if err := c.AuditAs(user, "room.fire", fmt.Sprintf("%s: order #%d", str(bk["name"]), o.Number), ""); err != nil {
		return madeOrder{}, err
	}
	c.Notify("orders")
	c.Notify("rooms")
	return o, nil
}

type paceStat struct {
	key any
	n   int
	avg float64
	p90 float64
}

func paceStatOf(list []float64) (int, float64, float64) {
	if len(list) == 0 {
		return 0, 0, 0
	}
	s := append([]float64{}, list...)
	sort.Float64s(s)
	t := 0.0
	for _, x := range s {
		t += x
	}
	i := int(math.Floor(float64(len(s)) * 0.9))
	if i > len(s)-1 {
		i = len(s) - 1
	}
	return len(s), kdsR1(t / float64(len(s))), kdsR1(s[i])
}

func paceGroup(keys []any, vals []float64) []*paceStat {
	idx := map[any][]float64{}
	order := []any{}
	for i, k := range keys {
		if _, ok := idx[k]; !ok {
			order = append(order, k)
		}
		idx[k] = append(idx[k], vals[i])
	}
	out := []*paceStat{}
	for _, k := range order {
		n, avg, p90 := paceStatOf(idx[k])
		out = append(out, &paceStat{k, n, avg, p90})
	}
	return out
}

func paceStatsJSON(l []*paceStat) []M {
	out := []M{}
	for _, s := range l {
		out = append(out, M{"key": s.key, "n": s.n, "avg": s.avg, "p90": s.p90})
	}
	return out
}

// paceFmt is JS String() of a number for the break planner's HH:MM.
func paceHM(x float64) string {
	h := math.Floor(math.Mod(math.Mod(x, 1440)+1440, 1440) / 60)
	m := math.Mod(math.Mod(x, 60)+60, 60)
	pad := func(f float64) string {
		s := kdsJS(f)
		if len(s) < 2 {
			s = "0" + s
		}
		return s
	}
	return pad(h) + ":" + pad(m)
}

func (a *App) registerPace(rt *router) {
	/* ===== curbside: "I'm here" from the customer's order page ===== */
	a.G["curbsideView"] = func(c *C, args ...any) (any, error) {
		g, _ := args[0].(map[string]any)
		s := c.S()
		if s["curbside"] != "1" || g == nil || str(g["kind"]) != "order" || !truthy(g["order_id"]) {
			return nil, nil
		}
		o, err := c.One(`SELECT status, fulfillment, arrived_at, arrival_note, handed_at FROM orders WHERE id = ?`, g["order_id"])
		if err != nil || o == nil || str(o["fulfillment"]) == "delivery" || str(o["status"]) == "void" || truthy(o["handed_at"]) {
			return nil, err
		}
		prompt := s["curbside_prompt"]
		if prompt == "" {
			prompt = "Car color and make, or parking spot"
		}
		note := o["arrival_note"]
		if !truthy(note) {
			note = ""
		}
		return M{"arrived": truthy(o["arrived_at"]), "note": note, "prompt": prompt}, nil
	}
	rt.pub("POST /api/g/{token}/here", func(c *C) error {
		if c.S()["curbside"] != "1" {
			return forbidden("Curbside pickup is off")
		}
		g, err := c.One(`SELECT * FROM guests WHERE token = ?`, c.Param("token"))
		if err != nil {
			return err
		}
		if g == nil || str(g["kind"]) != "order" || !truthy(g["order_id"]) {
			return notFound("Order not found")
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{"note": valid.String().Trim().Max(80).Optional()}))
		if err != nil {
			return err
		}
		note := str(b["note"])
		o, err := c.Get(`SELECT * FROM orders WHERE id = ?`, g["order_id"])
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE orders SET arrived_at = COALESCE(arrived_at, datetime('now')), arrival_note = ? WHERE id = ?`, orNil(note), o["id"]); err != nil {
			return err
		}
		first := kdsFirst(str(g["name"]))
		num := kdsJS(o["number"])
		detail := fmt.Sprintf("Curbside: #%s %s is here", num, first)
		if note != "" {
			detail += " (" + note + ")"
		}
		c.Emit("staff", "security", M{"type": "curbside", "detail": detail})
		c.Notify("orders")
		body := first
		if note != "" {
			body += ": " + note
		}
		c.a.pushToUsers(c.Ctx, c.Tx, []string{"staff", "manager", "owner"}, M{"title": "#" + num + " is here", "body": body, "tag": "here-" + kdsJS(o["id"]), "url": "/orders"}, 0)
		ad := "#" + num
		if note != "" {
			ad += " " + note
		}
		if err := c.AuditAs(nil, "curbside.here", ad, c.IP()); err != nil {
			return err
		}
		if err := c.pushGuest(i64(g["id"])); err != nil {
			return err
		}
		return c.OK()
	}, a.publicLim())
	a.G["handOff"] = func(c *C, args ...any) (any, error) {
		o, _ := args[0].(map[string]any)
		var u *auth.User
		if len(args) > 1 {
			u = lineUserArg(args[1])
		}
		return nil, c.paceHandOff(o, u)
	}
	rt.staff("POST /orders/{id}/handed", "staff", func(c *C) error {
		o, err := c.One(`SELECT * FROM orders WHERE id = ?`, c.kdsPID("id"))
		if err != nil {
			return err
		}
		if o == nil {
			return notFound("Not found")
		}
		if err := c.paceHandOff(o, c.U); err != nil {
			return err
		}
		return c.OK()
	})
	rt.staff("GET /curbside", "staff", func(c *C) error {
		rows, err := c.All(`SELECT o.id, o.number, o.status, o.arrived_at, o.arrival_note, o.customer_name, g.name guest_name FROM orders o LEFT JOIN guests g ON g.id = o.guest_id WHERE o.arrived_at IS NOT NULL AND o.handed_at IS NULL AND o.status <> 'void' AND o.arrived_at > datetime('now','-6 hours') ORDER BY o.arrived_at`)
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})

	/* ===== kitchen speed report ===== */
	rt.staff("GET /kitchen-speed", "manager", func(c *C) error {
		days := c.kdsDays(7, 1, 90)
		since := c.kdsSince(days)
		late := kdsSetNum(c.S()["kds_late_minutes"], 12)
		trows, err := c.All(`SELECT o.id, o.number, o.sent_at, o.ready_at, o.source, o.fulfillment, (SELECT SUM(qty) FROM order_items WHERE order_id = o.id) items FROM orders o WHERE o.sent_at >= ? AND o.ready_at IS NOT NULL AND o.status <> 'void' AND o.ready_at > o.sent_at ORDER BY o.id`, since)
		if err != nil {
			return err
		}
		type tk struct {
			r   store.Row
			min float64
		}
		tickets := []tk{}
		for _, t := range trows {
			if m := (kdsMs(t["ready_at"]) - kdsMs(t["sent_at"])) / 60000; m <= 240 {
				tickets = append(tickets, tk{t, m})
			}
		}
		irows, err := c.All(`SELECT oi.name, oi.done_station area, oi.done_at, COALESCE(oi.fired_at, o.sent_at) start FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.sent_at >= ? AND oi.done_at IS NOT NULL AND o.status <> 'void' ORDER BY oi.id`, since)
		if err != nil {
			return err
		}
		type it struct {
			r   store.Row
			min float64
		}
		items := []it{}
		for _, i := range irows {
			if m := (kdsMs(i["done_at"]) - kdsMs(i["start"])) / 60000; m >= 0 && m <= 240 {
				items = append(items, it{i, m})
			}
		}
		all := []float64{}
		nLate := 0
		hk, dk, ck := []any{}, []any{}, []any{}
		for _, t := range tickets {
			all = append(all, t.min)
			if t.min >= late {
				nLate++
			}
			hk = append(hk, int64(c.paceLocal(t.r["sent_at"]).Hour()))
			dk = append(dk, paceDows[c.paceLocal(t.r["sent_at"]).Weekday()])
			ch := "Register"
			switch {
			case str(t.r["fulfillment"]) == "delivery":
				ch = "Delivery"
			case str(t.r["source"]) == "online":
				ch = "Online"
			case str(t.r["source"]) == "table":
				ch = "Table QR"
			case str(t.r["source"]) == "kiosk":
				ch = "Kiosk"
			}
			ck = append(ck, ch)
		}
		n, avg, p90 := paceStatOf(all)
		byHour := paceGroup(hk, all)
		sort.SliceStable(byHour, func(a, b int) bool { return i64(byHour[a].key) < i64(byHour[b].key) })
		byDay := paceGroup(dk, all)
		dowIdx := func(k any) int {
			for i, d := range paceDows {
				if d == k {
					return i
				}
			}
			return -1
		}
		sort.SliceStable(byDay, func(a, b int) bool { return dowIdx(byDay[a].key) < dowIdx(byDay[b].key) })
		byCh := paceGroup(ck, all)
		sort.SliceStable(byCh, func(a, b int) bool { return byCh[a].n > byCh[b].n })
		ak, av, nk, nv := []any{}, []float64{}, []any{}, []float64{}
		for _, i := range items {
			if truthy(i.r["area"]) {
				ak = append(ak, i.r["area"])
				av = append(av, i.min)
			}
			nk = append(nk, i.r["name"])
			nv = append(nv, i.min)
		}
		byArea := paceGroup(ak, av)
		sort.SliceStable(byArea, func(a, b int) bool { return byArea[a].avg > byArea[b].avg })
		dishes := []*paceStat{}
		for _, d := range paceGroup(nk, nv) {
			if d.n >= 2 {
				dishes = append(dishes, d)
			}
		}
		sort.SliceStable(dishes, func(a, b int) bool { return dishes[a].avg > dishes[b].avg })
		if len(dishes) > 15 {
			dishes = dishes[:15]
		}
		sort.SliceStable(tickets, func(a, b int) bool { return tickets[a].min > tickets[b].min })
		slow := []M{}
		for i, t := range tickets {
			if i >= 10 {
				break
			}
			slow = append(slow, M{"id": t.r["id"], "number": t.r["number"], "minutes": kdsR1(t.min), "items": t.r["items"], "at": t.r["sent_at"]})
		}
		return c.JSON(M{"days": days, "lateMinutes": kdsOut(late), "overall": M{"n": n, "avg": avg, "p90": p90}, "late": nLate,
			"byHour": paceStatsJSON(byHour), "byDay": paceStatsJSON(byDay), "byChannel": paceStatsJSON(byCh), "byArea": paceStatsJSON(byArea), "byDish": paceStatsJSON(dishes), "slowest": slow})
	})

	/* ===== event menus for private rooms ===== */
	menuSchema := valid.Ordered("lines", valid.Array(valid.Ordered("itemId", valid.Int(), "qty", valid.Int().Min(1).Max(500), "note", valid.String().Trim().Max(80).Optional())).Max(40),
		"fireTime", valid.String().Regex(`^(\d{2}:\d{2})?$`).Optional())
	rt.staff("PUT /rooms/bookings/{id}/menu", "manager", func(c *C) error {
		b, err := c.Body(menuSchema)
		if err != nil {
			return err
		}
		bk, err := c.One(`SELECT * FROM room_bookings WHERE id = ?`, c.kdsPID("id"))
		if err != nil {
			return err
		}
		if bk == nil {
			return notFound("Not found")
		}
		if truthy(bk["fired_order_id"]) {
			return conflict("This menu was already sent to the kitchen")
		}
		lines, _ := b["lines"].([]any)
		if len(lines) > 0 {
			in := []any{}
			for _, l := range lines {
				lm := l.(map[string]any)
				in = append(in, valid.M{"itemId": lm["itemId"], "qty": lm["qty"], "mods": []any{}})
			}
			if _, err := c.priceLines(in, false); err != nil {
				return err
			}
		}
		parts := []string{}
		for _, l := range lines {
			lm := l.(map[string]any)
			p := fmt.Sprintf(`{"itemId":%d,"qty":%d`, i64(lm["itemId"]), i64(lm["qty"]))
			if n, ok := lm["note"]; ok {
				nb, _ := json.Marshal(n)
				p += `,"note":` + string(nb)
			}
			parts = append(parts, p+"}")
		}
		if _, err := c.Run(`UPDATE room_bookings SET menu = ?, fire_time = ? WHERE id = ?`, "["+strings.Join(parts, ",")+"]", orNil(b["fireTime"]), bk["id"]); err != nil {
			return err
		}
		if err := c.Audit("room.menu", fmt.Sprintf("%s: %d dishes", str(bk["name"]), len(lines))); err != nil {
			return err
		}
		c.Notify("rooms")
		return c.OK()
	})
	rt.staff("POST /rooms/bookings/{id}/fire", "manager", func(c *C) error {
		bk, err := c.One(`SELECT * FROM room_bookings WHERE id = ?`, c.kdsPID("id"))
		if err != nil {
			return err
		}
		if bk == nil {
			return notFound("Not found")
		}
		o, err := c.paceFire(bk, c.U)
		if err != nil {
			return err
		}
		return c.JSON(M{"ok": true, "number": o.Number})
	})
	a.G["eventsToday"] = func(c *C, args ...any) (any, error) { return c.paceEventsToday() }
	a.every("event-fire", time.Minute, func(c *C) error {
		due, err := c.All(`SELECT * FROM room_bookings WHERE date = ? AND status = 'confirmed' AND fired_order_id IS NULL AND fire_time IS NOT NULL AND fire_time <= ?`, c.kdsLocalToday(), c.paceLocalHM())
		if err != nil {
			return err
		}
		for _, bk := range due {
			if err := c.Tx.Savepoint(c.Ctx, func() error { _, e := c.paceFire(bk, nil); return e }); err != nil {
				if err := c.AuditAs(nil, "room.fire_failed", str(bk["name"])+": "+err.Error(), ""); err != nil {
					return err
				}
				if _, err := c.Run(`UPDATE room_bookings SET fire_time = NULL WHERE id = ?`, bk["id"]); err != nil {
					return err
				}
			}
		}
		return nil
	})

	/* ===== break planner ===== */
	rt.staff("GET /break-plan", "manager", func(c *C) error {
		s := c.S()
		breakAfter := kdsNumOr(s["break_after_hours"], 6)
		breakLen := kdsNumOr(s["break_minutes_planned"], 30)
		// expected sales by local hour today: same weekday over the last 8 weeks
		today := c.kdsLocalToday()
		curve := make([]float64, 24)
		for w := 1; w <= 8; w++ {
			st, en := c.kdsDayBounds(kdsAddDays(today, float64(-7*w)))
			rows, err := c.All(`SELECT paid_at, total_cents FROM orders WHERE paid_at >= ? AND paid_at < ? AND status <> 'void'`, st, en)
			if err != nil {
				return err
			}
			for _, o := range rows {
				curve[c.paceLocal(o["paid_at"]).Hour()] += f64(o["total_cents"]) / 8
			}
		}
		nowT := time.Now().In(c.kdsTZ())
		nowMin := float64(nowT.Hour()*60 + nowT.Minute())
		todayStart, _ := c.kdsDayBounds(today)
		minOf := func(sql any) float64 {
			t := c.paceLocal(sql)
			m := float64(t.Hour()*60 + t.Minute())
			if str(sql) < todayStart {
				m -= 1440
			}
			return m
		}
		on, err := c.passWhosOn()
		if err != nil {
			return err
		}
		max := math.Max(1, math.Floor(float64(len(on))/4))
		taken := 0
		type person struct {
			p                    M
			start, earliest, due float64
		}
		people := []person{}
		for _, p := range on {
			if p["onBreak"].(bool) {
				taken++
				continue
			}
			sh, err := c.One(`SELECT break_minutes FROM shifts WHERE user_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1`, p["userId"])
			if err != nil {
				return err
			}
			if sh != nil && f64(sh["break_minutes"]) >= 10 {
				continue
			}
			start := minOf(p["since"])
			x := person{p, start, math.Max(nowMin, start+120), start + breakAfter*60}
			if x.due-x.start >= 180 {
				people = append(people, x)
			}
		}
		sort.SliceStable(people, func(a, b int) bool { return people[a].due < people[b].due })
		load := map[float64]float64{}
		busy := func(m float64) float64 {
			return curve[int(math.Floor(math.Mod(math.Mod(m, 1440)+1440, 1440)/60))]
		}
		plan := []M{}
		for _, p := range people {
			type best struct {
				m, score float64
				slots    []float64
				forced   bool
			}
			var bst *best
			for m := math.Ceil(p.earliest/15) * 15; m <= math.Max(p.earliest, p.due-breakLen); m += 15 {
				slots := []float64{}
				for k := 0; k < int(math.Ceil(breakLen/15)); k++ {
					slots = append(slots, m+float64(k)*15)
				}
				blocked := false
				for _, x := range slots {
					extra := 0.0
					if x <= nowMin+breakLen {
						extra = float64(taken)
					}
					if load[x]+extra >= max {
						blocked = true
						break
					}
				}
				if blocked {
					continue
				}
				score := 0.0
				for _, x := range slots {
					score += busy(x)
				}
				if bst == nil || score < bst.score-1 {
					bst = &best{m, score, slots, false}
				}
			}
			if bst == nil {
				m := math.Max(p.earliest, nowMin)
				bst = &best{m, busy(m), []float64{m}, true}
			}
			for _, x := range bst.slots {
				load[x]++
			}
			plan = append(plan, M{"userId": p.p["userId"], "name": p.p["name"], "position": p.p["position"], "since": p.p["since"], "suggest": paceHM(bst.m), "dueBy": paceHM(p.due),
				"overdue": p.due < nowMin, "now": bst.m <= nowMin+10, "quiet": !bst.forced})
		}
		rc := make([]int64, 24)
		for i, v := range curve {
			rc[i] = roundJS(v)
		}
		return c.JSON(M{"breakAfterHours": breakAfter, "breakMinutes": breakLen, "maxAtOnce": max, "onBreak": taken, "plan": plan, "curve": rc, "nowHour": math.Floor(nowMin / 60)})
	})

	/* ===== declared tips ===== */
	a.G["declareTips"] = func(c *C, args ...any) (any, error) {
		if len(args) < 2 {
			return nil, nil
		}
		cents := kdsNum(args[1])
		if c.S()["declare_tips"] != "1" || !(cents >= 0) {
			return nil, nil
		}
		sh, err := c.One(`SELECT id FROM shifts WHERE user_id = ? AND clock_out IS NOT NULL ORDER BY clock_out DESC LIMIT 1`, args[0])
		if err != nil || sh == nil {
			return nil, err
		}
		_, err = c.Run(`UPDATE shifts SET declared_tips_cents = ? WHERE id = ?`, int64(math.Min(1_000_000, float64(roundJS(cents)))), sh["id"])
		return nil, err
	}
	rt.staff("PUT /shifts/{id}/declared-tips", "manager", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{"cents": valid.Int().Min(0).Max(1_000_000)}))
		if err != nil {
			return err
		}
		sh, err := c.One(`SELECT * FROM shifts WHERE id = ?`, c.kdsPID("id"))
		if err != nil {
			return err
		}
		if sh == nil {
			return notFound("Not found")
		}
		if _, err := c.Run(`UPDATE shifts SET declared_tips_cents = ? WHERE id = ?`, b["cents"], sh["id"]); err != nil {
			return err
		}
		if err := c.Audit("tips.declared_edit", fmt.Sprintf("shift %s: $%s", kdsJS(sh["id"]), dollars(i64(b["cents"])))); err != nil {
			return err
		}
		c.Notify("shifts")
		return c.OK()
	})
}
