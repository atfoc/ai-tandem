package runs

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

// The reference run, uninterrupted: the base line of every restart test.
func TestMatrixReferenceRun(t *testing.T) {
	t.Parallel()
	h := newMx(t, true)
	h.startRun(nil)
	end := h.refEnd()
	l := h.L()
	if !mxMergeAgentRan(l) {
		t.Errorf("no merge agent ran: the two writers did not conflict\n%s", h.dump())
	}
	if len(end.Tasks) != 4 {
		t.Errorf("tasks: %v", end.Tasks)
	}
}

func mxMergeAgentRan(l *Loaded) bool {
	return slices.ContainsFunc(l.Agents, func(a Agent) bool { return a.Role == model.RoleMerge && a.Status == model.AgentDone })
}

// sameEnd compares the end of a restarted reference run with the uninterrupted one's: the same
// status and outcome, the same tasks all done, the same files in the result with the same lines
// (the order of the two lines in shared.txt follows the order of the merges), the same delivery
// and the same files in the person's folder.
func (h *mx) sameEnd(got, want mxEnd) {
	h.t.Helper()
	if got.Status != want.Status || got.Outcome != want.Outcome {
		h.t.Errorf("ended %s/%s, the uninterrupted run %s/%s", got.Status, got.Outcome, want.Status, want.Outcome)
	}
	if fmt.Sprint(got.Tasks) != fmt.Sprint(want.Tasks) {
		h.t.Errorf("tasks %v, the uninterrupted run %v", got.Tasks, want.Tasks)
	}
	lines := func(files map[string]string) string {
		var out []string
		for name, text := range files {
			ls := strings.Split(strings.TrimSpace(text), "\n")
			sort.Strings(ls)
			out = append(out, name+": "+strings.Join(ls, " | "))
		}
		sort.Strings(out)
		return strings.Join(out, "\n")
	}
	if g, w := lines(got.Files), lines(want.Files); g != w {
		h.t.Errorf("the integration branch holds\n%s\nthe uninterrupted run's\n%s", g, w)
	}
	if got.Delivery != want.Delivery {
		h.t.Errorf("the delivery is %s, the uninterrupted run's %s", got.Delivery, want.Delivery)
	}
	if g, w := lines(got.Folder), lines(want.Folder); g != w {
		h.t.Errorf("the person's folder holds\n%s\nthe uninterrupted run's\n%s", g, w)
	}
}

// awaitFired waits until the armed crash or quit happened; false when the run ended first.
func (h *mx) awaitFired(fired <-chan struct{}) bool {
	h.t.Helper()
	deadline := time.Now().Add(mxWait)
	for {
		select {
		case <-fired:
			return true
		default:
		}
		if h.view().Status.Final() {
			select {
			case <-fired:
				return true
			default:
				return false
			}
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("the run neither got to the armed point nor ended\n%s", h.dump())
		}
		h.clock.Advance(500 * time.Millisecond)
		time.Sleep(3 * time.Millisecond)
	}
}

// launches counts the processes started and the messages taken so far.
func (h *mx) launches() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, e := range h.log {
		if e.Kind == "spawn" || e.Kind == "turn" {
			n++
		}
	}
	return n
}

// quiet moves the clock a minute ahead in steps and reports whether anything was launched.
func (h *mx) quiet() bool {
	before := h.launches()
	for i := 0; i < 12; i++ {
		h.tick(5 * time.Second)
	}
	return h.launches() == before
}

