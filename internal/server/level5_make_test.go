package server

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remote"
)

// What a client makes (contract 2.4, goal 3.4): a chat and a board are made by the calls of the
// server's own page, in the place the call names, with what the server remembers for
// that place. A call that names a server is refused and makes nothing.

// l5ServerRefused is the answer to a client's call that names a server, and l5ServerBodies what
// such a call may hold beside its own fields: any value, and the key in any letter case.
const l5ServerRefused = `{"code":"server_refused","error":"an API client cannot name a server"}`

var l5ServerBodies = []string{`"server":"local"`, `"server":""`, `"server":null`, `"server":"s_0123456789ab"`, `"server":"` + ownID + `"`,
	`"server":7`, `"server":{}`, `"Server":"local"`, `"SERVER":""`, `"sErVeR":null`}

// l5Trio is the owner's page and the two clients of a server. The set-up events
// are read: reach returns what was sent from here on.
func l5Trio(e *env, l *listener) (p, x, y *bridgetest.Page) {
	p = e.page(l5Owner)
	x, _ = l.api(apiX)
	y, _ = l.api(apiY)
	return p, x, y
}

// l5AllSame fails unless each of the three was sent the same list events and the same content
// events since the last reach, and returns them. Content events go to who follows the thing, so
// the three are the same only where all of them follow it, or none does.
func l5AllSame(t *testing.T, e *env, what string, three ...*bridgetest.Page) []string {
	t.Helper()
	return l5SameOf(t, what, e.reach(three...), three...)
}

// l5SameOf is l5AllSame for events that were read already, one list per client.
func l5SameOf(t *testing.T, what string, evs [][]string, three ...*bridgetest.Page) []string {
	t.Helper()
	typs := append(slices.Clone(l5List), "tree", "chat_items", "sub", "sub_items")
	first := only(evs[0], typs...)
	for i, c := range three {
		if got := only(evs[i], typs...); !slices.Equal(got, first) {
			t.Fatalf("%s: %s was sent\n%s\nand %s\n%s", what, c.ID, strings.Join(got, "\n"), three[0].ID, strings.Join(first, "\n"))
		}
		for _, raw := range evs[i] {
			l5Unmarked(t, "an event of "+what, raw)
		}
		if i > 0 {
			l5NoPageEvents(t, c, evs[i])
		}
	}
	return first
}

