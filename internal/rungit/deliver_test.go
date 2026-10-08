package rungit

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/testset"
)

// The tests of Deliver. Each works on a person's repository of its own under t.TempDir(): three
// files committed on main (the base), and the result of a run on a branch that was made in a work
// tree next to it, the way a run makes it. There is one test per row of the table "What git did in
// my trials" of the design (T13 §2), named in the comment of each.

// delivery is a person's folder with the result of a run to apply to it.
type delivery struct {
	t      *testing.T
	root   string // the person's folder: on main, at base, clean
	base   string
	result string // base plus: a.txt changed in its first line, new.txt and sub/deep.txt added
	req    DeliverReq
}

// baseFiles is what the person's repository has at the base commit.
var baseFiles = map[string]string{"a.txt": "one\ntwo\nthree\n", "keep.txt": "keep\n", "sub/s.txt": "s\n"}

// resultFiles is what the run of newDelivery wrote.
var resultFiles = map[string]string{"a.txt": "ONE\ntwo\nthree\n", "new.txt": "new\n", "sub/deep.txt": "deep\n"}

var (
	deliveryTemplate template
	deliveryCommits  [2]string // the base and the result of deliveryTemplate
)

// variant is called first in a subtest that is one more case of something the default set of
// tests already has in the subtests named in covered. Deliver is some dozens of git commands,
// and so is each look at what it left, so such a case runs in the full set only.
func variant(t *testing.T, covered string) {
	t.Helper()
	testset.SkipUnlessFull(t, "one more case of what the default set has in: "+covered)
}

func newDelivery(t *testing.T) *delivery {
	t.Helper()
	dir := deliveryTemplate.copyOf(t, func(t *testing.T, dir string) {
		initIn(t, dir, true)
		for name, content := range baseFiles {
			write(t, dir, name, content)
		}
		git(t, dir, "add", "-A")
		git(t, dir, "commit", "-q", "-m", "init")
		base := git(t, dir, "rev-parse", "HEAD")
		// The work tree of the run goes next to the template and is removed again: nothing in
		// the repository names the place it was made in.
		deliveryCommits = [2]string{base, runResult(t, dir, "r1", base, resultFiles)}
	})
	f := &delivery{t: t, root: resolve(dir), base: deliveryCommits[0], result: deliveryCommits[1]}
	f.req = DeliverReq{Folder: f.root, Base: f.base, Result: f.result, StartBranch: "main", Auto: true,
		Scratch: sibling(f.root, "r1/apply"), Message: `Merge run "one" (r1)`}
	return f
}

// runResult commits files on top of base the way a run does: in a work tree outside the folder, on
// the integration branch of the run. The work tree is removed again, as at the end of a run.
func runResult(t *testing.T, root, run, base string, files map[string]string) string {
	t.Helper()
	wt := sibling(root, run+"/int")
	git(t, root, "worktree", "add", "-q", "-b", "aiwb/"+run+"/integration", wt, base)
	for name, content := range files {
		write(t, wt, name, content)
	}
	git(t, wt, "add", "-A", "-f")
	git(t, wt, "commit", "-q", "-m", "run "+run)
	sha := git(t, wt, "rev-parse", "HEAD")
	git(t, root, "worktree", "remove", "--force", wt)
	return sha
}

// rawGit is git with its output as it wrote it: the first column of a status line is a space.
func rawGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, stderr, err := runRaw(bg, gitEnv(hermetic), dir, args...)
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, stderr)
	}
	return out
}

// tryGit is git for a command that is expected to stop: a merge that conflicts, a paused rebase.
func tryGit(dir string, env []string, args ...string) error {
	_, _, err := runGit(bg, gitEnv(append(append([]string(nil), hermetic...), env...)), dir, args...)
	return err
}

func status(t *testing.T, dir string) string {
	t.Helper()
	return rawGit(t, dir, "status", "--porcelain")
}

// checkoutState is everything of a work tree that a refused or a dry delivery must leave as it
// was: HEAD and its branch, the index, the status (ignored files too), the git operation in
// progress, and every file, byte for byte.
func checkoutState(t *testing.T, root string) string {
	t.Helper()
	var b strings.Builder
	// One git command for HEAD, where the files of an operation are, and the branch (the last
	// line: "HEAD" when the head is detached).
	args := []string{"rev-parse", "HEAD"}
	for _, name := range busyFiles {
		args = append(args, "--git-path", name)
	}
	lines := strings.Split(git(t, root, append(args, "--symbolic-full-name", "HEAD")...), "\n")
	if len(lines) != len(busyFiles)+2 {
		t.Fatalf("git rev-parse printed %q", lines)
	}
	fmt.Fprintf(&b, "HEAD %s (%s)\n", lines[0], strings.TrimPrefix(lines[len(lines)-1], "HEAD"))
	b.WriteString("status:\n" + rawGit(t, root, "status", "--porcelain", "--ignored"))
	b.WriteString("index:\n" + rawGit(t, root, "ls-files", "--stage"))
	for i, name := range busyFiles {
		path := absIn(root, lines[i+1])
		if data, err := os.ReadFile(path); err == nil {
			fmt.Fprintf(&b, "%s: %q\n", name, data)
		} else if exists(path) {
			fmt.Fprintf(&b, "%s exists\n", name)
		}
	}
	must(t, filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Name() == ".git" {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		fi, err := d.Info()
		if err != nil {
			return err
		}
		if d.IsDir() {
			fmt.Fprintf(&b, "dir %s\n", rel)
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		fmt.Fprintf(&b, "file %s %v %q\n", rel, fi.Mode(), data)
		return nil
	}))
	return b.String()
}

// folderState is checkoutState plus what the repository has: its refs and its work trees (a
// scratch work tree that was left behind shows here).
func folderState(t *testing.T, root string) string {
	t.Helper()
	return checkoutState(t, root) + "refs:\n" + git(t, root, "for-each-ref", "--format=%(refname) %(objectname)") +
		worktreesMark + git(t, root, "worktree", "list", "--porcelain") + "\n"
}

// worktreesMark is what comes before the list of work trees, the last part of a folderState.
const worktreesMark = "\nworktrees:\n"

// deliver is Deliver with the request of f.
func (f *delivery) deliver() Delivery {
	return Deliver(bg, f.req, WithEnv(hermetic...))
}

func (f *delivery) dry() Delivery {
	req := f.req
	req.DryRun = true
	return Deliver(bg, req, WithEnv(hermetic...))
}

func same(t *testing.T, what string, got, want Delivery) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s:\n got %+v\nwant %+v", what, got, want)
	}
}

// unchanged fails the test when the folder or its repository is not as before.
func (f *delivery) unchanged(what, before string) {
	f.t.Helper()
	after := folderState(f.t, f.root)
	if after != before {
		f.t.Errorf("%s changed the folder:\n--- before\n%s\n--- after\n%s", what, before, after)
	}
	_, list, _ := strings.Cut(after, worktreesMark) // the list git just printed: not asked for twice
	f.noScratchIn(list)
}

// noScratch fails the test when a scratch work tree is left, as a folder or on git's record.
func (f *delivery) noScratch() {
	f.t.Helper()
	f.noScratchIn(git(f.t, f.root, "worktree", "list", "--porcelain"))
}

// noScratchIn is noScratch with list as what git worktree list --porcelain prints.
func (f *delivery) noScratchIn(list string) {
	f.t.Helper()
	if exists(f.req.Scratch) {
		f.t.Errorf("the scratch folder %s is left", f.req.Scratch)
	}
	if strings.Contains(list, "apply") {
		f.t.Errorf("a scratch work tree is still on record:\n%s", list)
	}
}

// refuses checks that a dry run and then a real delivery both end as want, and that neither
// changed anything: HEAD, the index, the status, the files, the refs, the work trees.
func (f *delivery) refuses(want Delivery) {
	f.t.Helper()
	before := folderState(f.t, f.root)
	same(f.t, "dry run", f.dry(), want)
	f.unchanged("the dry run", before)
	same(f.t, "delivery", f.deliver(), want)
	f.unchanged("the refused delivery", before)
}

