package chats

import (
	"errors"
	"reflect"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// pendingParent is a parent mid-turn that is owed one result (its subagent finished while the
// parent was busy) and has one subagent still running.
func (e *env) pendingParent() (id string, parent *fakeAgent, owed, running model.Subagent, runner *fakeAgent) {
	e.t.Helper()
	id, parent = e.startSpawnParent()
	owed = e.spawn(id, SpawnSubRequest{Prompt: "finishes"})
	done := waitChild(e.t, e.claude, 2)
	running = e.spawn(id, SpawnSubRequest{Prompt: "runs on"})
	runner = waitChild(e.t, e.claude, 3)
	e.finish(done, "report")
	if len(parent.sent()) != 1 || e.subFile(id, owed.ID).Delivery != model.SubOwed {
		e.t.Fatalf("a result was sent to a busy parent: %d sends", len(parent.sent()))
	}
	return id, parent, owed, running, runner
}

// held fails unless the chat is not busy, its agent got nothing beyond its first sends messages,
// no result row was added, and each of owed is still owed on disk.
func (e *env) held(when, id string, parent *fakeAgent, sends int, owed ...string) {
	e.t.Helper()
	e.m.handoffs.Wait()
	if n := len(parent.sent()); n != sends {
		e.t.Fatalf("%s: %d sends, want %d", when, n, sends)
	}
	if rows := resultRows(e.items(id)); len(rows) != 0 {
		e.t.Fatalf("%s: result rows %v", when, rows)
	}
	if e.m.Busy(id) {
		e.t.Fatalf("%s: the chat is busy", when)
	}
	for _, sid := range owed {
		if f := e.subFile(id, sid); f.Delivery != model.SubOwed {
			e.t.Fatalf("%s: subagent.json %+v", when, f)
		}
	}
}

// What holds a chat: after each, no turn starts for the result already owed, nor for one that comes
// later, until the human sends. Then they go out once, with the human's message.
func TestHoldStartsNoTurn(t *testing.T) {
	interrupt := func(t *testing.T, e *env, id string) {
		t.Helper()
		if err := e.m.Interrupt(id); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name string
		// hold does what holds the chat and reports whether the parent's process is still there
		// and whether the subagent that was running still is.
		hold func(t *testing.T, e *env, id string, parent *fakeAgent) (alive, runs bool)
	}{
		// A CLI need not report an interrupted turn as aborted: this one ends cleanly.
		{"interrupt, clean turn end", func(t *testing.T, e *env, id string, parent *fakeAgent) (bool, bool) {
			interrupt(t, e, id)
			parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
			return true, false
		}},
		{"interrupt, aborted turn end", func(t *testing.T, e *env, id string, parent *fakeAgent) (bool, bool) {
			interrupt(t, e, id)
			parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
			return true, false
		}},
		{"aborted turn end", func(t *testing.T, e *env, id string, parent *fakeAgent) (bool, bool) {
			parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
			return true, false
		}},
		// An errored turn end leaves the subagents running.
		{"errored turn end", func(t *testing.T, e *env, id string, parent *fakeAgent) (bool, bool) {
			parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "rate limited"})
			return true, true
		}},
		{"exit", func(t *testing.T, e *env, id string, parent *fakeAgent) (bool, bool) {
			parent.exit(t)
			return false, false
		}},
		{"Stop", func(t *testing.T, e *env, id string, parent *fakeAgent) (bool, bool) {
			e.m.Stop(id)
			return false, false
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			id, parent, owed, running, runner := e.pendingParent()
			alive, runs := tc.hold(t, e, id, parent)
			want := []string{owed.ID}
			e.held("held", id, parent, 1, want...)
			if st := e.sub(id, running.ID).Status; (st == model.SubRunning) != runs {
				t.Fatalf("the subagent that was running is %q", st)
			}

			// A result that comes while the chat is held starts no turn either.
			e.clock.Store(testNow + 10)
			if runs {
				e.finish(runner, "late report")
				want = append(want, running.ID)
			} else {
				waitFor(t, "runner closed", func() bool { return agentClosed(runner) })
				procs := e.claude.count()
				last := e.spawn(id, SpawnSubRequest{Prompt: "spawned last"})
				e.finish(waitChild(t, e.claude, procs+1), "late report")
				want = append(want, last.ID)
			}
			e.held("after a later result", id, parent, 1, want...)

			// Neither does a clean turn end, when the agent is still there to have one.
			if alive {
				parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
				e.held("after a clean turn end", id, parent, 1, want...)
			} else {
				parent = nil
			}
			e.clock.Store(testNow + 20)
			e.afterHold(id, parent, want...)
		})
	}
}

