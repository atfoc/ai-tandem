package remotes

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// boardD is one more board of the tests.
const boardD = "b_dddd0004"

// TestSectionBoardThroughAnOutage: a page that holds a board when its server drops keeps
// holding it here, with nothing on disk. While the server is away a save and a take are
// refused, and a release is answered. When the tree is back the board is taken there again for
// the page: held at the same revision when nobody changed the board there, at another when
// somebody did, and superseded when someone else holds it there or it is no longer there.
func TestSectionBoardThroughAnOutage(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA, boardB, boardC, boardD)
	p, _ := rg.page("page-1")
	other, _ := rg.page("page-2")
	waiter, _ := rg.page("page-3")
	revs := map[string]int64{boardA: 5, boardB: 5, boardC: 5, boardD: 5}
	th.set(func() {
		th.take = func(id string, ifFree bool) thereAnswer { return heldThereAt(revs[id]) }
	})
	for id := range revs {
		wantReply(t, "take of "+id, rg.r.TakeBoard(rg.entry, p.ID, id, false), http.StatusOK, map[string]any{"state": "held", "rev": 5.0})
	}
	// One more board: a page waits for it on the server when the server drops.
	const waited = "b_eeee0005"
	th.set(func() {
		th.take = func(id string, ifFree bool) thereAnswer {
			if id == waited {
				return stateThere("waiting")
			}
			return heldThereAt(revs[id])
		}
	})
	wantReply(t, "take, waiting there", rg.r.TakeBoard(rg.entry, waiter.ID, waited, false), http.StatusOK, map[string]any{"state": "waiting"})

	rg.offline()
	nullSection(t, p, rg.far)
	// The page that waited there is told: the stream it waited under ended.
	if ev := role(t, waiter, "superseded"); !onEntry(rg.far, ev, waited) {
		t.Errorf("the page that waited there: %v", ev)
	}
	asked := len(rg.calls())
	unreachable := map[string]any{"code": "server_unreachable", "error": "Studio is not connected."}
	for id := range revs {
		if holder(rg.far, id) != p.ID {
			t.Errorf("%s is held by %q during the outage", id, holder(rg.far, id))
		}
	}
	scene := []byte(`{"elements":["drawn during the outage"]}`)
	wantReply(t, "a save during the outage", rg.r.SaveScene(rg.entry, p.ID, boardA, 5, scene), http.StatusServiceUnavailable, unreachable)
	wantReply(t, "a take by another window", rg.r.TakeBoard(rg.entry, other.ID, boardA, false), http.StatusServiceUnavailable, unreachable)
	wantReply(t, "a take if free by another window", rg.r.TakeBoard(rg.entry, other.ID, boardA, true), http.StatusServiceUnavailable, unreachable)
	wantReply(t, "a take by the holder", rg.r.TakeBoard(rg.entry, p.ID, boardA, false), http.StatusServiceUnavailable, unreachable)
	wantReply(t, "a take of a board that is not open", rg.r.TakeBoard(rg.entry, other.ID, "b_ffff0006", true), http.StatusServiceUnavailable, unreachable)
	if rep, _ := rg.r.Scene(context.Background(), rg.entry, boardA); rep.Status != http.StatusServiceUnavailable {
		t.Errorf("a read of the drawing during the outage: %d %s", rep.Status, rep.Body)
	}
	wantReply(t, "a release by a window that holds nothing", rg.r.ReleaseBoard(rg.entry, other.ID, boardA), http.StatusOK, map[string]any{"state": "none"})
	if holder(rg.far, boardA) != p.ID {
		t.Errorf("the board went to %q during the outage", holder(rg.far, boardA))
	}
	if got := rg.calls(); len(got) != asked {
		t.Errorf("the server that is away was asked: %v", got[asked:])
	}

	// The return: A is as it was, B was changed there, C is held by someone else, D is gone.
	th.set(func() {
		th.take = func(id string, ifFree bool) thereAnswer {
			switch id {
			case boardB:
				return heldThereAt(8)
			case boardC:
				return stateThere("busy")
			case boardD:
				return noBoardThere
			}
			return heldThereAt(5)
		}
	})
	rg.s.SetSnapshot(snapshotOf(tree{boards: []model.Board{farBoard(boardA), farBoard(boardB), farBoard(boardC)}}))
	rg.s.Restart()
	rg.returned(2)
	// The tree comes first, the boards after.
	got := map[any]map[string]any{}
	sawTree := false
	for len(got) < 4 {
		ev := p.Next()
		switch ev["type"] {
		case "section":
			sawTree = ev["tree"] != nil
		case "held", "superseded":
			if !sawTree || ev["server"] != rg.entry {
				t.Errorf("a role event before the tree, or of no entry: %v", ev)
			}
			got[ev["board"]] = ev
		}
	}
	for id, want := range map[string]map[string]any{
		boardA: {"type": "held", "rev": 5.0}, boardB: {"type": "held", "rev": 8.0},
		boardC: {"type": "superseded"}, boardD: {"type": "superseded"},
	} {
		for k, v := range want {
			if got[id][k] != v {
				t.Errorf("%s at the return: %v, want %v", id, got[id], want)
			}
		}
	}
	if got, want := th.calls("take "+boardA), []string{"take " + boardA + " ifFree=false", "take " + boardA + " ifFree=true"}; !reflect.DeepEqual(got, want) {
		t.Errorf("the takes of the board: %v", got)
	}
	if holder(rg.far, boardA) != p.ID || holder(rg.far, boardB) != p.ID || holder(rg.far, boardC) != "" || holder(rg.far, boardD) != "" {
		t.Errorf("the holders after the return: %q %q %q %q", holder(rg.far, boardA), holder(rg.far, boardB), holder(rg.far, boardC), holder(rg.far, boardD))
	}
	// At the revision the page's edit is based on its save passes; at another that server says so.
	wantReply(t, "the save of the edit that waited", rg.r.SaveScene(rg.entry, p.ID, boardA, 5, scene), http.StatusOK, map[string]any{"rev": 6.0})
	if got := th.calls("put"); len(got) != 1 || got[0] != "put "+boardA+" rev=5 "+string(scene) {
		t.Errorf("the save at the server: %v", got)
	}
	th.set(func() {
		th.put = thereAnswer{status: http.StatusConflict, body: map[string]any{"error": "the drawing changed", "code": "stale", "rev": 8}}
	})
	wantReply(t, "the save of an edit on a board that changed", rg.r.SaveScene(rg.entry, p.ID, boardB, 5, scene), http.StatusConflict, map[string]any{"code": "stale", "rev": 8.0})
	wantReply(t, "a save of a board that was taken from the page", rg.r.SaveScene(rg.entry, p.ID, boardC, 5, scene), http.StatusConflict, map[string]any{"code": "not_holder"})
}

