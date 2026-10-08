package rungit

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// The tests of what tree remembers about a linked work tree (recall). Each one lets a Repo
// remember a work tree, changes the folder behind its back and asks again: the answer must be the
// one of a Repo that remembers nothing, which is the package as it was before it remembered.

// cold is r with nothing remembered.
func cold(r *Repo) *Repo {
	return &Repo{root: r.root, commonDir: r.commonDir, env: r.env, name: r.name, email: r.email}
}

// recalled is what r remembers about the work tree at dir, or nil.
func recalled(r *Repo, dir string) *remembered {
	r.memoMu.Lock()
	defer r.memoMu.Unlock()
	return r.memo[resolve(dir)]
}

// putBack makes r remember m about the work tree at dir again, after a call dropped it.
func putBack(r *Repo, dir string, m *remembered) {
	r.memoMu.Lock()
	defer r.memoMu.Unlock()
	r.memo[resolve(dir)] = m
}

// stateOf is what git says about the work tree dir: its branch, its commit and its changes.
func stateOf(t *testing.T, dir string) string {
	t.Helper()
	return git(t, dir, "status", "--porcelain=v2", "--branch")
}

// memoCase is a repository with a linked work tree on the branch task that the Repo remembers.
// The work tree is inside the main one, as those of a run are: a git command in a folder there
// that is no work tree any more acts on the main one.
type memoCase struct {
	r    *Repo
	root string // the main work tree
	wt   string // the linked one
	own  string // its git dir
}

func newMemoCase(t *testing.T) *memoCase {
	t.Helper()
	r, root := newRepo(t)
	c := &memoCase{r: r, root: root, wt: filepath.Join(root, "runs", "x")}
	c.own = filepath.Join(r.CommonDir(), "worktrees", "x")
	must(t, r.EnsureWorktree(bg, c.wt, "task", "main"))
	return c
}

// other makes a second repository with a linked work tree runs/x of its own, on the branch theirs.
func other(t *testing.T) (r *Repo, root, wt string) {
	t.Helper()
	r, root = newRepo(t)
	wt = filepath.Join(root, "runs", "x")
	must(t, r.EnsureWorktree(bg, wt, "theirs", "main"))
	return r, root, wt
}

