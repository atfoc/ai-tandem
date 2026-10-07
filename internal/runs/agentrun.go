package runs

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync/atomic"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
)

// This file runs one agent of a run to its result: the same life for an orchestrator turn, a
// task's work agent and a merge agent. The agent is a hidden chat object whose id follows from
// the run and the agent's name, so making it twice finds the first; the engine sends it one
// message and waits until the chat has settled.

// agentJob is one agent to run.
type agentJob struct {
	name      string // "turn-007", "T03-work", "T03-a2-merge-r2"
	role      model.AgentRole
	cwd       string
	first     func() (string, error) // the first message, built when it is needed
	wantBlock bool                   // task and merge agents end with a result block
	git       bool                   // the run uses git (the retry note differs)
	w         *engWorker             // the worker it runs for: its context and its cancel request
}

// agentResult is what an agent that ended well left. Done writes the agent's own end into the
// entry in which the caller records the result (the launch ended, status done, the cost), so
// that "the agent is done" and "the engine has its result" are one journal line: a stop between
// the two cannot exist.
type agentResult struct {
	Text  string       // the last text since the engine's message: an orchestrator's closing message
	Block *resultBlock // nil for the orchestrator
	Done  func(tx *Tx)
}

// How one launch ended.
type engLaunchEnd int

const (
	engLaunchOK        engLaunchEnd = iota
	engLaunchStopped                // the worker was stopped or its task cancelled
	engLaunchNoSession              // the session to resume does not exist: not counted, the next launch is fresh
	engLaunchFailed                 // a counted failure: retried after a backoff
	engLaunchFatal                  // the agent fails for good
)

// interrupted says why a worker must stop now: errEngCancel when its task's cancel was asked (a
// cancel wins over a stop), errEngStop when the engine's work was cancelled, nil otherwise.
func (e *engine) interrupted(w *engWorker) error {
	e.r.mu.Lock()
	req := w.cancelReq
	e.r.mu.Unlock()
	if req != nil {
		return errEngCancel
	}
	if w.ctx.Err() != nil {
		return errEngStop
	}
	return nil
}

// runAgent runs an agent until it has a result, fails for good, or its worker is stopped. The
// agent's record was made by the entry that named it. An agent whose record says failed is not
// launched again; one that is done is never passed here (its caller's flag was set in the same
// entry). There is no shortcut after a restart: an agent whose turn ended but whose result was
// not recorded is resumed with the resume message and answers again.
func (e *engine) runAgent(j agentJob) (agentResult, error) {
	r, host := e.r, e.r.svc.Chats
	id := AgentChatID(r.id, j.name)
	rec, ok := r.engAgent(id)
	switch {
	case !ok:
		return agentResult{}, fmt.Errorf("internal error: agent %s has no record", j.name)
	case rec.Status == model.AgentFailed:
		return agentResult{}, fmt.Errorf("agent %s failed: %s", j.name, rec.Error)
	case rec.Status == model.AgentDone:
		return agentResult{}, fmt.Errorf("internal error: agent %s is done and was started again", j.name)
	}
	if err := e.interrupted(j.w); err != nil {
		return agentResult{}, e.agentStopped(id, err)
	}
	meta := r.engMeta()
	if rec.Model == "" { // a record made before agents had a tier
		mc := meta.Tiers.Of(rec.Tier)
		rec.Model, rec.Effort = mc.Model, mc.Effort
	}
	if _, err := host.CreateOwned(chats.OwnedSpec{ID: id, Run: r.id, Role: j.role, Name: j.name, Agent: meta.Agent,
		Model: rec.Model, Effort: rec.Effort, Cwd: j.cwd}); err != nil {
		return agentResult{}, fmt.Errorf("the chat of agent %s could not be made: %v", j.name, err)
	}
	head := Entry{Chat: id, Task: rec.Task, Attempt: rec.Attempt, Turn: rec.Turn}
	clock := r.svc.Clock

	for {
		if err := e.interrupted(j.w); err != nil {
			return agentResult{}, e.agentStopped(id, err)
		}
		rec, _ = r.engAgent(id)
		// The backoff after a counted failure is recorded, so a restart does not shorten it.
		if wait := rec.RetryAt - clock.Now().UnixMilli(); wait > 0 {
			select {
			case <-clock.After(time.Duration(wait) * time.Millisecond):
			case <-j.w.ctx.Done():
			}
			continue
		}
		resume := rec.Resumable
		msg, err := j.first()
		if err != nil {
			return agentResult{}, err
		}
		switch {
		case resume:
			msg = engResumeMessage(msg, j.role)
		case len(rec.Launches) > 0:
			msg += engRetryNote(j.role, j.git)
		}
		fresh := !resume && len(rec.Launches) > 0
		var started int64
		if _, err := r.commit(KAgent, func(tx *Tx) error {
			a := tx.Agent(id)
			a.Launches = append(a.Launches, model.RunLaunch{N: len(a.Launches) + 1, StartedAt: tx.Now(), Resume: resume})
			a.Status, a.EndedAt, a.Error = model.AgentRunning, 0, ""
			started = tx.Now()
			tx.Head(head)
			return nil
		}); err != nil {
			return agentResult{}, err
		}

		res, end, errText := e.launch(j, id, msg, fresh, resume, started)
		switch end {
		case engLaunchOK:
			e.stopAgent(id)
			cost := r.svc.engCostOf(id)
			res.Done = func(tx *Tx) {
				a := tx.Agent(id)
				engEndLaunch(a, tx.Now(), "")
				a.Status, a.EndedAt, a.Failures, a.RetryAt = model.AgentDone, tx.Now(), 0, 0
				cost.apply(a)
			}
			return res, nil

		case engLaunchStopped:
			err := e.interrupted(j.w)
			if err == nil {
				err = errEngStop
			}
			return agentResult{}, e.agentStopped(id, err)

		case engLaunchNoSession:
			// Not counted: the next launch starts a new session with the first message.
			e.stopAgent(id)
			cost := r.svc.engCostOf(id)
			if _, err := r.commit(KAgent, func(tx *Tx) error {
				a := tx.Agent(id)
				engEndLaunch(a, tx.Now(), "no session")
				a.Resumable = false
				cost.apply(a)
				tx.Head(head)
				return nil
			}); err != nil {
				return agentResult{}, err
			}
			e.checkCost()

		default:
			// A counted failure. The process is ended first, so that every later launch starts
			// one, nothing is owed to the agent, and the resume message is true.
			e.stopAgent(id)
			cost := r.svc.engCostOf(id)
			failed := false
			if _, err := r.commit(KAgent, func(tx *Tx) error {
				a := tx.Agent(id)
				engEndLaunch(a, tx.Now(), clip(errText, engErrorMax))
				a.Failures++
				a.RetryAt = tx.Now() + int64(30*a.Failures*a.Failures)*1000
				if end == engLaunchFatal || a.Failures > meta.Settings.AgentRetries {
					a.Status, a.Error, a.EndedAt, a.RetryAt = model.AgentFailed, clip(errText, engErrorMax), tx.Now(), 0
					failed = true
				}
				cost.apply(a)
				tx.Head(head)
				return nil
			}); err != nil {
				return agentResult{}, err
			}
			e.checkCost()
			if failed {
				return agentResult{}, fmt.Errorf("agent %s failed: %s", j.name, errText)
			}
		}
	}
}

