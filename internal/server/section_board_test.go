package server

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/testset"
)

// A board of a section through the routes, against a stand-in for its server: who draws is
// decided among the pages here, and this server's hold there follows it. (Between two real
// stacks: TestBoardPair.)

// takeOn is a take of a board of the rig's entry: the state, and the revision when it is held.
func (f *far) takeOn(p *bridgetest.Page, board string, ifFree bool) (state string, rev int64) {
	f.t.Helper()
	body := ""
	if ifFree {
		body = `{"ifFree":true}`
	}
	got := decode[struct {
		State string
		Rev   int64
	}](f.t, mustOK(f.t, f, p, "POST", f.on("/boards/"+board+"/take"), body))
	return got.State, got.Rev
}

// releaseOn is a release of a board of the rig's entry.
func (f *far) releaseOn(p *bridgetest.Page, board string) string {
	f.t.Helper()
	return decode[struct{ State string }](f.t, mustOK(f.t, f, p, "POST", f.on("/boards/"+board+"/release"), "")).State
}

// writeOn is a save of the drawing of a board of the rig's entry, on the revision base.
func (f *far) writeOn(p *bridgetest.Page, board string, base int64, scene string) (int, string) {
	f.t.Helper()
	return f.call(p, "PUT", f.on("/boards/"+board+"/scene")+"?rev="+itoa(int(base)), scene)
}

// role reads the page's events up to the next role event of this type for the board of the
// rig's entry, and returns it.
func (f *far) role(p *bridgetest.Page, typ, board string) map[string]any {
	f.t.Helper()
	evs := f.throughIf(p, func(raw string) bool {
		ev := decode[map[string]any](f.t, raw)
		return ev["type"] == typ && ev["board"] == board && ev["server"] == f.entry
	})
	return decode[map[string]any](f.t, evs[len(evs)-1])
}

// holder waits until the board of the rig's entry is held by this page here ("" = by none).
func (f *far) holderOn(board, want string) {
	f.t.Helper()
	var got string
	f.wait("the board "+board+" of the entry is held by "+want, func() bool {
		got, _ = f.s.Bridge.HolderOf(editorbridge.BoardOn(f.entry, board))
		return got == want
	})
}

