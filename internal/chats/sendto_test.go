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
	"ai-whiteboard/internal/prompts"
	"ai-whiteboard/internal/store"
)

// ---- fixtures -------------------------------------------------------------

func mainAt(at int) Target { return Target{Branch: model.MainBranch, At: at} }
func newAt(at int) Target  { return Target{Branch: model.MainBranch, At: at, New: true} }
func reply(n string) []agent.Event {
	return []agent.Event{{Kind: agent.EvText, Text: "reply " + n}, {Kind: agent.EvTurnEnd, Point: n}}
}

func (e *env) sendTo(id string, t Target, text string) {
	e.t.Helper()
	if err := e.m.SendTo(id, t, text, "", nil); err != nil {
		e.t.Fatalf("SendTo %+v: %v", t, err)
	}
}

func (e *env) sendToErr(id string, t Target) error {
	return e.m.SendTo(id, t, "never sent", "", nil)
}

// cur is the id of the chat's current branch, as its view names it.
func (e *env) cur(id string) string {
	e.t.Helper()
	if b := e.view(id).Branch; b != "" {
		return b
	}
	return model.MainBranch
}

// branchTo sends text to a point of the chat that starts a new branch and returns the branch's
// id, its server id and its process: the fork, or for the start of the chat the one spawned.
func (e *env) branchTo(id string, t Target, text string) (b, bid string, a *fakeAgent) {
	e.t.Helper()
	e.sendTo(id, t, text)
	b = e.cur(id)
	if b == model.MainBranch || b == t.Branch {
		e.t.Fatalf("SendTo %+v made no branch: the current one is %q", t, b)
	}
	sp := e.spawner(e.meta(id).Agent)
	if t.At == 0 {
		return b, branchChatID(id, b), sp.last(e.t)
	}
	return b, branchChatID(id, b), sp.lastFork(e.t)
}

// unsplit checks that the chat has nothing of a branch: no tree record, no branches/ folder, and
// a view that names none.
func (e *env) unsplit(id string) {
	e.t.Helper()
	if _, ok := e.treeFile(id); ok {
		e.t.Fatal("a tree record was written")
	}
	if _, err := os.Stat(filepath.Join(e.st.P.ChatDir(id), "branches")); !os.IsNotExist(err) {
		e.t.Fatalf("the branches folder: %v", err)
	}
	if v := e.view(id); v.Branch != "" || v.Branches != 0 {
		e.t.Fatalf("view %+v", v)
	}
}

func (e *env) noDefaults() {
	e.t.Helper()
	e.st.Read(func(s *model.State) {
		if len(s.Defaults.Groups) != 0 {
			e.t.Fatalf("defaults recorded by a Send on a branch: %+v", s.Defaults)
		}
	})
}

// ---- the point ------------------------------------------------------------

func TestSendToPoints(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		kind  model.AgentKind
		items []model.Item
		ok    []int // the counts a new branch may start at
	}{
		{"two turns", model.Claude, twoTurns(), []int{0, 3, 8}},
		{"first mark without an id", model.Claude, []model.Item{pUser(), pText(), pEnd(""), pUser(), pText(), pEnd("p2")}, []int{6}},
		{"last mark without an id", model.Claude, []model.Item{pUser(), pText(), pEnd("p1"), pUser(), pText(), pEnd("")}, []int{0, 3}},
		{"last turn cut", model.Claude, []model.Item{pUser(), pText(), pEnd("p1"), pUser(), pText()}, []int{0, 3}},
		{"no marks", model.Claude, []model.Item{pUser(), pText(), pUser(), pText()}, nil},
		{"a cut turn", model.Claude, cutTurn(), []int{0, 3, 8}},
		{"pi, a cut turn", model.Pi, cutTurn(), []int{0, 8}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			allowed := func(at int) bool {
				for _, ok := range tc.ok {
					if ok == at {
						return true
					}
				}
				return false
			}
			e := newEnv(t)
			id := e.stored(tc.kind, tc.items)
			sp := e.spawner(tc.kind)
			for at := -1; at <= len(tc.items)+1; at++ {
				if allowed(at) {
					continue
				}
				if err := e.sendToErr(id, newAt(at)); !errors.Is(err, ErrBadPoint) {
					t.Errorf("a new branch at %d: %v", at, err)
				}
				// Without the flag, only the end of the branch is no new branch.
				if at != len(tc.items) {
					if err := e.sendToErr(id, mainAt(at)); !errors.Is(err, ErrBadPoint) {
						t.Errorf("a message at %d: %v", at, err)
					}
				}
			}
			e.unsplit(id)
			if len(sp.forkCalls()) != 0 || sp.count() != 0 || len(e.items(id)) != len(tc.items) {
				t.Fatalf("refused points: %d fork starts, %d spawns, %d items", len(sp.forkCalls()), sp.count(), len(e.items(id)))
			}

			for _, at := range tc.ok {
				e := newEnv(t)
				id := e.stored(tc.kind, tc.items)
				if err := e.sendToErr(id, newAt(at)); err != nil {
					t.Fatalf("a new branch at %d: %v", at, err)
				}
				if rec, _ := e.treeFile(id); len(rec.Branches) != 1 || rec.Branches[0].At != at || rec.Current != rec.Branches[0].ID {
					t.Fatalf("the record after a branch at %d: %+v", at, rec)
				}
			}

			// Carrying on needs no id: the end of an idle branch always takes a message.
			e = newEnv(t)
			id = e.stored(tc.kind, tc.items)
			e.sendTo(id, mainAt(len(tc.items)), "carry on")
			e.unsplit(id)
			if got := e.items(id); len(got) != len(tc.items)+1 || got[len(tc.items)].Text != "carry on" {
				t.Fatalf("items after carrying on %+v", got)
			}
		})
	}

	// An empty chat has no point for a branch; its first message is an ordinary one.
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	if err := e.sendToErr(v.ID, newAt(0)); !errors.Is(err, ErrBadPoint) {
		t.Fatalf("a new branch in an empty chat: %v", err)
	}
	e.sendTo(v.ID, mainAt(0), "the first message")
	e.m.naming.Wait()
	e.unsplit(v.ID)
	if calls := e.namer.callList(); len(calls) != 1 || e.claude.count() != 1 || !e.meta(v.ID).Locked {
		t.Fatalf("the first message through SendTo: namer %v, %d spawns", calls, e.claude.count())
	}
}

func TestSendToRefusals(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, a := e.talked(model.Claude, "", 2)

	if err := e.sendToErr("nope", newAt(3)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown chat: %v", err)
	}
	for _, branch := range []string{"", "b1"} {
		for _, isNew := range []bool{false, true} {
			if err := e.sendToErr(id, Target{Branch: branch, At: 3, New: isNew}); !errors.Is(err, ErrNoBranch) {
				t.Fatalf("branch %q: %v", branch, err)
			}
		}
	}

	// Busy is the branch's the message goes to: the end of a branch whose turn is running takes
	// none, by its length or as its end. A point inside or after that turn is no point for a new
	// branch (the finished boundaries are: see TestBranchFromARunningSource).
	e.send(id, "more", "")
	for _, tg := range []Target{mainAt(7), {Branch: model.MainBranch, End: true}} {
		if err := e.sendToErr(id, tg); !errors.Is(err, ErrBusy) {
			t.Fatalf("busy branch, %+v: %v", tg, err)
		}
	}
	if err := e.sendToErr(id, newAt(7)); !errors.Is(err, ErrBadPoint) {
		t.Fatalf("a new branch after the running turn's message: %v", err)
	}
	// The branch named is looked up first: an unknown one is that, whatever the chat is doing.
	for _, tg := range []Target{{Branch: "b1", At: 3}, {Branch: "b1", At: 3, New: true}, {Branch: "b1", End: true}} {
		if err := e.sendToErr(id, tg); !errors.Is(err, ErrNoBranch) {
			t.Fatalf("an unknown branch of a busy chat, %+v: %v", tg, err)
		}
	}
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd, Point: "p3"})

	if err := e.m.SetArchive(id, model.Archive{Archived: true}); err != nil {
		t.Fatal(err)
	}
	for _, tg := range []Target{newAt(3), mainAt(8)} {
		if err := e.sendToErr(id, tg); !errors.Is(err, ErrArchived) {
			t.Fatalf("archived chat, %+v: %v", tg, err)
		}
	}
	if err := e.sendToErr(id, Target{Branch: "b1", End: true}); !errors.Is(err, ErrNoBranch) {
		t.Fatalf("an unknown branch of an archived chat: %v", err)
	}
	if err := e.m.SetArchive(id, model.Archive{}); err != nil {
		t.Fatal(err)
	}

	// A legacy chat.
	meta := e.meta(id)
	meta.InstructionsSent = true
	if err := store.WriteJSONAtomic(filepath.Join(e.st.P.ChatDir(id), "chat.json"), meta, 0o600); err != nil {
		t.Fatal(err)
	}
	e.boot()
	for _, tg := range []Target{newAt(3), mainAt(8)} {
		if err := e.sendToErr(id, tg); !errors.Is(err, ErrLegacy) {
			t.Fatalf("legacy chat, %+v: %v", tg, err)
		}
	}
	e.unsplit(id)
	if n := len(e.claude.forkCalls()); n != 0 || len(e.items(id)) != 8 {
		t.Fatalf("%d fork starts, %d items", n, len(e.items(id)))
	}

	// A record that cannot be read is never written over: no branch can be added.
	e = newEnv(t)
	id, a = e.talked(model.Claude, "", 2)
	bad := []byte(`{"branches":`)
	if err := os.WriteFile(e.m.treePath(id), bad, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := e.sendToErr(id, newAt(3)); !errors.Is(err, errTreeUnreadable) {
		t.Fatalf("a new branch with an unreadable record: %v", err)
	}
	if !bytes.Equal(e.file(id, "tree.json"), bad) || len(e.claude.forkCalls()) != 0 || a.isClosed() {
		t.Fatal("the refused branch left something")
	}
	if _, err := os.Stat(filepath.Join(e.st.P.ChatDir(id), "branches")); !os.IsNotExist(err) {
		t.Fatalf("the branches folder: %v", err)
	}
}

// A1: pi, with a turn cut without a mark between two finished ones.
func TestSendToPiCutTurn(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.stored(model.Pi, cutTurn())
	if err := e.sendToErr(id, newAt(3)); !errors.Is(err, ErrBadPoint) {
		t.Fatalf("pi branch at 3 past a cut turn: %v", err)
	}
	e.unsplit(id)
	if len(e.pi.forkCalls()) != 0 || len(e.items(id)) != 8 {
		t.Fatalf("%d fork starts, %d items", len(e.pi.forkCalls()), len(e.items(id)))
	}

	// With no mark after the point (the cut turn is the last) the id on the mark before it is
	// all pi needs: the branch is made, forked with that id alone and not as the session's end.
	e = newEnv(t)
	id = e.stored(model.Pi, cutTurn()[:5])
	_, bid, _ := e.branchTo(id, newAt(3), "aside")
	want := agent.ForkSource{ChatID: id, Dir: e.st.P.ChatDir(id), SessionID: e.meta(id).SessionID, Point: "p1"}
	if got := e.pi.forkCalls()[0].src; got != want {
		t.Fatalf("pi branch before a cut last turn %+v, want %+v", got, want)
	}
	if got := e.diskItems(bid); len(got) != 4 || got[3].Kind != "user" || got[3].Text != "aside" {
		t.Fatalf("the branch's items %+v", got)
	}

	// The end of turn 1 of three finished turns is forked with the id on turn 2's mark; a pi
	// branch keeps no fork source.
	e = newEnv(t)
	id, _ = e.talked(model.Pi, "", 3)
	_, bid, _ = e.branchTo(id, newAt(3), "aside")
	want = agent.ForkSource{ChatID: id, Dir: e.st.P.ChatDir(id), SessionID: e.meta(id).SessionID, Point: "p1", Next: "p2"}
	if got := e.pi.forkCalls()[0].src; got != want {
		t.Fatalf("pi branch at the end of turn 1 %+v, want %+v", got, want)
	}
	if e.meta(bid).ForkSource != nil {
		t.Fatal("a pi branch keeps a fork source")
	}
}

