package runs

import (
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// The limits of a run, what wakes the orchestrator, and the life of one agent: its timeout, its
// back-off, its repair turns, a session that is gone. All on the real chat manager, with the
// clock moved by hand.

func (h *mx) setStill(v bool) {
	h.mu.Lock()
	h.still = v
	h.mu.Unlock()
}

// steady reports whether ok holds now and still holds after the goroutines had a moment (the
// clock does not move): for "nothing happened".
func (h *mx) steady(ok func(l *Loaded) bool) bool {
	h.t.Helper()
	for i := 0; i < 15; i++ {
		if !ok(h.L()) {
			return false
		}
		time.Sleep(4 * time.Millisecond)
	}
	return true
}

// The turn limit: the run stalls when a turn is due and the limit is used up.
func TestLimitTurns(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		if n == 1 {
			a.Add("Look", false)
			a.Add("Look again", false)
		}
		a.Say("Looked at the run.")
	}, Task: func(a *mxTurn, tk Task) {
		if tk.ID == "T02" && !a.Gate("second") {
			return
		}
		a.Done("Looked.")
	}})
	h.startRun(func(m *model.RunMeta) { m.Settings.MaxTurns = 2 })
	// Turn 2 is woken by the first task. The second task still works: no turn is due, and the
	// limit, though used up, stops nothing.
	h.waitL("turn 2 to end", func(l *Loaded) bool { return len(l.Turns) == 2 && l.Turns[1].Status == "done" })
	for i := 0; i < 10; i++ {
		h.tick(2 * time.Second)
	}
	if l := h.L(); l.State.Status != model.RunRunning || mxState(l, "T02") != model.TaskWork {
		t.Fatalf("with the limit used up and no turn due: %s\n%s", l.State.Status, h.dump())
	}
	h.open("second")
	l := h.waitStatus(model.RunStalled, model.RunCompleted, model.RunError)
	if l.State.StalledBy != model.StalledTurns || l.State.Reason != "reached the limit of 2 orchestrator turns" || len(l.Turns) != 2 ||
		len(l.Stops) != 1 || l.Stops[0].Reason != model.StopStalled || mxState(l, "T02") != model.TaskDone {
		t.Fatalf("the run is %s/%s (%q), %d turns, stops %+v", l.State.Status, l.State.StalledBy, l.State.Reason, len(l.Turns), l.Stops)
	}
	if len(l.State.Inbox) != 1 || l.State.Inbox[0].Task != "T02" {
		t.Errorf("the event no turn was started for: %+v", l.State.Inbox)
	}
	h.idleEngine()
}

