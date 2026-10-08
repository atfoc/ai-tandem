package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/linksim"
	"ai-whiteboard/internal/store"
)

// Remote boards between two real stacks in one process. B is a server with a remote listener
// (remoteEnv: the real ServeRemote over TLS); A is a server wired as the program wires it, with
// B as the one entry of its server list, a real servers.Manager and a real relay. The pages of
// both are stand-in pages on the real bridges, and B's agents are stand-ins. Nothing is scripted
// between the two: what A sends is what B's routes get. A's connections pass a link simulator,
// which a test cuts for an outage; B's listener stays as it is, on its port.

// pair is A and B.
type pair struct {
	t  *testing.T
	b  *env // B: the server the boards live on
	l  *listener
	sp *apiSpawner // B's agents

	a     *env // A: the user's own server
	m     *servers.Manager
	rm    *remotes.Relay
	entry string        // B in A's list
	root  string        // where A keeps its list and its records
	link  *linksim.Link // the way from A to B: cut, it ends A's connections and refuses new ones
	ups   atomic.Int64  // the snapshots of B that A's relay took
}

// newPair starts B and then A, and waits until A's relay has B's first snapshot. limits are the
// relay's, as for a far.
func newPair(t *testing.T, limits remotes.Limits) *pair {
	t.Helper()
	pr := &pair{t: t, sp: &apiSpawner{}}
	pr.b, pr.l = remoteEnv(t, withAgents(pr.sp))
	// A dials the link whatever the entry's address is, so the address, the pin and the Host of
	// its requests stay B's own.
	pr.link = linksim.Start(t, pr.l.host, linksim.Good)
	root := t.TempDir()
	pr.root = root
	if limits.Flush == 0 {
		limits.Flush = 20 * time.Millisecond
	}
	wire := func(s *Server) { // as newFar, and as startServers of cmd/ai-whiteboard
		// B's bridge sends no pings here, so a quiet stream is no dead one: the outages of
		// these tests are the link's alone.
		timing := farTiming()
		timing.Silence = 10 * time.Minute
		m, err := servers.Open(servers.Options{Root: root, LocalID: testLocalID, Version: "test", Notify: s.Bridge.Broadcast,
			Timing: timing, Dial: pr.link.Dial})
		if err != nil {
			t.Fatal(err)
		}
		v, saved, _, err := m.Add(context.Background(), servers.Input{
			Name: "Studio", Address: pr.l.base, Secret: testSecret, SelfSigned: true, Pin: pr.l.pin,
		}, true)
		if err != nil || !saved {
			t.Fatalf("the entry is not saved: %v", err)
		}
		rm, err := remotes.Open(remotes.Options{
			Root: root, Servers: m, Bridge: s.Bridge, Local: upCounter{s.App.Chats, &pr.ups},
			Group: s.App.GroupState, Limits: limits, Logf: t.Logf,
		})
		if err != nil {
			t.Fatal(err)
		}
		pr.m, pr.rm, pr.entry = m, rm, v.ID
		s.App.Chats.Servers = rm
		s.Servers, s.App.Servers = m, m
		s.Remotes, s.App.Remotes = rm, rm
		s.Bridge.OnUnfollowed(rm.Unfollowed)
		s.Bridge.OnBoardFree(rm.BoardFree)
		ownRev := s.Bridge.SceneRev
		s.Bridge.SceneRev = func(id string) int64 {
			if rev, ok := rm.BoardRev(id); ok {
				return rev
			}
			return ownRev(id)
		}
		rm.SetLocalBoards(func(id string) bool {
			_, ok := s.App.Boards.Get(id)
			return ok
		})
		m.SetHooks(rm.Hooks())
		t.Cleanup(func() { // the order of a shutdown
			m.Close()
			rm.Close()
		})
		m.Start()
	}
	pr.a = newEnv(t, wire)
	pr.returned(1)
	return pr
}

