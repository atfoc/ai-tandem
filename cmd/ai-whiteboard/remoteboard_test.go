package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/linksim"
)

// A board of a section, between two server processes: the page of A makes a board in a group of
// B's section and draws on it, the link is cut while an edit is not saved, and the edit is saved
// at the return when nobody drew on B meanwhile and refused when B's own page did. A keeps
// nothing of the board: through the outage the page that holds it has the edit, and the section
// has no tree. The cases of a board of a section one by one are TestBoardPair (internal/server),
// with both servers in one process.

// boardScene is a drawing with one element, to tell one save from another.
func boardScene(element string) string {
	return `{"type":"excalidraw","version":2,"elements":[{"id":"` + element + `","type":"rectangle"}],"appState":{},"files":{}}`
}

// saveScene is a page's save, on the server s, of the drawing of a board of that server on the
// revision base.
func saveScene(t *testing.T, s *runServer, client, board string, base int, scene string) answer {
	t.Helper()
	return saveSceneAt(t, s, client, "/api/boards/"+board, base, scene)
}

// saveSceneAt is saveScene for the board at this path of s: a board of s itself, or a board of
// a section of s (remotePair.on).
func saveSceneAt(t *testing.T, s *runServer, client, path string, base int, scene string) answer {
	t.Helper()
	status, raw := s.call(t, client, "PUT", path+"/scene?rev="+strconv.Itoa(base), json.RawMessage(scene), nil)
	a := answer{}
	json.Unmarshal([]byte(raw), &a)
	a.Status, a.Raw = status, raw
	return a
}

