package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/app"
	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/store"
)

// ---- a server with runs, on scripted agents ---------------------------------------------------

// runEnv is a server wired as main wires it (the run service, the chat manager as its chat host,
// the MCP relay with the run tools), with scripted agents in place of the CLIs. The data folder
// has a name of its own: a run refuses a folder whose path holds that name.
type runEnv struct {
	*env
	rs   *runs.Service
	cm   *chats.Manager
	fake *agenttest.Fake
	cwd  string // the default folder: a plain folder, no git

	mu   sync.Mutex
	evs  []runTestEvent
	more chan struct{}
}

type runTestEvent struct {
	Type string
	Raw  string
}

func newRunEnv(t *testing.T) *runEnv {
	t.Helper()
	root := filepath.Join(t.TempDir(), "aiwb-srv-data")
	st, err := store.Open(store.NewPaths(root))
	if err != nil {
		t.Fatal(err)
	}
	cwd, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var a *app.App
	var cm *chats.Manager
	br := editorbridge.New(func() any { cm.ClearWatches(); return a.Snapshot() })
	bds := boards.New(st, br)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	fake := agenttest.New(model.Claude)
	rs := runs.New(runs.Deps{Store: st, Emit: br, DefaultCwd: cwd})
	cm = chats.New(chats.Deps{Store: st, Bridge: br, Boards: bds, Runs: rs, DefaultCwd: cwd, MCPURL: "http://localhost:6006/mcp",
		Spawners: map[model.AgentKind]agent.Spawner{model.Claude: fake}})
	if err := rs.Load(); err != nil {
		t.Fatal(err)
	}
	if err := cm.Load(); err != nil {
		t.Fatal(err)
	}
	rs.Chats = cm
	relay := &boardapi.Relay{Bridge: br, Chats: cm, Boards: bds, Runs: rs}
	fake.MCP = http.HandlerFunc(relay.ServeFixedMCP)
	a = &app.App{St: st, Boards: bds, Chats: cm, Runs: rs, Bridge: br, DataDir: root, DefaultCwd: cwd}
	s := &Server{App: a, Relay: relay, Bridge: br, Port: port}
	srv := httptest.NewUnstartedServer(s.Handler())
	srv.Listener.Close()
	srv.Listener = ln
	srv.Start()
	e := &runEnv{env: &env{t: t, st: st, a: a, s: s, url: srv.URL}, rs: rs, cm: cm, fake: fake, cwd: cwd, more: make(chan struct{})}
	// The order of main's shutdown: the runs halt, then the chats close their agents.
	t.Cleanup(func() {
		rs.Shutdown(5 * time.Second)
		cm.Shutdown()
		srv.Close()
	})
	rs.Boot()
	e.follow()
	return e
}

// follow connects as clientID, keeps every event, and returns when the client is active.
func (e *runEnv) follow() {
	e.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	e.t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, "GET", e.url+"/api/events?client="+clientID, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	go func() {
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(nil, 16<<20)
		for sc.Scan() {
			line, ok := strings.CutPrefix(sc.Text(), "data: ")
			if !ok {
				continue
			}
			var head struct{ Type string }
			if json.Unmarshal([]byte(line), &head) != nil {
				continue
			}
			e.mu.Lock()
			e.evs = append(e.evs, runTestEvent{head.Type, line})
			close(e.more)
			e.more = make(chan struct{})
			e.mu.Unlock()
		}
	}()
	e.await("the client to be active", func(evs []runTestEvent) bool {
		return slices.ContainsFunc(evs, func(ev runTestEvent) bool { return ev.Type == "hello" && strings.Contains(ev.Raw, `"active":true`) })
	})
}

func (e *runEnv) events() []runTestEvent {
	e.mu.Lock()
	defer e.mu.Unlock()
	return slices.Clone(e.evs)
}

// await blocks until ok holds for the events so far.
func (e *runEnv) await(what string, ok func(evs []runTestEvent) bool) {
	e.t.Helper()
	deadline := time.After(20 * time.Second)
	for {
		e.mu.Lock()
		evs, more := slices.Clone(e.evs), e.more
		e.mu.Unlock()
		if ok(evs) {
			return
		}
		select {
		case <-more:
		case <-deadline:
			var tail []string
			for _, ev := range evs[max(0, len(evs)-10):] {
				tail = append(tail, ev.Raw[:min(len(ev.Raw), 240)])
			}
			e.t.Fatalf("waiting for %s: nothing after 20 s. The last events:\n%s", what, strings.Join(tail, "\n"))
		}
	}
}

// awaitRun blocks until a `run` event of the run satisfies ok and returns that view.
func (e *runEnv) awaitRun(id, what string, ok func(v model.RunView) bool) model.RunView {
	e.t.Helper()
	var got model.RunView
	e.await("run "+id+" "+what, func(evs []runTestEvent) bool {
		for _, ev := range evs {
			if ev.Type != "run" {
				continue
			}
			var m struct{ Run model.RunView }
			if json.Unmarshal([]byte(ev.Raw), &m) == nil && m.Run.ID == id && ok(m.Run) {
				got = m.Run
				return true
			}
		}
		return false
	})
	return got
}

// refused expects the status and an error text that contains want.
func (e *runEnv) refused(status int, want, method, path, body string) {
	e.t.Helper()
	got := decode[map[string]string](e.t, e.expect(status, method, path, body))["error"]
	if !strings.Contains(got, want) {
		e.t.Fatalf("%s %s: error %q, want one with %q", method, path, got, want)
	}
}

func (e *runEnv) view(status int, method, path, body string) model.RunView {
	e.t.Helper()
	return decode[model.RunView](e.t, e.expect(status, method, path, body))
}

// newRun makes a draft run in the ungrouped area.
func (e *runEnv) newRun() model.RunView {
	e.t.Helper()
	return e.view(200, "POST", "/api/runs", `{"group":"`+model.Ungrouped+`"}`)
}

func (e *runEnv) detail(id string) model.RunDetail {
	e.t.Helper()
	return decode[model.RunDetail](e.t, e.expect(200, "GET", "/api/runs/"+id+"/detail", ""))
}

// What a scripted agent is, by the message it gets.
func isOrchestrator(t *agenttest.Turn) bool {
	return strings.HasPrefix(t.Text, "You are the orchestrator") || strings.Contains(t.Text, "\n---\n\nYou are the orchestrator")
}

// plan is the script of a small run: the first turn sets the notes and adds one reporting task,
// the task reports, and the turn that finds nothing left finishes the run. hold, when not nil, is
// waited for by the first turn before it does anything (an interrupt ends the wait).
func (e *runEnv) plan(hold chan struct{}) {
	e.fake.Script(func(t *agenttest.Turn) {
		switch {
		case isOrchestrator(t) && strings.Contains(t.Text, "This is turn 1."):
			if hold != nil {
				select {
				case <-hold:
				case <-t.Interrupted():
					return
				}
			}
			t.Call("set_notes", map[string]any{"notes": "Done means: the report exists."})
			t.Call("add_task", map[string]any{"title": "Look around", "kind": "research", "writes": false, "tier": "standard", "tier_reason": "A test task.",
				"brief": "Look at the folder and report what is in it, without changing anything."})
			t.Say("One task added.")
		case isOrchestrator(t) && strings.Contains(t.Text, "Nothing is running and nothing can start"):
			t.Call("finish_run", map[string]any{"outcome": "achieved", "summary": "The report exists."})
			t.Say("Finished.")
		case isOrchestrator(t):
			t.Say("Nothing to change.")
		default:
			t.Say("Looked.\n\n" + agenttest.Block("completed", "The folder is empty.", "Nothing is in the folder."))
		}
	})
}

// ---- the routes and their statuses ---------------------------------------------------------

