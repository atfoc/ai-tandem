package chats

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/model"
)

// The ids of the chats an earlier version of the app left in the data folder of the tests.
const (
	sectionPlain   = "0a000000-0000-4000-8000-000000000001" // in a group, with a draft
	sectionFarBd   = "0a000000-0000-4000-8000-000000000002" // on a board that is not here
	sectionFarRun  = "0a000000-0000-4000-8000-000000000003" // on a run that is not here
	sectionOnBoard = "0a000000-0000-4000-8000-000000000004" // on a board of this computer
	sectionOnRun   = "0a000000-0000-4000-8000-000000000005" // on a run of this computer
	sectionOwn     = "0a000000-0000-4000-8000-000000000006" // of this computer
	sectionSecond  = "0a000000-0000-4000-8000-000000000007" // in another group

	sectionEntry  = "s_bbbbbbbbbbbb"
	sectionNoRun  = "r_far00001"
	sectionNoBd   = "b_far00001"
	sectionFarCwd = "/home/bee/work" // a folder that is on no disk of the test's
)

// sectionOldChat writes the chat.json of a chat that never had a message as an earlier version of
// the app kept it: for the server entry when server is set, with the token "tok-"+id. It returns
// the file.
func (e *env) sectionOldChat(meta model.ChatMeta, server bool) string {
	e.t.Helper()
	meta.Token, meta.Created = "tok-"+meta.ID, e.m.now()
	raw, err := json.Marshal(meta)
	if err != nil {
		e.t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		e.t.Fatal(err)
	}
	if server {
		m["server"] = sectionEntry
	}
	if raw, err = json.MarshalIndent(m, "", "  "); err != nil {
		e.t.Fatal(err)
	}
	dir := e.st.P.ChatDir(meta.ID)
	if meta.Run != "" {
		dir = e.st.P.RunChatDir(meta.Run, false, meta.ID)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		e.t.Fatal(err)
	}
	file := filepath.Join(dir, "chat.json")
	if err := os.WriteFile(file, raw, 0o600); err != nil {
		e.t.Fatal(err)
	}
	return file
}

// sectionNoServer fails when the JSON of what names a field of a thing on another server.
func sectionNoServer(t *testing.T, what string, v any) {
	t.Helper()
	raw, ok := v.([]byte)
	if !ok {
		var err error
		if raw, err = json.Marshal(v); err != nil {
			t.Fatal(err)
		}
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("%s: %v", what, err)
	}
	for _, k := range []string{"server", "gone", "unmoved", "moveError", "remoteStart", "draftReplaced"} {
		if _, has := m[k]; has {
			t.Errorf("%s has %q: %s", what, k, raw)
		}
	}
}

// sectionLocal calls LocalOnly with the boards and the runs the env has.
func (e *env) sectionLocal() (local, deleted []string) {
	e.t.Helper()
	local, deleted, err := e.m.LocalOnly(
		func(id string) bool { _, ok := e.bds.Get(id); return ok },
		func(id string) bool { _, ok := e.m.Runs.RunOf(id); return ok })
	if err != nil {
		e.t.Fatalf("LocalOnly: %v", err)
	}
	return local, deleted
}

