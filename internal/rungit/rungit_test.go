package rungit

import (
	"ai-whiteboard/internal/agenttest"
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// Every test works in a repository of its own under t.TempDir(), with the user's and the system's
// git config switched off. No test runs git in a real repository.

var (
	bg       = context.Background()
	hermetic []string // the environment that switches the user's git config off
	scratch  string   // where the template repositories of the test binary are (see template)
)

func TestMain(m *testing.M) {
	agenttest.FastGit()
	// Nearly every test here waits for git commands, and a Mac starts only so many processes a
	// second: more than a few tests at once are done no sooner, and each takes longer against
	// its wall-clock waits.
	agenttest.LimitParallel()
	home, err := os.MkdirTemp("", "rungit-home")
	if err != nil {
		panic(err)
	}
	hermetic = []string{"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "HOME=" + home, "XDG_CONFIG_HOME=" + home}
	for _, name := range []string{"GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"} {
		os.Unsetenv(name)
	}
	if scratch, err = os.MkdirTemp("", "rungit-templates"); err != nil {
		panic(err)
	}
	code := m.Run()
	os.RemoveAll(scratch)
	os.RemoveAll(home)
	os.Exit(code)
}

// withWaits is ctx for calls that sit through one of the package's waits: the test gives the ones
// it waits out a shorter time. A zero field keeps the package's own.
func withWaits(ctx context.Context, w waits) context.Context {
	own := waitsOf(ctx)
	if w.grace == 0 {
		w.grace = own.grace
	}
	if w.settle == 0 {
		w.settle = own.settle
	}
	if w.staleAge == 0 {
		w.staleAge = own.staleAge
	}
	if w.flockWait == 0 {
		w.flockWait = own.flockWait
	}
	return context.WithValue(ctx, waitsKey{}, w)
}

// git runs git in dir the way a person (or an agent) would, and fails the test when it fails.
func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, stderr, err := runGit(bg, gitEnv(hermetic), dir, args...)
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, stderr)
	}
	return out
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	path := filepath.Join(dir, name)
	must(t, os.MkdirAll(filepath.Dir(path), 0o755))
	must(t, os.WriteFile(path, []byte(content), 0o644))
}

func read(t *testing.T, dir, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, name))
	must(t, err)
	return string(b)
}

// initRepo makes a repository on branch main in a new temp folder, without a commit, and returns
// its folder. With identity it gets a user.name and user.email of its own.
func initRepo(t *testing.T, identity bool) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "repo")
	must(t, os.MkdirAll(dir, 0o755))
	initIn(t, dir, identity)
	return dir
}

// initIn is initRepo in the folder dir, which is there and empty.
func initIn(t *testing.T, dir string, identity bool) {
	t.Helper()
	git(t, dir, "init", "-q", "-b", "main")
	if identity {
		// What git config user.name and git config user.email write, without the two processes.
		f, err := os.OpenFile(filepath.Join(dir, ".git", "config"), os.O_APPEND|os.O_WRONLY, 0)
		must(t, err)
		_, err = f.WriteString("[user]\n\tname = Tester\n\temail = tester@example.com\n")
		must(t, err)
		must(t, f.Close())
	}
}

// template is a repository that is built once for the test binary and copied for each test that
// starts from it: a copy of a few files instead of the same handful of git commands every time.
type template struct {
	once sync.Once
	dir  string
}

// copyOf returns a copy of the repository that build makes, in a new temp folder of t. A test
// gets what it would get from build: its own repository, with an index that matches its files.
func (tpl *template) copyOf(t *testing.T, build func(t *testing.T, dir string)) string {
	t.Helper()
	tpl.once.Do(func() {
		dir, err := os.MkdirTemp(scratch, "repo")
		must(t, err)
		build(t, dir)
		tpl.dir = dir
	})
	if tpl.dir == "" {
		t.Fatal("the template repository could not be built (see the first test that failed)")
	}
	dir := filepath.Join(t.TempDir(), "repo")
	must(t, os.CopyFS(dir, os.DirFS(tpl.dir)))
	// The index has the inodes and times of the template's files, not of the copies.
	git(t, dir, "update-index", "-q", "--refresh")
	return dir
}

var newRepoTemplate template