// Create, patch and draft of a run that has not started, and what each refuses.
func TestRunRoutesBeforeTheStart(t *testing.T) {
	e := newRunEnv(t)

	// Create.
	v := e.newRun()
	if !strings.HasPrefix(v.ID, "r_") || v.Name != "New run" || v.Status != model.RunDraft || v.Group != model.Ungrouped ||
		v.Agent != model.Claude || v.Tiers.Deep.Model == "" || v.Tiers.Standard.Model == "" || v.Tiers.Light.Model == "" || v.TierDefaults == nil || v.Cwd != e.cwd || v.Git || v.Settings.MaxParallel != 8 || v.Cost != nil {
		t.Fatalf("the new run: %+v", v)
	}
	g := decode[model.Group](t, e.expect(200, "POST", "/api/groups", `{"name":"G"}`))
	named := e.view(200, "POST", "/api/runs", `{"group":"`+g.ID+`","name":"  Port   the importer "}`)
	if named.Name != "Port the importer" || !named.UserNamed || named.Group != g.ID {
		t.Fatalf("a run made with a name: %+v", named)
	}
	e.refused(400, "group is empty", "POST", "/api/runs", `{}`)
	e.refused(400, "longer than 80", "POST", "/api/runs", `{"group":"`+g.ID+`","name":"`+strings.Repeat("n", 81)+`"}`)
	e.refused(404, "no such group", "POST", "/api/runs", `{"group":"g_nope"}`)
	e.expect(200, "POST", "/api/groups/"+g.ID+"/archive", "")
	e.refused(409, "the group is archived", "POST", "/api/runs", `{"group":"`+g.ID+`"}`)
	e.expect(200, "POST", "/api/groups/"+g.ID+"/unarchive", "")
	if code, out := e.doAs("", "POST", "/api/runs", `{"group":"`+model.Ungrouped+`"}`); code != 409 || !strings.Contains(out, "not_active") {
		t.Fatalf("a run route without the client header: %d %s", code, out)
	}

	// The view, read again.
	if got := e.view(200, "GET", "/api/runs/"+v.ID, ""); got.ID != v.ID || got.Status != model.RunDraft {
		t.Fatalf("GET of the run: %+v", got)
	}

	// Patch: the name and the group; the agent, model, effort, folder and settings of a draft.
	if got := e.view(200, "PATCH", "/api/runs/"+v.ID, `{"name":"A name"}`); got.Name != "A name" || !got.UserNamed {
		t.Fatalf("renamed: %+v", got)
	}
	if got := e.view(200, "PATCH", "/api/runs/"+v.ID, `{"group":"`+g.ID+`"}`); got.Group != g.ID {
		t.Fatalf("moved: %+v", got)
	}
	other := t.TempDir()
	got := e.view(200, "PATCH", "/api/runs/"+v.ID, `{"tiers":{"light":{"model":"haiku"}},"cwd":"`+other+`","settings":{"maxParallel":2,"maxTurns":7,"maxCost":1.5,"setup":"make deps","wake":"idle"}}`)
	if got.Tiers.Light != (model.ModelChoice{Model: "haiku"}) || got.Tiers.Deep != v.Tiers.Deep || got.Cwd != other || got.Settings.MaxParallel != 2 || got.Settings.MaxTurns != 7 || got.Settings.MaxCost != 1.5 ||
		got.Settings.Setup != "make deps" || got.Settings.Wake != "idle" || got.Settings.AgentRetries != 2 {
		t.Fatalf("configured: %+v", got)
	}
	for body, want := range map[string]string{
		`{"name":"  "}`:                                "the name is empty",
		`{"settings":{"maxParallel":0}}`:               "maxParallel must be between 1 and 16",
		`{"settings":{"maxTurns":501}}`:                "maxTurns must be between 1 and 500",
		`{"settings":{"wake":"never"}}`:                "wake must be",
		`{"settings":{"applyResult":"always"}}`:        `applyResult must be "auto" or "manual"`,
		`{"agent":"gpt"}`:                              "unknown agent",
		`{"tiers":{"deep":{"model":"no-such-model"}}}`: "unknown model",
		`{"tiers":{"deep":{"model":""}}}`:              "the model is empty",
		`{"tiers":{"deep":{"effort":"ludicrous"}}}`:    `has no effort "ludicrous"`,
		`{"cwd":"/nonexistent/aiwb-no-such"}`:          "is not a directory",
		`{"cwd":"` + e.a.DataDir + `"}`:                "",
		`{"group":""}`:                                 "group is empty",
	} {
		e.refused(400, want, "PATCH", "/api/runs/"+v.ID, body)
	}
	e.refused(404, "no such group", "PATCH", "/api/runs/"+v.ID, `{"group":"g_nope"}`)
	if again := e.view(200, "GET", "/api/runs/"+v.ID, ""); again.Settings != got.Settings || again.Cwd != other || again.Name != "A name" {
		t.Fatalf("a refused patch changed the run: %+v", again)
	}

	// The goal being typed.
	e.expect(200, "PUT", "/api/runs/"+v.ID+"/draft", `{"text":"Build the th"}`)
	if got := e.view(200, "GET", "/api/runs/"+v.ID, ""); got.Draft == nil || got.Draft.Text != "Build the th" {
		t.Fatalf("the draft: %+v", got.Draft)
	}
	e.expect(200, "PUT", "/api/runs/"+v.ID+"/draft", `{"text":""}`)
	if got := e.view(200, "GET", "/api/runs/"+v.ID, ""); got.Draft != nil {
		t.Fatalf("the cleared draft: %+v", got.Draft)
	}

	// What a run that has not started has not got.
	e.refused(409, "has not started", "GET", "/api/runs/"+v.ID+"/detail", "")
	e.refused(409, "has not started", "GET", "/api/runs/"+v.ID+"/goal", "")
	e.refused(409, "has not started", "POST", "/api/runs/"+v.ID+"/stop", "")
	e.refused(409, "has not started", "POST", "/api/runs/"+v.ID+"/resume", "")
	e.refused(404, "no such task", "GET", "/api/runs/"+v.ID+"/tasks/T01/brief", "")
	e.refused(404, "no such task", "GET", "/api/runs/"+v.ID+"/tasks/T01/attempts/1/report", "")
	e.refused(404, "no such task", "GET", "/api/runs/"+v.ID+"/tasks/T01/attempts/1/changes", "")
	e.refused(404, "no such version", "GET", "/api/runs/"+v.ID+"/notes/1", "")

	// An archived draft keeps its name and group open, and nothing else.
	e.expect(200, "POST", "/api/runs/"+v.ID+"/archive", "")
	e.refused(409, "the run is archived", "PATCH", "/api/runs/"+v.ID, `{"settings":{"maxTurns":9}}`)
	e.refused(409, "the run is archived", "POST", "/api/runs/"+v.ID+"/start", `{"goal":"x"}`)
	if got := e.view(200, "PATCH", "/api/runs/"+v.ID, `{"name":"Still mine"}`); got.Name != "Still mine" || !got.Archived || got.Op == "" {
		t.Fatalf("an archived draft renamed: %+v", got)
	}
	e.expect(200, "POST", "/api/runs/"+v.ID+"/unarchive", "")
	if got := e.view(200, "GET", "/api/runs/"+v.ID, ""); got.Archived {
		t.Fatalf("unarchived: %+v", got)
	}
}

// Every run route answers 404 for a run that does not exist.
func TestRunRoutesOfAMissingRun(t *testing.T) {
	e := newRunEnv(t)
	for _, c := range [][3]string{
		{"GET", "", ""}, {"PATCH", "", `{"name":"x"}`}, {"DELETE", "", ""},
		{"PUT", "/draft", `{"text":"x"}`}, {"POST", "/start", `{"goal":"x"}`}, {"POST", "/stop", ""}, {"POST", "/resume", ""},
		{"POST", "/archive", ""}, {"POST", "/unarchive", ""},
		{"GET", "/detail", ""}, {"GET", "/goal", ""}, {"GET", "/tasks/T01/brief", ""},
		{"GET", "/tasks/T01/attempts/1/report", ""}, {"GET", "/tasks/T01/attempts/1/changes", ""}, {"GET", "/notes/1", ""},
	} {
		e.refused(404, "no such run", c[0], "/api/runs/r_nope"+c[1], c[2])
	}
	e.refused(404, "no such run", "POST", "/api/chats", `{"agent":"claude","run":"r_nope"}`)
}

