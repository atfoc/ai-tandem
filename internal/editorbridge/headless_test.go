package editorbridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
)

// writerEvent reads the next event of a page, which must be the writer event of the board, and
// returns the kind it names.
func writerEvent(t *testing.T, p *bridgetest.Page, board string) string {
	t.Helper()
	ev := expectBoard(t, p, "writer", board)
	kind, ok := ev["writer"].(string)
	if !ok || len(ev) != 3 {
		t.Fatalf("page %s: writer event = %v, want type, board and writer", p.ID, ev)
	}
	return kind
}

// ---- follows ----

func TestFollowBoard(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	revs := map[string]int64{"b1": 7}
	b.SceneRev = func(board string) int64 { return revs[board] }
	b.SetAway("H")
	open(t, srv, "A")
	open(t, srv, "B")
	open(t, srv, "H")

	if _, _, ok := b.FollowBoard("nobody", "b1"); ok || len(b.Followers(Board("b1"))) != 0 {
		t.Fatal("FollowBoard accepted an id with no stream")
	}
	if rev, writer, ok := b.FollowBoard("A", "b1"); !ok || rev != 7 || writer != "" {
		t.Fatalf("FollowBoard of a free board = %d, %q, %v", rev, writer, ok)
	}
	take(t, b, "B", "b1", false, "held")
	if rev, writer, ok := b.FollowBoard("A", "b1"); !ok || rev != 7 || writer != "window" { // again: no change
		t.Fatalf("FollowBoard of a held board = %d, %q, %v", rev, writer, ok)
	}
	if got := b.WriterOf("b1"); got != "window" {
		t.Fatalf("WriterOf = %q", got)
	}
	b.ReleaseBoard("B", "b1")
	take(t, b, "H", "b1", false, "held")
	revs["b1"] = 9
	if rev, writer, ok := b.FollowBoard("B", "b1"); !ok || rev != 9 || writer != "headless" {
		t.Fatalf("FollowBoard of a board of the away client = %d, %q, %v", rev, writer, ok)
	}
	if got := b.Followers(Board("b1")); len(got) != 2 || got[0] != "A" || got[1] != "B" {
		t.Fatalf("Followers = %v", got)
	}
	if b.Followed(Chat("b1")) {
		t.Fatal("a board follow is a chat follow")
	}

	b.Unfollow("A", Board("b1"))
	if got := b.Followers(Board("b1")); len(got) != 1 || got[0] != "B" {
		t.Fatalf("Followers after Unfollow = %v", got)
	}
	b.Unfollow("A", Board("b1")) // no follow is no error
	b.Forget(Board("b1"))
	if b.Followed(Board("b1")) {
		t.Fatal("Forget left a follow")
	}
}

// A follow of a board ends with the stream, and with the removal of the board.
func TestBoardFollowEnds(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	a := open(t, srv, "A")
	open(t, srv, "B")
	b.FollowBoard("A", "b1")
	b.FollowBoard("B", "b1")
	b.SendBoard("b1", map[string]any{"type": "board_removed", "id": "b1"})
	if b.Followed(Board("b1")) {
		t.Fatal("a removed board is still followed")
	}
	b.FollowBoard("A", "b2")
	a.Close()
	waitGone(t, b, "A")
	if b.Followed(Board("b2")) {
		t.Fatal("a follow outlived its stream")
	}
}

// scene reaches the followers of the board and nobody else, and keeps the bytes.
func TestSceneEventReachesFollowers(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	f, g, n := open(t, srv, "F"), open(t, srv, "G"), open(t, srv, "N")
	b.FollowBoard("F", "b1")
	b.FollowBoard("G", "b1")
	b.FollowBoard("N", "b2")
	b.SendBoard("b1", map[string]any{"type": "scene", "board": "b1", "rev": 12})
	const want = `{"board":"b1","rev":12,"type":"scene"}`
	if x, y := f.NextRaw(), g.NextRaw(); x != want || y != want {
		t.Fatalf("scene events = %s, %s", x, y)
	}
	n.ExpectNone(50 * time.Millisecond)
}

// ---- the writer event ----

