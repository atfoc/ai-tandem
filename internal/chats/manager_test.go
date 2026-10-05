package chats

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/prompts"
	"ai-whiteboard/internal/store"
	"ai-whiteboard/internal/transcript"
)

// ---- fakes ----------------------------------------------------------------

type decision struct {
	id    string
	allow bool
}

type fakeAgent struct {
	opts agent.SpawnOptions
	ch   chan agent.Event // unbuffered: a send returns once the pump has taken the event

	mu           sync.Mutex
	sends        [][]agent.ContentBlock
	asked        map[string]bool // the permission requests it raised that have no answer yet
	decides      []decision
	strays       []decision // the answers Decide refused
	interrupts   int
	closed       bool
	interruptErr error         // what Interrupt returns
	sendErr      error         // non-nil: Send refuses the message with it, as an adapter does
	sendEmits    []agent.Event // what a refusing Send emits before it returns
	refusals     int           // the messages Send refused
	sendGate     chan struct{} // non-nil: Send waits for it to close before it takes or refuses a message
	sendPause    chan struct{} // non-nil: a refusing Send waits for it to close once it has emitted, before it returns
	sendPaused   chan struct{} // closed when a Send is waiting for sendPause
}

func (a *fakeAgent) Events() <-chan agent.Event { return a.ch }

func (a *fakeAgent) Send(b []agent.ContentBlock) error {
	a.mu.Lock()
	gate := a.sendGate
	a.mu.Unlock()
	if gate != nil {
		<-gate
	}
	a.mu.Lock()
	err, evs := a.sendErr, a.sendEmits
	if err == nil {
		a.sends = append(a.sends, b)
	} else {
		a.refusals++
	}
	a.mu.Unlock()
	if err != nil && len(evs) > 0 {
		for _, ev := range append(append([]agent.Event(nil), evs...), syncEv) {
			a.ch <- ev // the pump has finished with them before Send returns
		}
	}
	if err != nil {
		a.mu.Lock()
		pause, paused := a.sendPause, a.sendPaused
		a.sendPause, a.sendPaused = nil, nil
		a.mu.Unlock()
		if pause != nil {
			close(paused)
			<-pause
		}
	}
	return err
}

// pauseRefusal makes the next refusing Send wait between its emits and its return until release is
// called: the pump has finished with what the adapter emitted, and the caller of Send does not have
// the error yet. reached is closed when that Send is waiting.
func (a *fakeAgent) pauseRefusal() (reached <-chan struct{}, release func()) {
	pause, paused := make(chan struct{}), make(chan struct{})
	a.mu.Lock()
	a.sendPause, a.sendPaused = pause, paused
	a.mu.Unlock()
	return paused, sync.OnceFunc(func() { close(pause) })
}

// failSends makes every later Send refuse its message with err (nil: accept again), after emitting
// evs: pi signals "thinking" before an ack that times out, and ends the turn itself when it
// rejects a prompt.
func (a *fakeAgent) failSends(err error, evs ...agent.Event) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.sendErr, a.sendEmits = err, evs
}

// blockSends makes every later Send wait until the returned function is called, as pi's does for
// an RPC ack and Cursor's for its handshake. Until then the message is neither sent nor refused.
func (a *fakeAgent) blockSends() (release func()) {
	gate := make(chan struct{})
	a.mu.Lock()
	a.sendGate = gate
	a.mu.Unlock()
	return sync.OnceFunc(func() {
		a.mu.Lock()
		a.sendGate = nil
		a.mu.Unlock()
		close(gate)
	})
}

func (a *fakeAgent) interrupted() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.interrupts
}

func (a *fakeAgent) refused() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.refusals
}

func (a *fakeAgent) Interrupt() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.interrupts++
	return a.interruptErr
}

// Decide refuses an id the agent has not raised or has had answered, as the real adapters do.
func (a *fakeAgent) Decide(id string, allow bool) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.asked[id] {
		a.strays = append(a.strays, decision{id, allow})
		return fmt.Errorf("unknown permission request %q", id)
	}
	delete(a.asked, id)
	a.decides = append(a.decides, decision{id, allow})
	return nil
}

func (a *fakeAgent) Close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closed = true
}

// syncEv is ignored by both the pump and the transcript. Sending it after an event proves the
// pump has finished with that event (the channel is unbuffered).
var syncEv = agent.Event{Kind: agent.EvToolInputDelta, ToolID: "__sync__"}

func (a *fakeAgent) emit(t *testing.T, evs ...agent.Event) {
	t.Helper()
	for _, ev := range append(evs, syncEv) {
		if ev.Kind == agent.EvPermRequest {
			a.mu.Lock()
			if a.asked == nil {
				a.asked = map[string]bool{}
			}
			a.asked[ev.PermID] = true
			a.mu.Unlock()
		}
		select {
		case a.ch <- ev:
		case <-time.After(5 * time.Second):
			t.Fatalf("pump did not take event %v", ev.Kind)
		}
	}
}

// exit ends the process: EvExit, then the channel closes.
func (a *fakeAgent) exit(t *testing.T) {
	t.Helper()
	a.emit(t, agent.Event{Kind: agent.EvExit})
	close(a.ch)
}

func (a *fakeAgent) sent() [][]agent.ContentBlock {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([][]agent.ContentBlock(nil), a.sends...)
}

type fakeSpawner struct {
	mu     sync.Mutex
	agents []*fakeAgent
	live   bool // the agents answer ContextSplit themselves (Claude)

	splitReads []agent.SpawnOptions // ReadContextSplit calls
	liveSplits int                  // ContextSplit calls on its agents
	splitTotal int                  // the Total of the next split given
	splitGate  chan struct{}        // non-nil: every split waits for it to close

	// The fork capability (agent.Forker).
	forks    []forkCall               // SpawnFork calls, failed ones included
	forked   []*fakeAgent             // the agents SpawnFork started (never in agents)
	discards []string                 // DiscardFork calls
	forkErr  error                    // non-nil: SpawnFork fails with it (read when the start ends)
	forkGate chan struct{}            // non-nil: SpawnFork waits for it to close
	onFork   func(agent.SpawnOptions) // called during the start, before the gate
}

type forkCall struct {
	opts agent.SpawnOptions
	src  agent.ForkSource
}

func (s *fakeSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	if _, err := os.Stat(o.Cwd); err != nil {
		return nil, agent.ErrFolderMissing
	}
	a := &fakeAgent{opts: o, ch: make(chan agent.Event)}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.agents = append(s.agents, a)
	if s.live {
		return &splitAgent{a, s}, nil
	}
	return a, nil
}

// SpawnFork starts an agent as Spawn does, once the gate (if any) is open. The session id is the
// app's (Claude, pi) or, when it gave none, one made here (Cursor).
func (s *fakeSpawner) SpawnFork(o agent.SpawnOptions, src agent.ForkSource) (agent.Agent, string, error) {
	s.mu.Lock()
	s.forks = append(s.forks, forkCall{o, src})
	n, gate, hook := len(s.forks), s.forkGate, s.onFork
	s.mu.Unlock()
	if hook != nil {
		hook(o)
	}
	if gate != nil {
		<-gate
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.forkErr != nil {
		return nil, "", s.forkErr
	}
	sid := o.SessionID
	if sid == "" {
		sid = "forked-" + strconv.Itoa(n)
	}
	a := &fakeAgent{opts: o, ch: make(chan agent.Event)}
	s.forked = append(s.forked, a)
	if s.live {
		return &splitAgent{a, s}, sid, nil
	}
	return a, sid, nil
}

func (s *fakeSpawner) DiscardFork(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.discards = append(s.discards, sessionID)
}

func (s *fakeSpawner) forkCalls() []forkCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]forkCall(nil), s.forks...)
}

func (s *fakeSpawner) discarded() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.discards...)
}

// lastFork is the agent the last successful SpawnFork started.
func (s *fakeSpawner) lastFork(t *testing.T) *fakeAgent {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.forked) == 0 {
		t.Fatal("nothing forked")
	}
	return s.forked[len(s.forked)-1]
}

// set changes the fork switches under the spawner's lock.
func (s *fakeSpawner) set(f func(s *fakeSpawner)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f(s)
}

func (a *fakeAgent) isClosed() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.closed
}

// gatedAgent is an agent whose Send waits for gate to close, as pi's does for an RPC ack and
// Cursor's for its handshake. entered is closed when a Send is waiting.
type gatedAgent struct {
	agent.Agent
	once    sync.Once
	entered chan struct{}
	gate    chan struct{}
}

func (g *gatedAgent) Send(b []agent.ContentBlock) error {
	g.once.Do(func() { close(g.entered) })
	<-g.gate
	return g.Agent.Send(b)
}

// gatingForker is a fakeSpawner whose fork starts give a gatedAgent: the message a fork start is
// made for is held at the new process.
type gatingForker struct {
	*fakeSpawner
	started chan *gatedAgent
}

func gating(s *fakeSpawner) *gatingForker {
	return &gatingForker{fakeSpawner: s, started: make(chan *gatedAgent, 1)}
}

func (s *gatingForker) SpawnFork(o agent.SpawnOptions, src agent.ForkSource) (agent.Agent, string, error) {
	ag, sid, err := s.fakeSpawner.SpawnFork(o, src)
	if err != nil {
		return nil, "", err
	}
	g := &gatedAgent{Agent: ag, entered: make(chan struct{}), gate: make(chan struct{})}
	s.started <- g
	return g, sid, nil
}

// waiting returns the agent of the fork start once its Send is waiting.
func (s *gatingForker) waiting(t *testing.T) *gatedAgent {
	t.Helper()
	select {
	case g := <-s.started:
		select {
		case <-g.entered:
			return g
		case <-time.After(5 * time.Second):
		}
	case <-time.After(5 * time.Second):
	}
	t.Fatal("no message reached the process of a fork start")
	return nil
}

// splitAgent is a fakeAgent that answers ContextSplit, as Claude's process does.
type splitAgent struct {
	*fakeAgent
	s *fakeSpawner
}

func (a *splitAgent) ContextSplit() (model.ContextSplit, error) {
	a.s.mu.Lock()
	a.s.liveSplits++
	a.s.mu.Unlock()
	return a.s.split(), nil
}

func (s *fakeSpawner) ReadContextSplit(o agent.SpawnOptions) (model.ContextSplit, error) {
	s.mu.Lock()
	s.splitReads = append(s.splitReads, o)
	s.mu.Unlock()
	return s.split(), nil
}

func (s *fakeSpawner) split() model.ContextSplit {
	s.mu.Lock()
	gate := s.splitGate
	s.splitTotal++
	total := s.splitTotal
	s.mu.Unlock()
	if gate != nil {
		<-gate
	}
	return model.ContextSplit{Total: total, Window: 1000,
		Categories: []model.ContextCategory{{ID: "messages", Label: "Messages", Tokens: total, Kind: "used"}}}
}

// splitCalls is how many splits were asked of the agents and of the spawner.
func (s *fakeSpawner) splitCalls() (live, reads int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.liveSplits, len(s.splitReads)
}

func (s *fakeSpawner) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.agents)
}

func (s *fakeSpawner) last(t *testing.T) *fakeAgent {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.agents) == 0 {
		t.Fatal("nothing spawned")
	}
	return s.agents[len(s.agents)-1]
}

type fakeNamer struct {
	mu    sync.Mutex
	calls []string
}

func (n *fakeNamer) Name(text string) (string, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.calls = append(n.calls, text)
	return "Named title", nil
}

