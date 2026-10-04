package chats

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

// ---- fixtures -------------------------------------------------------------

func (e *env) spawner(a model.AgentKind) *fakeSpawner {
	switch a {
	case model.Cursor:
		return e.cursor
	case model.Pi:
		return e.pi
	}
	return e.claude
}

// turn runs one finished turn on the chat: the message "ask <i>", the reply "reply <i>" and the
// mark's id "p<i>". a is the chat's process, nil when the Send starts it; it is returned.
func (e *env) turn(id string, a *fakeAgent, i int) *fakeAgent {
	e.t.Helper()
	n := strconv.Itoa(i)
	e.send(id, "ask "+n, "")
	if a == nil {
		a = e.spawner(e.meta(id).Agent).last(e.t)
		if a.opts.SessionID == "" { // Cursor reports the id of the session it made
			a.emit(e.t, agent.Event{Kind: agent.EvSession, SessionID: "cur-" + n})
		}
	}
	a.emit(e.t, agent.Event{Kind: agent.EvText, Text: "reply " + n}, agent.Event{Kind: agent.EvTurnEnd, Point: "p" + n})
	return a
}

// talked makes a chat with n finished turns (three items each) and returns its id and process.
func (e *env) talked(kind model.AgentKind, board string, n int) (string, *fakeAgent) {
	e.t.Helper()
	group := gOne
	if board != "" {
		group = ""
	}
	v := e.create(kind, group, board)
	var a *fakeAgent
	for i := 1; i <= n; i++ {
		a = e.turn(v.ID, a, i)
	}
	e.m.naming.Wait() // the auto namer's rename is done: the chat is called "Named title"
	return v.ID, a
}

// stored makes a chat of agent kind holding items, loaded as a restart does.
func (e *env) stored(kind model.AgentKind, items []model.Item) string {
	e.t.Helper()
	v := e.create(kind, gOne, "")
	e.writeItems(v.ID, items)
	e.boot()
	return v.ID
}

// listen connects a client and forgets what it got on connecting.
func (e *env) listen() *events {
	e.t.Helper()
	evs := listen(e.t, e.br)
	evs.drain(e.t, e.br)
	return evs
}

func (e *env) fork(id string, at int) model.ChatView {
	e.t.Helper()
	v, err := e.m.Fork(id, ForkReq{Branch: model.MainBranch, At: at})
	if err != nil {
		e.t.Fatalf("Fork at %d: %v", at, err)
	}
	return v
}

func (e *env) forkErr(id string, at int) error {
	_, err := e.m.Fork(id, ForkReq{Branch: model.MainBranch, At: at})
	return err
}

// chatDirs is the names of the folders under chats/.
func (e *env) chatDirs() []string {
	e.t.Helper()
	ents, err := os.ReadDir(e.st.P.Chats)
	if err != nil {
		e.t.Fatal(err)
	}
	var out []string
	for _, en := range ents {
		out = append(out, en.Name())
	}
	return out
}

func (e *env) listed(id string) bool {
	for _, v := range e.m.Views() {
		if v.ID == id {
			return true
		}
	}
	return false
}

// gone checks that nothing is left of the chat a fork start was asked for: no folder, no map
// entry, no token.
func (e *env) gone(o agent.SpawnOptions) {
	e.t.Helper()
	if _, err := os.Stat(e.st.P.ChatDir(o.ChatID)); !os.IsNotExist(err) {
		e.t.Fatalf("the fork's folder is still there: %v", err)
	}
	if _, err := e.m.get(o.ChatID); !errors.Is(err, ErrNotFound) {
		e.t.Fatalf("the fork's map entry is still there: %v", err)
	}
	if _, ok := e.m.ResolveToken(o.MCP.Token); ok {
		e.t.Fatal("the fork's token still resolves")
	}
	e.m.extrasMu.Lock()
	_, used := e.m.used[o.MCP.Token]
	e.m.extrasMu.Unlock()
	if used {
		e.t.Fatal("the fork's token is still registered")
	}
	if e.listed(o.ChatID) {
		e.t.Fatal("the fork is listed")
	}
}

// namesChat reports whether any of the events names the chat id anywhere.
func namesChat(evs []map[string]any, id string) bool {
	for _, ev := range evs {
		if raw, _ := json.Marshal(ev); strings.Contains(string(raw), id) {
			return true
		}
	}
	return false
}

// blocked is a fork start held open: the spawner's SpawnFork has been called and waits.
type blocked struct {
	e    *env
	sp   *fakeSpawner
	opts agent.SpawnOptions // what the start was called with
	gate chan struct{}

	stop chan struct{}
	wg   sync.WaitGroup
	mu   sync.Mutex
	seen []string // what a client must never have seen, if anything
}

// block makes the next SpawnFork of sp wait, runs f (which leads to that start) in the background
// and returns once the start is running. Until release, it keeps checking that the new chat is
// not listed and has no chat.json. res receives f's error.
func (e *env) block(sp *fakeSpawner, f func() error) (b *blocked, res chan error) {
	e.t.Helper()
	b = &blocked{e: e, sp: sp, gate: make(chan struct{}), stop: make(chan struct{})}
	started := make(chan agent.SpawnOptions, 1)
	sp.set(func(s *fakeSpawner) {
		s.forkGate = b.gate
		s.onFork = func(o agent.SpawnOptions) { started <- o }
	})
	res = make(chan error, 1)
	go func() { res <- f() }()
	select {
	case b.opts = <-started:
	case err := <-res:
		e.t.Fatalf("ended before the fork start: %v", err)
	case <-time.After(5 * time.Second):
		e.t.Fatal("the fork start was not reached")
	}
	return b, res
}

// watch checks, until release, that the chat being started is never listed and never has a
// chat.json: for a fork that is still unlisted.
func (b *blocked) watch() {
	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		for {
			var bad string
			if b.e.listed(b.opts.ChatID) {
				bad = "listed"
			}
			if _, err := os.Stat(filepath.Join(b.e.st.P.ChatDir(b.opts.ChatID), "chat.json")); err == nil {
				bad = "chat.json written"
			}
			if bad != "" {
				b.mu.Lock()
				b.seen = append(b.seen, bad)
				b.mu.Unlock()
			}
			select {
			case <-b.stop:
				return
			default:
				time.Sleep(time.Millisecond)
			}
		}
	}()
}

// release lets the start end, failing with err when it is not nil, and returns what f returned.
func (b *blocked) release(res chan error, err error) error {
	b.e.t.Helper()
	b.sp.set(func(s *fakeSpawner) { s.forkErr, s.forkGate, s.onFork = err, nil, nil })
	close(b.gate)
	var got error
	select {
	case got = <-res:
	case <-time.After(5 * time.Second):
		b.e.t.Fatal("the call did not return")
	}
	close(b.stop)
	b.wg.Wait()
	b.sp.set(func(s *fakeSpawner) { s.forkErr = nil })
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.seen) > 0 {
		b.e.t.Fatalf("while unlisted the chat was: %v", b.seen[0])
	}
	return got
}

