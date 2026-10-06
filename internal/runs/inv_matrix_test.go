package runs

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// The fifteen invariants of the reference script (T01 §15.1), each on the real chat manager and
// the real MCP endpoint.

// Invariant 1: a change is recorded whole or not at all. A journal that cannot be written leaves
// the run in memory and its files of record exactly as they were, and the tool call that wanted
// the change is told so.
func TestInv01CommitAtomic(t *testing.T) {
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
		_, refusal := a.Add("While the journal is broken", false)
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
	journal := filepath.Join(r.dir, fileJournal)
	files := func() string {
		var b strings.Builder
		for _, name := range []string{fileJournal, "state.json", "tasks.json", "turns.json", "agents.json"} {
			data, _ := os.ReadFile(filepath.Join(r.dir, name))
			fmt.Fprintf(&b, "%s %d %x\n", name, len(data), data[max(0, len(data)-40):])
		}
		return b.String()
	}
	was := files()
	if err := os.Chmod(journal, 0o400); err != nil {
		t.Fatal(err)
	}
	h.open("broken")
	h.atGate("mended")
	if err := os.Chmod(journal, 0o600); err != nil {
		t.Fatal(err)
	}
	if text, _ := refused.Load().(string); !strings.Contains(text, "internal error in add_task") {
		t.Errorf("the call that could not be recorded answered %q", text)
	}
	after := h.L()
	if after.Version != before.Version || len(after.Tasks) != 0 || dump(t, after) != dump(t, before) {
		t.Errorf("the failed entry changed the run in memory: v%d → v%d, %d tasks", before.Version, after.Version, len(after.Tasks))
	}
	if now := files(); now != was {
		t.Errorf("the failed entry changed the files of record:\n%s\nwas\n%s", now, was)
	}
	h.open("mended")
	l := h.finished()
	if len(l.Tasks) != 1 || l.Tasks[0].ID != "T01" || l.Tasks[0].Title != "When it works again" {
		t.Errorf("tasks after the journal worked again: %+v", l.Tasks)
	}
}

// Invariant 2: every step of an attempt is recorded when it is done, so a restart neither
// repeats a finished step nor skips an unfinished one. The setup command runs once, the work
// agent's answer is taken once, the work is committed once.
func TestInv02StepFlags(t *testing.T) {
	t.Parallel()
	points := []struct {
		name string
		when func(a Attempt) bool
		// what must not happen again after the restart
		setups, turns int
	}{
		{"setup done", func(a Attempt) bool { return a.SetupDone }, 1, 1},
		{"work done", func(a Attempt) bool { return a.WorkDone }, 1, 1},
		{"committed", func(a Attempt) bool { return a.Head != "" }, 1, 1},
		{"merged", func(a Attempt) bool { return a.Merged != "" }, 1, 1},
	}
	for _, p := range points {
		t.Run(strings.ReplaceAll(p.name, " ", "_"), func(t *testing.T) {
			t.Parallel()
			h := newMx(t, true)
			ran := filepath.Join(h.root, "setup-ran.txt")
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
				Task: mxWriter,
			})
			h.newRun(func(m *model.RunMeta) { m.Settings.Setup = "echo ran >> " + ran })
			fired := h.crashWhen(func(l *Loaded) bool {
				t, ok := mxTask(l, "T01")
				return ok && len(t.Attempts) > 0 && p.when(t.Attempts[0])
			})
			h.begin()
			if !h.awaitFired(fired) {
				t.Fatal("the run ended before the step")
			}
			h.reboot(false)
			h.resume()
			l := h.finished()
			if b, _ := os.ReadFile(ran); strings.Count(string(b), "ran") != p.setups {
				t.Errorf("the setup command ran %q", b)
			}
			// The turn that had begun when the server died is not counted: only whole answers are.
			if a, _ := mxAgent(l, "T01-work"); a.Status != model.AgentDone {
				t.Errorf("the work agent: %+v", a)
			}
			// The task's branch went when the result was applied; its head is on the record.
			_, at := h.task("T01")
			if got := h.repo.Git("log", "--format=%s", "--first-parent", at.Head, "--not", l.State.Git.BaseRef); got != "T01: Write a file" {
				t.Errorf("the task's branch has the commits %q", got)
			}
			if got := strings.Count(h.repo.Git("log", "--format=%s", h.resultRef()), "Merge T01"); got != 1 {
				t.Errorf("the integration branch has %d merges of T01", got)
			}
			if h.intFile("t01.txt") == "" {
				t.Error("the task's file is not on the integration branch")
			}
		})
	}
}

// Invariant 3: an agent is known by its name, and an agent that is done never runs again. The
// agent's "done" and its result are one journal entry, so no restart can find one without the
// other; and a second conflict round gets a new agent.
func TestInv03DoneAgentNeverRunsAgain(t *testing.T) {
	t.Parallel()
	t.Run("done and result are one entry", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, true)
		h.startRun(nil)
		h.refEnd()
		// Replay the journal: whenever an agent becomes done, the same entry holds what its
		// caller made of the answer.
		l := &Loaded{}
		was := map[string]model.RunAgentStatus{}
		checked := 0
		for _, e := range h.journalWhole() {
			l.Apply(e.V, e.Patch)
			for _, a := range e.Patch.Agents {
				if a.Status != model.AgentDone || was[a.ID] == model.AgentDone {
					was[a.ID] = a.Status
					continue
				}
				was[a.ID] = a.Status
				checked++
				ok := false
				switch a.Role {
				case model.RoleOrchestrator:
					for _, tn := range e.Patch.Turns {
						ok = ok || (tn.N == a.Turn && tn.Status == "done")
					}
				case model.RoleTask:
					for _, tk := range e.Patch.Tasks {
						if tk.ID == a.Task {
							at := tk.Attempts[a.Attempt-1]
							ok = at.WorkDone && at.Result != nil
						}
					}
				case model.RoleMerge:
					for _, tk := range e.Patch.Tasks {
						if tk.ID == a.Task {
							at := tk.Attempts[a.Attempt-1]
							ok = at.MergeAgentDone == at.MergeRound && at.MergeRound > 0
						}
					}
				}
				if !ok {
					t.Errorf("entry %d (%s) records agent %s as done without its caller's result", e.V, e.Kind, a.Name)
				}
			}
		}
		if checked < 8 {
			t.Errorf("only %d agents became done in the reference run", checked)
		}
	})

	// The server dies in the entry that records an agent's result, and in the one before it:
	// after the resume no agent that was done gets a process or a message.
	for _, role := range []model.AgentRole{model.RoleOrchestrator, model.RoleTask, model.RoleMerge} {
		for _, back := range []int64{0, 1} {
			if testing.Short() && (role != model.RoleTask || back != 0) {
				continue // two whole runs each
			}
			t.Run(fmt.Sprintf("crash at the %s's result, %d before", role, back), func(t *testing.T) {
				t.Parallel()
				h := newMx(t, true)
				h.newRun(nil)
				var at atomic.Int64
				h.mu.Lock()
				h.onEntry = func(l *Loaded) {
					if at.Load() != 0 {
						return
					}
					for _, a := range l.Agents {
						if a.Role == role && a.Status == model.AgentDone {
							at.Store(l.Version)
						}
					}
				}
				h.mu.Unlock()
				// A first run finds the entry's number; the crash is armed for it in a second run.
				h.begin()
				h.refEnd()
				k := at.Load() - back
				if k < 2 {
					t.Fatalf("no %s became done", role)
				}

				h2 := newMx(t, true)
				h2.newRun(nil)
				fired := h2.crashAtEntry(k)
				h2.begin()
				if !h2.awaitFired(fired) {
					t.Skip("this run was shorter")
				}
				h2.reboot(false)
				done := map[string]int{}
				for _, a := range h2.L().Agents {
					if a.Status == model.AgentDone {
						done[a.Name] = h2.spawnsOf(a.Name)
					}
				}
				h2.resume()
				h2.refEnd()
				for name, n := range done {
					if got := h2.spawnsOf(name); got != n {
						t.Errorf("agent %s was done at the crash with %d processes and has had %d since", name, n, got)
					}
				}
			})
		}
	}

	// The integration branch moves under a resolution and conflicts again: the second round has
	// an agent of its own, and the first round's agent, which is done, gets nothing more.
	t.Run("a second merge round has a new agent", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, true)
		line := func(a *mxTurn, t Task) {
			if t.ID != "T01" && !a.Until(func(l *Loaded) bool { return mxState(l, "T01") == model.TaskDone }) {
				return
			}
			old := a.Read("shared.txt")
			if old == "base\n" {
				a.Write("shared.txt", "line of "+t.ID+"\n")
			} else {
				a.Write("shared.txt", old+"line of "+t.ID+"\n")
			}
			a.Done("Put the line of " + t.ID + " into shared.txt.")
		}
		var held atomic.Value // the task whose first merge agent waits
		h.plan(mxPlan{
			Turn: func(a *mxTurn, n int) {
				if n == 1 {
					a.Notes()
					for _, title := range []string{"One", "Two", "Three"} {
						a.Add(title, true)
					}
					a.Say("Three writers of one line.")
					return
				}
				mxFinishWhenDone(a)
			},
			Task: line,
			Merge: func(a *mxTurn, t Task) {
				if !strings.Contains(a.Name, "-r") && held.CompareAndSwap(nil, t.ID) {
					// Wait until the other conflicting task is merged: the integration branch
					// then has a line this resolution has not seen.
					other := "T03"
					if t.ID == "T03" {
						other = "T02"
					}
					if !a.Until(func(l *Loaded) bool { return mxState(l, other) == model.TaskDone }) {
						return
					}
				}
				mxRefMerge(a)
			},
		})
		h.startRun(nil)
		l := h.finished()
		tid, _ := held.Load().(string)
		first, ok1 := mxAgent(l, tid+"-merge")
		second, ok2 := mxAgent(l, tid+"-merge-r2")
		if !ok1 || !ok2 || first.Status != model.AgentDone || second.Status != model.AgentDone || first.ID == second.ID {
			t.Fatalf("the merge agents of %s: %+v / %+v\n%s", tid, first, second, h.dump())
		}
		if n := h.turnsOf(tid + "-merge"); n != 1 {
			t.Errorf("the first round's agent got %d messages", n)
		}
		if n := h.spawnsOf(tid + "-merge"); n != 1 {
			t.Errorf("the first round's agent had %d processes", n)
		}
		_, at := h.task(tid)
		if at.MergeRound != 2 || at.MergeAgentDone != 2 || at.Agents.Merge != second.ID {
			t.Errorf("the attempt: round %d, done %d, merge agent %s", at.MergeRound, at.MergeAgentDone, at.Agents.Merge)
		}
		shared := h.intFile("shared.txt")
		for _, id := range []string{"T01", "T02", "T03"} {
			if !strings.Contains(shared, "line of "+id) {
				t.Errorf("shared.txt lacks the line of %s:\n%s", id, shared)
			}
		}
		if strings.Contains(shared, "<<<<") || strings.Contains(shared, ">>>>") {
			t.Errorf("shared.txt has a marker:\n%s", shared)
		}
	})
}

