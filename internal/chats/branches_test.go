package chats

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
	"ai-whiteboard/internal/transcript"
)

// ---- fixtures -------------------------------------------------------------

func (e *env) writeMeta(meta model.ChatMeta) {
	e.t.Helper()
	if err := store.WriteJSONAtomic(filepath.Join(e.st.P.ChatDir(meta.ID), "chat.json"), meta, 0o600); err != nil {
		e.t.Fatal(err)
	}
}

// writeBranch writes the folder of the branch b of a chat as a Send with a target leaves it:
// items.jsonl, and a chat.json with the branch's server id, a token and a session id of its own
// and the chat's agent and settings, started. It returns that meta.
func (e *env) writeBranch(chat, b string, items []model.Item) model.ChatMeta {
	e.t.Helper()
	top := e.meta(chat)
	meta := model.ChatMeta{ID: branchChatID(chat, b), Agent: top.Agent, Board: top.Board, Cwd: top.Cwd,
		Model: top.Model, Effort: top.Effort, Created: time.Now(), Token: randHex(16),
		SessionID: "ses-" + b, Locked: len(items) > 0}
	if meta.Locked {
		meta.Usage.Turns = 1
	}
	e.writeItems(meta.ID, items)
	e.writeMeta(meta)
	return meta
}

// branched makes a chat of agent kind holding the worked example's two branches, on disk and in
// the tree record, with cur as the record's current branch ("" = main), and restarts the manager,
// so that nothing of the chat is loaded. It returns the chat's id and the branch's server id.
func (e *env) branched(kind model.AgentKind, board, cur string) (id, bid string) {
	e.t.Helper()
	group := gOne
	if board != "" {
		group = ""
	}
	v := e.create(kind, group, board)
	meta := e.meta(v.ID)
	meta.Locked = true
	meta.Usage.Turns = 2
	if meta.SessionID == "" { // Cursor's comes from its first session
		meta.SessionID = "ses-main"
	}
	e.writeMeta(meta)
	e.writeItems(v.ID, exampleMain())
	e.writeBranch(v.ID, exBranch, exampleBranch())
	tr := exampleTree
	tr.Current = cur
	e.writeTree(v.ID, tr)
	e.boot()
	return v.ID, branchChatID(v.ID, exBranch)
}

// diskItems is what the items.jsonl of the chat or branch with server id id holds.
func (e *env) diskItems(id string) []model.Item {
	e.t.Helper()
	tr, err := transcript.Load(e.m.itemsPath(id))
	if err != nil {
		e.t.Fatal(err)
	}
	_, items := tr.Snapshot()
	return items
}

func (e *env) file(id, name string) []byte {
	e.t.Helper()
	raw, err := os.ReadFile(filepath.Join(e.st.P.ChatDir(id), name))
	if err != nil {
		e.t.Fatal(err)
	}
	return raw
}