// blockFork holds a Fork that is going to fail in its start, watching that the new chat is never
// seen.
func (e *env) blockFork(id string, at int) (*blocked, chan error) {
	e.t.Helper()
	b, res := e.block(e.spawner(e.meta(id).Agent), func() error { return e.forkErr(id, at) })
	b.watch()
	return b, res
}

// ---- the point ------------------------------------------------------------

func TestForkPoints(t *testing.T) {
	cases := []struct {
		name  string
		items []model.Item
		ok    []int // the counts a fork may start at
	}{
		{"two turns", twoTurns(), []int{0, 3, 8}},
		{"first mark without an id", []model.Item{pUser(), pText(), pEnd(""), pUser(), pText(), pEnd("p2")}, []int{6}},
		{"last mark without an id", []model.Item{pUser(), pText(), pEnd("p1"), pUser(), pText(), pEnd("")}, []int{0, 3, 6}},
		{"last turn cut", []model.Item{pUser(), pText(), pEnd("p1"), pUser(), pText()}, []int{0, 3, 5}},
		{"no marks", []model.Item{pUser(), pText(), pUser(), pText()}, []int{4}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			id := e.stored(model.Claude, tc.items)
			for at := -1; at <= len(tc.items)+1; at++ {
				want := false
				for _, ok := range tc.ok {
					want = want || ok == at
				}
				err := e.forkErr(id, at)
				if want && err != nil || !want && !errors.Is(err, ErrBadPoint) {
					t.Errorf("Fork at %d: %v, allowed %v", at, err, want)
				}
			}
			if n := len(e.chatDirs()); n != 1+len(tc.ok) {
				t.Fatalf("%d chat folders after %d forks", n, len(tc.ok))
			}
		})
	}

	// An empty chat has no point.
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	if err := e.forkErr(v.ID, 0); !errors.Is(err, ErrBadPoint) {
		t.Fatalf("Fork of an empty chat: %v", err)
	}
}

func TestForkRefusals(t *testing.T) {
	e := newEnv(t)
	id, a := e.talked(model.Claude, "", 2)

	if err := e.forkErr("nope", 3); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown chat: %v", err)
	}
	if _, err := e.m.Fork("nope", ForkReq{Branch: "b1", At: 3}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown chat and branch: %v", err)
	}
	for _, branch := range []string{"", "b1"} {
		if _, err := e.m.Fork(id, ForkReq{Branch: branch, At: 3}); !errors.Is(err, ErrNoBranch) {
			t.Fatalf("branch %q: %v", branch, err)
		}
	}

	// Busy: also at a point that is fine otherwise.
	e.send(id, "more", "")
	for _, at := range []int{0, 3, 6, 7} {
		if err := e.forkErr(id, at); !errors.Is(err, ErrBusy) {
			t.Fatalf("busy chat at %d: %v", at, err)
		}
	}
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd, Point: "p3"})

	if err := e.m.SetArchive(id, model.Archive{Archived: true}); err != nil {
		t.Fatal(err)
	}
	if err := e.forkErr(id, 3); !errors.Is(err, ErrArchived) {
		t.Fatalf("archived chat: %v", err)
	}
	if err := e.m.SetArchive(id, model.Archive{}); err != nil {
		t.Fatal(err)
	}

	if n := len(e.claude.forkCalls()); n != 0 {
		t.Fatalf("%d fork starts", n)
	}

	// A legacy chat.
	path := filepath.Join(e.st.P.ChatDir(id), "chat.json")
	meta := e.meta(id)
	meta.InstructionsSent = true
	if err := store.WriteJSONAtomic(path, meta, 0o600); err != nil {
		t.Fatal(err)
	}
	e.boot()
	if err := e.forkErr(id, 3); !errors.Is(err, ErrLegacy) {
		t.Fatalf("legacy chat: %v", err)
	}

	if n := len(e.chatDirs()); n != 1 {
		t.Fatalf("%d chat folders", n)
	}
}

func TestForkPiCutTurn(t *testing.T) {
	e := newEnv(t)
	id := e.stored(model.Pi, cutTurn())
	three, five := 3, 5
	for _, msg := range []*int{nil, &three, &five} {
		if _, err := e.m.Fork(id, ForkReq{Branch: model.MainBranch, At: 3, Message: msg}); !errors.Is(err, ErrBadPoint) {
			t.Fatalf("pi fork at 3 past a cut turn (message %v): %v", msg, err)
		}
	}
	if n := len(e.pi.forkCalls()); n != 0 {
		t.Fatalf("%d fork starts", n)
	}
	e.fork(id, 8)
	sid := e.meta(id).SessionID
	if got, want := e.pi.forkCalls()[0].src, (agent.ForkSource{ChatID: id, SessionID: sid, Point: "p3", End: true}); got != want {
		t.Fatalf("pi fork at the end %+v, want %+v", got, want)
	}
	if e.meta(e.pi.forkCalls()[0].opts.ChatID).ForkSource != nil {
		t.Fatal("a pi fork keeps a fork source")
	}

	// The same items in a Claude chat: the mark's id is all it takes.
	e = newEnv(t)
	id = e.stored(model.Claude, cutTurn())
	e.fork(id, 3)
	if _, err := e.m.Fork(id, ForkReq{Branch: model.MainBranch, At: 3, Message: &five}); err != nil {
		t.Fatalf("claude fork and edit past a cut turn: %v", err)
	}
	want := agent.ForkSource{ChatID: id, SessionID: e.meta(id).SessionID, Point: "p1", Next: "p3"}
	for _, call := range e.claude.forkCalls() {
		if call.src != want {
			t.Fatalf("claude fork at 3 %+v, want %+v", call.src, want)
		}
	}

	// pi, the end of turn 1 of three finished turns: forked with the id on turn 2's mark.
	e = newEnv(t)
	id, _ = e.talked(model.Pi, "", 3)
	e.fork(id, 3)
	want = agent.ForkSource{ChatID: id, SessionID: e.meta(id).SessionID, Point: "p1", Next: "p2"}
	if got := e.pi.forkCalls()[0].src; got != want {
		t.Fatalf("pi fork at the end of turn 1 %+v, want %+v", got, want)
	}
}

func TestForkAtEndWithoutMarks(t *testing.T) {
	e := newEnv(t)
	id := e.stored(model.Claude, []model.Item{pUser(), pText()})
	if err := e.forkErr(id, 1); !errors.Is(err, ErrBadPoint) {
		t.Fatalf("Fork inside an older chat: %v", err)
	}
	v := e.fork(id, 2)
	want := agent.ForkSource{ChatID: id, SessionID: e.meta(id).SessionID, End: true}
	if got := e.claude.forkCalls()[0].src; got != want {
		t.Fatalf("fork source %+v, want %+v", got, want)
	}
	if m := e.meta(v.ID); !m.Locked || m.Usage.Turns != 1 {
		t.Fatalf("fork of an older chat %+v", m)
	}
}

// ---- the new chat ---------------------------------------------------------

