package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/app"
	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
	"ai-whiteboard/internal/version"
)

// ---- fakes ----------------------------------------------------------------

type fakeAgent struct{ ch chan agent.Event }

func (a *fakeAgent) Events() <-chan agent.Event      { return a.ch }
func (a *fakeAgent) Send([]agent.ContentBlock) error { return nil }
func (a *fakeAgent) Interrupt() error                { return nil }
func (a *fakeAgent) Decide(string, bool) error       { return nil }
func (a *fakeAgent) Close()                          {}

// fakeSpawner fails with ErrFolderMissing like the real adapters when the folder is gone.
type fakeSpawner struct {
	forkErr error // non-nil: every fork start fails with it
}

func (s fakeSpawner) SpawnFork(o agent.SpawnOptions, src agent.ForkSource) (agent.Agent, string, error) {
	if s.forkErr != nil {
		return nil, "", s.forkErr
	}
	return &fakeAgent{ch: make(chan agent.Event)}, o.SessionID, nil
}

func (fakeSpawner) DiscardFork(string) {}

func (fakeSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	if _, err := os.Stat(o.Cwd); err != nil {
		return nil, agent.ErrFolderMissing
	}
	return &fakeAgent{ch: make(chan agent.Event)}, nil
}

func (fakeSpawner) ReadContextSplit(o agent.SpawnOptions) (model.ContextSplit, error) {
	return model.ContextSplit{Total: 10, Window: 100, Categories: []model.ContextCategory{{ID: "messages", Label: "Messages", Tokens: 10, Kind: "used"}}}, nil
}

// permAgent raises permission requests and keeps the answers it gets. Like the real adapters it
// refuses an id it has not raised or has had answered.
type permAgent struct {
	fakeAgent
	mu      sync.Mutex
	asked   map[string]bool
	answers []string // "<id> true" or "<id> false", in order
}

func (a *permAgent) ask(id string) {
	a.mu.Lock()
	a.asked[id] = true
	a.mu.Unlock()
	a.ch <- agent.Event{Kind: agent.EvPermRequest, PermID: id, ToolName: "Bash"}
}

func (a *permAgent) Decide(id string, allow bool) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.asked[id] {
		return fmt.Errorf("unknown permission request %q", id)
	}
	delete(a.asked, id)
	a.answers = append(a.answers, fmt.Sprintf("%s %v", id, allow))
	return nil
}

func (a *permAgent) answered() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.answers...)
}

// permSpawner spawns permAgents and keeps them, in spawn order.
type permSpawner struct {
	fakeSpawner
	mu     sync.Mutex
	agents []*permAgent
}

func (s *permSpawner) Spawn(agent.SpawnOptions) (agent.Agent, error) {
	a := &permAgent{fakeAgent: fakeAgent{ch: make(chan agent.Event)}, asked: map[string]bool{}}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.agents = append(s.agents, a)
	return a, nil
}

// agent waits for the i-th process spawned.
func (s *permSpawner) agent(t *testing.T, i int) *permAgent {
	t.Helper()
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		s.mu.Lock()
		if len(s.agents) > i {
			a := s.agents[i]
			s.mu.Unlock()
			return a
		}
		s.mu.Unlock()
	}
	t.Fatalf("process %d was not spawned", i)
	return nil
}

// ---- environment ----------------------------------------------------------

const clientID = "A"

type env struct {
	t   *testing.T
	st  *store.Store
	a   *app.App
	s   *Server
	url string
}

// newEnv starts a server; each of with sets up the Server before its handler is built.
func newEnv(t *testing.T, with ...func(*Server)) *env {
	t.Helper()
	root := t.TempDir()
	st, err := store.Open(store.NewPaths(root))
	if err != nil {
		t.Fatal(err)
	}
	var a *app.App
	br := editorbridge.New(func() any { return a.Snapshot() })
	bds := boards.New(st, br)
	br.SceneRev = bds.Rev
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	cm := chats.New(chats.Deps{Store: st, Bridge: br, Boards: bds,
		Spawners:   map[model.AgentKind]agent.Spawner{model.Claude: fakeSpawner{}, model.Cursor: fakeSpawner{}},
		DefaultCwd: t.TempDir()})
	a = &app.App{St: st, Boards: bds, Chats: cm, Bridge: br, DataDir: root, DefaultCwd: cm.DefaultCwd}
	s := &Server{App: a, Relay: &boardapi.Relay{Bridge: br, Chats: cm, Boards: bds}, Bridge: br, Port: port}
	for _, f := range with {
		f(s)
	}
	srv := httptest.NewUnstartedServer(s.Handler())
	srv.Listener.Close()
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)
	e := &env{t: t, st: st, a: a, s: s, url: srv.URL}
	e.connect()
	return e
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

// connect opens /api/events as clientID and waits until it is a known client. As the page does, it
// releases a board it is asked to release (one it made: it holds no other), so an archive or a
// delete of that board does not wait three seconds for it.
func (e *env) connect() {
	e.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	e.t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, "GET", e.url+"/api/events?client="+clientID, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	active := make(chan struct{})
	go func() {
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(nil, 1<<20)
		done := false
		for sc.Scan() {
			line, ok := strings.CutPrefix(sc.Text(), "data: ")
			if !ok {
				continue
			}
			var ev map[string]any
			if json.Unmarshal([]byte(line), &ev) == nil && ev["type"] == "hello" && !done {
				done = true
				close(active)
			}
			if board, _ := ev["board"].(string); ev["type"] == "release_request" {
				go e.release(board)
			}
		}
	}()
	select {
	case <-active:
	case <-time.After(2 * time.Second):
		e.t.Fatal("client not active")
	}
}

// release is clientID's answer to a release_request for the board.
func (e *env) release(board string) {
	req, _ := http.NewRequest("POST", e.url+"/api/boards/"+board+"/release", nil)
	req.Header.Set(ClientHeader, clientID)
	if resp, err := http.DefaultClient.Do(req); err == nil {
		resp.Body.Close()
	}
}

// do sends a request as clientID and returns the status and body.
func (e *env) do(method, path, body string) (int, string) {
	e.t.Helper()
	return e.doAs(clientID, method, path, body)
}

func (e *env) doAs(client, method, path, body string) (int, string) {
	e.t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, e.url+path, rd)
	if client != "" {
		req.Header.Set(ClientHeader, client)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func (e *env) expect(want int, method, path, body string) string {
	e.t.Helper()
	got, out := e.do(method, path, body)
	if got != want {
		e.t.Fatalf("%s %s: status %d, want %d (%s)", method, path, got, want, out)
	}
	return out
}

func decode[T any](t *testing.T, s string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatalf("decode %q: %v", s, err)
	}
	return v
}

func (e *env) board(group string) model.Board {
	e.t.Helper()
	return decode[model.Board](e.t, e.expect(200, "POST", "/api/boards", `{"name":"b","group":"`+group+`"}`))
}

func (e *env) chat(body string) model.ChatView {
	e.t.Helper()
	return decode[model.ChatView](e.t, e.expect(200, "POST", "/api/chats", body))
}

// ---- guard ----------------------------------------------------------------

func TestBadHostIsForbidden(t *testing.T) {
	e := newEnv(t)
	for _, method := range []string{"GET", "POST"} {
		req, _ := http.NewRequest(method, e.url+"/api/state", nil)
		req.Host = "evil.example"
		req.Header.Set(ClientHeader, clientID)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 403 {
			t.Fatalf("%s: status %d, want 403", method, resp.StatusCode)
		}
	}
	req, _ := http.NewRequest("GET", strings.Replace(e.url, "127.0.0.1", "localhost", 1)+"/api/hello", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("localhost: status %d", resp.StatusCode)
	}
}

