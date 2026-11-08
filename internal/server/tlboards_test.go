package server

import (
	"os"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

// POST /api/boards with "kind":"tl" makes a tl board that nobody holds; another kind is refused.
func TestCreateTLBoard(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	bd := decode[model.Board](t, e.expect(200, "POST", "/api/boards", `{"name":"n","group":"`+model.Ungrouped+`","kind":"tl"}`))
	if bd.Kind != model.KindTL {
		t.Fatalf("kind %q", bd.Kind)
	}
	if _, held := e.s.Bridge.HolderOf(bd.ID); held {
		t.Fatal("a tl board was taken by the client that made it")
	}
	if _, err := os.Stat(e.st.P.BoardFile(bd.ID)); !os.IsNotExist(err) {
		t.Fatalf("tl board has a drawing: %v", err)
	}
	// A classic board is still taken by its maker, and its record has no kind.
	c := e.board(model.Ungrouped)
	if holder, held := e.s.Bridge.HolderOf(c.ID); !held || holder != clientID {
		t.Fatalf("classic board holder %q %v", holder, held)
	}
	if got := e.expect(200, "GET", "/api/boards/"+c.ID+"/scene", ""); got == "" {
		t.Fatal("classic scene empty")
	}

	n := len(e.a.Boards.List())
	out := e.expect(400, "POST", "/api/boards", `{"name":"x","group":"`+model.Ungrouped+`","kind":"excalidraw"}`)
	if !strings.Contains(out, `"code":"bad_kind"`) {
		t.Fatalf("bad kind answer %s", out)
	}
	if len(e.a.Boards.List()) != n {
		t.Fatal("a refused kind made a board")
	}
}

// The drawing routes and take refuse a tl board (409 "tl_board"); follow answers harmlessly and
// unfollow still works.
func TestTLBoardOldRoutes(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	bd := decode[model.Board](t, e.expect(200, "POST", "/api/boards", `{"name":"n","group":"`+model.Ungrouped+`","kind":"tl"}`))
	path := "/api/boards/" + bd.ID
	for _, c := range []struct{ method, path, body string }{
		{"GET", path + "/scene", ""},
		{"PUT", path + "/scene?rev=0", `{"type":"excalidraw","elements":[]}`},
		{"POST", path + "/take", `{}`},
		{"POST", path + "/take", `{"ifFree":true}`},
	} {
		out := e.expect(409, c.method, c.path, c.body)
		if !strings.Contains(out, `"code":"tl_board"`) {
			t.Errorf("%s %s: %s", c.method, c.path, out)
		}
	}
	if _, held := e.s.Bridge.HolderOf(bd.ID); held {
		t.Fatal("a tl board is held")
	}
	if _, err := os.Stat(e.st.P.BoardFile(bd.ID)); !os.IsNotExist(err) {
		t.Fatalf("tl board got a drawing: %v", err)
	}
	got := decode[map[string]any](t, e.expect(200, "POST", path+"/follow", ""))
	if len(got) != 2 || got["rev"] != float64(0) || got["writer"] != "" {
		t.Fatalf("follow answer %v", got)
	}
	e.expect(200, "POST", path+"/unfollow", "")
	// An unknown board is still 404 on follow.
	e.expect(404, "POST", "/api/boards/b_nope/follow", "")
}