// TestSectionBoardReleasedDuringAnOutage: a board that its page releases while its server is
// away is free here at once, with nothing sent, and is not taken there again at the return.
func TestSectionBoardReleasedDuringAnOutage(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA, boardB)
	p, _ := rg.page("page-1")
	other, _ := rg.page("page-2")
	take(t, rg, p, boardA)
	take(t, rg, p, boardB)
	// A second window waits for boardB here when the server drops: the hand-over is this
	// server's own, and goes on without the board's server.
	wantReply(t, "a take here", rg.r.TakeBoard(rg.entry, other.ID, boardB, false), http.StatusOK, map[string]any{"state": "waiting"})
	role(t, p, "release_request")
	rg.offline()
	wantReply(t, "a release during the outage", rg.r.ReleaseBoard(rg.entry, p.ID, boardA), http.StatusOK, map[string]any{"state": "free"})
	wantReply(t, "a release to a window that waits here", rg.r.ReleaseBoard(rg.entry, p.ID, boardB), http.StatusOK, map[string]any{"state": "handed"})
	role(t, p, "superseded")
	if ev := role(t, other, "held"); !onEntry(rg.far, ev, boardB) {
		t.Errorf("the hand-over during the outage: %v", ev)
	}
	if got := th.calls("release"); got != nil {
		t.Errorf("a release reached the server that is away: %v", got)
	}
	n := len(th.calls("take"))
	rg.s.Restart()
	rg.returned(2)
	if ev := role(t, other, "held"); !onEntry(rg.far, ev, boardB) || ev["rev"] != 1.0 {
		t.Errorf("held at the return: %v", ev)
	}
	noRole(t, rg.far, p)
	if got := th.calls("take"); len(got) != n+1 || got[n] != "take "+boardB+" ifFree=true" || holder(rg.far, boardA) != "" {
		t.Errorf("the takes of the return: %v", got[n:])
	}
}

