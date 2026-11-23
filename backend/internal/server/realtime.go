package server

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/zishang520/socket.io/v2/socket"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
)

// Live updates use Socket.IO v4, the same protocol and events as the Node server, so the
// React client needs no changes. Rooms are prefixed with the location slug ("main:staff").

type sockData struct {
	Slug    string
	User    *auth.User
	GuestID int64
}

func (a *App) setupRealtime() http.Handler {
	opts := socket.DefaultServerOptions()
	opts.SetCors(nil)
	io := socket.NewServer(nil, opts)
	a.io = io
	io.Use(func(s *socket.Socket, next func(*socket.ExtendedError)) {
		hs := s.Handshake()
		authMap, _ := hs.Auth.(map[string]any)
		cookies := parseCookieHeader(strings.Join(hs.Headers["cookie"], "; "))
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		d := &sockData{Slug: "main"}
		gt, _ := authMap["guestToken"].(string)
		if gt != "" {
			if slug := a.slugForToken(ctx, "guests", "token", gt); slug != "" {
				d.Slug = slug
			}
		} else {
			loc, _ := authMap["loc"].(string)
			for _, p := range []string{loc, a.sess.LocOf(cookies[auth.SessionCookie]), cookies["bh_loc"]} {
				if p != "" && a.db.LocationExists(ctx, p) {
					d.Slug = p
					break
				}
			}
		}
		_ = a.db.In(ctx, d.Slug, func(tx *store.Tx) error {
			if u, err := a.sess.UserFromToken(ctx, tx, cookies[auth.SessionCookie]); err == nil {
				d.User = u
				return nil
			}
			if gt != "" {
				if g, _ := a.guestByToken(ctx, tx, gt); g != nil {
					d.GuestID = store.Int(g["id"])
				}
			}
			return nil
		})
		if d.User == nil && d.GuestID == 0 {
			next(socket.NewExtendedError("unauthorized", nil))
			return
		}
		s.SetData(d)
		next(nil)
	})
	io.On("connection", func(clients ...any) {
		s := clients[0].(*socket.Socket)
		d, _ := s.Data().(*sockData)
		if d == nil {
			return
		}
		L := d.Slug
		s.Join(socket.Room(L + ":all"))
		if d.User != nil {
			s.Join(socket.Room(L+":staff"), socket.Room(L+":user:"+itoa(d.User.ID)))
			if auth.RoleRank[d.User.Role] >= auth.RoleRank["manager"] {
				s.Join(socket.Room(L + ":owners"))
			}
		} else if d.GuestID != 0 {
			s.Join(socket.Room(L + ":guest:" + itoa(d.GuestID)))
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				_ = a.db.In(ctx, L, func(tx *store.Tx) error { return a.pushGuest(ctx, tx, d.GuestID) })
			}()
		}
	})
	return io.ServeHandler(opts)
}

// emitTo sends an event to a room in the transaction's location ("staff", "owners", "guest:12", "user:3").
// Events are queued and sent after the transaction commits, so clients never see uncommitted data.
func (a *App) emitTo(tx *store.Tx, room, event string, data any) {
	slug := tx.Slug
	tx.AfterCommit(func() {
		if a.io != nil {
			a.io.To(socket.Room(slug+":"+room)).Emit(event, data)
		}
	})
}

// notifyStaff tells staff screens that a scope changed so they refetch it.
func (a *App) notifyStaff(tx *store.Tx, scope string) {
	a.emitTo(tx, "staff", "sync", map[string]any{"scope": scope, "at": time.Now().UnixMilli()})
}

func parseCookieHeader(h string) map[string]string {
	out := map[string]string{}
	for _, c := range (&http.Request{Header: http.Header{"Cookie": {h}}}).Cookies() {
		out[c.Name] = c.Value
	}
	return out
}
