package app

import (
	"errors"
	"io/fs"
	"os"
	"sync"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

// ---- fakes ----------------------------------------------------------------

type fakeAgent struct {
	ch     chan agent.Event
	mu     sync.Mutex
	closed bool
}

func (a *fakeAgent) Events() <-chan agent.Event      { return a.ch }
func (a *fakeAgent) Send([]agent.ContentBlock) error { return nil }
func (a *fakeAgent) Interrupt() error                { return nil }
func (a *fakeAgent) Decide(string, bool) error       { return nil }
func (a *fakeAgent) isClosed() bool                  { a.mu.Lock(); defer a.mu.Unlock(); return a.closed }
func (a *fakeAgent) Close()                          { a.mu.Lock(); a.closed = true; a.mu.Unlock() }

type fakeSpawner struct {
	mu     sync.Mutex
	agents map[string]*fakeAgent // by chat id
}

func (s *fakeSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	a := &fakeAgent{ch: make(chan agent.Event)}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.agents[o.ChatID] = a
	return a, nil
}

func (s *fakeSpawner) of(t *testing.T, chatID string) *fakeAgent {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.agents[chatID]
	if a == nil {
		t.Fatalf("no agent spawned for %s", chatID)
	}
	return a
}

// ---- environment ----------------------------------------------------------

type env struct {
	t  *testing.T
	st *store.Store
	sp *fakeSpawner
	a  *App
}

func newEnv(t *testing.T) *env {
	t.Helper()
	root := t.TempDir()
	st, err := store.Open(store.NewPaths(root))
	if err != nil {
		t.Fatal(err)
	}
	br := editorbridge.New(func() any { return nil })
	bds := boards.New(st, br)
	sp := &fakeSpawner{agents: map[string]*fakeAgent{}}
	cm := chats.New(chats.Deps{Store: st, Bridge: br, Boards: bds,
		Spawners:   map[model.AgentKind]agent.Spawner{model.Claude: sp, model.Cursor: sp},
		DefaultCwd: t.TempDir(), BaseURL: "http://127.0.0.1:1"})
	a := &App{St: st, Boards: bds, Chats: cm, Bridge: br, DataDir: root}
	return &env{t: t, st: st, sp: sp, a: a}
}

func (e *env) group(name string) string {
	e.t.Helper()
	g, err := e.a.CreateGroup(name)
	if err != nil {
		e.t.Fatal(err)
	}
	return g.ID
}

func (e *env) board(group string) string {
	e.t.Helper()
	b, err := e.a.Boards.Create("board", group, false)
	if err != nil {
		e.t.Fatal(err)
	}
	return b.ID
}

func (e *env) chat(group, board string) string {
	e.t.Helper()
	c, err := e.a.Chats.Create(model.Claude, group, board)
	if err != nil {
		e.t.Fatal(err)
	}
	return c.ID
}

// running creates a chat and sends a message, so it has a live agent.
func (e *env) running(group, board string) string {
	e.t.Helper()
	id := e.chat(group, board)
	if err := e.a.Chats.Send(id, "hi", ""); err != nil {
		e.t.Fatal(err)
	}
	return id
}

func (e *env) chatArchive(id string) model.Archive {
	e.t.Helper()
	v, err := e.a.Chats.View(id)
	if err != nil {
		e.t.Fatal(err)
	}
	return v.Archive
}

func (e *env) boardArchive(id string) model.Archive {
	e.t.Helper()
	b, ok := e.a.Boards.Get(id)
	if !ok {
		e.t.Fatalf("no board %s", id)
	}
	return b.Archive
}

func (e *env) groupArchive(id string) model.Archive {
	e.t.Helper()
	g, err := e.a.group(id)
	if err != nil {
		e.t.Fatal(err)
	}
	return g.Archive
}

func (e *env) must(err error) {
	e.t.Helper()
	if err != nil {
		e.t.Fatal(err)
	}
}

// ---- tests ----------------------------------------------------------------

func TestArchiveBoardArchivesChatsWithOneOpAndStopsAgents(t *testing.T) {
	e := newEnv(t)
	g := e.group("G")
	b := e.board(g)
	c1 := e.running("", b)
	c2 := e.running("", b)
	other := e.running(g, "") // a plain chat in the same group is untouched

	e.must(e.a.Archive(KindBoard, b))

	ba := e.boardArchive(b)
	if !ba.Archived || ba.Op == "" {
		t.Fatalf("board not archived: %+v", ba)
	}
	for _, c := range []string{c1, c2} {
		if ca := e.chatArchive(c); ca != ba {
			t.Errorf("chat %s archive %+v, want %+v", c, ca, ba)
		}
		if !e.sp.of(t, c).isClosed() {
			t.Errorf("agent of %s not stopped", c)
		}
	}
	if e.chatArchive(other).Archived || e.sp.of(t, other).isClosed() {
		t.Error("plain chat of the group was archived or stopped")
	}
}

func TestUnarchiveBoardChatBringsBoardBackOnly(t *testing.T) {
	e := newEnv(t)
	b := e.board(model.Ungrouped)
	c1 := e.chat("", b)
	c2 := e.chat("", b)
	e.must(e.a.Archive(KindBoard, b))

	e.must(e.a.Unarchive(KindChat, c1))

	if e.chatArchive(c1).Archived {
		t.Error("chat still archived")
	}
	if e.boardArchive(b).Archived {
		t.Error("board still archived")
	}
	if !e.chatArchive(c2).Archived {
		t.Error("the board's other chat came back")
	}
}

func TestUnarchiveBoardBringsBackOnlyWhatWentWithIt(t *testing.T) {
	e := newEnv(t)
	b := e.board(model.Ungrouped)
	early := e.chat("", b)
	with := e.chat("", b)
	e.must(e.a.Archive(KindChat, early))
	earlyOp := e.chatArchive(early).Op
	e.must(e.a.Archive(KindBoard, b))
	if e.chatArchive(early).Op != earlyOp {
		t.Fatal("archiving the board re-archived an already archived chat")
	}

	e.must(e.a.Unarchive(KindBoard, b))

	if e.boardArchive(b).Archived {
		t.Error("board still archived")
	}
	if e.chatArchive(with).Archived {
		t.Error("the chat archived with the board stays archived")
	}
	if !e.chatArchive(early).Archived {
		t.Error("the chat archived earlier came back")
	}
}

func TestArchiveAndUnarchiveGroup(t *testing.T) {
	e := newEnv(t)
	g := e.group("G")
	b := e.board(g)
	bc := e.running("", b)
	pc := e.running(g, "")
	outside := e.chat(model.Ungrouped, "")

	e.must(e.a.Archive(KindGroup, g))

	ga := e.groupArchive(g)
	if !ga.Archived || ga.Op == "" {
		t.Fatalf("group not archived: %+v", ga)
	}
	if e.boardArchive(b) != ga || e.chatArchive(bc) != ga || e.chatArchive(pc) != ga {
		t.Error("not everything in the group shares the group's op")
	}
	if !e.sp.of(t, bc).isClosed() || !e.sp.of(t, pc).isClosed() {
		t.Error("agents not stopped")
	}
	if e.chatArchive(outside).Archived {
		t.Error("chat outside the group archived")
	}

	e.must(e.a.Unarchive(KindGroup, g))

	if e.groupArchive(g).Archived || e.boardArchive(b).Archived || e.chatArchive(bc).Archived || e.chatArchive(pc).Archived {
		t.Error("not everything came back")
	}
}

func TestDeleteGroupWithContents(t *testing.T) {
	e := newEnv(t)
	g := e.group("G")
	b := e.board(g)
	bc := e.running("", b)
	pc := e.chat(g, "")
	p := e.st.P

	e.must(e.a.DeleteGroup(g, true))

	if _, err := os.Stat(p.BoardDir(b)); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("board folder left: %v", err)
	}
	if _, ok := e.a.Boards.Get(b); ok {
		t.Error("board still registered")
	}
	for _, c := range []string{bc, pc} {
		if _, err := os.Stat(p.ChatDir(c)); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("chat folder %s left: %v", c, err)
		}
		if _, err := e.a.Chats.View(c); !errors.Is(err, chats.ErrNotFound) {
			t.Errorf("chat %s still there", c)
		}
	}
	if !e.sp.of(t, bc).isClosed() {
		t.Error("agent not stopped")
	}
	if _, err := e.a.group(g); err == nil {
		t.Error("group still there")
	}
}

