package rungit

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The tests of the functions that ask git with one command what they used to ask with several:
// each gives what the separate commands gave.

// setUser writes a [user] section with these lines into the config of the repository.
func setUser(t *testing.T, root string, lines ...string) {
	t.Helper()
	f, err := os.OpenFile(filepath.Join(root, ".git", "config"), os.O_APPEND|os.O_WRONLY, 0)
	must(t, err)
	_, err = f.WriteString("[user]\n\t" + strings.Join(lines, "\n\t") + "\n")
	must(t, err)
	must(t, f.Close())
}

func TestCommitIdentityAskedOnce(t *testing.T) {
	t.Parallel()
	fallback := []string{"-c", "commit.gpgsign=false", "-c", "user.name=Fall Back", "-c", "user.email=fall@back"}
	own := []string{"-c", "commit.gpgsign=false"}
	cases := []struct {
		what   string
		config []string
		want   []string
		author string // of a commit made there
	}{
		{"neither", nil, fallback, "Fall Back <fall@back>"},
		{"only a name", []string{"name = Only Name"}, fallback, "Fall Back <fall@back>"},
		{"only an email", []string{"email = only@example.com"}, fallback, "Fall Back <fall@back>"},
		{"both", []string{"name = Own", "email = own@example.com"}, own, "Own <own@example.com>"},
		{"both, the name twice", []string{"name = First", "email = own@example.com", "name = Second"}, own, "Second <own@example.com>"},
		{"both, the email twice", []string{"name = Own", "email = first@example.com", "email = second@example.com"}, own, "Own <second@example.com>"},
		{"a name that was emptied later", []string{"name = Own", "email = own@example.com", "name ="}, fallback, "Fall Back <fall@back>"},
		{"an email of blanks", []string{"name = Own", `email = "  "`}, fallback, "Fall Back <fall@back>"},
		{"keys in capitals", []string{"NAME = Own", "Email = own@example.com"}, own, "Own <own@example.com>"},
		{"other keys of the section", []string{"name = Own", "signingkey = ABCD", "useConfigOnly = false"}, fallback, "Fall Back <fall@back>"},
	}
	for _, c := range cases {
		t.Run(c.what, func(t *testing.T) {
			t.Parallel()
			root := initRepo(t, false)
			if c.config != nil {
				setUser(t, root, c.config...)
			}
			write(t, root, "f.txt", "one\n")
			git(t, root, "add", "-A")
			git(t, root, "-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-q", "-m", "init")
			r, err := Open(bg, root, WithEnv(hermetic...), WithIdentity("Fall Back", "fall@back"))
			must(t, err)

			got, err := r.commitOpts(bg, root)
			must(t, err)
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("commitOpts = %q, want %q", got, c.want)
			}
			// What the two commands, one per key, say.
			both := true
			for _, key := range []string{"user.name", "user.email"} {
				if out, _ := r.run(bg, root, "config", "--get", key); out == "" {
					both = false
				}
			}
			if has, known := r.ownIdentity(bg, root); !known || has != both {
				t.Errorf("ownIdentity = %v, %v; asked key by key: %v", has, known, both)
			}

			write(t, root, "g.txt", "g\n")
			_, err = r.CommitAll(bg, root, "work")
			must(t, err)
			if got := git(t, root, "log", "-1", "--format=%an <%ae>|%cn <%ce>"); got != c.author+"|"+c.author {
				t.Errorf("the commit is by %s, want %s", got, c.author)
			}
		})
	}
}

// A config that git cannot read is an error, as it was: no identity is made up for it.
func TestCommitIdentityOfABrokenConfig(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	f, err := os.OpenFile(filepath.Join(root, ".git", "config"), os.O_APPEND|os.O_WRONLY, 0)
	must(t, err)
	_, err = f.WriteString("[user\n")
	must(t, err)
	must(t, f.Close())
	if _, known := r.ownIdentity(bg, root); known {
		t.Errorf("ownIdentity knows the identity of a config that cannot be read")
	}
	var ge *Error
	if opts, err := r.commitOpts(bg, root); !errors.As(err, &ge) || ge.Cmd != "config" {
		t.Errorf("commitOpts = %q, %v, want the error of git config", opts, err)
	}
}

