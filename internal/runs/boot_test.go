package runs

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
)

var engUserStop = Halting{Status: model.RunStopped, Reason: "stopped by the user", Stop: model.StopUser}

// An orderly shutdown halts every live run with one run_halted entry (app_quit) and closes no
// process; the next server continues the run by itself, and its agents go on in their sessions.
func TestShutdownThenBootContinues(t *testing.T) {
	t.Parallel()
	e, r := engOneTask(t, nil, func(m *engMsg) {
		if !m.Resumed {
			m.Hang()
			return
		}
		m.Block("completed", "Done after the restart.", "r")
	})
	r.startEngine()
	engUntil(t, "the work agent's message", func() bool { return len(e.host.sent("T01-work")) == 1 })
	e.clock.Advance(5 * time.Minute)
	stopsBefore := len(e.host.stoppedNames())
	e.s.Shutdown(10 * time.Second)

	st := r.engState()
	if st.Status != model.RunStopped || st.Reason != engReasonQuit || st.ActiveMs != 5*60_000 || st.Halting != nil {
		t.Errorf("state after the shutdown: %+v", st)
	}
	if len(r.L.Stops) != 1 || r.L.Stops[0].Reason != model.StopAppQuit || r.L.Stops[0].ResumedAt != 0 {
		t.Errorf("stops: %+v", r.L.Stops)
	}
	ks := engKinds(t, r)
	if engCount(ks, KRunHalted) != 1 || engCount(ks, KRunStopping) != 0 || ks[len(ks)-1] != KRunHalted {
		t.Errorf("entries: %v", ks)
	}
	if n := len(e.host.stoppedNames()); n != stopsBefore {
		t.Errorf("the shutdown closed %d agent process(es); the chat manager does that", n-stopsBefore)
	}
	if a, _ := r.engAgentNamed("T01-work"); a.Status != model.AgentInterrupted || !a.Resumable || a.Launches[0].EndedAt == 0 {
		t.Errorf("the agent after the shutdown: %+v", a)
	}
	if s := r.engTaskState("T01"); s != model.TaskWork {
		t.Errorf("the task after the shutdown: %s", s)
	}
	if !e.s.eng.wait(nil, 0) {
		t.Error("an engine goroutine is left after the shutdown")
	}
	r.startEngine() // a service that shuts down starts nothing
	if r.engHasEngine() {
		t.Error("an engine started after the shutdown")
	}
	// The checkpoint is whole: the next server reads state.json alone.
	if sf, ok, err := readHead(r.dir); err != nil || !ok || sf.State.Status != model.RunStopped || sf.JournalOffset != journalSize(r.dir) {
		t.Errorf("the checkpoint: %+v %v %v", sf.State, ok, err)
	}

	e.clock.Advance(time.Hour)
	r = e.reload("r_agent")
	e.play(r, nil, func(m *engMsg) bool {
		if m.Name == "T01-work" {
			m.Block("completed", "Done after the restart.", "r")
			return true
		}
		if m.Role == model.RoleOrchestrator {
			e.finishRun(r, len(r.engTurns()), model.Achieved)
		}
		return false
	})
	e.s.Boot()
	engStatus(t, r, model.RunCompleted)
	sent := e.host.sent("T01-work")
	if len(sent) != 1 || !sent[0].Resumed || !strings.HasPrefix(sent[0].Text, "Your previous run of this job stopped before it finished") {
		t.Errorf("after the restart the agent got %d message(s)", len(sent))
	}
	if len(r.L.Stops) != 1 || r.L.Stops[0].ResumedAt == 0 {
		t.Errorf("stops after the boot: %+v", r.L.Stops)
	}
	// The hour the app was closed is not working time.
	if st := r.engState(); st.ActiveMs != 5*60_000 {
		t.Errorf("active %d ms", st.ActiveMs)
	}
	// The turn after the server's own continue is an ordinary one: nobody resumed the run.
	if ts := r.engTurns(); len(ts) != 2 || ts[1].Reason != "idle" {
		t.Errorf("turns: %+v", ts)
	}
}

// A run found running when the server starts (the server died) is halted, with a stop at the
// time of its last entry and its agents' cost from the chat manager, and is not continued by
// itself: the dead server's agent processes may still be alive.
func TestBootAfterCrash(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_crash", nil)
	id := AgentChatID(r.id, "turn-001")
	e.clock.Advance(2 * time.Minute)
	e.must(r, KTurnStarted, func(tx *Tx) error {
		tx.AddTurn(Turn{N: 1, Agent: id, Reason: "start", Idle: true, Status: "running", StartedAt: tx.Now()})
		tx.AddAgent(Agent{RunAgent: model.RunAgent{ID: id, Name: "turn-001", Role: model.RoleOrchestrator, Turn: 1, Status: model.AgentRunning,
			StartedAt: tx.Now(), Launches: []model.RunLaunch{{N: 1, StartedAt: tx.Now()}}}, Resumable: true})
		return nil
	})
	last := e.clock.Now().UnixMilli()
	e.host.CreateOwned(chats.OwnedSpec{ID: id, Run: r.id, Role: model.RoleOrchestrator, Name: "turn-001", Cwd: e.cwd})
	e.host.chats[id].session = true
	e.host.costs[id] = chats.Cost{USD: 0.4, Known: true, Partial: true}
	e.clock.Advance(3 * time.Hour) // the server was down
	r = e.reload("r_crash")
	e.s.Boot()

	st := r.engState()
	if st.Status != model.RunStopped || st.Reason != engReasonCrash || st.AsOf != last || st.ActiveMs != 2*60_000 {
		t.Errorf("state: %+v (last entry at %d)", st, last)
	}
	if len(r.L.Stops) != 1 || r.L.Stops[0].At != last || r.L.Stops[0].Reason != model.StopAppQuit || r.L.Stops[0].ResumedAt != 0 {
		t.Errorf("stops: %+v", r.L.Stops)
	}
	a, _ := r.engAgent(id)
	if a.Status != model.AgentInterrupted || a.Cost == nil || *a.Cost != 0.4 || !a.CostLost || a.Launches[0].EndedAt != last {
		t.Errorf("agent: %+v", a)
	}
	if v := r.viewNow(); !v.CostPartial || v.Cost == nil || *v.Cost != 0.4 {
		t.Errorf("view cost: %v partial %v", v.Cost, v.CostPartial)
	}
	if r.engHasEngine() || len(e.host.all()) != 0 {
		t.Error("the run was continued by itself after a crash")
	}
	if tn := r.engTurns()[0]; tn.Status != "running" {
		t.Errorf("the turn: %+v", tn)
	}
	// A second boot changes nothing.
	n := len(readEntries(t, r.dir))
	e.s.Boot()
	if got := len(readEntries(t, r.dir)); got != n || r.engHasEngine() {
		t.Errorf("a second boot wrote %d entries", got-n)
	}

	// A person resumes: the turn goes on with the same number and agent, with the resume
	// message built from the run as it is now.
	e.host.on = func(m *engMsg) { e.finishRun(r, 1, model.Achieved); m.Say("back") }
	if err := r.resume(); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunCompleted)
	sent := e.host.sent("turn-001")
	if len(sent) != 1 || !sent[0].Resumed || !strings.Contains(sent[0].Text, "Tool calls you made before the stop took effect; the run below is as it is now.\n\n---\n\nYou are the orchestrator") {
		t.Errorf("the resumed turn got %d message(s)", len(sent))
	}
	if ts := r.engTurns(); len(ts) != 1 || ts[0].Status != "done" || ts[0].Summary != "back" {
		t.Errorf("turns: %+v", ts)
	}
}

