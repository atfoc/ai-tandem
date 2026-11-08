package tlrelay

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/headless"
)

func TestOpenSyncClose(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	s := g.open("b1", "w1")
	if !strings.HasPrefix(s, "s_") || len(s) != 18 || strings.Trim(s[2:], base36) != "" {
		t.Fatalf("session id %q", s)
	}
	evs := g.br.take("h1")
	if len(evs) != 1 || evs[0] != (sessionEvent{Type: "tl_open", Board: "b1", Session: s}) {
		t.Fatalf("host got %#v", evs)
	}

	code, m := g.do("POST", "/api/tl/b1/sync", "w1", map[string]any{"session": s, "messages": []string{"a", "b"}})
	if code != 200 || m["ok"] != true {
		t.Fatalf("sync: %d %v", code, m)
	}
	evs = g.br.take("h1")
	if len(evs) != 1 {
		t.Fatalf("host got %#v", evs)
	}
	got := wire(t, evs[0])
	want := map[string]any{"type": "tl_sync", "board": "b1", "session": s, "messages": []any{"a", "b"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tl_sync %v, want %v", got, want)
	}
	if len(g.br.all("w1")) != 0 {
		t.Fatalf("the window got its own messages back: %v", g.br.all("w1"))
	}

	code, m = g.do("POST", "/api/tl/b1/close", "w1", map[string]any{"session": s})
	if code != 200 || m["ok"] != true {
		t.Fatalf("close: %d %v", code, m)
	}
	evs = g.br.take("h1")
	if len(evs) != 1 || evs[0] != (sessionEvent{Type: "tl_close", Board: "b1", Session: s}) {
		t.Fatalf("host got %#v", evs)
	}
	if code, m := g.do("POST", "/api/tl/b1/sync", "w1", map[string]any{"session": s, "messages": []string{}}); code != 410 || m["code"] != "no_session" {
		t.Fatalf("sync after close: %d %v", code, m)
	}
	// close again, or of a session never known: 200, nothing sent
	for _, sid := range []string{s, "s_nothing"} {
		if code, _ := g.do("POST", "/api/tl/b1/close", "w1", map[string]any{"session": sid}); code != 200 {
			t.Fatalf("close %s: %d", sid, code)
		}
	}
	if evs := g.br.take("h1"); len(evs) != 0 {
		t.Fatalf("host got %#v", evs)
	}
	if n := g.sessionCount(); n != 0 {
		t.Fatalf("%d sessions left", n)
	}
}

func TestSessionChecks(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	s := g.open("b1", "w1")
	g.br.take("h1")
	for _, c := range []struct{ name, board, client, session string }{
		{"other client", "b1", "w2", s},
		{"other board", "b2", "w1", s},
		{"unknown session", "b1", "w1", "s_0000000000000000"},
		{"no session", "b1", "w1", ""},
	} {
		code, m := g.do("POST", "/api/tl/"+c.board+"/sync", c.client, map[string]any{"session": c.session, "messages": []string{"x"}})
		if code != 410 || m["code"] != "no_session" {
			t.Errorf("%s: %d %v", c.name, code, m)
		}
	}
	// a close by another client or on another board does nothing
	g.do("POST", "/api/tl/b1/close", "w2", map[string]any{"session": s})
	g.do("POST", "/api/tl/b2/close", "w1", map[string]any{"session": s})
	if evs := g.br.take("h1"); len(evs) != 0 {
		t.Fatalf("host got %#v", evs)
	}
	if code, _ := g.do("POST", "/api/tl/b1/sync", "w1", map[string]any{"session": s, "messages": []string{"x"}}); code != 200 {
		t.Fatalf("the session was harmed: %d", code)
	}
}

func TestBoardAndClientChecks(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	routes := []struct{ method, path string }{
		{"POST", "/api/tl/%s/open"}, {"POST", "/api/tl/%s/sync"}, {"POST", "/api/tl/%s/close"},
		{"GET", "/api/tl/%s/snapshot"}, {"PUT", "/api/tl/%s/snapshot"},
	}
	body := map[string]any{"session": "s_x", "messages": []string{}}
	for _, rt := range routes {
		client := "w1"
		if strings.HasSuffix(rt.path, "snapshot") {
			client = "h1"
		}
		if code, m := g.do(rt.method, fmt.Sprintf(rt.path, "nope"), client, body); code != 404 || m["code"] != "not_found" {
			t.Errorf("%s %s unknown board: %d %v", rt.method, rt.path, code, m)
		}
		if code, m := g.do(rt.method, fmt.Sprintf(rt.path, "old"), client, body); code != 409 || m["code"] != "not_tl" {
			t.Errorf("%s %s classic board: %d %v", rt.method, rt.path, code, m)
		}
		if code, m := g.do(rt.method, fmt.Sprintf(rt.path, "b1"), "", body); code != 400 {
			t.Errorf("%s %s no client: %d %v", rt.method, rt.path, code, m)
		}
	}
	if code, m := g.do("POST", "/api/tl-host/out", "", map[string]any{}); code != 400 {
		t.Errorf("out no client: %d %v", code, m)
	}
	if code, m := g.do("POST", "/api/tl/arch/open", "w1", nil); code != 409 || m["code"] != "archived" {
		t.Errorf("open archived: %d %v", code, m)
	}
	// open with an empty body is fine; the window needs a stream
	if code, m := g.do("POST", "/api/tl/b1/open", "w1", nil); code != 200 {
		t.Errorf("open, empty body: %d %v", code, m)
	}
	if code, m := g.do("POST", "/api/tl/b1/open", "w9", nil); code != 409 || m["code"] != "no_stream" {
		t.Errorf("open without a stream: %d %v", code, m)
	}
	// bodies over their limit
	big := `{"session":"` + strings.Repeat("x", maxSmallBody) + `"}`
	if code, m := g.do("POST", "/api/tl/b1/open", "w1", big); code != 413 {
		t.Errorf("open, big body: %d %v", code, m)
	}
	if code, m := g.do("POST", "/api/tl/b1/close", "w1", big); code != 413 {
		t.Errorf("close, big body: %d %v", code, m)
	}
}

func TestSyncMessagesMustBeAnArray(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	s := g.open("b1", "w1")
	g.br.take("h1")
	for _, body := range []string{
		`{"session":"` + s + `"}`,
		`{"session":"` + s + `","messages":null}`,
		`{"session":"` + s + `","messages":{"a":1}}`,
		`{"session":"` + s + `","messages":"[1]"}`,
		`{"session":"` + s + `","messages":[`,
		`not json`,
	} {
		if code, m := g.do("POST", "/api/tl/b1/sync", "w1", body); code != 400 {
			t.Errorf("%s: %d %v", body, code, m)
		}
	}
	if code, m := g.do("POST", "/api/tl-host/out", "h1", `{"out":[{"session":"`+s+`","messages":{}}]}`); code != 400 {
		t.Errorf("out with an object: %d %v", code, m)
	}
	if evs := g.br.take("h1"); len(evs) != 0 {
		t.Fatalf("host got %#v", evs)
	}
	if evs := g.br.take("w1"); len(evs) != 0 {
		t.Fatalf("window got %#v", evs)
	}
	// whitespace before the array is fine
	if code, m := g.do("POST", "/api/tl/b1/sync", "w1", `{"session":"`+s+`","messages": `+"\n\t"+`["x"]}`); code != 200 {
		t.Errorf("spaced array: %d %v", code, m)
	}
}

// The messages go through as they were sent, both ways, for strings that are easy to mangle.
func TestOpaqueRelay(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	s := g.open("b1", "w1")
	g.br.take("h1")
	odd := []string{
		"", " ", "plain", "ünïcødé ✓ 中文 עברית", "emoji 😀👩‍👩‍👧‍👦🏳️‍🌈", "<script>&amp;</script> & < >",
		"line sep para", `"quoted" and \backslash\ and \"both\"`, "\x00\x01\t\n\r", `{"type":"push","diff":{}}`,
		"�", strings.Repeat("big", 1<<20/3+1),
	}
	code, m := g.do("POST", "/api/tl/b1/sync", "w1", map[string]any{"session": s, "messages": odd})
	if code != 200 {
		t.Fatalf("sync: %d %v", code, m)
	}
	check := func(who string, evs []any) {
		t.Helper()
		if len(evs) != 1 {
			t.Fatalf("%s got %d events", who, len(evs))
		}
		j, err := json.Marshal(evs[0])
		if err != nil {
			t.Fatal(err)
		}
		var got struct {
			Messages []string `json:"messages"`
		}
		if err := json.Unmarshal(j, &got); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got.Messages, odd) {
			for i := range odd {
				if i >= len(got.Messages) || got.Messages[i] != odd[i] {
					t.Fatalf("%s: message %d changed", who, i)
				}
			}
			t.Fatalf("%s: %d messages, want %d", who, len(got.Messages), len(odd))
		}
	}
	check("host", g.br.take("h1"))

	code, m = g.do("POST", "/api/tl-host/out", "h1", map[string]any{"out": []any{map[string]any{"session": s, "messages": odd}}})
	if code != 200 {
		t.Fatalf("out: %d %v", code, m)
	}
	check("window", g.br.take("w1"))
}

