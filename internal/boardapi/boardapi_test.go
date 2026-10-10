package boardapi

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/boardtools"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

type env struct {
	t      *testing.T
	relay  *Relay
	mux    *http.ServeMux
	board  model.Board
	token  string
	chat   string
	claude *fakeSpawner
}

func newEnv(t *testing.T) *env {
	t.Helper()
	st, err := store.Open(store.NewPaths(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	br := editorbridge.New(nil)
	bds := boards.New(st, br)
	if err := bds.Load(); err != nil {
		t.Fatal(err)
	}
	claude := &fakeSpawner{}
	m := chats.New(chats.Deps{
		Store: st, Bridge: br, Boards: bds, DefaultCwd: t.TempDir(),
		MCPURL:   "http://localhost:6006/mcp",
		Spawners: map[model.AgentKind]agent.Spawner{model.Claude: claude},
	})
	if err := m.Load(); err != nil {
		t.Fatal(err)
	}
	bd, err := bds.Create("arch", model.Ungrouped, false)
	if err != nil {
		t.Fatal(err)
	}
	v, err := m.Create(model.Claude, "", bd.ID)
	if err != nil {
		t.Fatal(err)
	}
	metas := m.ChatsOfBoard(bd.ID)
	if len(metas) != 1 || metas[0].Token == "" {
		t.Fatalf("board chats %+v", metas)
	}
	r := &Relay{Bridge: br, Chats: m, Boards: bds}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /mcp", r.ServeFixedMCP) // the only MCP route (header credential)
	mux.HandleFunc("GET /api/events", br.ServeSSE)
	mux.HandleFunc("POST /api/rpc-reply", func(w http.ResponseWriter, req *http.Request) { // as the server does
		var body struct {
			ID string `json:"id"`
			editorbridge.RPCReply
		}
		json.NewDecoder(req.Body).Decode(&body)
		if !br.ReplyFrom(req.Header.Get(bridgetest.ClientHeader), body.ID, body.RPCReply) {
			w.WriteHeader(http.StatusConflict)
		}
	})
	return &env{t: t, relay: r, mux: mux, board: bd, token: metas[0].Token, chat: v.ID, claude: claude}
}

// mcp posts one JSON-RPC message to the fixed /mcp route with the token as the bearer
// credential and returns the response.
func (e *env) mcp(token, body string) (*http.Response, map[string]any) {
	e.t.Helper()
	req := httptest.NewRequest("POST", "/mcp", strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, req)
	resp := w.Result()
	var out map[string]any
	if resp.StatusCode == 200 {
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			e.t.Fatal(err)
		}
	}
	return resp, out
}

// callResult checks a tools/call response and returns its text and isError.
func callResult(t *testing.T, out map[string]any) (string, bool) {
	t.Helper()
	res, ok := out["result"].(map[string]any)
	if !ok {
		t.Fatalf("no result: %v", out)
	}
	content := res["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("content %v", content)
	}
	c := content[0].(map[string]any)
	if c["type"] != "text" {
		t.Fatalf("content %v", c)
	}
	isErr, _ := res["isError"].(bool)
	return c["text"].(string), isErr
}

// client connects an SSE client that answers every rpc with answer(params).
func (e *env) client(answer func(params map[string]any) editorbridge.RPCReply) {
	e.t.Helper()
	srv := httptest.NewServer(e.mux)
	e.t.Cleanup(srv.Close)
	ctx, cancel := context.WithCancel(context.Background())
	e.t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/events?client=A", nil)
	resp, err := srv.Client().Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	active := make(chan struct{})
	go func() {
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(nil, 1<<20)
		for sc.Scan() {
			line, ok := strings.CutPrefix(sc.Text(), "data: ")
			if !ok {
				continue
			}
			var ev map[string]any
			if json.Unmarshal([]byte(line), &ev) != nil {
				continue
			}
			switch ev["type"] {
			case "hello":
				close(active)
			case "rpc":
				p, _ := ev["params"].(map[string]any)
				e.relay.Bridge.ReplyFrom("A", ev["id"].(string), answer(p))
			}
		}
	}()
	select {
	case <-active:
	case <-time.After(2 * time.Second):
		e.t.Fatal("client not active")
	}
	e.relay.Bridge.Acted("A") // a page that only opened its stream is asked no tool call
}

func TestInitializeEchoesProtocolVersion(t *testing.T) {
	e := newEnv(t)
	_, out := e.mcp(e.token, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`)
	res := out["result"].(map[string]any)
	if res["protocolVersion"] != "2025-06-18" {
		t.Fatalf("protocolVersion %v", res["protocolVersion"])
	}
	if res["serverInfo"].(map[string]any)["name"] != "board" {
		t.Fatalf("serverInfo %v", res["serverInfo"])
	}
	if out["id"] != float64(1) || out["jsonrpc"] != "2.0" {
		t.Fatalf("envelope %v", out)
	}
}

func TestToolsList(t *testing.T) {
	e := newEnv(t)
	_, out := e.mcp(e.token, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	tools := out["result"].(map[string]any)["tools"].([]any)
	want := append(append([]boardtools.Tool{}, boardtools.Tools...), boardtools.SpawnFamily...)
	if len(tools) != len(want) || len(boardtools.Tools) != 8 {
		t.Fatalf("%d tools, boardtools.Tools=%d", len(tools), len(boardtools.Tools))
	}
	for i, x := range tools {
		tl := x.(map[string]any)
		if tl["name"] != want[i].Name || tl["description"] != want[i].Description {
			t.Fatalf("tool %d = %v, want %v", i, tl["name"], want[i].Name)
		}
		if s, ok := tl["inputSchema"].(map[string]any); !ok || s["type"] != "object" {
			t.Fatalf("tool %v inputSchema %v", tl["name"], tl["inputSchema"])
		}
	}
}

func TestMCPProtocolBits(t *testing.T) {
	e := newEnv(t)
	_, out := e.mcp(e.token, `{"jsonrpc":"2.0","id":3,"method":"ping"}`)
	if _, ok := out["result"].(map[string]any); !ok {
		t.Fatalf("ping %v", out)
	}
	_, out = e.mcp(e.token, `{"jsonrpc":"2.0","id":4,"method":"resources/list"}`)
	if out["error"].(map[string]any)["code"] != float64(-32601) {
		t.Fatalf("unknown method %v", out)
	}
	resp, _ := e.mcp(e.token, `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("notification status %d", resp.StatusCode)
	}
	req := httptest.NewRequest("GET", "/mcp", nil)
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status %d", w.Code)
	}
	resp, _ = e.mcp(e.token, `{nope`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad json status %d", resp.StatusCode)
	}
}