// The cost limit is checked at three points: when a turn is due, after every launch's end, and
// by the ticker every 15 seconds. Each is shown alone, with the other two shut out.
func TestLimitCost(t *testing.T) {
	t.Parallel()
	turn := func(cost float64, tasks int) func(a *mxTurn, n int) {
		return func(a *mxTurn, n int) {
			a.Cost(cost, 10, 10)
			if n == 1 {
				for i := 0; i < tasks; i++ {
					a.Add(fmt.Sprintf("Look %d", i+1), false)
				}
				a.Say("Planned.")
				return
			}
			mxFinishWhenDone(a)
		}
	}
	t.Run("when a turn is due", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{Turn: turn(0.02, 1), Task: func(a *mxTurn, tk Task) {
			if !a.Gate("work") {
				return
			}
			a.Done("Looked.")
		}})
		h.startRun(func(m *model.RunMeta) { m.Settings.Wake = "idle" })
		h.atGate("work")
		h.stopRun()
		// The limit is now below what the run has spent; no launch ends and the clock stands, so
		// only the check of a turn that is due can find it.
		if err := h.s().svcSetMeta(h.r(), func(m *model.RunMeta) error { m.Settings.MaxCost = 0.01; return nil }); err != nil {
			t.Fatal(err)
		}
		h.setStill(true)
		h.regate("work")
		h.resume()
		h.atGate("work")
		if !h.steady(func(l *Loaded) bool { return l.State.Status == model.RunRunning }) {
			t.Fatalf("the run halted with no turn due, no launch ended and the clock standing\n%s", h.dump())
		}
		_, token := h.newChat()
		if text, isErr := h.call(token, "tell_orchestrator", map[string]any{"text": "Please look at the cost."}); isErr {
			t.Fatal(text)
		}
		l := h.waitStatus(model.RunStalled)
		if l.State.StalledBy != model.StalledCost || l.State.Reason != "spent $0.02, over the limit of $0.01" || len(l.Turns) != 1 {
			t.Errorf("the run is %s/%s (%q), %d turns", l.State.Status, l.State.StalledBy, l.State.Reason, len(l.Turns))
		}
		h.idleEngine()
	})
	t.Run("after a launch's end", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{Turn: turn(0.10, 2), Task: func(a *mxTurn, tk Task) {
			if tk.ID == "T02" {
				if a.Gate("slow") {
					a.Done("Looked.")
				}
				return
			}
			if !a.Until(func(l *Loaded) bool { return a.h.turnsOf("T02-work") >= 1 }) {
				return
			}
			a.Cost(0.45, 40, 40)
			a.Done("Looked, at a price.")
		}})
		h.setStill(true) // no tick; and with wake "idle" no turn is due while T02 works
		h.startRun(func(m *model.RunMeta) { m.Settings.MaxCost = 0.50; m.Settings.Wake = "idle" })
		l := h.waitStatus(model.RunStalled, model.RunCompleted, model.RunError)
		if l.State.StalledBy != model.StalledCost || l.State.Reason != "spent $0.55, over the limit of $0.50" || mxState(l, "T02") != model.TaskWork {
			t.Errorf("the run is %s/%s (%q); T02 is %s", l.State.Status, l.State.StalledBy, l.State.Reason, mxState(l, "T02"))
		}
		h.idleEngine()
	})
	t.Run("on the tick", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{Turn: turn(0.10, 1), Task: func(a *mxTurn, tk Task) {
			if a.N == 1 {
				// A first message that ends without the block and costs more than the limit; the
				// launch goes on with the repair message, so no launch ends.
				a.Cost(0.60, 60, 60)
				a.Say("I have looked.")
				return
			}
			if a.Gate("repair") {
				a.Done("Looked.")
			}
		}})
		h.setStill(true)
		h.startRun(func(m *model.RunMeta) { m.Settings.MaxCost = 0.50; m.Settings.Wake = "idle" })
		h.atGate("repair")
		if !h.steady(func(l *Loaded) bool { return l.State.Status == model.RunRunning }) {
			t.Fatalf("the run halted before the ticker looked\n%s", h.dump())
		}
		h.setStill(false)
		l := h.waitStatus(model.RunStalled, model.RunCompleted, model.RunError)
		if l.State.StalledBy != model.StalledCost || l.State.Reason != "spent $0.70, over the limit of $0.50" {
			t.Errorf("the run is %s/%s (%q)", l.State.Status, l.State.StalledBy, l.State.Reason)
		}
		if a, _ := mxAgent(l, "T01-work"); a.Status != model.AgentInterrupted || a.Cost == nil || *a.Cost != 0.60 {
			t.Errorf("the agent that was working: %s, cost %v", a.Status, a.Cost)
		}
		h.idleEngine()
	})
}