// ---- a new branch ---------------------------------------------------------

func TestSendToNewBranch(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, mainAg := e.talked(model.Claude, "", 3)
	e.setDefaults(model.Defaults{})
	if err := e.setDraft(id, model.Draft{Text: "typed"}); err != nil {
		t.Fatal(err)
	}
	main, mainItems := e.meta(id), e.file(id, "items.jsonl")
	named := len(e.namer.callList())
	evs := e.listen()

	// A17: while its process starts, the branch's token resolves; no client sees the branch.
	var caller Caller
	var resolved bool
	e.claude.set(func(s *fakeSpawner) {
		s.onFork = func(o agent.SpawnOptions) {
			caller, resolved = e.m.ResolveToken(o.MCP.Token)
			if v := e.view(id); v.Branch != "" || v.Branches != 0 || v.Draft == nil {
				t.Errorf("view during the start %+v", v)
			}
			if _, _, _, _, err := e.m.ItemsOf(id, splitBranch(o.ChatID)); !errors.Is(err, ErrNoBranch) {
				t.Errorf("the branch's items during the start: %v", err)
			}
		}
	})
	// Something lies after the point: a new branch, also without the flag.
	e.sendTo(id, mainAt(3), "another way")
	e.claude.set(func(s *fakeSpawner) { s.onFork = nil })

	rec, _ := e.treeFile(id)
	if len(rec.Branches) != 1 || rec.Branches[0].From != model.MainBranch || rec.Branches[0].At != 3 || rec.Current != rec.Branches[0].ID {
		t.Fatalf("tree record %+v", rec)
	}
	b := rec.Branches[0].ID
	bid := branchChatID(id, b)
	if len(b) != 8 || !validBranchID(b) || strings.ToLower(b) != b {
		t.Fatalf("branch id %q", b)
	}

	// The folder: the whole path, the message, a chat.json of its own.
	got := e.diskItems(bid)
	if len(got) != 4 || !reflect.DeepEqual(got[:3], e.diskItems(id)[:3]) || got[3].Kind != "user" || got[3].Text != "another way" {
		t.Fatalf("the branch's items.jsonl %+v", got)
	}
	bm := e.meta(bid)
	if bm.ID != bid || bm.Token == "" || bm.Token == main.Token || bm.SessionID == "" || bm.SessionID == main.SessionID {
		t.Fatalf("the branch's chat.json %+v", bm)
	}
	if bm.Agent != main.Agent || bm.Cwd != main.Cwd || bm.Model != main.Model || bm.Effort != main.Effort || bm.Board != main.Board {
		t.Fatalf("the branch's settings %+v, main's %+v", bm, main)
	}
	if bm.Name != "" || bm.Group != "" || bm.Draft != nil || bm.Archived || bm.ForkedFrom != "" || bm.ForkedFromTitle != "" || bm.UserNamed {
		t.Fatalf("the branch's chat.json holds what is the chat's: %+v", bm)
	}
	if !bm.Locked || !bm.TurnActive || bm.Usage.Turns != 1 {
		t.Fatalf("the branch's state %+v", bm)
	}
	if want := (&model.ForkSource{Chat: id, Session: main.SessionID, Point: "p1", Next: "p2", Items: 3}); !reflect.DeepEqual(bm.ForkSource, want) {
		t.Fatalf("forkSource %+v, want %+v", bm.ForkSource, want)
	}

	// Its process is the fork of main's session at the mark: one fork start, no spawn, and the
	// message reached it once.
	calls := e.claude.forkCalls()
	if len(calls) != 1 || e.claude.count() != 1 {
		t.Fatalf("%d fork starts, %d spawns", len(calls), e.claude.count())
	}
	if want := (agent.ForkSource{ChatID: id, Dir: e.st.P.ChatDir(id), SessionID: main.SessionID, Point: "p1", Next: "p2"}); calls[0].src != want {
		t.Fatalf("fork source %+v, want %+v", calls[0].src, want)
	}
	if o := calls[0].opts; o.ChatID != bid || o.SessionID != bm.SessionID || !o.Resume || o.MCP == nil || o.MCP.Token != bm.Token {
		t.Fatalf("fork options %+v", o)
	}
	fa := e.claude.lastFork(t)
	if sent := fa.sent(); len(sent) != 1 || !reflect.DeepEqual(texts(sent[0]), []string{"another way"}) {
		t.Fatalf("the branch's process got %v", sent)
	}
	if !resolved || caller.Chat != id || caller.Meta.ID != bid || caller.Meta.Token != bm.Token {
		t.Fatalf("the token during the start: %+v, %v", caller, resolved)
	}

	// Main is intact and keeps its process. Its draft is its own: a message sent on another
	// branch leaves it, and the new branch has none.
	if !bytes.Equal(e.file(id, "items.jsonl"), mainItems) {
		t.Fatal("main's items.jsonl changed")
	}
	if d := main.Drafts[model.MainBranch]; len(main.Drafts) != 1 || d == nil || d.Text != "typed" {
		t.Fatalf("main's draft before the Send %+v", main.Drafts)
	}
	if after := e.meta(id); !reflect.DeepEqual(after, main) {
		t.Fatalf("main's chat.json %+v, want %+v", after, main)
	}
	if mainAg.isClosed() || mainAg.interrupted() != 0 || len(mainAg.sent()) != 3 || fa.isClosed() {
		t.Fatal("the new branch stopped a process")
	}

	// The view names the branch; the first-send effects are the chat's alone.
	v := e.view(id)
	if v.Branches != 2 || v.Branch != b || v.Draft != nil || !v.HasDraft || v.Status != model.StatusThinking || v.Name != main.Name || !v.Locked {
		t.Fatalf("view %+v", v)
	}
	e.m.naming.Wait()
	if n := len(e.namer.callList()); n != named {
		t.Fatalf("the auto namer ran for a branch's first message: %v", e.namer.callList())
	}
	e.noDefaults()

	// The client: one chat event naming the branch, and never its server id. Before it comes
	// the branch's first state record and nothing else: nothing was sent of the branch before
	// that, and nothing of main, which the Send did not touch. Main's record is as it was, its
	// draft kept. After it the tree gets the branch, as the current one.
	first := evs.drain(t, e.br)
	if !reflect.DeepEqual(typesOf(first), []string{"branch_state", "chat", "tree"}) || namesChat(first, "/branches/") {
		t.Fatalf("events of the Send %+v", first)
	}
	if p := treeIn(t, first[2]); p.Chat != id || p.Branch == nil || p.Labels != nil || p.Current == nil || *p.Current != b ||
		!reflect.DeepEqual(*p.Branch, e.tree(id).Branches[1]) || p.Branch.ID != b || p.Branch.From != model.MainBranch || p.Branch.At != 3 {
		t.Fatalf("the tree event of the new branch %s", p)
	}
	if st := e.stateOfBranch(id, model.MainBranch); st.Status != model.StatusReady || st.Draft == nil || st.Draft.Text != "typed" {
		t.Fatalf("main's state record %+v", st)
	}
	if st := stateIn(t, first[0]); st.Chat != id || st.Branch != b || st.Status != model.StatusThinking || !st.Locked || st.Draft != nil {
		t.Fatalf("the branch's first state record %+v", st)
	}
	first = first[1:]
	if c := chatOf(t, first[0]); c["id"] != id || c["branch"] != b || c["branches"] != 2.0 || c["status"] != string(model.StatusThinking) || c["hasDraft"] != true {
		t.Fatalf("chat event %v", c)
	} else if _, draft := c["draft"]; draft {
		t.Fatalf("chat event with a draft, which the new branch has none of: %v", c)
	}
	if served, _, items, _, err := e.m.ItemsOf(id, ""); err != nil || served != b || len(items) != 4 || items[3].Text != "another way" {
		t.Fatalf("the current branch's items: %q %+v %v", served, items, err)
	}
	fa.emit(t, reply("q1")...)
	later := evs.drain(t, e.br)
	items := ofType(later, "chat_items")
	if len(items) == 0 || namesChat(later, "/branches/") {
		t.Fatalf("events of the branch's turn %+v", later)
	}
	for _, ev := range items {
		if ev["chat"] != id || ev["branch"] != b {
			t.Fatalf("chat_items event %v", ev)
		}
	}
	// A18: the fork source goes at the first turn end after the Send.
	if m := e.meta(bid); m.ForkSource != nil || m.TurnActive || m.Usage.Turns != 2 {
		t.Fatalf("the branch's chat.json after its turn %+v", m)
	}
	if got := e.diskItems(bid); len(got) != 6 || got[5].Kind != "end" || got[5].Point != "q1" {
		t.Fatalf("the branch's items.jsonl after its turn %+v", got)
	}

	// A restart: the chat shows the branch that was current, and both tokens resolve.
	e.m.Shutdown()
	e.boot()
	if v := e.view(id); v.Branches != 2 || v.Branch != b || len(e.items(id)) != 6 {
		t.Fatalf("view after a restart %+v", v)
	}
	for tok, sid := range map[string]string{main.Token: id, bm.Token: bid} {
		if c, ok := e.m.ResolveToken(tok); !ok || c.Chat != id || c.Meta.ID != sid {
			t.Fatalf("the token of %s after a restart: %+v, %v", sid, c, ok)
		}
	}
	// A Send without a target goes on on the branch, resuming its own session.
	e.send(id, "more", "")
	if o := e.claude.last(t).opts; o.ChatID != bid || o.SessionID != bm.SessionID || !o.Resume || len(e.claude.forkCalls()) != 0 {
		t.Fatalf("spawn options after a restart %+v", o)
	}
}

// splitBranch is the branch id a server id names.
func splitBranch(id string) string {
	_, b := splitID(id)
	return b
}

