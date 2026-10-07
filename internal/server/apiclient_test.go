package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/servers"
)

// API clients on the remote listener: the real ServeRemote over TLS on 127.0.0.1, stand-in API
// clients (bridgetest.ConnectWith with the secret and a client id) beside stand-in pages on the
// loopback listener, and stand-in agents. The tests that need no stream ask RemoteHandler.

const (
	// ownID is the instance id of the server under test.
	ownID = "3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c"
	// The ids of three API clients: three other servers' instance ids.
	apiX = testAPIClient
	apiY = "0e5ac1f3-6d2b-4b7a-8f10-9a1b2c3d4e5f"
	apiZ = "5b0c7d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e"
	// Chat ids as a client makes them.
	chat1 = "11111111-1111-4111-8111-111111111111"
	chat2 = "22222222-2222-4222-8222-222222222222"
	chat3 = "33333333-3333-4333-8333-333333333333"
)

// ---- the listener ------------------------------------------------------------

// listener is a remote listener of a test: a port bound on 127.0.0.1, a certificate for that
// address, and an HTTP client that reaches it over HTTP/2.
type listener struct {
	t    *testing.T
	ln   net.Listener
	port int
	host string // the Host its requests carry
	base string
	pair tls.Certificate
	pin  string // the certificate's fingerprint
	http *http.Client

	mu    sync.Mutex
	lines []string // what the listener logged
}

func newListener(t *testing.T) *listener {
	t.Helper()
	certPEM, keyPEM, err := remote.GenerateCert([]string{"127.0.0.1"}, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	pin, err := remote.FingerprintOfPEM(certPEM)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, ForceAttemptHTTP2: true}
	t.Cleanup(tr.CloseIdleConnections)
	host := "127.0.0.1:" + strconv.Itoa(port)
	return &listener{t: t, ln: ln, port: port, host: host, base: "https://" + host, pair: pair, pin: pin, http: &http.Client{Transport: tr}}
}

// set makes s the server of the listener, before the listener serves. It sets what no handler of
// the loopback listener reads unless asked for hello or the remote status.
func (l *listener) set(s *Server) {
	s.Remote = NewRemote(l.port, []string{"127.0.0.1"}, l.pin, testSecret)
	s.Remote.logf = func(format string, args ...any) {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.lines = append(l.lines, fmt.Sprintf(format, args...))
	}
	s.InstanceID = ownID
}

// serve starts ServeRemote, which ends with the test.
func (l *listener) serve(s *Server) {
	done := make(chan error, 1)
	go func() { done <- s.ServeRemote(l.ln, l.pair) }()
	l.t.Cleanup(func() {
		l.ln.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			l.t.Error("ServeRemote did not return after its listener was closed")
		}
	})
}

// logged is what the listener logged so far.
func (l *listener) logged() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return slices.Clone(l.lines)
}

// remoteEnv is an env with a remote listener that serves.
func remoteEnv(t *testing.T, with ...func(*Server)) (*env, *listener) {
	t.Helper()
	l := newListener(t)
	// The consumer (internal/servers) requires a home that is not empty.
	home := func(s *Server) { s.App.Home = "/home/owner" }
	e := newEnv(t, append([]func(*Server){l.set, home}, with...)...)
	l.serve(e.s)
	return e, l
}

// options is how the API client id reaches the listener with this secret.
func (l *listener) options(id, secret string) bridgetest.Options {
	return bridgetest.Options{HTTP: l.http, Header: map[string]string{SecretHeader: secret, ClientHeader: id}}
}

// api connects the API client id and reads its hello and its snapshot, which it returns as sent.
func (l *listener) api(id string) (*bridgetest.Page, string) {
	l.t.Helper()
	c := bridgetest.ConnectWith(l.t, l.base, id, l.options(id, testSecret))
	if h := c.Expect("hello"); h["client"] != id || len(h) != 2 {
		l.t.Fatalf("hello of the API client %s: %v", id, h)
	}
	snap := c.NextRaw()
	if typeOf(snap) != "snapshot" {
		l.t.Fatalf("the API client %s was sent %s after hello", id, snap)
	}
	return c, snap
}

// call is one request of the API client id with this secret and no open stream of its own
// making; id "" sends no client header, secret "" no secret.
func (l *listener) call(id, secret, method, path, body string) (int, string) {
	l.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, l.base+path, strings.NewReader(body))
	if err != nil {
		l.t.Fatal(err)
	}
	if id != "" {
		req.Header.Set(ClientHeader, id)
	}
	if secret != "" {
		req.Header.Set(SecretHeader, secret)
	}
	resp, err := l.http.Do(req)
	if err != nil {
		l.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	if resp.ProtoMajor != 2 {
		l.t.Fatalf("%s %s was answered over %s, want HTTP/2", method, path, resp.Proto)
	}
	// An open stream is not read to its end.
	if resp.StatusCode == 200 && strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		return resp.StatusCode, ""
	}
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// ---- stand-in agents -----------------------------------------------------------

// apiAgent is a permAgent that counts the messages it is sent and may refuse them.
type apiAgent struct {
	permAgent
	sendErr error
	sends   atomic.Int32
}

func (a *apiAgent) Send([]agent.ContentBlock) error {
	a.sends.Add(1)
	return a.sendErr
}

// apiSpawner starts apiAgents and keeps them, in the order they started. With spawnErr set no
// program starts; with sendErr set the programs that start from then on refuse every message.
type apiSpawner struct {
	mu       sync.Mutex
	agents   []*apiAgent
	spawnErr error
	sendErr  error
	opts     []agent.SpawnOptions
}

func (s *apiSpawner) fail(spawnErr, sendErr error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.spawnErr, s.sendErr = spawnErr, sendErr
}

func (s *apiSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.spawnErr != nil {
		return nil, s.spawnErr
	}
	a := &apiAgent{permAgent: permAgent{fakeAgent: fakeAgent{ch: make(chan agent.Event)}, asked: map[string]bool{}}, sendErr: s.sendErr}
	s.agents = append(s.agents, a)
	s.opts = append(s.opts, o)
	return a, nil
}

func (s *apiSpawner) SpawnFork(o agent.SpawnOptions, src agent.ForkSource) (agent.Agent, string, error) {
	a, err := s.Spawn(o)
	return a, o.SessionID, err
}

func (*apiSpawner) DiscardFork(string) {}

func (*apiSpawner) ReadContextSplit(agent.SpawnOptions) (model.ContextSplit, error) {
	return fakeSpawner{}.ReadContextSplit(agent.SpawnOptions{})
}

// count is how many programs started.
func (s *apiSpawner) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.agents)
}

// of waits for the program of this chat that started last.
func (s *apiSpawner) of(t *testing.T, chat string) *apiAgent {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(2 * time.Millisecond) {
		s.mu.Lock()
		for i := len(s.agents) - 1; i >= 0; i-- {
			if s.opts[i].ChatID == chat {
				a := s.agents[i]
				s.mu.Unlock()
				return a
			}
		}
		s.mu.Unlock()
	}
	t.Fatalf("no program started for the chat %s", chat)
	return nil
}

// withAgents makes every Claude and Cursor chat of the server run on sp.
func withAgents(sp *apiSpawner) func(*Server) {
	return func(s *Server) {
		s.App.Chats.Spawners[model.Claude] = sp
		s.App.Chats.Spawners[model.Cursor] = sp
	}
}

// ---- helpers --------------------------------------------------------------------

// started is the answer of a creation call.
type started struct {
	OK      bool            `json:"ok"`
	Started bool            `json:"started"`
	Sent    bool            `json:"sent"`
	Chat    *model.ChatView `json:"chat"`
	Error   string          `json:"error"`
	Code    string          `json:"code"`
}

// startBody is the body of a creation call for a Claude chat; more adds or replaces fields.
func startBody(id, cwd string, more ...any) string {
	body := map[string]any{"id": id, "agent": "claude", "cwd": cwd, "text": "the first message"}
	for i := 0; i+1 < len(more); i += 2 {
		if more[i+1] == nil {
			delete(body, more[i].(string))
			continue
		}
		body[more[i].(string)] = more[i+1]
	}
	raw, _ := json.Marshal(body)
	return string(raw)
}

// start is the creation call of the client c, which must be answered with this status.
func start(t *testing.T, c *bridgetest.Page, want int, body string) started {
	t.Helper()
	status, out := c.Do("POST", "/api/chats", body)
	if status != want {
		t.Fatalf("the creation call of %s: status %d, want %d (%s)", c.ID, status, want, out)
	}
	got := decode[started](t, string(out))
	if (status == 200) != got.OK || (status == 200) != (got.Error == "") {
		t.Fatalf("the creation call of %s: status %d with %s", c.ID, status, out)
	}
	return got
}

var apiMarks atomic.Int64

// reach returns, for each client, the events it was sent and has not read yet, as the server sent
// them. It sends an agents event with a mark of its own, which every client is sent, a page and
// an API client alike, and reads each client up to it: what was sent before the call is in the
// lists, and the event of the mark is not.
func (e *env) reach(clients ...*bridgetest.Page) [][]string {
	e.t.Helper()
	mark := "mark-" + strconv.FormatInt(apiMarks.Add(1), 10)
	e.s.Bridge.Broadcast(map[string]any{"type": "agents", "agents": e.a.Agents.List(), "mark": mark})
	out := make([][]string, len(clients))
	for i, c := range clients {
		for {
			raw := c.NextRaw()
			if typeOf(raw) == "agents" && strings.Contains(raw, mark) {
				break
			}
			out[i] = append(out[i], raw)
		}
	}
	return out
}

// only keeps the events of these types.
func only(evs []string, typs ...string) (out []string) {
	for _, raw := range evs {
		if slices.Contains(typs, typeOf(raw)) {
			out = append(out, raw)
		}
	}
	return out
}

// quiet fails when the client is sent anything within a moment: "this client got nothing".
func quiet(t *testing.T, what string, c *bridgetest.Page) {
	t.Helper()
	if got := c.Drain(150 * time.Millisecond); len(got) != 0 {
		t.Errorf("%s: the client %s was sent %v", what, c.ID, got)
	}
}

// apiOnly fails when an API client was sent an event of a type outside its allow-list, or one
// of the types that tell a page of a board, a group or a role.
func apiOnly(t *testing.T, c *bridgetest.Page, evs []string) {
	t.Helper()
	for _, raw := range evs {
		if typ := typeOf(raw); !editorbridge.APIEvents[typ] {
			t.Errorf("the API client %s was sent %s: %s", c.ID, typ, raw)
		}
	}
}

