package runs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

// engConflictRun is a git run whose first turn adds n writing tasks that all change line two of
// f.txt, each to "two by <task>". Every work agent and every merge agent waits at its gate. A
// merge agent resolves the file to resolved(name) unless merge answers for it.
func engConflictRun(t *testing.T, id string, n int, merge func(e *engEnv, m *engMsg) bool) (*engEnv, *run) {
	t.Helper()
	e := newEngEnv(t, true)
	r := e.run(id, func(m *model.RunMeta) { m.Settings.Wake = "idle" })
	e.gates.block("turn-002")
	for i := 1; i <= n; i++ {
		e.gates.block(WorkAgentName(TaskID(i), 1))
	}
	e.conflictScript(r, n, merge)
	return e, r
}

func (e *engEnv) conflictScript(r *run, n int, merge func(e *engEnv, m *engMsg) bool) {
	e.play(r, func() {
		for i := 1; i <= n; i++ {
			e.add(r, 1, "Change line two", true)
		}
	}, func(m *engMsg) bool {
		switch m.Role {
		case model.RoleTask:
			engWrite(e.t, m.Cwd, "f.txt", "one\ntwo by "+strings.TrimSuffix(m.Name, "-work")+"\nthree\n")
		case model.RoleMerge:
			if merge != nil && merge(e, m) {
				return true
			}
			engWrite(e.t, m.Cwd, "f.txt", "one\n"+engResolved(m.Name)+"\nthree\n")
			m.Block("completed", "Resolved f.txt.", "Kept both sides.")
			return true
		}
		return false
	})
}

func engResolved(agent string) string { return "two as resolved by " + agent }

// fileOn is a file's content on a branch.
func (e *engEnv) fileOn(branch, path string) string {
	e.t.Helper()
	return e.repo.Git("show", branch+":"+path)
}

func (e *engEnv) merging(dir string) bool {
	_, err := os.Stat(filepath.Join(strings.TrimSpace(e.git(dir, "rev-parse", "--absolute-git-dir")), "MERGE_HEAD"))
	return err == nil
}

