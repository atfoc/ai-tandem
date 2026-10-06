package runs

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

// This file is the orchestrator's wait: when the next turn starts in each wake mode, what a turn
// records of the wait it started under, and that the wait is in the journal and the checkpoint.

// waitSet records what wait_for would: the wait of turn n on the tasks named.
func (e *engEnv) waitSet(r *run, turn int, mode string, tasks ...string) {
	e.t.Helper()
	e.must(r, KOp, func(tx *Tx) error {
		tx.State().Wait = &model.RunWait{Tasks: tasks, Mode: mode, Turn: turn}
		tx.Head(Entry{Op: "wait_for", Turn: turn})
		return nil
	})
}

func turnReasons(r *run) string {
	var out []string
	for _, tn := range r.engTurns() {
		out = append(out, tn.Reason)
	}
	return strings.Join(out, " ")
}

func TestWaitMet(t *testing.T) {
	l := &Loaded{Tasks: []Task{taskIn("T01", model.TaskDone), taskIn("T02", model.TaskWork), taskIn("T03", model.TaskFailed),
		taskIn("T04", model.TaskCancelled), taskIn("T05", model.TaskBlocked), taskIn("T06", model.TaskHeld)}}
	if met, set := engWaitMet(l); met || set {
		t.Errorf("no wait: met %v, set %v", met, set)
	}
	for _, c := range []struct {
		mode  string
		tasks []string
		met   bool
	}{
		{"all", []string{"T01"}, true},
		{"all", []string{"T01", "T03", "T04"}, true},
		{"all", []string{"T01", "T02"}, false},
		{"all", []string{"T05"}, false},
		{"all", []string{"T06"}, false},
		{"any", []string{"T02", "T05", "T06"}, false},
		{"any", []string{"T02", "T04"}, true},
		{"any", []string{"T03", "T02"}, true},
		{"", []string{"T01", "T02"}, false},   // no mode is all
		{"all", []string{"T01", "T99"}, true}, // a task that is not there holds nothing back
	} {
		l.State.Wait = &model.RunWait{Tasks: c.tasks, Mode: c.mode, Turn: 1}
		if met, set := engWaitMet(l); met != c.met || !set {
			t.Errorf("%s of %v: met %v, set %v", c.mode, c.tasks, met, set)
		}
	}
}

