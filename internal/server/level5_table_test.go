package server

import (
	"bytes"
	"image"
	imagepng "image/png"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// The table of the remote port (contract 2.2 and 2.3): a client reaches every route of the
// table, as the server's own page does, and no route outside it.

// l5Table is the table of the contract's 2.3, written out here: a route that joins or leaves
// RemoteRoutes must join or leave the contract too.
var l5Table = []string{
	"GET /api/hello", "GET /api/events", "GET /api/state",
	"POST /api/groups", "PATCH /api/groups/{id}", "POST /api/groups/{id}/move", "DELETE /api/groups/{id}",
	"POST /api/groups/{id}/archive", "POST /api/groups/{id}/unarchive",
	"POST /api/chats",
	"GET /api/chats/{id}", "GET /api/chats/{id}/items", "GET /api/chats/{id}/tree", "GET /api/chats/{id}/context",
	"GET /api/chats/{id}/subagents/{sid}/items",
	"PATCH /api/chats/{id}",
	"POST /api/chats/{id}/messages", "POST /api/chats/{id}/interrupt", "POST /api/chats/{id}/permission", "POST /api/chats/{id}/open",
	"PUT /api/chats/{id}/label", "PUT /api/chats/{id}/draft",
	"POST /api/chats/{id}/images", "GET /api/chats/{id}/images/{image}",
	"POST /api/chats/{id}/fork",
	"POST /api/chats/{id}/archive", "POST /api/chats/{id}/unarchive", "DELETE /api/chats/{id}", "POST /api/chats/{id}/unfollow",
	"GET /api/dirs", "GET /api/usage/{agent}",
	"POST /api/runs", "GET /api/runs/{id}", "PATCH /api/runs/{id}", "PUT /api/runs/{id}/draft", "POST /api/runs/{id}/start",
	"POST /api/runs/{id}/stop", "POST /api/runs/{id}/resume", "POST /api/runs/{id}/apply", "GET /api/runs/{id}/delivery", "DELETE /api/runs/{id}",
	"GET /api/runs/{id}/detail", "GET /api/runs/{id}/goal", "GET /api/runs/{id}/tasks/{tid}/brief",
	"GET /api/runs/{id}/tasks/{tid}/attempts/{n}/report", "GET /api/runs/{id}/tasks/{tid}/attempts/{n}/changes", "GET /api/runs/{id}/notes/{v}",
	"POST /api/runs/{id}/archive", "POST /api/runs/{id}/unarchive", "POST /api/runs/{id}/unfollow",
	"POST /api/boards",
	"GET /api/boards/{id}/scene", "PUT /api/boards/{id}/scene", "POST /api/boards/{id}/take", "POST /api/boards/{id}/release",
	"POST /api/boards/{id}/rename", "POST /api/boards/{id}/archive", "POST /api/boards/{id}/unarchive", "POST /api/boards/{id}/seen",
	"DELETE /api/boards/{id}", "PATCH /api/boards/{id}",
	"POST /api/rpc-reply",
	"GET /api/library", "POST /api/library/{server}/groups", "PATCH /api/library/{server}/groups/{id}", "DELETE /api/library/{server}/groups/{id}",
	"POST /api/library/{server}/prompts", "PATCH /api/library/{server}/prompts/{id}", "DELETE /api/library/{server}/prompts/{id}",
}

// l5Outside is what the contract's 2.3 names as not in the table, each as a request, and the
// four calls that went away at level 5.
var (
	l5Outside = [][2]string{
		{"PUT", "/api/groups/order"}, {"POST", "/api/boards/{board}/reveal"}, {"POST", "/api/restart"},
		{"GET", "/api/remote/status"}, {"GET", "/api/mcp/status"}, {"POST", "/api/client/flushed"},
		{"GET", "/api/servers"}, {"POST", "/api/servers"}, {"PATCH", "/api/servers/s_0123456789ab"}, {"DELETE", "/api/servers/s_0123456789ab"},
		{"GET", "/api/servers/s_0123456789ab/items"}, {"POST", "/api/servers/test"}, {"POST", "/api/servers/s_0123456789ab/test"},
		{"POST", "/api/servers/s_0123456789ab/accept"}, {"GET", "/api/servers/anything/else"},
		{"GET", "/api/on/s_0123456789ab/chats/{chat}"}, {"POST", "/api/on/s_0123456789ab/chats"}, {"GET", "/api/on/local/chats/{chat}"},
		{"POST", "/api/on/s_0123456789ab/groups"}, {"GET", "/api/on"}, {"DELETE", "/api/on/s_0123456789ab/boards/{board}"},
		{"GET", "/"}, {"GET", "/index.html"}, {"GET", "/version.json"}, {"GET", "/assets/app.js"}, {"HEAD", "/"},
		{"GET", "/api"}, {"GET", "/api/"}, {"GET", "/api/chats"}, {"GET", "/api/groups"}, {"GET", "/api/boards"}, {"GET", "/api/runs"},
		{"POST", "/api/state"}, {"POST", "/api/events"}, {"DELETE", "/api/hello"}, {"GET", "/api/boards/{board}"},
	}
	l5Gone = []string{"PUT /api/chats/{id}", "PUT /api/runs/{id}", "GET /api/runs/check", "PUT /api/boards/{id}"}
)

func TestLevel5TableIsTheContracts(t *testing.T) {
	t.Parallel()
	got, want := slices.Clone(RemoteRoutes), slices.Clone(l5Table)
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		for _, r := range got {
			if !slices.Contains(want, r) {
				t.Errorf("RemoteRoutes has %q, which the contract's table has not", r)
			}
		}
		for _, r := range want {
			if !slices.Contains(got, r) {
				t.Errorf("RemoteRoutes lacks %q of the contract's table", r)
			}
		}
		if len(got) != len(want) {
			t.Errorf("RemoteRoutes has %d routes, the contract's table %d", len(got), len(want))
		}
	}
	for _, r := range l5Gone {
		if slices.Contains(RemoteRoutes, r) {
			t.Errorf("%q is still in the table", r)
		}
	}
	// Every route of the table is one the server registers: none is a name for nothing.
	e := newEnv(t)
	registered := e.s.routes().patterns
	for _, r := range RemoteRoutes {
		if !slices.Contains(registered, r) {
			t.Errorf("the route %q of the table is not registered", r)
		}
	}
}