// A conflict is resolved on the task's side by a merge agent, checked and concluded by the run,
// and the task then merges. While the merge agent works nobody holds the merge lock: a third
// task starts, works, merges and ends.
func TestMergeConflictResolvedByAgent(t *testing.T) {
	t.Parallel()
	e, r := engConflictRun(t, "r_conf", 2, nil)
	e.gates.block("T02-merge")
	// A third task that touches another file, added by hand once the first two run.
	r.mu.Lock()
	r.meta.Settings.MaxParallel = 2
	r.mu.Unlock()
	r.startEngine()
	engTask(t, r, "T01", model.TaskWork)
	engTask(t, r, "T02", model.TaskWork)
	engUntil(t, "both work agents", func() bool { return len(e.host.sent("T01-work")) == 1 && len(e.host.sent("T02-work")) == 1 })
	e.must(r, KOp, func(tx *Tx) error {
		tx.AddTask(Task{ID: "T03", Title: "Another file", Kind: "build", Writes: true, CreatedAt: tx.Now(), BriefRev: 1,
			Attempts: []Attempt{{RunAttempt: model.RunAttempt{N: 1, QueuedAt: tx.Now()}}}})
		tx.File(briefRel("T03", 1), []byte("brief"))
		return nil
	})
	e.host.wrapOn(func(on func(m *engMsg)) func(m *engMsg) {
		return func(m *engMsg) {
			if m.Name == "T03-work" {
				engWrite(t, m.Cwd, "other.txt", "by T03\n")
				m.Block("completed", "T03 is done.", "r")
				return
			}
			on(m)
		}
	})

	e.gates.open("T01-work")
	engTask(t, r, "T01", model.TaskDone)
	e.gates.open("T02-work")
	engUntil(t, "the merge agent", func() bool { return len(e.host.sent("T02-merge")) == 1 })
	a := r.engLast(t, "T02")
	if a.MergeRound != 1 || a.MergeAgentDone != 0 || strings.Join(a.Conflicts, ",") != "f.txt" || a.Agents.Merge != AgentChatID(r.id, "T02-merge") ||
		r.engTaskState("T02") != model.TaskMerge || a.Head == "" {
		t.Errorf("the attempt while its conflict is resolved: %+v", a)
	}
	wt := filepath.Join(e.s.Store.P.RunWorkDir(r.id), "T02")
	m := e.host.sent("T02-merge")[0]
	if m.Cwd != wt || m.Role != model.RoleMerge || !strings.Contains(m.Text, "these files conflict:\n\n- f.txt\n\nWhat git reported:\n\nCONFLICT (content): Merge conflict in f.txt") ||
		!strings.Contains(m.Text, "<brief>\nDo this: Change line two.\n</brief>") || !strings.Contains(m.Text, "  - T01 Change line two: T01-work is done.") {
		t.Errorf("the merge agent's message (cwd %s):\n%s", m.Cwd, m.Text[:min(len(m.Text), 900)])
	}
	if !e.merging(wt) || e.merging(r.engGit().Integration) {
		t.Error("the conflict is not being resolved on the task's side")
	}
	// The third task runs from its slot to its end while the merge agent works.
	engTask(t, r, "T03", model.TaskDone)
	if got := r.cancelActive("T02", model.AttemptCancel{Reason: "x"}); got != "T02 has finished and is being merged; it can no longer be cancelled." {
		t.Errorf("a cancel of a merging task: %q", got)
	}
	e.gates.open("T02-merge")
	engTask(t, r, "T02", model.TaskDone)

	a = r.engLast(t, "T02")
	ib := r.engGit().IntegrationBranch
	if a.MergeRound != 1 || a.MergeAgentDone != 1 || a.Merged != e.repo.Git("rev-parse", ib) || strings.Join(a.Conflicts, ",") != "f.txt" {
		t.Errorf("the merged attempt: %+v", a)
	}
	if got := e.fileOn(ib, "f.txt"); got != "one\n"+engResolved("T02-merge")+"\nthree" {
		t.Errorf("f.txt on the integration branch: %q", got)
	}
	if got := e.fileOn(ib, "other.txt"); got != "by T03" {
		t.Errorf("the third task's work: %q", got)
	}
	if got := e.repo.Git("log", "--format=%s", "--first-parent", ib); got != "Merge T02: Change line two\nMerge T03: Another file\nMerge T01: Change line two\nfirst" {
		t.Errorf("the integration branch: %q", got)
	}
	// The task's own line of commits: without --first-parent the two newest commits are listed by
	// date, and the third task's merge can be newer than this task's commit.
	if got := e.repo.Git("log", "--format=%s", "--first-parent", "-2", "aiwb/r_conf/T02"); got != "Merge "+ib+" into T02\nT02: Change line two" {
		t.Errorf("the task's branch: %q", got)
	}
	c, err := readChanges(r.dir, "T02", 1)
	if err != nil || strings.Join(c.Conflicts, ",") != "f.txt" || c.Merged != a.Merged || len(c.Files) != 1 {
		t.Errorf("changes: %+v, %v", c, err)
	}
	ag, _ := r.engAgentNamed("T02-merge")
	if ag.Status != model.AgentDone || ag.Role != model.RoleMerge || ag.Task != "T02" || ag.Attempt != 1 {
		t.Errorf("the merge agent: %+v", ag)
	}
	if e.merging(r.engGit().Integration) {
		t.Error("the integration checkout is left in a merge")
	}
}