// The decision table of turnReason: every wake mode, with no wait, one that is not met and one
// that is (all and any), every kind of inbox, with something running or not, after a person's
// resume or not.
func TestTurnReasonTable(t *testing.T) {
	inboxes := map[string][]model.RunEvent{
		"empty":  nil,
		"done":   {{Seq: 1, Type: "task_done", Task: "T01"}},
		"failed": {{Seq: 1, Type: "task_done", Task: "T01"}, {Seq: 2, Type: "task_failed", Task: "T09"}},
		"chat":   {{Seq: 1, Type: "chat_op", Chat: "c1"}},
	}
	// The tasks of a wait on T01 and T02, by whether it is met. A wait that is not met has a task
	// that has not ended, so the run is idle then only when that task is blocked.
	waits := []struct {
		name, mode string
		t1, t2     model.TaskState
		met        bool
	}{
		{"unset", "", model.TaskDone, model.TaskDone, false},
		{"all unmet", "all", model.TaskDone, model.TaskWork, false},
		{"any unmet", "any", model.TaskWork, model.TaskWork, false},
		{"all met", "all", model.TaskDone, model.TaskCancelled, true},
		{"any met", "any", model.TaskFailed, model.TaskWork, true},
	}
	n := 0
	for _, wake := range []string{"declared", "", "each", "idle"} {
		for _, w := range waits {
			for _, inbox := range []string{"empty", "done", "failed", "chat"} {
				for _, idle := range []bool{false, true} {
					for _, resumed := range []bool{false, true} {
						t1, t2 := w.t1, w.t2
						l := &Loaded{Turns: []Turn{{N: 1, Status: "done"}}}
						if idle { // nothing runs: what has not ended is blocked
							for _, s := range []*model.TaskState{&t1, &t2} {
								if !s.Final() {
									*s = model.TaskBlocked
								}
							}
						} else {
							l.Tasks = append(l.Tasks, taskIn("T03", model.TaskWork))
						}
						l.Tasks = append(l.Tasks, taskIn("T01", t1), taskIn("T02", t2))
						if w.mode != "" {
							l.State.Wait = &model.RunWait{Tasks: []string{"T01", "T02"}, Mode: w.mode, Turn: 1}
						}
						l.State.Inbox = inboxes[inbox]
						if got := engIdle(l); got != idle {
							t.Fatalf("the case is wrong: idle %v, want %v", got, idle)
						}
						e := &engine{r: &run{}, person: resumed}
						e.r.meta.Settings.Wake = wake

						declared := wake == "declared" || wake == ""
						urgent := inbox == "failed" || inbox == "chat"
						want := ""
						switch {
						case idle && resumed:
							want = "resume"
						case declared && w.met:
							want = "wait"
						case idle:
							want = "idle"
						case inbox == "empty":
						case wake == "each", declared && w.mode == "", urgent:
							want = "events"
						}
						name := fmt.Sprintf("wake %q, wait %s, inbox %s, idle %v, resumed %v", wake, w.name, inbox, idle, resumed)
						if got := e.turnReason(l, idle); got != want {
							t.Errorf("%s: %q, want %q", name, got, want)
						}
						// Once the engine has started a turn, the resume is used up.
						e.turned = true
						if want == "resume" {
							want = "idle"
							if declared && w.met {
								want = "wait"
							}
						}
						if got := e.turnReason(l, idle); got != want {
							t.Errorf("%s, after a turn: %q, want %q", name, got, want)
						}
						n++
					}
				}
			}
		}
	}
	if n != 4*5*4*2*2 {
		t.Errorf("%d cases", n)
	}

	// Rows of the table spelled out, so that the test does not only repeat the rule.
	run2 := func(wake string, wait *model.RunWait, t1, t2 model.TaskState, inbox string, resumed bool) string {
		l := &Loaded{Turns: []Turn{{N: 1, Status: "done"}}, Tasks: []Task{taskIn("T01", t1), taskIn("T02", t2)}}
		l.State.Wait, l.State.Inbox = wait, inboxes[inbox]
		e := &engine{r: &run{}, person: resumed}
		e.r.meta.Settings.Wake = wake
		return e.turnReason(l, engIdle(l))
	}
	all, any := &model.RunWait{Tasks: []string{"T01", "T02"}, Mode: "all"}, &model.RunWait{Tasks: []string{"T01", "T02"}, Mode: "any"}
	const done, work, failed, cancelled, blocked = model.TaskDone, model.TaskWork, model.TaskFailed, model.TaskCancelled, model.TaskBlocked
	for _, c := range []struct {
		wake    string
		wait    *model.RunWait
		t1, t2  model.TaskState
		inbox   string
		resumed bool
		want    string
	}{
		{"declared", all, done, work, "done", false, ""},              // the first of two finished
		{"declared", all, done, done, "done", false, "wait"},          // both did
		{"declared", any, done, work, "done", false, "wait"},          // one is enough
		{"declared", any, work, work, "empty", false, ""},             //
		{"declared", all, failed, work, "failed", false, "events"},    // a failure starts it early
		{"declared", all, work, work, "chat", false, "events"},        // a chat's change too
		{"declared", all, cancelled, done, "empty", false, "wait"},    // met by a cancel, nothing new
		{"declared", all, cancelled, blocked, "empty", false, "idle"}, // nothing left running, not met
		{"declared", all, done, done, "done", true, "resume"},         // a person's resume comes first
		{"declared", all, done, work, "done", true, ""},               // but only when nothing runs
		{"declared", nil, done, work, "done", false, "events"},        // no wait: as each
		{"declared", nil, work, work, "empty", false, ""},             //
		{"each", all, done, work, "done", false, "events"},            // each does not know a wait
		{"each", all, done, done, "empty", false, "idle"},             //
		{"idle", nil, done, work, "done", false, ""},                  //
		{"idle", any, done, work, "done", false, ""},                  // idle does not know one either
		{"idle", nil, done, work, "failed", false, "events"},          //
		{"idle", nil, done, done, "done", false, "idle"},              //
	} {
		if got := run2(c.wake, c.wait, c.t1, c.t2, c.inbox, c.resumed); got != c.want {
			t.Errorf("wake %s, wait %+v, T01 %s, T02 %s, inbox %s, resumed %v: %q, want %q", c.wake, c.wait, c.t1, c.t2, c.inbox, c.resumed, got, c.want)
		}
	}
	// The first turn is "start" whatever else holds.
	e := &engine{r: &run{}, person: true}
	if got := e.turnReason(&Loaded{State: State{Wait: all}}, true); got != "start" {
		t.Errorf("no turn yet: %q", got)
	}
}