// Two limits reached at once: the order idle, turns, cost decides which one the run records.
func TestLimitOrder(t *testing.T) {
	t.Parallel()
	t.Run("idle before turns and cost", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
			if n == 3 && !a.Gate("third") {
				return
			}
			a.Say("Nothing to do.")
		}})
		h.startRun(func(m *model.RunMeta) { m.Settings.MaxIdleTurns = 2; m.Settings.MaxTurns = 3 })
		h.atGate("third")
		// While turn 3 runs the run is stopped and its cost limit set below... nothing was spent,
		// so the cost limit cannot be reached here: idle and turns are.
		h.open("third")
		l := h.waitStatus(model.RunStalled, model.RunCompleted, model.RunError)
		if l.State.StalledBy != model.StalledIdle || len(l.Turns) != 3 || l.State.IdleStreak != 2 ||
			l.State.Reason != "the orchestrator was started 2 times in a row with nothing running and neither added work nor finished the run" {
			t.Fatalf("the run is %s/%s (%q), %d turns, streak %d", l.State.Status, l.State.StalledBy, l.State.Reason, len(l.Turns), l.State.IdleStreak)
		}
		h.idleEngine()
		// The resume of a run that stalled on idle starts the count again; the turn limit is the
		// next thing in its way, once the resume's own turn is due.
		h.resume()
		l = h.waitStatus(model.RunStalled, model.RunCompleted, model.RunError)
		if l.State.StalledBy != model.StalledTurns || l.State.IdleStreak != 0 || len(l.Turns) != 3 {
			t.Errorf("after the resume: %s/%s (%q), %d turns, streak %d", l.State.Status, l.State.StalledBy, l.State.Reason, len(l.Turns), l.State.IdleStreak)
		}
	})
	t.Run("turns before cost", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
			a.Cost(0.02, 10, 10)
			if n == 1 {
				a.Add("Look", false)
				a.Say("One task.")
				return
			}
			mxFinishWhenDone(a)
		}, Task: func(a *mxTurn, tk Task) {
			if a.Gate("work") {
				a.Done("Looked.")
			}
		}})
		h.startRun(func(m *model.RunMeta) { m.Settings.Wake = "idle" })
		h.atGate("work")
		h.stopRun()
		// Both limits are used up now. The clock stands and no launch ends, so they are found
		// only when a turn is due.
		if err := h.s().svcSetMeta(h.r(), func(m *model.RunMeta) error { m.Settings.MaxCost, m.Settings.MaxTurns = 0.01, 1; return nil }); err != nil {
			t.Fatal(err)
		}
		h.setStill(true)
		h.regate("work")
		h.resume()
		h.atGate("work")
		_, token := h.newChat()
		if text, isErr := h.call(token, "tell_orchestrator", map[string]any{"text": "Please look."}); isErr {
			t.Fatal(text)
		}
		l := h.waitStatus(model.RunStalled)
		if l.State.StalledBy != model.StalledTurns || l.State.Reason != "reached the limit of 1 orchestrator turn" {
			t.Fatalf("the run is %s/%s (%q)", l.State.Status, l.State.StalledBy, l.State.Reason)
		}
		h.idleEngine()
		// With the turn limit raised, the cost limit is what stops the same turn from starting.
		n := 5
		h.regate("work")
		if _, err := h.s().Resume(h.id, ResumeReq{MaxTurns: &n}); err != nil {
			t.Fatal(err)
		}
		l = h.waitStatus(model.RunStalled)
		if l.State.StalledBy != model.StalledCost || len(l.Turns) != 1 || len(l.Stops) != 3 {
			t.Errorf("after the turn limit was raised: %s/%s (%q), %d turns, %d stops", l.State.Status, l.State.StalledBy, l.State.Reason, len(l.Turns), len(l.Stops))
		}
		h.idleEngine()
	})
}

// Three idle turns in a row that neither add work nor finish stall the run. The start turn and a
// resume turn do not count, and the resume of a run that stalled on idle starts the count again.
func TestIdleStreak(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		if n == 9 {
			a.Add("Look", false)
		}
		a.Say("Nothing to do.")
	}})
	h.startRun(nil)
	l := h.waitStatus(model.RunStalled, model.RunCompleted, model.RunError)
	if l.State.StalledBy != model.StalledIdle || l.State.IdleStreak != 3 || fmt.Sprint(mxReasons(l)) != "[start idle idle idle]" {
		t.Fatalf("the run is %s/%s, streak %d, turns %v", l.State.Status, l.State.StalledBy, l.State.IdleStreak, mxReasons(l))
	}
	for _, tn := range l.Turns {
		if !tn.Idle {
			t.Errorf("turn %d is not marked idle", tn.N)
		}
	}
	if p := h.promptsOf("turn-004"); len(p) != 1 || !strings.Contains(p[0], "3") {
		t.Errorf("the last idle turn was not told how many are left")
	}
	h.idleEngine()
	h.resume()
	if l := h.L(); l.State.IdleStreak != 0 {
		t.Errorf("the resume left the streak at %d", l.State.IdleStreak)
	}
	l = h.waitStatus(model.RunStalled, model.RunCompleted, model.RunError)
	if l.State.StalledBy != model.StalledIdle || l.State.IdleStreak != 3 || fmt.Sprint(mxReasons(l)) != "[start idle idle idle resume idle idle idle]" {
		t.Fatalf("after the resume: %s/%s, streak %d, turns %v", l.State.Status, l.State.StalledBy, l.State.IdleStreak, mxReasons(l))
	}
	// A task that starts ends the streak.
	h.resume()
	l = h.waitStatus(model.RunStalled, model.RunCompleted, model.RunError)
	want := "[start idle idle idle resume idle idle idle resume idle idle idle]"
	if fmt.Sprint(mxReasons(l)) != want || mxState(l, "T01") != model.TaskDone {
		t.Errorf("after the second resume: turns %v, T01 %s", mxReasons(l), mxState(l, "T01"))
	}
	var streakAtStart int
	for _, e := range h.journalWhole() {
		if e.Kind == KTaskStarted && e.Patch.State != nil {
			streakAtStart = e.Patch.State.IdleStreak
		}
	}
	if streakAtStart != 0 {
		t.Errorf("the task's start left the streak at %d", streakAtStart)
	}
}

