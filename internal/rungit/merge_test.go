package rungit

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// hook installs a hook for the repository (hooks are shared by all its work trees).
func hook(t *testing.T, r *Repo, name, script string) {
	t.Helper()
	path := filepath.Join(r.CommonDir(), "hooks", name)
	must(t, os.MkdirAll(filepath.Dir(path), 0o755))
	must(t, os.WriteFile(path, []byte("#!/bin/sh\n"+script+"\n"), 0o755))
}

// state is everything about a work tree that a refused operation must leave alone.
func state(t *testing.T, dir string, files ...string) string {
	t.Helper()
	s := git(t, dir, "rev-parse", "HEAD") + "\n" + git(t, dir, "status", "--porcelain") + "\n" +
		git(t, dir, "ls-files", "--stage") + "\n"
	mergeHead := absIn(dir, git(t, dir, "rev-parse", "--git-path", "MERGE_HEAD"))
	if b, err := os.ReadFile(mergeHead); err == nil {
		s += "merging " + string(b)
	}
	for _, f := range files {
		s += "\n" + f + ":\n" + read(t, dir, f)
	}
	return s
}

func parents(t *testing.T, dir, rev string) int {
	t.Helper()
	return len(strings.Fields(git(t, dir, "rev-list", "--parents", "-1", rev))) - 1
}

// hasMarkers reports whether text has a conflict-marker line.
func hasMarkers(text string) bool {
	marks, _ := findMarkers(strings.NewReader(text))
	return len(marks) > 0
}

func TestCommitAll(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	wt := sibling(root, "task")
	must(t, r.EnsureWorktree(bg, wt, "task", "main"))
	base := git(t, wt, "rev-parse", "HEAD")

	// Nothing to commit: the head as it is.
	if head, err := r.CommitAll(bg, wt, "T01: nothing"); err != nil || head != base {
		t.Fatalf("nothing to commit: %s, %v, want %s", head, err, base)
	}

	// A new, a changed and a deleted file in one commit.
	write(t, wt, "keep.txt", "keep\n")
	write(t, wt, "gone.txt", "gone\n")
	first, err := r.CommitAll(bg, wt, "T01: first")
	must(t, err)
	if first == base || git(t, wt, "rev-parse", "HEAD") != first {
		t.Fatalf("the head after a commit is %s (was %s)", first, base)
	}
	write(t, wt, "new/deep.txt", "new\n")
	write(t, wt, "f.txt", "one\nchanged\nthree\n")
	must(t, os.Remove(filepath.Join(wt, "gone.txt")))
	second, err := r.CommitAll(bg, wt, "T01: second")
	must(t, err)
	if got := git(t, wt, "show", "--name-status", "--format=%s|%an|%ae", second); got !=
		"T01: second|Tester|tester@example.com\n\nM\tf.txt\nD\tgone.txt\nA\tnew/deep.txt" {
		t.Errorf("the commit is:\n%s", got)
	}
	if got := git(t, wt, "status", "--porcelain"); got != "" {
		t.Errorf("something is left: %q", got)
	}
	if got := git(t, wt, "rev-parse", "task"); got != second {
		t.Errorf("the commit is not on the branch")
	}

	// The agent committed by itself: nothing is left, and its head is returned.
	write(t, wt, "own.txt", "own\n")
	git(t, wt, "add", "-A")
	git(t, wt, "commit", "-q", "-m", "the agent's own commit")
	own := git(t, wt, "rev-parse", "HEAD")
	if head, err := r.CommitAll(bg, wt, "T01: third"); err != nil || head != own {
		t.Errorf("after the agent's commit: %s, %v, want %s", head, err, own)
	}
	if got := git(t, wt, "log", "--format=%s", "-1"); got != "the agent's own commit" {
		t.Errorf("an extra commit was made: %s", got)
	}
	if _, err := r.CommitAll(bg, wt, ""); err == nil {
		t.Errorf("an empty message is not an error")
	}
}

