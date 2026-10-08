package remotes

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// there is the board side of the stand-in server: it answers the take, the release, the scene
// and the tool call replies as the test set them, and notes each call.
type there struct {
	rg *rig

	mu      sync.Mutex
	log     []string                                 // "take <id> ifFree=<bool>", "release <id>", "get <id>", "put <id> rev=<n> <body>", "reply <body>"
	take    func(id string, ifFree bool) thereAnswer // nil = held at revision 1
	release string                                   // the release's state; "" = "free"
	leaving func()                                   // called by a release before its answer; nil = nothing
	put     thereAnswer                              // zero = 200 {"ok":true,"rev":<base+1>}
	scene   func(w http.ResponseWriter)              // nil = {"elements":[]} at revision 4
}

type thereAnswer struct {
	status int // 0 = 200
	body   any
}

func heldThereAt(rev int64) thereAnswer {
	return thereAnswer{body: map[string]any{"state": "held", "rev": rev}}
}

func stateThere(state string) thereAnswer {
	return thereAnswer{body: map[string]any{"state": state}}
}

func (a thereAnswer) write(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	if a.status != 0 {
		w.WriteHeader(a.status)
	}
	_ = json.NewEncoder(w).Encode(a.body)
}

func (th *there) note(format string, args ...any) {
	th.mu.Lock()
	defer th.mu.Unlock()
	th.log = append(th.log, fmt.Sprintf(format, args...))
}

// set changes how the stand-in answers.
func (th *there) set(f func()) {
	th.mu.Lock()
	defer th.mu.Unlock()
	f()
}

// calls are the noted calls that start with prefix.
func (th *there) calls(prefix string) []string {
	th.mu.Lock()
	defer th.mu.Unlock()
	var out []string
	for _, l := range th.log {
		if strings.HasPrefix(l, prefix) {
			out = append(out, l)
		}
	}
	return out
}

// wait waits until n calls that start with prefix were noted, and returns them.
func (th *there) wait(prefix string, n int) []string {
	th.rg.t.Helper()
	th.rg.until(fmt.Sprintf("%d calls %q", n, prefix), func() bool { return len(th.calls(prefix)) >= n })
	return th.calls(prefix)
}

// holdRig is a rig whose bridge is wired to the relay as the server wires it, with the board
// routes of the stand-in server.
func holdRig(t *testing.T, o rigOpt, ids ...string) (*rig, *there) {
	t.Helper()
	var views []model.Board
	for _, id := range ids {
		o.boardSeed = append(o.boardSeed, boardSeedOf(id))
		views = append(views, remoteBoard(id))
	}
	o.snapshot = snapshotWithBoards(views...)
	o.wire = func(rg *rig) {
		rg.b.SceneRev = func(id string) int64 {
			rev, _ := rg.r.BoardRev(id)
			return rev
		}
		rg.b.OnBoardFree(rg.r.BoardFree)
	}
	o.hold = true
	rg := newRig(t, o)
	th := &there{rg: rg}
	rg.s.Handle("POST /api/boards/{id}/take", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ IfFree bool }
		_ = json.NewDecoder(r.Body).Decode(&body)
		th.note("take %s ifFree=%v", r.PathValue("id"), body.IfFree)
		th.mu.Lock()
		f := th.take
		th.mu.Unlock()
		ans := heldThereAt(1)
		if f != nil {
			ans = f(r.PathValue("id"), body.IfFree)
		}
		ans.write(w)
	})
	rg.s.Handle("POST /api/boards/{id}/release", func(w http.ResponseWriter, r *http.Request) {
		th.note("release %s", r.PathValue("id"))
		th.mu.Lock()
		state, leaving := th.release, th.leaving
		th.mu.Unlock()
		if leaving != nil {
			leaving()
		}
		if state == "" {
			state = "free"
		}
		stateThere(state).write(w)
	})
	rg.s.Handle("GET /api/boards/{id}/scene", func(w http.ResponseWriter, r *http.Request) {
		th.note("get %s", r.PathValue("id"))
		th.mu.Lock()
		f := th.scene
		th.mu.Unlock()
		if f != nil {
			f(w)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set(sceneRevHeader, "4")
		_, _ = w.Write([]byte(`{"elements":[]}`))
	})
	rg.s.Handle("PUT /api/boards/{id}/scene", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		th.note("put %s rev=%s %s", r.PathValue("id"), r.URL.Query().Get("rev"), b)
		th.mu.Lock()
		ans := th.put
		th.mu.Unlock()
		if ans.body == nil {
			var base int64
			_, _ = fmt.Sscan(r.URL.Query().Get("rev"), &base)
			ans.body = map[string]any{"ok": true, "rev": base + 1}
		}
		ans.write(w)
	})
	rg.s.Handle("POST /api/rpc-reply", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		th.note("reply %s", b)
		thereAnswer{body: map[string]any{"ok": true}}.write(w)
	})
	rg.start()
	return rg, th
}

// role returns the page's next role event (held, release_request, superseded, rpc), which must
// be of the type typ: the events of the lists are passed over.
func role(t *testing.T, p *bridgetest.Page, typ string) map[string]any {
	t.Helper()
	for {
		ev := p.Next()
		switch ev["type"] {
		case "held", "release_request", "superseded", "rpc":
			if ev["type"] != typ {
				t.Fatalf("page %s: got %v, want %s", p.ID, ev, typ)
			}
			return ev
		}
	}
}

