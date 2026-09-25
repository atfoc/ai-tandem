package editorbridge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// stream is one test client's SSE connection.
type stream struct {
	t      *testing.T
	events chan map[string]any
	ended  chan struct{} // closed when the server ends the stream
	cancel context.CancelFunc
}

func newTestServer(t *testing.T, snapshot func() any) (*Bridge, *httptest.Server) {
	t.Helper()
	b := New(snapshot)
	srv := httptest.NewServer(http.HandlerFunc(b.ServeSSE))
	t.Cleanup(srv.Close)
	return b, srv
}

func connect(t *testing.T, srv *httptest.Server, id string) *stream {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/events?client="+id, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	s := &stream{t: t, events: make(chan map[string]any, 100), ended: make(chan struct{}), cancel: cancel}
	t.Cleanup(cancel)
	go func() {
		defer close(s.ended)
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			line := sc.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var ev map[string]any
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev); err != nil {
				t.Errorf("bad event %q: %v", line, err)
				continue
			}
			s.events <- ev
		}
	}()
	return s
}

func (s *stream) next() map[string]any {
	s.t.Helper()
	select {
	case ev := <-s.events:
		return ev
	case <-time.After(2 * time.Second):
		s.t.Fatal("no event")
		return nil
	}
}

func (s *stream) expect(typ string) map[string]any {
	s.t.Helper()
	ev := s.next()
	if ev["type"] != typ {
		s.t.Fatalf("got event %v, want type %q", ev, typ)
	}
	return ev
}

func (s *stream) expectNone(d time.Duration) {
	s.t.Helper()
	select {
	case ev := <-s.events:
		s.t.Fatalf("unexpected event %v", ev)
	case <-time.After(d):
	}
}

func (s *stream) expectEnded() {
	s.t.Helper()
	select {
	case <-s.ended:
	case <-time.After(2 * time.Second):
		s.t.Fatal("stream did not end")
	}
}

func (s *stream) expectActiveWelcome() {
	s.t.Helper()
	h := s.expect("hello")
	if h["active"] != true || h["waiting"] == true {
		s.t.Fatalf("hello = %v, want active", h)
	}
	s.expect("snapshot")
}

// waitFor polls cond until it holds.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestFirstClientGetsHelloAndSnapshot(t *testing.T) {
	b, srv := newTestServer(t, func() any { return map[string]any{"groups": []string{"g1"}} })
	a := connect(t, srv, "A")
	h := a.expect("hello")
	if h["active"] != true || h["waiting"] != false {
		t.Fatalf("hello = %v", h)
	}
	snap := a.expect("snapshot")
	if g, _ := snap["groups"].([]any); len(g) != 1 || g[0] != "g1" {
		t.Fatalf("snapshot = %v", snap)
	}
	if !b.IsActive("A") {
		t.Fatal("A not active")
	}
}

