package editorbridge

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
)

// Tests of CallSpec.Client, CallSpec.Lost and Bridge.OnEnd (better-board design 3.2–3.4, G2).

// A call with Client goes to that client only: the holder and the follower of the board get
// nothing, the away client is not granted the board, the holder stays, and only the asked client's
// reply is taken.
func TestClientCallReachesOnlyThatClient(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.SetAway("H")
	h := open(t, srv, "H")
	a, f, host := open(t, srv, "A"), open(t, srv, "F"), open(t, srv, "T")
	take(t, b, "A", "b1", false, "held")
	b.FollowBoard("A", "b1")
	b.FollowBoard("F", "b1")

	done := goCall(b, CallSpec{Method: "tool", Board: "b1", Client: "T", Away: true}, 10*time.Second)
	id := host.Expect("rpc")["id"].(string)
	if !b.HasCalls("T") {
		t.Fatal("HasCalls(T) is false while its call is open")
	}
	if b.ReplyFrom("A", id, RPCReply{Result: json.RawMessage(`"forged"`)}) {
		t.Fatal("the holder's reply was taken for a call to another client")
	}
	expectOpen(t, done)
	if !b.ReplyFrom("T", id, RPCReply{Result: json.RawMessage(`"ok"`)}) {
		t.Fatal("the asked client's reply was refused")
	}
	if r := expectResult(t, done); r.err != nil || string(r.v) != `"ok"` {
		t.Fatalf("got %s, %v", r.v, r.err)
	}
	if b.HasCalls("T") {
		t.Fatal("HasCalls(T) after the reply")
	}
	for _, p := range []*bridgetest.Page{a, f, h} {
		p.ExpectNone(30 * time.Millisecond)
	}
	if id, _ := b.HolderOf("b1"); id != "A" {
		t.Fatalf("b1 is held by %q after the call", id)
	}
	if b.HoldsAny("T") {
		t.Fatal("the asked client was granted a board")
	}

	// A free board with Away set and the away client connected: still only T, no grant.
	done = goCall(b, CallSpec{Method: "tool", Board: "free", Client: "T", Away: true}, 10*time.Second)
	id = host.Expect("rpc")["id"].(string)
	b.ReplyFrom("T", id, RPCReply{Result: json.RawMessage(`1`)})
	if r := expectResult(t, done); r.err != nil {
		t.Fatal(r.err)
	}
	if id, ok := b.HolderOf("free"); ok {
		t.Fatalf("the free board was given to %s", id)
	}
	h.ExpectNone(30 * time.Millisecond)
}

// A call with Client that times out is ErrTimeout and takes no board from anyone, not even from
// the asked client when it holds the call's board; a hand-off of that board does not fail it.
func TestClientCallTimeoutChangesNothing(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.handoverAfter = time.Hour
	a, host := open(t, srv, "A"), open(t, srv, "T")
	take(t, b, "A", "b1", false, "held")

	_, err := b.CallBoard(CallSpec{Method: "apply", Board: "b1", Client: "T"}, 50*time.Millisecond)
	if !errors.Is(err, ErrTimeout) || errors.Is(err, ErrUnanswered) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	host.Expect("rpc")
	a.ExpectNone(30 * time.Millisecond)
	if id, _ := b.HolderOf("b1"); id != "A" {
		t.Fatalf("b1 is held by %q after the timeout", id)
	}

	// The asked client holds the board: a window would lose it for silence; a Client call does not.
	take(t, b, "T", "b2", false, "held")
	_, err = b.CallBoard(CallSpec{Method: "apply", Board: "b2", Client: "T"}, 50*time.Millisecond)
	if !errors.Is(err, ErrTimeout) || errors.Is(err, ErrUnanswered) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	host.Expect("rpc")
	host.ExpectNone(30 * time.Millisecond) // no superseded
	if !b.Holds("T", "b2") {
		t.Fatal("the timeout took b2 from its holder")
	}

	// Losing b2 does not fail an open Client call about it.
	done := goCall(b, CallSpec{Method: "apply", Board: "b2", Client: "T"}, 10*time.Second)
	id := host.Expect("rpc")["id"].(string)
	b.LoseBoard("b2")
	expectBoard(t, host, "superseded", "b2")
	expectOpen(t, done)
	b.ReplyFrom("T", id, RPCReply{Result: json.RawMessage(`1`)})
	if r := expectResult(t, done); r.err != nil {
		t.Fatal(r.err)
	}
}

// A call with Client for an id with no open stream fails at once, with nothing sent to anyone.
func TestClientCallWithNoStream(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.SetAway("H")
	h, a := open(t, srv, "H"), open(t, srv, "A")
	take(t, b, "A", "b1", false, "held")
	b.FollowBoard("A", "chat")
	for _, spec := range []CallSpec{
		{Method: "tool", Board: "b1", Client: "X"},
		{Method: "tool", Board: "b2", Client: "X", Away: true},
		{Method: "get_view", Screen: true, ChatBoard: "chat", Client: "X"},
	} {
		start := time.Now()
		if _, err := b.CallBoard(spec, 10*time.Second); !errors.Is(err, ErrNoClient) {
			t.Fatalf("%+v: err = %v", spec, err)
		}
		if time.Since(start) > 2*time.Second {
			t.Fatalf("%+v did not fail at once", spec)
		}
	}
	h.ExpectNone(30 * time.Millisecond)
	a.ExpectNone(30 * time.Millisecond)
	if _, ok := b.HolderOf("b2"); ok {
		t.Fatal("b2 was granted")
	}
}