// noRole fails when one of the pages got a role event by now.
func noRole(t *testing.T, rg *rig, pages ...*bridgetest.Page) {
	t.Helper()
	for i, got := range rg.barrier(pages...) {
		for _, ev := range got {
			switch ev["type"] {
			case "held", "release_request", "superseded", "rpc":
				t.Errorf("page %s got %v", pages[i].ID, ev)
			}
		}
	}
}

// reply reads an answer of the relay.
func reply(t *testing.T, rep Reply) (status int, body map[string]any) {
	t.Helper()
	if err := json.Unmarshal(rep.Body, &body); err != nil {
		t.Fatalf("the answer %q: %v", rep.Body, err)
	}
	return rep.Status, body
}

// wantReply fails unless the answer has the status and these members.
func wantReply(t *testing.T, what string, rep Reply, status int, members map[string]any) {
	t.Helper()
	got, body := reply(t, rep)
	if got != status {
		t.Errorf("%s: status %d, want %d: %s", what, got, status, rep.Body)
		return
	}
	for k, v := range members {
		if !reflect.DeepEqual(body[k], v) {
			t.Errorf("%s: %q is %v, want %v: %s", what, k, body[k], v, rep.Body)
		}
	}
}

// holdOf is what the record believes of the board's server.
func holdOf(rg *rig, id string) (heldThere bool, want string) {
	rec := rg.r.boardRec(id)
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return rec.heldThere, rec.want
}

// holder is the page that holds the board here, "" for none.
func holder(rg *rig, id string) string {
	h, _ := rg.b.HolderOf(id)
	return h
}

// offline stops the stand-in server and waits until the entry is no longer connected.
func offline(rg *rig) {
	rg.t.Helper()
	rg.s.Stop()
	rg.until("the entry is not connected", func() bool { return !rg.r.connected(rg.entry) })
}

// TestBoardTake: a free board is taken on its server for the page; two pages of this server
// change nothing there; the last release releases there.
func TestBoardTake(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA)
	ctx := t.Context()
	p1, _ := rg.page("page-1")
	p2, _ := rg.page("page-2")
	th.set(func() { th.take = func(string, bool) thereAnswer { return heldThereAt(7) } })

	wantReply(t, "no record", rg.r.TakeBoard(ctx, p1.ID, boardB, false), http.StatusNotFound, map[string]any{"error": "no such board"})
	wantReply(t, "no record", rg.r.ReleaseBoard(ctx, p1.ID, boardB), http.StatusNotFound, nil)
	wantReply(t, "unknown page", rg.r.TakeBoard(ctx, "page-9", boardA, false), http.StatusConflict, map[string]any{"error": "unknown_client"})
	if got := th.calls(""); got != nil {
		t.Fatalf("the server was called: %v", got)
	}

	wantReply(t, "take", rg.r.TakeBoard(ctx, p1.ID, boardA, true), http.StatusOK, map[string]any{"state": "held", "rev": 7.0})
	if got := th.calls(""); !reflect.DeepEqual(got, []string{"take " + boardA + " ifFree=true"}) {
		t.Errorf("the server got %v", got)
	}
	if there, want := holdOf(rg, boardA); !there || want != "" || holder(rg, boardA) != p1.ID {
		t.Errorf("after the take: heldThere %v, want %q, holder %q", there, want, holder(rg, boardA))
	}
	if rev, _ := rg.r.BoardRev(boardA); rev != 7 {
		t.Errorf("the revision kept is %d", rev)
	}
	wantReply(t, "take again", rg.r.TakeBoard(ctx, p1.ID, boardA, false), http.StatusOK, map[string]any{"state": "held", "rev": 7.0})

	// A second page of this server: the hand-off is the bridge's, the server hears nothing.
	wantReply(t, "busy here", rg.r.TakeBoard(ctx, p2.ID, boardA, true), http.StatusOK, map[string]any{"state": "busy"})
	wantReply(t, "second page", rg.r.TakeBoard(ctx, p2.ID, boardA, false), http.StatusOK, map[string]any{"state": "waiting"})
	if ev := role(t, p1, "release_request"); ev["board"] != boardA {
		t.Errorf("release_request: %v", ev)
	}
	wantReply(t, "release to the second", rg.r.ReleaseBoard(ctx, p1.ID, boardA), http.StatusOK, map[string]any{"state": "handed"})
	role(t, p1, "superseded")
	if ev := role(t, p2, "held"); ev["rev"] != 7.0 {
		t.Errorf("the second page's held: %v", ev)
	}
	wantReply(t, "release of a page that holds nothing", rg.r.ReleaseBoard(ctx, p1.ID, boardA), http.StatusOK, map[string]any{"state": "none"})
	if got := th.calls(""); len(got) != 1 {
		t.Errorf("two pages changed something on the server: %v", got)
	}
	if there, _ := holdOf(rg, boardA); !there || holder(rg, boardA) != p2.ID {
		t.Errorf("after the hand-off: heldThere %v, holder %q", there, holder(rg, boardA))
	}

	// The last release releases there.
	wantReply(t, "last release", rg.r.ReleaseBoard(ctx, p2.ID, boardA), http.StatusOK, map[string]any{"state": "free"})
	if got := th.calls("release"); len(got) != 1 {
		t.Errorf("releases on the server: %v", got)
	}
	if there, _ := holdOf(rg, boardA); there || holder(rg, boardA) != "" {
		t.Errorf("after the release: heldThere %v, holder %q", there, holder(rg, boardA))
	}

	// The server handed the board to somebody who waited there: the page is told so.
	th.set(func() { th.release = "handed" })
	wantReply(t, "take", rg.r.TakeBoard(ctx, p1.ID, boardA, false), http.StatusOK, map[string]any{"state": "held"})
	wantReply(t, "release, handed there", rg.r.ReleaseBoard(ctx, p1.ID, boardA), http.StatusOK, map[string]any{"state": "handed"})
	role(t, p1, "superseded")

	// Busy there, and a refusal of the server.
	th.set(func() { th.take = func(string, bool) thereAnswer { return stateThere("busy") } })
	wantReply(t, "busy there", rg.r.TakeBoard(ctx, p1.ID, boardA, true), http.StatusOK, map[string]any{"state": "busy"})
	th.set(func() {
		th.take = func(string, bool) thereAnswer {
			return thereAnswer{status: http.StatusConflict, body: map[string]any{"error": "the board is archived"}}
		}
	})
	wantReply(t, "refused there", rg.r.TakeBoard(ctx, p1.ID, boardA, false), http.StatusConflict, map[string]any{"error": "the board is archived"})
	if there, want := holdOf(rg, boardA); there || want != "" || holder(rg, boardA) != "" {
		t.Errorf("after two takes that gave nothing: heldThere %v, want %q, holder %q", there, want, holder(rg, boardA))
	}
	time.Sleep(quiet) // a BoardFree that is still on its way
	if got := th.calls("release"); len(got) != 2 {
		t.Errorf("releases on the server: %v", got)
	}
	noRole(t, rg, p1, p2)
}