// The chats an earlier version of the app kept here for another server. One that never had a
// message becomes a chat of this computer: with what a new chat in its place starts with here,
// and with its draft, the draft's counter, its name and its archive mark. One on a board that is
// not a board of this computer, or on a run that is not a run of this computer, is deleted with
// its folder. A chat of this computer is not touched, and a second call finds nothing to do.
func TestSectionChatsOfAnotherServerBecomeLocal(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	dirOne, runCwd := t.TempDir(), t.TempDir()
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{gOne: model.LocalDefaults(model.ServerDefaults{
		Cwd: dirOne, ByAgent: map[model.AgentKind]model.ModelChoice{model.Claude: {Model: "opus", Effort: "low"}},
		Subagents: &model.SubLimits{Depth: 2, Cap: 10}})}})
	bd, err := e.bds.Create("Board", gTwo, false)
	if err != nil {
		t.Fatal(err)
	}
	far := model.ChatMeta{Agent: model.Pi, Cwd: sectionFarCwd, Model: "far-1", Effort: "low", SessionID: "session-of-before",
		Subagents: &model.SubLimits{Depth: 3, Cap: 50}}
	with := func(id string, change func(m *model.ChatMeta)) model.ChatMeta {
		m := far
		m.ID = id
		change(&m)
		return m
	}
	plainFile := e.sectionOldChat(with(sectionPlain, func(m *model.ChatMeta) {
		m.Group, m.Name, m.UserNamed, m.Archive = gOne, "Typed for Bee", true, model.Archive{Archived: true, Op: "a_1"}
		m.Drafts = map[string]*model.Draft{model.MainBranch: {Text: "not sent yet"}}
		m.DraftRevs = map[string]int64{model.MainBranch: 3}
	}), true)
	e.sectionOldChat(with(sectionFarBd, func(m *model.ChatMeta) { m.Board = sectionNoBd }), true)
	e.sectionOldChat(with(sectionFarRun, func(m *model.ChatMeta) { m.Run = sectionNoRun }), true)
	e.sectionOldChat(with(sectionOnBoard, func(m *model.ChatMeta) { m.Board = bd.ID }), true)
	e.sectionOldChat(with(sectionOnRun, func(m *model.ChatMeta) { m.Run = ownRun }), true)
	e.sectionOldChat(with(sectionSecond, func(m *model.ChatMeta) { m.Group = gTwo }), true)
	ownFile := e.sectionOldChat(with(sectionOwn, func(m *model.ChatMeta) {
		m.Group, m.Agent, m.Cwd, m.Model, m.Effort = gOne, model.Claude, e.cwd, "haiku", ""
		m.Drafts = map[string]*model.Draft{model.MainBranch: {Text: "of this computer"}}
	}), false)
	ownBefore, err := os.ReadFile(ownFile)
	if err != nil {
		t.Fatal(err)
	}

	e.boot()
	runs := &fakeRuns{runs: map[string]RunInfo{ownRun: {Group: gTwo, Cwd: runCwd, Agent: model.Claude, Model: "opus", Effort: "high"}}}
	e.m.Runs = runs
	ev := listen(t, e.br)
	ev.drain(t, e.br)
	local, deleted := e.sectionLocal()
	wantLocal := []string{sectionPlain, sectionOnBoard, sectionOnRun, sectionSecond}
	wantDeleted := []string{sectionFarBd, sectionFarRun}
	if !reflect.DeepEqual(local, wantLocal) || !reflect.DeepEqual(deleted, wantDeleted) {
		t.Fatalf("LocalOnly: put here %v, deleted %v; want %v and %v", local, deleted, wantLocal, wantDeleted)
	}
	evs := ev.drain(t, e.br)

	// The chat in a group: that group's choices on this computer, and what it had of its own.
	v := e.view(sectionPlain)
	if v.Agent != model.Claude || v.Cwd != dirOne || v.Model != "opus" || v.Effort != "low" || v.SubLimits() != (model.SubLimits{Depth: 2, Cap: 10}) ||
		v.Locked || v.Status != model.StatusReady {
		t.Fatalf("the chat put on this computer: %+v", v)
	}
	if v.Group != gOne || v.Name != "Typed for Bee" || !v.UserNamed || !v.Archived || v.Op != "a_1" ||
		v.Draft == nil || v.Draft.Text != "not sent yet" || v.DraftRev != 3 || !v.HasDraft {
		t.Fatalf("what the chat keeps: %+v", v)
	}
	if m := e.meta(sectionPlain); m.Token != "tok-"+sectionPlain || m.SessionID == "" || m.SessionID == "session-of-before" {
		t.Fatalf("chat.json of the chat put on this computer: %+v", m)
	}
	// On a board and on a run of this computer: there, with what that place gives.
	onBoard := e.view(sectionOnBoard)
	if onBoard.Board != bd.ID || onBoard.Agent != model.Claude || onBoard.Cwd != e.cwd || onBoard.Model != "sonnet" || onBoard.Effort != "high" {
		t.Fatalf("the chat on a board of this computer: %+v", onBoard)
	}
	onRun := e.view(sectionOnRun)
	if onRun.Run != ownRun || onRun.Agent != model.Claude || onRun.Cwd != runCwd {
		t.Fatalf("the chat on a run of this computer: %+v", onRun)
	}
	for _, id := range wantLocal {
		view := e.view(id)
		sectionNoServer(t, "the view of "+id, view)
		raw, err := os.ReadFile(filepath.Join(e.m.chatDir(id), "chat.json"))
		if err != nil {
			t.Fatal(err)
		}
		sectionNoServer(t, "chat.json of "+id, raw)
	}
	for _, st := range e.m.States() {
		sectionNoServer(t, "the state of "+st.Chat, st)
	}
	sent := map[string]bool{}
	for _, got := range ofType(evs, "chat") {
		c := got["chat"].(map[string]any)
		if c["server"] != nil || c["unmoved"] != nil || c["moveError"] != nil {
			t.Fatalf("a chat sent by the change-over: %v", c)
		}
		sent[c["id"].(string)] = true
	}
	for _, id := range wantLocal {
		if !sent[id] {
			t.Errorf("no chat event of %s", id)
		}
	}

	// On a board and on a run that are not here: gone, with the folder, and of the run nothing
	// is left.
	for _, id := range wantDeleted {
		if _, err := e.m.View(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("the view of %s, which had nowhere to be: %v", id, err)
		}
		if _, ok := e.m.ByToken("tok-" + id); ok {
			t.Errorf("the token of %s still resolves", id)
		}
	}
	if _, err := os.Stat(e.st.P.ChatDir(sectionFarBd)); !os.IsNotExist(err) {
		t.Errorf("the folder of the chat on a board that is not here: %v", err)
	}
	if _, err := os.Stat(e.st.P.RunDir(sectionNoRun)); !os.IsNotExist(err) {
		t.Errorf("the folder of the run that is not here: %v", err)
	}
	if removed := ofType(evs, "chat_removed"); len(removed) != 2 {
		t.Errorf("%d chat_removed events for two chats deleted", len(removed))
	}

	// A chat of this computer is as it was, byte for byte.
	if got, _ := os.ReadFile(ownFile); string(got) != string(ownBefore) {
		t.Fatalf("chat.json of a chat of this computer: %s\nwas: %s", got, ownBefore)
	}

	// Again, and after a restart: nothing to do, and nothing is written or sent.
	before, err := os.Stat(plainFile)
	if err != nil {
		t.Fatal(err)
	}
	for _, again := range []string{"at once", "after a restart"} {
		if again == "after a restart" {
			e.boot()
			e.m.Runs = runs
			ev = listen(t, e.br)
		}
		ev.drain(t, e.br)
		if local, deleted := e.sectionLocal(); len(local)+len(deleted) != 0 {
			t.Fatalf("LocalOnly again, %s: %v, %v", again, local, deleted)
		}
		if after, err := os.Stat(plainFile); err != nil || !after.ModTime().Equal(before.ModTime()) {
			t.Fatalf("chat.json was written again, %s: %v", again, err)
		}
		if evs := ev.drain(t, e.br); len(ofType(evs, "chat"))+len(ofType(evs, "chat_removed")) != 0 {
			t.Fatalf("a call with nothing to do sent %v, %s", evs, again)
		}
	}
	if v := e.view(sectionPlain); v.Draft == nil || v.Draft.Text != "not sent yet" || v.DraftRev != 3 || v.Cwd != dirOne {
		t.Fatalf("the chat after a restart: %+v", v)
	}

	// It is a chat of this computer in every way: its draft is saved on its counter, and its
	// first message starts an agent here.
	if rev, _, err := e.m.SetDraft(sectionPlain, 3, model.Draft{Text: "typed on"}); err != nil || rev != 4 {
		t.Fatalf("a save of the draft that came along: %d, %v", rev, err)
	}
	e.send(sectionSecond, "hi", "")
	if e.claude.count() != 1 {
		t.Fatalf("%d Claude processes after the first message of the chat put here", e.claude.count())
	}
}

