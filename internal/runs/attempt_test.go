package runs

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

func engExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// A writing task and a reporting task of a git run, end to end: the checkouts, the commit, the
// merge into the integration branch, what is kept and what is removed, and the end of the run.
func TestAttemptWritingAndReportingGit(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.run("r_git", nil)
	work := e.s.Store.P.RunWorkDir(r.id)
	var sawDep, orchSaw bool
	var facts gitFacts
	// Before the engine has made the integration branch, the run stands at its base.
	if f, err := r.gitFacts(t.Context()); err != nil || f.Head != r.engGit().BaseRef || f.Commits != 0 {
		t.Fatalf("gitFacts before the engine: %+v, %v", f, err)
	}
	e.play(r, func() {
		a := e.add(r, 1, "Add a file", true)
		e.add(r, 1, "Check the file", false, a)
	}, func(m *engMsg) bool {
		switch m.Name {
		case "T01-work":
			engWrite(t, m.Cwd, "a.txt", "made by T01\n")
		case "T02-work":
			sawDep = engExists(filepath.Join(m.Cwd, "a.txt"))
			engWrite(t, m.Cwd, "scratch.txt", "thrown away\n")
		case "turn-002":
			orchSaw = engExists(filepath.Join(m.Cwd, "a.txt"))
			facts, _ = r.gitFacts(t.Context())
		case "turn-003":
			e.finishRun(r, 3, model.Achieved)
		}
		return false
	})
	r.startEngine()
	engStatus(t, r, model.RunCompleted)

	g := r.engGit()
	ib := "aiwb/r_git/integration"
	head := e.repo.Git("rev-parse", ib)
	a1 := r.engLast(t, "T01")
	if a1.Branch != "aiwb/r_git/T01" || a1.Base != g.BaseRef || a1.Head == "" || a1.Head == a1.Base || a1.Merged != head || a1.MergedAt == 0 ||
		a1.Worktree != "" || a1.Outcome != model.TaskDone || len(a1.Conflicts) != 0 {
		t.Errorf("T01: %+v", a1)
	}
	if ph := strings.TrimSpace(kinds(a1.Phases)); ph != "held slot setup work merge" {
		t.Errorf("T01 phases: %s", ph)
	}
	if got := e.repo.Git("log", "--format=%s", "--first-parent", ib); got != "Merge T01: Add a file\nfirst" {
		t.Errorf("the integration branch: %q", got)
	}
	if got := e.repo.Git("log", "--format=%s", "-1", "aiwb/r_git/T01"); got != "T01: Add a file" {
		t.Errorf("the task's commit: %q", got)
	}
	if got := e.repo.Git("show", ib+":a.txt"); got != "made by T01" {
		t.Errorf("a.txt on the integration branch: %q", got)
	}
	c, err := readChanges(r.dir, "T01", 1)
	if err != nil || len(c.Files) != 1 || c.Files[0].Path != "a.txt" || c.Files[0].Add != 1 || c.Add != 1 || c.Del != 0 || len(c.Commits) != 1 ||
		c.Commits[0].Subject != "T01: Add a file" || c.Head != a1.Head || c.Base != a1.Base || c.Merged != head || c.MergedAt != a1.MergedAt || c.Branch != a1.Branch {
		t.Errorf("changes of T01: %+v, %v", c, err)
	}

	a2 := r.engLast(t, "T02")
	if a2.Branch != "" || a2.Base != head || a2.Head != "" || a2.Merged != "" || a2.Worktree != "" || a2.Outcome != model.TaskDone {
		t.Errorf("T02: %+v", a2)
	}
	if ph := strings.TrimSpace(kinds(a2.Phases)); ph != "held deps slot setup work" {
		t.Errorf("T02 phases: %s", ph)
	}
	if _, err := readChanges(r.dir, "T02", 1); err != ErrNoText {
		t.Errorf("a reporting task has a changes file: %v", err)
	}
	if facts.Head != head || facts.Commits != 2 { // the task's commit and its merge
		t.Errorf("gitFacts in turn 2: %+v, want head %s", facts, head)
	}
	if !sawDep || !orchSaw {
		t.Errorf("the merged work was not in the later checkouts: dependent %v, orchestrator %v", sawDep, orchSaw)
	}
	if out, _ := e.repo.GitIn(e.repo.Dir(), "show", ib+":scratch.txt"); !strings.Contains(out, "does not exist") && !strings.Contains(out, "exists on disk, but not in") {
		t.Errorf("a reporting task's file reached the integration branch: %q", out)
	}

	// Where everyone worked.
	want := map[string]string{"turn-001": filepath.Join(work, "orch"), "T01-work": filepath.Join(work, "T01"), "T02-work": filepath.Join(work, "T02")}
	for name, cwd := range want {
		if m := e.host.sent(name)[0]; m.Cwd != cwd {
			t.Errorf("%s worked in %s, want %s", name, m.Cwd, cwd)
		}
	}
	dep := e.host.sent("T02-work")[0].Text
	if !strings.Contains(dep, fmt.Sprintf("Its changes are in your working directory already (`git diff %s..%s` shows them).", a1.Base[:12], a1.Head[:12])) ||
		!strings.Contains(dep, "Its full report is at "+filepath.Join(r.ctxDir(), "reports", "T01.a1.md")+". Read it only if your brief and this summary leave you short.") ||
		strings.Contains(dep, "report of T01-work") || !strings.Contains(dep, "scratch checkout") { // T02 does not name T01 in needs_report
		t.Error("the dependent task's prompt lacks the dependency's result")
	}
	if p := e.host.sent("T01-work")[0].Text; !strings.Contains(p, "git worktree made for this task") || !strings.Contains(p, "you can read the overall goal at "+filepath.Join(r.ctxDir(), "goal.md")+" and the briefs of the other tasks at ") || strings.Contains(p, "<goal>") ||
		!strings.Contains(p, "<brief>\nDo this: Add a file.\n</brief>") {
		t.Error("the writing task's prompt is not the git one with the brief and the goal")
	}

	// What is left: the branches; no checkout; the user's own checkout as it was.
	if g.ResultHead != head {
		t.Errorf("result head %q, want %q", g.ResultHead, head)
	}
	if got := e.repo.Git("branch", "--format=%(refname:short)"); got != "aiwb/r_git/T01\naiwb/r_git/integration\nmain" {
		t.Errorf("branches: %q", got)
	}
	if got := e.repo.Git("worktree", "list", "--porcelain"); strings.Count(got, "worktree ") != 1 {
		t.Errorf("work trees left: %s", got)
	}
	for _, d := range []string{"int", "orch", "T01", "T02"} {
		if engExists(filepath.Join(work, d)) {
			t.Errorf("the checkout %s is still there", d)
		}
	}
	if st := e.repo.Git("status", "--porcelain"); st != "" || e.repo.Git("rev-parse", "HEAD") != g.BaseRef || e.repo.Git("branch", "--show-current") != "main" {
		t.Errorf("the user's checkout changed: %q", st)
	}

	// removeCheckouts (a delete of the run) takes the folder and keeps the branches.
	if err := r.removeCheckouts(t.Context()); err != nil {
		t.Fatal(err)
	}
	if engExists(work) || engExists(e.s.Store.P.RunWork) {
		t.Error("the run's folder of checkouts is still there")
	}
	if got := e.repo.Git("branch", "--list", "aiwb/*"); !strings.Contains(got, "integration") {
		t.Errorf("the branches went with the checkouts: %q", got)
	}
}