// loaded reports whether the transcript of the chat object with server id id is in memory.
func (e *env) loaded(id string) bool {
	e.t.Helper()
	c, err := e.m.get(id)
	if err != nil {
		e.t.Fatal(err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.tr != nil
}

func (e *env) makeCurrent(id, branch string) {
	e.t.Helper()
	if err := e.m.setCurrent(id, branch); err != nil {
		e.t.Fatal(err)
	}
}

// bothRunning gives both branches of a branched chat a process: main's first, then the branch's,
// which is left current. Both are idle afterwards.
func (e *env) bothRunning(id string) (mainAg, branchAg *fakeAgent) {
	e.t.Helper()
	e.send(id, "on main", "")
	mainAg = e.claude.last(e.t)
	mainAg.emit(e.t, agent.Event{Kind: agent.EvTurnEnd, Point: "p3"})
	e.makeCurrent(id, exBranch)
	e.send(id, "on the branch", "")
	branchAg = e.claude.last(e.t)
	branchAg.emit(e.t, agent.Event{Kind: agent.EvTurnEnd, Point: "q2"})
	if mainAg == branchAg {
		e.t.Fatal("one process for both branches")
	}
	return mainAg, branchAg
}

func chatOf(t *testing.T, ev map[string]any) map[string]any {
	t.Helper()
	c, ok := ev["chat"].(map[string]any)
	if !ok {
		t.Fatalf("no chat view in %v", ev)
	}
	return c
}

// ---- boot -----------------------------------------------------------------

func TestBootRegistersBranches(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", exBranch)

	vs := e.m.Views()
	if len(vs) != 1 || vs[0].ID != id || vs[0].Branches != 2 || vs[0].Branch != exBranch {
		t.Fatalf("views %+v", vs)
	}
	js := asJSON(t, vs[0]).(map[string]any)
	if js["branches"] != 2.0 || js["branch"] != exBranch || js["id"] != id {
		t.Fatalf("view as JSON %v", js)
	}
	if got := e.items(id); !reflect.DeepEqual(got, exampleBranch()) {
		t.Fatalf("Items of the chat are not its current branch's: %+v", got)
	}
	if e.loaded(id) {
		t.Fatal("reading the current branch loaded main")
	}
	tok := e.meta(bid).Token
	caller, ok := e.m.ResolveToken(tok)
	if !ok || caller.Chat != id || caller.Meta.ID != bid || caller.Subagent || caller.Kind != model.Claude {
		t.Fatalf("the branch's token: %+v, %v", caller, ok)
	}
	if meta, ok := e.m.ByToken(tok); !ok || meta.ID != bid {
		t.Fatalf("ByToken of the branch's token: %+v, %v", meta, ok)
	}
	if caller, ok := e.m.ResolveToken(e.meta(id).Token); !ok || caller.Chat != id || caller.Meta.ID != id {
		t.Fatalf("main's token: %+v, %v", caller, ok)
	}
	if tv := e.tree(id); tv.Current != exBranch || len(tv.Branches) != 2 {
		t.Fatalf("tree %+v", tv)
	}
	// A branch's server id names no chat to a client.
	if _, err := e.m.View(bid); !errors.Is(err, ErrNotFound) {
		t.Fatalf("View of a branch's server id: %v", err)
	}
	if err := e.m.Send(bid, "x", "", nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Send to a branch's server id: %v", err)
	}
	if err := e.m.Delete(bid); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Delete of a branch's server id: %v", err)
	}
}

func TestBootBoardChatBranchesAreNotListed(t *testing.T) {
	e := newEnv(t)
	bd, err := e.bds.Create("board", gTwo, false)
	if err != nil {
		t.Fatal(err)
	}
	id, bid := e.branched(model.Claude, bd.ID, exBranch)
	if got := e.m.ChatsOfBoard(bd.ID); len(got) != 1 || got[0].ID != id {
		t.Fatalf("ChatsOfBoard %+v", got)
	}
	// A branch reads its group from its top-level chat: here the board's.
	if g := e.m.GroupOf(e.meta(bid)); g != gTwo {
		t.Fatalf("group of the branch %q", g)
	}
}

func TestGroupOfBranch(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", exBranch)
	if g := e.m.GroupOf(e.meta(bid)); g != gOne {
		t.Fatalf("group of the branch %q", g)
	}
	if err := e.m.Move(id, gTwo); err != nil {
		t.Fatal(err)
	}
	if g := e.m.GroupOf(e.meta(bid)); g != gTwo {
		t.Fatalf("group of the branch after a move %q", g)
	}
}

func TestBootSkipsWhatIsNotABranch(t *testing.T) {
	e := newEnv(t)
	id, _ := e.branched(model.Claude, "", "")

	// A top-level folder without chat.json.
	e.writeItems("nochat", exampleMain())
	// A complete branch folder the record does not name.
	stray := e.writeBranch(id, "0000000a", exampleBranch())
	// Recorded, with its thread but no chat.json: the current one.
	e.writeItems(branchChatID(id, "00000001"), exampleBranch())
	// Recorded and complete, but split from the branch that is skipped.
	child := e.writeBranch(id, "00000002", exampleBranch())
	// Recorded, with a chat.json that cannot be read.
	e.writeItems(branchChatID(id, "00000003"), exampleBranch())
	if err := os.WriteFile(filepath.Join(e.st.P.ChatDir(branchChatID(id, "00000003")), "chat.json"), []byte(`{"id":`), 0o600); err != nil {
		t.Fatal(err)
	}
	// Recorded, with the chat.json of another chat object.
	other := e.writeBranch(id, "00000004", exampleBranch())
	other.ID = branchChatID(id, "0000000b")
	if err := store.WriteJSONAtomic(filepath.Join(e.st.P.ChatDir(branchChatID(id, "00000004")), "chat.json"), other, 0o600); err != nil {
		t.Fatal(err)
	}
	e.writeTree(id, model.Tree{Branches: []model.TreeBranch{
		{ID: "00000001", From: model.MainBranch, At: 3},
		{ID: "00000002", From: "00000001", At: 4},
		{ID: exBranch, From: model.MainBranch, At: 3},
		{ID: "00000003", From: model.MainBranch, At: 3},
		{ID: "00000004", From: model.MainBranch, At: 3},
		{ID: "../" + id, From: model.MainBranch, At: 3},
	}, Current: "00000001"})
	record := e.file(id, "tree.json")
	e.boot()

	vs := e.m.Views()
	if len(vs) != 1 || vs[0].ID != id || vs[0].Branches != 2 || vs[0].Branch != "" {
		t.Fatalf("views %+v", vs)
	}
	if got := e.items(id); !reflect.DeepEqual(got, exampleMain()) {
		t.Fatalf("the current branch is not main: %+v", got)
	}
	for _, tok := range []string{stray.Token, child.Token, other.Token} {
		if _, ok := e.m.ResolveToken(tok); ok {
			t.Fatal("the token of a skipped branch resolves")
		}
	}
	for _, b := range []string{"0000000a", "00000001", "00000002", "00000003", "00000004"} {
		if _, _, _, _, err := e.m.ItemsOf(id, b); !errors.Is(err, ErrNoBranch) {
			t.Fatalf("ItemsOf the skipped branch %s: %v", b, err)
		}
	}
	if _, _, _, _, err := e.m.ItemsOf(id, exBranch); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(e.file(id, "tree.json"), record) {
		t.Fatal("boot rewrote the tree record")
	}
}

func TestBootUnreadableTreeRecord(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", exBranch)
	tok := e.meta(bid).Token
	bad := []byte(`{"branches":[{"id":"a1b2c3d4","from":"main","at":3}`)
	if err := os.WriteFile(e.m.treePath(id), bad, 0o600); err != nil {
		t.Fatal(err)
	}
	e.boot()
	v := e.view(id)
	if v.Branches != 0 || v.Branch != "" {
		t.Fatalf("view %+v", v)
	}
	if got := e.items(id); !reflect.DeepEqual(got, exampleMain()) {
		t.Fatalf("items %+v", got)
	}
	if _, ok := e.m.ResolveToken(tok); ok {
		t.Fatal("the branch of an unreadable record is registered")
	}
	if !bytes.Equal(e.file(id, "tree.json"), bad) {
		t.Fatal("the unreadable tree record was changed")
	}
}

// ---- an unsplit chat ------------------------------------------------------

func TestUnsplitChatHasNoBranchFields(t *testing.T) {
	e := newEnv(t)
	evs := e.listen()
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "hello", "")
	a := e.claude.last(t)
	a.emit(t, agent.Event{Kind: agent.EvText, Text: "hi"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)
	child.emit(t, agent.Event{Kind: agent.EvText, Text: "working"})

	js := asJSON(t, e.view(v.ID)).(map[string]any)
	if _, ok := js["branches"]; ok {
		t.Fatalf("an unsplit chat's view has branches: %v", js)
	}
	if _, ok := js["branch"]; ok {
		t.Fatalf("an unsplit chat's view has a branch: %v", js)
	}
	got := evs.drain(t, e.br)
	for _, typ := range []string{"chat_items", "sub", "sub_items"} {
		of := ofType(got, typ)
		if len(of) == 0 {
			t.Fatalf("no %s event", typ)
		}
		for _, ev := range of {
			if ev["chat"] != v.ID || ev["branch"] != model.MainBranch {
				t.Fatalf("%s event %v", typ, ev)
			}
		}
	}
	for _, ev := range ofType(got, "chat") {
		c := chatOf(t, ev)
		if _, ok := c["branches"]; ok || c["id"] != v.ID {
			t.Fatalf("chat event %v", c)
		}
		if _, ok := c["branch"]; ok {
			t.Fatalf("chat event %v", c)
		}
	}
	if err := e.m.StopSubagent(v.ID, sa.ID); err != nil {
		t.Fatal(err)
	}
}

// ---- routing --------------------------------------------------------------

func TestSendGoesToTheCurrentBranch(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", exBranch)
	e.setDefaults(model.Defaults{})
	if err := e.m.SetDraft(id, model.Draft{Text: "typed"}); err != nil {
		t.Fatal(err)
	}
	mainItems, branchTok := e.file(id, "items.jsonl"), e.meta(bid).Token
	evs := e.listen()
	e.send(id, "more", "")

	a := e.claude.last(t)
	if o := a.opts; o.ChatID != bid || o.SessionID != "ses-"+exBranch || !o.Resume || o.MCP == nil || o.MCP.Token != branchTok {
		t.Fatalf("spawn options %+v", o)
	}
	if e.claude.count() != 1 {
		t.Fatalf("%d processes", e.claude.count())
	}
	if got := e.diskItems(bid); len(got) != 7 || got[6].Kind != "user" || got[6].Text != "more" {
		t.Fatalf("the branch's items.jsonl %+v", got)
	}
	if !bytes.Equal(e.file(id, "items.jsonl"), mainItems) {
		t.Fatal("main's items.jsonl changed")
	}
	if e.loaded(id) {
		t.Fatal("a Send on the branch loaded main")
	}
	if top := e.meta(id); top.Draft != nil || top.TurnActive || top.ID != id {
		t.Fatalf("the top-level chat.json %+v", top)
	}
	if b := e.meta(bid); !b.TurnActive || b.Draft != nil || b.Name != "" || b.Group != "" {
		t.Fatalf("the branch's chat.json %+v", b)
	}
	v := e.view(id)
	if v.Draft != nil || v.Status != model.StatusThinking || v.Branch != exBranch {
		t.Fatalf("view %+v", v)
	}

	got := evs.drain(t, e.br)
	items := ofType(got, "chat_items")
	if len(items) != 1 || items[0]["chat"] != id || items[0]["branch"] != exBranch {
		t.Fatalf("chat_items events %v", items)
	}
	chatEvs := ofType(got, "chat")
	if len(chatEvs) != 1 {
		t.Fatalf("chat events %v", chatEvs)
	}
	c := chatOf(t, chatEvs[0])
	if _, draft := c["draft"]; draft || c["id"] != id || c["branch"] != exBranch || c["branches"] != 2.0 ||
		c["status"] != string(model.StatusThinking) || c["group"] != gOne {
		t.Fatalf("chat event %v", c)
	}

	// The first-send effects are the chat's, never a branch's.
	e.m.naming.Wait()
	if calls := e.namer.callList(); len(calls) != 0 {
		t.Fatalf("the auto namer ran for a Send on a branch: %v", calls)
	}
	e.st.Read(func(s *model.State) {
		if len(s.Defaults.Groups) != 0 || s.Defaults.Last.Cwd != "" {
			t.Fatalf("defaults recorded by a Send on a branch: %+v", s.Defaults)
		}
	})
}

// A branch that starts empty (D7) is unlocked, and its first Send still is not the chat's first.
func TestFirstSendOnAnEmptyBranch(t *testing.T) {
	e := newEnv(t)
	id, _ := e.branched(model.Claude, "", "")
	const b = "0e0e0e0e"
	bid := branchChatID(id, b)
	e.writeBranch(id, b, nil)
	e.writeTree(id, model.Tree{Branches: []model.TreeBranch{{ID: b, From: model.MainBranch, At: 0}}, Current: b})
	e.boot()
	e.setDefaults(model.Defaults{})
	if v := e.view(id); v.Locked || v.Branch != b || v.Usage.Turns != 0 {
		t.Fatalf("view %+v", v)
	}
	e.send(id, "from the start", "")
	if o := e.claude.last(t).opts; o.ChatID != bid || o.Resume {
		t.Fatalf("spawn options %+v", o)
	}
	e.m.naming.Wait()
	if calls := e.namer.callList(); len(calls) != 0 {
		t.Fatalf("the auto namer ran: %v", calls)
	}
	e.st.Read(func(s *model.State) {
		if len(s.Defaults.Groups) != 0 || s.Defaults.Last.Cwd != "" {
			t.Fatalf("defaults recorded: %+v", s.Defaults)
		}
	})
	if !e.meta(bid).Locked || !e.view(id).Locked || e.meta(id).Name != "" {
		t.Fatalf("after the Send: branch %+v, top %+v", e.meta(bid), e.meta(id))
	}
}

func TestSessionCallsReachTheCurrentBranch(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", exBranch)
	if e.m.Busy(id) {
		t.Fatal("busy before anything ran")
	}
	if err := e.m.Open(id); err != nil {
		t.Fatal(err)
	}
	if !e.loaded(bid) || e.loaded(id) {
		t.Fatalf("Open loaded: branch %v, main %v", e.loaded(bid), e.loaded(id))
	}
	e.send(id, "delete it", "")
	a := e.claude.last(t)
	if !e.m.Busy(id) {
		t.Fatal("not busy during the branch's turn")
	}
	a.emit(t, agent.Event{Kind: agent.EvPermRequest, PermID: "r1", ToolName: "Bash", ToolID: "t1"})
	if st := e.view(id).Status; st != model.StatusApproval {
		t.Fatalf("status %q", st)
	}
	if err := e.m.Decide(id, "", "r1", true); err != nil {
		t.Fatal(err)
	}
	if got := agentDecides(a); !reflect.DeepEqual(got, []decision{{"r1", true}}) {
		t.Fatalf("decisions %v", got)
	}
	if err := e.m.Interrupt(id); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	ints := a.interrupts
	a.mu.Unlock()
	if ints != 1 {
		t.Fatalf("%d interrupts", ints)
	}
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
	if e.m.Busy(id) {
		t.Fatal("busy after the turn")
	}

	// The context split is the branch's, and is kept in its chat.json.
	s := e.split(id, false)
	if s.Total == 0 {
		t.Fatalf("split %+v", s)
	}
	if e.meta(bid).ContextSplit == nil || e.meta(id).ContextSplit != nil {
		t.Fatalf("context split kept: branch %v, top %v", e.meta(bid).ContextSplit, e.meta(id).ContextSplit)
	}
	if e.loaded(id) {
		t.Fatal("main was loaded")
	}
}

func TestChatCallsReachTheTopLevelChat(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", exBranch)
	branch := e.file(bid, "chat.json")
	evs := e.listen()

	if err := e.m.Rename(id, "Named", true); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Move(id, gTwo); err != nil {
		t.Fatal(err)
	}
	if err := e.m.SetDraft(id, model.Draft{Text: "typed"}); err != nil {
		t.Fatal(err)
	}
	if err := e.m.SetArchive(id, model.Archive{Archived: true, Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	top := e.meta(id)
	if top.Name != "Named" || !top.UserNamed || top.Group != gTwo || top.Draft == nil || top.Draft.Text != "typed" ||
		!top.Archived || top.Op != "op1" {
		t.Fatalf("the top-level chat.json %+v", top)
	}
	if !bytes.Equal(e.file(bid, "chat.json"), branch) {
		t.Fatal("the branch's chat.json changed")
	}
	chatEvs := ofType(evs.drain(t, e.br), "chat")
	if len(chatEvs) != 4 {
		t.Fatalf("chat events %v", chatEvs)
	}
	last := chatOf(t, chatEvs[3])
	if last["id"] != id || last["name"] != "Named" || last["group"] != gTwo || last["archived"] != true ||
		last["branch"] != exBranch || last["branches"] != 2.0 {
		t.Fatalf("the last chat event %v", last)
	}
	// The top-level files stay those of an ordinary chat.
	js := asJSON(t, top).(map[string]any)
	for _, k := range []string{"branches", "branch", "current"} {
		if _, ok := js[k]; ok {
			t.Fatalf("the top-level chat.json has %q", k)
		}
	}
	if got := e.diskItems(id); !reflect.DeepEqual(got, exampleMain()) {
		t.Fatalf("main's items.jsonl %+v", got)
	}
}

func TestConfigureReachesTheCurrentBranch(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", exBranch)
	gone := filepath.Join(t.TempDir(), "gone")
	meta := e.meta(bid)
	meta.Cwd = gone
	e.writeMeta(meta)
	e.boot()
	topCwd := e.meta(id).Cwd

	if err := e.m.Send(id, "more", "", nil); !errors.Is(err, ErrFolderMissing) {
		t.Fatalf("Send with the branch's folder gone: %v", err)
	}
	if v := e.view(id); !v.FolderMissing || v.Status != model.StatusError || v.Cwd != gone {
		t.Fatalf("view %+v", v)
	}
	if err := e.m.Configure(id, ConfigReq{Model: "opus"}); !errors.Is(err, ErrLocked) {
		t.Fatalf("Configure with a model: %v", err)
	}
	dir := t.TempDir()
	if err := e.m.Configure(id, ConfigReq{Cwd: dir}); err != nil {
		t.Fatal(err)
	}
	if got := e.meta(bid).Cwd; got != dir {
		t.Fatalf("the branch's folder %q", got)
	}
	if got := e.meta(id).Cwd; got != topCwd {
		t.Fatalf("the top-level chat's folder changed to %q", got)
	}
	if v := e.view(id); v.FolderMissing || v.Error != "" || v.Status != model.StatusReady || v.Cwd != dir {
		t.Fatalf("view after the fix %+v", v)
	}
	e.send(id, "more", "")
	if o := e.claude.last(t).opts; o.ChatID != bid || o.Cwd != dir || !o.Resume {
		t.Fatalf("spawn options %+v", o)
	}
}

// The folder is the chat's as far as the user can tell: a new folder for the missing one, picked
// on the current branch, is the folder of every branch that had the missing one.
func TestConfigureFolderFixReachesEveryBranch(t *testing.T) {
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 2)
	b1, id1, a1 := e.branchTo(id, newAt(3), "one")
	a1.emit(t, reply("q1")...)
	b2, id2, a2 := e.branchTo(id, newAt(6), "two")
	a2.emit(t, reply("r1")...)
	old := e.meta(id).Cwd
	if e.meta(id1).Cwd != old || e.meta(id2).Cwd != old {
		t.Fatal("a branch did not take the chat's folder")
	}
	// The app is closed and the folder removed: no branch has a process.
	e.m.Shutdown()
	if err := os.Rename(old, old+".gone"); err != nil {
		t.Fatal(err)
	}
	e.boot()
	if err := e.m.Open(id); err != nil {
		t.Fatal(err)
	}
	if v := e.view(id); v.Branch != b2 || !v.FolderMissing || v.Cwd != old {
		t.Fatalf("view after the restart %+v", v)
	}

	dir := t.TempDir()
	evs := e.listen()
	if err := e.m.Configure(id, ConfigReq{Cwd: dir}); err != nil {
		t.Fatal(err)
	}
	for _, sid := range []string{id2, id1, id} {
		if got := e.meta(sid).Cwd; got != dir {
			t.Errorf("the folder of %s after the fix: %q", sid, got)
		}
	}
	if v := e.view(id); v.Branch != b2 || v.FolderMissing || v.Error != "" || v.Status != model.StatusReady || v.Cwd != dir {
		t.Fatalf("view after the fix %+v", v)
	}
	// Clients are told what they are told of a chat without branches: the chat's view, which
	// holds the current branch's folder, and the defaults. No other branch is loaded for it.
	got := evs.drain(t, e.br)
	if len(got) != 2 || len(ofType(got, "chat")) != 1 || len(ofType(got, "defaults")) != 1 || namesChat(got, "/branches/") {
		t.Fatalf("events %+v", got)
	}
	if c := chatOf(t, ofType(got, "chat")[0]); c["cwd"] != dir || c["branch"] != b2 || c["folderMissing"] != nil {
		t.Fatalf("the chat event %v", c)
	}
	if e.loaded(id) || e.loaded(id1) {
		t.Fatal("the fix loaded a branch that is not current")
	}

	// Going back to another branch, and starting a new one from it, finds the folder.
	if err := e.m.SendTo(id, mainAt(6), "back on main", "", nil); err != nil {
		t.Fatalf("SendTo main's end after the fix: %v", err)
	}
	a := e.claude.last(t)
	if o := a.opts; e.cur(id) != model.MainBranch || o.ChatID != id || o.Cwd != dir || !o.Resume {
		t.Fatalf("current %q, spawn options %+v", e.cur(id), o)
	}
	a.emit(t, reply("p3")...)
	_, id3, _ := e.branchTo(id, Target{Branch: b1, At: 3, New: true}, "three")
	if o := e.claude.lastFork(t).opts; o.ChatID != id3 || o.Cwd != dir || e.meta(id3).Cwd != dir {
		t.Fatalf("the folder of a branch started from another branch: %+v", o)
	}
	// The fix survives a restart.
	e.m.Shutdown()
	e.boot()
	for _, sid := range []string{id, id1, id2, id3} {
		if got := e.meta(sid).Cwd; got != dir {
			t.Errorf("the folder of %s after a restart: %q", sid, got)
		}
	}
}

// The folder fix writes the new folder to a branch that has a process, and leaves the process
// and its turn alone: the folder is used the next time the branch starts.
func TestConfigureFolderFixLeavesProcessesAlone(t *testing.T) {
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 2)
	_, bid, fa := e.branchTo(id, newAt(3), "aside")
	fa.emit(t, reply("q1")...)
	old := e.meta(id).Cwd
	// The branch works, and main is made current without stopping it.
	e.send(id, "more", "")
	e.makeCurrent(id, model.MainBranch)
	if err := os.Rename(old, old+".gone"); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Send(id, "on main", "", nil); !errors.Is(err, ErrFolderMissing) {
		t.Fatalf("Send with the folder gone: %v", err)
	}
	branchItems := e.file(bid, "items.jsonl")
	evs := e.listen()

	dir := t.TempDir()
	if err := e.m.Configure(id, ConfigReq{Cwd: dir}); err != nil {
		t.Fatal(err)
	}
	if e.meta(id).Cwd != dir || e.meta(bid).Cwd != dir {
		t.Fatalf("folders after the fix: main %q, the branch %q", e.meta(id).Cwd, e.meta(bid).Cwd)
	}
	if fa.isClosed() || fa.interrupted() != 0 || !bytes.Equal(e.file(bid, "items.jsonl"), branchItems) || !e.meta(bid).TurnActive {
		t.Fatal("the fix disturbed the branch's process or its turn")
	}
	if got := evs.drain(t, e.br); len(ofType(got, "chat_items")) != 0 || len(ofType(got, "chat")) != 1 {
		t.Fatalf("events %+v", got)
	}
	// Its turn goes on, in the process it has.
	fa.emit(t, reply("q2")...)
	if got := e.diskItems(bid); len(got) != 9 || got[7].Text != "reply q2" || fa.isClosed() {
		t.Fatalf("the branch's items %+v", got)
	}
	e.send(id, "on main", "")
	if o := e.claude.last(t).opts; o.ChatID != id || o.Cwd != dir {
		t.Fatalf("spawn options %+v", o)
	}
}

// A branch that could not be started for its missing folder, and was not made current for it
// (see SendTo), does not keep the error once the folder is fixed on another branch.
func TestConfigureFolderFixClearsTheErrorOfOtherBranches(t *testing.T) {
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 2)
	b, bid, fa := e.branchTo(id, newAt(3), "aside")
	fa.emit(t, reply("q1")...)
	old := e.meta(id).Cwd
	if err := os.Rename(old, old+".gone"); err != nil {
		t.Fatal(err)
	}
	if err := e.m.SendTo(id, mainAt(6), "back on main", "", nil); !errors.Is(err, ErrFolderMissing) {
		t.Fatalf("SendTo with the folder gone: %v", err)
	}
	own := func(sid string) model.ChatView {
		t.Helper()
		c, err := e.m.lock(sid)
		if err != nil {
			t.Fatal(err)
		}
		defer c.mu.Unlock()
		return view(c)
	}
	if v := own(id); e.cur(id) != b || !v.FolderMissing || v.Status != model.StatusError {
		t.Fatalf("current %q, main's own view %+v", e.cur(id), v)
	}
	// The branch's process ends; its next start finds the folder gone, and the user picks one.
	fa.exit(t)
	if err := e.m.Send(id, "more", "", nil); !errors.Is(err, ErrFolderMissing) {
		t.Fatalf("Send with the folder gone: %v", err)
	}
	dir := t.TempDir()
	if err := e.m.Configure(id, ConfigReq{Cwd: dir}); err != nil {
		t.Fatal(err)
	}
	if v := own(id); v.FolderMissing || v.Error != "" || v.Status != model.StatusReady || v.Cwd != dir {
		t.Fatalf("main's own view after the fix %+v", v)
	}
	if v := own(bid); v.FolderMissing || v.Error != "" || v.Status != model.StatusReady || v.Cwd != dir {
		t.Fatalf("the branch's own view after the fix %+v", v)
	}
	e.sendTo(id, mainAt(6), "back on main")
	if o := e.claude.last(t).opts; e.cur(id) != model.MainBranch || o.ChatID != id || o.Cwd != dir {
		t.Fatalf("current %q, spawn options %+v", e.cur(id), o)
	}
}

