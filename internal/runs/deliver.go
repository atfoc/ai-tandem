package runs

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/rungit"
)

// This file is how the result of a run with git reaches the folder the person works in. The
// agents work in checkouts outside that folder and the result ends on the run's integration
// branch; rungit.Deliver brings it into the folder with a fast-forward that git either does
// completely or refuses. What is here is around that call: when it is made, what its outcome is
// called on the record, and which of the run's branches go afterwards.
//
//   - The run's end (engFinish) applies the result by itself when the run ends completed, its
//     setting applyResult is not "manual" and it uses git. Deliver then also wants the folder on
//     the branch the run started on. The outcome is part of the run_finished entry.
//   - A person applies it (Service.Apply) when the run has ended or is halted: completed, gave_up,
//     stopped, stalled, error. Never while the run is live: its result is still moving. Each such
//     attempt is one run_delivery entry.
//   - Service.Delivery says what an Apply would do now, and records nothing.
//
// The states and reasons are those of model.RunDelivery. rungit gives applied, blocked, none with
// no_changes and pending with other_branch or history_changed (the folder's history no longer has
// the commit the run started from: nothing is applied by itself then, a person's Apply applies);
// both are passed on as they are. The reasons added here are no_git (none), and for
// pending manual (the run completed and the result waits for the person: the setting, or an
// automatic attempt that was blocked and would work now), not_achieved (the run gave up) and
// halted (the run is stopped, stalled or in error: what is merged so far can be applied).

// delivWait is how long the service gives one delivery; rungit.Deliver has the same limit of its
// own.
const delivWait = 2 * time.Minute

// delivAutomatic reports whether the end of a run with git applies the result by itself.
func delivAutomatic(status model.RunStatus, set model.RunSettings) bool {
	return status == model.RunCompleted && set.ApplyResult != "manual"
}

// delivWaits is why a result that could be applied waits for the person.
func delivWaits(status model.RunStatus) string {
	switch status {
	case model.RunCompleted:
		return "manual"
	case model.RunGaveUp:
		return "not_achieved"
	}
	return "halted"
}

// delivOf is the outcome of rungit.Deliver as the record and the clients have it. result is the
// commit that was to be applied, status the run's status then, auto whether the run's end made
// the attempt, at when it was made (0 for a dry run, which is no attempt).
func delivOf(d rungit.Delivery, result string, status model.RunStatus, auto bool, at int64) model.RunDelivery {
	out := model.RunDelivery{State: model.RunDeliveryState(d.State), Reason: d.Reason, Auto: auto, At: at, Result: result,
		Commit: d.Commit, How: d.How, Branch: d.Branch, Files: d.Files, More: d.More, Detail: d.Detail}
	switch out.State {
	case model.DeliveryNone:
		out.Result = ""
	case model.DeliveryPending:
		if out.Reason == "" {
			out.Reason = delivWaits(status)
		}
		out.Partial = status != model.RunCompleted
	default:
		out.Partial = status != model.RunCompleted
	}
	return out
}

// delivReq is the request for the result commit of the run. The folder is the top of the person's
// work tree, so a sub-folder that is gone does not hide the repository.
func (r *run) delivReq(g *Git, name, result string) rungit.DeliverReq {
	return rungit.DeliverReq{Folder: g.Repo, Base: g.BaseRef, Result: result, StartBranch: g.Branch,
		Scratch: filepath.Join(r.svc.Store.P.RunWorkDir(r.id), "apply"), Message: fmt.Sprintf("Merge run %q (%s)", name, r.id)}
}

// delivRun calls rungit.Deliver with the service's git environment. The scratch work tree is gone
// when it returns; the folders git made above it go too when nothing else is in them. A scratch
// folder that an earlier delivery left when it was killed, and that git does not have as a work
// tree, is removed first: rungit.Deliver refuses a folder it did not make. A dry run removes
// nothing.
func (r *run) delivRun(ctx context.Context, req rungit.DeliverReq) rungit.Delivery {
	if req.Scratch != "" && !req.DryRun {
		r.delivClearScratch(ctx, req)
	}
	d := rungit.Deliver(ctx, req, rungit.WithEnv(r.svc.GitEnv...))
	if req.Scratch != "" {
		// Both fail when the folder is not empty, which is what is wanted.
		if os.Remove(filepath.Dir(req.Scratch)) == nil {
			os.Remove(r.svc.Store.P.RunWork)
		}
	}
	return d
}

