package editorbridge

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
)

// newAPIServer serves the stream of a bridge's clients, as the client listener does: the id is
// the one the header names. snapshot gets that id.
func newAPIServer(t *testing.T, b *Bridge, snapshot func(id string) any) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/events", func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(bridgetest.ClientHeader)
		var snap func() any
		if snapshot != nil {
			snap = func() any { return snapshot(id) }
		}
		b.Serve(w, r, id, snap)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// connectAPI opens the stream of a client, which states its id in the header.
func connectAPI(t *testing.T, api *httptest.Server, id string) *bridgetest.Page {
	t.Helper()
	return bridgetest.ConnectWith(t, api.URL, id, bridgetest.Options{Header: map[string]string{bridgetest.ClientHeader: id}})
}

// openAPI connects a client that states its id in the header and reads its hello and snapshot.
func openAPI(t *testing.T, api *httptest.Server, id string) *bridgetest.Page {
	t.Helper()
	p := connectAPI(t, api, id)
	p.Welcome()
	return p
}

// mark is the sentinel of the tests here: a catalog event, which every client is
// sent. until reads a client's events up to it.
type sentinel struct {
	b   *Bridge
	seq int
}

func (s *sentinel) send() {
	s.seq++
	s.b.Broadcast(map[string]any{"type": "catalog", "sentinel": s.seq})
}

// until returns the types of the events p got before the sentinel sent last.
func (s *sentinel) until(t *testing.T, p *bridgetest.Page) []string {
	t.Helper()
	types := []string{}
	for {
		ev := p.Next()
		if ev["sentinel"] == float64(s.seq) {
			return types
		}
		typ, _ := ev["type"].(string)
		types = append(types, typ)
	}
}

// One case per row of the event table: a client that follows the item (F) and three that do not
// (P, X, Y).
func TestEventRows(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	p := open(t, srv, "P")
	x, f, y := open(t, srv, "X"), open(t, srv, "F"), open(t, srv, "Y")
	all := []*bridgetest.Page{p, x, f, y}
	s := &sentinel{b: b}

	// set puts the follows back: a removal ends them.
	set := func() {
		if !b.Follow("F", Chat("c1")) || !b.Follow("F", Board("b1")) {
			t.Fatal("Follow refused a connected client")
		}
	}
	// sent sends with send and checks that exactly these clients got the type.
	sent := func(t *testing.T, typ string, send func(ev any), want ...*bridgetest.Page) {
		t.Helper()
		set()
		send(map[string]any{"type": typ})
		s.send()
		for _, c := range all {
			var exp []string
			for _, w := range want {
				if w == c {
					exp = []string{typ}
				}
			}
			if got := s.until(t, c); len(got) != len(exp) || (len(got) == 1 && got[0] != exp[0]) {
				t.Errorf("%s: client %s got %v, want %v", typ, c.ID, got, exp)
			}
		}
	}
	chat := func(id string) func(any) { return func(ev any) { b.SendChat(id, ev) } }
	board := func(id string) func(any) { return func(ev any) { b.SendBoard(id, ev) } }

	for typ, rule := range Events {
		t.Run(typ, func(t *testing.T) {
			switch {
			case rule.Class == Role:
				// Only the bridge sends these. Through a sender it is a mistake, which goes to
				// no client.
				sent(t, typ, b.Broadcast)
				sent(t, typ, chat("c1"))
			case rule.Per == PerNone:
				sent(t, typ, b.Broadcast, all...)
				sent(t, typ, chat("c1"), all...)
				sent(t, typ, board("b1"), all...)
			case rule.Per == PerChat && rule.Class == List:
				sent(t, typ, chat("c1"), all...) // every client
				sent(t, typ, chat("c2"), all...) // a chat nobody follows
				sent(t, typ, board("c1"))        // misdirected: no client
				sent(t, typ, b.Broadcast)        // the same
			case rule.Per == PerChat:
				sent(t, typ, chat("c1"), f) // by follow
				sent(t, typ, chat("c2"))
				sent(t, typ, board("c1"))
				sent(t, typ, b.Broadcast)
			case rule.Per == PerBoard:
				if rule.Class != List {
					t.Fatalf("a %v type of a board", rule.Class)
				}
				sent(t, typ, board("b1"), all...) // every client
				sent(t, typ, board("b2"), all...) // a board nobody follows
				sent(t, typ, b.Broadcast)         // misdirected: no client
				sent(t, typ, chat("c1"))          // the same
			default:
				t.Fatalf("no case for the row %+v", rule)
			}
		})
	}
	t.Run("a type outside the table", func(t *testing.T) {
		sent(t, "brand_new", b.Broadcast)
		sent(t, "brand_new", chat("c1"))
		sent(t, "brand_new", board("b1"))
		b.Broadcast(struct{ N int }{1}) // no type at all
		s.send()
		for _, c := range all {
			if got := s.until(t, c); len(got) != 0 {
				t.Errorf("an event of no type: client %s got %d events", c.ID, len(got))
			}
		}
		// It is logged once, with the misdirected types of the table.
		b.mu.Lock()
		defer b.mu.Unlock()
		if !b.logged["brand_new"] || !b.logged["chat_items"] || !b.logged["board"] || b.logged["groups"] || b.logged["catalog"] {
			t.Fatalf("logged = %v", b.logged)
		}
	})
	t.Run("a second client that follows", func(t *testing.T) {
		b.Follow("X", Chat("c1"))
		sent(t, "chat_items", chat("c1"), x, f)
		sent(t, "chat", chat("c1"), all...)
		b.Unfollow("X", Chat("c1"))
		sent(t, "chat_items", chat("c1"), f)
	})
	for _, c := range all {
		if got := c.Drain(20 * time.Millisecond); len(got) != 0 {
			t.Errorf("client %s has events left: %v", c.ID, got)
		}
	}
}