// Interrupt, then a result from a subagent the turn spawned in its last moments, then the turn's
// end, reported as clean: nothing is sent.
func TestInterruptThenResultThenTurnEnd(t *testing.T) {
	e := newEnv(t)
	id, parent, owed, _, _ := e.pendingParent()
	if err := e.m.Interrupt(id); err != nil {
		t.Fatal(err)
	}
	e.clock.Store(testNow + 10)
	last := e.spawn(id, SpawnSubRequest{Prompt: "spawned last"})
	e.finish(waitChild(t, e.claude, 4), "late report")
	if len(parent.sent()) != 1 || e.subFile(id, last.ID).Delivery != model.SubOwed {
		t.Fatalf("after the result: %d sends, %+v", len(parent.sent()), e.subFile(id, last.ID))
	}
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.held("after the turn end", id, parent, 1, owed.ID, last.ID)
	if n := notes(e.items(id), "muted"); len(n) != 0 {
		t.Fatalf("notes %q for a turn that did not end aborted", n)
	}
	e.afterHold(id, parent, owed.ID, last.ID)
}

// An interrupted turn's own permission card is closed at its end; a late answer to it is refused
// and starts nothing.
func TestInterruptedTurnsCardStartsNothing(t *testing.T) {
	e := newEnv(t)
	id, parent, owed, _, _ := e.pendingParent()
	ask(t, parent, "", "r1")
	if err := e.m.Interrupt(id); err != nil {
		t.Fatal(err)
	}
	if c := e.card(id, "", "r1"); c.Decided != "" {
		t.Fatalf("card before the turn ended %+v", c)
	}
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	if c := e.card(id, "", "r1"); c.Decided != "deny" {
		t.Fatalf("card after the turn ended %+v", c)
	}
	if err := e.m.Decide(id, "", "r1", true); !errors.Is(err, ErrNoRequest) {
		t.Fatalf("late answer: %v", err)
	}
	if d, s := agentDecides(parent), agentStrays(parent); len(d) != 0 || len(s) != 0 {
		t.Fatalf("the agent was sent an answer: %+v %+v", d, s)
	}
	e.held("after the late answer", id, parent, 1, owed.ID)
	e.afterHold(id, parent, owed.ID)
}

