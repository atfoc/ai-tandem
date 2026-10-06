package rungit

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestChangesAndCommits(t *testing.T) {
	t.Parallel()
	r, root := newRepo(t)
	long := strings.Repeat("a line of a file that will be renamed\n", 20)
	write(t, root, "old/name.txt", long)
	write(t, root, "gone.txt", "1\n2\n3\n")
	write(t, root, "pic.bin", "\x00\x01\x02\x03")
	base, err := r.CommitAll(bg, root, "base")
	must(t, err)

	started := time.Now().Add(-2 * time.Second)
	write(t, root, "f.txt", "one\nTWO\nthree\nfour\n") // one line changed, one added
	write(t, root, "added.txt", "a\nb\n")
	first, err := r.CommitAll(bg, root, "T01: first")
	must(t, err)
	must(t, os.Remove(filepath.Join(root, "gone.txt")))
	must(t, os.MkdirAll(filepath.Join(root, "new"), 0o755))
	must(t, os.Rename(filepath.Join(root, "old", "name.txt"), filepath.Join(root, "new", "name.txt")))
	write(t, root, "new/name.txt", long+"and one more\n")
	write(t, root, "pic.bin", "\x00\x09\x08\x07\x06")
	write(t, root, "data.bin", "\x00\x00")
	write(t, root, "with space.txt", "x\n")
	second, err := r.CommitAll(bg, root, "T01: second\n\nwith a body")
	must(t, err)

	got, err := r.Changes(bg, base, second)
	must(t, err)
	want := []FileChange{
		{Path: "added.txt", Status: "A", Added: 2},
		{Path: "data.bin", Status: "A", Binary: true},
		{Path: "f.txt", Status: "M", Added: 2, Deleted: 1},
		{Path: "gone.txt", Status: "D", Deleted: 3},
		{Path: "new/name.txt", OldPath: "old/name.txt", Status: "R", Added: 1},
		{Path: "pic.bin", Status: "M", Binary: true},
		{Path: "with space.txt", Status: "A", Added: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Changes =\n%+v\nwant\n%+v", got, want)
	}
	// Refs work as well as shas; an empty range is an empty list.
	if got, err := r.Changes(bg, "HEAD~1", "main"); err != nil || len(got) != 5 {
		t.Errorf("Changes(HEAD~1, main) = %+v, %v", got, err)
	}
	if got, err := r.Changes(bg, second, second); err != nil || got == nil || len(got) != 0 {
		t.Errorf("Changes of an empty range = %#v, %v", got, err)
	}
	if _, err := r.Changes(bg, "nope", second); err == nil {
		t.Errorf("Changes from an unknown ref is not an error")
	}

	commits, err := r.Commits(bg, base, second)
	must(t, err)
	if len(commits) != 2 || commits[0].SHA != first || commits[1].SHA != second ||
		commits[0].Subject != "T01: first" || commits[1].Subject != "T01: second" {
		t.Fatalf("Commits = %+v", commits)
	}
	for _, c := range commits {
		if c.Time.Before(started) || c.Time.After(time.Now().Add(2*time.Second)) {
			t.Errorf("the time of %s is %s", c.Subject, c.Time)
		}
	}
	if got, err := r.Commits(bg, second, second); err != nil || got == nil || len(got) != 0 {
		t.Errorf("Commits of an empty range = %#v, %v", got, err)
	}
	if got, err := r.Commits(bg, second, base); err != nil || len(got) != 0 {
		t.Errorf("Commits backwards = %+v, %v", got, err)
	}

	// A merged branch: the range has the commits of both sides and the merge, oldest first.
	wt := sibling(root, "side")
	must(t, r.EnsureWorktree(bg, wt, "side", base))
	write(t, wt, "side.txt", "side\n")
	side, err := r.CommitAll(bg, wt, "side work")
	must(t, err)
	res, err := r.Merge(bg, root, "side", "Merge side", true)
	must(t, err)
	commits, err = r.Commits(bg, second, res.Head)
	must(t, err)
	if len(commits) != 2 || commits[0].SHA != side || commits[1].SHA != res.Head || commits[1].Subject != "Merge side" {
		t.Errorf("Commits over a merge = %+v", commits)
	}
}
