package remotes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
)

// seededBoards is a rig whose stand-in has the boards ids and whose relay has their records, in
// the local group g_here.
func seededBoards(t *testing.T, o rigOpt, ids ...string) *rig {
	t.Helper()
	views := []model.Board{}
	for _, id := range ids {
		d := boardSeedOf(id)
		o.boardSeed = append(o.boardSeed, d)
		views = append(views, d.View)
	}
	o.snapshot = snapshotWithBoards(views...)
	return newRig(t, o)
}

// nextOf is the page's next event of the type; the ones before it are passed over.
func nextOf(p *bridgetest.Page, typ string) map[string]any {
	for {
		if ev := p.Next(); ev["type"] == typ {
			return ev
		}
	}
}

// boardIn is the board id of a path /api/boards/{id}….
func boardIn(r *http.Request) string { return r.PathValue("id") }

// madeBoard answers a creation call as a server that makes the board.
func madeBoard(w http.ResponseWriter, r *http.Request) {
	var body struct{ Name string }
	_ = json.NewDecoder(r.Body).Decode(&body)
	bd := remoteBoard(boardIn(r))
	bd.Name = body.Name
	writeAnswer(w, http.StatusOK, map[string]any{"ok": true, "made": true, "board": bd})
}

// creation is the stand-in's creation route: the bodies it got, and its answer.
type creation struct {
	mu     sync.Mutex
	ids    []string
	bodies []string
	h      http.HandlerFunc
}

func creationRoute(rg *rig) *creation {
	c := &creation{h: madeBoard}
	rg.s.Handle("PUT /api/boards/{id}", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		c.mu.Lock()
		n := len(c.ids)
		c.ids, c.bodies = append(c.ids, boardIn(r)), append(c.bodies, string(body))
		h := c.h
		c.mu.Unlock()
		r.Header.Set("X-Test-Call", string(rune('0'+n)))
		r.Body = io.NopCloser(bytes.NewReader(body))
		h(w, r)
	})
	return c
}

func (c *creation) set(h http.HandlerFunc) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.h = h
}

func (c *creation) got() (ids, bodies []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.ids...), append([]string(nil), c.bodies...)
}

// nth is the number of the creation call the request is, from 0.
func nth(r *http.Request) int { return int(r.Header.Get("X-Test-Call")[0] - '0') }

// TestCreateBoard: this server makes the id, the board's server makes the board, and the record
// is in the group the page chose, although the board's event overtakes the answer.
func TestCreateBoard(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{snapshot: snapshotWithBoards()})
	c := creationRoute(rg)
	c.set(func(w http.ResponseWriter, r *http.Request) {
		rg.s.Send(map[string]any{"type": "board", "board": remoteBoard(boardIn(r))})
		time.Sleep(50 * time.Millisecond) // the event is taken first
		madeBoard(w, r)
	})
	var asked []string
	rg.r.SetLocalBoards(func(id string) bool {
		asked = append(asked, id)
		return len(asked) == 1 // the first id is a board's of this server
	})
	p, _ := rg.page("page-1")

	v, e := rg.r.CreateBoard(context.Background(), rg.entry, "Untitled", "g_here")
	if e != nil {
		t.Fatalf("CreateBoard: %v", e)
	}
	ids, bodies := c.got()
	if len(ids) != 1 || ids[0] != v.ID || bodies[0] != `{"name":"Untitled"}` {
		t.Errorf("the server got %v %v for the board %s", ids, bodies, v.ID)
	}
	if len(asked) != 2 || asked[0] == v.ID || asked[1] != v.ID || !validBoardID(v.ID) {
		t.Errorf("the id %s, of %v", v.ID, asked)
	}
	if v.Name != "Untitled" || v.Group != "g_here" || v.Server != rg.entry || v.Client != "" {
		t.Errorf("the view: %+v", v)
	}
	if d := rg.boardFile(v.ID); d.Entry != rg.entry || d.Group != "g_here" || d.View.Name != "Untitled" || d.View.Client != testLocalID {
		t.Errorf("the record: %+v", d)
	}
	if ev := p.Expect("board"); field(ev, "board", "id") != v.ID || field(ev, "board", "group") != "g_here" || field(ev, "board", "server") != rg.entry {
		t.Errorf("the event: %v", ev)
	}
	if got, ok := rg.r.BoardView(v.ID); !ok || !reflect.DeepEqual(got, v) {
		t.Errorf("BoardView: %+v", got)
	}

	// A group that cannot be a record's place, and an entry that is none: nothing is sent.
	rg.r.o.Group = func(id string) (bool, bool) { return id == "g_here" || id == "g_old", id == "g_old" }
	for group, status := range map[string]int{"": http.StatusBadRequest, "g_none": http.StatusNotFound, "g_old": http.StatusConflict} {
		if _, e := rg.r.CreateBoard(context.Background(), rg.entry, "Untitled", group); e == nil || e.Status != status {
			t.Errorf("the group %q: %v", group, e)
		}
	}
	for _, entry := range []string{"s_000000000000", servers.LocalID} {
		if _, e := rg.r.CreateBoard(context.Background(), entry, "Untitled", "g_here"); e == nil || e.Status != http.StatusBadRequest {
			t.Errorf("the entry %q: %v", entry, e)
		}
	}
	if ids, _ := c.got(); len(ids) != 1 || len(rg.r.BoardViews()) != 1 {
		t.Errorf("the refused creations sent %v", ids)
	}
}