// ---- the composed view ----------------------------------------------------

func TestComposedView(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", exBranch)
	top := e.meta(id)
	top.Name, top.UserNamed, top.Draft = "Top", true, &model.Draft{Text: "typed"}
	top.Archive = model.Archive{Archived: true, Op: "op1"}
	top.ForkedFrom, top.ForkedFromTitle = "elsewhere", "Elsewhere"
	top.Model, top.Effort = "sonnet", "low"
	top.Usage = model.Usage{Turns: 2, CtxIn: 10, CtxWindow: 100}
	e.writeMeta(top)
	b := e.meta(bid)
	b.Cwd, b.Model, b.Effort = t.TempDir(), "opus", "max"
	b.Usage = model.Usage{Turns: 1, CtxIn: 77, CtxWindow: 200}
	b.TurnActive = true // its turn was cut by a restart
	b.Name, b.Group, b.Created = "never shown", gTwo, top.Created.Add(time.Hour)
	e.writeMeta(b)
	e.boot()

	v := e.view(id)
	want := model.ChatView{ID: id, Agent: model.Claude, Name: "Top", UserNamed: true, Group: gOne,
		Created: v.Created, Draft: v.Draft, Archive: top.Archive, ForkedFrom: "elsewhere", ForkedFromTitle: "Elsewhere",
		Cwd: b.Cwd, Model: "opus", Effort: "max", Locked: true, Usage: b.Usage, Status: model.StatusStopped,
		Branches: 2, Branch: exBranch}
	if v != want {
		t.Fatalf("view\n got %+v\nwant %+v", v, want)
	}
	if !v.Created.Equal(top.Created) || v.Draft == nil || v.Draft.Text != "typed" {
		t.Fatalf("created %v, draft %+v", v.Created, v.Draft)
	}
	if vs := e.m.Views(); len(vs) != 1 || vs[0] != v {
		t.Fatalf("Views %+v", vs)
	}

	// With main current the session side is the top-level chat's own.
	evs := e.listen()
	e.makeCurrent(id, model.MainBranch)
	v = e.view(id)
	if v.Branch != "" || v.Branches != 2 || v.Model != "sonnet" || v.Effort != "low" || v.Usage != top.Usage ||
		v.Cwd != top.Cwd || v.Status != model.StatusReady || v.Name != "Top" {
		t.Fatalf("view with main current %+v", v)
	}
	chatEvs := ofType(evs.drain(t, e.br), "chat")
	if len(chatEvs) != 1 {
		t.Fatalf("chat events %v", chatEvs)
	}
	if c := chatOf(t, chatEvs[0]); c["model"] != "sonnet" || c["branches"] != 2.0 || c["name"] != "Top" {
		t.Fatalf("chat event %v", c)
	} else if _, ok := c["branch"]; ok {
		t.Fatalf("chat event names a branch with main current: %v", c)
	}
}

