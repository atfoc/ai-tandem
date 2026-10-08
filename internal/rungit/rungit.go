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
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
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

	// What tree learned from git about the linked work trees, by top level (see recall).
	memoMu   sync.Mutex
	memo     map[string]*remembered
	memoHits atomic.Int64 // how often recall spared a git command: for the tests
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
	if done, err := r.openAtOnce(ctx, dir); done {
		if err != nil {
			return nil, err
		}
		return r, nil
	}
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

// openAtOnce asks git with one command what Open otherwise asks with three: whether dir is inside
// a work tree, where its top level and the shared git dir are, and whether HEAD is a commit. done
// is false when what git answered is not exactly one of the answers below: Open then asks step
// by step, and nothing of r is set.
//
//   - "true", the top level, the git dir and a commit, exit 0: r is set.
//   - "true", the top level and the git dir, exit 1: HEAD is unborn (ErrNoCommits).
//   - "false" first: a bare repository or the inside of a .git folder (ErrNotRepo).
//   - Nothing but "not a git repository" on stderr: a plain folder (ErrNotRepo).
func (r *Repo) openAtOnce(ctx context.Context, dir string) (done bool, err error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return false, nil
	}
	if fi, err := os.Stat(abs); err != nil || !fi.IsDir() {
		return false, nil
	}
	// LC_ALL=C for git's "not a git repository", as in insideWorkTree.
	out, stderr, err := runGit(ctx, append(r.env[:len(r.env):len(r.env)], "LC_ALL=C"), abs, "rev-parse",
		"--is-inside-work-tree", "--show-toplevel", "--git-common-dir", "--verify", "--quiet", "HEAD^{commit}")
	code := 0
	if err != nil {
		if code = exitCode(err); code < 0 { // it did not run to its end
			return false, nil
		}
	}
	lines := strings.Split(out, "\n")
	switch {
	case out == "" && code != 0 && strings.Contains(stderr, "not a git repository"):
		return true, fmt.Errorf("%w: %s", ErrNotRepo, abs)
	case lines[0] == "false" && code != 0:
		return true, fmt.Errorf("%w: %s", ErrNotRepo, abs)
	case lines[0] != "true" || len(lines) < 3 || !filepath.IsAbs(lines[1]) || lines[2] == "":
		return false, nil
	case len(lines) == 3 && code == 1:
		return true, fmt.Errorf("%w: %s", ErrNoCommits, resolve(lines[1]))
	case len(lines) == 4 && code == 0 && isSHA(lines[3]):
		r.root = resolve(lines[1])
		r.commonDir = resolve(absIn(abs, lines[2]))
		return true, nil
	}
	return false, nil
}

