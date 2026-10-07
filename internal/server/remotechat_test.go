package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
	"ai-whiteboard/internal/store"
	"ai-whiteboard/internal/usable"
)

// The routes of the chats of other servers, through the real handler: a stand-in (loopback,
// TLS) is the other server, reached through a real servers.Manager and a real relay, and the
// pages are stand-in pages on the real bridge.

const (
	recA   = "2a000000-0000-4000-8000-00000000000a"
	recB   = "2b000000-0000-4000-8000-00000000000b"
	forkID = "2f000000-0000-4000-8000-00000000000f"
	newID  = "2c000000-0000-4000-8000-00000000000c"
)

// farTiming has limits no healthy loopback request reaches and a back-off of 20 and 40 ms.
func farTiming() servers.Timing {
	const limit = 3 * time.Second
	return servers.Timing{
		Dial: limit, Handshake: limit, Headers: limit, Hello: limit, FirstEvent: limit, Call: limit,
		TestStep: limit, Silence: limit,
		Backoff: []time.Duration{20 * time.Millisecond, 40 * time.Millisecond}, Jitter: -1,
	}
}

// viewThere is a chat's view as its server sends it: started, with that server's group.
func viewThere(id string) model.ChatView {
	return model.ChatView{
		ID: id, Agent: model.Claude, Name: "Chat " + id[:2], Group: "g_there", Cwd: "/home/standin/work",
		Model: "standin-model", Locked: true, Status: model.StatusReady,
		Created: time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC),
	}
}

// thereCall is one call the stand-in got on a route of the script.
type thereCall struct {
	Pattern, Method, Path, Query, Body string
}

// upCounter is the chat manager as the relay's Local, counting the snapshots the relay took.
type upCounter struct {
	*chats.Manager
	ups *atomic.Int64
}

func (l upCounter) ServerUp(entry string) {
	l.Manager.ServerUp(entry)
	l.ups.Add(1)
}

// farOpt says how a far differs from the usual one.
type farOpt struct {
	chats  []model.ChatView // the chats the stand-in has; each one has a record here, ungrouped
	runs   []model.RunView  // the runs the stand-in has; each one has a run record here, ungrouped
	local  bool             // this server has a run service, as it has with runs (see remoterun_test.go)
	limits remotes.Limits   // zero fields: Flush 20 ms, the others the defaults
	with   []func(*Server)  // set up the server before the relay is made
}

// far is a server wired as the program wires it, with one entry "Studio" in its list: the
// stand-in.
type far struct {
	*env
	st    *standin.Server
	m     *servers.Manager
	rm    *remotes.Relay
	entry string
	root  string
	ups   atomic.Int64
	rs    *runs.Service // nil without runs

	mu      sync.Mutex
	views   map[string]model.ChatView         // the chats the stand-in has
	runs    map[string]model.RunView          // the runs the stand-in has
	agents  []string                          // the agents' chats the stand-in's run details name
	answers map[string]http.HandlerFunc       // by pattern; none = the route's usual answer
	calls   []thereCall                       // what the stand-in got on the script's routes
	seen    []string                          // every answer and event a page got
	logs    []string                          // the relay's log
	pages   map[string]*bridgetest.Page       // by id
	usage   map[model.AgentKind]*atomic.Int64 // the local usage functions' calls
}

func newFar(t *testing.T, o farOpt) *far {
	t.Helper()
	f := &far{views: map[string]model.ChatView{}, runs: map[string]model.RunView{}, answers: map[string]http.HandlerFunc{}, pages: map[string]*bridgetest.Page{},
		root: t.TempDir(), usage: map[model.AgentKind]*atomic.Int64{model.Claude: {}}}
	snap := standin.DefaultSnapshot()
	states := []model.BranchState{}
	for _, v := range o.chats {
		f.views[v.ID] = v
		states = append(states, model.StateOf(v.ID, "main", v))
	}
	if o.chats != nil {
		snap["chats"], snap["states"] = o.chats, states
	}
	for _, v := range o.runs {
		f.runs[v.ID] = v
	}
	if o.runs != nil {
		snap["runs"] = o.runs
	}
	withRuns := o.local || o.runs != nil
	f.st = standin.Start(t, standin.Options{Snapshot: snap})
	f.script(withRuns)

	wire := func(s *Server) {
		m, err := servers.Open(servers.Options{Root: f.root, LocalID: testLocalID, Version: "test", Notify: s.Bridge.Broadcast, Timing: farTiming()})
		if err != nil {
			t.Fatal(err)
		}
		v, saved, _, err := m.Add(context.Background(), servers.Input{
			Name: "Studio", Address: f.st.URL(), Secret: standin.DefaultSecret, SelfSigned: true, Pin: f.st.Fingerprint(),
		}, true)
		if err != nil || !saved {
			t.Fatalf("the entry is not saved: %v", err)
		}
		f.m, f.entry = m, v.ID
		paths := store.NewPaths(f.root)
		if err := os.MkdirAll(paths.RemoteChats, 0o700); err != nil {
			t.Fatal(err)
		}
		for _, cv := range o.chats {
			rec := remotes.Record{ID: cv.ID, Entry: f.entry, Group: model.Ungrouped, View: cv,
				States: []model.BranchState{model.StateOf(cv.ID, "main", cv)}}
			if cv.Run != "" { // a chat on a run has the run's place
				rec.Run, rec.Group = cv.Run, ""
			}
			raw, _ := json.Marshal(rec)
			if err := os.WriteFile(paths.RemoteChatFile(cv.ID), raw, 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if o.limits.Flush == 0 {
			o.limits.Flush = 20 * time.Millisecond
		}
		var local remotes.LocalRuns
		if withRuns {
			local = f.wireRuns(t, s, o.runs)
		}
		rm, err := remotes.Open(remotes.Options{
			Root: f.root, Servers: m, Bridge: s.Bridge, Local: upCounter{s.App.Chats, &f.ups},
			Group: s.App.GroupState, Limits: o.limits, Runs: local,
			Logf: func(format string, args ...any) {
				f.mu.Lock()
				defer f.mu.Unlock()
				f.logs = append(f.logs, fmt.Sprintf(format, args...))
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		f.rm = rm
		if f.rs != nil {
			f.rs.Remote = rm
		}
		s.App.Chats.Servers = rm
		s.Servers, s.App.Servers = m, m
		s.Remotes, s.App.Remotes = rm, rm
		s.Bridge.OnUnfollowed(rm.Unfollowed)
		s.Usage = map[model.AgentKind]func(bool) (model.PlanUsage, error){
			model.Claude: func(bool) (model.PlanUsage, error) {
				f.usage[model.Claude].Add(1)
				return model.PlanUsage{}, nil
			},
		}
		m.SetHooks(rm.Hooks())
		t.Cleanup(func() { // the order of a shutdown
			m.Close()
			rm.Close()
		})
		m.Start()
	}
	f.env = newEnv(t, append(o.with, wire)...)
	// Runs before the servers stop: nothing a page got holds the secret of the entry.
	t.Cleanup(f.noSecret)
	f.returned(1)
	return f
}

// script makes the stand-in serve the routes a relay calls: every route of a chat, the creation
// call, the folders and the plan usage. Each call is noted, and answered by the handler set for
// its pattern or, without one, as a server that has the chats of f.views.
func (f *far) script(withRuns bool) {
	usual := map[string]http.HandlerFunc{
		"GET /api/chats/{id}": func(w http.ResponseWriter, r *http.Request) {
			f.mu.Lock()
			v, ok := f.views[r.PathValue("id")]
			f.mu.Unlock()
			if !ok {
				writeError(w, http.StatusNotFound, "no such chat")
				return
			}
			writeJSON(w, v)
		},
		"GET /api/chats/{id}/items": func(w http.ResponseWriter, r *http.Request) {
			id := r.PathValue("id")
			writeJSON(w, map[string]any{"branch": "main", "version": 3, "items": []any{map[string]any{"kind": "user", "text": "hello there"}},
				"subagents": []any{}, "state": map[string]any{"chat": id, "branch": "main", "status": "ready"}})
		},
	}
	pats := append((&Server{}).recordRoutes().patterns, "POST /api/chats", "GET /api/dirs", "GET /api/usage/{agent}")
	if withRuns {
		pats = append(append(pats, (&Server{}).runRecordRoutes().patterns...), "GET /api/runs/check")
		for pat, h := range f.usualRuns() {
			usual[pat] = h
		}
	}
	for _, pat := range pats {
		f.st.Handle(pat, func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewReader(body)) // the answer may read it too
			f.mu.Lock()
			f.calls = append(f.calls, thereCall{pat, r.Method, r.URL.Path, r.URL.RawQuery, string(body)})
			h := f.answers[pat]
			f.mu.Unlock()
			switch {
			case h != nil:
				h(w, r)
			case usual[pat] != nil:
				usual[pat](w, r)
			default:
				ok(w)
			}
		})
	}
}

// handle sets what the stand-in answers on the route; nil is the usual answer again.
func (f *far) handle(pat string, h http.HandlerFunc) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answers[pat] = h
}

// answer makes the stand-in answer the route with the status and v as JSON.
func (f *far) answer(pat string, status int, v any) {
	f.handle(pat, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(v)
	})
}

// hang makes the stand-in keep the route's calls without an answer until the test ends.
func (f *far) hang(pat string) {
	free := make(chan struct{})
	f.t.Cleanup(func() { close(free) })
	f.handle(pat, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-free:
		case <-r.Context().Done():
		}
	})
}