// TestCreateBoardRepeat: a creation call with no answer is made once more, with the same id.
func TestCreateBoardRepeat(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{snapshot: snapshotWithBoards()})
	c := creationRoute(rg)
	c.set(func(w http.ResponseWriter, r *http.Request) {
		if nth(r) == 0 {
			panic(http.ErrAbortHandler) // the board was made, the answer is lost
		}
		bd := remoteBoard(boardIn(r))
		writeAnswer(w, http.StatusOK, map[string]any{"ok": true, "made": false, "board": bd})
	})
	v, e := rg.r.CreateBoard(context.Background(), rg.entry, "Untitled", "g_here")
	ids, _ := c.got()
	if e != nil || len(ids) != 2 || ids[0] != ids[1] || ids[0] != v.ID || !rg.r.HasBoard(v.ID) {
		t.Fatalf("the repeat: %v, calls %v, board %+v", e, ids, v)
	}

	// No answer to the repeat either: 504, and no record.
	c.set(func(http.ResponseWriter, *http.Request) { panic(http.ErrAbortHandler) })
	_, e = rg.r.CreateBoard(context.Background(), rg.entry, "Untitled", "g_here")
	ids, _ = c.got()
	if e == nil || e.Status != http.StatusGatewayTimeout || e.Code != "no_answer" || len(ids) != 4 || ids[2] != ids[3] {
		t.Fatalf("no answer twice: %v, calls %v", e, ids)
	}
	if rg.r.HasBoard(ids[3]) || len(rg.r.BoardViews()) != 1 {
		t.Errorf("a record was made: %+v", rg.r.BoardViews())
	}
	// The board was made after all: its next event adopts it, in the ungrouped area.
	rg.s.Send(map[string]any{"type": "board", "board": remoteBoard(ids[3])})
	rg.until("the lost board is adopted", func() bool { return rg.r.HasBoard(ids[3]) })
	if _, group, _, _ := rg.r.BoardOn(ids[3]); group != model.Ungrouped {
		t.Errorf("the adopted board is in %q", group)
	}
}