func TestTreeRememberedIsCheckedAgainstTheFiles(t *testing.T) {
	t.Parallel()
	cases := []struct {
		what string
		// prep changes the work tree before the Repo remembers it.
		prep func(t *testing.T, c *memoCase)
		// spoil makes the folder something that is not the work tree any more. It returns the
		// folders, besides the main work tree, that no call may change.
		spoil func(t *testing.T, c *memoCase) (watch []string)
		// mend puts the work tree back; nil when it cannot be.
		mend func(t *testing.T, c *memoCase)
	}{
		{
			what:  ".git removed",
			spoil: func(t *testing.T, c *memoCase) []string { must(t, os.Remove(filepath.Join(c.wt, ".git"))); return nil },
			mend:  func(t *testing.T, c *memoCase) { write(t, c.wt, ".git", "gitdir: "+c.own+"\n") },
		},
		{
			what: ".git points at a work tree of another repository",
			spoil: func(t *testing.T, c *memoCase) []string {
				_, root, wt := other(t)
				write(t, c.wt, ".git", read(t, wt, ".git"))
				return []string{root, wt}
			},
			mend: func(t *testing.T, c *memoCase) { write(t, c.wt, ".git", "gitdir: "+c.own+"\n") },
		},
		{
			what: "a work tree of another repository in its place",
			spoil: func(t *testing.T, c *memoCase) []string {
				theirs, root := newRepo(t)
				must(t, os.RemoveAll(c.wt))
				must(t, theirs.EnsureWorktree(bg, c.wt, "theirs", "main"))
				return []string{root, c.wt}
			},
		},
		{
			what: "its git dir moved away",
			spoil: func(t *testing.T, c *memoCase) []string {
				must(t, os.Rename(c.own, c.own+".gone"))
				return nil
			},
			mend: func(t *testing.T, c *memoCase) { must(t, os.Rename(c.own+".gone", c.own)) },
		},
		{
			what: "its record pruned",
			spoil: func(t *testing.T, c *memoCase) []string {
				must(t, os.Rename(c.wt, c.wt+".aside"))
				git(t, c.root, "worktree", "prune")
				must(t, os.Rename(c.wt+".aside", c.wt))
				if exists(c.own) {
					t.Fatal("git worktree prune left the git dir of the work tree")
				}
				return nil
			},
		},
		{
			what: "deleted and made again as a plain folder",
			spoil: func(t *testing.T, c *memoCase) []string {
				must(t, os.RemoveAll(c.wt))
				must(t, os.MkdirAll(c.wt, 0o755))
				return nil
			},
		},
		{
			what: "deleted",
			spoil: func(t *testing.T, c *memoCase) []string {
				must(t, os.RemoveAll(c.wt))
				return nil
			},
		},
		{
			what: "moved with git worktree move",
			spoil: func(t *testing.T, c *memoCase) []string {
				git(t, c.root, "worktree", "move", c.wt, c.wt+"2")
				if got, err := c.r.Branch(bg, c.wt+"2"); err != nil || got != "task" {
					t.Errorf("Branch where it was moved to = %q, %v", got, err)
				}
				must(t, os.MkdirAll(c.wt, 0o755))
				return []string{c.wt + "2"}
			},
			mend: func(t *testing.T, c *memoCase) {
				must(t, os.Remove(c.wt))
				git(t, c.root, "worktree", "move", c.wt+"2", c.wt)
			},
		},
		{
			what: ".git replaced by a repository of its own",
			spoil: func(t *testing.T, c *memoCase) []string {
				must(t, os.Remove(filepath.Join(c.wt, ".git")))
				initIn(t, c.wt, true)
				return nil
			},
		},
		{
			what: ".git replaced by a symlink to another work tree's",
			spoil: func(t *testing.T, c *memoCase) []string {
				_, root, wt := other(t)
				must(t, os.Remove(filepath.Join(c.wt, ".git")))
				must(t, os.Symlink(filepath.Join(wt, ".git"), filepath.Join(c.wt, ".git")))
				return []string{root, wt}
			},
		},
		{
			// The files of the work tree stay byte for byte what they were.
			what: "a symlink on the way to its git dir leads to another repository",
			prep: func(t *testing.T, c *memoCase) {
				link := filepath.Join(t.TempDir(), "link")
				must(t, os.Symlink(filepath.Dir(c.root), link))
				write(t, c.wt, ".git", "gitdir: "+filepath.Join(link, "repo", ".git", "worktrees", "x")+"\n")
			},
			spoil: func(t *testing.T, c *memoCase) []string {
				_, root, wt := other(t)
				link := filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(read(t, c.wt, ".git")[len("gitdir: "):]))))
				must(t, os.Remove(link))
				must(t, os.Symlink(filepath.Dir(root), link))
				return []string{root, wt}
			},
		},
		{
			what: "the HEAD of its git dir emptied",
			spoil: func(t *testing.T, c *memoCase) []string {
				write(t, c.own, "HEAD", "")
				return nil
			},
			mend: func(t *testing.T, c *memoCase) { write(t, c.own, "HEAD", "ref: refs/heads/task\n") },
		},
		{
			// With extensions.worktreeConfig git takes core.worktree for the work tree of the
			// commands that run in the folder: here the main one, the person's checkout.
			// The setting that turns it on is part of the change: a work tree whose config has it
			// is not remembered in the first place (TestTreeIsNotRememberedWhenTheConfigNamesAWorktree).
			what: "core.worktree of its own points at the main work tree",
			spoil: func(t *testing.T, c *memoCase) []string {
				write(t, c.r.CommonDir(), "config.kept", read(t, c.r.CommonDir(), "config"))
				write(t, c.r.CommonDir(), "config", read(t, c.r.CommonDir(), "config")+"[extensions]\n\tworktreeConfig = true\n")
				write(t, c.own, "config.worktree", "[core]\n\tworktree = "+c.root+"\n")
				return nil
			},
			mend: func(t *testing.T, c *memoCase) {
				must(t, os.Remove(filepath.Join(c.own, "config.worktree")))
				must(t, os.Rename(filepath.Join(c.r.CommonDir(), "config.kept"), filepath.Join(c.r.CommonDir(), "config")))
			},
		},
		{
			what: "core.worktree of the repository points at the main work tree",
			spoil: func(t *testing.T, c *memoCase) []string {
				write(t, c.r.CommonDir(), "config.kept", read(t, c.r.CommonDir(), "config"))
				write(t, c.r.CommonDir(), "config", read(t, c.r.CommonDir(), "config")+
					"[extensions]\n\tworktreeConfig = true\n[core]\n\tworktree = "+c.root+"\n")
				return nil
			},
			mend: func(t *testing.T, c *memoCase) {
				must(t, os.Rename(filepath.Join(c.r.CommonDir(), "config.kept"), filepath.Join(c.r.CommonDir(), "config")))
			},
		},
		{
			what: "the shared git dir lost its objects",
			spoil: func(t *testing.T, c *memoCase) []string {
				must(t, os.Rename(filepath.Join(c.r.CommonDir(), "objects"), filepath.Join(c.r.CommonDir(), "objects.gone")))
				return nil
			},
			mend: func(t *testing.T, c *memoCase) {
				must(t, os.Rename(filepath.Join(c.r.CommonDir(), "objects.gone"), filepath.Join(c.r.CommonDir(), "objects")))
			},
		},
	}
	calls := []struct {
		what string
		call func(r *Repo, wt string) error
	}{
		{"Merging", func(r *Repo, wt string) error { _, err := r.Merging(bg, wt); return err }},
		{"Branch", func(r *Repo, wt string) error { _, err := r.Branch(bg, wt); return err }},
		{"CommitAll", func(r *Repo, wt string) error { _, err := r.CommitAll(bg, wt, "work"); return err }},
		{"ResetDetached", func(r *Repo, wt string) error { return r.ResetDetached(bg, wt, "main") }},
	}
	for _, tc := range cases {
		t.Run(tc.what, func(t *testing.T) {
			t.Parallel()
			c := newMemoCase(t)
			if tc.prep != nil {
				tc.prep(t, c)
			}
			// A file of the main work tree that a reset there would put back, and one in the
			// folder that a commit there would take.
			write(t, c.root, "f.txt", "the person's work\n")
			write(t, c.root, "runs/notes.txt", "the person's too\n")
			write(t, c.wt, "work.txt", "work\n")
			if got, err := c.r.Branch(bg, c.wt); err != nil || got != "task" {
				t.Fatalf("Branch = %q, %v", got, err)
			}
			warm := recalled(c.r, c.wt)
			if warm == nil {
				t.Fatal("the work tree is not remembered")
			}
			hits := c.r.memoHits.Load()
			if _, err := c.r.Merging(bg, c.wt); err != nil || c.r.memoHits.Load() != hits+1 {
				t.Fatalf("Merging = %v, answered from what is remembered %d times, want 1", err, c.r.memoHits.Load()-hits)
			}
			main := stateOf(t, c.root)

			watch := tc.spoil(t, c)
			var was []string
			for _, dir := range watch {
				was = append(was, stateOf(t, dir))
			}
			hits = c.r.memoHits.Load()
			for _, call := range calls {
				putBack(c.r, c.wt, warm) // each call meets what was remembered before the change
				err := call.call(c.r, c.wt)
				if !errors.Is(err, ErrNotWorktree) {
					t.Errorf("%s = %v, want ErrNotWorktree", call.what, err)
				}
				if recalled(c.r, c.wt) != nil {
					t.Errorf("%s: the work tree is still remembered", call.what)
				}
				if want := call.call(cold(c.r), c.wt); err == nil || want == nil || err.Error() != want.Error() {
					t.Errorf("%s = %v\nwith nothing remembered: %v", call.what, err, want)
				}
			}
			if got := c.r.memoHits.Load(); got != hits {
				t.Errorf("%d calls were answered from what is remembered", got-hits)
			}
			for i, dir := range watch {
				if got := stateOf(t, dir); got != was[i] {
					t.Errorf("%s changed:\n%s\nwas:\n%s", dir, got, was[i])
				}
			}

			if tc.mend != nil {
				tc.mend(t, c)
				if got, err := c.r.Branch(bg, c.wt); err != nil || got != "task" {
					t.Errorf("Branch after it was put back = %q, %v", got, err)
				}
				if recalled(c.r, c.wt) == nil {
					t.Errorf("the work tree is not remembered after it was put back")
				}
				hits = c.r.memoHits.Load()
				sha, err := c.r.CommitAll(bg, c.wt, "work")
				if err != nil || c.r.memoHits.Load() != hits+1 {
					t.Errorf("CommitAll after it was put back = %v, answered from what is remembered %d times, want 1",
						err, c.r.memoHits.Load()-hits)
				} else if got := git(t, c.root, "rev-parse", "task"); got != sha {
					t.Errorf("the commit %s is not on the branch task (%s)", sha, got)
				}
			}
			if got := stateOf(t, c.root); got != main {
				t.Errorf("the main work tree changed:\n%s\nwas:\n%s", got, main)
			}
			if got := read(t, c.root, "f.txt"); got != "the person's work\n" {
				t.Errorf("f.txt of the main work tree is %q", got)
			}
		})
	}
}