// l5Picture is a small PNG.
func l5Picture(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := imagepng.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// l5Rows asks routes of the table as one client and notes which were asked.
type l5Rows struct {
	t      *testing.T
	c      *bridgetest.Page
	called map[string]bool
}

// ask is the call of the route with id for {id}, query after the path and this body. It must be
// answered with this status by the route's own handler, in a body that holds has. It returns
// the body.
func (r *l5Rows) ask(route, id, query string, body any, want int, has string) string {
	r.t.Helper()
	if !slices.Contains(RemoteRoutes, route) {
		r.t.Fatalf("%s is no route of the table", route)
	}
	r.called[route] = true
	method, path, _ := strings.Cut(route, " ")
	path = strings.NewReplacer("{id}", id, "{sid}", "s1", "{agent}", "claude", "{tid}", "t1", "{n}", "1", "{v}", "1", "{server}", "local").Replace(path)
	status, out := l5Call(r.c, method, path+query, body)
	if out == l5Gate || out == l5TooOld || status == 401 || status == 403 {
		r.t.Fatalf("%s: the listener's own answer, %d %s", route, status, out)
	}
	if status != want || !strings.Contains(out, has) {
		r.t.Fatalf("%s%s: %d %s, want %d with %s", route, query, status, out, want, has)
	}
	return out
}

// image reads the image of the chat as the client, which must get its bytes.
func (r *l5Rows) image(chat, image string) []byte {
	r.t.Helper()
	const route = "GET /api/chats/{id}/images/{image}"
	r.called[route] = true
	status, out := r.c.Do("GET", "/api/chats/"+chat+"/images/"+image, nil)
	if status != 200 {
		r.t.Fatalf("%s: %d %s", route, status, out)
	}
	return out
}

// A client that made nothing on the server calls every route of the table for what the owner
// made: each is answered by its handler, as for the server's own page.
func TestLevel5TableRoutesServeAClient(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	e.fake.Script(func(turn *agenttest.Turn) { turn.Say("At work."); turn.Hang() })
	group, board, chat := l5Tree(e.env)
	// The chat gets a message below and its agent hangs: the chat is deleted before the server
	// of the test stops, so that nothing writes into its folder while the folder is removed.
	t.Cleanup(func() { e.a.DeleteChat(chat) })
	run := l5ID(t, e.expect(200, "POST", "/api/runs", `{"group":"`+group+`","name":"The owners run"}`))
	x, _ := e.l.api(apiX)
	rows := &l5Rows{t: t, c: x, called: map[string]bool{"GET /api/events": true}} // the stream is the one x has open
	ask := rows.ask
	const done = `{"ok":true}`

	ask("GET /api/hello", "", "", nil, 200, `"featureLevel":5`)
	ask("GET /api/state", "", "", nil, 200, chat)

	// Groups.
	gx := l5ID(t, ask("POST /api/groups", "", "", `{"name":"Made by X"}`, 200, `"name":"Made by X"`))
	ask("PATCH /api/groups/{id}", group, "", `{"name":"Renamed by X"}`, 200, done)
	ask("POST /api/groups/{id}/move", gx, "", `{"parent":"`+group+`","before":""}`, 200, done)
	ask("POST /api/groups/{id}/archive", gx, "", nil, 200, done)
	ask("POST /api/groups/{id}/unarchive", gx, "", nil, 200, done)
	ask("DELETE /api/groups/{id}", gx, "?contents=keep", nil, 200, done)

	// Chats: the owner's chat, before its first message and after.
	cx := l5ID(t, ask("POST /api/chats", "", "", `{"agent":"claude","group":"`+group+`"}`, 200, `"locked":false`))
	ask("GET /api/chats/{id}", chat, "", nil, 200, "The owners chat")
	ask("GET /api/chats/{id}/items", chat, "", nil, 200, `"items":[]`)
	ask("GET /api/chats/{id}/tree", chat, "", nil, 200, `"current":"main"`)
	ask("GET /api/chats/{id}/context", chat, "", nil, 409, `{"error":"the context split shows after the first message"}`)
	ask("GET /api/chats/{id}/subagents/{sid}/items", chat, "", nil, 404, `{"error":"no such subagent"}`)
	ask("PATCH /api/chats/{id}", chat, "", `{"name":"Renamed by X"}`, 200, `"name":"Renamed by X"`)
	ask("PUT /api/chats/{id}/draft", chat, "?rev=0", `{"text":"typed by X"}`, 200, `"rev":1`)
	status, uploaded := l5Raw(e.l, apiX, "POST", "/api/chats/"+chat+"/images?name=dot.png", "image/png", l5Picture(t))
	if status != 200 || !strings.Contains(uploaded, `"type":"image/png"`) || !strings.Contains(uploaded, `"name":"dot.png"`) {
		t.Fatalf("the upload of an image by a client: %d %s", status, uploaded)
	}
	rows.called["POST /api/chats/{id}/images"] = true
	img := l5ID(t, uploaded)
	if got := rows.image(chat, img); !bytes.Equal(got, l5Picture(t)) {
		t.Errorf("the image a client reads back is %d bytes, not the %d it sent", len(got), len(l5Picture(t)))
	}
	ask("POST /api/chats/{id}/messages", chat, "", `{"text":"hello from X"}`, 200, `"branch":"main"`)
	ask("POST /api/chats/{id}/permission", chat, "", `{"requestId":"p1","allow":true}`, 400, "no longer open")
	ask("POST /api/chats/{id}/interrupt", chat, "", nil, 200, done)
	ask("PUT /api/chats/{id}/label", chat, "", `{"branch":"main","item":0,"text":"first"}`, 200, `"labels":[{`)
	ask("POST /api/chats/{id}/open", chat, "?branch=main", nil, 200, done)
	ask("POST /api/chats/{id}/fork", chat, "", `{}`, 400, `{"error":"at is missing"}`)
	ask("POST /api/chats/{id}/unfollow", chat, "", nil, 200, done)
	ask("POST /api/chats/{id}/archive", cx, "", nil, 200, done)
	ask("POST /api/chats/{id}/unarchive", cx, "", nil, 200, done)
	ask("DELETE /api/chats/{id}", cx, "", nil, 200, done)

	ask("GET /api/dirs", "", "?path="+url.QueryEscape(e.cwd), nil, 200, `"path":"`+e.cwd+`"`)
	ask("GET /api/usage/{agent}", "", "", nil, 404, `{"error":"usage not available"}`)

	// Runs: the owner's run, which has not started.
	rx := l5ID(t, ask("POST /api/runs", "", "", `{"group":"`+group+`","name":"Made by X"}`, 200, `"status":"draft"`))
	ask("GET /api/runs/{id}", run, "", nil, 200, "The owners run")
	ask("PATCH /api/runs/{id}", run, "", `{"name":"Renamed by X"}`, 200, `"name":"Renamed by X"`)
	ask("PUT /api/runs/{id}/draft", run, "", `{"text":"The goal, typed by X."}`, 200, done)
	ask("POST /api/runs/{id}/start", run, "", `{"goal":""}`, 400, `{"error":"the goal is empty"}`)
	const notStarted = `{"error":"the run has not started"}`
	for _, route := range []string{"POST /api/runs/{id}/stop", "POST /api/runs/{id}/resume", "POST /api/runs/{id}/apply", "GET /api/runs/{id}/delivery",
		"GET /api/runs/{id}/detail", "GET /api/runs/{id}/goal"} {
		ask(route, run, "", nil, 409, notStarted)
	}
	for _, route := range []string{"GET /api/runs/{id}/tasks/{tid}/brief", "GET /api/runs/{id}/tasks/{tid}/attempts/{n}/report",
		"GET /api/runs/{id}/tasks/{tid}/attempts/{n}/changes"} {
		ask(route, run, "", nil, 404, `{"error":"no such task"}`)
	}
	ask("GET /api/runs/{id}/notes/{v}", run, "", nil, 404, `{"error":"no such version"}`)
	ask("POST /api/runs/{id}/unfollow", run, "", nil, 200, done)
	ask("POST /api/runs/{id}/archive", run, "", nil, 200, done)
	ask("POST /api/runs/{id}/unarchive", run, "", nil, 200, done)
	ask("DELETE /api/runs/{id}", rx, "", nil, 200, done)

	// Boards: the owner's board, which the client reads, takes, draws on and files.
	bx := l5ID(t, ask("POST /api/boards", "", "", `{"name":"made-by-x","group":"`+group+`"}`, 200, `"name":"made-by-x"`))
	ask("POST /api/boards/{id}/release", bx, "", nil, 200, `{"state":"free"}`) // the client held what it made
	ask("GET /api/boards/{id}/scene", board, "", nil, 200, `"type":"excalidraw"`)
	ask("POST /api/boards/{id}/take", board, "", nil, 200, `"state":"held"`)
	ask("PUT /api/boards/{id}/scene", board, "?rev=0", `{"type":"excalidraw","elements":[{"id":"by-x"}]}`, 200, `"rev":1`)
	ask("POST /api/boards/{id}/release", board, "", nil, 200, `{"state":"free"}`)
	ask("POST /api/boards/{id}/rename", board, "", `{"name":"renamed-by-x"}`, 200, `"name":"renamed-by-x"`)
	ask("PATCH /api/boards/{id}", board, "", `{"group":"`+model.Ungrouped+`"}`, 200, done)
	ask("POST /api/boards/{id}/seen", board, "", nil, 200, done)
	ask("POST /api/boards/{id}/archive", board, "", nil, 200, done)
	ask("POST /api/boards/{id}/unarchive", board, "", nil, 200, done)
	ask("DELETE /api/boards/{id}", bx, "", nil, 200, done)
	ask("POST /api/rpc-reply", "", "", `{"id":"rpc_nobody_asked","result":{}}`, 409, `{"error":"not_asked"}`)

	// What the client did is the server's state, the owner's too.
	state := e.expect(200, "GET", "/api/state", "")
	for _, part := range []string{`"name":"Renamed by X"`, `"name":"renamed-by-x"`, "typed by X", "The goal, typed by X.", `"group":"` + model.Ungrouped + `"`} {
		if !strings.Contains(state, part) {
			t.Errorf("the owner's state lacks %s: %s", part, state)
		}
	}
	for _, id := range []string{gx, cx, rx, bx} {
		if strings.Contains(state, id) {
			t.Errorf("the owner's state still holds %s, which the client deleted", id)
		}
	}

	// The library routes, on a server that has a library.
	_, l2 := remoteEnv(t, func(s *Server) {
		if err := s.App.OpenLibrary(filepath.Join(t.TempDir(), "library")); err != nil {
			t.Fatal(err)
		}
	})
	y, _ := l2.api(apiY)
	rows.c = y
	ask("GET /api/library", "", "", nil, 200, `"libraries":[{`)
	lg := decode[struct{ Group struct{ ID string } }](t, ask("POST /api/library/{server}/groups", "", "", `{"name":"Prompts of Y"}`, 200, `"name":"Prompts of Y"`)).Group.ID
	ask("PATCH /api/library/{server}/groups/{id}", lg, "", `{"name":"Renamed by Y"}`, 200, `"name":"Renamed by Y"`)
	lp := decode[struct{ Prompt struct{ ID string } }](t, ask("POST /api/library/{server}/prompts", "", "", `{"name":"A prompt","parent":"`+lg+`","text":"Say hello."}`, 200, `"text":"Say hello."`)).Prompt.ID
	ask("PATCH /api/library/{server}/prompts/{id}", lp, "", `{"text":"Say goodbye."}`, 200, `"text":"Say goodbye."`)
	ask("DELETE /api/library/{server}/prompts/{id}", lp, "", nil, 200, done)
	ask("DELETE /api/library/{server}/groups/{id}", lg, "", nil, 200, done)

	for _, route := range RemoteRoutes {
		if !rows.called[route] {
			t.Errorf("the route %s of the table was not asked", route)
		}
	}
}

// What the bounds keep from a client (goal, section 5): the server list, restart, the order of
// the groups, the reveal of a file, the status routes, the calls that pass on to another server
// and the client files are 404 for it, while the owner's page is served them.
func TestLevel5RoutesOutsideTheTable(t *testing.T) {
	t.Parallel()
	files := t.TempDir()
	for name, content := range map[string]string{"index.html": "<!doctype html><title>the page</title>", "version.json": `{"version":"9.9.9"}`} {
		if err := os.WriteFile(filepath.Join(files, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var restarts atomic.Int32
	e, l := remoteEnv(t, func(s *Server) {
		s.Client = files
		s.Restart = func() error { restarts.Add(1); return nil }
	})
	group, board, chat := l5Tree(e)
	g2 := l5ID(t, e.expect(200, "POST", "/api/groups", `{"name":"Second"}`))
	x, _ := l.api(apiX)
	fill := strings.NewReplacer("{board}", board, "{chat}", chat, "{id}", board)
	before := e.expect(200, "GET", "/api/state", "")

	// Every request the contract names, and every route the server registers outside the table.
	asks := slices.Clone(l5Outside)
	for _, route := range e.s.routes().patterns {
		if slices.Contains(RemoteRoutes, route) {
			continue
		}
		method, path, found := strings.Cut(route, " ")
		if !found { // the client files: a pattern with no method
			method, path = "GET", route
		}
		asks = append(asks, [2]string{method, path})
	}
	for _, a := range asks {
		for _, body := range []any{nil, `{"ids":["` + g2 + `","` + group + `"],"name":"n","url":"https://127.0.0.1:1"}`} {
			status, out := l5Call(x, a[0], fill.Replace(a[1]), body)
			if a[0] == "HEAD" {
				if status != 404 {
					t.Errorf("%s %s for a client: %d", a[0], a[1], status)
				}
				continue
			}
			l5Is(t, a[0]+" "+a[1]+" for a client", status, out, 404, l5Gate)
		}
	}
	if restarts.Load() != 0 {
		t.Error("a client restarted the server")
	}
	if after := e.expect(200, "GET", "/api/state", ""); after != before {
		t.Errorf("the calls outside the table changed the server:\nbefore %s\nafter  %s", before, after)
	}

	// The same calls on the owner's port are served: the bound is the remote listener's.
	p := e.page(l5Owner)
	if out := l5Want(t, p, 200, "GET", "/", nil); !strings.Contains(out, "the page") {
		t.Errorf("the client files on the owner's port: %s", out)
	}
	if out := l5Want(t, p, 200, "GET", "/api/remote/status", nil); !strings.Contains(out, `"listening":true`) {
		t.Errorf("the remote status on the owner's port: %s", out)
	}
	l5Want(t, p, 200, "GET", "/api/mcp/status", nil)
	l5Want(t, p, 200, "POST", "/api/client/flushed", nil)
	l5Want(t, p, 200, "PUT", "/api/groups/order", `{"ids":["`+g2+`","`+group+`"]}`)
	if out := l5Want(t, p, 200, "GET", "/api/servers", nil); !strings.Contains(out, `"local"`) {
		t.Errorf("the server list on the owner's port: %s", out)
	}
	l5Want(t, p, 202, "POST", "/api/restart", nil)
	if restarts.Load() != 1 {
		t.Errorf("the owner's restart ran %d times", restarts.Load())
	}
	// And the order the owner set is the one the client is shown: it reads what it cannot write.
	snap := decode[struct{ Groups []model.Group }](t, l5Want(t, x, 200, "GET", "/api/state", nil))
	if len(snap.Groups) != 2 || snap.Groups[0].ID != g2 || snap.Groups[1].ID != group {
		t.Errorf("the groups a client is shown after the owner's reorder: %+v", snap.Groups)
	}
}

// The four calls that went away at level 5 are 404 on the remote port, with the bodies that
// made a chat, a run and a board before, and they make nothing.
func TestLevel5GoneCalls(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	group, board, chat := l5Tree(e.env)
	run := l5ID(t, e.expect(200, "POST", "/api/runs", `{"group":"`+group+`"}`))
	x, _ := e.l.api(apiX)
	before := e.expect(200, "GET", "/api/state", "")
	const newBoard = "b_cccc3333"
	for _, a := range [][3]string{
		{"PUT", "/api/chats/" + chat1, `{"agent":"claude","cwd":"` + e.cwd + `"}`}, // the make
		{"PUT", "/api/chats/" + chat, `{"agent":"claude","cwd":"` + e.cwd + `"}`},
		{"PUT", "/api/runs/" + l5Run1, `{"agent":"claude","cwd":"` + e.cwd + `","goal":"Look around."}`}, // the start call
		{"PUT", "/api/runs/" + run, `{"agent":"claude","cwd":"` + e.cwd + `","goal":"Look around."}`},
		{"PUT", "/api/boards/" + newBoard, `{"name":"A client's board"}`}, // a client's creation of a board
		{"PUT", "/api/boards/" + board, `{"name":"A client's board"}`},
	} {
		status, out := l5Call(x, a[0], a[1], a[2])
		l5Is(t, a[0]+" "+a[1]+" on the remote port", status, out, 404, l5Gate)
	}
	// The draft check: its path is now a read of the run "check", which is not there.
	status, out := l5Call(x, "GET", "/api/runs/check?agent=claude&cwd="+url.QueryEscape(e.cwd), nil)
	l5Is(t, "the draft check on the remote port", status, out, 404, `{"code":"not_found","error":"no such run"}`)
	// The creation call with a text is the page's call now: its "text" is ignored, no agent starts.
	made := decode[model.ChatView](t, l5Want(t, x, 200, "POST", "/api/chats", `{"id":"`+chat2+`","agent":"claude","group":"`+model.Ungrouped+`","cwd":"`+e.cwd+`","text":"the first message"}`))
	if made.ID != chat2 || made.Locked {
		t.Errorf("the page's call with the fields of the creation call: %+v", made)
	}
	if got := keysOf(t, l5Want(t, x, 200, "GET", "/api/chats/"+chat2, nil)); slices.Contains(got, "started") || slices.Contains(got, "sent") {
		t.Errorf("the chat's view has the fields %v", got)
	}
	if items := l5Want(t, x, 200, "GET", "/api/chats/"+chat2+"/items", nil); !strings.Contains(items, `"items":[]`) {
		t.Errorf("the chat made with a text has a thread: %s", items)
	}
	l5Want(t, x, 200, "DELETE", "/api/chats/"+chat2, nil)
	if after := e.expect(200, "GET", "/api/state", ""); after != before {
		t.Errorf("the calls that are gone changed the server:\nbefore %s\nafter  %s", before, after)
	}
	for _, dir := range []string{e.st.P.ChatDir(chat1), filepath.Join(e.a.DataDir, "runs", l5Run1)} {
		if _, err := os.Stat(dir); err == nil {
			t.Errorf("a call that is gone made %s", dir)
		}
	}
	if _, found := e.a.Boards.Get(newBoard); found {
		t.Error("a call that is gone made a board")
	}
}

// The same four calls are not served on the owner's port either: nothing is registered for them
// there, so the answer is the mux's own, 404 or, where the path has other methods, 405.
func TestLevel5GoneCallsOnTheOwnersPort(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	group, board, chat := l5Tree(e.env)
	run := l5ID(t, e.expect(200, "POST", "/api/runs", `{"group":"`+group+`"}`))
	p := e.page(l5Owner)
	for _, a := range [][2]string{
		{"PUT", "/api/chats/" + chat1}, {"PUT", "/api/chats/" + chat},
		{"PUT", "/api/runs/" + l5Run1}, {"PUT", "/api/runs/" + run},
		{"GET", "/api/runs/check?agent=claude&cwd=" + url.QueryEscape(e.cwd)},
		{"PUT", "/api/boards/b_cccc3333"}, {"PUT", "/api/boards/" + board},
	} {
		var body any
		if a[0] == "PUT" {
			body = `{"agent":"claude","cwd":"` + e.cwd + `","goal":"Look around.","name":"n"}`
		}
		if status, out := l5Call(p, a[0], a[1], body); status != 404 && status != 405 {
			t.Errorf("%s %s on the owner's port: %d %s, want 404 or 405", a[0], a[1], status, out)
		}
	}
	if n := len(e.a.Chats.Views()); n != 1 {
		t.Errorf("%d chats after the calls that are gone, want the one", n)
	}
	if n := len(e.rs.List()); n != 1 {
		t.Errorf("%d runs after the calls that are gone, want the one", n)
	}
	if n := len(e.a.Boards.List()); n != 1 {
		t.Errorf("%d boards after the calls that are gone, want the one", n)
	}
}

// GET /api/dirs lists no folder of the app's own to a client: not the data folder, nothing in
// it, not the folder of the runs' checkouts, by whatever path they are named. The owner's page
// lists them.
func TestLevel5DirsKeepsTheDataFolderFromAClient(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	_, _, chat := l5Tree(e.env)
	x, _ := e.l.api(apiX)
	p := e.page(l5Owner)
	const refusal = `{"error":"the app's own folder can't be used as a working folder"}`
	work := e.st.P.RunWorkDir(l5Run1)
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(e.a.DataDir, link); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{e.a.DataDir, e.st.P.ChatDir(chat), filepath.Dir(e.st.P.ChatDir(chat)), filepath.Join(e.a.DataDir, "runs"),
		e.a.DataDir + "/", filepath.Join(e.a.DataDir, "runs", ".."), link, e.st.P.RunWork, work} {
		status, out := l5Call(x, "GET", "/api/dirs?path="+url.QueryEscape(dir), nil)
		l5Is(t, "the folder "+dir+" for a client", status, out, 400, refusal)
		if strings.Contains(out, chat) || strings.Contains(out, `"dirs"`) {
			t.Errorf("the refusal of %s lists something: %s", dir, out)
		}
		if out := l5Want(t, p, 200, "GET", "/api/dirs?path="+url.QueryEscape(dir), nil); !strings.Contains(out, `"dirs":[`) {
			t.Errorf("the folder %s for the owner's page: %s", dir, out)
		}
	}
	// The chats' folder holds the ids of the chats: that is what the owner is listed and the
	// client is not.
	if out := l5Want(t, p, 200, "GET", "/api/dirs?path="+url.QueryEscape(filepath.Dir(e.st.P.ChatDir(chat))), nil); !strings.Contains(out, chat) {
		t.Errorf("the chats' folder for the owner's page: %s", out)
	}
	// Any other folder of the machine is listed to a client, the parent of the data folder too.
	sub := filepath.Join(e.cwd, "inside")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	got := decode[struct {
		Path string
		Dirs []string
	}](t, l5Want(t, x, 200, "GET", "/api/dirs?path="+url.QueryEscape(e.cwd), nil))
	if got.Path != e.cwd || !slices.Equal(got.Dirs, []string{"inside"}) {
		t.Errorf("a folder of the machine for a client: %+v", got)
	}
	if out := l5Want(t, x, 200, "GET", "/api/dirs", nil); !strings.Contains(out, `"path":"`+e.cwd+`"`) {
		t.Errorf("the default folder for a client: %s", out)
	}
}