// The setup command: its output goes to the attempt's log in the run's folder; a non-zero exit
// fails the task with the end of the log, and no agent is started.
func TestAttemptSetupFails(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.run("r_setup", func(m *model.RunMeta) { m.Settings.Setup = "echo building; echo oops >&2; exit 3" })
	e.gates.block("turn-002")
	e.play(r, func() { e.add(r, 1, "Build it", true) }, nil)
	r.startEngine()
	engTask(t, r, "T01", model.TaskFailed)
	a := r.engLast(t, "T01")
	if a.Error != "the setup command failed (exit 3). Its last output:\nbuilding\noops" || a.SetupDone || a.Worktree != "" {
		t.Errorf("attempt: %+v", a)
	}
	if b, err := os.ReadFile(setupLogPath(r.dir, "T01", 1)); err != nil || string(b) != "building\noops\n" {
		t.Errorf("the setup log: %q, %v", b, err)
	}
	if len(e.host.sent("T01-work")) != 0 {
		t.Error("an agent was started after a failed setup")
	}
	if _, ok := r.engAgentNamed("T01-work"); ok {
		t.Error("an agent record was made after a failed setup")
	}
	if engExists(filepath.Join(e.s.Store.P.RunWorkDir(r.id), "T01")) {
		t.Error("the checkout of the failed task is still there")
	}
	engUntil(t, "the event", func() bool { ts := r.engTurns(); return len(ts) == 2 && len(ts[1].WokenBy) == 1 })
	if ev := r.engTurns()[1].WokenBy[0]; ev.Type != "task_failed" || ev.Text != a.Error {
		t.Errorf("event: %+v", ev)
	}
}

