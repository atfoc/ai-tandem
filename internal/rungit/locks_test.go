package rungit

import (
	"context"
	"errors"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/testset"
)

// runCheckout makes a checkout as a run has them: a linked work tree on a branch under ownRefs,
// made by EnsureWorktree. It returns its folder and its git dir.
func runCheckout(t *testing.T, r *Repo, root, name string) (dir, gitDir string) {
	t.Helper()
	dir = sibling(root, name)
	must(t, r.EnsureWorktree(bg, dir, "aiwb/r1/"+name, "main"))
	return dir, git(t, dir, "rev-parse", "--absolute-git-dir")
}

// leave puts a lock file where a killed git command would have left it: age ago.
func leave(t *testing.T, path string, age time.Duration) {
	t.Helper()
	must(t, os.MkdirAll(filepath.Dir(path), 0o755))
	must(t, os.WriteFile(path, nil, 0o644))
	at := time.Now().Add(-age)
	must(t, os.Chtimes(path, at, at))
}

// lockFilesIn lists every *.lock under the shared git dir but the package's own two.
func lockFilesIn(t *testing.T, r *Repo) []string {
	t.Helper()
	var list []string
	must(t, filepath.Walk(r.CommonDir(), func(path string, fi os.FileInfo, err error) error {
		if err != nil {
			return nil // a file git removed meanwhile
		}
		if name := fi.Name(); strings.HasSuffix(name, ".lock") && name != guardFile && name != lockFile {
			list = append(list, path)
		}
		return nil
	}))
	return list
}

// The lock files that a killed git command left in a run's checkout are removed before the next
// write there: of the index, of HEAD and of the checkout's branch.
func TestStaleLocksOfARunCheckoutAreRemoved(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	dir, gitDir := runCheckout(t, r, root, "T01")
	stale := []string{
		filepath.Join(gitDir, "index.lock"), filepath.Join(gitDir, "HEAD.lock"),
		filepath.Join(gitDir, "ORIG_HEAD.lock"), filepath.Join(gitDir, "AUTO_MERGE.lock"),
		filepath.Join(r.CommonDir(), "refs", "heads", "aiwb", "r1", "T01.lock"),
	}
	check := func(what string, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("%s with stale locks: %v", what, err)
		}
		if left := lockFilesIn(t, r); len(left) > 0 {
			t.Fatalf("%s left %v", what, left)
		}
	}
	litter := func() {
		for _, path := range stale {
			leave(t, path, time.Minute)
		}
	}

	litter()
	write(t, dir, "new.txt", "new\n")
	head, err := r.CommitAll(bg, dir, "T01: new")
	check("CommitAll", err)
	if got := git(t, dir, "log", "-1", "--format=%s"); got != "T01: new" || head != git(t, dir, "rev-parse", "HEAD") {
		t.Errorf("the commit is %q", got)
	}

	// A merge, and the abort of one.
	write(t, root, "main.txt", "main\n")
	_, err = r.CommitAll(bg, root, "on main")
	must(t, err)
	litter()
	res, err := r.Merge(bg, dir, "main", "Merge main", true)
	check("Merge", err)
	if !res.Merged {
		t.Errorf("Merge = %+v", res)
	}
	write(t, root, "f.txt", "ONE\ntwo\nthree\n")
	_, err = r.CommitAll(bg, root, "main changes f")
	must(t, err)
	write(t, dir, "f.txt", "uno\ntwo\nthree\n")
	_, err = r.CommitAll(bg, dir, "T01 changes f")
	must(t, err)
	if res, err = r.Merge(bg, dir, "main", "Merge main", true); err != nil || res.Merged {
		t.Fatalf("should conflict: %+v, %v", res, err)
	}
	litter()
	check("AbortMerge", r.AbortMerge(bg, dir))
	if res, err = r.Merge(bg, dir, "main", "Merge main", true); err != nil || res.Merged {
		t.Fatalf("should conflict: %+v, %v", res, err)
	}
	write(t, dir, "f.txt", "uno ONE\ntwo\nthree\n")
	litter()
	_, err = r.ConcludeMerge(bg, dir, "", res.Conflicts)
	check("ConcludeMerge", err)

	// EnsureWorktree of a checkout that is there: before its agent starts.
	litter()
	check("EnsureWorktree", r.EnsureWorktree(bg, dir, "aiwb/r1/T01", "main"))

	// The orchestrator's checkout: detached, reset before every turn.
	orch := sibling(root, "orch")
	must(t, r.EnsureWorktree(bg, orch, "", "main"))
	orchGit := git(t, orch, "rev-parse", "--absolute-git-dir")
	leave(t, filepath.Join(orchGit, "index.lock"), time.Minute)
	leave(t, filepath.Join(orchGit, "HEAD.lock"), time.Minute)
	check("ResetDetached", r.ResetDetached(bg, orch, "aiwb/r1/T01"))

	// The lock of the branch does not outlive the checkout: the branch can be deleted.
	litter()
	check("RemoveWorktree", r.RemoveWorktree(bg, dir))
	must(t, r.DeleteBranch(bg, "aiwb/r1/T01"))
}

