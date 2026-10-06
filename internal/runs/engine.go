package runs

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/rungit"
)

// This file is the run engine's face toward the service and the tools: the engine of a live run
// and what the service and the tools call on a run (start, halt, resume, stop, cancel a task,
// remove the checkouts, the agents' live values). The scheduler is in sched.go, a task attempt
// in attempt.go, the merge flow in merge.go, an orchestrator turn in turn.go, the life of one
// agent in agentrun.go, and what the server does with runs when it starts and stops in boot.go.
//
// Locks, in the order they may be taken: a chat's lock (the chat manager's), run.mergeMu,
// run.mu, then the leaf locks (engine.liveMu, engines.mu, the event queue's). So with run.mu
// held nothing here calls the chat manager or git, and every check a change depends on is made
// again inside the commit's build, on recorded state.

// How a worker says why it stopped without a result.
var (
	errEngStop   = errors.New("the run is stopping")   // a halt, a shutdown or a delete: the task or turn stays as it is
	errEngCancel = errors.New("the task is cancelled") // cancel_task
)

const (
	engStopGrace   = 10 * time.Second // how long a stopped agent's turn may take to end
	engTickEvery   = 2 * time.Second  // the ticker: run_activity
	engCostEvery   = 15 * time.Second // an interim cost per agent, the view's cost, the cost limit
	engCancelWait  = 90 * time.Second // cancel_task waits this long for the task's worker
	engMergeRounds = 3                // conflict rounds of one attempt
	engErrorMax    = 4000             // characters of an attempt's or a turn's recorded error
)

// engSetupTimeout is how long a setup command may run.
var engSetupTimeout = 30 * time.Minute

// The reason sentences of the halts the engine makes by itself.
const (
	engReasonQuit  = "the app was closed while the run was working"
	engReasonCrash = "the app ended unexpectedly while the run was working; resume it when you are ready"
	engReasonLoop  = "the app closed three times within a minute of continuing this run; resume it when you are ready"
)

// engine is what a live run's scheduler and workers share: run.eng while a scheduler runs, nil
// otherwise. run.mu guards the field. An engine lives from a start or a resume to the next halt
// or the run's end; a resume makes a new one.
type engine struct {
	r      *run
	person bool // a person's resume started it (not the server's start): see turnReason

	work     context.Context // the workers' context: cancelled by a halt, a shutdown, a delete
	stopWork context.CancelFunc
	quit     chan struct{} // closed by stop: the scheduler returns without writing an entry
	quitOnce sync.Once
	done     chan struct{}  // closed when the scheduler has returned and no worker is left
	wg       sync.WaitGroup // the workers; only the scheduler adds to it and waits on it

	// run.mu guards these.
	workers map[string]*engWorker // the task workers, by task id
	turn    *engWorker            // the turn worker; nil when none runs
	turnN   int
	turned  bool // a turn was started or continued by this engine

	// repo is the run's repository: set by the scheduler before it starts any worker, then read
	// only. nil for a run without git.
	repo *rungit.Repo

	// liveMu is a leaf lock: nothing is called with it held.
	liveMu   sync.Mutex
	liveVals map[string]Live      // the ticker's last sample of the running agents, by chat id
	costSent map[string]time.Time // when an agent's cost last rode in a run_activity event
	viewCost time.Time            // when the view was last rebuilt because a live cost moved
	limitAt  time.Time            // when the ticker last checked the cost limit
}

// engWorker is one goroutine of an engine that works on a task or on a turn.
type engWorker struct {
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
	// cancelReq is the cancellation cancel_task asked for; run.mu guards it. Once it is set the
	// task cannot enter phase merge (the cancel boundary) and its attempt ends cancelled.
	cancelReq *model.AttemptCancel
}

// engines is what the engine keeps per service (Service.eng): the quit flag of a shutdown, the
// engines whose goroutines have not returned, and the repositories it has opened.
type engines struct {
	s    *Service
	quit atomic.Bool

	mu     sync.Mutex // a leaf lock
	active map[*engine]struct{}
	repos  map[string]*rungit.Repo // by the folder they were opened from
	gitOK  bool                    // git was found new enough

	// onActivity, when set, sees every `run_activity` event the ticker queues. Tests set it;
	// nothing else does.
	onActivity func(engActivityEvent)
}

