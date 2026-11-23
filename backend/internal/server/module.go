package server

import (
	"context"
	"net/http"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
)

// Each ported Node module adds its register function here from an init() in its own file:
//
//	func init() { modules = append(modules, (*App).registerKds) }
//
// so modules never need to edit a shared list.
var modules []func(a *App, rt *router)

// job is background work that runs on a timer for every location (Node's setInterval + forEachLocation).
type job struct {
	name  string
	every time.Duration
	fn    func(c *C) error
}

// every registers a background job; call it from a module's register function.
func (a *App) every(name string, d time.Duration, fn func(c *C) error) {
	a.jobs = append(a.jobs, job{name, d, fn})
}

func (a *App) startJobs(ctx context.Context) {
	for _, j := range a.jobs {
		j := j
		go func() {
			t := time.NewTicker(j.every)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					for _, slug := range a.allSlugs(ctx) {
						jctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
						err := a.db.In(jctx, slug, func(tx *store.Tx) error {
							return j.fn(&C{a: a, Tx: tx, Ctx: jctx, R: &http.Request{Header: http.Header{}}, W: newBuf()})
						})
						cancel()
						if err != nil {
							a.log.Error("job failed", "job", j.name, "location", slug, "err", err)
						}
					}
				}
			}
		}()
	}
}
