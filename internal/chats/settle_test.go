package chats

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// backstopNote is the note the manager adds when a carrying turn that is settled as not received
// ended without one of its own.
const backstopNote = "The agent's turn ended with no reply: the subagent results were not received."

// spawnerOf is the fake that starts kind's processes.
func (e *env) spawnerOf(kind model.AgentKind) *fakeSpawner {
	return map[model.AgentKind]*fakeSpawner{model.Claude: e.claude, model.Cursor: e.cursor, model.Pi: e.pi}[kind]
}

// delivering creates a chat of kind whose agent is in a turn the app started to hand it one
// subagent's result: it has the message and has shown no model output. Another subagent still runs.
func (e *env) delivering(kind model.AgentKind) (id string, parent *fakeAgent, carried, running model.Subagent, runner *fakeAgent) {
	e.t.Helper()
	sp := e.spawnerOf(kind)
	v := e.create(kind, gOne, "")
	e.send(v.ID, "delegate", "")
	e.m.naming.Wait()
	id, parent = v.ID, sp.last(e.t)
	parent.emit(e.t, agent.Event{Kind: agent.EvTurnEnd})
	carried = e.spawn(id, SpawnSubRequest{Prompt: "finishes"})
	done := waitChild(e.t, sp, 2)
	running = e.spawn(id, SpawnSubRequest{Prompt: "runs on"})
	runner = waitChild(e.t, sp, 3)
	e.finish(done, "report")
	if n := len(parent.sent()); n != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[n-1]), []string{carried.ID}) {
		e.t.Fatalf("%d sends, want the human's and the delivery of %s", n, carried.ID)
	}
	if st := e.status(id); st != model.StatusThinking || e.subFile(id, carried.ID).Delivery != model.SubSent {
		e.t.Fatalf("no delivery turn: status %q, %+v", st, e.subFile(id, carried.ID))
	}
	return id, parent, carried, running, runner
}

// holding reports whether the chat's hold is set.
// lastNote is the text of the thread's last note; an errored turn's end mark comes after its note.
func lastNote(items []model.Item) string {
	for i := len(items) - 1; i >= 0; i-- {
		if items[i].Kind == "note" {
			return items[i].Text
		}
	}
	return ""
}

func (e *env) holding(id string) bool {
	e.t.Helper()
	c, err := e.m.lock(id)
	if err != nil {
		e.t.Fatal(err)
	}
	defer c.mu.Unlock()
	return c.hold
}

// delivery fails unless sid's delivery state is want, in memory and on disk.
func (e *env) delivery(when, id, sid string, want model.SubDelivery) {
	e.t.Helper()
	if s := e.sub(id, sid); s.Delivery != want {
		e.t.Fatalf("%s: subagent %+v, want delivery %q", when, s, want)
	}
	if f := e.subFile(id, sid); f.Delivery != want {
		e.t.Fatalf("%s: subagent.json %+v, want delivery %q", when, f, want)
	}
}

// A carrying turn that ends with no model output and was not stopped by the human: an errored end,
// the process's exit, and on pi a clean end. Its results are owed again after one failed attempt,
// the thread has a note, and the chat is held: a result that comes later starts no turn.
func TestCarryingTurnNotReceived(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		kind model.AgentKind
		// end ends the turn and reports whether the agent's process is still there.
		end  func(t *testing.T, parent *fakeAgent) (alive bool)
		note string
	}{
		// "Thinking" is not model output: pi and Cursor signal it before the CLI has the message.
		{"errored end", model.Claude, func(t *testing.T, parent *fakeAgent) bool {
			parent.emit(t, agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvTurnEnd, Error: "API Error: overloaded"})
			return true
		}, "API Error: overloaded"},
		{"exit", model.Claude, func(t *testing.T, parent *fakeAgent) bool {
			parent.exit(t)
			return false
		}, "The agent stopped: process ended"},
		// The backstop: a failed pi turn can end like this, and writes no note of its own.
		{"clean end on pi", model.Pi, func(t *testing.T, parent *fakeAgent) bool {
			parent.emit(t, agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvTurnEnd})
			return true
		}, backstopNote},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			sp := e.spawnerOf(tc.kind)
			id, parent, carried, running, runner := e.delivering(tc.kind)
			alive := tc.end(t, parent)
			e.m.handoffs.Wait()

			e.delivery("after the turn", id, carried.ID, model.SubOwedAgain)
			items := e.items(id)
			if errs := notes(items, "error"); len(errs) != 1 || errs[0] != tc.note {
				t.Fatalf("error notes %q, want %q", errs, tc.note)
			}
			if got := diskItems(t, e.m.itemsPath(id)); len(got) != len(items) || lastNote(got) != tc.note {
				t.Fatalf("the note was not written: %+v", got)
			}
			if rows := resultRows(items); len(rows) != 1 || rows[0] != carried.ID {
				t.Fatalf("result rows %v", rows)
			}
			if e.m.Busy(id) || e.meta(id).TurnActive != !alive || !e.holding(id) || len(parent.sent()) != 2 {
				t.Fatalf("busy %v, turnActive %v, held %v, %d sends", e.m.Busy(id), e.meta(id).TurnActive, e.holding(id), len(parent.sent()))
			}

			// A second subagent that finishes afterwards starts no turn.
			second := running
			if alive {
				e.finish(runner, "second report")
			} else {
				waitFor(t, "runner closed", func() bool { return agentClosed(runner) })
				procs := sp.count()
				second = e.spawn(id, SpawnSubRequest{Prompt: "spawned last"})
				e.finish(waitChild(t, sp, procs+1), "second report")
			}
			if len(parent.sent()) != 2 || e.m.Busy(id) {
				t.Fatalf("a turn started on a held chat: %d sends", len(parent.sent()))
			}
			e.delivery("held", id, second.ID, model.SubOwed)
			e.delivery("held", id, carried.ID, model.SubOwedAgain)
		})
	}
}

