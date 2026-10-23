package chats

import (
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/transcript"
)

func TestScaledSchedule(t *testing.T) {
	t.Parallel()
	if got, want := scaledSchedule(0), [4]time.Duration{20 * time.Second, time.Minute, 3 * time.Minute, 8 * time.Minute}; got != want {
		t.Errorf("the production schedule: %v, want %v", got, want)
	}
	if got, want := scaledSchedule(2*time.Second), [4]time.Duration{2 * time.Second, 6 * time.Second, 18 * time.Second, 48 * time.Second}; got != want {
		t.Errorf("scaled to 2 s: %v, want %v", got, want)
	}
}

func TestDefaultJitterBounds(t *testing.T) {
	t.Parallel()
	seen := map[time.Duration]bool{}
	for i := 0; i < 1000; i++ {
		d := defaultJitter(time.Second)
		if d < 750*time.Millisecond || d > 1250*time.Millisecond {
			t.Fatalf("defaultJitter(1s) = %v, outside [750ms, 1250ms]", d)
		}
		seen[d] = true
	}
	if len(seen) < 2 {
		t.Fatal("1000 draws are all equal")
	}
}

// gateStarts returns a start function for ticket i that reports i on the channel.
func gateStart(started chan int, i int) func() { return func() { started <- i } }

// gotStart waits for the next start and returns its number.
func gotStart(t *testing.T, started chan int) int {
	t.Helper()
	select {
	case i := <-started:
		return i
	case <-time.After(5 * time.Second):
		t.Fatal("no attempt started")
		return -1
	}
}

