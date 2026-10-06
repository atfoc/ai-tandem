package runs

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/rungit"
)

// This file is one attempt of a task, from its slot to its end. Every step records a flag in
// the same entry that records its effect, and is skipped when the attempt is entered again
// after a halt or a restart:
//
//	slot taken     task_started: StartedAt, phase setup, Base, Branch, Worktree   (the scheduler)
//	checkout       EnsureWorktree, idempotent
//	setup command  task_step: SetupDone, phase work, the work agent's record
//	work agent     agent entries; task_step: Result, WorkDone, the report file, the agent done,
//	               and for a writing task of a git run phase merge unless a cancel was asked
//	commit         task_step: Head, the changes file
//	merge          task_step: MergeRound, Conflicts, MergeAgentDone, Merged (merge.go)
//	end            task_ended: Outcome, the event
//
// In a run without git there is no checkout, no setup command, no commit and no merge.

// taskWorker is the goroutine of one active task.
func (e *engine) taskWorker(tid string, w *engWorker) {
	r := e.r
	defer func() {
		r.mu.Lock()
		if e.workers[tid] == w {
			delete(e.workers, tid)
		}
		r.mu.Unlock()
		w.cancel()
		close(w.done)
		e.wg.Done()
		r.engPoke()
	}()
	defer func() {
		if v := recover(); v != nil {
			e.crashed(v)
		}
	}()

	err := e.attemptSteps(tid, w)
	if err == nil {
		return
	}
	// Whatever a step returned, a stop or a cancel that was asked decides: an error of a command
	// the stop ended is not a failure.
	if ierr := e.interrupted(w); ierr != nil {
		err = ierr
	}
	if errors.Is(err, errEngStop) {
		return // the task stays as it is; the next start goes on with it
	}
	e.endAttempt(tid, w, err)
}

