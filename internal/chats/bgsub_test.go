package chats

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// The subagent's side of the background rule (background.go, nested.go): a subagent whose process
// has background work running is waiting, not finished. The events are built by hand.

// subBgEnd is the clean end of a turn of a subagent's process that reports its background work.
func subBgEnd(running int, unread bool) agent.Event {
	return agent.Event{Kind: agent.EvTurnEnd, Background: agent.Background{Running: running, Unread: unread}}
}

// bgNow is the event that reports a change of the background work between turns.
func bgNow(running int, unread bool) agent.Event {
	return agent.Event{Kind: agent.EvBackground, Background: agent.Background{Running: running, Unread: unread}}
}

// bgSub is a subagent of a chat whose agent rests: its record and its process, which has had its
// prompt. The manager's quiet wait for background work is as long as the test says.
func bgSub(t *testing.T, quiet time.Duration) (e *env, id string, a model.Subagent, parent, pa *fakeAgent) {
	t.Helper()
	e = newEnv(t)
	e.m.bgQuietWait = quiet
	id, parent = e.nested(2)
	a, pa = e.child(id, "", "delegate")
	return e, id, a, parent, pa
}

func hasText(items []model.Item, text string) bool {
	for _, it := range items {
		if it.Text == text {
			return true
		}
	}
	return false
}

func TestSubagentWaitsOnItsBackgroundWork(t *testing.T) {
	t.Parallel()
	e, id, a, parent, pa := bgSub(t, time.Hour)
	pa.emit(t, agent.Event{Kind: agent.EvText, Text: "I started a command"}, subBgEnd(1, false))
	e.m.handoffs.Wait()
	s := e.sub(id, a.ID)
	if s.Status != model.SubRunning || !s.Waiting || !s.BgWaiting || s.Ended != 0 || s.Delivery != model.SubNotOwed {
		t.Fatalf("after a turn end with a command running: %+v", s)
	}
	if f := e.subFile(id, a.ID); !f.Waiting || !f.BgWaiting {
		t.Fatalf("subagent.json of the waiting one %+v", f)
	}
	if agentClosed(pa) || len(pa.sent()) != 1 || len(parent.sent()) != 1 {
		t.Fatalf("closed %v, %d messages to it, %d to the chat's agent", agentClosed(pa), len(pa.sent()), len(parent.sent()))
	}
}

func TestSubagentSelfBegunTurnWorksThenWaits(t *testing.T) {
	t.Parallel()
	e, id, a, _, pa := bgSub(t, time.Hour)
	pa.emit(t, subBgEnd(1, false))
	if s := e.sub(id, a.ID); !s.Waiting || !s.BgWaiting {
		t.Fatalf("before the turn of its own: %+v", s)
	}
	pa.emit(t, agent.Event{Kind: agent.EvThinking})
	if s := e.sub(id, a.ID); s.Waiting || s.BgWaiting || s.Status != model.SubRunning {
		t.Fatalf("in a turn of its own: %+v", s)
	}
	pa.emit(t, agent.Event{Kind: agent.EvText, Text: "the command printed a line"}, agent.Event{Kind: agent.EvTurnEnd, SelfBegun: true, Background: agent.Background{Running: 1}})
	e.m.handoffs.Wait()
	if s := e.sub(id, a.ID); s.Status != model.SubRunning || !s.Waiting || !s.BgWaiting {
		t.Fatalf("after the turn of its own: %+v", s)
	}
	if !hasText(e.subItems(id, a.ID), "the command printed a line") {
		t.Fatalf("the text of the turn is not in its thread: %+v", e.subItems(id, a.ID))
	}
	if agentClosed(pa) {
		t.Fatal("its process was closed")
	}
}

func TestSubagentFinishesAfterTheLastTurn(t *testing.T) {
	t.Parallel()
	e, id, a, parent, pa := bgSub(t, time.Hour)
	pa.emit(t, agent.Event{Kind: agent.EvText, Text: "started"}, subBgEnd(1, false))
	pa.emit(t, bgNow(1, true), bgNow(0, true), agent.Event{Kind: agent.EvThinking})
	pa.emit(t, agent.Event{Kind: agent.EvText, Text: "all done"}, subBgEnd(0, false))
	e.m.handoffs.Wait()
	s := e.sub(id, a.ID)
	if s.Status != model.SubCompleted || s.Waiting || s.BgWaiting || s.Last != "all done" || s.Ended == 0 {
		t.Fatalf("after the last turn: %+v", s)
	}
	closed(t, "its process", pa)
	if len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{a.ID}) {
		t.Fatalf("the chat's agent got %d messages", len(parent.sent()))
	}
	if msg := lastSend(t, parent); !strings.Contains(msg, "<report>all done</report>") || strings.Contains(msg, "started") {
		t.Fatalf("the result is not the last turn's text:\n%s", msg)
	}
}

