package rungit

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// lockFile is the file in the shared git dir whose flock keeps two server instances, or several
// runs on one repository, from doing work-tree bookkeeping at the same moment.
const lockFile = "aiwb-runs.lock"

// repoLocks has one lock per shared git dir for the goroutines of this process: a channel that
// holds a value while the lock is taken, so that waiting for it can be given up.
var repoLocks sync.Map

// lock takes the bookkeeping lock of the repository. It is held only around a work-tree add or
// remove, never while anything else runs.
func (r *Repo) lock(ctx context.Context) (unlock func(), err error) {
	v, _ := repoLocks.LoadOrStore(r.commonDir, make(chan struct{}, 1))
	mu := v.(chan struct{})
	select {
	case mu <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	f, err := os.OpenFile(filepath.Join(r.commonDir, lockFile), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		<-mu
		return nil, err
	}
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() { f.Close(); <-mu }, nil // closing the file gives the flock back
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EINTR) {
			f.Close()
			<-mu
			return nil, fmt.Errorf("lock %s: %w", f.Name(), err)
		}
		select {
		case <-ctx.Done():
			f.Close()
			<-mu
			return nil, ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// registered is a work tree as git has it on record.
type registered struct {
	path   string // as git prints it
	branch string // "" when detached
	main   bool
}

// worktrees lists the work trees of the repository; the main one comes first.
func (r *Repo) worktrees(ctx context.Context) ([]registered, error) {
	out, err := r.run(ctx, r.root, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	var list []registered
	for _, line := range strings.Split(out, "\n") {
		if path, ok := strings.CutPrefix(line, "worktree "); ok {
			list = append(list, registered{path: path, main: len(list) == 0})
		} else if ref, ok := strings.CutPrefix(line, "branch refs/heads/"); ok && len(list) > 0 {
			list[len(list)-1].branch = ref
		}
	}
	return list, nil
}

// EnsureWorktree makes sure there is a work tree at path: detached at base when branch is "", on
// branch when the branch exists (base is not used then), else on a new branch created at base.
//
// It is idempotent. A work tree that is already at path is accepted, and left as it is, only when
// it is a work tree of this repository on the expected branch (detached at any commit when branch
// is ""); anything else there is ErrWorktreeMismatch. A work tree whose folder was deleted by hand
// is made again: the record git still has of it, or of another deleted work tree that had the
// branch, is removed first. No other record is pruned.
func (r *Repo) EnsureWorktree(ctx context.Context, path, branch, base string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if branch != "" {
		if err := checkArg("branch", branch); err != nil {
			return err
		}
	}
	unlock, err := r.lock(ctx)
	if err != nil {
		return err
	}
	defer unlock()

	if exists(filepath.Join(abs, ".git")) {
		t, err := r.checkWorktree(ctx, abs, branch)
		if err != nil {
			return err
		}
		return r.own(ctx, t, branch)
	}
	if err := r.dropStale(ctx, abs, branch); err != nil {
		return err
	}
	onBranch := false
	if branch != "" {
		if onBranch, err = r.BranchExists(ctx, branch); err != nil {
			return err
		}
	}
	if !onBranch {
		if err := checkArg("base", base); err != nil {
			return err
		}
	}
	switch {
	case branch == "":
		_, err = r.run(ctx, r.root, "worktree", "add", "-q", "--detach", abs, base)
	case onBranch:
		_, err = r.run(ctx, r.root, "worktree", "add", "-q", abs, branch)
	default:
		_, err = r.run(ctx, r.root, "worktree", "add", "-q", "--no-track", "-b", branch, abs, base)
	}
	if err != nil {
		return err
	}
	t, err := r.tree(ctx, abs)
	if err != nil {
		return err
	}
	return r.own(ctx, t, branch)
}

// checkWorktree says whether the work tree at path is this repository's and on branch.
func (r *Repo) checkWorktree(ctx context.Context, path, branch string) (tree, error) {
	t, err := r.tree(ctx, path)
	if errors.Is(err, ErrNotWorktree) {
		return t, fmt.Errorf("%w: %s is not a work tree of this repository", ErrWorktreeMismatch, path)
	}
	if err != nil {
		return t, err
	}
	have, err := r.branch(ctx, t.top)
	if err != nil {
		return t, err
	}
	switch {
	case have == branch:
		return t, nil
	case branch == "":
		return t, fmt.Errorf("%w: %s is on branch %s, not detached", ErrWorktreeMismatch, path, have)
	case have == "":
		return t, fmt.Errorf("%w: %s is detached, not on branch %s", ErrWorktreeMismatch, path, branch)
	}
	return t, fmt.Errorf("%w: %s is on branch %s, not %s", ErrWorktreeMismatch, path, have, branch)
}

// dropStale removes the record of a linked work tree whose folder is gone, when the record is
// in the way of a work tree at path on branch: it is of path itself, or it still holds the branch.
// A record that is locked on purpose is not removed: that is an error.
func (r *Repo) dropStale(ctx context.Context, path, branch string) error {
	list, err := r.worktrees(ctx)
	if err != nil {
		return err
	}
	want := resolve(path)
	for _, w := range list {
		if w.main || (resolve(w.path) != want && (branch == "" || w.branch != branch)) {
			continue
		}
		if _, err := os.Lstat(w.path); !errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err := r.removeForced(ctx, w.path); err != nil {
			return err
		}
	}
	return nil
}

// removeForced is git worktree remove --force for the linked work tree at path. A git worktree add
// that was killed during its checkout leaves the work tree locked, with the reason "initializing",
// and git refuses to remove a locked one: that lock, and no other, is taken off first. A work tree
// that somebody locked on purpose stays (there is no remove -f -f here).
func (r *Repo) removeForced(ctx context.Context, path string) error {
	// LC_ALL=C: the lock is told by git's words. No hook runs here that could mind.
	_, _, err := runGit(ctx, append(r.env[:len(r.env):len(r.env)], "LC_ALL=C"), r.root, "worktree", "remove", "--force", path)
	var ge *Error
	if err == nil || !errors.As(err, &ge) || !leftLocked(ge.Output) {
		return err
	}
	if _, uerr := r.run(ctx, r.root, "worktree", "unlock", path); uerr != nil {
		return err
	}
	_, err = r.run(ctx, r.root, "worktree", "remove", "--force", path)
	return err
}

// leftLocked reports whether git refused to remove a work tree because a git worktree add that
// did not finish left it locked.
func leftLocked(output string) bool {
	for _, line := range strings.Split(output, "\n") {
		if strings.HasSuffix(strings.TrimRight(line, " \t\r"), "lock reason: initializing") {
			return true
		}
	}
	return false
}

// RemoveWorktree removes the linked work tree at path, with everything in it (--force: uncommitted
// and untracked files too). Its branch stays. It is not an error when the work tree is already
// gone; it is one when path holds something that is not a linked work tree of this repository,
// which is then left alone, and when the work tree is locked (git worktree lock): only the lock
// that a killed git worktree add left is taken off.
func (r *Repo) RemoveWorktree(ctx context.Context, path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	unlock, err := r.lock(ctx)
	if err != nil {
		return err
	}
	defer unlock()

	want := resolve(abs)
	defer r.forget(want, nil) // what tree remembers of it
	// A folder that is a linked work tree of this repository says so itself, and git need not
	// list them all. Anything else (a folder that is gone, the main work tree, a folder git has
	// on record somewhere else) is for the list.
	if exists(filepath.Join(abs, ".git")) {
		if t, err := r.tree(ctx, abs); err == nil && t.linked && recordedAt(t.gitDir) == want {
			// The lock a killed commit left on its branch would outlive the work tree, and the
			// branch could not be deleted.
			guarded, done, err := r.guard(ctx, t)
			if err != nil {
				return err
			}
			defer done()
			return r.removeForced(guarded, abs)
		}
	}
	list, err := r.worktrees(ctx)
	if err != nil {
		return err
	}
	for _, w := range list {
		if resolve(w.path) != want {
			continue
		}
		if w.main {
			return fmt.Errorf("%w: %s is the main work tree", ErrWorktreeMismatch, path)
		}
		// The lock a killed commit left on its branch would outlive the work tree, and the
		// branch could not be deleted.
		if t, err := r.tree(ctx, w.path); err == nil {
			guarded, done, err := r.guard(ctx, t)
			if err != nil {
				return err
			}
			defer done()
			ctx = guarded
		}
		return r.removeForced(ctx, w.path)
	}
	if exists(abs) {
		return fmt.Errorf("%w: %s", ErrNotWorktree, path)
	}
	return nil
}

// recordedAt is the folder that git has on record for the linked work tree with the git dir
// gitDir, symlinks resolved: what git worktree list shows for it. "" when it cannot be read.
func recordedAt(gitDir string) string {
	b, err := os.ReadFile(filepath.Join(gitDir, "gitdir"))
	if err != nil {
		return ""
	}
	link := strings.TrimRight(string(b), "\r\n")
	if filepath.Base(link) != ".git" {
		return ""
	}
	return resolve(filepath.Dir(absIn(gitDir, link)))
}

// ResetDetached puts the linked work tree at path at ref with a detached HEAD and throws away
// everything else in it: local changes, untracked files, a merge in progress. Ignored files stay.
// This is the orchestrator's checkout, reset before every turn. The main work tree is refused.
func (r *Repo) ResetDetached(ctx context.Context, path, ref string) error {
	if err := checkArg("ref", ref); err != nil {
		return err
	}
	t, err := r.tree(ctx, path)
	if err != nil {
		return err
	}
	if !t.linked {
		return fmt.Errorf("%w: %s is the main work tree", ErrWorktreeMismatch, path)
	}
	ctx, done, err := r.guard(ctx, t)
	if err != nil {
		return err
	}
	defer done()
	if _, err := r.run(ctx, t.top, "checkout", "-q", "--detach", "--force", ref); err != nil {
		return err
	}
	_, err = r.run(ctx, t.top, "clean", "-fdq")
	return err
}

// Branch returns the branch that the work tree dir is on, or "" when its HEAD is detached.
func (r *Repo) Branch(ctx context.Context, dir string) (string, error) {
	t, err := r.tree(ctx, dir)
	if err != nil {
		return "", err
	}
	return r.branch(ctx, t.top)
}

func (r *Repo) branch(ctx context.Context, dir string) (string, error) {
	out, err := r.run(ctx, dir, "symbolic-ref", "--quiet", "HEAD")
	if exitCode(err) == 1 {
		return "", nil
	}
	return strings.TrimPrefix(out, "refs/heads/"), err
}