func TestIdleTurnCounts(t *testing.T) {
	for _, c := range []struct {
		reason string
		idle   bool
		want   bool
	}{
		{"idle", true, true}, {"wait", true, true}, {"wait", false, false}, {"events", false, false},
		{"resume", true, false}, {"start", true, false},
	} {
		if got := engIdleTurn(c.reason, c.idle); got != c.want {
			t.Errorf("%s, idle %v: %v", c.reason, c.idle, got)
		}
	}
}

// In wake mode declared (the default) a wait on two tasks holds the next turn back until both
// have ended. The turn records the wait and that it was met, and the wait is gone from the state;
// with no wait the run behaves as in each.
func TestWaitAllOfTwo(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_waitall", nil)
	if r.meta.Settings.Wake != "declared" {
		t.Fatalf("the default wake mode is %q", r.meta.Settings.Wake)
	}
	e.gates.block("T01-work", "T02-work", "T03-work", "T04-work")
	e.play(r, func() {
		for _, title := range []string{"one", "two", "three", "four"} {
			e.add(r, 1, title, false)
		}
		e.waitSet(r, 1, "all", "T01", "T02")
	}, nil)
	r.startEngine()
	engTask(t, r, "T04", model.TaskWork)
	want := &model.RunWait{Tasks: []string{"T01", "T02"}, Mode: "all", Turn: 1}
	if st := r.engState(); !reflect.DeepEqual(st.Wait, want) {
		t.Fatalf("the wait after turn 1: %+v", st.Wait)
	}
	if tn := r.engTurns()[0]; tn.Wait != nil || tn.WaitMet {
		t.Errorf("turn 1 has a wait: %+v", tn)
	}
	if v := r.view.Load(); v == nil || !reflect.DeepEqual(v.Wait, want) {
		t.Errorf("the view's wait: %+v", v.Wait)
	}

	e.gates.open("T01-work")
	engTask(t, r, "T01", model.TaskDone)
	time.Sleep(50 * time.Millisecond)
	if n := len(r.engTurns()); n != 1 {
		t.Fatalf("a turn started when the first of two finished (%d turns)", n)
	}
	if st := r.engState(); st.Wait == nil || len(st.Inbox) != 1 {
		t.Fatalf("while waiting: wait %+v, inbox %+v", st.Wait, st.Inbox)
	}

	e.gates.open("T02-work")
	engUntil(t, "turn 2", func() bool { ts := r.engTurns(); return len(ts) == 2 && ts[1].Status == "done" })
	tn := r.engTurns()[1]
	if tn.Reason != "wait" || tn.Idle || !tn.WaitMet || !reflect.DeepEqual(tn.Wait, want) ||
		len(tn.WokenBy) != 2 || tn.WokenBy[0].Task != "T01" || tn.WokenBy[1].Task != "T02" {
		t.Errorf("turn 2: %+v", tn)
	}
	if st := r.engState(); st.Wait != nil || len(st.Inbox) != 0 || st.IdleStreak != 0 {
		t.Errorf("after turn 2: wait %+v, inbox %+v, streak %d", st.Wait, st.Inbox, st.IdleStreak)
	}
	if v := r.view.Load(); v == nil || v.Wait != nil {
		t.Errorf("the view still has a wait: %+v", v.Wait)
	}

	// Turn 2 declared nothing: the next finished task starts a turn.
	e.gates.open("T03-work")
	engUntil(t, "turn 3", func() bool { ts := r.engTurns(); return len(ts) == 3 && ts[2].Status == "done" })
	if tn := r.engTurns()[2]; tn.Reason != "events" || tn.Wait != nil || tn.WaitMet || len(tn.WokenBy) != 1 || tn.WokenBy[0].Task != "T03" {
		t.Errorf("turn 3: %+v", tn)
	}
	r.stopEngine(10 * time.Second)
}