// The merge agent can say that it could not resolve the conflict; and a resolution that leaves
// conflict markers is not concluded. Either way the task fails, its own commit stays on its
// branch, and the integration branch is as it was.
func TestMergeAgentFailsOrLeavesMarkers(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		merge func(e *engEnv, m *engMsg) bool
		want  string
	}{
		{"failed", func(e *engEnv, m *engMsg) bool {
			m.Block("failed", "The two changes cannot both hold.", "why")
			return true
		}, "the merge agent could not resolve the conflict: The two changes cannot both hold."},
		{"markers", func(e *engEnv, m *engMsg) bool {
			m.Block("completed", "Resolved.", "it is not")
			return true
		}, "the conflict is not resolved: f.txt: conflict markers left at line 2 (<<<<<<< HEAD), 4 (=======), 6 (>>>>>>> aiwb/r_bad/integration)"},
		{"ended the merge itself", func(e *engEnv, m *engMsg) bool {
			engWrite(e.t, m.Cwd, "f.txt", "one\nmine\nthree\n")
			e.git(m.Cwd, "commit", "-q", "-am", "I merged it")
			m.Block("completed", "Committed.", "r")
			return true
		}, "the merge agent ended the merge itself (git commit or git merge --abort) instead of leaving it to the run"},
	}
	for _, c := range cases {
		e, r := engConflictRun(t, "r_bad", 2, c.merge)
		r.startEngine()
		engTask(t, r, "T02", model.TaskWork)
		e.gates.open("T01-work")
		engTask(t, r, "T01", model.TaskDone)
		ib := r.engGit().IntegrationBranch
		before := e.repo.Git("rev-parse", ib)
		e.gates.open("T02-work")
		engTask(t, r, "T02", model.TaskFailed)
		a := r.engLast(t, "T02")
		if a.Error != c.want {
			t.Errorf("%s: error %q", c.name, a.Error)
		}
		if a.Merged != "" || a.Head == "" || a.Worktree != "" {
			t.Errorf("%s: attempt %+v", c.name, a)
		}
		if got := e.repo.Git("rev-parse", ib); got != before || e.merging(r.engGit().Integration) {
			t.Errorf("%s: the integration branch moved or its checkout is in a merge", c.name)
		}
		if got := e.fileOn(ib, "f.txt"); got != "one\ntwo by T01\nthree" {
			t.Errorf("%s: f.txt on the integration branch: %q", c.name, got)
		}
		if c.name != "ended the merge itself" {
			if got := e.fileOn("aiwb/r_bad/T02", "f.txt"); got != "one\ntwo by T02\nthree" {
				t.Errorf("%s: the task's branch: %q", c.name, got)
			}
		}
		if ag, _ := r.engAgentNamed("T02-merge"); ag.Status != model.AgentDone {
			t.Errorf("%s: the merge agent: %+v", c.name, ag)
		}
		if engExists(filepath.Join(e.s.Store.P.RunWorkDir(r.id), "T02")) {
			t.Errorf("%s: the checkout of the failed task is still there", c.name)
		}
		r.stopEngine(10 * time.Second)
	}
}

// The integration branch moves while a conflict is resolved: the concluded resolution conflicts
// again, which is the next round with a merge agent of its own.
func TestMergeIntegrationMovesDuringResolution(t *testing.T) {
	t.Parallel()
	e, r := engConflictRun(t, "r_move", 3, nil)
	e.gates.block("T02-merge")
	r.startEngine()
	engTask(t, r, "T03", model.TaskWork)
	engUntil(t, "the work agents", func() bool { return len(e.host.all()) == 4 })
	e.gates.open("T01-work")
	engTask(t, r, "T01", model.TaskDone)
	e.gates.open("T02-work")
	engUntil(t, "the merge agent of T02", func() bool { return len(e.host.sent("T02-merge")) == 1 })
	// T03 conflicts too, is resolved and merged while T02's agent still works.
	e.gates.open("T03-work")
	engTask(t, r, "T03", model.TaskDone)
	ib := r.engGit().IntegrationBranch
	if got := e.fileOn(ib, "f.txt"); got != "one\n"+engResolved("T03-merge")+"\nthree" {
		t.Fatalf("f.txt after T03: %q", got)
	}
	e.gates.open("T02-merge")
	engTask(t, r, "T02", model.TaskDone)
	a := r.engLast(t, "T02")
	if a.MergeRound != 2 || a.MergeAgentDone != 2 || a.Agents.Merge != AgentChatID(r.id, "T02-merge-r2") {
		t.Errorf("attempt: %+v", a)
	}
	if got := e.fileOn(ib, "f.txt"); got != "one\n"+engResolved("T02-merge-r2")+"\nthree" {
		t.Errorf("f.txt on the integration branch: %q", got)
	}
	for _, name := range []string{"T02-merge", "T02-merge-r2", "T03-merge"} {
		if ag, ok := r.engAgentNamed(name); !ok || ag.Status != model.AgentDone || len(ag.Launches) != 1 {
			t.Errorf("agent %s: %+v", name, ag)
		}
	}
	// Round two got the whole merge prompt, with the task merged meanwhile.
	m := e.host.sent("T02-merge-r2")[0]
	if !strings.HasPrefix(m.Text, "You are resolving a merge conflict") || !strings.Contains(m.Text, "  - T03 Change line two: T03-work is done.") || m.Resumed {
		t.Errorf("round two's message: %s", m.Text[:min(len(m.Text), 300)])
	}
	// The attempt's cost is its work agent's and every merge agent's.
	if a.Cost != nil {
		t.Errorf("cost without any reported: %v", *a.Cost)
	}
	if got := e.repo.Git("log", "--format=%s", "--first-parent", ib); got != "Merge T02: Change line two\nMerge T03: Change line two\nMerge T01: Change line two\nfirst" {
		t.Errorf("the integration branch: %q", got)
	}
}