// keysOf is the keys of a JSON object, sorted.
func keysOf(t *testing.T, raw string) []string {
	t.Helper()
	var keys []string
	for k := range decode[map[string]json.RawMessage](t, raw) {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// remoteGroups is the groups named "Remote" in the state.
func (e *env) remoteGroups() (ids []string) {
	e.st.Read(func(s *model.State) {
		for _, g := range s.Groups {
			if g.Name == "Remote" {
				ids = append(ids, g.ID)
			}
		}
	})
	return ids
}

// ---- the client id (AC38) -------------------------------------------------------

func TestAPIClientID(t *testing.T) {
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	h := e.s.RemoteHandler()
	do := func(client, method, path, body string) *httptest.ResponseRecorder {
		return remoteDoAs(h, client, method, path, l.host, testSecret, body)
	}
	refusedAs := func(w *httptest.ResponseRecorder, what, text, code string) {
		t.Helper()
		if w.Code != 400 || strings.TrimSpace(w.Body.String()) != `{"code":"`+code+`","error":"`+text+`"}` {
			t.Fatalf("%s: %d %s, want 400 %s", what, w.Code, w.Body, code)
		}
	}
	cwd := t.TempDir()

	// No id, and an id of another form: refused on every route, hello included, and on a path
	// outside the table too, before the table is asked.
	v1 := strings.Replace(apiX, "-40de-", "-10de-", 1)
	for _, id := range []string{"", "client-1", strings.ToUpper(apiX), apiX[:35], apiX + "0", "{" + apiX + "}", " " + apiX, v1, strings.ReplaceAll(apiX, "-", "")} {
		for _, rq := range [][2]string{{"GET", "/api/hello"}, {"GET", "/api/state"}, {"GET", "/api/events"}, {"GET", "/api/chats/" + chat1},
			{"POST", "/api/chats"}, {"POST", "/api/chats/" + chat1 + "/messages"}, {"GET", "/api/mcp/status"}, {"GET", "/"}, {"POST", "/api/hello"}} {
			refusedAs(do(id, rq[0], rq[1], startBody(chat1, cwd)), fmt.Sprintf("%s %s with the id %q", rq[0], rq[1], id), "bad client id", "bad_client")
		}
	}
	// An id in the body or in the query is none.
	refusedAs(do("", "POST", "/api/chats?client="+apiX, startBody(chat1, cwd, "client", apiX)), "an id in the body and the query", "bad client id", "bad_client")
	refusedAs(do("", "GET", "/api/events?client="+apiX, ""), "a stream named by the query alone", "bad client id", "bad_client")
	// The stream's query may name the header's id, and no other.
	refusedAs(do(apiX, "GET", "/api/events?client="+apiY, ""), "a stream whose query names another id", "bad client id", "bad_client")
	refusedAs(do(apiX, "GET", "/api/events?client=", ""), "a stream whose query names no id", "bad client id", "bad_client")
	// The secret and the Host come first.
	wantReply(t, remoteDoAs(h, "", "GET", "/api/hello", l.host, "", ""), "no secret and no id", 401, "unauthorized")
	wantReply(t, remoteDoAs(h, "", "GET", "/api/hello", "evil.example:1", testSecret, ""), "another Host and no id", 403, "bad host")
	if _, err := os.Stat(e.st.P.ChatDir(chat1)); err == nil || len(e.remoteGroups()) != 0 {
		t.Fatal("a refused call made a chat or the group")
	}

	// The server's own id: hello answers, every other route refuses it, inside the table and
	// outside.
	w := do(ownID, "GET", "/api/hello", "")
	wantReply(t, w, "hello with the server's own id", 200, "")
	if got := decode[obj](t, w.Body.String()); got["instanceId"] != ownID || got["featureLevel"] != float64(FeatureLevel) {
		t.Fatalf("hello: %v", got)
	}
	for _, p := range append(slices.Clone(RemoteRoutes[1:]), "GET /api/mcp/status", "GET /", "POST /api/hello", "POST /api/runs") {
		method, path, _ := strings.Cut(p, " ")
		path = pathWildcard.ReplaceAllString(path, chat1)
		refusedAs(do(ownID, method, path, startBody(chat1, cwd)), p+" with the server's own id", "this is the server's own id", "own_client")
	}
	if RemoteRoutes[0] != helloRoute {
		t.Fatalf("the table's first route is %q", RemoteRoutes[0])
	}
	if _, err := os.Stat(e.st.P.ChatDir(chat1)); err == nil {
		t.Fatal("a call with the server's own id made a chat")
	}

	// A write needs no open stream, and it makes the caller no known client.
	if status, out := l.call(apiX, testSecret, "POST", "/api/chats", startBody(chat1, cwd)); status != 200 || !decode[started](t, out).Started {
		t.Fatalf("a creation call with no open stream: %d %s", status, out)
	}
	if status, out := l.call(apiX, testSecret, "POST", "/api/chats/"+chat1+"/interrupt", ""); status != 200 {
		t.Fatalf("a stop with no open stream: %d %s", status, out)
	}
	if e.s.Bridge.Known(apiX) {
		t.Fatal("a caller with no stream is a known client")
	}
	// A read with no open stream starts no follow.
	for _, path := range []string{"/items", "/tree"} {
		if status, out := l.call(apiX, testSecret, "GET", "/api/chats/"+chat1+path, ""); status != 200 {
			t.Fatalf("the read of %s with no open stream: %d %s", path, status, out)
		}
	}
	if got := e.s.Bridge.Followers(editorbridge.Chat(chat1)); len(got) != 0 {
		t.Fatalf("followers after reads with no open stream: %v", got)
	}

	// With a stream the read follows. A second stream with the id replaces the first: it ends,
	// and the new one follows nothing.
	x, _ := l.api(apiX)
	if status, out := x.Do("GET", "/api/chats/"+chat1+"/items", nil); status != 200 {
		t.Fatalf("the read: %d %s", status, out)
	}
	if got := e.s.Bridge.Followers(editorbridge.Chat(chat1)); !slices.Equal(got, []string{apiX}) {
		t.Fatalf("followers after the read: %v", got)
	}
	x2, _ := l.api(apiX)
	x.ExpectEnded()
	if got := e.s.Bridge.Followers(editorbridge.Chat(chat1)); len(got) != 0 {
		t.Fatalf("followers after the second stream: %v", got)
	}

	// One id, two kinds: a page's id opens no API stream, an API client's id no page stream,
	// and the stream that was there stays.
	const pageID = "9b2d5c1a-3e4f-4a6b-8c7d-0e1f2a3b4c5d"
	pg := e.page(pageID)
	const inUse = `{"error":"client id in use","code":"client_in_use"}`
	if status, out := l.call(pageID, testSecret, "GET", "/api/events", ""); status != 409 || out != inUse {
		t.Fatalf("an API stream with a connected page's id: %d %s", status, out)
	}
	if status, out := e.doAs("", "GET", "/api/events?client="+apiX, ""); status != 409 || out != inUse {
		t.Fatalf("a page's stream with a connected API client's id: %d %s", status, out)
	}
	// A loopback write that names an API client's id is one of no known client.
	if status, out := e.doAs(apiX, "POST", "/api/chats/"+chat1+"/interrupt", ""); status != 409 || strings.TrimSpace(out) != `{"error":"unknown_client"}` {
		t.Fatalf("a loopback write with an API client's id: %d %s", status, out)
	}
	got := e.reach(pg, x2)
	if len(got[0]) != 0 || len(got[1]) != 0 {
		t.Fatalf("the refused streams sent the page %v and the API client %v", got[0], got[1])
	}
	// The API client's own calls go on: its id is not the page's to act with, nor the reverse.
	if status, out := pg.Do("POST", "/api/chats/"+chat1+"/interrupt", nil); status != 200 {
		t.Fatalf("the page's write: %d %s", status, out)
	}
	if status, out := x2.Do("POST", "/api/chats/"+chat1+"/interrupt", nil); status != 200 {
		t.Fatalf("the API client's write: %d %s", status, out)
	}
	for _, line := range l.logged() {
		if !strings.Contains(line, "refused 401") && !strings.Contains(line, "refused 403") {
			t.Errorf("the listener logged %q: a refused client id is not logged", line)
		}
	}
}

// ---- the snapshot ---------------------------------------------------------------

// An API client's state and stream hold its own chats and the server's lists: no group, board,
// defaults, data folder or server list, and no chat of another client or of the owner.
func TestAPIClientSnapshot(t *testing.T) {
	sp := &apiSpawner{}
	list, _ := withServers(t)
	e, l := remoteEnv(t, withAgents(sp), list)
	// What the page's snapshot holds and an API client's must not: an entry of this server's own
	// list of remote servers, a board, a group, a chat of the owner's.
	pin := strings.TrimSuffix(strings.Repeat("AB:", 32), ":")
	if _, saved, _, err := e.s.Servers.Add(t.Context(), servers.Input{Name: "Studio", Address: "https://127.0.0.1:1", Secret: secondSecret, SelfSigned: true, Pin: pin}, true); err != nil || !saved {
		t.Fatalf("add: %v, saved %v", err, saved)
	}
	g, err := e.a.CreateGroup("Mine", "")
	if err != nil {
		t.Fatal(err)
	}
	bd := e.board(g.ID)
	owner := e.chat(`{"agent":"claude","group":"` + g.ID + `"}`)
	page := e.expect(200, "GET", "/api/state", "")
	for _, s := range []string{`"servers"`, "Studio", pin, `"dataDir"`, e.a.DataDir, `"groups"`, `"defaults"`, `"boards"`, bd.ID, owner.ID} {
		if !strings.Contains(page, s) {
			t.Fatalf("the page's state lacks %s: %s", s, page)
		}
	}

	want := []string{"agents", "catalogs", "chats", "defaultCwd", "home", "runs", "states"}
	x, snapX := l.api(apiX)
	y, _ := l.api(apiY)
	if got := keysOf(t, snapX); !slices.Equal(got, append(slices.Clone(want), "type")) {
		t.Fatalf("keys of the snapshot event: %v", got)
	}
	_, state := x.Do("GET", "/api/state", nil)
	if got := keysOf(t, string(state)); !slices.Equal(got, want) {
		t.Fatalf("keys of the state: %v", got)
	}
	type snap struct {
		Agents     []model.AgentKind
		Catalogs   map[string]*model.Catalog
		Home       string
		DefaultCwd string
		Chats      []model.ChatView
		States     []model.BranchState
		Runs       []json.RawMessage
	}
	if s := decode[snap](t, string(state)); len(s.Chats) != 0 || s.Chats == nil || s.States == nil || s.Runs == nil || len(s.States)+len(s.Runs) != 0 ||
		s.Home != "/home/owner" || s.DefaultCwd != e.a.DefaultCwd || len(s.Agents) != 3 || len(s.Catalogs) != 3 || s.Catalogs["claude"] == nil {
		t.Fatalf("the state of a new client: %s", state)
	}

	// X makes a chat and forks it.
	cwd := t.TempDir()
	if got := start(t, x, 200, startBody(chat1, cwd, "name", "X's chat", "userNamed", true)); !got.Started || !got.Sent || got.Chat == nil || got.Chat.ID != chat1 {
		t.Fatalf("the creation call: %+v", got)
	}
	reply(t, &sp.of(t, chat1).fakeAgent, "done", "p1")
	status, out := x.Do("POST", "/api/chats/"+chat1+"/fork", `{"branch":"main","at":3}`)
	fork := decode[model.ChatView](t, string(out))
	if status != 200 || fork.ID == "" || fork.ForkedFrom != chat1 {
		t.Fatalf("the fork: %d %s", status, out)
	}

	ids := func(c *bridgetest.Page) (cs, sts []string, raw string) {
		t.Helper()
		status, out := c.Do("GET", "/api/state", nil)
		if status != 200 {
			t.Fatalf("the state of %s: %d %s", c.ID, status, out)
		}
		s := decode[snap](t, string(out))
		for _, c := range s.Chats {
			cs = append(cs, c.ID)
		}
		for _, st := range s.States {
			sts = append(sts, st.Chat)
		}
		sort.Strings(cs)
		sort.Strings(sts)
		return cs, sts, string(out)
	}
	mine := []string{chat1, fork.ID}
	sort.Strings(mine)
	cs, sts, stateX := ids(x)
	if !slices.Equal(cs, mine) || !slices.Equal(sts, mine) {
		t.Fatalf("X's chats %v and states %v, want %v", cs, sts, mine)
	}
	if cs, sts, _ := ids(y); len(cs) != 0 || len(sts) != 0 {
		t.Fatalf("Y's chats %v and states %v", cs, sts)
	}
	// A new stream of X begins with the same.
	x.Close()
	x, snapX = l.api(apiX)
	if s := decode[snap](t, snapX); len(s.Chats) != 2 || len(s.States) != 2 {
		t.Fatalf("X's snapshot event: %s", snapX)
	}

	// The owner works meanwhile, on what an API client is told nothing of.
	e.expect(200, "POST", "/api/groups", `{"name":"More"}`)
	e.expect(200, "POST", "/api/chats/"+owner.ID+"/messages", `{"text":"ask"}`)
	evs := e.reach(x, y)
	apiOnly(t, x, evs[0])
	apiOnly(t, y, evs[1])
	if len(evs[1]) != 0 {
		t.Errorf("Y was sent %v", types(evs[1]))
	}
	// Neither the state nor the stream of X holds what is not its own.
	seen := stateX + "\n" + snapX + "\n" + strings.Join(evs[0], "\n")
	for _, s := range []string{`"servers"`, "Studio", "https://127.0.0.1:1", pin, secondSecret, testSecret, `"dataDir"`, e.a.DataDir,
		`"groups"`, `"defaults"`, `"boards"`, `"board"`, bd.ID, owner.ID, `"Remote"`, `"Mine"`, ownID} {
		if strings.Contains(seen, s) {
			t.Errorf("X's state or stream holds %s", s)
		}
	}
	if !strings.Contains(seen, chat1) || !strings.Contains(seen, "X's chat") {
		t.Fatalf("X's state lacks its own chat: %s", stateX)
	}
}

// Every route of the table does for an API client what it does for a page, on a chat the client
// made and on one it did not make.
func TestTableRoutesServeAnAPIClient(t *testing.T) {
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp), func(s *Server) {
		s.Usage = map[model.AgentKind]func(bool) (model.PlanUsage, error){model.Claude: func(bool) (model.PlanUsage, error) { return model.PlanUsage{}, nil }}
	})
	x, _ := l.api(apiX)
	cwd := t.TempDir()
	start(t, x, 200, startBody(chat1, cwd))
	a := sp.of(t, chat1)
	reply(t, &a.fakeAgent, "done", "p1")
	path := "/api/chats/" + chat1
	called := map[string]bool{"GET /api/events": true, "POST /api/chats": true} // made above
	call := func(route string, body any) obj {
		t.Helper()
		if !slices.Contains(RemoteRoutes, route) {
			t.Fatalf("%s is no route of the table", route)
		}
		called[route] = true
		method, p, _ := strings.Cut(route, " ")
		p = strings.Replace(strings.Replace(p, "{id}", chat1, 1), "{agent}", "claude", 1)
		return decode[obj](t, string(do(t, x, method, p, body)))
	}
	if got := call("GET /api/hello", nil); got["app"] != "ai-whiteboard" || got["pid"] != nil {
		t.Fatalf("hello: %v", got)
	}
	if got := call("GET /api/state", nil); len(got["chats"].([]any)) != 1 {
		t.Fatalf("the state: %v", got)
	}
	if got := call("GET /api/chats/{id}", nil); got["id"] != chat1 || got["locked"] != true {
		t.Fatalf("the chat: %v", got)
	}
	if got := call("GET /api/chats/{id}/items", nil); len(got["items"].([]any)) != 3 {
		t.Fatalf("the items: %v", got)
	}
	if got := call("GET /api/chats/{id}/tree", nil); got["current"] != "main" {
		t.Fatalf("the tree: %v", got)
	}
	if got := call("GET /api/chats/{id}/context", nil); got["total"] != 10.0 {
		t.Fatalf("the context split: %v", got)
	}
	dir := t.TempDir()
	if got := call("PATCH /api/chats/{id}", obj{"name": "renamed"}); got["ok"] != true || got["chat"].(obj)["name"] != "renamed" {
		t.Fatalf("the rename: %v", got)
	}
	if got := call("PUT /api/chats/{id}/label", obj{"branch": "main", "item": 1, "text": "a label"}); len(got["labels"].([]any)) != 1 {
		t.Fatalf("the label: %v", got)
	}
	call("POST /api/chats/{id}/open", nil)
	if got := call("POST /api/chats/{id}/messages", obj{"text": "again"}); got["ok"] != true || got["branch"] != "main" {
		t.Fatalf("the message: %v", got)
	}
	asked(t, a, "p1")
	call("POST /api/chats/{id}/permission", obj{"requestId": "p1", "allow": false})
	if got := a.answered(); !slices.Equal(got, []string{"p1 false"}) {
		t.Fatalf("the agent's answers: %v", got)
	}
	// A subagent's items: the route answers for the subagent the thread names.
	emit(t, &a.fakeAgent,
		agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Agent"},
		agent.Event{Kind: agent.EvSub, Sub: "t1", SubInfo: &agent.SubInfo{Status: model.SubRunning, Description: "count files"}},
		agent.Event{Kind: agent.EvText, Sub: "t1", Text: "looking"})
	thread, err := e.a.Chats.ThreadOf(chat1, "")
	if err != nil || len(thread.Subagents) != 1 {
		t.Fatalf("the chat's subagents: %+v, %v", thread.Subagents, err)
	}
	called["GET /api/chats/{id}/subagents/{sid}/items"] = true
	if got := decode[obj](t, string(do(t, x, "GET", path+"/subagents/"+thread.Subagents[0].ID+"/items", nil))); len(got["items"].([]any)) != 1 {
		t.Fatalf("the subagent's items: %v", got)
	}
	call("POST /api/chats/{id}/interrupt", nil)
	reply(t, &a.fakeAgent, "done again", "p2")
	if got := call("POST /api/chats/{id}/fork", obj{"branch": "main", "at": 3}); got["forkedFrom"] != chat1 {
		t.Fatalf("the fork: %v", got)
	}
	call("POST /api/chats/{id}/archive", nil)
	if v, _ := e.a.Chats.View(chat1); !v.Archived {
		t.Fatal("the chat is not archived")
	}
	call("POST /api/chats/{id}/unarchive", nil)
	call("POST /api/chats/{id}/unfollow", nil)
	if got := e.s.Bridge.Followers(editorbridge.Chat(chat1)); len(got) != 0 {
		t.Fatalf("followers after the unfollow: %v", got)
	}
	// The folder listing and the plan usage are the server's own machine's.
	called["GET /api/dirs"] = true
	if got := decode[obj](t, string(do(t, x, "GET", "/api/dirs?path="+dir, nil))); got["path"] != dir {
		t.Fatalf("the folder listing: %v", got)
	}
	call("GET /api/usage/{agent}", nil)

	// A chat the client did not make is served too: the secret is what lets a caller in. The
	// client is told of it only as a follower.
	owner := e.chat(`{"agent":"claude","group":"` + model.Ungrouped + `"}`)
	e.reach(x)
	do(t, x, "GET", "/api/chats/"+owner.ID+"/items", nil)
	do(t, x, "POST", "/api/chats/"+owner.ID+"/messages", obj{"text": "from the other server"})
	evs := e.reach(x)[0]
	apiOnly(t, x, evs)
	if count(evs, "chat_items", owner.ID) == 0 || count(evs, "chat", owner.ID) != 0 || count(evs, "branch_state", owner.ID) != 0 {
		t.Errorf("of the owner's chat, which it follows, the client was sent %v", types(evs))
	}
	if st := call("GET /api/state", nil); len(st["chats"].([]any)) != 2 || strings.Contains(fmt.Sprint(st), owner.ID) {
		t.Fatalf("the client's state lists what is not its own: %v", st)
	}

	// The delete, last: the client is told its chat is gone.
	call("DELETE /api/chats/{id}", nil)
	if got := e.reach(x)[0]; count(got, "chat_removed", chat1) != 1 {
		t.Errorf("after the delete the client was sent %v", types(got))
	}
	// The run routes of the table are called in apiruns_test.go, on a server with runs.
	for _, route := range RemoteRoutes {
		if !called[route] && !strings.Contains(route, " /api/runs/") {
			t.Errorf("the route %s of the table was not called", route)
		}
	}
}