func (n *fakeNamer) callList() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]string(nil), n.calls...)
}

// ---- bridge recorder ------------------------------------------------------

// events is a client connected to the real bridge over SSE, keeping what it receives.
type events struct {
	mu  sync.Mutex
	evs []map[string]any
}

func listen(t *testing.T, br *editorbridge.Bridge) *events {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(br.ServeSSE))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/?client=test", nil)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	e := &events{}
	go func() {
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 1<<20), 1<<24)
		for sc.Scan() {
			line, ok := strings.CutPrefix(sc.Text(), "data: ")
			if !ok {
				continue
			}
			var ev map[string]any
			if json.Unmarshal([]byte(line), &ev) == nil {
				e.mu.Lock()
				e.evs = append(e.evs, ev)
				e.mu.Unlock()
			}
		}
	}()
	e.wait(t, func(ev map[string]any) bool { return ev["type"] == "snapshot" })
	return e
}

func (e *events) find(pred func(map[string]any) bool) map[string]any {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, ev := range e.evs {
		if pred(ev) {
			return ev
		}
	}
	return nil
}

func (e *events) wait(t *testing.T, pred func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if ev := e.find(pred); ev != nil {
			return ev
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("event not received")
	return nil
}

var markSeq atomic.Int64

// drain returns, and forgets, every event received so far: a mark is broadcast and waited for,
// so everything broadcast before the call has arrived.
func (e *events) drain(t *testing.T, br *editorbridge.Bridge) []map[string]any {
	t.Helper()
	n := float64(markSeq.Add(1))
	br.Broadcast(map[string]any{"type": "mark", "n": n})
	e.wait(t, func(ev map[string]any) bool { return ev["type"] == "mark" && ev["n"] == n })
	e.mu.Lock()
	defer e.mu.Unlock()
	for i, ev := range e.evs {
		if ev["type"] == "mark" && ev["n"] == n {
			got := e.evs[:i]
			e.evs = append([]map[string]any(nil), e.evs[i+1:]...)
			return got
		}
	}
	return nil
}

// ofType keeps the events of type typ.
func ofType(evs []map[string]any, typ string) []map[string]any {
	var out []map[string]any
	for _, ev := range evs {
		if ev["type"] == typ {
			out = append(out, ev)
		}
	}
	return out
}

// ---- environment ----------------------------------------------------------

const (
	gOne = "g_one"
	gTwo = "g_two"
)

type env struct {
	t      *testing.T
	root   string
	st     *store.Store
	br     *editorbridge.Bridge
	bds    *boards.Service
	claude *fakeSpawner
	cursor *fakeSpawner
	pi     *fakeSpawner
	namer  *fakeNamer
	m      *Manager
	cwd    string       // DefaultCwd
	clock  atomic.Int64 // the managers' clock, unix ms (Manager.now)
}

// testNow is the fixed time the managers' clock starts at.
const testNow int64 = 1_700_000_000_000

var cursorCatalog = &model.Catalog{
	Models: []model.CatalogModel{
		{ID: "gpt-5.4-mini", Label: "GPT 5.4 mini"},
		{ID: "composer-2", Label: "Composer 2", Efforts: []string{"low", "high"}},
	},
	Default: model.ModelChoice{Model: "composer-2", Effort: "high"},
}

func newEnv(t *testing.T) *env {
	t.Helper()
	root := filepath.Join(t.TempDir(), ".ai-whiteboard")
	st, err := store.Open(store.NewPaths(root))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Update(func(s *model.State) error {
		s.Groups = []model.Group{{ID: gOne, Name: "One"}, {ID: gTwo, Name: "Two"}}
		s.Cursor = cursorCatalog
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, root: root, cwd: t.TempDir()}
	e.clock.Store(testNow)
	e.boot()
	return e
}

// boot starts a fresh manager on the data folder, as a server restart does.
func (e *env) boot() {
	e.t.Helper()
	if e.m != nil {
		// The previous manager's auto namer must not write chat.json alongside the new one.
		e.m.naming.Wait()
	}
	st, err := store.Open(store.NewPaths(e.root))
	if err != nil {
		e.t.Fatal(err)
	}
	e.st = st
	e.br = editorbridge.New(nil)
	e.bds = boards.New(st, e.br)
	if err := e.bds.Load(); err != nil {
		e.t.Fatal(err)
	}
	e.claude, e.cursor, e.pi, e.namer = &fakeSpawner{live: true}, &fakeSpawner{}, &fakeSpawner{live: true}, &fakeNamer{}
	e.m = New(Deps{
		Store:  st,
		Bridge: e.br,
		Boards: e.bds,
		Spawners: map[model.AgentKind]agent.Spawner{
			model.Claude: e.claude,
			model.Cursor: e.cursor,
			model.Pi:     e.pi,
		},
		Namers: map[model.AgentKind]Namer{
			model.Claude: e.namer,
			model.Cursor: e.namer,
			model.Pi:     e.namer,
		},
		DefaultCwd: e.cwd,
		MCPURL:     "http://localhost:6006/mcp",
	})
	e.m.now = func() time.Time { return time.UnixMilli(e.clock.Load()) }
	if err := e.m.Load(); err != nil {
		e.t.Fatal(err)
	}
	// Runs before the temp folders are removed (cleanups run last-registered first), so a late
	// Rename from the auto namer never writes into a folder being removed.
	m := e.m
	e.t.Cleanup(m.naming.Wait)
}

func (e *env) create(a model.AgentKind, group, board string) model.ChatView {
	e.t.Helper()
	v, err := e.m.Create(a, group, board)
	if err != nil {
		e.t.Fatal(err)
	}
	return v
}

func (e *env) view(id string) model.ChatView {
	e.t.Helper()
	v, err := e.m.View(id)
	if err != nil {
		e.t.Fatal(err)
	}
	return v
}

func (e *env) meta(id string) model.ChatMeta {
	e.t.Helper()
	raw, err := os.ReadFile(filepath.Join(e.st.P.ChatDir(id), "chat.json"))
	if err != nil {
		e.t.Fatal(err)
	}
	var m model.ChatMeta
	if err := json.Unmarshal(raw, &m); err != nil {
		e.t.Fatal(err)
	}
	return m
}

func (e *env) items(id string) []model.Item {
	e.t.Helper()
	_, items, _, err := e.m.Items(id)
	if err != nil {
		e.t.Fatal(err)
	}
	return items
}

func (e *env) send(id, text, ctx string) {
	e.t.Helper()
	if err := e.m.Send(id, text, ctx, nil); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) setDefaults(d model.Defaults) {
	e.t.Helper()
	if err := e.st.Update(func(s *model.State) error { s.Defaults = d; return nil }); err != nil {
		e.t.Fatal(err)
	}
}

func texts(bs []agent.ContentBlock) []string {
	out := make([]string, len(bs))
	for i, b := range bs {
		out[i] = b.Text
	}
	return out
}

func waitFor(t *testing.T, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !f() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// ---- tests ----------------------------------------------------------------

func TestCreateAppliesGroupDefaults(t *testing.T) {
	e := newEnv(t)
	dirA, dirB := t.TempDir(), t.TempDir()
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{
		gOne: {Cwd: dirA, ByAgent: map[model.AgentKind]model.ModelChoice{model.Claude: {Model: "opus", Effort: "low"}}},
		gTwo: {Cwd: dirB, ByAgent: map[model.AgentKind]model.ModelChoice{model.Cursor: {Model: "gpt-5.4-mini"}}},
	}})

	v := e.create(model.Claude, gOne, "")
	if v.Agent != model.Claude || v.Group != gOne || v.Cwd != dirA || v.Model != "opus" || v.Effort != "low" || v.Locked {
		t.Fatalf("plain chat view %+v", v)
	}
	if v.Status != model.StatusReady {
		t.Fatalf("status %q", v.Status)
	}
	m := e.meta(v.ID)
	if m.Agent != model.Claude || m.SessionID == "" {
		t.Fatalf("plain chat.json %+v", m)
	}
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(m.Token) {
		t.Fatalf("plain token %q", m.Token)
	}

	bd, err := e.bds.Create("board", gTwo, false)
	if err != nil {
		t.Fatal(err)
	}
	bv := e.create(model.Cursor, gOne, bd.ID) // the board's group wins
	bm := e.meta(bv.ID)
	if bm.Board != bd.ID || bm.Group != "" || bm.Cwd != dirB || bm.Model != "gpt-5.4-mini" || bm.Effort != "" {
		t.Fatalf("board chat.json %+v", bm)
	}
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(bm.Token) {
		t.Fatalf("token %q", bm.Token)
	}
	if bm.SessionID != "" {
		t.Fatalf("cursor chat got a session id before session/new: %q", bm.SessionID)
	}
	if g := e.m.GroupOf(bm); g != gTwo {
		t.Fatalf("GroupOf = %q", g)
	}
	cb := e.create(model.Claude, "", bd.ID)
	if e.meta(cb.ID).SessionID == "" || e.meta(cb.ID).Token == "" {
		t.Fatalf("claude board chat %+v", e.meta(cb.ID))
	}
	if raw, _ := json.Marshal(e.m.Views()); strings.Contains(string(raw), bm.Token) {
		t.Fatal("token leaked into views")
	}

	if e.claude.count()+e.cursor.count() != 0 {
		t.Fatal("Create spawned an agent")
	}
	// Resolved values are not recorded.
	e.st.Read(func(s *model.State) {
		if s.Defaults.Last.Cwd != "" || len(s.Defaults.Last.ByAgent) != 0 {
			t.Fatalf("Create recorded defaults: %+v", s.Defaults.Last)
		}
	})

	if _, err := e.m.Create(model.Claude, "g_nope", ""); err == nil {
		t.Fatal("Create in an unknown group succeeded")
	}
	if _, err := e.m.Create(model.Claude, "", "b_nope"); !errors.Is(err, boards.ErrNotFound) {
		t.Fatalf("Create on unknown board: %v", err)
	}
}

func TestCreatePiAssignsSessionIDAndResolvesCatalog(t *testing.T) {
	e := newEnv(t)
	piCat := &model.Catalog{
		Models: []model.CatalogModel{
			{ID: "deepseek-flash", Label: "DeepSeek Flash"},
			{ID: "glm-5.2", Label: "GLM 5.2", Efforts: []string{"low", "high"}},
		},
		Default: model.ModelChoice{Model: "glm-5.2", Effort: "high"},
	}
	if err := e.st.Update(func(s *model.State) error { s.SetCatalog(model.Pi, piCat); return nil }); err != nil {
		t.Fatal(err)
	}
	v := e.create(model.Pi, gOne, "")
	m := e.meta(v.ID)
	if m.Agent != model.Pi || m.SessionID == "" {
		t.Fatalf("pi chat.json %+v, want the app-assigned session id", m)
	}
	if v.Model != "glm-5.2" || v.Effort != "high" {
		t.Fatalf("pi defaults %+v, want the stored Pi catalog's default", v)
	}
	if e.pi.count() != 0 {
		t.Fatal("Create spawned a pi agent")
	}
}

func TestCreateRejectsUnknownAgent(t *testing.T) {
	e := newEnv(t)
	if _, err := e.m.Create(model.AgentKind("future"), gOne, ""); err == nil || !strings.Contains(err.Error(), "unknown agent") {
		t.Fatalf("Create with an unknown kind: %v, want an unknown agent error", err)
	}
}

func TestPiResumeKeepsAssignedSessionID(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Pi, gOne, "")
	sid := e.meta(v.ID).SessionID
	e.send(v.ID, "one", "")
	a := e.pi.last(t)
	if a.opts.SessionID != sid || a.opts.Resume {
		t.Fatalf("first pi spawn %+v, want the app-assigned session id and no resume", a.opts)
	}
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	a.exit(t)
	e.send(v.ID, "two", "")
	if e.pi.count() != 2 {
		t.Fatalf("%d spawns", e.pi.count())
	}
	if o := e.pi.last(t).opts; !o.Resume || o.SessionID != sid {
		t.Fatalf("pi resume options %+v, want SessionID %q and Resume", o, sid)
	}
}

