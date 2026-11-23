package server

import (
	"encoding/base64"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// Core routes from index.js: guest pages, waitlist, tables, menu, register orders, staff users,
// customer accounts and bookings. Every other module registers itself through modules (see module.go).

func init() { modules = append(modules, (*App).registerCore) }

var activeStatuses = map[string]bool{"waiting": true, "buzzed": true, "acknowledged": true}

const phoneRE = `^[+\d\s()-]*$`

func emailField() valid.Schema {
	return valid.String().Trim().Max(120).Email("Email looks wrong").Optional().Or(valid.Literal(""))
}

func (c *C) Customer() *auth.Customer {
	return c.a.sess.CustomerFromToken(c.Ctx, c.Tx, cookie(c.R, auth.CustomerCookie))
}

func (c *C) requireCustomer() (*auth.Customer, error) {
	cu := c.Customer()
	if cu == nil {
		return nil, fail(401, "Please sign in")
	}
	return cu, nil
}

func (c *C) guestFromPath() (store.Row, error) {
	return c.a.guestByToken(c.Ctx, c.Tx, c.Param("token"))
}

func (c *C) logoURL() any {
	s := c.S()
	if s["logo_version"] == "0" {
		return nil
	}
	return "/api/public/logo?l=" + c.Slug() + "&v=" + s["logo_version"]
}

/* ---------- business-time helpers (localNow, slotsFor ...) ---------- */

type localNowT struct {
	Date    string
	Minutes int
	Stamp   string
}

func localNow(tz string) localNowT {
	t := time.Now().In(loadTZ(tz))
	return localNowT{t.Format("2006-01-02"), t.Hour()*60 + t.Minute(), t.Format("2006-01-02 15:04")}
}
func toMin(hhmm string) int {
	var h, m int
	fmt.Sscanf(hhmm, "%d:%d", &h, &m)
	return h*60 + m
}
func fromMin(m int) string { return fmt.Sprintf("%02d:%02d", m/60, m%60) }
func minutesUntil(startLocal, tz string) float64 {
	a, _ := time.Parse("2006-01-02 15:04", startLocal)
	b, _ := time.Parse("2006-01-02 15:04", localNow(tz).Stamp)
	return a.Sub(b).Minutes()
}
func addDays(date string, n int) string {
	t, _ := time.Parse("2006-01-02", date)
	return t.AddDate(0, 0, n).Format("2006-01-02")
}
func dow(date string) int {
	t, _ := time.Parse("2006-01-02", date)
	return int(t.Weekday())
}

func (c *C) slotsFor(date string) ([]M, error) {
	s := c.S()
	ln := localNow(s["timezone"])
	days := s["booking_days"]
	d := dow(date)
	out := []M{}
	if s["booking_enabled"] != "1" || len(days) < 7 || days[d] != '1' {
		return out, nil
	}
	if date < ln.Date || date > addDays(ln.Date, int(f64(s["booking_days_ahead"]))) {
		return out, nil
	}
	step, cap := int(f64(s["booking_slot_minutes"])), i64(s["booking_capacity"])
	rows, err := c.All(`SELECT substr(start_local, 12, 5) t, COUNT(*) c FROM bookings WHERE substr(start_local,1,10) = ? AND status IN ('booked','checked_in') GROUP BY substr(start_local, 12, 5)`, date)
	if err != nil {
		return nil, err
	}
	taken := map[string]int64{}
	for _, r := range rows {
		taken[str(r["t"])] = i64(r["c"])
	}
	if step <= 0 {
		return out, nil
	}
	for m := toMin(s["booking_open"]); m+step <= toMin(s["booking_close"]); m += step {
		if date == ln.Date && m <= ln.Minutes+5 {
			continue
		}
		t := fromMin(m)
		left := cap - taken[t]
		if left < 0 {
			left = 0
		}
		out = append(out, M{"time": t, "left": left})
	}
	return out, nil
}

func (c *C) checkInBooking(bk store.Row, cu *auth.Customer, by *auth.User) (store.Row, error) {
	st := str(bk["start_local"])
	h, m := 0, 0
	if len(st) >= 16 {
		fmt.Sscanf(st[11:16], "%d:%d", &h, &m)
	}
	hh := h % 12
	if hh == 0 {
		hh = 12
	}
	ap := "PM"
	if h < 12 {
		ap = "AM"
	}
	tm := fmt.Sprintf("%d:%02d %s", hh, m, ap)
	phone := ""
	if cu.Phone != nil {
		phone = *cu.Phone
	}
	g, err := c.createGuest(newGuest{Name: cu.Name, Phone: phone, Email: cu.Email, NotifyEmail: true, PartySize: i64(bk["party_size"]), Notes: str(bk["notes"]), Source: "booking", CustomerID: cu.ID, BookingID: bk["id"]})
	if err != nil {
		return nil, err
	}
	if _, err := c.Run(`UPDATE bookings SET status = 'checked_in', guest_id = ? WHERE id = ?`, g["id"], bk["id"]); err != nil {
		return nil, err
	}
	if _, err := c.G("onBookingCheckin", bk, cu); err != nil {
		return nil, err
	}
	if err := c.AuditAs(by, "booking.checkin", cu.Name+" — "+st, ""); err != nil {
		return nil, err
	}
	c.Emit("staff", "booking:arrived", M{"name": cu.Name, "time": tm})
	c.Notify("guests")
	c.Notify("bookings")
	return g, c.pushAllWaiting()
}

func (c *C) customerByID(id any) (*auth.Customer, error) {
	r, err := c.One(`SELECT id, name, email, phone FROM customers WHERE id = ?`, id)
	if err != nil || r == nil {
		return nil, err
	}
	cu := &auth.Customer{ID: i64(r["id"]), Name: str(r["name"]), Email: str(r["email"])}
	if r["phone"] != nil {
		p := str(r["phone"])
		cu.Phone = &p
	}
	return cu, nil
}

func pct(v any) string { return fmtJSNum(f64(v)) }

func (c *C) qr(link string, dark string) (string, error) { return qrSVG(link, 1, dark, "", false) }

// markReady marks an order ready (or paid if prepaid) and buzzes a waiting pickup guest.
func (c *C) markReady(o store.Row, user *auth.User, ip, by string) (M, error) {
	pickup := false
	if o["guest_id"] != nil {
		k, _ := c.Val(`SELECT kind FROM guests WHERE id=?`, o["guest_id"])
		pickup = str(k) == "order"
	}
	st := "ready"
	if truthy(o["prepaid"]) && !pickup {
		st = "paid"
	}
	if _, err := c.Run(`UPDATE orders SET status=?, ready_at=? WHERE id=?`, st, store.Now(), o["id"]); err != nil {
		return nil, err
	}
	extra := ""
	if by != "" && user == nil {
		extra = " (" + by + ")"
	}
	if err := c.AuditAs(user, "order.ready", fmt.Sprintf("#%v%s", o["number"], extra), ip); err != nil {
		return nil, err
	}
	var buzz any
	if o["guest_id"] != nil && str(o["source"]) != "guest" {
		g, err := c.One(`SELECT * FROM guests WHERE id=?`, o["guest_id"])
		if err != nil {
			return nil, err
		}
		msg := ""
		if str(o["fulfillment"]) == "delivery" {
			msg = fmt.Sprintf("Order #%v is on its way to you!", o["number"])
		}
		if g != nil && str(g["kind"]) == "order" && activeStatuses[str(g["status"])] {
			if buzz, err = c.buzzGuest(g, msg, user, ip); err != nil {
				return nil, err
			}
		}
	}
	c.Notify("orders")
	return M{"ok": true, "buzz": buzz}, nil
}

var dataURLRE = regexp.MustCompile(`^data:(image/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$`)

func (a *App) registerCore(rt *router) {
	a.G["markReady"] = func(c *C, args ...any) (any, error) {
		u, _ := args[1].(*auth.User)
		by := ""
		if len(args) > 3 {
			by = str(args[3])
		}
		return c.markReady(args[0].(store.Row), u, str(args[2]), by)
	}
	a.G["createGuest"] = func(c *C, args ...any) (any, error) { return c.createGuest(args[0].(newGuest)) }
	a.G["pushGuest"] = func(c *C, args ...any) (any, error) { return nil, c.pushGuest(i64(args[0])) }

	// appointment reminders (phone notification + optional email)
	a.every("booking-reminders", time.Minute, func(c *C) error {
		s := c.S()
		lead := f64(s["booking_reminder_minutes"])
		if s["booking_enabled"] != "1" || lead == 0 {
			return nil
		}
		date := localNow(s["timezone"]).Date
		due, err := c.All(`SELECT b.*, c.name, c.email FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.status = 'booked' AND b.reminded_at IS NULL AND substr(b.start_local,1,10) BETWEEN ? AND ?`, date, addDays(date, 1))
		if err != nil {
			return err
		}
		for _, b := range due {
			until := minutesUntil(str(b["start_local"]), s["timezone"])
			if until > lead || until < 0 {
				continue
			}
			if _, err := c.Run(`UPDATE bookings SET reminded_at = ? WHERE id = ?`, store.Now(), b["id"]); err != nil {
				return err
			}
			t, _ := time.Parse("2006-01-02 15:04", str(b["start_local"]))
			body := "See you at " + t.Format("3:04 PM")
			if truthy(b["service_name"]) {
				body += " for " + str(b["service_name"])
			}
			body += `. When you arrive, open the app and tap "I'm here" to check in.`
			u := "/account"
			if c.Slug() != "main" {
				u += "?l=" + c.Slug()
			}
			a.pushToCustomer(c.Ctx, c.Tx, i64(b["customer_id"]), M{"title": s["business_name"] + ": appointment reminder", "body": body, "tag": fmt.Sprintf("booking-%v", b["id"]), "url": u})
			if emailEnabled() {
				_, _ = emailGuest(str(b["email"]), emailMsg{BusinessName: s["business_name"], Subject: "Appointment reminder", Message: body, Link: a.cfg.PublicURL + "/account", Accent: s["accent"]})
			}
		}
		return nil
	})
	a.every("push-cleanup", time.Hour, func(c *C) error {
		_, err := c.Run(`DELETE FROM push_subs WHERE customer_id IS NULL AND guest_id IN (SELECT id FROM guests WHERE closed_at IS NOT NULL AND closed_at < datetime('now','-1 day'))`)
		return err
	})
	a.every("device-cleanup", 6*time.Hour, func(c *C) error {
		_, err := c.Run(`DELETE FROM devices WHERE status = 'pending' AND COALESCE(last_seen, created_at) < datetime('now','-14 days')`)
		return err
	})

	rt.pub("GET /api/public/vapid", func(c *C) error { return c.JSON(M{"publicKey": a.vapid.PublicKey}) })

	rt.pub("POST /api/public/join", func(c *C) error {
		if c.S()["self_checkin"] != "1" {
			return forbidden("Self check-in is turned off. Please see the host.")
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{
			"name":        valid.String().Trim().Min(1).Max(40),
			"phone":       valid.String().Trim().Max(20).RegexMsg(phoneRE, "Phone looks wrong").Optional().Or(valid.Literal("")),
			"email":       emailField(),
			"notifyEmail": valid.Bool().Optional(),
			"partySize":   valid.Int().Min(1).Max(30),
		}))
		if err != nil {
			return err
		}
		cu := c.Customer()
		email := str(b["email"])
		var cid any
		if cu != nil {
			cid = cu.ID
			if email == "" {
				email = cu.Email
			}
		}
		notify, _ := b["notifyEmail"].(bool)
		g, err := c.createGuest(newGuest{Name: str(b["name"]), Phone: str(b["phone"]), Email: email, NotifyEmail: notify, PartySize: i64(b["partySize"]), Source: "self", CustomerID: cid})
		if err != nil {
			return err
		}
		if err := c.AuditAs(nil, "guest.selfjoin", fmt.Sprintf("%s party of %d", str(g["name"]), i64(g["party_size"])), c.IP()); err != nil {
			return err
		}
		c.Notify("guests")
		if err := c.pushAllWaiting(); err != nil {
			return err
		}
		return c.JSON(M{"token": g["token"]})
	}, a.joinLim())

	rt.pub("GET /api/g/{token}", func(c *C) error {
		g, err := c.guestFromPath()
		if err != nil {
			return err
		}
		if g == nil {
			return notFound("This buzzer link is not valid.")
		}
		v, err := c.guestPublicView(g)
		if err != nil {
			return err
		}
		return c.JSON(v)
	}, a.publicLim())

	rt.pub("GET /api/g/{token}/manifest.webmanifest", func(c *C) error {
		g, err := c.guestFromPath()
		if err != nil {
			return err
		}
		if g == nil {
			c.W.WriteHeader(404)
			return nil
		}
		s := c.S()
		icon := "/icon-512.png"
		if l := c.logoURL(); l != nil {
			icon = l.(string)
		}
		c.W.Header().Set("Content-Type", "application/manifest+json; charset=utf-8")
		return c.JSON(M{"name": s["business_name"] + " buzzer", "short_name": trunc(s["business_name"], 12), "start_url": "/b/" + str(g["token"]), "scope": "/b/",
			"display": "standalone", "background_color": "#0f1015", "theme_color": "#0f1015",
			"icons": []M{{"src": icon, "sizes": "512x512", "type": "image/png", "purpose": "any"}}})
	}, a.publicLim())

	rt.pub("POST /api/g/{token}/push", func(c *C) error {
		g, err := c.guestFromPath()
		if err != nil {
			return err
		}
		if g == nil || !activeStatuses[str(g["status"])] {
			return conflict("This buzzer is no longer active")
		}
		sub, err := c.Body(pushSubSchema)
		if err != nil {
			return err
		}
		k := sub["keys"].(valid.M)
		if err := saveSubscription(c.Ctx, c.Tx, g["id"], orNil(g["customer_id"]), str(sub["endpoint"]), str(k["p256dh"]), str(k["auth"])); err != nil {
			return err
		}
		if err := c.AuditAs(nil, "guest.alerts_on", fmt.Sprintf("%s (#%d) turned on phone alerts", str(g["name"]), i64(g["id"])), c.IP()); err != nil {
			return err
		}
		if err := c.pushGuest(i64(g["id"])); err != nil {
			return err
		}
		return c.OK()
	}, a.publicLim())

	rt.pub("POST /api/g/{token}/push/test", func(c *C) error {
		g, err := c.guestFromPath()
		if err != nil {
			return err
		}
		if g == nil {
			return notFound("Not found")
		}
		return c.JSON(a.pushToGuest(c.Ctx, c.Tx, i64(g["id"]), M{"title": c.S()["business_name"], "body": "Alerts are on. We'll buzz you here when it's your turn.", "tag": "test", "url": "/b/" + str(g["token"])}))
	}, a.publicLim())

	rt.pub("POST /api/g/{token}/email", func(c *C) error {
		g, err := c.guestFromPath()
		if err != nil {
			return err
		}
		if g == nil || !activeStatuses[str(g["status"])] {
			return conflict("This buzzer is no longer active")
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{"email": emailField(), "notify": valid.Bool()}))
		if err != nil {
			return err
		}
		email := str(b["email"])
		n := 0
		if email != "" && b["notify"].(bool) {
			n = 1
		}
		if _, err := c.Run(`UPDATE guests SET email = ?, notify_email = ? WHERE id = ?`, orNil(email), n, g["id"]); err != nil {
			return err
		}
		if err := c.pushGuest(i64(g["id"])); err != nil {
			return err
		}
		return c.OK()
	}, a.publicLim())

	rt.pub("GET /api/g/{token}/menu", func(c *C) error {
		g, err := c.guestFromPath()
		if err != nil {
			return err
		}
		if g == nil {
			return notFound("Not found")
		}
		items, err := c.menuWithMods("active = 1 AND guest_orderable = 1")
		if err != nil {
			return err
		}
		for _, m := range items {
			delete(m, "stock")
			delete(m, "low_stock")
			delete(m, "guest_orderable")
			delete(m, "active")
		}
		return c.JSON(M{"items": items, "currency": c.S()["currency"], "taxRate": f64(c.S()["tax_rate"])})
	}, a.publicLim())

	rt.pub("POST /api/g/{token}/preorder", func(c *C) error {
		g, err := c.guestFromPath()
		if err != nil {
			return err
		}
		if g == nil {
			return notFound("Not found")
		}
		q, err := queueFor(c.Ctx, c.Tx, str(g["kind"]))
		if err != nil {
			return err
		}
		win := c.preorderWindow(g, indexOf(q, i64(g["id"]))+1)
		if !win["open"].(bool) {
			if win["enabled"].(bool) {
				return conflict(fmt.Sprintf("Ordering opens in about %v minutes.", win["opensInMinutes"]))
			}
			return conflict("Ordering ahead is not available.")
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{"items": valid.Array(lineSchema).Min(1).Max(20)}))
		if err != nil {
			return err
		}
		lines, err := c.priceLines(b["items"].([]any), true)
		if err != nil {
			return err
		}
		var count int64
		names := []string{}
		for _, l := range lines {
			count += i64(l["qty"])
			names = append(names, fmt.Sprintf("%d× %s", i64(l["qty"]), str(l["name"])))
		}
		limit := i64(g["party_size"]) * 4
		if limit < 12 {
			limit = 12
		}
		if count > limit {
			return bad("That is a lot for one party. Please order the rest at your table.")
		}
		existing, err := c.One(`SELECT * FROM orders WHERE guest_id = ? AND source = 'guest' AND status <> 'void' ORDER BY id DESC LIMIT 1`, g["id"])
		if err != nil {
			return err
		}
		if existing != nil && str(existing["status"]) != "held" {
			return conflict("Your order is already being made. Please add more with your server.")
		}
		if existing != nil {
			if _, err := c.Run(`UPDATE orders SET status = 'void' WHERE id = ?`, existing["id"]); err != nil {
				return err
			}
			if err := c.returnStock(i64(existing["id"]), nil); err != nil {
				return err
			}
		}
		made, err := c.insertOrder(newOrder{Lines: lines, Status: "held", Source: "guest", GuestID: g["id"], CustomerName: g["name"]})
		if err != nil {
			return err
		}
		act := "preorder.create"
		if existing != nil {
			act = "preorder.update"
		}
		if err := c.AuditAs(nil, act, fmt.Sprintf("%s (#%d) — %s", str(g["name"]), i64(g["id"]), strings.Join(names, ", ")), c.IP()); err != nil {
			return err
		}
		c.Emit("staff", "preorder:new", M{"name": g["name"], "count": count, "updated": existing != nil})
		if str(g["status"]) != "waiting" && g["table_id"] != nil {
			if _, err := c.fireHeldPreorder(i64(g["id"]), g["table_id"]); err != nil {
				return err
			}
		}
		c.Notify("orders")
		c.Notify("guests")
		if err := c.pushGuest(i64(g["id"])); err != nil {
			return err
		}
		return c.JSON(M{"ok": true, "orderId": made.ID})
	}, a.orderLim())

	rt.pub("POST /api/g/{token}/preorder/cancel", func(c *C) error {
		g, err := c.guestFromPath()
		if err != nil {
			return err
		}
		if g == nil {
			return notFound("Not found")
		}
		r, err := c.Run(`UPDATE orders SET status = 'void' WHERE guest_id = ? AND source = 'guest' AND status = 'held'`, g["id"])
		if err != nil {
			return err
		}
		if r.Changes == 0 {
			return conflict("Your order is already being made.")
		}
		if err := c.AuditAs(nil, "preorder.cancel", fmt.Sprintf("%s (#%d)", str(g["name"]), i64(g["id"])), c.IP()); err != nil {
			return err
		}
		c.Notify("orders")
		if err := c.pushGuest(i64(g["id"])); err != nil {
			return err
		}
		return c.OK()
	}, a.orderLim())

	rt.pub("POST /api/g/{token}/ack", func(c *C) error {
		g, err := c.guestFromPath()
		if err != nil {
			return err
		}
		if g == nil || str(g["status"]) != "buzzed" {
			return conflict("Nothing to acknowledge")
		}
		if _, err := c.Run(`UPDATE guests SET status = 'acknowledged', acknowledged_at = ? WHERE id = ?`, store.Now(), g["id"]); err != nil {
			return err
		}
		if err := c.AuditAs(nil, "guest.ack", fmt.Sprintf("%s (#%d) is on the way", str(g["name"]), i64(g["id"])), c.IP()); err != nil {
			return err
		}
		c.Emit("staff", "guest:ack", M{"id": g["id"], "name": g["name"]})
		c.Notify("guests")
		if err := c.pushGuest(i64(g["id"])); err != nil {
			return err
		}
		return c.OK()
	}, a.publicLim())

	rt.pub("POST /api/g/{token}/leave", func(c *C) error {
		g, err := c.guestFromPath()
		if err != nil {
			return err
		}
		if g == nil || !activeStatuses[str(g["status"])] {
			return conflict("Not on the list")
		}
		id := i64(g["id"])
		if _, err := c.Run(`UPDATE guests SET status = 'cancelled', closed_at = ? WHERE id = ?`, store.Now(), id); err != nil {
			return err
		}
		if err := c.voidHeldPreorder(id); err != nil {
			return err
		}
		if _, err := c.Run(`DELETE FROM push_subs WHERE guest_id = ? AND customer_id IS NULL`, id); err != nil {
			return err
		}
		if err := c.AuditAs(nil, "guest.leave", fmt.Sprintf("%s (#%d) left the list", str(g["name"]), id), c.IP()); err != nil {
			return err
		}
		c.Notify("guests")
		if err := c.pushAllWaiting(); err != nil {
			return err
		}
		if err := c.pushGuest(id); err != nil {
			return err
		}
		return c.OK()
	}, a.publicLim())

	/* ---------- staff ---------- */
	rt.staff("PUT /settings", "manager", func(c *C) error { return a.putSettings(c) })

	rt.staff("GET /dashboard", "staff", func(c *C) error {
		today := "localdate(created_at) = localtoday()"
		waiting, _ := c.N(`SELECT COUNT(*) c FROM guests WHERE kind='table' AND status IN ('waiting','buzzed','acknowledged')`)
		seated, err := c.Get(`SELECT COUNT(*) c, COALESCE(SUM(party_size),0) covers FROM guests WHERE status IN ('seated','done') AND ` + today)
		if err != nil {
			return err
		}
		avgWait, _ := c.Val(`SELECT AVG((julianday(seated_at) - julianday(created_at)) * 1440) m FROM guests WHERE seated_at IS NOT NULL AND ` + today)
		sales, err := c.Get(`SELECT COALESCE(SUM(total_cents),0) total, COUNT(*) n, COALESCE(SUM(tip_cents),0) tips FROM orders WHERE paid_at IS NOT NULL AND status <> 'void' AND localdate(paid_at) = localtoday()`)
		if err != nil {
			return err
		}
		openOrders, _ := c.N(`SELECT COUNT(*) c FROM orders WHERE status IN ('open','sent','ready')`)
		tables, err := c.All(`SELECT status, COUNT(*) c FROM tables GROUP BY status`)
		if err != nil {
			return err
		}
		buzzes, _ := c.N(`SELECT COALESCE(SUM(buzz_count),0) c FROM guests WHERE ` + today)
		hourly, err := c.All(`SELECT CAST(strftime('%H', paid_at) AS INTEGER) h, SUM(total_cents) t FROM orders WHERE paid_at IS NOT NULL AND status <> 'void' AND localdate(paid_at) = localtoday() GROUP BY CAST(strftime('%H', paid_at) AS INTEGER)`)
		if err != nil {
			return err
		}
		top, err := c.All(`SELECT oi.name, SUM(oi.qty) q FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.paid_at IS NOT NULL AND o.status <> 'void' AND localdate(o.paid_at) = localtoday() GROUP BY oi.name ORDER BY q DESC LIMIT 5`)
		if err != nil {
			return err
		}
		activity, err := c.All(`SELECT ts, user_name, action, detail FROM audit ORDER BY id DESC LIMIT 12`)
		if err != nil {
			return err
		}
		r7, err := c.Get(`SELECT AVG(rating) a, COUNT(rating) n FROM feedback WHERE responded_at > datetime('now','-7 days')`)
		if err != nil {
			return err
		}
		var rating any
		if truthy(r7["a"]) {
			rating = float64(roundJS(f64(r7["a"])*10)) / 10
		}
		aw := int64(0)
		if truthy(avgWait) {
			aw = roundJS(f64(avgWait))
		}
		return c.JSON(M{"rating7": rating, "ratings7": r7["n"], "waitModel": c.waitModelInfo(), "waiting": waiting, "seatedToday": seated["c"], "coversToday": seated["covers"], "avgWait": aw,
			"salesCents": sales["total"], "ordersPaid": sales["n"], "tipsCents": sales["tips"], "openOrders": openOrders, "tables": tables, "buzzesToday": buzzes, "hourly": hourly, "top": top, "activity": activity})
	})

	rt.staff("GET /guests", "staff", func(c *C) error {
		active, err := c.All(`SELECT g.*, t.label table_label, o.number order_number,
			(SELECT COUNT(*) FROM push_subs p WHERE p.guest_id = g.id OR (g.customer_id IS NOT NULL AND p.customer_id = g.customer_id)) devices,
			(SELECT po.status || ':' || po.number || ':' || (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id = po.id) FROM orders po WHERE po.guest_id = g.id AND po.source = 'guest' AND po.status <> 'void' ORDER BY po.id DESC LIMIT 1) preorder,
			b.start_local booking_start, b.service_name booking_service, c.visits customer_visits, c.tags customer_tags, c.notes customer_notes, c.birthday customer_birthday,
			(SELECT COUNT(*) FROM rewards r WHERE r.customer_id = g.customer_id AND r.status = 'active') rewards
			FROM guests g LEFT JOIN tables t ON t.id=g.table_id LEFT JOIN orders o ON o.id=g.order_id LEFT JOIN bookings b ON b.id = g.booking_id LEFT JOIN customers c ON c.id = g.customer_id
			WHERE g.status IN ('waiting','buzzed','acknowledged') ORDER BY g.created_at, g.id`)
		if err != nil {
			return err
		}
		pos := map[string]int{}
		for _, g := range active {
			delete(g, "token")
			pos[str(g["kind"])]++
			g["est_minutes"] = c.estimate(pos[str(g["kind"])], i64(g["party_size"]))
		}
		recent, err := c.All(`SELECT g.*, t.label table_label FROM guests g LEFT JOIN tables t ON t.id=g.table_id WHERE g.status NOT IN ('waiting','buzzed','acknowledged') AND localdate(g.created_at) = localtoday() ORDER BY g.id DESC LIMIT 30`)
		if err != nil {
			return err
		}
		return c.JSON(M{"active": active, "recent": recent})
	})

	rt.staff("POST /guests", "staff", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{
			"name":      valid.String().Trim().Min(1).Max(40),
			"phone":     valid.String().Trim().Max(20).Regex(phoneRE).Optional().Or(valid.Literal("")),
			"partySize": valid.Int().Min(1).Max(50),
			"notes":     valid.String().Trim().Max(200).Optional(),
			"email":     emailField(),
			"kind":      valid.Enum("table", "order").Optional(),
		}))
		if err != nil {
			return err
		}
		kind := str(b["kind"])
		g, err := c.createGuest(newGuest{Name: str(b["name"]), Phone: str(b["phone"]), Email: str(b["email"]), NotifyEmail: truthy(b["email"]), PartySize: i64(b["partySize"]), Notes: str(b["notes"]), Kind: kind})
		if err != nil {
			return err
		}
		if err := c.Audit("guest.add", fmt.Sprintf("%s party of %d", str(g["name"]), i64(g["party_size"]))); err != nil {
			return err
		}
		c.Notify("guests")
		if err := c.pushAllWaiting(); err != nil {
			return err
		}
		return c.JSON(M{"guest": g, "link": c.PublicBase() + "/b/" + str(g["token"])})
	})

	rt.staff("GET /guests/{id}/qr", "staff", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		tok, err := c.Val(`SELECT token FROM guests WHERE id = ?`, id)
		if err != nil {
			if store.IsNoRows(err) {
				return notFound("Not found")
			}
			return err
		}
		link := c.PublicBase() + "/b/" + str(tok)
		svg, err := c.qr(link, "#0b0b12")
		if err != nil {
			return err
		}
		return c.JSON(M{"link": link, "svg": svg})
	})

	rt.staff("GET /join-qr", "staff", func(c *C) error {
		link := c.PublicBase() + "/join"
		if c.Slug() != "main" {
			link += "?l=" + c.Slug()
		}
		svg, err := qrSVG(link, 1, "#0b0b12", "", true)
		if err != nil {
			return err
		}
		return c.JSON(M{"link": link, "svg": svg})
	})

	rt.staff("PUT /logo", "manager", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{"dataUrl": valid.String().Max(900000)}))
		if err != nil {
			return err
		}
		m := dataURLRE.FindStringSubmatch(str(b["dataUrl"]))
		if m == nil {
			return bad("Upload a PNG, JPG or WebP image")
		}
		buf, _ := base64.StdEncoding.DecodeString(m[3])
		sig := map[string][]byte{"png": {0x89, 0x50, 0x4e, 0x47}, "jpeg": {0xff, 0xd8, 0xff}, "webp": {0x52, 0x49, 0x46, 0x46}}[m[2]]
		okSig := len(buf) >= len(sig)
		for i := 0; okSig && i < len(sig); i++ {
			okSig = buf[i] == sig[i]
		}
		if len(buf) > 600000 || !okSig {
			return bad("That file is not a valid image (max 600 KB)")
		}
		if _, err := c.Run(`INSERT INTO assets (key, mime, data) VALUES ('logo', ?, ?) ON CONFLICT(key) DO UPDATE SET mime=excluded.mime, data=excluded.data, updated_at=datetime('now')`, m[1], buf); err != nil {
			return err
		}
		v := itoa(nowMs())
		if err := c.Tx.SetSettings(c.Ctx, map[string]string{"logo_version": v}); err != nil {
			return err
		}
		if err := c.Audit("settings.logo", fmt.Sprintf("%d KB", roundJS(float64(len(buf))/1024))); err != nil {
			return err
		}
		c.Refresh()
		c.Emit("all", "settings", c.settingsOut())
		return c.JSON(M{"ok": true, "logo": "/api/public/logo?v=" + v})
	})
	rt.staff("DELETE /logo", "manager", func(c *C) error {
		if _, err := c.Run(`DELETE FROM assets WHERE key='logo'`); err != nil {
			return err
		}
		if err := c.Tx.SetSettings(c.Ctx, map[string]string{"logo_version": "0"}); err != nil {
			return err
		}
		if err := c.Audit("settings.logo_removed", ""); err != nil {
			return err
		}
		c.Refresh()
		c.Emit("all", "settings", c.settingsOut())
		return c.OK()
	})

	guestByID := func(c *C) (store.Row, error) {
		id, err := c.ID()
		if err != nil {
			return nil, err
		}
		return c.One(`SELECT * FROM guests WHERE id = ?`, id)
	}

	rt.staff("POST /guests/{id}/headsup", "staff", func(c *C) error {
		g, err := guestByID(c)
		if err != nil {
			return err
		}
		if g == nil || str(g["status"]) != "waiting" {
			return conflict("Guest is not waiting")
		}
		r, err := c.sendHeadsUp(g, true)
		if err != nil {
			return err
		}
		c.Notify("guests")
		return c.JSON(r)
	})

	rt.staff("POST /guests/{id}/buzz", "staff", func(c *C) error {
		g, err := guestByID(c)
		if err != nil {
			return err
		}
		if g == nil || !activeStatuses[str(g["status"])] {
			return conflict("Guest is not waiting")
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{"message": valid.String().Max(160).Optional(), "tableId": valid.Int().Optional()}))
		if err != nil {
			return err
		}
		if truthy(b["tableId"]) {
			t, err := c.One(`SELECT * FROM tables WHERE id = ?`, b["tableId"])
			if err != nil {
				return err
			}
			if t == nil {
				return notFound("Table not found")
			}
			if _, err := c.Run(`UPDATE tables SET status='reserved', guest_id=? WHERE id=?`, g["id"], t["id"]); err != nil {
				return err
			}
			if _, err := c.Run(`UPDATE guests SET table_id=? WHERE id=?`, t["id"], g["id"]); err != nil {
				return err
			}
			c.Notify("tables")
		}
		fresh, err := c.Get(`SELECT * FROM guests WHERE id = ?`, g["id"])
		if err != nil {
			return err
		}
		r, err := c.buzzGuest(fresh, str(b["message"]), c.U, c.IP())
		if err != nil {
			return err
		}
		return c.JSON(r)
	})

	rt.staff("POST /guests/{id}/seat", "staff", func(c *C) error {
		g, err := guestByID(c)
		if err != nil {
			return err
		}
		if g == nil {
			return notFound("Not found")
		}
		id := i64(g["id"])
		b, err := c.Body(valid.Object(map[string]valid.Schema{"tableId": valid.Int().Optional()}))
		if err != nil {
			return err
		}
		tid := orNil(b["tableId"])
		if tid == nil {
			tid = orNil(g["table_id"])
		}
		now := store.Now()
		if tid != nil {
			if _, err := c.Run(`UPDATE tables SET status='open', guest_id=NULL WHERE guest_id=? AND id<>?`, id, tid); err != nil {
				return err
			}
			if _, err := c.Run(`UPDATE tables SET status='seated', guest_id=?, seated_at=? WHERE id=?`, id, now, tid); err != nil {
				return err
			}
		}
		kind := str(g["kind"])
		st := "seated"
		if kind == "order" {
			st = "done"
		}
		if _, err := c.Run(`UPDATE guests SET status=?, table_id=?, seated_at=?, closed_at=? WHERE id=?`, st, tid, now, now, id); err != nil {
			return err
		}
		var fired any
		if kind == "table" {
			if fired, err = c.fireHeldPreorder(id, tid); err != nil {
				return err
			}
		}
		var joined any = []any{}
		if kind == "table" {
			combo, err := c.G("bookingCombo", g)
			if err != nil {
				return err
			}
			if combo != nil {
				if j, err := c.G("joinCombo", combo, c.U); err != nil {
					return err
				} else if j != nil {
					joined = j
				}
			} else if tid != nil {
				if j, err := c.G("autoJoinForParty", tid, g["party_size"], c.U); err != nil {
					return err
				} else if j != nil {
					joined = j
				}
			}
		}
		if kind == "order" && g["order_id"] != nil {
			if _, err := c.Run(`UPDATE orders SET status='paid' WHERE id=? AND prepaid=1 AND status IN ('ready','sent','open')`, g["order_id"]); err != nil {
				return err
			}
		}
		if g["customer_id"] != nil {
			if err := c.Tx.Savepoint(c.Ctx, func() error { _, e := c.G("countVisit", g["customer_id"]); return e }); err != nil {
				a.log.Error("countVisit", "err", err)
			}
		}
		if _, err := c.G("scheduleFeedback", id); err != nil {
			return err
		}
		if g["booking_id"] != nil {
			if _, err := c.Run(`UPDATE bookings SET status='done' WHERE id=?`, g["booking_id"]); err != nil {
				return err
			}
		}
		act := "guest.seat"
		if kind == "order" {
			act = "guest.pickedup"
		}
		detail := str(g["name"])
		if tid != nil {
			detail += fmt.Sprintf(" → table %v", tid)
		}
		if err := c.Audit(act, detail); err != nil {
			return err
		}
		c.Notify("guests")
		c.Notify("tables")
		if err := c.pushGuest(id); err != nil {
			return err
		}
		if err := c.pushAllWaiting(); err != nil {
			return err
		}
		return c.JSON(M{"ok": true, "preorderFired": fired, "joined": joined})
	})

	rt.staff("POST /guests/{id}/remove", "staff", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{"reason": valid.Enum("cancelled", "noshow")}))
		if err != nil {
			return err
		}
		g, err := c.One(`SELECT * FROM guests WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if g == nil {
			return notFound("Not found")
		}
		reason := str(b["reason"])
		if _, err := c.Run(`UPDATE guests SET status=?, closed_at=? WHERE id=?`, reason, store.Now(), id); err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE tables SET status='open', guest_id=NULL WHERE guest_id=? AND status='reserved'`, id); err != nil {
			return err
		}
		if err := c.voidHeldPreorder(id); err != nil {
			return err
		}
		if _, err := c.Run(`DELETE FROM push_subs WHERE guest_id = ? AND customer_id IS NULL`, id); err != nil {
			return err
		}
		if g["booking_id"] != nil {
			bs := "cancelled"
			if reason == "noshow" {
				bs = "noshow"
			}
			if _, err := c.Run(`UPDATE bookings SET status=? WHERE id=?`, bs, g["booking_id"]); err != nil {
				return err
			}
		}
		if err := c.Audit("guest."+reason, str(g["name"])); err != nil {
			return err
		}
		c.Notify("guests")
		c.Notify("tables")
		if err := c.pushGuest(id); err != nil {
			return err
		}
		if err := c.pushAllWaiting(); err != nil {
			return err
		}
		return c.OK()
	})

	/* ---- tables ---- */
	rt.staff("GET /tables", "staff", func(c *C) error {
		rows, err := c.All(`SELECT t.*, g.name guest_name, g.party_size, u.name server_name FROM tables t LEFT JOIN guests g ON g.id=t.guest_id LEFT JOIN users u ON u.id=t.server_id ORDER BY t.id`)
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})
	rt.staff("POST /tables", "manager", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{"label": valid.String().Trim().Min(1).Max(10), "seats": valid.Int().Min(1).Max(40), "zone": valid.String().Trim().Min(1).Max(20)}))
		if err != nil {
			return err
		}
		if _, err := c.Run(`INSERT INTO tables (label, seats, zone) VALUES (?, ?, ?)`, b["label"], b["seats"], b["zone"]); err != nil {
			return err
		}
		if err := c.Audit("table.add", str(b["label"])); err != nil {
			return err
		}
		c.Notify("tables")
		return c.OK()
	})
	rt.staff("POST /tables/{id}/status", "staff", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{"status": valid.Enum("open", "reserved", "seated", "dirty")}))
		if err != nil {
			return err
		}
		t, err := c.One(`SELECT * FROM tables WHERE id=?`, id)
		if err != nil {
			return err
		}
		if t == nil {
			return notFound("Not found")
		}
		st := str(b["status"])
		if st == "open" || st == "dirty" {
			if t["guest_id"] != nil {
				if _, err := c.Run(`UPDATE guests SET status='done', closed_at=? WHERE id=? AND status='seated'`, store.Now(), t["guest_id"]); err != nil {
					return err
				}
			}
			if _, err := c.Run(`UPDATE tables SET status=?, guest_id=NULL, seated_at=NULL WHERE id=?`, st, id); err != nil {
				return err
			}
		} else if _, err := c.Run(`UPDATE tables SET status=? WHERE id=?`, st, id); err != nil {
			return err
		}
		if err := c.Audit("table.status", str(t["label"])+" → "+st); err != nil {
			return err
		}
		c.Notify("tables")
		return c.OK()
	})
	rt.staff("DELETE /tables/{id}", "manager", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		if _, err := c.Run(`DELETE FROM tables WHERE id=?`, id); err != nil {
			return err
		}
		if err := c.Audit("table.delete", itoa(id)); err != nil {
			return err
		}
		c.Notify("tables")
		return c.OK()
	})

	/* ---- menu ---- */
	menuSchema := valid.Object(map[string]valid.Schema{
		"name": valid.String().Trim().Min(1).Max(40), "category": valid.String().Trim().Min(1).Max(24), "price_cents": valid.Int().Min(0).Max(10000000),
		"color": valid.String().Regex(`^#[0-9a-fA-F]{6}$`).Optional(), "active": valid.Bool().Optional(), "guest_orderable": valid.Bool().Optional(),
	})
	rt.staff("GET /menu", "staff", func(c *C) error {
		rows, err := c.All(`SELECT * FROM menu_items ORDER BY sort, id`)
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})
	rt.staff("POST /menu", "manager", func(c *C) error {
		b, err := c.Body(menuSchema)
		if err != nil {
			return err
		}
		color := str(b["color"])
		if color == "" {
			color = "#ffb020"
		}
		go_ := 0
		if truthy(b["guest_orderable"]) {
			go_ = 1
		}
		if _, err := c.Run(`INSERT INTO menu_items (name, category, price_cents, color, guest_orderable) VALUES (?, ?, ?, ?, ?)`, b["name"], b["category"], b["price_cents"], color, go_); err != nil {
			return err
		}
		if err := c.Audit("menu.add", str(b["name"])); err != nil {
			return err
		}
		c.Notify("menu")
		return c.OK()
	})
	rt.staff("PUT /menu/{id}", "manager", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		b, err := c.Body(menuSchema.Partial())
		if err != nil {
			return err
		}
		cur, err := c.One(`SELECT * FROM menu_items WHERE id=?`, id)
		if err != nil {
			return err
		}
		if cur == nil {
			return notFound("Not found")
		}
		for k, v := range b {
			cur[k] = v
		}
		for _, k := range []string{"active", "guest_orderable"} {
			if v, ok := b[k]; ok {
				if v.(bool) {
					cur[k] = 1
				} else {
					cur[k] = 0
				}
			}
		}
		if _, err := c.Run(`UPDATE menu_items SET name=?, category=?, price_cents=?, color=?, active=?, guest_orderable=? WHERE id=?`, cur["name"], cur["category"], cur["price_cents"], cur["color"], cur["active"], cur["guest_orderable"], id); err != nil {
			return err
		}
		if err := c.Audit("menu.update", str(cur["name"])); err != nil {
			return err
		}
		c.Notify("menu")
		return c.OK()
	})
	rt.staff("DELETE /menu/{id}", "manager", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		if _, err := c.Run(`DELETE FROM menu_items WHERE id=?`, id); err != nil {
			return err
		}
		if err := c.Audit("menu.delete", c.Param("id")); err != nil {
			return err
		}
		c.Notify("menu")
		return c.OK()
	})

	/* ---- orders / POS ---- */
	orderSchema := valid.Object(map[string]valid.Schema{
		"items":        valid.Array(lineSchema).Min(1).Max(100),
		"priority":     valid.Int().Min(0).Max(2).Optional(),
		"clientKey":    valid.String().Regex(`^[A-Za-z0-9_-]{8,40}$`).Optional(),
		"promoCode":    valid.String().Trim().Max(30).Optional(),
		"tableId":      valid.Int().Nullable().Optional(),
		"customerName": valid.String().Trim().Max(40).Optional(),
		"discountPct":  valid.Number().Min(0).Max(100).Optional(),
		"attachBuzzer": valid.Bool().Optional(),
		"phone":        valid.String().Trim().Max(20).Regex(phoneRE).Optional().Or(valid.Literal("")),
		"customerId":   valid.Int().Optional(),
		"allergies":    valid.Array(valid.String().Trim().Min(1).Max(30)).Max(12).Optional(),
	})
	rt.staff("POST /orders", "staff", func(c *C) error {
		b, err := c.Body(orderSchema)
		if err != nil {
			return err
		}
		dp := f64(b["discountPct"])
		var approver *auth.User
		if dp > 10 && auth.RoleRank[c.U.Role] < auth.RoleRank["manager"] {
			if approver, err = c.hasApproval("discount"); err != nil {
				return err
			}
			if approver == nil {
				return failX(403, "Discounts over 10% need a manager to approve", M{"needsApproval": "discount"})
			}
		}
		lines, err := c.priceLines(b["items"].([]any), false)
		if err != nil {
			return err
		}
		var subtotal int64
		for _, l := range lines {
			subtotal += i64(l["qty"]) * i64(l["price_cents"])
		}
		discount := roundJS(float64(subtotal) * dp / 100)
		var promo, member M
		if truthy(b["promoCode"]) && c.Has("promoDiscount") {
			p, err := c.G("promoDiscount", b["promoCode"], subtotal)
			if err != nil {
				return err
			}
			promo, _ = p.(M)
			if promo != nil && i64(promo["cents"]) > discount {
				discount = i64(promo["cents"])
			}
		}
		if truthy(b["customerId"]) && c.Has("memberDiscount") {
			p, err := c.G("memberDiscount", b["customerId"], subtotal)
			if err != nil {
				return err
			}
			member, _ = p.(M)
			if member != nil && i64(member["cents"]) > discount {
				discount = i64(member["cents"])
			}
		}
		var promoCode any
		if promo != nil {
			promoCode = promo["code"]
		}
		made, err := c.insertOrder(newOrder{Lines: lines, Status: "sent", Source: "staff", TableID: orNil(b["tableId"]), CustomerName: orNil(b["customerName"]), CreatedBy: c.U.ID, DiscountCents: discount, PromoCode: promoCode, ClientKey: orNil(b["clientKey"])})
		if err != nil {
			return err
		}
		if made.Duplicate {
			return c.JSON(M{"id": made.ID, "number": made.Number, "duplicate": true})
		}
		if truthy(b["priority"]) {
			if _, err := c.Run(`UPDATE orders SET priority = ? WHERE id = ?`, b["priority"], made.ID); err != nil {
				return err
			}
		}
		if truthy(b["tableId"]) {
			if _, err := c.G("applySeatAllergies", made.ID, b["tableId"]); err != nil {
				return err
			}
			if _, err := c.G("applySeatNames", made.ID, b["tableId"]); err != nil {
				return err
			}
		}
		allergies, _ := b["allergies"].([]any)
		if truthy(b["customerId"]) || len(allergies) > 0 {
			var note any
			if len(allergies) > 0 {
				parts := []string{}
				for _, x := range allergies {
					parts = append(parts, str(x))
				}
				note = strings.Join(parts, ", ")
			}
			if _, err := c.Run(`UPDATE orders SET customer_id = ?, allergy_note = ? WHERE id = ?`, orNil(b["customerId"]), note, made.ID); err != nil {
				return err
			}
		}
		var buzzer any
		if truthy(b["attachBuzzer"]) {
			name := str(b["customerName"])
			if name == "" {
				name = fmt.Sprintf("Order %d", made.Number)
			}
			g, err := c.createGuest(newGuest{Kind: "order", Name: name, Phone: str(b["phone"]), PartySize: 1, OrderID: made.ID})
			if err != nil {
				return err
			}
			if _, err := c.Run(`UPDATE orders SET guest_id=? WHERE id=?`, g["id"], made.ID); err != nil {
				return err
			}
			link := c.PublicBase() + "/b/" + str(g["token"])
			svg, err := c.qr(link, "")
			if err != nil {
				return err
			}
			buzzer = M{"guestId": g["id"], "link": link, "svg": svg}
		}
		detail := fmt.Sprintf("#%d %s", made.Number, dollars(subtotal))
		if discount > 0 {
			off := pct(b["discountPct"]) + "%"
			if member != nil && i64(member["cents"]) >= discount {
				off = fmt.Sprintf("%v %v%%", member["plan"], member["pct"])
			}
			detail += ", " + off + " off" + approvedNote(approver, " approved by %s")
		}
		if err := c.Audit("order.create", detail); err != nil {
			return err
		}
		c.Notify("orders")
		c.Notify("guests")
		return c.JSON(M{"id": made.ID, "number": made.Number, "buzzer": buzzer})
	})

	rt.staff("GET /orders", "staff", func(c *C) error {
		scope := "o.status IN ('held','open','sent','ready')"
		if c.Q("scope") == "paid" {
			scope = "o.status IN ('paid','void') AND localdate(o.created_at) = localtoday()"
		}
		orders, err := c.All(`SELECT o.*, t.label table_label, u.name staff_name, g.status guest_status, g.kind guest_kind FROM orders o LEFT JOIN guests g ON g.id=o.guest_id LEFT JOIN tables t ON t.id=o.table_id LEFT JOIN users u ON u.id=o.created_by WHERE ` + scope + ` ORDER BY o.id DESC LIMIT 100`)
		if err != nil {
			return err
		}
		if err := c.attachItems(orders); err != nil {
			return err
		}
		return c.JSON(orders)
	})

	orderByID := func(c *C) (store.Row, error) {
		id, err := c.ID()
		if err != nil {
			return nil, err
		}
		return c.One(`SELECT * FROM orders WHERE id=?`, id)
	}
	rt.staff("POST /orders/{id}/ready", "staff", func(c *C) error {
		o, err := orderByID(c)
		if err != nil {
			return err
		}
		if o == nil || !map[string]bool{"held": true, "open": true, "sent": true}[str(o["status"])] {
			return conflict("Order not in progress")
		}
		r, err := c.markReady(o, c.U, c.IP(), "")
		if err != nil {
			return err
		}
		return c.JSON(r)
	})
	rt.staff("POST /orders/{id}/fire", "staff", func(c *C) error {
		o, err := orderByID(c)
		if err != nil {
			return err
		}
		if o == nil || str(o["status"]) != "held" {
			return conflict("Only waiting pre-orders can be started")
		}
		if _, err := c.Run(`UPDATE orders SET status='sent', sent_at=? WHERE id=?`, store.Now(), o["id"]); err != nil {
			return err
		}
		if err := c.Audit("preorder.fire", fmt.Sprintf("#%v", o["number"])); err != nil {
			return err
		}
		c.Notify("orders")
		if o["guest_id"] != nil {
			if err := c.pushGuest(i64(o["guest_id"])); err != nil {
				return err
			}
		}
		return c.OK()
	})
	rt.staff("POST /orders/{id}/pay", "staff", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{"method": valid.Enum("cash", "card", "other"), "tipCents": valid.Int().Min(0).Max(1000000).Optional(), "tenderedCents": valid.Int().Min(0).Optional()}))
		if err != nil {
			return err
		}
		o, err := c.One(`SELECT * FROM orders WHERE id=?`, id)
		if err != nil {
			return err
		}
		if o == nil || str(o["status"]) == "paid" || str(o["status"]) == "void" {
			return conflict("Order already closed")
		}
		tip := i64(b["tipCents"])
		if truthy(o["prepaid"]) {
			return conflict("This order was already paid online")
		}
		method := str(b["method"])
		cashPct := f64(c.S()["cash_discount_pct"])
		cashOff := int64(0)
		if method == "cash" && cashPct > 0 {
			cashOff = roundJS(float64(i64(o["subtotal_cents"])-i64(o["discount_cents"])) * cashPct / 100)
			disc := i64(o["discount_cents"]) + cashOff
			if _, err := c.Run(`UPDATE orders SET discount_cents = ?, tax_cents = ? WHERE id = ?`, disc, roundJS(float64(i64(o["subtotal_cents"])-disc)*f64(c.S()["tax_rate"])/100), o["id"]); err != nil {
				return err
			}
			if o, err = c.Get(`SELECT * FROM orders WHERE id=?`, id); err != nil {
				return err
			}
		}
		total := i64(o["subtotal_cents"]) - i64(o["discount_cents"]) + i64(o["tax_cents"]) + i64(o["fee_cents"]) + tip
		owed := dueOf(o) + tip
		_, hasTender := b["tenderedCents"]
		if method == "cash" && hasTender && i64(b["tenderedCents"]) < owed {
			return bad("Not enough cash tendered")
		}
		st := str(o["status"])
		cooking := st == "sent" || st == "open" || st == "held"
		newSt, prepaid := "paid", 0
		if cooking {
			newSt, prepaid = st, 1
			if st == "held" {
				newSt = "sent"
			}
		}
		pm := method
		if truthy(o["gift_cents"]) {
			pm += "+gift"
		}
		now := store.Now()
		if _, err := c.Run(`UPDATE orders SET status=?, prepaid=?, tip_cents=?, total_cents=?, payment_method=?, paid_at=?, sent_at=COALESCE(sent_at, ?) WHERE id=?`, newSt, prepaid, tip, total, pm, now, now, id); err != nil {
			return err
		}
		if o["guest_id"] != nil && str(o["source"]) != "guest" {
			if _, err := c.Run(`UPDATE guests SET status='done', closed_at=? WHERE id=? AND kind='order' AND status IN ('waiting','buzzed','acknowledged')`, now, o["guest_id"]); err != nil {
				return err
			}
		}
		if o["guest_id"] != nil {
			if err := c.pushGuest(i64(o["guest_id"])); err != nil {
				return err
			}
		}
		if err := c.Audit("order.pay", fmt.Sprintf("#%v %s %s", o["number"], method, dollars(total))); err != nil {
			return err
		}
		c.Notify("orders")
		c.Notify("guests")
		change := int64(0)
		if hasTender {
			change = i64(b["tenderedCents"]) - owed
		}
		return c.JSON(M{"ok": true, "totalCents": owed, "cashDiscountCents": cashOff, "changeCents": change})
	})
	rt.staff("POST /orders/{id}/void", "staff", func(c *C) error {
		by, err := c.managerOr("void")
		if err != nil {
			return err
		}
		o, err := orderByID(c)
		if err != nil {
			return err
		}
		if o == nil || str(o["status"]) == "void" {
			return conflict("Cannot void")
		}
		if _, err := c.Run(`UPDATE orders SET status='void' WHERE id=?`, o["id"]); err != nil {
			return err
		}
		if err := c.returnStock(i64(o["id"]), c.U.ID); err != nil {
			return err
		}
		if o["guest_id"] != nil && str(o["source"]) != "guest" {
			if _, err := c.Run(`UPDATE guests SET status='cancelled', closed_at=? WHERE id=? AND kind='order' AND status IN ('waiting','buzzed','acknowledged')`, store.Now(), o["guest_id"]); err != nil {
				return err
			}
		}
		if o["guest_id"] != nil {
			if err := c.pushGuest(i64(o["guest_id"])); err != nil {
				return err
			}
		}
		if err := c.Audit("order.void", fmt.Sprintf("#%v %s%s", o["number"], dollars(i64(o["total_cents"])), approvedNote(by, " (approved by %s)"))); err != nil {
			return err
		}
		if i64(o["total_cents"]) >= 5000 {
			c.alertOwners(c.S()["business_name"]+": order voided", fmt.Sprintf("%s voided order #%v ($%s)%s.", c.U.Name, o["number"], dollars(i64(o["total_cents"])), approvedNote(by, ", approved by %s")), "void")
		}
		c.Notify("orders")
		c.Notify("guests")
		return c.OK()
	})

	/* ---- staff users ---- */
	rt.staff("GET /users", "manager", func(c *C) error {
		rows, err := c.All(`SELECT id, name, role, active, last_login_at, created_at, hourly_cents, totp_enabled, is_driver FROM users ORDER BY active DESC, role DESC, name`)
		if err != nil {
			return err
		}
		if c.U.Role != "owner" {
			for _, r := range rows {
				delete(r, "hourly_cents")
			}
		}
		return c.JSON(rows)
	})
	rt.staff("POST /users", "manager", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{"name": valid.String().Trim().Min(1).Max(40), "role": valid.Enum("owner", "manager", "staff"), "pin": valid.String()}))
		if err != nil {
			return err
		}
		role := str(b["role"])
		if auth.RoleRank[role] >= auth.RoleRank[c.U.Role] && c.U.Role != "owner" {
			return forbidden("You can only add roles below yours")
		}
		if p := auth.PinProblem(str(b["pin"])); p != "" {
			return bad(p)
		}
		if used, err := auth.PinInUse(c.Ctx, c.Tx, str(b["pin"]), 0); err != nil {
			return err
		} else if used {
			return conflict("That PIN is already taken — pick another")
		}
		h, err := auth.HashPin(str(b["pin"]))
		if err != nil {
			return err
		}
		if _, err := c.Run(`INSERT INTO users (name, role, pin_hash) VALUES (?, ?, ?)`, b["name"], role, h); err != nil {
			return err
		}
		if err := c.Audit("user.add", fmt.Sprintf("%s (%s)", str(b["name"]), role)); err != nil {
			return err
		}
		return c.OK()
	})
	rt.staff("PUT /users/{id}", "manager", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		t, err := c.One(`SELECT * FROM users WHERE id=?`, id)
		if err != nil {
			return err
		}
		if t == nil {
			return notFound("Not found")
		}
		if c.U.Role != "owner" && auth.RoleRank[str(t["role"])] >= auth.RoleRank[c.U.Role] && i64(t["id"]) != c.U.ID {
			return forbidden("Not allowed")
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{"name": valid.String().Trim().Min(1).Max(40).Optional(), "role": valid.Enum("owner", "manager", "staff").Optional(), "pin": valid.String().Optional(), "active": valid.Bool().Optional()}))
		if err != nil {
			return err
		}
		role, hasRole := b["role"].(string)
		active, hasActive := b["active"].(bool)
		if hasRole && role != "" && c.U.Role != "owner" {
			return forbidden("Only the owner can change roles")
		}
		if ((hasActive && !active) || (hasRole && role != "owner")) && str(t["role"]) == "owner" {
			n, err := c.N(`SELECT COUNT(*) c FROM users WHERE role='owner' AND active=1`)
			if err != nil {
				return err
			}
			if n <= 1 {
				return bad("You need at least one active owner")
			}
		}
		pinHash, sv := t["pin_hash"], i64(t["session_version"])
		pin := str(b["pin"])
		if pin != "" {
			if p := auth.PinProblem(pin); p != "" {
				return bad(p)
			}
			if used, err := auth.PinInUse(c.Ctx, c.Tx, pin, id); err != nil {
				return err
			} else if used {
				return conflict("That PIN is already taken")
			}
			h, err := auth.HashPin(pin)
			if err != nil {
				return err
			}
			pinHash, sv = h, sv+1
		}
		if (hasActive && !active) || hasRole {
			sv++
		}
		name := t["name"]
		if v, ok := b["name"]; ok {
			name = v
		}
		if !hasRole {
			role = str(t["role"])
		}
		act := t["active"]
		if hasActive {
			act = 0
			if active {
				act = 1
			}
		}
		if _, err := c.Run(`UPDATE users SET name=?, role=?, pin_hash=?, active=?, session_version=? WHERE id=?`, name, role, pinHash, act, sv, id); err != nil {
			return err
		}
		detail := str(t["name"])
		if pin != "" {
			detail += " (PIN reset)"
		}
		if hasActive && !active {
			detail += " (disabled)"
		}
		if err := c.Audit("user.update", detail); err != nil {
			return err
		}
		c.Emit("user:"+itoa(id), "force-lock", nil)
		return c.OK()
	})
	rt.staff("POST /users/{id}/revoke", "manager", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE users SET session_version = session_version + 1 WHERE id=?`, id); err != nil {
			return err
		}
		if err := c.Audit("user.revoke_sessions", itoa(id)); err != nil {
			return err
		}
		c.Emit("user:"+itoa(id), "force-lock", nil)
		return c.OK()
	})
	rt.staff("GET /audit", "manager", func(c *C) error {
		rows, err := c.All(`SELECT * FROM audit ORDER BY id DESC LIMIT 300`)
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})

	/* ---------- customer accounts ---------- */
	custOut := func(r store.Row) M {
		return M{"id": r["id"], "name": r["name"], "email": r["email"], "phone": r["phone"]}
	}
	rt.pub("GET /api/c/me", func(c *C) error {
		cu, err := c.requireCustomer()
		if err != nil {
			return err
		}
		return c.JSON(M{"customer": cu})
	})
	rt.pub("POST /api/c/register", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{
			"name":           valid.String().Trim().Min(1).Max(40),
			"email":          valid.String().Trim().Lower().Max(120).Email("Email looks wrong"),
			"phone":          valid.String().Trim().Max(20).RegexMsg(phoneRE, "Phone looks wrong").Optional().Or(valid.Literal("")),
			"password":       valid.String(),
			"marketingOptIn": valid.Bool().Optional(),
			"ref":            valid.String().Trim().Max(20).Optional(),
		}))
		if err != nil {
			return err
		}
		if p := auth.PasswordProblem(str(b["password"])); p != "" {
			return bad(p)
		}
		if n, _ := c.N(`SELECT COUNT(*) FROM customers WHERE email = ?`, b["email"]); n > 0 {
			return conflict("That email already has an account. Sign in instead.")
		}
		h, err := auth.HashPassword(str(b["password"]))
		if err != nil {
			return err
		}
		res, err := c.Run(`INSERT INTO customers (name, email, phone, pw_hash) VALUES (?, ?, ?, ?)`, b["name"], b["email"], orNil(b["phone"]), h)
		if err != nil {
			return err
		}
		if truthy(b["marketingOptIn"]) {
			if _, err := c.Run(`UPDATE customers SET marketing_opt_in = 1 WHERE id = ?`, res.LastID); err != nil {
				return err
			}
		}
		if truthy(b["ref"]) {
			if _, err := c.G("onCustomerJoined", res.LastID, b["ref"]); err != nil {
				return err
			}
		}
		r, err := c.Get(`SELECT * FROM customers WHERE id = ?`, res.LastID)
		if err != nil {
			return err
		}
		if err := a.sess.IssueCustomer(c.W, c.Slug(), i64(r["id"]), i64(r["session_version"])); err != nil {
			return err
		}
		if err := c.AuditAs(nil, "customer.register", fmt.Sprintf("%s <%s>", str(r["name"]), str(r["email"])), c.IP()); err != nil {
			return err
		}
		return c.JSON(M{"customer": custOut(r)})
	}, a.custLim())

	type attempt struct {
		n     int
		until time.Time
	}
	var attempts = map[string]*attempt{}
	rt.pub("POST /api/c/login", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{"email": valid.String().Trim().Lower().Max(120), "password": valid.String().Max(128)}))
		if err != nil {
			return err
		}
		key := str(b["email"])
		recentFailsMu.Lock()
		at := attempts[key]
		recentFailsMu.Unlock()
		if at != nil && at.until.After(time.Now()) {
			return fail(429, fmt.Sprintf("Too many wrong passwords. Try again in %d min.", int(time.Until(at.until).Minutes())+1))
		}
		r, err := c.One(`SELECT * FROM customers WHERE email = ?`, key)
		if err != nil {
			return err
		}
		ok := false
		if r != nil {
			ok = auth.CheckPassword(str(b["password"]), str(r["pw_hash"]))
		} else {
			auth.BurnCompare(str(b["password"]))
		}
		if !ok {
			recentFailsMu.Lock()
			n := 1
			if at != nil {
				n = at.n + 1
			}
			if n >= 8 {
				attempts[key] = &attempt{0, time.Now().Add(15 * time.Minute)}
			} else {
				attempts[key] = &attempt{n, time.Time{}}
			}
			if len(attempts) > 20000 {
				attempts = map[string]*attempt{}
			}
			recentFailsMu.Unlock()
			return fail(401, "Email or password is wrong")
		}
		recentFailsMu.Lock()
		delete(attempts, key)
		recentFailsMu.Unlock()
		if _, err := c.Run(`UPDATE customers SET last_login_at = ? WHERE id = ?`, store.Now(), r["id"]); err != nil {
			return err
		}
		if err := a.sess.IssueCustomer(c.W, c.Slug(), i64(r["id"]), i64(r["session_version"])); err != nil {
			return err
		}
		return c.JSON(M{"customer": custOut(r)})
	}, a.custLim())
	rt.pub("POST /api/c/logout", func(c *C) error { a.sess.ClearCustomer(c.W); return c.OK() })
	rt.pub("POST /api/c/push", func(c *C) error {
		cu, err := c.requireCustomer()
		if err != nil {
			return err
		}
		sub, err := c.Body(pushSubSchema)
		if err != nil {
			return err
		}
		k := sub["keys"].(valid.M)
		if err := saveSubscription(c.Ctx, c.Tx, nil, cu.ID, str(sub["endpoint"]), str(k["p256dh"]), str(k["auth"])); err != nil {
			return err
		}
		return c.OK()
	})
	rt.pub("GET /api/c/booking-info", func(c *C) error {
		s := c.S()
		today := localNow(s["timezone"]).Date
		days := []string{}
		bd := s["booking_days"]
		for i := 0; i <= int(f64(s["booking_days_ahead"])); i++ {
			d := addDays(today, i)
			if len(bd) == 7 && bd[dow(d)] == '1' {
				days = append(days, d)
			}
		}
		services := []store.Row{}
		if s["business_type"] == "service" {
			var err error
			if services, err = c.All(`SELECT id, name, category, price_cents FROM menu_items WHERE active = 1 ORDER BY sort, id`); err != nil {
				return err
			}
		}
		dep := int64(0)
		if on, err := c.G("depositOn"); err != nil {
			return err
		} else if truthy(on) {
			dep = i64(s["booking_deposit_cents"])
		}
		return c.JSON(M{"enabled": s["booking_enabled"] == "1", "days": days, "services": services, "slotMinutes": f64(s["booking_slot_minutes"]), "currency": s["currency"], "unitLabel": s["unit_label"], "type": s["business_type"],
			"depositCents": dep, "refundHours": f64(s["deposit_refund_hours"])})
	})
	rt.pub("GET /api/c/slots", func(c *C) error {
		date := c.Q("date")
		if !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`).MatchString(date) {
			return bad("Bad date")
		}
		sl, err := c.slotsFor(date)
		if err != nil {
			return err
		}
		return c.JSON(M{"date": date, "slots": sl})
	}, a.publicLim())
	rt.pub("GET /api/c/bookings", func(c *C) error {
		cu, err := c.requireCustomer()
		if err != nil {
			return err
		}
		s := c.S()
		rows, err := c.All(`SELECT b.*, g.token FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id WHERE b.customer_id = ? AND (b.status IN ('booked','checked_in') OR b.created_at > datetime('now','-30 days')) ORDER BY b.start_local DESC LIMIT 30`, cu.ID)
		if err != nil {
			return err
		}
		payOn, err := c.G("onlinePayEnabled")
		if err != nil {
			return err
		}
		out := []M{}
		for _, b := range rows {
			until := minutesUntil(str(b["start_local"]), s["timezone"])
			var text any
			if c.Has("preorderSummary") {
				if text, err = c.G("preorderSummary", b); err != nil {
					return err
				}
			}
			var buzzer, deposit, late any
			if str(b["status"]) == "checked_in" && truthy(b["token"]) {
				buzzer = "/b/" + str(b["token"])
			}
			if truthy(b["deposit_cents"]) {
				deposit = M{"cents": b["deposit_cents"], "status": b["deposit_status"], "code": b["deposit_code"]}
			}
			if truthy(b["late_minutes"]) {
				late = b["late_minutes"]
			}
			booked := str(b["status"]) == "booked"
			out = append(out, M{"id": b["id"], "start": b["start_local"], "service": b["service_name"], "partySize": b["party_size"], "notes": b["notes"], "status": b["status"], "lateMinutes": late,
				"preorder": jparse(b["preorder"], []any{}), "preorderText": text, "canPreorder": s["booking_preorder"] == "1" && booked,
				"canPayPreorder": s["booking_preorder_pay"] == "1" && truthy(payOn) && booked && truthy(b["preorder"]), "preorderPaidCents": i64(b["preorder_paid_cents"]),
				"buzzer": buzzer, "canCheckIn": booked && until <= 60 && until >= -60 && str(b["deposit_status"]) != "pending", "minutesUntil": roundJS(until), "deposit": deposit})
		}
		return c.JSON(out)
	})
	rt.pub("POST /api/c/bookings", func(c *C) error {
		cu, err := c.requireCustomer()
		if err != nil {
			return err
		}
		if c.S()["booking_enabled"] != "1" {
			return forbidden("Online booking is turned off.")
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{
			"date": valid.String().Regex(`^\d{4}-\d{2}-\d{2}$`), "time": valid.String().Regex(`^\d{2}:\d{2}$`),
			"serviceId": valid.Int().Optional(), "partySize": valid.Int().Min(1).Max(20).Optional(), "notes": valid.String().Trim().Max(200).Optional(),
		}))
		if err != nil {
			return err
		}
		mine, err := c.N(`SELECT COUNT(*) c FROM bookings WHERE customer_id = ? AND status = 'booked'`, cu.ID)
		if err != nil {
			return err
		}
		if mine >= 3 {
			return conflict("You already have 3 upcoming bookings. Cancel one to book another.")
		}
		var svc store.Row
		if truthy(b["serviceId"]) {
			if svc, err = c.One(`SELECT id, name FROM menu_items WHERE id = ? AND active = 1`, b["serviceId"]); err != nil {
				return err
			}
		}
		start := str(b["date"]) + " " + str(b["time"])
		// serialize booking for this location so two people can't take the last slot
		if _, err := c.Run(`SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':bookings'))`); err != nil {
			return err
		}
		slots, err := c.slotsFor(str(b["date"]))
		if err != nil {
			return err
		}
		okSlot := false
		for _, s := range slots {
			if s["time"] == str(b["time"]) && i64(s["left"]) >= 1 {
				okSlot = true
			}
		}
		if !okSlot {
			return conflict("That time was just taken. Please pick another.")
		}
		var sid, sname any
		if svc != nil {
			sid, sname = svc["id"], svc["name"]
		}
		party := i64(b["partySize"])
		if party == 0 {
			party = 1
		}
		res, err := c.Run(`INSERT INTO bookings (customer_id, service_id, service_name, party_size, start_local, notes) VALUES (?, ?, ?, ?, ?, ?)`, cu.ID, sid, sname, party, start, orNil(b["notes"]))
		if err != nil {
			return err
		}
		detail := cu.Name + " — " + start
		if svc != nil {
			detail += " (" + str(sname) + ")"
		}
		if err := c.AuditAs(nil, "booking.create", detail, c.IP()); err != nil {
			return err
		}
		var depositURL any
		if c.Has("startDeposit") {
			d, err := c.G("startDeposit", res.LastID)
			if err != nil {
				return err // the whole booking rolls back
			}
			if m, ok := d.(M); ok {
				depositURL = orNil(m["url"])
			}
		}
		c.Notify("bookings")
		return c.JSON(M{"ok": true, "id": res.LastID, "depositUrl": depositURL})
	}, a.custLim())
	rt.pub("POST /api/c/bookings/{id}/late", func(c *C) error {
		cu, err := c.requireCustomer()
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{"minutes": valid.Int().Min(5).Max(60)}))
		if err != nil {
			return err
		}
		id, _ := c.IntParam("id")
		if _, err := c.G("bookingLate", cu.ID, id, b["minutes"]); err != nil {
			return err
		}
		return c.OK()
	})
	rt.pub("POST /api/c/bookings/{id}/cancel", func(c *C) error {
		cu, err := c.requireCustomer()
		if err != nil {
			return err
		}
		id, err := c.ID()
		if err != nil {
			return err
		}
		bk, err := c.One(`SELECT * FROM bookings WHERE id = ? AND customer_id = ? AND status = 'booked'`, id, cu.ID)
		if err != nil {
			return err
		}
		if bk == nil {
			return conflict("That booking can no longer be cancelled here.")
		}
		if _, err := c.Run(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`, bk["id"]); err != nil {
			return err
		}
		note, err := c.G("onBookingCancel", bk, M{"minutesUntil": minutesUntil(str(bk["start_local"]), c.S()["timezone"])})
		if err != nil {
			return err
		}
		if err := c.AuditAs(nil, "booking.cancel", fmt.Sprintf("%s #%s", cu.Name, c.Param("id")), c.IP()); err != nil {
			return err
		}
		c.Notify("bookings")
		return c.JSON(M{"ok": true, "note": orNil(note)})
	})
	rt.pub("POST /api/c/bookings/{id}/checkin", func(c *C) error {
		cu, err := c.requireCustomer()
		if err != nil {
			return err
		}
		id, err := c.ID()
		if err != nil {
			return err
		}
		bk, err := c.One(`SELECT * FROM bookings WHERE id = ? AND customer_id = ?`, id, cu.ID)
		if err != nil {
			return err
		}
		if bk == nil || str(bk["status"]) != "booked" {
			return conflict("This booking is not open for check-in.")
		}
		until := minutesUntil(str(bk["start_local"]), c.S()["timezone"])
		if until > 60 {
			return conflict("Check-in opens 60 minutes before your time.")
		}
		if until < -60 {
			return conflict("This booking time has passed. Please see the front desk.")
		}
		g, err := c.checkInBooking(bk, cu, nil)
		if err != nil {
			return err
		}
		return c.JSON(M{"ok": true, "buzzer": "/b/" + str(g["token"])})
	})

	rt.staff("GET /bookings", "staff", func(c *C) error {
		s := c.S()
		date := localNow(s["timezone"]).Date
		from := c.Q("from")
		if !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`).MatchString(from) {
			from = date
		}
		rows, err := c.All(`SELECT b.*, c.name, c.email, c.phone FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE substr(b.start_local,1,10) BETWEEN ? AND ? ORDER BY b.start_local`, from, addDays(from, 6))
		if err != nil {
			return err
		}
		for _, r := range rows {
			r["preorderText"] = nil
			if c.Has("preorderSummary") {
				if r["preorderText"], err = c.G("preorderSummary", r); err != nil {
					return err
				}
			}
		}
		return c.JSON(M{"today": date, "from": from, "bookings": rows, "capacity": f64(s["booking_capacity"])})
	})
	rt.staff("POST /bookings/{id}/checkin", "staff", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		bk, err := c.One(`SELECT * FROM bookings WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if bk == nil || str(bk["status"]) != "booked" {
			return conflict("Not open for check-in")
		}
		cu, err := c.customerByID(bk["customer_id"])
		if err != nil {
			return err
		}
		if cu == nil {
			return notFound("Not found")
		}
		if _, err := c.checkInBooking(bk, cu, c.U); err != nil {
			return err
		}
		return c.OK()
	})
	rt.staff("POST /bookings/{id}/status", "staff", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{"status": valid.Enum("cancelled", "noshow", "done")}))
		if err != nil {
			return err
		}
		id, err := c.ID()
		if err != nil {
			return err
		}
		bk, err := c.One(`SELECT * FROM bookings WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if bk == nil {
			return notFound("Not found")
		}
		st := str(b["status"])
		if _, err := c.Run(`UPDATE bookings SET status = ? WHERE id = ?`, st, bk["id"]); err != nil {
			return err
		}
		if st == "cancelled" && str(bk["status"]) == "booked" {
			if _, err := c.G("onBookingCancel", bk, M{"byBusiness": true}); err != nil {
				return err
			}
		}
		if st == "noshow" {
			if _, err := c.G("onBookingNoShow", bk); err != nil {
				return err
			}
		}
		if err := c.Audit("booking."+st, fmt.Sprintf("#%v %s", bk["id"], str(bk["start_local"]))); err != nil {
			return err
		}
		c.Notify("bookings")
		return c.OK()
	})
	rt.staff("GET /customers", "manager", func(c *C) error {
		rows, err := c.All(`SELECT c.id, c.name, c.email, c.phone, c.created_at, c.last_login_at,
			(SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id) bookings,
			(SELECT COUNT(*) FROM guests g WHERE g.customer_id = c.id AND g.status IN ('seated','done')) visits
			FROM customers c ORDER BY c.id DESC LIMIT 500`)
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})
}

// attachItems adds each order's lines as "items" (shared by several order lists).
func (c *C) attachItems(orders []store.Row) error {
	if len(orders) == 0 {
		return nil
	}
	ids := make([]string, len(orders))
	for i, o := range orders {
		ids[i] = itoa(i64(o["id"]))
	}
	items, err := c.All(`SELECT * FROM order_items WHERE order_id IN (` + strings.Join(ids, ",") + `)`)
	if err != nil {
		return err
	}
	by := map[int64][]store.Row{}
	for _, it := range items {
		by[i64(it["order_id"])] = append(by[i64(it["order_id"])], it)
	}
	for _, o := range orders {
		l := by[i64(o["id"])]
		if l == nil {
			l = []store.Row{}
		}
		o["items"] = l
	}
	return nil
}
