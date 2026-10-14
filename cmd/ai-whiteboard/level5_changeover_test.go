package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/model"
)

// The test of this file is the change-over of a server from before level 5, on a real server
// process. Such a server put everything an API client made into one group, "Remote", and kept
// that group's id in state.json ("remoteGroup"); each chat and board of a client carried the
// client's id as a mark ("client"). The updated server removes that group at its first start,
// before it serves a request, and reads no mark. (The server's own page is a client now, like
// the others.)

// level5Tree is a server's tree, as the snapshot of an API client of level 5 and the state of
// the server's own page hold it.
type level5Tree struct {
	Groups   []model.Group
	Boards   []model.Board
	Chats    []model.ChatView
	States   []model.BranchState
	Defaults model.Defaults
}

// level5Fields are the fields of a state that are the tree.
var level5Fields = []string{"groups", "boards", "chats", "states", "defaults"}

// treeOf decodes the tree of a state or of a snapshot event, and returns each of its fields as
// it was sent too. A field that is missing fails the test.
func treeOf(t *testing.T, state []byte) (map[string]json.RawMessage, level5Tree) {
	t.Helper()
	var raw map[string]json.RawMessage
	var tree level5Tree
	if err := json.Unmarshal(state, &raw); err != nil {
		t.Fatalf("the state: %v in %s", err, state)
	}
	if err := json.Unmarshal(state, &tree); err != nil {
		t.Fatalf("the state: %v in %s", err, state)
	}
	for _, f := range level5Fields {
		if len(raw[f]) == 0 || string(raw[f]) == "null" {
			t.Fatalf("the state has no %q: %s", f, state)
		}
	}
	return raw, tree
}

// treeAs is the tree in the state that the client reads.
func (in *instance) treeAs(t *testing.T, client string) (map[string]json.RawMessage, level5Tree) {
	t.Helper()
	status, raw := getAs(t, in, client, "GET", "/api/state", nil)
	if status != http.StatusOK {
		t.Fatalf("the state of the client %s: status %d: %s", client, status, raw)
	}
	return treeOf(t, raw)
}

// apiY is the id of the tests' second client.
const apiY = "8d3e6b1c-2f4a-4b7d-a9c1-0e5f6a7b8c9d"

// apiZ is the id of the tests' third client.
const apiZ = "1c9b7a5d-3e2f-4a6b-8c0d-9e1f2a3b4c5d"

// getAs makes one call of the client and returns the status and the body.
func getAs(t *testing.T, in *instance, client, method, path string, body any) (int, []byte) {
	t.Helper()
	status, raw, err := in.request(context.Background(), client, method, path, body)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	return status, raw
}

// lines is the tree as lines, one for each thing with its place and its archive mark: the groups
// in the server's order, then the boards and the chats by id.
func (tr level5Tree) lines() []string {
	var groups, rest []string
	for _, g := range tr.Groups {
		groups = append(groups, fmt.Sprintf("group %s %q in %q archived %v %q", g.ID, g.Name, g.Parent, g.Archived, g.Op))
	}
	for _, b := range tr.Boards {
		rest = append(rest, fmt.Sprintf("board %s %q in %q archived %v %q", b.ID, b.Name, b.Group, b.Archived, b.Op))
	}
	for _, c := range tr.Chats {
		rest = append(rest, fmt.Sprintf("chat %s in %q on the board %q archived %v %q locked %v", c.ID, c.Group, c.Board, c.Archived, c.Op, c.Locked))
	}
	slices.Sort(rest)
	return append(groups, rest...)
}

// marksIn lists where a decoded JSON value holds a key "client" or "origin": the mark of the API
// client that made a thing, and of the board whose chat made a board.
func marksIn(v any, at string) (found []string) {
	switch v := v.(type) {
	case map[string]any:
		for k, sub := range v {
			if k == "client" || k == "origin" {
				found = append(found, at+"."+k)
			}
			found = append(found, marksIn(sub, at+"."+k)...)
		}
	case []any:
		for i, sub := range v {
			found = append(found, marksIn(sub, fmt.Sprintf("%s[%d]", at, i))...)
		}
	}
	return found
}

// noMarks checks that no view of the tree has a "client" or an "origin".
func noMarks(t *testing.T, who string, raw map[string]json.RawMessage) {
	t.Helper()
	for _, f := range level5Fields {
		var v any
		if err := json.Unmarshal(raw[f], &v); err != nil {
			t.Fatalf("%s of %s: %v", f, who, err)
		}
		if found := marksIn(v, f); len(found) != 0 {
			t.Errorf("the tree of %s holds a mark at %v: %s", who, found, raw[f])
		}
	}
}