func TestHostEndedClosesEverySession(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	s1 := g.open("b1", "w1")
	s2 := g.open("b2", "w1")
	s3 := g.open("b1", "w2")
	g.br.take("h1")
	g.endClient("h1")
	want := map[string][]closedEvent{
		"w1": {{"tl_closed", "b1", s1, "host_stopped"}, {"tl_closed", "b2", s2, "host_stopped"}},
		"w2": {{"tl_closed", "b1", s3, "host_stopped"}},
	}
	for w, ws := range want {
		got := map[closedEvent]bool{}
		for _, ev := range g.br.take(w) {
			got[ev.(closedEvent)] = true
		}
		for _, e := range ws {
			if !got[e] {
				t.Errorf("%s did not get %v", w, e)
			}
		}
		if len(got) != len(ws) {
			t.Errorf("%s got %v", w, got)
		}
	}
	if n := g.sessionCount(); n != 0 {
		t.Fatalf("%d sessions left", n)
	}
	// the host is forgotten: out and snapshot are refused, a sync is 410
	if code, m := g.do("POST", "/api/tl-host/out", "h1", map[string]any{}); code != 403 || m["code"] != "not_board_host" {
		t.Fatalf("out of the old host: %d %v", code, m)
	}
	if code, _ := g.do("POST", "/api/tl/b1/sync", "w1", map[string]any{"session": s1, "messages": []string{}}); code != 410 {
		t.Fatalf("sync: %d", code)
	}
}

