package editorbridge

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
)

// freeCalls collects the calls of OnBoardFree's hook, each with the holder the hook saw.
type freeCalls struct {
	t  *testing.T
	ch chan [2]string
}

// freeHookOf sets a hook that asks the bridge for the board's holder, as the real one does: it
// would block if it ran under the lock.
func freeHookOf(t *testing.T, b *Bridge) *freeCalls {
	h := &freeCalls{t: t, ch: make(chan [2]string, 64)}
	b.OnBoardFree(func(board string) {
		id, _ := b.HolderOf(board)
		h.ch <- [2]string{board, id}
	})
	return h
}

// want reads one call, which must be for this board, seen with no holder.
func (h *freeCalls) want(board string) {
	h.t.Helper()
	select {
	case got := <-h.ch:
		if got != [2]string{board, ""} {
			h.t.Fatalf("the hook got board %q held by %q, want %q held by nobody", got[0], got[1], board)
		}
	case <-time.After(bridgetest.Wait):
		h.t.Fatalf("the hook was not called for %s", board)
	}
}

// none fails the test when the hook is called within d.
func (h *freeCalls) none(d time.Duration) {
	h.t.Helper()
	select {
	case got := <-h.ch:
		h.t.Fatalf("the hook was called with %v", got)
	case <-time.After(d):
	}
}