// When the integration branch moves under every resolution, the task fails after three rounds,
// and the integration checkout is not left in a merge.
func TestMergeThreeRounds(t *testing.T) {
	t.Parallel()
	n := 0
	e, r := engConflictRun(t, "r_three", 2, func(e *engEnv, m *engMsg) bool {
		// While this agent "works", someone else's change to the same line lands.
		n++
		int_ := filepath.Join(e.s.Store.P.RunWorkDir("r_three"), "int")
		engWrite(e.t, int_, "f.txt", "one\ntwo moved again "+m.Name+"\nthree\n")
		e.git(int_, "commit", "-q", "-am", "someone else, during "+m.Name)
		return false
	})
	r.startEngine()
	engTask(t, r, "T02", model.TaskWork)
	e.gates.open("T01-work")
	engTask(t, r, "T01", model.TaskDone)
	e.gates.open("T02-work")
	engTask(t, r, "T02", model.TaskFailed)
	a := r.engLast(t, "T02")
	ib := r.engGit().IntegrationBranch
	if a.Error != "merging T02 kept conflicting with new work on "+ib+" (3 rounds)" || a.MergeRound != 3 || a.MergeAgentDone != 3 || a.Merged != "" {
		t.Errorf("attempt: %+v", a)
	}
	if n != 3 || len(e.host.sent("T02-merge")) != 1 || len(e.host.sent("T02-merge-r2")) != 1 || len(e.host.sent("T02-merge-r3")) != 1 {
		t.Errorf("%d merge agent turns", n)
	}
	if e.merging(r.engGit().Integration) {
		t.Error("the integration checkout is left in a merge")
	}
	if got := e.fileOn(ib, "f.txt"); got != "one\ntwo moved again T02-merge-r3\nthree" {
		t.Errorf("f.txt on the integration branch: %q", got)
	}
}

