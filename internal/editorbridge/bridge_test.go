package editorbridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
)

// newTestServer serves a bridge's stream, and the reply route as the server does: the client
// is the one the header names.
func newTestServer(t *testing.T, snapshot func() any) (*Bridge, *httptest.Server) {
	t.Helper()
	b := New(snapshot)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/events", b.ServeSSE)
	mux.HandleFunc("POST /api/rpc-reply", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID string `json:"id"`
			RPCReply
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if !b.ReplyFrom(r.Header.Get(bridgetest.ClientHeader), body.ID, body.RPCReply) {
			w.WriteHeader(http.StatusConflict)
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return b, srv
}

// open connects a page and reads its hello and snapshot.
func open(t *testing.T, srv *httptest.Server, id string) *bridgetest.Page {
	t.Helper()
	p := bridgetest.Connect(t, srv.URL, id)
	p.Welcome()
	return p
}

// waitFor polls cond until it holds.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(bridgetest.Wait)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// take takes a board for a page and checks the answer's state.
func take(t *testing.T, b *Bridge, id, board string, ifFree bool, want string) int64 {
	t.Helper()
	state, rev, err := b.TakeBoard(id, board, ifFree)
	if err != nil || state != want {
		t.Fatalf("TakeBoard(%s, %s, %v) = %q, %v; want %q", id, board, ifFree, state, err, want)
	}
	return rev
}

// expectBoard reads the next event of a page: one of this type about this board.
func expectBoard(t *testing.T, p *bridgetest.Page, typ, board string) map[string]any {
	t.Helper()
	ev := p.Expect(typ)
	if ev["board"] != board {
		t.Fatalf("page %s: %s = %v, want board %s", p.ID, typ, ev, board)
	}
	return ev
}

type callResult struct {
	v   json.RawMessage
	err error
}

// goCall runs CallBoard on a goroutine.
func goCall(b *Bridge, spec CallSpec, timeout time.Duration) chan callResult {
	done := make(chan callResult, 1)
	go func() {
		v, err := b.CallBoard(spec, timeout)
		done <- callResult{v, err}
	}()
	return done
}

func expectResult(t *testing.T, done chan callResult) callResult {
	t.Helper()
	select {
	case r := <-done:
		return r
	case <-time.After(bridgetest.Wait):
		t.Fatal("the call did not end")
		return callResult{}
	}
}

func expectOpen(t *testing.T, done chan callResult) {
	t.Helper()
	select {
	case r := <-done:
		t.Fatalf("the call ended: %s, %v", r.v, r.err)
	case <-time.After(50 * time.Millisecond):
	}
}

// ---- streams ----

func TestFirstClientGetsHelloAndSnapshot(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, func() any { return map[string]any{"groups": []string{"g1"}} })
	a := bridgetest.Connect(t, srv.URL, "A")
	h := a.Expect("hello")
	if h["client"] != "A" {
		t.Fatalf("hello = %v", h)
	}
	if len(h) != 2 { // the type and the id, and nothing of the one active client
		t.Fatalf("hello = %v", h)
	}
	snap := a.Expect("snapshot")
	if g, _ := snap["groups"].([]any); len(g) != 1 || g[0] != "g1" {
		t.Fatalf("snapshot = %v", snap)
	}
	if !b.Known("A") || b.Known("B") {
		t.Fatal("A should be known, B not")
	}
}

func TestMissingClientID(t *testing.T) {
	t.Parallel()
	_, srv := newTestServer(t, nil)
	resp, err := srv.Client().Get(srv.URL + "/api/events")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestDefaultHandoverDelay(t *testing.T) {
	t.Parallel()
	b := New(nil)
	if b.handoverAfter != 3*time.Second {
		t.Fatal("handover delay is not 3s")
	}
	if apiHandoverDelay != 10*time.Second || b.apiHandoverAfter != apiHandoverDelay {
		t.Fatal("handover delay of an API holder is not 10s")
	}
	b.SetHandoverDelay(time.Millisecond)
	if b.handoverAfter != time.Millisecond || b.apiHandoverAfter != time.Millisecond {
		t.Fatal("SetHandoverDelay did not set both delays")
	}
}

// A second stream with a connected id replaces the first: the old record ends and the new one
// holds and follows nothing (AC38).
func TestSecondStreamWithConnectedIDReplacesFirst(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	a1 := open(t, srv, "A")
	w := open(t, srv, "W")
	take(t, b, "A", "b1", false, "held")
	take(t, b, "A", "b2", false, "held")
	take(t, b, "W", "b2", false, "waiting")
	expectBoard(t, a1, "release_request", "b2")
	if !b.Follow("A", Chat("c1")) || !b.Follow("A", Run("r1")) {
		t.Fatal("Follow refused a connected client")
	}
	done := goCall(b, CallSpec{Method: "tool", Board: "b1"}, 10*time.Second)
	a1.Expect("rpc")

	a2 := open(t, srv, "A")
	a1.ExpectEnded()
	a1.ExpectNone(10 * time.Millisecond) // the old stream got nothing more
	if r := expectResult(t, done); !errors.Is(r.err, ErrNoClient) {
		t.Fatalf("the old stream's call ended with %v", r.err)
	}
	expectBoard(t, w, "held", "b2")
	if id, ok := b.HolderOf("b1"); ok {
		t.Fatalf("b1 is held by %s after the reconnect", id)
	}
	if b.Holds("A", "b1") || b.Holds("A", "b2") || !b.Holds("W", "b2") {
		t.Fatal("the new stream holds a board of the old one")
	}
	if b.Followed(Chat("c1")) || b.Followed(Run("r1")) {
		t.Fatal("the new stream follows what the old one did")
	}
	if !b.Known("A") {
		t.Fatal("A should be known")
	}
	// The new stream is the client: it gets the events and can take the board again.
	b.Broadcast(map[string]any{"type": "groups"})
	a2.Expect("groups")
	b.SendChat("c1", false, map[string]any{"type": "chat_items"})
	b.Broadcast(map[string]any{"type": "catalog"})
	a2.Expect("catalog")
	take(t, b, "A", "b1", true, "held")
}

// A page that has only opened a stream is given no board and no tool call (AC38).
func TestStreamOnlyPageGetsNoBoardAndNoCall(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	a := open(t, srv, "A")

	start := time.Now()
	for _, spec := range []CallSpec{
		{Method: "tool", Board: "b1"},
		{Method: "tool", Board: "b1", ChatBoard: "b2"},
		{Method: "tool", Screen: true, ChatBoard: "b2"},
	} {
		if _, err := b.CallBoard(spec, 5*time.Second); !errors.Is(err, ErrNoClient) {
			t.Fatalf("%+v: err = %v", spec, err)
		}
	}
	if time.Since(start) > time.Second {
		t.Fatal("CallBoard did not fail at once")
	}
	if id, ok := b.HolderOf("b1"); ok {
		t.Fatalf("b1 was given to %s", id)
	}

	// A page that acted is chosen, also when the stream-only page is the newer one.
	c := open(t, srv, "C")
	if !b.Acted("C") {
		t.Fatal("Acted refused a connected client")
	}
	a2 := open(t, srv, "A2")
	done := goCall(b, CallSpec{Method: "tool", Board: "b1"}, 5*time.Second)
	expectBoard(t, c, "held", "b1")
	ev := c.Expect("rpc")
	if !b.ReplyFrom("C", ev["id"].(string), RPCReply{Result: json.RawMessage(`"ok"`)}) {
		t.Fatal("ReplyFrom refused the client that was asked")
	}
	if r := expectResult(t, done); r.err != nil {
		t.Fatal(r.err)
	}
	b.Broadcast(map[string]any{"type": "catalog"})
	a.Expect("catalog")
	a2.Expect("catalog")
	if b.Acted("nobody") {
		t.Fatal("Acted accepted an id with no stream")
	}
}

// ---- holding a board (AC39) ----

func TestTakeFreeBoard(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.SceneRev = func(board string) int64 {
		if board == "b1" {
			return 7
		}
		return 0
	}
	a := open(t, srv, "A")
	if rev := take(t, b, "A", "b1", false, "held"); rev != 7 {
		t.Fatalf("rev = %d", rev)
	}
	if rev := take(t, b, "A", "b1", true, "held"); rev != 7 { // already the caller's
		t.Fatalf("rev = %d", rev)
	}
	if rev := take(t, b, "A", "b2", true, "held"); rev != 0 {
		t.Fatalf("rev = %d", rev)
	}
	if id, ok := b.HolderOf("b1"); !ok || id != "A" {
		t.Fatalf("HolderOf(b1) = %q, %v", id, ok)
	}
	if !b.Holds("A", "b1") || b.Holds("A", "b3") || b.Holds("B", "b1") {
		t.Fatal("Holds is wrong")
	}
	if _, ok := b.HolderOf("b3"); ok {
		t.Fatal("b3 has a holder")
	}
	if _, _, err := b.TakeBoard("B", "b3", false); !errors.Is(err, ErrUnknownClient) {
		t.Fatalf("a take with no stream: %v", err)
	}
	a.ExpectNone(50 * time.Millisecond) // the answer carries the grant: no event

	if got := b.ReleaseBoard("A", "b1"); got != "free" {
		t.Fatalf("ReleaseBoard = %q", got)
	}
	if got := b.ReleaseBoard("A", "b1"); got != "none" {
		t.Fatalf("second ReleaseBoard = %q", got)
	}
	if got := b.ReleaseBoard("B", "b2"); got != "none" {
		t.Fatalf("ReleaseBoard with no stream = %q", got)
	}
	if _, ok := b.HolderOf("b1"); ok || !b.Holds("A", "b2") {
		t.Fatal("the release freed the wrong board")
	}
	a.ExpectNone(50 * time.Millisecond)
}

func TestTwoPagesHoldTwoBoards(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	a, c := open(t, srv, "A"), open(t, srv, "B")
	take(t, b, "A", "b1", false, "held")
	take(t, b, "B", "b2", false, "held")
	if !b.Holds("A", "b1") || !b.Holds("B", "b2") || b.Holds("A", "b2") || b.Holds("B", "b1") {
		t.Fatal("each page should hold its own board")
	}
	a.ExpectNone(50 * time.Millisecond)
	c.ExpectNone(50 * time.Millisecond)
}

func TestTakeHeldBoardWithRelease(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	var rev atomic.Int64
	rev.Store(3)
	b.SceneRev = func(string) int64 { return rev.Load() }
	a, c := open(t, srv, "A"), open(t, srv, "B")
	take(t, b, "A", "b1", false, "held")
	take(t, b, "A", "b2", false, "held")

	take(t, b, "B", "b1", false, "waiting")
	expectBoard(t, a, "release_request", "b1")
	take(t, b, "B", "b1", false, "waiting") // asking again changes nothing
	if !b.Holds("A", "b1") || b.Holds("B", "b1") {
		t.Fatal("A should hold b1 while B waits")
	}
	c.ExpectNone(100 * time.Millisecond)
	a.ExpectNone(10 * time.Millisecond)

	rev.Store(4) // the holder's last write
	if got := b.ReleaseBoard("A", "b1"); got != "handed" {
		t.Fatalf("ReleaseBoard = %q", got)
	}
	expectBoard(t, a, "superseded", "b1")
	if h := expectBoard(t, c, "held", "b1"); h["rev"] != float64(4) {
		t.Fatalf("held = %v, want the revision after the holder's write", h)
	}
	if !b.Holds("B", "b1") || b.Holds("A", "b1") {
		t.Fatal("B should hold b1")
	}
	// The old holder keeps its stream and its other board.
	if !b.Known("A") || !b.Holds("A", "b2") {
		t.Fatal("A lost more than b1")
	}
	b.Broadcast(map[string]any{"type": "groups"})
	a.Expect("groups")
	c.Expect("groups")
}

func TestSilentHolderLosesBoardAfterDelay(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter = 200 * time.Millisecond
	a, c := open(t, srv, "A"), open(t, srv, "B")
	take(t, b, "A", "b1", false, "held")
	start := time.Now()
	take(t, b, "B", "b1", false, "waiting")
	expectBoard(t, a, "release_request", "b1")
	expectBoard(t, c, "held", "b1")
	if d := time.Since(start); d < 190*time.Millisecond {
		t.Fatalf("granted after %s, before the handover delay", d)
	}
	expectBoard(t, a, "superseded", "b1")
	if !b.Holds("B", "b1") || b.Holds("A", "b1") || !b.Known("A") {
		t.Fatal("B should hold b1, and A keep its stream")
	}
	// A late release from the old holder changes nothing.
	if got := b.ReleaseBoard("A", "b1"); got != "none" {
		t.Fatalf("late ReleaseBoard = %q", got)
	}
	if !b.Holds("B", "b1") {
		t.Fatal("the late release took the board from B")
	}
}

func TestTakeIfFreeOfHeldBoardIsBusy(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter = 50 * time.Millisecond
	a, c := open(t, srv, "A"), open(t, srv, "B")
	take(t, b, "A", "b1", false, "held")
	take(t, b, "B", "b1", true, "busy")
	a.ExpectNone(150 * time.Millisecond) // no request, and no hand-off after the delay
	c.ExpectNone(10 * time.Millisecond)
	if !b.Holds("A", "b1") {
		t.Fatal("A should still hold b1")
	}
}

func TestSecondWaiterSupersedesFirst(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter = time.Minute
	a, w1, w2 := open(t, srv, "A"), open(t, srv, "B"), open(t, srv, "C")
	take(t, b, "A", "b1", false, "held")
	take(t, b, "B", "b1", false, "waiting")
	expectBoard(t, a, "release_request", "b1")
	b.mu.Lock()
	timer := b.waiters["b1"].timer
	b.mu.Unlock()

	take(t, b, "C", "b1", false, "waiting")
	expectBoard(t, w1, "superseded", "b1")
	b.mu.Lock()
	same := b.waiters["b1"].timer == timer
	b.mu.Unlock()
	if !same {
		t.Fatal("the second take restarted the hand-off timer")
	}
	if !b.Known("B") {
		t.Fatal("the first waiter lost its stream")
	}

	if got := b.ReleaseBoard("A", "b1"); got != "handed" {
		t.Fatalf("ReleaseBoard = %q", got)
	}
	expectBoard(t, w2, "held", "b1")
	expectBoard(t, a, "superseded", "b1") // and no second release_request before it
	w1.ExpectNone(50 * time.Millisecond)
	if !b.Holds("C", "b1") {
		t.Fatal("C should hold b1")
	}
}

func TestStreamEndPromotesWaiter(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter = time.Minute
	a, c := open(t, srv, "A"), open(t, srv, "B")
	take(t, b, "A", "b1", false, "held")
	take(t, b, "A", "b2", false, "held")
	take(t, b, "B", "b1", false, "waiting")
	expectBoard(t, a, "release_request", "b1")
	a.Close()
	expectBoard(t, c, "held", "b1")
	waitFor(t, func() bool { return !b.Known("A") })
	if !b.Holds("B", "b1") {
		t.Fatal("B should hold b1")
	}
	if id, ok := b.HolderOf("b2"); ok {
		t.Fatalf("b2 is still held by %s", id)
	}
}

func TestRegrant(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	var rev atomic.Int64
	b.SceneRev = func(string) int64 { return rev.Load() }
	a, c := open(t, srv, "A"), open(t, srv, "B")

	b.Regrant("b1", "A") // a free board
	take(t, b, "A", "b1", false, "held")
	rev.Store(1)
	b.Regrant("b1", "A") // the holder's own write
	a.ExpectNone(50 * time.Millisecond)
	c.ExpectNone(0)

	// B got the board at revision 1; A's write is stored after that.
	take(t, b, "B", "b1", false, "waiting")
	expectBoard(t, a, "release_request", "b1")
	if got := b.ReleaseBoard("A", "b1"); got != "handed" {
		t.Fatalf("ReleaseBoard = %q", got)
	}
	if ev := expectBoard(t, c, "held", "b1"); ev["rev"] != float64(1) {
		t.Fatalf("B's grant: %v", ev)
	}
	rev.Store(2)
	b.Regrant("b1", "A")
	if ev := expectBoard(t, c, "held", "b1"); ev["rev"] != float64(2) {
		t.Fatalf("B's second held: %v, want revision 2", ev)
	}
	b.Regrant("b1", "") // a write with no client id
	if ev := expectBoard(t, c, "held", "b1"); ev["rev"] != float64(2) {
		t.Fatalf("B's third held: %v", ev)
	}
	b.Regrant("b2", "A") // another board, free
	c.ExpectNone(50 * time.Millisecond)
	expectBoard(t, a, "superseded", "b1")
	a.ExpectNone(0)
	if !b.Holds("B", "b1") {
		t.Fatal("B should still hold b1")
	}
}

func TestStreamEndRemovesItsWait(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter = 100 * time.Millisecond
	a, c := open(t, srv, "A"), open(t, srv, "B")
	take(t, b, "A", "b1", false, "held")
	take(t, b, "B", "b1", false, "waiting")
	expectBoard(t, a, "release_request", "b1")
	c.Close()
	waitFor(t, func() bool { return !b.Known("B") })
	a.ExpectNone(200 * time.Millisecond) // the timer went with the waiter
	if !b.Holds("A", "b1") {
		t.Fatal("A should still hold b1")
	}
	if got := b.ReleaseBoard("A", "b1"); got != "free" {
		t.Fatalf("ReleaseBoard = %q", got)
	}
}

func TestReconnectHoldsNothing(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	a := open(t, srv, "A")
	take(t, b, "A", "b1", false, "held")
	a.Close()
	waitFor(t, func() bool { return !b.Known("A") })
	if _, ok := b.HolderOf("b1"); ok {
		t.Fatal("b1 is held with no stream")
	}
	c := open(t, srv, "B")
	take(t, b, "B", "b1", true, "held")
	a2 := open(t, srv, "A")
	if b.Holds("A", "b1") {
		t.Fatal("the reconnect took the board back")
	}
	take(t, b, "A", "b1", true, "busy")
	a2.ExpectNone(50 * time.Millisecond)
	c.ExpectNone(10 * time.Millisecond)
}

func TestFreeBoard(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter = time.Minute

	// No holder: at once.
	start := time.Now()
	b.FreeBoard("b1", 5*time.Second)
	if time.Since(start) > time.Second {
		t.Fatal("FreeBoard waited with no holder")
	}

	// The holder releases: FreeBoard goes on at once, and the board is free.
	a, c := open(t, srv, "A"), open(t, srv, "B")
	take(t, b, "A", "b1", false, "held")
	take(t, b, "A", "b2", false, "held")
	done := make(chan struct{})
	go func() { b.FreeBoard("b1", 10*time.Second); close(done) }()
	expectBoard(t, a, "release_request", "b1")
	select {
	case <-done:
		t.Fatal("FreeBoard did not wait for the holder")
	case <-time.After(50 * time.Millisecond):
	}
	// A take in the meantime waits, and asks the holder no second time.
	take(t, b, "B", "b1", false, "waiting")
	if got := b.ReleaseBoard("A", "b1"); got != "handed" {
		t.Fatalf("ReleaseBoard = %q", got)
	}
	select {
	case <-done:
	case <-time.After(bridgetest.Wait):
		t.Fatal("FreeBoard did not return after the release")
	}
	expectBoard(t, a, "superseded", "b1")
	expectBoard(t, c, "superseded", "b1")
	if id, ok := b.HolderOf("b1"); ok {
		t.Fatalf("b1 is held by %s", id)
	}
	if !b.Holds("A", "b2") {
		t.Fatal("FreeBoard took another board")
	}

	// A silent holder: after the wait it loses the board, its calls on it fail, and the
	// waiter is told.
	take(t, b, "B", "b2", false, "waiting")
	expectBoard(t, a, "release_request", "b2")
	onB2 := goCall(b, CallSpec{Method: "tool", Board: "b2"}, 10*time.Second)
	a.Expect("rpc")
	start = time.Now()
	b.FreeBoard("b2", 150*time.Millisecond)
	if d := time.Since(start); d < 140*time.Millisecond {
		t.Fatalf("FreeBoard returned after %s, before its wait", d)
	}
	expectBoard(t, a, "superseded", "b2") // and no second release_request before it
	expectBoard(t, c, "superseded", "b2")
	if r := expectResult(t, onB2); !errors.Is(r.err, ErrNoClient) {
		t.Fatalf("the call on b2 ended with %v", r.err)
	}
	if _, ok := b.HolderOf("b2"); ok {
		t.Fatal("b2 is still held")
	}
	take(t, b, "B", "b2", true, "held")
}

// Many clients keep taking one board, each releasing when it is asked. No client is granted the
// board before the one before it let go.
func TestOneHolderAtATime(t *testing.T) {
	t.Parallel()
	b := New(nil)
	b.handoverAfter = time.Minute
	const clients, grants = 6, 150
	var mu sync.Mutex
	holder, total := "", 0
	enough := make(chan struct{})
	got := func(id string) {
		mu.Lock()
		defer mu.Unlock()
		if holder != "" {
			t.Errorf("%s was granted the board while %s held it", id, holder)
		}
		holder = id
		if total++; total == grants {
			close(enough)
		}
	}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for i := range clients {
		c := newClient(fmt.Sprintf("c%d", i), KindPage)
		b.mu.Lock()
		b.startLocked(c)
		b.mu.Unlock()
		wg.Add(1)
		go func() {
			defer wg.Done()
			held, own := false, 0 // own: superseded events of its own releases still to come
			try := func() {
				if state, _, _ := b.TakeBoard(c.id, "b", false); state == "held" {
					got(c.id)
					held = true
				}
			}
			try()
			for {
				var msg []byte
				select {
				case msg = <-c.ch:
				case <-stop:
					return
				}
				var ev map[string]any
				_ = json.Unmarshal(msg, &ev)
				switch ev["type"] {
				case "held":
					got(c.id)
					held = true
				case "superseded":
					if own > 0 {
						own--
					} else {
						try() // another waiter took its place
					}
				case "release_request":
					if !held {
						t.Errorf("%s was asked to release a board it does not hold", c.id)
						continue
					}
					mu.Lock()
					holder = ""
					mu.Unlock()
					held = false
					if b.ReleaseBoard(c.id, "b") == "handed" {
						own++
					}
					try()
				}
			}
		}()
	}
	select {
	case <-enough:
	case <-time.After(20 * time.Second):
		t.Error("the board stopped going round")
	}
	close(stop)
	wg.Wait()
}

// Random takes, releases, calls and stream ends from many goroutines keep the records
// consistent: a board has one holder, and a waiter only while it is held.
func TestRecordsStayConsistent(t *testing.T) {
	t.Parallel()
	b := New(nil)
	b.handoverAfter = time.Millisecond
	ids := []string{"c0", "c1", "c2", "c3", "c4"}
	boards := []string{"b0", "b1", "b2"}
	check := func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		for board, h := range b.holders {
			if !h.holds[board] || b.clients[h.id] != h {
				t.Errorf("%s: holder %s has no such hold, or no stream", board, h.id)
			}
		}
		for board, w := range b.waiters {
			if b.holders[board] == nil || b.holders[board] == w.c {
				t.Errorf("%s: a waiter with no other holder", board)
			}
			if !w.c.waits[board] || b.clients[w.c.id] != w.c {
				t.Errorf("%s: waiter %s has no such wait, or no stream", board, w.c.id)
			}
		}
		for board := range b.freeing {
			if b.holders[board] == nil {
				t.Errorf("%s: FreeBoard waits for a free board", board)
			}
		}
		for _, c := range b.clients {
			for board := range c.holds {
				if b.holders[board] != c {
					t.Errorf("%s: %s holds it too", board, c.id)
				}
			}
			for board := range c.waits {
				if w := b.waiters[board]; w == nil || w.c != c {
					t.Errorf("%s: %s waits unrecorded", board, c.id)
				}
			}
			for id, k := range c.calls {
				if b.rpcs[id] != k || k.client != c.id || (k.board != "" && !c.holds[k.board]) {
					t.Errorf("call %s of %s on %q is out of place", id, c.id, k.board)
				}
			}
		}
		for id, k := range b.rpcs {
			if c := b.clients[k.client]; c == nil || c.calls[id] != k {
				t.Errorf("call %s has no client", id)
			}
		}
	}
	var wg sync.WaitGroup
	for g := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rnd := rand.New(rand.NewSource(int64(g)))
			for range 300 {
				id, board := ids[rnd.Intn(len(ids))], boards[rnd.Intn(len(boards))]
				switch rnd.Intn(9) {
				case 0, 1, 2:
					b.TakeBoard(id, board, rnd.Intn(2) == 0)
				case 3, 4:
					b.ReleaseBoard(id, board)
				case 5:
					b.CallBoard(CallSpec{Method: "tool", Board: board, ChatBoard: boards[0], Screen: rnd.Intn(3) == 0}, time.Millisecond)
				case 6:
					b.FreeBoard(board, time.Millisecond)
				case 7:
					b.mu.Lock()
					b.startLocked(newClient(id, KindPage)) // a reconnect
					b.mu.Unlock()
				case 8:
					b.mu.Lock()
					if c := b.clients[id]; c != nil {
						b.endLocked(c)
					}
					b.mu.Unlock()
				}
				check()
			}
		}()
	}
	wg.Wait()
	// Every hand-off timer has ended or was stopped: nothing changes any more.
	time.Sleep(20 * time.Millisecond)
	check()
}