// Invariant 4: a task touched in a turn is held until that turn ends, also when the turn fails.
func TestInv04HeldUntilTurnEnds(t *testing.T) {
	t.Parallel()
	t.Run("the turn ends", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
			if n > 1 {
				mxFinishWhenDone(a)
				return
			}
			a.Add("Look", false)
			if !a.Gate("turn") {
				return
			}
			a.Say("One task.")
		}})
		h.startRun(nil)
		h.atGate("turn")
		for i := 0; i < 20; i++ {
			h.tick(time.Second)
		}
		tk, _ := h.task("T01")
		if tk.State() != model.TaskHeld || len(tk.HeldBy) != 1 || tk.HeldBy[0].Turn != 1 || h.turnsOf("T01-work") != 0 {
			t.Fatalf("while its turn runs the task is %s, held by %+v", tk.State(), tk.HeldBy)
		}
		h.open("turn")
		h.finished()
		// The entry that ends the turn releases the task.
		for _, e := range h.journalWhole() {
			if e.Kind == KTurnEnded && e.Turn == 1 {
				if len(e.Patch.Tasks) != 1 || e.Patch.Tasks[0].State() != model.TaskSlot || len(e.Patch.Tasks[0].HeldBy) != 0 {
					t.Errorf("turn 1's end left the task %+v", e.Patch.Tasks)
				}
			}
		}
	})
	t.Run("the turn fails", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
			switch {
			case n == 1 && len(a.State().Tasks) == 0:
				a.Add("Look", false)
				a.Fail("the model fell over")
			default:
				mxFinishWhenDone(a)
			}
		}})
		h.startRun(func(m *model.RunMeta) { m.Settings.AgentRetries = 0 })
		l := h.waitStatus(model.RunError)
		tk, _ := mxTask(l, "T01")
		if tk.State() != model.TaskSlot || len(tk.HeldBy) != 0 || l.Turns[0].Status != "failed" {
			t.Fatalf("after the failed turn the task is %s, held by %+v; turn %+v", tk.State(), tk.HeldBy, l.Turns[0])
		}
		if h.turnsOf("T01-work") != 0 {
			t.Error("the task started in a run that is in error")
		}
		h.idleEngine()
		h.resume()
		h.finished()
	})
}

// mxSetupMark is a sleep no other process on the machine has: the tests find their setup command
// by it.
var mxMarkSeq atomic.Int32

func mxSetupMark(n int) string { return fmt.Sprintf("%d.%d", n, os.Getpid()) }

func mxSleeping(mark string) bool { return engSleeping(mark) }

