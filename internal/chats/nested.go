// Subagents that start subagents. A chat whose subagent depth is above 1 gives the spawn family
// to its subagents down to the level above the deepest (sublimits.go). The subagent a subagent
// starts is a record of the chat like any other, with the one that started it as Parent, and its
// result is owed to that one, not to the chat's agent.
//
// So a subagent that started subagents is not finished when its turn ends. It waits
// (model.Subagent.Waiting): its status stays running, its process lives, and it counts against
// the chat's cap. It is handed the results it is owed as a message that starts a further turn of
// it, in the block the chat's agent gets (delivery.go). Only a turn of it that ends cleanly with
// none of its subagents running and nothing owed to it finishes it, and then its own result goes
// to whoever started it.
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
//
// A subagent that ends, in whatever way, takes every subagent below it with it (stopBelow):
// nobody is left to receive their results. A result that was owed to it, or that it was being
// handed and is not known to have received, is given up (model.SubGivenUp).
package chats

import (
	"log"

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
// that leaves s waiting and not finished: subagents it started still run, or a result is owed to
// it. Then s is marked as waiting, and the results it is owed go to it at once, in a turn that
// takes it out of waiting again (the delivery is added to aft). c.mu held.
func (m *Manager) subWaits(c *Chat, s *sub, out *outbox, aft *after) bool {
	if runningKids(c, s.meta.ID) == 0 && len(owedTo(c, s.meta.ID)) == 0 {
		return false
	}
	if tr, err := m.subTr(c, s); err == nil {
		out.emitSubItems(c, s.meta.ID, tr.Version(), tr.CloseOpen())
	}
	s.meta.Waiting = true
	if d := m.deliverSub(c, s, out); d != nil {
		aft.add(d) // it has written and sent s, working again
		return true
	}
	m.flushSub(c, s, false)
	out.emitSub(c, s.meta)
	return true
}

// waitOver finishes p, a subagent that waits, when nothing is left for it to wait for: none of
// its subagents runs and no result is owed to it. That is how its wait ends when the last one it
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
	s.meta.Waiting = false
	s.carry = d
	m.flushSub(c, s, false)
	out.emitSubItems(c, s.meta.ID, tr.Version(), ups)
	out.emitSub(c, s.meta)
	return d
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
