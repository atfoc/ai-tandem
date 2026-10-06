package runs

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"ai-whiteboard/internal/model"
)

// This file is the scheduler of a live run: one goroutine that makes a pass whenever the run's
// recorded state changed (commit signals run.wake), a worker returned, or a second of the clock
// went by.

// loop is the scheduler's goroutine. Its first act for a run with git is to open the repository
// and make the integration checkout. A panic in it halts the run with status error; it then
// waits for the workers and writes run_halted itself, since nobody else would.
func (e *engine) loop() {
	r := e.r
	defer func() {
		e.stopWork()
		e.wg.Wait()
		r.mu.Lock()
		if r.eng == e {
			r.eng = nil
		}
		r.mu.Unlock()
		es := &r.svc.eng
		es.mu.Lock()
		delete(es.active, e)
		es.mu.Unlock()
		close(e.done)
	}()
	defer func() {
		if v := recover(); v != nil {
			e.crashed(v)
			e.stopWork()
			e.wg.Wait()
			def := Halting{Status: model.RunError, Stop: model.StopError, Reason: clip(fmt.Sprintf("internal error: %v", v), 600)}
			if err := r.engWriteHalted(def, 0); err != nil {
				log.Printf("runs: halt %s after an internal error: %v", r.id, err)
			}
		}
	}()

	if err := e.prepare(); err != nil && e.work.Err() == nil {
		e.haltError(err.Error())
	}
	clock := r.svc.Clock
	tick := clock.After(time.Second)
	for {
		if e.pass() {
			return
		}
		select {
		case <-r.wake:
		case <-tick:
			tick = clock.After(time.Second)
		case <-e.quit:
		}
	}
}

// haltError halts the run with status error.
func (e *engine) haltError(reason string) {
	err := e.r.halt(Halting{Status: model.RunError, Stop: model.StopError, Reason: clip(reason, 600)})
	if err != nil && !errors.Is(err, ErrNotRunning) {
		log.Printf("runs: halt %s (%s): %v", e.r.id, reason, err)
	}
}

// prepare is what every engine start does before its first pass: it writes the run's readable
// copies (ctxSync) and, in a run with git, checks that git is new enough, opens the repository
// from the folder the run recorded, and makes the integration checkout (idempotent).
func (e *engine) prepare() error {
	r := e.r
	g := r.engGit()
	// The copies of the goal, the briefs and the reports that agents can read, in the run's work
	// folder, which a run without git has for them alone. Without them a prompt carries the text.
	if err := r.ctxSync(); err != nil {
		log.Printf("runs: the readable copies of %s: %v", r.id, err)
	}
	if g == nil {
		return nil
	}
	if err := r.svc.eng.checkGit(e.work); err != nil {
		return err
	}
	// Opened again at every engine start: the folder may have changed while the run was halted.
	repo, err := r.svc.openRepo(e.work, g.Repo)
	if err != nil {
		return fmt.Errorf("git cannot use %s any more: %v", g.Repo, err)
	}
	e.repo = repo
	es := &r.svc.eng
	es.mu.Lock()
	es.repos[g.Repo] = repo
	es.mu.Unlock()
	if err := os.MkdirAll(r.svc.Store.P.RunWorkDir(r.id), 0o700); err != nil {
		return fmt.Errorf("the folder for the run's checkouts could not be made: %v", err)
	}
	r.mergeMu.Lock()
	defer r.mergeMu.Unlock()
	if err := repo.EnsureWorktree(e.work, r.engIntDir(g), engIntBranch(r.id, g), g.BaseRef); err != nil {
		return fmt.Errorf("the integration checkout could not be made: %v", err)
	}
	return nil
}

var engGitVersion = regexp.MustCompile(`(\d+)\.(\d+)`)

