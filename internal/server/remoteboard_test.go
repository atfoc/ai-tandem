package server

import (
	"encoding/json"
	"net/http"
	"slices"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// The ids of two boards the stand-in has.
const (
	farBoardA = "b_aaaa0001"
	farBoardB = "b_bbbb0002"
)

// boardThere is a board as the stand-in has it: in its "Remote" group, with this server's mark.
func boardThere(id string) model.Board {
	return model.Board{ID: id, Name: "Board " + id[2:4], Group: "g_remote", Client: testLocalID,
		Created: time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)}
}

// usualBoards is what the stand-in answers on the routes of a board when a test sets nothing: a
// server that makes the board of a creation call, grants a take and stores a drawing.
func (f *far) usualBoards() map[string]http.HandlerFunc {
	return map[string]http.HandlerFunc{
		"PUT /api/boards/{id}": func(w http.ResponseWriter, r *http.Request) {
			var body struct{ Name string }
			json.NewDecoder(r.Body).Decode(&body)
			bd := boardThere(r.PathValue("id"))
			bd.Name = body.Name
			writeJSON(w, map[string]any{"ok": true, "made": true, "board": bd})
		},
		"POST /api/boards/{id}/rename": func(w http.ResponseWriter, r *http.Request) {
			var body struct{ Name string }
			json.NewDecoder(r.Body).Decode(&body)
			bd := boardThere(r.PathValue("id"))
			bd.Name = body.Name
			writeJSON(w, bd)
		},
		"POST /api/boards/{id}/take": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, map[string]any{"state": "held", "rev": 3})
		},
		"POST /api/boards/{id}/release": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, map[string]any{"state": "free"})
		},
		"GET /api/boards/{id}/scene": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set(SceneRevHeader, "3")
			writeJSON(w, map[string]any{"elements": []any{}})
		},
		"PUT /api/boards/{id}/scene": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, map[string]any{"ok": true, "rev": 4})
		},
	}
}

// boardsNow are the boards with the id in the snapshot a page gets now.
func (f *far) boardsNow(p *bridgetest.Page, id string) []model.Board {
	f.t.Helper()
	var snap struct{ Boards []model.Board }
	if err := json.Unmarshal([]byte(mustOK(f.t, f, p, "GET", "/api/state", "")), &snap); err != nil {
		f.t.Fatal(err)
	}
	var out []model.Board
	for _, b := range snap.Boards {
		if b.ID == id {
			out = append(out, b)
		}
	}
	return out
}

// boardNow is the board with the id in the snapshot, which lists it once.
func (f *far) boardNow(p *bridgetest.Page, id string) model.Board {
	f.t.Helper()
	got := f.boardsNow(p, id)
	if len(got) != 1 {
		f.t.Fatalf("the snapshot lists the board %s %d times", id, len(got))
	}
	return got[0]
}

// up starts the stand-in again and waits until the relay has taken the snapshot n.
func (f *far) up(n int64) {
	f.t.Helper()
	f.st.Restart()
	f.returned(n)
}

func boardRoute(pattern string) bool {
	_, path, _ := strings.Cut(pattern, " ")
	return path == "/api/boards/{id}" || strings.HasPrefix(path, "/api/boards/{id}/")
}