// Interrupt with no turn running: the subagents stop and the agent is signalled, as with a turn.
// No aborted turn end follows to say so, so Interrupt leaves the "Stopped." note, once, and only
// when it stopped a subagent.
func TestInterruptIdleParent(t *testing.T) {
	stopped := func(t *testing.T, e *env, id string, parent *fakeAgent, signals int, kids ...*fakeAgent) {
		t.Helper()
		for _, k := range kids {
			waitFor(t, "child closed", func() bool { return agentClosed(k) })
		}
		for _, s := range e.subs(id) {
			if s.Status != model.SubStopped || s.Delivery != model.SubNotOwed {
				t.Fatalf("subagent %+v", s)
			}
		}
		if parent.interrupted() != signals || agentClosed(parent) {
			t.Fatalf("the parent was signalled %d times, closed %v", parent.interrupted(), agentClosed(parent))
		}
		if st := e.status(id); st != model.StatusReady || e.meta(id).TurnActive {
			t.Fatalf("status %q, turnActive %v", st, e.meta(id).TurnActive)
		}
	}

	t.Run("running subagents", func(t *testing.T) {
		e := newEnv(t)
		evs := listen(t, e.br)
		id, parent := e.idleParent()
		e.spawn(id, SpawnSubRequest{Prompt: "a"})
		ca := waitChild(t, e.claude, 2)
		e.spawn(id, SpawnSubRequest{Prompt: "b"})
		cb := waitChild(t, e.claude, 3)
		evs.drain(t, e.br)
		if err := e.m.Interrupt(id); err != nil {
			t.Fatal(err)
		}
		stopped(t, e, id, parent, 1, ca, cb)
		items := e.items(id)
		if n := notes(items, "muted"); len(n) != 1 || n[0] != "Stopped." || items[len(items)-1].Kind != "note" {
			t.Fatalf("notes %q", n)
		}
		if got := diskItems(t, e.m.itemsPath(id)); len(got) != len(items) || got[len(got)-1].Text != "Stopped." {
			t.Fatalf("the note was not written: %+v", got)
		}
		var told bool
		for _, ev := range ofType(evs.drain(t, e.br), "chat_items") {
			for _, u := range updatesOf(t, ev) {
				told = told || (u.Item.Kind == "note" && u.Item.Text == "Stopped.")
			}
		}
		if !told {
			t.Fatal("clients were not sent the note")
		}
		e.held("after the interrupt", id, parent, 1)

		// A second interrupt stops nothing: no second note.
		if err := e.m.Interrupt(id); err != nil {
			t.Fatal(err)
		}
		if n := notes(e.items(id), "muted"); len(n) != 1 || parent.interrupted() != 2 {
			t.Fatalf("notes %q, %d signals", n, parent.interrupted())
		}

		// A result that comes while the chat is held waits for the human's message.
		last := e.spawn(id, SpawnSubRequest{Prompt: "spawned last"})
		e.finish(waitChild(t, e.claude, 4), "late report")
		e.held("after a later result", id, parent, 1, last.ID)
		e.afterHold(id, parent, last.ID)
	})

	t.Run("no running subagent", func(t *testing.T) {
		e := newEnv(t)
		id, parent := e.idleParent()
		n := len(e.items(id))
		if err := e.m.Interrupt(id); err != nil {
			t.Fatal(err)
		}
		stopped(t, e, id, parent, 1)
		if len(e.items(id)) != n {
			t.Fatalf("items %+v", e.items(id))
		}
		// The chat is held all the same.
		last := e.spawn(id, SpawnSubRequest{Prompt: "spawned last"})
		e.finish(waitChild(t, e.claude, 2), "late report")
		e.held("after a later result", id, parent, 1, last.ID)
		e.afterHold(id, parent, last.ID)
	})

	t.Run("held in approval by a child's request", func(t *testing.T) {
		e := newEnv(t)
		id, parent := e.idleParent()
		sa := e.spawn(id, SpawnSubRequest{Prompt: "asks"})
		child := waitChild(t, e.claude, 2)
		ask(t, child, "", "p1")
		if st := e.status(id); st != model.StatusApproval {
			t.Fatalf("status %q", st)
		}
		if err := e.m.Interrupt(id); err != nil {
			t.Fatal(err)
		}
		stopped(t, e, id, parent, 1, child)
		if c := e.card(id, sa.ID, "p1"); c.Decided != "deny" {
			t.Fatalf("card %+v", c)
		}
		items := e.items(id)
		if n := notes(items, "muted"); len(n) != 1 || n[0] != "Stopped." || items[len(items)-1].Kind != "note" {
			t.Fatalf("notes %q", n)
		}
		e.held("after the interrupt", id, parent, 1)
		e.afterHold(id, parent)
	})
}

