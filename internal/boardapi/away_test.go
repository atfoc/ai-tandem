package boardapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
)

// fakeAway stands in for the headless writer's manager: Ensure counts its calls and fails with err
// when it is set; CallTimedOut counts the calls that were cut by their time limit.
type fakeAway struct {
	mu       sync.Mutex
	ensured  int
	err      error
	timedOut int
}

func (a *fakeAway) Ensure(context.Context) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.ensured++
	return "H", a.err
}

func (a *fakeAway) CallTimedOut() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.timedOut++
}

func (a *fakeAway) counts() (ensured, timedOut int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.ensured, a.timedOut
}

// away gives the env a background editor whose client id is H, and returns the editor.
func (e *env) away() *fakeAway {
	a := &fakeAway{}
	e.relay.Away = a
	e.relay.Bridge.SetAway("H")
	return a
}

// connect opens one stand-in page per id on a server of the env's routes. A page's events are read by
// the test, in order, and its rpc events are not answered.
func (e *env) connect(ids ...string) map[string]*bridgetest.Page {
	e.t.Helper()
	srv := httptest.NewServer(e.mux)
	e.t.Cleanup(srv.Close)
	pages := map[string]*bridgetest.Page{}
	for _, id := range ids {
		p := bridgetest.Connect(e.t, srv.URL, id)
		p.Welcome()
		pages[id] = p
	}
	return pages
}

type answer struct {
	text  string
	isErr bool
}

// callAsync makes the agent call a tool and returns where the answer will arrive.
func (e *env) callAsync(tool, args string) <-chan answer {
	done := make(chan answer, 1)
	go func() {
		text, isErr := e.relay.Call(e.token, tool, json.RawMessage(args))
		done <- answer{text, isErr}
	}()
	return done
}

func (e *env) wait(done <-chan answer) answer {
	e.t.Helper()
	select {
	case a := <-done:
		return a
	case <-time.After(bridgetest.Wait):
		e.t.Fatal("the call did not end")
		return answer{}
	}
}

func reply(t *testing.T, p *bridgetest.Page, rpc map[string]any, result string) {
	t.Helper()
	if status, _ := p.Do("POST", "/api/rpc-reply", map[string]any{"id": rpc["id"], "result": result}); status != 200 {
		t.Fatalf("reply of %s: status %d", p.ID, status)
	}
}

// A call about a free board is given to the background editor: it is made the holder and told so
// before it is asked, it answers, and the next call on the board does not start it again.
func TestAwayCallIsAnsweredByTheAwayClientAfterHeld(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	other := e.newBoard("other")
	away := e.away()
	pages := e.connect("P1", "H")
	p1, h := pages["P1"], pages["H"]
	e.take("P1", e.board.ID)

	done := e.callAsync("apply", `{"board":"`+other.ID+`"}`)
	held := h.Expect("held")
	if held["board"] != other.ID {
		t.Fatalf("held = %v", held)
	}
	rpc := h.Expect("rpc")
	if p := rpc["params"].(map[string]any); rpc["method"] != "tool" || p["target"] != other.ID || p["board"] != e.board.ID ||
		p["name"] != "apply" || p["chat"] != e.chat {
		t.Fatalf("rpc = %v", rpc)
	}
	if id, held := e.relay.Bridge.HolderOf(other.ID); !held || id != "H" {
		t.Fatalf("holder of the board is %q, %v", id, held)
	}
	reply(t, h, rpc, "applied")
	if got := e.wait(done); got.isErr || got.text != "applied" {
		t.Fatalf("got %+v", got)
	}
	if ensured, _ := away.counts(); ensured != 1 {
		t.Fatalf("Ensure was called %d times", ensured)
	}

	// The board is the editor's now: its next call goes to it without a start.
	done = e.callAsync("read_board", `{"board":"`+other.ID+`"}`)
	rpc = h.Expect("rpc")
	reply(t, h, rpc, "read")
	if got := e.wait(done); got.isErr || got.text != "read" {
		t.Fatalf("got %+v", got)
	}
	if ensured, _ := away.counts(); ensured != 1 {
		t.Fatalf("Ensure was called %d times for a board the editor holds", ensured)
	}
	p1.ExpectNone(50 * time.Millisecond)
	h.ExpectNone(50 * time.Millisecond)
}

// A call about a held board never reaches the background editor and does not start it, whoever
// holds the chat's board and whichever tool it is.
func TestHeldBoardCallNeverReachesTheAwayClient(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	other := e.newBoard("other")
	away := e.away()
	pages := e.connect("P1", "P2", "H")
	e.take("P1", e.board.ID)
	e.take("P2", other.ID)
	for id, p := range pages {
		if id != "H" {
			p.OnRPC(func(params map[string]any) (any, string) { return id + ":" + params["name"].(string), "" })
		}
	}
	for _, tool := range []string{"read_board", "apply", "delete_elements", "get_image"} {
		for board, page := range map[string]string{e.board.ID: "P1", other.ID: "P2"} {
			text, isErr := e.relay.Call(e.token, tool, json.RawMessage(`{"board":"`+board+`"}`))
			if isErr || text != page+":"+tool {
				t.Fatalf("%s on a board of %s: %q isErr=%v", tool, page, text, isErr)
			}
		}
	}
	pages["H"].ExpectNone(50 * time.Millisecond)
	if ensured, _ := away.counts(); ensured != 0 {
		t.Fatalf("Ensure was called %d times", ensured)
	}
}

