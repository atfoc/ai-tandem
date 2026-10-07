package runs

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"ai-whiteboard/internal/model"
)

// Behaviours the final verification found right by hand and without a test of their own: the
// parallel limit at its default, a person's stop over a restart, a chat's message during a
// declared wait, a failed dependency, a merge agent that fails for good. All on the matrix
// harness (matrix_test.go).

// mxCount counts the tasks of l that are in one of the states.
func mxCount(l *Loaded, states ...model.TaskState) int {
	n := 0
	for _, t := range l.Tasks {
		if slices.Contains(states, t.State()) {
			n++
		}
	}
	return n
}

// The default settings let 8 tasks work at a time: of 10 independent tasks 8 work and 2 are
// ready without a slot; the ninth starts when one ends; never more than 8 hold a slot.
func TestMaxParallelDefault(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	var working, peak atomic.Int32
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		if n == 1 {
			for i := 1; i <= 10; i++ {
				a.Add(fmt.Sprintf("Look %d", i), false)
			}
			a.Say("Ten tasks.")
			return
		}
		mxFinishWhenDone(a)
	}, Task: func(a *mxTurn, tk Task) {
		if now := working.Add(1); now > peak.Load() {
			peak.Store(now)
		}
		defer working.Add(-1)
		if a.Gate("at " + tk.ID) {
			a.Done("Looked.")
		}
	}})
	var active atomic.Int32 // the most tasks that held a slot after any entry
	h.mu.Lock()
	h.onEntry = func(l *Loaded) {
		if n := int32(mxCount(l, model.TaskSetup, model.TaskWork, model.TaskMerge)); n > active.Load() {
			active.Store(n)
		}
	}
	h.mu.Unlock()
	h.startRun(nil)
	if set := h.r().engMeta().Settings; set.MaxParallel != 8 || set != model.DefaultRunSettings() {
		t.Fatalf("the run's settings are not the defaults: %+v", set)
	}
	for i := 1; i <= 8; i++ {
		h.atGate(fmt.Sprintf("at T%02d", i))
	}
	full := func(l *Loaded) bool { return mxCount(l, model.TaskWork) == 8 && mxCount(l, model.TaskSlot) == 2 }
	h.waitL("8 tasks to work", full)
	for i := 0; i < 10; i++ {
		h.tick(2 * 1e9)
	}
	if l := h.L(); !h.steady(full) || mxState(l, "T09") != model.TaskSlot || mxState(l, "T10") != model.TaskSlot || working.Load() != 8 {
		t.Fatalf("with 10 tasks: %d agents work; %d tasks work, %d wait for a slot; T09 %s, T10 %s", working.Load(),
			mxCount(l, model.TaskWork), mxCount(l, model.TaskSlot), mxState(l, "T09"), mxState(l, "T10"))
	}
	if n := h.spawnsOf("T09-work") + h.spawnsOf("T10-work"); n != 0 {
		t.Fatalf("%d process(es) started for the tasks without a slot", n)
	}
	h.open("at T01")
	h.atGate("at T09")
	l := h.waitL("the ninth task to work", func(l *Loaded) bool {
		return mxState(l, "T01") == model.TaskDone && mxState(l, "T09") == model.TaskWork
	})
	if !h.steady(func(l *Loaded) bool { return mxState(l, "T10") == model.TaskSlot && mxCount(l, model.TaskWork) == 8 }) {
		t.Errorf("after one task ended: %d tasks work, T10 is %s", mxCount(l, model.TaskWork), mxState(h.L(), "T10"))
	}
	for i := 2; i <= 10; i++ {
		h.open(fmt.Sprintf("at T%02d", i))
	}
	h.finished()
	if peak.Load() != 8 || active.Load() != 8 {
		t.Errorf("at most %d agents worked at once and %d tasks held a slot; want 8 and 8", peak.Load(), active.Load())
	}
}

