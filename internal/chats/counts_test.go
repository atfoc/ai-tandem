package chats

import (
	"encoding/json"
	"errors"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// chatViews decodes the chat views broadcast for chat id, in order.
func chatViews(t *testing.T, evs []map[string]any, id string) []model.ChatView {
	t.Helper()
	var out []model.ChatView
	for _, ev := range ofType(evs, "chat") {
		raw, _ := json.Marshal(ev["chat"])
		var v model.ChatView
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatal(err)
		}
		if v.ID == id {
			out = append(out, v)
		}
	}
	return out
}

// counted fails unless the chat's two subagent counts are running and owed wherever a client gets
// them: the chat's view, the views a snapshot is built from, and the last chat view broadcast since
// the previous check. changed says the step changed a count, so a view must have been broadcast. It
// returns the views broadcast since the previous check.
func (e *env) counted(when string, evs *events, id string, running, owed int, changed bool) []model.ChatView {
	e.t.Helper()
	e.m.handoffs.Wait()
	if v := e.view(id); v.SubsRunning != running || v.SubsOwed != owed {
		e.t.Fatalf("%s: the view has %d running, %d owed; want %d, %d", when, v.SubsRunning, v.SubsOwed, running, owed)
	}
	found := false
	for _, v := range e.m.Views() {
		if v.ID != id {
			continue
		}
		found = true
		if v.SubsRunning != running || v.SubsOwed != owed {
			e.t.Fatalf("%s: Views has %d running, %d owed; want %d, %d", when, v.SubsRunning, v.SubsOwed, running, owed)
		}
	}
	if !found {
		e.t.Fatalf("%s: the chat is not in Views", when)
	}
	sent := chatViews(e.t, evs.drain(e.t, e.br), id)
	if changed && len(sent) == 0 {
		e.t.Fatalf("%s: no chat view was broadcast", when)
	}
	if n := len(sent); n > 0 && (sent[n-1].SubsRunning != running || sent[n-1].SubsOwed != owed) {
		e.t.Fatalf("%s: the last chat view broadcast has %d running, %d owed; want %d, %d",
			when, sent[n-1].SubsRunning, sent[n-1].SubsOwed, running, owed)
	}
	return sent
}

// The chat view's two counts through a subagent's whole life and its result's delivery: spawn,
// completion, delivery, a failed delivery, stop_subagent, the carry with a human message, the retry,
// the give-up and an interrupt. After each step a client that only listens has the right numbers.
func TestSubCountsInView(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	id, parent := e.startSpawnParent() // mid-turn
	e.counted("before any subagent", evs, id, 0, 0, false)

	sa := e.spawn(id, SpawnSubRequest{Prompt: "a"})
	ca := waitChild(t, e.claude, 2)
	e.counted("first spawn", evs, id, 1, 0, true)
	sb := e.spawn(id, SpawnSubRequest{Prompt: "b"})
	waitChild(t, e.claude, 3)
	e.counted("second spawn", evs, id, 2, 0, true)
	sc := e.spawn(id, SpawnSubRequest{Prompt: "c"})
	cc := waitChild(t, e.claude, 4)
	e.spawn(id, SpawnSubRequest{Prompt: "d"})
	cd := waitChild(t, e.claude, 5)
	e.counted("four running", evs, id, 4, 0, true)

	// A completion that meets a busy parent is owed.
	e.finish(ca, "report a")
	e.counted("completion, parent busy", evs, id, 3, 1, true)

	// The parent's clean turn end delivers it.
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.counted("delivery", evs, id, 3, 0, true)
	e.delivery("delivery", id, sa.ID, model.SubSent)

	// The delivery's turn fails before the agent answered: owed again, and the chat is held.
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "API Error: overloaded"})
	e.counted("failed delivery", evs, id, 3, 1, true)
	e.delivery("failed delivery", id, sa.ID, model.SubOwedAgain)

	if err := e.m.StopSubagent(id, sb.ID); err != nil {
		t.Fatal(err)
	}
	e.counted("stop_subagent", evs, id, 2, 1, true)

	// A completion that meets a held parent is owed too.
	e.finish(cc, "report c")
	e.counted("completion, parent held", evs, id, 1, 2, true)

	// The human's message carries the one that has not failed; the other waits for the turn's end.
	e.send(id, "go on", "")
	e.counted("carried by the human's message", evs, id, 1, 1, true)
	e.delivery("carried", id, sc.ID, model.SubSent)
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd})
	e.counted("retry", evs, id, 1, 0, true)
	e.delivery("retry", id, sa.ID, model.SubSent)

	// The retry fails too: given up, which is not owed.
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "API Error: overloaded"})
	e.counted("given up", evs, id, 1, 0, false)
	e.delivery("given up", id, sa.ID, model.SubGivenUp)

	if err := e.m.Interrupt(id); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "child closed", func() bool { return agentClosed(cd) })
	e.counted("interrupt", evs, id, 0, 0, true)
}

