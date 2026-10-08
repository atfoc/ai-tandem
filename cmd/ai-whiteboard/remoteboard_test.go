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

// A board on another server, between two server processes: the page of A draws on a board of B,
// the link is cut while an edit is not saved, and the edit is saved at the return when nobody
// drew on B meanwhile and refused when B's own page did. The cases of a remote board one by one
// are TestBoardPair (internal/server), with both servers in one process.

// boardScene is a drawing with one element, to tell one save from another.
func boardScene(element string) string {
	return `{"type":"excalidraw","version":2,"elements":[{"id":"` + element + `","type":"rectangle"}],"appState":{},"files":{}}`
}

// saveScene is a page's save of the board's drawing on the revision base.
func saveScene(t *testing.T, s *runServer, client, board string, base int, scene string) answer {
	t.Helper()
	status, raw := s.call(t, client, "PUT", "/api/boards/"+board+"/scene?rev="+strconv.Itoa(base), json.RawMessage(scene), nil)
	a := answer{}
	json.Unmarshal([]byte(raw), &a)
	a.Status, a.Raw = status, raw
	return a
}

func TestRemoteBoardOutage(t *testing.T) {
	serverTest(t, "TestBoardPair (internal/server)")
	rp := connectedPair(t, linksim.Good, fast.env(t, "silence", "backoff"))
	const pageOfB = "page-of-b"
	g := rp.group(t, "Work")

	// The board is made on B from A's page, which holds it from then on.
	var bd model.Board
	rp.a.must(t, pairPage, "POST", "/api/boards", map[string]any{"name": "Untitled", "group": g, "server": rp.entry}, &bd)
	if bd.ID == "" || bd.Server != rp.entry || bd.Group != g {
		t.Fatalf("the new board: %+v", bd)
	}
	path := "/api/boards/" + bd.ID
	if a := saveScene(t, rp.a, pairPage, bd.ID, 0, boardScene("first")); a.Status != http.StatusOK {
		t.Fatalf("the first save: %s", a)
	}
	if status, raw := rp.b.call(t, pageOfB, "GET", path+"/scene", nil, nil); status != http.StatusOK || raw != boardScene("first") {
		t.Fatalf("B's drawing after the first save: %d %s", status, raw)
	}

	// cut cuts the link during an edit that is not saved: the save is refused, at once, and the
	// page keeps the edit.
	cut := func(edit string, base int) (mark int) {
		t.Helper()
		mark = rp.page.mark()
		rp.link.Cut()
		rp.waitState(t, servers.StateUnreachable, 5*time.Second)
		start := time.Now()
		if a := saveScene(t, rp.a, pairPage, bd.ID, base, edit); a.Status != http.StatusServiceUnavailable || a.Code != "server_unreachable" {
			t.Fatalf("a save while %s is unreachable: %s", pairName, a)
		}
		if d := time.Since(start); d > 2*time.Second {
			t.Fatalf("the refusal of the save took %v", d)
		}
		rp.refused(t, http.StatusServiceUnavailable, "server_unreachable", "DELETE", path, nil)
		return mark
	}
	// back mends the link and waits until A's page is told that it holds the board again, at
	// B's revision rev.
	back := func(mark, rev int) {
		t.Helper()
		rp.link.Uncut()
		rp.back(t, 45*time.Second)
		rp.page.awaitEvent(t, mark, 20*time.Second, "server_back", rp.entry)
		rp.page.awaitEvent(t, mark, 20*time.Second, "held", bd.ID, `"rev":`+strconv.Itoa(rev))
	}

	// The return at the revision of the edit: the page saves, and the edit is on B.
	kept := boardScene("drawn while the link was cut")
	mark := cut(kept, 1)
	back(mark, 1)
	if a := saveScene(t, rp.a, pairPage, bd.ID, 1, kept); a.Status != http.StatusOK {
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
	if a := saveScene(t, rp.a, pairPage, bd.ID, 2, lost); a.Status != http.StatusConflict || a.Code != "stale" {
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
	rp.a.must(t, "second-page", "POST", path+"/take", map[string]any{"ifFree": false}, &held)
	if held.State != "waiting" {
		t.Fatalf("the take of A's second page: %+v", held)
	}
	second.awaitEvent(t, mark, 30*time.Second, "held", bd.ID, `"rev":3`)
	second.close()
	eventually(t, 20*time.Second, "B's page takes the board A's closed page held", func() bool {
		rp.b.must(t, pageOfB, "POST", path+"/take", map[string]any{"ifFree": true}, &held)
		return held.State == "held"
	})
	rp.b.must(t, pageOfB, "POST", path+"/release", nil, nil)

	// Connected, the delete removes the board on B.
	rp.ok(t, "DELETE", path, nil)
	if status, raw := rp.b.call(t, pageOfB, "GET", path+"/scene", nil, nil); status != http.StatusNotFound {
		t.Fatalf("B's board after the delete: %d %s", status, raw)
	}
}