func open(t *testing.T, dir string) *Repo {
	t.Helper()
	r, err := Open(bg, dir, WithEnv(hermetic...))
	must(t, err)
	if !strings.HasPrefix(r.Root(), resolve(os.TempDir())) && !strings.HasPrefix(r.Root(), resolve(t.TempDir())) {
		t.Fatalf("the repository %s is not a temp one", r.Root())
	}
	return r
}

// newRepo makes a repository with one commit on main (f.txt, three lines) and opens it. Work trees
// of a test go next to it, in sibling(root, name).
func newRepo(t *testing.T) (*Repo, string) {
	t.Helper()
	dir := newRepoTemplate.copyOf(t, func(t *testing.T, dir string) {
		initIn(t, dir, true)
		write(t, dir, "f.txt", "one\ntwo\nthree\n")
		git(t, dir, "add", "-A")
		git(t, dir, "commit", "-q", "-m", "init")
	})
	r := open(t, dir)
	if r.Root() != resolve(dir) {
		t.Fatalf("Root() = %s, want %s", r.Root(), resolve(dir))
	}
	return r, r.Root()
}

func sibling(root, name string) string { return filepath.Join(filepath.Dir(root), "wt", name) }

func TestOpen(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	if want := filepath.Join(root, ".git"); r.CommonDir() != want {
		t.Errorf("CommonDir() = %s, want %s", r.CommonDir(), want)
	}

	sub := filepath.Join(root, "a", "b")
	must(t, os.MkdirAll(sub, 0o755))
	rs := open(t, sub)
	if rs.Root() != root || rs.CommonDir() != r.CommonDir() {
		t.Errorf("from a subfolder: Root %s, CommonDir %s", rs.Root(), rs.CommonDir())
	}

	// A linked work tree: its own top level, the shared git dir.
	linked := sibling(root, "linked")
	must(t, r.EnsureWorktree(bg, linked, "side", "main"))
	must(t, os.MkdirAll(filepath.Join(linked, "deep"), 0o755))
	for _, dir := range []string{linked, filepath.Join(linked, "deep")} {
		rl := open(t, dir)
		if rl.Root() != resolve(linked) || rl.CommonDir() != r.CommonDir() {
			t.Errorf("from %s: Root %s, CommonDir %s", dir, rl.Root(), rl.CommonDir())
		}
	}
	// "HEAD" means the head of the work tree the Repo was opened from.
	write(t, linked, "new.txt", "x\n")
	rl := open(t, linked)
	sideHead, err := rl.CommitAll(bg, linked, "side work")
	must(t, err)
	if got, _ := rl.Resolve(bg, "HEAD"); got != sideHead {
		t.Errorf("Resolve(HEAD) from the linked work tree = %s, want %s", got, sideHead)
	}
	if got, _ := r.Resolve(bg, "HEAD"); got == sideHead {
		t.Errorf("Resolve(HEAD) from the main work tree is the linked one's head")
	}

	plain := t.TempDir()
	notRepo := map[string]string{
		"a plain folder":         plain,
		"a folder that is not":   filepath.Join(plain, "missing"),
		"the inside of .git":     filepath.Join(root, ".git"),
		"a folder with a .git/ ": filepath.Join(plain, "fake"),
	}
	must(t, os.MkdirAll(filepath.Join(plain, "fake", ".git"), 0o755))
	for what, dir := range notRepo {
		if _, err := Open(bg, dir, WithEnv(hermetic...)); !errors.Is(err, ErrNotRepo) {
			t.Errorf("Open(%s) = %v, want ErrNotRepo", what, err)
		}
		if IsWorkTree(bg, dir, WithEnv(hermetic...)) {
			t.Errorf("IsWorkTree(%s) is true", what)
		}
	}
	for _, dir := range []string{root, sub, linked} {
		if !IsWorkTree(bg, dir, WithEnv(hermetic...)) {
			t.Errorf("IsWorkTree(%s) is false", dir)
		}
	}

	empty := initRepo(t, true)
	if _, err := Open(bg, empty, WithEnv(hermetic...)); !errors.Is(err, ErrNoCommits) {
		t.Errorf("Open(no commit) = %v, want ErrNoCommits", err)
	}
	if !IsWorkTree(bg, empty, WithEnv(hermetic...)) {
		t.Errorf("IsWorkTree(no commit) is false")
	}
}

