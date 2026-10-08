package rungit

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Head returns the sha of the commit that the work tree dir is at.
func (r *Repo) Head(ctx context.Context, dir string) (string, error) {
	t, err := r.tree(ctx, dir)
	if err != nil {
		return "", err
	}
	return r.head(ctx, t.top)
}

func (r *Repo) head(ctx context.Context, dir string) (string, error) {
	return r.run(ctx, dir, "rev-parse", "--verify", "HEAD^{commit}")
}

// Merging reports whether a merge is in progress in the work tree dir (MERGE_HEAD exists), whether
// it stopped on conflicts or is resolved and only waits to be committed.
func (r *Repo) Merging(ctx context.Context, dir string) (bool, error) {
	t, err := r.tree(ctx, dir)
	if err != nil {
		return false, err
	}
	return exists(t.mergeHead), nil
}

// AbortMerge aborts the merge in progress in the work tree dir, which puts the work tree back
// where it was before the merge. It is not an error when no merge is in progress.
func (r *Repo) AbortMerge(ctx context.Context, dir string) error {
	t, err := r.tree(ctx, dir)
	if err != nil || !exists(t.mergeHead) {
		return err
	}
	ctx, done, err := r.guard(ctx, t)
	if err != nil {
		return err
	}
	defer done()
	_, err = r.run(ctx, t.top, "merge", "--abort")
	return err
}

// Unmerged lists the paths that are unmerged in the index of the work tree dir (relative to its
// top level, with forward slashes), sorted. It is empty when there is none.
func (r *Repo) Unmerged(ctx context.Context, dir string) ([]string, error) {
	t, err := r.tree(ctx, dir)
	if err != nil {
		return nil, err
	}
	return r.unmerged(ctx, t.top)
}

func (r *Repo) unmerged(ctx context.Context, dir string) ([]string, error) {
	return r.runZ(ctx, dir, "diff", "--name-only", "--diff-filter=U", "-z")
}

// CommitAll stages everything in the work tree dir and commits it with msg when there is
// something to commit. It returns the head afterwards, also when nothing was left to commit
// because the agent committed by itself. A commit that a hook refuses is made with --no-verify.
//
// In a work tree that is in the middle of a merge it returns ErrMerging and changes nothing:
// staging would mark the conflicting files resolved, and the commit would conclude the merge with
// the conflict markers in them. ConcludeMerge is what ends a merge. For the same reason it
// returns ErrUnmerged, and changes nothing, when the index has unmerged paths without a merge
// (the agent left a cherry-pick, a rebase or a stash pop in conflict).
func (r *Repo) CommitAll(ctx context.Context, dir, msg string) (string, error) {
	if msg == "" {
		return "", fmt.Errorf("commit in %s: no message", dir)
	}
	t, err := r.tree(ctx, dir)
	if err != nil {
		return "", err
	}
	if exists(t.mergeHead) {
		return "", fmt.Errorf("%w in %s", ErrMerging, dir)
	}
	ctx, done, err := r.guard(ctx, t)
	if err != nil {
		return "", err
	}
	defer done()
	if left, err := r.unmerged(ctx, t.top); err != nil {
		return "", err
	} else if len(left) > 0 {
		return "", fmt.Errorf("%w in %s: %s", ErrUnmerged, dir, strings.Join(left, ", "))
	}
	if _, err := r.run(ctx, t.top, "add", "-A"); err != nil {
		return "", err
	}
	// Something is staged when the index differs from HEAD (exit 1).
	if _, err := r.run(ctx, t.top, "diff", "--cached", "--quiet", "--no-ext-diff"); err != nil {
		if exitCode(err) != 1 {
			return "", err
		}
		if err := r.commit(ctx, t.top, msg); err != nil {
			return "", err
		}
	}
	return r.head(ctx, t.top)
}

// commitOpts are the options of the package's own commits and merges.
func (r *Repo) commitOpts(ctx context.Context, dir string) ([]string, error) {
	// Never signed: the server has no terminal where a passphrase could be asked for, so a
	// repository set up to sign commits would block or fail here.
	opts := []string{"-c", "commit.gpgsign=false"}
	own, known := r.ownIdentity(ctx, dir)
	if !known {
		own = true
		for _, key := range []string{"user.name", "user.email"} {
			out, err := r.run(ctx, dir, "config", "--get", key)
			if err != nil && exitCode(err) != 1 {
				return nil, err
			}
			if out == "" {
				own = false
				break
			}
		}
	}
	if !own { // the repository has no identity of its own: use the fallback for both
		return append(opts, "-c", "user.name="+r.name, "-c", "user.email="+r.email), nil
	}
	return opts, nil
}

