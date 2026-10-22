package chats

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// The chat path of the rule of background.go: a chat whose agent ends a turn cleanly with
// background work left waits, and the person's Stop closes its process.

// bgEnd is a clean turn end at which the process reports b.
func bgEnd(b agent.Background) agent.Event { return agent.Event{Kind: agent.EvTurnEnd, Background: b} }

// waitingChat makes a Claude chat whose first turn ("started") ended with one background command
// running, and returns its id and process. The quiet wait is an hour unless the test lowers it.
func (e *env) waitingChat() (string, *fakeAgent) {
	e.t.Helper()
	e.m.bgQuietWait = time.Hour
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "start a command in the background", "")
	e.m.naming.Wait()
	a := e.claude.last(e.t)
	a.emit(e.t, agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvText, Text: "started"},
		bgEnd(agent.Background{Running: 1}))
	if st := e.view(v.ID).Status; st != model.StatusWaiting {
		e.t.Fatalf("status %q after a turn end with work running, want waiting", st)
	}
	return v.ID, a
}

// itemTexts is the texts the agent wrote in the thread, in order.
func itemTexts(items []model.Item) []string {
	var out []string
	for _, it := range items {
		if it.Kind == "text" {
			out = append(out, it.Text)
		}
	}
	return out
}

// countKind counts the items of the kind k.
func countKind(items []model.Item, k string) int {
	n := 0
	for _, it := range items {
		if it.Kind == k {
			n++
		}
	}
	return n
}

// holdOf reads the chat's hold.
func (e *env) holdOf(id string) bool {
	e.t.Helper()
	c, err := e.m.lock(id)
	if err != nil {
		e.t.Fatal(err)
	}
	defer c.mu.Unlock()
	return c.hold
}

func TestChatWaitsOnItsBackgroundWork(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, a := e.waitingChat()

	v := e.view(id)
	if v.Status != model.StatusWaiting || v.Working != 1 {
		t.Fatalf("view status %q, working %d; want waiting, 1", v.Status, v.Working)
	}
	if !e.m.Busy(id) {
		t.Fatal("a waiting chat is not busy")
	}
	if err := e.m.Send(id, "never sent", "", nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("Send to a waiting chat: %v, want ErrBusy", err)
	}
	if len(a.sent()) != 1 {
		t.Fatalf("the process got %d messages, want the first only", len(a.sent()))
	}
	meta := e.meta(id)
	if !meta.TurnActive || meta.Usage.Turns != 1 {
		t.Fatalf("chat.json TurnActive %v, turns %d; want true, 1", meta.TurnActive, meta.Usage.Turns)
	}
	items := e.items(id)
	if last := items[len(items)-1]; last.Kind != "end" {
		t.Fatalf("the last item is %+v, want the turn's end mark", last)
	}
	if agentClosed(a) || a.interrupted() != 0 {
		t.Fatal("the process was stopped")
	}
}

func TestChatSelfBegunTurnShowsWorkingThenWaits(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, a := e.waitingChat()

	a.emit(t, agent.Event{Kind: agent.EvThinking})
	if st := e.view(id).Status; st != model.StatusThinking {
		t.Fatalf("status %q in a turn the process began, want thinking", st)
	}
	if !e.meta(id).TurnActive {
		t.Fatal("TurnActive cleared")
	}
	a.emit(t, agent.Event{Kind: agent.EvText, Text: "the command printed done"}, bgEnd(agent.Background{Running: 1}))
	if st := e.view(id).Status; st != model.StatusWaiting {
		t.Fatalf("status %q after its end with work running, want waiting", st)
	}
	if n := e.meta(id).Usage.Turns; n != 2 {
		t.Fatalf("%d turns, want 2", n)
	}
	items := e.items(id)
	if got := itemTexts(items); !slices.Equal(got, []string{"started", "the command printed done"}) {
		t.Fatalf("texts %q", got)
	}
	if n := countKind(items, "user"); n != 1 {
		t.Fatalf("%d user items, want the one message", n)
	}
	if n := countKind(items, "end"); n != 2 {
		t.Fatalf("%d end marks, want 2", n)
	}
}