func TestLevel5ClientMakesAChatInItsPlace(t *testing.T) {
	t.Parallel()
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	p, x, y := l5Trio(e, l)
	three := []*bridgetest.Page{p, x, y}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	// The owner's page sets what the group remembers, by the choices of a chat of its own.
	g := l5ID(t, l5Want(t, p, 200, "POST", "/api/groups", `{"name":"Work"}`))
	own := l5ID(t, l5Want(t, p, 200, "POST", "/api/chats", `{"agent":"claude","group":"`+g+`"}`))
	l5Want(t, p, 200, "PATCH", "/api/chats/"+own, `{"agent":"claude","model":"opus","effort":"max","cwd":"`+dir+`","subDepth":2,"subCap":7}`)
	l5AllSame(t, e, "the owner's set-up", three...)
	remembered := func(what string, v model.ChatView, group, mdl, effort string) {
		t.Helper()
		if v.Agent != model.Claude || v.Group != group || v.Cwd != dir || v.Model != mdl || v.Effort != effort || v.SubDepth != 2 || v.SubCap != 7 || v.Locked {
			t.Errorf("%s: %+v, want a Claude chat in %s with %s, %s, the folder %s and the subagent settings 2 and 7", what, v, group, mdl, effort, dir)
		}
	}

	// A chat in a group, with no agent and no id: the answer is the chat, with what the group
	// remembers. It is in the group it was made in, and all three are told.
	out := l5Want(t, x, 200, "POST", "/api/chats", `{"group":"`+g+`"}`)
	made := decode[model.ChatView](t, out)
	remembered("a client's chat in the group", made, g, "opus", "max")
	if !remote.ValidID(made.ID) || !strings.Contains(out, `"locked":false`) {
		t.Errorf("a client's chat: %s", out)
	}
	for _, k := range []string{"started", "sent", "chat", "ok", "server", "client", "board"} {
		if slices.Contains(keysOf(t, out), k) {
			t.Errorf("the answer of a client's POST /api/chats has %q: %s", k, out)
		}
	}
	evs := l5AllSame(t, e, "a client's new chat", three...)
	if got := l5Types(evs); !slices.Equal(got, []string{"branch_state", "chat"}) || l5Count(evs, "chat", made.ID, `"group":"`+g+`"`) != 1 {
		t.Errorf("a client's new chat told %v", evs)
	}
	if view := decode[model.ChatView](t, l5Want(t, p, 200, "GET", "/api/chats/"+made.ID, nil)); view.Group != g {
		t.Errorf("the owner reads the client's chat in %q, want the group %s", view.Group, g)
	}
	// No group appears for it: the server's groups are the one the owner made.
	groups := decode[struct{ Groups []model.Group }](t, l5Want(t, p, 200, "GET", "/api/state", nil)).Groups
	if len(groups) != 1 || groups[0].ID != g || groups[0].Name != "Work" {
		t.Errorf("the groups after a client's chat: %+v", groups)
	}
	e.st.Read(func(s *model.State) {
		if s.RemoteGroup != "" {
			t.Errorf("the state names the group %q as the group Remote", s.RemoteGroup)
		}
	})

	// Outside any group: what the server starts a chat with where nothing is remembered.
	loose := decode[model.ChatView](t, l5Want(t, y, 200, "POST", "/api/chats", `{"group":"`+model.Ungrouped+`"}`))
	if loose.Group != model.Ungrouped || loose.Agent != model.Claude || loose.Model != "sonnet" || loose.Effort != "high" || loose.Cwd == dir || loose.SubDepth != 1 || loose.SubCap != 100 {
		t.Errorf("a client's chat outside any group: %+v", loose)
	}

	// With an id of the caller's making. The fields of a call that is gone are ignored: nothing
	// names the chat, no folder, model or first message is taken from the body.
	out = l5Want(t, x, 200, "POST", "/api/chats", `{"id":"`+chat1+`","agent":"claude","group":"`+g+`","cwd":"`+t.TempDir()+`","model":"haiku","effort":"low","name":"Named by the call","text":"the first message","client":"`+apiY+`"}`)
	withID := decode[model.ChatView](t, out)
	remembered("a client's chat with an id", withID, g, "opus", "max")
	if withID.ID != chat1 || withID.Name != "" || strings.Contains(out, "first message") {
		t.Errorf("a client's chat with an id: %s", out)
	}
	if _, err := os.Stat(e.st.P.ChatDir(chat1)); err != nil {
		t.Errorf("the folder of the chat made with an id: %v", err)
	}
	if items := l5Want(t, x, 200, "GET", "/api/chats/"+chat1+"/items", nil); !strings.Contains(items, `"items":[]`) || l5Started(sp) != 0 {
		t.Errorf("a new chat has a thread or an agent: %s, %d agents", items, l5Started(sp))
	}
	l5Want(t, x, 200, "POST", "/api/chats/"+chat1+"/unfollow", nil)
	// The same id twice, and an id of another form: refused as for the server's own page.
	n := len(e.a.Chats.Views())
	for _, c := range []struct {
		id     string
		status int
		answer string
	}{
		{chat1, 409, `{"error":"a chat with this id already exists"}`},
		{made.ID, 409, `{"error":"a chat with this id already exists"}`},
		{"abc", 400, `{"error":"a chat id must be a lowercase version 4 UUID"}`},
		{strings.ToUpper(l5Z), 400, `{"error":"a chat id must be a lowercase version 4 UUID"}`},
		{strings.Replace(chat2, "-4222-", "-1222-", 1), 400, `{"error":"a chat id must be a lowercase version 4 UUID"}`},
		{"{" + chat2 + "}", 400, `{"error":"a chat id must be a lowercase version 4 UUID"}`},
		{"../" + chat2, 400, `{"error":"a chat id must be a lowercase version 4 UUID"}`},
	} {
		body := map[string]any{"id": c.id, "agent": "claude", "group": g}
		for _, by := range three {
			status, out := l5Call(by, "POST", "/api/chats", body)
			l5Is(t, "a chat with the id "+c.id+" by "+by.ID, status, out, c.status, c.answer)
		}
	}
	if got := len(e.a.Chats.Views()); got != n {
		t.Errorf("the refused ids made %d chats", got-n)
	}
	l5AllSame(t, e, "the chats so far", three...)

	// On a board the owner made: the chat is the board's, and has no group of its own.
	board := l5ID(t, l5Want(t, p, 200, "POST", "/api/boards", `{"name":"plan","group":"`+g+`"}`))
	out = l5Want(t, y, 200, "POST", "/api/chats", `{"agent":"claude","board":"`+board+`"}`)
	if on := decode[model.ChatView](t, out); on.Board != board || on.Group != "" || on.Locked || on.Model != "opus" || on.Cwd != dir {
		t.Errorf("a client's chat on the owner's board: %s", out)
	}
	evs = l5AllSame(t, e, "a client's chat on a board", three...)
	if l5Count(evs, "chat", `"board":"`+board+`"`) != 1 {
		t.Errorf("a client's chat on a board told %v", evs)
	}

	// The agent is remembered too: in a group where the owner chose Cursor, a client's chat
	// with no agent is a Cursor chat.
	g2 := l5ID(t, l5Want(t, p, 200, "POST", "/api/groups", `{"name":"Cursor work"}`))
	own2 := l5ID(t, l5Want(t, p, 200, "POST", "/api/chats", `{"agent":"claude","group":"`+g2+`"}`))
	l5Want(t, p, 200, "PATCH", "/api/chats/"+own2, `{"agent":"cursor"}`)
	if v := decode[model.ChatView](t, l5Want(t, y, 200, "POST", "/api/chats", `{"group":"`+g2+`"}`)); v.Agent != model.Cursor || v.Group != g2 {
		t.Errorf("a client's chat in a group that remembers Cursor: %+v", v)
	}
	if v := decode[model.ChatView](t, l5Want(t, y, 200, "POST", "/api/chats", `{"agent":"claude","group":"`+g2+`"}`)); v.Agent != model.Claude {
		t.Errorf("a client's chat that names its agent: %+v", v)
	}
	l5AllSame(t, e, "the chats of the second group", three...)

	// The chat feeds what the group remembers, as the owner's chat does: the next chat there,
	// the owner's and the other client's, starts with the client's choice.
	l5Want(t, x, 200, "PATCH", "/api/chats/"+made.ID, `{"model":"sonnet","effort":"low"}`)
	evs = l5AllSame(t, e, "a client's choice", three...)
	if l5Count(evs, "defaults", g, `"model":"sonnet","effort":"low"`) != 1 || l5Count(evs, "branch_state", made.ID, `"effort":"low"`) != 1 {
		t.Errorf("a client's choice told %v", evs)
	}
	for _, by := range []*bridgetest.Page{p, y} {
		next := decode[model.ChatView](t, l5Want(t, by, 200, "POST", "/api/chats", `{"group":"`+g+`"}`))
		remembered("the next chat in the group, by "+by.ID, next, g, "sonnet", "low")
	}
	l5AllSame(t, e, "the next chats", three...)

	// A body that names a server, whatever the value: refused, and nothing is made: no chat,
	// no folder, no event.
	n = len(e.a.Chats.Views())
	for _, server := range l5ServerBodies {
		for _, place := range []string{`"group":"` + g + `"`, `"group":"` + model.Ungrouped + `"`, `"board":"` + board + `"`} {
			body := `{"id":"` + chat2 + `","agent":"claude",` + place + `,` + server + `}`
			status, out := l5Call(x, "POST", "/api/chats", body)
			l5Is(t, "POST /api/chats with "+body, status, out, 400, l5ServerRefused)
		}
	}
	// The refusal comes before the body is looked at: a call that would be refused for
	// something else is refused for the server.
	status, out := l5Call(x, "POST", "/api/chats", `{"id":"abc","server":"local"}`)
	l5Is(t, "a call with a bad id and a server", status, out, 400, l5ServerRefused)
	if got := len(e.a.Chats.Views()); got != n {
		t.Errorf("the refused calls made %d chats", got-n)
	}
	if _, err := os.Stat(e.st.P.ChatDir(chat2)); err == nil {
		t.Error("a refused call made the chat's folder")
	}
	if evs := l5AllSame(t, e, "the refused calls", three...); len(evs) != 0 {
		t.Errorf("the refused calls told %v", evs)
	}
	// The refusal is a client's alone: the server's own page may say "local".
	if v := decode[model.ChatView](t, l5Want(t, p, 200, "POST", "/api/chats", `{"agent":"claude","group":"`+g+`","server":"local"}`)); v.Group != g {
		t.Errorf("the owner's chat that names this computer: %+v", v)
	}
	l5AllSame(t, e, "the owner's chat", three...)

	// The first message is the message call, from whoever sends it: the agent starts on the
	// chat's folder and model, and all three see the chat at work.
	if out := l5Want(t, y, 200, "POST", "/api/chats/"+chat1+"/messages", `{"text":"the first message"}`); out != `{"branch":"main","ok":true}` {
		t.Errorf("the first message: %s", out)
	}
	ag := sp.of(t, chat1)
	if ag.sends.Load() != 1 || l5Started(sp) != 1 {
		t.Errorf("the first message started %d agents and sent %d messages", l5Started(sp), ag.sends.Load())
	}
	sp.mu.Lock()
	opts := sp.opts[0]
	sp.mu.Unlock()
	if opts.ChatID != chat1 || opts.Cwd != dir || opts.Model != "opus" || opts.Effort != "max" {
		t.Errorf("the agent of the first message started with %+v", opts)
	}
	evs = l5AllSame(t, e, "the first message", three...)
	if l5Count(evs, "chat", chat1, `"locked":true`) == 0 || l5Count(evs, "branch_state", chat1, `"locked":true`) == 0 {
		t.Errorf("the first message told %v", evs)
	}
	reply(t, &ag.fakeAgent, "Done.", "point-1")
	if v := decode[model.ChatView](t, l5Want(t, x, 200, "GET", "/api/chats/"+chat1, nil)); !v.Locked || v.Status != "ready" {
		t.Errorf("the chat after its first turn: %+v", v)
	}
}