// TestCreateBoardRefused: an id the server has is replaced once; a server without board routes;
// any other refusal is the server's.
func TestCreateBoardRefused(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{snapshot: snapshotWithBoards()})
	ctx := context.Background()

	// No board routes: the 404 of a route that is not there.
	if _, e := rg.r.CreateBoard(ctx, rg.entry, "Untitled", "g_here"); e == nil || e.Status != http.StatusBadGateway ||
		e.Code != "no_boards" || e.Text != "Studio does not serve boards. Update it." {
		t.Errorf("a server without boards: %+v", e)
	}

	c := creationRoute(rg)
	taken := func(w http.ResponseWriter, r *http.Request) {
		writeAnswer(w, http.StatusConflict, map[string]string{"error": "the id is taken", "code": "id_taken"})
	}
	c.set(func(w http.ResponseWriter, r *http.Request) {
		if nth(r) == 0 {
			taken(w, r)
			return
		}
		madeBoard(w, r)
	})
	v, e := rg.r.CreateBoard(ctx, rg.entry, "Untitled", "g_here")
	ids, _ := c.got()
	if e != nil || len(ids) != 2 || ids[0] == ids[1] || v.ID != ids[1] || rg.r.HasBoard(ids[0]) {
		t.Fatalf("a taken id: %v, calls %v, board %+v", e, ids, v)
	}
	// Taken twice: that is the answer.
	c.set(taken)
	if _, e := rg.r.CreateBoard(ctx, rg.entry, "Untitled", "g_here"); e == nil || e.Status != http.StatusConflict || e.Code != "id_taken" {
		t.Errorf("taken twice: %+v", e)
	}
	if ids, _ := c.got(); len(ids) != 4 || ids[2] == ids[3] {
		t.Errorf("taken twice: calls %v", ids)
	}
	// Another refusal, passed as it came, with one call.
	c.set(func(w http.ResponseWriter, r *http.Request) {
		writeAnswer(w, http.StatusBadRequest, map[string]string{"error": "the name is refused", "code": "bad_request"})
	})
	if _, e := rg.r.CreateBoard(ctx, rg.entry, "Untitled", "g_here"); e == nil || e.Status != http.StatusBadRequest ||
		e.Code != "bad_request" || e.Text != "the name is refused" {
		t.Errorf("a refusal: %+v", e)
	}
	// An answer that is not the creation's.
	c.set(func(w http.ResponseWriter, r *http.Request) {
		writeAnswer(w, http.StatusOK, map[string]any{"ok": true, "board": remoteBoard(boardB)})
	})
	if _, e := rg.r.CreateBoard(ctx, rg.entry, "Untitled", "g_here"); e == nil || e.Status != http.StatusBadGateway || e.Code != "bad_answer" {
		t.Errorf("the board of another id: %+v", e)
	}
	if ids, _ := c.got(); len(ids) != 6 || len(rg.r.BoardViews()) != 1 {
		t.Errorf("calls %v, boards %+v", ids, rg.r.BoardViews())
	}

	// Not connected: 503, nothing is sent and nothing made.
	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	if _, e := rg.r.CreateBoard(ctx, rg.entry, "Untitled", "g_here"); e == nil || e.Status != http.StatusServiceUnavailable ||
		e.Code != "server_unreachable" || !errors.Is(e, ErrUnreachable) {
		t.Errorf("a creation while the server is away: %+v", e)
	}
	if ids, _ := c.got(); len(ids) != 6 || len(rg.r.BoardViews()) != 1 {
		t.Errorf("while the server is away: calls %v, boards %+v", ids, rg.r.BoardViews())
	}
}