// ---- the creation call ----------------------------------------------------------

func TestCreationCall(t *testing.T) {
	sp := &apiSpawner{}
	set, _ := agentsOf("claude", "cursor") // pi is not installed
	e, l := remoteEnv(t, withAgents(sp), func(s *Server) { s.App.Agents, s.App.Chats.Agents = set, set })
	x, _ := l.api(apiX)
	y, _ := l.api(apiY)
	p := e.page("P")
	cwd := t.TempDir()
	gone := filepath.Join(t.TempDir(), "gone")

	// nothing checks that a refused call left no chat with the id, no group and no program.
	nothing := func(what, id string) {
		t.Helper()
		if _, err := os.Stat(e.st.P.ChatDir(id)); err == nil {
			t.Fatalf("%s: the chat's folder is there", what)
		}
		if len(e.remoteGroups()) != 0 || sp.count() != 0 {
			t.Fatalf("%s: groups named Remote %v, %d programs", what, e.remoteGroups(), sp.count())
		}
	}
	refusal := func(what string, status int, code, body string) started {
		t.Helper()
		got := start(t, x, status, body)
		if got.Code != code || got.Started || got.Sent || got.Chat != nil {
			t.Fatalf("%s: %+v, want the code %q and no chat", what, got, code)
		}
		return got
	}

	// Refused before anything is looked at.
	refusal("a board", 400, "board_refused", startBody(chat1, cwd, "board", "b_12345678"))
	refusal("a group", 400, "group_refused", startBody(chat1, cwd, "group", model.Ungrouped))
	for _, missing := range []string{"id", "agent", "cwd", "text"} {
		code := "bad_request"
		if missing == "id" {
			code = "bad_id"
		}
		refusal("no "+missing, 400, code, startBody(chat1, cwd, missing, nil))
	}
	refusal("a blank text", 400, "bad_request", startBody(chat1, cwd, "text", "  \n"))
	refusal("JSON that cannot be read", 400, "bad_request", `{"id":`)
	refusal("no body", 400, "bad_request", ``)
	for _, id := range []string{"c_12345678", strings.ToUpper(apiZ), "../../etc", "a/b", chat1[:35]} {
		refusal("the id "+id, 400, "bad_id", startBody(id, cwd))
	}
	// Refused by what the server has.
	refusal("a missing folder", 409, "folder_missing", startBody(chat1, gone))
	refusal("a file as the folder", 409, "folder_missing", startBody(chat1, e.st.P.State))
	refusal("the app's own folder", 400, "", startBody(chat1, e.a.DataDir))
	refusal("an agent the server lacks", 409, "agent_missing", startBody(chat1, cwd, "agent", "pi"))
	refusal("an agent nobody knows", 400, "", startBody(chat1, cwd, "agent", "nobody"))
	refusal("a model the catalog lacks", 400, "bad_choice", startBody(chat1, cwd, "model", "no-such-model"))
	refusal("an effort the catalog lacks", 400, "bad_choice", startBody(chat1, cwd, "effort", "no-such-effort"))
	refusal("a run that is not there", 404, "", startBody(chat1, cwd, "run", "r_12345678"))
	nothing("after the refused calls", chat1)
	// An id that is taken: a chat of the owner's, and one of another client's.
	owner := e.chat(`{"agent":"claude","group":"` + model.Ungrouped + `"}`)
	const ownerID = "44444444-4444-4444-8444-444444444444"
	e.chat(`{"id":"` + ownerID + `","agent":"claude","group":"` + model.Ungrouped + `"}`)
	refusal("the id of the owner's chat", 409, "id_taken", startBody(ownerID, cwd))
	nothing("after the taken id", chat1)
	_ = owner
	e.reach(x, y, p)

	// A start whose program does not start: the error's status is the server's, the chat is
	// there, unstarted, with the call's values, in the group "Remote".
	sp.fail(errors.New("the program did not start"), nil)
	got := start(t, x, 500, startBody(chat1, cwd, "model", "sonnet", "name", "first name", "userNamed", true))
	if got.Started || got.Sent || got.Chat == nil || got.Chat.ID != chat1 || got.Chat.Locked || got.Error != "the program did not start" || got.Code != "" {
		t.Fatalf("a start whose program failed: %+v", got)
	}
	rg := e.remoteGroups()
	if len(rg) != 1 || got.Chat.Group != rg[0] || got.Chat.Name != "first name" || !got.Chat.UserNamed || got.Chat.Cwd != cwd || got.Chat.Model != "sonnet" {
		t.Fatalf("the unstarted chat %+v; groups named Remote %v", got.Chat, rg)
	}
	// The cap on running turns: 429, and the chat stays unstarted.
	sp.fail(nil, nil)
	t.Cleanup(func() { chats.SetCaps("4", "12") })
	chats.SetCaps("", "1")
	e.expect(200, "POST", "/api/chats/"+owner.ID+"/messages", `{"text":"go"}`)
	if got := start(t, x, 429, startBody(chat1, cwd)); got.Code != "cap" || got.Started || got.Sent || got.Chat == nil || got.Chat.Locked {
		t.Fatalf("a start at the cap: %+v", got)
	}
	chats.SetCaps("4", "12")
	// A retry with other values: they are applied, and the message is sent.
	cwd2 := t.TempDir()
	before := sp.count()
	got = start(t, x, 200, startBody(chat1, cwd2, "agent", "cursor", "model", nil, "name", "second name", "userNamed", false))
	if !got.Started || !got.Sent || got.Chat == nil || !got.Chat.Locked || got.Chat.Agent != model.Cursor || got.Chat.Cwd != cwd2 ||
		got.Chat.Name != "second name" || got.Chat.UserNamed || got.Chat.Group != rg[0] {
		t.Fatalf("the retry: %+v", got)
	}
	a := sp.of(t, chat1)
	if sp.count() != before+1 || a.sends.Load() != 1 {
		t.Fatalf("%d programs started for the retry, %d messages at the agent", sp.count()-before, a.sends.Load())
	}
	// A repeat finds the chat started: nothing is applied, nothing is sent.
	got = start(t, x, 200, startBody(chat1, cwd, "name", "third name"))
	if !got.Started || got.Sent || got.Chat == nil || got.Chat.Name != "second name" || got.Chat.Cwd != cwd2 || a.sends.Load() != 1 || sp.count() != before+1 {
		t.Fatalf("the repeat: %+v; %d messages at the agent", got, a.sends.Load())
	}
	// Another client's call with this id: the id is taken, and it is told nothing of the chat.
	if status, out := y.Do("POST", "/api/chats", startBody(chat1, cwd)); status != 409 || strings.Contains(string(out), `"chat"`) || decode[started](t, string(out)).Code != "id_taken" {
		t.Fatalf("another client's call with the id: %d %s", status, out)
	}
	// The id of a fork is taken for the client that made the fork too.
	reply(t, &a.fakeAgent, "done", "p1")
	_, out := x.Do("POST", "/api/chats/"+chat1+"/fork", `{"branch":"main","at":3}`)
	fork := decode[model.ChatView](t, string(out))
	if fork.ID == "" || fork.Group != rg[0] {
		t.Fatalf("the fork: %s", out)
	}
	if got := start(t, x, 409, startBody(fork.ID, cwd)); got.Code != "id_taken" || got.Chat != nil {
		t.Fatalf("a call with a fork's id: %+v", got)
	}

	// An agent that starts and refuses the message: an error, and the chat is started. The
	// repeat sends nothing.
	sp.fail(nil, errors.New("the agent refused the message"))
	got = start(t, x, 500, startBody(chat2, cwd))
	if !got.Started || got.Chat == nil || !got.Chat.Locked || got.Error == "" {
		t.Fatalf("a start whose agent refused the message: %+v", got)
	}
	refuser := sp.of(t, chat2)
	if got := start(t, x, 200, startBody(chat2, cwd)); !got.Started || got.Sent || refuser.sends.Load() != 1 {
		t.Fatalf("the repeat after the agent's refusal: %+v; %d messages at the agent", got, refuser.sends.Load())
	}
	sp.fail(nil, nil)

	// A folder given with ~ is the server's home; one that went missing since is told as such
	// with the chat's state.
	if err := os.RemoveAll(cwd2); err != nil {
		t.Fatal(err)
	}
	if got := start(t, x, 409, startBody(chat1, cwd2)); got.Code != "folder_missing" || !got.Started || got.Chat == nil {
		t.Fatalf("a repeat whose folder is gone: %+v", got)
	}

	// Of what was made the two clients were told by its mark: X of its chats, Y of nothing; and
	// the page of all of it. No list of groups reaches either API client.
	evs := e.reach(x, y, p)
	apiOnly(t, x, evs[0])
	if count(evs[0], "chat", chat1) == 0 || count(evs[0], "chat", chat2) == 0 || count(evs[0], "chat", fork.ID) == 0 || count(evs[0], "branch_state", chat1) == 0 {
		t.Errorf("X was sent %v", types(evs[0]))
	}
	if len(evs[1]) != 0 {
		t.Errorf("Y was sent %v", types(evs[1]))
	}
	if count(evs[2], "groups", rg[0]) != 1 || count(evs[2], "defaults", rg[0]) == 0 || count(evs[2], "chat", chat1) == 0 {
		t.Errorf("the page was sent %v", types(evs[2]))
	}
	if len(e.remoteGroups()) != 1 {
		t.Fatalf("groups named Remote: %v", e.remoteGroups())
	}
}

