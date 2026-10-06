package server

import (
	"io"
	"net/http"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
)

// stopAgent is a permAgent that counts its interrupts.
type stopAgent struct {
	permAgent
	stops atomic.Int32
}

func (a *stopAgent) Interrupt() error { a.stops.Add(1); return nil }

// stopSpawner spawns stopAgents and keeps them, in spawn order.
type stopSpawner struct {
	fakeSpawner
	mu     sync.Mutex
	agents []*stopAgent
}

func (s *stopSpawner) Spawn(agent.SpawnOptions) (agent.Agent, error) {
	a := &stopAgent{permAgent: permAgent{fakeAgent: fakeAgent{ch: make(chan agent.Event)}, asked: map[string]bool{}}}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.agents = append(s.agents, a)
	return a, nil
}

func (s *stopSpawner) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.agents)
}

// thread is the items answer.
type thread struct {
	Branch    string
	Version   int
	Items     []model.Item
	Subagents []model.Subagent
	State     *model.BranchState
}

// thread reads one branch of a chat ("" = no query) and fails unless the answer has the state
// record of the branch served.
func (e *env) thread(id, branch string) thread {
	e.t.Helper()
	path := "/api/chats/" + id + "/items"
	if branch != "" {
		path += "?branch=" + branch
	}
	got := decode[thread](e.t, e.expect(200, "GET", path, ""))
	if got.State == nil || got.State.Chat != id || got.State.Branch != got.Branch {
		e.t.Fatalf("GET %s: state %+v of branch %q", path, got.State, got.Branch)
	}
	return got
}