// The run is dropped at every journal entry of the reference run in turn, the way a crash drops
// it (nothing more is written, no agent is ended, the home folder stays as it was at that
// instant), and a new server starts on the same folders. It must find the run stopped with the
// crash sentence and launch nothing; after a Resume the run must end exactly as the
// uninterrupted one. A second sweep quits the server in an orderly way at chosen points; the
// run must then continue by itself to the same end.
func TestRestartAtEveryStep(t *testing.T) {
	base := newMx(t, true)
	base.startRun(nil)
	want := base.refEnd()
	entries := base.journalWhole()
	n := int64(len(entries))
	if !mxMergeAgentRan(base.L()) {
		t.Fatalf("the reference run had no conflict\n%s", base.dump())
	}
	t.Logf("the reference run has %d journal entries", n)

	// A few more than the reference run had: the order of some entries differs from run to run.
	var ks []int64
	for k := int64(1); k <= n+3; k++ {
		if testing.Short() && k%16 != 1 {
			continue
		}
		ks = append(ks, k)
	}
	t.Run("crash", func(t *testing.T) {
		for _, k := range ks {
			t.Run(fmt.Sprintf("entry%02d", k), func(t *testing.T) {
				t.Parallel()
				h := newMx(t, true)
				h.newRun(nil)
				fired := h.crashAtEntry(k)
				_, err := h.s().Start(h.id, mxGoal)
				if k == 1 {
					// Entry 1 is written before run.json says the run has started: a server that
					// dies there leaves a draft, and the goal is sent again.
					if !errors.Is(err, ErrNotFound) {
						t.Fatalf("the start that was cut off answered %v", err)
					}
					<-fired
					h.reboot(false)
					if v := h.view(); v.Status != model.RunDraft {
						t.Fatalf("after a crash inside the start the run is %s", v.Status)
					}
					h.begin()
					h.sameEnd(h.refEnd(), want)
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				if !h.awaitFired(fired) {
					t.Logf("this run ended before entry %d", k)
					h.sameEnd(h.refEnd(), want)
					return
				}
				h.reboot(false)
				l := h.L()
				if l.State.Status.Final() {
					h.sameEnd(h.refEnd(), want) // the crash came after the run's last entry
					return
				}
				stops := l.Stops
				if l.State.Status != model.RunStopped || l.State.Reason != engReasonCrash || len(stops) == 0 ||
					stops[len(stops)-1].Reason != model.StopAppQuit || stops[len(stops)-1].ResumedAt != 0 {
					t.Fatalf("after the crash the run is %s (%q), stops %+v", l.State.Status, l.State.Reason, stops)
				}
				for _, a := range l.Agents {
					if a.Status == model.AgentRunning {
						t.Errorf("agent %s is recorded as running in a stopped run", a.Name)
					}
				}
				if !h.quiet() {
					t.Fatalf("something was launched before the run was resumed\n%s", h.dump())
				}
				if h.L().Version != l.Version {
					t.Fatalf("the stopped run's record moved from v%d to v%d", l.Version, h.L().Version)
				}
				if _, err := h.s().Resume(h.id, ResumeReq{}); err != nil {
					t.Fatalf("resume: %v", err)
				}
				h.sameEnd(h.refEnd(), want)
			})
		}
	})

	// The orderly quit, at points chosen by what is recorded.
	agentLaunched := func(l *Loaded, role model.AgentRole, title string) bool {
		for _, a := range l.Agents {
			if a.Role != role || len(a.Launches) == 0 || a.Status != model.AgentRunning {
				continue
			}
			if title == "" {
				return true
			}
			if t, ok := mxTask(l, a.Task); ok && t.Title == title {
				return true
			}
		}
		return false
	}
	attempt := func(l *Loaded, ok func(a Attempt) bool) bool {
		for _, t := range l.Tasks {
			if n := len(t.Attempts); n > 0 && t.Writes && ok(t.Attempts[n-1]) {
				return true
			}
		}
		return false
	}
	points := []struct {
		name string
		when func(l *Loaded) bool
	}{
		{"during the first turn", func(l *Loaded) bool { return agentLaunched(l, model.RoleOrchestrator, "") }},
		{"during the first turn, a task added", func(l *Loaded) bool { return len(l.Tasks) == 1 }},
		{"during a later turn", func(l *Loaded) bool { return len(l.Turns) >= 2 && agentLaunched(l, model.RoleOrchestrator, "") }},
		{"during the work of a writer", func(l *Loaded) bool { return agentLaunched(l, model.RoleTask, mxOne) }},
		{"during the work of the reporter", func(l *Loaded) bool { return agentLaunched(l, model.RoleTask, mxReport) }},
		{"during the chat's task", func(l *Loaded) bool { return agentLaunched(l, model.RoleTask, mxFourth) }},
		{"a result recorded, not committed", func(l *Loaded) bool {
			return attempt(l, func(a Attempt) bool { return a.WorkDone && a.Head == "" && a.Outcome == "" })
		}},
		{"committed, not merged", func(l *Loaded) bool {
			return attempt(l, func(a Attempt) bool { return a.Head != "" && a.Merged == "" && a.MergeRound == 0 })
		}},
		{"a round opened, its agent not named", func(l *Loaded) bool {
			return attempt(l, func(a Attempt) bool { return a.MergeRound == 1 && a.Agents.Merge == "" })
		}},
		{"during the merge agent", func(l *Loaded) bool { return agentLaunched(l, model.RoleMerge, "") }},
		{"the merge agent done, not concluded", func(l *Loaded) bool {
			return attempt(l, func(a Attempt) bool { return a.MergeAgentDone == 1 && a.Merged == "" })
		}},
		{"merged, not ended", func(l *Loaded) bool {
			return attempt(l, func(a Attempt) bool { return a.Merged != "" && a.Outcome == "" })
		}},
		{"the result set, the turn running", func(l *Loaded) bool { return l.State.Result != nil && l.State.Status == model.RunRunning }},
	}
	t.Run("quit", func(t *testing.T) {
		for i, p := range points {
			if testing.Short() && i%6 != 0 {
				continue
			}
			t.Run(strings.ReplaceAll(p.name, " ", "_"), func(t *testing.T) {
				t.Parallel()
				h := newMx(t, true)
				h.newRun(nil)
				fired := h.quitWhen(p.when)
				h.begin()
				if !h.awaitFired(fired) {
					t.Fatalf("the run never was at this point\n%s", h.dump())
				}
				before := h.L()
				h.reboot(true)
				l := h.L()
				// A quit after finish_run may find the run already ended by its engine: with the
				// result set the last worker's return finishes the run instead of halting it
				// (sched.go, "finished when the stop came after finish_run"), and then no stop is
				// recorded. Which of the two comes first is a matter of timing; both end the same.
				finishedInQuit := before.State.Result != nil && l.State.Status.Final() && len(l.Stops) == 0
				if !before.State.Status.Final() && !finishedInQuit {
					stops := l.Stops
					if len(stops) != 1 || stops[0].Reason != model.StopAppQuit || stops[0].ResumedAt == 0 {
						t.Fatalf("after the quit and the start: status %s (%q), stops %+v\n%s", l.State.Status, l.State.Reason, stops, h.dump())
					}
				}
				h.sameEnd(h.refEnd(), want)
			})
		}
	})
}

// oneTask is a run of one reporting task whose agent waits at the gate "work" in its first
// message of every process.
func mxOneTask(h *mx) {
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
			if !a.Gate("work") {
				return
			}
			a.Done("Looked.")
		},
	})
}