func TestChatIdleAfterTheLastTurn(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, a := e.waitingChat()

	a.emit(t, agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvText, Text: "all done"}, bgEnd(agent.Background{}))
	if st := e.view(id).Status; st != model.StatusReady {
		t.Fatalf("status %q after the last turn, want ready", st)
	}
	if e.meta(id).TurnActive || e.m.Busy(id) {
		t.Fatal("the chat still works")
	}

	// Results that became owed during the last turn go out when it ends.
	id, a = e.waitingChat()
	n := e.claude.count()
	a.emit(t, agent.Event{Kind: agent.EvThinking}) // a turn of its own: no delivery into it
	sa := e.spawn(id, SpawnSubRequest{Prompt: "count", Description: "count files"})
	child := waitChild(t, e.claude, n+1)
	e.finish(child, "42 files")
	if len(a.sent()) != 1 {
		t.Fatal("results handed to a chat in a turn")
	}
	a.emit(t, agent.Event{Kind: agent.EvText, Text: "all done"}, bgEnd(agent.Background{}))
	e.m.handoffs.Wait()
	if got := deliveredSids(a.sent()[len(a.sent())-1]); !slices.Equal(got, []string{sa.ID}) {
		t.Fatalf("the last message carries %v, want the result of %s", got, sa.ID)
	}
	if st := e.view(id).Status; st != model.StatusThinking {
		t.Fatalf("status %q with the delivery, want thinking", st)
	}
}

func TestWaitingChatTakesSubagentResults(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.m.bgQuietWait = time.Hour
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "delegate, and start a command", "")
	e.m.naming.Wait()
	a := e.claude.last(t)
	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "count", Description: "count files"})
	child := waitChild(t, e.claude, 2)
	a.emit(t, agent.Event{Kind: agent.EvText, Text: "started both"}, bgEnd(agent.Background{Running: 1}))
	if st := e.view(v.ID).Status; st != model.StatusWaiting {
		t.Fatalf("status %q, want waiting", st)
	}

	e.finish(child, "42 files")
	if len(a.sent()) != 2 {
		t.Fatalf("%d messages, want the human's and one delivery", len(a.sent()))
	}
	if got := deliveredSids(a.sent()[1]); !slices.Equal(got, []string{sa.ID}) {
		t.Fatalf("the delivery carries %v", got)
	}
	if st := e.view(v.ID).Status; st != model.StatusThinking {
		t.Fatalf("status %q with the delivery, want thinking", st)
	}

	a.emit(t, agent.Event{Kind: agent.EvText, Text: "thanks"}, bgEnd(agent.Background{Running: 1}))
	if st := e.view(v.ID).Status; st != model.StatusWaiting {
		t.Fatalf("status %q after the delivery's turn with work running, want waiting", st)
	}
	if s := e.sub(v.ID, sa.ID); s.Delivery != model.SubSent {
		t.Fatalf("the result's delivery is %q, want sent", s.Delivery)
	}
	if len(a.sent()) != 2 {
		t.Fatal("delivered twice")
	}
}

func TestChatQuietWaitEndsAWaitWithNothingRunning(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, a := e.waitingChat()
	e.m.bgQuietWait = 50 * time.Millisecond // after the pump's last arm: see emit's sync
	a.emit(t, agent.Event{Kind: agent.EvBackground, Background: agent.Background{Unread: true}})
	waitFor(t, "the chat to be idle after the quiet wait", func() bool { return e.view(id).Status == model.StatusReady })
	if e.meta(id).TurnActive {
		t.Fatal("TurnActive still set")
	}

	// A turn that begins before it is over keeps the chat working.
	id, a = e.waitingChat()
	e.m.bgQuietWait = 50 * time.Millisecond
	a.emit(t, agent.Event{Kind: agent.EvBackground, Background: agent.Background{Unread: true}},
		agent.Event{Kind: agent.EvThinking})
	c, err := e.m.get(id)
	if err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	armed := c.bg.armed
	c.mu.Unlock()
	if armed != 1 {
		t.Fatalf("the quiet wait was armed %d times, want 1", armed)
	}
	time.Sleep(10 * 50 * time.Millisecond)
	if st := e.view(id).Status; st != model.StatusThinking {
		t.Fatalf("status %q after the quiet time, want thinking", st)
	}
	if !e.meta(id).TurnActive {
		t.Fatal("TurnActive cleared")
	}
}