func TestForkNewChat(t *testing.T) {
	e := newEnv(t)
	// Turn 1 starts a subagent; then two plain turns.
	id, a := e.subStart()
	subRun(t, a, "t1")
	sub := e.onlySub(id)
	a.emit(t,
		agent.Event{Kind: agent.EvText, Sub: "t1", Text: "counting"},
		agent.Event{Kind: agent.EvSub, Sub: "t1", SubInfo: &agent.SubInfo{Status: model.SubCompleted}},
		agent.Event{Kind: agent.EvToolResult, ToolID: "t1", Result: "42 files"},
		agent.Event{Kind: agent.EvText, Text: "There are 42."},
		agent.Event{Kind: agent.EvUsage, CtxIn: 100, CtxOut: 10, CtxWindow: 1000},
		agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
	e.turn(id, a, 2)
	e.turn(id, a, 3)
	const at = 4 // user, tool, text, end
	srcItems, srcMeta, srcView := e.items(id), e.meta(id), e.view(id)
	srcFiles := folder(t, e.st.P.ChatDir(id), false)
	if len(srcItems) != 10 || srcItems[at-1].Point != "p1" || srcItems[1].Subagent != sub {
		t.Fatalf("source items %+v", srcItems)
	}

	evs := e.listen()
	v := e.fork(id, at)
	got := evs.drain(t, e.br)

	// One chat event, for the new chat; nothing for the source.
	if len(got) != 1 || got[0]["type"] != "chat" || got[0]["chat"].(map[string]any)["id"] != v.ID {
		t.Fatalf("events %+v", got)
	}
	if !reflect.DeepEqual(asJSON(t, got[0]["chat"]), asJSON(t, v)) {
		t.Fatalf("the event's view %+v, the answer %+v", got[0]["chat"], v)
	}
	if !e.listed(v.ID) || e.view(v.ID) != v {
		t.Fatalf("the fork is not listed as answered: %+v", e.view(v.ID))
	}
	want := model.ChatView{ID: v.ID, Agent: model.Claude, Name: "Named title (fork)", Group: gOne,
		Cwd: srcView.Cwd, Model: srcView.Model, Effort: srcView.Effort, Locked: true, Created: v.Created,
		Usage: model.Usage{CtxWindow: 1000, Turns: 1}, Status: model.StatusReady,
		ForkedFrom: id, ForkedFromTitle: "Named title"}
	if v != want {
		t.Fatalf("view %+v\nwant %+v", v, want)
	}
	if !v.Created.After(srcView.Created) {
		t.Fatalf("created %v, the source %v", v.Created, srcView.Created)
	}

	// Its items are the source's first four, under the same indexes; the subagent came along.
	if items := e.items(v.ID); !reflect.DeepEqual(items, srcItems[:at]) {
		t.Fatalf("items %+v", items)
	}
	if !reflect.DeepEqual(lineIndexes(t, folder(t, e.st.P.ChatDir(v.ID), true)["items.jsonl"]), []int{0, 1, 2, 3}) {
		t.Fatal("items.jsonl of the fork")
	}
	if subs := e.subs(v.ID); len(subs) != 1 || subs[0].ID != sub || subs[0].Status != model.SubCompleted {
		t.Fatalf("subagents of the fork %+v", subs)
	}
	if _, items, err := e.m.SubItems(v.ID, sub); err != nil || len(items) != 1 || items[0].Text != "counting" {
		t.Fatalf("the subagent's thread in the fork: %+v, %v", items, err)
	}

	// chat.json: built, not copied.
	m := e.meta(v.ID)
	if m.Token == "" || m.Token == srcMeta.Token || m.SessionID == "" || m.SessionID == srcMeta.SessionID {
		t.Fatalf("token or session id not its own: %+v", m)
	}
	if m.TurnActive || m.Archived || m.Draft != nil || m.ContextSplit != nil || m.UserNamed || m.McpInstructionsSent {
		t.Fatalf("chat.json %+v", m)
	}
	if c, ok := e.m.ResolveToken(m.Token); !ok || c.Meta.ID != v.ID {
		t.Fatalf("the fork's token resolves to %+v, %v", c.Meta.ID, ok)
	}

	// The fork start: the source's session at the mark's id, as the new chat.
	calls := e.claude.forkCalls()
	if len(calls) != 1 {
		t.Fatalf("%d fork starts", len(calls))
	}
	if want := (agent.ForkSource{ChatID: id, SessionID: srcMeta.SessionID, Point: "p1", Next: "p2"}); calls[0].src != want {
		t.Fatalf("fork source %+v, want %+v", calls[0].src, want)
	}
	wantOpts := agent.SpawnOptions{ChatID: v.ID, SessionID: m.SessionID, Resume: true, Cwd: v.Cwd, Model: v.Model,
		Effort: v.Effort, MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: m.Token}}
	if !reflect.DeepEqual(calls[0].opts, wantOpts) {
		t.Fatalf("fork options %+v, want %+v", calls[0].opts, wantOpts)
	}
	if len(e.claude.discarded()) != 0 {
		t.Fatalf("discarded %v", e.claude.discarded())
	}

	// The source: nothing changed.
	if !reflect.DeepEqual(e.items(id), srcItems) || e.view(id) != srcView || !reflect.DeepEqual(e.meta(id), srcMeta) {
		t.Fatal("the source changed")
	}
	if after := folder(t, e.st.P.ChatDir(id), false); !reflect.DeepEqual(after, srcFiles) {
		t.Fatalf("the source's files changed: %v", names(after))
	}
	if a.isClosed() {
		t.Fatal("the source's process was closed")
	}

	// The fork's first Send goes to the confirmed process: no other is started.
	if e.claude.count() != 1 {
		t.Fatalf("%d spawns before the Send", e.claude.count())
	}
	e.send(v.ID, "carry on", "")
	fa := e.claude.lastFork(t)
	if e.claude.count() != 1 || len(e.claude.forkCalls()) != 1 {
		t.Fatalf("%d spawns, %d fork starts after the Send", e.claude.count(), len(e.claude.forkCalls()))
	}
	if sent := fa.sent(); len(sent) != 1 || !reflect.DeepEqual(texts(sent[0]), []string{"carry on"}) {
		t.Fatalf("the fork's process got %v", sent)
	}
	if len(a.sent()) != 3 {
		t.Fatalf("the source's process got %d messages", len(a.sent()))
	}
	fa.emit(t, agent.Event{Kind: agent.EvText, Text: "sure"}, agent.Event{Kind: agent.EvTurnEnd, Point: "f1"})
	if got := kinds(e.items(v.ID)); !reflect.DeepEqual(got, []string{"user", "tool", "text", "end", "user", "text", "end"}) {
		t.Fatalf("the fork's items %v", got)
	}
	if len(e.namer.callList()) != 1 {
		t.Fatalf("the namer ran for the fork: %v", e.namer.callList())
	}

	// A fork at the end keeps the last turn's context numbers.
	end := e.fork(id, len(srcItems))
	if want := (model.Usage{CtxIn: 100, CtxOut: 10, CtxWindow: 1000, Turns: 3}); end.Usage != want {
		t.Fatalf("usage of a fork at the end %+v", end.Usage)
	}
	if got, want := e.claude.forkCalls()[1].src, (agent.ForkSource{ChatID: id, SessionID: srcMeta.SessionID, Point: "p3", End: true}); got != want {
		t.Fatalf("fork source at the end %+v, want %+v", got, want)
	}
}

