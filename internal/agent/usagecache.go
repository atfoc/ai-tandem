package agent

import (
	"sync"
	"time"

	"ai-whiteboard/internal/model"
)

// UsageCache keeps the last usage result in memory for TTL, so clicks close together share
// one run of the agent's usage command. Callers that come while a run is going wait for it.
// Nothing is stored.
type UsageCache struct {
	Fetch func() (model.PlanUsage, error)
	TTL   time.Duration
	Now   func() time.Time // nil = time.Now; for tests

	mu     sync.Mutex
	last   *model.PlanUsage // the last good result
	lastAt time.Time        // when it was fetched
	run    *usageRun        // the run going now
}

type usageRun struct {
	done chan struct{}
	u    model.PlanUsage
	err  error
}

// Get returns the cached result while it is fresh, else runs Fetch. fresh skips the cache.
func (c *UsageCache) Get(fresh bool) (model.PlanUsage, error) {
	now := c.Now
	if now == nil {
		now = time.Now
	}
	c.mu.Lock()
	if !fresh && c.last != nil && now().Sub(c.lastAt) < c.TTL {
		u := *c.last
		c.mu.Unlock()
		return u, nil
	}
	r := c.run
	if r == nil {
		r = &usageRun{done: make(chan struct{})}
		c.run = r
		go func() {
			u, err := c.Fetch()
			c.mu.Lock()
			if err == nil {
				c.lastAt = now()
				if u.FetchedAt.IsZero() { // Fetch may know when its numbers are from
					u.FetchedAt = c.lastAt
				}
				c.last = &u
			}
			r.u, r.err = u, err
			c.run = nil
			c.mu.Unlock()
			close(r.done)
		}()
	}
	c.mu.Unlock()
	<-r.done
	return r.u, r.err
}
