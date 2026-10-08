package runs

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/testset"
)

// The eighteen bugs of the reference script (T01 §15.2), each with the test that shows the run
// server does not have it, on the real chat manager and the real MCP endpoint.

// twoWriters is turn 1 of a run whose two writing tasks put their line in place of the same line
// of shared.txt.
func mxTwoWriters(a *mxTurn, n int) {
	if n == 1 {
		a.Notes()
		a.Add("One", true)
		a.Add("Two", true)
		a.Say("Two writers of one line.")
		return
	}
	l := a.State()
	if l == nil {
		return
	}
	for _, t := range l.Tasks {
		if !t.State().Final() {
			a.Say("Nothing to change yet.")
			return
		}
	}
	a.Finish()
	a.Say("Finished.")
}

// mxLine is a work agent that puts its line in place of shared.txt's base line.
func mxLine(a *mxTurn, t Task) {
	a.Write("shared.txt", "line of "+t.ID+"\n")
	a.Done("Put the line of " + t.ID + " into shared.txt.")
}

// markersAnywhere lists the commits of the repository's branches that add a conflict marker.
func (h *mx) markersAnywhere() string {
	h.t.Helper()
	out := h.repo.Git("log", "--all", "-p", "--format=commit %h %s")
	var bad []string
	commit := ""
	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.HasPrefix(line, "commit "):
			commit = line
		case strings.HasPrefix(line, "+<<<<<<<"), strings.HasPrefix(line, "+>>>>>>>"), line == "+=======":
			bad = append(bad, commit+": "+line)
		}
	}
	return strings.Join(bad, "\n")
}

// B1: a restart during a conflict resolution must not commit the half-resolved files. The server
// dies while the merge agent works, with the conflict markers in the task's checkout; after the
// resume the agent goes on, and no commit of any branch holds a marker.
func TestB01RestartInResolution(t *testing.T) {
	t.Parallel()
	for _, how := range []string{"crash", "quit"} {
		if !testset.Full() && how != "crash" {
			continue // a whole run each
		}
		t.Run(how, func(t *testing.T) {
			t.Parallel()
			h := newMx(t, true)
			h.plan(mxPlan{Turn: mxTwoWriters, Task: mxLine, Merge: func(a *mxTurn, tk Task) {
				if !strings.Contains(a.Read("shared.txt"), "<<<<<<<") {
					t.Errorf("the merge agent found no conflict in shared.txt: %q", a.Read("shared.txt"))
				}
				if !a.Gate("merge") {
					return
				}
				mxRefMerge(a)
			}})
			h.startRun(nil)
			h.atGate("merge")
			var tid string
			for _, tk := range h.L().Tasks {
				if tk.State() == model.TaskMerge {
					tid = tk.ID
				}
			}
			wt := filepath.Join(h.world().st.P.RunWorkDir(h.id), tid)
			h.taken(tid + "-merge")
			h.regate("merge")
			if how == "crash" {
				h.crash()
				h.waitStatus(model.RunStopped)
				if b, _ := os.ReadFile(filepath.Join(wt, "shared.txt")); !strings.Contains(string(b), "<<<<<<<") {
					t.Fatalf("the checkout the dead server left has no conflict: %q", b)
				}
				h.resume()
			} else {
				h.restartQuit()
			}
			h.atGate("merge")
			_, at := h.task(tid)
			if at.Head == "" || at.MergeRound != 1 || at.MergeAgentDone != 0 || at.Merged != "" {
				t.Fatalf("after the restart the attempt is: head %q round %d done %d merged %q", at.Head, at.MergeRound, at.MergeAgentDone, at.Merged)
			}
			// The task's branch is where it was: nothing was committed over the conflict.
			if got := h.repo.Git("rev-parse", "aiwb/"+h.id+"/"+tid); got != at.Head {
				t.Fatalf("the task's branch moved from %s to %s during the restart", at.Head, got)
			}
			h.open("merge")
			l := h.finished()
			if bad := h.markersAnywhere(); bad != "" {
				t.Errorf("commits with conflict markers:\n%s", bad)
			}
			if got := h.intFile("shared.txt"); got != "line of T01\nline of T02" {
				t.Errorf("shared.txt on the integration branch: %q", got)
			}
			a, _ := mxAgent(l, tid+"-merge")
			if len(a.Launches) != 2 || !a.Launches[1].Resume || a.Status != model.AgentDone {
				t.Errorf("the merge agent: %+v", a)
			}
			if _, ok := mxAgent(l, tid+"-merge-r2"); ok {
				t.Error("the restart opened a second round")
			}
			h.noCheckouts()
		})
	}
}

// B2: a task's end, its event and what it releases are one journal entry.
func TestB02EndAndEventOneEntry(t *testing.T) {
	t.Parallel()
	l := &Loaded{}
	ends, released := 0, false
	for _, e := range mxReference(t).entries(t) {
		seq := l.State.EventSeq
		var before model.TaskState
		if rep, ok := mxByTitle(l, mxReport); ok {
			before = rep.State()
		}
		l.Apply(e.V, e.Patch)
		if e.Kind != KTaskEnded {
			continue
		}
		ends++
		tk, _ := mxTask(l, e.Task)
		if tk.State() != model.TaskDone {
			t.Errorf("entry %d ends %s as %s", e.V, e.Task, tk.State())
		}
		if l.State.EventSeq != seq+1 || e.Patch.State == nil {
			t.Errorf("entry %d ends %s without its event", e.V, e.Task)
			continue
		}
		found := false
		for _, ev := range e.Patch.State.Inbox {
			found = found || (ev.Seq == seq+1 && ev.Type == "task_done" && ev.Task == e.Task)
		}
		if !found {
			t.Errorf("entry %d: the event of %s is not in the inbox it records: %+v", e.V, e.Task, e.Patch.State.Inbox)
		}
		// The reporting task waits for both writers: the entry that ends the second one frees it.
		if rep, ok := mxByTitle(l, mxReport); ok && before == model.TaskDeps && rep.State() == model.TaskSlot {
			released = true
		}
	}
	if ends != 4 || !released {
		t.Errorf("%d task ends; the dependent task released in a task's own entry: %v", ends, released)
	}
}