func TestWriterEventsReachFollowers(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter = time.Hour
	b.SetAway("H")
	w1, w2, r, other := open(t, srv, "W1"), open(t, srv, "W2"), open(t, srv, "R"), open(t, srv, "O")
	open(t, srv, "H")
	b.FollowBoard("R", "b1")
	b.FollowBoard("W2", "b1")

	// A grant.
	take(t, b, "W1", "b1", false, "held")
	if k := writerEvent(t, r, "b1"); k != "window" {
		t.Fatalf("grant: writer = %q", k)
	}
	if k := writerEvent(t, w2, "b1"); k != "window" {
		t.Fatalf("grant: writer = %q", k)
	}
	// The holder taking its own board again, and a hold of the same holder, change nothing.
	take(t, b, "W1", "b1", false, "held")
	take(t, b, "W1", "b1", true, "held")
	r.ExpectNone(30 * time.Millisecond)

	// A hand-off from a window to a window: the kind stays, the holder does not.
	take(t, b, "W2", "b1", false, "waiting")
	expectBoard(t, w1, "release_request", "b1")
	r.ExpectNone(30 * time.Millisecond) // nothing yet
	if got := b.ReleaseBoard("W1", "b1"); got != "handed" {
		t.Fatalf("release = %q", got)
	}
	expectBoard(t, w1, "superseded", "b1")
	expectBoard(t, w2, "held", "b1")
	if k := writerEvent(t, r, "b1"); k != "window" {
		t.Fatalf("hand-off: writer = %q", k)
	}
	if k := writerEvent(t, w2, "b1"); k != "window" {
		t.Fatalf("hand-off: writer = %q", k)
	}
	// W1 does not follow: it was not told by the writer event.
	w1.ExpectNone(30 * time.Millisecond)

	// A release with nobody waiting: nobody writes.
	if got := b.ReleaseBoard("W2", "b1"); got != "free" {
		t.Fatalf("release = %q", got)
	}
	if k := writerEvent(t, r, "b1"); k != "" {
		t.Fatalf("release: writer = %q", k)
	}
	writerEvent(t, w2, "b1")
	if got := b.ReleaseBoard("W2", "b1"); got != "none" { // nothing changed: no event
		t.Fatalf("release = %q", got)
	}
	r.ExpectNone(30 * time.Millisecond)

	// The away client holds it: the kind is headless, and no client id is in an event.
	take(t, b, "H", "b1", false, "held")
	raw := r.NextRaw()
	if strings.Contains(raw, `"H"`) || !strings.Contains(raw, `"writer":"headless"`) {
		t.Fatalf("event = %s", raw)
	}
	w2.Drain(10 * time.Millisecond)

	// A window takes it from the away client.
	take(t, b, "W1", "b1", false, "waiting")
	if got := b.ReleaseBoard("H", "b1"); got != "handed" {
		t.Fatalf("release = %q", got)
	}
	if k := writerEvent(t, r, "b1"); k != "window" {
		t.Fatalf("hand-off from the away client: writer = %q", k)
	}

	// The stream of the writer ends.
	w1.Drain(10 * time.Millisecond)
	w1.Close()
	waitGone(t, b, "W1")
	if k := writerEvent(t, r, "b1"); k != "" {
		t.Fatalf("stream end: writer = %q", k)
	}
	if b.WriterOf("b1") != "" {
		t.Fatal("WriterOf of a free board")
	}

	// FreeBoard, and LoseBoard.
	take(t, b, "W2", "b1", false, "held")
	if k := writerEvent(t, r, "b1"); k != "window" {
		t.Fatalf("grant: writer = %q", k)
	}
	b.LoseBoard("b1")
	if k := writerEvent(t, r, "b1"); k != "" {
		t.Fatalf("LoseBoard: writer = %q", k)
	}
	take(t, b, "W2", "b1", false, "held")
	writerEvent(t, r, "b1")
	w2.Drain(30 * time.Millisecond) // W2 follows the board too
	done := make(chan struct{})
	go func() { b.FreeBoard("b1", time.Hour); close(done) }()
	expectBoard(t, w2, "release_request", "b1")
	if got := b.ReleaseBoard("W2", "b1"); got != "handed" {
		t.Fatalf("release = %q", got)
	}
	<-done
	if k := writerEvent(t, r, "b1"); k != "" {
		t.Fatalf("FreeBoard: writer = %q", k)
	}
	other.ExpectNone(30 * time.Millisecond)
}

// A follower that follows later is told nothing of the past: FollowBoard answers the writer.
func TestWriterEventsOnlyAfterFollow(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	x := open(t, srv, "X")
	r := open(t, srv, "R")
	take(t, b, "X", "b1", false, "held")
	x.ExpectNone(30 * time.Millisecond) // a take of a free board is answered, not sent
	r.ExpectNone(30 * time.Millisecond)
	if _, w, _ := b.FollowBoard("R", "b1"); w != "window" {
		t.Fatalf("writer = %q", w)
	}
	r.ExpectNone(30 * time.Millisecond)
}