func TestToolsCallUnknownToken(t *testing.T) {
	e := newEnv(t)
	_, out := e.mcp(strings.Repeat("0", 32), `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}`)
	text, isErr := callResult(t, out)
	if !isErr || text != "unknown board token" {
		t.Fatalf("got %q isError=%v", text, isErr)
	}
}

func TestToolsCallNoClient(t *testing.T) {
	e := newEnv(t)
	start := time.Now()
	_, out := e.mcp(e.token, `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"read_board","arguments":{}}}`)
	text, isErr := callResult(t, out)
	if !isErr || text != NoClientText {
		t.Fatalf("got %q isError=%v", text, isErr)
	}
	if !strings.HasPrefix(text, "The board isn't open") {
		t.Fatalf("text %q", text)
	}
	if time.Since(start) > time.Second {
		t.Fatal("did not fail at once")
	}
}

func TestToolsCallThroughClient(t *testing.T) {
	e := newEnv(t)
	got := make(chan map[string]any, 1)
	e.client(func(p map[string]any) editorbridge.RPCReply {
		got <- p
		return editorbridge.RPCReply{Result: json.RawMessage(`"rect r1 at 0,0"`)}
	})
	other, err := e.relay.Boards.Create("other", model.Ungrouped, false)
	if err != nil {
		t.Fatal(err)
	}
	_, out := e.mcp(e.token, `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"read_board","arguments":{"board":"`+other.ID+`"}}}`)
	text, isErr := callResult(t, out)
	if isErr || text != "rect r1 at 0,0" {
		t.Fatalf("got %q isError=%v", text, isErr)
	}
	p := <-got
	if p["chat"] != e.chat || p["branch"] != model.MainBranch || p["board"] != e.board.ID || p["target"] != other.ID ||
		p["name"] != "read_board" || p["args"].(map[string]any)["board"] != other.ID {
		t.Fatalf("rpc params %v", p)
	}
}