// applies checks that a dry run expects the delivery to work and changes nothing, and that the
// delivery then is applied in the way how. It returns the folder's head afterwards.
func (f *delivery) applies(how string) string {
	f.t.Helper()
	before := folderState(f.t, f.root)
	branch := strings.TrimPrefix(git(f.t, f.root, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD")
	same(f.t, "dry run", f.dry(), Delivery{State: "pending", Branch: branch})
	f.unchanged("the dry run", before)

	got := f.deliver()
	head := git(f.t, f.root, "rev-parse", "HEAD")
	same(f.t, "delivery", got, Delivery{State: "applied", How: how, Commit: head, Branch: branch})
	if how == "ff" && head != f.req.Result {
		f.t.Errorf("after a fast-forward HEAD is %s, want the result %s", head, f.req.Result)
	}
	if now := strings.TrimPrefix(git(f.t, f.root, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD"); now != branch {
		f.t.Errorf("the folder is on %q now, it was on %q", now, branch)
	}
	if git(f.t, f.root, "merge-base", f.req.Result, head) != f.req.Result {
		f.t.Errorf("the result %s is not in HEAD %s", f.req.Result, head)
	}
	f.noScratch()
	return head
}

// files fails the test when a file of the folder does not have the content given for it.
func (f *delivery) files(want map[string]string) {
	f.t.Helper()
	for name, content := range want {
		if got := read(f.t, f.root, name); got != content {
			f.t.Errorf("%s is %q, want %q", name, got, content)
		}
	}
}

func parentsOf(t *testing.T, dir, rev string) []string {
	t.Helper()
	return strings.Fields(git(t, dir, "rev-list", "--parents", "-1", rev))[1:]
}

// Row "HEAD at base, clean": a fast-forward.
func TestDeliverFastForward(t *testing.T) {
	t.Parallel()
	f := newDelivery(t)
	if st := status(t, f.root); st != "" {
		t.Fatalf("status before: %q", st)
	}
	f.files(baseFiles)

	if head := f.applies("ff"); head != f.result {
		t.Errorf("HEAD = %s, want %s", head, f.result)
	}
	if st := status(t, f.root); st != "" {
		t.Errorf("status after: %q", st)
	}
	f.files(resultFiles)
	f.files(map[string]string{"keep.txt": "keep\n", "sub/s.txt": "s\n"})
	if got := git(t, f.root, "rev-parse", "main"); got != f.result {
		t.Errorf("main = %s, want the result", got)
	}
}

// Row "Clean, own commits": a merge commit built outside, then a fast-forward to it.
func TestDeliverMergesWithOwnCommits(t *testing.T) {
	t.Parallel()
	f := newDelivery(t)
	write(t, f.root, "keep.txt", "keep\nmine\n")
	write(t, f.root, "own.txt", "own\n")
	git(t, f.root, "add", "-A")
	git(t, f.root, "commit", "-q", "-m", "my own work")
	mine := git(t, f.root, "rev-parse", "HEAD")

	head := f.applies("merge")
	if got := parentsOf(t, f.root, head); !reflect.DeepEqual(got, []string{mine, f.result}) {
		t.Errorf("parents = %v, want the person's commit first, then the result", got)
	}
	if got := git(t, f.root, "log", "-1", "--format=%s|%an|%ae|%cn|%ce"); got != `Merge run "one" (r1)|Tester|tester@example.com|Tester|tester@example.com` {
		t.Errorf("the merge commit is %q", got)
	}
	if st := status(t, f.root); st != "" {
		t.Errorf("status after: %q", st)
	}
	f.files(resultFiles)
	f.files(map[string]string{"keep.txt": "keep\nmine\n", "own.txt": "own\n", "sub/s.txt": "s\n"})
}

// Row "Own commits that conflict": the conflict is found outside, the folder is not touched.
func TestDeliverConflict(t *testing.T) {
	t.Parallel()
	f := newDelivery(t)
	write(t, f.root, "a.txt", "mine\ntwo\nthree\n")
	git(t, f.root, "commit", "-q", "-am", "my own first line")
	write(t, f.root, "note.txt", "a note\n") // and an untracked file, which stays

	f.refuses(Delivery{State: "blocked", Reason: "conflict", Branch: "main", Files: []string{"a.txt"}})
	f.files(map[string]string{"a.txt": "mine\ntwo\nthree\n", "note.txt": "a note\n"})
}

// Row "Dirty, no overlap (unstaged, staged, untracked)": applied, the changes are still there and
// the staged ones are still staged. Also diverged plus dirty, through the merge outside.
func TestDeliverKeepsLocalChangesItDoesNotTouch(t *testing.T) {
	t.Parallel()
	for _, how := range []string{"ff", "merge"} {
		t.Run(how, func(t *testing.T) {
			if how != "ff" {
				variant(t, "ff")
			}
			t.Parallel()
			f := newDelivery(t)
			if how == "merge" {
				write(t, f.root, "own.txt", "own\n")
				git(t, f.root, "add", "-A")
				git(t, f.root, "commit", "-q", "-m", "my own work")
			}
			write(t, f.root, "keep.txt", "keep\nunstaged\n")
			write(t, f.root, "sub/s.txt", "s\nstaged\n")
			write(t, f.root, "added.txt", "staged new file\n")
			git(t, f.root, "add", "sub/s.txt", "added.txt")
			write(t, f.root, "sub/s.txt", "s\nstaged\nand edited again\n")
			write(t, f.root, "note.txt", "untracked\n")
			const dirty = "A  added.txt\n M keep.txt\nMM sub/s.txt\n?? note.txt\n"
			if st := status(t, f.root); st != dirty {
				t.Fatalf("status before: %q", st)
			}
			staged := rawGit(t, f.root, "diff", "--cached")

			f.applies(how)
			if st := status(t, f.root); st != dirty {
				t.Errorf("status after: %q, want %q", st, dirty)
			}
			if got := rawGit(t, f.root, "diff", "--cached"); got != staged {
				t.Errorf("what is staged changed:\n%s\nwas:\n%s", got, staged)
			}
			f.files(resultFiles)
			f.files(map[string]string{"keep.txt": "keep\nunstaged\n", "sub/s.txt": "s\nstaged\nand edited again\n",
				"added.txt": "staged new file\n", "note.txt": "untracked\n"})
		})
	}
}

// Row "Unstaged or staged change to a file the result changes, even with identical content".
func TestDeliverLocalChangesBlock(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		setup func(f *delivery)
	}{
		{"unstaged", func(f *delivery) { write(f.t, f.root, "a.txt", "one\ntwo\nmine\n") }},
		{"unstaged, identical to the result", func(f *delivery) { write(f.t, f.root, "a.txt", resultFiles["a.txt"]) }},
		{"staged", func(f *delivery) {
			write(f.t, f.root, "a.txt", "one\ntwo\nmine\n")
			git(f.t, f.root, "add", "a.txt")
		}},
		{"staged, and the file put back", func(f *delivery) {
			write(f.t, f.root, "a.txt", "one\ntwo\nmine\n")
			git(f.t, f.root, "add", "a.txt")
			write(f.t, f.root, "a.txt", baseFiles["a.txt"])
		}},
		{"own commits and unstaged", func(f *delivery) {
			write(f.t, f.root, "own.txt", "own\n")
			git(f.t, f.root, "add", "-A")
			git(f.t, f.root, "commit", "-q", "-m", "my own work")
			write(f.t, f.root, "a.txt", "one\ntwo\nmine\n")
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.name != "unstaged" && c.name != "staged" {
				variant(t, "unstaged and staged")
			}
			t.Parallel()
			f := newDelivery(t)
			c.setup(f)
			f.refuses(Delivery{State: "blocked", Reason: "local_changes", Branch: "main", Files: []string{"a.txt"}})
		})
	}
}

// Where the design's table did not hold with git 2.50.1: a staged change that is exactly what the
// result has is no obstacle to git (its two-tree merge keeps an index entry that already matches
// the target), and neither is a file the person deleted without staging that. Nothing of the
// person's is lost in either case, and the dry run says the same as git.
func TestDeliverLocalChangesThatGitAccepts(t *testing.T) {
	t.Parallel()
	t.Run("staged, identical to the result", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		write(t, f.root, "a.txt", resultFiles["a.txt"])
		git(t, f.root, "add", "a.txt")
		f.applies("ff")
		if st := status(t, f.root); st != "" {
			t.Errorf("status after: %q", st)
		}
		f.files(resultFiles)
	})
	t.Run("staged identical, then edited again", func(t *testing.T) {
		variant(t, "staged, identical to the result")
		t.Parallel()
		f := newDelivery(t)
		write(t, f.root, "a.txt", resultFiles["a.txt"])
		git(t, f.root, "add", "a.txt")
		write(t, f.root, "a.txt", resultFiles["a.txt"]+"more of mine\n")
		f.applies("ff")
		if st := status(t, f.root); st != " M a.txt\n" {
			t.Errorf("status after: %q", st)
		}
		f.files(map[string]string{"a.txt": resultFiles["a.txt"] + "more of mine\n"})
	})
	t.Run("deleted, not staged", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		must(t, os.Remove(filepath.Join(f.root, "a.txt")))
		f.applies("ff")
		f.files(resultFiles)
	})
}

// Row "Untracked file where the result adds one, even identical".
func TestDeliverUntrackedFilesBlock(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		setup func(f *delivery)
		files []string
	}{
		{"a file", func(f *delivery) { write(f.t, f.root, "new.txt", "mine\n") }, []string{"new.txt"}},
		{"an identical file", func(f *delivery) { write(f.t, f.root, "new.txt", resultFiles["new.txt"]) }, []string{"new.txt"}},
		{"two files", func(f *delivery) {
			write(f.t, f.root, "new.txt", "mine\n")
			write(f.t, f.root, "sub/deep.txt", "mine\n")
		}, []string{"new.txt", "sub/deep.txt"}},
		{"a folder with a file where the result adds a file", func(f *delivery) { write(f.t, f.root, "new.txt/inside", "mine\n") },
			[]string{"new.txt"}},
		{"a staged new file", func(f *delivery) {
			write(f.t, f.root, "new.txt", "mine\n")
			git(f.t, f.root, "add", "new.txt")
		}, []string{"new.txt"}},
		{"an untracked file and a changed one", func(f *delivery) {
			write(f.t, f.root, "new.txt", "mine\n")
			write(f.t, f.root, "a.txt", "one\ntwo\nmine\n")
		}, []string{"a.txt", "new.txt"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.name != "a file" {
				variant(t, "a file")
			}
			t.Parallel()
			f := newDelivery(t)
			c.setup(f)
			f.refuses(Delivery{State: "blocked", Reason: "local_changes", Branch: "main", Files: c.files})
		})
	}

	t.Run("a file where the result adds a folder", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		f.result = runResult(t, f.root, "r2", f.base, map[string]string{"docs/readme.md": "docs\n"})
		f.req.Result = f.result
		write(t, f.root, "docs", "my file named docs\n")
		f.refuses(Delivery{State: "blocked", Reason: "local_changes", Branch: "main", Files: []string{"docs"}})
	})
	t.Run("an empty folder is no obstacle", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		must(t, os.MkdirAll(filepath.Join(f.root, "new.txt", "empty"), 0o755))
		f.applies("ff")
		f.files(resultFiles)
	})
	t.Run("more than fifty", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		files := map[string]string{}
		var want []string
		for i := 0; i < 60; i++ {
			name := fmt.Sprintf("gen/f%02d.txt", i)
			files[name] = "generated\n"
			write(t, f.root, name, "mine\n")
			if i < maxDeliveryFiles {
				want = append(want, name)
			}
		}
		f.result = runResult(t, f.root, "r2", f.base, files)
		f.req.Result = f.result
		f.refuses(Delivery{State: "blocked", Reason: "local_changes", Branch: "main", Files: want, More: 10})
	})
}

// Row "Ignored file where the result adds one": without --no-overwrite-ignore git overwrites it
// and says nothing. Also an ignored folder in the way.
func TestDeliverIgnoredFilesBlock(t *testing.T) {
	t.Parallel()
	t.Run("file", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		write(t, f.root, ".git/info/exclude", "new.txt\n")
		write(t, f.root, "new.txt", "my secret, ignored\n")
		if st := status(t, f.root); st != "" {
			t.Fatalf("the ignored file shows in the status: %q", st)
		}
		f.refuses(Delivery{State: "blocked", Reason: "local_changes", Branch: "main", Files: []string{"new.txt"}})
		f.files(map[string]string{"new.txt": "my secret, ignored\n"})
	})
	t.Run("ignored by a committed .gitignore", func(t *testing.T) {
		variant(t, "file")
		t.Parallel()
		f := newDelivery(t)
		write(t, f.root, ".gitignore", "*.env\n")
		git(t, f.root, "add", "-A")
		git(t, f.root, "commit", "-q", "-m", "ignore env files")
		f.base = git(t, f.root, "rev-parse", "HEAD")
		f.result = runResult(t, f.root, "r2", f.base, map[string]string{"prod.env": "from the run\n"})
		f.req.Base, f.req.Result = f.base, f.result
		write(t, f.root, "prod.env", "my secret, ignored\n")
		f.refuses(Delivery{State: "blocked", Reason: "local_changes", Branch: "main", Files: []string{"prod.env"}})
		f.files(map[string]string{"prod.env": "my secret, ignored\n"})
	})
	t.Run("folder", func(t *testing.T) {
		variant(t, "file")
		t.Parallel()
		f := newDelivery(t)
		write(t, f.root, ".git/info/exclude", "new.txt\n")
		write(t, f.root, "new.txt/inside", "mine, ignored\n")
		f.refuses(Delivery{State: "blocked", Reason: "local_changes", Branch: "main", Files: []string{"new.txt"}})
		f.files(map[string]string{"new.txt/inside": "mine, ignored\n"})
	})
}

