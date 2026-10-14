package editorbridge

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
)

// A client that holds a board is asked to release it when another client takes it, and hands it
// over to the one that waits.
func TestAPIClientTakesAndHandsOver(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.SceneRev = func(string) int64 { return 7 }
	b.handoverAfter = time.Hour
	p := open(t, srv, "P")
	x, y := open(t, srv, "X"), open(t, srv, "Y")

	if rev := take(t, b, "X", "b1", false, "held"); rev != 7 {
		t.Fatalf("rev = %d", rev)
	}
	// A page takes it ("Use here"): the API client is asked once, releases, and is told.
	take(t, b, "P", "b1", false, "waiting")
	expectBoard(t, x, "release_request", "b1")
	take(t, b, "P", "b1", false, "waiting") // again: no second request
	if got := b.ReleaseBoard("X", "b1"); got != "handed" {
		t.Fatalf("release = %q", got)
	}
	expectBoard(t, x, "superseded", "b1")
	if ev := expectBoard(t, p, "held", "b1"); ev["rev"] != float64(7) {
		t.Fatalf("held = %v", ev)
	}

	// The API client takes it back, another one takes its place as the waiter, and gets it.
	take(t, b, "X", "b1", false, "waiting")
	expectBoard(t, p, "release_request", "b1")
	take(t, b, "Y", "b1", false, "waiting")
	expectBoard(t, x, "superseded", "b1")
	if got := b.ReleaseBoard("P", "b1"); got != "handed" {
		t.Fatalf("release = %q", got)
	}
	expectBoard(t, p, "superseded", "b1")
	expectBoard(t, y, "held", "b1")

	// From one API client to another.
	take(t, b, "X", "b1", false, "waiting")
	expectBoard(t, y, "release_request", "b1")
	if got := b.ReleaseBoard("Y", "b1"); got != "handed" {
		t.Fatalf("release = %q", got)
	}
	expectBoard(t, y, "superseded", "b1")
	expectBoard(t, x, "held", "b1")
	if id, _ := b.HolderOf("b1"); id != "X" {
		t.Fatalf("holder = %q", id)
	}
	for _, c := range []*bridgetest.Page{p, x, y} {
		if got := c.Drain(20 * time.Millisecond); len(got) != 0 {
			t.Fatalf("client %s got %v", c.ID, got)
		}
	}
}

// A holder that stays silent loses the board when the delay has passed, and the one that waited
// gets it.
func TestSilentHolderHasTheHandoverDelay(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	p := open(t, srv, "P")
	x := open(t, srv, "X")

	const delay = 150 * time.Millisecond
	b.handoverAfter = delay
	take(t, b, "X", "b1", false, "held")
	start := time.Now()
	take(t, b, "P", "b1", false, "waiting")
	expectBoard(t, x, "release_request", "b1")
	expectBoard(t, p, "held", "b1")
	if d := time.Since(start); d < delay-10*time.Millisecond {
		t.Fatalf("handed over after %s, before the delay", d)
	}
	expectBoard(t, x, "superseded", "b1")
	if got := b.ReleaseBoard("X", "b1"); got != "none" {
		t.Fatalf("a late release = %q", got)
	}
}

