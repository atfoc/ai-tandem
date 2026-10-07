package runs

import (
	"os"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

// A whole run without git: the first turn adds a reporting task, the task's agent reports, the
// second turn finishes the run.
func TestEngineRunEndToEndNoGit(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_e2e", nil)
	e.host.setOn(func(m *engMsg) {
		switch {
		case m.Name == "turn-001":
			e.add(r, 1, "Look around", false)
			m.Say("I added a task.")
		case m.Name == "T01-work":
			m.Block("completed", "Looked around.", "There is a README.")
		case m.Name == "turn-002":
			e.finishRun(r, 2, model.Achieved)
			m.Say("Finished.")
		}
	})
	r.startEngine()
	engStatus(t, r, model.RunCompleted)

	if got := strings.Join(e.host.names(), " "); got != "turn-001 T01-work turn-002" {
		t.Errorf("agents ran in the order %q", got)
	}
	ts := r.engTurns()
	if len(ts) != 2 || ts[0].Reason != "start" || !ts[0].Idle || ts[0].Status != "done" || ts[0].Summary != "I added a task." ||
		ts[1].Reason != "idle" || !ts[1].Idle || ts[1].Status != "done" || len(ts[1].WokenBy) != 1 || ts[1].WokenBy[0].Type != "task_done" ||
		ts[1].WokenBy[0].Text != "Looked around." {
		t.Errorf("turns: %+v", ts)
	}
	a := r.engLast(t, "T01")
	if a.Outcome != model.TaskDone || a.Result == nil || a.Result.Summary != "Looked around." || a.Worktree != "" || a.Base != "" || a.Branch != "" {
		t.Errorf("attempt: %+v", a)
	}
	if got := strings.TrimSpace(kinds(a.Phases)); got != "held slot setup work" {
		t.Errorf("phases: %s", got)
	}
	if rep, err := readReport(r.dir, "T01", 1); err != nil || rep != "There is a README." {
		t.Errorf("report: %q, %v", rep, err)
	}
	st := r.engState()
	if st.EndedAt == 0 || st.Halting != nil || len(st.Inbox) != 0 {
		t.Errorf("state: %+v", st)
	}
	for _, name := range []string{"turn-001", "T01-work", "turn-002"} {
		if ag, ok := r.engAgentNamed(name); !ok || ag.Status != model.AgentDone || len(ag.Launches) != 1 || ag.Launches[0].EndedAt == 0 {
			t.Errorf("agent %s: %+v", name, ag)
		}
	}
	// A task's end, its event and what it releases are one journal entry.
	for _, en := range readEntries(t, r.dir) {
		if en.Kind != KTaskEnded {
			continue
		}
		if en.Task != "T01" || len(en.Patch.Tasks) != 1 || en.Patch.Tasks[0].State() != model.TaskDone || en.Patch.State == nil ||
			len(en.Patch.State.Inbox) != 1 || en.Patch.State.Inbox[0].Type != "task_done" || en.Patch.State.Inbox[0].Seq != 1 {
			t.Errorf("the task_ended entry: %+v", en)
		}
	}
	// Every agent's process is closed when its result is taken.
	if got := strings.Join(e.host.stoppedNames(), " "); got != "turn-001 T01-work turn-002" {
		t.Errorf("stopped: %q", got)
	}
	// The task's agent works in the run's folder; nothing was made for checkouts.
	if m := e.host.sent("T01-work")[0]; m.Cwd != e.cwd || m.Role != model.RoleTask {
		t.Errorf("the task agent: cwd %s role %s", m.Cwd, m.Role)
	}
	if r.engHasEngine() {
		t.Error("the engine is still there after the run finished")
	}
	engUntil(t, "the scheduler to return", func() bool { return e.s.eng.wait(r, 0) })
}

// engPlay is a script for most tests: the first turn adds the tasks the test names, every other
// turn says nothing new, and a task's agent passes its gate and reports "completed". reply, when
// set, answers instead for the messages it wants (it returns true then).
func (e *engEnv) play(r *run, first func(), reply func(m *engMsg) bool) {
	e.host.setOn(func(m *engMsg) {
		if !e.gates.pass(m) {
			return
		}
		if reply != nil && reply(m) {
			return
		}
		switch {
		case m.Name == "turn-001":
			if first != nil {
				first()
			}
			m.Say("planned")
		case m.Role == model.RoleOrchestrator:
			m.Say("nothing to do")
		default:
			m.Block("completed", m.Name+" is done.", "report of "+m.Name)
		}
	})
}

// Tasks start in creation order, at most maxParallel at once, and only when the turn that added
// them has ended.
func TestSchedOrderMaxParallelAndHeld(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_order", func(m *model.RunMeta) { m.Settings.MaxParallel = 2; m.Settings.Wake = "idle" })
	e.gates.block("turn-001", "T01-work", "T02-work", "T03-work", "T04-work")
	added := make(chan struct{})
	e.play(r, nil, func(m *engMsg) bool {
		if m.Name == "turn-002" {
			e.finishRun(r, 2, model.Achieved)
		}
		return false
	})
	e.host.wrapOn(func(on func(m *engMsg)) func(m *engMsg) {
		return func(m *engMsg) {
			if m.Name == "turn-001" && m.N == 1 {
				for i := 0; i < 4; i++ {
					e.add(r, 1, "task", false)
				}
				close(added)
			}
			on(m)
		}
	})
	r.startEngine()
	<-added
	// While the turn runs its tasks are held: none has an agent.
	for _, id := range []string{"T01", "T02", "T03", "T04"} {
		if s := r.engTaskState(id); s != model.TaskHeld {
			t.Errorf("%s is %s while the turn that added it runs", id, s)
		}
	}
	e.clock.Advance(3 * time.Second) // scheduler ticks change nothing
	time.Sleep(20 * time.Millisecond)
	if n := len(e.host.names()); n != 1 {
		t.Fatalf("%d agents have a message while the turn runs", n)
	}
	e.gates.open("turn-001")
	engTask(t, r, "T01", model.TaskWork)
	engTask(t, r, "T02", model.TaskWork)
	engUntil(t, "the first two agents", func() bool { return len(e.host.names()) == 3 })
	time.Sleep(20 * time.Millisecond)
	if s3, s4 := r.engTaskState("T03"), r.engTaskState("T04"); s3 != model.TaskSlot || s4 != model.TaskSlot {
		t.Errorf("with two slots busy T03 is %s and T04 is %s", s3, s4)
	}
	e.gates.open("T02-work")
	engTask(t, r, "T02", model.TaskDone)
	engTask(t, r, "T03", model.TaskWork) // the next in creation order, not T04
	if s := r.engTaskState("T04"); s != model.TaskSlot {
		t.Errorf("T04 is %s", s)
	}
	e.gates.open("T01-work")
	e.gates.open("T03-work")
	e.gates.open("T04-work")
	engStatus(t, r, model.RunCompleted)
	var started []string
	for _, en := range readEntries(t, r.dir) {
		if en.Kind == KTaskStarted {
			started = append(started, en.Task)
		}
	}
	if got := strings.Join(started, " "); got != "T01 T02 T03 T04" {
		t.Errorf("tasks started in the order %s", got)
	}
	if names := e.host.names(); len(names) != 6 || names[0] != "turn-001" || names[5] != "turn-002" {
		t.Errorf("agents: %v", names)
	}
	// wake idle: one more turn, when nothing was left, with every event.
	if ts := r.engTurns(); len(ts) != 2 || ts[1].Reason != "idle" || len(ts[1].WokenBy) != 4 {
		t.Errorf("turns: %+v", ts)
	}
}

// With wake "each" a turn starts for every finished task while others still run; with wake
// "idle" only a failure, a change by a chat, or an idle run starts one.
func TestSchedWakeModes(t *testing.T) {
	t.Parallel()
	for _, wake := range []string{"each", "idle"} {
		e := newEngEnv(t, false)
		r := e.run("r_wake", func(m *model.RunMeta) { m.Settings.Wake = wake })
		e.gates.block("T01-work", "T02-work", "T03-work")
		e.play(r, func() {
			e.add(r, 1, "one", false)
			e.add(r, 1, "two", false)
			e.add(r, 1, "three", false)
		}, func(m *engMsg) bool {
			if m.Name == "T02-work" {
				m.Block("failed", "Could not do two.", "why")
				return true
			}
			return false
		})
		r.startEngine()
		engTask(t, r, "T03", model.TaskWork)
		e.gates.open("T01-work")
		engTask(t, r, "T01", model.TaskDone)
		if wake == "each" {
			engUntil(t, "turn 2", func() bool { ts := r.engTurns(); return len(ts) == 2 && ts[1].Status == "done" })
			if ts := r.engTurns(); ts[1].Reason != "events" || ts[1].Idle || len(ts[1].WokenBy) != 1 || ts[1].WokenBy[0].Task != "T01" {
				t.Errorf("each: turn 2 is %+v", ts[1])
			}
		} else {
			time.Sleep(30 * time.Millisecond)
			if n := len(r.engTurns()); n != 1 {
				t.Fatalf("idle: a turn started for a finished task (%d turns)", n)
			}
		}
		// A failed task wakes the orchestrator in both modes, and it gets every event so far.
		e.gates.open("T02-work")
		engTask(t, r, "T02", model.TaskFailed)
		want := map[string]int{"each": 3, "idle": 2}[wake]
		engUntil(t, "the turn after the failure", func() bool { ts := r.engTurns(); return len(ts) == want && ts[want-1].Status == "done" })
		last := r.engTurns()[want-1]
		if last.Reason != "events" || last.Idle {
			t.Errorf("%s: the turn after a failure is %+v", wake, last)
		}
		if wake == "idle" && (len(last.WokenBy) != 2 || last.WokenBy[0].Type != "task_done" || last.WokenBy[1].Type != "task_failed" ||
			last.WokenBy[1].Text != "its agent reported that it could not do the task: Could not do two.") {
			t.Errorf("idle: woken by %+v", last.WokenBy)
		}
		a := r.engLast(t, "T02")
		if a.Error != "its agent reported that it could not do the task: Could not do two." || a.Result == nil || a.Result.Outcome != "failed" {
			t.Errorf("%s: the failed attempt: %+v", wake, a)
		}
		// A change by a chat on the run wakes it too, in both modes.
		e.must(r, KOp, func(tx *Tx) error {
			tx.Event(model.RunEvent{Type: "chat_op", Chat: "c1", Text: "A chat on the run says: hurry."})
			return nil
		})
		engUntil(t, "the turn after the chat's change", func() bool { ts := r.engTurns(); return len(ts) == want+1 && ts[want].Status == "done" })
		if last := r.engTurns()[want]; last.Reason != "events" || len(last.WokenBy) != 1 || last.WokenBy[0].Type != "chat_op" {
			t.Errorf("%s: the turn after a chat's change is %+v", wake, last)
		}
		if st := r.engState(); st.IdleStreak != 0 || len(st.Inbox) != 0 {
			t.Errorf("%s: idle streak %d, inbox %v", wake, st.IdleStreak, st.Inbox)
		}
		r.stopEngine(10 * time.Second)
	}
}

// Three idle turns in a row are allowed; the fourth is replaced by a stall. The first turn and
// a turn after a person's resume do not count.
func TestSchedIdleStreak(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_idle", nil)
	e.play(r, nil, nil) // no turn ever adds a task
	r.startEngine()
	engStatus(t, r, model.RunStalled)
	st := r.engState()
	if st.StalledBy != model.StalledIdle || st.IdleStreak != 3 ||
		st.Reason != "the orchestrator was started 3 times in a row with nothing running and neither added work nor finished the run" {
		t.Errorf("state: %+v", st)
	}
	var reasons []string
	for _, tn := range r.engTurns() {
		reasons = append(reasons, tn.Reason)
	}
	if got := strings.Join(reasons, " "); got != "start idle idle idle" {
		t.Errorf("turn reasons: %s", got)
	}
	// The third idle turn was told that it is the last.
	if m := e.host.sent("turn-004")[0]; !strings.Contains(m.Text, "This is turn 3 in a row that began this way; after 3 the run is stopped as stalled.") {
		t.Error("turn 4 was not told about the streak")
	}
	if m := e.host.sent("turn-002")[0]; !strings.Contains(m.Text, "Nothing is running and nothing can start.") || strings.Contains(m.Text, "in a row that began this way") {
		t.Error("turn 2 has the wrong idle text")
	}
	if len(r.L.Stops) != 1 || r.L.Stops[0].Reason != model.StopStalled || r.L.Stops[0].ResumedAt != 0 {
		t.Errorf("stops: %+v", r.L.Stops)
	}

	// A person resumes: the streak starts again, and the turn that follows is a "resume" turn.
	e.clock.Advance(time.Minute)
	if err := r.resume(); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunStalled)
	reasons = nil
	for _, tn := range r.engTurns() {
		reasons = append(reasons, tn.Reason)
	}
	if got := strings.Join(reasons, " "); got != "start idle idle idle resume idle idle idle" {
		t.Errorf("turn reasons after the resume: %s", got)
	}
	if m := e.host.sent("turn-005")[0]; !strings.Contains(m.Text, "The run was halted (the orchestrator was started 3 times in a row with nothing running) and the person who started it resumed it.") {
		t.Error("the resume turn was not told why")
	}
	if st := r.engState(); st.IdleStreak != 3 || len(r.L.Stops) != 2 || r.L.Stops[0].ResumedAt == 0 {
		t.Errorf("after the second stall: streak %d, stops %+v", st.IdleStreak, r.L.Stops)
	}
}

