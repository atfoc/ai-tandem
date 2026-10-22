// Subagents that start subagents. A chat whose subagent depth is above 1 gives the spawn family
// to its subagents down to the level above the deepest (sublimits.go). The subagent a subagent
// starts is a record of the chat like any other, with the one that started it as Parent, and its
// result is owed to that one, not to the chat's agent.
//
// So a subagent that started subagents is not finished when its turn ends. It waits for the
// subagents it started and for its own background work (Claude: a background command or a
// Monitor; the rule is in background.go). It waits (model.Subagent.Waiting, with BgWaiting when
// background work is part of why): its status stays running, its process lives, and it counts
// against the chat's cap. It is handed the results it is owed as a message that starts a further
// turn of it, in the block the chat's agent gets (delivery.go). Only a turn of it that ends cleanly
// with none of its subagents running, nothing owed to it and no background work left finishes it,
// and then its own result goes to whoever started it.
//
// The delivery to a subagent is simpler than the chat's: there is no second attempt and no hold.
// A result that cannot be delivered fails the subagent, and whoever started that one is told, as
// of any failed subagent.
//
//	its process does not take the message               the subagent fails
//	model output appeared in the carrying turn          delivered
//	the turn ended with an error, or aborted            the subagent ends as it would in any turn
//	its process exited                                  the same
//	a clean end on pi with no model output              the subagent fails: a failed pi turn can look like it
//	a clean end on Claude or Cursor                     delivered: the model took the message and said nothing
//	a clean end of a turn its process began by itself   open: the next turn is the message's, or silence says it was read (subUnread)
//
// A subagent that ends, in whatever way, takes every subagent below it with it (stopBelow):
// nobody is left to receive their results. A result that was owed to it, or that it was being
// handed and is not known to have received, is given up (model.SubGivenUp).
package chats

import (
	"log"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/transcript"
)

// after is what a step taken under c.mu leaves to be done once the lock is released and what it
// emitted is sent: the processes to close, and the deliveries to hand to their agents.
type after struct {
	close []agent.Agent
	hand  []*carry
}

// add notes a delivery to hand off; nil is none.
func (a *after) add(d *carry) {
	if d != nil {
		a.hand = append(a.hand, d)
	}
}

// finish does what a holds. No chat's mu may be held.
func (m *Manager) finish(c *Chat, a *after) {
	closeAgents(a.close)
	for _, d := range a.hand {
		m.handOff(c, d)
	}
}

// below returns the app-spawned subagents under sid, at every level: those it started, those
// they started, and so on, in no order. c.mu held.
func below(c *Chat, sid string) []*sub {
	in := map[string]bool{sid: true}
	var under []*sub
	for grew := true; grew; {
		grew = false
		for id, s := range c.subs {
			if s.app && !in[id] && in[s.meta.Parent] {
				in[id], grew = true, true
				under = append(under, s)
			}
		}
	}
	return under
}

// stopBelow stops every subagent below s that still runs, and gives up the results nobody is
// left to receive. It is called for a subagent that has just reached a final status. The
// processes it detached are added to aft, for the caller to Close after unlock. It reports
// whether closing permission cards took the chat out of approval. c.mu held.
func (m *Manager) stopBelow(c *Chat, s *sub, out *outbox, aft *after) (leftApproval bool) {
	for _, k := range below(c, s.meta.ID) {
		if k.meta.Status != model.SubRunning {
			continue
		}
		ag, left := m.stopSub(c, k, endParent, out)
		aft.close = append(aft.close, ag)
		leftApproval = leftApproval || left
	}
	m.giveUpOrphans(c, out)
	return leftApproval
}

// giveUpOrphans gives up every result that is owed to a subagent that no longer runs: a
// subagent gets results only while it lives, and nobody else is owed them. c.mu held.
func (m *Manager) giveUpOrphans(c *Chat, out *outbox) {
	var sids []string
	for sid, k := range c.subs {
		if k.meta.Parent == "" || !k.meta.Delivery.Owed() {
			continue
		}
		if p := c.subs[k.meta.Parent]; p != nil && p.meta.Status == model.SubRunning {
			continue
		}
		sids = append(sids, sid)
	}
	m.giveUp(c, sids, out)
}

