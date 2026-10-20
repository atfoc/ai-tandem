package editorbridge

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
)

// quick is the call time of the tests below: short, because a test waits it out. What must happen
// is waited for up to bridgetest.Wait.
const quick = 150 * time.Millisecond

func TestUnansweredWindowLosesTheBoard(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	w := open(t, srv, "W")
	r := open(t, srv, "R")
	take(t, b, "W", "b1", false, "held")
	b.FollowBoard("R", "b1")

	start := time.Now()
	_, err := b.CallBoard(CallSpec{Method: "tool", Board: "b1"}, quick)
	if !errors.Is(err, ErrUnanswered) || errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want ErrUnanswered and not ErrTimeout", err)
	}
	if want := "the window that held the board did not answer tool in 150ms"; err.Error() != want {
		t.Fatalf("err = %q, want %q", err, want)
	}
	if time.Since(start) < quick {
		t.Fatal("the call ended before its time")
	}
	if b.Holds("W", "b1") || b.HeldCount("W") != 0 || b.HasCalls("W") {
		t.Fatal("the window still holds the board or has a call open")
	}
	if id, ok := b.HolderOf("b1"); ok || b.WriterOf("b1") != "" {
		t.Fatalf("the board is held by %q", id)
	}
	w.Expect("rpc")
	expectBoard(t, w, "superseded", "b1")
	w.ExpectNone(30 * time.Millisecond)
	if k := writerEvent(t, r, "b1"); k != "" {
		t.Fatalf("writer = %q, want none", k)
	}
	r.ExpectNone(30 * time.Millisecond)
}

func TestUnansweredCallLateReplyAndSaveAreIgnored(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	w := open(t, srv, "W")
	take(t, b, "W", "b1", false, "held")
	_, err := b.CallBoard(CallSpec{Method: "tool", Board: "b1"}, quick)
	if !errors.Is(err, ErrUnanswered) {
		t.Fatalf("err = %v", err)
	}
	id := w.Expect("rpc")["id"].(string)
	if b.ReplyFrom("W", id, RPCReply{Result: json.RawMessage(`"late"`)}) {
		t.Fatal("ReplyFrom took the reply to a call that had ended")
	}
	// The route answers 409 for it, as for any forgotten call.
	if code, _ := w.Do("POST", "/api/rpc-reply", map[string]any{"id": id, "result": "late"}); code != 409 {
		t.Fatalf("rpc-reply = %d, want 409", code)
	}
	if b.Holds("W", "b1") {
		t.Fatal("a late reply gave the board back")
	}
}

func TestUnansweredAnsweredInTimeKeepsTheBoard(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	w := open(t, srv, "W")
	take(t, b, "W", "b1", false, "held")
	w.OnRPC(func(map[string]any) (any, string) {
		time.Sleep(quick / 3)
		return "ok", ""
	})
	v, err := b.CallBoard(CallSpec{Method: "tool", Board: "b1"}, bridgetest.Wait)
	if err != nil || string(v) != `"ok"` {
		t.Fatalf("call = %s, %v", v, err)
	}
	// The window answered in a third of the call time: the next call is answered within it too.
	if _, err := b.CallBoard(CallSpec{Method: "tool", Board: "b1"}, quick); err != nil {
		t.Fatalf("second call: %v", err)
	}
	if !b.Holds("W", "b1") || b.WriterOf("b1") != "window" {
		t.Fatal("the window that answered lost the board")
	}
	w.ExpectNone(30 * time.Millisecond)
}

func TestUnansweredAwayClientKeepsTheBoard(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.SetAway("H")
	h := open(t, srv, "H")
	r := open(t, srv, "R")
	b.FollowBoard("R", "b1")
	_, err := b.CallBoard(CallSpec{Method: "tool", Board: "b1", Away: true}, quick)
	if !errors.Is(err, ErrTimeout) || errors.Is(err, ErrUnanswered) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	if id, ok := b.HolderOf("b1"); !ok || id != "H" || b.WriterOf("b1") != "headless" {
		t.Fatalf("holder = %q, %v", id, ok)
	}
	expectBoard(t, h, "held", "b1")
	h.Expect("rpc")
	h.ExpectNone(30 * time.Millisecond) // no superseded
	if k := writerEvent(t, r, "b1"); k != "headless" {
		t.Fatalf("writer = %q", k)
	}
	r.ExpectNone(30 * time.Millisecond) // and no second one
}

func TestUnansweredScreenCallFreesNothing(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	w := open(t, srv, "W")
	take(t, b, "W", "chat", false, "held")
	b.FollowBoard("W", "chat")
	_, err := b.CallBoard(CallSpec{Method: "get_view", Screen: true, ChatBoard: "chat"}, quick)
	if !errors.Is(err, ErrTimeout) || errors.Is(err, ErrUnanswered) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	if !b.Holds("W", "chat") || b.HasCalls("W") {
		t.Fatal("a screen call that timed out changed the board's holder or stayed open")
	}
	w.Expect("rpc")
	w.ExpectNone(30 * time.Millisecond)
}

