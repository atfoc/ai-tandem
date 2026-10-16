package server

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
)

// The follow routes of a board and what they bring: the scene event after an accepted write, the
// writer in the answer, and the release that keeps a board a call is open on. Stand-in pages
// (bridgetest) against the real handler; the env's own client "A" makes no call.

// follow is a page's follow of the board; it returns the answer's revision and writer.
func follow(t *testing.T, p *bridgetest.Page, board string) (rev float64, writer string) {
	t.Helper()
	status, out := p.Do("POST", "/api/boards/"+board+"/follow", nil)
	got := answer(t, 200, status, out)
	rev, hasRev := got["rev"].(float64)
	writer, hasWriter := got["writer"].(string)
	if !hasRev || !hasWriter || len(got) != 2 {
		t.Fatalf("follow: %s: want a revision and a writer only", out)
	}
	return rev, writer
}

func unfollow(t *testing.T, p *bridgetest.Page, board string) {
	t.Helper()
	status, out := p.Do("POST", "/api/boards/"+board+"/unfollow", nil)
	if got := answer(t, 200, status, out); got["ok"] != true || len(got) != 1 {
		t.Fatalf("unfollow: %s", out)
	}
}

// scenes returns the revisions the scene events of the board in evs name, in order.
func scenes(evs []string, board string) (revs []float64) {
	for _, raw := range evs {
		if typeOf(raw) != "scene" {
			continue
		}
		var ev struct {
			Board string
			Rev   float64
		}
		json.Unmarshal([]byte(raw), &ev)
		if ev.Board == board {
			revs = append(revs, ev.Rev)
		}
	}
	return revs
}

// A reader gets no scene event before it follows, gets one with the new revision after each
// accepted write once it follows, and none after it unfollows. A refused write sends none.
func TestSceneEventReachesFollowersOnly(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	w, r, other := e.page("W"), e.page("R"), e.page("O")
	bd := newBoard(t, w, "b")
	written(t, w, bd.ID, 0, drawing("one"))
	if evs := e.sent(w, r, other); len(scenes(evs[1], bd.ID)) != 0 || len(scenes(evs[2], bd.ID)) != 0 {
		t.Fatalf("scene events before anyone followed: %v %v", types(evs[1]), types(evs[2]))
	}

	if rev, writer := follow(t, r, bd.ID); rev != 1 || writer != "window" {
		t.Fatalf("follow: revision %v, writer %q, want 1 and window", rev, writer)
	}
	if rev, _ := follow(t, r, bd.ID); rev != 1 { // again is no change
		t.Fatalf("a second follow: revision %v", rev)
	}
	if n := len(e.s.Bridge.Followers(editorbridge.Board(bd.ID))); n != 1 {
		t.Fatalf("%d followers after two follows of one client", n)
	}
	e.sent(w, r, other)

	written(t, w, bd.ID, 1, drawing("two"))
	if status, out := write(r, bd.ID, 2, drawing("by-reader")); status != 409 {
		t.Fatalf("a reader's write: %d %s", status, out)
	}
	if status, out := write(w, bd.ID, 1, drawing("stale")); status != 409 {
		t.Fatalf("a stale write: %d %s", status, out)
	}
	written(t, w, bd.ID, 2, drawing("three"))
	evs := e.sent(w, r, other)
	if got := scenes(evs[1], bd.ID); len(got) != 2 || got[0] != 2 || got[1] != 3 {
		t.Errorf("the follower was sent scene revisions %v, want [2 3]", got)
	}
	if got := scenes(evs[0], bd.ID); len(got) != 0 {
		t.Errorf("the writer, which does not follow, was sent scene revisions %v", got)
	}
	if got := scenes(evs[2], bd.ID); len(got) != 0 {
		t.Errorf("a client that does not follow was sent scene revisions %v", got)
	}

	unfollow(t, r, bd.ID)
	unfollow(t, r, bd.ID) // no follow is no error
	written(t, w, bd.ID, 3, drawing("four"))
	if got := scenes(e.sent(r)[0], bd.ID); len(got) != 0 {
		t.Errorf("a client that unfollowed was sent scene revisions %v", got)
	}

	// The writer may follow too, and then gets its own revision.
	follow(t, w, bd.ID)
	e.sent(w)
	written(t, w, bd.ID, 4, drawing("five"))
	if got := scenes(e.sent(w)[0], bd.ID); len(got) != 1 || got[0] != 5 {
		t.Errorf("the writer that follows was sent %v, want [5]", got)
	}
}