// A quit while an agent's message is on its way to the chat manager. The engine's send returns at
// once when the server is going down ("the server closes the process itself", agentrun.go send),
// so Service.Shutdown does not wait for the message; chats.Manager.Shutdown closes the processes
// it finds and refuses nothing afterwards. A message that reaches the manager after that starts
// the agent's process, and nothing ends it.
func TestQuitWhileAnAgentStarts(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	mxOneTask(h)
	held, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	h.mu.Lock()
	h.beforeSend = func(name string) {
		if name == "T01-work" {
			once.Do(func() { close(held) })
			<-release
		}
	}
	h.mu.Unlock()
	h.startRun(nil)
	h.wait("the task agent's message to be on its way", func() bool {
		select {
		case <-held:
			return true
		default:
			return false
		}
	})
	// The server goes down as main does.
	w := h.world()
	w.s.Shutdown(20 * time.Second)
	w.dead.Store(true)
	w.cm.Shutdown()
	close(release)
	for deadline := time.Now().Add(20 * time.Second); w.sending.Load() > 0 && time.Now().Before(deadline); {
		time.Sleep(2 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	if names := h.liveNames(); names != "" {
		t.Errorf("started after the server's shutdown and left alive: %s", names)
	}
	w.cm.Shutdown() // the test's own end: nothing may be left of it
}

// A git command of the engine that a stop or a crash ends in the middle of a write (the engine
// ends its git commands with SIGTERM, rungit/exec.go runGroup) can leave a lock file behind:
// index.lock or HEAD.lock in the git dir of the task's checkout. Nothing removes it. After the
// resume every commit in that checkout fails ("Unable to create ... .lock: File exists"), also the
// one that saves the unfinished work, and the task fails with "its work could not be committed".
// Here the lock is put there by hand, in a run stopped while its task works.
func TestStaleGitLockAfterStop(t *testing.T) {
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
			if !a.Gate("work") {
				return
			}
			mxWriter(a, tk)
		},
	})
	h.startRun(nil)
	h.atGate("work")
	h.stopRun()
	h.idleEngine()
	_, at := h.task("T01")
	gitDir, err := h.repo.GitIn(at.Worktree, "rev-parse", "--absolute-git-dir")
	if err != nil {
		t.Fatalf("the checkout's git dir: %v %s", err, gitDir)
	}
	if err := os.WriteFile(filepath.Join(gitDir, "index.lock"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	h.open("work")
	h.resume()
	l := h.waitStatus(model.RunCompleted, model.RunGaveUp, model.RunStalled, model.RunError)
	if tk, at := h.task("T01"); tk.State() != model.TaskDone {
		t.Errorf("after the resume the task ended %s: %s", tk.State(), at.Error)
	}
	if l.State.Status != model.RunCompleted {
		t.Errorf("the run ended %s (%s)", l.State.Status, l.State.Reason)
	}
}

// A stop in the middle of a task: stopping, then stopped, with nothing left working; the resume
// continues the same agent in its session, with the resume message.
func TestStopResume(t *testing.T) {
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
			a.Cost(0.04, 4, 4)
			a.Write("half.txt", "half\n")
			if !a.Gate("work") {
				return
			}
			mxWriter(a, tk)
		},
	})
	h.startRun(nil)
	h.atGate("work")
	h.tick(30 * time.Second)
	v, err := h.s().Stop(h.id)
	if err != nil || v.Status != model.RunStopping {
		t.Fatalf("stop answered %s, %v", v.Status, err)
	}
	l := h.waitStatus(model.RunStopped)
	a, _ := mxAgent(l, "T01-work")
	if l.State.Reason != "stopped by the user" || len(l.Stops) != 1 || l.Stops[0].Reason != model.StopUser || l.Stops[0].ResumedAt != 0 ||
		a.Status != model.AgentInterrupted || len(a.Launches) != 1 || a.Launches[0].EndedAt == 0 || a.Launches[0].Error != "" || !a.Resumable {
		t.Fatalf("stopped: %q, stops %+v, the agent %+v", l.State.Reason, l.Stops, a)
	}
	if mxState(l, "T01") != model.TaskWork || l.State.ActiveMs < 30_000 {
		t.Errorf("the task is %s; the run worked for %d ms", mxState(l, "T01"), l.State.ActiveMs)
	}
	h.idleEngine()
	active := l.State.ActiveMs
	h.tick(time.Hour) // a stopped run's clock stands
	if _, err := h.s().Stop(h.id); err != ErrNotRunning {
		t.Errorf("a stop of a stopped run answered %v", err)
	}
	h.regate("work")
	h.resume()
	h.atGate("work")
	l = h.L()
	if l.State.Status != model.RunRunning || l.Stops[0].ResumedAt == 0 || l.State.Reason != "" || l.State.ActiveMs != active {
		t.Errorf("resumed: %s %q, stops %+v, worked %d ms (was %d)", l.State.Status, l.State.Reason, l.Stops, l.State.ActiveMs, active)
	}
	h.open("work")
	l = h.finished()
	a, _ = mxAgent(l, "T01-work")
	if len(a.Launches) != 2 || !a.Launches[1].Resume || a.Status != model.AgentDone {
		t.Errorf("the agent after the resume: %+v", a)
	}
	prompts := h.promptsOf("T01-work")
	if len(prompts) != 2 || !strings.HasPrefix(prompts[1], "Your previous run of this job stopped before it finished") || !strings.Contains(prompts[1], prompts[0]) {
		t.Errorf("the agent's second message is not the resume message with the first in it")
	}
	sp := h.spawnsWith("T01-work")
	if len(sp) != 2 || sp[0].Resume || !sp[1].Resume || sp[0].SessionID == "" || sp[0].SessionID != sp[1].SessionID {
		t.Errorf("the agent's processes: %+v", sp)
	}
	if h.intFile("half.txt") != "half" || h.intFile("t01.txt") == "" {
		t.Error("the work of before and after the stop is not both on the integration branch")
	}
}