// ---- board calls (AC40) ----

func TestCallGoesToHolderOfTarget(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	a, c := open(t, srv, "A"), open(t, srv, "B")
	take(t, b, "A", "b1", false, "held")
	take(t, b, "B", "b2", false, "held") // B is the chat's holder and acted last
	done := goCall(b, CallSpec{Method: "tool", Params: map[string]any{"name": "read_board"}, Board: "b1", ChatBoard: "b2"}, 5*time.Second)
	ev := a.Expect("rpc")
	if ev["method"] != "tool" || ev["params"].(map[string]any)["name"] != "read_board" {
		t.Fatalf("rpc = %v", ev)
	}
	c.ExpectNone(50 * time.Millisecond)
	if !b.ReplyFrom("A", ev["id"].(string), RPCReply{Result: json.RawMessage(`{"ok":true}`)}) {
		t.Fatal("ReplyFrom refused the holder")
	}
	if r := expectResult(t, done); r.err != nil || string(r.v) != `{"ok":true}` {
		t.Fatalf("got %s, %v", r.v, r.err)
	}

	// An error reply becomes the call's error. The page answers through the reply route.
	a.OnRPC(func(params map[string]any) (any, string) { return nil, "no such element" })
	if _, err := b.CallBoard(CallSpec{Method: "tool", Board: "b1"}, 5*time.Second); err == nil || err.Error() != "no such element" {
		t.Fatalf("err = %v", err)
	}
	a.OnRPC(func(params map[string]any) (any, string) { return params["name"], "" })
	v, err := b.CallBoard(CallSpec{Method: "tool", Params: map[string]any{"name": "apply"}, Board: "b1"}, 5*time.Second)
	if err != nil || string(v) != `"apply"` {
		t.Fatalf("got %s, %v", v, err)
	}
}