// What git config printed and how it ended, read without git: only "an entry and exit 0" and
// "nothing and exit 1" are answers, everything else is asked again key by key.
func TestIdentityIn(t *testing.T) {
	t.Parallel()
	exit := func(code int) error { return &Error{Cmd: "config", Code: code} }
	both := []string{"user.name\nOwn", "user.email\nown@example.com"}
	for _, c := range []struct {
		what       string
		entries    []string
		err        error
		own, known bool
	}{
		{"both", both, nil, true, true},
		{"only a name", both[:1], nil, false, true},
		{"a name without a value", []string{"user.name", both[1]}, nil, false, true},
		{"the last value counts", append(both[:2:2], "user.name\n"), nil, false, true},
		{"none, as git says it", nil, exit(1), false, true},
		{"nothing printed and exit 0", nil, nil, false, false},
		{"nothing printed and exit 0, an empty list", []string{}, nil, false, false},
		{"entries and exit 1", both, exit(1), false, false},
		{"a config git cannot read", nil, exit(128), false, false},
		{"a command that did not run to its end", nil, &Error{Cmd: "config", Code: -1, Err: context.Canceled}, false, false},
		{"another key", append(both[:2:2], "user.signingkey\nABCD"), nil, false, false},
	} {
		if own, known := identityIn(c.entries, c.err); own != c.own || known != c.known {
			t.Errorf("identityIn(%s) = %v, %v, want %v, %v", c.what, own, known, c.own, c.known)
		}
	}
}

// A repository that git refuses because it is another user's is neither ErrNotRepo nor
// ErrNoCommits: the error is git's, from the main work tree and from a linked one.
func TestOpenOfAnotherOwnersRepository(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	linked := sibling(root, "linked")
	must(t, r.EnsureWorktree(bg, linked, "side", "main"))
	theirs := WithEnv(append(hermetic[:len(hermetic):len(hermetic)], "GIT_TEST_ASSUME_DIFFERENT_OWNER=1")...)
	for what, dir := range map[string]string{"the main work tree": root, "a linked work tree": linked} {
		got, err := Open(bg, dir, theirs)
		var ge *Error
		if !errors.As(err, &ge) || ge.Code != 128 || errors.Is(err, ErrNotRepo) || errors.Is(err, ErrNoCommits) || got != nil {
			t.Errorf("Open(%s of another owner) = %v, %v, want git's error with exit 128", what, got, err)
		} else if !strings.Contains(ge.Output, "dubious ownership") {
			t.Errorf("Open(%s of another owner) = %v, which is not about the owner", what, err)
		}
	}
}

// A top level with a newline in its name cannot be told from two lines of git's answer: the one
// command is not taken for an answer, and Open fails as it did, step by step.
func TestOpenWithANewlineInThePath(t *testing.T) {
	t.Parallel()
	_, root := newRepo(t)
	odd := filepath.Join(filepath.Dir(root), "two\nlines")
	must(t, os.Rename(root, odd))
	if done, err := (&Repo{env: gitEnv(hermetic)}).openAtOnce(bg, odd); done {
		t.Errorf("openAtOnce took git's answer about %q: %v", odd, err)
	}
	got, err := Open(bg, odd, WithEnv(hermetic...))
	var ge *Error
	if got != nil || err == nil || errors.As(err, &ge) || errors.Is(err, ErrNotRepo) || errors.Is(err, ErrNoCommits) ||
		!strings.Contains(err.Error(), "git rev-parse in "+resolve(odd)+": unexpected output") {
		t.Errorf("Open(%q) = %v, %v, want the error about git's unexpected output", odd, got, err)
	}
}