// attemptSteps takes the task's attempt from where it is recorded to be to its end as done. An
// error ends it: errEngStop leaves the task as it is, errEngCancel ends it cancelled, any other error
// fails it with the error as the reason.
func (e *engine) attemptSteps(tid string, w *engWorker) error {
	r := e.r
	t, a, err := r.engAttempt(tid)
	if err != nil {
		return err
	}
	if a.Outcome != "" {
		return nil
	}
	g, meta := r.engGit(), r.engMeta()
	git := g != nil
	wt := a.Worktree

	// The checkout: a writing task's own branch at Base, a reporting task detached at Base.
	if git {
		if e.repo == nil {
			return errEngStop // the engine could not open the repository and is halting
		}
		if err := e.repo.EnsureWorktree(w.ctx, wt, a.Branch, a.Base); err != nil {
			return fmt.Errorf("its checkout could not be made: %v", err)
		}
	}
	if err := e.interrupted(w); err != nil {
		return err
	}

	if !a.SetupDone {
		if git {
			if err := e.setup(w, t, a, meta.Settings.Setup); err != nil {
				return err
			}
		}
		if err := e.interrupted(w); err != nil {
			return err
		}
		name := WorkAgentName(tid, a.N)
		id := AgentChatID(r.id, name)
		if _, err := r.commit(KTaskStep, func(tx *Tx) error {
			t := tx.Task(tid)
			a := &t.Attempts[len(t.Attempts)-1]
			if a.Outcome != "" || a.SetupDone {
				tx.Skip()
				return nil
			}
			a.SetupDone = true
			a.Phases = append(a.Phases, model.RunPhase{K: model.TaskWork, T: tx.Now()})
			a.Agents.Work = id
			if tx.Agent(id) == nil {
				// The attempt's tier, else the task's, else standard.
				tier := tierOr(a.Tier)
				if a.Tier == "" {
					tier = tierOr(t.Tier)
				}
				mc := r.meta.Tiers.Of(tier)
				tx.AddAgent(Agent{RunAgent: model.RunAgent{ID: id, Name: name, Role: model.RoleTask, Task: tid, Attempt: a.N,
					Status: model.AgentRunning, StartedAt: tx.Now(), Tier: tier, Model: mc.Model, Effort: mc.Effort}})
			}
			tx.Head(Entry{Task: tid, Attempt: a.N})
			return nil
		}); err != nil {
			return err
		}
	}

	if t, a, err = r.engAttempt(tid); err != nil {
		return err
	}
	if !a.WorkDone {
		// The prompt names the run's folder below the checkout's top only when the agent starts there.
		cwd, sub := e.taskCwd(g, wt, meta), ""
		if g != nil && cwd != wt {
			sub = g.Sub
		}
		res, err := e.runAgent(agentJob{name: WorkAgentName(tid, a.N), role: model.RoleTask, cwd: cwd,
			first: func() (string, error) { return e.taskPrompt(tid, sub) }, wantBlock: true, git: git, w: w})
		if err != nil {
			return err
		}
		b := res.Block
		if _, err := r.commit(KTaskStep, func(tx *Tx) error {
			t := tx.Task(tid)
			a := &t.Attempts[len(t.Attempts)-1]
			tx.File(reportRel(tid, a.N), []byte(b.Report))
			a.Result = &model.AttemptResult{Outcome: b.Outcome, Summary: b.Summary, ReportSize: utf8.RuneCountInString(b.Report)}
			a.WorkDone = true
			res.Done(tx)
			// The cancel boundary: a task whose cancel was asked does not start to merge.
			if git && t.Writes && b.Outcome == "completed" && w.cancelReq == nil {
				a.Phases = append(a.Phases, model.RunPhase{K: model.TaskMerge, T: tx.Now()})
			}
			tx.Head(Entry{Task: tid, Attempt: a.N})
			return nil
		}); err != nil {
			return err
		}
		e.checkCost()
		if t, a, err = r.engAttempt(tid); err != nil {
			return err
		}
	}
	if a.Result == nil {
		return fmt.Errorf("internal error: %s has no result", tid)
	}
	if a.Result.Outcome == "failed" {
		return fmt.Errorf("its agent reported that it could not do the task: %s", a.Result.Summary)
	}

	if git && t.Writes {
		if t.State() != model.TaskMerge {
			// The result was recorded while a cancel was asked, and then the cancel was lost (a
			// restart): the boundary is crossed here.
			if _, err := r.commit(KTaskStep, func(tx *Tx) error {
				if w.cancelReq != nil {
					return errEngCancel
				}
				t := tx.Task(tid)
				a := &t.Attempts[len(t.Attempts)-1]
				a.Phases = append(a.Phases, model.RunPhase{K: model.TaskMerge, T: tx.Now()})
				tx.Head(Entry{Task: tid, Attempt: a.N})
				return nil
			}); err != nil {
				return err
			}
		}
		if a.Head == "" {
			if err := e.commitWork(w, t, a); err != nil {
				return err
			}
			if t, a, err = r.engAttempt(tid); err != nil {
				return err
			}
		}
		if a.Head != a.Base && a.Merged == "" {
			if err := e.mergeTask(tid, w); err != nil {
				return err
			}
		}
	}
	if git && !meta.Settings.KeepWorktrees {
		// A checkout that cannot be removed is left: the task's work is in, and the folder goes
		// when the run is deleted.
		if err := e.repo.RemoveWorktree(w.ctx, wt); err != nil {
			if w.ctx.Err() != nil {
				return errEngStop
			}
			log.Printf("runs: remove the checkout of %s of %s: %v", tid, r.id, err)
		}
	}

	_, err = r.commit(KTaskEnded, func(tx *Tx) error {
		t := tx.Task(tid)
		a := &t.Attempts[len(t.Attempts)-1]
		if a.Outcome != "" {
			tx.Skip()
			return nil
		}
		if w.cancelReq != nil && t.State() != model.TaskMerge {
			return errEngCancel
		}
		engEndAttempt(tx, t, a, model.TaskDone, "", nil, nil)
		a.Worktree = ""
		tx.Event(model.RunEvent{Type: "task_done", Task: tid, Text: clip(a.Result.Summary, 600)})
		return nil
	})
	return err
}