// A call never gives a client a board. Asked as the holder of the chat's board about a target
// nobody holds, it gets the call alone, about no board: no hand-off of the target fails it.
func TestCallGivesAClientNoBoard(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter = time.Hour
	p := open(t, srv, "P")
	x := open(t, srv, "X")
	take(t, b, "X", "home", false, "held")

	done := goCall(b, CallSpec{Method: "tool", Board: "b1", ChatBoard: "home"}, bridgetest.Wait)
	rpc := x.Expect("rpc") // and no held before it
	id := rpc["id"].(string)
	if _, ok := b.HolderOf("b1"); ok {
		t.Fatal("the call gave the API client the board")
	}
	b.mu.Lock()
	k := b.rpcs[id]
	b.mu.Unlock()
	if k == nil || k.client != "X" || k.board != "" {
		t.Fatalf("the open call = %+v, want one of X about no board", k)
	}
	// The page behind the client takes the target itself, and lets it go again: the call
	// stays open.
	take(t, b, "X", "b1", false, "held")
	take(t, b, "P", "b1", false, "waiting")
	expectBoard(t, x, "release_request", "b1")
	if got := b.ReleaseBoard("X", "b1"); got != "handed" {
		t.Fatalf("release = %q", got)
	}
	expectBoard(t, x, "superseded", "b1")
	expectBoard(t, p, "held", "b1")
	expectOpen(t, done)
	if !b.ReplyFrom("X", id, RPCReply{Result: json.RawMessage(`"drawn"`)}) {
		t.Fatal("the reply was refused")
	}
	if r := expectResult(t, done); r.err != nil || string(r.v) != `"drawn"` {
		t.Fatalf("call = %s, %v", r.v, r.err)
	}

	// A screen call is asked of it as well, and gives nothing either.
	done = goCall(b, CallSpec{Method: "get_view", Board: "b2", ChatBoard: "home", Screen: true}, bridgetest.Wait)
	rpc = x.Expect("rpc")
	b.ReplyFrom("X", rpc["id"].(string), RPCReply{Result: json.RawMessage(`1`)})
	if r := expectResult(t, done); r.err != nil {
		t.Fatal(r.err)
	}
	if _, ok := b.HolderOf("b2"); ok {
		t.Fatal("the screen call gave a board")
	}

	// The holder of the chat's board is asked about every board of the server, and another
	// client is not.
	p.OnRPC(func(map[string]any) (any, string) { return "from P", "" })
	for _, target := range []string{"plain", "second", "other"} {
		done := goCall(b, CallSpec{Method: "tool", Board: target, ChatBoard: "home"}, bridgetest.Wait)
		rpc := x.Expect("rpc")
		if _, ok := b.HolderOf(target); ok {
			t.Fatalf("the call about the board %s gave it to somebody", target)
		}
		b.ReplyFrom("X", rpc["id"].(string), RPCReply{Result: json.RawMessage(`"from X"`)})
		if r := expectResult(t, done); r.err != nil || string(r.v) != `"from X"` {
			t.Fatalf("the call about the board %s = %s, %v", target, r.v, r.err)
		}
	}
	if got := p.Drain(20 * time.Millisecond); len(got) != 0 {
		t.Fatalf("the page got %v", got)
	}

	// A call about a board the client holds is about that board: losing it fails the call.
	done = goCall(b, CallSpec{Method: "tool", Board: "home"}, bridgetest.Wait)
	x.Expect("rpc")
	b.LoseBoard("home")
	expectBoard(t, x, "superseded", "home")
	if r := expectResult(t, done); !errors.Is(r.err, ErrNoClient) {
		t.Fatalf("the call on the lost board ended with %v", r.err)
	}
	// With the chat's board free there is no client to ask: a call never falls to a client that
	// holds nothing.
	if _, err := b.CallBoard(CallSpec{Method: "tool", Board: "b3", ChatBoard: "home"}, bridgetest.Wait); !errors.Is(err, ErrNoClient) {
		t.Fatalf("the call with the chat's board free ended with %v, want ErrNoClient", err)
	}
	for _, c := range []*bridgetest.Page{p, x} {
		if got := c.Drain(20 * time.Millisecond); len(got) != 0 {
			t.Fatalf("client %s got %v", c.ID, got)
		}
	}
}

// SendTo reaches the one open stream with the id, and reports a missing one.
func TestSendTo(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	p, q := open(t, srv, "P"), open(t, srv, "Q")
	x := open(t, srv, "X")

	if !b.SendTo("P", map[string]any{"type": "held", "board": "b1", "rev": 4}) {
		t.Fatal("SendTo reported no stream for P")
	}
	if ev := expectBoard(t, p, "held", "b1"); ev["rev"] != float64(4) {
		t.Fatalf("held = %v", ev)
	}
	if _, ok := b.HolderOf("b1"); ok {
		t.Fatal("SendTo changed who holds the board")
	}
	// A role type: SendTo is not routed by the table.
	if !b.SendTo("X", map[string]any{"type": "rpc", "id": "far_1", "method": "m"}) {
		t.Fatal("SendTo reported no stream for X")
	}
	if ev := x.Expect("rpc"); ev["id"] != "far_1" {
		t.Fatalf("rpc = %v", ev)
	}
	if b.SendTo("nobody", map[string]any{"type": "superseded", "board": "b1"}) {
		t.Fatal("SendTo reported a stream for an unknown id")
	}
	p.Close()
	waitGone(t, b, "P")
	if b.SendTo("P", map[string]any{"type": "superseded", "board": "b1"}) {
		t.Fatal("SendTo reported a stream after it ended")
	}
	b.Broadcast(map[string]any{"type": "agents"})
	q.Expect("agents") // the others got none of the sends above
	x.Expect("agents")
}