// ownIdentity asks git for user.name and user.email with one command and reports whether both
// have a value. The last value of a key counts, as for git. known is false when the command
// failed, printed something else than those two keys, or ended well without printing any: the
// caller then asks for each key by itself. Nothing is remembered: the person can change the
// config between two commits.
func (r *Repo) ownIdentity(ctx context.Context, dir string) (own, known bool) {
	entries, err := r.runZ(ctx, dir, "config", "--null", "--get-regexp", `^user\.(name|email)$`)
	return identityIn(entries, err)
}

// identityIn is ownIdentity for what git printed, entries, and how it ended, err.
func identityIn(entries []string, err error) (own, known bool) {
	// An entry is "key\nvalue", or just "key" for a key without a value. Git exits with 0 when it
	// printed an entry and with 1 when none is set; neither or both is not an answer.
	if set := len(entries) > 0; set != (err == nil) || !set && exitCode(err) != 1 {
		return false, false
	}
	var name, email string
	for _, e := range entries {
		key, value, _ := strings.Cut(e, "\n")
		switch key {
		case "user.name":
			name = strings.TrimSpace(value)
		case "user.email":
			email = strings.TrimSpace(value)
		default:
			return false, false
		}
	}
	return name != "" && email != "", true
}

// commit commits what is staged in dir, with msg or, when msg is "", with the message git has
// prepared (of a merge). When the commit fails, a hook may have refused it, and a hook must not
// wedge a run: it is made again with --no-verify.
func (r *Repo) commit(ctx context.Context, dir, msg string) error {
	opts, err := r.commitOpts(ctx, dir)
	if err != nil {
		return err
	}
	args := append(opts, "commit", "-q")
	if msg != "" {
		args = append(args, "-m", msg)
	} else {
		args = append(args, "--no-edit")
	}
	_, first := r.run(ctx, dir, args...)
	if first == nil || ctx.Err() != nil {
		return first
	}
	if _, err := r.run(ctx, dir, append(args, "--no-verify")...); err != nil {
		return fmt.Errorf("%w\nthe first try, with hooks: %v", err, first)
	}
	return nil
}

// MergeResult is how a merge ended when it did not fail.
type MergeResult struct {
	Merged    bool     // the merge is done (a merge commit, a fast-forward, or nothing to merge)
	Head      string   // the head of the work tree afterwards, when Merged
	Conflicts []string // the unmerged paths, when the merge stopped on conflicts (then Merged is false)
	Output    string   // what git printed: for a conflict, one CONFLICT line per path saying what kind
}

