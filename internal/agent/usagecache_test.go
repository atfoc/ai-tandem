package agent

import (
	"context"
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
		go func() { defer wg.Done(); got[i], _ = c.Get(context.Background(), false) }()
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

	// The cached result holds until the next check is allowed.
	clock = cacheNow.Add(59 * time.Second)
	if u, _ := c.Get(context.Background(), false); calls.Load() != 1 || u.Limits[0].Percent != 1 {
		t.Fatalf("cached: %d runs, %+v", calls.Load(), u)
	}
	clock = cacheNow.Add(time.Minute)
	if u, _ := c.Get(context.Background(), true); calls.Load() != 2 || u.Limits[0].Percent != 2 {
		t.Fatalf("fresh: %d runs, %+v", calls.Load(), u)
	}
	clock = clock.Add(time.Minute)
	if c.Get(context.Background(), false); calls.Load() != 3 {
		t.Fatalf("stale: %d runs", calls.Load())
	}

	// A failed run is paced too, and keeps the last good result in memory.
	fail = true
	clock = clock.Add(time.Minute)
	if _, err := c.Get(context.Background(), true); err == nil || calls.Load() != 4 {
		t.Fatalf("fail: %v, %d runs", err, calls.Load())
	}
	if _, err := c.Get(context.Background(), false); err == nil || calls.Load() != 4 {
		t.Fatalf("after fail: %v, %d runs", err, calls.Load())
	}
	if c.last == nil || c.last.Limits[0].Percent != 3 {
		t.Fatalf("last good result: %+v", c.last)
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
	if u, _ := c.Get(context.Background(), false); !u.FetchedAt.Equal(old) {
		t.Fatalf("fetchedAt %v, want %v", u.FetchedAt, old)
	}
	if c.Get(context.Background(), false); calls != 1 {
		t.Fatalf("%d runs, want 1 (cached)", calls)
	}
}

func TestUsageOverviewPacesFailuresAndForcedChecks(t *testing.T) {
	ctx := context.Background()
	var calls atomic.Int32
	c := &UsageCache{TTL: 200 * time.Millisecond, Fetch: func() (model.PlanUsage, error) {
		if calls.Add(1) == 1 {
			return model.PlanUsage{}, errors.New("unavailable")
		}
		return model.PlanUsage{Plan: true}, nil
	}}
	for range 2 {
		if _, err := c.Get(ctx, false); err == nil || calls.Load() != 1 {
			t.Fatalf("a failure should be returned during the cooldown: calls=%d err=%v", calls.Load(), err)
		}
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := c.Get(canceled, true); !errors.Is(err, context.Canceled) || calls.Load() != 1 {
		t.Fatalf("canceled refresh: calls=%d err=%v", calls.Load(), err)
	}
	began := c.latest.started
	if u, err := c.Get(ctx, true); err != nil || !u.Plan || calls.Load() != 2 {
		t.Fatalf("fresh check: calls=%d usage=%+v err=%v", calls.Load(), u, err)
	}
	if elapsed := c.latest.started.Sub(began); elapsed < c.TTL {
		t.Fatalf("fresh check ran after %s, before cooldown %s", elapsed, c.TTL)
	}
}

func TestPassiveUsageMergesAndLaterCheckReplacesIt(t *testing.T) {
	now := cacheNow
	c := &UsageCache{TTL: time.Minute, Now: func() time.Time { return now }}
	c.Fetch = func() (model.PlanUsage, error) {
		return model.PlanUsage{Plan: true, Limits: []model.UsageLimit{
			{Kind: "codex_primary", Percent: 12, ResetsAt: cacheNow.Add(time.Hour)},
			{Kind: "codex_secondary", Percent: 23},
		}}, nil
	}
	if _, err := c.Get(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute / 2)
	passive := c.Update(model.PlanUsage{Plan: true, FetchedAt: now, Limits: []model.UsageLimit{{Kind: "codex_primary", Percent: 35}}})
	got, err := c.Get(context.Background(), false)
	if err != nil || got.Limits[0].Percent != 35 || got.Limits[0].ResetsAt.IsZero() || len(got.Limits) != 2 || !got.FetchedAt.Equal(passive.FetchedAt) {
		t.Fatalf("passive usage: %+v, %v", got, err)
	}
	c.Fetch = func() (model.PlanUsage, error) {
		return model.PlanUsage{Plan: true, Limits: []model.UsageLimit{{Kind: "codex_primary", Percent: 42}}}, nil
	}
	now = now.Add(time.Minute / 2)
	got, err = c.Get(context.Background(), true)
	if err != nil || len(got.Limits) != 1 || got.Limits[0].Percent != 42 {
		t.Fatalf("fresh usage: %+v, %v", got, err)
	}
}
