package runs

import (
	"context"
	"errors"
	"fmt"
	"log"
	"slices"
	"sort"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/rungit"
)

// This file is the orchestrator's turns: when one starts and why, the limits that are checked
// then, what a turn's worker does, and how the run ends when the orchestrator has finished it.

// startTurn starts a turn when one is due and none runs: the turn a halt left running (same
// number, same agent, no limit checked), or a new one after the limits.
func (e *engine) startTurn() {
	r := e.r
	r.mu.Lock()
	l := r.L
	if e.turn != nil || l.State.Result != nil || l.State.Status != model.RunRunning {
		r.mu.Unlock()
		return
	}
	turns := len(l.Turns)
	if turns > 0 && l.Turns[turns-1].Status == "running" {
		e.spawnTurn(l.Turns[turns-1].N)
		r.mu.Unlock()
		return
	}
	idle := engIdle(l)
	reason := e.turnReason(l, idle)
	met, _ := engWaitMet(l)
	set, streak := r.meta.Settings, l.State.IdleStreak
	r.mu.Unlock()
	if reason == "" {
		return
	}

	// The limits, in this order; the first halt wins.
	stalled := func(by model.StalledBy, text string) {
		err := r.halt(Halting{Status: model.RunStalled, StalledBy: by, Stop: model.StopStalled, Reason: text})
		if err != nil && !errors.Is(err, ErrNotRunning) {
			log.Printf("runs: halt %s at a limit: %v", r.id, err)
		}
	}
	switch {
	case engIdleTurn(reason, idle) && streak >= set.MaxIdleTurns:
		stalled(model.StalledIdle, fmt.Sprintf("the orchestrator was started %s in a row with nothing running and neither added work nor finished the run", toolCount(set.MaxIdleTurns, "time")))
		return
	case turns >= set.MaxTurns:
		stalled(model.StalledTurns, fmt.Sprintf("reached the limit of %s", toolCount(set.MaxTurns, "orchestrator turn")))
		return
	}
	if over, h := r.engOverCost(); over {
		stalled(h.StalledBy, h.Reason)
		return
	}

	n := turns + 1
	name := TurnAgentName(n)
	id := AgentChatID(r.id, name)
	_, err := r.commit(KTurnStarted, func(tx *Tx) error {
		st := tx.State()
		ts := tx.L().Turns
		if st.Status != model.RunRunning || st.Result != nil || len(ts) != n-1 || (len(ts) > 0 && ts[len(ts)-1].Status == "running") {
			tx.Skip()
			return nil
		}
		// The wait ends with the turn it was for, whatever started the turn: met or not, the new
		// instance decides again what it waits for.
		turn := Turn{N: n, Agent: id, Reason: reason, Idle: idle, Status: "running", StartedAt: tx.Now(), WokenBy: slices.Clone(st.Inbox)}
		turn.Wait, turn.WaitMet = cloneWait(st.Wait), met && st.Wait != nil
		tx.AddTurn(turn)
		st.Inbox, st.Wait = nil, nil
		if engIdleTurn(reason, idle) {
			st.IdleStreak++
		}
		mc := r.meta.Tiers.Of(model.OrchestratorTier)
		tx.AddAgent(Agent{RunAgent: model.RunAgent{ID: id, Name: name, Role: model.RoleOrchestrator, Turn: n,
			Status: model.AgentRunning, StartedAt: tx.Now(), Tier: model.OrchestratorTier, Model: mc.Model, Effort: mc.Effort}})
		tx.Head(Entry{Turn: n})
		tx.After(func() { e.spawnTurn(n) })
		return nil
	})
	if err != nil {
		log.Printf("runs: start turn %d of %s: %v", n, r.id, err)
	}
}

// engIdle reports whether nothing runs and nothing can start: no task is held, ready or active.
// It is counted from the tasks' states, not from which workers happen to be alive.
func engIdle(l *Loaded) bool {
	for i := range l.Tasks {
		switch l.Tasks[i].State() {
		case model.TaskHeld, model.TaskSlot, model.TaskSetup, model.TaskWork, model.TaskMerge:
			return false
		}
	}
	return true
}

