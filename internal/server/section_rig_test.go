package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
)

// The rig of the tests of a section, through the real handler: a stand-in (loopback, TLS) is
// the other server, a server of level 5, reached through a real servers.Manager and a real
// relay, and the pages are stand-in pages on the real bridge.

// The ids of what the stand-in has.
const (
	farChatA  = "2a000000-0000-4000-8000-00000000000a"
	farChatB  = "2b000000-0000-4000-8000-00000000000b"
	farNewID  = "2c000000-0000-4000-8000-00000000000c"
	farRunA   = "r_aaaa0001"
	farRunB   = "r_bbbb0002"
	farBoardA = "b_aaaa0001"
	farBoardB = "b_bbbb0002"
	farGroup  = "g_there"
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

// groupThere is a group as the stand-in has it.
func groupThere(id, name string) model.Group { return model.Group{ID: id, Name: name} }

// viewThere is a chat's view as its server sends it: started, in that server's group.
func viewThere(id string) model.ChatView {
	return model.ChatView{
		ID: id, Agent: model.Claude, Name: "Chat " + id[:2], Group: farGroup, Cwd: "/home/standin/work",
		Model: "standin-model", Locked: true, Status: model.StatusReady,
		Created: time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC),
	}
}

// runThere is a run's view as its server sends it: started, in that server's group.
func runThere(id string) model.RunView {
	return model.RunView{
		ID: id, Name: "Run " + id[2:4], Group: farGroup, Agent: model.Claude, Cwd: "/home/standin/work", Git: true,
		Tiers:   model.RunTiers{Deep: model.ModelChoice{Model: "standin-model"}},
		Created: time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC), Started: time.Date(2026, 10, 6, 9, 1, 0, 0, time.UTC),
		Status: model.RunRunning, Turns: 1,
	}
}

// boardThere is a board as the stand-in has it, in that server's group.
func boardThere(id string) model.Board {
	return model.Board{ID: id, Name: "Board " + id[2:4], Group: farGroup, Created: time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)}
}

// thereDraft is a draft of the stand-in, with its counter.
type thereDraft struct {
	Rev   int64
	Draft *model.Draft
}

// thereCall is one call the stand-in got on a route of the script.
type thereCall struct {
	Pattern string // the route as the script names it; "" for a path that is no route of it
	Method  string
	Path    string // as it came, escaped
	Query   string
	Body    string
	Type    string // the Content-Type it came with
}

// thereTree is what the stand-in has: the tree of its snapshot.
type thereTree struct {
	groups []model.Group
	chats  []model.ChatView
	runs   []model.RunView
	boards []model.Board
}

// farOpt says how a far differs from the usual one.
type farOpt struct {
	groups []model.Group    // the groups the stand-in has; nil = the one group of the views
	chats  []model.ChatView // the chats the stand-in has
	runs   []model.RunView  // the runs the stand-in has
	boards []model.Board    // the boards the stand-in has
	local  bool             // this server has a run service
	limits remotes.Limits   // zero fields: the defaults
	with   []func(*Server)  // set up the server before the relay is made
	tooOld time.Duration    // servers.Timing.TooOld; 0 = the five minutes, which no test sits out
}

// far is a server wired as the program wires it, with one entry "Studio" in its list: the
// stand-in.
type far struct {
	*env
	st    *standin.Server
	m     *servers.Manager
	rm    *remotes.Relay
	entry string
	root  string        // the folder of the server list
	rs    *runs.Service // nil without runs

	trees atomic.Int64 // the section events with a tree that every page was sent
	nulls atomic.Int64 // those with null
	marks atomic.Int64 // the calls of events

	mu      sync.Mutex
	tree    thereTree
	revs    map[string]int64                  // by board id: the revision of its drawing on the stand-in
	drafts  map[string]thereDraft             // by chat id: the draft of its first branch on the stand-in
	images  map[string][]byte                 // by image id: the images the stand-in was uploaded
	answers map[string]http.HandlerFunc       // by pattern; none = the route's usual answer
	calls   []thereCall                       // what the stand-in got on the script's routes
	seen    []string                          // every answer and event a page got
	logs    []string                          // the relay's log
	pages   map[string]*bridgetest.Page       // by id
	usage   map[model.AgentKind]*atomic.Int64 // the local usage functions' calls
}

