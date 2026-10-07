package remotes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
)

// body reads a Reply's JSON object.
func body(t *testing.T, rep Reply) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rep.Body, &out); err != nil {
		t.Fatalf("the answer %d %q is no JSON object: %v", rep.Status, rep.Body, err)
	}
	return out
}

// refused fails the test unless rep is the refusal with this status, code and sentence.
func refused(t *testing.T, what string, rep Reply, status int, code, text string) {
	t.Helper()
	b := body(t, rep)
	c, _ := b["code"].(string)
	if rep.Status != status || c != code || b["error"] != text {
		t.Errorf("%s: %d %s, want %d %q %q", what, rep.Status, rep.Body, status, code, text)
	}
}

// last is the script's last request.
func (s *script) last(t *testing.T) got {
	t.Helper()
	calls := s.calls()
	if len(calls) == 0 {
		t.Fatal("the route got no request")
	}
	return calls[len(calls)-1]
}

// seeded is a rig with records of the chats, each in the stand-in's snapshot.
func seeded(t *testing.T, o rigOpt, ids ...string) *rig {
	t.Helper()
	var views []model.ChatView
	for _, id := range ids {
		d := seedOf(id)
		o.seed = append(o.seed, d)
		views = append(views, d.View)
	}
	o.snapshot = snapshotWith(views...)
	return newRig(t, o)
}

// TestPassedOn: the routes of a record that are passed on as they are: what the server gets,
// and that its answer is handed on with its status.
func TestPassedOn(t *testing.T) {
	rg := seeded(t, rigOpt{}, chatA)
	ctx := context.Background()
	p, _ := rg.page("page-1")

	routes := []struct {
		pattern string
		call    func() Reply
		method  string
		uri     string
		body    string
		follows bool
	}{
		{"GET /api/chats/{id}/tree", func() Reply { return rg.r.Tree(ctx, chatA, p.ID) },
			"GET", "/api/chats/" + chatA + "/tree", "", true},
		{"GET /api/chats/{id}/subagents/{sid}/items", func() Reply { return rg.r.SubItems(ctx, chatA, p.ID, "b1", "sub 1") },
			"GET", "/api/chats/" + chatA + "/subagents/sub%201/items?branch=b1", "", true},
		{"GET /api/chats/{id}/context", func() Reply { return rg.r.Context(ctx, chatA, "b1", true) },
			"GET", "/api/chats/" + chatA + "/context?branch=b1&fresh=1", "", false},
		{"POST /api/chats/{id}/interrupt", func() Reply { return rg.r.Interrupt(ctx, chatA, "b1") },
			"POST", "/api/chats/" + chatA + "/interrupt?branch=b1", "", false},
		{"POST /api/chats/{id}/permission", func() Reply {
			return rg.r.Permission(ctx, chatA, "", []byte(`{"requestId":"r1","allow":true}`))
		}, "POST", "/api/chats/" + chatA + "/permission", `{"requestId":"r1","allow":true}`, false},
		{"POST /api/chats/{id}/open", func() Reply { return rg.r.OpenChat(ctx, chatA, "") },
			"POST", "/api/chats/" + chatA + "/open", "", false},
		{"PUT /api/chats/{id}/label", func() Reply { return rg.r.Label(ctx, chatA, []byte(`{"item":2,"text":"here"}`)) },
			"PUT", "/api/chats/" + chatA + "/label", `{"item":2,"text":"here"}`, false},
	}
	for _, rt := range routes {
		s := rg.script(rt.pattern)
		const answer = `{"passed":"<on> & on","n":[1,2]}`
		s.set(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(answer))
		})
		rg.b.Unfollow(p.ID, editorbridge.Chat(chatA))
		rep := rt.call()
		if rep.Status != http.StatusOK || string(rep.Body) != answer {
			t.Errorf("%s: the answer %d %s", rt.pattern, rep.Status, rep.Body)
		}
		if q := s.last(t); q.Method != rt.method || q.URI != rt.uri || q.Body != rt.body {
			t.Errorf("%s: the server got %+v", rt.pattern, q)
		}
		if got := rg.b.Followed(editorbridge.Chat(chatA)); got != rt.follows {
			t.Errorf("%s: followed %v", rt.pattern, got)
		}
		// Any other answer than the table's: its status and its JSON.
		s.answer(http.StatusConflict, map[string]string{"error": "the agent is still working", "code": "busy"})
		refused(t, rt.pattern, rt.call(), http.StatusConflict, "busy", "the agent is still working")
	}
	if rep := rg.r.Context(ctx, chatA, "", false); rep.Status != http.StatusConflict {
		t.Errorf("context: %d", rep.Status)
	}
	if rep := rg.r.Tree(ctx, chatB, p.ID); rep.Status != http.StatusNotFound || body(t, rep)["error"] != "no such chat" {
		t.Errorf("a chat without a record: %d %s", rep.Status, rep.Body)
	}

	// Unfollow ends the page's follow here.
	rg.b.Follow(p.ID, editorbridge.Chat(chatA))
	if rep := rg.r.Unfollow(chatA, p.ID); rep.Status != http.StatusOK || string(rep.Body) != `{"ok":true}` {
		t.Errorf("unfollow: %d %s", rep.Status, rep.Body)
	}
	if rg.b.Followed(editorbridge.Chat(chatA)) {
		t.Error("the page follows after its unfollow")
	}
}

