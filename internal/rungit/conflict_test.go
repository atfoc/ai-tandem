package rungit

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// The marker lines as git writes them when it merges int into the task's work tree.
var (
	lineOurs   = markOurs + "HEAD"
	lineTheirs = markTheirs + "int"
)

// startResolution merges int into the task's work tree, which stops on f.txt.
func startResolution(t *testing.T, c conflict) []string {
	t.Helper()
	res, err := c.r.Merge(bg, c.taskDir, "int", "Merge int into T02", false)
	if err != nil || res.Merged || !reflect.DeepEqual(res.Conflicts, []string{"f.txt"}) {
		t.Fatalf("the merge should stop on f.txt: %+v, %v", res, err)
	}
	if want := "one\n" + lineOurs + "\nTASK\n" + markSplit + "\nOTHER\n" + lineTheirs + "\nthree\n"; read(t, c.taskDir, "f.txt") != want {
		t.Fatalf("f.txt is not the conflict expected:\n%s", read(t, c.taskDir, "f.txt"))
	}
	return res.Conflicts
}

func TestConflictProblems(t *testing.T) {
	t.Parallel()
	c := newConflict(t)
	r := c.r
	if _, err := r.ConflictProblems(bg, c.taskDir, nil); !errors.Is(err, ErrNotMerging) {
		t.Errorf("ConflictProblems without a merge = %v, want ErrNotMerging", err)
	}
	if _, err := r.ConcludeMerge(bg, c.taskDir, "x", nil); !errors.Is(err, ErrNotMerging) {
		t.Errorf("ConcludeMerge without a merge = %v, want ErrNotMerging", err)
	}
	files := startResolution(t, c)

	refused := func(what, content string, files []string, wantInProblem ...string) {
		t.Helper()
		write(t, c.taskDir, "f.txt", content)
		for _, staged := range []bool{false, true} {
			if staged { // the agent ran `git add`: the path is no longer unmerged
				git(t, c.taskDir, "add", "f.txt")
			}
			problems, err := r.ConflictProblems(bg, c.taskDir, files)
			must(t, err)
			if len(problems) != 1 || !strings.HasPrefix(problems[0], "f.txt: ") {
				t.Errorf("%s (staged %v): problems = %q, want one for f.txt", what, staged, problems)
				continue
			}
			for _, want := range wantInProblem {
				if !strings.Contains(problems[0], want) {
					t.Errorf("%s: the problem %q does not have %q", what, problems[0], want)
				}
			}
			before := state(t, c.taskDir, "f.txt")
			_, err = r.ConcludeMerge(bg, c.taskDir, "Merge int into T02", files)
			var ue *UnresolvedError
			if !errors.Is(err, ErrUnresolved) || !errors.As(err, &ue) || !reflect.DeepEqual(ue.Problems, problems) {
				t.Errorf("%s (staged %v): ConcludeMerge = %v, want ErrUnresolved with the problems", what, staged, err)
			}
			if state(t, c.taskDir, "f.txt") != before {
				t.Errorf("%s (staged %v): the refused ConcludeMerge changed the work tree", what, staged)
			}
		}
	}
	untouched := read(t, c.taskDir, "f.txt")
	refused("untouched", untouched, files, "2 ("+lineOurs+")", "4 ("+markSplit+")", "6 ("+lineTheirs+")")
	refused("untouched, files not given", untouched, nil, "2 (", "4 (", "6 (")
	// Half resolved: the script only looked for the first and the last marker line.
	refused("only the end left", "one\nTASK\n"+markSplit+"\nOTHER\n"+lineTheirs+"\nthree\n", files, "3 (", "5 (")
	refused("only the end left, files not given", "one\nTASK\n"+markSplit+"\nOTHER\n"+lineTheirs+"\nthree\n", nil, "3 (", "5 (")
	refused("only the start left", "one\n"+lineOurs+"\nTASK\n"+markSplit+"\nOTHER\nthree\n", files, "2 (", "4 (")
	refused("only the separator left", "one\nTASK\n"+markSplit+"\nOTHER\nthree\n", files, "3 ("+markSplit+")")
	refused("diff3 style", "one\n"+lineOurs+"\nTASK\n"+markBase+"base\ntwo\n"+markSplit+"\nOTHER\n"+lineTheirs+"\nthree\n", files, "4 (")
	refused("CRLF line ends", "one\r\nTASK\r\n"+markSplit+"\r\nOTHER\r\n"+lineTheirs+"\r\nthree\r\n", files, "3 (", "5 (")

	// A line of seven '=' alone, in a file that never conflicted, is taken for content.
	write(t, c.taskDir, "f.txt", "one\nTASK and OTHER\nthree\n")
	write(t, c.taskDir, "notes.md", "Title\n"+markSplit+"\ntext\n")
	problems, err := r.ConflictProblems(bg, c.taskDir, files)
	if err != nil || len(problems) != 0 {
		t.Errorf("a resolved merge has problems: %q, %v", problems, err)
	}
	// But markers in a file that was not on the list are found: a new file, a changed one.
	write(t, c.taskDir, "notes.md", "a\n"+lineOurs+"\nb\n"+markSplit+"\nc\n"+lineTheirs+"\n")
	write(t, c.taskDir, "task.txt", "task\n"+lineTheirs+"\n")
	problems, err = r.ConflictProblems(bg, c.taskDir, files)
	if err != nil || len(problems) != 2 || !strings.HasPrefix(problems[0], "notes.md: ") || !strings.HasPrefix(problems[1], "task.txt: ") {
		t.Errorf("markers outside the list: %q, %v", problems, err)
	}
	if _, err := r.ConflictProblems(bg, c.taskDir, []string{"../outside.txt"}); err == nil {
		t.Errorf("a path outside the work tree is not an error")
	}
}

