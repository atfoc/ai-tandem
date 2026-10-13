package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
	"ai-whiteboard/internal/store"
)

// The change-over of the data folder at the start of the program (contract 3.9), through
// startServers: what an app of before kept there of another server is gone or is this
// computer's own before a page is served. The steps one by one are the section tests of
// internal/store, internal/defaults, internal/chats and internal/runs.

// changedOver checks the files of a data folder that oldFolder wrote and the program then
// started on: the folder remote/ is gone, the chat that never had a message is a chat with its
// draft that names no server, the one on a board that is not here is deleted, the run names no
// server and has its goal, the group's defaults hold this computer's alone, both groups are
// there, the server list is the bytes list, and no other file names the entry or its server or
// holds what a record held: the draft kept with it, its last view, its archive mark.
func changedOver(t *testing.T, root string, list []byte) {
	t.Helper()
	p := store.NewPaths(root)
	if _, err := os.Lstat(filepath.Join(root, "remote")); !os.IsNotExist(err) {
		t.Errorf("the folder remote/ after the start: %v", err)
	}
	// fields is the JSON object of a file.
	fields := func(path string) map[string]json.RawMessage {
		t.Helper()
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("%s: %v in %s", path, err, raw)
		}
		return m
	}
	chat := fields(filepath.Join(p.ChatDir(oldChat), "chat.json"))
	var drafts map[string]*model.Draft
	if json.Unmarshal(chat["drafts"], &drafts); chat["server"] != nil || drafts[model.MainBranch] == nil || drafts[model.MainBranch].Text != oldDraft {
		t.Errorf("chat.json of the chat that was kept for the entry: server %s, drafts %s", chat["server"], chat["drafts"])
	}
	if _, err := os.Lstat(p.ChatDir(oldBoardChat)); !os.IsNotExist(err) {
		t.Errorf("the folder of the chat on a board that is not here: %v", err)
	}
	run := fields(filepath.Join(p.RunDir(oldRun), "run.json"))
	var goal *model.Draft
	if json.Unmarshal(run["draft"], &goal); run["server"] != nil || run["remoteStart"] != nil || goal == nil || goal.Text != oldGoal {
		t.Errorf("run.json of the run that named the entry: server %s, draft %s", run["server"], run["draft"])
	}
	var state struct {
		Groups   []model.Group
		Defaults struct {
			Groups map[string]map[string]map[string]json.RawMessage
		}
	}
	raw, err := os.ReadFile(p.State)
	if err != nil || json.Unmarshal(raw, &state) != nil {
		t.Fatalf("state.json: %v in %s", err, raw)
	}
	group := state.Defaults.Groups[oldGroup]
	if len(group) != 1 || len(group["servers"]) != 1 || group["servers"][model.LocalServer] == nil {
		t.Errorf("the defaults of the group in state.json: %s, want servers.local alone", raw)
	}
	// The group that held only things of that server stays, for the user to delete.
	if len(state.Groups) != 2 || state.Groups[0].ID != oldGroup || state.Groups[1].ID != oldFarGroup || state.Groups[1].Name != oldFarGroupName {
		t.Errorf("the groups in state.json: %+v, want the two of before", state.Groups)
	}
	files := folderFiles(t, root)
	if !bytes.Equal(files[servers.FileName], list) {
		t.Errorf("the server list was changed:\n%s\nwas:\n%s", files[servers.FileName], list)
	}
	if held := holders(files, []string{savedEntryID, standin.DefaultInstanceID}); len(held) != 0 {
		t.Errorf("files that still name the entry or its server: %v", held)
	}
	if held := holders(files, oldMarks()); len(held) != 0 {
		t.Errorf("files that still hold something of a record: %v", held)
	}
}