func newFar(t *testing.T, o farOpt) *far {
	t.Helper()
	f := &far{revs: map[string]int64{}, drafts: map[string]thereDraft{}, images: map[string][]byte{}, answers: map[string]http.HandlerFunc{},
		pages: map[string]*bridgetest.Page{}, root: t.TempDir(), usage: map[model.AgentKind]*atomic.Int64{model.Claude: {}}}
	f.tree = thereTree{groups: o.groups, chats: o.chats, runs: o.runs, boards: o.boards}
	if f.tree.groups == nil {
		f.tree.groups = []model.Group{groupThere(farGroup, "There")}
	}
	f.st = standin.Start(t, standin.Options{Snapshot: f.snapshot()})
	f.script()

	wire := func(s *Server) {
		if o.local {
			f.wireRuns(t, s)
		}
		timing := farTiming()
		timing.TooOld = o.tooOld
		var listed atomic.Pointer[remotes.Relay]
		m, err := servers.Open(servers.Options{Root: f.root, LocalID: testLocalID, Version: "test", Timing: timing,
			Notify: func(ev any) {
				s.Bridge.Broadcast(ev)
				if rm := listed.Load(); rm != nil {
					rm.ServersChanged()
				}
			}})
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
		rm, err := remotes.Open(remotes.Options{
			Servers: m, Bridge: s.Bridge, Limits: o.limits,
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
		listed.Store(rm)
		s.Servers, s.App.Servers = m, m
		s.Remotes, s.App.Remotes = rm, rm
		s.Bridge.OnUnfollowed(rm.Unfollowed)
		// A board of a section: the relay is told when no page holds it any more, and the
		// revision a grant names is the last one known of the board's server.
		s.Bridge.OnBoardFree(rm.BoardFree)
		ownRev := s.Bridge.SceneRev
		s.Bridge.SceneRev = func(key string) int64 {
			if rev, ok := rm.BoardRev(key); ok {
				return rev
			}
			return ownRev(key)
		}
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
	}
	f.env = newEnv(t, append(o.with, wire)...)
	f.watch()
	// Runs before the servers stop: nothing a page got holds the secret of the entry.
	t.Cleanup(f.noSecret)
	f.m.Start()
	f.returned(1)
	return f
}

// wireRuns gives the server a run service, as the program wires it.
func (f *far) wireRuns(t *testing.T, s *Server) {
	t.Helper()
	rs := runs.New(runs.Deps{Store: s.App.St, Emit: s.Bridge, DefaultCwd: s.App.DefaultCwd, HaltWait: 300 * time.Millisecond})
	if err := rs.Load(); err != nil {
		t.Fatal(err)
	}
	rs.Chats = s.App.Chats
	s.App.Chats.Runs = rs
	s.App.Runs, s.Relay.Runs = rs, rs
	f.rs = rs
	t.Cleanup(func() { rs.Shutdown(5 * time.Second) })
}

// watch opens a stream of its own and counts the section events on it: what tells that the
// relay has taken a snapshot of the entry, or the end of its connection. The stream never calls,
// so it is no page that acted.
func (f *far) watch() {
	f.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	f.t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, "GET", f.url+"/api/events?client=rig-watch", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	go func() {
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(nil, 64<<20)
		for sc.Scan() {
			line, ok := strings.CutPrefix(sc.Text(), "data: ")
			if !ok {
				continue
			}
			var ev struct {
				Type, Server string
				Tree         json.RawMessage
			}
			if json.Unmarshal([]byte(line), &ev) != nil || ev.Type != "section" || ev.Server != f.entry {
				continue
			}
			if string(ev.Tree) == "null" || len(ev.Tree) == 0 {
				f.nulls.Add(1)
			} else {
				f.trees.Add(1)
			}
		}
	}()
}

// snapshot is the stand-in's snapshot of its tree as it is now. The caller holds f.mu, or is
// the only one that knows f.
func (f *far) snapshot() map[string]any {
	snap := standin.DefaultSnapshot()
	states := []model.BranchState{}
	for _, v := range f.tree.chats {
		states = append(states, model.StateOf(v.ID, "main", v))
	}
	list := func(v any, n int) any {
		if n == 0 {
			return []any{}
		}
		return v
	}
	snap["groups"] = list(f.tree.groups, len(f.tree.groups))
	snap["chats"], snap["states"] = list(f.tree.chats, len(f.tree.chats)), states
	snap["runs"] = list(f.tree.runs, len(f.tree.runs))
	snap["boards"] = list(f.tree.boards, len(f.tree.boards))
	return snap
}

// change changes what the stand-in has: its snapshot is the changed tree from now on. Nothing
// is sent for it: a test sends the events of the change itself, or drops the stream.
func (f *far) change(do func(t *thereTree)) {
	f.mu.Lock()
	do(&f.tree)
	snap := f.snapshot()
	f.mu.Unlock()
	f.st.SetSnapshot(snap)
}

// notThere is the stand-in's answer for a thing it does not have, as a server of level 5 says it.
func notThere(w http.ResponseWriter, what string) {
	writeErrorCode(w, http.StatusNotFound, "no such "+what, "not_found")
}

// script makes the stand-in serve the routes a relay calls: every route of a section's table as
// it is on that server, the folders, the plan usage and the answer to a tool call. Each call is
// noted, and answered by the handler set for its pattern or, without one, as a server that has
// the tree of f.tree. A call of a path that is none of these routes is noted too, and is 404.
func (f *far) script() {
	has := func(id string, in func(t *thereTree) bool) bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return in(&f.tree)
	}
	chat := func(id string) (model.ChatView, bool) {
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, v := range f.tree.chats {
			if v.ID == id {
				return v, true
			}
		}
		return model.ChatView{}, false
	}
	run := func(id string) (model.RunView, bool) {
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, v := range f.tree.runs {
			if v.ID == id {
				return v, true
			}
		}
		return model.RunView{}, false
	}
	board := func(id string) bool {
		return has(id, func(t *thereTree) bool {
			for _, b := range t.boards {
				if b.ID == id {
					return true
				}
			}
			return false
		})
	}
	// rev is the revision of the board's drawing, 3 for one that was never saved.
	rev := func(id string) int64 {
		f.mu.Lock()
		defer f.mu.Unlock()
		if _, ok := f.revs[id]; !ok {
			f.revs[id] = 3
		}
		return f.revs[id]
	}
	usual := map[string]http.HandlerFunc{
		"GET /api/chats/{id}": func(w http.ResponseWriter, r *http.Request) {
			v, ok := chat(r.PathValue("id"))
			if !ok {
				notThere(w, "chat")
				return
			}
			writeJSON(w, v)
		},
		"GET /api/chats/{id}/items": func(w http.ResponseWriter, r *http.Request) {
			id := r.PathValue("id")
			if _, ok := chat(id); !ok {
				notThere(w, "chat")
				return
			}
			writeJSON(w, map[string]any{"branch": "main", "version": 3, "items": []any{map[string]any{"kind": "user", "text": "hello there"}},
				"subagents": []any{}, "state": map[string]any{"chat": id, "branch": "main", "status": "ready"}})
		},
		"GET /api/chats/{id}/tree": func(w http.ResponseWriter, r *http.Request) {
			if _, ok := chat(r.PathValue("id")); !ok {
				notThere(w, "chat")
				return
			}
			writeJSON(w, map[string]any{"chat": r.PathValue("id"), "version": 3, "branches": []any{}})
		},
		// A new chat: unstarted, with the id the body names or one of the stand-in's making.
		"POST /api/chats": func(w http.ResponseWriter, r *http.Request) {
			var body struct {
				ID    string
				Agent model.AgentKind
				Group string
				Board string
				Run   string
			}
			json.NewDecoder(r.Body).Decode(&body)
			if body.ID == "" {
				body.ID = farNewID
			}
			v := viewThere(body.ID)
			v.Locked, v.Name, v.Group, v.Board, v.Run = false, "", body.Group, body.Board, body.Run
			writeJSON(w, v)
		},
		// The draft of the first branch, with its counter: a save on the counter it was typed on.
		"PUT /api/chats/{id}/draft": func(w http.ResponseWriter, r *http.Request) {
			var d model.Draft
			json.NewDecoder(r.Body).Decode(&d)
			var next *model.Draft
			if d.Text != "" || len(d.References) > 0 || len(d.Images) > 0 {
				next = &d
			}
			id := r.PathValue("id")
			base, err := strconv.ParseInt(r.URL.Query().Get("rev"), 10, 64)
			f.mu.Lock()
			defer f.mu.Unlock()
			was := f.drafts[id]
			if err != nil || base != was.Rev {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusConflict)
				json.NewEncoder(w).Encode(map[string]any{"error": "the draft was changed elsewhere", "code": "stale", "rev": was.Rev, "draft": was.Draft})
				return
			}
			f.drafts[id] = thereDraft{was.Rev + 1, next}
			writeJSON(w, map[string]any{"ok": true, "rev": was.Rev + 1})
		},
		// The images: an upload is kept by the hash of its bytes and answered as an image of the
		// type the upload states, and a fetch gives the bytes back, as a PNG.
		imagePatterns[0]: func(w http.ResponseWriter, r *http.Request) {
			data, _ := io.ReadAll(r.Body)
			img := model.Image{ID: imageIDOf(data), Name: r.URL.Query().Get("name"), Type: r.Header.Get("Content-Type"), Size: int64(len(data))}
			f.mu.Lock()
			f.images[img.ID] = data
			f.mu.Unlock()
			writeJSON(w, img)
		},
		imagePatterns[1]: func(w http.ResponseWriter, r *http.Request) {
			f.mu.Lock()
			data, ok := f.images[r.PathValue("image")]
			f.mu.Unlock()
			if !ok {
				writeError(w, http.StatusNotFound, chats.ErrNoImage.Error())
				return
			}
			w.Header().Set("Content-Type", "image/png")
			w.Write(data)
		},
		"GET /api/runs/{id}": func(w http.ResponseWriter, r *http.Request) {
			v, ok := run(r.PathValue("id"))
			if !ok {
				notThere(w, "run")
				return
			}
			writeJSON(w, v)
		},
		"GET /api/runs/{id}/detail": func(w http.ResponseWriter, r *http.Request) {
			if _, ok := run(r.PathValue("id")); !ok {
				notThere(w, "run")
				return
			}
			writeJSON(w, map[string]any{"run": r.PathValue("id"), "version": 4, "agents": map[string]any{}})
		},
		// A server that makes the board of a creation call, grants a take and stores a drawing
		// at the revision it is based on.
		"POST /api/boards": func(w http.ResponseWriter, r *http.Request) {
			var body struct{ Name, Group string }
			json.NewDecoder(r.Body).Decode(&body)
			bd := boardThere(farBoardB)
			bd.Name, bd.Group = body.Name, body.Group
			f.mu.Lock()
			f.tree.boards = append(f.tree.boards, bd)
			f.mu.Unlock()
			writeJSON(w, bd)
		},
		"POST /api/boards/{id}/take": func(w http.ResponseWriter, r *http.Request) {
			if !board(r.PathValue("id")) {
				notThere(w, "board")
				return
			}
			writeJSON(w, map[string]any{"state": "held", "rev": rev(r.PathValue("id"))})
		},
		"POST /api/boards/{id}/release": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, map[string]any{"state": "free"})
		},
		"GET /api/boards/{id}/scene": func(w http.ResponseWriter, r *http.Request) {
			if !board(r.PathValue("id")) {
				notThere(w, "board")
				return
			}
			w.Header().Set(SceneRevHeader, strconv.FormatInt(rev(r.PathValue("id")), 10))
			writeJSON(w, map[string]any{"elements": []any{}})
		},
		"PUT /api/boards/{id}/scene": func(w http.ResponseWriter, r *http.Request) {
			id := r.PathValue("id")
			if !board(id) {
				notThere(w, "board")
				return
			}
			now := rev(id)
			if base, err := strconv.ParseInt(r.URL.Query().Get("rev"), 10, 64); err != nil || base != now {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusConflict)
				json.NewEncoder(w).Encode(map[string]any{"error": "the drawing was changed elsewhere", "code": "stale", "rev": now})
				return
			}
			f.mu.Lock()
			f.revs[id] = now + 1
			f.mu.Unlock()
			writeJSON(w, map[string]any{"ok": true, "rev": now + 1})
		},
	}
	noted := func(pat string, answer http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewReader(body)) // the answer may read it too
			f.mu.Lock()
			f.calls = append(f.calls, thereCall{pat, r.Method, r.URL.EscapedPath(), r.URL.RawQuery, string(body), r.Header.Get("Content-Type")})
			h := f.answers[pat]
			f.mu.Unlock()
			switch {
			case h != nil:
				h(w, r)
			case answer != nil:
				answer(w, r)
			default:
				ok(w)
			}
		}
	}
	for _, pat := range thereRoutes() {
		f.st.Handle(pat, noted(pat, usual[pat]))
	}
	// Everything else under the paths of a tree, and what a client must never be sent.
	for _, under := range []string{"/api/groups", "/api/chats", "/api/runs", "/api/boards", "/api/on", "/api/servers", "/api/restart"} {
		none := noted("", func(w http.ResponseWriter, r *http.Request) { writeError(w, http.StatusNotFound, "not found") })
		f.st.Handle(under, none)
		f.st.Handle(under+"/", none)
	}
}