// A lock file that is not a run checkout's own stays, and git fails on it as it always did: the
// person's checkout, a work tree the package did not make, a branch that is not a run's, and
// everything the checkouts share.
func TestOtherLocksAreLeftAlone(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	// Git waits for the lock of a ref (0.1 s) and of packed-refs (1 s) before it gives up or goes
	// on without. The locks here stay for good, so the test does not sit through that each time.
	git(t, root, "config", "core.filesRefLockTimeout", "0")
	git(t, root, "config", "core.packedRefsTimeout", "0")
	common := r.CommonDir()
	isLocked := func(what string, err error, lock string) {
		t.Helper()
		var ge *Error
		if !errors.As(err, &ge) || !strings.Contains(ge.Output, "File exists") {
			t.Errorf("%s = %v, want git's own failure on the lock", what, err)
		}
		if !exists(lock) {
			t.Errorf("%s removed %s", what, lock)
		}
		must(t, os.Remove(lock))
	}

	// The person's checkout: the work tree the Repo was opened from.
	lock := filepath.Join(common, "index.lock")
	leave(t, lock, time.Hour)
	write(t, root, "mine.txt", "mine\n")
	_, err := r.CommitAll(bg, root, "mine")
	isLocked("CommitAll in the main work tree", err, lock)
	lock = filepath.Join(common, "refs", "heads", "main.lock")
	leave(t, lock, time.Hour)
	_, err = r.CommitAll(bg, root, "mine")
	isLocked("CommitAll on main", err, lock)

	// The same when the person's checkout is a linked work tree.
	theirs := sibling(root, "theirs")
	git(t, root, "worktree", "add", "-q", "-b", "aiwb/theirs/x", theirs, "main")
	theirGit := git(t, theirs, "rev-parse", "--absolute-git-dir")
	rl := open(t, theirs)
	must(t, rl.EnsureWorktree(bg, theirs, "aiwb/theirs/x", "main")) // accepted, and not marked
	lock = filepath.Join(theirGit, "index.lock")
	leave(t, lock, time.Hour)
	write(t, theirs, "t.txt", "t\n")
	_, err = rl.CommitAll(bg, theirs, "theirs")
	isLocked("CommitAll in the linked work tree the Repo was opened from", err, lock)

	// A linked work tree that EnsureWorktree did not make.
	_, err = r.CommitAll(bg, theirs, "theirs")
	must(t, err)
	leave(t, lock, time.Hour)
	write(t, theirs, "t.txt", "t2\n")
	_, err = r.CommitAll(bg, theirs, "theirs")
	isLocked("CommitAll in a work tree the package did not make", err, lock)

	// A checkout of the package on a branch that is not a run's: its index lock goes, the lock of
	// the branch stays.
	plain := sibling(root, "plain")
	must(t, r.EnsureWorktree(bg, plain, "feature", "main"))
	leave(t, filepath.Join(git(t, plain, "rev-parse", "--absolute-git-dir"), "index.lock"), time.Hour)
	lock = filepath.Join(common, "refs", "heads", "feature.lock")
	leave(t, lock, time.Hour)
	write(t, plain, "p.txt", "p\n")
	_, err = r.CommitAll(bg, plain, "plain")
	isLocked("CommitAll on a branch that is not a run's", err, lock)

	// A run's checkout that its agent switched to another branch: not the lock of that branch, and
	// not the lock of the run's branch either, which the checkout is no longer on.
	dir, _ := runCheckout(t, r, root, "T01")
	git(t, dir, "checkout", "-q", "-b", "aiwb/r1/other")
	for _, name := range []string{"other", "T01"} {
		leave(t, filepath.Join(common, "refs", "heads", "aiwb", "r1", name+".lock"), time.Hour)
	}
	write(t, dir, "o.txt", "o\n")
	_, err = r.CommitAll(bg, dir, "other")
	isLocked("CommitAll on a branch the checkout was not made on", err, filepath.Join(common, "refs", "heads", "aiwb", "r1", "other.lock"))
	must(t, os.Remove(filepath.Join(common, "refs", "heads", "aiwb", "r1", "T01.lock")))
	git(t, dir, "checkout", "-q", "--force", "aiwb/r1/T01")

	// What the checkouts share, and the main work tree's own, when the package writes in a run's
	// checkout.
	shared := []string{"packed-refs.lock", "config.lock", "index.lock", "HEAD.lock", "ORIG_HEAD.lock",
		filepath.Join("refs", "heads", "main.lock"), filepath.Join("worktrees", "theirs", "index.lock")}
	for _, name := range shared {
		leave(t, filepath.Join(common, name), time.Hour)
	}
	write(t, dir, "run.txt", "run\n")
	if _, err := r.CommitAll(bg, dir, "T01: run"); err != nil {
		t.Errorf("CommitAll in the run's checkout: %v", err)
	}
	must(t, r.EnsureWorktree(bg, dir, "aiwb/r1/T01", "main"))
	for _, name := range shared {
		if !exists(filepath.Join(common, name)) {
			t.Errorf("%s was removed", name)
		}
	}
}

