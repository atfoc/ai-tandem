package remotes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers/standin"
)

const agent3 = "3c000000-0000-4000-8000-000000000003"

// TestRunEventTable: every row of the table of a remote server's run events, as two pages see
// it: one that read the run's detail and the chat of one of its agents, and one that did not.
func TestRunEventTable(t *testing.T) {
	t.Parallel()
	seed := runSeedOf(runA)
	rg := newRig(t, rigOpt{snapshot: snapshotWithRuns(seed.View), runSeed: []RunRecord{seed}})
	rg.serveRuns(agent1)
	reader, snap := rg.page("page-reader")
	other, _ := rg.page("page-other")

	// The page's snapshot is built from the relay with the bridge's lock held.
	if got := field(snap, "runs").([]any); len(got) != 1 || field(got[0], "id") != runA || field(got[0], "server") != rg.entry || field(got[0], "group") != "g_here" {
		t.Errorf("the snapshot's runs: %v", got)
	}
	// The detail read makes the page a follower, and its answer tells the first agent.
	rg.readRun(reader, runA)
	if got := rg.requests("GET", "/api/runs/"+runA+"/detail"); len(got) != 1 || got[0].Client != testLocalID || got[0].Secret != standin.DefaultSecret {
		t.Fatalf("the detail read at the server: %+v", got)
	}
	if run, ok := rg.r.AgentChat(agent1); !ok || run != runA {
		t.Fatalf("the agent of the detail answer is not learned: %q, %v", run, ok)
	}
	var seen []string // every event of both pages, as it came
	next := func(p *bridgetest.Page) map[string]any {
		t.Helper()
		raw := p.NextRaw()
		seen = append(seen, raw)
		var ev map[string]any
		if err := json.Unmarshal([]byte(raw), &ev); err != nil {
			t.Fatal(err)
		}
		return ev
	}
	both := []*bridgetest.Page{reader, other}

	// run: status, counts and attention are the server's (AC17); the place, the entry and the
	// mark's action are this server's; what belongs to a draft never reaches a page.
	cost := 0.25
	view := remoteRun(runA, model.RunStalled)
	view.Archive = model.Archive{Archived: true, Op: "a_there"}
	view.Server, view.Start, view.Was, view.Dirty, view.Gone = "s_there", model.RemoteUnconfirmed, "r_was00000", true, true
	view.Draft, view.TierDefaults = &model.Draft{Text: "typed there"}, &model.RunTiers{}
	view.Counts, view.Attention, view.Cost, view.Turns = model.RunCounts{Done: 2, Failed: 1, Work: 3}, 4, &cost, 5
	view.Reason, view.StalledBy = "No progress in three turns.", model.StalledIdle
	rg.s.Send(map[string]any{"type": "run", "run": view})
	for _, p := range both {
		ev := next(p)
		c, _ := ev["run"].(map[string]any)
		if ev["type"] != "run" || c["id"] != runA || c["group"] != "g_here" || c["server"] != rg.entry || c["archived"] != true ||
			c["status"] != "stalled" || c["stalledBy"] != "idle" || c["reason"] != view.Reason || c["attention"] != float64(4) ||
			field(c, "counts", "done") != float64(2) || field(c, "counts", "failed") != float64(1) || field(c, "counts", "work") != float64(3) ||
			c["cost"] != 0.25 || c["turns"] != float64(5) || c["name"] != view.Name || c["cwd"] != view.Cwd {
			t.Errorf("page %s: run event %v", p.ID, ev)
		}
		for _, k := range []string{"archiveOp", "draft", "tierDefaults", "start", "was", "dirty", "gone"} {
			if _, has := c[k]; has {
				t.Errorf("page %s: the run has %q: %v", p.ID, k, c[k])
			}
		}
	}

	// run_detail and run_activity: the bytes that came, to the page that read alone. The agents
	// they name are learned.
	for _, ev := range []map[string]any{
		{"type": "run_detail", "run": runA, "version": 3, "patch": map[string]any{
			"status": "running", "agents": map[string]any{agent2: map[string]any{"role": "task", "title": "<b>a & b</b> ünï  "}},
		}},
		{"type": "run_activity", "run": runA, "agents": map[string]any{agent3: map[string]any{"activity": "Bash", "tools": 2}}},
	} {
		want, _ := json.Marshal(ev)
		rg.s.Send(ev)
		got := reader.NextRaw()
		seen = append(seen, got)
		if got != string(want) {
			t.Errorf("%s: the reader got\n%s\nwant\n%s", ev["type"], got, want)
		}
	}
	for _, a := range []string{agent1, agent2, agent3} {
		if run, ok := rg.r.AgentChat(a); !ok || run != runA {
			t.Errorf("AgentChat(%s): %q, %v", a, run, ok)
		}
	}
	// An event that names its type or its run twice is not handed on: a page would read another
	// event than the one that was routed.
	for _, raw := range []string{
		`{"type":"run_detail","run":"` + runA + `","run":"r_local001","version":4,"patch":{}}`,
		`{"type":"run_detail","type":"servers","run":"` + runA + `","servers":[]}`,
		`{"type":"servers","Type":"run_detail","run":"` + runA + `","servers":[]}`,
	} {
		rg.r.event(rg.entry, "run_detail", json.RawMessage(raw))
	}

	// The events of an agent's chat: the bytes that came, to the page that read that chat alone.
	// The chat is in nobody's list, so its view and its state go to followers only too.
	rg.readAgent(reader, agent1)
	rg.b.FollowAs(editorbridge.KindPage, other.ID, editorbridge.Chat(agent2)) // it follows another agent
	agentView := remoteView(agent1, model.StatusThinking)
	agentView.Run, agentView.Role, agentView.Group = runA, "task", ""
	for _, ev := range []map[string]any{
		{"type": "chat", "chat": agentView},
		{"type": "branch_state", "state": model.BranchState{Chat: agent1, Branch: mainBranch, Status: model.StatusTool, StatusTool: "Bash"}},
		{"type": "chat_items", "chat": agent1, "branch": "main", "version": 4, "updates": []any{map[string]any{"id": "i1", "text": "<i>x</i>"}}},
		{"type": "tree", "chat": agent1, "nodes": []any{map[string]any{"id": "main"}}},
		{"type": "sub", "chat": agent1, "branch": "main", "subagent": map[string]any{"id": "sa1", "status": "running"}},
		{"type": "sub_items", "chat": agent1, "branch": "main", "sub": "sa1", "version": 2, "updates": []any{}},
	} {
		want, _ := json.Marshal(ev)
		rg.s.Send(ev)
		got := reader.NextRaw()
		seen = append(seen, got)
		if got != string(want) {
			t.Errorf("%s of an agent's chat: the reader got\n%s\nwant\n%s", ev["type"], got, want)
		}
	}
	// The removal of an agent's chat is dropped, and so is an event of one that names its chat
	// or its type twice.
	rg.s.Send(map[string]any{"type": "chat_removed", "id": agent1})
	rg.s.Send(json.RawMessage(`{"type":"chat","chat":{"id":"another"},"chat":{"id":"` + agent1 + `"}}`))
	rg.s.Send(json.RawMessage(`{"type":"branch_state","type":"servers","state":{"chat":"` + agent1 + `"}}`))
	for i, got := range rg.barrier(reader, other) {
		if len(got) != 0 {
			t.Errorf("page %d got %v", i, got)
		}
	}
	if n := rg.r.dropped.Load(); n != 0 {
		t.Errorf("%d events of an agent's chat were counted as those of a chat without a record", n)
	}
	if !rg.b.Followed(editorbridge.Chat(agent1)) || !rg.b.Followed(editorbridge.Run(runA)) {
		t.Fatal("the reader follows no more")
	}

	// run_removed: not passed on; the run is gone, and stays listed. Its follows and those of
	// its agents' chats are forgotten, so nothing of them reaches a page after it.
	rg.s.Send(map[string]any{"type": "run_removed", "id": runA})
	for _, p := range both {
		ev := next(p)
		if ev["type"] != "run" || field(ev, "run", "id") != runA || field(ev, "run", "gone") != true || field(ev, "run", "status") != "stalled" {
			t.Errorf("page %s: after run_removed: %v", p.ID, ev)
		}
	}
	if !rg.runFile(runA).Gone || !rg.r.HasRun(runA) {
		t.Error("the gone mark is not written at once, or the record is no more")
	}
	for _, it := range []editorbridge.Item{editorbridge.Run(runA), editorbridge.Chat(agent1), editorbridge.Chat(agent2)} {
		if rg.b.Followed(it) {
			t.Errorf("%v is followed after run_removed", it)
		}
	}
	rg.s.Send(map[string]any{"type": "chat_items", "chat": agent1, "branch": "main", "version": 5, "updates": []any{}})
	rg.s.Send(map[string]any{"type": "run_detail", "run": runA, "version": 4, "patch": map[string]any{}})
	rg.s.Send(map[string]any{"type": "run_removed", "id": runA}) // twice: nothing more
	for i, got := range rg.barrier(reader, other) {
		if len(got) != 0 {
			t.Errorf("after run_removed page %d got %v", i, got)
		}
	}
	if _, ok := rg.r.AgentChat(agent1); !ok {
		t.Error("the agents of a gone run are forgotten before its record is")
	}

	// A run event after it: the run is there again.
	rg.s.Send(map[string]any{"type": "run", "run": remoteRun(runA, model.RunRunning)})
	for _, p := range both {
		ev := next(p)
		c, _ := ev["run"].(map[string]any)
		if _, gone := c["gone"]; ev["type"] != "run" || gone || c["status"] != "running" || c["archived"] != nil {
			t.Errorf("page %s: the run that is there again: %v", p.ID, ev)
		}
	}
	if rg.runFile(runA).Gone {
		t.Error("the file still says gone")
	}
	if n := rg.r.droppedRuns.Load(); n != 0 {
		t.Errorf("%d events were counted as dropped for a run without a record", n)
	}

	// No secret reached a page, the file or a log line.
	file, _ := os.ReadFile(rg.r.runFiles.path(runA))
	for _, s := range append(seen, string(file), strings.Join(rg.logs.all(), "\n")) {
		if strings.Contains(s, standin.DefaultSecret) {
			t.Errorf("the secret is in %s", s)
		}
	}
}