// wake "each": a turn after each finished task, also while others work. The orchestrator has no
// wait_for there, which is what tells the mode from "declared": a wait for both tasks would hold
// turn 2 back until the second had ended.
func TestWakeEach(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	var mu sync.Mutex
	var tools []string
	var refusal string
	var refused bool
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		if n == 1 {
			a.Add("Look", false)
			a.Add("Look again", false)
			list := a.Tools()
			text, isErr := a.Call("wait_for", map[string]any{"tasks": []string{"T01", "T02"}})
			mu.Lock()
			tools, refusal, refused = list, text, isErr
			mu.Unlock()
			a.Say("Two tasks.")
			return
		}
		mxFinishWhenDone(a)
	}, Task: func(a *mxTurn, tk Task) {
		if tk.ID == "T02" && !a.Gate("second") {
			return
		}
		a.Done("Looked.")
	}})
	h.startRun(func(m *model.RunMeta) { m.Settings.Wake = "each" })
	if got := h.r().engMeta().Settings.Wake; got != "each" {
		t.Fatalf("the run's wake setting is %q", got)
	}
	l := h.waitL("turn 2 to end", func(l *Loaded) bool { return len(l.Turns) == 2 && l.Turns[1].Status == "done" })
	mu.Lock()
	if len(tools) == 0 || slices.Contains(tools, "wait_for") || !slices.Contains(tools, "add_task") {
		t.Errorf("the orchestrator's tools: %v", tools)
	}
	if !refused || !strings.Contains(refusal, "unknown tool wait_for") {
		t.Errorf("wait_for answered %q (an error: %v)", refusal, refused)
	}
	mu.Unlock()
	if t1 := l.Turns[0]; t1.Wait != nil || l.State.Wait != nil || l.Turns[1].Wait != nil {
		t.Errorf("a wait was recorded: %+v, %+v, %+v", t1.Wait, l.State.Wait, l.Turns[1].Wait)
	}
	if t2 := l.Turns[1]; t2.Reason != "events" || t2.Idle || len(t2.WokenBy) != 1 || t2.WokenBy[0].Type != "task_done" || t2.WokenBy[0].Task != "T01" {
		t.Errorf("turn 2: %+v", t2)
	}
	if mxState(l, "T02") != model.TaskWork {
		t.Errorf("T02 is %s", mxState(l, "T02"))
	}
	h.open("second")
	l = h.finished()
	if fmt.Sprint(mxReasons(l)) != "[start events idle]" {
		t.Errorf("turns: %v", mxReasons(l))
	}
}

// wake "idle": no turn for a task that is done while others work; a turn for one that failed; a
// turn when nothing is left.
func TestWakeIdle(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		switch n {
		case 1:
			for i := 1; i <= 3; i++ {
				a.Add(fmt.Sprintf("Look %d", i), false)
			}
			a.Say("Three tasks.")
		case 2:
			a.Say("One failed; so be it.")
		default:
			l := a.State()
			for _, tk := range l.Tasks {
				if !tk.State().Final() {
					a.Say("Not yet.")
					return
				}
			}
			a.Finish()
			a.Say("Finished.")
		}
	}, Task: func(a *mxTurn, tk Task) {
		switch tk.ID {
		case "T01":
			a.Done("Looked.")
		case "T02":
			if !a.Gate("second") {
				return
			}
			a.Say(agentBlock("failed", "It cannot be done.", "No way."))
		default:
			if a.Gate("third") {
				a.Done("Looked.")
			}
		}
	}})
	h.startRun(func(m *model.RunMeta) { m.Settings.Wake = "idle" })
	h.waitTask("T01", model.TaskDone)
	for i := 0; i < 10; i++ {
		h.tick(2 * time.Second)
	}
	if l := h.L(); len(l.Turns) != 1 || len(l.State.Inbox) != 1 {
		t.Fatalf("a finished task woke the orchestrator: %d turns, inbox %+v", len(l.Turns), l.State.Inbox)
	}
	h.open("second")
	l := h.waitL("turn 2 to end", func(l *Loaded) bool { return len(l.Turns) == 2 && l.Turns[1].Status == "done" })
	if t2 := l.Turns[1]; t2.Reason != "events" || t2.Idle || len(t2.WokenBy) != 2 || t2.WokenBy[0].Task != "T01" || t2.WokenBy[1].Type != "task_failed" {
		t.Errorf("turn 2: %+v", t2)
	}
	h.open("third")
	l = h.finished()
	if fmt.Sprint(mxReasons(l)) != "[start events idle]" || len(l.Turns[2].WokenBy) != 1 || l.Turns[2].WokenBy[0].Task != "T03" {
		t.Errorf("turns: %v, the last woken by %+v", mxReasons(l), l.Turns[2].WokenBy)
	}
}