func TestBoardOfASectionThroughTheRoutes(t *testing.T) {
	t.Parallel()
	f := newFar(t, farOpt{boards: []model.Board{boardThere(farBoardA)}})
	p, q := f.page("P"), f.page("Q")
	const takes, releases, saves = "POST /api/boards/{id}/take", "POST /api/boards/{id}/release", "PUT /api/boards/{id}/scene"
	there := "/api/boards/" + farBoardA

	// ---- create: the board is made there with the body as it came, the answer is that
	// server's, and the page that made it holds it: this server takes it there, if free.
	body := `{"name":"Plans","group":"` + farGroup + `","new":true,"later":[1]}`
	made := f.good(p, "POST", f.on("/boards"), body)
	if made["id"] != farBoardB || made["name"] != "Plans" || made["group"] != farGroup {
		t.Fatalf("the board the page got: %v", made)
	}
	if c := f.last("POST /api/boards"); c.Body != body || c.Path != "/api/boards" {
		t.Fatalf("the creation that was passed on: %+v", c)
	}
	if c := f.last(takes); c.Path != "/api/boards/"+farBoardB+"/take" || c.Body != `{"ifFree":true}` {
		t.Fatalf("the take of the new board: %+v", c)
	}
	f.holderOn(farBoardB, "P")
	if _, ok := f.a.Boards.Get(farBoardB); ok {
		t.Fatal("the board was made on this server too")
	}
	if _, err := os.Stat(f.env.st.P.BoardFile(farBoardB)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("this server has a drawing file of the board: %v", err)
	}
	// A creation that server refuses is the page's as it came, and nothing is taken.
	refusal := map[string]any{"error": "a client names no server", "code": "server_refused"}
	f.answer("POST /api/boards", http.StatusBadRequest, refusal)
	n := len(f.sent(takes))
	if status, out := f.call(p, "POST", f.on("/boards"), `{"name":"x","group":"g","server":"elsewhere"}`); status != 400 || decode[map[string]any](t, out)["code"] != "server_refused" {
		t.Fatalf("a creation that server refuses: %d %s", status, out)
	}
	if len(f.sent(takes)) != n {
		t.Fatal("a board that was not made was taken")
	}
	f.handle("POST /api/boards", nil)

	// ---- take: no page here holds the board, so it is taken there, and that server's
	// revision is the page's. The same page's next take is this server's own matter.
	if state, rev := f.takeOn(p, farBoardA, false); state != "held" || rev != 3 {
		t.Fatalf("P's take: %s at %d", state, rev)
	}
	if c := f.last(takes); c.Path != there+"/take" || c.Body != "" {
		t.Fatalf("the take that was passed on: %+v", c)
	}
	f.holderOn(farBoardA, "P")
	f.untouched("the holder's own take", func() {
		if state, rev := f.takeOn(p, farBoardA, true); state != "held" || rev != 3 {
			t.Fatalf("P's second take: %s at %d", state, rev)
		}
	})

	// ---- the drawing: read from there with its revision, by any page; saved by the holder
	// alone, at the revision it is based on.
	resp, drawn := f.getClient(f.on("/boards/"+farBoardA+"/scene"), map[string]string{ClientHeader: q.ID})
	if resp.StatusCode != 200 || resp.Header.Get(SceneRevHeader) != "3" || resp.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("the read of the drawing: %d at revision %q as %q", resp.StatusCode, resp.Header.Get(SceneRevHeader), resp.Header.Get("Content-Type"))
	}
	sameJSON(t, "the drawing", decode[any](t, drawn), `{"elements":[]}`)
	f.untouched("the save of a page that does not hold the board", func() {
		f.refuses(q, http.StatusConflict, "not_holder", "PUT", f.on("/boards/"+farBoardA+"/scene?rev=3"), drawing("Q's"))
	})
	if status, out := f.writeOn(p, farBoardA, 3, drawing("P's first")); status != 200 || decode[map[string]any](t, out)["rev"] != 4.0 {
		t.Fatalf("the holder's save: %d %s", status, out)
	}
	if c := f.last(saves); c.Path != there+"/scene" || c.Query != "rev=3" || c.Body != drawing("P's first") {
		t.Fatalf("the save that was passed on: %+v", c)
	}
	status, out := f.writeOn(p, farBoardA, 3, drawing("on an old revision"))
	if got := decode[map[string]any](t, out); status != 409 || got["code"] != "stale" || got["rev"] != 4.0 {
		t.Fatalf("a save on an old revision: %d %s", status, out)
	}
	// A read without a revision is no drawing.
	f.handle("GET /api/boards/{id}/scene", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]any{"elements": []any{}}) })
	f.refuses(q, http.StatusBadGateway, "bad_answer", "GET", f.on("/boards/"+farBoardA+"/scene"), "")
	f.handle("GET /api/boards/{id}/scene", nil)

	// ---- two pages here: the second one's take is this server's own hand-over, at that
	// server's revision, and nothing is sent for it.
	f.untouched("a hand-over between two pages here", func() {
		if state, _ := f.takeOn(q, farBoardA, true); state != "busy" {
			t.Fatalf("Q's take, if free, of P's board: %s", state)
		}
		if state, _ := f.takeOn(q, farBoardA, false); state != "waiting" {
			t.Fatalf("Q's take of P's board: %s", state)
		}
		f.role(p, "release_request", farBoardA)
		if got := f.releaseOn(p, farBoardA); got != "handed" {
			t.Fatalf("P's release to Q: %s", got)
		}
		if ev := f.role(q, "held", farBoardA); ev["rev"] != 4.0 {
			t.Fatalf("Q's grant: %v, want that server's revision 4", ev)
		}
		f.role(p, "superseded", farBoardA)
		f.holderOn(farBoardA, "Q")
	})
	if status, out := f.writeOn(q, farBoardA, 4, drawing("Q's")); status != 200 {
		t.Fatalf("Q's save: %d %s", status, out)
	}
	// The last page lets go: the board is let go there too.
	n = len(f.sent(releases))
	if got := f.releaseOn(q, farBoardA); got != "free" {
		t.Fatalf("Q's release: %s", got)
	}
	if got := f.sent(releases); len(got) != n+1 || got[n].Path != there+"/release" {
		t.Fatalf("the release there: %+v", got[n:])
	}
	f.holderOn(farBoardA, "")
	f.untouched("the release of a page that holds nothing", func() {
		if got := f.releaseOn(p, farBoardA); got != "none" {
			t.Fatalf("a release by a page that holds nothing: %s", got)
		}
	})

	// ---- the board is held there by somebody else: "busy" if free, else the page waits, and
	// that server's held or superseded is the page's, with the entry's id.
	f.answer(takes, 200, map[string]string{"state": "busy"})
	if state, _ := f.takeOn(p, farBoardA, true); state != "busy" {
		t.Fatalf("a take, if free, of a board held there: %s", state)
	}
	if c := f.last(takes); c.Body != `{"ifFree":true}` {
		t.Fatalf("the take, if free, that was passed on: %+v", c)
	}
	f.answer(takes, 200, map[string]string{"state": "waiting"})
	if state, _ := f.takeOn(p, farBoardA, false); state != "waiting" {
		t.Fatalf("a take of a board held there: %s", state)
	}
	f.holderOn(farBoardA, "")
	f.st.Send(map[string]any{"type": "held", "board": farBoardA, "rev": 7})
	if ev := f.role(p, "held", farBoardA); ev["rev"] != 7.0 {
		t.Fatalf("the grant from there: %v", ev)
	}
	f.holderOn(farBoardA, "P")
	// That server asks for the board back: the page is asked, lets go, and has lost it.
	f.st.Send(map[string]any{"type": "release_request", "board": farBoardA})
	f.role(p, "release_request", farBoardA)
	f.answer(releases, 200, map[string]string{"state": "handed"})
	if got := f.releaseOn(p, farBoardA); got != "handed" {
		t.Fatalf("P's release to the one who waits there: %s", got)
	}
	f.role(p, "superseded", farBoardA)
	f.handle(releases, nil)
	// A wait there that ends with the board given to another.
	if state, _ := f.takeOn(q, farBoardA, false); state != "waiting" {
		t.Fatalf("Q's take of a board held there: %s", state)
	}
	f.st.Send(map[string]any{"type": "superseded", "board": farBoardA})
	f.role(q, "superseded", farBoardA)
	f.holderOn(farBoardA, "")
	f.handle(takes, nil)

	// ---- an archived or a removed board is taken from the page that holds it.
	if state, _ := f.takeOn(p, farBoardA, false); state != "held" {
		t.Fatalf("P's take: %s", state)
	}
	f.st.Send(map[string]any{"type": "board_removed", "id": farBoardA})
	f.role(p, "superseded", farBoardA)
	f.holderOn(farBoardA, "")
}