func TestSubagentWaitsOnChildAndBackgroundEitherOrder(t *testing.T) {
	t.Parallel()
	t.Run("child first", func(t *testing.T) {
		t.Parallel()
		e, id, a, _, pa := bgSub(t, time.Hour)
		b, pb := e.child(id, a.ID, "one")
		pa.emit(t, subBgEnd(1, false))
		if s := e.sub(id, a.ID); !s.Waiting || !s.BgWaiting {
			t.Fatalf("waiting on both: %+v", s)
		}
		e.finish(pb, "report of b")
		if len(pa.sent()) != 2 || !reflect.DeepEqual(deliveredSids(pa.sent()[1]), []string{b.ID}) {
			t.Fatalf("the waiting subagent got %d messages", len(pa.sent()))
		}
		if s := e.sub(id, a.ID); s.Waiting || s.BgWaiting || s.Status != model.SubRunning {
			t.Fatalf("in the turn of the delivery: %+v", s)
		}
		pa.emit(t, agent.Event{Kind: agent.EvText, Text: "b says so"}, subBgEnd(1, false))
		e.m.handoffs.Wait()
		if s := e.sub(id, a.ID); s.Status != model.SubRunning || !s.Waiting || !s.BgWaiting || agentClosed(pa) {
			t.Fatalf("after the delivery's turn, with a command running: %+v", s)
		}
		pa.emit(t, agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvText, Text: "the end"}, subBgEnd(0, false))
		e.m.handoffs.Wait()
		if s := e.sub(id, a.ID); s.Status != model.SubCompleted || s.Last != "the end" {
			t.Fatalf("after the last turn: %+v", s)
		}
	})
	t.Run("background first", func(t *testing.T) {
		t.Parallel()
		e, id, a, _, pa := bgSub(t, time.Hour)
		b, pb := e.child(id, a.ID, "one")
		pa.emit(t, subBgEnd(1, false))
		pa.emit(t, agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvText, Text: "the command ended"}, subBgEnd(0, false))
		e.m.handoffs.Wait()
		if s := e.sub(id, a.ID); s.Status != model.SubRunning || !s.Waiting || s.BgWaiting {
			t.Fatalf("waiting on the child alone: %+v", s)
		}
		e.finish(pb, "report of b")
		if len(pa.sent()) != 2 || !reflect.DeepEqual(deliveredSids(pa.sent()[1]), []string{b.ID}) {
			t.Fatalf("the waiting subagent got %d messages", len(pa.sent()))
		}
		pa.emit(t, agent.Event{Kind: agent.EvText, Text: "with b"}, subBgEnd(0, false))
		e.m.handoffs.Wait()
		if s := e.sub(id, a.ID); s.Status != model.SubCompleted || s.Last != "with b" {
			t.Fatalf("after the delivery's turn: %+v", s)
		}
	})
}

func TestSubagentQuietWaitEndsAWaitWithNothingRunning(t *testing.T) {
	t.Parallel()
	t.Run("nothing follows", func(t *testing.T) {
		t.Parallel()
		e, id, a, parent, pa := bgSub(t, 50*time.Millisecond)
		pa.emit(t, agent.Event{Kind: agent.EvText, Text: "started"}, subBgEnd(1, false))
		pa.emit(t, bgNow(0, true))
		waitFor(t, "the subagent to finish after the quiet wait", func() bool { return e.sub(id, a.ID).Status != model.SubRunning })
		e.m.handoffs.Wait()
		if s := e.sub(id, a.ID); s.Status != model.SubCompleted || s.Waiting || s.BgWaiting || s.Last != "started" {
			t.Fatalf("after the quiet wait: %+v", s)
		}
		closed(t, "its process", pa)
		waitFor(t, "its result to go to the chat's agent", func() bool { return len(parent.sent()) == 2 })
		if msg := lastSend(t, parent); !strings.Contains(msg, "<report>started</report>") {
			t.Fatalf("the result lacks the last text:\n%s", msg)
		}
	})
	t.Run("a turn sign comes first", func(t *testing.T) {
		t.Parallel()
		const quiet = 100 * time.Millisecond
		e, id, a, _, pa := bgSub(t, quiet)
		pa.emit(t, subBgEnd(1, false), bgNow(0, true), agent.Event{Kind: agent.EvThinking})
		time.Sleep(4 * quiet)
		if s := e.sub(id, a.ID); s.Status != model.SubRunning || agentClosed(pa) {
			t.Fatalf("while the model thinks: %+v, closed %v", s, agentClosed(pa))
		}
		pa.emit(t, agent.Event{Kind: agent.EvText, Text: "read it"}, subBgEnd(0, false))
		e.m.handoffs.Wait()
		if s := e.sub(id, a.ID); s.Status != model.SubCompleted || s.Last != "read it" {
			t.Fatalf("after the turn: %+v", s)
		}
	})
}

func TestStoppingAWaitingSubagentClosesItsProcess(t *testing.T) {
	t.Parallel()
	e, id, a, _, pa := bgSub(t, time.Hour)
	pa.emit(t, subBgEnd(1, false))
	if s := e.sub(id, a.ID); !s.Waiting || !s.BgWaiting {
		t.Fatalf("before the stop: %+v", s)
	}
	if err := e.m.StopSubagent(id, a.ID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "its process closed", func() bool { return agentClosed(pa) })
	for name, s := range map[string]model.Subagent{"memory": e.sub(id, a.ID), "file": e.subFile(id, a.ID)} {
		if s.Status != model.SubStopped || s.Waiting || s.BgWaiting {
			t.Fatalf("after the stop, %s: %+v", name, s)
		}
	}
}

// Goal 6.5: an agent with no background work is finished by its clean turn end at once.
func TestSubagentWithoutBackgroundUnchanged(t *testing.T) {
	t.Parallel()
	e, id, a, parent, pa := bgSub(t, time.Hour)
	pa.emit(t, agent.Event{Kind: agent.EvText, Text: "done"}, subBgEnd(0, false))
	e.m.handoffs.Wait()
	if s := e.sub(id, a.ID); s.Status != model.SubCompleted || s.Waiting || s.BgWaiting || s.Last != "done" {
		t.Fatalf("after the turn: %+v", s)
	}
	closed(t, "its process", pa)
	if len(parent.sent()) != 2 {
		t.Fatalf("the chat's agent got %d messages", len(parent.sent()))
	}
}
