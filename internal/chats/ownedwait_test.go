package chats

// The settled state of a run agent's chat: SendOwned, WaitOwned, StopOwned.

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// ---- a manager that knows a run ---------------------------------------------

const ownRun = "r_one"

// fakeRuns is the RunOwner of the tests.
type fakeRuns struct {
	mu   sync.Mutex
	runs map[string]RunInfo
}

func (f *fakeRuns) RunOf(id string) (RunInfo, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ri, ok := f.runs[id]
	return ri, ok
}

func (f *fakeRuns) ChatContext(id string) string {
	return "<run-context>the state of " + id + "</run-context>"
}

func (f *fakeRuns) set(id string, ri RunInfo) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.runs[id] = ri
}

func (f *fakeRuns) drop(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.runs, id)
}

// runEnv is an env whose manager knows the run ownRun: in group gOne, in the folder e.cwd.
func runEnv(t *testing.T) (*env, *fakeRuns) {
	t.Helper()
	e := newEnv(t)
	fr := &fakeRuns{runs: map[string]RunInfo{ownRun: {Group: gOne, Cwd: e.cwd, Agent: model.Claude, Model: "sonnet", Effort: "high"}}}
	e.m.Runs = fr
	return e, fr
}

// reboot is boot for a manager that knows runs.
func (e *env) reboot(fr *fakeRuns) {
	e.t.Helper()
	e.boot()
	e.m.Runs = fr
}

// agentChat makes the chat of a run agent of ownRun, with the id id.
func (e *env) agentChat(id string, role model.AgentRole, kind model.AgentKind) string {
	e.t.Helper()
	modelID := map[model.AgentKind]string{model.Claude: "sonnet", model.Cursor: "composer-2", model.Pi: "pi-model"}[kind]
	created, err := e.m.CreateOwned(OwnedSpec{ID: id, Run: ownRun, Role: role, Name: id, Agent: kind, Model: modelID, Cwd: e.cwd})
	if err != nil || !created {
		e.t.Fatalf("CreateOwned %s: created %v, %v", id, created, err)
	}
	return id
}

func (e *env) sendOwned(id, text string) {
	e.t.Helper()
	if err := e.m.SendOwned(id, text, OwnedSend{}); err != nil {
		e.t.Fatalf("SendOwned: %v", err)
	}
}

// ownAnswer is what a WaitOwned returned.
type ownAnswer struct {
	s   Settled
	err error
}

// waitOwned starts WaitOwned on a goroutine and returns a channel with its answer.
func (e *env) waitOwned(id string) <-chan ownAnswer {
	ch := make(chan ownAnswer, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		s, err := e.m.WaitOwned(ctx, id)
		ch <- ownAnswer{s, err}
	}()
	return ch
}

func ownNotYet(t *testing.T, ch <-chan ownAnswer, when string) {
	t.Helper()
	select {
	case a := <-ch:
		t.Fatalf("settled too early (%s): %+v %v", when, a.s, a.err)
	case <-time.After(40 * time.Millisecond):
	}
}

func ownGot(t *testing.T, ch <-chan ownAnswer) Settled {
	t.Helper()
	select {
	case a := <-ch:
		if a.err != nil {
			t.Fatalf("WaitOwned: %v", a.err)
		}
		return a.s
	case <-time.After(5 * time.Second):
		t.Fatal("WaitOwned did not return")
	}
	return Settled{}
}

func ownErr(t *testing.T, ch <-chan ownAnswer) error {
	t.Helper()
	select {
	case a := <-ch:
		if a.err == nil {
			t.Fatalf("WaitOwned settled: %+v", a.s)
		}
		return a.err
	case <-time.After(5 * time.Second):
		t.Fatal("WaitOwned did not return")
	}
	return nil
}

func ownText(s string, point string) []agent.Event {
	return []agent.Event{{Kind: agent.EvText, Text: s}, {Kind: agent.EvTurnEnd, Point: point}}
}

