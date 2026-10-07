package remotes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
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
	wait        = 5 * time.Second
	quiet       = 150 * time.Millisecond
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

// fakeLocal stands in for the chat manager: it lists unstarted chats and notes what it is told.
type fakeLocal struct {
	mu        sync.Mutex
	unstarted map[string][]string       // by entry: the ids of the unstarted chats on it
	chats     map[string]model.ChatMeta // the unstarted chats that have all a chat has, by id
	starts    []string                  // "id=state" for every SetRemoteStart
	handed    []string                  // the ids HandOver was called for
	ups       []string                  // the entries ServerUp was called for
	resets    []string                  // the ids ResetServer was called for
	known     map[string]bool           // the ids of the chats of this server that are not unstarted ones
	onRuns    []string                  // the runs DeleteOnRun was called for
	onUp      func(entry string)
	onHand    func(id string)
}

func (f *fakeLocal) Known(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.chats[id]
	return ok || f.known[id]
}

func (f *fakeLocal) DeleteOnRun(run string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.onRuns = append(f.onRuns, run)
}

func (f *fakeLocal) RemoteUnstarted(id string) (model.ChatMeta, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	meta, ok := f.chats[id]
	return meta, ok
}

func (f *fakeLocal) SetRemoteStart(id, state string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	meta, ok := f.chats[id]
	if !ok {
		return chats.ErrNotFound
	}
	meta.RemoteStart = state
	f.chats[id] = meta
	f.starts = append(f.starts, id+"="+state)
	return nil
}

func (f *fakeLocal) HandOver(id string) (model.ChatMeta, error) {
	f.mu.Lock()
	meta, ok := f.chats[id]
	delete(f.chats, id)
	f.handed = append(f.handed, id)
	on := f.onHand
	f.mu.Unlock()
	if on != nil {
		on(id)
	}
	if !ok {
		return model.ChatMeta{}, chats.ErrNotFound
	}
	return meta, nil
}

func (f *fakeLocal) UnstartedOn(entry string) []model.ChatMeta {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []model.ChatMeta
	for _, id := range f.unstarted[entry] {
		out = append(out, model.ChatMeta{ID: id, Server: entry})
	}
	var own []model.ChatMeta
	for _, meta := range f.chats {
		if meta.Server == entry {
			own = append(own, meta)
		}
	}
	sort.Slice(own, func(i, j int) bool { return own[i].ID < own[j].ID })
	return append(out, own...)
}

func (f *fakeLocal) ServerUp(entry string) {
	f.mu.Lock()
	f.ups = append(f.ups, entry)
	on := f.onUp
	f.mu.Unlock()
	if on != nil {
		on(entry)
	}
}

func (f *fakeLocal) ResetServer(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.resets = append(f.resets, id)
	return nil
}

func (f *fakeLocal) upCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.ups)
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
	snapshot any                    // the stand-in's snapshot; nil = standin.DefaultSnapshot()
	limits   Limits                 // zero fields: Flush 20 ms, the others DefaultLimits
	root     string                 // "" = a new temp folder
	seed     []Record               // adopted after Open, before the manager starts; "" as Entry = the rig's entry
	runSeed  []RunRecord            // the same for run records
	noRuns   bool                   // Options.Runs is nil: this server has no runs
	prepare  func(rg *rig)          // after the entry was added, before Open
	wire     func(rg *rig)          // after Open and the seed, before the hooks are set
	hold     bool                   // do not start the manager: the test calls start
	hooks    func(h *servers.Hooks) // may wrap the relay's hooks
}

// rig is a relay between a stand-in remote server, reached through a real servers.Manager, and
// stand-in pages on a real bridge.
type rig struct {
	t     *testing.T
	root  string
	s     *standin.Server
	m     *servers.Manager
	b     *editorbridge.Bridge
	web   *httptest.Server
	local *fakeLocal
	runs  *fakeRuns
	logs  *logs
	r     *Relay
	entry string

	relay  atomic.Pointer[Relay] // what the bridge's snapshot reads
	noRuns bool                  // the relay has no run service
}

