// Background work: the one rule by which an agent that has background commands running is waiting,
// not done.
//
// A Claude agent can start a command that runs on after its turn has ended (a Bash command in the
// background, a Monitor), and the process then starts turns of its own, one for each notice that
// the work reports. So the end of a turn is not the end of the agent. The rule, for the chat's own
// agent and for every subagent at any depth, and for nothing else to decide: an agent whose turn
// ended cleanly while waitsOnBackground holds is waiting; it is working while a turn runs, one that
// began by itself included; and it is done after a turn that ends with none of its background work
// left. What being done means is the only difference: a subagent reports to whoever started it, a
// chat becomes idle. The agent's adapter says what runs (agent.Background); this file holds the
// rule and what the manager remembers per process, so that a change to it changes both paths.

package chats

import (
	"time"

	"ai-whiteboard/internal/agent"
)

// bgQuietWait is how long an agent that waits on background work, and has none running any more,
// may stay without a turn before it counts as done. The notice of the work that just ended starts a
// turn at once in the normal case and cancels this wait; it only runs out when a notice was read
// inside a turn that was already making requests, or when a task ended with no turn after it. A
// manager has it as a field, for tests to lower. Work that still runs is never timed: it ends when
// it ends, or when the person stops the agent.
const bgQuietWait = 30 * time.Second

// waitsOnBackground is the one rule of goal 4.1: an agent whose turn ended cleanly while this holds
// is waiting, not done. The chat's own agent and every subagent, at any depth, ask it and nothing else.
func waitsOnBackground(b agent.Background) bool { return b.Running > 0 || b.Unread }

// bgWork is what the manager knows of one agent process's background work (Chat.bg, sub.bg).
// Its methods are called with the chat's mu held.
type bgWork struct {
	now   agent.Background // the adapter's last report (EvBackground, EvTurnEnd)
	gen   int              // raised by every sign of a turn and every turn end: a quiet wait armed under an older gen does nothing
	armed int              // how many times the quiet wait was armed (for tests)
}

// report records the adapter's latest state.
func (b *bgWork) report(v agent.Background) { b.now = v }

// turnSign notes that a turn began (the agent is thinking, or model output came) or ended, which
// cancels a quiet wait armed before it.
func (b *bgWork) turnSign() { b.gen++ }

// holds reports whether the agent waits on background work (waitsOnBackground of the last report).
func (b *bgWork) holds() bool { return waitsOnBackground(b.now) }

// idle reports that what ran has ended: no task is live, but a notice may still start a turn.
func (b *bgWork) idle() bool { return b.now.Running == 0 }

// armBgQuiet starts the quiet wait of b (bgQuietWait): when it is over, under c.mu, fire runs if b
// has had no turn sign since it was armed and c is not deleted; what fire leaves in out and aft is
// then sent and finished, as the quiet wait of a subagent's delivery does (subUnread). c.mu held.
func (m *Manager) armBgQuiet(c *Chat, b *bgWork, fire func(out *outbox, aft *after)) {
	at := b.gen
	b.armed++
	time.AfterFunc(m.bgQuietWait, func() {
		var out outbox
		var aft after
		c.mu.Lock()
		if c.deleted || c.tr == nil || b.gen != at {
			c.mu.Unlock()
			return
		}
		fire(&out, &aft)
		out.emitCounts(c)
		c.mu.Unlock()
		m.send(out)
		m.finish(c, &aft)
	})
}