// With nothing told of the boards and the runs, none is here: a chat kept for another server on
// a board or on a run is deleted, and one in a group is put here all the same.
func TestSectionChatsWithNoBoardsAndRuns(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	bd, err := e.bds.Create("Board", gTwo, false)
	if err != nil {
		t.Fatal(err)
	}
	e.sectionOldChat(model.ChatMeta{ID: sectionPlain, Group: gOne, Agent: model.Pi, Cwd: sectionFarCwd}, true)
	e.sectionOldChat(model.ChatMeta{ID: sectionOnBoard, Board: bd.ID, Agent: model.Pi, Cwd: sectionFarCwd}, true)
	e.sectionOldChat(model.ChatMeta{ID: sectionOnRun, Run: ownRun, Agent: model.Pi, Cwd: sectionFarCwd}, true)
	e.boot()
	local, deleted, err := e.m.LocalOnly(nil, nil)
	if err != nil || !reflect.DeepEqual(local, []string{sectionPlain}) || !reflect.DeepEqual(deleted, []string{sectionOnBoard, sectionOnRun}) {
		t.Fatalf("LocalOnly: put here %v, deleted %v, %v", local, deleted, err)
	}
	if v := e.view(sectionPlain); v.Agent != model.Claude || v.Cwd != e.cwd {
		t.Fatalf("the chat put on this computer: %+v", v)
	}
	if got := e.chatDirs(); !reflect.DeepEqual(got, []string{sectionPlain}) {
		t.Fatalf("the chat folders: %v", got)
	}
}

