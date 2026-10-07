package runs

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
)

// engOneTask is a run without git whose first turn adds one reporting task; work answers the
// messages of its agent, T01-work.
func engOneTask(t *testing.T, mod func(m *model.RunMeta), work func(m *engMsg)) (*engEnv, *run) {
	t.Helper()
	e := newEngEnv(t, false)
	r := e.run("r_agent", func(m *model.RunMeta) {
		m.Settings.Wake = "idle"
		if mod != nil {
			mod(m)
		}
	})
	e.play(r, func() { e.add(r, 1, "the job", false) }, func(m *engMsg) bool {
		if m.Name != "T01-work" {
			return false
		}
		work(m)
		return true
	})
	return e, r
}

func engLaunchErrors(a Agent) string {
	var out []string
	for _, l := range a.Launches {
		kind := "fresh"
		if l.Resume {
			kind = "resume"
		}
		out = append(out, fmt.Sprintf("%d %s %q", l.N, kind, l.Error))
	}
	return strings.Join(out, "; ")
}

// A clean turn without the block is asked once more for it, in the same launch.
func TestAgentRepairTurn(t *testing.T) {
	t.Parallel()
	e, r := engOneTask(t, nil, func(m *engMsg) {
		if m.N == 1 {
			m.Say("I did everything you asked. Anything else?")
			return
		}
		m.Block("completed", "Did it.", "The details.")
	})
	r.startEngine()
	engTask(t, r, "T01", model.TaskDone)
	sent := e.host.sent("T01-work")
	if len(sent) != 2 || sent[1].Text != engRepairMessage || sent[1].Fresh {
		t.Fatalf("messages to the agent: %d", len(sent))
	}
	if !strings.HasPrefix(sent[0].Text, "You are one of the agents of an automated build run.") || sent[0].Resumed {
		t.Errorf("the first message: %q", sent[0].Text[:60])
	}
	a, _ := r.engAgentNamed("T01-work")
	if a.Status != model.AgentDone || len(a.Launches) != 1 || a.Failures != 0 || !a.Resumable {
		t.Errorf("agent: %+v", a)
	}
	if at := r.engLast(t, "T01"); at.Result.Summary != "Did it." || at.Result.ReportSize != len("The details.") {
		t.Errorf("result: %+v", at.Result)
	}
}

// After the second repair turn without a block the agent fails for good: no further launch.
func TestAgentTwoMissesFail(t *testing.T) {
	t.Parallel()
	e, r := engOneTask(t, nil, func(m *engMsg) { m.Say("Still thinking about it.") })
	r.startEngine()
	engTask(t, r, "T01", model.TaskFailed)
	sent := e.host.sent("T01-work")
	if len(sent) != 3 || sent[1].Text != engRepairMessage || sent[2].Text != engRepairMessage {
		t.Fatalf("%d messages to the agent", len(sent))
	}
	a, _ := r.engAgentNamed("T01-work")
	if a.Status != model.AgentFailed || a.Error != "finished without the result block" || len(a.Launches) != 1 ||
		a.Launches[0].Error != "finished without the result block" || a.EndedAt == 0 {
		t.Errorf("agent: %+v", a)
	}
	at := r.engLast(t, "T01")
	if at.Error != "agent T01-work failed: finished without the result block" || at.Result != nil {
		t.Errorf("attempt: %+v", at)
	}
	if ev := r.engState().Inbox; len(r.engTurns()) < 2 && (len(ev) != 1 || ev[0].Type != "task_failed") {
		t.Errorf("inbox: %+v", ev)
	}
}