func TestSendToAtTheEnd(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, mainAg := e.talked(model.Claude, "", 2)
	main := e.meta(id)

	// A5: Branch on the last reply forks the end of the session.
	b, bid, fa := e.branchTo(id, newAt(6), "aside")
	if rec, _ := e.treeFile(id); !reflect.DeepEqual(rec.Branches, []model.TreeBranch{{ID: b, From: model.MainBranch, At: 6}}) || rec.Current != b {
		t.Fatalf("tree record %+v", rec)
	}
	if want := (agent.ForkSource{ChatID: id, Dir: e.st.P.ChatDir(id), SessionID: main.SessionID, Point: "p2", End: true}); e.claude.forkCalls()[0].src != want {
		t.Fatalf("fork source %+v, want %+v", e.claude.forkCalls()[0].src, want)
	}
	if got := e.diskItems(bid); len(got) != 7 || got[6].Text != "aside" || mainAg.isClosed() {
		t.Fatalf("the branch's items %+v, main's process closed %v", got, mainAg.isClosed())
	}

	// While the branch works its own end takes no message, and the refusal changes nothing.
	if err := e.sendToErr(id, Target{Branch: b, At: 7}); !errors.Is(err, ErrBusy) {
		t.Fatalf("a message to the end of the working branch: %v", err)
	}
	if e.cur(id) != b || fa.isClosed() {
		t.Fatal("a refused Send changed the current branch")
	}
	fa.emit(t, reply("q1")...)
	// Main's process ends here, so that carrying main on has to start one.
	e.m.stopBranch(id)
	bm, branchItems := e.meta(bid), e.file(bid, "items.jsonl")
	if err := e.setDraft(id, model.Draft{Text: "typed"}); err != nil {
		t.Fatal(err)
	}

	// Sending at main's end carries main on: it is current again, the other branch keeps its
	// process, and main's own session is resumed.
	evs := e.listen()
	e.sendTo(id, mainAt(6), "back on main")
	rec, _ := e.treeFile(id)
	if len(rec.Branches) != 1 || rec.Current != model.MainBranch {
		t.Fatalf("tree record after carrying main on %+v", rec)
	}
	// The draft was typed on the branch left: it is still that branch's, and main has none.
	if v := e.view(id); v.Branch != "" || v.Branches != 2 || v.Draft != nil || !v.HasDraft || v.Status != model.StatusThinking {
		t.Fatalf("view %+v", v)
	}
	if ds := e.meta(id).Drafts; len(ds) != 1 || ds[b] == nil || ds[b].Text != "typed" {
		t.Fatalf("the drafts after carrying main on %+v", ds)
	}
	if fa.isClosed() || fa.interrupted() != 0 {
		t.Fatal("the branch left was stopped")
	}
	if len(e.claude.forkCalls()) != 1 || e.claude.count() != 2 {
		t.Fatalf("%d fork starts, %d spawns", len(e.claude.forkCalls()), e.claude.count())
	}
	a := e.claude.last(t)
	if o := a.opts; o.ChatID != id || o.SessionID != main.SessionID || !o.Resume || o.MCP.Token != main.Token {
		t.Fatalf("spawn options %+v", o)
	}
	if sent := a.sent(); len(sent) != 1 || !reflect.DeepEqual(texts(sent[0]), []string{"back on main"}) {
		t.Fatalf("main's process got %v", sent)
	}
	if got := e.items(id); len(got) != 7 || got[6].Text != "back on main" {
		t.Fatalf("main's items %+v", got)
	}
	// The branch left keeps its folder and its token.
	if !bytes.Equal(e.file(bid, "items.jsonl"), branchItems) || e.meta(bid).Token != bm.Token {
		t.Fatal("the branch left was changed")
	}
	if c, ok := e.m.ResolveToken(bm.Token); !ok || c.Chat != id || c.Meta.ID != bid {
		t.Fatalf("the token of the branch left: %+v, %v", c, ok)
	}
	got := evs.drain(t, e.br)
	chatEvs := ofType(got, "chat")
	if len(chatEvs) == 0 || namesChat(got, "/branches/") {
		t.Fatalf("events %+v", got)
	}
	last := chatOf(t, chatEvs[len(chatEvs)-1])
	if _, named := last["branch"]; named || last["branches"] != 2.0 || last["status"] != string(model.StatusThinking) {
		t.Fatalf("the last chat event %v", last)
	}
	// The whole of it: the message and the record of the branch carried on, the chat's view
	// with one more branch working, which still names the branch left, and once the message is
	// in the thread the view that names the branch carried on. Each view is followed by what
	// changed of the tree with it: the part of the branch carried on, then the current branch.
	if !reflect.DeepEqual(typesOf(got), []string{"chat_items", "branch_state", "chat", "tree", "chat", "tree"}) {
		t.Fatalf("events of the carry-on %v", typesOf(got))
	}
	if p := treeIn(t, got[3]).branchPart(t, model.MainBranch); p.Len != 7 || p.Items[len(p.Items)-1].Text != "back on main" {
		t.Fatalf("the part of the branch carried on %+v", p)
	}
	if p := treeIn(t, got[5]); p.Current == nil || *p.Current != model.MainBranch || p.Branch != nil || p.Labels != nil {
		t.Fatalf("the tree event of the current branch %s", p)
	}
	if st := stateIn(t, got[1]); st.Branch != model.MainBranch || st.Status != model.StatusThinking {
		t.Fatalf("the record of the branch carried on %+v", st)
	}
	if c := chatOf(t, got[2]); c["branch"] != b || c["working"] != 1.0 || c["status"] != string(model.StatusReady) {
		t.Fatalf("the chat event of the message %v", c)
	}
	for _, ev := range ofType(got, "chat_items") {
		if ev["branch"] != model.MainBranch {
			t.Fatalf("chat_items of another branch than the one carried on: %v", ev)
		}
	}

	// And back at the branch's end, with the flag off: the message goes to the process the
	// branch kept.
	a.emit(t, reply("p3")...)
	e.sendTo(id, Target{Branch: b, At: 9}, "back on the branch")
	if sent := fa.sent(); e.cur(id) != b || a.isClosed() || fa.isClosed() || e.claude.count() != 2 || len(sent) != 2 ||
		!reflect.DeepEqual(texts(sent[1]), []string{"back on the branch"}) {
		t.Fatalf("current %q, %d spawns, the branch's process got %v", e.cur(id), e.claude.count(), sent)
	}
	fa.emit(t, reply("q2")...)

	// Once its process is gone, its session is resumed.
	e.m.stopBranch(bid)
	e.sendTo(id, Target{Branch: b, At: 12}, "and again")
	if e.cur(id) != b || a.isClosed() || e.claude.count() != 3 || len(e.claude.forkCalls()) != 1 {
		t.Fatalf("current %q, %d spawns, %d fork starts", e.cur(id), e.claude.count(), len(e.claude.forkCalls()))
	}
	if o := e.claude.last(t).opts; o.ChatID != bid || o.SessionID != bm.SessionID || !o.Resume {
		t.Fatalf("spawn options %+v", o)
	}
	if got := e.diskItems(bid); len(got) != 13 || got[9].Text != "back on the branch" || got[12].Text != "and again" {
		t.Fatalf("the branch's items %+v", got)
	}
}

// A5: a branch whose last turn has no end mark is carried on at its end, and takes no new branch
// there.
func TestSendToEndWithoutMark(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, a := e.talked(model.Claude, "", 1)
	main := e.meta(id)
	e.send(id, "ask 2", "")
	a.emit(t, agent.Event{Kind: agent.EvText, Text: "half a rep"})
	a.exit(t) // the turn is cut: no mark
	if e.m.Busy(id) {
		t.Fatal("busy after the process ended")
	}
	n := len(e.items(id))
	if _, ok := nextMark(e.items(id), 3); ok {
		t.Fatalf("the cut turn has a mark: %+v", e.items(id))
	}
	if err := e.sendToErr(id, newAt(n)); !errors.Is(err, ErrBadPoint) {
		t.Fatalf("a new branch at an end without a mark: %v", err)
	}
	e.unsplit(id)

	_, _, fa := e.branchTo(id, newAt(3), "aside")
	fa.emit(t, reply("q1")...)
	if err := e.sendToErr(id, newAt(n)); !errors.Is(err, ErrBadPoint) {
		t.Fatalf("a new branch at the end of another branch, without a mark: %v", err)
	}
	if fa.isClosed() {
		t.Fatal("a refused branch stopped the current one")
	}
	spawns := e.claude.count()
	e.sendTo(id, mainAt(n), "go on")
	if e.cur(id) != model.MainBranch || fa.isClosed() || e.claude.count() != spawns+1 || len(e.claude.forkCalls()) != 1 {
		t.Fatalf("current %q, %d spawns, %d fork starts, the branch left closed %v", e.cur(id), e.claude.count(), len(e.claude.forkCalls()), fa.isClosed())
	}
	if o := e.claude.last(t).opts; o.ChatID != id || o.SessionID != main.SessionID || !o.Resume {
		t.Fatalf("spawn options %+v", o)
	}
	if got := e.items(id); len(got) != n+1 || got[n].Text != "go on" {
		t.Fatalf("main's items %+v", got)
	}
}

// A6: the start of a chat has nothing to fork.
func TestSendToFromTheStart(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, mainAg := e.talked(model.Claude, "", 2)
	e.setDefaults(model.Defaults{})
	main := e.meta(id)
	named := len(e.namer.callList())

	b, bid, a := e.branchTo(id, newAt(0), "start over")
	if rec, _ := e.treeFile(id); !reflect.DeepEqual(rec.Branches, []model.TreeBranch{{ID: b, From: model.MainBranch, At: 0}}) || rec.Current != b {
		t.Fatalf("tree record %+v", rec)
	}
	if len(e.claude.forkCalls()) != 0 || e.claude.count() != 2 || len(e.claude.discarded()) != 0 {
		t.Fatalf("%d fork starts, %d spawns", len(e.claude.forkCalls()), e.claude.count())
	}
	bm := e.meta(bid)
	if o := a.opts; o.ChatID != bid || o.Resume || o.SessionID == "" || o.SessionID == main.SessionID || o.SessionID != bm.SessionID {
		t.Fatalf("spawn options %+v", o)
	}
	// A17: the process got its MCP token at its normal spawn, and it is the chat's.
	if c, ok := e.m.ResolveToken(a.opts.MCP.Token); !ok || c.Chat != id || c.Meta.ID != bid || a.opts.MCP.Token == main.Token {
		t.Fatalf("the empty branch's token: %+v, %v", c, ok)
	}
	if sent := a.sent(); len(sent) != 1 || !reflect.DeepEqual(texts(sent[0]), []string{"start over"}) {
		t.Fatalf("the process got %v", sent)
	}
	if got := e.diskItems(bid); len(got) != 1 || got[0].Kind != "user" || got[0].Text != "start over" {
		t.Fatalf("the branch's items.jsonl %+v", got)
	}
	if !bm.Locked || !bm.TurnActive || bm.Usage.Turns != 0 || bm.ForkSource != nil || bm.Name != "" || bm.Group != "" {
		t.Fatalf("the branch's chat.json %+v", bm)
	}
	if len(e.items(id)) != 1 || e.view(id).Branches != 2 {
		t.Fatal("the branch from the start is not the current one")
	}
	if mainAg.isClosed() {
		t.Fatal("the branch from the start stopped main")
	}
	// The first-send effects are the chat's, also for a branch that starts empty.
	e.m.naming.Wait()
	if n := len(e.namer.callList()); n != named || e.meta(id).Name != main.Name {
		t.Fatalf("the auto namer ran for a branch from the start: %v", e.namer.callList())
	}
	e.noDefaults()

	// Something lies after the start: the flag is not needed.
	a.emit(t, reply("s1")...)
	if e.sendTo(id, mainAt(0), "once more"); len(e.claude.forkCalls()) != 0 || e.claude.count() != 3 {
		t.Fatalf("%d fork starts, %d spawns", len(e.claude.forkCalls()), e.claude.count())
	}
	if rec, _ := e.treeFile(id); len(rec.Branches) != 2 || rec.Branches[1].From != model.MainBranch || rec.Branches[1].At != 0 {
		t.Fatalf("tree record %+v", rec)
	}

	// A Cursor board chat gets the whiteboard instructions again.
	e = newEnv(t)
	bd, err := e.bds.Create("board", gOne, false)
	if err != nil {
		t.Fatal(err)
	}
	id, _ = e.talked(model.Cursor, bd.ID, 2)
	if !e.meta(id).McpInstructionsSent {
		t.Fatal("the board chat did not get its instructions")
	}
	_, bid, a = e.branchTo(id, newAt(0), "start over")
	if o := a.opts; o.ChatID != bid || o.Resume || o.SessionID != "" || o.BoardID != bd.ID {
		t.Fatalf("spawn options %+v", o)
	}
	sent := a.sent()
	if len(sent) != 1 || len(sent[0]) != 3 || sent[0][0].Text != prompts.Claude() || sent[0][2].Text != "start over" {
		t.Fatalf("the process got %v", sent)
	}
	if bm := e.meta(bid); !bm.McpInstructionsSent || bm.Board != bd.ID || bm.SessionID != "" {
		t.Fatalf("the branch's chat.json %+v", bm)
	}
	if len(e.cursor.forkCalls()) != 0 || len(e.m.ChatsOfBoard(bd.ID)) != 1 {
		t.Fatalf("%d fork starts, %d chats of the board", len(e.cursor.forkCalls()), len(e.m.ChatsOfBoard(bd.ID)))
	}

	// The first mark has no id: the start is no point.
	e = newEnv(t)
	id = e.stored(model.Claude, []model.Item{pUser(), pText(), pEnd(""), pUser(), pText(), pEnd("p2")})
	for _, tg := range []Target{newAt(0), mainAt(0)} {
		if err := e.sendToErr(id, tg); !errors.Is(err, ErrBadPoint) {
			t.Fatalf("%+v in a chat whose first mark has no id: %v", tg, err)
		}
	}
	e.unsplit(id)
	if e.claude.count() != 0 {
		t.Fatal("a refused branch from the start spawned")
	}
}