// TestGetAndItems: the two reads whose answer this server has a part in.
func TestGetAndItems(t *testing.T) {
	seed := seedOf(chatA)
	seed.Drafts = map[string]*model.Draft{"b1": {Text: "for b1"}}
	seed.DraftRevs = map[string]int64{mainBranch: 2, "b1": 5}
	view := seed.View
	rg := newRig(t, rigOpt{snapshot: snapshotWith(view), seed: []Record{seed}})
	ctx := context.Background()
	p, _ := rg.page("page-1")

	// The view: the record takes what the server answers, and the answer is the record's view.
	get := rg.script("GET /api/chats/{id}")
	there := remoteView(chatA, model.StatusTool)
	there.Op, there.Draft = "a_there", &model.Draft{Text: "typed there"}
	get.answer(http.StatusOK, there)
	rep := rg.r.Get(ctx, chatA)
	b := body(t, rep)
	if rep.Status != http.StatusOK || b["status"] != "tool" || b["group"] != "g_here" || b["server"] != rg.entry ||
		b["archiveOp"] != nil || b["draft"] != nil || b["draftRev"] != float64(2) || b["hasDraft"] != true {
		t.Errorf("the view: %d %s", rep.Status, rep.Body)
	}
	if ev := p.Expect("chat"); field(ev, "chat", "status") != "tool" {
		t.Errorf("the pages were told %v", ev)
	}
	if rg.b.Followed(editorbridge.Chat(chatA)) {
		t.Error("the read of the view follows")
	}
	if rep := rg.r.Get(ctx, chatA); rep.Status != http.StatusOK {
		t.Errorf("a second read: %d", rep.Status)
	}
	p.ExpectNone(quiet) // the same view: nothing to tell

	// The items: the page follows, and "state" gets the branch's draft and counter.
	items := rg.script("GET /api/chats/{id}/items")
	items.set(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		branch := r.URL.Query().Get("branch")
		if branch == "" {
			branch = mainBranch
		}
		_, _ = w.Write([]byte(`{"branch":"` + branch + `","version":7,"items":[{"kind":"user","text":"a <b> & c"}],"subagents":[],` +
			`"state":{"chat":"` + chatA + `","branch":"` + branch + `","cwd":"/w","model":"m","locked":true,"usage":{},"status":"ready","draft":{"text":"typed there"},"draftRev":9,"more":[1]}}`))
	})
	rep = rg.r.Items(ctx, chatA, p.ID, "b1")
	want := `{"branch":"b1","version":7,"items":[{"kind":"user","text":"a <b> & c"}],"subagents":[],` +
		`"state":{"chat":"` + chatA + `","branch":"b1","cwd":"/w","model":"m","locked":true,"usage":{},"status":"ready","draft":{"text":"for b1"},"draftRev":5,"more":[1]}}`
	if rep.Status != http.StatusOK || string(rep.Body) != want {
		t.Errorf("the items of b1:\n %s\nwant\n %s", rep.Body, want)
	}
	if q := items.last(t); q.URI != "/api/chats/"+chatA+"/items?branch=b1" {
		t.Errorf("the server got %+v", q)
	}
	if !rg.b.Followed(editorbridge.Chat(chatA)) {
		t.Error("the page does not follow after its read")
	}
	rep = rg.r.Items(ctx, chatA, p.ID, "")
	want = `{"branch":"main","version":7,"items":[{"kind":"user","text":"a <b> & c"}],"subagents":[],` +
		`"state":{"chat":"` + chatA + `","branch":"main","cwd":"/w","model":"m","locked":true,"usage":{},"status":"ready","draftRev":2,"more":[1]}}`
	if string(rep.Body) != want {
		t.Errorf("the items of main:\n %s\nwant\n %s", rep.Body, want)
	}
}

