package chats

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/model"
)

// The retry and the pause of a subagent (retrysub.go, design D8, D9, D11).

// rsFail ends the turn of a subagent's process a with a temporary error. The runner lets that
// process go on it, so no event can follow to prove the failure was handled: the caller waits for
// what it changes (rsRetrying, or the paused record).
func rsFail(t *testing.T, a *fakeAgent) {
	t.Helper()
	select {
	case a.ch <- rcFail():
	case <-time.After(5 * time.Second):
		t.Fatal("the runner did not take the failure")
	}
}

// rsRetrying waits for subagent sid to wait for attempt n, and returns its record.
func (e *env) rsRetrying(id, sid string, n int) model.Subagent {
	e.t.Helper()
	waitFor(e.t, "the subagent to wait for its attempt", func() bool { return e.sub(id, sid).Retry.Attempt == n && e.rsWait(id, sid) != nil })
	return e.sub(id, sid)
}

// rsWait is the retry of subagent sid, nil when it has none.
func (e *env) rsWait(id, sid string) *retryWait {
	e.t.Helper()
	c, err := e.m.lock(id)
	if err != nil {
		e.t.Fatal(err)
	}
	defer c.mu.Unlock()
	return c.subs[sid].retry
}

// rsFire runs the timer of subagent sid's retry now, as it would when it is due.
func (e *env) rsFire(id, sid string) {
	e.t.Helper()
	w := e.rsWait(id, sid)
	if w == nil {
		e.t.Fatal("no retry to fire")
	}
	c, err := e.m.lock(id)
	if err != nil {
		e.t.Fatal(err)
	}
	c.mu.Unlock()
	e.m.subRetryFire(c, sid, w)
}

// rsGateFree waits for the gate to hold no slot and no queued attempt: no path leaves one behind.
func (e *env) rsGateFree() {
	e.t.Helper()
	waitFor(e.t, "the gate to be free", func() bool { h, q := e.m.retryGate.counts(); return h == 0 && q == 0 })
}

// rsNoSpawn checks that no process is started for a while: ten times the waits of fastRetries.
func (e *env) rsNoSpawn(n int) {
	e.t.Helper()
	time.Sleep(200 * time.Millisecond)
	if got := e.claude.count(); got != n {
		e.t.Fatalf("%d processes, want %d: a cancelled retry started one", got, n)
	}
}

// rsWaitSub waits until subagent sid satisfies ok and returns the record that did.
func (e *env) rsWaitSub(id, sid, what string, ok func(model.Subagent) bool) model.Subagent {
	e.t.Helper()
	var got model.Subagent
	waitFor(e.t, what, func() bool { got = e.sub(id, sid); return ok(got) })
	return got
}

// rsLines are the lines of the log that belong to subagent sid of chat id, without their prefix.
func rsLines(lines []string, id, sid string) []string {
	pre := fmt.Sprintf("chats: retry %s sub=%s ", id, sid)
	var out []string
	for _, l := range lines {
		if strings.HasPrefix(l, pre) {
			out = append(out, strings.TrimPrefix(l, pre))
		}
	}
	return out
}

// rsSpawner is a Claude spawner whose resumes fail while fail is set; everything else is the
// inner spawner's.
type rsSpawner struct {
	inner agent.Spawner
	fail  atomic.Bool
}

func (s *rsSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	if o.Resume && s.fail.Load() {
		return nil, fmt.Errorf("no such program")
	}
	return s.inner.Spawn(o)
}