// wait waits for good.
func (pr *pair) wait(what string, good func() bool) {
	pr.t.Helper()
	for end := time.Now().Add(waitLimit); !good(); time.Sleep(2 * time.Millisecond) {
		if time.Now().After(end) {
			pr.t.Fatalf("waited in vain: %s", what)
		}
	}
}

// returned waits until A's relay has taken n snapshots of B.
func (pr *pair) returned(n int64) {
	pr.t.Helper()
	pr.wait("snapshot "+itoa(int(n))+" of B is taken", func() bool { return pr.ups.Load() >= n })
}

// cut cuts the link and waits until both ends know: A's entry is not connected, and B has no
// stream of A, so that nothing of A holds a board there.
func (pr *pair) cut() {
	pr.t.Helper()
	pr.link.Cut()
	pr.wait("A's entry is not connected", func() bool {
		v, _ := pr.m.View(pr.entry)
		return v.State != servers.StateConnected
	})
	pr.wait("B has no stream of A", func() bool { return !pr.b.s.Bridge.Known(testLocalID) })
}

// mend lets A reach B again and waits for the snapshot of the new stream.
func (pr *pair) mend() {
	pr.t.Helper()
	n := pr.ups.Load()
	pr.link.Uncut()
	pr.returned(n + 1)
}

// holders waits until the board is held by this page on A and by this client on B ("" = nobody).
func (pr *pair) holders(board, onA, onB string) {
	pr.t.Helper()
	var gotA, gotB string
	for end := time.Now().Add(waitLimit); ; time.Sleep(2 * time.Millisecond) {
		gotA, _ = pr.a.s.Bridge.HolderOf(board)
		gotB, _ = pr.b.s.Bridge.HolderOf(board)
		if gotA == onA && gotB == onB {
			return
		}
		if time.Now().After(end) {
			pr.t.Fatalf("the board %s is held by %q on A and %q on B, want %q and %q", board, gotA, gotB, onA, onB)
		}
	}
}

// event reads the page's events up to the next one of this type that is good, and returns it.
func (pr *pair) event(p *bridgetest.Page, typ string, good func(ev map[string]any) bool) map[string]any {
	pr.t.Helper()
	for end := time.Now().Add(waitLimit); time.Now().Before(end); {
		if ev := p.Next(); ev["type"] == typ && good(ev) {
			return ev
		}
	}
	pr.t.Fatalf("the page %s got no such %s event", p.ID, typ)
	return nil
}

// boardThere is the board as B has it.
func (pr *pair) boardThere(id string) model.Board {
	pr.t.Helper()
	bd, ok := pr.b.a.Boards.Get(id)
	if !ok {
		pr.t.Fatalf("B has no board %s", id)
	}
	return bd
}

// refusal checks a refused call of a page: the status and the code.
func (pr *pair) refusal(what string, want int, code string, status int, out []byte) map[string]any {
	pr.t.Helper()
	got := map[string]any{}
	json.Unmarshal(out, &got)
	if status != want || got["code"] != code {
		pr.t.Fatalf("%s: %d %s, want %d with the code %q", what, status, out, want, code)
	}
	return got
}

// create makes a board on B from A's page, in a group of A, and checks both ends.
func (pr *pair) create(p *bridgetest.Page, name string) (bd model.Board, group string) {
	pr.t.Helper()
	group = decode[obj](pr.t, string(do(pr.t, p, "POST", "/api/groups", obj{"name": "Work " + name, "parent": ""})))["id"].(string)
	bd = decode[model.Board](pr.t, string(do(pr.t, p, "POST", "/api/boards", obj{"name": name, "group": group, "server": pr.entry})))
	if bd.Name != name || bd.Group != group || bd.Server != pr.entry || bd.Client != "" {
		pr.t.Fatalf("the board A's page got: %+v", bd)
	}
	return bd, group
}