// B3: whether nothing is running is decided from the tasks' states. The turn that follows the
// last task's end is an idle one: it is told so, and it counts.
func TestB03IdleFromStates(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		switch n {
		case 1:
			a.Add("Look", false)
			a.Add("Look again", false)
			a.Say("Two tasks.")
		case 2:
			a.h.open("second")
			a.Say("One is done.")
		default:
			if !a.Gate("last") {
				return
			}
			mxFinishWhenDone(a)
		}
	}, Task: func(a *mxTurn, tk Task) {
		if tk.ID == "T02" && !a.Gate("second") {
			return
		}
		a.Done("Looked.")
	}})
	h.startRun(nil)
	h.atGate("last")
	l := h.L()
	if len(l.Turns) != 3 {
		t.Fatalf("turns: %+v", l.Turns)
	}
	// Turn 2 began while the second task worked: woken by the first, not idle.
	if t2 := l.Turns[1]; t2.Reason != "events" || t2.Idle || len(t2.WokenBy) != 1 || t2.WokenBy[0].Task != "T01" {
		t.Errorf("turn 2: %+v", t2)
	}
	// Turn 3 began with the last task's end.
	if t3 := l.Turns[2]; t3.Reason != "idle" || !t3.Idle || len(t3.WokenBy) != 1 || t3.WokenBy[0].Task != "T02" {
		t.Errorf("turn 3: %+v", t3)
	}
	if l.State.IdleStreak != 1 {
		t.Errorf("the idle streak is %d", l.State.IdleStreak)
	}
	if p := h.promptsOf("turn-003"); len(p) != 1 || !strings.Contains(p[0], "Nothing is running and nothing can start") {
		t.Error("turn 3 was not told that nothing is running")
	}
	if p := h.promptsOf("turn-002"); len(p) != 1 || strings.Contains(p[0], "Nothing is running and nothing can start") {
		t.Error("turn 2 was told that nothing is running")
	}
	h.open("last")
	h.finished()
}

// B4: a change that cannot be written changes nothing. Here a task's brief cannot be written.
func TestB04FailedCommit(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	var refused atomic.Value
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		if n > 1 {
			mxFinishWhenDone(a)
			return
		}
		if !a.Gate("broken") {
			return
		}
		_, refusal := a.Add("While the folder is locked", false)
		refused.Store(refusal)
		if !a.Gate("mended") {
			return
		}
		a.Add("When it works again", false)
		a.Say("One task.")
	}})
	h.startRun(nil)
	h.atGate("broken")
	r := h.r()
	before := h.L()
	journal, _ := os.ReadFile(filepath.Join(r.dir, fileJournal))
	tasks := filepath.Join(r.dir, "tasks")
	if err := os.MkdirAll(tasks, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(tasks, 0o500); err != nil {
		t.Fatal(err)
	}
	h.open("broken")
	h.atGate("mended")
	os.Chmod(tasks, 0o700)
	if text, _ := refused.Load().(string); !strings.Contains(text, "internal error in add_task") {
		t.Errorf("the call that could not be recorded answered %q", text)
	}
	after := h.L()
	now, _ := os.ReadFile(filepath.Join(r.dir, fileJournal))
	if after.Version != before.Version || len(after.Tasks) != 0 || string(now) != string(journal) {
		t.Errorf("the failed change left: v%d → v%d, %d tasks, journal %d → %d bytes", before.Version, after.Version, len(after.Tasks), len(journal), len(now))
	}
	h.open("mended")
	l := h.finished()
	if len(l.Tasks) != 1 || l.Tasks[0].ID != "T01" {
		t.Errorf("tasks: %+v", l.Tasks)
	}
}

// B4, the script's case: get_run reads git before it takes the events. When git fails, the
// events stay in the inbox and are shown by the next get_run.
func TestB04GetRunGitFails(t *testing.T) {
	t.Parallel()
	h := newMx(t, true)
	var first, second atomic.Value
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		switch n {
		case 1:
			a.Add("Look", false)
			a.Add("Look again", false)
			a.Say("Two tasks.")
		case 2:
			a.h.open("second")
			if !a.Until(func(l *Loaded) bool { return mxState(l, "T02") == model.TaskDone }) || !a.Gate("broken") {
				return
			}
			text, isErr := a.Call("get_run", map[string]any{})
			first.Store(fmt.Sprintf("%v|%s", isErr, text))
			if !a.Gate("mended") {
				return
			}
			text, isErr = a.Call("get_run", map[string]any{})
			second.Store(fmt.Sprintf("%v|%s", isErr, text))
			a.Finish()
			a.Say("Finished.")
		}
	}, Task: func(a *mxTurn, tk Task) {
		if tk.ID == "T02" && !a.Gate("second") {
			return
		}
		a.Done("Looked.")
	}})
	h.startRun(nil)
	h.atGate("broken")
	head := filepath.Join(h.repo.Dir(), ".git", "HEAD")
	if err := os.Rename(head, head+".away"); err != nil {
		t.Fatal(err)
	}
	h.open("broken")
	h.atGate("mended")
	if err := os.Rename(head+".away", head); err != nil {
		t.Fatal(err)
	}
	if got, _ := first.Load().(string); !strings.HasPrefix(got, "true|internal error in get_run") {
		t.Errorf("get_run while git is broken answered %q", got)
	}
	l := h.L()
	if len(l.State.Inbox) != 1 || l.State.Inbox[0].Task != "T02" || len(l.Turns[1].Learned) != 0 {
		t.Fatalf("after the failed get_run: inbox %+v, learned %+v", l.State.Inbox, l.Turns[1].Learned)
	}
	h.open("mended")
	l = h.finished()
	if got, _ := second.Load().(string); !strings.HasPrefix(got, "false|") || !strings.Contains(got, "T02") {
		t.Errorf("the next get_run answered %.300q", got)
	}
	if len(l.State.Inbox) != 0 || len(l.Turns[1].Learned) != 1 || l.Turns[1].Learned[0].Task != "T02" {
		t.Errorf("after the next get_run: inbox %+v, learned %+v", l.State.Inbox, l.Turns[1].Learned)
	}
}