// The answer of follow names the writer as the holder's kind, a board nobody holds has none, an
// unknown board is 404, an archived board may be followed, and a follow ends with the board.
func TestFollowAnswer(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	w, r := e.page("W"), e.page("R")
	bd := newBoard(t, w, "b")
	if _, writer := follow(t, r, bd.ID); writer != "window" {
		t.Fatalf("writer of a held board: %q", writer)
	}
	if got := release(t, w, bd.ID); got != "free" {
		t.Fatalf("release: %s", got)
	}
	if rev, writer := follow(t, r, bd.ID); rev != 0 || writer != "" {
		t.Fatalf("a free board: revision %v, writer %q", rev, writer)
	}
	// The change of writer reaches the follower as a writer event.
	e.sent(r)
	take(t, w, bd.ID, false)
	if ev := until(t, r, "writer", bd.ID); ev["writer"] != "window" {
		t.Fatalf("writer event: %v", ev)
	}

	status, out := r.Do("POST", "/api/boards/b_zzzz9999/follow", nil)
	if status != 404 || strings.TrimSpace(string(out)) != noSuchBoard {
		t.Fatalf("follow of a board that is not there: %d %s", status, out)
	}
	if n := len(e.s.Bridge.Followers(editorbridge.Board("b_zzzz9999"))); n != 0 {
		t.Fatalf("%d followers of a board that is not there", n)
	}

	release(t, w, bd.ID)
	do(t, w, "POST", "/api/boards/"+bd.ID+"/archive", nil)
	if rev, writer := follow(t, r, bd.ID); rev != 0 || writer != "" {
		t.Fatalf("follow of an archived board: revision %v, writer %q", rev, writer)
	}
	do(t, w, "DELETE", "/api/boards/"+bd.ID, nil)
	if n := len(e.s.Bridge.Followers(editorbridge.Board(bd.ID))); n != 0 {
		t.Fatalf("%d followers of a board that was deleted", n)
	}
}

// A client whose stream has ended follows nothing, and the answer is the same.
func TestFollowWithNoStreamFollowsNothing(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	w, z := e.page("W"), e.page("Z")
	bd := newBoard(t, w, "b")
	written(t, w, bd.ID, 0, drawing("one"))
	z.Close()
	e.gone("Z")
	status, out := e.doAs("Z", "POST", "/api/boards/"+bd.ID+"/follow", "")
	if status != 200 || !strings.Contains(out, `"rev":1`) || !strings.Contains(out, `"writer":"window"`) {
		t.Fatalf("follow with no stream: %d %s", status, out)
	}
	if n := len(e.s.Bridge.Followers(editorbridge.Board(bd.ID))); n != 0 {
		t.Fatalf("%d followers after a follow with no stream", n)
	}
}

// release with ifIdle keeps a board the caller has a call open on, unless somebody waits for it.
func TestReleaseIfIdle(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	p, q := e.page("P"), e.page("Q")
	bd, token := e.boardChat(p)
	idle := func(p *bridgetest.Page) string {
		t.Helper()
		status, out := p.Do("POST", "/api/boards/"+bd.ID+"/release", map[string]any{"ifIdle": true})
		state, _ := answer(t, 200, status, out)["state"].(string)
		return state
	}
	if got := idle(q); got != "none" { // not the holder
		t.Fatalf("ifIdle release by a client that does not hold: %s", got)
	}

	called := make(chan string, 1)
	go func() {
		text, _ := e.tool(token, "read_board")
		called <- text
	}()
	var rpc string
	for rpc == "" {
		if ev := p.Next(); ev["type"] == "rpc" {
			rpc, _ = ev["id"].(string)
		}
	}
	if got := idle(p); got != "kept" {
		t.Fatalf("ifIdle release with a call open: %s", got)
	}
	e.holder(bd.ID, "P")
	// A malformed body is refused, and ifIdle false is a release.
	if status, out := p.Do("POST", "/api/boards/"+bd.ID+"/release", "nothing"); status != 400 {
		t.Fatalf("release with a body that is no object: %d %s", status, out)
	}
	e.holder(bd.ID, "P")

	// Somebody waits: the release goes through.
	if state, _ := take(t, q, bd.ID, false); state != "waiting" {
		t.Fatalf("Q's take: %s", state)
	}
	if got := idle(p); got != "handed" {
		t.Fatalf("ifIdle release with a waiter: %s", got)
	}
	e.holder(bd.ID, "Q")
	select {
	case text := <-called:
		if text == "" {
			t.Fatal("the call that the hand-over cut gave no text")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the call did not end")
	}

	// With no call open, ifIdle releases like a release.
	if got := idle(q); got != "free" {
		t.Fatalf("ifIdle release with no call open: %s", got)
	}
	e.holder(bd.ID, "")
}