// A core.worktree that goes through a symlink names another folder once the symlink is turned,
// and not a byte of the files that recall reads changes with it. So a work tree whose config
// names a work tree is never remembered: git is asked every time, and every call answers as
// those of a Repo that remembers nothing.
func TestTreeIsNotRememberedWhenTheConfigNamesAWorktree(t *testing.T) {
	t.Parallel()
	calls := []struct {
		what string
		call func(r *Repo, wt string) error
	}{
		{"ResetDetached", func(r *Repo, wt string) error { return r.ResetDetached(bg, wt, "main") }},
		{"CommitAll", func(r *Repo, wt string) error { _, err := r.CommitAll(bg, wt, "work"); return err }},
		{"Merging", func(r *Repo, wt string) error { _, err := r.Merging(bg, wt); return err }},
		{"Branch", func(r *Repo, wt string) error { _, err := r.Branch(bg, wt); return err }},
	}
	for _, inside := range []bool{false, true} {
		for _, in := range []string{"config.worktree", "config"} {
			what := "the work tree outside the main one, core.worktree in " + in
			if inside {
				what = "the work tree inside the main one, core.worktree in " + in
			}
			t.Run(what, func(t *testing.T) {
				t.Parallel()
				r, root := newRepo(t)
				common := r.CommonDir()
				plain := read(t, common, "config")
				write(t, common, "config", plain+"[extensions]\n\tworktreeConfig = true\n")
				wt := sibling(root, "x")
				if inside {
					wt = filepath.Join(root, "runs", "x")
				}
				must(t, r.EnsureWorktree(bg, wt, "task", "main"))
				own := filepath.Join(common, "worktrees", "x")
				// core.worktree leads to the work tree itself, through a symlink.
				way := filepath.Join(t.TempDir(), "way")
				must(t, os.Symlink(wt, way))
				if in == "config" {
					write(t, common, "config", read(t, common, "config")+"[core]\n\tworktree = "+way+"\n")
				} else {
					write(t, own, "config.worktree", "[core]\n\tworktree = "+way+"\n")
				}
				if got, err := r.Branch(bg, wt); err != nil || got != "task" {
					t.Fatalf("Branch = %q, %v", got, err)
				}
				if recalled(r, wt) != nil {
					t.Errorf("a work tree with core.worktree in %s is remembered", in)
				}

				// The person's work, and the symlink turned to where it is.
				write(t, root, "f.txt", "the person's work\n")
				write(t, root, "secret.txt", "the person's own\n")
				write(t, wt, "work.txt", "work\n")
				must(t, os.Remove(way))
				must(t, os.Symlink(root, way))
				main, head := stateOf(t, root), read(t, common, "HEAD")
				refs := git(t, root, "rev-parse", "HEAD", "main", "task")

				hits := r.memoHits.Load()
				for _, call := range calls {
					err := call.call(r, wt)
					if !errors.Is(err, ErrNotWorktree) {
						t.Errorf("%s = %v, want ErrNotWorktree", call.what, err)
					}
					if want := call.call(cold(r), wt); err == nil || want == nil || err.Error() != want.Error() {
						t.Errorf("%s = %v\nwith nothing remembered: %v", call.what, err, want)
					}
				}
				if got := r.memoHits.Load(); got != hits || recalled(r, wt) != nil {
					t.Errorf("%d calls were answered from what is remembered", got-hits)
				}
				if got := read(t, root, "f.txt"); got != "the person's work\n" {
					t.Errorf("f.txt of the main work tree is %q", got)
				}
				if b, err := os.ReadFile(filepath.Join(root, "secret.txt")); err != nil || string(b) != "the person's own\n" {
					t.Errorf("secret.txt of the main work tree is %q, %v", b, err)
				}
				if got := stateOf(t, root); got != main {
					t.Errorf("the main work tree changed:\n%s\nwas:\n%s", got, main)
				}
				if got := read(t, common, "HEAD"); got != head {
					t.Errorf("HEAD of the main work tree is %q, was %q", got, head)
				}
				if got := git(t, root, "rev-parse", "HEAD", "main", "task"); got != refs {
					t.Errorf("HEAD, main and task are at\n%s\nwere at\n%s", got, refs)
				}

				// Without the two settings it is a linked work tree like any other, and remembered.
				write(t, common, "config", plain)
				if in != "config" {
					must(t, os.Remove(filepath.Join(own, "config.worktree")))
				}
				if got, err := r.Branch(bg, wt); err != nil || got != "task" {
					t.Errorf("Branch without the settings = %q, %v", got, err)
				}
				if recalled(r, wt) == nil {
					t.Errorf("the work tree is not remembered without the settings")
				}
				hits = r.memoHits.Load()
				if _, err := r.Merging(bg, wt); err != nil || r.memoHits.Load() != hits+1 {
					t.Errorf("Merging = %v, answered from what is remembered %d times, want 1", err, r.memoHits.Load()-hits)
				}
			})
		}
	}
}