// Each session route takes ?branch= and reaches that branch, also when it is not the current one.
func TestSessionRoutesTakeABranch(t *testing.T) {
	e := newEnv(t)
	sp := &stopSpawner{}
	e.a.Chats.Spawners[model.Claude] = sp
	id := e.branchedChat() // main and a1b2c3d4, which is current and has a session
	const other = "a1b2c3d4"
	chat := "/api/chats/" + id
	refused := func(want int, method, path, body string, err error) {
		t.Helper()
		out := decode[map[string]string](t, e.expect(want, method, path, body))
		if out["error"] != err.Error() {
			t.Fatalf("%s %s: error %q, want %q", method, path, out["error"], err)
		}
		if _, ok := out["code"]; ok && err != chats.ErrBusy {
			t.Fatalf("%s %s: code in %v", method, path, out)
		}
	}

	// An unknown branch: 404 on each of the seven, and nothing started.
	for _, r := range [][3]string{
		{"POST", "/interrupt", ""},
		{"POST", "/permission", `{"requestId":"p1","allow":true}`},
		{"PATCH", "", `{"model":"opus"}`},
		{"POST", "/open", ""},
		{"GET", "/context", ""},
		{"PUT", "/draft", `{"text":"x"}`},
		{"POST", "/messages", `{"text":"x"}`},
	} {
		refused(404, r[0], chat+r[1]+"?branch=nope", r[2], chats.ErrNoBranch)
	}
	// A target together with a branch: 400, whatever the two name.
	for _, q := range []string{"?branch=main", "?branch=" + other, "?branch=nope"} {
		out := decode[map[string]string](t, e.expect(400, "POST", chat+"/messages"+q, `{"text":"x","target":{"branch":"main","at":3}}`))
		if !reflect.DeepEqual(out, map[string]string{"error": "branch and target together"}) {
			t.Fatalf("target with %s: %v", q, out)
		}
	}
	if sp.count() != 0 || len(e.thread(id, "main").Items) != 8 || len(e.thread(id, other).Items) != 6 {
		t.Fatalf("the refused requests changed the chat: %d processes", sp.count())
	}

	// PUT /draft: each branch has its own.
	e.expect(200, "PUT", chat+"/draft?branch=main", `{"text":"for main"}`)
	e.expect(200, "PUT", chat+"/draft", `{"text":"for the branch"}`)
	if m, b := e.thread(id, "main").State.Draft, e.thread(id, other).State.Draft; m == nil || m.Text != "for main" || b == nil || b.Text != "for the branch" {
		t.Fatalf("drafts: main %+v, the branch %+v", m, b)
	}
	if v := decode[model.ChatView](t, e.expect(200, "GET", chat, "")); v.Draft == nil || v.Draft.Text != "for the branch" || !v.HasDraft {
		t.Fatalf("view with two drafts %+v", v)
	}

	// PATCH: model and cwd go to the branch named, the name stays the chat's.
	// (The current branch has started: its model is fixed.)
	dir := t.TempDir()
	refused(409, "PATCH", chat, `{"model":"opus"}`, chats.ErrLocked)
	e.expect(200, "PATCH", chat+"?branch=main", `{"name":"Mine","model":"opus","cwd":"`+dir+`"}`)
	if st := e.thread(id, "main").State; st.Model != "opus" || st.Cwd != dir {
		t.Fatalf("state of main after the patch %+v", st)
	}
	if st := e.thread(id, other).State; st.Model == "opus" || st.Cwd == dir {
		t.Fatalf("state of the other branch after main's patch %+v", st)
	}
	if v := decode[model.ChatView](t, e.expect(200, "GET", chat, "")); v.Name != "Mine" || v.Model == "opus" || v.Branch != other {
		t.Fatalf("view after main's patch %+v", v)
	}

	// GET /context: main has no session yet, the current branch has.
	refused(409, "GET", chat+"/context?branch=main", "", chats.ErrNotStarted)
	if s := decode[model.ContextSplit](t, e.expect(200, "GET", chat+"/context", "")); s.Total != 10 {
		t.Fatalf("split of the current branch %+v", s)
	}

	// POST /messages: the end of main, whatever its length; main is the current branch from now on,
	// and only its draft is cleared.
	out := e.expect(200, "POST", chat+"/messages?branch=main", `{"text":"on main"}`)
	if !reflect.DeepEqual(decode[any](t, out), map[string]any{"ok": true, "branch": "main"}) {
		t.Fatalf("answer %s", out)
	}
	main := e.thread(id, "main")
	if len(main.Items) != 9 || main.Items[8].Text != "on main" || main.State.Draft != nil || main.State.Status != model.StatusThinking || !main.State.Locked {
		t.Fatalf("main after the message %+v", main)
	}
	if b := e.thread(id, other); len(b.Items) != 6 || b.State.Draft == nil || b.State.Status != model.StatusReady {
		t.Fatalf("the other branch after main's message %+v", b)
	}
	if v := decode[model.ChatView](t, e.expect(200, "GET", chat, "")); v.Branch != "" || v.Branches != 2 || v.Model != "opus" {
		t.Fatalf("view after main's message %+v", v)
	}
	if got := e.thread(id, ""); got.Branch != "main" {
		t.Fatalf("the current branch is %q", got.Branch)
	}
	if sp.count() != 1 {
		t.Fatalf("%d processes after one message", sp.count())
	}
	ag := sp.agents[0]

	// Busy: 409 with the code, for the branch that works: by its name, and without one, since
	// it is the current branch. An unknown branch is 404 all the same.
	for _, q := range []string{"", "?branch=main"} {
		out := decode[map[string]string](t, e.expect(409, "POST", chat+"/messages"+q, `{"text":"again"}`))
		if !reflect.DeepEqual(out, map[string]string{"error": chats.ErrBusy.Error(), "code": "busy"}) {
			t.Fatalf("busy with %q: %v", q, out)
		}
	}
	refused(404, "POST", chat+"/messages?branch=nope", `{"text":"again"}`, chats.ErrNoBranch)

	// GET /context of the branch left.
	if s := decode[model.ContextSplit](t, e.expect(200, "GET", chat+"/context?branch="+other+"&fresh=1", "")); s.Total != 10 {
		t.Fatalf("split of the branch left %+v", s)
	}

	// POST /permission: main's request is not the other branch's.
	ag.ask("p1")
	for deadline := time.Now().Add(2 * time.Second); e.thread(id, "main").State.Status != model.StatusApproval; time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("main is not waiting for approval")
		}
	}
	refused(400, "POST", chat+"/permission?branch="+other, `{"requestId":"p1","allow":true}`, chats.ErrNoRequest)
	if got := ag.answered(); len(got) != 0 {
		t.Fatalf("an answer for the other branch reached main: %v", got)
	}
	e.expect(200, "POST", chat+"/permission?branch=main", `{"requestId":"p1","allow":true}`)
	if got := ag.answered(); !reflect.DeepEqual(got, []string{"p1 true"}) {
		t.Fatalf("answers %v", got)
	}

	// POST /interrupt: the other branch has nothing running, and main's turn is not touched.
	e.expect(200, "POST", chat+"/interrupt?branch="+other, "")
	if n := ag.stops.Load(); n != 0 {
		t.Fatalf("stopping the other branch interrupted main %d times", n)
	}
	e.expect(200, "POST", chat+"/interrupt?branch=main", "")
	if n := ag.stops.Load(); n != 1 {
		t.Fatalf("main interrupted %d times", n)
	}

	// POST /open: the other branch's folder is gone, main's is not.
	if err := os.RemoveAll(e.a.DefaultCwd); err != nil {
		t.Fatal(err)
	}
	e.expect(200, "POST", chat+"/open?branch=main", "")
	if st := e.thread(id, other).State; st.FolderMissing {
		t.Fatalf("opening main changed the other branch %+v", st)
	}
	e.expect(200, "POST", chat+"/open?branch="+other, "")
	if st := e.thread(id, other).State; !st.FolderMissing || st.Status != model.StatusError || st.Error == "" {
		t.Fatalf("the other branch after open %+v", st)
	}
	if st := e.thread(id, "main").State; st.FolderMissing || st.Error != "" {
		t.Fatalf("main after the other branch's open %+v", st)
	}
	e.a.Chats.Stop(id)
}