// TestBoardRoleEvents: every row of the table of the events of the board's server.
func TestBoardRoleEvents(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA)
	ctx := t.Context()
	p1, _ := rg.page("page-1")
	p2, _ := rg.page("page-2")
	send := func(typ string, rev int64) {
		ev := map[string]any{"type": typ, "board": boardA}
		if typ == "held" {
			ev["rev"] = rev
		}
		rg.s.Send(ev)
	}
	waiting := func(p *bridgetest.Page) {
		t.Helper()
		th.set(func() { th.take = func(string, bool) thereAnswer { return stateThere("waiting") } })
		wantReply(t, "take, waiting there", rg.r.TakeBoard(ctx, p.ID, boardA, false), http.StatusOK, map[string]any{"state": "waiting"})
		if there, want := holdOf(rg, boardA); there || want != p.ID || holder(rg, boardA) != "" {
			t.Fatalf("while waiting: heldThere %v, want %q, holder %q", there, want, holder(rg, boardA))
		}
	}

	// held, a page waits there: it gets the board here and the event.
	waiting(p1)
	send("held", 9)
	if ev := role(t, p1, "held"); ev["board"] != boardA || ev["rev"] != 9.0 {
		t.Errorf("held for the page that waited: %v", ev)
	}
	if there, want := holdOf(rg, boardA); !there || want != "" || holder(rg, boardA) != p1.ID {
		t.Errorf("after held: heldThere %v, want %q, holder %q", there, want, holder(rg, boardA))
	}
	// held, a page holds the board: the server's regrant is the page's.
	send("held", 10)
	if ev := role(t, p1, "held"); ev["rev"] != 10.0 {
		t.Errorf("the regrant: %v", ev)
	}
	if rev, _ := rg.r.BoardRev(boardA); rev != 10 {
		t.Errorf("the revision kept is %d", rev)
	}
	// release_request, a page holds the board: passed to it, and nothing is released yet.
	send("release_request", 0)
	if ev := role(t, p1, "release_request"); ev["board"] != boardA {
		t.Errorf("release_request: %v", ev)
	}
	// superseded, a page holds the board, another waits for it here: both lose it.
	wantReply(t, "second page", rg.r.TakeBoard(ctx, p2.ID, boardA, false), http.StatusOK, map[string]any{"state": "waiting"})
	role(t, p1, "release_request")
	send("superseded", 0)
	role(t, p1, "superseded")
	role(t, p2, "superseded")
	noRole(t, rg, p1, p2)
	if there, _ := holdOf(rg, boardA); there || holder(rg, boardA) != "" {
		t.Errorf("after superseded: heldThere %v, holder %q", there, holder(rg, boardA))
	}
	time.Sleep(quiet) // the BoardFree of the lost board
	if got := th.calls("release"); got != nil {
		t.Errorf("a board the server took was released there: %v", got)
	}

	// superseded, a page waits there: it is told, and no longer waits.
	waiting(p1)
	send("superseded", 0)
	role(t, p1, "superseded")
	// A second page takes the place of the one that waits there.
	waiting(p1)
	waiting(p2)
	role(t, p1, "superseded")
	send("superseded", 0)
	role(t, p2, "superseded")
	noRole(t, rg, p1, p2)
	if _, want := holdOf(rg, boardA); want != "" {
		t.Errorf("a page still waits: %q", want)
	}

	// held and release_request with no page: the board is released there.
	send("held", 11)
	th.wait("release", 1)
	send("release_request", 0)
	th.wait("release", 2)
	// held for a page that is gone: released there.
	waiting(p2)
	p2.Close()
	rg.until("the page is gone", func() bool { return !rg.b.Known(p2.ID) })
	send("held", 12)
	th.wait("release", 3)
	if there, want := holdOf(rg, boardA); there || want != "" || holder(rg, boardA) != "" {
		t.Errorf("at the end: heldThere %v, want %q, holder %q", there, want, holder(rg, boardA))
	}
	// An event for a board without a record, and one of another entry, do nothing.
	rg.s.Send(map[string]any{"type": "held", "board": boardB, "rev": 1})
	rg.r.boardRoleEvent("s_other", "superseded", json.RawMessage(`{"board":"`+boardA+`"}`))
	rg.r.boardRoleEvent(rg.entry, "held", json.RawMessage(`{"board":7}`))
	noRole(t, rg, p1)
	if got := th.calls("release"); len(got) != 3 {
		t.Errorf("releases on the server: %v", got)
	}
}