// The table of a board record's routes holds every route the mux has for one board: a board
// route that is added to the mux without a row here would reach the board service for a record,
// which knows no such board. The table has one row the mux of this listener may lack: the
// creation call of an API client, which is not served to a page.
func TestBoardRecordRoutesAreTheBoardRoutesOfTheMux(t *testing.T) {
	t.Parallel()
	s := newEnv(t).s
	const creation = "PUT /api/boards/{id}"
	var mux []string
	for _, p := range s.routes().patterns {
		if boardRoute(p) && p != creation {
			mux = append(mux, p)
		}
	}
	var table []string
	for _, p := range s.boardRecordRoutes().patterns {
		if !boardRoute(p) {
			t.Errorf("the table holds %q, which is no route of one board", p)
		}
		if p != creation {
			table = append(table, p)
		}
	}
	sort.Strings(mux)
	sort.Strings(table)
	if !slices.Equal(mux, table) {
		t.Fatalf("the mux has the board routes\n%s\nand the table\n%s", strings.Join(mux, "\n"), strings.Join(table, "\n"))
	}
	if len(table) != 11 || !slices.Contains(s.boardRecordRoutes().patterns, creation) {
		t.Fatalf("%d routes of one board, want 11 and the creation call: is a row of the design's table missing?", len(table))
	}
	// Every route of the remote listener's table that is a board's has a row too.
	for _, p := range RemoteRoutes {
		if boardRoute(p) && !slices.Contains(s.boardRecordRoutes().patterns, p) {
			t.Errorf("%q is served to an API client and has no row", p)
		}
	}
}

// The creation of a board on another server: this server makes the id, the stand-in gets the
// creation call, and the board is a record in the page's group. "local" and no server make a
// board of this server.
func TestBoardCreateThere(t *testing.T) {
	t.Parallel()
	f := newFar(t, farOpt{boards: []model.Board{}})
	p := f.page("P")
	g := f.group(p, "Work", "")
	const made = "PUT /api/boards/{id}"

	got := decode[model.Board](t, mustOK(t, f, p, "POST", "/api/boards", form("name", "Untitled", "group", g, "server", f.entry)))
	if !boards.ValidID(got.ID) || got.Name != "Untitled" || got.Group != g || got.Server != f.entry || got.Client != "" {
		t.Fatalf("the board: %+v", got)
	}
	if c := f.last(made); c.Path != "/api/boards/"+got.ID || c.Body != `{"name":"Untitled"}` {
		t.Fatalf("the creation call: %+v", c)
	}
	if now := f.boardNow(p, got.ID); now.Server != f.entry || now.Group != g {
		t.Fatalf("the snapshot: %+v", now)
	}
	if _, ok := f.s.App.Boards.Get(got.ID); ok {
		t.Fatal("the board was made on this server too")
	}

	// "local" and no server at all: a board of this server, and nothing is sent.
	f.untouched("a board of this server", func() {
		for _, body := range []string{form("name", "Here", "group", g, "server", "local"), form("name", "Here", "group", g)} {
			own := decode[model.Board](t, mustOK(t, f, p, "POST", "/api/boards", body))
			if _, ok := f.s.App.Boards.Get(own.ID); !ok || own.Server != "" || f.rm.HasBoard(own.ID) {
				t.Fatalf("a board of this server: %+v", own)
			}
		}
	})
	// A group that is none, and a server that is none: refused here.
	f.untouched("a creation that is refused here", func() {
		if status, out := f.call(p, "POST", "/api/boards", form("name", "X", "group", "g_none", "server", f.entry)); status != http.StatusNotFound {
			t.Fatalf("a group that is none: %d %s", status, out)
		}
		if status, out := f.call(p, "POST", "/api/boards", form("name", "X", "group", g, "server", "s_000000000000")); status != http.StatusBadRequest {
			t.Fatalf("a server that is none: %d %s", status, out)
		}
	})

	// The answer to the first call is lost: the same call is made once more.
	var n atomic.Int64
	f.handle(made, func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1) == 1 {
			panic(http.ErrAbortHandler)
		}
		writeJSON(w, map[string]any{"ok": true, "made": false, "board": boardThere(r.PathValue("id"))})
	})
	before := len(f.sent(made))
	got = decode[model.Board](t, mustOK(t, f, p, "POST", "/api/boards", form("name", "Untitled", "group", g, "server", f.entry)))
	if calls := f.sent(made)[before:]; len(calls) != 2 || calls[0].Path != calls[1].Path || calls[1].Path != "/api/boards/"+got.ID {
		t.Fatalf("the repeat: %+v for %+v", calls, got)
	}

	// The stand-in has a board with the id: one new id.
	n.Store(0)
	f.handle(made, func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1) == 1 {
			writeErrorCode(w, http.StatusConflict, "the id is taken", "id_taken")
			return
		}
		writeJSON(w, map[string]any{"ok": true, "made": true, "board": boardThere(r.PathValue("id"))})
	})
	before = len(f.sent(made))
	got = decode[model.Board](t, mustOK(t, f, p, "POST", "/api/boards", form("name", "Untitled", "group", g, "server", f.entry)))
	if calls := f.sent(made)[before:]; len(calls) != 2 || calls[0].Path == calls[1].Path || calls[1].Path != "/api/boards/"+got.ID {
		t.Fatalf("a taken id: %+v for %+v", calls, got)
	}
	if f.rm.HasBoard(strings.TrimPrefix(f.sent(made)[before].Path, "/api/boards/")) {
		t.Fatal("the refused id has a record")
	}

	// A server that has no board routes.
	f.answer(made, http.StatusNotFound, map[string]string{"error": "not found"})
	if text := f.refuses(p, http.StatusBadGateway, "no_boards", "POST", "/api/boards", form("name", "X", "group", g, "server", f.entry)); text != "Studio does not serve boards. Update it." {
		t.Fatalf("a server without boards: %q", text)
	}

	// Not connected: 503, and nothing is made.
	f.handle(made, nil)
	listed := len(f.rm.BoardViews())
	f.down()
	f.untouched("a creation while the server is away", func() {
		f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", "POST", "/api/boards", form("name", "X", "group", g, "server", f.entry))
	})
	if len(f.rm.BoardViews()) != listed {
		t.Fatalf("a record was made: %+v", f.rm.BoardViews())
	}
}

