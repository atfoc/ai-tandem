package chats

import (
	"bytes"
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

	// Busy: its end is no point (the fork would be of a session that is still going), and nor
	// is a place inside the running turn. (The finished boundaries are:
	// TestForkFromARunningSource.)
	e.send(id, "more", "")
	if err := e.forkErr(id, 7); !errors.Is(err, ErrBusy) {
		t.Fatalf("busy chat at its end, right after the message: %v", err)
	}
	a.emit(t, agent.Event{Kind: agent.EvText, Text: "half a rep"})
	if err := e.forkErr(id, 7); !errors.Is(err, ErrBadPoint) {
		t.Fatalf("busy chat inside the running turn: %v", err)
	}
	if err := e.forkErr(id, 8); !errors.Is(err, ErrBusy) {
		t.Fatalf("busy chat at its end: %v", err)
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
	if got, want := e.pi.forkCalls()[0].src, (agent.ForkSource{ChatID: id, Dir: e.st.P.ChatDir(id), SessionID: sid, Point: "p3", End: true}); got != want {
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
	want := agent.ForkSource{ChatID: id, Dir: e.st.P.ChatDir(id), SessionID: e.meta(id).SessionID, Point: "p1", Next: "p3"}
	for _, call := range e.claude.forkCalls() {
		if call.src != want {
			t.Fatalf("claude fork at 3 %+v, want %+v", call.src, want)
		}
	}

	// pi, the end of turn 1 of three finished turns: forked with the id on turn 2's mark.
	e = newEnv(t)
	id, _ = e.talked(model.Pi, "", 3)
	e.fork(id, 3)
	want = agent.ForkSource{ChatID: id, Dir: e.st.P.ChatDir(id), SessionID: e.meta(id).SessionID, Point: "p1", Next: "p2"}
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
	want := agent.ForkSource{ChatID: id, Dir: e.st.P.ChatDir(id), SessionID: e.meta(id).SessionID, End: true}
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

	// The new chat's state record, then one chat event for it; nothing for the source.
	if !reflect.DeepEqual(typesOf(got), []string{"branch_state", "chat"}) || got[1]["chat"].(map[string]any)["id"] != v.ID {
		t.Fatalf("events %+v", got)
	}
	if !reflect.DeepEqual(asJSON(t, got[1]["chat"]), asJSON(t, v)) {
		t.Fatalf("the event's view %+v, the answer %+v", got[1]["chat"], v)
	}
	if st := stateIn(t, got[0]); st != model.StateOf(v.ID, model.MainBranch, v) {
		t.Fatalf("the event's state record %+v, the answer %+v", st, v)
	}
	if !e.listed(v.ID) || e.view(v.ID) != v {
		t.Fatalf("the fork is not listed as answered: %+v", e.view(v.ID))
	}
	want := model.ChatView{ID: v.ID, Agent: model.Claude, Name: "Named title (fork)", Group: gOne,
		Cwd: srcView.Cwd, Model: srcView.Model, Effort: srcView.Effort, Locked: true, Created: v.Created,
		Usage: model.Usage{CtxWindow: 1000, Turns: 1}, Status: model.StatusReady,
		ForkedFrom: id, ForkedFromTitle: "Named title", ForkedBranch: model.MainBranch, ForkedAt: at, Fresh: true}
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
	if m.TurnActive || m.Archived || m.Drafts != nil || m.Draft != nil || m.ContextSplit != nil || m.UserNamed || m.McpInstructionsSent {
		t.Fatalf("chat.json %+v", m)
	}
	// No message of its own yet, and the context it starts with is the source's.
	if !m.Fresh || m.SourceCtx != 100 || srcMeta.Usage.CtxIn != 100 {
		t.Fatalf("chat.json: fresh %v, the source's context %d (the source has %d)", m.Fresh, m.SourceCtx, srcMeta.Usage.CtxIn)
	}
	if c, ok := e.m.ResolveToken(m.Token); !ok || c.Meta.ID != v.ID {
		t.Fatalf("the fork's token resolves to %+v, %v", c.Meta.ID, ok)
	}

	// The fork start: the source's session at the mark's id, as the new chat.
	calls := e.claude.forkCalls()
	if len(calls) != 1 {
		t.Fatalf("%d fork starts", len(calls))
	}
	if want := (agent.ForkSource{ChatID: id, Dir: e.st.P.ChatDir(id), SessionID: srcMeta.SessionID, Point: "p1", Next: "p2"}); calls[0].src != want {
		t.Fatalf("fork source %+v, want %+v", calls[0].src, want)
	}
	wantOpts := agent.SpawnOptions{ChatID: v.ID, SessionID: m.SessionID, Resume: true, Cwd: v.Cwd, Model: v.Model,
		Effort: v.Effort, MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: m.Token}, Dir: e.st.P.ChatDir(v.ID)}
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
	if got, want := e.claude.forkCalls()[1].src, (agent.ForkSource{ChatID: id, Dir: e.st.P.ChatDir(id), SessionID: srcMeta.SessionID, Point: "p3", End: true}); got != want {
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
	if want := (agent.ForkSource{ChatID: id, Dir: e.st.P.ChatDir(id), SessionID: "cur-1", Point: "p1", Next: "p2"}); call.src != want {
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
	// It is the draft of the new chat's main, the one branch it has.
	if m := e.meta(v.ID); !reflect.DeepEqual(m.Drafts, map[string]*model.Draft{model.MainBranch: want}) || m.Draft != nil ||
		!reflect.DeepEqual(e.view(v.ID).Draft, want) || !v.HasDraft {
		t.Fatalf("drafts %+v, view %+v", m.Drafts, v)
	}
	if !v.Locked || e.claude.forkCalls()[0].src.Point != "p1" {
		t.Fatalf("view %+v, fork %+v", v, e.claude.forkCalls()[0].src)
	}
	if m := e.meta(id); m.Drafts != nil || m.Draft != nil {
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
		Draft: &model.Draft{Text: "ask 1"}, HasDraft: true, Status: model.StatusReady, ForkedFrom: id, ForkedFromTitle: "Named title",
		ForkedBranch: model.MainBranch}
	if !reflect.DeepEqual(v, want) {
		t.Fatalf("view %+v\nwant %+v", v, want)
	}
	got := evs.drain(t, e.br)
	if !reflect.DeepEqual(typesOf(got), []string{"branch_state", "chat"}) || got[1]["chat"].(map[string]any)["id"] != v.ID {
		t.Fatalf("events %+v", got)
	}
	if st := stateIn(t, got[0]); !reflect.DeepEqual(st, model.StateOf(v.ID, model.MainBranch, want)) {
		t.Fatalf("the event's state record %+v", st)
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
	if after := e.meta(v.ID); !after.Locked || after.Drafts != nil || after.Name != "Named title (fork)" {
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
	got := evs.drain(t, e.br)
	if !reflect.DeepEqual(typesOf(got), []string{"branch_state", "chat"}) {
		t.Fatalf("events after the start %+v", got)
	}
	if st := stateIn(t, got[0]); st.Chat != o.ChatID || st.Branch != model.MainBranch {
		t.Fatalf("the state record after the start %+v", st)
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
	meta := prefixMeta(src.meta, items, 3, model.ModelChoice{Model: src.meta.Model, Effort: src.meta.Effort}, 0)
	meta.ID = uuid()
	c, err := e.m.addUnlisted(src, meta, 3)
	from := forkSourceOf(src.meta, items, 3, false)
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
	if _, err := e.m.sendOn(c, "on the branch", "", nil); err != nil {
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
	if want := (agent.ForkSource{ChatID: src, Dir: e.st.P.ChatDir(src), SessionID: srcSID, Point: "p1", Next: "p2"}); calls[0].src != want {
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
	src, third := e.claudeFork()
	e.boot()
	n := len(e.items(id))

	// During the start the chat is busy without a turn. A fork at a finished boundary is made
	// all the same: it has no session of its own yet, so the fork goes through its fork source,
	// cut at the id of the point.
	b, res := e.block(e.claude, func() error { return e.m.Send(third, "carry on", "", nil) })
	if !e.m.Busy(third) {
		t.Fatal("not busy during the start")
	}
	starts := len(e.claude.forkCalls())
	forked := make(chan error, 1)
	var fv model.ChatView
	go func() {
		var err error
		fv, err = e.m.Fork(third, ForkReq{Branch: model.MainBranch, At: 3})
		forked <- err
	}()
	waitFor(t, "the fork's own start", func() bool { return len(e.claude.forkCalls()) == starts+1 })
	if got, want := e.claude.forkCalls()[starts].src, (agent.ForkSource{ChatID: src, Dir: e.st.P.ChatDir(src), SessionID: e.meta(src).SessionID, Point: "p1"}); got != want {
		t.Fatalf("fork source during the start %+v, want %+v", got, want)
	}
	if err := b.release(res, nil); err != nil {
		t.Fatalf("Send whose start a fork was made during: %v", err)
	}
	select {
	case err := <-forked:
		if err != nil {
			t.Fatalf("Fork during the start: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the fork did not return")
	}
	if got := e.diskItems(fv.ID); !reflect.DeepEqual(got, e.diskItems(third)[:3]) || fv.ForkedFrom != third || !e.listed(fv.ID) {
		t.Fatalf("the fork made during the start: items %+v, view %+v", got, fv)
	}
	if got := e.items(third); len(got) != 4 || got[3].Text != "carry on" || !e.m.Busy(third) {
		t.Fatalf("the chat whose start a fork was made during: %+v", got)
	}

	// During the start a second Send is refused, and nothing is added.
	b, res = e.block(e.claude, func() error { return e.m.Send(id, "carry on", "", nil) })
	if !e.m.Busy(id) {
		t.Fatal("not busy during the start")
	}
	if err := e.m.Send(id, "two", "", nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("second Send during the start: %v", err)
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
	through := agent.ForkSource{ChatID: src, Dir: e.st.P.ChatDir(src), SessionID: srcSID, Point: "p1"}
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
	if got, want := e.claude.forkCalls()[2].src, (agent.ForkSource{ChatID: f1, Dir: e.st.P.ChatDir(f1), SessionID: f1SID, Point: "p1"}); got != want {
		t.Fatalf("fork of a sent fork %+v, want %+v", got, want)
	}
	n := len(e.items(f1))
	e.fork(f1, n)
	if got, want := e.claude.forkCalls()[3].src, (agent.ForkSource{ChatID: f1, Dir: e.st.P.ChatDir(f1), SessionID: f1SID, End: true}); got != want {
		t.Fatalf("fork of a sent fork at its end %+v, want %+v", got, want)
	}

	// The source of a fork made at the end of an older chat has no id: a fork of that fork is
	// made at the end of the first source.
	e = newEnv(t)
	old := e.stored(model.Claude, []model.Item{pUser(), pText()})
	g1 := e.fork(old, 2).ID
	e.fork(g1, 2)
	if got, want := e.claude.forkCalls()[1].src, (agent.ForkSource{ChatID: old, Dir: e.st.P.ChatDir(old), SessionID: e.meta(old).SessionID}); got != want {
		t.Fatalf("fork of an unsent fork of an older chat %+v, want %+v", got, want)
	}
}

// ---- a fork with no id to cut at ------------------------------------------

// oldFork makes a Claude chat from before forking (one turn, no end mark) and a fork of it at its
// end. Nothing names that place in the source's session: the fork's first start is of the whole
// source, and its record keeps no point.
func (e *env) oldFork() (src, fork string) {
	e.t.Helper()
	src = e.stored(model.Claude, []model.Item{pUser(), pText()})
	fork = e.fork(src, 2).ID
	srcSID := e.meta(src).SessionID
	if got, want := e.claude.forkCalls()[0].src, (agent.ForkSource{ChatID: src, Dir: e.st.P.ChatDir(src), SessionID: srcSID, End: true}); got != want {
		e.t.Fatalf("first start %+v, want %+v", got, want)
	}
	if got, want := e.meta(fork).ForkSource, (&model.ForkSource{Chat: src, Session: srcSID, Items: 2}); !reflect.DeepEqual(got, want) {
		e.t.Fatalf("forkSource %+v, want %+v", got, want)
	}
	return src, fork
}

// chatEventsOf keeps the chat events of the chat id.
func chatEventsOf(evs []map[string]any, id string) []map[string]any {
	var out []map[string]any
	for _, ev := range ofType(evs, "chat") {
		if ev["chat"].(map[string]any)["id"] == id {
			out = append(out, ev)
		}
	}
	return out
}

func TestForkWithoutPointSourceWentOn(t *testing.T) {
	e := newEnv(t)
	src, id := e.oldFork()
	e.turn(src, nil, 2) // the source goes on; the fork never had a message
	e.boot()
	evs := e.listen()
	n := len(e.items(id))
	file, _ := os.ReadFile(filepath.Join(e.st.P.ChatDir(id), "chat.json"))
	srcItems := e.file(src, "items.jsonl")
	evs.drain(t, e.br)

	// Made again now, the fork would be the whole source, with a turn its thread lacks: no start.
	for i := 0; i < 2; i++ { // and it stays refused
		if err := e.m.Send(id, "hello", "", nil); !errors.Is(err, errForkGone) {
			t.Fatalf("Send %d to a fork whose source went on: %v", i, err)
		}
		if calls := e.claude.forkCalls(); len(calls) != 0 || e.claude.count() != 0 {
			t.Fatalf("Send %d: %d fork starts (%+v), %d spawns", i, len(calls), calls, e.claude.count())
		}
		// As after a failed start: no message, note, mark or turn count; the failure shows on the chat.
		if items := e.items(id); len(items) != n {
			t.Fatalf("a refused start added items: %+v", items[n:])
		}
		if v := e.view(id); v.Status != model.StatusError || v.Error != errForkGone.Error() || v.Usage.Turns != 1 {
			t.Fatalf("view after a refused start %+v", v)
		}
		if after, _ := os.ReadFile(filepath.Join(e.st.P.ChatDir(id), "chat.json")); string(after) != string(file) {
			t.Fatalf("chat.json changed:\n%s", after)
		}
		chatEvs := chatEventsOf(evs.drain(t, e.br), id)
		if len(chatEvs) != 2 || chatEvs[1]["chat"].(map[string]any)["status"] != string(model.StatusError) ||
			chatEvs[1]["chat"].(map[string]any)["error"] != errForkGone.Error() {
			t.Fatalf("chat events %+v", chatEvs)
		}
	}
	if e.m.Busy(id) {
		t.Fatal("the fork is busy after a refused start")
	}
	// The source is only looked at.
	if v := e.view(src); v.Status != model.StatusReady || v.Error != "" || !bytes.Equal(e.file(src, "items.jsonl"), srcItems) {
		t.Fatalf("the source after the refusal %+v", v)
	}
}

func TestForkWithoutPointSourceKept(t *testing.T) {
	e := newEnv(t)
	src, id := e.oldFork()
	srcSID := e.meta(src).SessionID
	// An archived source has not gone on: its session still ends where the fork does.
	if err := e.m.SetArchive(src, model.Archive{Archived: true}); err != nil {
		t.Fatal(err)
	}
	e.boot()
	e.send(id, "hello", "")
	calls := e.claude.forkCalls()
	if len(calls) != 1 || e.claude.count() != 0 {
		t.Fatalf("%d fork starts, %d spawns", len(calls), e.claude.count())
	}
	if want := (agent.ForkSource{ChatID: src, Dir: e.st.P.ChatDir(src), SessionID: srcSID}); calls[0].src != want {
		t.Fatalf("relaunch source %+v, want %+v", calls[0].src, want)
	}
	if sent := e.claude.lastFork(t).sent(); len(sent) != 1 || !reflect.DeepEqual(texts(sent[0]), []string{"hello"}) {
		t.Fatalf("the process got %v", sent)
	}
	if v := e.view(id); v.Error != "" || v.Status != model.StatusThinking {
		t.Fatalf("view after the start %+v", v)
	}
}

func TestForkWithoutPointSourceDeleted(t *testing.T) {
	e := newEnv(t)
	src, id := e.oldFork()
	if err := e.m.Delete(src); err != nil {
		t.Fatal(err)
	}
	e.boot()
	n := len(e.items(id))
	// Nothing says any more where the source's session ended.
	if err := e.m.Send(id, "hello", "", nil); !errors.Is(err, errForkGone) {
		t.Fatalf("Send to a fork whose source is deleted: %v", err)
	}
	if calls := e.claude.forkCalls(); len(calls) != 0 || e.claude.count() != 0 {
		t.Fatalf("%d fork starts (%+v), %d spawns", len(calls), calls, e.claude.count())
	}
	if v := e.view(id); v.Status != model.StatusError || v.Error != errForkGone.Error() || len(e.items(id)) != n {
		t.Fatalf("view after a refused start %+v", v)
	}
}

// The source of a fork is one chat object: a branch's own thread says whether it went on, not
// its chat's other branches.
func TestForkWithoutPointOfABranch(t *testing.T) {
	for _, cur := range []string{"", exBranch} {
		e := newEnv(t)
		id, bid := e.branched(model.Claude, "", cur)
		v, err := e.m.Fork(id, ForkReq{Branch: exBranch, At: 6}) // the branch's last mark has no id
		if err != nil {
			t.Fatal(err)
		}
		through := agent.ForkSource{ChatID: bid, Dir: e.st.P.ChatDir(bid), SessionID: "ses-" + exBranch}
		if got, want := e.meta(v.ID).ForkSource, (&model.ForkSource{Chat: bid, Session: through.SessionID, Items: 6}); !reflect.DeepEqual(got, want) {
			t.Fatalf("forkSource %+v, want %+v", got, want)
		}
		e.turn(id, nil, 3) // on the chat's current branch
		e.boot()
		err = e.m.Send(v.ID, "hello", "", nil)
		calls := e.claude.forkCalls()
		if cur == exBranch {
			if !errors.Is(err, errForkGone) || len(calls) != 0 {
				t.Fatalf("Send to a fork of a branch that went on: %v, fork starts %+v", err, calls)
			}
			continue
		}
		if err != nil || len(calls) != 1 || calls[0].src != through {
			t.Fatalf("Send to a fork of a branch whose chat went on elsewhere: %v, fork starts %+v", err, calls)
		}
	}
}

// A fork whose first message was accepted has a session of its own, even when its turn never ended
// and its fork source is still kept: the start goes through the adapter, which finds that session
// and resumes it, whatever the source holds by now.
func TestForkWithoutPointSentBeforeSourceWentOn(t *testing.T) {
	e := newEnv(t)
	src, id := e.oldFork()
	srcSID := e.meta(src).SessionID
	e.send(id, "first", "") // accepted by the fork's process; the app closes during the turn
	e.turn(src, nil, 2)
	e.boot()
	if e.meta(id).ForkSource == nil {
		t.Fatal("the fork lost its fork source without a turn end")
	}
	e.send(id, "again", "")
	calls := e.claude.forkCalls()
	if len(calls) != 1 || e.claude.count() != 0 {
		t.Fatalf("%d fork starts, %d spawns", len(calls), e.claude.count())
	}
	if want := (agent.ForkSource{ChatID: src, Dir: e.st.P.ChatDir(src), SessionID: srcSID}); calls[0].src != want {
		t.Fatalf("relaunch source %+v, want %+v", calls[0].src, want)
	}
	if sent := e.claude.lastFork(t).sent(); len(sent) != 1 || !reflect.DeepEqual(texts(sent[0]), []string{"again"}) {
		t.Fatalf("the process got %v", sent)
	}
}

// With an id the fork is cut at it on every start, whatever the source holds by now.
func TestForkWithPointSourceWentOn(t *testing.T) {
	e := newEnv(t)
	src, a := e.talked(model.Claude, "", 1)
	srcSID := e.meta(src).SessionID
	id := e.fork(src, 3).ID // at the source's end
	if got, want := e.claude.forkCalls()[0].src, (agent.ForkSource{ChatID: src, Dir: e.st.P.ChatDir(src), SessionID: srcSID, Point: "p1", End: true}); got != want {
		t.Fatalf("first start %+v, want %+v", got, want)
	}
	e.turn(src, a, 2)
	e.boot()
	e.send(id, "hello", "")
	calls := e.claude.forkCalls()
	if len(calls) != 1 || e.claude.count() != 0 {
		t.Fatalf("%d fork starts, %d spawns", len(calls), e.claude.count())
	}
	if want := (agent.ForkSource{ChatID: src, Dir: e.st.P.ChatDir(src), SessionID: srcSID, Point: "p1"}); calls[0].src != want {
		t.Fatalf("relaunch source %+v, want %+v", calls[0].src, want)
	}
}

// A fork of a fork that has no session of its own yet goes through that fork's source. Where no
// id names the place, it is refused as that fork's own start is once the source has gone on.
func TestForkOfForkWithoutPointSourceWentOn(t *testing.T) {
	e := newEnv(t)
	old, g1 := e.oldFork()
	e.turn(old, nil, 2)
	dirs, views := e.chatDirs(), len(e.m.Views())
	for _, restart := range []bool{false, true} {
		if restart {
			e.boot()
		}
		n := len(e.claude.forkCalls())
		if err := e.forkErr(g1, 2); !errors.Is(err, errForkGone) {
			t.Fatalf("Fork of an unsent fork whose source went on (restart %v): %v", restart, err)
		}
		if calls := e.claude.forkCalls(); len(calls) != n {
			t.Fatalf("a refused fork started a process: %+v", calls[n:])
		}
		// Nothing is left of the chat it was asked for.
		if got := e.chatDirs(); !reflect.DeepEqual(got, dirs) || len(e.m.Views()) != views {
			t.Fatalf("chat folders %v, want %v; %d views, want %d", got, dirs, len(e.m.Views()), views)
		}
		// A branch never starts at a place without an id.
		if err := e.sendToErr(g1, Target{Branch: model.MainBranch, At: 2, New: true}); !errors.Is(err, ErrBadPoint) {
			t.Fatalf("a new branch at the end of an unsent fork without an id: %v", err)
		}
	}
}

// A fork of such a fork, made at the end of its thread, is also of the whole source session, and
// its record keeps the source's item count, not the count of the fork it was made from: that
// thread is longer by the end mark of the turn end Claude reports when the fork starts. After a
// restart it is refused, as that fork is, once the source has gone on by as little as one message.
func TestForkOfForkKeepsTheSourcesCount(t *testing.T) {
	e := newEnv(t)
	src, g := e.oldFork()
	e.claude.lastFork(t).emit(t, agent.Event{Kind: agent.EvTurnEnd})
	gItems := e.items(g)
	if got, want := kinds(gItems), []string{"user", "text", "end"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the fork's thread %v, want %v", got, want)
	}
	h := e.fork(g, len(gItems)).ID
	srcSID := e.meta(src).SessionID
	if got, want := e.meta(h).ForkSource, (&model.ForkSource{Chat: src, Session: srcSID, Items: 2}); !reflect.DeepEqual(got, want) {
		t.Errorf("forkSource of the fork's fork %+v, want %+v", got, want)
	}

	// The source goes on: one message, and its process ends before any reply.
	e.send(src, "more", "")
	e.claude.last(t).exit(t)
	if got, want := kinds(e.items(src)), []string{"user", "text", "user", "note"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the source's thread %v, want %v", got, want)
	}
	e.m.Shutdown()
	e.boot()

	n := len(e.claude.forkCalls())
	for name, id := range map[string]string{"the fork": g, "the fork's fork": h} {
		if err := e.m.Send(id, "hello", "", nil); !errors.Is(err, errForkGone) {
			t.Errorf("Send to %s, whose source went on: %v, want errForkGone", name, err)
		}
	}
	if calls := e.claude.forkCalls(); len(calls) != n {
		t.Errorf("a fork was started from a source that has gone on: %+v", calls[n:])
	}
}

// ---- the model and effort of a fork ---------------------------------------

func (e *env) forkWith(id string, at int, modelID, effort string) (model.ChatView, error) {
	return e.m.Fork(id, ForkReq{Branch: model.MainBranch, At: at, Model: modelID, Effort: effort})
}

func TestForkTakesTheChoice(t *testing.T) {
	e := newEnv(t)
	id, a := e.talked(model.Claude, "", 2)
	e.usedTurn(id, a, 100) // the source's window is known: 1000
	src, srcView := e.meta(id), e.view(id)
	cases := []struct {
		name          string
		at            int
		model, effort string
		want          model.ModelChoice
		window        int
	}{
		{"a model without efforts", 3, "haiku", "", model.ModelChoice{Model: "haiku"}, 200_000},
		{"a model that offers the effort", 9, "opus", "", model.ModelChoice{Model: "opus", Effort: "high"}, 1_000_000},
		{"an effort alone", 3, "", "low", model.ModelChoice{Model: "sonnet", Effort: "low"}, 1000},
		{"a model and an effort", 6, "opus", "max", model.ModelChoice{Model: "opus", Effort: "max"}, 1_000_000},
		{"none", 3, "", "", model.ModelChoice{Model: "sonnet", Effort: "high"}, 1000},
	}
	for _, tc := range cases {
		v, err := e.forkWith(id, tc.at, tc.model, tc.effort)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		m := e.meta(v.ID)
		if v.Model != tc.want.Model || v.Effort != tc.want.Effort || m.Model != v.Model || m.Effort != v.Effort {
			t.Fatalf("%s: the fork's view %+v, its chat.json %+v", tc.name, v, m)
		}
		if v.Usage.CtxWindow != tc.window {
			t.Fatalf("%s: the fork's context window %d, want %d", tc.name, v.Usage.CtxWindow, tc.window)
		}
		if st := e.stateOfBranch(v.ID, model.MainBranch); st.Model != tc.want.Model || st.Effort != tc.want.Effort {
			t.Fatalf("%s: the fork's state record %+v", tc.name, st)
		}
		if o := e.claude.lastFork(t).opts; o.ChatID != v.ID || o.Model != tc.want.Model || o.Effort != tc.want.Effort {
			t.Fatalf("%s: the fork's process was started with %+v", tc.name, o)
		}
		if e.view(id) != srcView || !reflect.DeepEqual(e.meta(id), src) {
			t.Fatalf("%s: the source changed", tc.name)
		}
	}

	// A choice that cannot be: no chat is made, no fork started.
	dirs, forks := e.chatDirs(), len(e.claude.forkCalls())
	for _, tc := range []struct {
		at            int
		model, effort string
		want          string
	}{
		{3, "nope", "", `unknown model "nope"`},
		{0, "nope", "", `unknown model "nope"`},
		{3, "", "bogus", `sonnet has no effort "bogus"`},
		{3, "haiku", "high", `haiku has no effort "high"`},
	} {
		if _, err := e.forkWith(id, tc.at, tc.model, tc.effort); err == nil || err.Error() != tc.want {
			t.Fatalf("a fork on %q, %q: %v", tc.model, tc.effort, err)
		}
	}
	if _, err := e.forkWith(id, 4, "nope", ""); !errors.Is(err, ErrBadPoint) { // the point comes first
		t.Fatalf("a bad point with an unknown model: %v", err)
	}
	if !reflect.DeepEqual(e.chatDirs(), dirs) || len(e.claude.forkCalls()) != forks {
		t.Fatalf("a refused choice left something: %v (were %v), %d fork starts (were %d)", e.chatDirs(), dirs, len(e.claude.forkCalls()), forks)
	}
}

func TestForkIsFreshUntilItsFirstMessage(t *testing.T) {
	e := newEnv(t)
	id, a := e.talked(model.Claude, "", 2)
	e.usedTurn(id, a, 100)
	fresh := func(when, fid string, want bool, ctx int) {
		t.Helper()
		m, v, st := e.meta(fid), e.view(fid), e.stateOfBranch(fid, model.MainBranch)
		if m.Fresh != want || v.Fresh != want || st.Fresh != want || m.SourceCtx != ctx {
			t.Fatalf("%s: fresh in chat.json %v, the view %v, the state record %v, want %v; the source's context %d, want %d",
				when, m.Fresh, v.Fresh, st.Fresh, want, m.SourceCtx, ctx)
		}
		raw := string(e.file(fid, "chat.json"))
		if strings.Contains(raw, `"fresh"`) != want || strings.Contains(raw, `"sourceCtx"`) != (ctx != 0) {
			t.Fatalf("%s: chat.json %s", when, raw)
		}
	}

	// A fork with a conversation is fresh until a message is sent on it.
	v := e.fork(id, 3)
	if !v.Locked {
		t.Fatalf("the fork %+v", v)
	}
	fresh("a new fork", v.ID, true, 100)
	if e.view(id).Fresh || e.meta(id).Fresh || e.meta(id).SourceCtx != 0 {
		t.Fatalf("the source is fresh: %+v", e.meta(id))
	}
	evs := e.listen()
	e.send(v.ID, "on the fork", "")
	fresh("after its first message", v.ID, false, 0)
	got := evs.drain(t, e.br)
	if sts := statesOf(t, got, v.ID, model.MainBranch); len(sts) == 0 || sts[len(sts)-1].Fresh {
		t.Fatalf("the state records after its first message %+v", sts)
	}
	for _, ev := range ofType(got, "chat") {
		if c := ev["chat"].(map[string]any); c["id"] == v.ID && c["fresh"] != nil {
			t.Fatalf("a chat event names the fork as fresh after its first message: %v", c)
		}
	}
	e.claude.lastFork(t).emit(t, reply("f1")...)
	fresh("after its first turn", v.ID, false, 0)

	// A message its agent refuses is still its first.
	v2 := e.fork(id, 3)
	fresh("a second fork", v2.ID, true, 100)
	e.claude.lastFork(t).failSends(errors.New("refused"))
	if err := e.m.Send(v2.ID, "never taken", "", nil); err == nil {
		t.Fatal("the refusing agent took the message")
	}
	fresh("after a refused message", v2.ID, false, 0)

	// A fork of a fresh fork keeps the context of the first source: its own turn has reported none.
	v3 := e.fork(id, 3)
	v4 := e.fork(v3.ID, 3)
	fresh("a fork of a fresh fork", v4.ID, true, 100)
	fresh("the fork it was made of", v3.ID, true, 100)

	// A fork at the start has no conversation: it is a chat not started, never fresh.
	v0 := e.fork(id, 0)
	if v0.Locked {
		t.Fatalf("the fork at the start %+v", v0)
	}
	fresh("a fork at the start", v0.ID, false, 100)
	e.send(v0.ID, "start", "")
	fresh("a fork at the start, after its first message", v0.ID, false, 0)

	// A fork made before there was the flag has none in its file: it stays not fresh, also
	// after a restart. One that has it keeps it.
	old := e.meta(v3.ID)
	old.Fresh, old.SourceCtx = false, 0
	e.writeMeta(old)
	e.m.naming.Wait()
	e.boot()
	fresh("a fork without the flag, after a restart", v3.ID, false, 0)
	fresh("a fresh fork, after a restart", v4.ID, true, 100)
	if v := e.view(v3.ID); !v.Locked || v.ForkedFrom != id {
		t.Fatalf("the fork without the flag %+v", v)
	}
	e.send(v3.ID, "on the old fork", "")
	fresh("a fork without the flag, after its first message", v3.ID, false, 0)
}

func TestForkWindowRefused(t *testing.T) {
	e := newEnv(t)
	id, _ := e.piTalked()
	dirs := e.chatDirs()
	untouched := func(when string) {
		t.Helper()
		if !reflect.DeepEqual(e.chatDirs(), dirs) || len(e.pi.forkCalls()) != 0 || len(e.m.Views()) != 1 {
			t.Fatalf("%s: folders %v (were %v), %d fork starts, %d chats", when, e.chatDirs(), dirs, len(e.pi.forkCalls()), len(e.m.Views()))
		}
	}
	for _, at := range []int{3, 6} {
		_, err := e.forkWith(id, at, "small", "")
		if !errors.Is(err, ErrWindow) || !strings.Contains(err.Error(), "Small takes 32000 tokens and the conversation holds about 20000") {
			t.Fatalf("a fork at %d on a model too small: %v", at, err)
		}
		untouched("the window refusal")
	}
	if _, err := e.forkWith(id, 4, "small", ""); !errors.Is(err, ErrBadPoint) { // the point comes first
		t.Fatalf("a bad point with a model too small: %v", err)
	}
	untouched("a bad point")

	// At the start the model is given nothing; a model whose window is not known passes.
	v0, err := e.forkWith(id, 0, "small", "")
	if err != nil || v0.Model != "small" || v0.Effort != "" || v0.Usage.CtxWindow != 32_000 || v0.Fresh || v0.Locked {
		t.Fatalf("a fork at the start on the small model: %+v, %v", v0, err)
	}
	v1, err := e.forkWith(id, 3, "unsized", "")
	if err != nil || v1.Model != "unsized" || v1.Usage.CtxWindow != 0 || !v1.Fresh {
		t.Fatalf("a fork on a model without a known window: %+v, %v", v1, err)
	}
	// The same model, and one with room.
	v2, err := e.forkWith(id, 3, "big", "high")
	if err != nil || v2.Model != "big" || v2.Effort != "high" || v2.Usage.CtxWindow != 200_000 {
		t.Fatalf("a fork on the source's model: %+v, %v", v2, err)
	}
	// A fork of that fork, which has had no turn: the guard has the first source's context.
	if m := e.meta(v2.ID); m.Usage.CtxIn != 0 || m.SourceCtx != piCtx {
		t.Fatalf("the fork's chat.json %+v", m)
	}
	n := len(e.pi.forkCalls())
	if _, err := e.m.Fork(v2.ID, ForkReq{Branch: model.MainBranch, At: 3, Model: "small"}); !errors.Is(err, ErrWindow) {
		t.Fatalf("a fork of a fresh fork on a model too small: %v", err)
	}
	if len(e.pi.forkCalls()) != n {
		t.Fatal("a fork was started for the refused choice")
	}
}

func TestChoiceDoesNotRecordDefaults(t *testing.T) {
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 2)
	was := e.defaultsOf()
	if mc := was.Last.ByAgent[model.Claude]; mc.Model != "sonnet" || mc.Effort != "high" || was.Last.Cwd != e.cwd {
		t.Fatalf("the defaults the chat's first message recorded %+v", was)
	}
	same := func(when string) {
		t.Helper()
		if got := e.defaultsOf(); !reflect.DeepEqual(got, was) {
			t.Fatalf("%s: the defaults %+v, were %+v", when, got, was)
		}
	}

	// A new branch, at a point and at the start.
	_, _, ba := e.branchTo(id, Target{Branch: model.MainBranch, At: 3, New: true, Model: "haiku"}, "aside")
	ba.emit(t, reply("q1")...)
	same("a branch on another model")
	_, _, ba = e.branchTo(id, Target{Branch: model.MainBranch, At: 0, New: true, Model: "opus", Effort: "max"}, "from the start")
	ba.emit(t, reply("q2")...)
	same("a branch at the start on another model")

	// A fork with a conversation, and its first message.
	v, err := e.forkWith(id, 3, "opus", "low")
	if err != nil {
		t.Fatal(err)
	}
	same("a fork on another model")
	e.send(v.ID, "on the fork", "")
	e.claude.lastFork(t).emit(t, reply("f1")...)
	same("the fork's first message")

	// A fork at the start is a chat not started: it can be configured and its first message
	// confirms its settings, but only its folder becomes a default.
	v0, err := e.forkWith(id, 0, "haiku", "")
	if err != nil {
		t.Fatal(err)
	}
	same("a fork at the start on another model")
	if err := e.m.Configure(v0.ID, ConfigReq{Model: "opus", Effort: "max"}); err != nil {
		t.Fatal(err)
	}
	if m := e.meta(v0.ID); m.Model != "opus" || m.Effort != "max" {
		t.Fatalf("the configured fork %+v", m)
	}
	same("a fork at the start, configured")
	dir := t.TempDir()
	if err := e.m.Configure(v0.ID, ConfigReq{Cwd: dir, Model: "haiku"}); err != nil {
		t.Fatal(err)
	}
	folder := func(when string) {
		t.Helper()
		got := e.defaultsOf()
		if got.Last.Cwd != dir || got.Groups[gOne].Cwd != dir {
			t.Fatalf("%s: the folder was not recorded: %+v", when, got)
		}
		if !reflect.DeepEqual(got.Last.ByAgent, was.Last.ByAgent) || !reflect.DeepEqual(got.Groups[gOne].ByAgent, was.Groups[gOne].ByAgent) {
			t.Fatalf("%s: the defaults took the fork's choice: %+v, were %+v", when, got, was)
		}
	}
	folder("a fork at the start, given a folder")
	e.send(v0.ID, "start", "")
	folder("the first message of a fork at the start")

	// A chat that is neither still records its choice.
	c := e.create(model.Claude, gOne, "")
	e.configure(c.ID, ConfigReq{Model: "opus", Effort: "max"})
	if mc := e.defaultsOf().Last.ByAgent[model.Claude]; mc.Model != "opus" || mc.Effort != "max" {
		t.Fatalf("a new chat's choice was not recorded: %+v", mc)
	}
}