// giveUp marks the results of sids as given up, those of them that are owed or were handed over
// in a turn (sent). c.mu held.
func (m *Manager) giveUp(c *Chat, sids []string, out *outbox) {
	for _, sid := range sids {
		k := c.subs[sid]
		if k == nil || (!k.meta.Delivery.Owed() && k.meta.Delivery != model.SubSent) {
			continue
		}
		k.meta.Delivery = model.SubGivenUp
		m.saveSub(c, k)
		out.emitSub(c, k.meta)
	}
}

// subWaits is the clean end of a turn of s, a running app-spawned subagent. It reports whether
// that leaves s waiting and not finished: subagents it started still run, a result is owed to
// it, or its own background work holds it. Then s is marked as waiting, and the results it is owed
// go to it at once, in a turn that takes it out of waiting again (the delivery is added to aft).
// When only background work that has ended holds it, the quiet wait is armed (armBgQuiet). c.mu held.
func (m *Manager) subWaits(c *Chat, s *sub, out *outbox, aft *after) bool {
	if runningKids(c, s.meta.ID) == 0 && len(owedTo(c, s.meta.ID)) == 0 && !s.bg.holds() {
		return false
	}
	if tr, err := m.subTr(c, s); err == nil {
		out.emitSubItems(c, s.meta.ID, tr.Version(), tr.CloseOpen())
	}
	s.meta.Waiting, s.meta.BgWaiting = true, s.bg.holds()
	if d := m.deliverSub(c, s, out); d != nil {
		aft.add(d) // it has written and sent s, working again
		return true
	}
	if s.meta.BgWaiting && s.bg.idle() && runningKids(c, s.meta.ID) == 0 && len(owedTo(c, s.meta.ID)) == 0 {
		m.armBgQuiet(c, &s.bg, m.subBgQuiet(c, s.meta.ID))
	}
	m.flushSub(c, s, false)
	out.emitSub(c, s.meta)
	return true
}

// waitOver finishes p, a subagent that waits, when nothing is left for it to wait for: none of
// its subagents runs, no result is owed to it and no background work holds it. That is how its wait ends when the last one it
// waited for ended without owing it a result, which only a spawn that failed after its turn had
// ended does: the spawn call itself told it. Its last turn ended cleanly, so it has finished.
// c.mu held.
func (m *Manager) waitOver(c *Chat, p *sub, out *outbox, aft *after) {
	if !p.app || p.meta.Status != model.SubRunning || !p.meta.Waiting || p.carry != nil {
		return
	}
	if runningKids(c, p.meta.ID) > 0 || len(owedTo(c, p.meta.ID)) > 0 {
		return
	}
	if p.bg.holds() {
		// Its own background work is all that is left. When that has ended too, a turn for its
		// notice is still to come, and the quiet wait bounds it.
		if p.meta.BgWaiting && p.bg.idle() {
			m.armBgQuiet(c, &p.bg, m.subBgQuiet(c, p.meta.ID))
		}
		return
	}
	m.finalizeAppSub(c, p, model.SubCompleted, "", endTurn, out, aft)
}

// deliverSub starts a turn of the subagent s that hands it every result it is owed, when it can
// take one: it waits, with a live process. It is deliver for a subagent. The results are marked
// as sent and get their rows in the thread of s, as a chat's get theirs in the chat's; s leaves
// waiting. Nothing of a chat's turn is involved: no slot of the cap on running turns, no hold,
// and no context block, since a subagent's messages have none. The caller passes the result to
// handOff after unlocking and sending out; nil when no turn started. c.mu held.
//
// It is called at the two moments a subagent becomes able to take a message with something to
// take: a turn of it ends cleanly (subWaits), and a result becomes owed to it while it waits
// (finalizeAppSub).
//
// A waiting subagent's process can be in a turn all the same: one it began by itself, which the
// manager knows of only from its first model output. Results handed over before that output are
// not that turn's, and its end does not finish the subagent (subUnread).
func (m *Manager) deliverSub(c *Chat, s *sub, out *outbox) *carry {
	if c.deleted || c.tr == nil || !s.app || s.meta.Status != model.SubRunning || !s.meta.Waiting || s.ag == nil || s.carry != nil {
		return nil
	}
	owed := owedTo(c, s.meta.ID)
	if len(owed) == 0 {
		return nil
	}
	tr, err := m.subTr(c, s)
	if err != nil {
		log.Printf("chats: subagent %s/%s: %v", c.meta.ID, s.meta.ID, err)
		return nil
	}
	_, items := tr.Snapshot()
	d := &carry{sub: s.meta.ID, ag: s.ag}
	var taken []model.Subagent
	var ups []transcript.Update
	for _, k := range owed {
		k.meta.Delivery, k.meta.Carried = model.SubSent, len(items)
		m.saveSub(c, k)
		d.sids = append(d.sids, k.meta.ID)
		taken = append(taken, k.meta)
		ups = append(ups, tr.AddSubResult(k.meta.ID)...)
		out.emitSub(c, k.meta)
	}
	d.blocks = []agent.ContentBlock{{Text: resultsBlock(taken, runningKids(c, s.meta.ID), false, true)}}
	s.meta.Waiting, s.meta.BgWaiting = false, false
	s.carry = d
	m.flushSub(c, s, false)
	out.emitSubItems(c, s.meta.ID, tr.Version(), ups)
	out.emitSub(c, s.meta)
	return d
}

