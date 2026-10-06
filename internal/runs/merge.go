package runs

import (
	"errors"
	"fmt"
	"log"
	"slices"
	"sort"
	"strings"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/rungit"
)

// This file merges a writing task's commit into the run's integration branch.
//
// Merges into the integration checkout happen one at a time, under run.mergeMu. A conflict is
// resolved on the task's side: the integration branch is merged into the task's checkout, a
// merge agent resolves the conflicts there, the engine checks and concludes that merge, and the
// task's branch then merges cleanly. The lock is never held while a merge agent works, so other
// tasks start, merge and end meanwhile; when the integration branch moved under a resolution and
// conflicts again, that is the next round, with a merge agent of its own, at most three.
//
// The attempt records where the flow is, and is read again after every entry:
//
//	MergeRound      rounds opened
//	MergeAgentDone  rounds whose agent answered "completed"
//	Conflicts       every file that conflicted in any round
//
// A round is opened before the integration branch is merged into the task's checkout, so a merge
// in progress there always belongs to a recorded round: to the open one (MergeRound >
// MergeAgentDone: its agent has not answered) or to one whose agent is done and whose conclusion
// is pending (MergeRound == MergeAgentDone >= 1). A restart enters the flow at its top and goes
// to the agent or to the check, never to a commit of half-resolved files.

