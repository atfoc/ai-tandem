package rungit

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestEnsureWorktree(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	main := git(t, root, "rev-parse", "HEAD")

	// A new branch at base.
	task := sibling(root, "task")
	must(t, r.EnsureWorktree(bg, task, "runs/x/T01", "main"))
	if got := git(t, task, "symbolic-ref", "HEAD"); got != "refs/heads/runs/x/T01" {
		t.Errorf("the work tree is on %s", got)
	}
	if got := git(t, task, "rev-parse", "HEAD"); got != main {
		t.Errorf("the new branch is at %s, want the base %s", got, main)
	}
	if got, err := r.Branch(bg, task); err != nil || got != "runs/x/T01" {
		t.Errorf("Branch() = %q, %v", got, err)
	}
	if up, _, _ := runGit(bg, gitEnv(hermetic), task, "rev-parse", "--abbrev-ref", "@{upstream}"); up != "" {
		t.Errorf("the new branch tracks %s", up)
	}

	// Detached at base.
	scratch := sibling(root, "scratch")
	must(t, r.EnsureWorktree(bg, scratch, "", "main"))
	if got, err := r.Branch(bg, scratch); err != nil || got != "" {
		t.Errorf("Branch() of a detached work tree = %q, %v", got, err)
	}
	if got := git(t, scratch, "rev-parse", "HEAD"); got != main {
		t.Errorf("the detached work tree is at %s", got)
	}

	// An existing branch is checked out where it is; base is not used.
	write(t, task, "t.txt", "t\n")
	taskHead, err := r.CommitAll(bg, task, "T01: work")
	must(t, err)
	must(t, r.RemoveWorktree(bg, task))
	must(t, r.EnsureWorktree(bg, task, "runs/x/T01", "main"))
	if got := git(t, task, "rev-parse", "HEAD"); got != taskHead {
		t.Errorf("the existing branch was checked out at %s, want %s", got, taskHead)
	}

	// Idempotent: a second call leaves the work tree as it is, uncommitted work included.
	write(t, task, "wip.txt", "wip\n")
	write(t, scratch, "wip.txt", "wip\n")
	must(t, r.EnsureWorktree(bg, task, "runs/x/T01", "main"))
	must(t, r.EnsureWorktree(bg, scratch, "", "main"))
	if read(t, task, "wip.txt") != "wip\n" || read(t, scratch, "wip.txt") != "wip\n" {
		t.Errorf("a second call changed the work tree")
	}

	// An unknown base is an error with git's text.
	var ge *Error
	if err := r.EnsureWorktree(bg, sibling(root, "bad"), "runs/x/bad", "no-such-ref"); !errors.As(err, &ge) ||
		ge.Cmd != "worktree add" || ge.Output == "" {
		t.Errorf("an unknown base = %v, want the error of git worktree add", err)
	}
}

func TestEnsureWorktreeAfterTheFolderWasDeleted(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	task, other := sibling(root, "task"), sibling(root, "other")
	must(t, r.EnsureWorktree(bg, task, "task", "main"))
	must(t, r.EnsureWorktree(bg, other, "other", "main"))
	write(t, task, "t.txt", "t\n")
	head, err := r.CommitAll(bg, task, "work")
	must(t, err)

	must(t, os.RemoveAll(task))
	must(t, os.RemoveAll(other))
	must(t, r.EnsureWorktree(bg, task, "task", "main"))
	if got := git(t, task, "rev-parse", "HEAD"); got != head {
		t.Errorf("the work tree came back at %s, want the branch's head %s", got, head)
	}
	// Only the record that was in the way is gone: the one of the other deleted work tree stays.
	if list := git(t, root, "worktree", "list", "--porcelain"); !strings.Contains(list, "branch refs/heads/other") {
		t.Errorf("the record of a work tree nobody asked about was pruned:\n%s", list)
	}

	// The branch is still held by the record of a deleted work tree at another path.
	must(t, os.RemoveAll(task))
	moved := sibling(root, "moved")
	must(t, r.EnsureWorktree(bg, moved, "task", "main"))
	if got := git(t, moved, "rev-parse", "HEAD"); got != head {
		t.Errorf("the branch was checked out at %s, want %s", got, head)
	}
	// A detached one, deleted by hand.
	scratch := sibling(root, "scratch")
	must(t, r.EnsureWorktree(bg, scratch, "", "main"))
	must(t, os.RemoveAll(scratch))
	must(t, r.EnsureWorktree(bg, scratch, "", "task"))
	if got := git(t, scratch, "rev-parse", "HEAD"); got != head {
		t.Errorf("the detached work tree came back at %s, want %s", got, head)
	}
}

