package chats

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

const rcErr = "Failed to authenticate."

// rcFail is the end of a turn with a temporary error, as an adapter reports it.
func rcFail() agent.Event {
	return agent.Event{Kind: agent.EvTurnEnd, Error: rcErr, Temporary: agent.TempLogin}
}

// hourRetries makes the pauses so long that a retry waits until the test fires it (fireRetry).
func hourRetries(e *env) {
	fastRetries(e)
	e.m.retryWaits = [retryAttempts]time.Duration{time.Hour, time.Hour, time.Hour, time.Hour}
}

// retryChat starts a Claude chat whose first turn runs, with its process.
func (e *env) retryChat() (string, *fakeAgent) {
	e.t.Helper()
	return e.startSpawnParent()
}

// fireRetry runs the timer of the chat's pending retry now, as it would when it is due.
func (e *env) fireRetry(id string) {
	e.t.Helper()
	c, err := e.m.lock(id)
	if err != nil {
		e.t.Fatal(err)
	}
	w := c.retry
	c.mu.Unlock()
	if w == nil {
		e.t.Fatal("no retry to fire")
	}
	e.m.chatRetryFire(c, w)
}

// rcState is what the chat holds of a retry, under its lock.
type rcState struct {
	status     model.Status
	retrying   bool
	started    bool
	attempt    int
	turnActive bool
	hold       bool
	pub        uint32
}

func (e *env) rcState(id string) rcState {
	e.t.Helper()
	c, err := e.m.lock(id)
	if err != nil {
		e.t.Fatal(err)
	}
	defer c.mu.Unlock()
	st, _ := c.tr.Status()
	s := rcState{status: st, retrying: c.retry != nil, turnActive: c.meta.TurnActive, hold: c.hold, pub: c.pub.Load()}
	if c.retry != nil {
		s.started, s.attempt = c.retry.started, c.retry.attempt
	}
	return s
}

// setSession records a session on subagent sid, as the start of a subagent does (spawn.go).
func (e *env) rcSetSession(id, sid, session string) {
	e.t.Helper()
	c, err := e.m.lock(id)
	if err != nil {
		e.t.Fatal(err)
	}
	defer c.mu.Unlock()
	c.subs[sid].meta.Session = session
}

// rcPaused spawns a subagent of the chat's agent and pauses it by hand, with a session.
func (e *env) rcPaused(id string) model.Subagent {
	e.t.Helper()
	sa, _ := e.child(id, "", "lead work")
	e.rcSetSession(id, sa.ID, "session-"+sa.ID)
	e.pauseByHand(id, sa.ID, "Failed to authenticate", agent.TempLogin)
	return e.sub(id, sa.ID)
}

func rcWaitProcess(t *testing.T, e *env, n int) *fakeAgent {
	t.Helper()
	return waitChild(t, e.claude, n)
}

func (e *env) rcLogLines() func() []string {
	var mu sync.Mutex
	var lines []string
	e.m.retryLog = func(s string) {
		mu.Lock()
		defer mu.Unlock()
		lines = append(lines, s)
	}
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), lines...)
	}
}