func TestRelayCallObjectAndErrorResults(t *testing.T) {
	e := newEnv(t)
	e.client(func(p map[string]any) editorbridge.RPCReply {
		if p["name"] == "get_view" {
			return editorbridge.RPCReply{Result: json.RawMessage(`{"board":"b_1"}`)}
		}
		return editorbridge.RPCReply{Error: "no such board"}
	})
	if text, isErr := e.relay.Call(e.token, "get_view", nil); isErr || text != `{"board":"b_1"}` {
		t.Fatalf("get_view: %q %v", text, isErr)
	}
	if text, isErr := e.relay.Call(e.token, "read_board", json.RawMessage(`{}`)); !isErr || text != "no such board" {
		t.Fatalf("read_board: %q %v", text, isErr)
	}
}

func TestRelayCallArchivedChat(t *testing.T) {
	e := newEnv(t)
	if err := e.relay.Chats.SetArchive(e.chat, model.Archive{Archived: true, Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	text, isErr := e.relay.Call(e.token, "list_boards", nil)
	if !isErr || text != "this chat is archived" {
		t.Fatalf("got %q isErr=%v", text, isErr)
	}
}

func TestRelayCallLegacyChat(t *testing.T) {
	e := newEnv(t)
	markLegacyAndReload(t, e)
	text, isErr := e.relay.Call(e.token, "list_boards", nil)
	if !isErr || text != "this chat used the old board connection" {
		t.Fatalf("got %q isErr=%v", text, isErr)
	}
}

// markLegacyAndReload persists instructionsSent on the test chat and reloads the chats manager,
// matching a restart of a curl-era Cursor board chat (there is no setter).
func markLegacyAndReload(t *testing.T, e *env) {
	t.Helper()
	m := e.relay.Chats
	path := filepath.Join(m.Store.P.ChatDir(e.chat), "chat.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var meta model.ChatMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatal(err)
	}
	meta.InstructionsSent = true
	if err := store.WriteJSONAtomic(path, meta, 0o600); err != nil {
		t.Fatal(err)
	}
	nm := chats.New(chats.Deps{Store: m.Store, Bridge: e.relay.Bridge, Boards: e.relay.Boards, DefaultCwd: m.DefaultCwd})
	if err := nm.Load(); err != nil {
		t.Fatal(err)
	}
	e.relay.Chats = nm
}

func TestRelayCallUnknownTool(t *testing.T) {
	e := newEnv(t)
	text, isErr := e.relay.Call(e.token, "rm_rf", nil)
	if !isErr || text != "unknown tool rm_rf" {
		t.Fatalf("got %q isErr=%v", text, isErr)
	}
}

// ---- board tool calls by target board --------------------------------------

// rpcSeen is one tool call as a stand-in page received it.
type rpcSeen struct {
	page   string
	params map[string]any
}

// pages serves the env's routes and connects one stand-in page per id. Each page answers a
// tool call with "<id>:<tool>" and passes what it received to seen. A page has only opened its
// stream: a test makes it act or hold a board through the bridge.
func (e *env) pages(ids ...string) (pages []*bridgetest.Page, seen chan rpcSeen) {
	e.t.Helper()
	srv := httptest.NewServer(e.mux)
	e.t.Cleanup(srv.Close)
	seen = make(chan rpcSeen, 64)
	for _, id := range ids {
		p := bridgetest.Connect(e.t, srv.URL, id)
		p.Welcome()
		p.OnRPC(func(params map[string]any) (any, string) {
			seen <- rpcSeen{id, params}
			return id + ":" + fmt.Sprint(params["name"]), ""
		})
		pages = append(pages, p)
	}
	return pages, seen
}

// take makes the page the holder of the board, as its take call does.
func (e *env) take(page, board string) {
	e.t.Helper()
	if state, _, err := e.relay.Bridge.TakeBoard(page, board, false); err != nil || state != "held" {
		e.t.Fatalf("take of %s by %s: %q %v", board, page, state, err)
	}
}

// addGroups makes the group Work and, inside it, the group Infra.
func (e *env) addGroups() {
	e.t.Helper()
	if err := e.relay.Chats.Store.Update(func(s *model.State) error {
		s.Groups = append(s.Groups, model.Group{ID: "g_work", Name: "Work"}, model.Group{ID: "g_infra", Name: "Infra", Parent: "g_work"})
		return nil
	}); err != nil {
		e.t.Fatal(err)
	}
}

// newBoard makes one more board, ungrouped.
func (e *env) newBoard(name string) model.Board {
	e.t.Helper()
	bd, err := e.relay.Boards.Create(name, model.Ungrouped, false)
	if err != nil {
		e.t.Fatal(err)
	}
	return bd
}

// asked returns the one call the pages received, which must have gone to this page.
func asked(t *testing.T, seen chan rpcSeen, page string) map[string]any {
	t.Helper()
	select {
	case got := <-seen:
		if got.page != page {
			t.Fatalf("page %s was asked %v, want page %s", got.page, got.params, page)
		}
		return got.params
	case <-time.After(bridgetest.Wait):
		t.Fatalf("page %s was not asked", page)
		return nil
	}
}

// A call about a held board goes to that board's holder, whoever holds the chat's board.
func TestCallGoesToTheHolderOfItsTarget(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	other := e.newBoard("other")
	pages, seen := e.pages("P1", "P2")
	e.take("P1", e.board.ID)
	e.take("P2", other.ID)

	for _, tool := range []string{"read_board", "apply", "delete_elements"} {
		args := `{"board":"` + other.ID + `","refs":[]}`
		text, isErr := e.relay.Call(e.token, tool, json.RawMessage(args))
		if isErr || text != "P2:"+tool {
			t.Fatalf("%s on the other board: %q isErr=%v", tool, text, isErr)
		}
		p := asked(t, seen, "P2")
		if len(p) != 6 || p["chat"] != e.chat || p["branch"] != model.MainBranch || p["board"] != e.board.ID ||
			p["target"] != other.ID || p["name"] != tool || p["args"].(map[string]any)["board"] != other.ID {
			t.Fatalf("%s: rpc params %v", tool, p)
		}
		// Without a board the call is about the chat's own, and so is an empty one.
		for _, args := range []string{`{}`, `{"board":""}`, `null`} {
			if text, isErr := e.relay.Call(e.token, tool, json.RawMessage(args)); isErr || text != "P1:"+tool {
				t.Fatalf("%s %s on the chat's board: %q isErr=%v", tool, args, text, isErr)
			}
			if p := asked(t, seen, "P1"); p["board"] != e.board.ID || p["target"] != e.board.ID {
				t.Fatalf("%s %s: rpc params %v", tool, args, p)
			}
		}
	}
	// Neither page got anything but its calls: no board changed hands.
	for _, p := range pages {
		p.ExpectNone(50 * time.Millisecond)
	}
	if id, _ := e.relay.Bridge.HolderOf(other.ID); id != "P2" {
		t.Fatalf("the other board's holder is %q", id)
	}
}

// A call about a board nobody holds goes to the holder of the chat's board, which is given the
// board first: held arrives before the call. A page that acted later is not asked.
func TestCallForAFreeBoardGoesToTheHolderOfTheChatsBoard(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	other := e.newBoard("other")
	pages, seen := e.pages("P1", "P2")
	p1, p2 := pages[0], pages[1]
	p1.OnRPC(nil) // read its events in order
	e.take("P1", e.board.ID)
	e.relay.Bridge.Acted("P2")

	type answer struct {
		text  string
		isErr bool
	}
	done := make(chan answer, 1)
	go func() {
		text, isErr := e.relay.Call(e.token, "apply", json.RawMessage(`{"board":"`+other.ID+`"}`))
		done <- answer{text, isErr}
	}()
	if held := p1.Expect("held"); held["board"] != other.ID || held["rev"] != float64(0) {
		t.Fatalf("held = %v", held)
	}
	rpc := p1.Expect("rpc")
	if p := rpc["params"].(map[string]any); rpc["method"] != "tool" || p["target"] != other.ID || p["board"] != e.board.ID || p["name"] != "apply" {
		t.Fatalf("rpc = %v", rpc)
	}
	if id, _ := e.relay.Bridge.HolderOf(other.ID); id != "P1" {
		t.Fatalf("the free board's holder is %q, want P1", id)
	}
	// Another page's answer is refused and the call stays open.
	if status, _ := p2.Do("POST", "/api/rpc-reply", map[string]any{"id": rpc["id"], "result": "stolen"}); status != http.StatusConflict {
		t.Fatalf("a reply from the page that was not asked: status %d", status)
	}
	if status, _ := p1.Do("POST", "/api/rpc-reply", map[string]any{"id": rpc["id"], "result": "applied"}); status != http.StatusOK {
		t.Fatalf("the asked page's reply: status %d", status)
	}
	if got := <-done; got.isErr || got.text != "applied" {
		t.Fatalf("got %+v", got)
	}
	p2.ExpectNone(50 * time.Millisecond)
	select {
	case got := <-seen:
		t.Fatalf("page %s was asked %v", got.page, got.params)
	default:
	}
}

// One page, which holds nothing, is asked every tool on every board once it has acted.
func TestOnePageGetsEveryToolOnEveryBoard(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	other := e.newBoard("other")
	_, seen := e.pages("P1")
	e.relay.Bridge.Acted("P1")
	for _, bd := range []model.Board{e.board, other} {
		for _, tool := range []string{"read_board", "get_view", "get_image", "apply", "delete_elements", "show_board"} {
			text, isErr := e.relay.Call(e.token, tool, json.RawMessage(`{"board":"`+bd.ID+`"}`))
			if isErr || text != "P1:"+tool {
				t.Fatalf("%s on %s: %q isErr=%v", tool, bd.Name, text, isErr)
			}
			p := asked(t, seen, "P1")
			target, has := p["target"]
			if tool == "get_view" { // about the screen: it names no board
				if has {
					t.Fatalf("get_view: rpc params %v", p)
				}
			} else if target != bd.ID {
				t.Fatalf("%s on %s: rpc params %v", tool, bd.Name, p)
			}
			if p["board"] != e.board.ID || p["chat"] != e.chat || p["name"] != tool {
				t.Fatalf("%s on %s: rpc params %v", tool, bd.Name, p)
			}
		}
		// The calls about the board gave it to the page; the calls about the screen gave nothing.
		if id, _ := e.relay.Bridge.HolderOf(bd.ID); id != "P1" {
			t.Fatalf("holder of %s is %q", bd.Name, id)
		}
	}
}

// With no page, and with a page that has only opened its stream, a call that needs a page
// fails at once with the text for the agent.
func TestCallWithNoPageFailsAtOnce(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	check := func(when string) {
		t.Helper()
		start := time.Now()
		for _, tool := range []string{"read_board", "get_view", "get_image", "apply", "delete_elements", "show_board"} {
			if text, isErr := e.relay.Call(e.token, tool, json.RawMessage(`{}`)); !isErr || text != NoClientText {
				t.Fatalf("%s, %s: %q isErr=%v", when, tool, text, isErr)
			}
		}
		if time.Since(start) > time.Second {
			t.Fatalf("%s: did not fail at once", when)
		}
	}
	check("no page")
	pages, seen := e.pages("P1")
	check("a page that only opened a stream")
	pages[0].ExpectNone(50 * time.Millisecond)
	if len(seen) != 0 {
		t.Fatal("the page was asked")
	}
	if _, held := e.relay.Bridge.HolderOf(e.board.ID); held {
		t.Fatal("a failed call left the board held")
	}
}

// list_boards is answered by the server, with no page: the boards that are not archived, by
// name then id, each with its group path, and the chat's own marked.
func TestListBoardsNeedsNoPage(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	if text, isErr := e.relay.Call(e.token, "list_boards", nil); isErr || text != "arch  ("+e.board.ID+")  [Ungrouped]  (this chat's board)" {
		t.Fatalf("one board: %q isErr=%v", text, isErr)
	}
	e.addGroups()
	mk := func(name, group string) model.Board {
		bd, err := e.relay.Boards.Create(name, group, false)
		if err != nil {
			t.Fatal(err)
		}
		return bd
	}
	zed, deep := mk("zed", "g_work"), mk("Net", "g_infra")
	twinA, twinB := mk("twin", model.Ungrouped), mk("twin", "g_infra")
	if twinA.ID > twinB.ID {
		twinA, twinB = twinB, twinA
	}
	gone := mk("gone", model.Ungrouped)
	if err := e.relay.Boards.SetArchive(gone.ID, model.Archive{Archived: true, Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	group := func(bd model.Board) string {
		switch bd.Group {
		case "g_work":
			return "Work"
		case "g_infra":
			return "Work / Infra"
		}
		return "Ungrouped"
	}
	line := func(bd model.Board) string { return bd.Name + "  (" + bd.ID + ")  [" + group(bd) + "]" }
	want := strings.Join([]string{
		line(deep), line(e.board) + "  (this chat's board)", line(twinA), line(twinB), line(zed),
	}, "\n")
	_, out := e.mcp(e.token, `{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}`)
	if text, isErr := callResult(t, out); isErr || text != want {
		t.Fatalf("got isErr=%v\n%s\nwant\n%s", isErr, text, want)
	}
	if strings.Contains(want, "on screen") {
		t.Fatal(want)
	}
	// A board named by the call changes nothing: the mark is the chat's.
	if text, _ := e.relay.Call(e.token, "list_boards", json.RawMessage(`{"board":"`+zed.ID+`"}`)); text != want {
		t.Fatalf("with a board named:\n%s", text)
	}
	// With every board archived there is none to list.
	for _, bd := range e.relay.Boards.List() {
		if err := e.relay.Boards.SetArchive(bd.ID, model.Archive{Archived: true, Op: "op2"}); err != nil {
			t.Fatal(err)
		}
	}
	if text, isErr := e.relay.Call(e.token, "list_boards", nil); isErr || text != "(no boards)" {
		t.Fatalf("no boards: %q isErr=%v", text, isErr)
	}
}

// A board made by the agent of a chat on an API client's board is that client's too: it gets
// the group and the mark of the chat's board, and names that board as its origin. The board of
// a chat on an unmarked board has neither.
func TestCreateBoardInheritsTheMark(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.addGroups()
	own, made, err := e.relay.Boards.Make(boards.NewBoard{ID: "b_remote00", Name: "theirs", Group: "g_infra", Client: "inst_A"})
	if err != nil || !made {
		t.Fatal(made, err)
	}
	if _, err := e.relay.Chats.Create(model.Claude, "", own.ID); err != nil {
		t.Fatal(err)
	}
	metas := e.relay.Chats.ChatsOfBoard(own.ID)
	if len(metas) != 1 || metas[0].Token == "" {
		t.Fatalf("board chats %+v", metas)
	}
	find := func(name string) model.Board {
		for _, bd := range e.relay.Boards.List() {
			if bd.Name == name {
				return bd
			}
		}
		t.Fatalf("no board %q", name)
		return model.Board{}
	}

	text, isErr := e.relay.Call(metas[0].Token, "create_board", json.RawMessage(`{"name":"plan"}`))
	plan := find("plan")
	if isErr || text != "created plan ("+plan.ID+") in Work / Infra" {
		t.Fatalf("got %q isErr=%v", text, isErr)
	}
	if plan.Group != "g_infra" || plan.Client != "inst_A" || plan.Origin != own.ID || !plan.New || !boards.ValidID(plan.ID) {
		t.Fatalf("board %+v", plan)
	}
	if l := e.relay.Boards.ListOf("inst_A"); len(l) != 2 {
		t.Fatalf("the client's boards %+v", l)
	}

	// The chat on an unmarked board: no mark, no origin.
	text, isErr = e.relay.Call(e.token, "create_board", json.RawMessage(`{"name":"mine"}`))
	mine := find("mine")
	if isErr || text != "created mine ("+mine.ID+") in Ungrouped" {
		t.Fatalf("got %q isErr=%v", text, isErr)
	}
	if mine.Client != "" || mine.Origin != "" || mine.Group != model.Ungrouped || !mine.New {
		t.Fatalf("board %+v", mine)
	}
}

// create_board is answered by the server, with no page: a board marked new in the group of the
// chat's board, which no client holds.
func TestCreateBoardNeedsNoPage(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	text, isErr := e.relay.Call(e.token, "create_board", json.RawMessage(`{"name":"plan"}`))
	var made model.Board
	for _, bd := range e.relay.Boards.List() {
		if bd.ID != e.board.ID {
			made = bd
		}
	}
	if isErr || made.ID == "" || text != "created plan ("+made.ID+") in Ungrouped" {
		t.Fatalf("got %q isErr=%v, board %+v", text, isErr, made)
	}
	if made.Name != "plan" || !made.New || made.Group != model.Ungrouped {
		t.Fatalf("board %+v", made)
	}
	if id, held := e.relay.Bridge.HolderOf(made.ID); held {
		t.Fatalf("the new board is held by %q", id)
	}

	// In a group: the chat's board's group, with its path in the answer.
	e.addGroups()
	if err := e.relay.Boards.Move(e.board.ID, "g_infra"); err != nil {
		t.Fatal(err)
	}
	text, isErr = e.relay.Call(e.token, "create_board", json.RawMessage(`{"name":"deep"}`))
	var deep model.Board
	for _, bd := range e.relay.Boards.List() {
		if bd.Name == "deep" {
			deep = bd
		}
	}
	if isErr || deep.Group != "g_infra" || text != "created deep ("+deep.ID+") in Work / Infra" {
		t.Fatalf("got %q isErr=%v, board %+v", text, isErr, deep)
	}
	// The page is not asked either when there is one.
	pages, seen := e.pages("P1")
	e.take("P1", e.board.ID)
	if text, isErr := e.relay.Call(e.token, "create_board", json.RawMessage(`{"name":"third"}`)); isErr || !strings.HasPrefix(text, "created third (") {
		t.Fatalf("got %q isErr=%v", text, isErr)
	}
	if text, isErr := e.relay.Call(e.token, "list_boards", nil); isErr || !strings.Contains(text, "third") {
		t.Fatalf("got %q isErr=%v", text, isErr)
	}
	if len(seen) != 0 {
		t.Fatal("the page was asked")
	}
	pages[0].Expect("board") // the board made since it connected
	pages[0].ExpectNone(50 * time.Millisecond)
}

// A board argument that is not a string names no board: the call is refused as for an unknown
// id and does not fall to the chat's own board. null is as no argument.
func TestCallRefusesABoardThatIsNotAString(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	_, seen := e.pages("P1")
	e.take("P1", e.board.ID)
	for _, tool := range []string{"read_board", "get_image", "apply", "delete_elements", "show_board"} {
		for _, v := range []string{`123`, `{"a":1}`} {
			text, isErr := e.relay.Call(e.token, tool, json.RawMessage(`{"board":`+v+`}`))
			if want := "NO_BOARD: no board with id " + v + "; call list_boards to find ids"; !isErr || text != want {
				t.Fatalf("%s on board %s: %q isErr=%v, want %q", tool, v, text, isErr, want)
			}
		}
	}
	if len(seen) != 0 {
		t.Fatal("the page was asked")
	}
	for _, args := range []string{`{"board":null}`, `{}`} {
		text, isErr := e.relay.Call(e.token, "read_board", json.RawMessage(args))
		if isErr || text != "P1:read_board" {
			t.Fatalf("read_board %s: %q isErr=%v", args, text, isErr)
		}
		if got := asked(t, seen, "P1"); got["target"] != e.board.ID {
			t.Fatalf("read_board %s was about %v, want the chat's board %s", args, got["target"], e.board.ID)
		}
	}
}

// The server checks the board a call is about and answers in the page's words; no page is asked.
func TestCallChecksItsTargetBoard(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	old := e.newBoard("old")
	if err := e.relay.Boards.SetArchive(old.ID, model.Archive{Archived: true, Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	_, seen := e.pages("P1")
	e.take("P1", e.board.ID)
	for _, tool := range []string{"read_board", "get_image", "apply", "delete_elements", "show_board"} {
		text, isErr := e.relay.Call(e.token, tool, json.RawMessage(`{"board":"b_nope"}`))
		if !isErr || text != "NO_BOARD: no board with id b_nope; call list_boards to find ids" {
			t.Fatalf("%s on an unknown board: %q isErr=%v", tool, text, isErr)
		}
		text, isErr = e.relay.Call(e.token, tool, json.RawMessage(`{"board":"`+old.ID+`"}`))
		if !isErr || text != "ARCHIVED: old is archived" {
			t.Fatalf("%s on an archived board: %q isErr=%v", tool, text, isErr)
		}
	}
	if _, held := e.relay.Bridge.HolderOf(old.ID); held {
		t.Fatal("a refused call gave the archived board to a page")
	}
	// The chat's own board is gone: the calls that are about it, named or not, and create_board.
	if err := e.relay.Boards.Delete(e.board.ID); err != nil {
		t.Fatal(err)
	}
	want := "NO_BOARD: this chat's board " + e.board.ID + " no longer exists"
	for _, tool := range []string{"read_board", "get_image", "apply", "delete_elements", "show_board", "create_board"} {
		for _, args := range []string{`{"name":"x"}`, `{"name":"x","board":"` + e.board.ID + `"}`} {
			if text, isErr := e.relay.Call(e.token, tool, json.RawMessage(args)); !isErr || text != want {
				t.Fatalf("%s %s with the chat's board gone: %q isErr=%v", tool, args, text, isErr)
			}
		}
	}
	if len(seen) != 0 {
		t.Fatal("the page was asked")
	}
}

// get_view and show_board are about a screen: they go to the holder of the chat's board, also
// when show_board names a board another page holds, and they move no board.
func TestScreenCallsGoToTheHolderOfTheChatsBoard(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	other, free := e.newBoard("other"), e.newBoard("free")
	pages, seen := e.pages("P1", "P2")
	e.take("P1", e.board.ID)
	e.take("P2", other.ID) // P2 acted last

	if text, isErr := e.relay.Call(e.token, "get_view", nil); isErr || text != "P1:get_view" {
		t.Fatalf("get_view: %q isErr=%v", text, isErr)
	}
	if p := asked(t, seen, "P1"); len(p) != 5 || p["board"] != e.board.ID || p["name"] != "get_view" {
		t.Fatalf("get_view: rpc params %v", p)
	}
	for _, target := range []string{e.board.ID, other.ID, free.ID} {
		text, isErr := e.relay.Call(e.token, "show_board", json.RawMessage(`{"board":"`+target+`"}`))
		if isErr || text != "P1:show_board" {
			t.Fatalf("show_board %s: %q isErr=%v", target, text, isErr)
		}
		if p := asked(t, seen, "P1"); p["board"] != e.board.ID || p["target"] != target || p["name"] != "show_board" {
			t.Fatalf("show_board %s: rpc params %v", target, p)
		}
	}
	if id, _ := e.relay.Bridge.HolderOf(other.ID); id != "P2" {
		t.Fatalf("the other board's holder is %q", id)
	}
	if id, held := e.relay.Bridge.HolderOf(free.ID); held {
		t.Fatalf("show_board gave the free board to %q", id)
	}
	for _, p := range pages {
		p.ExpectNone(50 * time.Millisecond)
	}
	// Nobody holds the chat's board: the page that acted last is asked.
	if got := e.relay.Bridge.ReleaseBoard("P1", e.board.ID); got != "free" {
		t.Fatalf("release: %q", got)
	}
	e.relay.Bridge.Acted("P2")
	if text, isErr := e.relay.Call(e.token, "get_view", nil); isErr || text != "P2:get_view" {
		t.Fatalf("get_view with the chat's board free: %q isErr=%v", text, isErr)
	}
	asked(t, seen, "P2")
}
