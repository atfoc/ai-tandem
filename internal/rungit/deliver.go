package rungit

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// DeliverReq says what to apply where.
type DeliverReq struct {
	Folder      string // the run's folder (the person's cwd; may be a sub-folder of the work tree)
	Base        string // the commit the run started from
	Result      string // the commit to apply (the integration head)
	StartBranch string // the folder's branch when the run started; "" = detached
	Auto        bool   // tried by the run's end: the folder must be on StartBranch and still have Base
	Branch      string // by hand: the folder's branch as the person saw it ("HEAD" = detached); "" = not given
	Scratch     string // where the scratch worktree for a merge commit may be made (it does not exist)
	Message     string // the message of that merge commit
	DryRun      bool   // steps 1 to 8 only: say what would happen, change nothing at all
}

// Delivery is the outcome. The string values are exactly those of model.RunDelivery.
type Delivery struct {
	State  string   // "none" | "pending" | "applied" | "blocked"
	Reason string   // none: "no_changes"; pending: "other_branch" | "history_changed"; blocked: "local_changes" | "conflict" | "busy" | "folder_missing" | "not_repo" | "result_missing" | "git"
	How    string   // applied: "ff" | "merge" | "already"
	Commit string   // applied: the folder's HEAD afterwards
	Branch string   // the folder's branch when tried; "" = detached
	Files  []string // local_changes, conflict: at most 50 paths
	More   int      // paths left out
	Detail string   // reason "git": git's words; "git" and "busy" when the branch could not be moved: what is in the folder now
}

const (
	// deliverTimeout is how long one Deliver may take, the wait for another one on the same
	// repository included. A fast-forward that has begun in the folder by then is not held to it.
	deliverTimeout = 2 * time.Minute
	// lateTime is what Deliver has to look at the folder once its time is up.
	lateTime = 30 * time.Second
	// headPoll is how often a fast-forward that outlives the time of its Deliver is asked whether
	// HEAD has arrived.
	headPoll = 200 * time.Millisecond
	// deliverRetries is how often Deliver starts again because the person moved HEAD meanwhile.
	deliverRetries = 3
	// maxDeliveryFiles is how many paths a Delivery names.
	maxDeliveryFiles = 50
)

// busyFiles are the files and folders of a git dir that exist while the person is in the middle of
// a git operation.
var busyFiles = []string{"MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"}

// The options of the one command that changes the person's folder. --ff-only makes git refuse,
// before it writes anything, what is not a plain fast-forward; without --no-overwrite-ignore git
// silently overwrites an ignored file that is in the way. The others are what the person's config
// could turn the other way.
var ffOnly = []string{"merge", "--ff-only", "--no-stat", "--no-autostash", "--no-overwrite-ignore", "--no-verify-signatures"}

// deliverLocks has one lock per shared git dir, as repoLocks has: only one Deliver works on a
// repository at a time in this process.
var deliverLocks sync.Map