func newRig(t *testing.T, o rigOpt) *rig {
	t.Helper()
	rg := &rig{t: t, root: o.root, local: &fakeLocal{unstarted: map[string][]string{}, chats: map[string]model.ChatMeta{}},
		runs: &fakeRuns{drafts: map[string]model.RunMeta{}}, logs: &logs{}}
	if rg.root == "" {
		rg.root = t.TempDir()
	}
	rg.s = standin.Start(t, standin.Options{Snapshot: o.snapshot})

	// The page's snapshot is built with the bridge's lock held, from the relay, as the app does.
	rg.b = editorbridge.New(func() any {
		r := rg.relay.Load()
		if r == nil {
			return map[string]any{}
		}
		return map[string]any{"chats": r.Views(), "states": r.States(), "lists": r.Lists(), "runs": r.RunViews()}
	})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/events", rg.b.ServeSSE)
	rg.web = httptest.NewServer(mux)
	t.Cleanup(rg.web.Close)

	m, err := servers.Open(servers.Options{Root: rg.root, LocalID: testLocalID, Version: "v-local", Timing: fastTiming()})
	if err != nil {
		t.Fatal(err)
	}
	rg.m = m
	if views := m.Views(); len(views) > 1 {
		rg.entry = views[1].ID // a root that has its list already
	} else {
		v, saved, _, err := m.Add(context.Background(), servers.Input{
			Name: "Studio", Address: rg.s.URL(), Secret: standin.DefaultSecret, SelfSigned: true, Pin: rg.s.Fingerprint(),
		}, true)
		if err != nil || !saved {
			t.Fatalf("the entry is not saved: %v", err)
		}
		rg.entry = v.ID
	}
	if o.prepare != nil {
		o.prepare(rg)
	}
	if o.limits.Flush == 0 {
		o.limits.Flush = 20 * time.Millisecond
	}
	opts := Options{Root: rg.root, Servers: m, Bridge: rg.b, Local: rg.local, Limits: o.limits, Logf: rg.logs.printf}
	if rg.noRuns = o.noRuns; !o.noRuns {
		opts.Runs = rg.runs
	}
	rg.r, err = Open(opts)
	if err != nil {
		t.Fatal(err)
	}
	rg.relay.Store(rg.r)
	t.Cleanup(func() { // the order of a shutdown
		m.Close()
		rg.r.Close()
	})
	for _, d := range o.seed {
		rg.adopt(d)
	}
	for _, d := range o.runSeed {
		rg.adoptRun(d)
	}
	if o.wire != nil {
		o.wire(rg)
	}
	rg.b.OnUnfollowed(rg.r.Unfollowed)
	h := rg.r.Hooks()
	if o.hooks != nil {
		o.hooks(&h)
	}
	m.SetHooks(h)
	if !o.hold {
		rg.start()
	}
	return rg
}

// start starts the manager and waits until the relay has taken the first snapshot.
func (rg *rig) start() {
	rg.t.Helper()
	rg.m.Start()
	rg.returned(1)
}

