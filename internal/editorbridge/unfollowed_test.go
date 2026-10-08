package editorbridge

import (
	"reflect"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
)

// hookCalls collects the calls of OnUnfollowed's hook.
type hookCalls struct {
	t  *testing.T
	ch chan []Item
}

func hookOf(t *testing.T, b *Bridge) *hookCalls {
	h := &hookCalls{t: t, ch: make(chan []Item, 64)}
	b.OnUnfollowed(func(items []Item) { h.ch <- items })
	return h
}

// next returns the next call's items.
func (h *hookCalls) next() []Item {
	h.t.Helper()
	select {
	case items := <-h.ch:
		return items
	case <-time.After(bridgetest.Wait):
		h.t.Fatal("the hook was not called")
		return nil
	}
}

// want reads one call, which must be for exactly these items.
func (h *hookCalls) want(items ...Item) {
	h.t.Helper()
	if got := h.next(); !reflect.DeepEqual(got, items) {
		h.t.Fatalf("the hook got %v, want %v", got, items)
	}
}

// none fails the test when the hook is called within d.
func (h *hookCalls) none(d time.Duration) {
	h.t.Helper()
	select {
	case items := <-h.ch:
		h.t.Fatalf("the hook was called with %v", items)
	case <-time.After(d):
	}
}

// The three rows of the remote chats reach pages and no API client.
func TestServerRowsReachPagesOnly(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	api := newAPIServer(t, b, nil)
	p, q := open(t, srv, "P"), open(t, srv, "Q")
	x := openAPI(t, api, "X")
	s := &sentinel{b: b}
	b.SetMark(Chat("c1"), "X")
	for _, id := range []string{"P", "Q", "X"} {
		if !b.Follow(id, Chat("c1")) {
			t.Fatalf("Follow refused %s", id)
		}
	}

	for _, typ := range []string{"server_lists", "server_back", "chat_reload"} {
		rule, ok := Events[typ]
		if !ok || !rule.PagesOnly || APIEvents[typ] {
			t.Fatalf("%s: row %+v (in the table: %v), in APIEvents: %v", typ, rule, ok, APIEvents[typ])
		}
		if rule.Per == PerChat {
			b.SendChat("c1", false, map[string]any{"type": typ, "chat": "c1"})
		} else {
			b.Broadcast(map[string]any{"type": typ, "server": "s_1"})
		}
		s.send()
		for _, c := range []*bridgetest.Page{p, q} {
			if got := s.until(t, c); !reflect.DeepEqual(got, []string{typ}) {
				t.Errorf("%s: page %s got %v", typ, c.ID, got)
			}
		}
		if got := s.until(t, x); len(got) != 0 {
			t.Errorf("%s: the API client got %v", typ, got)
		}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.logged) != 0 {
		t.Fatalf("logged as outside the table: %v", b.logged)
	}
}

// chat_reload goes to the pages that follow its chat, and to no other.
func TestChatReloadReachesFollowersOnly(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	f, n, o := open(t, srv, "F"), open(t, srv, "N"), open(t, srv, "O")
	s := &sentinel{b: b}
	b.Follow("F", Chat("c1"))
	b.Follow("O", Chat("c2"))

	b.SendChat("c1", false, map[string]any{"type": "chat_reload", "chat": "c1"})
	s.send()
	if ev := f.Expect("chat_reload"); ev["chat"] != "c1" {
		t.Fatalf("the follower got %v", ev)
	}
	for _, c := range []*bridgetest.Page{f, n, o} {
		if got := s.until(t, c); len(got) != 0 {
			t.Errorf("page %s got %v", c.ID, got)
		}
	}

	b.Unfollow("F", Chat("c1"))
	b.SendChat("c1", false, map[string]any{"type": "chat_reload", "chat": "c1"})
	s.send()
	for _, c := range []*bridgetest.Page{f, n, o} {
		if got := s.until(t, c); len(got) != 0 {
			t.Errorf("after the unfollow page %s got %v", c.ID, got)
		}
	}
}