// TestRenameBoard: the name is the board's server's.
func TestRenameBoard(t *testing.T) {
	t.Parallel()
	rg := seededBoards(t, rigOpt{}, boardA, boardB)
	rename := rg.script("POST /api/boards/{id}/rename")
	rename.set(func(w http.ResponseWriter, r *http.Request) {
		bd := remoteBoard(boardIn(r))
		bd.Name = "Plan"
		writeAnswer(w, http.StatusOK, bd)
	})
	ctx := context.Background()
	p, _ := rg.page("page-1")

	rep := rg.r.RenameBoard(ctx, boardA, []byte(`{"name":"Plan"}`))
	var v model.Board
	if rep.Status != http.StatusOK || json.Unmarshal(rep.Body, &v) != nil || v.Name != "Plan" || v.Group != "g_here" || v.Server != rg.entry || v.Client != "" {
		t.Fatalf("the rename: %d %s", rep.Status, rep.Body)
	}
	if q := rename.last(t); q.Method != http.MethodPost || q.URI != "/api/boards/"+boardA+"/rename" || q.Body != `{"name":"Plan"}` {
		t.Errorf("the server got %+v", q)
	}
	if ev := p.Expect("board"); field(ev, "board", "id") != boardA || field(ev, "board", "name") != "Plan" {
		t.Errorf("the event: %v", ev)
	}
	rg.until("the record has the name", func() bool { return rg.boardFile(boardA).View.Name == "Plan" })

	// A refusal of the server is handed on; the answer of another board is not taken.
	rename.answer(http.StatusBadRequest, map[string]string{"error": "the name is empty"})
	if rep := rg.r.RenameBoard(ctx, boardA, []byte(`{"name":""}`)); rep.Status != http.StatusBadRequest || !strings.Contains(string(rep.Body), "the name is empty") {
		t.Errorf("a refused rename: %d %s", rep.Status, rep.Body)
	}
	rename.answer(http.StatusOK, remoteBoard(boardB))
	if rep := rg.r.RenameBoard(ctx, boardA, []byte(`{"name":"X"}`)); rep.Status != http.StatusBadGateway {
		t.Errorf("the answer of another board: %d %s", rep.Status, rep.Body)
	}
	if rep := rg.r.RenameBoard(ctx, boardC, []byte(`{"name":"X"}`)); rep.Status != http.StatusNotFound {
		t.Errorf("no record: %d %s", rep.Status, rep.Body)
	}
	// The server has no such board: the record is marked gone.
	rename.answer(http.StatusNotFound, map[string]string{"error": "no such board"})
	if rep := rg.r.RenameBoard(ctx, boardB, []byte(`{"name":"X"}`)); rep.Status != http.StatusNotFound || !strings.Contains(string(rep.Body), "gone_there") {
		t.Errorf("a board that is gone: %d %s", rep.Status, rep.Body)
	}
	if ev := p.Expect("board"); field(ev, "board", "id") != boardB || field(ev, "board", "gone") != true {
		t.Errorf("the gone mark: %v", ev)
	}

	// Not connected: refused, nothing is sent.
	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	sent := rename.count()
	if rep := rg.r.RenameBoard(ctx, boardA, []byte(`{"name":"Later"}`)); rep.Status != http.StatusServiceUnavailable || !strings.Contains(string(rep.Body), "server_unreachable") {
		t.Errorf("a rename while the server is away: %d %s", rep.Status, rep.Body)
	}
	if got, _ := rg.r.BoardView(boardA); got.Name != "Plan" || rename.count() != sent {
		t.Errorf("the name changed, or a call was sent: %+v", got)
	}
	if rep := rg.r.SeenBoard(ctx, boardA); rep.Status != http.StatusServiceUnavailable {
		t.Errorf("seen while the server is away: %d %s", rep.Status, rep.Body)
	}
}

// TestMoveBoard: the place of a board record is this server's alone, connected or not.
func TestMoveBoard(t *testing.T) {
	t.Parallel()
	rg := seededBoards(t, rigOpt{wire: func(rg *rig) {
		rg.r.o.Group = func(id string) (bool, bool) { return id == "g_here" || id == "g_new" || id == "g_old", id == "g_old" }
	}}, boardA)
	seen := rg.script("POST /api/boards/{id}/seen")
	seen.answer(http.StatusOK, map[string]bool{"ok": true})
	p, _ := rg.page("page-1")

	if rep := rg.r.PatchBoard(boardA, "g_new"); rep.Status != http.StatusOK || string(rep.Body) != `{"ok":true}` {
		t.Fatalf("the move: %d %s", rep.Status, rep.Body)
	}
	if ev := p.Expect("board"); field(ev, "board", "id") != boardA || field(ev, "board", "group") != "g_new" {
		t.Errorf("the event: %v", ev)
	}
	if d := rg.boardFile(boardA); d.Group != "g_new" {
		t.Errorf("the record: %+v", d)
	}
	for group, status := range map[string]int{"": http.StatusBadRequest, "g_none": http.StatusNotFound, "g_old": http.StatusConflict} {
		if rep := rg.r.PatchBoard(boardA, group); rep.Status != status {
			t.Errorf("a move to %q: %d %s", group, rep.Status, rep.Body)
		}
	}
	if rep := rg.r.PatchBoard(boardB, "g_new"); rep.Status != http.StatusNotFound {
		t.Errorf("no record: %d %s", rep.Status, rep.Body)
	}
	if err := rg.r.MoveBoard(boardB, "g_new"); !errors.Is(err, ErrNoBoard) {
		t.Errorf("MoveBoard of no record: %v", err)
	}
	// Seen is passed on.
	if rep := rg.r.SeenBoard(context.Background(), boardA); rep.Status != http.StatusOK || seen.last(t).URI != "/api/boards/"+boardA+"/seen" {
		t.Errorf("seen: %d %s", rep.Status, rep.Body)
	}

	// While the server is away the move works; a group's delete moves with no check.
	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	if rep := rg.r.PatchBoard(boardA, model.Ungrouped); rep.Status != http.StatusOK {
		t.Errorf("a move while the server is away: %d %s", rep.Status, rep.Body)
	}
	if err := rg.r.MoveBoard(boardA, "g_old"); err != nil || rg.boardFile(boardA).Group != "g_old" {
		t.Errorf("MoveBoard: %v, %+v", err, rg.boardFile(boardA))
	}
	if n := len(rg.requests(http.MethodPatch, "")); n != 0 {
		t.Errorf("the server got %d PATCH calls", n)
	}
}

