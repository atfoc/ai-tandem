package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
)

// A server that drops and comes back, with both halves real (goal 3.7, 3.8 and 3.9; contract
// 3.5, 3.6 and 3.7, and V1): a page of client 1 has a chat and a run view open and holds a
// board with an edit that is not saved, when the remote server is no longer reached. What the
// page shows meanwhile is its own matter; here it is told that the section has no tree, every
// call has its answer, and when the server is back the page reads again what it shows and the
// board's revision decides about the edit.

// bothRows is the table of a section's routes (sectionRows) for the things of the rig's remote
// server: its ids in the place of the stand-in's.
func bothRows(group, chat, run, board string) []sectionRow {
	fill := strings.NewReplacer(farChatA, chat, farRunA, run, farBoardA, board, "g_1", group, "g_2", group)
	rows := sectionRows()
	for i := range rows {
		rows[i].path, rows[i].body = fill.Replace(rows[i].path), fill.Replace(rows[i].body)
	}
	return rows
}

// stop stops the remote listener for real and waits until every client knows.
func (bo *both) stop() {
	bo.t.Helper()
	bo.fr.stop()
	for _, sd := range bo.c {
		sd.away()
	}
}

// start starts the remote listener again and waits until every client holds the tree anew.
func (bo *both) start() {
	bo.t.Helper()
	was := make([]int64, len(bo.c))
	for i, sd := range bo.c {
		was[i] = sd.ups.Load()
	}
	bo.fr.start(nil)
	for i, sd := range bo.c {
		sd.returned(was[i] + 1)
	}
}

// TestBothServerDropsAndComesBack: the remote server drops in two ways, by the link of client 1
// alone (client 2 and the owner work on) and by a real stop of its remote listener (every
// client is cut off, the owner works on), and comes back with the chat, the run and the board
// unchanged, changed there meanwhile, and deleted there meanwhile.
func TestBothServerDropsAndComesBack(t *testing.T) {
	t.Parallel()
	for _, how := range []string{"the link is cut", "the listener stops"} {
		for _, back := range []string{"unchanged", "changed", "deleted"} {
			t.Run(how+", "+back, func(t *testing.T) {
				t.Parallel()
				bothDrop(t, how == "the link is cut", back)
			})
		}
	}
}