// Interrupt while results are being handed to the agent: it returns without waiting, and the agent
// is signalled only once it has the message, so the signal stops that turn. A hand-off the agent
// refuses leaves no turn to stop: no signal.
func TestInterruptDuringHandOff(t *testing.T) {
	for _, tc := range []struct {
		name   string
		refuse bool
	}{{"accepted", false}, {"refused", true}} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			id, parent := e.idleParent()
			sa := e.spawn(id, SpawnSubRequest{Prompt: "finishes"})
			child := waitChild(t, e.claude, 2)
			e.spawn(id, SpawnSubRequest{Prompt: "runs on"})
			runner := waitChild(t, e.claude, 3)
			if tc.refuse {
				parent.failSends(errors.New("stdin closed"))
			}
			release := parent.blockSends()
			defer release()
			child.emit(t, agent.Event{Kind: agent.EvText, Text: "report"}, agent.Event{Kind: agent.EvTurnEnd})
			if st := e.status(id); st != model.StatusThinking || e.subFile(id, sa.ID).Delivery != model.SubSent {
				t.Fatalf("not taken: status %q, %+v", st, e.subFile(id, sa.ID))
			}

			returns(t, "Interrupt", func() error { return e.m.Interrupt(id) })
			waitFor(t, "runner closed", func() bool { return agentClosed(runner) })
			if parent.interrupted() != 0 || len(parent.sent()) != 1 || parent.refused() != 0 {
				t.Fatalf("before the hand-off returned: %d signals, %d sends, %d refused",
					parent.interrupted(), len(parent.sent()), parent.refused())
			}
			release()
			e.m.handoffs.Wait()

			if tc.refuse {
				parent.failSends(nil)
				if parent.interrupted() != 0 || parent.refused() != 1 || len(parent.sent()) != 1 {
					t.Fatalf("%d signals, %d refused, %d sends", parent.interrupted(), parent.refused(), len(parent.sent()))
				}
				if st := e.status(id); st != model.StatusReady || e.meta(id).TurnActive {
					t.Fatalf("status %q after the refusal", st)
				}
				items := e.items(id)
				if len(notes(items, "error")) != 1 || len(notes(items, "muted")) != 0 {
					t.Fatalf("notes: error %q, muted %q", notes(items, "error"), notes(items, "muted"))
				}
				if f := e.subFile(id, sa.ID); f.Delivery != model.SubOwed {
					t.Fatalf("subagent.json %+v", f)
				}
				e.afterHold(id, parent, sa.ID)
				return
			}

			if parent.interrupted() != 1 || len(parent.sent()) != 2 {
				t.Fatalf("%d signals, %d sends", parent.interrupted(), len(parent.sent()))
			}
			if n := notes(e.items(id), "muted"); len(n) != 0 {
				t.Fatalf("notes %q before the turn ended", n)
			}
			parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
			e.m.handoffs.Wait()
			if n := notes(e.items(id), "muted"); len(n) != 1 || n[0] != "Stopped." {
				t.Fatalf("notes %q", n)
			}
			if len(parent.sent()) != 2 || parent.interrupted() != 1 || e.m.Busy(id) {
				t.Fatalf("after the aborted turn: %d sends, %d signals", len(parent.sent()), parent.interrupted())
			}
			// The human stopped the turn before the agent answered: what it carried is owed again,
			// with no failed attempt counted.
			if f := e.subFile(id, sa.ID); f.Delivery != model.SubOwed {
				t.Fatalf("subagent.json %+v", f)
			}
			e.afterHold(id, parent, sa.ID)
		})
	}
}

// With no hand-off in flight Interrupt still returns the agent's own error.
func TestInterruptReturnsAgentError(t *testing.T) {
	e := newEnv(t)
	id, parent := e.idleParent()
	e.spawn(id, SpawnSubRequest{Prompt: "go"})
	e.finish(waitChild(t, e.claude, 2), "report") // delivered: the turn is running, the hand-off done
	gone := errors.New("write |1: broken pipe")
	parent.mu.Lock()
	parent.interruptErr = gone
	parent.mu.Unlock()
	if err := e.m.Interrupt(id); !errors.Is(err, gone) {
		t.Fatalf("Interrupt: %v", err)
	}
	if parent.interrupted() != 1 {
		t.Fatalf("%d signals", parent.interrupted())
	}
}

