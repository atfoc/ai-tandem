package boardapi

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/tlrelay"
)

// fakeTL stands in for the relay of new boards: CallTool records its calls and answers with out
// or err; ScreenClient answers with screen when it is set and counts its calls.
type fakeTL struct {
	mu      sync.Mutex
	calls   []tlrelay.ToolCall
	out     json.RawMessage
	err     error
	screen  string
	screens []string
}

func (f *fakeTL) CallTool(c tlrelay.ToolCall) (json.RawMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, c)
	if f.err != nil {
		return nil, f.err
	}
	if f.out != nil {
		return f.out, nil
	}
	return json.RawMessage(`"host:` + c.Tool + `"`), nil
}

func (f *fakeTL) ScreenClient(board string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.screens = append(f.screens, board)
	return f.screen, f.screen != ""
}

func (f *fakeTL) recorded() []tlrelay.ToolCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]tlrelay.ToolCall(nil), f.calls...)
}

// tl gives the env a fake relay of new boards and returns it.
func (e *env) tl() *fakeTL {
	f := &fakeTL{}
	e.relay.TL = f
	return f
}

// newTLBoard makes one more board, a new board (kind tl), ungrouped.
func (e *env) newTLBoard(name string) model.Board {
	e.t.Helper()
	bd, err := e.relay.Boards.Create(name, model.Ungrouped, false, model.KindTL)
	if err != nil {
		e.t.Fatal(err)
	}
	return bd
}

// tlChat makes a Claude chat whose board is a new board, and returns the board and the chat's token.
func (e *env) tlChat() (model.Board, string, string) {
	e.t.Helper()
	bd := e.newTLBoard("multi")
	v, err := e.relay.Chats.Create(model.Claude, "", bd.ID)
	if err != nil {
		e.t.Fatal(err)
	}
	metas := e.relay.Chats.ChatsOfBoard(bd.ID)
	if len(metas) != 1 || metas[0].Token == "" {
		e.t.Fatalf("board chats %+v", metas)
	}
	return bd, metas[0].Token, v.ID
}

// The board tools of a new board reach the relay of new boards with the whole call, and never a
// window or the background editor, also when a window holds the board.
func TestTLBoardToolsGoToTheBoardHost(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	tl := e.tl()
	away := e.away()
	bd, token, chat := e.tlChat()
	pages := e.connect("P1", "H")
	e.take("P1", bd.ID) // even a window that holds it is not asked

	calls := []struct{ tool, args string }{
		{"read_board", `{}`},
		{"apply", `{"ops":[{"op":"create","type":"sticky","ref":"n1","x":0,"y":0,"text":"Idea"}]}`},
		{"delete_elements", `{"refs":[{"id":"shape:a1"}],"cascade":true}`},
		{"get_image", `{"scope":"all"}`},
	}
	for i, c := range calls {
		res := e.relay.CallResult(token, c.tool, json.RawMessage(c.args))
		if res.IsErr || res.Text != "host:"+c.tool {
			t.Fatalf("%s: %+v", c.tool, res)
		}
		got := tl.recorded()
		if len(got) != i+1 {
			t.Fatalf("%s: %d calls", c.tool, len(got))
		}
		call := got[i]
		args, _ := call.Args.(json.RawMessage)
		if call.Chat != chat || call.Branch != "main" || call.ChatBoard != bd.ID || call.Board != bd.ID ||
			call.Tool != c.tool || string(args) != c.args ||
			call.Agent != (tlrelay.Agent{Kind: "claude", Label: "Claude"}) {
			t.Fatalf("%s: call %+v (args %s)", c.tool, call, args)
		}
	}
	for _, p := range pages {
		p.ExpectNone(50 * time.Millisecond)
	}
	if ensured, _ := away.counts(); ensured != 0 {
		t.Fatalf("Ensure was called %d times", ensured)
	}
}

// A tool about a new board named with board, from a chat whose board is an old one, goes to the
// relay of new boards too; the old board's calls stay as they were.
func TestTLBoardNamedFromAClassicChat(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	tl := e.tl()
	away := e.away()
	bd := e.newTLBoard("multi")
	pages := e.connect("P1", "H")
	if res := e.relay.CallResult(e.token, "read_board", json.RawMessage(`{"board":"`+bd.ID+`"}`)); res.IsErr || res.Text != "host:read_board" {
		t.Fatalf("read_board: %+v", res)
	}
	got := tl.recorded()
	if len(got) != 1 || got[0].ChatBoard != e.board.ID || got[0].Board != bd.ID || got[0].Chat != e.chat {
		t.Fatalf("calls %+v", got)
	}
	for _, p := range pages {
		p.ExpectNone(50 * time.Millisecond)
	}
	if ensured, _ := away.counts(); ensured != 0 {
		t.Fatalf("Ensure was called %d times", ensured)
	}

	// The chat's own (old) board still goes to the window that holds it.
	e.take("P1", e.board.ID)
	done := e.callAsync("read_board", `{}`)
	rpc := pages["P1"].Expect("rpc")
	reply(t, pages["P1"], rpc, "window")
	if a := e.wait(done); a.isErr || a.text != "window" {
		t.Fatalf("old board: %+v", a)
	}
	if len(tl.recorded()) != 1 {
		t.Fatal("the old board's call reached the relay of new boards")
	}
}

