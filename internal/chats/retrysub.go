// The retry and the pause of a subagent after a temporary error (design D8, D9, D11; goal 2.1,
// 2.2, 2.6, 3.1–3.4, 6.4). A turn of an app-spawned subagent that ends with a temporary error does
// not finish it: its process is closed and it stays running, so it counts against the cap, what it
// started runs on, and what is owed to it stays owed (deliverSub needs a process). After a pause
// (the timer) and a slot of the gate, the attempt starts it again on its recorded session through
// startSub, with the carry-on block, the results it is owed and the list of its paused and stopped
// children. Its first reply ends the retrying; a further temporary failure is the next attempt;
// the failure after the last attempt pauses it.
//
// Every field of a retry (sub.retry) is guarded by c.mu. The timer and the gate's start run with no
// lock held and look again under it: a retry that was cancelled, or replaced, meanwhile is no longer
// s.retry, and its start does nothing. Every path that takes a subagent out of running (stopSub,
// finalizeAppSub, pauseSub) cancels its retry, so that no timer, slot or token is left behind.
package chats

import (
	"errors"
	"fmt"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// subTempFail is D8: s's turn ended with a temporary error. The results its turn carried are owed
// again, its process is closed, and it waits for its next attempt; after the last one it is
// paused. Its parent is handed nothing. c.mu held; what to close goes to aft.
func (m *Manager) subTempFail(c *Chat, s *sub, ev agent.Event, out *outbox, aft *after) {
	sid := s.meta.ID
	if d := s.carry; d != nil {
		s.carry = nil
		if !d.settled {
			// The results were not received, and no attempt of theirs failed: the retry carries them.
			m.unreceived(c, d, false, false, out)
		}
	}
	n := 1
	if w := s.retry; w != nil {
		n = w.attempt + 1
		w.cancel(m.retryGate) // the slot of the attempt that failed
		s.retry = nil
	}
	m.denySubPerms(c, s)
	aft.close = append(aft.close, s.ag)
	s.ag = nil
	closeStop(s)
	m.revokeExtra(c.meta.ID, sid)
	// Its background work ends with the process (design R3). The generation is kept, so a quiet
	// wait armed before does nothing.
	s.bg.report(agent.Background{})

	if n > retryAttempts {
		m.subErrorNote(c, s, ev.Error, out)
		m.subNote(c, s, "muted", pausedNote(), out)
		m.pauseSub(c, s, ev.Error, ev.Temporary, model.CauseRetriesFailed, true, out, aft)
		m.logRetry(c.meta.ID, sid, fmt.Sprintf("paused after %d attempts (%s): %s", retryAttempts, ev.Temporary, quoteErr(ev.Error)))
		return
	}
	wait := m.retryJitter(m.retryWaits[n-1])
	w := &retryWait{attempt: n, kind: ev.Temporary, reason: ev.Error, at: m.now().Add(wait)}
	w.timer = time.AfterFunc(wait, func() { m.subRetryFire(c, sid, w) })
	s.retry = w
	s.meta.Retry = w.model()
	s.meta.Waiting, s.meta.BgWaiting = false, false
	m.subErrorNote(c, s, retryNote(string(ev.Temporary), ev.Error, n, wait), out)
	m.flushSub(c, s, false)
	out.emitSub(c, s.meta)
	m.logRetry(c.meta.ID, sid, fmt.Sprintf("attempt %d/%d in %s (%s): %s", n, retryAttempts, waitWords(wait), ev.Temporary, quoteErr(ev.Error)))
}

// subNote adds a note of tone to s's thread. c.mu held.
func (m *Manager) subNote(c *Chat, s *sub, tone, text string, out *outbox) {
	tr, err := m.subTr(c, s)
	if err != nil {
		return
	}
	out.emitSubItems(c, s.meta.ID, tr.Version(), tr.AddNote(tone, text))
}

// subRetryOff reports whether c's subagent s may not start its attempt: the chat is deleted or
// unloaded, s no longer runs, or the chat is archived (its Stop follows, and stops s). c.mu held.
func (m *Manager) subRetryOff(c *Chat, s *sub) bool {
	return c.deleted || c.tr == nil || s.meta.Status != model.SubRunning || m.parentOf(c).Archived
}

// subRetryFire is the timer of w: when w is still the retry of c's subagent sid and it may start,
// it enters the gate. While the server shuts down it does nothing: Shutdown pauses s with its
// retry. No lock held.
func (m *Manager) subRetryFire(c *Chat, sid string, w *retryWait) {
	var out outbox
	c.mu.Lock()
	defer func() { c.mu.Unlock(); m.send(out) }()
	s := c.subs[sid]
	if s == nil || s.retry != w || m.down.Load() {
		return
	}
	if m.subRetryOff(c, s) {
		m.cancelSubRetry(c, s, "stopped")
		m.saveSub(c, s)
		out.emitSub(c, s.meta)
		return
	}
	// The gate runs the start on a goroutine of its own, which waits for c.mu: the ticket is set
	// before it looks.
	w.ticket = m.retryGate.enter(func() { m.subRetryStart(c, sid, w) })
}

// subRetryStart is w's slot: the attempt starts c's subagent sid again on its recorded session
// (startSub), with the message of subRetryBlocks. A start that fails fails the subagent, as a spawn
// that fails does. No lock held.
func (m *Manager) subRetryStart(c *Chat, sid string, w *retryWait) {
	var out outbox
	c.mu.Lock()
	s := c.subs[sid]
	if s == nil || s.retry != w || m.down.Load() {
		// Cancelled or replaced (its canceller left the gate), or the server stops (Shutdown pauses
		// s and leaves the gate): the slot is freed in any case, and leave is idempotent.
		m.retryGate.leave(w.ticket)
		c.mu.Unlock()
		return
	}
	if m.subRetryOff(c, s) {
		m.cancelSubRetry(c, s, "stopped")
		m.saveSub(c, s)
		out.emitSub(c, s.meta)
		c.mu.Unlock()
		m.send(out)
		return
	}
	w.started = true
	s.meta.Retry.At = m.nowMs()
	m.saveSub(c, s)
	out.emitSub(c, s.meta)
	depth, _ := subLimits(c)
	sa, chatID := s.meta, c.meta.ID
	opts := m.subSpawnOptions(c, sid, subLevel(c, sid) >= depth, sa.Kind, sa.Model, sa.Effort, sa.Session, true)
	m.logRetry(chatID, sid, fmt.Sprintf("attempt %d/%d starts", w.attempt, retryAttempts))
	c.mu.Unlock()
	m.send(out)

	err := m.startSub(chatID, sid, sa.Kind, opts, func(c *Chat, s *sub, out *outbox) ([]agent.ContentBlock, bool) {
		if s.retry != w {
			return nil, false // stopped, paused or resumed meanwhile: whoever did it has the record
		}
		if s.ag != nil {
			m.cancelSubRetry(c, s, "the process ended")
			return nil, false
		}
		return m.subRetryBlocks(c, s, w, out), true
	})
	if err == nil {
		return
	}
	if errors.Is(err, ErrFolderMissing) {
		err = &folderMissingError{text: folderMissingText(opts.Cwd)}
	}
	var aft after
	out = outbox{}
	c.mu.Lock()
	if s := c.subs[sid]; s != nil && s.retry == w && !c.deleted && c.tr != nil {
		m.logRetry(c.meta.ID, sid, fmt.Sprintf("attempt %d/%d could not start: %v", w.attempt, retryAttempts, err))
		m.cancelSubRetry(c, s, "the process ended")
		m.finalizeAppSub(c, s, model.SubFailed, "could not be started again: "+err.Error(), endFailed, &out, &aft)
	}
	out.emitCounts(c)
	c.mu.Unlock()
	m.send(out)
	m.finish(c, &aft)
}

// subRetryBlocks is the message of s's attempt: the carry-on retry block, then the results it is
// owed (taken now, so s.carry holds them), then the list of its paused and stopped children
// (s.listed). c.mu held.
func (m *Manager) subRetryBlocks(c *Chat, s *sub, w *retryWait, out *outbox) []agent.ContentBlock {
	blocks := []agent.ContentBlock{{Text: carryOnRetryBlock(string(w.kind), w.reason)}}
	return append(blocks, m.subCarryOnRest(c, s, out)...)
}

// subCarryOnRest is what follows the carry-on block of a message that starts s again on its
// session (a retry, a resume): the results it is owed, taken now (s.carry holds them), and the list
// of the subagents it started that are paused or stopped, the paused of which it has then been
// told of (s.listed). c.mu held.
func (m *Manager) subCarryOnRest(c *Chat, s *sub, out *outbox) []agent.ContentBlock {
	var blocks []agent.ContentBlock
	sid := s.meta.ID
	if tr, err := m.subTr(c, s); err == nil {
		if d, taken, ups := m.takeSubOwed(c, s, tr, out); d != nil {
			blocks = append(blocks, agent.ContentBlock{Text: resultsBlock(taken, runningKids(c, sid), false, true)})
			s.carry = d
			m.flushSub(c, s, false)
			out.emitSubItems(c, sid, tr.Version(), ups)
			out.emitSub(c, s.meta)
		}
	}
	if list := pausedOrStopped(c, sid); len(list) > 0 {
		blocks = append(blocks, agent.ContentBlock{Text: pausedListBlock(list, false)})
		for _, k := range list {
			if k.Status == model.SubPaused {
				if s.listed == nil {
					s.listed = map[string]bool{}
				}
				s.listed[k.ID] = true
			}
		}
	}
	return blocks
}

// subRetryOK ends s's retry at the first reply of its attempt (goal 2.4): the next temporary error
// starts at attempt 1 again. The caller writes and emits the record. c.mu held.
func (m *Manager) subRetryOK(c *Chat, s *sub) {
	w := s.retry
	if w == nil {
		return
	}
	m.logRetry(c.meta.ID, s.meta.ID, fmt.Sprintf("attempt %d/%d answered", w.attempt, retryAttempts))
	w.cancel(m.retryGate)
	s.retry = nil
	s.meta.Retry = model.Retry{}
}

// pauseSub is D9: s, which runs, is paused for reason (the error text) of class kind. Its process,
// if it still has one, is closed; the results its turn carried are owed again; it is written and
// emitted as a subagent that ends is (endSub), with its last text kept. It is not ended: nothing is
// owed to its parent, what it started runs on, and what is owed to it stays owed. tell says whether
// its parent is told (tellPaused): never during shutdown or a load, when no turn may start. c.mu
// held; what to close and to hand off goes to aft.
func (m *Manager) pauseSub(c *Chat, s *sub, reason string, kind agent.Temporary, cause model.SubCause, tell bool, out *outbox, aft *after) {
	if w := s.retry; w != nil {
		w.cancel(m.retryGate)
		s.retry = nil
	}
	if s.ag != nil {
		m.denySubPerms(c, s)
		aft.close = append(aft.close, s.ag)
		s.ag = nil
	}
	closeStop(s)
	m.revokeExtra(c.meta.ID, s.meta.ID)
	s.bg.report(agent.Background{})
	if d := s.carry; d != nil {
		s.carry = nil // endSub below would give its results up: a paused subagent keeps them owed
		if !d.settled {
			m.unreceived(c, d, false, false, out)
		}
	}
	s.meta.Status, s.meta.Ended, s.meta.Waiting, s.meta.BgWaiting = model.SubPaused, m.nowMs(), false, false
	s.meta.Error, s.meta.ErrorKind, s.meta.Cause, s.meta.Retry = reason, string(kind), cause, model.Retry{}
	leftApproval := m.endSub(c, s, out)
	if !tell {
		return
	}
	m.tellPaused(c, s, out, aft)
	if leftApproval {
		aft.add(m.deliver(c, out))
	}
}

// cancelSubRetry cancels s's retry (timer, gate), clears its record's Retry and logs why, one of
// "stopped", "the process ended" and "shutdown"; nil-safe. The caller writes and emits the record.
// c.mu held.
func (m *Manager) cancelSubRetry(c *Chat, s *sub, why string) {
	w := s.retry
	if w == nil {
		return
	}
	w.cancel(m.retryGate)
	s.retry = nil
	s.meta.Retry = model.Retry{}
	m.logRetry(c.meta.ID, s.meta.ID, "cancelled: "+why)
}
