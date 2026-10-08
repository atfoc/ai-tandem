package chats

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// Subagent results and copies of a thread: what a new branch or a fork owes its agent.

// spawnLinked creates a Claude chat in its first turn whose agent has spawned one app subagent
// through the spawn_subagent tool call t1, which has returned its receipt: the subagent is linked
// from the thread, so a copy of the thread takes its folder along.
func (e *env) spawnLinked() (id string, parent *fakeAgent, sa model.Subagent, child *fakeAgent) {
	e.t.Helper()
	id, parent = e.startSpawnParent()
	emitSpawnItem(e.t, parent, "t1", "mcp__board__spawn_subagent", `{"prompt":"go"}`)
	sa = e.spawn(id, SpawnSubRequest{Prompt: "go"})
	if sa.Tool != "t1" {
		e.t.Fatalf("not linked: %+v", sa)
	}
	child = waitChild(e.t, e.claude, 2)
	parent.emit(e.t, agent.Event{Kind: agent.EvToolResult, ToolID: "t1", Result: "receipt"})
	return id, parent, sa, child
}

// deliveredLinked is spawnLinked whose subagent finished while the chat was idle: the app started
// a turn that handed its result over, and the agent answered. It returns the point right before
// that turn.
func (e *env) deliveredLinked() (id string, parent *fakeAgent, sa model.Subagent, at int) {
	e.t.Helper()
	id, parent, sa, child := e.spawnLinked()
	parent.emit(e.t, agent.Event{Kind: agent.EvText, Text: "spawned"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
	e.finish(child, "the report")
	parent.emit(e.t, agent.Event{Kind: agent.EvText, Text: "thanks"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p2"})
	e.m.handoffs.Wait()
	e.delivery("delivered", id, sa.ID, model.SubSent)
	items := e.items(id)
	want := []string{"user", "tool", "text", "end", "subresult", "text", "end"}
	if !reflect.DeepEqual(kinds(items), want) {
		e.t.Fatalf("source thread %v, want %v", kinds(items), want)
	}
	return id, parent, sa, turnEnd(items, itemAt(items, "text", "spawned"))
}

// itemAt is the index of the first item of kind with text; -1 = none.
func itemAt(items []model.Item, kind, text string) int {
	for i, it := range items {
		if it.Kind == kind && it.Text == text {
			return i
		}
	}
	return -1
}

// carriedAhead fails unless msg, the first message a copy's agent got, is the results of sids in
// one block ahead of the human's text.
func carriedAhead(t *testing.T, msg []agent.ContentBlock, text string, sids ...string) {
	t.Helper()
	got := texts(msg)
	if len(got) != 2 || len(got[0]) < len(humanBlock) || got[0][:len(humanBlock)] != humanBlock || got[1] != text {
		t.Fatalf("the copy's first message is %q, want the results block ahead of %q", got, text)
	}
	if carried := deliveredSids(msg); !reflect.DeepEqual(carried, sids) {
		t.Fatalf("the copy's first message carries %v, want %v", carried, sids)
	}
}

// The human's message carried a result, and the user edits that message: the new branch is cut
// before the result's row, in a session forked from before the message. The branch's agent has not
// had the result, so the edited message carries it.
func TestEditOfCarryingMessageOwesResult(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent, sa, child := e.spawnLinked()
	e.finish(child, "the report") // owed: the parent is busy
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "spawned"},
		agent.Event{Kind: agent.EvTurnEnd, Error: "rate limited", Point: "p1"})
	e.m.handoffs.Wait()
	e.delivery("held", id, sa.ID, model.SubOwed)
	e.send(id, "go on", "")
	if got := deliveredSids(parent.sent()[1]); !reflect.DeepEqual(got, []string{sa.ID}) {
		t.Fatalf("the human's message carries %v", got)
	}
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p2"})
	e.m.handoffs.Wait()

	items := e.items(id)
	want := []string{"user", "tool", "text", "note", "end", "subresult", "user", "text", "end"}
	if !reflect.DeepEqual(kinds(items), want) {
		t.Fatalf("source thread %v, want %v", kinds(items), want)
	}
	at, ok := cutBefore(items, itemAt(items, "user", "go on"))
	if !ok || at != 5 {
		t.Fatalf("cut point %d %v", at, ok)
	}
	_, bid, a := e.branchTo(id, mainAt(at), "go on, edited")

	if len(a.sent()) != 1 {
		t.Fatalf("the branch's agent got %d messages", len(a.sent()))
	}
	carriedAhead(t, a.sent()[0], "go on, edited", sa.ID)
	if got := kinds(e.items(id)); !reflect.DeepEqual(got, append(want[:at:at], "subresult", "user")) {
		t.Fatalf("branch thread %v", got)
	}
	if s, f := e.sub(id, sa.ID), e.subFile(bid, sa.ID); s.Delivery != model.SubSent || f.Delivery != model.SubSent {
		t.Fatalf("branch record %+v, subagent.json %+v", s, f)
	}
	if v := e.view(id); v.SubsOwed != 0 {
		t.Fatalf("view %+v", v)
	}
	// The branch left is as it was.
	if f := e.subFile(id, sa.ID); f.Delivery != model.SubSent || len(parent.sent()) != 2 {
		t.Fatalf("main: subagent.json %+v, %d sends", f, len(parent.sent()))
	}
	if _, _, mitems, _, err := e.m.ItemsOf(id, model.MainBranch); err != nil || !reflect.DeepEqual(kinds(mitems), want) {
		t.Fatalf("main thread %v %v", kinds(mitems), err)
	}
}

// A branch that starts before a turn the app started to deliver a result keeps the spawn, not the
// delivery: its first message carries the result.
func TestBranchBeforeDeliveryTurnOwesResult(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent, sa, at := e.deliveredLinked()
	sends := len(parent.sent())
	_, bid, a := e.branchTo(id, mainAt(at), "what did the subagent say?")

	if len(a.sent()) != 1 {
		t.Fatalf("the branch's agent got %d messages", len(a.sent()))
	}
	carriedAhead(t, a.sent()[0], "what did the subagent say?", sa.ID)
	if got, want := kinds(e.items(id)), []string{"user", "tool", "text", "end", "subresult", "user"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("branch thread %v, want %v", got, want)
	}
	if s, f := e.sub(id, sa.ID), e.subFile(bid, sa.ID); s.Delivery != model.SubSent || f.Delivery != model.SubSent {
		t.Fatalf("branch record %+v, subagent.json %+v", s, f)
	}
	if v := e.view(id); v.SubsOwed != 0 {
		t.Fatalf("view %+v", v)
	}
	if f := e.subFile(id, sa.ID); f.Delivery != model.SubSent || len(parent.sent()) != sends {
		t.Fatalf("main: subagent.json %+v, %d sends", f, len(parent.sent()))
	}

	// The message released the hold the branch started with: a result that comes once its turn
	// has ended is handed over at once, alone.
	a.emit(t, agent.Event{Kind: agent.EvText, Text: "it said"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p3"})
	e.m.handoffs.Wait()
	if len(a.sent()) != 1 {
		t.Fatalf("%d sends after the branch's turn", len(a.sent()))
	}
	n := e.claude.count()
	next := e.spawn(bid, SpawnSubRequest{Prompt: "more"})
	e.finish(waitChild(t, e.claude, n+1), "another report")
	if len(a.sent()) != 2 || !reflect.DeepEqual(deliveredSids(a.sent()[1]), []string{next.ID}) {
		t.Fatalf("%d sends, the last delivers %v, want %s", len(a.sent()), deliveredSids(a.sent()[len(a.sent())-1]), next.ID)
	}
}

// The same through a fork to a new chat: the fork shows the result as owed from the start, starts
// no turn for it, and its first human message carries it.
func TestForkBeforeDeliveryTurnOwesResult(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent, sa, at := e.deliveredLinked()
	sends := len(parent.sent())
	before := folder(t, e.st.P.ChatDir(id), false)
	evs := e.listen()
	f := e.fork(id, at)
	a := e.claude.lastFork(t)

	if f.SubsOwed != 1 || e.view(f.ID).SubsOwed != 1 {
		t.Fatalf("the fork's view owes %d (returned %d), want 1", e.view(f.ID).SubsOwed, f.SubsOwed)
	}
	if vs := chatViews(t, evs.drain(t, e.br), f.ID); len(vs) != 1 || vs[0].SubsOwed != 1 {
		t.Fatalf("chat events of the fork %+v", vs)
	}
	if s, file := e.sub(f.ID, sa.ID), e.subFile(f.ID, sa.ID); s.Delivery != model.SubOwed || file.Delivery != model.SubOwed ||
		s.Status != model.SubCompleted || s.Last != "the report" {
		t.Fatalf("fork record %+v, subagent.json %+v", s, file)
	}
	e.held("forked", f.ID, a, 0)

	e.send(f.ID, "what did the subagent say?", "")
	carriedAhead(t, a.sent()[0], "what did the subagent say?", sa.ID)
	if got, want := kinds(e.items(f.ID)), []string{"user", "tool", "text", "end", "subresult", "user"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("fork thread %v, want %v", got, want)
	}
	e.delivery("sent with the message", f.ID, sa.ID, model.SubSent)
	if v := e.view(f.ID); v.SubsOwed != 0 {
		t.Fatalf("view %+v", v)
	}
	a.emit(t, agent.Event{Kind: agent.EvText, Text: "it said"}, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if len(a.sent()) != 1 || rowsOf(e.items(f.ID), sa.ID) != 1 {
		t.Fatalf("%d sends, rows %v", len(a.sent()), resultRows(e.items(f.ID)))
	}
	// The source is as it was.
	if after := folder(t, e.st.P.ChatDir(id), false); !reflect.DeepEqual(after, before) {
		t.Fatalf("the source changed:\n%v\nwas\n%v", after, before)
	}
	if s := e.sub(id, sa.ID); s.Delivery != model.SubSent || len(parent.sent()) != sends || e.view(id).SubsOwed != 0 {
		t.Fatalf("source: subagent %+v, %d sends, view %+v", s, len(parent.sent()), e.view(id))
	}
}

// retriedSource is a chat whose subagent result was handed over twice. The first attempt left the
// result's row and did not reach the agent, as how says: "refused" by the adapter, "errored" with
// no model output, or "stopped" by the human before any output. A later turn delivered it, with no
// row of its own: the app's retry after the human's next turn, or for "stopped" the human's next
// message. It returns the point right before that turn.
func (e *env) retriedSource(how string) (id string, parent *fakeAgent, sa model.Subagent, at int) {
	e.t.Helper()
	t := e.t
	id, parent, sa, child := e.spawnLinked()
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "spawned"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
	var want []string
	switch how {
	case "refused": // the adapter did not take the message: it never reached the agent
		parent.failSends(errors.New("stdin closed"))
		e.finish(child, "the report")
		parent.failSends(nil)
		want = []string{"user", "tool", "text", "end", "subresult", "note", "user", "text", "end", "text", "end"}
	case "errored": // the turn ended with an error and no model output
		e.finish(child, "the report")
		parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "overloaded", Point: "p1b"})
		e.m.handoffs.Wait()
		want = []string{"user", "tool", "text", "end", "subresult", "note", "end", "user", "text", "end", "text", "end"}
	case "stopped": // the human pressed Stop before the model said anything
		e.finish(child, "the report")
		if err := e.m.Interrupt(id); err != nil {
			t.Fatal(err)
		}
		parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true, Point: "p1b"})
		e.m.handoffs.Wait()
		e.delivery("after the stopped attempt", id, sa.ID, model.SubOwed)
		// The human's next message carries it again, with no new row.
		e.send(id, "go on", "")
		if got := deliveredSids(parent.sent()[len(parent.sent())-1]); !reflect.DeepEqual(got, []string{sa.ID}) {
			t.Fatalf("the human's message carries %v", got)
		}
		parent.emit(t, agent.Event{Kind: agent.EvText, Text: "thanks"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p2"})
		e.m.handoffs.Wait()
		e.delivery("after the human's message", id, sa.ID, model.SubSent)
		items := e.items(id)
		want = []string{"user", "tool", "text", "end", "subresult", "note", "end", "user", "text", "end"}
		if !reflect.DeepEqual(kinds(items), want) {
			t.Fatalf("source thread %v, want %v", kinds(items), want)
		}
		at, ok := cutBefore(items, itemAt(items, "user", "go on"))
		if !ok {
			t.Fatal("no cut point")
		}
		return id, parent, sa, at
	}
	e.delivery("after the first attempt", id, sa.ID, model.SubOwedAgain)
	n := len(parent.sent())
	e.send(id, "go on", "")
	if got := deliveredSids(parent.sent()[n]); len(got) != 0 {
		t.Fatalf("the human's message carries %v", got)
	}
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p2"})
	e.m.handoffs.Wait()
	if got := deliveredSids(parent.sent()[n+1]); !reflect.DeepEqual(got, []string{sa.ID}) {
		t.Fatalf("the app's retry carries %v", got)
	}
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "thanks"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p3"})
	e.m.handoffs.Wait()
	e.delivery("after the retry", id, sa.ID, model.SubSent)
	items := e.items(id)
	if !reflect.DeepEqual(kinds(items), want) {
		t.Fatalf("source thread %v, want %v", kinds(items), want)
	}
	return id, parent, sa, turnEnd(items, itemAt(items, "text", "ok"))
}

// A fork or a branch made right before the turn that finally delivered a result, after a first
// attempt that did not reach the agent: the copied thread has the result's row, from that first
// attempt, and the copied record says "sent", but the copy's session is forked from before the
// delivery. The copy's agent is owed the result and gets it with the copy's first message, with no
// second row.
func TestCopyBeforeRetriedDeliveryOwesResult(t *testing.T) {
	t.Parallel()
	for _, how := range []string{"refused", "errored", "stopped"} {
		t.Run("fork/"+how, func(t *testing.T) {
			e := newEnv(t)
			id, parent, sa, at := e.retriedSource(how)
			sends := len(parent.sent())
			f := e.fork(id, at)
			a := e.claude.lastFork(t)
			if rowsOf(e.items(f.ID), sa.ID) != 1 {
				t.Fatalf("fixture: the fork at %d has the rows %v", at, resultRows(e.items(f.ID)))
			}
			if s, file := e.sub(f.ID, sa.ID), e.subFile(f.ID, sa.ID); s.Delivery != model.SubOwed || file.Delivery != model.SubOwed {
				t.Errorf("fork record: delivery %q, subagent.json %q, want %q", s.Delivery, file.Delivery, model.SubOwed)
			}
			if f.SubsOwed != 1 || e.view(f.ID).SubsOwed != 1 {
				t.Errorf("the fork's view owes %d (returned %d), want 1", e.view(f.ID).SubsOwed, f.SubsOwed)
			}
			e.send(f.ID, "what did the subagent say?", "")
			if got := deliveredSids(a.sent()[0]); !reflect.DeepEqual(got, []string{sa.ID}) {
				t.Fatalf("the fork's agent never got the result: its first message carries %v, want %s; record %q",
					got, sa.ID, e.sub(f.ID, sa.ID).Delivery)
			}
			carriedAhead(t, a.sent()[0], "what did the subagent say?", sa.ID)
			a.emit(t, agent.Event{Kind: agent.EvText, Text: "it said"}, agent.Event{Kind: agent.EvTurnEnd, Point: "f1"})
			e.m.handoffs.Wait()
			e.delivery("sent with the fork's message", f.ID, sa.ID, model.SubSent)
			if len(a.sent()) != 1 || rowsOf(e.items(f.ID), sa.ID) != 1 || e.view(f.ID).SubsOwed != 0 {
				t.Fatalf("%d sends, rows %v, view %+v", len(a.sent()), resultRows(e.items(f.ID)), e.view(f.ID))
			}
			// The source is as it was.
			if s := e.sub(id, sa.ID); s.Delivery != model.SubSent || len(parent.sent()) != sends || e.view(id).SubsOwed != 0 {
				t.Fatalf("source: subagent %+v, %d sends, view %+v", s, len(parent.sent()), e.view(id))
			}
		})
		t.Run("branch/"+how, func(t *testing.T) {
			e := newEnv(t)
			id, parent, sa, at := e.retriedSource(how)
			sends := len(parent.sent())
			_, bid, a := e.branchTo(id, mainAt(at), "what did the subagent say?")
			if got := deliveredSids(a.sent()[0]); !reflect.DeepEqual(got, []string{sa.ID}) {
				t.Fatalf("the branch's agent never got the result: its first message carries %v, want %s; record %q",
					got, sa.ID, e.subFile(bid, sa.ID).Delivery)
			}
			carriedAhead(t, a.sent()[0], "what did the subagent say?", sa.ID)
			a.emit(t, agent.Event{Kind: agent.EvText, Text: "it said"}, agent.Event{Kind: agent.EvTurnEnd, Point: "f1"})
			e.m.handoffs.Wait()
			if s, file := e.sub(id, sa.ID), e.subFile(bid, sa.ID); s.Delivery != model.SubSent || file.Delivery != model.SubSent {
				t.Fatalf("branch record %+v, subagent.json %+v", s, file)
			}
			if len(a.sent()) != 1 || rowsOf(e.items(id), sa.ID) != 1 || e.view(id).SubsOwed != 0 {
				t.Fatalf("%d sends, rows %v, view %+v", len(a.sent()), resultRows(e.items(id)), e.view(id))
			}
			// The branch left is as it was.
			if file := e.subFile(id, sa.ID); file.Delivery != model.SubSent || len(parent.sent()) != sends {
				t.Fatalf("main: subagent.json %+v, %d sends", file, len(parent.sent()))
			}
		})
	}
}

// A record keeps the thread's item count as it was when its result was last taken for a turn,
// before what the turn added: the index of the result's row at the first attempt, and at a later
// one the count right before the turn that carried it again.
func TestCarriedIsTheCountBeforeTheTurn(t *testing.T) {
	t.Parallel()
	carried := func(e *env, id, sid string, want int) {
		e.t.Helper()
		if s, file := e.sub(id, sid), e.subFile(id, sid); s.Carried != want || file.Carried != want {
			e.t.Fatalf("carried %d, subagent.json %d, want %d; thread %v", s.Carried, file.Carried, want, kinds(e.items(id)))
		}
	}
	t.Run("the first attempt", func(t *testing.T) {
		e := newEnv(t)
		id, _, sa, at := e.deliveredLinked()
		if row := e.items(id)[at]; row.Kind != "subresult" || row.Subagent != sa.ID {
			t.Fatalf("item %d is %+v", at, row)
		}
		carried(e, id, sa.ID, at)
	})
	for _, how := range []string{"refused", "errored", "stopped"} {
		t.Run("a later attempt, the first "+how, func(t *testing.T) {
			e := newEnv(t)
			id, _, sa, at := e.retriedSource(how)
			carried(e, id, sa.ID, at)
		})
	}
}

// A fork or a branch made after the turn that delivered a result owes nothing: its session has the
// result. So it is for a result delivered at the first attempt, by a turn of the app's or with the
// human's message, and for one delivered at a later attempt.
func TestCopyAfterDeliveryOwesNothing(t *testing.T) {
	t.Parallel()
	sources := map[string]func(e *env) (string, model.Subagent){
		"a delivery turn": func(e *env) (string, model.Subagent) {
			id, _, sa, _ := e.deliveredLinked()
			return id, sa
		},
		"the human's message": func(e *env) (string, model.Subagent) {
			id, parent, sa, child := e.spawnLinked()
			e.finish(child, "the report") // owed: the parent is busy
			parent.emit(e.t, agent.Event{Kind: agent.EvText, Text: "spawned"},
				agent.Event{Kind: agent.EvTurnEnd, Error: "rate limited", Point: "p1"})
			e.m.handoffs.Wait()
			e.send(id, "go on", "")
			if got := deliveredSids(parent.sent()[1]); !reflect.DeepEqual(got, []string{sa.ID}) {
				e.t.Fatalf("the human's message carries %v", got)
			}
			parent.emit(e.t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p2"})
			e.m.handoffs.Wait()
			return id, sa
		},
	}
	for _, how := range []string{"refused", "errored", "stopped"} {
		sources["a later attempt, the first "+how] = func(e *env) (string, model.Subagent) {
			id, _, sa, _ := e.retriedSource(how)
			return id, sa
		}
	}
	for name, source := range sources {
		t.Run("fork/"+name, func(t *testing.T) {
			e := newEnv(t)
			id, sa := source(e)
			e.delivery("delivered", id, sa.ID, model.SubSent)
			f := e.fork(id, len(e.items(id)))
			a := e.claude.lastFork(t)
			e.delivery("forked", f.ID, sa.ID, model.SubSent)
			if rowsOf(e.items(f.ID), sa.ID) != 1 || f.SubsOwed != 0 || e.view(f.ID).SubsOwed != 0 {
				t.Fatalf("fork: rows %v, the view owes %d (returned %d)", resultRows(e.items(f.ID)), e.view(f.ID).SubsOwed, f.SubsOwed)
			}
			e.send(f.ID, "hello fork", "")
			a.emit(t, agent.Event{Kind: agent.EvText, Text: "hello"}, agent.Event{Kind: agent.EvTurnEnd, Point: "f1"})
			e.m.handoffs.Wait()
			if len(a.sent()) != 1 || carriedTimes(a.sent(), sa.ID) != 0 || rowsOf(e.items(f.ID), sa.ID) != 1 {
				t.Fatalf("the fork's agent got the result again: %d sends, carried %d times, rows %v",
					len(a.sent()), carriedTimes(a.sent(), sa.ID), resultRows(e.items(f.ID)))
			}
		})
		t.Run("branch/"+name, func(t *testing.T) {
			e := newEnv(t)
			id, sa := source(e)
			e.delivery("delivered", id, sa.ID, model.SubSent)
			_, bid, a := e.branchTo(id, newAt(len(e.items(id))), "hello branch")
			a.emit(t, agent.Event{Kind: agent.EvText, Text: "hello"}, agent.Event{Kind: agent.EvTurnEnd, Point: "f1"})
			e.m.handoffs.Wait()
			if len(a.sent()) != 1 || carriedTimes(a.sent(), sa.ID) != 0 || rowsOf(e.items(id), sa.ID) != 1 {
				t.Fatalf("the branch's agent got the result again: %d sends, carried %d times, rows %v",
					len(a.sent()), carriedTimes(a.sent(), sa.ID), resultRows(e.items(id)))
			}
			if file := e.subFile(bid, sa.ID); file.Delivery != model.SubSent {
				t.Fatalf("branch subagent.json %+v", file)
			}
		})
	}
}

// Only the chat's own agent is owed a result. A subagent's own native subagent is copied with it
// and stays as it was.
func TestForkOwesOnlyTheChatsOwnResult(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent, sa, child := e.spawnLinked()
	child.emit(t, agent.Event{Kind: agent.EvToolStart, ToolID: "n1", ToolName: "Agent"},
		agent.Event{Kind: agent.EvSub, Sub: "n1", SubInfo: &agent.SubInfo{Status: model.SubCompleted, Description: "nested task"}})
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "spawned"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
	e.finish(child, "the report")
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "thanks"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p2"})
	e.m.handoffs.Wait()
	items := e.items(id)

	f := e.fork(id, turnEnd(items, itemAt(items, "text", "spawned")))
	subs := e.subs(f.ID)
	if len(subs) != 2 {
		t.Fatalf("fork subagents %+v", subs)
	}
	for _, s := range subs {
		want := model.SubNotOwed
		if s.ID == sa.ID {
			want = model.SubOwed
		} else if s.Parent != sa.ID || s.Status != model.SubCompleted {
			t.Fatalf("nested subagent %+v", s)
		}
		if s.Delivery != want || e.subFile(f.ID, s.ID).Delivery != want {
			t.Fatalf("fork subagent %+v, subagent.json %+v, want delivery %q", s, e.subFile(f.ID, s.ID), want)
		}
	}
	if v := e.view(f.ID); v.SubsOwed != 1 || v.SubsRunning != 0 {
		t.Fatalf("view %+v", v)
	}
	e.send(f.ID, "hello fork", "")
	carriedAhead(t, e.claude.lastFork(t).sent()[0], "hello fork", sa.ID)
}

// storeSub writes a subagent's record as the app does.
func (e *env) storeSub(id string, sa model.Subagent) {
	e.t.Helper()
	raw, err := json.Marshal(sa)
	if err != nil {
		e.t.Fatal(err)
	}
	if err := os.MkdirAll(e.subDir(id, sa.ID), 0o700); err != nil {
		e.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.subDir(id, sa.ID), "subagent.json"), raw, 0o600); err != nil {
		e.t.Fatal(err)
	}
}

// Every delivery state in a copy, with and without the result's row in the copied thread. A
// result that was handed over, is to be retried or was given up is owed in a copy that lacks its
// row: that thread never carried it. With its row the record is copied as it is. A record that
// owes nothing (a stopped subagent, a native one, a subagent's own) never becomes owed.
func TestCopyDeliveryStates(t *testing.T) {
	t.Parallel()
	res := "receipt"
	tool := func(n, sid string) model.Item {
		return model.Item{Kind: "tool", ToolID: n, Name: "mcp__board__spawn_subagent", Result: &res, Subagent: sid}
	}
	const sent, retry, givenUp, owed, owedRow, stopped, native, nested = "aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc",
		"dddddddddddd", "eeeeeeeeeeee", "ffffffffffff", "111111111111", "222222222222"
	items := []model.Item{
		{Kind: "user", Text: "delegate"},
		tool("t1", sent), tool("t2", retry), tool("t3", givenUp), tool("t4", owed), tool("t5", owedRow), tool("t6", stopped),
		{Kind: "tool", ToolID: "t7", Name: "Agent", Result: &res, Subagent: native},
		{Kind: "text", Text: "spawned", Done: true}, {Kind: "end", Point: "p1"},
		{Kind: "subresult", Subagent: sent}, {Kind: "subresult", Subagent: retry},
		{Kind: "subresult", Subagent: givenUp}, {Kind: "subresult", Subagent: owedRow},
		{Kind: "text", Text: "thanks", Done: true}, {Kind: "end", Point: "p2"},
	}
	records := []model.Subagent{
		{ID: sent, Tool: "t1", Kind: model.Claude, Status: model.SubCompleted, Ended: 10, Last: "r1", Delivery: model.SubSent},
		{ID: retry, Tool: "t2", Kind: model.Claude, Status: model.SubCompleted, Ended: 20, Last: "r2", Delivery: model.SubOwedAgain},
		{ID: givenUp, Tool: "t3", Kind: model.Claude, Status: model.SubFailed, Ended: 30, Error: "boom", Delivery: model.SubGivenUp},
		{ID: owed, Tool: "t4", Kind: model.Claude, Status: model.SubCompleted, Ended: 40, Last: "r4", Delivery: model.SubOwed},
		// Owed with its row: the human stopped the turn that carried it.
		{ID: owedRow, Tool: "t5", Kind: model.Claude, Status: model.SubCompleted, Ended: 50, Last: "r5", Delivery: model.SubOwed},
		{ID: stopped, Tool: "t6", Kind: model.Claude, Status: model.SubStopped, Ended: 60},
		{ID: native, Tool: "t7", Status: model.SubCompleted, Ended: 70},
		{ID: nested, Tool: "n1", Parent: native, Status: model.SubCompleted, Ended: 80},
	}
	for _, tc := range []struct {
		name  string
		at    int
		want  map[string]model.SubDelivery
		first []string // what the copy's first human message carries, in order
		later []string // what the app hands over once that message's turn has ended
	}{
		{"without the rows", 10, map[string]model.SubDelivery{sent: model.SubOwed, retry: model.SubOwed, givenUp: model.SubOwed,
			owed: model.SubOwed, owedRow: model.SubOwed, stopped: "", native: "", nested: ""},
			[]string{sent, retry, givenUp, owed, owedRow}, nil},
		{"with the rows", len(items), map[string]model.SubDelivery{sent: model.SubSent, retry: model.SubOwedAgain, givenUp: model.SubGivenUp,
			owed: model.SubOwed, owedRow: model.SubOwed, stopped: "", native: "", nested: ""},
			[]string{owed, owedRow}, []string{retry}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			v := e.create(model.Claude, gOne, "")
			e.writeItems(v.ID, items)
			for _, sa := range records {
				e.storeSub(v.ID, sa)
			}
			e.boot()
			id := v.ID
			before := folder(t, e.st.P.ChatDir(id), false)

			f := e.fork(id, tc.at)
			a := e.claude.lastFork(t)
			subs := e.subs(f.ID)
			if len(subs) != len(records) {
				t.Fatalf("fork subagents %+v", subs)
			}
			n := 0
			for _, s := range subs {
				want, ok := tc.want[s.ID]
				if file := e.subFile(f.ID, s.ID); !ok || s.Delivery != want || file.Delivery != want {
					t.Errorf("fork subagent %s: delivery %q, subagent.json %q, want %q", s.ID, s.Delivery, file.Delivery, want)
				}
				if want.Owed() {
					n++
				}
			}
			if f.SubsOwed != n || e.view(f.ID).SubsOwed != n {
				t.Errorf("the fork's view owes %d (returned %d), want %d", e.view(f.ID).SubsOwed, f.SubsOwed, n)
			}
			if after := folder(t, e.st.P.ChatDir(id), false); !reflect.DeepEqual(after, before) {
				t.Fatalf("the source changed:\n%v\nwas\n%v", after, before)
			}

			// A turn end of the fork's process before the human has written starts nothing.
			a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
			e.m.handoffs.Wait()
			if len(a.sent()) != 0 || e.m.Busy(f.ID) {
				t.Fatalf("the fork's agent got %d messages with no human message", len(a.sent()))
			}
			e.send(f.ID, "hello fork", "")
			carriedAhead(t, a.sent()[0], "hello fork", tc.first...)
			a.emit(t, agent.Event{Kind: agent.EvText, Text: "hello"}, agent.Event{Kind: agent.EvTurnEnd})
			e.m.handoffs.Wait()
			sends := 1
			if tc.later != nil {
				sends = 2
				if got := deliveredSids(a.sent()[len(a.sent())-1]); !reflect.DeepEqual(got, tc.later) {
					t.Fatalf("after the turn the app hands over %v, want %v", got, tc.later)
				}
				a.emit(t, agent.Event{Kind: agent.EvText, Text: "noted"}, agent.Event{Kind: agent.EvTurnEnd})
				e.m.handoffs.Wait()
			}
			if len(a.sent()) != sends {
				t.Fatalf("%d sends, want %d", len(a.sent()), sends)
			}
			fitems := e.items(f.ID)
			for _, sid := range append(append([]string{}, tc.first...), tc.later...) {
				if s := e.subFile(f.ID, sid); s.Delivery != model.SubSent || rowsOf(fitems, sid) != 1 {
					t.Errorf("%s: subagent.json %+v, %d rows", sid, s, rowsOf(fitems, sid))
				}
			}
			for _, sid := range []string{stopped, native, nested} {
				if s := e.subFile(f.ID, sid); s.Delivery != model.SubNotOwed || carriedTimes(a.sent(), sid) != 0 {
					t.Errorf("%s: subagent.json %+v, carried %d times", sid, s, carriedTimes(a.sent(), sid))
				}
			}
			if v := e.view(f.ID); v.SubsOwed != 0 {
				t.Errorf("view %+v", v)
			}
			if after := folder(t, e.st.P.ChatDir(id), false); !reflect.DeepEqual(after, before) {
				t.Fatalf("the source changed:\n%v\nwas\n%v", after, before)
			}
		})
	}
}

// A fork of a held chat that is owed a result inherits the debt: the result goes to the fork's
// agent with the fork's first message, and to the source's agent with the source's next message.
func TestForkInheritsOwedResult(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent, sa, child := e.spawnLinked()
	e.finish(child, "the report")
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "spawned"},
		agent.Event{Kind: agent.EvTurnEnd, Error: "rate limited", Point: "p1"})
	e.m.handoffs.Wait()
	e.delivery("held", id, sa.ID, model.SubOwed)

	f := e.fork(id, len(e.items(id)))
	a := e.claude.lastFork(t)
	e.delivery("forked", f.ID, sa.ID, model.SubOwed)
	if v := e.view(f.ID); v.SubsOwed != 1 || v.SubsRunning != 0 {
		t.Fatalf("fork view %+v", v)
	}
	e.send(f.ID, "hello fork", "")
	carriedAhead(t, a.sent()[0], "hello fork", sa.ID)
	e.delivery("the fork's message", f.ID, sa.ID, model.SubSent)
	e.delivery("the fork's message, in the source", id, sa.ID, model.SubOwed)

	e.send(id, "go on", "")
	carriedAhead(t, parent.sent()[1], "go on", sa.ID)
	e.delivery("the source's message", id, sa.ID, model.SubSent)
	if rowsOf(e.items(f.ID), sa.ID) != 1 || rowsOf(e.items(id), sa.ID) != 1 || len(a.sent()) != 1 {
		t.Fatalf("fork rows %v, source rows %v, %d sends to the fork", resultRows(e.items(f.ID)), resultRows(e.items(id)), len(a.sent()))
	}
}

