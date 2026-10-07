package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// The fork and branch flow through the HTTP API, read as the web client reads it: every answer
// and event is checked by its JSON keys (web/src/types.ts, web/src/api.ts, web/src/conn.ts), not
// through the Go structs that wrote it.

// ---- fakes ----------------------------------------------------------------

// flowSpawner keeps the agents it starts, so the test can emit their events. It forks as it
// spawns (agent.Forker).
type flowSpawner struct {
	mu     sync.Mutex
	agents []*fakeAgent // Spawn's and SpawnFork's, in the order they started
}

func (s *flowSpawner) start() *fakeAgent {
	a := &fakeAgent{ch: make(chan agent.Event)}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.agents = append(s.agents, a)
	return a
}

func (s *flowSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	if _, err := os.Stat(o.Cwd); err != nil {
		return nil, agent.ErrFolderMissing
	}
	return s.start(), nil
}

func (s *flowSpawner) SpawnFork(o agent.SpawnOptions, src agent.ForkSource) (agent.Agent, string, error) {
	return s.start(), o.SessionID, nil
}

func (*flowSpawner) DiscardFork(string) {}

// last is the agent started last: the process of the chat or branch the last request started.
func (s *flowSpawner) last(t *testing.T) *fakeAgent {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.agents) == 0 {
		t.Fatal("no agent started")
	}
	return s.agents[len(s.agents)-1]
}

// flowSync is ignored by both the pump and the transcript. Sending it after an event proves the
// pump has finished with that event (the channel is unbuffered).
var flowSync = agent.Event{Kind: agent.EvToolInputDelta, ToolID: "__sync__"}

// emit gives the agent's events to its chat and returns once the chat has applied them.
func emit(t *testing.T, a *fakeAgent, evs ...agent.Event) {
	t.Helper()
	for _, ev := range append(evs, flowSync) {
		select {
		case a.ch <- ev:
		case <-time.After(5 * time.Second):
			t.Fatalf("pump did not take event %v", ev.Kind)
		}
	}
}

// reply ends the running turn of a's chat: one reply, then the end of the turn with point as its
// id ("" = the agent gave none).
func reply(t *testing.T, a *fakeAgent, text, point string) {
	t.Helper()
	emit(t, a, agent.Event{Kind: agent.EvText, Text: text}, agent.Event{Kind: agent.EvTurnEnd, Point: point})
}

// events is an SSE client that keeps what it is sent.
type events struct {
	mu  sync.Mutex
	all []map[string]any
}

// listen opens /api/events as clientID (the same tab reconnecting: it takes the stream over) and
// returns once it is the active client.
func (e *env) listen() *events {
	e.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	e.t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, "GET", e.url+"/api/events?client="+clientID, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	evs := &events{}
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
			if json.Unmarshal([]byte(line), &ev) == nil {
				evs.mu.Lock()
				evs.all = append(evs.all, ev)
				evs.mu.Unlock()
			}
		}
	}()
	evs.wait(e.t, "hello", 0, func(ev map[string]any) bool { return ev["type"] == "hello" })
	return evs
}

// count is how many events have arrived: the place a later wait starts from.
func (evs *events) count() int {
	evs.mu.Lock()
	defer evs.mu.Unlock()
	return len(evs.all)
}