// A turn that ended with an error is never repaired and its text is never read as a result,
// even when it holds a whole block: the launch is a counted failure, and the next launch resumes
// the session with the resume message.
func TestAgentNoRepairAfterAnError(t *testing.T) {
	t.Parallel()
	block := agenttest.Block("completed", "Looks finished.", "But the turn broke.")
	e, r := engOneTask(t, nil, func(m *engMsg) {
		if m.N == 1 {
			m.Fail("API error: overloaded", block)
			return
		}
		m.Block("completed", "Really finished.", "r")
	})
	r.startEngine()
	engUntil(t, "the failed launch", func() bool { a, _ := r.engAgentNamed("T01-work"); return a.Failures == 1 })
	a, _ := r.engAgentNamed("T01-work")
	if a.Status != model.AgentRunning || a.Launches[0].Error != "API error: overloaded" || a.RetryAt != e.clock.Now().UnixMilli()+30_000 {
		t.Errorf("agent after the failure: %+v (now %d)", a, e.clock.Now().UnixMilli())
	}
	if r.engLast(t, "T01").WorkDone {
		t.Fatal("the block of an errored turn was taken as the result")
	}
	// The failed launch's process was ended before the backoff.
	if got := e.host.stoppedNames(); len(got) == 0 || got[len(got)-1] != "T01-work" {
		t.Errorf("stopped: %v", got)
	}
	e.clock.Advance(29 * time.Second)
	time.Sleep(30 * time.Millisecond)
	if n := len(e.host.sent("T01-work")); n != 1 {
		t.Fatalf("%d messages before the backoff was over", n)
	}
	e.clock.Advance(time.Second)
	engTask(t, r, "T01", model.TaskDone)
	sent := e.host.sent("T01-work")
	if len(sent) != 2 || !sent[1].Resumed || sent[1].Fresh || !strings.HasPrefix(sent[1].Text, "Your previous run of this job stopped before it finished") ||
		!strings.Contains(sent[1].Text, "\n\n---\n\n"+sent[0].Text) {
		t.Errorf("the second message is not the resume message with the instructions in full")
	}
	a, _ = r.engAgentNamed("T01-work")
	if got := engLaunchErrors(a); got != `1 fresh "API error: overloaded"; 2 resume ""` || a.Failures != 0 || a.RetryAt != 0 {
		t.Errorf("launches: %s; failures %d", got, a.Failures)
	}
	if s := r.engLast(t, "T01").Result.Summary; s != "Really finished." {
		t.Errorf("summary: %q", s)
	}
}

// A launch has one deadline, on the service's clock. A timed-out agent is stopped and counted
// as failed once, and resumed after the backoff.
func TestAgentTimeoutFakeHost(t *testing.T) {
	t.Parallel()
	e, r := engOneTask(t, func(m *model.RunMeta) { m.Settings.AgentTimeoutSec = 3600 }, func(m *engMsg) {
		if m.N == 1 {
			m.Hang()
			return
		}
		m.Block("completed", "ok", "r")
	})
	r.startEngine()
	engUntil(t, "the first message", func() bool { return len(e.host.sent("T01-work")) == 1 })
	e.clock.Advance(59 * time.Minute)
	time.Sleep(30 * time.Millisecond)
	if a, _ := r.engAgentNamed("T01-work"); a.Failures != 0 {
		t.Fatal("the agent timed out early")
	}
	e.clock.Advance(time.Minute)
	engUntil(t, "the timeout", func() bool { a, _ := r.engAgentNamed("T01-work"); return a.Failures == 1 })
	a, _ := r.engAgentNamed("T01-work")
	if a.Launches[0].Error != "timed out after 1h00m" || a.Launches[0].EndedAt == 0 {
		t.Errorf("the launch: %+v", a.Launches[0])
	}
	e.clock.Advance(30 * time.Second)
	engTask(t, r, "T01", model.TaskDone)
	if sent := e.host.sent("T01-work"); len(sent) != 2 || !sent[1].Resumed {
		t.Errorf("after the timeout: %d messages", len(sent))
	}
}