// The removal reaches every client although Forget ran before it, as the chat manager's remove
// does: the one that followed and the ones that did not.
func TestRemovalReachesEveryClientAfterForget(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		typ  string
		it   Item
		send func(b *Bridge, ev any)
	}{
		{"chat_removed", Chat("c1"), func(b *Bridge, ev any) { b.SendChat("c1", ev) }},
		{"board_removed", Board("b1"), func(b *Bridge, ev any) { b.SendBoard("b1", ev) }},
	} {
		t.Run(tc.typ, func(t *testing.T) {
			t.Parallel()
			b, srv := newTestServer(t, nil)
			p, x, y := open(t, srv, "P"), open(t, srv, "X"), open(t, srv, "Y")
			b.Follow("Y", tc.it)

			b.Forget(tc.it)
			if b.Followed(tc.it) {
				t.Fatal("Forget left a follow")
			}
			tc.send(b, map[string]any{"type": tc.typ, "id": tc.it.ID})
			for _, c := range []*bridgetest.Page{p, x, y} {
				if ev := c.Expect(tc.typ); ev["id"] != tc.it.ID {
					t.Fatalf("client %s got %v", c.ID, ev)
				}
			}
		})
	}
}

// The snapshot function is called once per stream, and its fields are inline in the snapshot
// event.
func TestSnapshot(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	b := New()
	type snap struct {
		Agents []string       `json:"agents"`
		Chats  []any          `json:"chats"`
		Home   string         `json:"home"`
		Lists  map[string]int `json:"lists"`
	}
	api := newAPIServer(t, b, func(id string) any {
		calls.Add(1)
		return snap{Agents: []string{"claude"}, Chats: []any{}, Home: "/home/of/" + id, Lists: map[string]int{"n": 1}}
	})

	x := connectAPI(t, api, "X")
	if raw := x.NextRaw(); raw != `{"client":"X","type":"hello"}` {
		t.Fatalf("hello = %s", raw)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(x.NextRaw()), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"type": "snapshot", "agents": []any{"claude"}, "chats": []any{}, "home": "/home/of/X", "lists": map[string]any{"n": 1.0},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("snapshot = %v, want %v", got, want)
	}
	if calls.Load() != 1 {
		t.Fatalf("after one stream: %d calls", calls.Load())
	}

	// Events do not ask for it again; each further stream asks once.
	b.Broadcast(map[string]any{"type": "catalog"})
	x.Expect("catalog")
	if s := openAPI(t, api, "Y").ID; s != "Y" || calls.Load() != 2 {
		t.Fatalf("after two streams: %d calls", calls.Load())
	}
	if h := connectAPI(t, api, "X").Welcome()["home"]; h != "/home/of/X" || calls.Load() != 3 {
		t.Fatalf("after a reconnect: home %v, %d calls", h, calls.Load())
	}

	// No function, and one that gives no object: a snapshot event with its type alone.
	for _, fn := range []func(string) any{nil, func(string) any { return nil }, func(string) any { return []int{1} }} {
		b2 := New()
		z := connectAPI(t, newAPIServer(t, b2, fn), "Z")
		z.Expect("hello")
		if raw := z.NextRaw(); raw != `{"type":"snapshot"}` {
			t.Fatalf("snapshot = %s", raw)
		}
	}
}