func TestOpenErrors(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	plain := t.TempDir()
	write(t, plain, "file.txt", "x\n")
	bare := filepath.Join(plain, "bare.git")
	git(t, plain, "init", "-q", "--bare", "bare.git")
	linked := sibling(root, "linked")
	must(t, r.EnsureWorktree(bg, linked, "side", "main"))
	// A work tree whose git dir is not there: git says "not a git repository" with more words.
	must(t, os.MkdirAll(filepath.Join(plain, "lost"), 0o755))
	write(t, filepath.Join(plain, "lost"), ".git", "gitdir: "+filepath.Join(plain, "nowhere")+"\n")

	notRepo := map[string]string{
		"a folder that does not exist":     filepath.Join(plain, "missing"),
		"a file":                           filepath.Join(plain, "file.txt"),
		"a plain folder":                   plain,
		"a bare repository":                bare,
		"the inside of a bare repository":  filepath.Join(bare, "refs"),
		"the inside of .git":               filepath.Join(root, ".git"),
		"deep inside .git":                 filepath.Join(root, ".git", "refs", "heads"),
		"the git dir of a linked one":      filepath.Join(root, ".git", "worktrees", "linked"),
		"a work tree without its git dir ": filepath.Join(plain, "lost"),
	}
	for what, dir := range notRepo {
		got, err := Open(bg, dir, WithEnv(hermetic...))
		if !errors.Is(err, ErrNotRepo) || errors.Is(err, ErrNoCommits) || got != nil {
			t.Errorf("Open(%s) = %v, %v, want ErrNotRepo", what, got, err)
		}
		if IsWorkTree(bg, dir, WithEnv(hermetic...)) {
			t.Errorf("IsWorkTree(%s) is true", what)
		}
	}

	// An unborn HEAD: no commit at all, and a branch without one in a repository that has commits.
	empty := initRepo(t, true)
	must(t, os.MkdirAll(filepath.Join(empty, "sub"), 0o755))
	git(t, linked, "checkout", "-q", "--orphan", "fresh")
	for what, dir := range map[string]string{"no commit": empty, "a subfolder, no commit": filepath.Join(empty, "sub"), "an orphan branch": linked} {
		got, err := Open(bg, dir, WithEnv(hermetic...))
		if !errors.Is(err, ErrNoCommits) || errors.Is(err, ErrNotRepo) || got != nil {
			t.Errorf("Open(%s) = %v, %v, want ErrNoCommits", what, got, err)
		}
		if err != nil && !strings.Contains(err.Error(), resolve(strings.TrimSuffix(dir, "/sub"))) {
			t.Errorf("Open(%s) = %v, which does not name the top level", what, err)
		}
	}

	// A repository git refuses to use is neither: the error is git's.
	refused := initRepo(t, true)
	write(t, refused, "f.txt", "x\n")
	git(t, refused, "add", "-A")
	git(t, refused, "commit", "-q", "-m", "init")
	git(t, refused, "config", "core.repositoryformatversion", "99")
	var ge *Error
	if got, err := Open(bg, refused, WithEnv(hermetic...)); !errors.As(err, &ge) || ge.Code != 128 ||
		errors.Is(err, ErrNotRepo) || errors.Is(err, ErrNoCommits) || got != nil {
		t.Errorf("Open(a repository git refuses) = %v, %v, want git's error", got, err)
	}

	// A context that is done: its error, for a repository and for what is none.
	ctx, cancel := context.WithCancel(bg)
	cancel()
	for _, dir := range []string{root, plain, empty} {
		if got, err := Open(ctx, dir, WithEnv(hermetic...)); !errors.Is(err, context.Canceled) ||
			errors.Is(err, ErrNotRepo) || errors.Is(err, ErrNoCommits) || got != nil {
			t.Errorf("Open(%s) with a cancelled context = %v, %v", dir, got, err)
		}
	}
}