// Row "Detached HEAD": automatic only when the run started detached, else by hand.
func TestDeliverDetachedHead(t *testing.T) {
	t.Parallel()
	detached := func(t *testing.T) *delivery {
		f := newDelivery(t)
		git(t, f.root, "checkout", "-q", "--detach")
		return f
	}
	check := func(t *testing.T, f *delivery) {
		t.Helper()
		if err := tryGit(f.root, nil, "symbolic-ref", "-q", "HEAD"); err == nil {
			t.Error("HEAD is on a branch now")
		}
		if got := git(t, f.root, "rev-parse", "main"); got != f.base {
			t.Errorf("main moved to %s", got)
		}
		f.files(resultFiles)
	}
	t.Run("automatic, the run started on main", func(t *testing.T) {
		t.Parallel()
		f := detached(t)
		f.refuses(Delivery{State: "pending", Reason: "other_branch"})
	})
	t.Run("automatic, the run started detached", func(t *testing.T) {
		t.Parallel()
		f := detached(t)
		f.req.StartBranch = ""
		f.applies("ff")
		check(t, f)
	})
	t.Run("by hand", func(t *testing.T) {
		t.Parallel()
		f := detached(t)
		f.req.Auto = false
		// No branch named, and another one named: the default set has both in
		// TestDeliverLookingAtTheResult, and here what only this subtest has, a detached HEAD
		// that is named.
		if testset.Full() {
			f.refuses(Delivery{State: "pending", Reason: "other_branch"})
			f.req.Branch = "main"
			f.refuses(Delivery{State: "pending", Reason: "other_branch"})
		}
		f.req.Branch = "HEAD"
		f.applies("ff")
		check(t, f)
	})
	t.Run("the run started detached and the folder is on a branch now", func(t *testing.T) {
		variant(t, "the two automatic ones")
		t.Parallel()
		f := newDelivery(t)
		f.req.StartBranch = ""
		f.refuses(Delivery{State: "pending", Reason: "other_branch", Branch: "main"})
		f.req.Auto, f.req.Branch = false, "HEAD"
		f.refuses(Delivery{State: "pending", Reason: "other_branch", Branch: "main"})
		f.req.Branch = "main"
		f.applies("ff")
	})
}

// Row "Another branch than at start": never automatic; by hand when the request names the branch,
// with the merge outside into that branch.
func TestDeliverOtherBranch(t *testing.T) {
	t.Parallel()
	t.Run("diverged", func(t *testing.T) {
		variant(t, "at the base")
		t.Parallel()
		f := newDelivery(t)
		git(t, f.root, "checkout", "-q", "-b", "feature")
		write(t, f.root, "feature.txt", "feature\n")
		git(t, f.root, "add", "-A")
		git(t, f.root, "commit", "-q", "-m", "feature work")
		mine := git(t, f.root, "rev-parse", "HEAD")
		other := Delivery{State: "pending", Reason: "other_branch", Branch: "feature"}

		f.refuses(other) // automatic
		f.req.Auto = false
		f.refuses(other) // by hand, no branch named
		f.req.Branch = "main"
		f.refuses(other) // by hand, the person saw another branch
		f.req.Branch = "feature"
		head := f.applies("merge")
		if got := parentsOf(t, f.root, head); !reflect.DeepEqual(got, []string{mine, f.result}) {
			t.Errorf("parents = %v, want the person's commit first", got)
		}
		if got := git(t, f.root, "rev-parse", "main"); got != f.base {
			t.Errorf("main moved to %s", got)
		}
		f.files(resultFiles)
		f.files(map[string]string{"feature.txt": "feature\n"})
	})
	t.Run("at the base", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		git(t, f.root, "checkout", "-q", "-b", "feature")
		f.refuses(Delivery{State: "pending", Reason: "other_branch", Branch: "feature"})
		f.req.Auto, f.req.Branch = false, "refs/heads/feature"
		f.applies("ff")
		if got := git(t, f.root, "rev-parse", "main"); got != f.base {
			t.Errorf("main moved to %s", got)
		}
	})
	t.Run("on the start branch the named branch does not matter", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		f.req.Auto, f.req.Branch = false, "feature"
		f.applies("ff")
	})
}

// Row "cwd is a sub-folder": the whole work tree gets the result.
func TestDeliverFromASubFolder(t *testing.T) {
	t.Parallel()
	f := newDelivery(t)
	f.req.Folder = filepath.Join(f.root, "sub")
	write(t, f.root, "sub/s.txt", "s\nmine\n") // a change of the person's in the sub-folder stays
	f.applies("ff")
	f.files(resultFiles) // a.txt and new.txt are outside the sub-folder
	f.files(map[string]string{"sub/s.txt": "s\nmine\n"})
	if st := status(t, f.root); st != " M sub/s.txt\n" {
		t.Errorf("status after: %q", st)
	}

	t.Run("blocked", func(t *testing.T) {
		f := newDelivery(t)
		f.req.Folder = filepath.Join(f.root, "sub")
		write(t, f.root, "a.txt", "one\ntwo\nmine\n")
		f.refuses(Delivery{State: "blocked", Reason: "local_changes", Branch: "main", Files: []string{"a.txt"}})
	})
}

// Row "Folder or .git gone", and a result that is gone.
func TestDeliverFolderOrRepositoryGone(t *testing.T) {
	t.Parallel()
	// files is every file below dir with its content.
	files := func(t *testing.T, dir string) map[string]string {
		m := map[string]string{}
		must(t, filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			data, err := os.ReadFile(path)
			m[path] = string(data)
			return err
		}))
		return m
	}
	t.Run("the folder is gone", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		must(t, os.RemoveAll(f.root))
		same(t, "delivery", f.deliver(), Delivery{State: "blocked", Reason: "folder_missing"})
		same(t, "dry run", f.dry(), Delivery{State: "blocked", Reason: "folder_missing"})
		if exists(f.root) {
			t.Error("the folder was made again")
		}
	})
	t.Run("the folder is a file", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		must(t, os.RemoveAll(f.root))
		must(t, os.WriteFile(f.root, []byte("a file\n"), 0o644))
		same(t, "delivery", f.deliver(), Delivery{State: "blocked", Reason: "folder_missing"})
		f.req.Folder = ""
		same(t, "no folder", f.deliver(), Delivery{State: "blocked", Reason: "folder_missing"})
	})
	t.Run(".git is gone", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		must(t, os.RemoveAll(filepath.Join(f.root, ".git")))
		before := files(t, f.root)
		same(t, "delivery", f.deliver(), Delivery{State: "blocked", Reason: "not_repo"})
		same(t, "dry run", f.dry(), Delivery{State: "blocked", Reason: "not_repo"})
		if after := files(t, f.root); !reflect.DeepEqual(after, before) {
			t.Errorf("the files changed: %v, were %v", after, before)
		}
	})
	t.Run("the folder is another repository now", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		must(t, os.RemoveAll(filepath.Join(f.root, ".git")))
		git(t, f.root, "init", "-q", "-b", "main")
		git(t, f.root, "config", "user.name", "Tester")
		git(t, f.root, "config", "user.email", "tester@example.com")
		before := files(t, f.root)
		same(t, "no commit yet", f.deliver(), Delivery{State: "blocked", Reason: "not_repo"})
		git(t, f.root, "add", "-A")
		git(t, f.root, "commit", "-q", "-m", "a new start")
		f.refuses(Delivery{State: "blocked", Reason: "not_repo"})
		if after := files(t, f.root); len(after) < len(before) {
			t.Errorf("files are gone: %v, were %v", after, before)
		}
	})
	t.Run("the result is gone", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		results := []string{strings.Repeat("0123456789", 4), "aiwb/r9/integration", "", "--force"}
		if !testset.Full() {
			// One name of what is not there, and the one that git would take for an option.
			results = []string{results[0], "--force"}
		}
		for _, result := range results {
			f.req.Result = result
			f.refuses(Delivery{State: "blocked", Reason: "result_missing"})
		}
		// The repository lost the commit itself: the branch is deleted and the objects are pruned.
		f.req.Result = f.result
		git(t, f.root, "branch", "-D", "aiwb/r1/integration")
		git(t, f.root, "reflog", "expire", "--expire=now", "--all")
		git(t, f.root, "gc", "-q", "--prune=now")
		f.refuses(Delivery{State: "blocked", Reason: "result_missing"})
	})
	t.Run("the result's branch is deleted, the commit is still there", func(t *testing.T) {
		variant(t, "the folder is gone, the folder is another repository now and the result is gone")
		t.Parallel()
		f := newDelivery(t)
		git(t, f.root, "branch", "-D", "aiwb/r1/integration")
		f.applies("ff")
	})
}

// Row "A second run was applied first": the merge outside, or a conflict.
func TestDeliverAfterAnotherRun(t *testing.T) {
	testset.SkipUnlessFull(t, "three deliveries in a row; TestDeliverFastForward, TestDeliverMergesWithOwnCommits and TestDeliverConflict have one each")
	t.Parallel()
	f := newDelivery(t)
	f.applies("ff")
	first := f.result

	// A second run from the same base that changed other files.
	f.result = runResult(t, f.root, "r2", f.base, map[string]string{"keep.txt": "kept by r2\n", "two.txt": "two\n"})
	f.req.Result, f.req.Scratch, f.req.Message = f.result, sibling(f.root, "r2/apply"), `Merge run "two" (r2)`
	head := f.applies("merge")
	if got := parentsOf(t, f.root, head); !reflect.DeepEqual(got, []string{first, f.result}) {
		t.Errorf("parents = %v, want the first run's result, then the second's", got)
	}
	f.files(resultFiles)
	f.files(map[string]string{"keep.txt": "kept by r2\n", "two.txt": "two\n"})
	if st := status(t, f.root); st != "" {
		t.Errorf("status after: %q", st)
	}

	// A third one that changed the line the first one changed.
	f.result = runResult(t, f.root, "r3", f.base, map[string]string{"a.txt": "EINS\ntwo\nthree\n"})
	f.req.Result, f.req.Scratch = f.result, sibling(f.root, "r3/apply")
	f.refuses(Delivery{State: "blocked", Reason: "conflict", Branch: "main", Files: []string{"a.txt"}})
	if got := git(t, f.root, "rev-parse", "HEAD"); got != head {
		t.Errorf("HEAD = %s, want %s", got, head)
	}
}

// conflictWith leaves the person's folder on main with a commit of its own to keep.txt, and makes
// the branch other with a commit that conflicts with it.
func conflictWith(t *testing.T, f *delivery) {
	t.Helper()
	git(t, f.root, "checkout", "-q", "-b", "other")
	write(t, f.root, "keep.txt", "theirs\n")
	git(t, f.root, "commit", "-q", "-am", "theirs")
	git(t, f.root, "checkout", "-q", "main")
	write(t, f.root, "keep.txt", "mine\n")
	git(t, f.root, "commit", "-q", "-am", "mine")
}