// ownChild spawns one app subagent on the chat, as the MCP call does, and returns its process.
func (e *env) ownChild(id, prompt string) (model.Subagent, *fakeAgent) {
	e.t.Helper()
	before := e.claude.count()
	sa := e.spawn(id, SpawnSubRequest{Prompt: prompt, Description: prompt})
	return sa, waitChild(e.t, e.claude, before+1)
}

// ownStart is a task agent's chat that was sent its brief: its process and a WaitOwned on it.
func ownStart(t *testing.T) (*env, string, *fakeAgent, <-chan ownAnswer) {
	t.Helper()
	e, _ := runEnv(t)
	id := e.agentChat("agent-1", model.RoleTask, model.Claude)
	if _, err := e.m.WaitOwned(context.Background(), id); !errors.Is(err, ErrNothingSent) {
		t.Fatalf("WaitOwned before any SendOwned: %v", err)
	}
	e.sendOwned(id, "the brief")
	return e, id, e.claude.last(t), e.waitOwned(id)
}

// ---- the thirteen cases of the spike, against WaitOwned ----------------------

func TestSettledPlainTurnAndATurnWithoutText(t *testing.T) {
	e, id, ag, w := ownStart(t)
	ownNotYet(t, w, "mid-turn")
	if err := e.m.SendOwned(id, "too early", OwnedSend{}); !errors.Is(err, ErrBusy) {
		t.Fatalf("SendOwned in the turn: %v", err)
	}
	ag.emit(t, ownText("first answer", "p1")...)
	s := ownGot(t, w)
	if s.Outcome != EndClean || s.Text != "first answer" || s.Turns != 1 || s.From != 0 || s.To != 3 || s.NoSession || s.Error != "" {
		t.Fatalf("%+v", s)
	}
	// Asked again, the chat is as it was, and so is the answer.
	if again, err := e.m.WaitOwned(context.Background(), id); err != nil || again != s {
		t.Fatalf("second WaitOwned: %+v %v", again, err)
	}
	// A turn that writes no text: Text is empty, not the older turn's text.
	e.sendOwned(id, "again")
	w = e.waitOwned(id)
	ag.emit(t, agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Bash"},
		agent.Event{Kind: agent.EvToolResult, ToolID: "t1", Result: "ok"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p2"})
	s = ownGot(t, w)
	if s.Outcome != EndClean || s.Text != "" || s.From != 3 || s.Turns != 1 {
		t.Fatalf("%+v", s)
	}
	if e.claude.count() != 1 {
		t.Fatalf("%d processes for two messages", e.claude.count())
	}
}

func TestSettledSubagentStillRunningAtTheTurnEnd(t *testing.T) {
	e, id, ag, w := ownStart(t)
	_, child := e.ownChild(id, "child work")
	ag.emit(t, ownText("spawned, waiting", "p1")...)
	ownNotYet(t, w, "the subagent runs")
	if e.m.Idle(id) {
		t.Fatal("idle while a subagent runs")
	}
	child.emit(t, ownText("child report", "")...)
	waitFor(t, "the delivery", func() bool { return len(ag.sent()) == 2 })
	ownNotYet(t, w, "the results are being delivered")
	ag.emit(t, ownText("final <result>x</result>", "p2")...)
	s := ownGot(t, w)
	if s.Outcome != EndClean || s.Text != "final <result>x</result>" || s.Turns != 2 || s.Owed != 0 {
		t.Fatalf("%+v", s)
	}
	if v := e.view(id); v.SubsRunning != 0 || v.SubsOwed != 0 {
		t.Fatalf("view: %+v", v)
	}
	if !e.m.Idle(id) {
		t.Fatal("not idle once settled")
	}
}

func TestSettledSubagentEndsDuringTheTurn(t *testing.T) {
	e, id, ag, w := ownStart(t)
	_, child := e.ownChild(id, "child work")
	child.emit(t, ownText("child report", "")...)
	if v := e.view(id); v.SubsOwed != 1 {
		t.Fatalf("owed: %+v", v)
	}
	ag.emit(t, ownText("spawned", "p1")...) // turnOver delivers in the same hold of the lock
	waitFor(t, "the delivery", func() bool { return len(ag.sent()) == 2 })
	ownNotYet(t, w, "the results are being delivered")
	ag.emit(t, ownText("final", "p2")...)
	if s := ownGot(t, w); s.Outcome != EndClean || s.Text != "final" || s.Turns != 2 {
		t.Fatalf("%+v", s)
	}
}

func TestSettledTwoSubagentsTwoDeliveries(t *testing.T) {
	e, id, ag, w := ownStart(t)
	_, c1 := e.ownChild(id, "one")
	_, c2 := e.ownChild(id, "two")
	ag.emit(t, ownText("spawned two", "p1")...)
	c1.emit(t, ownText("r1", "")...)
	waitFor(t, "delivery 1", func() bool { return len(ag.sent()) == 2 })
	c2.emit(t, ownText("r2", "")...) // owed while the first delivery's turn runs
	ag.emit(t, ownText("got one", "p2")...)
	waitFor(t, "delivery 2", func() bool { return len(ag.sent()) == 3 })
	ownNotYet(t, w, "the second delivery")
	ag.emit(t, ownText("got both", "p3")...)
	if s := ownGot(t, w); s.Outcome != EndClean || s.Text != "got both" || s.Turns != 3 {
		t.Fatalf("%+v", s)
	}
}

func TestSettledErrorThenTheEngineRetries(t *testing.T) {
	e, id, ag, w := ownStart(t)
	ag.emit(t, agent.Event{Kind: agent.EvText, Text: "partial"}, agent.Event{Kind: agent.EvTurnEnd, Error: "overloaded"})
	s := ownGot(t, w)
	if s.Outcome != EndError || s.Error != "overloaded" || s.Text != "partial" {
		t.Fatalf("%+v", s)
	}
	// The chat is held, but the engine's own message is what releases a hold.
	e.sendOwned(id, "continue")
	w = e.waitOwned(id)
	ag.emit(t, ownText("done now", "p2")...)
	if s := ownGot(t, w); s.Outcome != EndClean || s.Text != "done now" || s.Error != "" {
		t.Fatalf("%+v", s)
	}
}

func TestSettledErrorWhileASubagentRunsLeavesItsResultOwed(t *testing.T) {
	e, id, ag, w := ownStart(t)
	_, child := e.ownChild(id, "child work")
	ag.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "overloaded"})
	ownNotYet(t, w, "the subagent still runs")
	child.emit(t, ownText("child report", "")...)
	s := ownGot(t, w)
	if s.Outcome != EndError || s.Owed != 1 {
		t.Fatalf("%+v", s)
	}
	if len(ag.sent()) != 1 {
		t.Fatal("a held chat was sent the results")
	}
	// The engine's next message carries the owed result.
	e.sendOwned(id, "continue")
	w = e.waitOwned(id)
	last := ag.sent()[1]
	if len(last) != 2 || !strings.Contains(last[0].Text, "<subagent-results>") || !strings.Contains(last[0].Text, "child report") {
		t.Fatalf("the retry message: %q", texts(last))
	}
	ag.emit(t, ownText("done", "p2")...)
	if s := ownGot(t, w); s.Outcome != EndClean || s.Owed != 0 {
		t.Fatalf("%+v", s)
	}
}