// While a run is stopping, a second stop changes nothing, a resume is refused, the tools refuse
// to change it; when the last worker has let go the run is stopped, once.
func TestStopWhileStopping(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	h.plan(mxPlan{
		Turn: func(a *mxTurn, n int) {
			if n == 1 {
				a.Add("Look", false)
				a.Add("Look again", false)
				a.Say("Two tasks.")
				return
			}
			mxFinishWhenDone(a)
		},
		Task: func(a *mxTurn, tk Task) {
			if len(a.h.promptsOf(a.Name)) == 1 {
				<-a.h.gate("hold").open // an agent that does not let go at once
			}
			a.Done("Looked.")
		},
	})
	h.startRun(func(m *model.RunMeta) { m.Settings.Wake = "idle" })
	h.wait("both agents to work", func() bool { return h.turnsOf("T01-work") == 1 && h.turnsOf("T02-work") == 1 })
	_, token := h.newChat()
	v1, err := h.s().Stop(h.id)
	if err != nil || v1.Status != model.RunStopping {
		t.Fatalf("stop: %s %v", v1.Status, err)
	}
	version := h.L().Version
	v2, err := h.s().Stop(h.id)
	if err != nil || v2.Status != model.RunStopping {
		t.Errorf("the second stop: %s %v", v2.Status, err)
	}
	if _, err := h.s().Resume(h.id, ResumeReq{}); err != ErrStopping {
		t.Errorf("a resume while stopping answered %v", err)
	}
	if text, isErr := h.call(token, "add_task", map[string]any{"title": "More", "kind": "research", "writes": false, "tier": "standard", "tier_reason": "A test task.", "brief": mxBrief("Look.")}); !isErr || text != toolStopping {
		t.Errorf("add_task while stopping answered %q (error %v)", text, isErr)
	}
	if text, isErr := h.call(token, "get_run", map[string]any{}); isErr || !strings.Contains(text, "stopping") {
		t.Errorf("get_run while stopping answered %.200q (error %v)", text, isErr)
	}
	l := h.L()
	if l.State.Status != model.RunStopping || l.State.Halting == nil || len(l.Stops) != 0 {
		t.Fatalf("while stopping: %s, halting %+v, stops %+v", l.State.Status, l.State.Halting, l.Stops)
	}
	stopping := 0
	for _, e := range h.journalWhole() {
		if e.Kind == KRunStopping {
			stopping++
		}
	}
	if stopping != 1 || l.Version < version {
		t.Errorf("%d run_stopping entries", stopping)
	}
	h.open("hold")
	l = h.waitStatus(model.RunStopped)
	if len(l.Stops) != 1 || l.State.Halting != nil || len(l.Tasks) != 2 {
		t.Errorf("stopped: stops %+v, halting %+v, %d tasks", l.Stops, l.State.Halting, len(l.Tasks))
	}
	h.idleEngine()
	h.resume()
	h.finished()
}