// A run that the app's closing stopped three times in a row, each time within a minute of
// continuing it, is not continued a fourth time.
func TestBootLoopGuardFakeHost(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_loop", nil)
	e.host.on = func(m *engMsg) { m.Hang() }
	r.startEngine()
	cycle := func(after time.Duration) {
		t.Helper()
		engUntil(t, "the turn's agent", func() bool { return len(e.host.sent("turn-001")) == 1 })
		e.clock.Advance(after)
		e.s.Shutdown(10 * time.Second)
		r = e.reload("r_loop")
		e.host.on = func(m *engMsg) { m.Hang() }
		e.s.Boot()
	}
	cycle(10 * time.Second)
	cycle(59 * time.Second)
	if s := r.engSt(); s != model.RunRunning {
		t.Fatalf("after two quick closes the run is %s", s)
	}
	cycle(10 * time.Second)
	st := r.engState()
	if st.Status != model.RunStopped || st.Reason != engReasonLoop || r.engHasEngine() {
		t.Fatalf("after three quick closes: %+v, engine %v", st, r.engHasEngine())
	}
	if len(r.L.Stops) != 3 || r.L.Stops[2].ResumedAt != 0 {
		t.Errorf("stops: %+v", r.L.Stops)
	}
	if v := r.viewNow(); v.Reason != engReasonLoop {
		t.Errorf("view reason: %q", v.Reason)
	}
	// It stays halted over further starts, until a person resumes it.
	r = e.reload("r_loop")
	e.s.Boot()
	if r.engSt() != model.RunStopped || r.engHasEngine() {
		t.Error("the run was continued after the guard")
	}
	e.host.on = func(m *engMsg) { e.finishRun(r, 1, model.Achieved); m.Say("done") }
	if err := r.resume(); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunCompleted)

	// A close that came a minute or more after the run was continued breaks the row.
	if engQuickCloses([]model.RunStop{{At: 10_000, ResumedAt: 11_000, Reason: model.StopAppQuit}, {At: 71_000, ResumedAt: 72_000, Reason: model.StopAppQuit},
		{At: 80_000, Reason: model.StopAppQuit}}, 0) {
		t.Error("a close 60 s after the resume counts as quick")
	}
	if engQuickCloses([]model.RunStop{{At: 10_000, ResumedAt: 11_000, Reason: model.StopUser}, {At: 20_000, ResumedAt: 21_000, Reason: model.StopAppQuit},
		{At: 30_000, Reason: model.StopAppQuit}}, 0) {
		t.Error("a stop by the user counts as a close of the app")
	}
	if !engQuickCloses([]model.RunStop{{At: 500_000, ResumedAt: 600_000, Reason: model.StopUser}, {At: 610_000, ResumedAt: 611_000, Reason: model.StopAppQuit},
		{At: 620_000, ResumedAt: 621_000, Reason: model.StopAppQuit}, {At: 630_000, Reason: model.StopAppQuit}}, 0) {
		t.Error("three quick closes after an older stop are not seen")
	}
}

// A run that died while it was stopping ends as the halt intended, and is not continued.
func TestBootEndsAStoppingRunAsItsHaltSays(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_stopping", nil)
	e.must(r, KRunStopping, func(tx *Tx) error {
		st := tx.State()
		st.Status = model.RunStopping
		st.Halting = &Halting{Status: model.RunStalled, StalledBy: model.StalledCost, Reason: "spent $3.00, over the limit of $2.00", Stop: model.StopStalled}
		return nil
	})
	r = e.reload("r_stopping")
	if v := r.viewNow(); v.Status != model.RunStopping {
		t.Fatalf("the run was read as %s", v.Status)
	}
	e.s.Boot()
	st := r.engState()
	if st.Status != model.RunStalled || st.StalledBy != model.StalledCost || st.Reason != "spent $3.00, over the limit of $2.00" || st.Halting != nil {
		t.Errorf("state: %+v", st)
	}
	if len(r.L.Stops) != 1 || r.L.Stops[0].Reason != model.StopStalled {
		t.Errorf("stops: %+v", r.L.Stops)
	}
	if r.engHasEngine() {
		t.Error("the run was continued")
	}

	// The same at an orderly shutdown: the halt that was under way decides, not the app's closing.
	e = newEngEnv(t, false)
	r = e.run("r_stopping", nil)
	e.must(r, KRunStopping, func(tx *Tx) error {
		st := tx.State()
		st.Status, st.Halting = model.RunStopping, &engUserStop
		return nil
	})
	e.s.Shutdown(time.Second)
	if st := r.engState(); st.Status != model.RunStopped || st.Reason != "stopped by the user" || r.L.Stops[0].Reason != model.StopUser {
		t.Errorf("state after the shutdown: %+v, stops %+v", st, r.L.Stops)
	}
	r = e.reload("r_stopping")
	e.s.Boot()
	if r.engSt() != model.RunStopped || r.engHasEngine() {
		t.Error("a run the user stopped was continued by the server")
	}
}