// A wait for any of its tasks is met by the first that ends.
func TestWaitAnyOfTwo(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_waitany", nil)
	e.gates.block("T01-work", "T02-work", "T03-work")
	e.play(r, func() {
		e.add(r, 1, "one", false)
		e.add(r, 1, "two", false)
		e.add(r, 1, "three", false)
		e.waitSet(r, 1, "any", "T01", "T02")
	}, nil)
	r.startEngine()
	engTask(t, r, "T03", model.TaskWork)
	e.gates.open("T03-work") // not one of them
	engTask(t, r, "T03", model.TaskDone)
	time.Sleep(50 * time.Millisecond)
	if n := len(r.engTurns()); n != 1 {
		t.Fatalf("a turn started for a task that is not waited for (%d turns)", n)
	}
	e.gates.open("T02-work")
	engUntil(t, "turn 2", func() bool { ts := r.engTurns(); return len(ts) == 2 && ts[1].Status == "done" })
	tn := r.engTurns()[1]
	if tn.Reason != "wait" || tn.Idle || !tn.WaitMet || tn.Wait == nil || tn.Wait.Mode != "any" || len(tn.WokenBy) != 2 {
		t.Errorf("turn 2: %+v", tn)
	}
	if st := r.engState(); st.Wait != nil {
		t.Errorf("the wait is still there: %+v", st.Wait)
	}
	r.stopEngine(10 * time.Second)
}

// A failed task starts the turn before the wait is met; a chat's change does too. The turn says
// what it had waited for and that it did not happen, and the wait is over all the same.
func TestWaitEndsEarly(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_waitearly", nil)
	e.gates.block("T01-work", "T02-work", "T03-work")
	e.play(r, func() {
		e.add(r, 1, "one", false)
		e.add(r, 1, "two", false)
		e.add(r, 1, "three", false)
		e.waitSet(r, 1, "all", "T02", "T03")
	}, func(m *engMsg) bool {
		switch m.Name {
		case "T01-work":
			m.Block("failed", "Could not do one.", "why")
			return true
		case "turn-002":
			e.waitSet(r, 2, "all", "T02", "T03")
			m.Say("still waiting")
			return true
		}
		return false
	})
	r.startEngine()
	engTask(t, r, "T03", model.TaskWork)
	e.gates.open("T01-work")
	engUntil(t, "turn 2", func() bool { ts := r.engTurns(); return len(ts) == 2 && ts[1].Status == "done" })
	tn := r.engTurns()[1]
	if tn.Reason != "events" || tn.Idle || tn.WaitMet || tn.Wait == nil || tn.Wait.Turn != 1 ||
		len(tn.WokenBy) != 1 || tn.WokenBy[0].Type != "task_failed" {
		t.Errorf("turn 2: %+v", tn)
	}
	// Turn 2 waits again; a chat's change starts turn 3 before that is met.
	if st := r.engState(); st.Wait == nil || st.Wait.Turn != 2 {
		t.Fatalf("the wait of turn 2: %+v", st.Wait)
	}
	e.must(r, KOp, func(tx *Tx) error {
		tx.Event(model.RunEvent{Type: "chat_op", Chat: "c1", Text: "A chat on the run says: hurry."})
		return nil
	})
	engUntil(t, "turn 3", func() bool { ts := r.engTurns(); return len(ts) == 3 && ts[2].Status == "done" })
	tn = r.engTurns()[2]
	if tn.Reason != "events" || tn.WaitMet || tn.Wait == nil || tn.Wait.Turn != 2 || len(tn.WokenBy) != 1 || tn.WokenBy[0].Type != "chat_op" {
		t.Errorf("turn 3: %+v", tn)
	}
	if st := r.engState(); st.Wait != nil || st.IdleStreak != 0 {
		t.Errorf("after turn 3: wait %+v, streak %d", st.Wait, st.IdleStreak)
	}
	r.stopEngine(10 * time.Second)
}

// A cancel records no event. A wait it meets starts a "wait" turn with nothing new; a wait it
// leaves unmet, with nothing left running, starts an "idle" turn.
func TestWaitAndACancel(t *testing.T) {
	t.Parallel()
	for _, mode := range []string{"any", "all"} {
		e := newEngEnv(t, false)
		r := e.run("r_waitcancel_"+mode, nil)
		e.gates.block("T01-work")
		e.play(r, func() {
			e.add(r, 1, "one", false)
			e.add(r, 1, "two", false, "T01") // blocked for good once T01 is cancelled
			e.waitSet(r, 1, mode, "T01", "T02")
		}, nil)
		r.startEngine()
		engTask(t, r, "T01", model.TaskWork)
		if got := r.cancelActive("T01", model.AttemptCancel{Reason: "not needed", Chat: "c1"}); got != "" {
			t.Fatalf("cancelActive: %q", got)
		}
		engUntil(t, "turn 2", func() bool { ts := r.engTurns(); return len(ts) >= 2 && ts[1].Status == "done" })
		engTask(t, r, "T02", model.TaskBlocked)
		tn := r.engTurns()[1]
		wantReason, wantMet := "wait", true
		if mode == "all" {
			wantReason, wantMet = "idle", false
		}
		if tn.Reason != wantReason || !tn.Idle || tn.WaitMet != wantMet || tn.Wait == nil || tn.Wait.Mode != mode || len(tn.WokenBy) != 0 {
			t.Errorf("%s: turn 2: %+v", mode, tn)
		}
		// Either way the turn started with nothing running: it counts in the streak.
		engStatus(t, r, model.RunStalled)
		if st := r.engState(); st.Wait != nil || st.IdleStreak != 3 || st.StalledBy != model.StalledIdle {
			t.Errorf("%s: state %+v", mode, st)
		}
		if got := turnReasons(r); got != "start "+wantReason+" idle idle" {
			t.Errorf("%s: turn reasons: %s", mode, got)
		}
	}
}

