// Package rungit is the git layer of runs: work trees, commits, merges with conflict detection,
// what an attempt changed, and the setup command of a new work tree. It does everything by calling
// the git command line, as the autobuild script it is ported from does, and knows nothing about
// tasks, agents or state: the run engine builds on it.
//
// A Repo is safe for concurrent use. What the package serialises is only the bookkeeping of work
// trees (EnsureWorktree, RemoveWorktree): per repository, with a mutex in the process and an
// advisory flock on a file in the shared git dir, held just for the add or the remove.
//
// A git command that writes is not ended in the middle of it: when the context is done it gets a
// moment to finish. A lock file that a killed git command left in a work tree EnsureWorktree made
// is removed before the package writes there again (locks.go has the rule).
//
// The package does not serialise merges. The engine must let only one merge into a branch happen at
// a time, and must not hold its lock while a merge agent resolves a conflict.
//
// No command waits for a person: there is no terminal prompt and no editor, and the package's own
// commits and merges are not signed. The rest of the environment is the server's, so the user's
// git config and the repository's hooks apply. A commit that a hook refuses is made again with
// --no-verify, so that a hook cannot wedge a run. The one place without the hooks is the scratch
// work tree in which Deliver builds a merge commit.
//
// Every function that takes the folder of a work tree wants its top level, of a work tree of this
// repository, and reports ErrNotWorktree otherwise. Run work trees usually live inside the main
// work tree; without this check a command in a folder that lost its .git would act on the user's
// own checkout.
//
// No function touches a branch or a work tree it was not asked about.
package rungit

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var (
	// ErrNotRepo: the folder is not inside a git work tree.
	ErrNotRepo = errors.New("not inside a git work tree")
	// ErrNoCommits: the repository has no commit yet (HEAD is unborn).
	ErrNoCommits = errors.New("the repository has no commit yet")
	// ErrUnknownRef: the ref does not name a commit.
	ErrUnknownRef = errors.New("unknown ref")
	// ErrNotWorktree: the folder is not the top level of a work tree of this repository.
	ErrNotWorktree = errors.New("not the top level of a work tree of this repository")
	// ErrWorktreeMismatch: the folder holds a work tree that is not the one asked for.
	ErrWorktreeMismatch = errors.New("the folder holds another work tree")
	// ErrMerging: the work tree is in the middle of a merge.
	ErrMerging = errors.New("a merge is in progress")
	// ErrNotMerging: the work tree is not in the middle of a merge.
	ErrNotMerging = errors.New("no merge is in progress")
	// ErrUnmerged: the index has unmerged paths that no merge in progress accounts for (a
	// cherry-pick, a rebase or a stash pop left them).
	ErrUnmerged = errors.New("the work tree has unmerged paths")
	// ErrUnresolved: the merge cannot be concluded yet. The error is an *UnresolvedError.
	ErrUnresolved = errors.New("the merge is not resolved")
)

// UnresolvedError is what ConcludeMerge returns when ConflictProblems is not empty.
// errors.Is(err, ErrUnresolved) is true for it.
type UnresolvedError struct {
	Problems []string // one line per problem, as ConflictProblems returns them
}

func (e *UnresolvedError) Error() string {
	return ErrUnresolved.Error() + ": " + strings.Join(e.Problems, "; ")
}

func (e *UnresolvedError) Is(target error) bool { return target == ErrUnresolved }

// Repo is a git repository: a main work tree, its linked work trees and the git dir they share.
type Repo struct {
	root      string
	commonDir string
	env       []string
	name      string
	email     string
}

// Option changes how Open sets a Repo up.
type Option func(*options)

type options struct {
	env         []string
	name, email string
}

// WithEnv adds environment variables ("KEY=value") to every git command of the Repo. They win
// over the server's and the package's own.
func WithEnv(extra ...string) Option {
	return func(o *options) { o.env = append(o.env, extra...) }
}

// WithIdentity sets the identity of commits and merges in a repository that has no user.name and
// user.email of its own. The default is "AI Whiteboard" <runs@localhost>.
func WithIdentity(name, email string) Option {
	return func(o *options) { o.name, o.email = name, email }
}

func newOptions(opts []Option) options {
	o := options{name: "AI Whiteboard", email: "runs@localhost"}
	for _, opt := range opts {
		opt(&o)
	}
	return o
}