// A carrying turn in which model output appeared, or which a Claude or Cursor agent ended cleanly
// without any: its results are delivered, whatever follows. The chat is held only by how the turn
// ended, and when it is not, a second subagent's result is sent.
func TestCarryingTurnDelivered(t *testing.T) {
	t.Parallel()
	text := []agent.Event{{Kind: agent.EvTextStart}, {Kind: agent.EvTextDelta, Text: "noted"}}
	with := func(evs []agent.Event, end agent.Event) []agent.Event {
		return append(append([]agent.Event(nil), evs...), end)
	}
	for _, tc := range []struct {
		name string
		kind model.AgentKind
		evs  []agent.Event
		held bool
	}{
		// The model took the message and said nothing.
		{"clean end with no output on claude", model.Claude, []agent.Event{{Kind: agent.EvThinking}, {Kind: agent.EvTurnEnd}}, false},
		{"clean end with no output on cursor", model.Cursor, []agent.Event{{Kind: agent.EvThinking}, {Kind: agent.EvTurnEnd}}, false},
		// The known limit: a Cursor turn that failed at the model writes the CLI's error as text and
		// ends cleanly, the same as an answer. Flip this case if the adapter learns to tell ([Q-18]).
		{"text then clean end on cursor", model.Cursor, []agent.Event{{Kind: agent.EvText, Text: "Error: usage limit reached"}, {Kind: agent.EvTurnEnd}}, false},
		{"text then clean end", model.Claude, with(text, agent.Event{Kind: agent.EvTurnEnd}), false},
		{"text then clean end on pi", model.Pi, with(text, agent.Event{Kind: agent.EvTurnEnd}), false},
		{"text then errored end", model.Claude, with(text, agent.Event{Kind: agent.EvTurnEnd, Error: "limit reached"}), true},
		{"tool call then errored end", model.Claude, []agent.Event{{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Bash"},
			{Kind: agent.EvTurnEnd, Error: "limit reached"}}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			id, parent, carried, running, runner := e.delivering(tc.kind)
			parent.emit(t, tc.evs...)
			e.m.handoffs.Wait()

			e.delivery("after the turn", id, carried.ID, model.SubSent)
			if e.m.Busy(id) || e.holding(id) != tc.held || len(parent.sent()) != 2 {
				t.Fatalf("busy %v, held %v (want %v), %d sends", e.m.Busy(id), e.holding(id), tc.held, len(parent.sent()))
			}
			if n := notes(e.items(id), "error"); tc.held != (len(n) == 1) {
				t.Fatalf("error notes %q", n)
			}

			e.finish(runner, "second report")
			if tc.held {
				if len(parent.sent()) != 2 || e.m.Busy(id) {
					t.Fatalf("a turn started on a held chat: %d sends", len(parent.sent()))
				}
				e.delivery("held", id, running.ID, model.SubOwed)
			} else {
				if n := len(parent.sent()); n != 3 || !reflect.DeepEqual(deliveredSids(parent.sent()[n-1]), []string{running.ID}) {
					t.Fatalf("%d sends, want the delivery of the second result", n)
				}
				e.delivery("delivered", id, running.ID, model.SubSent)
			}
			e.delivery("at the end", id, carried.ID, model.SubSent)
		})
	}
}

// The turn's end is settled before it is looked at as a trigger: a result that became owed during a
// carrying turn that is settled as not received does not go out at that turn's clean end.
func TestSettlementComesBeforeTurnEndTrigger(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent, carried, running, runner := e.delivering(model.Pi)
	e.finish(runner, "second report")
	e.delivery("during the turn", id, running.ID, model.SubOwed)
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if len(parent.sent()) != 2 || e.m.Busy(id) || !e.holding(id) {
		t.Fatalf("%d sends, busy %v, held %v", len(parent.sent()), e.m.Busy(id), e.holding(id))
	}
	e.delivery("after the turn", id, carried.ID, model.SubOwedAgain)
	e.delivery("after the turn", id, running.ID, model.SubOwed)
}

// A permission request raised by a subagent is not output of the agent the results went to.
func TestChildRequestIsNotModelOutput(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent, carried, running, runner := e.delivering(model.Claude)
	ask(t, runner, "", "p1")
	if c := e.card(id, running.ID, "p1"); c.Decided != "" || e.status(id) != model.StatusApproval {
		t.Fatalf("card %+v, status %q", c, e.status(id))
	}
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "API Error: overloaded"})
	e.delivery("after the turn", id, carried.ID, model.SubOwedAgain)
}

// Nor is one raised by a native subagent that an earlier turn left running, which reaches the app
// through the agent's own process.
func TestNativeSubagentRequestIsNotModelOutput(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.subStart()
	subRun(t, parent, "t1")
	native := e.onlySub(id)
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	e.finish(waitChild(t, e.claude, 2), "report")
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if len(parent.sent()) != 2 || e.subFile(id, sa.ID).Delivery != model.SubSent {
		t.Fatalf("no delivery turn: %d sends", len(parent.sent()))
	}
	ask(t, parent, "t1", "r1")
	if c := e.card(id, native, "r1"); c.Decided != "" || e.status(id) != model.StatusApproval {
		t.Fatalf("card %+v, status %q", c, e.status(id))
	}
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "API Error: overloaded"})
	e.delivery("after the turn", id, sa.ID, model.SubOwedAgain)
}