func bothDrop(t *testing.T, cut bool, back string) {
	bo := newBoth(t, bothOpt{})
	c1, c2 := bo.c[0], bo.c[1]
	owner, p, q, r := bo.owner("O"), c1.page("P"), c1.page("Q"), c2.page("R")
	// Who works on the remote server while client 1 is cut off from it: the other client,
	// which a cut link leaves connected, or the owner, when the listener has stopped.
	other := r
	if !cut {
		other = owner
	}

	// ---- what client 1's page P has open: a chat that has started, a run that works, and a
	// board it holds and has saved once. A second run has not started.
	group := l5ID(t, p.want(t, 200, "POST", "/groups", obj{"name": "Work", "parent": ""}))
	chat := l5ID(t, p.want(t, 200, "POST", "/chats", obj{"agent": "claude", "group": group}))
	p.want(t, 200, "POST", "/chats/"+chat+"/messages", obj{"text": "the first message"})
	ag := bo.sp.of(t, chat)
	reply(t, &ag.fakeAgent, "the first answer", "point-1")
	run := l5ID(t, p.want(t, 200, "POST", "/runs", obj{"group": group, "name": "Run"}))
	p.want(t, 200, "POST", "/runs/"+run+"/start", obj{"goal": "Look around."})
	bo.orchestrator(p, run)
	fresh := l5ID(t, p.want(t, 200, "POST", "/runs", obj{"group": group, "name": "Not started"}))
	board := l5ID(t, p.want(t, 200, "POST", "/boards", obj{"name": "plan", "group": group}))
	c1.holders(board, "P", bothID1)
	c1.written(p.p, board, 0, drawing("saved before the drop"))
	chatPath, runPath, boardPath := "/chats/"+chat, "/runs/"+run, "/boards/"+board
	for _, rest := range []string{chatPath + "/items", chatPath + "/tree", runPath + "/detail"} {
		p.want(t, 200, "GET", rest, nil)
	}
	// Every page was sent all of it.
	for _, u := range []*user{owner, p, q, r} {
		u.upTo(t, "run", run, `"turns":1`)
	}
	bo.reach(owner, p, q, r)
	kept := drawing("drawn and not saved") // the edit in P's window, on the revision 1
	ids := []string{group, chat, run, fresh, board}

	// ---- the drop.
	if cut {
		c1.cut()
	} else {
		bo.stop()
	}
	// Every page of client 1 is told that the section has no tree.
	for _, u := range []*user{p, q} {
		if tree := u.sectionEvent(t); tree != "null" {
			t.Fatalf("the section event of %s at the drop has a tree: %s", u.who, tree)
		}
	}
	// A fresh snapshot has no key for the entry and nothing of that server, for a page that
	// was connected and for one that connects during the outage. The entry itself stays in the
	// list, not connected.
	nothing := func(what, state string) {
		t.Helper()
		snap := decode[struct {
			Sections map[string]json.RawMessage
			Servers  []servers.View
		}](t, state)
		if _, has := snap.Sections[c1.entry]; has || snap.Sections == nil {
			t.Errorf("%s has the sections %v", what, snap.Sections)
		}
		for _, id := range ids {
			if strings.Contains(state, id) {
				t.Errorf("%s holds %s of the server that is away", what, id)
			}
		}
		if i := slices.IndexFunc(snap.Servers, func(v servers.View) bool { return v.ID == c1.entry }); i < 0 || snap.Servers[i].State == servers.StateConnected {
			t.Errorf("%s has the servers %+v", what, snap.Servers)
		}
	}
	nothing("the state of a page during the outage", string(do(t, p.p, "GET", "/api/state", nil)))
	late := bridgetest.Connect(t, c1.a.url, "N")
	welcome, _ := json.Marshal(late.Welcome())
	nothing("the snapshot of a page that connects during the outage", string(welcome))
	n := &user{who: c1.who + "'s page N", p: late, sd: c1, entry: c1.entry, at: p.at}

	// Every route of a section has its answer (contract 3.5): 503 with the sentence that names
	// the server, but for the three that are answered here. Nothing is sent to that server.
	bo.untouched("the calls for a section whose server is not connected", func() {
		for _, row := range bothRows(group, chat, run, board) {
			rest, what := row.path, row.pattern+" while the server is away"
			if row.query != "" {
				rest += "?" + row.query
			}
			var body any
			if row.body != "" {
				body = row.body
			}
			status, out := q.call(row.method(), rest, body)
			switch {
			case strings.HasSuffix(row.path, "/unfollow"):
				if status != 200 || out != `{"ok":true}` {
					t.Errorf("%s: %d %s", what, status, out)
				}
			case strings.HasSuffix(row.path, "/release"):
				if status != 200 || out != `{"state":"none"}` {
					t.Errorf("%s, by a page that holds nothing: %d %s", what, status, out)
				}
			case strings.HasSuffix(row.path, "/reveal"):
				c1.refusal(what, 400, "not_here", status, []byte(out))
			default:
				if got := c1.refusal(what, 503, "server_unreachable", status, []byte(out)); got["error"] != c1.notConnected() {
					t.Errorf("%s: %s", what, out)
				}
			}
		}
		// The board: the holder's save is 503 and the page keeps holding it here; no other
		// window gets it.
		status, out := c1.write(p.p, board, 1, kept)
		c1.refusal("the holder's save while the server is away", 503, "server_unreachable", status, out)
		q.refused(t, 503, "server_unreachable", "POST", boardPath+"/take", nil)
		// Typed text is not taken either: the page keeps it in the open composer (goal 3.8).
		if text := p.refused(t, 503, "server_unreachable", "PUT", chatPath+"/draft?rev=0", obj{"text": "typed during the outage"}); text != c1.notConnected() {
			t.Errorf("a draft save while the server is away: %q", text)
		}
	})
	c1.holders(board, "P", "")

	// ---- what happens on that server meanwhile.
	switch back {
	case "changed":
		// A message in the chat, with its answer; the run renamed and the other one started;
		// and the board drawn on by someone else, so that its revision moved.
		other.want(t, 200, "POST", chatPath+"/messages", obj{"text": "sent meanwhile"})
		reply(t, &ag.fakeAgent, "answered meanwhile", "point-2")
		other.want(t, 200, "PATCH", runPath, obj{"name": "Renamed meanwhile"})
		other.want(t, 200, "POST", "/runs/"+fresh+"/start", obj{"goal": "Started meanwhile."})
		bo.orchestrator(other, fresh)
		if got := decode[struct {
			State string
			Rev   int64
		}](t, other.want(t, 200, "POST", boardPath+"/take", obj{"ifFree": true})); got.State != "held" || got.Rev != 1 {
			t.Fatalf("the take of the board by %s during the outage: %+v", other.who, got)
		}
		other.want(t, 200, "PUT", boardPath+"/scene?rev=1", drawing("drawn by another"))
		if !cut { // the owner lets the board go again; the other client keeps it
			other.want(t, 200, "POST", boardPath+"/release", nil)
		}
	case "deleted":
		bo.stopRun(other, run)
		for _, rest := range []string{chatPath, runPath, boardPath} {
			other.want(t, 200, "DELETE", rest, nil)
		}
	}
	want := owner.tree(t) // that server's tree as it is now

	// ---- the return.
	if cut {
		c1.mend()
	} else {
		bo.start()
	}
	// Every page is told the tree as it is now, the page that connected during the outage too.
	for _, u := range []*user{p, q, n} {
		tree := u.sectionEvent(t)
		if tree == "null" {
			t.Fatalf("the section event of %s at the return has no tree", u.who)
		}
		for _, f := range []string{"groups", "boards", "chats", "states", "runs", "defaults"} {
			if !l5SameList(t, tree, want, f) {
				t.Errorf("the %s of the tree %s is told at the return are\n%s\nand the remote server's\n%s", f, u.who, l5Field(t, tree, f), l5Field(t, want, f))
			}
		}
		l5Unmarked(t, "the tree at the return", tree)
	}
	tree := bo.level("after the return", owner, p, q, n)
	switch back {
	case "unchanged":
		for _, id := range ids {
			if !strings.Contains(tree, id) {
				t.Errorf("the tree after the return lacks %s", id)
			}
		}
	case "changed":
		for _, part := range []string{`"name":"Renamed meanwhile"`, `"id":"` + fresh + `"`, chat, board} {
			if !strings.Contains(tree, part) {
				t.Errorf("the tree after the return lacks %s: %s", part, tree)
			}
		}
		if v := decode[model.RunView](t, p.want(t, 200, "GET", "/runs/"+fresh, nil)); v.Status == model.RunDraft {
			t.Errorf("the run that was started meanwhile: %+v", v)
		}
	case "deleted":
		for _, id := range []string{chat, run, board} {
			if strings.Contains(tree, id) {
				t.Errorf("the tree after the return has %s, which was deleted: %s", id, tree)
			}
		}
	}

	if back == "deleted" {
		// The page reads again what it shows: each is gone there, with that server's answer.
		for _, c := range [][2]string{
			{"GET", chatPath}, {"GET", chatPath + "/items"}, {"GET", chatPath + "/tree"}, {"GET", runPath}, {"GET", runPath + "/detail"},
			{"GET", boardPath + "/scene"}, {"POST", boardPath + "/take"}, {"PUT", chatPath + "/draft?rev=0"}, {"PATCH", runPath},
		} {
			var body any
			if c[0] != "GET" {
				body = obj{"text": "typed during the outage", "name": "Late"}
			}
			p.refused(t, 404, "not_found", c[0], c[1], body)
		}
		// The board was the page's: it is told that it has lost it, and keeps the edit to itself.
		c1.until(p.p, "superseded", board)
		c1.holders(board, "", "")
		status, out := c1.write(p.p, board, 1, kept)
		c1.refusal("the save of the edit of a board that is gone", 409, "not_holder", status, out)
		return
	}

	// ---- the board: client 1's server takes it there again for the page that holds it here.
	switch {
	case back == "unchanged":
		// The same revision: the page saves the edit it kept.
		if ev := c1.until(p.p, "held", board); ev["rev"] != 1.0 {
			t.Fatalf("the grant at the return: %v", ev)
		}
		c1.holders(board, "P", bothID1)
		c1.written(p.p, board, 1, kept)
		bo.b.stored(board, kept, 2)
	case !cut:
		// Another revision: the owner drew meanwhile and let go. The page is told that server's
		// revision, and its edit on the old one is refused: the page drops it.
		if ev := c1.until(p.p, "held", board); ev["rev"] != 2.0 {
			t.Fatalf("the grant at the return, after the owner drew: %v", ev)
		}
		c1.holders(board, "P", bothID1)
		status, out := c1.write(p.p, board, 1, kept)
		if got := c1.refusal("the edit on the revision before the outage", 409, "stale", status, out); got["rev"] != 2.0 {
			t.Fatalf("the edit on the revision before the outage: %s", out)
		}
		bo.b.stored(board, drawing("drawn by another"), 2)
		c1.written(p.p, board, 2, drawing("drawn anew"))
	default:
		// Someone else holds it there, the other client: the page has lost the board and keeps
		// its edit until "Use here".
		c1.until(p.p, "superseded", board)
		c1.holders(board, "", bothID2)
		status, out := c1.write(p.p, board, 1, kept)
		c1.refusal("the save of the page that lost the board", 409, "not_holder", status, out)
		if state, _ := c1.take(p.p, board, true); state != "busy" {
			t.Fatalf("a take, if free, of the board the other client holds: %s", state)
		}
		if state, _ := c1.take(p.p, board, false); state != "waiting" {
			t.Fatalf("Use here: %s", state)
		}
		c2.until(r.p, "release_request", board)
		if got := c2.release(r.p, board); got != "handed" {
			t.Fatalf("the other client's release: %s", got)
		}
		if ev := c1.until(p.p, "held", board); ev["rev"] != 2.0 {
			t.Fatalf("the grant after Use here: %v", ev)
		}
		c1.holders(board, "P", bothID1)
		status, out = c1.write(p.p, board, 1, kept)
		c1.refusal("the edit on the revision before the outage", 409, "stale", status, out)
	}

	// ---- the chat and the run view. Nothing is followed until the page reads again: that
	// server forgot the follows with the stream. A message arrives meanwhile.
	bo.reach(p)
	owner.want(t, 200, "POST", chatPath+"/messages", obj{"text": "sent after the return"})
	if evs := bo.reach(p)[0]; len(only(evs, bothContent...)) != 0 || l5Count(evs, "chat", chat, `"working":`) == 0 {
		t.Errorf("before it read again, the page was sent %v", l5Types(evs))
	}
	// The page reads again what it shows, and is level with that server: the thread, the tree
	// and the run's detail are the ones the owner's page reads.
	for _, rest := range []string{chatPath, chatPath + "/items", chatPath + "/tree", runPath, runPath + "/detail"} {
		got, there := p.want(t, 200, "GET", rest, nil), owner.want(t, 200, "GET", rest, nil)
		if !l5Same(t, got, there) {
			t.Errorf("GET %s after the return: the page reads\n%s\nand the owner's page\n%s", rest, got, there)
		}
		if rest == chatPath+"/items" && (!strings.Contains(got, "sent after the return") || strings.Contains(got, "sent meanwhile") != (back == "changed")) {
			t.Errorf("the thread after the return: %s", got)
		}
	}
	// The reads follow again: what the agent answers now, and what the run does, reach the page.
	reply(t, &ag.fakeAgent, "answered after the return", "point-3")
	if evs := p.upTo(t, "chat_items", chat, "answered after the return"); l5Count(evs, "run_detail") != 0 {
		t.Errorf("the page was sent %v", l5Types(evs))
	}
	bo.stopRun(owner, run)
	p.upTo(t, "run_detail", run, `"status":"stopped"`)
	if back == "changed" {
		bo.stopRun(owner, fresh)
	}
	// Typed text is saved now, on the counter the page has.
	rev := decode[model.ChatView](t, p.want(t, 200, "GET", chatPath, nil)).DraftRev
	if out := p.want(t, 200, "PUT", chatPath+"/draft?rev="+itoa(int(rev)), obj{"text": "typed during the outage"}); !strings.Contains(out, `"ok":true`) {
		t.Errorf("the draft save after the return: %s", out)
	}
}