// Stop ends the turn that was delivering results, and settles it: the results are owed again, and
// the human's next message carries them. When the old hand-off then comes back refused, nothing of
// it is left to be taken for the newer turn's. That refusal changes nothing: not the results, which
// the newer turn now carries, not that turn, and not the hold the human's message released.
func TestStopClearsDeliveryInFlight(t *testing.T) {
	inFlight := func(e *env, id string) *carry {
		c, err := e.m.lock(id)
		if err != nil {
			e.t.Fatal(err)
		}
		defer c.mu.Unlock()
		return c.carry
	}
	e := newEnv(t)
	id, parent := e.idleParent()
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)
	parent.failSends(errors.New("stdin closed"))
	release := parent.blockSends()
	defer release()
	child.emit(t, agent.Event{Kind: agent.EvText, Text: "report"}, agent.Event{Kind: agent.EvTurnEnd})
	old := inFlight(e, id)
	if old == nil {
		t.Fatal("no delivery in flight")
	}

	e.m.Stop(id)
	if inFlight(e, id) != nil {
		t.Fatal("Stop left the delivery in flight")
	}
	if f := e.subFile(id, sa.ID); f.Delivery != model.SubOwed {
		t.Fatalf("subagent.json after Stop %+v", f)
	}
	// The human's message starts a new process and a turn of its own, which carries the result.
	e.send(id, "again", "")
	next := e.claude.last(t)
	items := e.items(id)
	if len(next.sent()) != 1 || !reflect.DeepEqual(deliveredSids(next.sent()[0]), []string{sa.ID}) {
		t.Fatalf("%d sends to the new process, want the human's message carrying the result", len(next.sent()))
	}
	if d := inFlight(e, id); d == nil || d == old {
		t.Fatal("the human's turn does not carry the result")
	}

	release()
	e.m.handoffs.Wait()
	if parent.refused() != 1 || parent.interrupted() != 1 { // Stop's own signal, none after the hand-off
		t.Fatalf("%d refused, %d signals", parent.refused(), parent.interrupted())
	}
	if f := e.subFile(id, sa.ID); f.Delivery != model.SubSent {
		t.Fatalf("the late refusal changed what the newer turn carries: subagent.json %+v", f)
	}
	if st := e.status(id); st != model.StatusThinking || !e.meta(id).TurnActive || e.holding(id) {
		t.Fatalf("the late refusal changed the newer turn: status %q, held %v", st, e.holding(id))
	}
	if got := e.items(id); len(got) != len(items) || len(notes(got, "error")) != 0 {
		t.Fatalf("the late refusal wrote to the thread: %+v", got[len(items):])
	}
	next.emit(t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if len(next.sent()) != 1 || e.m.Busy(id) || e.subFile(id, sa.ID).Delivery != model.SubSent {
		t.Fatalf("%d sends to the new process, %+v", len(next.sent()), e.subFile(id, sa.ID))
	}
	if rows := resultRows(e.items(id)); len(rows) != 1 || rows[0] != sa.ID {
		t.Fatalf("result rows %v", rows)
	}
}

// A delivery never starts a process: results that meet a chat without one wait, held, for the
// human's message, which starts it.
func TestNoProcessResultsWaitForHuman(t *testing.T) {
	e := newEnv(t)
	id, parent := e.idleParent()
	parent.exit(t)
	procs := e.claude.count()
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	e.finish(waitChild(t, e.claude, procs+1), "report")
	e.held("with no process", id, parent, 1, sa.ID)
	if e.claude.count() != procs+1 {
		t.Fatalf("%d processes: the result started one", e.claude.count())
	}
	next := e.afterHold(id, nil, sa.ID)
	if next == parent || !next.opts.Resume {
		t.Fatalf("the human's message did not resume the agent: %+v", next.opts)
	}
}