// Git follows the paths in .git and in commondir on disk: ".." after a symlink is the parent of
// what the symlink points at, not of the folder the symlink is in. Such a path leads into another
// repository once the symlink is turned, and not a byte of the files that recall reads changes
// with it: the answer must then be the one of a Repo that remembers nothing.
func TestTreeRememberedFollowsDotDotAfterASymlinkAsGitDoes(t *testing.T) {
	t.Parallel()
	for _, in := range []string{".git", "commondir"} {
		t.Run("the path in "+in, func(t *testing.T) {
			t.Parallel()
			r, root := newRepo(t)
			base := filepath.Dir(root)
			wt := filepath.Join(base, "x")
			must(t, r.EnsureWorktree(bg, wt, "task", "main"))
			own := filepath.Join(r.CommonDir(), "worktrees", "x")

			// Another repository, with a work tree record of the same name.
			theirs := filepath.Join(base, "deep", "repo")
			must(t, os.CopyFS(theirs, os.DirFS(root)))
			must(t, os.RemoveAll(filepath.Join(theirs, ".git", "worktrees")))
			write(t, theirs, "f.txt", "the other repository's\n")
			git(t, theirs, "commit", "-q", "-a", "-m", "theirs")
			theirWt := filepath.Join(base, "deep", "x")
			git(t, theirs, "worktree", "add", "-q", "-b", "theirs", theirWt, "main")
			theirCommon := filepath.Join(theirs, ".git")
			theirOwn := filepath.Join(theirCommon, "worktrees", "x")

			// The path goes through a symlink and back out of it with "..".
			sym := filepath.Join(base, "sym")
			must(t, os.Symlink(root, sym))
			if in == ".git" {
				write(t, wt, ".git", "gitdir: ../sym/../repo/.git/worktrees/x\n")
			} else {
				write(t, own, "commondir", "../../../../sym/../repo/.git\n")
			}
			// commonOf is the shared git dir that git itself finds in dir.
			commonOf := func(dir string) string {
				t.Helper()
				c, err := filepath.EvalSymlinks(git(t, dir, "rev-parse", "--path-format=absolute", "--git-common-dir"))
				must(t, err)
				return c
			}
			if got := commonOf(wt); got != r.CommonDir() {
				t.Fatalf("with the path written by hand git has the shared git dir at %s, want %s", got, r.CommonDir())
			}
			if got, err := r.Branch(bg, wt); err != nil || got != "task" {
				t.Fatalf("Branch = %q, %v", got, err)
			}
			hits := r.memoHits.Load()
			if _, err := r.Merging(bg, wt); err != nil || recalled(r, wt) == nil || r.memoHits.Load() != hits+1 {
				t.Fatalf("Merging = %v, answered from what is remembered %d times, want 1", err, r.memoHits.Load()-hits)
			}

			// The work of the task, and the symlink turned to the other repository.
			write(t, wt, "f.txt", "the work of the task\n")
			must(t, os.Remove(sym))
			must(t, os.Symlink(theirs, sym))
			if got := commonOf(wt); got != theirCommon {
				t.Fatalf("with the symlink turned git has the shared git dir at %s, want %s", got, theirCommon)
			}
			main, linked, head := stateOf(t, theirs), stateOf(t, theirWt), read(t, theirOwn, "HEAD")
			refs := git(t, theirs, "rev-parse", "HEAD", "main", "theirs")

			calls := []struct {
				what string
				call func(r *Repo) error
			}{
				{"Merging", func(r *Repo) error { _, err := r.Merging(bg, wt); return err }},
				{"ResetDetached", func(r *Repo) error { return r.ResetDetached(bg, wt, "main") }},
			}
			hits = r.memoHits.Load()
			for _, call := range calls {
				err := call.call(r)
				if !errors.Is(err, ErrNotWorktree) {
					t.Errorf("%s = %v, want ErrNotWorktree", call.what, err)
				}
				if want := call.call(cold(r)); err == nil || want == nil || err.Error() != want.Error() {
					t.Errorf("%s = %v\nwith nothing remembered: %v", call.what, err, want)
				}
			}
			if got := r.memoHits.Load(); got != hits || recalled(r, wt) != nil {
				t.Errorf("%d calls were answered from what is remembered", got-hits)
			}
			if got := read(t, wt, "f.txt"); got != "the work of the task\n" {
				t.Errorf("f.txt of the work tree is %q", got)
			}
			if got := stateOf(t, theirs); got != main {
				t.Errorf("the main work tree of the other repository changed:\n%s\nwas:\n%s", got, main)
			}
			if got := stateOf(t, theirWt); got != linked {
				t.Errorf("the work tree of the other repository changed:\n%s\nwas:\n%s", got, linked)
			}
			if got := read(t, theirOwn, "HEAD"); got != head {
				t.Errorf("HEAD of the other repository's work tree record is %q, was %q", got, head)
			}
			if got := git(t, theirs, "rev-parse", "HEAD", "main", "theirs"); got != refs {
				t.Errorf("HEAD, main and theirs of the other repository are at\n%s\nwere at\n%s", got, refs)
			}
		})
	}
}

