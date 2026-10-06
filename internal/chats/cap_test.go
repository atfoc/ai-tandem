package chats

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// The cap on running turns (cap.go): 4 chat objects of one chat and 12 overall may work at once.

// lowerCaps sets the two caps for the test.
func lowerCaps(t *testing.T, perChat, overall int) {
	t.Helper()
	was, wasAll := maxTurnsPerChat, maxTurns
	maxTurnsPerChat, maxTurns = perChat, overall
	t.Cleanup(func() { maxTurnsPerChat, maxTurns = was, wasAll })
}

// slots is the chat objects that hold a slot of the cap: those of the chat id, and all.
func (e *env) slots(id string) (chat, all int) {
	e.t.Helper()
	top, err := e.m.topChat(id)
	if err != nil {
		e.t.Fatal(err)
	}
	e.m.capMu.Lock()
	defer e.m.capMu.Unlock()
	return e.m.slots(top, nil)
}

// slotsHeld fails unless chat objects of the chat id hold chat slots, and all of the app's.
func (e *env) slotsHeld(when, id string, chat, all int) {
	e.t.Helper()
	if c, a := e.slots(id); c != chat || a != all {
		e.t.Fatalf("%s: %d slots held in the chat, %d in all; want %d, %d", when, c, a, chat, all)
	}
}

// reserved counts the chat objects with a reservation: none is left once a call has returned.
func (e *env) reserved() int {
	e.m.capMu.Lock()
	defer e.m.capMu.Unlock()
	n := 0
	for _, c := range e.m.all() {
		if c.reserved {
			n++
		}
	}
	return n
}

func TestCapTextsAndOverrides(t *testing.T) {
	if maxTurnsPerChat != 4 || maxTurns != 12 {
		t.Fatalf("the caps are %d and %d", maxTurnsPerChat, maxTurns)
	}
	if got := ErrChatCap.Error(); got != "this chat already has 4 branches working; wait for one to finish or stop one" {
		t.Fatalf("ErrChatCap: %q", got)
	}
	if got := ErrAppCap.Error(); got != "12 agents are already working; wait for one to finish or stop one" {
		t.Fatalf("ErrAppCap: %q", got)
	}
	if errors.Is(ErrChatCap, ErrAppCap) || errors.Is(ErrAppCap, ErrChatCap) || errors.Is(ErrChatCap, ErrBusy) {
		t.Fatal("the two refusals are not told apart")
	}

	// AIWB_CHAT_CAP and AIWB_APP_CAP: unset or not a positive integer keeps the cap.
	t.Cleanup(func() { maxTurnsPerChat, maxTurns = 4, 12 })
	for _, v := range [][2]string{{"", ""}, {"0", "-3"}, {"two", "1.5"}, {"4x", " "}} {
		if c, a := SetCaps(v[0], v[1]); c != 4 || a != 12 {
			t.Fatalf("SetCaps(%q, %q): %d, %d", v[0], v[1], c, a)
		}
	}
	if c, a := SetCaps("2", ""); c != 2 || a != 12 || maxTurnsPerChat != 2 || maxTurns != 12 {
		t.Fatalf("the chat's cap alone: %d, %d", c, a)
	}
	if c, a := SetCaps("nope", " 3 "); c != 2 || a != 3 {
		t.Fatalf("the app's cap alone: %d, %d", c, a)
	}
	// The texts name the caps in force.
	if c, a := ErrChatCap.Error(), ErrAppCap.Error(); !strings.HasPrefix(c, "this chat already has 2 branches working;") || !strings.HasPrefix(a, "3 agents are already working;") {
		t.Fatalf("the texts with the caps 2 and 3: %q, %q", c, a)
	}
	SetCaps("1", "1")
	if c, a := ErrChatCap.Error(), ErrAppCap.Error(); c != "this chat already has 1 branch working; wait for it to finish or stop it" ||
		a != "1 agent is already working; wait for it to finish or stop it" {
		t.Fatalf("the texts with the caps 1 and 1: %q, %q", c, a)
	}
}

