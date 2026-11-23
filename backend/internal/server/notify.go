package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"html"
	"net"
	"net/http"
	"net/smtp"
	"os"
	"strconv"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
)

// Free notification channels: Web Push and optional email through the business's own SMTP.

type vapidKeys struct {
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
}

// loadVapid uses VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY, else keys saved in the database (the data
// migration copies the Node server's .vapid.json there, so existing phone alerts keep working).
func (a *App) loadVapid(ctx context.Context) error {
	if pub, priv := os.Getenv("VAPID_PUBLIC_KEY"), os.Getenv("VAPID_PRIVATE_KEY"); pub != "" && priv != "" {
		a.vapid = vapidKeys{pub, priv}
		return nil
	}
	var raw string
	err := a.db.Pool.QueryRow(ctx, `SELECT value FROM public.app_secrets WHERE name = 'vapid'`).Scan(&raw)
	if err == nil && json.Unmarshal([]byte(raw), &a.vapid) == nil && a.vapid.PublicKey != "" {
		return nil
	}
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		return err
	}
	b, _ := json.Marshal(vapidKeys{pub, priv})
	if _, err := a.db.Pool.Exec(ctx, `INSERT INTO public.app_secrets (name, value) VALUES ('vapid', $1) ON CONFLICT (name) DO NOTHING`, string(b)); err != nil {
		return err
	}
	if err := a.db.Pool.QueryRow(ctx, `SELECT value FROM public.app_secrets WHERE name = 'vapid'`).Scan(&raw); err != nil {
		return err
	}
	return json.Unmarshal([]byte(raw), &a.vapid)
}

type pushResult struct {
	Sent    int `json:"sent"`
	Devices int `json:"devices"`
}

// sendPush delivers a notification to each unique subscription; dead ones (404/410) are removed.
func (a *App) sendPush(ctx context.Context, tx *store.Tx, subs []store.Row, payload map[string]any) pushResult {
	body, _ := json.Marshal(payload)
	seen := map[string]bool{}
	res := pushResult{}
	subject := os.Getenv("VAPID_SUBJECT")
	if subject == "" {
		subject = "mailto:alerts@buzzhub.app"
	}
	for _, s := range subs {
		ep := store.Str(s["endpoint"])
		if seen[ep] {
			continue
		}
		seen[ep] = true
		res.Devices++
		resp, err := webpush.SendNotificationWithContext(ctx, body, &webpush.Subscription{Endpoint: ep, Keys: webpush.Keys{P256dh: store.Str(s["p256dh"]), Auth: store.Str(s["auth"])}},
			&webpush.Options{HTTPClient: pushClient, Subscriber: subject, VAPIDPublicKey: a.vapid.PublicKey, VAPIDPrivateKey: a.vapid.PrivateKey, TTL: 900, Urgency: webpush.UrgencyHigh})
		if err != nil {
			continue
		}
		resp.Body.Close()
		if resp.StatusCode == 404 || resp.StatusCode == 410 {
			_, _ = tx.Run(ctx, `DELETE FROM push_subs WHERE id = ?`, s["id"])
			continue
		}
		if resp.StatusCode < 300 {
			res.Sent++
		}
	}
	return res
}

func (a *App) devicesForGuest(ctx context.Context, tx *store.Tx, guestID int64) ([]store.Row, error) {
	cid, err := tx.Val(ctx, `SELECT customer_id FROM guests WHERE id = ?`, guestID)
	if err != nil {
		return nil, err
	}
	c := int64(-1)
	if cid != nil {
		c = store.Int(cid)
	}
	return tx.All(ctx, `SELECT * FROM push_subs WHERE guest_id = ? OR (customer_id IS NOT NULL AND customer_id = ?)`, guestID, c)
}

func (a *App) pushToGuest(ctx context.Context, tx *store.Tx, guestID int64, payload map[string]any) pushResult {
	subs, err := a.devicesForGuest(ctx, tx, guestID)
	if err != nil {
		return pushResult{}
	}
	return a.sendPush(ctx, tx, subs, payload)
}

func (a *App) pushToCustomer(ctx context.Context, tx *store.Tx, customerID int64, payload map[string]any) pushResult {
	subs, err := tx.All(ctx, `SELECT * FROM push_subs WHERE customer_id = ?`, customerID)
	if err != nil {
		return pushResult{}
	}
	return a.sendPush(ctx, tx, subs, payload)
}

// pushToUsers sends staff alerts to everyone with one of the roles (or only one person).
func (a *App) pushToUsers(ctx context.Context, tx *store.Tx, roles []string, payload map[string]any, onlyUser int64) pushResult {
	ph := strings.TrimSuffix(strings.Repeat("?,", len(roles)), ",")
	args := []any{}
	for _, r := range roles {
		args = append(args, r)
	}
	q := `SELECT p.* FROM push_subs p JOIN users u ON u.id = p.user_id WHERE u.active = 1 AND u.role IN (` + ph + `)`
	if onlyUser > 0 {
		q += ` AND u.id = ?`
		args = append(args, onlyUser)
	}
	subs, err := tx.All(ctx, q, args...)
	if err != nil {
		return pushResult{}
	}
	return a.sendPush(ctx, tx, subs, payload)
}