// A start that the folder forbids answers 409 with the sentence the view shows.
func TestRunStartRefusals(t *testing.T) {
	e := newRunEnv(t)
	v := e.newRun()
	e.refused(400, "the goal is empty", "POST", "/api/runs/"+v.ID+"/start", `{"goal":"  "}`)
	e.refused(400, "", "POST", "/api/runs/"+v.ID+"/start", `not json`)

	// A repository without a commit: the view says why, and the start answers the same.
	repo := agenttest.NewRepo(t)
	got := e.view(200, "PATCH", "/api/runs/"+v.ID, `{"cwd":"`+repo.Dir()+`"}`)
	const noCommit = "this repository has no commit yet"
	if !got.Git || !strings.Contains(got.Blocked, noCommit) {
		t.Fatalf("the run in a repository without a commit: git %v, blocked %q", got.Git, got.Blocked)
	}
	e.refused(409, noCommit, "POST", "/api/runs/"+v.ID+"/start", `{"goal":"Build it."}`)
	if got := e.view(200, "GET", "/api/runs/"+v.ID, ""); got.Status != model.RunDraft || !strings.Contains(got.Blocked, noCommit) {
		t.Fatalf("after the refused start: %+v", got)
	}

	// A folder that is gone.
	gone := filepath.Join(t.TempDir(), "gone")
	if err := os.Mkdir(gone, 0o755); err != nil {
		t.Fatal(err)
	}
	e.view(200, "PATCH", "/api/runs/"+v.ID, `{"cwd":"`+gone+`"}`)
	os.Remove(gone)
	e.refused(409, "Folder not found: "+gone, "POST", "/api/runs/"+v.ID+"/start", `{"goal":"Build it."}`)
	if got := e.view(200, "GET", "/api/runs/"+v.ID, ""); !got.FolderMissing {
		t.Fatalf("the view of a run whose folder is gone: %+v", got)
	}

	// An agent with no model yet.
	if got := e.view(200, "PATCH", "/api/runs/"+v.ID, `{"agent":"cursor","cwd":"`+e.cwd+`"}`); got.Tiers.Deep.Model == "" {
		e.refused(400, "pick a model first", "POST", "/api/runs/"+v.ID+"/start", `{"goal":"Build it."}`)
	}
}

// One run from its start to its end through the routes: start, what a started run refuses, the
// detail and what is read on demand, the snapshot, and delete.
func TestRunRoutesOfAStartedRun(t *testing.T) {
	e := newRunEnv(t)
	hold := make(chan struct{})
	e.plan(hold)
	v := e.newRun()
	e.expect(200, "PUT", "/api/runs/"+v.ID+"/draft", `{"text":"Look at the fol"}`)
	const goal = "Look at the folder and say what is in it.\nThen finish."
	started := e.view(200, "POST", "/api/runs/"+v.ID+"/start", `{"goal":"Look at the folder and say what is in it.\nThen finish."}`)
	if started.Status != model.RunRunning || started.Started.IsZero() || started.Draft != nil || started.Git ||
		started.Name != "Look at the folder and say what is in it" {
		t.Fatalf("the started run: %+v", started)
	}

	// What a started run refuses, and what it still takes.
	e.refused(409, "the run has started", "POST", "/api/runs/"+v.ID+"/start", `{"goal":"again"}`)
	e.refused(409, "the run has started", "PATCH", "/api/runs/"+v.ID, `{"settings":{"maxTurns":9}}`)
	e.refused(409, "the run has started", "PATCH", "/api/runs/"+v.ID, `{"tiers":{"light":{"model":"haiku"}}}`)
	e.refused(409, "the run is not stopped", "POST", "/api/runs/"+v.ID+"/resume", "")
	e.expect(200, "PUT", "/api/runs/"+v.ID+"/draft", `{"text":"late"}`)
	if got := e.view(200, "PATCH", "/api/runs/"+v.ID, `{"name":"Looking"}`); got.Name != "Looking" || got.Draft != nil {
		t.Fatalf("a started run renamed: %+v", got)
	}

	// The first turn waits: its agent's chat exists, hidden, and a person cannot change it.
	e.await("the first turn's agent to run", func([]runTestEvent) bool {
		d := e.detail(v.ID)
		return len(d.Turns) == 1 && d.Agents[d.Turns[0].Agent].Status == model.AgentRunning && len(e.fake.Spawns()) > 0
	})
	d := e.detail(v.ID)
	orch := d.Turns[0].Agent
	if d.Run != v.ID || d.Status != model.RunRunning || d.GoalSize != len(goal) || d.Git != nil || d.Turns[0].Reason != "start" ||
		d.Stops == nil || d.Tasks == nil || d.ChatOps == nil || d.Notes == nil {
		t.Fatalf("the detail of the started run: %+v", d)
	}
	if got := decode[model.RunGoal](t, e.expect(200, "GET", "/api/runs/"+v.ID+"/goal", "")); got.Text != goal {
		t.Fatalf("the goal: %q", got.Text)
	}
	cv := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+orch, ""))
	if cv.Run != v.ID || cv.Role != model.RoleOrchestrator || cv.Group != "" {
		t.Fatalf("the orchestrator's chat: %+v", cv)
	}
	for _, c := range [][3]string{
		{"POST", "/messages", `{"text":"hello"}`}, {"PUT", "/draft", `{"text":"x"}`}, {"PATCH", "", `{"name":"x"}`},
		{"PATCH", "", `{"model":"haiku"}`}, {"PATCH", "", `{"group":"` + model.Ungrouped + `"}`},
		{"POST", "/fork", `{"at":1}`}, {"PUT", "/label", `{"item":0,"text":"x"}`}, {"POST", "/interrupt", ""},
		{"POST", "/archive", ""}, {"POST", "/unarchive", ""}, {"DELETE", "", ""},
	} {
		e.refused(409, "one of a run's agents", c[0], "/api/chats/"+orch+c[1], c[2])
	}
	for _, path := range []string{"/items", "/tree"} {
		e.expect(200, "GET", "/api/chats/"+orch+path, "")
	}
	e.expect(200, "POST", "/api/chats/"+orch+"/open", "")

	// The snapshot: the run, and no chat of its agents.
	raw := e.expect(200, "GET", "/api/state", "")
	snap := decode[struct {
		Runs  []model.RunView
		Chats []model.ChatView
	}](t, raw)
	if len(snap.Runs) != 1 || snap.Runs[0].ID != v.ID || snap.Runs[0].Status != model.RunRunning || len(snap.Chats) != 0 {
		t.Fatalf("the snapshot: %s", raw)
	}

	// The run goes on to its end.
	close(hold)
	done := e.awaitRun(v.ID, "to end", func(v model.RunView) bool { return v.Status.Final() })
	if done.Status != model.RunCompleted || done.Outcome != model.Achieved || done.Counts.Done != 1 || done.Turns < 2 {
		t.Fatalf("the run's end: %+v", done)
	}
	d = e.detail(v.ID)
	if len(d.Tasks) != 1 || d.Tasks[0].ID != "T01" || d.Tasks[0].Attempts[0].Outcome != model.TaskDone || d.Result == nil || len(d.Notes) != 1 {
		t.Fatalf("the detail of the finished run: %+v", d)
	}

	// What is read on demand.
	brief := decode[model.TaskBrief](t, e.expect(200, "GET", "/api/runs/"+v.ID+"/tasks/T01/brief", ""))
	if brief.Task != "T01" || brief.Rev != 1 || !strings.HasPrefix(brief.Text, "Look at the folder and report") {
		t.Fatalf("the brief: %+v", brief)
	}
	if again := e.expect(200, "GET", "/api/runs/"+v.ID+"/tasks/T01/brief?rev=1", ""); decode[model.TaskBrief](t, again).Text != brief.Text {
		t.Fatalf("the brief by revision: %s", again)
	}
	e.refused(404, "no such version", "GET", "/api/runs/"+v.ID+"/tasks/T01/brief?rev=2", "")
	e.refused(400, "rev must be a number", "GET", "/api/runs/"+v.ID+"/tasks/T01/brief?rev=x", "")
	e.refused(404, "no such task", "GET", "/api/runs/"+v.ID+"/tasks/T09/brief", "")
	rep := decode[model.AttemptReport](t, e.expect(200, "GET", "/api/runs/"+v.ID+"/tasks/T01/attempts/1/report", ""))
	if rep.Task != "T01" || rep.Attempt != 1 || rep.Outcome != "completed" || rep.Summary != "The folder is empty." || rep.Report != "Nothing is in the folder." {
		t.Fatalf("the report: %+v", rep)
	}
	e.refused(404, "no such attempt", "GET", "/api/runs/"+v.ID+"/tasks/T01/attempts/2/report", "")
	e.refused(400, "n must be a number", "GET", "/api/runs/"+v.ID+"/tasks/T01/attempts/x/report", "")
	e.refused(404, "nothing recorded yet", "GET", "/api/runs/"+v.ID+"/tasks/T01/attempts/1/changes", "") // a run without git commits nothing
	e.refused(404, "no such attempt", "GET", "/api/runs/"+v.ID+"/tasks/T01/attempts/2/changes", "")
	notes := decode[model.RunNotes](t, e.expect(200, "GET", "/api/runs/"+v.ID+"/notes/1", ""))
	if notes.V != 1 || notes.Turn != 1 || !strings.HasPrefix(notes.Text, "Done means: the report exists.") {
		t.Fatalf("the notes: %+v", notes)
	}
	e.refused(404, "no such version", "GET", "/api/runs/"+v.ID+"/notes/2", "")

	// What a finished run refuses.
	e.refused(409, "the run is not running", "POST", "/api/runs/"+v.ID+"/stop", "")
	e.refused(409, "the run is finished", "POST", "/api/runs/"+v.ID+"/resume", "")

	// Every agent's chat is under the run's folder, none in chats/.
	if ents, _ := os.ReadDir(e.st.P.Chats); len(ents) != 0 {
		t.Errorf("%d folders in chats/", len(ents))
	}
	for id := range d.Agents {
		if _, err := os.Stat(filepath.Join(e.st.P.RunDir(v.ID), "agents", id, "chat.json")); err != nil {
			t.Errorf("an agent's chat: %v", err)
		}
	}

	// Delete: the run goes with its agents' chats; run_removed is its last event.
	e.expect(200, "DELETE", "/api/runs/"+v.ID, "")
	e.refused(404, "no such run", "GET", "/api/runs/"+v.ID, "")
	e.refused(404, "no such chat", "GET", "/api/chats/"+orch, "")
	e.await("run_removed", func(evs []runTestEvent) bool {
		return slices.ContainsFunc(evs, func(ev runTestEvent) bool { return ev.Type == "run_removed" && strings.Contains(ev.Raw, v.ID) })
	})
	if _, err := os.Stat(e.st.P.RunDir(v.ID)); !os.IsNotExist(err) {
		t.Errorf("the run's folder after the delete: %v", err)
	}
	if raw := e.expect(200, "GET", "/api/state", ""); !strings.Contains(raw, `"runs":[]`) {
		t.Errorf("the snapshot without runs has no empty list: %s", raw)
	}
}

