package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// The known-client guard, the hold of a board and the scene revision, with stand-in pages
// (bridgetest) against the real handler. The env's own client "A" is connected in every test and
// makes no call unless the test says so.

// page connects a stand-in page with this id and reads its hello and snapshot: it is a known
// client from then on, and Do makes its calls with the client header.
func (e *env) page(id string) *bridgetest.Page {
	e.t.Helper()
	p := bridgetest.Connect(e.t, e.url, id)
	p.Welcome()
	return p
}

// answer checks the status of a page's call and returns the decoded body.
func answer(t *testing.T, want int, status int, body []byte) map[string]any {
	t.Helper()
	if status != want {
		t.Fatalf("status %d, want %d (%s)", status, want, body)
	}
	return decode[map[string]any](t, string(body))
}

// refused checks that a call was refused with 409 and this "error" or, when it has one, "code".
func refused(t *testing.T, what, want string, status int, body []byte) map[string]any {
	t.Helper()
	out := map[string]any{}
	json.Unmarshal(body, &out)
	got := out["code"]
	if got == nil {
		got = out["error"]
	}
	if status != 409 || got != want {
		t.Fatalf("%s: %d %s, want 409 %s", what, status, body, want)
	}
	return out
}

// newBoard makes a board as the page, which then holds it.
func newBoard(t *testing.T, p *bridgetest.Page, name string) model.Board {
	t.Helper()
	status, out := p.Do("POST", "/api/boards", map[string]any{"name": name, "group": model.Ungrouped})
	if status != 200 {
		t.Fatalf("new board %s: %d %s", name, status, out)
	}
	return decode[model.Board](t, string(out))
}

// drawing is a scene with one element, to tell one write from another.
func drawing(element string) string {
	return `{"type":"excalidraw","version":2,"elements":[{"id":"` + element + `","type":"rectangle"}],"appState":{},"files":{}}`
}

// write is the page's scene write based on the revision base.
func write(p *bridgetest.Page, board string, base int64, scene string) (int, []byte) {
	return p.Do("PUT", "/api/boards/"+board+"/scene?rev="+strconv.FormatInt(base, 10), scene)
}

// written checks that the page's write on base was accepted and stored as revision base+1.
func written(t *testing.T, p *bridgetest.Page, board string, base int64, scene string) {
	t.Helper()
	status, out := write(p, board, base, scene)
	if got := answer(t, 200, status, out); got["ok"] != true || got["rev"] != float64(base+1) {
		t.Fatalf("write on revision %d: %s", base, out)
	}
}

// take is the page's take of the board; it returns the answer's state and revision.
func take(t *testing.T, p *bridgetest.Page, board string, ifFree bool) (state string, rev int64) {
	t.Helper()
	status, out := p.Do("POST", "/api/boards/"+board+"/take", map[string]any{"ifFree": ifFree})
	got := answer(t, 200, status, out)
	state, _ = got["state"].(string)
	n, hasRev := got["rev"].(float64)
	if hasRev != (state == "held") {
		t.Fatalf("take: %s: a revision goes with held only", out)
	}
	return state, int64(n)
}

// release is the page's release of the board; it returns the answer's state.
func release(t *testing.T, p *bridgetest.Page, board string) string {
	t.Helper()
	status, out := p.Do("POST", "/api/boards/"+board+"/release", nil)
	state, _ := answer(t, 200, status, out)["state"].(string)
	return state
}

// until reads the page's events up to the next one of this type about this board, and returns it.
func until(t *testing.T, p *bridgetest.Page, typ, board string) map[string]any {
	t.Helper()
	for {
		if ev := p.Next(); ev["type"] == typ && ev["board"] == board {
			return ev
		}
	}
}

var marks int

// roleEvents returns the events about a role ("<type> <board>") that the page was sent and has
// not read yet. It makes a group, which every page is told of, and reads up to that event.
func (e *env) roleEvents(p *bridgetest.Page) (got []string) {
	e.t.Helper()
	marks++
	g, err := e.a.CreateGroup("mark "+strconv.Itoa(marks), "")
	if err != nil {
		e.t.Fatal(err)
	}
	for {
		raw := p.NextRaw()
		var ev struct{ Type, Board string }
		json.Unmarshal([]byte(raw), &ev)
		switch ev.Type {
		case "groups":
			if strings.Contains(raw, g.ID) {
				return got
			}
		case "release_request", "superseded", "held", "rpc", "server_stopping":
			got = append(got, strings.TrimSpace(ev.Type+" "+ev.Board))
		}
	}
}

// holder checks who holds the board; "" for nobody.
func (e *env) holder(board, want string) {
	e.t.Helper()
	if got, _ := e.s.Bridge.HolderOf(board); got != want {
		e.t.Fatalf("the holder of %s is %q, want %q", board, got, want)
	}
}

// onDisk checks the board's drawing file.
func (e *env) onDisk(board, want string) {
	e.t.Helper()
	got, err := os.ReadFile(e.st.P.BoardFile(board))
	if err != nil || string(got) != want {
		e.t.Fatalf("the drawing on disk is %s (%v), want %s", got, err, want)
	}
}

// stored checks what a read of the board's scene answers: the drawing and its revision.
func (e *env) stored(board, want string, rev int64) {
	e.t.Helper()
	resp, err := http.Get(e.url + "/api/boards/" + board + "/scene")
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	got, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(got) != want || resp.Header.Get(SceneRevHeader) != strconv.FormatInt(rev, 10) {
		e.t.Fatalf("scene read: %d, revision %q, %s; want revision %d, %s", resp.StatusCode, resp.Header.Get(SceneRevHeader), got, rev, want)
	}
}

// gone waits until the server has noticed the end of the client's stream.
func (e *env) gone(id string) {
	e.t.Helper()
	for end := time.Now().Add(5 * time.Second); e.s.Bridge.Known(id); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(end) {
			e.t.Fatalf("client %s is still known", id)
		}
	}
}

