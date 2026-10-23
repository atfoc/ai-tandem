package chats

import (
	"errors"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// pausedLead is a chat at depth 2 with a lead L that was paused by hand, and its process.
func (e *env) pausedLead() (id string, l model.Subagent, pl *fakeAgent) {
	e.t.Helper()
	id, _ = e.nested(2)
	l, pl = e.child(id, "", "lead")
	e.pauseByHand(id, l.ID, "Failed to authenticate", agent.TempLogin)
	closed(e.t, "the paused lead's process", pl)
	return id, l, pl
}

// The parent resumes a paused subagent: it starts again on its session with its own kind, model
// and effort and a new token, is running, and is sent the carry-on block first.
func TestResumePausedSubagent(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, l, pl := e.pausedLead()
	prev := e.sub(id, l.ID)

	sa, err := e.m.ResumeSubagent(id, l.ID)
	if err != nil {
		t.Fatal(err)
	}
	if sa.Status != model.SubRunning {
		t.Fatalf("the receipt: %+v", sa)
	}
	n := waitChild(t, e.claude, 3) // the chat's agent, the lead, the resumed process
	o := n.opts
	if !o.Resume || o.SessionID != l.Session || o.Model != l.Model || o.Effort != pl.opts.Effort || o.MCP == nil || o.MCP.Token == pl.opts.MCP.Token {
		t.Fatalf("the new spawn: %+v (old %+v)", o, pl.opts)
	}
	if !e.revoked(pl) || e.revoked(n) {
		t.Fatal("the old token must be revoked and the new one valid")
	}
	got := e.sub(id, l.ID)
	if got.Status != model.SubRunning || got.Ended != 0 || got.Delivery != "" || got.Error != "" || got.ErrorKind != "" ||
		got.Cause != "" || got.Retry != (model.Retry{}) || got.Session != l.Session {
		t.Fatalf("the record after the resume: %+v", got)
	}
	if f := e.subFile(id, l.ID); f != got {
		t.Fatalf("subagent.json %+v differs from %+v", f, got)
	}
	msg := n.sent()[0]
	if len(msg) != 1 || msg[0].Text != carryOnResumeBlock(prev) {
		t.Fatalf("the first message: %q", texts(msg))
	}
}

// What a paused subagent is owed goes with the message that resumes it.
func TestResumeCarriesOwedResults(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(2)
	l, pl := e.child(id, "", "lead")
	k, pk := e.child(id, l.ID, "chunk")
	e.pauseByHand(id, l.ID, "Failed to authenticate", agent.TempLogin)
	closed(t, "the lead's process", pl)
	e.finish(pk, "chunk report")

	if s := e.sub(id, k.ID); s.Delivery != model.SubOwed { // a paused parent keeps what is owed to it (D10)
		t.Fatalf("the chunk's result: %+v", s)
	}
	prev := e.sub(id, l.ID)

	if _, err := e.m.ResumeSubagent(id, l.ID); err != nil {
		t.Fatal(err)
	}
	n := waitChild(t, e.claude, 4)
	msg := n.sent()[0]
	if len(msg) != 2 || msg[0].Text != carryOnResumeBlock(prev) || !strings.HasPrefix(msg[1].Text, "<"+subResultsTag+">") ||
		len(deliveredSids(msg)) != 1 || deliveredSids(msg)[0] != k.ID {
		t.Fatalf("the resume message: %q", texts(msg))
	}
	if s := e.sub(id, k.ID); s.Delivery != model.SubSent {
		t.Fatalf("the delivered result: %+v", s)
	}
}

// A stopped subagent comes back alone: the subagents below it that were stopped with it start no
// process, and its message lists them (goal 4.6).
func TestResumeStoppedSubagentListsItsStoppedChildren(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(2)
	l, pl := e.child(id, "", "lead")
	k, pk := e.child(id, l.ID, "chunk")
	if err := e.m.Interrupt(id); err != nil {
		t.Fatal(err)
	}
	closed(t, "the stopped processes", pl, pk)
	if s := e.sub(id, k.ID); s.Status != model.SubStopped || s.Cause != model.CausePerson {
		t.Fatalf("the child: %+v", s)
	}

	if _, err := e.m.ResumeSubagent(id, l.ID); err != nil {
		t.Fatal(err)
	}
	n := waitChild(t, e.claude, 4)
	if e.claude.count() != 4 {
		t.Fatalf("%d processes: the child was started", e.claude.count())
	}
	msg := n.sent()[0]
	if len(msg) != 2 || !strings.HasPrefix(msg[0].Text, "<"+carryOnTag+">") || !strings.Contains(msg[0].Text, "You were stopped") {
		t.Fatalf("the resume message: %q", texts(msg))
	}
	list := msg[1].Text
	if !strings.HasPrefix(list, "<"+pausedListTag+">") || !strings.Contains(list, sidTag(k.ID)) ||
		!strings.Contains(list, "<why>the user stopped the chat's agent while it ran</why>") {
		t.Fatalf("the list: %s", list)
	}
	if s := e.sub(id, k.ID); s.Status != model.SubStopped {
		t.Fatalf("the child after the resume: %+v", s)
	}
}

// Every subagent that cannot be resumed is refused with a sentence of its own.
func TestResumeRefusals(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(2)
	run, _ := e.child(id, "", "running")
	retrying, _ := e.child(id, "", "retrying")
	done, pd := e.child(id, "", "completed")
	failed, pf := e.child(id, "", "failed")
	kid, _ := e.child(id, run.ID, "a child of running")
	e.finish(pd, "done")
	pf.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "boom"})
	e.m.handoffs.Wait()

	// Records of the other kinds, set by hand.
	base := model.Subagent{Parent: "", Kind: model.Claude, Status: model.SubStopped, Cause: model.CausePerson, Session: "s-1", Started: 1, Ended: 2}
	mk := func(sid string, f func(*model.Subagent)) {
		sa := base
		sa.ID = sid
		f(&sa)
		e.storeSub(id, sa)
	}
	mk("aaaaaaaaaaaa", func(sa *model.Subagent) { sa.Kind = "" })
	mk("bbbbbbbbbbbb", func(sa *model.Subagent) { sa.NotCarried = true })
	mk("cccccccccccc", func(sa *model.Subagent) { sa.Session = "" })
	e.m.Shutdown()
	e.boot()
	// After the restart nothing runs; put the running and retrying records back by hand.
	c, err := e.m.lock(id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.trOf(c, &outbox{}); err != nil {
		t.Fatal(err)
	}
	for _, sid := range []string{run.ID, retrying.ID} {
		c.subs[sid].meta.Status, c.subs[sid].meta.Ended = model.SubRunning, 0
	}
	c.subs[retrying.ID].retry = &retryWait{attempt: 2}
	c.subs[retrying.ID].meta.Retry = model.Retry{Attempt: 2, Of: 4}
	c.subs[done.ID].meta.Status = model.SubCompleted
	c.subs[failed.ID].meta.Status = model.SubFailed
	c.mu.Unlock()

	cases := []struct {
		name, by, sid, want string
	}{
		{"unknown", "", "zzzzzzzzzzzz", "no such subagent"},
		{"another's", "", kid.ID, "that subagent was not started by you: resume_subagent resumes only the subagents you started yourself"},
		{"native", "", "aaaaaaaaaaaa", "subagent aaaaaaaaaaaa was not started by the app: it cannot be resumed"},
		{"not carried", "", "bbbbbbbbbbbb", "subagent bbbbbbbbbbbb was not carried over into this chat: it cannot be resumed here"},
		{"running", "", run.ID, "subagent " + run.ID + " is running: only a paused or stopped subagent can be resumed"},
		{"retrying", "", retrying.ID, "subagent " + retrying.ID + " is running: it is being retried after a temporary error (attempt 2 of 4); only a paused or stopped subagent can be resumed"},
		{"completed", "", done.ID, "subagent " + done.ID + " has finished (completed): a finished subagent cannot be resumed; start a new one if more work is needed"},
		{"failed", "", failed.ID, "subagent " + failed.ID + " has finished (failed): a finished subagent cannot be resumed; start a new one if more work is needed"},
		{"no session", "", "cccccccccccc", "subagent cccccccccccc cannot be resumed: its session was not recorded (it was started before the app kept subagent sessions)"},
	}
	for _, tc := range cases {
		_, err := e.m.ResumeSubagentBy(id, tc.by, tc.sid)
		if err == nil || err.Error() != tc.want {
			t.Errorf("%s: %v, want %q", tc.name, err, tc.want)
		}
	}
	if !errors.Is(func() error { _, err := e.m.ResumeSubagentBy(id, "", kid.ID); return err }(), ErrNotStarterResume) {
		t.Error("another's: not ErrNotStarterResume")
	}
	if _, err := e.m.ResumeSubagentBy(id, "dddddddddddd", run.ID); err == nil || err.Error() != "the calling subagent has ended" {
		t.Errorf("a caller that is gone: %v", err)
	}
	if e.claude.count() != 0 {
		t.Fatalf("%d processes started by refused resumes", e.claude.count())
	}
}