func TestCatalogLegacyCursorField(t *testing.T) {
	e := newEnv(t) // newEnv stores cursorCatalog in the legacy cursorCatalog field only
	if got := e.m.catalog(model.Cursor); got == nil || got.Default != cursorCatalog.Default || len(got.Models) != len(cursorCatalog.Models) {
		t.Fatalf("legacy cursor catalog not returned: %+v", got)
	}
	if got := e.m.catalog(model.Pi); got != nil {
		t.Fatalf("pi catalog before it is stored: %+v", got)
	}
	// A generic stored catalog wins over the legacy field.
	stored := &model.Catalog{Models: []model.CatalogModel{{ID: "new-cursor"}}, Default: model.ModelChoice{Model: "new-cursor"}}
	if err := e.st.Update(func(s *model.State) error { s.SetCatalog(model.Cursor, stored); return nil }); err != nil {
		t.Fatal(err)
	}
	if got := e.m.catalog(model.Cursor); got == nil || got.Default.Model != "new-cursor" {
		t.Fatalf("stored cursor catalog not returned: %+v", got)
	}
}

func TestPiCatalogEventPersistsAndBroadcasts(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	v := e.create(model.Pi, gOne, "")
	e.send(v.ID, "hello", "")
	a := e.pi.last(t)
	cat := model.Catalog{
		Models:  []model.CatalogModel{{ID: "deepseek-flash", Label: "DeepSeek Flash", Provider: "deepseek"}},
		Default: model.ModelChoice{Model: "deepseek-flash"},
	}
	a.emit(t, agent.Event{Kind: agent.EvCatalog, Catalog: &cat})

	ev := evs.wait(t, func(ev map[string]any) bool { return ev["type"] == "catalog" && ev["agent"] == "pi" })
	raw, _ := json.Marshal(ev["catalog"])
	if !strings.Contains(string(raw), `"provider":"deepseek"`) {
		t.Errorf("broadcast catalog lacks the provider: %s", raw)
	}
	var got model.Catalog
	if err := json.Unmarshal(raw, &got); err != nil || got.Default.Model != "deepseek-flash" || len(got.Models) != 1 || got.Models[0].Provider != "deepseek" {
		t.Fatalf("catalog event %s (%v)", raw, err)
	}
	e.st.Read(func(s *model.State) {
		if c := s.Catalog(model.Pi); c == nil || c.Default.Model != "deepseek-flash" || len(c.Models) != 1 || c.Models[0].Provider != "deepseek" {
			t.Fatalf("pi catalog not persisted with its provider under Pi: %+v", c)
		}
		if _, ok := s.Catalogs[model.Cursor]; ok {
			t.Fatalf("the pi catalog event wrote the Cursor slot: %+v", s.Catalogs)
		}
		if s.Cursor == nil || s.Cursor.Default != cursorCatalog.Default {
			t.Fatalf("legacy cursor catalog changed: %+v", s.Cursor)
		}
	})
}

func TestOpenNeverSpawnsAndShowsMissingFolder(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{model.Ungrouped: {Cwd: dir}}})
	v := e.create(model.Claude, model.Ungrouped, "")
	if err := e.m.Open(v.ID); err != nil {
		t.Fatal(err)
	}
	if e.claude.count() != 0 {
		t.Fatal("Open spawned")
	}
	e.send(v.ID, "hi", "")
	e.claude.last(t).emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.claude.last(t).exit(t)

	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Open(v.ID); err != nil {
		t.Fatal(err)
	}
	got := e.view(v.ID)
	if !got.FolderMissing || got.Status != model.StatusError || !strings.Contains(got.Error, dir) {
		t.Fatalf("view after Open with folder gone: %+v", got)
	}
	if e.claude.count() != 1 {
		t.Fatalf("Open spawned: %d spawns", e.claude.count())
	}
}

func TestConfigureBeforeFirstMessage(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	v := e.create(model.Claude, gOne, "")
	sid := e.meta(v.ID).SessionID
	dir := t.TempDir()
	if err := e.m.Configure(v.ID, ConfigReq{Model: "opus", Effort: "max", Cwd: dir}); err != nil {
		t.Fatal(err)
	}
	m := e.meta(v.ID)
	if m.Model != "opus" || m.Effort != "max" || m.Cwd != dir || m.SessionID != sid || m.Locked {
		t.Fatalf("chat.json after Configure %+v (session was %s)", m, sid)
	}
	if e.claude.count() != 0 {
		t.Fatal("Configure spawned")
	}
	want := model.GroupDefaults{Cwd: dir, ByAgent: map[model.AgentKind]model.ModelChoice{model.Claude: {Model: "opus", Effort: "max"}}}
	e.st.Read(func(s *model.State) {
		if !reflect.DeepEqual(s.Defaults.Groups[gOne], want) || !reflect.DeepEqual(s.Defaults.Last, want) {
			t.Fatalf("defaults %+v", s.Defaults)
		}
	})
	evs.wait(t, func(ev map[string]any) bool { return ev["type"] == "defaults" })

	// A model with no efforts clears the effort.
	if err := e.m.Configure(v.ID, ConfigReq{Model: "haiku"}); err != nil {
		t.Fatal(err)
	}
	if m := e.meta(v.ID); m.Model != "haiku" || m.Effort != "" {
		t.Fatalf("after haiku: %+v", m)
	}
	if err := e.m.Configure(v.ID, ConfigReq{Model: "nope"}); err == nil {
		t.Fatal("unknown model accepted")
	}
	if err := e.m.Configure(v.ID, ConfigReq{Effort: "high"}); err == nil {
		t.Fatal("effort accepted for a model without efforts")
	}
}