// Of many creation calls with one id, at once, one makes the chat and one sends.
func TestCreationCallManyAtOnce(t *testing.T) {
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	cwd := t.TempDir()
	const n = 24
	answers := make([]started, n)
	var wg sync.WaitGroup
	for i := range answers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, out := l.call(apiX, testSecret, "POST", "/api/chats", startBody(chat1, cwd))
			if status != 200 || json.Unmarshal([]byte(out), &answers[i]) != nil {
				t.Errorf("call %d: %d %s", i, status, out)
			}
		}()
	}
	wg.Wait()
	sent := 0
	for i, a := range answers {
		if !a.OK || !a.Started || a.Chat == nil || a.Chat.ID != chat1 {
			t.Fatalf("answer %d: %+v", i, a)
		}
		if a.Sent {
			sent++
		}
	}
	if sent != 1 || sp.count() != 1 || sp.of(t, chat1).sends.Load() != 1 {
		t.Fatalf("%d calls sent, %d programs, %d messages at the agent; want one of each", sent, sp.count(), sp.of(t, chat1).sends.Load())
	}
	if rg := e.remoteGroups(); len(rg) != 1 || len(e.a.Chats.ViewsOf(apiX)) != 1 {
		t.Fatalf("groups named Remote %v, %d chats of the client", rg, len(e.a.Chats.ViewsOf(apiX)))
	}
}

// ---- beside a page (AC13) -------------------------------------------------------

// do is a call of the client that must be answered with 200.
func do(t *testing.T, c *bridgetest.Page, method, path string, body any) []byte {
	t.Helper()
	status, out := c.Do(method, path, body)
	if status != 200 {
		t.Fatalf("%s %s by %s: %d %s", method, path, c.ID, status, out)
	}
	return out
}

// asked makes the chat's agent ask for a permission, and returns once the card is in the thread.
func asked(t *testing.T, a *apiAgent, id string) {
	t.Helper()
	a.ask(id)
	emit(t, &a.fakeAgent)
}