// taskCwd is where a task's agent works: its checkout, in the folder the run was started in
// when that is below the repository's top level and exists in the checkout; the run's folder in
// a run without git.
func (e *engine) taskCwd(g *Git, wt string, meta model.RunMeta) string {
	if g == nil {
		return meta.Cwd
	}
	if g.Sub != "" && filepath.IsLocal(g.Sub) {
		if fi, err := os.Stat(filepath.Join(wt, g.Sub)); err == nil && fi.IsDir() {
			return filepath.Join(wt, g.Sub)
		}
	}
	return wt
}

// setup runs the run's setup command in the top level of a new checkout, for writing and
// reporting tasks alike. Its output goes to the attempt's setup log in the run's folder. A stop
// and a cancel end it; a non-zero exit and a timeout fail the task with the end of the log.
func (e *engine) setup(w *engWorker, t Task, a Attempt, command string) error {
	if strings.TrimSpace(command) == "" {
		return nil
	}
	r := e.r
	logf, err := openSetupLog(r.dir, t.ID, a.N)
	if err != nil {
		log.Printf("runs: the setup log of %s of %s: %v", t.ID, r.id, err)
		return errors.New("the log of the setup command could not be opened")
	}
	err = rungit.RunSetup(w.ctx, a.Worktree, command, logf, engSetupTimeout)
	logf.Close()
	if err == nil {
		return nil
	}
	if ierr := e.interrupted(w); ierr != nil {
		return ierr
	}
	last := ""
	if tail := engLogTail(setupLogPath(r.dir, t.ID, a.N), 1500); tail != "" {
		last = " Its last output:\n" + tail
	}
	var se *rungit.SetupError
	switch {
	case errors.Is(err, rungit.ErrSetupTimeout):
		return fmt.Errorf("the setup command timed out after %s.%s", engMinutes(engSetupTimeout), last)
	case errors.As(err, &se) && se.Err == nil:
		return fmt.Errorf("the setup command failed (exit %d).%s", se.ExitCode, last)
	}
	return fmt.Errorf("the setup command could not be run: %v", err)
}

// engMinutes is a timeout as texts show it: whole minutes as "30m".
func engMinutes(d time.Duration) string {
	if d >= time.Minute && d%time.Minute == 0 {
		return fmt.Sprintf("%dm", int(d/time.Minute))
	}
	return d.String()
}

// engLogTail is the last max characters of a file, trimmed; "" when it cannot be read.
func engLogTail(path string, max int) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	text := strings.TrimSpace(strings.ToValidUTF8(string(b), "?"))
	if r := []rune(text); len(r) > max {
		text = string(r[len(r)-max:])
	}
	return text
}

// engBranchError says that an agent left its work tree somewhere else than on its branch.
func engBranchError(found, want string) error {
	where := "on branch " + found
	if found == "" {
		where = "on a detached HEAD (a rebase in progress, or a commit checked out)"
	}
	return fmt.Errorf("its agent left the work tree %s instead of on %s; its work was not merged", where, want)
}

// commitWork commits what a writing task's agent left in its checkout and records the head and
// what the attempt changed. The work tree must still be on the task's branch: git would commit
// on whatever is checked out. A merge or a conflict the agent left unfinished fails the task.
func (e *engine) commitWork(w *engWorker, t Task, a Attempt) error {
	r, repo, ctx := e.r, e.repo, w.ctx
	gitErr := func(what string, err error) error {
		if ctx.Err() != nil {
			return errEngStop
		}
		return fmt.Errorf("%s:\n%v", what, err)
	}
	br, err := repo.Branch(ctx, a.Worktree)
	if err != nil {
		return gitErr("its checkout could not be read", err)
	}
	if br != a.Branch {
		return engBranchError(br, a.Branch)
	}
	head, err := repo.CommitAll(ctx, a.Worktree, fmt.Sprintf("%s: %s", t.ID, engOneLine(t.Title)))
	switch {
	case errors.Is(err, rungit.ErrMerging), errors.Is(err, rungit.ErrUnmerged):
		return errors.New("its agent left a merge or a conflict unfinished in its working directory")
	case err != nil:
		return gitErr("its work could not be committed", err)
	}
	changes, err := e.changes(ctx, t.ID, a, head)
	if err != nil {
		return gitErr("its changes could not be listed", err)
	}
	_, err = r.commit(KTaskStep, func(tx *Tx) error {
		t := tx.Task(t.ID)
		a := &t.Attempts[len(t.Attempts)-1]
		a.Head = head
		tx.File(changesRel(t.ID, a.N), changesData(changes))
		tx.Head(Entry{Task: t.ID, Attempt: a.N})
		return nil
	})
	return err
}