// Open returns the repository that dir (any folder inside a main or linked work tree) belongs to.
// The error is ErrNotRepo when dir is not inside a git work tree (a folder that does not exist, a
// plain folder, a bare repository, the inside of a .git folder) and ErrNoCommits when HEAD is
// unborn.
func Open(ctx context.Context, dir string, opts ...Option) (*Repo, error) {
	o := newOptions(opts)
	r := &Repo{env: gitEnv(o.env), name: o.name, email: o.email}
	abs, err := insideWorkTree(ctx, r.env, dir)
	if err != nil {
		return nil, err
	}
	out, _, err := runGit(ctx, r.env, abs, "rev-parse", "--show-toplevel", "--git-common-dir")
	if err != nil {
		return nil, err
	}
	lines := strings.Split(out, "\n")
	if len(lines) != 2 {
		return nil, fmt.Errorf("git rev-parse in %s: unexpected output %q", abs, out)
	}
	r.root = resolve(lines[0])
	r.commonDir = resolve(absIn(abs, lines[1]))
	if _, _, err := runGit(ctx, r.env, abs, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"); err != nil {
		if ctx.Err() != nil {
			return nil, err
		}
		return nil, fmt.Errorf("%w: %s", ErrNoCommits, r.root)
	}
	return r, nil
}

// IsWorkTree reports whether dir is inside a git work tree. A folder that merely has a .git entry
// is not enough, and a subfolder of a work tree is.
func IsWorkTree(ctx context.Context, dir string, opts ...Option) bool {
	_, err := insideWorkTree(ctx, gitEnv(newOptions(opts).env), dir)
	return err == nil
}

// insideWorkTree returns the absolute dir when it is inside a git work tree, else ErrNotRepo.
func insideWorkTree(ctx context.Context, env []string, dir string) (string, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	if fi, err := os.Stat(abs); err != nil {
		return "", fmt.Errorf("%w: %w", ErrNotRepo, err)
	} else if !fi.IsDir() {
		return "", fmt.Errorf("%w: %s is not a folder", ErrNotRepo, abs)
	}
	// LC_ALL=C so that git's "not a git repository" can be told from another failure (a
	// repository git refuses to use, for example).
	out, stderr, err := runGit(ctx, append(env[:len(env):len(env)], "LC_ALL=C"), abs, "rev-parse", "--is-inside-work-tree")
	switch {
	case err == nil && out == "true":
		return abs, nil
	case err == nil, strings.Contains(stderr, "not a git repository"):
		return "", fmt.Errorf("%w: %s", ErrNotRepo, abs)
	}
	return "", err
}

// Root is the top level of the work tree that the folder given to Open is in, symlinks resolved.
// A ref like "HEAD" given to the functions below means the HEAD of this work tree.
func (r *Repo) Root() string { return r.root }

// CommonDir is the git dir that the main work tree and every linked one share, symlinks resolved.
// It is the same for a Repo opened from any of them.
func (r *Repo) CommonDir() string { return r.commonDir }