// Rows "Merge or cherry-pick with unmerged files", "Merge resolved but not concluded" and
// "Interactive rebase paused at edit", and the other operations step 5 looks for.
func TestDeliverBusy(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		setup  func(t *testing.T, f *delivery)
		branch string // the folder's branch in that state
	}{
		{"a merge with unmerged files", func(t *testing.T, f *delivery) {
			conflictWith(t, f)
			if tryGit(f.root, nil, "merge", "other") == nil {
				t.Fatal("the merge did not conflict")
			}
		}, "main"},
		{"a cherry-pick with unmerged files", func(t *testing.T, f *delivery) {
			conflictWith(t, f)
			if tryGit(f.root, nil, "cherry-pick", "other") == nil {
				t.Fatal("the cherry-pick did not conflict")
			}
		}, "main"},
		{"a merge that is resolved and not concluded", func(t *testing.T, f *delivery) {
			conflictWith(t, f)
			tryGit(f.root, nil, "merge", "other")
			write(t, f.root, "keep.txt", "both\n")
			git(t, f.root, "add", "keep.txt")
			if out := git(t, f.root, "ls-files", "--unmerged"); out != "" {
				t.Fatalf("still unmerged: %s", out)
			}
		}, "main"},
		{"a merge without a conflict that waits for its commit", func(t *testing.T, f *delivery) {
			git(t, f.root, "checkout", "-q", "-b", "other")
			write(t, f.root, "other.txt", "other\n")
			git(t, f.root, "add", "-A")
			git(t, f.root, "commit", "-q", "-m", "other")
			git(t, f.root, "checkout", "-q", "main")
			git(t, f.root, "merge", "-q", "--no-ff", "--no-commit", "other")
		}, "main"},
		{"an interactive rebase paused at edit", func(t *testing.T, f *delivery) {
			for _, line := range []string{"second", "third"} {
				write(t, f.root, "keep.txt", line+"\n")
				git(t, f.root, "commit", "-q", "-am", line)
			}
			edit := `GIT_SEQUENCE_EDITOR=f() { sed -e '1s/^pick/edit/' "$1" > "$1.new" && mv "$1.new" "$1"; }; f`
			if err := tryGit(f.root, []string{edit}, "rebase", "-i", "HEAD~1"); err != nil {
				t.Fatal(err)
			}
			if out := git(t, f.root, "ls-files", "--unmerged"); out != "" {
				t.Fatalf("unmerged: %s", out)
			}
			if !exists(filepath.Join(f.root, ".git", "rebase-merge")) {
				t.Skip("this git does not pause an interactive rebase with a rebase-merge folder")
			}
			// HEAD is detached now, and without step 5 git would fast-forward it: ask as a
			// person who saw that.
			f.req.Auto, f.req.Branch = false, "HEAD"
		}, ""},
		{"a revert that is not committed", func(t *testing.T, f *delivery) {
			write(t, f.root, "keep.txt", "second\n")
			git(t, f.root, "commit", "-q", "-am", "second")
			git(t, f.root, "revert", "--no-commit", "HEAD")
		}, "main"},
		{"a bisect", func(t *testing.T, f *delivery) {
			git(t, f.root, "bisect", "start")
		}, "main"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.name != "a merge with unmerged files" && c.name != "an interactive rebase paused at edit" {
				variant(t, "a merge with unmerged files and an interactive rebase paused at edit")
			}
			t.Parallel()
			f := newDelivery(t)
			c.setup(t, f)
			f.refuses(Delivery{State: "blocked", Reason: "busy", Branch: c.branch})
		})
	}
}

// Row "index.lock present": git says so at the fast-forward. A dry run cannot know.
func TestDeliverIndexLocked(t *testing.T) {
	t.Parallel()
	f := newDelivery(t)
	lock := filepath.Join(f.root, ".git", "index.lock")
	must(t, os.WriteFile(lock, nil, 0o644))
	before := folderState(t, f.root)
	same(t, "delivery", f.deliver(), Delivery{State: "blocked", Reason: "busy", Branch: "main"})
	f.unchanged("the refused delivery", before)
	if !exists(lock) {
		t.Error("the lock of another process was removed")
	}
	same(t, "dry run", f.dry(), Delivery{State: "pending", Branch: "main"})

	must(t, os.Remove(lock))
	f.applies("ff")
}

// The folder is itself a linked work tree: the files of an operation in progress are found in its
// own git dir, and the main work tree is not touched.
func TestDeliverIntoALinkedWorktree(t *testing.T) {
	t.Parallel()
	linked := func(t *testing.T) (f *delivery, main, mainState string) {
		f = newDelivery(t)
		main = f.root
		write(t, main, "keep.txt", "keep\nedited in the main work tree\n")
		f.root = sibling(main, "mine")
		git(t, main, "worktree", "add", "-q", "-b", "side", f.root, f.base)
		f.req.Folder, f.req.StartBranch = f.root, "side"
		return f, main, checkoutState(t, main)
	}
	// applies and refuses look for a record with "apply" in it; the person's work tree stays.
	check := func(t *testing.T, f *delivery, main, mainState string) {
		t.Helper()
		if got := checkoutState(t, main); got != mainState {
			t.Errorf("the main work tree changed:\n%s\nwas:\n%s", got, mainState)
		}
		if list := git(t, main, "worktree", "list", "--porcelain"); strings.Count(list, "worktree ") != 2 {
			t.Errorf("work trees:\n%s", list)
		}
	}
	t.Run("fast-forward", func(t *testing.T) {
		t.Parallel()
		f, main, mainState := linked(t)
		f.applies("ff")
		f.files(resultFiles)
		check(t, f, main, mainState)
	})
	t.Run("merge", func(t *testing.T) {
		variant(t, "fast-forward")
		t.Parallel()
		f, main, mainState := linked(t)
		write(t, f.root, "own.txt", "own\n")
		git(t, f.root, "add", "-A")
		git(t, f.root, "commit", "-q", "-m", "my own work")
		f.applies("merge")
		f.files(resultFiles)
		check(t, f, main, mainState)
	})
	t.Run("busy", func(t *testing.T) {
		variant(t, "fast-forward")
		t.Parallel()
		f, main, mainState := linked(t)
		git(t, f.root, "revert", "--no-commit", "HEAD")
		f.refuses(Delivery{State: "blocked", Reason: "busy", Branch: "side"})
		check(t, f, main, mainState)
	})
	t.Run("an operation in the main work tree is not the folder's", func(t *testing.T) {
		variant(t, "fast-forward")
		t.Parallel()
		f, main, _ := linked(t)
		write(t, main, "keep.txt", baseFiles["keep.txt"])
		git(t, main, "revert", "--no-commit", "HEAD")
		mainState := checkoutState(t, main)
		f.applies("ff")
		check(t, f, main, mainState)
	})
	t.Run("local changes", func(t *testing.T) {
		variant(t, "fast-forward")
		t.Parallel()
		f, main, mainState := linked(t)
		write(t, f.root, "new.txt", "mine\n")
		f.refuses(Delivery{State: "blocked", Reason: "local_changes", Branch: "side", Files: []string{"new.txt"}})
		check(t, f, main, mainState)
	})
}

// commitOwn is the person committing a file of their own in the folder.
func commitOwn(t *testing.T, root, name string) string {
	t.Helper()
	write(t, root, name, name+"\n")
	git(t, root, "add", name)
	git(t, root, "commit", "-q", "-m", "my "+name)
	return git(t, root, "rev-parse", "HEAD")
}

// HEAD moves between step 7 and step 9: Deliver starts again from step 3.
func TestDeliverWhenHeadMovesMeanwhile(t *testing.T) {
	t.Parallel()
	t.Run("once", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		d := newDeliverer([]Option{WithEnv(hermetic...)})
		var tries []int
		mine := ""
		d.beforeApply = func(try int) {
			if tries = append(tries, try); try == 0 { // the fast-forward to the result is decided
				mine = commitOwn(t, f.root, "own.txt")
			}
		}
		got := d.deliver(bg, f.req)
		head := git(t, f.root, "rev-parse", "HEAD")
		same(t, "delivery", got, Delivery{State: "applied", How: "merge", Commit: head, Branch: "main"})
		if !reflect.DeepEqual(tries, []int{0, 1}) {
			t.Errorf("tries = %v, want two", tries)
		}
		if got := parentsOf(t, f.root, head); !reflect.DeepEqual(got, []string{mine, f.result}) {
			t.Errorf("parents = %v, want the person's commit %s first", got, mine)
		}
		if st := status(t, f.root); st != "" {
			t.Errorf("status after: %q", st)
		}
		f.files(resultFiles)
		f.files(map[string]string{"own.txt": "own.txt\n"})
		f.noScratch()
	})
	t.Run("after the merge was built", func(t *testing.T) {
		variant(t, "once")
		t.Parallel()
		f := newDelivery(t)
		commitOwn(t, f.root, "own.txt")
		d := newDeliverer([]Option{WithEnv(hermetic...)})
		mine := ""
		d.beforeApply = func(try int) {
			if try == 0 { // the merge commit is built on a head that is about to be history
				mine = commitOwn(t, f.root, "more.txt")
			}
		}
		got := d.deliver(bg, f.req)
		head := git(t, f.root, "rev-parse", "HEAD")
		same(t, "delivery", got, Delivery{State: "applied", How: "merge", Commit: head, Branch: "main"})
		if got := parentsOf(t, f.root, head); !reflect.DeepEqual(got, []string{mine, f.result}) {
			t.Errorf("parents = %v, want the person's last commit %s first", got, mine)
		}
		f.files(map[string]string{"own.txt": "own.txt\n", "more.txt": "more.txt\n", "new.txt": "new\n"})
		f.noScratch()
	})
	t.Run("every time", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		d := newDeliverer([]Option{WithEnv(hermetic...)})
		tries, mine := 0, ""
		d.beforeApply = func(try int) {
			tries++
			mine = commitOwn(t, f.root, fmt.Sprintf("own%d.txt", try))
		}
		got := d.deliver(bg, f.req)
		if got.State != "blocked" || got.Reason != "git" || got.Branch != "main" ||
			!strings.Contains(got.Detail, "Not possible to fast-forward") || strings.Contains(got.Detail, "hint:") {
			t.Errorf("delivery: %+v", got)
		}
		if tries != 1+deliverRetries {
			t.Errorf("%d tries, want %d", tries, 1+deliverRetries)
		}
		if head := git(t, f.root, "rev-parse", "HEAD"); head != mine {
			t.Errorf("HEAD = %s, want the person's last commit %s", head, mine)
		}
		if st := status(t, f.root); st != "" {
			t.Errorf("status after: %q", st)
		}
		f.files(baseFiles)
		f.noScratch()
		f.applies("merge") // and it is not stuck: the next one goes through
	})
}