func TestCommitAllWhenAHookRefuses(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	ran := filepath.Join(t.TempDir(), "ran")
	hook(t, r, "pre-commit", "echo ran >> "+ran+"\necho the hook says no >&2\nexit 1")
	write(t, root, "g.txt", "g\n")
	before := git(t, root, "rev-parse", "HEAD")
	head, err := r.CommitAll(bg, root, "despite the hook")
	must(t, err)
	if head == before || git(t, root, "log", "--format=%s", "-1") != "despite the hook" {
		t.Errorf("the commit was not made")
	}
	if !exists(ran) {
		t.Errorf("the hook was never tried")
	}
	// A commit-msg hook too.
	hook(t, r, "commit-msg", "exit 1")
	write(t, root, "h.txt", "h\n")
	if h, err := r.CommitAll(bg, root, "despite both"); err != nil || h == head {
		t.Errorf("with a commit-msg hook: %s, %v", h, err)
	}
}

func TestCommitAllFallbackIdentity(t *testing.T) {
	t.Parallel()
	dir := initRepo(t, false) // no user.name, no user.email, and no global config
	write(t, dir, "f.txt", "one\n")
	git(t, dir, "add", "-A")
	git(t, dir, "-c", "user.name=First", "-c", "user.email=first@example.com", "commit", "-q", "-m", "init")

	r := open(t, dir)
	write(t, dir, "g.txt", "g\n")
	_, err := r.CommitAll(bg, dir, "by the fallback")
	must(t, err)
	if got := git(t, dir, "log", "-1", "--format=%an <%ae> %cn <%ce>"); got != "AI Whiteboard <runs@localhost> AI Whiteboard <runs@localhost>" {
		t.Errorf("the commit is by %s", got)
	}

	r, err = Open(bg, dir, WithEnv(hermetic...), WithIdentity("Runs", "runs@example.com"))
	must(t, err)
	write(t, dir, "h.txt", "h\n")
	_, err = r.CommitAll(bg, dir, "by the given one")
	must(t, err)
	if got := git(t, dir, "log", "-1", "--format=%an <%ae>"); got != "Runs <runs@example.com>" {
		t.Errorf("the commit is by %s", got)
	}

	// Only one of the two configured is not an identity: the fallback is used for both.
	git(t, dir, "config", "user.name", "Half")
	write(t, dir, "i.txt", "i\n")
	_, err = r.CommitAll(bg, dir, "half")
	must(t, err)
	if got := git(t, dir, "log", "-1", "--format=%an <%ae>"); got != "Runs <runs@example.com>" {
		t.Errorf("with only user.name the commit is by %s", got)
	}
	// Both configured: the repository's identity. A merge commit gets it the same way.
	git(t, dir, "config", "user.email", "half@example.com")
	git(t, dir, "checkout", "-q", "-b", "side", "HEAD~1")
	git(t, dir, "commit", "-q", "--allow-empty", "-m", "side work")
	git(t, dir, "checkout", "-q", "main")
	res, err := r.Merge(bg, dir, "side", "Merge side", true)
	if err != nil || !res.Merged {
		t.Fatalf("merge: %+v, %v", res, err)
	}
	if got := git(t, dir, "log", "-1", "--format=%s by %an <%ae>"); got != "Merge side by Half <half@example.com>" {
		t.Errorf("the merge commit is %s", got)
	}
}

// Signing is switched off for the package's own commits: a repository set up to sign, with a
// program that cannot sign, still gets its commit.
func TestCommitAllDoesNotSign(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	git(t, root, "checkout", "-q", "-b", "side")
	git(t, root, "commit", "-q", "--allow-empty", "-m", "side work")
	git(t, root, "checkout", "-q", "main")
	git(t, root, "config", "commit.gpgsign", "true")
	git(t, root, "config", "gpg.program", "/usr/bin/false")
	write(t, root, "g.txt", "g\n")
	if _, _, err := runGit(bg, gitEnv(hermetic), root, "commit", "-q", "--allow-empty", "-m", "signed"); err == nil {
		t.Fatal("the repository is not set up so that signing fails")
	}
	if _, err := r.CommitAll(bg, root, "unsigned"); err != nil {
		t.Fatal(err)
	}
	res, err := r.Merge(bg, root, "side", "Merge side", true)
	if err != nil || !res.Merged || parents(t, root, "HEAD") != 2 {
		t.Fatalf("merge: %+v, %v", res, err)
	}
}

