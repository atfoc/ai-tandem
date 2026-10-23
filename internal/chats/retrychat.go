// The retry of the chat's own agent after a temporary error (design D16, goal 2.7, 2.8, 3.5). A turn
// that ends with a temporary error and has an attempt left is applied to the thread as a clean end;
// the process is closed and the chat shows as working (StatusRetrying) while it waits for the
// attempt, which starts the session again in a new process through spawn, as the person's next
// message does. A reply from the new process ends the retrying; a further temporary failure is the
// next attempt; the last attempt's failure is an ordinary failed turn with a note (pump, turnOver).
//
// A retrying chat takes the person's message (it is not busy): sendOn cancels the retry and the
// message is the next turn. Stop, Interrupt, the exit of a retry's process and Shutdown cancel it
// too. Every field of a retry (Chat.retry) is guarded by c.mu; the timer and the gate's start run
// with no lock held and look again under it, so a cancel that came first wins.
package chats

import (
	"fmt"
	"log"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/prompts"
)

// retryLeftChat reports whether a temporary failure of c's agent is retried: no retry runs, or the
// one that runs has an attempt after it. c.mu held.
func retryLeftChat(c *Chat) bool {
	return c.retry == nil || c.retry.attempt < retryAttempts
}

// chatTempFail is D16's failure, after the turn end was applied as a clean one: the thread's retry
// note, StatusRetrying, c.retry for the next attempt (1, or the running one's + 1), the timer, the
// carry's results back to owed with no attempt counted and no hold, the log. It returns the process
// to close (dropProcess), for the caller to close once it has unlocked. c.mu held.
func (m *Manager) chatTempFail(c *Chat, ev agent.Event, out *outbox) agent.Agent {
	attempt := 1
	if w := c.retry; w != nil {
		attempt = w.attempt + 1
		w.cancel(m.retryGate) // the slot of the attempt that failed
	}
	if d := c.carry; d != nil {
		c.carry = nil
		if !d.settled {
			// The results were not received, and no attempt of theirs failed: the retry carries them.
			m.unreceived(c, d, false, false, out)
		}
	}
	wait := m.retryJitter(m.retryWaits[attempt-1])
	w := &retryWait{attempt: attempt, kind: ev.Temporary, reason: ev.Error, at: m.now().Add(wait)}
	w.timer = time.AfterFunc(wait, func() { m.chatRetryFire(c, w) })
	c.retry = w
	ups := c.tr.AddNote("error", retryNote(string(ev.Temporary), ev.Error, attempt, wait))
	c.tr.SetStatus(model.StatusRetrying)
	out.emitItems(c, ups)
	m.logRetry(c.meta.ID, "", fmt.Sprintf("attempt %d/%d in %s (%s): %s", attempt, retryAttempts, waitWords(wait), ev.Temporary, quoteErr(ev.Error)))
	return dropProcess(c)
}

// chatRetryFire is the timer of w: when w is still c's retry and c may start, it enters the gate.
// No lock held.
func (m *Manager) chatRetryFire(c *Chat, w *retryWait) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.retry != w || c.deleted || c.tr == nil || c.ag != nil || m.down.Load() {
		return
	}
	// The gate runs the start on a goroutine of its own, which waits for c.mu: the ticket is set
	// before it looks.
	w.ticket = m.retryGate.enter(func() { m.chatRetryStart(c, w) })
}

// chatRetryStart is w's slot: the attempt starts c's agent on its session through spawn, with the
// retry's message (chatRetryBlocks), and hands it over on a goroutine. No lock held.
func (m *Manager) chatRetryStart(c *Chat, w *retryWait) {
	var out outbox
	c.mu.Lock()
	if c.retry != w || c.deleted || c.tr == nil || c.ag != nil || m.down.Load() {
		m.retryGate.leave(w.ticket)
		c.mu.Unlock()
		return
	}
	if p := m.parentOf(c); p.Archived || p.InstructionsSent {
		m.cancelChatRetry(c, "stopped")
		c.meta.TurnActive = false
		c.tr.SetStatus(model.StatusReady)
		m.logSave(c)
		out.emitChat(c)
		c.mu.Unlock()
		m.send(out)
		return
	}
	w.started = true
	m.logRetry(c.meta.ID, "", fmt.Sprintf("attempt %d/%d starts", w.attempt, retryAttempts))
	if err := m.spawn(c, &out); err != nil {
		// spawnFailed has shown the error. The turn is over: the next message of the person starts it.
		m.logRetry(c.meta.ID, "", fmt.Sprintf("attempt %d/%d could not start: %v", w.attempt, retryAttempts, err))
		m.cancelChatRetry(c, "the process ended")
		c.meta.TurnActive = false
		setHold(c)
		m.logSave(c)
		out.emitChat(c)
		c.mu.Unlock()
		m.send(out)
		return
	}
	blocks := m.chatRetryBlocks(c, w, &out)
	d := c.carry
	c.tr.SetStatus(model.StatusThinking)
	if err := c.tr.Flush(false); err != nil {
		log.Printf("chats: flush %s: %v", c.meta.ID, err)
	}
	m.logSave(c)
	out.emitChat(c)
	ag := c.ag
	c.sentGen = c.gen
	c.mu.Unlock()
	m.send(out)
	m.handoffs.Add(1)
	go func() {
		defer m.handoffs.Done()
		if err := ag.Send(blocks); err != nil {
			m.chatRetryRefused(c, w, d, err)
		}
	}()
}