// Stop, the answers while a run is stopping, resume, a limit that must be raised, and archive of
// a run that works.
func TestRunStopResumeAndLimit(t *testing.T) {
	e := newRunEnv(t)
	// The first turn hangs; once it is interrupted it takes a moment to let go, so the run is
	// seen stopping. From the second start on the script is the small run's.
	slow, working := make(chan struct{}), make(chan struct{})
	var once sync.Once
	e.fake.Script(func(t *agenttest.Turn) {
		once.Do(func() { close(working) })
		<-t.Interrupted()
		<-slow
	})
	v := e.newRun()
	e.view(200, "PATCH", "/api/runs/"+v.ID, `{"settings":{"maxTurns":1}}`)
	e.view(200, "POST", "/api/runs/"+v.ID+"/start", `{"goal":"Look around."}`)
	// Until the turn itself has begun, not only its process: a stop that finds the agent between
	// the two has nothing to wait for, and the run is stopped before the next request.
	select {
	case <-working:
	case <-time.After(20 * time.Second):
		t.Fatal("the first turn's agent did not start to work")
	}

	stopping := e.view(200, "POST", "/api/runs/"+v.ID+"/stop", "")
	if stopping.Status != model.RunStopping {
		t.Fatalf("the answer of stop: %+v", stopping)
	}
	if again := e.view(200, "POST", "/api/runs/"+v.ID+"/stop", ""); again.Status != model.RunStopping {
		t.Fatalf("a second stop while stopping: %+v", again)
	}
	e.refused(409, "the run is stopping", "POST", "/api/runs/"+v.ID+"/resume", "")
	e.plan(nil)
	close(slow)
	stopped := e.awaitRun(v.ID, "to stop", func(v model.RunView) bool { return v.Status == model.RunStopped })
	if stopped.Reason != "stopped by the user" || stopped.TurnRunning != 1 {
		t.Fatalf("the stopped run: %+v", stopped)
	}
	e.refused(409, "the run is not running", "POST", "/api/runs/"+v.ID+"/stop", "")
	if d := e.detail(v.ID); len(d.Stops) != 1 || d.Stops[0].Reason != model.StopUser || d.Stops[0].ResumedAt != 0 ||
		d.Agents[d.Turns[0].Agent].Status != model.AgentInterrupted {
		t.Fatalf("the detail of the stopped run: stops %+v, agent %+v", d.Stops, d.Agents[d.Turns[0].Agent])
	}

	// Resume: the turn is continued, adds its task, and the run reaches its limit of one turn.
	if resumed := e.view(200, "POST", "/api/runs/"+v.ID+"/resume", ""); resumed.Status != model.RunRunning {
		t.Fatalf("the resumed run: %+v", resumed)
	}
	stalled := e.awaitRun(v.ID, "to stall", func(v model.RunView) bool { return v.Status == model.RunStalled })
	if stalled.StalledBy != model.StalledTurns || stalled.Turns != 1 || stalled.Counts.Done != 1 {
		t.Fatalf("the stalled run: %+v", stalled)
	}
	e.refused(409, "raise it to resume", "POST", "/api/runs/"+v.ID+"/resume", "")
	e.refused(409, "raise it to resume", "POST", "/api/runs/"+v.ID+"/resume", `{}`)
	e.refused(400, "the run has used 1 turn", "POST", "/api/runs/"+v.ID+"/resume", `{"maxTurns":1}`)
	e.refused(400, "maxTurns must be between 1 and 500", "POST", "/api/runs/"+v.ID+"/resume", `{"maxTurns":501}`)
	if resumed := e.view(200, "POST", "/api/runs/"+v.ID+"/resume", `{"maxTurns":5}`); resumed.Status != model.RunRunning || resumed.Settings.MaxTurns != 5 {
		t.Fatalf("resumed with a higher limit: %+v", resumed)
	}
	done := e.awaitRun(v.ID, "to end", func(v model.RunView) bool { return v.Status.Final() })
	if done.Status != model.RunCompleted || done.Turns != 2 {
		t.Fatalf("the run's end: %+v", done)
	}

	// Archive of a run that works: it is stopped first (by the user), then archived.
	gate := make(chan struct{})
	defer close(gate)
	e.plan(gate)
	w := e.newRun()
	e.view(200, "POST", "/api/runs/"+w.ID+"/start", `{"goal":"Look around again."}`)
	e.await("the second run's first turn", func([]runTestEvent) bool { return e.fake.Live() == 1 })
	e.expect(200, "POST", "/api/runs/"+w.ID+"/archive", "")
	if got := e.view(200, "GET", "/api/runs/"+w.ID, ""); !got.Archived || got.Status != model.RunStopped || got.Reason != "the run was archived" {
		t.Fatalf("the archived run: %+v", got)
	}
	e.refused(409, "the run is archived", "POST", "/api/runs/"+w.ID+"/resume", "")
	e.refused(409, "the run is archived", "POST", "/api/chats", `{"agent":"claude","run":"`+w.ID+`"}`)
	e.expect(200, "POST", "/api/runs/"+w.ID+"/unarchive", "")
	if got := e.view(200, "GET", "/api/runs/"+w.ID, ""); got.Archived || got.Status != model.RunStopped {
		t.Fatalf("the unarchived run (it does not resume by itself): %+v", got)
	}
}