func TestUnansweredTwoCallsFreeTheBoardOnce(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	w := open(t, srv, "W")
	r := open(t, srv, "R")
	take(t, b, "W", "b1", false, "held")
	take(t, b, "W", "b2", false, "held")
	b.FollowBoard("R", "b1")

	d1 := goCall(b, CallSpec{Method: "one", Board: "b1"}, quick)
	w.Expect("rpc")
	d2 := goCall(b, CallSpec{Method: "two", Board: "b1"}, 3*quick)
	w.Expect("rpc")
	other := goCall(b, CallSpec{Method: "other", Board: "b2"}, 3*quick)
	w.Expect("rpc")

	r1, r2 := expectResult(t, d1), expectResult(t, d2)
	if !errors.Is(r1.err, ErrUnanswered) || !errors.Is(r2.err, ErrUnanswered) {
		t.Fatalf("errs = %v, %v", r1.err, r2.err)
	}
	for _, e := range []error{r1.err, r2.err} {
		if errors.Is(e, ErrTimeout) || errors.Is(e, ErrTaken) {
			t.Fatalf("err = %v, want ErrUnanswered alone", e)
		}
	}
	if b.Holds("W", "b1") || !b.Holds("W", "b2") {
		t.Fatal("the board of the call was not freed or the other board was")
	}
	expectBoard(t, w, "superseded", "b1")
	// The call about the other board ends in its own time, and frees its own board.
	if ro := expectResult(t, other); !errors.Is(ro.err, ErrUnanswered) {
		t.Fatalf("other: %v", ro.err)
	}
	expectBoard(t, w, "superseded", "b2")
	w.ExpectNone(30 * time.Millisecond)
	if k := writerEvent(t, r, "b1"); k != "" {
		t.Fatalf("writer = %q", k)
	}
	r.ExpectNone(30 * time.Millisecond) // one writer event for b1, not two
	if b.HasCalls("W") {
		t.Fatal("a call is left open")
	}
}

func TestUnansweredWaiterGetsTheBoard(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter = time.Hour
	w := open(t, srv, "W")
	x := open(t, srv, "X")
	r := open(t, srv, "R")
	b.FollowBoard("R", "b1")
	take(t, b, "W", "b1", false, "held")
	if k := writerEvent(t, r, "b1"); k != "window" {
		t.Fatalf("writer = %q", k)
	}
	done := goCall(b, CallSpec{Method: "tool", Board: "b1"}, quick)
	w.Expect("rpc")
	take(t, b, "X", "b1", false, "waiting")
	expectBoard(t, w, "release_request", "b1")

	if res := expectResult(t, done); !errors.Is(res.err, ErrUnanswered) {
		t.Fatalf("err = %v", res.err)
	}
	expectBoard(t, w, "superseded", "b1")
	expectBoard(t, x, "held", "b1")
	if id, ok := b.HolderOf("b1"); !ok || id != "X" || b.HasCalls("W") {
		t.Fatalf("holder = %q, %v", id, ok)
	}
	if k := writerEvent(t, r, "b1"); k != "window" {
		t.Fatalf("writer = %q", k)
	}
	r.ExpectNone(30 * time.Millisecond) // exactly one
	x.ExpectNone(30 * time.Millisecond)
	// The hand-off timer was stopped: X is not given the board twice.
	if len(b.waiters) != 0 {
		t.Fatal("a waiter is left")
	}
}

func TestUnansweredFreeBoardWaiterCompletes(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	w := open(t, srv, "W")
	take(t, b, "W", "b1", false, "held")
	done := goCall(b, CallSpec{Method: "tool", Board: "b1"}, quick)
	w.Expect("rpc")
	fd := make(chan struct{})
	go func() { b.FreeBoard("b1", bridgetest.Wait); close(fd) }()
	// The window is silent, so the call times out first (FreeBoard waits longer) and frees the
	// board, which completes FreeBoard.
	if res := expectResult(t, done); !errors.Is(res.err, ErrUnanswered) {
		t.Fatalf("err = %v", res.err)
	}
	select {
	case <-fd:
	case <-time.After(bridgetest.Wait):
		t.Fatal("FreeBoard did not complete")
	}
	if _, ok := b.HolderOf("b1"); ok {
		t.Fatal("the board is held")
	}
}

func TestUnansweredBoardGoesToTheAwayClientAtOnce(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.SetAway("H")
	h := open(t, srv, "H")
	w := open(t, srv, "W")
	take(t, b, "W", "b1", false, "held")
	_, err := b.CallBoard(CallSpec{Method: "tool", Board: "b1", Away: true}, quick)
	if !errors.Is(err, ErrUnanswered) {
		t.Fatalf("err = %v", err)
	}
	w.Expect("rpc")

	h.OnRPC(func(map[string]any) (any, string) { return "from the headless writer", "" })
	start := time.Now()
	v, err := b.CallBoard(CallSpec{Method: "tool", Board: "b1", Away: true}, bridgetest.Wait)
	if err != nil || string(v) != `"from the headless writer"` {
		t.Fatalf("call = %s, %v", v, err)
	}
	if time.Since(start) > bridgetest.Wait/2 {
		t.Fatal("the next call waited")
	}
	if id, ok := b.HolderOf("b1"); !ok || id != "H" || b.WriterOf("b1") != "headless" {
		t.Fatalf("holder = %q, %v", id, ok)
	}
	// Without Away the board is free and there is nobody to ask.
	if _, err := b.CallBoard(CallSpec{Method: "tool", Board: "b9"}, quick); !errors.Is(err, ErrNoClient) {
		t.Fatalf("err = %v", err)
	}
}

func TestUnansweredTextsAreDistinct(t *testing.T) {
	t.Parallel()
	if errors.Is(ErrUnanswered, ErrTimeout) || errors.Is(ErrTimeout, ErrUnanswered) {
		t.Fatal("ErrUnanswered and ErrTimeout must never be confused")
	}
	if !strings.Contains(ErrUnanswered.Error(), "did not answer") {
		t.Fatal("ErrUnanswered's text changed")
	}
}