// A message to the end of a branch is refused when the chat has its cap of branches working, and
// leaves nothing: the thread, the draft, the counts and the current branch are as they were, and
// clients are sent nothing. A new branch is refused before anything is made for it. Another chat
// is not held back, and the slot a turn's end frees is taken by the next message.
func TestSendRefusedAtTheChatCap(t *testing.T) {
	e := newEnv(t)
	id, mainAg := e.talked(model.Claude, "", 2)
	b1, bid1, a1 := e.branchTo(id, newAt(3), "one")
	a1.emit(t, reply("q1")...) // the first branch is idle
	b2, _, a2 := e.branchTo(id, newAt(3), "two")
	lowerCaps(t, 2, 12)
	e.sendTo(id, Target{Branch: model.MainBranch, End: true}, "on main")
	if err := e.m.SetDraftOf(id, b1, model.Draft{Text: "kept"}); err != nil {
		t.Fatal(err)
	}
	e.slotsHeld("main and a branch work", id, 2, 2)

	evs := e.listen()
	thread, tree, view := e.file(bid1, "items.jsonl"), e.file(id, "tree.json"), e.view(id)
	forks := len(e.claude.forkCalls())
	untouched := func(when string) {
		t.Helper()
		if !bytes.Equal(e.file(bid1, "items.jsonl"), thread) || !bytes.Equal(e.file(id, "tree.json"), tree) {
			t.Fatalf("%s: the thread or the tree record changed", when)
		}
		if d := e.stateOfBranch(id, b1).Draft; d == nil || d.Text != "kept" {
			t.Fatalf("%s: the branch's draft is %+v", when, d)
		}
		if v := e.view(id); v != view || v.Working != 2 || e.cur(id) != model.MainBranch {
			t.Fatalf("%s: the view is %+v, was %+v", when, v, view)
		}
		if len(a1.sent()) != 1 || len(e.claude.forkCalls()) != forks {
			t.Fatalf("%s: the branch's process got %d messages, %d fork starts", when, len(a1.sent()), len(e.claude.forkCalls())-forks)
		}
		if ents, err := os.ReadDir(filepath.Join(e.st.P.ChatDir(id), "branches")); err != nil || len(ents) != 2 {
			t.Fatalf("%s: the branches folder has %v (%v)", when, ents, err)
		}
		if got := evs.drain(t, e.br); len(got) != 0 {
			t.Fatalf("%s: clients were sent %v", when, got)
		}
		e.slotsHeld(when, id, 2, 2)
		if n := e.reserved(); n != 0 {
			t.Fatalf("%s: %d reservations left", when, n)
		}
	}

	err := e.sendToErr(id, Target{Branch: b1, End: true})
	if !errors.Is(err, ErrChatCap) || err.Error() != "this chat already has 2 branches working; wait for one to finish or stop one" {
		t.Fatalf("a message to an idle branch at the chat's cap: %v", err)
	}
	untouched("after the refused message")
	// A new branch: refused before its folder is made or its fork started.
	if err := e.sendToErr(id, newAt(3)); !errors.Is(err, ErrChatCap) {
		t.Fatalf("a new branch at the chat's cap: %v", err)
	}
	untouched("after the refused new branch")
	// Busy comes first: a branch that works says so, cap or not.
	if err := e.sendToErr(id, Target{Branch: b2, End: true}); !errors.Is(err, ErrBusy) {
		t.Fatalf("a message to a working branch at the cap: %v", err)
	}
	if err := e.m.Send(id, "never sent", "", nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("a plain Send to the working current branch at the cap: %v", err)
	}

	// The cap is the chat's: another chat takes a message.
	other, _ := e.talked(model.Claude, "", 1)
	e.send(other, "go", "")
	e.slotsHeld("another chat works too", id, 2, 3)

	// A turn ends: its slot goes to the next message.
	a2.emit(t, reply("q2")...)
	e.slotsHeld("a branch's turn ended", id, 1, 2)
	e.sendTo(id, Target{Branch: b1, End: true}, "now")
	if len(a1.sent()) != 2 || e.cur(id) != b1 || e.stateOfBranch(id, b1).Draft != nil {
		t.Fatalf("the message after a slot was freed: %d sent, current %q", len(a1.sent()), e.cur(id))
	}
	e.slotsHeld("the freed slot is taken", id, 2, 3)
	if mainAg.isClosed() || mainAg.interrupted() != 0 {
		t.Fatal("the cap stopped a branch")
	}
}