// B5: the events a failed turn was told about are told again to the next turn.
func TestB05FailedTurnEvents(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	var failed atomic.Bool
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		switch {
		case n == 1:
			a.Add("Look", false)
			a.Say("One task.")
		case failed.CompareAndSwap(false, true):
			a.Call("get_run", map[string]any{})
			a.Fail("the model fell over")
		default:
			mxFinishWhenDone(a)
		}
	}})
	h.startRun(func(m *model.RunMeta) { m.Settings.AgentRetries = 0 })
	l := h.waitStatus(model.RunError)
	if len(l.Turns) != 2 || l.Turns[1].Status != "failed" || len(l.Turns[1].WokenBy) != 1 || len(l.State.Inbox) != 1 ||
		l.State.Inbox[0].Seq != l.Turns[1].WokenBy[0].Seq || !strings.Contains(l.State.Reason, "orchestrator turn 2") {
		t.Fatalf("after the failed turn: %q, turns %+v, inbox %+v", l.State.Reason, l.Turns, l.State.Inbox)
	}
	if a, _ := mxAgent(l, "turn-002"); a.Status != model.AgentFailed {
		t.Errorf("the failed turn's agent is %s", a.Status)
	}
	h.idleEngine()
	h.resume()
	l = h.finished()
	if len(l.Turns) != 3 || len(l.Turns[2].WokenBy) != 1 || l.Turns[2].WokenBy[0].Task != "T01" || len(l.Turns[1].WokenBy) != 1 {
		t.Errorf("turn 3 was woken by %+v; the failed turn keeps %+v", l.Turns[2].WokenBy, l.Turns[1].WokenBy)
	}
	if p := h.promptsOf("turn-003"); len(p) == 0 || !strings.Contains(p[0], "T01") {
		t.Error("turn 3 was not told of T01's end")
	}
}

// B6: a turn that was running when the result was set is closed with the run. The server dies
// between finish_run and the turn's end; the next start finishes the run at once and closes the
// turn. And a stop in that window does not leave a stopped run whose result is set.
func TestB06TurnClosedAtFinish(t *testing.T) {
	t.Parallel()
	script := mxPlan{Turn: func(a *mxTurn, n int) {
		if n == 1 {
			a.Add("Look", false)
			a.Say("One task.")
			return
		}
		a.Say("All is done.")
		if refusal := a.Finish(); refusal != "" {
			a.Say("refused: " + refusal)
			return
		}
		a.Gate("after")
	}}
	check := func(t *testing.T, h *mx) {
		l := h.finished()
		last := l.Turns[len(l.Turns)-1]
		a, _ := mxAgent(l, fmt.Sprintf("turn-%03d", last.N))
		if last.Status != "done" || last.EndedAt == 0 || a.Status != model.AgentDone || l.State.Result == nil || l.State.Result.Outcome != model.Achieved {
			t.Errorf("the last turn %+v, its agent %s", last, a.Status)
		}
		for _, s := range l.Stops {
			if s.ResumedAt == 0 {
				t.Errorf("a finished run has an open stop: %+v", l.Stops)
			}
		}
	}
	t.Run("crash", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(script)
		h.startRun(nil)
		h.atGate("after")
		h.crash()
		check(t, h) // no resume: Boot finishes it
		if h.turnsOf("turn-002") != 1 {
			t.Errorf("the last turn's agent was run again")
		}
	})
	t.Run("quit", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(script)
		h.startRun(nil)
		h.atGate("after")
		h.restartQuit()
		check(t, h)
	})
	t.Run("stop", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(script)
		h.startRun(nil)
		h.atGate("after")
		if _, err := h.s().Stop(h.id); err != nil {
			t.Fatal(err)
		}
		check(t, h)
		if l := h.L(); len(l.Stops) != 0 {
			t.Errorf("stops of a run that finished: %+v", l.Stops)
		}
	})
}

// B7: the tasks a failed turn held are released, so after the resume they start, and the next
// turn is not an idle one.
func TestB07HoldsAfterFailedTurn(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		if n == 1 {
			a.Add("Look", false)
			a.Fail("the model fell over")
			return
		}
		mxFinishWhenDone(a)
	}})
	h.startRun(func(m *model.RunMeta) { m.Settings.AgentRetries = 0 })
	h.waitStatus(model.RunError)
	h.idleEngine()
	h.resume()
	l := h.finished()
	// The first turn after a person's resume is a "resume" turn, and it comes when nothing is
	// left to run: the task was not waiting for it.
	if len(l.Turns) != 2 || l.Turns[1].Reason != "resume" || len(l.Turns[1].WokenBy) != 1 || l.Turns[1].WokenBy[0].Task != "T01" {
		t.Errorf("the turns after the resume: %+v", l.Turns)
	}
	// The task started with the resume, before any turn: turn 2 began only when it had ended.
	_, at := h.task("T01")
	if at.StartedAt == 0 || l.Turns[1].StartedAt < at.EndedAt || at.Outcome != model.TaskDone {
		t.Errorf("the task ran %d–%d, turn 2 began at %d", at.StartedAt, at.EndedAt, l.Turns[1].StartedAt)
	}
	if l.State.IdleStreak != 0 {
		t.Errorf("the idle streak is %d", l.State.IdleStreak)
	}
}