// subTurnOver is the clean end of a turn of s that leaves nothing of a delivery open: what the
// turn carried is delivered. It reports whether s goes on, waiting or in a further turn
// (subWaits); if not, the caller finishes it. c.mu held.
func (m *Manager) subTurnOver(c *Chat, s *sub, out *outbox, aft *after) bool {
	s.carry = nil
	return m.subWaits(c, s, out, aft)
}

// subQuietWait is how long the process of a subagent may stay silent, after a turn it began by
// itself, before the results it was handed during that turn count as read in it. A process that
// kept the message for a turn of its own starts that turn as soon as the other has ended, and
// says so at once (it reports that it is thinking before the model has answered), so the silence
// only has to outlast a slow machine. A manager has it as a field, for tests to lower.
const subQuietWait = 30 * time.Second

// subUnread is the clean end of a turn that the process of s began by itself (agent.Event.SelfBegun)
// while s was being handed results: the message came into a turn that was already running, which
// the manager could not know. Whether the agent read it in that turn cannot be told from here.
// A process that did not read it starts the message's own turn now, and s must be alive for it:
// finished here, s would report without the results, with nothing to show that they were lost.
// So s stays as it is, running and in a turn as far as anyone can see, and the turn that follows
// ends as any turn of it does. A process that did read the message starts no turn: when it has
// given no sign of one for subQuietWait, the results count as read and the turn as over
// (subTurnOver). c.mu held.
func (m *Manager) subUnread(c *Chat, s *sub, out *outbox) {
	if tr, err := m.subTr(c, s); err == nil {
		out.emitSubItems(c, s.meta.ID, tr.Version(), tr.CloseOpen())
	}
	m.flushSub(c, s, false)
	out.emitSub(c, s.meta)
	d, sid, at := s.carry, s.meta.ID, s.carry.quiet
	time.AfterFunc(m.subQuietWait, func() {
		var out outbox
		var aft after
		c.mu.Lock()
		// Still that delivery's, and no sign of a turn since: every other end of s has taken its
		// carry (endSub), and a turn that began has counted (handleSubEv).
		if s := c.subs[sid]; s != nil && s.carry == d && d.quiet == at && s.meta.Status == model.SubRunning && !c.deleted && c.tr != nil {
			if !m.subTurnOver(c, s, &out, &aft) {
				m.finalizeAppSub(c, s, model.SubCompleted, "", endTurn, &out, &aft)
			}
		}
		out.emitCounts(c)
		c.mu.Unlock()
		m.send(out)
		m.finish(c, &aft)
	})
}

// subRefused is a delivery the process of a subagent did not accept. The subagent fails, with a
// note in its thread, and whoever started it is told as of any failed subagent; the results it
// was being handed are given up (endSub). A refusal that comes for a turn in which model output
// appeared, or for a subagent that has ended some other way, changes nothing. No chat's mu may
// be held.
func (m *Manager) subRefused(c *Chat, d *carry, cause error) {
	var out outbox
	var aft after
	c.mu.Lock()
	if s := c.subs[d.sub]; s != nil && s.carry == d && !d.settled && !c.deleted && c.tr != nil {
		m.subErrorNote(c, s, "The subagent results could not be sent to the subagent: "+cause.Error(), &out)
		m.finalizeAppSub(c, s, model.SubFailed, "the results of its subagents could not be sent to it: "+cause.Error(), endFailed, &out, &aft)
	}
	out.emitCounts(c)
	c.mu.Unlock()
	m.send(out)
	m.finish(c, &aft)
}