func TestMCPHandlerRoutesAndHost(t *testing.T) {
	e := newEnv(t)
	const mcpPort = 6006
	h := e.s.MCPHandler(mcpPort)
	post := func(host, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", path, strings.NewReader(body))
		req.Host = host
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w
	}

	// POST /mcp answers on the MCP listener for the advertised host spelling.
	for _, host := range []string{"localhost:6006", "127.0.0.1:6006"} {
		if w := post(host, "/mcp", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`); w.Code != 200 {
			t.Fatalf("host %s: status %d, want 200 (%s)", host, w.Code, w.Body)
		}
	}

	// The DNS-rebinding guard still applies to the MCP listener: only its own port is allowed.
	if w := post("evil.example", "/mcp", `{}`); w.Code != 403 {
		t.Fatalf("foreign host: status %d, want 403", w.Code)
	}
	if w := post(fmt.Sprintf("localhost:%d", e.s.Port), "/mcp", `{}`); w.Code != 403 {
		t.Fatalf("app-port host on the MCP listener: status %d, want 403", w.Code)
	}

	// Non-POST is 405, and the listener serves no /api routes.
	req := httptest.NewRequest("GET", "/mcp", nil)
	req.Host = "localhost:6006"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /mcp: status %d, want 405", w.Code)
	}
	req = httptest.NewRequest("GET", "/api/hello", nil)
	req.Host = "localhost:6006"
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("GET /api/hello on the MCP listener: status %d, want 404", w.Code)
	}
}

func TestMCPStatusRoute(t *testing.T) {
	e := newEnv(t, func(s *Server) {
		s.MCPPort = 6006
		s.MCPURL = boardapi.MCPURL
		s.MCPUp = func() bool { return true }
	})
	// Listener shape before any contact; no client header is needed for a GET (guard.go).
	if code, out := e.doAs("", "GET", "/api/mcp/status", ""); code != 200 {
		t.Fatalf("GET /api/mcp/status without a client header: status %d (%s), want 200", code, out)
	}
	out := decode[mcpStatus](t, e.expect(200, "GET", "/api/mcp/status", ""))
	if out.Listener.Port != 6006 || out.Listener.URL != boardapi.MCPURL || !out.Listener.Up {
		t.Fatalf("listener %+v", out.Listener)
	}
	if len(out.Chats) != 0 {
		t.Fatalf("chats before contact %+v", out.Chats)
	}

	bd := e.board(model.Ungrouped)
	c := e.chat(`{"agent":"claude","board":"` + bd.ID + `"}`)
	metas := e.a.Chats.ChatsOfBoard(bd.ID)
	if len(metas) != 1 || metas[0].Token == "" {
		t.Fatalf("board chats %+v", metas)
	}
	token := metas[0].Token

	// The fixed MCP handler is the observation point; post to it directly, as the 6006 listener
	// would. Archive the chat first so the tools/call answers without a browser client and the
	// archived interaction is what gets recorded.
	post := func(auth, body string) {
		t.Helper()
		req := httptest.NewRequest("POST", "/mcp", strings.NewReader(body))
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		w := httptest.NewRecorder()
		e.s.Relay.ServeFixedMCP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("POST /mcp: status %d (%s)", w.Code, w.Body)
		}
	}
	post("Bearer "+token, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"Cursor","version":"1.2.3"}}}`)
	e.expect(200, "POST", "/api/boards/"+bd.ID+"/archive", "")
	post("Bearer "+token, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_board","arguments":{}}}`)
	// An unresolved credential is logged and reported as unknown, and answered normally (D8).
	post("Bearer not-a-real-token", `{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"clientInfo":{"name":"probe","version":"0"}}}`)

	body := e.expect(200, "GET", "/api/mcp/status", "")
	if strings.Contains(body, token) {
		t.Fatalf("status leaks the board token: %s", body)
	}
	if strings.Contains(body, "not-a-real-token") {
		t.Fatalf("status leaks the unknown credential: %s", body)
	}
	st := decode[mcpStatus](t, body)
	if len(st.Chats) != 2 {
		t.Fatalf("chats %+v", st.Chats)
	}
	// The endpoint's most-recent-first order is pinned deterministically by
	// boardapi.TestContactLogSnapshotOrdersMostRecentFirst. Here each contact is found by its chat
	// label, so map iteration order cannot decide the result.
	var unknown, known *boardapi.Contact
	for i := range st.Chats {
		if st.Chats[i].Chat == "unknown" {
			unknown = &st.Chats[i]
		} else {
			known = &st.Chats[i]
		}
	}
	if unknown == nil || known == nil {
		t.Fatalf("chats %+v, want one unknown and one known contact", st.Chats)
	}
	if unknown.Client != "probe" || unknown.Method != "initialize" {
		t.Fatalf("unknown contact %+v", *unknown)
	}
	if known.Chat != c.ID[:8] || known.Client != "Cursor" || known.ClientVersion != "1.2.3" ||
		known.Method != "tools/call" || known.Tool != "read_board" || known.Outcome != "error" || known.At.IsZero() {
		t.Fatalf("known contact %+v", *known)
	}
}

func TestMutationsNeedAKnownClient(t *testing.T) {
	e := newEnv(t)
	for _, client := range []string{"", "B"} {
		code, out := e.doAs(client, "POST", "/api/boards", `{"group":"__ungrouped__"}`)
		if code != 409 || decode[map[string]string](t, out)["error"] != "unknown_client" {
			t.Fatalf("client %q: %d %s", client, code, out)
		}
	}
	if n := len(e.a.Boards.List()); n != 0 {
		t.Fatalf("%d boards made", n)
	}
	// GETs need no header.
	if code, out := e.doAs("", "GET", "/api/state", ""); code != 200 {
		t.Fatalf("state: %d %s", code, out)
	}
	// The client routes are no exception, and a client in the body does not count.
	for _, path := range []string{"/api/rpc-reply", "/api/client/flushed"} {
		for _, client := range []string{"", "B"} {
			code, out := e.doAs(client, "POST", path, `{"id":"rpc_1","client":"A"}`)
			if code != 409 || decode[map[string]string](t, out)["error"] != "unknown_client" {
				t.Fatalf("%s from %q: %d %s", path, client, code, out)
			}
		}
	}
	if code, _ := e.doAs("A", "POST", "/api/client/flushed", ""); code != 200 {
		t.Fatalf("flushed from A: %d", code)
	}
	// A client releases a board, not itself: the route of the one active client is gone.
	if code, _ := e.doAs("A", "POST", "/api/client/release", `{"client":"A"}`); code != 404 {
		t.Fatalf("release from A: %d", code)
	}
	// A reply counts only from the client that was asked: A was asked nothing.
	code, out := e.doAs("A", "POST", "/api/rpc-reply", `{"id":"rpc_1","result":"x"}`)
	if code != 409 || decode[map[string]string](t, out)["error"] != "not_asked" {
		t.Fatalf("rpc-reply from A, which was not asked: %d %s", code, out)
	}
}

func TestHello(t *testing.T) {
	e := newEnv(t)
	out := decode[map[string]any](t, e.expect(200, "GET", "/api/hello", ""))
	if out["app"] != "ai-whiteboard" || out["version"] != version.Version || out["pid"] != float64(os.Getpid()) {
		t.Fatalf("hello %v", out)
	}
}

func TestHelloWebVersion(t *testing.T) {
	webVersion := func(e *env) any {
		return decode[map[string]any](t, e.expect(200, "GET", "/api/hello", ""))["webVersion"]
	}
	if got := webVersion(newEnv(t)); got != "dev" {
		t.Fatalf("no client folder: webVersion %v, want dev", got)
	}
	dir := t.TempDir()
	e := newEnv(t, func(s *Server) { s.Client = dir })
	if got := webVersion(e); got != "dev" {
		t.Fatalf("no version.json: webVersion %v, want dev", got)
	}
	if err := os.WriteFile(filepath.Join(dir, "version.json"), []byte(`{"version":"v1.2-3-gabc"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := webVersion(e); got != "v1.2-3-gabc" {
		t.Fatalf("webVersion %v, want v1.2-3-gabc", got)
	}
	// Read on each request: a new install changes it without a restart.
	if err := os.WriteFile(filepath.Join(dir, "version.json"), []byte(`not json`), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := webVersion(e); got != "dev" {
		t.Fatalf("unreadable version.json: webVersion %v, want dev", got)
	}
}

func TestRestart(t *testing.T) {
	calls := 0
	e := newEnv(t, func(s *Server) { s.Restart = func() error { calls++; return nil } })
	if code, out := e.doAs("B", "POST", "/api/restart", ""); code != 409 || calls != 0 {
		t.Fatalf("restart from another client: %d %s, %d calls", code, out, calls)
	}
	e.expect(202, "POST", "/api/restart", "")
	if calls != 1 {
		t.Fatalf("hook called %d times, want 1", calls)
	}
	// The server keeps running.
	e.expect(200, "GET", "/api/hello", "")
}

func TestRestartBinaryMissing(t *testing.T) {
	e := newEnv(t, func(s *Server) {
		s.Restart = func() error { return fmt.Errorf("%w: stat /x: no such file", ErrBinaryMissing) }
	})
	out := e.expect(409, "POST", "/api/restart", "")
	if got := decode[map[string]string](t, out)["error"]; got != "binary_missing" {
		t.Fatalf("error %q, want binary_missing", got)
	}
	e = newEnv(t, func(s *Server) { s.Restart = func() error { return errors.New("fork failed") } })
	e.expect(500, "POST", "/api/restart", "")
}

// ---- boards ---------------------------------------------------------------

func TestCreateBoardAndSceneRoundTrip(t *testing.T) {
	e := newEnv(t)
	bd := e.board(model.Ungrouped)
	if _, err := os.Stat(e.st.P.BoardFile(bd.ID)); err != nil {
		t.Fatalf("drawing not written: %v", err)
	}
	if _, err := os.Stat(filepath.Join(e.st.P.BoardDir(bd.ID), "board.json")); err != nil {
		t.Fatalf("board.json not written: %v", err)
	}
	if got := e.expect(200, "GET", "/api/boards/"+bd.ID+"/scene", ""); got != boards.EmptyScene {
		t.Fatalf("new scene %s", got)
	}
	scene := `{"type":"excalidraw","version":2,"elements":[{"id":"x","type":"rectangle"}],"appState":{},"files":{}}`
	e.expect(200, "PUT", "/api/boards/"+bd.ID+"/scene?rev=0", scene)
	if got := e.expect(200, "GET", "/api/boards/"+bd.ID+"/scene", ""); got != scene {
		t.Fatalf("scene %s", got)
	}
}

// ---- error mapping --------------------------------------------------------

func TestNotFound(t *testing.T) {
	e := newEnv(t)
	for _, r := range [][3]string{
		{"GET", "/api/boards/b_nope/scene", ""},
		{"PUT", "/api/boards/b_nope/scene?rev=0", `{}`},
		{"POST", "/api/boards/b_nope/rename", `{"name":"x"}`},
		{"POST", "/api/boards/b_nope/archive", ""},
		{"DELETE", "/api/boards/b_nope", ""},
		{"GET", "/api/chats/nope", ""},
		{"GET", "/api/chats/nope/items", ""},
		{"GET", "/api/chats/nope/context", ""},
		{"GET", "/api/chats/nope/tree", ""},
		{"PUT", "/api/chats/nope/label", `{"branch":"main","item":1,"text":"x"}`},
		{"GET", "/api/chats/nope/subagents/nope/items", ""},
		{"POST", "/api/chats/nope/messages", `{"text":"hi"}`},
		{"PATCH", "/api/chats/nope", `{"name":"x"}`},
		{"PUT", "/api/chats/nope/draft?rev=0", `{"text":"x"}`},
		{"DELETE", "/api/chats/nope", ""},
		{"PATCH", "/api/groups/g_nope", `{"name":"x"}`},
		{"POST", "/api/groups/g_nope/archive", ""},
		{"DELETE", "/api/groups/g_nope?contents=delete", ""},
		{"POST", "/api/groups", `{"name":"x","parent":"g_nope"}`},
		{"POST", "/api/groups/g_nope/move", `{"parent":""}`},
	} {
		out := e.expect(404, r[0], r[1], r[2])
		if decode[map[string]string](t, out)["error"] == "" {
			t.Fatalf("%s %s: no error text in %s", r[0], r[1], out)
		}
	}
}

func TestConflict(t *testing.T) {
	e := newEnv(t)

	// archived board and chat
	bd := e.board(model.Ungrouped)
	c := e.chat(`{"agent":"claude","board":"` + bd.ID + `"}`)
	e.expect(200, "POST", "/api/boards/"+bd.ID+"/archive", "")
	e.expect(409, "PUT", "/api/boards/"+bd.ID+"/scene?rev=0", `{}`)
	e.expect(409, "POST", "/api/chats/"+c.ID+"/messages", `{"text":"hi"}`)
	e.expect(409, "PATCH", "/api/chats/"+c.ID, `{"model":"opus"}`)

	// busy, then locked
	c = e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	e.expect(200, "POST", "/api/chats/"+c.ID+"/messages", `{"text":"hi"}`)
	e.expect(409, "POST", "/api/chats/"+c.ID+"/messages", `{"text":"again"}`)
	e.expect(409, "PATCH", "/api/chats/"+c.ID, `{"model":"opus"}`)

	// folder missing
	dir := filepath.Join(t.TempDir(), "work")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	c = e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	e.expect(200, "PATCH", "/api/chats/"+c.ID, `{"cwd":"`+dir+`"}`)
	if err := os.Remove(dir); err != nil {
		t.Fatal(err)
	}
	e.expect(409, "POST", "/api/chats/"+c.ID+"/messages", `{"text":"hi"}`)

	// archived group: no new or moved subgroups in it
	g := decode[model.Group](t, e.expect(200, "POST", "/api/groups", `{"name":"G"}`))
	h := decode[model.Group](t, e.expect(200, "POST", "/api/groups", `{"name":"H"}`))
	e.expect(200, "POST", "/api/groups/"+g.ID+"/archive", "")
	e.expect(409, "POST", "/api/groups", `{"name":"S","parent":"`+g.ID+`"}`)
	e.expect(409, "POST", "/api/groups/"+h.ID+"/move", `{"parent":"`+g.ID+`"}`)
}

func TestBadRequest(t *testing.T) {
	e := newEnv(t)
	bd := e.board(model.Ungrouped)
	c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	g := decode[model.Group](t, e.expect(200, "POST", "/api/groups", `{"name":"G"}`))
	notDir := filepath.Join(t.TempDir(), "file")
	os.WriteFile(notDir, nil, 0o644)
	for _, r := range [][3]string{
		{"POST", "/api/boards", `not json`},
		{"POST", "/api/boards", `{"name":"x","group":""}`},
		{"POST", "/api/boards", `{"name":"x"}`},
		{"POST", "/api/boards", `{"name":"a/b","group":"__ungrouped__"}`},
		{"POST", "/api/boards", `{"name":"x","group":"g_nope"}`},
		{"PUT", "/api/boards/" + bd.ID + "/scene?rev=0", `not json`},
		{"PUT", "/api/boards/" + bd.ID + "/scene", `{}`},
		{"POST", "/api/boards/" + bd.ID + "/rename", `{"name":"  "}`},
		{"PATCH", "/api/boards/" + bd.ID, `{"group":""}`},
		{"PATCH", "/api/boards/" + bd.ID, `{"group":"g_nope"}`},
		{"POST", "/api/chats", `{"agent":"claude","group":""}`},
		{"POST", "/api/chats", `{"agent":"nobody","group":"__ungrouped__"}`},
		{"PATCH", "/api/chats/" + c.ID, `{"group":""}`},
		{"PATCH", "/api/chats/" + c.ID, `{"cwd":"` + notDir + `"}`},
		{"PATCH", "/api/chats/" + c.ID, `{"cwd":"` + e.st.P.Root + `"}`},
		{"PATCH", "/api/chats/" + c.ID, `{"model":"no-such-model"}`},
		{"PUT", "/api/chats/" + c.ID + "/draft?rev=0", `not json`},
		{"PUT", "/api/groups/order", `{"ids":["g_nope"]}`},
		{"DELETE", "/api/groups/g_x?contents=maybe", ""},
		{"POST", "/api/groups/" + g.ID + "/move", `{"parent":"` + g.ID + `"}`},
		{"GET", "/api/dirs?path=" + notDir, ""},
	} {
		code, out := e.do(r[0], r[1], r[2])
		if code != 400 {
			t.Fatalf("%s %s %s: status %d, want 400 (%s)", r[0], r[1], r[2], code, out)
		}
		if decode[map[string]string](t, out)["error"] == "" {
			t.Fatalf("%s %s: no error text in %s", r[0], r[1], out)
		}
	}
}

// ---- other routes ---------------------------------------------------------

func TestChatPatchRoutesFields(t *testing.T) {
	e := newEnv(t)
	g := decode[model.Group](t, e.expect(200, "POST", "/api/groups", `{"name":"G"}`))
	c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	dir := t.TempDir()
	e.expect(200, "PATCH", "/api/chats/"+c.ID, `{"name":"Mine","group":"`+g.ID+`","model":"opus","cwd":"`+dir+`"}`)
	v := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+c.ID, ""))
	if v.Name != "Mine" || !v.UserNamed || v.Group != g.ID || v.Model != "opus" || v.Cwd != dir {
		t.Fatalf("chat %+v", v)
	}
	items := decode[map[string]any](t, e.expect(200, "GET", "/api/chats/"+c.ID+"/items", ""))
	if _, ok := items["items"].([]any); !ok {
		t.Fatalf("items %v", items)
	}
	if subs, ok := items["subagents"].([]any); !ok || len(subs) != 0 {
		t.Fatalf("subagents %v", items)
	}
	// With the branch named: the session fields go to it, the name stays the chat's.
	e.expect(200, "PATCH", "/api/chats/"+c.ID+"?branch=main", `{"name":"Ours","model":"sonnet","effort":"high"}`)
	v = decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+c.ID, ""))
	if st := e.thread(c.ID, "main").State; v.Name != "Ours" || v.Model != "sonnet" || v.Effort != "high" || st.Model != "sonnet" || st.Effort != "high" || st.Cwd != dir {
		t.Fatalf("chat %+v, state %+v", v, st)
	}
	e.expect(404, "PATCH", "/api/chats/"+c.ID+"?branch=nope", `{"model":"opus"}`)
	out := e.expect(404, "GET", "/api/chats/"+c.ID+"/subagents/nope/items", "")
	if decode[map[string]string](t, out)["error"] == "" {
		t.Fatalf("unknown subagent: no error text in %s", out)
	}
}

func TestGroupRoutesNestAndMove(t *testing.T) {
	e := newEnv(t)
	a := decode[model.Group](t, e.expect(200, "POST", "/api/groups", `{"name":"A"}`))
	b := decode[model.Group](t, e.expect(200, "POST", "/api/groups", `{"name":"B"}`))
	s := decode[model.Group](t, e.expect(200, "POST", "/api/groups", `{"name":"S","parent":"`+a.ID+`"}`))
	if s.Parent != a.ID {
		t.Fatalf("subgroup %+v", s)
	}
	e.expect(200, "POST", "/api/groups/"+s.ID+"/move", `{"parent":"`+b.ID+`"}`)
	e.expect(200, "POST", "/api/groups/"+b.ID+"/move", `{"parent":"","before":"`+a.ID+`"}`)
	snap := decode[app.Snapshot](t, e.expect(200, "GET", "/api/state", ""))
	var got []string
	for _, g := range snap.Groups {
		got = append(got, g.Name+"<"+g.Parent)
	}
	if want := []string{"B<", "A<", "S<" + b.ID}; !reflect.DeepEqual(got, want) {
		t.Fatalf("groups %v, want %v", got, want)
	}
	e.expect(200, "DELETE", "/api/groups/"+b.ID+"?contents=keep", "")
	snap = decode[app.Snapshot](t, e.expect(200, "GET", "/api/state", ""))
	if len(snap.Groups) != 2 || snap.Groups[1].ID != s.ID || snap.Groups[1].Parent != "" {
		t.Fatalf("after deleting B: %+v", snap.Groups)
	}
}

func TestChatDraft(t *testing.T) {
	e := newEnv(t)
	c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	if code, _ := e.doAs("B", "PUT", "/api/chats/"+c.ID+"/draft?rev=0", `{"text":"x"}`); code != 409 {
		t.Fatalf("draft from B: %d", code)
	}
	e.expect(200, "PUT", "/api/chats/"+c.ID+"/draft?rev=0", `{"text":"hi @Plan","mentions":[{"name":"Plan","id":"b_1"}]}`)
	v := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+c.ID, ""))
	want := &model.Draft{Text: "hi @Plan", Mentions: []model.Mention{{Name: "Plan", ID: "b_1"}}}
	if !reflect.DeepEqual(v.Draft, want) {
		t.Fatalf("draft %+v", v.Draft)
	}
	if st := e.thread(c.ID, "").State; !reflect.DeepEqual(st.Draft, want) || !v.HasDraft {
		t.Fatalf("draft in the state %+v, hasDraft %v", st.Draft, v.HasDraft)
	}
	e.expect(200, "PUT", "/api/chats/"+c.ID+"/draft?rev=1", `{"text":""}`)
	if v := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+c.ID, "")); v.Draft != nil {
		t.Fatalf("cleared draft %+v", v.Draft)
	}
	// With the branch named: the same draft for an unsplit chat.
	e.expect(200, "PUT", "/api/chats/"+c.ID+"/draft?branch=main&rev=2", `{"text":"again"}`)
	if v := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+c.ID, "")); v.Draft == nil || v.Draft.Text != "again" {
		t.Fatalf("draft by branch %+v", v.Draft)
	}
	e.expect(200, "PUT", "/api/chats/"+c.ID+"/draft?branch=main&rev=3", `{"text":""}`)
	if v := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+c.ID, "")); v.Draft != nil || v.HasDraft || e.thread(c.ID, "main").State.Draft != nil {
		t.Fatalf("cleared draft %+v", v.Draft)
	}
	if out := e.expect(404, "PUT", "/api/chats/"+c.ID+"/draft?branch=nope&rev=4", `{"text":"x"}`); !strings.Contains(out, chats.ErrNoBranch.Error()) {
		t.Fatalf("error body %s", out)
	}
}

// PUT /api/chats/{id}/draft names the counter of the draft it was typed on (?rev=): the answer
// has the new one, a save on another counter is refused with the stored counter and draft, and
// a save that names none is refused.
func TestChatDraftCounter(t *testing.T) {
	e := newEnv(t)
	c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	draft := "/api/chats/" + c.ID + "/draft"
	view := func() model.ChatView {
		t.Helper()
		return decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+c.ID, ""))
	}
	if raw := e.expect(200, "GET", "/api/chats/"+c.ID, ""); strings.Contains(raw, "draftRev") {
		t.Fatalf("a chat without a draft has a counter: %s", raw)
	}

	// No counter, or one that is none: 400, and nothing is stored.
	for _, q := range []string{"", "?branch=main", "?rev=", "?rev=x", "?rev=-1", "?rev=1.5"} {
		out := decode[map[string]any](t, e.expect(400, "PUT", draft+q, `{"text":"x"}`))
		want := "rev is not a number"
		if !strings.Contains(q, "rev") {
			want = "rev is missing"
		}
		if !reflect.DeepEqual(out, map[string]any{"error": want}) {
			t.Fatalf("PUT draft%s: %v", q, out)
		}
	}
	if v := view(); v.Draft != nil || v.DraftRev != 0 {
		t.Fatalf("view after the refused saves %+v", v)
	}

	sameJSON(t, "the first save", decode[any](t, e.expect(200, "PUT", draft+"?rev=0", `{"text":"one"}`)), `{"ok":true,"rev":1}`)
	sameJSON(t, "the second save", decode[any](t, e.expect(200, "PUT", draft+"?branch=main&rev=1", `{"text":"two","mentions":[{"name":"Plan","id":"b_1"}]}`)), `{"ok":true,"rev":2}`)
	if v, st := view(), e.thread(c.ID, "main").State; v.DraftRev != 2 || st.DraftRev != 2 || v.Draft == nil || v.Draft.Text != "two" {
		t.Fatalf("view %+v, state %+v", v, st)
	}

	// A late save, typed on the first draft: 409 with what is stored, which stays.
	stale := `{"error":"the draft was changed elsewhere","code":"stale","rev":2,"draft":{"text":"two","mentions":[{"name":"Plan","id":"b_1"}]}}`
	for _, q := range []string{"?rev=1", "?rev=0", "?rev=3", "?branch=main&rev=1"} {
		sameJSON(t, "a save on "+q, decode[any](t, e.expect(409, "PUT", draft+q, `{"text":"late"}`)), stale)
	}
	if v := view(); v.DraftRev != 2 || v.Draft == nil || v.Draft.Text != "two" {
		t.Fatalf("view after the late saves %+v", v)
	}

	// A clear keeps the counter; a late save then gets no draft back.
	sameJSON(t, "the clear", decode[any](t, e.expect(200, "PUT", draft+"?rev=2", `{"text":""}`)), `{"ok":true,"rev":3}`)
	if v, st := view(), e.thread(c.ID, "main").State; v.Draft != nil || v.DraftRev != 3 || st.Draft != nil || st.DraftRev != 3 {
		t.Fatalf("view after the clear %+v, state %+v", v, st)
	}
	sameJSON(t, "a late save after the clear", decode[any](t, e.expect(409, "PUT", draft+"?rev=2", `{"text":"late"}`)),
		`{"error":"the draft was changed elsewhere","code":"stale","rev":3,"draft":null}`)

	// A message sent clears the draft of its branch and raises the counter.
	sameJSON(t, "a save before the message", decode[any](t, e.expect(200, "PUT", draft+"?rev=3", `{"text":"hello"}`)), `{"ok":true,"rev":4}`)
	e.expect(200, "POST", "/api/chats/"+c.ID+"/messages", `{"text":"hello","context":""}`)
	if v := view(); v.Draft != nil || v.DraftRev != 5 {
		t.Fatalf("view after the message %+v", v)
	}
	sameJSON(t, "a late save after the message", decode[any](t, e.expect(409, "PUT", draft+"?rev=4", `{"text":"hello"}`)),
		`{"error":"the draft was changed elsewhere","code":"stale","rev":5,"draft":null}`)
}

func TestChatContext(t *testing.T) {
	e := newEnv(t)
	c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	out := decode[map[string]string](t, e.expect(409, "GET", "/api/chats/"+c.ID+"/context", ""))
	if out["error"] != chats.ErrNotStarted.Error() {
		t.Fatalf("error %q", out["error"])
	}
	e.expect(200, "POST", "/api/chats/"+c.ID+"/messages", `{"text":"hi"}`)
	s := decode[model.ContextSplit](t, e.expect(200, "GET", "/api/chats/"+c.ID+"/context?fresh=1", ""))
	if s.Total != 10 || s.AtMessage != 1 || len(s.Categories) != 1 {
		t.Fatalf("split %+v", s)
	}
	named := decode[model.ContextSplit](t, e.expect(200, "GET", "/api/chats/"+c.ID+"/context?branch=main&fresh=1", ""))
	if !reflect.DeepEqual(named, s) {
		t.Fatalf("split by branch %+v, want %+v", named, s)
	}
	if out := e.expect(404, "GET", "/api/chats/"+c.ID+"/context?branch=nope", ""); !strings.Contains(out, chats.ErrNoBranch.Error()) {
		t.Fatalf("error body %s", out)
	}
}

// The permission route passes on who asked together with the request id. An answer that names no
// asker is for the chat's own agent, so it is refused for a subagent's card (a page loaded before
// answers named the asker).
func TestChatPermission(t *testing.T) {
	e := newEnv(t)
	sp := &permSpawner{}
	e.a.Chats.Spawners[model.Claude] = sp
	c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	path := "/api/chats/" + c.ID + "/permission"
	e.expect(200, "POST", "/api/chats/"+c.ID+"/messages", `{"text":"hi"}`)
	parent := sp.agent(t, 0)
	sa, err := e.a.Chats.SpawnSubagent(c.ID, chats.SpawnSubRequest{Prompt: "go"})
	if err != nil {
		t.Fatal(err)
	}
	child := sp.agent(t, 1)

	// cards waits for the thread to hold n permission cards and returns them.
	cards := func(n int) []model.Item {
		t.Helper()
		var got []model.Item
		for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
			got = nil
			out := decode[struct{ Items []model.Item }](t, e.expect(200, "GET", "/api/chats/"+c.ID+"/items", ""))
			for _, it := range out.Items {
				if it.Kind == "perm" {
					got = append(got, it)
				}
			}
			if len(got) == n {
				return got
			}
		}
		t.Fatalf("permission cards %+v, want %d", got, n)
		return nil
	}

	// Both use the id Cursor gives the first request of every process.
	child.ask("p1")
	if ps := cards(1); ps[0].Subagent != sa.ID || ps[0].RequestID != "p1" {
		t.Fatalf("the subagent's card %+v", ps[0])
	}
	out := decode[map[string]string](t, e.expect(400, "POST", path, `{"requestId":"p1","allow":true}`))
	if out["error"] != chats.ErrNoRequest.Error() {
		t.Fatalf("error %q", out["error"])
	}
	if ps := cards(1); ps[0].Decided != "" || len(child.answered()) != 0 || len(parent.answered()) != 0 {
		t.Fatalf("an answer without the asker reached the subagent's request: %+v", ps)
	}

	parent.ask("p1")
	cards(2)
	e.expect(200, "POST", path, `{"requestId":"p1","allow":false}`)
	if got := parent.answered(); !reflect.DeepEqual(got, []string{"p1 false"}) || len(child.answered()) != 0 {
		t.Fatalf("answer without an asker: parent %v child %v", got, child.answered())
	}
	if ps := cards(2); ps[0].Decided != "" || ps[1].Subagent != "" || ps[1].Decided != "deny" {
		t.Fatalf("cards %+v", ps)
	}

	// With the branch named: the same request.
	e.expect(404, "POST", path+"?branch=nope", `{"requestId":"p1","subagent":"`+sa.ID+`","allow":true}`)
	e.expect(200, "POST", path+"?branch=main", `{"requestId":"p1","subagent":"`+sa.ID+`","allow":true}`)
	if got := child.answered(); !reflect.DeepEqual(got, []string{"p1 true"}) || len(parent.answered()) != 1 {
		t.Fatalf("answer naming the subagent: child %v parent %v", got, parent.answered())
	}
	if ps := cards(2); ps[0].Decided != "allow" || ps[1].Decided != "deny" {
		t.Fatalf("cards %+v", ps)
	}

	// A card that is no longer open takes no answer.
	out = decode[map[string]string](t, e.expect(400, "POST", path, `{"requestId":"p1","subagent":"`+sa.ID+`","allow":false}`))
	if out["error"] != chats.ErrNoRequest.Error() || len(child.answered()) != 1 {
		t.Fatalf("second answer: %v, child %v", out, child.answered())
	}
	e.a.Chats.Stop(c.ID)
}

func TestNoStaticClientWhenUnset(t *testing.T) {
	e := newEnv(t)
	code, _ := e.do("GET", "/", "")
	if code != 404 {
		t.Fatalf("GET / status %d, want 404", code)
	}
}

// getClient fetches path with the given extra headers and returns the response and its body.
func (e *env) getClient(path string, hdr map[string]string) (*http.Response, string) {
	e.t.Helper()
	req, _ := http.NewRequest("GET", e.url+path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

func TestClientFilesRevalidateByContent(t *testing.T) {
	dir := t.TempDir()
	js := filepath.Join(dir, "main.js")
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>v1</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(js, []byte("console.log('v1')"), 0o644); err != nil {
		t.Fatal(err)
	}
	oldTime := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err := os.Chtimes(js, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	e := newEnv(t, func(s *Server) { s.Client = dir })

	for _, p := range []string{"/main.js", "/"} {
		resp, _ := e.getClient(p, nil)
		if resp.StatusCode != 200 {
			t.Fatalf("GET %s: status %d, want 200", p, resp.StatusCode)
		}
		if got := resp.Header.Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("GET %s: Cache-Control %q, want no-cache", p, got)
		}
		if tag := resp.Header.Get("ETag"); !strings.HasPrefix(tag, `"`) || len(tag) < 3 {
			t.Fatalf("GET %s: ETag %q, want a strong ETag", p, tag)
		}
	}

	resp, body := e.getClient("/main.js", nil)
	if body != "console.log('v1')" {
		t.Fatalf("main.js body %q", body)
	}
	tag := resp.Header.Get("ETag")
	lastMod := resp.Header.Get("Last-Modified")
	if resp, _ := e.getClient("/main.js", map[string]string{"If-None-Match": tag}); resp.StatusCode != 304 {
		t.Fatalf("If-None-Match same ETag: status %d, want 304", resp.StatusCode)
	}

	// A newer build with an older file time: the content decides, not the time.
	if err := os.WriteFile(js, []byte("console.log('v2 new build')"), 0o644); err != nil {
		t.Fatal(err)
	}
	older := oldTime.Add(-time.Hour)
	if err := os.Chtimes(js, older, older); err != nil {
		t.Fatal(err)
	}
	resp, body = e.getClient("/main.js", map[string]string{"If-None-Match": tag, "If-Modified-Since": lastMod})
	if resp.StatusCode != 200 {
		t.Fatalf("changed main.js: status %d, want 200", resp.StatusCode)
	}
	if body != "console.log('v2 new build')" {
		t.Fatalf("changed main.js body %q", body)
	}
	if got := resp.Header.Get("ETag"); got == tag || got == "" {
		t.Fatalf("changed main.js: ETag %q, want a new one (old %q)", got, tag)
	}
}

// ---- the tree and labels --------------------------------------------------

// The worked example of the chat forking plan: main's items, the branch a1b2c3d4 split from it at
// 3, the tree record and the answer of the tree route.
const (
	exMainItems = `{"i":0,"item":{"kind":"user","text":"ask"}}
{"i":1,"item":{"kind":"text","text":"options","done":true}}
{"i":2,"item":{"kind":"end","point":"p1"}}
{"i":3,"item":{"kind":"user","text":"redis"}}
{"i":4,"item":{"kind":"text","text":"looking","done":true}}
{"i":5,"item":{"kind":"tool","toolId":"t1","name":"Read","result":"ok"}}
{"i":6,"item":{"kind":"text","text":"lua","done":true}}
{"i":7,"item":{"kind":"end","point":"p2"}}
`
	exBranchItems = `{"i":0,"item":{"kind":"user","text":"ask"}}
{"i":1,"item":{"kind":"text","text":"options","done":true}}
{"i":2,"item":{"kind":"end","point":"p1"}}
{"i":3,"item":{"kind":"user","text":"memory"}}
{"i":4,"item":{"kind":"text","text":"map","done":true}}
{"i":5,"item":{"kind":"end"}}
`
	exTree = `{"branches":[{"id":"a1b2c3d4","from":"main","at":3}],"labels":[{"branch":"main","item":1,"text":"options"},{"branch":"a1b2c3d4","item":3,"text":"mem"}],"current":"a1b2c3d4"}`
	exView = `{
  "current": "a1b2c3d4",
  "branches": [
    {"id": "main", "at": 0, "len": 8, "items": [
      {"i": 0, "kind": "user", "text": "ask", "before": 0, "ok": true},
      {"i": 1, "kind": "text", "text": "options", "done": true, "end": 3, "ok": true},
      {"i": 3, "kind": "user", "text": "redis", "before": 3, "ok": true},
      {"i": 4, "kind": "text", "text": "looking", "done": true},
      {"i": 6, "kind": "text", "text": "lua", "done": true, "end": 8, "ok": true}
    ]},
    {"id": "a1b2c3d4", "from": "main", "at": 3, "len": 6, "items": [
      {"i": 3, "kind": "user", "text": "memory", "before": 3, "ok": true},
      {"i": 4, "kind": "text", "text": "map", "done": true, "end": 6}
    ]}
  ],
  "labels": [
    {"branch": "main", "item": 1, "text": "options"},
    {"branch": "a1b2c3d4", "item": 3, "text": "mem"}
  ]
}`
)

// exampleChat puts a Claude chat holding the worked example on disk, with tree as its tree.json
// ("" = none), and loads it as a restart does: nothing of it is read until a route asks.
func (e *env) exampleChat(tree string) string {
	e.t.Helper()
	const id = "c-example"
	dir := e.st.P.ChatDir(id)
	branch := filepath.Join(dir, "branches", "a1b2c3d4")
	if err := os.MkdirAll(branch, 0o700); err != nil {
		e.t.Fatal(err)
	}
	meta, _ := json.Marshal(model.ChatMeta{ID: id, Agent: model.Claude, Group: model.Ungrouped, Created: time.Now()})
	files := map[string]string{
		filepath.Join(dir, "chat.json"):      string(meta),
		filepath.Join(dir, "items.jsonl"):    exMainItems,
		filepath.Join(branch, "items.jsonl"): exBranchItems,
	}
	if tree != "" {
		files[filepath.Join(dir, "tree.json")] = tree
	}
	for path, text := range files {
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			e.t.Fatal(err)
		}
	}
	if err := e.a.Chats.Load(); err != nil {
		e.t.Fatal(err)
	}
	return id
}

func TestChatTree(t *testing.T) {
	e := newEnv(t)
	id := e.exampleChat(exTree)
	// A GET: no client header needed.
	code, out := e.doAs("", "GET", "/api/chats/"+id+"/tree", "")
	if code != 200 {
		t.Fatalf("tree: %d %s", code, out)
	}
	if got, want := decode[any](t, out), decode[any](t, exView); !reflect.DeepEqual(got, want) {
		t.Fatalf("tree\n got %v\nwant %v", got, want)
	}

	// No tree.json: one branch, no labels.
	c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	got := decode[any](t, e.expect(200, "GET", "/api/chats/"+c.ID+"/tree", ""))
	want := decode[any](t, `{"current":"main","branches":[{"id":"main","at":0,"len":0,"items":[]}],"labels":[]}`)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tree of a new chat %v", got)
	}
}