// B8: the merge lock is not held while a merge agent works. During a resolution a new task
// starts, is merged and ends, and orchestrator turns start and end.
func TestB08TasksStartDuringResolution(t *testing.T) {
	t.Parallel()
	h := newMx(t, true)
	h.plan(mxPlan{
		Turn: func(a *mxTurn, n int) {
			l := a.State()
			switch {
			case n == 1:
				mxTwoWriters(a, 1)
			case len(l.Tasks) == 2:
				// The first later turn runs while the conflict is being resolved.
				if !a.Until(func(l *Loaded) bool { return a.h.turnsOf("T01-merge")+a.h.turnsOf("T02-merge") > 0 }) {
					return
				}
				a.Add("A file of its own", true)
				a.Say("One more task.")
			default:
				mxTwoWriters(a, n)
			}
		},
		Task: func(a *mxTurn, tk Task) {
			if tk.ID == "T03" {
				mxWriter(a, tk)
				return
			}
			mxLine(a, tk)
		},
		Merge: func(a *mxTurn, tk Task) {
			if !a.Gate("merge") {
				return
			}
			mxRefMerge(a)
		},
	})
	h.startRun(nil)
	h.atGate("merge")
	l := h.waitTask("T03", model.TaskDone, model.TaskFailed)
	t3, _ := mxTask(l, "T03")
	if t3.State() != model.TaskDone || t3.Attempts[0].Merged == "" || h.intFile("t03.txt") == "" {
		t.Fatalf("the task that started during the resolution: %s %+v\n%s", t3.State(), t3.Attempts[0], h.dump())
	}
	turnsDone := 0
	for _, tn := range l.Turns {
		if tn.Status == "done" {
			turnsDone++
		}
	}
	var resolving string
	for _, tk := range l.Tasks {
		if tk.State() == model.TaskMerge {
			resolving = tk.ID
		}
	}
	if resolving == "" || turnsDone < 2 {
		t.Fatalf("when T03 was done: resolving %q, %d turns done\n%s", resolving, turnsDone, h.dump())
	}
	h.open("merge")
	l = h.finished()
	if got := h.intFile("shared.txt"); got != "line of T01\nline of T02" {
		t.Errorf("shared.txt on the integration branch: %q", got)
	}
	if _, at := h.task(resolving); at.MergeRound != 1 {
		t.Errorf("the resolution took %d rounds although shared.txt did not move", at.MergeRound)
	}
}

// B9: the setup command can be cancelled, stopped and timed out. (A stop and a cancel in every
// other step are TestInv05StopReachesEveryWorker's.) This test changes the package's setup
// timeout, so it does not run beside the others.
func TestB09SetupCancelAndTimeout(t *testing.T) {
	old := engSetupTimeout
	defer func() { engSetupTimeout = old }()

	turn := func(a *mxTurn, n int) {
		if n == 1 {
			a.Notes()
			a.Add("Write a file", true)
			a.Say("One task.")
			return
		}
		if l := a.State(); l != nil && l.Tasks[0].State().Final() {
			a.Finish()
		}
		a.Say("Looked.")
	}
	t.Run("timeout", func(t *testing.T) {
		defer func() { engSetupTimeout = old }()
		// The shell has to start inside the timeout before the test can say anything about a
		// command that is cut off, and on a loaded machine the start alone can take longer than
		// 700ms. The command shows that it started by making a file, after it wrote its line and
		// apart from the log the test asserts: a run that timed out without the file says nothing
		// and is made again with a timeout four times as long, and a run with the file counts, so
		// a line the product lost fails here at once. Without the file the last one fails.
		boxes := []time.Duration{700 * time.Millisecond, 2800 * time.Millisecond, 11200 * time.Millisecond}
		for i, box := range boxes {
			engSetupTimeout = box
			h := newMx(t, true)
			mark := mxSetupMark(4901 + i)
			h.plan(mxPlan{Turn: turn, Task: mxWriter})
			started := filepath.Join(t.TempDir(), "started")
			h.startRun(func(m *model.RunMeta) {
				m.Settings.Setup = "echo getting ready; : > '" + strings.ReplaceAll(started, "'", `'\''`) + "'; sleep " + mark
			})
			l := h.finished()
			tk, _ := mxTask(l, "T01")
			at := tk.Attempts[0]
			timedOut := "the setup command timed out after " + box.String()
			setupLog, _ := os.ReadFile(setupLogPath(h.r().dir, "T01", 1))
			_, err := os.Stat(started)
			ran := err == nil
			if mxSleeping(mark) {
				exec.Command("pkill", "-f", "sleep "+mark).Run()
				t.Error("the setup command outlived its timeout")
			}
			if at.SetupDone || h.turnsOf("T01-work") != 0 || at.Worktree != "" {
				t.Errorf("after the timeout: setup done %v, the agent ran %d times, checkout %q", at.SetupDone, h.turnsOf("T01-work"), at.Worktree)
			}
			h.noCheckouts()
			if !ran {
				if i < len(boxes)-1 && !t.Failed() && tk.State() == model.TaskFailed && strings.Contains(at.Error, timedOut) {
					t.Logf("the setup command had not started after %s; again with a longer timeout", box)
					continue
				}
				t.Errorf("the setup command did not start inside %s (no file %s): the task %s %q, the setup log %q", box, started, tk.State(), at.Error, setupLog)
				return
			}
			if tk.State() != model.TaskFailed || !strings.Contains(at.Error, timedOut) || !strings.Contains(at.Error, "getting ready") {
				t.Errorf("the task: %s %q", tk.State(), at.Error)
			}
			if !strings.Contains(string(setupLog), "getting ready") {
				t.Errorf("the setup log: %q", setupLog)
			}
			return
		}
	})
	// The failing command runs with the timeout of production: nothing here is about a timeout.
	t.Run("a failing command", func(t *testing.T) {
		h := newMx(t, true)
		h.plan(mxPlan{Turn: turn, Task: mxWriter})
		h.startRun(func(m *model.RunMeta) { m.Settings.Setup = "echo no such tool >&2; exit 3" })
		l := h.finished()
		tk, _ := mxTask(l, "T01")
		if at := tk.Attempts[0]; tk.State() != model.TaskFailed || !strings.Contains(at.Error, "the setup command failed (exit 3)") || !strings.Contains(at.Error, "no such tool") {
			t.Errorf("the task: %s %q", tk.State(), at.Error)
		}
	})
}

