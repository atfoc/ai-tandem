package agent

import (
	"context"
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
	lastAt time.Time        // when an explicit check last succeeded
	run    *usageRun        // the run going now
	latest *usageRun        // the last started check, including failures
}

type usageRun struct {
	done    chan struct{}
	started time.Time
	u       model.PlanUsage
	err     error
}

// Get returns the current result within the TTL. A forced check waits out the
// cooldown first. Concurrent callers share a check, including one that fails.
func (c *UsageCache) Get(ctx context.Context, fresh bool) (model.PlanUsage, error) {
	now := c.Now
	if now == nil {
		now = time.Now
	}
	c.mu.Lock()
	previous := c.latest
	for {
		if err := ctx.Err(); err != nil {
			c.mu.Unlock()
			return model.PlanUsage{}, err
		}
		if !fresh && c.last != nil && now().Sub(c.lastAt) < c.TTL &&
			(c.run != nil || c.latest == nil || c.latest.err == nil || c.last.FetchedAt.After(c.latest.started)) {
			u := *c.last
			c.mu.Unlock()
			return u, nil
		}
		if c.run != nil || (fresh && c.latest != previous) {
			r := c.latest
			c.mu.Unlock()
			return r.wait(ctx)
		}
		var delay time.Duration
		if c.latest != nil {
			delay = c.latest.started.Add(c.TTL).Sub(now())
		}
		if delay <= 0 {
			r := c.startLocked(now)
			c.mu.Unlock()
			return r.wait(ctx)
		}
		if !fresh {
			r := c.latest
			c.mu.Unlock()
			return r.wait(ctx)
		}
		c.mu.Unlock()
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return model.PlanUsage{}, ctx.Err()
		case <-timer.C:
		}
		c.mu.Lock()
	}
}

func (r *usageRun) wait(ctx context.Context) (model.PlanUsage, error) {
	select {
	case <-ctx.Done():
		return model.PlanUsage{}, ctx.Err()
	case <-r.done:
		return r.u, r.err
	}
}

func (c *UsageCache) startLocked(now func() time.Time) *usageRun {
	r := &usageRun{done: make(chan struct{}), started: now()}
	c.run, c.latest = r, r
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
	return r
}

// Update merges a sparse passive snapshot into the last good result and leaves the
// check cooldown alone. A completed explicit check replaces the merged snapshot.
func (c *UsageCache) Update(u model.PlanUsage) model.PlanUsage {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.last != nil {
		if c.last.FetchedAt.After(u.FetchedAt) {
			return *c.last
		}
		limits := append([]model.UsageLimit(nil), c.last.Limits...)
		for _, l := range u.Limits {
			found := false
			for i := range limits {
				if limits[i].Kind == l.Kind {
					if l.ResetsAt.IsZero() {
						l.ResetsAt = limits[i].ResetsAt
					}
					limits[i] = l
					found = true
					break
				}
			}
			if !found {
				limits = append(limits, l)
			}
		}
		u.Limits = limits
		if u.Note == "" && c.last.Plan {
			u.Note = c.last.Note
		}
	}
	c.last = &u
	return u
}