func TestConfigureModelChangeFitsEffort(t *testing.T) {
	e := newEnv(t)
	if err := e.st.Update(func(s *model.State) error {
		s.Cursor = &model.Catalog{
			Models: []model.CatalogModel{
				{ID: "claude-opus-5-5", Efforts: []string{"low", "medium", "high", "xhigh", "max"}, DefaultEffort: "medium"},
				{ID: "glm-5.2", Efforts: []string{"high", "max"}, DefaultEffort: "high"},
				{ID: "gpt-5.4-mini", Efforts: []string{"none", "low", "medium", "high", "xhigh"}, DefaultEffort: "medium"},
				{ID: "plain"},
			},
			Default: model.ModelChoice{Model: "claude-opus-5-5", Effort: "medium"},
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	v := e.create(model.Cursor, gOne, "")
	configure := func(req ConfigReq, wantModel, wantEffort string) {
		t.Helper()
		if err := e.m.Configure(v.ID, req); err != nil {
			t.Fatalf("Configure %+v: %v", req, err)
		}
		if m := e.meta(v.ID); m.Model != wantModel || m.Effort != wantEffort {
			t.Fatalf("after %+v: model %q effort %q, want %q %q", req, m.Model, m.Effort, wantModel, wantEffort)
		}
	}
	configure(ConfigReq{Model: "claude-opus-5-5", Effort: "max"}, "claude-opus-5-5", "max")
	// The new model has the current effort: unchanged.
	configure(ConfigReq{Model: "glm-5.2"}, "glm-5.2", "max")
	// The new model lacks "max": its default effort.
	configure(ConfigReq{Model: "gpt-5.4-mini"}, "gpt-5.4-mini", "medium")
	// A model with no efforts: cleared.
	configure(ConfigReq{Model: "plain"}, "plain", "")
	// Model and effort together: the requested effort.
	configure(ConfigReq{Model: "gpt-5.4-mini", Effort: "none"}, "gpt-5.4-mini", "none")
	// A requested effort the model lacks is an error, and nothing changes.
	if err := e.m.Configure(v.ID, ConfigReq{Model: "glm-5.2", Effort: "low"}); err == nil {
		t.Fatal("effort the model lacks accepted")
	}
	if m := e.meta(v.ID); m.Model != "gpt-5.4-mini" || m.Effort != "none" {
		t.Fatalf("after rejected Configure: %+v", m)
	}
}

func TestSpawnMintsTokenlessChat(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	meta := e.meta(v.ID)
	meta.Token = ""
	path := filepath.Join(e.st.P.ChatDir(v.ID), "chat.json")
	raw, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	e.boot()
	if e.meta(v.ID).Token != "" {
		t.Fatalf("Load minted a token: %q", e.meta(v.ID).Token)
	}
	e.send(v.ID, "hello", "")
	tok := e.meta(v.ID).Token
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(tok) {
		t.Fatalf("spawn token %q", tok)
	}
	a := e.claude.last(t)
	if a.opts.MCP == nil || a.opts.MCP.Token != tok || a.opts.BoardID != "" {
		t.Fatalf("spawn options MCP %+v BoardID %q", a.opts.MCP, a.opts.BoardID)
	}
	if _, ok := e.m.ByToken(tok); !ok {
		t.Fatal("minted token not resolved")
	}
}

func TestFirstSendSpawnsOnce(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	sid := e.meta(v.ID).SessionID
	e.send(v.ID, "hello", "")
	if e.claude.count() != 1 {
		t.Fatalf("%d spawns", e.claude.count())
	}
	o := e.claude.last(t).opts
	want := agent.SpawnOptions{ChatID: v.ID, SessionID: sid, Resume: false, Cwd: v.Cwd, Model: v.Model, Effort: v.Effort,
		MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: e.meta(v.ID).Token}}
	if !reflect.DeepEqual(o, want) {
		t.Fatalf("spawn options %+v, want %+v", o, want)
	}
	if m := e.meta(v.ID); !m.Locked || !m.TurnActive {
		t.Fatalf("chat.json after Send %+v", m)
	}
	e.claude.last(t).emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.send(v.ID, "again", "")
	if e.claude.count() != 1 {
		t.Fatal("second Send spawned again")
	}
}

func TestFirstSendRecordsDefaults(t *testing.T) {
	e := newEnv(t)
	e.setDefaults(model.Defaults{Last: model.GroupDefaults{
		Cwd:     t.TempDir(),
		ByAgent: map[model.AgentKind]model.ModelChoice{model.Claude: {Model: "opus", Effort: "max"}},
	}})
	v := e.create(model.Claude, gOne, "")
	dir := t.TempDir()
	if err := e.m.Configure(v.ID, ConfigReq{Cwd: dir}); err != nil {
		t.Fatal(err)
	}
	e.send(v.ID, "hello", "")
	// The model came from "last" and was never changed, but sending confirms it for the group.
	want := model.GroupDefaults{Cwd: dir, ByAgent: map[model.AgentKind]model.ModelChoice{model.Claude: {Model: "opus", Effort: "max"}}}
	e.st.Read(func(s *model.State) {
		if !reflect.DeepEqual(s.Defaults.Groups[gOne], want) || !reflect.DeepEqual(s.Defaults.Last, want) {
			t.Fatalf("defaults after first Send %+v", s.Defaults)
		}
	})
}

func TestConfigureLockedAndAppFolder(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	if err := e.m.Configure(v.ID, ConfigReq{Cwd: e.st.P.Boards}); !errors.Is(err, ErrAppFolder) {
		t.Fatalf("Configure into the data folder: %v", err)
	}
	if err := e.m.Configure(v.ID, ConfigReq{Cwd: e.root}); !errors.Is(err, ErrAppFolder) {
		t.Fatalf("Configure to the data folder: %v", err)
	}
	e.send(v.ID, "hello", "")
	for _, req := range []ConfigReq{{Model: "opus"}, {Effort: "low"}, {Cwd: t.TempDir()}} {
		if err := e.m.Configure(v.ID, req); !errors.Is(err, ErrLocked) {
			t.Fatalf("Configure %+v after Send: %v", req, err)
		}
	}
}

func TestSendBlocks(t *testing.T) {
	e := newEnv(t)
	bd, err := e.bds.Create("board", gOne, false)
	if err != nil {
		t.Fatal(err)
	}
	ctx := "<ui-context>\nboard: b\n</ui-context>"

	// Plain chat: the context is dropped. MCP is still set; board extras are not.
	p := e.create(model.Claude, gOne, "")
	e.send(p.ID, "plain", ctx)
	pa := e.claude.last(t)
	if got := texts(pa.sent()[0]); !reflect.DeepEqual(got, []string{"plain"}) {
		t.Fatalf("plain chat sent %q", got)
	}
	if pa.opts.MCP == nil || pa.opts.MCP.MCPURL != "http://localhost:6006/mcp" || pa.opts.MCP.Token != e.meta(p.ID).Token || pa.opts.BoardID != "" || pa.opts.Subagent {
		t.Fatalf("plain spawn options MCP %+v BoardID %q Subagent %v", pa.opts.MCP, pa.opts.BoardID, pa.opts.Subagent)
	}
	if it := e.items(p.ID)[0]; it.Kind != "user" || it.Text != "plain" || it.Context != "" {
		t.Fatalf("plain user item %+v", it)
	}

	// Claude board chat: [context, text].
	cb := e.create(model.Claude, "", bd.ID)
	e.send(cb.ID, "draw", ctx)
	ca := e.claude.last(t)
	if got := texts(ca.sent()[0]); !reflect.DeepEqual(got, []string{ctx, "draw"}) {
		t.Fatalf("claude board chat sent %q", got)
	}
	tok := e.meta(cb.ID).Token
	if ca.opts.MCP == nil || ca.opts.MCP.MCPURL != "http://localhost:6006/mcp" || ca.opts.MCP.Token != tok || ca.opts.BoardID != bd.ID || ca.opts.Subagent {
		t.Fatalf("board spawn options MCP %+v BoardID %q", ca.opts.MCP, ca.opts.BoardID)
	}
	if it := e.items(cb.ID)[0]; it.Context != ctx {
		t.Fatalf("board user item context %q", it.Context)
	}

	// Cursor board chat: the whiteboard body only the first time, then context + text.
	ub := e.create(model.Cursor, "", bd.ID)
	e.send(ub.ID, "one", ctx)
	ua := e.cursor.last(t)
	if ua.opts.MCP == nil || ua.opts.MCP.MCPURL != "http://localhost:6006/mcp" || ua.opts.MCP.Token != e.meta(ub.ID).Token || ua.opts.BoardID != bd.ID {
		t.Fatalf("cursor board access MCP %+v BoardID %q", ua.opts.MCP, ua.opts.BoardID)
	}
	if got := texts(ua.sent()[0]); !reflect.DeepEqual(got, []string{prompts.Claude(), ctx, "one"}) {
		t.Fatalf("cursor first send %q", got)
	}
	for _, s := range texts(ua.sent()[0]) {
		if strings.Contains(s, "<board-api>") || strings.Contains(s, "curl") {
			t.Fatalf("cursor first send still carries the command path: %q", s)
		}
	}
	if !e.meta(ub.ID).McpInstructionsSent {
		t.Fatal("mcpInstructionsSent not saved")
	}
	if e.meta(ub.ID).InstructionsSent {
		t.Fatal("instructionsSent set on a new Cursor board send")
	}
	ua.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.send(ub.ID, "two", ctx)
	if got := texts(ua.sent()[1]); !reflect.DeepEqual(got, []string{ctx, "two"}) {
		t.Fatalf("cursor second send %q", got)
	}

	// Naming starts on the first send only.
	waitFor(t, "names", func() bool { return len(e.namer.callList()) == 3 })
	waitFor(t, "rename", func() bool { return e.view(ub.ID).Name == "Named title" })
	calls := e.namer.callList()
	for _, want := range []string{"plain", "draw", "one"} {
		found := false
		for _, c := range calls {
			found = found || c == want
		}
		if !found {
			t.Fatalf("namer calls %q, missing %q", calls, want)
		}
	}
	if m := e.meta(ub.ID); m.Name != "Named title" || m.UserNamed {
		t.Fatalf("auto name %+v", m)
	}
}

func TestSendPiBoardChat(t *testing.T) {
	e := newEnv(t)
	bd, err := e.bds.Create("board", gOne, false)
	if err != nil {
		t.Fatal(err)
	}
	ctx := "<ui-context>\nboard: b\n</ui-context>"
	c := e.create(model.Pi, "", bd.ID)
	e.send(c.ID, "draw", ctx)
	a := e.pi.last(t)
	if got := texts(a.sent()[0]); !reflect.DeepEqual(got, []string{ctx, "draw"}) {
		t.Fatalf("pi board chat sent %q, want only the context and the text", got)
	}
	// The pi spawner gets the same shared MCP value as Claude: the fixed endpoint URL
	// and the chat's durable token (not a run-scoped URL). pi's own unit tests construct
	// their own BoardAccess, so this manager-level assertion is what catches a split there.
	if a.opts.MCP == nil || a.opts.MCP.MCPURL != "http://localhost:6006/mcp" ||
		a.opts.MCP.Token != e.meta(c.ID).Token || a.opts.MCP.Token == "" || a.opts.BoardID != bd.ID {
		t.Fatalf("pi board access MCP %+v BoardID %q, want the fixed URL and the chat's token", a.opts.MCP, a.opts.BoardID)
	}
	if strings.Contains(a.opts.MCP.MCPURL, a.opts.MCP.Token) {
		t.Fatalf("pi board MCP URL carries the token: %q", a.opts.MCP.MCPURL)
	}
	if m := e.meta(c.ID); m.InstructionsSent || m.McpInstructionsSent {
		t.Fatal("pi got Cursor's instructions")
	}
	// The fallback <ui-context> still names the board when the page sends none.
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.send(c.ID, "move it", "")
	want := prompts.BoardContext("board", bd.ID)
	if got := texts(a.sent()[1]); !reflect.DeepEqual(got, []string{want, "move it"}) {
		t.Fatalf("pi board chat without a page context sent %q", got)
	}
}

func TestLegacyCursorBoardChatDisabled(t *testing.T) {
	e := newEnv(t)
	bd, err := e.bds.Create("board", gOne, false)
	if err != nil {
		t.Fatal(err)
	}
	v := e.create(model.Cursor, "", bd.ID)
	path := filepath.Join(e.st.P.ChatDir(v.ID), "chat.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var meta model.ChatMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatal(err)
	}
	meta.InstructionsSent = true
	if err := store.WriteJSONAtomic(path, meta, 0o600); err != nil {
		t.Fatal(err)
	}
	e.boot()
	if err := e.m.Send(v.ID, "hi", "", nil); !errors.Is(err, ErrLegacy) {
		t.Fatalf("Send: %v", err)
	}
	if e.cursor.count() != 0 {
		t.Fatal("agent spawned")
	}
	if err := e.m.Configure(v.ID, ConfigReq{Model: "gpt-5.4-mini"}); !errors.Is(err, ErrLegacy) {
		t.Fatalf("Configure: %v", err)
	}
	if !e.view(v.ID).InstructionsSent {
		t.Fatal("View missing InstructionsSent")
	}
}

func TestNoNamerEntryMeansNoName(t *testing.T) {
	e := newEnv(t)
	e.m.Namers = map[model.AgentKind]Namer{model.Claude: e.namer}
	v := e.create(model.Pi, gOne, "")
	e.send(v.ID, "hello", "")
	if calls := e.namer.callList(); len(calls) != 0 {
		t.Fatalf("pi chat was named without a namer entry: %q", calls)
	}
	if name := e.meta(v.ID).Name; name != "" {
		t.Fatalf("pi chat got name %q", name)
	}
}

func TestSendNamesTheBoard(t *testing.T) {
	e := newEnv(t)
	bd, err := e.bds.Create("arch", gOne, false)
	if err != nil {
		t.Fatal(err)
	}
	// A board chat message sent without a context still names its board.
	cb := e.create(model.Claude, "", bd.ID)
	msg := `move <selection ids="a1" label="rectangle “API”">rectangle id=a1 "API" (0,0 160×70)</selection> to <point x="10" y="-20"/>`
	e.send(cb.ID, msg, "")
	want := prompts.BoardContext("arch", bd.ID)
	if got := texts(e.claude.last(t).sent()[0]); !reflect.DeepEqual(got, []string{want, msg}) {
		t.Fatalf("board chat sent %q", got)
	}
	if it := e.items(cb.ID)[0]; it.Text != msg || it.Context != want {
		t.Fatalf("user item %+v", it)
	}
	// The chat is named from the message with its references shortened.
	waitFor(t, "names", func() bool { return len(e.namer.callList()) == 1 })
	if got := e.namer.callList()[0]; got != "move [rectangle “API”] to [point (10, -20)]" {
		t.Fatalf("namer got %q", got)
	}
}

func TestPlainText(t *testing.T) {
	for in, want := range map[string]string{
		"no refs": "no refs",
		`a <selection ids="x,y" label="2 elements">…</selection> b`:                     "a [2 elements] b",
		`<selection ids="x" label="text “a &amp; b”">text id=x "a &amp; b"</selection>`: "[text “a & b”]",
		`at <point x="1" y="2">near: rectangle id=x (0,0 1×1) 1px left</point>.`:        "at [point (1, 2)].",
		`<point x="-3" y="4"/><point x="5" y="6"/>`:                                     "[point (-3, 4)][point (5, 6)]",
	} {
		if got := PlainText(in); got != want {
			t.Errorf("PlainText(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRenameUserNameWins(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	if err := e.m.Rename(v.ID, "  Mine ", true); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Rename(v.ID, "Auto", false); err != nil {
		t.Fatal(err)
	}
	if m := e.meta(v.ID); m.Name != "Mine" || !m.UserNamed {
		t.Fatalf("after renames %+v", m)
	}
}

func TestDraft(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	v := e.create(model.Claude, gOne, "")
	d := model.Draft{Text: "half a thought", Mentions: []model.Mention{{Name: "Plan", ID: "b_1"}}}
	if err := e.m.SetDraft(v.ID, d); err != nil {
		t.Fatal(err)
	}
	evs.wait(t, func(ev map[string]any) bool {
		c, _ := ev["chat"].(map[string]any)
		dr, _ := c["draft"].(map[string]any)
		return ev["type"] == "chat" && c["id"] == v.ID && dr["text"] == d.Text
	})
	if m := e.meta(v.ID); !reflect.DeepEqual(m.Draft, &d) {
		t.Fatalf("chat.json draft %+v", m.Draft)
	}

	e.boot() // kept across a restart
	if got := e.view(v.ID).Draft; !reflect.DeepEqual(got, &d) {
		t.Fatalf("draft after restart %+v", got)
	}

	if err := e.m.SetDraft(v.ID, model.Draft{Mentions: d.Mentions}); err != nil { // mentions alone are no draft
		t.Fatal(err)
	}
	if m := e.meta(v.ID); m.Draft != nil {
		t.Fatalf("empty draft stored %+v", m.Draft)
	}
	if err := e.m.SetDraft("nope", d); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SetDraft on unknown chat: %v", err)
	}
}

func TestSendClearsDraft(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.m.SetDraft(v.ID, model.Draft{Text: "one"})
	e.send(v.ID, "one", "")
	if m := e.meta(v.ID); m.Draft != nil {
		t.Fatalf("draft after send %+v", m.Draft)
	}
	// A send refused while busy leaves the draft alone.
	e.m.SetDraft(v.ID, model.Draft{Text: "two"})
	if err := e.m.Send(v.ID, "two", "", nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("Send while busy: %v", err)
	}
	if m := e.meta(v.ID); m.Draft == nil || m.Draft.Text != "two" {
		t.Fatalf("draft after busy send %+v", m.Draft)
	}
}

func TestSendAfterExitResumes(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	sid := e.meta(v.ID).SessionID
	e.send(v.ID, "one", "")
	a := e.claude.last(t)
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	a.exit(t)
	e.send(v.ID, "two", "")
	if e.claude.count() != 2 {
		t.Fatalf("%d spawns", e.claude.count())
	}
	if o := e.claude.last(t).opts; !o.Resume || o.SessionID != sid {
		t.Fatalf("resume options %+v", o)
	}

	// Cursor: the id reported by session/new is the one resumed.
	c := e.create(model.Cursor, gOne, "")
	e.send(c.ID, "one", "")
	ca := e.cursor.last(t)
	if ca.opts.SessionID != "" || ca.opts.Resume {
		t.Fatalf("first cursor spawn %+v", ca.opts)
	}
	ca.emit(t, agent.Event{Kind: agent.EvSession, SessionID: "cur-1"}, agent.Event{Kind: agent.EvTurnEnd})
	if e.meta(c.ID).SessionID != "cur-1" {
		t.Fatal("session id not saved")
	}
	ca.exit(t)
	e.send(c.ID, "two", "")
	if o := e.cursor.last(t).opts; !o.Resume || o.SessionID != "cur-1" {
		t.Fatalf("cursor resume %+v", o)
	}
}

func TestSendWhileBusy(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "one", "")
	a := e.claude.last(t)
	waitFor(t, "auto name", func() bool { return e.meta(v.ID).Name != "" }) // the namer's save is done
	before, err := os.ReadFile(filepath.Join(e.st.P.ChatDir(v.ID), "chat.json"))
	if err != nil {
		t.Fatal(err)
	}
	n := len(e.items(v.ID))
	if !e.m.Busy(v.ID) {
		t.Fatal("not busy after Send")
	}
	if err := e.m.Send(v.ID, "two", "", nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("Send while busy: %v", err)
	}
	after, _ := os.ReadFile(filepath.Join(e.st.P.ChatDir(v.ID), "chat.json"))
	if string(before) != string(after) {
		t.Fatal("chat.json changed")
	}
	if len(e.items(v.ID)) != n || len(a.sent()) != 1 {
		t.Fatal("busy Send added an item or reached the agent")
	}
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.send(v.ID, "two", "")
	if len(a.sent()) != 2 {
		t.Fatal("Send after turn end did not reach the agent")
	}
}

func TestLoadIsLazy(t *testing.T) {
	e := newEnv(t)
	good := e.create(model.Claude, gOne, "")
	e.send(good.ID, "hello", "")
	e.claude.last(t).emit(t, agent.Event{Kind: agent.EvText, Text: "hi there"}, agent.Event{Kind: agent.EvTurnEnd})
	bad := e.create(model.Claude, gOne, "")
	// items.jsonl that cannot be read at all.
	if err := os.Mkdir(filepath.Join(e.st.P.ChatDir(bad.ID), "items.jsonl"), 0o700); err != nil {
		t.Fatal(err)
	}

	e.boot() // must not fail on the bad chat
	if len(e.m.Views()) != 2 {
		t.Fatalf("views %d", len(e.m.Views()))
	}
	if _, _, _, err := e.m.Items(bad.ID); err == nil {
		t.Fatal("Items on an unreadable items.jsonl succeeded")
	}
	if v := e.view(bad.ID); v.Status != model.StatusError || v.Error == "" {
		t.Fatalf("bad chat view %+v", v)
	}

	items := e.items(good.ID)
	if len(items) != 3 || items[0].Text != "hello" || items[1].Text != "hi there" || items[2].Kind != "end" {
		t.Fatalf("items %+v", items)
	}
	if err := os.Remove(filepath.Join(e.st.P.ChatDir(good.ID), "items.jsonl")); err != nil {
		t.Fatal(err)
	}
	if again := e.items(good.ID); !reflect.DeepEqual(again, items) {
		t.Fatalf("second Items read the disk again: %+v", again)
	}
}

func TestInterruptedAtBoot(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	sid := e.meta(v.ID).SessionID
	e.send(v.ID, "long job", "")
	e.m.Shutdown() // mid-turn
	if !e.meta(v.ID).TurnActive {
		t.Fatal("turnActive not kept through shutdown")
	}

	e.boot()
	if st := e.view(v.ID).Status; st != model.StatusStopped {
		t.Fatalf("status before Items %q", st)
	}
	e.m.Shutdown()
	e.boot() // restart before the history was read
	if st := e.view(v.ID).Status; st != model.StatusStopped || !e.meta(v.ID).TurnActive {
		t.Fatalf("second boot: status %q, chat.json %+v", st, e.meta(v.ID))
	}

	countNotes := func(items []model.Item) int {
		n := 0
		for _, it := range items {
			if it.Kind == "note" && strings.HasPrefix(it.Text, "Stopped: the app was closed") {
				n++
			}
		}
		return n
	}
	if n := countNotes(e.items(v.ID)); n != 1 {
		t.Fatalf("%d notes after first Items", n)
	}
	if n := countNotes(e.items(v.ID)); n != 1 {
		t.Fatalf("%d notes after second Items", n)
	}
	if e.meta(v.ID).TurnActive {
		t.Fatal("turnActive still set on disk")
	}
	if st := e.view(v.ID).Status; st != model.StatusStopped {
		t.Fatalf("status after Items %q", st)
	}
	e.boot()
	if n := countNotes(e.items(v.ID)); n != 1 {
		t.Fatalf("%d notes after reboot", n)
	}
	e.send(v.ID, "go on", "")
	if o := e.claude.last(t).opts; !o.Resume || o.SessionID != sid {
		t.Fatalf("resume %+v", o)
	}
}

func TestMissingFolderFix(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{gOne: {Cwd: dir}}})
	v := e.create(model.Claude, gOne, "")
	sid := e.meta(v.ID).SessionID
	e.send(v.ID, "one", "")
	e.claude.last(t).emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.m.Shutdown()
	os.RemoveAll(dir)

	e.boot()
	if err := e.m.Send(v.ID, "two", "", nil); !errors.Is(err, ErrFolderMissing) {
		t.Fatalf("Send with folder gone: %v", err)
	}
	got := e.view(v.ID)
	if got.Status != model.StatusError || !got.FolderMissing {
		t.Fatalf("view %+v", got)
	}
	if err := e.m.Configure(v.ID, ConfigReq{Model: "opus", Cwd: t.TempDir()}); !errors.Is(err, ErrLocked) {
		t.Fatalf("Configure with a model on a locked chat: %v", err)
	}
	newDir := t.TempDir()
	evs := listen(t, e.br)
	evs.drain(t, e.br)
	if err := e.m.Configure(v.ID, ConfigReq{Cwd: newDir}); err != nil {
		t.Fatal(err)
	}
	got = e.view(v.ID)
	if got.FolderMissing || got.Error != "" || got.Status != model.StatusReady || got.Cwd != newDir {
		t.Fatalf("view after fix %+v", got)
	}
	if sent := evs.drain(t, e.br); len(sent) != 2 || len(ofType(sent, "chat")) != 1 || len(ofType(sent, "defaults")) != 1 {
		t.Fatalf("events of the fix %+v", sent)
	}
	e.send(v.ID, "two", "")
	if o := e.claude.last(t).opts; !o.Resume || o.SessionID != sid || o.Cwd != newDir {
		t.Fatalf("spawn after fix %+v", o)
	}
}