// TestRunWithoutARecord: an event of a run without a record is dropped and counted, and logged
// once for its id; the first run event of a start, whose draft is still here and whose start
// call is under way, is not logged. A server's event never reaches the record of another
// server's run, nor the chat of its agent.
func TestRunWithoutARecord(t *testing.T) {
	t.Parallel()
	seed := runSeedOf(runA)
	seed.Agents = []string{agent1}
	rg := newRig(t, rigOpt{snapshot: snapshotWithRuns(seed.View), runSeed: []RunRecord{seed}})
	p, _ := rg.page("page-1")
	// The page would get what is handed on.
	for _, it := range []editorbridge.Item{editorbridge.Run(runB), editorbridge.Run(runA), editorbridge.Chat(agent1)} {
		rg.b.FollowAs(editorbridge.KindPage, p.ID, it)
	}

	rg.s.Send(map[string]any{"type": "run", "run": remoteRun(runB, model.RunRunning)})
	rg.s.Send(map[string]any{"type": "run_detail", "run": runB, "version": 2, "patch": map[string]any{"agents": map[string]any{agent2: map[string]any{}}}})
	rg.s.Send(map[string]any{"type": "run_activity", "run": runB, "agents": map[string]any{agent3: map[string]any{}}})
	rg.s.Send(map[string]any{"type": "run_removed", "id": runB})
	if got := rg.barrier(p)[0]; len(got) != 0 {
		t.Errorf("the page got %v", got)
	}
	if n := rg.r.droppedRuns.Load(); n != 4 {
		t.Errorf("%d events counted as dropped, want 4", n)
	}
	if n := rg.logs.count(runB); n != 1 {
		t.Errorf("%d log lines for the id, want one a minute: %v", n, rg.logs.all())
	}
	if rg.r.HasRun(runB) {
		t.Error("an event made a record")
	}
	for _, a := range []string{agent2, agent3} {
		if _, ok := rg.r.AgentChat(a); ok {
			t.Errorf("the agent %s of a run without a record was learned", a)
		}
	}

	// The first run event of a start comes before the record, while the start call is under
	// way: counted, not logged, and the swap is left to that call.
	const draft = "r_draft001"
	rg.runs.draft(draft, rg.entry, "")
	free, _ := rg.r.locks.runStart.try(draft)
	rg.s.Send(map[string]any{"type": "run", "run": remoteRun(draft, model.RunRunning)})
	rg.barrier(p)
	free()
	if n := rg.r.droppedRuns.Load(); n != 5 || rg.logs.count(draft) != 0 || rg.r.HasRun(draft) || rg.runHanded(draft) {
		t.Errorf("the first run event of a start: %d dropped, the log %v", n, rg.logs.all())
	}

	// The same events from another entry, for the run of this one: dropped, the record untouched.
	for typ, ev := range map[string]map[string]any{
		"run":          {"type": "run", "run": remoteRun(runA, model.RunError)},
		"run_removed":  {"type": "run_removed", "id": runA},
		"run_detail":   {"type": "run_detail", "run": runA, "version": 9, "patch": map[string]any{"agents": map[string]any{agent2: map[string]any{}}}},
		"run_activity": {"type": "run_activity", "run": runA, "agents": map[string]any{agent3: map[string]any{}}},
	} {
		raw, _ := json.Marshal(ev)
		rg.r.event("s_other", typ, raw)
	}
	if n := rg.r.droppedRuns.Load(); n != 9 {
		t.Errorf("%d events counted as dropped, want 9", n)
	}
	if v := rg.r.RunViews()[0]; v.Status != model.RunRunning || v.Gone {
		t.Errorf("another server changed the record: %+v", v)
	}
	if _, ok := rg.r.AgentChat(agent2); ok {
		t.Error("another server's event taught an agent")
	}
	// An agent's chat is its run's server's: another one's event of it is that of an unknown chat.
	raw, _ := json.Marshal(map[string]any{"type": "chat_items", "chat": agent1, "version": 1, "updates": []any{}})
	rg.r.event("s_other", "chat_items", raw)
	if n := rg.r.dropped.Load(); n != 1 {
		t.Errorf("%d events counted as dropped for a chat without a record, want 1", n)
	}
	p.ExpectNone(quiet)
}