// TestSectionBoardRemovedOrArchivedThere: a board that is removed or archived on its server, by
// anyone, is let go here: the page that holds it, and one that waits for it, get superseded.
func TestSectionBoardRemovedOrArchivedThere(t *testing.T) {
	t.Parallel()
	rg, _ := holdRig(t, rigOpt{}, boardA, boardB)
	p, _ := rg.page("page-1")
	other, _ := rg.page("page-2")
	take(t, rg, p, boardA)
	take(t, rg, p, boardB)
	wantReply(t, "a take here", rg.r.TakeBoard(rg.entry, other.ID, boardA, false), http.StatusOK, map[string]any{"state": "waiting"})
	role(t, p, "release_request")

	rg.s.Send(map[string]any{"type": "board_removed", "id": boardA})
	for _, page := range []*bridgetest.Page{p, other} {
		if ev := next(t, page, "board_removed"); ev["server"] != rg.entry || ev["id"] != boardA {
			t.Errorf("board_removed: %v", ev)
		}
		if ev := role(t, page, "superseded"); !onEntry(rg.far, ev, boardA) {
			t.Errorf("superseded for a board that was removed: %v", ev)
		}
	}
	gone := farBoard(boardB)
	gone.Archived, gone.Op = true, "a_1"
	rg.s.Send(map[string]any{"type": "board", "board": gone})
	if ev := role(t, p, "superseded"); !onEntry(rg.far, ev, boardB) {
		t.Errorf("superseded for a board that was archived: %v", ev)
	}
	noRole(t, rg.far, p, other)
	if holder(rg.far, boardA) != "" || holder(rg.far, boardB) != "" {
		t.Errorf("the holders: %q %q", holder(rg.far, boardA), holder(rg.far, boardB))
	}
	if held, _ := rg.treeOf(); len(held.Boards) != 1 || held.Boards[0].ID != boardB || !held.Boards[0].Archived {
		t.Errorf("the boards of the tree: %s", mustJSON(t, held.Boards))
	}
}

// TestSectionBoardOfARemovedEntry: with its entry the boards of a section are taken from the
// pages, and nothing of them is kept.
func TestSectionBoardOfARemovedEntry(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA)
	p, _ := rg.page("page-1")
	take(t, rg, p, boardA)
	key := editorbridge.BoardOn(rg.entry, boardA)
	if err := rg.m.Remove(rg.entry); err != nil {
		t.Fatal(err)
	}
	if ev := role(t, p, "superseded"); !onEntry(rg.far, ev, boardA) {
		t.Errorf("superseded: %v", ev)
	}
	next(t, p, "server_lists")
	if _, ok := rg.r.BoardRev(key); ok || holder(rg.far, boardA) != "" {
		t.Errorf("a board of a removed entry is kept: holder %q", holder(rg.far, boardA))
	}
	wantReply(t, "a release on a removed entry", rg.r.ReleaseBoard(rg.entry, p.ID, boardA), http.StatusNotFound, map[string]any{"code": "no_server"})
	time.Sleep(quiet)
	if got := th.calls("release"); got != nil {
		t.Errorf("the server of a removed entry was told: %v", got)
	}
}

