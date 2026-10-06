package rungit

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

// The messages the engine will use (T01 §8.6).
const (
	msgTask    = "T02: task"
	msgResolve = "Merge int into T02"
	msgMerge   = "Merge T02: task"
)

// resolve is what a merge agent does in the task's work tree: it edits the conflicting files and
// stages nothing.
func resolveAsAgent(t *testing.T, c conflict) {
	t.Helper()
	write(t, c.taskDir, "f.txt", "one\nTASK and OTHER\nthree\n")
}

// checkIntegrated checks integration after the task was merged: both sides' changes, no marker,
// the three commits of the task on the branch.
func checkIntegrated(t *testing.T, c conflict) {
	t.Helper()
	for name, want := range map[string]string{
		"f.txt": "one\nTASK and OTHER\nthree\n", "other.txt": "other\n", "task.txt": "task\n",
	} {
		got := read(t, c.intDir, name)
		if got != want {
			t.Errorf("integration's %s is %q, want %q", name, got, want)
		}
		if hasMarkers(got) || hasMarkers(git(t, c.root, "show", "int:"+name)) {
			t.Errorf("integration's %s has conflict markers", name)
		}
	}
	if got := git(t, c.intDir, "status", "--porcelain"); got != "" {
		t.Errorf("integration's work tree is not clean: %q", got)
	}
	if m, _ := c.r.Merging(bg, c.intDir); m {
		t.Errorf("integration is still merging")
	}
	if ok, err := c.r.IsAncestor(bg, "task", "int"); err != nil || !ok {
		t.Errorf("the task is not in integration: %v", err)
	}
	subjects := strings.Split(git(t, c.root, "log", "--first-parent", "--format=%s", "-2", "int"), "\n")
	if !reflect.DeepEqual(subjects, []string{msgMerge, "Merge T01: other"}) {
		t.Errorf("integration's merges are %q", subjects)
	}
	if got := git(t, c.root, "log", "--format=%s", "-3", "task"); !strings.HasPrefix(got, msgResolve+"\n") || !strings.Contains(got, msgTask) {
		t.Errorf("the task's commits are %q", got)
	}
	if parents(t, c.root, "int") != 2 {
		t.Errorf("integration's head is not a merge commit")
	}
}

// The whole conflict flow of the engine (T01 §8.6), with nothing but the package's functions and
// the edit a merge agent makes.
func TestConflictFlow(t *testing.T) {
	t.Parallel()
	c := newConflict(t)
	r := c.r
	intBefore := state(t, c.intDir)

	// Step 2 and 3: nothing was left by an earlier process; the task is not merged yet.
	if m, err := r.Merging(bg, c.intDir); err != nil || m {
		t.Fatalf("Merging(integration) = %v, %v", m, err)
	}
	if ok, err := r.IsAncestor(bg, "task", "int"); err != nil || ok {
		t.Fatalf("IsAncestor(task, int) = %v, %v", ok, err)
	}
	// The task's work is committed already; CommitAll gives its head.
	head, err := r.CommitAll(bg, c.taskDir, msgTask)
	must(t, err)
	if head != git(t, c.root, "rev-parse", "task") {
		t.Fatalf("CommitAll = %s", head)
	}

	// Step 4: merge the task into integration. It conflicts.
	res, err := r.Merge(bg, c.intDir, "task", msgMerge, true)
	if err != nil || res.Merged || !reflect.DeepEqual(res.Conflicts, []string{"f.txt"}) {
		t.Fatalf("Merge(integration, task) = %+v, %v, want a conflict in f.txt", res, err)
	}
	// Step 5: integration is put back, and integration is merged into the task instead.
	must(t, r.AbortMerge(bg, c.intDir))
	if after := state(t, c.intDir); after != intBefore {
		t.Fatalf("integration is not as before the merge:\n%s", after)
	}
	res, err = r.Merge(bg, c.taskDir, "int", msgResolve, false)
	if err != nil || res.Merged || !reflect.DeepEqual(res.Conflicts, []string{"f.txt"}) {
		t.Fatalf("Merge(task, int) = %+v, %v, want a conflict in f.txt", res, err)
	}
	files := res.Conflicts // the engine stores them as task.conflicts
	if problems, err := r.ConflictProblems(bg, c.taskDir, files); err != nil || len(problems) != 1 {
		t.Fatalf("before the agent: problems = %q, %v", problems, err)
	}

	// Step 7 and 8: the merge agent resolves; the merge is concluded and the task merged.
	resolveAsAgent(t, c)
	if _, err := r.ConcludeMerge(bg, c.taskDir, msgResolve, files); err != nil {
		t.Fatal(err)
	}
	res, err = r.Merge(bg, c.intDir, "task", msgMerge, true)
	if err != nil || !res.Merged {
		t.Fatalf("the final merge = %+v, %v", res, err)
	}
	// Step 9: the engine records integration's head.
	if got, err := r.Resolve(bg, "int"); err != nil || got != res.Head {
		t.Errorf("Resolve(int) = %s, %v, want %s", got, err, res.Head)
	}
	checkIntegrated(t, c)
	must(t, r.RemoveWorktree(bg, c.taskDir))
	if ok, _ := r.BranchExists(bg, "task"); !ok {
		t.Errorf("the task's branch went with its work tree")
	}
}