// A chat a person opens on a run: made by POST /api/chats {agent, run}, listed with its run and
// no group, told about the run with every message, archived and brought back with its run.
func TestChatOnARunRoutes(t *testing.T) {
	e := newRunEnv(t)
	var mu sync.Mutex
	var seen []string
	e.fake.Script(func(t *agenttest.Turn) {
		mu.Lock()
		seen = append(seen, strings.Join(t.Tools(), " ")+"\n"+t.Text)
		mu.Unlock()
		t.Say("ok")
	})
	g := decode[model.Group](t, e.expect(200, "POST", "/api/groups", `{"name":"G"}`))
	v := e.view(200, "POST", "/api/runs", `{"group":"`+g.ID+`","name":"The run"}`)

	// On a draft already.
	cv := e.chat(`{"agent":"claude","run":"` + v.ID + `"}`)
	if cv.Run != v.ID || cv.Role != "" || cv.Group != "" || cv.Board != "" || cv.Cwd != e.cwd {
		t.Fatalf("the chat on the run: %+v", cv)
	}
	if _, err := os.Stat(filepath.Join(e.st.P.RunDir(v.ID), "chats", cv.ID, "chat.json")); err != nil {
		t.Fatalf("where the chat is kept: %v", err)
	}
	e.refused(400, "unknown agent", "POST", "/api/chats", `{"agent":"gpt","run":"`+v.ID+`"}`)
	snap := decode[struct {
		Runs  []model.RunView
		Chats []model.ChatView
	}](t, e.expect(200, "GET", "/api/state", ""))
	if len(snap.Runs) != 1 || len(snap.Chats) != 1 || snap.Chats[0].ID != cv.ID || snap.Chats[0].Run != v.ID {
		t.Fatalf("the snapshot: %+v", snap)
	}

	// Its agent is told which run it is on and lists the run tools of a chat and the spawn family.
	e.expect(200, "POST", "/api/chats/"+cv.ID+"/messages", `{"text":"How is it going?"}`)
	e.await("the chat's reply", func([]runTestEvent) bool { mu.Lock(); defer mu.Unlock(); return len(seen) == 1 })
	mu.Lock()
	first := seen[0]
	mu.Unlock()
	tools, msg, _ := strings.Cut(first, "\n")
	if tools != "get_run get_task get_agent get_notes add_task update_task cancel_task retry_task tell_orchestrator spawn_subagent stop_subagent list_subagent_models" {
		t.Errorf("the tools of a chat on a run: %s", tools)
	}
	for _, want := range []string{`This chat belongs to the run "The run" (id ` + v.ID + `)`, "mcp__board__get_task", "How is it going?"} {
		if !strings.Contains(msg, want) {
			t.Errorf("the chat's message has no %q:\n%s", want, msg)
		}
	}

	// It moves with its run, not by itself.
	e.refused(400, "a run's chat moves with its run", "PATCH", "/api/chats/"+cv.ID, `{"group":"`+model.Ungrouped+`"}`)

	// Archive of the run takes the chat along with the same action; a second chat archived before
	// keeps its own.
	early := e.chat(`{"agent":"claude","run":"` + v.ID + `"}`)
	e.expect(200, "POST", "/api/chats/"+early.ID+"/archive", "")
	e.expect(200, "POST", "/api/runs/"+v.ID+"/archive", "")
	rv := e.view(200, "GET", "/api/runs/"+v.ID, "")
	c1 := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+cv.ID, ""))
	c0 := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+early.ID, ""))
	if !rv.Archived || !c1.Archived || c1.Op != rv.Op || !c0.Archived || c0.Op == rv.Op {
		t.Fatalf("after the run's archive: run %v %q, chat %v %q, the earlier chat %v %q", rv.Archived, rv.Op, c1.Archived, c1.Op, c0.Archived, c0.Op)
	}
	e.refused(409, "", "POST", "/api/chats/"+cv.ID+"/messages", `{"text":"still there?"}`)

	// Unarchiving the earlier chat brings the run back, and not the run's other chat.
	e.expect(200, "POST", "/api/chats/"+early.ID+"/unarchive", "")
	rv = e.view(200, "GET", "/api/runs/"+v.ID, "")
	c1 = decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+cv.ID, ""))
	c0 = decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+early.ID, ""))
	if rv.Archived || c0.Archived || !c1.Archived {
		t.Fatalf("after unarchiving a chat of the run: run %v, that chat %v, the other %v", rv.Archived, c0.Archived, c1.Archived)
	}

	// The run's own unarchive brings back what its archive took.
	e.expect(200, "POST", "/api/runs/"+v.ID+"/archive", "")
	e.expect(200, "POST", "/api/runs/"+v.ID+"/unarchive", "")
	if c1 = decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+cv.ID, "")); !c1.Archived {
		// cv was archived by the first archive of the run, whose action the second does not share.
		t.Log("the chat archived by an earlier action stays archived, as a board's does")
	}

	// Delete of the run deletes its chats.
	e.expect(200, "DELETE", "/api/runs/"+v.ID, "")
	e.refused(404, "no such chat", "GET", "/api/chats/"+cv.ID, "")
	e.refused(404, "no such chat", "GET", "/api/chats/"+early.ID, "")
	e.await("chat_removed of both chats", func(evs []runTestEvent) bool {
		n := 0
		for _, ev := range evs {
			if ev.Type == "chat_removed" && (strings.Contains(ev.Raw, cv.ID) || strings.Contains(ev.Raw, early.ID)) {
				n++
			}
		}
		return n == 2
	})
}