// B10: the cost limit is not only checked when a turn is due. It halts a run while agents work,
// and never a run whose orchestrator has finished it.
func TestB10CostLimit(t *testing.T) {
	t.Parallel()
	t.Run("a halt while agents run", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{
			Turn: func(a *mxTurn, n int) {
				a.Cost(0.10, 10, 10)
				if n == 1 {
					a.Add("Costly", false)
					a.Add("Slow", false)
					a.Say("Two tasks.")
					return
				}
				mxFinishWhenDone(a)
			},
			Task: func(a *mxTurn, tk Task) {
				if tk.ID == "T02" {
					if !a.Gate("slow") {
						return
					}
					a.Cost(0.05, 5, 5)
					a.Done("Looked.")
					return
				}
				if !a.Until(func(l *Loaded) bool { return a.h.turnsOf("T02-work") >= 1 }) {
					return
				}
				a.Cost(0.45, 40, 40)
				a.Done("Looked, at a price.")
			},
		})
		h.startRun(func(m *model.RunMeta) { m.Settings.MaxCost = 0.50; m.Settings.Wake = "idle" })
		l := h.waitStatus(model.RunStalled, model.RunCompleted, model.RunError)
		if l.State.Status != model.RunStalled || l.State.StalledBy != model.StalledCost || l.State.Reason != "spent $0.55, over the limit of $0.50" {
			t.Fatalf("the run is %s/%s (%q)\n%s", l.State.Status, l.State.StalledBy, l.State.Reason, h.dump())
		}
		// The slow task was at work when the limit was reached; it is interrupted, not ended.
		slow, _ := mxAgent(l, "T02-work")
		if mxState(l, "T02") != model.TaskWork || slow.Status != model.AgentInterrupted || len(l.Turns) != 1 {
			t.Errorf("the task that was working: %s, its agent %s; %d turns", mxState(l, "T02"), slow.Status, len(l.Turns))
		}
		h.idleEngine()
		if _, err := h.s().Resume(h.id, ResumeReq{}); err == nil || !strings.Contains(err.Error(), "raise it to resume") {
			t.Errorf("a resume without a higher limit answered %v", err)
		}
		lim := 2.0
		if _, err := h.s().Resume(h.id, ResumeReq{MaxCost: &lim}); err != nil {
			t.Fatal(err)
		}
		h.open("slow")
		h.finished()
	})
	t.Run("none once the run is finished", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
			if n == 1 {
				a.Cost(0.10, 10, 10)
				a.Add("Look", false)
				a.Say("One task.")
				return
			}
			// The last turn alone costs more than the limit.
			a.Cost(0.90, 90, 90)
			a.Finish()
			if !a.Gate("last") {
				return
			}
			a.Say("Finished.")
		}})
		h.startRun(func(m *model.RunMeta) { m.Settings.MaxCost = 0.50 })
		h.atGate("last")
		for i := 0; i < 20; i++ {
			h.tick(2 * time.Second) // the ticker's cost check comes round
		}
		h.open("last")
		l := h.finished()
		if len(l.Stops) != 0 || l.State.StalledBy != "" {
			t.Errorf("the finished run was halted: %+v", l.Stops)
		}
		if sum := l.Summarize(false); sum.Cost == nil || *sum.Cost < 0.99 {
			t.Errorf("the run's cost: %v", sum.Cost)
		}
	})
}

// B11: a merge agent that says it could not resolve the conflict fails the task.
func TestB11MergeAgentFailed(t *testing.T) {
	t.Parallel()
	h := newMx(t, true)
	h.plan(mxPlan{Turn: mxTwoWriters, Task: mxLine, Merge: func(a *mxTurn, tk Task) {
		a.Write("shared.txt", "half an idea\n")
		a.Say(agentBlock("failed", "The two lines contradict each other.", "I cannot tell which line is wanted."))
	}})
	h.startRun(nil)
	l := h.finished()
	var failed, done Task
	for _, tk := range l.Tasks {
		if tk.State() == model.TaskFailed {
			failed = tk
		} else {
			done = tk
		}
	}
	if failed.ID == "" || done.State() != model.TaskDone {
		t.Fatalf("tasks: %s\n", h.dump())
	}
	at := failed.Attempts[0]
	if !strings.Contains(at.Error, "the merge agent could not resolve the conflict: The two lines contradict each other.") || at.Merged != "" || at.Worktree != "" {
		t.Errorf("the failed attempt: %q merged %q checkout %q", at.Error, at.Merged, at.Worktree)
	}
	if a, _ := mxAgent(l, failed.ID+"-merge"); a.Status != model.AgentDone {
		t.Errorf("the merge agent that answered is %s", a.Status)
	}
	if got := h.intFile("shared.txt"); got != "line of "+done.ID {
		t.Errorf("shared.txt on the integration branch: %q", got)
	}
	if bad := h.markersAnywhere(); bad != "" {
		t.Errorf("commits with conflict markers:\n%s", bad)
	}
	// The task's own commit is still on its branch; the merge it was in is gone.
	if got := h.repo.Git("log", "--format=%s", "--first-parent", "-2", "aiwb/"+h.id+"/"+failed.ID); !strings.Contains(got, failed.ID+": ") || strings.Contains(got, "Merge ") {
		t.Errorf("the failed task's branch: %q", got)
	}
	h.noCheckouts()
}