func TestStopDeniesPendingPermission(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "delete it", "")
	a := e.claude.last(t)
	a.emit(t, agent.Event{Kind: agent.EvPermRequest, PermID: "r1", ToolName: "Bash", ToolID: "t1"})
	if st := e.view(v.ID).Status; st != model.StatusApproval {
		t.Fatalf("status %q", st)
	}
	e.m.Stop(v.ID)
	a.mu.Lock()
	decides, closed, ints := a.decides, a.closed, a.interrupts
	a.mu.Unlock()
	if !reflect.DeepEqual(decides, []decision{{"r1", false}}) || !closed || ints != 1 {
		t.Fatalf("agent after Stop: decides %v closed %v interrupts %d", decides, closed, ints)
	}
	if e.meta(v.ID).TurnActive {
		t.Fatal("turnActive not cleared")
	}
	if st := e.view(v.ID).Status; st != model.StatusReady {
		t.Fatalf("status after Stop %q", st)
	}
	items := e.items(v.ID)
	var perm, note bool
	for _, it := range items {
		perm = perm || (it.Kind == "perm" && it.Decided == "deny")
		note = note || (it.Kind == "note" && it.Text == "Stopped.")
	}
	if !perm || !note {
		t.Fatalf("items %+v", items)
	}
	// The next Send resumes a new process.
	e.send(v.ID, "again", "")
	if e.claude.count() != 2 || !e.claude.last(t).opts.Resume {
		t.Fatal("Send after Stop did not resume")
	}
}

func TestDelete(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "x", "")
	if err := e.m.Delete(v.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(e.st.P.ChatDir(v.ID)); !os.IsNotExist(err) {
		t.Fatalf("chat folder still there: %v", err)
	}
	evs.wait(t, func(ev map[string]any) bool { return ev["type"] == "chat_removed" && ev["id"] == v.ID })
	if _, err := e.m.View(v.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("View after Delete: %v", err)
	}
	a := e.claude.last(t)
	a.mu.Lock()
	closed := a.closed
	a.mu.Unlock()
	if !closed {
		t.Fatal("agent not closed")
	}
}

func TestUsageTurns(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "one", "")
	a := e.claude.last(t)
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.send(v.ID, "two", "")
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	u := e.view(v.ID).Usage
	if u.Turns != 2 || e.meta(v.ID).TurnActive {
		t.Fatalf("usage %+v", u)
	}
	if e.meta(v.ID).Usage != u {
		t.Fatalf("chat.json usage %+v", e.meta(v.ID).Usage)
	}
}