// sameLists checks that two readings of one server hold exactly the same tree, field by field
// and each list in the same order: the server gives its own page and every client the groups in
// its order, the boards and the chats oldest first and the branch states by their
// chat, at every read and after a restart.
func sameLists(t *testing.T, a, b string, ra, rb map[string]json.RawMessage) {
	t.Helper()
	for _, f := range level5Fields {
		var va, vb any
		if err := json.Unmarshal(ra[f], &va); err != nil {
			t.Fatalf("%s of %s: %v in %s", f, a, err, ra[f])
		}
		if err := json.Unmarshal(rb[f], &vb); err != nil {
			t.Fatalf("%s of %s: %v in %s", f, b, err, rb[f])
		}
		ca, _ := json.Marshal(va) // with the keys in one order
		cb, _ := json.Marshal(vb)
		if string(ca) != string(cb) {
			t.Errorf("%s of %s and of %s differ:\n%s\n\n%s", f, a, b, ca, cb)
		}
	}
}

// sameTree checks that the tree a section holds and the tree of its server are exactly the same,
// field by field. The groups are in the server's order; the local server of a client keeps the
// boards, the chats and their branch states of a section in the order they came, so
// each of those is compared as the set of what it holds.
func sameTree(t *testing.T, a, b string, ra, rb map[string]json.RawMessage) {
	t.Helper()
	inOneOrder := func(f string, raw json.RawMessage) string {
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatalf("%s: %v in %s", f, err, raw)
		}
		list, isList := v.([]any)
		if !isList || f == "groups" {
			c, _ := json.Marshal(v) // with the keys in one order
			return string(c)
		}
		each := make([]string, len(list))
		for i, e := range list {
			c, _ := json.Marshal(e)
			each[i] = string(c)
		}
		slices.Sort(each)
		return strings.Join(each, "\n")
	}
	for _, f := range level5Fields {
		if ca, cb := inOneOrder(f, ra[f]), inOneOrder(f, rb[f]); ca != cb {
			t.Errorf("%s of %s and of %s differ:\n%s\n\n%s", f, a, b, ca, cb)
		}
	}
}

// fileOf finds the file <id>/<name> of a thing under the data folder: a chat's chat.json is
// under chats/.
func fileOf(t *testing.T, dir, id, name string) string {
	t.Helper()
	var found string
	filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && d.Name() == name && filepath.Base(filepath.Dir(path)) == id {
			found = path
		}
		return nil
	})
	if found == "" {
		t.Fatalf("no %s of %s under %s", name, id, dir)
	}
	return found
}

// editJSON changes the JSON object in the file at path, as an edit by hand does: the numbers
// stay as they are written.
func editJSON(t *testing.T, path string, edit func(obj map[string]any)) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var obj map[string]any
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	if err := dec.Decode(&obj); err != nil {
		t.Fatalf("%s: %v in %s", path, err, b)
	}
	edit(obj)
	if b, err = json.MarshalIndent(obj, "", "  "); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