// Open gives the same Repo from every folder of a work tree, with a detached HEAD too.
func TestOpenAtOnce(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	linked := sibling(root, "linked")
	must(t, r.EnsureWorktree(bg, linked, "", "main"))
	must(t, os.MkdirAll(filepath.Join(root, "a", "b"), 0o755))
	must(t, os.MkdirAll(filepath.Join(linked, "deep"), 0o755))
	for dir, top := range map[string]string{
		root:                           root,
		filepath.Join(root, "a", "b"):  root,
		linked:                         resolve(linked),
		filepath.Join(linked, "deep"):  resolve(linked),
		filepath.Join(root, "a", "."):  root,
		filepath.Join(root, "a", ".."): root,
	} {
		got := &Repo{env: gitEnv(hermetic)}
		done, err := got.openAtOnce(bg, dir)
		if !done || err != nil || got.root != top || got.commonDir != r.CommonDir() {
			t.Errorf("openAtOnce(%s) = %v, %v: root %s, common dir %s", dir, done, err, got.root, got.commonDir)
		}
		o := open(t, dir)
		if o.Root() != top || o.CommonDir() != r.CommonDir() {
			t.Errorf("Open(%s): Root %s, CommonDir %s", dir, o.Root(), o.CommonDir())
		}
	}
	// What it cannot answer is left to the three commands.
	for _, dir := range []string{filepath.Join(root, "missing"), filepath.Join(root, "f.txt")} {
		if done, err := (&Repo{env: gitEnv(hermetic)}).openAtOnce(bg, dir); done || err != nil {
			t.Errorf("openAtOnce(%s) = %v, %v", dir, done, err)
		}
	}
	for s, want := range map[string]bool{
		"0123456789abcdef0123456789abcdef01234567":                         true,
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef": true,
		"0123456789ABCDEF0123456789abcdef01234567":                         false,
		"0123456789abcdef": false,
		"":                 false,
		"refs/heads/main0123456789abcdef012345678": false,
	} {
		if isSHA(s) != want {
			t.Errorf("isSHA(%q) = %v", s, !want)
		}
	}
}

func TestMergedBranches(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	base, err := r.Resolve(bg, "main")
	must(t, err)
	// aiwb/r1/a and aiwb/r1/b are merged into main, aiwb/r1/c is not; aiwb/r1/at is at main's
	// head, aiwb/r1/old at an ancestor of it, and aiwb/r10/x and other are of nobody's run r1.
	for _, name := range []string{"aiwb/r1/a", "aiwb/r1/b", "aiwb/r1/c"} {
		git(t, root, "checkout", "-q", "-b", name, base)
		write(t, root, strings.ReplaceAll(name, "/", "-")+".txt", name+"\n")
		_, err := r.CommitAll(bg, root, name)
		must(t, err)
	}
	git(t, root, "checkout", "-q", "main")
	git(t, root, "branch", "aiwb/r1/old")
	git(t, root, "merge", "-q", "--no-ff", "-m", "a", "aiwb/r1/a")
	git(t, root, "branch", "aiwb/r10/x")
	git(t, root, "merge", "-q", "--no-ff", "-m", "b", "aiwb/r1/b")
	git(t, root, "branch", "aiwb/r1/at")
	git(t, root, "branch", "other", "aiwb/r1/a")
	result, err := r.Resolve(bg, "main")
	must(t, err)

	check := func(prefix, into string, want ...string) {
		t.Helper()
		if want == nil {
			want = []string{}
		}
		got, err := r.MergedBranches(bg, prefix, into)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Errorf("MergedBranches(%q, %s) = %q, %v, want %q", prefix, into, got, err, want)
		}
		// What Branches, Resolve and IsAncestor say, branch by branch.
		all, err := r.Branches(bg, prefix)
		must(t, err)
		slow := []string{}
		for _, name := range all {
			head, err := r.Resolve(bg, "refs/heads/"+name)
			must(t, err)
			if in, err := r.IsAncestor(bg, head, into); err == nil && in {
				slow = append(slow, name)
			}
		}
		if !reflect.DeepEqual(got, slow) {
			t.Errorf("MergedBranches(%q, %s) = %q, branch by branch it is %q", prefix, into, got, slow)
		}
	}
	check("aiwb/r1/", result, "aiwb/r1/a", "aiwb/r1/at", "aiwb/r1/b", "aiwb/r1/old")
	check("aiwb/r1/", "main", "aiwb/r1/a", "aiwb/r1/at", "aiwb/r1/b", "aiwb/r1/old")
	check("aiwb/r1", result, "aiwb/r1/a", "aiwb/r1/at", "aiwb/r1/b", "aiwb/r1/old", "aiwb/r10/x")
	check("", result, "aiwb/r1/a", "aiwb/r1/at", "aiwb/r1/b", "aiwb/r1/old", "aiwb/r10/x", "main", "other")
	check("aiwb/r1/", base, "aiwb/r1/old")
	check("aiwb/r1/", "aiwb/r1/c", "aiwb/r1/c", "aiwb/r1/old")
	check("aiwb/r2/", result)
	if got, err := r.MergedBranches(bg, "aiwb/r2/", result); err != nil || got == nil {
		t.Errorf("MergedBranches of no branch = %#v, %v, want an empty list", got, err)
	}
	for _, into := range []string{"nope", "", "--all", strings.Repeat("0", 40)} {
		if got, err := r.MergedBranches(bg, "", into); err == nil {
			t.Errorf("MergedBranches into %q = %q, want an error", into, got)
		}
	}
}