// What namesWorktree takes for a config that names a work tree, and that the config of a
// repository as git makes it is none: its work trees are remembered.
func TestNamesWorktree(t *testing.T) {
	t.Parallel()
	for config, want := range map[string]bool{
		"": false,
		"[core]\n\trepositoryformatversion = 0\n\tbare = false\n": false,
		"[core]\n\tworktree = /somewhere\n":                       true,
		"[CORE]\n\tWorkTree = /somewhere\n":                       true,
		"[core]\n\tWORKTREE\n":                                    true,
		"[extensions]\n\tworktreeConfig = true\n":                 true,
		"[extensions]\n\tworktreeconfig = false\n":                true,
		"[include]\n\tpath = worktree.inc\n":                      true,
		"[branch \"my-WorkTree-idea\"]\n\tremote = origin\n":      true,
		"[core]\n\tworktre = e\n":                                 false,
	} {
		if got := namesWorktree([]byte(config)); got != want {
			t.Errorf("namesWorktree(%q) = %v, want %v", config, got, want)
		}
	}
	_, root := newRepo(t)
	if config := read(t, root, ".git/config"); namesWorktree([]byte(config)) {
		t.Errorf("the config of a new repository names a work tree:\n%s", config)
	}
}

func TestTreeRememberedIsUsed(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	wt := sibling(root, "x")
	must(t, r.EnsureWorktree(bg, wt, "task", "main"))
	m := recalled(r, wt)
	if m == nil {
		t.Fatal("the work tree is not remembered after EnsureWorktree made it")
	}
	// What is remembered is what git says, and what a Repo that remembers nothing gets from it.
	want, err := cold(r).tree(bg, wt)
	must(t, err)
	if m.tree != want || !want.linked || want.mergeHead != filepath.Join(want.gitDir, "MERGE_HEAD") {
		t.Errorf("remembered %+v, git says %+v", m.tree, want)
	}
	if out := git(t, wt, "rev-parse", "--git-path", "MERGE_HEAD"); out != want.mergeHead {
		t.Errorf("git has MERGE_HEAD at %s, remembered at %s", out, want.mergeHead)
	}

	// Every call that starts at tree is spared its git command.
	hits := r.memoHits.Load()
	if got, err := r.Branch(bg, wt); err != nil || got != "task" {
		t.Errorf("Branch = %q, %v", got, err)
	}
	if merging, err := r.Merging(bg, wt); err != nil || merging {
		t.Errorf("Merging = %v, %v", merging, err)
	}
	write(t, wt, "new.txt", "new\n")
	if _, err := r.CommitAll(bg, wt, "work"); err != nil {
		t.Errorf("CommitAll = %v", err)
	}
	if got, err := r.tree(bg, wt); err != nil || got != want {
		t.Errorf("tree = %+v, %v, want %+v", got, err, want)
	}
	if got := r.memoHits.Load() - hits; got != 4 {
		t.Errorf("%d of 4 calls were answered from what is remembered", got)
	}

	// A merge in progress is not remembered: it is looked up each time.
	git(t, root, "checkout", "-q", "-b", "side")
	write(t, root, "new.txt", "theirs\n")
	git(t, root, "add", "-A")
	git(t, root, "commit", "-q", "-m", "side")
	hits = r.memoHits.Load()
	if res, err := r.Merge(bg, wt, "side", "merge side", true); err != nil || len(res.Conflicts) == 0 {
		t.Fatalf("Merge = %+v, %v, want a conflict", res, err)
	}
	if merging, err := r.Merging(bg, wt); err != nil || !merging {
		t.Errorf("Merging during a merge = %v, %v", merging, err)
	}
	must(t, r.AbortMerge(bg, wt))
	if merging, err := r.Merging(bg, wt); err != nil || merging {
		t.Errorf("Merging after the merge was aborted = %v, %v", merging, err)
	}
	if got := r.memoHits.Load() - hits; got != 4 {
		t.Errorf("%d of 4 calls were answered from what is remembered", got)
	}

	// The main work tree is never remembered.
	hits = r.memoHits.Load()
	for i := 0; i < 2; i++ {
		if got, err := r.Branch(bg, root); err != nil || got != "side" {
			t.Errorf("Branch of the main work tree = %q, %v", got, err)
		}
	}
	if recalled(r, root) != nil || r.memoHits.Load() != hits {
		t.Errorf("the main work tree is remembered")
	}

	// A context that is done gets the error of the git command that did not start.
	ctx, cancel := context.WithCancel(bg)
	cancel()
	_, err = r.tree(ctx, wt)
	_, werr := cold(r).tree(ctx, wt)
	var ge *Error
	if !errors.Is(err, context.Canceled) || !errors.As(err, &ge) || ge.Cmd != "rev-parse" || werr == nil || err.Error() != werr.Error() {
		t.Errorf("tree with a done context = %v\nwith nothing remembered: %v", err, werr)
	}
	if r.memoHits.Load() != hits || recalled(r, wt) == nil {
		t.Errorf("a done context was answered from what is remembered, or made it forgotten")
	}
}