// A run found live with its result set is finished by the boot: run_finished closes the turn
// that was left running, with its agent's last text as the summary. No halt is written.
func TestBootFinishesARunWhoseResultIsSet(t *testing.T) {
	t.Parallel()
	for _, git := range []bool{false, true} {
		e := newEngEnv(t, git)
		r := e.run("r_bootfin", nil)
		id := AgentChatID(r.id, "turn-001")
		e.must(r, KTurnStarted, func(tx *Tx) error {
			tx.AddTurn(Turn{N: 1, Agent: id, Reason: "start", Status: "running", StartedAt: tx.Now()})
			tx.AddAgent(Agent{RunAgent: model.RunAgent{ID: id, Name: "turn-001", Role: model.RoleOrchestrator, Turn: 1, Status: model.AgentRunning,
				StartedAt: tx.Now(), Launches: []model.RunLaunch{{N: 1, StartedAt: tx.Now()}}}})
			return nil
		})
		e.finishRun(r, 1, model.Achieved)
		e.host.CreateOwned(chats.OwnedSpec{ID: id, Run: r.id, Role: model.RoleOrchestrator, Name: "turn-001", Cwd: e.cwd})
		e.host.chats[id].text = "Everything is merged and verified."
		e.host.setCost(id, 1.5)
		e.clock.Advance(time.Minute)
		r = e.reload("r_bootfin")
		e.s.Boot()
		st := r.engState()
		if st.Status != model.RunCompleted || st.EndedAt == 0 || st.Reason != "" {
			t.Fatalf("git %v: state %+v", git, st)
		}
		tn := r.engTurns()[0]
		if tn.Status != "done" || tn.Summary != "Everything is merged and verified." || tn.EndedAt == 0 || tn.Cost == nil || *tn.Cost != 1.5 {
			t.Errorf("git %v: the turn %+v", git, tn)
		}
		if a, _ := r.engAgent(id); a.Status != model.AgentDone || a.Launches[0].EndedAt == 0 || a.Cost == nil || *a.Cost != 1.5 {
			t.Errorf("git %v: the agent %+v", git, a)
		}
		ks := engKinds(t, r)
		if engCount(ks, KRunFinished) != 1 || engCount(ks, KRunHalted) != 0 || len(r.L.Stops) != 0 {
			t.Errorf("git %v: entries %v", git, ks)
		}
		if git {
			if g := r.engGit(); g.ResultHead != g.BaseRef {
				t.Errorf("result head %q", g.ResultHead)
			}
		}
		if v := r.viewNow(); v.Outcome != model.Achieved || v.TurnRunning != 0 {
			t.Errorf("git %v: view %+v", git, v)
		}
	}
}

// engHandTask makes the recorded state of a non-git run whose task T01 a dead engine left
// active: started, its setup done, its work agent named. agent may change the agent's record.
func engHandTask(e *engEnv, r *run, agent func(a *Agent)) {
	e.add(r, 0, "the job", false)
	id := AgentChatID(r.id, "T01-work")
	e.must(r, KTaskStep, func(tx *Tx) error {
		tk := tx.Task("T01")
		a := &tk.Attempts[0]
		a.StartedAt, a.SetupDone, a.Agents.Work = tx.Now(), true, id
		a.Phases = append(a.Phases, model.RunPhase{K: model.TaskSetup, T: tx.Now()}, model.RunPhase{K: model.TaskWork, T: tx.Now()})
		rec := Agent{RunAgent: model.RunAgent{ID: id, Name: "T01-work", Role: model.RoleTask, Task: "T01", Attempt: 1, Status: model.AgentRunning, StartedAt: tx.Now()}}
		if agent != nil {
			agent(&rec)
		}
		tx.AddAgent(rec)
		// A first turn that is over, so that the engine starts with the task.
		tid := AgentChatID(r.id, "turn-001")
		tx.AddTurn(Turn{N: 1, Agent: tid, Reason: "start", Status: "done", StartedAt: tx.Now(), EndedAt: tx.Now()})
		tx.AddAgent(Agent{RunAgent: model.RunAgent{ID: tid, Name: "turn-001", Role: model.RoleOrchestrator, Turn: 1, Status: model.AgentDone, StartedAt: tx.Now(), EndedAt: tx.Now()}})
		return nil
	})
}