// The turn limit halts the run when the next turn is due, and nothing else does.
func TestSchedMaxTurns(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_turns", func(m *model.RunMeta) { m.Settings.MaxTurns = 2 })
	e.play(r, func() { e.add(r, 1, "one", false) }, func(m *engMsg) bool {
		if m.Name == "turn-002" {
			e.add(r, 2, "two", false)
		}
		return false
	})
	r.startEngine()
	engStatus(t, r, model.RunStalled)
	st := r.engState()
	if st.StalledBy != model.StalledTurns || st.Reason != "reached the limit of 2 orchestrator turns" || len(r.engTurns()) != 2 {
		t.Errorf("state: %+v, %d turns", st, len(r.engTurns()))
	}
	// The task turn 2 added ran: the limit stops turns, not tasks.
	if s := r.engTaskState("T02"); s != model.TaskDone {
		t.Errorf("T02 is %s", s)
	}
	// Raised, the run goes on.
	r.mu.Lock()
	r.meta.Settings.MaxTurns = 3
	r.mu.Unlock()
	e.host.setOn(func(m *engMsg) { e.finishRun(r, 3, model.NotAchieved); m.Say("giving up") })
	if err := r.resume(); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunGaveUp)
	if ts := r.engTurns(); len(ts) != 3 || ts[2].Reason != "resume" {
		t.Errorf("turns after the resume: %+v", ts)
	}
}