// Counted failures back off by 30·n² seconds. The count and the time of the next launch are
// recorded, so a restart neither forgets failures nor shortens the wait; one failure more than
// the retries fails the agent and its task.
func TestAgentBackoffSurvivesRestart(t *testing.T) {
	t.Parallel()
	e, r := engOneTask(t, nil, func(m *engMsg) { m.Exit("exit status 1") })
	r.startEngine()
	t0 := e.clock.Now().UnixMilli()
	engUntil(t, "the first failure", func() bool { a, _ := r.engAgentNamed("T01-work"); return a.Failures == 1 })
	if a, _ := r.engAgentNamed("T01-work"); a.RetryAt != t0+30_000 || a.Launches[0].Error != "exit status 1" {
		t.Fatalf("after one failure: %+v", a)
	}
	e.clock.Advance(10 * time.Second)

	// The server goes away during the backoff and comes back.
	r = e.restart("r_agent")
	e.play(r, nil, func(m *engMsg) bool { m.Exit(""); return true })
	e.s.Boot()
	if st := r.engState(); st.Status != model.RunStopped || st.Reason != engReasonCrash {
		t.Fatalf("after the crash: %+v", st)
	}
	if a, _ := r.engAgentNamed("T01-work"); a.Failures != 1 || a.RetryAt != t0+30_000 || a.Status != model.AgentInterrupted {
		t.Fatalf("the agent after the restart: %+v", a)
	}
	if err := r.resume(); err != nil {
		t.Fatal(err)
	}
	e.clock.Advance(19 * time.Second)
	time.Sleep(40 * time.Millisecond)
	if n := len(e.host.sent("T01-work")); n != 0 {
		t.Fatalf("the agent was launched %d time(s) before its backoff was over", n)
	}
	e.clock.Advance(time.Second)
	t1 := e.clock.Now().UnixMilli()
	engUntil(t, "the second failure", func() bool { a, _ := r.engAgentNamed("T01-work"); return a.Failures == 2 })
	a, _ := r.engAgentNamed("T01-work")
	if a.RetryAt != t1+120_000 || a.Launches[1].Error != "the agent's process ended" {
		t.Errorf("after two failures: %+v", a)
	}
	e.clock.Advance(2 * time.Minute)
	engTask(t, r, "T01", model.TaskFailed)
	a, _ = r.engAgentNamed("T01-work")
	if a.Status != model.AgentFailed || a.Failures != 3 || len(a.Launches) != 3 || a.Error != "the agent's process ended" {
		t.Errorf("the failed agent: %+v", a)
	}
	if at := r.engLast(t, "T01"); at.Error != "agent T01-work failed: the agent's process ended" {
		t.Errorf("attempt error: %q", at.Error)
	}
	// Launch 1 started a session, so the later ones resumed it.
	if got := engLaunchErrors(a); got != `1 fresh "exit status 1"; 2 resume "the agent's process ended"; 3 resume "the agent's process ended"` {
		t.Errorf("launches: %s", got)
	}
}

// "No session", by the send's error (Cursor, pi) and by the turn's end (Claude), is one outcome:
// the launch is not counted as a failure and the next one starts a new session with the first
// message and the retry note.
func TestAgentNoSession(t *testing.T) {
	t.Parallel()
	for _, how := range []string{"send error", "turn end"} {
		e, r := engOneTask(t, nil, func(m *engMsg) {
			switch {
			case m.N == 1:
				m.Hang()
			case m.Resumed && how == "turn end":
				m.NoSession()
			default:
				m.Block("completed", "ok", "r")
			}
		})
		if how == "send error" {
			e.host.refuse = func(m *engMsg) error {
				if m.Name == "T01-work" && m.Resumed {
					return fmt.Errorf("session/load: %w", agent.NoSession("Session not found"))
				}
				return nil
			}
		}
		r.startEngine()
		// The stop comes once the engine has recorded that the message was taken: a stop between
		// the chat's taking it and that record leaves an agent that is started fresh, which is not
		// what this test is about.
		engUntil(t, "the first message", func() bool {
			a, _ := r.engAgentNamed("T01-work")
			return len(e.host.sent("T01-work")) == 1 && a.Resumable
		})
		if err := r.halt(Halting{Status: model.RunStopped, Reason: "stopped by the user", Stop: model.StopUser}); err != nil {
			t.Fatal(err)
		}
		engStatus(t, r, model.RunStopped)
		if a, _ := r.engAgentNamed("T01-work"); a.Status != model.AgentInterrupted || !a.Resumable || a.Launches[0].Error != "" || a.Launches[0].EndedAt == 0 {
			t.Fatalf("%s: the stopped agent: %+v", how, a)
		}
		if err := r.resume(); err != nil {
			t.Fatal(err)
		}
		engTask(t, r, "T01", model.TaskDone)
		a, _ := r.engAgentNamed("T01-work")
		if got := engLaunchErrors(a); got != `1 fresh ""; 2 resume "no session"; 3 fresh ""` || a.Failures != 0 {
			t.Errorf("%s: launches: %s; failures %d", how, got, a.Failures)
		}
		sent := e.host.sent("T01-work")
		last := sent[len(sent)-1]
		if !last.Fresh || last.Resumed || !strings.HasPrefix(last.Text, "You are one of the agents") ||
			!strings.HasSuffix(last.Text, "look at the files and build on whatever is sound.") {
			t.Errorf("%s: the launch after \"no session\" is not a fresh start with the retry note: fresh %v, %q", how, last.Fresh, last.Text[len(last.Text)-80:])
		}
		if how == "turn end" && (len(sent) != 3 || !strings.HasPrefix(sent[1].Text, "Your previous run of this job stopped")) {
			t.Errorf("%s: %d messages", how, len(sent))
		}
		r.stopEngine(10 * time.Second)
	}
}