// ---- away calls ----

func TestAwayCallGrantsTheFreeBoard(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.SceneRev = func(string) int64 { return 5 }
	b.SetAway("H")
	h := open(t, srv, "H")
	r := open(t, srv, "R")
	b.FollowBoard("R", "b1")

	done := goCall(b, CallSpec{Method: "tool", Board: "b1", ChatBoard: "chat", Away: true}, bridgetest.Wait)
	held := expectBoard(t, h, "held", "b1") // held first, then the call
	if held["rev"] != float64(5) {
		t.Fatalf("held = %v", held)
	}
	rpc := h.Expect("rpc")
	if k := writerEvent(t, r, "b1"); k != "headless" {
		t.Fatalf("writer = %q", k)
	}
	if id, ok := b.HolderOf("b1"); !ok || id != "H" || b.WriterOf("b1") != "headless" {
		t.Fatalf("holder = %q, %v", id, ok)
	}
	if !b.HoldsAny("H") || !b.HasCalls("H") {
		t.Fatal("the away client holds nothing or has no call")
	}
	b.ReplyFrom("H", rpc["id"].(string), RPCReply{Result: json.RawMessage(`"ok"`)})
	if res := expectResult(t, done); res.err != nil || string(res.v) != `"ok"` {
		t.Fatalf("call = %s, %v", res.v, res.err)
	}
	if b.HasCalls("H") || !b.HoldsAny("H") {
		t.Fatal("HasCalls or HoldsAny is wrong after the answer")
	}

	// Held by the away client: the next call goes to it with no second grant.
	done = goCall(b, CallSpec{Method: "tool", Board: "b1", Away: true}, bridgetest.Wait)
	rpc = h.Expect("rpc")
	b.ReplyFrom("H", rpc["id"].(string), RPCReply{})
	expectResult(t, done)
	r.ExpectNone(30 * time.Millisecond)
}

func TestAwayCallNeedsAwayAndTheAwayClient(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	h := open(t, srv, "H")
	x := open(t, srv, "X")
	take(t, b, "X", "chat", false, "held")

	// Away unset on the call, or no away client named, or not connected: no client, and nothing
	// is granted.
	for _, tc := range []struct {
		away string
		spec CallSpec
	}{
		{"H", CallSpec{Method: "tool", Board: "b1", ChatBoard: "chat"}},
		{"", CallSpec{Method: "tool", Board: "b1", ChatBoard: "chat", Away: true}},
		{"gone", CallSpec{Method: "tool", Board: "b1", ChatBoard: "chat", Away: true}},
		{"H", CallSpec{Method: "tool", Away: true}},
		{"H", CallSpec{Method: "tool", Screen: true, Board: "b1", ChatBoard: "free", Away: true}},
	} {
		b.SetAway(tc.away)
		if _, err := b.CallBoard(tc.spec, bridgetest.Wait); !errors.Is(err, ErrNoClient) {
			t.Fatalf("%+v with away %q: err = %v", tc.spec, tc.away, err)
		}
		if _, ok := b.HolderOf("b1"); ok {
			t.Fatalf("%+v with away %q: the board was granted", tc.spec, tc.away)
		}
	}
	h.ExpectNone(30 * time.Millisecond)
	x.ExpectNone(10 * time.Millisecond)

	// A held board is never taken: the call goes to the window.
	b.SetAway("H")
	done := goCall(b, CallSpec{Method: "tool", Board: "chat", Away: true}, bridgetest.Wait)
	rpc := x.Expect("rpc")
	b.ReplyFrom("X", rpc["id"].(string), RPCReply{})
	expectResult(t, done)
	h.ExpectNone(30 * time.Millisecond)
	if !b.Holds("X", "chat") {
		t.Fatal("the window lost its board")
	}
}