func TestWindowEndedClosesItsSessions(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	s1 := g.open("b1", "w1")
	s2 := g.open("b2", "w1")
	s3 := g.open("b1", "w2")
	g.br.take("h1")
	g.endClient("w1")
	got := map[sessionEvent]bool{}
	for _, ev := range g.br.take("h1") {
		got[ev.(sessionEvent)] = true
	}
	if len(got) != 2 || !got[sessionEvent{"tl_close", "b1", s1}] || !got[sessionEvent{"tl_close", "b2", s2}] {
		t.Fatalf("host got %v", got)
	}
	if evs := g.br.all("w2"); len(evs) != 0 {
		t.Fatalf("w2 got %v", evs)
	}
	if code, _ := g.do("POST", "/api/tl/b1/sync", "w2", map[string]any{"session": s3, "messages": []string{}}); code != 200 {
		t.Fatalf("w2's session: %d", code)
	}
}

func TestLateEndOfAnOldHost(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	old := g.open("b1", "w1")
	// the manager starts another host before the old one's stream has ended
	g.startHost("h2")
	if code, m := g.do("POST", "/api/tl/b1/sync", "w1", map[string]any{"session": old, "messages": []string{"x"}}); code != 410 {
		t.Fatalf("sync on the old host's session: %d %v", code, m)
	}
	s := g.open("b1", "w1")
	s2 := g.open("b2", "w2")
	if len(g.br.all("h2")) != 2 {
		t.Fatalf("h2 got %s", types(g.br.all("h2")))
	}
	g.br.take("w1")
	g.endClient("h1")
	if evs := g.br.all("w1"); len(evs) != 0 {
		t.Fatalf("w1 got %s", types(evs))
	}
	if n := g.sessionCount(); n != 2 {
		t.Fatalf("%d sessions", n)
	}
	for _, c := range []struct{ w, b, s string }{{"w1", "b1", s}, {"w2", "b2", s2}} {
		if code, _ := g.do("POST", "/api/tl/"+c.b+"/sync", c.w, map[string]any{"session": c.s, "messages": []string{}}); code != 200 {
			t.Fatalf("sync on h2's session: %d", code)
		}
	}
	if code, _ := g.do("POST", "/api/tl-host/out", "h2", map[string]any{}); code != 200 {
		t.Fatalf("h2 is no longer the host: %d", code)
	}
}