// A completion that meets an idle parent is delivered in the lock hold that made it owed: clients
// get one chat view, the delivery turn's, and never a count that was owed for no time at all.
func TestSubCountsDeliveredAtOnce(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	id, parent := e.idleParent()
	e.spawn(id, SpawnSubRequest{Prompt: "a"})
	ca := waitChild(t, e.claude, 2)
	e.counted("spawn", evs, id, 1, 0, true)

	e.finish(ca, "report")
	sent := e.counted("delivered at once", evs, id, 0, 0, true)
	if len(sent) != 1 || sent[0].Status != model.StatusThinking {
		t.Fatalf("%d chat views, the last with status %q: want the delivery turn's alone", len(sent), sent[len(sent)-1].Status)
	}
	if len(parent.sent()) != 2 {
		t.Fatalf("%d sends", len(parent.sent()))
	}
}

// The other ways a count changes, each followed by a chat view: every way a parent's subagents are
// stopped with it, and a delivery or a human message the adapter refuses.
func TestSubCountsBroadcastOnEveryChange(t *testing.T) {
	// running is a chat in its first turn with two subagents running.
	running := func(t *testing.T) (*env, *events, string, *fakeAgent) {
		e := newEnv(t)
		evs := listen(t, e.br)
		id, parent := e.startSpawnParent()
		e.spawn(id, SpawnSubRequest{Prompt: "a"})
		waitChild(t, e.claude, 2)
		e.spawn(id, SpawnSubRequest{Prompt: "b"})
		waitChild(t, e.claude, 3)
		e.counted("two running", evs, id, 2, 0, true)
		return e, evs, id, parent
	}
	t.Run("spawn that fails", func(t *testing.T) {
		e := newEnv(t)
		evs := listen(t, e.br)
		id, _ := e.idleParent()
		e.counted("idle", evs, id, 0, 0, false)
		delete(e.m.Spawners, model.Cursor)
		if sa, err := e.m.SpawnSubagent(id, SpawnSubRequest{Prompt: "x", Kind: model.Cursor}); err == nil || sa.Status != model.SubFailed {
			t.Fatalf("spawn %+v %v", sa, err)
		}
		sent := e.counted("spawn failed", evs, id, 0, 0, true)
		if len(sent) != 2 || sent[0].SubsRunning != 1 {
			t.Fatalf("chat views %+v: want the receipt's, then the failure's", sent)
		}
	})
	t.Run("subagent whose process fails", func(t *testing.T) {
		e, evs, id, _ := running(t)
		child := e.claude.last(t)
		child.emit(t, agent.Event{Kind: agent.EvExit, ExitErr: "crashed"})
		e.counted("failed", evs, id, 1, 1, true)
		for _, s := range e.subs(id) {
			if s.Delivery == model.SubOwed && s.Status != model.SubFailed {
				t.Fatalf("owed subagent %+v", s)
			}
		}
	})
	t.Run("aborted turn end", func(t *testing.T) {
		e, evs, id, parent := running(t)
		parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
		e.counted("aborted", evs, id, 0, 0, true)
	})
	t.Run("parent exit", func(t *testing.T) {
		e, evs, id, parent := running(t)
		parent.exit(t)
		e.counted("exit", evs, id, 0, 0, true)
	})
	t.Run("idle parent exit", func(t *testing.T) {
		e, evs, id, parent := running(t)
		parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
		e.counted("idle", evs, id, 2, 0, false)
		parent.exit(t)
		e.counted("exit", evs, id, 0, 0, true)
	})
	t.Run("Stop", func(t *testing.T) {
		e, evs, id, _ := running(t)
		e.m.Stop(id)
		e.counted("Stop", evs, id, 0, 0, true)
	})
	t.Run("Shutdown", func(t *testing.T) {
		e, evs, id, _ := running(t)
		e.m.Shutdown()
		e.counted("Shutdown", evs, id, 0, 0, true)
	})
	t.Run("Shutdown during a carrying turn", func(t *testing.T) {
		e := newEnv(t)
		evs := listen(t, e.br)
		id, _, _, _, _ := e.delivering(model.Claude)
		e.counted("delivering", evs, id, 1, 0, true)
		e.m.Shutdown()
		e.counted("Shutdown", evs, id, 0, 1, true)
	})
	t.Run("refused delivery", func(t *testing.T) {
		e := newEnv(t)
		evs := listen(t, e.br)
		id, parent := e.idleParent()
		e.spawn(id, SpawnSubRequest{Prompt: "a"})
		ca := waitChild(t, e.claude, 2)
		parent.failSends(errors.New("stdin closed"))
		e.finish(ca, "report")
		e.counted("refused", evs, id, 0, 1, true)
		if e.m.Busy(id) || parent.refused() != 1 {
			t.Fatalf("busy %v, %d refused", e.m.Busy(id), parent.refused())
		}
	})
	t.Run("refused human message that carries", func(t *testing.T) {
		e := newEnv(t)
		evs := listen(t, e.br)
		id, parent, owed, _, _ := e.heldResult(model.Claude)
		e.counted("held", evs, id, 1, 1, true)
		parent.failSends(errors.New("stdin closed"))
		if err := e.m.Send(id, "go on", "", nil); err == nil {
			t.Fatal("the message was accepted")
		}
		sent := e.counted("refused", evs, id, 1, 1, true)
		if len(sent) != 2 || sent[0].SubsOwed != 0 {
			t.Fatalf("chat views %+v: want the carrying turn's, then the result owed again", sent)
		}
		e.delivery("refused", id, owed.ID, model.SubOwedAgain)
	})
}