// The engine's stop of a running turn: the turn is interrupted, StopOwned waits for it to end, and
// only then is the process closed.
func TestSettledStopOwnedInterruptsARunningTurn(t *testing.T) {
	e, id, ag, w := ownStart(t)
	_, child := e.ownChild(id, "child work")
	stopped := make(chan struct{})
	go func() { e.m.StopOwned(id, 5*time.Second); close(stopped) }()
	waitFor(t, "the interrupt", func() bool { return ag.interrupted() >= 1 })
	waitFor(t, "the child's close", child.isClosed)
	ownNotYet(t, w, "the aborted turn end has not come")
	select {
	case <-stopped:
		t.Fatal("StopOwned did not wait for the turn to end")
	default:
	}
	if ag.isClosed() {
		t.Fatal("the process was closed before its turn ended")
	}
	ag.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true, CostUSD: 0.02, HasCost: true, OutTokens: 5, CumOutTokens: 5})
	<-stopped
	s := ownGot(t, w)
	if s.Outcome != EndAborted || s.Owed != 0 || s.Turns != 1 {
		t.Fatalf("%+v", s)
	}
	waitFor(t, "the process's close", ag.isClosed)
	// The turn ended before the close, so its cost was reported. What the subagent spent is in
	// no report: it was stopped in its one turn.
	if c, err := e.m.CostOf(id); err != nil || !c.Known || !c.Partial || c.USD != 0.02 {
		t.Fatalf("cost after an orderly stop: %+v %v", c, err)
	}
	if st, _ := e.m.OwnedState(id); st.HasProcess || st.WasActive || !st.Locked {
		t.Fatalf("state after StopOwned: %+v", st)
	}
}