// With no background editor, a free board's call is told that the board isn't open.
func TestFreeBoardCallWithNoAwayEditor(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	pages := e.connect("P1")
	for _, tool := range []string{"read_board", "apply", "delete_elements", "get_image"} {
		if text, isErr := e.relay.Call(e.token, tool, json.RawMessage(`{}`)); !isErr || text != NoClientText {
			t.Fatalf("%s: %q isErr=%v", tool, text, isErr)
		}
	}
	pages["P1"].ExpectNone(50 * time.Millisecond)
}

// The editor cannot run: with no window connected the agent is told that the window is closed; with
// one connected, that nobody is editing and the user can press Edit here.
func TestAwayUnavailableTexts(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	away := e.away()
	away.err = errors.New("no node")
	for _, tool := range []string{"read_board", "apply", "delete_elements", "get_image"} {
		if text, isErr := e.relay.Call(e.token, tool, json.RawMessage(`{}`)); !isErr || text != NoClientText {
			t.Fatalf("no window, %s: %q isErr=%v", tool, text, isErr)
		}
	}
	pages := e.connect("P1")
	for _, tool := range []string{"read_board", "apply", "delete_elements", "get_image"} {
		if text, isErr := e.relay.Call(e.token, tool, json.RawMessage(`{}`)); !isErr || text != NoEditorText {
			t.Fatalf("a window, %s: %q isErr=%v", tool, text, isErr)
		}
	}
	if !strings.Contains(NoEditorText, "press Edit here on the board") {
		t.Fatalf("NoEditorText = %q", NoEditorText)
	}
	pages["P1"].ExpectNone(50 * time.Millisecond)
	if _, held := e.relay.Bridge.HolderOf(e.board.ID); held {
		t.Fatal("a failed call left the board held")
	}
}

// The editor started but is not connected any more: the same texts.
func TestAwayStartedButNotConnected(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.away() // Ensure says yes, and no client H is connected
	if text, isErr := e.relay.Call(e.token, "read_board", json.RawMessage(`{}`)); !isErr || text != NoClientText {
		t.Fatalf("no window: %q isErr=%v", text, isErr)
	}
	e.connect("P1")
	if text, isErr := e.relay.Call(e.token, "read_board", json.RawMessage(`{}`)); !isErr || text != NoEditorText {
		t.Fatalf("a window: %q isErr=%v", text, isErr)
	}
}

// get_view and show_board go to a window that shows the chat's board, never to the editor. With no
// such window they are answered in plain words, not as a failure, and the editor is not started.
func TestScreenCalls(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	other := e.newBoard("other")
	away := e.away()
	pages := e.connect("P1", "P2", "H")
	h := pages["H"]

	want := map[string]string{
		"get_view": "No window shows arch (" + e.board.ID + ") now, so there is no view and no selection to read. " +
			"The board itself can be read and changed as usual: use read_board, and get_image for a picture.",
		"show_board": "No window shows this chat's board now, so arch (" + e.board.ID + ") could not be put on a screen. " +
			"Your changes are saved in the board; the user sees them when they open it.",
	}
	for tool, text := range want {
		if got, isErr := e.relay.Call(e.token, tool, nil); isErr || got != text {
			t.Fatalf("%s with no window showing the board: %q isErr=%v", tool, got, isErr)
		}
	}
	if got, isErr := e.relay.Call(e.token, "show_board", json.RawMessage(`{"board":"`+other.ID+`"}`)); isErr ||
		!strings.Contains(got, "so other ("+other.ID+") could not be put on a screen") {
		t.Fatalf("show_board of another board: %q isErr=%v", got, isErr)
	}

	// The editor holds the chat's board and nobody follows it: still no window to ask.
	e.take("H", e.board.ID)
	if got, isErr := e.relay.Call(e.token, "get_view", nil); isErr || got != want["get_view"] {
		t.Fatalf("get_view with the editor holding the board: %q isErr=%v", got, isErr)
	}
	e.relay.Bridge.ReleaseBoard("H", e.board.ID)

	// A window that follows the chat's board is asked, also when another window holds it.
	e.take("P1", e.board.ID)
	e.relay.Bridge.Follow("P2", editorbridge.Board(e.board.ID))
	for id, p := range pages {
		if id != "H" {
			p.OnRPC(func(params map[string]any) (any, string) { return id + ":" + params["name"].(string), "" })
		}
	}
	for _, tool := range []string{"get_view", "show_board"} {
		if got, isErr := e.relay.Call(e.token, tool, nil); isErr || got != "P2:"+tool {
			t.Fatalf("%s with a following window: %q isErr=%v", tool, got, isErr)
		}
	}
	h.ExpectNone(50 * time.Millisecond)
	if ensured, _ := away.counts(); ensured != 0 {
		t.Fatalf("Ensure was called %d times", ensured)
	}
}