// Each row of the board record's table that is not the hold chain's: what the stand-in gets,
// and what the page gets.
func TestBoardRecordRoutes(t *testing.T) {
	t.Parallel()
	f := newFar(t, farOpt{boards: []model.Board{boardThere(farBoardA), boardThere(farBoardB)}})
	p := f.page("P")
	g := f.group(p, "Work", "")
	at := "/api/boards/" + farBoardA

	// The snapshot: the record, with this server's place and the entry, and nothing of the mark.
	if now := f.boardNow(p, farBoardA); now.Server != f.entry || now.Group != model.Ungrouped || now.Client != "" || now.Name != "Board aa" {
		t.Fatalf("the snapshot: %+v", now)
	}

	// rename: passed on; the record takes the answer.
	got := f.good(p, "POST", at+"/rename", form("name", "Plan"))
	if got["id"] != farBoardA || got["name"] != "Plan" || got["server"] != f.entry || got["group"] != model.Ungrouped {
		t.Fatalf("the rename: %v", got)
	}
	if c := f.last("POST /api/boards/{id}/rename"); c.Path != at+"/rename" || c.Body != form("name", "Plan") {
		t.Fatalf("the rename there: %+v", c)
	}
	if now := f.boardNow(p, farBoardA); now.Name != "Plan" {
		t.Fatalf("the name: %+v", now)
	}

	// PATCH: the place is this server's; nothing is sent.
	f.untouched("a move", func() {
		f.good(p, "PATCH", at, form("group", g))
		if status, out := f.call(p, "PATCH", at, form("group", "g_none")); status != http.StatusNotFound {
			t.Fatalf("a move to no group: %d %s", status, out)
		}
		if status, out := f.call(p, "PATCH", at, form("group", "")); status != http.StatusBadRequest {
			t.Fatalf("a move to the empty group: %d %s", status, out)
		}
	})
	if now := f.boardNow(p, farBoardA); now.Group != g {
		t.Fatalf("the place: %+v", now)
	}

	// seen: passed on.
	f.good(p, "POST", at+"/seen", "")
	if c := f.last("POST /api/boards/{id}/seen"); c.Path != at+"/seen" {
		t.Fatalf("seen there: %+v", c)
	}

	// reveal: the board has no file here. The creation call is no route of a page.
	f.untouched("the routes answered here", func() {
		if text := f.refuses(p, http.StatusBadRequest, "not_here", "POST", at+"/reveal", ""); text != "A board on another server has no file on this computer" {
			t.Fatalf("reveal: %q", text)
		}
		if status, out := f.call(p, "PUT", at, form("name", "X")); status != http.StatusNotFound || !strings.Contains(out, "not found") {
			t.Fatalf("the creation call of an API client: %d %s", status, out)
		}
		// The drawing a page saves: its revision is checked here, and its size.
		if status, out := f.call(p, "PUT", at+"/scene", `{}`); status != http.StatusBadRequest || !strings.Contains(out, "rev is missing") {
			t.Fatalf("a save without a revision: %d %s", status, out)
		}
		if status, out := f.call(p, "PUT", at+"/scene?rev=x", `{}`); status != http.StatusBadRequest || !strings.Contains(out, "rev is not a number") {
			t.Fatalf("a save at no revision: %d %s", status, out)
		}
		large := `{"x":"` + strings.Repeat("a", remoteSceneMax) + `"}`
		if text := f.refuses(p, http.StatusRequestEntityTooLarge, "too_large", "PUT", at+"/scene?rev=0", large); text != "the drawing is larger than 32 MB" {
			t.Fatalf("a drawing above the limit: %q", text)
		}
	})

	// The hold chain's routes and the drawing reach the relay, not the boards of this server,
	// which would say "no such board" (their behaviour is tested with the relay).
	for _, c := range [][2]string{{"POST", at + "/take"}, {"POST", at + "/release"}, {"GET", at + "/scene"}, {"PUT", at + "/scene?rev=0"}} {
		body := ""
		if c[0] == "PUT" {
			body = `{}`
		}
		if status, out := f.call(p, c[0], c[1], body); status == http.StatusNotFound {
			t.Errorf("%s %s reached the boards of this server: %s", c[0], c[1], out)
		}
	}
	// An answer to a tool call nobody asked is refused, whoever would have asked it.
	if status, out := f.call(p, "POST", "/api/rpc-reply", `{"id":"far_1","result":1}`); status != http.StatusConflict || !strings.Contains(out, "not_asked") {
		t.Errorf("an answer to no call: %d %s", status, out)
	}
	// An answer to a tool call of this server's own bridge is not the relay's: it passes the
	// peek with its body whole, and ends the call.
	p.OnRPC(func(map[string]any) (any, string) { return "local", "" })
	if out, err := f.s.Bridge.CallBoard(editorbridge.CallSpec{Method: "tool", Params: map[string]any{}, Screen: true}, 10*time.Second); err != nil || string(out) != `"local"` {
		t.Errorf("a tool call of this server's bridge: %s, %v", out, err)
	}
	p.OnRPC(nil)

	// archive and unarchive: the mark shows, and is passed on.
	f.good(p, "POST", at+"/archive", "")
	if now := f.boardNow(p, farBoardA); !now.Archived || now.Op == "" {
		t.Fatalf("after the archive: %+v", now)
	}
	if c := f.last("POST /api/boards/{id}/archive"); c.Path != at+"/archive" {
		t.Fatalf("the archive there: %+v", c)
	}
	f.good(p, "POST", at+"/unarchive", "")
	if now := f.boardNow(p, farBoardA); now.Archived || now.Op != "" {
		t.Fatalf("after the unarchive: %+v", now)
	}
	if c := f.last("POST /api/boards/{id}/unarchive"); c.Path != at+"/unarchive" {
		t.Fatalf("the unarchive there: %+v", c)
	}

	// DELETE ?local=1 is refused while the server is connected; DELETE deletes the board there.
	f.untouched("a local delete while connected", func() {
		f.refuses(p, http.StatusConflict, "server_connected", "DELETE", "/api/boards/"+farBoardB+"?local=1", "")
	})
	f.good(p, "DELETE", "/api/boards/"+farBoardB, "")
	if c := f.last("DELETE /api/boards/{id}"); c.Path != "/api/boards/"+farBoardB {
		t.Fatalf("the delete there: %+v", c)
	}
	if got := f.boardsNow(p, farBoardB); len(got) != 0 || f.rm.HasBoard(farBoardB) {
		t.Fatalf("the board after its delete: %+v", got)
	}
	// From here on the id is no record's: the boards of this server answer.
	if status, out := f.call(p, "POST", "/api/boards/"+farBoardB+"/seen", ""); status != http.StatusNotFound {
		t.Fatalf("a board without a record: %d %s", status, out)
	}
}