// A lock is removed only once it has been there for staleAge: a git command that the package did
// not start and that is just writing keeps its lock.
func TestAYoungLockIsWaitedFor(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	dir, gitDir := runCheckout(t, r, root, "T01")
	lock := filepath.Join(gitDir, "index.lock")

	// The rule is the same with a shorter staleAge, and the test does not sit through two
	// seconds three times. It is still several writes of the writer below.
	const staleAge = 800 * time.Millisecond
	bg := withWaits(bg, waits{staleAge: staleAge})

	// One that stays as it is: stale after staleAge.
	leave(t, lock, 0)
	write(t, dir, "a.txt", "a\n")
	start := time.Now()
	if _, err := r.CommitAll(bg, dir, "T01: a"); err != nil {
		t.Fatalf("CommitAll with a young stale lock: %v", err)
	}
	if took := time.Since(start); took < staleAge-200*time.Millisecond {
		t.Errorf("the lock was removed %s after it was made, before staleAge", took)
	}

	// One that somebody is writing: it stays.
	leave(t, lock, 0)
	stop := make(chan struct{})
	written := make(chan struct{})
	go func() {
		defer close(written)
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			case <-time.After(100 * time.Millisecond):
				os.WriteFile(lock, []byte(strings.Repeat("x", i+1)), 0o644)
			}
		}
	}()
	write(t, dir, "b.txt", "b\n")
	_, err := r.CommitAll(bg, dir, "T01: b")
	close(stop)
	<-written
	if err == nil || !exists(lock) {
		t.Errorf("CommitAll = %v with a lock that is being written; the lock is there: %v", err, exists(lock))
	}

	// The wait ends with the context.
	leave(t, lock, 0)
	ctx, cancel := context.WithTimeout(bg, 100*time.Millisecond)
	defer cancel()
	if _, err := r.CommitAll(ctx, dir, "T01: b"); !errors.Is(err, context.DeadlineExceeded) || !exists(lock) {
		t.Errorf("CommitAll = %v, want the context's error and the lock left", err)
	}
}