// conflict makes the situation a run gets into: integration (branch int, in intDir) and a task
// (branch task, in taskDir, made from an older int) both changed line two of f.txt, and each added
// a file. Nothing is merged yet.
type conflict struct {
	r               *Repo
	root            string
	intDir, taskDir string
}

func newConflict(t *testing.T) conflict {
	t.Helper()
	r, root := newRepo(t)
	// As the repository of the app itself is set up: each work tree may have config of its own.
	git(t, root, "config", "extensions.worktreeConfig", "true")
	c := conflict{r: r, root: root, intDir: sibling(root, "integration"), taskDir: sibling(root, "task")}
	must(t, r.EnsureWorktree(bg, c.intDir, "int", "main"))
	must(t, r.EnsureWorktree(bg, c.taskDir, "task", "int"))
	// Another task finishes first and is merged: integration moves.
	otherDir := sibling(root, "other")
	must(t, r.EnsureWorktree(bg, otherDir, "other", "int"))
	write(t, otherDir, "f.txt", "one\nOTHER\nthree\n")
	write(t, otherDir, "other.txt", "other\n")
	_, err := r.CommitAll(bg, otherDir, "T01: other")
	must(t, err)
	res, err := r.Merge(bg, c.intDir, "other", "Merge T01: other", true)
	if err != nil || !res.Merged {
		t.Fatalf("merging the other task: %+v, %v", res, err)
	}
	must(t, r.RemoveWorktree(bg, otherDir))
	// The task's work.
	write(t, c.taskDir, "f.txt", "one\nTASK\nthree\n")
	write(t, c.taskDir, "task.txt", "task\n")
	_, err = r.CommitAll(bg, c.taskDir, "T02: task")
	must(t, err)
	return c
}

// B1, the most serious bug of the script: after a restart in the middle of a conflict resolution
// it ran commit_all in the task's work tree, which concluded the merge with the markers in the
// files, and the markers were merged into integration.
func TestCommitAllRefusesInAMerge(t *testing.T) {
	t.Parallel()
	c := newConflict(t)
	r := c.r
	res, err := r.Merge(bg, c.taskDir, "int", "Merge int into T02", false)
	if err != nil || res.Merged || !reflect.DeepEqual(res.Conflicts, []string{"f.txt"}) {
		t.Fatalf("the merge should stop on f.txt: %+v, %v", res, err)
	}
	if !hasMarkers(read(t, c.taskDir, "f.txt")) {
		t.Fatalf("f.txt has no conflict markers:\n%s", read(t, c.taskDir, "f.txt"))
	}
	before := state(t, c.taskDir, "f.txt")
	if !strings.Contains(before, "merging ") || !strings.Contains(before, "UU f.txt") {
		t.Fatalf("not the state of a conflict:\n%s", before)
	}

	// The process dies; the next one runs the script's sequence.
	r2 := open(t, c.root)
	head, err := r2.CommitAll(bg, c.taskDir, "T02: task")
	if !errors.Is(err, ErrMerging) || head != "" {
		t.Fatalf("CommitAll in a merge = %q, %v, want ErrMerging", head, err)
	}
	if after := state(t, c.taskDir, "f.txt"); after != before {
		t.Fatalf("CommitAll changed the work tree:\n%s\nwas:\n%s", after, before)
	}
	// Also when the agent had staged the file with the markers in it, which hides it from Unmerged.
	git(t, c.taskDir, "add", "f.txt")
	before = state(t, c.taskDir, "f.txt")
	if _, err := r2.CommitAll(bg, c.taskDir, "T02: task"); !errors.Is(err, ErrMerging) {
		t.Fatalf("CommitAll in a merge with everything staged = %v, want ErrMerging", err)
	}
	if after := state(t, c.taskDir, "f.txt"); after != before {
		t.Fatalf("CommitAll changed the work tree")
	}
	if _, err := r2.ConcludeMerge(bg, c.taskDir, "Merge int into T02", res.Conflicts); !errors.Is(err, ErrUnresolved) {
		t.Fatalf("ConcludeMerge with the markers staged = %v, want ErrUnresolved", err)
	}
	// So no commit of the task has the markers, and nothing reached integration.
	if hasMarkers(git(t, c.root, "show", "task:f.txt")) {
		t.Errorf("the markers were committed to the task's branch")
	}
	if ok, _ := r2.IsAncestor(bg, "task", "int"); ok {
		t.Errorf("the task reached integration")
	}
}