// boardArchiveRoutes makes the stand-in answer the archive and the unarchive of every board with 200.
func boardArchiveRoutes(rg *rig) (archive, unarchive *script) {
	archive, unarchive = rg.script("POST /api/boards/{id}/archive"), rg.script("POST /api/boards/{id}/unarchive")
	archive.answer(http.StatusOK, map[string]bool{"ok": true})
	unarchive.answer(http.StatusOK, map[string]bool{"ok": true})
	return archive, unarchive
}

// TestBoardArchiveConnected: archive and unarchive of a board record whose server answers.
func TestBoardArchiveConnected(t *testing.T) {
	t.Parallel()
	rg := seededBoards(t, rigOpt{}, boardA, boardB)
	archive, unarchive := boardArchiveRoutes(rg)
	ctx := context.Background()
	p, _ := rg.page("page-1")

	if err := rg.r.ArchiveBoard(ctx, boardA, "a_1"); err != nil {
		t.Fatalf("an archive: %v", err)
	}
	if q := archive.last(t); q.Method != http.MethodPost || q.URI != "/api/boards/"+boardA+"/archive" || q.Body != "" {
		t.Errorf("the server got %+v", q)
	}
	for _, what := range []string{"at once", "confirmed"} {
		if ev := p.Expect("board"); field(ev, "board", "id") != boardA || field(ev, "board", "archived") != true || field(ev, "board", "archiveOp") != "a_1" {
			t.Errorf("the mark %s: %v", what, ev)
		}
	}
	if d := rg.boardFile(boardA); !d.Archived || d.Pending != "" || d.Op != "a_1" {
		t.Errorf("the record: %+v", d)
	}
	if got := rg.r.BoardsArchivedWith("a_1"); !reflect.DeepEqual(got, []string{boardA}) {
		t.Errorf("BoardsArchivedWith: %v", got)
	}
	if got := rg.r.BoardsArchivedWith(""); got == nil || len(got) != 0 {
		t.Errorf("BoardsArchivedWith of no action: %v", got)
	}
	if _, _, archived, _ := rg.r.BoardOn(boardA); !archived {
		t.Error("BoardOn does not tell the mark")
	}
	// A record that is archived keeps its mark and its action; nothing is sent.
	sent := archive.count()
	if err := rg.r.ArchiveBoard(ctx, boardA, "a_2"); err != nil || rg.boardFile(boardA).Op != "a_1" || archive.count() != sent {
		t.Errorf("a second archive: %v, %+v", err, rg.boardFile(boardA))
	}
	// The user's own archive makes an action id.
	if err := rg.r.ArchiveBoard(ctx, boardB, ""); err != nil || !strings.HasPrefix(rg.boardFile(boardB).Op, "a_") {
		t.Errorf("an archive by the user: %v, %+v", err, rg.boardFile(boardB))
	}
	p.Expect("board")
	p.Expect("board")

	if err := rg.r.UnarchiveBoard(ctx, boardA); err != nil {
		t.Fatalf("an unarchive: %v", err)
	}
	if q := unarchive.last(t); q.URI != "/api/boards/"+boardA+"/unarchive" {
		t.Errorf("the server got %+v", q)
	}
	for range 2 {
		if ev := p.Expect("board"); field(ev, "board", "archived") != nil || field(ev, "board", "archiveOp") != nil {
			t.Errorf("the unarchive: %v", ev)
		}
	}
	if d := rg.boardFile(boardA); d.Archived || d.Pending != "" || d.Op != "" {
		t.Errorf("the record: %+v", d)
	}

	// A refusal undoes the change here and is returned.
	archive.answer(http.StatusConflict, map[string]string{"error": "the board is in use"})
	err := rg.r.ArchiveBoard(ctx, boardA, "a_3")
	var e *Error
	if !errors.As(err, &e) || e.Status != http.StatusConflict || e.Text != "the board is in use" {
		t.Errorf("a refused archive: %v", err)
	}
	if d := rg.boardFile(boardA); d.Archived || d.Pending != "" || d.Op != "" {
		t.Errorf("the record after a refusal: %+v", d)
	}
	if err := rg.r.ArchiveBoard(ctx, boardC, ""); !errors.Is(err, ErrNoBoard) {
		t.Errorf("no record: %v", err)
	}
}