// TestRunAgentsLearned: which chat ids a record takes as those of its run's agents, and that
// what the other server sends never grows a record without limit.
func TestRunAgentsLearned(t *testing.T) {
	t.Parallel()
	a, b := runSeedOf(runA), runSeedOf(runB)
	chat := seedOf(chatA)
	rg := newRig(t, rigOpt{snapshot: snapshotWithRuns(a.View, b.View), seed: []Record{chat}, runSeed: []RunRecord{a, b}})
	rg.local.mu.Lock()
	rg.local.known = map[string]bool{chatB: true}
	rg.local.mu.Unlock()
	recA, recB := rg.r.runRec(runA), rg.r.runRec(runB)

	// Not an id of another form, not one with a chat record, not a chat of this server.
	rg.r.learn(recA, []string{agent1, chatA, chatB, "../x", "", agent1, strings.Repeat("a", 65)})
	if got := recA.agents(); !reflect.DeepEqual(got, []string{agent1}) {
		t.Errorf("the agents of the first run: %v", got)
	}
	for _, id := range []string{chatA, chatB, "../x", ""} {
		if _, ok := rg.r.AgentChat(id); ok {
			t.Errorf("%q is an agent chat", id)
		}
	}
	// An agent is one run's.
	rg.r.learn(recB, []string{agent1, agent2})
	if got := recB.agents(); !reflect.DeepEqual(got, []string{agent2}) {
		t.Errorf("the agents of the second run: %v", got)
	}
	if run, _ := rg.r.AgentChat(agent1); run != runA {
		t.Errorf("the first run's agent is now %q's", run)
	}
	// The detail answer.
	rg.r.learnDetail(recB, []byte(`{"run":"`+runB+`","version":3,"agents":{"`+agent3+`":{"role":"orchestrator"}}}`))
	rg.r.learnDetail(recB, []byte(`{"agents":["no","map"]}`))
	rg.r.learnDetail(recB, []byte(`not JSON`))
	if got := recB.agents(); !reflect.DeepEqual(got, []string{agent2, agent3}) {
		t.Errorf("the agents after a detail answer: %v", got)
	}
	// A chat record that is made under an agent's id later is that record's.
	if rg.r.agentRun(agent2) != recB || rg.r.agentOn(rg.entry, agent2) != recB || rg.r.agentOn("s_other", agent2) != nil {
		t.Error("agentRun and agentOn of a learned agent")
	}
	rg.adopt(seedOf(agent2))
	if rg.r.agentRun(agent2) != nil || rg.r.agentOn(rg.entry, agent2) != nil {
		t.Error("an id with a chat record is still a run agent's chat")
	}

	// At most maxAgents: more are dropped, and that is logged once.
	ids := func(from, n int) (out []string) {
		for i := from; i < from+n; i++ {
			out = append(out, fmt.Sprintf("agent-%04d", i))
		}
		return out
	}
	rg.r.learn(recA, ids(0, 300))
	rg.r.learn(recA, ids(300, 300))
	rg.r.learn(recA, ids(600, 50))
	if got := recA.agents(); len(got) != maxAgents || got[0] != agent1 || got[maxAgents-1] != "agent-0498" {
		t.Errorf("%d agents, the last %s", len(got), got[len(got)-1])
	}
	if n := rg.logs.count("more are dropped"); n != 1 {
		t.Errorf("%d log lines for the dropped agents: %v", n, rg.logs.all())
	}
	if _, ok := rg.r.AgentChat("agent-0499"); ok {
		t.Error("a dropped agent is in the lookup")
	}
	if _, ok := rg.r.AgentChat("agent-0620"); ok {
		t.Error("a dropped agent is in the lookup")
	}
	rg.until("the agents are flushed", func() bool { return len(rg.runFile(runA).Agents) == maxAgents })
	// The same from an event.
	big := map[string]any{}
	for _, id := range ids(1000, 100) {
		big[id] = map[string]any{}
	}
	raw, _ := json.Marshal(map[string]any{"type": "run_detail", "run": runA, "version": 2, "patch": map[string]any{"agents": big}})
	rg.r.event(rg.entry, "run_detail", raw)
	if got := recA.agents(); len(got) != maxAgents {
		t.Errorf("%d agents after an event with more", len(got))
	}
	if n := rg.logs.count("more are dropped"); n != 1 {
		t.Errorf("%d log lines for the dropped agents", n)
	}
	rg.r.mu.Lock()
	n := len(rg.r.agents)
	rg.r.mu.Unlock()
	if n != maxAgents+2 {
		t.Errorf("the lookup holds %d ids, want %d", n, maxAgents+2)
	}
}