// Step 4: a second delivery finds the result in HEAD, however it got there.
func TestDeliverTwice(t *testing.T) {
	t.Parallel()
	already := func(t *testing.T, f *delivery) {
		t.Helper()
		head := git(t, f.root, "rev-parse", "HEAD")
		branch := strings.TrimPrefix(git(t, f.root, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD")
		f.refuses(Delivery{State: "applied", How: "already", Commit: head, Branch: branch})
	}
	t.Run("after a fast-forward", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		f.applies("ff")
		already(t, f)
	})
	t.Run("after a merge, and after more commits", func(t *testing.T) {
		variant(t, "after a fast-forward and the person merged by hand")
		t.Parallel()
		f := newDelivery(t)
		commitOwn(t, f.root, "own.txt")
		f.applies("merge")
		already(t, f)
		commitOwn(t, f.root, "more.txt")
		write(t, f.root, "a.txt", "dirty\n")
		already(t, f)
	})
	t.Run("the person merged by hand", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		commitOwn(t, f.root, "own.txt")
		git(t, f.root, "merge", "-q", "--no-edit", "aiwb/r1/integration")
		already(t, f)
	})
	t.Run("on another branch that has it, once the request names the branch", func(t *testing.T) {
		variant(t, "after a fast-forward and the person merged by hand")
		t.Parallel()
		f := newDelivery(t)
		f.applies("ff")
		git(t, f.root, "checkout", "-q", "-b", "next")
		f.refuses(Delivery{State: "pending", Reason: "other_branch", Branch: "next"})
		f.req.Auto = false
		f.refuses(Delivery{State: "pending", Reason: "other_branch", Branch: "next"})
		f.req.Branch = "next"
		already(t, f)
		git(t, f.root, "checkout", "-q", "--detach")
		f.refuses(Delivery{State: "pending", Reason: "other_branch"})
		f.req.Branch = "HEAD"
		already(t, f)
	})
	t.Run("the person merged by hand into another branch", func(t *testing.T) {
		variant(t, "after a fast-forward and the person merged by hand")
		t.Parallel()
		f := newDelivery(t)
		git(t, f.root, "checkout", "-q", "-b", "feature")
		commitOwn(t, f.root, "own.txt")
		git(t, f.root, "merge", "-q", "--no-edit", "aiwb/r1/integration")
		f.refuses(Delivery{State: "pending", Reason: "other_branch", Branch: "feature"})
		f.req.Auto, f.req.Branch = false, "feature"
		already(t, f)
	})
	t.Run("in the middle of an operation", func(t *testing.T) {
		variant(t, "after a fast-forward and the person merged by hand")
		t.Parallel()
		f := newDelivery(t)
		f.applies("ff")
		git(t, f.root, "revert", "--no-commit", "HEAD")
		already(t, f)
	})
}

// A dry run changes nothing and leaves no scratch work tree, also when it had to build the merge.
func TestDeliverDryRun(t *testing.T) {
	t.Parallel()
	t.Run("fast-forward", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		before := folderState(t, f.root)
		same(t, "dry run", f.dry(), Delivery{State: "pending", Branch: "main"})
		f.unchanged("the dry run", before)
		f.files(baseFiles)
	})
	t.Run("merge", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		commitOwn(t, f.root, "own.txt")
		write(t, f.root, "keep.txt", "keep\nmine\n")
		before := folderState(t, f.root)
		for i := 0; i < 2; i++ {
			same(t, "dry run", f.dry(), Delivery{State: "pending", Branch: "main"})
			f.unchanged("the dry run", before)
		}
		if out := git(t, f.root, "worktree", "list", "--porcelain"); strings.Count(out, "worktree ") != 1 {
			t.Errorf("work trees after the dry run:\n%s", out)
		}
		if exists(filepath.Dir(f.req.Scratch)) {
			if entries, _ := os.ReadDir(filepath.Dir(f.req.Scratch)); len(entries) > 0 {
				t.Errorf("left next to the scratch folder: %v", entries)
			}
		}
	})
	t.Run("merge, local changes in the way of the merge commit", func(t *testing.T) {
		variant(t, "fast-forward and merge")
		t.Parallel()
		f := newDelivery(t)
		commitOwn(t, f.root, "own.txt")
		write(t, f.root, "new.txt", "mine\n")
		f.refuses(Delivery{State: "blocked", Reason: "local_changes", Branch: "main", Files: []string{"new.txt"}})
	})
	t.Run("no scratch folder is needed for a fast-forward", func(t *testing.T) {
		variant(t, "fast-forward and merge")
		t.Parallel()
		f := newDelivery(t)
		f.req.Scratch = ""
		f.applies("ff")
	})
}

// Step 2: the run changed nothing.
func TestDeliverNoChanges(t *testing.T) {
	t.Parallel()
	f := newDelivery(t)
	f.req.Result = f.base
	write(t, f.root, "a.txt", "dirty\n")
	f.refuses(Delivery{State: "none", Reason: "no_changes"})
	f.req.Base, f.req.Result = "main", f.base // by name
	f.refuses(Delivery{State: "none", Reason: "no_changes"})
	git(t, f.root, "checkout", "-q", "-b", "elsewhere")
	f.req.Base = f.base
	f.refuses(Delivery{State: "none", Reason: "no_changes"})
}

// Two results delivered to one repository at the same moment: both arrive, one after the other.
func TestDeliverConcurrently(t *testing.T) {
	t.Parallel()
	t.Run("two runs", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		second := runResult(t, f.root, "r2", f.base, map[string]string{"keep.txt": "kept by r2\n", "two.txt": "two\n"})
		reqs := []DeliverReq{f.req, f.req}
		reqs[1].Result, reqs[1].Scratch = second, sibling(f.root, "r2/apply")
		got := make([]Delivery, len(reqs))
		done := make(chan int)
		for i := range reqs {
			go func() {
				got[i] = Deliver(bg, reqs[i], WithEnv(hermetic...))
				done <- i
			}()
		}
		<-done
		<-done
		head := git(t, f.root, "rev-parse", "HEAD")
		hows := map[string]int{}
		for i, d := range got {
			if d.State != "applied" || d.Branch != "main" {
				t.Errorf("delivery %d: %+v", i, d)
			}
			hows[d.How]++
			if git(t, f.root, "merge-base", reqs[i].Result, head) != reqs[i].Result {
				t.Errorf("result %d is not in HEAD", i)
			}
		}
		if hows["ff"] != 1 || hows["merge"] != 1 {
			t.Errorf("how: %v, want one fast-forward and one merge", hows)
		}
		if st := status(t, f.root); st != "" {
			t.Errorf("status after: %q", st)
		}
		f.files(resultFiles)
		f.files(map[string]string{"keep.txt": "kept by r2\n", "two.txt": "two\n"})
		f.noScratch()
	})
	t.Run("one result twice", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		commitOwn(t, f.root, "own.txt")
		got := make(chan Delivery)
		for i := 0; i < 2; i++ {
			go func() { got <- f.deliver() }()
		}
		a, b := <-got, <-got
		if a.How == "already" {
			a, b = b, a
		}
		head := git(t, f.root, "rev-parse", "HEAD")
		same(t, "the first", a, Delivery{State: "applied", How: "merge", Commit: head, Branch: "main"})
		same(t, "the second", b, Delivery{State: "applied", How: "already", Commit: head, Branch: "main"})
		f.noScratch()
	})
	t.Run("the second waits for the first", func(t *testing.T) {
		variant(t, "two runs and one result twice")
		t.Parallel()
		f := newDelivery(t)
		second := runResult(t, f.root, "r2", f.base, map[string]string{"two.txt": "two\n"})
		other := newDelivery(t) // another repository is not held up

		entered, release := make(chan struct{}), make(chan struct{})
		d := newDeliverer([]Option{WithEnv(hermetic...)})
		d.beforeApply = func(int) { close(entered); <-release }
		first := make(chan Delivery, 1)
		go func() { first <- d.deliver(bg, f.req) }()
		<-entered

		req := f.req
		req.Result, req.Scratch = second, sibling(f.root, "r2/apply")
		next := make(chan Delivery, 1)
		go func() { next <- Deliver(bg, req, WithEnv(hermetic...)) }()
		other.applies("ff")
		select {
		case got := <-next:
			t.Fatalf("the second delivery did not wait: %+v", got)
		case <-time.After(300 * time.Millisecond):
		}
		if head := git(t, f.root, "rev-parse", "HEAD"); head != f.base {
			t.Errorf("HEAD = %s while the first delivery is held, want the base", head)
		}
		close(release)
		same(t, "the first", <-first, Delivery{State: "applied", How: "ff", Commit: f.result, Branch: "main"})
		got := <-next
		head := git(t, f.root, "rev-parse", "HEAD")
		same(t, "the second", got, Delivery{State: "applied", How: "merge", Commit: head, Branch: "main"})
		if p := parentsOf(t, f.root, head); !reflect.DeepEqual(p, []string{f.result, second}) {
			t.Errorf("parents = %v", p)
		}
	})
}

// The merge commit has the person's identity. Where git finds none, nothing is made up.
func TestDeliverMergeNeedsAnIdentity(t *testing.T) {
	t.Parallel()
	f := newDelivery(t)
	commitOwn(t, f.root, "own.txt")
	git(t, f.root, "config", "--unset", "user.name")
	git(t, f.root, "config", "--unset", "user.email")
	git(t, f.root, "config", "user.useConfigOnly", "true") // or git guesses one from the machine
	before := folderState(t, f.root)
	got := f.deliver()
	if got.State != "blocked" || got.Reason != "git" || got.Branch != "main" || !strings.Contains(got.Detail, "tell me who you are") {
		t.Errorf("delivery: %+v", got)
	}
	f.unchanged("the refused delivery", before)

	// A fast-forward makes no commit and needs none.
	g := newDelivery(t)
	git(t, g.root, "config", "--unset", "user.name")
	git(t, g.root, "config", "--unset", "user.email")
	git(t, g.root, "config", "user.useConfigOnly", "true")
	g.applies("ff")
}

// The person's hooks: post-merge runs on the fast-forward and its exit code changes nothing; a
// hook that refuses the merge commit outside does not block the delivery.
func TestDeliverAndHooks(t *testing.T) {
	t.Parallel()
	t.Run("post-merge", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		ran := filepath.Join(t.TempDir(), "ran")
		hook(t, open(t, f.root), "post-merge", `pwd > "`+ran+`"; exit 3`)
		f.applies("ff")
		if got, err := os.ReadFile(ran); err != nil || resolve(strings.TrimSpace(string(got))) != f.root {
			t.Errorf("the post-merge hook ran in %q (%v), want the folder", got, err)
		}
	})
	t.Run("a hook refuses the merge commit", func(t *testing.T) {
		variant(t, "post-merge and config that the environment passes stays")
		t.Parallel()
		f := newDelivery(t)
		commitOwn(t, f.root, "own.txt")
		hook(t, open(t, f.root), "pre-merge-commit", "echo no merges here >&2; exit 1")
		head := f.applies("merge")
		if len(parentsOf(t, f.root, head)) != 2 {
			t.Errorf("HEAD %s is not a merge commit", head)
		}
	})
	// T39's finding 6: git worktree add exits with the code of post-checkout, and a husky or
	// git-lfs hook that cannot find its program blocked every delivery that needs a merge.
	t.Run("a failing post-checkout hook", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		commitOwn(t, f.root, "own.txt")
		hook(t, open(t, f.root), "post-checkout", `echo "npx: command not found" >&2; exit 127`)
		f.applies("merge")
	})
	t.Run("no hook runs in the scratch work tree, and those of the folder still do", func(t *testing.T) {
		variant(t, "post-merge and config that the environment passes stays")
		t.Parallel()
		f := newDelivery(t)
		commitOwn(t, f.root, "own.txt")
		log := hookLog(t, f.root)
		f.applies("merge")
		ran := string(mustRead(t, log))
		if strings.Contains(ran, f.req.Scratch) {
			t.Errorf("hooks ran in the scratch work tree:\n%s", ran)
		}
		for _, name := range []string{"post-checkout", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-commit"} {
			if strings.Contains(ran, name+" ") {
				t.Errorf("the hook %s ran, and it has no business in a fast-forward:\n%s", name, ran)
			}
		}
		if !strings.Contains(ran, "post-merge 0 in "+f.root+"\n") {
			t.Errorf("post-merge did not run in the folder:\n%s", ran)
		}
	})
	t.Run("config that the environment passes stays", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		commitOwn(t, f.root, "own.txt")
		hook(t, open(t, f.root), "post-checkout", "exit 1")
		env := append(append([]string(nil), hermetic...), "GIT_CONFIG_COUNT=2", "GIT_CONFIG_KEY_0=user.name",
			"GIT_CONFIG_VALUE_0=From The Environment", "GIT_CONFIG_KEY_1=user.email", "GIT_CONFIG_VALUE_1=env@example.com")
		got := Deliver(bg, f.req, WithEnv(env...))
		if got.State != "applied" || got.How != "merge" {
			t.Fatalf("delivery: %+v", got)
		}
		if who := git(t, f.root, "log", "-1", "--format=%an <%ae>"); who != "From The Environment <env@example.com>" {
			t.Errorf("the merge commit is by %q: the config of the environment was lost", who)
		}
	})
}

