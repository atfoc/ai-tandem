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
type fakeSpawner struct{}

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

// connect opens /api/events as clientID and waits until it is the active client.
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
			if json.Unmarshal([]byte(line), &ev) == nil && ev["type"] == "hello" && ev["active"] == true && !done {
				done = true
				close(active)
			}
		}
	}()
	select {
	case <-active:
	case <-time.After(2 * time.Second):
		e.t.Fatal("client not active")
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
	post("Bearer "+token, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}`)
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
		known.Method != "tools/call" || known.Tool != "list_boards" || known.Outcome != "error" || known.At.IsZero() {
		t.Fatalf("known contact %+v", *known)
	}
}

func TestMutationsNeedTheActiveClient(t *testing.T) {
	e := newEnv(t)
	for _, client := range []string{"", "B"} {
		code, out := e.doAs(client, "POST", "/api/boards", `{"group":"__ungrouped__"}`)
		if code != 409 || decode[map[string]string](t, out)["error"] != "not_active" {
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
	// Client routes check the client in the body or header instead.
	if code, _ := e.doAs("", "POST", "/api/rpc-reply", `{"id":"rpc_1","client":"B"}`); code != 409 {
		t.Fatalf("rpc-reply from B: %d", code)
	}
	if code, _ := e.doAs("", "POST", "/api/rpc-reply", `{"id":"rpc_1","client":"A"}`); code != 200 {
		t.Fatalf("rpc-reply from A: %d", code)
	}
	if code, _ := e.doAs("B", "POST", "/api/client/flushed", ""); code != 409 {
		t.Fatalf("flushed from B: %d", code)
	}
	if code, _ := e.doAs("A", "POST", "/api/client/flushed", ""); code != 200 {
		t.Fatalf("flushed from A: %d", code)
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
	e.expect(200, "PUT", "/api/boards/"+bd.ID+"/scene", scene)
	if got := e.expect(200, "GET", "/api/boards/"+bd.ID+"/scene", ""); got != scene {
		t.Fatalf("scene %s", got)
	}
}

// ---- error mapping --------------------------------------------------------

func TestNotFound(t *testing.T) {
	e := newEnv(t)
	for _, r := range [][3]string{
		{"GET", "/api/boards/b_nope/scene", ""},
		{"PUT", "/api/boards/b_nope/scene", `{}`},
		{"POST", "/api/boards/b_nope/rename", `{"name":"x"}`},
		{"POST", "/api/boards/b_nope/archive", ""},
		{"DELETE", "/api/boards/b_nope", ""},
		{"GET", "/api/chats/nope", ""},
		{"GET", "/api/chats/nope/items", ""},
		{"GET", "/api/chats/nope/context", ""},
		{"GET", "/api/chats/nope/subagents/nope/items", ""},
		{"POST", "/api/chats/nope/messages", `{"text":"hi"}`},
		{"PATCH", "/api/chats/nope", `{"name":"x"}`},
		{"PUT", "/api/chats/nope/draft", `{"text":"x"}`},
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
	e.expect(409, "PUT", "/api/boards/"+bd.ID+"/scene", `{}`)
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
		{"PUT", "/api/boards/" + bd.ID + "/scene", `not json`},
		{"POST", "/api/boards/" + bd.ID + "/rename", `{"name":"  "}`},
		{"PATCH", "/api/boards/" + bd.ID, `{"group":""}`},
		{"PATCH", "/api/boards/" + bd.ID, `{"group":"g_nope"}`},
		{"POST", "/api/chats", `{"agent":"claude","group":""}`},
		{"POST", "/api/chats", `{"agent":"nobody","group":"__ungrouped__"}`},
		{"PATCH", "/api/chats/" + c.ID, `{"group":""}`},
		{"PATCH", "/api/chats/" + c.ID, `{"cwd":"` + notDir + `"}`},
		{"PATCH", "/api/chats/" + c.ID, `{"cwd":"` + e.st.P.Root + `"}`},
		{"PATCH", "/api/chats/" + c.ID, `{"model":"no-such-model"}`},
		{"PUT", "/api/chats/" + c.ID + "/draft", `not json`},
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
	if code, _ := e.doAs("B", "PUT", "/api/chats/"+c.ID+"/draft", `{"text":"x"}`); code != 409 {
		t.Fatalf("draft from B: %d", code)
	}
	e.expect(200, "PUT", "/api/chats/"+c.ID+"/draft", `{"text":"hi @Plan","mentions":[{"name":"Plan","id":"b_1"}]}`)
	v := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+c.ID, ""))
	want := &model.Draft{Text: "hi @Plan", Mentions: []model.Mention{{Name: "Plan", ID: "b_1"}}}
	if !reflect.DeepEqual(v.Draft, want) {
		t.Fatalf("draft %+v", v.Draft)
	}
	e.expect(200, "PUT", "/api/chats/"+c.ID+"/draft", `{"text":""}`)
	if v := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+c.ID, "")); v.Draft != nil {
		t.Fatalf("cleared draft %+v", v.Draft)
	}
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

	e.expect(200, "POST", path, `{"requestId":"p1","subagent":"`+sa.ID+`","allow":true}`)
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

// ---- usage ----------------------------------------------------------------

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
