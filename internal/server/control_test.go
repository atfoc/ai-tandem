package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/version"
)

// controlDo asks the control socket's handler, which asks no secret.
func (e *env) controlDo(method, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	w := httptest.NewRecorder()
	e.s.ControlHandler(e.a.DataDir).ServeHTTP(w, req)
	return w
}

// control is the body of a request that the control socket answers with 200.
func (e *env) control(method, path string) string {
	e.t.Helper()
	w := e.controlDo(method, path)
	if w.Code != http.StatusOK {
		e.t.Fatalf("%s %s on the control socket: %d %s", method, path, w.Code, w.Body)
	}
	return w.Body.String()
}

// mcpStatusOf is the MCP part of the control socket's /status.
type mcpStatusOf struct {
	Listener struct {
		Port int    `json:"port"`
		URL  string `json:"url"`
		Up   bool   `json:"up"`
	} `json:"listener"`
	Chats []boardapi.Contact `json:"chats"`
}

func (e *env) mcpStatus() mcpStatusOf {
	e.t.Helper()
	return decode[struct{ MCP mcpStatusOf }](e.t, e.control("GET", "/status")).MCP
}

// The control socket's hello says what a command needs to tell the server of its own data folder
// from another: the app, the version, the level, the instance id, the pid and the data folder.
func TestControlHello(t *testing.T) {
	t.Parallel()
	const id = "3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c"
	e := newEnv(t, func(s *Server) { s.InstanceID = id })
	out := decode[map[string]any](t, e.control("GET", "/hello"))
	if len(out) != 6 || out["app"] != "ai-whiteboard" || out["version"] != version.Version || out["featureLevel"] != float64(FeatureLevel) ||
		out["instanceId"] != id || out["pid"] != float64(os.Getpid()) || out["dataDir"] != e.a.DataDir {
		t.Fatalf("hello: %v", out)
	}
	if out := decode[map[string]any](t, newRawEnv(t).control("GET", "/hello")); out["instanceId"] != nil || out["dataDir"] == nil {
		t.Fatalf("hello of a server without an instance id: %v", out)
	}
}

// /status says what the client listener serves and the MCP listener's identity with the last
// contacts. It holds no secret, and nothing else is served: no other route, no other method.
func TestControlStatus(t *testing.T) {
	t.Parallel()
	e := newEnv(t, func(s *Server) { s.MCPPort, s.MCPURL, s.MCPUp = 6006, boardapi.MCPURL, func() bool { return true } })
	st := decode[struct {
		Client struct {
			Listening     bool     `json:"listening"`
			Address       string   `json:"address"`
			Port          int      `json:"port"`
			Names         []string `json:"names"`
			Fingerprint   string   `json:"fingerprint"`
			SecretReloads int      `json:"secretReloads"`
		}
		MCP mcpStatusOf
	}](t, e.control("GET", "/status"))
	if c := st.Client; !c.Listening || c.Address != e.url || c.Port != e.l.port || len(c.Names) != 1 || c.Names[0] != "127.0.0.1" ||
		c.Fingerprint != e.l.pin || c.SecretReloads != 0 {
		t.Fatalf("the client part: %+v (the listener's address %s, pin %s)", c, e.url, e.l.pin)
	}
	if st.MCP.Listener.Port != 6006 || !st.MCP.Listener.Up || len(st.MCP.Chats) != 0 {
		t.Fatalf("the MCP part: %+v", st.MCP)
	}
	if got := e.control("GET", "/status"); strings.Contains(got, testSecret) || strings.Contains(strings.ToLower(got), "secret\":\"") {
		t.Fatalf("the status holds the secret: %s", got)
	}

	// After a reload of the secret it counts it.
	e.s.ReloadSecret(strings.Repeat("ab", 32))
	if n := decode[struct{ Client struct{ SecretReloads int } }](t, e.control("GET", "/status")).Client.SecretReloads; n != 1 {
		t.Fatalf("secretReloads after a reload: %d", n)
	}

	// A server whose listener does not serve says so.
	raw := newRawEnv(t, withClients)
	if got := decode[struct{ Client map[string]any }](t, raw.control("GET", "/status")).Client; len(got) != 1 || got["listening"] != false {
		t.Fatalf("the client part of a server that does not serve: %v", got)
	}

	for _, rq := range [][2]string{{"POST", "/hello"}, {"GET", "/api/hello"}, {"GET", "/api/state"}, {"GET", "/"}, {"GET", "/api/mcp/status"},
		{"POST", "/status"}, {"GET", "/stop"}, {"GET", "/secret"}} {
		if w := e.controlDo(rq[0], rq[1]); w.Code != 404 && w.Code != 405 {
			t.Errorf("%s %s on the control socket: %d %s", rq[0], rq[1], w.Code, w.Body)
		}
	}
}

// The client API is the same for this machine's app as for any: the control socket's routes are
// no route of the client listener, and a client cannot reach them with the secret.
func TestControlRoutesAreNotClientRoutes(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	for _, path := range []string{"/hello", "/status"} {
		if code, out := e.do("GET", path, ""); code != 404 {
			t.Errorf("GET %s on the client listener: %d %s, want 404", path, code, out)
		}
	}
}

func TestControlMCPStatus(t *testing.T) {
	t.Parallel()
	e := newEnv(t, func(s *Server) {
		s.MCPPort = 6006
		s.MCPURL = boardapi.MCPURL
		s.MCPUp = func() bool { return true }
	})
	// Listener shape before any contact; the control socket asks no secret and no client id.
	out := e.mcpStatus()
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

	body := e.control("GET", "/status")
	if strings.Contains(body, token) {
		t.Fatalf("status leaks the board token: %s", body)
	}
	if strings.Contains(body, "not-a-real-token") {
		t.Fatalf("status leaks the unknown credential: %s", body)
	}
	st := e.mcpStatus()
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