// sent are the calls the stand-in got on the route; pat "" is every route of the script.
func (f *far) sent(pat string) []thereCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []thereCall
	for _, c := range f.calls {
		if pat == "" || c.Pattern == pat {
			out = append(out, c)
		}
	}
	return out
}

// last is the last call the stand-in got on the route.
func (f *far) last(pat string) thereCall {
	f.t.Helper()
	got := f.sent(pat)
	if len(got) == 0 {
		f.t.Fatalf("the stand-in got no %s", pat)
	}
	return got[len(got)-1]
}

// untouched runs do and fails when the stand-in got a call of the script's routes meanwhile.
func (f *far) untouched(what string, do func()) {
	f.t.Helper()
	before := len(f.sent(""))
	do()
	if got := f.sent(""); len(got) != before {
		f.t.Errorf("%s: the stand-in was sent %+v", what, got[before:])
	}
}

// wait waits for good.
func (f *far) wait(what string, good func() bool) {
	f.t.Helper()
	for end := time.Now().Add(10 * time.Second); !good(); time.Sleep(2 * time.Millisecond) {
		if time.Now().After(end) {
			f.t.Fatalf("waited in vain: %s", what)
		}
	}
}

// returned waits until the relay has taken n snapshots of the entry.
func (f *far) returned(n int64) {
	f.t.Helper()
	f.wait(fmt.Sprintf("snapshot %d is taken", n), func() bool { return f.ups.Load() >= n })
}

// down stops the stand-in and waits until the entry is no longer connected.
func (f *far) down() {
	f.t.Helper()
	f.st.Stop()
	f.wait("the entry is not connected", func() bool {
		v, _ := f.m.View(f.entry)
		return v.State != servers.StateConnected
	})
}

// page connects a stand-in page and reads its hello and snapshot.
func (f *far) page(id string) *bridgetest.Page {
	f.t.Helper()
	p := bridgetest.Connect(f.t, f.url, id)
	raw, _ := json.Marshal(p.Welcome())
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pages[id] = p
	f.seen = append(f.seen, "snapshot of "+id+": "+string(raw))
	return p
}

// call makes a call of the page and returns the status and the answer.
func (f *far) call(p *bridgetest.Page, method, path, body string) (int, string) {
	f.t.Helper()
	var b any
	if body != "" {
		b = body
	}
	status, out := p.Do(method, path, b)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seen = append(f.seen, method+" "+path+": "+string(out))
	return status, string(out)
}

// good is a call that must answer 200; it returns the answer.
func (f *far) good(p *bridgetest.Page, method, path, body string) map[string]any {
	f.t.Helper()
	status, out := f.call(p, method, path, body)
	if status != http.StatusOK {
		f.t.Fatalf("%s %s: %d %s", method, path, status, out)
	}
	return decode[map[string]any](f.t, out)
}

// refuses is a call that must be answered with the status and the code; it returns the error's
// sentence.
func (f *far) refuses(p *bridgetest.Page, status int, code, method, path, body string) string {
	f.t.Helper()
	got, out := f.call(p, method, path, body)
	var r struct{ Error, Code string }
	json.Unmarshal([]byte(out), &r)
	if got != status || r.Code != code || r.Error == "" {
		f.t.Fatalf("%s %s: %d %s, want %d with the code %q", method, path, got, out, status, code)
	}
	return r.Error
}

// events returns, for each of the pages, the events it was sent and has not read yet. The
// stand-in sends an agents event, which the relay turns into server_lists for every page: what
// the relay made of everything the stand-in sent before is in the lists, and so is what this
// server sent by itself before the call. Every page of the rig is read up to that event, the
// ones that are not asked for too, so that none keeps it for a later call.
func (f *far) events(pages ...*bridgetest.Page) [][]string {
	f.t.Helper()
	f.mu.Lock()
	all := make([]*bridgetest.Page, 0, len(f.pages))
	for _, p := range f.pages {
		all = append(all, p)
	}
	f.mu.Unlock()
	f.st.Send(map[string]any{"type": "agents", "agents": []string{"claude", "pi"}})
	got := map[*bridgetest.Page][]string{}
	for _, p := range all {
		for {
			raw := p.NextRaw()
			f.mu.Lock()
			f.seen = append(f.seen, "event to "+p.ID+": "+raw)
			f.mu.Unlock()
			if typeOf(raw) == "server_lists" {
				break
			}
			got[p] = append(got[p], raw)
		}
	}
	out := make([][]string, len(pages))
	for i, p := range pages {
		out[i] = got[p]
	}
	return out
}

// chatNow is the chat as GET /api/state lists it; ok is false when it lists none with the id.
func (f *far) chatNow(p *bridgetest.Page, id string) (cv model.ChatView, ok bool) {
	f.t.Helper()
	status, out := f.call(p, "GET", "/api/state", "")
	if status != http.StatusOK {
		f.t.Fatalf("GET /api/state: %d %s", status, out)
	}
	var snap struct{ Chats []model.ChatView }
	if err := json.Unmarshal([]byte(out), &snap); err != nil {
		f.t.Fatal(err)
	}
	n := 0
	for _, c := range snap.Chats {
		if c.ID == id {
			cv, n = c, n+1
		}
	}
	if n > 1 {
		f.t.Fatalf("the snapshot lists the chat %s %d times", id, n)
	}
	return cv, n == 1
}

// noSecret fails when an answer, an event or a log line holds the entry's secret. It reads what
// the pages were sent and did not read.
func (f *far) noSecret() {
	f.mu.Lock()
	pages := f.pages
	f.mu.Unlock()
	texts := []string{}
	for id, p := range pages {
		for _, raw := range p.Drain(50 * time.Millisecond) {
			texts = append(texts, "event to "+id+": "+raw)
		}
	}
	f.mu.Lock()
	texts = append(append(texts, f.seen...), f.logs...)
	f.mu.Unlock()
	if len(f.st.Requests()) == 0 {
		f.t.Error("the stand-in was never sent the secret")
	}
	for _, text := range texts {
		if strings.Contains(text, standin.DefaultSecret) || strings.Contains(text, `"secret"`) {
			f.t.Errorf("a secret is in %s", text)
		}
	}
}

// group makes a group and returns its id.
func (f *far) group(p *bridgetest.Page, name, parent string) string {
	f.t.Helper()
	return f.good(p, "POST", "/api/groups", form("name", name, "parent", parent))["id"].(string)
}

// chatRoute says whether a registered pattern is a route of one chat: /api/chats/{id} or below.
func chatRoute(pattern string) bool {
	_, path, _ := strings.Cut(pattern, " ")
	return path == "/api/chats/{id}" || strings.HasPrefix(path, "/api/chats/{id}/")
}