func TestDeleteGroupUngroupsContents(t *testing.T) {
	e := newEnv(t)
	g := e.group("G")
	b := e.board(g)
	bc := e.chat("", b)
	pc := e.chat(g, "")

	e.must(e.a.DeleteGroup(g, false))

	if bd, ok := e.a.Boards.Get(b); !ok || bd.Group != model.Ungrouped {
		t.Errorf("board %+v, want ungrouped", bd)
	}
	for _, c := range []string{bc, pc} {
		v, err := e.a.Chats.View(c)
		if err != nil {
			t.Fatal(err)
		}
		if got := e.a.Chats.GroupOf(model.ChatMeta{Board: v.Board, Group: v.Group}); got != model.Ungrouped {
			t.Errorf("chat %s in %q, want ungrouped", c, got)
		}
	}
	snap := e.a.Snapshot()
	for _, gr := range snap.Groups {
		if gr.ID == g {
			t.Error("group still listed")
		}
	}
	if _, ok := snap.Defaults.Groups[g]; ok {
		t.Error("group's defaults left behind")
	}
}

func TestCreateGroupSeedsDefaultsFromLast(t *testing.T) {
	e := newEnv(t)
	last := model.GroupDefaults{Cwd: t.TempDir(), ByAgent: map[model.AgentKind]model.ModelChoice{
		model.Claude: {Model: "opus", Effort: "max"}}}
	e.must(e.st.Update(func(s *model.State) error { s.Defaults.Last = last; return nil }))

	g, err := e.a.CreateGroup("  ")
	if err != nil {
		t.Fatal(err)
	}
	if g.Name != "New group" {
		t.Errorf("name %q", g.Name)
	}
	snap := e.a.Snapshot()
	gd := snap.Defaults.Groups[g.ID]
	if gd.Cwd != last.Cwd || gd.ByAgent[model.Claude] != last.ByAgent[model.Claude] {
		t.Errorf("seeded %+v, want %+v", gd, last)
	}
	// a deep copy: changing last later leaves the group alone
	e.must(e.st.Update(func(s *model.State) error {
		s.Defaults.Last.ByAgent[model.Claude] = model.ModelChoice{Model: "haiku"}
		return nil
	}))
	if e.a.Snapshot().Defaults.Groups[g.ID].ByAgent[model.Claude].Model != "opus" {
		t.Error("group defaults share last's map")
	}
}