// branchedChat is exampleChat with its tree record and the branch a1b2c3d4 complete: its own
// chat.json and one subagent. The branch is registered and current.
func (e *env) branchedChat() string {
	e.t.Helper()
	const id = "c-example"
	branch := e.st.P.ChatDir(id + "/branches/a1b2c3d4")
	sub := filepath.Join(branch, "subagents", "s1")
	if err := os.MkdirAll(sub, 0o700); err != nil {
		e.t.Fatal(err)
	}
	meta, _ := json.Marshal(model.ChatMeta{ID: id + "/branches/a1b2c3d4", Agent: model.Claude, Cwd: e.a.DefaultCwd,
		Created: time.Now(), Token: "branch-token", SessionID: "ses-branch", Locked: true})
	sa, _ := json.Marshal(model.Subagent{ID: "s1", Status: model.SubCompleted})
	files := map[string]string{
		filepath.Join(branch, "chat.json"):  string(meta),
		filepath.Join(sub, "subagent.json"): string(sa),
		filepath.Join(sub, "items.jsonl"):   `{"i":0,"item":{"kind":"text","text":"found it","done":true}}` + "\n",
	}
	for path, text := range files {
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			e.t.Fatal(err)
		}
	}
	return e.exampleChat(exTree)
}

func TestChatItemsOfABranch(t *testing.T) {
	e := newEnv(t)
	id := e.branchedChat()
	type answer struct {
		Branch    string
		Version   int
		Items     []model.Item
		Subagents []model.Subagent
		State     model.BranchState
	}
	path := "/api/chats/" + id + "/items"

	// Without the query: the current branch. "state" is the state record of the branch served.
	got := decode[answer](t, e.expect(200, "GET", path, ""))
	if got.Branch != "a1b2c3d4" || len(got.Items) != 6 || got.Items[3].Text != "memory" || len(got.Subagents) != 1 {
		t.Fatalf("items of the current branch %+v", got)
	}
	ofBranch := model.BranchState{Chat: id, Branch: "a1b2c3d4", Cwd: e.a.DefaultCwd, Locked: true, Status: model.StatusReady}
	if !reflect.DeepEqual(got.State, ofBranch) {
		t.Fatalf("state of the current branch %+v, want %+v", got.State, ofBranch)
	}
	got = decode[answer](t, e.expect(200, "GET", path+"?branch=main", ""))
	if got.Branch != "main" || len(got.Items) != 8 || got.Items[3].Text != "redis" || len(got.Subagents) != 0 {
		t.Fatalf("items of main %+v", got)
	}
	if st := got.State; st.Chat != id || st.Branch != "main" || st.Locked || st.Status != model.StatusReady {
		t.Fatalf("state of main %+v", st)
	}
	got = decode[answer](t, e.expect(200, "GET", path+"?branch=a1b2c3d4", ""))
	if got.Branch != "a1b2c3d4" || len(got.Items) != 6 || !reflect.DeepEqual(got.State, ofBranch) {
		t.Fatalf("items of the branch %+v", got)
	}
	// The record's keys are the wire names.
	raw, _ := decode[map[string]any](t, e.expect(200, "GET", path+"?branch=a1b2c3d4", ""))["state"].(map[string]any)
	for _, k := range []string{"chat", "branch", "cwd", "model", "locked", "usage", "status"} {
		if _, ok := raw[k]; !ok {
			t.Fatalf("state without %q: %v", k, raw)
		}
	}
	if out := e.expect(404, "GET", path+"?branch=nope", ""); !strings.Contains(out, chats.ErrNoBranch.Error()) {
		t.Fatalf("error body %s", out)
	}
	e.expect(404, "GET", "/api/chats/nope/items?branch=main", "")
	// A branch's server id is no chat id, however it is written.
	e.expect(404, "GET", "/api/chats/"+id+"%2Fbranches%2Fa1b2c3d4/items", "")

	// The view is the chat's, naming its current branch.
	v := decode[map[string]any](t, e.expect(200, "GET", "/api/chats/"+id, ""))
	if v["id"] != id || v["branches"] != 2.0 || v["branch"] != "a1b2c3d4" || v["locked"] != true {
		t.Fatalf("view %v", v)
	}

	// A subagent's thread, by branch.
	sub := "/api/chats/" + id + "/subagents/s1/items"
	thread := decode[answer](t, e.expect(200, "GET", sub, ""))
	if len(thread.Items) != 1 || thread.Items[0].Text != "found it" {
		t.Fatalf("subagent items %+v", thread)
	}
	e.expect(200, "GET", sub+"?branch=a1b2c3d4", "")
	e.expect(404, "GET", sub+"?branch=main", "")
	e.expect(404, "GET", sub+"?branch=nope", "")

	// An unsplit chat serves main, and its view names no branch.
	c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	got = decode[answer](t, e.expect(200, "GET", "/api/chats/"+c.ID+"/items", ""))
	if got.Branch != "main" || got.Items == nil || got.Subagents == nil {
		t.Fatalf("items of an unsplit chat %+v", got)
	}
	if st := got.State; st.Chat != c.ID || st.Branch != "main" || st.Model != c.Model || st.Cwd != c.Cwd || st.Status != model.StatusReady {
		t.Fatalf("state of an unsplit chat %+v", st)
	}
	e.expect(200, "GET", "/api/chats/"+c.ID+"/items?branch=main", "")
	e.expect(404, "GET", "/api/chats/"+c.ID+"/items?branch=a1b2c3d4", "")
	plain := decode[map[string]any](t, e.expect(200, "GET", "/api/chats/"+c.ID, ""))
	if _, ok := plain["branches"]; ok {
		t.Fatalf("view of an unsplit chat %v", plain)
	}
	if _, ok := plain["branch"]; ok {
		t.Fatalf("view of an unsplit chat %v", plain)
	}
}