// An agent that does not end its turn when it is interrupted is closed when the grace is over.
func TestStopOwnedGraceEnds(t *testing.T) {
	e, id, ag, w := ownStart(t)
	start := time.Now()
	e.m.StopOwned(id, 60*time.Millisecond)
	if d := time.Since(start); d < 60*time.Millisecond || d > 2*time.Second {
		t.Fatalf("StopOwned took %v", d)
	}
	if s := ownGot(t, w); s.Outcome != EndAborted || s.Error != "stopped" {
		t.Fatalf("%+v", s)
	}
	waitFor(t, "the process's close", ag.isClosed)
	if ag.interrupted() < 1 {
		t.Fatal("the turn was not interrupted")
	}
	// The process was closed in its turn: what the turn spent is in no report.
	if c, _ := e.m.CostOf(id); !c.Partial {
		t.Fatalf("cost after a process closed in its turn: %+v", c)
	}
}

func TestSettledStopWhileOnlySubagentsRun(t *testing.T) {
	e, id, ag, w := ownStart(t)
	_, child := e.ownChild(id, "child work")
	ag.emit(t, ownText("spawned", "p1")...)
	ownNotYet(t, w, "the subagent runs")
	e.m.StopOwned(id, time.Second) // no turn runs: nothing to wait for
	if s := ownGot(t, w); s.Outcome != EndAborted || s.Text != "spawned" || s.Owed != 0 {
		t.Fatalf("%+v", s)
	}
	waitFor(t, "the child's close", child.isClosed)
	waitFor(t, "the process's close", ag.isClosed)
	if ag.interrupted() != 1 { // only the one that goes with the close
		t.Fatalf("%d interrupts for an agent with no turn running", ag.interrupted())
	}
}

func TestSettledProcessExitMidTurn(t *testing.T) {
	e, id, ag, w := ownStart(t)
	_, child := e.ownChild(id, "child work")
	ag.emit(t, agent.Event{Kind: agent.EvText, Text: "working"})
	ag.emit(t, agent.Event{Kind: agent.EvExit, ExitErr: "signal: killed"})
	close(ag.ch)
	s := ownGot(t, w)
	if s.Outcome != EndExit || s.Error != "signal: killed" || s.Text != "working" || s.Turns != 0 {
		t.Fatalf("%+v", s)
	}
	waitFor(t, "the child's close", child.isClosed)
	if st, _ := e.m.OwnedState(id); st.HasProcess || st.WasActive || !st.Exists {
		t.Fatalf("state after the exit: %+v", st)
	}
	if e.m.TurnRunning(id) {
		t.Fatal("a turn runs on a chat without a process")
	}
}

func TestSettledProcessExitWhileWaitingForASubagent(t *testing.T) {
	e, id, ag, w := ownStart(t)
	e.ownChild(id, "child work")
	ag.emit(t, ownText("spawned", "p1")...)
	ownNotYet(t, w, "the subagent runs")
	ag.exit(t)
	if s := ownGot(t, w); s.Outcome != EndExit || s.Text != "spawned" {
		t.Fatalf("%+v", s)
	}
}