// TestBoardHeldBeforeWaiting: the server's held event overtakes its "waiting" answer.
func TestBoardHeldBeforeWaiting(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA)
	p, _ := rg.page("page-1")
	th.set(func() {
		th.take = func(string, bool) thereAnswer {
			rg.s.Send(map[string]any{"type": "held", "board": boardA, "rev": 6})
			rg.until("the event is taken", func() bool { there, _ := holdOf(rg, boardA); return there })
			return stateThere("waiting")
		}
	})
	wantReply(t, "take", rg.r.TakeBoard(t.Context(), p.ID, boardA, false), http.StatusOK, map[string]any{"state": "waiting"})
	if ev := role(t, p, "held"); ev["rev"] != 6.0 {
		t.Errorf("held: %v", ev)
	}
	if there, want := holdOf(rg, boardA); !there || want != "" || holder(rg, boardA) != p.ID {
		t.Errorf("heldThere %v, want %q, holder %q", there, want, holder(rg, boardA))
	}
	noRole(t, rg, p)
	if got := th.calls("release"); got != nil {
		t.Errorf("released there: %v", got)
	}
}

// TestBoardPageGone: the stream of the page that holds the board ends, and the board is
// released on its server; so is a board that was granted there after its page went away.
func TestBoardPageGone(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA)
	ctx := t.Context()
	p1, _ := rg.page("page-1")
	wantReply(t, "take", rg.r.TakeBoard(ctx, p1.ID, boardA, false), http.StatusOK, map[string]any{"state": "held", "rev": 1.0})
	p1.Close()
	th.wait("release", 1)
	rg.until("the hold is ended", func() bool { there, _ := holdOf(rg, boardA); return !there })
	if holder(rg, boardA) != "" {
		t.Errorf("the board is held by %q", holder(rg, boardA))
	}

	p2, _ := rg.page("page-2")
	th.set(func() {
		th.take = func(string, bool) thereAnswer {
			p2.Close()
			rg.until("the page is gone", func() bool { return !rg.b.Known(p2.ID) })
			return heldThereAt(2)
		}
	})
	wantReply(t, "take of a page that went away", rg.r.TakeBoard(ctx, p2.ID, boardA, false), http.StatusConflict, map[string]any{"error": "unknown_client"})
	if got := th.calls("release"); len(got) != 2 {
		t.Errorf("releases on the server: %v", got)
	}
	if there, want := holdOf(rg, boardA); there || want != "" {
		t.Errorf("heldThere %v, want %q", there, want)
	}
}