// A message goes to the current branch, and the MCP status lists a branch's agent under the
// chat's id.
func TestBranchedChatSendAndMCPStatus(t *testing.T) {
	e := newEnv(t)
	id := e.branchedChat()
	// The answer names the branch the message was put on: the current one.
	if out := e.expect(200, "POST", "/api/chats/"+id+"/messages", `{"text":"more"}`); !reflect.DeepEqual(decode[any](t, out), map[string]any{"ok": true, "branch": "a1b2c3d4"}) {
		t.Fatalf("answer %s", out)
	}
	type answer struct {
		Branch string
		Items  []model.Item
	}
	got := decode[answer](t, e.expect(200, "GET", "/api/chats/"+id+"/items", ""))
	if got.Branch != "a1b2c3d4" || len(got.Items) != 7 || got.Items[6].Text != "more" {
		t.Fatalf("items of the current branch %+v", got)
	}
	if main := decode[answer](t, e.expect(200, "GET", "/api/chats/"+id+"/items?branch=main", "")); len(main.Items) != 8 {
		t.Fatalf("items of main %+v", main)
	}
	// Busy, with the code, for the branch that works: named or, as the current one, not.
	for _, q := range []string{"", "?branch=a1b2c3d4"} {
		out := decode[map[string]string](t, e.expect(409, "POST", "/api/chats/"+id+"/messages"+q, `{"text":"again"}`))
		if !reflect.DeepEqual(out, map[string]string{"error": chats.ErrBusy.Error(), "code": "busy"}) {
			t.Fatalf("busy with %q: %v", q, out)
		}
	}
	// A branch the chat does not have is 404 also while another one works.
	if out := e.expect(404, "POST", "/api/chats/"+id+"/messages?branch=nope", `{"text":"again"}`); !strings.Contains(out, chats.ErrNoBranch.Error()) {
		t.Fatalf("error body %s", out)
	}
	if got := e.thread(id, ""); got.Branch != "a1b2c3d4" || len(got.Items) != 7 || got.State.Status != model.StatusThinking {
		t.Fatalf("the current branch after refused Sends %+v", got)
	}

	req := httptest.NewRequest("POST", "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"claude","version":"1"}}}`))
	req.Header.Set("Authorization", "Bearer branch-token")
	w := httptest.NewRecorder()
	e.s.Relay.ServeFixedMCP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST /mcp: status %d (%s)", w.Code, w.Body)
	}
	st := decode[mcpStatus](t, e.expect(200, "GET", "/api/mcp/status", ""))
	if len(st.Chats) != 1 || st.Chats[0].Chat != id[:8] || st.Chats[0].Client != "claude" {
		t.Fatalf("contacts %+v", st.Chats)
	}
}