// foreign makes a call as a page of another origin can without a preflight: no client header,
// and a body sent as text/plain.
func (e *env) foreign(method, path, body string, headers ...string) (int, string, http.Header) {
	e.t.Helper()
	req, _ := http.NewRequest(method, e.url+path, strings.NewReader(body))
	req.Header.Set("Origin", "http://evil.example")
	if body != "" {
		req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(out), resp.Header
}

// later sends the request as clientID on a goroutine of its own; its status arrives on the
// channel, 0 when it could not be sent.
func (e *env) later(method, path string) <-chan int {
	done := make(chan int, 1)
	go func() {
		req, _ := http.NewRequest(method, e.url+path, nil)
		req.Header.Set(ClientHeader, clientID)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			done <- 0
			return
		}
		resp.Body.Close()
		done <- resp.StatusCode
	}()
	return done
}

// tool is a board tool call of the agent whose chat has this token, as the MCP listener gets it.
// It makes no test call, so it may run on a goroutine of its own.
func (e *env) tool(token, name string) (text string, isErr bool) {
	req := httptest.NewRequest("POST", "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"`+name+`","arguments":{}}}`))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	e.s.Relay.ServeFixedMCP(w, req)
	var out struct {
		Result struct {
			Content []struct{ Text string }
			IsError bool
		}
	}
	if json.Unmarshal(w.Body.Bytes(), &out) != nil || len(out.Result.Content) != 1 {
		return "bad answer: " + w.Body.String(), true
	}
	return out.Result.Content[0].Text, out.Result.IsError
}

// boardChat makes a board and a chat on it as the page, and returns the chat's token.
func (e *env) boardChat(p *bridgetest.Page) (model.Board, string) {
	e.t.Helper()
	bd := newBoard(e.t, p, "b")
	if status, out := p.Do("POST", "/api/chats", map[string]any{"agent": "claude", "board": bd.ID}); status != 200 {
		e.t.Fatalf("new chat: %d %s", status, out)
	}
	metas := e.a.Chats.ChatsOfBoard(bd.ID)
	if len(metas) != 1 || metas[0].Token == "" {
		e.t.Fatalf("board chats %+v", metas)
	}
	return bd, metas[0].Token
}

// ---- the guard (AC38) -------------------------------------------------------

func TestKnownClientGuard(t *testing.T) {
	e := newEnv(t)
	p := e.page("P")
	bd := newBoard(t, p, "b")
	c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	e.holder(bd.ID, "P")

	// No id, the id of no stream, and a known id in the body only: every route refuses, the
	// ones about the client itself too.
	body := `{"client":"P","id":"rpc_1","ifFree":true,"name":"x","group":"` + model.Ungrouped + `"}`
	routes := [][2]string{
		{"POST", "/api/rpc-reply"},
		{"POST", "/api/client/flushed"},
		{"POST", "/api/boards/" + bd.ID + "/take"},
		{"POST", "/api/boards/" + bd.ID + "/release"},
		{"POST", "/api/chats/" + c.ID + "/unfollow"},
		{"POST", "/api/runs/r_x/unfollow"},
		{"PUT", "/api/boards/" + bd.ID + "/scene?rev=0"},
		{"PUT", "/api/boards/" + bd.ID + "/scene"},
		{"POST", "/api/boards"},
		{"DELETE", "/api/boards/" + bd.ID},
		{"POST", "/api/restart"},
	}
	for _, r := range routes {
		for _, client := range []string{"", "ghost"} {
			code, out := e.doAs(client, r[0], r[1], body)
			if code != 409 || strings.TrimSpace(out) != `{"error":"unknown_client"}` {
				t.Fatalf("%s %s from %q: %d %s", r[0], r[1], client, code, out)
			}
		}
		// The id as a query parameter is not the header either.
		if code, out := e.doAs("", r[0], r[1]+map[bool]string{true: "&", false: "?"}[strings.Contains(r[1], "?")]+"client=P", body); code != 409 {
			t.Fatalf("%s %s with the id in the query: %d %s", r[0], r[1], code, out)
		}
	}
	e.holder(bd.ID, "P")
	if n := len(e.a.Boards.List()); n != 1 {
		t.Fatalf("%d boards after the refused calls", n)
	}
	e.onDisk(bd.ID, string(mustRead(t, e.st.P.BoardFile(bd.ID))))
	if got := e.roleEvents(p); len(got) != 0 {
		t.Fatalf("the holder was sent %v", got)
	}

	// A GET and a HEAD need no id.
	for _, r := range [][2]string{{"GET", "/api/state"}, {"HEAD", "/api/state"}, {"GET", "/api/boards/" + bd.ID + "/scene"}, {"GET", "/api/chats/" + c.ID + "/items"}} {
		if code, out := e.doAs("", r[0], r[1], ""); code != 200 {
			t.Fatalf("%s %s without an id: %d %s", r[0], r[1], code, out)
		}
	}

	// A second stream with a connected id replaces the first: the new one holds and follows
	// nothing.
	p.Do("GET", "/api/chats/"+c.ID+"/items", nil)
	if got := e.s.Bridge.Followers(editorbridge.Chat(c.ID)); !slices.Equal(got, []string{"P"}) {
		t.Fatalf("followers before the second stream: %v", got)
	}
	again := e.page("P")
	p.ExpectEnded()
	e.holder(bd.ID, "")
	if got := e.s.Bridge.Followers(editorbridge.Chat(c.ID)); len(got) != 0 {
		t.Fatalf("followers after the second stream: %v", got)
	}
	status, out := write(again, bd.ID, 0, drawing("late"))
	refused(t, "a write by the new stream, which holds nothing", "not_holder", status, out)
	if state, _ := take(t, again, bd.ID, true); state != "held" {
		t.Fatalf("the new stream's take of the free board: %s", state)
	}
	written(t, again, bd.ID, 0, drawing("again"))
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// What a page of another origin can do (T09 Part A): open a stream, and post without the client
// header. It takes no board, forges no answer, and is asked nothing.
func TestForeignPageGetsNothing(t *testing.T) {
	e := newEnv(t)
	v := e.page("V")
	bd, token := e.boardChat(v)
	written(t, v, bd.ID, 0, drawing("v"))

	// Its stream alone leaves the holder undisturbed.
	x := e.page("X")
	e.holder(bd.ID, "V")
	if got := e.roleEvents(v); len(got) != 0 {
		t.Fatalf("the holder was sent %v when another stream opened", got)
	}

	// An agent's call is open at the holder. A reply that names the holder in its body, sent as
	// text/plain, is refused, and the call stays open.
	type result struct {
		text  string
		isErr bool
	}
	called := make(chan result, 1)
	go func() {
		text, isErr := e.tool(token, "read_board")
		called <- result{text, isErr}
	}()
	var rpc map[string]any
	for rpc == nil {
		if ev := v.Next(); ev["type"] == "rpc" {
			rpc = ev
		}
	}
	id, _ := rpc["id"].(string)
	forged, _ := json.Marshal(map[string]any{"id": id, "client": "V", "result": "forged"})
	if code, out, _ := e.foreign("POST", "/api/rpc-reply", string(forged)); code != 409 || !strings.Contains(out, "unknown_client") {
		t.Fatalf("a forged reply: %d %s", code, out)
	}
	select {
	case r := <-called:
		t.Fatalf("the call ended with the forged reply: %+v", r)
	case <-time.After(100 * time.Millisecond):
	}

	// Neither can it take or release the board, or answer server_stopping for the holder.
	for _, path := range []string{"/api/boards/" + bd.ID + "/take", "/api/boards/" + bd.ID + "/release", "/api/client/flushed"} {
		for _, body := range []string{`{"client":"V"}`, ""} {
			if code, out, _ := e.foreign("POST", path, body); code != 409 || !strings.Contains(out, "unknown_client") {
				t.Fatalf("POST %s with body %q: %d %s", path, body, code, out)
			}
		}
	}
	e.holder(bd.ID, "V")

	// The preflight of a call with the client header is not answered, and no answer allows the
	// other origin to read it.
	code, _, h := e.foreign("OPTIONS", "/api/boards", "", "Access-Control-Request-Method", "POST", "Access-Control-Request-Headers", "x-aiwb-client,content-type")
	if code != 409 || h.Get("Access-Control-Allow-Origin") != "" || h.Get("Access-Control-Allow-Headers") != "" {
		t.Fatalf("OPTIONS /api/boards: %d %v", code, h)
	}
	for _, path := range []string{"/api/state", "/api/boards/" + bd.ID + "/scene", "/api/hello"} {
		if _, _, h := e.foreign("GET", path, ""); h.Get("Access-Control-Allow-Origin") != "" {
			t.Fatalf("GET %s allows origin %q", path, h.Get("Access-Control-Allow-Origin"))
		}
	}

	// The holder's own answer ends the call.
	if status, out := v.Do("POST", "/api/rpc-reply", map[string]any{"id": id, "result": "the board"}); status != 200 {
		t.Fatalf("the holder's reply: %d %s", status, out)
	}
	select {
	case r := <-called:
		if r.isErr || r.text != "the board" {
			t.Fatalf("the call's answer: %+v", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the call did not end with the holder's reply")
	}
	if got := e.roleEvents(v); len(got) != 0 {
		t.Fatalf("the holder was sent %v", got)
	}

	// With only clients that opened a stream and made no call (X, and the env's A), an agent's
	// call is refused at once: none of them is given the board or the call.
	v.Close()
	e.gone("V")
	e.holder(bd.ID, "")
	start := time.Now()
	if text, isErr := e.tool(token, "read_board"); !isErr || text != boardapi.NoClientText || time.Since(start) > time.Second {
		t.Fatalf("a call with stream-only clients: %q isErr=%v after %v", text, isErr, time.Since(start))
	}
	e.holder(bd.ID, "")
	if got := e.roleEvents(x); len(got) != 0 {
		t.Fatalf("the stream-only client was sent %v", got)
	}
	e.onDisk(bd.ID, drawing("v"))
}

// A reply counts only from the client that was asked, another known client's is refused.
func TestReplyOnlyFromTheClientAsked(t *testing.T) {
	e := newEnv(t)
	p, q := e.page("P"), e.page("Q")
	bd, token := e.boardChat(p)
	newBoard(t, q, "other")
	called := make(chan string, 1)
	go func() {
		text, _ := e.tool(token, "read_board")
		called <- text
	}()
	var id string
	for id == "" {
		if ev := p.Next(); ev["type"] == "rpc" {
			id, _ = ev["id"].(string)
		}
	}
	status, out := q.Do("POST", "/api/rpc-reply", map[string]any{"id": id, "result": "from Q"})
	if status != 409 || strings.TrimSpace(string(out)) != `{"error":"not_asked"}` {
		t.Fatalf("a reply from another client: %d %s", status, out)
	}
	if status, out := p.Do("POST", "/api/rpc-reply", map[string]any{"id": id, "result": "from P"}); status != 200 {
		t.Fatalf("the reply of the client asked: %d %s", status, out)
	}
	select {
	case text := <-called:
		if text != "from P" {
			t.Fatalf("the call's answer: %q", text)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the call did not end")
	}
	// A second reply to the same call, and a reply to no call.
	for _, rpcID := range []string{id, "rpc_none"} {
		if status, out := p.Do("POST", "/api/rpc-reply", map[string]any{"id": rpcID, "result": "late"}); status != 409 || !strings.Contains(string(out), "not_asked") {
			t.Fatalf("a late reply to %s: %d %s", rpcID, status, out)
		}
	}
	if got := e.roleEvents(q); len(got) != 0 {
		t.Fatalf("the other client was sent %v", got)
	}
	e.holder(bd.ID, "P")
}

// ---- the hold of a board (AC39) ---------------------------------------------

func TestTwoPagesSaveTwoBoards(t *testing.T) {
	e := newEnv(t)
	p, q := e.page("P"), e.page("Q")
	bp, bq := newBoard(t, p, "p"), newBoard(t, q, "q")
	// The client that creates a board holds it.
	e.holder(bp.ID, "P")
	e.holder(bq.ID, "Q")
	for i := int64(0); i < 3; i++ {
		written(t, p, bp.ID, i, drawing("p"+strconv.FormatInt(i, 10)))
		written(t, q, bq.ID, i, drawing("q"+strconv.FormatInt(i, 10)))
	}
	e.onDisk(bp.ID, drawing("p2"))
	e.onDisk(bq.ID, drawing("q2"))
	e.stored(bp.ID, drawing("p2"), 3)
	e.stored(bq.ID, drawing("q2"), 3)
	for _, pg := range []*bridgetest.Page{p, q} {
		if got := e.roleEvents(pg); len(got) != 0 {
			t.Fatalf("page %s was sent %v", pg.ID, got)
		}
	}

	// Neither writes the other's board, with or without a revision.
	status, out := write(q, bp.ID, 3, drawing("q on p"))
	if got := refused(t, "a write by a non-holder", "not_holder", status, out); got["error"] != "another window holds this board" {
		t.Fatalf("the refusal's text: %s", out)
	}
	status, out = q.Do("PUT", "/api/boards/"+bp.ID+"/scene", drawing("q on p"))
	refused(t, "a write without a revision by a non-holder", "not_holder", status, out)
	e.stored(bp.ID, drawing("p2"), 3)
}

func TestTakeAndReleaseRoutes(t *testing.T) {
	e := newEnv(t)
	p, q := e.page("P"), e.page("Q")
	bd := newBoard(t, p, "b")
	written(t, p, bd.ID, 0, drawing("one"))

	// The holder's own take, with and without ifFree, and with no body at all.
	for _, ifFree := range []bool{false, true} {
		if state, rev := take(t, p, bd.ID, ifFree); state != "held" || rev != 1 {
			t.Fatalf("the holder's take: %s at %d", state, rev)
		}
	}
	status, out := p.Do("POST", "/api/boards/"+bd.ID+"/take", nil)
	if got := answer(t, 200, status, out); got["state"] != "held" || got["rev"] != float64(1) {
		t.Fatalf("a take without a body: %s", out)
	}
	// Take if free of a held board: busy, and nobody is told.
	if state, _ := take(t, q, bd.ID, true); state != "busy" {
		t.Fatalf("take if free of a held board: %s", state)
	}
	e.holder(bd.ID, "P")
	for _, pg := range []*bridgetest.Page{p, q} {
		if got := e.roleEvents(pg); len(got) != 0 {
			t.Fatalf("page %s was sent %v", pg.ID, got)
		}
	}

	// Release: by a client that does not hold it, by the holder, and again.
	if state := release(t, q, bd.ID); state != "none" {
		t.Fatalf("a release by a non-holder: %s", state)
	}
	e.holder(bd.ID, "P")
	if state := release(t, p, bd.ID); state != "free" {
		t.Fatalf("the holder's release: %s", state)
	}
	if state := release(t, p, bd.ID); state != "none" {
		t.Fatalf("a second release: %s", state)
	}
	e.holder(bd.ID, "")
	// A free board is written by nobody (but see the write without a revision), and taken by
	// whoever asks.
	status, out = write(p, bd.ID, 1, drawing("free"))
	if got := refused(t, "a write of a free board", "not_holder", status, out); got["error"] != "this window does not hold the board" {
		t.Fatalf("the refusal's text: %s", out)
	}
	if state, rev := take(t, q, bd.ID, true); state != "held" || rev != 1 {
		t.Fatalf("take if free of a free board: %s at %d", state, rev)
	}
	written(t, q, bd.ID, 1, drawing("two"))

	// An unknown board and an archived one are not taken.
	if status, out := p.Do("POST", "/api/boards/b_nope/take", nil); status != 404 {
		t.Fatalf("take of an unknown board: %d %s", status, out)
	}
	if state := release(t, p, "b_nope"); state != "none" {
		t.Fatalf("release of an unknown board: %s", state)
	}
	if state := release(t, q, bd.ID); state != "free" {
		t.Fatalf("the release before the archive: %s", state)
	}
	if status, out := p.Do("POST", "/api/boards/"+bd.ID+"/archive", nil); status != 200 {
		t.Fatalf("archive: %d %s", status, out)
	}
	status, out = p.Do("POST", "/api/boards/"+bd.ID+"/take", nil)
	if status != 409 || strings.TrimSpace(string(out)) != `{"error":"the board is archived"}` {
		t.Fatalf("take of an archived board: %d %s", status, out)
	}
	e.holder(bd.ID, "")
	if status, out := p.Do("POST", "/api/boards/"+bd.ID+"/take", "not json"); status != 400 {
		t.Fatalf("take with a bad body: %d %s", status, out)
	}
}

// A take of a held board puts the holder's pending write on disk before the grant: the revision
// the new holder is given is the one after that write.
func TestTakeOfAHeldBoard(t *testing.T) {
	e := newEnv(t)
	p, q := e.page("P"), e.page("Q")
	bd := newBoard(t, p, "b")
	other := newBoard(t, p, "other")
	written(t, p, bd.ID, 0, drawing("saved"))

	if state, _ := take(t, q, bd.ID, false); state != "waiting" {
		t.Fatalf("the take of a held board: %s", state)
	}
	until(t, p, "release_request", bd.ID)
	e.holder(bd.ID, "P")
	// The holder writes what it had pending, then releases.
	written(t, p, bd.ID, 1, drawing("pending"))
	if state := release(t, p, bd.ID); state != "handed" {
		t.Fatalf("the holder's release: %s", state)
	}
	until(t, p, "superseded", bd.ID)
	if ev := until(t, q, "held", bd.ID); ev["rev"] != float64(2) {
		t.Fatalf("the grant: %v, want revision 2", ev)
	}
	e.holder(bd.ID, "Q")
	e.stored(bd.ID, drawing("pending"), 2)
	e.onDisk(bd.ID, drawing("pending"))

	// The old holder lost that board only: it writes its other board, and not this one.
	status, out := write(p, bd.ID, 2, drawing("too late"))
	refused(t, "a write by the old holder", "not_holder", status, out)
	written(t, p, other.ID, 0, drawing("other"))
	e.holder(other.ID, "P")
	written(t, q, bd.ID, 2, drawing("by q"))
	if got := append(e.roleEvents(p), e.roleEvents(q)...); len(got) != 0 {
		t.Fatalf("more events about a role: %v", got)
	}

	// "Use here" in the old holder: a take again, and the scene as stored.
	if state, _ := take(t, p, bd.ID, false); state != "waiting" {
		t.Fatalf("the take back: %s", state)
	}
	until(t, q, "release_request", bd.ID)
	if state := release(t, q, bd.ID); state != "handed" {
		t.Fatalf("the release for the take back: %s", state)
	}
	if ev := until(t, p, "held", bd.ID); ev["rev"] != float64(3) {
		t.Fatalf("the grant back: %v, want revision 3", ev)
	}
	e.stored(bd.ID, drawing("by q"), 3)
}

// ---- the scene revision (AC42) ----------------------------------------------

func TestStaleSceneWrite(t *testing.T) {
	e := newEnv(t)
	p := e.page("P")
	bd := newBoard(t, p, "b")
	e.stored(bd.ID, string(mustRead(t, e.st.P.BoardFile(bd.ID))), 0)
	written(t, p, bd.ID, 0, drawing("one"))
	written(t, p, bd.ID, 1, drawing("two"))

	for _, base := range []int64{0, 1, 3, 99} {
		status, out := write(p, bd.ID, base, drawing("stale"))
		got := refused(t, "a write on revision "+strconv.FormatInt(base, 10), "stale", status, out)
		if got["error"] != "the board was changed elsewhere" || got["rev"] != float64(2) {
			t.Fatalf("the refusal: %s", out)
		}
	}
	e.stored(bd.ID, drawing("two"), 2)
	e.onDisk(bd.ID, drawing("two"))
	for _, rev := range []string{"", "x", "-1", "1.5"} {
		if status, out := p.Do("PUT", "/api/boards/"+bd.ID+"/scene?rev="+rev, drawing("bad")); status != 400 || !strings.Contains(string(out), "rev is not a number") {
			t.Fatalf("rev=%q: %d %s", rev, status, out)
		}
	}
	if status, out := write(p, bd.ID, 2, "not json"); status != 400 {
		t.Fatalf("a drawing that is not JSON: %d %s", status, out)
	}
	e.stored(bd.ID, drawing("two"), 2)

	// A write names its revision: one without is refused, by the holder and of any board.
	for _, id := range []string{bd.ID, "b_nope"} {
		if status, out := p.Do("PUT", "/api/boards/"+id+"/scene", drawing("three")); status != 400 || !strings.Contains(string(out), "rev is missing") {
			t.Fatalf("a write of %s without a revision: %d %s", id, status, out)
		}
	}
	e.stored(bd.ID, drawing("two"), 2)
	e.onDisk(bd.ID, drawing("two"))

	// An unknown board.
	if status, out := p.Do("PUT", "/api/boards/b_nope/scene?rev=0", drawing("x")); status != 404 {
		t.Fatalf("a write of an unknown board: %d %s", status, out)
	}
	if code, _ := e.doAs("", "GET", "/api/boards/b_nope/scene", ""); code != 404 {
		t.Fatalf("a read of an unknown board: %d", code)
	}
}

// T11 X1: a page that had a board, lost it to another page that changed it, and takes it back,
// does not put its older scene over the newer one.
func TestReturningPageDoesNotOverwrite(t *testing.T) {
	e := newEnv(t)
	p, q := e.page("P"), e.page("Q")
	bd := newBoard(t, p, "b")
	written(t, p, bd.ID, 0, drawing("old")) // P's cache: "old" at revision 1

	if state, _ := take(t, q, bd.ID, false); state != "waiting" {
		t.Fatalf("Q's take: %s", state)
	}
	until(t, p, "release_request", bd.ID)
	if state := release(t, p, bd.ID); state != "handed" {
		t.Fatalf("P's release: %s", state)
	}
	if ev := until(t, q, "held", bd.ID); ev["rev"] != float64(1) {
		t.Fatalf("Q's grant: %v", ev)
	}
	written(t, q, bd.ID, 1, drawing("newer"))

	// P comes back to the board. The grant names revision 2, which is not its cache's.
	if state, _ := take(t, p, bd.ID, false); state != "waiting" {
		t.Fatalf("P's take back: %s", state)
	}
	until(t, q, "release_request", bd.ID)
	if state := release(t, q, bd.ID); state != "handed" {
		t.Fatalf("Q's release: %s", state)
	}
	if ev := until(t, p, "held", bd.ID); ev["rev"] != float64(2) {
		t.Fatalf("P's grant: %v, want revision 2", ev)
	}
	// Its cached scene, written anyway, is refused.
	status, out := write(p, bd.ID, 1, drawing("old"))
	if got := refused(t, "the write of the older scene", "stale", status, out); got["rev"] != float64(2) {
		t.Fatalf("the refusal: %s", out)
	}
	e.onDisk(bd.ID, drawing("newer"))
	e.stored(bd.ID, drawing("newer"), 2)
}

// T11 X3 (b): a holder that could not write its pending edit within the handover delay loses
// the board, and the edit is written neither late nor after it took the board back.
func TestLateWriteOfTheOldHolderIsRefused(t *testing.T) {
	e := newEnv(t)
	p, q := e.page("P"), e.page("Q")
	bd := newBoard(t, p, "b")
	written(t, p, bd.ID, 0, drawing("saved")) // P then edits: "pending", based on revision 1

	start := time.Now()
	if state, _ := take(t, q, bd.ID, false); state != "waiting" {
		t.Fatalf("Q's take: %s", state)
	}
	until(t, p, "release_request", bd.ID)
	// P's write is held up for longer than the delay: Q gets the board without it.
	if ev := until(t, q, "held", bd.ID); ev["rev"] != float64(1) {
		t.Fatalf("Q's grant: %v", ev)
	}
	if waited := time.Since(start); waited < 2500*time.Millisecond {
		t.Fatalf("the grant came after %v, before the holder's time was over", waited)
	}
	until(t, p, "superseded", bd.ID)
	written(t, q, bd.ID, 1, drawing("newer"))

	// The write arrives late.
	status, out := write(p, bd.ID, 1, drawing("pending"))
	refused(t, "the late write", "not_holder", status, out)
	if state := release(t, p, bd.ID); state != "none" {
		t.Fatalf("the late release: %s", state)
	}
	e.holder(bd.ID, "Q")
	e.onDisk(bd.ID, drawing("newer"))

	// P takes the board back and tries again.
	if state, _ := take(t, p, bd.ID, false); state != "waiting" {
		t.Fatalf("P's take back: %s", state)
	}
	until(t, q, "release_request", bd.ID)
	if state := release(t, q, bd.ID); state != "handed" {
		t.Fatalf("Q's release: %s", state)
	}
	if ev := until(t, p, "held", bd.ID); ev["rev"] != float64(2) {
		t.Fatalf("P's grant: %v, want revision 2", ev)
	}
	status, out = write(p, bd.ID, 1, drawing("pending"))
	refused(t, "the write of the edit that was not written in time", "stale", status, out)
	e.onDisk(bd.ID, drawing("newer"))
	e.stored(bd.ID, drawing("newer"), 2)
}

// T35 F3: the holder's stream ends while its write is on the way. The grant of the waiting page
// can fall between the write's holder check and its store, and then names the revision before
// the write; the page is told the stored revision with a second held.
func TestGrantDuringTheOldHoldersWrite(t *testing.T) {
	e := newEnv(t)
	late := 0
	for i := range 300 {
		n := strconv.Itoa(i)
		h, q := e.page("H"+n), e.page("Q"+n)
		bd := newBoard(t, h, "b"+n)
		if state, _ := take(t, q, bd.ID, false); state != "waiting" {
			t.Fatalf("round %d: Q's take: %s", i, state)
		}
		var status int
		done := make(chan struct{}, 2)
		go func() { status, _ = write(h, bd.ID, 0, drawing("h")); done <- struct{}{} }()
		go func() {
			time.Sleep(time.Duration(i%8) * 50 * time.Microsecond)
			h.Close()
			done <- struct{}{}
		}()
		granted := until(t, q, "held", bd.ID)["rev"].(float64)
		<-done
		<-done
		stored := e.a.Boards.Rev(bd.ID)
		if (status == 200) != (stored == 1) {
			t.Fatalf("round %d: H's write answered %d, the stored revision is %d", i, status, stored)
		}
		if granted != float64(stored) {
			late++
			if ev := until(t, q, "held", bd.ID); ev["rev"] != float64(stored) {
				t.Fatalf("round %d: Q's second held: %v, the stored revision is %d", i, ev, stored)
			}
		}
		e.holder(bd.ID, "Q"+n)
		written(t, q, bd.ID, stored, drawing("q"))
		q.Close()
	}
	t.Logf("the grant named the revision before the write in %d of 300 rounds", late)
}

// T11 X5: a page whose stream was cut comes back while another page works on its board. It
// takes nothing back unasked, and its older scene is not written.
func TestReconnectDoesNotOverwrite(t *testing.T) {
	e := newEnv(t)
	p, q := e.page("P"), e.page("Q")
	bd := newBoard(t, p, "b")
	written(t, p, bd.ID, 0, drawing("old")) // P then edits: "pending", based on revision 1

	p.Close()
	e.gone("P")
	e.holder(bd.ID, "")
	if state, rev := take(t, q, bd.ID, true); state != "held" || rev != 1 {
		t.Fatalf("Q's take of the board that P's cut freed: %s at %d", state, rev)
	}
	written(t, q, bd.ID, 1, drawing("newer"))

	// P's stream returns. It holds nothing, and its take if free leaves the board with Q.
	p = e.page("P")
	e.holder(bd.ID, "Q")
	status, out := write(p, bd.ID, 1, drawing("pending"))
	refused(t, "a write right after the reconnect", "not_holder", status, out)
	if state, _ := take(t, p, bd.ID, true); state != "busy" {
		t.Fatalf("P's take if free: %s", state)
	}
	status, out = write(p, bd.ID, 1, drawing("pending"))
	refused(t, "a write after the take was answered busy", "not_holder", status, out)
	if got := e.roleEvents(q); len(got) != 0 {
		t.Fatalf("Q was sent %v", got)
	}
	e.onDisk(bd.ID, drawing("newer"))

	// Q goes away. P's take if free is now granted, at another revision than its cache's.
	q.Close()
	e.gone("Q")
	if state, rev := take(t, p, bd.ID, true); state != "held" || rev != 2 {
		t.Fatalf("P's take of the free board: %s at %d", state, rev)
	}
	status, out = write(p, bd.ID, 1, drawing("pending"))
	refused(t, "the write of the edit made before the cut", "stale", status, out)
	e.onDisk(bd.ID, drawing("newer"))
	e.stored(bd.ID, drawing("newer"), 2)

	// At the same revision the pending edit is written: a cut with nobody else on the board.
	p.Close()
	e.gone("P")
	p = e.page("P")
	if state, rev := take(t, p, bd.ID, true); state != "held" || rev != 2 {
		t.Fatalf("P's take after a cut with no other client: %s at %d", state, rev)
	}
	written(t, p, bd.ID, 2, drawing("pending"))
}

// ---- archive and delete -----------------------------------------------------

func TestArchiveAndDeleteAskTheHolder(t *testing.T) {
	e := newEnv(t)
	p := e.page("P")
	for _, c := range []struct{ name, method, path string }{
		{"archive", "POST", "/archive"},
		{"delete", "DELETE", ""},
	} {
		bd := newBoard(t, p, c.name)
		written(t, p, bd.ID, 0, drawing("saved"))
		start := time.Now()
		done := e.later(c.method, "/api/boards/"+bd.ID+c.path)
		until(t, p, "release_request", bd.ID)
		// It waits for the holder, which writes its pending change and releases.
		select {
		case code := <-done:
			t.Fatalf("%s: answered %d before the holder released", c.name, code)
		case <-time.After(100 * time.Millisecond):
		}
		if got, found := e.a.Boards.Get(bd.ID); !found || got.Archived {
			t.Fatalf("%s: done before the holder released: %+v %v", c.name, got, found)
		}
		written(t, p, bd.ID, 1, drawing("pending"))
		if state := release(t, p, bd.ID); state != "handed" {
			t.Fatalf("%s: the holder's release: %s", c.name, state)
		}
		until(t, p, "superseded", bd.ID)
		select {
		case code := <-done:
			if code != 200 {
				t.Fatalf("%s: status %d", c.name, code)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%s: did not go on after the release", c.name)
		}
		if waited := time.Since(start); waited > 2*time.Second {
			t.Fatalf("%s: took %v with a holder that released", c.name, waited)
		}
		e.holder(bd.ID, "")
		got, found := e.a.Boards.Get(bd.ID)
		if c.name == "archive" {
			if !found || !got.Archived {
				t.Fatalf("archive: the board is %+v %v", got, found)
			}
			e.onDisk(bd.ID, drawing("pending"))
			status, out := write(p, bd.ID, 2, drawing("after"))
			if status != 409 || !strings.Contains(string(out), "the board is archived") {
				t.Fatalf("a write of the archived board: %d %s", status, out)
			}
		} else {
			if found {
				t.Fatalf("delete: the board is still there: %+v", got)
			}
			if status, out := p.Do("POST", "/api/boards/"+bd.ID+"/take", nil); status != 404 {
				t.Fatalf("take of the deleted board: %d %s", status, out)
			}
		}
	}

	// A board that nobody holds is archived at once, and its creator is not asked twice.
	bd := newBoard(t, p, "free")
	if state := release(t, p, bd.ID); state != "free" {
		t.Fatalf("release: %s", state)
	}
	start := time.Now()
	if status, out := p.Do("POST", "/api/boards/"+bd.ID+"/archive", nil); status != 200 || time.Since(start) > time.Second {
		t.Fatalf("archive of a free board: %d %s after %v", status, out, time.Since(start))
	}
	if got := e.roleEvents(p); len(got) != 0 {
		t.Fatalf("the page was sent %v for a board it does not hold", got)
	}
}

// ---- follow at a read -------------------------------------------------------

func TestReadsFollow(t *testing.T) {
	e := newEnv(t)
	p := e.page("P")
	c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	chat := editorbridge.Chat(c.ID)
	followers := func() []string { return e.s.Bridge.Followers(chat) }

	// A read without the id of an open stream starts no follow.
	for _, client := range []string{"", "ghost"} {
		for _, path := range []string{"/items", "/tree", "/subagents/nope/items"} {
			e.doAs(client, "GET", "/api/chats/"+c.ID+path, "")
		}
	}
	// Neither does a read of the chat's view.
	p.Do("GET", "/api/chats/"+c.ID, nil)
	if got := followers(); len(got) != 0 {
		t.Fatalf("followers before a read: %v", got)
	}
	// Each of the three reads follows the chat for its client; the unfollow ends it. The read of
	// a subagent's items follows before it looks for the subagent.
	for _, r := range []struct {
		path string
		code int
	}{{"/items", 200}, {"/tree", 200}, {"/subagents/nope/items", 404}} {
		if status, out := p.Do("GET", "/api/chats/"+c.ID+r.path, nil); status != r.code {
			t.Fatalf("GET %s: %d %s", r.path, status, out)
		}
		if got := followers(); !slices.Equal(got, []string{"P"}) {
			t.Fatalf("followers after GET %s: %v", r.path, got)
		}
		// Another client's unfollow is its own.
		e.expect(200, "POST", "/api/chats/"+c.ID+"/unfollow", "")
		if got := followers(); !slices.Equal(got, []string{"P"}) {
			t.Fatalf("followers after another client's unfollow: %v", got)
		}
		for range 2 { // the second has nothing to end, and is answered the same
			status, out := p.Do("POST", "/api/chats/"+c.ID+"/unfollow", nil)
			if got := answer(t, 200, status, out); got["ok"] != true {
				t.Fatalf("unfollow: %s", out)
			}
		}
		if got := followers(); len(got) != 0 {
			t.Fatalf("followers after the unfollow: %v", got)
		}
	}
	// Two clients follow one chat.
	p.Do("GET", "/api/chats/"+c.ID+"/items", nil)
	e.expect(200, "GET", "/api/chats/"+c.ID+"/items", "")
	if got := followers(); len(got) != 2 {
		t.Fatalf("followers after two clients' reads: %v", got)
	}
	// The unfollow of a chat or a run that is not there is answered the same, without runs too.
	for _, path := range []string{"/api/chats/nope/unfollow", "/api/runs/r_nope/unfollow"} {
		status, out := p.Do("POST", path, nil)
		if got := answer(t, 200, status, out); got["ok"] != true {
			t.Fatalf("POST %s: %s", path, out)
		}
	}
}

func TestRunDetailReadFollows(t *testing.T) {
	e := newRunEnv(t)
	said := make(chan struct{}, 1)
	e.fake.Script(func(t *agenttest.Turn) {
		t.Say("first")
		said <- struct{}{}
		<-t.Interrupted()
	})
	v := e.newRun()
	e.view(200, "POST", "/api/runs/"+v.ID+"/start", `{"goal":"Look around."}`)
	<-said
	run := editorbridge.Run(v.ID)
	if code, out := e.doAs("", "GET", "/api/runs/"+v.ID+"/detail", ""); code != 200 {
		t.Fatalf("detail without an id: %d %s", code, out)
	}
	e.expect(200, "GET", "/api/runs/"+v.ID, "")
	if got := e.s.Bridge.Followers(run); len(got) != 0 {
		t.Fatalf("followers before the read: %v", got)
	}
	e.expect(200, "GET", "/api/runs/"+v.ID+"/detail", "")
	if got := e.s.Bridge.Followers(run); !slices.Equal(got, []string{clientID}) {
		t.Fatalf("followers after the read: %v", got)
	}
	e.expect(200, "POST", "/api/runs/"+v.ID+"/unfollow", "")
	if got := e.s.Bridge.Followers(run); len(got) != 0 {
		t.Fatalf("followers after the unfollow: %v", got)
	}
}

// A page that has only read since its stream opened (a reload of a page that shows a chat) is
// asked a board tool call (AC40).
func TestPageThatOnlyReadIsAskedACall(t *testing.T) {
	e := newEnv(t)
	v := e.page("V")
	bd, token := e.boardChat(v)
	c := e.a.Chats.ChatsOfBoard(bd.ID)[0]
	v2 := e.page("V") // the reconnect: a new record
	v.ExpectEnded()
	v2.OnRPC(func(map[string]any) (any, string) { return "the board", "" })
	for _, path := range []string{"/api/state", "/api/chats/" + c.ID + "/items", "/api/chats/" + c.ID + "/tree", "/api/boards/" + bd.ID + "/scene"} {
		if status, out := v2.Do("GET", path, nil); status != 200 {
			t.Fatalf("GET %s: %d %s", path, status, out)
		}
	}
	if text, isErr := e.tool(token, "read_board"); isErr || text != "the board" {
		t.Fatalf("read_board after reads alone: %q, error %v", text, isErr)
	}
}

// A read of a chat that is not there leaves no follow; a missing subagent of a chat that is there
// keeps the chat's.
func TestFailedChatReadLeavesNoFollow(t *testing.T) {
	e := newEnv(t)
	p := e.page("P")
	none := editorbridge.Chat("no-such-chat")
	for _, path := range []string{"/items", "/tree", "/subagents/x/items"} {
		if status, out := p.Do("GET", "/api/chats/no-such-chat"+path, nil); status != 404 {
			t.Fatalf("GET %s of a missing chat: %d %s", path, status, out)
		}
		if got := e.s.Bridge.Followers(none); len(got) != 0 {
			t.Fatalf("followers after GET %s of a missing chat: %v", path, got)
		}
	}
	bd, _ := e.boardChat(p)
	c := e.a.Chats.ChatsOfBoard(bd.ID)[0]
	if status, out := p.Do("GET", "/api/chats/"+c.ID+"/subagents/no-such/items", nil); status != 404 {
		t.Fatalf("a missing subagent: %d %s", status, out)
	}
	if got := e.s.Bridge.Followers(editorbridge.Chat(c.ID)); !slices.Equal(got, []string{"P"}) {
		t.Fatalf("followers after a missing subagent's read: %v", got)
	}
}

func TestFailedRunReadLeavesNoFollow(t *testing.T) {
	e := newRunEnv(t)
	e.expect(404, "GET", "/api/runs/r_nosuchrun/detail", "")
	if got := e.s.Bridge.Followers(editorbridge.Run("r_nosuchrun")); len(got) != 0 {
		t.Fatalf("followers after the detail of a missing run: %v", got)
	}
}

// ---- who is told (AC41) -----------------------------------------------------

// The events about a role go to the pages they concern and to no other: a page that neither
// holds nor asks for the board gets none of them, an agent's call goes to the holder alone, and
// the hello and the snapshot of a new stream go to that stream alone.
func TestRoleEventsReachOnlyWhoTheyConcern(t *testing.T) {
	e := newEnv(t)
	p, q, n := e.page("P"), e.page("Q"), e.page("N")
	bd, token := e.boardChat(p)
	e.holder(bd.ID, "P")
	for _, pg := range []*bridgetest.Page{p, q, n} {
		if got := e.roleEvents(pg); len(got) != 0 {
			t.Fatalf("page %s was sent %v before anything was asked", pg.ID, got)
		}
	}

	// Q takes the board P holds, and P releases it.
	if state, _ := take(t, q, bd.ID, false); state != "waiting" {
		t.Fatalf("the take of a held board: %s", state)
	}
	if state := release(t, p, bd.ID); state != "handed" {
		t.Fatalf("the holder's release: %s", state)
	}
	e.holder(bd.ID, "Q")
	if got := e.roleEvents(n); len(got) != 0 {
		t.Errorf("the page that neither held nor asked was sent %v", got)
	}
	if got, want := e.roleEvents(p), []string{"release_request " + bd.ID, "superseded " + bd.ID}; !slices.Equal(got, want) {
		t.Errorf("the page that held was sent %v, want %v", got, want)
	}
	if got, want := e.roleEvents(q), []string{"held " + bd.ID}; !slices.Equal(got, want) {
		t.Errorf("the page that asked was sent %v, want %v", got, want)
	}

	// An agent's call: the holder is asked and answers, and no other page sees the call. (Q's
	// rpc events go to its answering function, so its queue shows none either way.)
	asked := make(chan map[string]any, 4)
	q.OnRPC(func(params map[string]any) (any, string) {
		asked <- params
		return "the board", ""
	})
	if text, isErr := e.tool(token, "read_board"); isErr || text != "the board" {
		t.Fatalf("read_board answered by the holder: %q, error %v", text, isErr)
	}
	if len(asked) != 1 {
		t.Errorf("the holder was asked %d calls, want 1", len(asked))
	}
	for _, pg := range []*bridgetest.Page{n, p} {
		if got := e.roleEvents(pg); len(got) != 0 {
			t.Errorf("page %s was sent %v for a call the holder answered", pg.ID, got)
		}
	}
	q.OnRPC(nil)
	if got := e.roleEvents(q); len(got) != 0 {
		t.Errorf("the holder was sent %v after its answer", got)
	}

	// A fourth page connects: its hello and snapshot are its own.
	f := e.page("F")
	for _, pg := range []*bridgetest.Page{p, q, n} {
		for _, raw := range pg.Drain(150 * time.Millisecond) {
			if typ := typeOf(raw); typ == "hello" || typ == "snapshot" {
				t.Errorf("page %s was sent the %s of another stream: %s", pg.ID, typ, raw)
			}
		}
	}
	if got := e.roleEvents(f); len(got) != 0 {
		t.Errorf("the new page was sent %v", got)
	}
	e.holder(bd.ID, "Q")
}