// TestBoardScene: the scene read and the saves that are refused here, refused there and stored.
func TestBoardScene(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA, boardB)
	ctx := t.Context()
	p1, _ := rg.page("page-1")
	p2, _ := rg.page("page-2")

	body, rev, e := rg.r.Scene(ctx, boardA)
	if e != nil || string(body) != `{"elements":[]}` || rev != 4 {
		t.Fatalf("Scene: %q at %d, %v", body, rev, e)
	}
	if kept, _ := rg.r.BoardRev(boardA); kept != 4 {
		t.Errorf("the revision kept is %d", kept)
	}
	if _, _, e := rg.r.Scene(ctx, boardC); e == nil || e.Status != http.StatusNotFound {
		t.Errorf("Scene of no record: %v", e)
	}

	scene := []byte(`{"elements":[1]}`)
	wantReply(t, "nobody holds", rg.r.SaveScene(ctx, p1.ID, boardA, 4, scene), http.StatusConflict,
		map[string]any{"code": "not_holder", "error": "this window does not hold the board"})
	wantReply(t, "take", rg.r.TakeBoard(ctx, p1.ID, boardA, false), http.StatusOK, map[string]any{"state": "held", "rev": 4.0})
	wantReply(t, "another holds", rg.r.SaveScene(ctx, p2.ID, boardA, 4, scene), http.StatusConflict,
		map[string]any{"code": "not_holder", "error": "another window holds this board"})
	wantReply(t, "no record", rg.r.SaveScene(ctx, p1.ID, boardC, 4, scene), http.StatusNotFound, nil)
	wantReply(t, "bad revision", rg.r.SaveScene(ctx, p1.ID, boardA, -1, scene), http.StatusBadRequest, map[string]any{"error": "rev is not a number"})
	if got := th.calls("put"); got != nil {
		t.Fatalf("a refused save reached the server: %v", got)
	}

	wantReply(t, "save", rg.r.SaveScene(ctx, p1.ID, boardA, 4, scene), http.StatusOK, map[string]any{"ok": true, "rev": 5.0})
	if got := th.calls("put"); !reflect.DeepEqual(got, []string{"put " + boardA + ` rev=4 {"elements":[1]}`}) {
		t.Errorf("the server got %v", got)
	}
	if kept, _ := rg.r.BoardRev(boardA); kept != 5 {
		t.Errorf("the revision kept is %d", kept)
	}
	// What the server refuses is the page's answer as it came.
	th.set(func() {
		th.put = thereAnswer{status: http.StatusConflict, body: map[string]any{"error": "the drawing changed", "code": "stale", "rev": 12}}
	})
	wantReply(t, "stale", rg.r.SaveScene(ctx, p1.ID, boardA, 4, scene), http.StatusConflict, map[string]any{"code": "stale", "rev": 12.0})
	th.set(func() {
		th.put = thereAnswer{status: http.StatusConflict, body: map[string]any{"error": "another window holds this board", "code": "not_holder"}}
	})
	// But for "not the holder there": the page keeps its edit, and the board is taken again
	// (TestBoardSaveNotHolderThere).
	wantReply(t, "not the holder there", rg.r.SaveScene(ctx, p1.ID, boardA, 5, scene), http.StatusServiceUnavailable, map[string]any{"code": "not_held_there"})
	role(t, p1, "held")
	if kept, _ := rg.r.BoardRev(boardA); kept != 5 {
		t.Errorf("a refused save changed the revision kept: %d", kept)
	}

	// The board is not held there, as between the server's return and the answer of the take.
	rec := rg.r.boardRec(boardA)
	rec.mu.Lock()
	rec.heldThere = false
	rec.mu.Unlock()
	n := len(th.calls("put"))
	wantReply(t, "not held there", rg.r.SaveScene(ctx, p1.ID, boardA, 5, scene), http.StatusServiceUnavailable,
		map[string]any{"code": "not_held_there", "error": "The board is being taken again on Studio."})

	// A scene read whose answer has no revision, and one of a board the server no longer has.
	th.set(func() {
		th.scene = func(w http.ResponseWriter) { thereAnswer{body: map[string]any{}}.write(w) }
	})
	if _, _, e := rg.r.Scene(ctx, boardA); e == nil || e.Code != "bad_answer" {
		t.Errorf("Scene without a revision: %v", e)
	}
	th.set(func() {
		th.scene = func(w http.ResponseWriter) {
			thereAnswer{status: http.StatusNotFound, body: map[string]any{"error": "no such board"}}.write(w)
		}
	})
	if _, _, e := rg.r.Scene(ctx, boardB); e == nil || e.Code != "gone_there" {
		t.Errorf("Scene of a board that is gone there: %v", e)
	}
	if v, _ := rg.r.BoardView(boardB); !v.Gone {
		t.Error("the board is not marked gone")
	}

	offline(rg)
	wantReply(t, "not connected", rg.r.SaveScene(ctx, p1.ID, boardA, 5, scene), http.StatusServiceUnavailable,
		map[string]any{"code": "server_unreachable", "error": "Studio is not connected."})
	if _, _, e := rg.r.Scene(ctx, boardA); e == nil || e.Status != http.StatusServiceUnavailable {
		t.Errorf("Scene while not connected: %v", e)
	}
	if got := th.calls("put"); len(got) != n {
		t.Errorf("a save that was refused here reached the server: %v", got)
	}
}