// toolCall sends a board tool's call of the entry's server, under the id it has there, and
// returns the id the page that holds the board was asked it under.
func (f *far) toolCall(p *bridgetest.Page, there string) string {
	f.t.Helper()
	f.st.Send(map[string]any{"type": "rpc", "id": there, "method": "board",
		"params": map[string]any{"board": farBoardA, "chat": farChatA, "name": "read_board", "args": map[string]any{"scope": "all"}}})
	evs := f.through(p, "rpc")
	ev := decode[map[string]any](f.t, evs[len(evs)-1])
	id, _ := ev["id"].(string)
	if !strings.HasPrefix(id, "far_") || ev["server"] != f.entry || ev["method"] != "board" || field(ev, "params", "board") != farBoardA ||
		field(ev, "params", "chat") != farChatA || field(ev, "params", "args", "scope") != "all" {
		f.t.Fatalf("the call the page was asked: %v", ev)
	}
	return id
}

// toolAnswer waits for the answer the entry's server got to its call there.
func (f *far) toolAnswer(there string) map[string]any {
	f.t.Helper()
	var got map[string]any
	f.wait("the answer to "+there+" reaches the board's server", func() bool {
		for _, c := range f.sent("POST /api/rpc-reply") {
			if ans := decode[map[string]any](f.t, c.Body); ans["id"] == there {
				got = ans
				return true
			}
		}
		return false
	})
	return got
}