// The rows of the recovery table that a run without git has: what the next start does with what
// is recorded.
func TestRecoveryTableNoGit(t *testing.T) {
	t.Parallel()
	block := func(m *engMsg) bool {
		if m.Role == model.RoleTask {
			m.Block("completed", "ok", "r")
			return true
		}
		return false
	}

	// Active tasks go on before new ones start, whatever maxParallel says; a waiting task waits.
	t.Run("active tasks first", func(t *testing.T) {
		t.Parallel()
		e := newEngEnv(t, false)
		r := e.run("r_rec", func(m *model.RunMeta) { m.Settings.MaxParallel = 1; m.Settings.Wake = "idle" })
		engHandTask(e, r, nil)
		// Two more tasks were active too, and one waits for a slot.
		for _, id := range []string{"T02", "T03"} {
			e.add(r, 0, "also active", false)
			e.must(r, KTaskStarted, func(tx *Tx) error {
				a := &tx.Task(id).Attempts[0]
				a.StartedAt = tx.Now()
				a.Phases = append(a.Phases, model.RunPhase{K: model.TaskSetup, T: tx.Now()})
				return nil
			})
		}
		e.add(r, 0, "waits", false)
		e.gates.block("T01-work", "T02-work", "T03-work")
		e.play(r, nil, nil)
		r.startEngine()
		engUntil(t, "the three agents", func() bool { return len(e.host.names()) == 3 })
		if s := r.engTaskState("T04"); s != model.TaskSlot {
			t.Errorf("the waiting task is %s", s)
		}
		// The agent that had no launch got the first message, as it is.
		m := e.host.sent("T01-work")[0]
		if m.Resumed || m.Fresh || !strings.HasPrefix(m.Text, "You are one of the agents") || strings.Contains(m.Text, "Note: an earlier attempt") {
			t.Errorf("an agent without a launch got: resumed %v fresh %v", m.Resumed, m.Fresh)
		}
		e.gates.open("T01-work")
		e.gates.open("T02-work")
		engTask(t, r, "T02", model.TaskDone)
		time.Sleep(30 * time.Millisecond)
		if s := r.engTaskState("T04"); s != model.TaskSlot { // T03 still holds the one slot
			t.Errorf("the waiting task is %s while a recovered task works", s)
		}
		e.gates.open("T03-work")
		engTask(t, r, "T04", model.TaskDone)
	})

	// An interrupted agent that has no session starts fresh, with the retry note.
	t.Run("no session to resume", func(t *testing.T) {
		t.Parallel()
		e := newEngEnv(t, false)
		r := e.run("r_rec", nil)
		engHandTask(e, r, func(a *Agent) {
			a.Status = model.AgentInterrupted
			a.Launches = []model.RunLaunch{{N: 1, StartedAt: 5, EndedAt: 6, Error: "no session"}}
		})
		e.play(r, nil, block)
		r.startEngine()
		engTask(t, r, "T01", model.TaskDone)
		m := e.host.sent("T01-work")[0]
		if !m.Fresh || !strings.HasPrefix(m.Text, "You are one of the agents") || !strings.Contains(m.Text, "Note: an earlier attempt at this job did not finish.") {
			t.Errorf("the launch: fresh %v", m.Fresh)
		}
	})

	// An agent recorded as failed is not launched again: its task fails.
	t.Run("a failed agent", func(t *testing.T) {
		t.Parallel()
		e := newEngEnv(t, false)
		r := e.run("r_rec", nil)
		engHandTask(e, r, func(a *Agent) { a.Status, a.Error = model.AgentFailed, "timed out after 3h00m" })
		e.play(r, nil, block)
		r.startEngine()
		engTask(t, r, "T01", model.TaskFailed)
		if a := r.engLast(t, "T01"); a.Error != "agent T01-work failed: timed out after 3h00m" || len(e.host.sent("T01-work")) != 0 {
			t.Errorf("attempt: %+v", a)
		}
	})

	// The result is recorded and says failed: the task fails, no agent runs.
	t.Run("work done, outcome failed", func(t *testing.T) {
		t.Parallel()
		e := newEngEnv(t, false)
		r := e.run("r_rec", nil)
		engHandTask(e, r, func(a *Agent) { a.Status = model.AgentDone })
		e.must(r, KTaskStep, func(tx *Tx) error {
			a := &tx.Task("T01").Attempts[0]
			a.WorkDone, a.Result = true, &model.AttemptResult{Outcome: "failed", Summary: "No way."}
			return nil
		})
		e.play(r, nil, block)
		r.startEngine()
		engTask(t, r, "T01", model.TaskFailed)
		if a := r.engLast(t, "T01"); a.Error != "its agent reported that it could not do the task: No way." || len(e.host.sent("T01-work")) != 0 {
			t.Errorf("attempt: %+v", a)
		}
	})

	// The result is recorded and says completed: the task ends, no agent runs.
	t.Run("work done, completed", func(t *testing.T) {
		t.Parallel()
		e := newEngEnv(t, false)
		r := e.run("r_rec", nil)
		engHandTask(e, r, func(a *Agent) { a.Status = model.AgentDone })
		e.must(r, KTaskStep, func(tx *Tx) error {
			a := &tx.Task("T01").Attempts[0]
			a.WorkDone, a.Result = true, &model.AttemptResult{Outcome: "completed", Summary: "Yes."}
			return nil
		})
		e.play(r, nil, block)
		r.startEngine()
		engTask(t, r, "T01", model.TaskDone)
		if len(e.host.sent("T01-work")) != 0 {
			t.Error("an agent that was done ran again")
		}
		engUntil(t, "the event's turn", func() bool { return len(r.engTurns()) >= 2 }) // idle turns follow it
		if ev := r.engTurns()[1].WokenBy; len(ev) != 1 || ev[0].Text != "Yes." {
			t.Errorf("event: %+v", ev)
		}
	})

	// A turn that a stop left running goes on, and the tasks it holds stay held until it ends.
	t.Run("a running turn", func(t *testing.T) {
		t.Parallel()
		e := newEngEnv(t, false)
		r := e.run("r_rec", nil)
		added := make(chan struct{})
		e.host.on = func(m *engMsg) {
			e.add(r, 1, "held", false)
			close(added)
			m.Hang()
		}
		r.startEngine()
		<-added
		if err := r.halt(engUserStop); err != nil {
			t.Fatal(err)
		}
		engStatus(t, r, model.RunStopped)
		if tn := r.engTurns()[0]; tn.Status != "running" || r.engTaskState("T01") != model.TaskHeld {
			t.Fatalf("after the stop: turn %+v, task %s", tn, r.engTaskState("T01"))
		}
		if v := r.viewNow(); v.TurnRunning != 1 || v.Status != model.RunStopped {
			t.Errorf("view: %+v", v)
		}
		e.gates.block("turn-001")
		e.play(r, nil, func(m *engMsg) bool {
			if m.Name == "turn-001" {
				m.Say("continued")
				return true
			}
			return block(m)
		})
		if err := r.resume(); err != nil {
			t.Fatal(err)
		}
		engUntil(t, "the turn's second message", func() bool { return len(e.host.sent("turn-001")) == 2 })
		time.Sleep(30 * time.Millisecond)
		if s := r.engTaskState("T01"); s != model.TaskHeld {
			t.Fatalf("the held task is %s while its turn runs again", s)
		}
		e.gates.open("turn-001")
		engTask(t, r, "T01", model.TaskDone)
		ts := r.engTurns()
		if ts[0].Status != "done" || ts[0].Summary != "continued" || ts[0].N != 1 {
			t.Errorf("turn 1: %+v", ts[0])
		}
		if m := e.host.sent("turn-001")[1]; !m.Resumed || !strings.HasPrefix(m.Text, "Your previous run of this job stopped") {
			t.Error("the turn was not continued with the resume message")
		}
		if a, _ := r.engAgentNamed("turn-001"); len(a.Launches) != 2 || a.Status != model.AgentDone {
			t.Errorf("the turn's agent: %+v", a)
		}
	})

	// A result that is set with nothing running: the next start finishes the run at once.
	t.Run("result set", func(t *testing.T) {
		t.Parallel()
		e := newEngEnv(t, false)
		r := e.run("r_rec", nil)
		e.host.on = func(m *engMsg) { m.Say("x") }
		e.must(r, KTurnStarted, func(tx *Tx) error {
			tx.AddTurn(Turn{N: 1, Agent: "a", Reason: "start", Status: "done", StartedAt: tx.Now(), EndedAt: tx.Now()})
			return nil
		})
		e.finishRun(r, 1, model.NotAchieved)
		r.startEngine()
		engStatus(t, r, model.RunGaveUp)
		if len(e.host.all()) != 0 || len(r.engTurns()) != 1 {
			t.Error("something ran in a run whose result was set")
		}
	})
}