// work is what an API client does with a chat it made: it creates it, reads it, answers a
// permission ask, stops the turn and sends a second message. It returns the chat's agent.
func work(t *testing.T, sp *apiSpawner, c *bridgetest.Page, chat, cwd string, between func()) *apiAgent {
	t.Helper()
	if got := start(t, c, 200, startBody(chat, cwd)); !got.Started || !got.Sent {
		t.Fatalf("the creation call: %+v", got)
	}
	a := sp.of(t, chat)
	items := decode[struct{ Items []model.Item }](t, string(do(t, c, "GET", "/api/chats/"+chat+"/items", nil)))
	if len(items.Items) != 1 || items.Items[0].Kind != "user" || items.Items[0].Text != "the first message" {
		t.Fatalf("the items after the creation call: %+v", items.Items)
	}
	emit(t, &a.fakeAgent, agent.Event{Kind: agent.EvText, Text: "working"})
	asked(t, a, "p1")
	if between != nil {
		between()
	}
	do(t, c, "POST", "/api/chats/"+chat+"/permission", map[string]any{"requestId": "p1", "allow": true})
	if got := a.answered(); !slices.Equal(got, []string{"p1 true"}) {
		t.Fatalf("the agent's answers: %v", got)
	}
	do(t, c, "POST", "/api/chats/"+chat+"/interrupt", nil)
	emit(t, &a.fakeAgent, agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
	do(t, c, "POST", "/api/chats/"+chat+"/messages", map[string]any{"text": "the second message"})
	if a.sends.Load() != 2 {
		t.Fatalf("%d messages at the agent, want 2", a.sends.Load())
	}
	reply(t, &a.fakeAgent, "done", "p2")
	return a
}

// content is the content events among evs, as sent.
func content(evs []string) []string { return only(evs, "chat_items", "tree", "sub", "sub_items") }

// While a page holds a board and follows a chat of its own, two API clients connect and one of
// them creates a chat, sends, answers a permission ask and stops. Nothing is taken from the page.
func TestAPIClientsTakeNothingFromAPage(t *testing.T) {
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	p := e.page("P")
	bd, token := e.boardChat(p) // the page made the board, so it holds it
	_, rev := take(t, p, bd.ID, false)
	written(t, p, bd.ID, rev, drawing("one"))
	own := decode[model.ChatView](t, string(do(t, p, "POST", "/api/chats", map[string]any{"agent": "claude", "group": model.Ungrouped})))
	do(t, p, "POST", "/api/chats/"+own.ID+"/messages", map[string]any{"text": "ask"})
	open(t, p, own.ID)
	ownAgent := sp.of(t, own.ID)
	p.OnRPC(func(map[string]any) (any, string) { return "the board", "" })
	e.reach(p)

	// The connects: the page is sent nothing and keeps its board.
	x, _ := l.api(apiX)
	y, _ := l.api(apiY)
	if got := e.reach(p)[0]; len(got) != 0 {
		t.Fatalf("at the API clients' connects the page was sent %v", got)
	}
	quiet(t, "the API clients' connects", p)
	e.holder(bd.ID, "P")

	// X works on a chat it makes; Y follows that chat too. Meanwhile the page saves its board,
	// its own chat goes on, and an agent's board tool is answered by the page.
	cwd := t.TempDir()
	a := work(t, sp, x, chat1, cwd, func() {
		do(t, y, "GET", "/api/chats/"+chat1+"/items", nil)
		written(t, p, bd.ID, rev+1, drawing("two"))
		emit(t, &ownAgent.fakeAgent, agent.Event{Kind: agent.EvText, Text: "for the page"})
		if text, isErr := e.tool(token, "read_board"); isErr || text != "the board" {
			t.Fatalf("the board tool: %q (error %v)", text, isErr)
		}
	})
	written(t, p, bd.ID, rev+2, drawing("three"))
	e.holder(bd.ID, "P")
	e.stored(bd.ID, drawing("three"), rev+3)

	evs := e.reach(x, y, p)
	xs, ys, ps := evs[0], evs[1], evs[2]
	// The page: nothing about a role, and the events of the chat it follows.
	for _, typ := range []string{"release_request", "superseded", "held", "server_stopping"} {
		if n := count(ps, typ); n != 0 {
			t.Errorf("the page was sent %d %s", n, typ)
		}
	}
	if count(ps, "chat_items", own.ID, "for the page") == 0 {
		t.Errorf("the page got no chat_items of the chat it follows: %v", types(ps))
	}
	if count(ps, "chat", chat1) == 0 || count(ps, "chat_items", chat1) != 0 {
		t.Errorf("the page, which lists the API client's chat and does not follow it, was sent %v", types(ps))
	}
	// The API clients: no rpc, no role event, nothing outside their list, nothing of the page's
	// chat or board.
	for i, c := range []*bridgetest.Page{x, y} {
		apiOnly(t, c, evs[i])
		for _, raw := range evs[i] {
			if strings.Contains(raw, own.ID) || strings.Contains(raw, bd.ID) {
				t.Errorf("the API client %s was sent %s", c.ID, raw)
			}
		}
	}
	// X, whose chat it is, was told of the chat; Y, a follower, was not; both got its content,
	// the same events in the same order from Y's read on.
	if count(xs, "chat", chat1) == 0 || count(xs, "branch_state", chat1) == 0 {
		t.Errorf("X was sent %v", types(xs))
	}
	if count(ys, "chat") != 0 || count(ys, "branch_state") != 0 || count(ys, "chat_removed") != 0 {
		t.Errorf("Y, which has no item with its mark, was sent %v", types(ys))
	}
	cx, cy := content(xs), content(ys)
	if len(cy) < 4 || len(cx) < len(cy) || !slices.Equal(cx[len(cx)-len(cy):], cy) {
		t.Errorf("the content events of the two followers differ:\nX %v\nY %v", cx, cy)
	}
	if count(cy, "chat_items", "the second message") == 0 || count(cy, "tree") == 0 || count(cx, "chat_items", `"p1"`) == 0 {
		t.Errorf("the followers' content events: X %v, Y %v", types(cx), types(cy))
	}
	if got := a.answered(); len(got) != 1 {
		t.Errorf("the agent's answers: %v", got)
	}
}

// The same with no page connected at all.
func TestAPIClientWithNoPage(t *testing.T) {
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	// The env's own page goes: a new stream with its id ends the old one, and is then closed.
	bridgetest.Connect(t, e.url, clientID).Close()
	for deadline := time.Now().Add(5 * time.Second); e.s.Bridge.Known(clientID); time.Sleep(2 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the page's stream did not end")
		}
	}
	x, _ := l.api(apiX)
	work(t, sp, x, chat1, t.TempDir(), nil)
	evs := e.reach(x)[0]
	apiOnly(t, x, evs)
	for _, typ := range []string{"chat", "branch_state", "chat_items", "tree"} {
		if count(evs, typ, chat1) == 0 {
			t.Errorf("no %s of the chat: %v", typ, types(evs))
		}
	}
	if count(evs, "chat_items", "the second message") == 0 || count(evs, "chat_items", `"p1"`) == 0 {
		t.Errorf("the turn's events: %v", types(evs))
	}
	st := decode[struct{ Chats []model.ChatView }](t, string(do(t, x, "GET", "/api/state", nil)))
	if len(st.Chats) != 1 || st.Chats[0].ID != chat1 || !st.Chats[0].Locked {
		t.Fatalf("the client's chats: %+v", st.Chats)
	}
}

// A page that follows the chat of a run's agent still gets that chat's events after API clients
// connected; an API client gets them only when it follows the chat, and nothing of the run.
func TestRunAgentsChatBesideAPIClients(t *testing.T) {
	l := newListener(t)
	e := newRunEnv(t)
	l.set(e.s)
	l.serve(e.s)
	said, next := make(chan struct{}, 8), make(chan struct{})
	e.fake.Script(func(t *agenttest.Turn) {
		t.Say("first")
		said <- struct{}{}
		select {
		case <-next:
		case <-t.Interrupted():
			return
		}
		t.Say("second")
		said <- struct{}{}
		<-t.Interrupted()
	})
	v := e.newRun()
	e.expect(409, "GET", "/api/runs/"+v.ID+"/detail", "")
	e.view(200, "POST", "/api/runs/"+v.ID+"/start", `{"goal":"Look around."}`)
	<-said
	orch := e.detail(v.ID).Turns[0].Agent
	e.expect(200, "GET", "/api/chats/"+orch+"/items", "") // the page follows the agent's chat

	x, snapX := l.api(apiX)
	y, snapY := l.api(apiY)
	for _, snap := range []string{snapX, snapY} {
		if strings.Contains(snap, v.ID) || strings.Contains(snap, orch) || !strings.Contains(snap, `"runs":[]`) || !strings.Contains(snap, `"chats":[]`) {
			t.Fatalf("an API client's snapshot beside the owner's run: %s", snap)
		}
	}
	// X reads the agent's items: it follows the chat, with no mark on it.
	if got := decode[struct{ Items []model.Item }](t, string(do(t, x, "GET", "/api/chats/"+orch+"/items", nil))); len(got.Items) < 2 {
		t.Fatalf("the agent's items: %+v", got.Items)
	}
	if got := e.s.Bridge.Followers(editorbridge.Chat(orch)); !slices.Contains(got, clientID) || !slices.Contains(got, apiX) || len(got) != 2 {
		t.Fatalf("the followers of the agent's chat: %v", got)
	}
	close(next)
	<-said
	e.await("the agent's chat_items at the page, after the API clients connected", func(evs []runTestEvent) bool {
		return slices.ContainsFunc(evs, func(ev runTestEvent) bool {
			return ev.Type == "chat_items" && strings.Contains(ev.Raw, orch) && strings.Contains(ev.Raw, "second")
		})
	})
	xs := upTo(t, x, "chat_items", orch, "second")
	e.expect(200, "POST", "/api/runs/"+v.ID+"/stop", "")
	e.awaitRun(v.ID, "to stop", func(v model.RunView) bool { return v.Status == model.RunStopped })
	evs := e.reach(x, y)
	xs = append(xs, evs[0]...)
	apiOnly(t, x, xs)
	// The follower: the chat's own events, its view too, and nothing of the run.
	if count(xs, "chat", orch) == 0 {
		t.Errorf("X, a follower of the agent's chat, got no chat event of it: %v", types(xs))
	}
	for _, typ := range []string{"run", "run_detail", "run_activity", "run_removed"} {
		if n := count(xs, typ); n != 0 {
			t.Errorf("X was sent %d %s", n, typ)
		}
	}
	// The other client: nothing at all.
	if len(evs[1]) != 0 {
		t.Errorf("Y was sent %v", evs[1])
	}
	quiet(t, "the owner's run", y)
	// A chat on a run: the creation call puts it on the run, in the run's folder, with the mark,
	// and asks for no group.
	got := start(t, x, 200, startBody(chat1, "", "run", v.ID, "cwd", nil))
	if !got.Started || !got.Sent || got.Chat == nil || got.Chat.Run != v.ID || got.Chat.Group != "" || got.Chat.Cwd != e.cwd {
		t.Fatalf("the creation call on a run: %+v", got)
	}
	if mark, err := e.cm.ClientOf(chat1); err != nil || mark != apiX || len(e.remoteGroups()) != 0 {
		t.Fatalf("the mark of the chat on the run: %q, %v; groups named Remote %v", mark, err, e.remoteGroups())
	}
	if evs := e.reach(x, y); count(evs[0], "chat", chat1) == 0 || len(evs[1]) != 0 {
		t.Errorf("after the creation on a run X was sent %v, Y %v", types(evs[0]), types(evs[1]))
	}
}