// Invariant 5: a stop and a cancel reach a worker in every step of an attempt. Afterwards the run
// has no process and no worker, and a stopped run resumes to its end.
func TestInv05StopReachesEveryWorker(t *testing.T) {
	t.Parallel()
	type env struct {
		h    *mx
		task string // the task that is in the step
		mark string
		lock *sync.Mutex
		mu   sync.Mutex // release is called from the test, its helper goroutine and its cleanup
	}
	turn := func(tasks int, writes bool) func(a *mxTurn, n int) {
		return func(a *mxTurn, n int) {
			if n == 1 {
				a.Notes()
				for i := 0; i < tasks; i++ {
					a.Add(fmt.Sprintf("Task %d", i+1), writes)
				}
				a.Say("Planned.")
				return
			}
			l := a.State()
			for _, t := range l.Tasks {
				if !t.State().Final() {
					a.Say("Nothing to change yet.")
					return
				}
			}
			a.Finish()
			a.Say("Finished.")
		}
	}
	steps := []struct {
		name string
		// arrange brings the run into the step and returns when it is there.
		arrange func(t *testing.T, e *env)
		// release lets the step go on once the stop or the cancel is in.
		release func(e *env)
		// cancelled: a cancel in this step ends the task cancelled; else it is refused, because
		// the task's result is in and is being merged.
		cancelled bool
		// state is the task's state while it is in the step.
		state model.TaskState
	}{
		{name: "slot wait", cancelled: true, state: model.TaskSlot,
			arrange: func(t *testing.T, e *env) {
				e.h.plan(mxPlan{Turn: turn(2, false), Task: func(a *mxTurn, tk Task) {
					if tk.ID == "T01" && !a.Gate("work") {
						return
					}
					a.Done("Did it.")
				}})
				e.h.startRun(func(m *model.RunMeta) { m.Settings.MaxParallel = 1 })
				e.h.atGate("work")
				e.h.waitTask("T02", model.TaskSlot)
				e.task = "T02"
			},
			release: func(e *env) { e.h.open("work") }},
		{name: "setup command", cancelled: true, state: model.TaskSetup,
			arrange: func(t *testing.T, e *env) {
				// A counter, not the clock: the stop and the cancel subtests run at the same time
				// and must not find each other's sleep.
				e.mark = mxSetupMark(4300 + int(mxMarkSeq.Add(1)))
				gofile := filepath.Join(e.h.root, "go")
				e.h.plan(mxPlan{Turn: turn(1, true), Task: mxWriter})
				e.h.startRun(func(m *model.RunMeta) {
					m.Settings.Setup = fmt.Sprintf("test -f %s || sleep %s", gofile, e.mark)
				})
				e.h.wait("the setup command", func() bool { return mxSleeping(e.mark) })
				e.task = "T01"
			},
			release: func(e *env) { os.WriteFile(filepath.Join(e.h.root, "go"), nil, 0o644) }},
		{name: "SendOwned blocked", cancelled: true, state: model.TaskWork,
			arrange: func(t *testing.T, e *env) {
				in := make(chan struct{})
				var used atomic.Bool
				e.h.mu.Lock()
				e.h.sendHook = func(name string, ag agent.Agent) agent.Agent {
					if name != "T01-work" || !used.CompareAndSwap(false, true) {
						return ag
					}
					s := mxNewStuck(ag)
					go func() { <-s.in; close(in) }()
					return s
				}
				e.h.mu.Unlock()
				e.h.plan(mxPlan{Turn: turn(1, true), Task: mxWriter})
				e.h.startRun(nil)
				e.h.wait("the message to be in flight", func() bool {
					select {
					case <-in:
						return true
					default:
						return false
					}
				})
				e.task = "T01"
			}},
		{name: "work", cancelled: true, state: model.TaskWork,
			arrange: func(t *testing.T, e *env) {
				e.h.plan(mxPlan{Turn: turn(1, true), Task: func(a *mxTurn, tk Task) {
					a.Write("half.txt", "half\n")
					if !a.Gate("work") {
						return
					}
					mxWriter(a, tk)
				}})
				e.h.startRun(nil)
				e.h.atGate("work")
				e.task = "T01"
			},
			release: func(e *env) { e.h.open("work") }},
		{name: "back-off sleep", cancelled: true, state: model.TaskWork,
			arrange: func(t *testing.T, e *env) {
				var failed atomic.Bool
				e.h.plan(mxPlan{Turn: turn(1, true), Task: func(a *mxTurn, tk Task) {
					if failed.CompareAndSwap(false, true) {
						a.Fail("overloaded")
						return
					}
					mxWriter(a, tk)
				}})
				e.h.mu.Lock()
				e.h.still = true
				e.h.mu.Unlock()
				e.h.startRun(nil)
				e.h.waitL("the back-off", func(l *Loaded) bool {
					a, ok := mxAgent(l, "T01-work")
					return ok && a.Failures == 1 && a.RetryAt > 0
				})
				e.task = "T01"
			},
			release: func(e *env) {
				e.h.mu.Lock()
				e.h.still = false
				e.h.mu.Unlock()
			}},
		{name: "commit", cancelled: false, state: model.TaskMerge,
			arrange: func(t *testing.T, e *env) {
				// A pre-commit hook that waits for a file: the commit of the task's work hangs in it.
				gofile := filepath.Join(e.h.root, "go")
				hook := filepath.Join(e.h.repo.Dir(), ".git", "hooks", "pre-commit")
				os.MkdirAll(filepath.Dir(hook), 0o755)
				os.WriteFile(hook, []byte("#!/bin/sh\nwhile [ ! -f "+gofile+" ]; do sleep 0.05; done\n"), 0o755)
				e.h.plan(mxPlan{Turn: turn(1, true), Task: mxWriter})
				e.h.startRun(nil)
				e.h.waitL("the commit to be under way", func(l *Loaded) bool {
					tk, ok := mxTask(l, "T01")
					return ok && tk.State() == model.TaskMerge
				})
				e.task = "T01"
			},
			release: func(e *env) { os.WriteFile(filepath.Join(e.h.root, "go"), nil, 0o644) }},
		{name: "merge", cancelled: false, state: model.TaskMerge,
			arrange: func(t *testing.T, e *env) {
				// The test holds the merge lock: the task's merge waits for it.
				e.h.plan(mxPlan{Turn: turn(1, true), Task: func(a *mxTurn, tk Task) {
					if !a.Gate("work") {
						return
					}
					mxWriter(a, tk)
				}})
				e.h.startRun(nil)
				e.h.atGate("work")
				e.lock = &e.h.r().mergeMu
				e.lock.Lock()
				e.h.open("work")
				e.h.waitL("the task to wait for its merge", func(l *Loaded) bool {
					tk, ok := mxTask(l, "T01")
					return ok && len(tk.Attempts) > 0 && tk.Attempts[0].Head != ""
				})
				e.task = "T01"
			},
			release: func(e *env) {
				e.mu.Lock()
				defer e.mu.Unlock()
				if e.lock != nil {
					e.lock.Unlock()
					e.lock = nil
				}
			}},
		{name: "merge agent", cancelled: false, state: model.TaskMerge,
			arrange: func(t *testing.T, e *env) {
				e.h.plan(mxPlan{
					Turn: turn(2, true),
					Task: func(a *mxTurn, tk Task) {
						a.Write("shared.txt", "line of "+tk.ID+"\n")
						a.Done("Put my line in.")
					},
					Merge: func(a *mxTurn, tk Task) {
						if !a.Gate("merge") {
							return
						}
						mxRefMerge(a)
					},
				})
				e.h.startRun(nil)
				e.h.atGate("merge")
				for _, tk := range e.h.L().Tasks {
					if tk.State() == model.TaskMerge {
						e.task = tk.ID
					}
				}
			},
			release: func(e *env) { e.h.open("merge") }},
	}
	for si, st := range steps {
		for i, how := range []string{"stop", "cancel"} {
			if testing.Short() && i != si%2 {
				continue // every step once, by a stop or by a cancel in turn
			}
			t.Run(strings.ReplaceAll(st.name, " ", "_")+"/"+how, func(t *testing.T) {
				t.Parallel()
				e := &env{h: newMx(t, true)}
				h := e.h
				st.arrange(t, e)
				if got, _ := h.task(e.task); got.State() != st.state {
					t.Fatalf("in the step the task is %s, want %s\n%s", got.State(), st.state, h.dump())
				}
				t.Cleanup(func() {
					if st.release != nil {
						st.release(e)
					}
					if e.mark != "" {
						exec.Command("pkill", "-f", "sleep "+e.mark).Run()
					}
				})
				if how == "stop" {
					began := time.Now()
					if _, err := h.s().Stop(h.id); err != nil {
						t.Fatal(err)
					}
					if st.name == "merge" || st.name == "commit" {
						// The worker is inside a git step: it sees the stop when the step lets go.
						if st.name == "merge" {
							st.release(e)
						}
					}
					l := h.waitStatus(model.RunStopped)
					if took := time.Since(began); took > 15*time.Second {
						t.Errorf("the stop took %s", took)
					}
					if e.mark != "" && mxSleeping(e.mark) {
						t.Error("the setup command outlived the stop")
					}
					h.idleEngine()
					if got := mxState(l, e.task); got != st.state {
						t.Errorf("the stop changed the task from %s to %s", st.state, got)
					}
					if tk, _ := mxTask(l, e.task); st.name == "commit" && tk.Attempts[0].Head != "" {
						t.Errorf("the commit that hung in its hook was recorded: %s", tk.Attempts[0].Head)
					} else if st.name == "merge" && tk.Attempts[0].Merged != "" {
						t.Errorf("the merge that waited for the lock was recorded: %s", tk.Attempts[0].Merged)
					}
					if len(l.Stops) != 1 || l.Stops[0].Reason != model.StopUser {
						t.Errorf("stops: %+v", l.Stops)
					}
					h.mu.Lock()
					h.sendHook = nil
					h.mu.Unlock()
					if st.release != nil {
						st.release(e)
					}
					h.resume()
					h.finished()
					if got := mxState(h.L(), e.task); got != model.TaskDone {
						t.Errorf("after the resume the task ended %s", got)
					}
					return
				}

				// cancel_task, as a person's chat on the run calls it.
				_, token := h.newChat()
				if st.name == "merge" || st.name == "commit" {
					go func() { time.Sleep(50 * time.Millisecond); st.release(e) }()
				}
				text, isErr := h.call(token, "cancel_task", map[string]any{"id": e.task, "reason": "not needed any more"})
				if e.mark != "" && mxSleeping(e.mark) {
					t.Error("the setup command outlived the cancel")
				}
				if st.cancelled {
					if isErr {
						t.Fatalf("cancel_task was refused: %s", text)
					}
					tk, at := h.task(e.task)
					if tk.State() != model.TaskCancelled || at.Cancel == nil || at.Cancel.Reason != "not needed any more" || at.Merged != "" {
						t.Fatalf("after the cancel: %s %+v", tk.State(), at)
					}
					for _, a := range h.L().Agents {
						if a.Task == e.task && a.Status != model.AgentCancelled {
							t.Errorf("agent %s of the cancelled task is %s", a.Name, a.Status)
						}
					}
				} else {
					if !isErr || !strings.Contains(text, "being merged") {
						t.Fatalf("cancel_task of a task that is being merged answered %q (error %v)", text, isErr)
					}
				}
				if st.release != nil {
					st.release(e)
				}
				h.mu.Lock()
				h.sendHook = nil
				h.mu.Unlock()
				l := h.finished()
				want := model.TaskDone
				if st.cancelled {
					want = model.TaskCancelled
				}
				if got := mxState(l, e.task); got != want {
					t.Errorf("the task ended %s, want %s", got, want)
				}
				if st.cancelled && h.intFile(strings.ToLower(e.task)+".txt") != "" {
					t.Error("the cancelled task's file is on the integration branch")
				}
			})
		}
	}
}