// What changes neither count, nor anything else in the view, broadcasts no chat view.
func TestSubCountsNoBroadcastWithoutChange(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	id, _ := e.idleParent()
	sa := e.spawn(id, SpawnSubRequest{Prompt: "a"})
	ca := waitChild(t, e.claude, 2)
	e.counted("spawn", evs, id, 1, 0, true)

	ca.emit(t,
		agent.Event{Kind: agent.EvThinking},
		agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Bash"},
		agent.Event{Kind: agent.EvToolResult, ToolID: "t1", Result: "ok"},
		agent.Event{Kind: agent.EvUsage, CtxIn: 100, CtxWindow: 1000},
		agent.Event{Kind: agent.EvText, Text: "working"})
	if err := e.m.Open(id); err != nil {
		t.Fatal(err)
	}
	e.items(id)
	e.subItems(id, sa.ID)
	if err := e.m.StopSubagent(id, "nope"); !errors.Is(err, ErrNoSubagent) {
		t.Fatalf("StopSubagent: %v", err)
	}
	if sent := e.counted("nothing changed", evs, id, 1, 0, false); len(sent) != 0 {
		t.Fatalf("%d chat views broadcast for no change: %+v", len(sent), sent)
	}
}

// After a restart a chat's counts are zero until its thread is read: nothing runs, and what is owed
// is on its subagents' records. Reading it broadcasts the chat's view with the owed count, once,
// whichever call reads it first; a client does not ask for the view when it opens a chat.
func TestSubCountsAfterRestart(t *testing.T) {
	// owedAtBoot restarts the app over a chat that is owed one result and returns a listener of the
	// new run.
	owedAtBoot := func(t *testing.T, e *env, id string) *events {
		t.Helper()
		e.m.Shutdown()
		e.boot()
		evs := listen(t, e.br)
		if v := e.view(id); v.SubsRunning != 0 || v.SubsOwed != 0 {
			t.Fatalf("not loaded since boot: %d running, %d owed", v.SubsRunning, v.SubsOwed)
		}
		for _, v := range e.m.Views() {
			if v.SubsRunning != 0 || v.SubsOwed != 0 {
				t.Fatalf("Views at boot: chat %s has %d running, %d owed", v.ID, v.SubsRunning, v.SubsOwed)
			}
		}
		if e.claude.count() != 0 {
			t.Fatalf("%d processes at boot", e.claude.count())
		}
		return evs
	}

	t.Run("opened", func(t *testing.T) {
		e := newEnv(t)
		id, _, owed, _, _ := e.heldResult(model.Claude)
		other := e.create(model.Claude, gOne, "")
		evs := owedAtBoot(t, e, id)
		if err := e.m.Open(id); err != nil {
			t.Fatal(err)
		}
		sent := e.counted("opened", evs, id, 0, 1, true)
		if len(sent) != 1 || sent[0].Status != model.StatusReady {
			t.Fatalf("chat views at load %+v: want one", sent)
		}
		e.delivery("opened", id, owed.ID, model.SubOwed)

		// Reading it again says nothing new.
		if err := e.m.Open(id); err != nil {
			t.Fatal(err)
		}
		e.items(id)
		if sent := e.counted("opened again", evs, id, 0, 1, false); len(sent) != 0 {
			t.Fatalf("%d chat views for a chat already loaded", len(sent))
		}
		// A chat nobody opened still reports nothing, and one with no subagents says nothing at load.
		e.items(other.ID)
		if sent := e.counted("another chat", evs, other.ID, 0, 0, false); len(sent) != 0 {
			t.Fatalf("%d chat views for a chat with no subagents", len(sent))
		}

		// The next message carries the result: nothing is owed.
		e.send(id, "back", "")
		e.counted("carried", evs, id, 0, 0, true)
	})

	t.Run("items fetched first", func(t *testing.T) {
		e := newEnv(t)
		id, _, _, _, _ := e.heldResult(model.Claude)
		evs := owedAtBoot(t, e, id)
		e.items(id)
		if sent := e.counted("items", evs, id, 0, 1, true); len(sent) != 1 {
			t.Fatalf("chat views at load %+v: want one", sent)
		}
	})

	// A chat closed mid-turn gets its "Stopped" note and view at load; the owed count is in that
	// view, and no second one follows.
	t.Run("interrupted at boot", func(t *testing.T) {
		e := newEnv(t)
		id, _, _, _, _ := e.pendingParent() // mid-turn, one result owed
		evs := owedAtBoot(t, e, id)
		if err := e.m.Open(id); err != nil {
			t.Fatal(err)
		}
		sent := e.counted("opened", evs, id, 0, 1, true)
		if len(sent) != 1 || sent[0].Status != model.StatusStopped {
			t.Fatalf("chat views at load %+v: want one, stopped", sent)
		}
	})
}