// chatRetryBlocks is the retry's message: board context, carry-on, the owed results
// (carryOwed(c, false)), the list. It sets c.carry. c.mu held.
func (m *Manager) chatRetryBlocks(c *Chat, w *retryWait, out *outbox) []agent.ContentBlock {
	var blocks []agent.ContentBlock
	if b := m.boardContextBlock(c); b != nil {
		blocks = append(blocks, *b)
	}
	blocks = append(blocks, agent.ContentBlock{Text: carryOnRetryBlock(string(w.kind), w.reason)})
	d, taken, ups := m.carryOwed(c, false, out)
	if d != nil {
		blocks = append(blocks, agent.ContentBlock{Text: subResultsBlock(taken, runningKids(c, ""), false)})
		c.carry = d
	}
	if subs := pausedOrStopped(c, ""); len(subs) > 0 {
		blocks = append(blocks, agent.ContentBlock{Text: pausedListBlock(subs, false)})
	}
	out.emitItems(c, ups)
	return blocks
}

// boardContextBlock is the block that names the board of a board chat, which every message the app
// writes for it starts with; nil for a plain chat. c.mu held.
func (m *Manager) boardContextBlock(c *Chat) *agent.ContentBlock {
	if c.meta.Board == "" {
		return nil
	}
	name := c.meta.Board
	if bd, ok := m.Boards.Get(c.meta.Board); ok {
		name = bd.Name
	}
	return &agent.ContentBlock{Text: prompts.BoardContext(name, c.meta.Board)}
}

// chatRetryOK ends the retry at the first reply of its process (goal 2.4): the next temporary error
// starts at attempt 1 again. c.mu held.
func (m *Manager) chatRetryOK(c *Chat) {
	w := c.retry
	if w == nil {
		return
	}
	w.cancel(m.retryGate)
	c.retry = nil
	m.logRetry(c.meta.ID, "", fmt.Sprintf("attempt %d/%d answered", w.attempt, retryAttempts))
}

// chatRetryRefused is a retry's message the agent did not take: the retry ends, and the chat is
// where a refused delivery leaves it: an error note, ready, held, the results it carried owed
// again. A refusal that comes for a retry that has ended some other way (the person's message, a
// stop, the process's exit) changes nothing. No lock held.
func (m *Manager) chatRetryRefused(c *Chat, w *retryWait, d *carry, err error) {
	var out outbox
	c.mu.Lock()
	if !c.deleted && c.tr != nil && c.retry == w {
		m.logRetry(c.meta.ID, "", fmt.Sprintf("attempt %d/%d could not start: %v", w.attempt, retryAttempts, err))
		m.cancelChatRetry(c, "the process ended")
		if d != nil && c.carry == d {
			m.endCarry(c, false, &out)
		}
		c.lateEnd = err.Error()
		ups := c.tr.CloseOpen()
		ups = append(ups, c.tr.AddNote("error", "The agent could not be started again: "+err.Error())...)
		c.tr.SetStatus(model.StatusReady)
		c.meta.TurnActive = false
		setHold(c)
		if err := c.tr.Flush(false); err != nil {
			log.Printf("chats: flush %s: %v", c.meta.ID, err)
		}
		m.logSave(c)
		out.emitItems(c, ups)
		out.emitChat(c)
	}
	c.mu.Unlock()
	m.send(out)
}

// chatRetryGaveUp is the end of the last attempt, whose failure the caller applied as any failed
// turn: the gave-up note, the retry cleared, the log. c.mu held.
func (m *Manager) chatRetryGaveUp(c *Chat, ev agent.Event, out *outbox) {
	if w := c.retry; w != nil {
		w.cancel(m.retryGate)
		c.retry = nil
	}
	out.emitItems(c, c.tr.AddNote("muted", gaveUpNote()))
	m.logRetry(c.meta.ID, "", fmt.Sprintf("gave up after %d attempts (%s): %s", retryAttempts, ev.Temporary, quoteErr(ev.Error)))
}

// cancelChatRetry cancels c's retry (timer, gate) and logs why, one of "stopped", "a message of
// the user", "the process ended" and "shutdown"; nil-safe. It clears c.retry: what the chat shows
// instead (the status) is the caller's. c.mu held.
func (m *Manager) cancelChatRetry(c *Chat, why string) {
	w := c.retry
	if w == nil {
		return
	}
	w.cancel(m.retryGate)
	c.retry = nil
	m.logRetry(c.meta.ID, "", "cancelled: "+why)
}