// GET /api/state and the snapshot event carry one state record per branch of every chat.
func TestStateRoute(t *testing.T) {
	e := newEnv(t)
	id := e.branchedChat()
	c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	e.expect(200, "PUT", "/api/chats/"+id+"/draft?branch=main", `{"text":"kept"}`)

	check := func(what string, snap obj) {
		t.Helper()
		raw, ok := snap["states"].([]any)
		if !ok {
			t.Fatalf(`%s: "states" is %v`, what, snap["states"])
		}
		states := decode[[]model.BranchState](t, mustJSON(t, raw))
		by := map[[2]string]model.BranchState{}
		for _, st := range states {
			by[[2]string{st.Chat, st.Branch}] = st
		}
		if len(states) != 3 || len(by) != 3 {
			t.Fatalf("%s: states %+v", what, states)
		}
		m, b, plain := by[[2]string{id, "main"}], by[[2]string{id, "a1b2c3d4"}], by[[2]string{c.ID, "main"}]
		if m.Chat == "" || m.Locked || m.Status != model.StatusReady || m.Draft == nil || m.Draft.Text != "kept" {
			t.Fatalf("%s: state of main %+v", what, m)
		}
		if b.Chat == "" || !b.Locked || b.Status != model.StatusReady || b.Cwd != e.a.DefaultCwd || b.Draft != nil {
			t.Fatalf("%s: state of the branch %+v", what, b)
		}
		if plain.Chat == "" || plain.Locked || plain.Model != c.Model || plain.Cwd != c.Cwd {
			t.Fatalf("%s: state of the unsplit chat %+v", what, plain)
		}
		// The same record as the items answer gives.
		for _, st := range states {
			if got := e.thread(st.Chat, st.Branch).State; !reflect.DeepEqual(*got, st) {
				t.Fatalf("%s: state %+v, the items answer has %+v", what, st, *got)
			}
		}
		if n := len(snap["chats"].([]any)); n != 2 {
			t.Fatalf("%s: %d chats", what, n)
		}
	}
	// A GET: no client header needed.
	code, out := e.doAs("", "GET", "/api/state", "")
	if code != 200 {
		t.Fatalf("state: %d %s", code, out)
	}
	check("GET /api/state", decode[obj](t, out))
	evs := e.listen()
	check("the snapshot event", evs.wait(t, "snapshot", 0, func(ev obj) bool { return ev["type"] == "snapshot" }))
}

