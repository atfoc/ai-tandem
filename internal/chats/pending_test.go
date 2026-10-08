package chats

import (
	"errors"
	"reflect"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// A result that becomes owed while the parent is thinking waits for the clean end of that turn.
func TestPendingResultGoesOutAtTurnEnd(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	evs := listen(t, e.br)
	id, parent := e.startSpawnParent() // mid-turn
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	e.finish(waitChild(t, e.claude, 2), "report")
	if len(parent.sent()) != 1 {
		t.Fatal("a result was sent to a busy parent")
	}
	if f := e.subFile(id, sa.ID); f.Delivery != model.SubOwed {
		t.Fatalf("subagent.json %+v", f)
	}
	evs.drain(t, e.br)

	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "spawned"}, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{sa.ID}) {
		t.Fatalf("%d sends, the last delivers %v", len(parent.sent()), deliveredSids(parent.sent()[len(parent.sent())-1]))
	}
	if f := e.subFile(id, sa.ID); f.Delivery != model.SubSent {
		t.Fatalf("subagent.json %+v", f)
	}
	if rows := resultRows(e.items(id)); len(rows) != 1 || rows[0] != sa.ID {
		t.Fatalf("result rows %v", rows)
	}
	if st := e.view(id).Status; st != model.StatusThinking || !e.meta(id).TurnActive {
		t.Fatalf("status %q, turnActive %v", st, e.meta(id).TurnActive)
	}
	// Clients see the turn end and then the new turn.
	var states []any
	for _, ev := range ofType(evs.drain(t, e.br), "chat") {
		states = append(states, ev["chat"].(map[string]any)["status"])
	}
	if n := len(states); n < 2 || states[n-2] != "ready" || states[n-1] != "thinking" {
		t.Fatalf("chat statuses sent %v", states)
	}
	// The turn the app started took the lock that ended the human's: a message gets ErrBusy.
	if err := e.m.Send(id, "wait", "", nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("Send during the delivery's turn: %v", err)
	}

	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if len(parent.sent()) != 2 || e.m.Busy(id) {
		t.Fatalf("%d sends after the delivery's turn", len(parent.sent()))
	}
}

// The agent's own permission request answered mid-turn: its turn goes on, and a result owed by then
// waits for that turn's end.
func TestOwnPermissionAnsweredKeepsResultPending(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.startSpawnParent() // mid-turn
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)
	parent.emit(t, agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Bash"})
	ask(t, parent, "", "r1")
	e.finish(child, "report")
	if err := e.m.Decide(id, "", "r1", true); err != nil {
		t.Fatal(err)
	}
	e.m.handoffs.Wait()
	if st := e.status(id); st != model.StatusTool {
		t.Fatalf("status after the answer %q", st)
	}
	if len(parent.sent()) != 1 || e.subFile(id, sa.ID).Delivery != model.SubOwed {
		t.Fatalf("a result was sent mid-turn: %d sends", len(parent.sent()))
	}
	parent.emit(t, agent.Event{Kind: agent.EvToolResult, ToolID: "t1", Result: "ok"})
	if len(parent.sent()) != 1 {
		t.Fatal("a result was sent mid-turn")
	}
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{sa.ID}) {
		t.Fatalf("%d sends, the last delivers %v", len(parent.sent()), deliveredSids(parent.sent()[len(parent.sent())-1]))
	}
}