// boardChat makes a chat on the board from A's page and sends its first message, which starts
// it on B. The message goes with the <ui-context> the page puts in front of every message of a
// board chat, and B's thread has it. It returns the chat's id and the token of its agent on B.
func (pr *pair) boardChat(p *bridgetest.Page, board string) (chat, token string) {
	pr.t.Helper()
	cv := decode[model.ChatView](pr.t, string(do(pr.t, p, "POST", "/api/chats", obj{"agent": "claude", "board": board})))
	if cv.Board != board || cv.Server != pr.entry || cv.Locked {
		pr.t.Fatalf("the new chat on the board: %+v", cv)
	}
	ctx := "<ui-context>\nactive_board: the board (" + board + ")\nreferenced_boards: another (b_other001)\n</ui-context>"
	do(pr.t, p, "POST", "/api/chats/"+cv.ID+"/messages", obj{"text": "hello", "context": ctx})
	if _, items, _, err := pr.b.a.Chats.Items(cv.ID); err != nil || len(items) == 0 || items[0].Kind != "user" || items[0].Context != ctx {
		pr.t.Fatalf("the first message on B: %+v, %v", items, err)
	}
	metas := pr.b.a.Chats.ChatsOfBoard(board)
	if len(metas) != 1 || metas[0].ID != cv.ID || metas[0].Client != testLocalID || metas[0].Token == "" {
		pr.t.Fatalf("the chats of the board on B: %+v", metas)
	}
	return cv.ID, metas[0].Token
}