// POST /messages answers with the branch the message was put on, in each of its three forms, and
// two branches of a chat take a message and work at the same time: busy is the branch's.
func TestMessagesAnswerNamesTheBranch(t *testing.T) {
	e := newEnv(t)
	id := e.branchedChat() // main and a1b2c3d4, which is current and has a session
	const other = "a1b2c3d4"
	chat := "/api/chats/" + id
	sent := func(what, path, body string) string {
		t.Helper()
		out := decode[map[string]any](t, e.expect(200, "POST", path, body))
		b, _ := out["branch"].(string)
		if len(out) != 2 || out["ok"] != true || b == "" {
			t.Fatalf("%s: answer %v", what, out)
		}
		return b
	}
	view := func() model.ChatView {
		t.Helper()
		return decode[model.ChatView](t, e.expect(200, "GET", chat, ""))
	}

	// A message that does not get onto its branch names none, and the current branch stays:
	// main's process cannot start, its folder being gone, and the error is on main's record.
	out := decode[map[string]any](t, e.expect(409, "POST", chat+"/messages?branch=main", `{"text":"never sent"}`))
	if _, named := out["branch"]; named || out["error"] == "" {
		t.Fatalf("answer of a failed start %v", out)
	}
	if st := e.thread(id, "main").State; view().Branch != other || !st.FolderMissing || st.Status != model.StatusError || len(e.thread(id, "main").Items) != 8 {
		t.Fatalf("after a failed start: current %q, main's state %+v", view().Branch, st)
	}
	if st := e.thread(id, other).State; st.Status != model.StatusReady || st.Error != "" {
		t.Fatalf("the current branch after main's failed start %+v", st)
	}

	sp := &stopSpawner{}
	e.a.Chats.Spawners[model.Claude] = sp
	// 1. No branch and no target: the branch that is current when the message is sent.
	if b := sent("a plain Send", chat+"/messages", `{"text":"one"}`); b != other {
		t.Fatalf("a plain Send was put on %q", b)
	}
	// 2. ?branch=: that branch. Main takes its message while the other branch works, and is the
	// current branch from now on.
	if b := sent("?branch=main", chat+"/messages?branch=main", `{"text":"two"}`); b != "main" {
		t.Fatalf("a Send to main was put on %q", b)
	}
	if v := view(); v.Branch != "" || v.Branches != 2 || v.Working != 2 || sp.count() != 2 {
		t.Fatalf("view with two branches working %+v, %d processes", v, sp.count())
	}
	for _, b := range []string{"main", other} {
		if th := e.thread(id, b); th.State.Status != model.StatusThinking || th.Items[len(th.Items)-1].Kind != "user" {
			t.Fatalf("the branch %s after its message %+v", b, th.State)
		}
	}
	// Each is busy on its own, and a refusal names no branch.
	for _, q := range []string{"", "?branch=main", "?branch=" + other} {
		out := decode[map[string]any](t, e.expect(409, "POST", chat+"/messages"+q, `{"text":"again"}`))
		if _, named := out["branch"]; named || out["code"] != "busy" {
			t.Fatalf("busy with %q: %v", q, out)
		}
	}
	// 3. A target that starts a new branch: its new id. The point is a finished boundary of
	// main, whose turn is running.
	nb := sent("a new branch", chat+"/messages", `{"text":"three","target":{"branch":"main","at":3,"new":true}}`)
	if v := view(); len(nb) != 8 || nb == other || v.Branch != nb || v.Branches != 3 || v.Working != 3 {
		t.Fatalf("the new branch %q, view %+v", nb, v)
	}
	if th := e.thread(id, nb); len(th.Items) != 4 || th.Items[3].Text != "three" || th.State.Status != model.StatusThinking {
		t.Fatalf("the new branch %+v", th)
	}
	if n := sp.agents[1].stops.Load() + sp.agents[0].stops.Load(); n != 0 || len(e.thread(id, "main").Items) != 9 {
		t.Fatalf("the new branch disturbed the others: %d interrupts", n)
	}
	// A target at the end of a branch: that branch. Its turn has ended first.
	sp.agents[0].ch <- agent.Event{Kind: agent.EvTurnEnd, Point: "q2"}
	deadline := time.Now().Add(5 * time.Second)
	for e.thread(id, other).State.Status != model.StatusReady {
		if time.Now().After(deadline) {
			t.Fatal("the branch's turn did not end")
		}
		time.Sleep(time.Millisecond)
	}
	at := len(e.thread(id, other).Items)
	if b := sent("a target at the end of a branch", chat+"/messages", `{"text":"four","target":{"branch":"`+other+`","at":`+strconv.Itoa(at)+`}}`); b != other {
		t.Fatalf("a Send to the end of %s was put on %q", other, b)
	}
	if v := view(); v.Branch != other || v.Branches != 3 || v.Working != 3 {
		t.Fatalf("view %+v", v)
	}
	e.a.Chats.Stop(id)
}