func TestStopWaitingChatClosesItsProcess(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, a := e.waitingChat()

	if err := e.m.Interrupt(id); err != nil {
		t.Fatal(err)
	}
	if !agentClosed(a) {
		t.Fatal("the process of a waiting chat was not closed")
	}
	if st := e.view(id).Status; st != model.StatusReady {
		t.Fatalf("status %q, want ready", st)
	}
	if got := notes(e.items(id), "muted"); !slices.Equal(got, []string{"Stopped."}) {
		t.Fatalf("muted notes %q", got)
	}
	if !e.holdOf(id) {
		t.Fatal("the chat is not held")
	}
	if e.meta(id).TurnActive {
		t.Fatal("TurnActive still set")
	}

	e.send(id, "again", "")
	if n := e.claude.count(); n != 2 {
		t.Fatalf("%d processes, want a new one", n)
	}
	if b := e.claude.last(t); !b.opts.Resume {
		t.Fatal("the new process does not resume the session")
	}
}

func TestStopChatInATurnWithBackgroundWork(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "go", "")
	a := e.claude.last(t)
	a.emit(t, agent.Event{Kind: agent.EvBackground, Background: agent.Background{Running: 1}},
		agent.Event{Kind: agent.EvThinking})
	if err := e.m.Interrupt(v.ID); err != nil {
		t.Fatal(err)
	}
	if !agentClosed(a) {
		t.Fatal("the process with background work was only interrupted")
	}
	if st := e.view(v.ID).Status; st != model.StatusReady {
		t.Fatalf("status %q, want ready", st)
	}
}

// inTurnWithWork makes a Claude chat whose turn is running with one background command that the
// pump has seen, and returns its id and process.
func (e *env) inTurnWithWork() (string, *fakeAgent) {
	e.t.Helper()
	e.m.bgQuietWait = time.Hour
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "start a command in the background", "")
	a := e.claude.last(e.t)
	a.emit(e.t, agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvBackground, Background: agent.Background{Running: 1}})
	return v.ID, a
}

// closedAfter checks that the chat's process was closed, that the chat shows ready, held and not
// in a turn, and that its next message resumes the session in a new process with no work known.
func (e *env) closedAfter(id string, a *fakeAgent) {
	e.t.Helper()
	waitFor(e.t, "the process to be closed", func() bool { return agentClosed(a) })
	if st := e.view(id).Status; st != model.StatusReady {
		e.t.Fatalf("status %q, want ready", st)
	}
	if e.meta(id).TurnActive || e.m.Busy(id) {
		e.t.Fatalf("TurnActive %v, busy %v; want neither", e.meta(id).TurnActive, e.m.Busy(id))
	}
	if !e.holdOf(id) {
		e.t.Fatal("the chat is not held")
	}
	// What the old process still says is dropped, as after Stop.
	a.emit(e.t, agent.Event{Kind: agent.EvBackground, Background: agent.Background{Running: 1}})
	if st := e.view(id).Status; st != model.StatusReady {
		e.t.Fatalf("status %q after the old process spoke, want ready", st)
	}
	e.send(id, "again", "")
	if n := e.claude.count(); n != 2 {
		e.t.Fatalf("%d processes, want a new one", n)
	}
	if b := e.claude.last(e.t); !b.opts.Resume {
		e.t.Fatal("the new process does not resume the session")
	}
}

// A turn that ends aborted while the process has background work (a Stop that came before the pump
// had seen the work) closes the process, as Stop of a waiting chat does: the commands must not go
// on and begin turns of a chat that shows stopped.
func TestAbortedTurnEndWithBackgroundWorkClosesTheProcess(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, a := e.inTurnWithWork()
	ev := bgEnd(agent.Background{Running: 1})
	ev.Aborted = true
	a.emit(t, ev)
	e.closedAfter(id, a)
	if got := notes(e.items(id), "muted"); !slices.Equal(got, []string{"Stopped."}) {
		t.Fatalf("muted notes %q", got)
	}
}