// While a git command of the package is at work in a checkout, in this server or another, no lock
// is removed there: the command holds the flock of the guard file, and so does all it starts.
func TestALockIsKeptWhileAGitCommandIsAtWork(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	dir, gitDir := runCheckout(t, r, root, "T01")
	lock := filepath.Join(gitDir, "index.lock")

	// Another holder: flock belongs to the open file, so a second open in this process stands in
	// for the git command of another server.
	other, err := os.Open(filepath.Join(gitDir, guardFile))
	must(t, err)
	defer other.Close()
	must(t, syscall.Flock(int(other.Fd()), syscall.LOCK_SH))
	leave(t, lock, time.Hour)
	write(t, dir, "a.txt", "a\n")
	// The flock is held for as long as the call tries for it, however long that is: the test
	// does not sit through flockWait each time.
	held := withWaits(bg, waits{flockWait: 20 * time.Millisecond})
	if _, err := r.CommitAll(held, dir, "T01: a"); err == nil || !exists(lock) {
		t.Fatalf("CommitAll = %v while another git command is at work; the lock is there: %v", err, exists(lock))
	}
	must(t, syscall.Flock(int(other.Fd()), syscall.LOCK_UN))
	if _, err := r.CommitAll(bg, dir, "T01: a"); err != nil {
		t.Fatalf("CommitAll when the other is gone: %v", err)
	}

	// A git command of the package hands the flock down: a process that a hook left behind holds
	// it after the command, as a git command that outlives its killed server does.
	pidFile := filepath.Join(t.TempDir(), "pid")
	hook(t, r, "pre-commit", "sleep 60 >/dev/null 2>&1 &\necho $! > "+pidFile)
	write(t, dir, "b.txt", "b\n")
	if _, err := r.CommitAll(bg, dir, "T01: b"); err != nil {
		t.Fatal(err)
	}
	pid := waitForPids(t, pidFile, 1)[0]
	defer syscall.Kill(pid, syscall.SIGKILL)
	must(t, os.Remove(filepath.Join(r.CommonDir(), "hooks", "pre-commit")))
	free := func() bool {
		f, err := os.Open(filepath.Join(gitDir, guardFile))
		must(t, err)
		defer f.Close()
		return tryFlock(f, syscall.LOCK_EX)
	}
	if free() {
		t.Fatalf("the flock is free while a process of the git command is alive")
	}
	leave(t, lock, time.Hour)
	write(t, dir, "c.txt", "c\n")
	if _, err := r.CommitAll(held, dir, "T01: c"); err == nil || !exists(lock) {
		t.Errorf("CommitAll = %v while a process of an earlier git command is alive; the lock is there: %v", err, exists(lock))
	}
	must(t, syscall.Kill(pid, syscall.SIGKILL))
	for deadline := time.Now().Add(5 * time.Second); !free(); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("the flock is still held after the process is gone")
		}
	}
	if _, err := r.CommitAll(bg, dir, "T01: c"); err != nil {
		t.Errorf("CommitAll when the process is gone: %v", err)
	}
}