func TestCallOnFreeTargetGoesToHolderOfChatBoard(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.SceneRev = func(board string) int64 { return int64(len(board)) }
	a, c := open(t, srv, "A"), open(t, srv, "B")
	take(t, b, "A", "chat", false, "held")
	b.Acted("B") // B acted last, and is not chosen
	done := goCall(b, CallSpec{Method: "tool", Board: "target", ChatBoard: "chat"}, 5*time.Second)
	if h := expectBoard(t, a, "held", "target"); h["rev"] != float64(6) {
		t.Fatalf("held = %v", h)
	}
	ev := a.Expect("rpc") // after held
	if !b.Holds("A", "target") || !b.Holds("A", "chat") {
		t.Fatal("A should hold the target and the chat's board")
	}
	c.ExpectNone(50 * time.Millisecond)
	b.ReplyFrom("A", ev["id"].(string), RPCReply{})
	if r := expectResult(t, done); r.err != nil {
		t.Fatal(r.err)
	}

	// The next call on the target finds its holder: no second grant.
	done = goCall(b, CallSpec{Method: "tool", Board: "target", ChatBoard: "other"}, 5*time.Second)
	ev = a.Expect("rpc")
	b.ReplyFrom("A", ev["id"].(string), RPCReply{})
	expectResult(t, done)
}