// The cost limit is checked at three points: after an entry that ends a launch, when a turn is
// due, and by the ticker while agents run. It never halts a run whose result is set.
func TestSchedCostLimit(t *testing.T) {
	t.Parallel()
	work := AgentChatID("r_cost", "T01-work")
	e := newEngEnv(t, false)
	r := e.run("r_cost", func(m *model.RunMeta) { m.Settings.MaxCost = 1 })
	e.play(r, func() { e.add(r, 1, "one", false) }, func(m *engMsg) bool {
		if m.Name == "T01-work" {
			e.host.setCost(m.ID, 1.5)
		}
		return false
	})
	r.startEngine()
	// 1. The entry that ends the work agent's launch takes the run over the limit.
	engStatus(t, r, model.RunStalled)
	st := r.engState()
	if st.StalledBy != model.StalledCost || st.Reason != "spent $1.50, over the limit of $1.00" {
		t.Errorf("state: %+v", st)
	}
	if a, _ := r.engAgent(work); a.Cost == nil || *a.Cost != 1.5 {
		t.Errorf("the agent's cost: %v", a.Cost)
	}
	turns := len(r.engTurns())
	// 2. Resumed without a higher limit: the next turn is due, and the limit halts it again.
	if err := r.resume(); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunStalled)
	if n := len(r.engTurns()); n != turns || r.engState().StalledBy != model.StalledCost {
		t.Errorf("a turn started over the cost limit (%d turns, were %d)", n, turns)
	}
	r.stopEngine(10 * time.Second)

	// 3. The ticker: an agent that works past the limit is stopped while it works.
	e = newEngEnv(t, false)
	r = e.run("r_cost", func(m *model.RunMeta) { m.Settings.MaxCost = 1 })
	e.gates.block("T01-work")
	e.play(r, func() { e.add(r, 1, "one", false) }, nil)
	r.startEngine()
	engTask(t, r, "T01", model.TaskWork)
	engUntil(t, "the work agent's message", func() bool { return len(e.host.sent("T01-work")) == 1 })
	e.host.setCost(work, 0.4)
	e.clock.Advance(16 * time.Second)
	time.Sleep(30 * time.Millisecond)
	if s := r.engSt(); s != model.RunRunning {
		t.Fatalf("the run is %s under its cost limit", s)
	}
	e.host.setCost(work, 2.25)
	e.clock.Advance(16 * time.Second)
	engStatus(t, r, model.RunStalled)
	if st := r.engState(); st.StalledBy != model.StalledCost || st.Reason != "spent $2.25, over the limit of $1.00" {
		t.Errorf("state: %+v", st)
	}
	if a, _ := r.engAgent(work); a.Status != model.AgentInterrupted || a.Cost == nil || *a.Cost != 2.25 {
		t.Errorf("the stopped agent: %+v", a)
	}
	if s := r.engTaskState("T01"); s != model.TaskWork {
		t.Errorf("the task of a run halted by its cost is %s", s)
	}
	r.stopEngine(10 * time.Second)

	// 4. Nothing halts a run that has called finish_run: the last turn's own cost may pass the limit.
	e = newEngEnv(t, false)
	r = e.run("r_cost", func(m *model.RunMeta) { m.Settings.MaxCost = 1 })
	e.host.setOn(func(m *engMsg) {
		e.finishRun(r, 1, model.Achieved)
		e.host.setCost(m.ID, 5)
		m.Say("done")
	})
	r.startEngine()
	engStatus(t, r, model.RunCompleted)
	if c := r.viewNow().Cost; c == nil || *c != 5 {
		t.Errorf("the run's cost: %v", c)
	}
}