// A merge that fails for another reason than a conflict fails the task, leaves the integration
// checkout as it was, and never merges the integration branch into the task.
func TestMergeFailsWithoutConflict(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.run("r_nonc", nil)
	e.gates.block("turn-002")
	e.play(r, func() { e.add(r, 1, "Add new.txt", true) }, func(m *engMsg) bool {
		if m.Name == "T01-work" {
			engWrite(t, m.Cwd, "new.txt", "the task's\n")
			// An untracked file of the same name in the integration checkout is in the merge's way.
			engWrite(t, filepath.Join(e.s.Store.P.RunWorkDir(r.id), "int"), "new.txt", "in the way\n")
		}
		return false
	})
	r.startEngine()
	engTask(t, r, "T01", model.TaskFailed)
	a := r.engLast(t, "T01")
	g := r.engGit()
	if !strings.HasPrefix(a.Error, "merging T01 into "+g.IntegrationBranch+" failed:\n") || !strings.Contains(a.Error, "new.txt") {
		t.Errorf("error: %q", a.Error)
	}
	if a.MergeRound != 0 || len(a.Conflicts) != 0 || a.Head == "" || a.Merged != "" {
		t.Errorf("attempt: %+v", a)
	}
	if got := e.repo.Git("rev-parse", g.IntegrationBranch); got != g.BaseRef || e.merging(g.Integration) {
		t.Error("the integration branch moved, or its checkout is in a merge")
	}
	if b, _ := os.ReadFile(filepath.Join(g.Integration, "new.txt")); string(b) != "in the way\n" {
		t.Errorf("the file in the integration checkout: %q", b)
	}
	if got := e.repo.Git("log", "--format=%s", "aiwb/r_nonc/T01"); got != "T01: Add new.txt\nfirst" {
		t.Errorf("the task's branch: %q", got)
	}
	engUntil(t, "turn 2", func() bool { return len(r.engTurns()) == 2 })
	if ev := r.engTurns()[1].WokenBy; len(ev) != 1 || ev[0].Type != "task_failed" || len([]rune(ev[0].Text)) > 600 || !strings.HasPrefix(ev[0].Text, "merging T01 into ") {
		t.Errorf("the event: %+v", ev)
	}
}