func TestUsageCtxError(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Cursor, gOne, "")
	e.send(v.ID, "one", "")
	a := e.cursor.last(t)
	a.emit(t, agent.Event{Kind: agent.EvUsage, CtxIn: 100, CtxWindow: 1000})
	a.emit(t, agent.Event{Kind: agent.EvUsage, CtxError: "sqlite3 not found"})
	u := e.view(v.ID).Usage
	if u.CtxError != "sqlite3 not found" || u.CtxIn != 100 || u.CtxWindow != 1000 {
		t.Fatalf("usage after error %+v", u)
	}
	a.emit(t, agent.Event{Kind: agent.EvUsage, CtxIn: 200})
	u = e.view(v.ID).Usage
	if u.CtxError != "" || u.CtxIn != 200 || u.CtxWindow != 1000 {
		t.Fatalf("usage after good read %+v", u)
	}
}

func TestOldGenerationIgnored(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "one", "")
	old := e.claude.last(t)
	e.m.Stop(v.ID)
	n := len(e.items(v.ID))
	old.emit(t, agent.Event{Kind: agent.EvText, Text: "late"}, agent.Event{Kind: agent.EvTurnEnd})
	if got := len(e.items(v.ID)); got != n {
		t.Fatalf("stale event added items: %d → %d", n, got)
	}
	if u := e.view(v.ID).Usage; u.Turns != 0 {
		t.Fatalf("stale event changed usage %+v", u)
	}
}

func TestCleanTitle(t *testing.T) {
	for in, want := range map[string]string{
		"Title: Draw a flowchart\nmore": "Draw a flowchart",
		`"Sketch the API"`:              "Sketch the API",
		"  plain  ":                     "plain",
	} {
		if got := CleanTitle(in); got != want {
			t.Errorf("CleanTitle(%q) = %q, want %q", in, got, want)
		}
	}
}

// ---- subagents ------------------------------------------------------------

// subStart creates a Claude chat mid-turn whose thread has the Agent tool call t1.
func (e *env) subStart() (string, *fakeAgent) {
	e.t.Helper()
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "count the files", "")
	e.m.naming.Wait() // the auto namer's rename is broadcast before the test listens for messages
	a := e.claude.last(e.t)
	a.emit(e.t, agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Agent"})
	return v.ID, a
}

// subRun emits the first event of the subagent started by tool call tool.
func subRun(t *testing.T, a *fakeAgent, tool string) {
	t.Helper()
	a.emit(t, agent.Event{Kind: agent.EvSub, Sub: tool,
		SubInfo: &agent.SubInfo{Status: model.SubRunning, Description: "count files"}})
}

// subs returns the chat's subagents, as Items does.
func (e *env) subs(id string) []model.Subagent {
	e.t.Helper()
	_, _, subs, err := e.m.Items(id)
	if err != nil {
		e.t.Fatal(err)
	}
	return subs
}

// onlySub returns the sid of the chat's only subagent.
func (e *env) onlySub(id string) string {
	e.t.Helper()
	subs := e.subs(id)
	if len(subs) != 1 {
		e.t.Fatalf("subagents %+v", subs)
	}
	return subs[0].ID
}

func (e *env) subDir(chat, sid string) string {
	return filepath.Join(e.st.P.ChatDir(chat), "subagents", sid)
}

// subFile reads subagents/<sid>/subagent.json.
func (e *env) subFile(chat, sid string) model.Subagent {
	e.t.Helper()
	raw, err := os.ReadFile(filepath.Join(e.subDir(chat, sid), "subagent.json"))
	if err != nil {
		e.t.Fatal(err)
	}
	var sa model.Subagent
	if err := json.Unmarshal(raw, &sa); err != nil {
		e.t.Fatal(err)
	}
	return sa
}

// diskItems reads an items.jsonl with the transcript's own reader.
func diskItems(t *testing.T, path string) []model.Item {
	t.Helper()
	tr, err := transcript.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	_, items := tr.Snapshot()
	return items
}

// subOf decodes the subagent of a "sub" message.
func subOf(t *testing.T, ev map[string]any) model.Subagent {
	t.Helper()
	raw, _ := json.Marshal(ev["subagent"])
	var sa model.Subagent
	if err := json.Unmarshal(raw, &sa); err != nil {
		t.Fatal(err)
	}
	return sa
}

// updatesOf decodes the updates of a chat_items or sub_items message.
func updatesOf(t *testing.T, ev map[string]any) []transcript.Update {
	t.Helper()
	raw, _ := json.Marshal(ev["updates"])
	var ups []transcript.Update
	if err := json.Unmarshal(raw, &ups); err != nil {
		t.Fatal(err)
	}
	return ups
}

func TestSubagentCreatedOnFirstEvent(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	id, a := e.subStart()
	evs.drain(t, e.br)
	subRun(t, a, "t1")
	got := evs.drain(t, e.br)
	sid := e.onlySub(id)

	ci := ofType(got, "chat_items")
	if len(ci) != 1 {
		t.Fatalf("chat_items %v", ci)
	}
	if ups := updatesOf(t, ci[0]); len(ups) != 1 || ups[0].Item.ToolID != "t1" || ups[0].Item.Subagent != sid {
		t.Fatalf("link update %+v", ups)
	}
	sm := ofType(got, "sub")
	if len(sm) != 1 || sm[0]["chat"] != id {
		t.Fatalf("sub messages %v", sm)
	}
	want := model.Subagent{ID: sid, Tool: "t1", Description: "count files", Status: model.SubRunning, Started: testNow}
	if sa := subOf(t, sm[0]); sa != want {
		t.Fatalf("sub %+v", sa)
	}
	if sa := e.subFile(id, sid); sa != want {
		t.Fatalf("subagent.json %+v", sa)
	}
	items := diskItems(t, filepath.Join(e.st.P.ChatDir(id), "items.jsonl"))
	var linked bool
	for _, it := range items {
		linked = linked || (it.Kind == "tool" && it.ToolID == "t1" && it.Subagent == sid)
	}
	if !linked {
		t.Fatalf("chat items.jsonl %+v", items)
	}
}

func TestSubagentThread(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	id, a := e.subStart()
	subRun(t, a, "t1")
	sid := e.onlySub(id)
	n, before := len(e.items(id)), e.view(id)
	evs.drain(t, e.br)
	a.emit(t,
		agent.Event{Kind: agent.EvText, Sub: "t1", Text: "looking"},
		agent.Event{Kind: agent.EvToolStart, Sub: "t1", ToolID: "s1", ToolName: "Bash"},
		agent.Event{Kind: agent.EvToolResult, Sub: "t1", ToolID: "s1", Result: "3"})
	got := evs.drain(t, e.br)
	if len(ofType(got, "sub_items")) == 0 || len(ofType(got, "chat_items")) != 0 || len(ofType(got, "chat")) != 0 {
		t.Fatalf("messages %v", got)
	}
	for _, ev := range ofType(got, "sub_items") {
		if ev["sub"] != sid || ev["chat"] != id {
			t.Fatalf("sub_items %v", ev)
		}
	}
	if len(e.items(id)) != n || e.view(id) != before {
		t.Fatalf("the parent changed: %d items, view %+v", len(e.items(id)), e.view(id))
	}
	items := diskItems(t, filepath.Join(e.subDir(id, sid), "items.jsonl"))
	if len(items) != 2 || items[0].Text != "looking" || items[1].ToolID != "s1" ||
		items[1].Result == nil || *items[1].Result != "3" {
		t.Fatalf("subagent items.jsonl %+v", items)
	}
}

func TestSubagentEnd(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	id, a := e.subStart()
	subRun(t, a, "t1")
	sid := e.onlySub(id)
	a.emit(t, agent.Event{Kind: agent.EvTextDelta, Sub: "t1", Text: "42 files"})
	evs.drain(t, e.br)
	e.clock.Store(testNow + 5000)
	a.emit(t, agent.Event{Kind: agent.EvSub, Sub: "t1", SubInfo: &agent.SubInfo{Status: model.SubCompleted, Summary: "found 42"}})
	got := evs.drain(t, e.br)

	si := ofType(got, "sub_items")
	if len(si) != 1 {
		t.Fatalf("sub_items %v", si)
	}
	if ups := updatesOf(t, si[0]); len(ups) != 1 || !ups[0].Item.Done || ups[0].Item.Text != "42 files" {
		t.Fatalf("close update %+v", ups)
	}
	sm := ofType(got, "sub")
	if len(sm) != 1 {
		t.Fatalf("sub messages %v", sm)
	}
	sa := subOf(t, sm[0])
	if sa.Status != model.SubCompleted || sa.Last != "42 files" || sa.Summary != "found 42" ||
		sa.Ended != testNow+5000 || sa.Started != testNow {
		t.Fatalf("sub %+v", sa)
	}
	if f := e.subFile(id, sid); f != sa {
		t.Fatalf("subagent.json %+v", f)
	}

	// Late lines change nothing; a late usage read applies; a late status does not.
	a.emit(t, agent.Event{Kind: agent.EvText, Sub: "t1", Text: "late"})
	if got := evs.drain(t, e.br); len(ofType(got, "sub")) != 0 || len(ofType(got, "sub_items")) != 0 {
		t.Fatalf("late text sent %v", got)
	}
	a.emit(t, agent.Event{Kind: agent.EvSub, Sub: "t1", SubInfo: &agent.SubInfo{Tokens: 900}})
	if sm := ofType(evs.drain(t, e.br), "sub"); len(sm) != 1 || subOf(t, sm[0]).Tokens != 900 {
		t.Fatalf("tokens %v", sm)
	}
	a.emit(t, agent.Event{Kind: agent.EvSub, Sub: "t1", SubInfo: &agent.SubInfo{Status: model.SubStopped}})
	if s := e.subs(id)[0]; s.Status != model.SubCompleted || s.Tokens != 900 {
		t.Fatalf("after a late stop %+v", s)
	}
	if _, items, err := e.m.SubItems(id, sid); err != nil || len(items) != 1 {
		t.Fatalf("thread %+v %v", items, err)
	}
}

func TestSubagentThinkingSendsNothing(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	_, a := e.subStart()
	subRun(t, a, "t1")
	evs.drain(t, e.br)
	a.emit(t, agent.Event{Kind: agent.EvThinking, Sub: "t1"})
	for _, ev := range evs.drain(t, e.br) {
		if ev["type"] != "snapshot" {
			t.Fatalf("thinking sent %v", ev)
		}
	}
}

func TestSubagentUnknownTool(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	id, a := e.subStart()
	evs.drain(t, e.br)
	a.emit(t,
		agent.Event{Kind: agent.EvSub, Sub: "nope", SubInfo: &agent.SubInfo{Status: model.SubRunning}},
		agent.Event{Kind: agent.EvText, Sub: "nope", Text: "x"})
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("messages %v", got)
	}
	if _, err := os.Stat(filepath.Join(e.st.P.ChatDir(id), "subagents")); !os.IsNotExist(err) {
		t.Fatalf("subagents folder: %v", err)
	}
	if len(e.subs(id)) != 0 {
		t.Fatal("a subagent was made")
	}
}