// Goal 2.1, 2.2, 2.7: a temporary error keeps the chat working, closes the process, and the attempt
// starts the session again with one message: carry on.
func TestChatRetriesATemporaryError(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	hourRetries(e)
	id, p1 := e.retryChat()
	p1.emit(t, rcFail())

	v := e.view(id)
	if v.Status != model.StatusRetrying || v.Retry.Attempt != 1 || v.Retry.Of != retryAttempts || v.Retry.Kind != "login" ||
		v.Retry.Error != rcErr || v.Working != 1 {
		t.Fatalf("view %+v", v)
	}
	items := e.items(id)
	if got, want := notes(items, "error"), []string{retryNote("login", rcErr, 1, time.Hour)}; len(got) != 1 || got[0] != want[0] {
		t.Fatalf("error notes %q, want %q (and no generic error note)", got, want)
	}
	if s := e.rcState(id); !s.turnActive || s.hold {
		t.Fatalf("state %+v: the turn goes on and the chat is not held", s)
	}
	closed(t, "the first process", p1)

	e.fireRetry(id)
	p2 := rcWaitProcess(t, e, 2)
	if !p2.opts.Resume || p2.opts.SessionID != p1.opts.SessionID || p2.opts.SessionID == "" {
		t.Fatalf("the second process %+v, first %+v: want a resume of the same session", p2.opts, p1.opts)
	}
	sent := p2.sent()
	if len(sent) != 1 || len(sent[0]) != 1 || sent[0][0].Text != carryOnRetryBlock("login", rcErr) {
		t.Fatalf("the retry's message %+v", sent)
	}
	if v := e.view(id); v.Status != model.StatusThinking || v.Retry.Attempt != 1 {
		t.Fatalf("the attempt runs: %+v", v)
	}

	p2.emit(t, agent.Event{Kind: agent.EvText, Text: "back"})
	if v := e.view(id); v.Retry != (model.Retry{}) {
		t.Fatalf("a reply ends the retrying: %+v", v.Retry)
	}
	p2.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	if v := e.view(id); v.Status != model.StatusReady || e.rcState(id).turnActive {
		t.Fatalf("after the clean end: %+v", v)
	}
}

// Goal 2.4: an attempt that gets a reply starts the count again.
func TestChatRetryCountStartsAgainAfterAReply(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	hourRetries(e)
	id, p1 := e.retryChat()
	p1.emit(t, rcFail())
	e.fireRetry(id)
	p2 := rcWaitProcess(t, e, 2)
	p2.emit(t, agent.Event{Kind: agent.EvText, Text: "hello"}, rcFail())
	if s := e.rcState(id); !s.retrying || s.attempt != 1 || s.started {
		t.Fatalf("after a reply and a new failure: %+v, want attempt 1 waiting", s)
	}
	// Without the reply it is the next attempt.
	e.fireRetry(id)
	p3 := rcWaitProcess(t, e, 3)
	p3.emit(t, rcFail())
	if s := e.rcState(id); !s.retrying || s.attempt != 2 {
		t.Fatalf("after a failure with no reply: %+v, want attempt 2", s)
	}
}

// Goal 3.5: the fifth failure in a row ends as a failed turn does, and a note says the app tried.
func TestChatGivesUpAfterFourAttempts(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	fastRetries(e)
	logs := e.rcLogLines()
	id, p := e.retryChat()
	first := p
	for n := 2; n <= 1+retryAttempts; n++ {
		p.emit(t, rcFail())
		p = rcWaitProcess(t, e, n)
		if p.opts.SessionID != first.opts.SessionID || !p.opts.Resume {
			t.Fatalf("process %d: %+v", n, p.opts)
		}
	}
	p.emit(t, rcFail())

	v := e.view(id)
	if v.Status != model.StatusReady || v.Retry != (model.Retry{}) {
		t.Fatalf("view %+v", v)
	}
	s := e.rcState(id)
	if s.turnActive || !s.hold || s.retrying {
		t.Fatalf("state %+v: the turn is over, the chat is held, no retry runs", s)
	}
	items := e.items(id)
	errNotes := notes(items, "error")
	if len(errNotes) != retryAttempts+1 || errNotes[len(errNotes)-1] != rcErr {
		t.Fatalf("error notes %q: want the %d retry notes and then the error", errNotes, retryAttempts)
	}
	last := items[len(items)-1]
	if last.Kind != "note" || last.Tone != "muted" || last.Text != gaveUpNote() {
		t.Fatalf("last item %+v, want the gave-up note", last)
	}
	if e.claude.count() != 1+retryAttempts {
		t.Fatalf("%d processes, want %d", e.claude.count(), 1+retryAttempts)
	}
	if closedP := agentClosed(p); closedP {
		t.Fatal("the last process stays, as after any failed turn")
	}
	var gaveUp bool
	for _, l := range logs() {
		if strings.Contains(l, "gave up after 4 attempts (login)") {
			gaveUp = true
		}
	}
	if !gaveUp {
		t.Fatalf("log %q", logs())
	}
	// The person's next message goes to the session.
	e.send(id, "go on", "")
	if got := lastSend(t, p); !strings.HasSuffix(got, "go on") {
		t.Fatalf("the message %q", got)
	}
	if e.claude.count() != 1+retryAttempts || e.rcState(id).hold {
		t.Fatalf("the message resumes the chat: %d processes, %+v", e.claude.count(), e.rcState(id))
	}
}