// TestRunFollows: the content events of a run and of an agent's chat go to the pages that read
// them; the remote server is told to end a follow when the last page's stream ends, and not
// while another page follows.
func TestRunFollows(t *testing.T) {
	t.Parallel()
	seed := runSeedOf(runA)
	rg := newRig(t, rigOpt{snapshot: snapshotWithRuns(seed.View), runSeed: []RunRecord{seed}})
	rg.serveRuns(agent1)
	rec := rg.r.runRec(runA)
	first, _ := rg.page("page-first")
	second, _ := rg.page("page-second")
	for _, p := range []*bridgetest.Page{first, second} {
		rg.readRun(p, runA)
		rg.readAgent(p, agent1)
	}
	if got := rg.requests("GET", "/api/chats/"+agent1+"/items"); len(got) != 2 || got[0].Client != testLocalID {
		t.Fatalf("the reads of the agent's chat at the server: %+v", got)
	}
	unfollows := func() [2]int {
		return [2]int{len(rg.requests("POST", "/api/runs/"+runA+"/unfollow")), len(rg.requests("POST", "/api/chats/"+agent1+"/unfollow"))}
	}
	send := func(version int) {
		rg.s.Send(map[string]any{"type": "run_detail", "run": runA, "version": version, "patch": map[string]any{}})
		rg.s.Send(map[string]any{"type": "chat_items", "chat": agent1, "branch": "main", "version": version, "updates": []any{}})
	}
	got := func(p *bridgetest.Page, version int) {
		t.Helper()
		if ev := p.Expect("run_detail"); ev["run"] != runA || ev["version"] != float64(version) {
			t.Errorf("page %s: %v", p.ID, ev)
		}
		if ev := p.Expect("chat_items"); ev["chat"] != agent1 || ev["version"] != float64(version) {
			t.Errorf("page %s: %v", p.ID, ev)
		}
	}
	send(2)
	got(first, 2)
	got(second, 2)

	// The first page's stream ends: the other one follows on, and the server is told nothing.
	first.Close()
	rg.until("the first page's follows are gone", func() bool {
		return reflect.DeepEqual(rg.b.Followers(editorbridge.Run(runA)), []string{second.ID})
	})
	time.Sleep(quiet)
	if n := unfollows(); n != [2]int{} {
		t.Fatalf("unfollow calls while a page follows: %v", n)
	}
	send(3)
	got(second, 3)

	// The last one's stream ends: one unfollow call for the run and one for the agent's chat.
	second.Close()
	rg.until("both unfollow calls are at the server", func() bool { return unfollows() == [2]int{1, 1} })
	if q := rg.requests("POST", "/api/runs/"+runA+"/unfollow")[0]; q.Client != testLocalID || q.Secret != standin.DefaultSecret {
		t.Errorf("the unfollow call: %+v", q)
	}

	// A page that leaves the run, and then the agent's chat, by the unfollow route.
	third, _ := rg.page("page-third")
	rg.readRun(third, runA)
	rg.readAgent(third, agent1)
	rg.b.UnfollowAs(editorbridge.KindPage, third.ID, editorbridge.Run(runA))
	rg.until("the run's unfollow is at the server", func() bool { return unfollows() == [2]int{2, 1} })
	send(4)
	if ev := third.Expect("chat_items"); ev["version"] != float64(4) { // the run's detail no more
		t.Errorf("after the run's unfollow: %v", ev)
	}
	rg.b.UnfollowAs(editorbridge.KindPage, third.ID, editorbridge.Chat(agent1))
	rg.until("the chat's unfollow is at the server", func() bool { return unfollows() == [2]int{2, 2} })

	// A read for a client that has no stream here follows nothing here: the follow it made there
	// is ended after it, unless a page follows.
	stray := func() {
		t.Helper()
		if _, err := rg.r.followRun(context.Background(), rec, "page-without-a-stream", http.MethodGet, runPath(runA, "/detail"), wait); err != nil {
			t.Fatal(err)
		}
		if _, err := rg.r.followAgent(context.Background(), rec, agent1, "page-without-a-stream", http.MethodGet, chatPath(agent1, "/items"), wait); err != nil {
			t.Fatal(err)
		}
	}
	stray()
	rg.until("the unfollows after the reads are at the server", func() bool { return unfollows() == [2]int{3, 3} })
	rg.readRun(third, runA)
	rg.readAgent(third, agent1)
	stray()
	// Neither does the hook for an item that is followed again, for a run without a record or
	// for a chat that is no agent's.
	rg.r.Unfollowed([]editorbridge.Item{editorbridge.Run(runA), editorbridge.Chat(agent1), editorbridge.Run(runB), editorbridge.Chat("no-agent")})
	time.Sleep(quiet)
	if n := unfollows(); n != [2]int{3, 3} {
		t.Errorf("unfollow calls while a page follows: %v", n)
	}
	if got := len(rg.requests("POST", "/unfollow")); got != 6 {
		t.Errorf("%d unfollow calls in all, want 6", got)
	}

	// A run that is gone there is not unfollowed, nor are its agents' chats.
	rg.s.Send(map[string]any{"type": "run_removed", "id": runA})
	third.Expect("run")
	rg.r.Unfollowed([]editorbridge.Item{editorbridge.Run(runA), editorbridge.Chat(agent1)})
	time.Sleep(quiet)
	if n := unfollows(); n != [2]int{3, 3} {
		t.Errorf("unfollow calls for a gone run: %v", n)
	}
}