// The table of a record's routes holds exactly the routes the mux has for one chat: a chat
// route that is added to the mux without a row here would reach the chat manager for a record,
// which knows no such chat.
func TestRecordRoutesAreTheChatRoutesOfTheMux(t *testing.T) {
	s := newEnv(t).s
	var mux []string
	for _, p := range s.routes().patterns {
		if chatRoute(p) {
			mux = append(mux, p)
		}
	}
	table := slices.Clone(s.recordRoutes().patterns)
	for _, p := range table {
		if !chatRoute(p) {
			t.Errorf("the table holds %q, which is no route of one chat", p)
		}
	}
	sort.Strings(mux)
	sort.Strings(table)
	if !slices.Equal(mux, table) {
		t.Fatalf("the mux has the chat routes\n%s\nand the table of a record\n%s", strings.Join(mux, "\n"), strings.Join(table, "\n"))
	}
	if len(table) != 17 {
		t.Fatalf("%d routes of one chat, want 17: is a row of the design's table missing?", len(table))
	}
	// Every route of the remote listener's table that is a chat's is one of them too.
	for _, p := range RemoteRoutes {
		if chatRoute(p) && !slices.Contains(table, p) {
			t.Errorf("%q is served to an API client and has no row", p)
		}
	}
}

// sameQuery compares two query strings as sets of values.
func sameQuery(a, b string) bool {
	x, _ := url.ParseQuery(a)
	y, _ := url.ParseQuery(b)
	return reflect.DeepEqual(x, y)
}

// The rows that are passed on as they are: the stand-in gets the method, the path, the query
// and the body, and the page gets what it answered, a refusal with its status too.
func TestRecordRoutesPassOn(t *testing.T) {
	f := newFar(t, farOpt{chats: []model.ChatView{viewThere(recA)}})
	p := f.page("P")
	rows := []struct {
		pat, method, rest, query, body string
	}{
		{"GET /api/chats/{id}/tree", "GET", "/tree", "", ""},
		{"GET /api/chats/{id}/subagents/{sid}/items", "GET", "/subagents/sub-1/items", "branch=b1", ""},
		{"GET /api/chats/{id}/context", "GET", "/context", "branch=b1&fresh=1", ""},
		{"GET /api/chats/{id}/context", "GET", "/context", "", ""},
		{"POST /api/chats/{id}/messages", "POST", "/messages", "branch=b1", `{"text":"go on","references":[{"quote":"q","item":1,"start":0,"end":1}]}`},
		{"POST /api/chats/{id}/messages", "POST", "/messages", "", `{"text":"there","target":{"branch":"main","at":2,"new":true}}`},
		{"POST /api/chats/{id}/interrupt", "POST", "/interrupt", "branch=b1", ""},
		{"POST /api/chats/{id}/permission", "POST", "/permission", "branch=b1", `{"requestId":"r1","allow":true}`},
		{"POST /api/chats/{id}/open", "POST", "/open", "branch=b1", ""},
		{"PUT /api/chats/{id}/label", "PUT", "/label", "", `{"branch":"main","item":1,"text":"a name"}`},
	}
	for i, row := range rows {
		path := "/api/chats/" + recA + row.rest
		if row.query != "" {
			path += "?" + row.query
		}
		for _, status := range []int{http.StatusOK, http.StatusConflict, http.StatusInternalServerError} {
			want := map[string]any{"row": float64(i), "status": float64(status)}
			if status != http.StatusOK {
				want["error"], want["code"] = "refused there", "busy"
			}
			f.answer(row.pat, status, want)
			got, out := f.call(p, row.method, path, row.body)
			if got != status || !reflect.DeepEqual(decode[map[string]any](t, out), want) {
				t.Errorf("%s %s: %d %s, want %d %v", row.method, path, got, out, status, want)
			}
			c := f.last(row.pat)
			if c.Method != row.method || c.Path != "/api/chats/"+recA+row.rest || !sameQuery(c.Query, row.query) || c.Body != row.body {
				t.Errorf("%s %s: the stand-in got %+v", row.method, path, c)
			}
		}
	}
	// A body that is no JSON is refused here, as for a chat of this server.
	f.untouched("a body that is no JSON", func() {
		for _, rest := range []string{"/messages", "/permission", "/label", "/fork"} {
			method := "POST"
			if rest == "/label" {
				method = "PUT"
			}
			if status, out := f.call(p, method, "/api/chats/"+recA+rest, "{"); status != http.StatusBadRequest {
				t.Errorf("%s with a cut body: %d %s", rest, status, out)
			}
		}
	})
	// A route the table does not have is no route of a record either.
	if status, _ := f.call(p, "GET", "/api/chats/"+recA+"/nothing", ""); status != http.StatusNotFound {
		t.Errorf("a route that is not in the table: %d", status)
	}
}

