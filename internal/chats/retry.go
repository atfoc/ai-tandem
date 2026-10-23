// The retry of an agent after a temporary error (design D5, D6, D14, D15, D17): the schedule, the
// limiter, the state of one retry, and the texts. The chat's agent uses them in retrychat.go, a
// subagent in retrysub.go.
package chats

import (
	"fmt"
	"math"
	"math/rand/v2"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// retrySchedule is the pause before each retry of a turn that failed with a temporary error (goal
// 2.3). The original turn is not an attempt, so an agent's model is asked at most five times in a
// row. A manager has its own copy (Manager.retryWaits), for tests to lower.
var retrySchedule = [4]time.Duration{20 * time.Second, time.Minute, 3 * time.Minute, 8 * time.Minute}

const retryAttempts = len(retrySchedule)

// retryGateLimit is how many retries may start at once, for the whole server (goal 2.5), and
// retryGateHold how long an attempt keeps its slot when it neither gets a reply nor fails, so that
// a hung one does not block every other.
const (
	retryGateLimit = 2
	retryGateHold  = 60 * time.Second
)

// scaledSchedule is the schedule a manager uses: retrySchedule for first == 0, else every pause
// times first/retrySchedule[0] (cmd's AIWB_TEST_WAITS retry=).
func scaledSchedule(first time.Duration) [retryAttempts]time.Duration {
	if first == 0 {
		return retrySchedule
	}
	var w [retryAttempts]time.Duration
	for i, d := range retrySchedule {
		w[i] = time.Duration(math.Round(float64(d) * float64(first) / float64(retrySchedule[0])))
	}
	return w
}

// defaultJitter is d times a uniform random factor in [0.75, 1.25]: agents that failed together
// do not retry together.
func defaultJitter(d time.Duration) time.Duration {
	return time.Duration(float64(d) * (0.75 + 0.5*rand.Float64()))
}

// retryGate lets at most limit retries start at once, in the order they were queued (design D6).
// Its mutex is a leaf: no chat's lock is taken under it, and no start runs under it.
type retryGate struct {
	mu      sync.Mutex
	limit   int
	hold    time.Duration
	holding int
	queue   []*gateTicket
}

const (
	ticketQueued = iota
	ticketHolding
	ticketLeft
)

// gateTicket is one queued attempt. It holds a slot from the moment start is called until leave.
type gateTicket struct {
	start func()
	state int // ticketQueued, ticketHolding, ticketLeft
	timer *time.Timer
}

func newRetryGate(limit int, hold time.Duration) *retryGate {
	return &retryGate{limit: limit, hold: hold}
}

// enter queues start; it runs on a goroutine of its own once a slot is free (at once when one is).
func (g *retryGate) enter(start func()) *gateTicket {
	t := &gateTicket{start: start}
	g.mu.Lock()
	var run []*gateTicket
	if g.holding < g.limit {
		run = append(run, g.grant(t))
	} else {
		g.queue = append(g.queue, t)
	}
	g.mu.Unlock()
	startTickets(run)
	return t
}

// leave frees t's slot, or takes it out of the queue; idempotent, nil-safe. The next queued ticket
// starts on a goroutine of its own: no caller's lock is held when start runs.
func (g *retryGate) leave(t *gateTicket) {
	if t == nil {
		return
	}
	g.mu.Lock()
	var run []*gateTicket
	switch t.state {
	case ticketQueued:
		for i, q := range g.queue {
			if q == t {
				g.queue = append(g.queue[:i], g.queue[i+1:]...)
				break
			}
		}
		t.state = ticketLeft
	case ticketHolding:
		t.state = ticketLeft
		if t.timer != nil {
			t.timer.Stop()
		}
		g.holding--
		for g.holding < g.limit && len(g.queue) > 0 {
			next := g.queue[0]
			g.queue = g.queue[1:]
			run = append(run, g.grant(next))
		}
	}
	g.mu.Unlock()
	startTickets(run)
}

// grant gives t a slot and arms its hold. g.mu held.
func (g *retryGate) grant(t *gateTicket) *gateTicket {
	t.state = ticketHolding
	g.holding++
	t.timer = time.AfterFunc(g.hold, func() { g.leave(t) })
	return t
}

func startTickets(ts []*gateTicket) {
	for _, t := range ts {
		go t.start()
	}
}

// counts is for tests: the tickets that hold a slot and those that wait.
func (g *retryGate) counts() (holding, queued int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.holding, len(g.queue)
}

// retryWait is one agent's retry (Chat.retry, sub.retry). c.mu held for every field.
type retryWait struct {
	attempt int             // the attempt waited for or running, 1..retryAttempts
	kind    agent.Temporary // the failed turn's class
	reason  string          // the failed turn's error text
	at      time.Time       // when the attempt is due
	timer   *time.Timer
	ticket  *gateTicket
	started bool // its process was started: the next reply or failure ends it
}

// cancel stops the timer and leaves the gate, so that the attempt never starts, or frees the slot
// of one that did. nil-safe.
func (w *retryWait) cancel(g *retryGate) {
	if w == nil {
		return
	}
	if w.timer != nil {
		w.timer.Stop()
	}
	g.leave(w.ticket)
}

// model is the record clients see.
func (w *retryWait) model() model.Retry {
	return model.Retry{Attempt: w.attempt, Of: retryAttempts, At: w.at.UnixMilli(), Kind: string(w.kind), Error: w.reason}
}

// kindLabel is how a class of temporary error is named in a sentence.
func kindLabel(kind string) string {
	switch agent.Temporary(kind) {
	case agent.TempLogin:
		return "login failed"
	case agent.TempRate:
		return "rate limited"
	case agent.TempOverloaded:
		return "overloaded"
	case agent.TempServer:
		return "server error"
	}
	return "temporary error"
}

// waitWords says a wait: "N s" below a minute (rounded up, at least 1), else "N min" (rounded up).
func waitWords(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%d s", max(1, int((d+time.Second-1)/time.Second)))
	}
	return fmt.Sprintf("%d min", int((d+time.Minute-1)/time.Minute))
}