// hookLog installs every hook that a checkout, a merge or a commit can run in the repository of
// root; each writes its name, its first argument and where it ran to the file that is returned.
func hookLog(t *testing.T, root string) string {
	t.Helper()
	log := filepath.Join(t.TempDir(), "hooks.log")
	for _, name := range []string{"post-checkout", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-merge",
		"post-commit", "reference-transaction", "pre-commit"} {
		hook(t, open(t, root), name, `echo "`+name+` $1 in $(pwd -P)" >> "`+log+`"`)
	}
	return log
}

// mustRead is the content of the file, nothing when it does not exist.
func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return b
}

// When the time is up, or the caller gives up, step 4 says whether the result was applied.
func TestDeliverTimeout(t *testing.T) {
	t.Parallel()
	t.Run("before anything happened", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		commitOwn(t, f.root, "own.txt")
		before := folderState(t, f.root)
		d := newDeliverer([]Option{WithEnv(hermetic...)})
		d.timeout = time.Millisecond
		got := d.deliver(bg, f.req)
		if got.State != "blocked" || got.Reason != "git" || !strings.Contains(got.Detail, "did not finish within 1ms") {
			t.Errorf("delivery: %+v", got)
		}
		f.unchanged("the delivery that ran out of time", before)
	})
	t.Run("while it waits for another delivery", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		entered, release := make(chan struct{}), make(chan struct{})
		d := newDeliverer([]Option{WithEnv(hermetic...)})
		d.beforeApply = func(int) { close(entered); <-release }
		first := make(chan Delivery, 1)
		go func() { first <- d.deliver(bg, f.req) }()
		<-entered
		ctx, cancel := context.WithCancel(bg)
		cancel()
		got := Deliver(ctx, f.req, WithEnv(hermetic...))
		if got.State != "blocked" || got.Reason != "git" || !strings.Contains(got.Detail, "interrupted") {
			t.Errorf("delivery: %+v", got)
		}
		close(release)
		same(t, "the first", <-first, Delivery{State: "applied", How: "ff", Commit: f.result, Branch: "main"})
	})
	t.Run("after the fast-forward, in the person's hook", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		started := filepath.Join(t.TempDir(), "started")
		hook(t, open(t, f.root), "post-merge", `echo $$ > "`+started+`"; sleep 60`)
		// The hook never ends: how long it is left to finish by itself changes nothing here.
		ctx, cancel := context.WithCancel(withWaits(bg, waits{settle: 300 * time.Millisecond}))
		defer cancel()
		go func() {
			for !exists(started) {
				time.Sleep(10 * time.Millisecond)
			}
			cancel()
		}()
		begun := time.Now()
		got := Deliver(ctx, f.req, WithEnv(hermetic...))
		same(t, "delivery", got, Delivery{State: "applied", How: "ff", Commit: f.result, Branch: "main"})
		if took := time.Since(begun); took > 30*time.Second {
			t.Errorf("it took %s: the hook was not ended", took)
		}
		f.files(resultFiles)
		if st := status(t, f.root); st != "" {
			t.Errorf("status after: %q", st)
		}
	})
	// T39's finding 1: git writes the files first and HEAD last. Ended in between it left half
	// of the result in the folder as changes nobody made. A slow smudge filter stands in for a
	// large checkout.
	t.Run("in the middle of the fast-forward", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		f.req.Result = runResult(t, f.root, "r2", f.base, map[string]string{".gitattributes": "*.big filter=slow\n",
			"a.txt": "A\n", "b.txt": "b\n", "z.big": "big\n", "zz.txt": "zz\n"})
		started := filepath.Join(t.TempDir(), "started")
		git(t, f.root, "config", "filter.slow.smudge", `sh -c 'touch "`+started+`"; sleep 1; cat'`)
		git(t, f.root, "config", "filter.slow.clean", "cat")
		ctx, cancel := context.WithCancel(bg)
		defer cancel()
		go func() { // the time is up while git is writing the files
			for !exists(started) {
				time.Sleep(10 * time.Millisecond)
			}
			cancel()
		}()
		got := Deliver(ctx, f.req, WithEnv(hermetic...))
		if ctx.Err() == nil {
			t.Fatal("the delivery was over before its time was up")
		}
		same(t, "delivery", got, Delivery{State: "applied", How: "ff", Commit: f.req.Result, Branch: "main"})
		if head := git(t, f.root, "rev-parse", "HEAD"); head != f.req.Result {
			t.Errorf("HEAD = %s, want the result %s", head, f.req.Result)
		}
		if st := status(t, f.root); st != "" {
			t.Errorf("status after:\n%s", st)
		}
		f.files(map[string]string{"a.txt": "A\n", "b.txt": "b\n", "z.big": "big\n", "zz.txt": "zz\n"})
	})
	t.Run("just before the fast-forward: it is not started", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		before := folderState(t, f.root)
		ctx, cancel := context.WithCancel(bg)
		defer cancel()
		d := newDeliverer([]Option{WithEnv(hermetic...)})
		d.beforeApply = func(int) { cancel() }
		got := d.deliver(ctx, f.req)
		if got.State != "blocked" || got.Reason != "git" || !strings.Contains(got.Detail, "interrupted") {
			t.Errorf("delivery: %+v", got)
		}
		f.unchanged("the delivery that ran out of time", before)
	})
	// Step 4 decides after a timeout too, and by the same rule: a folder that is looking at
	// the result does not have it applied.
	t.Run("while the folder is looking at the result", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		git(t, f.root, "switch", "-q", "-c", "review", f.result)
		// The time is up while it waits for another delivery: the repository and the result
		// are known by then, and step 4 looks.
		unlock, err := lockDelivery(bg, open(t, f.root).CommonDir())
		must(t, err)
		defer unlock()
		d := newDeliverer([]Option{WithEnv(hermetic...)})
		d.timeout = 500 * time.Millisecond
		if got := d.deliver(bg, f.req); got.State != "blocked" || got.Reason != "git" || !strings.Contains(got.Detail, "did not finish within 500ms") {
			t.Errorf("delivery: %+v", got)
		}
		// On the branch the run started on, the same wait ends applied.
		git(t, f.root, "switch", "-q", "main")
		git(t, f.root, "merge", "-q", "--ff-only", "review")
		// The time has to be up while the delivery waits, not before it knows the repository and
		// the result: that is a handful of git commands, and on a busy machine they can take
		// longer than half a second. Then step 4 has nothing to look with, and the delivery is
		// tried again with more time.
		var got Delivery
		for _, d.timeout = range []time.Duration{500 * time.Millisecond, 2 * time.Second, 8 * time.Second, 30 * time.Second} {
			got = d.deliver(bg, f.req)
			if got.State != "blocked" || got.Reason != "git" || !strings.Contains(got.Detail, "did not finish within") {
				break // anything else, another blocked too, is the outcome
			}
		}
		same(t, "on main", got, Delivery{State: "applied", How: "already", Commit: f.result, Branch: "main"})
	})
}

// The scratch folder: one that a killed server left is made anew, anything else there is left
// alone, and it is never inside the person's folder.
func TestDeliverScratchFolder(t *testing.T) {
	t.Parallel()
	gitSaid := func(t *testing.T, f *delivery, words string) {
		t.Helper()
		before := folderState(t, f.root)
		for _, got := range []Delivery{f.dry(), f.deliver()} {
			if got.State != "blocked" || got.Reason != "git" || got.Branch != "main" || !strings.Contains(got.Detail, words) {
				t.Errorf("delivery: %+v, want blocked, git with %q", got, words)
			}
		}
		if after := folderState(t, f.root); after != before {
			t.Errorf("the folder changed:\n%s\nwas:\n%s", after, before)
		}
	}
	t.Run("left by a killed server", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		git(t, f.root, "worktree", "add", "-q", "--detach", f.req.Scratch, f.base)
		write(t, f.req.Scratch, "half.txt", "half a merge\n")
		commitOwn(t, f.root, "own.txt")
		// A dry run leaves it where it is, and says what the delivery will do with it gone.
		before := folderState(t, f.root)
		same(t, "dry run", f.dry(), Delivery{State: "pending", Branch: "main"})
		if after := folderState(t, f.root); after != before || read(t, f.req.Scratch, "half.txt") != "half a merge\n" {
			t.Errorf("the dry run changed the folder or the scratch work tree:\n%s\nwas:\n%s", after, before)
		}
		f.deliver()
		f.noScratch()
		head := git(t, f.root, "rev-parse", "HEAD")
		if len(parentsOf(t, f.root, head)) != 2 || exists(filepath.Join(f.root, "half.txt")) {
			t.Errorf("HEAD %s is not a clean merge of the result", head)
		}
	})
	t.Run("its record is left and the folder is gone", func(t *testing.T) {
		variant(t, "left by a killed server and a folder with files")
		t.Parallel()
		f := newDelivery(t)
		git(t, f.root, "worktree", "add", "-q", "--detach", f.req.Scratch, f.base)
		must(t, os.RemoveAll(f.req.Scratch))
		commitOwn(t, f.root, "own.txt")
		got := f.deliver() // the stale record is dropped on the way
		same(t, "delivery", got, Delivery{State: "applied", How: "merge", Commit: git(t, f.root, "rev-parse", "HEAD"), Branch: "main"})
		f.noScratch()
	})
	t.Run("an empty folder", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		must(t, os.MkdirAll(f.req.Scratch, 0o755))
		commitOwn(t, f.root, "own.txt")
		before := folderState(t, f.root)
		same(t, "dry run", f.dry(), Delivery{State: "pending", Branch: "main"})
		if after := folderState(t, f.root); after != before || !exists(f.req.Scratch) {
			t.Errorf("the dry run changed the folder, or removed the empty scratch folder:\n%s\nwas:\n%s", after, before)
		}
		same(t, "delivery", f.deliver(), Delivery{State: "applied", How: "merge", Commit: git(t, f.root, "rev-parse", "HEAD"), Branch: "main"})
		f.noScratch()
	})
	t.Run("a work tree on a branch", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		git(t, f.root, "worktree", "add", "-q", "-b", "theirs", f.req.Scratch, f.base)
		write(t, f.req.Scratch, "work.txt", "somebody's work\n")
		commitOwn(t, f.root, "own.txt")
		gitSaid(t, f, "a work tree in use")
		if read(t, f.req.Scratch, "work.txt") != "somebody's work\n" {
			t.Error("the work tree at the scratch path was touched")
		}
	})
	t.Run("a folder with files", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		write(t, f.req.Scratch, "work.txt", "somebody's work\n")
		commitOwn(t, f.root, "own.txt")
		gitSaid(t, f, "exists")
		if read(t, f.req.Scratch, "work.txt") != "somebody's work\n" {
			t.Error("the folder at the scratch path was touched")
		}
	})
	t.Run("inside the folder, above it, or not given", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		commitOwn(t, f.root, "own.txt")
		for scratch, words := range map[string]string{
			filepath.Join(f.root, "apply"): "inside the folder",
			f.root:                         "inside the folder",
			filepath.Dir(f.root):           "inside the folder",
			"":                             "no scratch folder",
		} {
			f.req.Scratch = scratch
			gitSaid(t, f, words)
		}
		if exists(filepath.Join(f.root, "apply")) {
			t.Error("a scratch folder was made inside the person's folder")
		}
	})
}