// Goal 2.8: the person's message between attempts is the next turn, and cancels the retry.
func TestMessageDuringBackoffIsTheNextTurn(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	hourRetries(e)
	logs := e.rcLogLines()
	id, p1 := e.retryChat()
	p1.emit(t, rcFail())
	c, _ := e.m.lock(id)
	w := c.retry
	c.mu.Unlock()

	if err := e.m.Send(id, "go on", "", nil); err != nil {
		t.Fatalf("a retrying chat takes a message: %v", err)
	}
	p2 := rcWaitProcess(t, e, 2)
	if !p2.opts.Resume || p2.opts.SessionID != p1.opts.SessionID {
		t.Fatalf("the process %+v", p2.opts)
	}
	if got := texts(p2.sent()[0]); len(got) != 1 || got[0] != "go on" {
		t.Fatalf("the message %q: the person's text alone, no carry-on block", got)
	}
	if v := e.view(id); v.Retry != (model.Retry{}) || v.Status != model.StatusThinking {
		t.Fatalf("view %+v", v)
	}
	// The cancelled attempt starts nothing, whatever fires it.
	e.m.chatRetryFire(c, w)
	e.m.chatRetryStart(c, w)
	time.Sleep(200 * time.Millisecond)
	if e.claude.count() != 2 {
		t.Fatalf("%d processes: the cancelled retry started one", e.claude.count())
	}
	want := []string{
		fmt.Sprintf("chats: retry %s sub=- attempt 1/4 in 60 min (login): %q", id, rcErr),
		fmt.Sprintf("chats: retry %s sub=- cancelled: a message of the user", id),
	}
	if got := logs(); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("log %q, want %q", got, want)
	}
}

// Goal 2.8: Interrupt and Stop between attempts cancel the retry and nothing starts later.
func TestInterruptAndStopDuringBackoffCancel(t *testing.T) {
	t.Parallel()
	for name, stop := range map[string]func(e *env, id string){
		"interrupt": func(e *env, id string) {
			if err := e.m.Interrupt(id); err != nil {
				t.Fatal(err)
			}
		},
		"stop": func(e *env, id string) { e.m.Stop(id) },
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t)
			hourRetries(e)
			id, p1 := e.retryChat()
			p1.emit(t, rcFail())
			c, _ := e.m.lock(id)
			w := c.retry
			c.mu.Unlock()

			stop(e, id)
			if v := e.view(id); v.Status != model.StatusReady || v.Retry != (model.Retry{}) {
				t.Fatalf("view %+v", v)
			}
			s := e.rcState(id)
			if s.turnActive || !s.hold || s.retrying || s.pub != pubIdle {
				t.Fatalf("state %+v", s)
			}
			if got := notes(e.items(id), "muted"); len(got) != 1 || got[0] != "Stopped." {
				t.Fatalf("muted notes %q: want one Stopped.", got)
			}
			e.m.chatRetryFire(c, w)
			e.m.chatRetryStart(c, w)
			time.Sleep(200 * time.Millisecond)
			if e.claude.count() != 1 {
				t.Fatalf("%d processes: the cancelled retry started one", e.claude.count())
			}
			if holding, queued := e.m.retryGate.counts(); holding != 0 || queued != 0 {
				t.Fatalf("the gate holds %d and queues %d", holding, queued)
			}
		})
	}
}