// noStart fails if another start comes within a short time.
func noStart(t *testing.T, started chan int) {
	t.Helper()
	select {
	case i := <-started:
		t.Fatalf("attempt %d started", i)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestRetryGateLimitsAndOrder(t *testing.T) {
	t.Parallel()
	g := newRetryGate(2, time.Hour)
	started := make(chan int, 5)
	var ts []*gateTicket
	for i := 0; i < 5; i++ {
		ts = append(ts, g.enter(gateStart(started, i)))
	}
	// Two start, in either order (each on a goroutine of its own); three are queued.
	first := map[int]bool{gotStart(t, started): true, gotStart(t, started): true}
	if !first[0] || !first[1] {
		t.Fatalf("the first two to start are %v, want tickets 0 and 1", first)
	}
	noStart(t, started)
	if h, q := g.counts(); h != 2 || q != 3 {
		t.Fatalf("holding %d, queued %d, want 2 and 3", h, q)
	}

	// A holder leaves: the oldest queued one starts.
	g.leave(ts[0])
	if i := gotStart(t, started); i != 2 {
		t.Fatalf("ticket %d started, want 2", i)
	}
	// A queued one leaves: it is out of the queue and never starts.
	g.leave(ts[4])
	if h, q := g.counts(); h != 2 || q != 1 {
		t.Fatalf("holding %d, queued %d, want 2 and 1", h, q)
	}
	g.leave(ts[1])
	if i := gotStart(t, started); i != 3 {
		t.Fatalf("ticket %d started, want 3", i)
	}
	noStart(t, started)

	// A second leave, and leave(nil), change nothing.
	g.leave(ts[0])
	g.leave(ts[4])
	g.leave(nil)
	if h, q := g.counts(); h != 2 || q != 0 {
		t.Fatalf("holding %d, queued %d, want 2 and 0", h, q)
	}
	noStart(t, started)
	g.leave(ts[2])
	g.leave(ts[3])
	if h, q := g.counts(); h != 0 || q != 0 {
		t.Fatalf("holding %d, queued %d, want 0 and 0", h, q)
	}
}

func TestRetryGateHoldFreesASlot(t *testing.T) {
	t.Parallel()
	g := newRetryGate(1, 30*time.Millisecond)
	started := make(chan int, 2)
	g.enter(gateStart(started, 0))
	g.enter(gateStart(started, 1))
	if i := gotStart(t, started); i != 0 {
		t.Fatalf("ticket %d started first", i)
	}
	// The holder never leaves: the hold runs out and the queued one starts.
	if i := gotStart(t, started); i != 1 {
		t.Fatalf("ticket %d started second", i)
	}
}

func TestRetryWaitCancel(t *testing.T) {
	t.Parallel()
	g := newRetryGate(1, time.Hour)
	started := make(chan int, 2)
	holder := g.enter(gateStart(started, 0))
	gotStart(t, started)

	// A wait whose ticket is still queued, with its timer armed.
	var fired atomic.Bool
	w := &retryWait{attempt: 1, kind: agent.TempLogin}
	w.timer = time.AfterFunc(20*time.Millisecond, func() { fired.Store(true) })
	w.ticket = g.enter(gateStart(started, 1))
	w.cancel(g)
	time.Sleep(200 * time.Millisecond)
	if fired.Load() {
		t.Fatal("the timer of a cancelled wait fired")
	}
	if h, q := g.counts(); h != 1 || q != 0 {
		t.Fatalf("holding %d, queued %d after the cancel, want 1 and 0", h, q)
	}
	g.leave(holder)
	noStart(t, started) // the cancelled ticket never starts

	// A wait whose attempt holds the slot: the cancel frees it.
	w = &retryWait{attempt: 2}
	w.ticket = g.enter(gateStart(started, 2))
	gotStart(t, started)
	w.cancel(g)
	if h, q := g.counts(); h != 0 || q != 0 {
		t.Fatalf("holding %d, queued %d after the cancel of a holder, want 0 and 0", h, q)
	}
	(*retryWait)(nil).cancel(g) // nil-safe
}

func TestWaitWords(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		d    time.Duration
		want string
	}{
		{400 * time.Millisecond, "1 s"},
		{20 * time.Second, "20 s"},
		{59200 * time.Millisecond, "60 s"},
		{time.Minute, "1 min"},
		{61 * time.Second, "2 min"},
		{8 * time.Minute, "8 min"},
	} {
		if got := waitWords(c.d); got != c.want {
			t.Errorf("waitWords(%v) = %q, want %q", c.d, got, c.want)
		}
	}
}

func TestKindLabel(t *testing.T) {
	t.Parallel()
	for kind, want := range map[string]string{
		"login":        "login failed",
		"rate_limit":   "rate limited",
		"overloaded":   "overloaded",
		"server_error": "server error",
		"retried":      "temporary error",
		"":             "temporary error",
		"other":        "temporary error",
	} {
		if got := kindLabel(kind); got != want {
			t.Errorf("kindLabel(%q) = %q, want %q", kind, got, want)
		}
	}
}

func TestRetryTexts(t *testing.T) {
	t.Parallel()
	check := func(what, got, want string) {
		t.Helper()
		if got != want {
			t.Errorf("%s:\n got %q\nwant %q", what, got, want)
		}
	}
	check("retryNote", retryNote("login", "Failed to authenticate. API Error: 401", 1, 20*time.Second),
		"Login failed: Failed to authenticate. API Error: 401. Trying again in about 20 s (attempt 1 of 4).")
	check("retryNote, minutes", retryNote("server_error", "boom", 3, 3*time.Minute),
		"Server error: boom. Trying again in about 3 min (attempt 3 of 4).")
	check("pausedNote", pausedNote(),
		"Paused: the app tried again 4 times without success. The agent that started this subagent can resume it.")
	check("gaveUpNote", gaveUpNote(),
		"The app tried again 4 times without success. Your next message starts the agent again in the same session.")

	check("carryOnRetryBlock", carryOnRetryBlock("login", "Failed to authenticate"),
		"<carry-on>\n"+
			"This message was written by the app, not by the user. Your last turn ended with a temporary error (login failed: Failed to authenticate). "+
			"The app has started you again in the same session: carry on with your task where you stopped.\n"+
			"</carry-on>")
	check("carryOnResumeBlock, paused", carryOnResumeBlock(model.Subagent{Status: model.SubPaused, ErrorKind: "rate_limit", Error: "slow down", Cause: model.CauseRetriesFailed}),
		"<carry-on>\n"+
			"This message was written by the app, not by the user. You were paused: your turns failed with a temporary error (rate limited: slow down) and the app's retries failed too. "+
			"The agent that started you has resumed you in the same session: carry on with your task where you stopped.\n"+
			"</carry-on>")
	check("carryOnResumeBlock, stopped", carryOnResumeBlock(model.Subagent{Status: model.SubStopped, Cause: model.CausePerson}),
		"<carry-on>\n"+
			"This message was written by the app, not by the user. You were stopped (the user stopped the chat's agent while it ran). "+
			"The agent that started you has resumed you in the same session: carry on with your task where you stopped.\n"+
			"</carry-on>")

	// What the error says is escaped, and cut to 500 characters.
	if got := carryOnRetryBlock("login", "a <x> & b"); !strings.Contains(got, "(login failed: a &lt;x&gt; &amp; b)") {
		t.Errorf("the reason is not escaped: %q", got)
	}
	long := strings.Repeat("é", 600)
	got := carryOnRetryBlock("login", long)
	want := "(login failed: " + strings.Repeat("é", 499) + "…)"
	if !strings.Contains(got, want) {
		t.Errorf("a reason of 600 characters is not cut to 500 with an ellipsis: %q", got)
	}
	if n := utf8.RuneCountInString(clip(long, 500)); n != 500 {
		t.Errorf("clip(600 runes, 500) has %d runes", n)
	}
	if got := clip("short", 500); got != "short" {
		t.Errorf("clip changed a short text: %q", got)
	}
}

const pausedListIntro = "This block was written by the app, not by the user. These subagents you started are paused or were stopped without your asking, " +
	"and do not run: no result will come from them unless you resume them. To have one carry on in its own session where it stopped, " +
	"call resume_subagent with its sid: it is then sent the results it is owed, and its result comes to you as usual. " +
	"If you no longer need one, call stop_subagent with its sid and it is no longer listed.\n"

func TestPausedListBlock(t *testing.T) {
	t.Parallel()
	subs := []model.Subagent{
		{ID: "4f0a1c2b9e7d", Description: "Lead: storage layer", Status: model.SubPaused, ErrorKind: "login", Error: "Failed to authenticate", Cause: model.CauseRetriesFailed},
		{ID: "b2", Status: model.SubStopped, Cause: model.CausePerson},
	}
	body := "\n<subagent>\n<sid>4f0a1c2b9e7d</sid>\n<description>Lead: storage layer</description>\n<state>paused</state>\n" +
		"<why>its turns failed with a temporary error and the app's 4 retries failed too (login failed: Failed to authenticate)</why>\n</subagent>\n" +
		"\n<subagent>\n<sid>b2</sid>\n<state>stopped</state>\n<why>the user stopped the chat's agent while it ran</why>\n</subagent>\n"
	want := "<subagents-paused-or-stopped>\n" + pausedListIntro + body + "</subagents-paused-or-stopped>"
	if got := pausedListBlock(subs, false); got != want {
		t.Errorf("without a message:\n got %q\nwant %q", got, want)
	}
	withMsg := strings.Replace(want, "This block was written by the app, not by the user. ", "This block was written by the app, not by the user; the user's message follows it. ", 1)
	if got := pausedListBlock(subs, true); got != withMsg {
		t.Errorf("with a message:\n got %q\nwant %q", got, withMsg)
	}

	// What a subagent supplied is escaped, and its error is cut to 300 characters.
	got := pausedListBlock([]model.Subagent{
		{ID: "s<1>", Description: "a & b", Status: model.SubPaused, ErrorKind: "overloaded", Error: "<e>" + strings.Repeat("x", 400), Cause: model.CauseRetryingAtStop},
	}, false)
	for _, w := range []string{"<sid>s&lt;1&gt;</sid>", "<description>a &amp; b</description>",
		"<why>it was being retried after a temporary error when the server stopped (overloaded: &lt;e&gt;" + strings.Repeat("x", 296) + "…)</why>"} {
		if !strings.Contains(got, w) {
			t.Errorf("the block lacks %q:\n%s", w, got)
		}
	}
}

// listedSub is a record the selector lists unless the test changes it.
func listedSub(id string, ended int64, mut func(*model.Subagent)) *sub {
	sa := model.Subagent{ID: id, Kind: model.Claude, Status: model.SubPaused, Cause: model.CauseRetriesFailed, Session: "sess-" + id, Ended: ended}
	if mut != nil {
		mut(&sa)
	}
	return &sub{meta: sa}
}

func TestPausedOrStoppedSelection(t *testing.T) {
	t.Parallel()
	stopped := func(cause model.SubCause) func(*model.Subagent) {
		return func(sa *model.Subagent) { sa.Status, sa.Cause = model.SubStopped, cause }
	}
	c := &Chat{subs: map[string]*sub{}}
	add := func(s *sub) { c.subs[s.meta.ID] = s }
	// Listed, in the order of Ended and then of id.
	add(listedSub("l-paused", 50, nil))
	add(listedSub("l-person", 40, stopped(model.CausePerson)))
	add(listedSub("l-parent", 40, stopped(model.CauseParent)))
	add(listedSub("l-shutdown", 30, stopped(model.CauseShutdown)))
	add(listedSub("l-restart", 60, stopped(model.CauseRestart)))
	// Not listed.
	add(listedSub("n-stoptool", 1, stopped(model.CauseStopTool)))
	add(listedSub("n-aborted", 1, stopped(model.CauseAborted)))
	add(listedSub("n-gone", 1, stopped(model.CauseGone)))
	add(listedSub("n-native", 1, func(sa *model.Subagent) { sa.Kind = "" }))
	add(listedSub("n-notcarried", 1, func(sa *model.Subagent) { sa.NotCarried = true }))
	add(listedSub("n-nosession", 1, func(sa *model.Subagent) { sa.Session = "" }))
	add(listedSub("n-running", 1, func(sa *model.Subagent) { sa.Status, sa.Cause = model.SubRunning, "" }))
	add(listedSub("n-completed", 1, func(sa *model.Subagent) { sa.Status, sa.Cause = model.SubCompleted, model.CauseTurn }))
	add(listedSub("n-failed", 1, func(sa *model.Subagent) { sa.Status, sa.Cause = model.SubFailed, model.CauseFailed }))
	add(listedSub("n-old", 1, func(sa *model.Subagent) { sa.Status, sa.Cause = model.SubStopped, "" }))
	add(listedSub("n-other-parent", 1, func(sa *model.Subagent) { sa.Parent = "someone-else" }))
	// A child of l-paused that is listed for l-paused.
	add(listedSub("k-child", 5, func(sa *model.Subagent) { sa.Parent = "l-paused" }))

	var got []string
	for _, sa := range pausedOrStopped(c, "") {
		got = append(got, sa.ID)
	}
	want := []string{"l-shutdown", "l-parent", "l-person", "l-paused", "l-restart"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("listed for the chat's agent: %v, want %v", got, want)
	}
	got = nil
	for _, sa := range pausedOrStopped(c, "l-paused") {
		got = append(got, sa.ID)
	}
	if strings.Join(got, ",") != "k-child" {
		t.Errorf("listed for l-paused: %v, want [k-child]", got)
	}
}

func TestEndedRecordsCause(t *testing.T) {
	t.Parallel()
	if len(causeOf) != int(endShutdown)+1 || len(endingNotifies) != int(endShutdown)+1 {
		t.Fatalf("causeOf has %d entries and endingNotifies %d, want one for each of the %d endings", len(causeOf), len(endingNotifies), int(endShutdown)+1)
	}
	for why := subEnding(0); why <= endShutdown; why++ {
		app := &sub{app: true}
		ended(app, why)
		if app.meta.Cause == "" || app.meta.Cause != causeOf[why] {
			t.Errorf("ending %d: cause %q, want %q", why, app.meta.Cause, causeOf[why])
		}
		if owed := app.meta.Delivery == model.SubOwed; owed != endingNotifies[why] {
			t.Errorf("ending %d: owed %v, want %v", why, owed, endingNotifies[why])
		}
		native := &sub{}
		ended(native, why)
		if native.meta.Cause != causeOf[why] || native.meta.Delivery != model.SubNotOwed {
			t.Errorf("ending %d, native: cause %q, delivery %q", why, native.meta.Cause, native.meta.Delivery)
		}
	}
}

// retryingChat is a chat object whose thread says retrying.
func retryingChat(t *testing.T) *Chat {
	t.Helper()
	tr := transcript.New(filepath.Join(t.TempDir(), "items.jsonl"))
	tr.SetStatus(model.StatusRetrying)
	return &Chat{tr: tr}
}

func TestRetryingIsWorkingNotBusy(t *testing.T) {
	t.Parallel()
	if got := pubOf(model.StatusRetrying); got != pubWorking {
		t.Errorf("pubOf(retrying) = %d, want pubWorking (%d)", got, pubWorking)
	}
	c := retryingChat(t)
	if busy(c) || inTurn(c) || waiting(c) {
		t.Errorf("a retrying chat is busy %v, in a turn %v, waiting %v; it takes the person's message", busy(c), inTurn(c), waiting(c))
	}
}

func TestViewCarriesRetry(t *testing.T) {
	t.Parallel()
	c := retryingChat(t)
	c.mu.Lock()
	defer c.mu.Unlock()
	if v := view(c); v.Retry != (model.Retry{}) || retrying(c) {
		t.Fatalf("a chat with no retry shows %+v", v.Retry)
	}
	c.retry = &retryWait{attempt: 2, kind: agent.TempServer, reason: "boom", at: time.UnixMilli(5000)}
	v := view(c)
	if v.Retry != c.retry.model() || v.Retry.Attempt != 2 || v.Retry.Of != 4 || v.Retry.At != 5000 || v.Retry.Kind != "server_error" || v.Retry.Error != "boom" || v.Status != model.StatusRetrying {
		t.Fatalf("the view of a retrying chat: %+v", v)
	}
	if !retrying(c) {
		t.Fatal("retrying(c) is false with a retry")
	}
}