// Unmerged paths without a merge (a stash pop that conflicted) are not committed either.
func TestCommitAllRefusesUnmergedPaths(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	write(t, root, "f.txt", "one\nSTASHED\nthree\n")
	git(t, root, "stash", "-q")
	write(t, root, "f.txt", "one\nCOMMITTED\nthree\n")
	git(t, root, "commit", "-q", "-am", "committed")
	if _, _, err := runGit(bg, gitEnv(hermetic), root, "stash", "pop"); err == nil {
		t.Fatal("the stash pop should conflict")
	}
	if m, _ := r.Merging(bg, root); m {
		t.Fatal("a stash pop is not a merge")
	}
	before := state(t, root, "f.txt")
	if _, err := r.CommitAll(bg, root, "x"); !errors.Is(err, ErrUnmerged) || !strings.Contains(err.Error(), "f.txt") {
		t.Errorf("CommitAll = %v, want ErrUnmerged naming f.txt", err)
	}
	if after := state(t, root, "f.txt"); after != before {
		t.Errorf("CommitAll changed the work tree")
	}
}

func TestMerge(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	intDir, taskDir := sibling(root, "integration"), sibling(root, "task")
	must(t, r.EnsureWorktree(bg, intDir, "int", "main"))
	must(t, r.EnsureWorktree(bg, taskDir, "task", "int"))
	base := git(t, intDir, "rev-parse", "HEAD")
	write(t, taskDir, "task.txt", "task\n")
	taskHead, err := r.CommitAll(bg, taskDir, "T01: task")
	must(t, err)

	// A clean merge with --no-ff: a merge commit with the message, though a fast-forward was possible.
	res, err := r.Merge(bg, intDir, "task", "Merge T01: task", true)
	if err != nil || !res.Merged || len(res.Conflicts) != 0 {
		t.Fatalf("clean merge: %+v, %v", res, err)
	}
	if res.Head != git(t, intDir, "rev-parse", "HEAD") || res.Head == base || res.Head == taskHead {
		t.Errorf("Head = %s", res.Head)
	}
	if parents(t, intDir, "HEAD") != 2 || git(t, intDir, "log", "-1", "--format=%s") != "Merge T01: task" {
		t.Errorf("not a merge commit with the message: %s", git(t, intDir, "log", "-1", "--format=%p %s"))
	}
	if read(t, intDir, "task.txt") != "task\n" || git(t, intDir, "status", "--porcelain") != "" {
		t.Errorf("the merged work tree is not right")
	}
	if got := git(t, root, "rev-parse", "int"); got != res.Head {
		t.Errorf("the branch is at %s, not at the merge", got)
	}

	// Already merged: done, nothing new.
	again, err := r.Merge(bg, intDir, "task", "Merge T01: task", true)
	if err != nil || !again.Merged || again.Head != res.Head {
		t.Errorf("already merged: %+v, %v", again, err)
	}

	// Without noFF git fast-forwards when it can, and merges when it cannot.
	res, err = r.Merge(bg, taskDir, "int", "", false)
	if err != nil || !res.Merged || res.Head != again.Head {
		t.Errorf("fast-forward: %+v, %v", res, err)
	}
	write(t, taskDir, "more.txt", "more\n")
	_, err = r.CommitAll(bg, taskDir, "T01: more")
	must(t, err)
	write(t, intDir, "int.txt", "int\n")
	_, err = r.CommitAll(bg, intDir, "int moves")
	must(t, err)
	res, err = r.Merge(bg, taskDir, "int", "", false)
	if err != nil || !res.Merged || parents(t, taskDir, "HEAD") != 2 {
		t.Errorf("a real merge without noFF: %+v, %v", res, err)
	}
	if got := git(t, taskDir, "log", "-1", "--format=%s"); !strings.HasPrefix(got, "Merge branch 'int'") {
		t.Errorf("git's own message is %q", got)
	}

	// A ref that does not exist: an error with git's text, nothing changed.
	before := state(t, intDir)
	var ge *Error
	res, err = r.Merge(bg, intDir, "no-such-branch", "x", true)
	if !errors.As(err, &ge) || ge.Cmd != "merge" || ge.Output == "" || res.Merged || res.Output == "" {
		t.Errorf("unknown ref: %+v, %v", res, err)
	}
	if after := state(t, intDir); after != before {
		t.Errorf("a failed merge changed the work tree")
	}
}