// The grant to the away client and a window's take are one step each: whichever comes first
// wins, and the other sees it. An away call never overtakes a window.
func TestAwayGrantIsAtomicAgainstATake(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter = time.Hour
	b.SetAway("H")
	h, w := open(t, srv, "H"), open(t, srv, "W")
	h.OnRPC(func(map[string]any) (any, string) { return "away", "" })
	w.OnRPC(func(map[string]any) (any, string) { return "window", "" })

	for i := range 40 {
		board := fmt.Sprintf("b%d", i)
		var wg sync.WaitGroup
		var res callResult
		var state string
		wg.Add(2)
		go func() {
			defer wg.Done()
			v, err := b.CallBoard(CallSpec{Method: "tool", Board: board, Away: true}, bridgetest.Wait)
			res = callResult{v, err}
		}()
		go func() {
			defer wg.Done()
			state, _, _ = b.TakeBoard("W", board, false)
		}()
		wg.Wait()
		if res.err != nil {
			t.Fatalf("%s: call: %v", board, res.err)
		}
		switch string(res.v) {
		case `"window"`: // the take came first; the call went to the window
			if state != "held" || !b.Holds("W", board) || b.Holds("H", board) {
				t.Fatalf("%s: window answered, but state=%q W=%v H=%v", board, state, b.Holds("W", board), b.Holds("H", board))
			}
		case `"away"`: // the call came first; the take waits for the away client
			if state != "waiting" || !b.Holds("H", board) || b.Holds("W", board) {
				t.Fatalf("%s: away answered, but state=%q W=%v H=%v", board, state, b.Holds("W", board), b.Holds("H", board))
			}
		default:
			t.Fatalf("%s: answer %s", board, res.v)
		}
	}
}

func TestAwayHeldComesBeforeTheCall(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.SetAway("H")
	h := open(t, srv, "H")
	for i := range 3 {
		board := fmt.Sprintf("b%d", i)
		done := goCall(b, CallSpec{Method: "tool", Board: board, Away: true}, bridgetest.Wait)
		expectBoard(t, h, "held", board)
		rpc := h.Expect("rpc")
		b.ReplyFrom("H", rpc["id"].(string), RPCReply{})
		expectResult(t, done)
	}
	if !b.HoldsAny("H") {
		t.Fatal("the away client holds nothing")
	}
}

// ---- Screen calls ----

func TestScreenCallRouting(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.SetAway("H")
	h := open(t, srv, "H")
	w1, w2, w3 := open(t, srv, "W1"), open(t, srv, "W2"), open(t, srv, "W3")
	spec := CallSpec{Method: "get_view", Screen: true, ChatBoard: "chat"}
	for _, p := range []*bridgetest.Page{h, w1, w2, w3} {
		p.OnRPC(func(map[string]any) (any, string) { return p.ID, "" })
	}
	// ask makes a screen call and says which page answered it ("" for none).
	ask := func() string {
		t.Helper()
		v, err := b.CallBoard(spec, bridgetest.Wait)
		if errors.Is(err, ErrNoClient) {
			return ""
		}
		if err != nil {
			t.Fatal(err)
		}
		var id string
		_ = json.Unmarshal(v, &id)
		return id
	}

	if got := ask(); got != "" {
		t.Fatalf("with no holder and no follower the call went to %q", got)
	}
	// A holder that follows nothing is the last choice.
	take(t, b, "W1", "chat", false, "held")
	if got := ask(); got != "W1" {
		t.Fatalf("the holder, following nothing: %q", got)
	}
	// A follower is preferred to a holder that does not follow; the latest follower wins.
	b.FollowBoard("W2", "chat")
	b.FollowBoard("W3", "chat")
	if got := ask(); got != "W3" {
		t.Fatalf("the latest follower: %q", got)
	}
	b.FollowBoard("W2", "chat") // again: no change, W3 is still the latest
	if got := ask(); got != "W3" {
		t.Fatalf("a repeated follow moved the order: %q", got)
	}
	b.Unfollow("W3", Board("chat"))
	if got := ask(); got != "W2" {
		t.Fatalf("after W3 unfollowed: %q", got)
	}
	// The holder that follows is first, whoever followed later.
	b.FollowBoard("W1", "chat")
	b.FollowBoard("W3", "chat")
	if got := ask(); got != "W1" {
		t.Fatalf("the holder that follows: %q", got)
	}
	// The away client is never asked: not as holder, not as follower.
	b.ReleaseBoard("W1", "chat")
	take(t, b, "H", "chat", false, "held")
	b.FollowBoard("H", "chat")
	b.Unfollow("W1", Board("chat"))
	b.Unfollow("W2", Board("chat"))
	b.Unfollow("W3", Board("chat"))
	if got := ask(); got != "" {
		t.Fatalf("a screen call went to %q with only the away client left", got)
	}
	b.FollowBoard("W2", "chat")
	if got := ask(); got != "W2" {
		t.Fatalf("a follower, the away client holding: %q", got)
	}
}