// The first halt wins: a second one is refused and changes nothing.
func TestSchedFirstHaltWins(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_halt", nil)
	e.gates.block("turn-001")
	e.play(r, nil, nil)
	r.startEngine()
	engUntil(t, "the turn's message", func() bool { return len(e.host.sent("turn-001")) == 1 })
	first := Halting{Status: model.RunStalled, StalledBy: model.StalledCost, Reason: "the first reason", Stop: model.StopStalled}
	if err := r.halt(first); err != nil {
		t.Fatal(err)
	}
	if err := r.halt(Halting{Status: model.RunStopped, Reason: "stopped by the user", Stop: model.StopUser}); err != ErrNotRunning {
		t.Fatalf("the second halt: %v", err)
	}
	engStatus(t, r, model.RunStalled)
	if st := r.engState(); st.Reason != "the first reason" || st.StalledBy != model.StalledCost || st.Halting != nil {
		t.Errorf("state: %+v", st)
	}
	if err := r.halt(first); err != ErrNotRunning {
		t.Errorf("a halt of a halted run: %v", err)
	}
	ks := engKinds(t, r)
	if engCount(ks, KRunStopping) != 1 || engCount(ks, KRunHalted) != 1 {
		t.Errorf("entries: %v", ks)
	}
	if len(r.L.Stops) != 1 || r.L.Stops[0].Reason != model.StopStalled {
		t.Errorf("stops: %+v", r.L.Stops)
	}
}