// The cap over all chats. Subagents hold no slot. The refused message leaves nothing, the notice
// of what was not carried over included: it goes with the message that is accepted.
func TestSendRefusedAtTheAppCap(t *testing.T) {
	e := newEnv(t)
	id, _, _, _, at := e.runningLinked() // a subagent runs in it
	f := e.fork(id, at).ID
	fa := e.claude.lastFork(t)
	if !e.meta(f).NoticeOwed {
		t.Fatal("the fork owes its agent no notice")
	}
	x, xa := e.talked(model.Claude, "", 1)
	y, _ := e.talked(model.Claude, "", 1)
	if err := e.m.SetDraft(f, model.Draft{Text: "kept"}); err != nil {
		t.Fatal(err)
	}
	lowerCaps(t, 4, 2)
	e.slotsHeld("a subagent runs", id, 0, 0)
	e.send(x, "go", "")
	e.send(y, "go", "")
	e.slotsHeld("two chats work", id, 0, 2)

	evs := e.listen()
	n, view := len(e.items(f)), e.view(f)
	err := e.m.Send(f, "never sent", "", nil)
	if !errors.Is(err, ErrAppCap) || err.Error() != "2 agents are already working; wait for one to finish or stop one" {
		t.Fatalf("a message at the app's cap: %v", err)
	}
	if len(e.items(f)) != n || len(fa.sent()) != 0 || !e.meta(f).NoticeOwed || e.meta(f).TurnActive {
		t.Fatalf("the refused message left %d items, %d messages sent, chat.json %+v", len(e.items(f)), len(fa.sent()), e.meta(f))
	}
	if v := e.view(f); v != view || v.Draft == nil || v.Draft.Text != "kept" || v.Status != model.StatusReady {
		t.Fatalf("the view after the refused message %+v, was %+v", v, view)
	}
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("clients were sent %v", got)
	}
	// A new branch of a chat that is far from its own cap.
	if err := e.sendToErr(id, newAt(at)); !errors.Is(err, ErrAppCap) {
		t.Fatalf("a new branch at the app's cap: %v", err)
	}
	e.unsplit(id)
	e.slotsHeld("after the refusals", id, 0, 2)

	xa.emit(t, reply("p2")...)
	e.send(f, "now", "")
	if msg := lastSend(t, fa); !strings.Contains(msg, "<"+notCarriedTag+">") || e.meta(f).NoticeOwed || e.view(f).Draft != nil {
		t.Fatalf("the accepted message:\n%s", msg)
	}
	e.slotsHeld("the freed slot is taken", f, 1, 2)
}

// Every way a turn ends gives its slot back.
func TestSlotFreedByEveryEnd(t *testing.T) {
	for _, tc := range []struct {
		name string
		end  func(t *testing.T, e *env, x string, xa *fakeAgent)
	}{
		{"a clean turn end", func(t *testing.T, e *env, x string, xa *fakeAgent) { xa.emit(t, reply("p2")...) }},
		{"an errored turn end", func(t *testing.T, e *env, x string, xa *fakeAgent) {
			xa.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "the provider said no"})
		}},
		{"an interrupt", func(t *testing.T, e *env, x string, xa *fakeAgent) {
			if err := e.m.Interrupt(x); err != nil {
				t.Fatal(err)
			}
			e.slotsHeld("the stop was asked for", x, 1, 1) // the turn runs until the agent ends it
			xa.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
		}},
		{"a stop", func(t *testing.T, e *env, x string, xa *fakeAgent) { e.m.Stop(x) }},
		{"a process exit", func(t *testing.T, e *env, x string, xa *fakeAgent) { xa.exit(t) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			x, xa := e.talked(model.Claude, "", 1)
			y, ya := e.talked(model.Claude, "", 1)
			lowerCaps(t, 4, 1)
			evs := e.listen()
			e.send(x, "go", "")
			e.working("the turn started", evs, x, 1, 0, true)
			e.slotsHeld("the turn started", x, 1, 1)
			if err := e.m.Send(y, "never sent", "", nil); !errors.Is(err, ErrAppCap) {
				t.Fatalf("a message at the cap: %v", err)
			}
			tc.end(t, e, x, xa)
			e.working("the turn is over", evs, x, 0, 0, true)
			e.slotsHeld("the turn is over", x, 0, 0)
			e.send(y, "go", "")
			if len(ya.sent()) != 2 {
				t.Fatalf("the other chat's process got %d messages", len(ya.sent()))
			}
			e.slotsHeld("the slot is taken again", y, 1, 1)
		})
	}
}