// What a chat on the run does wakes the orchestrator, also with wake "idle" and while tasks work.
func TestChatOpWakes(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		if n == 1 {
			a.Add("Look", false)
			a.Say("One task.")
			return
		}
		mxFinishWhenDone(a)
	}, Task: func(a *mxTurn, tk Task) {
		// The chat's task waits too: its end is an event, and would be a third one for the last
		// turn the chat woke when it came before that turn started.
		gate := "work"
		if tk.ID != "T01" {
			gate = "the chat's task"
		}
		if !a.Gate(gate) {
			return
		}
		a.Done("Looked.")
	}, Chat: func(a *mxTurn) {
		a.Call("tell_orchestrator", map[string]any{"text": "The user wants small tasks."})
		a.Add("From the chat", false)
		a.Say("Passed on, and one task added.")
	}})
	h.startRun(func(m *model.RunMeta) { m.Settings.Wake = "idle" })
	h.atGate("work")
	chat, _ := h.newChat()
	if err := h.cm().Send(chat, "Tell it to keep the tasks small, and add one.", "", nil); err != nil {
		t.Fatal(err)
	}
	// The chat's two calls are two events: they wake one turn or two, as they fall.
	l := h.waitL("the turns the chat woke to end", func(l *Loaded) bool {
		told := 0
		for _, tn := range l.Turns[1:] {
			if tn.Status != "done" {
				return false
			}
			told += len(tn.WokenBy) + len(tn.Learned)
		}
		return told == 2
	})
	if mxState(l, "T01") != model.TaskWork {
		t.Fatalf("T01 is %s", mxState(l, "T01"))
	}
	for _, tn := range l.Turns[1:] {
		if tn.Reason != "events" || tn.Idle {
			t.Errorf("turn %d: %+v", tn.N, tn)
		}
		for _, ev := range append(tn.WokenBy, tn.Learned...) {
			if ev.Type != "chat_op" || ev.Chat != chat {
				t.Errorf("turn %d was told of %+v", tn.N, ev)
			}
		}
	}
	if p := h.promptsOf("turn-002"); len(p) != 1 || !strings.Contains(p[0], "The user wants small tasks.") {
		t.Error("turn 2 was not told what the chat said")
	}
	// The chat's task was held until the chat's own reply was over, and ran while T01 still worked.
	h.open("the chat's task")
	l = h.waitTask("T02", model.TaskDone)
	tk, _ := mxTask(l, "T02")
	if tk.AddedBy != chat || tk.Attempts[0].Phases[0].K != model.TaskHeld || tk.Attempts[0].Phases[0].Chat != chat {
		t.Errorf("the chat's task: added by %q, phases %+v", tk.AddedBy, tk.Attempts[0].Phases)
	}
	if len(l.ChatOps) != 2 || l.ChatOps[0].Op != "tell_orchestrator" || l.ChatOps[1].Op != "add_task" {
		t.Errorf("the chat's ops: %+v", l.ChatOps)
	}
	h.open("work")
	h.finished()
}

// An agent that does not answer within the agent timeout is ended; that is a counted failure,
// and after the back-off the agent is resumed.
func TestAgentTimeout(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		if n == 1 {
			a.Add("Look", false)
			a.Say("One task.")
			return
		}
		mxFinishWhenDone(a)
	}, Task: func(a *mxTurn, tk Task) {
		if len(a.h.promptsOf(a.Name)) == 1 {
			a.Cost(0.03, 3, 3)
			a.Hang()
			return
		}
		a.Done("Looked.")
	}})
	h.setStill(true)
	h.startRun(func(m *model.RunMeta) { m.Settings.AgentTimeoutSec = 60 })
	h.wait("the agent to work", func() bool { return h.turnsOf("T01-work") == 1 })
	h.taken("T01-work")
	launched := func(n int) func(l *Loaded) bool {
		return func(l *Loaded) bool {
			a, ok := mxAgent(l, "T01-work")
			return ok && len(a.Launches) == n && a.Launches[n-1].EndedAt == 0
		}
	}
	h.tick(59 * time.Second)
	if !h.steady(launched(1)) {
		t.Fatalf("the launch ended before its timeout\n%s", h.dump())
	}
	h.tick(time.Second)
	l := h.waitL("the timeout", func(l *Loaded) bool {
		a, _ := mxAgent(l, "T01-work")
		return a.Failures == 1
	})
	a, _ := mxAgent(l, "T01-work")
	if a.Launches[0].Error != "timed out after 1m00s" || a.Status != model.AgentRunning || a.RetryAt != a.Launches[0].EndedAt+30_000 || a.Cost == nil || *a.Cost != 0.03 {
		t.Fatalf("after the timeout: %+v cost %v", a, a.Cost)
	}
	h.noAgentProcess("after the timeout")
	h.tick(29 * time.Second)
	if !h.steady(func(l *Loaded) bool { a, _ := mxAgent(l, "T01-work"); return len(a.Launches) == 1 }) {
		t.Fatal("the agent was launched again before its back-off was over")
	}
	h.tick(time.Second)
	h.setStill(false)
	l = h.finished()
	a, _ = mxAgent(l, "T01-work")
	if len(a.Launches) != 2 || !a.Launches[1].Resume || a.Failures != 0 || a.Status != model.AgentDone {
		t.Errorf("the agent: %+v", a)
	}
	if p := h.promptsOf("T01-work"); len(p) != 2 || !strings.HasPrefix(p[1], "Your previous run of this job stopped before it finished") {
		t.Errorf("the second launch's message is not the resume message")
	}
}

