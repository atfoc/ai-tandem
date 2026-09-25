package chats

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/prompts"
	"ai-whiteboard/internal/store"
)

// ---- fakes ----------------------------------------------------------------

type decision struct {
	id    string
	allow bool
}

type fakeAgent struct {
	opts agent.SpawnOptions
	ch   chan agent.Event // unbuffered: a send returns once the pump has taken the event

	mu         sync.Mutex
	sends      [][]agent.ContentBlock
	decides    []decision
	interrupts int
	closed     bool
}

func (a *fakeAgent) Events() <-chan agent.Event { return a.ch }

func (a *fakeAgent) Send(b []agent.ContentBlock) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.sends = append(a.sends, b)
	return nil
}

func (a *fakeAgent) Interrupt() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.interrupts++
	return nil
}

func (a *fakeAgent) Decide(id string, allow bool) error {
	a.mu.Lock()
	defer a.mu.Unlock()
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
}

func (s *fakeSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	if _, err := os.Stat(o.Cwd); err != nil {
		return nil, agent.ErrFolderMissing
	}
	a := &fakeAgent{opts: o, ch: make(chan agent.Event)}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.agents = append(s.agents, a)
	return a, nil
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
	namer  *fakeNamer
	m      *Manager
	cwd    string // DefaultCwd
}

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
	e.boot()
	return e
}

// boot starts a fresh manager on the data folder, as a server restart does.
func (e *env) boot() {
	e.t.Helper()
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
	e.claude, e.cursor, e.namer = &fakeSpawner{}, &fakeSpawner{}, &fakeNamer{}
	e.m = New(Deps{
		Store:      st,
		Bridge:     e.br,
		Boards:     e.bds,
		Spawners:   map[model.AgentKind]agent.Spawner{model.Claude: e.claude, model.Cursor: e.cursor},
		Namer:      e.namer,
		DefaultCwd: e.cwd,
		BaseURL:    "http://127.0.0.1:4747",
	})
	if err := e.m.Load(); err != nil {
		e.t.Fatal(err)
	}
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
	_, items, err := e.m.Items(id)
	if err != nil {
		e.t.Fatal(err)
	}
	return items
}

func (e *env) send(id, text, ctx string) {
	e.t.Helper()
	if err := e.m.Send(id, text, ctx); err != nil {
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
	if m.Agent != model.Claude || m.SessionID == "" || m.Token != "" {
		t.Fatalf("plain chat.json %+v", m)
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

func TestFirstSendSpawnsOnce(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	sid := e.meta(v.ID).SessionID
	e.send(v.ID, "hello", "")
	if e.claude.count() != 1 {
		t.Fatalf("%d spawns", e.claude.count())
	}
	o := e.claude.last(t).opts
	want := agent.SpawnOptions{ChatID: v.ID, SessionID: sid, Resume: false, Cwd: v.Cwd, Model: v.Model, Effort: v.Effort}
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

	// Plain chat: the context is dropped.
	p := e.create(model.Claude, gOne, "")
	e.send(p.ID, "plain", ctx)
	if got := texts(e.claude.last(t).sent()[0]); !reflect.DeepEqual(got, []string{"plain"}) {
		t.Fatalf("plain chat sent %q", got)
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
	if ca.opts.Board == nil || ca.opts.Board.MCPURL != "http://127.0.0.1:4747/mcp/"+tok || ca.opts.Board.Token != tok {
		t.Fatalf("board access %+v", ca.opts.Board)
	}
	if it := e.items(cb.ID)[0]; it.Context != ctx {
		t.Fatalf("board user item context %q", it.Context)
	}

	// Cursor board chat: instructions only the first time.
	ub := e.create(model.Cursor, "", bd.ID)
	e.send(ub.ID, "one", ctx)
	ua := e.cursor.last(t)
	api := "<board-api>http://127.0.0.1:4747/agent/" + e.meta(ub.ID).Token + "</board-api>"
	if got := texts(ua.sent()[0]); !reflect.DeepEqual(got, []string{prompts.CursorInstructions(), api, ctx, "one"}) {
		t.Fatalf("cursor first send %q", got)
	}
	if !e.meta(ub.ID).InstructionsSent {
		t.Fatal("instructionsSent not saved")
	}
	ua.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.send(ub.ID, "two", ctx)
	if got := texts(ua.sent()[1]); !reflect.DeepEqual(got, []string{api, ctx, "two"}) {
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
	if err := e.m.Send(v.ID, "two", ""); !errors.Is(err, ErrBusy) {
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
	if _, _, err := e.m.Items(bad.ID); err == nil {
		t.Fatal("Items on an unreadable items.jsonl succeeded")
	}
	if v := e.view(bad.ID); v.Status != model.StatusError || v.Error == "" {
		t.Fatalf("bad chat view %+v", v)
	}

	items := e.items(good.ID)
	if len(items) != 2 || items[0].Text != "hello" || items[1].Text != "hi there" {
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
	if err := e.m.Send(v.ID, "two", ""); !errors.Is(err, ErrFolderMissing) {
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
	if err := e.m.Configure(v.ID, ConfigReq{Cwd: newDir}); err != nil {
		t.Fatal(err)
	}
	got = e.view(v.ID)
	if got.FolderMissing || got.Error != "" || got.Status != model.StatusReady || got.Cwd != newDir {
		t.Fatalf("view after fix %+v", got)
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