func TestRemoteBoardOutage(t *testing.T) {
	serverTest(t, "TestServerDropsWithABoardHeld, TestBoardPair (internal/server)", "TestSectionBoardThroughAnOutage (internal/remotes)")
	rp := connectedPair(t, linksim.Good, fast.env(t, "silence", "backoff"))
	const pageOfB = "page-of-b"
	g := rp.group(t, "Work")

	// The question about the place is gone: the call for this computer that names B makes no
	// board, here or there.
	rp.refused(t, http.StatusBadRequest, "server_refused", "POST", "/api/boards", map[string]any{"name": "Untitled", "group": model.Ungrouped, "server": rp.entry})
	// The board is made in the section, in its group, from A's page, which holds it from then
	// on. It is on B, with B's id, in that group for B's owner; A has no board of its own.
	mark := rp.page.mark()
	var bd model.Board
	rp.a.must(t, pairPage, "POST", rp.on("/boards"), map[string]any{"name": "Untitled", "group": g}, &bd)
	if bd.ID == "" || bd.Group != g {
		t.Fatalf("the new board: %+v", bd)
	}
	path := "/api/boards/" + bd.ID     // the board on B's own port
	there := rp.on("/boards/" + bd.ID) // and through A
	save := func(base int, scene string) answer {
		t.Helper()
		return saveSceneAt(t, rp.a, pairPage, there, base, scene)
	}
	rp.page.awaitEvent(t, mark, 10*time.Second, "board", rp.inSection(), bd.ID)
	if tree, own := rp.tree(t), rp.ownTree(t); len(tree.Boards) != 1 || tree.Boards[0].ID != bd.ID || tree.Boards[0].Group != g ||
		len(own.Boards) != 1 || own.Boards[0].ID != bd.ID || own.Boards[0].Group != g || len(own.Groups) != 1 {
		t.Fatalf("the board in the section: %+v; on B's own page: %+v in the groups %+v", tree.Boards, own.Boards, own.Groups)
	}
	var here level5Tree
	rp.a.must(t, pairPage, "GET", "/api/state", nil, &here)
	if len(here.Boards) != 0 || len(here.Groups) != 0 {
		t.Fatalf("A's own boards and groups: %+v, %+v", here.Boards, here.Groups)
	}
	rp.refused(t, http.StatusNotFound, "not_found", "GET", path+"/scene", nil)
	if a := save(0, boardScene("first")); a.Status != http.StatusOK {
		t.Fatalf("the first save: %s", a)
	}
	if status, raw := rp.b.call(t, pageOfB, "GET", path+"/scene", nil, nil); status != http.StatusOK || raw != boardScene("first") {
		t.Fatalf("B's drawing after the first save: %d %s", status, raw)
	}

	// cut cuts the link during an edit that is not saved: the save is refused, at once, and the
	// page keeps the edit. The board's row is gone with the section's tree, and a board that is
	// not open cannot be opened: a take is refused too.
	cut := func(edit string, base int) (mark int) {
		t.Helper()
		mark = rp.page.mark()
		rp.link.Cut()
		rp.waitState(t, servers.StateUnreachable, 5*time.Second)
		start := time.Now()
		if a := save(base, edit); a.Status != http.StatusServiceUnavailable || a.Code != "server_unreachable" {
			t.Fatalf("a save while %s is unreachable: %s", pairName, a)
		}
		if d := time.Since(start); d > 2*time.Second {
			t.Fatalf("the refusal of the save took %v", d)
		}
		rp.refused(t, http.StatusServiceUnavailable, "server_unreachable", "DELETE", there, nil)
		rp.refused(t, http.StatusServiceUnavailable, "server_unreachable", "POST", there+"/take", map[string]any{"ifFree": true})
		rp.refused(t, http.StatusServiceUnavailable, "server_unreachable", "GET", there+"/scene", nil)
		rp.page.await(t, mark, 10*time.Second, "section event without a tree", func(e seenEvent) bool {
			return e.holds("section", rp.inSection(), `"tree":null`)
		})
		rp.noTree(t, "while the link is cut")
		return mark
	}
	// back mends the link and waits until A's page is told that it holds the board again, at
	// B's revision rev.
	back := func(mark, rev int) {
		t.Helper()
		rp.link.Uncut()
		rp.back(t, 45*time.Second)
		rp.treeBack(t, mark)
		rp.page.awaitEvent(t, mark, 20*time.Second, "held", rp.inSection(), bd.ID, `"rev":`+strconv.Itoa(rev))
	}

	// The return at the revision of the edit: the page saves, and the edit is on B.
	kept := boardScene("drawn while the link was cut")
	mark = cut(kept, 1)
	back(mark, 1)
	if a := save(1, kept); a.Status != http.StatusOK {
		t.Fatalf("the save of the kept edit at the return: %s", a)
	}
	if status, raw := rp.b.call(t, pageOfB, "GET", path+"/scene", nil, nil); status != http.StatusOK || raw != kept {
		t.Fatalf("B's drawing after the return: %d %s", status, raw)
	}

	// The return at another revision: B's own page drew while the link was cut. A's page is told
	// the new revision, and the save of its edit on the old one is refused.
	bPage := watch(t, http.DefaultClient, strings.TrimSuffix(rp.b.in.url, "/"), pageOfB, nil)
	defer bPage.close()
	lost := boardScene("drawn on the old revision")
	mark = cut(lost, 2)
	var held struct {
		State string
		Rev   int
	}
	eventually(t, 10*time.Second, "B's page takes the board A held", func() bool {
		rp.b.must(t, pageOfB, "POST", path+"/take", map[string]any{"ifFree": true}, &held)
		return held.State == "held"
	})
	if held.Rev != 2 {
		t.Fatalf("the take of B's page: %+v", held)
	}
	if a := saveScene(t, rp.b.runServer, pageOfB, bd.ID, 2, boardScene("B's own")); a.Status != http.StatusOK {
		t.Fatalf("the save of B's page: %s", a)
	}
	rp.b.must(t, pageOfB, "POST", path+"/release", nil, nil)
	back(mark, 3)
	if a := save(2, lost); a.Status != http.StatusConflict || a.Code != "stale" {
		t.Fatalf("the save of the edit on the old revision: %s", a)
	}
	if status, raw := rp.b.call(t, pageOfB, "GET", path+"/scene", nil, nil); status != http.StatusOK || raw != boardScene("B's own") {
		t.Fatalf("B's drawing after the second return: %d %s", status, raw)
	}

	// What the program wires between the bridge and the relay. A second page of A takes the
	// board: the hand-off is A's own, and its grant names B's revision. That page's stream ends:
	// A lets the board go on B, where B's page finds it free.
	second := watch(t, http.DefaultClient, strings.TrimSuffix(rp.a.in.url, "/"), "second-page", nil)
	mark = second.mark()
	rp.a.must(t, "second-page", "POST", there+"/take", map[string]any{"ifFree": false}, &held)
	if held.State != "waiting" {
		t.Fatalf("the take of A's second page: %+v", held)
	}
	second.awaitEvent(t, mark, 30*time.Second, "held", rp.inSection(), bd.ID, `"rev":3`)
	second.close()
	eventually(t, 20*time.Second, "B's page takes the board A's closed page held", func() bool {
		rp.b.must(t, pageOfB, "POST", path+"/take", map[string]any{"ifFree": true}, &held)
		return held.State == "held"
	})
	rp.b.must(t, pageOfB, "POST", path+"/release", nil, nil)

	// Connected, the delete removes the board on B: it leaves the section and B's own page, and
	// a call for it is B's "not found". Nothing of the board, of its group or of what was drawn
	// was ever in a file of A.
	mark = rp.page.mark()
	rp.ok(t, "DELETE", there, nil)
	rp.page.awaitEvent(t, mark, 10*time.Second, "board_removed", rp.inSection(), bd.ID)
	if status, raw := rp.b.call(t, pageOfB, "GET", path+"/scene", nil, nil); status != http.StatusNotFound {
		t.Fatalf("B's board after the delete: %d %s", status, raw)
	}
	rp.refused(t, http.StatusNotFound, "not_found", "GET", there+"/scene", nil)
	rp.refused(t, http.StatusNotFound, "not_found", "POST", there+"/take", map[string]any{"ifFree": true})
	if tree, own := rp.tree(t), rp.ownTree(t); len(tree.Boards) != 0 || len(own.Boards) != 0 {
		t.Fatalf("the deleted board is still there: %+v in the section, %+v on B's own page", tree.Boards, own.Boards)
	}
	if held := holders(folderFiles(t, rp.a.home), []string{bd.ID, g, "drawn while the link was cut", "drawn on the old revision", "B's own"}); len(held) != 0 {
		t.Fatalf("files of A's data folder that hold something of the board on %s: %v", pairName, held)
	}
}