// ---- errors of a call that started ----

func TestCallErrors(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter = time.Hour
	b.SetAway("H")
	h := open(t, srv, "H")
	w := open(t, srv, "W")
	x := open(t, srv, "X")

	// A hand-off of a board the away client works on: ErrTaken.
	done := goCall(b, CallSpec{Method: "tool", Board: "b1", Away: true}, bridgetest.Wait)
	expectBoard(t, h, "held", "b1")
	h.Expect("rpc")
	take(t, b, "W", "b1", false, "waiting")
	expectBoard(t, h, "release_request", "b1")
	expectOpen(t, done)
	if got := b.ReleaseBoard("H", "b1"); got != "handed" {
		t.Fatalf("release = %q", got)
	}
	expectBoard(t, h, "superseded", "b1")
	expectBoard(t, w, "held", "b1")
	if r := expectResult(t, done); !errors.Is(r.err, ErrTaken) || errors.Is(r.err, ErrNoClient) {
		t.Fatalf("hand-off: err = %v, want ErrTaken", r.err)
	}

	// FreeBoard and LoseBoard: ErrTaken as well.
	take(t, b, "X", "b2", false, "held")
	done = goCall(b, CallSpec{Method: "tool", Board: "b2"}, bridgetest.Wait)
	x.Expect("rpc")
	fd := make(chan struct{})
	go func() { b.FreeBoard("b2", time.Millisecond*50); close(fd) }()
	if r := expectResult(t, done); !errors.Is(r.err, ErrTaken) {
		t.Fatalf("FreeBoard: err = %v", r.err)
	}
	<-fd
	take(t, b, "X", "b2", false, "held")
	done = goCall(b, CallSpec{Method: "tool", Board: "b2"}, bridgetest.Wait)
	x.Drain(10 * time.Millisecond)
	b.LoseBoard("b2")
	if r := expectResult(t, done); !errors.Is(r.err, ErrTaken) {
		t.Fatalf("LoseBoard: err = %v", r.err)
	}

	// The stream of the away client ends during a call: ErrAwayLost, and its board is free.
	done = goCall(b, CallSpec{Method: "tool", Board: "b3", Away: true}, bridgetest.Wait)
	expectBoard(t, h, "held", "b3")
	h.Expect("rpc")
	h.Close()
	if r := expectResult(t, done); !errors.Is(r.err, ErrAwayLost) || errors.Is(r.err, ErrNoClient) {
		t.Fatalf("away stream end: err = %v, want ErrAwayLost", r.err)
	}
	waitGone(t, b, "H")
	if _, ok := b.HolderOf("b3"); ok {
		t.Fatal("the board of the lost away client is still held")
	}

	// The stream of a window ends during a call: ErrNoClient, as before.
	take(t, b, "X", "b4", false, "held")
	done = goCall(b, CallSpec{Method: "tool", Board: "b4"}, bridgetest.Wait)
	x.Drain(10 * time.Millisecond)
	x.Close()
	if r := expectResult(t, done); !errors.Is(r.err, ErrNoClient) || errors.Is(r.err, ErrTaken) {
		t.Fatalf("window stream end: err = %v, want ErrNoClient", r.err)
	}
	if !strings.Contains(ErrNoClient.Error(), "the AI Whiteboard window is closed") {
		t.Fatal("ErrNoClient's text changed")
	}
}

// ---- release with ifIdle ----