// A turn that fails halts the run with status error. The tasks it held are released all the
// same, and the events it was told about go back into the inbox, so the next turn is told again.
func TestSchedFailedTurn(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_failturn", func(m *model.RunMeta) { m.Settings.AgentRetries = 0 })
	e.gates.block("T02-work")
	e.play(r, func() { e.add(r, 1, "one", false) }, func(m *engMsg) bool {
		if m.Name == "turn-002" {
			e.add(r, 2, "two", false)
			// It learned of a second event by get_run, then broke.
			e.must(r, KLearned, func(tx *Tx) error {
				tx.Event(model.RunEvent{Type: "chat_op", Text: "late news"})
				st := tx.State()
				tn := tx.Turn(2)
				tn.Learned = append(tn.Learned, st.Inbox...)
				st.Inbox = nil
				return nil
			})
			m.Fail("the model is overloaded", "")
			return true
		}
		return false
	})
	r.startEngine()
	engStatus(t, r, model.RunError)
	st := r.engState()
	if st.Reason != "orchestrator turn 2: agent turn-002 failed: the model is overloaded" {
		t.Errorf("reason: %q", st.Reason)
	}
	ts := r.engTurns()
	if len(ts) != 2 || ts[1].Status != "failed" || ts[1].Error != "agent turn-002 failed: the model is overloaded" || ts[1].EndedAt == 0 {
		t.Fatalf("turns: %+v", ts)
	}
	// The failed turn keeps what it was told; the inbox has copies of both, in order.
	if len(ts[1].WokenBy) != 1 || len(ts[1].Learned) != 1 || len(st.Inbox) != 2 || st.Inbox[0].Seq != 1 || st.Inbox[1].Seq != 2 ||
		st.Inbox[0].Type != "task_done" || st.Inbox[1].Text != "late news" {
		t.Errorf("woken by %+v, learned %+v, inbox %+v", ts[1].WokenBy, ts[1].Learned, st.Inbox)
	}
	// The task the failed turn added is no longer held.
	tk, _ := r.engTask("T02")
	if len(tk.HeldBy) != 0 || tk.State() != model.TaskSlot {
		t.Errorf("T02 after the failed turn: held by %v, %s", tk.HeldBy, tk.State())
	}
	if a, _ := r.engAgentNamed("turn-002"); a.Status != model.AgentFailed || a.Error != "the model is overloaded" {
		t.Errorf("the turn's agent: %+v", a)
	}
	if r.L.Stops[0].Reason != model.StopError {
		t.Errorf("stops: %+v", r.L.Stops)
	}

	// Resumed: the released task starts, and the next turn is woken by the same events.
	e.play(r, nil, nil)
	if err := r.resume(); err != nil {
		t.Fatal(err)
	}
	engTask(t, r, "T02", model.TaskWork)
	engUntil(t, "turn 3", func() bool { ts := r.engTurns(); return len(ts) == 3 && ts[2].Status == "done" })
	if tn := r.engTurns()[2]; tn.Reason != "events" || len(tn.WokenBy) != 2 || tn.WokenBy[1].Text != "late news" {
		t.Errorf("turn 3: %+v", tn)
	}
	e.gates.open("T02-work")
	engTask(t, r, "T02", model.TaskDone)
}

