package server

import (
	"io"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
)

// The boards of the server for an API client on the remote listener: the real ServeRemote,
// stand-in API clients and stand-in pages, as in apiclient_test.go. A client makes a board with
// the page's call and reaches every board of the server, whoever made it.

// noSuchBoard is the answer of a board route for a board that is not there.
const noSuchBoard = `{"code":"not_found","error":"no such board"}`

// isBoardRoute reports whether the route of the table is one of a board, or the answer to a
// board tool call.
func isBoardRoute(route string) bool {
	return strings.Contains(route, " /api/boards/") || route == "POST /api/boards" || route == "POST /api/rpc-reply"
}

// Every board route of the table, for a client, on a board it made.
func TestBoardRoutesOfAnAPIClient(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	x, _ := l.api(apiX)
	y, _ := l.api(apiY)
	g, err := e.a.CreateGroup("Mine", "")
	if err != nil {
		t.Fatal(err)
	}
	called := map[string]bool{}
	var id string // the board the routes are called for
	call := func(want int, route string, body any) obj {
		t.Helper()
		if !slices.Contains(RemoteRoutes, route) {
			t.Fatalf("%s is no route of the table", route)
		}
		called[route] = true
		method, p, _ := strings.Cut(route, " ")
		status, out := x.Do(method, strings.Replace(p, "{id}", id, 1), body)
		if status != want {
			t.Fatalf("%s: status %d, want %d (%s)", route, status, want, out)
		}
		return decode[obj](t, string(out))
	}

	// What is refused makes nothing: a body that names a server, which a page's may, and what a
	// page is refused too.
	for what, c := range map[string]struct {
		status int
		code   string
		body   any
	}{
		"a server":                  {400, "server_refused", obj{"name": "n", "group": model.Ungrouped, "server": "local"}},
		"a server in other letters": {400, "server_refused", obj{"name": "n", "group": model.Ungrouped, "SERVER": ""}},
		"no group":                  {400, "", obj{"name": "n"}},
		"a name with a slash":       {400, "", obj{"name": "a/b", "group": model.Ungrouped}},
		"a name that is too long":   {400, "", obj{"name": strings.Repeat("n", 81), "group": model.Ungrouped}},
		"a body that is no object":  {400, "", "nothing"},
	} {
		status, out := x.Do("POST", "/api/boards", c.body)
		if got := decode[refusal](t, string(out)); status != c.status || got.Code != c.code || got.Error == "" {
			t.Errorf("a new board with %s: %d %s, want %d and the code %q", what, status, out, c.status, c.code)
		}
	}
	if n := len(e.a.Boards.List()); n != 0 {
		t.Fatalf("%d boards after the refused creations", n)
	}

	// The creation: in the group the call names, with no mark, and held by the client that made
	// it, as a page holds the board it makes.
	made := do(t, x, "POST", "/api/boards", obj{"name": "Untitled", "group": g.ID})
	first := decode[model.Board](t, string(made))
	called["POST /api/boards"] = true
	id = first.ID
	if !regexp.MustCompile(`^b_[a-z0-9]{8}$`).MatchString(id) || first.Name != "Untitled" || first.Group != g.ID || first.New || first.Archived ||
		strings.Contains(string(made), `"client"`) || strings.Contains(string(made), `"origin"`) {
		t.Fatalf("the creation: %s", made)
	}
	e.holder(id, apiX)
	e.st.Read(func(s *model.State) {
		if len(s.Groups) != 1 || s.RemoteGroup != "" {
			t.Fatalf("the groups after the creation: %+v, the group remembered as Remote %q", s.Groups, s.RemoteGroup)
		}
	})
	// The snapshot and the state of every client hold the board.
	for who, c := range map[string]*bridgetest.Page{apiX: x, apiY: y} {
		_, state := c.Do("GET", "/api/state", nil)
		if got := decode[struct{ Boards []model.Board }](t, string(state)); len(got.Boards) != 1 || got.Boards[0].ID != id || got.Boards[0].Group != g.ID {
			t.Fatalf("the state of %s: %s", who, state)
		}
	}
	if _, snap := l.api(apiZ); !strings.Contains(snap, id) {
		t.Fatalf("Z's snapshot: %s", snap)
	}

	// The drawing: a write needs the hold and the revision it is based on.
	scene := func() (string, string) {
		t.Helper()
		called["GET /api/boards/{id}/scene"] = true
		req, _ := http.NewRequest("GET", l.base+"/api/boards/"+id+"/scene", nil)
		req.Header.Set(SecretHeader, testSecret)
		req.Header.Set(ClientHeader, apiX)
		req.Header.Set(servers.LevelHeader, testLevel)
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
		status, out := x.Do("PUT", "/api/boards/"+id+"/scene"+rev, body)
		if status != want {
			t.Fatalf("the write with %q: status %d, want %d (%s)", rev, status, want, out)
		}
		return decode[obj](t, string(out))
	}
	if got := call(200, "POST /api/boards/{id}/release", nil); got["state"] != "free" {
		t.Fatalf("the release of the new board: %v", got)
	}
	if got := writeAt(409, "?rev=0", drawing("early")); got["code"] != "not_holder" {
		t.Fatalf("a write without the hold: %v", got)
	}
	if got := call(200, "POST /api/boards/{id}/take", obj{"ifFree": true}); got["state"] != "held" || got["rev"] != 0.0 {
		t.Fatalf("the take: %v", got)
	}
	e.holder(id, apiX)
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
	e.onDisk(id, drawing("one"))

	// The rest of the board's routes.
	if got := call(200, "POST /api/boards/{id}/rename", obj{"name": "Plan"}); got["name"] != "Plan" || got["id"] != id || got["client"] != nil {
		t.Fatalf("the rename: %v", got)
	}
	if got := call(200, "PATCH /api/boards/{id}", obj{"group": model.Ungrouped}); got["ok"] != true {
		t.Fatalf("the move out of the group: %v", got)
	}
	if bd, _ := e.a.Boards.Get(id); bd.Group != model.Ungrouped {
		t.Fatalf("the board after the move: %+v", bd)
	}
	if got := call(400, "PATCH /api/boards/{id}", obj{"group": "g_nowhere1"}); got["error"] != `no such group "g_nowhere1"` || got["code"] != nil {
		t.Fatalf("the move into a group that is not there: %v", got)
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
	if bd, _ := e.a.Boards.Get(id); !bd.Archived {
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
	// A take needs an open stream: Z, whose stream has ended, takes nothing.
	z := bridgetest.ConnectWith(t, l.base, apiZ, l.options(apiZ, testSecret))
	other := newBoard(t, z, "Z")
	z.Close()
	deadline := time.Now().Add(10 * time.Second)
	for {
		status, out := l.call(apiZ, testSecret, "POST", "/api/boards/"+other.ID+"/take", "")
		if status == 409 && strings.TrimSpace(out) == `{"error":"unknown_client"}` {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("a take with no open stream: %d %s", status, out)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// The delete, of a board nobody holds: a holder would be given its time to let go.
	call(200, "POST /api/boards/{id}/release", nil)
	if got := call(200, "DELETE /api/boards/{id}", nil); got["ok"] != true {
		t.Fatalf("the delete: %v", got)
	}
	if _, found := e.a.Boards.Get(id); found {
		t.Fatal("the board is still there after the delete")
	}
	e.holder(id, "")
	for _, route := range RemoteRoutes {
		if isBoardRoute(route) && !called[route] {
			t.Errorf("the route %s of the table was not called", route)
		}
	}
	// What the table does not serve to an API client.
	for _, r := range [][2]string{{"PUT", "/api/boards/" + other.ID}, {"POST", "/api/boards/" + other.ID + "/reveal"}, {"POST", "/api/client/flushed"}} {
		if status, out := x.Do(r[0], r[1], obj{"name": "n", "group": model.Ungrouped}); status != 404 || strings.TrimSpace(string(out)) != `{"error":"not found"}` {
			t.Errorf("%s %s: %d %s, want 404 not found", r[0], r[1], status, out)
		}
	}
}

// An API client reaches every board of the server: one of the server's own page and one of
// another client are served to it as to a page that does not hold them. A board that is not there
// is answered as that, and nothing is made.
func TestBoardRoutesServeEveryBoard(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	p := e.page("P")
	x, _ := l.api(apiX)
	y, _ := l.api(apiY)
	own := newBoard(t, p, "own") // P holds it
	written(t, p, own.ID, 0, drawing("the owner's"))
	theirs := newBoard(t, y, "Y") // Y holds it
	written(t, y, theirs.ID, 0, drawing("Y's"))
	e.reach(p, x, y)

	for id, holder := range map[string]*bridgetest.Page{own.ID: p, theirs.ID: y} {
		at := "/api/boards/" + id
		// The drawing is read, and not written without the hold.
		if status, out := x.Do("GET", at+"/scene", nil); status != 200 || !strings.Contains(string(out), "rectangle") {
			t.Fatalf("X's read of the drawing of %s: %d %s", id, status, out)
		}
		status, out := write(x, id, 1, drawing("X's"))
		refused(t, "X's write of a board it does not hold", "not_holder", status, out)
		// A take that leaves a held board where it is, and a release of what X does not hold.
		if state, _ := take(t, x, id, true); state != "busy" {
			t.Fatalf("X's take if free of %s: %s", id, state)
		}
		if got := release(t, x, id); got != "none" {
			t.Fatalf("X's release of %s: %s", id, got)
		}
		e.holder(id, holder.ID)
		// The name, the "new" mark and the place are every client's to change.
		if bd := decode[model.Board](t, string(do(t, x, "POST", at+"/rename", obj{"name": "by-X"}))); bd.ID != id || bd.Name != "by-X" {
			t.Fatalf("X's rename of %s: %+v", id, bd)
		}
		do(t, x, "POST", at+"/seen", nil)
		// Its holder is not asked to let go, and its own calls are served.
		written(t, holder, id, 1, drawing("the holder's next"))
	}
	evs := e.reach(p, x, y)
	for i, c := range []*bridgetest.Page{p, x, y} {
		// Two of each board: the rename, and the "new" mark's.
		if count(evs[i], "board", own.ID, "by-X") != 2 || count(evs[i], "board", theirs.ID, "by-X") != 2 {
			t.Errorf("of X's renames %s was sent %v", c.ID, types(evs[i]))
		}
		if got := only(evs[i], "release_request", "superseded", "held"); len(got) != 0 {
			t.Errorf("X's calls sent %s %v", c.ID, got)
		}
	}
	// The take of a held board, and the archive and the delete of one, are a page's too: its
	// holder is asked to let go and does.
	if state, _ := take(t, x, theirs.ID, false); state != "waiting" {
		t.Fatalf("X's take of Y's board: %s", state)
	}
	until(t, y, "release_request", theirs.ID)
	if got := release(t, y, theirs.ID); got != "handed" {
		t.Fatalf("Y's release: %s", got)
	}
	if ev := until(t, x, "held", theirs.ID); ev["rev"] != 2.0 {
		t.Fatalf("X's grant: %v", ev)
	}
	written(t, x, theirs.ID, 2, drawing("X's"))
	if got := release(t, x, theirs.ID); got != "free" {
		t.Fatalf("X's release: %s", got)
	}
	do(t, x, "POST", "/api/boards/"+theirs.ID+"/archive", nil)
	do(t, x, "POST", "/api/boards/"+theirs.ID+"/unarchive", nil)
	do(t, x, "DELETE", "/api/boards/"+theirs.ID, nil)
	if _, found := e.a.Boards.Get(theirs.ID); found {
		t.Fatal("Y's board is there after X's delete")
	}
	evs = e.reach(p, x, y)
	for i, c := range []*bridgetest.Page{p, x, y} {
		if count(evs[i], "board_removed", theirs.ID) != 1 {
			t.Errorf("of X's delete of Y's board %s was sent %v", c.ID, types(evs[i]))
		}
	}

	// A board that is not there: every route that names one says so, with the code, and the
	// release, which ends a hold whatever the board is, says that there was none.
	const missing = "b_zzzz9999"
	for _, route := range RemoteRoutes {
		if !strings.Contains(route, " /api/boards/") {
			continue
		}
		method, path, _ := strings.Cut(route, " ")
		path = strings.Replace(path, "{id}", missing, 1)
		if strings.HasSuffix(path, "/scene") && method == "PUT" {
			path += "?rev=0"
		}
		var body any = obj{"name": "taken", "ifFree": false, "group": model.Ungrouped}
		if strings.HasSuffix(path, "/scene?rev=0") {
			body = drawing("nowhere")
		}
		status, out := x.Do(method, path, body)
		if route == "POST /api/boards/{id}/release" {
			if status != 200 || strings.TrimSpace(string(out)) != `{"state":"none"}` {
				t.Errorf("%s of a board that is not there: %d %s", route, status, out)
			}
			continue
		}
		if status != 404 || strings.TrimSpace(string(out)) != noSuchBoard {
			t.Errorf("%s of a board that is not there: %d %s, want 404 %s", route, status, out, noSuchBoard)
		}
	}
	if _, found := e.a.Boards.Get(missing); found || len(e.a.Boards.List()) != 1 {
		t.Fatalf("the boards after the calls for one that is not there: %+v", e.a.Boards.List())
	}
	e.holder(own.ID, "P")
	e.onDisk(own.ID, drawing("the holder's next"))
}

// A board's events reach every page and every API client, whoever made the board and whoever
// changed it.
func TestBoardEventsReachEveryClient(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	p := e.page("P")
	x, _ := l.api(apiX)
	y, _ := l.api(apiY)
	e.reach(p, x, y)
	// sent checks that the page, X and Y were each sent n events of this type, the same ones.
	sent := func(what, typ string, n int, has ...string) {
		t.Helper()
		evs := e.reach(p, x, y)
		apiOnly(t, x, evs[1])
		apiOnly(t, y, evs[2])
		if got := []int{count(evs[0], typ, has...), count(evs[1], typ, has...), count(evs[2], typ, has...)}; !slices.Equal(got, []int{n, n, n}) {
			t.Errorf("%s: %s reached the page, X and Y %v times, want %d each", what, typ, got, n)
		}
		if a, b, c := only(evs[0], typ), only(evs[1], typ), only(evs[2], typ); !slices.Equal(a, b) || !slices.Equal(a, c) {
			t.Errorf("%s: the %s events of the three differ:\nthe page %v\nX %v\nY %v", what, typ, a, b, c)
		}
		// Y holds no board and waits for none: nothing about a role reaches it.
		if got := only(evs[2], "held", "superseded", "release_request"); len(got) != 0 {
			t.Errorf("%s: Y was sent %v", what, got)
		}
	}
	bd := newBoard(t, x, "X")
	sent("X's creation", "board", 1, bd.ID, `"name":"X"`)
	if got := release(t, x, bd.ID); got != "free" {
		t.Fatalf("X's release of its new board: %s", got)
	}
	at := "/api/boards/" + bd.ID
	e.expect(200, "POST", at+"/rename", `{"name":"by-the-page"}`)
	sent("the page's rename", "board", 1, bd.ID, "by-the-page")
	do(t, x, "POST", at+"/rename", obj{"name": "by-X"})
	sent("X's rename", "board", 1, bd.ID, "by-X")
	e.expect(200, "POST", at+"/archive", "")
	sent("the page's archive", "board", 1, bd.ID, `"archived":true`)
	do(t, y, "POST", at+"/unarchive", nil)
	sent("Y's unarchive", "board", 1, bd.ID)
	// A board of the server's own page.
	own := e.board(model.Ungrouped)
	e.expect(200, "POST", "/api/boards/"+own.ID+"/rename", `{"name":"mine"}`)
	sent("the owner's board", "board", 2, own.ID)
	e.expect(200, "DELETE", "/api/boards/"+own.ID, "")
	sent("the delete of the owner's board", "board_removed", 1, own.ID)
	do(t, y, "DELETE", at, nil)
	sent("Y's delete of X's board", "board_removed", 1, bd.ID)
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
	board1 := newBoard(t, x, "X").ID // X made the board, so it holds it
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

// An agent's board tool on a chat of a board is asked of the API client that holds the board,
// and answered through POST /api/rpc-reply on the remote listener. A client makes a chat on any
// board of the server, and forks one, whoever made the board and the chat.
func TestChatAndToolCallOnABoardOfAnAPIClient(t *testing.T) {
	t.Parallel()
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	p := e.page("P")
	x, _ := l.api(apiX)
	y, _ := l.api(apiY)
	board1 := newBoard(t, x, "X").ID // X holds it
	own := newBoard(t, p, "own")     // the page's own, which the page holds
	old := newBoard(t, y, "old")
	if got := release(t, y, old.ID); got != "free" {
		t.Fatalf("Y's release of its new board: %s", got)
	}
	do(t, y, "POST", "/api/boards/"+old.ID+"/archive", nil)

	// The refusals are the page's own: a board that is not there, and an archived one.
	for what, c := range map[string]struct {
		status int
		code   string
		board  string
	}{
		"a board that is not there": {404, "not_found", "b_zzzz9999"},
		"an archived board":         {409, "", old.ID},
	} {
		status, out := x.Do("POST", "/api/chats", obj{"id": chat2, "agent": "claude", "board": c.board})
		if got := decode[refusal](t, string(out)); status != c.status || got.Code != c.code || got.Error == "" {
			t.Errorf("a new chat on %s: %d %s, want %d and the code %q", what, status, out, c.status, c.code)
		}
	}
	if n := len(e.a.Chats.Views()); n != 0 || sp.count() != 0 {
		t.Fatalf("%d chats and %d programs after the refused calls", n, sp.count())
	}

	// A chat on the board of another client, and one on the page's own board: each is on its
	// board, in the board's place, with no mark.
	startedBy(t, y, chat1, "group", nil, "board", board1)
	if on := unstartedBy(t, x, chat2, "group", nil, "board", own.ID); on.Board != own.ID {
		t.Fatalf("the chat on the page's board: %+v", on)
	}
	metas := e.a.Chats.ChatsOfBoard(board1)
	if len(metas) != 1 || metas[0].ID != chat1 || metas[0].Token == "" || e.a.Chats.GroupOf(metas[0]) != model.Ungrouped {
		t.Fatalf("the chats of the board: %+v", metas)
	}
	for who, c := range map[string]*bridgetest.Page{"X": x, "Y": y} {
		if _, state := c.Do("GET", "/api/state", nil); !strings.Contains(string(state), chat1) || !strings.Contains(string(state), chat2) || !strings.Contains(string(state), own.ID) {
			t.Fatalf("the state of %s: %s", who, state)
		}
	}

	// The fork of the chat is made on the board, by the client that made neither.
	a := sp.of(t, chat1)
	reply(t, &a.fakeAgent, "done", "p1")
	items := decode[struct{ Items []model.Item }](t, string(do(t, x, "GET", "/api/chats/"+chat1+"/items", nil)))
	fork := decode[model.ChatView](t, string(do(t, x, "POST", "/api/chats/"+chat1+"/fork", `{"branch":"main","at":`+itoa(len(items.Items))+`}`)))
	if fork.ID == chat1 || fork.Board != board1 || fork.ForkedFrom != chat1 {
		t.Fatalf("X's fork of Y's chat: %+v", fork)
	}

	// The tool call: X holds the board and answers.
	token := metas[0].Token
	e.holder(board1, apiX)
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
	e.holder(own.ID, "P")
}

// An API client's drawing is cut at SceneMax; a page's is not.
func TestSceneCapIsTheAPIClientsAlone(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	p := e.page("P")
	x, _ := l.api(apiX)
	board1 := newBoard(t, x, "X").ID
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