func TestReleaseBoardIf(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter = time.Hour
	b.SetAway("H")
	h := open(t, srv, "H")
	w := open(t, srv, "W")

	// Without a call on the board: free, as ReleaseBoard.
	take(t, b, "H", "b1", false, "held")
	if got := b.ReleaseBoardIf("H", "b1", true); got != "free" {
		t.Fatalf("ifIdle, no call = %q", got)
	}
	if got := b.ReleaseBoardIf("H", "b1", true); got != "none" {
		t.Fatalf("ifIdle, not the holder = %q", got)
	}

	// With a call on it: kept, and nothing changes.
	done := goCall(b, CallSpec{Method: "tool", Board: "b1", Away: true}, bridgetest.Wait)
	h.Drain(30 * time.Millisecond)
	if got := b.ReleaseBoardIf("H", "b1", true); got != "kept" {
		t.Fatalf("ifIdle, a call open = %q", got)
	}
	if !b.Holds("H", "b1") || b.WriterOf("b1") != "headless" {
		t.Fatal("kept changed the hold")
	}
	expectOpen(t, done)
	// A call on another board does not count.
	take(t, b, "H", "b2", false, "held")
	if got := b.ReleaseBoardIf("H", "b2", true); got != "free" {
		t.Fatalf("ifIdle, a call on another board = %q", got)
	}

	// Somebody waits: the release goes through, and the call is cut by the hand-off.
	take(t, b, "W", "b1", false, "waiting")
	if got := b.ReleaseBoardIf("H", "b1", true); got != "handed" {
		t.Fatalf("ifIdle, a waiter = %q", got)
	}
	if r := expectResult(t, done); !errors.Is(r.err, ErrTaken) {
		t.Fatalf("err = %v", r.err)
	}
	expectBoard(t, w, "held", "b1")

	// Without ifIdle, a call does not keep the board.
	b.ReleaseBoard("W", "b1")
	done = goCall(b, CallSpec{Method: "tool", Board: "b1", Away: true}, bridgetest.Wait)
	h.Drain(30 * time.Millisecond)
	if got := b.ReleaseBoardIf("H", "b1", false); got != "free" {
		t.Fatalf("no ifIdle, a call open = %q", got)
	}
	if r := expectResult(t, done); !errors.Is(r.err, ErrTaken) {
		t.Fatalf("err = %v", r.err)
	}

	// A FreeBoard that waits counts as somebody waiting.
	done = goCall(b, CallSpec{Method: "tool", Board: "b1", Away: true}, bridgetest.Wait)
	h.Drain(30 * time.Millisecond)
	fd := make(chan struct{})
	go func() { b.FreeBoard("b1", time.Hour); close(fd) }()
	waitFor(t, func() bool {
		b.mu.Lock()
		defer b.mu.Unlock()
		return b.freeing["b1"] != nil
	})
	if got := b.ReleaseBoardIf("H", "b1", true); got != "handed" {
		t.Fatalf("ifIdle, FreeBoard waiting = %q", got)
	}
	<-fd
	expectResult(t, done)
}

// ---- the questions about clients ----

func TestHoldsAnyHasCallsWindowsConnected(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.SetAway("H")
	if b.WindowsConnected() || b.HoldsAny("H") || b.HasCalls("H") || b.HoldsAny("nobody") {
		t.Fatal("an empty bridge answers yes")
	}
	h := open(t, srv, "H")
	if b.WindowsConnected() {
		t.Fatal("the away client is a window")
	}
	w := open(t, srv, "W")
	if !b.WindowsConnected() {
		t.Fatal("a window is connected")
	}
	if b.HoldsAny("W") {
		t.Fatal("W holds nothing")
	}
	take(t, b, "W", "b1", false, "held")
	if !b.HoldsAny("W") || b.HasCalls("W") {
		t.Fatal("HoldsAny or HasCalls of W is wrong")
	}
	done := goCall(b, CallSpec{Method: "tool", Board: "b1"}, bridgetest.Wait)
	rpc := w.Drain(30 * time.Millisecond)
	if len(rpc) != 1 || !b.HasCalls("W") {
		t.Fatalf("events %v, HasCalls %v", rpc, b.HasCalls("W"))
	}
	b.ReleaseBoard("W", "b1")
	expectResult(t, done)
	if b.HoldsAny("W") || b.HasCalls("W") {
		t.Fatal("W still holds or has a call")
	}
	w.Close()
	waitGone(t, b, "W")
	if b.WindowsConnected() {
		t.Fatal("no window is connected")
	}
	h.Close()
	waitGone(t, b, "H")
}

func TestHeldCount(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	if n := b.HeldCount("nobody"); n != 0 {
		t.Fatalf("HeldCount of an id with no stream = %d", n)
	}
	w := open(t, srv, "W")
	if n := b.HeldCount("W"); n != 0 {
		t.Fatalf("HeldCount before any take = %d", n)
	}
	take(t, b, "W", "b1", false, "held")
	take(t, b, "W", "b2", false, "held")
	if n := b.HeldCount("W"); n != 2 {
		t.Fatalf("HeldCount with two boards = %d", n)
	}
	b.ReleaseBoard("W", "b1")
	if n := b.HeldCount("W"); n != 1 {
		t.Fatalf("HeldCount after a release = %d", n)
	}
	w.Close()
	waitGone(t, b, "W")
	if n := b.HeldCount("W"); n != 0 {
		t.Fatalf("HeldCount after the stream ended = %d", n)
	}
}