// The hook is called for the last follower's Unfollow, and not while another client follows.
func TestUnfollowedByUnfollow(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	api := newAPIServer(t, b, nil)
	open(t, srv, "A")
	open(t, srv, "B")
	openAPI(t, api, "X")
	h := hookOf(t, b)
	c1, r1 := Chat("c1"), Run("r1")

	b.Unfollow("A", c1) // no follow ended
	b.Unfollow("nobody", c1)
	h.none(30 * time.Millisecond)

	b.Follow("A", c1)
	b.Follow("B", c1)
	b.Unfollow("A", c1)
	h.none(30 * time.Millisecond)
	b.Unfollow("B", c1)
	h.want(c1)
	b.Unfollow("B", c1) // a second time: nothing ended
	h.none(30 * time.Millisecond)

	// A client of another kind keeps the item followed.
	b.Follow("A", c1)
	b.Follow("X", c1)
	b.Unfollow("A", c1)
	h.none(30 * time.Millisecond)
	b.UnfollowAs(KindPage, "X", c1) // not X's kind: no follow ends
	h.none(30 * time.Millisecond)
	if !b.Followed(c1) {
		t.Fatal("UnfollowAs ended the follow of a client of another kind")
	}
	b.UnfollowAs(KindAPI, "X", c1)
	h.want(c1)

	// An item of each kind, and a chat and a run with one id, are apart.
	b.FollowAs(KindPage, "A", r1)
	b.Follow("A", Chat("r1"))
	b.UnfollowAs(KindPage, "A", r1)
	h.want(r1)
	b.Unfollow("A", Chat("r1"))
	h.want(Chat("r1"))

	// With no hook nothing is called.
	b.OnUnfollowed(nil)
	b.Follow("A", c1)
	b.Unfollow("A", c1)
	h.none(30 * time.Millisecond)
}

// A stream's end calls the hook once, with every item that client was the last to follow.
func TestUnfollowedByStreamEnd(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	api := newAPIServer(t, b, nil)
	a, bb := open(t, srv, "A"), open(t, srv, "B")
	x := openAPI(t, api, "X")
	h := hookOf(t, b)

	b.Follow("A", Chat("c2"))
	b.Follow("A", Chat("c1"))
	b.Follow("A", Run("r1"))
	b.Follow("A", Chat("shared"))
	b.Follow("B", Chat("shared"))
	b.Follow("A", Chat("api"))
	b.Follow("X", Chat("api"))
	a.Close()
	h.want(Chat("c1"), Chat("c2"), Run("r1")) // one call, sorted; the two still followed are not in it
	h.none(30 * time.Millisecond)

	// An API client's stream ends: what a page still follows is not in the call.
	b.Follow("X", Chat("shared"))
	x.Close()
	h.want(Chat("api"))

	// A stream that followed nothing, and one whose items are all followed by another.
	d, e := open(t, srv, "D"), open(t, srv, "E")
	b.Follow("E", Chat("shared"))
	d.Close()
	e.Close()
	waitGone(t, b, "D")
	waitGone(t, b, "E")
	h.none(30 * time.Millisecond)

	// A newer stream of the id replaces the record: its follows end.
	b2 := open(t, srv, "B")
	bb.ExpectEnded()
	h.want(Chat("shared"))
	if b.Followed(Chat("shared")) {
		t.Fatal("the new stream follows what the old one did")
	}

	// CloseKind ends records too: one call per record.
	open(t, srv, "C")
	b.Follow("B", Chat("c1"))
	b.Follow("C", Chat("c2"))
	b.Follow("C", Chat("c3"))
	if n := b.CloseKind(KindPage); n != 2 {
		t.Fatalf("CloseKind ended %d records", n)
	}
	b2.ExpectEnded()
	got := [][]Item{h.next(), h.next()}
	if len(got[0]) > len(got[1]) {
		got[0], got[1] = got[1], got[0]
	}
	if want := [][]Item{{Chat("c1")}, {Chat("c2"), Chat("c3")}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the hook got %v, want %v", got, want)
	}
	h.none(30 * time.Millisecond)
}

// waitGone waits until the client's record ended.
func waitGone(t *testing.T, b *Bridge, id string) {
	t.Helper()
	deadline := time.Now().Add(bridgetest.Wait)
	for b.Known(id) {
		if time.Now().After(deadline) {
			t.Fatalf("the record of %s did not end", id)
		}
		time.Sleep(time.Millisecond)
	}
}