// Invariant 6: a task can be cancelled until its result is in and it begins to merge; from then
// on cancel_task is refused. A cancel that races the result ends in exactly one of two ways:
// cancelled and nothing merged, or refused and merged.
func TestInv06CancelBoundary(t *testing.T) {
	t.Parallel()
	rounds := 16
	if testing.Short() {
		rounds = 4
	}
	var cancelled, merged atomic.Int32
	t.Run("race", func(t *testing.T) {
		for i := 0; i < rounds; i++ {
			t.Run(fmt.Sprint(i), func(t *testing.T) {
				t.Parallel()
				h := newMx(t, true)
				ready := make(chan struct{})
				var once sync.Once
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
						a.Write("t01.txt", "the file of T01\n")
						once.Do(func() { close(ready) })
						// The answer and the cancel are on their way at the same time.
						time.Sleep(time.Duration(i%4) * 300 * time.Microsecond)
						a.Done("Wrote the file.")
					},
				})
				h.startRun(nil)
				_, token := h.newChat()
				<-ready
				time.Sleep(time.Duration(i) * 600 * time.Microsecond)
				text, isErr := h.call(token, "cancel_task", map[string]any{"id": "T01", "reason": "raced"})
				l := h.finished()
				tk, _ := mxTask(l, "T01")
				at := tk.Attempts[0]
				onInt := h.intFile("t01.txt") != ""
				switch {
				case !isErr && tk.State() == model.TaskCancelled && at.Merged == "" && !onInt:
					cancelled.Add(1)
					if at.Cancel == nil || at.Cancel.Reason != "raced" {
						t.Errorf("the cancelled attempt: %+v", at)
					}
					if got := h.repo.Git("rev-parse", h.resultRef()); got != l.State.Git.BaseRef {
						t.Errorf("the integration branch moved to %s although the task was cancelled", got)
					}
				case isErr && tk.State() == model.TaskDone && at.Merged != "" && onInt:
					merged.Add(1)
					if !strings.Contains(text, "can no longer be cancelled") && !strings.Contains(text, "look again with get_run") {
						t.Errorf("the refusal: %q", text)
					}
				default:
					t.Errorf("neither of the two outcomes: cancel_task answered %q (error %v), the task is %s, merged %q, its file on the integration branch %v\n%s",
						text, isErr, tk.State(), at.Merged, onInt, h.dump())
				}
			})
		}
	})
	t.Logf("of %d races: %d cancelled, %d merged", rounds, cancelled.Load(), merged.Load())
}

// Invariant 7: finish_run needs every task ended; after it the task set cannot change; the run
// ends only when that turn's agent has ended.
func TestInv07FinishRun(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	var early, late, read atomic.Value
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) {
		if n == 1 {
			a.Add("Look", false)
			early.Store(a.Finish())
			a.Say("One task.")
			return
		}
		if !mxAllDone(a.State()) {
			a.Say("Not yet.")
			return
		}
		if refusal := a.Finish(); refusal != "" {
			a.Say("refused: " + refusal)
			return
		}
		_, refusal := a.Add("One more", false)
		late.Store(refusal)
		text, isErr := a.Call("get_run", map[string]any{})
		read.Store(fmt.Sprintf("%v %v", isErr, strings.Contains(text, "T01")))
		if !a.Gate("last") {
			return
		}
		a.Say("Finished.")
	}})
	h.startRun(nil)
	h.atGate("last")
	if text, _ := early.Load().(string); !strings.Contains(text, "T01") {
		t.Errorf("finish_run with a task that has not ended answered %q", text)
	}
	if text, _ := late.Load().(string); text == "" {
		t.Error("add_task after finish_run was not refused")
	}
	if got, _ := read.Load().(string); got != "false true" {
		t.Errorf("get_run after finish_run: %s", got)
	}
	for i := 0; i < 10; i++ {
		h.tick(2 * time.Second)
	}
	l := h.L()
	if l.State.Status != model.RunRunning || l.State.Result == nil || len(l.Tasks) != 1 {
		t.Fatalf("while the last turn runs: %s, result %v, %d tasks", l.State.Status, l.State.Result, len(l.Tasks))
	}
	h.open("last")
	l = h.finished()
	last := l.Turns[len(l.Turns)-1]
	if last.Status != "done" || last.Summary != "Finished." || l.State.EndedAt < last.EndedAt {
		t.Errorf("the last turn: %+v; the run ended at %d", last, l.State.EndedAt)
	}
}