// changes is what an attempt changed between its base and head: the files with their line
// counts, and the commits.
func (e *engine) changes(ctx context.Context, tid string, a Attempt, head string) (model.AttemptChanges, error) {
	c := model.AttemptChanges{Task: tid, Attempt: a.N, Branch: a.Branch, Base: a.Base, Head: head}
	files, err := e.repo.Changes(ctx, a.Base, head)
	if err != nil {
		return c, err
	}
	for _, f := range files {
		c.Files = append(c.Files, model.ChangedFile{Path: f.Path, Add: f.Added, Del: f.Deleted, Binary: f.Binary})
		c.Add += f.Added
		c.Del += f.Deleted
	}
	commits, err := e.repo.Commits(ctx, a.Base, head)
	if err != nil {
		return c, err
	}
	for _, k := range commits {
		c.Commits = append(c.Commits, model.Commit{SHA: k.SHA, Subject: k.Subject, At: k.Time.UnixMilli()})
	}
	return c, nil
}

// endAttempt ends an attempt that did not end as done: cancelled when its cancel was asked
// before it began to merge, else failed with err as the reason and a task_failed event in the
// same entry. Its checkout is discarded first.
func (e *engine) endAttempt(tid string, w *engWorker, cause error) {
	r := e.r
	t, a, err := r.engAttempt(tid)
	if err != nil || a.Outcome != "" {
		return
	}
	note := e.discard(t, a)
	costs := r.engRunningCosts()
	_, err = r.commit(KTaskEnded, func(tx *Tx) error {
		t := tx.Task(tid)
		a := &t.Attempts[len(t.Attempts)-1]
		if a.Outcome != "" {
			tx.Skip()
			return nil
		}
		if w.cancelReq != nil && t.State() != model.TaskMerge {
			engEndAttempt(tx, t, a, model.TaskCancelled, "", w.cancelReq, costs)
		} else {
			text := cause.Error() + note
			engEndAttempt(tx, t, a, model.TaskFailed, text, nil, costs)
			tx.Event(model.RunEvent{Type: "task_failed", Task: tid, Text: clip(text, 600)})
		}
		a.Worktree = ""
		return nil
	})
	if err != nil && !errors.Is(err, ErrNotFound) {
		log.Printf("runs: end %s of %s: %v", tid, r.id, err)
	}
}

// discard is what happens to the checkout of an attempt that failed or was cancelled: a merge in
// progress is aborted, a writing task's unfinished work is committed to its branch (a retry never
// uses that branch again), and the checkout is removed. The checkout is kept when the run keeps
// its work trees, and when the work could not be committed (the agent left conflicts, or the
// tree is not on the task's branch): then note says where the uncommitted work is.
func (e *engine) discard(t Task, a Attempt) (note string) {
	if e.repo == nil || a.Worktree == "" {
		return ""
	}
	wt, repo := a.Worktree, e.repo
	if _, err := os.Stat(wt); err != nil {
		return ""
	}
	// A cancel has ended the worker's context; the discard still has to happen.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	merging, err := repo.Merging(ctx, wt)
	if errors.Is(err, rungit.ErrNotWorktree) {
		return "" // the checkout was never made whole; the folder goes when the run is deleted
	}
	if merging {
		if err := repo.AbortMerge(ctx, wt); err != nil {
			log.Printf("runs: abort the merge in the checkout of %s of %s: %v", t.ID, e.r.id, err)
		}
	}
	if a.Branch != "" {
		br, err := repo.Branch(ctx, wt)
		if err == nil && br == a.Branch {
			_, err = repo.CommitAll(ctx, wt, fmt.Sprintf("%s: unfinished work (%s)", t.ID, engOneLine(t.Title)))
		}
		if err != nil || br != a.Branch {
			return fmt.Sprintf(" Its uncommitted work is left in %s.", wt)
		}
	}
	if e.r.engMeta().Settings.KeepWorktrees {
		return ""
	}
	if err := repo.RemoveWorktree(ctx, wt); err != nil {
		log.Printf("runs: remove the checkout of %s of %s: %v", t.ID, e.r.id, err)
	}
	return ""
}

