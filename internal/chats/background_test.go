package chats

import (
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

func TestWaitsOnBackground(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		b    agent.Background
		want bool
	}{
		{agent.Background{}, false},
		{agent.Background{Running: 1}, true},
		{agent.Background{Unread: true}, true},
		{agent.Background{Running: 2, Unread: true}, true},
	} {
		if got := waitsOnBackground(tc.b); got != tc.want {
			t.Errorf("waitsOnBackground(%+v) = %v, want %v", tc.b, got, tc.want)
		}
	}
}

// loadedChat is a chat of e whose transcript is in memory.
func (e *env) loadedChat() *Chat {
	e.t.Helper()
	v := e.create(model.Claude, gOne, "")
	c, err := e.m.get(v.ID)
	if err != nil {
		e.t.Fatal(err)
	}
	var out outbox
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := e.m.trOf(c, &out); err != nil {
		e.t.Fatal(err)
	}
	return c
}

func TestBgQuietFiresOnlyWithoutATurnSign(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	const quiet = 20 * time.Millisecond
	e.m.bgQuietWait = quiet
	c := e.loadedChat()

	var fired atomic.Int32
	fire := func(*outbox, *after) { fired.Add(1) }
	arm := func() {
		c.mu.Lock()
		e.m.armBgQuiet(c, &c.bg, fire)
		c.mu.Unlock()
	}

	arm()
	waitFor(t, "the quiet wait to fire", func() bool { return fired.Load() == 1 })

	// A turn sign before it is over cancels it.
	arm()
	c.mu.Lock()
	c.bg.turnSign()
	c.mu.Unlock()
	time.Sleep(10 * quiet)
	if n := fired.Load(); n != 1 {
		t.Fatalf("fired %d times after a turn sign, want it to stay at 1", n)
	}

	// So does the chat being deleted.
	arm()
	c.mu.Lock()
	c.deleted = true
	c.mu.Unlock()
	time.Sleep(10 * quiet)
	if n := fired.Load(); n != 1 {
		t.Fatalf("fired %d times after the chat was deleted, want it to stay at 1", n)
	}
	c.mu.Lock()
	armed := c.bg.armed
	c.mu.Unlock()
	if armed != 3 {
		t.Errorf("armed %d times, want 3", armed)
	}
}

func TestWaitingIsBusyNotInTurn(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	c := e.loadedChat()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.tr.SetStatus(model.StatusWaiting)
	if !busy(c) || inTurn(c) {
		t.Errorf("waiting: busy %v, inTurn %v, want true and false", busy(c), inTurn(c))
	}
	c.tr.SetStatus(model.StatusThinking)
	if !busy(c) || !inTurn(c) {
		t.Errorf("thinking: busy %v, inTurn %v, want both true", busy(c), inTurn(c))
	}
	c.tr.SetStatus(model.StatusReady)
	if busy(c) || inTurn(c) {
		t.Errorf("ready: busy %v, inTurn %v, want both false", busy(c), inTurn(c))
	}
	if pubOf(model.StatusWaiting) != pubWorking {
		t.Errorf("pubOf(waiting) = %d, want pubWorking", pubOf(model.StatusWaiting))
	}
}