func TestDeleteBranches(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	held := sibling(root, "held")
	must(t, r.EnsureWorktree(bg, held, "held", "main"))
	for _, name := range []string{"a", "b", "c", "keep"} {
		git(t, root, "branch", name)
	}
	git(t, root, "checkout", "-q", "-b", "unmerged")
	write(t, root, "u.txt", "u\n")
	_, err := r.CommitAll(bg, root, "unmerged work")
	must(t, err)
	git(t, root, "checkout", "-q", "main")
	branches := func() []string {
		t.Helper()
		names, err := r.Branches(bg, "")
		must(t, err)
		return names
	}

	must(t, r.DeleteBranches(bg))
	if got, want := branches(), []string{"a", "b", "c", "held", "keep", "main", "unmerged"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after deleting none: %q, want %q", got, want)
	}
	// One is checked out in a work tree and one is not there: the rest goes all the same, and the
	// error is of the one that is checked out, as DeleteBranch gives it.
	err = r.DeleteBranches(bg, "a", "held", "gone", "unmerged", "c")
	want := r.DeleteBranch(bg, "held")
	var ge, wantGe *Error
	if !errors.As(err, &ge) || !errors.As(want, &wantGe) || ge.Cmd != "branch" || ge.Code != wantGe.Code || ge.Output != wantGe.Output {
		t.Errorf("DeleteBranches = %v\nwant what DeleteBranch gives for the branch that is checked out: %v", err, want)
	}
	if got, want := branches(), []string{"b", "held", "keep", "main"}; !reflect.DeepEqual(got, want) {
		t.Errorf("branches afterwards: %q, want %q", got, want)
	}
	// Branches that are not there are no error, alone or among others.
	must(t, r.DeleteBranches(bg, "gone"))
	must(t, r.DeleteBranches(bg, "gone", "b", "a"))
	if got, want := branches(), []string{"held", "keep", "main"}; !reflect.DeepEqual(got, want) {
		t.Errorf("branches afterwards: %q, want %q", got, want)
	}
	// The branch the main work tree is on is an error too, and stays.
	if err := r.DeleteBranches(bg, "main", "keep"); err == nil {
		t.Errorf("deleting the branch that is checked out is not an error")
	}
	if got, want := branches(), []string{"held", "main"}; !reflect.DeepEqual(got, want) {
		t.Errorf("branches afterwards: %q, want %q", got, want)
	}
	// A name git would read as an option: nothing is deleted.
	git(t, root, "branch", "x")
	for _, bad := range []string{"-a", "", "--all"} {
		if err := r.DeleteBranches(bg, "x", bad); err == nil {
			t.Errorf("DeleteBranches(x, %q) is not an error", bad)
		}
	}
	if got, want := branches(), []string{"held", "main", "x"}; !reflect.DeepEqual(got, want) {
		t.Errorf("branches afterwards: %q, want %q", got, want)
	}
	ctx, cancel := context.WithCancel(bg)
	cancel()
	if err := r.DeleteBranches(ctx, "x"); !errors.Is(err, context.Canceled) {
		t.Errorf("DeleteBranches with a cancelled context = %v", err)
	}
}