// While the board's server is away: the rename and the delete are refused, the move works, an
// archive stays pending and is passed on at the return, and "Remove from this sidebar" drops
// the record.
func TestBoardRecordRoutesWhileAway(t *testing.T) {
	t.Parallel()
	f := newFar(t, farOpt{boards: []model.Board{boardThere(farBoardA), boardThere(farBoardB)}})
	p := f.page("P")
	g := f.group(p, "Work", "")
	at := "/api/boards/" + farBoardA
	f.down()

	f.untouched("the calls while the server is away", func() {
		f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", "POST", at+"/rename", form("name", "Later"))
		f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", "POST", at+"/seen", "")
		if text := f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", "DELETE", at, ""); text != "Studio is not connected." {
			t.Fatalf("the refusal of the delete: %q", text)
		}
		f.good(p, "PATCH", at, form("group", g))
		f.good(p, "POST", at+"/archive", "")
	})
	if now := f.boardNow(p, farBoardA); now.Name != "Board aa" || now.Group != g || !now.Archived {
		t.Fatalf("the board while its server is away: %+v", now)
	}
	// "Remove from this sidebar": the record alone goes.
	f.good(p, "DELETE", "/api/boards/"+farBoardB+"?local=1", "")
	if got := f.boardsNow(p, farBoardB); len(got) != 0 {
		t.Fatalf("the removed board: %+v", got)
	}

	// The return: the pending archive wins over the stand-in's mark and is passed on.
	f.up(2)
	f.wait("the pending archive is passed on", func() bool { return len(f.sent("POST /api/boards/{id}/archive")) == 1 })
	if c := f.last("POST /api/boards/{id}/archive"); c.Path != at+"/archive" {
		t.Fatalf("the archive that was passed on: %+v", c)
	}
	if now := f.boardNow(p, farBoardA); !now.Archived || now.Gone {
		t.Fatalf("the board after the return: %+v", now)
	}
	// The stand-in still has the removed board: its snapshot brought it back, ungrouped.
	if now := f.boardNow(p, farBoardB); now.Group != model.Ungrouped || now.Server != f.entry {
		t.Fatalf("the board the stand-in still has: %+v", now)
	}
}