func TestForkBoardChat(t *testing.T) {
	e := newEnv(t)
	bd, err := e.bds.Create("board", gTwo, false)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := e.talked(model.Cursor, bd.ID, 2)
	src := e.meta(id)
	if !src.McpInstructionsSent || src.SessionID != "cur-1" {
		t.Fatalf("source %+v", src)
	}
	v := e.fork(id, 3)
	if v.Board != bd.ID || v.Group != "" || !v.Locked || e.m.GroupOf(e.meta(v.ID)) != gTwo {
		t.Fatalf("view %+v", v)
	}
	found := false
	for _, m := range e.m.ChatsOfBoard(bd.ID) {
		found = found || m.ID == v.ID
	}
	if !found {
		t.Fatal("the fork is not among the board's chats")
	}

	// Cursor: the session id is the adapter's; the fork is durable at once, so no source is kept.
	// The forked session holds the whiteboard instructions already.
	call := e.cursor.forkCalls()[0]
	if want := (agent.ForkSource{ChatID: id, SessionID: "cur-1", Point: "p1", Next: "p2"}); call.src != want {
		t.Fatalf("fork source %+v, want %+v", call.src, want)
	}
	if call.opts.SessionID != "" || call.opts.BoardID != bd.ID || !call.opts.Resume {
		t.Fatalf("fork options %+v", call.opts)
	}
	if m := e.meta(v.ID); m.SessionID != "forked-1" || m.ForkSource != nil || !m.McpInstructionsSent {
		t.Fatalf("chat.json of a Cursor fork %+v", m)
	}

	// At the start: a fresh session, which gets the instructions again.
	zero := 0
	first, err := e.m.Fork(id, ForkReq{Branch: model.MainBranch, At: 0, Message: &zero})
	if err != nil {
		t.Fatal(err)
	}
	if m := e.meta(first.ID); m.SessionID != "" || m.McpInstructionsSent || m.Locked || m.Board != bd.ID {
		t.Fatalf("chat.json of a Cursor fork at the start %+v", m)
	}

	// The board must exist and not be archived, as for a new chat.
	if err := e.bds.SetArchive(bd.ID, model.Archive{Archived: true}); err != nil {
		t.Fatal(err)
	}
	if err := e.forkErr(id, 3); !errors.Is(err, boards.ErrArchived) {
		t.Fatalf("Fork on an archived board: %v", err)
	}
	if n := len(e.cursor.forkCalls()); n != 1 {
		t.Fatalf("%d fork starts", n)
	}
}

func TestForkTitle(t *testing.T) {
	long := "  Please look at <selection label=\"a &amp; b\">x</selection>\nand tell me what you think about it  "
	for _, tc := range []struct {
		name  string
		items []model.Item
		want  string
	}{
		{"Given", []model.Item{{Kind: "user", Text: "hello"}}, "Given"},
		{"", nil, "New chat"},
		{"", []model.Item{{Kind: "note", Text: "n"}, {Kind: "user", Text: "  two\n words "}, {Kind: "user", Text: "later"}}, "two words"},
		{"", []model.Item{{Kind: "user", Text: long}}, "Please look at [a & b] and tell me what …"},
		{"", []model.Item{{Kind: "user", Text: strings.Repeat("é", 42)}}, strings.Repeat("é", 42)},
		{"", []model.Item{{Kind: "user", Text: strings.Repeat("é", 43)}}, strings.Repeat("é", 40) + "…"},
		{"", []model.Item{{Kind: "user", Text: " \n"}}, "New chat"},
	} {
		if got := titleOf(model.ChatMeta{Name: tc.name}, tc.items); got != tc.want {
			t.Errorf("titleOf(%q, %+v) = %q, want %q", tc.name, tc.items, got, tc.want)
		}
	}

	// An unnamed chat: the fork is named after the source's first message.
	e := newEnv(t)
	delete(e.m.Namers, model.Claude)
	id, _ := e.talked(model.Claude, "", 1)
	v := e.fork(id, 3)
	if v.Name != "ask 1 (fork)" || v.ForkedFromTitle != "ask 1" || v.UserNamed {
		t.Fatalf("fork of an unnamed chat %+v", v)
	}
}

func TestForkAndEdit(t *testing.T) {
	e := newEnv(t)
	items := cutTurn()
	items[5].Text = "the message"
	items[5].References = []model.Reference{
		{Quote: "t", Comment: "why", Item: 1, Start: 0, End: 1},
		{Quote: "u", Item: 3, Start: 0, End: 1}, // the cut turn's message: not in the copy
		{Quote: "u", Item: 0, Start: 0, End: 1},
	}
	id := e.stored(model.Claude, items)

	// Not a user item, or not the message right after the point.
	for _, tc := range []struct{ at, msg int }{{3, 1}, {3, 2}, {3, 0}, {0, 3}, {0, 5}, {8, 5}, {3, 99}, {3, -1}, {8, 8}} {
		msg := tc.msg
		if _, err := e.m.Fork(id, ForkReq{Branch: model.MainBranch, At: tc.at, Message: &msg}); !errors.Is(err, ErrBadPoint) {
			t.Fatalf("Fork at %d with message %d: %v", tc.at, tc.msg, err)
		}
	}
	if n := len(e.chatDirs()); n != 1 {
		t.Fatalf("%d chat folders", n)
	}

	five := 5
	v, err := e.m.Fork(id, ForkReq{Branch: model.MainBranch, At: 3, Message: &five})
	if err != nil {
		t.Fatal(err)
	}
	// The copy stops at the mark before the message; the message and its quotes are the draft.
	if got := e.items(v.ID); !reflect.DeepEqual(got, items[:3]) {
		t.Fatalf("items %+v", got)
	}
	want := &model.Draft{Text: "the message", References: []model.Reference{items[5].References[0], items[5].References[2]}}
	if !reflect.DeepEqual(e.meta(v.ID).Draft, want) || !reflect.DeepEqual(e.view(v.ID).Draft, want) {
		t.Fatalf("draft %+v", e.meta(v.ID).Draft)
	}
	if !v.Locked || e.claude.forkCalls()[0].src.Point != "p1" {
		t.Fatalf("view %+v, fork %+v", v, e.claude.forkCalls()[0].src)
	}
	if e.meta(id).Draft != nil {
		t.Fatal("the source got a draft")
	}
}