// A point on a part two branches share is one place: the new branch splits from its owner.
func TestSendToRecordsTheOwner(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 3)
	x, xid, xa := e.branchTo(id, newAt(6), "on x")
	xa.emit(t, reply("x1")...)
	xm := e.meta(xid)

	// Through x, a point main owns.
	y, yid, ya := e.branchTo(id, Target{Branch: x, At: 3, New: true}, "on y")
	rec, _ := e.treeFile(id)
	want := []model.TreeBranch{{ID: x, From: model.MainBranch, At: 6}, {ID: y, From: model.MainBranch, At: 3}}
	if !reflect.DeepEqual(rec.Branches, want) || rec.Current != y {
		t.Fatalf("tree record %+v, want %+v", rec, want)
	}
	// It is x's session that is forked: x is the branch the point was named on.
	if got, want := e.claude.forkCalls()[1].src, (agent.ForkSource{ChatID: xid, Dir: e.st.P.ChatDir(xid), SessionID: xm.SessionID, Point: "p1", Next: "p2"}); got != want {
		t.Fatalf("fork source %+v, want %+v", got, want)
	}
	if got := e.diskItems(yid); len(got) != 4 || !reflect.DeepEqual(got[:3], e.diskItems(id)[:3]) || got[3].Text != "on y" {
		t.Fatalf("y's items %+v", got)
	}
	if xa.isClosed() {
		t.Fatal("x, the branch left, was stopped")
	}
	ya.emit(t, reply("y1")...)

	// A point x owns.
	z, _, _ := e.branchTo(id, Target{Branch: x, At: 9, New: true}, "on z")
	rec, _ = e.treeFile(id)
	if got := rec.Branches[2]; got != (model.TreeBranch{ID: z, From: x, At: 9}) || rec.Current != z {
		t.Fatalf("tree record %+v", rec)
	}
	if v := e.view(id); v.Branches != 4 || v.Branch != z {
		t.Fatalf("view %+v", v)
	}
	// The tree route shows them all, each off its split.
	tv := e.tree(id)
	if len(tv.Branches) != 4 || tv.Current != z || tv.Branches[3].From != x || tv.Branches[3].Len != 10 || len(tv.Branches[3].Items) != 1 {
		t.Fatalf("tree %+v", tv)
	}
	e.m.Shutdown()
	e.boot()
	if v := e.view(id); v.Branches != 4 || v.Branch != z {
		t.Fatalf("view after a restart %+v", v)
	}
}

// ---- failure --------------------------------------------------------------

func TestSendToFailureLeavesNothing(t *testing.T) {
	t.Parallel()
	boom := errors.New("the provider said no")
	cases := []struct {
		name string
		// during runs while the start is blocked; fail is what the start then ends with.
		during  func(e *env, id string)
		fail    error
		want    error
		started bool // the start succeeds: its process is closed and the fork discarded
		deleted bool // the chat is gone
		stopped bool // the current branch was stopped by what ran during the start
	}{
		{name: "the start blocks and fails", fail: boom, want: boom},
		{name: "the chat is deleted", during: func(e *env, id string) {
			if err := e.m.Delete(id); err != nil {
				e.t.Fatal(err)
			}
		}, want: ErrNotFound, started: true, deleted: true},
		{name: "the chat is archived", during: func(e *env, id string) {
			e.m.Stop(id)
			if err := e.m.SetArchive(id, model.Archive{Archived: true, Op: "op1"}); err != nil {
				e.t.Fatal(err)
			}
		}, want: ErrArchived, started: true, stopped: true},
	}
	for _, kind := range []model.AgentKind{model.Claude, model.Cursor} {
		for _, tc := range cases {
			t.Run(string(kind)+"/"+tc.name, func(t *testing.T) {
				e := newEnv(t)
				id, mainAg := e.talked(kind, "", 2)
				sp := e.spawner(kind)
				before := e.meta(id)
				evs := e.listen()

				b, res := e.block(sp, func() error { return e.m.SendTo(id, newAt(3), "aside", "", nil) })
				b.watch()
				// A17: the starting process finds its token, which is the chat's.
				if c, ok := e.m.ResolveToken(b.opts.MCP.Token); !ok || c.Chat != id || c.Meta.ID != b.opts.ChatID {
					t.Fatalf("the token during the start: %+v, %v", c, ok)
				}
				if chat, _ := splitID(b.opts.ChatID); chat != id {
					t.Fatalf("the start was asked for %q", b.opts.ChatID)
				}
				if tc.during != nil {
					tc.during(e, id)
				}
				if err := b.release(res, tc.fail); !errors.Is(err, tc.want) {
					t.Fatalf("SendTo: %v, want %v", err, tc.want)
				}
				e.gone(b.opts)
				got := evs.drain(t, e.br)
				if namesChat(got, "/branches/") || namesChat(got, splitBranch(b.opts.ChatID)) {
					t.Fatalf("an event named the branch: %+v", got)
				}
				if tc.started {
					// The confirmed process is closed, then what the start made is discarded.
					fa := sp.lastFork(t)
					waitFor(t, "the branch's process to close", fa.isClosed)
					sid := b.opts.SessionID
					if kind == model.Cursor {
						sid = "forked-1"
					}
					waitFor(t, "the fork to be discarded", func() bool { return reflect.DeepEqual(sp.discarded(), []string{sid}) })
					if len(fa.sent()) != 0 {
						t.Fatalf("the message reached the process: %v", fa.sent())
					}
				} else if len(sp.discarded()) != 0 {
					t.Fatalf("discarded %v after a failed start", sp.discarded())
				}
				if tc.deleted {
					if _, err := os.Stat(e.st.P.ChatDir(id)); !os.IsNotExist(err) {
						t.Fatalf("the deleted chat's folder: %v", err)
					}
					return
				}

				// The chat is as it was: one branch, the same current one, no message.
				e.unsplit(id)
				items := e.items(id)
				if len(items) != 6 {
					t.Fatalf("main's items %+v", items)
				}
				for _, it := range items {
					if it.Text == "aside" {
						t.Fatalf("the message was added: %+v", items)
					}
				}
				if after := e.meta(id); after.SessionID != before.SessionID || after.Token != before.Token {
					t.Fatalf("main's chat.json %+v", after)
				}
				if mainAg.isClosed() != tc.stopped || sp.count() != 1 {
					t.Fatalf("the current branch's process: closed %v, %d spawns", mainAg.isClosed(), sp.count())
				}
			})
		}
	}
}

// A failed branch of a chat that is split already: the record and the current branch stay.
func TestSendToFailureKeepsTheTree(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 3)
	b, bid, fa := e.branchTo(id, newAt(3), "aside")
	fa.emit(t, reply("q1")...)
	record, branchFiles := e.file(id, "tree.json"), folder(t, e.st.P.ChatDir(bid), true)
	evs := e.listen()

	boom := errors.New("No conversation found")
	e.claude.set(func(s *fakeSpawner) { s.forkErr = boom })
	for _, tg := range []Target{newAt(6), {Branch: b, At: 6, New: true}, {Branch: b, At: 3}} {
		if err := e.sendToErr(id, tg); !errors.Is(err, boom) {
			t.Fatalf("SendTo %+v: %v", tg, err)
		}
	}
	calls := e.claude.forkCalls()
	if len(calls) != 4 {
		t.Fatalf("%d fork starts", len(calls))
	}
	for _, call := range calls[1:] {
		e.gone(call.opts)
	}
	if !bytes.Equal(e.file(id, "tree.json"), record) || e.cur(id) != b || e.view(id).Branches != 2 {
		t.Fatalf("the record or the current branch changed: %s", e.file(id, "tree.json"))
	}
	if after := folder(t, e.st.P.ChatDir(bid), true); !reflect.DeepEqual(after, branchFiles) || fa.isClosed() {
		t.Fatal("the current branch was touched")
	}
	if ents, err := os.ReadDir(filepath.Join(e.st.P.ChatDir(id), "branches")); err != nil || len(ents) != 1 {
		t.Fatalf("the branches folder holds %v (%v)", ents, err)
	}
	if got := evs.drain(t, e.br); len(got) != 0 || len(e.claude.discarded()) != 0 {
		t.Fatalf("events %+v, discarded %v", got, e.claude.discarded())
	}

	// Without the fork capability: the same, and the start of the chat still works.
	e.m.Spawners[model.Claude] = plainSpawner{e.claude}
	if err := e.sendToErr(id, newAt(6)); err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("SendTo without the fork capability: %v", err)
	}
	if !bytes.Equal(e.file(id, "tree.json"), record) || fa.isClosed() {
		t.Fatal("the record or the current branch changed")
	}
	e.sendTo(id, newAt(0), "start over")
	if rec, _ := e.treeFile(id); len(rec.Branches) != 2 || fa.isClosed() {
		t.Fatalf("tree record %+v, the branch left closed %v", rec, fa.isClosed())
	}
}