// checkGit refuses a git older than 2.27: the merge options the run's git layer uses need it.
func (e *engines) checkGit(ctx context.Context) error {
	e.mu.Lock()
	ok := e.gitOK
	e.mu.Unlock()
	if ok {
		return nil
	}
	cmd := exec.CommandContext(ctx, "git", "version")
	cmd.Env = append(os.Environ(), e.s.GitEnv...)
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("git does not run on this machine (%v): a run in a git repository needs git 2.27 or newer", err)
	}
	if err := engGitTooOld(string(out)); err != nil {
		return err
	}
	e.mu.Lock()
	e.gitOK = true
	e.mu.Unlock()
	return nil
}

// engGitTooOld reads the answer of `git version` and says when it is older than 2.27.
func engGitTooOld(out string) error {
	m := engGitVersion.FindStringSubmatch(out)
	if m == nil {
		return fmt.Errorf("git answered %q to `git version`: a run in a git repository needs git 2.27 or newer", clip(strings.TrimSpace(out), 80))
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	if major < 2 || major == 2 && minor < 27 {
		return fmt.Errorf("git %s.%s is too old for runs: a run in a git repository needs git 2.27 or newer", m[1], m[2])
	}
	return nil
}

// pass is one pass of the scheduler; it reports that the engine is over.
func (e *engine) pass() bool {
	r := e.r
	if e.quitting() {
		return true // a shutdown or a delete: no entry is written here
	}
	r.mu.Lock()
	st := r.L.State
	busy := len(e.workers) > 0 || e.turn != nil
	r.mu.Unlock()

	switch {
	case !st.Status.Live():
		return true
	case st.Status == model.RunStopping:
		// Nothing starts while the run is stopping. When the last worker has let go the run is
		// halted, or finished when the stop came after finish_run.
		if busy {
			return false
		}
		var err error
		if st.Result != nil {
			err = e.finish()
		} else {
			err = r.engWriteHalted(Halting{}, 0)
		}
		if err != nil {
			log.Printf("runs: end the halt of %s: %v", r.id, err)
			return false
		}
		return true
	case st.Result != nil:
		if busy {
			return false
		}
		if err := e.finish(); err != nil {
			log.Printf("runs: finish %s: %v", r.id, err)
			return false
		}
		return true
	}

	e.releaseChats()
	e.recoverTasks()
	e.startTasks()
	e.startTurn()
	return false
}

// finish ends the run whose result is set. The workers' context may be cancelled by then (a stop
// that came after finish_run), so the last git commands get one of their own.
func (e *engine) finish() error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	return e.r.engFinish(ctx, e.repo)
}

// releaseChats ends the holds of chats whose reply is over.
func (e *engine) releaseChats() {
	r := e.r
	r.mu.Lock()
	var held []string
	seen := map[string]bool{}
	for i := range r.L.Tasks {
		t := &r.L.Tasks[i]
		if !t.State().Waiting() {
			continue
		}
		for _, h := range t.HeldBy {
			if h.Chat != "" && !seen[h.Chat] {
				seen[h.Chat] = true
				held = append(held, h.Chat)
			}
		}
	}
	r.mu.Unlock()
	idle := map[string]bool{}
	for _, c := range held {
		if r.svc.Chats == nil || r.svc.Chats.Idle(c) {
			idle[c] = true
		}
	}
	if len(idle) == 0 {
		return
	}
	_, err := r.commit(KTaskWait, func(tx *Tx) error {
		changed := false
		for _, rec := range tx.L().Tasks {
			if !rec.State().Waiting() {
				continue
			}
			keep := rec.HeldBy[:0:0]
			for _, h := range rec.HeldBy {
				if h.Chat == "" || !idle[h.Chat] {
					keep = append(keep, h)
				}
			}
			if len(keep) != len(rec.HeldBy) {
				tx.Task(rec.ID).HeldBy = keep
				changed = true
			}
		}
		if !changed {
			tx.Skip()
		}
		return nil
	})
	if err != nil {
		log.Printf("runs: release the chat holds of %s: %v", r.id, err)
	}
}