func TestMergeConflicts(t *testing.T) {
	t.Parallel()
	c := newConflict(t)
	r := c.r
	before := state(t, c.intDir)

	// A content conflict: not merged, the paths, the merge left in progress.
	res, err := r.Merge(bg, c.intDir, "task", "Merge T02: task", true)
	if err != nil || res.Merged || res.Head != "" || !reflect.DeepEqual(res.Conflicts, []string{"f.txt"}) {
		t.Fatalf("content conflict: %+v, %v", res, err)
	}
	if !strings.Contains(res.Output, "f.txt") {
		t.Errorf("Output does not name the file: %q", res.Output)
	}
	if m, err := r.Merging(bg, c.intDir); err != nil || !m {
		t.Errorf("Merging() = %v, %v after a conflict", m, err)
	}
	if got, err := r.Unmerged(bg, c.intDir); err != nil || !reflect.DeepEqual(got, []string{"f.txt"}) {
		t.Errorf("Unmerged() = %v, %v", got, err)
	}
	if m, _ := r.Merging(bg, c.taskDir); m {
		t.Errorf("the other work tree is merging too")
	}
	// A second merge on top of it is refused and touches nothing.
	mid := state(t, c.intDir, "f.txt")
	if _, err := r.Merge(bg, c.intDir, "task", "x", true); !errors.Is(err, ErrMerging) {
		t.Errorf("Merge in a merge = %v, want ErrMerging", err)
	}
	if state(t, c.intDir, "f.txt") != mid {
		t.Errorf("the refused merge changed the work tree")
	}

	// Abort puts everything back; a second abort is fine.
	must(t, r.AbortMerge(bg, c.intDir))
	must(t, r.AbortMerge(bg, c.intDir))
	if after := state(t, c.intDir); after != before {
		t.Errorf("after the abort:\n%s\nwas:\n%s", after, before)
	}
	if got, _ := r.Unmerged(bg, c.intDir); len(got) != 0 {
		t.Errorf("Unmerged() = %v after the abort", got)
	}

	// A delete/modify conflict, and a binary one, next to the content conflict.
	write(t, c.intDir, "bin.dat", "int\x00\x01\x02")
	must(t, os.Remove(filepath.Join(c.intDir, "other.txt")))
	_, err = r.CommitAll(bg, c.intDir, "int: delete other.txt, add bin.dat")
	must(t, err)
	git(t, c.taskDir, "merge", "-q", "--no-edit", "-X", "ours", "int~1")
	write(t, c.taskDir, "other.txt", "other, changed by the task\n")
	write(t, c.taskDir, "bin.dat", "task\x00\x03\x04")
	_, err = r.CommitAll(bg, c.taskDir, "T02: change other.txt, add bin.dat")
	must(t, err)
	res, err = r.Merge(bg, c.taskDir, "int", "", false)
	if err != nil || res.Merged || !reflect.DeepEqual(res.Conflicts, []string{"bin.dat", "other.txt"}) {
		t.Fatalf("delete/modify and binary conflict: %+v, %v", res, err)
	}
	if !strings.Contains(res.Output, "other.txt deleted in int") {
		t.Errorf("Output does not say who deleted the file: %q", res.Output)
	}
	if m, _ := r.Merging(bg, c.taskDir); !m {
		t.Errorf("the merge is not left in progress")
	}
}