func TestNestedSubagent(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	id, a := e.subStart()
	subRun(t, a, "t1")
	outer := e.onlySub(id)
	a.emit(t, agent.Event{Kind: agent.EvToolStart, Sub: "t1", ToolID: "t2", ToolName: "Agent"})
	evs.drain(t, e.br)
	e.clock.Store(testNow + 1)
	subRun(t, a, "t2")
	got := evs.drain(t, e.br)

	subs := e.subs(id)
	if len(subs) != 2 || subs[0].ID != outer {
		t.Fatalf("subagents %+v", subs)
	}
	inner := subs[1]
	if inner.Parent != outer || inner.Tool != "t2" {
		t.Fatalf("nested %+v", inner)
	}
	if f := e.subFile(id, inner.ID); f != inner {
		t.Fatalf("nested subagent.json %+v", f)
	}
	if len(ofType(got, "chat_items")) != 0 {
		t.Fatalf("the link went to the chat's thread: %v", got)
	}
	si := ofType(got, "sub_items")
	if len(si) != 1 || si[0]["sub"] != outer {
		t.Fatalf("sub_items %v", si)
	}
	if ups := updatesOf(t, si[0]); len(ups) != 1 || ups[0].Item.ToolID != "t2" || ups[0].Item.Subagent != inner.ID {
		t.Fatalf("link %+v", ups)
	}

	a.emit(t, agent.Event{Kind: agent.EvText, Sub: "t2", Text: "inner work"},
		agent.Event{Kind: agent.EvSub, Sub: "t2", SubInfo: &agent.SubInfo{Status: model.SubCompleted}})
	items := diskItems(t, filepath.Join(e.subDir(id, inner.ID), "items.jsonl"))
	if len(items) != 1 || items[0].Text != "inner work" {
		t.Fatalf("nested items.jsonl %+v", items)
	}
	_, outerItems, err := e.m.SubItems(id, outer)
	if err != nil || len(outerItems) != 1 || outerItems[0].Subagent != inner.ID {
		t.Fatalf("outer thread %+v %v", outerItems, err)
	}
}

func TestSubagentPermission(t *testing.T) {
	e := newEnv(t)
	id, a := e.subStart()
	subRun(t, a, "t1")
	sid := e.onlySub(id)
	a.emit(t, agent.Event{Kind: agent.EvPermRequest, Sub: "t1", PermID: "r1", ToolName: "Bash", ToolID: "s1"})
	items := e.items(id)
	last := items[len(items)-1]
	if last.Kind != "perm" || last.RequestID != "r1" || last.Subagent != sid {
		t.Fatalf("perm item %+v", last)
	}
	if st := e.view(id).Status; st != model.StatusApproval {
		t.Fatalf("status %q", st)
	}
	if _, subItems, _ := e.m.SubItems(id, sid); len(subItems) != 0 {
		t.Fatalf("perm in the subagent's thread %+v", subItems)
	}
}

func TestSubagentPermissionWhileIdle(t *testing.T) {
	e := newEnv(t)
	id, a := e.subStart()
	subRun(t, a, "t1")
	sid := e.onlySub(id)
	// The agent's own request is still open when its turn ends. It is closed there, so it cannot
	// keep the idle chat in approval once the subagent's request is answered.
	a.emit(t, agent.Event{Kind: agent.EvPermRequest, PermID: "r0", ToolName: "Bash", ToolID: "t0"})
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	if p := perms(e.items(id)); len(p) != 1 || p[0].Decided != "deny" {
		t.Fatalf("the agent's own request after its turn ended %+v", p)
	}
	a.emit(t, agent.Event{Kind: agent.EvPermRequest, Sub: "t1", PermID: "r1", ToolName: "Bash", ToolID: "s1"})
	if st := e.view(id).Status; st != model.StatusApproval {
		t.Fatalf("status %q", st)
	}
	if err := e.m.Decide(id, sid, "r1", true); err != nil {
		t.Fatal(err)
	}
	if st := e.view(id).Status; st != model.StatusReady {
		t.Fatalf("status after Decide %q", st)
	}
	if err := e.m.Send(id, "next", "", nil); err != nil {
		t.Fatalf("Send after Decide: %v", err)
	}
}

func TestStopMarksSubagentsStopped(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	id, a := e.subStart()
	subRun(t, a, "t1")
	sid := e.onlySub(id)
	evs.drain(t, e.br)
	e.clock.Store(testNow + 700)
	e.m.Stop(id)
	sm := ofType(evs.drain(t, e.br), "sub")
	if len(sm) != 1 {
		t.Fatalf("sub messages %v", sm)
	}
	if sa := subOf(t, sm[0]); sa.Status != model.SubStopped || sa.Ended != testNow+700 {
		t.Fatalf("sub %+v", sa)
	}
	if f := e.subFile(id, sid); f.Status != model.SubStopped || f.Ended != testNow+700 {
		t.Fatalf("subagent.json %+v", f)
	}
}

func TestSubagentsStoppedOnAbortedTurn(t *testing.T) {
	e := newEnv(t)
	id, a := e.subStart()
	subRun(t, a, "t1")
	sid := e.onlySub(id)
	a.emit(t, agent.Event{Kind: agent.EvTextDelta, Sub: "t1", Text: "half"})
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	if s := e.subs(id)[0]; s.Status != model.SubRunning {
		t.Fatalf("a normal turn end stopped it: %+v", s)
	}
	e.send(id, "stop that", "")
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
	s := e.subs(id)[0]
	if s.Status != model.SubStopped || s.Last != "half" {
		t.Fatalf("after an aborted turn %+v", s)
	}
	if f := e.subFile(id, sid); f.Status != model.SubStopped {
		t.Fatalf("subagent.json %+v", f)
	}
	items := diskItems(t, filepath.Join(e.subDir(id, sid), "items.jsonl"))
	if len(items) != 1 || !items[0].Done || items[0].Text != "half" {
		t.Fatalf("open text not closed: %+v", items)
	}
	e.m.handoffs.Wait()
	if n, rows := len(a.sent()), resultRows(e.items(id)); n != 2 || len(rows) != 0 {
		t.Fatalf("after the aborted turn: %d sends, result rows %v", n, rows)
	}
}

func TestSubagentsStoppedOnExit(t *testing.T) {
	e := newEnv(t)
	id, a := e.subStart()
	subRun(t, a, "t1")
	sid := e.onlySub(id)
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	if st := e.view(id).Status; st != model.StatusReady {
		t.Fatalf("status %q", st)
	}
	a.exit(t)
	if s := e.subs(id)[0]; s.Status != model.SubStopped {
		t.Fatalf("after exit %+v", s)
	}
	if f := e.subFile(id, sid); f.Status != model.SubStopped {
		t.Fatalf("subagent.json %+v", f)
	}
}

func TestLoadStopsRunningSubagents(t *testing.T) {
	e := newEnv(t)
	id, a := e.subStart()
	subRun(t, a, "t1")
	sid := e.onlySub(id)
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.m.Shutdown()
	if f := e.subFile(id, sid); f.Status != model.SubRunning {
		t.Fatalf("subagent.json before boot %+v", f)
	}

	e.boot()
	e.clock.Store(testNow + 9000)
	subs := e.subs(id)
	if len(subs) != 1 || subs[0].Status != model.SubStopped || subs[0].Ended != testNow+9000 {
		t.Fatalf("subagents after boot %+v", subs)
	}
	if f := e.subFile(id, sid); f != subs[0] {
		t.Fatalf("subagent.json after boot %+v", f)
	}
}

func TestShutdownWritesSubagents(t *testing.T) {
	e := newEnv(t)
	id, a := e.subStart()
	subRun(t, a, "t1")
	sid := e.onlySub(id)
	a.emit(t, agent.Event{Kind: agent.EvTextDelta, Sub: "t1", Text: "partial"},
		agent.Event{Kind: agent.EvSub, Sub: "t1", SubInfo: &agent.SubInfo{Tokens: 1234}})
	if f := e.subFile(id, sid); f.Tokens != 0 {
		t.Fatalf("tokens written before a write point: %+v", f)
	}
	e.m.Shutdown()
	if f := e.subFile(id, sid); f.Tokens != 1234 || f.Status != model.SubRunning {
		t.Fatalf("subagent.json after shutdown %+v", f)
	}
	items := diskItems(t, filepath.Join(e.subDir(id, sid), "items.jsonl"))
	if len(items) != 1 || items[0].Text != "partial" {
		t.Fatalf("items.jsonl after shutdown %+v", items)
	}
}

func TestItemsAndSubItems(t *testing.T) {
	e := newEnv(t)
	id, a := e.subStart()
	a.emit(t, agent.Event{Kind: agent.EvToolStart, ToolID: "t2", ToolName: "Agent"})
	e.clock.Store(testNow + 2000)
	subRun(t, a, "t1")
	e.clock.Store(testNow + 1000)
	subRun(t, a, "t2")
	a.emit(t, agent.Event{Kind: agent.EvText, Sub: "t1", Text: "from one"})

	subs := e.subs(id)
	if len(subs) != 2 || subs[0].Tool != "t2" || subs[1].Tool != "t1" {
		t.Fatalf("subagents not sorted by started: %+v", subs)
	}
	v, items, err := e.m.SubItems(id, subs[1].ID)
	if err != nil || v == 0 || len(items) != 1 || items[0].Text != "from one" {
		t.Fatalf("SubItems %d %+v %v", v, items, err)
	}
	if _, items, err := e.m.SubItems(id, subs[0].ID); err != nil || len(items) != 0 {
		t.Fatalf("SubItems of t2 %+v %v", items, err)
	}
	if _, _, err := e.m.SubItems(id, "nope"); !errors.Is(err, ErrNoSubagent) {
		t.Fatalf("unknown sid: %v", err)
	}
	if _, _, err := e.m.SubItems("nope", subs[0].ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown chat: %v", err)
	}

	// After a restart the thread is read from its items.jsonl.
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.m.Shutdown()
	e.boot()
	if _, items, err := e.m.SubItems(id, subs[1].ID); err != nil || len(items) != 1 || items[0].Text != "from one" {
		t.Fatalf("SubItems after boot %+v %v", items, err)
	}
}