// The snapshot of a page: the boards of this server and the records; an id that has both is
// listed once, as the record.
func TestSnapshotHasBoardRecords(t *testing.T) {
	t.Parallel()
	f := newFar(t, farOpt{boards: []model.Board{boardThere(farBoardA)}})
	p := f.page("P")
	own := decode[model.Board](t, mustOK(t, f, p, "POST", "/api/boards", form("name", "Here", "group", model.Ungrouped)))
	if _, _, err := f.s.App.Boards.Make(boards.NewBoard{ID: farBoardA, Name: "Same id", Group: model.Ungrouped}); err != nil {
		t.Fatal(err)
	}
	if now := f.boardNow(p, own.ID); now.Server != "" || now.Name != "Here" {
		t.Fatalf("the board of this server: %+v", now)
	}
	if now := f.boardNow(p, farBoardA); now.Server != f.entry || now.Name != "Board aa" {
		t.Fatalf("the record: %+v", now)
	}
	// A page that connects gets the same in its stream's snapshot.
	q := bridgetest.Connect(t, f.url, "Q")
	raw, _ := json.Marshal(q.Welcome()["boards"])
	var listed []model.Board
	json.Unmarshal(raw, &listed)
	n := 0
	for _, b := range listed {
		if b.ID == farBoardA {
			if n++; b.Server != f.entry {
				t.Errorf("the stream's snapshot: %+v", b)
			}
		}
	}
	if n != 1 || len(listed) != 2 {
		t.Fatalf("the stream's snapshot lists %+v", listed)
	}
}