// wait returns the first event at or after from that match accepts, waiting for it to arrive.
func (evs *events) wait(t *testing.T, what string, from int, match func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		evs.mu.Lock()
		for _, ev := range evs.all[min(from, len(evs.all)):] {
			if match(ev) {
				evs.mu.Unlock()
				return ev
			}
		}
		seen := len(evs.all) - min(from, len(evs.all))
		evs.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatalf("no %s event among %d", what, seen)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// ---- reading JSON as the client does ---------------------------------------

type obj = map[string]any

// get answers a GET as a JSON object.
func (e *env) get(path string) obj {
	e.t.Helper()
	return decode[obj](e.t, e.expect(200, "GET", path, ""))
}

// sameJSON fails unless got is the JSON want, key for key.
func sameJSON(t *testing.T, what string, got any, want string) {
	t.Helper()
	if w := decode[any](t, want); !reflect.DeepEqual(got, w) {
		g, _ := json.Marshal(got)
		t.Fatalf("%s\n got %s\nwant %s", what, g, want)
	}
}

// okAnswer fails unless out is {"ok": true}.
func okAnswer(t *testing.T, what, out string) {
	t.Helper()
	sameJSON(t, what, decode[any](t, out), `{"ok":true}`)
}

// chatAnswer fails unless out is PATCH /api/chats/{id}'s answer, {"ok": true, "chat": <the view of
// the chat at path>}, with nothing else in it. It returns the view.
func chatAnswer(t *testing.T, what, out, path string) map[string]any {
	t.Helper()
	got := decode[map[string]any](t, out)
	view, _ := got["chat"].(map[string]any)
	id, _ := view["id"].(string)
	if len(got) != 2 || got["ok"] != true || id == "" || !strings.HasSuffix(path, "/"+id) {
		t.Fatalf("%s\n got %s\nwant {\"ok\":true,\"chat\":{the view of %s}}", what, out, path)
	}
	return view
}

// sentOn fails unless out is the answer of a message that was put on branch: {"ok": true,
// "branch": branch}.
func sentOn(t *testing.T, what, out, branch string) {
	t.Helper()
	sameJSON(t, what, decode[any](t, out), `{"ok":true,"branch":"`+branch+`"}`)
}

// errorOf sends a request that must be refused with the status want and returns the answer's
// "error" text, which is never empty.
func (e *env) errorOf(want int, method, path, body string) string {
	e.t.Helper()
	msg, _ := decode[obj](e.t, e.expect(want, method, path, body))["error"].(string)
	if msg == "" {
		e.t.Fatalf("%s %s: status %d without an error text", method, path, want)
	}
	return msg
}

// absent fails when v has one of keys.
func absent(t *testing.T, what string, v obj, keys ...string) {
	t.Helper()
	for _, k := range keys {
		if _, ok := v[k]; ok {
			t.Fatalf("%s has %q: %v", what, k, v)
		}
	}
}

// ---- the flow -------------------------------------------------------------

func TestForkAndBranchFlow(t *testing.T) {
	sp := &flowSpawner{}
	e := newEnv(t, func(s *Server) { s.App.Chats.Spawners[model.Claude] = sp })
	evs := e.listen()

	// 1. A chat with two finished turns: each ends with an end mark that carries the point's id.
	id := e.chat(`{"agent":"claude","group":"__ungrouped__"}`).ID
	chat := "/api/chats/" + id
	e.get(chat + "/items") // the client opens the chat: the events of its thread go to who read it
	sentOn(t, "send", e.expect(200, "POST", chat+"/messages", `{"text":"ask","context":""}`), "main")
	main := sp.last(t)
	reply(t, main, "options", "p1")
	sentOn(t, "send", e.expect(200, "POST", chat+"/messages", `{"text":"redis","context":""}`), "main")
	reply(t, main, "lua", "p2")

	got := e.get(chat + "/items")
	if got["branch"] != "main" {
		t.Fatalf(`items: "branch" is %v`, got["branch"])
	}
	if _, ok := got["version"].(float64); !ok {
		t.Fatalf(`items: "version" is %v`, got["version"])
	}
	sameJSON(t, "items", got["items"], `[
		{"kind":"user","text":"ask"},
		{"kind":"text","text":"options","done":true},
		{"kind":"end","point":"p1"},
		{"kind":"user","text":"redis"},
		{"kind":"text","text":"lua","done":true},
		{"kind":"end","point":"p2"}
	]`)
	sameJSON(t, "subagents", got["subagents"], `[]`)
	if st, _ := got["state"].(obj); st["chat"] != id || st["branch"] != "main" || st["status"] != "ready" || st["locked"] != true {
		t.Fatalf(`items: "state" is %v`, got["state"])
	}
	sameJSON(t, "items by the branch's name", e.get(chat + "/items?branch=main")["items"], mustJSON(t, got["items"]))
	absent(t, "the view of an unsplit chat", e.get(chat), "branches", "branch", "forkedFrom", "forkedFromTitle", "forkedBranch", "forkedAt")

	// 2. A label on the first reply, and the tree: one branch, its items with the point rules.
	const label = `{"branch":"main","item":1,"text":"options"}`
	sameJSON(t, "label", decode[any](t, e.expect(200, "PUT", chat+"/label", label)), `{"labels":[`+label+`]}`)
	const mainBranch = `{"id":"main","at":0,"len":6,"items":[
		{"i":0,"kind":"user","text":"ask","before":0,"ok":true},
		{"i":1,"kind":"text","text":"options","done":true,"end":3,"ok":true},
		{"i":3,"kind":"user","text":"redis","before":3,"ok":true},
		{"i":4,"kind":"text","text":"lua","done":true,"end":6,"ok":true}
	]}`
	sameJSON(t, "tree", e.get(chat+"/tree"), `{"current":"main","branches":[`+mainBranch+`],"labels":[`+label+`]}`)

	// 3. Fork to new at the end of turn 1: the answer is the new chat's view.
	fork := decode[obj](t, e.expect(200, "POST", chat+"/fork", `{"branch":"main","at":3}`))
	fid, _ := fork["id"].(string)
	name, _ := fork["name"].(string)
	title, _ := fork["forkedFromTitle"].(string)
	if fid == "" || fid == id || fork["forkedFrom"] != id || fork["forkedBranch"] != "main" || fork["forkedAt"] != 3.0 || title == "" || name != title+" (fork)" || fork["agent"] != "claude" {
		t.Fatalf("fork %v", fork)
	}
	absent(t, "the fork's view", fork, "branches", "branch")
	var listed []any
	for _, c := range e.get("/api/state")["chats"].([]any) {
		listed = append(listed, c.(obj)["id"])
	}
	if !reflect.DeepEqual(listed, []any{id, fid}) && !reflect.DeepEqual(listed, []any{fid, id}) {
		t.Fatalf("chats listed after the fork: %v, want %s and %s", listed, id, fid)
	}
	const copied = `{"id":"main","at":0,"len":3,"items":[
		{"i":0,"kind":"user","text":"ask","before":0,"ok":true},
		{"i":1,"kind":"text","text":"options","done":true,"end":3,"ok":true}
	]}`
	sameJSON(t, "the fork's tree", e.get("/api/chats/"+fid+"/tree"), `{"current":"main","branches":[`+copied+`],"labels":[`+label+`]}`)
	sameJSON(t, "the fork's items", e.get("/api/chats/" + fid + "/items")["items"], `[
		{"kind":"user","text":"ask"},
		{"kind":"text","text":"options","done":true},
		{"kind":"end","point":"p1"}
	]`)

	// 4. A message to the end of turn 1, asking for a new branch.
	from := evs.count()
	sent := e.expect(200, "POST", chat+"/messages",
		`{"text":"memory","context":"","target":{"branch":"main","at":3,"new":true}}`)
	view := e.get(chat)
	b, _ := view["branch"].(string)
	if view["id"] != id || view["branches"] != 2.0 || b == "" || b == "main" {
		t.Fatalf("view after the branch %v", view)
	}
	sentOn(t, "send to a new branch", sent, b) // the answer names the branch that was made
	branch := sp.last(t)
	if branch == main {
		t.Fatal("the new branch started no process")
	}
	newBranch := `{"id":"` + b + `","from":"main","at":3,"len":4,"items":[
		{"i":3,"kind":"user","text":"memory","before":3,"ok":true}
	]}`
	sameJSON(t, "tree with two branches", e.get(chat+"/tree"),
		`{"current":"`+b+`","branches":[`+mainBranch+`,`+newBranch+`],"labels":[`+label+`]}`)
	got = e.get(chat + "/items")
	if got["branch"] != b {
		t.Fatalf(`items of the current branch: "branch" is %v, want %s`, got["branch"], b)
	}
	sameJSON(t, "items of the new branch", got["items"], `[
		{"kind":"user","text":"ask"},
		{"kind":"text","text":"options","done":true},
		{"kind":"end","point":"p1"},
		{"kind":"user","text":"memory"}
	]`)
	sameJSON(t, "items of the new branch by its id", e.get(chat + "/items?branch=" + b)["items"], mustJSON(t, got["items"]))
	first := e.get(chat + "/items?branch=main")
	if items, _ := first["items"].([]any); first["branch"] != "main" || len(items) != 6 {
		t.Fatalf("items of main while the new branch is current %v", first)
	}
	// Each answer has the state of the branch it serves: the new branch works, main does not.
	if st, _ := got["state"].(obj); st["chat"] != id || st["branch"] != b || st["status"] != "thinking" {
		t.Fatalf("state of the new branch %v", got["state"])
	}
	if st, _ := first["state"].(obj); st["chat"] != id || st["branch"] != "main" || st["status"] != "ready" {
		t.Fatalf("state of main while the new branch is current %v", first["state"])
	}
	var states []any
	for _, st := range e.get("/api/state")["states"].([]any) {
		if st := st.(obj); st["chat"] == id {
			states = append(states, st["branch"])
		}
	}
	if !reflect.DeepEqual(states, []any{"main", b}) && !reflect.DeepEqual(states, []any{b, "main"}) {
		t.Fatalf("states of the chat: %v", states)
	}
	if n := len(e.get("/api/state")["chats"].([]any)); n != 2 {
		t.Fatalf("%d chats listed after the branch, want 2", n)
	}

	// 7. What an SSE client saw of it: the chat's view naming the new branch, and the branch's
	// items under the chat's id and the branch's.
	ev := evs.wait(t, "chat", from, func(ev obj) bool {
		c, _ := ev["chat"].(obj)
		return ev["type"] == "chat" && c["id"] == id && c["branch"] == b
	})
	if c := ev["chat"].(obj); c["branches"] != 2.0 {
		t.Fatalf("chat event %v", ev)
	}
	reply(t, branch, "map", "q1")
	ev = evs.wait(t, "chat_items", from, func(ev obj) bool { return ev["type"] == "chat_items" && ev["chat"] == id })
	updates, _ := ev["updates"].([]any)
	if _, ok := ev["version"].(float64); ev["branch"] != b || !ok || len(updates) == 0 {
		t.Fatalf("chat_items event %v", ev)
	}
	if up, _ := updates[0].(obj); up["item"] == nil || up["index"] == nil {
		t.Fatalf("chat_items update %v", updates[0])
	}
	// "branch" is on every one of them, "main" for the first branch: turn 1 and 2 were main's.
	evs.wait(t, "chat_items of main", 0, func(ev obj) bool {
		return ev["type"] == "chat_items" && ev["chat"] == id && ev["branch"] == "main"
	})
	evs.mu.Lock()
	for _, ev := range evs.all {
		if _, ok := ev["branch"].(string); ev["type"] == "chat_items" && (!ok || ev["branch"] == "") {
			evs.mu.Unlock()
			t.Fatalf(`chat_items event without "branch": %v`, ev)
		}
	}
	evs.mu.Unlock()

	// 5. A message to the end of main, once the new branch's turn ended: main is carried on and
	// is current again.
	sentOn(t, "send to the end of main", e.expect(200, "POST", chat+"/messages",
		`{"text":"more","context":"","target":{"branch":"main","at":6,"new":false}}`), "main")
	view = e.get(chat)
	if view["branches"] != 2.0 {
		t.Fatalf("view back on main %v", view)
	}
	absent(t, "the view back on main", view, "branch")
	got = e.get(chat + "/items")
	if items, _ := got["items"].([]any); got["branch"] != "main" || len(items) != 7 {
		t.Fatalf("items back on main %v", got)
	}
	tree := e.get(chat + "/tree")
	if branches, _ := tree["branches"].([]any); tree["current"] != "main" || len(branches) != 2 {
		t.Fatalf("tree back on main %v", tree)
	}

	// 6. The status codes. Busy: 409, for the branch that works, which is main: without a
	// branch (main is the current one), by its end as a target, and by its name. (That the
	// chat's other branch takes a message meanwhile is TestMessagesAnswerNamesTheBranch.)
	for _, body := range []string{
		`{"text":"x","context":""}`,
		`{"text":"x","context":"","target":{"branch":"main","at":7,"new":false}}`,
	} {
		if out := decode[obj](t, e.expect(409, "POST", chat+"/messages", body)); out["error"] == "" || out["code"] != "busy" {
			t.Fatalf("busy with %s: %v", body, out)
		}
	}
	if out := decode[obj](t, e.expect(409, "POST", chat+"/messages?branch=main", `{"text":"x","context":""}`)); out["error"] == "" || out["code"] != "busy" {
		t.Fatalf("busy with ?branch=main: %v", out)
	}
	// A point after the message of main's running turn is no point for a new branch: 400.
	if out := decode[obj](t, e.expect(400, "POST", chat+"/messages", `{"text":"x","context":"","target":{"branch":"main","at":7,"new":true}}`)); out["error"] == "" || out["code"] != "bad_point" {
		t.Fatalf("a new branch in the running turn: %v", out)
	}
	// A fork of the end of the working branch is of a session that is still going: 409. Inside
	// its running turn there is no point (the message is at 6, so this needs no reply yet): the
	// same end. A finished boundary of it is forked while it works, and so is the other branch.
	if out := decode[obj](t, e.expect(409, "POST", chat+"/fork", `{"branch":"main","at":7}`)); out["error"] == "" || out["code"] != "busy" {
		t.Fatalf("fork of the end of a busy branch: %v", out)
	}
	live := decode[obj](t, e.expect(200, "POST", chat+"/fork", `{"branch":"main","at":3}`))
	if live["forkedFrom"] != id || live["forkedBranch"] != "main" || live["forkedAt"] != 3.0 {
		t.Fatalf("fork of a busy branch at a finished boundary: %v", live)
	}
	side := decode[obj](t, e.expect(200, "POST", chat+"/fork", `{"branch":"`+b+`","at":3}`))
	if side["forkedFrom"] != id || side["forkedBranch"] != b || side["forkedAt"] != 3.0 {
		t.Fatalf("fork of the other branch of a busy chat: %v", side)
	}
	sameJSON(t, "the forked view is the one listed", e.get("/api/chats/"+side["id"].(string)), mustJSON(t, side))
	if st := e.get(chat + "/items")["state"].(obj); st["status"] == "ready" {
		t.Fatalf("the forks stopped the working branch: %v", st)
	}
	// A branch and a target together: 400.
	if msg := e.errorOf(400, "POST", chat+"/messages?branch=main", `{"text":"x","context":"","target":{"branch":"main","at":3,"new":true}}`); msg != "branch and target together" {
		t.Fatalf("branch and target: %q", msg)
	}

	// A turn that ends without an id leaves a point no branch can start at: 400.
	reply(t, main, "sure", "") // main's process, which the new branch of step 4 did not stop
	got = e.get(chat + "/items")
	items, _ := got["items"].([]any)
	if len(items) != 9 {
		t.Fatalf("items after the turn without an id %v", got)
	}
	sameJSON(t, "an end mark without an id", items[8], `{"kind":"end"}`)
	bad := decode[obj](t, e.expect(400, "POST", chat+"/messages", `{"text":"x","context":"","target":{"branch":"main","at":9,"new":true}}`))
	if bad["error"] == "" || bad["code"] != "bad_point" {
		t.Fatalf("a point without an id: %v", bad)
	}
	e.errorOf(400, "POST", chat+"/fork", `{"branch":"main","at":7}`) // no point there at all
	// And the tree says so: the reply has its turn's end, without "ok".
	rows, _ := e.get(chat + "/tree")["branches"].([]any)[0].(obj)["items"].([]any)
	sameJSON(t, "the reply before a point without an id", rows[len(rows)-1], `{"i":7,"kind":"text","text":"sure","done":true,"end":9}`)

	// An unknown branch: 404, on every route that names one.
	e.errorOf(404, "POST", chat+"/messages", `{"text":"x","context":"","target":{"branch":"nope","at":3,"new":true}}`)
	e.errorOf(404, "POST", chat+"/fork", `{"branch":"nope","at":3}`)
	e.errorOf(404, "PUT", chat+"/label", `{"branch":"nope","item":1,"text":"x"}`)
	e.errorOf(404, "GET", chat+"/items?branch=nope", "")
	e.errorOf(404, "GET", chat+"/subagents/s1/items?branch=nope", "")
	e.errorOf(404, "GET", "/api/chats/nope/tree", "")
	e.errorOf(404, "POST", chat+"/messages?branch=nope", `{"text":"x","context":""}`)
	e.errorOf(404, "POST", chat+"/interrupt?branch=nope", "")
	e.errorOf(404, "POST", chat+"/permission?branch=nope", `{"requestId":"p1","allow":true}`)
	e.errorOf(404, "PATCH", chat+"?branch=nope", `{"model":"opus"}`)
	e.errorOf(404, "POST", chat+"/open?branch=nope", "")
	e.errorOf(404, "GET", chat+"/context?branch=nope", "")
	e.errorOf(404, "PUT", chat+"/draft?branch=nope&rev=0", `{"text":"x"}`)

	// None of the refused requests changed the chat.
	view = e.get(chat)
	if view["branches"] != 2.0 {
		t.Fatalf("view after the refused requests %v", view)
	}
	absent(t, "the view after the refused requests", view, "branch")

	// 8. The session calls by branch. The branch left by step 5: its draft is its own, and nothing
	// of main changes. Its model is fixed like main's (409), the chat's name is not.
	sameJSON(t, "draft of the branch", decode[any](t, e.expect(200, "PUT", chat+"/draft?rev=0&branch="+b, `{"text":"later"}`)), `{"ok":true,"rev":1}`)
	e.errorOf(409, "PATCH", chat+"?branch="+b, `{"model":"opus"}`)
	if v := chatAnswer(t, "name by the branch", e.expect(200, "PATCH", chat+"?branch="+b, `{"name":"Renamed"}`), chat); v["name"] != "Renamed" {
		t.Fatalf("the chat in the answer of the rename %v", v)
	}
	okAnswer(t, "open the branch", e.expect(200, "POST", chat+"/open?branch="+b, ""))
	okAnswer(t, "stop the branch", e.expect(200, "POST", chat+"/interrupt?branch="+b, ""))
	e.errorOf(400, "POST", chat+"/permission?branch="+b, `{"requestId":"p1","allow":true}`) // no such request
	st, _ := e.get(chat + "/items?branch=" + b)["state"].(obj)
	if st["branch"] != b || st["status"] != "ready" {
		t.Fatalf("state of the branch %v", st)
	}
	sameJSON(t, "draft of the branch", st["draft"], `{"text":"later"}`)
	view = e.get(chat)
	absent(t, "the view of the chat on main", view, "branch", "draft")
	if view["name"] != "Renamed" || view["hasDraft"] != true {
		t.Fatalf("view after the branch's draft and the new name %v", view)
	}
	// A message to the end of the branch, by its name alone: its length is not asked for. The
	// branch is the current one again, and its draft is gone.
	sentOn(t, "send to the end of the branch", e.expect(200, "POST", chat+"/messages?branch="+b, `{"text":"again","context":""}`), b)
	view = e.get(chat)
	if view["branch"] != b {
		t.Fatalf("view on the branch %v", view)
	}
	absent(t, "the view on the branch", view, "draft", "hasDraft")
	got = e.get(chat + "/items")
	if items, _ := got["items"].([]any); got["branch"] != b || len(items) != 7 {
		t.Fatalf("items on the branch %v", got)
	}
	if n := len(e.get(chat + "/tree")["branches"].([]any)); n != 2 {
		t.Fatalf("%d branches after a message to the end of one", n)
	}
}

// mustJSON writes v as JSON.
func mustJSON(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// ---- the model and effort of a new branch and of a fork --------------------

// flowPiCatalog has a model too small for the conversation choiceEnv makes on pi.
var flowPiCatalog = &model.Catalog{
	Models: []model.CatalogModel{
		{ID: "big", Label: "Big", Efforts: []string{"low", "high"}, DefaultEffort: "low", ContextWindow: 200000},
		{ID: "small", Label: "Small", ContextWindow: 32000},
	},
	Default: model.ModelChoice{Model: "big", Effort: "low"},
}

// choiceEnv is a server with a Claude chat and a pi chat of two finished turns each; the pi chat
// holds 20000 tokens of context. It returns the two chats' paths.
func choiceEnv(t *testing.T) (e *env, claude, pi string) {
	t.Helper()
	sp := &flowSpawner{}
	e = newEnv(t, func(s *Server) {
		s.App.Chats.Spawners[model.Claude] = sp
		s.App.Chats.Spawners[model.Pi] = sp
	})
	if err := e.st.Update(func(s *model.State) error { s.SetCatalog(model.Pi, flowPiCatalog); return nil }); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"claude", "pi"} {
		chat := "/api/chats/" + e.chat(`{"agent":"`+kind+`","group":"__ungrouped__"}`).ID
		sentOn(t, "send", e.expect(200, "POST", chat+"/messages", `{"text":"ask","context":""}`), "main")
		a := sp.last(t)
		reply(t, a, "options", "p1")
		sentOn(t, "send", e.expect(200, "POST", chat+"/messages", `{"text":"more","context":""}`), "main")
		emit(t, a, agent.Event{Kind: agent.EvUsage, CtxIn: 20000, CtxOut: 10, CtxWindow: 200000})
		reply(t, a, "done", "p2")
		if kind == "claude" {
			claude = chat
		} else {
			pi = chat
		}
	}
	if v := e.get(claude); v["model"] != "sonnet" || v["effort"] != "high" {
		t.Fatalf("the Claude chat %v", v)
	}
	if v := e.get(pi); v["model"] != "big" || v["effort"] != "low" {
		t.Fatalf("the pi chat %v", v)
	}
	return e, claude, pi
}

// refusal sends a request that must be refused with the status want, and checks the answer's
// "error" text and its "code" ("" = none).
func (e *env) refusal(want int, path, body, code, text string) {
	e.t.Helper()
	out := decode[obj](e.t, e.expect(want, "POST", path, body))
	msg, _ := out["error"].(string)
	if msg == "" || !strings.Contains(msg, text) {
		e.t.Fatalf("POST %s %s: the error %q, want one with %q", path, body, msg, text)
	}
	if got, has := out["code"]; (code == "" && has) || (code != "" && got != code) {
		e.t.Fatalf("POST %s %s: the code %v, want %q", path, body, got, code)
	}
}

func TestMessagesTargetChoice(t *testing.T) {
	e, chat, pi := choiceEnv(t)
	msg := func(target string) string { return `{"text":"x","context":"","target":` + target + `}` }
	const window = "the model's context window is too small for this conversation: Small takes 32000 tokens and the conversation holds about 20000; pick a larger model"

	// The refusals of the table, each leaving the chat with its one branch.
	e.refusal(400, chat+"/messages", msg(`{"branch":"main","at":7,"new":true,"model":"haiku"}`), "bad_point", "")
	e.refusal(409, chat+"/messages", msg(`{"branch":"main","at":6,"model":"haiku"}`), "", "fixed once the chat has started")
	e.refusal(409, chat+"/messages", msg(`{"branch":"main","at":6,"effort":"low"}`), "", "fixed once the chat has started")
	e.refusal(409, chat+"/messages", msg(`{"branch":"main","at":6,"model":"sonnet","effort":"high"}`), "", "fixed once the chat has started")
	e.refusal(400, chat+"/messages", msg(`{"branch":"main","at":3,"new":true,"model":"nope"}`), "", `unknown model "nope"`)
	e.refusal(400, chat+"/messages", msg(`{"branch":"main","at":3,"new":true,"effort":"bogus"}`), "", `sonnet has no effort "bogus"`)
	e.refusal(400, chat+"/messages", msg(`{"branch":"main","at":3,"new":true,"model":"haiku","effort":"high"}`), "", `haiku has no effort "high"`)
	e.refusal(409, pi+"/messages", msg(`{"branch":"main","at":3,"new":true,"model":"small"}`), "window", window)
	for _, c := range []string{chat, pi} {
		absent(t, "the view after the refusals", e.get(c), "branches", "branch")
		if tree := e.get(c + "/tree"); len(tree["branches"].([]any)) != 1 {
			t.Fatalf("the tree after the refusals %v", tree)
		}
	}

	// A new branch on another model: the answer is as before, and the branch's state record
	// carries the choice while main keeps its own.
	out := decode[obj](t, e.expect(200, "POST", chat+"/messages", msg(`{"branch":"main","at":3,"new":true,"model":"haiku"}`)))
	b, _ := out["branch"].(string)
	if b == "" || b == "main" {
		t.Fatalf("the answer of a new branch %v", out)
	}
	sameJSON(t, "the answer of a new branch", out, `{"ok":true,"branch":"`+b+`"}`)
	st, _ := e.get(chat + "/items?branch=" + b)["state"].(obj)
	if st["model"] != "haiku" || st["locked"] != true {
		t.Fatalf("the new branch's state record %v", st)
	}
	absent(t, "the new branch's state record", st, "effort", "fresh")
	if st, _ := e.get(chat + "/items?branch=main")["state"].(obj); st["model"] != "sonnet" || st["effort"] != "high" {
		t.Fatalf("main's state record %v", st)
	}
	if v := e.get(chat); v["branch"] != b || v["model"] != "haiku" {
		t.Fatalf("the chat's view %v", v)
	}
	// An effort alone, and the small model at the start of the pi chat, where the guard is off.
	out = decode[obj](t, e.expect(200, "POST", chat+"/messages", msg(`{"branch":"main","at":3,"new":true,"effort":"low"}`)))
	b, _ = out["branch"].(string)
	if st, _ := e.get(chat + "/items?branch=" + b)["state"].(obj); st["model"] != "sonnet" || st["effort"] != "low" {
		t.Fatalf("the state record of a branch with an effort alone %v", st)
	}
	out = decode[obj](t, e.expect(200, "POST", pi+"/messages", msg(`{"branch":"main","at":0,"new":true,"model":"small"}`)))
	b, _ = out["branch"].(string)
	if st, _ := e.get(pi + "/items?branch=" + b)["state"].(obj); st["model"] != "small" {
		t.Fatalf("the state record of the pi branch at the start %v", st)
	}
}

func TestForkBodyChoice(t *testing.T) {
	e, chat, pi := choiceEnv(t)
	const window = "the model's context window is too small for this conversation: Small takes 32000 tokens and the conversation holds about 20000; pick a larger model"
	chats := len(e.a.Chats.Views())

	e.refusal(400, chat+"/fork", `{"branch":"main","at":4,"model":"haiku"}`, "bad_point", "")
	e.refusal(400, chat+"/fork", `{"branch":"main","at":3,"model":"nope"}`, "", `unknown model "nope"`)
	e.refusal(400, chat+"/fork", `{"branch":"main","at":3,"effort":"bogus"}`, "", `sonnet has no effort "bogus"`)
	e.refusal(400, chat+"/fork", `{"branch":"main","at":3,"model":"haiku","effort":"high"}`, "", `haiku has no effort "high"`)
	e.refusal(409, pi+"/fork", `{"branch":"main","at":3,"model":"small"}`, "window", window)
	e.refusal(409, pi+"/fork", `{"branch":"main","at":6,"model":"small"}`, "window", window)
	if n := len(e.a.Chats.Views()); n != chats {
		t.Fatalf("%d chats after the refusals, were %d", n, chats)
	}

	// A fork on another model: the answer is its view, fresh until its first message.
	fork := decode[obj](t, e.expect(200, "POST", chat+"/fork", `{"branch":"main","at":3,"model":"opus","effort":"max"}`))
	fid, _ := fork["id"].(string)
	if fork["model"] != "opus" || fork["effort"] != "max" || fork["fresh"] != true || fork["locked"] != true {
		t.Fatalf("the fork's view %v", fork)
	}
	if u, _ := fork["usage"].(obj); u["ctxWindow"] != float64(1000000) {
		t.Fatalf("the fork's usage %v", fork["usage"])
	}
	absent(t, "the fork's view", fork, "sourceCtx")
	if st, _ := e.get("/api/chats/" + fid + "/items")["state"].(obj); st["fresh"] != true || st["model"] != "opus" {
		t.Fatalf("the fork's state record %v", st)
	}
	if v := e.get(chat); v["model"] != "sonnet" || v["effort"] != "high" {
		t.Fatalf("the source's view %v", v)
	}
	absent(t, "the source's view", e.get(chat), "fresh")
	sentOn(t, "send", e.expect(200, "POST", "/api/chats/"+fid+"/messages", `{"text":"on the fork","context":""}`), "main")
	absent(t, "the fork's view after its first message", e.get("/api/chats/"+fid), "fresh")
	st, _ := e.get("/api/chats/" + fid + "/items")["state"].(obj)
	absent(t, "the fork's state record after its first message", st, "fresh")

	// No choice: the source's; at the start the guard is off and the fork is not fresh.
	fork = decode[obj](t, e.expect(200, "POST", chat+"/fork", `{"branch":"main","at":3}`))
	if fork["model"] != "sonnet" || fork["effort"] != "high" || fork["fresh"] != true {
		t.Fatalf("a fork without a choice %v", fork)
	}
	fork = decode[obj](t, e.expect(200, "POST", pi+"/fork", `{"branch":"main","at":0,"model":"small"}`))
	if fork["model"] != "small" || fork["locked"] != false {
		t.Fatalf("the pi fork at the start %v", fork)
	}
	absent(t, "the pi fork at the start", fork, "fresh", "effort")
}