// A group's delete and archive reach its runs.
func TestGroupCascadesOverRuns(t *testing.T) {
	e := newRunEnv(t)
	group := func(name, parent string) string {
		return decode[model.Group](t, e.expect(200, "POST", "/api/groups", fmt.Sprintf(`{"name":%q,"parent":%q}`, name, parent))).ID
	}
	run := func(g string) string { return e.view(200, "POST", "/api/runs", `{"group":"`+g+`"}`).ID }
	groupOf := func(id string) string { return e.view(200, "GET", "/api/runs/"+id, "").Group }

	// Delete, keeping the contents: the group's runs move up to its parent; a subgroup's stay.
	top := group("top", "")
	mid := group("mid", top)
	low := group("low", mid)
	inMid, inLow := run(mid), run(low)
	e.expect(200, "DELETE", "/api/groups/"+mid+"?contents=keep", "")
	if groupOf(inMid) != top || groupOf(inLow) != low {
		t.Fatalf("after deleting the group and keeping its contents: %s is in %s, %s in %s", inMid, groupOf(inMid), inLow, groupOf(inLow))
	}
	e.awaitRun(inMid, "to move", func(v model.RunView) bool { return v.Group == top })

	// Delete with the contents: the runs of the whole subtree go.
	e.expect(200, "DELETE", "/api/groups/"+top+"?contents=delete", "")
	e.refused(404, "no such run", "GET", "/api/runs/"+inMid, "")
	e.refused(404, "no such run", "GET", "/api/runs/"+inLow, "")
	e.refused(404, "", "POST", "/api/runs", `{"group":"`+low+`"}`)

	// A top-level group's runs move to the ungrouped area.
	solo := group("solo", "")
	inSolo := run(solo)
	e.expect(200, "DELETE", "/api/groups/"+solo+"?contents=keep", "")
	if groupOf(inSolo) != model.Ungrouped {
		t.Fatalf("a top-level group's run after the delete: in %s", groupOf(inSolo))
	}

	// Archive: the subtree's runs get the group's action, a working one is stopped first, and one
	// archived before keeps its own. Unarchive brings back exactly what the archive took.
	a := group("a", "")
	b := group("b", a)
	gate := make(chan struct{})
	defer close(gate)
	e.plan(gate)
	draft, working, before := run(a), run(b), run(b)
	chat := e.chat(`{"agent":"claude","run":"` + draft + `"}`)
	e.expect(200, "POST", "/api/runs/"+before+"/archive", "")
	e.view(200, "POST", "/api/runs/"+working+"/start", `{"goal":"Look around."}`)
	e.await("the working run's first turn", func([]runTestEvent) bool { return e.fake.Live() == 1 })
	e.expect(200, "POST", "/api/groups/"+a+"/archive", "")
	vd, vw, vb := e.view(200, "GET", "/api/runs/"+draft, ""), e.view(200, "GET", "/api/runs/"+working, ""), e.view(200, "GET", "/api/runs/"+before, "")
	cv := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+chat.ID, ""))
	if !vd.Archived || !vw.Archived || vd.Op != vw.Op || vw.Status != model.RunStopped || !vb.Archived || vb.Op == vd.Op || !cv.Archived || cv.Op != vd.Op {
		t.Fatalf("after the group's archive: draft %v %q, working %v %q %s, earlier %v %q, chat %v %q",
			vd.Archived, vd.Op, vw.Archived, vw.Op, vw.Status, vb.Archived, vb.Op, cv.Archived, cv.Op)
	}
	e.expect(200, "POST", "/api/groups/"+a+"/unarchive", "")
	vd, vw, vb = e.view(200, "GET", "/api/runs/"+draft, ""), e.view(200, "GET", "/api/runs/"+working, ""), e.view(200, "GET", "/api/runs/"+before, "")
	cv = decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+chat.ID, ""))
	if vd.Archived || vw.Archived || vw.Status != model.RunStopped || !vb.Archived || cv.Archived {
		t.Fatalf("after the group's unarchive: draft %v, working %v %s, earlier %v, chat %v", vd.Archived, vw.Archived, vw.Status, vb.Archived, cv.Archived)
	}

	// Unarchiving a run brings back the groups it is in.
	e.expect(200, "POST", "/api/groups/"+a+"/archive", "")
	e.expect(200, "POST", "/api/runs/"+draft+"/unarchive", "")
	snap := decode[struct{ Groups []model.Group }](t, e.expect(200, "GET", "/api/state", ""))
	for _, g := range snap.Groups {
		if g.ID == a && g.Archived || g.ID == b && !g.Archived {
			t.Errorf("group %s after unarchiving a run of %s: archived %v", g.Name, a, g.Archived)
		}
	}
}

// The chat events of a run's agent reach the client only after it read that chat's items; a new
// connection watches nothing.
func TestRunAgentEventsStartWithItsItems(t *testing.T) {
	e := newRunEnv(t)
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
	v := e.newRun()
	e.view(200, "POST", "/api/runs/"+v.ID+"/start", `{"goal":"Look around."}`)
	<-said
	orch := e.detail(v.ID).Turns[0].Agent
	about := func(evs []runTestEvent) (n int) {
		for _, ev := range evs {
			if (ev.Type == "chat" || ev.Type == "chat_items" || ev.Type == "sub" || ev.Type == "sub_items") && strings.Contains(ev.Raw, orch) {
				n++
			}
		}
		return n
	}
	// The run's own events came; they name the agent, and its live activity follows in time.
	e.await("the run's events", func(evs []runTestEvent) bool {
		return slices.ContainsFunc(evs, func(ev runTestEvent) bool { return ev.Type == "run_detail" && strings.Contains(ev.Raw, orch) })
	})
	e.await("the agent's activity", func(evs []runTestEvent) bool {
		return slices.ContainsFunc(evs, func(ev runTestEvent) bool {
			return ev.Type == "run_activity" && strings.Contains(ev.Raw, orch) && strings.Contains(ev.Raw, `"activity":"Bash: ls -la"`)
		})
	})
	if n := about(e.events()); n != 0 {
		t.Fatalf("%d chat events of the agent's chat before its items were read", n)
	}

	// Reading the items starts them.
	got := decode[struct{ Items []model.Item }](t, e.expect(200, "GET", "/api/chats/"+orch+"/items", ""))
	if len(got.Items) < 2 || got.Items[0].Kind != "user" || !strings.HasPrefix(got.Items[0].Text, "You are the orchestrator") {
		t.Fatalf("the agent's items: %+v", got.Items)
	}
	close(next)
	<-said
	e.await("the agent's chat_items", func(evs []runTestEvent) bool {
		return slices.ContainsFunc(evs, func(ev runTestEvent) bool {
			return ev.Type == "chat_items" && strings.Contains(ev.Raw, orch) && strings.Contains(ev.Raw, "second")
		})
	})

	// A client that connects anew gets a snapshot and watches nothing.
	e.cm.ClearWatches()
	before := about(e.events())
	e.expect(200, "POST", "/api/runs/"+v.ID+"/stop", "")
	e.awaitRun(v.ID, "to stop", func(v model.RunView) bool { return v.Status == model.RunStopped })
	if n := about(e.events()); n != before {
		t.Errorf("%d chat events of the agent's chat after the watches were cleared", n-before)
	}
}

// GET /api/dirs says whether a folder is inside a git work tree: a folder below the top level
// counts, a folder that only holds something named .git does not.
func TestDirsGit(t *testing.T) {
	e := newRunEnv(t)
	repo := agenttest.NewRepo(t)
	sub := filepath.Join(repo.Dir(), "pkg", "deep")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	plain := t.TempDir()
	if err := os.WriteFile(filepath.Join(plain, ".git"), []byte("not a repository"), 0o644); err != nil {
		t.Fatal(err)
	}
	for dir, want := range map[string]bool{repo.Dir(): true, sub: true, plain: false, e.cwd: false} {
		got := decode[struct {
			Path string
			Git  bool
		}](t, e.expect(200, "GET", "/api/dirs?path="+dir, ""))
		if got.Git != want {
			t.Errorf("git of %s: %v, want %v", dir, got.Git, want)
		}
	}
}

