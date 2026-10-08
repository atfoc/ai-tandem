package remotes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/runs"
)

// seededRuns is a rig with records of the runs, each in the stand-in's snapshot.
func seededRuns(t *testing.T, o rigOpt, ids ...string) *rig {
	t.Helper()
	var views []model.RunView
	for _, id := range ids {
		d := runSeedOf(id)
		o.runSeed = append(o.runSeed, d)
		views = append(views, d.View)
	}
	o.snapshot = snapshotWithRuns(views...)
	return newRig(t, o)
}

// raw makes the route answer every request with the status and these bytes.
func (s *script) raw(status int, b string) {
	s.set(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(b))
	})
}

// TestRunRoutes: every route method of a run record: what the server gets, what the record
// takes, and what the page is answered.
func TestRunRoutes(t *testing.T) {
	t.Parallel()
	rg := seededRuns(t, rigOpt{}, runA)
	ctx := context.Background()
	p, _ := rg.page("page-1")
	get := rg.script("GET /api/runs/{id}")
	patch := rg.script("PATCH /api/runs/{id}")
	detail := rg.script("GET /api/runs/{id}/detail")
	stop := rg.script("POST /api/runs/{id}/stop")
	resume := rg.script("POST /api/runs/{id}/resume")
	apply := rg.script("POST /api/runs/{id}/apply")
	rg.s.Handle("POST /api/runs/{id}/unfollow", func(w http.ResponseWriter, r *http.Request) { writeJSONTest(w, map[string]any{"ok": true}) })

	// The view: read there, taken by the record, answered as the record's.
	there := remoteRun(runA, model.RunStopped)
	there.Op, there.Turns = "a_there", 4
	get.answer(http.StatusOK, there)
	rep := rg.r.RunGet(ctx, runA)
	if b := body(t, rep); rep.Status != http.StatusOK || b["id"] != runA || b["group"] != "g_here" || b["server"] != rg.entry ||
		b["status"] != "stopped" || b["turns"] != 4.0 || b["archiveOp"] != nil {
		t.Errorf("RunGet: %d %s", rep.Status, rep.Body)
	}
	if q := get.last(t); q.Method != http.MethodGet || q.URI != "/api/runs/"+runA {
		t.Errorf("the server got %+v", q)
	}
	if ev := p.Expect("run"); field(ev, "run", "status") != "stopped" || field(ev, "run", "group") != "g_here" {
		t.Errorf("the pages were told %v", ev)
	}
	// A view of another run is not taken.
	get.answer(http.StatusOK, remoteRun(runB, model.RunRunning))
	refused(t, "a view of another run", rg.r.RunGet(ctx, runA), http.StatusBadGateway, "bad_answer", "Studio gave an answer that cannot be read.")
	if v := rg.r.runRec(runA).view(); v.Status != model.RunStopped {
		t.Errorf("the record took another run's view: %+v", v)
	}
	// An error of the read is the server's.
	get.answer(http.StatusInternalServerError, map[string]string{"error": "boom"})
	refused(t, "a read the server fails", rg.r.RunGet(ctx, runA), http.StatusInternalServerError, "", "boom")
	// An answer above the size limit was sent and answered: it is no "did not answer".
	get.set(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(append([]byte(`{"name":"`), bytes.Repeat([]byte("x"), 32<<20)...))
	})
	refused(t, "an answer that is too long", rg.r.RunGet(ctx, runA), http.StatusBadGateway, "bad_answer", "Studio gave an answer that cannot be read.")

	// The detail: the page follows, the agents are learned, the bytes are those that came.
	const bytesThere = `{"run":"` + runA + `","version":7,  "agents":{"` + agent1 + `":{"role":"task"}},"extra":[1,2]}`
	detail.raw(http.StatusOK, bytesThere)
	if rep := rg.r.RunDetail(ctx, runA, p.ID); rep.Status != http.StatusOK || string(rep.Body) != bytesThere {
		t.Errorf("RunDetail: %d %s", rep.Status, rep.Body)
	}
	if run, ok := rg.r.AgentChat(agent1); !ok || run != runA || !rg.b.Followed(editorbridge.Run(runA)) {
		t.Errorf("after the detail read: the agent's run %q, followed %v", run, rg.b.Followed(editorbridge.Run(runA)))
	}
	if rep := rg.r.RunUnfollow(runA, p.ID); rep.Status != http.StatusOK || rg.b.Followed(editorbridge.Run(runA)) {
		t.Errorf("RunUnfollow: %d, followed %v", rep.Status, rg.b.Followed(editorbridge.Run(runA)))
	}
	rg.until("the follow there ends", func() bool { return len(rg.requests("POST", "/api/runs/"+runA+"/unfollow")) == 1 })

	// The texts: passed on with the query, as they came.
	for rest, uri := range map[string]string{
		"/goal":                         "/api/runs/" + runA + "/goal",
		"/delivery":                     "/api/runs/" + runA + "/delivery",
		"/tasks/T1/brief":               "/api/runs/" + runA + "/tasks/T1/brief?rev=2",
		"/tasks/T1/attempts/2/report":   "/api/runs/" + runA + "/tasks/T1/attempts/2/report?rev=2",
		"/tasks/T 1/attempts/2/changes": "/api/runs/" + runA + "/tasks/T%201/attempts/2/changes?rev=2",
		"/notes/3":                      "/api/runs/" + runA + "/notes/3?rev=2",
	} {
		text := rg.script("GET /api/runs/{id}" + strings.NewReplacer("T 1", "{tid}", "T1", "{tid}", "/2/", "/{n}/", "/3", "/{v}").Replace(rest))
		text.raw(http.StatusOK, `{"text":"as it came",  "n":1}`)
		query := "rev=2"
		if !strings.Contains(uri, "?") {
			query = ""
		}
		if rep := rg.r.RunRead(ctx, runA, rest, query); rep.Status != http.StatusOK || string(rep.Body) != `{"text":"as it came",  "n":1}` {
			t.Errorf("RunRead %s: %d %s", rest, rep.Status, rep.Body)
		}
		if q := text.last(t); q.Method != http.MethodGet || q.URI != uri {
			t.Errorf("RunRead %s: the server got %+v", rest, q)
		}
	}
	sent := len(rg.s.Requests())
	for _, rest := range []string{"", "/", "/detail", "/start", "/tasks/T1", "/tasks//brief", "/goal/more", "goal", "/../chats"} {
		if rep := rg.r.RunRead(ctx, runA, rest, ""); rep.Status != http.StatusNotFound || body(t, rep)["error"] != "not found" {
			t.Errorf("RunRead %q: %d %s", rest, rep.Status, rep.Body)
		}
	}
	if got := len(rg.s.Requests()); got != sent {
		t.Errorf("%d requests for paths that are no read of a run", got-sent)
	}

	// Stop and resume: the body is passed on, the record takes the answer's view.
	p.Drain(quiet)
	stopped := remoteRun(runA, model.RunStopped)
	stopped.Reason = "stopped by the user"
	stop.answer(http.StatusOK, stopped)
	rep = rg.r.RunDo(ctx, runA, "stop", nil)
	if b := body(t, rep); rep.Status != http.StatusOK || b["status"] != "stopped" || b["reason"] != "stopped by the user" || b["group"] != "g_here" {
		t.Errorf("stop: %d %s", rep.Status, rep.Body)
	}
	if q := stop.last(t); q.Method != http.MethodPost || q.URI != "/api/runs/"+runA+"/stop" || q.Body != "" {
		t.Errorf("stop: the server got %+v", q)
	}
	if ev := p.Expect("run"); field(ev, "run", "reason") != "stopped by the user" {
		t.Errorf("the pages were told %v", ev)
	}
	resume.answer(http.StatusOK, remoteRun(runA, model.RunRunning))
	rep = rg.r.RunDo(ctx, runA, "resume", []byte(`{"maxTurns":90}`))
	if rep.Status != http.StatusOK || body(t, rep)["status"] != "running" || resume.last(t).Body != `{"maxTurns":90}` {
		t.Errorf("resume: %d %s, the server got %+v", rep.Status, rep.Body, resume.last(t))
	}
	p.Expect("run")
	resume.answer(http.StatusConflict, map[string]string{"error": "the run is not halted"})
	refused(t, "a resume the server refuses", rg.r.RunDo(ctx, runA, "resume", nil), http.StatusConflict, "", "the run is not halted")
	resume.answer(http.StatusOK, remoteRun(runB, model.RunRunning))
	refused(t, "a resume answered with another run", rg.r.RunDo(ctx, runA, "resume", nil), http.StatusBadGateway, "bad_answer", "Studio gave an answer that cannot be read.")
	// Apply: answered as it came.
	apply.raw(http.StatusOK, `{"state":"blocked",  "why":"the folder changed"}`)
	if rep := rg.r.RunDo(ctx, runA, "apply", []byte(`{"branch":"main"}`)); rep.Status != http.StatusOK ||
		string(rep.Body) != `{"state":"blocked",  "why":"the folder changed"}` || apply.last(t).Body != `{"branch":"main"}` {
		t.Errorf("apply: %d %s, the server got %+v", rep.Status, rep.Body, apply.last(t))
	}
	if rep := rg.r.RunDo(ctx, runA, "start", nil); rep.Status != http.StatusNotFound {
		t.Errorf("a verb that is none: %d %s", rep.Status, rep.Body)
	}
	p.ExpectNone(quiet)

	// The patch: the name is passed on alone, the group is the place here, the rest is fixed.
	renamed := remoteRun(runA, model.RunRunning)
	renamed.Name, renamed.UserNamed = "Renamed", true
	patch.answer(http.StatusOK, renamed)
	name, group := "Renamed", "g_next"
	rep = rg.r.RunPatch(ctx, runA, RunPatchReq{Name: &name, Group: &group})
	if b := body(t, rep); rep.Status != http.StatusOK || b["name"] != "Renamed" || b["group"] != "g_next" || b["server"] != rg.entry {
		t.Errorf("RunPatch: %d %s", rep.Status, rep.Body)
	}
	if q := patch.last(t); q.Method != http.MethodPatch || q.URI != "/api/runs/"+runA || q.Body != `{"name":"Renamed"}` {
		t.Errorf("RunPatch: the server got %+v", q)
	}
	if d := rg.runFile(runA); d.Group != "g_next" || d.View.Group != "g_there" {
		t.Errorf("the record after the move: %+v", d)
	}
	p.Expect("run")
	p.Expect("run")
	sent = patch.count()
	for what, req := range map[string]RunPatchReq{
		"server":   {Server: json.RawMessage(`"local"`)},
		"agent":    {Agent: json.RawMessage(`"pi"`), Name: &name},
		"tiers":    {Tiers: json.RawMessage(`{"deep":{"model":"m"}}`)},
		"cwd":      {Cwd: json.RawMessage(`"/tmp"`), Group: &group},
		"settings": {Settings: json.RawMessage(`{"maxTurns":3}`)},
	} {
		refused(t, "a patch of "+what, rg.r.RunPatch(ctx, runA, req), http.StatusConflict, "", runs.ErrStarted.Error())
	}
	blank := ""
	if rep := rg.r.RunPatch(ctx, runA, RunPatchReq{Group: &blank, Name: &name}); rep.Status != http.StatusBadRequest {
		t.Errorf("a patch with an empty group: %d %s", rep.Status, rep.Body)
	}
	if patch.count() != sent {
		t.Errorf("%d calls for patches that are refused here", patch.count()-sent)
	}
	// A null is no value, and a patch of nothing answers the view.
	if rep := rg.r.RunPatch(ctx, runA, RunPatchReq{Cwd: json.RawMessage(`null`)}); rep.Status != http.StatusOK || body(t, rep)["id"] != runA || patch.count() != sent {
		t.Errorf("a patch of nothing: %d %s", rep.Status, rep.Body)
	}
	// The server refuses the name: the place is not changed.
	patch.answer(http.StatusBadRequest, map[string]string{"error": "the name is too long"})
	back := "g_here"
	refused(t, "a name the server refuses", rg.r.RunPatch(ctx, runA, RunPatchReq{Name: &name, Group: &back}), http.StatusBadRequest, "", "the name is too long")
	if d := rg.runFile(runA); d.Group != "g_next" {
		t.Errorf("the place changed with a refused name: %+v", d)
	}

	// No record: 404 "no such run", and nothing is sent.
	sent = len(rg.s.Requests())
	for what, rep := range map[string]Reply{
		"RunGet": rg.r.RunGet(ctx, runB), "RunDetail": rg.r.RunDetail(ctx, runB, p.ID), "RunRead": rg.r.RunRead(ctx, runB, "/goal", ""),
		"RunDo": rg.r.RunDo(ctx, runB, "stop", nil), "RunPatch": rg.r.RunPatch(ctx, runB, RunPatchReq{Name: &name}),
	} {
		refused(t, what+" without a record", rep, http.StatusNotFound, "", "no such run")
	}
	if got := len(rg.s.Requests()); got != sent {
		t.Errorf("%d requests for a run without a record", got-sent)
	}
	noSecret(t, "the log", strings.Join(rg.logs.all(), "\n"))
}