// A start that fails holds no slot: of a process, and through the fork capability, which shows
// the chat as thinking while it lasts and counts for that long.
func TestFailedStartHoldsNoSlot(t *testing.T) {
	t.Run("a process", func(t *testing.T) {
		e := newEnv(t)
		x := e.create(model.Claude, gOne, "").ID
		dir := t.TempDir()
		if err := e.m.Configure(x, ConfigReq{Cwd: dir}); err != nil {
			t.Fatal(err)
		}
		if err := os.RemoveAll(dir); err != nil {
			t.Fatal(err)
		}
		y, _ := e.talked(model.Claude, "", 1)
		lowerCaps(t, 4, 1)
		if err := e.m.Send(x, "go", "", nil); !errors.Is(err, ErrFolderMissing) {
			t.Fatalf("a Send to a chat whose folder is gone: %v", err)
		}
		e.slotsHeld("the start failed", x, 0, 0)
		if n := e.reserved(); n != 0 || e.view(x).Working != 0 {
			t.Fatalf("%d reservations left, view %+v", n, e.view(x))
		}
		e.send(y, "go", "")
		// At the cap the start is not tried: the chat keeps the error it had and gets no other.
		if err := e.m.Send(x, "go", "", nil); !errors.Is(err, ErrAppCap) {
			t.Fatalf("a Send at the cap to a chat whose folder is gone: %v", err)
		}
	})

	t.Run("a fork start", func(t *testing.T) {
		e := newEnv(t)
		_, f := e.claudeFork()
		y, _ := e.talked(model.Claude, "", 1)
		e.boot() // the fork has no process and still has its fork source: its start is a fork start
		lowerCaps(t, 4, 1)
		evs := e.listen()
		b, res := e.block(e.claude, func() error { return e.m.Send(f, "carry on", "", nil) })
		e.working("during the fork start", evs, f, 1, 0, true)
		e.slotsHeld("during the fork start", f, 1, 1)
		if err := e.m.Send(y, "never sent", "", nil); !errors.Is(err, ErrAppCap) {
			t.Fatalf("a message during another chat's fork start, at the cap: %v", err)
		}
		if err := b.release(res, errors.New("No conversation found")); err == nil || !strings.Contains(err.Error(), "No conversation found") {
			t.Fatalf("the Send whose fork start failed: %v", err)
		}
		e.working("the fork start failed", evs, f, 0, 0, true)
		e.slotsHeld("the fork start failed", f, 0, 0)
		if n := e.reserved(); n != 0 {
			t.Fatalf("%d reservations left", n)
		}
		e.send(y, "go", "")
		e.slotsHeld("the slot is taken", y, 1, 1)

		// And one that succeeds keeps the slot it counted for, as the turn's.
		e.claude.last(t).emit(t, reply("p2")...)
		e.send(f, "carry on", "")
		e.working("the fork works", evs, f, 1, 0, true)
		e.slotsHeld("the fork works", f, 1, 1)
	})
}

// A delivery the adapter refuses: the turn the app started for it is over, and its slot is free.
func TestRefusedDeliveryFreesTheSlot(t *testing.T) {
	e := newEnv(t)
	x, xa := e.talked(model.Claude, "", 1)
	_, child := e.waiting(x)
	y, ya := e.talked(model.Claude, "", 1)
	lowerCaps(t, 4, 1)
	evs := e.listen()
	release := xa.blockSends()
	defer release()
	child.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	// The turn has started and its message is on the way to the agent.
	e.working("the delivery turn started", evs, x, 1, 0, true)
	e.slotsHeld("the delivery turn started", x, 1, 1)
	if err := e.m.Send(y, "never sent", "", nil); !errors.Is(err, ErrAppCap) {
		t.Fatalf("a message during a delivery turn, at the cap: %v", err)
	}
	xa.failSends(errors.New("stdin closed"))
	release()
	e.m.handoffs.Wait()
	if xa.refused() != 1 || e.m.Busy(x) {
		t.Fatalf("the delivery was refused %d times, busy %v", xa.refused(), e.m.Busy(x))
	}
	e.working("the delivery was refused", evs, x, 0, 0, true)
	e.slotsHeld("the delivery was refused", x, 0, 0)
	e.send(y, "go", "")
	if len(ya.sent()) != 2 {
		t.Fatalf("the other chat's process got %d messages", len(ya.sent()))
	}
}