// The flock of a checkout is not always free the moment its last command ended: a process that
// the server was starting just then has a copy of the open guard file until it runs its program.
// So the flock is tried for flockWait before a lock is left where it is. Here a second open file
// holds it, for a part of that time and for all of it.
func TestTheFlockIsWaitedForBeforeALockIsLeft(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	dir, gitDir := runCheckout(t, r, root, "T01")
	lock := filepath.Join(gitDir, "index.lock")
	other, err := os.Open(filepath.Join(gitDir, guardFile))
	must(t, err)
	defer other.Close()
	hold := func() {
		t.Helper()
		must(t, syscall.Flock(int(other.Fd()), syscall.LOCK_SH))
		leave(t, lock, time.Hour)
	}

	// Let go of within flockWait, which is long here so that a slow machine cannot use it up: the
	// lock is removed, which it can be only after the flock was let go of.
	hold()
	write(t, dir, "a.txt", "a\n")
	letGo := time.AfterFunc(300*time.Millisecond, func() { syscall.Flock(int(other.Fd()), syscall.LOCK_UN) })
	defer letGo.Stop()
	if _, err := r.CommitAll(withWaits(bg, waits{flockWait: time.Minute}), dir, "T01: a"); err != nil || exists(lock) {
		t.Fatalf("CommitAll = %v with a flock that was let go of in time; the lock is there: %v", err, exists(lock))
	}
	if got := git(t, dir, "log", "-1", "--format=%s"); got != "T01: a" {
		t.Errorf("the commit was not made: the head is %q", got)
	}

	// Held for all of flockWait: the lock stays, and git fails on it as it always did.
	hold()
	write(t, dir, "b.txt", "b\n")
	const wait = 200 * time.Millisecond
	start := time.Now()
	_, err = r.CommitAll(withWaits(bg, waits{flockWait: wait}), dir, "T01: b")
	var ge *Error
	if !errors.As(err, &ge) || !strings.Contains(ge.Output, "File exists") || !exists(lock) {
		t.Errorf("CommitAll = %v with a flock that is held, want git's own failure on the lock; the lock is there: %v", err, exists(lock))
	}
	if took := time.Since(start); took < wait {
		t.Errorf("the flock was given up after %s, before flockWait", took)
	}

	// The wait ends with the context.
	ctx, cancel := context.WithTimeout(withWaits(bg, waits{flockWait: time.Minute}), 100*time.Millisecond)
	defer cancel()
	if _, err := r.CommitAll(ctx, dir, "T01: b"); !errors.Is(err, context.DeadlineExceeded) || !exists(lock) {
		t.Errorf("CommitAll = %v, want the context's error; the lock is there: %v", err, exists(lock))
	}

	// And nothing of this outlives the holder.
	must(t, syscall.Flock(int(other.Fd()), syscall.LOCK_UN))
	if _, err := r.CommitAll(bg, dir, "T01: b"); err != nil || exists(lock) {
		t.Errorf("CommitAll when the holder is gone = %v; the lock is there: %v", err, exists(lock))
	}
}

// The same with real processes: a stale lock that is met right after a command of the package
// ended in the checkout is removed, while other goroutines start processes all the time. Each of
// those has a copy of the guard file of the command that just ended until it runs its program,
// and without the wait for the flock about one round in twenty failed with git's "File exists".
func TestAStaleLockIsClearedWhileProcessesStart(t *testing.T) {
	testset.SkipUnlessFull(t, "thousands of processes; TestTheFlockIsWaitedForBeforeALockIsLeft holds the flock without them")
	r, root := newRepo(t)
	dir, gitDir := runCheckout(t, r, root, "T01")
	lock := filepath.Join(gitDir, "index.lock")

	stop := make(chan struct{})
	var starting sync.WaitGroup
	for i := 0; i < 16; i++ {
		starting.Add(1)
		go func() {
			defer starting.Done()
			for {
				select {
				case <-stop:
					return
				default:
					exec.Command("true").Run()
				}
			}
		}()
	}
	defer starting.Wait()
	defer close(stop)

	// Each CommitAll is the command that just ended for the next one.
	if _, err := r.CommitAll(bg, dir, "T01: nothing"); err != nil {
		t.Fatalf("CommitAll: %v", err)
	}
	failed := 0
	for round := 0; round < staleRounds; round++ {
		leave(t, lock, time.Hour)
		if _, err := r.CommitAll(bg, dir, "T01: nothing"); err != nil {
			if failed++; failed == 1 {
				t.Errorf("round %d: CommitAll with a stale lock: %v", round, err)
			}
			must(t, os.Remove(lock))
		}
	}
	if failed > 0 {
		t.Errorf("the stale lock was not removed in %d of %d rounds", failed, staleRounds)
	}
}

// staleRounds is the number of rounds of TestAStaleLockIsClearedWhileProcessesStart: enough for
// several of them to fail without the wait for the flock.
const staleRounds = 150