// recoverTasks gives a worker to every task that is in setup, work or merge and has none,
// whatever maxParallel says: tasks a halt left active go on before new ones start. It also
// discards the checkout of every attempt that ended while no engine ran (a task cancelled while
// the run was halted).
func (e *engine) recoverTasks() {
	r := e.r
	type ended struct {
		task    string
		attempt int
	}
	var leftovers []ended
	r.mu.Lock()
	for i := range r.L.Tasks {
		t := &r.L.Tasks[i]
		if t.State().Active() && e.workers[t.ID] == nil {
			e.spawnTask(t.ID)
		}
		for _, a := range t.Attempts {
			if a.Outcome != "" && a.Worktree != "" {
				leftovers = append(leftovers, ended{t.ID, a.N})
			}
		}
	}
	r.mu.Unlock()
	for _, l := range leftovers {
		e.discardEnded(l.task, l.attempt)
	}
}

// spawnTask registers and starts the worker of a task. r.mu held.
func (e *engine) spawnTask(tid string) {
	ctx, cancel := context.WithCancel(e.work)
	w := &engWorker{ctx: ctx, cancel: cancel, done: make(chan struct{})}
	e.workers[tid] = w
	e.wg.Add(1)
	go e.taskWorker(tid, w)
}

// startTasks gives slots to the tasks that are ready, in creation order, up to maxParallel
// active tasks. In a run without git nothing isolates writing tasks, so only one of them is
// active at a time.
func (e *engine) startTasks() {
	r := e.r
	r.mu.Lock()
	max := r.meta.Settings.MaxParallel
	g := clonePtr(r.L.State.Git)
	active, writing := 0, false
	for i := range r.L.Tasks {
		if t := &r.L.Tasks[i]; t.State().Active() {
			active++
			writing = writing || t.Writes
		}
	}
	var picks []string
	for i := range r.L.Tasks {
		if len(picks) >= max-active {
			break
		}
		t := &r.L.Tasks[i]
		if t.State() != model.TaskSlot {
			continue
		}
		if g == nil && t.Writes {
			if writing {
				continue
			}
			writing = true
		}
		picks = append(picks, t.ID)
	}
	r.mu.Unlock()
	if len(picks) == 0 {
		return
	}

	base := ""
	if g != nil {
		// A task starts from the integration branch as it is between two merges.
		r.mergeMu.Lock()
		defer r.mergeMu.Unlock()
		var err error
		if base, err = e.repo.Resolve(e.work, engIntBranch(r.id, g)); err != nil {
			if e.work.Err() == nil {
				e.haltError(fmt.Sprintf("the integration branch could not be read: %v", err))
			}
			return
		}
	}
	for _, tid := range picks {
		_, err := r.commit(KTaskStarted, func(tx *Tx) error {
			t := tx.Task(tid)
			if t == nil || t.State() != model.TaskSlot || tx.State().Status != model.RunRunning || tx.State().Result != nil {
				tx.Skip()
				return nil
			}
			n := 0
			for _, o := range tx.L().Tasks {
				if o.State().Active() {
					n++
					if g == nil && t.Writes && o.Writes {
						tx.Skip()
						return nil
					}
				}
			}
			if n >= max {
				tx.Skip()
				return nil
			}
			a := &t.Attempts[len(t.Attempts)-1]
			a.Phases = append(a.Phases, model.RunPhase{K: model.TaskSetup, T: tx.Now()})
			a.StartedAt = tx.Now()
			if g != nil {
				prefix := AttemptPrefix(tid, a.N)
				a.Base = base
				a.Worktree = filepath.Join(r.svc.Store.P.RunWorkDir(r.id), prefix)
				if t.Writes {
					a.Branch = engTaskBranch(r.id, prefix)
				}
			}
			tx.State().IdleStreak = 0
			tx.Head(Entry{Task: tid, Attempt: a.N})
			tx.After(func() { e.spawnTask(tid) })
			return nil
		})
		if err != nil {
			log.Printf("runs: start %s of %s: %v", tid, r.id, err)
		}
	}
}
