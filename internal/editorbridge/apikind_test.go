package editorbridge

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
)

// newAPIServer serves the stream of a bridge's API clients, as the remote listener does: the id
// is the one the header names. snapshot gets that id.
func newAPIServer(t *testing.T, b *Bridge, snapshot func(id string) any) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/events", func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(bridgetest.ClientHeader)
		var snap func() any
		if snapshot != nil {
			snap = func() any { return snapshot(id) }
		}
		b.ServeAPI(w, r, id, snap)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// connectAPI opens the stream of an API client, which states its id in the header.
func connectAPI(t *testing.T, api *httptest.Server, id string) *bridgetest.Page {
	t.Helper()
	return bridgetest.ConnectWith(t, api.URL, id, bridgetest.Options{Header: map[string]string{bridgetest.ClientHeader: id}})
}

// openAPI connects an API client and reads its hello and snapshot.
func openAPI(t *testing.T, api *httptest.Server, id string) *bridgetest.Page {
	t.Helper()
	p := connectAPI(t, api, id)
	p.Welcome()
	return p
}

// mark is the sentinel of the tests here: a catalog event, which every client of both kinds is
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

// The two tables agree: an API client is sent exactly the list and content types that are not
// for pages only.
func TestAPIEventsAgreeWithEvents(t *testing.T) {
	t.Parallel()
	for typ := range APIEvents {
		rule, ok := Events[typ]
		switch {
		case !ok:
			t.Errorf("%s is in APIEvents and not in Events", typ)
		case rule.Class == Role:
			t.Errorf("%s is a role type in APIEvents", typ)
		case rule.PagesOnly:
			t.Errorf("%s is for pages only and in APIEvents", typ)
		}
	}
	for typ, rule := range Events {
		if (rule.Class == List || rule.Class == Content) && !rule.PagesOnly && !APIEvents[typ] {
			t.Errorf("%s is not for pages only and is missing in APIEvents", typ)
		}
	}
	b := New(nil)
	for typ, rule := range Events {
		if got, want := b.kinds[KindAPI].allow(typ), rule.Class != Role && !rule.PagesOnly; got != want {
			t.Errorf("the API kind allows %s = %v, want %v", typ, got, want)
		}
	}
	if b.kinds[KindAPI].allow("brand_new") {
		t.Error("the API kind allows a type outside the table")
	}
	if !b.kinds[KindAPI].boards {
		t.Error("the API kind may hold no board")
	}
}