// engWaitMet reports whether the orchestrator said what it waits for (set) and whether that has
// happened (met): all of the wait's tasks have ended, or any of them, as its mode says. A task
// that is no longer there counts as ended, so a wait can never hold a turn back for good.
func engWaitMet(l *Loaded) (met, set bool) {
	w := l.State.Wait
	if w == nil {
		return false, false
	}
	ended := 0
	for _, id := range w.Tasks {
		if i := slices.IndexFunc(l.Tasks, func(t Task) bool { return t.ID == id }); i < 0 || l.Tasks[i].State().Final() {
			ended++
		}
	}
	if w.Mode == "any" {
		return ended > 0, true
	}
	return ended == len(w.Tasks), true
}

// engIdleTurn reports whether a turn that starts for reason counts in the idle streak: one that
// starts with nothing running, because of that or because what it waited for ended. The first
// turn and a turn after a person's resume do not count.
func engIdleTurn(reason string, idle bool) bool {
	return reason == "idle" || (reason == "wait" && idle)
}

// turnReason says why a turn is due now; "" when none is. In wake mode declared the next turn
// starts when the wait is met; without a wait it starts on every event, as in each. A failed
// task, a chat's change and a person's resume start a turn in every mode, and so does a run with
// nothing left running. r.mu held.
func (e *engine) turnReason(l *Loaded, idle bool) string {
	wake := e.r.meta.Settings.Wake
	if wake == "" {
		wake = "declared"
	}
	met, set := engWaitMet(l)
	switch {
	case len(l.Turns) == 0:
		return "start"
	case idle && e.resumedByPerson():
		return "resume"
	case wake == "declared" && met:
		return "wait"
	case idle:
		return "idle"
	}
	if len(l.State.Inbox) == 0 {
		return ""
	}
	if wake == "each" || (wake == "declared" && !set) {
		return "events"
	}
	for _, ev := range l.State.Inbox {
		if ev.Type == "task_failed" || ev.Type == "chat_op" {
			return "events"
		}
	}
	return ""
}

// resumedByPerson reports whether a person resumed the run and no turn has started since. An
// engine lives from a start or a resume to the next halt, so it knows: person says who started
// it (a person's resume, not the server continuing the run by itself), turned that it has
// started or continued a turn. r.mu held.
func (e *engine) resumedByPerson() bool { return e.person && !e.turned }

// spawnTurn registers and starts the worker of turn n. r.mu held.
func (e *engine) spawnTurn(n int) {
	ctx, cancel := context.WithCancel(e.work)
	w := &engWorker{ctx: ctx, cancel: cancel, done: make(chan struct{})}
	e.turn, e.turnN, e.turned = w, n, true
	e.wg.Add(1)
	go e.turnWorker(n, w)
}