// The rows of the recovery table that only a git run has: each step of a writing task's way
// into the integration branch is done once, whatever the server last recorded.
func TestRecoveryTableGit(t *testing.T) {
	t.Parallel()
	// start runs a git run until T01's work agent has its message, then takes the server away.
	// The returned run is the reloaded one; wt is the task's checkout with the agent's file in it.
	start := func(t *testing.T) (e *engEnv, r *run, wt string) {
		e = newEngEnv(t, true)
		r = e.run("r_recg", func(m *model.RunMeta) { m.Settings.Wake = "idle" })
		e.gates.block("turn-002")
		e.play(r, func() { e.add(r, 1, "Add a file", true) }, func(m *engMsg) bool {
			if m.Name == "T01-work" {
				m.Hang()
				return true
			}
			return false
		})
		r.startEngine()
		engUntil(t, "the work agent's message", func() bool { return len(e.host.sent("T01-work")) == 1 })
		r = e.restart("r_recg")
		wt = r.engLast(t, "T01").Worktree
		engWrite(t, wt, "a.txt", "by T01\n")
		e.play(r, nil, func(m *engMsg) bool {
			if m.Name == "T01-work" {
				t.Errorf("the work agent ran again")
			}
			return false
		})
		return e, r, wt
	}
	// done records what the dead engine had recorded up to a step.
	workDone := func(e *engEnv, r *run) {
		id := AgentChatID(r.id, "T01-work")
		e.must(r, KTaskStep, func(tx *Tx) error {
			a := &tx.Task("T01").Attempts[0]
			a.WorkDone, a.Result = true, &model.AttemptResult{Outcome: "completed", Summary: "Added it."}
			a.Phases = append(a.Phases, model.RunPhase{K: model.TaskMerge, T: tx.Now()})
			ag := tx.Agent(id)
			engEndLaunch(ag, tx.Now(), "")
			ag.Status, ag.EndedAt = model.AgentDone, tx.Now()
			return nil
		})
	}
	check := func(t *testing.T, e *engEnv, r *run) {
		t.Helper()
		e.s.Boot()
		if err := r.resume(); err != nil {
			t.Fatal(err)
		}
		engTask(t, r, "T01", model.TaskDone)
		g := r.engGit()
		a := r.engLast(t, "T01")
		if got := e.fileOn(g.IntegrationBranch, "a.txt"); got != "by T01" {
			t.Errorf("a.txt on the integration branch: %q", got)
		}
		if got := e.repo.Git("log", "--format=%s", "--first-parent", g.IntegrationBranch); got != "Merge T01: Add a file\nfirst" {
			t.Errorf("the integration branch: %q", got)
		}
		if got := e.repo.Git("log", "--format=%s", "aiwb/r_recg/T01"); got != "T01: Add a file\nfirst" {
			t.Errorf("the task's branch: %q", got)
		}
		if a.Head == "" || a.Merged == "" || a.Worktree != "" || engExists(filepath.Join(e.s.Store.P.RunWorkDir(r.id), "T01")) {
			t.Errorf("attempt: %+v", a)
		}
		if c, err := readChanges(r.dir, "T01", 1); err != nil || len(c.Files) != 1 || c.Merged != a.Merged {
			t.Errorf("changes: %+v, %v", c, err)
		}
		if ks := engKinds(t, r); engCount(ks, KTaskEnded) != 1 {
			t.Errorf("task_ended entries: %d", engCount(ks, KTaskEnded))
		}
	}

	t.Run("work done, no head", func(t *testing.T) {
		t.Parallel()
		e, r, _ := start(t)
		workDone(e, r)
		check(t, e, r)
	})
	t.Run("committed, head not recorded", func(t *testing.T) {
		t.Parallel()
		e, r, wt := start(t)
		workDone(e, r)
		e.git(wt, "add", "-A")
		e.git(wt, "commit", "-q", "-m", "T01: Add a file")
		check(t, e, r)
	})
	t.Run("head, no merge yet", func(t *testing.T) {
		t.Parallel()
		e, r, wt := start(t)
		workDone(e, r)
		e.git(wt, "add", "-A")
		e.git(wt, "commit", "-q", "-m", "T01: Add a file")
		head := e.git(wt, "rev-parse", "HEAD")
		e.must(r, KTaskStep, func(tx *Tx) error { tx.Task("T01").Attempts[0].Head = head; return nil })
		check(t, e, r)
	})
	t.Run("merged in git, not recorded", func(t *testing.T) {
		t.Parallel()
		e, r, wt := start(t)
		workDone(e, r)
		e.git(wt, "add", "-A")
		e.git(wt, "commit", "-q", "-m", "T01: Add a file")
		head := e.git(wt, "rev-parse", "HEAD")
		e.must(r, KTaskStep, func(tx *Tx) error { tx.Task("T01").Attempts[0].Head = head; return nil })
		e.git(r.engGit().Integration, "merge", "-q", "--no-ff", "-m", "Merge T01: Add a file", "aiwb/r_recg/T01")
		check(t, e, r)
	})
	t.Run("merged and recorded, not ended", func(t *testing.T) {
		t.Parallel()
		e, r, wt := start(t)
		workDone(e, r)
		e.git(wt, "add", "-A")
		e.git(wt, "commit", "-q", "-m", "T01: Add a file")
		head := e.git(wt, "rev-parse", "HEAD")
		g := r.engGit()
		e.git(g.Integration, "merge", "-q", "--no-ff", "-m", "Merge T01: Add a file", "aiwb/r_recg/T01")
		merged := e.git(g.Integration, "rev-parse", "HEAD")
		e.must(r, KTaskStep, func(tx *Tx) error {
			a := &tx.Task("T01").Attempts[0]
			a.Head, a.Merged, a.MergedAt = head, merged, tx.Now()
			tx.File(changesRel("T01", 1), changesData(model.AttemptChanges{Task: "T01", Attempt: 1, Head: head, Merged: merged, Files: []model.ChangedFile{{Path: "a.txt", Add: 1}}}))
			return nil
		})
		check(t, e, r)
	})

	// A task that a chat cancelled while the run was halted: the attempt is closed at once, and
	// the next start discards its checkout, with the unfinished work kept on its branch.
	t.Run("cancelled while halted", func(t *testing.T) {
		t.Parallel()
		e, r, wt := start(t)
		e.s.Boot()
		if got := r.cancelActive("T01", model.AttemptCancel{Reason: "changed my mind", Chat: "c1"}); got != "" {
			t.Fatalf("cancelActive on a halted run: %q", got)
		}
		a := r.engLast(t, "T01")
		if a.Outcome != model.TaskCancelled || a.Cancel == nil || a.Cancel.Chat != "c1" || a.Worktree != wt || a.EndedAt == 0 {
			t.Errorf("the attempt closed while halted: %+v", a)
		}
		if ag, _ := r.engAgentNamed("T01-work"); ag.Status != model.AgentCancelled {
			t.Errorf("its agent: %+v", ag)
		}
		if !engExists(wt) {
			t.Fatal("the checkout went before the next start")
		}
		if err := r.resume(); err != nil {
			t.Fatal(err)
		}
		engUntil(t, "the checkout to be discarded", func() bool { return r.engLast(t, "T01").Worktree == "" })
		if engExists(wt) {
			t.Error("the checkout of the cancelled task is still there")
		}
		if got := e.repo.Git("log", "--format=%s", "-1", "aiwb/r_recg/T01"); got != "T01: unfinished work (Add a file)" {
			t.Errorf("the cancelled task's branch: %q", got)
		}
		if len(e.host.sent("T01-work")) != 0 {
			t.Error("the cancelled task's agent ran")
		}
	})
}