// A Screen call with Client goes to that window, not to the one the lookup would find.
func TestScreenCallWithClient(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	w1, w2 := open(t, srv, "W1"), open(t, srv, "W2")
	for _, p := range []*bridgetest.Page{w1, w2} {
		p.OnRPC(func(map[string]any) (any, string) { return p.ID, "" })
	}
	take(t, b, "W1", "chat", false, "held")
	b.FollowBoard("W1", "chat")

	ask := func(client string) string {
		t.Helper()
		v, err := b.CallBoard(CallSpec{Method: "get_view", Screen: true, ChatBoard: "chat", Client: client}, bridgetest.Wait)
		if err != nil {
			t.Fatal(err)
		}
		var id string
		_ = json.Unmarshal(v, &id)
		return id
	}
	if got := ask(""); got != "W1" {
		t.Fatalf("without Client: %q", got)
	}
	if got := ask("W2"); got != "W2" {
		t.Fatalf("with Client W2: %q", got)
	}
	// With no chat board at all, Client still names the window.
	v, err := b.CallBoard(CallSpec{Method: "get_view", Screen: true, Client: "W2"}, bridgetest.Wait)
	if err != nil || string(v) != `"W2"` {
		t.Fatalf("no chat board: %s, %v", v, err)
	}
}

var errLostForTest = errors.New("HOST_STOPPED: test")

// Lost is the error of an open call whose client's stream ends or is replaced; without it, the
// error of today.
func TestClientCallLost(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.SetAway("H")
	cases := []struct {
		id   string
		lost error
		want error
		swap bool // replace the stream instead of closing it
	}{
		{"W", errLostForTest, errLostForTest, false},
		{"W2", nil, ErrNoClient, false},
		{"H", errLostForTest, errLostForTest, false},
		{"H", nil, ErrAwayLost, false},
		{"R", errLostForTest, errLostForTest, true},
		{"R2", nil, ErrNoClient, true},
	}
	for _, c := range cases {
		p := open(t, srv, c.id)
		take(t, b, c.id, "b_"+c.id, false, "held")
		byClient := goCall(b, CallSpec{Method: "tool", Board: "x", Client: c.id, Lost: c.lost}, 10*time.Second)
		p.Expect("rpc")
		byHolder := goCall(b, CallSpec{Method: "tool", Board: "b_" + c.id, Lost: c.lost}, 10*time.Second)
		p.Expect("rpc")
		if c.swap {
			open(t, srv, c.id)
			p.ExpectEnded()
		} else {
			p.Close()
		}
		for _, done := range []chan callResult{byClient, byHolder} {
			if r := expectResult(t, done); !errors.Is(r.err, c.want) {
				t.Fatalf("%s (lost %v, replaced %v): err = %v, want %v", c.id, c.lost, c.swap, r.err, c.want)
			}
		}
		if !c.swap {
			waitGone(t, b, c.id)
		}
	}
}

// OnEnd is called once per ended record, after the bridge's lock is released: the hook calls
// Known and SendTo, which would hang under the lock.
func TestOnEnd(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	type end struct {
		id    string
		known bool
	}
	ends := make(chan end, 16)
	b.OnEnd = func(id string) {
		known := b.Known(id)
		b.SendTo("O", map[string]any{"type": "ended_seen", "client": id})
		ends <- end{id, known}
	}
	next := func() end {
		t.Helper()
		select {
		case e := <-ends:
			return e
		case <-time.After(bridgetest.Wait):
			t.Fatal("OnEnd was not called (or hung under the lock)")
			return end{}
		}
	}
	none := func() {
		t.Helper()
		select {
		case e := <-ends:
			t.Fatalf("an extra OnEnd: %+v", e)
		case <-time.After(50 * time.Millisecond):
		}
	}

	o := open(t, srv, "O")
	a := open(t, srv, "A")
	take(t, b, "A", "b1", false, "held")
	a.Close()
	if e := next(); e.id != "A" || e.known {
		t.Fatalf("end of A: %+v", e)
	}
	if ev := o.Expect("ended_seen"); ev["client"] != "A" {
		t.Fatalf("SendTo from the hook: %v", ev)
	}
	none()

	r1 := open(t, srv, "R")
	open(t, srv, "R")
	if e := next(); e.id != "R" || !e.known {
		t.Fatalf("replacement of R: %+v (the new stream should be known)", e)
	}
	o.Expect("ended_seen")
	r1.ExpectEnded()
	none() // the old stream's own end fires nothing more
	if !b.Known("R") {
		t.Fatal("the new R stream is not known")
	}

	if n := b.CloseAll(); n != 2 {
		t.Fatalf("CloseAll = %d", n)
	}
	got := map[string]bool{}
	for range 2 {
		got[next().id] = true
	}
	if !got["O"] || !got["R"] {
		t.Fatalf("CloseAll ended %v", got)
	}
	none()
}
