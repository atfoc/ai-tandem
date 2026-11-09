// Who works on an agent kind, and stopping them (design D7 of the Claude accounts): the accounts
// (internal/aliases) ask it before an account's container is recreated or stopped. A container
// with agents at work is restarted only when the person agrees; idle processes are ended without a
// question, and their chats resume on their next message.
package chats

import (
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// AccountWork is the chat manager as the Claude accounts need it (aliases.Work): Busy and
// StopKind of an agent kind. It is a view of the manager rather than the manager itself because
// Manager.Busy is a chat's already. Get it with Manager.AccountWork.
type AccountWork struct{ m *Manager }

// AccountWork is the manager's AccountWork.
func (m *Manager) AccountWork() AccountWork { return AccountWork{m} }

// Busy is Manager.BusyKind.
func (w AccountWork) Busy(a model.AgentKind) int { return w.m.BusyKind(a) }

// StopKind is Manager.StopKind.
func (w AccountWork) StopKind(a model.AgentKind) { w.m.StopKind(a) }

// stopKindWait is how long StopKind waits for the processes it ended to be gone. A process is
// closed within a few seconds (agent.Agent's Close); one that is still there after this is left
// to its adapter, and StopKind returns.
const stopKindWait = closeWait

// BusyKind is the number of chat objects (top-level chats, branches, subagents) of the agent kind
// a whose agent is working now: a turn running (permission requests included), a turn that goes
// on across the attempts of a retry, or background work it waits on. Each is counted by its own
// kind: a chat's or a branch's is its agent's (ChatMeta.Agent), a subagent's its own
// (Subagent.Kind), so a subagent on a Claude account counts for the account in a chat of any
// agent, and a chat on the account does not count for its subagents of other agents. An app
// subagent counts while it runs, which it does only working or waiting on its subagents or its
// background work. An idle process counts for nothing; neither does a chat object a fork or a new
// branch is still making (unlisted), which is listed or gone within its start.
//
// Each chat object is locked in turn, one at a time and with no other lock of the manager held.
func (m *Manager) BusyKind(a model.AgentKind) int {
	n := 0
	for _, c := range m.all() {
		c.mu.Lock()
		if !c.deleted && !c.unlisted {
			if c.meta.Agent == a && chatWorks(c) {
				n++
			}
			for _, s := range c.subs {
				if subWorks(s, a) {
					n++
				}
			}
		}
		c.mu.Unlock()
	}
	return n
}

// chatWorks reports whether c's agent works for BusyKind: busy, or retried after a temporary
// error (a turn that goes on between its attempts, as stopLocked counts it). c.mu held.
func chatWorks(c *Chat) bool { return busy(c) || c.retry != nil }

// subWorks reports whether s is an app subagent of kind a that runs (BusyKind). c.mu held.
func subWorks(s *sub, a model.AgentKind) bool {
	return s.app && s.meta.Kind == a && s.meta.Status == model.SubRunning
}

// StopKind ends every live process of the agent kind a, working or idle, and returns once they
// have ended (or after stopKindWait). For each chat object, one at a time:
//
//   - a chat or branch of kind a that works (BusyKind) is stopped as Stop stops it (stopLocked):
//     the "Stopped." note, its subagents stopped with it, held. Its next message resumes it.
//   - one of kind a with an idle process loses the process alone (dropProcess), as a stopped
//     waiting chat does: nothing shows, the subagents of other agents it started run on and what
//     they are owed stays owed for its next message, which resumes it.
//   - every app subagent of kind a that runs, in a chat of any agent, is stopped as stop_subagent
//     stops one, with what it started under it, and with the cause of a stop by the person
//     (model.CausePerson), so its parent is told of it with its next message and may resume it.
//     A delivery to the chat's agent that this frees is handed off, as after stop_subagent.
//
// A retry waiting for its attempt is cancelled with what it would retry. A chat object a fork or a
// new branch is still making (unlisted) is not looked at.
//
// StopKind takes each chat's mu with no other lock of the manager held, as Shutdown does. It is
// for the accounts, which call it before they recreate or stop a container: they must not hold a
// lock that Agents.Check, Accounts.CheckFolder or an account's spawner takes while they call it
// (or Busy), since a chat's start holds the chat's mu while it calls those. The long wait for a
// container (Accounts.Prepare) is never under a chat's mu: a start makes the container ready
// before it takes the lock (prepare), and the spawner's own wait under it is short, so StopKind,
// Busy, Views and Shutdown do not wait for an image build. Prepare must not call StopKind or Busy,
// nor take a lock held by whoever does. Nor does StopKind keep a process from starting after it
// has passed its chat: a message that comes meanwhile starts one while the account can be used
// (accountGate).
func (m *Manager) StopKind(a model.AgentKind) {
	var ended []agent.Agent
	for _, c := range m.all() {
		ended = append(ended, m.stopKindOf(c, a)...)
	}
	waitEnded(ended, stopKindWait)
}

// stopKindOf is StopKind on the chat object c. It returns the processes it ended, for the caller
// to wait for. No chat's mu may be held.
func (m *Manager) stopKindOf(c *Chat, a model.AgentKind) []agent.Agent {
	var out outbox
	var aft after
	var ended []agent.Agent
	c.mu.Lock()
	if c.deleted || c.unlisted {
		c.mu.Unlock()
		return nil
	}
	if c.meta.Agent == a {
		if ag := c.ag; chatWorks(c) {
			aft.close = append(aft.close, m.stopLocked(c, &out)...) // closes ag itself
			ended = append(ended, ag)
		} else if ag != nil {
			aft.close = append(aft.close, dropProcess(c))
		}
	}
	hand := false
	for _, s := range c.subs {
		if !subWorks(s, a) {
			continue // stopBelow may have stopped it on the way
		}
		ag, leftApproval := m.stopSub(c, s, endPerson, &out)
		aft.close = append(aft.close, ag)
		if m.stopBelow(c, s, &out, &aft) || leftApproval {
			hand = true
		}
	}
	if hand {
		aft.add(m.deliver(c, &out))
	}
	out.emitCounts(c)
	c.mu.Unlock()
	m.send(out)
	m.finish(c, &aft)
	return append(ended, aft.close...)
}

// waitEnded waits until the events of every process of ags have closed, which an adapter does
// once its process has ended, or until limit has passed. nil entries are skipped. What the
// processes still say is dropped: each was taken from its chat object under the chat's mu before
// (a new gen, or a closed stop channel), so whoever read their events (a pump, a subagent's
// runner) no longer applies them, and reading them here alongside takes nothing from anyone.
func waitEnded(ags []agent.Agent, limit time.Duration) {
	done := make(chan struct{}, len(ags))
	n := 0
	for _, ag := range ags {
		if ag == nil {
			continue
		}
		n++
		go func(ch <-chan agent.Event) {
			for range ch {
			}
			done <- struct{}{}
		}(ag.Events())
	}
	t := time.NewTimer(limit)
	defer t.Stop()
	for ; n > 0; n-- {
		select {
		case <-done:
		case <-t.C:
			return
		}
	}
}