// The back-off after a counted failure is 30 seconds, then 120, on the service's clock, and a
// restart does not shorten it.
func TestBackoffValues(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	var fails atomic.Int32
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		if n == 1 {
			a.Add("Look", false)
			a.Say("One task.")
			return
		}
		mxFinishWhenDone(a)
	}, Task: func(a *mxTurn, tk Task) {
		if fails.Add(1) <= 2 {
			a.Fail("overloaded")
			return
		}
		a.Done("Looked.")
	}})
	h.setStill(true)
	h.startRun(nil)
	failed := func(n int) *Loaded {
		return h.waitL(fmt.Sprintf("failure %d", n), func(l *Loaded) bool {
			a, ok := mxAgent(l, "T01-work")
			return ok && a.Failures == n && a.RetryAt > 0
		})
	}
	launches := func(n int) func(l *Loaded) bool {
		return func(l *Loaded) bool { a, _ := mxAgent(l, "T01-work"); return len(a.Launches) == n }
	}
	l := failed(1)
	a, _ := mxAgent(l, "T01-work")
	if a.RetryAt-a.Launches[0].EndedAt != 30_000 || a.Launches[0].Error != "overloaded" {
		t.Fatalf("after the first failure: retry %d ms after the end, error %q", a.RetryAt-a.Launches[0].EndedAt, a.Launches[0].Error)
	}
	h.tick(29 * time.Second)
	if !h.steady(launches(1)) {
		t.Fatal("launched again after 29 s")
	}
	h.tick(time.Second)
	l = failed(2)
	a, _ = mxAgent(l, "T01-work")
	if a.RetryAt-a.Launches[1].EndedAt != 120_000 || !a.Launches[1].Resume {
		t.Fatalf("after the second failure: retry %d ms after the end; launches %+v", a.RetryAt-a.Launches[1].EndedAt, a.Launches)
	}
	retryAt := a.RetryAt
	h.tick(60 * time.Second)
	// The server is closed and started in the middle of the back-off.
	h.restartQuit()
	if a, _ := mxAgent(h.L(), "T01-work"); a.RetryAt != retryAt || a.Failures != 2 {
		t.Fatalf("after the restart: retry at %d (was %d), %d failures", a.RetryAt, retryAt, a.Failures)
	}
	h.tick(59 * time.Second)
	if !h.steady(launches(2)) {
		t.Fatal("the restart shortened the back-off")
	}
	h.tick(time.Second)
	h.setStill(false)
	l = h.finished()
	a, _ = mxAgent(l, "T01-work")
	if len(a.Launches) != 3 || a.Failures != 0 || a.RetryAt != 0 || a.Status != model.AgentDone {
		t.Errorf("the agent at the end: %+v", a)
	}
}