// engSleepMark is a number of seconds no other process sleeps for: n with this test process's id
// as its fraction. The tests look for their setup command by it with pgrep, and several test
// processes of this package can run on one machine at once.
func engSleepMark(n int) string { return fmt.Sprintf("%d.%d", n, os.Getpid()) }

// engSleeping reports whether the sleep itself runs: the shell that will start it has the same
// words in its command line, before it has run what stands in front of the sleep.
func engSleeping(marker string) bool {
	out, _ := exec.Command("pgrep", "-f", "^sleep "+regexp.QuoteMeta(marker)+"$").Output()
	return strings.TrimSpace(string(out)) != ""
}

// A setup command that runs is ended by a cancel and by a stop; after a stop the next start
// runs it again from its beginning (it is recorded as done only when it has ended).
func TestAttemptSetupCancelledAndRunAgain(t *testing.T) {
	t.Parallel()
	// Cancelled.
	e := newEngEnv(t, true)
	r := e.run("r_setupc", func(m *model.RunMeta) { m.Settings.Setup = "sleep " + engSleepMark(3217) })
	e.gates.block("turn-002")
	e.play(r, func() { e.add(r, 1, "Build it", false) }, nil)
	r.startEngine()
	engTask(t, r, "T01", model.TaskSetup)
	engUntil(t, "the setup command", func() bool { return engSleeping(engSleepMark(3217)) })
	if got := r.cancelActive("T01", model.AttemptCancel{Reason: "too slow", Turn: 1}); got != "" {
		t.Fatalf("cancelActive: %q", got)
	}
	if engSleeping(engSleepMark(3217)) {
		exec.Command("pkill", "-f", "sleep "+engSleepMark(3217)).Run()
		t.Fatal("the cancelled setup command still runs")
	}
	a := r.engLast(t, "T01")
	if a.Outcome != model.TaskCancelled || a.Cancel == nil || a.Cancel.Reason != "too slow" || a.SetupDone || a.Worktree != "" {
		t.Errorf("attempt: %+v", a)
	}
	if engExists(filepath.Join(e.s.Store.P.RunWorkDir(r.id), "T01")) {
		t.Error("the checkout of the cancelled task is still there")
	}
	r.stopEngine(10 * time.Second)

	// Stopped, then run again.
	e = newEngEnv(t, true)
	out, gofile := filepath.Join(t.TempDir(), "runs.txt"), filepath.Join(t.TempDir(), "go")
	r = e.run("r_setups", func(m *model.RunMeta) {
		m.Settings.Setup = fmt.Sprintf("echo ran >> %s; test -f %s || sleep %s", out, gofile, engSleepMark(3218))
	})
	e.gates.block("turn-002")
	e.play(r, func() { e.add(r, 1, "Build it", true) }, nil)
	r.startEngine()
	engUntil(t, "the setup command", func() bool { return engSleeping(engSleepMark(3218)) })
	if err := r.halt(Halting{Status: model.RunStopped, Stop: model.StopUser}); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunStopped)
	if engSleeping(engSleepMark(3218)) {
		exec.Command("pkill", "-f", "sleep "+engSleepMark(3218)).Run()
		t.Fatal("the stopped setup command still runs")
	}
	if a := r.engLast(t, "T01"); a.SetupDone || a.Outcome != "" || a.Worktree == "" || r.engTaskState("T01") != model.TaskSetup {
		t.Errorf("the attempt of a run stopped in its setup: %+v", a)
	}
	engWrite(t, filepath.Dir(gofile), "go", "")
	if err := r.resume(); err != nil {
		t.Fatal(err)
	}
	engTask(t, r, "T01", model.TaskDone)
	if b, _ := os.ReadFile(out); string(b) != "ran\nran\n" {
		t.Errorf("the setup command ran %q", b)
	}
}