func TestEnsureWorktreeRefusesWhatIsNotIt(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	task := sibling(root, "task")
	must(t, r.EnsureWorktree(bg, task, "task", "main"))
	scratch := sibling(root, "scratch")
	must(t, r.EnsureWorktree(bg, scratch, "", "main"))
	_, foreign := newRepo(t)
	fake := sibling(root, "fake")
	must(t, os.MkdirAll(filepath.Join(fake, ".git"), 0o755))

	for what, c := range map[string]struct{ path, branch string }{
		"another branch":           {task, "other"},
		"a branch, want detached":  {task, ""},
		"detached, want a branch":  {scratch, "task2"},
		"another repository":       {foreign, "main"},
		"another repository, det.": {foreign, ""},
		"a folder with a .git/":    {fake, "x"},
	} {
		if err := r.EnsureWorktree(bg, c.path, c.branch, "main"); !errors.Is(err, ErrWorktreeMismatch) {
			t.Errorf("%s: %v, want ErrWorktreeMismatch", what, err)
		}
	}
	if got, _ := r.Branches(bg, ""); strings.Join(got, " ") != "main task" {
		t.Errorf("a refused call left a branch: %v", got)
	}
	// A branch that is checked out elsewhere cannot be checked out twice.
	var ge *Error
	if err := r.EnsureWorktree(bg, sibling(root, "twice"), "task", "main"); !errors.As(err, &ge) {
		t.Errorf("a branch checked out twice = %v, want a git error", err)
	}
	// A folder with files in it and no work tree is not taken over.
	full := sibling(root, "full")
	write(t, full, "keep.txt", "keep\n")
	if err := r.EnsureWorktree(bg, full, "full", "main"); !errors.As(err, &ge) {
		t.Errorf("a folder with files = %v, want a git error", err)
	}
	if read(t, full, "keep.txt") != "keep\n" {
		t.Errorf("the folder was touched")
	}
}

func TestEnsureWorktreeConcurrently(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	const n = 20
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Each goroutine opens the repository by itself, as several runs would.
			rr, err := Open(bg, root, WithEnv(hermetic...))
			if err != nil {
				errs[i] = err
				return
			}
			branch := ""
			if i%4 != 0 {
				branch = fmt.Sprintf("runs/c/T%02d", i)
			}
			errs[i] = rr.EnsureWorktree(bg, sibling(root, fmt.Sprintf("T%02d", i)), branch, "main")
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("work tree %d: %v", i, err)
		}
	}
	if got := strings.Count(git(t, root, "worktree", "list", "--porcelain"), "worktree "); got != n+1 {
		t.Errorf("%d work trees on record, want %d", got, n+1)
	}
	// And all removed at once.
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = r.RemoveWorktree(bg, sibling(root, fmt.Sprintf("T%02d", i)))
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("remove work tree %d: %v", i, err)
		}
	}
	if got := strings.Count(git(t, root, "worktree", "list", "--porcelain"), "worktree "); got != 1 {
		t.Errorf("%d work trees on record after removing, want 1", got)
	}
}

func TestRemoveWorktree(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	task := sibling(root, "task")
	must(t, r.EnsureWorktree(bg, task, "task", "main"))
	write(t, task, "f.txt", "uncommitted\n")
	write(t, task, "untracked.txt", "x\n")

	must(t, r.RemoveWorktree(bg, task))
	if exists(task) {
		t.Errorf("the folder is still there")
	}
	if ok, _ := r.BranchExists(bg, "task"); !ok {
		t.Errorf("the branch went with the work tree")
	}
	must(t, r.RemoveWorktree(bg, task)) // already gone
	must(t, r.RemoveWorktree(bg, sibling(root, "never-was")))

	// Deleted by hand: the record goes.
	must(t, r.EnsureWorktree(bg, task, "task", "main"))
	must(t, os.RemoveAll(task))
	must(t, r.RemoveWorktree(bg, task))
	if list := git(t, root, "worktree", "list", "--porcelain"); strings.Contains(list, "refs/heads/task") {
		t.Errorf("the record is still there:\n%s", list)
	}

	// What is not a linked work tree of this repository is left alone.
	if err := r.RemoveWorktree(bg, root); !errors.Is(err, ErrWorktreeMismatch) {
		t.Errorf("removing the main work tree = %v, want ErrWorktreeMismatch", err)
	}
	plain := t.TempDir()
	write(t, plain, "keep.txt", "keep\n")
	if err := r.RemoveWorktree(bg, plain); !errors.Is(err, ErrNotWorktree) {
		t.Errorf("removing a plain folder = %v, want ErrNotWorktree", err)
	}
	if read(t, plain, "keep.txt") != "keep\n" || read(t, root, "f.txt") != "one\ntwo\nthree\n" {
		t.Errorf("something was removed")
	}
}