// The caller of Serve gives the id: a client value in the query does not count.
func TestServeTakesTheGivenID(t *testing.T) {
	t.Parallel()
	b := New()
	api := newAPIServer(t, b, nil)
	x := openAPI(t, api, "X") // bridgetest states the id in the query too
	if !b.Known("X") || x.ID != "X" {
		t.Fatal("X is not connected")
	}
	req, _ := http.NewRequest("GET", api.URL+"/api/events?client=other", nil)
	resp, err := http.DefaultClient.Do(req) // no header: the caller gives ""
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest || b.Known("other") {
		t.Fatalf("a stream with no id: status %d, other known %v", resp.StatusCode, b.Known("other"))
	}
}

// A second stream with a connected client's id ends the first, whose follows go with it.
func TestSecondStreamReplacesFirst(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	first := open(t, srv, "X")
	b.Follow("X", Chat("c1"))
	second := open(t, srv, "X")
	first.ExpectEnded()
	if b.Followed(Chat("c1")) {
		t.Fatal("the new record follows what the old one did")
	}
	b.Broadcast(map[string]any{"type": "agents"})
	second.Expect("agents")
	if got := first.Drain(10 * time.Millisecond); len(got) != 0 {
		t.Fatalf("the ended stream got %v", got)
	}
	// The old stream's end, noticed late by its handler, does not take the new record.
	first.Close()
	time.Sleep(20 * time.Millisecond)
	if !b.Known("X") {
		t.Fatal("the end of the old stream removed the new record")
	}
}