// The fork that inherited a debt is held like any chat the human has not written in: a turn end
// of its process before any Send starts no turn. The human's first message carries the result.
func TestForkWithOwedResultStartsNoTurn(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent, sa, child := e.spawnLinked()
	e.finish(child, "the report")
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "spawned"},
		agent.Event{Kind: agent.EvTurnEnd, Error: "rate limited", Point: "p1"})
	e.m.handoffs.Wait()

	f := e.fork(id, len(e.items(id)))
	a := e.claude.lastFork(t)
	if !e.holding(f.ID) {
		t.Error("the fork is not held")
	}
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if n := len(a.sent()); n != 0 {
		t.Fatalf("the fork's agent was sent %d message(s) with no human message: carries %v; fork status %q",
			n, deliveredSids(a.sent()[0]), e.status(f.ID))
	}
	e.deliverNow(f.ID)
	e.held("a turn end before any Send", f.ID, a, 0, sa.ID)
	if v := e.view(f.ID); v.SubsOwed != 1 || v.Status != model.StatusReady {
		t.Fatalf("fork view %+v", v)
	}

	e.send(f.ID, "hello fork", "")
	if e.holding(f.ID) {
		t.Fatal("the human's message did not release the hold")
	}
	carriedAhead(t, a.sent()[0], "hello fork", sa.ID)
	e.delivery("the fork's message", f.ID, sa.ID, model.SubSent)
}