// The board host's answers come out as a window's do: text, text with a picture, and an error
// whose text is the agent's whole text.
func TestTLResults(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	tl := e.tl()
	bd := e.newTLBoard("multi")
	args := json.RawMessage(`{"board":"` + bd.ID + `","scope":"all"}`)

	tl.out = json.RawMessage(`"plain"`)
	if res := e.relay.CallResult(e.token, "get_image", args); res.IsErr || res.Text != "plain" || res.Image != nil {
		t.Fatalf("text: %+v", res)
	}
	data := pngB64(20)
	tl.out = mustJSON(t, imageReply("image/png", data))
	res := e.relay.CallResult(e.token, "get_image", args)
	if res.IsErr || !strings.HasPrefix(res.Text, "bounds") || res.Image == nil || res.Image.Data != data || res.Image.MimeType != "image/png" {
		t.Fatalf("image: %+v", res)
	}
	tl.out = mustJSON(t, imageReply("image/gif", data))
	if res := e.relay.CallResult(e.token, "get_image", args); !res.IsErr || res.Image != nil {
		t.Fatalf("bad image: %+v", res)
	}
	tl.err = errors.New(tlrelay.HostStoppedText)
	if res := e.relay.CallResult(e.token, "apply", json.RawMessage(`{"board":"`+bd.ID+`","ops":[]}`)); !res.IsErr || res.Text != tlrelay.HostStoppedText {
		t.Fatalf("error: %+v", res)
	}
}

// A server with no relay of new boards says so, and asks nobody.
func TestTLBoardWithNoRelay(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	away := e.away()
	bd := e.newTLBoard("multi")
	pages := e.connect("P1", "H")
	for _, tool := range []string{"read_board", "apply", "delete_elements", "get_image"} {
		if text, isErr := e.relay.Call(e.token, tool, json.RawMessage(`{"board":"`+bd.ID+`"}`)); !isErr || text != NoTLText {
			t.Fatalf("%s: %q isErr=%v", tool, text, isErr)
		}
	}
	for _, p := range pages {
		p.ExpectNone(50 * time.Millisecond)
	}
	if ensured, _ := away.counts(); ensured != 0 {
		t.Fatalf("Ensure was called %d times", ensured)
	}
}

// An apply in the terms of the other kind of board is refused before anyone is asked.
func TestApplyMixedTermsRefused(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	tl := e.tl()
	bd := e.newTLBoard("multi")
	for _, args := range []string{
		`{"board":"` + bd.ID + `","create":[{"type":"rectangle"}]}`,
		`{"board":"` + bd.ID + `","update":[]}`,
		`{"board":"` + bd.ID + `","ops":[],"create":[]}`,
	} {
		if text, isErr := e.relay.Call(e.token, "apply", json.RawMessage(args)); !isErr || text != MixedTLText {
			t.Fatalf("%s: %q isErr=%v", args, text, isErr)
		}
	}
	if text, isErr := e.relay.Call(e.token, "apply", json.RawMessage(`{"ops":[]}`)); !isErr || text != MixedClassicText {
		t.Fatalf("ops on a classic board: %q isErr=%v", text, isErr)
	}
	if n := len(tl.recorded()); n != 0 {
		t.Fatalf("%d calls reached the relay", n)
	}
	// Without ops a new board's apply is the board host's to answer.
	if text, isErr := e.relay.Call(e.token, "apply", json.RawMessage(`{"board":"`+bd.ID+`"}`)); isErr || text != "host:apply" {
		t.Fatalf("no ops: %q isErr=%v", text, isErr)
	}
}