// changedOverSnapshot checks a page's snapshot of the program that started on oldFolder, once
// the entry is connected: this computer's lists hold the chat with its draft and the run with
// its goal, as things of this computer, and nothing else; the group that held only things of
// the entry's server is there, with nothing in it; the group's defaults are this computer's
// alone; what the stand-in has is in its section and nowhere else; and the draft that was kept
// with a record is nowhere. agent is the agent a new chat of the group starts with on this
// server: none when it finds no agent's program.
func changedOverSnapshot(t *testing.T, raw string, agent model.AgentKind) {
	t.Helper()
	var snap struct {
		Groups   []model.Group
		Boards   []model.Board
		Chats    []model.ChatView
		States   []model.BranchState
		Runs     []model.RunView
		Defaults model.Defaults
		Sections map[string]remotes.Tree
	}
	var parts map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &snap); err != nil {
		t.Fatalf("the snapshot: %v in %s", err, raw)
	}
	json.Unmarshal([]byte(raw), &parts)
	if len(snap.Chats) != 1 || snap.Chats[0].ID != oldChat || snap.Chats[0].Locked || snap.Chats[0].Group != oldGroup ||
		snap.Chats[0].Draft == nil || snap.Chats[0].Draft.Text != oldDraft || snap.Chats[0].DraftRev != 2 || snap.Chats[0].Agent != agent ||
		len(snap.States) != 1 || snap.States[0].Chat != oldChat {
		t.Errorf("this computer's chats: %s, states %s; want the chat that was kept for the entry alone, with its draft and the agent %q", parts["chats"], parts["states"], agent)
	}
	if len(snap.Runs) != 1 || snap.Runs[0].ID != oldRun || snap.Runs[0].Status != model.RunDraft || snap.Runs[0].Group != oldGroup ||
		snap.Runs[0].Name != "Port the importer" || snap.Runs[0].Draft == nil || snap.Runs[0].Draft.Text != oldGoal || !snap.Runs[0].Started.IsZero() {
		t.Errorf("this computer's runs: %s; want the run that named the entry alone, not started, with its goal", parts["runs"])
	}
	// The place the board and the run of that server had in the second group is lost, and the
	// group stays, empty: the chat and the run of this computer are in the first.
	if len(snap.Boards) != 0 || len(snap.Groups) != 2 || snap.Groups[0].ID != oldGroup || snap.Groups[1].ID != oldFarGroup || snap.Groups[1].Name != oldFarGroupName {
		t.Errorf("this computer's boards %s and groups %s", parts["boards"], parts["groups"])
	}
	for _, mark := range oldMarks() {
		if strings.Contains(raw, mark) {
			t.Errorf("the snapshot holds %s of a record: %s", mark, raw)
		}
	}
	if g := snap.Defaults.Groups[oldGroup]; len(g.Servers) != 1 || g.Local().Agent != model.Claude {
		t.Errorf("the defaults of the group: %s, want this computer's alone", parts["defaults"])
	}
	// The folder a new chat of the group starts in here is the chat's and the run's now.
	if cwd := snap.Defaults.Groups[oldGroup].Local().Cwd; cwd == "" || snap.Chats[0].Cwd != cwd || snap.Runs[0].Cwd != cwd {
		t.Errorf("the chat is in %q and the run in %q, want the group's folder on this computer, %q", snap.Chats[0].Cwd, snap.Runs[0].Cwd, cwd)
	}
	for _, list := range []string{"groups", "boards", "chats", "states", "runs", "defaults"} {
		for _, word := range append(farMarks(), `"server"`, savedEntryID, standin.DefaultInstanceID) {
			if bytes.Contains(parts[list], []byte(word)) {
				t.Errorf("this computer's %s hold %s: %s", list, word, parts[list])
			}
		}
	}
	tree, ok := snap.Sections[savedEntryID]
	if !ok || len(snap.Sections) != 1 || len(tree.Groups) != 1 || tree.Groups[0].ID != farGroup || len(tree.Boards) != 1 || tree.Boards[0].ID != farBoard ||
		len(tree.Chats) != 2 || tree.Chats[0].ID != farChat || tree.Chats[1].ID != farDrafted || tree.Chats[1].Draft == nil || tree.Chats[1].Draft.Text != farDraft ||
		len(tree.States) != 2 || len(tree.Runs) != 1 || tree.Runs[0].ID != farRun {
		t.Errorf("the section of the entry: %s", parts["sections"])
	}
}