// A run that a limit stalled resumes only with that limit raised above what is used; the new
// value is in run.json before the run goes on.
func TestResumeRaisesLimit(t *testing.T) {
	t.Parallel()
	t.Run("turns", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
			if n == 1 {
				a.Add("Look", false)
				a.Say("One task.")
				return
			}
			if n < 3 {
				a.Say("Not yet.")
				return
			}
			mxFinishWhenDone(a)
		}})
		h.startRun(func(m *model.RunMeta) { m.Settings.MaxTurns = 2 })
		l := h.waitStatus(model.RunStalled, model.RunCompleted, model.RunError)
		if l.State.StalledBy != model.StalledTurns || l.State.Reason != "reached the limit of 2 orchestrator turns" || len(l.Turns) != 2 {
			t.Fatalf("the run is %s/%s (%q) after %d turns", l.State.Status, l.State.StalledBy, l.State.Reason, len(l.Turns))
		}
		h.idleEngine()
		var le *LimitError
		if _, err := h.s().Resume(h.id, ResumeReq{}); !errors.As(err, &le) || !errors.Is(err, ErrLimit) {
			t.Errorf("a resume without a limit answered %v", err)
		}
		for _, n := range []int{1, 2} {
			if _, err := h.s().Resume(h.id, ResumeReq{MaxTurns: &n}); err == nil || !strings.Contains(err.Error(), "the limit must be higher") {
				t.Errorf("a resume with maxTurns %d answered %v", n, err)
			}
		}
		if h.view().Status != model.RunStalled {
			t.Fatalf("a refused resume changed the status to %s", h.view().Status)
		}
		n := 4
		v, err := h.s().Resume(h.id, ResumeReq{MaxTurns: &n})
		if err != nil || v.Status != model.RunRunning || v.Settings.MaxTurns != 4 {
			t.Fatalf("the resume: %s, maxTurns %d, %v", v.Status, v.Settings.MaxTurns, err)
		}
		if meta, err := readMeta(h.r().dir); err != nil || meta.Settings.MaxTurns != 4 {
			t.Errorf("run.json: maxTurns %d %v", meta.Settings.MaxTurns, err)
		}
		l = h.finished()
		if fmt.Sprint(mxReasons(l)) != "[start idle resume]" {
			t.Errorf("turns: %v", mxReasons(l))
		}
	})
	t.Run("cost", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
			a.Cost(0.30, 30, 30)
			if n == 1 {
				a.Add("Look", false)
				a.Say("One task.")
				return
			}
			mxFinishWhenDone(a)
		}, Task: func(a *mxTurn, tk Task) {
			a.Cost(0.30, 30, 30)
			a.Done("Looked.")
		}})
		h.startRun(func(m *model.RunMeta) { m.Settings.MaxCost = 0.50 })
		l := h.waitStatus(model.RunStalled, model.RunCompleted, model.RunError)
		if l.State.StalledBy != model.StalledCost || l.State.Reason != "spent $0.60, over the limit of $0.50" {
			t.Fatalf("the run is %s/%s (%q)", l.State.Status, l.State.StalledBy, l.State.Reason)
		}
		h.idleEngine()
		if _, err := h.s().Resume(h.id, ResumeReq{}); !errors.Is(err, ErrLimit) {
			t.Errorf("a resume without a limit answered %v", err)
		}
		for _, c := range []float64{0.5, 0.6, -1} {
			if _, err := h.s().Resume(h.id, ResumeReq{MaxCost: &c}); err == nil {
				t.Errorf("a resume with maxCost %v was taken", c)
			}
		}
		c := 0.0 // no limit
		if v, err := h.s().Resume(h.id, ResumeReq{MaxCost: &c}); err != nil || v.Settings.MaxCost != 0 {
			t.Fatalf("the resume with no limit: %v", err)
		}
		h.finished()
	})
}

