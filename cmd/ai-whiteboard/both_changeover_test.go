package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers/linksim"
)

// Both change-overs at once, with two real server processes (the goal's section 7): a remote
// server that starts on the data folder a server of before level 5 left, and the app that starts
// on the data folder an app of before the sections left for that same server, whose list has it
// as an entry. Each half alone, against a stand-in or a plain client, is
// TestSectionChangeOverAtTheStart and TestLevel5ChangeOver.

// thingFiles are the files of a data folder that are a chat's, a board's or a run's, or a
// record's of the app of before: their paths, with "/", sorted.
func thingFiles(files map[string][]byte) (out []string) {
	for rel := range files {
		rel = filepath.ToSlash(rel)
		if top, _, _ := strings.Cut(rel, "/"); top == "chats" || top == "boards" || top == "runs" || top == "remote" {
			out = append(out, rel)
		}
	}
	slices.Sort(out)
	return out
}

// notHeld are the marks that no file of files holds: of a folder that must hold every one of
// them, what is missing. The server list is left out, as in holders.
func notHeld(files map[string][]byte, marks []string) (out []string) {
	for _, mark := range marks {
		if len(holders(files, []string{mark})) == 0 {
			out = append(out, mark)
		}
	}
	return out
}

// B is a remote server from before level 5: its state.json names a group as the one of its
// clients ("remoteGroup"), which holds a chat with a message, an archived chat, a board with a
// chat on it, a run that has not started and has a goal, and a nested group with a chat; beside
// it is a group that is merely named "Remote", with a chat and a board. What a client made
// carries the client's mark.
//
// A is the app of before, with B as the entry of its list: the folder remote/ with the records
// of B's chat, board and run, a draft kept with the chat's record, a record with an archive mark
// that B was never told of, and the memory of a make; a chat that never had a message, kept for
// B with a draft, and one on B's board; a run that has not started and names B, with its goal;
// a group that remembers B as its server with choices for it; and a group that held only things
// of B.
//
// A starts first, while B is still down: its change-over needs no server. Its data folder holds
// the server list and nothing else of B, the chat and the run are this computer's with the draft
// and the goal, the group that held only B's things is there, empty, and B's section has no
// tree. Then B starts, for the first time since its update, and A connects by itself: the
// section has B's whole tree, with what was in the clients' group in no group and the nested
// group at the top level, and B's own page has the same tree. Nothing was deleted on B: not the
// chat of the memory of makes, and the chat A had an archive mark for is not archived. A chat, a
// board and a run are then made in the section, a draft is typed and sent, the board is drawn on
// and the run gets its goal: B's own page is told of each, B's data folder holds each, and A's
// gained no file and holds nothing of them, while it runs and after it was stopped.
func TestBothChangeOvers(t *testing.T) {
	serverTest(t, "TestSectionChangeOverAtTheStart (this package: the app's data folder, against a stand-in server)",
		"TestLevel5DropRemoteGroup, TestLevel5DropRemoteGroupCorners (internal/app: the group of the API clients of a remote server)",
		"TestRemoteListenerServes (this package: the group that state.json names is gone after a start of a real server); TestLevel5ChangeOver is the remote server's half alone, in the full set")
	rp := newPair(t, linksim.Good, "", []string{fast.env(t, "backoff")})

	// ---- B, as it is used: its own page makes the groups and what is in them --------------------
	rp.b.up(t)
	instance, _ := rp.b.in.helloMap(t)["instanceId"].(string)
	if instance == "" {
		t.Fatal("B's hello has no instance id")
	}
	bPage := rp.ownPage(t)
	made := func(path string, body map[string]any) string {
		t.Helper()
		var v struct{ ID string }
		rp.b.must(t, pairOwnPage, "POST", path, body, &v)
		if v.ID == "" {
			t.Fatalf("POST %s %v at B: the answer has no id", path, body)
		}
		return v.ID
	}
	const (
		word      = "A message of before the update."
		goal      = "a goal typed on the studio before the update"
		boardName = "a-board-a-client-made" // a board's name has no spaces
		nestName  = "Inside the clients' group"
	)
	named := made("/api/groups", map[string]any{"name": "Clients", "parent": ""})
	nested := made("/api/groups", map[string]any{"name": nestName, "parent": named})
	plain := made("/api/groups", map[string]any{"name": "Remote", "parent": ""})
	chat := made("/api/chats", map[string]any{"agent": "claude", "group": named})
	rp.b.must(t, pairOwnPage, "PATCH", "/api/chats/"+chat, map[string]any{"cwd": rp.work}, nil)
	rp.b.must(t, pairOwnPage, "POST", "/api/chats/"+chat+"/messages", map[string]any{"text": word}, nil)
	rp.turns(t, chat, 1)
	archived := made("/api/chats", map[string]any{"agent": "claude", "group": named})
	rp.b.must(t, pairOwnPage, "POST", "/api/chats/"+archived+"/archive", nil, nil)
	board := made("/api/boards", map[string]any{"name": boardName, "group": named})
	onBoard := made("/api/chats", map[string]any{"agent": "claude", "board": board})
	run := made("/api/runs", map[string]any{"group": named, "name": "Not started"})
	rp.b.must(t, pairOwnPage, "PUT", "/api/runs/"+run+"/draft", map[string]any{"text": goal}, nil)
	inNested := made("/api/chats", map[string]any{"agent": "claude", "group": nested})
	inPlain := made("/api/chats", map[string]any{"agent": "claude", "group": plain})
	boardPlain := made("/api/boards", map[string]any{"name": "The owner's board", "group": plain})
	before := rp.ownTree(t)
	bPage.close()
	rp.b.stop(t)

	// What a server from before level 5 left: the group's id in state.json, with what the server
	// remembered for the group, and the client's mark on what the client made.
	bState := filepath.Join(rp.b.home, "state.json")
	editJSON(t, bState, func(st map[string]any) {
		st["remoteGroup"] = named
		defaults, _ := st["defaults"].(map[string]any)
		groups, _ := defaults["groups"].(map[string]any)
		if groups == nil {
			t.Fatalf("B's state.json has no defaults by group: %v", st["defaults"])
		}
		if _, has := groups[named]; !has {
			groups[named] = map[string]any{"servers": map[string]any{"local": map[string]any{"cwd": "/"}}}
		}
	})
	for _, id := range []string{chat, archived, onBoard, inNested} {
		editJSON(t, fileOf(t, rp.b.home, id, "chat.json"), func(meta map[string]any) { meta["client"] = testClient })
	}
	editJSON(t, fileOf(t, rp.b.home, board, "board.json"), func(meta map[string]any) { meta["client"], meta["origin"] = testClient, boardPlain })
	editJSON(t, fileOf(t, rp.b.home, run, "run.json"), func(meta map[string]any) { meta["client"] = testClient })

	// The tree B's start must leave: what was there, with the named group gone, what was in it in
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
	if inNamed != 4 || len(before.Groups) != 3 || len(before.Chats) != 5 || len(before.Boards) != 2 || len(before.Runs) != 1 {
		t.Fatalf("B's tree before the change-over, with %d things in the named group:\n%s", inNamed, strings.Join(before.lines(), "\n"))
	}
	// treeAsWanted checks one reading of B's tree: the lines, and each thing by its name.
	treeAsWanted := func(who string, x level5Tree, more ...string) {
		t.Helper()
		all := append(slices.Clone(want), more...)
		got := x.lines()
		// The groups come first, in the server's order: the two that stay. The rest is sorted.
		slices.Sort(all[2:])
		if !slices.Equal(got, all) {
			t.Fatalf("the tree of %s:\n%s\nwant:\n%s", who, strings.Join(got, "\n"), strings.Join(all, "\n"))
		}
		if len(x.Groups) != 2 || x.Groups[0].ID != nested || x.Groups[0].Parent != "" || x.Groups[0].Name != nestName ||
			x.Groups[1].ID != plain || x.Groups[1].Parent != "" || x.Groups[1].Name != "Remote" {
			t.Errorf("the groups of %s: %+v; want the nested one and the one named \"Remote\", both at the top level, and no group of the clients", who, x.Groups)
		}
		if _, has := x.Defaults.Groups[named]; has {
			t.Errorf("the defaults of %s hold the removed group: %+v", who, x.Defaults.Groups)
		}
		place := map[string]string{chat: model.Ungrouped, archived: model.Ungrouped, inNested: nested, inPlain: plain, board: model.Ungrouped, boardPlain: plain, run: model.Ungrouped}
		for _, c := range x.Chats {
			if c.ID == onBoard {
				if c.Board != board {
					t.Errorf("%s: the chat on the board is on the board %q, want %s", who, c.Board, board)
				}
			} else if g, known := place[c.ID]; known && (c.Group != g || c.Archived != (c.ID == archived)) {
				t.Errorf("%s: the chat %s is in %q, archived %v; want it in %q", who, c.ID, c.Group, c.Archived, g)
			}
		}
		for _, b := range x.Boards {
			if g, known := place[b.ID]; known && (b.Group != g || b.Archived) {
				t.Errorf("%s: the board %s is in %q, archived %v; want it in %q", who, b.ID, b.Group, b.Archived, g)
			}
		}
		for _, r := range x.Runs {
			if r.ID == run && (r.Group != model.Ungrouped || r.Status != model.RunDraft || r.Draft == nil || r.Draft.Text != goal) {
				t.Errorf("%s: the run of before is %+v; want it in no group, not started, with its goal", who, r)
			}
		}
	}

	// ---- A, as the app of before left its data folder for B -------------------------------------
	const onlyFar, onlyFarName = oldFarGroup, oldFarGroupName
	list := []byte(fmt.Sprintf(`{"version":1,"servers":[{"id":%q,"name":%q,"address":"https://127.0.0.1:%d","secret":%q,"selfSigned":true,"instanceId":%q,"pin":%q}]}`,
		savedEntryID, pairName, rp.b.port, rp.b.secret, instance, rp.b.fpr))
	if err := os.MkdirAll(rp.a.home, 0o700); err != nil {
		t.Fatal(err)
	}
	// The group's folder on this computer is a real one: the chat and the run that become this
	// computer's are in it.
	oldFolderOf(t, rp.a.home, rp.work, list, oldThings{instance: instance, chat: chat, made: inNested, board: board, run: run})
	// The folder's second group held only things of B: the records of the board and the run,
	// and the record of a chat of B that was archived here while B was away. B was never told of
	// that mark, nor of the run's.
	pending := `{"id":"` + inPlain + `","entry":"` + savedEntryID + `","group":"` + onlyFar + `","archived":true,"archiveOp":"` + oldArchive + `2","pending":"archive","view":{"id":"` + inPlain + `","name":"Archived here, not yet there"}}`
	if err := os.WriteFile(filepath.Join(rp.a.home, "remote", "chats", inPlain+".json"), []byte(pending), 0o600); err != nil {
		t.Fatal(err)
	}
	// What is B's: no file of A but the list may hold one of these after A's start.
	ofB := []string{named, nested, plain, chat, archived, board, onBoard, run, inNested, inPlain, boardPlain, instance, rp.b.secret,
		word, goal, boardName, nestName, oldKeptDraft, oldSeen, "Archived here, not yet there"}
	// Before the start the folder does hold them: the checks below are of the start.
	if missing := notHeld(folderFiles(t, rp.a.home), []string{chat, board, inNested, inPlain, instance, oldKeptDraft}); len(missing) != 0 {
		t.Fatalf("the folder of the app of before holds no %v", missing)
	}
	if records := thingFiles(folderFiles(t, rp.a.home)); !slices.Contains(records, "remote/runs/"+run+".json") || !slices.Contains(records, "remote/makes.json") {
		t.Fatalf("the files of the app of before: %v", records)
	}

	// ---- A starts, with B still down -------------------------------------------------------------
	rp.a.start(t)
	rp.entry = savedEntryID
	rp.page = watch(t, http.DefaultClient, strings.TrimSuffix(rp.a.in.url, "/"), pairPage, nil)
	// The server answers: the change-over is over, since it comes before the first request.
	changedOver(t, rp.a.home, list)
	// localPart checks this computer's own lists in A's snapshot: the chat with its draft and
	// the run with its goal, as things of this computer, the two groups, and nothing of B.
	localPart := func(when string) {
		t.Helper()
		var snap level5Tree
		var parts map[string]json.RawMessage
		status, raw := rp.a.call(t, pairPage, "GET", "/api/state", nil, &snap)
		if status != http.StatusOK || json.Unmarshal([]byte(raw), &parts) != nil {
			t.Fatalf("%s: A's snapshot: %d %s", when, status, raw)
		}
		if len(snap.Chats) != 1 || snap.Chats[0].ID != oldChat || snap.Chats[0].Locked || snap.Chats[0].Group != oldGroup || snap.Chats[0].Agent != model.Claude ||
			snap.Chats[0].Draft == nil || snap.Chats[0].Draft.Text != oldDraft || snap.Chats[0].DraftRev != 2 || snap.Chats[0].Cwd != rp.work ||
			len(snap.States) != 1 || snap.States[0].Chat != oldChat {
			t.Errorf("%s: this computer's chats: %s, states %s; want the chat that was kept for the entry alone, with its draft, in %s", when, parts["chats"], parts["states"], rp.work)
		}
		if len(snap.Runs) != 1 || snap.Runs[0].ID != oldRun || snap.Runs[0].Status != model.RunDraft || snap.Runs[0].Group != oldGroup ||
			snap.Runs[0].Draft == nil || snap.Runs[0].Draft.Text != oldGoal || !snap.Runs[0].Started.IsZero() || snap.Runs[0].Cwd != rp.work {
			t.Errorf("%s: this computer's runs: %s; want the run that named the entry alone, not started, with its goal, in %s", when, parts["runs"], rp.work)
		}
		// The group that held only things of B stays, empty, for the user to delete.
		if len(snap.Boards) != 0 || len(snap.Groups) != 2 || snap.Groups[0].ID != oldGroup || snap.Groups[1].ID != onlyFar || snap.Groups[1].Name != onlyFarName {
			t.Errorf("%s: this computer's boards %s and groups %s", when, parts["boards"], parts["groups"])
		}
		if g := snap.Defaults.Groups[oldGroup]; len(g.Servers) != 1 || g.Local().Cwd != rp.work {
			t.Errorf("%s: the defaults of the group: %s, want this computer's alone", when, parts["defaults"])
		}
		for _, f := range level5Fields {
			for _, mark := range append(slices.Clone(ofB), `"server"`, savedEntryID) {
				if bytes.Contains(parts[f], []byte(mark)) {
					t.Errorf("%s: this computer's %s hold %s: %s", when, f, mark, parts[f])
				}
			}
		}
	}
	localPart("with B down")
	// Nothing of B is known until it connects: no tree, and nothing can be asked for.
	rp.noTree(t, "with B down")
	if held := holders(folderFiles(t, rp.a.home), ofB); len(held) != 0 {
		t.Fatalf("with B down, files of A's data folder hold something of B: %v", held)
	}
	// The chat and the run are this computer's: its own routes have them.
	rp.ok(t, "GET", "/api/chats/"+oldChat, nil)
	rp.ok(t, "GET", "/api/runs/"+oldRun, nil)

	// ---- B starts: the first start of the updated server ----------------------------------------
	mark := rp.page.mark()
	rp.b.up(t)
	rp.back(t, 60*time.Second)
	rp.treeBack(t, mark)
	if v := rp.entryView(t); v.InstanceID != instance {
		t.Fatalf("the entry is connected to the instance %q, want B's %q", v.InstanceID, instance)
	}
	// The section is B's whole tree, and B's own page has the same.
	var snap struct {
		Sections map[string]map[string]json.RawMessage
	}
	rp.a.must(t, pairPage, "GET", "/api/state", nil, &snap)
	section := snap.Sections[savedEntryID]
	if section == nil || len(snap.Sections) != 1 {
		t.Fatalf("A's sections after B's start: %v", snap.Sections)
	}
	treeAsWanted("the section of "+pairName, level5Tree(rp.tree(t)))
	ownRaw, own := rp.b.in.tree(t)
	treeAsWanted("B's own page", own)
	sameTree(t, "the section of "+pairName, "B's own page", section, ownRaw)
	noMarks(t, "the section of "+pairName, section)
	noMarks(t, "B's own page", ownRaw)
	if b, err := os.ReadFile(bState); err != nil || bytes.Contains(b, []byte("remoteGroup")) || bytes.Contains(b, []byte(named)) {
		t.Fatalf("B's state.json after its start (%v):\n%s", err, b)
	}
	// Nothing was done on B for what A dropped: the chat of the memory of makes is there, the
	// chat A had an archive mark for is not archived, the started chat has no draft, and its
	// thread is as it was.
	if v, ok := rp.ownView(t, inNested); !ok || v.Locked {
		t.Fatalf("the chat of A's memory of makes at B: %+v (there: %v)", v, ok)
	}
	if v, ok := rp.ownView(t, inPlain); !ok || v.Archived {
		t.Fatalf("the chat A had an archive mark for, at B: %+v (there: %v)", v, ok)
	}
	if v, ok := rp.ownView(t, chat); !ok || v.Draft != nil || !v.Locked {
		t.Fatalf("the started chat at B: %+v (draft %+v, there: %v)", v, v.Draft, ok)
	}
	if th := rp.same(t, chat, "after both change-overs"); th.users(t, word) != 1 {
		t.Fatalf("the thread of the chat of before, through A: %s", joinThread(th))
	}
	// What became this computer's is not on B, and what is B's is no thing of this computer.
	rp.refused(t, http.StatusNotFound, "not_found", "GET", rp.on("/chats/"+oldChat), nil)
	rp.refused(t, http.StatusNotFound, "not_found", "GET", rp.on("/runs/"+oldRun), nil)
	rp.refused(t, http.StatusNotFound, "not_found", "GET", "/api/chats/"+chat, nil)
	rp.refused(t, http.StatusNotFound, "not_found", "GET", "/api/runs/"+run, nil)
	localPart("with B connected")
	changedOver(t, rp.a.home, list)
	if held := holders(folderFiles(t, rp.a.home), ofB); len(held) != 0 {
		t.Fatalf("with B connected, files of A's data folder hold something of B: %v", held)
	}
	thingsOfA := thingFiles(folderFiles(t, rp.a.home))
	if wantFiles := []string{"chats/" + oldChat + "/chat.json", "runs/" + oldRun + "/run.json"}; !slices.Equal(thingsOfA, wantFiles) {
		t.Fatalf("the files of chats, boards and runs in A's data folder: %v, want %v", thingsOfA, wantFiles)
	}

	// ---- afterwards: things are made in the section, and none is written on A -------------------
	const (
		typed     = "typed in the section after the update"
		newGoal   = "a goal typed in the section after the update"
		drawn     = "drawn-in-the-section"
		newBoard  = "board-made-from-the-app"
		newRunTxt = "Made from the app, a run"
	)
	bPage = rp.ownPage(t)
	pm, bm := rp.page.mark(), bPage.mark()
	var c model.ChatView
	rp.a.must(t, pairPage, "POST", rp.on("/chats"), map[string]any{"agent": "claude", "group": nested}, &c)
	rp.ok(t, "PATCH", rp.on("/chats/"+c.ID), map[string]any{"cwd": rp.work})
	rp.ok(t, "PUT", rp.on("/chats/"+c.ID+"/draft?rev=0"), map[string]any{"text": typed})
	if v, ok := rp.ownView(t, c.ID); !ok || v.Group != nested || v.Draft == nil || v.Draft.Text != typed {
		t.Fatalf("the new chat at B: %+v (draft %+v, there: %v)", v, v.Draft, ok)
	}
	var bd model.Board
	rp.a.must(t, pairPage, "POST", rp.on("/boards"), map[string]any{"name": newBoard, "group": plain}, &bd)
	if a := saveSceneAt(t, rp.a, pairPage, rp.on("/boards/"+bd.ID), 0, boardScene(drawn)); a.Status != http.StatusOK {
		t.Fatalf("the save of the new board's drawing: %s", a)
	}
	var r model.RunView
	rp.a.must(t, pairPage, "POST", rp.on("/runs"), map[string]any{"group": model.Ungrouped, "name": newRunTxt}, &r)
	if r.ID == "" || r.Status != model.RunDraft {
		t.Fatalf("the new run: %+v", r)
	}
	rp.ok(t, "PUT", rp.on("/runs/"+r.ID+"/draft"), map[string]any{"text": newGoal})
	// The draft is sent: the chat starts on B.
	rp.send(t, c.ID, typed)
	rp.turns(t, c.ID, 1)
	// B's own page was told of each, and so was A's page, with the entry as the server.
	for _, ev := range [][2]string{{"chat", c.ID}, {"board", bd.ID}, {"run", r.ID}} {
		bPage.awaitEvent(t, bm, 20*time.Second, ev[0], ev[1])
		rp.page.awaitEvent(t, pm, 20*time.Second, ev[0], rp.inSection(), ev[1])
	}
	more := []string{
		fmt.Sprintf("board %s %q in %q archived %v %q", bd.ID, newBoard, plain, false, ""),
		fmt.Sprintf("chat %s in %q on the board %q, on the run %q archived %v %q locked %v", c.ID, nested, "", "", false, "", true),
		fmt.Sprintf("run %s %q in %q %s archived %v %q", r.ID, newRunTxt, model.Ungrouped, model.RunDraft, false, ""),
	}
	eventually(t, 20*time.Second, "the section has the started chat, the board and the run with its goal", func() bool {
		tree := rp.tree(t)
		v, _ := rp.listed(t, c.ID)
		i := slices.IndexFunc(tree.Runs, func(x model.RunView) bool { return x.ID == r.ID })
		return v.Locked && i >= 0 && tree.Runs[i].Draft != nil && tree.Runs[i].Draft.Text == newGoal &&
			slices.ContainsFunc(tree.Boards, func(x model.Board) bool { return x.ID == bd.ID })
	})
	treeAsWanted("the section of "+pairName+" after the makes", level5Tree(rp.tree(t)), more...)
	treeAsWanted("B's own page after the makes", rp.ownTree(t), more...)
	localPart("after the makes in the section")

	// A's data folder gained no file of a chat, a board or a run, and holds nothing of what was
	// made, typed, drawn or sent: while it runs, and after it was stopped as a quit stops it.
	made4 := []string{c.ID, bd.ID, r.ID, typed, newGoal, drawn, newBoard, newRunTxt}
	folderOfA := func(when string) {
		t.Helper()
		files := folderFiles(t, rp.a.home)
		if held := holders(files, append(slices.Clone(ofB), made4...)); len(held) != 0 {
			t.Errorf("%s, files of A's data folder hold something of B: %v", when, held)
		}
		if got := thingFiles(files); !slices.Equal(got, thingsOfA) {
			t.Errorf("%s, the files of chats, boards and runs in A's data folder: %v, were %v", when, got, thingsOfA)
		}
		if _, err := os.Lstat(filepath.Join(rp.a.home, "remote")); !os.IsNotExist(err) {
			t.Errorf("%s, the folder remote/ of A: %v", when, err)
		}
		changedOver(t, rp.a.home, list)
	}
	folderOfA("while A runs")
	bPage.close()
	rp.page.close()
	rp.a.stop(t)
	folderOfA("after A was stopped")
	// B's has them all.
	rp.b.stop(t)
	if missing := notHeld(folderFiles(t, rp.b.home), made4); len(missing) != 0 {
		t.Fatalf("B's data folder holds no %v", missing)
	}
	if log := rp.a.out.String(); !strings.Contains(log, "are removed from "+rp.a.home) || !strings.Contains(log, "the chat "+oldChat) || !strings.Contains(log, "the run "+oldRun) {
		t.Errorf("A's output does not tell of the change-over:\n%s", log)
	}
}