// A branch that is carried on and cannot be started: the message is not in its thread, so the
// current branch is the one it was, at every moment. The error of the start is on the record of
// the branch that did not start, and clients get nothing else.
func TestSendToCarryOnFailureKeepsTheCurrentBranch(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 2)
	b, bid, fa := e.branchTo(id, newAt(3), "aside")
	fa.emit(t, reply("b1")...)
	e.m.stopBranch(id) // main's process ends: a message to main has to start one
	d := model.Draft{References: []model.Reference{{Quote: "reply b1", Comment: "on the branch's reply", Item: 4, Start: 0, End: 8}}}
	if err := e.setDraft(id, d); err != nil {
		t.Fatal(err)
	}
	mainItems, branchItems := e.file(id, "items.jsonl"), e.file(bid, "items.jsonl")
	same := func(what string) {
		t.Helper()
		if rec, _ := e.treeFile(id); e.cur(id) != b || rec.Current != b {
			t.Fatalf("%s: the current branch is %q, the record's %q", what, e.cur(id), rec.Current)
		}
		if fa.isClosed() || fa.interrupted() != 0 {
			t.Fatalf("%s: the branch left was stopped", what)
		}
		if v := e.view(id); !reflect.DeepEqual(v.Draft, &d) || v.Status != model.StatusReady || v.FolderMissing || v.Error != "" {
			t.Fatalf("%s: view %+v", what, v)
		}
		if !bytes.Equal(e.file(id, "items.jsonl"), mainItems) || !bytes.Equal(e.file(bid, "items.jsonl"), branchItems) {
			t.Fatalf("%s: a thread changed", what)
		}
	}

	// A quote that names no message of the branch is refused before anything is started.
	if err := e.m.SendTo(id, mainAt(6), "back on main", "", []model.Reference{{Item: 6, Quote: "reply"}}); !errors.Is(err, ErrBadReference) {
		t.Fatalf("SendTo with a quote past main's end: %v", err)
	}
	same("a refused quote")

	// Main has to start again, and its folder is gone.
	cwd := e.meta(id).Cwd
	if err := os.Rename(cwd, cwd+".gone"); err != nil {
		t.Fatal(err)
	}
	evs := e.listen()
	if err := e.m.SendTo(id, mainAt(6), "back on main", "", nil); !errors.Is(err, ErrFolderMissing) {
		t.Fatalf("SendTo with main's folder gone: %v", err)
	}
	same("a start that failed")
	// A client gets one event: the record of main, with the error. No view of the chat is sent:
	// main was never the current branch, and no count over the branches changed.
	got := evs.drain(t, e.br)
	if !reflect.DeepEqual(typesOf(got), []string{"branch_state"}) {
		t.Fatalf("events of the failed start %+v", got)
	}
	if st := stateIn(t, got[0]); st.Chat != id || st.Branch != model.MainBranch || st.Status != model.StatusError || !st.FolderMissing || st.Error == "" {
		t.Fatalf("the record of the branch that did not start %+v", st)
	}
	if st := e.stateOfBranch(id, model.MainBranch); st.Status != model.StatusError || !st.FolderMissing {
		t.Fatalf("main's record after the failed start %+v", st)
	}
	// The branch left is the one a message goes to, in the process it had.
	e.send(id, "still here", "")
	if sent := fa.sent(); len(sent) != 2 || !reflect.DeepEqual(texts(sent[1]), []string{"still here"}) {
		t.Fatalf("the process of the branch left got %v", sent)
	}
	fa.emit(t, reply("b2")...)
	if err := os.Rename(cwd+".gone", cwd); err != nil {
		t.Fatal(err)
	}

	// The same when the branch is started through the fork capability: its first turn was cut.
	e.sendTo(id, mainAt(6), "back on main")
	a := e.claude.last(t)
	a.emit(t, reply("p3")...)
	b2, _, _ := e.branchTo(id, newAt(3), "cut")
	e.m.Stop(id)
	e.sendTo(id, mainAt(9), "on main again")
	a = e.claude.last(t)
	a.emit(t, reply("p4")...)
	_, _, items, _, err := e.m.ItemsOf(id, b2)
	if err != nil {
		t.Fatal(err)
	}
	record := e.file(id, "tree.json")
	boom := errors.New("No conversation found")
	e.claude.set(func(s *fakeSpawner) { s.forkErr = boom })
	if err := e.m.SendTo(id, Target{Branch: b2, At: len(items)}, "carry on", "", nil); !errors.Is(err, boom) {
		t.Fatalf("SendTo with a fork start that fails: %v", err)
	}
	e.claude.set(func(s *fakeSpawner) { s.forkErr = nil })
	if e.cur(id) != model.MainBranch || !bytes.Equal(e.file(id, "tree.json"), record) || a.isClosed() {
		t.Fatalf("after a failed fork start: current %q, record %s, main's process closed %v", e.cur(id), e.file(id, "tree.json"), a.isClosed())
	}
	if v := e.view(id); v.Status != model.StatusReady || v.Error != "" {
		t.Fatalf("view %+v", v)
	}
	// The error is the branch's own.
	if st := e.stateOfBranch(id, b2); st.Status != model.StatusError || st.Error == "" {
		t.Fatalf("the record of the branch whose fork start failed %+v", st)
	}
}

// A branch that is carried on and whose process refuses the message: the message is in its
// thread, as after a refused Send, so the branch is the current one. The branch left runs on.
func TestSendToCarryOnRefusedMessageMoves(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 2)
	b, _, fa := e.branchTo(id, newAt(3), "aside")
	fa.emit(t, reply("b1")...)
	e.m.stopBranch(id) // main's process ends: a message to main has to start one
	if err := e.setDraft(id, model.Draft{Text: "typed"}); err != nil {
		t.Fatal(err)
	}
	rejected := errors.New("stdin closed")
	e.m.Spawners[model.Claude] = refusingSpawner{e.claude, rejected}
	if err := e.m.SendTo(id, mainAt(6), "back on main", "", nil); !errors.Is(err, rejected) {
		t.Fatalf("SendTo to a process that refuses the message: %v", err)
	}
	if rec, _ := e.treeFile(id); e.cur(id) != model.MainBranch || rec.Current != model.MainBranch {
		t.Fatalf("the current branch is %q (was %q), the record's %q", e.cur(id), b, rec.Current)
	}
	if got := e.items(id); len(got) != 7 || got[6].Text != "back on main" || e.view(id).Draft != nil {
		t.Fatalf("main's items %+v", got)
	}
	if ds := e.meta(id).Drafts; len(ds) != 1 || ds[b] == nil { // typed on the branch left, and still its own
		t.Fatalf("the drafts %+v", ds)
	}
	if fa.isClosed() || fa.interrupted() != 0 {
		t.Fatal("the branch left was stopped")
	}
}

// refusingSpawner is a fakeSpawner whose spawned processes refuse every message with err.
type refusingSpawner struct {
	*fakeSpawner
	err error
}

func (s refusingSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	ag, err := s.fakeSpawner.Spawn(o)
	if err == nil {
		s.set(func(f *fakeSpawner) { f.agents[len(f.agents)-1].failSends(s.err) })
	}
	return ag, err
}

// Two Sends with a target at once: both branches are made, each with its message. The current
// branch is one of the two, the same in the record and in memory, and no process is stopped.
func TestSendToTwiceAtOnce(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, mainAg := e.talked(model.Claude, "", 2)
	res := make(chan error, 2)
	for _, at := range []int{3, 6} {
		go func() { res <- e.m.SendTo(id, newAt(at), "aside", "", nil) }()
	}
	for range 2 {
		if err := <-res; err != nil {
			t.Fatalf("two Sends at once: %v", err)
		}
	}
	rec, _ := e.treeFile(id)
	if len(rec.Branches) != 2 || e.view(id).Branches != 3 {
		t.Fatalf("tree record %+v", rec)
	}
	if cur := e.cur(id); rec.Current != cur || (cur != rec.Branches[0].ID && cur != rec.Branches[1].ID) {
		t.Fatalf("the current branch is %q, the record's %q, of %+v", cur, rec.Current, rec.Branches)
	}
	if ents, err := os.ReadDir(filepath.Join(e.st.P.ChatDir(id), "branches")); err != nil || len(ents) != 2 {
		t.Fatalf("the branches folder holds %v (%v)", ents, err)
	}
	for _, tb := range rec.Branches {
		if got := e.diskItems(branchChatID(id, tb.ID)); len(got) != tb.At+1 || got[tb.At].Text != "aside" {
			t.Fatalf("the items of the branch at %d: %+v", tb.At, got)
		}
		if st := e.stateOfBranch(id, tb.ID); st.Status != model.StatusThinking {
			t.Fatalf("the record of the branch at %d: %+v", tb.At, st)
		}
	}
	// Three processes run: main's and one for each branch.
	open := 0
	e.claude.set(func(s *fakeSpawner) {
		for _, a := range append(append([]*fakeAgent(nil), s.agents...), s.forked...) {
			if !a.isClosed() {
				open++
			}
		}
	})
	if open != 3 || mainAg.isClosed() || e.view(id).Working != 2 {
		t.Fatalf("%d processes open, main's closed %v, %d branches working", open, mainAg.isClosed(), e.view(id).Working)
	}
}

// A plain Send that comes while a Send with a target is handing its message to the new branch's
// process: it does not wait for that Send, and goes to the branch that is current then, which
// keeps its process and its message when the new branch becomes the current one.
func TestSendToAndSendAtOnce(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, mainAg := e.talked(model.Claude, "", 2)
	fk := gating(e.claude)
	e.m.Spawners[model.Claude] = fk
	answer := func(what string, res chan error) error {
		t.Helper()
		select {
		case err := <-res:
			return err
		case <-time.After(5 * time.Second):
			t.Fatalf("%s did not return", what)
			return nil
		}
	}

	res, plain := make(chan error, 1), make(chan error, 1)
	go func() { res <- e.m.SendTo(id, newAt(3), "aside", "", nil) }()
	g := fk.waiting(t) // the message is at the new branch's process, which holds it
	go func() { plain <- e.m.Send(id, "meanwhile", "", nil) }()
	// The plain Send is answered while the other is still held.
	if err := answer("the plain Send", plain); err != nil {
		t.Fatalf("the plain Send: %v", err)
	}
	if e.cur(id) != model.MainBranch || len(e.items(id)) != 7 {
		t.Fatalf("during the Send with a target: current %q, %d items", e.cur(id), len(e.items(id)))
	}
	close(g.gate)
	if err := answer("the Send with a target", res); err != nil {
		t.Fatalf("SendTo: %v", err)
	}

	// The new branch is the current one, with its message.
	b := e.cur(id)
	fa := e.claude.lastFork(t)
	if rec, _ := e.treeFile(id); b == model.MainBranch || rec.Current != b || fa.isClosed() || len(fa.sent()) != 1 {
		t.Fatalf("current %q, the record's %q; the branch's process: closed %v, %d messages", b, rec.Current, fa.isClosed(), len(fa.sent()))
	}
	if items := e.items(id); len(items) != 4 || items[3].Text != "aside" {
		t.Fatalf("the branch's items %+v", items)
	}
	// Main has the plain Send's message, in the process it had, and works on it.
	if _, _, items, _, err := e.m.ItemsOf(id, model.MainBranch); err != nil || len(items) != 7 || items[6].Text != "meanwhile" {
		t.Fatalf("main's items %+v (%v)", items, err)
	}
	if mainAg.isClosed() || len(mainAg.sent()) != 3 || !e.m.BusyOf(id, model.MainBranch) {
		t.Fatalf("main's process: closed %v, %d messages", mainAg.isClosed(), len(mainAg.sent()))
	}
	if v := e.view(id); v.Working != 2 {
		t.Fatalf("view %+v", v)
	}
}

