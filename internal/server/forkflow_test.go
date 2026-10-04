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
	evs.wait(e.t, "hello", 0, func(ev map[string]any) bool { return ev["type"] == "hello" && ev["active"] == true })
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
	okAnswer(t, "send", e.expect(200, "POST", chat+"/messages", `{"text":"ask","context":""}`))
	main := sp.last(t)
	reply(t, main, "options", "p1")
	okAnswer(t, "send", e.expect(200, "POST", chat+"/messages", `{"text":"redis","context":""}`))
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
	absent(t, "the view of an unsplit chat", e.get(chat), "branches", "branch", "forkedFrom", "forkedFromTitle")

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
	if fid == "" || fid == id || fork["forkedFrom"] != id || title == "" || name != title+" (fork)" || fork["agent"] != "claude" {
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
	okAnswer(t, "send to a new branch", e.expect(200, "POST", chat+"/messages",
		`{"text":"memory","context":"","target":{"branch":"main","at":3,"new":true}}`))
	view := e.get(chat)
	b, _ := view["branch"].(string)
	if view["id"] != id || view["branches"] != 2.0 || b == "" || b == "main" {
		t.Fatalf("view after the branch %v", view)
	}
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
	okAnswer(t, "send to the end of main", e.expect(200, "POST", chat+"/messages",
		`{"text":"more","context":"","target":{"branch":"main","at":6,"new":false}}`))
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

	// 6. The status codes. Busy: 409, whatever the target.
	for _, body := range []string{
		`{"text":"x","context":""}`,
		`{"text":"x","context":"","target":{"branch":"main","at":3,"new":true}}`,
		`{"text":"x","context":"","target":{"branch":"` + b + `","at":6,"new":false}}`,
	} {
		e.errorOf(409, "POST", chat+"/messages", body)
	}
	e.errorOf(409, "POST", chat+"/fork", `{"branch":"main","at":3}`)

	// A turn that ends without an id leaves a point no branch can start at: 400.
	reply(t, sp.last(t), "sure", "")
	got = e.get(chat + "/items")
	items, _ := got["items"].([]any)
	if len(items) != 9 {
		t.Fatalf("items after the turn without an id %v", got)
	}
	sameJSON(t, "an end mark without an id", items[8], `{"kind":"end"}`)
	e.errorOf(400, "POST", chat+"/messages", `{"text":"x","context":"","target":{"branch":"main","at":9,"new":true}}`)
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

	// None of the refused requests changed the chat.
	view = e.get(chat)
	if view["branches"] != 2.0 {
		t.Fatalf("view after the refused requests %v", view)
	}
	absent(t, "the view after the refused requests", view, "branch")
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
