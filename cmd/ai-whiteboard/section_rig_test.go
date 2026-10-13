package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
	"ai-whiteboard/internal/store"
)

// What the tests of a section in this package share: the tree a stand-in server has, the data
// folder an app of before left, and the files of a data folder. The other server is a stand-in
// (internal/servers/standin), a server of level 5 that answers what a test scripts; this server
// is the real program, wired in this process by startServers (wired) or run as a process.

// The ids and the texts of what the stand-in has. No file of this server's data folder may hold
// one of them.
const (
	farGroup   = "g_there"
	farChat    = "2a000000-0000-4000-8000-00000000000a" // started
	farDrafted = "2b000000-0000-4000-8000-00000000000b" // not started, with a draft
	farBoard   = "b_aaaa0001"

	farGroupName = "Studio work"
	farDraft     = "typed on the studio and not sent"
)

// farTime is when the stand-in's things were made.
var farTime = time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)

// farView is a chat of the stand-in: started, in the stand-in's group.
func farView(id, name string) model.ChatView {
	return model.ChatView{ID: id, Agent: model.Claude, Name: name, Group: farGroup, Cwd: "/home/standin/work",
		Model: "standin-model", Locked: true, Status: model.StatusReady, Created: farTime}
}

// farTree is the snapshot of a stand-in with a tree: a group and what it remembers for a new
// chat, a board, a started chat and one that has not started and has a draft, the state of each
// chat's branch.
func farTree() map[string]any {
	drafted := farView(farDrafted, "")
	drafted.Locked, drafted.Draft, drafted.DraftRev, drafted.HasDraft = false, &model.Draft{Text: farDraft}, 1, true
	chats := []model.ChatView{farView(farChat, "Started there"), drafted}
	states := []model.BranchState{}
	for _, v := range chats {
		states = append(states, model.StateOf(v.ID, model.MainBranch, v))
	}
	snap := standin.DefaultSnapshot()
	snap["groups"] = []model.Group{{ID: farGroup, Name: farGroupName}}
	snap["defaults"] = model.Defaults{Groups: map[string]model.GroupDefaults{
		farGroup: model.LocalDefaults(model.ServerDefaults{Agent: model.Claude, Cwd: "/home/standin/work"})}}
	snap["boards"] = []model.Board{{ID: farBoard, Name: "Studio board", Group: farGroup, Created: farTime}}
	snap["chats"], snap["states"] = chats, states
	return snap
}

// farMarks are the ids and texts of farTree, and the stand-in's secret: what a file of this
// server's data folder must not hold, but for the secret in the server list.
func farMarks() []string {
	return []string{farGroup, farChat, farDrafted, farBoard, farGroupName, farDraft, standin.DefaultSecret}
}

// The ids and the texts of what an app of before left in the data folder (oldFolder).
const (
	oldChat      = "0c000000-0000-4000-8000-000000000001" // never had a message, kept here for the entry, with a draft
	oldBoardChat = "0c000000-0000-4000-8000-000000000002" // the same, on a board that is not on this computer
	oldGroup     = "g_old"                                // the group of both
	oldFarGroup  = "g_onlyfar"                            // a group that held only things of the entry's server

	oldFarGroupName = "Only the studio's"
	oldDraft        = "typed here for the studio"
	oldKeptDraft    = "a draft kept with the record" // of the started chat: not carried over, lost
	oldSeen         = "As it was last seen"          // the name in the last view of a record
	oldArchive      = "a_old0000"                    // the archive action of a mark that waited for the server, without its last digit
)

// oldMarks are what the records of an app of before held and no file holds after the start: the
// draft kept with a record, the name of a last view, and the id of the archive action whose mark
// waited for the server (oldArchive and a digit).
func oldMarks() []string {
	return []string{oldKeptDraft, oldSeen, oldArchive}
}

// oldFolder writes into root what an app of before the sections left there with one entry in
// its list, the stand-in: the folder remote/ with the record files of a chat and a board and the
// memory of makes; a chat that never had a message and names the entry, with a draft, and one
// such chat on a board that is not on this computer; and a state.json whose group remembers that
// server as the one it used last and has choices for it beside this computer's, whose folder is
// cwd. The record of the chat, a started one, has a draft that was kept with it and not carried
// over. The record of the board has its place in a second group, which so holds only things of
// that server, and has an archive mark that was set here and that server was never told of. It
// returns the bytes of the list file.
func oldFolder(t *testing.T, root, cwd string, st *standin.Server) (list []byte) {
	t.Helper()
	// The list of an app that was connected to that server: it knows the server's instance id.
	list = []byte(strings.Replace(savedEntry(st), `"selfSigned":true`, `"selfSigned":true,"instanceId":"`+standin.DefaultInstanceID+`"`, 1))
	oldFolderOf(t, root, cwd, list, oldThings{instance: standin.DefaultInstanceID, chat: farChat, made: farDrafted, board: farBoard})
	return list
}