func TestTreeRememberedAfterRemoveAndAdd(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	wt := sibling(root, "x")
	must(t, r.EnsureWorktree(bg, wt, "one", "main"))
	second := open(t, root) // another Repo for the same repository, with what it remembers itself
	for _, repo := range []*Repo{r, second} {
		if got, err := repo.Branch(bg, wt); err != nil || got != "one" {
			t.Fatalf("Branch = %q, %v", got, err)
		}
		if recalled(repo, wt) == nil {
			t.Fatal("the work tree is not remembered")
		}
	}

	// RemoveWorktree forgets it; the other Repo finds out by itself.
	must(t, r.RemoveWorktree(bg, wt))
	if recalled(r, wt) != nil {
		t.Errorf("the work tree is still remembered after RemoveWorktree")
	}
	if _, err := second.Branch(bg, wt); !errors.Is(err, ErrNotWorktree) {
		t.Errorf("Branch of the removed work tree, by the other Repo = %v, want ErrNotWorktree", err)
	}
	must(t, r.EnsureWorktree(bg, wt, "two", "main"))
	for _, repo := range []*Repo{r, second} {
		if got, err := repo.Branch(bg, wt); err != nil || got != "two" {
			t.Errorf("Branch after it was added again = %q, %v, want two", got, err)
		}
	}

	// Removed and added again behind the back of both, with the same files as before: what is
	// remembered still holds, and the branch is not part of it.
	if recalled(r, wt) == nil || recalled(second, wt) == nil {
		t.Fatal("the work tree is not remembered")
	}
	git(t, root, "worktree", "remove", "--force", wt)
	git(t, root, "worktree", "add", "-q", "-b", "three", wt, "main")
	for _, repo := range []*Repo{r, second} {
		hits := repo.memoHits.Load()
		if got, err := repo.Branch(bg, wt); err != nil || got != "three" {
			t.Errorf("Branch after git added it again = %q, %v, want three", got, err)
		}
		if repo.memoHits.Load() != hits+1 {
			t.Errorf("the work tree git added again with the same files was asked about anew")
		}
		want, err := cold(repo).tree(bg, wt)
		must(t, err)
		if got, err := repo.tree(bg, wt); err != nil || got != want {
			t.Errorf("tree = %+v, %v, git says %+v", got, err, want)
		}
	}
	// Detached by ResetDetached, on a branch again by git: neither is remembered.
	must(t, r.ResetDetached(bg, wt, "main"))
	if got, err := second.Branch(bg, wt); err != nil || got != "" {
		t.Errorf("Branch after ResetDetached = %q, %v, want none", got, err)
	}
	git(t, wt, "checkout", "-q", "one")
	if got, err := r.Branch(bg, wt); err != nil || got != "one" {
		t.Errorf("Branch after a checkout = %q, %v, want one", got, err)
	}
}