// A turn that ends because the run stopped it, or because its task was cancelled, is not the
// agent's result, whatever its last text says: an adapter ends an interrupted turn with a turn
// end of its own (aborted) before the process goes, and the text before it can be a whole result
// block.
func TestAbortedTurnAfterAStopIsNotAResult(t *testing.T) {
	e := newRunEnv(t)
	wrote := make(chan struct{}, 8)
	var mu sync.Mutex
	hang := true // the task's agent writes its block and then keeps working until it is interrupted
	e.fake.Script(func(t *agenttest.Turn) {
		switch {
		case strings.HasPrefix(t.Text, "<ui-context>"): // the chat on the run
			text, isErr := t.Call("cancel_task", map[string]any{"id": "T02", "reason": "not needed"})
			t.Say(fmt.Sprintf("cancel_task: %v %s", isErr, text))
		case isOrchestrator(t) && strings.Contains(t.Text, "This is turn 1."):
			t.Call("set_notes", map[string]any{"notes": "Done means: the reports exist."})
			for _, title := range []string{"Look around", "Look again"} {
				t.Call("add_task", map[string]any{"title": title, "kind": "research", "writes": false, "tier": "standard", "tier_reason": "A test task.",
					"brief": "Look at the folder and report what is in it, without changing anything."})
			}
			t.Say("Two tasks added.")
		case isOrchestrator(t) && strings.Contains(t.Text, "Nothing is running and nothing can start"):
			t.Call("finish_run", map[string]any{"outcome": "achieved", "summary": "Done."})
		case isOrchestrator(t):
		default:
			t.Say("Looked.\n\n" + agenttest.Block("completed", "A result nobody asked for yet.", "The whole report."))
			mu.Lock()
			wait := hang
			mu.Unlock()
			if wait {
				wrote <- struct{}{}
				<-t.Interrupted()
			}
		}
	})
	v := e.newRun()
	e.view(200, "PATCH", "/api/runs/"+v.ID, `{"settings":{"maxParallel":2}}`)
	e.view(200, "POST", "/api/runs/"+v.ID+"/start", `{"goal":"Look around twice."}`)
	<-wrote
	<-wrote

	// A chat on the run cancels the second task while its agent works, a whole block being the
	// last thing it wrote: the task ends cancelled, with no result.
	cv := e.chat(`{"agent":"claude","run":"` + v.ID + `"}`)
	e.expect(200, "POST", "/api/chats/"+cv.ID+"/messages", `{"text":"Cancel T02."}`)
	e.await("T02 to be cancelled", func([]runTestEvent) bool {
		d := e.detail(v.ID)
		return len(d.Tasks) == 2 && d.Tasks[1].Attempts[0].Outcome == model.TaskCancelled
	})
	d := e.detail(v.ID)
	if a := d.Tasks[1].Attempts[0]; a.Result != nil || a.Cancel == nil || a.Cancel.Chat != cv.ID || d.Agents[a.Agents.Work].Status != model.AgentCancelled {
		t.Errorf("the cancelled task: %+v, its agent %+v", a, d.Agents[a.Agents.Work])
	}

	// The run is stopped while the first task's agent works, in the same state.
	e.expect(200, "POST", "/api/runs/"+v.ID+"/stop", "")
	e.awaitRun(v.ID, "to stop", func(v model.RunView) bool { return v.Status == model.RunStopped })
	d = e.detail(v.ID)
	first := d.Tasks[0].Attempts[0]
	if ag := d.Agents[first.Agents.Work]; first.Result != nil || first.Outcome != "" || ag.Status != model.AgentInterrupted || len(ag.Launches) != 1 || ag.Launches[0].Error != "" {
		t.Errorf("T01 after the stop: result %+v, outcome %q, agent %+v", first.Result, first.Outcome, ag)
	}
	// Both agents' chats do end with the block: it is the engine that does not take it.
	for _, task := range d.Tasks {
		got := decode[struct{ Items []model.Item }](t, e.expect(200, "GET", "/api/chats/"+task.Attempts[0].Agents.Work+"/items", ""))
		if !slices.ContainsFunc(got.Items, func(it model.Item) bool { return it.Kind == "text" && strings.HasSuffix(it.Text, "</result>") }) {
			t.Errorf("%s: the agent's chat has no text that ends with its block (%d items)", task.ID, len(got.Items))
		}
	}
	for _, id := range []string{"T01", "T02"} {
		e.refused(404, "nothing recorded yet", "GET", "/api/runs/"+v.ID+"/tasks/"+id+"/attempts/1/report", "")
	}

	// Resumed, the first task's agent is launched again (a resume of its session), answers, and
	// only that answer is its result.
	mu.Lock()
	hang = false
	mu.Unlock()
	e.view(200, "POST", "/api/runs/"+v.ID+"/resume", "")
	e.await("T01 to be done", func([]runTestEvent) bool { return e.detail(v.ID).Tasks[0].Attempts[0].Outcome == model.TaskDone })
	d = e.detail(v.ID)
	a := d.Tasks[0].Attempts[0]
	if ag := d.Agents[a.Agents.Work]; a.Result == nil || a.Result.Outcome != "completed" || len(ag.Launches) != 2 || !ag.Launches[1].Resume || ag.Status != model.AgentDone {
		t.Errorf("T01 after the resume: result %+v, agent %+v", a.Result, ag)
	}
}

// ---- the result in the person's folder ----------------------------------------------------

// POST /api/runs/{id}/apply and GET /api/runs/{id}/delivery: what they refuse, and what they
// answer for a run without git, which has nothing to apply.
func TestRunApplyRefusalsAndNoGit(t *testing.T) {
	e := newRunEnv(t)
	e.refused(404, "no such run", "POST", "/api/runs/r_nope/apply", "")
	e.refused(404, "no such run", "GET", "/api/runs/r_nope/delivery", "")

	hold := make(chan struct{})
	e.plan(hold)
	v := e.newRun()
	e.refused(409, "the run has not started", "POST", "/api/runs/"+v.ID+"/apply", "")
	e.refused(409, "the run has not started", "GET", "/api/runs/"+v.ID+"/delivery", "")

	e.view(200, "POST", "/api/runs/"+v.ID+"/start", `{"goal":"Look around."}`)
	e.refused(409, "the run is still going: its result can be applied when it has ended or is stopped", "POST", "/api/runs/"+v.ID+"/apply", `{}`)
	e.refused(409, "the run is still going", "GET", "/api/runs/"+v.ID+"/delivery", "")
	e.expect(400, "POST", "/api/runs/"+v.ID+"/apply", `{"branch":5}`)
	e.expect(400, "POST", "/api/runs/"+v.ID+"/apply", `not json`)
	if d := e.detail(v.ID); d.Delivery != nil {
		t.Fatalf("a live run shows a delivery: %+v", d.Delivery)
	}
	close(hold)
	e.awaitRun(v.ID, "the run to complete", func(v model.RunView) bool { return v.Status == model.RunCompleted })

	const none = `{"state":"none","reason":"no_git"}`
	if got := strings.TrimSpace(e.expect(200, "GET", "/api/runs/"+v.ID+"/delivery", "")); got != none {
		t.Errorf("the dry run of a run without git: %s", got)
	}
	for _, body := range []string{"", `{}`, `{"branch":"main"}`} {
		if got := strings.TrimSpace(e.expect(200, "POST", "/api/runs/"+v.ID+"/apply", body)); got != none {
			t.Errorf("apply of a run without git with the body %q: %s", body, got)
		}
	}
	if d := e.detail(v.ID); d.Delivery == nil || d.Delivery.State != model.DeliveryNone || d.Delivery.Reason != "no_git" {
		t.Errorf("the detail's delivery: %+v", d.Delivery)
	}
	if got := e.view(200, "GET", "/api/runs/"+v.ID, ""); got.Delivery != model.DeliveryNone {
		t.Errorf("the view's delivery: %q", got.Delivery)
	}
	e.expect(200, "POST", "/api/runs/"+v.ID+"/archive", "")
	e.refused(409, "the run is archived", "POST", "/api/runs/"+v.ID+"/apply", "")
	if got := strings.TrimSpace(e.expect(200, "GET", "/api/runs/"+v.ID+"/delivery", "")); got != none {
		t.Errorf("the dry run of an archived run: %s", got)
	}
}

