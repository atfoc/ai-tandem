package chats

import (
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// A pause in the family: what is owed to a paused subagent, what runs below it, and the parent
// that is told of it (nested.go).

// pauseAndTell pauses the subagent sid as the retry does when its attempts ran out and tells its
// parent (tellPaused). The subagent has the session it was spawned with, so the list holds it.
func pauseAndTell(e *env, id, sid string) {
	e.t.Helper()
	e.pauseByHand(id, sid, "Failed to authenticate", agent.TempLogin)
	var out outbox
	var aft after
	c, err := e.m.lock(id)
	if err != nil {
		e.t.Fatal(err)
	}
	e.m.tellPaused(c, c.subs[sid], &out, &aft)
	c.mu.Unlock()
	e.m.send(out)
	e.m.finish(c, &aft)
	e.m.handoffs.Wait()
}

// listedBy reports whether the subagent p has been listed the paused child k.
func (e *env) listedBy(id, p, k string) bool {
	e.t.Helper()
	c, err := e.m.lock(id)
	if err != nil {
		e.t.Fatal(err)
	}
	defer c.mu.Unlock()
	return c.subs[p].listed[k]
}

// Goal 3.3: what is owed to a paused subagent stays owed, also over a restart.
func TestPausedKeepsWhatIsOwedToIt(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(2)
	l, _ := e.child(id, "", "lead")
	k, pk := e.child(id, l.ID, "chunk")
	e.pauseByHand(id, l.ID, "Failed to authenticate", agent.TempLogin)
	e.finish(pk, "chunk report")
	if s := e.sub(id, k.ID); s.Status != model.SubCompleted || s.Delivery != model.SubOwed {
		t.Fatalf("the chunk that finished after the pause: %+v", s)
	}
	e.m.Shutdown()
	e.boot()
	if s := e.sub(id, k.ID); s.Delivery != model.SubOwed {
		t.Fatalf("the chunk after a restart: %+v", s)
	}
	if s := e.sub(id, l.ID); s.Status != model.SubPaused {
		t.Fatalf("the lead after a restart: %+v", s)
	}
}

// Goal 3.2: pausing a subagent does not stop what it started.
func TestPausingDoesNotStopChildren(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(2)
	l, pl := e.child(id, "", "lead")
	k, pk := e.child(id, l.ID, "chunk")
	e.pauseByHand(id, l.ID, "Failed to authenticate", agent.TempLogin)
	closed(t, "the paused lead's process", pl)
	if s := e.sub(id, k.ID); s.Status != model.SubRunning {
		t.Fatalf("the chunk of a paused lead: %+v", s)
	}
	if agentClosed(pk) || e.revoked(pk) {
		t.Fatalf("the chunk's process: closed %v, token revoked %v", agentClosed(pk), e.revoked(pk))
	}
}

// Goal 3.4: a paused subagent is not counted against the cap.
func TestPausedNotCountedInCap(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(2)
	e.limits(id, 2, 2)
	l, _ := e.child(id, "", "lead")
	e.child(id, l.ID, "chunk")
	e.pauseByHand(id, l.ID, "Failed to authenticate", agent.TempLogin)
	e.spawn(id, SpawnSubRequest{Prompt: "more"})
	c, err := e.m.lock(id)
	if err != nil {
		t.Fatal(err)
	}
	n := runningAppSubs(c)
	c.mu.Unlock()
	if n != 2 {
		t.Fatalf("%d running, want the chunk and the new one", n)
	}
}

// A subagent that ends takes the paused ones below it with it: nobody is left to resume them. A
// paused child that has a session (as every one the app starts has) is first listed to its parent
// (design D10): the parent's first clean end leaves it waiting and hands it the list, and only its
// end after that finishes it and stops the paused one below with cause parent.
func TestEndedSubagentStopsThosePausedBelow(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(3)
	p, pp := e.child(id, "", "parent")
	l, _ := e.child(id, p.ID, "lead")
	e.pauseByHand(id, l.ID, "Failed to authenticate", agent.TempLogin) // in a turn: no tell
	e.finish(pp, "done")
	if s := e.sub(id, p.ID); s.Status != model.SubRunning || s.Waiting || !e.listedBy(id, p.ID, l.ID) {
		t.Fatalf("the parent, handed the list of its paused child: %+v", s)
	}
	if s := e.sub(id, l.ID); s.Status != model.SubPaused {
		t.Fatalf("the paused one while its parent is told of it: %+v", s)
	}
	e.finish(pp, "done after the list")
	if s := e.sub(id, p.ID); s.Status != model.SubCompleted {
		t.Fatalf("the parent: %+v", s)
	}
	if s := e.sub(id, l.ID); s.Status != model.SubStopped || s.Cause != model.CauseParent {
		t.Fatalf("the paused one below it: %+v", s)
	}
}

// A parent that waits only on a paused child is told of it, once, and then finishes.
func TestWaitingParentToldOfPausedChild(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.nested(3)
	p, pp := e.child(id, "", "parent")
	l, pl := e.child(id, p.ID, "lead")
	e.finish(pp, "I started a lead")
	if s := e.sub(id, p.ID); !s.Waiting {
		t.Fatalf("the parent does not wait: %+v", s)
	}
	pauseAndTell(e, id, l.ID)
	closed(t, "the paused lead's process", pl)
	sent := pp.sent()
	if len(sent) != 2 || len(sent[1]) != 1 {
		t.Fatalf("the parent got %d messages, the last of %d blocks", len(sent), len(sent[len(sent)-1]))
	}
	c, _ := e.m.lock(id)
	want := pausedListBlock(pausedOrStopped(c, p.ID), false)
	c.mu.Unlock()
	if sent[1][0].Text != want || !strings.Contains(want, sidTag(l.ID)) || !strings.Contains(want, "<state>paused</state>") {
		t.Fatalf("the message to the parent:\n%s\nwant\n%s", sent[1][0].Text, want)
	}
	if !e.listedBy(id, p.ID, l.ID) {
		t.Fatal("the paused child is not marked as listed")
	}
	if s := e.sub(id, p.ID); s.Waiting || s.Status != model.SubRunning {
		t.Fatalf("the parent in the turn the list started: %+v", s)
	}

	e.finish(pp, "nothing more to do")
	if s := e.sub(id, p.ID); s.Status != model.SubCompleted || s.Delivery != model.SubSent {
		t.Fatalf("the parent after it was told: %+v", s)
	}
	if len(pp.sent()) != 2 {
		t.Fatalf("the parent got %d messages, want no second one", len(pp.sent()))
	}
	if len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{p.ID}) {
		t.Fatalf("the chat's agent got %d messages", len(parent.sent()))
	}
}