// TestBoardReturnHeld: a take while the server is not connected is granted here alone; at the
// return the board is taken there again, if free, and the page gets held with the server's
// revision. A page that waited there is sent superseded.
func TestBoardReturnHeld(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA, boardB)
	ctx := t.Context()
	p1, _ := rg.page("page-1")
	p2, _ := rg.page("page-2")
	th.set(func() {
		th.take = func(id string, ifFree bool) thereAnswer {
			if id == boardB && !ifFree {
				return stateThere("waiting")
			}
			return heldThereAt(5)
		}
	})
	wantReply(t, "take, waiting there", rg.r.TakeBoard(ctx, p2.ID, boardB, false), http.StatusOK, map[string]any{"state": "waiting"})
	if _, _, e := rg.r.Scene(ctx, boardA); e != nil {
		t.Fatal(e)
	}

	offline(rg)
	n := len(th.calls(""))
	wantReply(t, "take while not connected", rg.r.TakeBoard(ctx, p1.ID, boardA, true), http.StatusOK, map[string]any{"state": "held", "rev": 4.0})
	if there, _ := holdOf(rg, boardA); there || holder(rg, boardA) != p1.ID {
		t.Errorf("granted here alone: heldThere %v, holder %q", there, holder(rg, boardA))
	}
	// A page that waited on the server no longer waits once another takes the board here.
	wantReply(t, "take while not connected", rg.r.TakeBoard(ctx, p1.ID, boardB, false), http.StatusOK, map[string]any{"state": "held", "rev": 0.0})
	role(t, p2, "superseded")
	wantReply(t, "release while not connected", rg.r.ReleaseBoard(ctx, p1.ID, boardB), http.StatusOK, map[string]any{"state": "free"})
	if got := th.calls(""); len(got) != n {
		t.Errorf("the server was called while it was stopped: %v", got[n:])
	}

	rg.s.Restart()
	rg.returned(2)
	if ev := role(t, p1, "held"); ev["board"] != boardA || ev["rev"] != 5.0 {
		t.Errorf("held at the return: %v", ev)
	}
	if got := th.calls("take " + boardA); !reflect.DeepEqual(got, []string{"take " + boardA + " ifFree=true"}) {
		t.Errorf("the takes of the return: %v", got)
	}
	if there, _ := holdOf(rg, boardA); !there || holder(rg, boardA) != p1.ID {
		t.Errorf("after the return: heldThere %v, holder %q", there, holder(rg, boardA))
	}
	wantReply(t, "save after the return", rg.r.SaveScene(ctx, p1.ID, boardA, 5, []byte(`{}`)), http.StatusOK, map[string]any{"rev": 6.0})

	// A page waits there when the stream ends: the new stream knows nothing of it.
	wantReply(t, "take, waiting there", rg.r.TakeBoard(ctx, p2.ID, boardB, false), http.StatusOK, map[string]any{"state": "waiting"})
	rg.s.DropStreams()
	rg.returned(3)
	role(t, p2, "superseded")
	role(t, p1, "held")
	if _, want := holdOf(rg, boardB); want != "" {
		t.Errorf("a page still waits: %q", want)
	}
	noRole(t, rg, p1, p2)
}

// TestBoardReturnBusy: at the return the board is held there by another, or is archived or
// gone: the page loses it. With no answer all stays, and the next return tries again (and so
// does the wait of TestBoardRetakeAgain, which is not waited out here).
func TestBoardReturnBusy(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA, boardB, boardC)
	ctx := t.Context()
	p, _ := rg.page("page-1")
	for _, id := range []string{boardA, boardB, boardC} {
		wantReply(t, "take", rg.r.TakeBoard(ctx, p.ID, id, false), http.StatusOK, map[string]any{"state": "held"})
	}
	th.set(func() {
		th.take = func(id string, ifFree bool) thereAnswer {
			switch id {
			case boardA:
				return stateThere("busy")
			case boardB:
				return thereAnswer{status: http.StatusNotFound, body: map[string]any{"error": "no such board"}}
			}
			return thereAnswer{status: http.StatusInternalServerError, body: map[string]any{"error": "no"}}
		}
	})
	rg.s.DropStreams()
	rg.returned(2)
	lost := map[any]bool{}
	for range 2 {
		lost[role(t, p, "superseded")["board"]] = true
	}
	if !lost[boardA] || !lost[boardB] {
		t.Errorf("the boards lost: %v", lost)
	}
	th.wait("take", 6)
	noRole(t, rg, p)
	if holder(rg, boardA) != "" || holder(rg, boardB) != "" || holder(rg, boardC) != p.ID {
		t.Errorf("the holders: %q, %q, %q", holder(rg, boardA), holder(rg, boardB), holder(rg, boardC))
	}
	if v, _ := rg.r.BoardView(boardB); !v.Gone {
		t.Error("the board the server no longer has is not marked gone")
	}
	wantReply(t, "save before the board is taken again", rg.r.SaveScene(ctx, p.ID, boardC, 1, []byte(`{}`)),
		http.StatusServiceUnavailable, map[string]any{"code": "not_held_there"})
	th.wait("take", 7) // the save asks for the board there once more
	time.Sleep(quiet)  // the BoardFree of the lost boards
	if got := th.calls("release"); got != nil {
		t.Errorf("released there: %v", got)
	}

	// The next return takes the board that got no answer, and an archived one is lost.
	th.set(func() {
		th.take = func(string, bool) thereAnswer {
			return thereAnswer{status: http.StatusConflict, body: map[string]any{"error": "the board is archived"}}
		}
	})
	rg.s.DropStreams()
	rg.returned(3)
	if ev := role(t, p, "superseded"); ev["board"] != boardC {
		t.Errorf("superseded: %v", ev)
	}
	if got := th.calls("take"); len(got) != 8 {
		t.Errorf("takes on the server: %v", got)
	}
}

// TestBoardTakeNoAnswer: a take the server does not answer in time gives the page nothing, and
// what the server may have granted is released.
func TestBoardTakeNoAnswer(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{limits: Limits{Call: 100 * time.Millisecond}}, boardA)
	p, _ := rg.page("page-1")
	free := make(chan struct{})
	t.Cleanup(func() { close(free) })
	th.set(func() {
		th.take = func(string, bool) thereAnswer {
			select {
			case <-free:
			case <-time.After(wait):
			}
			return heldThereAt(3)
		}
	})
	wantReply(t, "take", rg.r.TakeBoard(t.Context(), p.ID, boardA, false), http.StatusGatewayTimeout, map[string]any{"code": "no_answer"})
	th.wait("release", 1)
	if there, want := holdOf(rg, boardA); there || want != "" || holder(rg, boardA) != "" {
		t.Errorf("heldThere %v, want %q, holder %q", there, want, holder(rg, boardA))
	}
}