// mergeTask merges the task's branch into the integration branch and records it. errEngStop when
// the worker was stopped; any other error fails the task.
func (e *engine) mergeTask(tid string, w *engWorker) error {
	r, repo, ctx := e.r, e.repo, w.ctx
	g := r.engGit()
	ib, intDir := engIntBranch(r.id, g), r.engIntDir(g)
	t, a, err := r.engAttempt(tid)
	if err != nil {
		return err
	}
	wt, branch, title := a.Worktree, a.Branch, engOneLine(t.Title)
	intoInt := fmt.Sprintf("Merge %s: %s", tid, title)
	intoTask := fmt.Sprintf("Merge %s into %s", ib, tid)

	locked := false
	lock := func() { r.mergeMu.Lock(); locked = true }
	unlock := func() {
		if locked {
			r.mergeMu.Unlock()
			locked = false
		}
	}
	defer unlock()
	// gitErr is a git command's error as the flow returns it: a stop when the worker's context
	// ended the command, else a failure of the task.
	gitErr := func(err error) error {
		if ctx.Err() != nil {
			return errEngStop
		}
		return fmt.Errorf("merging %s into %s failed:\n%v", tid, ib, err)
	}
	mergeFailed := func(res rungit.MergeResult, err error) error {
		if ctx.Err() != nil {
			return errEngStop
		}
		out := strings.TrimSpace(res.Output)
		if out == "" {
			out = err.Error()
		}
		return fmt.Errorf("merging %s into %s failed:\n%s", tid, ib, out)
	}
	step := func(build func(a *Attempt, tx *Tx)) error {
		_, err := r.commit(KTaskStep, func(tx *Tx) error {
			t := tx.Task(tid)
			a := &t.Attempts[len(t.Attempts)-1]
			build(a, tx)
			tx.Head(Entry{Task: tid, Attempt: a.N})
			return nil
		})
		if err != nil {
			return err
		}
		_, a, err = r.engAttempt(tid)
		return err
	}
	// named puts this round's merge agent into the attempt, with its record.
	named := func(a *Attempt, tx *Tx, files []string) {
		name := engMergeAgentName(tid, a.N, a.MergeRound)
		id := AgentChatID(r.id, name)
		a.Conflicts = engUnion(a.Conflicts, files)
		a.Agents.Merge = id
		if tx.Agent(id) == nil {
			mc := r.meta.Tiers.Of(model.MergeTier)
			tx.AddAgent(Agent{RunAgent: model.RunAgent{ID: id, Name: name, Role: model.RoleMerge, Task: tid, Attempt: a.N,
				Status: model.AgentRunning, StartedAt: tx.Now(), Tier: model.MergeTier, Model: mc.Model, Effort: mc.Effort}})
		}
	}

	var gitSaid []string
	merged := ""
	lock()
	for merged == "" {
		if ctx.Err() != nil {
			return errEngStop
		}
		if _, a, err = r.engAttempt(tid); err != nil {
			return err
		}
		// A merge a dead process left in the integration checkout is undone.
		if m, err := repo.Merging(ctx, intDir); err != nil {
			return gitErr(err)
		} else if m {
			if err := repo.AbortMerge(ctx, intDir); err != nil {
				return gitErr(err)
			}
		}
		if br, err := repo.Branch(ctx, wt); err != nil {
			return gitErr(err)
		} else if br != branch {
			return engBranchError(br, branch)
		}
		// Merged already, and not recorded yet.
		if anc, err := repo.IsAncestor(ctx, branch, ib); err != nil {
			return gitErr(err)
		} else if anc {
			if merged, err = repo.Resolve(ctx, ib); err != nil {
				return gitErr(err)
			}
			break
		}
		resolving, err := repo.Merging(ctx, wt)
		if err != nil {
			return gitErr(err)
		}
		switch {
		case !resolving:
			res, err := repo.Merge(ctx, intDir, branch, intoInt, true)
			if err != nil {
				return mergeFailed(res, err) // the integration checkout is as it was
			}
			if res.Merged {
				merged = res.Head
				continue
			}
			// A conflict: it is resolved on the task's side.
			if err := repo.AbortMerge(ctx, intDir); err != nil {
				return gitErr(err)
			}
			if a.MergeRound == a.MergeAgentDone { // no round is open: open one before the back-merge
				if a.MergeRound >= engMergeRounds {
					return fmt.Errorf("merging %s kept conflicting with new work on %s (%d rounds)", tid, ib, engMergeRounds)
				}
				if err := step(func(a *Attempt, tx *Tx) { a.MergeRound++ }); err != nil {
					return err
				}
			}
			res2, err := repo.Merge(ctx, wt, ib, intoTask, false)
			if err != nil {
				return mergeFailed(res2, err)
			}
			if res2.Merged {
				// Nothing to resolve after all. The round is used up, so this cannot go on for ever.
				if err := step(func(a *Attempt, tx *Tx) { a.MergeAgentDone = a.MergeRound }); err != nil {
					return err
				}
				continue
			}
			gitSaid = engConflictLines(res2.Output)
			if err := step(func(a *Attempt, tx *Tx) { named(a, tx, res2.Conflicts) }); err != nil {
				return err
			}
		case a.MergeRound == 0:
			// A merge the run did not start (the work agent's commit came before any round).
			if err := repo.AbortMerge(ctx, wt); err != nil {
				return gitErr(err)
			}
			continue
		}

		if a.MergeAgentDone < a.MergeRound { // this round's agent has not answered
			round := a.MergeRound
			name := engMergeAgentName(tid, a.N, round)
			files, err := repo.Unmerged(ctx, wt)
			if err != nil {
				return gitErr(err)
			}
			if len(files) == 0 {
				files = a.Conflicts
			}
			if a.Agents.Merge != AgentChatID(r.id, name) {
				// The server died between the back-merge and the entry that names the agent.
				if err := step(func(a *Attempt, tx *Tx) { named(a, tx, files) }); err != nil {
					return err
				}
			}
			unlock() // no lock while the agent works
			said := gitSaid
			res, err := e.runAgent(agentJob{name: name, role: model.RoleMerge, cwd: wt, wantBlock: true, git: true, w: w,
				first: func() (string, error) { return e.mergePrompt(tid, files, said) }})
			if err != nil {
				return err
			}
			if res.Block.Outcome == "failed" {
				if _, err := r.commit(KAgent, func(tx *Tx) error { res.Done(tx); return nil }); err != nil {
					return err
				}
				e.checkCost()
				return fmt.Errorf("the merge agent could not resolve the conflict: %s", res.Block.Summary)
			}
			if err := step(func(a *Attempt, tx *Tx) { a.MergeAgentDone = round; res.Done(tx) }); err != nil {
				return err
			}
			e.checkCost()
			lock()
			if ctx.Err() != nil {
				return errEngStop
			}
			if m, err := repo.Merging(ctx, wt); err != nil {
				return gitErr(err)
			} else if !m {
				return errors.New("the merge agent ended the merge itself (git commit or git merge --abort) instead of leaving it to the run")
			}
		}
		// The check and the conclusion. The lock is kept into the next pass: if the integration
		// branch did not move, the task's branch now merges cleanly; if it moved and conflicts,
		// that is the next round.
		_, err = repo.ConcludeMerge(ctx, wt, intoTask, a.Conflicts)
		var ue *rungit.UnresolvedError
		if errors.As(err, &ue) {
			if err := repo.AbortMerge(ctx, wt); err != nil {
				log.Printf("runs: abort the merge in the checkout of %s of %s: %v", tid, r.id, err)
			}
			return fmt.Errorf("the conflict is not resolved: %s", strings.Join(ue.Problems, "; "))
		}
		if err != nil {
			return gitErr(err)
		}
	}
	unlock()

	// The changes file keeps the file list written when the head was recorded.
	changes, err := readChanges(r.dir, tid, a.N)
	if err != nil {
		if changes, err = e.changes(ctx, tid, a, a.Head); err != nil {
			return gitErr(err)
		}
	}
	return step(func(a *Attempt, tx *Tx) {
		a.Merged, a.MergedAt = merged, tx.Now()
		changes.Merged, changes.MergedAt, changes.Conflicts = merged, tx.Now(), a.Conflicts
		tx.File(changesRel(tid, a.N), changesData(changes))
	})
}