// TestCannotBeMade: what the page gets when a call cannot be made. None of it is 409.
func TestCannotBeMade(t *testing.T) {
	rg := seeded(t, rigOpt{limits: Limits{Call: 150 * time.Millisecond, Start: 150 * time.Millisecond}}, chatA, chatB)
	ctx := context.Background()
	p, _ := rg.page("page-1")
	interrupt := rg.script("POST /api/chats/{id}/interrupt")
	items := rg.script("GET /api/chats/{id}/items")
	send := rg.script("POST /api/chats/{id}/messages")

	// Sent, no answer.
	_, free := interrupt.hang()
	defer free()
	refused(t, "no answer", rg.r.Interrupt(ctx, chatA, ""), http.StatusGatewayTimeout, "no_answer", "Studio did not answer.")
	_, free2 := send.hang()
	defer free2()
	refused(t, "a send without an answer", rg.r.Send(ctx, chatA, "", []byte(`{"text":"hi"}`)),
		http.StatusGatewayTimeout, "send_unknown", "Studio did not answer: it is not known whether the message arrived.")

	// "no such chat": the record is marked gone, and the page that read follows nothing.
	items.answer(http.StatusNotFound, map[string]string{"error": "no such chat"})
	refused(t, "a chat that is gone there", rg.r.Items(ctx, chatA, p.ID, ""), http.StatusNotFound, "gone_there", "This chat is no longer on Studio.")
	if ev := p.Expect("chat"); field(ev, "chat", "id") != chatA || field(ev, "chat", "gone") != true {
		t.Errorf("the pages were told %v", ev)
	}
	if !rg.file(chatA).Gone || rg.b.Followed(editorbridge.Chat(chatA)) {
		t.Errorf("gone %v, followed %v", rg.file(chatA).Gone, rg.b.Followed(editorbridge.Chat(chatA)))
	}
	// Another 404 is the server's answer, and marks nothing.
	items.answer(http.StatusNotFound, map[string]string{"error": "no such branch"})
	if rep := rg.r.Items(ctx, chatB, p.ID, "b9"); rep.Status != http.StatusNotFound || body(t, rep)["error"] != "no such branch" || rg.file(chatB).Gone {
		t.Errorf("no such branch: %d %s", rep.Status, rep.Body)
	}
	// An answer that is no JSON is not handed on.
	items.set(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("<html>")) })
	refused(t, "an answer that is no JSON", rg.r.Items(ctx, chatB, p.ID, ""), http.StatusBadGateway, "bad_answer", "Studio gave an answer that cannot be read.")

	// 401: the entry's matter.
	items.answer(http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
	refused(t, "401", rg.r.Items(ctx, chatB, p.ID, ""), http.StatusServiceUnavailable, "server_unreachable", "Studio is not connected.")

	// Not connected: nothing is sent.
	rg.until("the entry is not connected", func() bool { return !rg.r.connected(rg.entry) })
	sent := len(rg.s.Requests())
	for what, rep := range map[string]Reply{
		"a read":         rg.r.Items(ctx, chatB, p.ID, ""),
		"the view":       rg.r.Get(ctx, chatB),
		"a send":         rg.r.Send(ctx, chatB, "", []byte(`{"text":"hi"}`)),
		"a fork":         rg.r.Fork(ctx, chatB, []byte(`{"at":1}`)),
		"a change":       rg.r.Patch(ctx, chatB, "", PatchReq{Model: "m"}),
		"the folders":    rg.r.Dirs(ctx, rg.entry, "/"),
		"the plan usage": rg.r.Usage(ctx, rg.entry, "claude", false),
	} {
		refused(t, what+" while not connected", rep, http.StatusServiceUnavailable, "server_unreachable", "Studio is not connected.")
	}
	if got := len(rg.s.Requests()); got != sent {
		t.Errorf("%d requests were sent while not connected", got-sent)
	}
	noSecret(t, "the log", strings.Join(rg.logs.all(), "\n"))
}