// B11: a merge agent that says "completed" and leaves the conflict half resolved fails the task
// too: the files are checked, not the agent's word.
func TestB11HalfResolved(t *testing.T) {
	t.Parallel()
	cases := map[string]func(a *mxTurn){
		"nothing touched": func(a *mxTurn) {},
		"one marker left": func(a *mxTurn) { a.Write("shared.txt", "line of T01\n=======\nline of T02\n") },
		"the merge ended by it": func(a *mxTurn) {
			a.Write("shared.txt", mxResolved(a.Read("shared.txt")))
			a.h.repo.GitIn(a.Cwd, "commit", "-qam", "mine")
		},
	}
	for name, leave := range cases {
		if !testset.Full() && name != "one marker left" {
			continue // a whole run each; TestMergeAgentFailsOrLeavesMarkers has the two other ways
		}
		t.Run(strings.ReplaceAll(name, " ", "_"), func(t *testing.T) {
			t.Parallel()
			h := newMx(t, true)
			h.plan(mxPlan{Turn: mxTwoWriters, Task: mxLine, Merge: func(a *mxTurn, tk Task) {
				leave(a)
				a.Done("All resolved.")
			}})
			h.startRun(nil)
			l := h.finished()
			var failed, done Task
			for _, tk := range l.Tasks {
				if tk.State() == model.TaskFailed {
					failed = tk
				} else {
					done = tk
				}
			}
			if failed.ID == "" || done.State() != model.TaskDone {
				t.Fatalf("no task failed\n%s", h.dump())
			}
			at := failed.Attempts[0]
			want := "the conflict is not resolved: shared.txt"
			if name == "the merge ended by it" {
				want = "the merge agent ended the merge itself"
			}
			if !strings.Contains(at.Error, want) || at.Merged != "" {
				t.Errorf("the failed attempt: %q merged %q", at.Error, at.Merged)
			}
			if got := h.intFile("shared.txt"); got != "line of "+done.ID {
				t.Errorf("shared.txt on the integration branch: %q", got)
			}
			if out, _ := h.repo.GitIn(h.repo.Dir(), "show", h.resultRef()+":shared.txt"); strings.Contains(out, "<<<<") || strings.Contains(out, "====") {
				t.Errorf("a marker reached the integration branch: %q", out)
			}
		})
	}
}