func TestCallFallsBackToLastPageThatActed(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	a, c := open(t, srv, "A"), open(t, srv, "B")
	b.Acted("B")
	b.Acted("A")
	b.Acted("B")
	n := open(t, srv, "N") // the newest stream, which only opened it

	done := goCall(b, CallSpec{Method: "tool", Board: "b1", ChatBoard: "free"}, 5*time.Second)
	expectBoard(t, c, "held", "b1")
	ev := c.Expect("rpc")
	b.ReplyFrom("B", ev["id"].(string), RPCReply{})
	expectResult(t, done)

	// A call about one screen: the holder of the chat's board, and it is given no board.
	take(t, b, "A", "chat", false, "held")
	done = goCall(b, CallSpec{Method: "tool", Screen: true, Board: "b9", ChatBoard: "chat"}, 5*time.Second)
	ev = a.Expect("rpc")
	b.ReplyFrom("A", ev["id"].(string), RPCReply{})
	expectResult(t, done)
	if _, ok := b.HolderOf("b9"); ok {
		t.Fatal("a screen call gave a board")
	}
	// With no holder of the chat's board: the page that acted last, here A by its take.
	done = goCall(b, CallSpec{Method: "tool", Screen: true, ChatBoard: "free"}, 5*time.Second)
	ev = a.Expect("rpc")
	b.ReplyFrom("A", ev["id"].(string), RPCReply{})
	expectResult(t, done)

	c.ExpectNone(50 * time.Millisecond)
	n.ExpectNone(10 * time.Millisecond)
}

