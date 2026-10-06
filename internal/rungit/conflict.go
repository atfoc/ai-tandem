package rungit

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The lines git writes into a file it could not merge: "<<<<<<< ours", "||||||| base" (in the
// diff3 styles), "=======" and ">>>>>>> theirs". They are spelled this way so that no line of this
// file is one.
var (
	markOurs   = strings.Repeat("<", 7) + " "
	markBase   = strings.Repeat("|", 7) + " "
	markTheirs = strings.Repeat(">", 7) + " "
	markSplit  = strings.Repeat("=", 7)
)

// marker is a conflict-marker line in a file.
type marker struct {
	line int    // 1-based
	kind byte   // '<', '|', '=' or '>'
	text string // the line
}

// ConflictProblems says why the merge in progress in the work tree dir cannot be concluded yet:
// one line per problem, none when it can. files are the paths that conflicted when the merge
// stopped (what Merge returned), which the caller keeps, because they are no longer unmerged once
// somebody staged them. ErrNotMerging when no merge is in progress.
//
// A problem is a file with a conflict-marker line that the merge put there. The files looked at
// are files and every other file that ConcludeMerge would commit as different from HEAD. In them,
// a line that starts with seven '<', '|' or '>' and a space counts, and a line of exactly seven
// '=' counts when it stands between such lines or the file is one of files. A marker line that the
// file already had before the merge is content and does not count: a line counts only when it
// occurs more often than on either side and more often than a clean merge of the two would have it.
//
// A path that is still unmerged in the index is not a problem (ConcludeMerge stages everything),
// nor is a file that was deleted (a valid resolution). Binary files, symlinks and folders are not
// read. So a binary or a delete/modify conflict that nobody touched passes, as the side git left
// in the work tree: nothing in the files tells it from a deliberate choice.
func (r *Repo) ConflictProblems(ctx context.Context, dir string, files []string) ([]string, error) {
	t, err := r.tree(ctx, dir)
	if err != nil {
		return nil, err
	}
	if !exists(t.mergeHead) {
		return nil, fmt.Errorf("%w in %s", ErrNotMerging, dir)
	}
	changed, err := r.runZ(ctx, t.top, "diff", "--name-only", "--no-renames", "--no-ext-diff", "-z", "HEAD")
	if err != nil {
		return nil, err
	}
	untracked, err := r.runZ(ctx, t.top, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return nil, err
	}
	conflicted := map[string]bool{}
	for _, f := range files {
		conflicted[filepath.ToSlash(filepath.Clean(f))] = true
	}
	seen := map[string]bool{}
	var paths []string
	for _, list := range [][]string{files, changed, untracked} {
		for _, f := range list {
			if f = filepath.ToSlash(filepath.Clean(f)); !seen[f] {
				seen[f] = true
				paths = append(paths, f)
			}
		}
	}
	sort.Strings(paths)

	problems := []string{}
	var sides []string // ours, theirs and their merge base ("" when they have none), once needed
	for _, path := range paths {
		if !filepath.IsLocal(filepath.FromSlash(path)) {
			return nil, fmt.Errorf("%s is not a path inside the work tree", path)
		}
		full := filepath.Join(t.top, filepath.FromSlash(path))
		if fi, err := os.Lstat(full); err != nil || !fi.Mode().IsRegular() {
			continue // deleted, or not a file with lines
		}
		f, err := os.Open(full)
		if err != nil {
			return nil, err
		}
		marks, err := findMarkers(f)
		f.Close()
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", full, err)
		}
		if len(marks) == 0 {
			continue
		}
		if sides == nil {
			sides = []string{"HEAD", "MERGE_HEAD", ""}
			if base, err := r.run(ctx, t.top, "merge-base", "HEAD", "MERGE_HEAD"); err == nil {
				sides[2] = base
			} else if ctx.Err() != nil {
				return nil, err
			}
		}
		var had [3]map[string]int // the marker lines of the file in ours, in theirs and in their base
		for i, rev := range sides {
			had[i] = map[string]int{}
			if rev == "" {
				continue
			}
			blob, _, err := runRaw(ctx, r.env, t.top, "cat-file", "blob", rev+":"+path)
			if err != nil {
				if ctx.Err() != nil {
					return nil, err
				}
				continue // the file is not on this side
			}
			old, _ := findMarkers(strings.NewReader(blob))
			for _, m := range old {
				had[i][m.text]++
			}
		}
		// How often a line may be there without the merge having put it there: as often as on
		// either side, or as in a clean merge of the two (what both have from the base, once).
		before := map[string]int{}
		for _, m := range marks {
			ours, theirs := had[0][m.text], had[1][m.text]
			before[m.text] = max(ours, theirs, ours+theirs-had[2][m.text])
		}
		if left := leftover(marks, before, conflicted[path]); len(left) > 0 {
			problems = append(problems, describe(path, left))
		}
	}
	return problems, nil
}