// What cancelActive answers when it cannot cancel.
func TestCancelActiveRefusals(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_cancel", nil)
	engHandTask(e, r, nil)
	// The run is running and no worker has the task yet (no engine in this process).
	if got := r.cancelActive("T01", model.AttemptCancel{Reason: "x"}); got != "T01 is starting; try again in a moment" {
		t.Errorf("no worker, running: %q", got)
	}
	if got := r.cancelActive("T09", model.AttemptCancel{Reason: "x"}); got != "no task T09" {
		t.Errorf("no such task: %q", got)
	}
	e.add(r, 0, "waits", false, "T01")
	if got := r.cancelActive("T02", model.AttemptCancel{Reason: "x"}); got != "T02 is deps now; look again with get_run" {
		t.Errorf("a waiting task: %q", got)
	}
	// Phase merge is refused in every run status.
	e.must(r, KTaskStep, func(tx *Tx) error {
		a := &tx.Task("T01").Attempts[0]
		a.Phases = append(a.Phases, model.RunPhase{K: model.TaskMerge, T: tx.Now()})
		return nil
	})
	const merging = "T01 has finished and is being merged; it can no longer be cancelled."
	if got := r.cancelActive("T01", model.AttemptCancel{Reason: "x"}); got != merging {
		t.Errorf("merging, running: %q", got)
	}
	if err := r.halt(engUserStop); err != nil { // no engine: halt writes run_halted itself
		t.Fatal(err)
	}
	if st := r.engState(); st.Status != model.RunStopped || len(r.L.Stops) != 1 {
		t.Fatalf("a halt without an engine: %+v", st)
	}
	if got := r.cancelActive("T01", model.AttemptCancel{Reason: "x"}); got != merging {
		t.Errorf("merging, halted: %q", got)
	}
	if s := r.engTaskState("T01"); s != model.TaskMerge {
		t.Errorf("the task is %s", s)
	}
}