// The process dies while integration is in the middle of the merge: the next one sees it, aborts
// it and does the merge again.
func TestRestartWithIntegrationMidMerge(t *testing.T) {
	t.Parallel()
	c := newConflict(t)
	intBefore := state(t, c.intDir)
	if res, err := c.r.Merge(bg, c.intDir, "task", msgMerge, true); err != nil || res.Merged {
		t.Fatalf("Merge = %+v, %v", res, err)
	}

	r := open(t, c.root) // the next process
	if m, err := r.Merging(bg, c.intDir); err != nil || !m {
		t.Fatalf("Merging(integration) = %v, %v, want true", m, err)
	}
	must(t, r.AbortMerge(bg, c.intDir))
	if after := state(t, c.intDir); after != intBefore {
		t.Fatalf("integration is not as before the merge")
	}
	if ok, _ := r.IsAncestor(bg, "task", "int"); ok {
		t.Fatalf("the task counts as merged")
	}
	if m, _ := r.Merging(bg, c.taskDir); m {
		t.Fatalf("the task's work tree is merging")
	}
	// From here it is the flow again.
	res, err := r.Merge(bg, c.intDir, "task", msgMerge, true)
	if err != nil || res.Merged {
		t.Fatalf("Merge = %+v, %v", res, err)
	}
	must(t, r.AbortMerge(bg, c.intDir))
	res, err = r.Merge(bg, c.taskDir, "int", msgResolve, false)
	if err != nil || res.Merged {
		t.Fatalf("Merge(task, int) = %+v, %v", res, err)
	}
	resolveAsAgent(t, c)
	_, err = r.ConcludeMerge(bg, c.taskDir, msgResolve, res.Conflicts)
	must(t, err)
	if res, err := r.Merge(bg, c.intDir, "task", msgMerge, true); err != nil || !res.Merged {
		t.Fatalf("the final merge = %+v, %v", res, err)
	}
	checkIntegrated(t, c)
}

// The process dies while the merge agent works in the task's work tree: the next one sees the
// merge there, does not commit, and goes on with the resolution (the place of bug B1).
func TestRestartWithTaskMidMerge(t *testing.T) {
	t.Parallel()
	c := newConflict(t)
	if res, err := c.r.Merge(bg, c.intDir, "task", msgMerge, true); err != nil || res.Merged {
		t.Fatalf("Merge = %+v, %v", res, err)
	}
	must(t, c.r.AbortMerge(bg, c.intDir))
	res, err := c.r.Merge(bg, c.taskDir, "int", msgResolve, false)
	if err != nil || res.Merged {
		t.Fatalf("Merge(task, int) = %+v, %v", res, err)
	}
	files := res.Conflicts // persisted by the engine before the agent starts
	taskHead := git(t, c.root, "rev-parse", "task")

	r := open(t, c.root) // the next process
	if m, _ := r.Merging(bg, c.intDir); m {
		t.Fatalf("integration is merging")
	}
	if ok, _ := r.IsAncestor(bg, "task", "int"); ok {
		t.Fatalf("the task counts as merged")
	}
	m, err := r.Merging(bg, c.taskDir)
	if err != nil || !m {
		t.Fatalf("Merging(task) = %v, %v, want true", m, err)
	}
	// It must not commit; and if it tried, nothing would happen.
	if _, err := r.CommitAll(bg, c.taskDir, msgTask); !errors.Is(err, ErrMerging) {
		t.Fatalf("CommitAll = %v, want ErrMerging", err)
	}
	if got := git(t, c.root, "rev-parse", "task"); got != taskHead {
		t.Fatalf("the task's branch moved")
	}
	// Nor start the merge again.
	if _, err := r.Merge(bg, c.taskDir, "int", msgResolve, false); !errors.Is(err, ErrMerging) {
		t.Fatalf("Merge = %v, want ErrMerging", err)
	}
	// The paths still unmerged can be read again, and the merge is not ready to be concluded.
	if got, err := r.Unmerged(bg, c.taskDir); err != nil || !reflect.DeepEqual(got, files) {
		t.Fatalf("Unmerged = %v, %v", got, err)
	}
	if _, err := r.ConcludeMerge(bg, c.taskDir, msgResolve, files); !errors.Is(err, ErrUnresolved) {
		t.Fatalf("ConcludeMerge before the agent is done = %v, want ErrUnresolved", err)
	}
	// The merge agent runs again and finishes.
	resolveAsAgent(t, c)
	_, err = r.ConcludeMerge(bg, c.taskDir, msgResolve, files)
	must(t, err)
	if res, err := r.Merge(bg, c.intDir, "task", msgMerge, true); err != nil || !res.Merged {
		t.Fatalf("the final merge = %+v, %v", res, err)
	}
	checkIntegrated(t, c)
}