// TestRunCannotBeMade: the answers of a run's call that cannot be made.
func TestRunCannotBeMade(t *testing.T) {
	t.Parallel()
	rg := seededRuns(t, rigOpt{limits: Limits{Call: 150 * time.Millisecond, Start: 150 * time.Millisecond}}, runA, runB)
	ctx := context.Background()
	p, _ := rg.page("page-1")
	stop := rg.script("POST /api/runs/{id}/stop")
	detail := rg.script("GET /api/runs/{id}/detail")
	brief := rg.script("GET /api/runs/{id}/tasks/{tid}/brief")
	goal := rg.script("GET /api/runs/{id}/goal")

	// Sent, no answer.
	_, free := stop.hang()
	defer free()
	refused(t, "no answer", rg.r.RunDo(ctx, runA, "stop", nil), http.StatusGatewayTimeout, "no_answer", "Studio did not answer.")

	// "no such task" and "nothing recorded yet" are the server's answers, and mark nothing.
	brief.answer(http.StatusNotFound, map[string]string{"error": "no such task"})
	if rep := rg.r.RunRead(ctx, runA, "/tasks/T9/brief", ""); rep.Status != http.StatusNotFound || body(t, rep)["error"] != "no such task" || rg.runFile(runA).Gone {
		t.Errorf("no such task: %d %s", rep.Status, rep.Body)
	}
	goal.answer(http.StatusConflict, map[string]string{"error": "nothing recorded yet", "code": "early"})
	refused(t, "a 409 of the server", rg.r.RunRead(ctx, runA, "/goal", ""), http.StatusConflict, "early", "nothing recorded yet")
	// An answer that is no JSON is not handed on.
	goal.raw(http.StatusOK, "<html>")
	refused(t, "an answer that is no JSON", rg.r.RunRead(ctx, runA, "/goal", ""), http.StatusBadGateway, "bad_answer", "Studio gave an answer that cannot be read.")
	p.ExpectNone(quiet)

	// "no such run": the record is marked gone, and the page that read follows nothing.
	detail.answer(http.StatusNotFound, map[string]string{"error": "no such run"})
	refused(t, "a run that is gone there", rg.r.RunDetail(ctx, runA, p.ID), http.StatusNotFound, "gone_there", "This run is no longer on Studio.")
	if ev := p.Expect("run"); field(ev, "run", "id") != runA || field(ev, "run", "gone") != true {
		t.Errorf("the pages were told %v", ev)
	}
	if !rg.runFile(runA).Gone || rg.b.Followed(editorbridge.Run(runA)) {
		t.Errorf("gone %v, followed %v", rg.runFile(runA).Gone, rg.b.Followed(editorbridge.Run(runA)))
	}

	// 401: the entry's matter.
	detail.answer(http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
	refused(t, "401", rg.r.RunDetail(ctx, runB, p.ID), http.StatusServiceUnavailable, "server_unreachable", "Studio is not connected.")
	if rg.runFile(runB).Gone {
		t.Error("a 401 marked the record gone")
	}

	// Not connected: nothing is sent, and the answer is there at once.
	rg.until("the entry is not connected", func() bool { return !rg.r.connected(rg.entry) })
	sent := len(rg.s.Requests())
	name := "n"
	start := time.Now()
	for what, rep := range map[string]Reply{
		"the view":   rg.r.RunGet(ctx, runB),
		"the detail": rg.r.RunDetail(ctx, runB, p.ID),
		"a text":     rg.r.RunRead(ctx, runB, "/goal", ""),
		"a stop":     rg.r.RunDo(ctx, runB, "stop", nil),
		"an apply":   rg.r.RunDo(ctx, runB, "apply", nil),
		"a rename":   rg.r.RunPatch(ctx, runB, RunPatchReq{Name: &name}),
	} {
		refused(t, what+" while not connected", rep, http.StatusServiceUnavailable, "server_unreachable", "Studio is not connected.")
	}
	if took := time.Since(start); took > time.Second {
		t.Errorf("the calls while not connected took %v", took)
	}
	if got := len(rg.s.Requests()); got != sent {
		t.Errorf("%d requests were sent while not connected", got-sent)
	}
	noSecret(t, "the log", strings.Join(rg.logs.all(), "\n"))
}

// TestAgentRoutes: the routes of the chat of a run's agent.
func TestAgentRoutes(t *testing.T) {
	t.Parallel()
	// The relay's agentEvery and agentWait, lowered in the same proportion. The upper bounds
	// below stay those of the waits outside the tests.
	const every, patience = agentEvery / 5, agentWait / 5
	live, halted := runSeedOf(runA), runSeedOf(runB)
	live.Agents = []string{agent1}
	halted.View.Status, halted.Agents = model.RunStopped, []string{agent2}
	chat := seedOf(chatA)
	rg := newRig(t, rigOpt{snapshot: func() map[string]any {
		snap := snapshotWith(chat.View)
		snap["runs"] = []model.RunView{live.View, halted.View}
		return snap
	}(), runSeed: []RunRecord{live, halted}, seed: []Record{chat}, agent: [2]time.Duration{every, patience}})
	ctx := context.Background()
	p, _ := rg.page("page-1")
	view := rg.script("GET /api/chats/{id}")
	items := rg.script("GET /api/chats/{id}/items")
	tree := rg.script("GET /api/chats/{id}/tree")
	sub := rg.script("GET /api/chats/{id}/subagents/{sid}/items")
	usage := rg.script("GET /api/chats/{id}/context")
	rg.s.Handle("POST /api/chats/{id}/unfollow", func(w http.ResponseWriter, r *http.Request) { writeJSONTest(w, map[string]any{"ok": true}) })
	const came = `{"as":"it came",  "n":[1,2]}`
	for _, s := range []*script{view, items, tree, sub, usage} {
		s.raw(http.StatusOK, came)
	}
	same := func(what string, rep Reply, s *script, uri string) {
		t.Helper()
		if rep.Status != http.StatusOK || string(rep.Body) != came {
			t.Errorf("%s: %d %s", what, rep.Status, rep.Body)
		}
		if q := s.last(t); q.Method != http.MethodGet || q.URI != uri {
			t.Errorf("%s: the server got %+v", what, q)
		}
	}
	base := "/api/chats/" + agent1
	same("AgentView", rg.r.AgentView(ctx, agent1), view, base)
	if rg.b.Followed(editorbridge.Chat(agent1)) {
		t.Error("the view made a follower")
	}
	same("the items", rg.r.AgentRead(ctx, agent1, p.ID, "/items", "branch=main"), items, base+"/items?branch=main")
	if !rg.b.Followed(editorbridge.Chat(agent1)) {
		t.Error("the items read made no follower")
	}
	same("the tree", rg.r.AgentRead(ctx, agent1, p.ID, "/tree", ""), tree, base+"/tree")
	same("a subagent's items", rg.r.AgentRead(ctx, agent1, p.ID, "/subagents/s 1/items", "branch=b1"), sub, base+"/subagents/s%201/items?branch=b1")
	same("the context", rg.r.AgentContext(ctx, agent1, "branch=main&fresh=1"), usage, base+"/context?branch=main&fresh=1")
	if rep := rg.r.AgentUnfollow(agent1, p.ID); rep.Status != http.StatusOK || rg.b.Followed(editorbridge.Chat(agent1)) {
		t.Errorf("AgentUnfollow: %d, followed %v", rep.Status, rg.b.Followed(editorbridge.Chat(agent1)))
	}
	rg.until("the follow there ends", func() bool { return len(rg.requests("POST", base+"/unfollow")) == 1 })

	// A path that is no read of an agent's chat, a chat that is no agent's, and a chat with a
	// record of its own: nothing is sent.
	sent := len(rg.s.Requests())
	for _, rest := range []string{"", "/messages", "/items/x", "/subagents//items", "/context"} {
		if rep := rg.r.AgentRead(ctx, agent1, p.ID, rest, ""); rep.Status != http.StatusNotFound || body(t, rep)["error"] != "not found" {
			t.Errorf("AgentRead %q: %d %s", rest, rep.Status, rep.Body)
		}
	}
	for _, id := range []string{chatA, chatB} {
		for what, rep := range map[string]Reply{
			"AgentView": rg.r.AgentView(ctx, id), "AgentRead": rg.r.AgentRead(ctx, id, p.ID, "/items", ""),
			"AgentRead of no path": rg.r.AgentRead(ctx, id, p.ID, "/x", ""), "AgentContext": rg.r.AgentContext(ctx, id, ""),
		} {
			refused(t, what+" of "+id, rep, http.StatusNotFound, "", "no such chat")
		}
	}
	if got := len(rg.s.Requests()); got != sent {
		t.Errorf("%d requests that were not to be sent", got-sent)
	}

	// The chat of an agent that was just listed is not there yet: the read is made again while
	// the run is live.
	var calls atomic.Int32
	late := func(after int32) func(w http.ResponseWriter, r *http.Request) {
		calls.Store(0)
		return func(w http.ResponseWriter, r *http.Request) {
			if calls.Add(1) <= after {
				writeAnswer(w, http.StatusNotFound, map[string]string{"error": "no such chat"})
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(came))
		}
	}
	items.set(late(2))
	start := time.Now()
	if rep := rg.r.AgentRead(ctx, agent1, p.ID, "/items", ""); rep.Status != http.StatusOK || string(rep.Body) != came || calls.Load() != 3 {
		t.Errorf("a chat that is there at the third read: %d %s after %d reads", rep.Status, rep.Body, calls.Load())
	}
	if took := time.Since(start); took < 2*every || took > agentWait {
		t.Errorf("two waits took %v", took)
	}
	view.set(late(1))
	if rep := rg.r.AgentView(ctx, agent1); rep.Status != http.StatusOK || calls.Load() != 2 {
		t.Errorf("a view that is there at the second read: %d %s after %d reads", rep.Status, rep.Body, calls.Load())
	}
	// It never comes: the 404 is handed on after agentWait (here patience), nothing is marked gone, and the
	// page follows nothing.
	items.set(late(1 << 30))
	start = time.Now()
	rep := rg.r.AgentRead(ctx, agent1, p.ID, "/items", "")
	refused(t, "a chat that never comes", rep, http.StatusNotFound, "", "no such chat")
	if took, n := time.Since(start), calls.Load(); took < patience-2*every || took > 2*agentWait || n < 5 || n > 9 {
		t.Errorf("the retries took %v and %d reads", took, n)
	}
	if rg.runFile(runA).Gone || rg.b.Followed(editorbridge.Chat(agent1)) {
		t.Errorf("after the 404: gone %v, followed %v", rg.runFile(runA).Gone, rg.b.Followed(editorbridge.Chat(agent1)))
	}
	if _, ok := rg.r.AgentChat(agent1); !ok {
		t.Error("the agent was forgotten")
	}
	// The other reads, and the reads of a run that is not live, are made once.
	tree.set(late(1 << 30))
	if rep := rg.r.AgentRead(ctx, agent1, p.ID, "/tree", ""); rep.Status != http.StatusNotFound || calls.Load() != 1 {
		t.Errorf("the tree of a chat that is not there: %d after %d reads", rep.Status, calls.Load())
	}
	items.set(late(1 << 30))
	start = time.Now()
	if rep := rg.r.AgentRead(ctx, agent2, p.ID, "/items", ""); rep.Status != http.StatusNotFound || calls.Load() != 1 || time.Since(start) > agentWait/2 {
		t.Errorf("an agent of a halted run: %d after %d reads and %v", rep.Status, calls.Load(), time.Since(start))
	}
	// 401 is the entry's matter.
	items.answer(http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
	refused(t, "401", rg.r.AgentRead(ctx, agent1, p.ID, "/items", ""), http.StatusServiceUnavailable, "server_unreachable", "Studio is not connected.")
	rg.until("the entry is not connected", func() bool { return !rg.r.connected(rg.entry) })
	sent = len(rg.s.Requests())
	refused(t, "the view while not connected", rg.r.AgentView(ctx, agent1), http.StatusServiceUnavailable, "server_unreachable", "Studio is not connected.")
	refused(t, "a read while not connected", rg.r.AgentRead(ctx, agent1, p.ID, "/items", ""), http.StatusServiceUnavailable, "server_unreachable", "Studio is not connected.")
	if got := len(rg.s.Requests()); got != sent {
		t.Errorf("%d requests were sent while not connected", got-sent)
	}
	if !reflect.DeepEqual(rg.r.runRec(runA).agents(), []string{agent1}) {
		t.Errorf("the agents of the run: %v", rg.r.runRec(runA).agents())
	}
}

// TestNoRunsHere: on a relay without a run service every run method answers "no such run" or
// "none", and nothing is sent.
func TestNoRunsHere(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{noRuns: true, snapshot: snapshotWithRuns(remoteRun(runA, model.RunRunning))})
	ctx := context.Background()
	name := "n"
	sent := len(rg.s.Requests())
	for what, rep := range map[string]Reply{
		"StartRun": rg.r.StartRun(ctx, runA, "Go"), "RunGet": rg.r.RunGet(ctx, runA), "RunDetail": rg.r.RunDetail(ctx, runA, "page-1"),
		"RunRead": rg.r.RunRead(ctx, runA, "/goal", ""), "RunDo": rg.r.RunDo(ctx, runA, "stop", nil),
		"RunPatch":   rg.r.RunPatch(ctx, runA, RunPatchReq{Name: &name}),
		"ArchiveRun": ReplyOf(rg.r.ArchiveRun(ctx, runA, "")), "UnarchiveRun": ReplyOf(rg.r.UnarchiveRun(ctx, runA)),
		"DeleteRun": ReplyOf(rg.r.DeleteRun(ctx, runA, false)), "DeleteRun local": ReplyOf(rg.r.DeleteRun(ctx, runA, true)),
		"MoveRun": ReplyOf(rg.r.MoveRun(runA, "g_next")),
	} {
		refused(t, what, rep, http.StatusNotFound, "", "no such run")
	}
	for what, rep := range map[string]Reply{
		"AgentView": rg.r.AgentView(ctx, agent1), "AgentRead": rg.r.AgentRead(ctx, agent1, "page-1", "/items", ""),
		"AgentContext": rg.r.AgentContext(ctx, agent1, ""),
	} {
		refused(t, what, rep, http.StatusNotFound, "", "no such chat")
	}
	if rep := rg.r.RunUnfollow(runA, "page-1"); rep.Status != http.StatusOK {
		t.Errorf("RunUnfollow: %d", rep.Status)
	}
	if rep := rg.r.AgentUnfollow(agent1, "page-1"); rep.Status != http.StatusOK {
		t.Errorf("AgentUnfollow: %d", rep.Status)
	}
	if got := rg.r.RunsArchivedWith("a_1"); got == nil || len(got) != 0 {
		t.Errorf("RunsArchivedWith: %v", got)
	}
	if _, ok := rg.r.RunInfo(runA); ok {
		t.Error("RunInfo without a run service")
	}
	if err := rg.r.Deletable(map[string]bool{"g_here": true}); err != nil {
		t.Errorf("Deletable: %v", err)
	}
	if got := len(rg.s.Requests()); got != sent {
		t.Errorf("%d requests were sent", got-sent)
	}
}