// A merge that fails for a reason other than a conflict is an error and leaves no trace (B12: the
// script went on as if it were a conflict and made a stray merge commit in the task).
func TestMergeFailureIsNotAConflict(t *testing.T) {
	t.Parallel()
	c := newConflict(t)
	r := c.r
	// Uncommitted work in integration that the merge would overwrite.
	write(t, c.intDir, "task.txt", "in the way\n")
	write(t, c.intDir, "f.txt", "one\nlocal edit\nthree\n")
	before := state(t, c.intDir, "task.txt", "f.txt")
	taskBefore := state(t, c.taskDir)

	res, err := r.Merge(bg, c.intDir, "task", "Merge T02: task", true)
	var ge *Error
	if !errors.As(err, &ge) || ge.Cmd != "merge" || ge.Code == 0 || ge.Output == "" {
		t.Fatalf("Merge = %+v, %v, want the error of git merge", res, err)
	}
	if errors.Is(err, ErrMerging) || res.Merged || len(res.Conflicts) != 0 || res.Output == "" {
		t.Errorf("the result looks like something else: %+v", res)
	}
	if m, _ := r.Merging(bg, c.intDir); m {
		t.Errorf("a merge is left in progress")
	}
	if after := state(t, c.intDir, "task.txt", "f.txt"); after != before {
		t.Errorf("the work tree changed:\n%s\nwas:\n%s", after, before)
	}
	if state(t, c.taskDir) != taskBefore {
		t.Errorf("the task's work tree changed")
	}

	// The same with the local work staged: it stays staged.
	git(t, c.intDir, "add", "-A")
	before = state(t, c.intDir, "task.txt", "f.txt")
	if res, err := r.Merge(bg, c.intDir, "task", "Merge T02: task", true); !errors.As(err, &ge) || res.Merged {
		t.Fatalf("Merge with staged work in the way = %+v, %v, want the error of git merge", res, err)
	}
	if after := state(t, c.intDir, "task.txt", "f.txt"); after != before || !strings.Contains(after, "A  task.txt") {
		t.Errorf("the staged work changed:\n%s\nwas:\n%s", after, before)
	}

	// Histories without a common commit.
	git(t, c.root, "checkout", "-q", "--orphan", "island")
	git(t, c.root, "commit", "-q", "--allow-empty", "-m", "island")
	git(t, c.root, "checkout", "-q", "-f", "main")
	must(t, r.AbortMerge(bg, c.taskDir))
	if res, err := r.Merge(bg, c.taskDir, "island", "x", true); err == nil || res.Merged {
		t.Errorf("unrelated histories: %+v, %v", res, err)
	}
	if m, _ := r.Merging(bg, c.taskDir); m || state(t, c.taskDir) != taskBefore {
		t.Errorf("the failed merge left something in the task's work tree")
	}
}