// TestSend: a message for a record.
func TestSend(t *testing.T) {
	seed := seedOf(chatA)
	seed.States = append(seed.States, model.StateOf(chatA, "b1", seed.View))
	seed.Drafts = map[string]*model.Draft{mainBranch: {Text: "for main"}, "b1": {Text: "for b1"}}
	seed.DraftRevs = map[string]int64{mainBranch: 2, "b1": 5}
	archived := seedOf(chatB)
	archived.Archived = true
	archived.View.Archived = true
	snap := snapshotWith(seed.View, archived.View)
	snap["states"] = append(snap["states"].([]model.BranchState), seed.States[1])
	rg := newRig(t, rigOpt{snapshot: snap, seed: []Record{seed, archived}})
	ctx := context.Background()
	p, _ := rg.page("page-1")
	send := rg.script("POST /api/chats/{id}/messages")
	const msg = `{"text":"go on","references":[{"quote":"q"}]}`

	// Taken: the draft of the answer's branch is cleared and its counter raised.
	send.answer(http.StatusOK, map[string]any{"ok": true, "branch": "b1"})
	rep := rg.r.Send(ctx, chatA, "b1", []byte(msg))
	if rep.Status != http.StatusOK || !reflect.DeepEqual(body(t, rep), map[string]any{"ok": true, "branch": "b1"}) {
		t.Errorf("the answer: %d %s", rep.Status, rep.Body)
	}
	if q := send.last(t); q.URI != "/api/chats/"+chatA+"/messages?branch=b1" || q.Body != msg {
		t.Errorf("the server got %+v", q)
	}
	d := rg.file(chatA)
	if d.Drafts["b1"] != nil || d.Drafts[mainBranch] == nil || !reflect.DeepEqual(d.DraftRevs, map[string]int64{mainBranch: 2, "b1": 6}) {
		t.Errorf("the drafts %v and counters %v", d.Drafts, d.DraftRevs)
	}
	st, chat := p.Expect("branch_state"), p.Expect("chat")
	if field(st, "state", "branch") != "b1" || field(st, "state", "draft") != nil || field(st, "state", "draftRev") != float64(6) ||
		field(chat, "chat", "hasDraft") != true || field(chat, "chat", "draftRev") != float64(2) {
		t.Errorf("the events: %v %v", st, chat)
	}
	// A branch with no draft: the counter goes up all the same, by one.
	rg.r.Send(ctx, chatA, "b1", []byte(msg))
	if got := rg.file(chatA).DraftRevs["b1"]; got != 7 {
		t.Errorf("the counter of a branch without a draft: %d", got)
	}
	p.Expect("branch_state")
	p.Expect("chat")
	// An answer that names no branch: the first one.
	send.answer(http.StatusOK, map[string]any{"ok": true})
	rg.r.Send(ctx, chatA, "", []byte(msg))
	if d := rg.file(chatA); len(d.Drafts) != 0 || d.DraftRevs[mainBranch] != 3 {
		t.Errorf("after a send on main: %v %v", d.Drafts, d.DraftRevs)
	}
	p.Expect("branch_state")
	if ev := p.Expect("chat"); field(ev, "chat", "hasDraft") != nil {
		t.Errorf("the view after the last draft went: %v", ev)
	}

	// Refused there: the draft stays.
	send.answer(http.StatusConflict, map[string]string{"error": "the agent is still working", "code": "busy"})
	refused(t, "a busy chat", rg.r.Send(ctx, chatA, "b1", []byte(msg)), http.StatusConflict, "busy", "the agent is still working")
	if got := rg.file(chatA).DraftRevs["b1"]; got != 7 {
		t.Errorf("a refused send changed the counter: %d", got)
	}

	// An archived record: refused here, nothing is sent.
	sent := send.count()
	rep = rg.r.Send(ctx, chatB, "", []byte(msg))
	if rep.Status != http.StatusConflict || body(t, rep)["error"] != "the chat is archived" || send.count() != sent {
		t.Errorf("a send to an archived record: %d %s, %d sent", rep.Status, rep.Body, send.count()-sent)
	}
	p.ExpectNone(quiet)
}