// clip cuts s to at most n runes; a cut text ends with "…".
func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}

// upperFirst is s with its first letter upper-cased.
func upperFirst(s string) string {
	r, n := utf8.DecodeRuneInString(s)
	return string(unicode.ToUpper(r)) + s[n:]
}

// retryNote is the note in the thread of an agent that failed with a temporary error and will be
// tried again after wait. The reason is cut to 500 characters, and its closing periods are left off:
// the CLI's errors end with one, and the sentence supplies its own.
func retryNote(kind, reason string, attempt int, wait time.Duration) string {
	return fmt.Sprintf("%s: %s. Trying again in about %s (attempt %d of %d).",
		upperFirst(kindLabel(kind)), clip(strings.TrimRight(reason, ". "), 500), waitWords(wait), attempt, retryAttempts)
}

// pausedNote is the note in the thread of a subagent whose retries ran out.
func pausedNote() string {
	return fmt.Sprintf("Paused: the app tried again %d times without success. The agent that started this subagent can resume it.", retryAttempts)
}

// gaveUpNote is the note in the thread of the chat's agent whose retries ran out.
func gaveUpNote() string {
	return fmt.Sprintf("The app tried again %d times without success. Your next message starts the agent again in the same session.", retryAttempts)
}

// quoteErr is an error text as a log line holds it: cut and quoted.
func quoteErr(s string) string { return strconv.Quote(clip(s, 300)) }

// carryOnTag names the block of a message that starts an agent again on its session.
const carryOnTag = "carry-on"

// carryOnBlock is the block of the message that carries an agent on: what happened, in the words
// of middle, and then the same ending for all.
func carryOnBlock(middle string) string {
	return "<" + carryOnTag + ">\nThis message was written by the app, not by the user. " + middle + "\n</" + carryOnTag + ">"
}

// reasonText is an error as a block holds it: cut to 500 characters and escaped.
func reasonText(s string) string { return xmlEscape.Replace(clip(s, 500)) }

// carryOnRetryBlock is the message of a retry.
func carryOnRetryBlock(kind, reason string) string {
	return carryOnBlock(fmt.Sprintf("Your last turn ended with a temporary error (%s: %s). "+
		"The app has started you again in the same session: carry on with your task where you stopped.",
		kindLabel(kind), reasonText(reason)))
}