// oldThings are what the app of before knew of the server of its entry: the server's instance
// id, and the ids there of the chat and the board it kept records of and of the chat its memory
// of makes names.
type oldThings struct {
	instance, chat, made, board string
}

// oldFolderOf is oldFolder for any server: list is the bytes of the list file, whose one entry
// has the id savedEntryID, and there is what the app knew of that entry's server.
func oldFolderOf(t *testing.T, root, cwd string, list []byte, there oldThings) {
	t.Helper()
	p := store.NewPaths(root)
	write := func(path string, content []byte) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// named is v as JSON with the entry as its "server", as the app of before wrote it.
	named := func(v any) []byte {
		t.Helper()
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		m["server"] = savedEntryID
		if raw, err = json.MarshalIndent(m, "", "  "); err != nil {
			t.Fatal(err)
		}
		return raw
	}
	write(filepath.Join(root, servers.FileName), list)

	remote := filepath.Join(root, "remote")
	// record is the record file of the thing id of the entry's server, filed in group, with more
	// fields after its last view.
	record := func(id, group, more string) []byte {
		return []byte(`{"id":"` + id + `","entry":"` + savedEntryID + `","group":"` + group + `","view":{"id":"` + id + `","name":"` + oldSeen + `"}` + more + `}`)
	}
	write(filepath.Join(remote, "chats", there.chat+".json"), record(there.chat, oldGroup, `,"drafts":{"main":{"text":"`+oldKeptDraft+`"}},"draftRevs":{"main":3}`))
	write(filepath.Join(remote, "chats", there.chat+".draft.json"), []byte(`{"text":"`+oldKeptDraft+`"}`))
	write(filepath.Join(remote, "boards", there.board+".json"), record(there.board, oldFarGroup, `,"archived":true,"archiveOp":"`+oldArchive+`1","pending":"archive"`))
	write(filepath.Join(remote, "makes.json"), []byte(`{"makes":[{"entry":"`+savedEntryID+`","id":"`+there.made+`"}]}`))

	chat := model.ChatMeta{ID: oldChat, Agent: model.Claude, Group: oldGroup, Cwd: "/home/standin/work", Model: "standin-model",
		Token: "tok-" + oldChat, Created: farTime,
		Drafts: map[string]*model.Draft{model.MainBranch: {Text: oldDraft}}, DraftRevs: map[string]int64{model.MainBranch: 2}}
	write(filepath.Join(p.ChatDir(oldChat), "chat.json"), named(chat))
	onBoard := chat
	onBoard.ID, onBoard.Token, onBoard.Group, onBoard.Board, onBoard.Drafts, onBoard.DraftRevs = oldBoardChat, "tok-"+oldBoardChat, "", there.board, nil, nil
	write(filepath.Join(p.ChatDir(oldBoardChat), "chat.json"), named(onBoard))

	state, err := json.Marshal(map[string]any{"version": 1, "groups": []model.Group{{ID: oldGroup, Name: "Mixed"}, {ID: oldFarGroup, Name: oldFarGroupName}},
		"defaults": map[string]any{"groups": map[string]any{oldGroup: map[string]any{
			"server": there.instance,
			"servers": map[string]any{
				model.LocalServer: model.ServerDefaults{Agent: model.Claude, Cwd: cwd},
				there.instance:    model.ServerDefaults{Agent: model.Claude, Cwd: "/home/standin/work"},
			}}}}})
	if err != nil {
		t.Fatal(err)
	}
	write(p.State, state)
}

// filesUnder lists the files below dir, relative to it.
func filesUnder(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			rel, _ := filepath.Rel(dir, path)
			out = append(out, rel)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// folderFiles reads every file under the data folder: its bytes by its path relative to root.
// What is no file with bytes, as the socket of a running server, is left out.
func folderFiles(t *testing.T, root string) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	for _, rel := range filesUnder(t, root) {
		if info, err := os.Lstat(filepath.Join(root, rel)); err != nil || !info.Mode().IsRegular() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(root, rel))
		if err != nil {
			t.Fatal(err)
		}
		out[rel] = b
	}
	return out
}

// holders are the files, of those of folderFiles, that hold one of the marks: each as
// "path holds mark". The server list is left out: it is what this server keeps of another one.
func holders(files map[string][]byte, marks []string) (out []string) {
	for rel, b := range files {
		if filepath.Base(rel) == servers.FileName {
			continue
		}
		for _, mark := range marks {
			if bytes.Contains(b, []byte(mark)) {
				out = append(out, rel+" holds "+mark)
			}
		}
	}
	return out
}