// A server that is closed in an orderly way while a run works finds the run stopped by the app
// at its next start, and continues it by itself.
func TestBootContinues(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	mxOneTask(h)
	h.startRun(nil)
	h.atGate("work")
	h.stopWorld(true)
	// What the closed server left.
	w := h.start()
	l := h.L()
	if l.State.Status != model.RunStopped || l.State.Reason != engReasonQuit || len(l.Stops) != 1 || l.Stops[0].Reason != model.StopAppQuit || l.Stops[0].ResumedAt != 0 {
		t.Fatalf("the closed server left: %s (%q), stops %+v", l.State.Status, l.State.Reason, l.Stops)
	}
	if a, _ := mxAgent(l, "T01-work"); a.Status != model.AgentInterrupted {
		t.Errorf("the agent is recorded as %s", a.Status)
	}
	h.regate("work")
	h.mu.Lock()
	h.frozen = false
	h.mu.Unlock()
	w.s.Boot()
	h.atGate("work")
	l = h.L()
	if l.State.Status != model.RunRunning || l.Stops[0].ResumedAt == 0 || l.State.Reason != "" {
		t.Fatalf("after the start: %s (%q), stops %+v", l.State.Status, l.State.Reason, l.Stops)
	}
	h.open("work")
	l = h.finished()
	if a, _ := mxAgent(l, "T01-work"); len(a.Launches) != 2 || !a.Launches[1].Resume {
		t.Errorf("the agent: %+v", a.Launches)
	}
	// It does not continue what it should not: a run stopped by the user stays stopped.
	h2 := newMx(t, false)
	mxOneTask(h2)
	h2.startRun(nil)
	h2.atGate("work")
	h2.stopRun()
	h2.restartQuit()
	if !h2.quiet() || h2.view().Status != model.RunStopped || h2.view().Reason != "stopped by the user" {
		t.Errorf("a run the user stopped is %s (%q) after a restart", h2.view().Status, h2.view().Reason)
	}
}