// Two answers to one permission ask at once, one from a page and one from an API client: one is
// taken, the other finds the request closed, and the agent gets one answer.
func TestTwoAnswersToOneAsk(t *testing.T) {
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	p := e.page("P")
	x, _ := l.api(apiX)
	start(t, x, 200, startBody(chat1, t.TempDir()))
	a := sp.of(t, chat1)
	wins := map[string]int{}
	const rounds = 20
	for round := range rounds {
		id := "p" + strconv.Itoa(round)
		asked(t, a, id)
		var wg sync.WaitGroup
		status, out := make([]int, 2), make([][]byte, 2)
		for i, c := range []*bridgetest.Page{p, x} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				status[i], out[i] = c.Do("POST", "/api/chats/"+chat1+"/permission", map[string]any{"requestId": id, "allow": i == 0})
			}()
		}
		wg.Wait()
		won, lost := 0, 1
		if status[0] != 200 {
			won, lost = 1, 0
		}
		if status[won] != 200 || status[lost] != 400 || decode[obj](t, string(out[lost]))["error"] != chats.ErrNoRequest.Error() {
			t.Fatalf("round %d: the page got %d %s, the API client %d %s", round, status[0], out[0], status[1], out[1])
		}
		got := a.answered()
		if len(got) != round+1 || got[round] != fmt.Sprintf("%s %v", id, won == 0) {
			t.Fatalf("round %d: the agent's answers %v", round, got)
		}
		wins[[]string{"page", "api"}[won]]++
	}
	t.Logf("of %d asks the page's answer was taken %d times, the API client's %d times", rounds, wins["page"], wins["api"])
}

// ---- the group "Remote" (AC45) ----------------------------------------------------

func TestChatsOfAPIClientsSitInTheRemoteGroup(t *testing.T) {
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	p := e.page("P")
	x, _ := l.api(apiX)
	y, _ := l.api(apiY)
	cwd := t.TempDir()
	mine := decode[model.Group](t, e.expect(200, "POST", "/api/groups", `{"name":"Mine"}`))
	if len(e.remoteGroups()) != 0 {
		t.Fatal("a group Remote before any creation")
	}
	e.reach(x, y, p)

	// Two clients' chats and a fork: one group, at the top level, and all three in it.
	a, b := start(t, x, 200, startBody(chat1, cwd)), start(t, y, 200, startBody(chat2, cwd))
	reply(t, &sp.of(t, chat1).fakeAgent, "done", "p1")
	fork := decode[model.ChatView](t, string(do(t, x, "POST", "/api/chats/"+chat1+"/fork", `{"branch":"main","at":3}`)))
	rg := e.remoteGroups()
	if len(rg) != 1 || a.Chat.Group != rg[0] || b.Chat.Group != rg[0] || fork.Group != rg[0] {
		t.Fatalf("groups named Remote %v; the chats are in %q, %q and %q", rg, a.Chat.Group, b.Chat.Group, fork.Group)
	}
	page := decode[struct {
		Groups []model.Group
		Chats  []model.ChatView
	}](t, e.expect(200, "GET", "/api/state", ""))
	if i := slices.IndexFunc(page.Groups, func(g model.Group) bool { return g.ID == rg[0] }); i < 0 || page.Groups[i] != (model.Group{ID: rg[0], Name: "Remote"}) {
		t.Fatalf("the page's groups: %+v", page.Groups)
	}
	for _, c := range page.Chats {
		if c.Group != rg[0] || len(page.Chats) != 3 {
			t.Fatalf("the page's chats: %+v", page.Chats)
		}
	}
	// The page was told of the group once; no API client was told of a group or of defaults, in
	// its state or on its stream.
	evs := e.reach(x, y, p)
	if count(evs[2], "groups", rg[0]) != 1 || count(evs[2], "defaults", rg[0]) != 1 {
		t.Errorf("the page was sent %v", types(evs[2]))
	}
	for i, c := range []*bridgetest.Page{x, y} {
		apiOnly(t, c, evs[i])
		state := string(do(t, c, "GET", "/api/state", nil))
		if strings.Contains(state, `"groups"`) || strings.Contains(state, `"defaults"`) || strings.Contains(state, `"Remote"`) {
			t.Errorf("the state of %s: %s", c.ID, state)
		}
	}

	// A configure that names a group or a server is refused before anything is written: the
	// name of the same body is not applied.
	for _, c := range []struct{ body, code string }{
		{`{"name":"renamed","group":"` + mine.ID + `"}`, "group_refused"},
		{`{"name":"renamed","group":"` + model.Ungrouped + `"}`, "group_refused"},
		{`{"name":"renamed","group":""}`, "group_refused"},
		{`{"name":"renamed","server":"local"}`, "server_refused"},
		{`{"name":"renamed","model":"sonnet","server":"` + ownID + `"}`, "server_refused"},
	} {
		status, out := x.Do("PATCH", "/api/chats/"+chat1, c.body)
		if got := decode[refusal](t, string(out)); status != 400 || got.Code != c.code || got.Error == "" {
			t.Fatalf("PATCH %s: %d %s, want 400 %s", c.body, status, out, c.code)
		}
	}
	if v := decode[model.ChatView](t, string(do(t, x, "GET", "/api/chats/"+chat1, nil))); v.Name == "renamed" || v.Group != rg[0] {
		t.Fatalf("after the refused configures: %+v", v)
	}
	// The rest of the route is as built, and the owner's page may still move the chat.
	if got := decode[patched](t, string(do(t, x, "PATCH", "/api/chats/"+chat1, `{"name":"renamed"}`))); !got.OK || got.Chat.Name != "renamed" {
		t.Fatalf("a rename by the API client: %+v", got)
	}
	e.expect(200, "PATCH", "/api/chats/"+chat1, `{"group":"`+mine.ID+`"}`)

	// An item the owner moved out, then configured and sent to, changes no defaults. The item
	// is a chat that a failed start left unstarted.
	sp.fail(errors.New("the program did not start"), nil)
	if got := start(t, x, 500, startBody(chat3, cwd)); got.Started || got.Chat == nil {
		t.Fatalf("the failed start: %+v", got)
	}
	sp.fail(nil, nil)
	defaultsNow := func() string {
		return string(decode[struct{ Defaults json.RawMessage }](t, e.expect(200, "GET", "/api/state", "")).Defaults)
	}
	e.reach(p)
	before := defaultsNow()
	dir := t.TempDir()
	e.expect(200, "PATCH", "/api/chats/"+chat3, `{"group":"`+mine.ID+`"}`)
	e.expect(200, "PATCH", "/api/chats/"+chat3, `{"agent":"cursor"}`)
	e.expect(200, "PATCH", "/api/chats/"+chat3, mustJSON(t, obj{"agent": "claude", "model": "sonnet", "cwd": dir}))
	e.expect(200, "POST", "/api/chats/"+chat3+"/messages", `{"text":"from the owner"}`)
	if v := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+chat3, "")); !v.Locked || v.Group != mine.ID || v.Cwd != dir {
		t.Fatalf("the chat after the owner's changes: %+v", v)
	}
	if got := defaultsNow(); got != before {
		t.Fatalf("the defaults changed:\n%s\nwant\n%s", got, before)
	}
	if got := e.reach(p)[0]; count(got, "defaults") != 0 || count(got, "chat", chat3) == 0 {
		t.Fatalf("a defaults event after the owner's changes of a client's chat: %v", types(got))
	}
	// The same steps on a chat of the owner's do record: the check above can fail.
	own := e.chat(`{"agent":"claude","group":"` + mine.ID + `"}`)
	e.expect(200, "PATCH", "/api/chats/"+own.ID, mustJSON(t, obj{"cwd": dir}))
	if defaultsNow() == before {
		t.Fatal("the owner's own chat recorded no defaults")
	}

	// The group deleted alone, deleted with what is in it, and archived: each time the next
	// creation makes a new group "Remote".
	last := rg[0]
	next := func(what, id string) string {
		t.Helper()
		got := start(t, y, 200, startBody(id, cwd))
		g := got.Chat.Group
		if g == last || g == model.Ungrouped || !slices.Contains(e.remoteGroups(), g) {
			t.Fatalf("%s: the new chat is in %q; the group before was %q, groups named Remote %v", what, g, last, e.remoteGroups())
		}
		e.st.Read(func(s *model.State) {
			if i := slices.IndexFunc(s.Groups, func(x model.Group) bool { return x.ID == g }); s.Groups[i] != (model.Group{ID: g, Name: "Remote"}) || s.RemoteGroup != g {
				t.Fatalf("%s: the new group is %+v, remembered %q", what, s.Groups[i], s.RemoteGroup)
			}
		})
		last = g
		return g
	}
	e.expect(200, "DELETE", "/api/groups/"+rg[0]+"?contents=keep", "")
	if v := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+chat2, "")); v.Group != model.Ungrouped {
		t.Fatalf("after the group's delete the chat is in %q", v.Group)
	}
	const chat4, chat5, chat6 = "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"
	g2 := next("deleted alone", chat4)
	e.expect(200, "DELETE", "/api/groups/"+g2+"?contents=delete", "")
	e.expect(404, "GET", "/api/chats/"+chat4, "")
	g3 := next("deleted with its contents", chat5)
	e.expect(200, "POST", "/api/groups/"+g3+"/archive", "")
	if v := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+chat5, "")); !v.Archived {
		t.Fatalf("the chat of the archived group: %+v", v)
	}
	next("archived", chat6)
	// The client was told of the delete of its chat, and of the archive.
	ys := e.reach(y)[0]
	apiOnly(t, y, ys)
	if count(ys, "chat_removed", chat4) != 1 || count(ys, "chat", chat5, `"archived":true`) == 0 {
		t.Errorf("Y was sent %v", types(ys))
	}
}

// ---- the event table for an API client (AC41) -------------------------------------

