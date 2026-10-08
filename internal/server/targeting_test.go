package server

import (
	"encoding/json"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// Which clients an event reaches, with the real senders (the app, the boards, the chat manager and
// the run service) and stand-in pages (bridgetest) against the real handler: a list event goes to
// every page, a content event of a chat or a run only to the pages that follow it, which a page
// does by reading it. The env's own client "A" makes the calls the tests do not give to a page.

// typeOf is the "type" of an event as the server sent it.
func typeOf(raw string) string {
	var ev struct{ Type string }
	json.Unmarshal([]byte(raw), &ev)
	return ev.Type
}

// sent returns, for each page, the events it was sent and has not read yet, as the server sent
// them. It makes a group, which every page is told of, and reads each page up to that event:
// what was sent before the call is in the lists, and the event of the mark is not.
func (e *env) sent(pages ...*bridgetest.Page) [][]string {
	e.t.Helper()
	g, err := e.a.CreateGroup("mark "+strconv.FormatInt(marks.Add(1), 10), "")
	if err != nil {
		e.t.Fatal(err)
	}
	out := make([][]string, len(pages))
	for i, p := range pages {
		for {
			raw := p.NextRaw()
			if typeOf(raw) == "groups" && strings.Contains(raw, g.ID) {
				break
			}
			out[i] = append(out[i], raw)
		}
	}
	return out
}

// upTo reads the page's events up to the first of this type that names all of has, and returns
// them, that one last. The events of a run come from its queue, so a test waits for them here.
func upTo(t *testing.T, p *bridgetest.Page, typ string, has ...string) []string {
	t.Helper()
	var got []string
	for {
		raw := p.NextRaw()
		got = append(got, raw)
		if typeOf(raw) == typ && !slices.ContainsFunc(has, func(s string) bool { return !strings.Contains(raw, s) }) {
			return got
		}
	}
}

// count is how many of the events are of this type and name all of has.
func count(evs []string, typ string, has ...string) (n int) {
	for _, raw := range evs {
		if typeOf(raw) == typ && !slices.ContainsFunc(has, func(s string) bool { return !strings.Contains(raw, s) }) {
			n++
		}
	}
	return n
}

// types names the events, for a failure's text.
func types(evs []string) []string {
	out := make([]string, len(evs))
	for i, raw := range evs {
		out[i] = typeOf(raw)
	}
	return out
}

// reached checks one row of the event table after a step: the follower was sent an event of
// this type that names all of has, and the other page was too exactly when all is true.
func reached(t *testing.T, when string, follower, other []string, all bool, typ string, has ...string) {
	t.Helper()
	if count(follower, typ, has...) == 0 {
		t.Errorf("%s: the page that follows got no %s: %v", when, typ, types(follower))
	}
	if n := count(other, typ, has...); all && n == 0 {
		t.Errorf("%s: the other page got no %s: %v", when, typ, types(other))
	} else if !all && n != 0 {
		t.Errorf("%s: the page that does not follow got %d %s", when, n, typ)
	}
}

// open is the page reading the chat's thread, which makes it follow the chat.
func open(t *testing.T, p *bridgetest.Page, chat string) {
	t.Helper()
	if status, out := p.Do("GET", "/api/chats/"+chat+"/items", nil); status != 200 {
		t.Fatalf("page %s: the items of %s: %d %s", p.ID, chat, status, out)
	}
}

// flowEnv is an env whose Claude chats are driven by the test (flowSpawner).
func flowEnv(t *testing.T) (*env, *flowSpawner) {
	t.Helper()
	sp := &flowSpawner{}
	return newEnv(t, func(s *Server) { s.App.Chats.Spawners[model.Claude] = sp }), sp
}

// working makes a chat in the ungrouped area with a turn running, and returns its agent.
func (e *env) working(sp *flowSpawner) (id string, a *fakeAgent) {
	e.t.Helper()
	id = e.chat(`{"agent":"claude","group":"__ungrouped__"}`).ID
	e.expect(200, "POST", "/api/chats/"+id+"/messages", `{"text":"ask","context":""}`)
	return id, sp.last(e.t)
}

// Every row of the event table whose sender is the app, the boards or the chat manager: who is
// sent it, of a page that follows the chat and one that does not.
func TestEventsOfAChatReachWhoTheyConcern(t *testing.T) {
	t.Parallel()
	e, sp := flowEnv(t)
	f, o := e.page("F"), e.page("O")
	step := func() (follower, other []string) {
		t.Helper()
		got := e.sent(f, o)
		return got[0], got[1]
	}

	// groups and defaults (the app), board and board_removed (the boards): every page.
	e.expect(200, "POST", "/api/groups", `{"name":"G"}`)
	fg, og := step()
	reached(t, "a new group", fg, og, true, "groups")
	reached(t, "a new group", fg, og, true, "defaults")
	b := e.board(model.Ungrouped)
	fg, og = step()
	reached(t, "a new board", fg, og, true, "board", b.ID)
	e.expect(200, "DELETE", "/api/boards/"+b.ID, "")
	fg, og = step()
	reached(t, "a deleted board", fg, og, true, "board_removed", b.ID)
	// agents, as main sends it when the usable agents change: every page.
	e.s.Bridge.Broadcast(map[string]any{"type": "agents", "agents": []model.AgentKind{model.Claude}})
	fg, og = step()
	reached(t, "the usable agents", fg, og, true, "agents")

	// chat: every page. Nobody follows the chat yet, so nobody is sent what is in it.
	id := e.chat(`{"agent":"claude","group":"__ungrouped__"}`).ID
	fg, og = step()
	reached(t, "a new chat", fg, og, true, "chat", id)
	open(t, f, id)

	// A message: the items and the tree to the follower; the state record, the view and the
	// sticky defaults (the manager's own event) to every page.
	e.expect(200, "POST", "/api/chats/"+id+"/messages", `{"text":"ask","context":""}`)
	a := sp.last(t)
	fg, og = step()
	reached(t, "a message", fg, og, false, "chat_items", id)
	reached(t, "a message", fg, og, false, "tree", id)
	reached(t, "a message", fg, og, true, "branch_state", id)
	reached(t, "a message", fg, og, true, "chat", id)
	reached(t, "a message", fg, og, true, "defaults")

	// catalog (the manager's own event, of no chat): every page.
	emit(t, a, agent.Event{Kind: agent.EvCatalog, Catalog: &model.Catalog{Models: []model.CatalogModel{{ID: "m-one"}}}})
	fg, og = step()
	reached(t, "the agent's catalog", fg, og, true, "catalog", "m-one")

	// sub and sub_items: the follower.
	emit(t, a,
		agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Agent"},
		agent.Event{Kind: agent.EvSub, Sub: "t1", SubInfo: &agent.SubInfo{Status: model.SubRunning, Description: "count files"}},
		agent.Event{Kind: agent.EvText, Sub: "t1", Text: "looking"})
	fg, og = step()
	reached(t, "a subagent", fg, og, false, "sub", id)
	reached(t, "a subagent", fg, og, false, "sub_items", id)
	reached(t, "a subagent", fg, og, false, "chat_items", id)

	// The end of the turn: again the list events to every page, the content to the follower.
	reply(t, a, "done", "p1")
	fg, og = step()
	reached(t, "the turn's end", fg, og, false, "chat_items", id)
	reached(t, "the turn's end", fg, og, false, "tree", id)
	reached(t, "the turn's end", fg, og, true, "branch_state", id)
	reached(t, "the turn's end", fg, og, true, "chat", id)

	// chat_removed: every page, and the follows of the chat end with it.
	e.expect(200, "DELETE", "/api/chats/"+id, "")
	fg, og = step()
	reached(t, "a deleted chat", fg, og, true, "chat_removed", id)
	if got := e.s.Bridge.Followers(editorbridge.Chat(id)); len(got) != 0 {
		t.Errorf("followers of the deleted chat: %v", got)
	}
}

// A content event reaches a page only after its read, and after a reconnect only after a new
// read.
func TestContentOnlyAfterTheRead(t *testing.T) {
	t.Parallel()
	e, sp := flowEnv(t)
	p := e.page("P")
	id, a := e.working(sp)
	say := func(text string) []string {
		t.Helper()
		emit(t, a, agent.Event{Kind: agent.EvText, Text: text})
		return e.sent(p)[0]
	}
	if got := say("one"); count(got, "chat_items") != 0 || count(got, "tree") != 0 || count(got, "chat", id) == 0 {
		t.Fatalf("before the read: %v", types(got))
	}
	open(t, p, id)
	if got := say("two"); count(got, "chat_items", id) == 0 {
		t.Fatalf("after the read: %v", types(got))
	}

	// The same page connects again: its new stream follows nothing.
	p = e.page("P")
	if got := e.s.Bridge.Followers(editorbridge.Chat(id)); len(got) != 0 {
		t.Fatalf("followers after the reconnect: %v", got)
	}
	if got := say("three"); count(got, "chat_items") != 0 {
		t.Fatalf("after the reconnect, before a read: %v", types(got))
	}
	// The read of the tree follows as the read of the items does.
	if status, out := p.Do("GET", "/api/chats/"+id+"/tree", nil); status != 200 {
		t.Fatalf("the tree: %d %s", status, out)
	}
	if got := say("four"); count(got, "chat_items", id) == 0 {
		t.Fatalf("after the reconnect and a new read: %v", types(got))
	}
	// An unfollow ends it.
	if status, out := p.Do("POST", "/api/chats/"+id+"/unfollow", nil); status != 200 {
		t.Fatalf("the unfollow: %d %s", status, out)
	}
	if got := say("five"); count(got, "chat_items") != 0 {
		t.Fatalf("after the unfollow: %v", types(got))
	}
}

// Two pages that follow the same chats are sent the same events in the same order, whatever the
// order the chats' agents work in.
func TestTwoFollowersGetTheSameEventsInTheSameOrder(t *testing.T) {
	t.Parallel()
	e, sp := flowEnv(t)
	p, q := e.page("P"), e.page("Q")
	one, a := e.working(sp)
	two, b := e.working(sp)
	for _, page := range []*bridgetest.Page{p, q} {
		open(t, page, one)
		open(t, page, two)
	}
	e.sent(p, q)

	var wg sync.WaitGroup
	for _, ag := range []*fakeAgent{a, b} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range 25 {
				ag.ch <- agent.Event{Kind: agent.EvText, Text: "part " + strconv.Itoa(i)}
				ag.ch <- agent.Event{Kind: agent.EvToolStart, ToolID: "t" + strconv.Itoa(i), ToolName: "Bash"}
				ag.ch <- agent.Event{Kind: agent.EvToolResult, ToolID: "t" + strconv.Itoa(i), Result: "ok"}
			}
			ag.ch <- agent.Event{Kind: agent.EvTurnEnd, Point: "p1"}
			ag.ch <- flowSync
		}()
	}
	wg.Wait()
	got := e.sent(p, q)
	if !slices.Equal(got[0], got[1]) {
		t.Fatalf("the two pages were sent different events:\n%v\n%v", types(got[0]), types(got[1]))
	}
	for _, id := range []string{one, two} {
		if n := count(got[0], "chat_items", id); n < 25 {
			t.Errorf("%d chat_items events of %s", n, id)
		}
		if count(got[0], "tree", id) == 0 || count(got[0], "chat", id) == 0 || count(got[0], "branch_state", id) == 0 {
			t.Errorf("the events of %s: %v", id, types(got[0]))
		}
	}
}