// ---- events ---------------------------------------------------------------

func TestBranchEvents(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", "")
	if err := e.m.Rename(id, "Top", true); err != nil {
		t.Fatal(err)
	}
	mainAg, branchAg := e.bothRunning(id)
	evs := e.listen()

	// The branch that is not current still sends its items, and no chat event.
	mainAg.emit(t, agent.Event{Kind: agent.EvTextDelta, Text: "late"})
	if st := e.view(id).Status; st != model.StatusReady {
		t.Fatalf("status of the chat while main writes: %q", st)
	}
	mainAg.emit(t, agent.Event{Kind: agent.EvTurnEnd, Point: "p4"})
	got := evs.drain(t, e.br)
	items := ofType(got, "chat_items")
	if len(items) == 0 {
		t.Fatal("no chat_items event of main")
	}
	for _, ev := range items {
		if ev["chat"] != id || ev["branch"] != model.MainBranch {
			t.Fatalf("chat_items event %v", ev)
		}
	}
	if c := ofType(got, "chat"); len(c) != 0 {
		t.Fatalf("a change of a branch that is not current sent chat events: %v", c)
	}
	if v := e.view(id); v.Status != model.StatusReady || v.Usage.Turns != 2 {
		t.Fatalf("view %+v", v) // the branch's two turns, not main's four
	}

	// The current branch's status change sends the composed view.
	branchAg.emit(t, agent.Event{Kind: agent.EvTextDelta, Text: "writing"})
	got = evs.drain(t, e.br)
	items = ofType(got, "chat_items")
	if len(items) != 1 || items[0]["chat"] != id || items[0]["branch"] != exBranch {
		t.Fatalf("chat_items events %v", items)
	}
	chatEvs := ofType(got, "chat")
	if len(chatEvs) != 1 {
		t.Fatalf("chat events %v", chatEvs)
	}
	if c := chatOf(t, chatEvs[0]); c["id"] != id || c["branch"] != exBranch || c["branches"] != 2.0 ||
		c["status"] != string(model.StatusWriting) || c["name"] != "Top" || c["group"] != gOne {
		t.Fatalf("chat event %v", c)
	}

	// A subagent of the branch: its folder is the branch's, its events name the branch.
	sa := e.spawn(bid, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 3)
	child.emit(t, agent.Event{Kind: agent.EvText, Text: "working"})
	if child.opts.ChatID != bid+"/subagents/"+sa.ID {
		t.Fatalf("the subagent's chat id %q", child.opts.ChatID)
	}
	if _, err := os.Stat(filepath.Join(e.st.P.ChatDir(id), "branches", exBranch, "subagents", sa.ID, "subagent.json")); err != nil {
		t.Fatalf("the subagent's folder: %v", err)
	}
	if _, err := os.Stat(filepath.Join(e.st.P.ChatDir(id), "subagents")); !os.IsNotExist(err) {
		t.Fatalf("a subagents folder under main: %v", err)
	}
	got = evs.drain(t, e.br)
	for _, typ := range []string{"sub", "sub_items"} {
		of := ofType(got, typ)
		if len(of) == 0 {
			t.Fatalf("no %s event", typ)
		}
		for _, ev := range of {
			if ev["chat"] != id || ev["branch"] != exBranch {
				t.Fatalf("%s event %v", typ, ev)
			}
		}
	}
	caller, ok := e.m.ResolveToken(child.opts.MCP.Token)
	if !ok || !caller.Subagent || caller.SID != sa.ID || caller.Chat != id || caller.Meta.ID != bid {
		t.Fatalf("the subagent's token: %+v, %v", caller, ok)
	}

	// The read side: the subagent is the branch's.
	if _, items, err := e.m.SubItems(id, sa.ID); err != nil || len(items) != 1 {
		t.Fatalf("SubItems: %v, %v", items, err)
	}
	if _, _, err := e.m.SubItemsOf(id, exBranch, sa.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.m.SubItemsOf(id, model.MainBranch, sa.ID); !errors.Is(err, ErrNoSubagent) {
		t.Fatalf("SubItemsOf main: %v", err)
	}
	if _, _, err := e.m.SubItemsOf(id, "nope", sa.ID); !errors.Is(err, ErrNoBranch) {
		t.Fatalf("SubItemsOf an unknown branch: %v", err)
	}
	if served, _, _, subs, err := e.m.ItemsOf(id, ""); err != nil || served != exBranch || len(subs) != 1 || subs[0].ID != sa.ID {
		t.Fatalf("ItemsOf the current branch: %q, %v, %v", served, subs, err)
	}
}

func TestItemsOf(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", exBranch)
	served, _, items, _, err := e.m.ItemsOf(id, model.MainBranch)
	if err != nil || served != model.MainBranch || !reflect.DeepEqual(items, exampleMain()) {
		t.Fatalf("ItemsOf main: %q, %+v, %v", served, items, err)
	}
	served, _, items, _, err = e.m.ItemsOf(id, "")
	if err != nil || served != exBranch || !reflect.DeepEqual(items, exampleBranch()) {
		t.Fatalf("ItemsOf the current branch: %q, %+v, %v", served, items, err)
	}
	served, _, items, _, err = e.m.ItemsOf(id, exBranch)
	if err != nil || served != exBranch || len(items) != 6 {
		t.Fatalf("ItemsOf the branch: %q, %+v, %v", served, items, err)
	}
	if _, _, _, _, err := e.m.ItemsOf(id, "nope"); !errors.Is(err, ErrNoBranch) {
		t.Fatalf("ItemsOf an unknown branch: %v", err)
	}
	if _, _, _, _, err := e.m.ItemsOf("nope", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ItemsOf an unknown chat: %v", err)
	}
	if _, _, _, _, err := e.m.ItemsOf(bid, ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ItemsOf a branch's server id: %v", err)
	}
	// An unsplit chat serves main.
	v := e.create(model.Claude, gOne, "")
	if served, _, _, _, err := e.m.ItemsOf(v.ID, ""); err != nil || served != model.MainBranch {
		t.Fatalf("ItemsOf an unsplit chat: %q, %v", served, err)
	}
	if _, _, _, _, err := e.m.ItemsOf(v.ID, exBranch); !errors.Is(err, ErrNoBranch) {
		t.Fatalf("ItemsOf a branch of an unsplit chat: %v", err)
	}
}

// ---- the two stops --------------------------------------------------------

func TestStopOneBranchAndStopTheChat(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", "")
	mainAg, branchAg := e.bothRunning(id)
	mainSub := e.spawn(id, SpawnSubRequest{Prompt: "main's"})
	mainChild := waitChild(t, e.claude, 3)
	branchSub := e.spawn(bid, SpawnSubRequest{Prompt: "the branch's"})
	branchChild := waitChild(t, e.claude, 4)
	e.send(id, "a long job", "")
	mainBefore := e.file(id, "chat.json")
	evs := e.listen()

	e.m.stopBranch(bid)
	waitFor(t, "the branch's subagent closed", func() bool { return agentClosed(branchChild) })
	if !agentClosed(branchAg) {
		t.Fatal("the branch's process is not closed")
	}
	if _, ok := e.m.ResolveToken(branchChild.opts.MCP.Token); ok {
		t.Fatal("the token of the branch's subagent still resolves")
	}
	if s := e.subFile(bid, branchSub.ID); s.Status != model.SubStopped {
		t.Fatalf("the branch's subagent %+v", s)
	}
	items := e.diskItems(bid)
	if last := items[len(items)-1]; last.Kind != "note" || last.Text != "Stopped." {
		t.Fatalf("the branch's last item %+v", last)
	}
	if e.meta(bid).TurnActive || e.view(id).Status != model.StatusReady {
		t.Fatalf("after the stop: %+v, view %+v", e.meta(bid), e.view(id))
	}
	// Every other branch is as it was.
	if agentClosed(mainAg) || agentClosed(mainChild) {
		t.Fatal("stopping one branch closed another's process")
	}
	if _, ok := e.m.ResolveToken(mainChild.opts.MCP.Token); !ok {
		t.Fatal("the token of main's subagent was revoked")
	}
	if s := e.subFile(id, mainSub.ID); s.Status != model.SubRunning {
		t.Fatalf("main's subagent %+v", s)
	}
	if !bytes.Equal(e.file(id, "chat.json"), mainBefore) {
		t.Fatal("main's chat.json changed")
	}
	for _, ev := range evs.drain(t, e.br) {
		if (ev["type"] == "chat_items" || ev["type"] == "sub" || ev["type"] == "sub_items") && ev["branch"] != exBranch {
			t.Fatalf("an event of another branch: %v", ev)
		}
	}

	// Stop the chat: every branch that has a process.
	e.send(id, "again", "")
	resumed := e.claude.last(t)
	if resumed.opts.ChatID != bid || !resumed.opts.Resume {
		t.Fatalf("the Send after the stop: %+v", resumed.opts)
	}
	e.m.Stop(id)
	waitFor(t, "main's subagent closed", func() bool { return agentClosed(mainChild) })
	if !agentClosed(mainAg) || !agentClosed(resumed) {
		t.Fatalf("after Stop: main closed %v, branch closed %v", agentClosed(mainAg), agentClosed(resumed))
	}
	if _, ok := e.m.ResolveToken(mainChild.opts.MCP.Token); ok {
		t.Fatal("the token of main's subagent still resolves")
	}
	if e.m.Busy(id) || e.meta(bid).TurnActive {
		t.Fatal("busy after Stop")
	}
}

// ---- parent operations ----------------------------------------------------

func TestArchiveCoversBranches(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", exBranch)
	tok := e.meta(bid).Token
	if err := e.m.SetArchive(id, model.Archive{Archived: true, Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Send(id, "x", "", nil); !errors.Is(err, ErrArchived) {
		t.Fatalf("Send on an archived chat's branch: %v", err)
	}
	if err := e.m.Configure(id, ConfigReq{Cwd: t.TempDir()}); !errors.Is(err, ErrArchived) {
		t.Fatalf("Configure: %v", err)
	}
	if _, err := e.m.SpawnSubagent(bid, SpawnSubRequest{Prompt: "go"}); !errors.Is(err, ErrArchived) {
		t.Fatalf("SpawnSubagent: %v", err)
	}
	if _, err := e.m.Fork(id, ForkReq{Branch: exBranch, At: 3}); !errors.Is(err, ErrArchived) {
		t.Fatalf("Fork: %v", err)
	}
	if caller, ok := e.m.ResolveToken(tok); !ok || !caller.Meta.Archived || caller.Meta.Op != "op1" || caller.Meta.ID != bid {
		t.Fatalf("caller of an archived chat's branch: %+v, %v", caller, ok)
	}
	if e.meta(bid).Archived {
		t.Fatal("the archive flag was written to the branch")
	}
	if e.claude.count() != 0 {
		t.Fatal("something was spawned")
	}

	if err := e.m.SetArchive(id, model.Archive{}); err != nil {
		t.Fatal(err)
	}
	if caller, ok := e.m.ResolveToken(tok); !ok || caller.Meta.Archived {
		t.Fatalf("caller after unarchive: %+v, %v", caller, ok)
	}
	e.send(id, "x", "")
	if o := e.claude.last(t).opts; o.ChatID != bid {
		t.Fatalf("spawn options %+v", o)
	}
}

func TestDeleteCoversBranches(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", "")
	mainAg, branchAg := e.bothRunning(id)
	e.spawn(bid, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 3)
	e.send(id, "a long job", "")
	toks := []string{e.meta(id).Token, e.meta(bid).Token, child.opts.MCP.Token}
	for _, tok := range toks {
		if _, ok := e.m.ResolveToken(tok); !ok {
			t.Fatal("a token does not resolve before the delete")
		}
	}
	evs := e.listen()

	if err := e.m.Delete(id); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the subagent closed", func() bool { return agentClosed(child) })
	if !agentClosed(mainAg) || !agentClosed(branchAg) {
		t.Fatalf("after Delete: main closed %v, branch closed %v", agentClosed(mainAg), agentClosed(branchAg))
	}
	for i, tok := range toks {
		if _, ok := e.m.ResolveToken(tok); ok {
			t.Fatalf("token %d still resolves", i)
		}
	}
	if _, err := os.Stat(e.st.P.ChatDir(id)); !os.IsNotExist(err) {
		t.Fatalf("the chat's folder is still there: %v", err)
	}
	for _, sid := range []string{id, bid} {
		if _, err := e.m.get(sid); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s is still in the map: %v", sid, err)
		}
	}
	e.m.extrasMu.Lock()
	for _, tok := range toks {
		if _, ok := e.m.used[tok]; ok {
			t.Error("a token is still in the uniqueness set")
		}
	}
	e.m.extrasMu.Unlock()
	got := evs.drain(t, e.br)
	removed := ofType(got, "chat_removed")
	if len(removed) != 1 || removed[0]["id"] != id {
		t.Fatalf("chat_removed events %v", removed)
	}
	// A late event of a deleted branch writes and sends nothing.
	branchAg.emit(t, agent.Event{Kind: agent.EvText, Text: "late"})
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("events after the delete: %v", got)
	}
	if _, err := os.Stat(e.st.P.ChatDir(id)); !os.IsNotExist(err) {
		t.Fatalf("the chat's folder came back: %v", err)
	}
	if err := e.m.Delete(id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a second Delete: %v", err)
	}
}

func TestShutdownSavesBranches(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", exBranch)
	e.send(id, "a long job", "")
	e.claude.last(t).emit(t, agent.Event{Kind: agent.EvText, Text: "half"})
	e.m.Shutdown() // mid-turn
	if !e.meta(bid).TurnActive || e.meta(id).TurnActive {
		t.Fatalf("turnActive: branch %v, top %v", e.meta(bid).TurnActive, e.meta(id).TurnActive)
	}
	if got := e.diskItems(bid); len(got) != 8 || got[7].Text != "half" {
		t.Fatalf("the branch's items.jsonl %+v", got)
	}

	e.boot()
	if v := e.view(id); v.Status != model.StatusStopped || v.Branch != exBranch {
		t.Fatalf("view after the restart %+v", v)
	}
	items := e.items(id)
	if last := items[len(items)-1]; last.Kind != "note" || !strings.HasPrefix(last.Text, "Stopped: the app was closed") {
		t.Fatalf("the branch's last item %+v", last)
	}
	if e.meta(bid).TurnActive || e.loaded(id) {
		t.Fatal("the interrupted turn was not settled on the branch alone")
	}
}

// ---- forking a branch -----------------------------------------------------

func TestForkFromABranch(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", "")
	if err := e.m.Rename(id, "Top", true); err != nil {
		t.Fatal(err)
	}
	mainItems := e.file(id, "items.jsonl")

	if _, err := e.m.Fork(id, ForkReq{Branch: "nope", At: 3}); !errors.Is(err, ErrNoBranch) {
		t.Fatalf("Fork of an unknown branch: %v", err)
	}
	// Past the split the fork is the branch's path, in a session forked from the branch's.
	v, err := e.m.Fork(id, ForkReq{Branch: exBranch, At: 6})
	if err != nil {
		t.Fatal(err)
	}
	calls := e.claude.forkCalls()
	if len(calls) != 1 || calls[0].src.ChatID != bid || calls[0].src.SessionID != "ses-"+exBranch || !calls[0].src.End {
		t.Fatalf("fork calls %+v", calls)
	}
	if got := e.diskItems(v.ID); !reflect.DeepEqual(got, exampleBranch()) {
		t.Fatalf("the fork's items %+v", got)
	}
	if v.Name != "Top (fork)" || v.ForkedFrom != id || v.ForkedFromTitle != "Top" || v.Group != gOne ||
		v.Branches != 0 || v.Branch != "" || strings.Contains(v.ID, "/") {
		t.Fatalf("the fork's view %+v", v)
	}
	want := []model.TreeLabel{{Branch: model.MainBranch, Item: 1, Text: "options"}, {Branch: model.MainBranch, Item: 3, Text: "mem"}}
	if got, ok := e.treeFile(v.ID); !ok || !reflect.DeepEqual(got.Labels, want) || len(got.Branches) != 0 {
		t.Fatalf("the fork's tree record %+v, %v", got, ok)
	}
	if !bytes.Equal(e.file(id, "items.jsonl"), mainItems) || !reflect.DeepEqual(e.diskItems(bid), exampleBranch()) {
		t.Fatal("the source's threads changed")
	}
	if vs := e.m.Views(); len(vs) != 2 {
		t.Fatalf("views %+v", vs)
	}

	// Busy is the chat's: its current branch's turn refuses a fork of any branch.
	e.send(id, "on main", "")
	if _, err := e.m.Fork(id, ForkReq{Branch: exBranch, At: 3}); !errors.Is(err, ErrBusy) {
		t.Fatalf("Fork of an idle branch of a busy chat: %v", err)
	}
	if len(e.claude.forkCalls()) != 1 {
		t.Fatal("a refused fork started a process")
	}
}

// ---- the registry at run time ---------------------------------------------

// What a Send with a target builds on: an entry made under a branch's server id is its chat's
// from the start, joins the registry, and becomes current.
func TestAddBranchAndSetCurrent(t *testing.T) {
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 2)
	const b = "0badf00d"
	bid := branchChatID(id, b)

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
	meta.ID = bid
	c, err := e.m.addUnlisted(src, meta, 3)
	src.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if topOf(c) != src || c.branch != b {
		t.Fatalf("the entry's link: top %v, branch %q", c.top, c.branch)
	}
	c.mu.Lock()
	tok := c.meta.Token
	c.mu.Unlock()
	if caller, ok := e.m.ResolveToken(tok); !ok || caller.Chat != id || caller.Meta.ID != bid {
		t.Fatalf("the unlisted branch's token: %+v, %v", caller, ok)
	}
	if v := e.view(id); v.Branches != 0 || v.Branch != "" {
		t.Fatalf("view with an unlisted branch %+v", v)
	}
	if _, err := e.m.branchObj(id, b); !errors.Is(err, ErrNoBranch) {
		t.Fatalf("branchObj of an unlisted branch: %v", err)
	}
	if err := e.m.setCurrent(id, b); !errors.Is(err, ErrNoBranch) {
		t.Fatalf("setCurrent to an unlisted branch: %v", err)
	}

	// Made visible: chat.json, the record, the registry.
	c.mu.Lock()
	err = e.m.writeMeta(c)
	c.unlisted = false
	c.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if err := e.m.updateTree(id, func(t *model.Tree) error {
		t.Branches = append(t.Branches, model.TreeBranch{ID: b, From: model.MainBranch, At: 3})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := e.m.addBranch(c, bid); err != nil {
		t.Fatal(err)
	}
	if err := e.m.addBranch(c, bid); err != nil { // again: still one entry
		t.Fatal(err)
	}
	if got, err := e.m.branchObj(id, b); err != nil || got != c {
		t.Fatalf("branchObj: %v, %v", got, err)
	}
	if v := e.view(id); v.Branches != 2 || v.Branch != "" {
		t.Fatalf("view with the branch registered %+v", v)
	}
	if got := e.items(id); len(got) != 6 {
		t.Fatalf("the current branch's items %+v", got)
	}

	evs := e.listen()
	e.makeCurrent(id, b)
	if v := e.view(id); v.Branches != 2 || v.Branch != b {
		t.Fatalf("view with the branch current %+v", v)
	}
	if got := e.items(id); len(got) != 3 {
		t.Fatalf("the current branch's items %+v", got)
	}
	if rec, _ := e.treeFile(id); rec.Current != b {
		t.Fatalf("the record's current %q", rec.Current)
	}
	chatEvs := ofType(evs.drain(t, e.br), "chat")
	if len(chatEvs) != 1 || chatOf(t, chatEvs[0])["branch"] != b || chatOf(t, chatEvs[0])["id"] != id {
		t.Fatalf("chat events %v", chatEvs)
	}
	if err := e.m.setCurrent(id, "nope"); !errors.Is(err, ErrNoBranch) {
		t.Fatalf("setCurrent to an unknown branch: %v", err)
	}
	if err := e.m.setCurrent("nope", b); !errors.Is(err, ErrNotFound) {
		t.Fatalf("setCurrent on an unknown chat: %v", err)
	}
	if err := e.m.addBranch(&Chat{}, branchChatID("nope", b)); !errors.Is(err, ErrNoBranch) {
		t.Fatalf("addBranch for an unknown chat: %v", err)
	}
	if err := e.m.addBranch(&Chat{}, "nope"); !errors.Is(err, ErrNoBranch) {
		t.Fatalf("addBranch under a top-level id: %v", err)
	}
	if err := e.m.addBranch(&Chat{}, bid); err == nil {
		t.Fatal("addBranch put a second chat object under the branch's id")
	}

	// It is all there after a restart.
	e.m.Shutdown()
	e.boot()
	if v := e.view(id); v.Branches != 2 || v.Branch != b {
		t.Fatalf("view after a restart %+v", v)
	}
	e.makeCurrent(id, model.MainBranch)
	if rec, _ := e.treeFile(id); rec.Current != model.MainBranch {
		t.Fatalf("the record's current %q", rec.Current)
	}
	if v := e.view(id); v.Branch != "" || len(e.items(id)) != 6 {
		t.Fatalf("view with main current again %+v", v)
	}
}

// An unreadable tree record is never written over: the current branch stays.
func TestSetCurrentUnreadableRecord(t *testing.T) {
	e := newEnv(t)
	id, _ := e.branched(model.Claude, "", "")
	bad := []byte(`{"branches":`)
	if err := os.WriteFile(e.m.treePath(id), bad, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := e.m.setCurrent(id, exBranch); !errors.Is(err, errTreeUnreadable) {
		t.Fatalf("setCurrent: %v", err)
	}
	if v := e.view(id); v.Branch != "" {
		t.Fatalf("view %+v", v)
	}
	if !bytes.Equal(e.file(id, "tree.json"), bad) {
		t.Fatal("the record was changed")
	}
}