// The rows that this server has a part in: the view, the reads that follow, the draft, a send,
// the change of name, model and place, the fork, archive and unarchive, unfollow and delete.
func TestRecordRoutes(t *testing.T) {
	f := newFar(t, farOpt{chats: []model.ChatView{viewThere(recA), viewThere(recB)}})
	p, q := f.page("P"), f.page("Q")
	chat := "/api/chats/" + recA

	// A call that changes something must come from a known client, on a record's route as on
	// any other: the guard stands in front of the record's routes, and nothing is passed on.
	f.untouched("a call of no known client", func() {
		for _, client := range []string{"", "nobody"} {
			for _, c := range [][2]string{
				{"POST", chat + "/messages"}, {"POST", chat + "/interrupt"}, {"POST", chat + "/fork"}, {"POST", chat + "/archive"},
				{"POST", chat + "/unfollow"}, {"PUT", chat + "/draft?rev=0"}, {"PATCH", chat}, {"DELETE", chat}, {"DELETE", chat + "?local=1"},
			} {
				status, out := f.doAs(client, c[0], c[1], `{"text":"hi"}`)
				if status != http.StatusConflict || decode[map[string]string](t, out)["error"] != "unknown_client" {
					t.Errorf("%s %s of the client %q: %d %s", c[0], c[1], client, status, out)
				}
			}
		}
	})
	if now, ok := f.chatNow(p, recA); !ok || now.Archived || now.HasDraft {
		t.Fatalf("the record after the calls of no known client: %+v, listed %v", now, ok)
	}

	// The view: passed on, and answered as the record's view: this server's place, the entry.
	there := viewThere(recA)
	there.Name, there.Status = "Renamed there", model.StatusThinking
	f.answer("GET /api/chats/{id}", http.StatusOK, there)
	got := f.good(p, "GET", chat, "")
	if got["id"] != recA || got["name"] != "Renamed there" || got["status"] != "thinking" || got["group"] != model.Ungrouped ||
		got["server"] != f.entry || got["locked"] != true {
		t.Fatalf("the view: %v", got)
	}
	if c := f.last("GET /api/chats/{id}"); c.Path != chat {
		t.Fatalf("the view was read with %+v", c)
	}
	f.handle("GET /api/chats/{id}", nil)
	if evs := f.events(p, q); count(evs[0], "chat", recA, "Renamed there") != 1 || count(evs[1], "chat", recA, "Renamed there") != 1 {
		t.Fatalf("the pages were told of the view: %v and %v", types(evs[0]), types(evs[1]))
	}

	// The draft is this server's: nothing is sent, the counter decides.
	f.untouched("a draft", func() {
		if got := f.good(p, "PUT", chat+"/draft?rev=0", `{"text":"typing"}`); got["rev"] != float64(1) {
			t.Errorf("the first draft: %v", got)
		}
		status, out := f.call(q, "PUT", chat+"/draft?rev=0", `{"text":"too late"}`)
		stale := decode[map[string]any](t, out)
		if status != http.StatusConflict || stale["code"] != "stale" || stale["rev"] != float64(1) || field(stale, "draft", "text") != "typing" {
			t.Errorf("a draft on an old counter: %d %s", status, out)
		}
		if status, out := f.call(p, "PUT", chat+"/draft", `{"text":"x"}`); status != http.StatusBadRequest || !strings.Contains(out, "rev is missing") {
			t.Errorf("a draft without rev: %d %s", status, out)
		}
		if status, out := f.call(p, "PUT", chat+"/draft?rev=x", `{"text":"x"}`); status != http.StatusBadRequest || !strings.Contains(out, "rev is not a number") {
			t.Errorf("a draft with a rev that is no number: %d %s", status, out)
		}
	})
	if cv, _ := f.chatNow(p, recA); cv.Draft == nil || cv.Draft.Text != "typing" || cv.DraftRev != 1 || !cv.HasDraft {
		t.Fatalf("the draft in the snapshot: %+v", cv)
	}
	if evs := f.events(q); count(evs[0], "branch_state", recA, "typing") != 1 || count(evs[0], "chat", recA, "typing") != 1 {
		t.Fatalf("the other page was told of the draft: %v", evs[0])
	}

	// The items: the page follows, the state in the answer holds this server's draft, the rest
	// is what came.
	items := f.good(p, "GET", chat+"/items?branch=main", "")
	if items["version"] != float64(3) || field(items, "items").([]any)[0].(map[string]any)["text"] != "hello there" ||
		field(items, "state", "draft", "text") != "typing" || field(items, "state", "draftRev") != float64(1) {
		t.Fatalf("the items: %v", items)
	}
	if c := f.last("GET /api/chats/{id}/items"); c.Path != chat+"/items" || c.Query != "branch=main" {
		t.Fatalf("the items were read with %+v", c)
	}
	f.events(p, q)
	content := `{"type":"chat_items","chat":"` + recA + `","branch":"main","version":4,"items":[{"kind":"assistant","text":"a  reply"}]}`
	f.st.Send(json.RawMessage(content))
	if evs := f.events(p, q); len(evs[0]) != 1 || evs[0][0] != content || len(evs[1]) != 0 {
		t.Fatalf("a content event: the reader got %v, the other page %v", evs[0], evs[1])
	}

	// A send: on 200 the draft of the answer's branch is cleared and its counter raised.
	f.answer("POST /api/chats/{id}/messages", http.StatusOK, map[string]any{"ok": true, "branch": "main"})
	if got := f.good(p, "POST", chat+"/messages", `{"text":"typing"}`); got["branch"] != "main" {
		t.Fatalf("a send: %v", got)
	}
	if cv, _ := f.chatNow(p, recA); cv.Draft != nil || cv.DraftRev != 2 || cv.HasDraft {
		t.Fatalf("the draft after a send: %+v", cv)
	}

	// Name and model are passed on in one call with the branch; the place is this server's.
	renamed := viewThere(recA)
	renamed.Name, renamed.Model = "By the page", "other-model"
	f.answer("PATCH /api/chats/{id}", http.StatusOK, map[string]any{"ok": true, "chat": renamed})
	got = f.good(p, "PATCH", chat+"?branch=b1", `{"name":"By the page","model":"other-model"}`)
	if got["ok"] != true || field(got, "chat", "name") != "By the page" || field(got, "chat", "model") != "other-model" || field(got, "chat", "server") != f.entry {
		t.Fatalf("a change of name and model: %v", got)
	}
	if c := f.last("PATCH /api/chats/{id}"); c.Query != "branch=b1" || !reflect.DeepEqual(decode[map[string]any](t, c.Body), map[string]any{"name": "By the page", "model": "other-model"}) {
		t.Fatalf("the change was passed on as %+v", c)
	}
	g := f.group(p, "Here", "")
	f.untouched("a move", func() {
		if got := f.good(p, "PATCH", chat, form("group", g)); field(got, "chat", "group") != g {
			t.Errorf("a move: %v", got)
		}
		if status, out := f.call(p, "PATCH", chat, `{"group":"g_none"}`); status != http.StatusNotFound {
			t.Errorf("a move to no group: %d %s", status, out)
		}
		if status, out := f.call(p, "PATCH", chat, `{"group":""}`); status != http.StatusBadRequest {
			t.Errorf("a move to the group \"\": %d %s", status, out)
		}
		old := f.group(p, "Old", "")
		f.good(p, "POST", "/api/groups/"+old+"/archive", "")
		if status, out := f.call(p, "PATCH", chat, form("group", old)); status != http.StatusConflict || !strings.Contains(out, "archived") {
			t.Errorf("a move to an archived group: %d %s", status, out)
		}
	})
	if cv, _ := f.chatNow(p, recA); cv.Group != g {
		t.Fatalf("the place after the moves: %q, want %q", cv.Group, g)
	}

	// A fork: the stand-in makes it, and it gets a record in the source's place.
	fork := viewThere(forkID)
	fork.Name, fork.Fresh, fork.ForkedFrom = "Fork", true, recA
	f.mu.Lock()
	f.views[forkID] = fork
	f.mu.Unlock()
	f.answer("POST /api/chats/{id}/fork", http.StatusOK, fork)
	got = f.good(p, "POST", chat+"/fork", `{"branch":"main","at":2}`)
	if got["id"] != forkID || got["group"] != g || got["server"] != f.entry || got["name"] != "Fork" {
		t.Fatalf("the fork: %v", got)
	}
	if c := f.last("POST /api/chats/{id}/fork"); c.Path != chat+"/fork" || c.Body != `{"branch":"main","at":2}` {
		t.Fatalf("the fork was passed on as %+v", c)
	}
	if !f.rm.Has(forkID) {
		t.Fatal("the fork has no record")
	}
	if got := f.good(p, "GET", "/api/chats/"+forkID, ""); got["id"] != forkID || got["server"] != f.entry {
		t.Fatalf("the fork's view through its own routes: %v", got)
	}
	if cv, ok := f.chatNow(q, forkID); !ok || cv.Group != g || cv.Server != f.entry {
		t.Fatalf("the fork in the snapshot: %+v, %v", cv, ok)
	}

	// Archive: the mark shows, with an action of this server, and the stand-in is asked. A
	// send and a change of the model are refused here meanwhile.
	f.good(p, "POST", chat+"/archive", "")
	if c := f.last("POST /api/chats/{id}/archive"); c.Path != chat+"/archive" {
		t.Fatalf("the archive was passed on as %+v", c)
	}
	if cv, _ := f.chatNow(p, recA); !cv.Archived || !strings.HasPrefix(cv.Op, "a_") {
		t.Fatalf("after the archive: %+v", cv)
	}
	f.untouched("an archived record", func() {
		if status, out := f.call(p, "POST", chat+"/messages", `{"text":"hi"}`); status != http.StatusConflict || !strings.Contains(out, "the chat is archived") {
			t.Errorf("a send to an archived record: %d %s", status, out)
		}
		if status, out := f.call(p, "PATCH", chat, `{"model":"m"}`); status != http.StatusConflict || !strings.Contains(out, "the chat is archived") {
			t.Errorf("a model for an archived record: %d %s", status, out)
		}
	})
	f.good(p, "POST", chat+"/unarchive", "")
	if c := f.last("POST /api/chats/{id}/unarchive"); c.Path != chat+"/unarchive" {
		t.Fatalf("the unarchive was passed on as %+v", c)
	}
	if cv, _ := f.chatNow(p, recA); cv.Archived || cv.Op != "" {
		t.Fatalf("after the unarchive: %+v", cv)
	}

	// Unfollow: the page's follow ends here; it was the last, so the hook asks the stand-in.
	if !f.s.Bridge.Followed(editorbridge.Chat(recA)) {
		t.Fatal("the reader does not follow the chat")
	}
	f.good(p, "POST", chat+"/unfollow", "")
	if f.s.Bridge.Followed(editorbridge.Chat(recA)) {
		t.Fatal("the chat is followed after the unfollow")
	}
	f.wait("the stand-in is told of the unfollow", func() bool { return len(f.sent("POST /api/chats/{id}/unfollow")) == 1 })
	if c := f.last("POST /api/chats/{id}/unfollow"); c.Path != chat+"/unfollow" {
		t.Fatalf("the unfollow there: %+v", c)
	}

	// Delete: "this sidebar only" is refused while the server is connected; the delete is
	// passed on, and the record goes with the chat.
	f.untouched("a removal from the sidebar only", func() {
		f.refuses(p, http.StatusConflict, "server_connected", "DELETE", chat+"?local=1", "")
	})
	f.events(p, q)
	f.good(p, "DELETE", chat, "")
	if c := f.last("DELETE /api/chats/{id}"); c.Path != chat || c.Method != "DELETE" {
		t.Fatalf("the delete was passed on as %+v", c)
	}
	if evs := f.events(q); count(evs[0], "chat_removed", recA) != 1 {
		t.Fatalf("the other page after the delete: %v", evs[0])
	}
	if _, ok := f.chatNow(p, recA); ok || f.rm.Has(recA) {
		t.Fatal("the record is still there after the delete")
	}
	// The id is no chat's now: the routes of this server's own chats answer.
	f.untouched("a chat that is deleted", func() {
		if status, out := f.call(p, "GET", chat, ""); status != http.StatusNotFound || !strings.Contains(out, "no such chat") {
			t.Errorf("the view of the deleted chat: %d %s", status, out)
		}
	})
	if _, ok := f.chatNow(p, recB); !ok {
		t.Fatal("the other record is gone too")
	}
}