// The same for a turn that fails: the chat keeps the error note and shows ready, and the process
// with its Monitor goes, so that no notice begins a turn of its own later.
func TestErroredTurnEndWithBackgroundWorkClosesTheProcess(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, a := e.inTurnWithWork()
	ev := bgEnd(agent.Background{Running: 1})
	ev.Error = "529 overloaded"
	a.emit(t, ev)
	e.closedAfter(id, a)
	if got := notes(e.items(id), "error"); len(got) != 1 || !strings.Contains(got[0], "529 overloaded") {
		t.Fatalf("error notes %q, want the one error", got)
	}
}

// An errored turn end of a chat that was waiting (a self-begun turn that fails while a Monitor runs).
func TestErroredSelfBegunTurnWhileWaitingClosesTheProcess(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, a := e.waitingChat()
	a.emit(t, agent.Event{Kind: agent.EvThinking})
	ev := bgEnd(agent.Background{Running: 1})
	ev.Error = "529 overloaded"
	a.emit(t, ev)
	e.closedAfter(id, a)
	if got := notes(e.items(id), "error"); len(got) != 1 || !strings.Contains(got[0], "529 overloaded") {
		t.Fatalf("error notes %q, want the one error", got)
	}
}

// An errored turn end with no background work is what it was: the process stays.
func TestErroredTurnEndWithoutBackgroundWorkUnchanged(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "go", "")
	a := e.claude.last(t)
	ev := bgEnd(agent.Background{})
	ev.Error = "529 overloaded"
	a.emit(t, agent.Event{Kind: agent.EvThinking}, ev)
	if agentClosed(a) {
		t.Fatal("the process was closed")
	}
	if st := e.view(v.ID).Status; st != model.StatusReady {
		t.Fatalf("status %q, want ready", st)
	}
	e.send(v.ID, "again", "")
	if n := e.claude.count(); n != 1 {
		t.Fatalf("%d processes, want the same one", n)
	}
}

// A clean turn end with work left still waits and keeps its process (the rule of background.go).
func TestCleanTurnEndWithBackgroundWorkKeepsTheProcess(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, a := e.inTurnWithWork()
	a.emit(t, bgEnd(agent.Background{Running: 1}))
	if agentClosed(a) {
		t.Fatal("the process of a waiting chat was closed")
	}
	if st := e.view(id).Status; st != model.StatusWaiting {
		t.Fatalf("status %q, want waiting", st)
	}
}

func TestInterruptWithoutBackgroundWorkUnchanged(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "go", "")
	a := e.claude.last(t)
	a.emit(t, agent.Event{Kind: agent.EvThinking})
	if err := e.m.Interrupt(v.ID); err != nil {
		t.Fatal(err)
	}
	if agentClosed(a) || a.interrupted() != 1 {
		t.Fatalf("closed %v, interrupts %d; want the turn interrupted and the process kept", agentClosed(a), a.interrupted())
	}
}

func TestExitWhileWaiting(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, a := e.waitingChat()
	a.exit(t)
	if st := e.view(id).Status; st != model.StatusStopped {
		t.Fatalf("status %q, want stopped", st)
	}
	if got := notes(e.items(id), "error"); !slices.Equal(got, []string{"The agent stopped: process ended"}) {
		t.Fatalf("error notes %q", got)
	}
}

func TestRestartWhileWaitingShowsStopped(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.waitingChat()
	e.m.Shutdown()
	e.boot()
	if st := e.view(id).Status; st != model.StatusStopped {
		t.Fatalf("status %q after a restart, want stopped", st)
	}
	if got := notes(e.items(id), "error"); !slices.Equal(got, []string{"Stopped: the app was closed while the agent was working."}) {
		t.Fatalf("error notes %q", got)
	}
}

// Not parallel: it lowers the caps.
func TestWaitingChatHoldsATurnSlot(t *testing.T) {
	e := newEnv(t)
	e.m.bgQuietWait = time.Hour
	id, _ := e.talked(model.Claude, "", 2)
	_, _, a1 := e.branchTo(id, newAt(3), "one")
	a1.emit(t, agent.Event{Kind: agent.EvText, Text: "started"}, bgEnd(agent.Background{Running: 1}))
	lowerCaps(t, 1, 12)
	e.slotsHeld("a branch waits", id, 1, 1)
	if err := e.sendToErr(id, Target{Branch: model.MainBranch, End: true}); !errors.Is(err, ErrChatCap) {
		t.Fatalf("a message to main while a branch waits, at a cap of 1: %v, want ErrChatCap", err)
	}
}