// Turns that start because their wait was met, with nothing running, count as idle turns: the
// run stalls at the limit, as it does with "idle" turns. A person's resume starts the count again.
func TestWaitIdleStreak(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_waitstreak", nil)
	e.play(r, func() {
		e.add(r, 1, "one", false)
		e.waitSet(r, 1, "all", "T01")
	}, func(m *engMsg) bool {
		if m.Role == model.RoleOrchestrator && m.Name != "turn-001" {
			n := len(r.engTurns())
			e.waitSet(r, n, "all", "T01") // adds no work and waits for what has ended
			m.Say("waiting")
			return true
		}
		return false
	})
	r.startEngine()
	engStatus(t, r, model.RunStalled)
	st := r.engState()
	if st.StalledBy != model.StalledIdle || st.IdleStreak != 3 ||
		st.Reason != "the orchestrator was started 3 times in a row with nothing running and neither added work nor finished the run" {
		t.Errorf("state: %+v", st)
	}
	if got := turnReasons(r); got != "start wait wait wait" {
		t.Errorf("turn reasons: %s", got)
	}
	for _, tn := range r.engTurns()[1:] {
		if !tn.Idle || !tn.WaitMet || tn.Wait == nil || tn.Wait.Turn != tn.N-1 {
			t.Errorf("turn %d: %+v", tn.N, tn)
		}
	}
	// The wait of the last turn is still in the state: no turn started that would have ended it.
	if st.Wait == nil || st.Wait.Turn != 4 {
		t.Errorf("the wait at the stall: %+v", st.Wait)
	}

	// Resumed by the person: a "resume" turn, which does not count, though its wait was met.
	e.clock.Advance(time.Minute)
	if err := r.resume(); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunStalled)
	if got := turnReasons(r); got != "start wait wait wait resume wait wait wait" {
		t.Errorf("turn reasons after the resume: %s", got)
	}
	if tn := r.engTurns()[4]; !tn.WaitMet || tn.Wait == nil || tn.Wait.Turn != 4 {
		t.Errorf("the resume turn: %+v", tn)
	}
	if st := r.engState(); st.IdleStreak != 3 {
		t.Errorf("streak after the second stall: %d", st.IdleStreak)
	}
}

// A "wait" turn that starts while other tasks still run does not count as idle.
func TestWaitTurnWithWorkRunningIsNotIdle(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_waitbusy", func(m *model.RunMeta) { m.Settings.MaxIdleTurns = 1 })
	e.gates.block("T02-work")
	e.play(r, func() {
		e.add(r, 1, "one", false)
		e.add(r, 1, "two", false)
		e.waitSet(r, 1, "any", "T01", "T02")
	}, func(m *engMsg) bool {
		if m.Role == model.RoleOrchestrator && m.Name != "turn-001" && len(r.engTurns()) < 4 {
			e.waitSet(r, len(r.engTurns()), "any", "T01", "T02")
			m.Say("waiting")
			return true
		}
		return false
	})
	r.startEngine()
	engUntil(t, "turn 4", func() bool { ts := r.engTurns(); return len(ts) == 4 && ts[3].Status == "done" })
	if got := turnReasons(r); got != "start wait wait wait" {
		t.Errorf("turn reasons: %s", got)
	}
	if st := r.engState(); st.IdleStreak != 0 || st.Status != model.RunRunning {
		t.Errorf("state: %+v", st)
	}
	r.stopEngine(10 * time.Second)
}

