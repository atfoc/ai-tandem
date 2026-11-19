package chats

import (
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

type queueSteerer struct {
	*fakeAgent
	entered chan string
	release chan struct{}
	reject  bool
}

func (a *queueSteerer) Steer(id string, _ []agent.ContentBlock) error {
	a.entered <- id
	if a.release != nil {
		<-a.release
	}
	if a.reject {
		return agent.ErrSteerUnavailable
	}
	a.ch <- agent.Event{Kind: agent.EvSteerConsumed, MsgID: id}
	return nil
}
func installQueueSteerer(t *testing.T, e *env, id string, a *fakeAgent, reject bool) *queueSteerer {
	t.Helper()
	s := &queueSteerer{fakeAgent: a, entered: make(chan string, 1), reject: reject}
	c, _, err := e.m.lockBranch(id, "")
	if err != nil {
		t.Fatal(err)
	}
	c.ag = s
	c.mu.Unlock()
	return s
}
func queuePrompt(t *testing.T, e *env, id, delivery, text string) {
	t.Helper()
	if _, err := e.m.SubmitPrompt(id, "", delivery, Message{Text: text}); err != nil {
		t.Fatal(err)
	}
}
func TestPendingQueueFIFOAndDraft(t *testing.T) {
	e := newEnv(t)
	id, a := e.startSpawnParent()
	queuePrompt(t, e, id, QueueDelivery, "first")
	queuePrompt(t, e, id, QueueDelivery, "second")
	e.saveDraft(id, "", model.Draft{Text: "later draft"})
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	waitFor(t, "first queued prompt", func() bool { return len(a.sent()) == 2 })
	if got := texts(a.sent()[1]); got[len(got)-1] != "first" {
		t.Fatalf("first send: %v", got)
	}
	if d := e.view(id).Draft; d == nil || d.Text != "later draft" {
		t.Fatalf("draft after dequeue: %+v", d)
	}
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	waitFor(t, "second queued prompt", func() bool { return len(a.sent()) == 3 })
	if got := texts(a.sent()[2]); got[len(got)-1] != "second" {
		t.Fatalf("second send: %v", got)
	}
}
func TestSteerKeepsRunningSubagent(t *testing.T) {
	e := newEnv(t)
	id, parent, _, running, child := e.pendingParent()
	s := installQueueSteerer(t, e, id, parent, false)
	s.release = make(chan struct{})
	parent.emit(t, agent.Event{Kind: agent.EvToolStart, ToolID: "running-tool", ToolName: "Bash"})
	queuePrompt(t, e, id, SteerDelivery, "adjust")
	<-s.entered
	if e.view(id).PendingPrompts == nil {
		t.Fatal("steer disappeared before the provider confirmed pickup")
	}
	parent.emit(t, agent.Event{Kind: agent.EvToolResult, ToolID: "running-tool", Result: "finished"})
	close(s.release)
	waitFor(t, "steer consumption", func() bool { return e.view(id).PendingPrompts == nil })
	if parent.interrupted() != 0 || child.interrupted() != 0 || child.isClosed() {
		t.Fatal("steer interrupted an agent")
	}
	e.running("steer", id, running.ID, child)
	if len(parent.sent()) != 1 {
		t.Fatalf("steer started another turn: %d sends", len(parent.sent()))
	}
}

func TestPendingPromptSurvivesRestartWithImage(t *testing.T) {
	e := newEnv(t)
	id, _ := e.startSpawnParent()
	im := e.upload(id, "pending")
	if _, err := e.m.SubmitPrompt(id, "", QueueDelivery, Message{Text: "use the image", Images: []model.Image{im}}); err != nil {
		t.Fatal(err)
	}
	e.m.Shutdown()
	e.boot()
	v := e.view(id)
	if !v.QueuePaused || v.PendingPrompts == nil || len(*v.PendingPrompts) != 1 {
		t.Fatalf("queue after restart: %+v", v)
	}
	e.later(2 * time.Hour)
	e.m.cleanImages()
	if !e.holds(id, im.ID) {
		t.Fatal("queued image was swept after restart")
	}
	if err := e.m.ResumePrompts(id, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "resumed prompt", func() bool { return e.view(id).PendingPrompts == nil })
	items := e.items(id)
	last := items[len(items)-1]
	if last.Text != "use the image" || len(last.Images) != 1 || last.Images[0].ID != im.ID {
		t.Fatalf("resumed message: %+v", last)
	}
}
func TestSteerRejectedAfterCleanEndGoesBeforeQueue(t *testing.T) {
	e := newEnv(t)
	id, parent := e.startSpawnParent()
	s := installQueueSteerer(t, e, id, parent, true)
	s.release = make(chan struct{})
	queuePrompt(t, e, id, QueueDelivery, "ordinary")
	queuePrompt(t, e, id, SteerDelivery, "steer")
	<-s.entered
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	close(s.release)
	waitFor(t, "steer as next turn", func() bool { return len(parent.sent()) == 2 })
	if got := texts(parent.sent()[1]); got[len(got)-1] != "steer" {
		t.Fatalf("next send: %v", got)
	}
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	waitFor(t, "ordinary queued turn", func() bool { return len(parent.sent()) == 3 })
	if got := texts(parent.sent()[2]); got[len(got)-1] != "ordinary" {
		t.Fatalf("following send: %v", got)
	}
}
func TestStopPausesPendingQueue(t *testing.T) {
	e := newEnv(t)
	id, a := e.startSpawnParent()
	queuePrompt(t, e, id, QueueDelivery, "queued")
	if err := e.m.Interrupt(id); err != nil {
		t.Fatal(err)
	}
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
	if !e.view(id).QueuePaused || len(a.sent()) != 1 {
		t.Fatal("stop did not pause queue")
	}
	if err := e.m.ResumePrompts(id, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "resumed prompt", func() bool { return len(a.sent()) == 2 })
}

func TestQueuedPromptStaysOnItsBranch(t *testing.T) {
	e := newEnv(t)
	id, _ := e.branched(model.Claude, "", "")
	main, branch := e.bothRunning(id)
	e.send(id, "branch work", "")
	if _, err := e.m.SubmitPrompt(id, exBranch, QueueDelivery, Message{Text: "branch follow-up"}); err != nil {
		t.Fatal(err)
	}
	e.makeCurrent(id, model.MainBranch)
	branch.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	waitFor(t, "branch follow-up", func() bool { return len(branch.sent()) == 3 })
	if got := texts(branch.sent()[2]); got[len(got)-1] != "branch follow-up" {
		t.Fatalf("branch send: %v", got)
	}
	if len(main.sent()) != 1 {
		t.Fatalf("follow-up went to main: %d sends", len(main.sent()))
	}
}

func TestFailedTurnPausesPendingQueue(t *testing.T) {
	e := newEnv(t)
	id, a := e.startSpawnParent()
	queuePrompt(t, e, id, QueueDelivery, "queued")
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "provider failed"})
	if !e.view(id).QueuePaused || len(a.sent()) != 1 {
		t.Fatal("failed turn did not pause queue")
	}
}
