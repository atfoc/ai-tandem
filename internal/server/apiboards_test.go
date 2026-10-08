package server

import (
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// The boards of an API client on the remote listener: the real ServeRemote, stand-in API clients
// and stand-in pages, as in apiclient_test.go.

// Board ids as a client makes them.
const (
	board1 = "b_aaaa1111"
	board2 = "b_bbbb2222"
)

// isBoardRoute reports whether the route of the table is one of the eleven that level 2 added.
func isBoardRoute(route string) bool {
	return strings.Contains(route, " /api/boards/") || route == "POST /api/rpc-reply"
}

type madeBoard struct {
	OK    bool        `json:"ok"`
	Made  bool        `json:"made"`
	Board model.Board `json:"board"`
	Error string      `json:"error"`
	Code  string      `json:"code"`
}

// makeBoard is the client's creation of the board id, which must be answered with this status.
func makeBoard(t *testing.T, c *bridgetest.Page, want int, id string, body any) madeBoard {
	t.Helper()
	status, out := c.Do("PUT", "/api/boards/"+id, body)
	if status != want {
		t.Fatalf("the creation of the board %s by %s: status %d, want %d (%s)", id, c.ID, status, want, out)
	}
	return decode[madeBoard](t, string(out))
}

// noBoard fails unless the answer is the gate's: 404 and nothing but "no such board".
func noBoard(t *testing.T, what string, status int, out []byte) {
	t.Helper()
	if status != 404 || strings.TrimSpace(string(out)) != `{"error":"no such board"}` {
		t.Errorf("%s: %d %s, want 404 no such board", what, status, out)
	}
}

// Every board route of the table, for the client that made the board.
func TestBoardRoutesOfAnAPIClient(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	x, _ := l.api(apiX)
	y, _ := l.api(apiY)
	called := map[string]bool{}
	call := func(want int, route string, body any) obj {
		t.Helper()
		if !slices.Contains(RemoteRoutes, route) {
			t.Fatalf("%s is no route of the table", route)
		}
		called[route] = true
		method, p, _ := strings.Cut(route, " ")
		status, out := x.Do(method, strings.Replace(p, "{id}", board1, 1), body)
		if status != want {
			t.Fatalf("%s: status %d, want %d (%s)", route, status, want, out)
		}
		return decode[obj](t, string(out))
	}

	// The creation: in the group "Remote", with the caller's mark, held by nobody.
	called["PUT /api/boards/{id}"] = true
	first := makeBoard(t, x, 200, board1, obj{"name": "Untitled", "id": board1})
	groups := e.remoteGroups()
	if !first.OK || !first.Made || first.Board.ID != board1 || first.Board.Name != "Untitled" || first.Board.Client != apiX ||
		len(groups) != 1 || first.Board.Group != groups[0] || first.Board.New {
		t.Fatalf("the creation: %+v, the Remote groups %v", first, groups)
	}
	e.holder(board1, "")
	// A repeat finds the board, its name untouched.
	if again := makeBoard(t, x, 200, board1, obj{"name": "Other"}); !again.OK || again.Made || again.Board.Name != "Untitled" || again.Board.Client != apiX {
		t.Fatalf("the repeat: %+v", again)
	}
	// Another client's creation with the id, and one with the id of a board of the server's own.
	if got := makeBoard(t, y, 409, board1, obj{"name": "Untitled"}); got.Code != "id_taken" || got.Error == "" {
		t.Fatalf("Y's creation with X's id: %+v", got)
	}
	own := e.board(model.Ungrouped)
	if got := makeBoard(t, x, 409, own.ID, obj{"name": "Untitled"}); got.Code != "id_taken" {
		t.Fatalf("the creation with the id of the server's own board: %+v", got)
	}
	// What is refused before anything is made.
	for what, c := range map[string]struct {
		id   string
		body any
		code string
	}{
		"an id of another form":    {"b_SHOUTING", obj{"name": "n"}, "bad_id"},
		"an id that is too short":  {"b_abc", obj{"name": "n"}, "bad_id"},
		"an id that is not a b_":   {"c_aaaa1111", obj{"name": "n"}, "bad_id"},
		"another id in the body":   {board2, obj{"name": "n", "id": board1}, "bad_id"},
		"a group":                  {board2, obj{"name": "n", "group": model.Ungrouped}, "group_refused"},
		"a name with a slash":      {board2, obj{"name": "a/b"}, "bad_request"},
		"a name that is too long":  {board2, obj{"name": strings.Repeat("n", 81)}, "bad_request"},
		"a body that is no object": {board2, "nothing", "bad_request"},
	} {
		if got := makeBoard(t, x, 400, c.id, c.body); got.Code != c.code || got.Error == "" || got.OK {
			t.Errorf("%s: %+v, want the code %s", what, got, c.code)
		}
	}
	if n := len(e.a.Boards.List()); n != 2 || len(e.remoteGroups()) != 1 {
		t.Fatalf("%d boards and the Remote groups %v after the refused creations", n, e.remoteGroups())
	}
	// The route is the remote listener's alone.
	if status, out := e.do("PUT", "/api/boards/"+board2, `{"name":"n"}`); status != 404 || strings.TrimSpace(out) != `{"error":"not found"}` {
		t.Fatalf("the creation on the loopback listener: %d %s", status, out)
	}

	// The snapshot and the state hold the client's boards, and no other client's.
	for who, c := range map[string]*bridgetest.Page{apiX: x, apiY: y} {
		_, state := c.Do("GET", "/api/state", nil)
		got := decode[struct{ Boards []model.Board }](t, string(state))
		if who == apiX && (len(got.Boards) != 1 || got.Boards[0].ID != board1 || got.Boards[0].Client != apiX) {
			t.Fatalf("X's state: %s", state)
		}
		if who == apiY && (got.Boards == nil || len(got.Boards) != 0 || strings.Contains(string(state), board1)) {
			t.Fatalf("Y's state: %s", state)
		}
	}
	if _, snap := l.api(apiZ); !strings.Contains(snap, `"boards":[]`) {
		t.Fatalf("Z's snapshot: %s", snap)
	}

	// The drawing: a write needs the hold and the revision it is based on.
	scene := func() (string, string) {
		t.Helper()
		called["GET /api/boards/{id}/scene"] = true
		req, _ := http.NewRequest("GET", l.base+"/api/boards/"+board1+"/scene", nil)
		req.Header.Set(SecretHeader, testSecret)
		req.Header.Set(ClientHeader, apiX)
		resp, err := l.http.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			t.Fatalf("the read of the drawing: %d %s", resp.StatusCode, b)
		}
		return string(b), resp.Header.Get("X-AIWB-Scene-Rev")
	}
	if _, rev := scene(); rev != "0" {
		t.Fatalf("the revision of a new board: %q", rev)
	}
	const write = "PUT /api/boards/{id}/scene"
	writeAt := func(want int, rev string, body string) obj {
		t.Helper()
		called[write] = true
		status, out := x.Do("PUT", "/api/boards/"+board1+"/scene"+rev, body)
		if status != want {
			t.Fatalf("the write with %q: status %d, want %d (%s)", rev, status, want, out)
		}
		return decode[obj](t, string(out))
	}
	if got := writeAt(409, "?rev=0", drawing("early")); got["code"] != "not_holder" {
		t.Fatalf("a write without the hold: %v", got)
	}
	if got := call(200, "POST /api/boards/{id}/take", obj{"ifFree": true}); got["state"] != "held" || got["rev"] != 0.0 {
		t.Fatalf("the take: %v", got)
	}
	e.holder(board1, apiX)
	if got := writeAt(200, "?rev=0", drawing("one")); got["ok"] != true || got["rev"] != 1.0 {
		t.Fatalf("the write: %v", got)
	}
	if got := writeAt(409, "?rev=0", drawing("old")); got["code"] != "stale" || got["rev"] != 1.0 {
		t.Fatalf("a write on an old revision: %v", got)
	}
	if got := writeAt(400, "", drawing("x")); got["error"] != "rev is missing" {
		t.Fatalf("a write without a revision: %v", got)
	}
	if got := writeAt(400, "?rev=one", drawing("x")); got["error"] != "rev is not a number" {
		t.Fatalf("a write with a revision that is no number: %v", got)
	}
	writeAt(400, "?rev=1", "{not json")
	if body, rev := scene(); body != drawing("one") || rev != "1" {
		t.Fatalf("the drawing after the writes: revision %q, %s", rev, body)
	}
	e.onDisk(board1, drawing("one"))

	// The rest of the board's routes.
	if got := call(200, "POST /api/boards/{id}/rename", obj{"name": "Plan"}); got["name"] != "Plan" || got["id"] != board1 || got["client"] != apiX {
		t.Fatalf("the rename: %v", got)
	}
	if got := call(200, "POST /api/boards/{id}/seen", nil); got["ok"] != true {
		t.Fatalf("seen: %v", got)
	}
	if got := call(200, "POST /api/boards/{id}/release", nil); got["state"] != "free" {
		t.Fatalf("the release: %v", got)
	}
	if got := call(200, "POST /api/boards/{id}/release", nil); got["state"] != "none" {
		t.Fatalf("a second release: %v", got)
	}
	if got := call(200, "POST /api/boards/{id}/archive", nil); got["ok"] != true {
		t.Fatalf("the archive: %v", got)
	}
	if bd, _ := e.a.Boards.Get(board1); !bd.Archived {
		t.Fatal("the board is not archived")
	}
	call(409, "POST /api/boards/{id}/take", nil)
	writeAt(409, "?rev=1", drawing("archived"))
	call(200, "POST /api/boards/{id}/unarchive", nil)
	if got := call(200, "POST /api/boards/{id}/take", nil); got["state"] != "held" || got["rev"] != 1.0 {
		t.Fatalf("the take after the unarchive: %v", got)
	}
	// An answer to a call nobody asked of the client.
	if got := call(409, "POST /api/rpc-reply", obj{"id": "rpc_99", "result": "x"}); got["error"] != "not_asked" || len(got) != 1 {
		t.Fatalf("an answer that was not asked for: %v", got)
	}
	// A take needs an open stream: Z's own board, taken by a Z whose stream has ended.
	z := bridgetest.ConnectWith(t, l.base, apiZ, l.options(apiZ, testSecret))
	makeBoard(t, z, 200, board2, obj{"name": "Z"})
	z.Close()
	deadline := time.Now().Add(10 * time.Second)
	for {
		status, out := l.call(apiZ, testSecret, "POST", "/api/boards/"+board2+"/take", "")
		if status == 409 && strings.TrimSpace(out) == `{"error":"unknown_client"}` {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("a take with no open stream: %d %s", status, out)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// The delete, of a board nobody holds: a holder would be given its three seconds to let go.
	call(200, "POST /api/boards/{id}/release", nil)
	if got := call(200, "DELETE /api/boards/{id}", nil); got["ok"] != true {
		t.Fatalf("the delete: %v", got)
	}
	if _, found := e.a.Boards.Get(board1); found {
		t.Fatal("the board is still there after the delete")
	}
	e.holder(board1, "")
	for _, route := range RemoteRoutes {
		if isBoardRoute(route) && !called[route] {
			t.Errorf("the route %s of the table was not called", route)
		}
	}
	// What the table does not serve to an API client.
	for _, r := range [][2]string{{"POST", "/api/boards"}, {"PATCH", "/api/boards/" + board2}, {"POST", "/api/boards/" + board2 + "/reveal"}, {"POST", "/api/client/flushed"}} {
		if status, out := x.Do(r[0], r[1], obj{"name": "n", "group": model.Ungrouped}); status != 404 || strings.TrimSpace(string(out)) != `{"error":"not found"}` {
			t.Errorf("%s %s: %d %s, want 404 not found", r[0], r[1], status, out)
		}
	}
}

// A creation that is refused or repeated asks for no group "Remote": only one that makes a board
// does.
func TestRefusedOrRepeatedCreationMakesNoRemoteGroup(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	x, _ := l.api(apiX)
	own := e.board(model.Ungrouped)
	if got := makeBoard(t, x, 409, own.ID, obj{"name": "Untitled"}); got.Code != "id_taken" {
		t.Fatalf("the creation with the id of the server's own board: %+v", got)
	}
	if got := makeBoard(t, x, 400, "b_SHOUTING", obj{"name": "n"}); got.Code != "bad_id" {
		t.Fatalf("the creation with a bad id: %+v", got)
	}
	if groups := e.remoteGroups(); len(groups) != 0 {
		t.Fatalf("the refused creations made the Remote groups %v", groups)
	}

	first := makeBoard(t, x, 200, board1, obj{"name": "Untitled"})
	groups := e.remoteGroups()
	if !first.Made || len(groups) != 1 || first.Board.Group != groups[0] {
		t.Fatalf("the creation: %+v, the Remote groups %v", first, groups)
	}
	// The owner archives the group: a repeat finds the board where it is, and so does a refusal.
	e.expect(200, "POST", "/api/groups/"+groups[0]+"/archive", "")
	if again := makeBoard(t, x, 200, board1, obj{"name": "Other"}); !again.OK || again.Made || again.Board.ID != board1 ||
		again.Board.Name != "Untitled" || again.Board.Group != groups[0] {
		t.Fatalf("the repeat after the group was archived: %+v", again)
	}
	y, _ := l.api(apiY)
	if got := makeBoard(t, y, 409, board1, obj{"name": "Untitled"}); got.Code != "id_taken" {
		t.Fatalf("Y's creation with X's id: %+v", got)
	}
	if got := e.remoteGroups(); len(got) != 1 {
		t.Fatalf("the Remote groups after the repeat: %v, want the one %v", got, groups)
	}
	// A free id makes the board, in a new group "Remote".
	if second := makeBoard(t, x, 200, board2, obj{"name": "Untitled"}); !second.Made || len(e.remoteGroups()) != 2 || second.Board.Group == groups[0] {
		t.Fatalf("the creation after the group was archived: %+v, the Remote groups %v", second, e.remoteGroups())
	}
}

// An API client reaches only the boards with its mark: a board of the server's own, one of
// another client and one that is not there are answered alike, and nothing is done to them.
func TestBoardGateOfAnAPIClient(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	p := e.page("P")
	x, _ := l.api(apiX)
	y, _ := l.api(apiY)
	own := newBoard(t, p, "own") // P holds it
	written(t, p, own.ID, 0, drawing("the owner's"))
	makeBoard(t, y, 200, board1, obj{"name": "Y"})
	if state, _ := take(t, y, board1, false); state != "held" {
		t.Fatalf("Y's take: %s", state)
	}
	written(t, y, board1, 0, drawing("Y's"))
	e.reach(p, x, y)

	for _, id := range []string{own.ID, board1, "b_zzzz9999"} {
		for _, route := range RemoteRoutes {
			if !strings.Contains(route, " /api/boards/") || route == "PUT /api/boards/{id}" {
				continue
			}
			method, path, _ := strings.Cut(route, " ")
			path = strings.Replace(path, "{id}", id, 1)
			if strings.HasSuffix(path, "/scene") && method == "PUT" {
				path += "?rev=1"
			}
			status, out := x.Do(method, path, obj{"name": "taken", "ifFree": false})
			noBoard(t, route+" of "+id, status, out)
		}
	}
	e.holder(own.ID, "P")
	e.holder(board1, apiY)
	e.onDisk(own.ID, drawing("the owner's"))
	e.onDisk(board1, drawing("Y's"))
	for _, id := range []string{own.ID, board1} {
		if bd, found := e.a.Boards.Get(id); !found || bd.Archived || bd.Name == "taken" {
			t.Errorf("the board %s after X's calls: %+v (found %v)", id, bd, found)
		}
	}
	if evs := e.reach(p, x, y); len(evs[0])+len(evs[1])+len(evs[2]) != 0 {
		t.Errorf("the refused calls sent %v", evs)
	}
	// The holder of the board is not asked to let go, and its own calls are served.
	written(t, y, board1, 1, drawing("Y's next"))
	written(t, p, own.ID, 1, drawing("the owner's next"))
}

// A board's events reach the pages and, of the API clients, the one whose mark the board has.
func TestBoardEventsReachTheMarkOnly(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	p := e.page("P")
	x, _ := l.api(apiX)
	y, _ := l.api(apiY)
	e.reach(p, x, y)
	sent := func(what, typ string, toP, toX, toY int) {
		t.Helper()
		evs := e.reach(p, x, y)
		apiOnly(t, x, evs[1])
		apiOnly(t, y, evs[2])
		if got := []int{count(evs[0], typ), count(evs[1], typ), count(evs[2], typ)}; !slices.Equal(got, []int{toP, toX, toY}) {
			t.Errorf("%s: %s reached the page, X and Y %v times, want %v", what, typ, got, []int{toP, toX, toY})
		}
		if len(only(evs[2], "board", "board_removed", "held", "superseded", "release_request")) != 0 {
			t.Errorf("%s: Y was sent %v", what, types(evs[2]))
		}
	}
	makeBoard(t, x, 200, board1, obj{"name": "X"})
	sent("X's creation", "board", 1, 1, 0)
	makeBoard(t, x, 200, board1, obj{"name": "X"})
	sent("the repeat", "board", 0, 0, 0)
	// The owner's page works on the marked board as on any: X is told.
	e.expect(200, "POST", "/api/boards/"+board1+"/rename", `{"name":"by the page"}`)
	sent("the page's rename", "board", 1, 1, 0)
	do(t, x, "POST", "/api/boards/"+board1+"/rename", obj{"name": "by X"})
	sent("X's rename", "board", 1, 1, 0)
	e.expect(200, "POST", "/api/boards/"+board1+"/archive", "")
	sent("the page's archive", "board", 1, 1, 0)
	do(t, x, "POST", "/api/boards/"+board1+"/unarchive", nil)
	sent("X's unarchive", "board", 1, 1, 0)
	// A board of the server's own: no API client.
	own := e.board(model.Ungrouped)
	e.expect(200, "POST", "/api/boards/"+own.ID+"/rename", `{"name":"mine"}`)
	sent("the owner's board", "board", 2, 0, 0)
	e.expect(200, "DELETE", "/api/boards/"+own.ID, "")
	sent("the delete of the owner's board", "board_removed", 1, 0, 0)
	e.expect(200, "DELETE", "/api/boards/"+board1, "")
	sent("the page's delete of X's board", "board_removed", 1, 1, 0)
	// The id is free again, and the mark went with the board: Y's board of that id is Y's.
	makeBoard(t, y, 200, board1, obj{"name": "Y"})
	evs := e.reach(p, x, y)
	if count(evs[0], "board") != 1 || len(evs[1]) != 0 || count(evs[2], "board") != 1 {
		t.Errorf("Y's board with the id X's had: the page %v, X %v, Y %v", types(evs[0]), types(evs[1]), types(evs[2]))
	}
}

// A page of the server takes a board an API client holds ("Use here"): the client is asked to
// let go and loses the board, by its release or when its time is over. It takes the board back
// the same way.
func TestPageTakesTheBoardOfAnAPIClient(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	// The hand-off waits ten seconds for an API client; the test waits it out once.
	const delay = 300 * time.Millisecond
	e.s.Bridge.SetHandoverDelay(delay)
	p := e.page("P")
	x, _ := l.api(apiX)
	makeBoard(t, x, 200, board1, obj{"name": "X"})
	if state, rev := take(t, x, board1, true); state != "held" || rev != 0 {
		t.Fatalf("X's take: %s at %d", state, rev)
	}
	written(t, x, board1, 0, drawing("X's"))

	// A take that leaves a held board where it is.
	if state, _ := take(t, p, board1, true); state != "busy" {
		t.Fatalf("the page's take if free: %s", state)
	}
	// X does not answer: the page has the board when X's time is over.
	start := time.Now()
	if state, _ := take(t, p, board1, false); state != "waiting" {
		t.Fatalf("the page's take: %s", state)
	}
	until(t, x, "release_request", board1)
	if ev := until(t, p, "held", board1); ev["rev"] != 1.0 {
		t.Fatalf("the page's grant: %v", ev)
	}
	if waited := time.Since(start); waited < delay {
		t.Fatalf("the grant came after %v, before the client's time was over", waited)
	}
	until(t, x, "superseded", board1)
	e.holder(board1, "P")
	// X's late write is refused; the page's is stored.
	status, out := write(x, board1, 1, drawing("late"))
	refused(t, "X's write after it lost the board", "not_holder", status, out)
	written(t, p, board1, 1, drawing("the page's"))

	// X takes it back, and the page lets go when asked.
	if state, _ := take(t, x, board1, false); state != "waiting" {
		t.Fatalf("X's take of the page's board: %s", state)
	}
	until(t, p, "release_request", board1)
	if got := release(t, p, board1); got != "handed" {
		t.Fatalf("the page's release: %s", got)
	}
	if ev := until(t, x, "held", board1); ev["rev"] != 2.0 {
		t.Fatalf("X's grant: %v", ev)
	}
	e.holder(board1, apiX)
	written(t, x, board1, 2, drawing("X's again"))

	// The page asks again and X lets go at once.
	if state, _ := take(t, p, board1, false); state != "waiting" {
		t.Fatalf("the page's second take: %s", state)
	}
	until(t, x, "release_request", board1)
	if got := release(t, x, board1); got != "handed" {
		t.Fatalf("X's release: %s", got)
	}
	if ev := until(t, p, "held", board1); ev["rev"] != 3.0 {
		t.Fatalf("the page's second grant: %v", ev)
	}
	e.holder(board1, "P")
}

// An agent's board tool on a chat of a marked board is asked of the API client that holds the
// board, and answered through POST /api/rpc-reply on the remote listener. The chat is one the
// client made on its board; on any other board the creation call is refused.
func TestChatAndToolCallOnAMarkedBoard(t *testing.T) {
	t.Parallel()
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	p := e.page("P")
	x, _ := l.api(apiX)
	y, _ := l.api(apiY)
	made := makeBoard(t, x, 200, board1, obj{"name": "X"})
	makeBoard(t, y, 200, board2, obj{"name": "Y"})
	own := newBoard(t, p, "own")
	cwd := t.TempDir()

	// The refusals: a board of the server's own, another client's, none, an archived one, and a
	// run beside the board.
	do(t, x, "POST", "/api/boards/"+board1+"/archive", nil)
	for what, c := range map[string][2]string{
		"the server's own board": {startBody(chat2, cwd, "board", own.ID), "board_refused"},
		"another client's board": {startBody(chat2, cwd, "board", board2), "board_refused"},
		"a board that is not":    {startBody(chat2, cwd, "board", "b_zzzz9999"), "board_refused"},
		"an archived board":      {startBody(chat2, cwd, "board", board1), "board_refused"},
		"a board and a run":      {startBody(chat2, cwd, "board", board1, "run", "r_00000001"), "bad_request"},
	} {
		if got := start(t, x, 400, c[0]); got.Code != c[1] || got.Chat != nil || got.Started || got.Sent {
			t.Errorf("%s: %+v, want the code %s", what, got, c[1])
		}
	}
	if n := len(e.a.Chats.Views()); n != 0 || sp.count() != 0 {
		t.Fatalf("%d chats and %d programs after the refused calls", n, sp.count())
	}
	do(t, x, "POST", "/api/boards/"+board1+"/unarchive", nil)

	// The chat on the client's board: in the board's group, with the client's mark.
	got := start(t, x, 200, startBody(chat1, cwd, "board", board1))
	if !got.Started || !got.Sent || got.Chat == nil || got.Chat.Board != board1 {
		t.Fatalf("the chat on the board: %+v", got)
	}
	if again := start(t, x, 200, startBody(chat1, cwd, "board", board1)); again.Sent || again.Chat == nil {
		t.Fatalf("the repeat: %+v", again)
	}
	start(t, x, 409, startBody(chat1, cwd)) // the same id with no board is another chat
	metas := e.a.Chats.ChatsOfBoard(board1)
	if len(metas) != 1 || metas[0].ID != chat1 || metas[0].Client != apiX || metas[0].Token == "" ||
		e.a.Chats.GroupOf(metas[0]) != made.Board.Group || made.Board.Group != e.remoteGroups()[0] {
		t.Fatalf("the chats of the board: %+v", metas)
	}
	if _, state := x.Do("GET", "/api/state", nil); !strings.Contains(string(state), chat1) || !strings.Contains(string(state), board1) {
		t.Fatalf("X's state: %s", state)
	}

	// The fork of that chat: X's is made on the board; Y's, whose mark the board has not, is not.
	a := sp.of(t, chat1)
	reply(t, &a.fakeAgent, "done", "p1")
	items := decode[struct{ Items []model.Item }](t, string(do(t, x, "GET", "/api/chats/"+chat1+"/items", nil)))
	body := `{"branch":"main","at":` + itoa(len(items.Items)) + `}`
	status, out := y.Do("POST", "/api/chats/"+chat1+"/fork", body)
	if refusal := decode[obj](t, string(out)); status != 400 || refusal["code"] != "board_refused" {
		t.Fatalf("Y's fork of a chat on X's board: %d %s", status, out)
	}
	fork := decode[model.ChatView](t, string(do(t, x, "POST", "/api/chats/"+chat1+"/fork", body)))
	if fork.ID == chat1 || fork.Board != board1 || fork.ForkedFrom != chat1 {
		t.Fatalf("X's fork: %+v", fork)
	}

	// The tool call: X holds the board and answers.
	token := metas[0].Token
	if state, _ := take(t, x, board1, true); state != "held" {
		t.Fatalf("X's take: %s", state)
	}
	asked := make(chan map[string]any, 1)
	x.OnRPC(func(params map[string]any) (any, string) {
		asked <- params
		return "X's board", ""
	})
	if text, isErr := e.tool(token, "read_board"); isErr || text != "X's board" {
		t.Fatalf("the board tool: %q (error %v)", text, isErr)
	}
	if params := <-asked; params["board"] != board1 || params["name"] != "read_board" || params["chat"] != chat1 {
		t.Fatalf("the call X was asked: %v", params)
	}
	x.OnRPC(func(map[string]any) (any, string) { return nil, "the window is closed" })
	if text, isErr := e.tool(token, "read_board"); !isErr || !strings.Contains(text, "the window is closed") {
		t.Fatalf("the board tool, answered with an error: %q (error %v)", text, isErr)
	}
	// An answer from a client that was not asked is refused, and the call goes on to its own.
	x.OnRPC(nil)
	done := make(chan string, 1)
	go func() {
		text, _ := e.tool(token, "read_board")
		done <- text
	}()
	var id string
	for id == "" {
		if ev := x.Next(); ev["type"] == "rpc" {
			id, _ = ev["id"].(string)
		}
	}
	if status, out := y.Do("POST", "/api/rpc-reply", obj{"id": id, "result": "Y's"}); status != 409 || strings.TrimSpace(string(out)) != `{"error":"not_asked"}` {
		t.Fatalf("Y's answer to X's call: %d %s", status, out)
	}
	if got := decode[obj](t, string(do(t, x, "POST", "/api/rpc-reply", obj{"id": id, "result": "X's own"}))); got["ok"] != true {
		t.Fatalf("X's answer: %v", got)
	}
	if text := <-done; text != "X's own" {
		t.Fatalf("the board tool, answered by hand: %q", text)
	}
	if status, _ := x.Do("POST", "/api/rpc-reply", obj{"id": id, "result": "twice"}); status != 409 {
		t.Fatalf("a second answer to one call: %d", status)
	}
	e.holder(board1, apiX)
}

// An API client's drawing is cut at SceneMax; a page's is not.
func TestSceneCapIsTheAPIClientsAlone(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	p := e.page("P")
	x, _ := l.api(apiX)
	makeBoard(t, x, 200, board1, obj{"name": "X"})
	if state, _ := take(t, x, board1, true); state != "held" {
		t.Fatalf("X's take: %s", state)
	}
	// Asked of the handler, without the listener: 32 MiB are not sent over TLS.
	h := e.s.RemoteHandler()
	put := func(body string) (int, string) {
		w := remoteDoAs(h, apiX, "PUT", "/api/boards/"+board1+"/scene?rev=0", "127.0.0.1:"+strconv.Itoa(l.port), testSecret, body)
		return w.Code, strings.TrimSpace(w.Body.String())
	}
	const head, tail = `{"type":"excalidraw","elements":[],"pad":"`, `"}`
	of := func(size int) string { return head + strings.Repeat("a", size-len(head)-len(tail)) + tail }
	if status, out := put(of(SceneMax + 1)); status != 413 || out != `{"code":"too_large","error":"the drawing is larger than 32 MB"}` {
		t.Fatalf("a drawing of one byte more than the cap: %d %s", status, out)
	}
	e.stored(board1, boards.EmptyScene, 0)
	if status, out := put(of(SceneMax)); status != 200 || out != `{"ok":true,"rev":1}` {
		t.Fatalf("a drawing of the cap's size: %d %.200s", status, out)
	}
	// The page's write of a larger one is stored.
	own := newBoard(t, p, "own")
	written(t, p, own.ID, 0, of(SceneMax+1))
}
