package rungit

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// A git command that is killed while it writes can leave a lock file behind (index.lock, HEAD.lock,
// the lock of a branch), and every later command that needs the lock fails with "File exists".
// The package lets its writing commands finish when the context ends (settle in exec.go), which
// covers a stop; a server that is killed, or a command that had to be ended after all, can still
// leave one. guard removes such a lock before the package writes in the checkout again.
//
// It is the person's repository, so the rule is narrow. A lock file is removed only when all of
// this holds:
//
//   - The checkout is one EnsureWorktree made or took over for the caller: a linked work tree, not
//     the one the Repo was opened from, with guardFile in its git dir.
//   - The file is one of ownLocks in that git dir (<common dir>/worktrees/<name>/), or the lock
//     of the branch EnsureWorktree put the checkout on, when the checkout is still on it and the
//     branch is under ownRefs. Nothing else: not the main work tree's locks, not
//     packed-refs.lock, config.lock or any other shared one. Those fail as git reports them.
//   - No git command of the package is at work in the checkout, in this server or another one,
//     alive or killed: each of them holds the flock of guardFile, shared, and hands it down to
//     git and to whatever git starts, so the exclusive flock can be had only when all of them are
//     gone.
//   - The file has been there, unchanged, for staleAge. That is for git commands the package did
//     not start (an agent's, a person's): one that is just writing is done long before.
const (
	// guardFile marks a checkout as the caller's own and carries the flock of the git commands
	// that the package runs in it. Its content is the branch of the checkout ("" when detached).
	guardFile = "aiwb-checkout.lock"
	// ownRefs is where the branches of runs are; the lock of no other branch is ever removed.
	ownRefs = "aiwb/"
	// staleAge is how long a lock file must have been there before it counts as left behind.
	staleAge = 2 * time.Second
)

type guardKey struct{}

// guardOf is the open guard file that the git commands run with ctx inherit, or nil.
func guardOf(ctx context.Context) *os.File {
	f, _ := ctx.Value(guardKey{}).(*os.File)
	return f
}

// ownable reports whether t can be a checkout of the caller: a linked work tree other than the one
// the Repo was opened from, with its git dir where git keeps those of linked work trees.
func (r *Repo) ownable(t tree) bool {
	return t.linked && t.top != r.root && filepath.Dir(t.gitDir) == filepath.Join(r.commonDir, "worktrees")
}

// own marks the work tree t, which EnsureWorktree made or found on branch, as the caller's own,
// and removes what a killed git command left in it.
func (r *Repo) own(ctx context.Context, t tree, branch string) error {
	if !r.ownable(t) {
		return nil
	}
	path, want := filepath.Join(t.gitDir, guardFile), branch+"\n"
	if have, err := os.ReadFile(path); err != nil || string(have) != want {
		// Written in place: the flock is on the file itself and would not follow a rename.
		if err := os.WriteFile(path, []byte(want), 0o644); err != nil {
			return nil // without the mark nothing is ever removed there
		}
	}
	_, done, err := r.guard(ctx, t)
	done()
	return err
}

// guard is called before the package writes in the work tree t. In a checkout that is the
// caller's own it removes the lock files a killed git command left there, and returns a context
// whose git commands hold the flock of the checkout until done is called. In any other work tree
// it does nothing and returns ctx. The error is the context's.
func (r *Repo) guard(ctx context.Context, t tree) (guarded context.Context, done func(), err error) {
	done = func() {}
	if !r.ownable(t) {
		return ctx, done, nil
	}
	f, err := os.Open(filepath.Join(t.gitDir, guardFile))
	if err != nil {
		return ctx, done, nil // not marked: not a checkout that EnsureWorktree made
	}
	if err := r.clearStale(ctx, t, f); err != nil {
		f.Close()
		return ctx, done, err
	}
	// Shared, so that the commands of one checkout never wait for each other, only for a
	// clearStale that is looking at the checkout.
	for !tryFlock(f, syscall.LOCK_SH) {
		select {
		case <-ctx.Done():
			f.Close()
			return ctx, done, ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
	return context.WithValue(ctx, guardKey{}, f), func() { f.Close() }, nil
}

// tryFlock takes the flock of f (LOCK_SH or LOCK_EX) when it is free, and reports whether it did.
func tryFlock(f *os.File, how int) bool {
	for {
		err := syscall.Flock(int(f.Fd()), how|syscall.LOCK_NB)
		if !errors.Is(err, syscall.EINTR) {
			return err == nil
		}
	}
}

// clearStale removes the lock files of the checkout t that nobody holds; f is its open guard file.
func (r *Repo) clearStale(ctx context.Context, t tree, f *os.File) error {
	var found []string
	for _, path := range r.lockFiles(t) {
		if fi, err := os.Lstat(path); err == nil && fi.Mode().IsRegular() {
			found = append(found, path)
		}
	}
	if len(found) == 0 {
		return nil
	}
	if !tryFlock(f, syscall.LOCK_EX) {
		return nil // a git command of the package is at work in the checkout: the lock may be its
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	for _, path := range found {
		if err := removeStale(ctx, path); err != nil {
			return err
		}
	}
	return nil
}

// ownLocks are the lock files in the git dir of a linked work tree that are only its own: of its
// index, its HEAD, and the two other refs of its own that a merge, a reset or a checkout writes.
var ownLocks = []string{"index.lock", "HEAD.lock", "ORIG_HEAD.lock", "AUTO_MERGE.lock"}

// lockFiles are the lock files that clearStale may remove in the checkout t.
func (r *Repo) lockFiles(t tree) []string {
	var list []string
	for _, name := range ownLocks {
		list = append(list, filepath.Join(t.gitDir, name))
	}
	mark, err := os.ReadFile(filepath.Join(t.gitDir, guardFile))
	if err != nil {
		return list
	}
	head, err := os.ReadFile(filepath.Join(t.gitDir, "HEAD"))
	if err != nil {
		return list
	}
	branch, onBranch := strings.CutPrefix(strings.TrimSpace(string(head)), "ref: refs/heads/")
	if onBranch && branch == strings.TrimSpace(string(mark)) && strings.HasPrefix(branch, ownRefs) && filepath.IsLocal(branch) {
		list = append(list, filepath.Join(r.commonDir, "refs", "heads", filepath.FromSlash(branch)+".lock"))
	}
	return list
}

// removeStale removes the lock file path once it has been there, unchanged, for staleAge. A file
// that goes away or changes while it is waited for belongs to somebody who is at work, and stays.
func removeStale(ctx context.Context, path string) error {
	was, err := os.Lstat(path)
	if err != nil || !was.Mode().IsRegular() {
		return nil
	}
	if wait := min(staleAge-time.Since(was.ModTime()), staleAge); wait > 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
		is, err := os.Lstat(path)
		if err != nil || !os.SameFile(was, is) || !is.ModTime().Equal(was.ModTime()) || is.Size() != was.Size() {
			return nil
		}
	}
	os.Remove(path)
	return nil
}