// TestBoardPair: a board of B, made and drawn on from A's pages. The cases follow one board
// through its life, in the order a user meets them.
func TestBoardPair(t *testing.T) {
	t.Parallel()
	pr := newPair(t, remotes.Limits{})
	a, b := pr.a, pr.b
	p := a.page("P")

	// ---- create: the board is B's, in B's "Remote" group, with A's mark; A keeps a record and
	// no drawing. The page that made it holds it, and so A holds it on B.
	bd, group := pr.create(p, "Untitled")
	id, path := bd.ID, "/api/boards/"+bd.ID
	there := pr.boardThere(id)
	if remote := b.remoteGroups(); len(remote) != 1 || there.Group != remote[0] || there.Client != testLocalID || there.Name != "Untitled" {
		t.Fatalf("the board on B: %+v, B's Remote groups %v", there, remote)
	}
	if !pr.rm.HasBoard(id) {
		t.Fatal("A has no record of the board")
	}
	if _, ok := a.a.Boards.Get(id); ok {
		t.Fatal("the board was made on A too")
	}
	if _, err := os.Stat(a.st.P.BoardFile(id)); !os.IsNotExist(err) {
		t.Fatalf("A has a drawing file of the board: %v", err)
	}
	if _, err := os.Stat(store.NewPaths(pr.root).RemoteBoardFile(id)); err != nil {
		t.Fatalf("A's record file: %v", err)
	}
	if _, err := os.Stat(b.st.P.BoardFile(id)); err != nil {
		t.Fatalf("B's drawing file: %v", err)
	}
	var snap struct{ Boards []model.Board }
	json.Unmarshal(do(t, p, "GET", "/api/state", nil), &snap)
	if len(snap.Boards) != 1 || snap.Boards[0].ID != id || snap.Boards[0].Server != pr.entry || snap.Boards[0].Group != group {
		t.Fatalf("the boards of A's snapshot: %+v", snap.Boards)
	}
	pr.holders(id, "P", testLocalID)
	// The creation again, as A repeats it after a lost answer: the same board, not made again.
	status, out := pr.l.call(testLocalID, testSecret, "PUT", path, `{"name":"Another name"}`)
	if again := decode[madeBoard](t, out); status != 200 || again.Made || again.Board.ID != id || again.Board.Name != "Untitled" {
		t.Fatalf("the repeated creation: %d %s", status, out)
	}

	// ---- hold chain. The page lets go: B is free. It takes: B's holder is A.
	if got := release(t, p, id); got != "free" {
		t.Fatalf("P's release: %s", got)
	}
	pr.holders(id, "", "")
	if state, rev := take(t, p, id, false); state != "held" || rev != 0 {
		t.Fatalf("P's take: %s at %d", state, rev)
	}
	pr.holders(id, "P", testLocalID)

	// ---- save: refused from a page of A that does not hold the board and at an old revision;
	// the holder's is stored on B.
	q := a.page("Q")
	status, raw := write(q, id, 0, drawing("Q's"))
	pr.refusal("the write of a page that does not hold the board", 409, "not_holder", status, raw)
	written(t, p, id, 0, drawing("P's first"))
	b.stored(id, drawing("P's first"), 1)
	status, raw = write(p, id, 0, drawing("on an old revision"))
	if got := pr.refusal("a write on an old revision", 409, "stale", status, raw); got["rev"] != 1.0 {
		t.Fatalf("a write on an old revision: %s", raw)
	}
	b.stored(id, drawing("P's first"), 1)
	if _, err := os.Stat(a.st.P.BoardFile(id)); !os.IsNotExist(err) {
		t.Fatalf("A has a drawing file of the board after a save: %v", err)
	}
	// A reads the drawing from B, with B's revision.
	resp, err := http.Get(a.url + path + "/scene")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get(SceneRevHeader) != "1" {
		t.Fatalf("A's read of the drawing: %d at revision %q", resp.StatusCode, resp.Header.Get(SceneRevHeader))
	}

	// ---- hold chain, two pages of A: the second one's take is A's own hand-off, at B's
	// revision, and changes nothing on B.
	if state, _ := take(t, q, id, false); state != "waiting" {
		t.Fatalf("Q's take of P's board: %s", state)
	}
	until(t, p, "release_request", id)
	if got := release(t, p, id); got != "handed" {
		t.Fatalf("P's release to Q: %s", got)
	}
	if ev := until(t, q, "held", id); ev["rev"] != 1.0 {
		t.Fatalf("Q's grant: %v, want B's revision 1", ev)
	}
	until(t, p, "superseded", id)
	pr.holders(id, "Q", testLocalID)
	written(t, q, id, 1, drawing("Q's"))
	// The holding page's stream ends: A lets the board go on B.
	q.Close()
	pr.holders(id, "", "")
	if state, rev := take(t, p, id, true); state != "held" || rev != 2 {
		t.Fatalf("P's take after Q left: %s at %d", state, rev)
	}
	pr.holders(id, "P", testLocalID)

	// ---- a chat made on the board from A is a chat of B on that board, and A's page gets it
	// under the board.
	chat, token := pr.boardChat(p, id)
	if metas := b.a.Chats.ChatsOfBoard(id); b.a.Chats.GroupOf(metas[0]) != there.Group {
		t.Fatalf("the chat's group on B is not the board's: %+v", metas[0])
	}
	var state struct{ Chats []model.ChatView }
	json.Unmarshal(do(t, p, "GET", "/api/state", nil), &state)
	if len(state.Chats) != 1 || state.Chats[0].ID != chat || state.Chats[0].Board != id || state.Chats[0].Server != pr.entry || !state.Chats[0].Locked {
		t.Fatalf("the chats of A's snapshot: %+v", state.Chats)
	}
	reply(t, &pr.sp.of(t, chat).fakeAgent, "an answer", "p1") // B's agent ends its turn: the chat's event reaches A's page
	ev := pr.event(p, "chat", func(ev map[string]any) bool {
		return field(ev, "chat", "id") == chat && field(ev, "chat", "status") == "ready"
	})
	if field(ev, "chat", "board") != id || field(ev, "chat", "server") != pr.entry {
		t.Fatalf("the chat's event on A's page: %v", ev)
	}

	// ---- tool call: a board tool of B's agent is answered by A's page.
	asked := make(chan map[string]any, 1)
	p.OnRPC(func(params map[string]any) (any, string) {
		asked <- params
		return "what P shows", ""
	})
	if text, isErr := b.tool(token, "read_board"); isErr || text != "what P shows" {
		t.Fatalf("the board tool: %q (error %v)", text, isErr)
	}
	if params := <-asked; params["board"] != id || params["name"] != "read_board" || params["chat"] != chat {
		t.Fatalf("the call P was asked: %v", params)
	}
	p.OnRPC(func(map[string]any) (any, string) { return nil, "the window is closed" })
	if text, isErr := b.tool(token, "read_board"); !isErr || !strings.Contains(text, "the window is closed") {
		t.Fatalf("the board tool, answered with an error: %q (error %v)", text, isErr)
	}
	p.OnRPC(nil)
	pr.holders(id, "P", testLocalID)

	// ---- outage. The page keeps the board on A; nothing of it is held on B. A save, a rename
	// and a delete are refused with 503 and change nothing; the group and the archive mark are
	// A's own matter.
	pr.cut()
	pr.holders(id, "P", "")
	kept := drawing("drawn while B was away")
	status, raw = write(p, id, 2, kept)
	pr.refusal("a write while B is unreachable", 503, "server_unreachable", status, raw)
	status, raw = p.Do("DELETE", path, nil)
	if got := pr.refusal("a delete while B is unreachable", 503, "server_unreachable", status, raw); got["error"] != "Studio is not connected." {
		t.Fatalf("a delete while B is unreachable: %s", raw)
	}
	status, raw = p.Do("POST", path+"/rename", obj{"name": "Renamed"})
	pr.refusal("a rename while B is unreachable", 503, "server_unreachable", status, raw)
	if !pr.rm.HasBoard(id) || pr.boardThere(id).Name != "Untitled" {
		t.Fatal("the refused calls changed the board")
	}
	b.stored(id, drawing("Q's"), 2)

	// ---- return at the same revision: A takes the board again for its page, which is told the
	// revision; it is the one the edit was made on, so the page saves, and the edit is on B.
	pr.mend()
	if ev := until(t, p, "held", id); ev["rev"] != 2.0 {
		t.Fatalf("P's grant at the return: %v", ev)
	}
	pr.holders(id, "P", testLocalID)
	written(t, p, id, 2, kept)
	b.stored(id, kept, 3)

	// ---- return at another revision: B's own page drew meanwhile. A's page is told the new
	// revision, and its edit on the old one is refused: the page drops it.
	bp := b.page("BP")
	pr.cut()
	if state, rev := take(t, bp, id, true); state != "held" || rev != 3 {
		t.Fatalf("the take of B's page during the outage: %s at %d", state, rev)
	}
	written(t, bp, id, 3, drawing("B's own"))
	if got := release(t, bp, id); got != "free" {
		t.Fatalf("the release of B's page: %s", got)
	}
	pr.mend()
	if ev := until(t, p, "held", id); ev["rev"] != 4.0 {
		t.Fatalf("P's grant at the return, after B's page drew: %v", ev)
	}
	pr.holders(id, "P", testLocalID)
	status, raw = write(p, id, 3, drawing("drawn on the old revision"))
	if got := pr.refusal("the edit on the revision before the outage", 409, "stale", status, raw); got["rev"] != 4.0 {
		t.Fatalf("the edit on the revision before the outage: %s", raw)
	}
	b.stored(id, drawing("B's own"), 4)

	// ---- "Use here" on B: A's page is asked to let go, saves, lets go, and has lost the board.
	if state, _ := take(t, bp, id, true); state != "busy" {
		t.Fatalf("the take, if free, of B's page: %s", state)
	}
	if state, _ := take(t, bp, id, false); state != "waiting" {
		t.Fatalf("the take of B's page: %s", state)
	}
	until(t, p, "release_request", id)
	written(t, p, id, 4, drawing("P's last"))
	if got := release(t, p, id); got != "handed" {
		t.Fatalf("P's release to B's page: %s", got)
	}
	until(t, p, "superseded", id)
	if ev := until(t, bp, "held", id); ev["rev"] != 5.0 {
		t.Fatalf("the grant of B's page: %v", ev)
	}
	pr.holders(id, "", "BP")
	status, raw = write(p, id, 5, drawing("late"))
	pr.refusal("P's write after it lost the board", 409, "not_holder", status, raw)
	// And back: A's page takes it from B's page, which lets go.
	if state, _ := take(t, p, id, false); state != "waiting" {
		t.Fatalf("P's take of the board of B's page: %s", state)
	}
	until(t, bp, "release_request", id)
	if got := release(t, bp, id); got != "handed" {
		t.Fatalf("the release of B's page to A: %s", got)
	}
	if ev := until(t, p, "held", id); ev["rev"] != 5.0 {
		t.Fatalf("P's grant from B's page: %v", ev)
	}
	pr.holders(id, "P", testLocalID)
	if got := release(t, p, id); got != "free" {
		t.Fatalf("P's last release: %s", got)
	}
	pr.holders(id, "", "")

	// ---- rename and archive pass through.
	if got := decode[model.Board](t, string(do(t, p, "POST", path+"/rename", obj{"name": "Plans"}))); got.Name != "Plans" || got.Server != pr.entry || got.Group != group {
		t.Fatalf("the renamed board: %+v", got)
	}
	if got := pr.boardThere(id); got.Name != "Plans" {
		t.Fatalf("the board on B after the rename: %+v", got)
	}
	do(t, p, "POST", path+"/archive", nil)
	pr.wait("the board is archived on B", func() bool { return pr.boardThere(id).Archived })
	do(t, p, "POST", path+"/unarchive", nil)
	pr.wait("the board is no longer archived on B", func() bool { return !pr.boardThere(id).Archived })

	// ---- delete when connected: the board is gone on B, and A's record with it.
	do(t, p, "DELETE", path, nil)
	if _, ok := b.a.Boards.Get(id); ok || pr.rm.HasBoard(id) {
		t.Fatalf("after the delete: on B %v, A's record %v", ok, pr.rm.HasBoard(id))
	}
	pr.event(p, "board_removed", func(ev map[string]any) bool { return ev["id"] == id })
	if len(b.a.Chats.ChatsOfBoard(id)) != 0 || pr.rm.Has(chat) {
		t.Fatal("the board's chat outlived the board")
	}
}