func TestMoveBoardMovesItsChats(t *testing.T) {
	e := newEnv(t)
	g1, g2 := e.group("One"), e.group("Two")
	b := e.board(g1)
	c := e.chat("", b)
	meta := e.a.Chats.ChatsOfBoard(b)[0]
	if meta.ID != c || e.a.Chats.GroupOf(meta) != g1 {
		t.Fatalf("chat starts in %q", e.a.Chats.GroupOf(meta))
	}

	e.must(e.a.MoveBoard(b, g2))

	if got := e.a.Chats.GroupOf(e.a.Chats.ChatsOfBoard(b)[0]); got != g2 {
		t.Errorf("GroupOf = %q, want %q", got, g2)
	}
}

func TestGroupsUpdateAndReorder(t *testing.T) {
	e := newEnv(t)
	g1, g2, g3 := e.group("A"), e.group("B"), e.group("C")
	name, col := "  Renamed ", true
	e.must(e.a.UpdateGroup(g2, &name, &col))
	empty := " "
	if err := e.a.UpdateGroup(g2, &empty, nil); err == nil {
		t.Error("empty name accepted")
	}
	if err := e.a.ReorderGroups([]string{g1, g2}); err == nil {
		t.Error("partial order accepted")
	}
	if err := e.a.ReorderGroups([]string{g1, g1, g2}); err == nil {
		t.Error("duplicate order accepted")
	}
	e.must(e.a.ReorderGroups([]string{g3, g1, g2}))
	gs := e.a.Snapshot().Groups
	if len(gs) != 3 || gs[0].ID != g3 || gs[1].ID != g1 || gs[2].ID != g2 {
		t.Fatalf("order %+v", gs)
	}
	if gs[2].Name != "Renamed" || !gs[2].Collapsed {
		t.Errorf("group %+v", gs[2])
	}
}

func TestSnapshotCatalogs(t *testing.T) {
	e := newEnv(t)
	snap := e.a.Snapshot()
	if snap.Catalogs[model.Claude] == nil || snap.Catalogs[model.Claude].Default.Model != "sonnet" {
		t.Error("Claude catalog missing")
	}
	if snap.Catalogs[model.Cursor] != nil {
		t.Error("Cursor catalog before it is known")
	}
	cat := &model.Catalog{Models: []model.CatalogModel{{ID: "composer-2"}}, Default: model.ModelChoice{Model: "composer-2"}}
	e.must(e.st.Update(func(s *model.State) error { s.Cursor = cat; return nil }))
	if c := e.a.Snapshot().Catalogs[model.Cursor]; c == nil || c.Default.Model != "composer-2" {
		t.Error("stored Cursor catalog not reported")
	}
}