// A message of the human's that the adapter refuses leaves the chat showing "thinking" until
// something ends the turn, and an adapter may send nothing that does. No turn runs, so the chat
// holds no slot; whatever its agent says later is a turn's, and takes one.
func TestRefusedSendFreesTheSlot(t *testing.T) {
	e := newEnv(t)
	x, xa := e.talked(model.Claude, "", 1)
	y, ya := e.talked(model.Claude, "", 1)
	lowerCaps(t, 4, 1)
	xa.failSends(errors.New("the handshake failed"))
	if err := e.m.Send(x, "go", "", nil); err == nil || err.Error() != "the handshake failed" {
		t.Fatalf("the refused Send: %v", err)
	}
	if v := e.view(x); v.Status != model.StatusThinking || v.Working != 1 || len(e.items(x)) != 4 {
		t.Fatalf("after the refused Send: view %+v, %d items", v, len(e.items(x)))
	}
	e.slotsHeld("the message was refused", x, 0, 0)
	e.send(y, "go", "")
	e.slotsHeld("another chat took the slot", y, 1, 1)
	// The agent goes on after all: a turn, counted, though no slot was left for it.
	xa.emit(t, agent.Event{Kind: agent.EvUsage, CtxIn: 10})
	e.slotsHeld("usage says nothing of a turn", x, 0, 1)
	xa.emit(t, agent.Event{Kind: agent.EvThinking})
	e.slotsHeld("the agent goes on", x, 1, 2)
	xa.emit(t, reply("p2")...)
	ya.emit(t, reply("p2")...)
	e.slotsHeld("both turns ended", x, 0, 0)

	// An adapter that ends the refused turn itself (pi, rejecting a prompt): no slot is lost or
	// kept either way.
	const rejected = "pi rejected the prompt: no"
	xa.failSends(errors.New(rejected), agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvTurnEnd, Error: rejected})
	if err := e.m.Send(x, "again", "", nil); err == nil {
		t.Fatal("the rejected Send returned no error")
	}
	e.slotsHeld("the adapter ended the refused turn", x, 0, 0)
	xa.failSends(nil)
	e.send(x, "and again", "")
	e.slotsHeld("the next message", x, 1, 1)
	if err := e.m.Send(y, "never sent", "", nil); !errors.Is(err, ErrAppCap) {
		t.Fatalf("a message at the cap: %v", err)
	}
}

// The refused message's "thinking" holds no slot only while it shows: a permission request of a
// subagent the chat spawned makes the chat wait for an approval, and that is counted.
func TestRefusedSendCountsAgainOnASubagentsRequest(t *testing.T) {
	e := newEnv(t)
	x, xa := e.talked(model.Claude, "", 1)
	e.spawn(x, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)
	lowerCaps(t, 1, 12)
	xa.failSends(errors.New("the handshake failed"))
	if err := e.m.Send(x, "go", "", nil); err == nil || err.Error() != "the handshake failed" {
		t.Fatalf("the refused Send: %v", err)
	}
	if v := e.view(x); v.Status != model.StatusThinking {
		t.Fatalf("after the refused Send: view %+v", v)
	}
	e.slotsHeld("the message was refused", x, 0, 0)
	child.emit(t, agent.Event{Kind: agent.EvPermRequest, PermID: "r1", ToolName: "Bash", ToolID: "s1"})
	if v := e.view(x); v.Status != model.StatusApproval {
		t.Fatalf("after the subagent's request: view %+v", v)
	}
	e.slotsHeld("the chat waits for an approval", x, 1, 1)
	if err := e.sendToErr(x, newAt(3)); !errors.Is(err, ErrChatCap) {
		t.Fatalf("a new branch at the cap: %v", err)
	}
	e.unsplit(x)
}