func TestConcludeMerge(t *testing.T) {
	t.Parallel()
	c := newConflict(t)
	r := c.r
	files := startResolution(t, c)
	intHead := git(t, c.root, "rev-parse", "int")
	taskHead := git(t, c.root, "rev-parse", "task")

	// The merge agent edits the file and does not stage it.
	write(t, c.taskDir, "f.txt", "one\nTASK and OTHER\nthree\n")
	head, err := r.ConcludeMerge(bg, c.taskDir, "Merge int into T02", files)
	must(t, err)
	if head != git(t, c.taskDir, "rev-parse", "HEAD") || head != git(t, c.root, "rev-parse", "task") {
		t.Errorf("the head returned is %s", head)
	}
	if got := git(t, c.taskDir, "log", "-1", "--format=%s|%P"); got != "Merge int into T02|"+taskHead+" "+intHead {
		t.Errorf("the merge commit is %s", got)
	}
	if m, _ := r.Merging(bg, c.taskDir); m || git(t, c.taskDir, "status", "--porcelain") != "" {
		t.Errorf("the merge is not concluded")
	}
	if got := git(t, c.root, "show", "task:f.txt"); got != "one\nTASK and OTHER\nthree" {
		t.Errorf("the resolution committed is %q", got)
	}
	if read(t, c.taskDir, "other.txt") != "other\n" || read(t, c.taskDir, "task.txt") != "task\n" {
		t.Errorf("one side's file is missing")
	}
	if _, err := r.ConcludeMerge(bg, c.taskDir, "again", files); !errors.Is(err, ErrNotMerging) {
		t.Errorf("a second ConcludeMerge = %v, want ErrNotMerging", err)
	}
}

// Taking one side entirely makes the work tree equal to HEAD: there is still a merge to commit.
func TestConcludeMergeWithOurSide(t *testing.T) {
	t.Parallel()
	c := newConflict(t)
	files := startResolution(t, c)
	git(t, c.taskDir, "checkout", "--ours", "f.txt")
	head, err := c.r.ConcludeMerge(bg, c.taskDir, "", files)
	must(t, err)
	if parents(t, c.taskDir, head) != 2 || read(t, c.taskDir, "f.txt") != "one\nTASK\nthree\n" {
		t.Errorf("not a merge commit with our side")
	}
	// Without a message, the one the merge was started with is used.
	if got := git(t, c.taskDir, "log", "-1", "--format=%s"); got != "Merge int into T02" {
		t.Errorf("the message of the merge is %q", got)
	}
}

// A delete/modify conflict resolved by deleting the file, and a binary conflict resolved by taking
// one side: neither has lines to check, and neither fails the check (B11).
func TestConcludeMergeDeletedAndBinary(t *testing.T) {
	t.Parallel()
	c := newConflict(t)
	r := c.r
	// Task and integration both have other.txt and bin.dat; then they part.
	write(t, c.intDir, "bin.dat", "base\x00\x01\x02")
	_, err := r.CommitAll(bg, c.intDir, "int: add bin.dat")
	must(t, err)
	git(t, c.taskDir, "merge", "-q", "--no-edit", "-X", "ours", "int")
	must(t, os.Remove(filepath.Join(c.intDir, "other.txt")))
	write(t, c.intDir, "bin.dat", "int\x00\x05\x06")
	_, err = r.CommitAll(bg, c.intDir, "int: delete other.txt, change bin.dat")
	must(t, err)
	write(t, c.taskDir, "other.txt", "other, changed by the task\n")
	write(t, c.taskDir, "bin.dat", "task\x00\x03\x04")
	_, err = r.CommitAll(bg, c.taskDir, "T02: change other.txt and bin.dat")
	must(t, err)

	res, err := r.Merge(bg, c.taskDir, "int", "Merge int into T02", false)
	if err != nil || res.Merged || !reflect.DeepEqual(res.Conflicts, []string{"bin.dat", "other.txt"}) {
		t.Fatalf("the merge should stop on bin.dat and other.txt: %+v, %v", res, err)
	}
	// The merge agent: integration deleted the file, so it goes; integration's binary wins.
	must(t, os.Remove(filepath.Join(c.taskDir, "other.txt")))
	git(t, c.taskDir, "checkout", "--theirs", "bin.dat")
	if problems, err := r.ConflictProblems(bg, c.taskDir, res.Conflicts); err != nil || len(problems) != 0 {
		t.Fatalf("problems = %q, %v", problems, err)
	}
	head, err := r.ConcludeMerge(bg, c.taskDir, "Merge int into T02", res.Conflicts)
	must(t, err)
	if parents(t, c.taskDir, head) != 2 {
		t.Errorf("not a merge commit")
	}
	if got := git(t, c.taskDir, "ls-tree", "--name-only", "HEAD"); got != "bin.dat\nf.txt\ntask.txt" {
		t.Errorf("the tree committed is %q", got)
	}
	if read(t, c.taskDir, "bin.dat") != "int\x00\x05\x06" {
		t.Errorf("bin.dat is not integration's")
	}
	// And it merges into integration.
	if res, err := r.Merge(bg, c.intDir, "task", "Merge T02: task", true); err != nil || !res.Merged {
		t.Errorf("the final merge: %+v, %v", res, err)
	}
}