// discardEnded discards the checkout of an attempt that ended while no engine ran, and clears
// its path in the record.
func (e *engine) discardEnded(tid string, n int) {
	r := e.r
	t, ok := r.engTask(tid)
	if !ok {
		return
	}
	for _, a := range t.Attempts {
		if a.N == n {
			e.discard(t, a)
		}
	}
	_, err := r.commit(KTaskStep, func(tx *Tx) error {
		t := tx.Task(tid)
		for i := range t.Attempts {
			if t.Attempts[i].N == n && t.Attempts[i].Outcome != "" {
				t.Attempts[i].Worktree = ""
				tx.Head(Entry{Task: tid, Attempt: n})
				return nil
			}
		}
		tx.Skip()
		return nil
	})
	if err != nil {
		log.Printf("runs: discard the checkout of %s of %s: %v", tid, r.id, err)
	}
}

// taskPrompt builds the first message of a task's work agent from the run as it is now. sub is
// the folder of its checkout the agent starts in when that is not the checkout's top, else "".
func (e *engine) taskPrompt(tid, sub string) (string, error) {
	r := e.r
	r.mu.Lock()
	l := r.L.snapshot()
	r.mu.Unlock()
	find := func(id string) *Task {
		for i := range l.Tasks {
			if l.Tasks[i].ID == id {
				return &l.Tasks[i]
			}
		}
		return nil
	}
	t := find(tid)
	if t == nil {
		return "", fmt.Errorf("internal error: no task %s", tid)
	}
	brief, err := readBrief(r.dir, tid, t.BriefRev)
	if err != nil {
		log.Printf("runs: the brief of %s of %s: %v", tid, r.id, err)
		return "", fmt.Errorf("the brief of %s could not be read", tid)
	}
	goal, _ := readGoal(r.dir)
	p := engTaskPrompt{ID: tid, Title: t.Title, Brief: brief, Goal: goal, Writes: t.Writes, Git: l.State.Git != nil, Sub: sub}
	// The readable copies (ctx.go) are the only files of the run a prompt may name.
	p.GoalPath, _ = r.readable(ctxGoal, "", 0)
	if path, ok := r.readable(ctxBrief, tid, 0); ok {
		p.BriefsDir = filepath.Dir(path)
	}
	for _, d := range t.DependsOn {
		dt := find(d)
		if dt == nil || len(dt.Attempts) == 0 {
			continue
		}
		da := dt.Attempts[len(dt.Attempts)-1]
		dep := engDep{ID: dt.ID, Kind: dt.Kind, Title: dt.Title, Needs: slices.Contains(t.NeedsReport, d)}
		if da.Result != nil {
			dep.Summary, dep.ReportSize = da.Result.Summary, da.Result.ReportSize
		}
		dep.Path, _ = r.readable(ctxReport, d, da.N)
		if dep.Needs {
			dep.Report, _ = readReport(r.dir, d, da.N)
		}
		if p.Git && dt.Writes && da.Head != "" && da.Head != da.Base {
			dep.Base, dep.Head = da.Base, da.Head
		}
		p.Deps = append(p.Deps, dep)
	}
	return engTaskPromptText(p), nil
}