func TestSettledSelfStartedTurnBeforeTheChatSettled(t *testing.T) {
	e, id, ag, w := ownStart(t)
	_, child := e.ownChild(id, "child work")
	ag.emit(t, ownText("spawned", "p1")...)
	ag.emit(t, agent.Event{Kind: agent.EvThinking}) // the agent starts a turn of its own
	if !e.m.TurnRunning(id) {
		t.Fatal("a turn the agent started itself does not count as running")
	}
	child.emit(t, ownText("child report", "")...) // owed: the chat is busy
	ownNotYet(t, w, "the agent's own turn runs")
	ag.emit(t, ownText("background thing done", "p2")...)
	waitFor(t, "the delivery", func() bool { return len(ag.sent()) == 2 })
	ag.emit(t, ownText("final", "p3")...)
	if s := ownGot(t, w); s.Outcome != EndClean || s.Text != "final" || s.Turns != 3 {
		t.Fatalf("%+v", s)
	}
}

// Changed from the spike: a turn the agent starts by itself after the chat settled is waited for,
// because the answer is computed from the chat as it is.
func TestSettledSelfStartedTurnAfterTheChatSettled(t *testing.T) {
	e, id, ag, w := ownStart(t)
	ag.emit(t, ownText("answer", "p1")...)
	if s := ownGot(t, w); s.Text != "answer" || s.To != 3 {
		t.Fatalf("%+v", s)
	}
	ag.emit(t, agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvTextStart}, agent.Event{Kind: agent.EvTextDelta, Text: "one more thing"})
	w = e.waitOwned(id)
	ownNotYet(t, w, "the agent's own turn runs")
	if err := e.m.SendOwned(id, "next", OwnedSend{}); !errors.Is(err, ErrBusy) {
		t.Fatalf("SendOwned in a self-started turn: %v", err)
	}
	ag.emit(t, agent.Event{Kind: agent.EvTurnEnd, Point: "p2"})
	want := Settled{Outcome: EndClean, Text: "one more thing", From: 0, To: 5, Turns: 2}
	if s := ownGot(t, w); s != want {
		t.Fatalf("%+v, want %+v", s, want)
	}
}

// Changed from the spike: a chat deleted while it is waited for answers ErrNotFound.
func TestSettledStopMidTurnDeleteWhileWaitingASecondSend(t *testing.T) {
	e, id, ag, w := ownStart(t)
	e.m.StopOwned(id, 0)
	if s := ownGot(t, w); s.Outcome != EndAborted || s.Error != "stopped" {
		t.Fatalf("%+v", s)
	}
	waitFor(t, "the process's close", ag.isClosed)
	if ag.interrupted() != 1 {
		t.Fatalf("%d interrupts: with no grace only the one that goes with the close", ag.interrupted())
	}
	e.sendOwned(id, "again") // a resume
	w = e.waitOwned(id)
	ag2 := e.claude.last(t)
	if ag2 == ag || !ag2.opts.Resume || !ag2.opts.NeedHistory || ag2.opts.SessionID != ag.opts.SessionID {
		t.Fatalf("the process after a stop: %+v", ag2.opts)
	}
	ag2.emit(t, ownText("r", "p1")...)
	ownGot(t, w)
	e.sendOwned(id, "third")
	w = e.waitOwned(id)
	ownNotYet(t, w, "mid-turn")
	if err := e.m.DeleteOwned(id); err != nil {
		t.Fatal(err)
	}
	if err := ownErr(t, w); !errors.Is(err, ErrNotFound) {
		t.Fatalf("WaitOwned across a delete: %v", err)
	}
	if _, err := e.m.WaitOwned(context.Background(), id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("WaitOwned on a deleted chat: %v", err)
	}
	if err := e.m.SendOwned(id, "x", OwnedSend{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SendOwned on a deleted chat: %v", err)
	}
	waitFor(t, "the process's close", ag2.isClosed)
}

// ---- the errors of WaitOwned --------------------------------------------------

func TestWaitOwnedSuperseded(t *testing.T) {
	e, id, ag, w := ownStart(t)
	// The turn ends with an error while a subagent runs: not settled, and not busy either.
	e.ownChild(id, "child work")
	ag.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "overloaded"})
	ownNotYet(t, w, "the subagent runs")
	e.sendOwned(id, "another message")
	if err := ownErr(t, w); !errors.Is(err, ErrSuperseded) {
		t.Fatalf("the first WaitOwned: %v", err)
	}
	// The new message has a wait of its own.
	w = e.waitOwned(id)
	ownNotYet(t, w, "the second turn runs")
}