// A turn that fails gives its events back and not its wait: the turn after the resume starts on
// them at once.
func TestWaitNotRestoredByAFailedTurn(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_waitfail", func(m *model.RunMeta) { m.Settings.AgentRetries = 0 })
	e.gates.block("T01-work", "T02-work", "T03-work")
	e.play(r, func() {
		e.add(r, 1, "one", false)
		e.add(r, 1, "two", false)
		e.add(r, 1, "three", false)
		e.waitSet(r, 1, "all", "T01", "T02")
	}, func(m *engMsg) bool {
		if m.Name == "turn-002" {
			m.Fail("the model is overloaded", "")
			return true
		}
		return false
	})
	r.startEngine()
	engTask(t, r, "T03", model.TaskWork)
	e.gates.open("T01-work")
	e.gates.open("T02-work")
	engStatus(t, r, model.RunError)
	ts := r.engTurns()
	if len(ts) != 2 || ts[1].Status != "failed" || ts[1].Reason != "wait" || !ts[1].WaitMet || ts[1].Wait == nil {
		t.Fatalf("turns: %+v", ts)
	}
	if st := r.engState(); st.Wait != nil || len(st.Inbox) != 2 {
		t.Fatalf("after the failed turn: wait %+v, inbox %+v", st.Wait, st.Inbox)
	}
	e.play(r, nil, nil)
	if err := r.resume(); err != nil {
		t.Fatal(err)
	}
	engUntil(t, "turn 3", func() bool { ts := r.engTurns(); return len(ts) == 3 && ts[2].Status == "done" })
	if tn := r.engTurns()[2]; tn.Reason != "events" || tn.Idle || tn.Wait != nil || tn.WaitMet || len(tn.WokenBy) != 2 {
		t.Errorf("turn 3: %+v", tn)
	}
	r.stopEngine(10 * time.Second)
}

// A turn that calls wait_for and then fails takes its own wait with it: the turn after the resume
// starts on the failed turn's events at once, with work still running. A server restart between
// the failed turn and the resume does not bring the wait back.
func TestWaitOfAFailedTurnIsDropped(t *testing.T) {
	t.Parallel()
	for _, restart := range []bool{false, true} {
		e := newEngEnv(t, false)
		id := fmt.Sprintf("r_waitfailown_%v", restart)
		r := e.run(id, func(m *model.RunMeta) { m.Settings.AgentRetries = 0 })
		e.gates.block("T01-work", "T02-work", "T03-work")
		e.play(r, func() {
			e.add(r, 1, "one", false)
			e.add(r, 1, "two", false)
			e.add(r, 1, "three", false)
			e.waitSet(r, 1, "all", "T01", "T02")
		}, func(m *engMsg) bool {
			if m.Name == "turn-002" {
				e.waitSet(r, 2, "all", "T03") // what wait_for records
				m.Fail("the model is overloaded", "")
				return true
			}
			return false
		})
		r.startEngine()
		engTask(t, r, "T03", model.TaskWork)
		e.gates.open("T01-work")
		e.gates.open("T02-work")
		engStatus(t, r, model.RunError)
		if ts := r.engTurns(); len(ts) != 2 || ts[1].Status != "failed" {
			t.Fatalf("restart %v: turns: %+v", restart, ts)
		}
		if st := r.engState(); st.Wait != nil || len(st.Inbox) != 2 {
			t.Fatalf("restart %v: after the failed turn: wait %+v, inbox %+v", restart, st.Wait, st.Inbox)
		}
		if restart {
			r = e.restart(id)
			if st := loadedState(t, r); st.Wait != nil || len(st.Inbox) != 2 || st.Status != model.RunError {
				t.Fatalf("read from the run's folder: status %s, wait %+v, inbox %+v", st.Status, st.Wait, st.Inbox)
			}
		}
		e.play(r, nil, nil)
		if err := r.resume(); err != nil {
			t.Fatal(err)
		}
		engUntil(t, "turn 3", func() bool { ts := r.engTurns(); return len(ts) == 3 && ts[2].Status == "done" })
		if tn := r.engTurns()[2]; tn.Reason != "events" || tn.Idle || tn.Wait != nil || tn.WaitMet || len(tn.WokenBy) != 2 {
			t.Errorf("restart %v: turn 3: %+v", restart, tn)
		}
		if s := r.engTaskState("T03"); s != model.TaskWork {
			t.Errorf("restart %v: T03 is %s when turn 3 has ended", restart, s)
		}
		r.stopEngine(10 * time.Second)
	}
}