// The human stops a carrying turn. With no model output its results are owed again and the attempt
// does not count; with model output first they are delivered.
func TestHumanStopsCarryingTurn(t *testing.T) {
	t.Parallel()
	interrupt := func(t *testing.T, e *env, id string, parent *fakeAgent, runner *fakeAgent) {
		t.Helper()
		if err := e.m.Interrupt(id); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "runner closed", func() bool { return agentClosed(runner) })
		if parent.interrupted() != 1 {
			t.Fatalf("%d signals", parent.interrupted())
		}
	}

	t.Run("before model output", func(t *testing.T) {
		e := newEnv(t)
		id, parent, carried, _, runner := e.delivering(model.Claude)
		interrupt(t, e, id, parent, runner)
		e.delivery("before the turn ended", id, carried.ID, model.SubSent)
		parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
		e.m.handoffs.Wait()
		e.delivery("after the aborted end", id, carried.ID, model.SubOwed)
		items := e.items(id)
		if n := notes(items, "muted"); len(n) != 1 || n[0] != "Stopped." || len(notes(items, "error")) != 0 {
			t.Fatalf("notes: muted %q, error %q", n, notes(items, "error"))
		}
		if e.m.Busy(id) || !e.holding(id) || len(parent.sent()) != 2 {
			t.Fatalf("busy %v, held %v, %d sends", e.m.Busy(id), e.holding(id), len(parent.sent()))
		}

		// The stop was not a failed attempt: the human's next message carries the result, and when
		// that turn fails, that is its first.
		e.send(id, "go on", "")
		if n := len(parent.sent()); n != 3 || !reflect.DeepEqual(deliveredSids(parent.sent()[2]), []string{carried.ID}) {
			t.Fatalf("%d sends, want the result with the human's message", n)
		}
		parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "API Error: overloaded"})
		e.delivery("after a failed attempt", id, carried.ID, model.SubOwedAgain)
		if rows := resultRows(e.items(id)); len(rows) != 1 || rows[0] != carried.ID {
			t.Fatalf("result rows %v: one per subagent", rows)
		}
	})

	// A CLI need not report an interrupted turn as aborted. The human's stop decides, not the
	// CLI's report, on a backend where a clean end with no output would count as delivered.
	t.Run("before model output, clean end", func(t *testing.T) {
		e := newEnv(t)
		id, parent, carried, _, runner := e.delivering(model.Claude)
		interrupt(t, e, id, parent, runner)
		parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
		e.m.handoffs.Wait()
		e.delivery("after the clean end", id, carried.ID, model.SubOwed)
		if errs := notes(e.items(id), "error"); len(errs) != 1 || errs[0] != backstopNote {
			t.Fatalf("error notes %q", errs)
		}
		if e.m.Busy(id) || !e.holding(id) || len(parent.sent()) != 2 {
			t.Fatalf("busy %v, held %v, %d sends", e.m.Busy(id), e.holding(id), len(parent.sent()))
		}
	})

	t.Run("before model output, errored end", func(t *testing.T) {
		e := newEnv(t)
		id, parent, carried, _, runner := e.delivering(model.Claude)
		interrupt(t, e, id, parent, runner)
		parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "request cancelled"})
		e.delivery("after the errored end", id, carried.ID, model.SubOwed)
	})

	t.Run("after model output", func(t *testing.T) {
		e := newEnv(t)
		id, parent, carried, _, runner := e.delivering(model.Claude)
		parent.emit(t, agent.Event{Kind: agent.EvText, Text: "reading the report"})
		interrupt(t, e, id, parent, runner)
		parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
		e.m.handoffs.Wait()
		e.delivery("after the aborted end", id, carried.ID, model.SubSent)
		if !e.holding(id) || len(parent.sent()) != 2 {
			t.Fatalf("held %v, %d sends", e.holding(id), len(parent.sent()))
		}
		e.afterHold(id, parent)
	})

	// A permission request of the agent's own is model output: only a tool call raises one.
	t.Run("after its own permission request", func(t *testing.T) {
		e := newEnv(t)
		id, parent, carried, _, runner := e.delivering(model.Claude)
		ask(t, parent, "", "r1")
		interrupt(t, e, id, parent, runner)
		parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
		e.m.handoffs.Wait()
		e.delivery("after the aborted end", id, carried.ID, model.SubSent)
		if c := e.card(id, "", "r1"); c.Decided != "deny" {
			t.Fatalf("card %+v", c)
		}
		e.afterHold(id, parent)
	})
}