func TestWaitOwnedErrors(t *testing.T) {
	e, _ := runEnv(t)
	if _, err := e.m.WaitOwned(context.Background(), "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an unknown chat: %v", err)
	}
	// A person's chat is not the engine's to wait on.
	v := e.create(model.Claude, gOne, "")
	if _, err := e.m.WaitOwned(context.Background(), v.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a person's chat: %v", err)
	}
	if err := e.m.SendOwned(v.ID, "x", OwnedSend{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SendOwned to a person's chat: %v", err)
	}
	id := e.agentChat("agent-1", model.RoleTask, model.Claude)
	e.sendOwned(id, "work")
	ctx, cancel := context.WithCancel(context.Background())
	res := make(chan error, 1)
	go func() { _, err := e.m.WaitOwned(ctx, id); res <- err }()
	select {
	case err := <-res:
		t.Fatalf("WaitOwned returned in the turn: %v", err)
	case <-time.After(40 * time.Millisecond):
	}
	cancel()
	select {
	case err := <-res:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("a cancelled wait: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a cancelled WaitOwned did not return")
	}
}

// A change that wakes nobody is seen by the backstop: at most its period late, never a hang.
func TestWaitOwnedBackstop(t *testing.T) {
	e, id, _, w := ownStart(t)
	ownNotYet(t, w, "mid-turn")
	c, _ := e.m.get(id)
	c.mu.Lock()
	c.wait.end = EndClean
	c.tr.SetStatus(model.StatusReady) // the turn "ended" on a path that forgot the wake
	c.mu.Unlock()
	start := time.Now()
	if s := ownGot(t, w); s.Outcome != EndClean {
		t.Fatalf("%+v", s)
	}
	if d := time.Since(start); d > 2*waitBackstop+time.Second {
		t.Fatalf("the backstop took %v", d)
	}
}

// ---- where the settled state is written ---------------------------------------

// A process that goes away while the chat rests after a clean turn changes nothing of how that
// turn ended.
func TestSettledExitWhileIdleStaysClean(t *testing.T) {
	e, id, ag, w := ownStart(t)
	ag.emit(t, ownText("the answer", "p1")...)
	s := ownGot(t, w)
	ag.emit(t, agent.Event{Kind: agent.EvExit, ExitErr: "a warning on stderr"})
	close(ag.ch)
	again, err := e.m.WaitOwned(context.Background(), id)
	if err != nil || again != s || again.Outcome != EndClean {
		t.Fatalf("after an idle exit: %+v %v, was %+v", again, err, s)
	}
	if st, _ := e.m.OwnedState(id); st.HasProcess || st.Text != "the answer" {
		t.Fatalf("state: %+v", st)
	}
	if c, _ := e.m.CostOf(id); c.Partial {
		t.Fatalf("an idle exit lost a cost: %+v", c)
	}
}

// Claude's "no session": a turn end that says so, then the exit. The exit must not hide it.
func TestSettledNoSessionSurvivesTheExit(t *testing.T) {
	_, _, ag, w := ownStart(t)
	text := "No conversation found with session ID: x"
	ag.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: text, NoSession: true})
	ag.emit(t, agent.Event{Kind: agent.EvExit, ExitErr: text})
	close(ag.ch)
	s := ownGot(t, w)
	if !s.NoSession || s.Outcome != EndError || s.Error != text {
		t.Fatalf("%+v", s)
	}
}