// Scenario 1: a lead's turn fails with a login error and the next attempt gets a reply. It was
// running all along, its chunk was never stopped, and its result reaches the chat's agent once.
func TestSubRetryLoginThenReply(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	hourRetries(e)
	id, parent := e.nested(2)
	l, pl := e.child(id, "", "lead")
	k, pk := e.child(id, l.ID, "chunk")
	handed := len(parent.sent())

	rsFail(t, pl)
	got := e.rsRetrying(id, l.ID, 1)
	want := model.Retry{Attempt: 1, Of: retryAttempts, At: testNow + time.Hour.Milliseconds(), Kind: "login", Error: rcErr}
	if got.Status != model.SubRunning || got.Retry != want || got.Delivery != "" {
		t.Fatalf("the retrying lead: %+v", got)
	}
	if f := e.subFile(id, l.ID); f.Retry != want {
		t.Fatalf("subagent.json: %+v", f)
	}
	closed(t, "the failed process", pl)
	if !e.revoked(pl) {
		t.Fatal("the failed process's token still resolves")
	}
	if s := e.sub(id, k.ID); s.Status != model.SubRunning || agentClosed(pk) {
		t.Fatalf("the chunk: %+v (closed %v)", s, agentClosed(pk))
	}
	if n := len(parent.sent()); n != handed {
		t.Fatalf("the chat's agent was handed %d messages", n-handed)
	}
	if got := notes(e.subItems(id, l.ID), "error"); len(got) != 1 || got[0] != retryNote("login", rcErr, 1, time.Hour) {
		t.Fatalf("the lead's error notes: %q", got)
	}

	e.rsFire(id, l.ID)
	n := waitChild(t, e.claude, 4) // the chat's agent, the lead, the chunk, the attempt
	if !n.opts.Resume || n.opts.SessionID != l.Session || l.Session == "" || e.revoked(n) {
		t.Fatalf("the attempt's process: %+v", n.opts)
	}
	waitFor(t, "the attempt's message", func() bool { return len(n.sent()) == 1 })
	if msg := n.sent()[0]; len(msg) != 1 || msg[0].Text != carryOnRetryBlock("login", rcErr) {
		t.Fatalf("the attempt's message: %q", texts(msg))
	}
	n.emit(t, agent.Event{Kind: agent.EvText, Text: "carrying on"})
	if s := e.sub(id, l.ID); s.Retry != (model.Retry{}) || s.Status != model.SubRunning {
		t.Fatalf("the lead after the reply: %+v", s)
	}
	e.rsGateFree()

	n.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	if s := e.sub(id, l.ID); !s.Waiting {
		t.Fatalf("the lead does not wait on its chunk: %+v", s)
	}
	e.finish(pk, "chunk report")
	waitFor(t, "the chunk's result to reach the lead", func() bool { return carriedTimes(n.sent(), k.ID) == 1 })
	e.finish(n, "lead report")
	waitFor(t, "the lead's result to reach the chat's agent", func() bool { return carriedTimes(parent.sent(), l.ID) == 1 })
	if s := e.sub(id, l.ID); s.Status != model.SubCompleted || s.Error != "" {
		t.Fatalf("the finished lead: %+v", s)
	}
	time.Sleep(50 * time.Millisecond)
	if got := carriedTimes(parent.sent(), l.ID); got != 1 {
		t.Fatalf("the lead's result was handed %d times", got)
	}
}