// A result whose delivery failed once is not carried by the human's message. It goes out once more
// at the clean end of the human's turn. If that turn fails too it is given up: never carried again,
// whatever is sent or finishes later, with its report still on its record. Every change of its
// state is sent to the clients.
func TestRetryOnceThenGiveUp(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	evs := listen(t, e.br)
	id, parent, sa, sb, runner := e.delivering(model.Claude)
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "API Error: overloaded"})
	e.delivery("first failure", id, sa.ID, model.SubOwedAgain)

	// The human's message goes without it; the retry is the turn after, with what became owed
	// during the human's turn.
	e.send(id, "go on", "")
	if n := len(parent.sent()); n != 3 || !reflect.DeepEqual(texts(parent.sent()[2]), []string{"go on"}) {
		t.Fatalf("%d sends; the human's message is %q", n, texts(parent.sent()[n-1]))
	}
	e.delivery("during the human's turn", id, sa.ID, model.SubOwedAgain)
	e.clock.Store(testNow + 10)
	e.finish(runner, "report two")
	e.delivery("pending", id, sb.ID, model.SubOwed)
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if n := len(parent.sent()); n != 4 || !reflect.DeepEqual(deliveredSids(parent.sent()[3]), []string{sa.ID, sb.ID}) {
		t.Fatalf("%d sends, the last delivers %v", n, deliveredSids(parent.sent()[n-1]))
	}
	e.delivery("retry under way", id, sa.ID, model.SubSent)

	// The retry fails: the one that failed before is given up, the other has its first failure.
	parent.emit(t, agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvTurnEnd, Error: "API Error: overloaded"})
	e.m.handoffs.Wait()
	e.delivery("second failure", id, sa.ID, model.SubGivenUp)
	e.delivery("second failure", id, sb.ID, model.SubOwedAgain)
	if !e.holding(id) || e.m.Busy(id) || len(parent.sent()) != 4 {
		t.Fatalf("held %v, busy %v, %d sends", e.holding(id), e.m.Busy(id), len(parent.sent()))
	}
	c, err := e.m.lock(id)
	if err != nil {
		t.Fatal(err)
	}
	owed := owedSubs(c)
	c.mu.Unlock()
	if len(owed) != 1 || owed[0].meta.ID != sb.ID {
		t.Fatalf("%d owed: a given-up result is not owed", len(owed))
	}

	// Further human turns and triggers never carry it again; the other is retried and received.
	e.send(id, "and now?", "")
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if n := len(parent.sent()); n != 6 || deliveredSids(parent.sent()[4]) != nil || !reflect.DeepEqual(deliveredSids(parent.sent()[5]), []string{sb.ID}) {
		t.Fatalf("%d sends, the last delivers %v", n, deliveredSids(parent.sent()[n-1]))
	}
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "got it"}, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	e.delivery("retried", id, sb.ID, model.SubSent)
	sc := e.spawn(id, SpawnSubRequest{Prompt: "three"})
	e.finish(waitChild(t, e.claude, 4), "report three")
	if n := len(parent.sent()); n != 7 || !reflect.DeepEqual(deliveredSids(parent.sent()[6]), []string{sc.ID}) {
		t.Fatalf("%d sends, the last delivers %v", n, deliveredSids(parent.sent()[n-1]))
	}
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	e.deliverNow(id)
	if n := carriedTimes(parent.sent(), sa.ID); n != 2 || len(parent.sent()) != 7 {
		t.Fatalf("the given-up result was carried %d times, in %d sends", n, len(parent.sent()))
	}
	e.delivery("at the end", id, sa.ID, model.SubGivenUp)
	if s := e.sub(id, sa.ID); s.Last != "report" || s.Status != model.SubCompleted {
		t.Fatalf("the given-up result's record %+v", s)
	}
	var states []model.SubDelivery
	for _, ev := range ofType(evs.drain(t, e.br), "sub") {
		if got := subOf(t, ev); got.ID == sa.ID && (len(states) == 0 || states[len(states)-1] != got.Delivery) {
			states = append(states, got.Delivery)
		}
	}
	if want := []model.SubDelivery{model.SubNotOwed, model.SubOwed, model.SubSent, model.SubOwedAgain, model.SubSent, model.SubGivenUp}; !reflect.DeepEqual(states, want) {
		t.Fatalf("delivery states sent to clients %q, want %q", states, want)
	}
	if rows := resultRows(e.items(id)); !reflect.DeepEqual(rows, []string{sa.ID, sb.ID, sc.ID}) {
		t.Fatalf("result rows %v: one per subagent", rows)
	}

	// It stays given up across a restart.
	e.m.Shutdown()
	e.boot()
	if s := e.sub(id, sa.ID); s.Delivery != model.SubGivenUp || s.Last != "report" {
		t.Fatalf("after boot %+v", s)
	}
	e.send(id, "back", "")
	next := e.claude.last(t)
	next.emit(t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if len(next.sent()) != 1 || deliveredSids(next.sent()[0]) != nil {
		t.Fatalf("%d sends after boot, carrying %v", len(next.sent()), deliveredSids(next.sent()[0]))
	}
}

// Results that shared two failed turns are given up together.
func TestBatchGivenUpTogether(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.startSpawnParent() // mid-turn
	sa := e.spawn(id, SpawnSubRequest{Prompt: "a"})
	ca := waitChild(t, e.claude, 2)
	sb := e.spawn(id, SpawnSubRequest{Prompt: "b"})
	cb := waitChild(t, e.claude, 3)
	e.finish(ca, "report a")
	e.finish(cb, "report b")
	both := []string{sa.ID, sb.ID}
	sort.Strings(both) // they ended in the same millisecond

	for attempt, want := range []model.SubDelivery{model.SubOwedAgain, model.SubGivenUp} {
		parent.emit(t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd})
		e.m.handoffs.Wait()
		if n := len(parent.sent()); n != 2*(attempt+1) || !reflect.DeepEqual(deliveredSids(parent.sent()[n-1]), both) {
			t.Fatalf("attempt %d: %d sends, the last delivers %v", attempt, n, deliveredSids(parent.sent()[n-1]))
		}
		parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "API Error: overloaded"})
		for _, sid := range both {
			e.delivery("after the failed turn", id, sid, want)
		}
		e.send(id, "go on", "")
	}
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if len(parent.sent()) != 5 || e.m.Busy(id) {
		t.Fatalf("%d sends, busy %v: given-up results were carried again", len(parent.sent()), e.m.Busy(id))
	}
	if rows := resultRows(e.items(id)); !reflect.DeepEqual(rows, both) {
		t.Fatalf("result rows %v", rows)
	}
}