// RemoveWorktree asks the folder first, and git's list for everything the folder cannot say.
func TestRemoveWorktreeAsksTheFolder(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	listed := func() string {
		t.Helper()
		return git(t, root, "worktree", "list", "--porcelain") + "\n"
	}

	// Through a symlink to it, with uncommitted work in it.
	task := sibling(root, "task")
	must(t, r.EnsureWorktree(bg, task, "task", "main"))
	write(t, task, "untracked.txt", "x\n")
	link := filepath.Join(t.TempDir(), "link")
	must(t, os.Symlink(task, link))
	if got := recordedAt(filepath.Join(r.CommonDir(), "worktrees", "task")); got != resolve(task) {
		t.Errorf("recordedAt = %q, want %s", got, resolve(task))
	}
	must(t, r.RemoveWorktree(bg, link))
	if exists(task) || strings.Contains(listed(), "worktree "+resolve(task)+"\n") {
		t.Errorf("the work tree is still there:\n%s", listed())
	}
	if ok, _ := r.BranchExists(bg, "task"); !ok {
		t.Errorf("the branch went with the work tree")
	}

	// A folder that was moved by hand: its .git still names the record, but the record names the
	// folder it was made in. It is not the work tree git knows, and is left alone.
	was, moved := sibling(root, "was"), sibling(root, "moved")
	must(t, r.EnsureWorktree(bg, was, "was", "main"))
	must(t, os.Rename(was, moved))
	write(t, moved, "keep.txt", "keep\n")
	if err := r.RemoveWorktree(bg, moved); !errors.Is(err, ErrNotWorktree) {
		t.Errorf("removing a work tree that was moved by hand = %v, want ErrNotWorktree", err)
	}
	if read(t, moved, "keep.txt") != "keep\n" {
		t.Errorf("the moved folder was touched")
	}
	must(t, r.RemoveWorktree(bg, was)) // the folder is gone: the record goes
	if strings.Contains(listed(), "refs/heads/was\n") {
		t.Errorf("the record of the moved work tree is still there:\n%s", listed())
	}

	// The work tree of another repository, and a subfolder of one of this repository.
	other, otherRoot := newRepo(t)
	foreign := sibling(otherRoot, "foreign")
	must(t, other.EnsureWorktree(bg, foreign, "foreign", "main"))
	sub := sibling(root, "sub")
	must(t, r.EnsureWorktree(bg, sub, "sub", "main"))
	must(t, os.MkdirAll(filepath.Join(sub, "inner", ".git"), 0o755))
	for what, path := range map[string]string{"a work tree of another repository": foreign, "a folder inside a work tree": filepath.Join(sub, "inner")} {
		if err := r.RemoveWorktree(bg, path); !errors.Is(err, ErrNotWorktree) {
			t.Errorf("removing %s = %v, want ErrNotWorktree", what, err)
		}
		if !exists(path) {
			t.Errorf("%s was removed", what)
		}
	}
	if err := r.RemoveWorktree(bg, root); !errors.Is(err, ErrWorktreeMismatch) {
		t.Errorf("removing the main work tree = %v, want ErrWorktreeMismatch", err)
	}
	if !exists(filepath.Join(sub, "f.txt")) || !exists(filepath.Join(root, "f.txt")) {
		t.Errorf("something was removed")
	}

	// A work tree somebody locked stays, and the error is git's.
	git(t, root, "worktree", "lock", sub)
	var ge *Error
	if err := r.RemoveWorktree(bg, sub); !errors.As(err, &ge) || ge.Cmd != "worktree remove" {
		t.Errorf("removing a locked work tree = %v, want the error of git worktree remove", err)
	}
	if !exists(filepath.Join(sub, "f.txt")) {
		t.Errorf("the locked work tree was removed")
	}
	for gitDir, want := range map[string]string{filepath.Join(root, "nowhere"): "", r.CommonDir(): ""} {
		if got := recordedAt(gitDir); got != want {
			t.Errorf("recordedAt(%s) = %q, want %q", gitDir, got, want)
		}
	}
}