// ---- the model and effort of a fork that has had no message ----------------

// holdSpawner is a flowSpawner whose fork start can be held open.
type holdSpawner struct {
	*flowSpawner
	hmu     sync.Mutex
	gate    chan struct{} // non-nil: the next SpawnFork waits for it to close
	waiting chan struct{} // closed when that SpawnFork is waiting
}

func (s *holdSpawner) SpawnFork(o agent.SpawnOptions, src agent.ForkSource) (agent.Agent, string, error) {
	s.hmu.Lock()
	gate, waiting := s.gate, s.waiting
	s.gate, s.waiting = nil, nil
	s.hmu.Unlock()
	if gate != nil {
		close(waiting)
		<-gate
	}
	return s.flowSpawner.SpawnFork(o, src)
}

// hold makes the next fork start wait until release is called; waiting is closed once it does.
func (s *holdSpawner) hold() (waiting <-chan struct{}, release func()) {
	gate, w := make(chan struct{}), make(chan struct{})
	s.hmu.Lock()
	s.gate, s.waiting = gate, w
	s.hmu.Unlock()
	return w, sync.OnceFunc(func() { close(gate) })
}

// count is how many processes it has started.
func (s *holdSpawner) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.agents)
}

// PATCH on a fork that has had no message changes its model and effort, and answers once the
// fork's process has been started again on them.
func TestPatchFreshFork(t *testing.T) {
	e, chat, pi := choiceEnv(t)
	hs := &holdSpawner{flowSpawner: &flowSpawner{}}
	e.a.Chats.Spawners[model.Claude] = hs
	refused := func(want int, method, path, body, code, text string) {
		t.Helper()
		out := decode[obj](t, e.expect(want, method, path, body))
		msg, _ := out["error"].(string)
		if msg == "" || !strings.Contains(msg, text) {
			t.Fatalf("%s %s %s: the error %q, want one with %q", method, path, body, msg, text)
		}
		if got, has := out["code"]; (code == "" && has) || (code != "" && got != code) {
			t.Fatalf("%s %s %s: the code %v, want %q", method, path, body, got, code)
		}
	}
	forkOf := func(path, body string) string {
		t.Helper()
		fork := decode[obj](t, e.expect(200, "POST", path+"/fork", body))
		if fork["fresh"] != true || fork["locked"] != true {
			t.Fatalf("the fork's view %v", fork)
		}
		return "/api/chats/" + fork["id"].(string)
	}
	stateOf := func(path string) obj {
		t.Helper()
		st, _ := e.get(path + "/items")["state"].(obj)
		return st
	}

	// 200: the view and the state record have the choice, and the fork is still fresh.
	fork := forkOf(chat, `{"branch":"main","at":3}`)
	started := hs.count()
	okAnswer(t, "PATCH on a fresh fork", e.expect(200, "PATCH", fork, `{"model":"opus","effort":"max"}`))
	if v := e.get(fork); v["model"] != "opus" || v["effort"] != "max" || v["fresh"] != true || v["status"] != "ready" {
		t.Fatalf("the fork's view after the patch %v", v)
	}
	if u, _ := e.get(fork)["usage"].(obj); u["ctxWindow"] != float64(1000000) {
		t.Fatalf("the fork's usage after the patch %v", u)
	}
	if st := stateOf(fork); st["model"] != "opus" || st["effort"] != "max" || st["fresh"] != true {
		t.Fatalf("the fork's state record after the patch %v", st)
	}
	if hs.count() != started+1 {
		t.Fatalf("%d processes started for the patch", hs.count()-started)
	}
	// Its branch named, and a choice it has already: 200, the second with no new process.
	okAnswer(t, "PATCH with the branch named", e.expect(200, "PATCH", fork+"?branch=main", `{"effort":"low"}`))
	okAnswer(t, "PATCH with the same choice", e.expect(200, "PATCH", fork, `{"model":"opus","effort":"low"}`))
	if st := stateOf(fork); st["model"] != "opus" || st["effort"] != "low" || hs.count() != started+2 {
		t.Fatalf("the fork's state record %v; %d processes started", st, hs.count()-started)
	}
	if v := e.get(chat); v["model"] != "sonnet" || v["effort"] != "high" {
		t.Fatalf("the source's view %v", v)
	}

	// 409 with a folder; 400 for a choice that cannot be.
	dir := t.TempDir()
	refused(409, "PATCH", fork, `{"cwd":"`+dir+`"}`, "", chats.ErrLocked.Error())
	refused(409, "PATCH", fork, `{"model":"haiku","cwd":"`+dir+`"}`, "", chats.ErrLocked.Error())
	refused(400, "PATCH", fork, `{"model":"nope"}`, "", `unknown model "nope"`)
	refused(400, "PATCH", fork, `{"model":"haiku","effort":"high"}`, "", `haiku has no effort "high"`)

	// 409 busy while the start of a change is going on, for a second change and for a message.
	waiting, release := hs.hold()
	type answer struct {
		status int
		body   string
	}
	done := make(chan answer, 1)
	go func() {
		req, _ := http.NewRequest("PATCH", e.url+fork, strings.NewReader(`{"model":"haiku"}`))
		req.Header.Set(ClientHeader, clientID)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			done <- answer{body: err.Error()}
			return
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		done <- answer{resp.StatusCode, string(b)}
	}()
	select {
	case <-waiting:
	case <-time.After(5 * time.Second):
		t.Fatal("the patch did not reach the fork start")
	}
	if v := e.get(fork); v["status"] != "thinking" || v["model"] != "haiku" || v["fresh"] != true {
		t.Fatalf("the fork's view during the start %v", v)
	}
	refused(409, "PATCH", fork, `{"model":"sonnet"}`, "busy", chats.ErrBusy.Error())
	refused(409, "POST", fork+"/messages", `{"text":"too soon","context":""}`, "busy", chats.ErrBusy.Error())
	release()
	select {
	case got := <-done:
		if got.status != 200 {
			t.Fatalf("the patch a second one came in during: %d %s", got.status, got.body)
		}
		okAnswer(t, "the patch a second one came in during", got.body)
	case <-time.After(5 * time.Second):
		t.Fatal("the patch did not return")
	}
	if v := e.get(fork); v["status"] != "ready" || v["model"] != "haiku" || v["fresh"] != true {
		t.Fatalf("the fork's view after the start %v", v)
	}
	absent(t, "the fork's view on a model without efforts", e.get(fork), "effort")

	// 409 window: pi, by the context the fork got from its source.
	piFork := forkOf(pi, `{"branch":"main","at":3}`)
	refused(409, "PATCH", piFork, `{"model":"small"}`, "window", "Small takes 32000 tokens and the conversation holds about 20000")
	if v := e.get(piFork); v["model"] != "big" || v["status"] != "ready" || v["fresh"] != true {
		t.Fatalf("the pi fork's view after the refusal %v", v)
	}
	okAnswer(t, "PATCH of the pi fork's effort", e.expect(200, "PATCH", piFork, `{"effort":"high"}`))
	if v := e.get(piFork); v["model"] != "big" || v["effort"] != "high" {
		t.Fatalf("the pi fork's view after the patch %v", v)
	}

	// The fork's first message fixes them.
	sentOn(t, "send", e.expect(200, "POST", fork+"/messages", `{"text":"on the fork","context":""}`), "main")
	refused(409, "PATCH", fork, `{"model":"opus"}`, "", chats.ErrLocked.Error())
	absent(t, "the fork's view after its first message", e.get(fork), "fresh")
}