// An API client holds a board as a page does: it takes a free one, is busy or waits on a held
// one, and releases. What it has no part in sends it nothing.
func TestClientHoldsBoard(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.SceneRev = func(board string) int64 { return int64(len(board)) }
	b.handoverAfter = time.Hour
	p := open(t, srv, "P")
	take(t, b, "P", "b1", false, "held") // the answer says so: no event

	// The connects of clients send the holder nothing and leave its hold.
	x, y := open(t, srv, "X"), open(t, srv, "Y")
	if !b.Holds("P", "b1") {
		t.Fatal("the page lost its board at another client's connect")
	}
	if state, _, err := b.TakeBoard("Z", "b2", false); !errors.Is(err, ErrUnknownClient) {
		t.Fatalf("TakeBoard by an id with no stream = %q, %v", state, err)
	}

	// A free board: held, with its revision, and no event. Again: still held.
	for range 2 {
		if rev := take(t, b, "X", "b22", false, "held"); rev != 3 {
			t.Fatalf("rev = %d, want 3", rev)
		}
	}
	if id, ok := b.HolderOf("b22"); !ok || id != "X" || !b.Holds("X", "b22") {
		t.Fatalf("holder of b22 = %q, %v", id, ok)
	}
	// A held one: busy if asked so, else it waits and the holder is asked.
	take(t, b, "X", "b1", true, "busy")
	take(t, b, "Y", "b22", true, "busy")
	take(t, b, "X", "b1", false, "waiting")
	expectBoard(t, p, "release_request", "b1")
	if got := b.ReleaseBoard("X", "b1"); got != "none" {
		t.Fatalf("ReleaseBoard by a waiting client = %q", got)
	}
	if got := b.ReleaseBoard("P", "b1"); got != "handed" {
		t.Fatalf("release = %q", got)
	}
	expectBoard(t, p, "superseded", "b1")
	if ev := expectBoard(t, x, "held", "b1"); ev["rev"] != float64(2) {
		t.Fatalf("held = %v", ev)
	}
	// It releases with nobody waiting: free, and no event.
	if got := b.ReleaseBoard("X", "b22"); got != "free" {
		t.Fatalf("ReleaseBoard = %q", got)
	}
	if _, ok := b.HolderOf("b22"); ok {
		t.Fatal("b22 is still held")
	}

	// A call about the board it holds is asked of it, and fails when it loses the board.
	done := goCall(b, CallSpec{Method: "tool", Board: "b1"}, bridgetest.Wait)
	rpc := x.Expect("rpc")
	if !b.ReplyFrom("X", rpc["id"].(string), RPCReply{Result: json.RawMessage(`"from X"`)}) {
		t.Fatal("the client's reply was refused")
	}
	if r := expectResult(t, done); r.err != nil || string(r.v) != `"from X"` {
		t.Fatalf("call = %s, %v", r.v, r.err)
	}
	// The stop asks every holder.
	stopped := make(chan struct{})
	go func() { b.StopAndFlush(bridgetest.Wait); close(stopped) }()
	x.Expect("server_stopping")
	b.FlushedBy("X")
	<-stopped

	// The end of its stream frees its board, and that of a client with no board changes none.
	take(t, b, "P", "b3", false, "held")
	y.Close()
	waitFor(t, func() bool { return !b.Known("Y") })
	if !b.Holds("X", "b1") || !b.Holds("P", "b3") {
		t.Fatal("a holder changed at the end of another client's stream")
	}
	x.Close()
	waitFor(t, func() bool { return !b.Known("X") })
	if id, ok := b.HolderOf("b1"); ok {
		t.Fatalf("b1 is held by %s after its holder's stream ended", id)
	}
	if got := p.Drain(20 * time.Millisecond); len(got) != 0 {
		t.Fatalf("the page got %v", got)
	}
}

// CloseAll ends every stream, after what was queued for them.
func TestCloseAll(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	if n := b.CloseAll(); n != 0 {
		t.Fatalf("CloseAll with no client = %d", n)
	}
	p := open(t, srv, "P")
	take(t, b, "P", "b1", false, "held") // the answer says so: no event
	b.Follow("P", Chat("c1"))
	x, y := open(t, srv, "X"), open(t, srv, "Y")
	b.Follow("Y", Chat("c1"))

	b.Broadcast(map[string]any{"type": "agents", "last": true})
	if n := b.CloseAll(); n != 3 {
		t.Fatalf("CloseAll = %d, want 3", n)
	}
	for _, c := range []*bridgetest.Page{p, x, y} {
		c.ExpectEnded()
		if ev := c.Expect("agents"); ev["last"] != true { // queued before the close: still written
			t.Fatalf("client %s got %v", c.ID, ev)
		}
		if b.Known(c.ID) {
			t.Fatalf("client %s still has a record", c.ID)
		}
	}
	if got := b.Followers(Chat("c1")); len(got) != 0 {
		t.Fatalf("followers = %v", got)
	}
	if _, held := b.HolderOf("b1"); held {
		t.Fatal("b1 is still held after its holder's stream was closed")
	}
	if n := b.CloseAll(); n != 0 {
		t.Fatalf("a second CloseAll = %d", n)
	}

	// A client connects again and gets the list events; the old streams get nothing.
	x2 := open(t, srv, "X")
	b.SendChat("c1", map[string]any{"type": "chat"})
	x2.Expect("chat")
	if got := x.Drain(10 * time.Millisecond); len(got) != 0 {
		t.Fatalf("the closed stream got %v", got)
	}
}