func TestChangesWithOneDiff(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	long := strings.Repeat("a line of a file that will be renamed\n", 20)
	write(t, root, "old name.txt", long)
	write(t, root, "exact.txt", strings.Repeat("moved as it is\n", 10))
	write(t, root, "gone.txt", "1\n2\n3\n")
	write(t, root, "pic.bin", "\x00\x01\x02\x03")
	write(t, root, "gone.bin", "\x00\x01")
	write(t, root, "mode.sh", "echo\n")
	write(t, root, "link", "was a file\n")
	write(t, root, ":colon", "1\n")
	write(t, root, "tab\there.txt", "1\n")
	base, err := r.CommitAll(bg, root, "base")
	must(t, err)

	must(t, os.Rename(filepath.Join(root, "old name.txt"), filepath.Join(root, ":new name.txt")))
	write(t, root, ":new name.txt", long+"and one more\n")
	must(t, os.MkdirAll(filepath.Join(root, "dir"), 0o755))
	must(t, os.Rename(filepath.Join(root, "exact.txt"), filepath.Join(root, "dir", "exact.txt")))
	must(t, os.Remove(filepath.Join(root, "gone.txt")))
	must(t, os.Remove(filepath.Join(root, "gone.bin")))
	write(t, root, "pic.bin", "\x00\x09\x08\x07\x06")
	write(t, root, "new.bin", "\x00\x00")
	write(t, root, "added.txt", "a\nb\n")
	write(t, root, "empty.txt", "")
	write(t, root, "f.txt", "one\nTWO\nthree\nfour\n")
	must(t, os.Chmod(filepath.Join(root, "mode.sh"), 0o755))
	must(t, os.Remove(filepath.Join(root, "link")))
	must(t, os.Symlink("f.txt", filepath.Join(root, "link")))
	write(t, root, ":colon", "1\n2\n")
	write(t, root, "tab\there.txt", "2\n")
	head, err := r.CommitAll(bg, root, "head")
	must(t, err)

	want := []FileChange{
		{Path: ":colon", Status: "M", Added: 1},
		{Path: ":new name.txt", OldPath: "old name.txt", Status: "R", Added: 1},
		{Path: "added.txt", Status: "A", Added: 2},
		{Path: "dir/exact.txt", OldPath: "exact.txt", Status: "R"},
		{Path: "empty.txt", Status: "A"},
		{Path: "f.txt", Status: "M", Added: 2, Deleted: 1},
		{Path: "gone.bin", Status: "D", Binary: true},
		{Path: "gone.txt", Status: "D", Deleted: 3},
		{Path: "link", Status: "M", Added: 1, Deleted: 1},
		{Path: "mode.sh", Status: "M"},
		{Path: "new.bin", Status: "A", Binary: true},
		{Path: "pic.bin", Status: "M", Binary: true},
		{Path: "tab\there.txt", Status: "M", Added: 1, Deleted: 1},
	}
	// twoDiffs is what the two commands, one per list, give.
	twoDiffs := func(base, head string) []FileChange {
		t.Helper()
		diff := func(format string) []string {
			list, err := r.runZ(bg, root, "diff", "--no-ext-diff", "--no-textconv", "-M", format, "-z", base, head, "--")
			must(t, err)
			return list
		}
		changes, _, err := fileChanges(diff("--name-status"), diff("--numstat"))
		must(t, err)
		return changes
	}
	for _, pair := range [][2]string{{base, head}, {head, base}, {base, base}, {"HEAD~1", "main"}} {
		got, err := r.Changes(bg, pair[0], pair[1])
		must(t, err)
		if old := twoDiffs(pair[0], pair[1]); !reflect.DeepEqual(got, old) {
			t.Errorf("Changes(%s, %s) =\n%+v\nwith two diffs it is\n%+v", pair[0], pair[1], got, old)
		}
		if pair == [2]string{base, head} && !reflect.DeepEqual(got, want) {
			t.Errorf("Changes =\n%+v\nwant\n%+v", got, want)
		}
		// The one diff was enough: it had the counts of every file.
		both, err := r.runZ(bg, root, "diff", "--no-ext-diff", "--no-textconv", "-M", "--raw", "--numstat", "-z", pair[0], pair[1], "--")
		must(t, err)
		names, stats, ok := splitRaw(both)
		changes, counted, err := fileChanges(names, stats)
		if !ok || err != nil || counted != len(changes) || !reflect.DeepEqual(changes, got) {
			t.Errorf("one diff of %s and %s: ok %v, %v, counts of %d of %d files", pair[0], pair[1], ok, err, counted, len(changes))
		}
	}
	if _, err := r.Changes(bg, "nope", head); err == nil {
		t.Errorf("Changes from an unknown ref is not an error")
	}
}