func TestCallBoardNoClient(t *testing.T) {
	t.Parallel()
	b := New(nil)
	start := time.Now()
	for _, spec := range []CallSpec{{Method: "tool", Board: "b1", ChatBoard: "b2"}, {Method: "tool", Screen: true}} {
		if _, err := b.CallBoard(spec, 5*time.Second); !errors.Is(err, ErrNoClient) {
			t.Fatalf("err = %v", err)
		}
	}
	if time.Since(start) > time.Second {
		t.Fatal("CallBoard did not fail at once")
	}
}

func TestCallBoardTimeout(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	a := open(t, srv, "A")
	take(t, b, "A", "b1", false, "held")
	_, err := b.CallBoard(CallSpec{Method: "tool", Board: "b1"}, 100*time.Millisecond)
	if err == nil || err.Error() != "the board did not answer tool in 100ms" {
		t.Fatalf("err = %v", err)
	}
	ev := a.Expect("rpc")
	if b.ReplyFrom("A", ev["id"].(string), RPCReply{}) {
		t.Fatal("ReplyFrom took a reply to a call that had ended")
	}
}

func TestReplyFromAnotherClientIsRefused(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	a, c := open(t, srv, "A"), open(t, srv, "B")
	take(t, b, "A", "b1", false, "held")
	take(t, b, "B", "b2", false, "held")
	done := goCall(b, CallSpec{Method: "tool", Board: "b1"}, 10*time.Second)
	id := a.Expect("rpc")["id"].(string)

	if b.ReplyFrom("B", id, RPCReply{Result: json.RawMessage(`"forged"`)}) {
		t.Fatal("ReplyFrom took the reply of a client that was not asked")
	}
	if b.ReplyFrom("", id, RPCReply{}) || b.ReplyFrom("nobody", id, RPCReply{}) || b.ReplyFrom("A", "rpc_0", RPCReply{}) {
		t.Fatal("ReplyFrom took a reply it should refuse")
	}
	// Through the route too: 409 for the other page.
	if code, _ := c.Do("POST", "/api/rpc-reply", map[string]any{"id": id, "result": "forged"}); code != http.StatusConflict {
		t.Fatalf("reply route for B: %d", code)
	}
	expectOpen(t, done)

	if code, _ := a.Do("POST", "/api/rpc-reply", map[string]any{"id": id, "result": "mine"}); code != http.StatusOK {
		t.Fatalf("reply route for A: %d", code)
	}
	if r := expectResult(t, done); r.err != nil || string(r.v) != `"mine"` {
		t.Fatalf("got %s, %v", r.v, r.err)
	}
	if b.ReplyFrom("A", id, RPCReply{}) {
		t.Fatal("ReplyFrom took a second reply")
	}
}