// A parent with children still running is not woken by a pause: the news rides on its next message.
func TestWaitingParentWithRunningChildrenNotWoken(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(3)
	p, pp := e.child(id, "", "parent")
	l, _ := e.child(id, p.ID, "lead")
	m, pm := e.child(id, p.ID, "other")
	e.finish(pp, "two started")
	pauseAndTell(e, id, l.ID)
	if len(pp.sent()) != 1 {
		t.Fatalf("the parent was woken: %d messages", len(pp.sent()))
	}
	e.finish(pm, "report of m")
	sent := pp.sent()
	if len(sent) != 2 || len(sent[1]) != 2 {
		t.Fatalf("the delivery: %d messages, the last of %d blocks", len(sent), len(sent[len(sent)-1]))
	}
	c, _ := e.m.lock(id)
	list := pausedListBlock(pausedOrStopped(c, p.ID), false)
	c.mu.Unlock()
	if !reflect.DeepEqual(deliveredSids(sent[1]), []string{m.ID}) || sent[1][1].Text != list || !strings.Contains(list, sidTag(l.ID)) {
		t.Fatalf("the delivery:\n%q", texts(sent[1]))
	}
}

// A clean end of a parent with a paused child it has not been told of leaves it waiting, and it is
// handed the list.
func TestCleanEndWithUnlistedPausedChildWaits(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(3)
	p, pp := e.child(id, "", "parent")
	l, _ := e.child(id, p.ID, "lead")
	e.pauseByHand(id, l.ID, "Failed to authenticate", agent.TempLogin) // in a turn: no tell
	e.finish(pp, "all I can do")
	sent := pp.sent()
	if s := e.sub(id, p.ID); s.Status != model.SubRunning || s.Waiting {
		t.Fatalf("the parent: %+v", s)
	}
	if len(sent) != 2 || len(sent[1]) != 1 || !strings.HasPrefix(sent[1][0].Text, "<"+pausedListTag+">") || !strings.Contains(sent[1][0].Text, sidTag(l.ID)) {
		t.Fatalf("the parent was handed %q", texts(sent[len(sent)-1]))
	}
}

// Scenario 11: with nothing paused or stopped, a delivery to a subagent is what it was.
func TestDeliverSubUnchangedWithNothingListed(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(2)
	p, pp := e.child(id, "", "parent")
	k, pk := e.child(id, p.ID, "chunk")
	e.finish(pp, "started")
	e.finish(pk, "report of k")
	sent := pp.sent()
	if len(sent) != 2 || len(sent[1]) != 1 {
		t.Fatalf("the delivery: %d messages, the last of %d blocks", len(sent), len(sent[len(sent)-1]))
	}
	want := resultsBlock([]model.Subagent{e.sub(id, k.ID)}, 0, false, true)
	if sent[1][0].Text != want {
		t.Fatalf("the delivery:\n%s\nwant\n%s", sent[1][0].Text, want)
	}
}

// A pi subagent handed only the list, whose turn ends cleanly with no model output, is not failed:
// the no-reply rule is for turns that carry results.
func TestPiNoticeWithoutReplyDoesNotFail(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(3)
	p := e.spawn(id, SpawnSubRequest{Prompt: "parent", Kind: model.Pi})
	pp := waitChild(t, e.pi, 1)
	l := e.spawn(id, SpawnSubRequest{Prompt: "lead", From: p.ID, Kind: model.Pi})
	waitChild(t, e.pi, 2)
	e.finish(pp, "started")
	pauseAndTell(e, id, l.ID)
	if sent := pp.sent(); len(sent) != 2 || len(sent[1]) != 1 || !strings.HasPrefix(sent[1][0].Text, "<"+pausedListTag+">") {
		t.Fatalf("the pi parent was handed %d messages", len(sent))
	}
	e.finish(pp, "") // a clean end, no model output
	if s := e.sub(id, p.ID); s.Status != model.SubCompleted || s.Error != "" {
		t.Fatalf("the pi parent: %+v", s)
	}
}