// A second page's connect leaves what the first page follows.
func TestAConnectLeavesTheFollowsOfOthers(t *testing.T) {
	t.Parallel()
	e, sp := flowEnv(t)
	p := e.page("P")
	id, a := e.working(sp)
	open(t, p, id)
	q := e.page("Q")
	if got := e.s.Bridge.Followers(editorbridge.Chat(id)); !slices.Equal(got, []string{"P"}) {
		t.Fatalf("followers after another page connected: %v", got)
	}
	emit(t, a, agent.Event{Kind: agent.EvText, Text: "more"})
	got := e.sent(p, q)
	if count(got[0], "chat_items", id) == 0 || count(got[1], "chat_items") != 0 {
		t.Fatalf("the first page: %v; the new one: %v", types(got[0]), types(got[1]))
	}
}

// The rows of a run, with the real run service and engine: run and run_removed go to every
// page, run_detail and run_activity to the page that read the run's detail. The chat of a run's
// agent is in nobody's list: its view and its items go only to the page that read its items, and
// a page that connects meanwhile takes nothing from it.
func TestEventsOfARunReachWhoTheyConcern(t *testing.T) {
	t.Parallel()
	e := newRunEnvOn(t, quickTicks{}) // the test waits for a tick
	said, next := make(chan struct{}, 8), make(chan struct{})
	e.fake.Script(func(t *agenttest.Turn) {
		t.Say("first")
		t.Tool("Bash", map[string]any{"command": "ls -la"}, "total 0", false)
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
	f, o := e.page("F"), e.page("O")
	// ofAgent is how many of the events are of the chat of the run's agent.
	ofAgent := func(evs []string, orch string) (n int) {
		for _, typ := range []string{"chat", "chat_items", "sub", "sub_items", "branch_state", "tree"} {
			n += count(evs, typ, orch)
		}
		return n
	}

	// run: every page.
	v := e.newRun()
	upTo(t, f, "run", v.ID)
	upTo(t, o, "run", v.ID)

	// The page reads the run's detail and so follows it; a draft has none to give yet.
	if status, out := f.Do("GET", "/api/runs/"+v.ID+"/detail", nil); status != 409 {
		t.Fatalf("the detail of a draft: %d %s", status, out)
	}
	e.view(200, "POST", "/api/runs/"+v.ID+"/start", `{"goal":"Look around."}`)
	<-said
	orch := e.detail(v.ID).Turns[0].Agent
	// run_detail and run_activity: the follower. run, and the defaults the start records (sent
	// from the runs' queue), go to every page.
	fg := upTo(t, f, "run_activity", v.ID, orch)
	og := e.sent(o)[0]
	reached(t, "the start", fg, og, false, "run_activity", v.ID)
	reached(t, "the start", fg, og, false, "run_detail", v.ID)
	reached(t, "the start", fg, og, true, "run", v.ID)
	reached(t, "the start", fg, og, true, "defaults")
	if n, m := ofAgent(fg, orch), ofAgent(og, orch); n != 0 || m != 0 {
		t.Fatalf("events of the agent's chat before its items were read: %d and %d", n, m)
	}

	// The follower reads the agent's items; another page connects.
	open(t, f, orch)
	q := e.page("Q")
	if got := e.s.Bridge.Followers(editorbridge.Chat(orch)); !slices.Equal(got, []string{"F"}) {
		t.Fatalf("followers of the agent's chat: %v", got)
	}
	close(next)
	<-said
	fg = upTo(t, f, "chat_items", orch, "second")
	// The stop ends the agent's turn: its view changes.
	e.expect(200, "POST", "/api/runs/"+v.ID+"/stop", "")
	e.awaitRun(v.ID, "to stop", func(v model.RunView) bool { return v.Status == model.RunStopped })
	fg = append(fg, upTo(t, f, "chat", orch)...)
	fg = append(fg, e.sent(f)[0]...)
	rest := e.sent(o, q)
	for i, got := range rest {
		if n := ofAgent(got, orch); n != 0 {
			t.Errorf("page %d that did not read the agent's items got %d of its events", i, n)
		}
		if count(got, "run_detail") != 0 || count(got, "run_activity") != 0 {
			t.Errorf("page %d that does not follow the run: %v", i, types(got))
		}
		if count(got, "run", v.ID) == 0 {
			t.Errorf("page %d got no run event of the stop: %v", i, types(got))
		}
	}
	if count(fg, "branch_state", orch) != 0 || count(fg, "tree", orch) != 0 {
		t.Errorf("a state record or a tree event of the agent's chat: %v", types(fg))
	}

	// run_removed: every page, and the follows of the run and of its agent's chat end.
	e.expect(200, "DELETE", "/api/runs/"+v.ID, "")
	for _, p := range []*bridgetest.Page{f, o, q} {
		upTo(t, p, "run_removed", v.ID)
	}
	for _, it := range []editorbridge.Item{editorbridge.Run(v.ID), editorbridge.Chat(orch)} {
		if got := e.s.Bridge.Followers(it); len(got) != 0 {
			t.Errorf("followers of %v after the delete: %v", it, got)
		}
	}
}