// init prepares the per-service state. New calls it once, before any run exists. It starts no
// goroutine that needs Service.Chats, which is set later.
func (e *engines) init(s *Service) {
	e.s = s
	e.active = map[*engine]struct{}{}
	e.repos = map[string]*rungit.Repo{}
}

// openRepo is the repository at dir (the folder a run recorded as its repository), opened once
// per service.
func (e *engines) openRepo(ctx context.Context, dir string) (*rungit.Repo, error) {
	e.mu.Lock()
	repo := e.repos[dir]
	e.mu.Unlock()
	if repo != nil {
		return repo, nil
	}
	repo, err := e.s.openRepo(ctx, dir)
	if err != nil {
		return nil, err
	}
	e.mu.Lock()
	e.repos[dir] = repo
	e.mu.Unlock()
	return repo, nil
}

// wait waits up to d for the engines of r whose goroutines have not returned; it reports
// whether none is left.
func (e *engines) wait(r *run, d time.Duration) bool {
	e.mu.Lock()
	var dones []chan struct{}
	for eng := range e.active {
		if r == nil || eng.r == r {
			dones = append(dones, eng.done)
		}
	}
	e.mu.Unlock()
	if len(dones) == 0 {
		return true
	}
	// The deadline of a stop is the wall clock's: it bounds how long the server waits to go down.
	limit := time.NewTimer(d)
	defer limit.Stop()
	for _, done := range dones {
		select {
		case <-done:
		case <-limit.C:
			return false
		}
	}
	return true
}

// startEngine starts the scheduler of a run whose status is running: a goroutine that waits on
// r.wake, a one-second tick of the clock and its context, and makes one pass each time (start
// tasks, start a turn, end the run). It is a no-op when one runs already, when the status is not
// running, or when the service is shutting down. Its first act for a run with git is to make the
// integration checkout. It locks r.mu itself: do not call it with r.mu held.
func (r *run) startEngine() { r.engStartAs(false) }