// A restart at each point of a conflict resolution continues it: never a commit of half-resolved
// files, never a second round for the same conflict, never a second run of an agent that is done.
func TestMergeRestartPoints(t *testing.T) {
	t.Parallel()
	// 1. The server died with the integration checkout in the middle of a merge: it is undone.
	t.Run("integration mid-merge", func(t *testing.T) {
		t.Parallel()
		e, r := engConflictRun(t, "r_rs1", 2, nil)
		r.startEngine()
		engTask(t, r, "T02", model.TaskWork)
		e.gates.open("T01-work")
		engTask(t, r, "T01", model.TaskDone)
		engUntil(t, "T02's agent", func() bool { return len(e.host.sent("T02-work")) == 1 })
		r = e.restart("r_rs1")
		g := r.engGit()
		wt := filepath.Join(e.s.Store.P.RunWorkDir(r.id), "T02")
		// What a dead engine may have left: the task's commit made, its merge begun.
		engWrite(t, wt, "f.txt", "one\ntwo by T02\nthree\n")
		e.git(wt, "commit", "-q", "-am", "T02: Change line two")
		if out, err := e.repo.GitIn(g.Integration, "merge", "--no-ff", "aiwb/r_rs1/T02"); err == nil {
			t.Fatalf("the merge did not conflict: %s", out)
		}
		if !e.merging(g.Integration) {
			t.Fatal("the integration checkout is not in a merge")
		}
		e.conflictScript(r, 2, nil)
		e.gates.open("T02-work")
		e.s.Boot()
		if err := r.resume(); err != nil {
			t.Fatal(err)
		}
		engTask(t, r, "T02", model.TaskDone)
		a := r.engLast(t, "T02")
		if a.MergeRound != 1 || a.MergeAgentDone != 1 || e.merging(g.Integration) {
			t.Errorf("attempt: %+v", a)
		}
		if got := e.fileOn(g.IntegrationBranch, "f.txt"); got != "one\n"+engResolved("T02-merge")+"\nthree" {
			t.Errorf("f.txt on the integration branch: %q", got)
		}
	})

	// 2. The server died while the merge agent worked: the same agent is resumed, in the same round.
	t.Run("before the merge agent answered", func(t *testing.T) {
		t.Parallel()
		e, r := engConflictRun(t, "r_rs2", 2, nil)
		e.gates.block("T02-merge")
		r.startEngine()
		engTask(t, r, "T02", model.TaskWork)
		e.gates.open("T01-work")
		engTask(t, r, "T01", model.TaskDone)
		e.gates.open("T02-work")
		engUntil(t, "the merge agent", func() bool { return len(e.host.sent("T02-merge")) == 1 })
		for i := 0; i < 3; i++ { // three restarts inside one resolution are still one round
			r = e.restart("r_rs2")
			e.conflictScript(r, 2, nil)
			e.s.Boot()
			if err := r.resume(); err != nil {
				t.Fatal(err)
			}
			engUntil(t, "the merge agent again", func() bool { return len(e.host.sent("T02-merge")) == 1 })
			if a := r.engLast(t, "T02"); a.MergeRound != 1 || a.MergeAgentDone != 0 || !e.merging(a.Worktree) {
				t.Fatalf("restart %d: %+v", i, a)
			}
		}
		m := e.host.sent("T02-merge")[0]
		if !m.Resumed || !strings.HasPrefix(m.Text, "Your previous run of this job stopped") || !strings.Contains(m.Text, "these files conflict:\n\n- f.txt\n") {
			t.Errorf("the resumed merge agent's message: %s", m.Text[:min(len(m.Text), 200)])
		}
		e.gates.open("T02-merge")
		engTask(t, r, "T02", model.TaskDone)
		a := r.engLast(t, "T02")
		if a.MergeRound != 1 || a.MergeAgentDone != 1 {
			t.Errorf("attempt: %+v", a)
		}
		if _, ok := r.engAgentNamed("T02-merge-r2"); ok {
			t.Error("a second round was opened for the same conflict")
		}
		if got := e.fileOn(r.engGit().IntegrationBranch, "f.txt"); got != "one\n"+engResolved("T02-merge")+"\nthree" {
			t.Errorf("f.txt on the integration branch: %q", got)
		}
	})

	// 3. The server died after the merge agent's answer was recorded, before the merge was
	// concluded: the run checks and concludes; no agent runs again.
	t.Run("after the merge agent answered", func(t *testing.T) {
		t.Parallel()
		e, r := engConflictRun(t, "r_rs3", 2, nil)
		e.gates.block("T02-merge")
		r.startEngine()
		engTask(t, r, "T02", model.TaskWork)
		e.gates.open("T01-work")
		engTask(t, r, "T01", model.TaskDone)
		e.gates.open("T02-work")
		engUntil(t, "the merge agent", func() bool { return len(e.host.sent("T02-merge")) == 1 })
		r = e.restart("r_rs3")
		wt := r.engLast(t, "T02").Worktree
		// The agent had resolved the file and its answer was recorded; then the server died.
		engWrite(t, wt, "f.txt", "one\n"+engResolved("by hand")+"\nthree\n")
		id := AgentChatID(r.id, "T02-merge")
		e.must(r, KTaskStep, func(tx *Tx) error {
			tk := tx.Task("T02")
			tk.Attempts[0].MergeAgentDone = 1
			ag := tx.Agent(id)
			engEndLaunch(ag, tx.Now(), "")
			ag.Status, ag.EndedAt = model.AgentDone, tx.Now()
			return nil
		})
		e.conflictScript(r, 2, nil)
		e.s.Boot()
		if err := r.resume(); err != nil {
			t.Fatal(err)
		}
		engTask(t, r, "T02", model.TaskDone)
		if n := len(e.host.all()); n != 0 {
			t.Errorf("%d message(s) were sent after the restart: %v", n, e.host.names())
		}
		if got := e.fileOn(r.engGit().IntegrationBranch, "f.txt"); got != "one\n"+engResolved("by hand")+"\nthree" {
			t.Errorf("f.txt on the integration branch: %q", got)
		}
		if a := r.engLast(t, "T02"); a.MergeRound != 1 || a.MergeAgentDone != 1 || a.Merged == "" {
			t.Errorf("attempt: %+v", a)
		}
	})

	// 4. The server died between the back-merge and the entry that names the round's agent: the
	// round is open, the tree is in a merge, and nobody looked at it yet. The agent runs; the
	// untouched conflict is never concluded.
	t.Run("between the back-merge and its entry", func(t *testing.T) {
		t.Parallel()
		e, r := engConflictRun(t, "r_rs4", 2, nil)
		r.startEngine()
		engTask(t, r, "T02", model.TaskWork)
		e.gates.open("T01-work")
		engTask(t, r, "T01", model.TaskDone)
		engUntil(t, "T02's agent", func() bool { return len(e.host.sent("T02-work")) == 1 })
		r = e.restart("r_rs4")
		g := r.engGit()
		wt := r.engLast(t, "T02").Worktree
		engWrite(t, wt, "f.txt", "one\ntwo by T02\nthree\n")
		e.git(wt, "commit", "-q", "-am", "T02: Change line two")
		head := e.git(wt, "rev-parse", "HEAD")
		e.repo.GitIn(wt, "merge", g.IntegrationBranch) // conflicts, and stays
		id := AgentChatID(r.id, "T02-work")
		e.must(r, KTaskStep, func(tx *Tx) error {
			tk := tx.Task("T02")
			a := &tk.Attempts[0]
			a.Result, a.WorkDone, a.Head, a.MergeRound = &model.AttemptResult{Outcome: "completed", Summary: "s"}, true, head, 1
			a.Phases = append(a.Phases, model.RunPhase{K: model.TaskMerge, T: tx.Now()})
			ag := tx.Agent(id)
			engEndLaunch(ag, tx.Now(), "")
			ag.Status, ag.EndedAt = model.AgentDone, tx.Now()
			return nil
		})
		e.conflictScript(r, 2, nil)
		e.s.Boot()
		if err := r.resume(); err != nil {
			t.Fatal(err)
		}
		engTask(t, r, "T02", model.TaskDone)
		if n := len(e.host.sent("T02-merge")); n != 1 || len(e.host.sent("T02-work")) != 0 {
			t.Errorf("the merge agent got %d message(s)", n)
		}
		if a := r.engLast(t, "T02"); a.MergeRound != 1 || a.MergeAgentDone != 1 || strings.Join(a.Conflicts, ",") != "f.txt" {
			t.Errorf("attempt: %+v", a)
		}
		if got := e.fileOn(g.IntegrationBranch, "f.txt"); got != "one\n"+engResolved("T02-merge")+"\nthree" {
			t.Errorf("f.txt on the integration branch: %q", got)
		}
	})
}