// Invariant 8: merges into the integration branch happen one at a time.
func TestInv08MergesSerialised(t *testing.T) {
	t.Parallel()
	h := newMx(t, true)
	h.plan(mxPlan{
		Turn: func(a *mxTurn, n int) {
			if n == 1 {
				a.Notes()
				for i := 1; i <= 4; i++ {
					a.Add(fmt.Sprintf("File %d", i), true)
				}
				a.Say("Four writers.")
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
	h.waitL("all four to work", func(l *Loaded) bool {
		n := 0
		for _, tk := range l.Tasks {
			if tk.State() == model.TaskWork {
				n++
			}
		}
		return n == 4
	})
	// With the merge lock held nothing is merged, however many tasks are ready to.
	r := h.r()
	r.mergeMu.Lock()
	h.open("work")
	h.waitL("all four committed", func(l *Loaded) bool {
		n := 0
		for _, tk := range l.Tasks {
			if len(tk.Attempts) > 0 && tk.Attempts[0].Head != "" {
				n++
			}
		}
		return n == 4
	})
	for i := 0; i < 5; i++ {
		h.tick(time.Second)
	}
	base := h.L().State.Git.BaseRef
	if got := h.repo.Git("rev-parse", svcIntegrationBranch(h.id)); got != base {
		r.mergeMu.Unlock()
		t.Fatalf("the integration branch moved while the merge lock was held")
	}
	r.mergeMu.Unlock()
	l := h.finished()
	// One line of merges: each has the integration branch as it was before as its first parent.
	ib := h.resultRef()
	chain := strings.Split(h.repo.Git("log", "--first-parent", "--format=%H %s", ib), "\n")
	if len(chain) != 5 {
		t.Fatalf("the integration branch's own line:\n%s", strings.Join(chain, "\n"))
	}
	var heads []string
	for _, line := range chain[:4] {
		sha, subject, _ := strings.Cut(line, " ")
		if !strings.HasPrefix(subject, "Merge T0") {
			t.Errorf("on the integration branch's line: %s", line)
		}
		heads = append(heads, sha)
	}
	for _, tk := range l.Tasks {
		at := tk.Attempts[0]
		if !slices.Contains(heads, at.Merged) {
			t.Errorf("%s was recorded as merged at %s, which is not on the integration branch's line", tk.ID, at.Merged)
		}
		if h.intFile(strings.ToLower(tk.ID)+".txt") == "" {
			t.Errorf("the file of %s is not on the integration branch", tk.ID)
		}
	}
}

// Invariant 9: the orchestrator never works in the integration checkout; its own checkout is
// reset to the integration branch and cleaned before every turn, and its process cannot write.
func TestInv09OrchestratorCheckout(t *testing.T) {
	t.Parallel()
	h := newMx(t, true)
	type seen struct {
		cwd, shared, junk, t01 string
	}
	var mu sync.Mutex
	turns := map[int]seen{}
	h.plan(mxPlan{
		Turn: func(a *mxTurn, n int) {
			junk, _ := os.ReadFile(filepath.Join(a.Cwd, "junk.txt"))
			mu.Lock()
			turns[n] = seen{a.Cwd, a.Read("shared.txt"), string(junk), a.Read("t01.txt")}
			mu.Unlock()
			// What a careless orchestrator leaves behind (its process is read-only; a file gets
			// there all the same when a tool misbehaves).
			os.WriteFile(filepath.Join(a.Cwd, "junk.txt"), []byte("left by turn\n"), 0o644)
			os.WriteFile(filepath.Join(a.Cwd, "shared.txt"), []byte("scribbled\n"), 0o644)
			if n == 1 {
				a.Notes()
				a.Add("Write a file", true)
				a.Say("One task.")
				return
			}
			mxFinishWhenDone(a)
		},
		Task: mxWriter,
	})
	h.startRun(nil)
	l := h.finished()
	work := h.world().st.P.RunWorkDir(h.id)
	mu.Lock()
	defer mu.Unlock()
	if len(turns) < 2 {
		t.Fatalf("%d turns", len(turns))
	}
	for n, s := range turns {
		if s.cwd != filepath.Join(work, "orch") || s.cwd == l.State.Git.Integration {
			t.Errorf("turn %d worked in %s", n, s.cwd)
		}
		if s.junk != "" || s.shared != "base\n" {
			t.Errorf("turn %d found junk %q and shared.txt %q in its checkout", n, s.junk, s.shared)
		}
	}
	if turns[1].t01 != "" || turns[2].t01 != "the file of T01\n" {
		t.Errorf("the task's file as the turns saw it: %q, then %q", turns[1].t01, turns[2].t01)
	}
	for _, o := range h.spawnsWith("turn-001") {
		if !o.ReadOnly || !o.Unattended || o.Cwd != filepath.Join(work, "orch") {
			t.Errorf("the orchestrator's process: %+v", o)
		}
	}
	if h.intFile("junk.txt") != "" || h.intFile("shared.txt") != "base" {
		t.Errorf("what the orchestrator scribbled reached the integration branch")
	}
}

var mxOrchTools = "get_run get_task get_agent get_notes set_notes edit_notes add_task update_task cancel_task retry_task wait_for finish_run"
var mxChatTools = "get_run get_task get_agent get_notes add_task update_task cancel_task retry_task tell_orchestrator spawn_subagent stop_subagent list_subagent_models"
var mxSpawnTools = "spawn_subagent stop_subagent list_subagent_models"

// Invariant 10: the orchestrator's tools work only while its own turn runs and the run is
// running. The same token changes nothing before, after, in another turn or in a stopped run.
func TestInv10OrchestratorToolsOnlyInItsTurn(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	var listed atomic.Value
	h.plan(mxPlan{
		Turn: func(a *mxTurn, n int) {
			switch n {
			case 1:
				listed.Store(strings.Join(a.Tools(), " "))
				a.Add("Look", false)
				a.Say("One task.")
			case 2:
				if !a.Gate("turn2") {
					return
				}
				a.Say("Waiting.")
			default:
				mxFinishWhenDone(a)
			}
		},
		Task: func(a *mxTurn, tk Task) {
			if tk.ID == "T02" && !a.Gate("work") {
				return
			}
			a.Done("Looked.")
		},
	})
	h.startRun(nil)
	h.atGate("turn2")
	if got, _ := listed.Load().(string); got != mxOrchTools {
		t.Errorf("in its turn the orchestrator is listed: %s", got)
	}
	tok1, tok2 := h.token("turn-001"), h.token("turn-002")
	add := map[string]any{"title": "Too late", "kind": "research", "writes": false, "tier": "standard", "tier_reason": "A test task.", "brief": mxBrief("Look at it.")}
	over := "the orchestrator's turn is over; add_task was not run"

	// Turn 1 is over; turn 2 runs. The first turn's token is not the second's.
	if text, isErr := h.call(tok1, "add_task", add); !isErr || text != over {
		t.Errorf("turn 1's token after its turn: %q (error %v)", text, isErr)
	}
	if text, isErr := h.call(tok1, "get_run", map[string]any{}); !isErr || !strings.Contains(text, "turn is over") {
		t.Errorf("turn 1's get_run after its turn: %q (error %v)", text, isErr)
	}
	// The running turn's token works, from wherever it is used.
	if text, isErr := h.call(tok2, "add_task", add); isErr {
		t.Errorf("the running turn's add_task: %q", text)
	}
	// A stopped run: the turn stays "running" in the record, its process is gone.
	h.stopRun()
	if text, isErr := h.call(tok2, "add_task", add); !isErr || text != over {
		t.Errorf("turn 2's token in a stopped run: %q (error %v)", text, isErr)
	}
	if n := len(h.L().Tasks); n != 2 {
		t.Fatalf("%d tasks: a refused call added one", n)
	}
	h.open("turn2", "work")
	h.resume()
	l := h.finished()
	for _, tok := range []string{tok1, tok2, h.token(fmt.Sprintf("turn-%03d", len(l.Turns)))} {
		if text, isErr := h.call(tok, "add_task", add); !isErr || text != over {
			t.Errorf("a token of a finished run: %q (error %v)", text, isErr)
		}
	}
	if n := len(h.L().Tasks); n != 2 {
		t.Errorf("%d tasks at the end", n)
	}
}

// Invariant 11: no event is lost and none is told twice by mistake. After every entry, every
// event made so far is in exactly one place: the inbox, or the WokenBy or Learned list of a turn
// that did not fail. A failed turn keeps its lists, and its events are told again to the next.
func TestInv11EventsNeverLost(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	var bad []string
	var mu sync.Mutex
	check := func(l *Loaded) {
		where := map[int][]string{}
		for _, ev := range l.State.Inbox {
			where[ev.Seq] = append(where[ev.Seq], "inbox")
		}
		for _, tn := range l.Turns {
			if tn.Status == "failed" {
				continue
			}
			for _, ev := range tn.WokenBy {
				where[ev.Seq] = append(where[ev.Seq], fmt.Sprintf("turn %d woken", tn.N))
			}
			for _, ev := range tn.Learned {
				where[ev.Seq] = append(where[ev.Seq], fmt.Sprintf("turn %d learned", tn.N))
			}
		}
		mu.Lock()
		defer mu.Unlock()
		for seq := 1; seq <= l.State.EventSeq; seq++ {
			if len(where[seq]) != 1 {
				bad = append(bad, fmt.Sprintf("v%d: event %d is in %v", l.Version, seq, where[seq]))
			}
		}
		if len(where) != l.State.EventSeq {
			bad = append(bad, fmt.Sprintf("v%d: %d events are placed, %d were made", l.Version, len(where), l.State.EventSeq))
		}
	}
	var failed atomic.Bool
	h.plan(mxPlan{
		Turn: func(a *mxTurn, n int) {
			switch {
			case n == 1:
				for i := 1; i <= 3; i++ {
					a.Add(fmt.Sprintf("Look %d", i), false)
				}
				a.Say("Three tasks.")
			case n == 2:
				// Woken by the first task; it learns of the second through get_run.
				a.h.open("second")
				if !a.Until(func(l *Loaded) bool { return mxState(l, "T02") == model.TaskDone }) {
					return
				}
				a.Call("get_run", map[string]any{})
				a.Say("Two are done.")
			case failed.CompareAndSwap(false, true):
				// Woken by the third task, and it fails.
				a.Fail("the model fell over")
			default:
				mxFinishWhenDone(a)
			}
		},
		Task: func(a *mxTurn, tk Task) {
			switch tk.ID {
			case "T02":
				if !a.Gate("second") {
					return
				}
			case "T03":
				if !a.Until(func(l *Loaded) bool { return len(l.Turns) >= 2 && l.Turns[1].Status == "done" }) {
					return
				}
			}
			a.Done("Looked at " + tk.ID + ".")
		},
	})
	h.newRun(func(m *model.RunMeta) { m.Settings.AgentRetries = 0 })
	h.mu.Lock()
	h.onEntry = check
	h.mu.Unlock()
	h.begin()
	l := h.waitStatus(model.RunError)
	if len(l.Turns) != 3 || l.Turns[2].Status != "failed" || len(l.Turns[2].WokenBy) != 1 || l.Turns[2].WokenBy[0].Task != "T03" {
		t.Fatalf("the failed turn: %+v", l.Turns)
	}
	if len(l.Turns[1].WokenBy) != 1 || l.Turns[1].WokenBy[0].Task != "T01" || len(l.Turns[1].Learned) != 1 || l.Turns[1].Learned[0].Task != "T02" {
		t.Errorf("turn 2: woken by %+v, learned %+v", l.Turns[1].WokenBy, l.Turns[1].Learned)
	}
	if len(l.State.Inbox) != 1 || l.State.Inbox[0].Task != "T03" {
		t.Errorf("the inbox after the failed turn: %+v", l.State.Inbox)
	}
	h.resume()
	l = h.finished()
	if len(l.Turns) != 4 || len(l.Turns[3].WokenBy) != 1 || l.Turns[3].WokenBy[0].Seq != l.Turns[2].WokenBy[0].Seq {
		t.Errorf("the turn after the failed one was woken by %+v", l.Turns[3].WokenBy)
	}
	prompts := h.promptsOf("turn-004")
	if len(prompts) == 0 || !strings.Contains(prompts[0], "T03") {
		t.Errorf("the turn after the failed one was not told of T03 again")
	}
	mu.Lock()
	defer mu.Unlock()
	for _, b := range bad {
		t.Error(b)
	}
}

// Invariant 12: the first halt wins. A second reason to stop changes nothing.
func TestInv12FirstHaltWins(t *testing.T) {
	t.Parallel()
	t.Run("a stop, then a limit", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{
			Turn: func(a *mxTurn, n int) {
				if n == 1 {
					a.Add("Look", false)
				}
				a.Say("Planned.")
			},
			Task: func(a *mxTurn, tk Task) {
				// It lets go only when the test says so: the run stays "stopping" until then.
				<-a.h.gate("hold").open
				a.Done("Looked.")
			},
		})
		h.startRun(nil)
		h.waitTask("T01", model.TaskWork)
		h.wait("the agent to work", func() bool { return h.turnsOf("T01-work") == 1 })
		v, err := h.s().Stop(h.id)
		if err != nil || v.Status != model.RunStopping {
			t.Fatalf("stop: %+v %v", v.Status, err)
		}
		r := h.r()
		limit := Halting{Status: model.RunStalled, StalledBy: model.StalledCost, Stop: model.StopStalled, Reason: "spent too much"}
		if err := r.halt(limit); err != ErrNotRunning {
			t.Errorf("the second halt answered %v", err)
		}
		if v, err := h.s().Stop(h.id); err != nil || v.Status != model.RunStopping {
			t.Errorf("a second stop: %s %v", v.Status, err)
		}
		if _, err := h.s().Resume(h.id, ResumeReq{}); err != ErrStopping {
			t.Errorf("a resume while stopping answered %v", err)
		}
		h.open("hold")
		l := h.waitStatus(model.RunStopped)
		if l.State.Reason != "stopped by the user" || l.State.StalledBy != "" || len(l.Stops) != 1 || l.Stops[0].Reason != model.StopUser {
			t.Errorf("the run stopped as %q/%q, stops %+v", l.State.Reason, l.State.StalledBy, l.Stops)
		}
		n := 0
		for _, e := range h.journalWhole() {
			if e.Kind == KRunStopping || e.Kind == KRunHalted {
				n++
			}
		}
		if n != 2 {
			t.Errorf("%d stopping and halted entries", n)
		}
		h.idleEngine()
	})
	t.Run("a limit, then a stop", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.plan(mxPlan{
			Turn: func(a *mxTurn, n int) {
				a.Cost(0.30, 10, 10)
				if n == 1 {
					a.Add("Look", false)
					a.Add("Look again", false)
				}
				a.Say("Planned.")
			},
			Task: func(a *mxTurn, tk Task) {
				if tk.ID == "T02" {
					<-a.h.gate("hold").open
					a.Done("Looked.")
					return
				}
				if !a.Until(func(l *Loaded) bool { return a.h.turnsOf("T02-work") == 1 }) {
					return
				}
				a.Cost(0.30, 10, 10)
				a.Done("Looked.")
			},
		})
		h.startRun(func(m *model.RunMeta) { m.Settings.MaxCost = 0.50; m.Settings.Wake = "idle" })
		h.waitStatus(model.RunStopping)
		if v, err := h.s().Stop(h.id); err != nil || v.Status != model.RunStopping {
			t.Errorf("a stop of a run that is stalling: %s %v", v.Status, err)
		}
		h.open("hold")
		l := h.waitStatus(model.RunStalled, model.RunStopped)
		if l.State.Status != model.RunStalled || l.State.StalledBy != model.StalledCost || len(l.Stops) != 1 || l.Stops[0].Reason != model.StopStalled {
			t.Errorf("the run halted as %s/%s (%q), stops %+v", l.State.Status, l.State.StalledBy, l.State.Reason, l.Stops)
		}
		h.idleEngine()
	})
}

// Invariant 13: who may call what is decided by the MCP endpoint, per caller. Every kind of
// caller lists its tools and makes a call it has no right to, through the real endpoint with its
// own token: the orchestrator (the first thing its new process does is list), a task agent, a
// merge agent, a subagent of a task agent, a person's chat on the run, and a chat that is on no
// run.
func TestInv13ToolsPerRole(t *testing.T) {
	t.Parallel()
	h := newMx(t, true)
	var mu sync.Mutex
	got := map[string]string{}
	note := func(key, value string) {
		mu.Lock()
		defer mu.Unlock()
		if _, ok := got[key]; !ok {
			got[key] = value
		}
	}
	refusal := func(a *mxTurn, tool string) string {
		text, isErr := a.Call(tool, map[string]any{})
		if !isErr {
			return "NOT REFUSED: " + text
		}
		return text
	}
	var plain atomic.Value // the id of the chat that is on no run
	h.plan(mxPlan{
		Turn: func(a *mxTurn, n int) {
			if n == 1 {
				note("orchestrator list", strings.Join(a.Tools(), " "))
				note("orchestrator tell_orchestrator", refusal(a, "tell_orchestrator"))
				note("orchestrator spawn_subagent", refusal(a, "spawn_subagent"))
				note("orchestrator list_boards", refusal(a, "list_boards"))
				a.Notes()
				a.Add("One", true)
				a.Add("Two", true)
				a.Say("Two writers of one line.")
				return
			}
			mxFinishWhenDone(a)
		},
		Task: func(a *mxTurn, tk Task) {
			if a.N == 1 {
				note("task list", strings.Join(a.Tools(), " "))
				note("task get_run", refusal(a, "get_run"))
				note("task add_task", refusal(a, "add_task"))
				note("task list_boards", refusal(a, "list_boards"))
				if tk.ID == "T01" {
					text, isErr := a.Call("spawn_subagent", map[string]any{"prompt": "Look at shared.txt.", "description": "a look"})
					note("task spawn_subagent", fmt.Sprintf("%v|%s", isErr, text))
					if !isErr {
						a.Say("Waiting for the subagent.")
						return
					}
				}
			}
			a.Write("shared.txt", "line of "+tk.ID+"\n")
			a.Done("Put my line in.")
		},
		Merge: func(a *mxTurn, tk Task) {
			note("merge list", strings.Join(a.Tools(), " "))
			note("merge get_run", refusal(a, "get_run"))
			note("merge finish_run", refusal(a, "finish_run"))
			mxRefMerge(a)
		},
		Sub: func(a *mxTurn) {
			note("subagent list", strings.Join(a.Tools(), " "))
			note("subagent get_run", refusal(a, "get_run"))
			note("subagent spawn_subagent", refusal(a, "spawn_subagent"))
			a.Say("Looked.")
		},
		Chat: func(a *mxTurn) {
			who := "chat"
			if id, _ := plain.Load().(string); a.Opts.ChatID == id {
				who = "plain chat"
			}
			note(who+" list", strings.Join(a.Tools(), " "))
			text, isErr := a.Call("get_run", map[string]any{})
			note(who+" get_run", fmt.Sprintf("%v|%s", isErr, text))
			note(who+" set_notes", refusal(a, "set_notes"))
			note(who+" finish_run", refusal(a, "finish_run"))
			note(who+" list_boards", refusal(a, "list_boards"))
			a.Say("Hello.")
		},
	})
	h.startRun(nil)
	chat, _ := h.newChat()
	if err := h.cm().Send(chat, "What may you do?", "", nil); err != nil {
		t.Fatal(err)
	}
	pv, err := h.cm().Create(model.Claude, model.Ungrouped, "")
	if err != nil {
		t.Fatal(err)
	}
	plain.Store(pv.ID)
	if err := h.cm().Send(pv.ID, "What may you do?", "", nil); err != nil {
		t.Fatal(err)
	}
	h.wait("both chats to have answered", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return got["chat list_boards"] != "" && got["plain chat list_boards"] != ""
	})
	h.wait("the plain chat's turn to end", func() bool { return !h.cm().Busy(pv.ID) })
	h.cm().Stop(pv.ID)
	l := h.finished()
	if !mxMergeAgentRan(l) {
		t.Fatalf("no merge agent ran\n%s", h.dump())
	}
	mu.Lock()
	defer mu.Unlock()
	want := map[string]string{
		"orchestrator list":              mxOrchTools,
		"orchestrator tell_orchestrator": toolOrchTell,
		"orchestrator spawn_subagent":    "spawn_subagent is not available to this agent",
		"orchestrator list_boards":       "list_boards is not available on this chat",
		"task list":                      mxSpawnTools,
		"task get_run":                   "get_run is not available to this agent",
		"task add_task":                  "add_task is not available to this agent",
		"task list_boards":               "list_boards is not available on this chat",
		"merge list":                     mxSpawnTools,
		"merge get_run":                  "get_run is not available to this agent",
		"merge finish_run":               "finish_run is not available to this agent",
		"subagent list":                  "",
		"subagent get_run":               "get_run is not available to subagents",
		"subagent spawn_subagent":        "spawn_subagent is not available to subagents",
		"chat list":                      mxChatTools,
		"chat set_notes":                 toolChatNotes,
		"chat finish_run":                toolChatFinish,
		"chat list_boards":               "list_boards is not available on this chat",
		"plain chat set_notes":           "set_notes is not available on this chat",
		"plain chat finish_run":          "finish_run is not available on this chat",
	}
	for key, w := range want {
		if g, ok := got[key]; !ok || g != w {
			t.Errorf("%s: %q, want %q", key, g, w)
		}
	}
	if !strings.HasPrefix(got["task spawn_subagent"], "false|") {
		t.Errorf("the task agent's spawn_subagent: %s", got["task spawn_subagent"])
	}
	if !strings.HasPrefix(got["chat get_run"], "false|Run ") {
		t.Errorf("the chat's get_run: %.200s", got["chat get_run"])
	}
	if g := got["plain chat get_run"]; g != "true|get_run is not available on this chat" {
		t.Errorf("the plain chat's get_run: %q", g)
	}
	for _, name := range strings.Fields(mxOrchTools + " tell_orchestrator") {
		if slices.Contains(strings.Fields(got["plain chat list"]), name) {
			t.Errorf("a chat on no run is listed the run tool %s", name)
		}
	}
	for _, list := range []string{"orchestrator list", "task list", "merge list", "chat list"} {
		for _, name := range strings.Fields(got[list]) {
			if name == "list_boards" || name == "apply" || name == "get_scene" {
				t.Errorf("%s holds the whiteboard tool %s", list, name)
			}
		}
	}
	// What the processes were started with, per role.
	h.mu.Lock()
	spawned := slices.Clone(h.spawned)
	h.mu.Unlock()
	seen := map[string]bool{}
	for _, o := range spawned {
		name := h.names[o.ChatID]
		tools := strings.Join(o.MCPTools, " ")
		switch {
		case o.Subagent:
			seen["sub"] = true
			if !o.Unattended || o.MCPTools == nil || len(o.MCPTools) != 0 || o.BoardID != "" {
				t.Errorf("a run agent's subagent was started with %+v", o)
			}
		case strings.HasPrefix(name, "turn-"):
			seen["orchestrator"] = true
			if !o.Unattended || !o.ReadOnly || tools != mxOrchTools || o.BoardID != "" {
				t.Errorf("the orchestrator was started with %+v", o)
			}
		case strings.HasSuffix(name, "-work"), strings.Contains(name, "-merge"):
			seen[name[strings.LastIndex(name, "-")+1:]] = true
			if !o.Unattended || o.ReadOnly || tools != mxSpawnTools || o.BoardID != "" {
				t.Errorf("%s was started with %+v", name, o)
			}
		case o.ChatID == chat:
			seen["chat"] = true
			if o.Unattended || o.ReadOnly || o.BoardID != "" {
				t.Errorf("the chat on the run was started with %+v", o)
			}
		}
	}
	if len(seen) != 5 {
		t.Errorf("processes seen: %v", seen)
	}
}