func TestChatLabel(t *testing.T) {
	e := newEnv(t)
	id := e.exampleChat(`{"branches":[{"id":"a1b2c3d4","from":"main","at":3}],"current":"a1b2c3d4"}`)
	path := "/api/chats/" + id + "/label"
	treeFile := filepath.Join(e.st.P.ChatDir(id), "tree.json")
	type answer struct{ Labels []model.TreeLabel }
	stored := func() []model.TreeLabel {
		t.Helper()
		raw, err := os.ReadFile(treeFile)
		if err != nil {
			t.Fatal(err)
		}
		return decode[model.Tree](t, string(raw)).Labels
	}

	// The label is kept under the item's owner, trimmed; the answer lists all labels.
	onMain := model.TreeLabel{Branch: "main", Item: 1, Text: "options"}
	got := decode[answer](t, e.expect(200, "PUT", path, `{"branch":"a1b2c3d4","item":1,"text":" options "}`))
	if !reflect.DeepEqual(got.Labels, []model.TreeLabel{onMain}) || !reflect.DeepEqual(stored(), got.Labels) {
		t.Fatalf("labels %+v, stored %+v", got.Labels, stored())
	}
	got = decode[answer](t, e.expect(200, "PUT", path, `{"branch":"a1b2c3d4","item":3,"text":"mem"}`))
	if want := []model.TreeLabel{onMain, {Branch: "a1b2c3d4", Item: 3, Text: "mem"}}; !reflect.DeepEqual(got.Labels, want) {
		t.Fatalf("labels %+v", got.Labels)
	}
	if tv := decode[model.TreeView](t, e.expect(200, "GET", "/api/chats/"+id+"/tree", "")); !reflect.DeepEqual(tv.Labels, got.Labels) {
		t.Fatalf("tree labels %+v", tv.Labels)
	}

	// Refused labels write nothing.
	before, err := os.ReadFile(treeFile)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range []struct {
		code int
		body string
	}{
		{404, `{"branch":"ffffffff","item":1,"text":"x"}`},
		{404, `{"item":1,"text":"x"}`},
		{400, `{"branch":"main","item":5,"text":"x"}`},     // a tool call
		{400, `{"branch":"main","item":7,"text":"x"}`},     // an end mark
		{400, `{"branch":"main","item":8,"text":"x"}`},     // no such item
		{400, `{"branch":"a1b2c3d4","item":6,"text":"x"}`}, // no such item in that branch
		{400, `{"branch":"main","text":"x"}`},
		{400, `{"branch":"main","item":6,"text":"` + strings.Repeat("x", 201) + `"}`},     // too long
		{400, `{"branch":"main","item":1,"text":"` + strings.Repeat("x", 200_000) + `"}`}, // too long, on a labeled message
		{400, `not json`},
	} {
		if out := decode[map[string]string](t, e.expect(r.code, "PUT", path, r.body)); out["error"] == "" {
			t.Fatalf("%s: no error text", r.body)
		}
	}
	if out := e.expect(400, "PUT", path, `{"branch":"main","item":6,"text":"`+strings.Repeat("é", 201)+`"}`); !strings.Contains(out, chats.ErrLongLabel.Error()) {
		t.Fatalf("error body %s", out)
	}
	e.expect(200, "PUT", path, `{"branch":"main","item":6,"text":"`+strings.Repeat("é", 200)+`"}`)
	e.expect(200, "PUT", path, `{"branch":"main","item":6,"text":""}`)
	// A mutation: only a known client may make it.
	for _, client := range []string{"", "B"} {
		code, out := e.doAs(client, "PUT", path, `{"branch":"main","item":6,"text":"lua"}`)
		if code != 409 || decode[map[string]string](t, out)["error"] != "unknown_client" {
			t.Fatalf("client %q: %d %s", client, code, out)
		}
	}
	if after, err := os.ReadFile(treeFile); err != nil || string(after) != string(before) {
		t.Fatalf("tree.json changed by a refused label: %s %v", after, err)
	}

	// A label is kept as one clean line: control characters become spaces.
	got = decode[answer](t, e.expect(200, "PUT", path, `{"branch":"main","item":1,"text":"a\nb\u0000c\u001b[31m\t"}`))
	if want := (model.TreeLabel{Branch: "main", Item: 1, Text: "a b c [31m"}); got.Labels[0] != want || stored()[0] != want {
		t.Fatalf("labels %+v, stored %+v", got.Labels, stored())
	}

	// Blank text removes; "labels" is [] when none is left.
	e.expect(200, "PUT", path, `{"branch":"main","item":1,"text":""}`)
	out := e.expect(200, "PUT", path, `{"branch":"a1b2c3d4","item":3,"text":"  "}`)
	if !reflect.DeepEqual(decode[any](t, out), map[string]any{"labels": []any{}}) {
		t.Fatalf("answer %s", out)
	}
	if len(stored()) != 0 {
		t.Fatalf("stored %+v", stored())
	}

	// An archived chat can still be labeled.
	e.expect(200, "POST", "/api/chats/"+id+"/archive", "")
	e.expect(409, "POST", "/api/chats/"+id+"/messages", `{"text":"hi"}`)
	e.expect(200, "PUT", path, `{"branch":"main","item":1,"text":"options"}`)

	// A tree record that cannot be read is not written over.
	bad := `{"branches":`
	if err := os.WriteFile(treeFile, []byte(bad), 0o600); err != nil {
		t.Fatal(err)
	}
	e.expect(500, "PUT", path, `{"branch":"main","item":1,"text":"x"}`)
	tv := decode[model.TreeView](t, e.expect(200, "GET", "/api/chats/"+id+"/tree", ""))
	if len(tv.Branches) != 1 || tv.Current != "main" || len(tv.Labels) != 0 {
		t.Fatalf("tree with an unreadable record %+v", tv)
	}
	if after, err := os.ReadFile(treeFile); err != nil || string(after) != bad {
		t.Fatalf("unreadable tree.json changed: %s %v", after, err)
	}
}