// Merge merges ref into the branch that the work tree dir is on, with msg as the message of the
// merge commit ("" for git's own). With noFF there is always a merge commit; without, git
// fast-forwards when it can. It never opens an editor.
//
//   - Merged: the merge is done, or there was nothing to merge; Head is the head afterwards.
//   - Not Merged, no error: the merge stopped on conflicts. Conflicts lists the unmerged paths and
//     the merge is left in progress in dir: the caller aborts it (AbortMerge) or has it resolved
//     and concludes it (ConcludeMerge).
//   - An error: the merge failed for another reason (local changes in the way, an unknown ref,
//     histories without a common commit) and dir is as it was before; Output has git's text.
//     ErrMerging when a merge was already in progress in dir, which is not touched. A merge that
//     ctx interrupts is undone too, and the error is the context's; one that git still got to
//     the end of (it is left a moment for that, see settle) is Merged.
//
// When git stops with nothing unmerged because a hook refused the merge commit, the merge is
// concluded with --no-verify, as CommitAll does.
func (r *Repo) Merge(ctx context.Context, dir, ref, msg string, noFF bool) (MergeResult, error) {
	if err := checkArg("ref", ref); err != nil {
		return MergeResult{}, err
	}
	t, err := r.tree(ctx, dir)
	if err != nil {
		return MergeResult{}, err
	}
	if exists(t.mergeHead) {
		return MergeResult{}, fmt.Errorf("%w in %s", ErrMerging, dir)
	}
	ctx, done, err := r.guard(ctx, t)
	if err != nil {
		return MergeResult{}, err
	}
	defer done()
	opts, err := r.commitOpts(ctx, t.top)
	if err != nil {
		return MergeResult{}, err
	}
	before, err := r.head(ctx, t.top)
	if err != nil {
		return MergeResult{}, err
	}
	// Whether something was staged before the merge: if so, a failed merge must leave it there.
	_, err = r.run(ctx, t.top, "diff", "--cached", "--quiet", "--no-ext-diff")
	if err != nil && exitCode(err) != 1 {
		return MergeResult{}, err
	}
	cleanIndex := err == nil
	// The options that the user's config could turn the other way are given explicitly.
	args := append(opts, "merge", "--no-edit", "--no-stat", "--no-autostash", "--no-verify-signatures")
	if noFF {
		args = append(args, "--no-ff")
	} else {
		args = append(args, "--ff")
	}
	if msg != "" {
		args = append(args, "-m", msg)
	}
	stdout, stderr, err := runGit(ctx, r.env, t.top, append(args, ref)...)
	res := MergeResult{Output: clip(strings.TrimSpace(stdout+"\n"+stderr), 4*maxErrText)}
	if err == nil && ctx.Err() == nil {
		res.Head, err = r.head(ctx, t.top)
		res.Merged = err == nil
		return res, err
	}
	if ctx.Err() != nil {
		// Interrupted. The caller's context can no longer run git, so this one does.
		bg, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		if err == nil { // git got to the end of the merge all the same
			res.Head, err = r.head(bg, t.top)
			res.Merged = err == nil
			return res, err
		}
		if head, herr := r.head(bg, t.top); herr == nil && head != before && !exists(t.mergeHead) {
			res.Merged, res.Head = true, head // the merge was done when the signal came
			return res, nil
		}
		r.undoMerge(bg, t, cleanIndex)
		return res, err
	}
	if !exists(t.mergeHead) {
		// Git refused. As a rule it had changed nothing yet; undoMerge is for when it had.
		r.undoMerge(ctx, t, cleanIndex)
		return res, err
	}
	if res.Conflicts, err = r.unmerged(ctx, t.top); err != nil || len(res.Conflicts) > 0 {
		return res, err
	}
	// The merge itself went through and only the commit is missing: a hook refused it.
	if cerr := r.commit(ctx, t.top, msg); cerr != nil {
		bg, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		r.undoMerge(bg, t, cleanIndex)
		return res, cerr
	}
	res.Head, err = r.head(ctx, t.top)
	res.Merged = err == nil
	return res, err
}

// undoMerge puts a work tree back after a merge that did not get to its end: it aborts the merge
// when git has it on record, and otherwise takes back what the merge had already put into the
// index and the files (git records a merge only when it stops; ended in the middle, it leaves the
// merged files staged and nothing else). cleanIndex says that nothing was staged before the
// merge; when something was, it is not known what is the merge's, and nothing is taken back.
func (r *Repo) undoMerge(ctx context.Context, t tree, cleanIndex bool) {
	if exists(t.mergeHead) {
		r.run(ctx, t.top, "merge", "--abort")
	} else if cleanIndex {
		r.run(ctx, t.top, "reset", "-q", "--merge", "HEAD")
	}
}

// ConcludeMerge finishes the merge in progress in the work tree dir: it stages everything and
// commits with msg ("" for the message the merge was started with), with --no-verify when a hook
// refuses. It returns the new head.
//
// It refuses with an *UnresolvedError (errors.Is ErrUnresolved) that carries the problems when
// ConflictProblems(dir, files) is not empty, and changes nothing then. ErrNotMerging when no merge
// is in progress.
func (r *Repo) ConcludeMerge(ctx context.Context, dir, msg string, files []string) (string, error) {
	problems, err := r.ConflictProblems(ctx, dir, files)
	if err != nil {
		return "", err
	}
	if len(problems) > 0 {
		return "", &UnresolvedError{Problems: problems}
	}
	t, err := r.tree(ctx, dir)
	if err != nil {
		return "", err
	}
	ctx, done, err := r.guard(ctx, t)
	if err != nil {
		return "", err
	}
	defer done()
	if _, err := r.run(ctx, t.top, "add", "-A"); err != nil {
		return "", err
	}
	if err := r.commit(ctx, t.top, msg); err != nil {
		return "", err
	}
	return r.head(ctx, t.top)
}