// A person stops the run while the orchestrator waits and work runs, and resumes it: the wait
// holds, no turn starts at the resume, and one starts when the wait is met.
func TestWaitHoldsOverAPersonsStopAndResume(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_waitstop", nil)
	e.gates.block("T01-work", "T02-work", "T03-work")
	e.play(r, func() {
		e.add(r, 1, "one", false)
		e.add(r, 1, "two", false)
		e.add(r, 1, "three", false)
		e.waitSet(r, 1, "all", "T01", "T02")
	}, nil)
	r.startEngine()
	engTask(t, r, "T03", model.TaskWork)
	e.gates.open("T01-work")
	engTask(t, r, "T01", model.TaskDone)
	if err := r.halt(engUserStop); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunStopped)
	want := &model.RunWait{Tasks: []string{"T01", "T02"}, Mode: "all", Turn: 1}
	if st := r.engState(); !reflect.DeepEqual(st.Wait, want) || len(st.Inbox) != 1 {
		t.Fatalf("stopped: wait %+v, inbox %+v", st.Wait, st.Inbox)
	}
	if err := r.resume(); err != nil {
		t.Fatal(err)
	}
	// The engine is at work again when the agents it interrupted have their second message.
	engUntil(t, "T02 and T03 to go on", func() bool { return len(e.host.sent("T02-work")) == 2 && len(e.host.sent("T03-work")) == 2 })
	time.Sleep(50 * time.Millisecond)
	if n := len(r.engTurns()); n != 1 {
		t.Fatalf("a turn started at the resume with the wait not met (%d turns: %s)", n, turnReasons(r))
	}
	if st := r.engState(); !reflect.DeepEqual(st.Wait, want) || st.Status != model.RunRunning {
		t.Fatalf("resumed: status %s, wait %+v", st.Status, st.Wait)
	}
	e.gates.open("T02-work")
	engUntil(t, "turn 2", func() bool { ts := r.engTurns(); return len(ts) == 2 && ts[1].Status == "done" })
	if tn := r.engTurns()[1]; tn.Reason != "wait" || tn.Idle || !tn.WaitMet || !reflect.DeepEqual(tn.Wait, want) || len(tn.WokenBy) != 2 {
		t.Errorf("turn 2: %+v", tn)
	}
	if st := r.engState(); st.Wait != nil {
		t.Errorf("the wait is still there: %+v", st.Wait)
	}
	r.stopEngine(10 * time.Second)
}

// The turn limit is checked when a turn is due and not before: a run at its limit goes on while
// the orchestrator waits. The wait survives the stall, and the turn after the limit is raised and
// the run resumed is a "resume" turn that says its wait was met.
func TestWaitAtTheTurnLimit(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_waitlimit", func(m *model.RunMeta) { m.Settings.MaxTurns = 1 })
	e.gates.block("T01-work", "T02-work")
	e.play(r, func() {
		e.add(r, 1, "one", false)
		e.add(r, 1, "two", false)
		e.waitSet(r, 1, "all", "T01", "T02")
	}, nil)
	r.startEngine()
	engTask(t, r, "T02", model.TaskWork)
	e.gates.open("T01-work")
	engTask(t, r, "T01", model.TaskDone)
	time.Sleep(50 * time.Millisecond)
	if st := r.engState(); st.Status != model.RunRunning || len(r.engTurns()) != 1 {
		t.Fatalf("at the limit with no turn due: status %s (%s), %d turns", st.Status, st.Reason, len(r.engTurns()))
	}
	e.gates.open("T02-work")
	engStatus(t, r, model.RunStalled)
	want := &model.RunWait{Tasks: []string{"T01", "T02"}, Mode: "all", Turn: 1}
	if st := r.engState(); st.StalledBy != model.StalledTurns || !reflect.DeepEqual(st.Wait, want) || len(st.Inbox) != 2 || len(r.engTurns()) != 1 {
		t.Fatalf("stalled: by %s, wait %+v, inbox %+v, %d turns", st.StalledBy, st.Wait, st.Inbox, len(r.engTurns()))
	}
	n := 2
	if _, err := e.s.Resume(r.id, ResumeReq{MaxTurns: &n}); err != nil {
		t.Fatal(err)
	}
	engUntil(t, "turn 2", func() bool { ts := r.engTurns(); return len(ts) == 2 && ts[1].Status == "done" })
	if tn := r.engTurns()[1]; tn.Reason != "resume" || !tn.Idle || !tn.WaitMet || !reflect.DeepEqual(tn.Wait, want) || len(tn.WokenBy) != 2 {
		t.Errorf("turn 2: %+v", tn)
	}
	if st := r.engState(); st.Wait != nil || st.IdleStreak != 0 {
		t.Errorf("after turn 2: wait %+v, streak %d", st.Wait, st.IdleStreak)
	}
	engStatus(t, r, model.RunStalled) // the next turn is due at once, at the new limit
}