// TestPatch: the changes of a record.
func TestPatch(t *testing.T) {
	archived := seedOf(chatB)
	archived.Archived = true
	archived.View.Archived = true
	seed := seedOf(chatA)
	groups := map[string][2]bool{"g_here": {true, false}, "g_new": {true, false}, "g_old": {true, true}}
	rg := newRig(t, rigOpt{snapshot: snapshotWith(seed.View, archived.View), seed: []Record{seed, archived}, wire: func(rg *rig) {
		rg.r.o.Group = func(id string) (bool, bool) { return groups[id][0], groups[id][1] }
	}})
	ctx := context.Background()
	p, _ := rg.page("page-1")
	patch := rg.script("PATCH /api/chats/{id}")
	str := func(s string) *string { return &s }

	// The group: the chat's place here. Nothing is sent.
	rep := rg.r.Patch(ctx, chatA, "", PatchReq{Group: str("g_new")})
	if rep.Status != http.StatusOK || body(t, rep)["ok"] != true || field(body(t, rep), "chat", "group") != "g_new" || patch.count() != 0 {
		t.Errorf("a move: %d %s, %d sent", rep.Status, rep.Body, patch.count())
	}
	if ev := p.Expect("chat"); field(ev, "chat", "group") != "g_new" || rg.file(chatA).Group != "g_new" {
		t.Errorf("after the move: %v", ev)
	}
	if rep := rg.r.Patch(ctx, chatA, "", PatchReq{Group: str(model.Ungrouped)}); rep.Status != http.StatusOK {
		t.Errorf("a move out of every group: %d %s", rep.Status, rep.Body)
	}
	p.Expect("chat")
	for group, want := range map[string]int{"g_none": http.StatusNotFound, "g_old": http.StatusConflict, "": http.StatusBadRequest} {
		if rep := rg.r.Patch(ctx, chatA, "", PatchReq{Group: str(group), Name: str("x")}); rep.Status != want {
			t.Errorf("a move to %q: %d %s", group, rep.Status, rep.Body)
		}
	}
	if rg.file(chatA).Group != model.Ungrouped || patch.count() != 0 {
		t.Errorf("a refused move changed the place to %q or sent %d", rg.file(chatA).Group, patch.count())
	}

	// Server and agent are fixed: the chat has started.
	for _, req := range []PatchReq{{Server: "local"}, {Agent: model.Pi}, {Agent: model.Pi, Name: str("x")}} {
		rep := rg.r.Patch(ctx, chatA, "", req)
		if rep.Status != http.StatusConflict || body(t, rep)["error"] != chats.ErrAgentFixed.Error() {
			t.Errorf("%+v: %d %s", req, rep.Status, rep.Body)
		}
	}
	if patch.count() != 0 {
		t.Errorf("a refused change sent %d", patch.count())
	}

	// The name, and model, effort and folder of a branch, are passed on; the answer is the
	// record's view, with what the server answered.
	there := remoteView(chatA, model.StatusReady)
	there.Name, there.Model = "Renamed", "other-model"
	patch.answer(http.StatusOK, map[string]any{"ok": true, "chat": there})
	rep = rg.r.Patch(ctx, chatA, "b1", PatchReq{Name: str("Renamed"), Model: "other-model", Effort: "low", Cwd: "/srv"})
	b := body(t, rep)
	if rep.Status != http.StatusOK || field(b, "chat", "name") != "Renamed" || field(b, "chat", "model") != "other-model" ||
		field(b, "chat", "group") != model.Ungrouped || field(b, "chat", "server") != rg.entry {
		t.Errorf("the answer: %d %s", rep.Status, rep.Body)
	}
	q := patch.last(t)
	var sent map[string]any
	_ = json.Unmarshal([]byte(q.Body), &sent)
	if q.URI != "/api/chats/"+chatA+"?branch=b1" || !reflect.DeepEqual(sent, map[string]any{"name": "Renamed", "model": "other-model", "effort": "low", "cwd": "/srv"}) {
		t.Errorf("the server got %+v", q)
	}
	if ev := p.Expect("chat"); field(ev, "chat", "name") != "Renamed" {
		t.Errorf("the pages were told %v", ev)
	}
	rg.r.Patch(ctx, chatA, "", PatchReq{Name: str("")})
	if q := patch.last(t); q.Body != `{"name":""}` || q.URI != "/api/chats/"+chatA {
		t.Errorf("a name alone: %+v", q)
	}
	// Refused there: the answer as it came, and the place is not changed.
	patch.answer(http.StatusBadRequest, map[string]string{"error": "no such model"})
	rep = rg.r.Patch(ctx, chatA, "", PatchReq{Model: "nope", Group: str("g_new")})
	if rep.Status != http.StatusBadRequest || body(t, rep)["error"] != "no such model" || rg.file(chatA).Group != model.Ungrouped {
		t.Errorf("a change the server refuses: %d %s, group %q", rep.Status, rep.Body, rg.file(chatA).Group)
	}

	// An archived record: model, effort and folder are refused here; its name and place are not.
	before := patch.count()
	rep = rg.r.Patch(ctx, chatB, "", PatchReq{Model: "other-model"})
	if rep.Status != http.StatusConflict || body(t, rep)["error"] != "the chat is archived" || patch.count() != before {
		t.Errorf("a model for an archived record: %d %s", rep.Status, rep.Body)
	}
	if rep := rg.r.Patch(ctx, chatB, "", PatchReq{Group: str("g_new")}); rep.Status != http.StatusOK || rg.file(chatB).Group != "g_new" {
		t.Errorf("a move of an archived record: %d %s", rep.Status, rep.Body)
	}
}