// Goal 2.5: a retry starts only when the limiter lets it.
func TestChatRetryWaitsForTheGate(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	fastRetries(e)
	e.m.retryGate = newRetryGate(1, time.Minute)
	taken := make(chan struct{})
	busyTicket := e.m.retryGate.enter(func() { close(taken) })
	<-taken
	id, p1 := e.retryChat()
	p1.emit(t, rcFail())
	time.Sleep(200 * time.Millisecond) // ten times the pause
	if e.claude.count() != 1 {
		t.Fatalf("%d processes: the retry went past the limiter", e.claude.count())
	}
	if v := e.view(id); v.Status != model.StatusRetrying {
		t.Fatalf("view %+v", v)
	}
	e.m.retryGate.leave(busyTicket)
	p2 := rcWaitProcess(t, e, 2)
	p2.emit(t, agent.Event{Kind: agent.EvText, Text: "x"})
	waitFor(t, "the slot to be free", func() bool { h, q := e.m.retryGate.counts(); return h == 0 && q == 0 })
}

// A retry that is cancelled while it fires, or that fires while a message comes: no process starts
// after the cancel has returned, and the limiter is left empty.
func TestChatRetryCancelRacesItsTimer(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	fastRetries(e)
	e.m.retryWaits = [retryAttempts]time.Duration{time.Millisecond, time.Millisecond, time.Millisecond, time.Millisecond}
	for i := 0; i < 20; i++ {
		id, p := e.retryChat()
		p.emit(t, rcFail())
		time.Sleep(time.Duration(i%4) * 500 * time.Microsecond)
		if i%2 == 0 {
			if err := e.m.Interrupt(id); err != nil {
				t.Fatal(err)
			}
		} else {
			e.m.Stop(id)
		}
		n := e.claude.count()
		time.Sleep(15 * time.Millisecond)
		if got := e.claude.count(); got != n {
			t.Fatalf("round %d: a process was started after the cancel (%d, then %d)", i, n, got)
		}
		if s := e.rcState(id); s.retrying || (s.pub != pubIdle && s.status != model.StatusThinking) {
			t.Fatalf("round %d: state %+v", i, s)
		}
		if v := e.view(id); v.Retry != (model.Retry{}) {
			t.Fatalf("round %d: view %+v", i, v)
		}
	}
	e.m.handoffs.Wait()
	waitFor(t, "the limiter to be empty", func() bool { h, q := e.m.retryGate.counts(); return h == 0 && q == 0 })
}

// Goal 6.1, 6.4: the results a chat is owed while it waits stay owed, and the retry carries them.
func TestRetryCarriesOwedResults(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	hourRetries(e)
	id, p1 := e.retryChat()
	sa, kid := e.child(id, "", "work")
	p1.emit(t, rcFail())
	time.Sleep(50 * time.Millisecond)
	if agentClosed(kid) || e.sub(id, sa.ID).Status != model.SubRunning {
		t.Fatal("the chat's retry stops nothing it started")
	}
	e.finish(kid, "kid report")
	e.delivery("owed while the chat has no process", id, sa.ID, model.SubOwed)

	e.fireRetry(id)
	p2 := rcWaitProcess(t, e, 3) // the kid's process is the second
	if p2 == kid {
		t.Fatal("not the retry's process")
	}
	got := texts(p2.sent()[0])
	if len(got) != 2 || got[0] != carryOnRetryBlock("login", rcErr) || !strings.HasPrefix(got[1], "<"+subResultsTag+">") ||
		!strings.Contains(got[1], "<sid>"+sa.ID+"</sid>") {
		t.Fatalf("the retry's message %q", got)
	}
	e.delivery("carried by the retry", id, sa.ID, model.SubSent)
}

// A carrying turn that fails with a temporary error before any output did not deliver: the results
// are owed, with no failed attempt, and the retry carries them.
func TestTemporaryFailureKeepsCarriedResultsOwed(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	hourRetries(e)
	id, parent := e.idleParent()
	sa, kid := e.child(id, "", "work")
	e.finish(kid, "report")
	e.delivery("carried by the delivery turn", id, sa.ID, model.SubSent)

	parent.emit(t, rcFail())
	e.delivery("after the temporary failure", id, sa.ID, model.SubOwed)
	if e.rcState(id).hold {
		t.Fatal("a retried failure does not hold the chat")
	}

	e.fireRetry(id)
	p2 := rcWaitProcess(t, e, 3)
	if got := texts(p2.sent()[0]); len(got) != 2 || !strings.Contains(got[1], "<sid>"+sa.ID+"</sid>") {
		t.Fatalf("the retry's message %q", got)
	}
	e.delivery("carried again", id, sa.ID, model.SubSent)
}