func TestForkAndEditFirstMessage(t *testing.T) {
	e := newEnv(t)
	evs := e.listen()
	v0 := e.create(model.Claude, gTwo, "")
	dir := t.TempDir()
	if err := e.m.Configure(v0.ID, ConfigReq{Cwd: dir, Model: "opus", Effort: "low"}); err != nil {
		t.Fatal(err)
	}
	id := v0.ID
	a := e.turn(id, nil, 1)
	e.turn(id, a, 2)
	e.m.naming.Wait()
	src := e.meta(id)
	evs.drain(t, e.br)

	zero := 0
	v, err := e.m.Fork(id, ForkReq{Branch: model.MainBranch, At: 0, Message: &zero})
	if err != nil {
		t.Fatal(err)
	}
	want := model.ChatView{ID: v.ID, Agent: model.Claude, Name: "Named title (fork)", Group: gTwo, Cwd: dir,
		Model: "opus", Effort: "low", Created: v.Created, Usage: model.Usage{CtxWindow: src.Usage.CtxWindow},
		Draft: &model.Draft{Text: "ask 1"}, Status: model.StatusReady, ForkedFrom: id, ForkedFromTitle: "Named title"}
	if !reflect.DeepEqual(v, want) {
		t.Fatalf("view %+v\nwant %+v", v, want)
	}
	if got := evs.drain(t, e.br); len(got) != 1 || got[0]["type"] != "chat" || got[0]["chat"].(map[string]any)["id"] != v.ID {
		t.Fatalf("events %+v", got)
	}
	m := e.meta(v.ID)
	if m.SessionID == "" || m.SessionID == src.SessionID || m.ForkSource != nil || m.Token == "" || m.Token == src.Token {
		t.Fatalf("chat.json %+v", m)
	}
	if items := e.items(v.ID); len(items) != 0 {
		t.Fatalf("items %+v", items)
	}
	// Nothing was forked and no process runs.
	if len(e.claude.forkCalls()) != 0 || e.claude.count() != 1 {
		t.Fatalf("%d fork starts, %d spawns", len(e.claude.forkCalls()), e.claude.count())
	}

	// Its first Send is a new chat's: a new session, the settings confirmed, the chat locked.
	if err := e.m.Configure(v.ID, ConfigReq{Effort: "high"}); err != nil {
		t.Fatalf("Configure before the first message: %v", err)
	}
	e.send(v.ID, "ask 1, edited", "")
	if e.claude.count() != 2 || len(e.claude.forkCalls()) != 0 {
		t.Fatalf("%d spawns, %d fork starts", e.claude.count(), len(e.claude.forkCalls()))
	}
	if o := e.claude.last(t).opts; o.Resume || o.SessionID != m.SessionID || o.ChatID != v.ID || o.Cwd != dir || o.Effort != "high" {
		t.Fatalf("spawn options %+v", o)
	}
	if after := e.meta(v.ID); !after.Locked || after.Draft != nil || after.Name != "Named title (fork)" {
		t.Fatalf("chat.json after the first Send %+v", after)
	}
	if len(e.namer.callList()) != 1 {
		t.Fatalf("the namer ran for the fork: %v", e.namer.callList())
	}
}

func TestForkLabels(t *testing.T) {
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 2)
	plain := e.fork(id, 3)
	if _, ok := e.treeFile(plain.ID); ok {
		t.Fatal("a fork of a chat without labels has a tree.json")
	}
	if tv := e.tree(plain.ID); len(tv.Labels) != 0 || len(tv.Branches) != 1 {
		t.Fatalf("tree of a fork without labels %+v", tv)
	}

	for item, text := range map[int]string{1: "options", 3: "redis", 4: "later"} {
		if _, err := e.m.SetLabel(id, model.MainBranch, item, text); err != nil {
			t.Fatal(err)
		}
	}
	srcTree, _ := e.treeFile(id)

	// The labels of the copied path only, under the same indexes.
	v := e.fork(id, 3)
	want := []model.TreeLabel{{Branch: model.MainBranch, Item: 1, Text: "options"}}
	if got, ok := e.treeFile(v.ID); !ok || !reflect.DeepEqual(got, model.Tree{Branches: []model.TreeBranch{}, Labels: want}) {
		t.Fatalf("tree.json of the fork %+v, %v", got, ok)
	}
	if tv := e.tree(v.ID); !reflect.DeepEqual(tv.Labels, want) || tv.Current != model.MainBranch || len(tv.Branches) != 1 {
		t.Fatalf("tree of the fork %+v", tv)
	}
	// It is a chat's own record from then on, also after a restart.
	if _, err := e.m.SetLabel(v.ID, model.MainBranch, 0, "start"); err != nil {
		t.Fatal(err)
	}
	all := e.fork(id, 6)
	if got := e.tree(all.ID).Labels; len(got) != 3 {
		t.Fatalf("labels of a fork at the end %+v", got)
	}
	if after, _ := e.treeFile(id); !reflect.DeepEqual(after, srcTree) {
		t.Fatalf("the source's tree record changed: %+v", after)
	}
	e.boot()
	if got := e.tree(v.ID).Labels; len(got) != 2 || got[1] != want[0] {
		t.Fatalf("labels of the fork after a restart %+v", got)
	}
}

// ---- the unlisted entry ---------------------------------------------------

func TestForkIsUnlistedDuringTheStart(t *testing.T) {
	e := newEnv(t)
	bd, err := e.bds.Create("board", gOne, false)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := e.talked(model.Claude, bd.ID, 2)
	evs := e.listen()
	b, res := e.block(e.claude, func() error { return e.forkErr(id, 3) })
	o := b.opts

	// A17: the starting process finds its MCP token, which belongs to the new chat.
	for _, look := range []func(string) (model.ChatMeta, bool){
		e.m.ByToken,
		func(tok string) (model.ChatMeta, bool) { c, ok := e.m.ResolveToken(tok); return c.Meta, ok },
	} {
		if m, ok := look(o.MCP.Token); !ok || m.ID != o.ChatID || m.Board != bd.ID || m.Token != o.MCP.Token {
			t.Fatalf("the token resolves to %+v, %v", m, ok)
		}
	}

	// No client can name it.
	if e.listed(o.ChatID) {
		t.Fatal("listed during the start")
	}
	for _, m := range e.m.ChatsOfBoard(bd.ID) {
		if m.ID == o.ChatID {
			t.Fatal("among the board's chats during the start")
		}
	}
	if _, err := e.m.View(o.ChatID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("View: %v", err)
	}
	if _, _, _, err := e.m.Items(o.ChatID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Items: %v", err)
	}
	if err := e.m.Send(o.ChatID, "hi", "", nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Send: %v", err)
	}
	if err := e.m.Rename(o.ChatID, "mine", true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Rename: %v", err)
	}
	if _, err := e.m.Tree(o.ChatID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Tree: %v", err)
	}
	if err := e.forkErr(o.ChatID, 3); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Fork: %v", err)
	}
	e.m.Stop(o.ChatID)
	if err := e.m.Delete(o.ChatID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Delete: %v", err)
	}
	// Its folder holds the copy, and no chat.json.
	if got := names(folder(t, e.st.P.ChatDir(o.ChatID), true)); !reflect.DeepEqual(got, []string{"items.jsonl"}) {
		t.Fatalf("the folder during the start holds %v", got)
	}
	// The source is not held: it answers, and is not busy.
	if e.m.Busy(id) || len(e.items(id)) != 6 {
		t.Fatal("the source during the start")
	}
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("events during the start %+v", got)
	}

	if err := b.release(res, nil); err != nil {
		t.Fatal(err)
	}
	if !e.listed(o.ChatID) || e.meta(o.ChatID).ID != o.ChatID {
		t.Fatal("not listed after the start")
	}
	if got := evs.drain(t, e.br); len(got) != 1 || got[0]["type"] != "chat" {
		t.Fatalf("events after the start %+v", got)
	}
}