// After a restart of the local server during the outage nothing of that server is known until
// it connects (goal 3.7 and 3.12, D1; contract V1 and 3.6): the local server is built again on
// the folder of its server list while the link is cut. The entry is in the list, nothing else
// of the remote server is on disk or in a snapshot, and when the server is back the window,
// which kept its drawing and the revision it is based on, asks for the board itself: the same
// revision saves the edit, another one drops it.
func TestBothLocalServerIsRebuiltDuringTheOutage(t *testing.T) {
	t.Parallel()
	bo := newBoth(t, bothOpt{clients: 1, noRuns: true})
	c1, owner := bo.c[0], bo.owner("O")
	p := c1.page("P")
	group := l5ID(t, p.want(t, 200, "POST", "/groups", obj{"name": "Work", "parent": ""}))
	chat := l5ID(t, p.want(t, 200, "POST", "/chats", obj{"agent": "claude", "group": group}))
	p.want(t, 200, "PUT", "/chats/"+chat+"/draft?rev=0", obj{"text": "a draft of the remote chat"})
	// Two boards the window has open and has saved once: it holds the second, and lets the
	// first go for it, as a window that shows one board at a time.
	var boards [2]string
	for i := range boards {
		boards[i] = l5ID(t, p.want(t, 200, "POST", "/boards", obj{"name": "plan", "group": group}))
		c1.holders(boards[i], "P", bothID1)
		c1.written(p.p, boards[i], 0, drawing("saved before the drop"))
		if i == 0 {
			c1.release(p.p, boards[i])
		}
	}
	kept := drawing("drawn and not saved")
	ids := []string{group, chat, boards[0], boards[1], "a draft of the remote chat"}

	c1.cut()
	// The local server ends, and one is built on the same folder. Nothing of the remote server
	// is in a file of the folder of the list or of the data folder: the list alone names it.
	c1.m.Close()
	c1.rm.Close()
	for _, id := range ids {
		noFileHolds(t, c1.root, id)
		noFileHolds(t, c1.a.a.DataDir, id)
	}
	if _, err := os.Stat(filepath.Join(c1.root, "remote")); !os.IsNotExist(err) {
		t.Errorf("the folder of the list has a folder of the things of other servers: %v", err)
	}
	if entries, _ := os.ReadDir(c1.root); len(entries) != 1 || entries[0].Name() != servers.FileName {
		t.Errorf("the folder of the list holds %v, want the list alone", entries)
	}
	again := bo.rejoin(c1)
	if again.entry != c1.entry {
		t.Fatalf("the entry of the rebuilt server is %q, want %q", again.entry, c1.entry)
	}
	w := again.page("W") // the window's new stream
	state := string(do(t, w.p, "GET", "/api/state", nil))
	snap := decode[struct {
		Sections map[string]json.RawMessage
		Lists    map[string]json.RawMessage
		Servers  []servers.View
	}](t, state)
	if len(snap.Sections) != 0 || snap.Sections == nil || len(snap.Lists) != 0 {
		t.Errorf("the rebuilt server knows the sections %v and the lists %v", snap.Sections, snap.Lists)
	}
	if len(snap.Servers) != 2 || snap.Servers[1].ID != c1.entry || snap.Servers[1].Name != c1.name || snap.Servers[1].State == servers.StateConnected {
		t.Errorf("the servers of the rebuilt server: %+v", snap.Servers)
	}
	for _, id := range ids {
		if strings.Contains(state, id) {
			t.Errorf("the state of the rebuilt server holds %s", id)
		}
	}
	// Nothing of that server can be opened, made or changed, and the window gets no board.
	for _, c := range [][2]string{{"GET", "/chats/" + chat + "/items"}, {"POST", "/chats"}, {"POST", "/boards/" + boards[0] + "/take"}, {"GET", "/boards/" + boards[1] + "/scene"}} {
		if text := w.refused(t, 503, "server_unreachable", c[0], c[1], nil); text != again.notConnected() {
			t.Errorf("%s %s on the rebuilt server: %q", c[0], c[1], text)
		}
	}
	status, out := again.write(w.p, boards[1], 1, kept)
	again.refusal("a save on the rebuilt server while the remote server is away", 503, "server_unreachable", status, out)

	// The owner draws on the second board meanwhile; the first stays as it is.
	if state, rev := take(t, owner.p, boards[1], true); state != "held" || rev != 1 {
		t.Fatalf("the owner's take during the outage: %s at %d", state, rev)
	}
	written(t, owner.p, boards[1], 1, drawing("the owner's"))
	release(t, owner.p, boards[1])

	again.mend()
	if tree := w.sectionEvent(t); !strings.Contains(tree, chat) || !strings.Contains(tree, boards[0]) || !strings.Contains(tree, `"draft":{"text":"a draft of the remote chat"}`) {
		t.Fatalf("the tree at the return: %s", tree)
	}
	bo.level("after the return", owner, w)
	// The window asks for each board it has open. The first is at the revision the edit is
	// based on: the edit is saved.
	if state, rev := again.take(w.p, boards[0], true); state != "held" || rev != 1 {
		t.Fatalf("the window's take of the board that did not change: %s at %d", state, rev)
	}
	again.written(w.p, boards[0], 1, kept)
	bo.b.stored(boards[0], kept, 2)
	again.release(w.p, boards[0])
	// The second moved on: the edit on the old revision is refused, and the window drops it.
	if state, rev := again.take(w.p, boards[1], true); state != "held" || rev != 2 {
		t.Fatalf("the window's take of the board that changed: %s at %d", state, rev)
	}
	status, out = again.write(w.p, boards[1], 1, kept)
	if got := again.refusal("the edit on the revision before the outage", 409, "stale", status, out); got["rev"] != 2.0 {
		t.Fatalf("the edit on the revision before the outage: %s", out)
	}
	bo.b.stored(boards[1], drawing("the owner's"), 2)
}