// TestFork: a fork is made by the chat's server, and gets a record in the source's place.
func TestFork(t *testing.T) {
	rg := seeded(t, rigOpt{}, chatA)
	ctx := context.Background()
	p, _ := rg.page("page-1")
	fork := rg.script("POST /api/chats/{id}/fork")
	get := rg.script("GET /api/chats/{id}")
	const forkID = "f0rk0000-0000-4000-8000-00000000000f"
	const req = `{"branch":"main","at":3,"message":2}`

	made := remoteView(forkID, model.StatusReady)
	made.Fresh, made.Locked = true, false
	made.Draft, made.DraftRev, made.HasDraft = &model.Draft{Text: "the message to edit"}, 1, true
	fork.answer(http.StatusOK, made)
	read := made
	read.Name = "Fork of A" // what the first events, which were dropped, told
	get.answer(http.StatusOK, read)

	rep := rg.r.Fork(ctx, chatA, []byte(req))
	b := body(t, rep)
	if rep.Status != http.StatusOK || b["id"] != forkID || b["group"] != "g_here" || b["server"] != rg.entry || b["fresh"] != true ||
		b["name"] != "Fork of A" || field(b, "draft", "text") != "the message to edit" || b["draftRev"] != float64(1) || b["hasDraft"] != true {
		t.Errorf("the answer: %d %s", rep.Status, rep.Body)
	}
	if q := fork.last(t); q.URI != "/api/chats/"+chatA+"/fork" || q.Body != req {
		t.Errorf("the server got %+v", q)
	}
	if q := get.last(t); q.URI != "/api/chats/"+forkID {
		t.Errorf("the read after the fork: %+v", q)
	}
	d := rg.file(forkID)
	if d.Entry != rg.entry || d.Group != "g_here" || d.Drafts[mainBranch] == nil || d.Drafts[mainBranch].Text != "the message to edit" ||
		!reflect.DeepEqual(d.DraftRevs, map[string]int64{mainBranch: 1}) || len(d.States) != 1 {
		t.Errorf("the fork's record: %+v", d)
	}
	st, chat := p.Expect("branch_state"), p.Expect("chat")
	if field(st, "state", "chat") != forkID || field(st, "state", "draft", "text") != "the message to edit" || field(st, "state", "draftRev") != float64(1) ||
		field(chat, "chat", "id") != forkID || field(chat, "chat", "name") != "Fork of A" || field(chat, "chat", "group") != "g_here" {
		t.Errorf("the events: %v %v", st, chat)
	}
	// The fork's events now have a record to go to.
	rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(forkID, model.StatusThinking)})
	if ev := p.Expect("chat"); field(ev, "chat", "id") != forkID || field(ev, "chat", "status") != "thinking" {
		t.Errorf("an event of the fork: %v", ev)
	}

	// A fork with no draft has no counter.
	const plainID = "f0rk0000-0000-4000-8000-0000000000aa"
	plain := remoteView(plainID, model.StatusReady)
	fork.answer(http.StatusOK, plain)
	get.answer(http.StatusOK, plain)
	if rep := rg.r.Fork(ctx, chatA, []byte(`{"at":1}`)); rep.Status != http.StatusOK || body(t, rep)["draftRev"] != nil {
		t.Errorf("a plain fork: %d %s", rep.Status, rep.Body)
	}
	if d := rg.file(plainID); len(d.Drafts) != 0 || len(d.DraftRevs) != 0 {
		t.Errorf("a plain fork's drafts: %v %v", d.Drafts, d.DraftRevs)
	}

	// Refused there: the answer as it came, and no record.
	fork.answer(http.StatusConflict, map[string]string{"error": "the agent is still working", "code": "busy"})
	refused(t, "a refused fork", rg.r.Fork(ctx, chatA, []byte(`{"at":1}`)), http.StatusConflict, "busy", "the agent is still working")
	// An id that cannot name a record here is not kept.
	bad := remoteView("../../etc", model.StatusReady)
	fork.answer(http.StatusOK, bad)
	if rep := rg.r.Fork(ctx, chatA, []byte(`{"at":1}`)); rep.Status != http.StatusBadGateway || body(t, rep)["code"] != "bad_answer" {
		t.Errorf("a fork with a bad id: %d %s", rep.Status, rep.Body)
	}
	// An id that is a chat's on this server makes no record: it would take that chat's place.
	const ownID, unstartedID = "0e000000-0000-4000-8000-00000000000e", "0f000000-0000-4000-8000-00000000000f"
	rg.local.mu.Lock()
	rg.local.known = map[string]bool{ownID: true}
	rg.local.mu.Unlock()
	rg.unstarted(unstartedID, "")
	for _, id := range []string{ownID, unstartedID} {
		fork.answer(http.StatusOK, remoteView(id, model.StatusReady))
		refused(t, "a fork under the id of a chat here", rg.r.Fork(ctx, chatA, []byte(`{"at":1}`)), http.StatusBadGateway, "bad_answer", "Studio gave an answer that cannot be read.")
		if rg.r.Has(id) || rg.handedOver(id) {
			t.Errorf("the fork's answer made a record under the id %s of a chat here", id)
		}
		if _, err := os.Stat(rg.r.files.path(id)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("a file for the id %s: %v", id, err)
		}
	}
	if n := rg.logs.count("the id is a chat's here"); n != 2 {
		t.Errorf("%d log lines for the forks that were not kept: %v", n, rg.logs.all())
	}
	if n, _ := rg.r.Counts(rg.entry); n != 3 {
		t.Errorf("%d records, want 3", n)
	}
}