func TestLevel5ClientMakesABoard(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	p, x, y := l5Trio(e, l)
	three := []*bridgetest.Page{p, x, y}
	g := l5ID(t, l5Want(t, p, 200, "POST", "/api/groups", `{"name":"Work"}`))
	l5AllSame(t, e, "the set-up", three...)
	const drawing = `{"type":"excalidraw","elements":[{"id":"one"}]}`

	// In the group named. The board is free, so the client that made it holds it: its write of
	// the drawing is taken, another client's is not.
	out := l5Want(t, x, 200, "POST", "/api/boards", `{"name":"The plan","group":"`+g+`","new":true}`)
	made := decode[model.Board](t, out)
	if got := keysOf(t, out); !slices.Equal(got, []string{"created", "group", "id", "name", "new"}) || !strings.HasPrefix(made.ID, "b_") || made.Group != g || made.Name != "The-plan" || !made.New {
		t.Fatalf("a client's board: %s", out)
	}
	evs := l5AllSame(t, e, "a client's new board", three...)
	if got := l5Types(evs); !slices.Equal(got, []string{"board"}) || l5Count(evs, "board", made.ID, `"group":"`+g+`"`, `"new":true`) != 1 {
		t.Errorf("a client's new board told %v", evs)
	}
	if holder, held := e.s.Bridge.HolderOf(made.ID); !held || holder != apiX {
		t.Errorf("the holder of a client's new board: %q (held %v), want the client", holder, held)
	}
	if out := l5Want(t, x, 200, "PUT", "/api/boards/"+made.ID+"/scene?rev=0", drawing); out != `{"ok":true,"rev":1}` {
		t.Errorf("the write of the client that made the board: %s", out)
	}
	for _, c := range []*bridgetest.Page{y, p} {
		l5Code(t, c, 409, "not_holder", "PUT", "/api/boards/"+made.ID+"/scene?rev=1", drawing)
	}
	if scene := l5Want(t, p, 200, "GET", "/api/boards/"+made.ID+"/scene", nil); !l5Same(t, scene, drawing) {
		t.Errorf("the owner reads the drawing of a client's board as %s", scene)
	}
	// It is in no other group, and no group was made for it.
	if groups := l5Field(t, l5Want(t, p, 200, "GET", "/api/state", nil), "groups"); !l5Same(t, groups, `[{"id":"`+g+`","name":"Work"}]`) {
		t.Errorf("the groups after a client's board: %s", groups)
	}

	// Outside any group, by the other client.
	loose := decode[model.Board](t, l5Want(t, y, 200, "POST", "/api/boards", `{"name":"loose","group":"`+model.Ungrouped+`"}`))
	if loose.Group != model.Ungrouped || loose.New {
		t.Errorf("a client's board outside any group: %+v", loose)
	}
	if holder, _ := e.s.Bridge.HolderOf(loose.ID); holder != apiY {
		t.Errorf("the holder of the second client's board: %q", holder)
	}
	// A caller with no stream makes the board too, and holds nothing: nobody holds it.
	status, out := l.call(l5Z, testSecret, "POST", "/api/boards", `{"name":"no-stream","group":"`+g+`"}`)
	if status != 200 {
		t.Fatalf("a board by a caller with no stream: %d %s", status, out)
	}
	noStream := l5ID(t, out)
	if holder, held := e.s.Bridge.HolderOf(noStream); held {
		t.Errorf("the board of a caller with no stream is held by %q", holder)
	}
	status, out = l.call(l5Z, testSecret, "PUT", "/api/boards/"+noStream+"/scene?rev=0", drawing)
	l5Is(t, "the write of a caller with no stream", status, strings.TrimSpace(out), 409, `{"code":"not_holder","error":"this window does not hold the board"}`)
	l5AllSame(t, e, "the boards so far", three...)

	// The page's refusals.
	n := len(e.a.Boards.List())
	for _, c := range []struct {
		body   string
		status int
		answer string
	}{
		{`{"name":"b"}`, 400, `{"error":"group is empty (use \"__ungrouped__\" for ungrouped)"}`},
		{`{"name":"b","group":""}`, 400, `{"error":"group is empty (use \"__ungrouped__\" for ungrouped)"}`},
		{`{"name":"b","group":"g_nothere"}`, 400, `{"error":"no such group \"g_nothere\""}`},
		{`not json`, 400, ""},
	} {
		for _, by := range three {
			status, out := l5Call(by, "POST", "/api/boards", c.body)
			if status != c.status || (c.answer != "" && out != c.answer) {
				t.Errorf("POST /api/boards %s by %s: %d %s, want %d %s", c.body, by.ID, status, out, c.status, c.answer)
			}
		}
	}
	// A body that names a server: refused, nothing made, nothing told.
	for _, server := range l5ServerBodies {
		body := `{"name":"b","group":"` + g + `",` + server + `}`
		status, out := l5Call(x, "POST", "/api/boards", body)
		l5Is(t, "POST /api/boards with "+body, status, out, 400, l5ServerRefused)
	}
	status, out = l5Call(x, "POST", "/api/boards", `{"server":"local"}`)
	l5Is(t, "a board with no group and a server", status, out, 400, l5ServerRefused)
	if got := len(e.a.Boards.List()); got != n {
		t.Errorf("the refused calls made %d boards", got-n)
	}
	if evs := l5AllSame(t, e, "the refused calls", three...); len(evs) != 0 {
		t.Errorf("the refused calls told %v", evs)
	}
}