// An API client that holds a board is asked to release it when another client takes it, and
// hands it over: to a page, and to another API client.
func TestAPIClientTakesAndHandsOver(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.SceneRev = func(string) int64 { return 7 }
	b.handoverAfter, b.apiHandoverAfter = time.Hour, time.Hour
	api := newAPIServer(t, b, nil)
	p := open(t, srv, "P")
	x, y := openAPI(t, api, "X"), openAPI(t, api, "Y")

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

// The delay of a hand-off is the holder's: an API client that stays silent has its own, longer
// one, and a page the pages' one, whoever waits.
func TestSilentAPIHolderHasItsOwnDelay(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	api := newAPIServer(t, b, nil)
	p := open(t, srv, "P")
	x := openAPI(t, api, "X")

	// The API client holds: its delay runs, not the pages', which would never end here.
	const delay = 150 * time.Millisecond
	b.handoverAfter, b.apiHandoverAfter = time.Hour, delay
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

	// The page holds and an API client waits: the pages' delay runs.
	b.mu.Lock()
	b.handoverAfter, b.apiHandoverAfter = delay, time.Hour
	b.mu.Unlock()
	start = time.Now()
	take(t, b, "X", "b1", false, "waiting")
	expectBoard(t, p, "release_request", "b1")
	expectBoard(t, x, "held", "b1")
	if d := time.Since(start); d < delay-10*time.Millisecond {
		t.Fatalf("handed over after %s, before the delay", d)
	}
	expectBoard(t, p, "superseded", "b1")
}

// A call never gives an API client a board. Asked as the holder of the chat's board about a
// target nobody holds, it gets the call alone, about no board: no hand-off of the target fails
// it.
func TestCallGivesAPIClientNoBoard(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter, b.apiHandoverAfter = time.Hour, time.Hour
	api := newAPIServer(t, b, nil)
	p := open(t, srv, "P")
	if !b.Acted("P") {
		t.Fatal("Acted is false for a page")
	}
	x := openAPI(t, api, "X")
	take(t, b, "X", "home", false, "held")
	b.MarkBoard("b1", "X")

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
	// The page behind the API client takes the target itself, and lets it go again: the call
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

	// A free board that is not the API client's, the server's own or another client's, is not
	// asked of it: the page that acted last is asked, and is given the target.
	b.MarkBoard("other", "Y")
	p.OnRPC(func(map[string]any) (any, string) { return "from P", "" })
	for _, target := range []string{"own", "other"} {
		v, err := b.CallBoard(CallSpec{Method: "tool", Board: target, ChatBoard: "home"}, bridgetest.Wait)
		if err != nil || string(v) != `"from P"` {
			t.Fatalf("the call about the board %s = %s, %v", target, v, err)
		}
		expectBoard(t, p, "held", target)
		if h, _ := b.HolderOf(target); h != "P" {
			t.Fatalf("the board %s is held by %q, want P", target, h)
		}
	}
	if got := x.Drain(20 * time.Millisecond); len(got) != 0 {
		t.Fatalf("the API client got %v", got)
	}

	// A call about a board the API client holds is about that board: losing it fails the call.
	done = goCall(b, CallSpec{Method: "tool", Board: "home"}, bridgetest.Wait)
	x.Expect("rpc")
	b.LoseBoard("home")
	expectBoard(t, x, "superseded", "home")
	if r := expectResult(t, done); !errors.Is(r.err, ErrNoClient) {
		t.Fatalf("the call on the lost board ended with %v", r.err)
	}
	// With the chat's board free the page that acted last is asked, and is given the target.
	v, err := b.CallBoard(CallSpec{Method: "tool", Board: "b3", ChatBoard: "home"}, bridgetest.Wait)
	if err != nil || string(v) != `"from P"` {
		t.Fatalf("CallBoard = %s, %v", v, err)
	}
	expectBoard(t, p, "held", "b3")
	if got := x.Drain(20 * time.Millisecond); len(got) != 0 {
		t.Fatalf("the API client got %v", got)
	}

	// With no page that acted, a free board that is not the API client's has no client to ask.
	take(t, b, "X", "home", false, "held")
	p.Close()
	waitFor(t, func() bool { return !b.Acted("P") })
	if _, err := b.CallBoard(CallSpec{Method: "tool", Board: "own2", ChatBoard: "home"}, bridgetest.Wait); !errors.Is(err, ErrNoClient) {
		t.Fatalf("the call with no page ended with %v, want ErrNoClient", err)
	}
	if got := x.Drain(20 * time.Millisecond); len(got) != 0 {
		t.Fatalf("the API client got %v", got)
	}
}

// SendTo reaches the one open stream with the id, of either kind, and reports a missing one.
func TestSendTo(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	api := newAPIServer(t, b, nil)
	p, q := open(t, srv, "P"), open(t, srv, "Q")
	x := openAPI(t, api, "X")

	if !b.SendTo("P", map[string]any{"type": "held", "board": "b1", "rev": 4}) {
		t.Fatal("SendTo reported no stream for a page")
	}
	if ev := expectBoard(t, p, "held", "b1"); ev["rev"] != float64(4) {
		t.Fatalf("held = %v", ev)
	}
	if _, ok := b.HolderOf("b1"); ok {
		t.Fatal("SendTo changed who holds the board")
	}
	// A role type the API kind's allow-list does not name: SendTo is not routed by the table.
	if !b.SendTo("X", map[string]any{"type": "rpc", "id": "far_1", "method": "m"}) {
		t.Fatal("SendTo reported no stream for an API client")
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
	q.Expect("agents") // the other page got none of them
	x.Expect("agents")
}

// LoseBoard takes the board at once: the holder and the waiter are told, the holder's calls on
// the board fail, nobody is asked to release, and the board is free.
func TestLoseBoard(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter, b.apiHandoverAfter = time.Hour, time.Hour
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

// The hook runs once for each end of a hold that leaves the board free, outside the lock, and
// not when the board goes to a waiter.
func TestOnBoardFree(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter, b.apiHandoverAfter = time.Hour, time.Hour
	api := newAPIServer(t, b, nil)
	h := freeHookOf(t, b)
	p := open(t, srv, "P")

	t.Run("release with no waiter", func(t *testing.T) {
		take(t, b, "P", "b1", false, "held")
		h.none(20 * time.Millisecond) // a take frees nothing
		if got := b.ReleaseBoard("P", "b1"); got != "free" {
			t.Fatalf("release = %q", got)
		}
		h.want("b1")
		if got := b.ReleaseBoard("P", "b1"); got != "none" { // no hold ended
			t.Fatalf("second release = %q", got)
		}
		h.none(20 * time.Millisecond)
	})
	t.Run("stream end", func(t *testing.T) {
		for _, kind := range []Kind{KindPage, KindAPI} {
			var c *bridgetest.Page
			if kind == KindPage {
				c = open(t, srv, "E")
			} else {
				c = openAPI(t, api, "E")
			}
			take(t, b, "E", "b1", false, "held")
			take(t, b, "E", "b2", false, "held")
			c.Close()
			waitGone(t, b, "E")
			got := map[string]bool{}
			for range 2 {
				select {
				case call := <-h.ch:
					got[call[0]] = call[1] == ""
				case <-time.After(bridgetest.Wait):
					t.Fatalf("%s: the hook got %v, want b1 and b2", kind, got)
				}
			}
			if !got["b1"] || !got["b2"] {
				t.Fatalf("%s: the hook got %v, want b1 and b2 with no holder", kind, got)
			}
		}
		h.none(20 * time.Millisecond)
	})
	t.Run("LoseBoard", func(t *testing.T) {
		q := open(t, srv, "Q")
		b.LoseBoard("b1") // free already
		h.none(20 * time.Millisecond)
		take(t, b, "P", "b1", false, "held")
		take(t, b, "Q", "b1", false, "waiting")
		b.LoseBoard("b1")
		h.want("b1")
		q.Close()
		waitGone(t, b, "Q")
		h.none(20 * time.Millisecond)
	})
	t.Run("FreeBoard", func(t *testing.T) {
		b.FreeBoard("b1", time.Hour) // no holder
		h.none(20 * time.Millisecond)
		// The holder stays silent.
		take(t, b, "P", "b1", false, "held")
		b.FreeBoard("b1", 50*time.Millisecond)
		h.want("b1")
		// The holder releases, with a client waiting too: the board stays free.
		q := open(t, srv, "Q")
		take(t, b, "P", "b1", false, "held")
		take(t, b, "Q", "b1", false, "waiting")
		done := make(chan struct{})
		go func() { b.FreeBoard("b1", time.Hour); close(done) }()
		waitFor(t, func() bool {
			b.mu.Lock()
			defer b.mu.Unlock()
			return b.freeing["b1"] != nil
		})
		if got := b.ReleaseBoard("P", "b1"); got != "handed" {
			t.Fatalf("release = %q", got)
		}
		<-done
		h.want("b1")
		q.Close()
		waitGone(t, b, "Q")
		h.none(20 * time.Millisecond)
	})
	t.Run("not when a waiter gets the board", func(t *testing.T) {
		open(t, srv, "Q")
		// By the holder's release.
		take(t, b, "P", "b1", false, "held")
		take(t, b, "Q", "b1", false, "waiting")
		if got := b.ReleaseBoard("P", "b1"); got != "handed" {
			t.Fatalf("release = %q", got)
		}
		// By the delay.
		b.mu.Lock()
		b.handoverAfter = 20 * time.Millisecond
		b.mu.Unlock()
		take(t, b, "P", "b1", false, "waiting")
		waitFor(t, func() bool { return b.Holds("P", "b1") })
		// By the end of the holder's stream.
		b.mu.Lock()
		b.handoverAfter = time.Hour
		b.mu.Unlock()
		take(t, b, "Q", "b1", false, "waiting")
		p.Close()
		waitFor(t, func() bool { return b.Holds("Q", "b1") })
		h.none(50 * time.Millisecond)
		// A nil hook is none.
		b.OnBoardFree(nil)
		if got := b.ReleaseBoard("Q", "b1"); got != "free" {
			t.Fatalf("release = %q", got)
		}
		h.none(20 * time.Millisecond)
	})
}

// A board event goes to every page, and to the API client whose mark the board carries. The
// mark ends with the board's removal.
func TestBoardMarksFilterEvents(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	api := newAPIServer(t, b, nil)
	p := open(t, srv, "P")
	x, y := openAPI(t, api, "X"), openAPI(t, api, "Y")
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

	b.MarkBoard("b1", "X")
	b.MarkBoard("b3", "Y")
	if b.MarkOf(Board("b1")) != "X" || b.MarkOf(Chat("b1")) != "" {
		t.Fatal("MarkBoard did not mark the board, or marked a chat")
	}
	sent("board", "b1", p, x)
	sent("board", "b2", p) // a board of the owner's
	sent("board", "b3", p, y)
	// A chat's mark with the board's id is another item's.
	b.SetMark(Chat("b2"), "X")
	sent("board", "b2", p)
	// A follow lists nothing, and holding the board does not either.
	b.Follow("Y", Board("b1"))
	take(t, b, "Y", "b1", false, "held")
	sent("board", "b1", p, x)

	// The removal reaches the marked client and ends the mark.
	sent("board_removed", "b1", p, x)
	if got := b.MarkOf(Board("b1")); got != "" {
		t.Fatalf("the mark of the removed board is %q", got)
	}
	sent("board", "b1", p)
	sent("board_removed", "b1", p)
	if b.MarkOf(Board("b3")) != "Y" {
		t.Fatal("the removal ended another board's mark")
	}
	// The mark is of one client; "" removes it.
	b.MarkBoard("b3", "X")
	sent("board", "b3", p, x)
	b.MarkBoard("b3", "")
	sent("board", "b3", p)
	// Through Broadcast, as before the boards knew SendBoard, it reaches the pages alone.
	b.MarkBoard("b3", "X")
	b.Broadcast(map[string]any{"type": "board", "id": "b3"})
	s.send()
	for _, c := range all {
		if got := s.until(t, c); (len(got) == 1) != (c == p) {
			t.Errorf("a board event through Broadcast: client %s got %v", c.ID, got)
		}
	}
}