func TestLosingBoardFailsItsCallsOnly(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter = time.Minute
	a := open(t, srv, "A")
	open(t, srv, "B")
	take(t, b, "A", "bB", false, "held")
	take(t, b, "A", "bC", false, "held")
	onB := goCall(b, CallSpec{Method: "tool", Board: "bB"}, 10*time.Second)
	a.Expect("rpc")
	onC := goCall(b, CallSpec{Method: "tool", Board: "bC"}, 10*time.Second)
	idC := a.Expect("rpc")["id"].(string)
	screen := goCall(b, CallSpec{Method: "tool", Screen: true, ChatBoard: "bB"}, 10*time.Second)
	idScreen := a.Expect("rpc")["id"].(string)

	take(t, b, "B", "bB", false, "waiting")
	expectBoard(t, a, "release_request", "bB")
	expectOpen(t, onB) // not before the hand-off
	b.ReleaseBoard("A", "bB")
	expectBoard(t, a, "superseded", "bB")
	if r := expectResult(t, onB); !errors.Is(r.err, ErrNoClient) {
		t.Fatalf("the call on bB ended with %v", r.err)
	}
	expectOpen(t, onC)
	expectOpen(t, screen)
	for id, done := range map[string]chan callResult{idC: onC, idScreen: screen} {
		if !b.ReplyFrom("A", id, RPCReply{Result: json.RawMessage(`1`)}) {
			t.Fatal("ReplyFrom refused an open call")
		}
		if r := expectResult(t, done); r.err != nil {
			t.Fatal(r.err)
		}
	}

	// A release with nobody waiting fails the calls on that board as well.
	onC = goCall(b, CallSpec{Method: "tool", Board: "bC"}, 10*time.Second)
	a.Expect("rpc")
	if got := b.ReleaseBoard("A", "bC"); got != "free" {
		t.Fatalf("ReleaseBoard = %q", got)
	}
	if r := expectResult(t, onC); !errors.Is(r.err, ErrNoClient) {
		t.Fatalf("the call on bC ended with %v", r.err)
	}
}

func TestStreamEndFailsAllCalls(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	a := open(t, srv, "A")
	take(t, b, "A", "b1", false, "held")
	take(t, b, "A", "b2", false, "held")
	calls := []chan callResult{
		goCall(b, CallSpec{Method: "tool", Board: "b1"}, 10*time.Second),
		goCall(b, CallSpec{Method: "tool", Board: "b2"}, 10*time.Second),
		goCall(b, CallSpec{Method: "tool", Screen: true}, 10*time.Second),
	}
	for range calls {
		a.Expect("rpc")
	}
	start := time.Now()
	a.Close()
	for _, done := range calls {
		if r := expectResult(t, done); !errors.Is(r.err, ErrNoClient) {
			t.Fatalf("err = %v", r.err)
		}
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("the calls did not fail at once")
	}
	waitFor(t, func() bool { return !b.Known("A") })
}

// ---- events (AC41) ----

