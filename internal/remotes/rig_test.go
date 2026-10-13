package remotes

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
)

const (
	testLocalID = "0b0e6f52-1c3d-4a8e-b7f1-93a2c4d5e6f7" // this server's instance id
	chatA       = "1a000000-0000-4000-8000-00000000000a"
	chatB       = "1b000000-0000-4000-8000-00000000000b"
	agent1      = "3a000000-0000-4000-8000-000000000001" // the chat of a run's agent
	runA        = "r_aaaa0001"
	runB        = "r_bbbb0002"
	boardA      = "b_aaaa0001"
	boardB      = "b_bbbb0002"
	boardC      = "b_cccc0003"
	wait        = 5 * time.Second
	quiet       = 150 * time.Millisecond

	// testLevel is the level of the stand-in servers: the one this relay is a client of.
	testLevel = 5
)

// fastTiming has limits no healthy loopback request reaches and a back-off of 20 and 40 ms.
func fastTiming() servers.Timing {
	const limit = 3 * time.Second
	return servers.Timing{
		Dial: limit, Handshake: limit, Headers: limit, Hello: limit, FirstEvent: limit, Call: limit,
		TestStep: limit, Silence: limit,
		Backoff: []time.Duration{20 * time.Millisecond, 40 * time.Millisecond}, Jitter: -1,
	}
}

// logs collects the relay's log lines.
type logs struct {
	mu    sync.Mutex
	lines []string
}

func (l *logs) printf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *logs) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.lines...)
}

// count is the number of lines that contain part.
func (l *logs) count(part string) int {
	n := 0
	for _, line := range l.all() {
		if strings.Contains(line, part) {
			n++
		}
	}
	return n
}

// rigOpt says how a rig differs from the usual one.
type rigOpt struct {
	snapshot any                    // the stand-in's snapshot; nil = an empty tree
	limits   Limits                 // zero fields: DefaultLimits
	hold     bool                   // do not start the manager: the test calls start
	hooks    func(h *servers.Hooks) // may wrap the relay's hooks
	again    time.Duration          // the relay's wait before a hold call is made again; 0 = Limits.Call
	backoff  []time.Duration        // the manager's back-off; nil = 20 and 40 ms
	timing   func(t *servers.Timing)
	level    *int // the first server's feature level; nil = testLevel
	restart  *rig // a rig that stopped: this one starts on its data folder, with its server
}

// far is one stand-in server of a rig with its entry, and what the rig counts of it.
type far struct {
	rg    *rig
	s     *standin.Server
	entry string
	name  string

	snaps atomic.Int64 // the snapshots the hooks gave the relay
	items atomic.Int64 // those, and the ends of a connection that followed one: what counts a stream
}

// rig is a relay between stand-in remote servers, reached through a real servers.Manager, and
// stand-in pages on a real bridge. Its data folder holds the server list, as the app's does.
type rig struct {
	t    *testing.T
	root string // the data folder
	m    *servers.Manager
	b    *editorbridge.Bridge
	web  *httptest.Server
	logs *logs
	r    *Relay
	h    servers.Hooks // the hooks the manager has: a test may call one as the manager does

	*far // the first server: "Studio"

	mu   sync.Mutex
	fars map[string]*far // by entry id

	relay atomic.Pointer[Relay] // what the bridge's snapshot reads
}