// A resume that would take the chat over its cap is refused with the cap's sentence and starts
// nothing; the subagent stays paused.
func TestResumeOverTheCapRefused(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, l, _ := e.pausedLead()
	e.limits(id, 2, 1)
	e.child(id, "", "takes the only place")
	n := e.claude.count()

	_, err := e.m.ResumeSubagent(id, l.ID)
	want := "this chat's cap on running subagents is 1 and 1 are running, at every level: the subagent was not resumed and the resume is not queued. " +
		"End your turn to wait for a result of a subagent you started, stop one of yours with stop_subagent, or resume it later."
	var capErr *SubCapError
	if !errors.As(err, &capErr) || err.Error() != want {
		t.Fatalf("the refusal: %v", err)
	}
	if e.claude.count() != n || e.sub(id, l.ID).Status != model.SubPaused {
		t.Fatalf("a refused resume changed things: %d processes, %+v", e.claude.count(), e.sub(id, l.ID))
	}
}

func TestResumeRefusedWhenArchivedOrShuttingDown(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, l, _ := e.pausedLead()
	if err := e.m.SetArchive(id, model.Archive{Archived: true, Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.ResumeSubagent(id, l.ID); !errors.Is(err, ErrArchived) {
		t.Fatalf("archived: %v", err)
	}

	e2 := newEnv(t)
	id2, l2, _ := e2.pausedLead()
	e2.m.Shutdown()
	if _, err := e2.m.ResumeSubagent(id2, l2.ID); !errors.Is(err, ErrShutdown) {
		t.Fatalf("shutting down: %v", err)
	}
}

// A resume whose process cannot be started changes nothing: the subagent is paused as before.
func TestResumeStartFailureRestores(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, l, _ := e.pausedLead()
	before, memBefore := e.subFile(id, l.ID), e.sub(id, l.ID)
	gate := &gatedSpawner{inner: e.claude, enter: make(chan struct{}, 1), gate: make(chan struct{})}
	close(gate.gate)
	e.m.Spawners[model.Claude] = failingSpawner{gate}

	_, err := e.m.ResumeSubagent(id, l.ID)
	want := "subagent " + l.ID + " could not be started again: no such program; it is paused as before"
	if err == nil || err.Error() != want {
		t.Fatalf("the error: %v, want %q", err, want)
	}
	if got := e.sub(id, l.ID); got != memBefore {
		t.Fatalf("the record: %+v, was %+v", got, memBefore)
	}
	if got := e.subFile(id, l.ID); got != before {
		t.Fatalf("subagent.json: %+v, was %+v", got, before)
	}
}

// A resumed subagent finishes as any does, and its parent is handed its result once (goal 4.5).
func TestResumedSubagentReportsWhenItFinishes(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.nested(2)
	l, pl := e.child(id, "", "lead")
	e.pauseByHand(id, l.ID, "Failed to authenticate", agent.TempLogin)
	closed(t, "the lead's process", pl)

	if _, err := e.m.ResumeSubagent(id, l.ID); err != nil {
		t.Fatal(err)
	}
	n := waitChild(t, e.claude, 3)
	e.finish(n, "all done")
	if s := e.sub(id, l.ID); s.Status != model.SubCompleted || s.Delivery == "" || s.Last != "all done" {
		t.Fatalf("after its turn: %+v", s)
	}
	parent.emit(t) // let the parent's pump settle
	waitFor(t, "the result on the chat's agent", func() bool { return carriedTimes(parent.sent(), l.ID) == 1 })
}

// stop_subagent stops a paused subagent, what runs below it, and gives up what was owed to it.
func TestStopPausedSubagent(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(2)
	l, pl := e.child(id, "", "lead")
	k, pk := e.child(id, l.ID, "runs on")
	done, pd := e.child(id, l.ID, "finished")
	e.finish(pd, "early")
	e.pauseByHand(id, l.ID, "Failed to authenticate", agent.TempLogin)
	closed(t, "the lead's process", pl)
	if s := e.sub(id, k.ID); s.Status != model.SubRunning {
		t.Fatalf("a pause stopped its child: %+v", s)
	}

	if err := e.m.StopSubagent(id, l.ID); err != nil {
		t.Fatal(err)
	}
	if s := e.sub(id, l.ID); s.Status != model.SubStopped || s.Cause != model.CauseStopTool {
		t.Fatalf("the lead: %+v", s)
	}
	closed(t, "the child's process", pk)
	if s := e.sub(id, k.ID); s.Status != model.SubStopped {
		t.Fatalf("the child: %+v", s)
	}
	if s := e.sub(id, done.ID); s.Delivery != model.SubGivenUp {
		t.Fatalf("what was owed to the stopped one: %+v", s)
	}
}

// A subagent stopped by anything but its parent's request can be stopped again to leave the list.
func TestStopAgainTakesItOffTheList(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(2)
	l, pl := e.child(id, "", "lead")
	if err := e.m.Interrupt(id); err != nil {
		t.Fatal(err)
	}
	closed(t, "the lead's process", pl)

	c, _ := e.m.lock(id)
	listed := pausedOrStopped(c, "")
	c.mu.Unlock()
	if len(listed) != 1 || listed[0].ID != l.ID {
		t.Fatalf("before: %+v", listed)
	}
	if err := e.m.StopSubagent(id, l.ID); err != nil {
		t.Fatal(err)
	}
	c, _ = e.m.lock(id)
	listed = pausedOrStopped(c, "")
	c.mu.Unlock()
	if s := e.sub(id, l.ID); s.Status != model.SubStopped || s.Cause != model.CauseStopTool || len(listed) != 0 {
		t.Fatalf("after: %+v, listed %+v", s, listed)
	}
	if got := e.subFile(id, l.ID); got.Cause != model.CauseStopTool {
		t.Fatalf("subagent.json: %+v", got)
	}
}

// A copy of a chat resumes nothing: its records have no session, and a paused one is stopped and
// not carried over. The source's records are as they were.
func TestCopyDropsSessionsAndPaused(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.startSpawnParent()
	emitSpawnItem(t, parent, "t1", "mcp__board__spawn_subagent", `{"prompt":"will pause"}`)
	p := e.spawn(id, SpawnSubRequest{Prompt: "will pause"})
	pp := waitChild(t, e.claude, 2)
	emitSpawnItem(t, parent, "t2", "mcp__board__spawn_subagent", `{"prompt":"will stop"}`)
	s := e.spawn(id, SpawnSubRequest{Prompt: "will stop"})
	ps := waitChild(t, e.claude, 3)
	if p.Tool != "t1" || s.Tool != "t2" {
		t.Fatalf("not linked: %+v %+v", p, s)
	}
	parent.emit(t, agent.Event{Kind: agent.EvToolResult, ToolID: "t1", Result: "receipt"},
		agent.Event{Kind: agent.EvToolResult, ToolID: "t2", Result: "receipt"},
		agent.Event{Kind: agent.EvText, Text: "spawned"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
	e.pauseByHand(id, p.ID, "Failed to authenticate", agent.TempLogin)
	closed(t, "the paused one", pp)
	if err := e.m.StopSubagent(id, s.ID); err != nil {
		t.Fatal(err)
	}
	closed(t, "the stopped one", ps)

	f := e.fork(id, len(e.items(id)))
	for _, sid := range []string{p.ID, s.ID} {
		got := e.subOn(f.ID, sid)
		if got.Session != "" || got.Status != model.SubStopped || got.Retry != (model.Retry{}) {
			t.Fatalf("in the copy: %+v", got)
		}
	}
	if got := e.subOn(f.ID, p.ID); !got.NotCarried {
		t.Fatalf("the paused one in the copy: %+v", got)
	}
	if got := e.sub(id, p.ID); got.Status != model.SubPaused || got.Session != p.Session || got.NotCarried {
		t.Fatalf("the source's paused record: %+v", got)
	}
	if got := e.sub(id, s.ID); got.Session != s.Session {
		t.Fatalf("the source's stopped record: %+v", got)
	}
}