// One row of the table at a time, with a page that follows the chat and the run and one that
// does not.
func TestEventsTable(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	f, n := open(t, srv, "F"), open(t, srv, "N")
	if !b.Follow("F", Chat("c1")) || !b.Follow("F", Run("r1")) {
		t.Fatal("Follow refused a connected client")
	}
	seq := 0
	// sent checks who got the event just sent: the follower always, the other page if both.
	// It follows again first: a removal ends the follows.
	sent := func(t *testing.T, typ string, both bool) {
		t.Helper()
		b.Follow("F", Chat("c1"))
		b.Follow("F", Run("r1"))
		seq++
		b.Broadcast(map[string]any{"type": "catalog", "mark": seq})
		for _, p := range []*bridgetest.Page{f, n} {
			if p == f || both {
				p.Expect(typ)
			}
			if ev := p.Expect("catalog"); ev["mark"] != float64(seq) {
				t.Fatalf("page %s: catalog = %v, want mark %d", p.ID, ev, seq)
			}
		}
	}
	for typ, rule := range Events {
		t.Run(typ, func(t *testing.T) {
			ev := map[string]any{"type": typ}
			switch {
			case rule.Class == Role:
				// Only the bridge sends these, to one client. Through Broadcast it is a
				// mistake, which goes to every page.
				b.Broadcast(ev)
				sent(t, typ, true)
			case rule.Per == PerNone:
				if rule.Class != List {
					t.Fatalf("a %v type of no item", rule.Class)
				}
				b.Broadcast(ev)
				sent(t, typ, true)
				// Through the item senders it goes by its class too.
				b.SendRun("r2", ev)
				sent(t, typ, true)
				b.SendChat("c2", true, ev)
				sent(t, typ, true)
			case rule.Per == PerChat:
				b.SendChat("c1", false, ev)
				if typ == "chat_removed" && b.Followed(Chat("c1")) {
					t.Fatal("the removed chat is still followed")
				}
				sent(t, typ, rule.Class == List)
				b.SendChat("c1", true, ev) // a run agent's chat: its followers only
				sent(t, typ, false)
				// A chat that nobody follows.
				b.SendChat("c2", false, ev)
				if rule.Class == List {
					sent(t, typ, true)
				}
				b.SendChat("c2", true, ev)
				seq++
				b.Broadcast(map[string]any{"type": "catalog", "mark": seq})
				f.Expect("catalog")
				n.Expect("catalog")
				// Sent as an event of a run, or of no item, it goes to every page, and no
				// follow ends.
				b.SendRun("r1", ev)
				b.Broadcast(ev)
				if !b.Followed(Chat("c1")) || !b.Followed(Run("r1")) {
					t.Fatal("a misdirected removal ended a follow")
				}
				for _, p := range []*bridgetest.Page{f, n} {
					p.Expect(typ)
				}
				sent(t, typ, true)
			case rule.Per == PerRun:
				b.SendRun("r1", ev)
				if typ == "run_removed" && b.Followed(Run("r1")) {
					t.Fatal("the removed run is still followed")
				}
				sent(t, typ, rule.Class == List)
				b.SendRun("r2", ev)
				if rule.Class == List {
					sent(t, typ, true)
				}
				b.SendChat("c1", false, ev)
				sent(t, typ, true)
				b.Broadcast(ev)
				sent(t, typ, true)
			case rule.Per == PerBoard:
				if rule.Class != List {
					t.Fatalf("a %v type of a board", rule.Class)
				}
				b.SendBoard("b1", ev) // every page has every board
				sent(t, typ, true)
				// Sent as an event of no item, or of a chat, it goes to every page too.
				b.Broadcast(ev)
				sent(t, typ, true)
				b.SendChat("c1", true, ev)
				sent(t, typ, true)
			}
		})
	}
	t.Run("a type outside the table", func(t *testing.T) {
		for _, send := range []func(any){b.Broadcast, func(ev any) { b.SendChat("c2", true, ev) }, func(ev any) { b.SendRun("r2", ev) }} {
			send(map[string]any{"type": "brand_new"})
			sent(t, "brand_new", true)
		}
		b.Broadcast(struct{ N int }{1}) // no type at all
		for _, p := range []*bridgetest.Page{f, n} {
			if ev := p.Next(); ev["N"] != float64(1) {
				t.Fatalf("page %s got %v", p.ID, ev)
			}
		}
		b.mu.Lock()
		defer b.mu.Unlock()
		if !b.logged["brand_new"] || !b.logged["chat_items"] || !b.logged["run"] || b.logged["groups"] || b.logged["catalog"] {
			t.Fatalf("logged = %v", b.logged)
		}
	})
	f.ExpectNone(50 * time.Millisecond)
	n.ExpectNone(10 * time.Millisecond)
}

// The rows the plan names are all in the table, with their class.
func TestEventsRows(t *testing.T) {
	t.Parallel()
	want := map[string]Rule{
		"hello": {Role, PerNone, false}, "snapshot": {Role, PerNone, false},
		"release_request": {Role, PerNone, false}, "superseded": {Role, PerNone, false}, "held": {Role, PerNone, false},
		"rpc": {Role, PerNone, false}, "server_stopping": {Role, PerNone, false},
		"groups": {List, PerNone, true}, "defaults": {List, PerNone, true},
		"board": {List, PerBoard, false}, "board_removed": {List, PerBoard, false},
		"catalog": {List, PerNone, false}, "agents": {List, PerNone, false},
		"servers": {List, PerNone, true}, "server_state": {List, PerNone, true},
		"server_lists": {List, PerNone, true}, "server_back": {List, PerNone, true},
		"chat_reload": {Content, PerChat, true},
		"chat":        {List, PerChat, false}, "chat_removed": {List, PerChat, false}, "branch_state": {List, PerChat, false},
		"tree": {Content, PerChat, false}, "chat_items": {Content, PerChat, false},
		"sub": {Content, PerChat, false}, "sub_items": {Content, PerChat, false},
		"run": {List, PerRun, false}, "run_removed": {List, PerRun, false},
		"run_detail": {Content, PerRun, false}, "run_activity": {Content, PerRun, false},
	}
	if len(Events) != len(want) {
		t.Fatalf("%d rows, want %d", len(Events), len(want))
	}
	for typ, rule := range want {
		if Events[typ] != rule {
			t.Errorf("%s: %+v, want %+v", typ, Events[typ], rule)
		}
	}
}

func TestContentOnlyAfterFollow(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	a := open(t, srv, "A")
	items := map[string]any{"type": "chat_items", "chat": "c1"}
	detail := map[string]any{"type": "run_detail", "run": "r1"}
	mark := map[string]any{"type": "groups"}

	b.SendChat("c1", false, items)
	b.SendRun("r1", detail)
	b.Broadcast(mark)
	a.Expect("groups") // neither content event came first

	b.Follow("A", Chat("c1"))
	b.SendChat("c1", false, items)
	b.SendChat("c2", false, items) // another chat
	b.SendRun("c1", detail)        // a run with the chat's id
	a.Expect("chat_items")
	b.Follow("A", Run("r1"))
	b.SendRun("r1", detail)
	a.Expect("run_detail")

	// After a reconnect, only after a new follow.
	a2 := open(t, srv, "A")
	a.ExpectEnded()
	b.SendChat("c1", false, items)
	b.SendRun("r1", detail)
	b.Broadcast(mark)
	a2.Expect("groups")
	if b.Followed(Chat("c1")) || len(b.Followers(Run("r1"))) != 0 {
		t.Fatal("a follow outlived its stream")
	}
	b.Follow("A", Chat("c1"))
	b.SendChat("c1", false, items)
	a2.Expect("chat_items")

	// A follow needs an open stream.
	if b.Follow("nobody", Chat("c1")) || b.Follow("", Chat("c1")) {
		t.Fatal("Follow accepted an id with no stream")
	}
	if got := b.Followers(Chat("c1")); len(got) != 1 || got[0] != "A" {
		t.Fatalf("Followers = %v", got)
	}
}