// B12: a merge that fails for another reason than a conflict fails the task and leaves both
// sides as they were: the integration branch is not merged into the task's branch.
func TestB12NonConflictFailure(t *testing.T) {
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
			if l := a.State(); l != nil && l.Tasks[0].State().Final() {
				a.Finish()
			}
			a.Say("Looked.")
		},
		Task: func(a *mxTurn, tk Task) {
			if !a.Gate("work") {
				return
			}
			mxWriter(a, tk)
		},
	})
	h.startRun(nil)
	h.atGate("work")
	// A file in the integration checkout that the merge would overwrite: git refuses the merge.
	intDir := filepath.Join(h.world().st.P.RunWorkDir(h.id), "int")
	if err := os.WriteFile(filepath.Join(intDir, "t01.txt"), []byte("in the way\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	base := h.L().State.Git.BaseRef
	h.open("work")
	l := h.waitTask("T01", model.TaskFailed, model.TaskDone)
	tk, _ := mxTask(l, "T01")
	at := tk.Attempts[0]
	ib := svcIntegrationBranch(h.id)
	if tk.State() != model.TaskFailed || !strings.Contains(at.Error, "merging T01 into "+ib+" failed") || !strings.Contains(at.Error, "t01.txt") {
		t.Fatalf("the task: %s %q", tk.State(), at.Error)
	}
	if at.MergeRound != 0 || at.Agents.Merge != "" || at.Merged != "" {
		t.Errorf("a failure that is no conflict opened a round: %+v", at)
	}
	if got := h.repo.Git("rev-parse", ib); got != base {
		t.Errorf("the integration branch moved to %s", got)
	}
	branch := "aiwb/" + h.id + "/T01"
	if got := h.repo.Git("log", "--format=%s", branch, "--not", "main"); got != "T01: Write a file" {
		t.Errorf("the task's branch has the commits %q", got)
	}
	if out := h.repo.Git("log", "--all", "--format=%s"); strings.Contains(out, "Merge "+ib+" into") {
		t.Errorf("a back-merge was committed:\n%s", out)
	}
	os.Remove(filepath.Join(intDir, "t01.txt"))
	h.finished()
}

// B13: the cancellation stays on its attempt when the task is retried.
func TestB13CancelKept(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	h.plan(mxPlan{
		Turn: func(a *mxTurn, n int) {
			if n == 1 {
				a.Add("Look", false)
				a.Say("One task.")
				return
			}
			mxFinishWhenDone(a)
		},
		Task: func(a *mxTurn, tk Task) {
			if len(tk.Attempts) == 1 && !a.Gate("work") {
				return
			}
			a.Done("Looked.")
		},
	})
	h.startRun(func(m *model.RunMeta) { m.Settings.Wake = "idle" })
	h.atGate("work")
	chat, token := h.newChat()
	if text, isErr := h.call(token, "cancel_task", map[string]any{"id": "T01", "reason": "the first try went wrong"}); isErr {
		t.Fatalf("cancel_task: %s", text)
	}
	if text, isErr := h.call(token, "retry_task", map[string]any{"id": "T01", "reason": "now with the right folder"}); isErr {
		t.Fatalf("retry_task: %s", text)
	}
	l := h.finished()
	tk, _ := mxTask(l, "T01")
	if len(tk.Attempts) != 2 || tk.Attempts[1].Outcome != model.TaskDone {
		t.Fatalf("attempts: %+v", tk.Attempts)
	}
	a1 := tk.Attempts[0]
	if a1.Outcome != model.TaskCancelled || a1.Cancel == nil || a1.Cancel.Reason != "the first try went wrong" || a1.Cancel.Chat != chat || a1.Cancel.T == 0 {
		t.Errorf("the cancelled attempt after the retry: %s %+v", a1.Outcome, a1.Cancel)
	}
	if tk.Attempts[1].Cancel != nil {
		t.Errorf("the retry carries a cancellation: %+v", tk.Attempts[1].Cancel)
	}
}

// B14: cancel_task and retry_task need a reason; cancelling a failed task stays allowed and
// keeps what the attempt recorded.
func TestB14EmptyReason(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	h.plan(mxPlan{
		Turn: func(a *mxTurn, n int) {
			if n == 1 {
				a.Add("Fails", false)
				a.Add("Works", false)
				a.Say("Two tasks.")
				return
			}
			if !a.Gate("end") {
				return
			}
			a.Finish()
			a.Say("Finished.")
		},
		Task: func(a *mxTurn, tk Task) {
			if tk.ID == "T01" {
				a.Say(agentBlock("failed", "It cannot be done.", "No way."))
				return
			}
			if !a.Gate("work") {
				return
			}
			a.Done("Looked.")
		},
	})
	h.startRun(func(m *model.RunMeta) { m.Settings.Wake = "idle" })
	h.atGate("work")
	h.waitTask("T01", model.TaskFailed)
	_, token := h.newChat()
	before := h.L()
	for _, c := range []struct{ tool, id, reason string }{
		{"cancel_task", "T02", ""}, {"cancel_task", "T02", "   "}, {"retry_task", "T01", ""}, {"cancel_task", "T01", ""},
	} {
		if text, isErr := h.call(token, c.tool, map[string]any{"id": c.id, "reason": c.reason}); !isErr || text != "the reason is empty" {
			t.Errorf("%s of %s with the reason %q answered %q (error %v)", c.tool, c.id, c.reason, text, isErr)
		}
	}
	after := h.L()
	if mxState(after, "T01") != model.TaskFailed || mxState(after, "T02") != model.TaskWork || len(after.Tasks[0].Attempts) != 1 {
		t.Fatalf("a refused call changed a task\n%s", h.dump())
	}
	failed := before.Tasks[0].Attempts[0]
	h.tick(5 * time.Second)
	if text, isErr := h.call(token, "cancel_task", map[string]any{"id": "T01", "reason": "we do without it"}); isErr {
		t.Fatalf("cancel_task of a failed task: %s", text)
	}
	tk, at := h.task("T01")
	if tk.State() != model.TaskCancelled || at.Error != failed.Error || at.Error == "" || at.Cancel == nil || at.Cancel.Reason != "we do without it" {
		t.Errorf("the failed task after its cancel: %s, error %q, cancel %+v", tk.State(), at.Error, at.Cancel)
	}
	if at.EndedAt != failed.EndedAt {
		t.Errorf("the cancel moved the attempt's end from %d to %d", failed.EndedAt, at.EndedAt)
	}
	h.open("work", "end")
	h.finished()
}

// B15: a task's kind must be a word.
func TestB15EmptyKind(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	var answers atomic.Value
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		if n > 1 {
			mxFinishWhenDone(a)
			return
		}
		var got []string
		for _, kind := range []string{"", "   ", "!!!", "---"} {
			text, isErr := a.Call("add_task", map[string]any{"title": "Look", "kind": kind, "writes": false, "tier": "standard", "tier_reason": "A test task.", "brief": mxBrief("Look at it.")})
			got = append(got, fmt.Sprintf("%q: %v|%s", kind, isErr, text))
		}
		answers.Store(got)
		// What can be made a word is made one.
		a.Call("add_task", map[string]any{"title": "Look", "kind": "Two Words!", "writes": false, "tier": "standard", "tier_reason": "A test task.", "brief": mxBrief("Look at it.")})
		a.Say("One task.")
	}})
	h.startRun(nil)
	l := h.finished()
	got, _ := answers.Load().([]string)
	if len(got) != 4 {
		t.Fatalf("answers: %v", got)
	}
	for _, g := range got {
		if !strings.HasSuffix(g, ": true|kind must be one short word, e.g. research, implement, review") {
			t.Errorf("add_task with the kind %s", g)
		}
	}
	if len(l.Tasks) != 1 || l.Tasks[0].Kind != "two-words" {
		t.Errorf("tasks: %+v", l.Tasks)
	}
	for _, op := range l.Turns[0].Ops {
		if op.Op == "add_task" && op.Error != "" && op.Task != "" {
			t.Errorf("a refused add_task names a task: %+v", op)
		}
	}
}

// B16: a result block is taken only when it is one. An outcome that is neither "completed" nor
// "failed", and an empty summary, are no block: the agent is asked again.
func TestB16BlockValidation(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	h.plan(mxPlan{
		Turn: func(a *mxTurn, n int) {
			if n == 1 {
				a.Add("Look", false)
				a.Say("One task.")
				return
			}
			mxFinishWhenDone(a)
		},
		Task: func(a *mxTurn, tk Task) {
			switch a.N {
			case 1:
				a.Say(agentBlock("maybe", "It might be done.", "Hard to say."))
			case 2:
				a.Say(agentBlock("completed", "  ", "A report without a summary."))
			default:
				a.Say(agentBlock("completed", "It is done.", "The whole report."))
			}
		},
	})
	h.startRun(nil)
	l := h.finished()
	_, at := h.task("T01")
	if at.Result == nil || at.Result.Outcome != "completed" || at.Result.Summary != "It is done." {
		t.Fatalf("the result: %+v", at.Result)
	}
	prompts := h.promptsOf("T01-work")
	if len(prompts) != 3 || prompts[1] != engRepairMessage || prompts[2] != engRepairMessage {
		t.Errorf("the agent got %d messages", len(prompts))
	}
	if a, _ := mxAgent(l, "T01-work"); len(a.Launches) != 1 || a.Failures != 0 || a.Status != model.AgentDone {
		t.Errorf("the agent: %+v", a)
	}
	if rep, err := readReport(h.r().dir, "T01", 1); err != nil || rep != "The whole report." {
		t.Errorf("the report: %q %v", rep, err)
	}
}