// Files that had marker lines before the merge (documentation about git, a test fixture) are not
// taken for unresolved, yet a real conflict in such a file is still found.
func TestConflictProblemsWithMarkersThatAreContent(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	// On both sides from the start: a file that shows exactly the lines git will write.
	example := "A conflict looks like this:\n" + lineOurs + "\nmine\n" + markSplit + "\nyours\n" + lineTheirs + "\nline: base\n"
	write(t, root, "doc.md", example)
	_, err := r.CommitAll(bg, root, "doc")
	must(t, err)
	intDir, taskDir := sibling(root, "integration"), sibling(root, "task")
	must(t, r.EnsureWorktree(bg, intDir, "int", "main"))
	must(t, r.EnsureWorktree(bg, taskDir, "task", "int"))
	// Integration changes the last line, adds a fixture with markers, and deletes nothing.
	fixture := lineOurs + "\na\n" + markSplit + "\nb\n" + lineTheirs + "\n"
	write(t, intDir, "doc.md", strings.Replace(example, "line: base", "line: int", 1))
	write(t, intDir, "fixture.txt", fixture)
	_, err = r.CommitAll(bg, intDir, "int")
	must(t, err)
	write(t, taskDir, "doc.md", strings.Replace(example, "line: base", "line: task", 1))
	write(t, taskDir, "own-fixture.txt", fixture)
	_, err = r.CommitAll(bg, taskDir, "task")
	must(t, err)

	res, err := r.Merge(bg, taskDir, "int", "Merge int into task", false)
	if err != nil || res.Merged || !reflect.DeepEqual(res.Conflicts, []string{"doc.md"}) {
		t.Fatalf("the merge should stop on doc.md: %+v, %v", res, err)
	}
	// Unresolved: only doc.md is a problem, and the lines named are those that are too many.
	problems, err := r.ConflictProblems(bg, taskDir, res.Conflicts)
	if err != nil || len(problems) != 1 || !strings.HasPrefix(problems[0], "doc.md: ") {
		t.Fatalf("unresolved: problems = %q, %v", problems, err)
	}
	// Resolved, with the example still in the file: no problem, and neither fixture is one.
	write(t, taskDir, "doc.md", strings.Replace(example, "line: base", "line: task and int", 1))
	if problems, err := r.ConflictProblems(bg, taskDir, res.Conflicts); err != nil || len(problems) != 0 {
		t.Fatalf("resolved: problems = %q, %v", problems, err)
	}
	if _, err := r.ConcludeMerge(bg, taskDir, "Merge int into task", res.Conflicts); err != nil {
		t.Fatal(err)
	}
	if read(t, taskDir, "fixture.txt") != fixture || read(t, taskDir, "own-fixture.txt") != fixture {
		t.Errorf("a fixture is missing")
	}
}

func TestFindMarkers(t *testing.T) {
	long := strings.Repeat("x", 200<<10)
	text := "a\n" + lineOurs + "\n" + markSplit + "\n" + markSplit + " not alone\n " + lineOurs + "\n" +
		long + "\n" + markTheirs + long + "\n" + markBase + "base\n" + strings.Repeat("=", 8) + "\n" +
		strings.Repeat("<", 7) + "no space\n" + markSplit
	marks, err := findMarkers(strings.NewReader(text))
	must(t, err)
	var got []string
	for _, m := range marks {
		got = append(got, string(m.kind)+":"+strconv.Itoa(m.line))
	}
	if want := []string{"<:2", "=:3", ">:7", "|:8", "=:11"}; !reflect.DeepEqual(got, want) {
		t.Errorf("markers = %v, want %v", got, want)
	}
	if marks, _ := findMarkers(strings.NewReader("bin\x00ary\n" + lineOurs + "\n")); len(marks) != 0 {
		t.Errorf("a binary file has markers: %v", marks)
	}
	if marks, _ := findMarkers(strings.NewReader("")); len(marks) != 0 {
		t.Errorf("an empty file has markers: %v", marks)
	}
}