// What the page gets when a call cannot be made: the status table of the relay, through the
// routes.
func TestRecordCallsThatCannotBeMade(t *testing.T) {
	f := newFar(t, farOpt{chats: []model.ChatView{viewThere(recA), viewThere(recB)},
		limits: remotes.Limits{Call: 150 * time.Millisecond, Start: 150 * time.Millisecond}})
	p := f.page("P")
	a, b := "/api/chats/"+recA, "/api/chats/"+recB

	// Any other answer goes to the page as it came.
	f.answer("POST /api/chats/{id}/interrupt", http.StatusTeapot, map[string]any{"error": "not now", "code": "odd", "more": []any{"x"}})
	if status, out := f.call(p, "POST", b+"/interrupt", ""); status != http.StatusTeapot ||
		!reflect.DeepEqual(decode[map[string]any](t, out), map[string]any{"error": "not now", "code": "odd", "more": []any{"x"}}) {
		t.Errorf("another answer: %d %s", status, out)
	}
	// A 404 that is not "no such chat" is the server's answer, and marks nothing.
	f.answer("GET /api/chats/{id}/items", http.StatusNotFound, map[string]string{"error": "no such branch"})
	if status, out := f.call(p, "GET", b+"/items?branch=b9", ""); status != http.StatusNotFound || !strings.Contains(out, "no such branch") {
		t.Errorf("no such branch: %d %s", status, out)
	}
	if cv, _ := f.chatNow(p, recB); cv.Gone {
		t.Error("the record is gone after another 404")
	}

	// "no such chat" there: the record is marked gone, the page is told, and nothing follows it.
	f.events(p)
	f.answer("GET /api/chats/{id}/items", http.StatusNotFound, map[string]string{"error": "no such chat"})
	if text := f.refuses(p, http.StatusNotFound, "gone_there", "GET", a+"/items", ""); text != "This chat is no longer on Studio." {
		t.Errorf("gone there: %q", text)
	}
	if evs := f.events(p); count(evs[0], "chat", recA, `"gone":true`) != 1 {
		t.Errorf("the page after the chat was found gone: %v", evs[0])
	}
	if cv, ok := f.chatNow(p, recA); !ok || !cv.Gone || f.s.Bridge.Followed(editorbridge.Chat(recA)) {
		t.Errorf("the gone record: %+v, listed %v", cv, ok)
	}
	f.handle("GET /api/chats/{id}/items", nil)

	// Sent, no answer.
	f.hang("POST /api/chats/{id}/interrupt")
	if text := f.refuses(p, http.StatusGatewayTimeout, "no_answer", "POST", b+"/interrupt", ""); text != "Studio did not answer." {
		t.Errorf("no answer: %q", text)
	}
	f.hang("POST /api/chats/{id}/messages")
	if text := f.refuses(p, http.StatusGatewayTimeout, "send_unknown", "POST", b+"/messages", `{"text":"hi"}`); text != "Studio did not answer: it is not known whether the message arrived." {
		t.Errorf("a send without an answer: %q", text)
	}

	// 401 there is the entry's matter.
	f.answer("GET /api/chats/{id}/tree", http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
	if text := f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", "GET", b+"/tree", ""); text != "Studio is not connected." {
		t.Errorf("401 there: %q", text)
	}

	// Not connected: nothing is sent, whatever the call.
	f.down()
	f.untouched("an entry that is not connected", func() {
		for _, c := range [][3]string{
			{"GET", b, ""}, {"GET", b + "/items", ""}, {"GET", b + "/tree", ""}, {"GET", b + "/context", ""},
			{"POST", b + "/messages", `{"text":"hi"}`}, {"POST", b + "/interrupt", ""}, {"POST", b + "/open", ""},
			{"POST", b + "/permission", `{"requestId":"r","allow":true}`}, {"PUT", b + "/label", `{"branch":"main","item":1,"text":"x"}`},
			{"PATCH", b, `{"name":"n"}`}, {"POST", b + "/fork", `{"at":1}`}, {"DELETE", b, ""},
			{"GET", "/api/dirs?server=" + f.entry, ""}, {"GET", "/api/usage/claude?server=" + f.entry, ""},
		} {
			if text := f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", c[0], c[1], c[2]); text != "Studio is not connected." {
				t.Errorf("%s %s while not connected: %q", c[0], c[1], text)
			}
		}
		// What is this server's still works: the draft, the place, the archive mark, and the
		// removal from the sidebar.
		f.good(p, "PUT", b+"/draft?rev=0", `{"text":"kept"}`)
		f.good(p, "PATCH", b, `{"group":"`+model.Ungrouped+`"}`)
		f.good(p, "POST", b+"/archive", "")
		if cv, _ := f.chatNow(p, recB); !cv.Archived || cv.Draft == nil {
			t.Errorf("the record while its server is away: %+v", cv)
		}
		f.good(p, "POST", b+"/unarchive", "")
		f.good(p, "DELETE", b+"?local=1", "")
		if _, ok := f.chatNow(p, recB); ok {
			t.Error("the record is listed after its removal from the sidebar")
		}
	})
}