// Tokens and peak context: the activity event carries the peak as it grows, and the agent's
// record gets the tokens and the peak wherever its cost is recorded. An agent whose kind reports
// no tokens (Cursor) has none.
func TestAgentTokensAndPeak(t *testing.T) {
	t.Parallel()
	for _, reports := range []bool{true, false} {
		e, r := engOneTask(t, nil, func(m *engMsg) { m.Hang() })
		id := AgentChatID(r.id, "T01-work")
		events := make(chan engActivityEvent, 100)
		e.s.eng.onActivity = func(ev engActivityEvent) { events <- ev }
		next := func() model.RunActivity {
			t.Helper()
			select {
			case ev := <-events:
				return ev.Agents[id]
			case <-time.After(10 * time.Second):
				t.Fatal("no run_activity event")
				return model.RunActivity{}
			}
		}
		advance := func(d time.Duration) {
			t.Helper()
			engUntil(t, "the ticker to sleep", func() bool { return e.clock.DueIn(engTickEvery) > 0 })
			e.clock.Advance(d)
		}
		set := func(c chats.Cost) {
			e.host.mu.Lock()
			e.host.costs[id] = c
			e.host.mu.Unlock()
		}
		r.startEngine()
		engUntil(t, "the work agent's message", func() bool { return len(e.host.sent("T01-work")) == 1 })

		tok := model.TokenCount{In: 120, Out: 900, CacheRead: 40000, CacheWrite: 3000}
		c := chats.Cost{Peak: 31000}
		if reports {
			c = chats.Cost{USD: 0.10, Known: true, Tokens: tok, TokensKnown: true, Peak: 31000}
		}
		set(c)
		advance(2 * time.Second)
		if ev := next(); ev.PeakContext != 31000 || (ev.Cost != nil) != reports {
			t.Errorf("reports %v: event %+v", reports, ev)
		}
		r.mu.Lock()
		d := r.L.Detail(r.id, r.live())
		r.mu.Unlock()
		if a := d.Agents[id]; a.PeakContext != 31000 {
			t.Errorf("reports %v: the agent in the detail: %+v", reports, a)
		}
		// The peak grew and nothing else changed: it is sent.
		c.Peak = 64000
		set(c)
		advance(2 * time.Second)
		if ev := next(); ev.PeakContext != 64000 {
			t.Errorf("reports %v: event after the peak grew: %+v", reports, ev)
		}

		if err := r.halt(engUserStop); err != nil {
			t.Fatal(err)
		}
		engStatus(t, r, model.RunStopped)
		a, _ := r.engAgent(id)
		if a.PeakContext != 64000 {
			t.Errorf("reports %v: the recorded peak: %d", reports, a.PeakContext)
		}
		if reports && (a.Tokens == nil || *a.Tokens != tok) {
			t.Errorf("the recorded tokens: %+v", a.Tokens)
		}
		if !reports && (a.Tokens != nil || a.Cost != nil) {
			t.Errorf("an agent that reports nothing: tokens %+v, cost %v", a.Tokens, a.Cost)
		}
		raw, err := json.Marshal(a.View(Live{}))
		if err != nil {
			t.Fatal(err)
		}
		if has := strings.Contains(string(raw), `"tokens":null`); has == reports || !strings.Contains(string(raw), `"peakContext":64000`) {
			t.Errorf("reports %v: the agent on the wire: %s", reports, raw)
		}
	}
}

// The ticker: every two seconds it tells what the running agents do (only what changed), a
// moved cost at most every 15 s per agent, and the run's view takes the live cost.
func TestTickerActivity(t *testing.T) {
	t.Parallel()
	e, r := engOneTask(t, nil, func(m *engMsg) { m.Hang() })
	id := AgentChatID(r.id, "T01-work")
	events := make(chan engActivityEvent, 100)
	e.s.eng.onActivity = func(ev engActivityEvent) { events <- ev }
	next := func() engActivityEvent {
		t.Helper()
		select {
		case ev := <-events:
			return ev
		case <-time.After(10 * time.Second):
			t.Fatal("no run_activity event")
			return engActivityEvent{}
		}
	}
	none := func(what string) {
		t.Helper()
		select {
		case ev := <-events:
			t.Fatalf("%s: an event was sent: %+v", what, ev)
		case <-time.After(40 * time.Millisecond):
		}
	}
	// advance moves the clock once the ticker sleeps on it: a move made while the ticker is
	// between two sleeps is lost on it.
	advance := func(d time.Duration) {
		t.Helper()
		engUntil(t, "the ticker to sleep", func() bool { return e.clock.DueIn(engTickEvery) > 0 })
		e.clock.Advance(d)
	}
	r.startEngine()
	engUntil(t, "the work agent's message", func() bool { return len(e.host.sent("T01-work")) == 1 })
	advance(2 * time.Second)
	none("nothing to tell")

	res := "ok"
	e.host.mu.Lock()
	e.host.acts[id] = chats.Activity{Tools: 3, Last: model.Item{Kind: "tool", Name: "Bash", Input: []byte(`{"command":"go test ./...\necho done","description":"run the tests"}`), Result: &res}}
	e.host.costs[id] = chats.Cost{USD: 0.10, Known: true}
	e.host.mu.Unlock()
	advance(2 * time.Second)
	ev := next()
	if ev.Type != "run_activity" || ev.Run != r.id || len(ev.Agents) != 1 || ev.Agents[id].Tools != 3 || ev.Agents[id].Activity != "Bash: go test ./..." ||
		ev.Agents[id].Cost == nil || *ev.Agents[id].Cost != 0.10 {
		t.Errorf("event: %+v", ev)
	}
	// The detail of a record sent now carries the live values, and the view the live cost.
	r.mu.Lock()
	live := r.live()
	d := r.L.Detail(r.id, live)
	r.mu.Unlock()
	if a := d.Agents[id]; a.Tools != 3 || a.Activity != "Bash: go test ./..." || a.Cost == nil || *a.Cost != 0.10 {
		t.Errorf("the agent in the detail: %+v", a)
	}
	if len(live) != 1 {
		t.Errorf("live values of %d agents", len(live))
	}
	engUntil(t, "the view's cost", func() bool { c := r.viewNow().Cost; return c != nil && *c == 0.10 })

	// Nothing changed: nothing is sent.
	advance(2 * time.Second)
	none("nothing changed")
	// The cost moved, within 15 s of the last one sent: it waits; the tool count does not.
	e.host.mu.Lock()
	e.host.acts[id] = chats.Activity{Tools: 4, Last: model.Item{Kind: "tool", Name: "Read", Input: []byte(`{"file_path":"/work/a.go"}`)}}
	e.host.costs[id] = chats.Cost{USD: 0.20, Known: true}
	e.host.mu.Unlock()
	advance(2 * time.Second)
	if ev := next(); ev.Agents[id].Tools != 4 || ev.Agents[id].Activity != "Read: /work/a.go" || ev.Agents[id].Cost != nil {
		t.Errorf("event within 15 s: %+v", ev.Agents[id])
	}
	advance(12 * time.Second)
	if ev := next(); ev.Agents[id].Cost == nil || *ev.Agents[id].Cost != 0.20 {
		t.Errorf("event after 15 s: %+v", ev.Agents[id])
	}
	engUntil(t, "the view's cost", func() bool { c := r.viewNow().Cost; return c != nil && *c == 0.20 })

	// An agent that is no longer running has no live values: its record is what counts.
	if err := r.halt(engUserStop); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunStopped)
	r.mu.Lock()
	live = r.live()
	r.mu.Unlock()
	if live != nil {
		t.Errorf("live values after the halt: %v", live)
	}
	if a, _ := r.engAgent(id); a.Cost == nil || *a.Cost != 0.20 {
		t.Errorf("the recorded cost: %v", a.Cost)
	}

	// The label of a tool item.
	for _, c := range []struct{ name, input, want string }{
		{"Grep", `{"pattern":"func main","path":"."}`, "Grep: func main"},
		{"mcp__board__spawn_subagent", `{"task":"look at the tests","agent":"claude"}`, "spawn_subagent: look at the tests"},
		{"mcp__board__get_run", `{}`, "get_run"},
		{"mcp__board__", `{}`, "mcp__board__"},
		{"TodoWrite", `{"todos":[]}`, "TodoWrite"},
		{"Bash", `{"command":"` + strings.Repeat("x", 200) + `"}`, "Bash: " + strings.Repeat("x", 113) + "…"},
		{"Odd", `not json`, "Odd"},
	} {
		if got := engActivityLabel(model.Item{Kind: "tool", Name: c.name, Input: []byte(c.input)}); got != c.want {
			t.Errorf("label of %s: %q", c.name, got)
		}
	}
	if got := engActivityLabel(model.Item{Kind: "text", Text: "hello"}); got != "" {
		t.Errorf("label of a text item: %q", got)
	}
}