// A board tool of an agent on the entry's server is answered by the page that holds the board
// here: the page gets the call with the entry's id under an id of this server's making, and
// its answer goes to that server under the id the call had there.
func TestToolCallOfASectionsAgentThroughTheRoutes(t *testing.T) {
	t.Parallel()
	f := newFar(t, farOpt{boards: []model.Board{boardThere(farBoardA)}, chats: []model.ChatView{viewThere(farChatA)}})
	p, q := f.page("P"), f.page("Q")
	if state, _ := f.takeOn(p, farBoardA, false); state != "held" {
		t.Fatalf("P's take: %s", state)
	}
	asked := func(there string) string { return f.toolCall(p, there) }
	answered := f.toolAnswer

	// The page's result goes back under that server's id. Only the page that was asked answers,
	// and once.
	id := asked("rpc_7")
	f.untouched("an answer of a page that was not asked", func() {
		if status, out := f.call(q, "POST", "/api/rpc-reply", mustJSON(t, obj{"id": id, "result": "Q's"})); status != 409 || !strings.Contains(out, "not_asked") {
			t.Fatalf("Q's answer: %d %s", status, out)
		}
	})
	if got := f.good(p, "POST", "/api/rpc-reply", mustJSON(t, obj{"id": id, "result": obj{"text": "what P shows"}})); got["ok"] != true {
		t.Fatalf("P's answer: %v", got)
	}
	sameJSON(t, "the answer that server got", answered("rpc_7"), `{"id":"rpc_7","result":{"text":"what P shows"}}`)
	if status, out := f.call(p, "POST", "/api/rpc-reply", mustJSON(t, obj{"id": id, "result": "again"})); status != 409 || !strings.Contains(out, "not_asked") {
		t.Fatalf("P's second answer: %d %s", status, out)
	}
	// An error is passed on as one.
	id = asked("rpc_8")
	f.good(p, "POST", "/api/rpc-reply", mustJSON(t, obj{"id": id, "error": "the window is closed"}))
	sameJSON(t, "the error that server got", answered("rpc_8"), `{"id":"rpc_8","error":"the window is closed"}`)
	// An answer above the size limit is refused, and the call is failed with the size.
	id = asked("rpc_9")
	large := `{"id":"` + id + `","result":"` + strings.Repeat("a", rpcReplyMax) + `"}`
	if status, out := f.call(p, "POST", "/api/rpc-reply", large); status != 413 || !strings.Contains(out, "larger than 32 MB") {
		t.Fatalf("the oversize answer: %d %s", status, out)
	}
	if got := answered("rpc_9"); !strings.Contains(got["error"].(string), "larger than 32 MB") {
		t.Fatalf("the answer that server got to the oversize one: %v", got)
	}
	// An id of this server's own bridge is no call of a section: nothing is sent for it.
	f.untouched("an answer to a call of this server", func() {
		if status, out := f.call(p, "POST", "/api/rpc-reply", `{"id":"rpc_1","result":"x"}`); status != 409 || !strings.Contains(out, "not_asked") {
			t.Fatalf("an answer to no call: %d %s", status, out)
		}
	})
	// No page holds the board: that server is answered at once.
	if got := f.releaseOn(p, farBoardA); got != "free" {
		t.Fatalf("P's release: %s", got)
	}
	f.st.Send(map[string]any{"type": "rpc", "id": "rpc_11", "method": "board", "params": map[string]any{"board": farBoardA, "name": "read_board"}})
	if got := answered("rpc_11"); got["error"] != "No window of this computer has the board open." {
		t.Fatalf("the answer to a call for a board no page holds: %v", got)
	}
}