// saveSubscription links a browser to a waitlist visit and/or a customer account (max 3 each).
func saveSubscription(ctx context.Context, tx *store.Tx, guestID, customerID any, endpoint, p256dh, authKey string) error {
	col, owner := "guest_id", guestID
	if customerID != nil {
		col, owner = "customer_id", customerID
	}
	existing, err := tx.All(ctx, `SELECT id FROM push_subs WHERE `+col+` = ? ORDER BY id`, owner)
	if err != nil {
		return err
	}
	if len(existing) >= 3 {
		if _, err := tx.Run(ctx, `DELETE FROM push_subs WHERE id = ?`, existing[0]["id"]); err != nil {
			return err
		}
	}
	_, err = tx.Run(ctx, `INSERT INTO push_subs (guest_id, customer_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(endpoint) DO UPDATE SET guest_id = COALESCE(excluded.guest_id, push_subs.guest_id), customer_id = COALESCE(excluded.customer_id, push_subs.customer_id), p256dh = excluded.p256dh, auth = excluded.auth`,
		guestID, customerID, endpoint, p256dh, authKey)
	return err
}

/* ---------- email ---------- */

type emailMsg struct {
	BusinessName, Subject, Message, Link, Accent, Button, Unsubscribe string
}

// emailGuest sends a simple branded email. Returns false when email isn't set up.
func emailGuest(to string, m emailMsg) (bool, error) {
	host, user, pass := os.Getenv("SMTP_HOST"), os.Getenv("SMTP_USER"), os.Getenv("SMTP_PASS")
	if host == "" || user == "" || pass == "" || to == "" {
		return false, nil
	}
	if m.Accent == "" {
		m.Accent = "#ffb020"
	}
	if m.Button == "" {
		m.Button = "Open my buzzer"
	}
	port, _ := strconv.Atoi(os.Getenv("SMTP_PORT"))
	if port == 0 {
		port = 587
	}
	from := os.Getenv("SMTP_FROM")
	if from == "" {
		from = fmt.Sprintf(`"%s" <%s>`, strings.ReplaceAll(m.BusinessName, `"`, ""), user)
	}
	esc := html.EscapeString
	text := m.Message + "\n\n" + m.Button + ": " + m.Link
	if m.Unsubscribe != "" {
		text += "\n\nNo longer want offers? Unsubscribe: " + m.Unsubscribe
	}
	foot := esc(m.BusinessName)
	if m.Unsubscribe != "" {
		foot += ` · <a href="` + esc(m.Unsubscribe) + `" style="color:#888">Unsubscribe from offers</a>`
	}
	htmlBody := `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px"><h2 style="margin:0 0 8px">` + esc(m.Subject) + `</h2><p style="font-size:16px;color:#333">` + esc(m.Message) +
		`</p><p><a href="` + esc(m.Link) + `" style="display:inline-block;background:` + esc(m.Accent) + `;color:#1a1406;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">` + esc(m.Button) + `</a></p><p style="color:#888;font-size:12px">` + foot + `</p></div>`
	boundary := fmt.Sprintf("bh%d", time.Now().UnixNano())
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nDate: %s\r\n", from, to, mimeHeader(m.BusinessName+": "+m.Subject), time.Now().Format(time.RFC1123Z))
	if m.Unsubscribe != "" {
		fmt.Fprintf(&b, "List-Unsubscribe: <%s>\r\n", m.Unsubscribe)
	}
	fmt.Fprintf(&b, "Content-Type: multipart/alternative; boundary=%s\r\n\r\n--%s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n--%s\r\nContent-Type: text/html; charset=utf-8\r\n\r\n%s\r\n--%s--\r\n", boundary, boundary, text, boundary, htmlBody, boundary)
	return true, sendMail(host, port, user, pass, user, []string{to}, []byte(b.String()))
}

func mimeHeader(s string) string {
	for _, r := range s {
		if r > 127 {
			return "=?utf-8?b?" + b64(s) + "?="
		}
	}
	return s
}

func sendMail(host string, port int, user, pass, from string, to []string, msg []byte) error {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	authn := smtp.PlainAuth("", user, pass, host)
	if port == 465 { // implicit TLS
		conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 15 * time.Second}, "tcp", addr, &tls.Config{ServerName: host})
		if err != nil {
			return err
		}
		c, err := smtp.NewClient(conn, host)
		if err != nil {
			return err
		}
		defer c.Close()
		if err := c.Auth(authn); err != nil {
			return err
		}
		if err := c.Mail(from); err != nil {
			return err
		}
		for _, t := range to {
			if err := c.Rcpt(t); err != nil {
				return err
			}
		}
		w, err := c.Data()
		if err != nil {
			return err
		}
		if _, err := w.Write(msg); err != nil {
			return err
		}
		if err := w.Close(); err != nil {
			return err
		}
		return c.Quit()
	}
	return smtp.SendMail(addr, authn, from, to, msg) // STARTTLS when offered
}

var pushClient = &http.Client{Timeout: 8 * time.Second}