func TestSyncToAGoneHost(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	s := g.open("b1", "w1")
	g.br.setKnown("h1", false) // its stream ended; ClientEnded has not come yet
	if code, m := g.do("POST", "/api/tl/b1/sync", "w1", map[string]any{"session": s, "messages": []string{"x"}}); code != 410 || m["code"] != "no_session" {
		t.Fatalf("sync: %d %v", code, m)
	}
	if n := g.sessionCount(); n != 0 {
		t.Fatalf("%d sessions", n)
	}
	g.r.ClientEnded("h1")
	if evs := g.br.all("w1"); len(evs) != 0 {
		t.Fatalf("w1 got %s", types(evs))
	}
}

func TestOut(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	s1 := g.open("b1", "w1")
	s2 := g.open("b2", "w2")
	s3 := g.open("b1", "w2")
	g.br.take("h1")
	body := map[string]any{
		"out": []any{
			map[string]any{"session": s1, "messages": []string{"1"}},
			map[string]any{"session": "s_unknown", "messages": []string{"2"}},
			map[string]any{"session": s2, "messages": []string{"3"}},
			map[string]any{"session": s1, "messages": []string{"4"}},
		},
		"closed": []any{
			map[string]any{"session": s2, "reason": "rejected by tldraw"},
			map[string]any{"session": "s_unknown2", "reason": "x"},
		},
	}
	code, m := g.do("POST", "/api/tl-host/out", "h1", body)
	if code != 200 || !reflect.DeepEqual(m["gone"], []any{"s_unknown"}) {
		t.Fatalf("out: %d %v", code, m)
	}
	w1 := g.br.take("w1")
	if types(w1) != "tl_sync:"+s1+" tl_sync:"+s1 || wire(t, w1[1])["messages"].([]any)[0] != "4" {
		t.Fatalf("w1 got %s", types(w1))
	}
	w2 := g.br.take("w2")
	if len(w2) != 2 || typeOf(w2[0]) != "tl_sync" || w2[1] != (closedEvent{"tl_closed", "b2", s2, "rejected by tldraw"}) {
		t.Fatalf("w2 got %#v", w2)
	}
	if code, _ := g.do("POST", "/api/tl/b2/sync", "w2", map[string]any{"session": s2, "messages": []string{}}); code != 410 {
		t.Fatalf("sync on a closed session: %d", code)
	}
	if evs := g.br.take("h1"); len(evs) != 0 {
		t.Fatalf("host got %s for a close it made", types(evs))
	}
	// a window whose stream is gone: its session is forgotten and listed in gone
	g.br.setKnown("w2", false)
	code, m = g.do("POST", "/api/tl-host/out", "h1", map[string]any{"out": []any{map[string]any{"session": s3, "messages": []string{"x"}}}})
	if code != 200 || !reflect.DeepEqual(m["gone"], []any{s3}) {
		t.Fatalf("out to a gone window: %d %v", code, m)
	}
	// empty body: gone is an empty list, not null
	code, m = g.do("POST", "/api/tl-host/out", "h1", nil)
	if code != 200 || !reflect.DeepEqual(m["gone"], []any{}) {
		t.Fatalf("empty out: %d %v", code, m)
	}
	// only the host
	for _, c := range []string{"w1", "h9"} {
		if code, m := g.do("POST", "/api/tl-host/out", c, body); code != 403 || m["code"] != "not_board_host" {
			t.Fatalf("out by %s: %d %v", c, code, m)
		}
	}
}