// ---- usage ----------------------------------------------------------------

func TestChatFork(t *testing.T) {
	e := newEnv(t)
	id := e.exampleChat(exTree)
	path := "/api/chats/" + id + "/fork"

	// Fork to new: the answer is the new chat's view, and the chat is listed.
	v := decode[model.ChatView](t, e.expect(200, "POST", path, `{"branch":"main","at":3}`))
	if v.ID == "" || v.ID == id || v.Name != "ask (fork)" || !v.Locked || v.ForkedFrom != id || v.ForkedFromTitle != "ask" ||
		v.ForkedBranch != "main" || v.ForkedAt != 3 || v.Agent != model.Claude || v.Group != model.Ungrouped || v.Draft != nil {
		t.Fatalf("fork %+v", v)
	}
	if got := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+v.ID, "")); !reflect.DeepEqual(got, v) {
		t.Fatalf("the fork's view %+v, answered %+v", got, v)
	}
	items := decode[struct{ Items []model.Item }](t, e.expect(200, "GET", "/api/chats/"+v.ID+"/items", ""))
	if len(items.Items) != 3 || items.Items[2].Point != "p1" {
		t.Fatalf("the fork's items %+v", items.Items)
	}
	// The labels of the copied path come back from its tree route.
	tv := decode[model.TreeView](t, e.expect(200, "GET", "/api/chats/"+v.ID+"/tree", ""))
	if want := []model.TreeLabel{{Branch: "main", Item: 1, Text: "options"}}; !reflect.DeepEqual(tv.Labels, want) || len(tv.Branches) != 1 {
		t.Fatalf("the fork's tree %+v", tv)
	}

	// Fork and edit: the message is the new chat's draft.
	edit := decode[model.ChatView](t, e.expect(200, "POST", path, `{"branch":"main","at":3,"message":3}`))
	if edit.Draft == nil || edit.Draft.Text != "redis" || !edit.Locked {
		t.Fatalf("fork and edit %+v", edit)
	}
	first := decode[model.ChatView](t, e.expect(200, "POST", path, `{"branch":"main","at":0,"message":0}`))
	if first.Draft == nil || first.Draft.Text != "ask" || first.Locked {
		t.Fatalf("fork and edit of the first message %+v", first)
	}

	// 400: no point there, a message that does not follow the point, a broken body.
	for _, body := range []string{`{"branch":"main","at":4}`, `{"branch":"main","at":9}`, `{"branch":"main","at":3,"message":1}`,
		`{"branch":"main","at":0,"message":3}`, `{"branch":"main","at":"3"}`, `{`} {
		e.expect(400, "POST", path, body)
	}
	// 400: "at" is required; without it nothing is forked from the start of the chat.
	before := len(e.a.Chats.Views())
	for _, body := range []string{`{"branch":"main"}`, `{"branch":"main","at":null}`, `{"branch":"main","message":0}`, `{}`} {
		if out := e.expect(400, "POST", path, body); !strings.Contains(out, "at is missing") {
			t.Fatalf("%s: error body %s", body, out)
		}
	}
	if n := len(e.a.Chats.Views()); n != before {
		t.Fatalf("%d chats after forks without a point, %d before", n, before)
	}
	if out := e.expect(400, "POST", path, `{"branch":"main","at":4}`); !strings.Contains(out, chats.ErrBadPoint.Error()) {
		t.Fatalf("error body %s", out)
	}
	// 404: unknown chat, unknown branch.
	e.expect(404, "POST", "/api/chats/nope/fork", `{"branch":"main","at":3}`)
	e.expect(404, "POST", path, `{"branch":"nope","at":3}`)
	e.expect(404, "POST", path, `{"at":3}`)
	// A mutation: only the active client may ask.
	if code, _ := e.doAs("B", "POST", path, `{"branch":"main","at":3}`); code != 409 {
		t.Fatalf("fork by another client: %d", code)
	}

	// 500 with the provider's text when the fork start fails; nothing is created.
	before = len(e.a.Chats.Views())
	e.a.Chats.Spawners[model.Claude] = fakeSpawner{forkErr: errors.New("No conversation found")}
	if out := e.expect(500, "POST", path, `{"branch":"main","at":3}`); !strings.Contains(out, "No conversation found") {
		t.Fatalf("error body %s", out)
	}
	if n := len(e.a.Chats.Views()); n != before {
		t.Fatalf("%d chats after a failed fork, %d before", n, before)
	}
	e.a.Chats.Spawners[model.Claude] = fakeSpawner{}

	// 409: busy (the end of a chat whose turn is running), archived.
	e.expect(200, "POST", "/api/chats/"+v.ID+"/messages", `{"text":"hi"}`)
	e.expect(409, "POST", "/api/chats/"+v.ID+"/fork", `{"branch":"main","at":4}`)
	e.expect(200, "POST", "/api/chats/"+id+"/archive", "")
	e.expect(409, "POST", path, `{"branch":"main","at":3}`)
}