// notHolderThere is the server's refusal of a write by a client that does not hold the board.
var notHolderThere = thereAnswer{status: http.StatusConflict, body: map[string]any{"error": "this window does not hold the board", "code": "not_holder"}}

// TestBoardSaveNotHolderThere: the server ended this one's stream and freed the board, and this
// server has not learnt of it yet. The server's "not_holder" to a save is then no loss of the
// board: the page gets the 503 after which it keeps its edit, the board is taken there again,
// and at the same revision the save passes.
func TestBoardSaveNotHolderThere(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA)
	ctx := t.Context()
	p, _ := rg.page("page-1")
	th.set(func() {
		th.take = func(string, bool) thereAnswer { return heldThereAt(3) }
		th.put = notHolderThere
	})
	wantReply(t, "take", rg.r.TakeBoard(ctx, p.ID, boardA, false), http.StatusOK, map[string]any{"state": "held", "rev": 3.0})
	scene := []byte(`{"elements":[1]}`)
	wantReply(t, "save, not the holder there", rg.r.SaveScene(ctx, p.ID, boardA, 3, scene), http.StatusServiceUnavailable,
		map[string]any{"code": "not_held_there", "error": "The board is being taken again on Studio."})
	if ev := role(t, p, "held"); ev["board"] != boardA || ev["rev"] != 3.0 {
		t.Errorf("held after the re-take: %v", ev)
	}
	if got, want := th.calls("take"), []string{"take " + boardA + " ifFree=false", "take " + boardA + " ifFree=true"}; !reflect.DeepEqual(got, want) {
		t.Errorf("the takes: %v, want %v", got, want)
	}
	if there, _ := holdOf(rg, boardA); !there || holder(rg, boardA) != p.ID {
		t.Errorf("after the re-take: heldThere %v, holder %q", there, holder(rg, boardA))
	}
	th.set(func() { th.put = thereAnswer{} })
	wantReply(t, "save after the re-take", rg.r.SaveScene(ctx, p.ID, boardA, 3, scene), http.StatusOK, map[string]any{"rev": 4.0})

	// A "held" that answers a take sent under a stream that ended since is no hold.
	rec := rg.r.boardRec(boardA)
	old := rg.r.holds.stream(rg.entry)
	rg.s.DropStreams()
	rg.returned(2)
	role(t, p, "held")
	rec.mu.Lock()
	rec.heldThere = false
	rec.mu.Unlock()
	if rg.r.holdGranted(rec, old, 9, "") {
		t.Error("a hold of the stream before was counted on")
	}
	if there, _ := holdOf(rg, boardA); there {
		t.Error("heldThere after a hold of the stream before")
	}
	if rev, _ := rg.r.BoardRev(boardA); rev != 4 {
		t.Errorf("the revision kept is %d", rev)
	}
}

// TestBoardNotHeldThereEnds: a page holds the board here on a connected server that does not
// know of it. The save that is refused for it takes the board there, so the state does not last.
func TestBoardNotHeldThereEnds(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA)
	ctx := t.Context()
	p, _ := rg.page("page-1")
	take(t, rg, p, boardA)
	rec := rg.r.boardRec(boardA)
	rec.mu.Lock()
	rec.heldThere = false
	rec.mu.Unlock()
	wantReply(t, "save, not held there", rg.r.SaveScene(ctx, p.ID, boardA, 1, []byte(`{}`)), http.StatusServiceUnavailable, map[string]any{"code": "not_held_there"})
	role(t, p, "held")
	if got := th.calls("put"); got != nil {
		t.Errorf("the refused save reached the server: %v", got)
	}
	wantReply(t, "save after the re-take", rg.r.SaveScene(ctx, p.ID, boardA, 1, []byte(`{}`)), http.StatusOK, map[string]any{"rev": 2.0})
}

// retakeRig is a rig with a page that holds boardA, on which the server answers the takes of a
// return (ifFree) with first, in that order, and after them with held at revision 7. The wait
// before a repeated call is short, and no limit is waited out.
func retakeRig(t *testing.T, first ...func() thereAnswer) (*rig, *there, *bridgetest.Page) {
	t.Helper()
	rg, th := holdRig(t, rigOpt{again: 20 * time.Millisecond}, boardA)
	p, _ := rg.page("page-1")
	take(t, rg, p, boardA)
	var mu sync.Mutex
	n := 0 // the takes of a return so far
	th.set(func() {
		th.take = func(_ string, ifFree bool) thereAnswer {
			mu.Lock()
			i := n
			if ifFree {
				n++
			}
			mu.Unlock()
			if ifFree && i < len(first) {
				return first[i]()
			}
			return heldThereAt(7)
		}
	})
	return rg, th, p
}