// A git command that writes is not ended when the context is: it finishes, and what it did is
// there. A commit with a hook that takes a moment stands for a commit that is in the middle of
// its writing.
func TestAWriteFinishesAfterTheCancel(t *testing.T) {
	t.Parallel()
	// What is left of the commit and of the merge after the cancel, the hook's 0.3 s and git's
	// own writing, has to fit into settle. On a busy machine two seconds can be too few for it;
	// the commands return when they are done, so more costs nothing.
	bg := withWaits(bg, waits{settle: 20 * time.Second})
	r, root := newRepo(t)
	dir, _ := runCheckout(t, r, root, "T01")
	started := filepath.Join(t.TempDir(), "started")
	hook(t, r, "pre-commit", "echo $$ > "+started+"\nsleep 0.3")
	hook(t, r, "pre-merge-commit", "echo $$ > "+started+"\nsleep 0.3")

	write(t, dir, "a.txt", "a\n")
	ctx, cancel := context.WithCancel(bg)
	done := make(chan error, 1)
	go func() {
		_, err := r.CommitAll(ctx, dir, "T01: a")
		done <- err
	}()
	waitForPids(t, started, 1)
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Errorf("CommitAll = %v, want context.Canceled", err) // it cannot read the head any more
	}
	if got := git(t, dir, "log", "-1", "--format=%s"); got != "T01: a" {
		t.Errorf("the commit was not made: the head is %q", got)
	}
	if left := lockFilesIn(t, r); len(left) > 0 {
		t.Errorf("left %v", left)
	}

	// A merge that got to its end is reported as done.
	must(t, os.Remove(started))
	intDir := sibling(root, "int")
	must(t, r.EnsureWorktree(bg, intDir, "aiwb/r1/integration", "main"))
	ctx, cancel = context.WithCancel(bg)
	type merged struct {
		res MergeResult
		err error
	}
	mdone := make(chan merged, 1)
	go func() {
		res, err := r.Merge(ctx, intDir, "aiwb/r1/T01", "Merge T01", true)
		mdone <- merged{res, err}
	}()
	waitForPids(t, started, 1)
	cancel()
	m := <-mdone
	if m.err != nil || !m.res.Merged || m.res.Head != git(t, intDir, "rev-parse", "HEAD") {
		t.Errorf("Merge = %+v, %v, want it done", m.res, m.err)
	}
	if got := git(t, intDir, "log", "-1", "--format=%s"); got != "Merge T01" {
		t.Errorf("the merge commit was not made: the head is %q", got)
	}
	if left := lockFilesIn(t, r); len(left) > 0 {
		t.Errorf("left %v", left)
	}
}

// Stops at any moment of a commit leave no lock file, and the next commit goes through.
func TestCancelAtAnyMomentLeavesNoLock(t *testing.T) {
	testset.SkipUnlessFull(t, "100 commits, each stopped at another moment; "+
		"TestAWriteFinishesAfterTheCancel covers a commit that is cancelled and leaves no lock, "+
		"TestCancelEndsASlowGitCommand that the next commit goes through")
	t.Parallel()
	r, root := newRepo(t)
	dir, _ := runCheckout(t, r, root, "T01")
	for i := 0; i < 100; i++ {
		write(t, dir, "f.txt", strings.Repeat("line\n", i+1))
		ctx, cancel := context.WithCancel(bg)
		done := make(chan struct{})
		go func() {
			defer close(done)
			r.CommitAll(ctx, dir, "T01: stopped")
		}()
		time.Sleep(time.Duration(rand.Intn(40)) * time.Millisecond)
		cancel()
		<-done
		if left := lockFilesIn(t, r); len(left) > 0 {
			t.Fatalf("round %d: the stopped commit left %v", i, left)
		}
	}
	write(t, dir, "last.txt", "last\n")
	if _, err := r.CommitAll(bg, dir, "T01: last"); err != nil {
		t.Fatalf("the commit after the stops: %v", err)
	}
	if out := git(t, dir, "status", "--porcelain"); out != "" {
		t.Errorf("not everything is committed:\n%s", out)
	}
}