func TestChatSendWithTarget(t *testing.T) {
	e := newEnv(t)
	id := e.exampleChat("")
	path := "/api/chats/" + id + "/messages"
	treeFile := filepath.Join(e.st.P.ChatDir(id), "tree.json")
	type answer struct {
		Branch string
		Items  []model.Item
	}
	target := func(tg string) string { return `{"text":"another way","target":` + tg + `}` }

	// 400: no point there, a quote of what the new branch lacks, a broken target.
	for _, body := range []string{
		target(`{"branch":"main","at":4,"new":true}`),
		target(`{"branch":"main","at":4}`),
		target(`{"branch":"main","at":9}`),
		target(`{"branch":"main","at":-1,"new":true}`),
		`{"text":"x","references":[{"item":4,"quote":"looking"}],"target":{"branch":"main","at":3}}`,
		`{"text":"x","references":[{"item":8,"quote":"lua"}],"target":{"branch":"main","at":8}}`,
		target(`{"branch":"main","at":"3"}`),
		target(`3`),
	} {
		if out := decode[map[string]string](t, e.expect(400, "POST", path, body)); out["error"] == "" {
			t.Fatalf("%s: no error text", body)
		}
	}
	bad := decode[map[string]string](t, e.expect(400, "POST", path, target(`{"branch":"main","at":4}`)))
	if !reflect.DeepEqual(bad, map[string]string{"error": chats.ErrBadPoint.Error(), "code": "bad_point"}) {
		t.Fatalf("error body %v", bad)
	}
	// 400: a target together with ?branch=. An empty ?branch= is none.
	for _, q := range []string{"?branch=main", "?branch=nope"} {
		out := decode[map[string]string](t, e.expect(400, "POST", path+q, target(`{"branch":"main","at":3}`)))
		if !reflect.DeepEqual(out, map[string]string{"error": "branch and target together"}) {
			t.Fatalf("target with %s: %v", q, out)
		}
	}
	if out := e.expect(400, "POST", path+"?branch=", target(`{"branch":"main","at":4}`)); !strings.Contains(out, chats.ErrBadPoint.Error()) {
		t.Fatalf("error body %s", out)
	}
	// 400: a target's "at" is required; without it no branch starts at the start of the chat.
	for _, tg := range []string{`{"branch":"main"}`, `{"branch":"main","new":true}`, `{"branch":"main","at":null,"new":true}`, `{}`} {
		if out := e.expect(400, "POST", path, target(tg)); !strings.Contains(out, "at is missing") {
			t.Fatalf("%s: error body %s", tg, out)
		}
	}
	// 404: unknown chat, unknown branch.
	e.expect(404, "POST", "/api/chats/nope/messages", target(`{"branch":"main","at":3}`))
	if out := e.expect(404, "POST", path, target(`{"branch":"nope","at":3}`)); !strings.Contains(out, chats.ErrNoBranch.Error()) {
		t.Fatalf("error body %s", out)
	}
	e.expect(404, "POST", path, target(`{"at":3}`))
	// A mutation: only the active client may ask.
	if code, _ := e.doAs("B", "POST", path, target(`{"branch":"main","at":3}`)); code != 409 {
		t.Fatalf("a Send with a target by another client: %d", code)
	}
	// 500 with the provider's text when the fork start fails.
	e.a.Chats.Spawners[model.Claude] = fakeSpawner{forkErr: errors.New("No conversation found")}
	if out := e.expect(500, "POST", path, target(`{"branch":"main","at":3}`)); !strings.Contains(out, "No conversation found") {
		t.Fatalf("error body %s", out)
	}
	e.a.Chats.Spawners[model.Claude] = fakeSpawner{}

	// None of them made a branch or added a message.
	if _, err := os.Stat(treeFile); !os.IsNotExist(err) {
		t.Fatalf("tree.json after refused Sends: %v", err)
	}
	// (The example has a branches/ folder its record does not name: it is left alone.)
	if ents, err := os.ReadDir(filepath.Join(e.st.P.ChatDir(id), "branches")); err != nil || len(ents) != 1 {
		t.Fatalf("the branches folder after refused Sends: %v (%v)", ents, err)
	}
	if got := decode[answer](t, e.expect(200, "GET", "/api/chats/"+id+"/items", "")); got.Branch != "main" || len(got.Items) != 8 {
		t.Fatalf("items after refused Sends %+v", got)
	}

	// Something lies after the point: a new branch, which is the current one from now on.
	out := e.expect(200, "POST", path, `{"text":"another way","references":[{"item":1,"quote":"options"}],"target":{"branch":"main","at":3}}`)
	v := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+id, ""))
	if v.ID != id || v.Branches != 2 || len(v.Branch) != 8 || v.Status != model.StatusThinking {
		t.Fatalf("view %+v", v)
	}
	// The answer names the new branch.
	if !reflect.DeepEqual(decode[any](t, out), map[string]any{"ok": true, "branch": v.Branch}) {
		t.Fatalf("answer %s, the new branch is %q", out, v.Branch)
	}
	got := decode[answer](t, e.expect(200, "GET", "/api/chats/"+id+"/items", ""))
	if got.Branch != v.Branch || len(got.Items) != 4 || got.Items[3].Text != "another way" || got.Items[2].Point != "p1" ||
		!reflect.DeepEqual(got.Items[3].References, []model.Reference{{Item: 1, Quote: "options"}}) {
		t.Fatalf("items of the new branch %+v", got)
	}
	if main := decode[answer](t, e.expect(200, "GET", "/api/chats/"+id+"/items?branch=main", "")); len(main.Items) != 8 {
		t.Fatalf("items of main %+v", main)
	}
	tv := decode[model.TreeView](t, e.expect(200, "GET", "/api/chats/"+id+"/tree", ""))
	if tv.Current != v.Branch || len(tv.Branches) != 2 || tv.Branches[1].ID != v.Branch || tv.Branches[1].From != "main" ||
		tv.Branches[1].At != 3 || tv.Branches[1].Len != 4 {
		t.Fatalf("tree %+v", tv)
	}

	// 409: busy, for the branch that works: its end as a target, and no target (it is the
	// current branch). A point in its running turn is no point for a new branch (400), and an
	// unknown branch is 404 all the same.
	for _, tg := range []string{`{"branch":"` + v.Branch + `","at":4}`, `null`} {
		out := decode[map[string]string](t, e.expect(409, "POST", path, target(tg)))
		if !reflect.DeepEqual(out, map[string]string{"error": chats.ErrBusy.Error(), "code": "busy"}) {
			t.Fatalf("busy with the target %s: %v", tg, out)
		}
	}
	bad = decode[map[string]string](t, e.expect(400, "POST", path, target(`{"branch":"`+v.Branch+`","at":4,"new":true}`)))
	if !reflect.DeepEqual(bad, map[string]string{"error": chats.ErrBadPoint.Error(), "code": "bad_point"}) {
		t.Fatalf("a new branch in the running turn: %v", bad)
	}
	if out := e.expect(404, "POST", path, target(`{"branch":"nope","at":3}`)); !strings.Contains(out, chats.ErrNoBranch.Error()) {
		t.Fatalf("error body %s", out)
	}
	// The other branch is not busy with it: a second branch starts at a finished boundary of
	// main while the first one works, and both work.
	out = e.expect(200, "POST", path, target(`{"branch":"main","at":3,"new":true}`))
	second := decode[map[string]any](t, out)["branch"]
	v2 := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+id, ""))
	if second == v.Branch || second != v2.Branch || v2.Branches != 3 || v2.Working != 2 {
		t.Fatalf("answer %s, view %+v", out, v2)
	}
	e.expect(200, "POST", "/api/chats/"+id+"/archive", "")
	e.expect(409, "POST", path, target(`{"branch":"main","at":8}`))

	// Without a target the route is what it was; the end of an unsplit chat's only branch is no
	// new branch either.
	c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	for i, body := range []string{`{"text":"hi"}`, target(`{"branch":"main","at":0}`), target(`null`)} {
		c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
		out := e.expect(200, "POST", "/api/chats/"+c.ID+"/messages", body)
		if !reflect.DeepEqual(decode[any](t, out), map[string]any{"ok": true, "branch": "main"}) {
			t.Fatalf("answer %d: %s", i, out)
		}
		if _, err := os.Stat(filepath.Join(e.st.P.ChatDir(c.ID), "tree.json")); !os.IsNotExist(err) {
			t.Fatalf("tree.json of an unsplit chat: %v", err)
		}
		plain := decode[map[string]any](t, e.expect(200, "GET", "/api/chats/"+c.ID, ""))
		if _, ok := plain["branches"]; ok || plain["locked"] != true {
			t.Fatalf("view of an unsplit chat %v", plain)
		}
		// The same again, while the turn runs: the end of the branch is busy, and the start of
		// a chat whose first turn has not ended is no point for a new branch.
		again := 409
		if i == 1 {
			again = 400
		}
		e.expect(again, "POST", "/api/chats/"+c.ID+"/messages", body)
	}
	e.expect(400, "POST", "/api/chats/"+c.ID+"/messages", target(`{"branch":"main","at":0,"new":true}`))
}