// A task a chat on the run added or changed waits until that chat's reply is over.
func TestSchedChatHold(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_chathold", func(m *model.RunMeta) { m.Settings.Wake = "idle" })
	e.gates.block("T01-work")
	e.play(r, func() { e.add(r, 1, "one", false) }, nil)
	r.startEngine()
	engTask(t, r, "T01", model.TaskWork)
	e.host.setBusy("chat-1", true)
	e.must(r, KOp, func(tx *Tx) error {
		tx.AddTask(Task{ID: "T02", Title: "from the chat", Kind: "build", AddedBy: "chat-1", CreatedAt: tx.Now(), BriefRev: 1,
			HeldBy:   []Holder{{Chat: "chat-1"}},
			Attempts: []Attempt{{RunAttempt: model.RunAttempt{N: 1, QueuedBy: "chat-1", QueuedAt: tx.Now()}}}})
		tx.File(briefRel("T02", 1), []byte("brief"))
		return nil
	})
	e.clock.Advance(2 * time.Second)
	time.Sleep(30 * time.Millisecond)
	if tk, _ := r.engTask("T02"); tk.State() != model.TaskHeld || len(tk.HeldBy) != 1 {
		t.Fatalf("T02 while its chat replies: %s, held by %v", tk.State(), tk.HeldBy)
	}
	e.host.setBusy("chat-1", false)
	e.clock.Advance(time.Second) // the scheduler looks every second
	engTask(t, r, "T02", model.TaskDone)
	if ph := strings.TrimSpace(kinds(phasesOf(r, "T02"))); ph != "held slot setup work" {
		t.Errorf("phases of T02: %s", ph)
	}
	if got := engCount(engKinds(t, r), KTaskWait); got != 1 {
		t.Errorf("%d task_wait entries", got)
	}
}

