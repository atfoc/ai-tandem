package rungit

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// FileChange is one file that differs between two commits.
type FileChange struct {
	Path    string // where the file is in head (where it was in base, for a deleted file)
	OldPath string // where it was in base, when it was renamed; else ""
	Status  string // "A" added, "M" modified, "D" deleted, "R" renamed
	Added   int    // lines added; 0 for a binary file
	Deleted int    // lines deleted; 0 for a binary file
	Binary  bool
}

// Commit is one commit of a range.
type Commit struct {
	SHA     string
	Subject string    // the first line of its message
	Time    time.Time // when it was authored
}

// Changes lists the files that differ between the commits base and head, sorted by path: what
// `git diff base head` shows, which is what an attempt changed when base is the commit it started
// from. Renames are detected. The list is empty when the two are the same.
func (r *Repo) Changes(ctx context.Context, base, head string) ([]FileChange, error) {
	if err := errors.Join(checkArg("ref", base), checkArg("ref", head)); err != nil {
		return nil, err
	}
	diff := func(format string) ([]string, error) {
		return r.runZ(ctx, r.root, "diff", "--no-ext-diff", "--no-textconv", "-M", format, "-z", base, head, "--")
	}
	names, err := diff("--name-status")
	if err != nil {
		return nil, err
	}
	stats, err := diff("--numstat")
	if err != nil {
		return nil, err
	}
	changes := []FileChange{}
	at := map[string]int{}
	for i := 0; i < len(names); i++ {
		c := FileChange{Status: names[i][:1]}
		paths := 1
		switch c.Status {
		case "R", "C": // "R100", old path, new path
			paths = 2
		case "T": // the type changed (a file became a symlink)
			c.Status = "M"
		}
		if i+paths >= len(names) {
			return nil, fmt.Errorf("git diff --name-status: unexpected output %q", strings.Join(names, " "))
		}
		if paths == 2 {
			c.OldPath = names[i+1]
			if c.Status == "C" {
				c.Status, c.OldPath = "A", ""
			}
		}
		c.Path = names[i+paths]
		i += paths
		at[c.Path] = len(changes)
		changes = append(changes, c)
	}
	// A numstat entry is "added<TAB>deleted<TAB>path", or "added<TAB>deleted<TAB>" followed by the
	// old and the new path for a rename; "-" stands for the counts of a binary file.
	for i := 0; i < len(stats); i++ {
		f := strings.SplitN(stats[i], "\t", 3)
		if len(f) != 3 {
			return nil, fmt.Errorf("git diff --numstat: unexpected output %q", stats[i])
		}
		path := f[2]
		if path == "" && i+2 < len(stats) {
			path = stats[i+2]
			i += 2
		}
		n, ok := at[path]
		if !ok {
			continue
		}
		if f[0] == "-" {
			changes[n].Binary = true
			continue
		}
		changes[n].Added, _ = strconv.Atoi(f[0])
		changes[n].Deleted, _ = strconv.Atoi(f[1])
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].Path < changes[j].Path })
	return changes, nil
}

// Commits lists the commits that are in head and not in base (base..head), oldest first. The
// list is empty when there is none.
func (r *Repo) Commits(ctx context.Context, base, head string) ([]Commit, error) {
	if err := errors.Join(checkArg("ref", base), checkArg("ref", head)); err != nil {
		return nil, err
	}
	out, err := r.run(ctx, r.root, "log", "--reverse", "--no-show-signature", "--format=%H%x09%at%x09%s",
		base+".."+head, "--")
	if err != nil {
		return nil, err
	}
	commits := []Commit{}
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		f := strings.SplitN(line, "\t", 3)
		if len(f) != 3 {
			return nil, fmt.Errorf("git log: unexpected output %q", line)
		}
		sec, err := strconv.ParseInt(f[1], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("git log: unexpected output %q", line)
		}
		commits = append(commits, Commit{SHA: f[0], Subject: f[2], Time: time.Unix(sec, 0)})
	}
	return commits, nil
}