// Goal 1.3: an error that is not temporary is what it was.
func TestNonTemporaryErrorAsToday(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	fastRetries(e)
	id, p1 := e.retryChat()
	p1.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "API Error: 400 bad"})
	v := e.view(id)
	if v.Status != model.StatusReady || v.Retry != (model.Retry{}) {
		t.Fatalf("view %+v", v)
	}
	s := e.rcState(id)
	if s.retrying || s.turnActive || !s.hold {
		t.Fatalf("state %+v", s)
	}
	if got := notes(e.items(id), "error"); len(got) != 1 || got[0] != "API Error: 400 bad" {
		t.Fatalf("error notes %q", got)
	}
	time.Sleep(100 * time.Millisecond)
	if agentClosed(p1) || e.claude.count() != 1 {
		t.Fatalf("the process stays and nothing is started: closed %v, %d processes", agentClosed(p1), e.claude.count())
	}
}

// An attempt that fails for a reason that is not temporary ends the retry.
func TestAttemptFailingForGoodEndsTheRetry(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	hourRetries(e)
	id, p1 := e.retryChat()
	p1.emit(t, rcFail())
	e.fireRetry(id)
	p2 := rcWaitProcess(t, e, 2)
	p2.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "API Error: 400 bad"})
	if s := e.rcState(id); s.retrying || s.status != model.StatusReady || !s.hold {
		t.Fatalf("state %+v", s)
	}
	if v := e.view(id); v.Retry != (model.Retry{}) {
		t.Fatalf("view %+v", v)
	}
}

// The exit of the process of an attempt ends the retry.
func TestAttemptProcessExitEndsTheRetry(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	hourRetries(e)
	logs := e.rcLogLines()
	id, p1 := e.retryChat()
	p1.emit(t, rcFail())
	e.fireRetry(id)
	p2 := rcWaitProcess(t, e, 2)
	p2.exit(t)
	if s := e.rcState(id); s.retrying || s.status != model.StatusStopped {
		t.Fatalf("state %+v", s)
	}
	if got := logs(); !strings.HasSuffix(got[len(got)-1], "cancelled: the process ended") {
		t.Fatalf("log %q", got)
	}
}

// An attempt's message the agent does not take ends the retry as a refused delivery does.
func TestRefusedRetryMessageEndsTheRetry(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	hourRetries(e)
	id, p1 := e.retryChat()
	p1.emit(t, rcFail())
	e.fireRetry(id)
	rcWaitProcess(t, e, 2)
	c, _ := e.m.lock(id)
	w := c.retry
	c.mu.Unlock()
	e.m.chatRetryRefused(c, w, nil, errors.New("rpc timed out"))
	s := e.rcState(id)
	if s.retrying || s.status != model.StatusReady || !s.hold || s.turnActive {
		t.Fatalf("state %+v", s)
	}
	if got := notes(e.items(id), "error"); got[len(got)-1] != "The agent could not be started again: rpc timed out" {
		t.Fatalf("error notes %q", got)
	}
}

// Goal 2.7: Send is taken (not busy), and the chat counts as working for the caps.
func TestRetryingChatTakesAMessageButShowsWorking(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	hourRetries(e)
	id, p1 := e.retryChat()
	p1.emit(t, rcFail())
	if e.m.Busy(id) {
		t.Fatal("a retrying chat is not busy")
	}
	if s := e.rcState(id); s.pub != pubWorking || s.status != model.StatusRetrying {
		t.Fatalf("state %+v: want the mirror to say working", s)
	}
}

// Goal 5.1, 5.2: the person's message carries the list, in front of the text.
func TestPersonMessageCarriesTheList(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.idleParent()
	lead := e.rcPaused(id)
	e.send(id, "continue", "")
	got := texts(parent.sent()[1])
	want := []string{pausedListBlock([]model.Subagent{lead}, true), "continue"}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("blocks %q, want %q", got, want)
	}
	if !strings.Contains(got[0], "<sid>"+lead.ID+"</sid>") || !strings.Contains(got[0], "<state>paused</state>") {
		t.Fatalf("the list %q", got[0])
	}
}