// The first message of a chat that will start on another server is one creation call there, and
// the chat is a record under its own id from then on (AC30). A record, a fork of one and a
// branch refuse a change of server and of agent.
func TestFirstMessageOfAChatOnAnotherServer(t *testing.T) {
	f := newFar(t, farOpt{})
	p, q := f.page("P"), f.page("Q")
	g := f.group(p, "Work", "")
	chat := "/api/chats/" + newID

	cv := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", form("id", newID, "group", g, "server", f.entry)))
	if cv.ID != newID || cv.Server != f.entry || cv.Agent != model.Claude || cv.Cwd != "/home/standin/work" || cv.Locked {
		t.Fatalf("the new chat: %+v", cv)
	}
	if _, there := f.a.Chats.RemoteUnstarted(newID); !there || f.rm.Has(newID) {
		t.Fatal("the new chat is not one that waits for its first message")
	}
	f.good(p, "GET", chat+"/items", "") // the page shows the chat: it follows it

	// More than the text is refused before anything is sent.
	f.untouched("a first message with more than its text", func() {
		for what, c := range map[string][2]string{
			"a target":   {chat + "/messages", `{"text":"hi","target":{"branch":"main","at":0}}`},
			"a branch":   {chat + "/messages?branch=main", `{"text":"hi"}`},
			"a context":  {chat + "/messages", `{"text":"hi","context":"the board"}`},
			"references": {chat + "/messages", `{"text":"hi","references":[{"quote":"q"}]}`},
		} {
			if status, out := f.call(p, "POST", c[0], c[1]); status != http.StatusBadRequest || !strings.Contains(out, "text alone") {
				t.Errorf("a first message with %s: %d %s", what, status, out)
			}
		}
	})

	// The server refuses the start: the page gets its status, sentence and code, and the chat
	// is still this server's, unstarted.
	left := viewThere(newID)
	left.Locked = false
	f.answer("POST /api/chats", http.StatusConflict, map[string]any{"started": false, "sent": false, "chat": left,
		"error": "the folder is missing: /home/standin/work", "code": "folder_missing"})
	if text := f.refuses(p, http.StatusConflict, "folder_missing", "POST", chat+"/messages", `{"text":"hello"}`); text != "the folder is missing: /home/standin/work" {
		t.Fatalf("a refused start: %q", text)
	}
	if meta, there := f.a.Chats.RemoteUnstarted(newID); !there || meta.RemoteStart != model.RemoteLeft || f.rm.Has(newID) {
		t.Fatalf("after a refused start: %+v, unstarted %v", meta, there)
	}
	var sent map[string]any
	json.Unmarshal([]byte(f.last("POST /api/chats").Body), &sent)
	if sent["id"] != newID || sent["agent"] != "claude" || sent["cwd"] != "/home/standin/work" || sent["text"] != "hello" {
		t.Fatalf("the creation call: %v", sent)
	}

	// The start: the chat is a record, the pages are told in order, and the reader reloads.
	started := viewThere(newID)
	started.Name, started.Status = "New chat", model.StatusThinking
	f.mu.Lock()
	f.views[newID] = started
	f.mu.Unlock()
	f.answer("POST /api/chats", http.StatusOK, map[string]any{"ok": true, "started": true, "sent": true, "chat": started})
	f.events(p, q)
	if got := f.good(p, "POST", chat+"/messages", `{"text":"hello"}`); !reflect.DeepEqual(got, map[string]any{"ok": true, "branch": "main"}) {
		t.Fatalf("the first message: %v", got)
	}
	if !f.rm.Has(newID) {
		t.Fatal("the started chat has no record")
	}
	if _, err := f.a.Chats.View(newID); !errors.Is(err, chats.ErrNotFound) {
		t.Fatalf("the chat manager still has the chat: %v", err)
	}
	evs := f.events(p, q)
	mine := only(evs[0], "branch_state", "chat", "chat_reload", "chat_removed")
	if len(mine) < 3 || typeOf(mine[0]) != "branch_state" || typeOf(mine[1]) != "chat" || typeOf(mine[len(mine)-1]) != "chat_reload" ||
		!strings.Contains(mine[1], `"server":"`+f.entry+`"`) || !strings.Contains(mine[1], `"locked":true`) || count(mine, "chat_removed") != 0 {
		t.Fatalf("the reader after the start: %v", mine)
	}
	if count(evs[1], "chat_reload") != 0 || count(evs[1], "chat", newID, `"locked":true`) == 0 || count(evs[1], "chat_removed") != 0 {
		t.Fatalf("the other page after the start: %v", evs[1])
	}
	now, ok := f.chatNow(q, newID)
	if !ok || now.Server != f.entry || now.Group != g || !now.Locked || now.Status != model.StatusThinking {
		t.Fatalf("the record in the snapshot: %+v, listed %v", now, ok)
	}

	// The id stays taken.
	if status, out := f.call(p, "POST", "/api/chats", form("id", newID, "group", g)); status != http.StatusConflict {
		t.Fatalf("a new chat with the record's id: %d %s", status, out)
	}

	// AC30: server and agent are fixed, for the record, a branch of it and a fork of it.
	fork := viewThere(forkID)
	fork.ForkedFrom = newID
	f.mu.Lock()
	f.views[forkID] = fork
	f.mu.Unlock()
	f.answer("POST /api/chats/{id}/fork", http.StatusOK, fork)
	if got := f.good(p, "POST", chat+"/fork", `{"branch":"main","at":1}`); got["id"] != forkID {
		t.Fatalf("the fork: %v", got)
	}
	f.untouched("a change of server or agent", func() {
		for _, path := range []string{chat, chat + "?branch=b1", "/api/chats/" + forkID} {
			for _, body := range []string{`{"server":"local"}`, `{"server":"` + f.entry + `"}`, `{"agent":"pi"}`, `{"agent":"claude","model":"m"}`} {
				if status, out := f.call(p, "PATCH", path, body); status != http.StatusConflict || !strings.Contains(out, chats.ErrAgentFixed.Error()) {
					t.Errorf("PATCH %s %s: %d %s", path, body, status, out)
				}
			}
		}
	})

	// An archived chat that has not started is not sent anywhere.
	other := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", form("group", g, "server", f.entry)))
	f.good(p, "POST", "/api/chats/"+other.ID+"/archive", "")
	f.untouched("an archived chat", func() {
		if status, out := f.call(p, "POST", "/api/chats/"+other.ID+"/messages", `{"text":"hi"}`); status != http.StatusConflict || !strings.Contains(out, "archived") {
			t.Errorf("a first message of an archived chat: %d %s", status, out)
		}
	})
}

// TestFirstMessageWhoseTextWasNotSent: the chat's server answers that the chat had started
// before, with the text of an earlier call that got no answer. The page sent another text: it
// gets the relay's 409 with its code and sentence, and so keeps the text; the chat is a record.
func TestFirstMessageWhoseTextWasNotSent(t *testing.T) {
	f := newFar(t, farOpt{limits: remotes.Limits{Start: 200 * time.Millisecond, Settle: 200 * time.Millisecond}})
	p := f.page("P")
	g := f.group(p, "Work", "")
	chat := "/api/chats/" + newID
	mustOK(t, f, p, "POST", "/api/chats", form("id", newID, "group", g, "server", f.entry))

	// The first text: no answer to the call, and none to the read that would settle it.
	f.hang("POST /api/chats")
	f.hang("GET /api/chats/{id}")
	f.refuses(p, http.StatusGatewayTimeout, "start_unconfirmed", "POST", chat+"/messages", `{"text":"hello"}`)
	if meta, there := f.a.Chats.RemoteUnstarted(newID); !there || meta.RemoteStart != model.RemoteUnconfirmed {
		t.Fatalf("after a first message with no answer: %+v, unstarted %v", meta, there)
	}

	// It had arrived. The same call with another text sends nothing there.
	started := viewThere(newID)
	f.mu.Lock()
	f.views[newID] = started
	f.mu.Unlock()
	f.handle("GET /api/chats/{id}", nil)
	f.answer("POST /api/chats", http.StatusOK, map[string]any{"ok": true, "started": true, "sent": false, "chat": started})
	status, out := f.call(p, "POST", chat+"/messages", `{"text":"hello, and more"}`)
	want := map[string]string{"code": "first_text_kept", "error": "The first message had already arrived on Studio; this text was not sent."}
	if status != http.StatusConflict || !reflect.DeepEqual(decode[map[string]string](t, out), want) {
		t.Fatalf("the first message with another text: %d %s", status, out)
	}
	if !f.rm.Has(newID) {
		t.Fatal("the started chat has no record")
	}
	if now, ok := f.chatNow(p, newID); !ok || now.Server != f.entry || now.Group != g || !now.Locked {
		t.Fatalf("the record in the snapshot: %+v, listed %v", now, ok)
	}
}

// mustOK is a call that must answer 200; it returns the answer as it came.
func mustOK(t *testing.T, f *far, p *bridgetest.Page, method, path, body string) string {
	t.Helper()
	status, out := f.call(p, method, path, body)
	if status != http.StatusOK {
		t.Fatalf("%s %s: %d %s", method, path, status, out)
	}
	return out
}