// A branch without a commit (git checkout --orphan) has nothing to fast-forward from.
func TestDeliverOnAnUnbornBranch(t *testing.T) {
	t.Parallel()
	f := newDelivery(t)
	git(t, f.root, "checkout", "-q", "--orphan", "fresh")
	same(t, "automatic", f.deliver(), Delivery{State: "pending", Reason: "other_branch", Branch: "fresh"})
	f.req.Auto, f.req.Branch = false, "fresh"
	for _, got := range []Delivery{f.dry(), f.deliver()} {
		if got.State != "blocked" || got.Reason != "git" || got.Branch != "fresh" || !strings.Contains(got.Detail, "no commit yet") {
			t.Errorf("delivery: %+v", got)
		}
	}
	f.files(baseFiles)
	if out := rawGit(t, f.root, "status", "--porcelain"); !strings.Contains(out, "A  a.txt") {
		t.Errorf("the index of the unborn branch changed: %q", out)
	}
}

// T39's finding 2: a folder that has the result checked out is looking at it. It counted as
// applied, the record said so, and deleting the run then removed the only branch with the result.
func TestDeliverLookingAtTheResult(t *testing.T) {
	t.Parallel()
	for how, tc := range map[string]struct {
		look   []string // the git command that checks the result out
		branch string   // the branch the folder is on then
		named  string   // what an Apply sends that names it
		counts bool     // whether the result counts as applied once it is named
	}{
		"detached":               {[]string{"checkout", "-q", "--detach", "aiwb/r1/integration"}, "", "HEAD", true},
		"a branch of the person": {[]string{"switch", "-q", "-c", "review", "aiwb/r1/integration"}, "review", "review", true},
		"the run's own branch":   {[]string{"switch", "-q", "aiwb/r1/integration"}, "aiwb/r1/integration", "aiwb/r1/integration", false},
	} {
		t.Run(how, func(t *testing.T) {
			if how == "detached" {
				variant(t, "a branch of the person")
			}
			t.Parallel()
			f := newDelivery(t)
			git(t, f.root, tc.look...)
			other := Delivery{State: "pending", Reason: "other_branch", Branch: tc.branch}
			f.refuses(other) // at the run's end
			f.req.Auto = false
			f.refuses(other) // by hand, no branch named
			f.req.Branch = "main"
			f.refuses(other) // by hand, the person saw main
			f.req.Branch = tc.named
			if tc.counts {
				// The person says this is where they want it, and it is there.
				f.refuses(Delivery{State: "applied", How: "already", Commit: f.result, Branch: tc.branch})
			} else {
				f.refuses(other) // a run's branch is never where a result is applied
			}
			if got := git(t, f.root, "rev-parse", "main"); got != f.base {
				t.Errorf("main moved to %s", got)
			}
		})
	}
	t.Run("another run's branch, with the result not in it", func(t *testing.T) {
		variant(t, "a branch of the person")
		t.Parallel()
		f := newDelivery(t)
		git(t, f.root, "switch", "-q", "-c", "aiwb/r0/integration", f.base)
		f.req.Auto, f.req.Branch = false, "aiwb/r0/integration"
		f.refuses(Delivery{State: "pending", Reason: "other_branch", Branch: "aiwb/r0/integration"})
		f.req.Auto, f.req.StartBranch = true, "aiwb/r0/integration"
		f.refuses(Delivery{State: "pending", Reason: "other_branch", Branch: "aiwb/r0/integration"})
	})
}

// historyChanged is a person's folder whose start commit has a file that should not be there, and
// the result of a run that started from it.
func historyChanged(t *testing.T) *delivery {
	t.Helper()
	dir := initRepo(t, true)
	write(t, dir, "a.txt", "a\n")
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-q", "-m", "init")
	write(t, dir, "secret.txt", "password\n")
	write(t, dir, "feature.txt", "feature\n")
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-q", "-m", "feature (with a secret by mistake)")
	f := &delivery{t: t, root: resolve(dir)}
	f.base = git(t, f.root, "rev-parse", "HEAD")
	f.result = runResult(t, f.root, "r1", f.base, map[string]string{"new.txt": "new\n"})
	f.req = DeliverReq{Folder: f.root, Base: f.base, Result: f.result, StartBranch: "main", Auto: true,
		Scratch: sibling(f.root, "r1/apply"), Message: "Merge run"}
	return f
}

// T39's finding 3: the person amended, or reset away, the commit the run started from. The result
// has that commit in its history: applying it by itself brought the commit and its files back.
func TestDeliverHistoryChanged(t *testing.T) {
	t.Parallel()
	changed := Delivery{State: "pending", Reason: "history_changed", Branch: "main"}
	back := func(t *testing.T, f *delivery) bool {
		t.Helper()
		return exists(filepath.Join(f.root, "secret.txt")) || strings.Contains(git(t, f.root, "log", "--format=%s", "HEAD"), "secret")
	}
	t.Run("amended", func(t *testing.T) {
		t.Parallel()
		f := historyChanged(t)
		git(t, f.root, "rm", "-q", "secret.txt")
		git(t, f.root, "commit", "-q", "--amend", "-m", "feature")
		mine := git(t, f.root, "rev-parse", "HEAD")

		f.refuses(changed) // at the run's end, and its dry run
		if back(t, f) {
			t.Errorf("the commit that was amended away is back:\n%s", git(t, f.root, "log", "--oneline", "--graph"))
		}
		// By hand the person decides: the dry run warns, the Apply applies.
		f.req.Auto = false
		before := folderState(t, f.root)
		same(t, "dry run by hand", f.dry(), changed)
		f.unchanged("the dry run", before)
		got := f.deliver()
		head := git(t, f.root, "rev-parse", "HEAD")
		same(t, "apply by hand", got, Delivery{State: "applied", How: "merge", Commit: head, Branch: "main"})
		if p := parentsOf(t, f.root, head); !reflect.DeepEqual(p, []string{mine, f.result}) {
			t.Errorf("parents = %v, want the person's commit first", p)
		}
		f.files(map[string]string{"new.txt": "new\n"})
		f.noScratch()
	})
	t.Run("reset back", func(t *testing.T) {
		variant(t, "amended and no start commit given")
		t.Parallel()
		f := historyChanged(t)
		git(t, f.root, "reset", "-q", "--hard", "HEAD~1")

		f.refuses(changed)
		if back(t, f) {
			t.Errorf("the commit the person dropped is back:\n%s", git(t, f.root, "log", "--oneline"))
		}
		f.req.Auto = false
		before := folderState(t, f.root)
		same(t, "dry run by hand", f.dry(), changed)
		f.unchanged("the dry run", before)
		same(t, "apply by hand", f.deliver(), Delivery{State: "applied", How: "ff", Commit: f.result, Branch: "main"})
	})
	t.Run("the same files in another commit", func(t *testing.T) {
		variant(t, "amended and no start commit given")
		t.Parallel()
		f := historyChanged(t)
		git(t, f.root, "commit", "-q", "--amend", "--no-edit", "--date=2001-01-01T00:00:00")
		f.refuses(changed)
	})
	t.Run("own commits on top of the start commit are no change of history", func(t *testing.T) {
		variant(t, "amended and no start commit given")
		t.Parallel()
		f := historyChanged(t)
		commitOwn(t, f.root, "own.txt")
		f.applies("merge")
	})
	t.Run("another branch comes first", func(t *testing.T) {
		variant(t, "amended and no start commit given")
		t.Parallel()
		f := historyChanged(t)
		git(t, f.root, "switch", "-q", "-c", "old", "HEAD~1")
		f.refuses(Delivery{State: "pending", Reason: "other_branch", Branch: "old"})
		// Named by hand: the branch never had the start commit, and the dry run says so.
		f.req.Auto, f.req.Branch = false, "old"
		same(t, "dry run by hand", f.dry(), Delivery{State: "pending", Reason: "history_changed", Branch: "old"})
		same(t, "apply by hand", f.deliver(), Delivery{State: "applied", How: "ff", Commit: f.result, Branch: "old"})
	})
	t.Run("no start commit given", func(t *testing.T) {
		t.Parallel()
		f := historyChanged(t)
		git(t, f.root, "reset", "-q", "--hard", "HEAD~1")
		f.req.Base = ""
		f.applies("ff")
	})
}

// halfState is the status of the folder of newDelivery after git wrote the result's files and
// index and could not move the branch, with the person's own edit to keep.txt left alone.
const halfState = "M  a.txt\n M keep.txt\nA  new.txt\nA  sub/deep.txt\n"