// agentStopped records that an agent was stopped by a halt (interrupted) or by its task's cancel
// (cancelled): its process is ended, its open launch is closed without an error, and its cost is
// read. It returns why.
func (e *engine) agentStopped(id string, why error) error {
	r := e.r
	e.stopAgent(id)
	cost := r.svc.engCostOf(id)
	_, err := r.commit(KAgent, func(tx *Tx) error {
		a := tx.Agent(id)
		if a == nil || a.Status == model.AgentDone || a.Status == model.AgentFailed {
			tx.Skip()
			return nil
		}
		engEndLaunch(a, tx.Now(), "")
		a.Status = model.AgentInterrupted
		if errors.Is(why, errEngCancel) {
			a.Status, a.EndedAt = model.AgentCancelled, tx.Now()
		}
		cost.apply(a)
		tx.Head(Entry{Chat: id, Task: a.Task, Attempt: a.Attempt, Turn: a.Turn})
		return nil
	})
	if err != nil && !errors.Is(err, ErrNotFound) {
		log.Printf("runs: record the stop of an agent of %s: %v", r.id, err)
	}
	return why
}

// launch is one launch of an agent: the message, the wait for the chat to settle, and for an
// agent that owes a result block up to two repair turns after a clean turn that had none. One
// deadline covers the whole launch, on the service's clock.
func (e *engine) launch(j agentJob, id, msg string, fresh, resume bool, started int64) (res agentResult, end engLaunchEnd, errText string) {
	r, host := e.r, e.r.svc.Chats
	ctx, timedOut, stop := e.deadline(j.w.ctx, started)
	defer stop()
	timeout := time.Duration(r.engMeta().Settings.AgentTimeoutSec) * time.Second

	// why turns an error of a call that ctx ended into how the launch ended.
	why := func(err error) (engLaunchEnd, string) {
		switch {
		case e.interrupted(j.w) != nil:
			return engLaunchStopped, ""
		case timedOut():
			return engLaunchFailed, "timed out after " + engDuration(timeout)
		}
		return engLaunchFailed, err.Error()
	}
	send := func(text string, o chats.OwnedSend) (engLaunchEnd, string) {
		for busy := 0; ; busy++ {
			err := e.send(ctx, id, text, o)
			switch {
			case err == nil:
				return engLaunchOK, ""
			case errors.Is(err, chats.ErrShutdown):
				// The server is going down and the chat manager was first: no process was started.
				// Not a failed launch: the engine ends as at a quit, and the agent's record is
				// left as after any quit.
				e.stop()
				return engLaunchStopped, ""
			case ctx.Err() != nil:
				return why(err)
			case errors.Is(err, chats.ErrBusy) && busy < 3:
				// The agent started a turn by itself: wait for it, then send again.
				if _, werr := host.WaitOwned(ctx, id); werr != nil {
					if ctx.Err() != nil {
						return why(werr)
					}
					e.stopAgent(id)
				}
			case errors.Is(err, agent.ErrNoSession) && resume:
				return engLaunchNoSession, ""
			default:
				return engLaunchFailed, err.Error()
			}
		}
	}

	if end, errText := send(msg, chats.OwnedSend{Fresh: fresh}); end != engLaunchOK {
		return res, end, errText
	}
	if !resume {
		// The session exists from here on: a launch after a stop resumes it.
		if _, err := r.commit(KAgent, func(tx *Tx) error {
			a := tx.Agent(id)
			a.Resumable = true
			tx.Head(Entry{Chat: id, Task: a.Task, Attempt: a.Attempt, Turn: a.Turn})
			return nil
		}); err != nil {
			return res, engLaunchFailed, err.Error()
		}
	}
	for repairs := 0; ; repairs++ {
		st, err := host.WaitOwned(ctx, id)
		if err != nil {
			end, errText := why(err)
			return res, end, errText
		}
		switch {
		case st.NoSession && resume:
			return res, engLaunchNoSession, ""
		case st.Outcome != chats.EndClean:
			// The text of a turn that did not end cleanly is never read as a result.
			errText := st.Error
			if errText == "" {
				errText = "the agent's process ended"
			}
			return res, engLaunchFailed, errText
		case !j.wantBlock:
			return agentResult{Text: st.Text}, engLaunchOK, ""
		}
		if b := parseResult(st.Text); b != nil {
			return agentResult{Text: st.Text, Block: b}, engLaunchOK, ""
		}
		if repairs == 2 {
			return res, engLaunchFatal, "finished without the result block"
		}
		if end, errText := send(engRepairMessage, chats.OwnedSend{}); end != engLaunchOK {
			return res, end, errText
		}
	}
}