// thereRoutes are the routes of the script, as the stand-in serves them: every route of a
// section's table without the entry in its path, and the three that are not under the prefix.
func thereRoutes() []string {
	pats := []string{"GET /api/dirs", "GET /api/usage/{agent}", "POST /api/rpc-reply"}
	for _, p := range (&Server{}).sectionRoutes().patterns {
		pats = append(pats, strings.Replace(p, sectionPrefix+"{server}", "/api", 1))
	}
	return pats
}

// on is the path of a section's route for the rig's entry: rest is the path of the same call for
// a thing of this server, after /api.
func (f *far) on(rest string) string { return sectionPrefix + f.entry + rest }

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

// hang makes the stand-in keep the route's calls without an answer until the caller gives up
// or the test ends.
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

// sent are the calls the stand-in got on the route; pat "" is every call of the script.
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

// untouched runs do and fails when the stand-in got a call of the script meanwhile.
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
	for end := time.Now().Add(waitLimit); !good(); time.Sleep(2 * time.Millisecond) {
		if time.Now().After(end) {
			f.t.Fatalf("waited in vain: %s", what)
		}
	}
}

// returned waits until the pages were sent the n-th tree of the entry: the relay holds it.
func (f *far) returned(n int64) {
	f.t.Helper()
	f.wait(fmt.Sprintf("tree %d of the entry is held", n), func() bool { return f.trees.Load() >= n })
}