// The wait is recorded state: it is read back from the journal alone and from a checkpoint, and
// so is the wait a turn started under.
func TestWaitInJournalAndCheckpoint(t *testing.T) {
	e := newTestEnv(t)
	r := e.started("r_waitrec")
	want := &model.RunWait{Tasks: []string{"T01", "T02"}, Mode: "any", Turn: 3}
	e.must(r, KTurnStarted, func(tx *Tx) error {
		tx.AddTurn(Turn{N: 1, Agent: "a1", Reason: "wait", Status: "running", StartedAt: tx.Now(), Wait: cloneWait(want), WaitMet: true})
		return nil
	})
	e.must(r, KOp, func(tx *Tx) error {
		tx.State().Wait = cloneWait(want)
		return nil
	})
	check := func(how string) {
		t.Helper()
		r = e.reopen("r_waitrec")
		r.mu.Lock()
		defer r.mu.Unlock()
		if err := r.loadLocked(); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(r.L.State.Wait, want) {
			t.Errorf("%s: the state's wait: %+v", how, r.L.State.Wait)
		}
		if tn := r.L.Turns[0]; !reflect.DeepEqual(tn.Wait, want) || !tn.WaitMet {
			t.Errorf("%s: the turn: %+v", how, tn)
		}
	}
	check("from the journal")
	if err := r.checkpoint(); err != nil {
		t.Fatal(err)
	}
	check("from the checkpoint")
	// A cleared wait is read back as none.
	e.must(r, KOp, func(tx *Tx) error {
		tx.State().Wait = nil
		return nil
	})
	want = nil
	r = e.reopen("r_waitrec")
	if st := loadedState(t, r); st.Wait != nil {
		t.Errorf("a cleared wait came back: %+v", st.Wait)
	}
}

// A server restart while the orchestrator waits: the wait holds after it, and the turn starts
// when it is met.
func TestWaitSurvivesRestart(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_waitrestart", nil)
	e.gates.block("T01-work", "T02-work")
	first := func() {
		e.add(r, 1, "one", false)
		e.add(r, 1, "two", false)
		e.waitSet(r, 1, "all", "T01", "T02")
	}
	e.play(r, first, nil)
	r.startEngine()
	engTask(t, r, "T02", model.TaskWork)
	e.gates.open("T01-work")
	engTask(t, r, "T01", model.TaskDone)
	e.s.Shutdown(10 * time.Second)
	e.clock.Advance(time.Hour)

	r = e.reload("r_waitrestart")
	want := &model.RunWait{Tasks: []string{"T01", "T02"}, Mode: "all", Turn: 1}
	if st := loadedState(t, r); !reflect.DeepEqual(st.Wait, want) || len(st.Inbox) != 1 {
		t.Fatalf("after the restart: wait %+v, inbox %+v", st.Wait, st.Inbox)
	}
	e.play(r, nil, nil)
	e.s.Boot()
	engTask(t, r, "T02", model.TaskWork)
	time.Sleep(50 * time.Millisecond)
	if n := len(r.engTurns()); n != 1 {
		t.Fatalf("a turn started after the restart with the wait not met (%d turns)", n)
	}
	e.gates.open("T02-work")
	engUntil(t, "turn 2", func() bool { ts := r.engTurns(); return len(ts) >= 2 && ts[1].Status == "done" })
	if tn := r.engTurns()[1]; tn.Reason != "wait" || !tn.WaitMet || !reflect.DeepEqual(tn.Wait, want) || len(tn.WokenBy) != 2 {
		t.Errorf("turn 2: %+v", tn)
	}
	if st := r.engState(); st.Wait != nil {
		t.Errorf("the wait is still there: %+v", st.Wait)
	}
	r.stopEngine(10 * time.Second)
}

// loadedState is the state of a run that was just read from its folder: the record is loaded first.
func loadedState(t testing.TB, r *run) State {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.loadLocked(); err != nil {
		t.Fatal(err)
	}
	return cloneState(r.L.State)
}