// A run a person stopped stays stopped over a restart of the server: the boot starts no agent,
// and the person's resume continues the same task's agent in its session.
func TestStopRestartResume(t *testing.T) {
	t.Parallel()
	h := newMx(t, true)
	h.plan(mxPlan{
		Turn: func(a *mxTurn, n int) {
			if n == 1 {
				a.Notes()
				a.Add("Write a file", true)
				a.Say("One task.")
				return
			}
			mxFinishWhenDone(a)
		},
		Task: func(a *mxTurn, tk Task) {
			a.Write("half.txt", "half\n")
			if !a.Gate("work") {
				return
			}
			mxWriter(a, tk)
		},
	})
	h.startRun(nil)
	h.atGate("work")
	l := h.stopRun()
	if a, _ := mxAgent(l, "T01-work"); l.State.Reason != "stopped by the user" || a.Status != model.AgentInterrupted || len(a.Launches) != 1 || !a.Resumable {
		t.Fatalf("stopped: %q, the agent %+v", l.State.Reason, a)
	}
	h.idleEngine()
	version, before := l.Version, h.launches()

	h.restartQuit()
	if !h.quiet() || h.launches() != before {
		t.Errorf("the boot launched something: %d launches, %d before it", h.launches(), before)
	}
	l = h.L()
	if l.State.Status != model.RunStopped || l.State.Reason != "stopped by the user" || len(l.Stops) != 1 || l.Stops[0].Reason != model.StopUser ||
		l.Stops[0].ResumedAt != 0 || l.Version != version {
		t.Fatalf("after the restart: %s %q, stops %+v, version %d (was %d)", l.State.Status, l.State.Reason, l.Stops, l.Version, version)
	}
	if a, _ := mxAgent(l, "T01-work"); mxState(l, "T01") != model.TaskWork || a.Status != model.AgentInterrupted || len(a.Launches) != 1 {
		t.Errorf("after the restart: T01 is %s, its agent %+v", mxState(l, "T01"), a)
	}
	h.idleEngine()

	h.regate("work")
	h.resume()
	h.atGate("work")
	if l = h.L(); l.State.Status != model.RunRunning || l.Stops[0].ResumedAt == 0 {
		t.Errorf("resumed: %s, stops %+v", l.State.Status, l.Stops)
	}
	h.open("work")
	l = h.finished()
	if a, _ := mxAgent(l, "T01-work"); len(a.Launches) != 2 || !a.Launches[1].Resume || a.Status != model.AgentDone {
		t.Errorf("the agent after the resume: %+v", a)
	}
	if tk, _ := mxTask(l, "T01"); len(tk.Attempts) != 1 || len(l.Tasks) != 1 {
		t.Errorf("the task was started anew: %d attempt(s), %d task(s)", len(tk.Attempts), len(l.Tasks))
	}
	sp := h.spawnsWith("T01-work")
	if len(sp) != 2 || sp[0].Resume || !sp[1].Resume || sp[0].SessionID == "" || sp[0].SessionID != sp[1].SessionID {
		t.Errorf("the agent's processes: %+v", sp)
	}
	if p := h.promptsOf("T01-work"); len(p) != 2 || !strings.HasPrefix(p[1], "Your previous run of this job stopped before it finished") {
		t.Errorf("the agent got %d message(s), the last not the resume message", len(p))
	}
	if h.intFile("half.txt") != "half" || h.intFile("t01.txt") == "" {
		t.Error("the work of before and after the stop is not both in the result")
	}
}