// TestRunUnfollowNeverOvertakesARead: the follow lock of a run, which is that of its agents'
// chats too. While a read is passed on the unfollow call waits, and while an unfollow call is
// out a read waits.
func TestRunUnfollowNeverOvertakesARead(t *testing.T) {
	t.Parallel()
	seed := runSeedOf(runA)
	seed.Agents = []string{agent1}
	rg := newRig(t, rigOpt{snapshot: snapshotWithRuns(seed.View), runSeed: []RunRecord{seed}})
	rec := rg.r.runRec(runA)
	var mu sync.Mutex
	var order []string
	note := func(s string) {
		mu.Lock()
		defer mu.Unlock()
		order = append(order, s)
	}
	noted := func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), order...)
	}
	hold := make(chan struct{}, 2)
	slow := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			note(name + " in")
			<-hold
			note(name + " out")
			writeJSONTest(w, map[string]any{})
		}
	}
	rg.s.Handle("GET /api/runs/{id}/detail", slow("detail"))
	rg.s.Handle("POST /api/runs/{id}/unfollow", slow("unfollow run"))
	rg.s.Handle("GET /api/chats/{id}/items", slow("items"))
	rg.s.Handle("POST /api/chats/{id}/unfollow", slow("unfollow chat"))
	p, _ := rg.page("page-1")
	detail := func() chan struct{} {
		done := make(chan struct{})
		go func() {
			defer close(done)
			_, _ = rg.r.followRun(context.Background(), rec, p.ID, http.MethodGet, runPath(runA, "/detail"), wait)
		}()
		return done
	}
	items := func() chan struct{} {
		done := make(chan struct{})
		go func() {
			defer close(done)
			_, _ = rg.r.followAgent(context.Background(), rec, agent1, p.ID, http.MethodGet, chatPath(agent1, "/items"), wait)
		}()
		return done
	}

	// A detail read is out and the page leaves the run at once: the unfollow waits for the answer.
	done := detail()
	rg.until("the read is at the server", func() bool { return len(noted()) == 1 })
	rg.b.UnfollowAs(editorbridge.KindPage, p.ID, editorbridge.Run(runA))
	time.Sleep(quiet)
	if got := noted(); !reflect.DeepEqual(got, []string{"detail in"}) {
		t.Fatalf("while the read is out: %v", got)
	}
	hold <- struct{}{}
	<-done
	rg.until("the unfollow is at the server", func() bool { return len(noted()) == 3 })

	// The run's unfollow is out: a read of an agent's chat waits for its answer.
	done = items()
	time.Sleep(quiet)
	if got := noted(); !reflect.DeepEqual(got, []string{"detail in", "detail out", "unfollow run in"}) {
		t.Fatalf("while the unfollow is out: %v", got)
	}
	hold <- struct{}{}
	rg.until("the read of the agent's chat is at the server", func() bool { return len(noted()) == 5 })

	// That read is out and the page leaves the chat: the chat's unfollow waits for the answer.
	rg.b.UnfollowAs(editorbridge.KindPage, p.ID, editorbridge.Chat(agent1))
	time.Sleep(quiet)
	if got := noted(); len(got) != 5 {
		t.Fatalf("while the read of the agent's chat is out: %v", got)
	}
	hold <- struct{}{}
	<-done
	rg.until("the chat's unfollow is at the server", func() bool { return len(noted()) == 7 })
	hold <- struct{}{}
	rg.until("the chat's unfollow is answered", func() bool { return len(noted()) == 8 })
	want := []string{"detail in", "detail out", "unfollow run in", "unfollow run out", "items in", "items out", "unfollow chat in", "unfollow chat out"}
	if got := noted(); !reflect.DeepEqual(got, want) {
		t.Errorf("the order at the server: %v", got)
	}
}