// A page that does not answer a tool call: the entry's server is told within the relay's own
// limit, well before its own wait is over, and a late answer is nobody's.
func TestToolCallOfASectionsAgentThatNoPageAnswers(t *testing.T) {
	t.Parallel()
	const limit = 300 * time.Millisecond
	f := newFar(t, farOpt{boards: []model.Board{boardThere(farBoardA)}, limits: remotes.Limits{BoardCall: limit}})
	p := f.page("P")
	if state, _ := f.takeOn(p, farBoardA, false); state != "held" {
		t.Fatalf("P's take: %s", state)
	}
	id := f.toolCall(p, "rpc_10")
	if got := f.toolAnswer("rpc_10"); got["error"] != "the board's window did not answer in "+limit.String() {
		t.Fatalf("the answer to a call no page answered: %v", got)
	}
	if status, out := f.call(p, "POST", "/api/rpc-reply", mustJSON(t, obj{"id": id, "result": "late"})); status != 409 || !strings.Contains(out, "not_asked") {
		t.Fatalf("P's late answer: %d %s", status, out)
	}
	f.holderOn(farBoardA, "P")
}

// Two pages take one free board of a section at the same moment, round after round: one of
// them gets it, by one take on the board's server, and the other waits for it here. While both
// save, the holder's drawing alone is stored. The hand-over is this server's own.
func TestTwoPagesTakeOneBoardOfASectionAtOnce(t *testing.T) {
	t.Parallel()
	f := newFar(t, farOpt{boards: []model.Board{boardThere(farBoardA)}})
	pages := []*bridgetest.Page{f.page("P"), f.page("Q")}
	const takes, releases, saves = "POST /api/boards/{id}/take", "POST /api/boards/{id}/release", "PUT /api/boards/{id}/scene"
	rounds := 4
	if testset.Full() {
		rounds = 30
	}
	rev := int64(3)
	for round := 0; round < rounds; round++ {
		before := [3]int{len(f.sent(takes)), len(f.sent(releases)), len(f.sent(saves))}
		var states [2]string
		var wg sync.WaitGroup
		for i, page := range pages {
			wg.Add(1)
			go func() {
				defer wg.Done()
				states[i], _ = f.takeOn(page, farBoardA, false)
			}()
		}
		wg.Wait()
		held := 0
		if states[1] == "held" {
			held = 1
		}
		holder, waiter := pages[held], pages[1-held]
		if states[held] != "held" || states[1-held] != "waiting" {
			t.Fatalf("round %d: the takes ended as %v", round, states)
		}
		f.holderOn(farBoardA, holder.ID)
		f.role(holder, "release_request", farBoardA)

		// Both save on the revision the board has.
		var status [2]int
		var out [2]string
		for i, page := range pages {
			wg.Add(1)
			go func() {
				defer wg.Done()
				status[i], out[i] = f.writeOn(page, farBoardA, rev, drawing(fmt.Sprintf("%s in round %d", page.ID, round)))
			}()
		}
		wg.Wait()
		if status[held] != 200 || status[1-held] != 409 || decode[map[string]any](t, out[1-held])["code"] != "not_holder" {
			t.Fatalf("round %d: the holder's save %d %s, the other's %d %s", round, status[held], out[held], status[1-held], out[1-held])
		}
		rev++
		// The holder lets go: the board is the other page's, at the revision of the save.
		if got := f.releaseOn(holder, farBoardA); got != "handed" {
			t.Fatalf("round %d: the holder's release: %s", round, got)
		}
		if ev := f.role(waiter, "held", farBoardA); ev["rev"] != float64(rev) {
			t.Fatalf("round %d: the grant of the page that waited: %v, want revision %d", round, ev, rev)
		}
		f.role(holder, "superseded", farBoardA)
		f.holderOn(farBoardA, waiter.ID)
		if got := f.releaseOn(waiter, farBoardA); got != "free" {
			t.Fatalf("round %d: the last release: %s", round, got)
		}
		f.holderOn(farBoardA, "")
		// That server saw one user of the board: one take, one drawing and one release.
		f.wait("the board is let go there", func() bool { return len(f.sent(releases)) == before[1]+1 })
		if got := [3]int{len(f.sent(takes)) - before[0], len(f.sent(releases)) - before[1], len(f.sent(saves)) - before[2]}; got != [3]int{1, 1, 1} {
			t.Fatalf("round %d: the board's server got %v takes, releases and saves, want one of each", round, got)
		}
		if c := f.last(saves); !strings.Contains(c.Body, holder.ID+" in round") {
			t.Fatalf("round %d: the drawing that was stored is not the holder's: %s", round, c.Body)
		}
	}
}