// A fork made while a subagent of the source still runs leaves that subagent alone: the copy
// shows it stopped and owes nothing for it, and its result still reaches the source only.
func TestForkWhileSubagentRuns(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent, sa, child := e.spawnLinked()
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "spawned"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
	f := e.fork(id, len(e.items(id)))
	fa := e.claude.lastFork(t)
	if agentClosed(child) || e.sub(id, sa.ID).Status != model.SubRunning || e.view(id).SubsRunning != 1 {
		t.Fatalf("the fork stopped the source's subagent: %+v", e.sub(id, sa.ID))
	}
	if s, file := e.sub(f.ID, sa.ID), e.subFile(f.ID, sa.ID); s.Status != model.SubStopped || s.Delivery != model.SubNotOwed ||
		file.Status != model.SubStopped || file.Delivery != model.SubNotOwed {
		t.Fatalf("fork record %+v, subagent.json %+v", s, file)
	}
	if v := e.view(f.ID); v.SubsRunning != 0 || v.SubsOwed != 0 {
		t.Fatalf("fork view %+v", v)
	}
	e.marked("made", f.ID, sa.ID)
	if e.sub(id, sa.ID).NotCarried || e.subFile(id, sa.ID).NotCarried || !e.meta(f.ID).NoticeOwed {
		t.Fatalf("source record %+v, the fork's notice owed %v", e.sub(id, sa.ID), e.meta(f.ID).NoticeOwed)
	}

	e.finish(child, "the report")
	if got := deliveredSids(parent.sent()[len(parent.sent())-1]); !reflect.DeepEqual(got, []string{sa.ID}) {
		t.Fatalf("the source's agent got %v", got)
	}
	e.delivery("delivered to the source", id, sa.ID, model.SubSent)
	if len(fa.sent()) != 0 {
		t.Fatalf("the fork's agent was sent %q", fa.sent())
	}
	e.send(f.ID, "hello fork", "")
	// The fork's agent is told once that the subagent does not run here; no result comes.
	noticeAhead(t, fa.sent()[0], "hello fork", sa.ID)
	if got := deliveredSids(fa.sent()[0]); len(got) != 0 {
		t.Fatalf("the fork's agent got the results of %v", got)
	}
	if s := e.subFile(f.ID, sa.ID); s.Status != model.SubStopped || s.Delivery != model.SubNotOwed || e.view(f.ID).SubsOwed != 0 {
		t.Fatalf("fork subagent.json %+v, view %+v", s, e.view(f.ID))
	}
	e.marked("after the first message", f.ID, sa.ID)
	if e.meta(f.ID).NoticeOwed || len(resultRows(e.items(f.ID))) != 0 {
		t.Fatalf("notice owed %v, result rows %v", e.meta(f.ID).NoticeOwed, resultRows(e.items(f.ID)))
	}
	if s := e.sub(id, sa.ID); s.Status != model.SubCompleted || s.NotCarried {
		t.Fatalf("the source's record after its result: %+v", s)
	}
}