// With wake "declared" and a wait pending, what a chat on the run tells the orchestrator starts
// the next turn at once, before any of the awaited tasks ends. The wait ends with the turn it
// was for (turn.go startTurn): the new turn is told what was waited for and that it has not
// happened, the run's state holds no wait any more, and since the new instance declares none the
// next task that ends starts a turn by itself.
func TestTellOrchestratorDuringDeclaredWait(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	const said = "The user wants the second look dropped."
	var told string
	var toldErr bool
	var mu sync.Mutex
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		if n == 1 {
			a.Add("Look", false)
			a.Add("Look again", false)
			a.Call("wait_for", map[string]any{"tasks": []string{"T01", "T02"}})
			a.Say("Two tasks; I wait for both.")
			return
		}
		mxFinishWhenDone(a)
	}, Task: func(a *mxTurn, tk Task) {
		if a.Gate("at " + tk.ID) {
			a.Done("Looked.")
		}
	}, Chat: func(a *mxTurn) {
		text, isErr := a.Call("tell_orchestrator", map[string]any{"text": said})
		mu.Lock()
		told, toldErr = text, isErr
		mu.Unlock()
		a.Say("Passed on.")
	}})
	h.startRun(nil) // wake "declared" is the default
	h.atGate("at T01")
	h.atGate("at T02")
	waiting := func(l *Loaded) bool {
		w := l.State.Wait
		return len(l.Turns) == 1 && l.Turns[0].Status == "done" && w != nil && fmt.Sprint(w.Tasks) == "[T01 T02]" && w.Mode == "all" && w.Turn == 1
	}
	for i := 0; i < 10; i++ {
		h.tick(2 * 1e9)
	}
	if !h.steady(waiting) {
		l := h.L()
		t.Fatalf("before the chat: %d turn(s), the wait %+v", len(l.Turns), l.State.Wait)
	}

	chat, _ := h.newChat()
	if err := h.cm().Send(chat, "Tell it to drop the second look.", "", nil); err != nil {
		t.Fatal(err)
	}
	l := h.waitL("turn 2 to end", func(l *Loaded) bool { return len(l.Turns) >= 2 && l.Turns[1].Status == "done" })
	mu.Lock()
	if toldErr || told == "" {
		t.Errorf("tell_orchestrator answered %q (an error: %v)", told, toldErr)
	}
	mu.Unlock()
	if mxState(l, "T01") != model.TaskWork || mxState(l, "T02") != model.TaskWork || len(l.Turns) != 2 {
		t.Fatalf("turn 2 did not come before the tasks ended: T01 %s, T02 %s, %d turns", mxState(l, "T01"), mxState(l, "T02"), len(l.Turns))
	}
	t2 := l.Turns[1]
	if t2.Reason != "events" || t2.Idle || len(t2.WokenBy) != 1 || t2.WokenBy[0].Type != "chat_op" || t2.WokenBy[0].Chat != chat || !strings.Contains(t2.WokenBy[0].Text, said) {
		t.Errorf("turn 2: %+v", t2)
	}
	// The wait: kept in the turn as what was waited for, not met; gone from the run's state.
	if w := t2.Wait; w == nil || fmt.Sprint(w.Tasks) != "[T01 T02]" || w.Mode != "all" || w.Turn != 1 || t2.WaitMet {
		t.Errorf("turn 2's wait: %+v, met %v", t2.Wait, t2.WaitMet)
	}
	if l.State.Wait != nil || len(l.State.Inbox) != 0 {
		t.Errorf("after turn 2 started: the wait %+v, the inbox %+v", l.State.Wait, l.State.Inbox)
	}
	if len(l.ChatOps) != 1 || l.ChatOps[0].Op != "tell_orchestrator" || l.ChatOps[0].Chat != chat {
		t.Errorf("the chat's ops: %+v", l.ChatOps)
	}
	if p := h.promptsOf("turn-002"); len(p) != 1 || !strings.Contains(p[0], said) {
		t.Error("turn 2 was not told what the chat said")
	}
	// No wait was declared again: one task's end starts a turn, which a wait for both would not.
	h.open("at T01")
	l = h.waitL("turn 3 to end", func(l *Loaded) bool { return len(l.Turns) >= 3 && l.Turns[2].Status == "done" })
	if t3 := l.Turns[2]; t3.Reason != "events" || t3.Wait != nil || len(t3.WokenBy) != 1 || t3.WokenBy[0].Type != "task_done" || t3.WokenBy[0].Task != "T01" || mxState(l, "T02") != model.TaskWork {
		t.Errorf("turn 3: %+v; T02 is %s", t3, mxState(l, "T02"))
	}
	h.open("at T02")
	l = h.finished()
	if fmt.Sprint(mxReasons(l)) != "[start events events idle]" {
		t.Errorf("turns: %v", mxReasons(l))
	}
}