func TestOutOfAnOldHostCannotReachNewSessions(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	old := g.open("b1", "w1")
	g.startHost("h2")
	s := g.open("b1", "w1")
	g.br.take("w1")
	if code, _ := g.do("POST", "/api/tl-host/out", "h1", map[string]any{"out": []any{map[string]any{"session": old, "messages": []string{}}}}); code != 403 {
		t.Fatalf("out by the old host: %d", code)
	}
	code, m := g.do("POST", "/api/tl-host/out", "h2", map[string]any{
		"out":    []any{map[string]any{"session": old, "messages": []string{}}, map[string]any{"session": s, "messages": []string{"y"}}},
		"closed": []any{map[string]any{"session": old, "reason": "x"}},
	})
	if code != 200 || !reflect.DeepEqual(m["gone"], []any{old}) {
		t.Fatalf("out: %d %v", code, m)
	}
	if evs := g.br.take("w1"); types(evs) != "tl_sync:"+s {
		t.Fatalf("w1 got %s", types(evs))
	}
}

func TestSnapshotRoutes(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	for _, c := range []string{"w1", "h9"} {
		if code, m := g.do("GET", "/api/tl/b1/snapshot", c, nil); code != 403 || m["code"] != "not_board_host" {
			t.Fatalf("GET by %s: %d %v", c, code, m)
		}
		if code, m := g.do("PUT", "/api/tl/b1/snapshot", c, `{}`); code != 403 || m["code"] != "not_board_host" {
			t.Fatalf("PUT by %s: %d %v", c, code, m)
		}
	}
	if code, body, _ := g.doRaw("GET", "/api/tl/b1/snapshot", "h1", nil); code != 204 || len(body) != 0 {
		t.Fatalf("GET of none: %d %q", code, body)
	}
	snap := `{"document":{"store":{"a":"<&>"}},"schema":{}}`
	if code, m := g.do("PUT", "/api/tl/b1/snapshot", "h1", snap); code != 200 || m["ok"] != true {
		t.Fatalf("PUT: %d %v", code, m)
	}
	code, body, h := g.doRaw("GET", "/api/tl/b1/snapshot", "h1", nil)
	if code != 200 || string(body) != snap || h.Get("Content-Type") != "application/json" {
		t.Fatalf("GET: %d %q %v", code, body, h)
	}
	if code, m := g.do("PUT", "/api/tl/arch/snapshot", "h1", snap); code != 200 {
		t.Fatalf("PUT on an archived board: %d %v", code, m)
	}
	for _, bad := range []string{``, `{`, `{"a":}`, `nope`} {
		if code, m := g.do("PUT", "/api/tl/b1/snapshot", "h1", bad); code != 400 {
			t.Fatalf("PUT %q: %d %v", bad, code, m)
		}
	}
	if code, _ := g.do("PUT", "/api/tl/gone/snapshot", "h1", snap); code != 404 {
		t.Fatalf("PUT on an unknown board: %d", code)
	}
	g.bs.mu.Lock()
	g.bs.saveErr = errBoom
	g.bs.mu.Unlock()
	if code, _ := g.do("PUT", "/api/tl/b1/snapshot", "h1", snap); code != 500 {
		t.Fatalf("PUT that fails: %d", code)
	}
}

func TestBoardGone(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	s1 := g.open("b1", "w1")
	s2 := g.open("b1", "w2")
	s3 := g.open("b2", "w2")
	g.br.take("h1")
	g.bs.archive("b1")
	g.r.BoardGone("b1", "archived")
	if evs := g.br.take("w1"); len(evs) != 1 || evs[0] != (closedEvent{"tl_closed", "b1", s1, "archived"}) {
		t.Fatalf("w1 got %#v", evs)
	}
	if evs := g.br.take("w2"); len(evs) != 1 || evs[0] != (closedEvent{"tl_closed", "b1", s2, "archived"}) {
		t.Fatalf("w2 got %#v", evs)
	}
	if evs := g.br.take("h1"); len(evs) != 1 || evs[0] != (dropEvent{"tl_drop", "b1", "archived"}) {
		t.Fatalf("host got %#v", evs)
	}
	if code, _ := g.do("POST", "/api/tl/b2/sync", "w2", map[string]any{"session": s3, "messages": []string{}}); code != 200 {
		t.Fatalf("the other board's session: %d", code)
	}
	if code, m := g.do("POST", "/api/tl/b1/open", "w1", nil); code != 409 || m["code"] != "archived" {
		t.Fatalf("open after archive: %d %v", code, m)
	}
	// no host: nothing to drop, nothing sent
	g.br.take("h1")
	g.endClient("h1")
	g.br.take("w2")
	g.r.BoardGone("b2", "deleted")
	if evs := g.br.all("h1"); len(evs) != 0 {
		t.Fatalf("a gone host got %#v", evs)
	}
}