// ConnectWith sends its headers with the stream's request and with every call, and uses the
// HTTP client it is given. Drain returns what waits and what arrives, and nothing for nothing.
func TestConnectWithAndDrain(t *testing.T) {
	t.Parallel()
	b := New()
	var calls atomic.Int32
	type seen struct{ secret, client, extra string }
	reqs := make(chan seen, 8)
	mux := http.NewServeMux()
	note := func(r *http.Request) {
		reqs <- seen{r.Header.Get("X-AIWB-Secret"), r.Header.Get(bridgetest.ClientHeader), r.Header.Get("X-Extra")}
	}
	mux.HandleFunc("GET /api/events", func(w http.ResponseWriter, r *http.Request) {
		note(r)
		b.Serve(w, r, r.URL.Query().Get("client"), nil)
	})
	mux.HandleFunc("POST /api/thing", func(w http.ResponseWriter, r *http.Request) {
		note(r)
		w.WriteHeader(http.StatusTeapot)
	})
	srv := httptest.NewTLSServer(mux) // the plain client does not trust it: the given one is used
	t.Cleanup(srv.Close)
	hc := srv.Client()
	hc.Transport = countingTransport{hc.Transport, &calls}

	c := bridgetest.ConnectWith(t, srv.URL+"/", "X", bridgetest.Options{
		HTTP: hc, Header: map[string]string{"X-AIWB-Secret": "s3", bridgetest.ClientHeader: "X", "X-Extra": "e"},
	})
	if got := <-reqs; got != (seen{"s3", "X", "e"}) {
		t.Fatalf("the stream's request had %+v", got)
	}
	if status, _ := c.Do("POST", "/api/thing", map[string]any{"a": 1}); status != http.StatusTeapot {
		t.Fatalf("status %d", status)
	}
	if got := <-reqs; got != (seen{"s3", "X", "e"}) {
		t.Fatalf("the call had %+v", got)
	}
	if calls.Load() != 2 {
		t.Fatalf("the given HTTP client made %d of 2 requests", calls.Load())
	}

	// Drain: hello and the snapshot wait; three more arrive while it reads.
	go func() {
		for i := range 3 {
			time.Sleep(10 * time.Millisecond)
			b.Broadcast(map[string]any{"type": "agents", "i": i})
		}
	}()
	got := c.Drain(300 * time.Millisecond)
	want := []string{
		`{"client":"X","type":"hello"}`, `{"type":"snapshot"}`,
		`{"i":0,"type":"agents"}`, `{"i":1,"type":"agents"}`, `{"i":2,"type":"agents"}`,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Drain = %v, want %v", got, want)
	}
	start := time.Now()
	if got := c.Drain(30 * time.Millisecond); got != nil || time.Since(start) < 30*time.Millisecond {
		t.Fatalf("Drain with nothing = %v after %v", got, time.Since(start))
	}
	// It eats no event that comes after it returned.
	b.Broadcast(map[string]any{"type": "agents"})
	c.Expect("agents")
	c.Close()
	if got := c.Drain(10 * time.Millisecond); got != nil { // an ended stream: nothing, no failure
		t.Fatalf("Drain of an ended stream = %v", got)
	}

	// The zero Options are Connect's request, with no header on the stream.
	pb, psrv := newTestServer(t, nil)
	p := bridgetest.ConnectWith(t, psrv.URL, "P", bridgetest.Options{})
	p.Welcome()
	if !pb.Known("P") {
		t.Fatal("the zero Options did not connect")
	}
}

type countingTransport struct {
	rt http.RoundTripper
	n  *atomic.Int32
}

func (c countingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	c.n.Add(1)
	return c.rt.RoundTrip(r)
}