// Two messages at once for the last slot: one is admitted, the other refused.
func TestTwoSendsForTheLastSlot(t *testing.T) {
	const rounds = 100
	run := func(t *testing.T, e *env, ids [2]string, want error, sends [2]func() error, agents [2]*fakeAgent) {
		t.Helper()
		before := len(agents[0].sent()) + len(agents[1].sent())
		for i := range rounds {
			var errs [2]error
			var wg sync.WaitGroup
			start := make(chan struct{})
			for j := range sends {
				wg.Add(1)
				go func() {
					defer wg.Done()
					<-start
					errs[j] = sends[j]()
				}()
			}
			close(start)
			wg.Wait()
			won := 0
			switch {
			case errs[0] == nil && errors.Is(errs[1], want):
			case errs[1] == nil && errors.Is(errs[0], want):
				won = 1
			default:
				t.Fatalf("round %d: the two Sends returned %v and %v", i, errs[0], errs[1])
			}
			e.slotsHeld("one was admitted", ids[won], 1, 1)
			if n := e.reserved(); n != 0 {
				t.Fatalf("round %d: %d reservations left", i, n)
			}
			agents[won].emit(t, reply("r"+strconv.Itoa(i))...)
			e.slotsHeld("its turn ended", ids[won], 0, 0)
		}
		if got := len(agents[0].sent()) + len(agents[1].sent()) - before; got != rounds {
			t.Fatalf("the two processes got %d messages in %d rounds", got, rounds)
		}
	}

	t.Run("of the app", func(t *testing.T) {
		e := newEnv(t)
		x, xa := e.talked(model.Claude, "", 1)
		y, ya := e.talked(model.Claude, "", 1)
		lowerCaps(t, 4, 1)
		run(t, e, [2]string{x, y}, ErrAppCap, [2]func() error{
			func() error { return e.m.Send(x, "go", "", nil) },
			func() error { return e.m.Send(y, "go", "", nil) },
		}, [2]*fakeAgent{xa, ya})
	})

	t.Run("of the chat", func(t *testing.T) {
		e := newEnv(t)
		id, mainAg := e.talked(model.Claude, "", 2)
		b, _, fa := e.branchTo(id, newAt(3), "aside")
		fa.emit(t, reply("q1")...)
		lowerCaps(t, 1, 12)
		run(t, e, [2]string{id, id}, ErrChatCap, [2]func() error{
			func() error { return e.m.SendTo(id, Target{Branch: model.MainBranch, End: true}, "go", "", nil) },
			func() error { return e.m.SendTo(id, Target{Branch: b, End: true}, "go", "", nil) },
		}, [2]*fakeAgent{mainAg, fa})
	})
}