// turnWorker is the goroutine of one orchestrator turn. A stop leaves the turn running: the
// next start continues it with the same number and agent. Any other failure ends the turn as
// failed and halts the run with status error.
func (e *engine) turnWorker(n int, w *engWorker) {
	r := e.r
	defer func() {
		r.mu.Lock()
		if e.turn == w {
			e.turn = nil
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
	err := e.turnSteps(n, w)
	if err == nil || errors.Is(err, errEngStop) || w.ctx.Err() != nil {
		return
	}
	e.failTurn(n, err)
}

// turnSteps is one turn: the orchestrator's checkout is reset to the integration branch under
// the merge lock (so it never reads a half-done merge), the agent runs in it without a result
// block, and its closing message is the turn's summary. In a run without git the orchestrator
// works in the run's folder itself.
func (e *engine) turnSteps(n int, w *engWorker) error {
	r := e.r
	g, meta := r.engGit(), r.engMeta()
	cwd := meta.Cwd
	if g != nil {
		if e.repo == nil {
			return errEngStop
		}
		cwd = r.engOrchDir(g)
		ib := engIntBranch(r.id, g)
		r.mergeMu.Lock()
		err := e.repo.EnsureWorktree(w.ctx, cwd, "", ib)
		if err == nil {
			err = e.repo.ResetDetached(w.ctx, cwd, ib)
		}
		r.mergeMu.Unlock()
		if err != nil {
			if w.ctx.Err() != nil {
				return errEngStop
			}
			return fmt.Errorf("the orchestrator's checkout could not be reset: %v", err)
		}
	}
	res, err := e.runAgent(agentJob{name: TurnAgentName(n), role: model.RoleOrchestrator, cwd: cwd, git: g != nil, w: w,
		first: func() (string, error) { return e.orchPrompt(w.ctx, n) }})
	if err != nil {
		return err
	}
	if _, err := r.commit(KTurnEnded, func(tx *Tx) error {
		t := tx.Turn(n)
		if t == nil || t.Status != "running" {
			tx.Skip()
			return nil
		}
		t.Status, t.EndedAt, t.Summary = "done", tx.Now(), res.Text
		res.Done(tx)
		t.Cost = clonePtr(tx.Agent(t.Agent).Cost)
		engReleaseTurn(tx, n)
		tx.Head(Entry{Turn: n})
		return nil
	}); err != nil {
		return err
	}
	if err := r.checkpoint(); err != nil {
		log.Printf("runs: checkpoint of %s: %v", r.id, err)
	}
	e.checkCost()
	return nil
}

// engReleaseTurn ends every hold by turn n: its tasks may start.
func engReleaseTurn(tx *Tx, n int) {
	for _, rec := range tx.L().Tasks {
		if !slices.ContainsFunc(rec.HeldBy, func(h Holder) bool { return h.Turn == n }) {
			continue
		}
		t := tx.Task(rec.ID)
		t.HeldBy = slices.DeleteFunc(t.HeldBy, func(h Holder) bool { return h.Turn == n })
	}
}

// failTurn halts the run with status error and ends the turn as failed. The tasks the turn held
// are released all the same, and the events the turn was told about go back into the inbox (the
// turn keeps its own copies), so the next turn is told again. The wait the turn started under is
// not put back and a wait it declared itself is dropped: the turn after the resume starts on
// those events at once.
func (e *engine) failTurn(n int, cause error) {
	r := e.r
	text := clip(cause.Error(), engErrorMax)
	// The halt comes first: the tasks the turn held are released by the next entry, and nothing
	// starts while the run is stopping.
	e.haltError(fmt.Sprintf("orchestrator turn %d: %v", n, cause))
	costs := r.engRunningCosts()
	_, err := r.commit(KTurnEnded, func(tx *Tx) error {
		t := tx.Turn(n)
		if t == nil || t.Status != "running" {
			tx.Skip()
			return nil
		}
		t.Status, t.EndedAt, t.Error = "failed", tx.Now(), text
		if a := tx.Agent(t.Agent); a != nil {
			if a.Status == model.AgentRunning || a.Status == model.AgentInterrupted {
				engEndLaunch(a, tx.Now(), "")
				a.Status, a.Error, a.EndedAt = model.AgentFailed, text, tx.Now()
				costs[a.ID].apply(a)
			}
			t.Cost = clonePtr(a.Cost)
		}
		engReleaseTurn(tx, n)
		st := tx.State()
		inbox := slices.Clone(st.Inbox)
		for _, ev := range append(slices.Clone(t.WokenBy), t.Learned...) {
			if !slices.ContainsFunc(inbox, func(x model.RunEvent) bool { return x.Seq == ev.Seq }) {
				inbox = append(inbox, ev)
			}
		}
		sort.SliceStable(inbox, func(i, j int) bool { return inbox[i].Seq < inbox[j].Seq })
		st.Inbox = inbox
		// A wait the failed turn declared itself goes with it, or it would hold those events back.
		if w := st.Wait; w != nil && w.Turn == n {
			st.Wait = nil
		}
		tx.Head(Entry{Turn: n})
		return nil
	})
	if err != nil {
		log.Printf("runs: end turn %d of %s as failed: %v", n, r.id, err)
	}
}

// orchPrompt builds the first message of turn n from the run as it is now: a turn that is
// continued after a stop gets the run as it stands then, not as it was.
func (e *engine) orchPrompt(ctx context.Context, n int) (string, error) {
	r := e.r
	facts, err := r.gitFacts(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return "", errEngStop
		}
		return "", fmt.Errorf("the integration branch could not be read: %v", err)
	}
	r.mu.Lock()
	l := r.L.snapshot()
	meta := r.meta
	r.mu.Unlock()
	var turn Turn
	for _, t := range l.Turns {
		if t.N == n {
			turn = t
		}
	}
	p := engOrchPrompt{Turn: n, Reason: turn.Reason, IdleStreak: l.State.IdleStreak, MaxIdleTurns: meta.Settings.MaxIdleTurns,
		Snapshot: snapshotText(meta, l, facts), MaxParallel: meta.Settings.MaxParallel, Wake: meta.Settings.Wake,
		Tiers: meta.Tiers, MaxTurns: meta.Settings.MaxTurns, Wait: turn.Wait, WaitMet: turn.WaitMet,
		// A turn recorded before Idle was: idle and resume turns start with nothing running.
		Idle:          turn.Idle || turn.Reason == "idle" || turn.Reason == "resume",
		ReportsByPath: true, // a report's readable copy is written whenever a task's prompt names it (ctx.go)
		ManualApply:   meta.Settings.ApplyResult == "manual"}
	if p.Wake == "" {
		p.Wake = "declared"
	}
	p.WokenByChat = slices.ContainsFunc(turn.WokenBy, func(ev model.RunEvent) bool { return ev.Type == "chat_op" })
	p.Goal, _ = readGoal(r.dir)
	latest := 0
	for _, v := range l.Notes {
		latest = max(latest, v.V)
	}
	if latest > 0 {
		p.Notes, _ = readNotes(r.dir, latest)
	}
	for _, ev := range append(slices.Clone(turn.WokenBy), turn.Learned...) {
		p.Events = append(p.Events, eventLine(ev))
	}
	if g := l.State.Git; g != nil {
		p.Git, p.Sub, p.Dirty = true, g.Sub, g.DirtyAtStart
	}
	// The stop a resume turn follows: the last one that was resumed before the turn began.
	for _, s := range l.Stops {
		if s.ResumedAt != 0 && s.ResumedAt <= turn.StartedAt {
			p.Halt, p.StalledBy = s.Reason, s.StalledBy
		}
	}
	return engOrchestratorPrompt(p), nil
}

// engFinish ends a run whose result is set, when the turn that set it is over and no task worker
// is left. The result is delivered first (delivAtEnd): applied to the person's folder when that
// is automatic and git accepts it, otherwise left for the person. Then the orchestrator's and the
// integration checkout are removed (a branch that is checked out in a work tree could not be
// checked out by the user), and one run_finished entry sets the status, the end, the result's
// head and the delivery, and closes a turn that was left running, with its agent's last text as
// the summary. Then a checkpoint, and the branches of a run whose result was applied go
// (delivTidy). A server that stops between the fast-forward and the entry finishes the run again
// at its next start, and the delivery is then "already". repo may be nil: it is opened then.
func (r *run) engFinish(ctx context.Context, repo *rungit.Repo) error {
	g, meta := r.engGit(), r.engMeta()
	status := model.RunGaveUp
	r.mu.Lock()
	if r.L != nil && r.L.State.Result != nil && r.L.State.Result.Outcome == model.Achieved {
		status = model.RunCompleted
	}
	r.mu.Unlock()
	head := ""
	if g != nil {
		if repo == nil {
			repo, _ = r.svc.eng.openRepo(ctx, g.Repo)
		}
		if repo != nil {
			h, err := repo.Resolve(ctx, engIntBranch(r.id, g))
			switch {
			case err == nil:
				head = h
			case ctx.Err() != nil:
				return ctx.Err()
			case errors.Is(err, rungit.ErrUnknownRef):
				head = g.BaseRef // no engine ever made the branch: nothing was merged
			default:
				log.Printf("runs: the result's head of %s: %v", r.id, err)
			}
		}
	}
	// Before the checkouts go: the work folder is still there for the scratch work tree of a
	// merge commit, and it is removed with them when the delivery left it empty.
	delivery := r.delivAtEnd(ctx, g, meta, status, head)
	if repo != nil && !meta.Settings.KeepWorktrees {
		r.mergeMu.Lock()
		for _, dir := range []string{r.engOrchDir(g), r.engIntDir(g)} {
			// A checkout that cannot be removed is left; it goes when the run is deleted.
			if err := repo.RemoveWorktree(ctx, dir); err != nil {
				log.Printf("runs: remove %s of %s: %v", dir, r.id, err)
			}
		}
		r.mergeMu.Unlock()
	}
	r.ctxRemove() // no agent of the run reads them any more
	// A turn left running (the server stopped between finish_run and the turn's end).
	open, agent := 0, ""
	r.mu.Lock()
	if r.L != nil {
		if n := len(r.L.Turns); n > 0 && r.L.Turns[n-1].Status == "running" {
			open, agent = r.L.Turns[n-1].N, r.L.Turns[n-1].Agent
		}
	}
	r.mu.Unlock()
	summary := ""
	if open != 0 && r.svc.Chats != nil {
		if st, err := r.svc.Chats.OwnedState(agent); err == nil {
			summary = st.Text
		}
	}
	costs := r.engRunningCosts()
	v, err := r.commit(KRunFinished, func(tx *Tx) error {
		st := tx.State()
		if st.Result == nil || !st.Status.Live() {
			tx.Skip()
			return nil
		}
		st.Status = model.RunGaveUp
		if st.Result.Outcome == model.Achieved {
			st.Status = model.RunCompleted
		}
		st.EndedAt = tx.Now()
		if tx.Now() > st.AsOf {
			st.ActiveMs += tx.Now() - st.AsOf
		}
		st.AsOf, st.Reason, st.StalledBy, st.Halting = tx.Now(), "", "", nil
		if st.Git != nil {
			st.Git.ResultHead = head
		}
		st.Delivery = cloneDelivery(&delivery)
		done := ""
		for _, rec := range tx.L().Turns {
			if rec.Status != "running" {
				continue
			}
			t := tx.Turn(rec.N)
			t.Status, t.EndedAt = "done", tx.Now()
			if rec.N == open {
				t.Summary = summary
			}
			done = t.Agent
		}
		for _, rec := range tx.L().Agents {
			if rec.Status != model.AgentRunning && !(rec.ID == done && rec.Status == model.AgentInterrupted) {
				continue
			}
			a := tx.Agent(rec.ID)
			engEndLaunch(a, tx.Now(), "")
			a.Status, a.EndedAt = model.AgentInterrupted, tx.Now()
			if rec.ID == done {
				a.Status = model.AgentDone
			}
			costs[rec.ID].apply(a)
		}
		if done != "" {
			if t, a := tx.Turn(open), tx.Agent(done); t != nil && a != nil {
				t.Cost = clonePtr(a.Cost)
			}
		}
		tx.Head(Entry{Turn: open})
		tx.After(func() { r.eng = nil })
		return nil
	})
	if err != nil {
		return err
	}
	if err := r.checkpoint(); err != nil {
		return err
	}
	if v != 0 && repo != nil && !meta.Settings.KeepWorktrees {
		r.delivTidy(ctx, repo, g, delivery)
	}
	return nil
}