// carryOnResumeBlock is the message of a resume of prev, the record as it was paused or stopped.
func carryOnResumeBlock(prev model.Subagent) string {
	if prev.Status == model.SubPaused {
		return carryOnBlock(fmt.Sprintf("You were paused: your turns failed with a temporary error (%s: %s) and the app's retries failed too. "+
			"The agent that started you has resumed you in the same session: carry on with your task where you stopped.",
			kindLabel(prev.ErrorKind), reasonText(prev.Error)))
	}
	return carryOnBlock(fmt.Sprintf("You were stopped (%s). "+
		"The agent that started you has resumed you in the same session: carry on with your task where you stopped.",
		xmlEscape.Replace(whyText(prev))))
}

// pausedListTag names the block that lists the paused and stopped subagents a message carries.
const pausedListTag = "subagents-paused-or-stopped"

// pausedListBlock is the list of design D14 for subs, in their order. withMessage is the person's
// message, which follows the block.
func pausedListBlock(subs []model.Subagent, withMessage bool) string {
	var b strings.Builder
	b.WriteString("<" + pausedListTag + ">\n")
	if withMessage {
		b.WriteString("This block was written by the app, not by the user; the user's message follows it. ")
	} else {
		b.WriteString("This block was written by the app, not by the user. ")
	}
	b.WriteString("These subagents you started are paused or were stopped without your asking, and do not run: " +
		"no result will come from them unless you resume them. To have one carry on in its own session where it stopped, " +
		"call resume_subagent with its sid: it is then sent the results it is owed, and its result comes to you as usual. " +
		"If you no longer need one, call stop_subagent with its sid and it is no longer listed.\n")
	field := func(name, v string) {
		if v != "" {
			fmt.Fprintf(&b, "<%s>%s</%s>\n", name, xmlEscape.Replace(v), name)
		}
	}
	for _, sa := range subs {
		b.WriteString("\n<subagent>\n")
		field("sid", sa.ID)
		field("description", sa.Description)
		field("state", string(sa.Status))
		field("why", whyText(sa))
		b.WriteString("</subagent>\n")
	}
	b.WriteString("</" + pausedListTag + ">")
	return b.String()
}

// whyText says why sa is paused or stopped, for the list and for a resume (design D14). A cause
// the list never holds (a stop that was asked for, a record from before) is said in general terms.
func whyText(sa model.Subagent) string {
	switch sa.Status {
	case model.SubPaused:
		cause := fmt.Sprintf("(%s: %s)", kindLabel(sa.ErrorKind), clip(sa.Error, 300))
		if sa.Cause == model.CauseRetryingAtStop {
			return "it was being retried after a temporary error when the server stopped " + cause
		}
		return fmt.Sprintf("its turns failed with a temporary error and the app's %d retries failed too %s", retryAttempts, cause)
	case model.SubStopped:
		switch sa.Cause {
		case model.CausePerson:
			return "the user stopped the chat's agent while it ran"
		case model.CauseParent:
			return "it was stopped together with the agent that started it"
		case model.CauseShutdown, model.CauseRestart:
			return "the server stopped while it ran"
		}
	}
	return "it was stopped"
}

// listedCauses are the causes of a stop that the list tells the parent of: not the stops the
// parent asked for, and not those that already reached it as a result.
var listedCauses = map[model.SubCause]bool{model.CausePerson: true, model.CauseParent: true, model.CauseShutdown: true, model.CauseRestart: true}

// pausedOrStopped is the selector of design D14: the children of parent (a sid, "" = the chat's
// agent) that the app started, that were carried into this chat, that have a session to resume,
// and that are paused or stopped by something other than the parent's request. Ordered by Ended,
// then id. c.mu held.
func pausedOrStopped(c *Chat, parent string) []model.Subagent {
	var list []model.Subagent
	for _, s := range c.subs {
		sa := s.meta
		if sa.Parent != parent || sa.Kind == "" || sa.NotCarried || sa.Session == "" {
			continue
		}
		if sa.Status == model.SubPaused || (sa.Status == model.SubStopped && listedCauses[sa.Cause]) {
			list = append(list, sa)
		}
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Ended != list[j].Ended {
			return list[i].Ended < list[j].Ended
		}
		return list[i].ID < list[j].ID
	})
	return list
}

// logRetry writes a line of the retry's log: the chat, the subagent ("-" for the chat's agent) and
// msg.
func (m *Manager) logRetry(chatID, sid, msg string) {
	if sid == "" {
		sid = "-"
	}
	if m.retryLog != nil {
		m.retryLog(fmt.Sprintf("chats: retry %s sub=%s %s", chatID, sid, msg))
	}
}