// pi ends a turn itself, with an error, when it rejects the prompt, and then returns that error
// from Send. The pump and the hand-off can come to the two in either order. In both the turn is
// settled once, the thread gets one note, one turn is counted, and a human message that got in
// between keeps its turn.
func TestRefusalRace(t *testing.T) {
	t.Parallel()
	const rejected = "pi rejected the prompt: no model"
	ended := []agent.Event{{Kind: agent.EvThinking}, {Kind: agent.EvTurnEnd, Error: rejected}}
	for _, tc := range []struct {
		name      string
		pumpFirst bool
		human     bool // a human message lands between the two
		note      string
	}{
		{"pump first", true, false, rejected},
		{"pump first, human message between", true, true, rejected},
		{"hand-off first", false, false, "The subagent results could not be sent to the agent: " + rejected},
		{"hand-off first, human message between", false, true, "The subagent results could not be sent to the agent: " + rejected},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			v := e.create(model.Pi, gOne, "")
			id := v.ID
			e.send(id, "delegate", "")
			e.m.naming.Wait()
			parent := e.pi.last(t)
			parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
			sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
			child := waitChild(t, e.pi, 2)
			turns := e.meta(id).Usage.Turns

			// one fails unless the refused delivery left exactly its one trace.
			one := func(when string) {
				t.Helper()
				e.delivery(when, id, sa.ID, model.SubOwedAgain)
				items := e.items(id)
				if errs := notes(items, "error"); len(errs) != 1 || errs[0] != tc.note {
					t.Fatalf("%s: error notes %q, want %q", when, errs, tc.note)
				}
				if rows := resultRows(items); len(rows) != 1 {
					t.Fatalf("%s: result rows %v", when, rows)
				}
				if got := e.meta(id).Usage.Turns; got != turns+1 {
					t.Fatalf("%s: %d turns counted for the refused delivery", when, got-turns)
				}
				if parent.refused() != 1 {
					t.Fatalf("%s: %d refusals", when, parent.refused())
				}
			}
			idle := func(when string) {
				t.Helper()
				if st := e.status(id); st != model.StatusReady || e.meta(id).TurnActive || !e.holding(id) {
					t.Fatalf("%s: status %q, turnActive %v, held %v", when, st, e.meta(id).TurnActive, e.holding(id))
				}
			}
			inTurn := func(when string) {
				t.Helper()
				if st := e.status(id); st != model.StatusThinking || !e.meta(id).TurnActive || e.holding(id) {
					t.Fatalf("%s: the human's turn: status %q, turnActive %v, held %v", when, st, e.meta(id).TurnActive, e.holding(id))
				}
			}
			human := func() {
				t.Helper()
				parent.failSends(nil)
				e.send(id, "go on", "")
				if len(parent.sent()) != 2 || deliveredSids(parent.sent()[1]) != nil {
					t.Fatalf("%d sends", len(parent.sent()))
				}
			}

			if tc.pumpFirst {
				parent.failSends(errors.New(rejected), ended...)
				reached, release := parent.pauseRefusal()
				defer release()
				child.emit(t, agent.Event{Kind: agent.EvText, Text: "report"}, agent.Event{Kind: agent.EvTurnEnd})
				<-reached // the pump has ended the turn; the hand-off does not have the error yet
				one("after the pump")
				idle("after the pump")
				if tc.human {
					human()
				}
				release()
				e.m.handoffs.Wait()
			} else {
				parent.failSends(errors.New(rejected))
				e.finish(child, "report") // the hand-off has the error; the pump has not come to the turn's end
				e.delivery("after the hand-off", id, sa.ID, model.SubOwedAgain)
				idle("after the hand-off")
				if tc.human {
					human()
				}
				parent.emit(t, ended[0])
				if !tc.human {
					idle("after the late thinking")
				}
				parent.emit(t, ended[1])
			}

			one("after both")
			if !tc.human {
				idle("after both")
				parent.failSends(nil)
				e.send(id, "go on", "")
			}
			inTurn("after both")

			// The human's turn ends as any turn, and the retry goes out after it.
			parent.emit(t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd})
			e.m.handoffs.Wait()
			if got := e.meta(id).Usage.Turns; got != turns+2 {
				t.Fatalf("%d turns counted for the delivery and the human's turn", got-turns)
			}
			if n := len(parent.sent()); n != 3 || !reflect.DeepEqual(deliveredSids(parent.sent()[2]), []string{sa.ID}) {
				t.Fatalf("%d sends, want the retry at the end of the human's turn", n)
			}
			parent.emit(t, agent.Event{Kind: agent.EvText, Text: "thanks"}, agent.Event{Kind: agent.EvTurnEnd})
			e.delivery("retried", id, sa.ID, model.SubSent)
			if errs := notes(e.items(id), "error"); len(errs) != 1 {
				t.Fatalf("error notes %q", errs)
			}
		})
	}
}

// A refusal with an error the turn's own end does not carry: that end is the next turn's, and is
// not taken for the refused delivery's.
func TestRefusalThenUnrelatedTurnEnd(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.idleParent()
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)
	parent.failSends(errors.New("no ack from the agent"), agent.Event{Kind: agent.EvThinking})
	e.finish(child, "report")
	e.delivery("refused", id, sa.ID, model.SubOwedAgain)
	parent.failSends(nil)
	e.send(id, "go on", "")
	parent.emit(t, agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvTurnEnd, Error: "API Error: overloaded"})
	if e.m.Busy(id) || e.meta(id).TurnActive || !e.holding(id) {
		t.Fatalf("the human's turn did not end: busy %v, held %v", e.m.Busy(id), e.holding(id))
	}
	if errs := notes(e.items(id), "error"); len(errs) != 2 || errs[1] != "API Error: overloaded" {
		t.Fatalf("error notes %q", errs)
	}
	// The human's turn carried nothing: its failure is no attempt of the result's.
	e.delivery("after the human's failed turn", id, sa.ID, model.SubOwedAgain)

	// The refused delivery's end is waited for no longer: a turn that ends with its error ends.
	e.send(id, "and now?", "")
	parent.emit(t, agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvTurnEnd, Error: "no ack from the agent"})
	if errs := notes(e.items(id), "error"); e.m.Busy(id) || e.meta(id).TurnActive || len(errs) != 3 {
		t.Fatalf("the next turn did not end: busy %v, error notes %q", e.m.Busy(id), errs)
	}
}