// Forget and a removal end follows and call nothing.
func TestUnfollowedNotByForget(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	a := open(t, srv, "A")
	h := hookOf(t, b)

	b.Follow("A", Chat("c1"))
	b.Forget(Chat("c1"))
	if b.Followed(Chat("c1")) {
		t.Fatal("Forget left a follow")
	}
	b.Follow("A", Chat("c2"))
	b.Follow("A", Run("r1"))
	b.SendChat("c2", false, map[string]any{"type": "chat_removed", "chat": "c2"})
	b.SendRun("r1", map[string]any{"type": "run_removed", "run": "r1"})
	a.Expect("chat_removed")
	a.Expect("run_removed")
	h.none(50 * time.Millisecond)

	// The forgotten items are not reported at the stream's end either.
	b.Follow("A", Chat("c3"))
	a.Close()
	h.want(Chat("c3"))
	h.none(30 * time.Millisecond)
}

// The hook runs outside the bridge's lock: it calls back into the bridge, and the bridge is not
// held up by a hook that takes its time.
func TestUnfollowedOutsideTheLock(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	a := open(t, srv, "A")
	open(t, srv, "B")
	c1 := Chat("c1")

	type seen struct {
		items              []Item
		followed, followOK bool
		followers          []string
	}
	calls := make(chan seen, 8)
	release := make(chan struct{})
	b.OnUnfollowed(func(items []Item) {
		s := seen{items: items, followed: b.Followed(items[0])}
		s.followOK = b.Follow("B", items[0])
		s.followers = b.Followers(items[0])
		b.Unfollow("nobody", items[0])
		calls <- s
		<-release
	})
	next := func() seen {
		t.Helper()
		select {
		case s := <-calls:
			return s
		case <-time.After(bridgetest.Wait):
			t.Fatal("the hook did not return from the bridge: called under the lock?")
			return seen{}
		}
	}

	b.Follow("A", c1)
	b.Unfollow("A", c1)
	s := next()
	if !reflect.DeepEqual(s.items, []Item{c1}) || s.followed || !s.followOK || !reflect.DeepEqual(s.followers, []string{"B"}) {
		t.Fatalf("in the hook: %+v", s)
	}
	// The first call still waits in the hook: the bridge works on, and a second call runs.
	b.Follow("A", Run("r1"))
	done := make(chan struct{})
	go func() {
		defer close(done)
		b.Broadcast(map[string]any{"type": "groups"})
		a.Close()
	}()
	select {
	case <-done:
	case <-time.After(bridgetest.Wait):
		t.Fatal("the bridge waits for the hook")
	}
	if s := next(); !reflect.DeepEqual(s.items, []Item{Run("r1")}) || s.followed || !s.followOK {
		t.Fatalf("at the stream's end, in the hook: %+v", s)
	}
	close(release)
}

// Follows, unfollows, stream ends and a hook that calls back, all at once (for -race).
func TestUnfollowedConcurrently(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	var mu sync.Mutex
	lost := 0
	b.OnUnfollowed(func(items []Item) {
		for _, it := range items {
			b.Followed(it)
			b.Follow("keeper", Chat("kept"))
		}
		mu.Lock()
		lost += len(items)
		mu.Unlock()
	})
	open(t, srv, "keeper")

	const clients, rounds = 8, 50
	var wg sync.WaitGroup
	for i := 0; i < clients; i++ {
		id := string(rune('a' + i))
		p := open(t, srv, id)
		wg.Add(1)
		go func() {
			defer wg.Done()
			own := Chat("own-" + id)
			for r := 0; r < rounds; r++ {
				b.Follow(id, own)
				b.Follow(id, Chat("shared"))
				b.Unfollow(id, own)
				b.UnfollowAs(KindPage, id, Chat("shared"))
				b.Forget(Run("r"))
			}
			b.Follow(id, own)
			p.Close()
			waitGone(t, b, id)
		}()
	}
	wg.Wait()
	// Every own item was lost once per round and once at the stream's end.
	want := clients * (rounds + 1)
	deadline := time.Now().Add(bridgetest.Wait)
	for {
		mu.Lock()
		n := lost
		mu.Unlock()
		if n >= want {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the hook reported %d lost items, want at least %d", n, want)
		}
		time.Sleep(time.Millisecond)
	}
	if b.Followed(Chat("shared")) || !b.Followed(Chat("kept")) {
		t.Fatal("the follows after the run are wrong")
	}
}