// TestSectionCreateBoard: the creation of a board is passed on as it came, answered as that
// server answers, and the page that made the board is given it here.
func TestSectionCreateBoard(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{})
	p, _ := rg.page("page-1")
	ctx := context.Background()
	create := rg.script("POST /api/boards")
	made := farBoard(boardA)
	made.New = true
	create.answer(http.StatusOK, made)
	th.set(func() { th.take = func(string, bool) thereAnswer { return heldThereAt(0) } })
	body := []byte(`{"name":"Board aa","group":"g_there","new":true}`)
	rep := rg.r.CreateBoard(ctx, rg.entry, p.ID, body)
	if rep.Status != http.StatusOK || !sameJSON(t, json.RawMessage(rep.Body), made) {
		t.Fatalf("the creation: %d %s", rep.Status, rep.Body)
	}
	if g := create.last(t); g.URI != "/api/boards" || g.Body != string(body) {
		t.Errorf("the creation at the server: %+v", g)
	}
	if got := th.calls("take"); !reflect.DeepEqual(got, []string{"take " + boardA + " ifFree=true"}) || holder(rg.far, boardA) != p.ID {
		t.Errorf("the take of the new board: %v, holder %q", got, holder(rg.far, boardA))
	}
	if there, _ := holdOf(rg.far, boardA); !there {
		t.Error("the new board is not counted as held there")
	}
	noRole(t, rg.far, p) // the page learns of its hold from its own take, as for a board of this server

	// A refusal makes nothing, here or there, and is the page's as it came.
	create.answer(http.StatusBadRequest, map[string]any{"error": "a board is made on the server it is asked of", "code": "server_refused"})
	rep = rg.r.CreateBoard(ctx, rg.entry, p.ID, []byte(`{"name":"x","group":"g","server":"local"}`))
	wantReply(t, "a creation that is refused", rep, http.StatusBadRequest, map[string]any{"code": "server_refused"})
	create.drop()
	wantReply(t, "a creation with no answer", rg.r.CreateBoard(ctx, rg.entry, p.ID, body), http.StatusGatewayTimeout, map[string]any{"code": "no_answer"})
	wantReply(t, "a creation on no entry", rg.r.CreateBoard(ctx, "local", p.ID, body), http.StatusNotFound, map[string]any{"code": "no_server"})
	if got := th.calls("take"); len(got) != 1 {
		t.Errorf("a board that was not made was taken: %v", got)
	}
	rg.offline()
	wantReply(t, "a creation while not connected", rg.r.CreateBoard(ctx, rg.entry, p.ID, body), http.StatusServiceUnavailable, map[string]any{"code": "server_unreachable"})
}

// TestSectionCreateBoardByAPageWithNoStream: that server gives a new board to this one, also
// when the page that asked has no stream here any more and cannot be given it. No page holds the
// board then, so this server lets it go there.
func TestSectionCreateBoardByAPageWithNoStream(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{})
	made := farBoard(boardA)
	rg.script("POST /api/boards").answer(http.StatusOK, made)
	rep := rg.r.CreateBoard(context.Background(), rg.entry, "page-gone", []byte(`{"name":"Board aa","group":"g_there"}`))
	if rep.Status != http.StatusOK || !sameJSON(t, json.RawMessage(rep.Body), made) {
		t.Fatalf("the creation: %d %s", rep.Status, rep.Body)
	}
	if got := th.wait("release", 1); !reflect.DeepEqual(got, []string{"release " + boardA}) {
		t.Errorf("the releases at the server: %v", got)
	}
	if got := th.calls("take"); got != nil || holder(rg.far, boardA) != "" {
		t.Errorf("the takes: %v, holder %q", got, holder(rg.far, boardA))
	}
	if there, _ := holdOf(rg.far, boardA); there {
		t.Error("the board nobody holds here is counted as held there")
	}
}