// Scenario 11: with nothing paused or stopped without being asked, a message is what it was.
func TestPersonMessageUnchangedWithNothingListed(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.idleParent()
	done, kidDone := e.child(id, "", "one")
	stopped, _ := e.child(id, "", "two")
	failed, kidFailed := e.child(id, "", "three")
	for _, sid := range []string{done.ID, stopped.ID, failed.ID} {
		e.rcSetSession(id, sid, "session-"+sid)
	}
	e.finish(kidDone, "done")
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd}) // the delivery's turn
	if err := e.m.StopSubagent(id, stopped.ID); err != nil {
		t.Fatal(err)
	}
	kidFailed.emit(t, agent.Event{Kind: agent.EvExit, ExitErr: "crashed"})
	e.m.handoffs.Wait()
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})

	before := len(parent.sent())
	e.send(id, "hello", "")
	sent := parent.sent()
	if len(sent) != before+1 {
		t.Fatalf("%d messages, want %d", len(sent), before+1)
	}
	if got := texts(sent[before]); len(got) != 1 || got[0] != "hello" {
		t.Fatalf("blocks %q, want the text alone", got)
	}
}

// Goal 5.1: an app delivery carries the list after its results.
func TestDeliverCarriesTheList(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.idleParent()
	lead := e.rcPaused(id)
	other, kid := e.child(id, "", "other")
	e.finish(kid, "report")
	got := texts(parent.sent()[1])
	if len(got) != 2 || !strings.HasPrefix(got[0], "<"+subResultsTag+">") || !strings.Contains(got[0], "<sid>"+other.ID+"</sid>") ||
		got[1] != pausedListBlock([]model.Subagent{lead}, false) {
		t.Fatalf("blocks %q", got)
	}
}

// Goal 2.9: the log has the lines of D17, in order.
func TestRetryLogLines(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	hourRetries(e)
	logs := e.rcLogLines()
	id, p1 := e.retryChat()
	p1.emit(t, rcFail())
	e.fireRetry(id)
	p2 := rcWaitProcess(t, e, 2)
	p2.emit(t, agent.Event{Kind: agent.EvText, Text: "back"}, rcFail())
	e.send(id, "stop retrying", "")
	pre := fmt.Sprintf("chats: retry %s sub=- ", id)
	want := []string{
		pre + fmt.Sprintf("attempt 1/4 in 60 min (login): %q", rcErr),
		pre + "attempt 1/4 starts",
		pre + "attempt 1/4 answered",
		pre + fmt.Sprintf("attempt 1/4 in 60 min (login): %q", rcErr),
		pre + "cancelled: a message of the user",
	}
	if got := logs(); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("log\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// Goal 3.6 for the chat: the server stops during a pause; the next load shows the chat stopped, and
// the person's message starts the session again.
func TestShutdownDuringChatBackoff(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	hourRetries(e)
	id, p1 := e.retryChat()
	p1.emit(t, rcFail())
	c, _ := e.m.lock(id)
	w := c.retry
	c.mu.Unlock()
	e.m.Shutdown()
	if s := e.rcState(id); s.retrying {
		t.Fatalf("state %+v: shutdown cancels the retry", s)
	}
	e.m.chatRetryFire(c, w)
	e.m.chatRetryStart(c, w)
	if e.claude.count() != 1 {
		t.Fatalf("%d processes after shutdown", e.claude.count())
	}

	e.boot()
	if got := notes(e.items(id), "error"); got[len(got)-1] != "Stopped: the app was closed while the agent was working." {
		t.Fatalf("error notes %q", got)
	}
	if v := e.view(id); v.Status != model.StatusStopped || v.Retry != (model.Retry{}) {
		t.Fatalf("view %+v", v)
	}
	e.send(id, "again", "")
	p := rcWaitProcess(t, e, 1)
	if !p.opts.Resume || p.opts.SessionID != p1.opts.SessionID {
		t.Fatalf("the process %+v", p.opts)
	}
}