// The chat is archived while a Send with a target is handing its message to the new branch's
// process, which the archive's Stop does not reach: the branch is not yet one of the chat's. It
// is stopped as soon as it is.
func TestSendToArchivedDuringTheSend(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, mainAg := e.talked(model.Claude, "", 2)
	fk := gating(e.claude)
	e.m.Spawners[model.Claude] = fk

	res := make(chan error, 1)
	go func() { res <- e.m.SendTo(id, newAt(3), "aside", "", nil) }()
	g := fk.waiting(t)
	// What archiving a chat does (App.archiveChat).
	if err := e.m.SetArchive(id, model.Archive{Archived: true, Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	e.m.Stop(id)
	close(g.gate)
	select {
	case err := <-res:
		if err != nil {
			t.Fatalf("SendTo: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the Send with a target did not return")
	}

	// The message is on the new branch, and nothing of the archived chat runs.
	v := e.view(id)
	fa := e.claude.lastFork(t)
	if !v.Archived || v.Branch == "" || v.Status != model.StatusReady || e.m.Busy(id) {
		t.Fatalf("view %+v", v)
	}
	if !fa.isClosed() || !mainAg.isClosed() {
		t.Fatalf("the archived chat's processes: the branch's closed %v, main's closed %v", fa.isClosed(), mainAg.isClosed())
	}
	items := e.items(id)
	if len(items) != 5 || items[3].Text != "aside" || items[4].Kind != "note" || items[4].Text != "Stopped." {
		t.Fatalf("the branch's items %+v", items)
	}
	if bm := e.meta(branchChatID(id, v.Branch)); bm.TurnActive {
		t.Fatalf("the branch's chat.json %+v", bm)
	}
	if err := e.m.Send(id, "more", "", nil); !errors.Is(err, ErrArchived) {
		t.Fatalf("Send to the archived chat: %v", err)
	}
}

// A branch that is carried on while it keeps its fork source is started through the fork
// capability. No lock of the chat is held during that start: another Send is answered at once.
// One to the starting branch finds it busy; one to another branch is accepted.
func TestSendToCarryOnStartIsNotOneStep(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 3)
	b, _, _ := e.branchTo(id, newAt(3), "aside")
	e.m.Stop(id) // in the branch's first turn
	_, _, items, _, err := e.m.ItemsOf(id, b)
	if err != nil {
		t.Fatal(err)
	}

	blk, res := e.block(e.claude, func() error {
		return e.m.SendTo(id, Target{Branch: b, At: len(items)}, "carry on", "", nil)
	})
	for _, tc := range []struct {
		what string
		send func() error
		want error
	}{
		// The starting branch is the current one already: it was when it was stopped.
		{"a plain Send", func() error { return e.m.Send(id, "two", "", nil) }, ErrBusy},
		{"a Send to the end of the starting branch", func() error { return e.sendToErr(id, Target{Branch: b, End: true}) }, ErrBusy},
		{"a Send to the end of another branch", func() error { return e.m.SendTo(id, mainAt(9), "on main", "", nil) }, nil},
	} {
		done := make(chan error, 1)
		go func() { done <- tc.send() }()
		select {
		case err := <-done:
			if !errors.Is(err, tc.want) {
				t.Fatalf("%s during the start: %v, want %v", tc.what, err, tc.want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s waited for the start", tc.what)
		}
	}
	// Main took its message and became the current branch while the other was starting.
	mainAg := e.claude.last(t)
	if sent := mainAg.sent(); e.cur(id) != model.MainBranch || len(sent) != 1 || !reflect.DeepEqual(texts(sent[0]), []string{"on main"}) {
		t.Fatalf("current %q, main's process got %v", e.cur(id), sent)
	}
	if err := blk.release(res, nil); err != nil {
		t.Fatalf("SendTo: %v", err)
	}
	// The branch's message got onto it last: it is the current one, and main works on.
	fa := e.claude.lastFork(t)
	if sent := fa.sent(); e.cur(id) != b || len(sent) != 1 || !reflect.DeepEqual(texts(sent[0]), []string{"carry on"}) {
		t.Fatalf("current %q, the branch's process got %v", e.cur(id), sent)
	}
	if rec, _ := e.treeFile(id); rec.Current != b || mainAg.isClosed() || e.view(id).Working != 2 {
		t.Fatalf("the record's current branch %q, main's process closed %v, %d working", rec.Current, mainAg.isClosed(), e.view(id).Working)
	}
}

// ---- the branch left ------------------------------------------------------

// A Send that makes another branch the current one stops nothing: the branch left keeps its
// process, its thread and its token, and takes its next message in that process.
func TestSendToStopsNoBranch(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, mainAg := e.talked(model.Claude, "", 3)
	b1, id1, a1 := e.branchTo(id, newAt(3), "one")
	a1.emit(t, reply("q1")...)
	if err := e.setDraft(id, model.Draft{Text: "typed"}); err != nil {
		t.Fatal(err)
	}
	main, mainItems := e.meta(id), e.file(id, "items.jsonl")
	items1, m1 := e.file(id1, "items.jsonl"), e.meta(id1)

	b2, id2, a2 := e.branchTo(id, newAt(6), "two")
	if a1.isClosed() || a2.isClosed() || mainAg.isClosed() || a1.interrupted() != 0 {
		t.Fatal("the new branch stopped a process")
	}
	rec, _ := e.treeFile(id)
	want := []model.TreeBranch{{ID: b1, From: model.MainBranch, At: 3}, {ID: b2, From: model.MainBranch, At: 6}}
	if !reflect.DeepEqual(rec.Branches, want) || rec.Current != b2 {
		t.Fatalf("tree record %+v", rec)
	}
	if v := e.view(id); v.Branches != 3 || v.Branch != b2 || v.Draft != nil || !v.HasDraft {
		t.Fatalf("view %+v", v)
	}
	// Main was not touched: its chat.json still has the draft of the branch left, which was typed
	// while that branch was current. The branch left keeps its thread and token.
	if !bytes.Equal(e.file(id, "items.jsonl"), mainItems) {
		t.Fatal("main's items.jsonl changed")
	}
	if d := main.Drafts[b1]; len(main.Drafts) != 1 || d == nil || d.Text != "typed" {
		t.Fatalf("the drafts before the Send %+v", main.Drafts)
	}
	if after := e.meta(id); !reflect.DeepEqual(after, main) {
		t.Fatalf("main's chat.json %+v, want %+v", after, main)
	}
	if !bytes.Equal(e.file(id1, "items.jsonl"), items1) {
		t.Fatal("the items.jsonl of the branch left changed")
	}
	if after := e.meta(id1); after.Token != m1.Token || after.SessionID != m1.SessionID || after.TurnActive {
		t.Fatalf("the chat.json of the branch left %+v", after)
	}
	for tok, sid := range map[string]string{main.Token: id, m1.Token: id1, e.meta(id2).Token: id2} {
		if c, ok := e.m.ResolveToken(tok); !ok || c.Chat != id || c.Meta.ID != sid {
			t.Fatalf("the token of %s: %+v, %v", sid, c, ok)
		}
	}

	// Going to the end of the first branch: its message goes to the process it kept, and the
	// second branch, in its turn, is not stopped either.
	spawns := e.claude.count()
	e.sendTo(id, Target{Branch: b1, At: 6}, "one again")
	if a2.isClosed() || a2.interrupted() != 0 || e.cur(id) != b1 || e.claude.count() != spawns || len(e.claude.forkCalls()) != 2 {
		t.Fatalf("current %q, %d spawns, %d fork starts, the branch left closed %v", e.cur(id), e.claude.count(), len(e.claude.forkCalls()), a2.isClosed())
	}
	if sent := a1.sent(); len(sent) != 2 || !reflect.DeepEqual(texts(sent[1]), []string{"one again"}) || a1.isClosed() || mainAg.isClosed() {
		t.Fatalf("the process of the first branch got %v", sent)
	}
	if !e.m.BusyOf(id, b1) || !e.m.BusyOf(id, b2) || e.view(id).Working != 2 {
		t.Fatalf("the two branches do not both work: view %+v", e.view(id))
	}
	a2.emit(t, reply("r1")...)
	if !bytes.Equal(e.file(id, "items.jsonl"), mainItems) || len(e.diskItems(id2)) != 9 {
		t.Fatal("another branch than the one left changed")
	}
	if rec, _ := e.treeFile(id); len(rec.Branches) != 2 || rec.Current != b1 {
		t.Fatalf("tree record %+v", rec)
	}
}

// ---- the fork source ------------------------------------------------------

// A18: a Claude branch whose first turn was cut is made again from its source.
func TestSendToClaudeRelaunch(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 3)
	main := e.meta(id)
	b, bid, fa := e.branchTo(id, newAt(3), "aside")
	want := &model.ForkSource{Chat: id, Session: main.SessionID, Point: "p1", Next: "p2", Items: 3}
	sid := e.meta(bid).SessionID

	// The source is kept until the first turn end after the Send.
	fa.emit(t, agent.Event{Kind: agent.EvText, Text: "half"})
	if got := e.meta(bid).ForkSource; !reflect.DeepEqual(got, want) {
		t.Fatalf("forkSource during the first turn %+v, want %+v", got, want)
	}

	// The app is closed during the first turn: the next Send makes the fork again, with no
	// chat lock held.
	e.m.Shutdown()
	e.boot()
	if e.cur(id) != b {
		t.Fatalf("current branch after a restart %q", e.cur(id))
	}
	e.claude.set(func(s *fakeSpawner) {
		s.onFork = func(o agent.SpawnOptions) {
			if c, ok := e.m.ResolveToken(o.MCP.Token); !ok || c.Chat != id || c.Meta.ID != bid {
				t.Errorf("the token during the relaunch resolves to %+v, %v", c, ok)
			}
			if st := e.view(id).Status; st != model.StatusThinking {
				t.Errorf("status during the relaunch %q", st)
			}
		}
	})
	e.send(id, "carry on", "")
	e.claude.set(func(s *fakeSpawner) { s.onFork = nil })
	calls := e.claude.forkCalls()
	if len(calls) != 1 || e.claude.count() != 0 {
		t.Fatalf("%d fork starts, %d spawns", len(calls), e.claude.count())
	}
	if want := (agent.ForkSource{ChatID: id, Dir: e.st.P.ChatDir(id), SessionID: main.SessionID, Point: "p1", Next: "p2"}); calls[0].src != want {
		t.Fatalf("relaunch source %+v, want %+v", calls[0].src, want)
	}
	if o := calls[0].opts; o.SessionID != sid || o.ChatID != bid || !o.Resume {
		t.Fatalf("relaunch options %+v", o)
	}
	fb := e.claude.lastFork(t)
	if sent := fb.sent(); len(sent) != 1 || !reflect.DeepEqual(texts(sent[0]), []string{"carry on"}) {
		t.Fatalf("the process got %v", sent)
	}
	if got := e.meta(bid).ForkSource; !reflect.DeepEqual(got, want) {
		t.Fatalf("forkSource before the first turn end %+v", got)
	}
	fb.emit(t, reply("q1")...)
	if m := e.meta(bid); m.ForkSource != nil || m.SessionID != sid {
		t.Fatalf("chat.json after the first turn end %+v", m)
	}

	// From now on the branch has a session of its own: a resume, and a branch off it forks it.
	fb.exit(t)
	e.send(id, "again", "")
	a := e.claude.last(t)
	if o := a.opts; len(e.claude.forkCalls()) != 1 || e.claude.count() != 1 || !o.Resume || o.SessionID != sid {
		t.Fatalf("%d fork starts, resume options %+v", len(e.claude.forkCalls()), o)
	}
	a.emit(t, reply("q2")...)
	e.sendTo(id, Target{Branch: b, At: 3, New: true}, "elsewhere")
	if got := e.claude.forkCalls()[1].src; got.ChatID != bid || got.SessionID != sid || got.Point != "p1" || got.End {
		t.Fatalf("fork of the branch %+v", got)
	}
}

// ---- quotes ---------------------------------------------------------------

func TestSendToReferences(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, mainAg := e.talked(model.Claude, "", 2)
	ref := func(i int) []model.Reference { return []model.Reference{{Item: i, Quote: "reply"}} }

	// A quote of what the new branch lacks, or of what is no message or reply, creates nothing.
	for _, refs := range [][]model.Reference{ref(3), ref(4), ref(2), ref(-1), {{Item: 1, Quote: " "}}, append(ref(1), ref(5)...)} {
		if err := e.m.SendTo(id, newAt(3), "aside", "", refs); !errors.Is(err, ErrBadReference) {
			t.Fatalf("SendTo with the quotes %+v: %v", refs, err)
		}
	}
	e.unsplit(id)
	if len(e.claude.forkCalls()) != 0 || mainAg.isClosed() || len(e.items(id)) != 6 {
		t.Fatal("a refused quote left something")
	}

	// Quotes of the prefix are kept on the user item, and the agent gets them.
	refs := []model.Reference{{Item: 1, Quote: "reply 1", Comment: "why?", Start: 0, End: 7}, {Item: 0, Quote: "ask"}}
	if err := e.m.SendTo(id, newAt(3), "aside", "", refs); err != nil {
		t.Fatal(err)
	}
	b := e.cur(id)
	bid := branchChatID(id, b)
	if got := e.diskItems(bid); len(got) != 4 || !reflect.DeepEqual(got[3].References, refs) {
		t.Fatalf("the branch's items %+v", got)
	}
	fa := e.claude.lastFork(t)
	if sent := fa.sent(); len(sent) != 1 || !strings.Contains(sent[0][0].Text, "<quote>reply 1</quote>") || !strings.HasSuffix(sent[0][0].Text, "aside") {
		t.Fatalf("the process got %v", sent)
	}
	fa.emit(t, reply("q1")...)

	// Carrying another branch on: the quotes are checked against that branch's thread, before
	// anything changes.
	for _, refs := range [][]model.Reference{ref(6), ref(5)} {
		if err := e.m.SendTo(id, mainAt(6), "back", "", refs); !errors.Is(err, ErrBadReference) {
			t.Fatalf("carrying main on with the quotes %+v: %v", refs, err)
		}
	}
	if e.cur(id) != b || fa.isClosed() || len(e.items(id)) != 6 {
		t.Fatal("a refused quote changed the current branch")
	}
	if err := e.m.SendTo(id, mainAt(6), "back", "", ref(4)); err != nil {
		t.Fatal(err)
	}
	if got := e.items(id); e.cur(id) != model.MainBranch || len(got) != 7 || !reflect.DeepEqual(got[6].References, ref(4)) {
		t.Fatalf("main's items %+v", got)
	}
}

// ---- no branch ------------------------------------------------------------

// A message to the end of the current branch is a Send, on split and unsplit chats alike.
func TestSendToTheCurrentEndIsSend(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, a := e.talked(model.Claude, "", 2)
	if err := e.setDraft(id, model.Draft{Text: "typed"}); err != nil {
		t.Fatal(err)
	}
	evs := e.listen()
	e.sendTo(id, mainAt(6), "more")
	e.unsplit(id)
	if sent := a.sent(); len(sent) != 3 || a.isClosed() || e.claude.count() != 1 || len(e.claude.forkCalls()) != 0 {
		t.Fatalf("the process got %d messages, %d spawns", len(sent), e.claude.count())
	}
	if got := e.items(id); len(got) != 7 || got[6].Text != "more" || e.meta(id).Drafts != nil {
		t.Fatalf("items %+v", got)
	}
	got := evs.drain(t, e.br)
	if !reflect.DeepEqual(typesOf(got), []string{"chat_items", "branch_state", "chat", "tree"}) {
		t.Fatalf("events %+v", got)
	}
	if st := stateIn(t, got[1]); st.Chat != id || st.Branch != model.MainBranch || st.Status != model.StatusThinking || st.Draft != nil {
		t.Fatalf("state record %+v", st)
	}
	if p := treeIn(t, got[3]).branchPart(t, model.MainBranch); p.Len != 7 || p.Items[len(p.Items)-1].Text != "more" {
		t.Fatalf("main's part of the tree %+v", p)
	}
	if c := chatOf(t, ofType(got, "chat")[0]); c["branch"] != nil || c["branches"] != nil {
		t.Fatalf("chat event of an unsplit chat %v", c)
	}
	a.emit(t, reply("p3")...)

	// A split chat: the current branch's end, named or not.
	b, bid, fa := e.branchTo(id, newAt(3), "aside")
	fa.emit(t, reply("q1")...)
	record := e.file(id, "tree.json")
	e.sendTo(id, Target{Branch: b, At: 6}, "on the branch")
	if sent := fa.sent(); len(sent) != 2 || fa.isClosed() || len(e.claude.forkCalls()) != 1 || !bytes.Equal(e.file(id, "tree.json"), record) {
		t.Fatalf("the branch's process got %d messages", len(sent))
	}
	fa.emit(t, reply("q2")...)
	e.send(id, "and without a target", "")
	if got := e.diskItems(bid); len(fa.sent()) != 3 || len(got) != 10 || got[9].Text != "and without a target" || !bytes.Equal(e.file(id, "tree.json"), record) {
		t.Fatalf("the branch's items %+v", got)
	}

	// Notes after the last mark are no reason for a branch: nothing was said past the point.
	e = newEnv(t)
	id = e.stored(model.Claude, []model.Item{pUser(), pText(), pEnd("p1"), pNote()})
	e.sendTo(id, mainAt(3), "after the note")
	e.unsplit(id)
	if got := e.items(id); len(got) != 5 || got[4].Text != "after the note" || len(e.claude.forkCalls()) != 0 {
		t.Fatalf("items %+v", got)
	}
}

// A Send to the end of a branch (Target.End) carries the branch on whatever length the client
// last saw of it: no point that the branch has grown past makes a new branch.
func TestSendToTheEndOfABranch(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, mainAg := e.talked(model.Claude, "", 2)
	b, bid, fa := e.branchTo(id, newAt(3), "aside")
	fa.emit(t, reply("q1")...)

	// The length is stale: main has six items, and without End a message at three starts a
	// new branch there. New is ignored as At is.
	e.sendTo(id, Target{Branch: model.MainBranch, At: 3, New: true, End: true}, "back on main")
	rec, _ := e.treeFile(id)
	if len(rec.Branches) != 1 || rec.Current != model.MainBranch || e.cur(id) != model.MainBranch {
		t.Fatalf("tree record %+v, current %q", rec, e.cur(id))
	}
	// Main kept its process when the branch was made: the message goes to it.
	if sent := mainAg.sent(); len(sent) != 3 || e.claude.count() != 1 || len(e.claude.forkCalls()) != 1 {
		t.Fatalf("main's process got %d messages, %d spawns, %d fork starts", len(sent), e.claude.count(), len(e.claude.forkCalls()))
	}
	if got := e.diskItems(id); len(got) != 7 || got[6].Text != "back on main" {
		t.Fatalf("main's items %+v", got)
	}
	if fa.isClosed() {
		t.Fatal("the branch left was stopped") // as with a point at the end
	}

	// The busy rule is that of a point at the end: the branch works, and takes no message.
	if err := e.sendToErr(id, Target{Branch: model.MainBranch, End: true}); !errors.Is(err, ErrBusy) {
		t.Fatalf("SendTo the end of main while main works: %v", err)
	}
	if e.cur(id) != model.MainBranch || mainAg.isClosed() {
		t.Fatal("a refused Send moved the chat")
	}

	// It is that branch's alone: the other one's end takes a message while main works. A point
	// past the end is no error either.
	e.sendTo(id, Target{Branch: b, At: 99, End: true}, "more aside")
	ba := fa
	if rec, _ := e.treeFile(id); len(rec.Branches) != 1 || rec.Current != b || e.cur(id) != b || len(ba.sent()) != 2 || mainAg.isClosed() || e.claude.count() != 1 {
		t.Fatalf("tree record %+v, the branch's process got %d messages", rec, len(ba.sent()))
	}
	if !e.m.BusyOf(id, model.MainBranch) || !e.m.BusyOf(id, b) {
		t.Fatal("the two branches do not both work")
	}
	mainAg.emit(t, reply("p3")...)
	ba.emit(t, reply("q2")...)

	// On the current branch it is a plain Send: the same process, and nothing moves.
	spawns := e.claude.count()
	evs := e.listen()
	e.sendTo(id, Target{Branch: b, At: 1, End: true}, "and more")
	if got := e.diskItems(bid); len(got) != 10 || got[9].Text != "and more" {
		t.Fatalf("the branch's items %+v", got)
	}
	if rec, _ := e.treeFile(id); len(rec.Branches) != 1 || rec.Current != b || e.claude.count() != spawns || ba.isClosed() || len(ba.sent()) != 3 {
		t.Fatalf("tree record %+v, %d spawns (were %d), %d messages to the process", rec, e.claude.count(), spawns, len(ba.sent()))
	}
	for _, ev := range ofType(evs.drain(t, e.br), "chat") {
		if c := chatOf(t, ev); c["branch"] != b {
			t.Fatalf("a chat event of another branch %v", c)
		}
	}
}

// ---- the model and effort of a new branch ---------------------------------

func TestSendToNewBranchTakesTheChoice(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, mainAg := e.talked(model.Claude, "", 2)
	e.usedTurn(id, mainAg, 100) // the source's window is known: 1000
	src, srcState := e.meta(id), e.stateOfBranch(id, model.MainBranch)
	if src.Model != "sonnet" || src.Effort != "high" || src.Usage.CtxWindow != 1000 {
		t.Fatalf("the source %+v", src)
	}
	cases := []struct {
		name          string
		at            int
		model, effort string
		want          model.ModelChoice
		window        int
	}{
		{"a model without efforts", 3, "haiku", "", model.ModelChoice{Model: "haiku"}, 200_000},
		{"a model that offers the effort", 6, "opus", "", model.ModelChoice{Model: "opus", Effort: "high"}, 1_000_000},
		{"an effort alone", 3, "", "low", model.ModelChoice{Model: "sonnet", Effort: "low"}, 1000},
		{"a model and an effort", 3, "opus", "max", model.ModelChoice{Model: "opus", Effort: "max"}, 1_000_000},
		{"at the start", 0, "haiku", "", model.ModelChoice{Model: "haiku"}, 200_000},
		{"none", 3, "", "", model.ModelChoice{Model: "sonnet", Effort: "high"}, 1000},
		{"the source's own", 3, "sonnet", "high", model.ModelChoice{Model: "sonnet", Effort: "high"}, 1000},
	}
	for _, tc := range cases {
		b, bid, a := e.branchTo(id, Target{Branch: model.MainBranch, At: tc.at, New: true, Model: tc.model, Effort: tc.effort}, "aside")
		// The branch's own record, the state record clients get, and what its process was started with.
		m := e.meta(bid)
		if got := (model.ModelChoice{Model: m.Model, Effort: m.Effort}); got != tc.want || !m.Locked || m.Fresh || m.SourceCtx != 0 {
			t.Fatalf("%s: the branch's chat.json %+v", tc.name, m)
		}
		if m.Usage.CtxWindow != tc.window {
			t.Fatalf("%s: the branch's context window %d, want %d", tc.name, m.Usage.CtxWindow, tc.window)
		}
		if st := e.stateOfBranch(id, b); st.Model != tc.want.Model || st.Effort != tc.want.Effort || !st.Locked || st.Fresh {
			t.Fatalf("%s: the branch's state record %+v", tc.name, st)
		}
		if a.opts.ChatID != bid || a.opts.Model != tc.want.Model || a.opts.Effort != tc.want.Effort {
			t.Fatalf("%s: the branch's process was started with %+v", tc.name, a.opts)
		}
		if v := e.view(id); v.Branch != b || v.Model != tc.want.Model || v.Effort != tc.want.Effort {
			t.Fatalf("%s: the chat's view %+v", tc.name, v)
		}
		// The source keeps its own.
		if got := e.meta(id); got.Model != src.Model || got.Effort != src.Effort || got.Usage != src.Usage {
			t.Fatalf("%s: the source's chat.json %+v", tc.name, got)
		}
		if st := e.stateOfBranch(id, model.MainBranch); st != srcState {
			t.Fatalf("%s: the source's state record %+v, was %+v", tc.name, st, srcState)
		}
		a.emit(t, reply("q")...)
		// From its first message the branch is locked: carried on, it takes no choice.
		if err := e.sendToErr(id, Target{Branch: b, End: true, Model: "opus"}); !errors.Is(err, ErrLocked) {
			t.Fatalf("%s: a choice on the branch carried on: %v", tc.name, err)
		}
		if err := e.m.ConfigureOf(id, b, ConfigReq{Model: "opus"}); !errors.Is(err, ErrLocked) {
			t.Fatalf("%s: Configure on the branch: %v", tc.name, err)
		}
	}
	// A branch of a branch starts from that branch's choice, not main's.
	e.sendTo(id, newAt(3), "first") // on sonnet
	e.spawner(model.Claude).lastFork(t).emit(t, reply("r1")...)
	b1, bid1, a1 := e.branchTo(id, Target{Branch: model.MainBranch, At: 3, New: true, Model: "haiku"}, "on haiku")
	a1.emit(t, reply("r2")...)
	_, bid2, a2 := e.branchTo(id, Target{Branch: b1, At: 3, New: true}, "below it")
	if m := e.meta(bid2); m.Model != "haiku" || m.Effort != "" || a2.opts.Model != "haiku" {
		t.Fatalf("a branch of the haiku branch %s: %+v, started with %+v", bid1, m, a2.opts)
	}
}

func TestSendToChoiceRefusals(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, mainAg := e.talked(model.Claude, "", 2)
	objects := len(e.m.all())
	with := func(tg Target, m, ef string) Target { tg.Model, tg.Effort = m, ef; return tg }
	end := Target{Branch: model.MainBranch, End: true}
	untouched := func(when string) {
		t.Helper()
		e.unsplit(id)
		if n := len(e.claude.forkCalls()); n != 0 || e.claude.count() != 1 || len(e.m.all()) != objects {
			t.Fatalf("%s: %d fork starts, %d spawns, %d chat objects (were %d)", when, n, e.claude.count(), len(e.m.all()), objects)
		}
		if len(e.items(id)) != 6 || len(mainAg.sent()) != 2 {
			t.Fatalf("%s: %d items, %d messages sent", when, len(e.items(id)), len(mainAg.sent()))
		}
	}

	for _, tc := range []struct {
		name string
		t    Target
		want string
	}{
		{"an unknown model", with(newAt(3), "nope", ""), `unknown model "nope"`},
		{"an unknown model at the start", with(newAt(0), "nope", ""), `unknown model "nope"`},
		{"an effort the source's model lacks", with(newAt(3), "", "bogus"), `sonnet has no effort "bogus"`},
		{"an effort the chosen model lacks", with(newAt(3), "haiku", "high"), `haiku has no effort "high"`},
	} {
		if err := e.sendToErr(id, tc.t); err == nil || err.Error() != tc.want {
			t.Fatalf("%s: %v", tc.name, err)
		}
		untouched(tc.name)
	}
	// The point and the quotes are checked first.
	if err := e.sendToErr(id, with(newAt(4), "nope", "")); !errors.Is(err, ErrBadPoint) {
		t.Fatalf("a bad point with an unknown model: %v", err)
	}
	if err := e.m.SendTo(id, with(newAt(3), "nope", ""), "x", "", []model.Reference{{Item: 4, Quote: "reply"}}); !errors.Is(err, ErrBadReference) {
		t.Fatalf("a bad quote with an unknown model: %v", err)
	}
	untouched("a bad point and a bad quote")

	// A target that carries the branch on takes no choice, also the branch's own, also an
	// unknown one; a busy branch says the same.
	for _, tg := range []Target{with(end, "opus", ""), with(end, "", "low"), with(end, "sonnet", "high"),
		with(end, "nope", ""), with(mainAt(6), "opus", ""), with(mainAt(6), "sonnet", "high")} {
		if err := e.sendToErr(id, tg); !errors.Is(err, ErrLocked) {
			t.Fatalf("a choice on %+v: %v", tg, err)
		}
		untouched("a choice on a branch carried on")
	}
	e.send(id, "go", "")
	if err := e.sendToErr(id, with(end, "opus", "")); !errors.Is(err, ErrLocked) {
		t.Fatalf("a choice on a busy branch carried on: %v", err)
	}
	if err := e.sendToErr(id, end); !errors.Is(err, ErrBusy) {
		t.Fatalf("no choice on a busy branch carried on: %v", err)
	}
	e.unsplit(id)
	if m := e.meta(id); m.Model != "sonnet" || m.Effort != "high" {
		t.Fatalf("the chat's chat.json %+v", m)
	}
}

func TestSendToWindowRefused(t *testing.T) {
	e := newEnv(t)
	id, _ := e.piTalked()
	objects := len(e.m.all())
	small := Target{Branch: model.MainBranch, At: 3, New: true, Model: "small"}
	untouched := func(when string) {
		t.Helper()
		e.unsplit(id)
		if n := len(e.pi.forkCalls()); n != 0 || e.pi.count() != 1 || len(e.m.all()) != objects {
			t.Fatalf("%s: %d fork starts, %d spawns, %d chat objects (were %d)", when, n, e.pi.count(), len(e.m.all()), objects)
		}
	}

	err := e.sendToErr(id, small)
	if !errors.Is(err, ErrWindow) || !strings.Contains(err.Error(), "Small takes 32000 tokens and the conversation holds about 20000") {
		t.Fatalf("a model too small for the conversation: %v", err)
	}
	untouched("the window refusal")

	// Before the cap: the window refusal stays, the cap's passes.
	t.Run("at the cap", func(t *testing.T) {
		lowerCaps(t, 0, 12)
		if err := e.sendToErr(id, small); !errors.Is(err, ErrWindow) {
			t.Fatalf("a model too small, at the cap: %v", err)
		}
		if err := e.sendToErr(id, newAt(3)); !errors.Is(err, ErrChatCap) {
			t.Fatalf("no choice, at the cap: %v", err)
		}
		// The quotes come before it.
		tg := small
		if err := e.m.SendTo(id, tg, "x", "", []model.Reference{{Item: 4, Quote: "reply"}}); !errors.Is(err, ErrBadReference) {
			t.Fatalf("a bad quote with a model too small: %v", err)
		}
	})
	untouched("the refusals at the cap")

	// A model whose window is not known passes, and so does the small one at the start of the
	// chat, where it is given nothing.
	_, bid, a := e.branchTo(id, Target{Branch: model.MainBranch, At: 3, New: true, Model: "unsized"}, "aside")
	if m := e.meta(bid); m.Model != "unsized" || m.Effort != "" || m.Usage.CtxWindow != 0 || a.opts.Model != "unsized" {
		t.Fatalf("the branch on a model without a known window %+v, started with %+v", m, a.opts)
	}
	a.emit(t, reply("q1")...)
	_, bid, a = e.branchTo(id, Target{Branch: model.MainBranch, At: 0, New: true, Model: "small"}, "from the start")
	if m := e.meta(bid); m.Model != "small" || m.Usage.CtxWindow != 32_000 || a.opts.Model != "small" {
		t.Fatalf("the small model at the start %+v, started with %+v", m, a.opts)
	}
	// The source's own model is never refused, whatever its row says.
	a.emit(t, reply("q2")...)
	e.storeCatalog(model.Pi, &model.Catalog{Models: []model.CatalogModel{{ID: "big", Efforts: []string{"low"}, ContextWindow: 20_000}}})
	e.branchTo(id, Target{Branch: model.MainBranch, At: 3, New: true, Model: "big"}, "the same model")
}

func TestSubagentInheritsTheBranchModel(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 2)
	_, bid, a := e.branchTo(id, Target{Branch: model.MainBranch, At: 3, New: true, Model: "haiku"}, "aside")
	a.emit(t, reply("q1")...)

	sa, err := e.m.SpawnSubagent(bid, SpawnSubRequest{Prompt: "count"})
	if err != nil {
		t.Fatal(err)
	}
	if sa.Kind != model.Claude || sa.Model != "haiku" || sa.Effort != "" {
		t.Fatalf("the branch's subagent %+v", sa)
	}
	if o := e.claude.last(t).opts; o.Model != "haiku" || o.Effort != "" {
		t.Fatalf("the branch's subagent was started with %+v", o)
	}
	// Main's still takes main's.
	sa, err = e.m.SpawnSubagent(id, SpawnSubRequest{Prompt: "count"})
	if err != nil {
		t.Fatal(err)
	}
	if sa.Model != "sonnet" || sa.Effort != "high" {
		t.Fatalf("main's subagent %+v", sa)
	}
	if o := e.claude.last(t).opts; o.Model != "sonnet" || o.Effort != "high" {
		t.Fatalf("main's subagent was started with %+v", o)
	}
}