// A new chat is a chat of this computer, whatever its group's defaults hold: it starts with this
// computer's choices, and neither its view nor its chat.json names a server. A chat on a board is
// on a board of this computer, and no other board is known.
func TestSectionNewChatIsLocal(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	stale := model.ServerDefaults{Agent: model.Pi, Cwd: sectionFarCwd, ByAgent: map[model.AgentKind]model.ModelChoice{model.Pi: {Model: "pi-big"}},
		Subagents: &model.SubLimits{Depth: 3, Cap: 50}}
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{
		gOne:            {Servers: map[string]model.ServerDefaults{"inst-bee": stale}},
		model.Ungrouped: {Servers: map[string]model.ServerDefaults{"inst-bee": stale}},
	}})
	bd, err := e.bds.Create("Board", gOne, false)
	if err != nil {
		t.Fatal(err)
	}
	for what, n := range map[string]NewChat{
		"in a group":           {Group: gOne},
		"on a board":           {Board: bd.ID},
		"in the group of none": {Group: model.Ungrouped},
	} {
		v := e.newChat(n)
		if v.Agent != model.Claude || v.Cwd != e.cwd || v.Model != "sonnet" || v.Effort != "high" || v.SubLimits() != model.DefaultSubLimits() {
			t.Errorf("a new chat %s: %+v", what, v)
		}
		sectionNoServer(t, "the view of a new chat "+what, v)
		raw, err := os.ReadFile(filepath.Join(e.st.P.ChatDir(v.ID), "chat.json"))
		if err != nil {
			t.Fatal(err)
		}
		sectionNoServer(t, "chat.json of a new chat "+what, raw)
	}
	made := len(e.chatDirs())
	if _, err := e.m.CreateChat(NewChat{Board: sectionNoBd}); !errors.Is(err, boards.ErrNotFound) {
		t.Errorf("a chat on a board nobody has: %v, want boards.ErrNotFound", err)
	}
	if _, err := e.m.CreateChat(NewChat{Run: sectionNoRun}); !errors.Is(err, ErrNoRun) {
		t.Errorf("a chat on a run nobody has: %v, want ErrNoRun", err)
	}
	if n := len(e.chatDirs()); n != made {
		t.Fatalf("the refused creations left %d folders", n-made)
	}

	// A first message records what was chosen as the group's own, under "local", and reads
	// nothing of another key.
	v := e.newChat(NewChat{Group: gOne})
	e.send(v.ID, "hi", "")
	if e.claude.count() != 1 {
		t.Fatalf("%d Claude processes after the first message", e.claude.count())
	}
	gd := e.defaultsOf().Groups[gOne]
	if keys := mapKeys(gd.Servers); !reflect.DeepEqual(keys, []string{"inst-bee", model.LocalServer}) || gd.Local().Agent != model.Claude ||
		gd.Local().Cwd != e.cwd || !reflect.DeepEqual(gd.Servers["inst-bee"], stale) {
		t.Fatalf("the defaults after the first message: %+v", gd)
	}
	if w := e.newChat(NewChat{Group: gOne}); w.Agent != model.Claude || w.Cwd != e.cwd {
		t.Fatalf("the next chat of the group: %+v", w)
	}
}

// mapKeys is the keys of m, sorted.
func mapKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// A chat on a run lives in the run's folder. The folder of the run's chats goes with the last
// chat in it; the run's own folder goes too when nothing else is in it, and stays with its
// run.json, as the folder of a run does.
func TestSectionRunFolderGoesWithItsLastChat(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.m.Runs = &fakeRuns{runs: map[string]RunInfo{ownRun: {Group: gOne, Cwd: t.TempDir(), Agent: model.Claude, Model: "opus"}}}
	runDir := e.st.P.RunDir(ownRun)
	there := func() bool {
		t.Helper()
		_, err := os.Stat(runDir)
		if err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		return err == nil
	}
	onRun := func() model.ChatView {
		t.Helper()
		v := e.newChat(NewChat{Run: ownRun})
		if _, err := os.Stat(e.st.P.RunChatDir(ownRun, false, v.ID)); err != nil {
			t.Fatalf("the folder of a chat on the run: %v", err)
		}
		return v
	}

	// The folder stays while another chat is in it, and goes with the last one.
	first, second := onRun(), onRun()
	if err := e.m.Delete(first.ID); err != nil || !there() {
		t.Fatalf("the delete of one of two chats: %v, the run's folder is there: %v", err, there())
	}
	if _, err := os.Stat(e.st.P.RunChatDir(ownRun, false, second.ID)); err != nil {
		t.Fatalf("the folder of the other chat: %v", err)
	}
	if err := e.m.Delete(second.ID); err != nil || there() {
		t.Fatalf("the delete of the last chat: %v, the run's folder is there: %v", err, there())
	}

	// A folder with a run.json in it is a run's own: it stays, and so does the file.
	third, fourth := onRun(), onRun()
	runFile := filepath.Join(runDir, "run.json")
	if err := os.WriteFile(runFile, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, v := range []model.ChatView{third, fourth} {
		if err := e.m.Delete(v.ID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(runFile); err != nil {
		t.Fatalf("the run's file after its chats went: %v", err)
	}
	if _, err := os.Stat(filepath.Join(runDir, "chats")); !os.IsNotExist(err) {
		t.Fatalf("the folder of the run's chats after the last one went: %v", err)
	}
}