func TestForkFailureLeavesNothing(t *testing.T) {
	boom := errors.New("the provider said no")
	archive := model.Archive{Archived: true, Op: "op1"}
	cases := []struct {
		name string
		// during runs while the start is blocked; fail is what the start then ends with.
		during  func(e *env, id, board string)
		fail    error
		want    error
		started bool // the start succeeds: its process is closed and the fork discarded
	}{
		{"the start blocks and fails", nil, boom, boom, false},
		{"the source is deleted", func(e *env, id, _ string) {
			if err := e.m.Delete(id); err != nil {
				e.t.Fatal(err)
			}
		}, nil, ErrNotFound, true},
		{"the source is archived", func(e *env, id, _ string) {
			e.m.Stop(id)
			if err := e.m.SetArchive(id, archive); err != nil {
				e.t.Fatal(err)
			}
		}, nil, ErrArchived, true},
		{"the board is archived", func(e *env, _, board string) {
			// What app.archiveBoard does.
			chats := e.m.ChatsOfBoard(board)
			if len(chats) != 1 {
				e.t.Fatalf("the board's chats during the start: %+v", chats)
			}
			for _, c := range chats {
				e.m.Stop(c.ID)
				if err := e.m.SetArchive(c.ID, archive); err != nil {
					e.t.Fatal(err)
				}
			}
			if err := e.bds.SetArchive(board, archive); err != nil {
				e.t.Fatal(err)
			}
		}, nil, ErrArchived, true},
	}
	for _, kind := range []model.AgentKind{model.Claude, model.Cursor} {
		for _, tc := range cases {
			t.Run(string(kind)+"/"+tc.name, func(t *testing.T) {
				e := newEnv(t)
				bd, err := e.bds.Create("board", gOne, false)
				if err != nil {
					t.Fatal(err)
				}
				id, _ := e.talked(kind, bd.ID, 2)
				sp := e.spawner(kind)
				evs := e.listen()

				b, res := e.blockFork(id, 3)
				if tc.during != nil {
					tc.during(e, id, bd.ID)
				}
				if err := b.release(res, tc.fail); !errors.Is(err, tc.want) {
					t.Fatalf("Fork: %v, want %v", err, tc.want)
				}
				e.gone(b.opts)
				if namesChat(evs.drain(t, e.br), b.opts.ChatID) {
					t.Fatal("an event named the fork")
				}
				if !tc.started {
					if len(sp.discarded()) != 0 {
						t.Fatalf("discarded %v after a failed start", sp.discarded())
					}
					return
				}
				// The confirmed process is closed, then what the start made is discarded.
				fa := sp.lastFork(t)
				waitFor(t, "the fork's process to close", fa.isClosed)
				sid := b.opts.SessionID
				if kind == model.Cursor {
					sid = "forked-1"
				}
				waitFor(t, "the fork to be discarded", func() bool { return reflect.DeepEqual(sp.discarded(), []string{sid}) })
				// A late event of that process writes nothing.
				select {
				case fa.ch <- agent.Event{Kind: agent.EvTurnEnd}:
				case <-time.After(5 * time.Second):
					t.Fatal("the pump of the closed process is gone")
				}
				fa.emit(t)
				e.gone(b.opts)
			})
		}
	}

	// A start that fails at once.
	e := newEnv(t)
	id, _ := e.talked(model.Pi, "", 2)
	evs := e.listen()
	e.pi.set(func(s *fakeSpawner) { s.forkErr = boom })
	if err := e.forkErr(id, 3); !errors.Is(err, boom) {
		t.Fatalf("Fork: %v", err)
	}
	e.gone(e.pi.forkCalls()[0].opts)
	if got := evs.drain(t, e.br); len(got) != 0 || len(e.chatDirs()) != 1 || len(e.pi.discarded()) != 0 {
		t.Fatalf("events %+v, folders %v, discarded %v", got, e.chatDirs(), e.pi.discarded())
	}
}

func TestShutdownDuringForkStart(t *testing.T) {
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 2)
	b, res := e.blockFork(id, 3)
	dir := e.st.P.ChatDir(b.opts.ChatID)
	before := folder(t, dir, true)

	e.m.Shutdown()
	if after := folder(t, dir, true); !reflect.DeepEqual(after, before) || len(after) != 1 {
		t.Fatalf("Shutdown wrote for the unlisted chat: %v", names(after))
	}
	if err := b.release(res, errors.New("cut")); err == nil {
		t.Fatal("Fork succeeded")
	}
	e.gone(b.opts)
}

// The steps of Fork as a new branch will use them: a Send on the entry while it is still
// unlisted goes to the confirmed process, and still nothing is saved or emitted for it.
func TestUnlistedEntryIsNeverSavedOrEmitted(t *testing.T) {
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 2)
	var out outbox
	src, err := e.m.lock(id)
	if err != nil {
		t.Fatal(err)
	}
	tr, err := e.m.trOf(src, &out)
	if err != nil {
		t.Fatal(err)
	}
	_, items := tr.Snapshot()
	meta := prefixMeta(src.meta, items, 3)
	meta.ID = uuid()
	c, err := e.m.addUnlisted(src, meta, 3)
	from := forkSourceOf(src.meta, items, 3)
	src.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if err := e.m.startFork(c, from, 3); err != nil {
		t.Fatal(err)
	}
	fa := e.claude.lastFork(t)
	dir := e.st.P.ChatDir(meta.ID)
	evs := e.listen()

	c.mu.Lock()
	if err := e.m.sendOn(c, "on the branch", "", nil); err != nil {
		t.Fatal(err)
	}
	if e.claude.count() != 1 || len(e.claude.forkCalls()) != 1 || len(fa.sent()) != 1 {
		t.Fatalf("%d spawns, %d fork starts, %d messages", e.claude.count(), len(e.claude.forkCalls()), len(fa.sent()))
	}
	fa.emit(t, agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Agent"})
	subRun(t, fa, "t1")
	fa.emit(t,
		agent.Event{Kind: agent.EvText, Sub: "t1", Text: "working"},
		agent.Event{Kind: agent.EvSub, Sub: "t1", SubInfo: &agent.SubInfo{Status: model.SubCompleted}},
		agent.Event{Kind: agent.EvToolResult, ToolID: "t1", Result: "done"},
		agent.Event{Kind: agent.EvText, Text: "reply"},
		agent.Event{Kind: agent.EvTurnEnd, Point: "b1"})

	// The thread is written, chat.json is not; no event; no client sees the chat.
	files := folder(t, dir, true)
	if _, ok := files["chat.json"]; ok || len(lineIndexes(t, files["items.jsonl"])) != 8 {
		t.Fatalf("the unlisted chat's folder holds %v", names(files))
	}
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("events for an unlisted chat %+v", got)
	}
	if e.listed(meta.ID) {
		t.Fatal("listed")
	}
	c.mu.Lock()
	dropped, turns := c.meta.ForkSource == nil, c.meta.Usage.Turns
	c.mu.Unlock()
	if !dropped || turns != 2 {
		t.Fatalf("after the first turn: fork source dropped %v, %d turns", dropped, turns)
	}

	// Shutdown writes nothing for it, and closes its process.
	e.m.Shutdown()
	if after := folder(t, dir, true); !reflect.DeepEqual(after, files) {
		t.Fatalf("Shutdown wrote for the unlisted chat: %v", names(after))
	}
	waitFor(t, "the unlisted chat's process to close", fa.isClosed)

	e.m.dropUnlisted(c, true)
	e.gone(fa.opts)
	waitFor(t, "the fork to be discarded", func() bool { return reflect.DeepEqual(e.claude.discarded(), []string{meta.SessionID}) })
}