// The archive, the unarchive and the delete of a group reach the board records in it as they
// reach the chats and the runs of other servers there.
func TestGroupRoutesWithBoardRecords(t *testing.T) {
	t.Parallel()
	f := newFar(t, farOpt{boards: []model.Board{boardThere(farBoardA), boardThere(farBoardB)}})
	p := f.page("P")
	g := f.group(p, "Work", "")
	sub := f.group(p, "Deep", g)
	f.good(p, "PATCH", "/api/boards/"+farBoardA, form("group", g))
	f.good(p, "PATCH", "/api/boards/"+farBoardB, form("group", sub))

	f.good(p, "POST", "/api/groups/"+g+"/archive", "")
	a, b := f.boardNow(p, farBoardA), f.boardNow(p, farBoardB)
	if !a.Archived || !b.Archived || a.Op == "" || a.Op != b.Op {
		t.Fatalf("after the group's archive: %+v, %+v", a, b)
	}
	if n := len(f.sent("POST /api/boards/{id}/archive")); n != 2 {
		t.Fatalf("the stand-in got %d archive calls, want 2", n)
	}
	f.good(p, "POST", "/api/groups/"+g+"/unarchive", "")
	a, b = f.boardNow(p, farBoardA), f.boardNow(p, farBoardB)
	if a.Archived || b.Archived {
		t.Fatalf("after the group's unarchive: %+v, %+v", a, b)
	}
	if n := len(f.sent("POST /api/boards/{id}/unarchive")); n != 2 {
		t.Fatalf("the stand-in got %d unarchive calls, want 2", n)
	}
	// One record comes back alone: with it the groups it is nested in.
	f.good(p, "POST", "/api/groups/"+g+"/archive", "")
	f.good(p, "POST", "/api/boards/"+farBoardB+"/unarchive", "")
	if a, b = f.boardNow(p, farBoardA), f.boardNow(p, farBoardB); !a.Archived || b.Archived {
		t.Fatalf("after the unarchive of one record: %+v, %+v", a, b)
	}
	var snap struct{ Groups []model.Group }
	json.Unmarshal([]byte(mustOK(t, f, p, "GET", "/api/state", "")), &snap)
	for _, x := range snap.Groups {
		if x.Archived {
			t.Fatalf("the group %s stayed archived", x.Name)
		}
	}
	f.good(p, "POST", "/api/boards/"+farBoardA+"/unarchive", "")

	// The delete of the group alone moves its record up.
	f.untouched("a delete of the group alone", func() { f.good(p, "DELETE", "/api/groups/"+sub+"?contents=keep", "") })
	if b = f.boardNow(p, farBoardB); b.Group != g {
		t.Fatalf("the record of the deleted group: %+v", b)
	}
	// With the server away nothing is deleted.
	f.down()
	f.untouched("a delete while the server is away", func() {
		text := f.refuses(p, http.StatusConflict, "server_unreachable", "DELETE", "/api/groups/"+g+"?contents=delete", "")
		if !strings.Contains(text, "Nothing was deleted") {
			t.Fatalf("the refusal: %q", text)
		}
	})
	if len(f.boardsNow(p, farBoardA)) != 1 || len(f.boardsNow(p, farBoardB)) != 1 {
		t.Fatal("a board went with the refused delete")
	}
	// Connected again: the boards are deleted on their server, and the records go.
	f.up(2)
	f.good(p, "DELETE", "/api/groups/"+g+"?contents=delete", "")
	if n := len(f.sent("DELETE /api/boards/{id}")); n != 2 {
		t.Fatalf("the stand-in got %d delete calls, want 2", n)
	}
	if len(f.boardsNow(p, farBoardA)) != 0 || len(f.boardsNow(p, farBoardB)) != 0 {
		t.Fatal("a board record stayed after the group's delete")
	}
}