// In a run without git nothing isolates the tasks: writing tasks run one at a time, reporting
// tasks beside them, everyone in the run's folder, and nothing is made for checkouts.
func TestSchedNoGitWritersOneAtATime(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_nogit", func(m *model.RunMeta) { m.Settings.Wake = "idle" })
	e.gates.block("T01-work", "T02-work", "T03-work", "T04-work")
	e.play(r, func() {
		e.add(r, 1, "write one", true)
		e.add(r, 1, "write two", true)
		e.add(r, 1, "read", false)
		e.add(r, 1, "write three", true)
	}, func(m *engMsg) bool {
		if m.Role == model.RoleTask {
			engWrite(t, m.Cwd, m.Name+".txt", "by "+m.Name)
		}
		if m.Name == "turn-002" {
			e.finishRun(r, 2, model.Achieved)
		}
		return false
	})
	r.startEngine()
	engTask(t, r, "T01", model.TaskWork)
	engTask(t, r, "T03", model.TaskWork) // the reporting task runs beside the writer
	time.Sleep(30 * time.Millisecond)
	if s2, s4 := r.engTaskState("T02"), r.engTaskState("T04"); s2 != model.TaskSlot || s4 != model.TaskSlot {
		t.Fatalf("beside a writing task T02 is %s and T04 is %s", s2, s4)
	}
	e.gates.open("T01-work")
	engTask(t, r, "T02", model.TaskWork)
	if s := r.engTaskState("T04"); s != model.TaskSlot {
		t.Fatalf("T04 is %s while T02 writes", s)
	}
	e.gates.open("T02-work")
	e.gates.open("T03-work")
	e.gates.open("T04-work")
	engStatus(t, r, model.RunCompleted)
	for _, m := range e.host.all() {
		if m.Cwd != e.cwd {
			t.Errorf("%s worked in %s", m.Name, m.Cwd)
		}
	}
	for _, id := range []string{"T01", "T02", "T03", "T04"} {
		a := r.engLast(t, id)
		if a.Base != "" || a.Branch != "" || a.Head != "" || a.Merged != "" || a.Worktree != "" || a.Outcome != model.TaskDone {
			t.Errorf("%s: %+v", id, a)
		}
		if ph := strings.TrimSpace(kinds(a.Phases)); ph != "held slot setup work" {
			t.Errorf("%s phases: %s", id, ph)
		}
		if _, err := readChanges(r.dir, id, 1); err != ErrNoText {
			t.Errorf("%s has a changes file: %v", id, err)
		}
	}
	if _, err := os.Stat(e.s.Store.P.RunWork); !os.IsNotExist(err) {
		t.Errorf("the folder of the run's work is left: %v", err)
	}
	if m := e.host.sent("T01-work")[0]; !strings.Contains(m.Text, "the run's own folder, which is not a git repository: you work directly in it") {
		t.Error("the writing task was not told that it works in the folder")
	}
	if m := e.host.sent("turn-001")[0]; !strings.Contains(m.Text, "Your working directory is the run's folder itself") {
		t.Error("the orchestrator was not told that it works in the folder")
	}
}

// finish_run recorded while its turn still runs: the run ends when the turn's worker returns.
func TestSchedFinishWhileTheTurnRuns(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_fin", nil)
	e.gates.block("turn-001")
	finished := make(chan struct{})
	e.host.setOn(func(m *engMsg) {
		e.finishRun(r, 1, model.Achieved)
		close(finished)
		if e.gates.pass(m) {
			m.Say("That is all.")
		}
	})
	r.startEngine()
	<-finished
	e.clock.Advance(3 * time.Second)
	time.Sleep(30 * time.Millisecond)
	if s := r.engSt(); s != model.RunRunning {
		t.Fatalf("the run is %s while its last turn runs", s)
	}
	e.gates.open("turn-001")
	engStatus(t, r, model.RunCompleted)
	if tn := r.engTurns()[0]; tn.Status != "done" || tn.Summary != "That is all." {
		t.Errorf("the turn: %+v", tn)
	}
	if v := r.viewNow(); v.Outcome != model.Achieved || v.TurnRunning != 0 {
		t.Errorf("view: %+v", v)
	}
}