// A drop in the middle of a call (goal 3.4, last bullet; contract 3.5): the remote server takes
// the call and its answer is lost with the connection. A message is 504 "send_unknown", since
// it may have arrived, and it has; any other call is 504 "no_answer"; and a chat that was made
// by a make whose answer was lost shows in the tree when the server is back, like anything
// else, and nothing deletes it.
func TestBothServerDropsInTheMiddleOfACall(t *testing.T) {
	t.Parallel()
	bo := newBoth(t, bothOpt{noRuns: true})
	c1, owner := bo.c[0], bo.owner("O")
	p, r := c1.page("P"), bo.c[1].page("R")
	group := l5ID(t, p.want(t, 200, "POST", "/groups", obj{"name": "Work", "parent": ""}))
	chat := l5ID(t, p.want(t, 200, "POST", "/chats", obj{"agent": "claude", "group": group}))
	type answer struct {
		status int
		out    string
	}
	// lost makes the call while the answers of the remote server wait on the link, cuts the
	// link once that server has done what arrived says, and returns what the page was answered.
	lost := func(method, rest string, body any, arrived func() bool) answer {
		t.Helper()
		c1.link.Stall(true, false)
		got := make(chan answer, 1)
		go func() {
			status, out := p.call(method, rest, body)
			got <- answer{status, out}
		}()
		c1.wait("the remote server has taken "+method+" "+rest, arrived)
		c1.cut()
		c1.link.Stall(false, false)
		select {
		case a := <-got:
			return a
		case <-time.After(waitLimit):
			t.Fatalf("%s %s was not answered after the drop", method, rest)
			return answer{}
		}
	}

	// returned mends the link, and returns the tree the page is told then.
	returned := func() string {
		t.Helper()
		if tree := p.sectionEvent(t); tree != "null" {
			t.Fatalf("the section event at the drop has a tree: %s", tree)
		}
		c1.mend()
		return p.sectionEvent(t)
	}

	// A message: the agent on that server has it, and the page is told that this is not known.
	a := lost("POST", "/chats/"+chat+"/messages", obj{"text": "sent into the drop"}, func() bool {
		return strings.Contains(owner.want(t, 200, "GET", "/chats/"+chat+"/items", nil), "sent into the drop")
	})
	if got := c1.refusal("a message whose answer was lost", 504, "send_unknown", a.status, []byte(a.out)); got["error"] != c1.name+" did not answer: it is not known whether the message arrived." {
		t.Errorf("a message whose answer was lost: %s", a.out)
	}
	if tree := returned(); !strings.Contains(tree, `"locked":true`) {
		t.Errorf("the tree at the return does not have the chat as started: %s", tree)
	}
	if thread := p.want(t, 200, "GET", "/chats/"+chat+"/items", nil); strings.Count(thread, "sent into the drop") != 1 {
		t.Errorf("the thread after the return: %s", thread)
	}
	if bo.sp.of(t, chat).sends.Load() != 1 {
		t.Errorf("the agent got the message %d times", bo.sp.of(t, chat).sends.Load())
	}

	// A make: the chat is made there, and the page is told that no answer came.
	chatsOf := func(u *user) (ids []string) {
		for _, v := range decode[struct{ Chats []model.ChatView }](t, u.tree(t)).Chats {
			ids = append(ids, v.ID)
		}
		return ids
	}
	a = lost("POST", "/chats", obj{"agent": "claude", "group": group}, func() bool { return len(chatsOf(owner)) == 2 })
	if got := c1.refusal("a make whose answer was lost", 504, "no_answer", a.status, []byte(a.out)); got["error"] != c1.name+" did not answer." {
		t.Errorf("a make whose answer was lost: %s", a.out)
	}
	made := chatsOf(owner)
	made = slices.DeleteFunc(made, func(id string) bool { return id == chat })
	asked := len(bo.fr.requests())
	// It shows in the section like anything else, in the group it was made in.
	if tree := returned(); !strings.Contains(tree, made[0]) {
		t.Errorf("the tree at the return lacks the chat that was made: %s", tree)
	}
	if v := decode[model.ChatView](t, p.want(t, 200, "GET", "/chats/"+made[0], nil)); v.Group != group || v.Locked {
		t.Errorf("the chat that was made: %+v", v)
	}
	// Any other call: a rename.
	a = lost("PATCH", "/chats/"+made[0], obj{"name": "Renamed into the drop"}, func() bool {
		return strings.Contains(owner.tree(t), "Renamed into the drop")
	})
	c1.refusal("a rename whose answer was lost", 504, "no_answer", a.status, []byte(a.out))
	returned()
	// No clean-up looks for the chat and nothing deletes it: it is there for everyone, and the
	// remote server was asked for no delete.
	if tree := bo.level("after the returns", owner, p, r); !strings.Contains(tree, made[0]) || !strings.Contains(tree, "Renamed into the drop") {
		t.Errorf("the tree after the returns: %s", tree)
	}
	for _, rq := range bo.fr.requests()[asked:] {
		if rq.Method == "DELETE" {
			t.Errorf("the remote server was asked %s %s", rq.Method, rq.Path)
		}
	}
}