// The bookkeeping lock is also a flock in the shared git dir, for other processes.
func TestWorktreeLockAcrossProcesses(t *testing.T) {
	r, root := newRepo(t)
	// Another holder: flock belongs to the open file, so a second open in this process stands in
	// for another process.
	f, err := os.OpenFile(filepath.Join(r.CommonDir(), lockFile), os.O_CREATE|os.O_RDWR, 0o644)
	must(t, err)
	defer f.Close()
	must(t, syscall.Flock(int(f.Fd()), syscall.LOCK_EX))

	ctx, cancel := context.WithTimeout(bg, 300*time.Millisecond)
	defer cancel()
	wt := sibling(root, "wt")
	if err := r.EnsureWorktree(ctx, wt, "b", "main"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("EnsureWorktree while the lock is held elsewhere = %v, want the context's error", err)
	}
	if exists(wt) {
		t.Fatalf("the work tree was made without the lock")
	}
	done := make(chan error, 1)
	go func() { done <- r.EnsureWorktree(bg, wt, "b", "main") }()
	select {
	case err := <-done:
		t.Fatalf("EnsureWorktree did not wait for the lock: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	must(t, syscall.Flock(int(f.Fd()), syscall.LOCK_UN))
	must(t, <-done)
	must(t, r.RemoveWorktree(bg, wt))
}

func TestResetDetached(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	write(t, root, ".gitignore", "ignored/\n")
	write(t, root, "dir/tracked.txt", "tracked\n")
	_, err := r.CommitAll(bg, root, "more")
	must(t, err)
	intDir, orch := sibling(root, "integration"), sibling(root, "orchestrator")
	must(t, r.EnsureWorktree(bg, intDir, "int", "main"))
	must(t, r.EnsureWorktree(bg, orch, "", "int"))

	// Integration moves; the orchestrator's checkout is messed up.
	write(t, intDir, "new.txt", "new\n")
	intHead, err := r.CommitAll(bg, intDir, "T01: new")
	must(t, err)
	write(t, orch, "f.txt", "edited\n")
	write(t, orch, "untracked.txt", "x\n")
	write(t, orch, "junk/deep/file", "x\n")
	write(t, orch, "ignored/cache", "cache\n")
	must(t, os.Remove(filepath.Join(orch, "dir", "tracked.txt")))
	git(t, orch, "add", "-A")

	must(t, r.ResetDetached(bg, orch, "int"))
	if got := git(t, orch, "rev-parse", "HEAD"); got != intHead {
		t.Errorf("HEAD is %s, want integration's %s", got, intHead)
	}
	if got, _ := r.Branch(bg, orch); got != "" {
		t.Errorf("HEAD is on branch %s, want detached", got)
	}
	if got := git(t, orch, "status", "--porcelain"); got != "" {
		t.Errorf("the work tree is not clean: %q", got)
	}
	if read(t, orch, "f.txt") != "one\ntwo\nthree\n" || read(t, orch, "dir/tracked.txt") != "tracked\n" || read(t, orch, "new.txt") != "new\n" {
		t.Errorf("the tracked files are not integration's")
	}
	if exists(filepath.Join(orch, "untracked.txt")) || exists(filepath.Join(orch, "junk")) {
		t.Errorf("untracked files are still there")
	}
	if read(t, orch, "ignored/cache") != "cache\n" {
		t.Errorf("an ignored file was removed")
	}

	// A merge in progress goes too.
	write(t, intDir, "f.txt", "one\nINT\nthree\n")
	_, err = r.CommitAll(bg, intDir, "int side")
	must(t, err)
	write(t, orch, "f.txt", "one\nORCH\nthree\n")
	git(t, orch, "commit", "-q", "-am", "orch side")
	if res, err := r.Merge(bg, orch, "int", "", false); err != nil || res.Merged {
		t.Fatalf("the merge should conflict: %+v, %v", res, err)
	}
	must(t, r.ResetDetached(bg, orch, "int"))
	if m, _ := r.Merging(bg, orch); m || read(t, orch, "f.txt") != "one\nINT\nthree\n" {
		t.Errorf("the merge in progress survived the reset")
	}

	// Never the main work tree, and the integration branch did not move.
	if err := r.ResetDetached(bg, root, "int"); !errors.Is(err, ErrWorktreeMismatch) {
		t.Errorf("ResetDetached of the main work tree = %v, want ErrWorktreeMismatch", err)
	}
	if got := git(t, root, "symbolic-ref", "HEAD"); got != "refs/heads/main" {
		t.Errorf("the main work tree is at %s", got)
	}
	if err := r.ResetDetached(bg, orch, "no-such-ref"); err == nil {
		t.Errorf("an unknown ref is not an error")
	}
}

// T39's finding 5: a git worktree add that is killed during its checkout leaves the work tree
// locked, and git removes no locked one. The lock of the unfinished add is taken off; one that
// somebody set is not.
func TestRemoveWorktreeLeftLocked(t *testing.T) {
	t.Parallel()
	listed := func(t *testing.T, root, path string) bool {
		t.Helper()
		return strings.Contains(git(t, root, "worktree", "list", "--porcelain")+"\n", "worktree "+resolve(path)+"\n")
	}
	t.Run("by a killed git worktree add", func(t *testing.T) {
		t.Parallel()
		root := slowRepo(t)
		r := open(t, root)
		wt := sibling(root, "r1/int")
		killedWorktreeAdd(t, root, wt)
		if err := r.RemoveWorktree(bg, wt); err != nil {
			t.Fatalf("RemoveWorktree: %v", err)
		}
		if exists(wt) || listed(t, root, wt) {
			t.Errorf("the work tree is still there:\n%s", git(t, root, "worktree", "list", "--porcelain"))
		}
	})
	t.Run("by a killed git worktree add, and the folder was deleted", func(t *testing.T) {
		t.Parallel()
		root := slowRepo(t)
		r := open(t, root)
		wt := sibling(root, "r1/int")
		killedWorktreeAdd(t, root, wt)
		must(t, os.RemoveAll(wt))
		must(t, r.EnsureWorktree(bg, wt, "aiwb/r1/integration", "HEAD"))
		if got := git(t, wt, "rev-parse", "--abbrev-ref", "HEAD"); got != "aiwb/r1/integration" {
			t.Errorf("the work tree is on %q", got)
		}
		if list := git(t, root, "worktree", "list", "--porcelain"); strings.Contains(list, "locked") {
			t.Errorf("a locked record is left:\n%s", list)
		}
	})
	t.Run("on purpose", func(t *testing.T) {
		t.Parallel()
		for _, reason := range []string{"", "mine", "initializing my experiment", "not initializing"} {
			r, root := newRepo(t)
			wt := sibling(root, "theirs")
			must(t, r.EnsureWorktree(bg, wt, "", "HEAD"))
			write(t, wt, "work.txt", "work\n")
			lock := []string{"worktree", "lock", wt}
			if reason != "" {
				lock = []string{"worktree", "lock", "--reason", reason, wt}
			}
			git(t, root, lock...)
			var ge *Error
			if err := r.RemoveWorktree(bg, wt); !errors.As(err, &ge) || !strings.Contains(ge.Output, "locked") {
				t.Errorf("reason %q: RemoveWorktree = %v, want git's refusal", reason, err)
			}
			if read(t, wt, "work.txt") != "work\n" || !listed(t, root, wt) {
				t.Errorf("reason %q: the locked work tree was touched", reason)
			}
			if list := git(t, root, "worktree", "list", "--porcelain"); !strings.Contains(list, "\nlocked") {
				t.Errorf("reason %q: the lock is gone:\n%s", reason, list)
			}
			// With its folder gone the record is still not dropped.
			must(t, os.RemoveAll(wt))
			if err := r.EnsureWorktree(bg, wt, "", "HEAD"); !errors.As(err, &ge) || !strings.Contains(ge.Output, "locked") {
				t.Errorf("reason %q: EnsureWorktree over the locked record = %v, want git's refusal", reason, err)
			}
		}
	})
}