// A refused delivery that had no turn end of its own, and then a turn in which the agent answers and
// which ends with the refusal's error: that end is the newer turn's, and ends it.
func TestRefusalThenTurnEndWithItsError(t *testing.T) {
	t.Parallel()
	const cause = "connection lost"
	e := newEnv(t)
	id, parent := e.idleParent()
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)
	parent.failSends(errors.New(cause), agent.Event{Kind: agent.EvThinking})
	e.finish(child, "report")
	e.delivery("refused", id, sa.ID, model.SubOwedAgain)
	turns := e.meta(id).Usage.Turns
	parent.failSends(nil)
	e.send(id, "go on", "")
	parent.emit(t, agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvText, Text: "looking"},
		agent.Event{Kind: agent.EvTurnEnd, Error: cause})
	if e.m.Busy(id) || e.meta(id).TurnActive || !e.holding(id) || e.meta(id).Usage.Turns != turns+1 {
		t.Fatalf("the human's turn did not end: busy %v, held %v, %d turns", e.m.Busy(id), e.holding(id), e.meta(id).Usage.Turns-turns)
	}
	if errs := notes(e.items(id), "error"); len(errs) != 2 || errs[1] != cause {
		t.Fatalf("error notes %q", errs)
	}
	e.delivery("after the human's failed turn", id, sa.ID, model.SubOwedAgain)
}

// A result owed after a failed attempt whose record cannot be written is not handed over, and keeps
// its failed attempt: the retry that follows is its last.
func TestRecordWriteFailureKeepsFailedAttempt(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent, carried, _, _ := e.delivering(model.Claude)
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "API Error: overloaded"})
	e.delivery("first failure", id, carried.ID, model.SubOwedAgain)

	// subagent.json can no longer be replaced.
	block := filepath.Join(e.subDir(id, carried.ID), "subagent.json.tmp")
	if err := os.Mkdir(block, 0o700); err != nil {
		t.Fatal(err)
	}
	e.send(id, "go on", "")
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if len(parent.sent()) != 3 || e.m.Busy(id) || !e.holding(id) {
		t.Fatalf("%d sends, busy %v, held %v", len(parent.sent()), e.m.Busy(id), e.holding(id))
	}
	e.delivery("not written", id, carried.ID, model.SubOwedAgain)

	if err := os.Remove(block); err != nil {
		t.Fatal(err)
	}
	e.send(id, "and now?", "")
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if n := len(parent.sent()); n != 5 || !reflect.DeepEqual(deliveredSids(parent.sent()[4]), []string{carried.ID}) {
		t.Fatalf("%d sends, want the retry at the end of the human's turn", n)
	}
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "API Error: overloaded"})
	e.delivery("second failure", id, carried.ID, model.SubGivenUp)
}