// Every row of the event table whose sender is the app, the boards or the chat manager, for
// three API clients beside a page: X made the chat (its mark), Y follows it, Z does neither.
func TestEventsOfAnAPIClient(t *testing.T) {
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	p := e.page("P")
	x, _ := l.api(apiX)
	y, _ := l.api(apiY)
	z, _ := l.api(apiZ)
	cwd := t.TempDir()
	var xs, ys, zs, ps []string
	step := func() {
		t.Helper()
		got := e.reach(x, y, z, p)
		xs, ys, zs, ps = got[0], got[1], got[2], got[3]
		apiOnly(t, x, xs)
		apiOnly(t, y, ys)
		apiOnly(t, z, zs)
	}
	// row checks who was sent an event of this type that names all of has, in the last step.
	row := func(when, typ string, toX, toY, toZ, toP bool, has ...string) {
		t.Helper()
		for _, c := range []struct {
			who  string
			evs  []string
			want bool
		}{{"X, with the mark", xs, toX}, {"Y, a follower", ys, toY}, {"Z", zs, toZ}, {"the page", ps, toP}} {
			if n := count(c.evs, typ, has...); (n > 0) != c.want {
				t.Errorf("%s: %s was sent %d %s, want %v: %v", when, c.who, n, typ, c.want, types(c.evs))
			}
		}
	}
	none := func(when string, evs ...[]string) {
		t.Helper()
		for _, ev := range evs {
			if len(ev) != 0 {
				t.Errorf("%s: an API client was sent %v", when, ev)
			}
		}
	}

	// groups and defaults (the app), board and board_removed (the boards): the pages alone.
	e.expect(200, "POST", "/api/groups", `{"name":"G"}`)
	b := e.board(model.Ungrouped)
	e.expect(200, "DELETE", "/api/boards/"+b.ID, "")
	step()
	row("a new group", "groups", false, false, false, true)
	row("a new group", "defaults", false, false, false, true)
	row("a new board", "board", false, false, false, true, b.ID)
	row("a deleted board", "board_removed", false, false, false, true, b.ID)
	none("the owner's groups and boards", xs, ys, zs)

	// agents, as main sends it, and catalog, the manager's own event of no chat: every client.
	// The chat whose agent reports the catalog is the owner's: nothing else of it reaches an
	// API client.
	own := e.chat(`{"agent":"claude","group":"` + model.Ungrouped + `"}`)
	e.expect(200, "POST", "/api/chats/"+own.ID+"/messages", `{"text":"ask"}`)
	e.s.Bridge.Broadcast(map[string]any{"type": "agents", "agents": []model.AgentKind{model.Claude}})
	emit(t, &sp.of(t, own.ID).fakeAgent, agent.Event{Kind: agent.EvCatalog, Catalog: &model.Catalog{Models: []model.CatalogModel{{ID: "m-one"}}}})
	step()
	row("the usable agents", "agents", true, true, true, true)
	row("an agent's catalog", "catalog", true, true, true, true, "m-one")
	row("the owner's chat", "chat", false, false, false, true, own.ID)
	row("the owner's chat", "branch_state", false, false, false, true, own.ID)
	for _, evs := range [][]string{xs, ys, zs} {
		if len(evs) != 2 {
			t.Errorf("an API client was sent %v, want agents and catalog", types(evs))
		}
	}

	// The creation: chat and branch_state to the client with the mark, and to the pages. Nobody
	// follows the chat yet, so nobody is sent what is in it.
	start(t, x, 200, startBody(chat1, cwd))
	a := &sp.of(t, chat1).fakeAgent
	step()
	row("the creation", "chat", true, false, false, true, chat1)
	row("the creation", "branch_state", true, false, false, true, chat1)
	row("the creation", "chat_items", false, false, false, false)
	row("the creation", "tree", false, false, false, false)
	row("the creation", "groups", false, false, false, true)
	none("the creation", ys, zs)

	// X reads the items and Y the tree: both follow. The content goes to them, and not to the
	// page, which did not read.
	do(t, x, "GET", "/api/chats/"+chat1+"/items", nil)
	do(t, y, "GET", "/api/chats/"+chat1+"/tree", nil)
	emit(t, a, agent.Event{Kind: agent.EvText, Text: "one"})
	step()
	row("a reply's text", "chat_items", true, true, false, false, chat1, "one")
	none("a reply's text", zs)
	// sub and sub_items: the followers.
	emit(t, a,
		agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Agent"},
		agent.Event{Kind: agent.EvSub, Sub: "t1", SubInfo: &agent.SubInfo{Status: model.SubRunning, Description: "count files"}},
		agent.Event{Kind: agent.EvText, Sub: "t1", Text: "looking"})
	step()
	row("a subagent", "sub", true, true, false, false, chat1)
	row("a subagent", "sub_items", true, true, false, false, chat1)
	row("a subagent", "chat_items", true, true, false, false, chat1)
	none("a subagent", zs)
	// The end of the turn: the list events by the mark, the content to the followers.
	reply(t, a, "done", "p1")
	step()
	row("the turn's end", "chat_items", true, true, false, false, chat1)
	row("the turn's end", "tree", true, true, false, false, chat1)
	row("the turn's end", "branch_state", true, false, false, true, chat1)
	row("the turn's end", "chat", true, false, false, true, chat1)
	none("the turn's end", zs)
	if cx, cy := content(xs), content(ys); len(cy) == 0 || !slices.Equal(cx, cy) {
		t.Errorf("the two followers' content events differ:\nX %v\nY %v", cx, cy)
	}

	// After an unfollow, no more.
	do(t, y, "POST", "/api/chats/"+chat1+"/unfollow", nil)
	do(t, x, "POST", "/api/chats/"+chat1+"/messages", map[string]any{"text": "again"})
	emit(t, a, agent.Event{Kind: agent.EvText, Text: "two"})
	step()
	row("after Y's unfollow", "chat_items", true, false, false, false, chat1)
	none("after Y's unfollow", ys, zs)

	// A new stream of X follows nothing: the content comes again only after a new read.
	x.Close()
	x, _ = l.api(apiX)
	if got := e.s.Bridge.Followers(editorbridge.Chat(chat1)); len(got) != 0 {
		t.Fatalf("followers after the reconnect: %v", got)
	}
	emit(t, a, agent.Event{Kind: agent.EvText, Text: "three"})
	step()
	row("after the reconnect, before a read", "chat_items", false, false, false, false)
	row("after the reconnect, before a read", "tree", false, false, false, false)
	do(t, x, "GET", "/api/chats/"+chat1+"/tree", nil)
	emit(t, a, agent.Event{Kind: agent.EvText, Text: "four"})
	step()
	row("after the reconnect and a new read", "chat_items", true, false, false, false, chat1, "four")

	// The owner's delete: chat_removed by the mark. Y follows again and is told nothing: a
	// follower without the mark does not list the chat.
	thread, err := e.a.Chats.ThreadOf(chat1, "")
	if err != nil || len(thread.Subagents) != 1 {
		t.Fatalf("the chat's subagents: %+v, %v", thread.Subagents, err)
	}
	do(t, y, "GET", "/api/chats/"+chat1+"/subagents/"+thread.Subagents[0].ID+"/items", nil) // a subagent's items follow as well
	if got := e.s.Bridge.Followers(editorbridge.Chat(chat1)); !slices.Contains(got, apiY) || !slices.Contains(got, apiX) {
		t.Fatalf("followers before the delete: %v", got)
	}
	e.expect(200, "DELETE", "/api/chats/"+chat1, "")
	step()
	row("the owner's delete", "chat_removed", true, false, false, true, chat1)
	// The stop of the chat's agent is content, which Y is sent; of the list it is told nothing.
	if len(content(ys)) != len(ys) {
		t.Errorf("the owner's delete: Y, a follower without the mark, was sent %v", types(ys))
	}
	none("the owner's delete", zs)
	if got := e.s.Bridge.Followers(editorbridge.Chat(chat1)); len(got) != 0 || e.s.Bridge.MarkOf(editorbridge.Chat(chat1)) != "" {
		t.Errorf("after the delete: followers %v, mark %q", got, e.s.Bridge.MarkOf(editorbridge.Chat(chat1)))
	}
	// Z, which has no item and follows none, got agents and catalog and nothing else, to the end.
	quiet(t, "the whole test", z)
}

// ---- the reload of the secret (AC24) ----------------------------------------------

func TestReloadSecret(t *testing.T) {
	e, l := remoteEnv(t)
	p := e.page("P")
	x, _ := l.api(apiX)
	y, _ := l.api(apiY)
	next, third := strings.Repeat("ab", 32), strings.Repeat("cd", 32)
	reloads := func() float64 {
		t.Helper()
		st := decode[obj](t, e.expect(200, "GET", "/api/remote/status", ""))
		n, ok := st["secretReloads"].(float64)
		if st["listening"] != true || !ok || strings.Contains(fmt.Sprint(st), testSecret) || strings.Contains(fmt.Sprint(st), next) {
			t.Fatalf("the status: %v", st)
		}
		return n
	}
	if n := reloads(); n != 0 {
		t.Fatalf("%v reloads before any", n)
	}

	if n := e.s.ReloadSecret(next); n != 2 {
		t.Fatalf("ReloadSecret closed %d streams, want 2", n)
	}
	// The old secret is refused, on every route, and the streams it opened have ended.
	for _, rq := range [][2]string{{"GET", "/api/hello"}, {"GET", "/api/state"}, {"GET", "/api/events"}, {"POST", "/api/chats"}} {
		if status, out := l.call(apiX, testSecret, rq[0], rq[1], ""); status != 401 || strings.TrimSpace(out) != `{"error":"unauthorized"}` {
			t.Fatalf("%s %s with the old secret: %d %s", rq[0], rq[1], status, out)
		}
	}
	x.ExpectEnded()
	y.ExpectEnded()
	if e.s.Bridge.Known(apiX) || e.s.Bridge.Known(apiY) {
		t.Fatal("an API client is still connected")
	}
	// The page's stream stays.
	if !e.s.Bridge.Known("P") || len(e.reach(p)[0]) != 0 {
		t.Fatal("the page's stream did not stay as it was")
	}
	if n := reloads(); n != 1 {
		t.Fatalf("%v reloads after one", n)
	}
	// A new stream needs the new secret.
	if status, out := l.call(apiX, next, "GET", "/api/hello", ""); status != 200 {
		t.Fatalf("hello with the new secret: %d %s", status, out)
	}
	x2 := bridgetest.ConnectWith(t, l.base, apiX, l.options(apiX, next))
	x2.Welcome()
	if got := e.reach(x2, p); len(got[0]) != 0 || len(got[1]) != 0 {
		t.Fatalf("after the reload: %v", got)
	}
	// A second reload, with one stream open.
	if n := e.s.ReloadSecret(third); n != 1 || reloads() != 2 {
		t.Fatalf("the second reload closed %d streams; %v reloads", n, reloads())
	}
	x2.ExpectEnded()
	if status, _ := l.call(apiX, next, "GET", "/api/hello", ""); status != 401 {
		t.Fatalf("hello with the second secret after the third was set: %d", status)
	}
	// With none open it closes none.
	if n := e.s.ReloadSecret(third); n != 0 || reloads() != 3 {
		t.Fatalf("a reload with no stream closed %d; %v reloads", n, reloads())
	}

	// No log line holds a secret.
	lines := l.logged()
	if len(lines) == 0 {
		t.Fatal("the refused requests were not logged")
	}
	for _, line := range lines {
		for _, s := range []string{testSecret, next, third} {
			if strings.Contains(line, s) {
				t.Fatalf("a log line holds a secret: %q", line)
			}
		}
	}

	// With remote access off there is nothing to do.
	off := newEnv(t)
	if n := off.s.ReloadSecret(next); n != 0 || off.s.Remote != nil {
		t.Fatalf("ReloadSecret with remote access off: %d", n)
	}
	if out := strings.TrimSpace(off.expect(200, "GET", "/api/remote/status", "")); out != `{"listening":false}` {
		t.Fatalf("the status with remote access off: %s", out)
	}
}