// A failed writing task leaves its unfinished work on its branch, unmerged, and its checkout is
// removed. A retry starts from the integration branch on a branch of its own.
func TestAttemptDiscardKeepsUnfinishedWork(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.run("r_discard", func(m *model.RunMeta) { m.Settings.Wake = "idle" })
	e.gates.block("turn-002", "T01-a2-work")
	e.play(r, func() { e.add(r, 1, "Half a job", true) }, func(m *engMsg) bool {
		switch m.Name {
		case "T01-work":
			engWrite(t, m.Cwd, "half.txt", "half done\n")
			m.Block("failed", "Could not finish.", "why")
			return true
		case "turn-002":
			e.retry(r, 2, "T01")
		case "T01-a2-work":
			engWrite(t, m.Cwd, "whole.txt", "all done\n")
		}
		return false
	})
	r.startEngine()
	engTask(t, r, "T01", model.TaskFailed)
	a := r.engLast(t, "T01")
	if a.Error != "its agent reported that it could not do the task: Could not finish." || a.Worktree != "" || a.Head != "" || a.Merged != "" {
		t.Errorf("attempt: %+v", a)
	}
	if ph := strings.TrimSpace(kinds(a.Phases)); ph != "held slot setup work" {
		t.Errorf("a failed writing task entered phase merge: %s", ph)
	}
	if got := e.repo.Git("log", "--format=%s", "-1", "aiwb/r_discard/T01"); got != "T01: unfinished work (Half a job)" {
		t.Errorf("the branch of the failed task: %q", got)
	}
	if got := e.repo.Git("show", "aiwb/r_discard/T01:half.txt"); got != "half done" {
		t.Errorf("the unfinished work: %q", got)
	}
	g := r.engGit()
	if got := e.repo.Git("rev-parse", "aiwb/r_discard/integration"); got != g.BaseRef {
		t.Error("a failed task changed the integration branch")
	}
	if engExists(filepath.Join(e.s.Store.P.RunWorkDir(r.id), "T01")) {
		t.Error("the checkout of the failed task is still there")
	}

	// The retry: attempt 2 has its own names and does not see the unfinished work.
	e.gates.open("turn-002")
	engTask(t, r, "T01", model.TaskWork)
	engUntil(t, "the second attempt's agent", func() bool { return len(e.host.sent("T01-a2-work")) == 1 })
	m := e.host.sent("T01-a2-work")[0]
	if m.Cwd != filepath.Join(e.s.Store.P.RunWorkDir(r.id), "T01-a2") || engExists(filepath.Join(m.Cwd, "half.txt")) {
		t.Errorf("attempt 2 works in %s (half.txt there: %v)", m.Cwd, engExists(filepath.Join(m.Cwd, "half.txt")))
	}
	e.gates.open("T01-a2-work")
	engTask(t, r, "T01", model.TaskDone)
	a = r.engLast(t, "T01")
	if a.N != 2 || a.Branch != "aiwb/r_discard/T01-a2" || a.Merged == "" {
		t.Errorf("attempt 2: %+v", a)
	}
	if got := e.repo.Git("log", "--format=%s", "-1", "aiwb/r_discard/T01"); got != "T01: unfinished work (Half a job)" {
		t.Errorf("the first attempt's branch changed: %q", got)
	}
	tk, _ := r.engTask("T01")
	if tk.Attempts[0].Outcome != model.TaskFailed || tk.Attempts[0].Error == "" {
		t.Errorf("attempt 1 after the retry: %+v", tk.Attempts[0])
	}
}