// TestRunSnapshotSteps: the steps of a stream's start with runs, in their order, as a page and
// the hook points see them. In every step the chats come before the runs. A run that the
// snapshot does not have is gone, and is back with a later snapshot that has it.
func TestRunSnapshotSteps(t *testing.T) {
	t.Parallel()
	chat := seedOf(chatA)
	there := remoteRun(runA, model.RunStalled)
	snap := snapshotWith(chat.View)
	snap["runs"] = []model.RunView{remoteRun("r_zzzz0009", model.RunRunning), there}
	a, b := runSeedOf(runA), runSeedOf(runB)
	a.Agents = []string{agent1}
	a.Pending, a.Op = pendingArchive, "a_here" // an archive that is not confirmed: it wins at a snapshot

	var mu sync.Mutex
	var steps []string
	note := func(s string) {
		mu.Lock()
		defer mu.Unlock()
		steps = append(steps, s)
	}
	noted := func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), steps...)
	}
	var pendingChats, pendingRuns atomic.Int32
	rg := newRig(t, rigOpt{snapshot: snap, seed: []Record{chat}, runSeed: []RunRecord{a, b}, hold: true, wire: func(rg *rig) {
		followed := func() string {
			return fmt.Sprint(rg.b.Followed(editorbridge.Run(runA)), rg.b.Followed(editorbridge.Chat(agent1)), rg.b.Followed(editorbridge.Run(runB)))
		}
		rg.r.settle = func(entry string, s *snapshot) { note("settle chats") }
		rg.r.settleRuns = func(entry string, s *snapshot) {
			v, has := s.run(runA)
			_, hasB := s.run(runB)
			views := rg.r.RunViews()
			note(fmt.Sprintf("settle runs %v: the record is %s, archived %v, gone %v; the other is gone %v; the snapshot has %v %s, %v; followed %s",
				entry == rg.entry, views[0].Status, views[0].Archived, views[0].Gone, views[1].Gone, has, v.Status, hasB, followed()))
		}
		rg.local.onUp = func(entry string) { note("up chats: followed " + followed()) }
		rg.runs.onUp = func(entry string) { note(fmt.Sprintf("up runs %v", entry == rg.entry)) }
		rg.r.pending = func(ctx context.Context, entry string) { pendingChats.Add(1) }
		rg.r.pendingRuns = func(ctx context.Context, entry string) {
			if entry == rg.entry && ctx.Err() == nil {
				pendingRuns.Add(1)
			}
		}
	}})
	p, first := rg.page("page-1")
	if got := field(first, "runs").([]any); len(got) != 2 || field(got[0], "status") != "running" || field(got[0], "archived") != true {
		t.Fatalf("the page's snapshot before the connect: %v", got)
	}
	for _, it := range []editorbridge.Item{editorbridge.Run(runA), editorbridge.Chat(agent1), editorbridge.Run(runB)} {
		rg.b.FollowAs(editorbridge.KindPage, p.ID, it)
	}
	rg.start()
	rg.until("step 8 ran for the chats and for the runs", func() bool { return pendingChats.Load() == 1 && pendingRuns.Load() == 1 })

	// 1 and 5, then 6: the lists, server_back, the chats' events, then the runs', record by record.
	p.Expect("server_lists")
	if ev := p.Expect("server_back"); ev["server"] != rg.entry {
		t.Errorf("server_back: %v", ev)
	}
	p.Expect("branch_state")
	if ev := p.Expect("chat"); field(ev, "chat", "id") != chatA {
		t.Errorf("the chat: %v", ev)
	}
	ev := p.Expect("run")
	if c := ev["run"].(map[string]any); c["id"] != runA || c["status"] != "stalled" || c["group"] != "g_here" || c["gone"] != nil ||
		c["archived"] != true || c["archiveOp"] != "a_here" {
		t.Errorf("the run that is there: %v", ev)
	}
	if ev = p.Expect("run"); field(ev, "run", "id") != runB || field(ev, "run", "gone") != true || field(ev, "run", "status") != "running" {
		t.Errorf("the run that is not there: %v", ev)
	}
	p.ExpectNone(quiet)

	// 2 before 3, the chats' settling before the runs'; 4 before 7; the chat manager before the
	// run service.
	want := []string{
		"settle chats",
		"settle runs true: the record is stalled, archived true, gone false; the other is gone true; the snapshot has true stalled, false; followed true true true",
		"up chats: followed false false false",
		"up runs true",
	}
	if got := noted(); !reflect.DeepEqual(got, want) {
		t.Errorf("the steps:\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	// 4: the follows are gone, and the remote server was told nothing about them.
	if got := rg.requests("POST", "/unfollow"); len(got) != 0 {
		t.Errorf("unfollow calls at a return: %+v", got)
	}
	// The gone mark is written at once, and the pending change stays.
	if !rg.runFile(runB).Gone || rg.runFile(runA).Pending != pendingArchive || rg.runFile(runA).Gone {
		t.Errorf("the files after the snapshot: %+v, %+v", rg.runFile(runA), rg.runFile(runB))
	}

	// A later snapshot: the run that was gone is back, the other one is gone and keeps its view.
	back := remoteRun(runB, model.RunCompleted)
	rg.s.SetSnapshot(snapshotWithRuns(back))
	rg.s.DropStreams()
	rg.returned(2)
	var evs []map[string]any
	for range 6 {
		evs = append(evs, p.Next())
	}
	if got, want := types(evs), []string{"server_lists", "server_back", "branch_state", "chat", "run", "run"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the events of a return: %v", got)
	}
	if field(evs[4], "run", "id") != runA || field(evs[4], "run", "gone") != true || field(evs[4], "run", "status") != "stalled" || field(evs[4], "run", "archived") != true ||
		field(evs[5], "run", "id") != runB || field(evs[5], "run", "gone") != nil || field(evs[5], "run", "status") != "completed" {
		t.Errorf("after a snapshot with the second run alone: %v", evs[4:])
	}
	if !rg.runFile(runA).Gone || rg.runFile(runB).Gone {
		t.Error("the gone marks are not written at once")
	}

	// A snapshot whose runs cannot be read marks nothing and settles nothing; the rest goes on.
	rg.until("the steps of the second snapshot are noted", func() bool { return len(noted()) == 8 })
	settles := len(noted())
	rg.r.snapshot(rg.entry, json.RawMessage(`{"agents":[],"chats":[],"runs":"none"}`))
	evs = nil
	for range 6 {
		evs = append(evs, p.Next())
	}
	if got, want := types(evs), []string{"server_lists", "server_back", "branch_state", "chat", "run", "run"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the events of a snapshot that cannot be read: %v", got)
	}
	if field(evs[4], "run", "gone") != true || field(evs[5], "run", "gone") != nil {
		t.Errorf("the records were marked from a snapshot that cannot be read: %v", evs[4:])
	}
	rg.until("the steps of the third snapshot are noted", func() bool { return len(noted()) >= settles+2 })
	if got := noted()[settles:]; len(got) != 2 || !strings.HasPrefix(got[0], "up chats") || got[1] != "up runs true" {
		t.Errorf("the steps of a snapshot that cannot be read: %v", got)
	}
}

// TestRunCountsAndRemoved: the counts of an entry with runs, and its removal: the run records
// go with their files after the chat records, the pages are told, the draft runs go back to
// this computer, and the server is sent nothing.
func TestRunCountsAndRemoved(t *testing.T) {
	t.Parallel()
	chat := seedOf(chatA)
	a, b := runSeedOf(runA), runSeedOf(runB)
	a.Agents = []string{agent1}
	snap := snapshotWith(chat.View)
	snap["runs"] = []model.RunView{a.View, b.View}
	rg := newRig(t, rigOpt{snapshot: snap, seed: []Record{chat}, runSeed: []RunRecord{a, b}})
	rg.serveRuns(agent1)
	rg.runs.draft("r_draft001", rg.entry, "")
	rg.runs.draft("r_draft002", rg.entry, model.RemoteUnconfirmed)
	rg.runs.draft("r_draft003", "s_other", "")
	p, _ := rg.page("page-1")
	rg.readRun(p, runA)
	rg.readAgent(p, agent1)

	if chats, runs := rg.r.Counts(rg.entry); chats != 1 || runs != 2 {
		t.Errorf("Counts: %d, %d", chats, runs)
	}
	if chats, runs := rg.r.Counts("s_other"); chats != 0 || runs != 0 {
		t.Errorf("Counts of another entry: %d, %d", chats, runs)
	}
	if !rg.r.HasRun(runA) || !rg.r.HasRun(runB) || rg.r.HasRun("r_draft001") || rg.r.HasRun(chatA) || rg.r.Has(runA) {
		t.Error("HasRun and Has before the removal")
	}
	if got := rg.r.RunViews(); len(got) != 2 || got[0].ID != runA || got[1].ID != runB {
		t.Errorf("RunViews: %+v", got)
	}

	sent := len(rg.s.Requests())
	if err := rg.m.Remove(rg.entry); err != nil {
		t.Fatal(err)
	}
	if ev := p.Expect("chat_removed"); ev["id"] != chatA {
		t.Errorf("chat_removed: %v", ev)
	}
	for _, id := range []string{runA, runB} {
		if ev := p.Expect("run_removed"); ev["id"] != id {
			t.Errorf("run_removed: %v, want %s", ev, id)
		}
	}
	p.Expect("server_lists")
	rg.until("the draft runs are put back", func() bool { return len(rg.runs.told(&rg.runs.resets)) == 2 })
	p.ExpectNone(quiet)
	if got := rg.runs.told(&rg.runs.resets); !reflect.DeepEqual(got, []string{"r_draft001", "r_draft002"}) {
		t.Errorf("ResetServer for %v", got)
	}
	if meta, ok := rg.runs.RemoteDraft("r_draft003"); !ok || meta.Server != "s_other" {
		t.Error("the draft of another entry was put back")
	}
	if _, runs := rg.r.Counts(rg.entry); runs != 0 || rg.r.HasRun(runA) || rg.r.HasRun(runB) || len(rg.r.RunViews()) != 0 {
		t.Error("run records are left after the removal")
	}
	if _, ok := rg.r.AgentChat(agent1); ok {
		t.Error("the lookup has an agent of a removed record")
	}
	// The unstarted chats people made on the runs go with them.
	rg.local.mu.Lock()
	onRuns := append([]string(nil), rg.local.onRuns...)
	rg.local.mu.Unlock()
	if !reflect.DeepEqual(onRuns, []string{runA, runB}) {
		t.Errorf("DeleteOnRun for %v", onRuns)
	}
	if left, err := os.ReadDir(rg.r.runFiles.dir); err != nil || len(left) != 0 {
		t.Errorf("files left after the removal: %v, %v", left, err)
	}
	if rg.b.Followed(editorbridge.Run(runA)) || rg.b.Followed(editorbridge.Chat(agent1)) {
		t.Error("a follow of a removed run or of its agent's chat is left")
	}
	time.Sleep(quiet)
	if got := rg.s.Requests()[sent:]; len(got) != 0 {
		t.Errorf("the removed server was sent %+v", got)
	}
	// No record is made for an entry that left.
	gone := runSeedOf(runA)
	gone.Entry = rg.entry
	if _, err := rg.r.adoptRun(gone); err == nil || rg.r.HasRun(runA) {
		t.Errorf("a run record was adopted for a removed entry: %v", err)
	}
}

// TestTakeRun: an answer and an event of one run can cross: a view is taken only if no view of
// the run was taken since its read was sent. The pages are told when what they get changed.
func TestTakeRun(t *testing.T) {
	t.Parallel()
	seed := runSeedOf(runA)
	seed.Agents = []string{agent1}
	rg := newRig(t, rigOpt{snapshot: snapshotWithRuns(seed.View), runSeed: []RunRecord{seed}})
	p, _ := rg.page("page-1")
	rec := rg.r.runRec(runA)
	status := func() model.RunStatus { return rg.r.RunViews()[0].Status }

	// A read is sent, an event comes, the read's answer comes: the answer is older.
	since := rec.stamp()
	rg.s.Send(map[string]any{"type": "run", "run": remoteRun(runA, model.RunStopping)})
	p.Expect("run")
	if rg.r.takeRun(rec, since, remoteRun(runA, model.RunRunning)) || status() != model.RunStopping {
		t.Errorf("an answer that an event overtook was taken: %s", status())
	}
	// An answer with the view the record has: taken, and the pages are told nothing.
	if !rg.r.takeRun(rec, rec.stamp(), remoteRun(runA, model.RunStopping)) {
		t.Error("an answer was not taken")
	}
	p.ExpectNone(quiet)
	// An answer with a new view, and with a mark.
	stopped := remoteRun(runA, model.RunStopped)
	stopped.Archived = true
	if !rg.r.takeRun(rec, rec.stamp(), stopped) {
		t.Error("an answer was not taken")
	}
	if ev := p.Expect("run"); field(ev, "run", "status") != "stopped" || field(ev, "run", "archived") != true || field(ev, "run", "group") != "g_here" {
		t.Errorf("the event of a taken answer: %v", ev)
	}
	// A snapshot counts as a view too.
	since = rec.stamp()
	rg.r.snapshotRuns(rg.entry, &snapshot{Runs: []model.RunView{remoteRun(runA, model.RunCompleted)}})
	if rg.r.takeRun(rec, since, stopped) || status() != model.RunCompleted {
		t.Errorf("an answer that a snapshot overtook was taken: %s", status())
	}

	// Gone: told once, and an answer that was sent before is not taken over it.
	since = rec.stamp()
	rg.b.FollowAs(editorbridge.KindPage, p.ID, editorbridge.Run(runA))
	rg.b.FollowAs(editorbridge.KindPage, p.ID, editorbridge.Chat(agent1))
	rg.r.markRunGone(rec)
	rg.r.markRunGone(rec)
	if ev := p.Expect("run"); field(ev, "run", "gone") != true {
		t.Errorf("the event of a run that is gone: %v", ev)
	}
	p.ExpectNone(quiet)
	if rg.r.takeRun(rec, since, stopped) || !rg.runFile(runA).Gone {
		t.Error("an answer was taken over the gone mark, or the mark is not in the file")
	}
	if rg.b.Followed(editorbridge.Run(runA)) || rg.b.Followed(editorbridge.Chat(agent1)) {
		t.Error("a gone run or its agent's chat is followed")
	}

	// Removed: the pages are told once; nothing is taken and nothing is told after it.
	rg.r.removeRun(rec)
	rg.r.removeRun(rec)
	if ev := p.Expect("run_removed"); ev["id"] != runA {
		t.Errorf("run_removed: %v", ev)
	}
	if rg.r.takeRun(rec, rec.stamp(), stopped) || rg.r.HasRun(runA) {
		t.Error("a removed record took a view")
	}
	rg.r.markRunGone(rec)
	raw, _ := json.Marshal(map[string]any{"type": "run", "run": remoteRun(runA, model.RunRunning)})
	rg.r.runEvent(rg.entry, raw)
	p.ExpectNone(quiet)
	if _, err := os.Stat(rg.r.runFiles.path(runA)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the file of a removed record: %v", err)
	}
	if _, ok := rg.r.AgentChat(agent1); ok {
		t.Error("the agent of a removed record is in the lookup")
	}
}

// TestNoRunService: a relay of a server without runs keeps no run record, and every run branch
// does nothing.
func TestNoRunService(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{noRuns: true, snapshot: snapshotWithRuns(remoteRun(runA, model.RunRunning))})
	p, _ := rg.page("page-1")
	rg.b.FollowAs(editorbridge.KindPage, p.ID, editorbridge.Run(runA))
	rg.s.Send(map[string]any{"type": "run", "run": remoteRun(runA, model.RunStopped)})
	rg.s.Send(map[string]any{"type": "run_detail", "run": runA, "version": 2, "patch": map[string]any{"agents": map[string]any{agent1: map[string]any{}}}})
	rg.s.Send(map[string]any{"type": "run_activity", "run": runA, "agents": map[string]any{agent1: map[string]any{}}})
	rg.s.Send(map[string]any{"type": "run_removed", "id": runA})
	if got := rg.barrier(p)[0]; len(got) != 0 {
		t.Errorf("the page got %v", got)
	}
	if n := rg.r.droppedRuns.Load(); n != 4 {
		t.Errorf("%d events counted as dropped, want 4", n)
	}
	if _, ok := rg.r.AgentChat(agent1); ok || rg.r.HasRun(runA) || len(rg.r.RunViews()) != 0 {
		t.Error("a relay without a run service learned of a run")
	}
	rg.r.Unfollowed([]editorbridge.Item{editorbridge.Run(runA), editorbridge.Chat(agent1)})
	if err := rg.m.Remove(rg.entry); err != nil {
		t.Fatal(err)
	}
	p.Expect("server_lists")
	p.ExpectNone(quiet)
	if got := rg.requests("POST", "/unfollow"); len(got) != 0 {
		t.Errorf("unfollow calls: %+v", got)
	}
}