// An agent whose turn ended with a whole block, but whose result was not recorded before the
// run stopped, is not taken at its word after the restart: it is resumed and answers again.
func TestAgentNoShortcutAfterRestart(t *testing.T) {
	t.Parallel()
	e, r := engOneTask(t, nil, func(m *engMsg) {
		if m.N == 1 {
			m.Hang()
			return
		}
		m.Block("completed", "The second answer.", "r")
	})
	r.startEngine()
	engUntil(t, "the first message", func() bool { // taken, and recorded as taken
		a, _ := r.engAgentNamed("T01-work")
		return len(e.host.sent("T01-work")) == 1 && a.Resumable
	})
	r = e.restart("r_agent")
	// What the chat holds now looks like a finished turn.
	c := e.host.chats[AgentChatID(r.id, "T01-work")]
	c.text = agenttest.Block("completed", "The first answer, never recorded.", "r")
	e.play(r, nil, func(m *engMsg) bool {
		if m.Name == "T01-work" {
			m.Block("completed", "The second answer.", "r")
			return true
		}
		return false
	})
	e.s.Boot()
	if err := r.resume(); err != nil {
		t.Fatal(err)
	}
	engTask(t, r, "T01", model.TaskDone)
	sent := e.host.sent("T01-work")
	if len(sent) != 1 || !sent[0].Resumed || !strings.HasPrefix(sent[0].Text, "Your previous run of this job stopped") {
		t.Fatalf("after the restart the agent got %d message(s)", len(sent))
	}
	if s := r.engLast(t, "T01").Result.Summary; s != "The second answer." {
		t.Errorf("summary: %q", s)
	}
}

// A stop during an agent's turn: the worker ends the agent's process, records it as interrupted
// with its cost and returns; the task stays as it is, and run_halted is one entry.
func TestAgentStopDuringAWait(t *testing.T) {
	t.Parallel()
	e, r := engOneTask(t, nil, func(m *engMsg) {
		if m.N == 1 {
			e_ := m.h
			e_.setCost(m.ID, 0.25)
			m.Hang()
			return
		}
		m.h.setCost(m.ID, 0.75)
		m.Block("completed", "ok", "r")
	})
	r.startEngine()
	// The message is taken before the agent's script runs: the stop waits for the turn to be under
	// way (its cost so far is set), or it would find an agent that has reported nothing.
	engUntil(t, "the first message", func() bool {
		c, _ := e.host.CostOf(AgentChatID(r.id, "T01-work"))
		return len(e.host.sent("T01-work")) == 1 && c.Known
	})
	if err := r.halt(Halting{Status: model.RunStopped, Reason: "stopped by the user", Stop: model.StopUser}); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunStopped)
	a, _ := r.engAgentNamed("T01-work")
	if a.Status != model.AgentInterrupted || a.Cost == nil || *a.Cost != 0.25 || a.Launches[0].EndedAt == 0 || a.Launches[0].Error != "" || a.Failures != 0 {
		t.Errorf("the stopped agent: %+v", a)
	}
	if s := r.engTaskState("T01"); s != model.TaskWork {
		t.Errorf("the task of a stopped run is %s", s)
	}
	if got := e.host.stoppedNames(); len(got) != 2 || got[1] != "T01-work" { // turn-001 when it ended, then the stop
		t.Errorf("stopped: %v", got)
	}
	ks := engKinds(t, r)
	if engCount(ks, KRunHalted) != 1 || engCount(ks, KRunStopping) != 1 || ks[len(ks)-1] != KRunHalted {
		t.Errorf("entries: %v", ks)
	}
	st := r.engState()
	if st.Reason != "stopped by the user" || st.Halting != nil || len(r.L.Stops) != 1 || r.L.Stops[0].Reason != model.StopUser || r.L.Stops[0].ResumedAt != 0 {
		t.Errorf("state %+v, stops %+v", st, r.L.Stops)
	}
	if r.engHasEngine() || !e.s.eng.wait(r, 5*time.Second) {
		t.Error("an engine goroutine is left after the halt")
	}
	// Resumed, the agent goes on in its session; its cost is the chat's total, not a sum.
	if err := r.resume(); err != nil {
		t.Fatal(err)
	}
	engTask(t, r, "T01", model.TaskDone)
	a, _ = r.engAgentNamed("T01-work")
	if a.Cost == nil || *a.Cost != 0.75 || a.Status != model.AgentDone {
		t.Errorf("the agent after the resume: %+v", a)
	}
	if at := r.engLast(t, "T01"); at.Cost == nil || *at.Cost != 0.75 {
		t.Errorf("the attempt's cost: %v", at.Cost)
	}
	if sent := e.host.sent("T01-work"); len(sent) != 2 || !sent[1].Resumed {
		t.Errorf("%d messages", len(sent))
	}
}