// leftover picks from the marker lines of a file those that the merge left: the lines that occur
// more often than before, and of the "=======" lines only those between other markers, unless
// strict (the file is one that conflicted).
func leftover(marks []marker, before map[string]int, strict bool) []marker {
	now := map[string]int{}
	for _, m := range marks {
		now[m.text]++
	}
	var left []marker
	for i, m := range marks {
		if now[m.text] <= before[m.text] {
			continue
		}
		if m.kind == '=' && !strict && !between(marks, i) {
			continue
		}
		left = append(left, m)
	}
	return left
}

// between reports whether the "=======" line marks[i] stands where git puts one: after the start
// of a conflict or before the end of one.
func between(marks []marker, i int) bool {
	for j := i - 1; j >= 0; j-- {
		if k := marks[j].kind; k != '=' {
			if k == '<' || k == '|' {
				return true
			}
			break
		}
	}
	for j := i + 1; j < len(marks); j++ {
		if k := marks[j].kind; k != '=' {
			return k == '>'
		}
	}
	return false
}

// describe makes the problem line of a file.
func describe(path string, left []marker) string {
	const show = 6
	var b strings.Builder
	fmt.Fprintf(&b, "%s: conflict markers left at line ", path)
	for i, m := range left {
		if i == show {
			fmt.Fprintf(&b, " and %d more", len(left)-show)
			break
		}
		if i > 0 {
			b.WriteString(", ")
		}
		text := m.text
		if len(text) > 40 {
			text = strings.ToValidUTF8(text[:40], "") + "…"
		}
		fmt.Fprintf(&b, "%d (%s)", m.line, text)
	}
	return b.String()
}

// findMarkers returns the conflict-marker lines of a text. A binary file (one with a NUL byte near
// its start, which is how git decides) has none.
func findMarkers(src io.Reader) ([]marker, error) {
	rd := bufio.NewReaderSize(src, 64<<10)
	if start, _ := rd.Peek(8000); bytes.IndexByte(start, 0) >= 0 {
		return nil, nil
	}
	var marks []marker
	for n := 1; ; n++ {
		line, err := rd.ReadSlice('\n')
		whole := err == nil || err == io.EOF
		if kind := markerKind(line, whole); kind != 0 {
			marks = append(marks, marker{line: n, kind: kind, text: string(bytes.TrimRight(line, "\r\n"))})
		}
		for errors.Is(err, bufio.ErrBufferFull) { // a very long line: skip the rest of it
			_, err = rd.ReadSlice('\n')
		}
		if err == io.EOF {
			return marks, nil
		}
		if err != nil {
			return nil, err
		}
	}
}

// markerKind says which marker the line is ('<', '|', '=', '>'), or 0. whole is false when line is
// only the start of a longer one.
func markerKind(line []byte, whole bool) byte {
	switch {
	case bytes.HasPrefix(line, []byte(markOurs)):
		return '<'
	case bytes.HasPrefix(line, []byte(markBase)):
		return '|'
	case bytes.HasPrefix(line, []byte(markTheirs)):
		return '>'
	case whole && string(bytes.TrimRight(line, "\r\n")) == markSplit:
		return '='
	}
	return 0
}