// returned waits until the relay has taken n snapshots up to the step that calls ServerUp, of
// the chat manager and then of the run service.
func (rg *rig) returned(n int) {
	rg.t.Helper()
	rg.until(fmt.Sprintf("snapshot %d is taken", n), func() bool {
		return rg.local.upCount() >= n && (rg.noRuns || len(rg.runs.told(&rg.runs.ups)) >= n)
	})
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

// state waits until the entry is in the state.
func (rg *rig) state(want servers.State) {
	rg.t.Helper()
	rg.until("the entry is "+string(want), func() bool {
		v, ok := rg.m.View(rg.entry)
		return ok && v.State == want
	})
}

// adopt makes a record, on the rig's entry unless it names one.
func (rg *rig) adopt(d Record) *record {
	rg.t.Helper()
	if d.Entry == "" {
		d.Entry = rg.entry
	}
	rec, err := rg.r.adopt(d)
	if err != nil {
		rg.t.Fatalf("adopt %s: %v", d.ID, err)
	}
	return rec
}

// page connects a stand-in page and reads its hello and snapshot.
func (rg *rig) page(id string) (p *bridgetest.Page, snapshot map[string]any) {
	rg.t.Helper()
	p = bridgetest.Connect(rg.t, rg.web.URL, id)
	return p, p.Welcome()
}

// read makes the page read the chat's items through the relay, which makes it a follower.
func (rg *rig) read(p *bridgetest.Page, id string) {
	rg.t.Helper()
	rec := rg.r.rec(id)
	if rec == nil {
		rg.t.Fatalf("no record %s", id)
	}
	rep, err := rg.r.follow(context.Background(), rec, p.ID, http.MethodGet, chatPath(id, "/items"), rg.r.o.Limits.Call)
	if err != nil || rep.Status != http.StatusOK {
		rg.t.Fatalf("the read of %s: status %d, %v", id, rep.Status, err)
	}
}

// serveItems makes the stand-in answer the items read and the unfollow of every chat.
func (rg *rig) serveItems() {
	rg.s.Handle("GET /api/chats/{id}/items", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":1,"items":[]}`))
	})
	rg.s.Handle("POST /api/chats/{id}/unfollow", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
}

// barrier sends one agents event, which the relay turns into a server_lists event, and returns
// what each page got before that event: all that the relay made of what was sent before.
func (rg *rig) barrier(pages ...*bridgetest.Page) [][]map[string]any {
	rg.t.Helper()
	rg.s.Send(map[string]any{"type": "agents", "agents": []string{"claude", "pi"}})
	out := make([][]map[string]any, len(pages))
	for i, p := range pages {
		for {
			ev := p.Next()
			if ev["type"] == "server_lists" {
				break
			}
			out[i] = append(out[i], ev)
		}
	}
	return out
}

// requests are the stand-in's requests of the method whose path ends in suffix.
func (rg *rig) requests(method, suffix string) []standin.Request {
	var out []standin.Request
	for _, q := range rg.s.Requests() {
		if q.Method == method && strings.HasSuffix(q.Path, suffix) {
			out = append(out, q)
		}
	}
	return out
}

// file reads the record's file.
func (rg *rig) file(id string) Record {
	rg.t.Helper()
	b, err := os.ReadFile(rg.r.files.path(id))
	if err != nil {
		rg.t.Fatal(err)
	}
	var d Record
	if err := json.Unmarshal(b, &d); err != nil {
		rg.t.Fatalf("the file of %s: %v", id, err)
	}
	return d
}

// remoteView is a chat's view as its server sends it: with that server's group.
func remoteView(id string, status model.Status) model.ChatView {
	return model.ChatView{
		ID: id, Agent: model.Claude, Name: "Chat " + id[:2], Group: "g_there", Cwd: "/home/standin/work",
		Model: "standin-model", Locked: true, Status: status,
		Created: time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC),
	}
}

// snapshotWith is the stand-in's snapshot with these chats and the state of main of each.
func snapshotWith(views ...model.ChatView) map[string]any {
	snap := standin.DefaultSnapshot()
	states := []model.BranchState{}
	for _, v := range views {
		states = append(states, model.StateOf(v.ID, mainBranch, v))
	}
	if views == nil {
		views = []model.ChatView{}
	}
	snap["chats"], snap["states"] = views, states
	return snap
}

// seedOf is a record of the chat id in the local group g_here, with the view its server sends.
func seedOf(id string) Record {
	v := remoteView(id, model.StatusReady)
	return Record{ID: id, Group: "g_here", View: v, States: []model.BranchState{model.StateOf(id, mainBranch, v)}}
}

// field walks the keys of nested JSON objects.
func field(v any, keys ...string) any {
	for _, k := range keys {
		m, _ := v.(map[string]any)
		v = m[k]
	}
	return v
}

// The run ids of the tests, and the chat ids of two agents.
const (
	runA   = "r_aaaa0001"
	runB   = "r_bbbb0002"
	agent1 = "3a000000-0000-4000-8000-000000000001"
	agent2 = "3b000000-0000-4000-8000-000000000002"
)