// At the cap the app starts no turn for a subagent's result: nothing is taken, the result stays
// owed and shows as owed, the chat is not held, and nothing is queued: a slot that frees starts
// nothing by itself. The result goes with the human's next message, or at the chat's own next
// trigger.
func TestDeliveryNotStartedAtTheCap(t *testing.T) {
	setup := func(t *testing.T) (e *env, x string, xa *fakeAgent, sa model.Subagent, ya *fakeAgent) {
		e = newEnv(t)
		x, xa = e.talked(model.Claude, "", 1)
		sa, child := e.waiting(x)
		y, ya := e.talked(model.Claude, "", 1)
		lowerCaps(t, 4, 1)
		e.send(y, "go", "")
		evs := e.listen()
		thread := e.file(x, "items.jsonl")

		e.finish(child, "42 files")
		if len(xa.sent()) != 1 || e.m.Busy(x) || e.meta(x).TurnActive || !bytes.Equal(e.file(x, "items.jsonl"), thread) {
			t.Fatalf("a turn started at the cap: %d messages sent, busy %v", len(xa.sent()), e.m.Busy(x))
		}
		if s := e.sub(x, sa.ID); s.Delivery != model.SubOwed || e.subFile(x, sa.ID).Delivery != model.SubOwed {
			t.Fatalf("the result at the cap: %+v", s)
		}
		// Clients: the record of the branch and the chat's view have it as owed.
		st := e.stateOfBranch(x, model.MainBranch)
		if st.Status != model.StatusReady || st.SubsOwed != 1 || st.SubsRunning != 0 {
			t.Fatalf("the state record at the cap %+v", st)
		}
		got := evs.drain(t, e.br)
		if sts := statesOf(t, got, x, model.MainBranch); len(sts) == 0 || sts[len(sts)-1] != st {
			t.Fatalf("the state records sent %+v, want %+v last", sts, st)
		}
		if vs := chatViews(t, got, x); len(vs) == 0 || vs[len(vs)-1].SubsOwed != 1 || vs[len(vs)-1].Working != 0 {
			t.Fatalf("the chat views sent %+v", vs)
		}
		c, err := e.m.get(x)
		if err != nil {
			t.Fatal(err)
		}
		c.mu.Lock()
		hold, carrying := c.hold, c.carry != nil
		c.mu.Unlock()
		if hold || carrying || e.reserved() != 0 {
			t.Fatalf("at the cap: held %v, carrying %v, %d reservations", hold, carrying, e.reserved())
		}
		e.slotsHeld("the delivery was not started", x, 0, 1)

		// The slot frees: nothing was queued, so nothing starts.
		ya.emit(t, reply("p2")...)
		e.m.handoffs.Wait()
		if len(xa.sent()) != 1 || e.m.Busy(x) || e.stateOfBranch(x, model.MainBranch).SubsOwed != 1 {
			t.Fatalf("a freed slot started a turn: %d messages sent", len(xa.sent()))
		}
		e.slotsHeld("the other chat's turn ended", x, 0, 0)
		return e, x, xa, sa, ya
	}

	t.Run("sent with the next human message", func(t *testing.T) {
		e, x, xa, sa, _ := setup(t)
		e.send(x, "and?", "")
		sent := xa.sent()
		if len(sent) != 2 || !reflect.DeepEqual(deliveredSids(sent[1]), []string{sa.ID}) || !strings.Contains(lastSend(t, xa), "<report>42 files</report>") {
			t.Fatalf("the human's message: %v", sent)
		}
		if rows := resultRows(e.items(x)); len(rows) != 1 || rows[0] != sa.ID || e.sub(x, sa.ID).Delivery != model.SubSent || e.view(x).SubsOwed != 0 {
			t.Fatalf("after the human's message: rows %v, %+v", rows, e.sub(x, sa.ID))
		}
		e.slotsHeld("the human's message", x, 1, 1)
	})

	t.Run("sent at the chat's next trigger", func(t *testing.T) {
		e, x, xa, sa, _ := setup(t)
		e.deliverNow(x)
		sent := xa.sent()
		if len(sent) != 2 || !reflect.DeepEqual(deliveredSids(sent[1]), []string{sa.ID}) || !e.m.Busy(x) {
			t.Fatalf("the delivery once a slot is free: %v", sent)
		}
		e.slotsHeld("the delivery turn", x, 1, 1)
	})
}

// A delivery turn that starts on a branch that is not the current one, below the cap: clients
// get the chat's view with the raised count of working branches. (The reservation of the slot
// must not write the mirror the "counts changed" of that view is derived from.)
func TestDeliveryOnANonCurrentBranchSendsTheCount(t *testing.T) {
	e := newEnv(t)
	id, mainAg := e.talked(model.Claude, "", 2)
	sa, child := e.waiting(id)
	b, _, fa := e.branchTo(id, newAt(3), "aside")
	fa.emit(t, reply("q1")...) // the current branch is idle
	evs := e.listen()
	e.working("both idle", evs, id, 0, 0, false)

	e.finish(child, "42 files")
	if sent := mainAg.sent(); len(sent) != 3 || !reflect.DeepEqual(deliveredSids(sent[2]), []string{sa.ID}) || e.cur(id) != b {
		t.Fatalf("the delivery on main: %d messages, current %q", len(sent), e.cur(id))
	}
	got := evs.drain(t, e.br)
	vs := chatViews(t, got, id)
	if len(vs) == 0 || vs[len(vs)-1].Working != 1 || vs[len(vs)-1].Branch != b || vs[len(vs)-1].Status != model.StatusReady {
		t.Fatalf("the chat views sent for a delivery turn on the branch that is not current: %+v", vs)
	}
	if sts := statesOf(t, got, id, model.MainBranch); len(sts) == 0 || sts[len(sts)-1].Status != model.StatusThinking {
		t.Fatalf("main's records sent %+v", sts)
	}
	e.working("the delivery turn started", evs, id, 1, 0, false)
	e.slotsHeld("the delivery turn started", id, 1, 1)
	if n := e.reserved(); n != 0 {
		t.Fatalf("%d reservations left", n)
	}

	mainAg.emit(t, reply("p3")...)
	e.m.handoffs.Wait()
	e.working("the delivery turn ended", evs, id, 0, 0, true)
	e.slotsHeld("the delivery turn ended", id, 0, 0)
}