// delivClearScratch removes the scratch folder of the request when it is there and is no work tree
// of the repository: only that path, which is the run's own and which nothing but a delivery
// writes. A folder git has as a work tree is left to rungit.Deliver, as is everything when git
// cannot be asked.
func (r *run) delivClearScratch(ctx context.Context, req rungit.DeliverReq) {
	if req.Scratch != filepath.Join(r.svc.Store.P.RunWorkDir(r.id), "apply") {
		return
	}
	if _, err := os.Lstat(req.Scratch); err != nil {
		return
	}
	cmd := exec.CommandContext(ctx, "git", "-C", req.Folder, "worktree", "list", "--porcelain")
	cmd.Env = append(os.Environ(), r.svc.GitEnv...)
	out, err := cmd.Output()
	if err != nil {
		return
	}
	real := func(p string) string {
		if q, err := filepath.EvalSymlinks(p); err == nil {
			return q
		}
		return filepath.Clean(p)
	}
	want := real(req.Scratch)
	for _, line := range strings.Split(string(out), "\n") {
		if path, ok := strings.CutPrefix(strings.TrimRight(line, "\r"), "worktree "); ok && real(path) == want {
			return
		}
	}
	if err := os.RemoveAll(req.Scratch); err != nil {
		log.Printf("runs: remove the left-over scratch folder %s: %v", req.Scratch, err)
	}
}

// delivAtEnd is the delivery that the end of the run records: status is the status the run ends
// with, head the head of its integration branch ("" when it could not be read: rungit.Deliver
// then says what is wrong with the folder). It applies the result when that is automatic.
// Otherwise it only looks: a result that is in the folder already (a person applied it while the
// run was stopped and nothing was merged since) is applied, one that changed nothing is none, a
// folder or a result that is gone is blocked, and everything else waits for the person (with the
// reason history_changed when the folder's history no longer has the run's start commit). A server
// that stopped between the fast-forward and the run_finished entry comes here again at its next
// start, and rungit.Deliver finds the result in the folder: applied, how "already".
func (r *run) delivAtEnd(ctx context.Context, g *Git, meta model.RunMeta, status model.RunStatus, head string) model.RunDelivery {
	if g == nil {
		return model.RunDelivery{State: model.DeliveryNone, Reason: "no_git"}
	}
	now := r.svc.nowMs()
	req := r.delivReq(g, meta.Name, head)
	if delivAutomatic(status, meta.Settings) {
		req.Auto = true
		return delivOf(r.delivRun(ctx, req), head, status, true, now)
	}
	// Without a scratch folder a dry run makes no checkout: it ends at the latest where a merge
	// commit would have to be built.
	req.DryRun, req.Scratch = true, ""
	d := r.delivRun(ctx, req)
	switch {
	case d.State == "applied", d.State == "none",
		d.State == "blocked" && (d.Reason == "folder_missing" || d.Reason == "not_repo" || d.Reason == "result_missing"):
		return delivOf(d, head, status, false, now)
	}
	reason := delivWaits(status)
	if d.State == "pending" && d.Reason == "history_changed" {
		reason = d.Reason
	}
	return model.RunDelivery{State: model.DeliveryPending, Reason: reason, Result: head, Partial: status != model.RunCompleted}
}

// delivResult is the commit a person's Apply applies: the result's head of a run that has ended,
// the integration branch's head of one that is halted (the base when no engine ever made the
// branch). "" when the repository or the branch cannot be read: rungit.Deliver then says what is
// wrong with the folder.
func (r *run) delivResult(ctx context.Context, st State) (result string, repo *rungit.Repo) {
	g := st.Git
	repo, err := r.svc.eng.openRepo(ctx, g.Repo)
	if err != nil {
		repo = nil
	}
	if st.Status.Final() && g.ResultHead != "" {
		return g.ResultHead, repo
	}
	if repo == nil {
		return "", nil
	}
	head, err := repo.Resolve(ctx, engIntBranch(r.id, g))
	switch {
	case err == nil:
		return head, repo
	case errors.Is(err, rungit.ErrUnknownRef):
		return g.BaseRef, repo
	}
	log.Printf("runs: the result's head of %s: %v", r.id, err)
	return "", repo
}