// The folders and the plan usage of another server are asked there, and those of this one are
// not (AC18).
func TestDirsAndUsageOfAServer(t *testing.T) {
	f := newFar(t, farOpt{})
	p := f.page("P")
	here := t.TempDir()

	dirs := map[string]any{"path": "/home/standin/work", "parent": "/home/standin", "dirs": []any{"a", "b"}, "git": true}
	f.answer("GET /api/dirs", http.StatusOK, dirs)
	if got := f.good(p, "GET", "/api/dirs?path="+url.QueryEscape("~/work")+"&server="+f.entry, ""); !reflect.DeepEqual(got, dirs) {
		t.Fatalf("the folders there: %v", got)
	}
	if c := f.last("GET /api/dirs"); c.Path != "/api/dirs" || !sameQuery(c.Query, "path="+url.QueryEscape("~/work")) {
		t.Fatalf("the folders were asked with %+v", c)
	}
	use := map[string]any{"plan": "there", "windows": []any{}}
	f.answer("GET /api/usage/{agent}", http.StatusOK, use)
	if got := f.good(p, "GET", "/api/usage/pi?fresh=1&server="+f.entry, ""); !reflect.DeepEqual(got, use) {
		t.Fatalf("the plan usage there: %v", got)
	}
	if c := f.last("GET /api/usage/{agent}"); c.Path != "/api/usage/pi" || c.Query != "fresh=1" {
		t.Fatalf("the plan usage was asked with %+v", c)
	}
	// A refusal there goes to the page as it came.
	f.answer("GET /api/dirs", http.StatusBadRequest, map[string]string{"error": "/nowhere is not a directory"})
	if status, out := f.call(p, "GET", "/api/dirs?path=/nowhere&server="+f.entry, ""); status != http.StatusBadRequest || !strings.Contains(out, "/nowhere is not a directory") {
		t.Fatalf("a folder that is none there: %d %s", status, out)
	}
	f.answer("GET /api/usage/{agent}", http.StatusNotFound, map[string]string{"error": "usage not available"})
	if status, out := f.call(p, "GET", "/api/usage/cursor?server="+f.entry, ""); status != http.StatusNotFound || !strings.Contains(out, "usage not available") {
		t.Fatalf("an agent without usage there: %d %s", status, out)
	}
	if n := f.usage[model.Claude].Load(); n != 0 {
		t.Fatalf("this server's usage was read %d times for another server", n)
	}

	// "local" and no server are this machine: the stand-in is not asked.
	f.untouched("this computer's folders and usage", func() {
		for _, q := range []string{"", "&server=local"} {
			got := f.good(p, "GET", "/api/dirs?path="+url.QueryEscape(here)+q, "")
			if want, _ := filepath.EvalSymlinks(here); got["path"] != here && got["path"] != want {
				t.Errorf("the folders here with %q: %v", q, got)
			}
			f.good(p, "GET", "/api/usage/claude?fresh=1"+q, "")
		}
		if n := f.usage[model.Claude].Load(); n != 2 {
			t.Errorf("this server's usage was read %d times, want 2", n)
		}
		// An entry that is not in the list.
		for _, path := range []string{"/api/dirs?server=" + noSuchServer, "/api/usage/claude?server=" + noSuchServer} {
			if status, out := f.call(p, "GET", path, ""); status != http.StatusNotFound || !strings.Contains(out, "no such server") {
				t.Errorf("%s: %d %s", path, status, out)
			}
		}
	})

	// A server without a relay knows no entry but its own.
	e := newEnv(t)
	for _, path := range []string{"/api/dirs?server=" + noSuchServer, "/api/usage/claude?server=" + noSuchServer} {
		if status, out := e.do("GET", path, ""); status != http.StatusNotFound || !strings.Contains(out, "no such server") {
			t.Errorf("without a relay, %s: %d %s", path, status, out)
		}
	}
	if status, out := e.do("GET", "/api/dirs?server=local&path="+url.QueryEscape(here), ""); status != http.StatusOK {
		t.Errorf("without a relay, this computer's folders: %d %s", status, out)
	}
}

// The snapshot, as GET /api/state and as a stream's second event: the lists of the entry, the
// records among the chats and their states among the states.
func TestSnapshotHasRecordsAndLists(t *testing.T) {
	f := newFar(t, farOpt{chats: []model.ChatView{viewThere(recA)}})
	p := f.page("P")
	own := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", `{"group":"`+model.Ungrouped+`","server":"local"}`))

	check := func(what, raw string) {
		t.Helper()
		var snap struct {
			Lists  map[string]remotes.ServerLists `json:"lists"`
			Chats  []model.ChatView               `json:"chats"`
			States []model.BranchState            `json:"states"`
		}
		if err := json.Unmarshal([]byte(raw), &snap); err != nil {
			t.Fatalf("%s: %v", what, err)
		}
		l, ok := snap.Lists[f.entry]
		if len(snap.Lists) != 1 || !ok || !slices.Equal(l.Agents, []model.AgentKind{model.Claude, model.Pi}) || l.Home != "/home/standin" ||
			l.DefaultCwd != "/home/standin/work" || l.Catalogs[model.Claude] == nil || l.Catalogs[model.Claude].Models[0].ID != "standin-model" {
			t.Fatalf("%s: lists %+v", what, snap.Lists)
		}
		byID := map[string]model.ChatView{}
		for _, c := range snap.Chats {
			byID[c.ID] = c
		}
		rec := byID[recA]
		if len(snap.Chats) != 2 || rec.Server != f.entry || rec.Group != model.Ungrouped || rec.Name != "Chat 2a" || !rec.Locked ||
			byID[own.ID].Server != "" || byID[own.ID].ID != own.ID {
			t.Fatalf("%s: chats %+v", what, snap.Chats)
		}
		states := map[string]int{}
		for _, st := range snap.States {
			states[st.Chat+"/"+st.Branch]++
		}
		if !reflect.DeepEqual(states, map[string]int{recA + "/main": 1, own.ID + "/main": 1}) {
			t.Fatalf("%s: states %v", what, states)
		}
	}
	check("GET /api/state", mustOK(t, f, p, "GET", "/api/state", ""))
	raw, _ := json.Marshal(bridgetest.Connect(t, f.url, "Q").Welcome())
	check("the stream's snapshot", string(raw))

	// Without a relay the lists are there and empty.
	keys := decode[map[string]json.RawMessage](t, newEnv(t).expect(200, "GET", "/api/state", ""))
	if string(keys["lists"]) != "{}" {
		t.Fatalf("lists without a relay: %s", keys["lists"])
	}
}

// On the remote listener a record is no chat: this server passes nothing on for its own API
// clients, lists no record for them, and asks no other server for folders or usage.
func TestRemoteListenerPassesNothingOn(t *testing.T) {
	l := newListener(t)
	f := newFar(t, farOpt{chats: []model.ChatView{viewThere(recA)}, with: []func(*Server){l.set, func(s *Server) { s.App.Home = "/home/owner" }}})
	l.serve(f.s)
	p := f.page("P")
	f.good(p, "GET", "/api/chats/"+recA+"/items", "") // the record answers a page
	here := t.TempDir()
	waiting := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", form("group", model.Ungrouped, "server", f.entry)))

	f.untouched("an API client", func() {
		bodies := map[string]string{
			"POST /api/chats/{id}/messages":   `{"text":"hi"}`,
			"POST /api/chats/{id}/permission": `{"requestId":"r","allow":true}`,
			"PUT /api/chats/{id}/label":       `{"branch":"main","item":1,"text":"x"}`,
			"PUT /api/chats/{id}/draft":       `{"text":"x"}`,
			"PATCH /api/chats/{id}":           `{"name":"theirs"}`,
			"POST /api/chats/{id}/fork":       `{"branch":"main","at":1}`,
		}
		for _, pat := range f.s.recordRoutes().patterns {
			method, path, _ := strings.Cut(pat, " ")
			path = strings.NewReplacer("{id}", recA, "{sid}", "sub-1").Replace(path)
			status, out := l.call(apiX, testSecret, method, path, bodies[pat])
			if strings.Contains(out, "Chat 2a") || strings.Contains(out, f.entry) || strings.Contains(out, "hello there") {
				t.Errorf("%s on the remote listener tells of the record: %s", pat, out)
			}
			if pat == "POST /api/chats/{id}/unfollow" { // ends a follow of any id, as for every chat that is not there
				continue
			}
			if status != http.StatusNotFound {
				t.Errorf("%s on the remote listener: %d %s, want 404", pat, status, out)
			}
		}
		// The API client's snapshot has no record and no lists of other servers.
		status, out := l.call(apiX, testSecret, "GET", "/api/state", "")
		if status != http.StatusOK || strings.Contains(out, recA) || strings.Contains(out, `"lists"`) || strings.Contains(out, "standin") {
			t.Errorf("the API client's snapshot: %d %s", status, out)
		}
		// "server" is ignored: the folders and the usage are this machine's.
		status, out = l.call(apiX, testSecret, "GET", "/api/dirs?path="+url.QueryEscape(here)+"&server="+f.entry, "")
		if status != http.StatusOK || !strings.Contains(out, filepath.Base(here)) {
			t.Errorf("the folders for an API client: %d %s", status, out)
		}
		if status, out = l.call(apiX, testSecret, "GET", "/api/usage/claude?server="+f.entry, ""); status != http.StatusOK || f.usage[model.Claude].Load() != 1 {
			t.Errorf("the usage for an API client: %d %s", status, out)
		}
		// The first message of a page's chat that waits for another server is not sent there
		// for an API client either: the chat manager refuses it.
		status, out = l.call(apiX, testSecret, "POST", "/api/chats/"+waiting.ID+"/messages", `{"text":"hi"}`)
		if status != http.StatusConflict || !strings.Contains(out, "remote_start") {
			t.Errorf("an API client's message to a chat that starts elsewhere: %d %s", status, out)
		}
		// A chat on another server is made by a page alone.
		if status, out = l.call(apiX, testSecret, "PATCH", "/api/chats/"+recA, `{"server":"`+f.entry+`"}`); status != http.StatusBadRequest || !strings.Contains(out, "server_refused") {
			t.Errorf("an API client names a server: %d %s", status, out)
		}
	})
	if cv, ok := f.chatNow(p, recA); !ok || cv.Name != "Chat 2a" || cv.Archived {
		t.Fatalf("the record after the API client's calls: %+v, listed %v", cv, ok)
	}
}