// Scenario 2: five failures in a row pause the lead. Its process is closed, its chunk runs on and
// leaves its result owed to it, the cap no longer counts it, and the chat's agent hears nothing.
func TestSubPausedAfterFourAttempts(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	fastRetries(e)
	id, parent := e.nested(2)
	l, pl := e.child(id, "", "lead")
	k, pk := e.child(id, l.ID, "chunk")
	handed := len(parent.sent())
	procs := []*fakeAgent{pl}

	rsFail(t, pl)
	for i := 1; i <= retryAttempts; i++ {
		n := waitChild(t, e.claude, 3+i)
		waitFor(t, "the attempt's message", func() bool { return len(n.sent()) == 1 })
		procs = append(procs, n)
		rsFail(t, n)
	}
	waitFor(t, "the lead to pause", func() bool { return e.sub(id, l.ID).Status == model.SubPaused })
	got := e.sub(id, l.ID)
	if got.Error != rcErr || got.ErrorKind != "login" || got.Cause != model.CauseRetriesFailed || got.Retry != (model.Retry{}) ||
		got.Waiting || got.Delivery != "" || got.Ended == 0 {
		t.Fatalf("the paused lead: %+v", got)
	}
	if f := e.subFile(id, l.ID); f != got {
		t.Fatalf("subagent.json %+v differs from %+v", f, got)
	}
	closed(t, "every process of the lead", procs...)
	items := e.subItems(id, l.ID)
	errs := notes(items, "error")
	if len(errs) != retryAttempts+1 || errs[retryAttempts] != rcErr || errs[0] != retryNote("login", rcErr, 1, 20*time.Millisecond) {
		t.Fatalf("the lead's error notes: %q", errs)
	}
	if muted := notes(items, "muted"); len(muted) != 1 || muted[0] != pausedNote() {
		t.Fatalf("the lead's muted notes: %q", muted)
	}

	if s := e.sub(id, k.ID); s.Status != model.SubRunning || agentClosed(pk) {
		t.Fatalf("the chunk: %+v", s)
	}
	c, err := e.m.lock(id)
	if err != nil {
		t.Fatal(err)
	}
	running := runningAppSubs(c)
	c.mu.Unlock()
	if running != 1 {
		t.Fatalf("%d running subagents counted, want the chunk alone", running)
	}
	e.finish(pk, "chunk report")
	if s := e.sub(id, k.ID); s.Status != model.SubCompleted || s.Delivery != model.SubOwed {
		t.Fatalf("the chunk's result: %+v", s)
	}
	if n := len(parent.sent()); n != handed {
		t.Fatalf("the chat's agent was handed %d messages", n-handed)
	}
	e.rsGateFree()
}

// Scenario 6: an error that is not temporary ends a lead as it did before: completed with the
// error, its chunk stopped, its result owed to the chat's agent, and nothing tried again.
func TestNonTemporaryErrorEndsSubAsToday(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	fastRetries(e)
	id, _ := e.nested(2)
	l, pl := e.child(id, "", "lead")
	k, pk := e.child(id, l.ID, "chunk")

	pl.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "billing error"})
	e.m.handoffs.Wait()
	got := e.sub(id, l.ID)
	if got.Status != model.SubCompleted || got.Error != "billing error" || got.Retry != (model.Retry{}) ||
		(!got.Delivery.Owed() && got.Delivery != model.SubSent) {
		t.Fatalf("the lead: %+v", got)
	}
	if s := e.sub(id, k.ID); s.Status != model.SubStopped || s.Cause != model.CauseParent {
		t.Fatalf("the chunk: %+v", s)
	}
	closed(t, "the processes", pl, pk)
	e.rsNoSpawn(3)
	e.rsGateFree()
}

// Goal 2.8: stopping a subagent between its attempts cancels its retry: nothing starts later.
func TestStopSubagentDuringBackoff(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	hourRetries(e)
	id, _ := e.idleParent()
	l, pl := e.child(id, "", "lead")
	rsFail(t, pl)
	e.rsRetrying(id, l.ID, 1)

	if err := e.m.StopSubagent(id, l.ID); err != nil {
		t.Fatal(err)
	}
	got := e.sub(id, l.ID)
	if got.Status != model.SubStopped || got.Cause != model.CauseStopTool || got.Retry != (model.Retry{}) {
		t.Fatalf("the stopped lead: %+v", got)
	}
	if e.rsWait(id, l.ID) != nil {
		t.Fatal("the retry is still there")
	}
	fastRetries(e)
	e.rsNoSpawn(2)
	e.rsGateFree()
}

// Scenario 8: Interrupt while the chat's agent and its lead both wait for an attempt cancels both:
// the chat is ready, the lead stopped by the person, and nothing starts later.
func TestStopDuringBackoffCancelsEveryRetry(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	hourRetries(e)
	id, parent := e.retryChat()
	l, pl := e.child(id, "", "lead")
	rsFail(t, pl)
	e.rsRetrying(id, l.ID, 1)
	parent.emit(t, rcFail())
	if s := e.rcState(id); !s.retrying || s.status != model.StatusRetrying {
		t.Fatalf("the chat: %+v", s)
	}

	if err := e.m.Interrupt(id); err != nil {
		t.Fatal(err)
	}
	if s := e.rcState(id); s.retrying || s.status != model.StatusReady {
		t.Fatalf("the chat after Interrupt: %+v", s)
	}
	if s := e.sub(id, l.ID); s.Status != model.SubStopped || s.Cause != model.CausePerson || s.Retry != (model.Retry{}) {
		t.Fatalf("the lead after Interrupt: %+v", s)
	}
	fastRetries(e)
	e.rsNoSpawn(2)
	e.rsGateFree()
}