// The variables that point git at another repository are dropped from the server's environment.
func TestEnvPointingElsewhereIsDropped(t *testing.T) {
	_, root := newRepo(t)
	other := initRepo(t, true)
	t.Setenv("GIT_DIR", filepath.Join(other, ".git"))
	t.Setenv("GIT_WORK_TREE", other)
	t.Setenv("GIT_INDEX_FILE", filepath.Join(other, ".git", "index"))
	r := open(t, root) // would be ErrNoCommits in other
	if r.Root() != root {
		t.Errorf("Root() = %s, want %s", r.Root(), root)
	}
	write(t, root, "g.txt", "g\n")
	if _, err := r.CommitAll(bg, root, "g"); err != nil {
		t.Fatal(err)
	}
	if got := git(t, root, "log", "--format=%s", "-1"); got != "g" {
		t.Errorf("the commit went elsewhere: last subject in the repository is %q", got)
	}
	for _, kv := range gitEnv(nil) {
		for _, name := range elsewhere {
			if strings.HasPrefix(kv, name+"=") {
				t.Errorf("%s is still in the environment", name)
			}
		}
	}
	for _, want := range []string{"GIT_TERMINAL_PROMPT=0", "GIT_EDITOR=true", "GIT_MERGE_AUTOEDIT=no", "GIT_OPTIONAL_LOCKS=0"} {
		if !contains(gitEnv(nil), want) {
			t.Errorf("%s is not in the environment", want)
		}
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func TestRefs(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	first := git(t, root, "rev-parse", "HEAD")
	git(t, root, "branch", "runs/x/one")
	git(t, root, "branch", "runs/x/two")
	git(t, root, "branch", "runs/xy/three")
	write(t, root, "g.txt", "g\n")
	second, err := r.CommitAll(bg, root, "second")
	must(t, err)

	for ref, want := range map[string]string{"HEAD": second, "main": second, "runs/x/one": first, first[:10]: first} {
		if got, err := r.Resolve(bg, ref); err != nil || got != want {
			t.Errorf("Resolve(%s) = %s, %v, want %s", ref, got, err, want)
		}
	}
	if _, err := r.Resolve(bg, "nope"); !errors.Is(err, ErrUnknownRef) {
		t.Errorf("Resolve(nope) = %v, want ErrUnknownRef", err)
	}
	if _, err := r.Resolve(bg, "--all"); err == nil {
		t.Errorf("Resolve(--all) took an option for a ref")
	}

	for name, want := range map[string]bool{"main": true, "runs/x/one": true, "runs/x": false, "nope": false} {
		if got, err := r.BranchExists(bg, name); err != nil || got != want {
			t.Errorf("BranchExists(%s) = %v, %v", name, got, err)
		}
	}
	for prefix, want := range map[string][]string{
		"runs/x/": {"runs/x/one", "runs/x/two"},
		"runs/":   {"runs/x/one", "runs/x/two", "runs/xy/three"},
		"":        {"main", "runs/x/one", "runs/x/two", "runs/xy/three"},
		"none/":   {},
	} {
		if got, err := r.Branches(bg, prefix); err != nil || !reflect.DeepEqual(got, want) {
			t.Errorf("Branches(%q) = %v, %v, want %v", prefix, got, err, want)
		}
	}

	for _, c := range []struct {
		a, b string
		want bool
	}{{"runs/x/one", "main", true}, {"main", "runs/x/one", false}, {"main", "main", true}} {
		if got, err := r.IsAncestor(bg, c.a, c.b); err != nil || got != c.want {
			t.Errorf("IsAncestor(%s, %s) = %v, %v", c.a, c.b, got, err)
		}
	}
	if _, err := r.IsAncestor(bg, "nope", "main"); err == nil {
		t.Errorf("IsAncestor(nope, main) is not an error")
	}

	// DeleteBranch: an unmerged branch goes, an absent one is fine, a checked-out one is an error.
	wt := sibling(root, "ahead")
	must(t, r.EnsureWorktree(bg, wt, "ahead", "main"))
	write(t, wt, "h.txt", "h\n")
	_, err = r.CommitAll(bg, wt, "unmerged work")
	must(t, err)
	var ge *Error
	if err := r.DeleteBranch(bg, "ahead"); !errors.As(err, &ge) || ge.Cmd != "branch" || ge.Output == "" {
		t.Errorf("DeleteBranch of a checked-out branch = %v, want a git error with its text", err)
	}
	must(t, r.RemoveWorktree(bg, wt))
	must(t, r.DeleteBranch(bg, "ahead"))
	must(t, r.DeleteBranch(bg, "ahead"))
	if ok, _ := r.BranchExists(bg, "ahead"); ok {
		t.Errorf("the branch is still there")
	}
	if got, _ := r.Branches(bg, "runs/"); len(got) != 3 {
		t.Errorf("other branches were touched: %v", got)
	}
}

func TestDirty(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	write(t, root, ".gitignore", "ignored/\n")
	_, err := r.CommitAll(bg, root, "ignore")
	must(t, err)
	sub := filepath.Join(root, "sub")
	must(t, os.MkdirAll(sub, 0o755))
	dirty := func(dir string) bool {
		t.Helper()
		d, err := r.Dirty(bg, dir)
		must(t, err)
		return d
	}
	if dirty(root) {
		t.Errorf("a clean work tree is dirty")
	}
	write(t, root, "ignored/x", "x\n")
	if dirty(root) {
		t.Errorf("an ignored file makes it dirty")
	}
	write(t, root, "untracked.txt", "x\n")
	if !dirty(root) || !dirty(sub) {
		t.Errorf("an untracked file does not make it dirty")
	}
	must(t, os.Remove(filepath.Join(root, "untracked.txt")))
	write(t, root, "f.txt", "changed\n")
	if !dirty(root) {
		t.Errorf("a changed file does not make it dirty")
	}
	// A linked work tree has its own state.
	wt := sibling(root, "clean")
	must(t, r.EnsureWorktree(bg, wt, "", "main"))
	if dirty(wt) {
		t.Errorf("the linked work tree is dirty")
	}
	if _, err := r.Dirty(bg, t.TempDir()); !errors.Is(err, ErrNotWorktree) {
		t.Errorf("Dirty(a plain folder) = %v, want ErrNotWorktree", err)
	}
}

// A folder inside a work tree that is not a work tree itself (its .git is gone, say) must not be
// taken for one: the command would act on the enclosing checkout.
func TestFolderInsideAWorkTreeIsRefused(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	inner := filepath.Join(root, "runs", "task")
	write(t, inner, "work.txt", "work\n")
	before := git(t, root, "status", "--porcelain")
	head := git(t, root, "rev-parse", "HEAD")

	if _, err := r.CommitAll(bg, inner, "x"); !errors.Is(err, ErrNotWorktree) {
		t.Errorf("CommitAll = %v, want ErrNotWorktree", err)
	}
	if _, err := r.Merge(bg, inner, "main", "x", true); !errors.Is(err, ErrNotWorktree) {
		t.Errorf("Merge = %v, want ErrNotWorktree", err)
	}
	if err := r.ResetDetached(bg, inner, "main"); !errors.Is(err, ErrNotWorktree) {
		t.Errorf("ResetDetached = %v, want ErrNotWorktree", err)
	}
	if _, err := r.Head(bg, inner); !errors.Is(err, ErrNotWorktree) {
		t.Errorf("Head = %v, want ErrNotWorktree", err)
	}
	if _, err := r.Merging(bg, inner); !errors.Is(err, ErrNotWorktree) {
		t.Errorf("Merging = %v, want ErrNotWorktree", err)
	}
	// Nor a work tree of another repository.
	_, other := newRepo(t)
	if _, err := r.CommitAll(bg, other, "x"); !errors.Is(err, ErrNotWorktree) {
		t.Errorf("CommitAll in another repository = %v, want ErrNotWorktree", err)
	}
	if got := git(t, root, "status", "--porcelain"); got != before {
		t.Errorf("the enclosing work tree changed: %q, was %q", got, before)
	}
	if got := git(t, root, "rev-parse", "HEAD"); got != head {
		t.Errorf("the enclosing work tree got a commit")
	}
	if got := git(t, root, "symbolic-ref", "HEAD"); got != "refs/heads/main" {
		t.Errorf("the enclosing work tree is at %s", got)
	}
}