// The archive, the unarchive and the delete of a group through the routes, with records in it:
// the records go with the group, an unarchive of one record brings its groups back, and a
// delete with one server away deletes nothing (AC33).
func TestGroupRoutesWithRecords(t *testing.T) {
	f := newFar(t, farOpt{chats: []model.ChatView{viewThere(recA), viewThere(recB)}})
	p := f.page("P")
	g := f.group(p, "Work", "")
	sub := f.group(p, "Deep", g)
	f.good(p, "PATCH", "/api/chats/"+recA, form("group", g))
	f.good(p, "PATCH", "/api/chats/"+recB, form("group", sub))
	own := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", form("group", g, "server", "local")))
	archived := func(id string) bool {
		t.Helper()
		var snap struct{ Groups []model.Group }
		json.Unmarshal([]byte(mustOK(t, f, p, "GET", "/api/state", "")), &snap)
		for _, x := range snap.Groups {
			if x.ID == id {
				return x.Archived
			}
		}
		t.Fatalf("no group %s", id)
		return false
	}

	f.good(p, "POST", "/api/groups/"+g+"/archive", "")
	a, _ := f.chatNow(p, recA)
	b, _ := f.chatNow(p, recB)
	o, _ := f.chatNow(p, own.ID)
	if !a.Archived || !b.Archived || !o.Archived || a.Op == "" || a.Op != b.Op || a.Op != o.Op || !archived(g) || !archived(sub) {
		t.Fatalf("after the group's archive: %+v, %+v, %+v", a, b, o)
	}
	if n := len(f.sent("POST /api/chats/{id}/archive")); n != 2 {
		t.Fatalf("the stand-in got %d archive calls, want 2", n)
	}
	// One record comes back: with it the groups it is nested in, and nothing else in them.
	f.good(p, "POST", "/api/chats/"+recB+"/unarchive", "")
	a, _ = f.chatNow(p, recA)
	b, _ = f.chatNow(p, recB)
	if b.Archived || !a.Archived || archived(g) || archived(sub) {
		t.Fatalf("after the unarchive of one record: %+v, %+v, groups %v %v", a, b, archived(g), archived(sub))
	}
	f.good(p, "POST", "/api/chats/"+recA+"/unarchive", "")
	f.good(p, "POST", "/api/chats/"+own.ID+"/unarchive", "")

	// One server is away: nothing is deleted, here or there.
	f.down()
	f.untouched("a delete with a server away", func() {
		text := f.refuses(p, http.StatusConflict, "server_unreachable", "DELETE", "/api/groups/"+g+"?contents=delete", "")
		if text != "Nothing was deleted: “Chat 2a” is on Studio, which is not connected." && text != "Nothing was deleted: “Chat 2b” is on Studio, which is not connected." {
			t.Errorf("the refusal: %q", text)
		}
	})
	_, hasA := f.chatNow(p, recA)
	_, hasB := f.chatNow(p, recB)
	_, hasOwn := f.chatNow(p, own.ID)
	if !hasA || !hasB || !hasOwn || archived(g) || archived(sub) {
		t.Fatalf("after the refused delete: records %v %v, the chat %v", hasA, hasB, hasOwn)
	}

	// Back: the delete deletes the chats there, then everything here.
	f.st.Restart()
	f.returned(2)
	f.good(p, "DELETE", "/api/groups/"+g+"?contents=delete", "")
	if n := len(f.sent("DELETE /api/chats/{id}")); n != 2 {
		t.Fatalf("the stand-in got %d delete calls, want 2", n)
	}
	_, hasA = f.chatNow(p, recA)
	_, hasB = f.chatNow(p, recB)
	_, hasOwn = f.chatNow(p, own.ID)
	if hasA || hasB || hasOwn || f.rm.Has(recA) || f.rm.Has(recB) {
		t.Fatalf("after the delete: records %v %v, the chat %v", hasA, hasB, hasOwn)
	}
}

// The errors of a chat's server choice have their statuses and codes, in the table and through
// the routes.
func TestServerChoiceErrors(t *testing.T) {
	for _, c := range []struct {
		err    error
		status int
		code   string
	}{
		{chats.ErrServerUnknown, http.StatusBadRequest, ""},
		{chats.ErrBoardLocal, http.StatusConflict, "board_local"},
		{chats.ErrServerFixed, http.StatusConflict, "server_fixed"},
		{chats.ErrServerUnusable, http.StatusConflict, "server_unusable"},
		{chats.ErrServerUnreachable, http.StatusServiceUnavailable, "server_unreachable"},
		{chats.ErrStartUnconfirmed, http.StatusConflict, "start_unconfirmed"},
		{chats.ErrRemoteStart, http.StatusConflict, "remote_start"},
	} {
		for _, err := range []error{c.err, fmt.Errorf("configure: %w", c.err)} {
			// The fallback is never what decides.
			for _, fallback := range []int{http.StatusBadRequest, http.StatusInternalServerError} {
				if got := statusOf(err, fallback); got != c.status || codeOf(err) != c.code {
					t.Errorf("%v: %d %q, want %d %q", err, got, codeOf(err), c.status, c.code)
				}
			}
		}
	}
	// The errors that were there keep theirs.
	if statusOf(fmt.Errorf("%w: /x", agent.ErrFolderMissing), 500) != http.StatusConflict || codeOf(usable.ErrNone) != "no_agent" || codeOf(chats.ErrAgentFixed) != "" {
		t.Error("an error that was there before has another status or code")
	}

	f := newFar(t, farOpt{})
	p := f.page("P")
	g := f.group(p, "Work", "")
	bd := decode[model.Board](t, mustOK(t, f, p, "POST", "/api/boards", form("name", "b", "group", g)))
	f.untouched("a refused server choice", func() {
		f.refuses(p, http.StatusConflict, "board_local", "POST", "/api/chats", form("board", bd.ID, "server", f.entry))
		f.refuses(p, http.StatusBadRequest, "", "POST", "/api/chats", form("group", g, "server", noSuchServer))
		onBoard := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", form("board", bd.ID)))
		f.refuses(p, http.StatusConflict, "board_local", "PATCH", "/api/chats/"+onBoard.ID, form("server", f.entry))
		own := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", form("group", g, "server", "local")))
		if text := f.refuses(p, http.StatusBadRequest, "", "PATCH", "/api/chats/"+own.ID, form("server", noSuchServer)); text != "no such server" {
			t.Errorf("a server that is not in the list: %q", text)
		}
		// The choice itself: this computer, then the entry, with that server's agent and folder.
		got := f.good(p, "PATCH", "/api/chats/"+own.ID, form("server", f.entry))
		if field(got, "chat", "server") != f.entry || field(got, "chat", "cwd") != "/home/standin/work" {
			t.Errorf("a chat put on the entry: %v", got)
		}
		// Nothing of a chat that has not started is here to fork.
		f.refuses(p, http.StatusConflict, "remote_start", "POST", "/api/chats/"+own.ID+"/fork", `{"branch":"main","at":0}`)
	})
	// A folder is checked on the chat's server; while that is away the change waits.
	there := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", form("group", g, "server", f.entry)))
	f.answer("GET /api/dirs", http.StatusOK, map[string]any{"path": "/srv/code", "parent": "/srv", "dirs": []any{}, "git": false})
	if got := f.good(p, "PATCH", "/api/chats/"+there.ID, `{"cwd":"/srv/code"}`); field(got, "chat", "cwd") != "/srv/code" {
		t.Fatalf("a folder of the entry: %v", got)
	}
	f.down()
	f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", "PATCH", "/api/chats/"+there.ID, `{"cwd":"/srv/other"}`)
	if text := f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", "POST", "/api/chats/"+there.ID+"/messages", `{"text":"hi"}`); text != "Studio is not connected." {
		t.Fatalf("a first message while the server is away: %q", text)
	}
}

// field walks the keys of nested JSON objects.
func field(v any, keys ...string) any {
	for _, k := range keys {
		m, _ := v.(map[string]any)
		v = m[k]
	}
	return v
}