// cancel_task of a task whose agent works: the agent ends cancelled, the attempt ends cancelled
// with the reason, no event is made, and the tool gets no refusal.
func TestAgentCancelDuringAWait(t *testing.T) {
	t.Parallel()
	e, r := engOneTask(t, nil, func(m *engMsg) { m.Hang() })
	r.startEngine()
	engUntil(t, "the first message", func() bool { return len(e.host.sent("T01-work")) == 1 })
	if got := r.cancelActive("T01", model.AttemptCancel{Reason: "not needed", Chat: "c1"}); got != "" {
		t.Fatalf("cancelActive: %q", got)
	}
	at := r.engLast(t, "T01")
	if at.Outcome != model.TaskCancelled || at.Cancel == nil || at.Cancel.Reason != "not needed" || at.Cancel.Chat != "c1" || at.Cancel.T == 0 ||
		at.EndedAt == 0 || at.Error != "" {
		t.Errorf("attempt: %+v", at)
	}
	a, _ := r.engAgentNamed("T01-work")
	if a.Status != model.AgentCancelled || a.EndedAt == 0 || a.Launches[0].Error != "" {
		t.Errorf("agent: %+v", a)
	}
	// The run goes on: with nothing left it gets an idle turn, and no event tells of the cancel.
	engUntil(t, "the idle turn", func() bool { ts := r.engTurns(); return len(ts) >= 2 && ts[1].Status == "done" })
	if tn := r.engTurns()[1]; tn.Reason != "idle" || len(tn.WokenBy) != 0 {
		t.Errorf("turn 2: %+v", tn)
	}
	if got := r.cancelActive("T01", model.AttemptCancel{Reason: "again"}); got != "T01 is cancelled now; look again with get_run" {
		t.Errorf("a second cancel: %q", got)
	}
}

// A stop reaches a worker wherever it waits: in the backoff sleep, and in a send that the
// adapter does not answer (the process is closed, which makes the send return).
func TestAgentStopInBackoffAndInSend(t *testing.T) {
	t.Parallel()
	e, r := engOneTask(t, nil, func(m *engMsg) { m.Exit("boom") })
	r.startEngine()
	engUntil(t, "the failure", func() bool { a, _ := r.engAgentNamed("T01-work"); return a.Failures == 1 })
	if err := r.halt(Halting{Status: model.RunStopped, Stop: model.StopUser}); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunStopped)
	if a, _ := r.engAgentNamed("T01-work"); a.Status != model.AgentInterrupted || a.Failures != 1 || a.RetryAt == 0 {
		t.Errorf("the agent stopped in its backoff: %+v", a)
	}
	r.stopEngine(10 * time.Second)

	e, r = engOneTask(t, nil, func(m *engMsg) { m.Block("completed", "ok", "r") })
	gate := make(chan struct{})
	e.host.refuse = func(m *engMsg) error {
		if m.Name == "turn-001" {
			e.host.mu.Lock()
			e.host.gate = gate // from now on every send hangs in the adapter
			e.host.mu.Unlock()
		}
		return nil
	}
	r.startEngine()
	engTask(t, r, "T01", model.TaskWork)
	engUntil(t, "the launch", func() bool { a, _ := r.engAgentNamed("T01-work"); return len(a.Launches) == 1 })
	time.Sleep(20 * time.Millisecond)
	if err := r.halt(Halting{Status: model.RunStopped, Stop: model.StopUser}); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunStopped)
	a, _ := r.engAgentNamed("T01-work")
	if a.Status != model.AgentInterrupted || a.Failures != 0 || a.Launches[0].Error != "" || a.Resumable {
		t.Errorf("the agent stopped in its send: %+v", a)
	}
	if n := len(e.host.sent("T01-work")); n != 0 {
		t.Errorf("%d messages were accepted", n)
	}
	close(gate)
}