// A result row whose subagent no tool item of the thread names (a spawn that was never linked to
// its tool call) takes its record along: the copy's row has its subagent, and its state.
func TestForkCopiesRecordOfResultRow(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.startSpawnParent()
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "spawned"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"}) // no spawn tool item: unlinked
	if sa.Tool != "" {
		t.Fatalf("linked: %+v", sa)
	}
	child := waitChild(t, e.claude, 2)
	child.emit(t, agent.Event{Kind: agent.EvToolStart, ToolID: "s1", ToolName: "Read"})
	e.finish(child, "the report")
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "thanks"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p2"})
	e.m.handoffs.Wait()

	f := e.fork(id, len(e.items(id)))
	if rows := resultRows(e.items(f.ID)); !reflect.DeepEqual(rows, []string{sa.ID}) {
		t.Fatalf("fork rows %v", rows)
	}
	subs := e.subs(f.ID)
	if len(subs) != 1 || subs[0].ID != sa.ID || subs[0].Delivery != model.SubSent || subs[0].Last != "the report" {
		t.Fatalf("the fork has the result row of %s and the subagents %+v", sa.ID, subs)
	}
	if got, want := e.subItems(f.ID, sa.ID), e.subItems(id, sa.ID); len(got) == 0 || !reflect.DeepEqual(got, want) {
		t.Fatalf("the fork's copy of the subagent's thread %+v, want %+v", got, want)
	}
	if v := e.view(f.ID); v.SubsOwed != 0 {
		t.Fatalf("fork view %+v", v)
	}
	// A copy that lacks the row has nothing that names the subagent, and takes nothing of it.
	g := e.fork(id, 3)
	if subs := e.subs(g.ID); len(subs) != 0 || len(resultRows(e.items(g.ID))) != 0 {
		t.Fatalf("the fork before the row has rows %v and the subagents %+v", resultRows(e.items(g.ID)), subs)
	}
}