// A task whose dependency failed does not start: it is blocked, and the orchestrator is started
// with the failure among its events. After retry_task and the dependency's success it starts.
func TestFailedDependencyBlocksDependant(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	var retried atomic.Bool
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		l := a.State()
		switch {
		case n == 1:
			a.Add("Look", false)
			a.Add("Look at what the first found", false, "T01")
			a.Add("Look elsewhere", false)
			a.Say("Three tasks.")
		case mxState(l, "T01") == model.TaskFailed && !retried.Load():
			if !a.Gate("retry") {
				return
			}
			if text, isErr := a.Call("retry_task", map[string]any{"id": "T01", "reason": "It can be done after all."}); isErr {
				a.Say("retry_task was refused: " + text)
				return
			}
			retried.Store(true)
			a.Say("T01 again.")
		default:
			mxFinishWhenDone(a)
		}
	}, Task: func(a *mxTurn, tk Task) {
		switch {
		case tk.ID == "T01" && len(tk.Attempts) == 1:
			a.Say(agentBlock("failed", "It cannot be done.", "No way."))
		case tk.ID == "T03":
			if a.Gate("third") {
				a.Done("Looked.")
			}
		default:
			a.Done("Looked.")
		}
	}})
	h.startRun(nil)
	h.atGate("retry")
	blocked := func(l *Loaded) bool {
		return mxState(l, "T01") == model.TaskFailed && mxState(l, "T02") == model.TaskBlocked && h.spawnsOf("T02-work") == 0
	}
	for i := 0; i < 10; i++ {
		h.tick(2 * 1e9)
	}
	l := h.L()
	if !h.steady(blocked) {
		t.Fatalf("with T01 failed: T01 %s, T02 %s, %d process(es) of T02", mxState(l, "T01"), mxState(l, "T02"), h.spawnsOf("T02-work"))
	}
	tk, _ := mxTask(l, "T02")
	if _, ok := mxAgent(l, "T02-work"); ok || len(tk.Attempts) != 1 || tk.Attempts[0].StartedAt != 0 {
		t.Errorf("the blocked task has started: %+v", tk.Attempts)
	}
	if ph := tk.Attempts[0].Phases; len(ph) == 0 || ph[len(ph)-1].K != model.TaskBlocked || fmt.Sprint(ph[len(ph)-1].On) != "[T01]" {
		t.Errorf("the blocked task's phases: %+v", ph)
	}
	// The run is not idle (T03 works): the turn was started by the failure.
	if len(l.Turns) != 2 || l.Turns[1].Reason != "events" || l.Turns[1].Idle || len(l.Turns[1].WokenBy) != 1 ||
		l.Turns[1].WokenBy[0].Type != "task_failed" || l.Turns[1].WokenBy[0].Task != "T01" {
		t.Errorf("the turn after the failure: %+v", l.Turns[len(l.Turns)-1])
	}
	if p := h.promptsOf("turn-002"); len(p) != 1 || !strings.Contains(p[0], "T01") || !strings.Contains(p[0], "It cannot be done.") {
		t.Error("turn 2 was not told of T01's failure")
	}

	h.open("retry")
	l = h.waitTask("T02", model.TaskDone)
	one, _ := mxTask(l, "T01")
	two, _ := mxTask(l, "T02")
	if one.State() != model.TaskDone || len(one.Attempts) != 2 || len(two.Attempts) != 1 || h.spawnsOf("T02-work") != 1 {
		t.Errorf("after the retry: T01 %s with %d attempts, T02 with %d attempts and %d process(es)", one.State(), len(one.Attempts), len(two.Attempts), h.spawnsOf("T02-work"))
	}
	if ended := one.Attempts[1].EndedAt; two.Attempts[0].StartedAt < ended || ended == 0 {
		t.Errorf("T02 started at %d, before T01's second attempt ended at %d", two.Attempts[0].StartedAt, ended)
	}
	h.open("third")
	h.finished()
}