// Three closes of the app in a row, each within a minute of the run being continued: the next
// start leaves the run stopped and says why. A close after more than a minute does not count.
func TestBootLoopGuard(t *testing.T) {
	t.Parallel()
	for _, quick := range []bool{true, false} {
		t.Run(fmt.Sprintf("quick=%v", quick), func(t *testing.T) {
			t.Parallel()
			h := newMx(t, false)
			h.mu.Lock()
			h.still = true
			h.mu.Unlock()
			mxOneTask(h)
			h.startRun(nil)
			for i := 1; i <= 3; i++ {
				h.atGate("work")
				if i == 3 && !quick {
					h.tick(61 * time.Second)
				} else {
					h.tick(20 * time.Second)
				}
				h.regate("work")
				h.restartQuit()
				l := h.L()
				if len(l.Stops) != i || l.Stops[i-1].Reason != model.StopAppQuit {
					t.Fatalf("after close %d: stops %+v", i, l.Stops)
				}
				if i < 3 && (l.State.Status != model.RunRunning || l.Stops[i-1].ResumedAt == 0) {
					t.Fatalf("after close %d the run was not continued: %s (%q)", i, l.State.Status, l.State.Reason)
				}
			}
			l := h.L()
			if !quick {
				if l.State.Status != model.RunRunning || l.Stops[2].ResumedAt == 0 {
					t.Fatalf("a close after more than a minute stopped the run for good: %s (%q)", l.State.Status, l.State.Reason)
				}
			} else {
				if l.State.Status != model.RunStopped || l.State.Reason != engReasonLoop || l.Stops[2].ResumedAt != 0 {
					t.Fatalf("after three quick closes: %s (%q), stops %+v", l.State.Status, l.State.Reason, l.Stops)
				}
				if !h.quiet() {
					t.Fatal("something was launched in the run the guard stopped")
				}
				h.idleEngine()
				// A fourth start leaves it alone too; a person resumes it.
				h.restartQuit()
				if v := h.view(); v.Status != model.RunStopped || v.Reason != engReasonLoop || !h.quiet() {
					t.Fatalf("the next start: %s (%q)", v.Status, v.Reason)
				}
				h.resume()
			}
			h.atGate("work")
			h.open("work")
			h.mu.Lock()
			h.still = false
			h.mu.Unlock()
			h.finished()
		})
	}
}

// A server that died finds its runs at the next start as it left them, halts them with a
// sentence that says what happened, and launches nothing: the dead server's agents may still be
// working in the checkouts. The run waits for a person.
func TestBootAfterCrashWaits(t *testing.T) {
	t.Parallel()
	t.Run("running", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, true)
		h.plan(mxPlan{Turn: mxTwoWriters, Task: func(a *mxTurn, tk Task) {
			a.Cost(0.05, 5, 5)
			if !a.Gate("work") {
				return
			}
			mxLine(a, tk)
		}})
		h.startRun(nil)
		h.atGate("work")
		h.wait("both agents to work", func() bool { return h.turnsOf("T01-work") == 1 && h.turnsOf("T02-work") == 1 })
		h.tick(40 * time.Second)
		last := h.L()
		h.regate("work")
		h.crash()
		l := h.L()
		if l.State.Status != model.RunStopped || l.State.Reason != engReasonCrash || len(l.Stops) != 1 ||
			l.Stops[0].Reason != model.StopAppQuit || l.Stops[0].ResumedAt != 0 {
			t.Fatalf("after the crash: %s (%q), stops %+v", l.State.Status, l.State.Reason, l.Stops)
		}
		// The stop is dated with the last thing the dead server recorded, not with the start.
		if es := h.journalWhole(); l.Stops[0].At != es[last.Version-1].T {
			t.Errorf("the stop is dated %d, the dead server's last entry %d", l.Stops[0].At, es[last.Version-1].T)
		}
		for _, name := range []string{"T01-work", "T02-work"} {
			if a, _ := mxAgent(l, name); a.Status != model.AgentInterrupted || a.Launches[0].EndedAt == 0 {
				t.Errorf("%s is recorded as %s after the crash", name, a.Status)
			}
		}
		if mxState(l, "T01") != model.TaskWork || mxState(l, "T02") != model.TaskWork {
			t.Errorf("the tasks changed: %s, %s", mxState(l, "T01"), mxState(l, "T02"))
		}
		if !h.quiet() {
			t.Fatal("something was launched before a person resumed the run")
		}
		h.idleEngine()
		// A second start changes nothing more.
		h.restartQuit()
		if v := h.view(); v.Status != model.RunStopped || v.Reason != engReasonCrash || !h.quiet() || len(h.L().Stops) != 1 {
			t.Fatalf("the second start: %s (%q)", v.Status, v.Reason)
		}
		h.resume()
		h.atGate("work")
		h.open("work")
		h.finished()
		if got := h.intFile("shared.txt"); got != "line of T01\nline of T02" {
			t.Errorf("shared.txt on the integration branch: %q", got)
		}
	})
	t.Run("stopping", func(t *testing.T) {
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
				if len(a.h.promptsOf(a.Name)) == 1 {
					<-a.Interrupted()
					<-a.h.gate("hold").open
					return
				}
				a.Done("Looked.")
			},
		})
		h.startRun(nil)
		h.wait("the agent to work", func() bool { return h.turnsOf("T01-work") == 1 })
		if _, err := h.s().Stop(h.id); err != nil {
			t.Fatal(err)
		}
		if h.view().Status != model.RunStopping {
			t.Fatalf("the run is %s", h.view().Status)
		}
		// The server dies while the run is stopping: the run ends as the stop intended.
		w, r := h.world(), h.r()
		r.mu.Lock()
		h.crashLocked(w, r)
		r.mu.Unlock()
		h.open("hold")
		h.reboot(false)
		l := h.L()
		if l.State.Status != model.RunStopped || l.State.Reason != "stopped by the user" || len(l.Stops) != 1 || l.Stops[0].Reason != model.StopUser {
			t.Fatalf("after the crash of a stopping run: %s (%q), stops %+v", l.State.Status, l.State.Reason, l.Stops)
		}
		if !h.quiet() {
			t.Fatal("something was launched")
		}
		h.resume()
		h.finished()
	})
}