// The order of a batch: completion time first, then sid, for the block and for the rows.
func TestDeliveryBatchOrder(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.startSpawnParent() // mid-turn: everything stays owed
	var subs []model.Subagent
	var kids []*fakeAgent
	for k := 0; k < 4; k++ {
		subs = append(subs, e.spawn(id, SpawnSubRequest{Prompt: "p", Description: string(rune('a' + k))}))
		kids = append(kids, waitChild(t, e.claude, 2+k))
	}
	// 3 ends first; then 0 and 1 in the same millisecond; then 2.
	e.clock.Store(testNow + 10)
	e.finish(kids[3], "r3")
	e.clock.Store(testNow + 20)
	e.finish(kids[1], "r1")
	e.finish(kids[0], "r0")
	e.clock.Store(testNow + 30)
	e.finish(kids[2], "r2")
	tie := []string{subs[0].ID, subs[1].ID}
	sort.Strings(tie)
	want := []string{subs[3].ID, tie[0], tie[1], subs[2].ID}
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "done"}, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if got := deliveredSids(parent.sent()[1]); !reflect.DeepEqual(got, want) {
		t.Fatalf("order %v, want %v", got, want)
	}
	if rows := resultRows(e.items(id)); !reflect.DeepEqual(rows, want) {
		t.Fatalf("rows %v, want %v", rows, want)
	}
}