// engUnion is the sorted union of two lists of paths.
func engUnion(a, b []string) []string {
	out := slices.Clone(a)
	for _, p := range b {
		if !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

// engConflictLines are git's CONFLICT lines of a merge's output: one per path, saying what kind
// of conflict it is.
func engConflictLines(output string) []string {
	var out []string
	for _, line := range strings.Split(output, "\n") {
		if line = strings.TrimSpace(line); strings.HasPrefix(line, "CONFLICT") {
			out = append(out, line)
		}
	}
	return out
}

// mergePrompt builds the first message of a round's merge agent from the run as it is now.
func (e *engine) mergePrompt(tid string, files, gitSaid []string) (string, error) {
	r := e.r
	r.mu.Lock()
	l := r.L.snapshot()
	r.mu.Unlock()
	p := engMergePrompt{ID: tid, Files: files, GitSaid: gitSaid}
	var started int64
	for i := range l.Tasks {
		if t := &l.Tasks[i]; t.ID == tid && len(t.Attempts) > 0 {
			p.Title = t.Title
			started = t.Attempts[len(t.Attempts)-1].StartedAt
			brief, err := readBrief(r.dir, tid, t.BriefRev)
			if err != nil {
				log.Printf("runs: the brief of %s of %s: %v", tid, r.id, err)
				return "", fmt.Errorf("the brief of %s could not be read", tid)
			}
			p.Brief = brief
			p.Report, _ = r.readable(ctxReport, tid, t.Attempts[len(t.Attempts)-1].N)
		}
	}
	type done struct {
		at int64
		m  engMergedTask
	}
	var others []done
	for i := range l.Tasks {
		t := &l.Tasks[i]
		if t.ID == tid {
			continue
		}
		for _, a := range t.Attempts {
			if a.Merged == "" || a.MergedAt < started {
				continue
			}
			m := engMergedTask{ID: t.ID, Title: t.Title}
			if a.Result != nil {
				m.Summary = a.Result.Summary
			}
			m.BriefPath, _ = r.readable(ctxBrief, t.ID, 0)
			m.ReportPath, _ = r.readable(ctxReport, t.ID, a.N)
			others = append(others, done{a.MergedAt, m})
		}
	}
	sort.SliceStable(others, func(i, j int) bool { return others[i].at < others[j].at })
	for _, o := range others {
		p.Merged = append(p.Merged, o.m)
	}
	return engMergePromptText(p), nil
}