func lockDelivery(ctx context.Context, commonDir string) (unlock func(), err error) {
	v, _ := deliverLocks.LoadOrStore(commonDir, make(chan struct{}, 1))
	mu := v.(chan struct{})
	select {
	case mu <- struct{}{}:
		return func() { <-mu }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Deliver applies the commit req.Result to the person's folder, or says why it did not. It is the
// only function of the package that changes a folder the person works in, and the one thing it
// ever does there is
//
//	git merge --ff-only --no-stat --no-autostash --no-overwrite-ignore --no-verify-signatures <commit>
//
// which git refuses with HEAD, the index and every file as they were when something of the person
// is in the way. The person's uncommitted changes stay when the result does not touch their files,
// and block the delivery when it does. There is no force, reset, stash or checkout.
//
// The command is not all or nothing: git writes the files and the index first and moves the branch
// last. So it is never ended before HEAD has moved (see step 9), and when git itself cannot move
// the branch after it wrote the files (a lock on the ref, a hook that refuses the update), the
// outcome says that the result's files are in the folder, staged, with HEAD where it was. Nothing
// is reset then: the next Deliver, once the cause is gone, completes the fast-forward.
//
//  1. The folder is gone: blocked, folder_missing. It is not inside a work tree, or the
//     repository has neither the result nor the base commit: blocked, not_repo.
//  2. The result is not a commit of the repository: blocked, result_missing. It is the base:
//     none, no_changes.
//  3. HEAD and the branch of the folder are read.
//  4. The result is already in HEAD, and the folder is on a branch that step 6 allows: applied,
//     how "already". A second Deliver after one that applied, or after the person merged by hand,
//     ends here. A folder that merely has the result checked out (the run's own branch, a branch
//     made to look at it, a detached HEAD) does not: that is for step 6.
//  5. A merge, cherry-pick, revert, bisect or rebase is in progress, or the index has unmerged
//     paths: blocked, busy.
//  6. With Auto the folder must be on StartBranch (detached when StartBranch is ""). Without, it
//     may also be on another branch when Branch names that branch. A branch under aiwb/ is a
//     run's and never allowed. Otherwise: pending, other_branch.
//     With Auto, Base must still be in HEAD. When the person amended, rebased or reset the commit
//     the run started from away, applying would bring it back: pending, history_changed, and
//     nothing is changed. A person's Apply (no Auto) applies all the same; a dry run says
//     pending, history_changed for it too, so that the person can be told first.
//  7. When HEAD is an ancestor of the result, the result itself is what the folder gets (how
//     "ff"). When the person has committed meanwhile, a merge commit of HEAD and the result is
//     built in a work tree at Scratch (how "merge", first parent the person's commit, the person's
//     identity, not signed); a conflict there is blocked, conflict with the paths. The scratch
//     work tree is removed before Deliver returns, whatever happened. The person's hooks do not
//     run in it: it is not their checkout, and a hook that fails there would block the delivery.
//     With DryRun nothing is built: git merge-tree says whether the merge conflicts and what its
//     tree would be, with no checkout, no work tree on record, no hook, and no object left in the
//     repository. A git older than 2.38 cannot: pending with no reason, without a look.
//  8. With DryRun it ends here: blocked, local_changes with the files of the person that are in
//     the way, or pending with no reason when the fast-forward is expected to work.
//  9. The fast-forward, with the person's hooks. It is not started when the time is up. Once
//     started it runs to its end, however long that takes: only when HEAD is at the target, and
//     what still runs is the person's post-merge hook, the time is held against it. When git
//     refuses and HEAD has moved since step 3, it starts again from there, at most three times.
//     Otherwise what git says decides: files in the way are blocked, local_changes with them; a
//     locked index or ref, or an operation that began meanwhile, is blocked, busy; anything else
//     is blocked, git with git's words in Detail. When git could not move the branch after it
//     wrote the files, Detail says so (busy for a locked ref, else git).
//
// Steps 3 to 9 run one Deliver at a time per repository. After two minutes, or when ctx ends,
// Deliver stops, unless it is in step 9, and step 4 says whether the result was applied by then.
//
// opts are those of Open; only WithEnv matters here.
func Deliver(ctx context.Context, req DeliverReq, opts ...Option) Delivery {
	return newDeliverer(opts).deliver(ctx, req)
}

// deliverer is what Deliver works with; tests change it.
type deliverer struct {
	env     []string
	timeout time.Duration
	// beforeApply, when set, is called between step 8 and step 9 with the number of the try (0
	// for the first).
	beforeApply func(try int)
	// noMergeTree stands for a git that has no merge-tree --write-tree (older than 2.38).
	noMergeTree bool
}

func newDeliverer(opts []Option) *deliverer {
	// LC_ALL=C comes last: step 9 reads git's messages.
	return &deliverer{env: append(gitEnv(newOptions(opts).env), "LC_ALL=C"), timeout: deliverTimeout}
}

// delivering is one Deliver at work.
type delivering struct {
	d      *deliverer
	ctx    context.Context
	req    DeliverReq
	r      *Repo  // the repository of the folder; root is the top of the folder's work tree
	quiet  *Repo  // r without the person's hooks: for the scratch work tree
	result string // the sha of req.Result
	base   string // the sha of req.Base; "" when none was given
	// Of the current try:
	branch string // the folder's branch, "" when detached
	target string // the commit the fast-forward goes to, once step 7 has it
	how    string // "ff" or "merge", with target
}

func (d *deliverer) deliver(ctx context.Context, req DeliverReq) Delivery {
	ctx, cancel := context.WithTimeout(ctx, d.timeout)
	defer cancel()
	dl := &delivering{d: d, ctx: ctx, req: req}

	// Step 1.
	if req.Folder == "" {
		return dl.blocked("folder_missing")
	}
	folder, err := filepath.Abs(req.Folder)
	if err != nil {
		return dl.blocked("folder_missing")
	}
	if fi, err := os.Stat(folder); err != nil || !fi.IsDir() {
		return dl.blocked("folder_missing")
	}
	if _, err := insideWorkTree(ctx, d.env, folder); err != nil {
		if errors.Is(err, ErrNotRepo) {
			return dl.blocked("not_repo")
		}
		return dl.failed(err)
	}
	out, _, err := runGit(ctx, d.env, folder, "rev-parse", "--show-toplevel", "--git-common-dir")
	if err != nil {
		return dl.failed(err)
	}
	lines := strings.Split(out, "\n")
	if len(lines) != 2 {
		return dl.failed(fmt.Errorf("git rev-parse in %s: unexpected output %q", folder, out))
	}
	dl.r = &Repo{root: resolve(lines[0]), commonDir: resolve(absIn(folder, lines[1])), env: d.env}
	dl.quiet = &Repo{root: dl.r.root, commonDir: dl.r.commonDir, env: noHooks(d.env)}

	// Step 2. A repository that has neither the result nor the commit the run started from is not
	// the one the run worked in.
	result, err := dl.sha(req.Result)
	if err != nil {
		return dl.failed(err)
	}
	base := ""
	if req.Base != "" {
		if base, err = dl.sha(req.Base); err != nil {
			return dl.failed(err)
		}
	}
	switch {
	case result == "" && req.Base != "" && base == "":
		return dl.blocked("not_repo")
	case result == "":
		return dl.blocked("result_missing")
	case result == base:
		return Delivery{State: "none", Reason: "no_changes"}
	}
	dl.result, dl.base = result, base

	// Steps 3 to 9.
	unlock, err := lockDelivery(ctx, dl.r.commonDir)
	if err != nil {
		return dl.failed(err)
	}
	defer unlock()
	for try := 0; ; try++ {
		out, moved := dl.attempt(try)
		if !moved || try == deliverRetries {
			return out
		}
	}
}

// attempt is steps 3 to 9. moved says that git refused the fast-forward and HEAD is not where
// step 3 found it: the person committed or switched meanwhile, and out is of a state that is gone.
func (dl *delivering) attempt(try int) (out Delivery, moved bool) {
	ctx, r := dl.ctx, dl.r
	dl.branch, dl.target, dl.how = "", "", ""

	// Step 3. head is "" on a branch without a commit.
	head, err := r.run(ctx, r.root, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")
	if err != nil && (exitCode(err) != 1 || ctx.Err() != nil) {
		return dl.failed(err), false
	}
	if dl.branch, err = r.branch(ctx, r.root); err != nil {
		return dl.failed(err), false
	}

	// Step 4. Only where a result may be applied: a folder that has the result checked out on
	// another branch, or on the run's own, is looking at it.
	if head != "" && dl.branchAllowed() {
		done, err := r.IsAncestor(ctx, dl.result, head)
		if err != nil {
			return dl.failed(err), false
		}
		if done {
			return dl.applied("already", head), false
		}
	}

	// Step 5.
	if busy, err := dl.busy(); err != nil {
		return dl.failed(err), false
	} else if busy {
		return dl.blocked("busy"), false
	}

	// Step 6.
	if !dl.branchAllowed() {
		return Delivery{State: "pending", Reason: "other_branch", Branch: dl.branch}, false
	}
	if head == "" {
		return dl.failed(errors.New("the folder's branch has no commit yet")), false
	}
	if dl.base != "" && dl.base != head && (dl.req.Auto || dl.req.DryRun) {
		kept, err := r.IsAncestor(ctx, dl.base, head)
		if err != nil {
			return dl.failed(err), false
		}
		if !kept {
			return Delivery{State: "pending", Reason: "history_changed", Branch: dl.branch}, false
		}
	}

	// Step 7.
	target, how := dl.result, "ff"
	ff, err := r.IsAncestor(ctx, head, dl.result)
	if err != nil {
		return dl.failed(err), false
	}
	if !ff {
		scratch, err := dl.scratchPath()
		if err != nil {
			return dl.failed(err), false
		}
		if dl.req.DryRun {
			return dl.dryMerge(head), false
		}
		defer dl.removeScratch(scratch)
		var conflicts []string
		if target, conflicts, err = dl.mergeOutside(scratch, head); err != nil {
			return dl.failed(err), false
		}
		if len(conflicts) > 0 {
			return dl.withFiles("conflict", conflicts), false
		}
		how = "merge"
	}
	dl.target, dl.how = target, how

	// Step 8.
	if dl.req.DryRun {
		return dl.wouldApply(r, head, target), false
	}
	if dl.d.beforeApply != nil {
		dl.d.beforeApply(try)
	}

	// Step 9. It is not started when the time is up. Once started it runs to its end, or to the
	// person's hook, whatever the time, so what it left is looked at with time of its own.
	if ctx.Err() != nil {
		return dl.failed(ctx.Err()), false
	}
	stdout, stderr, err := dl.fastForward(target)
	late, cancel := context.WithTimeout(context.WithoutCancel(ctx), lateTime)
	defer cancel()
	now, herr := r.head(late, r.root)
	switch {
	case herr == nil && now == target: // also when the hook that ran after it had to be ended
		return dl.applied(how, now), false
	case herr == nil && err == nil: // the person brought the result in at the same moment
		return dl.applied("already", now), false
	case err == nil:
		return dl.failed(herr), false
	}
	// Git refused. A Deliver whose time is up does not start again.
	moved = herr == nil && now != head && ctx.Err() == nil
	return dl.refused(late, stderr, stdout, head, target), moved
}

// fastForward is step 9: the one command that changes the person's folder. Git writes the files
// and the index first and HEAD last, and has no way back in between, so the command is not ended
// when the time of the Deliver is up: it gets the time it needs. Once HEAD is at target the files,
// the index and the branch are done; what may still run then is the person's post-merge hook, and
// that is ended.
func (dl *delivering) fastForward(target string) (stdout, stderr string, err error) {
	ctx, r := dl.ctx, dl.r
	own, end := context.WithCancel(context.WithoutCancel(ctx))
	defer end()
	done := make(chan struct{})
	go func() {
		defer close(done)
		stdout, stderr, err = runRaw(own, r.env, r.root, append(ffOnly[:len(ffOnly):len(ffOnly)], target)...)
	}()
	select {
	case <-done:
		return
	case <-ctx.Done():
	}
	for {
		look, cancel := context.WithTimeout(context.WithoutCancel(ctx), lateTime)
		head, herr := r.head(look, r.root)
		cancel()
		if herr == nil && head == target {
			end()
		}
		select {
		case <-done:
			return
		case <-time.After(headPoll):
		}
	}
}

// wouldApply is step 8, the end of a dry run: whether the fast-forward of the folder from head to
// target (a commit, or the tree of one that is not made) would go through. in is the Repo that
// can read target.
func (dl *delivering) wouldApply(in *Repo, head, target string) Delivery {
	files, err := dl.inTheWay(in, head, target)
	if err != nil {
		return dl.failed(err)
	}
	if len(files) > 0 {
		return dl.withFiles("local_changes", files)
	}
	return Delivery{State: "pending", Branch: dl.branch}
}

// sha is the full sha of the commit that ref names in the repository of the folder, "" when it
// names none.
func (dl *delivering) sha(ref string) (string, error) {
	if checkArg("ref", ref) != nil {
		return "", nil
	}
	out, err := dl.r.run(dl.ctx, dl.r.root, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	if err != nil && dl.ctx.Err() == nil && exitCode(err) >= 0 {
		return "", nil
	}
	return out, err
}

// busy is step 5: whether the person is in the middle of a git operation in the folder.
func (dl *delivering) busy() (bool, error) {
	r := dl.r
	args := []string{"rev-parse"}
	for _, name := range busyFiles {
		args = append(args, "--git-path", name)
	}
	out, err := r.run(dl.ctx, r.root, args...)
	if err != nil {
		return false, err
	}
	for _, path := range strings.Split(out, "\n") {
		if path != "" && exists(absIn(r.root, path)) {
			return true, nil
		}
	}
	out, err = r.run(dl.ctx, r.root, "ls-files", "--unmerged")
	return out != "", err
}

// branchAllowed is step 6: whether the branch the folder is on is one the request applies the
// result to. A branch of a run (the integration branch the result is on, above all) never is: the
// person who has it checked out is looking at the result, and the branch goes with its run.
func (dl *delivering) branchAllowed() bool {
	if strings.HasPrefix(dl.branch, ownRefs) {
		return false
	}
	if dl.branch == strings.TrimPrefix(dl.req.StartBranch, "refs/heads/") {
		return true
	}
	if dl.req.Auto {
		return false
	}
	switch named := strings.TrimPrefix(dl.req.Branch, "refs/heads/"); named {
	case "":
		return false
	case "HEAD":
		return dl.branch == ""
	default:
		return named == dl.branch
	}
}

// scratchPath is the folder of the scratch work tree, free to be made. A scratch work tree that an
// earlier Deliver left there when the server was killed is removed. Anything else that is there
// is an error, and so is a path inside the person's folder or above it. A dry run only looks:
// what the real one would remove stays.
func (dl *delivering) scratchPath() (string, error) {
	r := dl.quiet
	if dl.req.Scratch == "" {
		return "", errors.New("your own commits and the result have to be merged, and no scratch folder was given for that")
	}
	abs, err := filepath.Abs(dl.req.Scratch)
	if err != nil {
		return "", err
	}
	path := resolve(abs)
	if path == r.root || strings.HasPrefix(path, r.root+string(filepath.Separator)) ||
		strings.HasPrefix(r.root, path+string(filepath.Separator)) {
		return "", fmt.Errorf("the scratch folder %s is inside the folder or holds it", path)
	}
	list, err := r.worktrees(dl.ctx)
	if err != nil {
		return "", err
	}
	for _, w := range list {
		if resolve(w.path) != path {
			continue
		}
		if w.main || w.branch != "" { // never one of ours: the scratch work tree is detached
			return "", fmt.Errorf("%w: the scratch folder %s is a work tree in use", ErrWorktreeMismatch, path)
		}
		if dl.req.DryRun {
			return path, nil
		}
		if err := r.RemoveWorktree(dl.ctx, path); err != nil {
			return "", err
		}
	}
	if dl.req.DryRun {
		if entries, err := os.ReadDir(path); err == nil && len(entries) == 0 {
			return path, nil
		}
	} else {
		os.Remove(path) // an empty folder is no obstacle
	}
	if exists(path) {
		return "", fmt.Errorf("the scratch folder %s exists", path)
	}
	return path, nil
}

// removeScratch removes the scratch work tree, also when the time of the Deliver is up.
func (dl *delivering) removeScratch(path string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(dl.ctx), lateTime)
	defer cancel()
	dl.quiet.RemoveWorktree(ctx, path)
}

// mergeOutside makes the scratch work tree at head and merges the result into it, with a merge
// commit. It returns that commit, or the conflicting paths when the merge stopped on conflicts.
// The identity of the commit is the one git finds for the person: a repository where git finds
// none gets no fallback, and the error has git's words. The person's hooks are off for all of it
// (post-checkout, pre-merge-commit, commit-msg, post-merge, reference-transaction and the rest):
// the scratch work tree is not their checkout.
func (dl *delivering) mergeOutside(scratch, head string) (commit string, conflicts []string, err error) {
	ctx, r := dl.ctx, dl.quiet
	if err := r.EnsureWorktree(ctx, scratch, "", head); err != nil {
		return "", nil, err
	}
	// Not signed, as every commit of the package: there is no terminal for a passphrase.
	args := []string{"-c", "commit.gpgsign=false", "merge", "--no-edit", "--no-stat", "--no-autostash",
		"--no-verify-signatures", "--no-ff"}
	if dl.req.Message != "" {
		args = append(args, "-m", dl.req.Message)
	}
	_, merr := r.run(ctx, scratch, append(args, dl.result)...)
	if merr != nil {
		if ctx.Err() != nil {
			return "", nil, merr
		}
		mergeHead, err := r.run(ctx, scratch, "rev-parse", "--git-path", "MERGE_HEAD")
		if err != nil {
			return "", nil, err
		}
		if !exists(absIn(scratch, mergeHead)) {
			return "", nil, merr // git refused before it merged anything
		}
		if conflicts, err = r.unmerged(ctx, scratch); err != nil {
			return "", nil, err
		}
		if len(conflicts) > 0 {
			r.run(ctx, scratch, "merge", "--abort")
			return "", conflicts, nil
		}
		// The merge went through and the commit was not made. With a git too old to have the
		// hooks switched off from outside, a hook refused it: as everywhere in the package, a
		// hook does not get to wedge the run, and the commit is made without it.
		if _, err := r.run(ctx, scratch, "-c", "commit.gpgsign=false", "commit", "-q", "--no-edit", "--no-verify"); err != nil {
			return "", nil, fmt.Errorf("%w\nthe first try: %v", err, merr)
		}
	}
	commit, err = r.head(ctx, scratch)
	return commit, nil, err
}

// dryMerge is step 7 of a dry run when the person has commits of their own: what merging the
// result into head would give, without making the merge. git merge-tree works the merge out in
// memory and writes the tree of it, and the objects it writes go to a folder of their own that is
// removed afterwards, so the repository is left as it was to the last object.
func (dl *delivering) dryMerge(head string) Delivery {
	ctx, r := dl.ctx, dl.r
	if ok, err := r.gitAtLeast(ctx, 2, 38); err != nil {
		return dl.failed(err)
	} else if !ok || dl.d.noMergeTree {
		return Delivery{State: "pending", Branch: dl.branch}
	}
	objects, err := r.run(ctx, r.root, "rev-parse", "--git-path", "objects")
	if err != nil {
		return dl.failed(err)
	}
	tmp, err := os.MkdirTemp("", "aiwb-dry-run-")
	if err != nil {
		return dl.failed(err)
	}
	defer os.RemoveAll(tmp)
	// New objects go to tmp; the repository's own are read through the alternate.
	aside := &Repo{root: r.root, commonDir: r.commonDir, env: append(r.env[:len(r.env):len(r.env)],
		"GIT_OBJECT_DIRECTORY="+tmp, "GIT_ALTERNATE_OBJECT_DIRECTORIES="+absIn(r.root, objects))}
	// Exit 0 is a clean merge and 1 one with conflicts. The output is the tree, then the
	// conflicting paths, then an empty entry and git's messages.
	out, _, err := runRaw(ctx, aside.env, r.root, "merge-tree", "--write-tree", "--name-only", "-z", head, dl.result)
	if err != nil && (exitCode(err) != 1 || ctx.Err() != nil) {
		if exitCode(err) == 129 && ctx.Err() == nil { // not the git that was asked for its version
			return Delivery{State: "pending", Branch: dl.branch}
		}
		return dl.failed(err)
	}
	entries := strings.Split(out, "\x00")
	tree := entries[0]
	if checkArg("tree", tree) != nil {
		return dl.failed(fmt.Errorf("git merge-tree in %s: unexpected output %q", r.root, clip(out, 200)))
	}
	if err != nil {
		var conflicts []string
		for _, path := range entries[1:] {
			if path == "" {
				break
			}
			conflicts = append(conflicts, path)
		}
		return dl.withFiles("conflict", conflicts)
	}
	return dl.wouldApply(aside, head, tree)
}

// inTheWay is step 8: the paths in the folder that would make git refuse the fast-forward from
// head to target, sorted. It follows git's own rule (git read-tree, "two tree merge") for a path
// that differs between head and target: the fast-forward goes through when the index has the
// path as target has it, or has it as head has it with an unchanged file; a file that is not in
// the index must not be where the target adds one. It only reads. r is the repository of the
// folder, with what it takes to read target.
func (dl *delivering) inTheWay(r *Repo, head, target string) ([]string, error) {
	ctx := dl.ctx
	status, err := r.runZ(ctx, r.root, "diff", "--name-status", "--no-renames", "-z", head, target)
	if err != nil {
		return nil, err
	}
	changed, removed := map[string]bool{}, map[string]string{}
	var paths, added []string
	for i := 0; i+1 < len(status); i += 2 {
		path := status[i+1]
		changed[path] = true
		paths = append(paths, path)
		switch {
		case strings.HasPrefix(status[i], "A"):
			added = append(added, path)
		case strings.HasPrefix(status[i], "D"):
			removed[strings.ToLower(path)] = path
		}
	}
	set := func(args ...string) (map[string]bool, error) {
		list, err := r.runZ(ctx, r.root, append([]string{"diff", "--name-only", "--no-renames", "-z"}, args...)...)
		m := make(map[string]bool, len(list))
		for _, path := range list {
			m[path] = true
		}
		return m, err
	}
	edited, err := set() // the file is not what the index has
	if err != nil {
		return nil, err
	}
	gone, err := set("--diff-filter=D") // the file is deleted, which is in nobody's way
	if err != nil {
		return nil, err
	}
	notHead, err := set("--cached", head) // the index is not what head has
	if err != nil {
		return nil, err
	}
	notTarget, err := set("--cached", target) // the index is not what target has
	if err != nil {
		return nil, err
	}
	var files []string
	for _, path := range paths {
		if notTarget[path] && (notHead[path] || (edited[path] && !gone[path])) {
			files = append(files, path)
		}
	}
	// What is not in the index and sits where the target adds a file: untracked or ignored.
	file := func(path string) string { return filepath.Join(r.root, filepath.FromSlash(path)) }
	above := map[string]bool{} // folders of added files that were looked at
	for _, path := range added {
		if notHead[path] {
			continue // in the index: decided above
		}
		blocker := ""
		for dir := parent(path); dir != "" && !above[dir]; dir = parent(dir) {
			above[dir] = true
			if fi, err := os.Lstat(file(dir)); err == nil && !fi.IsDir() && !changed[dir] {
				blocker = dir // a file where the target needs a folder
			}
		}
		if blocker != "" {
			files = append(files, blocker)
			continue
		}
		fi, err := os.Lstat(file(path))
		if err != nil {
			continue
		}
		// On a file system that ignores case, a file that the target renames by case alone is
		// found under its new name too.
		if old, ok := removed[strings.ToLower(path)]; ok {
			if ofi, err := os.Lstat(file(old)); err == nil && os.SameFile(fi, ofi) {
				continue
			}
		}
		if fi.IsDir() { // a folder is in the way only with files in it that git does not track
			inside, err := runZ(ctx, append(r.env[:len(r.env):len(r.env)], "GIT_LITERAL_PATHSPECS=1"), r.root,
				"ls-files", "--others", "--directory", "--no-empty-directory", "-z", "--", path)
			if err != nil {
				return nil, err
			}
			if len(inside) == 0 {
				continue
			}
		}
		files = append(files, path)
	}
	sort.Strings(files)
	return files, nil
}

// parent is the folder of the slash-separated path, "" for a path at the top.
func parent(path string) string {
	if i := strings.LastIndexByte(path, '/'); i >= 0 {
		return path[:i]
	}
	return ""
}

// runZ is Repo.runZ with an environment of its own.
func runZ(ctx context.Context, env []string, dir string, args ...string) ([]string, error) {
	r := &Repo{env: env}
	return r.runZ(ctx, dir, args...)
}

// refused maps what git said, on stderr and stdout, when it refused the fast-forward from head to
// target. ctx has the time to look at the folder.
func (dl *delivering) refused(ctx context.Context, stderr, stdout, head, target string) Delivery {
	text := stderr + "\n" + stdout
	switch {
	case strings.Contains(text, "would be overwritten by merge"), strings.Contains(text, "would lose untracked files"):
		// Git lists the paths on lines of their own, each after a tab, as they are.
		var files []string
		for _, line := range strings.Split(text, "\n") {
			if path, ok := strings.CutPrefix(strings.TrimSuffix(line, "\r"), "\t"); ok && path != "" {
				files = append(files, path)
			}
		}
		if len(files) == 0 {
			files, _ = dl.inTheWay(dl.r, head, target)
		}
		return dl.withFiles("local_changes", files)
	case strings.Contains(text, "index.lock"), strings.Contains(text, "unmerged files"),
		strings.Contains(text, "You have not concluded"):
		return dl.blocked("busy")
	}
	// The lock of the branch, of HEAD or of ORIG_HEAD: a git command of the person is at work, or
	// one that was killed left it.
	locked := strings.Contains(text, "cannot lock ref")
	if dl.halfDone(ctx, head, target) {
		d := dl.gitSaid(text)
		if locked {
			d.Reason = "busy"
		}
		d.Detail = "the result's files are in the folder, staged, but the branch could not be moved: " +
			clip(firstWords(stderr), maxErrText) + "; remove the cause and apply again"
		return d
	}
	if locked {
		return dl.blocked("busy")
	}
	return dl.gitSaid(text)
}

// halfDone reports whether the folder is where a fast-forward from head to target leaves it when
// git wrote the files and the index and then could not move the branch: HEAD is still head, and
// the index has every path that differs between the two as target has it.
func (dl *delivering) halfDone(ctx context.Context, head, target string) bool {
	r := dl.r
	if now, err := r.head(ctx, r.root); err != nil || now != head {
		return false
	}
	changed, err := r.runZ(ctx, r.root, "diff", "--name-only", "--no-renames", "-z", head, target)
	if err != nil || len(changed) == 0 {
		return false
	}
	other, err := r.runZ(ctx, r.root, "diff", "--cached", "--name-only", "--no-renames", "-z", target)
	if err != nil {
		return false
	}
	notTarget := make(map[string]bool, len(other))
	for _, path := range other {
		notTarget[path] = true
	}
	for _, path := range changed {
		if notTarget[path] {
			return false
		}
	}
	return true
}

// firstWords is what git said first: its lines up to the first empty one (the advice that follows
// a lock error comes after it), on one line.
func firstWords(stderr string) string {
	var lines []string
	for _, line := range strings.Split(strings.TrimSpace(stderr), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			break
		}
		if !strings.HasPrefix(line, "hint:") {
			lines = append(lines, strings.TrimSuffix(line, "."))
		}
	}
	return strings.Join(lines, "; ")
}

func (dl *delivering) blocked(reason string) Delivery {
	return Delivery{State: "blocked", Reason: reason, Branch: dl.branch}
}

func (dl *delivering) applied(how, commit string) Delivery {
	return Delivery{State: "applied", How: how, Commit: commit, Branch: dl.branch}
}

// withFiles is blocked with the paths that are the reason: sorted, each once, at most
// maxDeliveryFiles of them.
func (dl *delivering) withFiles(reason string, files []string) Delivery {
	d := dl.blocked(reason)
	files = append([]string(nil), files...)
	sort.Strings(files)
	for i, f := range files {
		if i > 0 && f == files[i-1] {
			continue
		}
		if len(d.Files) < maxDeliveryFiles {
			d.Files = append(d.Files, f)
		} else {
			d.More++
		}
	}
	return d
}

// gitSaid is blocked for a reason that has no name: Detail has git's words, without its hints.
func (dl *delivering) gitSaid(text string) Delivery {
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		if line = strings.TrimRight(line, " \t\r"); line != "" && !strings.HasPrefix(line, "hint:") {
			lines = append(lines, line)
		}
	}
	d := dl.blocked("git")
	d.Detail = clip(strings.Join(lines, "\n"), maxErrText)
	return d
}

// failed is the outcome when something went wrong that has no name of its own. When it went wrong
// because the time was up or the caller gave up, step 4 decides, with time of its own: a
// fast-forward that git had done by then counts, on a branch the request allows.
func (dl *delivering) failed(err error) Delivery {
	if dl.ctx.Err() == nil {
		var ge *Error
		if errors.As(err, &ge) && ge.Output != "" {
			return dl.gitSaid(ge.Output)
		}
		return dl.gitSaid(err.Error())
	}
	if r := dl.r; r != nil && dl.result != "" {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(dl.ctx), lateTime)
		defer cancel()
		if head, err := r.head(ctx, r.root); err == nil {
			if done, _ := r.IsAncestor(ctx, dl.result, head); done {
				if branch, err := r.branch(ctx, r.root); err == nil {
					if dl.branch = branch; dl.branchAllowed() {
						if head == dl.target {
							return dl.applied(dl.how, head)
						}
						return dl.applied("already", head)
					}
				}
			}
		}
	}
	if errors.Is(dl.ctx.Err(), context.DeadlineExceeded) {
		return dl.gitSaid(fmt.Sprintf("applying the result did not finish within %s", dl.d.timeout))
	}
	return dl.gitSaid("applying the result was interrupted: " + dl.ctx.Err().Error())
}