func newRig(t *testing.T, o rigOpt) *rig {
	t.Helper()
	rg := &rig{t: t, root: t.TempDir(), logs: &logs{}, fars: map[string]*far{}}
	if o.restart != nil {
		rg.root = o.restart.root
	}

	// The page's snapshot is built with the bridge's lock held, from the relay, as the app does.
	rg.b = editorbridge.New(func() any {
		r := rg.relay.Load()
		if r == nil {
			return map[string]any{}
		}
		return map[string]any{"sections": r.Sections(), "lists": r.Lists(), "libraries": r.Libraries()}
	})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/events", rg.b.ServeSSE)
	// A page's answer to a tool call, as the server routes it.
	mux.HandleFunc("POST /api/rpc-reply", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var named struct{ ID string }
		_ = json.Unmarshal(body, &named)
		rep := notAsked()
		if rg.r.IsBoardCall(named.ID) {
			rep = rg.r.ReplyBoardCall(r.Context(), r.Header.Get(bridgetest.ClientHeader), named.ID, body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(rep.Status)
		_, _ = w.Write(rep.Body)
	})
	rg.web = httptest.NewServer(mux)
	t.Cleanup(rg.web.Close)

	timing := fastTiming()
	if o.backoff != nil {
		timing.Backoff = o.backoff
	}
	if o.timing != nil {
		o.timing(&timing)
	}
	m, err := servers.Open(servers.Options{Root: rg.root, LocalID: testLocalID, Version: "v-local", Timing: timing})
	if err != nil {
		t.Fatal(err)
	}
	rg.m = m
	rg.r, err = Open(Options{Servers: m, Bridge: rg.b, Limits: o.limits, Logf: rg.logs.printf})
	if err != nil {
		t.Fatal(err)
	}
	if o.again != 0 {
		rg.r.again = o.again
	}
	rg.relay.Store(rg.r)
	t.Cleanup(func() { // the order of a shutdown
		m.Close()
		rg.r.Close()
	})
	// The bridge is wired to the relay as the server wires it.
	rg.b.OnUnfollowed(rg.r.Unfollowed)
	rg.b.OnBoardFree(rg.r.BoardFree)
	rg.b.SceneRev = func(key string) int64 {
		rev, _ := rg.r.BoardRev(key)
		return rev
	}
	h := rg.r.Hooks()
	rg.count(&h)
	if o.hooks != nil {
		o.hooks(&h)
	}
	rg.h = h
	m.SetHooks(h)

	if o.restart != nil {
		// The list is the one of the rig before: its entry, and the server it names.
		rg.far = &far{rg: rg, s: o.restart.s, entry: o.restart.entry, name: o.restart.name}
		rg.fars[rg.entry] = rg.far
	} else {
		rg.far = rg.serverAt("Studio", o.snapshot, o.level)
	}
	if !o.hold {
		rg.start()
	}
	return rg
}

// count makes the hooks count, for each server of the rig, what the relay's worker of its entry
// has to take of a stream: its snapshots, and the ends of a connection that follow one.
func (rg *rig) count(h *servers.Hooks) {
	snapshot, state := h.Snapshot, h.State
	h.Snapshot = func(entry string, raw json.RawMessage) {
		snapshot(entry, raw)
		if f := rg.farOf(entry); f != nil {
			f.snaps.Add(1)
			f.items.Add(1)
		}
	}
	h.State = func(entry string, from, to servers.State) {
		state(entry, from, to)
		if f := rg.farOf(entry); f != nil && to != servers.StateConnected && f.snaps.Load() > 0 {
			f.items.Add(1)
		}
	}
}

func (rg *rig) farOf(entry string) *far {
	rg.mu.Lock()
	defer rg.mu.Unlock()
	return rg.fars[entry]
}

// server starts one more stand-in server of the level of the tests and adds its entry. Before
// start the entry connects with the others; after it, at once.
func (rg *rig) server(name string, snapshot any) *far {
	rg.t.Helper()
	return rg.serverAt(name, snapshot, nil)
}

// serverAt is server for a stand-in that reports the feature level level; nil is testLevel.
func (rg *rig) serverAt(name string, snapshot any, level *int) *far {
	rg.t.Helper()
	if snapshot == nil {
		snapshot = emptySnapshot()
	}
	if level == nil {
		level = standin.Level(testLevel)
	}
	f := &far{rg: rg, name: name}
	// Each stand-in is another server: it has an instance id of its own.
	id := fmt.Sprintf("5d0c3a1e-7b42-4f6a-9c1d-%012d", len(rg.fars)+1)
	f.s = standin.Start(rg.t, standin.Options{Snapshot: snapshot, FeatureLevel: level, InstanceID: id})
	// The lock is held over the add: a hook of the new entry finds its far.
	rg.mu.Lock()
	defer rg.mu.Unlock()
	v, saved, _, err := rg.m.Add(context.Background(), servers.Input{
		Name: name, Address: f.s.URL(), Secret: standin.DefaultSecret, SelfSigned: true, Pin: f.s.Fingerprint(),
	}, true)
	if err != nil || !saved {
		rg.t.Fatalf("the entry %s is not saved: %v", name, err)
	}
	f.entry = v.ID
	rg.fars[f.entry] = f
	return f
}

// start starts the manager and waits until the relay holds the tree of the first server.
func (rg *rig) start() {
	rg.t.Helper()
	rg.m.Start()
	rg.returned(1)
}

// until waits for ok.
func (rg *rig) until(what string, ok func() bool) {
	rg.t.Helper()
	for end := time.Now().Add(wait); !ok(); time.Sleep(2 * time.Millisecond) {
		if time.Now().After(end) {
			rg.t.Fatalf("waited %v in vain: %s", wait, what)
		}
	}
}

// settled waits until the relay's worker has taken every snapshot and every end of a connection
// that the hooks gave it for the server so far.
func (f *far) settled() {
	f.rg.t.Helper()
	f.rg.until("the relay has taken what the hooks gave it for "+f.name, func() bool {
		return int64(f.rg.r.stream(f.entry)) == f.items.Load()
	})
}

// returned waits until the relay has taken the server's n-th snapshot, and holds its tree.
func (f *far) returned(n int64) {
	f.rg.t.Helper()
	f.rg.until(fmt.Sprintf("snapshot %d of %s is taken", n, f.name), func() bool {
		return f.snaps.Load() >= n && int64(f.rg.r.stream(f.entry)) == f.items.Load() && f.rg.r.held(f.entry)
	})
}

// offline stops the stand-in server and waits until the relay holds no tree of it.
func (f *far) offline() {
	f.rg.t.Helper()
	f.s.Stop()
	f.away()
}

// away waits until the relay holds no tree of the server.
func (f *far) away() {
	f.rg.t.Helper()
	f.rg.until("the tree of "+f.name+" is gone", func() bool {
		return int64(f.rg.r.stream(f.entry)) == f.items.Load() && !f.rg.r.held(f.entry)
	})
}

// state waits until the server's entry is in the state.
func (f *far) state(want servers.State) {
	f.rg.t.Helper()
	f.rg.until("the entry of "+f.name+" is "+string(want), func() bool {
		v, ok := f.rg.m.View(f.entry)
		return ok && v.State == want
	})
}

// requests are the stand-in's requests of the method whose path ends in suffix.
func (f *far) requests(method, suffix string) []standin.Request {
	var out []standin.Request
	for _, q := range f.s.Requests() {
		if q.Method == method && strings.HasSuffix(q.Path, suffix) {
			out = append(out, q)
		}
	}
	return out
}

// calls are the stand-in's requests but those of a connection: hello, the state and the stream.
func (f *far) calls() []string {
	var out []string
	for _, q := range f.s.Requests() {
		switch q.Path {
		case servers.HelloPath, servers.StatePath, servers.StreamPath:
		default:
			out = append(out, q.Method+" "+q.Path)
		}
	}
	return out
}

// page connects a stand-in page and reads its hello and snapshot.
func (rg *rig) page(id string) (p *bridgetest.Page, snapshot map[string]any) {
	rg.t.Helper()
	p = bridgetest.Connect(rg.t, rg.web.URL, id)
	return p, p.Welcome()
}

// barrier sends one agents event on the server, which the relay turns into a server_lists
// event, and returns what each page got before that event: all that the relay made of what the
// server sent before.
func (f *far) barrier(pages ...*bridgetest.Page) [][]map[string]any {
	f.rg.t.Helper()
	f.s.Send(map[string]any{"type": "agents", "agents": []string{"claude", "pi"}})
	out := make([][]map[string]any, len(pages))
	for i, p := range pages {
		for {
			ev := p.Next()
			if ev["type"] == "server_lists" && ev["server"] == f.entry {
				break
			}
			out[i] = append(out[i], ev)
		}
	}
	return out
}

// next returns the page's next event of the type typ, passing over the others.
func next(t *testing.T, p *bridgetest.Page, typ string) map[string]any {
	t.Helper()
	for {
		if ev := p.Next(); ev["type"] == typ {
			return ev
		}
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

// reply reads an answer of the relay.
func reply(t *testing.T, rep Reply) (status int, body map[string]any) {
	t.Helper()
	if err := json.Unmarshal(rep.Body, &body); err != nil {
		t.Fatalf("the answer %q: %v", rep.Body, err)
	}
	return rep.Status, body
}

// wantReply fails unless the answer has the status and these members.
func wantReply(t *testing.T, what string, rep Reply, status int, members map[string]any) {
	t.Helper()
	got, body := reply(t, rep)
	if got != status {
		t.Errorf("%s: status %d, want %d: %s", what, got, status, rep.Body)
		return
	}
	for k, v := range members {
		if !reflect.DeepEqual(body[k], v) {
			t.Errorf("%s: %q is %v, want %v: %s", what, k, body[k], v, rep.Body)
		}
	}
}

// mustJSON is v as JSON.
func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// sameJSON reports whether a and b are the same JSON value, whatever the order of their members.
func sameJSON(t *testing.T, a, b any) bool {
	t.Helper()
	var x, y any
	if err := json.Unmarshal(mustJSON(t, a), &x); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(mustJSON(t, b), &y); err != nil {
		t.Fatal(err)
	}
	return reflect.DeepEqual(x, y)
}

// ---- what a server of the level of the tests sends ----

// emptySnapshot is the snapshot of a server with nothing on it.
func emptySnapshot() map[string]any {
	snap := standin.DefaultSnapshot()
	snap["groups"], snap["boards"] = []any{}, []any{}
	snap["defaults"] = map[string]any{"groups": map[string]any{}}
	return snap
}

// farChat is a chat's view as its server sends it.
func farChat(id string, status model.Status) model.ChatView {
	return model.ChatView{
		ID: id, Agent: model.Claude, Name: "Chat " + id[:2], Group: "g_there", Cwd: "/home/standin/work",
		Model: "standin-model", Locked: true, Status: status,
		Created: time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC),
	}
}

// farRun is a run's view as its server sends it.
func farRun(id string, status model.RunStatus) model.RunView {
	return model.RunView{
		ID: id, Name: "Run " + id[2:4], Group: "g_there", Agent: model.Claude, Cwd: "/home/standin/work", Git: true,
		Created: time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC), Started: time.Date(2026, 10, 6, 9, 1, 0, 0, time.UTC),
		Status: status, Turns: 1,
	}
}

// farBoard is a board as its server sends it.
func farBoard(id string) model.Board {
	return model.Board{ID: id, Name: "Board " + id[2:4], Group: "g_there", Created: time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)}
}

// farGroup is a group as its server sends it.
func farGroup(id, name string) model.Group { return model.Group{ID: id, Name: name} }

// tree is a snapshot's tree for snapshotOf.
type tree struct {
	groups []model.Group
	boards []model.Board
	chats  []model.ChatView
	runs   []model.RunView
}

// snapshotOf is the snapshot of a server with this tree, and the state of main of each chat.
func snapshotOf(tr tree) map[string]any {
	snap := emptySnapshot()
	states := []model.BranchState{}
	for _, v := range tr.chats {
		states = append(states, model.StateOf(v.ID, mainBranch, v))
	}
	if tr.groups != nil {
		snap["groups"] = tr.groups
	}
	if tr.boards != nil {
		snap["boards"] = tr.boards
	}
	if tr.chats != nil {
		snap["chats"], snap["states"] = tr.chats, states
	}
	if tr.runs != nil {
		snap["runs"] = tr.runs
	}
	return snap
}

// treeOf is the tree of the server as the relay holds it; ok is false when it holds none.
func (f *far) treeOf() (Tree, bool) {
	t, ok := f.rg.r.Sections()[f.entry]
	return t, ok
}