// Resolve returns the full sha of the commit that ref names, or ErrUnknownRef.
func (r *Repo) Resolve(ctx context.Context, ref string) (string, error) {
	if err := checkArg("ref", ref); err != nil {
		return "", err
	}
	out, err := r.run(ctx, r.root, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	if exitCode(err) == 1 {
		return "", fmt.Errorf("%w: %s", ErrUnknownRef, ref)
	}
	return out, err
}

// BranchExists reports whether the local branch name exists.
func (r *Repo) BranchExists(ctx context.Context, name string) (bool, error) {
	if err := checkArg("branch", name); err != nil {
		return false, err
	}
	_, err := r.run(ctx, r.root, "show-ref", "--verify", "--quiet", "refs/heads/"+name)
	if exitCode(err) == 1 {
		return false, nil
	}
	return err == nil, err
}

// Branches lists the local branches whose name starts with prefix (a plain string prefix: give
// "runs/x/" for the branches under runs/x), sorted. An empty prefix lists them all.
func (r *Repo) Branches(ctx context.Context, prefix string) ([]string, error) {
	out, err := r.run(ctx, r.root, "for-each-ref", "--format=%(refname)", "refs/heads/")
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, line := range strings.Split(out, "\n") {
		if name, ok := strings.CutPrefix(line, "refs/heads/"); ok && strings.HasPrefix(name, prefix) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names, nil
}

// IsAncestor reports whether commit a is an ancestor of commit b (or the same commit).
func (r *Repo) IsAncestor(ctx context.Context, a, b string) (bool, error) {
	if err := errors.Join(checkArg("ref", a), checkArg("ref", b)); err != nil {
		return false, err
	}
	_, err := r.run(ctx, r.root, "merge-base", "--is-ancestor", a, b)
	if exitCode(err) == 1 {
		return false, nil
	}
	return err == nil, err
}

// DeleteBranch deletes the local branch name, merged or not. A branch that does not exist is not
// an error; one that is checked out in a work tree is.
func (r *Repo) DeleteBranch(ctx context.Context, name string) error {
	if ok, err := r.BranchExists(ctx, name); err != nil || !ok {
		return err
	}
	_, err := r.run(ctx, r.root, "branch", "-D", name)
	return err
}

// Dirty reports whether the work tree that dir is in (dir may be a subfolder) has uncommitted
// changes or untracked files. Ignored files do not count.
func (r *Repo) Dirty(ctx context.Context, dir string) (bool, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return false, err
	}
	out, err := r.run(ctx, abs, "rev-parse", "--git-common-dir")
	if err != nil {
		if ctx.Err() != nil {
			return false, err
		}
		return false, fmt.Errorf("%w: %s: %v", ErrNotWorktree, dir, err)
	}
	if resolve(absIn(abs, out)) != r.commonDir {
		return false, fmt.Errorf("%w: %s", ErrNotWorktree, dir)
	}
	out, err = r.run(ctx, abs, "status", "--porcelain", "--untracked-files=normal")
	return out != "", err
}

// tree is what the functions that work inside one work tree need to know about it.
type tree struct {
	top       string // its top level, symlinks resolved
	gitDir    string // its own git dir, symlinks resolved: the shared one for the main work tree
	mergeHead string // the file that exists while a merge is in progress
	linked    bool   // a linked work tree, not the main one
}

// tree checks that dir is the top level of a work tree of this repository.
func (r *Repo) tree(ctx context.Context, dir string) (tree, error) {
	abs := resolve(dir)
	out, err := r.run(ctx, abs, "rev-parse", "--show-toplevel", "--git-common-dir", "--absolute-git-dir",
		"--git-path", "MERGE_HEAD")
	if err != nil {
		if ctx.Err() != nil {
			return tree{}, err
		}
		return tree{}, fmt.Errorf("%w: %s: %v", ErrNotWorktree, dir, err)
	}
	lines := strings.Split(out, "\n")
	if len(lines) != 4 {
		return tree{}, fmt.Errorf("git rev-parse in %s: unexpected output %q", abs, out)
	}
	common := resolve(absIn(abs, lines[1]))
	if resolve(lines[0]) != abs || common != r.commonDir {
		return tree{}, fmt.Errorf("%w: %s", ErrNotWorktree, dir)
	}
	gitDir := resolve(lines[2])
	return tree{top: abs, gitDir: gitDir, mergeHead: absIn(abs, lines[3]), linked: gitDir != common}, nil
}

// checkArg refuses a ref or branch name that git would read as an option or that cannot be one.
func checkArg(what, s string) error {
	if s == "" || strings.HasPrefix(s, "-") || strings.ContainsAny(s, "\x00\n") {
		return fmt.Errorf("invalid %s %q", what, s)
	}
	return nil
}

// absIn makes a path that git printed relative to dir absolute.
func absIn(dir, path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(dir, path)
}

// resolve cleans path and resolves symlinks in it (/tmp is /private/tmp on macOS). When path does
// not exist, its deepest existing ancestor is resolved and the rest is joined back on.
func resolve(path string) string {
	path = filepath.Clean(path)
	if !filepath.IsAbs(path) {
		if a, err := filepath.Abs(path); err == nil {
			path = a
		}
	}
	rest := ""
	for cur := path; ; {
		if r, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(r, rest)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return path
		}
		rest = filepath.Join(filepath.Base(cur), rest)
		cur = parent
	}
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}