// What an agent can leave in its checkout that a commit would get wrong: another branch, a
// detached HEAD (a rebase in progress looks the same), and unmerged paths without a merge (a
// stash pop that conflicted). Each fails the task with a sentence that says what was found,
// nothing is merged, and the checkout is kept, because its work could not be committed.
func TestAttemptAgentLeavesTheTreeWrong(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		do   func(e *engEnv, dir string)
		want string
	}{
		{"another branch", func(e *engEnv, dir string) { e.git(dir, "checkout", "-q", "-b", "my-own") },
			"its agent left the work tree on branch my-own instead of on aiwb/r_wrong/T01; its work was not merged"},
		{"a detached HEAD", func(e *engEnv, dir string) { e.git(dir, "checkout", "-q", "--detach") },
			"its agent left the work tree on a detached HEAD (a rebase in progress, or a commit checked out) instead of on aiwb/r_wrong/T01; its work was not merged"},
		{"a conflicted stash pop", func(e *engEnv, dir string) {
			engWrite(e.t, dir, "f.txt", "one\nstashed\nthree\n")
			e.git(dir, "stash", "-q")
			engWrite(e.t, dir, "f.txt", "one\ncommitted\nthree\n")
			e.git(dir, "commit", "-q", "-am", "mine")
			e.repo.GitIn(dir, "stash", "pop") // conflicts
		}, "its agent left a merge or a conflict unfinished in its working directory"},
	}
	for _, c := range cases {
		e := newEngEnv(t, true)
		r := e.run("r_wrong", nil)
		e.gates.block("turn-002")
		e.play(r, func() { e.add(r, 1, "Go astray", true) }, func(m *engMsg) bool {
			if m.Name == "T01-work" {
				engWrite(t, m.Cwd, "important.txt", "the work\n")
				c.do(e, m.Cwd)
			}
			return false
		})
		r.startEngine()
		engTask(t, r, "T01", model.TaskFailed)
		a := r.engLast(t, "T01")
		wt := filepath.Join(e.s.Store.P.RunWorkDir(r.id), "T01")
		if a.Error != c.want+" Its uncommitted work is left in "+wt+"." {
			t.Errorf("%s: error %q", c.name, a.Error)
		}
		if a.Head != "" || a.Merged != "" || a.Worktree != "" {
			t.Errorf("%s: attempt %+v", c.name, a)
		}
		if !engExists(filepath.Join(wt, "important.txt")) {
			t.Errorf("%s: the checkout with the uncommitted work was removed", c.name)
		}
		g := r.engGit()
		if got := e.repo.Git("rev-parse", g.IntegrationBranch); got != g.BaseRef {
			t.Errorf("%s: the integration branch moved", c.name)
		}
		r.stopEngine(10 * time.Second)
	}
}

// keepWorktrees keeps the checkout of a finished task; the record's path is cleared all the same.
func TestAttemptKeepWorktrees(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.run("r_keep", func(m *model.RunMeta) { m.Settings.KeepWorktrees = true })
	e.gates.block("turn-002")
	e.play(r, func() { e.add(r, 1, "Add a file", true) }, func(m *engMsg) bool {
		if m.Name == "T01-work" {
			engWrite(t, m.Cwd, "a.txt", "x\n")
		}
		return false
	})
	r.startEngine()
	engTask(t, r, "T01", model.TaskDone)
	if a := r.engLast(t, "T01"); a.Worktree != "" || a.Merged == "" {
		t.Errorf("attempt: %+v", a)
	}
	if !engExists(filepath.Join(e.s.Store.P.RunWorkDir(r.id), "T01", "a.txt")) {
		t.Error("the checkout was removed although the run keeps its work trees")
	}
}