func TestMergeWhenAHookRefuses(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"pre-merge-commit", "commit-msg"} {
		t.Run(name, func(t *testing.T) {
			r, root := newRepo(t)
			intDir, taskDir := sibling(root, "integration"), sibling(root, "task")
			must(t, r.EnsureWorktree(bg, intDir, "int", "main"))
			must(t, r.EnsureWorktree(bg, taskDir, "task", "int"))
			write(t, taskDir, "task.txt", "task\n")
			_, err := r.CommitAll(bg, taskDir, "T01: task")
			must(t, err)
			ran := filepath.Join(t.TempDir(), "ran")
			hook(t, r, name, "echo ran >> "+ran+"\necho the hook says no >&2\nexit 1")

			res, err := r.Merge(bg, intDir, "task", "Merge T01: task", true)
			if err != nil || !res.Merged || res.Head != git(t, intDir, "rev-parse", "HEAD") {
				t.Fatalf("Merge = %+v, %v", res, err)
			}
			if !exists(ran) {
				t.Errorf("the hook was never tried")
			}
			if parents(t, intDir, "HEAD") != 2 || git(t, intDir, "log", "-1", "--format=%s") != "Merge T01: task" {
				t.Errorf("not the merge commit: %s", git(t, intDir, "log", "-1", "--format=%p %s"))
			}
			if m, _ := r.Merging(bg, intDir); m || git(t, intDir, "status", "--porcelain") != "" {
				t.Errorf("the merge is not concluded")
			}
			// Concluding a resolved conflict gets past the hook the same way.
			write(t, taskDir, "f.txt", "one\nTASK\nthree\n")
			_, err = r.CommitAll(bg, taskDir, "T01: more")
			must(t, err)
			write(t, intDir, "f.txt", "one\nINT\nthree\n")
			_, err = r.CommitAll(bg, intDir, "int moves")
			must(t, err)
			res, err = r.Merge(bg, taskDir, "int", "Merge int into T01", false)
			if err != nil || res.Merged {
				t.Fatalf("should conflict: %+v, %v", res, err)
			}
			write(t, taskDir, "f.txt", "one\nTASK and INT\nthree\n")
			if _, err := r.ConcludeMerge(bg, taskDir, "Merge int into T01", res.Conflicts); err != nil {
				t.Fatal(err)
			}
			if parents(t, taskDir, "HEAD") != 2 || git(t, taskDir, "log", "-1", "--format=%s") != "Merge int into T01" {
				t.Errorf("not the merge commit: %s", git(t, taskDir, "log", "-1", "--format=%p %s"))
			}
		})
	}
}