// folderTimes is when each file of the data folder was written last, by its path.
func folderTimes(t *testing.T, root string) map[string]time.Time {
	t.Helper()
	out := map[string]time.Time{}
	for _, rel := range filesUnder(t, root) {
		info, err := os.Stat(filepath.Join(root, rel))
		if err != nil {
			t.Fatal(err)
		}
		out[rel] = info.ModTime()
	}
	return out
}

// folderChanges are the files that differ between two readings of a data folder (folderFiles
// and folderTimes): written, by their bytes or their time, new, or gone. Sorted.
func folderChanges(files map[string][]byte, times map[string]time.Time, again map[string][]byte, timesAgain map[string]time.Time) (changed []string) {
	for rel, b := range again {
		if was, ok := files[rel]; !ok || !bytes.Equal(was, b) || !times[rel].Equal(timesAgain[rel]) {
			changed = append(changed, rel)
		}
	}
	for rel := range files {
		if _, ok := again[rel]; !ok {
			changed = append(changed, rel+" (gone)")
		}
	}
	slices.Sort(changed)
	return changed
}

// A data folder as an app of before left it is brought to this computer's own by the start:
// remote/ is gone, the chat that never had a message is a chat of this computer with its draft,
// the one on a board of the other server is deleted, the run that had not started is a run of
// this computer with its goal, the group's defaults are this computer's alone, and the server
// list is untouched, so its entry connects and its section has that server's tree. That server
// is asked for nothing but what a connection reads. A second start writes no file.
func TestSectionChangeOverAtTheStart(t *testing.T) {
	t.Parallel()
	st := standin.Start(t, standin.Options{Snapshot: farTree()})
	root := t.TempDir()
	list := oldFolder(t, root, t.TempDir(), st)

	started := func(when string) *program {
		t.Helper()
		pr := wired(t, root)
		// The change-over is over when startServers returns: before the list is opened.
		changedOver(t, root, list)
		until(t, when+": the relay has the entry's tree", func() bool { _, ok := pr.sectionOf(savedEntryID); return ok })
		changedOverSnapshot(t, pr.call(t, "", "GET", "/api/state", nil).Raw, model.Claude)
		if held := holders(folderFiles(t, root), farMarks()); len(held) != 0 {
			t.Errorf("%s: files that hold something of the entry's server: %v", when, held)
		}
		pr.stop()
		changedOver(t, root, list)
		return pr
	}
	started("the first start")
	for _, r := range st.Requests() {
		if r.Method != "GET" || !slices.Contains([]string{servers.HelloPath, "/api/state", "/api/events"}, r.Path) {
			t.Errorf("the entry's server was sent %s %s for the change-over", r.Method, r.Path)
		}
	}
	files, times := folderFiles(t, root), folderTimes(t, root)

	started("the second start")
	if changed := folderChanges(files, times, folderFiles(t, root), folderTimes(t, root)); len(changed) != 0 {
		t.Errorf("the second start wrote or removed: %s", strings.Join(changed, ", "))
	}
}