// A stream whose request passed the secret check before a reload and is recorded after it would
// stay open with the old secret: it gets no snapshot and ends at once.
func TestStreamAcrossAReloadEnds(t *testing.T) {
	e := newEnv(t, withRemote)
	stream := func(gen int64) (*httptest.ResponseRecorder, chan struct{}, context.CancelFunc) {
		ctx, cancel := context.WithCancel(context.WithValue(context.Background(), remoteKey{}, remoteCall{secretGen: gen}))
		req := httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx)
		req.Header.Set(ClientHeader, apiX)
		w, done := httptest.NewRecorder(), make(chan struct{})
		go func() {
			defer close(done)
			e.s.apiEvents(w, req)
		}()
		return w, done, cancel
	}
	before := e.s.Remote.secretGen.Load()
	e.s.ReloadSecret(strings.Repeat("ab", 32))

	// Checked before the reload.
	w, done, cancel := stream(before)
	defer cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the stream of a request checked before the reload stays open")
	}
	if body := w.Body.String(); strings.Contains(body, `"agents"`) || strings.Contains(body, `"chats"`) {
		t.Fatalf("the stream was sent a snapshot: %s", body)
	}
	for deadline := time.Now().Add(5 * time.Second); e.s.Bridge.Known(apiX); time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the client's record stayed")
		}
	}
	// Checked after it: the stream stays open, with its snapshot.
	_, done, cancel2 := stream(e.s.Remote.secretGen.Load())
	select {
	case <-done:
		t.Fatal("the stream of a request checked after the reload ended")
	case <-time.After(100 * time.Millisecond):
	}
	if !e.s.Bridge.Known(apiX) {
		t.Fatal("the client is not connected")
	}
	cancel2()
	<-done
}

// ---- the consumer: internal/servers against the real listener ---------------------

// hooked keeps what a servers.Manager tells its hooks.
type hooked struct {
	mu     sync.Mutex
	snaps  []string
	events []string // "<type> <raw>", snapshots as "snapshot <raw>" too, in order
	states []servers.State
}

func (h *hooked) hooks() servers.Hooks {
	add := func(f func()) {
		h.mu.Lock()
		defer h.mu.Unlock()
		f()
	}
	return servers.Hooks{
		Snapshot: func(_ string, raw json.RawMessage) {
			add(func() { h.snaps = append(h.snaps, string(raw)); h.events = append(h.events, "snapshot "+string(raw)) })
		},
		Event: func(_, typ string, raw json.RawMessage) {
			add(func() { h.events = append(h.events, typ+" "+string(raw)) })
		},
		State: func(_ string, _, to servers.State) { add(func() { h.states = append(h.states, to) }) },
	}
}

// await waits until ok holds for what the hooks were told.
func (h *hooked) await(t *testing.T, what string, ok func(h *hooked) bool) {
	t.Helper()
	for deadline := time.Now().Add(15 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		h.mu.Lock()
		done := ok(h)
		events, states := slices.Clone(h.events), slices.Clone(h.states)
		h.mu.Unlock()
		if done {
			return
		}
		if time.Now().After(deadline) {
			for i, ev := range events {
				events[i] = ev[:min(len(ev), 80)]
			}
			t.Fatalf("waiting for %s: states %v, events %v", what, states, events)
		}
	}
}

// The connection another server makes (internal/servers: the test of the Servers dialog and the
// manager's own connection) against the real listener: the contract of the two packages.
func TestServersPackageAgainstTheListener(t *testing.T) {
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	timing := servers.Timing{Backoff: []time.Duration{20 * time.Millisecond, 40 * time.Millisecond}, Jitter: -1}
	opts := servers.Options{Root: t.TempDir(), LocalID: apiX, Version: "test", Timing: timing}
	target := servers.Target{Address: l.base, Secret: testSecret, SelfSigned: true, Pin: l.pin}
	ctx := t.Context()

	// The test of the dialog. A server that finds its own id there says so, at hello.
	if r := servers.TestConnection(ctx, target, servers.Identity{LocalID: ownID}, opts); r.OK || r.Outcome != servers.OutcomeIsLocal || r.Step != 4 {
		t.Fatalf("the test with the server's own id: %+v", r)
	}
	r := servers.TestConnection(ctx, target, servers.Identity{}, opts)
	if !r.OK || r.Outcome != servers.OutcomeConnected || r.Step != 5 || r.InstanceID != ownID || r.FeatureLevel != FeatureLevel || len(r.Agents) != 3 {
		t.Fatalf("the test: %+v", r)
	}
	wrong := target
	wrong.Secret = strings.Repeat("ab", 32)
	if r := servers.TestConnection(ctx, wrong, servers.Identity{}, opts); r.OK || r.Outcome != servers.OutcomeSecretRefused {
		t.Fatalf("the test with another secret: %+v", r)
	}
	// A server with no instance id of its own states no client id: every request is refused,
	// which reads as "not AI Whiteboard".
	noID := opts
	noID.LocalID = ""
	if r := servers.TestConnection(ctx, target, servers.Identity{}, noID); r.OK || r.Outcome != servers.OutcomeNotAIWB {
		t.Fatalf("the test of a server without an instance id: %+v", r)
	}
	if e.s.Bridge.Known(apiX) {
		t.Fatal("the test left a stream open")
	}

	// The manager: add, connect, the lists.
	m, err := servers.Open(opts)
	if err != nil {
		t.Fatal(err)
	}
	h := &hooked{}
	m.SetHooks(h.hooks())
	m.Start()
	t.Cleanup(m.Close)
	v, saved, res, err := m.Add(ctx, servers.Input{Name: "Studio", Address: l.base, Secret: testSecret, SelfSigned: true, Pin: l.pin}, false)
	if err != nil || !saved || res == nil || !res.OK || res.Step != 5 || res.FeatureLevel != 1 || v.InstanceID != ownID {
		t.Fatalf("add: %+v, saved %v, result %+v, %v", v, saved, res, err)
	}
	h.await(t, "the connection", func(h *hooked) bool { return slices.Contains(h.states, servers.StateConnected) && len(h.snaps) == 1 })
	if got, _ := m.View(v.ID); got.State != servers.StateConnected || got.Version == "" || len(got.Agents) != 3 {
		t.Fatalf("the entry: %+v", got)
	}
	lists, ok := m.Lists(v.ID)
	if !ok || lists.Home != "/home/owner" || lists.DefaultCwd != e.a.DefaultCwd || len(lists.Catalogs) != 3 || lists.Catalogs[model.Claude] == nil || len(lists.Agents) != 3 {
		t.Fatalf("the lists: %+v, %v", lists, ok)
	}
	if got := keysOf(t, h.snaps[0]); !slices.Equal(got, []string{"agents", "catalogs", "chats", "defaultCwd", "home", "runs", "states", "type"}) {
		t.Fatalf("the snapshot the hooks got: %v", got)
	}
	if !e.s.Bridge.Known(apiX) {
		t.Fatal("the manager's stream is not the API client's with its instance id")
	}

	// A creation call passed on, and its events through the hooks.
	reply, err := m.Do(ctx, v.ID, "POST", "/api/chats", []byte(startBody(chat1, t.TempDir())), 0)
	if err != nil || reply.Status != 200 {
		t.Fatalf("the creation call: %+v, %v", reply, err)
	}
	if got := decode[started](t, string(reply.Body)); !got.OK || !got.Started || !got.Sent || got.Chat == nil || got.Chat.ID != chat1 {
		t.Fatalf("the creation call's answer: %s", reply.Body)
	}
	has := func(typ string, parts ...string) func(h *hooked) bool {
		return func(h *hooked) bool {
			return slices.ContainsFunc(h.events, func(ev string) bool {
				return strings.HasPrefix(ev, typ+" ") && !slices.ContainsFunc(parts, func(p string) bool { return !strings.Contains(ev, p) })
			})
		}
	}
	h.await(t, "the chat's list events", func(h *hooked) bool { return has("chat", chat1)(h) && has("branch_state", chat1)(h) })
	// The read through the manager follows; the content comes through the hooks.
	if reply, err := m.Do(ctx, v.ID, "GET", "/api/chats/"+chat1+"/items", nil, 0); err != nil || reply.Status != 200 {
		t.Fatalf("the read: %+v, %v", reply, err)
	}
	emit(t, &sp.of(t, chat1).fakeAgent, agent.Event{Kind: agent.EvText, Text: "for the other server"})
	h.await(t, "the chat's content", has("chat_items", chat1, "for the other server"))
	h.mu.Lock()
	if !strings.HasPrefix(h.events[0], "snapshot ") {
		t.Errorf("the first thing the hooks got: %.60s", h.events[0])
	}
	h.mu.Unlock()

	// The secret changes: the entry ends as "secret not accepted", and sends no more.
	if n := e.s.ReloadSecret(strings.Repeat("cd", 32)); n != 1 {
		t.Fatalf("ReloadSecret closed %d streams", n)
	}
	h.await(t, "the entry to end as secret_not_accepted", func(h *hooked) bool {
		return len(h.states) > 0 && h.states[len(h.states)-1] == servers.StateSecretNotAccepted
	})
	if got, _ := m.View(v.ID); got.State != servers.StateSecretNotAccepted {
		t.Fatalf("the entry after the reload: %+v", got)
	}
	for _, line := range l.logged() {
		if strings.Contains(line, testSecret) {
			t.Fatalf("a log line holds the secret: %q", line)
		}
	}
}