// The limit of a passed-on tool call: A's page does not answer, and B's agent has A's answer
// well before B's own wait of 30 seconds is over.
func TestBoardPairToolCallLimit(t *testing.T) {
	t.Parallel()
	const limit = 400 * time.Millisecond
	pr := newPair(t, remotes.Limits{BoardCall: limit})
	p := pr.a.page("P")
	bd, _ := pr.create(p, "Untitled")
	pr.holders(bd.ID, "P", testLocalID)
	_, token := pr.boardChat(p, bd.ID)

	start := time.Now()
	text, isErr := pr.b.tool(token, "read_board")
	if waited := time.Since(start); !isErr || !strings.Contains(text, "the board's window did not answer in "+limit.String()) || waited < limit || waited > 20*time.Second {
		t.Fatalf("the board tool that no page answers: %q (error %v) after %v", text, isErr, waited)
	}
	ev := pr.event(p, "rpc", func(map[string]any) bool { return true })
	if id, _ := ev["id"].(string); !strings.HasPrefix(id, "far_") {
		t.Fatalf("the call P was sent: %v", ev)
	} else if status, out := p.Do("POST", "/api/rpc-reply", obj{"id": id, "result": "late"}); status != 409 || !strings.Contains(string(out), "not_asked") {
		t.Fatalf("P's late answer: %d %s", status, out)
	}
	pr.holders(bd.ID, "P", testLocalID)
}