// What git diff --raw --numstat -z printed, read without git: it is the list of Changes only
// when every entry of --raw has its counts, and counts alone are not "no changes".
func TestBothLists(t *testing.T) {
	t.Parallel()
	raw := []string{":100644 100644 aaaaaaa bbbbbbb M", "f.txt", ":100644 100644 aaaaaaa bbbbbbb R085", "old", "new"}
	counts := []string{"2\t1\tf.txt", "1\t0\t", "old", "new"}
	want := []FileChange{{Path: "f.txt", Status: "M", Added: 2, Deleted: 1}, {Path: "new", OldPath: "old", Status: "R", Added: 1}}
	if got, ok := bothLists(append(raw[:len(raw):len(raw)], counts...)); !ok || !reflect.DeepEqual(got, want) {
		t.Errorf("bothLists = %+v, %v, want %+v", got, ok, want)
	}
	if got, ok := bothLists(nil); !ok || got == nil || len(got) != 0 {
		t.Errorf("bothLists of nothing = %+v, %v, want no changes", got, ok)
	}
	for what, entries := range map[string][]string{
		"only the counts, as a git that left --raw out would print them": counts,
		"only the counts of one file":                                    counts[:1],
		"only the entries of --raw":                                      raw,
		"the counts of one file of two":                                  append(raw[:len(raw):len(raw)], counts[0]),
		"an entry of --raw without its path":                             raw[:1],
		"counts that are none":                                           append(raw[:2:2], "f.txt"),
	} {
		if got, ok := bothLists(entries); ok {
			t.Errorf("bothLists(%s) = %+v, want not ok", what, got)
		}
	}
}

func TestSplitRaw(t *testing.T) {
	t.Parallel()
	names, stats, ok := splitRaw([]string{
		":100644 100644 aaaaaaa bbbbbbb M", ":colon",
		":100644 100644 aaaaaaa bbbbbbb R085", "old", ":new",
		":000000 100644 0000000 bbbbbbb A", "added",
		"1\t0\t:colon", "1\t0\t", "old", ":new", "2\t0\tadded",
	})
	wantNames := []string{"M", ":colon", "R085", "old", ":new", "A", "added"}
	wantStats := []string{"1\t0\t:colon", "1\t0\t", "old", ":new", "2\t0\tadded"}
	if !ok || !reflect.DeepEqual(names, wantNames) || !reflect.DeepEqual(stats, wantStats) {
		t.Errorf("splitRaw = %q, %q, %v", names, stats, ok)
	}
	if names, stats, ok := splitRaw(nil); !ok || len(names) != 0 || len(stats) != 0 {
		t.Errorf("splitRaw of nothing = %q, %q, %v", names, stats, ok)
	}
	for what, entries := range map[string][]string{
		"an entry without its path":      {":100644 100644 aaaaaaa bbbbbbb M"},
		"a rename with one path":         {":100644 100644 aaaaaaa bbbbbbb R100", "old"},
		"an entry with too few fields":   {":100644 aaaaaaa bbbbbbb M", "path"},
		"an entry without a status":      {":100644 100644 aaaaaaa bbbbbbb ", "path"},
		"an entry with the path in it":   {":100644 100644 aaaaaaa bbbbbbb M\tpath", "1\t0\tpath"},
		"an entry of a merge (two modes": {"::100644 100644 100644 aaaaaaa bbbbbbb ccccccc MM", "path"},
	} {
		if names, stats, ok := splitRaw(entries); ok {
			t.Errorf("splitRaw(%s) = %q, %q, want not ok", what, names, stats)
		}
	}
	// Only the entries of --raw, as a git that left --numstat out would print them: the counts
	// are missing, and Changes asks again.
	names, stats, ok = splitRaw([]string{":100644 100644 aaaaaaa bbbbbbb M", "f.txt"})
	changes, counted, err := fileChanges(names, stats)
	if !ok || err != nil || len(changes) != 1 || counted != 0 {
		t.Errorf("without the counts: %v, %v, %d changes, %d counted", ok, err, len(changes), counted)
	}
}
