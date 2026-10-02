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
	return e.subgroup(name, "")
}

func (e *env) subgroup(name, parent string) string {
	e.t.Helper()
	g, err := e.a.CreateGroup(name, parent)
	if err != nil {
		e.t.Fatal(err)
	}
	return g.ID
}

// groupOf is the group a chat is listed in.
func (e *env) groupOf(chat string) string {
	e.t.Helper()
	v, err := e.a.Chats.View(chat)
	if err != nil {
		e.t.Fatal(err)
	}
	return e.a.Chats.GroupOf(model.ChatMeta{Board: v.Board, Group: v.Group})
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
	if err := e.a.Chats.Send(id, "hi", "", nil); err != nil {
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

	g, err := e.a.CreateGroup("  ", "")
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

func TestCreateSubgroup(t *testing.T) {
	e := newEnv(t)
	g := e.group("G")
	cwd := t.TempDir()
	e.must(e.st.Update(func(s *model.State) error {
		s.Defaults.Groups[g] = model.GroupDefaults{Cwd: cwd, ByAgent: map[model.AgentKind]model.ModelChoice{model.Claude: {Model: "opus"}}}
		s.Defaults.Last = model.GroupDefaults{Cwd: t.TempDir()}
		return nil
	}))
	s := e.subgroup("S", g)
	sg, err := e.a.group(s)
	if err != nil || sg.Parent != g {
		t.Fatalf("subgroup %+v, %v", sg, err)
	}
	if gd := e.a.Snapshot().Defaults.Groups[s]; gd.Cwd != cwd || gd.ByAgent[model.Claude].Model != "opus" {
		t.Errorf("subgroup defaults %+v, want the parent's", gd)
	}

	if _, err := e.a.CreateGroup("X", "g_missing"); !errors.Is(err, ErrGroupNotFound) {
		t.Errorf("missing parent: %v", err)
	}
	if _, err := e.a.CreateGroup("X", e.board(g)); !errors.Is(err, ErrGroupNotFound) {
		t.Errorf("a board as parent: %v", err)
	}
	e.must(e.a.Archive(KindGroup, g))
	if _, err := e.a.CreateGroup("X", g); !errors.Is(err, ErrGroupArchived) {
		t.Errorf("archived parent: %v", err)
	}
}

func TestMoveGroup(t *testing.T) {
	e := newEnv(t)
	a, b := e.group("A"), e.group("B")
	s := e.subgroup("S", a)
	ss := e.subgroup("SS", s)

	for _, p := range []string{a, s, ss} {
		if err := e.a.MoveGroup(a, p, ""); err == nil {
			t.Errorf("A moved inside %s", p)
		}
	}
	if err := e.a.MoveGroup(b, e.board(a), ""); !errors.Is(err, ErrGroupNotFound) {
		t.Errorf("a board as parent: %v", err)
	}

	// S (with SS) goes to the top level, before A
	e.must(e.a.MoveGroup(s, "", a))
	gs := e.a.Snapshot().Groups
	if gs[0].ID != s || gs[0].Parent != "" || gs[1].ID != a {
		t.Fatalf("order %+v", gs)
	}
	if g, _ := e.a.group(ss); g.Parent != s {
		t.Errorf("SS left its parent: %+v", g)
	}

	// B into S, last
	e.must(e.a.MoveGroup(b, s, ""))
	gs = e.a.Snapshot().Groups
	if last := gs[len(gs)-1]; last.ID != b || last.Parent != s {
		t.Errorf("B %+v", last)
	}

	e.must(e.a.Archive(KindGroup, a))
	if err := e.a.MoveGroup(b, a, ""); !errors.Is(err, ErrGroupArchived) {
		t.Errorf("into an archived group: %v", err)
	}
}

func TestArchiveGroupArchivesSubgroups(t *testing.T) {
	e := newEnv(t)
	g := e.group("G")
	s := e.subgroup("S", g)
	ss := e.subgroup("SS", s)
	early := e.subgroup("Early", g)
	b := e.board(ss)
	bc := e.running("", b)
	pc := e.chat(s, "")
	ec := e.chat(early, "")
	e.must(e.a.Archive(KindGroup, early))
	earlyOp := e.groupArchive(early).Op

	e.must(e.a.Archive(KindGroup, g))

	op := e.groupArchive(g).Op
	for _, ar := range []model.Archive{e.groupArchive(s), e.groupArchive(ss), e.boardArchive(b), e.chatArchive(bc), e.chatArchive(pc)} {
		if !ar.Archived || ar.Op != op {
			t.Errorf("%+v, want archived with op %s", ar, op)
		}
	}
	if !e.sp.of(t, bc).isClosed() {
		t.Error("agent in a subgroup not stopped")
	}
	if e.groupArchive(early).Op != earlyOp || e.chatArchive(ec).Op != earlyOp {
		t.Error("an already archived subgroup was re-archived")
	}

	e.must(e.a.Unarchive(KindGroup, g))
	for _, ar := range []model.Archive{e.groupArchive(g), e.groupArchive(s), e.groupArchive(ss), e.boardArchive(b), e.chatArchive(bc), e.chatArchive(pc)} {
		if ar.Archived {
			t.Errorf("%+v still archived", ar)
		}
	}
	if !e.groupArchive(early).Archived || !e.chatArchive(ec).Archived {
		t.Error("a subgroup archived on its own came back")
	}
}

func TestUnarchiveBringsBackParentGroups(t *testing.T) {
	e := newEnv(t)
	g := e.group("G")
	s := e.subgroup("S", g)
	ss := e.subgroup("SS", s)
	gc := e.chat(g, "")
	sc := e.chat(s, "")
	ssc := e.chat(ss, "")
	e.must(e.a.Archive(KindGroup, g))

	// a subgroup comes back with its contents and its parents' records, not their contents
	e.must(e.a.Unarchive(KindGroup, s))
	if e.groupArchive(g).Archived || e.groupArchive(s).Archived || e.groupArchive(ss).Archived {
		t.Error("groups on the path still archived")
	}
	if e.chatArchive(sc).Archived || e.chatArchive(ssc).Archived {
		t.Error("the subgroup's contents still archived")
	}
	if !e.chatArchive(gc).Archived {
		t.Error("the parent's own chat came back")
	}

	// a chat deep inside brings back every group above it
	e.must(e.a.Archive(KindGroup, g))
	e.must(e.a.Unarchive(KindChat, ssc))
	if e.groupArchive(g).Archived || e.groupArchive(s).Archived || e.groupArchive(ss).Archived {
		t.Error("groups above the chat still archived")
	}
	if !e.chatArchive(sc).Archived {
		t.Error("a sibling chat came back")
	}
}

func TestDeleteGroupKeepMovesContentsToParent(t *testing.T) {
	e := newEnv(t)
	g := e.group("G")
	s := e.subgroup("S", g)
	ss := e.subgroup("SS", s)
	b := e.board(s)
	bc := e.chat("", b)
	pc := e.chat(s, "")
	ssc := e.chat(ss, "")

	e.must(e.a.DeleteGroup(s, false))

	if bd, _ := e.a.Boards.Get(b); bd.Group != g {
		t.Errorf("board in %q, want %q", bd.Group, g)
	}
	for _, c := range []string{bc, pc} {
		if got := e.groupOf(c); got != g {
			t.Errorf("chat %s in %q, want %q", c, got, g)
		}
	}
	if sg, err := e.a.group(ss); err != nil || sg.Parent != g {
		t.Errorf("SS %+v %v, want it under G", sg, err)
	}
	if e.groupOf(ssc) != ss {
		t.Error("SS's chat moved")
	}
	if _, err := e.a.group(s); err == nil {
		t.Error("S still there")
	}
}

func TestDeleteGroupWithContentsDeletesSubgroups(t *testing.T) {
	e := newEnv(t)
	g := e.group("G")
	s := e.subgroup("S", g)
	b := e.board(s)
	pc := e.chat(s, "")
	other := e.group("Other")

	e.must(e.a.DeleteGroup(g, true))

	if _, ok := e.a.Boards.Get(b); ok {
		t.Error("board in a subgroup still there")
	}
	if _, err := e.a.Chats.View(pc); !errors.Is(err, chats.ErrNotFound) {
		t.Error("chat in a subgroup still there")
	}
	snap := e.a.Snapshot()
	if len(snap.Groups) != 1 || snap.Groups[0].ID != other {
		t.Errorf("groups %+v, want only Other", snap.Groups)
	}
	if _, ok := snap.Defaults.Groups[s]; ok {
		t.Error("subgroup's defaults left behind")
	}
}

func TestSnapshotCatalogs(t *testing.T) {
	e := newEnv(t)
	snap := e.a.Snapshot()
	if snap.Catalogs[model.Claude] == nil || snap.Catalogs[model.Claude].Default.Model != "sonnet" {
		t.Error("Claude catalog missing")
	}
	if snap.Catalogs[model.Claude] != nil && snap.Catalogs[model.Claude].Models[0].Provider != "" {
		t.Error("Claude catalog gained a provider")
	}
	if snap.Catalogs[model.Cursor] != nil {
		t.Error("Cursor catalog before it is known")
	}
	if c, ok := snap.Catalogs[model.Pi]; !ok || c != nil {
		t.Errorf("pi catalog before it is known: value %v, present %v", c, ok)
	}
	cat := &model.Catalog{Models: []model.CatalogModel{{ID: "composer-2"}}, Default: model.ModelChoice{Model: "composer-2"}}
	e.must(e.st.Update(func(s *model.State) error { s.Cursor = cat; return nil }))
	if c := e.a.Snapshot().Catalogs[model.Cursor]; c == nil || c.Default.Model != "composer-2" || c.Models[0].Provider != "" {
		t.Error("stored Cursor catalog not reported")
	}
	piCat := &model.Catalog{
		Models:  []model.CatalogModel{{ID: "deepseek-flash", Label: "DeepSeek Flash", Provider: "deepseek"}},
		Default: model.ModelChoice{Model: "deepseek-flash"},
	}
	e.must(e.st.Update(func(s *model.State) error { s.SetCatalog(model.Pi, piCat); return nil }))
	if c := e.a.Snapshot().Catalogs[model.Pi]; c == nil || c.Default.Model != "deepseek-flash" || c.Models[0].Provider != "deepseek" {
		t.Error("stored pi catalog not reported with its provider")
	}

	// Reading the catalog through the snapshot twice must not change what is stored.
	first := e.a.Snapshot().Catalogs[model.Pi]
	second := e.a.Snapshot().Catalogs[model.Pi]
	if first == nil || second == nil || first.Models[0].Provider != "deepseek" || second.Models[0].Provider != "deepseek" {
		t.Fatalf("snapshot reads lost the provider: first %+v, second %+v", first, second)
	}
	e.st.Read(func(s *model.State) {
		if c := s.Catalog(model.Pi); c == nil || len(c.Models) != 1 || c.Models[0].Provider != "deepseek" {
			t.Errorf("stored pi catalog changed after two snapshot reads: %+v", c)
		}
	})
}
