package chats

import (
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// fastRetries makes the pauses of the retry short and exact: four of 20 ms, without jitter. A test
// that must sit between attempts sets them to an hour instead.
func fastRetries(e *env) {
	e.m.retryWaits = [retryAttempts]time.Duration{20 * time.Millisecond, 20 * time.Millisecond, 20 * time.Millisecond, 20 * time.Millisecond}
	e.m.retryJitter = func(d time.Duration) time.Duration { return d }
}

// pauseByHand pauses the running subagent sid of chat id as the retry does when its attempts have
// run out (D9), without what the other chunks add: no parent is told (tellPaused). Its process is
// detached as stopSub detaches it and closed after the lock is released.
func (e *env) pauseByHand(id, sid, reason string, kind agent.Temporary) {
	e.t.Helper()
	var out outbox
	c, err := e.m.lock(id)
	if err != nil {
		e.t.Fatal(err)
	}
	s := c.subs[sid]
	if s == nil {
		c.mu.Unlock()
		e.t.Fatalf("no subagent %s", sid)
	}
	var ag agent.Agent
	if s.ag != nil {
		e.m.denySubPerms(c, s)
		ag = s.ag
		s.ag = nil
	}
	s.meta.Status, s.meta.Ended = model.SubPaused, e.m.nowMs()
	s.meta.Error, s.meta.ErrorKind, s.meta.Cause = reason, string(kind), model.CauseRetriesFailed
	s.meta.Retry, s.meta.Waiting, s.meta.BgWaiting = model.Retry{}, false, false
	e.m.endSub(c, s, &out)
	if s.app {
		e.m.revokeExtra(c.meta.ID, s.meta.ID)
	}
	closeStop(s)
	c.mu.Unlock()
	e.m.send(out)
	closeAgents([]agent.Agent{ag})
}

func TestPauseByHand(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.idleParent()
	sa, pa := e.child(id, "", "work")
	e.pauseByHand(id, sa.ID, "Failed to authenticate", agent.TempLogin)
	got := e.subFile(id, sa.ID)
	if got.Status != model.SubPaused || got.Error != "Failed to authenticate" || got.ErrorKind != "login" ||
		got.Cause != model.CauseRetriesFailed || got.Ended == 0 || got.Retry != (model.Retry{}) || got.Waiting {
		t.Fatalf("the record on disk: %+v", got)
	}
	if got.Delivery.Owed() {
		t.Fatalf("a paused subagent leaves its result owed: %+v", got)
	}
	closed(t, "the paused subagent's process", pa)
}