// planWriter is the script of a run with one writing task that writes made.txt; the turn that
// finds nothing left finishes the run.
func (e *runEnv) planWriter() {
	e.fake.Script(func(t *agenttest.Turn) {
		switch {
		case isOrchestrator(t) && strings.Contains(t.Text, "This is turn 1."):
			t.Call("set_notes", map[string]any{"notes": "Done means: made.txt exists with one line."})
			if text, isErr := t.Call("add_task", map[string]any{"title": "Write a file", "kind": "implement", "writes": true, "tier": "standard", "tier_reason": "A test task.",
				"brief": "Write the file made.txt with one line in it, in your working directory, change nothing else, and report what you wrote and where."}); isErr {
				t.Say("add_task was refused: " + text)
				return
			}
			t.Say("One task added.")
		case isOrchestrator(t) && strings.Contains(t.Text, "Nothing is running and nothing can start"):
			t.Call("finish_run", map[string]any{"outcome": "achieved", "summary": "The file exists."})
			t.Say("Finished.")
		case isOrchestrator(t):
			t.Say("Nothing to change.")
		default:
			if err := os.WriteFile(filepath.Join(t.Opts.Cwd, "made.txt"), []byte("made by the run\n"), 0o644); err != nil {
				t.Fail(err.Error())
				return
			}
			t.Say("Written.\n\n" + agenttest.Block("completed", "made.txt is written.", "One file."))
		}
	})
}

// A run in a git folder whose result is applied by hand (applyResult manual): pending at the end,
// the dry run says the apply would work and changes nothing, an apply that names the wrong
// branch is pending as an answer, and the apply brings the result into the folder.
func TestRunApplyRoutes(t *testing.T) {
	e := newRunEnv(t)
	repo := agenttest.NewRepo(t)
	repo.Write("README.md", "the project\n")
	base := repo.Commit("first")
	e.rs.GitEnv = repo.Env()
	e.planWriter()
	v := e.newRun()
	patched := e.view(200, "PATCH", "/api/runs/"+v.ID, fmt.Sprintf(`{"cwd":%q,"settings":{"applyResult":"manual"}}`, repo.Dir()))
	if !patched.Git || patched.Settings.ApplyResult != "manual" {
		t.Fatalf("the run in the repository: %+v", patched)
	}
	e.view(200, "POST", "/api/runs/"+v.ID+"/start", `{"goal":"Write a file."}`)
	done := e.awaitRun(v.ID, "the run to complete", func(v model.RunView) bool { return v.Status == model.RunCompleted })
	if done.Delivery != model.DeliveryPending {
		t.Fatalf("the view's delivery at the end: %q; turns %+v", done.Delivery, e.detail(v.ID).Turns)
	}
	d := e.detail(v.ID)
	result := d.Git.ResultHead
	if d.Delivery == nil || d.Delivery.State != model.DeliveryPending || d.Delivery.Reason != "manual" || d.Delivery.Result != result || result == base || d.Git.Branch != "main" {
		t.Fatalf("the detail at the end: delivery %+v, git %+v", d.Delivery, d.Git)
	}
	folder := func() string {
		return repo.Git("rev-parse", "HEAD") + "|" + repo.Git("status", "--porcelain") + "|" + repo.Git("for-each-ref") + "|" + repo.Git("worktree", "list")
	}
	before := folder()
	if _, err := os.Stat(filepath.Join(repo.Dir(), "made.txt")); err == nil || repo.Git("rev-parse", "HEAD") != base {
		t.Fatal("the folder changed before the result was applied")
	}

	// The dry run.
	want := fmt.Sprintf(`{"state":"pending","reason":"manual","result":%q,"branch":"main"}`, result)
	if got := strings.TrimSpace(e.expect(200, "GET", "/api/runs/"+v.ID+"/delivery", "")); got != want {
		t.Errorf("the dry run: %s, want %s", got, want)
	}
	if folder() != before || e.detail(v.ID).Version != d.Version {
		t.Error("the dry run changed the folder or the record")
	}

	// The apply.
	got := decode[model.RunDelivery](t, e.expect(200, "POST", "/api/runs/"+v.ID+"/apply", `{"branch":"main"}`))
	if got.State != model.DeliveryApplied || got.How != "ff" || got.Commit != result || got.Result != result || got.Branch != "main" || got.Auto || got.Partial || got.At == 0 {
		t.Fatalf("the apply: %+v", got)
	}
	if b, _ := os.ReadFile(filepath.Join(repo.Dir(), "made.txt")); string(b) != "made by the run\n" || repo.Git("rev-parse", "HEAD") != result || repo.Git("status", "--porcelain") != "" {
		t.Errorf("the folder after the apply: made.txt %q, status %q", b, repo.Git("status", "--porcelain"))
	}
	after := e.detail(v.ID)
	if after.Delivery == nil || after.Delivery.State != model.DeliveryApplied || after.Delivery.Commit != result || after.Version != d.Version+1 {
		t.Errorf("the detail after the apply: %+v (version %d, was %d)", after.Delivery, after.Version, d.Version)
	}
	if got := e.view(200, "GET", "/api/runs/"+v.ID, ""); got.Delivery != model.DeliveryApplied {
		t.Errorf("the view's delivery after the apply: %q", got.Delivery)
	}
	e.await("the run_detail event of the apply", func(evs []runTestEvent) bool {
		return slices.ContainsFunc(evs, func(ev runTestEvent) bool {
			return ev.Type == "run_detail" && strings.Contains(ev.Raw, `"delivery":{"state":"applied"`)
		})
	})
	if got := repo.Git("for-each-ref", "--format=%(refname:short)", "refs/heads"); got != "main" {
		t.Errorf("branches after the apply: %q", got)
	}
	// Again: the same answer, nothing written.
	again := decode[model.RunDelivery](t, e.expect(200, "POST", "/api/runs/"+v.ID+"/apply", ""))
	if again.State != model.DeliveryApplied || again.How != "ff" || again.At != got.At || e.detail(v.ID).Version != after.Version {
		t.Errorf("a second apply: %+v", again)
	}
}

// An apply that is not on the branch the run started on answers 200 with pending, other_branch:
// an outcome, not an error.
func TestRunApplyOnAnotherBranchIsAnAnswer(t *testing.T) {
	e := newRunEnv(t)
	repo := agenttest.NewRepo(t)
	repo.Write("README.md", "the project\n")
	repo.Commit("first")
	e.rs.GitEnv = repo.Env()
	e.planWriter()
	v := e.newRun()
	e.view(200, "PATCH", "/api/runs/"+v.ID, fmt.Sprintf(`{"cwd":%q,"settings":{"applyResult":"manual"}}`, repo.Dir()))
	e.view(200, "POST", "/api/runs/"+v.ID+"/start", `{"goal":"Write a file."}`)
	e.awaitRun(v.ID, "the run to complete", func(v model.RunView) bool { return v.Status == model.RunCompleted })
	repo.Git("checkout", "-q", "-b", "side")
	got := decode[model.RunDelivery](t, e.expect(200, "POST", "/api/runs/"+v.ID+"/apply", `{"branch":"main"}`))
	if got.State != model.DeliveryPending || got.Reason != "other_branch" || got.Branch != "side" {
		t.Fatalf("an apply that names the branch the folder is not on: %+v", got)
	}
	if dry := decode[model.RunDelivery](t, e.expect(200, "GET", "/api/runs/"+v.ID+"/delivery", "")); dry.State != model.DeliveryPending || dry.Reason != "other_branch" || dry.Branch != "side" {
		t.Errorf("the dry run on another branch: %+v", dry)
	}
	got = decode[model.RunDelivery](t, e.expect(200, "POST", "/api/runs/"+v.ID+"/apply", `{"branch":"side"}`))
	if got.State != model.DeliveryApplied || got.Branch != "side" || repo.Git("rev-parse", "side") != got.Commit || repo.Git("rev-parse", "main") == got.Commit {
		t.Errorf("the apply that names the folder's branch: %+v", got)
	}
}