// state is the state of the rig's entry.
func (f *far) state() servers.State {
	v, _ := f.m.View(f.entry)
	return v.State
}

// down stops the stand-in and waits until the relay holds no tree of the entry any more.
func (f *far) down() {
	f.t.Helper()
	gone := f.nulls.Load() + 1
	f.st.Stop()
	f.wait("the entry's tree is gone", func() bool { return f.nulls.Load() >= gone && f.state() != servers.StateConnected })
}

// up starts the stand-in again and waits until the pages were sent the n-th tree.
func (f *far) up(n int64) {
	f.t.Helper()
	f.st.Restart()
	f.returned(n)
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
	return decode[map[string]any](f.t, mustOK(f.t, f, p, method, path, body))
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

// events returns, for each of the pages, the events it was sent and has not read yet, the
// lists of the entry apart. The stand-in sends a model list with a name of this call's own,
// which the relay turns into server_lists for every page: what the relay made of everything the
// stand-in sent before is in front of that event, and so is what this server sent by itself
// before the call. Every page of the rig is read up to that event, the ones that are not asked
// for too, so that none keeps it for a later call. The entry must be connected.
func (f *far) events(pages ...*bridgetest.Page) [][]string {
	f.t.Helper()
	f.mu.Lock()
	all := make([]*bridgetest.Page, 0, len(f.pages))
	for _, p := range f.pages {
		all = append(all, p)
	}
	f.mu.Unlock()
	mark := fmt.Sprintf("mark-%d", f.marks.Add(1))
	f.st.Send(map[string]any{"type": "catalog", "agent": model.Pi,
		"catalog": model.Catalog{Models: []model.CatalogModel{{ID: mark, Label: mark}}, Default: model.ModelChoice{Model: mark}}})
	got := map[*bridgetest.Page][]string{}
	for _, p := range all {
		for {
			raw := p.NextRaw()
			f.mu.Lock()
			f.seen = append(f.seen, "event to "+p.ID+": "+raw)
			f.mu.Unlock()
			if typeOf(raw) != "server_lists" {
				got[p] = append(got[p], raw)
			} else if strings.Contains(raw, mark) {
				break
			}
		}
	}
	out := make([][]string, len(pages))
	for i, p := range pages {
		out[i] = got[p]
	}
	return out
}

// through reads the page's events up to the first one of the type, and returns them, that one
// last: what the page got of something that ends with such an event, however long it takes.
func (f *far) through(p *bridgetest.Page, typ string) []string {
	f.t.Helper()
	return f.throughIf(p, func(raw string) bool { return typeOf(raw) == typ })
}

// throughIf is through for the first event that is last.
func (f *far) throughIf(p *bridgetest.Page, last func(raw string) bool) []string {
	f.t.Helper()
	var got []string
	for {
		raw := p.NextRaw()
		f.mu.Lock()
		f.seen = append(f.seen, "event to "+p.ID+": "+raw)
		f.mu.Unlock()
		got = append(got, raw)
		if last(raw) {
			return got
		}
	}
}

// pageSnapshot is what a page is handed of the trees: the lists of this server, and the sections.
type pageSnapshot struct {
	Groups   []model.Group
	Boards   []model.Board
	Chats    []model.ChatView
	States   []model.BranchState
	Runs     []model.RunView
	Sections map[string]*remotes.Tree
	Lists    map[string]json.RawMessage
}

// state is GET /api/state as the page gets it.
func (f *far) snapshotOf(p *bridgetest.Page) pageSnapshot {
	f.t.Helper()
	return decode[pageSnapshot](f.t, mustOK(f.t, f, p, "GET", "/api/state", ""))
}

// section is the tree of the rig's entry as GET /api/state has it; nil when it has none.
func (f *far) section(p *bridgetest.Page) *remotes.Tree {
	f.t.Helper()
	return f.snapshotOf(p).Sections[f.entry]
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

// group makes a group of this server and returns its id.
func (f *far) group(p *bridgetest.Page, name, parent string) string {
	f.t.Helper()
	return f.good(p, "POST", "/api/groups", form("name", name, "parent", parent))["id"].(string)
}

// sameQuery compares two query strings as sets of values.
func sameQuery(a, b string) bool {
	x, _ := url.ParseQuery(a)
	y, _ := url.ParseQuery(b)
	return reflect.DeepEqual(x, y)
}

// field is the value at the keys in a decoded JSON value, nil when a key is not there.
func field(v any, keys ...string) any {
	for _, k := range keys {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = m[k]
	}
	return v
}