// deadline is the context of one launch: it ends with parent, and when the launch's timeout has
// passed on the service's clock, counted from when the launch was recorded as started (so a
// clock that moved in between is not lost). No timeout when the setting is 0.
func (e *engine) deadline(parent context.Context, started int64) (ctx context.Context, timedOut func() bool, stop context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	sec := e.r.engMeta().Settings.AgentTimeoutSec
	if sec <= 0 {
		return ctx, func() bool { return false }, cancel
	}
	clock := e.r.svc.Clock
	var hit atomic.Bool
	left := time.Duration(started+int64(sec)*1000-clock.Now().UnixMilli()) * time.Millisecond
	// The timer is set here, not on the goroutine: it counts from the clock's time now, which the
	// goroutine would read only when it gets to run.
	timer := clock.After(left)
	go func() {
		select {
		case <-timer:
			hit.Store(true)
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx, hit.Load, cancel
}

// send is SendOwned that a stop can end: an adapter may wait for its process without a limit.
// When ctx ends first the agent's process is closed at once, which makes SendOwned return.
func (e *engine) send(ctx context.Context, id, text string, o chats.OwnedSend) error {
	host := e.r.svc.Chats
	errc := make(chan error, 1)
	go func() {
		defer func() {
			if v := recover(); v != nil {
				errc <- fmt.Errorf("internal error: %v", v)
			}
		}()
		errc <- host.SendOwned(id, text, o)
	}()
	return e.sent(ctx, id, errc)
}

// sent is send's wait for the result of SendOwned, which comes on errc (buffered).
func (e *engine) sent(ctx context.Context, id string, errc <-chan error) error {
	host := e.r.svc.Chats
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	if e.quitting() {
		// The server closes the process itself: chats.Manager.Shutdown closes the one this message
		// has started by then, and refuses the message (chats.ErrShutdown) when it comes later.
		// A result that is there already is taken all the same: a message the agent's chat has
		// accepted is recorded as sent, or the next server would send it again. SendOwned may be
		// about to return it, so the wait goes on for a short time.
		select {
		case err := <-errc:
			return err
		case <-time.After(engStopGrace):
		}
		return ctx.Err()
	}
	host.StopOwned(id, 0)
	select {
	case <-errc:
	case <-time.After(3 * engStopGrace):
		log.Printf("runs: a message to agent chat %s of %s did not return after its process was closed", id, e.r.id)
	}
	return ctx.Err()
}