// With no background editor, a screen call that no window can answer keeps the old text.
func TestScreenCallWithNoAwayEditorAndNoWindow(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	for _, tool := range []string{"get_view", "show_board"} {
		if got, isErr := e.relay.Call(e.token, tool, nil); !isErr || got != NoClientText {
			t.Fatalf("%s: %q isErr=%v", tool, got, isErr)
		}
	}
}

// A call cut by a hand-off is told that the board was taken over, not that the window is closed.
func TestCallCutByAHandOff(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	other := e.newBoard("other")
	e.away()
	pages := e.connect("P1", "P2")
	p1 := pages["P1"]
	e.take("P1", other.ID)

	done := e.callAsync("apply", `{"board":"`+other.ID+`"}`)
	p1.Expect("rpc")
	if state, _, err := e.relay.Bridge.TakeBoard("P2", other.ID, false); err != nil || state != "waiting" {
		t.Fatalf("take: %q %v", state, err)
	}
	p1.Expect("release_request")
	if got := e.relay.Bridge.ReleaseBoard("P1", other.ID); got != "handed" {
		t.Fatalf("release = %q", got)
	}
	if got := e.wait(done); !got.isErr || got.text != TakenText {
		t.Fatalf("got %+v", got)
	}
}

// A call of the background editor whose stream ends is told that the editor stopped; a call of a
// window whose stream ends is told that the window is closed, as before.
func TestCallCutByTheEndOfAStream(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	other := e.newBoard("other")
	e.away()
	pages := e.connect("P1", "H")
	p1, h := pages["P1"], pages["H"]

	done := e.callAsync("apply", `{"board":"`+other.ID+`"}`)
	h.Expect("held")
	h.Expect("rpc")
	h.Close()
	if got := e.wait(done); !got.isErr || got.text != AwayLostText {
		t.Fatalf("editor: %+v", got)
	}

	e.take("P1", other.ID)
	done = e.callAsync("apply", `{"board":"`+other.ID+`"}`)
	p1.Expect("rpc")
	p1.Close()
	if got := e.wait(done); !got.isErr || got.text != NoClientText {
		t.Fatalf("window: %+v", got)
	}
}

// A call that the background editor does not answer in time is reported to it, so that it is
// stopped; a window's silent call is not. The agent is told what it was before.
func TestCallTimedOutIsReportedToTheAwayEditor(t *testing.T) {
	old := callTimeout
	callTimeout = 200 * time.Millisecond
	t.Cleanup(func() { callTimeout = old })
	e := newEnv(t)
	other := e.newBoard("other")
	away := e.away()
	e.connect("P1", "H")
	e.take("P1", e.board.ID)

	if got := e.wait(e.callAsync("apply", `{"board":"`+other.ID+`"}`)); !got.isErr || !strings.HasPrefix(got.text, "the board did not answer tool in ") {
		t.Fatalf("editor: %+v", got)
	}
	if _, timedOut := away.counts(); timedOut != 1 {
		t.Fatalf("CallTimedOut was called %d times", timedOut)
	}
	// The editor still holds the board: a second silent call is reported again.
	if got := e.wait(e.callAsync("apply", `{"board":"`+other.ID+`"}`)); !got.isErr || !strings.HasPrefix(got.text, "the board did not answer") {
		t.Fatalf("editor again: %+v", got)
	}
	if _, timedOut := away.counts(); timedOut != 2 {
		t.Fatalf("CallTimedOut was called %d times", timedOut)
	}

	if got := e.wait(e.callAsync("apply", `{}`)); !got.isErr || !strings.HasPrefix(got.text, "the board did not answer") {
		t.Fatalf("window: %+v", got)
	}
	if _, timedOut := away.counts(); timedOut != 2 {
		t.Fatalf("a window's silent call was reported: %d", timedOut)
	}
}

// list_boards and create_board stay answered by the server, with the editor not started; the
// board that create_board made is free, and the agent's next call on it is away.
func TestCreateBoardThenAwayCall(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	away := e.away()
	h := e.connect("H")["H"]
	text, isErr := e.relay.Call(e.token, "create_board", json.RawMessage(`{"name":"fresh"}`))
	if isErr || !strings.HasPrefix(text, "created fresh (") {
		t.Fatalf("create_board: %q isErr=%v", text, isErr)
	}
	var id string
	for _, bd := range e.relay.Boards.List() {
		if bd.Name == "fresh" {
			id = bd.ID
		}
	}
	h.Expect("board") // the list event of the new board
	if ensured, _ := away.counts(); ensured != 0 {
		t.Fatalf("Ensure was called %d times", ensured)
	}
	done := e.callAsync("apply", `{"board":"`+id+`"}`)
	h.Expect("held")
	rpc := h.Expect("rpc")
	reply(t, h, rpc, "drawn")
	if got := e.wait(done); got.isErr || got.text != "drawn" {
		t.Fatalf("got %+v", got)
	}
}