// Invariant 14: what a failed or cancelled writing task had done is committed to its own branch
// before its checkout is removed, and a retry starts on a new branch. When that commit cannot be
// made, or the tree is on another branch, the checkout is kept and the task says where it is.
func TestInv14UnfinishedWorkOnBranch(t *testing.T) {
	t.Parallel()
	turn := func(a *mxTurn, n int) {
		l := a.State()
		switch {
		case n == 1:
			a.Notes()
			a.Add("Half a job", true)
			a.Say("One task.")
		case len(l.Tasks[0].Attempts) == 1 && l.Tasks[0].State() == model.TaskFailed:
			if text, isErr := a.Call("retry_task", map[string]any{"id": "T01", "reason": "it should work now"}); isErr {
				a.Say("retry_task was refused: " + text)
				return
			}
			a.Say("Again.")
		case l.Tasks[0].State().Final():
			a.Finish()
			a.Say("Finished.")
		default:
			a.Say("Waiting.")
		}
	}
	unfinished := "T01: unfinished work (Half a job)"
	t.Run("failed, then retried", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, true)
		h.plan(mxPlan{Turn: turn, Task: func(a *mxTurn, tk Task) {
			if len(tk.Attempts) == 1 {
				a.Write("half.txt", "half done\n")
				a.Say(agentBlock("failed", "Could not finish.", "The second half is missing."))
				return
			}
			a.Write("whole.txt", "all done\n")
			a.Done("Did all of it.")
		}})
		h.startRun(nil)
		l := h.finished()
		tk, _ := mxTask(l, "T01")
		if len(tk.Attempts) != 2 || tk.Attempts[0].Outcome != model.TaskFailed || tk.Attempts[1].Outcome != model.TaskDone {
			t.Fatalf("attempts: %+v", tk.Attempts)
		}
		a1, a2 := tk.Attempts[0], tk.Attempts[1]
		b1, b2 := "aiwb/"+h.id+"/T01", "aiwb/"+h.id+"/T01-a2"
		if a1.Branch != b1 || a2.Branch != b2 || a1.Worktree != "" || a2.Worktree != "" {
			t.Errorf("branches %q and %q, checkouts %q and %q", a1.Branch, a2.Branch, a1.Worktree, a2.Worktree)
		}
		if got := h.repo.Git("log", "-1", "--format=%s", b1); got != unfinished {
			t.Errorf("the failed attempt's branch ends with %q", got)
		}
		if got := h.repo.Git("show", b1+":half.txt"); got != "half done" {
			t.Errorf("half.txt on the failed attempt's branch: %q", got)
		}
		if h.intFile("half.txt") != "" || h.intFile("whole.txt") != "all done" {
			t.Errorf("the integration branch: half.txt %q, whole.txt %q", h.intFile("half.txt"), h.intFile("whole.txt"))
		}
		if _, err := h.repo.GitIn(h.repo.Dir(), "merge-base", "--is-ancestor", b1, b2); err == nil {
			t.Error("the retry was built on the failed attempt's branch")
		}
		if !strings.Contains(a1.Error, "Could not finish.") {
			t.Errorf("the failed attempt's error: %q", a1.Error)
		}
		h.noCheckouts()
	})
	t.Run("cancelled", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, true)
		h.plan(mxPlan{Turn: turn, Task: func(a *mxTurn, tk Task) {
			a.Write("half.txt", "half done\n")
			a.Gate("work")
		}})
		h.startRun(nil)
		h.atGate("work")
		_, token := h.newChat()
		if text, isErr := h.call(token, "cancel_task", map[string]any{"id": "T01", "reason": "not wanted"}); isErr {
			t.Fatalf("cancel_task: %s", text)
		}
		l := h.finished()
		tk, _ := mxTask(l, "T01")
		b1 := "aiwb/" + h.id + "/T01"
		if tk.State() != model.TaskCancelled || tk.Attempts[0].Worktree != "" {
			t.Fatalf("the task: %s %+v", tk.State(), tk.Attempts[0])
		}
		if got := h.repo.Git("log", "-1", "--format=%s", b1); got != unfinished {
			t.Errorf("the cancelled attempt's branch ends with %q", got)
		}
		if got := h.repo.Git("show", b1+":half.txt"); got != "half done" {
			t.Errorf("half.txt on the cancelled attempt's branch: %q", got)
		}
		if h.intFile("half.txt") != "" {
			t.Error("the cancelled task's file is on the integration branch")
		}
		h.noCheckouts()
	})
	t.Run("the tree is on another branch", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, true)
		h.plan(mxPlan{Turn: turn, Task: func(a *mxTurn, tk Task) {
			if len(tk.Attempts) > 1 {
				a.Done("Did it.")
				return
			}
			a.Write("half.txt", "half done\n")
			if out, err := h.repo.GitIn(a.Cwd, "checkout", "-q", "-b", "elsewhere"); err != nil {
				t.Errorf("checkout: %v %s", err, out)
			}
			a.Say(agentBlock("failed", "Could not finish.", "I lost my way."))
		}})
		h.startRun(func(m *model.RunMeta) { m.Settings.Wake = "idle" })
		l := h.waitTask("T01", model.TaskFailed, model.TaskDone)
		tk, _ := mxTask(l, "T01")
		a1 := tk.Attempts[0]
		wt := filepath.Join(h.world().st.P.RunWorkDir(h.id), "T01")
		if a1.Outcome != model.TaskFailed || !strings.Contains(a1.Error, "Its uncommitted work is left in "+wt) {
			t.Fatalf("the attempt: %s %q", a1.Outcome, a1.Error)
		}
		if b, _ := os.ReadFile(filepath.Join(wt, "half.txt")); string(b) != "half done\n" {
			t.Errorf("the kept checkout holds half.txt = %q", b)
		}
		if got := h.repo.Git("log", "-1", "--format=%s", "aiwb/"+h.id+"/T01"); got != "first" {
			t.Errorf("the task's branch got the commit %q although the tree was elsewhere", got)
		}
		if got := h.repo.Git("log", "-1", "--format=%s", "elsewhere"); got != "first" {
			t.Errorf("the agent's own branch got the commit %q", got)
		}
		h.finished()
	})
	t.Run("the commit fails", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, true)
		h.plan(mxPlan{Turn: turn, Task: func(a *mxTurn, tk Task) {
			if len(tk.Attempts) > 1 {
				a.Done("Did it.")
				return
			}
			// The agent commits by itself, then pops a stash that conflicts with its commit and
			// leaves the conflict: nothing can be committed over unmerged paths.
			a.Write("shared.txt", "stashed\n")
			for _, args := range [][]string{{"stash"}, {"commit", "-q", "--allow-empty", "-m", "the agent's own commit"}} {
				if out, err := h.repo.GitIn(a.Cwd, args...); err != nil {
					t.Errorf("git %v: %v %s", args, err, out)
				}
			}
			a.Write("shared.txt", "committed\n")
			h.repo.GitIn(a.Cwd, "commit", "-q", "-am", "the agent's second commit")
			h.repo.GitIn(a.Cwd, "stash", "pop") // conflicts
			a.Done("Wrote shared.txt.")
		}})
		h.startRun(func(m *model.RunMeta) { m.Settings.Wake = "idle" })
		l := h.waitTask("T01", model.TaskFailed, model.TaskDone)
		tk, _ := mxTask(l, "T01")
		a1 := tk.Attempts[0]
		wt := filepath.Join(h.world().st.P.RunWorkDir(h.id), "T01")
		if a1.Outcome != model.TaskFailed || !strings.Contains(a1.Error, "left a merge or a conflict unfinished") ||
			!strings.Contains(a1.Error, "Its uncommitted work is left in "+wt) {
			t.Fatalf("the attempt: %s %q", a1.Outcome, a1.Error)
		}
		if b, _ := os.ReadFile(filepath.Join(wt, "shared.txt")); !strings.Contains(string(b), "stashed") {
			t.Errorf("the kept checkout holds shared.txt = %q", b)
		}
		if a1.Head != "" || a1.Merged != "" || h.intFile("shared.txt") != "base" {
			t.Errorf("the attempt that could not be committed: head %q merged %q, shared.txt on the integration branch %q", a1.Head, a1.Merged, h.intFile("shared.txt"))
		}
		h.finished()
	})
}