// One case per row of the event table: an API client with the item's mark (X), one that follows
// the item without the mark (F), one with neither (Y), beside a page (P).
func TestAPIEventRows(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	api := newAPIServer(t, b, nil)
	p := open(t, srv, "P")
	x, f, y := openAPI(t, api, "X"), openAPI(t, api, "F"), openAPI(t, api, "Y")
	all := []*bridgetest.Page{p, x, f, y}
	s := &sentinel{b: b}

	// set puts the marks and the follows back: a removal ends both.
	set := func() {
		b.SetMark(Chat("c1"), "X")
		b.SetMark(Run("r1"), "X")
		b.MarkBoard("b1", "X")
		if !b.Follow("F", Chat("c1")) || !b.Follow("F", Run("r1")) || !b.Follow("F", Board("b1")) {
			t.Fatal("Follow refused a connected API client")
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
	chat := func(id string, unlisted bool) func(any) {
		return func(ev any) { b.SendChat(id, unlisted, ev) }
	}
	run := func(id string) func(any) { return func(ev any) { b.SendRun(id, ev) } }
	board := func(id string) func(any) { return func(ev any) { b.SendBoard(id, ev) } }

	for typ, rule := range Events {
		t.Run(typ, func(t *testing.T) {
			switch {
			case rule.Class == Role:
				// Only the bridge sends these. Through a sender it is a mistake, which goes
				// to every page and to no API client.
				sent(t, typ, b.Broadcast, p)
				sent(t, typ, chat("c1", false), p)
			case rule.Per == PerNone && rule.PagesOnly:
				sent(t, typ, b.Broadcast, p)
				sent(t, typ, chat("c1", false), p)
				sent(t, typ, run("r1"), p)
			case rule.Per == PerNone:
				sent(t, typ, b.Broadcast, all...)
				sent(t, typ, chat("c1", true), all...)
				sent(t, typ, run("r1"), all...)
			case rule.Per == PerChat && rule.PagesOnly:
				if rule.Class != Content {
					t.Fatalf("a %v type of a chat for pages only", rule.Class)
				}
				sent(t, typ, chat("c1", false)) // F follows the chat and is no page
				b.Follow("P", Chat("c1"))
				sent(t, typ, chat("c1", false), p)
				sent(t, typ, chat("c1", true), p)
				sent(t, typ, chat("c2", false))
				b.Unfollow("P", Chat("c1"))
				sent(t, typ, run("c1"), p) // misdirected: every page, no API client
				sent(t, typ, b.Broadcast, p)
			case rule.Per == PerChat && rule.Class == List:
				sent(t, typ, chat("c1", false), p, x) // by mark, not by follow
				sent(t, typ, chat("c1", true), f)     // a run agent's chat: its followers only
				sent(t, typ, chat("c2", false), p)    // a chat of the owner's
				sent(t, typ, run("c1"), p)            // misdirected: every page, no API client
				sent(t, typ, b.Broadcast, p)          // the same
				sent(t, typ, chat("r1", false), p)    // a run's id is not a chat's
			case rule.Per == PerChat:
				sent(t, typ, chat("c1", false), f) // by follow, not by mark
				sent(t, typ, chat("c1", true), f)
				sent(t, typ, chat("c2", false))
				sent(t, typ, run("c1"), p)
				sent(t, typ, b.Broadcast, p)
			case rule.Per == PerBoard:
				if rule.Class != List {
					t.Fatalf("a %v type of a board", rule.Class)
				}
				sent(t, typ, board("b1"), p, x)    // by mark, not by follow
				sent(t, typ, board("b2"), p)       // a board of the owner's
				sent(t, typ, board("c1"), p)       // a chat's id is not a board's
				sent(t, typ, b.Broadcast, p)       // misdirected: every page, no API client
				sent(t, typ, chat("c1", false), p) // the same
				sent(t, typ, run("r1"), p)
			case rule.Class == List: // of a run
				sent(t, typ, run("r1"), p, x)
				sent(t, typ, run("r2"), p)
				sent(t, typ, chat("r1", false), p)
				sent(t, typ, b.Broadcast, p)
				sent(t, typ, run("c1"), p)
			default:
				sent(t, typ, run("r1"), f)
				sent(t, typ, run("r2"))
				sent(t, typ, chat("r1", false), p)
				sent(t, typ, b.Broadcast, p)
			}
		})
	}
	t.Run("a type outside the table", func(t *testing.T) {
		sent(t, "brand_new", b.Broadcast, p)
		sent(t, "brand_new", chat("c1", false), p)
		sent(t, "brand_new", chat("c1", true), p)
		sent(t, "brand_new", run("r1"), p)
		b.Broadcast(struct{ N int }{1}) // no type at all
		s.send()
		for _, c := range all {
			if got := s.until(t, c); (len(got) == 1) != (c == p) {
				t.Errorf("an event of no type: client %s got %d events", c.ID, len(got))
			}
		}
	})
	t.Run("a client with the mark that follows", func(t *testing.T) {
		b.Follow("X", Chat("c1"))
		sent(t, "chat_items", chat("c1", false), x, f)
		sent(t, "chat", chat("c1", false), p, x)
		sent(t, "chat", chat("c1", true), x, f)
		b.Unfollow("X", Chat("c1"))
		sent(t, "chat_items", chat("c1", false), f)
	})
	for _, c := range all {
		if got := c.Drain(20 * time.Millisecond); len(got) != 0 {
			t.Errorf("client %s has events left: %v", c.ID, got)
		}
	}
}

// A mark is of one client and one item, and "" removes it.
func TestSetMark(t *testing.T) {
	t.Parallel()
	b, _ := newTestServer(t, nil)
	api := newAPIServer(t, b, nil)
	x, y := openAPI(t, api, "X"), openAPI(t, api, "Y")
	s := &sentinel{b: b}
	got := func() (xs, ys []string) {
		t.Helper()
		b.SendChat("c1", false, map[string]any{"type": "chat"})
		s.send()
		return s.until(t, x), s.until(t, y)
	}

	if m := b.MarkOf(Chat("c1")); m != "" {
		t.Fatalf("MarkOf with no mark = %q", m)
	}
	if xs, ys := got(); len(xs)+len(ys) != 0 {
		t.Fatalf("a chat without a mark reached %v, %v", xs, ys)
	}
	b.SetMark(Chat("c1"), "X")
	if b.MarkOf(Chat("c1")) != "X" || b.MarkOf(Run("c1")) != "" || b.MarkOf(Chat("c2")) != "" {
		t.Fatal("the mark is not of the one item")
	}
	if xs, ys := got(); len(xs) != 1 || len(ys) != 0 {
		t.Fatalf("with X's mark: X got %v, Y got %v", xs, ys)
	}
	b.SetMark(Chat("c1"), "Y")
	if xs, ys := got(); len(xs) != 0 || len(ys) != 1 {
		t.Fatalf("with Y's mark: X got %v, Y got %v", xs, ys)
	}
	b.SetMark(Chat("c1"), "")
	if xs, ys := got(); len(xs)+len(ys) != 0 || b.MarkOf(Chat("c1")) != "" {
		t.Fatalf("with the mark removed: X got %v, Y got %v", xs, ys)
	}
	// A mark of a client that is not connected stays, and holds for its next stream.
	b.SetMark(Chat("c1"), "Z")
	z := openAPI(t, api, "Z")
	b.SendChat("c1", false, map[string]any{"type": "chat"})
	z.Expect("chat")
}

// The removal reaches the client with the mark although Forget ran before it, as the chat
// manager's remove does. The mark is gone afterwards, and not before.
func TestRemovalReachesMarkedClientAfterForget(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		typ  string
		it   Item
		send func(b *Bridge, ev any)
	}{
		{"chat_removed", Chat("c1"), func(b *Bridge, ev any) { b.SendChat("c1", false, ev) }},
		{"run_removed", Run("r1"), func(b *Bridge, ev any) { b.SendRun("r1", ev) }},
	} {
		t.Run(tc.typ, func(t *testing.T) {
			t.Parallel()
			b, srv := newTestServer(t, nil)
			api := newAPIServer(t, b, nil)
			p, x, y := open(t, srv, "P"), openAPI(t, api, "X"), openAPI(t, api, "Y")
			s := &sentinel{b: b}
			b.SetMark(tc.it, "X")
			b.Follow("X", tc.it)
			b.Follow("Y", tc.it)

			b.Forget(tc.it)
			if b.Followed(tc.it) {
				t.Fatal("Forget left a follow")
			}
			if b.MarkOf(tc.it) != "X" {
				t.Fatal("Forget took the mark")
			}
			tc.send(b, map[string]any{"type": tc.typ, "id": tc.it.ID})
			if ev := x.Expect(tc.typ); ev["id"] != tc.it.ID {
				t.Fatalf("X got %v", ev)
			}
			p.Expect(tc.typ)
			if b.MarkOf(tc.it) != "" {
				t.Fatal("the mark outlived the removal")
			}
			// A follower without the mark is not told. An item made again with this id is
			// nobody's until it is marked.
			tc.send(b, map[string]any{"type": tc.typ, "id": tc.it.ID})
			s.send()
			if got := s.until(t, x); len(got) != 0 {
				t.Fatalf("X got %v for an item without its mark", got)
			}
			if got := s.until(t, y); len(got) != 0 {
				t.Fatalf("Y, which had followed, got %v", got)
			}
		})
	}
	t.Run("a misdirected removal keeps the mark", func(t *testing.T) {
		t.Parallel()
		b, _ := newTestServer(t, nil)
		b.SetMark(Chat("c1"), "X")
		b.SendRun("c1", map[string]any{"type": "chat_removed"})
		b.Broadcast(map[string]any{"type": "chat_removed"})
		b.SendChat("c1", false, map[string]any{"type": "run_removed"})
		if b.MarkOf(Chat("c1")) != "X" {
			t.Fatal("the mark is gone")
		}
	})
}

// Content reaches an API client only after Follow, and after a new stream only after a new
// Follow. A follow noted before the item is made holds when the item gets its mark.
func TestAPIContentOnlyAfterFollow(t *testing.T) {
	t.Parallel()
	b, _ := newTestServer(t, nil)
	api := newAPIServer(t, b, nil)
	x := openAPI(t, api, "X")
	s := &sentinel{b: b}
	items := func(n int) { b.SendChat("c1", false, map[string]any{"type": "chat_items", "n": n}) }

	if b.Follow("nobody", Chat("c1")) {
		t.Fatal("Follow accepted an id with no stream")
	}
	if !b.Follow("X", Chat("c1")) { // a read of an id that no chat has yet
		t.Fatal("Follow refused a connected API client")
	}
	b.SetMark(Chat("c1"), "X") // the chat is made
	if got := b.Followers(Chat("c1")); !reflect.DeepEqual(got, []string{"X"}) {
		t.Fatalf("followers after SetMark = %v", got)
	}
	items(1)
	if ev := x.Expect("chat_items"); ev["n"] != float64(1) {
		t.Fatalf("got %v", ev)
	}
	b.SetMark(Chat("c1"), "")
	if !b.Followed(Chat("c1")) {
		t.Fatal("the mark's removal ended a follow")
	}
	b.SetMark(Chat("c1"), "X")

	b.Unfollow("X", Chat("c1"))
	items(2)
	s.send()
	if got := s.until(t, x); len(got) != 0 {
		t.Fatalf("after unfollow X got %v", got)
	}

	// A new stream follows nothing: the mark still lists the chat, its content waits for a read.
	b.Follow("X", Chat("c1"))
	x2 := openAPI(t, api, "X")
	x.ExpectEnded()
	items(3)
	b.SendChat("c1", false, map[string]any{"type": "chat"})
	if ev := x2.Next(); ev["type"] != "chat" {
		t.Fatalf("the new stream got %v, want the list event alone", ev)
	}
	b.Follow("X", Chat("c1"))
	items(4)
	if ev := x2.Expect("chat_items"); ev["n"] != float64(4) {
		t.Fatalf("got %v", ev)
	}
	if got := x.Drain(10 * time.Millisecond); len(got) != 0 {
		t.Fatalf("the ended stream got %v", got)
	}
}

// Two API clients and a page that follow one chat get the same events, byte for byte.
func TestAPIFollowersGetTheSameBytes(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	api := newAPIServer(t, b, nil)
	p, x, y := open(t, srv, "P"), openAPI(t, api, "X"), openAPI(t, api, "Y")
	b.SetMark(Chat("c1"), "X")
	for _, id := range []string{"P", "X", "Y"} {
		b.Follow(id, Chat("c1"))
	}
	const n = 200
	for i := range n {
		b.SendChat("c1", false, map[string]any{"type": []string{"chat_items", "tree", "sub", "sub_items"}[i%4], "i": i, "text": strings.Repeat("é", i)})
	}
	for range n {
		want := p.NextRaw()
		if gx, gy := x.NextRaw(), y.NextRaw(); gx != want || gy != want {
			t.Fatalf("page got %s, X got %s, Y got %s", want, gx, gy)
		}
	}
}

// The snapshot function is called once per stream, and its fields are inline in the snapshot
// event. The page's snapshot function is not asked for an API client, nor the other way round.
func TestAPISnapshot(t *testing.T) {
	t.Parallel()
	var pageCalls, apiCalls atomic.Int32
	b, srv := newTestServer(t, func() any {
		pageCalls.Add(1)
		return map[string]any{"groups": []string{"g1"}, "boards": []string{}}
	})
	type snap struct {
		Agents []string       `json:"agents"`
		Chats  []any          `json:"chats"`
		Home   string         `json:"home"`
		Lists  map[string]int `json:"lists"`
	}
	api := newAPIServer(t, b, func(id string) any {
		apiCalls.Add(1)
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
	if apiCalls.Load() != 1 || pageCalls.Load() != 0 {
		t.Fatalf("after one API stream: %d API calls, %d page calls", apiCalls.Load(), pageCalls.Load())
	}

	// Events do not ask for it again; each further stream asks once.
	b.Broadcast(map[string]any{"type": "catalog"})
	x.Expect("catalog")
	if s := openAPI(t, api, "Y").ID; s != "Y" || apiCalls.Load() != 2 {
		t.Fatalf("after two API streams: %d API calls", apiCalls.Load())
	}
	if h := connectAPI(t, api, "X").Welcome()["home"]; h != "/home/of/X" || apiCalls.Load() != 3 {
		t.Fatalf("after a reconnect: home %v, %d API calls", h, apiCalls.Load())
	}
	if s := open(t, srv, "P"); apiCalls.Load() != 3 || pageCalls.Load() != 1 {
		t.Fatalf("after a page's stream (%s): %d API calls, %d page calls", s.ID, apiCalls.Load(), pageCalls.Load())
	}

	// No function, and one that gives no object: a snapshot event with its type alone.
	for _, fn := range []func(string) any{nil, func(string) any { return nil }, func(string) any { return []int{1} }} {
		b2 := New(nil)
		z := connectAPI(t, newAPIServer(t, b2, fn), "Z")
		z.Expect("hello")
		if raw := z.NextRaw(); raw != `{"type":"snapshot"}` {
			t.Fatalf("snapshot = %s", raw)
		}
	}
}

// The caller of ServeAPI gives the id: a client value in the query does not count.
func TestServeAPITakesTheGivenID(t *testing.T) {
	t.Parallel()
	b, _ := newTestServer(t, nil)
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

// A second stream with a connected API client's id ends the first, whose follows go with it.
func TestSecondAPIStreamReplacesFirst(t *testing.T) {
	t.Parallel()
	b, _ := newTestServer(t, nil)
	api := newAPIServer(t, b, nil)
	first := openAPI(t, api, "X")
	b.Follow("X", Chat("c1"))
	second := openAPI(t, api, "X")
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

// An id that is connected with one kind is refused as the other kind's, in both directions,
// and the connected record stays as it was.
func TestClientIDOfAnotherKindIsRefused(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	api := newAPIServer(t, b, nil)
	refused := func(t *testing.T, url, id string) {
		t.Helper()
		req, _ := http.NewRequest("GET", url+"/api/events?client="+id, nil)
		req.Header.Set(bridgetest.ClientHeader, id)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body) // returns: the refusal is no stream
		if resp.StatusCode != http.StatusConflict || string(body) != `{"error":"client id in use","code":"client_in_use"}` {
			t.Fatalf("status %d, body %s", resp.StatusCode, body)
		}
		if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
			t.Fatalf("content type %q", ct)
		}
	}

	page := open(t, srv, "A")
	take(t, b, "A", "b1", false, "held") // the answer says so: no event
	b.Follow("A", Chat("c1"))
	refused(t, api.URL, "A")
	if !b.Holds("A", "b1") || !b.Followed(Chat("c1")) || !b.Acted("A") {
		t.Fatal("the refused API stream changed the page's record")
	}
	b.Broadcast(map[string]any{"type": "groups"})
	page.Expect("groups") // its stream is open and still a page's

	client := openAPI(t, api, "B")
	b.Follow("B", Chat("c2"))
	take(t, b, "B", "b2", false, "held")
	refused(t, srv.URL, "B")
	if !b.Holds("B", "b2") || !b.Followed(Chat("c2")) || b.Acted("B") {
		t.Fatal("the refused page stream changed the API client's record")
	}
	b.Broadcast(map[string]any{"type": "groups"})
	b.Broadcast(map[string]any{"type": "agents"})
	client.Expect("agents") // still an API client: no groups

	// Once the record ended the id is free for the other kind.
	page.Close()
	waitFor(t, func() bool { return !b.Known("A") })
	openAPI(t, api, "A")
	client.Close()
	waitFor(t, func() bool { return !b.Known("B") })
	open(t, srv, "B")
	if b.Acted("A") || !b.Acted("B") {
		t.Fatal("the kinds did not change with the new streams")
	}
}

// An API client's id is no known client for Acted, and an API client is never the page that
// acted last: not after its own take either.
func TestActedIsFalseForAPIClient(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	api := newAPIServer(t, b, nil)
	x := openAPI(t, api, "X")
	if !b.Known("X") {
		t.Fatal("X has no stream")
	}
	if b.Acted("X") {
		t.Fatal("Acted is true for an API client")
	}
	take(t, b, "X", "b9", false, "held") // a take stamps a page, and not an API client
	b.mu.Lock()
	acted, clock := b.clients["X"].acted, b.clock
	b.mu.Unlock()
	if acted != 0 || clock != 0 {
		t.Fatalf("an API client was stamped: acted %d, clock %d", acted, clock)
	}
	// With API clients alone a call about a board that nobody holds has nobody to ask.
	if _, err := b.CallBoard(CallSpec{Method: "m", Board: "b1"}, time.Second); !errors.Is(err, ErrNoClient) {
		t.Fatalf("CallBoard with an API client alone = %v", err)
	}
	if _, err := b.CallBoard(CallSpec{Method: "m", Screen: true}, time.Second); !errors.Is(err, ErrNoClient) {
		t.Fatalf("a screen call with an API client alone = %v", err)
	}
	if _, ok := b.HolderOf("b1"); ok {
		t.Fatal("the failed call left a holder")
	}

	// A page acts; the API client's later calls do not make it the last one.
	p := open(t, srv, "P")
	if !b.Acted("P") {
		t.Fatal("Acted is false for a page")
	}
	b.Acted("X")
	take(t, b, "X", "b9", false, "held")
	p.OnRPC(func(map[string]any) (any, string) { return "from P", "" })
	v, err := b.CallBoard(CallSpec{Method: "m", Board: "b1"}, bridgetest.Wait)
	if err != nil || string(v) != `"from P"` {
		t.Fatalf("CallBoard = %s, %v", v, err)
	}
	p.Expect("held") // the page was given the board the call is about
	b.Broadcast(map[string]any{"type": "agents"})
	if ev := x.Next(); ev["type"] != "agents" {
		t.Fatalf("the API client got %v: an rpc or a grant", ev)
	}
}

// An API client holds a board as a page does: it takes a free one, is busy or waits on a held
// one, and releases. What it has no part in sends it nothing.
func TestAPIClientHoldsBoard(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.SceneRev = func(board string) int64 { return int64(len(board)) }
	b.handoverAfter, b.apiHandoverAfter = time.Hour, time.Hour
	api := newAPIServer(t, b, nil)
	p := open(t, srv, "P")
	take(t, b, "P", "b1", false, "held") // the answer says so: no event

	// The connects of API clients send the holder nothing and leave its hold.
	x, y := openAPI(t, api, "X"), openAPI(t, api, "Y")
	if !b.Holds("P", "b1") {
		t.Fatal("the page lost its board at an API client's connect")
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
		t.Fatalf("ReleaseBoard by a waiting API client = %q", got)
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
		t.Fatal("the API client's reply was refused")
	}
	if r := expectResult(t, done); r.err != nil || string(r.v) != `"from X"` {
		t.Fatalf("call = %s, %v", r.v, r.err)
	}
	// The stop asks every holder, of either kind.
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

// CloseKind ends every stream of the kind and no other, after what was queued for them.
func TestCloseKind(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	api := newAPIServer(t, b, nil)
	if n := b.CloseKind(KindAPI); n != 0 {
		t.Fatalf("CloseKind with no client = %d", n)
	}
	p := open(t, srv, "P")
	take(t, b, "P", "b1", false, "held") // the answer says so: no event
	b.Follow("P", Chat("c1"))
	x, y, z := openAPI(t, api, "X"), openAPI(t, api, "Y"), openAPI(t, api, "Z")
	b.SetMark(Chat("c1"), "X")
	b.Follow("Y", Chat("c1"))

	b.Broadcast(map[string]any{"type": "agents", "last": true})
	if n := b.CloseKind(KindAPI); n != 3 {
		t.Fatalf("CloseKind = %d, want 3", n)
	}
	for _, c := range []*bridgetest.Page{x, y, z} {
		c.ExpectEnded()
		if ev := c.Expect("agents"); ev["last"] != true { // queued before the close: still written
			t.Fatalf("client %s got %v", c.ID, ev)
		}
		if b.Known(c.ID) {
			t.Fatalf("client %s still has a record", c.ID)
		}
	}
	if got := b.Followers(Chat("c1")); !reflect.DeepEqual(got, []string{"P"}) {
		t.Fatalf("followers = %v", got)
	}
	if b.MarkOf(Chat("c1")) != "X" {
		t.Fatal("the close took a mark")
	}
	if n := b.CloseKind(KindAPI); n != 0 {
		t.Fatalf("a second CloseKind = %d", n)
	}

	// The page's stream is open, with its board and its follow.
	p.Expect("agents")
	if !b.Known("P") || !b.Holds("P", "b1") {
		t.Fatal("the page's record changed")
	}
	b.SendChat("c1", false, map[string]any{"type": "chat_items"})
	p.Expect("chat_items")

	// An API client connects again and gets what its mark lists; the old streams get nothing.
	x2 := openAPI(t, api, "X")
	b.SendChat("c1", false, map[string]any{"type": "chat"})
	x2.Expect("chat")
	p.Expect("chat")
	if got := x.Drain(10 * time.Millisecond); len(got) != 0 {
		t.Fatalf("the closed stream got %v", got)
	}

	// The same for pages: the API client stays.
	if n := b.CloseKind(KindPage); n != 1 {
		t.Fatalf("CloseKind(KindPage) = %d", n)
	}
	p.ExpectEnded()
	if _, held := b.HolderOf("b1"); held || !b.Known("X") {
		t.Fatal("after the pages' close: the board is held, or the API client is gone")
	}
}

// ConnectWith sends its headers with the stream's request and with every call, and uses the
// HTTP client it is given. Drain returns what waits and what arrives, and nothing for nothing.
func TestConnectWithAndDrain(t *testing.T) {
	t.Parallel()
	b := New(nil)
	var calls atomic.Int32
	type seen struct{ secret, client, extra string }
	reqs := make(chan seen, 8)
	mux := http.NewServeMux()
	note := func(r *http.Request) {
		reqs <- seen{r.Header.Get("X-AIWB-Secret"), r.Header.Get(bridgetest.ClientHeader), r.Header.Get("X-Extra")}
	}
	mux.HandleFunc("GET /api/events", func(w http.ResponseWriter, r *http.Request) {
		note(r)
		b.ServeAPI(w, r, r.URL.Query().Get("client"), nil)
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

	// The zero Options are a page: Connect's request, with no header on the stream.
	pb, psrv := newTestServer(t, nil)
	p := bridgetest.ConnectWith(t, psrv.URL, "P", bridgetest.Options{})
	p.Welcome()
	if !pb.Acted("P") {
		t.Fatal("the zero Options did not connect a page")
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

// The lists of the kinds table stay consistent under streams, marks and sends of both kinds at
// once (run with -race).
func TestAPIAndPagesAtOnce(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, func() any { return map[string]any{"n": 1} })
	api := newAPIServer(t, b, func(id string) any { return map[string]any{"me": id} })
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		for i := 0; ; i++ {
			select {
			case <-done:
				return
			default:
			}
			b.SetMark(Chat("c1"), []string{"X", "Y", ""}[i%3])
			b.SendChat("c1", false, map[string]any{"type": "chat", "i": i})
			b.SendChat("c1", false, map[string]any{"type": "chat_items", "i": i})
			if i%7 == 0 {
				b.SendChat("c1", false, map[string]any{"type": "chat_removed"})
			}
			b.MarkOf(Chat("c1"))
			b.Acted("X")
			// A pause per round: a page that reads must not fall a whole send buffer behind,
			// or its stream is closed as too slow and its board freed under the assert below.
			time.Sleep(200 * time.Microsecond)
		}
	}()
	for range 15 {
		x, y, p := openAPI(t, api, "X"), openAPI(t, api, "Y"), open(t, srv, "P")
		b.Follow("X", Chat("c1"))
		b.Follow("P", Chat("c1"))
		take(t, b, "P", "b1", false, "held")
		if n := b.CloseKind(KindAPI); n != 2 {
			t.Fatalf("CloseKind = %d", n)
		}
		x.ExpectEnded()
		y.ExpectEnded()
		if !b.Holds("P", "b1") {
			t.Fatal("the page lost its board")
		}
		p.Close()
		waitFor(t, func() bool { return !b.Known("P") })
	}
	close(done)
	<-finished
	var ids []string
	b.mu.Lock()
	for id := range b.clients {
		ids = append(ids, id)
	}
	b.mu.Unlock()
	sort.Strings(ids)
	if len(ids) != 0 {
		t.Fatalf("clients left: %v", ids)
	}
}

// FollowAs and UnfollowAs act on a record of the caller's kind only: a page's id stated by an API
// client, or an API client's stated by a page, starts and ends nothing.
func TestFollowAndUnfollowByKind(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	api := newAPIServer(t, b, nil)
	p := bridgetest.Connect(t, srv.URL, "P")
	p.Welcome()
	openAPI(t, api, "X")
	chat, run := Chat("c1"), Run("r1")
	followers := func(want ...string) {
		t.Helper()
		for _, it := range []Item{chat, run} {
			if got := b.Followers(it); !reflect.DeepEqual(got, want) && (len(got) != 0 || len(want) != 0) {
				t.Fatalf("followers of %v = %v, want %v", it, got, want)
			}
		}
	}
	both := func(f func(it Item)) {
		f(chat)
		f(run)
	}

	// The other kind's id, and an id with no stream: no follow.
	both(func(it Item) {
		if b.FollowAs(KindPage, "X", it) || b.FollowAs(KindAPI, "P", it) || b.FollowAs(KindPage, "nobody", it) || b.FollowAs(KindAPI, "nobody", it) {
			t.Fatalf("FollowAs started a follow of %v for a record of another kind or for no record", it)
		}
	})
	followers()
	both(func(it Item) {
		if !b.FollowAs(KindPage, "P", it) {
			t.Fatalf("FollowAs refused the page's own follow of %v", it)
		}
	})
	followers("P")
	// An API client that states the page's id ends nothing, and a page that states an API client's
	// starts nothing.
	both(func(it Item) {
		b.UnfollowAs(KindAPI, "P", it)
		b.UnfollowAs(KindAPI, "nobody", it)
		b.FollowAs(KindPage, "X", it)
	})
	followers("P")
	both(func(it Item) {
		if !b.FollowAs(KindAPI, "X", it) {
			t.Fatalf("FollowAs refused the API client's own follow of %v", it)
		}
	})
	followers("P", "X")
	both(func(it Item) { b.UnfollowAs(KindPage, "X", it) })
	followers("P", "X")
	both(func(it Item) { b.UnfollowAs(KindAPI, "X", it) })
	followers("P")
	both(func(it Item) { b.UnfollowAs(KindPage, "P", it) })
	followers()
	// Follow and Unfollow, for a caller that knows the record, are as they were.
	if !b.Follow("X", chat) || !b.Follow("P", chat) {
		t.Fatal("Follow refused a connected client")
	}
	b.Unfollow("X", chat)
	if got := b.Followers(chat); !reflect.DeepEqual(got, []string{"P"}) {
		t.Fatalf("followers after Unfollow = %v", got)
	}
}