// delivByHand is Service.Apply and, with dry, Service.Delivery, for a run that is not live. The
// caller holds the run's op lock, so the run is not resumed meanwhile. An attempt is recorded as
// one run_delivery entry; when the result it found in the folder is the one the record says was
// applied, the record is the answer and nothing is written.
func (r *run) delivByHand(branch string, dry bool) (model.RunDelivery, error) {
	if err := r.load(); err != nil {
		return model.RunDelivery{}, err
	}
	r.mu.Lock()
	st, meta := cloneState(r.L.State), r.meta
	r.mu.Unlock()
	if st.Status.Live() {
		return model.RunDelivery{}, ErrLive
	}
	if st.Git == nil {
		return model.RunDelivery{State: model.DeliveryNone, Reason: "no_git"}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), delivWait)
	defer cancel()
	result, repo := r.delivResult(ctx, st)
	req := r.delivReq(st.Git, meta.Name, result)
	req.Branch, req.DryRun = branch, dry
	at := int64(0)
	if !dry {
		at = r.svc.nowMs()
	}
	d := delivOf(r.delivRun(ctx, req), result, st.Status, false, at)
	if was := st.Delivery; was != nil && was.State == model.DeliveryApplied && d.State == model.DeliveryApplied && d.How == "already" && was.Result == result {
		d = *cloneDelivery(was)
	} else if !dry {
		_, err := r.commit(KRunDelivery, func(tx *Tx) error {
			if tx.State().Status.Live() {
				return ErrLive
			}
			tx.State().Delivery = cloneDelivery(&d)
			return nil
		})
		if err != nil {
			return model.RunDelivery{}, err
		}
		if err := r.checkpoint(); err != nil {
			log.Printf("runs: checkpoint of %s: %v", r.id, err)
		}
	}
	if !dry && st.Status.Final() && repo != nil && !meta.Settings.KeepWorktrees {
		r.delivTidy(ctx, repo, st.Git, d)
	}
	return d, nil
}

// delivElsewhere reports whether the commit result is on a local branch that is not a run's: it
// is asked of git now, and not of the record, which only says where the folder was when the result
// was applied. branch is the branch to look at first (the one a delivery names; "" for none).
// A branch under aiwb/ does not count: it is deleted with its run. When git cannot say, the
// answer is no.
func (r *run) delivElsewhere(ctx context.Context, repo *rungit.Repo, g *Git, result, branch string) bool {
	if result == "" {
		return false
	}
	mine := func(name string) bool {
		return name != "" && !strings.HasPrefix(name, "aiwb/") && name != engIntBranch(r.id, g)
	}
	has := func(name string) bool {
		in, err := repo.IsAncestor(ctx, result, "refs/heads/"+name)
		return err == nil && in
	}
	if mine(branch) && has(branch) {
		return true
	}
	names, err := repo.Branches(ctx, "")
	if err != nil {
		log.Printf("runs: the branches of %s: %v", g.Repo, err)
		return false
	}
	for _, name := range names {
		if name != branch && mine(name) && has(name) {
			return true
		}
	}
	return false
}

// delivTidy deletes the branches of a run that has ended and whose result is in the person's
// folder: the integration branch and every other branch of the run that is an ancestor of the
// result, so every commit they name is on the person's branch. The branch of an attempt that was
// not merged stays until the run is deleted. The integration branch goes only when the result is
// on a branch of the person's own (delivElsewhere): with a detached HEAD, or when that branch is
// gone or was moved back since, it is the only name the result has, and it stays. A branch that
// is still checked out (a checkout that could not be removed) is left, and goes with the run.
func (r *run) delivTidy(ctx context.Context, repo *rungit.Repo, g *Git, d model.RunDelivery) {
	if d.State != model.DeliveryApplied || d.Result == "" {
		return
	}
	names, err := repo.MergedBranches(ctx, engTaskBranch(r.id, ""), d.Result)
	if err != nil {
		log.Printf("runs: the branches of %s: %v", r.id, err)
		return
	}
	elsewhere := d.Branch != "" && r.delivElsewhere(ctx, repo, g, d.Result, d.Branch)
	var gone []string
	for _, name := range names {
		if name == engIntBranch(r.id, g) && !elsewhere {
			continue
		}
		gone = append(gone, name)
	}
	if err := repo.DeleteBranches(ctx, gone...); err != nil {
		log.Printf("runs: delete the branches of %s: %v", r.id, err)
	}
}

// delivDropBranches deletes the branches of a run that is being deleted, after its checkouts are
// gone: all of them, except the integration branch when it holds a result that is on no branch of
// the person's own (delivElsewhere, asked of git now: that a delivery was recorded as applied does
// not say that the branch it was applied to still has the result). That branch is then all that
// is left of the run's work, and it stays in the repository for the person.
func (r *run) delivDropBranches(ctx context.Context, repo *rungit.Repo, g *Git) error {
	names, err := repo.Branches(ctx, engTaskBranch(r.id, ""))
	if err != nil {
		return err
	}
	r.mu.Lock()
	var was *model.RunDelivery
	if r.L != nil {
		was = cloneDelivery(r.L.State.Delivery)
	}
	r.mu.Unlock()
	first := ""
	if was != nil && was.State == model.DeliveryApplied {
		first = was.Branch
	}
	var gone []string
	for _, name := range names {
		if name == engIntBranch(r.id, g) {
			head, err := repo.Resolve(ctx, "refs/heads/"+name)
			if err != nil || (head != g.BaseRef && !r.delivElsewhere(ctx, repo, g, head, first)) {
				continue
			}
		}
		gone = append(gone, name)
	}
	return repo.DeleteBranches(ctx, gone...)
}