func TestMissingClientID(t *testing.T) {
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

func TestTakeoverWithRelease(t *testing.T) {
	b, srv := newTestServer(t, func() any { return map[string]any{} })
	a := connect(t, srv, "A")
	a.expectActiveWelcome()

	c := connect(t, srv, "B")
	h := c.expect("hello")
	if h["active"] != false || h["waiting"] != true {
		t.Fatalf("hello = %v, want waiting", h)
	}
	a.expect("release_request")
	if !b.IsActive("A") || !b.IsPending("B") {
		t.Fatal("A should stay active while B waits")
	}
	c.expectNone(100 * time.Millisecond)

	b.Release("A")
	a.expect("superseded")
	a.expectEnded()
	c.expectActiveWelcome()
	if !b.IsActive("B") || b.IsActive("A") || b.IsPending("B") {
		t.Fatal("B should be active")
	}
}

func TestReleaseFromNonActiveIgnored(t *testing.T) {
	b, srv := newTestServer(t, nil)
	a := connect(t, srv, "A")
	a.expectActiveWelcome()
	c := connect(t, srv, "B")
	c.expect("hello")
	a.expect("release_request")
	b.Release("B")
	c.expectNone(100 * time.Millisecond)
	if !b.IsActive("A") {
		t.Fatal("A should still be active")
	}
}

func TestDefaultHandoverDelay(t *testing.T) {
	if New(nil).handoverAfter != 3*time.Second {
		t.Fatal("handover delay is not 3s")
	}
}

func TestTakeoverWithoutReleasePromotes(t *testing.T) {
	b, srv := newTestServer(t, nil)
	b.handoverAfter = 200 * time.Millisecond
	a := connect(t, srv, "A")
	a.expectActiveWelcome()
	c := connect(t, srv, "B")
	c.expect("hello")
	a.expect("release_request")
	start := time.Now()
	a.expect("superseded")
	if d := time.Since(start); d < 150*time.Millisecond {
		t.Fatalf("promoted after %s, before the handover delay", d)
	}
	a.expectEnded()
	c.expectActiveWelcome()
	if !b.IsActive("B") {
		t.Fatal("B should be active")
	}
}

func TestActiveDisconnectPromotesPending(t *testing.T) {
	b, srv := newTestServer(t, nil)
	a := connect(t, srv, "A")
	a.expectActiveWelcome()
	c := connect(t, srv, "B")
	c.expect("hello")
	a.expect("release_request")
	a.cancel()
	c.expectActiveWelcome()
	if !b.IsActive("B") {
		t.Fatal("B should be active")
	}
}

func TestSecondWaitingClientSupersedesFirstWaiting(t *testing.T) {
	b, srv := newTestServer(t, nil)
	a := connect(t, srv, "A")
	a.expectActiveWelcome()
	c1 := connect(t, srv, "B")
	c1.expect("hello")
	a.expect("release_request")
	c2 := connect(t, srv, "C")
	c1.expect("superseded")
	c1.expectEnded()
	c2.expect("hello")
	a.expect("release_request")
	b.Release("A")
	c2.expectActiveWelcome()
}

func TestSameClientReconnectReplacesStream(t *testing.T) {
	b, srv := newTestServer(t, nil)
	a1 := connect(t, srv, "A")
	a1.expectActiveWelcome()
	a2 := connect(t, srv, "A")
	a2.expectActiveWelcome()
	a1.expectEnded()
	select {
	case ev := <-a1.events:
		t.Fatalf("old stream got %v", ev)
	default:
	}
	if !b.IsActive("A") || b.IsPending("A") {
		t.Fatal("A should be active with no takeover")
	}
	b.Broadcast(map[string]any{"type": "x"})
	a2.expect("x")
}

func TestBroadcastReachesOnlyActive(t *testing.T) {
	b, srv := newTestServer(t, nil)
	a := connect(t, srv, "A")
	a.expectActiveWelcome()
	c := connect(t, srv, "B")
	c.expect("hello")
	a.expect("release_request")
	b.Broadcast(map[string]any{"type": "groups", "groups": []any{}})
	a.expect("groups")
	c.expectNone(100 * time.Millisecond)
}

func TestCallNoClient(t *testing.T) {
	b := New(nil)
	start := time.Now()
	_, err := b.Call("tool", nil, 5*time.Second)
	if !errors.Is(err, ErrNoClient) {
		t.Fatalf("err = %v", err)
	}
	if time.Since(start) > 100*time.Millisecond {
		t.Fatal("Call did not fail at once")
	}
}

func TestCallReply(t *testing.T) {
	b, srv := newTestServer(t, nil)
	a := connect(t, srv, "A")
	a.expectActiveWelcome()
	type res struct {
		v   json.RawMessage
		err error
	}
	done := make(chan res, 1)
	go func() {
		v, err := b.Call("tool", map[string]any{"name": "read_board"}, 2*time.Second)
		done <- res{v, err}
	}()
	ev := a.expect("rpc")
	if ev["method"] != "tool" || ev["params"].(map[string]any)["name"] != "read_board" {
		t.Fatalf("rpc = %v", ev)
	}
	b.Reply(ev["id"].(string), RPCReply{Result: json.RawMessage(`{"ok":true}`)})
	r := <-done
	if r.err != nil || string(r.v) != `{"ok":true}` {
		t.Fatalf("got %s, %v", r.v, r.err)
	}

	// An error reply becomes the call's error.
	go func() {
		v, err := b.Call("tool", nil, 2*time.Second)
		done <- res{v, err}
	}()
	ev = a.expect("rpc")
	b.Reply(ev["id"].(string), RPCReply{Error: "no such board"})
	r = <-done
	if r.err == nil || r.err.Error() != "no such board" {
		t.Fatalf("err = %v", r.err)
	}
}

func TestCallTimeout(t *testing.T) {
	b, srv := newTestServer(t, nil)
	a := connect(t, srv, "A")
	a.expectActiveWelcome()
	_, err := b.Call("tool", nil, 100*time.Millisecond)
	if err == nil || err.Error() != "the board did not answer tool in 100ms" {
		t.Fatalf("err = %v", err)
	}
	a.expect("rpc")
}

func TestActiveDisconnectFailsCalls(t *testing.T) {
	b, srv := newTestServer(t, nil)
	a := connect(t, srv, "A")
	a.expectActiveWelcome()
	errc := make(chan error, 1)
	go func() {
		_, err := b.Call("tool", nil, 10*time.Second)
		errc <- err
	}()
	a.expect("rpc")
	start := time.Now()
	a.cancel()
	select {
	case err := <-errc:
		if err == nil || err.Error() != ErrNoClient.Error() {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("call not failed")
	}
	if time.Since(start) > time.Second {
		t.Fatal("call not failed at once")
	}
	waitFor(t, func() bool { return !b.IsActive("A") })
}

func TestSupersededClientCallsFail(t *testing.T) {
	b, srv := newTestServer(t, nil)
	a := connect(t, srv, "A")
	a.expectActiveWelcome()
	errc := make(chan error, 1)
	go func() {
		_, err := b.Call("tool", nil, 10*time.Second)
		errc <- err
	}()
	a.expect("rpc")
	c := connect(t, srv, "B")
	c.expect("hello")
	a.expect("release_request")
	b.Release("A")
	select {
	case err := <-errc:
		if err == nil || err.Error() != ErrNoClient.Error() {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("call not failed")
	}
}

func TestStopAndFlush(t *testing.T) {
	b, srv := newTestServer(t, nil)
	// No client: returns at once.
	start := time.Now()
	b.StopAndFlush(time.Second)
	if time.Since(start) > 100*time.Millisecond {
		t.Fatal("StopAndFlush waited with no client")
	}

	a := connect(t, srv, "A")
	a.expectActiveWelcome()
	done := make(chan struct{})
	go func() { b.StopAndFlush(5 * time.Second); close(done) }()
	a.expect("server_stopping")
	b.Flushed()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("StopAndFlush did not return after Flushed")
	}

	start = time.Now()
	b.StopAndFlush(100 * time.Millisecond)
	if d := time.Since(start); d < 90*time.Millisecond {
		t.Fatalf("StopAndFlush returned after %s without Flushed", d)
	}
	a.expect("server_stopping")
}