// TestBoardArchivePending: a change made while the board's server is away shows at once, stays
// pending, wins over that server's mark at the return and is passed on then.
func TestBoardArchivePending(t *testing.T) {
	t.Parallel()
	rg := seededBoards(t, rigOpt{}, boardA, boardB)
	archive, unarchive := boardArchiveRoutes(rg)
	ctx := context.Background()
	p, _ := rg.page("page-1")

	// boardB is archived and confirmed; its unarchive will be the pending change.
	if err := rg.r.ArchiveBoard(ctx, boardB, "a_b"); err != nil {
		t.Fatal(err)
	}
	p.Expect("board")
	p.Expect("board")

	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	if err := rg.r.ArchiveBoard(ctx, boardA, "a_down"); err != nil {
		t.Errorf("an archive while the server is away: %v", err)
	}
	if err := rg.r.UnarchiveBoard(ctx, boardB); err != nil {
		t.Errorf("an unarchive while the server is away: %v", err)
	}
	if ev := p.Expect("board"); field(ev, "board", "id") != boardA || field(ev, "board", "archived") != true || field(ev, "board", "archiveOp") != "a_down" {
		t.Errorf("the mark does not show at once: %v", ev)
	}
	if ev := p.Expect("board"); field(ev, "board", "id") != boardB || field(ev, "board", "archived") != nil {
		t.Errorf("the unarchive does not show at once: %v", ev)
	}
	if a, b := rg.boardFile(boardA), rg.boardFile(boardB); a.Pending != pendingArchive || a.Archived || a.Op != "a_down" ||
		b.Pending != pendingUnarchive || !b.Archived || b.Op != "" {
		t.Errorf("the records while the server is away: %+v\n%+v", a, b)
	}
	before := archive.count() + unarchive.count()

	// The return: the snapshot tells the marks as that server has them, the reverse of what is
	// pending. The pending changes win, and are passed on.
	a, b := remoteBoard(boardA), remoteBoard(boardB)
	b.Archived, b.Op = true, "a_there"
	rg.s.SetSnapshot(snapshotWithBoards(a, b))
	rg.s.Restart()
	rg.returned(2)
	nextOf(p, "server_back")
	if ev := p.Expect("board"); field(ev, "board", "id") != boardA || field(ev, "board", "archived") != true || field(ev, "board", "archiveOp") != "a_down" {
		t.Errorf("the snapshot's mark won over the pending archive: %v", ev)
	}
	if ev := p.Expect("board"); field(ev, "board", "id") != boardB || field(ev, "board", "archived") != nil {
		t.Errorf("the snapshot's mark won over the pending unarchive: %v", ev)
	}
	rg.until("the pending changes are passed on", func() bool { return archive.count()+unarchive.count() == before+2 })
	if q := archive.last(t); q.URI != "/api/boards/"+boardA+"/archive" {
		t.Errorf("the archive that was passed on: %+v", q)
	}
	if q := unarchive.last(t); q.URI != "/api/boards/"+boardB+"/unarchive" {
		t.Errorf("the unarchive that was passed on: %+v", q)
	}
	rg.until("the changes are confirmed", func() bool {
		a, b := rg.boardFile(boardA), rg.boardFile(boardB)
		return a.Pending == "" && a.Archived && a.Op == "a_down" && b.Pending == "" && !b.Archived
	})
}