// A task's agent works in the folder the run was started in, when that is below the
// repository's top level; the orchestrator and git work at the top.
func TestAttemptSubFolder(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	e.repo.Write("services/api/main.go", "package main\n")
	e.repo.Commit("a sub folder")
	r := e.draft("r_sub")
	r.meta.Cwd = filepath.Join(e.repo.Dir(), "services", "api")
	e.s.remove("r_sub")
	e.cwd = e.repo.Dir()
	r = e.run("r_sub", func(m *model.RunMeta) { m.Cwd = filepath.Join(e.repo.Dir(), "services", "api") })
	e.must(r, KOp, func(tx *Tx) error { tx.State().Git.Sub = "services/api"; return nil })
	e.gates.block("turn-002")
	e.play(r, func() { e.add(r, 1, "Change the api", true) }, func(m *engMsg) bool {
		if m.Name == "T01-work" {
			engWrite(t, m.Cwd, "new.go", "package main\n")
		}
		return false
	})
	r.startEngine()
	engTask(t, r, "T01", model.TaskDone)
	work := e.s.Store.P.RunWorkDir(r.id)
	if m := e.host.sent("T01-work")[0]; m.Cwd != filepath.Join(work, "T01", "services", "api") ||
		!strings.Contains(m.Text, "Your working directory is the folder `services/api` of a git worktree made for this task") || !strings.Contains(m.Text, "- Work only inside your worktree.") {
		t.Errorf("the task agent worked in %s", m.Cwd)
	}
	if m := e.host.sent("turn-001")[0]; m.Cwd != filepath.Join(work, "orch") || !strings.Contains(m.Text, "The run was started in its folder `services/api`: every task's agent starts in that folder of its own checkout") {
		t.Errorf("the orchestrator worked in %s", m.Cwd)
	}
	if got := e.repo.Git("show", "aiwb/r_sub/integration:services/api/new.go"); got != "package main" {
		t.Errorf("the work in the sub folder was not merged: %q", got)
	}
}

// A writing task that changes nothing is done without a merge, and one whose agent committed by
// itself has that commit taken as its head.
func TestAttemptNoChangeAndOwnCommit(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.run("r_nochange", func(m *model.RunMeta) { m.Settings.Wake = "idle" })
	e.gates.block("turn-002")
	e.play(r, func() {
		e.add(r, 1, "Change nothing", true)
		e.add(r, 1, "Commit it myself", true)
	}, func(m *engMsg) bool {
		if m.Name == "T02-work" {
			engWrite(t, m.Cwd, "mine.txt", "committed by the agent\n")
			e.git(m.Cwd, "add", "-A")
			e.git(m.Cwd, "commit", "-q", "-m", "my own commit")
		}
		return false
	})
	r.startEngine()
	engTask(t, r, "T01", model.TaskDone)
	engTask(t, r, "T02", model.TaskDone)
	g := r.engGit()
	a := r.engLast(t, "T01")
	if a.Head != a.Base || a.Merged != "" || a.MergedAt != 0 || strings.TrimSpace(kinds(a.Phases)) != "held slot setup work merge" {
		t.Errorf("the task that changed nothing: %+v", a)
	}
	if c, err := readChanges(r.dir, "T01", 1); err != nil || len(c.Files) != 0 || len(c.Commits) != 0 || c.Head != a.Base {
		t.Errorf("its changes: %+v, %v", c, err)
	}
	b := r.engLast(t, "T02")
	if b.Head == b.Base || b.Merged == "" || e.repo.Git("log", "--format=%s", "-1", b.Head) != "my own commit" {
		t.Errorf("the task whose agent committed: %+v", b)
	}
	if got := e.repo.Git("log", "--format=%s", "--first-parent", g.IntegrationBranch); got != "Merge T02: Commit it myself\nfirst" {
		t.Errorf("the integration branch: %q", got)
	}
	if got := e.fileOn(g.IntegrationBranch, "mine.txt"); got != "committed by the agent" {
		t.Errorf("mine.txt: %q", got)
	}
}