// T39's finding 4: git merge --ff-only writes the files and the index first and the ref last.
// When the ref cannot be moved, the folder has the result staged with HEAD where it was. Nothing
// is reset: the outcome says what is there, and the next delivery completes it.
func TestDeliverBranchCannotBeMoved(t *testing.T) {
	t.Parallel()
	half := func(t *testing.T, f *delivery, got Delivery, reason, words string) {
		t.Helper()
		if got.State != "blocked" || got.Reason != reason || got.Branch != "main" ||
			!strings.HasPrefix(got.Detail, "the result's files are in the folder, staged, but the branch could not be moved: ") ||
			!strings.HasSuffix(got.Detail, "; remove the cause and apply again") || !strings.Contains(got.Detail, words) ||
			strings.Contains(got.Detail, "\n") {
			t.Errorf("delivery: %+v", got)
		}
		if head := git(t, f.root, "rev-parse", "HEAD"); head != f.base {
			t.Errorf("HEAD = %s, want the base", head)
		}
		if st := status(t, f.root); st != halfState {
			t.Errorf("status:\n%s\nwant:\n%s", st, halfState)
		}
		f.files(resultFiles)
		f.files(map[string]string{"keep.txt": "keep\nmine\n"})
	}
	completes := func(t *testing.T, f *delivery) {
		t.Helper()
		same(t, "dry run in the half state", f.dry(), Delivery{State: "pending", Branch: "main"})
		same(t, "delivery after the cause went", f.deliver(), Delivery{State: "applied", How: "ff", Commit: f.result, Branch: "main"})
		if st := status(t, f.root); st != " M keep.txt\n" {
			t.Errorf("status after: %q", st)
		}
		f.files(map[string]string{"keep.txt": "keep\nmine\n"})
	}
	for _, name := range []string{"refs/heads/main.lock", "HEAD.lock"} {
		t.Run(name, func(t *testing.T) {
			if name != "refs/heads/main.lock" {
				variant(t, "refs/heads/main.lock")
			}
			t.Parallel()
			f := newDelivery(t)
			write(t, f.root, "keep.txt", "keep\nmine\n")
			lock := filepath.Join(f.root, ".git", name)
			must(t, os.WriteFile(lock, nil, 0o644))
			half(t, f, f.deliver(), "busy", "cannot lock ref")
			half(t, f, f.deliver(), "busy", "cannot lock ref") // and again: it stays as it is
			must(t, os.Remove(lock))
			completes(t, f)
		})
	}
	// This lock git takes before it writes anything.
	t.Run("ORIG_HEAD.lock", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		write(t, f.root, "keep.txt", "keep\nmine\n")
		lock := filepath.Join(f.root, ".git", "ORIG_HEAD.lock")
		must(t, os.WriteFile(lock, nil, 0o644))
		before := folderState(t, f.root)
		same(t, "delivery", f.deliver(), Delivery{State: "blocked", Reason: "busy", Branch: "main"})
		must(t, os.Remove(lock))
		f.unchanged("the refused delivery", before)
		f.applies("ff")
	})
	t.Run("a reference-transaction hook refuses the branch", func(t *testing.T) {
		variant(t, "refs/heads/main.lock")
		t.Parallel()
		f := newDelivery(t)
		write(t, f.root, "keep.txt", "keep\nmine\n")
		hook(t, open(t, f.root), "reference-transaction", `[ "$1" = prepared ] || exit 0
while read old new ref; do if [ "$ref" = refs/heads/main ]; then echo "policy: main is protected" >&2; exit 1; fi; done`)
		half(t, f, f.deliver(), "git", "policy: main is protected; fatal: ref updates aborted by hook")
		must(t, os.Remove(filepath.Join(f.root, ".git", "hooks", "reference-transaction")))
		completes(t, f)
	})
}

// killedWorktreeAdd leaves at path what a git worktree add leaves when it is killed during its
// checkout: the folder with part of the files, and a record that git has locked ("initializing").
// The repository of root must have a file with the attribute filter=slow in HEAD.
func killedWorktreeAdd(t *testing.T, root, path string) {
	t.Helper()
	started := filepath.Join(t.TempDir(), "started")
	git(t, root, "config", "filter.slow.smudge", `sh -c 'touch "`+started+`"; sleep 30; cat'`)
	must(t, os.MkdirAll(filepath.Dir(path), 0o755))
	cmd := exec.Command("git", "worktree", "add", "-q", "--detach", path, "HEAD")
	cmd.Dir, cmd.Env = root, append(gitEnv(hermetic), "LC_ALL=C")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	must(t, cmd.Start())
	for deadline := time.Now().Add(20 * time.Second); !exists(started) && time.Now().Before(deadline); {
		time.Sleep(10 * time.Millisecond)
	}
	syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	cmd.Wait()
	git(t, root, "config", "filter.slow.smudge", "cat")
	if list := git(t, root, "worktree", "list", "--porcelain"); !strings.Contains(list, "locked initializing") {
		t.Fatalf("the killed git worktree add left no locked work tree:\n%s", list)
	}
}

// slowRepo is a repository with a commit that has a file with the attribute filter=slow.
func slowRepo(t *testing.T) string {
	t.Helper()
	dir := initRepo(t, true)
	write(t, dir, ".gitattributes", "*.big filter=slow\n")
	write(t, dir, "a.txt", "one\ntwo\nthree\n")
	write(t, dir, "z.big", "big\n")
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-q", "-m", "init")
	return resolve(dir)
}

// T39's finding 5: the scratch work tree of a delivery whose git worktree add was killed during
// the checkout stays locked on git's record, and blocked every later delivery that had to merge.
func TestDeliverAfterAKilledScratchCheckout(t *testing.T) {
	t.Parallel()
	root := slowRepo(t)
	f := &delivery{t: t, root: root, base: git(t, root, "rev-parse", "HEAD")}
	f.result = runResult(t, root, "r1", f.base, map[string]string{"new.txt": "new\n"})
	f.req = DeliverReq{Folder: root, Base: f.base, Result: f.result, StartBranch: "main", Scratch: sibling(root, "r1/apply"), Message: "Merge run"}
	commitOwn(t, root, "own.txt")
	killedWorktreeAdd(t, root, f.req.Scratch)

	before := folderState(t, root)
	same(t, "dry run", f.dry(), Delivery{State: "pending", Branch: "main"})
	if after := folderState(t, root); after != before {
		t.Errorf("the dry run changed the folder or the record of the scratch work tree:\n%s\nwas:\n%s", after, before)
	}
	got := f.deliver()
	same(t, "delivery", got, Delivery{State: "applied", How: "merge", Commit: git(t, root, "rev-parse", "HEAD"), Branch: "main"})
	f.noScratch()
	f.files(map[string]string{"new.txt": "new\n", "own.txt": "own.txt\n"})
}

// T39's finding 7: a dry run with commits of the person to merge checked the repository out,
// ran the person's hooks there and left a merge commit behind, each time the view asked.
func TestDeliverDryRunIsDry(t *testing.T) {
	t.Parallel()
	objects := func(t *testing.T, f *delivery) string {
		t.Helper()
		return git(t, f.root, "count-objects", "-v") + "\n" + git(t, f.root, "fsck", "--dangling", "--unreachable", "--no-reflogs")
	}
	dry := func(t *testing.T, f *delivery, want Delivery) {
		t.Helper()
		log := hookLog(t, f.root)
		before, objs := folderState(t, f.root), objects(t, f)
		for i := 0; i < 3; i++ {
			same(t, "dry run", f.dry(), want)
		}
		f.unchanged("the dry run", before)
		if ran := mustRead(t, log); len(ran) > 0 {
			t.Errorf("hooks run by three dry runs:\n%s", ran)
		}
		if now := objects(t, f); now != objs {
			t.Errorf("the objects of the repository before:\n%s\nafter:\n%s", objs, now)
		}
	}
	t.Run("a merge that would go through", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		commitOwn(t, f.root, "own.txt")
		dry(t, f, Delivery{State: "pending", Branch: "main"})
	})
	t.Run("files in the way of the merge", func(t *testing.T) {
		variant(t, "a merge that would go through")
		t.Parallel()
		f := newDelivery(t)
		commitOwn(t, f.root, "own.txt")
		write(t, f.root, "new.txt", "mine\n")
		write(t, f.root, "own.txt", "edited, and in nobody's way\n")
		dry(t, f, Delivery{State: "blocked", Reason: "local_changes", Branch: "main", Files: []string{"new.txt"}})
	})
	t.Run("a conflict", func(t *testing.T) {
		variant(t, "a merge that would go through")
		t.Parallel()
		f := newDelivery(t)
		write(t, f.root, "a.txt", "mine\ntwo\nthree\n")
		write(t, f.root, "sub/deep.txt", "mine\n")
		git(t, f.root, "add", "-A")
		git(t, f.root, "commit", "-q", "-m", "my own a.txt and sub/deep.txt")
		dry(t, f, Delivery{State: "blocked", Reason: "conflict", Branch: "main", Files: []string{"a.txt", "sub/deep.txt"}})
		// The delivery finds the same, in the scratch work tree.
		f.refuses(Delivery{State: "blocked", Reason: "conflict", Branch: "main", Files: []string{"a.txt", "sub/deep.txt"}})
	})
	t.Run("with a git that has no merge-tree --write-tree", func(t *testing.T) {
		t.Parallel()
		f := newDelivery(t)
		write(t, f.root, "a.txt", "mine\ntwo\nthree\n")
		git(t, f.root, "commit", "-q", "-am", "my own first line") // a conflict, which nobody looks for
		log := hookLog(t, f.root)
		before := folderState(t, f.root)
		d := newDeliverer([]Option{WithEnv(hermetic...)})
		d.noMergeTree = true
		req := f.req
		req.DryRun = true
		same(t, "dry run", d.deliver(bg, req), Delivery{State: "pending", Branch: "main"})
		f.unchanged("the dry run", before)
		if ran := mustRead(t, log); len(ran) > 0 {
			t.Errorf("hooks run by the dry run:\n%s", ran)
		}
		// The delivery itself still finds the conflict, in the scratch work tree.
		same(t, "delivery", d.deliver(bg, f.req), Delivery{State: "blocked", Reason: "conflict", Branch: "main", Files: []string{"a.txt"}})
		f.unchanged("the refused delivery", before)
	})
}

func TestGitVersion(t *testing.T) {
	t.Parallel()
	for out, want := range map[string][2]int{
		"git version 2.50.1 (Apple Git-155)": {2, 50},
		"git version 2.38.0":                 {2, 38},
		"git version 2.37.GIT":               {2, 37},
		"git version 3.0":                    {3, 0},
		"git version 2.39.3.windows.1":       {2, 39},
		"git version two":                    {0, 0},
		"":                                   {0, 0},
	} {
		if got := parseVersion(out); got != want {
			t.Errorf("parseVersion(%q) = %v, want %v", out, got, want)
		}
	}
	r, _ := newRepo(t)
	if ok, err := r.gitAtLeast(bg, 1, 0); err != nil || !ok {
		t.Errorf("gitAtLeast(1.0) = %v, %v", ok, err)
	}
	if ok, err := r.gitAtLeast(bg, 99, 0); err != nil || ok {
		t.Errorf("gitAtLeast(99.0) = %v, %v", ok, err)
	}
}

func TestWithConfig(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ env, want []string }{
		{[]string{"A=1"}, []string{"A=1", "GIT_CONFIG_KEY_0=core.hooksPath", "GIT_CONFIG_VALUE_0=/dev/null", "GIT_CONFIG_COUNT=1"}},
		{[]string{"GIT_CONFIG_COUNT=5", "GIT_CONFIG_COUNT=2", "GIT_CONFIG_KEY_0=a.b", "GIT_CONFIG_VALUE_0=c", "GIT_CONFIG_KEY_1=d.e", "GIT_CONFIG_VALUE_1=f"},
			[]string{"GIT_CONFIG_COUNT=5", "GIT_CONFIG_COUNT=2", "GIT_CONFIG_KEY_0=a.b", "GIT_CONFIG_VALUE_0=c", "GIT_CONFIG_KEY_1=d.e", "GIT_CONFIG_VALUE_1=f",
				"GIT_CONFIG_KEY_2=core.hooksPath", "GIT_CONFIG_VALUE_2=/dev/null", "GIT_CONFIG_COUNT=3"}},
		{[]string{"GIT_CONFIG_COUNT=x"}, []string{"GIT_CONFIG_COUNT=x", "GIT_CONFIG_KEY_0=core.hooksPath", "GIT_CONFIG_VALUE_0=/dev/null", "GIT_CONFIG_COUNT=1"}},
	} {
		env := append([]string(nil), tc.env...)
		if got := noHooks(env); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("noHooks(%q) = %q, want %q", tc.env, got, tc.want)
		}
		if !reflect.DeepEqual(env, tc.env) {
			t.Errorf("noHooks changed its argument: %q", env)
		}
	}
}