// After an update of a remote server there is no group "Remote", and what was in it is in no
// group (the goal's section 7; the contract's 2.8 and V7). The data folder is made by the server
// itself, through its own port, and then given what a server from before level 5 left in it: the
// id of one group as "remoteGroup" in state.json, a group that has another name by now, and the
// mark of an API client in the files of what is in it.
//
// The group holds a chat with a message, an archived chat, a board with a chat on it, and a group
// nested in it with a chat of its own. A second, ordinary group is
// merely named "Remote" and holds a chat and a board. After the start the named group is gone;
// its plain chats and its board are in no group with their archive marks as they were;
// the chat on the board is on the board still; the nested group is at the top level with its
// chat; the group named "Remote" is as it was. No view holds a mark, a second client sees
// exactly the same tree and reads what the first one "made", and a restart changes nothing more.
func TestLevel5ChangeOver(t *testing.T) {
	serverTest(t, "TestLevel5DropRemoteGroup, TestLevel5DropRemoteGroupCorners (internal/app: the group of the API clients of a remote server)")
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH (the fake claude is a Node script)")
	}
	in := newInstance(t)
	in.claude = agenttest.FakeClaude(t)
	in.launchJSON(t, "launch")

	// The server as it is used: a client makes the groups and what is in them.
	p := in.page(t, "6c8f2a1d-3e4b-4f5a-8b7c-9d0e1f2a3b4c")
	p.Welcome()
	made := func(path string, body map[string]any) string {
		t.Helper()
		id, _ := ok200(t, p, "POST", path, body)["id"].(string)
		if id == "" {
			t.Fatalf("POST %s %v: the answer has no id", path, body)
		}
		return id
	}
	named := made("/api/groups", map[string]any{"name": "Clients", "parent": ""})
	nested := made("/api/groups", map[string]any{"name": "Inside", "parent": named})
	plain := made("/api/groups", map[string]any{"name": "Remote", "parent": ""})

	const word = "A message of before."
	chat := made("/api/chats", map[string]any{"agent": "claude", "group": named})
	ok200(t, p, "PATCH", "/api/chats/"+chat, map[string]any{"cwd": t.TempDir()})
	ok200(t, p, "POST", "/api/chats/"+chat+"/messages", map[string]any{"text": word})
	awaitItems(t, p, chat, "the end of the first turn", func(items []model.Item) bool {
		return len(items) > 0 && items[len(items)-1].Kind == "end"
	})
	archived := made("/api/chats", map[string]any{"agent": "claude", "group": named})
	ok200(t, p, "POST", "/api/chats/"+archived+"/archive", nil)
	board := made("/api/boards", map[string]any{"name": "A client's board", "group": named})
	onBoard := made("/api/chats", map[string]any{"agent": "claude", "board": board})
	inNested := made("/api/chats", map[string]any{"agent": "claude", "group": nested})
	inPlain := made("/api/chats", map[string]any{"agent": "claude", "group": plain})
	boardPlain := made("/api/boards", map[string]any{"name": "The owner's board", "group": plain})

	_, before := in.treeAs(t, apiZ)
	p.Close()
	if out := in.run(t, "stop"); !strings.Contains(out, "AI Whiteboard stopped") {
		t.Fatalf("stop printed %q", out)
	}

	// What a server from before level 5 left: the group's id in state.json, with what the server
	// remembered for the group, and the client's mark on what the client made. The board carries
	// the mark of a board an agent made, too.
	statePath := filepath.Join(in.dir, "state.json")
	editJSON(t, statePath, func(st map[string]any) {
		st["remoteGroup"] = named
		defaults, _ := st["defaults"].(map[string]any)
		groups, _ := defaults["groups"].(map[string]any)
		if groups == nil {
			t.Fatalf("state.json has no defaults by group: %v", st["defaults"])
		}
		if _, has := groups[named]; !has {
			groups[named] = map[string]any{"servers": map[string]any{"local": map[string]any{"cwd": "/"}}}
		}
	})
	for _, id := range []string{chat, archived, onBoard, inNested} {
		editJSON(t, fileOf(t, in.dir, id, "chat.json"), func(meta map[string]any) { meta["client"] = testClient })
	}
	editJSON(t, fileOf(t, in.dir, board, "board.json"), func(meta map[string]any) {
		meta["client"], meta["origin"] = testClient, boardPlain
	})

	// The tree the start must leave: what was there, with the named group gone, what was in it in
	// no group, and the group nested in it at the top level.
	var want []string
	inNamed := 0
	for _, line := range before.lines() {
		switch {
		case strings.HasPrefix(line, "group "+named+" "):
			continue
		case strings.HasPrefix(line, "group "+nested+" "):
			line = strings.Replace(line, fmt.Sprintf("in %q", named), `in ""`, 1)
		case strings.Contains(line, fmt.Sprintf("in %q", named)):
			line = strings.Replace(line, fmt.Sprintf("in %q", named), fmt.Sprintf("in %q", model.Ungrouped), 1)
			inNamed++
		}
		want = append(want, line)
	}
	// The chat with a message, the archived one and the board; the chat on the board is in no
	// group of its own.
	if inNamed != 3 || len(before.Groups) != 3 || len(before.Chats) != 5 || len(before.Boards) != 2 {
		t.Fatalf("the tree before the change-over, with %d things in the named group:\n%s", inNamed, strings.Join(before.lines(), "\n"))
	}
	check := func(when string, x level5Tree) {
		t.Helper()
		if got := x.lines(); !slices.Equal(got, want) {
			t.Fatalf("the tree %s:\n%s\nwant:\n%s", when, strings.Join(got, "\n"), strings.Join(want, "\n"))
		}
		// The same, said of each thing by its name.
		for _, c := range x.Chats {
			if c.ID == onBoard {
				if c.Board != board || c.Archived {
					t.Errorf("%s, the chat on the board is on the board %q, archived %v; want it on %s", when, c.Board, c.Archived, board)
				}
				continue
			}
			want := map[string]string{chat: model.Ungrouped, archived: model.Ungrouped, inNested: nested, inPlain: plain}[c.ID]
			if c.Group != want || c.Board != "" || c.Archived != (c.ID == archived) {
				t.Errorf("%s, the chat %s is in %q, on the board %q, archived %v; want it in %q", when, c.ID, c.Group, c.Board, c.Archived, want)
			}
		}
		for _, b := range x.Boards {
			if want := map[string]string{board: model.Ungrouped, boardPlain: plain}[b.ID]; b.Group != want || b.Archived {
				t.Errorf("%s, the board %s is in %q, archived %v; want it in %q", when, b.ID, b.Group, b.Archived, want)
			}
		}
		if len(x.Groups) != 2 || x.Groups[0].ID != nested || x.Groups[0].Parent != "" || x.Groups[0].Name != "Inside" ||
			x.Groups[1].ID != plain || x.Groups[1].Parent != "" || x.Groups[1].Name != "Remote" {
			t.Errorf("%s, the groups are %+v; want the nested one and the one named \"Remote\", both at the top level", when, x.Groups)
		}
		if _, has := x.Defaults.Groups[named]; has {
			t.Errorf("%s, the defaults hold the removed group: %+v", when, x.Defaults.Groups)
		}
	}
	stateFile := func(when string) {
		t.Helper()
		b, err := os.ReadFile(statePath)
		if err != nil {
			t.Fatal(err)
		}
		var st struct {
			Groups      []model.Group
			Defaults    model.Defaults
			RemoteGroup *string
		}
		if err := json.Unmarshal(b, &st); err != nil {
			t.Fatalf("state.json %s: %v in %s", when, err, b)
		}
		_, kept := st.Defaults.Groups[named]
		if st.RemoteGroup != nil || bytes.Contains(b, []byte("remoteGroup")) || kept || bytes.Contains(b, []byte(named)) ||
			len(st.Groups) != 2 || st.Groups[0].ID != nested || st.Groups[0].Parent != "" || st.Groups[1].ID != plain {
			t.Fatalf("state.json %s:\n%s", when, b)
		}
	}
	// Before the start the file is the one of before: the checks below are of the start.
	if b, _ := os.ReadFile(statePath); !bytes.Contains(b, []byte(`"remoteGroup": "`+named+`"`)) {
		t.Fatalf("state.json before the start:\n%s", b)
	}

	// The first start of the updated server.
	in.launchJSON(t, "launch")
	x := in.page(t, testClient)
	snapshot, err := json.Marshal(x.Welcome())
	if err != nil {
		t.Fatal(err)
	}
	xRaw, xTree := treeOf(t, snapshot)
	check("in the snapshot of the client whose mark the files hold", xTree)
	yRaw, yTree := in.treeAs(t, apiY)
	check("in the state of a second client", yTree)
	ownRaw, ownTree := in.treeAs(t, apiZ)
	check("in the state of a third client", ownTree)
	sameLists(t, "the first client", "a second client", xRaw, yRaw)
	sameLists(t, "the first client", "a third client", xRaw, ownRaw)
	noMarks(t, "the first client", xRaw)
	noMarks(t, "a second client", yRaw)
	noMarks(t, "a third client", ownRaw)
	stateFile("after the first start")

	// What the files say the first client made is everyone's: the second client reads the chat,
	// and puts the board into the group named "Remote".
	status, raw := getAs(t, in, apiY, "GET", "/api/chats/"+chat+"/items", nil)
	if status != http.StatusOK || !strings.Contains(string(raw), word) {
		t.Fatalf("the second client's read of the chat: status %d: %s", status, raw)
	}
	if status, raw := getAs(t, in, apiY, "PATCH", "/api/boards/"+board, map[string]any{"group": plain}); status != http.StatusOK {
		t.Fatalf("the second client's move of the board: status %d: %s", status, raw)
	}
	if status, raw := getAs(t, in, apiY, "PATCH", "/api/boards/"+board, map[string]any{"group": model.Ungrouped}); status != http.StatusOK {
		t.Fatalf("the second client's move of the board back: status %d: %s", status, raw)
	}
	x.Close()

	// A restart: the change-over ran once, and nothing more changes.
	old := in.hello(t).Pid
	in.run(t, "relaunch")
	in.waitServing(t)
	if pid := in.hello(t).Pid; pid == old {
		t.Fatalf("hello still reports the old pid %d", old)
	}
	againRaw, againTree := in.treeAs(t, testClient)
	check("after a restart", againTree)
	sameLists(t, "the first start", "the restart", xRaw, againRaw)
	noMarks(t, "a client after the restart", againRaw)
	ownRaw, ownTree = in.treeAs(t, apiZ)
	check("in the state of a third client after a restart", ownTree)
	noMarks(t, "a third client after a restart", ownRaw)
	stateFile("after a restart")
	if log := serverLog(t, in.dir); strings.Contains(log, "could not be removed") {
		t.Fatalf("the log speaks of a change-over that failed:\n%s", log)
	}
}