// Scenario 9: the server stops while a lead waits for an attempt. After the next start it is
// paused with its session and reason, what was owed to it is still owed, and a resume hands it over.
func TestShutdownDuringBackoffPauses(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	hourRetries(e)
	id, _ := e.nested(2)
	l, pl := e.child(id, "", "lead")
	k, pk := e.child(id, l.ID, "chunk")
	e.finish(pk, "chunk report") // the lead is in its turn: the result waits for it
	rsFail(t, pl)
	e.rsRetrying(id, l.ID, 1)

	e.m.Shutdown()
	e.rsGateFree()
	if f := e.subFile(id, l.ID); f.Status != model.SubPaused || f.Cause != model.CauseRetryingAtStop {
		t.Fatalf("subagent.json after Shutdown: %+v", f)
	}
	e.boot()
	got := e.sub(id, l.ID)
	if got.Status != model.SubPaused || got.Cause != model.CauseRetryingAtStop || got.Session != l.Session || got.Session == "" ||
		got.Error != rcErr || got.ErrorKind != "login" || got.Retry != (model.Retry{}) {
		t.Fatalf("the lead after the restart: %+v", got)
	}
	if s := e.sub(id, k.ID); s.Delivery != model.SubOwed {
		t.Fatalf("the chunk's result after the restart: %+v", s)
	}

	if _, err := e.m.ResumeSubagent(id, l.ID); err != nil {
		t.Fatal(err)
	}
	n := waitChild(t, e.claude, 1)
	waitFor(t, "the resume's message", func() bool { return len(n.sent()) == 1 })
	if msg := n.sent()[0]; !n.opts.Resume || n.opts.SessionID != l.Session || len(deliveredSids(msg)) != 1 || deliveredSids(msg)[0] != k.ID {
		t.Fatalf("the resume: %+v, %q", n.opts, texts(msg))
	}
}

// Goal 3.6 after a crash: a record that is running with a retry is paused when it is loaded, and
// one that is running without is stopped as before.
func TestCrashDuringBackoffPauses(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(2)
	l, _ := e.child(id, "", "lead")
	k, _ := e.child(id, "", "another lead")
	sa := e.subFile(id, l.ID)
	sa.Retry = model.Retry{Attempt: 2, Of: retryAttempts, At: testNow + 1000, Kind: "overloaded", Error: "Overloaded"}
	raw, err := json.Marshal(sa)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.subDir(id, l.ID), "subagent.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}

	e.boot()
	got := e.sub(id, l.ID)
	if got.Status != model.SubPaused || got.Cause != model.CauseRetryingAtStop || got.Error != "Overloaded" ||
		got.ErrorKind != "overloaded" || got.Retry != (model.Retry{}) || got.Session != l.Session || got.Ended == 0 {
		t.Fatalf("the lead that was retrying: %+v", got)
	}
	if f := e.subFile(id, l.ID); f != got {
		t.Fatalf("subagent.json %+v differs from %+v", f, got)
	}
	if s := e.sub(id, k.ID); s.Status != model.SubStopped || s.Cause != model.CauseRestart {
		t.Fatalf("the lead that ran: %+v", s)
	}
}