// A merge agent that fails every launch it has (one and the two retries) fails its task with a
// reason that names it; the integration branch and its checkout are as they were, and the next
// writing task merges.
func TestMergeAgentLaunchesUsedUp(t *testing.T) {
	t.Parallel()
	h := newMx(t, true)
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		l := a.State()
		if n == 1 || l == nil {
			mxTwoWriters(a, n)
			return
		}
		for _, tk := range l.Tasks {
			if !tk.State().Final() {
				a.Say("Nothing to change yet.")
				return
			}
		}
		if len(l.Tasks) == 2 {
			if !a.Gate("look") {
				return
			}
			a.Add("Three", true)
			a.Say("One more writer.")
			return
		}
		a.Finish()
		a.Say("Finished.")
	}, Task: func(a *mxTurn, tk Task) {
		if tk.Title == "Three" {
			mxWriter(a, tk)
			return
		}
		mxLine(a, tk)
	}, Merge: func(a *mxTurn, tk Task) {
		a.Exit("the merge agent fell over")
	}})
	h.startRun(nil)
	h.atGate("look")
	l := h.L()
	var failed, done Task
	for _, tk := range l.Tasks {
		if tk.State() == model.TaskFailed {
			failed = tk
		} else {
			done = tk
		}
	}
	if failed.ID == "" || done.State() != model.TaskDone {
		t.Fatalf("tasks:\n%s", h.dump())
	}
	name := failed.ID + "-merge"
	ag, _ := mxAgent(l, name)
	if ag.Status != model.AgentFailed || len(ag.Launches) != 3 || ag.Failures != 3 || h.spawnsOf(name) != 3 {
		t.Errorf("the merge agent: %+v; %d process(es)", ag, h.spawnsOf(name))
	}
	at := failed.Attempts[0]
	if !strings.HasPrefix(at.Error, "agent "+name+" failed: ") || at.Merged != "" || at.Worktree != "" {
		t.Errorf("the failed attempt: %q merged %q checkout %q", at.Error, at.Merged, at.Worktree)
	}
	// The integration branch holds the other task's line alone, and its checkout is clean.
	r := h.r()
	dir := r.engIntDir(r.engGit())
	if st, err := h.repo.GitIn(dir, "status", "--porcelain"); err != nil || st != "" {
		t.Errorf("git status of the integration checkout: %q %v", st, err)
	}
	gitDir, err := h.repo.GitIn(dir, "rev-parse", "--absolute-git-dir")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(strings.TrimSpace(gitDir), "MERGE_HEAD")); err == nil {
		t.Error("the integration checkout is in a merge")
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "shared.txt")); string(got) != "line of "+done.ID+"\n" {
		t.Errorf("shared.txt in the integration checkout: %q", got)
	}
	if got := h.intFile("shared.txt"); got != "line of "+done.ID {
		t.Errorf("shared.txt on the integration branch: %q", got)
	}
	if bad := h.markersAnywhere(); bad != "" {
		t.Errorf("commits with conflict markers:\n%s", bad)
	}

	h.open("look")
	l = h.finished()
	three, _ := mxByTitle(l, "Three")
	if three.State() != model.TaskDone || three.Attempts[0].Merged == "" || h.intFile(strings.ToLower(three.ID)+".txt") == "" {
		t.Errorf("the later writing task: %s, merged %q", three.State(), three.Attempts[0].Merged)
	}
	if got := h.intFile("shared.txt"); got != "line of "+done.ID {
		t.Errorf("shared.txt in the result: %q", got)
	}
	if bad := h.markersAnywhere(); bad != "" {
		t.Errorf("commits with conflict markers:\n%s", bad)
	}
}

// get_run of a run whose result was applied says where the result is: the integration branch is
// gone by then. Every other delivery state names the branch.
func TestSnapshotNamesTheAppliedResult(t *testing.T) {
	meta := model.RunMeta{Name: "A run", Agent: model.Claude, Settings: model.DefaultRunSettings()}
	git := &Git{RunGit: model.RunGit{BaseRef: "ba9876543210ffff", IntegrationBranch: "aiwb/r_x/integration", ResultHead: "0123456789abffff", Branch: "main"}}
	facts := gitFacts{Head: "0123456789abffff", Commits: 2}
	line := func(d *model.RunDelivery) string {
		text := snapshotText(meta, &Loaded{State: State{Status: model.RunCompleted, Git: git, Delivery: d}}, facts)
		for _, ln := range strings.Split(text, "\n") {
			if strings.Contains(ln, "since the run started from") {
				return ln
			}
		}
		return ""
	}
	branch := "Integration branch aiwb/r_x/integration at 0123456789ab, 2 commit(s) since the run started from ba9876543210."
	for _, c := range []struct {
		d    *model.RunDelivery
		want string
	}{
		{nil, branch},
		{&model.RunDelivery{State: model.DeliveryPending, Reason: "manual", Result: "0123456789abffff", Branch: "main"}, branch},
		{&model.RunDelivery{State: model.DeliveryBlocked, Reason: "local_changes", Result: "0123456789abffff", Branch: "main"}, branch},
		{&model.RunDelivery{State: model.DeliveryApplied, How: "ff", Result: "0123456789abffff", Commit: "0123456789abffff", Branch: "main"},
			"The run's result was applied to the person's working folder, branch main at 0123456789ab, 2 commit(s) since the run started from ba9876543210."},
		{&model.RunDelivery{State: model.DeliveryApplied, How: "merge", Result: "0123456789abffff", Commit: "fedcba987654ffff"},
			"The run's result was applied to the person's working folder, a detached HEAD at fedcba987654, 2 commit(s) since the run started from ba9876543210."},
	} {
		if got := line(c.d); got != c.want {
			t.Errorf("delivery %+v:\n got %q\nwant %q", c.d, got, c.want)
		}
	}
}