// TestDeleteBoard: the board is deleted on its server, then the record goes, with the records
// of the chats on the board.
func TestDeleteBoard(t *testing.T) {
	t.Parallel()
	onBoard := seedOf(chatA)
	onBoard.Group, onBoard.View.Board = "", boardA
	rg := seededBoards(t, rigOpt{seed: []Record{onBoard, seedOf(chatB)}}, boardA, boardB, boardC)
	del := rg.script("DELETE /api/boards/{id}")
	del.answer(http.StatusOK, map[string]bool{"ok": true})
	ctx := context.Background()
	p, _ := rg.page("page-1")

	// "Remove from this sidebar" is refused while the server is connected.
	err := rg.r.DeleteBoard(ctx, boardA, true)
	var e *Error
	if !errors.As(err, &e) || e.Status != http.StatusConflict || e.Code != "server_connected" || del.count() != 0 || !rg.r.HasBoard(boardA) {
		t.Errorf("a local delete while connected: %v", err)
	}
	if err := rg.r.DeleteBoard(ctx, boardA, false); err != nil {
		t.Fatalf("the delete: %v", err)
	}
	if q := del.last(t); q.Method != http.MethodDelete || q.URI != "/api/boards/"+boardA {
		t.Errorf("the server got %+v", q)
	}
	if ev := p.Expect("chat_removed"); ev["id"] != chatA {
		t.Errorf("the chat on the board: %v", ev)
	}
	if ev := p.Expect("board_removed"); ev["id"] != boardA {
		t.Errorf("the event: %v", ev)
	}
	if rg.r.HasBoard(boardA) || rg.r.Has(chatA) || !rg.r.Has(chatB) {
		t.Error("the records after the delete")
	}
	if err := rg.r.DeleteBoard(ctx, boardA, false); !errors.Is(err, ErrNoBoard) {
		t.Errorf("no record: %v", err)
	}
	// The server has no such board: the record goes all the same.
	del.answer(http.StatusNotFound, map[string]string{"error": "no such board"})
	if err := rg.r.DeleteBoard(ctx, boardC, false); err != nil || rg.r.HasBoard(boardC) {
		t.Errorf("a board that is gone there: %v", err)
	}
	nextOf(p, "board_removed")
	// A refusal: the record stays.
	del.answer(http.StatusConflict, map[string]string{"error": "the board is in use"})
	if err := rg.r.DeleteBoard(ctx, boardB, false); !errors.As(err, &e) || e.Status != http.StatusConflict || !rg.r.HasBoard(boardB) {
		t.Errorf("a refused delete: %v", err)
	}
	del.answer(http.StatusOK, map[string]bool{"ok": true})

	// Not connected: refused, the record stays, nothing is sent.
	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	sent := del.count()
	err = rg.r.DeleteBoard(ctx, boardB, false)
	if !errors.As(err, &e) || e.Status != http.StatusServiceUnavailable || e.Code != "server_unreachable" || e.Text != "Studio is not connected." {
		t.Errorf("a delete while the server is away: %v", err)
	}
	if !rg.r.HasBoard(boardB) || del.count() != sent {
		t.Error("the record went, or a call was sent")
	}
	// "Remove from this sidebar" drops the record alone.
	if err := rg.r.DeleteBoard(ctx, boardB, true); err != nil || rg.r.HasBoard(boardB) || del.count() != sent {
		t.Errorf("a local delete while the server is away: %v", err)
	}
	if ev := p.Expect("board_removed"); ev["id"] != boardB {
		t.Errorf("the event: %v", ev)
	}
}

// TestDeleteBoardGone: a record that is gone is removed with no call, connected or not.
func TestDeleteBoardGone(t *testing.T) {
	t.Parallel()
	rg := seededBoards(t, rigOpt{}, boardA, boardB)
	del := rg.script("DELETE /api/boards/{id}")
	rg.markGoneBoards(boardA, boardB)
	if err := rg.r.DeleteBoard(context.Background(), boardA, false); err != nil || rg.r.HasBoard(boardA) {
		t.Errorf("the delete of a gone board: %v", err)
	}
	if err := rg.r.DeleteBoard(context.Background(), boardB, true); err != nil || rg.r.HasBoard(boardB) {
		t.Errorf("the local delete of a gone board: %v", err)
	}
	if del.count() != 0 {
		t.Errorf("the server got %+v", del.calls())
	}
}

func (rg *rig) markGoneBoards(ids ...string) {
	rg.t.Helper()
	for _, id := range ids {
		rg.r.markBoardGone(rg.r.boardRec(id))
	}
}