func TestForkWithoutForker(t *testing.T) {
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 2)
	e.m.Spawners[model.Claude] = plainSpawner{e.claude}
	err := e.forkErr(id, 3)
	if err == nil || err.Error() != "forking is not available for claude chats" {
		t.Fatalf("Fork: %v", err)
	}
	if dirs := e.chatDirs(); len(dirs) != 1 || len(e.m.Views()) != 1 {
		t.Fatalf("chat folders %v", dirs)
	}
	// The start of the chat needs no fork.
	if v := e.fork(id, 0); v.Locked {
		t.Fatalf("fork at the start %+v", v)
	}
}

// plainSpawner is a spawner without the fork capability.
type plainSpawner struct{ s *fakeSpawner }

func (p plainSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) { return p.s.Spawn(o) }

// ---- the launch order -----------------------------------------------------

// claudeFork makes a Claude chat with three finished turns and a fork of it at the end of turn 1.
func (e *env) claudeFork() (src, fork string) {
	e.t.Helper()
	src, _ = e.talked(model.Claude, "", 3)
	return src, e.fork(src, 3).ID
}

func TestForkSourceKeptUntilFirstTurn(t *testing.T) {
	e := newEnv(t)
	src, id := e.claudeFork()
	srcSID, sid := e.meta(src).SessionID, e.meta(id).SessionID
	want := &model.ForkSource{Chat: src, Session: srcSID, Point: "p1", Next: "p2", Items: 3}
	if got := e.meta(id).ForkSource; !reflect.DeepEqual(got, want) {
		t.Fatalf("forkSource %+v, want %+v", got, want)
	}
	if raw, _ := json.Marshal(e.view(id)); strings.Contains(string(raw), srcSID) || strings.Contains(string(raw), "forkSource") {
		t.Fatalf("the view shows the fork source: %s", raw)
	}

	// A turn end before any Send (Claude's phantom result) drops nothing.
	e.claude.lastFork(t).emit(t, agent.Event{Kind: agent.EvTurnEnd})
	if got := e.meta(id).ForkSource; !reflect.DeepEqual(got, want) {
		t.Fatalf("forkSource after a turn end without a Send %+v", got)
	}

	// After a restart the first Send makes the fork again, with no chat lock held: the starting
	// process finds its token.
	e.boot()
	e.claude.set(func(s *fakeSpawner) {
		s.onFork = func(o agent.SpawnOptions) {
			if m, ok := e.m.ByToken(o.MCP.Token); !ok || m.ID != id {
				t.Errorf("the token during the relaunch resolves to %+v, %v", m.ID, ok)
			}
			if st := e.view(id).Status; st != model.StatusThinking {
				t.Errorf("status during the relaunch %q", st)
			}
		}
	})
	n := len(e.items(id))
	e.send(id, "carry on", "")
	calls := e.claude.forkCalls()
	if len(calls) != 1 || e.claude.count() != 0 {
		t.Fatalf("%d fork starts, %d spawns", len(calls), e.claude.count())
	}
	if want := (agent.ForkSource{ChatID: src, SessionID: srcSID, Point: "p1", Next: "p2"}); calls[0].src != want {
		t.Fatalf("relaunch source %+v, want %+v", calls[0].src, want)
	}
	if o := calls[0].opts; o.SessionID != sid || o.ChatID != id || !o.Resume {
		t.Fatalf("relaunch options %+v", o)
	}
	fa := e.claude.lastFork(t)
	if sent := fa.sent(); len(sent) != 1 || !reflect.DeepEqual(texts(sent[0]), []string{"carry on"}) {
		t.Fatalf("the process got %v", sent)
	}
	if items := e.items(id); len(items) != n+1 || items[n].Text != "carry on" {
		t.Fatalf("items %+v", items)
	}
	if m := e.meta(id); m.ForkSource == nil || !m.TurnActive || m.SessionID != sid {
		t.Fatalf("chat.json during the first turn %+v", m)
	}

	// The first turn end after a Send drops the source, and that is saved.
	fa.emit(t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd, Point: "f1"})
	if m := e.meta(id); m.ForkSource != nil || m.TurnActive {
		t.Fatalf("chat.json after the first turn %+v", m)
	}
	// From now on it is a chat like any other: a resume.
	fa.exit(t)
	e.send(id, "again", "")
	if len(e.claude.forkCalls()) != 1 || e.claude.count() != 1 {
		t.Fatalf("%d fork starts, %d spawns after the source was dropped", len(e.claude.forkCalls()), e.claude.count())
	}
	if o := e.claude.last(t).opts; !o.Resume || o.SessionID != sid {
		t.Fatalf("resume options %+v", o)
	}
}

func TestForkRelaunchAfterExit(t *testing.T) {
	// Without a restart: the confirmed process exits before the first Send.
	e := newEnv(t)
	_, id := e.claudeFork()
	e.claude.lastFork(t).exit(t)
	e.send(id, "carry on", "")
	if len(e.claude.forkCalls()) != 2 || e.claude.count() != 1 {
		t.Fatalf("%d fork starts, %d spawns", len(e.claude.forkCalls()), e.claude.count())
	}
	if a, b := e.claude.forkCalls()[0], e.claude.forkCalls()[1]; a.src != b.src || a.opts.SessionID != b.opts.SessionID {
		t.Fatalf("relaunch %+v, first launch %+v", b, a)
	}
	if sent := e.claude.lastFork(t).sent(); len(sent) != 1 {
		t.Fatalf("the process got %v", sent)
	}
}

