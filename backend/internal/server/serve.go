package server

import (
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// Port of serve.js: seat names, auto-join for big parties, prep by service, leftover rollover,
// door tips, recall reasons, VIP arrival alerts, fire reminders.

func init() { modules = append(modules, (*App).registerServe) }

func (c *C) serveSeatNames(tableID any) (map[int64]string, error) {
	rows, err := c.All(`SELECT seat, name FROM seat_allergies WHERE table_id = ? AND name IS NOT NULL AND name <> ''`, tableID)
	out := map[int64]string{}
	for _, r := range rows {
		out[i64(r["seat"])] = str(r["name"])
	}
	return out, err
}

func (c *C) serveApplySeatNames(orderID, tableID any) error {
	names, err := c.serveSeatNames(tableID)
	if err != nil {
		return err
	}
	for seat, name := range names {
		if _, err := c.Run(`UPDATE order_items SET seat_name = ? WHERE order_id = ? AND seat = ?`, name, orderID, seat); err != nil {
			return err
		}
	}
	return nil
}

func (c *C) serveAutoJoin(tableID, party, user any) ([]string, error) {
	joined := []string{}
	if c.S()["auto_join_tables"] != "1" || !truthy(tableID) || !truthy(party) {
		return joined, nil
	}
	main, err := c.One(`SELECT * FROM tables WHERE id = ?`, tableID)
	if err != nil || main == nil {
		return joined, err
	}
	seats, err := c.seatJoinedSeats(main)
	if err != nil {
		return nil, err
	}
	p := f64(party)
	if float64(seats) >= p {
		return joined, nil
	}
	free, err := c.All(`SELECT * FROM tables WHERE id <> ? AND status = 'open' AND joined_to IS NULL AND guest_id IS NULL AND zone = ? AND id NOT IN (SELECT table_id FROM orders WHERE table_id IS NOT NULL AND paid_at IS NULL AND status <> 'void') ORDER BY ABS(id - ?), id`, main["id"], main["zone"], main["id"])
	if err != nil {
		return nil, err
	}
	for _, t := range free {
		if float64(seats) >= p {
			break
		}
		if _, err := c.Run(`UPDATE tables SET joined_to = ?, status = 'seated', guest_id = ? WHERE id = ?`, main["id"], main["guest_id"], t["id"]); err != nil {
			return nil, err
		}
		n := i64(t["seats"])
		if n == 0 {
			n = 4
		}
		seats += n
		joined = append(joined, str(t["label"]))
	}
	if len(joined) > 0 {
		if err := c.AuditAs(tableUser(user), "table.auto_join", fmt.Sprintf("%s %s + %s for %s", tableUnit(c), str(main["label"]), strings.Join(joined, ", "), fmtJSNum(p)), ""); err != nil {
			return nil, err
		}
		c.Notify("tables")
	}
	return joined, nil
}

/* ---------- prep by service ---------- */

type serveSplit struct {
	key   string
	at    int64
	share map[int64]float64
}

var (
	serveSplitMu sync.Mutex
	serveSplits  = map[string]serveSplit{}
)

func (c *C) servePrepSplit(items []M) ([]M, error) {
	s := c.S()
	hour := tableJSNumber(s["prep_split_hour"])
	if hour == 0 || math.IsNaN(hour) {
		return items, nil
	}
	tz := c.tableTZ()
	today := c.tableToday()
	key := today + ":" + fmtJSNum(hour)
	serveSplitMu.Lock()
	sc := serveSplits[c.Slug()]
	serveSplitMu.Unlock()
	if sc.key != key || nowMs()-sc.at > 30*60_000 {
		dw := dow(today)
		loc := loadTZ(tz)
		rows, err := c.All(`SELECT oi.item_id, oi.qty, o.created_at FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.created_at > datetime('now','-56 days') AND o.status <> 'void' AND oi.item_id IS NOT NULL`)
		if err != nil {
			return nil, err
		}
		tot, early := map[int64]float64{}, map[int64]float64{}
		for _, r := range rows {
			ms := tableMs(r["created_at"])
			if math.IsNaN(ms) {
				continue
			}
			t := time.UnixMilli(int64(ms)).In(loc)
			if int(t.Weekday()) != dw {
				continue
			}
			id := i64(r["item_id"])
			tot[id] += f64(r["qty"])
			if float64(t.Hour()) < hour {
				early[id] += f64(r["qty"])
			}
		}
		share := map[int64]float64{}
		for id, n := range tot {
			share[id] = early[id] / n
		}
		sc = serveSplit{key: key, at: nowMs(), share: share}
		serveSplitMu.Lock()
		serveSplits[c.Slug()] = sc
		serveSplitMu.Unlock()
	}
	out := make([]M, 0, len(items))
	for _, i := range items {
		sh, ok := sc.share[i64(i["id"])]
		if !ok {
			sh = 0.5
		}
		prep := f64(i["prep"])
		first := roundJS(prep * sh)
		m := M{}
		for k, v := range i {
			m[k] = v
		}
		m["split"] = M{"hour": tableNumAny(hour), "first": first, "second": tableNumAny(math.Max(0, prep-float64(first)))}
		out = append(out, m)
	}
	return out, nil
}

/* ---------- leftover rollover ---------- */

func (c *C) serveLeftoverKeeps(itemID any) (bool, error) {
	r, err := c.One(`SELECT shelf_days FROM menu_items WHERE id = ?`, itemID)
	if err != nil {
		return false, err
	}
	return r != nil && f64(r["shelf_days"]) > 0 && c.S()["leftover_rollover"] != "0", nil
}

func (c *C) serveRollLeftover(itemID any, qty int64, by string) error {
	tomorrow := addDays(c.tableToday(), 1)
	cur, err := c.One(`SELECT qty FROM prep_counts WHERE date = ? AND item_id = ?`, tomorrow, itemID)
	if err != nil {
		return err
	}
	var have int64
	if cur != nil {
		have = i64(cur["qty"])
	}
	label := "Left over"
	if by != "" {
		label = by + " (left over)"
	}
	_, err = c.Run(`INSERT INTO prep_counts (date, item_id, qty, by_label) VALUES (?, ?, ?, ?) ON CONFLICT (date, item_id) DO UPDATE SET qty = excluded.qty, by_label = excluded.by_label, at = excluded.at`, tomorrow, itemID, have+qty, label)
	return err
}

/* ---------- VIP arrival alerts ---------- */

func (c *C) serveVipLabel(customerID any) (string, error) {
	m, err := c.One(`SELECT p.name FROM memberships ms JOIN membership_plans p ON p.id = ms.plan_id WHERE ms.customer_id = ? AND ms.status = 'active'`, customerID)
	if err != nil {
		return "", err
	}
	if m != nil {
		return str(m["name"]) + " member", nil
	}
	min := tableJSNumber(c.S()["auto_vip_spend_cents"])
	if min != 0 && !math.IsNaN(min) {
		v, err := c.Val(`SELECT COALESCE(SUM(total_cents),0) c FROM orders WHERE customer_id = ? AND paid_at > datetime('now','-365 days') AND status <> 'void'`, customerID)
		if err != nil {
			return "", err
		}
		if f64(v) >= min {
			return "Top guest", nil
		}
	}
	return "", nil
}

func (c *C) serveVipArrivalSweep() error {
	s := c.S()
	if s["vip_arrival_alert"] != "1" {
		return nil
	}
	rows, err := c.All(`SELECT g.*, c.name cname, c.notes cnotes, c.visits FROM guests g JOIN customers c ON c.id = g.customer_id WHERE g.vip_alerted = 0 AND g.kind = 'table' AND g.created_at > datetime('now','-2 hours') AND g.status IN ('waiting','buzzed','acknowledged','seated')`)
	if err != nil {
		return err
	}
	for _, g := range rows {
		if _, err := c.Run(`UPDATE guests SET vip_alerted = 1 WHERE id = ?`, g["id"]); err != nil {
			return err
		}
		label, err := c.serveVipLabel(g["customer_id"])
		if err != nil {
			return err
		}
		if label == "" {
			continue
		}
		visit := ""
		if truthy(g["visits"]) {
			visit = fmt.Sprintf(", visit %d", i64(g["visits"])+1)
		}
		notes := ""
		if truthy(g["cnotes"]) {
			notes = " Notes: " + str(g["cnotes"])
		}
		body := fmt.Sprintf("%s (%s, party of %s%s) just arrived.%s", str(g["cname"]), label, str(g["party_size"]), visit, notes)
		if err := c.AuditAs(nil, "guest.vip_arrived", body, ""); err != nil {
			return err
		}
		c.Emit("staff", "security", M{"type": "vip", "detail": body, "customerId": g["customer_id"]})
		c.a.pushToUsers(c.Ctx, c.Tx, []string{"staff", "manager", "owner"}, M{"title": s["business_name"] + ": VIP arrived", "body": body, "tag": "vip-" + str(g["id"]), "url": "/waitlist"}, 0)
	}
	return nil
}

/* ---------- fire reminders ---------- */

func (c *C) serveFireSweep() error {
	s := c.S()
	if s["fire_reminders"] != "1" || !c.Has("coursePace") {
		return nil
	}
	held, err := c.All(`SELECT o.table_id, oi.course, t.label, t.server_id, MIN(o.id) oid FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN tables t ON t.id = o.table_id WHERE o.status IN ('open','sent','ready') AND oi.fired_at IS NULL AND oi.course > 1 GROUP BY o.table_id, oi.course, t.label, t.server_id`)
	if err != nil {
		return err
	}
	for _, r := range held {
		skip := false
		for _, x := range held {
			if i64(x["table_id"]) == i64(r["table_id"]) && i64(x["course"]) < i64(r["course"]) {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		pv, err := c.G("coursePace", r["table_id"], r["course"])
		if err != nil {
			return err
		}
		p := seatAsMap(pv)
		if p == nil || !truthy(p["due"]) {
			continue
		}
		key := fmt.Sprintf("%d:%d:%d", i64(r["table_id"]), i64(r["course"]), i64(r["oid"]))
		res, err := c.Run(`INSERT OR IGNORE INTO fire_reminders (key) VALUES (?)`, key)
		if err != nil {
			return err
		}
		if res.Changes == 0 {
			continue
		}
		body := fmt.Sprintf("%s %s: course %d is due (last course landed %s min ago).", tableUnit(c), str(r["label"]), i64(r["course"]), str(p["since"]))
		payload := M{"title": "Time to fire", "body": body, "tag": "fire-" + key, "url": "/pad"}
		if truthy(r["server_id"]) {
			c.a.pushToUsers(c.Ctx, c.Tx, []string{"staff", "manager", "owner"}, payload, i64(r["server_id"]))
		} else {
			c.a.pushToUsers(c.Ctx, c.Tx, []string{"manager", "owner"}, payload, 0)
		}
		c.Emit("staff", "security", M{"type": "fire", "detail": body})
	}
	_, err = c.Run(`DELETE FROM fire_reminders WHERE at < datetime('now','-1 day')`)
	return err
}

/* ---------- register ---------- */

func (a *App) registerServe(rt *router) {
	a.G["seatNames"] = func(c *C, args ...any) (any, error) {
		m, err := c.serveSeatNames(args[0])
		out := M{}
		for k, v := range m {
			out[itoa(k)] = v
		}
		return out, err
	}
	a.G["applySeatNames"] = func(c *C, args ...any) (any, error) { return nil, c.serveApplySeatNames(args[0], args[1]) }
	// autoJoinForParty(tableId, party, user) -> labels joined
	a.G["autoJoinForParty"] = func(c *C, args ...any) (any, error) {
		var user any
		if len(args) > 2 {
			user = args[2]
		}
		return c.serveAutoJoin(args[0], args[1], user)
	}
	// prepSplit(items [{id, prep, ...}]) -> items with split {hour, first, second}
	a.G["prepSplit"] = func(c *C, args ...any) (any, error) { return c.servePrepSplit(tableList(args[0])) }
	a.G["leftoverKeeps"] = func(c *C, args ...any) (any, error) { return c.serveLeftoverKeeps(args[0]) }
	a.G["rollLeftover"] = func(c *C, args ...any) (any, error) {
		by := ""
		if len(args) > 2 {
			by = str(args[2])
		}
		return nil, c.serveRollLeftover(args[0], i64(args[1]), by)
	}
	// doorTip(order, tipCents, user)
	a.G["doorTip"] = func(c *C, args ...any) (any, error) {
		o, tip := tableRow(args[0]), i64(args[1])
		if tip == 0 {
			return nil, nil
		}
		if _, err := c.Run(`UPDATE orders SET tip_cents = tip_cents + ?, total_cents = total_cents + ? WHERE id = ?`, tip, tip, o["id"]); err != nil {
			return nil, err
		}
		var user any
		if len(args) > 2 {
			user = args[2]
		}
		return nil, c.AuditAs(tableUser(user), "delivery.door_tip", fmt.Sprintf("#%s $%s", str(o["number"]), dollars(tip)), "")
	}
	// recallReason(order, reason, area, by)
	a.G["recallReason"] = func(c *C, args ...any) (any, error) {
		o := tableRow(args[0])
		if len(args) < 2 || !truthy(args[1]) {
			return nil, nil
		}
		var area, by any
		if len(args) > 2 {
			area = args[2]
		}
		if len(args) > 3 {
			by = orNil(args[3])
		}
		_, err := c.Run(`INSERT INTO remakes (order_id, name, qty, reason, area, cost_cents, by_label) VALUES (?, ?, 0, ?, ?, 0, ?)`, o["id"], "Ticket #"+str(o["number"])+" brought back", "Brought back: "+str(args[1]), area, by)
		return nil, err
	}
	a.G["vipArrivalSweep"] = func(c *C, args ...any) (any, error) { return nil, c.serveVipArrivalSweep() }
	a.G["fireReminderSweep"] = func(c *C, args ...any) (any, error) { return nil, c.serveFireSweep() }

	/* ===== 1. seat names ===== */
	rt.staff("PUT /tables/{id}/seat-name", "staff", func(c *C) error {
		b, err := c.Body(valid.Ordered("seat", valid.Int().Min(1).Max(40), "name", valid.String().Trim().Max(30)))
		if err != nil {
			return err
		}
		tid := tableNumParam(c.Param("id"))
		t, err := c.One(`SELECT 1 FROM tables WHERE id = ?`, tid)
		if err != nil {
			return err
		}
		if t == nil {
			return notFound("Not found")
		}
		name := orNil(b["name"])
		cur, err := c.One(`SELECT * FROM seat_allergies WHERE table_id = ? AND seat = ?`, tid, b["seat"])
		if err != nil {
			return err
		}
		if cur != nil {
			if name == nil && !truthy(cur["allergy"]) {
				_, err = c.Run(`DELETE FROM seat_allergies WHERE table_id = ? AND seat = ?`, tid, b["seat"])
			} else {
				_, err = c.Run(`UPDATE seat_allergies SET name = ? WHERE table_id = ? AND seat = ?`, name, tid, b["seat"])
			}
		} else if name != nil {
			_, err = c.Run(`INSERT INTO seat_allergies (table_id, seat, allergy, name) VALUES (?, ?, '', ?)`, tid, b["seat"], name)
		}
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE order_items SET seat_name = ? WHERE seat = ? AND order_id IN (SELECT id FROM orders WHERE table_id = ? AND paid_at IS NULL AND status <> 'void')`, name, b["seat"], tid); err != nil {
			return err
		}
		c.Notify("orders")
		return c.OK()
	})

	a.every("vip-arrival", 20*time.Second, func(c *C) error {
		if err := c.Tx.Savepoint(c.Ctx, c.serveVipArrivalSweep); err != nil && !strings.Contains(err.Error(), "does not exist") {
			a.log.Error("vip arrival", "err", err)
		}
		return nil
	})
	a.every("fire-reminders", time.Minute, func(c *C) error {
		if err := c.Tx.Savepoint(c.Ctx, c.serveFireSweep); err != nil && !strings.Contains(err.Error(), "does not exist") {
			a.log.Error("fire reminders", "err", err)
		}
		return nil
	})
}