// An agent that started a turn by itself answers the engine's next message with "busy": the
// engine waits for that turn and sends again, and counts nothing.
func TestAgentBusyOnRepair(t *testing.T) {
	t.Parallel()
	busy := 0
	e, r := engOneTask(t, nil, func(m *engMsg) {
		if m.N == 1 {
			m.Say("no block yet")
			return
		}
		m.Block("completed", "ok", "r")
	})
	e.host.refuse = func(m *engMsg) error {
		if m.Name == "T01-work" && m.Text == engRepairMessage && busy == 0 {
			busy++
			return chats.ErrBusy
		}
		return nil
	}
	r.startEngine()
	engTask(t, r, "T01", model.TaskDone)
	a, _ := r.engAgentNamed("T01-work")
	if busy != 1 || a.Failures != 0 || len(a.Launches) != 1 || a.Status != model.AgentDone {
		t.Errorf("busy %d, agent %+v", busy, a)
	}
}

// A send the adapter refuses for another reason is a counted failure; with no session made, the
// next launch is a fresh start with the retry note.
func TestAgentSendRefused(t *testing.T) {
	t.Parallel()
	refused := 0
	e, r := engOneTask(t, nil, func(m *engMsg) { m.Block("completed", "ok", "r") })
	e.host.refuse = func(m *engMsg) error {
		if m.Name == "T01-work" && refused == 0 {
			refused++
			return errors.New("the agent's program could not be started")
		}
		return nil
	}
	r.startEngine()
	engUntil(t, "the failure", func() bool { a, _ := r.engAgentNamed("T01-work"); return a.Failures == 1 })
	e.clock.Advance(30 * time.Second)
	engTask(t, r, "T01", model.TaskDone)
	a, _ := r.engAgentNamed("T01-work")
	if got := engLaunchErrors(a); got != `1 fresh "the agent's program could not be started"; 2 fresh ""` {
		t.Errorf("launches: %s", got)
	}
	sent := e.host.sent("T01-work")
	if len(sent) != 1 || !sent[0].Fresh || !strings.Contains(sent[0].Text, "Note: an earlier attempt at this job did not finish.") {
		t.Errorf("the launch after a refused send: %d messages", len(sent))
	}
}

// A message the agent's chat accepted at the moment the server shuts down is recorded as sent:
// with the result there and the context ended at once, the result is taken whichever of the two
// the wait sees first. (Then launch records the session, and the next server resumes it instead
// of sending the message again.)
func TestSendTakesAResultThatIsThereAtAShutdown(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_agent", nil)
	quit := make(chan struct{})
	close(quit)
	eng := &engine{r: r, quit: quit}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	stopsBefore := len(e.host.stoppedNames())
	for _, want := range []error{nil, chats.ErrShutdown} {
		// Many times: the wait picks between the two at random.
		for i := range 200 {
			errc := make(chan error, 1)
			errc <- want
			if err := eng.sent(ctx, "T01-work", errc); err != want {
				t.Fatalf("round %d: the result %v was there, the answer is %v", i, want, err)
			}
		}
	}
	// No result for engStopGrace: the answer is the context's, and no process is closed.
	if err := eng.sent(ctx, "T01-work", make(chan error, 1)); !errors.Is(err, context.Canceled) {
		t.Fatalf("with no result: %v", err)
	}
	if n := len(e.host.stoppedNames()); n != stopsBefore {
		t.Fatalf("%d agent process(es) closed at a shutdown", n-stopsBefore)
	}
}

// At a shutdown SendOwned may still be inside the chat manager: its result, which comes a
// moment later, is the answer, so an accepted message is not sent again by the next server.
func TestSendWaitsForAResultThatComesJustAfterAShutdown(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_agent", nil)
	quit := make(chan struct{})
	close(quit)
	eng := &engine{r: r, quit: quit}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	stopsBefore := len(e.host.stoppedNames())
	for _, want := range []error{nil, chats.ErrShutdown} {
		errc := make(chan error, 1)
		time.AfterFunc(20*time.Millisecond, func() { errc <- want })
		if err := eng.sent(ctx, "T01-work", errc); err != want {
			t.Fatalf("the result %v came 20 ms after the call, the answer is %v", want, err)
		}
	}
	if n := len(e.host.stoppedNames()); n != stopsBefore {
		t.Fatalf("%d agent process(es) closed at a shutdown", n-stopsBefore)
	}
}