// The process dies after the final merge and before recording it: the next one sees that the
// task's branch is in integration and merges nothing.
func TestRestartAfterTheFinalMerge(t *testing.T) {
	t.Parallel()
	c := newConflict(t)
	must(t, c.r.AbortMerge(bg, c.intDir))
	res, err := c.r.Merge(bg, c.taskDir, "int", msgResolve, false)
	if err != nil || res.Merged {
		t.Fatalf("Merge(task, int) = %+v, %v", res, err)
	}
	resolveAsAgent(t, c)
	_, err = c.r.ConcludeMerge(bg, c.taskDir, msgResolve, res.Conflicts)
	must(t, err)
	res, err = c.r.Merge(bg, c.intDir, "task", msgMerge, true)
	if err != nil || !res.Merged {
		t.Fatalf("the final merge = %+v, %v", res, err)
	}

	r := open(t, c.root) // the next process
	if m, _ := r.Merging(bg, c.intDir); m {
		t.Fatalf("integration is merging")
	}
	// run_task commits first: nothing to commit, the head is the task's.
	if head, err := r.CommitAll(bg, c.taskDir, msgTask); err != nil || head != git(t, c.root, "rev-parse", "task") {
		t.Fatalf("CommitAll = %s, %v", head, err)
	}
	if ok, err := r.IsAncestor(bg, "task", "int"); err != nil || !ok {
		t.Fatalf("IsAncestor(task, int) = %v, %v, want true", ok, err)
	}
	if got, err := r.Resolve(bg, "int"); err != nil || got != res.Head {
		t.Errorf("Resolve(int) = %s, %v, want the merge %s", got, err, res.Head)
	}
	checkIntegrated(t, c)
}

// A failed or cancelled attempt (T01 §8.7): a merge in progress is aborted, what the task left is
// committed to its branch as unfinished work, the work tree is removed.
func TestDiscardFlow(t *testing.T) {
	t.Parallel()
	c := newConflict(t)
	r := c.r
	intHead := git(t, c.root, "rev-parse", "int")
	res, err := r.Merge(bg, c.taskDir, "int", msgResolve, false)
	if err != nil || res.Merged {
		t.Fatalf("Merge(task, int) = %+v, %v", res, err)
	}
	write(t, c.taskDir, "f.txt", "half a resolution\n")
	taskHead := git(t, c.root, "rev-parse", "task")

	m, err := r.Merging(bg, c.taskDir)
	if err != nil || !m {
		t.Fatalf("Merging(task) = %v, %v", m, err)
	}
	must(t, r.AbortMerge(bg, c.taskDir))
	if got := read(t, c.taskDir, "f.txt"); got != "one\nTASK\nthree\n" {
		t.Fatalf("after the abort f.txt is %q", got)
	}
	// Nothing was left uncommitted: the head stays.
	if head, err := r.CommitAll(bg, c.taskDir, "T02: unfinished work (task)"); err != nil || head != taskHead {
		t.Fatalf("CommitAll = %s, %v, want %s", head, err, taskHead)
	}
	// Work the agent had not committed is kept.
	write(t, c.taskDir, "wip.txt", "half done\n")
	write(t, c.taskDir, "task.txt", "task, edited\n")
	head, err := r.CommitAll(bg, c.taskDir, "T02: unfinished work (task)")
	must(t, err)
	must(t, r.RemoveWorktree(bg, c.taskDir))

	if exists(c.taskDir) {
		t.Errorf("the work tree is still there")
	}
	if got := git(t, c.root, "rev-parse", "task"); got != head || head == taskHead {
		t.Errorf("the branch is at %s, want the unfinished-work commit %s", got, head)
	}
	if got := git(t, c.root, "log", "-1", "--format=%s", "task"); got != "T02: unfinished work (task)" {
		t.Errorf("the last commit of the branch is %q", got)
	}
	if got := git(t, c.root, "show", "task:wip.txt"); got != "half done" {
		t.Errorf("the unfinished work is not in the commit")
	}
	if hasMarkers(git(t, c.root, "show", "task:f.txt")) {
		t.Errorf("conflict markers were committed")
	}
	// Unmerged: integration did not move.
	if got := git(t, c.root, "rev-parse", "int"); got != intHead {
		t.Errorf("integration moved")
	}
	if ok, _ := r.IsAncestor(bg, "task", "int"); ok {
		t.Errorf("the discarded task is in integration")
	}
}