func TestTreeRememberedThroughASymlink(t *testing.T) {
	t.Parallel()
	c := newMemoCase(t)
	link := filepath.Join(t.TempDir(), "link")
	must(t, os.Symlink(c.wt, link))
	hits := c.r.memoHits.Load()
	if got, err := c.r.Branch(bg, link); err != nil || got != "task" {
		t.Fatalf("Branch through a symlink = %q, %v", got, err)
	}
	if c.r.memoHits.Load() != hits+1 {
		t.Errorf("the work tree is remembered under another name through a symlink")
	}
	// The symlink now leads to a plain folder inside the main work tree.
	plain := filepath.Join(c.root, "runs", "plain")
	write(t, plain, "work.txt", "work\n")
	main := stateOf(t, c.root)
	must(t, os.Remove(link))
	must(t, os.Symlink(plain, link))
	if _, err := c.r.CommitAll(bg, link, "work"); !errors.Is(err, ErrNotWorktree) {
		t.Errorf("CommitAll through a symlink to a plain folder = %v, want ErrNotWorktree", err)
	}
	if got := stateOf(t, c.root); got != main {
		t.Errorf("the main work tree changed:\n%s\nwas:\n%s", got, main)
	}
	// And the work tree itself is still the one that is remembered.
	hits = c.r.memoHits.Load()
	if got, err := c.r.Branch(bg, c.wt); err != nil || got != "task" || c.r.memoHits.Load() != hits+1 {
		t.Errorf("Branch = %q, %v, answered from what is remembered %d times, want 1", got, err, c.r.memoHits.Load()-hits)
	}
}