// A back-off survives a crash too: the resumed run waits what is left of it.
func TestBackoffPersisted(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	var fails atomic.Int32
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		if n == 1 {
			a.Add("Look", false)
			a.Say("One task.")
			return
		}
		mxFinishWhenDone(a)
	}, Task: func(a *mxTurn, tk Task) {
		if fails.Add(1) == 1 {
			a.Exit("the process fell over")
			return
		}
		a.Done("Looked.")
	}})
	h.setStill(true)
	h.startRun(nil)
	l := h.waitL("the failure", func(l *Loaded) bool {
		a, ok := mxAgent(l, "T01-work")
		return ok && a.Failures == 1 && a.RetryAt > 0
	})
	was, _ := mxAgent(l, "T01-work")
	if !strings.Contains(was.Launches[0].Error, "the process fell over") && was.Launches[0].Error == "" {
		t.Errorf("the failed launch's error: %q", was.Launches[0].Error)
	}
	h.tick(10 * time.Second)
	h.crash()
	h.waitStatus(model.RunStopped)
	h.resume()
	if a, _ := mxAgent(h.L(), "T01-work"); a.RetryAt != was.RetryAt || a.Failures != 1 {
		t.Fatalf("after the crash: retry at %d (was %d), %d failures", a.RetryAt, was.RetryAt, a.Failures)
	}
	h.tick(19 * time.Second)
	if !h.steady(func(l *Loaded) bool { a, _ := mxAgent(l, "T01-work"); return len(a.Launches) == 1 }) {
		t.Fatal("the crash shortened the back-off")
	}
	h.tick(time.Second)
	h.setStill(false)
	l = h.finished()
	if a, _ := mxAgent(l, "T01-work"); len(a.Launches) != 2 || a.Status != model.AgentDone {
		t.Errorf("the agent: %+v", a)
	}
}

// The repair turn: an answer without the result block is asked for the block, twice at most; an
// answer that ended in an error is not.
func TestRepairTurn(t *testing.T) {
	t.Parallel()
	turn := func(a *mxTurn, n int) {
		if n == 1 {
			a.Add("Look", false)
			a.Say("One task.")
			return
		}
		if l := a.State(); l != nil && l.Tasks[0].State().Final() {
			a.Finish()
		}
		a.Say("Looked.")
	}
	t.Run("no block, then the block", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{Turn: turn, Task: func(a *mxTurn, tk Task) {
			if a.N == 1 {
				a.Say("I looked at everything and it is fine.")
				return
			}
			a.Done("It is fine.")
		}})
		h.startRun(nil)
		l := h.finished()
		a, _ := mxAgent(l, "T01-work")
		p := h.promptsOf("T01-work")
		if len(p) != 2 || p[1] != engRepairMessage || len(a.Launches) != 1 || a.Failures != 0 || h.spawnsOf("T01-work") != 1 {
			t.Errorf("%d messages, %d launches, %d failures, %d processes", len(p), len(a.Launches), a.Failures, h.spawnsOf("T01-work"))
		}
		if _, at := h.task("T01"); at.Result == nil || at.Result.Summary != "It is fine." || at.Outcome != model.TaskDone {
			t.Errorf("the result: %+v", at.Result)
		}
	})
	t.Run("two misses", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{Turn: turn, Task: func(a *mxTurn, tk Task) { a.Say("All is fine.") }})
		h.startRun(nil)
		l := h.finished()
		a, _ := mxAgent(l, "T01-work")
		p := h.promptsOf("T01-work")
		if len(p) != 3 || p[1] != engRepairMessage || p[2] != engRepairMessage {
			t.Errorf("the agent got %d messages", len(p))
		}
		// Not answered in the form asked for is final: no back-off, no second launch.
		if a.Status != model.AgentFailed || len(a.Launches) != 1 || a.Launches[0].Error != "finished without the result block" || a.RetryAt != 0 {
			t.Errorf("the agent: %+v", a)
		}
		if _, at := h.task("T01"); at.Outcome != model.TaskFailed || !strings.Contains(at.Error, "finished without the result block") {
			t.Errorf("the task: %s %q", at.Outcome, at.Error)
		}
	})
	t.Run("no repair after an error", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{Turn: turn, Task: func(a *mxTurn, tk Task) {
			if len(a.h.promptsOf(a.Name)) == 1 {
				a.Say("Half an answer, with no block.")
				a.Fail("rate limited")
				return
			}
			a.Done("Looked.")
		}})
		h.startRun(nil)
		l := h.finished()
		a, _ := mxAgent(l, "T01-work")
		p := h.promptsOf("T01-work")
		if len(p) != 2 || p[1] == engRepairMessage || !strings.HasPrefix(p[1], "Your previous run of this job stopped") {
			t.Errorf("after the error the agent got %d messages; the second is the repair message: %v", len(p), len(p) > 1 && p[1] == engRepairMessage)
		}
		if len(a.Launches) != 2 || a.Launches[0].Error != "rate limited" || !a.Launches[1].Resume || a.Status != model.AgentDone {
			t.Errorf("the agent: %+v", a)
		}
	})
}