func TestUnrequestedTurnSetsTurnActive(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "one", "")
	a := e.claude.last(t)
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	if e.meta(v.ID).TurnActive {
		t.Fatal("turnActive after turn end")
	}
	a.emit(t, agent.Event{Kind: agent.EvThinking})
	if !e.meta(v.ID).TurnActive {
		t.Fatal("an unrequested turn did not set turnActive")
	}
	a.emit(t, agent.Event{Kind: agent.EvText, Text: "the subagent is done"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p2"})
	if e.meta(v.ID).TurnActive {
		t.Fatal("turnActive after the unrequested turn ended")
	}
	// The unrequested turn ends with its own mark, separate from the mark of the turn before.
	items := e.items(v.ID)
	if got := kinds(items); !reflect.DeepEqual(got, []string{"user", "end", "text", "end"}) {
		t.Fatalf("items %+v", items)
	}
	if items[1].Point != "" || items[3].Point != "p2" {
		t.Fatalf("marks %+v, %+v", items[1], items[3])
	}
}

func TestDeleteRemovesSubagents(t *testing.T) {
	e := newEnv(t)
	id, a := e.subStart()
	subRun(t, a, "t1")
	sid := e.onlySub(id)
	if _, err := os.Stat(e.subDir(id, sid)); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Delete(id); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(e.st.P.ChatDir(id)); !os.IsNotExist(err) {
		t.Fatalf("chat folder still there: %v", err)
	}
}

func TestSendReferences(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "plan please", "")
	a := e.claude.last(t)
	a.emit(t, agent.Event{Kind: agent.EvTextStart}, agent.Event{Kind: agent.EvTextDelta, Text: "Own undo in the <ShapeStore>. Retry 3 times."},
		agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Read"}, agent.Event{Kind: agent.EvToolResult, ToolID: "t1", Result: "x"},
		agent.Event{Kind: agent.EvTurnEnd})

	refs := []model.Reference{
		{Quote: "Own undo in the <ShapeStore>", Comment: "Keep it in the canvas & apply.ts.", Item: 1, Start: 0, End: 28},
		{Quote: "Retry 3 times", Item: 1, Start: 30, End: 43},
	}
	if err := e.m.Send(v.ID, "Otherwise go ahead.", "", refs); err != nil {
		t.Fatal(err)
	}
	want := "<reference>\n<quote>Own undo in the &lt;ShapeStore&gt;</quote>\n<comment>Keep it in the canvas &amp; apply.ts.</comment>\n</reference>\n\n" +
		"<reference>\n<quote>Retry 3 times</quote>\n</reference>\n\nOtherwise go ahead."
	if got := texts(a.sent()[1]); !reflect.DeepEqual(got, []string{want}) {
		t.Fatalf("agent got %q", got)
	}
	// Item 3 is the first turn's end mark.
	if it := e.items(v.ID)[4]; it.Kind != "user" || it.Text != "Otherwise go ahead." || !reflect.DeepEqual(it.References, refs) {
		t.Fatalf("user item %+v", it)
	}
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})

	// A message can be quotes alone.
	if err := e.m.Send(v.ID, "", "", refs[1:]); err != nil {
		t.Fatal(err)
	}
	if got := texts(a.sent()[2]); !reflect.DeepEqual(got, []string{"<reference>\n<quote>Retry 3 times</quote>\n</reference>"}) {
		t.Fatalf("agent got %q", got)
	}
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})

	// Empty quotes, missing items and items that aren't a message or a reply (the tool call, an
	// end mark).
	for _, bad := range []model.Reference{{Quote: " ", Item: 1}, {Quote: "x", Item: 9}, {Quote: "x", Item: -1}, {Quote: "x", Item: 2}, {Quote: "x", Item: 3}} {
		if err := e.m.Send(v.ID, "hi", "", []model.Reference{bad}); !errors.Is(err, ErrBadReference) {
			t.Fatalf("Send(%+v): %v", bad, err)
		}
	}
	if n := len(e.items(v.ID)); n != 8 { // three turns, each with its end mark
		t.Fatalf("rejected sends added items: %d", n)
	}

	e.boot()
	if it := e.items(v.ID)[4]; !reflect.DeepEqual(it.References, refs) {
		t.Fatalf("references after restart %+v", it.References)
	}
}

func TestDraftReferences(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	d := model.Draft{References: []model.Reference{{Quote: "q", Comment: "c", Item: 0, Start: 1, End: 2}}} // quotes alone are a draft
	if err := e.m.SetDraft(v.ID, d); err != nil {
		t.Fatal(err)
	}
	e.boot()
	if got := e.view(v.ID).Draft; !reflect.DeepEqual(got, &d) {
		t.Fatalf("draft after restart %+v", got)
	}
	if err := e.m.SetDraft(v.ID, model.Draft{}); err != nil {
		t.Fatal(err)
	}
	if got := e.view(v.ID).Draft; got != nil {
		t.Fatalf("empty draft kept: %+v", got)
	}
}

// ---- end marks ------------------------------------------------------------

func kinds(items []model.Item) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.Kind
	}
	return out
}

// lastItems returns the updates of the last chat_items message among evs.
func lastItems(t *testing.T, evs []map[string]any, chat string) []transcript.Update {
	t.Helper()
	ci := ofType(evs, "chat_items")
	if len(ci) == 0 || ci[len(ci)-1]["chat"] != chat {
		t.Fatalf("chat_items %v", ci)
	}
	return updatesOf(t, ci[len(ci)-1])
}

func TestTurnEndAddsEndMark(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	v := e.create(model.Claude, gOne, "")
	path := filepath.Join(e.st.P.ChatDir(v.ID), "items.jsonl")
	e.send(v.ID, "one", "")
	a := e.claude.last(t)
	a.emit(t, agent.Event{Kind: agent.EvText, Text: "first"})
	evs.drain(t, e.br)

	// No id from the agent: a bare mark.
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	items := e.items(v.ID)
	if got := kinds(items); !reflect.DeepEqual(got, []string{"user", "text", "end"}) {
		t.Fatalf("items %+v", items)
	}
	if raw, _ := json.Marshal(items[2]); string(raw) != `{"kind":"end"}` {
		t.Fatalf("mark %s", raw)
	}
	// The turn end's chat_items message carries the mark.
	if ups := lastItems(t, evs.drain(t, e.br), v.ID); len(ups) != 1 || ups[0].Index != 2 || ups[0].Item.Kind != "end" {
		t.Fatalf("turn end updates %+v", ups)
	}
	if st := e.view(v.ID).Status; st != model.StatusReady {
		t.Fatalf("status %q", st)
	}

	// The agent's id is kept on the mark.
	e.send(v.ID, "two", "")
	a.emit(t, agent.Event{Kind: agent.EvTextStart}, agent.Event{Kind: agent.EvTextDelta, Text: "second"})
	evs.drain(t, e.br)
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
	items = e.items(v.ID)
	if got := kinds(items); !reflect.DeepEqual(got, []string{"user", "text", "end", "user", "text", "end"}) {
		t.Fatalf("items %+v", items)
	}
	if raw, _ := json.Marshal(items[5]); string(raw) != `{"kind":"end","point":"p1"}` {
		t.Fatalf("mark %s", raw)
	}
	// The closed text, then the mark, in one message.
	want := []transcript.Update{{Index: 4, Item: model.Item{Kind: "text", Text: "second", Done: true}},
		{Index: 5, Item: model.Item{Kind: "end", Point: "p1"}}}
	if ups := lastItems(t, evs.drain(t, e.br), v.ID); !reflect.DeepEqual(ups, want) {
		t.Fatalf("turn end updates %+v", ups)
	}

	// Written with the event, and read back after a restart.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `{"i":2,"item":{"kind":"end"}}`) || !strings.Contains(string(raw), `{"i":5,"item":{"kind":"end","point":"p1"}}`) {
		t.Fatalf("items.jsonl:\n%s", raw)
	}
	e.boot()
	if again := e.items(v.ID); !reflect.DeepEqual(again, items) {
		t.Fatalf("items after restart %+v", again)
	}
}

func TestEndMarkFollowsTurnEndNote(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "one", "")
	a := e.claude.last(t)
	evs.drain(t, e.br)

	a.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true, Point: "p1"})
	want := []transcript.Update{{Index: 1, Item: model.Item{Kind: "note", Tone: "muted", Text: "Stopped."}},
		{Index: 2, Item: model.Item{Kind: "end", Point: "p1"}}}
	if ups := lastItems(t, evs.drain(t, e.br), v.ID); !reflect.DeepEqual(ups, want) {
		t.Fatalf("aborted turn end updates %+v", ups)
	}

	e.send(v.ID, "two", "")
	evs.drain(t, e.br)
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "rate limited"})
	want = []transcript.Update{{Index: 4, Item: model.Item{Kind: "note", Tone: "error", Text: "rate limited"}},
		{Index: 5, Item: model.Item{Kind: "end"}}}
	if ups := lastItems(t, evs.drain(t, e.br), v.ID); !reflect.DeepEqual(ups, want) {
		t.Fatalf("failed turn end updates %+v", ups)
	}

	items := e.items(v.ID)
	if got := kinds(items); !reflect.DeepEqual(got, []string{"user", "note", "end", "user", "note", "end"}) {
		t.Fatalf("items %+v", items)
	}
	if disk := diskItems(t, filepath.Join(e.st.P.ChatDir(v.ID), "items.jsonl")); !reflect.DeepEqual(disk, items) {
		t.Fatalf("items.jsonl %+v", disk)
	}
}

// Only a turn-end event of the chat's own thread writes a mark.
func TestNoEndMarkWithoutTurnEnd(t *testing.T) {
	e := newEnv(t)
	noMark := func(what, id string, want ...string) {
		t.Helper()
		items := e.items(id)
		if got := kinds(items); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: items %+v", what, items)
		}
		if disk := diskItems(t, filepath.Join(e.st.P.ChatDir(id), "items.jsonl")); !reflect.DeepEqual(kinds(disk), want) {
			t.Fatalf("%s: items.jsonl %+v", what, disk)
		}
	}

	stopped := e.create(model.Claude, gOne, "")
	e.send(stopped.ID, "one", "")
	e.m.Stop(stopped.ID)
	noMark("Stop", stopped.ID, "user", "note")

	exited := e.create(model.Claude, gOne, "")
	e.send(exited.ID, "one", "")
	e.claude.last(t).exit(t)
	noMark("exit mid-turn", exited.ID, "user", "note")

	closed := e.create(model.Claude, gOne, "")
	e.send(closed.ID, "one", "")
	e.m.Shutdown() // mid-turn
	if disk := diskItems(t, filepath.Join(e.st.P.ChatDir(closed.ID), "items.jsonl")); !reflect.DeepEqual(kinds(disk), []string{"user"}) {
		t.Fatalf("Shutdown: items.jsonl %+v", disk)
	}
	e.boot()
	noMark("boot note", closed.ID, "user", "note")
}

func TestSubagentThreadsHaveNoEndMark(t *testing.T) {
	e := newEnv(t)

	// Native: the subagent's events come through the chat's own process.
	id, a := e.subStart()
	subRun(t, a, "t1")
	native := e.onlySub(id)
	n := len(e.items(id))
	a.emit(t, agent.Event{Kind: agent.EvText, Sub: "t1", Text: "42 files"},
		agent.Event{Kind: agent.EvTurnEnd, Sub: "t1", Point: "sub-point"},
		agent.Event{Kind: agent.EvSub, Sub: "t1", SubInfo: &agent.SubInfo{Status: model.SubCompleted}})
	if got := len(e.items(id)); got != n {
		t.Fatalf("a subagent's turn end changed the chat's thread: %d → %d items", n, got)
	}
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
	items := e.items(id)
	if got := kinds(items); !reflect.DeepEqual(got, []string{"user", "tool", "end"}) || items[2].Point != "p1" {
		t.Fatalf("chat items %+v", items)
	}
	if _, subItems, err := e.m.SubItems(id, native); err != nil || !reflect.DeepEqual(kinds(subItems), []string{"text"}) {
		t.Fatalf("native thread %+v %v", subItems, err)
	}
	if disk := diskItems(t, filepath.Join(e.subDir(id, native), "items.jsonl")); !reflect.DeepEqual(kinds(disk), []string{"text"}) {
		t.Fatalf("native items.jsonl %+v", disk)
	}

	// App-spawned: a process of its own, whose turn end completes it.
	v := e.create(model.Claude, gOne, "")
	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, e.claude.count())
	child.emit(t, agent.Event{Kind: agent.EvText, Text: "done"}, agent.Event{Kind: agent.EvTurnEnd, Point: "child-point"})
	waitFor(t, "the subagent completed", func() bool { return e.sub(v.ID, sa.ID).Status == model.SubCompleted })
	if _, subItems, err := e.m.SubItems(v.ID, sa.ID); err != nil || !reflect.DeepEqual(kinds(subItems), []string{"text"}) {
		t.Fatalf("app-spawned thread %+v %v", subItems, err)
	}
	if disk := diskItems(t, filepath.Join(e.subDir(v.ID, sa.ID), "items.jsonl")); !reflect.DeepEqual(kinds(disk), []string{"text"}) {
		t.Fatalf("app-spawned items.jsonl %+v", disk)
	}
	if items := e.items(v.ID); len(items) != 0 {
		t.Fatalf("the parent of an app-spawned subagent got items %+v", items)
	}
}