// A git command that hangs (a hook that sleeps) ends, with everything it started, when the
// context is cancelled.
func TestCancelEndsASlowGitCommand(t *testing.T) {
	r, root := newRepo(t)
	pidFile := filepath.Join(t.TempDir(), "pid")
	hook(t, r, "pre-commit", "echo $$ > "+pidFile+"\nsleep 60 &\necho $! >> "+pidFile+"\nwait")
	write(t, root, "g.txt", "g\n")

	ctx, cancel := context.WithCancel(bg)
	defer cancel()
	type result struct {
		err error
		at  time.Time
	}
	done := make(chan result, 1)
	go func() {
		_, err := r.CommitAll(ctx, root, "never")
		done <- result{err, time.Now()}
	}()
	pids := waitForPids(t, pidFile, 2)
	cancelled := time.Now()
	cancel()
	var res result
	select {
	case res = <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("CommitAll did not return after the cancel")
	}
	// A commit may be writing, so it is first left settle to finish by itself.
	if took := res.at.Sub(cancelled); took < settle || took > settle+1500*time.Millisecond {
		t.Errorf("CommitAll returned %s after the cancel", took)
	}
	if !errors.Is(res.err, context.Canceled) {
		t.Errorf("CommitAll = %v, want context.Canceled", res.err)
	}
	for _, pid := range pids {
		if !gone(pid) {
			t.Errorf("process %d of the hook is still alive", pid)
			syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	if got := git(t, root, "log", "--format=%s", "-1"); got != "init" {
		t.Errorf("a commit was made: %s", got)
	}
	// Nothing is left that blocks the next command (git removed its index lock).
	must(t, os.Remove(filepath.Join(r.CommonDir(), "hooks", "pre-commit")))
	if _, err := r.CommitAll(bg, root, "afterwards"); err != nil {
		t.Errorf("the next commit: %v", err)
	}
	// A context that is already cancelled starts nothing.
	if _, err := r.Head(ctx, root); !errors.Is(err, context.Canceled) {
		t.Errorf("Head with a cancelled context = %v", err)
	}
}

// A merge that is interrupted half way is put back: no merge is left in progress.
func TestCancelDuringAMerge(t *testing.T) {
	r, root := newRepo(t)
	intDir, taskDir := sibling(root, "integration"), sibling(root, "task")
	must(t, r.EnsureWorktree(bg, intDir, "int", "main"))
	must(t, r.EnsureWorktree(bg, taskDir, "task", "int"))
	write(t, taskDir, "task.txt", "task\n")
	_, err := r.CommitAll(bg, taskDir, "T01: task")
	must(t, err)
	before := state(t, intDir)
	pidFile := filepath.Join(t.TempDir(), "pid")
	// The hook runs when the merge is made in the index and the work tree, before its commit.
	hook(t, r, "pre-merge-commit", "echo $$ > "+pidFile+"\nsleep 60")

	ctx, cancel := context.WithCancel(bg)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := r.Merge(ctx, intDir, "task", "Merge T01: task", true)
		done <- err
	}()
	pids := waitForPids(t, pidFile, 1)
	if !exists(filepath.Join(intDir, "task.txt")) {
		t.Fatalf("the merge had not reached the work tree when the hook ran")
	}
	cancel()
	select {
	case err = <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Merge did not return after the cancel")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("Merge = %v, want context.Canceled", err)
	}
	if !gone(pids[0]) {
		t.Errorf("the hook is still alive")
		syscall.Kill(pids[0], syscall.SIGKILL)
	}
	if m, _ := r.Merging(bg, intDir); m {
		t.Errorf("a merge is left in progress")
	}
	if after := state(t, intDir); after != before || exists(filepath.Join(intDir, "task.txt")) {
		t.Errorf("the work tree is not as before the merge:\n%s", after)
	}
}

// Nothing opens an editor: with an editor that fails, every commit and merge still goes through.
func TestNoEditor(t *testing.T) {
	t.Parallel()
	c := newConflict(t)
	git(t, c.root, "config", "core.editor", "false")
	r, err := Open(bg, c.root, WithEnv(append(hermetic[:len(hermetic):len(hermetic)], "GIT_EDITOR=false")...))
	must(t, err)
	res, err := r.Merge(bg, c.taskDir, "int", "", false) // git's own message
	if err != nil || res.Merged {
		t.Fatalf("Merge = %+v, %v, want a conflict", res, err)
	}
	write(t, c.taskDir, "f.txt", "one\nTASK and OTHER\nthree\n")
	if _, err := r.ConcludeMerge(bg, c.taskDir, "", res.Conflicts); err != nil {
		t.Fatal(err)
	}
	if got := git(t, c.taskDir, "log", "-1", "--format=%s"); !strings.HasPrefix(got, "Merge branch 'int'") {
		t.Errorf("the message of the merge is %q", got)
	}
	// A merge commit with git's own message, no conflict.
	write(t, c.intDir, "more.txt", "more\n")
	_, err = r.CommitAll(bg, c.intDir, "int moves")
	must(t, err)
	if res, err := r.Merge(bg, c.intDir, "task", "", true); err != nil || !res.Merged || parents(t, c.intDir, "HEAD") != 2 {
		t.Fatalf("Merge = %+v, %v", res, err)
	}
}

// waitForPids waits until file has n process ids and returns them.
func waitForPids(t *testing.T, file string, n int) []int {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		b, _ := os.ReadFile(file)
		var pids []int
		for _, f := range strings.Fields(string(b)) {
			if pid, err := strconv.Atoi(f); err == nil {
				pids = append(pids, pid)
			}
		}
		if len(pids) >= n && strings.HasSuffix(string(b), "\n") {
			return pids
		}
	}
	t.Fatalf("%s never had %d process ids", file, n)
	return nil
}

// gone reports whether process pid has ended (kill -0 fails), giving it a moment to be reaped.
func gone(pid int) bool {
	for deadline := time.Now().Add(time.Second); ; time.Sleep(10 * time.Millisecond) {
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
	}
}