// A new branch at the cap is refused before anything is made: no folder, no tree record, no fork
// start. When the slot goes while the branch's fork is being started, the message is refused by
// the admission, and nothing is left of the branch then either.
func TestNewBranchAtTheCap(t *testing.T) {
	t.Run("refused before anything is made", func(t *testing.T) {
		e := newEnv(t)
		id, mainAg := e.talked(model.Claude, "", 2)
		lowerCaps(t, 1, 12)
		e.send(id, "go", "")
		objects := len(e.m.all())
		if err := e.sendToErr(id, newAt(3)); !errors.Is(err, ErrChatCap) {
			t.Fatalf("a new branch at the cap: %v", err)
		}
		e.unsplit(id)
		if n := len(e.claude.forkCalls()); n != 0 || len(e.m.all()) != objects || len(mainAg.sent()) != 3 {
			t.Fatalf("%d fork starts, %d chat objects (were %d)", n, len(e.m.all()), objects)
		}
		e.slotsHeld("after the refusal", id, 1, 1)
		// Below the cap the branch is made, from the running source.
		mainAg.emit(t, reply("p3")...)
		b, _, _ := e.branchTo(id, newAt(3), "aside")
		e.slotsHeld("the new branch works", id, 1, 1)
		if e.cur(id) != b {
			t.Fatalf("current %q", e.cur(id))
		}
	})

	t.Run("the slot goes during the fork start", func(t *testing.T) {
		e := newEnv(t)
		id, _ := e.talked(model.Claude, "", 2)
		b1, _, a1 := e.branchTo(id, newAt(3), "one")
		a1.emit(t, reply("q1")...)
		lowerCaps(t, 2, 12)
		e.sendTo(id, Target{Branch: model.MainBranch, End: true}, "on main")
		objects := len(e.m.all())

		blk, res := e.block(e.claude, func() error { return e.sendToErr(id, newAt(3)) })
		e.sendTo(id, Target{Branch: b1, End: true}, "takes the last slot")
		if err := blk.release(res, nil); !errors.Is(err, ErrChatCap) {
			t.Fatalf("a new branch whose slot went during its fork start: %v", err)
		}
		fa := e.claude.lastFork(t)
		waitFor(t, "the new branch's process to close", fa.isClosed)
		if len(fa.sent()) != 0 || len(e.m.all()) != objects || e.cur(id) != b1 {
			t.Fatalf("the refused branch: %d messages sent, %d chat objects (were %d), current %q", len(fa.sent()), len(e.m.all()), objects, e.cur(id))
		}
		if rec, _ := e.treeFile(id); len(rec.Branches) != 1 || rec.Branches[0].ID != b1 || rec.Current != b1 {
			t.Fatalf("the tree record after the refused branch %+v", rec)
		}
		if ents, err := os.ReadDir(filepath.Join(e.st.P.ChatDir(id), "branches")); err != nil || len(ents) != 1 || ents[0].Name() != b1 {
			t.Fatalf("the branches folder: %v (%v)", ents, err)
		}
		waitFor(t, "the fork to be discarded", func() bool { return len(e.claude.discarded()) == 1 })
		e.slotsHeld("after the refusal", id, 2, 2)
		if n := e.reserved(); n != 0 {
			t.Fatalf("%d reservations left", n)
		}
	})
}
