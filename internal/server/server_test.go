package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
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

// ---- environment ----------------------------------------------------------

const clientID = "A"

type env struct {
	t   *testing.T
	st  *store.Store
	a   *app.App
	s   *Server
	url string
}

func newEnv(t *testing.T) *env {
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
		DefaultCwd: t.TempDir(), BaseURL: "http://127.0.0.1:" + itoa(port)})
	a = &app.App{St: st, Boards: bds, Chats: cm, Bridge: br, DataDir: root, DefaultCwd: cm.DefaultCwd}
	s := &Server{App: a, Relay: &boardapi.Relay{Bridge: br, Chats: cm, Boards: bds}, Bridge: br, Port: port}
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

func TestNoStaticClientWhenUnset(t *testing.T) {
	e := newEnv(t)
	code, _ := e.do("GET", "/", "")
	if code != 404 {
		t.Fatalf("GET / status %d, want 404", code)
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