// agentBlock is an answer that ends with a result block.
func agentBlock(outcome, summary, report string) string {
	return "Here is my result.\n\n<result>\n<outcome>" + outcome + "</outcome>\n<summary>" + summary + "</summary>\n<report>\n" + report + "\n</report>\n</result>"
}

// Invariant 15: the tasks a halt left active go on before any new task starts, however many
// tasks may run at once.
func TestInv15ActiveTasksRestartFirst(t *testing.T) {
	t.Parallel()
	for _, how := range []string{"stop", "crash"} {
		t.Run(how, func(t *testing.T) {
			t.Parallel()
			h := newMx(t, false)
			var most atomic.Int32
			h.plan(mxPlan{
				Turn: func(a *mxTurn, n int) {
					if n == 1 {
						for i := 1; i <= 4; i++ {
							a.Add(fmt.Sprintf("Look %d", i), false)
						}
						a.Say("Four tasks.")
						return
					}
					mxFinishWhenDone(a)
				},
				Task: func(a *mxTurn, tk Task) {
					if (tk.ID == "T01" || tk.ID == "T02") && !a.Gate("work") {
						return
					}
					a.Done("Looked.")
				},
			})
			h.newRun(func(m *model.RunMeta) { m.Settings.MaxParallel = 2; m.Settings.Wake = "idle" })
			h.mu.Lock()
			h.onEntry = func(l *Loaded) {
				n := int32(0)
				for _, tk := range l.Tasks {
					if tk.State().Active() {
						n++
					}
				}
				if n > most.Load() {
					most.Store(n)
				}
			}
			h.mu.Unlock()
			h.begin()
			h.atGate("work")
			h.waitL("two to work and two to wait", func(l *Loaded) bool {
				return mxState(l, "T01") == model.TaskWork && mxState(l, "T02") == model.TaskWork &&
					mxState(l, "T03") == model.TaskSlot && mxState(l, "T04") == model.TaskSlot
			})
			h.wait("both agents to be at work", func() bool { return h.turnsOf("T01-work") == 1 && h.turnsOf("T02-work") == 1 })
			if how == "stop" {
				h.stopRun()
				h.idleEngine()
			} else {
				h.crash()
				h.waitStatus(model.RunStopped)
			}
			// One task at a time from now on: the two that were active still both go on first.
			if err := h.s().svcSetMeta(h.r(), func(m *model.RunMeta) error { m.Settings.MaxParallel = 1; return nil }); err != nil {
				t.Fatal(err)
			}
			h.regate("work")
			h.resume()
			h.atGate("work")
			h.wait("both agents to be at work again", func() bool { return h.turnsOf("T01-work") == 2 && h.turnsOf("T02-work") == 2 })
			for i := 0; i < 10; i++ {
				h.tick(time.Second)
			}
			l := h.L()
			if mxState(l, "T03") != model.TaskSlot || mxState(l, "T04") != model.TaskSlot || h.turnsOf("T03-work")+h.turnsOf("T04-work") != 0 {
				t.Fatalf("a new task started before the active ones had ended\n%s", h.dump())
			}
			for _, name := range []string{"T01-work", "T02-work"} {
				a, _ := mxAgent(l, name)
				if len(a.Launches) != 2 || !a.Launches[1].Resume {
					t.Errorf("%s was not resumed: %+v", name, a.Launches)
				}
			}
			h.open("work")
			h.finished()
			if most.Load() != 2 {
				t.Errorf("at most %d tasks were active at once", most.Load())
			}
		})
	}
}