// A start that fails leaves the wait of the message before as it was.
func TestSendOwnedFailedStartKeepsTheWait(t *testing.T) {
	e, _ := runEnv(t)
	cwd := t.TempDir() + "/work"
	if err := os.Mkdir(cwd, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.CreateOwned(OwnedSpec{ID: "agent-1", Run: ownRun, Role: model.RoleTask, Agent: model.Claude, Model: "sonnet", Cwd: cwd}); err != nil {
		t.Fatal(err)
	}
	id := "agent-1"
	e.sendOwned(id, "the brief")
	ag := e.claude.last(t)
	ag.emit(t, ownText("the answer", "p1")...)
	s, err := e.m.WaitOwned(context.Background(), id)
	if err != nil || s.Outcome != EndClean {
		t.Fatalf("%+v %v", s, err)
	}
	e.m.StopOwned(id, 0)
	if err := os.Remove(cwd); err != nil {
		t.Fatal(err)
	}
	if err := e.m.SendOwned(id, "more", OwnedSend{}); !errors.Is(err, ErrFolderMissing) {
		t.Fatalf("SendOwned with the folder gone: %v", err)
	}
	if e.m.Busy(id) || e.m.TurnRunning(id) {
		t.Fatal("the chat is busy after a start that failed")
	}
	after, err := e.m.WaitOwned(context.Background(), id)
	if err != nil || after.From != s.From || after.Text != "the answer" {
		t.Fatalf("the wait after a failed start: %+v %v (was %+v)", after, err, s)
	}
	if n := len(e.items(id)); n != s.To {
		t.Fatalf("a failed start added to the thread: %d items, were %d", n, s.To)
	}
}

// ---- a message the adapter refuses ---------------------------------------------

// Whatever an adapter's Send answers, the chat is left not busy and without a process, so the
// next SendOwned is not refused as busy for ever.
func TestSendOwnedRefusedLeavesTheChatFree(t *testing.T) {
	e, id, ag, w := ownStart(t)
	ag.emit(t, ownText("the answer", "p1")...)
	ownGot(t, w)
	ag.failSends(errors.New("the adapter says no"))
	err := e.m.SendOwned(id, "more", OwnedSend{})
	if err == nil || err.Error() != "the adapter says no" {
		t.Fatalf("SendOwned: %v", err)
	}
	if e.m.Busy(id) || e.m.TurnRunning(id) {
		t.Fatal("the chat is busy after a refused message")
	}
	if st, _ := e.m.OwnedState(id); st.HasProcess {
		t.Fatalf("a process is left: %+v", st)
	}
	waitFor(t, "the process's close", ag.isClosed)
	// The next message starts a process and is taken.
	e.sendOwned(id, "once more")
	ag2 := e.claude.last(t)
	if ag2 == ag || !ag2.opts.Resume {
		t.Fatalf("no new process after a refusal: %+v", ag2.opts)
	}
	w = e.waitOwned(id)
	ag2.emit(t, ownText("fine", "p2")...)
	if s := ownGot(t, w); s.Outcome != EndClean || s.Text != "fine" {
		t.Fatalf("%+v", s)
	}
}

// stuckAgent is a process whose Send waits until the process is closed, as Cursor's does for a
// handshake that never comes, and whose Close waits for release, as Cursor's does for a process
// whose children hold its output.
type stuckAgent struct {
	*fakeAgent
	sending chan struct{} // closed when a Send waits
	closing chan struct{} // closed by Close
	release chan struct{} // closed by the test: Close returns
	once    sync.Once
	closed  sync.Once
}

func (a *stuckAgent) Send(b []agent.ContentBlock) error {
	a.once.Do(func() { close(a.sending) })
	<-a.closing
	return errors.New("the process was closed")
}

func (a *stuckAgent) Close() {
	a.closed.Do(func() { close(a.closing) })
	<-a.release
	a.fakeAgent.Close()
}

type stuckSpawner struct {
	inner *fakeSpawner
	mu    sync.Mutex
	last  *stuckAgent
}

func (s *stuckSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	ag, err := s.inner.Spawn(o)
	if err != nil {
		return nil, err
	}
	a := &stuckAgent{fakeAgent: ag.(*fakeAgent), sending: make(chan struct{}), closing: make(chan struct{}), release: make(chan struct{})}
	s.mu.Lock()
	s.last = a
	s.mu.Unlock()
	return a, nil
}

// StopOwned reaches a SendOwned that is inside the adapter, and neither it nor the manager waits
// for an adapter's Close that does not return.
func TestStopOwnedReachesASendInFlightAndNeverWaitsForClose(t *testing.T) {
	e, _ := runEnv(t)
	sp := &stuckSpawner{inner: e.cursor}
	e.m.Spawners[model.Cursor] = sp
	id := e.agentChat("agent-1", model.RoleTask, model.Cursor)
	sent := make(chan error, 1)
	go func() { sent <- e.m.SendOwned(id, "the brief", OwnedSend{}) }()
	waitFor(t, "the process", func() bool { sp.mu.Lock(); defer sp.mu.Unlock(); return sp.last != nil })
	sp.mu.Lock()
	ag := sp.last
	sp.mu.Unlock()
	<-ag.sending
	if !e.m.TurnRunning(id) {
		t.Fatal("no turn runs while the message is with the adapter")
	}
	done := make(chan struct{})
	go func() { e.m.StopOwned(id, 0); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("StopOwned waited for a Close that does not return")
	}
	select {
	case err := <-sent:
		if err == nil || errors.Is(err, ErrBusy) {
			t.Fatalf("the SendOwned that was stopped: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the SendOwned in flight did not return")
	}
	// The manager is not held up by the Close that still waits: the chat answers, and what the
	// closing process still says is taken from it and dropped.
	if e.m.Busy(id) || e.m.TurnRunning(id) {
		t.Fatal("the chat is busy after StopOwned")
	}
	ag.emit(t, agent.Event{Kind: agent.EvText, Text: "a late word"}, agent.Event{Kind: agent.EvExit, ExitErr: "exit status 143"})
	if items := e.items(id); kindsOf(items) != "user note" || items[1].Text != "Stopped." {
		t.Fatalf("items: %s", kindsOf(items))
	}
	// The exit error of a process the manager closed itself is not a failure of the chat.
	s, err := e.m.WaitOwned(context.Background(), id)
	if err != nil || s.Outcome != EndAborted || s.Error != "stopped" {
		t.Fatalf("after the stop: %+v %v", s, err)
	}
	if v := e.view(id); v.Status != model.StatusReady || v.Error != "" {
		t.Fatalf("view: %+v", v)
	}
	close(ag.release)
	waitFor(t, "the close to return", ag.isClosed)
}

// Shutdown closes the processes of the runs' agents through their adapters, interrupt first, and
// does not go on before those closes have returned; a Close that never returns holds it up no
// longer than its limit. The process of a person's chat is closed without waiting, as before.
func TestShutdownClosesRunAgentsThroughTheirAdapters(t *testing.T) {
	e, _ := runEnv(t)
	log := &loggingSpawner{inner: e.claude}
	e.m.Spawners[model.Claude] = log
	id := e.agentChat("agent-1", model.RoleTask, model.Claude)
	e.sendOwned(id, "the brief")
	ag := log.last(t)
	_, child := e.ownChild(id, "child work")
	e.m.Shutdown()
	// Shutdown has returned: the closes are done, not merely started.
	if got := strings.Join(ag.ended(), ","); got != "interrupt,close" {
		t.Fatalf("the run agent's process at Shutdown: %s", got)
	}
	if !child.isClosed() {
		t.Fatal("the run agent's subagent was not closed when Shutdown returned")
	}
	if m := e.runMeta(id, true); !m.TurnActive {
		t.Fatal("Shutdown cleared the running turn's mark")
	}

	// A Close that never returns.
	e2, _ := runEnv(t)
	sp := &stuckSpawner{inner: e2.cursor}
	e2.m.Spawners[model.Cursor] = sp
	id2 := e2.agentChat("agent-2", model.RoleOrchestrator, model.Cursor)
	sent := make(chan error, 1)
	go func() { sent <- e2.m.SendOwned(id2, "the brief", OwnedSend{}) }()
	waitFor(t, "the process", func() bool { sp.mu.Lock(); defer sp.mu.Unlock(); return sp.last != nil })
	start := time.Now()
	e2.m.Shutdown()
	if d := time.Since(start); d < ownedCloseWait || d > ownedCloseWait+2*time.Second {
		t.Fatalf("Shutdown with a Close that does not return took %v", d)
	}
	<-sent // the message in flight was let go by the close
	sp.mu.Lock()
	close(sp.last.release)
	sp.mu.Unlock()
}