func TestGitVersionCheck(t *testing.T) {
	t.Parallel()
	for out, ok := range map[string]bool{
		"git version 2.50.1 (Apple Git-155)\n": true,
		"git version 2.27.0\n":                 true,
		"git version 3.0.0\n":                  true,
		"git version 2.26.3\n":                 false,
		"git version 1.9.5.windows.1\n":        false,
		"something else\n":                     false,
	} {
		err := engGitTooOld(out)
		if (err == nil) != ok {
			t.Errorf("%q: %v", out, err)
		}
		if err != nil && !strings.Contains(err.Error(), "needs git 2.27 or newer") {
			t.Errorf("%q: the refusal does not say what is needed: %v", out, err)
		}
	}
	if got := engGitTooOld("git version 2.20.1").Error(); got != "git 2.20 is too old for runs: a run in a git repository needs git 2.27 or newer" {
		t.Errorf("the refusal: %q", got)
	}
	for d, want := range map[time.Duration]string{42 * time.Second: "42s", 327 * time.Second: "5m27s", 3900 * time.Second: "1h05m", 3 * time.Hour: "3h00m"} {
		if got := engDuration(d); got != want {
			t.Errorf("engDuration(%v) = %q", d, got)
		}
	}
}

// An engine that cannot use the run's repository halts the run with a sentence that says so,
// and starts nothing.
func TestEngineGitUnusable(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.run("r_nogitnow", nil)
	gone := filepath.Join(t.TempDir(), "moved-away")
	e.must(r, KOp, func(tx *Tx) error { tx.State().Git.Repo = gone; return nil })
	e.play(r, nil, nil)
	r.startEngine()
	engStatus(t, r, model.RunError)
	if st := r.engState(); !strings.HasPrefix(st.Reason, "git cannot use "+gone+" any more: ") {
		t.Errorf("reason: %q", st.Reason)
	}
	if len(e.host.all()) != 0 || len(r.engTurns()) != 0 || r.L.Stops[0].Reason != model.StopError {
		t.Errorf("something started: %v", e.host.names())
	}
}

// What a delete of a run uses: stopEngine ends the scheduler and every worker without an entry,
// and removeCheckouts takes every checkout of the run and leaves its branches.
func TestStopEngineAndRemoveCheckouts(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.run("r_del", nil)
	e.play(r, func() { e.add(r, 1, "Add a file", true); e.add(r, 1, "Look", false) }, func(m *engMsg) bool {
		if m.Role == model.RoleTask {
			engWrite(t, m.Cwd, "wip.txt", "half\n")
			m.Hang()
			return true
		}
		return false
	})
	r.startEngine()
	engUntil(t, "both work agents", func() bool { return len(e.host.sent("T01-work")) == 1 && len(e.host.sent("T02-work")) == 1 })
	work := e.s.Store.P.RunWorkDir(r.id)
	entries := len(readEntries(t, r.dir))
	stops := len(e.host.stoppedNames())
	if !r.stopEngine(10 * time.Second) {
		t.Fatal("the engine did not stop")
	}
	if r.engHasEngine() || r.engSt() != model.RunRunning || engCount(engKinds(t, r), KRunHalted) != 0 {
		t.Errorf("after stopEngine: engine %v, status %s", r.engHasEngine(), r.engSt())
	}
	if n := len(e.host.stoppedNames()); n != stops {
		t.Errorf("stopEngine closed %d agent process(es)", n-stops)
	}
	// The workers only recorded that their agents were interrupted.
	for _, en := range readEntries(t, r.dir)[entries:] {
		if en.Kind != KAgent {
			t.Errorf("an entry of kind %s was written by stopEngine", en.Kind)
		}
	}
	if !r.stopEngine(time.Second) { // again: nothing runs
		t.Error("stopEngine with no engine is not true")
	}
	if err := r.removeCheckouts(t.Context()); err != nil {
		t.Fatal(err)
	}
	if engExists(work) {
		t.Error("the checkouts are still there")
	}
	if got := e.repo.Git("worktree", "list", "--porcelain"); strings.Count(got, "worktree ") != 1 {
		t.Errorf("work trees still listed: %s", got)
	}
	// The run's branches go with its checkouts: nothing was merged, so no result is kept.
	if got := e.repo.Git("branch", "--format=%(refname:short)"); got != "main" {
		t.Errorf("branches: %q", got)
	}
	if err := r.removeCheckouts(t.Context()); err != nil { // nothing left: nothing to do
		t.Errorf("a second removeCheckouts: %v", err)
	}
}