// The refusal comes after the delivery's turn was settled some other way: it changes nothing. The
// results are not put back as owed, the chat is not held again, and no note is added.
func TestLateRefusalChangesNothing(t *testing.T) {
	t.Parallel()
	blocked := func(t *testing.T) (e *env, id string, parent *fakeAgent, sa model.Subagent, release func()) {
		t.Helper()
		e = newEnv(t)
		id, parent = e.idleParent()
		sa = e.spawn(id, SpawnSubRequest{Prompt: "go"})
		child := waitChild(t, e.claude, 2)
		parent.failSends(errors.New("stdin closed"))
		release = parent.blockSends()
		t.Cleanup(release)
		child.emit(t, agent.Event{Kind: agent.EvText, Text: "report"}, agent.Event{Kind: agent.EvTurnEnd})
		if st := e.status(id); st != model.StatusThinking || e.subFile(id, sa.ID).Delivery != model.SubSent {
			t.Fatalf("not taken: status %q", st)
		}
		return e, id, parent, sa, release
	}

	// Claude ends the turn cleanly with no output: delivered. The chat is idle and not held, so a
	// result put back as owed would wait for a trigger that never comes.
	t.Run("after a clean end", func(t *testing.T) {
		e, id, parent, sa, release := blocked(t)
		parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
		e.delivery("after the clean end", id, sa.ID, model.SubSent)
		release()
		e.m.handoffs.Wait()
		if parent.refused() != 1 {
			t.Fatalf("%d refusals", parent.refused())
		}
		e.delivery("after the late refusal", id, sa.ID, model.SubSent)
		items := e.items(id)
		if e.m.Busy(id) || e.holding(id) || len(notes(items, "error")) != 0 {
			t.Fatalf("busy %v, held %v, error notes %q", e.m.Busy(id), e.holding(id), notes(items, "error"))
		}
		parent.failSends(nil)
		sb := e.spawn(id, SpawnSubRequest{Prompt: "next"})
		e.finish(waitChild(t, e.claude, 3), "next report")
		if n := len(parent.sent()); n != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{sb.ID}) {
			t.Fatalf("%d sends, want the next result delivered", n)
		}
	})

	// The exit settled the turn as a failed attempt. The late refusal is not a second one, and
	// does not end or hold the turn of the human's message that started a new process meanwhile.
	t.Run("after an exit", func(t *testing.T) {
		e, id, parent, sa, release := blocked(t)
		parent.exit(t)
		e.delivery("after the exit", id, sa.ID, model.SubOwedAgain)
		e.send(id, "again", "")
		next := e.claude.last(t)
		items := e.items(id)
		release()
		e.m.handoffs.Wait()
		if parent.refused() != 1 {
			t.Fatalf("%d refusals", parent.refused())
		}
		e.delivery("after the late refusal", id, sa.ID, model.SubOwedAgain)
		if st := e.status(id); st != model.StatusThinking || !e.meta(id).TurnActive || e.holding(id) {
			t.Fatalf("the late refusal changed the newer turn: status %q, held %v", st, e.holding(id))
		}
		if got := e.items(id); len(got) != len(items) || len(notes(got, "error")) != 1 {
			t.Fatalf("the late refusal wrote to the thread: %+v", got[len(items):])
		}
		next.emit(t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd})
		e.m.handoffs.Wait()
		if n := len(next.sent()); n != 2 || !reflect.DeepEqual(deliveredSids(next.sent()[1]), []string{sa.ID}) {
			t.Fatalf("%d sends to the new process, want the retry at the end of the human's turn", n)
		}
	})

	// Model output settled the turn as delivered while the hand-off had not returned (pi can answer
	// a prompt whose ack it then fails to give in time). The turn goes on.
	t.Run("after model output", func(t *testing.T) {
		e, id, parent, sa, release := blocked(t)
		parent.emit(t, agent.Event{Kind: agent.EvText, Text: "reading"})
		release()
		e.m.handoffs.Wait()
		e.delivery("after the late refusal", id, sa.ID, model.SubSent)
		if st := e.status(id); !e.m.Busy(id) || e.holding(id) || len(notes(e.items(id), "error")) != 0 {
			t.Fatalf("status %q, held %v, error notes %q", st, e.holding(id), notes(e.items(id), "error"))
		}
		parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
		if e.m.Busy(id) || e.holding(id) {
			t.Fatalf("busy %v, held %v after the turn", e.m.Busy(id), e.holding(id))
		}
	})
}

// Stop (archive) settles the turn that was carrying results, as stopped by the human.
func TestStopDuringCarryingTurn(t *testing.T) {
	t.Parallel()
	t.Run("no model output", func(t *testing.T) {
		e := newEnv(t)
		id, parent, carried, _, _ := e.delivering(model.Claude)
		e.m.Stop(id)
		e.delivery("after Stop", id, carried.ID, model.SubOwed)
		if e.m.Busy(id) || !e.holding(id) {
			t.Fatalf("busy %v, held %v", e.m.Busy(id), e.holding(id))
		}
		// What the stopped process still says is dropped: it is no failed attempt.
		parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "killed"})
		e.delivery("after the old process's end", id, carried.ID, model.SubOwed)
		if errs := notes(e.items(id), "error"); len(errs) != 0 {
			t.Fatalf("error notes %q", errs)
		}
		e.afterHold(id, nil, carried.ID)
	})

	t.Run("with model output", func(t *testing.T) {
		e := newEnv(t)
		id, parent, carried, _, _ := e.delivering(model.Claude)
		parent.emit(t, agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Read"})
		e.m.Stop(id)
		e.delivery("after Stop", id, carried.ID, model.SubSent)
		e.afterHold(id, nil)
	})
}

// Delete during a carrying turn: nothing is written for the chat afterwards, whatever its old
// process or a hand-off still in flight comes back with.
func TestDeleteDuringCarryingTurn(t *testing.T) {
	t.Parallel()
	gone := func(t *testing.T, e *env, id string) {
		t.Helper()
		if _, err := os.Stat(e.st.P.ChatDir(id)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("the chat's folder is there: %v", err)
		}
		if _, err := e.m.View(id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("View: %v", err)
		}
	}

	t.Run("turn running", func(t *testing.T) {
		e := newEnv(t)
		id, parent, _, _, _ := e.delivering(model.Claude)
		if err := e.m.Delete(id); err != nil {
			t.Fatal(err)
		}
		gone(t, e, id)
		parent.emit(t, agent.Event{Kind: agent.EvText, Text: "late"}, agent.Event{Kind: agent.EvTurnEnd, Error: "killed"})
		e.m.handoffs.Wait()
		gone(t, e, id)
	})

	for _, refuse := range []bool{true, false} {
		name := "hand-off accepted afterwards"
		if refuse {
			name = "hand-off refused afterwards"
		}
		t.Run(name, func(t *testing.T) {
			e := newEnv(t)
			id, parent := e.idleParent()
			e.spawn(id, SpawnSubRequest{Prompt: "go"})
			child := waitChild(t, e.claude, 2)
			if refuse {
				parent.failSends(errors.New("stdin closed"))
			}
			release := parent.blockSends()
			defer release()
			child.emit(t, agent.Event{Kind: agent.EvText, Text: "report"}, agent.Event{Kind: agent.EvTurnEnd})
			if e.status(id) != model.StatusThinking {
				t.Fatal("not taken")
			}
			returns(t, "Delete", func() error { return e.m.Delete(id) })
			gone(t, e, id)
			release()
			e.m.handoffs.Wait()
			gone(t, e, id)
			if parent.interrupted() != 1 { // Stop's own signal, none after the hand-off
				t.Fatalf("%d signals", parent.interrupted())
			}
		})
	}
}