// The chat leaves approval because the subagent that asked was stopped with stop_subagent, or (a
// native one) ended: the results owed by then are delivered.
func TestAskerGoneDeliversOwedResults(t *testing.T) {
	t.Parallel()
	t.Run("stop_subagent", func(t *testing.T) {
		e := newEnv(t)
		id, parent := e.idleParent()
		sa := e.spawn(id, SpawnSubRequest{Prompt: "asks"})
		child := waitChild(t, e.claude, 2)
		sb := e.spawn(id, SpawnSubRequest{Prompt: "finishes"})
		other := waitChild(t, e.claude, 3)
		ask(t, child, "", "p1")
		e.finish(other, "report")
		if len(parent.sent()) != 1 || e.status(id) != model.StatusApproval {
			t.Fatalf("%d sends, status %q with a request open", len(parent.sent()), e.status(id))
		}
		if err := e.m.StopSubagent(id, sa.ID); err != nil {
			t.Fatal(err)
		}
		e.m.handoffs.Wait()
		if len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{sb.ID}) {
			t.Fatalf("%d sends, want one delivery of %s", len(parent.sent()), sb.ID)
		}
		if s := e.sub(id, sa.ID); s.Status != model.SubStopped || s.Delivery != model.SubNotOwed {
			t.Fatalf("stopped subagent %+v", s)
		}
	})

	t.Run("native subagent ends", func(t *testing.T) {
		e := newEnv(t)
		id, parent := e.subStart()
		subRun(t, parent, "t1")
		sid := e.onlySub(id)
		parent.emit(t, agent.Event{Kind: agent.EvTurnEnd}) // the native subagent runs on in the background
		sb := e.spawn(id, SpawnSubRequest{Prompt: "finishes"})
		other := waitChild(t, e.claude, 2)
		ask(t, parent, "t1", "r1")
		e.finish(other, "report")
		if len(parent.sent()) != 1 || e.status(id) != model.StatusApproval {
			t.Fatalf("%d sends, status %q with a request open", len(parent.sent()), e.status(id))
		}
		parent.emit(t, agent.Event{Kind: agent.EvSub, Sub: "t1", SubInfo: &agent.SubInfo{Status: model.SubCompleted}})
		e.m.handoffs.Wait()
		if c := e.card(id, sid, "r1"); c.Decided != "deny" {
			t.Fatalf("card after the subagent ended %+v", c)
		}
		if len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{sb.ID}) {
			t.Fatalf("%d sends, want one delivery of %s", len(parent.sent()), sb.ID)
		}
	})
}

// A request raised late by a native subagent that had already finished is not closed by its turn's
// end. It is closed when the process exits, also when the chat is idle then, so it cannot keep the
// chat in approval after a later subagent's request is answered.
func TestIdleExitClosesLatePermission(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.subStart()
	subRun(t, parent, "t1")
	sid := e.onlySub(id)
	parent.emit(t, agent.Event{Kind: agent.EvSub, Sub: "t1", SubInfo: &agent.SubInfo{Status: model.SubCompleted}})
	ask(t, parent, "t1", "r9")
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	if c := e.card(id, sid, "r9"); c.Decided != "" || e.status(id) != model.StatusReady {
		t.Fatalf("after the turn: card %+v, status %q", c, e.status(id))
	}

	parent.exit(t)
	if c := e.card(id, sid, "r9"); c.Decided != "deny" {
		t.Fatalf("card after the idle exit %+v", c)
	}
	if st := e.status(id); st != model.StatusReady {
		t.Fatalf("status after the idle exit %q", st)
	}
	if n := notes(e.items(id), "error"); len(n) != 0 {
		t.Fatalf("an idle exit left a note: %q", n)
	}
	if got := diskItems(t, e.m.itemsPath(id)); len(perms(got)) != 1 || perms(got)[0].Decided != "deny" {
		t.Fatalf("the closed card was not written: %+v", perms(got))
	}

	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)
	ask(t, child, "", "p1")
	if st := e.status(id); st != model.StatusApproval {
		t.Fatalf("status %q with the child's request open", st)
	}
	if err := e.m.Decide(id, sa.ID, "p1", true); err != nil {
		t.Fatal(err)
	}
	if st := e.status(id); st != model.StatusReady {
		t.Fatalf("status after the answer %q", st)
	}
	if err := e.m.Decide(id, sid, "r9", true); !errors.Is(err, ErrNoRequest) {
		t.Fatalf("answer to the card closed at the exit: %v", err)
	}
	if d, s := agentDecides(parent), agentStrays(parent); len(d) != 0 || len(s) != 0 {
		t.Fatalf("the exited agent was sent an answer: %+v %+v", d, s)
	}
	if err := e.m.Send(id, "next", "", nil); err != nil {
		t.Fatalf("Send: %v", err)
	}
}