func TestCreateBoardKind(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	find := func(name string) model.Board {
		for _, bd := range e.relay.Boards.List() {
			if bd.Name == name {
				return bd
			}
		}
		t.Fatalf("no board %s", name)
		return model.Board{}
	}
	text, isErr := e.relay.Call(e.token, "create_board", json.RawMessage(`{"name":"multi","kind":"new"}`))
	bd := find("multi")
	if isErr || text != "created multi ("+bd.ID+") in Ungrouped, a new board" || bd.Kind != model.KindTL || !bd.New {
		t.Fatalf("new: %q isErr=%v %+v", text, isErr, bd)
	}
	for _, c := range []struct{ name, args string }{
		{"plain", `{"name":"plain"}`},
		{"classic", `{"name":"classic","kind":"classic"}`},
		{"nul", `{"name":"nul","kind":null}`},
	} {
		text, isErr := e.relay.Call(e.token, "create_board", json.RawMessage(c.args))
		bd := find(c.name)
		if isErr || text != "created "+c.name+" ("+bd.ID+") in Ungrouped" || bd.Kind != model.KindClassic {
			t.Fatalf("%s: %q isErr=%v %+v", c.args, text, isErr, bd)
		}
	}
	n := len(e.relay.Boards.List())
	for _, args := range []string{`{"name":"x","kind":"tl"}`, `{"name":"x","kind":1}`, `{"name":"x","kind":""}`} {
		if text, isErr := e.relay.Call(e.token, "create_board", json.RawMessage(args)); !isErr || text != `BAD_ARGS: kind is "new" or "classic"` {
			t.Fatalf("%s: %q isErr=%v", args, text, isErr)
		}
	}
	if len(e.relay.Boards.List()) != n {
		t.Fatal("a refused create_board made a board")
	}
}

func TestListBoardsMarksANewBoard(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	bd := e.newTLBoard("multi")
	want := "arch  (" + e.board.ID + ")  [Ungrouped]  (this chat's board)\n" +
		"multi  (" + bd.ID + ")  [Ungrouped]  (new board)"
	if text, isErr := e.relay.Call(e.token, "list_boards", nil); isErr || text != want {
		t.Fatalf("got %q isErr=%v", text, isErr)
	}
	_, token, _ := e.tlChat()
	text, _ := e.relay.Call(token, "list_boards", nil)
	if !strings.Contains(text, ")  [Ungrouped]  (new board)  (this chat's board)") {
		t.Fatalf("the chat's own new board: %q", text)
	}
}

// A screen call from a chat on a new board goes to the window the relay names, and to no other;
// with none, the agent is told that no window shows the board, as no error.
func TestTLScreenCalls(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	tl := e.tl()
	bd, token, _ := e.tlChat()
	pages, seen := e.pages("P1", "P2")
	e.take("P1", bd.ID) // without the relay's window, the call would go here
	tl.screen = "P2"
	for _, tool := range []string{"get_view", "show_board"} {
		if text, isErr := e.relay.Call(token, tool, nil); isErr || text != "P2:"+tool {
			t.Fatalf("%s: %q isErr=%v", tool, text, isErr)
		}
		if p := asked(t, seen, "P2"); p["name"] != tool || p["board"] != bd.ID {
			t.Fatalf("%s: rpc params %v", tool, p)
		}
	}
	for _, p := range pages {
		p.ExpectNone(50 * time.Millisecond)
	}
	if len(tl.recorded()) != 0 {
		t.Fatal("a screen call reached CallTool")
	}

	// No window shows it (and no background editor on this server): the plain words.
	e.relay.Bridge.ReleaseBoard("P1", bd.ID)
	tl.screen = ""
	if text, isErr := e.relay.Call(token, "get_view", nil); isErr || !strings.HasPrefix(text, "No window shows multi ("+bd.ID+") now") {
		t.Fatalf("get_view with no window: %q isErr=%v", text, isErr)
	}
	if text, isErr := e.relay.Call(token, "show_board", nil); isErr || !strings.HasPrefix(text, "No window shows this chat's board now") {
		t.Fatalf("show_board with no window: %q isErr=%v", text, isErr)
	}
	if len(tl.screens) != 4 || tl.screens[0] != bd.ID {
		t.Fatalf("ScreenClient asked %v", tl.screens)
	}
}

// show_board of a new board from a chat on an old board goes to the window of the chat's board, as
// today, and does not ask the relay for a window.
func TestShowTLBoardFromAClassicChat(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	tl := e.tl()
	bd := e.newTLBoard("multi")
	_, seen := e.pages("P1")
	e.take("P1", e.board.ID)
	if text, isErr := e.relay.Call(e.token, "show_board", json.RawMessage(`{"board":"`+bd.ID+`"}`)); isErr || text != "P1:show_board" {
		t.Fatalf("got %q isErr=%v", text, isErr)
	}
	if p := asked(t, seen, "P1"); p["target"] != bd.ID {
		t.Fatalf("rpc params %v", p)
	}
	if len(tl.screens) != 0 || len(tl.recorded()) != 0 {
		t.Fatalf("relay asked: screens %v calls %v", tl.screens, tl.recorded())
	}
}

func TestAgentLabel(t *testing.T) {
	for kind, want := range map[model.AgentKind]string{model.Claude: "Claude", model.Cursor: "Cursor", model.Pi: "pi"} {
		if got := agentLabel(kind); got != want {
			t.Errorf("%s: %q", kind, got)
		}
	}
}