// D10 through pauseSub: a lead that waits only on its chunk is told at once when the chunk's
// retries run out, in a message that lists it.
func TestPausedLeadToldToItsWaitingParent(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	fastRetries(e)
	id, _ := e.nested(3)
	p, pp := e.child(id, "", "lead")
	l, pl := e.child(id, p.ID, "chunk")
	pp.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	if s := e.sub(id, p.ID); !s.Waiting {
		t.Fatalf("the lead does not wait: %+v", s)
	}

	rsFail(t, pl)
	for i := 1; i <= retryAttempts; i++ {
		n := waitChild(t, e.claude, 3+i)
		waitFor(t, "the attempt's message", func() bool { return len(n.sent()) == 1 })
		rsFail(t, n)
	}
	waitFor(t, "the lead to be told", func() bool { return len(pp.sent()) == 2 })
	msg := pp.sent()[1]
	if len(msg) != 1 || !strings.HasPrefix(msg[0].Text, "<"+pausedListTag+">") || !strings.Contains(msg[0].Text, sidTag(l.ID)) {
		t.Fatalf("the lead's message: %q", texts(msg))
	}
	if !e.listedBy(id, p.ID, l.ID) {
		t.Fatal("the paused chunk is not marked as listed")
	}
	if s := e.sub(id, p.ID); s.Status != model.SubRunning || s.Waiting {
		t.Fatalf("the lead after the message: %+v", s)
	}
	e.rsGateFree()
}

// D8: a result that becomes owed to a lead between its attempts goes with the attempt's message,
// after the carry-on block, and is then sent.
func TestSubRetryCarriesOwedResults(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	hourRetries(e)
	id, _ := e.nested(2)
	l, pl := e.child(id, "", "lead")
	k, pk := e.child(id, l.ID, "chunk")
	rsFail(t, pl)
	e.rsRetrying(id, l.ID, 1)
	e.finish(pk, "chunk report")
	if s := e.sub(id, k.ID); s.Delivery != model.SubOwed {
		t.Fatalf("the chunk's result during the backoff: %+v", s)
	}

	e.rsFire(id, l.ID)
	n := waitChild(t, e.claude, 4)
	waitFor(t, "the attempt's message", func() bool { return len(n.sent()) == 1 })
	msg := n.sent()[0]
	if len(msg) != 2 || msg[0].Text != carryOnRetryBlock("login", rcErr) || !strings.HasPrefix(msg[1].Text, "<"+subResultsTag+">") ||
		len(deliveredSids(msg)) != 1 || deliveredSids(msg)[0] != k.ID {
		t.Fatalf("the attempt's message: %q", texts(msg))
	}
	if s := e.sub(id, k.ID); s.Delivery != model.SubSent {
		t.Fatalf("the chunk's result after the attempt started: %+v", s)
	}

	// The attempt fails too before it answers: the result is owed again, and the next one carries it.
	fastRetries(e)
	rsFail(t, n)
	n2 := waitChild(t, e.claude, 5)
	waitFor(t, "the next attempt's message", func() bool { return len(n2.sent()) == 1 })
	if got := deliveredSids(n2.sent()[0]); len(got) != 1 || got[0] != k.ID {
		t.Fatalf("the next attempt's message: %q", texts(n2.sent()[0]))
	}
	n2.emit(t, agent.Event{Kind: agent.EvText, Text: "got it"})
	e.rsGateFree()
}