// adoptRun makes a run record, on the rig's entry unless it names one.
func (rg *rig) adoptRun(d RunRecord) *runRecord {
	rg.t.Helper()
	if d.Entry == "" {
		d.Entry = rg.entry
	}
	rec, err := rg.r.adoptRun(d)
	if err != nil {
		rg.t.Fatalf("adoptRun %s: %v", d.ID, err)
	}
	return rec
}

// runFile reads the run record's file.
func (rg *rig) runFile(id string) RunRecord {
	rg.t.Helper()
	b, err := os.ReadFile(rg.r.runFiles.path(id))
	if err != nil {
		rg.t.Fatal(err)
	}
	var d RunRecord
	if err := json.Unmarshal(b, &d); err != nil {
		rg.t.Fatalf("the file of %s: %v", id, err)
	}
	return d
}

// serveRuns makes the stand-in answer the detail read of every run with these agents, the items
// read of every chat, and both unfollow calls.
func (rg *rig) serveRuns(agents ...string) {
	rg.serveItems()
	rg.s.Handle("GET /api/runs/{id}/detail", func(w http.ResponseWriter, r *http.Request) {
		as := map[string]any{}
		for _, a := range agents {
			as[a] = map[string]any{"role": "task"}
		}
		writeJSONTest(w, map[string]any{"run": r.PathValue("id"), "version": 1, "agents": as})
	})
	rg.s.Handle("POST /api/runs/{id}/unfollow", func(w http.ResponseWriter, r *http.Request) {
		writeJSONTest(w, map[string]any{"ok": true})
	})
}

func writeJSONTest(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// readRun makes the page read the run's detail through the relay, which makes it a follower,
// and learns the agents of the answer, as the detail route does.
func (rg *rig) readRun(p *bridgetest.Page, id string) {
	rg.t.Helper()
	rec := rg.r.runRec(id)
	if rec == nil {
		rg.t.Fatalf("no run record %s", id)
	}
	rep, err := rg.r.followRun(context.Background(), rec, p.ID, http.MethodGet, runPath(id, "/detail"), rg.r.o.Limits.Call)
	if err != nil || rep.Status != http.StatusOK {
		rg.t.Fatalf("the detail read of %s: status %d, %v", id, rep.Status, err)
	}
	rg.r.learnDetail(rec, rep.Body)
}

// readAgent makes the page read the items of a run agent's chat through the relay.
func (rg *rig) readAgent(p *bridgetest.Page, chat string) {
	rg.t.Helper()
	rec := rg.r.agentRun(chat)
	if rec == nil {
		rg.t.Fatalf("%s is no agent chat of a run record", chat)
	}
	rep, err := rg.r.followAgent(context.Background(), rec, chat, p.ID, http.MethodGet, chatPath(chat, "/items"), rg.r.o.Limits.Call)
	if err != nil || rep.Status != http.StatusOK {
		rg.t.Fatalf("the items read of %s: status %d, %v", chat, rep.Status, err)
	}
}

// remoteRun is a run's view as its server sends it: with that server's group.
func remoteRun(id string, status model.RunStatus) model.RunView {
	return model.RunView{
		ID: id, Name: "Run " + id[2:4], Group: "g_there", Agent: model.Claude, Cwd: "/home/standin/work", Git: true,
		Created: time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC), Started: time.Date(2026, 10, 6, 9, 1, 0, 0, time.UTC),
		Status: status, Turns: 1,
	}
}

// runSeedOf is a record of the run id in the local group g_here, with the view its server sends.
func runSeedOf(id string) RunRecord {
	return RunRecord{ID: id, Group: "g_here", View: remoteRun(id, model.RunRunning)}
}

// snapshotWithRuns is the stand-in's snapshot with these runs and no chats.
func snapshotWithRuns(views ...model.RunView) map[string]any {
	snap := standin.DefaultSnapshot()
	if views == nil {
		views = []model.RunView{}
	}
	snap["runs"] = views
	return snap
}