func TestForkRelaunchFails(t *testing.T) {
	e := newEnv(t)
	_, id := e.claudeFork()
	e.boot()
	evs := e.listen()
	n := len(e.items(id))
	file, _ := os.ReadFile(filepath.Join(e.st.P.ChatDir(id), "chat.json"))
	evs.drain(t, e.br)

	boom := errors.New("No conversation found")
	e.claude.set(func(s *fakeSpawner) { s.forkErr = boom })
	if err := e.m.Send(id, "carry on", "", nil); !errors.Is(err, boom) {
		t.Fatalf("Send: %v", err)
	}
	// No message, note, mark or turn count; the failure shows on the chat.
	if items := e.items(id); len(items) != n {
		t.Fatalf("a failed start added items: %+v", items[n:])
	}
	if v := e.view(id); v.Status != model.StatusError || v.Error != boom.Error() || v.Usage.Turns != 1 {
		t.Fatalf("view after a failed start %+v", v)
	}
	if after, _ := os.ReadFile(filepath.Join(e.st.P.ChatDir(id), "chat.json")); string(after) != string(file) {
		t.Fatalf("chat.json changed:\n%s", after)
	}
	chatEvs := ofType(evs.drain(t, e.br), "chat")
	if len(chatEvs) != 2 || chatEvs[1]["chat"].(map[string]any)["status"] != string(model.StatusError) {
		t.Fatalf("chat events %+v", chatEvs)
	}

	// The next Send starts it: the message goes once, to the confirmed process.
	e.claude.set(func(s *fakeSpawner) { s.forkErr = nil })
	e.send(id, "carry on", "")
	if sent := e.claude.lastFork(t).sent(); len(sent) != 1 || len(e.claude.forkCalls()) != 2 || e.claude.count() != 0 {
		t.Fatalf("sent %v, %d fork starts, %d spawns", sent, len(e.claude.forkCalls()), e.claude.count())
	}
	if v := e.view(id); v.Error != "" || v.Status != model.StatusThinking {
		t.Fatalf("view after the start %+v", v)
	}

	// A spawner that lost the capability: the same failure, at once.
	e.claude.lastFork(t).exit(t)
	e.m.Spawners[model.Claude] = plainSpawner{e.claude}
	n = len(e.items(id))
	if err := e.m.Send(id, "more", "", nil); err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("Send without the fork capability: %v", err)
	}
	if len(e.items(id)) != n || e.claude.count() != 0 {
		t.Fatal("a Send without the fork capability added an item or spawned")
	}
}

func TestForkRelaunchBusyDeleteArchive(t *testing.T) {
	e := newEnv(t)
	_, id := e.claudeFork()
	_, other := e.claudeFork()
	e.boot()
	n := len(e.items(id))

	// During the start the chat is busy.
	b, res := e.block(e.claude, func() error { return e.m.Send(id, "carry on", "", nil) })
	if !e.m.Busy(id) {
		t.Fatal("not busy during the start")
	}
	if err := e.m.Send(id, "two", "", nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("second Send during the start: %v", err)
	}
	if err := e.forkErr(id, 3); !errors.Is(err, ErrBusy) {
		t.Fatalf("Fork during the start: %v", err)
	}
	if len(e.items(id)) != n {
		t.Fatal("the message was added before the start was confirmed")
	}
	// Deleted during the start: the process is closed, nothing is written.
	if err := e.m.Delete(id); err != nil {
		t.Fatal(err)
	}
	if err := b.release(res, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Send of a chat deleted during the start: %v", err)
	}
	fa := e.claude.lastFork(t)
	waitFor(t, "the process to close", fa.isClosed)
	if len(fa.sent()) != 0 {
		t.Fatal("the message reached the process of a deleted chat")
	}
	if _, err := os.Stat(e.st.P.ChatDir(id)); !os.IsNotExist(err) {
		t.Fatalf("the deleted chat's folder: %v", err)
	}

	// Archived during the start.
	n = len(e.items(other))
	b, res = e.block(e.claude, func() error { return e.m.Send(other, "carry on", "", nil) })
	if err := e.m.SetArchive(other, model.Archive{Archived: true}); err != nil {
		t.Fatal(err)
	}
	if err := b.release(res, nil); !errors.Is(err, ErrArchived) {
		t.Fatalf("Send of a chat archived during the start: %v", err)
	}
	fa = e.claude.lastFork(t)
	waitFor(t, "the process to close", fa.isClosed)
	if len(fa.sent()) != 0 || len(e.items(other)) != n {
		t.Fatal("the message reached an archived chat")
	}
	if v := e.view(other); v.Status != model.StatusReady || e.meta(other).ForkSource == nil {
		t.Fatalf("view after the start %+v", v)
	}
}

func TestForkOfFork(t *testing.T) {
	e := newEnv(t)
	src, f1 := e.claudeFork()
	srcSID, f1SID := e.meta(src).SessionID, e.meta(f1).SessionID

	// Not sent to yet: it has no session of its own, so its fork goes through the first source.
	f2 := e.fork(f1, 3).ID
	through := agent.ForkSource{ChatID: src, SessionID: srcSID, Point: "p1"}
	if got := e.claude.forkCalls()[1].src; got != through {
		t.Fatalf("fork of an unsent fork %+v, want %+v", got, through)
	}
	if got, want := e.meta(f2).ForkSource, (&model.ForkSource{Chat: src, Session: srcSID, Point: "p1", Items: 3}); !reflect.DeepEqual(got, want) {
		t.Fatalf("forkSource of the second fork %+v", got)
	}
	if e.meta(f2).ForkedFrom != f1 {
		t.Fatalf("forkedFrom %q", e.meta(f2).ForkedFrom)
	}

	// A message was sent and its turn cut: the source is still kept, but the fork has a session.
	e.send(f1, "carry on", "")
	e.claude.forked[0].exit(t)
	if e.meta(f1).ForkSource == nil || e.m.Busy(f1) {
		t.Fatalf("the fork after a cut turn %+v", e.meta(f1))
	}
	e.fork(f1, 3)
	if got, want := e.claude.forkCalls()[2].src, (agent.ForkSource{ChatID: f1, SessionID: f1SID, Point: "p1"}); got != want {
		t.Fatalf("fork of a sent fork %+v, want %+v", got, want)
	}
	n := len(e.items(f1))
	e.fork(f1, n)
	if got, want := e.claude.forkCalls()[3].src, (agent.ForkSource{ChatID: f1, SessionID: f1SID, End: true}); got != want {
		t.Fatalf("fork of a sent fork at its end %+v, want %+v", got, want)
	}

	// The source of a fork made at the end of an older chat has no id: a fork of that fork is
	// made at the end of the first source.
	e = newEnv(t)
	old := e.stored(model.Claude, []model.Item{pUser(), pText()})
	g1 := e.fork(old, 2).ID
	e.fork(g1, 2)
	if got, want := e.claude.forkCalls()[1].src, (agent.ForkSource{ChatID: old, SessionID: e.meta(old).SessionID}); got != want {
		t.Fatalf("fork of an unsent fork of an older chat %+v, want %+v", got, want)
	}
}