// Design D5, goal 2.3: the pause before attempt n is retryWaits[n-1], and the fifth failure in a
// row pauses the subagent. The record's due time is checked on a clock that stands still with the
// pauses an hour long, so that no timer can change it between the failure and the read; the timer
// itself is checked with real pauses of milliseconds.
func TestSubRetryWaitsFollowTheSchedule(t *testing.T) {
	t.Parallel()
	t.Run("due", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t)
		e.m.retryWaits = [retryAttempts]time.Duration{10 * time.Minute, 20 * time.Minute, 30 * time.Minute, 40 * time.Minute}
		e.m.retryJitter = func(d time.Duration) time.Duration { return d }
		id, _ := e.idleParent()
		sa, p := e.child(id, "", "work")
		for n := 1; n <= retryAttempts; n++ {
			rsFail(t, p)
			wait := e.m.retryWaits[n-1]
			got := e.rsWaitSub(id, sa.ID, fmt.Sprintf("attempt %d to be waited for", n), func(s model.Subagent) bool { return s.Retry.Attempt == n })
			want := model.Retry{Attempt: n, Of: retryAttempts, At: e.clock.Load() + wait.Milliseconds(), Kind: "login", Error: rcErr}
			if got.Status != model.SubRunning || got.Retry != want {
				t.Fatalf("after failure %d: %+v, want running with retry %+v", n, got, want)
			}
			if f := e.subFile(id, sa.ID); f.Retry != want {
				t.Fatalf("after failure %d: subagent.json retry %+v, want %+v", n, f.Retry, want)
			}
			closed(t, fmt.Sprintf("process %d", n), p)
			e.rsFire(id, sa.ID)
			p = waitChild(t, e.claude, n+2) // the chat's agent, the subagent, then the attempts
			if sess := e.sub(id, sa.ID).Session; !p.opts.Resume || sess == "" || p.opts.SessionID != sess {
				t.Fatalf("attempt %d: %+v, want a resume of the recorded session", n, p.opts)
			}
			if got := e.sub(id, sa.ID).Retry; got.Attempt != n || got.At > e.clock.Load() {
				t.Fatalf("attempt %d runs: retry %+v, want its due time in the past", n, got)
			}
		}
		rsFail(t, p)
		got := e.rsWaitSub(id, sa.ID, "the subagent to be paused", func(s model.Subagent) bool { return s.Status == model.SubPaused })
		if got.Retry != (model.Retry{}) || got.ErrorKind != "login" || got.Cause != model.CauseRetriesFailed {
			t.Fatalf("after the fifth failure: %+v, want it paused", got)
		}
		e.rsGateFree()
	})

	t.Run("timer", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t)
		e.m.retryWaits = [retryAttempts]time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 30 * time.Millisecond, 40 * time.Millisecond}
		e.m.retryJitter = func(d time.Duration) time.Duration { return d }
		id, _ := e.idleParent()
		sa, p := e.child(id, "", "work")
		for n := 1; n <= retryAttempts; n++ {
			begin := time.Now()
			rsFail(t, p)
			p = waitChild(t, e.claude, n+2)
			if took, wait := time.Since(begin), e.m.retryWaits[n-1]; took < wait {
				t.Fatalf("attempt %d started after %v, before its pause of %v", n, took, wait)
			}
			if !p.opts.Resume {
				t.Fatalf("attempt %d: %+v, want a resume", n, p.opts)
			}
		}
		rsFail(t, p)
		if got := e.rsWaitSub(id, sa.ID, "the subagent to be paused", func(s model.Subagent) bool { return s.Status == model.SubPaused }); got.Retry != (model.Retry{}) {
			t.Fatalf("after the fifth failure: %+v, want it paused", got)
		}
		if n := e.claude.count(); n != 2+retryAttempts {
			t.Fatalf("%d processes, want the chat's agent, the subagent and %d attempts", n, retryAttempts)
		}
		e.rsGateFree()
	})
}

// Goal scenario 5: twenty subagents that fail with a login error at once are started again at most
// two at a time, each exactly once, and every result reaches the chat's agent.
func TestTwentyLoginFailuresGoThroughTheGate(t *testing.T) {
	t.Parallel()
	const kids = 20
	e, f := fakeEnv(t, model.Claude)
	fastRetries(e)
	var inside, maxInside atomic.Int32
	f.Script(func(tn *agenttest.Turn) {
		if !tn.Opts.Subagent {
			tn.Say("ok")
			return
		}
		if !tn.Opts.Resume {
			tn.FailTemp(agent.TempLogin, rcErr)
			return
		}
		n := inside.Add(1)
		for m := maxInside.Load(); n > m && !maxInside.CompareAndSwap(m, n); m = maxInside.Load() {
		}
		time.Sleep(30 * time.Millisecond)
		inside.Add(-1) // before the answer, which frees the slot
		tn.Say("ok")
	})
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "delegate", "")
	waitFor(t, "the first turn to end", func() bool { return e.view(v.ID).Usage.Turns == 1 })
	e.limits(v.ID, 1, 30)

	sids := make([]string, kids)
	for i := range sids {
		sids[i] = e.spawn(v.ID, SpawnSubRequest{Prompt: fmt.Sprintf("work %d", i)}).ID
	}
	waitFor(t, "every subagent to complete", func() bool {
		done := 0
		for _, s := range e.subs(v.ID) {
			if s.Status == model.SubCompleted {
				done++
			}
		}
		return done == kids
	})
	if got := maxInside.Load(); got < 1 || got > 2 {
		t.Fatalf("%d attempts ran at once, want 1 or 2", got)
	}
	for _, sid := range sids {
		if got := len(spawnsOf(f, v.ID+"/subagents/"+sid)); got != 2 {
			t.Errorf("subagent %s was started %d times, want the original and one attempt", sid, got)
		}
		s := e.sub(v.ID, sid)
		if s.Retry != (model.Retry{}) || s.Error != "" {
			t.Errorf("subagent %s: %+v, want no retry and no error", sid, s)
		}
		if s.Delivery != model.SubOwed && s.Delivery != model.SubOwedAgain && s.Delivery != model.SubSent {
			t.Errorf("subagent %s: delivery %q, want its result owed or handed to the chat's agent", sid, s.Delivery)
		}
	}
	e.rsGateFree()
}