// TestBoardRetakeAgain: a re-take that gets no answer on an entry that stays connected is made
// again, with no new stream: three calls in a row at most.
func TestBoardRetakeAgain(t *testing.T) {
	t.Parallel()
	none := func() thereAnswer { panic(http.ErrAbortHandler) } // the call gets no answer
	rg, th, p := retakeRig(t, none)
	rg.s.DropStreams()
	rg.returned(2)
	if ev := role(t, p, "held"); ev["board"] != boardA || ev["rev"] != 7.0 {
		t.Errorf("held after the second take: %v", ev)
	}
	if got := th.calls("take " + boardA + " ifFree=true"); len(got) != 2 {
		t.Errorf("the takes of the return: %v", got)
	}
	if there, _ := holdOf(rg, boardA); !there || rg.local.upCount() != 2 {
		t.Errorf("heldThere %v after %d snapshots", there, rg.local.upCount())
	}

	// A server that never answers gets three calls, and no more; the page keeps the board.
	rg, th, p = retakeRig(t, none, none, none, none)
	rg.s.DropStreams()
	rg.returned(2)
	th.wait("take "+boardA+" ifFree=true", holdTries)
	time.Sleep(quiet)
	if got := th.calls("take " + boardA + " ifFree=true"); len(got) != holdTries {
		t.Errorf("the takes of a server that does not answer: %v", got)
	}
	if there, _ := holdOf(rg, boardA); there || holder(rg, boardA) != p.ID {
		t.Errorf("heldThere %v, holder %q", there, holder(rg, boardA))
	}
	noRole(t, rg, p)
}

// TestBoardRetakeUnknownClient: the server answers the re-take with unknown_client, as it does
// while this one's stream there is not open. Nobody took the board: the page keeps it, and the
// take is made again.
func TestBoardRetakeUnknownClient(t *testing.T) {
	t.Parallel()
	rg, th, p := retakeRig(t, func() thereAnswer {
		return thereAnswer{status: http.StatusConflict, body: map[string]any{"error": "unknown_client"}}
	})
	rg.s.DropStreams()
	rg.returned(2)
	if ev := role(t, p, "held"); ev["rev"] != 7.0 { // and not superseded
		t.Errorf("held after unknown_client: %v", ev)
	}
	if got := th.calls("take " + boardA + " ifFree=true"); len(got) != 2 {
		t.Errorf("the takes of the return: %v", got)
	}
	if there, _ := holdOf(rg, boardA); !there || holder(rg, boardA) != p.ID {
		t.Errorf("heldThere %v, holder %q", there, holder(rg, boardA))
	}
}

// TestBoardReleaseAgain: a release that gets no answer on an entry that stays connected is made
// again, so the server does not keep this one as the holder of a board no page here has. It is
// not made again once a page here holds the board.
func TestBoardReleaseAgain(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{again: 20 * time.Millisecond}, boardA, boardB)
	ctx := t.Context()
	p, _ := rg.page("page-1")
	take(t, rg, p, boardA)
	var n atomic.Int32
	th.set(func() {
		th.leaving = func() {
			if n.Add(1) == 1 {
				panic(http.ErrAbortHandler) // the first release gets no answer
			}
		}
	})
	wantReply(t, "release", rg.r.ReleaseBoard(ctx, p.ID, boardA), http.StatusOK, map[string]any{"state": "free"})
	if got := th.wait("release "+boardA, 2); len(got) != 2 {
		t.Errorf("the releases: %v", got)
	}
	if there, _ := holdOf(rg, boardA); there || holder(rg, boardA) != "" {
		t.Errorf("heldThere %v, holder %q", there, holder(rg, boardA))
	}

	// A page has the board again before the release is repeated: it is not released. The
	// page gets it here while the release that gets no answer is still on its way.
	take(t, rg, p, boardB)
	th.set(func() {
		th.leaving = func() {
			if state, _, err := rg.b.TakeBoard(p.ID, boardB, false); err != nil || state != "held" {
				t.Errorf("the page's take here: %s, %v", state, err)
			}
			panic(http.ErrAbortHandler)
		}
	})
	wantReply(t, "release with no answer", rg.r.ReleaseBoard(ctx, p.ID, boardB), http.StatusOK, map[string]any{"state": "free"})
	time.Sleep(quiet)
	if got := th.calls("release " + boardB); len(got) != 1 {
		t.Errorf("released there while a page holds the board: %v", got)
	}
}

// TestBoardRevKept: the scene revision that was seen last is in the record's file after a
// flush, and a relay on the same folder knows it before its server connects: a take that is
// granted here alone names it.
func TestBoardRevKept(t *testing.T) {
	t.Parallel()
	rg, _ := holdRig(t, rigOpt{}, boardA)
	if _, _, e := rg.r.Scene(t.Context(), boardA); e != nil {
		t.Fatal(e)
	}
	rg.until("the revision is flushed", func() bool { return rg.boardFile(boardA).Rev == 4 })
	if raw := mustRead(t, rg.r.boardFiles.path(boardA)); !strings.Contains(string(raw), `"rev": 4`) {
		t.Errorf("the file: %s", raw)
	}

	again := newRig(t, rigOpt{root: rg.root, hold: true}) // its manager is not started: not connected
	if rev, ok := again.r.BoardRev(boardA); rev != 4 || !ok {
		t.Errorf("the revision after a restart: %d, %v", rev, ok)
	}
	p, _ := again.page("page-1")
	wantReply(t, "take while not connected, after a restart", again.r.TakeBoard(t.Context(), p.ID, boardA, false), http.StatusOK,
		map[string]any{"state": "held", "rev": 4.0})

	// A record that never saw a revision has none in its file.
	if b, err := json.Marshal(boardSeedOf(boardB)); err != nil || strings.Contains(string(b), `"rev"`) {
		t.Errorf("a record without a revision: %s, %v", b, err)
	}
}