// A server that died in the middle of writing a journal line leaves half a line. The next start
// cuts it off, and the run goes on from the entry before it.
func TestTornJournalLine(t *testing.T) {
	t.Parallel()
	base := newMx(t, true)
	base.startRun(nil)
	want := base.refEnd()
	points := map[string]func(l *Loaded) bool{
		"a result": func(l *Loaded) bool {
			tk, ok := mxByTitle(l, mxOne)
			return ok && len(tk.Attempts) > 0 && tk.Attempts[0].WorkDone
		},
		"a commit": func(l *Loaded) bool {
			tk, ok := mxByTitle(l, mxTwo)
			return ok && len(tk.Attempts) > 0 && tk.Attempts[0].Head != ""
		},
		"a merge": func(l *Loaded) bool {
			for _, tk := range l.Tasks {
				if len(tk.Attempts) > 0 && tk.Attempts[0].Merged != "" && tk.Attempts[0].MergeRound > 0 {
					return true
				}
			}
			return false
		},
		"a turn's end": func(l *Loaded) bool { return len(l.Turns) >= 2 && l.Turns[1].Status == "done" },
	}
	for name, when := range points {
		if testing.Short() && name != "a merge" {
			continue
		}
		t.Run(strings.ReplaceAll(name, " ", "_"), func(t *testing.T) {
			t.Parallel()
			h := newMx(t, true)
			h.newRun(nil)
			fired := h.crashWhen(when)
			h.begin()
			if !h.awaitFired(fired) {
				t.Fatal("the run ended before the point")
			}
			h.stopWorld(false)
			// The last line is the entry the server was writing: half of it is on disk.
			path := filepath.Join(h.home, "runs", h.id, fileJournal)
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			body := strings.TrimRight(string(data), "\n")
			at := strings.LastIndexByte(body, '\n') + 1
			whole := strings.Count(body, "\n")
			cut := at + (len(body)-at)/2
			if err := os.WriteFile(path, data[:cut], 0o600); err != nil {
				t.Fatal(err)
			}
			h.boot()
			l := h.L()
			// The half line is gone; the entry that halts the run took its place.
			es := h.journalWhole()
			if l.Version != int64(whole)+1 || es[whole].Kind != KRunHalted || l.State.Status != model.RunStopped || l.State.Reason != engReasonCrash {
				t.Fatalf("after the start: v%d (the journal had %d whole entries), %s (%q)", l.Version, whole, l.State.Status, l.State.Reason)
			}
			// An agent whose "done" was in the half line is not done: it answers again.
			h.mu.Lock()
			h.log = slices.DeleteFunc(h.log, func(e mxEvent) bool {
				a, _ := mxAgent(l, e.Name)
				return e.Kind == "done" && a.Status != model.AgentDone
			})
			h.mu.Unlock()
			h.resume()
			h.sameEnd(h.refEnd(), want)
		})
	}
}