// isSHA reports whether s is a full object name as git prints it: 40 hex digits, or 64.
func isSHA(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
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

// MergedBranches lists the local branches whose name starts with prefix (as for Branches) and
// whose head is the commit into or an ancestor of it, sorted: every commit such a branch names is
// in into.
func (r *Repo) MergedBranches(ctx context.Context, prefix, into string) ([]string, error) {
	if err := checkArg("ref", into); err != nil {
		return nil, err
	}
	out, err := r.run(ctx, r.root, "for-each-ref", "--format=%(refname)", "--merged", into, "refs/heads/")
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

// DeleteBranches deletes the local branches names, merged or not, with one git command when all
// goes well. As for DeleteBranch, a branch that does not exist is not an error and one that is
// checked out in a work tree is: it is left, the others are deleted all the same, and the error
// is that of the first branch that could not be deleted.
func (r *Repo) DeleteBranches(ctx context.Context, names ...string) error {
	if len(names) == 0 {
		return nil
	}
	for _, name := range names {
		if err := checkArg("branch", name); err != nil {
			return err
		}
	}
	_, err := r.run(ctx, r.root, append([]string{"branch", "-D"}, names...)...)
	if err == nil || ctx.Err() != nil {
		return err
	}
	// Git stops at no branch it cannot delete, but it does not say which ones those were in
	// words that could be relied on: what is still there is deleted one by one.
	var failed error
	for _, name := range names {
		if err := r.DeleteBranch(ctx, name); err != nil && failed == nil {
			failed = err
		}
	}
	return failed
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
//
// Git is asked, but for a linked work tree about which it gave this very answer before and whose
// files still say the same (see recall): nearly every function of the package starts here, and
// this was the most frequent git command of a run.
func (r *Repo) tree(ctx context.Context, dir string) (tree, error) {
	abs := resolve(dir)
	if ctx.Err() == nil { // a done context gets the error of the command below
		if t, ok := r.recall(abs); ok {
			return t, nil
		}
	}
	before, readable := readLinked(abs)
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
	t := tree{top: abs, gitDir: gitDir, mergeHead: absIn(abs, lines[3]), linked: gitDir != common}
	if readable && t.linked {
		r.remember(t, before)
	}
	return t, nil
}

// remembered is an answer of git about a linked work tree, with the files it follows from.
type remembered struct {
	tree  tree
	files linkFiles
}

// linkFiles is what git reads to find the git dirs and the top level of a linked work tree, and
// where that leads.
type linkFiles struct {
	dotGit    []byte // <top>/.git: "gitdir: " and the way to the work tree's own git dir
	commondir []byte // <gitDir>/commondir: the way to the shared git dir
	config    []byte // <common>/config: the format of the repository, and core.worktree
	ownConfig []byte // <gitDir>/config.worktree, where core.worktree can be too
	hasOwn    bool   // config.worktree is there
	gitDir    string // where dotGit leads, symlinks resolved
	common    string // where commondir leads, symlinks resolved
}

func (f linkFiles) equal(g linkFiles) bool {
	return bytes.Equal(f.dotGit, g.dotGit) && bytes.Equal(f.commondir, g.commondir) &&
		bytes.Equal(f.config, g.config) && bytes.Equal(f.ownConfig, g.ownConfig) && f.hasOwn == g.hasOwn &&
		f.gitDir == g.gitDir && f.common == g.common
}

// readLinked reads the linkFiles of the folder top, following them as git does: on disk (see
// linkIn), so that a path with a symlink before ".." leads elsewhere once the symlink is turned.
// ok is false when
// top is not a linked work tree whose git dirs are in order: .git is not a regular file (it is
// gone, or a folder as in a main work tree), a file cannot be read, a path leads nowhere, HEAD is
// not one, or the shared git dir has lost its objects or refs folder.
func readLinked(top string) (f linkFiles, ok bool) {
	dotGit := filepath.Join(top, ".git")
	if fi, err := os.Lstat(dotGit); err != nil || !fi.Mode().IsRegular() {
		return f, false
	}
	var err error
	if f.dotGit, err = os.ReadFile(dotGit); err != nil {
		return f, false
	}
	link, isLink := strings.CutPrefix(strings.TrimRight(string(f.dotGit), "\r\n"), "gitdir: ")
	if !isLink || link == "" {
		return f, false
	}
	if f.gitDir, err = filepath.EvalSymlinks(linkIn(top, link)); err != nil {
		return f, false
	}
	if f.commondir, err = os.ReadFile(filepath.Join(f.gitDir, "commondir")); err != nil {
		return f, false
	}
	link = strings.TrimRight(string(f.commondir), "\r\n")
	if link == "" {
		return f, false
	}
	if f.common, err = filepath.EvalSymlinks(linkIn(f.gitDir, link)); err != nil {
		return f, false
	}
	if f.config, err = os.ReadFile(filepath.Join(f.common, "config")); err != nil {
		return f, false
	}
	f.ownConfig, err = os.ReadFile(filepath.Join(f.gitDir, "config.worktree"))
	if f.hasOwn = err == nil; err != nil && !errors.Is(err, fs.ErrNotExist) {
		return f, false
	}
	return f, validHead(filepath.Join(f.gitDir, "HEAD")) &&
		isDir(filepath.Join(f.common, "objects")) && isDir(filepath.Join(f.common, "refs"))
}

// validHead reports whether path is a HEAD file as git accepts one: a ref under refs/, or a
// commit. Git takes a folder with another HEAD (an empty one, after a crash) for no git dir.
func validHead(path string) bool {
	if fi, err := os.Lstat(path); err != nil || !fi.Mode().IsRegular() {
		return false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	if ref, ok := strings.CutPrefix(string(b), "ref:"); ok {
		return strings.HasPrefix(strings.TrimLeft(ref, " \t\r\n"), "refs/")
	}
	return len(b) >= 40 && isSHA(string(b[:40]))
}

func isDir(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.IsDir()
}

// remember keeps t, the answer git just gave about a linked work tree, for recall. before is what
// readLinked gave just before git was asked. The answer is kept only when the files were the same
// before and after it, so that they are what git read, and when they lead where git says: the
// answer is then nothing but what these files say.
//
// Nothing is kept about a work tree whose config names a work tree (see namesWorktree): the
// folder core.worktree leads to is not in these files, and git is asked about it every time.
func (r *Repo) remember(t tree, before linkFiles) {
	after, ok := readLinked(t.top)
	if !ok || !after.equal(before) || after.gitDir != t.gitDir || after.common != r.commonDir ||
		t.mergeHead != filepath.Join(t.gitDir, "MERGE_HEAD") {
		return
	}
	if namesWorktree(after.config) || namesWorktree(after.ownConfig) {
		return
	}
	r.memoMu.Lock()
	if r.memo == nil {
		r.memo = map[string]*remembered{}
	}
	r.memo[t.top] = &remembered{tree: t, files: after}
	r.memoMu.Unlock()
}

// namesWorktree reports whether the config file b has the word "worktree" in it, in any letter
// case: core.worktree or extensions.worktreeConfig, however they are written. A branch or a URL
// with the word in its name counts too, which only costs what remembering would have saved.
func namesWorktree(b []byte) bool {
	return bytes.Contains(bytes.ToLower(b), []byte("worktree"))
}

// recall returns what git said before about the linked work tree with the top level top, when
// what it said still holds. Git works its four answers out from a few small files, and these are
// read again on every call; beside them only the checks of the known limit below can make git
// refuse the folder. The answer holds only when
//
//   - <top>/.git is a regular file with the same bytes as when git answered, and the path in it
//     still leads to the same git dir (a symlink on the way may have changed);
//   - <gitDir>/commondir has the same bytes and still leads to the shared git dir of r;
//   - <common>/config and <gitDir>/config.worktree have the same bytes (the second may be
//     missing, as it was), and neither has the word "worktree" in it, which remember sees to:
//     with extensions.worktreeConfig, a core.worktree in either makes another folder the work
//     tree of the commands that run here, and that folder can become another one while the
//     bytes stay (a symlink on the way to it). A repository that uses either setting is asked
//     about every time;
//   - <gitDir>/HEAD is a ref or a commit, and <common>/objects and <common>/refs are folders:
//     without them git takes the folder for no repository.
//
// Anything else, a file that cannot be read included, drops the answer, and git is asked as if
// it had never been: a folder that lost its .git, where git would go up to the enclosing
// checkout, is never answered from here. Nor is the main work tree, whose .git is a folder.
// Nothing is remembered about refs, the value of HEAD, the index or the files, and whether a
// merge is in progress is for the caller to look up each time, at t.mergeHead.
//
// The lock is held for the map alone, never while files are read or git runs.
//
// Known limit: git also refuses a repository for reasons that the files above do not show, and
// the checks here do not see them (tried on git 2.50.1):
//
//   - the repository's files belong to another user, and safe.directory in the user's own
//     config does not allow it;
//   - <common>/objects or <common>/refs cannot be searched (chmod 000, for one): git asks for
//     the permission to search them, the check here only stats them;
//   - <gitDir>/HEAD has its "refs/" after the first 255 bytes ("ref:" and 300 spaces before it,
//     for one): git reads no more of the file than that;
//   - the path in <top>/.git crosses more than 32 symlinks: git gives up there,
//     filepath.EvalSymlinks does not;
//   - a config file that is none of the files above, the user's or the system's, cannot be
//     parsed.
//
// When one of these comes to be true of a work tree that is remembered and none of the files
// above changes, the answer is still given, and every git command that follows fails in this
// folder ("fatal: not a git repository"): they do not go up, so they act on no other checkout
// and change nothing on disk, but the error is an *Error of git where it would have been
// ErrNotWorktree.
func (r *Repo) recall(top string) (tree, bool) {
	r.memoMu.Lock()
	m := r.memo[top]
	r.memoMu.Unlock()
	if m == nil {
		return tree{}, false
	}
	if now, ok := readLinked(top); ok && now.equal(m.files) {
		r.memoHits.Add(1)
		return m.tree, true
	}
	r.forget(top, m)
	return tree{}, false
}

// forget drops what is remembered about the work tree with the top level top: the answer m, or
// whatever there is when m is nil.
func (r *Repo) forget(top string, m *remembered) {
	r.memoMu.Lock()
	if m == nil || r.memo[top] == m {
		delete(r.memo, top)
	}
	r.memoMu.Unlock()
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

// linkIn is absIn for a path that a file of git names: nothing is cleaned away, so that ".."
// after a symlink leads where it leads for git, to the parent of what the symlink points at.
func linkIn(dir, path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	return dir + string(filepath.Separator) + path
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