// TestSectionBoardTwoPagesAtOnce: two pages take one board at the same moment, round after
// round. One of them holds it each time, this server holds it there exactly while one of its
// pages holds it here, and the last release frees it there.
func TestSectionBoardTwoPagesAtOnce(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA)
	// The stand-in keeps the hold as a server does: one client, held or free.
	var mu sync.Mutex
	heldThere := false
	th.set(func() {
		th.take = func(string, bool) thereAnswer {
			mu.Lock()
			defer mu.Unlock()
			heldThere = true
			return heldThereAt(3)
		}
		th.leaving = func() {
			mu.Lock()
			defer mu.Unlock()
			heldThere = false
		}
	})
	p1, _ := rg.page("page-1")
	p2, _ := rg.page("page-2")
	pages := []*bridgetest.Page{p1, p2}
	for round := range 20 {
		states := make([]string, 2)
		var wg sync.WaitGroup
		for i, p := range pages {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, body := reply(t, rg.r.TakeBoard(rg.entry, p.ID, boardA, true))
				states[i], _ = body["state"].(string)
			}()
		}
		wg.Wait()
		held := 0
		for i, state := range states {
			switch state {
			case "held":
				held++
				if holder(rg.far, boardA) != pages[i].ID {
					t.Fatalf("round %d: %s was told held, the holder is %q", round, pages[i].ID, holder(rg.far, boardA))
				}
			case "busy":
			default:
				t.Fatalf("round %d: a take answered %q", round, state)
			}
		}
		if held != 1 {
			t.Fatalf("round %d: %d pages hold the board: %v", round, held, states)
		}
		if there, _ := holdOf(rg.far, boardA); !there {
			t.Fatalf("round %d: a page holds the board here and this server does not hold it there", round)
		}
		for _, p := range pages {
			wg.Add(1)
			go func() {
				defer wg.Done()
				rg.r.ReleaseBoard(rg.entry, p.ID, boardA)
			}()
		}
		wg.Wait()
		rg.until("the board is free on both servers", func() bool {
			mu.Lock()
			defer mu.Unlock()
			there, _ := holdOf(rg.far, boardA)
			return !heldThere && !there && holder(rg.far, boardA) == ""
		})
	}
}

// TestSectionServerDropsInACall: the server drops while calls for its things are on their way.
// Each call ends with an answer of the table, the tree goes, and nothing is left held or
// followed for a server that knows of neither any more.
func TestSectionServerDropsInACall(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA, boardB)
	p, _ := rg.page("page-1")
	take(t, rg, p, boardB)
	in, free := make(chan struct{}, 16), make(chan struct{})
	t.Cleanup(func() { close(free) })
	hang := func(w http.ResponseWriter, r *http.Request) {
		in <- struct{}{}
		<-r.Context().Done()
	}
	rg.s.Handle("PUT /api/chats/{id}/label", hang)
	rg.s.Handle("GET /api/chats/{id}/items", hang)
	th.set(func() {
		th.take = func(string, bool) thereAnswer {
			in <- struct{}{}
			select { // the server is stopped long before
			case <-free:
			case <-time.After(wait):
			}
			return heldThereAt(1)
		}
	})
	ctx := context.Background()
	answers := make(chan Reply, 3)
	go func() {
		answers <- rg.r.Pass(ctx, rg.entry, http.MethodPut, chatPath(chatA, "/label"), []byte(`{}`), wait)
	}()
	go func() { answers <- rg.r.FollowChat(ctx, rg.entry, p.ID, chatA, chatPath(chatA, "/items")) }()
	go func() { answers <- rg.r.TakeBoard(rg.entry, p.ID, boardA, false) }()
	for range 3 {
		<-in
	}
	rg.s.Stop()
	for range 3 {
		select {
		case rep := <-answers:
			status, body := reply(t, rep)
			if status != http.StatusGatewayTimeout || body["code"] != "no_answer" {
				t.Errorf("a call that the drop ended: %d %s", status, rep.Body)
			}
		case <-time.After(wait):
			t.Fatal("a call did not end with the connection")
		}
	}
	rg.away()
	if holder(rg.far, boardA) != "" || holder(rg.far, boardB) != p.ID {
		t.Errorf("the holders after the drop: %q %q", holder(rg.far, boardA), holder(rg.far, boardB))
	}
	for _, id := range []string{boardA, boardB} {
		if there, want := holdOf(rg.far, id); there || want != "" {
			t.Errorf("%s after the drop: heldThere %v, want %q", id, there, want)
		}
	}
	if rg.b.Followed(editorbridge.ChatOn(rg.entry, chatA)) {
		t.Error("the chat is followed after its tree went")
	}
}