func TestUsage(t *testing.T) {
	e := newEnv(t)
	e.expect(404, "GET", "/api/usage/claude", "") // no Usage set

	var gotFresh []bool
	var err error
	e.s.Usage = map[model.AgentKind]func(bool) (model.PlanUsage, error){
		model.Claude: func(fresh bool) (model.PlanUsage, error) {
			gotFresh = append(gotFresh, fresh)
			return model.PlanUsage{Plan: true, Limits: []model.UsageLimit{{Kind: "session", Label: "Current session", Percent: 8}}}, err
		},
		model.Cursor: func(bool) (model.PlanUsage, error) {
			return model.PlanUsage{Plan: true, Limits: []model.UsageLimit{{Kind: "individual.overall", Percent: 37.5, Detail: "$413.89 of $1,101"}}}, nil
		},
	}
	u := decode[model.PlanUsage](t, e.expect(200, "GET", "/api/usage/claude", ""))
	if !u.Plan || len(u.Limits) != 1 || u.Limits[0].Percent != 8 {
		t.Fatalf("usage %+v", u)
	}
	e.expect(200, "GET", "/api/usage/claude?fresh=1", "")
	c := decode[model.PlanUsage](t, e.expect(200, "GET", "/api/usage/cursor", ""))
	if len(c.Limits) != 1 || c.Limits[0].Detail != "$413.89 of $1,101" {
		t.Fatalf("cursor usage %+v", c)
	}
	e.expect(404, "GET", "/api/usage/other", "")
	if len(gotFresh) != 2 || gotFresh[0] || !gotFresh[1] {
		t.Fatalf("fresh %v", gotFresh)
	}

	err = errors.New("claude /usage: not logged in")
	out := decode[map[string]string](t, e.expect(500, "GET", "/api/usage/claude", ""))
	if out["error"] != "claude /usage: not logged in" {
		t.Fatalf("error %v", out)
	}
}