// A session that is gone, as each kind of agent says so: the launch that found it gone is not a
// failure, and the next one starts a new session with the first message and a note.
func TestNoSessionPerKind(t *testing.T) {
	t.Parallel()
	for _, kind := range []model.AgentKind{model.Claude, model.Cursor, model.Pi} {
		t.Run(string(kind), func(t *testing.T) {
			t.Parallel()
			h := newMx(t, false)
			h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
				if n == 1 {
					a.Add("Look", false)
					a.Say("One task.")
					return
				}
				mxFinishWhenDone(a)
			}, Task: func(a *mxTurn, tk Task) {
				if len(a.h.promptsOf(a.Name)) == 1 && !a.Gate("work") {
					return
				}
				a.Done("Looked.")
			}})
			h.startRun(func(m *model.RunMeta) { m.Agent, m.Tiers = kind, tiersAll("sonnet", "") })
			h.atGate("work")
			h.taken("T01-work")
			h.stopRun()
			var session string
			_, agents := h.cm().ChatsOfRun(h.id)
			for _, m := range agents {
				if m.Name == "T01-work" {
					session = m.SessionID
				}
			}
			if session == "" {
				t.Fatal("the agent's chat has no session id")
			}
			h.fakes[kind].NoSession(session)
			h.resume()
			l := h.finished()
			a, _ := mxAgent(l, "T01-work")
			if len(a.Launches) != 3 || !a.Launches[1].Resume || a.Launches[1].Error != "no session" || a.Launches[2].Resume || a.Failures != 0 || a.Status != model.AgentDone {
				t.Fatalf("the agent: %+v", a)
			}
			if a.Launches[2].StartedAt-a.Launches[1].EndedAt >= 30_000 {
				t.Errorf("a back-off after a session that was gone: launch 2 ended %d, launch 3 began %d", a.Launches[1].EndedAt, a.Launches[2].StartedAt)
			}
			p := h.promptsOf("T01-work")
			last := p[len(p)-1]
			if !strings.HasPrefix(last, p[0]) || !strings.Contains(last, "Note: an earlier attempt at this job did not finish.") || strings.Contains(last, "Your previous run of this job stopped") {
				t.Errorf("the message of the fresh launch is not the first message with the note")
			}
			sp := h.spawnsWith("T01-work")
			fresh := sp[len(sp)-1]
			if fresh.Resume || fresh.SessionID == session {
				t.Errorf("the fresh launch's process: resume %v, session %q (the old one %q)", fresh.Resume, fresh.SessionID, session)
			}
		})
	}
}

// A message the agent's process refuses (T24 M4) is a counted failure, and the chat is free
// afterwards: no process, not busy, so the next launch is not refused as "busy" for ever.
func TestSendRefusedLeavesTheChatFree(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		if n == 1 {
			a.Add("Look", false)
			a.Say("One task.")
			return
		}
		mxFinishWhenDone(a)
	}})
	var used atomic.Bool
	h.mu.Lock()
	h.sendHook = func(name string, ag agent.Agent) agent.Agent {
		if name == "T01-work" {
			return mxRefusing{Agent: ag, text: "session/prompt: the server refused the request", used: &used}
		}
		return ag
	}
	h.mu.Unlock()
	h.setStill(true)
	h.startRun(nil)
	l := h.waitL("the refused message", func(l *Loaded) bool {
		a, ok := mxAgent(l, "T01-work")
		return ok && a.Failures == 1
	})
	a, _ := mxAgent(l, "T01-work")
	if !strings.Contains(a.Launches[0].Error, "the server refused the request") || a.Resumable {
		t.Errorf("the refused launch: %+v, resumable %v", a.Launches[0], a.Resumable)
	}
	id := AgentChatID(h.id, "T01-work")
	h.wait("the chat to be free", func() bool {
		st, err := h.cm().OwnedState(id)
		return err == nil && !st.HasProcess && h.cm().Idle(id) && !h.cm().TurnRunning(id)
	})
	h.noAgentProcess("after the refused message")
	h.setStill(false)
	l = h.finished()
	a, _ = mxAgent(l, "T01-work")
	if len(a.Launches) != 2 || a.Status != model.AgentDone || a.Failures != 0 {
		t.Errorf("the agent: %+v", a)
	}
	if p := h.promptsOf("T01-work"); len(p) != 1 || !strings.Contains(p[0], "Note: an earlier attempt at this job did not finish.") {
		t.Errorf("the agent got %d messages; the one after the refusal is the first message with the note: %v", len(p), len(p) == 1)
	}
}
