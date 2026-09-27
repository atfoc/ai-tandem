package agent

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

var cacheNow = time.Date(2026, 9, 26, 18, 54, 40, 0, time.UTC)

func TestUsageCache(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	fail := false
	clock := cacheNow
	c := &UsageCache{TTL: time.Minute, Now: func() time.Time { return clock },
		Fetch: func() (model.PlanUsage, error) {
			calls.Add(1)
			<-release
			if fail {
				return model.PlanUsage{}, errors.New("boom")
			}
			return model.PlanUsage{Plan: true, Limits: []model.UsageLimit{{Kind: "session", Percent: float64(calls.Load())}}}, nil
		}}

	// Callers during a run share it.
	var wg sync.WaitGroup
	got := make([]model.PlanUsage, 3)
	for i := range got {
		wg.Add(1)
		go func() { defer wg.Done(); got[i], _ = c.Get(false) }()
	}
	for c.running() == nil {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond) // let the others join
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("%d runs, want 1", calls.Load())
	}
	for _, u := range got {
		if !u.Plan || !u.FetchedAt.Equal(cacheNow) {
			t.Fatalf("got %+v", u)
		}
	}

	// Fresh within the TTL: no run. fresh: a run.
	clock = cacheNow.Add(59 * time.Second)
	if u, _ := c.Get(false); calls.Load() != 1 || u.Limits[0].Percent != 1 {
		t.Fatalf("cached: %d runs, %+v", calls.Load(), u)
	}
	if u, _ := c.Get(true); calls.Load() != 2 || u.Limits[0].Percent != 2 {
		t.Fatalf("fresh: %d runs, %+v", calls.Load(), u)
	}
	clock = clock.Add(time.Minute)
	if c.Get(false); calls.Load() != 3 {
		t.Fatalf("stale: %d runs", calls.Load())
	}

	// A failed run is not cached, and keeps the last good result.
	fail = true
	if _, err := c.Get(true); err == nil || calls.Load() != 4 {
		t.Fatalf("fail: %v, %d runs", err, calls.Load())
	}
	if u, err := c.Get(false); err != nil || calls.Load() != 4 || u.Limits[0].Percent != 3 {
		t.Fatalf("after fail: %v, %d runs, %+v", err, calls.Load(), u)
	}
}

func (c *UsageCache) running() *usageRun {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.run
}

// A Fetch that knows when its numbers are from keeps that time; the TTL still counts from the run.
func TestUsageCacheKeepsFetchedAt(t *testing.T) {
	var calls int
	old := cacheNow.Add(-10 * time.Minute)
	c := &UsageCache{TTL: time.Minute, Now: func() time.Time { return cacheNow },
		Fetch: func() (model.PlanUsage, error) { calls++; return model.PlanUsage{Plan: true, FetchedAt: old}, nil }}
	if u, _ := c.Get(false); !u.FetchedAt.Equal(old) {
		t.Fatalf("fetchedAt %v, want %v", u.FetchedAt, old)
	}
	if c.Get(false); calls != 1 {
		t.Fatalf("%d runs, want 1 (cached)", calls)
	}
}
