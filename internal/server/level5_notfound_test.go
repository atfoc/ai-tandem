package server

import (
	"slices"
	"strings"
	"testing"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// The code "not_found" (contract 2.4): on both listeners, a 404 whose cause is that the chat,
// the run, the board or the group the call names is not there carries it, and a 404 for a part
// of a thing that is there keeps what it had. It is how a client and a page tell "the thing is
// gone" from "a part of it is missing".

// The ids of things no server of a test has.
const (
	l5NoChat  = chat3
	l5NoRun   = "r_nothere1"
	l5NoBoard = "b_nothere1"
	l5NoGroup = "g_nothere1"
	l5NoImage = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

// l5Bodies is, for the routes that read a body or a query before they look the thing up, a
// query and a body that pass that reading.
var l5Bodies = map[string][2]string{
	"PATCH /api/groups/{id}":          {"", `{"name":"Renamed"}`},
	"POST /api/groups/{id}/move":      {"", `{"parent":"","before":""}`},
	"DELETE /api/groups/{id}":         {"?contents=keep", ""},
	"PATCH /api/chats/{id}":           {"", `{"name":"Renamed"}`},
	"POST /api/chats/{id}/messages":   {"", `{"text":"hello"}`},
	"POST /api/chats/{id}/permission": {"", `{"requestId":"perm-1","allow":true}`},
	"PUT /api/chats/{id}/label":       {"", `{"branch":"main","item":0,"text":"label"}`},
	"PUT /api/chats/{id}/draft":       {"?rev=0", `{"text":"typed"}`},
	"POST /api/chats/{id}/images":     {"?name=dot.png", `not an image`},
	"POST /api/chats/{id}/fork":       {"", `{"branch":"main","at":1}`},
	"PATCH /api/runs/{id}":            {"", `{"name":"Renamed"}`},
	"PUT /api/runs/{id}/draft":        {"", `{"text":"The goal."}`},
	"POST /api/runs/{id}/start":       {"", `{"goal":"Look around."}`},
	"PUT /api/boards/{id}/scene":      {"?rev=0", `{"type":"excalidraw","elements":[]}`},
	"POST /api/boards/{id}/rename":    {"", `{"name":"renamed"}`},
	"PATCH /api/boards/{id}":          {"", `{"group":"` + model.Ungrouped + `"}`},
}

// l5NotLookups is the routes with an {id} that look nothing up: each ends something for the
// caller, and there is nothing to end for a thing that is not there.
var l5NotLookups = map[string]string{
	"POST /api/chats/{id}/unfollow": `{"ok":true}`,
	"POST /api/runs/{id}/unfollow":  `{"ok":true}`,
	"POST /api/boards/{id}/release": `{"state":"none"}`,
}

// l5Kind is what a route with an {id} names: its path's word after /api/, the id of a thing of
// that kind that is not there, and the sentence of its refusal.
func l5Kind(route string) (id, sentence string, named bool) {
	_, path, _ := strings.Cut(route, " ")
	switch {
	case !strings.Contains(path, "{id}"):
	case strings.HasPrefix(path, "/api/chats/"):
		return l5NoChat, "no such chat", true
	case strings.HasPrefix(path, "/api/runs/"):
		return l5NoRun, "no such run", true
	case strings.HasPrefix(path, "/api/boards/"):
		return l5NoBoard, "no such board", true
	case strings.HasPrefix(path, "/api/groups/"):
		return l5NoGroup, `no such group \"` + l5NoGroup + `\"`, true
	}
	return "", "", false
}

// Every route that names a chat, a run, a board or a group by its id answers 404 "not_found"
// when there is none, on the remote port and on the server's own, with the same body.
func TestLevel5NotFoundOnEveryRouteWithAnID(t *testing.T) {
	t.Parallel()
	s := l5NewSite(t)
	before := l5Want(t, s.p, 200, "GET", "/api/state", nil)
	asked := 0
	for _, route := range s.s.routes().patterns {
		id, sentence, named := l5Kind(route)
		if !named || strings.HasSuffix(route, "/reveal") { // the reveal opens this machine's file manager
			continue
		}
		method, path, _ := strings.Cut(route, " ")
		path = strings.NewReplacer("{id}", id, "{sid}", "s1", "{image}", l5NoImage, "{tid}", "t1", "{n}", "1", "{v}", "1").Replace(path)
		var body any
		if b := l5Bodies[route][1]; b != "" {
			body = b
		}
		path += l5Bodies[route][0]
		want := `{"code":"not_found","error":"` + sentence + `"}`
		for _, c := range s.all() {
			if c != s.p && !slices.Contains(RemoteRoutes, route) {
				continue // outside the table: the owner's alone
			}
			status, out := l5Call(c, method, path, body)
			if answer, plain := l5NotLookups[route]; plain {
				l5Is(t, route+" for a thing that is not there, by "+s.who(c), status, out, 200, answer)
				continue
			}
			l5Is(t, route+" for a thing that is not there, by "+s.who(c), status, out, 404, want)
			asked++
		}
	}
	if asked < 140 { // some fifty routes, each asked by the three
		t.Errorf("only %d calls were asked: the routes with an {id} are not what the test thinks", asked)
	}
	// A thing named in the body: the board or the run a new chat is for, the group of a run.
	for _, c := range s.all() {
		for body, sentence := range map[string]string{
			`{"agent":"claude","board":"` + l5NoBoard + `"}`: "no such board",
		} {
			status, out := l5Call(c, "POST", "/api/chats", body)
			l5Is(t, "POST /api/chats "+body+" by "+s.who(c), status, out, 404, `{"code":"not_found","error":"`+sentence+`"}`)
		}
		status, out := l5Call(c, "POST", "/api/runs", `{"group":"`+l5NoGroup+`","name":"Run"}`)
		if status != 404 || decode[map[string]string](t, out)["code"] != "not_found" {
			t.Errorf("POST /api/runs in a group that is not there by %s: %d %s", s.who(c), status, out)
		}
	}
	// Nothing was made by any of it, and nobody follows what is not there.
	if after := l5Want(t, s.p, 200, "GET", "/api/state", nil); after != before {
		t.Errorf("the calls for things that are not there changed the server:\nbefore %s\nafter  %s", before, after)
	}
	for _, it := range []editorbridge.Item{editorbridge.Chat(l5NoChat), editorbridge.Run(l5NoRun)} {
		if got := s.s.Bridge.Followers(it); len(got) != 0 {
			t.Errorf("the followers of %v, which is not there: %v", it, got)
		}
	}
	for i, evs := range s.reach(s.all()...) {
		if len(evs) != 0 {
			t.Errorf("the calls for things that are not there sent %s %v", s.who(s.all()[i]), evs)
		}
	}
}

// A 404 for a part that is missing of a thing that is there keeps its own answer: a branch, a
// subagent, an image, a task, an attempt, a version of the notes. None of them says "not_found".
func TestLevel5MissingPartIsNotNotFound(t *testing.T) {
	t.Parallel()
	s := l5NewSite(t)
	s.plan(nil)
	chat := l5ID(t, l5Want(t, s.p, 200, "POST", "/api/chats", `{"agent":"claude","group":"`+model.Ungrouped+`"}`))
	run := l5ID(t, l5Want(t, s.x, 200, "POST", "/api/runs", `{"group":"`+model.Ungrouped+`","name":"Run"}`))
	l5Want(t, s.x, 200, "POST", "/api/runs/"+run+"/start", `{"goal":"Look around."}`)
	l5Await(t, s.x, "/api/runs/"+run, `"status":"completed"`)
	task := decode[model.RunDetail](t, l5Want(t, s.y, 200, "GET", "/api/runs/"+run+"/detail", nil)).Tasks[0].ID
	// The parts that are there, so that what follows is about the part and not the thing.
	l5Want(t, s.x, 200, "GET", "/api/runs/"+run+"/tasks/"+task+"/brief", nil)
	l5Want(t, s.x, 200, "GET", "/api/runs/"+run+"/tasks/"+task+"/attempts/1/report", nil)
	l5Want(t, s.x, 200, "GET", "/api/runs/"+run+"/notes/1", nil)

	for _, c := range []struct {
		what, method, path, body string
		answer                   string
	}{
		{"a draft for a branch the chat does not have", "PUT", "/api/chats/" + chat + "/draft?rev=0&branch=nothere", `{"text":"typed"}`, `{"code":"no_branch","error":"no such branch"}`},
		{"the thread of a branch the chat does not have", "GET", "/api/chats/" + chat + "/items?branch=nothere", ``, `{"error":"no such branch"}`},
		{"the open of a branch the chat does not have", "POST", "/api/chats/" + chat + "/open?branch=nothere", ``, `{"error":"no such branch"}`},
		{"a message to a branch the chat does not have", "POST", "/api/chats/" + chat + "/messages?branch=nothere", `{"text":"hello"}`, `{"error":"no such branch"}`},
		{"a subagent the chat does not have", "GET", "/api/chats/" + chat + "/subagents/s1/items", ``, `{"error":"no such subagent"}`},
		{"an image the chat does not hold", "GET", "/api/chats/" + chat + "/images/" + l5NoImage, ``, `{"error":"no such image"}`},
		{"a task the run does not have", "GET", "/api/runs/" + run + "/tasks/t_nothere/brief", ``, `{"error":"no such task"}`},
		{"the report of a task the run does not have", "GET", "/api/runs/" + run + "/tasks/t_nothere/attempts/1/report", ``, `{"error":"no such task"}`},
		{"an attempt the task does not have", "GET", "/api/runs/" + run + "/tasks/" + task + "/attempts/9/report", ``, `{"error":"no such attempt"}`},
		{"the changes of an attempt the task does not have", "GET", "/api/runs/" + run + "/tasks/" + task + "/attempts/9/changes", ``, `{"error":"no such attempt"}`},
		{"a version of the notes the run does not have", "GET", "/api/runs/" + run + "/notes/9", ``, `{"error":"no such version"}`},
	} {
		var body any
		if c.body != "" {
			body = c.body
		}
		for _, by := range s.all() {
			status, out := l5Call(by, c.method, c.path, body)
			l5Is(t, c.what+", by "+s.who(by), status, out, 404, c.answer)
			if strings.Contains(out, "not_found") {
				t.Errorf("%s: a part that is missing is answered as a thing that is gone: %s", c.what, out)
			}
		}
	}
	// A read of a part that is missing leaves the follow of the thing, which is there.
	if got := s.s.Bridge.Followers(editorbridge.Chat(chat)); len(got) != 3 {
		t.Errorf("the followers of the chat after the reads of a subagent it does not have: %v", got)
	}
}

// After one client deleted a thing, the other client's call for it, and the owner's, is 404
// "not_found": the thing is gone for everyone, and each was told so.
func TestLevel5DeletedByOneIsGoneForAll(t *testing.T) {
	t.Parallel()
	s := l5NewSite(t)
	s.fake.Script(func(turn *agenttest.Turn) { turn.Say("Done.") })
	group := l5ID(t, s.step(s.x, "a group", "POST", "/api/groups", `{"name":"Short-lived"}`, "groups", ""))
	chat := l5ID(t, s.step(s.x, "a chat", "POST", "/api/chats", `{"agent":"claude","group":"`+group+`"}`, "chat", ""))
	board := l5ID(t, s.step(s.x, "a board", "POST", "/api/boards", `{"name":"board","group":"`+group+`"}`, "board", ""))
	l5Want(t, s.x, 200, "POST", "/api/boards/"+board+"/release", nil)
	run := l5ID(t, s.step(s.x, "a run", "POST", "/api/runs", `{"group":"`+group+`","name":"Run"}`, "run", ""))
	// The other client and the owner have the chat open, and read the rest.
	for _, c := range []*bridgetest.Page{s.y, s.p} {
		l5Want(t, c, 200, "GET", "/api/chats/"+chat+"/items", nil)
		l5Want(t, c, 200, "GET", "/api/boards/"+board+"/scene", nil)
		l5Want(t, c, 200, "GET", "/api/runs/"+run, nil)
	}

	s.step(s.x, "the delete of the chat", "DELETE", "/api/chats/"+chat, nil, "chat_removed", chat)
	s.step(s.x, "the delete of the board", "DELETE", "/api/boards/"+board, nil, "board_removed", board)
	s.step(s.x, "the delete of the run", "DELETE", "/api/runs/"+run, nil, "run_removed", run)
	l5Want(t, s.x, 200, "DELETE", "/api/groups/"+group+"?contents=delete", nil)
	s.told("the delete of the group", "defaults")

	gone := func(sentence string) string { return `{"code":"not_found","error":"` + sentence + `"}` }
	for _, c := range []struct {
		method, path, body string
		answer             string
	}{
		{"GET", "/api/chats/" + chat, ``, gone("no such chat")},
		{"GET", "/api/chats/" + chat + "/items", ``, gone("no such chat")},
		{"GET", "/api/chats/" + chat + "/tree", ``, gone("no such chat")},
		{"POST", "/api/chats/" + chat + "/messages", `{"text":"hello"}`, gone("no such chat")},
		{"PUT", "/api/chats/" + chat + "/draft?rev=0", `{"text":"typed"}`, gone("no such chat")},
		{"PATCH", "/api/chats/" + chat, `{"name":"Renamed"}`, gone("no such chat")},
		{"DELETE", "/api/chats/" + chat, ``, gone("no such chat")},
		{"GET", "/api/boards/" + board + "/scene", ``, gone("no such board")},
		{"POST", "/api/boards/" + board + "/take", ``, gone("no such board")},
		{"PUT", "/api/boards/" + board + "/scene?rev=0", `{"elements":[]}`, gone("no such board")},
		{"POST", "/api/boards/" + board + "/rename", `{"name":"renamed"}`, gone("no such board")},
		{"DELETE", "/api/boards/" + board, ``, gone("no such board")},
		{"POST", "/api/chats", `{"agent":"claude","board":"` + board + `"}`, gone("no such board")},
		{"GET", "/api/runs/" + run, ``, gone("no such run")},
		{"GET", "/api/runs/" + run + "/detail", ``, gone("no such run")},
		{"PATCH", "/api/runs/" + run, `{"name":"Renamed"}`, gone("no such run")},
		{"POST", "/api/runs/" + run + "/start", `{"goal":"Look around."}`, gone("no such run")},
		{"DELETE", "/api/runs/" + run, ``, gone("no such run")},
		{"PATCH", "/api/groups/" + group, `{"name":"Renamed"}`, gone(`no such group \"` + group + `\"`)},
		{"POST", "/api/groups/" + group + "/archive", ``, gone(`no such group \"` + group + `\"`)},
		{"DELETE", "/api/groups/" + group + "?contents=keep", ``, gone(`no such group \"` + group + `\"`)},
		{"POST", "/api/groups", `{"name":"Nested","parent":"` + group + `"}`, gone(`no such group \"` + group + `\"`)},
	} {
		var body any
		if c.body != "" {
			body = c.body
		}
		for _, by := range s.all() { // the one that deleted it too
			status, out := l5Call(by, c.method, c.path, body)
			l5Is(t, c.method+" "+c.path+" after the delete, by "+s.who(by), status, out, 404, c.answer)
		}
	}
	// The follows of the chat ended with it, and nothing is listed any more.
	if got := s.s.Bridge.Followers(editorbridge.Chat(chat)); len(got) != 0 {
		t.Errorf("the followers of the deleted chat: %v", got)
	}
	for _, c := range s.all() {
		state := l5Want(t, c, 200, "GET", "/api/state", nil)
		for _, id := range []string{chat, board, run, group} {
			if strings.Contains(state, id) {
				t.Errorf("the state of %s still holds %s", s.who(c), id)
			}
		}
	}
}

// A new chat on a run that is not there names a thing that is gone, as a call with the run's id
// in its path does: 404 "not_found" on both listeners, and no chat is made.
func TestLevel5NewChatOnARunThatIsNotThere(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	x, _ := l.api(apiX)
	p := e.page(l5Owner)
	for _, c := range []*bridgetest.Page{x, p} {
		l5Code(t, c, 404, "not_found", "POST", "/api/chats", `{"agent":"claude","run":"r_nothere0"}`)
	}
	if n := len(e.a.Chats.Views()); n != 0 {
		t.Errorf("%d chats after the refused calls", n)
	}
}