func TestTwoFollowersGetTheSameBytes(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	a, c, n := open(t, srv, "A"), open(t, srv, "B"), open(t, srv, "N")
	b.Follow("B", Chat("c1"))
	b.Follow("A", Chat("c1"))
	if got := b.Followers(Chat("c1")); len(got) != 2 || got[0] != "A" || got[1] != "B" {
		t.Fatalf("Followers = %v", got)
	}
	type items struct {
		Type  string `json:"type"`
		Chat  string `json:"chat"`
		Items []int  `json:"items"`
	}
	for i := range 20 {
		if i%2 == 0 {
			b.SendChat("c1", false, items{"chat_items", "c1", []int{i}}) // a struct: the type is read from its JSON
		} else {
			b.SendChat("c1", true, map[string]any{"type": "sub_items", "chat": "c1", "n": i})
		}
	}
	for i := range 20 {
		x, y := a.NextRaw(), c.NextRaw()
		if x != y {
			t.Fatalf("event %d: A got %s, B got %s", i, x, y)
		}
		if i == 0 && x != `{"type":"chat_items","chat":"c1","items":[0]}` {
			t.Fatalf("event 0 = %s", x)
		}
	}
	n.ExpectNone(50 * time.Millisecond)
}

func TestUnfollow(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	a, c := open(t, srv, "A"), open(t, srv, "B")
	b.Follow("A", Chat("c1"))
	b.Follow("B", Chat("c1"))
	b.Follow("A", Run("c1"))
	b.Unfollow("A", Chat("c1"))
	b.Unfollow("A", Chat("c9")) // not followed
	b.Unfollow("nobody", Chat("c1"))
	b.SendChat("c1", false, map[string]any{"type": "tree"})
	c.Expect("tree")
	b.SendRun("c1", map[string]any{"type": "run_activity"}) // the run's follow stays
	a.Expect("run_activity")
	if got := b.Followers(Chat("c1")); len(got) != 1 || got[0] != "B" {
		t.Fatalf("Followers = %v", got)
	}
	b.Unfollow("B", Chat("c1"))
	if b.Followed(Chat("c1")) || !b.Followed(Run("c1")) {
		t.Fatal("Followed is wrong after the unfollows")
	}
	a.ExpectNone(50 * time.Millisecond)
	c.ExpectNone(10 * time.Millisecond)
}

func TestForget(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	a, c := open(t, srv, "A"), open(t, srv, "B")
	for _, id := range []string{"A", "B"} {
		b.Follow(id, Chat("c1"))
		b.Follow(id, Chat("c2"))
		b.Follow(id, Run("r1"))
	}
	b.Forget(Chat("c1"))
	if b.Followed(Chat("c1")) || !b.Followed(Chat("c2")) || !b.Followed(Run("r1")) {
		t.Fatal("Forget dropped the wrong follows")
	}
	// A removal sent through the bridge forgets by itself, after the followers got it.
	b.SendChat("c2", true, map[string]any{"type": "chat_removed", "id": "c2"})
	a.Expect("chat_removed")
	c.Expect("chat_removed")
	b.SendRun("r1", map[string]any{"type": "run_removed", "id": "r1"})
	a.Expect("run_removed")
	c.Expect("run_removed")
	if b.Followed(Chat("c2")) || b.Followed(Run("r1")) {
		t.Fatal("a removed item is still followed")
	}
	b.SendChat("c2", false, map[string]any{"type": "chat_items"})
	a.ExpectNone(50 * time.Millisecond)
	c.ExpectNone(10 * time.Millisecond)
}

// ---- stopping ----

func TestStopAndFlushWaitsForEveryHolder(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	// No client: returns at once.
	start := time.Now()
	b.StopAndFlush(5 * time.Second)
	if time.Since(start) > time.Second {
		t.Fatal("StopAndFlush waited with no client")
	}

	a, c := open(t, srv, "A"), open(t, srv, "B")
	take(t, b, "A", "b1", false, "held")
	take(t, b, "B", "b2", false, "held")
	stop := func() chan struct{} {
		done := make(chan struct{})
		go func() { b.StopAndFlush(10 * time.Second); close(done) }()
		a.Expect("server_stopping")
		c.Expect("server_stopping")
		return done
	}
	waits := func(done chan struct{}) {
		t.Helper()
		select {
		case <-done:
			t.Fatal("StopAndFlush did not wait for every holder")
		case <-time.After(100 * time.Millisecond):
		}
	}
	returns := func(done chan struct{}) {
		t.Helper()
		select {
		case <-done:
		case <-time.After(bridgetest.Wait):
			t.Fatal("StopAndFlush did not return")
		}
	}

	done := stop()
	b.FlushedBy("A")
	b.FlushedBy("A")
	b.FlushedBy("nobody")
	waits(done)
	b.FlushedBy("B")
	returns(done)

	// An answer counts for one stop only. A holder whose stream ends is waited for no longer.
	done = stop()
	b.FlushedBy("B")
	waits(done)
	a.Close()
	returns(done)

	// The limit.
	start = time.Now()
	b.StopAndFlush(100 * time.Millisecond)
	if d := time.Since(start); d < 90*time.Millisecond {
		t.Fatalf("StopAndFlush returned after %s without an answer", d)
	}
	c.Expect("server_stopping")

	// A page that holds nothing is not told and not waited for.
	n := open(t, srv, "N")
	b.ReleaseBoard("B", "b2")
	start = time.Now()
	b.StopAndFlush(5 * time.Second)
	if time.Since(start) > time.Second {
		t.Fatal("StopAndFlush waited for a page that holds nothing")
	}
	n.ExpectNone(50 * time.Millisecond)
	c.ExpectNone(10 * time.Millisecond)
}