// TestDirsAndUsage: the two routes that take the entry, and what the chat manager asks.
func TestDirsAndUsage(t *testing.T) {
	rg := newRig(t, rigOpt{})
	ctx := context.Background()
	dirs := rg.script("GET /api/dirs")
	usage := rg.script("GET /api/usage/{agent}")
	del := rg.script("DELETE /api/chats/{id}")
	del.answer(http.StatusOK, map[string]bool{"ok": true})

	const listing = `{"path":"/home/standin/work","parent":"/home/standin","dirs":["a","b"],"git":false}`
	dirs.set(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(listing)) })
	if rep := rg.r.Dirs(ctx, rg.entry, "~/work"); rep.Status != http.StatusOK || string(rep.Body) != listing {
		t.Errorf("the folders: %d %s", rep.Status, rep.Body)
	}
	if q := dirs.last(t); q.URI != "/api/dirs?path=~%2Fwork" && q.URI != "/api/dirs?path=%7E%2Fwork" {
		t.Errorf("the server got %+v", q)
	}
	rg.r.Dirs(ctx, rg.entry, "")
	if q := dirs.last(t); q.URI != "/api/dirs" {
		t.Errorf("no path: %+v", q)
	}
	usage.answer(http.StatusOK, map[string]any{"plan": "max"})
	if rep := rg.r.Usage(ctx, rg.entry, "claude", true); rep.Status != http.StatusOK || body(t, rep)["plan"] != "max" {
		t.Errorf("the plan usage: %d %s", rep.Status, rep.Body)
	}
	if q := usage.last(t); q.URI != "/api/usage/claude?fresh=1" {
		t.Errorf("the server got %+v", q)
	}
	rg.r.Usage(ctx, rg.entry, "pi", false)
	if q := usage.last(t); q.URI != "/api/usage/pi" {
		t.Errorf("not fresh: %+v", q)
	}
	for _, entry := range []string{"s_000000000000", servers.LocalID} {
		if rep := rg.r.Dirs(ctx, entry, "/"); rep.Status != http.StatusNotFound || body(t, rep)["error"] != "no such server" {
			t.Errorf("the folders of %s: %d %s", entry, rep.Status, rep.Body)
		}
		if rep := rg.r.Usage(ctx, entry, "claude", false); rep.Status != http.StatusNotFound {
			t.Errorf("the plan usage of %s: %d", entry, rep.Status)
		}
	}

	// Dir: the folder as that server names it.
	if abs, err := rg.r.Dir(rg.entry, "~/work"); err != nil || abs != "/home/standin/work" {
		t.Errorf("Dir: %q, %v", abs, err)
	}
	dirs.answer(http.StatusBadRequest, map[string]string{"error": "stat /nowhere: no such file or directory"})
	_, err := rg.r.Dir(rg.entry, "/nowhere")
	if !errors.Is(err, agent.ErrFolderMissing) || !strings.Contains(err.Error(), "stat /nowhere: no such file or directory") {
		t.Errorf("Dir of a folder that is none: %v", err)
	}
	dirs.answer(http.StatusInternalServerError, map[string]string{"error": "boom"})
	if _, err := rg.r.Dir(rg.entry, "/"); err == nil || errors.Is(err, agent.ErrFolderMissing) || err.Error() != "boom" {
		t.Errorf("Dir with an answer of 500: %v", err)
	}

	// DropLeftover: the chat is deleted there, in the background.
	rg.r.DropLeftover(rg.entry, chatA)
	rg.until("the leftover is deleted", func() bool { return del.count() == 1 })
	if q := del.last(t); q.Method != http.MethodDelete || q.URI != "/api/chats/"+chatA {
		t.Errorf("the server got %+v", q)
	}
	del.answer(http.StatusInternalServerError, map[string]string{"error": "boom"})
	rg.r.DropLeftover(rg.entry, chatB)
	rg.until("the failure is logged", func() bool { return rg.logs.count("is not deleted on the server") == 1 })

	// Not connected: Dir says so, and nothing is dropped.
	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	if _, err := rg.r.Dir(rg.entry, "/"); !errors.Is(err, chats.ErrServerUnreachable) {
		t.Errorf("Dir while not connected: %v", err)
	}
	rg.r.DropLeftover(rg.entry, chatA)
	time.Sleep(quiet)
	if del.count() != 2 {
		t.Errorf("%d deletes, want 2", del.count())
	}
	noSecret(t, "the log", strings.Join(rg.logs.all(), "\n"))
}