// Two tasks that finish together merge one after the other: the integration branch gets one
// merge commit per task, each on top of the other.
func TestMergesAreSerialised(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.run("r_serial", func(m *model.RunMeta) { m.Settings.MaxParallel = 6 })
	const n = 6
	e.gates.block("turn-002")
	for i := 1; i <= n; i++ {
		e.gates.block(WorkAgentName(TaskID(i), 1))
	}
	e.play(r, func() {
		for i := 1; i <= n; i++ {
			e.add(r, 1, "Add a file", true)
		}
	}, func(m *engMsg) bool {
		if m.Role == model.RoleTask {
			engWrite(t, m.Cwd, m.Name+".txt", "by "+m.Name+"\n")
		}
		return false
	})
	r.startEngine()
	engUntil(t, "every work agent", func() bool { return len(e.host.all()) == n+1 })
	for i := 1; i <= n; i++ {
		e.gates.open(WorkAgentName(TaskID(i), 1))
	}
	for i := 1; i <= n; i++ {
		engTask(t, r, TaskID(i), model.TaskDone)
	}
	ib := r.engGit().IntegrationBranch
	log := strings.Split(e.repo.Git("log", "--format=%s", "--first-parent", ib), "\n")
	if len(log) != n+1 {
		t.Fatalf("the integration branch has %d first-parent commits: %v", len(log), log)
	}
	for i := 1; i <= n; i++ {
		if got := e.fileOn(ib, WorkAgentName(TaskID(i), 1)+".txt"); !strings.HasPrefix(got, "by ") {
			t.Errorf("the work of %s is missing", TaskID(i))
		}
	}
	if out := e.repo.Git("fsck", "--no-progress"); strings.Contains(out, "error") {
		t.Errorf("fsck: %s", out)
	}
}