// A stop that comes after finish_run does not leave a stopped run with a result: when the
// turn's worker has let go the run is finished, and run_finished closes the turn left running,
// with the agent's last text as its summary.
func TestSchedStopAfterFinishRun(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_finstop", nil)
	finished := make(chan struct{})
	e.host.setOn(func(m *engMsg) {
		e.finishRun(r, 1, model.NotAchieved)
		e.host.mu.Lock()
		m.c.text = "I was about to say goodbye."
		e.host.mu.Unlock()
		close(finished)
		m.Hang()
	})
	r.startEngine()
	<-finished
	if err := r.halt(Halting{Status: model.RunStopped, Reason: "stopped by the user", Stop: model.StopUser}); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunGaveUp)
	tn := r.engTurns()[0]
	if tn.Status != "done" || tn.Summary != "I was about to say goodbye." || tn.EndedAt == 0 {
		t.Errorf("the turn: %+v", tn)
	}
	if a, _ := r.engAgentNamed("turn-001"); a.Status != model.AgentDone || a.EndedAt == 0 {
		t.Errorf("the turn's agent: %+v", a)
	}
	ks := engKinds(t, r)
	if engCount(ks, KRunFinished) != 1 || engCount(ks, KRunHalted) != 0 || engCount(ks, KTurnEnded) != 0 {
		t.Errorf("entries: %v", ks)
	}
	if st := r.engState(); st.Halting != nil || st.Reason != "" || len(r.L.Stops) != 0 {
		t.Errorf("state: %+v, stops %v", st, r.L.Stops)
	}
}

// A panic in an engine goroutine halts its run with status error and does not end the server.
func TestEnginePanicHaltsTheRun(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_panic", nil)
	e.host.setOn(func(m *engMsg) { m.Say("x") })
	e.host.boom = "turn-001"
	r.startEngine()
	engStatus(t, r, model.RunError)
	if st := r.engState(); st.Reason != "internal error: the chat manager fell over" {
		t.Errorf("reason: %q", st.Reason)
	}
	if tn := r.engTurns()[0]; tn.Status != "running" {
		t.Errorf("the turn: %+v", tn)
	}
}

// The idle streak is recorded: a restart of the server does not give the run three more idle
// turns.
func TestSchedIdleStreakSurvivesRestart(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_streak", nil)
	e.gates.block("turn-003")
	e.play(r, nil, nil)
	r.startEngine()
	engUntil(t, "turn 3", func() bool { return len(e.host.sent("turn-003")) == 1 })
	if st := r.engState(); st.IdleStreak != 2 {
		t.Fatalf("idle streak %d in the second idle turn", st.IdleStreak)
	}
	e.s.Shutdown(10 * time.Second)
	e.clock.Advance(time.Hour)
	r = e.reload("r_streak")
	e.play(r, nil, nil)
	e.gates.open("turn-003")
	e.s.Boot()
	engStatus(t, r, model.RunStalled)
	st := r.engState()
	if st.StalledBy != model.StalledIdle || st.IdleStreak != 3 || len(r.engTurns()) != 4 {
		t.Errorf("after the restart: %+v, %d turns", st, len(r.engTurns()))
	}
	if tn := r.engTurns()[2]; tn.Status != "done" || tn.Reason != "idle" {
		t.Errorf("turn 3: %+v", tn)
	}
}

// An orchestrator turn whose session is gone starts fresh, with the note that the run above is
// as it is now.
func TestSchedTurnWithoutSession(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_turnns", nil)
	e.host.setOn(func(m *engMsg) {
		switch {
		case m.N == 1:
			m.Hang()
		case m.Resumed:
			m.NoSession()
		default:
			e.finishRun(r, 1, model.Achieved)
			m.Say("third time lucky")
		}
	})
	r.startEngine()
	engUntil(t, "the turn's message", func() bool { return len(e.host.sent("turn-001")) == 1 })
	if err := r.halt(engUserStop); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunStopped)
	if err := r.resume(); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunCompleted)
	sent := e.host.sent("turn-001")
	if len(sent) != 3 || !sent[2].Fresh || !strings.HasPrefix(sent[2].Text, "You are the orchestrator") ||
		!strings.HasSuffix(sent[2].Text, "Note: an earlier instance of this turn did not finish. Tool calls it made took effect; the run above is as it is now.") {
		t.Errorf("%d messages to the turn", len(sent))
	}
	a, _ := r.engAgentNamed("turn-001")
	if got := engLaunchErrors(a); got != `1 fresh ""; 2 resume "no session"; 3 fresh ""` || a.Failures != 0 {
		t.Errorf("launches: %s", got)
	}
	if ts := r.engTurns(); len(ts) != 1 || ts[0].Summary != "third time lucky" {
		t.Errorf("turns: %+v", ts)
	}
}