// LoseBoard takes the board at once: the holder and the waiter are told, the holder's calls on
// the board fail, nobody is asked to release, and the board is free.
func TestLoseBoard(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter = time.Hour
	p, q := open(t, srv, "P"), open(t, srv, "Q")

	b.LoseBoard("b1") // free: nothing

	// A holder alone: superseded, and no release_request before it.
	take(t, b, "P", "b1", false, "held")
	take(t, b, "P", "b2", false, "held")
	b.LoseBoard("b1")
	expectBoard(t, p, "superseded", "b1")
	if _, ok := b.HolderOf("b1"); ok {
		t.Fatal("b1 is still held")
	}
	if !b.Holds("P", "b2") {
		t.Fatal("LoseBoard took another board")
	}

	// A holder with calls and a waiter. The waiter's take asked the holder; LoseBoard asks
	// no second time.
	take(t, b, "P", "b1", false, "held")
	take(t, b, "Q", "b1", false, "waiting")
	expectBoard(t, p, "release_request", "b1")
	onB1 := goCall(b, CallSpec{Method: "tool", Board: "b1"}, bridgetest.Wait)
	p.Expect("rpc")
	onB2 := goCall(b, CallSpec{Method: "tool", Board: "b2"}, bridgetest.Wait)
	rpc := p.Expect("rpc")
	b.LoseBoard("b1")
	expectBoard(t, p, "superseded", "b1")
	expectBoard(t, q, "superseded", "b1")
	if r := expectResult(t, onB1); !errors.Is(r.err, ErrNoClient) {
		t.Fatalf("the call on b1 ended with %v", r.err)
	}
	expectOpen(t, onB2)
	b.ReplyFrom("P", rpc["id"].(string), RPCReply{Result: json.RawMessage(`1`)})
	if r := expectResult(t, onB2); r.err != nil {
		t.Fatal(r.err)
	}
	b.mu.Lock()
	waiters, waits := len(b.waiters), len(b.clients["Q"].waits)
	b.mu.Unlock()
	if waiters != 0 || waits != 0 {
		t.Fatalf("a wait is left: %d waiters, %d waits of Q", waiters, waits)
	}
	if got := b.ReleaseBoard("P", "b1"); got != "none" {
		t.Fatalf("release after the loss = %q", got)
	}
	take(t, b, "Q", "b1", true, "held") // free: the waiter was not given it

	// A FreeBoard that waits for the holder goes on.
	done := make(chan struct{})
	go func() { b.FreeBoard("b1", time.Hour); close(done) }()
	expectBoard(t, q, "release_request", "b1")
	b.LoseBoard("b1")
	select {
	case <-done:
	case <-time.After(bridgetest.Wait):
		t.Fatal("FreeBoard did not return after LoseBoard")
	}
	expectBoard(t, q, "superseded", "b1")
	for _, c := range []*bridgetest.Page{p, q} {
		if got := c.Drain(20 * time.Millisecond); len(got) != 0 {
			t.Fatalf("page %s got %v", c.ID, got)
		}
	}
}

// A board's events reach every client, whoever made the board: a follow and a hold decide
// nothing about them.
func TestBoardEventsReachEveryClient(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	p, x, y := open(t, srv, "P"), open(t, srv, "X"), open(t, srv, "Y")
	all := []*bridgetest.Page{p, x, y}
	s := &sentinel{b: b}
	// sent sends a board's event and checks that exactly these clients got it.
	sent := func(typ, board string, want ...*bridgetest.Page) {
		t.Helper()
		b.SendBoard(board, map[string]any{"type": typ, "id": board})
		s.send()
		for _, c := range all {
			exp := 0
			for _, w := range want {
				if w == c {
					exp = 1
				}
			}
			if got := s.until(t, c); len(got) != exp || (exp == 1 && got[0] != typ) {
				t.Errorf("%s of %s: client %s got %v, want %d", typ, board, c.ID, got, exp)
			}
		}
	}

	sent("board", "b1", all...)
	sent("board", "b2", all...)
	// A follow, or holding the board, changes nothing.
	b.Follow("Y", Board("b1"))
	take(t, b, "Y", "b1", false, "held")
	sent("board", "b1", all...)

	// The removal reaches every client.
	sent("board_removed", "b1", all...)
	sent("board", "b1", all...)
	sent("board_removed", "b2", all...)
	// Through Broadcast, which is for events of no board, it reaches nobody.
	b.Broadcast(map[string]any{"type": "board", "id": "b3"})
	s.send()
	for _, c := range all {
		if got := s.until(t, c); len(got) != 0 {
			t.Errorf("a board event through Broadcast: client %s got %v", c.ID, got)
		}
	}
}