// engStartAs is startEngine; person says that a person's resume starts it.
func (r *run) engStartAs(person bool) {
	s := r.svc
	if s.eng.quit.Load() {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.eng != nil {
		return
	}
	if err := r.loadLocked(); err != nil || r.L.State.Status != model.RunRunning {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	e := &engine{r: r, person: person, work: ctx, stopWork: cancel, quit: make(chan struct{}), done: make(chan struct{}),
		workers: map[string]*engWorker{}, liveVals: map[string]Live{}, costSent: map[string]time.Time{}}
	r.eng = e
	s.eng.mu.Lock()
	s.eng.active[e] = struct{}{}
	s.eng.mu.Unlock()
	go e.loop()
	go e.ticker()
}

// stop ends the engine without an entry: the workers' context is cancelled and the scheduler
// returns when they have.
func (e *engine) stop() {
	e.quitOnce.Do(func() { close(e.quit) })
	e.stopWork()
	e.r.engPoke()
}

// quitting reports whether the engine is ending without a halt: the server shuts down or the
// run is deleted. Its workers then only record; they close no process.
func (e *engine) quitting() bool {
	select {
	case <-e.quit:
		return true
	default:
		return e.r.svc.eng.quit.Load()
	}
}

// engPoke makes the scheduler look again.
func (r *run) engPoke() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// halt begins a halt of the run: one run_stopping entry sets the status stopping and
// State.Halting = h (where the halt is going: stopped by the user, stalled by a limit, error).
// It is refused with ErrNotRunning when the run is not running; the first halt wins. It returns
// when the entry is written; the engine then cancels its workers, each ends its agent and records
// it, and when none is left the scheduler writes run_halted (the status of h, a new open stop,
// ActiveMs) and a checkpoint. With no scheduler running (the engine was never started in this
// process) halt writes run_halted itself.
func (r *run) halt(h Halting) error {
	var eng *engine
	_, err := r.commit(KRunStopping, func(tx *Tx) error {
		st := tx.State()
		if st.Status != model.RunRunning {
			return ErrNotRunning
		}
		target := h
		st.Status, st.Halting = model.RunStopping, &target
		tx.After(func() { eng = r.eng })
		return nil
	})
	if err != nil {
		return err
	}
	if eng != nil {
		eng.stopWork()
		r.engPoke()
		return nil
	}
	return r.engWriteHalted(Halting{}, 0)
}

// engWriteHalted commits run_halted for a run that is running or stopping, and a checkpoint: the
// status, reason and stop reason of State.Halting (of def when no halt was under way), a new
// open stop, ActiveMs, and every agent still recorded as running becomes interrupted with its
// cost from the chat manager. at is the stop's time, 0 for now. A run that is not live is left
// alone.
func (r *run) engWriteHalted(def Halting, at int64) error {
	costs := r.engRunningCosts()
	_, err := r.commit(KRunHalted, func(tx *Tx) error {
		st := tx.State()
		if !st.Status.Live() {
			tx.Skip()
			return nil
		}
		h := def
		if st.Halting != nil {
			h = *st.Halting
		}
		if h.Status == "" {
			h.Status, h.Stop = model.RunStopped, model.StopUser
		}
		t := at
		if t == 0 {
			t = tx.Now()
		}
		st.Status, st.Reason, st.StalledBy, st.Halting = h.Status, h.Reason, h.StalledBy, nil
		if t > st.AsOf {
			st.ActiveMs += t - st.AsOf
		}
		st.AsOf = t
		tx.SetStops(append(tx.Stops(), model.RunStop{At: t, Reason: h.Stop, StalledBy: h.StalledBy}))
		for _, a := range tx.L().Agents {
			if a.Status != model.AgentRunning {
				continue
			}
			rec := tx.Agent(a.ID)
			engEndLaunch(rec, t, "")
			rec.Status = model.AgentInterrupted
			costs[a.ID].apply(rec)
		}
		tx.After(func() { r.eng = nil })
		return nil
	})
	if err != nil {
		return err
	}
	return r.checkpoint()
}

// resume continues a halted run: one run_resumed entry (status running, the open stop gets
// ResumedAt, AsOf = now, Reason and StalledBy cleared, IdleStreak = 0 when the run had stalled on
// idle), then startEngine. The caller has made the route's checks (the run is halted, not
// archived, not blocked, the limit that stalled it was raised) and has written a raised limit to
// run.json and r.meta. ErrNotHalted when the run is not stopped, stalled or in error.
func (r *run) resume() error { return r.engResumeAs(true) }

// engResumeAs is resume; person is false when the server continues the run by itself at its start.
func (r *run) engResumeAs(person bool) error {
	_, err := r.commit(KRunResumed, func(tx *Tx) error {
		st := tx.State()
		switch st.Status {
		case model.RunStopped, model.RunStalled, model.RunError:
		default:
			return ErrNotHalted
		}
		if st.StalledBy == model.StalledIdle {
			st.IdleStreak = 0
		}
		st.Status, st.Reason, st.StalledBy, st.Halting = model.RunRunning, "", "", nil
		st.AsOf = tx.Now()
		stops := tx.Stops()
		if n := len(stops); n > 0 && stops[n-1].ResumedAt == 0 {
			stops[n-1].ResumedAt = tx.Now()
			tx.SetStops(stops)
		}
		return nil
	})
	if err != nil {
		return err
	}
	r.engStartAs(person)
	return nil
}

// stopEngine cancels the run's workers and its scheduler and waits up to wait for them to
// return; it reports whether none is left. It writes no entry and changes no status: a run
// deleted or a server shutting down uses it, a Stop uses halt. True at once when no engine runs.
func (r *run) stopEngine(wait time.Duration) bool {
	r.mu.Lock()
	e := r.eng
	r.mu.Unlock()
	if e != nil {
		e.stop()
	}
	return r.svc.eng.wait(r, wait)
}

// cancelActive cancels a task that is in setup, work or merge: the cancel_task tool calls it for
// such a task (a waiting or failed task it closes itself). c is the cancellation to record on the
// attempt. It cancels the task's worker and waits up to 90 s for its task_ended entry (outcome
// cancelled, Cancel = c, no event, the holds cleared, the checkout discarded). refusal is "" when
// the task was cancelled, else the text the tool answers:
//   - the task is in phase merge: its result is in and is being merged, it cannot be cancelled;
//   - no worker has it and the run is running: `{tid} is starting; try again in a moment`;
//   - the worker did not let go in time, or the run halted while it was asked to.
//
// With no worker and the run halted, the attempt is closed as cancelled at once and its checkout
// is discarded at the next start. The caller holds no lock and records its own op entry after.
func (r *run) cancelActive(tid string, c model.AttemptCancel) (refusal string) {
	const merging = "%s has finished and is being merged; it can no longer be cancelled."
	const starting = "%s is starting; try again in a moment"
	const stuck = "%s is being stopped but has not let go yet; look again with get_run"

	// One hold of r.mu: the phase check and the request. A worker reads the request under the
	// same lock in the entry that would take the task into phase merge.
	r.mu.Lock()
	if err := r.loadLocked(); err != nil {
		r.mu.Unlock()
		return err.Error()
	}
	var w *engWorker
	state, found := model.TaskState(""), false
	for i := range r.L.Tasks {
		if r.L.Tasks[i].ID == tid {
			state, found = r.L.Tasks[i].State(), true
		}
	}
	status := r.L.State.Status
	if found && state.Active() && state != model.TaskMerge && r.eng != nil {
		if w = r.eng.workers[tid]; w != nil && w.cancelReq == nil {
			req := c
			w.cancelReq = &req
		}
	}
	r.mu.Unlock()
	switch {
	case !found:
		return fmt.Sprintf("no task %s", tid)
	case state == model.TaskMerge:
		return fmt.Sprintf(merging, tid)
	case !state.Active():
		return fmt.Sprintf("%s is %s now; look again with get_run", tid, state)
	}

	if w == nil {
		if status == model.RunRunning {
			return fmt.Sprintf(starting, tid)
		}
		// No worker and the run is halted (or its last worker has just let go): close the attempt
		// here. Everything is checked again inside build.
		costs := r.engRunningCosts()
		_, err := r.commit(KTaskEnded, func(tx *Tx) error {
			if r.eng != nil && r.eng.workers[tid] != nil {
				return errors.New(fmt.Sprintf(starting, tid))
			}
			t := tx.Task(tid)
			if t == nil || !t.State().Active() {
				return fmt.Errorf("%s is no longer running; look again with get_run", tid)
			}
			if t.State() == model.TaskMerge {
				return fmt.Errorf(merging, tid)
			}
			if tx.State().Status == model.RunRunning {
				return errors.New(fmt.Sprintf(starting, tid))
			}
			a := &t.Attempts[len(t.Attempts)-1]
			engEndAttempt(tx, t, a, model.TaskCancelled, "", &c, costs)
			return nil
		})
		if err != nil {
			return err.Error()
		}
		return ""
	}

	w.cancel()
	select {
	case <-w.done:
	case <-r.svc.Clock.After(engCancelWait):
		return fmt.Sprintf(stuck, tid)
	}
	if t, ok := r.engTask(tid); ok && t.State() == model.TaskCancelled {
		return ""
	} else if ok && t.State() == model.TaskMerge {
		return fmt.Sprintf(merging, tid)
	} else if ok && t.State().Final() {
		return fmt.Sprintf("%s is %s now; it can no longer be cancelled.", tid, t.State())
	}
	// The worker returned without ending the task: the run halted while it was asked to.
	return fmt.Sprintf(stuck, tid)
}

// removeCheckouts removes every checkout of the run (its folders under store.Paths.RunWorkDir)
// from the repository and then that folder, and after them the run's branches: all of them,
// except an integration branch whose result is not in the person's folder (delivDropBranches). A
// run without git has only the folder; one that never made a checkout or a branch has nothing to
// remove. Service.Delete calls it after stopEngine and before the run's folder is removed; an
// archive does not call it, and removes nothing.
func (r *run) removeCheckouts(ctx context.Context) error {
	r.ctxRemove()
	root := r.svc.Store.P.RunWorkDir(r.id)
	entries, err := os.ReadDir(root)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var first error
	g := r.engGit()
	var repo *rungit.Repo
	if g != nil {
		if repo, err = r.svc.eng.openRepo(ctx, g.Repo); err != nil {
			repo = nil
			if len(entries) > 0 {
				first = fmt.Errorf("the checkouts of the run are still listed in %s: %w", g.Repo, err)
			}
		}
	}
	for _, e := range entries {
		if repo == nil || !e.IsDir() {
			continue
		}
		// A folder that is no work tree of the repository (ErrNotWorktree) is only a folder.
		if err := repo.RemoveWorktree(ctx, filepath.Join(root, e.Name())); err != nil && !errors.Is(err, rungit.ErrNotWorktree) && first == nil {
			first = err
		}
	}
	if err := os.RemoveAll(root); err != nil && first == nil {
		first = err
	}
	os.Remove(r.svc.Store.P.RunWork) // the parent goes with its last run; it fails when it is not empty
	if repo != nil {
		if err := r.delivDropBranches(ctx, repo, g); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// live is what the run's running agents say of themselves, by agent chat id: the tool count and
// the label of the last tool item, and a cost newer than the recorded one. Detail, WirePatch and
// the view's cost use it. It returns what the engine's ticker last read (nil when no engine
// runs), for the agents whose recorded status is running: it is called with r.mu held, so it
// must not take r.mu and must not call the chat manager.
func (r *run) live() map[string]Live {
	e := r.eng
	if e == nil || r.L == nil {
		return nil
	}
	e.liveMu.Lock()
	defer e.liveMu.Unlock()
	if len(e.liveVals) == 0 {
		return nil
	}
	out := make(map[string]Live, len(e.liveVals))
	for i := range r.L.Agents {
		a := &r.L.Agents[i]
		if a.Status != model.AgentRunning {
			continue
		}
		if v, ok := e.liveVals[a.ID]; ok {
			out[a.ID] = v
		}
	}
	return out
}

// gitFacts reads the integration branch's head and the number of commits on it since the run's
// base, for the snapshot text. Zero values for a run without git. It runs git: call it with no
// lock held, before the commit or the lock whose state the text is built from.
func (r *run) gitFacts(ctx context.Context) (gitFacts, error) {
	g := r.engGit()
	if g == nil {
		return gitFacts{}, nil
	}
	repo, err := r.svc.eng.openRepo(ctx, g.Repo)
	if err != nil {
		return gitFacts{}, err
	}
	head, err := repo.Resolve(ctx, engIntBranch(r.id, g))
	if errors.Is(err, rungit.ErrUnknownRef) {
		if g.ResultHead == "" {
			return gitFacts{Head: g.BaseRef}, nil // the engine has not made the branch yet
		}
		head, err = g.ResultHead, nil // the run has ended and the branch went when its result was applied
	}
	if err != nil {
		return gitFacts{}, err
	}
	commits, err := repo.Commits(ctx, g.BaseRef, head)
	if err != nil {
		return gitFacts{}, err
	}
	return gitFacts{Head: head, Commits: len(commits)}, nil
}

// ---- reading the run ---------------------------------------------------------

// engGit is a copy of the run's git record; nil for a run without git or one that has not started.
func (r *run) engGit() *Git {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.loadLocked() != nil {
		return nil
	}
	return clonePtr(r.L.State.Git)
}

// engTask is a task as recorded now. Records never change in place, so it can be read after the
// lock is released.
func (r *run) engTask(id string) (Task, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.L == nil {
		return Task{}, false
	}
	for i := range r.L.Tasks {
		if r.L.Tasks[i].ID == id {
			return r.L.Tasks[i], true
		}
	}
	return Task{}, false
}

// engAttempt is a task and its current attempt as recorded now.
func (r *run) engAttempt(id string) (Task, Attempt, error) {
	t, ok := r.engTask(id)
	if !ok || len(t.Attempts) == 0 {
		return t, Attempt{}, fmt.Errorf("internal error: task %s has no attempt", id)
	}
	return t, t.Attempts[len(t.Attempts)-1], nil
}

// engAgent is an agent's record as it is now.
func (r *run) engAgent(id string) (Agent, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.L == nil {
		return Agent{}, false
	}
	for i := range r.L.Agents {
		if r.L.Agents[i].ID == id {
			return r.L.Agents[i], true
		}
	}
	return Agent{}, false
}

// engMeta is run.json as it is in memory.
func (r *run) engMeta() model.RunMeta {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.meta
}

// ---- names and places ----------------------------------------------------------

// engIntBranch is the run's integration branch.
func engIntBranch(run string, g *Git) string {
	if g != nil && g.IntegrationBranch != "" {
		return g.IntegrationBranch
	}
	return "aiwb/" + run + "/integration"
}

// engTaskBranch is the branch of a writing task's attempt.
func engTaskBranch(run, prefix string) string { return "aiwb/" + run + "/" + prefix }

// engIntDir and engOrchDir are the integration checkout and the orchestrator's.
func (r *run) engIntDir(g *Git) string {
	if g != nil && g.Integration != "" {
		return g.Integration
	}
	return filepath.Join(r.svc.Store.P.RunWorkDir(r.id), "int")
}

func (r *run) engOrchDir(g *Git) string {
	if g != nil && g.Orchestrator != "" {
		return g.Orchestrator
	}
	return filepath.Join(r.svc.Store.P.RunWorkDir(r.id), "orch")
}

// engMergeAgentName names the merge agent of a conflict round: "T03-merge" for the first,
// "T03-merge-r2" from the second on.
func engMergeAgentName(task string, attempt, round int) string {
	name := MergeAgentName(task, attempt)
	if round > 1 {
		name += fmt.Sprintf("-r%d", round)
	}
	return name
}

// engDuration is a duration as texts show it: 42s, 5m27s, 1h05m.
func engDuration(d time.Duration) string {
	s := int(d / time.Second)
	h, m := s/3600, s%3600/60
	switch {
	case h > 0:
		return fmt.Sprintf("%dh%02dm", h, m)
	case m > 0:
		return fmt.Sprintf("%dm%02ds", m, s%60)
	}
	return fmt.Sprintf("%ds", s)
}

// ---- cost ----------------------------------------------------------------------

// engCost is what the chat manager says an agent's chat has cost.
type engCost struct {
	ok   bool // the chat manager answered
	usd  *float64
	lost bool
	tok  *model.TokenCount // nil: no tokens were reported
	peak int               // the largest context of the chat's own agent; 0 = not known
}

// apply sets an agent's recorded cost: the chat's total, never a sum, so a restart can neither
// lose nor count twice. Nothing changes when the chat manager did not answer.
func (c engCost) apply(a *Agent) {
	if !c.ok {
		return
	}
	a.Cost, a.CostLost = clonePtr(c.usd), c.lost
	a.Tokens, a.PeakContext = clonePtr(c.tok), c.peak
}

// engCostOf reads an agent's cost from the chat manager. Never call it with r.mu held.
func (s *Service) engCostOf(id string) engCost {
	if s.Chats == nil {
		return engCost{}
	}
	c, err := s.Chats.CostOf(id)
	if err != nil {
		return engCost{}
	}
	out := engCost{ok: true, lost: c.Partial, peak: c.Peak}
	if c.TokensKnown {
		tok := c.Tokens
		out.tok = &tok
	}
	if c.Known {
		usd := c.USD
		out.usd = &usd
	}
	return out
}

// engRunningCosts is the cost of every agent recorded as running, by chat id.
func (r *run) engRunningCosts() map[string]engCost {
	r.mu.Lock()
	var ids []string
	if r.loadLocked() == nil {
		for i := range r.L.Agents {
			if r.L.Agents[i].Status == model.AgentRunning {
				ids = append(ids, r.L.Agents[i].ID)
			}
		}
	}
	r.mu.Unlock()
	out := make(map[string]engCost, len(ids))
	for _, id := range ids {
		out[id] = r.svc.engCostOf(id)
	}
	return out
}

// engEndLaunch closes an agent's open launch.
func engEndLaunch(a *Agent, at int64, errText string) {
	if n := len(a.Launches); n > 0 && a.Launches[n-1].EndedAt == 0 {
		a.Launches[n-1].EndedAt = at
		a.Launches[n-1].Error = errText
	}
}

// engAttemptCost is what the agents of an attempt have cost: its work agent and every merge
// agent. nil when none has a cost.
func engAttemptCost(tx *Tx, task string, attempt int) *float64 {
	var sum float64
	any := false
	for _, a := range tx.L().Agents {
		if a.Task != task || a.Attempt != attempt {
			continue
		}
		cost := a.Cost
		if rec, ok := tx.agents[a.ID]; ok { // the record as this entry leaves it
			cost = rec.Cost
		}
		if cost != nil {
			sum += *cost
			any = true
		}
	}
	if !any {
		return nil
	}
	return &sum
}

// engEndAttempt writes the end of an attempt into a task_ended entry: the outcome, when, the
// error or the cancellation, the cost, the holds cleared, and every agent of the attempt that is
// not ended becomes cancelled (a cancelled attempt) or interrupted. The checkout's path is left
// to the caller. costs: what the chat manager says of the agents still recorded as running.
func engEndAttempt(tx *Tx, t *Task, a *Attempt, outcome model.TaskState, errText string, c *model.AttemptCancel, costs map[string]engCost) {
	tx.Head(Entry{Task: t.ID, Attempt: a.N})
	a.Outcome, a.EndedAt = outcome, tx.Now()
	a.Error = clip(errText, engErrorMax)
	if c != nil {
		cc := *c
		if cc.T == 0 {
			cc.T = tx.Now()
		}
		a.Cancel = &cc
	}
	t.HeldBy = nil
	for _, rec := range tx.L().Agents {
		if rec.Task != t.ID || rec.Attempt != a.N {
			continue
		}
		if rec.Status != model.AgentRunning && !(outcome == model.TaskCancelled && rec.Status == model.AgentInterrupted) {
			continue
		}
		ag := tx.Agent(rec.ID)
		engEndLaunch(ag, tx.Now(), "")
		ag.Status = model.AgentInterrupted
		if outcome == model.TaskCancelled {
			ag.Status = model.AgentCancelled
		}
		if ag.EndedAt == 0 {
			ag.EndedAt = tx.Now()
		}
		costs[rec.ID].apply(ag)
	}
	a.Cost = engAttemptCost(tx, t.ID, a.N)
}

// ---- the cost limit --------------------------------------------------------------

// checkCost halts the run as stalled when its cost has reached the limit: the recorded cost of
// the ended agents plus what the chat manager says of the running ones. It is called when a turn
// is due (the caller halts), after every entry that ends a launch, and by the ticker. Nothing
// halts a run whose result is set, and a kind that reports no cost never reaches a limit.
func (e *engine) checkCost() {
	if over, h := e.r.engOverCost(); over {
		if err := e.r.halt(h); err != nil && !errors.Is(err, ErrNotRunning) {
			log.Printf("runs: halt %s at its cost limit: %v", e.r.id, err)
		}
	}
}

// engOverCost reports whether the run's cost has reached its limit, and the halt that says so.
func (r *run) engOverCost() (bool, Halting) {
	r.mu.Lock()
	if r.L == nil || r.L.State.Status != model.RunRunning || r.L.State.Result != nil || r.noCost() || r.meta.Settings.MaxCost <= 0 {
		r.mu.Unlock()
		return false, Halting{}
	}
	limit := r.meta.Settings.MaxCost
	var spent float64
	var running []Agent
	for i := range r.L.Agents {
		a := r.L.Agents[i]
		if a.Status == model.AgentRunning {
			running = append(running, a)
		} else if a.Cost != nil {
			spent += *a.Cost
		}
	}
	r.mu.Unlock()
	for _, a := range running {
		c := r.svc.engCostOf(a.ID)
		switch {
		case c.ok && c.usd != nil:
			spent += *c.usd
		case a.Cost != nil:
			spent += *a.Cost
		}
	}
	if spent < limit {
		return false, Halting{}
	}
	return true, Halting{Status: model.RunStalled, StalledBy: model.StalledCost, Stop: model.StopStalled,
		Reason: fmt.Sprintf("spent $%.2f, over the limit of $%.2f", spent, limit)}
}

// ---- panics ----------------------------------------------------------------------

// crashed turns a panic of an engine goroutine into a halt of its run with status error, so
// that it never ends the server.
func (e *engine) crashed(v any) {
	log.Printf("runs: internal error in the engine of %s: %v\n%s", e.r.id, v, debug.Stack())
	err := e.r.halt(Halting{Status: model.RunError, Stop: model.StopError, Reason: clip(fmt.Sprintf("internal error: %v", v), 600)})
	if err != nil && !errors.Is(err, ErrNotRunning) {
		log.Printf("runs: halt %s after an internal error: %v", e.r.id, err)
	}
}

// ---- the ticker --------------------------------------------------------------------

// engActivityEvent is the `run_activity` event: what the running agents of a run do right now. It
// is not recorded and has no version.
type engActivityEvent struct {
	Type   string                       `json:"type"` // "run_activity"
	Run    string                       `json:"run"`
	Agents map[string]model.RunActivity `json:"agents"`
}

// ticker reads the live values of the run's running agents every two seconds of the clock, for
// as long as the engine lives.
func (e *engine) ticker() {
	defer func() {
		if v := recover(); v != nil {
			e.crashed(v)
		}
	}()
	clock := e.r.svc.Clock
	for {
		select {
		case <-e.done:
			return
		case <-clock.After(engTickEvery):
		}
		e.tick()
	}
}

// tick is one look at the running agents: their activity label and tool count, a cost that
// moved (at most every 15 s per agent), the view's cost (at most every 15 s per run), and the
// cost limit (every 15 s).
func (e *engine) tick() {
	r := e.r
	if r.svc.Chats == nil {
		return
	}
	r.mu.Lock()
	var running []Agent
	if r.L != nil {
		for i := range r.L.Agents {
			if r.L.Agents[i].Status == model.AgentRunning {
				running = append(running, r.L.Agents[i])
			}
		}
	}
	r.mu.Unlock()

	now := r.svc.Clock.Now()
	type sample struct {
		live  Live
		known bool
	}
	samples := make(map[string]sample, len(running))
	for _, a := range running {
		var s sample
		if act, err := r.svc.Chats.Activity(a.ID); err == nil {
			s.live.Tools, s.live.Activity = act.Tools, engActivityLabel(act.Last)
		}
		if c := r.svc.engCostOf(a.ID); c.ok {
			s.live.PeakContext = c.peak
			if c.usd != nil {
				s.live.Cost, s.known = c.usd, true
			}
		}
		samples[a.ID] = s
	}

	changed := map[string]model.RunActivity{}
	costMoved := false
	e.liveMu.Lock()
	for id, s := range samples {
		old, had := e.liveVals[id]
		var ev model.RunActivity
		send := false
		if !had || old.Tools != s.live.Tools || old.Activity != s.live.Activity {
			ev.Activity, ev.Tools = s.live.Activity, s.live.Tools
			send = had || s.live.Tools != 0 || s.live.Activity != ""
		}
		next := s.live
		if s.known && (old.Cost == nil || *old.Cost != *s.live.Cost) {
			// A cost that moved rides along at most every 15 s per agent; until then the last
			// one sent stays the live one.
			if last, ok := e.costSent[id]; !ok || now.Sub(last) >= engCostEvery {
				e.costSent[id] = now
				ev.Cost = s.live.Cost
				ev.Activity, ev.Tools = s.live.Activity, s.live.Tools
				send, costMoved = true, true
			} else {
				next.Cost = old.Cost
			}
		}
		if s.live.PeakContext != old.PeakContext {
			ev.Activity, ev.Tools = s.live.Activity, s.live.Tools
			send = true
		}
		// The peak rides on every event of the agent.
		ev.PeakContext = s.live.PeakContext
		e.liveVals[id] = next
		if send {
			changed[id] = ev
		}
	}
	for id := range e.liveVals {
		if _, ok := samples[id]; !ok {
			delete(e.liveVals, id)
			delete(e.costSent, id)
		}
	}
	refresh := costMoved && now.Sub(e.viewCost) >= engCostEvery
	if refresh {
		e.viewCost = now
	}
	limit := now.Sub(e.limitAt) >= engCostEvery
	if limit {
		e.limitAt = now
	}
	e.liveMu.Unlock()

	if len(changed) > 0 {
		ev := engActivityEvent{Type: "run_activity", Run: r.id, Agents: changed}
		if f := r.svc.eng.onActivity; f != nil {
			f(ev)
		}
		r.svc.queue(r.id, ev)
	}
	if refresh {
		r.refresh()
	}
	if limit {
		e.checkCost()
	}
}

// engActivityLabel is a tool item as the run view shows it while the agent works: the line
// get_agent lists for the same step (toolStepLabel), at most 120 characters. "" for an item that
// is not a tool.
func engActivityLabel(it model.Item) string {
	if it.Kind != "tool" || it.Name == "" {
		return ""
	}
	return clip(toolStepLabel(it, 120), 120)
}

// stopAgent ends an agent's process the way a halt or a cancel does: the turn is interrupted
// and gets ten seconds to end, so that its cost is reported. A server that shuts down, and a
// run that is deleted, close their processes themselves.
func (e *engine) stopAgent(id string) {
	if e.quitting() || e.r.svc.Chats == nil {
		return
	}
	e.r.svc.Chats.StopOwned(id, engStopGrace)
}