// B17: a tool call that was let in while its turn ran and is carried out after the turn's end
// changes nothing. The call passes the "is its turn running" check, is held there until the turn
// has ended, and is then refused inside its own entry.
func TestB17LateCallRefused(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		if n == 1 {
			a.Add("Look", false)
			if !a.Gate("turn") {
				return
			}
			a.Say("One task.")
			return
		}
		if !a.Gate("end") {
			return
		}
		mxFinishWhenDone(a)
	}})
	h.startRun(nil)
	h.atGate("turn")
	token := h.token("turn-001")
	chat := AgentChatID(h.id, "turn-001")
	passed, release := make(chan bool, 1), make(chan struct{})
	h.mu.Lock()
	h.turnRunning = func(id string, running bool) {
		if id == chat {
			select {
			case passed <- running:
				<-release
			default:
			}
		}
	}
	h.mu.Unlock()
	type answer struct {
		text  string
		isErr bool
	}
	got := make(chan answer, 1)
	go func() {
		text, isErr := h.call(token, "add_task", map[string]any{"title": "Too late", "kind": "research", "writes": false, "tier": "standard", "tier_reason": "A test task.", "brief": mxBrief("Look at it.")})
		got <- answer{text, isErr}
	}()
	if running := <-passed; !running {
		t.Fatal("the turn was not running when the call came in")
	}
	// The call is past the check. The turn ends.
	h.open("turn")
	h.waitL("turn 1 to end", func(l *Loaded) bool { return l.Turns[0].Status == "done" })
	close(release)
	a := <-got
	if !a.isErr || a.text != "the orchestrator's turn is over; add_task was not run" {
		t.Errorf("the late call answered %q (error %v)", a.text, a.isErr)
	}
	l := h.L()
	if len(l.Tasks) != 1 || l.Tasks[0].Title != "Look" {
		t.Errorf("tasks after the late call: %+v", l.Tasks)
	}
	for _, tn := range l.Turns {
		for _, op := range tn.Ops {
			if op.Title == "Too late" || (op.Op == "add_task" && op.Error != "") {
				t.Errorf("the late call is recorded in turn %d: %+v", tn.N, op)
			}
		}
	}
	h.mu.Lock()
	h.turnRunning = nil
	h.mu.Unlock()
	h.open("end")
	h.finished()
}

// B18: the counters that bound a run survive a restart: an agent's failures and its back-off, and
// the idle streak.
func TestB18CountersSurviveRestart(t *testing.T) {
	t.Parallel()
	t.Run("failures", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{
			Turn: func(a *mxTurn, n int) {
				if n == 1 {
					a.Add("Look", false)
					a.Say("One task.")
					return
				}
				if l := a.State(); l != nil && l.Tasks[0].State().Final() {
					a.Finish()
				}
				a.Say("Looked.")
			},
			Task: func(a *mxTurn, tk Task) { a.Fail("overloaded") },
		})
		h.mu.Lock()
		h.still = true
		h.mu.Unlock()
		h.startRun(func(m *model.RunMeta) { m.Settings.AgentRetries = 1 })
		l := h.waitL("the first failure", func(l *Loaded) bool {
			a, ok := mxAgent(l, "T01-work")
			return ok && a.Failures == 1 && a.RetryAt > 0
		})
		was, _ := mxAgent(l, "T01-work")
		h.crash()
		h.waitStatus(model.RunStopped)
		if a, _ := mxAgent(h.L(), "T01-work"); a.Failures != 1 || a.RetryAt != was.RetryAt {
			t.Fatalf("after the restart: failures %d, retry at %d (was %d)", a.Failures, a.RetryAt, was.RetryAt)
		}
		h.resume()
		h.mu.Lock()
		h.still = false
		h.mu.Unlock()
		l = h.finished()
		a, _ := mxAgent(l, "T01-work")
		// One retry is allowed: the failure before the restart counts, so the second launch's
		// failure is the last.
		if a.Status != model.AgentFailed || a.Failures != 2 || len(a.Launches) != 2 || mxState(l, "T01") != model.TaskFailed {
			t.Errorf("the agent after the restart: %s, %d failures, %d launches", a.Status, a.Failures, len(a.Launches))
		}
	})
	t.Run("idle streak", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
			if n == 3 && len(a.h.promptsOf("turn-003")) == 1 && !a.Gate("third") {
				return
			}
			a.Say("Nothing to do.")
		}})
		h.startRun(nil)
		h.atGate("third")
		if l := h.L(); l.State.IdleStreak != 2 || fmt.Sprint(mxReasons(l)) != "[start idle idle]" {
			t.Fatalf("before the restart: streak %d, turns %v", l.State.IdleStreak, mxReasons(l))
		}
		h.restartQuit() // the server continues the run by itself
		l := h.waitStatus(model.RunStalled, model.RunCompleted, model.RunError)
		if l.State.StalledBy != model.StalledIdle || l.State.IdleStreak != 3 || fmt.Sprint(mxReasons(l)) != "[start idle idle idle]" {
			t.Errorf("after the restart: %s/%s, streak %d, turns %v", l.State.Status, l.State.StalledBy, l.State.IdleStreak, mxReasons(l))
		}
		h.idleEngine()
	})
}