// Shutdown settles a carrying turn itself, as stopped by the human: with no model output its
// results are owed again, with no failed attempt counted, whatever the closing process then does.
func TestShutdownDuringCarryingTurn(t *testing.T) {
	t.Parallel()
	t.Run("no model output", func(t *testing.T) {
		e := newEnv(t)
		id, parent, carried, running, _ := e.delivering(model.Claude)
		e.m.Shutdown()
		if f := e.subFile(id, carried.ID); f.Delivery != model.SubOwed {
			t.Fatalf("subagent.json after Shutdown %+v", f)
		}
		parent.exit(t) // the closing process's exit, handled before the server ends
		if f := e.subFile(id, carried.ID); f.Delivery != model.SubOwed {
			t.Fatalf("subagent.json after the exit %+v", f)
		}
		e.boot()
		e.delivery("after boot", id, carried.ID, model.SubOwed)
		e.delivery("after boot", id, running.ID, model.SubNotOwed) // stopped by Shutdown
		if rows := resultRows(e.items(id)); len(rows) != 1 || rows[0] != carried.ID {
			t.Fatalf("result rows after boot %v", rows)
		}
		e.afterHold(id, nil, carried.ID)
	})

	t.Run("with model output", func(t *testing.T) {
		e := newEnv(t)
		id, parent, carried, _, _ := e.delivering(model.Claude)
		parent.emit(t, agent.Event{Kind: agent.EvTextStart}, agent.Event{Kind: agent.EvTextDelta, Text: "reading"})
		e.m.Shutdown()
		parent.exit(t)
		e.boot()
		e.delivery("after boot", id, carried.ID, model.SubSent)
		e.afterHold(id, nil)
	})

	// A retry in flight keeps its one failed attempt: the shutdown is not a second.
	t.Run("retry in flight", func(t *testing.T) {
		e := newEnv(t)
		id, parent, carried, _, _ := e.delivering(model.Claude)
		parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "API Error: overloaded"})
		e.send(id, "go on", "")
		parent.emit(t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd})
		e.m.handoffs.Wait()
		if f := e.subFile(id, carried.ID); f.Delivery != model.SubSent || len(parent.sent()) != 4 {
			t.Fatalf("no retry under way: %+v, %d sends", f, len(parent.sent()))
		}
		e.m.Shutdown()
		e.boot()
		e.delivery("after boot", id, carried.ID, model.SubOwedAgain)
	})

	// The hand-off had not returned at Shutdown, and is refused by the closing process.
	t.Run("hand-off in flight", func(t *testing.T) {
		e := newEnv(t)
		id, parent := e.idleParent()
		sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
		child := waitChild(t, e.claude, 2)
		parent.failSends(errors.New("stdin closed"))
		release := parent.blockSends()
		defer release()
		child.emit(t, agent.Event{Kind: agent.EvText, Text: "report"}, agent.Event{Kind: agent.EvTurnEnd})
		if e.subFile(id, sa.ID).Delivery != model.SubSent {
			t.Fatal("not taken")
		}
		old := e.m
		e.m.Shutdown()
		release()
		old.handoffs.Wait()
		if f := e.subFile(id, sa.ID); f.Delivery != model.SubOwed {
			t.Fatalf("subagent.json after the late refusal %+v", f)
		}
		e.boot()
		e.delivery("after boot", id, sa.ID, model.SubOwed)
	})
}

// The hand-off of a delivery that starts at a turn's end does not run on the pump: with the agent's
// Send blocked, the pump goes on taking the agent's events.
func TestTurnEndHandOffNotOnPump(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent, owed, _, _ := e.pendingParent()
	release := parent.blockSends()
	defer release()
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "spawned"}, agent.Event{Kind: agent.EvTurnEnd})
	if st := e.status(id); st != model.StatusThinking || e.subFile(id, owed.ID).Delivery != model.SubSent || len(parent.sent()) != 1 {
		t.Fatalf("no delivery waiting on the agent: status %q, %d sends", st, len(parent.sent()))
	}
	parent.emit(t, agent.Event{Kind: agent.EvUsage, CtxIn: 4321})
	if got := e.view(id).Usage.CtxIn; got != 4321 {
		t.Fatalf("the pump did not take the next event: context %d", got)
	}
	release()
	e.m.handoffs.Wait()
	if n := len(parent.sent()); n != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{owed.ID}) {
		t.Fatalf("%d sends after the hand-off", n)
	}
}

// An Interrupt that came while results were being handed over is passed on once the agent has the
// message. When the delivery's turn has ended by then, there is nothing to stop: no signal.
func TestDeferredInterruptDroppedAfterTurnEnded(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.idleParent()
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)
	release := parent.blockSends()
	defer release()
	child.emit(t, agent.Event{Kind: agent.EvText, Text: "report"}, agent.Event{Kind: agent.EvTurnEnd})
	if e.status(id) != model.StatusThinking {
		t.Fatal("not taken")
	}
	returns(t, "Interrupt", func() error { return e.m.Interrupt(id) })
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
	if e.m.Busy(id) || parent.interrupted() != 0 {
		t.Fatalf("busy %v, %d signals before the hand-off returned", e.m.Busy(id), parent.interrupted())
	}
	release()
	e.m.handoffs.Wait()
	if parent.interrupted() != 0 || len(parent.sent()) != 2 {
		t.Fatalf("%d signals, %d sends: the signal for a turn that had ended was sent", parent.interrupted(), len(parent.sent()))
	}
	// The human stopped it before any model output: owed again, with no failed attempt.
	e.delivery("after the hand-off", id, sa.ID, model.SubOwed)
	e.afterHold(id, parent, sa.ID)
}