// One Repo is asked about its work trees from several goroutines while one of them comes and goes
// and another loses and finds its .git: for the race detector, and no answer may be a wrong one.
func TestTreeRememberedConcurrently(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	steady, shaky, coming := sibling(root, "steady"), sibling(root, "shaky"), sibling(root, "coming")
	must(t, r.EnsureWorktree(bg, steady, "steady", "main"))
	must(t, r.EnsureWorktree(bg, shaky, "shaky", "main"))
	want := map[string]tree{}
	for _, wt := range []string{steady, shaky} {
		tr, err := cold(r).tree(bg, wt)
		must(t, err)
		want[wt] = tr
	}

	var wg sync.WaitGroup
	ask := func(wt string, times int, mayBeGone bool) {
		defer wg.Done()
		for i := 0; i < times; i++ {
			got, err := r.tree(bg, wt)
			switch {
			case err == nil && got.top == resolve(wt) && got.linked && (want[wt] == tree{} || got == want[wt]):
			case mayBeGone && errors.Is(err, ErrNotWorktree):
			default:
				t.Errorf("tree(%s) = %+v, %v", filepath.Base(wt), got, err)
				return
			}
		}
	}
	hits := r.memoHits.Load()
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go ask(steady, 200, false) // no git command: the files never change
	}
	for i := 0; i < 2; i++ {
		wg.Add(2)
		go ask(shaky, 12, true)
		go ask(coming, 12, true)
	}
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 4; i++ {
			if err := os.Rename(filepath.Join(shaky, ".git"), filepath.Join(shaky, "dot-git")); err != nil {
				t.Error(err)
				return
			}
			r.tree(bg, shaky)
			if err := os.Rename(filepath.Join(shaky, "dot-git"), filepath.Join(shaky, ".git")); err != nil {
				t.Error(err)
				return
			}
			r.tree(bg, shaky)
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 3; i++ {
			if err := r.EnsureWorktree(bg, coming, "", "main"); err != nil {
				t.Errorf("EnsureWorktree: %v", err)
				return
			}
			if err := r.RemoveWorktree(bg, coming); err != nil {
				t.Errorf("RemoveWorktree: %v", err)
				return
			}
		}
	}()
	wg.Wait()
	if got := r.memoHits.Load() - hits; got < 800 {
		t.Errorf("%d calls were answered from what is remembered, want the 800 about the steady work tree at least", got)
	}
	// An answer about the work tree that went may have been kept after RemoveWorktree forgot it
	// (it was given just before): the files say that it does not hold.
	if _, err := r.tree(bg, coming); !errors.Is(err, ErrNotWorktree) || recalled(r, coming) != nil {
		t.Errorf("tree of the removed work tree = %v, want ErrNotWorktree and nothing remembered", err)
	}
	if got, err := r.tree(bg, shaky); err != nil || got != want[shaky] {
		t.Errorf("tree of the work tree that has its .git back = %+v, %v, want %+v", got, err, want[shaky])
	}
}