// A chat that never had a message on the run that had not started and named the entry stays on
// that run, with its draft: the run is a run of this computer by the time the chat's place is
// looked at, since the runs are put here before the chats (localOnly). The chat's folder is in
// the run's, and its chat.json names no server.
func TestSectionChangeOverKeepsAChatOnTheRunThatBecomesLocal(t *testing.T) {
	t.Parallel()
	const onRun, typed = "0c000000-0000-4000-8000-000000000003", "typed here on the run for the studio"
	st := standin.Start(t, standin.Options{Snapshot: farTree()})
	root := t.TempDir()
	list := oldFolder(t, root, t.TempDir(), st)
	p := store.NewPaths(root)
	file := filepath.Join(p.RunChatDir(oldRun, false, onRun), "chat.json")
	meta, err := json.Marshal(model.ChatMeta{ID: onRun, Agent: model.Claude, Run: oldRun, Cwd: "/home/standin/work", Model: "standin-model",
		Token: "tok-" + onRun, Created: farTime,
		Drafts: map[string]*model.Draft{model.MainBranch: {Text: typed}}, DraftRevs: map[string]int64{model.MainBranch: 1}})
	if err != nil {
		t.Fatal(err)
	}
	// As the app of before wrote it: with the entry as its "server".
	meta = append([]byte(`{"server":"`+savedEntryID+`",`), meta[1:]...)
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, meta, 0o600); err != nil {
		t.Fatal(err)
	}

	pr := wired(t, root)
	changedOver(t, root, list)
	var v model.ChatView
	got := pr.call(t, "", "GET", "/api/chats/"+onRun, nil)
	if json.Unmarshal([]byte(got.Raw), &v); got.Status != http.StatusOK || v.Run != oldRun || v.Group != "" || v.Locked ||
		v.Draft == nil || v.Draft.Text != typed || v.DraftRev != 1 || strings.Contains(got.Raw, `"server"`) {
		t.Fatalf("the chat on the run that named the entry: %s; want it on that run, not started, with its draft", got)
	}
	// The run it is on is a run of this computer that has not started.
	var r model.RunView
	if got := pr.call(t, "", "GET", "/api/runs/"+oldRun, nil); json.Unmarshal([]byte(got.Raw), &r) != nil || got.Status != http.StatusOK || r.Status != model.RunDraft {
		t.Fatalf("the run of the chat: %s", got)
	}
	// The chat is in the run's folder, as it was, and it is the chat that is left of the two
	// that were kept for the entry outside a group.
	raw, err := os.ReadFile(file)
	if err != nil || bytes.Contains(raw, []byte(`"server"`)) || !bytes.Contains(raw, []byte(typed)) {
		t.Fatalf("chat.json of the chat on the run (%v): %s", err, raw)
	}
	if _, err := os.Lstat(p.ChatDir(onRun)); !os.IsNotExist(err) {
		t.Errorf("the chat on the run has a folder among the chats in groups: %v", err)
	}
	pr.stop()
	changedOver(t, root, list)
}

// A data folder that never had another server: the start finds nothing to change over. What
// this computer has, a chat with a draft and an image, a board with its drawing, a run with its
// goal and what the groups remember, is in the snapshot as it was, no file is written or
// removed by a second start, and the folder has no remote/ and no server list.
func TestSectionChangeOverLeavesAFolderOfThisComputerAlone(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	// lists are this computer's lists of a page's snapshot, as they came.
	lists := func(pr *program) map[string]string {
		t.Helper()
		var parts map[string]json.RawMessage
		got := pr.call(t, "", "GET", "/api/state", nil)
		if err := json.Unmarshal([]byte(got.Raw), &parts); err != nil || got.Status != http.StatusOK {
			t.Fatalf("the snapshot: %v in %s", err, got)
		}
		if string(parts["sections"]) != "{}" {
			t.Errorf("the sections of a program with no entry: %s", parts["sections"])
		}
		out := map[string]string{}
		for _, list := range []string{"groups", "boards", "chats", "states", "runs", "defaults"} {
			out[list] = string(parts[list])
		}
		return out
	}
	first := wired(t, root)
	first.page(t, "page")
	localSteps(t, first, "page")
	was := lists(first)
	first.stop()
	for _, list := range []string{"boards", "chats", "states", "runs"} {
		if was[list] == "[]" {
			t.Fatalf("this computer's %s before the second start: none", list)
		}
	}
	files, times := folderFiles(t, root), folderTimes(t, root)

	second := wired(t, root)
	now := lists(second)
	second.stop()
	for list, raw := range was {
		if now[list] != raw {
			t.Errorf("this computer's %s after the second start:\n%s\nwere:\n%s", list, now[list], raw)
		}
	}
	again := folderFiles(t, root)
	if changed := folderChanges(files, times, again, folderTimes(t, root)); len(changed) != 0 {
		t.Errorf("the start of a folder that never had another server wrote or removed: %s", strings.Join(changed, ", "))
	}
	for rel := range again {
		if top, _, _ := strings.Cut(filepath.ToSlash(rel), "/"); top == "remote" || strings.HasPrefix(top, servers.FileName) {
			t.Errorf("the folder has %s", rel)
		}
	}
}