func TestOpenUnavailable(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	g.host.mu.Lock()
	g.host.ensure = func(context.Context) (string, error) {
		return "", fmt.Errorf("%w: node was not found", headless.ErrUnavailable)
	}
	g.host.mu.Unlock()
	code, m := g.do("POST", "/api/tl/b1/open", "w1", nil)
	if code != 503 || m["code"] != "board_host_unavailable" || m["error"] != "node was not found" {
		t.Fatalf("open: %d %v", code, m)
	}
	// the request's context bounds the wait
	g.host.mu.Lock()
	g.host.ensure = func(ctx context.Context) (string, error) { <-ctx.Done(); return "", ctx.Err() }
	g.host.mu.Unlock()
	g.r.openTimeout = 10e6 // 10 ms
	code, m = g.do("POST", "/api/tl/b1/open", "w1", nil)
	if code != 503 || m["error"] != "it did not start in time" {
		t.Fatalf("open, slow start: %d %v", code, m)
	}
	// no host manager at all
	g2 := newRig(t)
	g2.r.SetHost(nil)
	if code, m := g2.do("POST", "/api/tl/b1/open", "w1", nil); code != 503 || m["error"] != noHostReason {
		t.Fatalf("open with no host: %d %v", code, m)
	}
	if g.sessionCount()+g2.sessionCount() != 0 {
		t.Fatal("a session was made")
	}
}

// The host dies between Ensure and the registration: the session is the new host's, or the answer is 503.
func TestOpenHostDiesAfterEnsure(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	n := 0
	g.host.mu.Lock()
	g.host.ensure = func(context.Context) (string, error) {
		n++
		id := g.hostID()
		if n == 1 { // the first answer names a host that dies at once, and a new one starts
			g.endClient(id)
			g.startHost("h2")
		}
		return id, nil
	}
	g.host.mu.Unlock()
	s := g.open("b1", "w1")
	if evs := g.br.all("h1"); len(evs) != 0 {
		t.Fatalf("the dead host got %s", types(evs))
	}
	if evs := g.br.all("h2"); types(evs) != "tl_open:"+s {
		t.Fatalf("h2 got %s", types(evs))
	}
	g.r.mu.Lock()
	host := g.r.sessions[s].host
	g.r.mu.Unlock()
	if host != "h2" {
		t.Fatalf("session's host %q", host)
	}

	// both answers name a host that dies: 503, no session
	g.host.mu.Lock()
	k := 2
	g.host.ensure = func(context.Context) (string, error) {
		id := g.hostID()
		k++
		g.endClient(id)
		g.startHost(fmt.Sprintf("h%d", k))
		return id, nil
	}
	g.host.mu.Unlock()
	if code, m := g.do("POST", "/api/tl/b1/open", "w2", nil); code != 503 || m["code"] != "board_host_unavailable" {
		t.Fatalf("open: %d %v", code, m)
	}
	if n := g.sessionCount(); n != 0 {
		t.Fatalf("%d sessions", n)
	}
}

// A board archived while the host started: the open is refused and the host is told to close.
func TestOpenArchivedWhileStarting(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	g.host.mu.Lock()
	g.host.ensure = func(context.Context) (string, error) {
		g.bs.archive("b1")
		g.r.BoardGone("b1", "archived")
		return g.hostID(), nil
	}
	g.host.mu.Unlock()
	if code, m := g.do("POST", "/api/tl/b1/open", "w1", nil); code != 409 || m["code"] != "archived" {
		t.Fatalf("open: %d %v", code, m)
	}
	evs := g.br.all("h1")
	if len(evs) != 3 || typeOf(evs[0]) != "tl_drop" || typeOf(evs[1]) != "tl_open" || typeOf(evs[2]) != "tl_close" || sessionOf(evs[1]) != sessionOf(evs[2]) {
		t.Fatalf("host got %s", types(evs))
	}
	if n := g.sessionCount(); n != 0 {
		t.Fatalf("%d sessions", n)
	}
}
