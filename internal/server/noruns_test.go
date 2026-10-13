package server

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// This server has no runs: what it answers a client that asks for one, on both listeners, and
// what its answers do not hold. A server built with runs, as an API client's server can be, reads
// the remote listener's 404 {"error":"not found"} as "that server has no runs".

// keysNamed returns the paths of the keys of the JSON value that have one of the names, at any
// depth.
func keysNamed(v any, at string, names ...string) (found []string) {
	switch v := v.(type) {
	case map[string]any:
		for k, sub := range v {
			if slices.Contains(names, k) {
				found = append(found, at+"."+k)
			}
			found = append(found, keysNamed(sub, at+"."+k, names...)...)
		}
	case []any:
		for _, sub := range v {
			found = append(found, keysNamed(sub, at+"[]", names...)...)
		}
	}
	return found
}

// No route under /api/runs is registered or in the remote listener's table, and a request for
// one is answered as any route the listener does not have: by the remote listener's table with
// 404 {"error":"not found"}, on loopback by the mux with its own plain 404.
func TestNoRunRoutes(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	for _, p := range e.s.routes().patterns {
		if strings.Contains(p, "/api/runs") {
			t.Errorf("the mux has the route %q", p)
		}
	}
	for _, p := range RemoteRoutes {
		if strings.Contains(p, "/api/runs") {
			t.Errorf("the remote listener's table has the route %q", p)
		}
	}
	for _, rq := range [][2]string{
		{"POST", "/api/runs"},
		{"GET", "/api/runs/x"},
		{"GET", "/api/runs/check"},
		{"PUT", "/api/runs/x"},
		{"PATCH", "/api/runs/x"},
		{"DELETE", "/api/runs/x"},
		{"GET", "/api/runs/x/detail"},
		{"POST", "/api/runs/x/start"},
		{"POST", "/api/runs/x/unfollow"},
		{"POST", "/api/runs/x/archive"},
		{"POST", "/api/runs/x/unarchive"},
	} {
		if status, out := e.do(rq[0], rq[1], `{}`); status != 404 || out != "404 page not found\n" {
			t.Errorf("%s %s on loopback: %d %q", rq[0], rq[1], status, out)
		}
		if status, out := l.call(apiX, testSecret, rq[0], rq[1], `{}`); status != 404 || strings.TrimSpace(out) != `{"error":"not found"}` {
			t.Errorf("%s %s on the remote listener: %d %q", rq[0], rq[1], status, out)
		}
	}
}

// The state and the stream's snapshot, a page's and an API client's, name no run: no list of
// runs, and no run or role in a chat's view, in a state record or in the defaults. A page's
// creation of a chat reads no run: the body's group alone says where the chat is.
func TestStateNamesNoRun(t *testing.T) {
	t.Parallel()
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	onRun := `{"agent":"claude","run":"r_x"}`
	if msg := decode[refusal](t, e.expect(400, "POST", "/api/chats", onRun)).Error; !strings.Contains(msg, "group is empty") {
		t.Fatalf("a chat with a run and no group: %q", msg)
	}
	if status, out := l.call(apiX, testSecret, "POST", "/api/chats", onRun); status != 400 || !strings.Contains(out, "group is empty") {
		t.Fatalf("a chat with a run and no group, on the remote listener: %d %q", status, out)
	}
	if n := len(e.a.Chats.Views()); n != 0 {
		t.Fatalf("%d chats after the refused creation", n)
	}
	// One chat of the page's, started, so that the defaults hold what a first message records,
	// and one of the API client's.
	own := e.chat(`{"agent":"claude","group":"` + model.Ungrouped + `","run":"r_x"}`)
	if own.Group != model.Ungrouped {
		t.Fatalf("a chat made with a group and a run: %+v", own)
	}
	status, out := l.call(apiX, testSecret, "POST", "/api/chats", `{"agent":"claude","group":"`+model.Ungrouped+`","run":"r_x"}`)
	if remote := decode[model.ChatView](t, out); status != 200 || remote.Group != model.Ungrouped {
		t.Fatalf("a chat made with a group and a run, on the remote listener: %d %+v", status, remote)
	}
	e.expect(200, "POST", "/api/chats/"+own.ID+"/messages", `{"text":"hello"}`)
	x, _ := l.api(apiX)
	startedBy(t, x, chat1)

	check := func(what, raw string, chat string) {
		t.Helper()
		var v any
		if err := json.Unmarshal([]byte(raw), &v); err != nil {
			t.Fatalf("%s: %v", what, err)
		}
		if !strings.Contains(raw, chat) {
			t.Fatalf("%s lacks the chat %s: %s", what, chat, raw)
		}
		if found := keysNamed(v, "", "runs", "run", "role"); len(found) != 0 {
			t.Errorf("%s has the keys %v", what, found)
		}
	}
	check("the page's state", e.expect(200, "GET", "/api/state", ""), own.ID)
	_, state := x.Do("GET", "/api/state", nil)
	check("the API client's state", string(state), chat1)
	// The snapshots of two new streams.
	raw, _ := json.Marshal(bridgetest.Connect(t, e.url, "P").Welcome())
	check("the page's snapshot", string(raw), own.ID)
	_, snap := l.api(apiX)
	check("the API client's snapshot", snap, chat1)
}

// GET /api/dirs answers with the folder, its parent and its folders, and nothing else, on both
// listeners.
func TestDirsAnswer(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	want := `{"dirs":["sub"],"parent":` + mustJSON(t, filepath.Dir(dir)) + `,"path":` + mustJSON(t, dir) + `}`
	q := "/api/dirs?path=" + url.QueryEscape(dir)
	if got := strings.TrimSpace(e.expect(200, "GET", q, "")); got != want {
		t.Errorf("the page's list: %s, want %s", got, want)
	}
	if status, got := l.call(apiX, testSecret, "GET", q, ""); status != 200 || strings.TrimSpace(got) != want {
		t.Errorf("the API client's list: %d %s, want %s", status, got, want)
	}
}