// Goal 2.9, design D17: the log has the lines of a subagent's retry, with the chat's id and the
// subagent's, in order.
func TestSubRetryLogLines(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	fastRetries(e)
	logs := e.rcLogLines()
	id, _ := e.idleParent()
	in := fmt.Sprintf("in 1 s (login): %q", rcErr)

	a, pa := e.child(id, "", "first")
	rsFail(t, pa)
	p2 := waitChild(t, e.claude, 3)
	p2.emit(t, agent.Event{Kind: agent.EvText, Text: "back"})
	want := []string{"attempt 1/4 " + in, "attempt 1/4 starts", "attempt 1/4 answered"}
	if got := rsLines(logs(), id, a.ID); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("log of the subagent that answered:\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	e.rsGateFree()

	b, pb := e.child(id, "", "second")
	want = nil
	for n := 1; n <= retryAttempts; n++ {
		rsFail(t, pb)
		want = append(want, fmt.Sprintf("attempt %d/4 %s", n, in), fmt.Sprintf("attempt %d/4 starts", n))
		pb = waitChild(t, e.claude, 4+n)
	}
	rsFail(t, pb)
	e.rsWaitSub(id, b.ID, "the subagent to be paused", func(s model.Subagent) bool { return s.Status == model.SubPaused })
	want = append(want, fmt.Sprintf("paused after 4 attempts (login): %q", rcErr))
	if got := rsLines(logs(), id, b.ID); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("log of the subagent that was paused:\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	e.rsGateFree()
}

// Design D8: an attempt whose process cannot be started fails the subagent, as a spawn that fails
// does, and its result is owed to its parent.
func TestSubRetryStartFailureFails(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	fastRetries(e)
	logs := e.rcLogLines()
	sp := &rsSpawner{inner: e.claude}
	e.m.Spawners[model.Claude] = sp
	id, parent := e.startSpawnParent() // its first turn runs: the result stays owed
	l, pl := e.child(id, "", "lead")

	sp.fail.Store(true)
	rsFail(t, pl)
	got := e.rsWaitSub(id, l.ID, "the subagent to fail", func(s model.Subagent) bool { return s.Status == model.SubFailed })
	if !strings.HasPrefix(got.Error, "could not be started again: ") || got.Retry != (model.Retry{}) {
		t.Fatalf("the record: %+v", got)
	}
	e.delivery("after the failed start", id, l.ID, model.SubOwed)
	if f := e.subFile(id, l.ID); f.Status != model.SubFailed || f.Retry != (model.Retry{}) {
		t.Fatalf("subagent.json %+v", f)
	}
	closed(t, "the first process of the subagent", pl)
	if n := e.claude.count(); n != 2 {
		t.Fatalf("%d processes: the failed start made one", n)
	}
	var could bool
	for _, l := range logs() {
		if strings.Contains(l, "attempt 1/4 could not start: ") {
			could = true
		}
	}
	if !could {
		t.Fatalf("log %q", logs())
	}

	// The chat's agent is told when its turn is over.
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	e.delivery("after the parent's turn", id, l.ID, model.SubSent)
	e.rsGateFree()
}
