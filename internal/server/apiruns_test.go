package server

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/runs"
)

// The run routes on the remote listener: a server with the real run service and engine on
// scripted agents (newRunEnv), the real ServeRemote over TLS on 127.0.0.1, a page on loopback
// and the API clients X and Y. The page "A" is newRunEnv's own: its events tell when the run
// service has sent what it queued.

const (
	run1 = "r_aaaaaaa1"
	run2 = "r_bbbbbbb2"
	run3 = "r_ccccccc3"
)

// apiRunEnv is a runEnv with a remote listener, the run's mark wired to the bridge as main does.
type apiRunEnv struct {
	*runEnv
	l *listener
}

func newAPIRunEnv(t *testing.T) *apiRunEnv { return newAPIRunEnvOn(t, nil) }

// newAPIRunEnvOn is newAPIRunEnv with the run service on the clock given (nil is the wall clock).
func newAPIRunEnvOn(t *testing.T, clock runs.Clock) *apiRunEnv {
	t.Helper()
	l := newListener(t)
	e := newRunEnvOn(t, clock)
	e.rs.Mark = func(run, client string) { e.s.Bridge.SetMark(editorbridge.Run(run), client) }
	l.set(e.s)
	l.serve(e.s)
	return &apiRunEnv{runEnv: e, l: l}
}

// runStarted is the answer of a start call.
type runStarted struct {
	OK      bool           `json:"ok"`
	Started *bool          `json:"started"`
	Made    *bool          `json:"made"`
	Run     *model.RunView `json:"run"`
	Error   string         `json:"error"`
	Code    string         `json:"code"`
}

// runBody is the body of a start call for a Claude run; more adds or replaces fields, nil removes.
func runBody(cwd string, more ...any) string {
	body := map[string]any{"agent": "claude", "cwd": cwd, "goal": "Look around.",
		"tiers": obj{"deep": obj{"model": "opus"}, "standard": obj{"model": "opus"}, "light": obj{"model": "sonnet"}}}
	for i := 0; i+1 < len(more); i += 2 {
		if more[i+1] == nil {
			delete(body, more[i].(string))
			continue
		}
		body[more[i].(string)] = more[i+1]
	}
	raw, _ := json.Marshal(body)
	return string(raw)
}

// startRun is the start call of the client c for the run id, which must be answered with this
// status and code. Every answer has started and made; one that is not started has no run.
func startRun(t *testing.T, c *bridgetest.Page, id string, want int, code, body string) runStarted {
	t.Helper()
	status, out := c.Do("PUT", "/api/runs/"+id, body)
	return checkStarted(t, "the start call of "+c.ID+" for "+id, status, string(out), want, code)
}

func checkStarted(t *testing.T, what string, status int, out string, want int, code string) runStarted {
	t.Helper()
	if status != want {
		t.Fatalf("%s: status %d, want %d (%s)", what, status, want, out)
	}
	got := decode[runStarted](t, out)
	if got.Started == nil || got.Made == nil || (status == 200) != got.OK || (status == 200) != (got.Error == "") || got.Code != code {
		t.Fatalf("%s: status %d with %s, want the code %q", what, status, out, code)
	}
	if *got.Started != (got.Run != nil) || *got.Started != (status == 200) || (*got.Made && !*got.Started) {
		t.Fatalf("%s: started, made and run do not fit: %s", what, out)
	}
	return got
}

// defaults is the stored defaults as JSON, without what is stored for the group without.
func (e *apiRunEnv) defaults(without string) string {
	e.t.Helper()
	var raw []byte
	e.st.Read(func(s *model.State) { raw, _ = json.Marshal(s.Defaults) })
	m := decode[obj](e.t, string(raw))
	if g, ok := m["groups"].(obj); ok {
		delete(g, without)
	}
	out, _ := json.Marshal(m)
	return string(out)
}

// runFolders is the names in the data folder's runs folder.
func (e *apiRunEnv) runFolders() (names []string) {
	entries, _ := os.ReadDir(filepath.Join(e.a.DataDir, "runs"))
	for _, en := range entries {
		names = append(names, en.Name())
	}
	return names
}

// nothing fails unless the server has no run, no run folder and no group "Remote", and no client
// was sent anything.
func (e *apiRunEnv) nothing(what string, clients ...*bridgetest.Page) {
	e.t.Helper()
	if runs, folders, groups := e.rs.List(), e.runFolders(), e.remoteGroups(); len(runs) != 0 || len(folders) != 0 || len(groups) != 0 {
		e.t.Errorf("%s left %d runs, the folders %v and the groups %v", what, len(runs), folders, groups)
	}
	for i, evs := range e.reach(clients...) {
		if len(evs) != 0 {
			e.t.Errorf("%s: the client %s was sent %v", what, clients[i].ID, evs)
		}
	}
}

// versions is the versions of the run_detail events of the run among evs, in order.
func versions(evs []string, run string) (out []int) {
	for _, raw := range only(evs, "run_detail") {
		var ev struct {
			Run     string
			Version int
		}
		if json.Unmarshal([]byte(raw), &ev) == nil && ev.Run == run {
			out = append(out, ev.Version)
		}
	}
	return out
}

// ---- the start call (AC43) ------------------------------------------------------

// A start call over the TLS listener makes and starts the run with the given id; a repeat, at
// once too, does nothing; an id that is not the caller's is taken; the run goes to its end.
func TestRunStartCall(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	e.plan(nil)
	p := e.page("P")
	x, _ := e.l.api(apiX)
	y, _ := e.l.api(apiY)
	before := e.defaults("")

	got := startRun(t, x, run1, 200, "", runBody(e.cwd, "id", run1, "settings", obj{"maxTurns": 12}, "more", "an unknown field"))
	groups := e.remoteGroups()
	if !*got.Made || got.Run.ID != run1 || got.Run.Status == model.RunDraft || got.Run.Started.IsZero() ||
		got.Run.Cwd != e.cwd || got.Run.Settings.MaxTurns != 12 || got.Run.Settings.MaxParallel != model.DefaultRunSettings().MaxParallel ||
		got.Run.Name != "Look around" && got.Run.Name != "Look around." || len(groups) != 1 || got.Run.Group != groups[0] {
		t.Fatalf("the first start call: %+v; groups named Remote %v", got.Run, groups)
	}
	if mark, err := e.rs.ClientOf(run1); err != nil || mark != apiX {
		t.Fatalf("the run's mark: %q, %v", mark, err)
	}
	// A repeat with other values: the run as it is.
	again := startRun(t, x, run1, 200, "", runBody(t.TempDir(), "goal", "Something else.", "name", "Another", "userNamed", true))
	if *again.Made || again.Run.Cwd != e.cwd || again.Run.Name != got.Run.Name {
		t.Fatalf("the repeat: made %v, %+v", *again.Made, again.Run)
	}
	// Another client with the run's id, and the id of a draft of the owner.
	startRun(t, y, run1, 409, "id_taken", runBody(e.cwd))
	draft := e.newRun()
	startRun(t, x, draft.ID, 409, "id_taken", runBody(e.cwd))
	if v, err := e.rs.View(draft.ID); err != nil || v.Status != model.RunDraft {
		t.Fatalf("the owner's draft after a start call with its id: %+v, %v", v, err)
	}
	// The read of the run, by its client and by another.
	for _, c := range []*bridgetest.Page{x, y} {
		if v := decode[model.RunView](t, string(do(t, c, "GET", "/api/runs/"+run1, nil))); v.ID != run1 {
			t.Fatalf("the run as %s reads it: %+v", c.ID, v)
		}
	}

	// 24 calls at once with one id: one run.
	var wg sync.WaitGroup
	type answer struct {
		status int
		body   string
	}
	answers := make([]answer, 24)
	for i := range answers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, out := e.l.call(apiY, testSecret, "PUT", "/api/runs/"+run2, runBody(e.cwd))
			answers[i] = answer{status, out}
		}()
	}
	wg.Wait()
	made := 0
	for _, a := range answers {
		if got := checkStarted(t, "a call of 24", a.status, a.body, 200, ""); *got.Made {
			made++
		}
	}
	if made != 1 || len(e.rs.ViewsOf(apiY)) != 1 || len(e.rs.List()) != 3 || len(e.remoteGroups()) != 1 {
		t.Fatalf("24 calls at once: %d made, %d runs of Y, %d runs, groups %v", made, len(e.rs.ViewsOf(apiY)), len(e.rs.List()), e.remoteGroups())
	}
	if v, _ := e.rs.View(run2); v.Group != groups[0] {
		t.Fatalf("the second client's run is in the group %q, want %q", v.Group, groups[0])
	}

	// Both runs go to their end, and a repeat after the end still answers started.
	for _, id := range []string{run1, run2} {
		e.awaitRun(id, "to complete", func(v model.RunView) bool { return v.Status == model.RunCompleted })
	}
	if end := startRun(t, x, run1, 200, "", runBody(e.cwd)); *end.Made || end.Run.Status != model.RunCompleted {
		t.Fatalf("the repeat after the end: %+v", end.Run)
	}
	// Events: the page was told of every run and of the group; each client of its own run only.
	evs := e.reach(p, x, y)
	ps, xs, ys := evs[0], evs[1], evs[2]
	if count(ps, "run", run1) == 0 || count(ps, "run", run2) == 0 || count(ps, "groups") == 0 {
		t.Errorf("the page was sent %v", types(ps))
	}
	if count(xs, "run", run1) == 0 || count(xs, "run", run2) != 0 || count(xs, "run", draft.ID) != 0 ||
		count(ys, "run", run2) == 0 || count(ys, "run", run1) != 0 || count(ys, "run", draft.ID) != 0 {
		t.Errorf("X was sent %v, Y %v", types(xs), types(ys))
	}
	for i, c := range []*bridgetest.Page{x, y} {
		apiOnly(t, c, evs[i+1])
		if n := count(evs[i+1], "groups") + count(evs[i+1], "defaults") + count(evs[i+1], "run_detail") + count(evs[i+1], "run_activity"); n != 0 {
			t.Errorf("%s, which read no detail, was sent %v", c.ID, types(evs[i+1]))
		}
	}
	// No defaults but the new group's seed.
	if after := e.defaults(groups[0]); after != before {
		t.Errorf("the defaults changed:\nbefore %s\nafter  %s", before, after)
	}
}

// Each refusal of the start call has its status and code, and leaves nothing: no run, no folder,
// no group and no event on any stream.
func TestRunStartCallRefusals(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	e.plan(nil)
	p := e.page("P")
	x, _ := e.l.api(apiX)
	y, _ := e.l.api(apiY)
	before := e.defaults("")
	file := filepath.Join(e.cwd, "a-file")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	empty := agenttest.NewRepo(t) // a repository with no commit
	long := strings.Repeat("n", 81)

	// Ids of other forms in the path.
	for _, id := range []string{"R_AAAAAAA1", "r_AAAAAAA1", "r_aaaaaaa", "r_aaaaaaaa1", "c_aaaaaaa1", "r_aaa.aaa1", "r_aaa%20aaa1",
		"7c9e6679-7425-40de-944b-e07fc1f90ae7", "..%2F..%2Fetc", "r_aaa%2Faaa1", "check", "r_"} {
		status, out := x.Do("PUT", "/api/runs/"+id, runBody(e.cwd))
		checkStarted(t, "the start call with the id "+id, status, string(out), 400, "bad_id")
		e.nothing("the id "+id, p, x, y)
	}
	for _, c := range []struct {
		name   string
		status int
		code   string
		body   string
	}{
		{"a body id that is not the path's", 400, "bad_id", runBody(e.cwd, "id", run2)},
		{"JSON that cannot be read", 400, "bad_request", `{"agent":`},
		{"no agent", 400, "bad_request", runBody(e.cwd, "agent", nil)},
		{"no folder", 400, "bad_request", runBody(e.cwd, "cwd", nil)},
		{"a blank folder", 400, "bad_request", runBody("  ")},
		{"no goal", 400, "bad_request", runBody(e.cwd, "goal", nil)},
		{"a blank goal", 400, "bad_request", runBody(e.cwd, "goal", " \n\t")},
		{"a group", 400, "group_refused", runBody(e.cwd, "group", model.Ungrouped)},
		{"an unknown agent kind", 400, "", runBody(e.cwd, "agent", "gpt")},
		{"a setting out of range", 400, "", runBody(e.cwd, "settings", obj{"maxParallel": 17})},
		{"a name of the user's that is too long", 400, "", runBody(e.cwd, "name", long, "userNamed", true)},
		{"a folder inside the data folder", 400, "", runBody(e.a.DataDir)},
		{"a tier without a model", 400, "bad_choice", runBody(e.cwd, "tiers", obj{"deep": obj{"model": "opus"}, "standard": obj{}, "light": obj{"model": "sonnet"}})},
		{"no tiers", 400, "bad_choice", runBody(e.cwd, "tiers", nil)},
		{"a model the catalog lacks", 400, "bad_choice", runBody(e.cwd, "tiers", obj{"deep": obj{"model": "opus"}, "standard": obj{"model": "opus"}, "light": obj{"model": "nope"}})},
		{"a missing folder", 409, "folder_missing", runBody(filepath.Join(e.cwd, "gone"))},
		{"a file as the folder", 409, "folder_missing", runBody(file)},
		{"a repository with no commit", 409, "blocked", runBody(empty.Dir())},
	} {
		got := startRun(t, x, run1, c.status, c.code, c.body)
		if got.Error == "" {
			t.Errorf("%s: no error text", c.name)
		}
		e.nothing(c.name, p, x, y)
		if status, out := x.Do("GET", "/api/runs/"+run1, nil); status != 404 {
			t.Errorf("%s: the read of the run afterwards: %d %s", c.name, status, out)
		}
	}
	if after := e.defaults(""); after != before {
		t.Errorf("the defaults changed:\nbefore %s\nafter  %s", before, after)
	}
	if st := decode[obj](t, e.expect(200, "GET", "/api/state", "")); len(st["runs"].([]any)) != 0 {
		t.Errorf("the page's state lists runs: %v", st["runs"])
	}

	// A write that fails: 500, and no run. The group is asked for before the first write.
	if os.Getuid() == 0 {
		return
	}
	dir := filepath.Join(e.a.DataDir, "runs")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	startRun(t, x, run1, 500, "", runBody(e.cwd))
	if len(e.rs.List()) != 0 || len(e.runFolders()) != 0 {
		t.Errorf("a failed write left the runs %v and the folders %v", e.rs.List(), e.runFolders())
	}
	os.Chmod(dir, 0o700)
	if got := startRun(t, x, run1, 200, "", runBody(e.cwd)); !*got.Made {
		t.Errorf("the start call after the failed one made nothing")
	}
	e.awaitRun(run1, "to complete", func(v model.RunView) bool { return v.Status == model.RunCompleted })
}

// AC44, the start-call clause: an agent whose program is not found refuses the start call with
// the sentence that names the program; once the program is there the same call starts the run.
func TestRunStartCallAgentMissing(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	e.plan(nil)
	agents, path := agentsOf("cursor")
	e.rs.Agents = agents
	x, _ := e.l.api(apiX)
	got := startRun(t, x, run1, 409, "agent_missing", runBody(e.cwd))
	if !strings.Contains(got.Error, "claude") {
		t.Errorf("the refusal does not name the program: %q", got.Error)
	}
	e.nothing("the start call with a missing agent", x)
	path.set("cursor", "claude")
	if got := startRun(t, x, run1, 200, "", runBody(e.cwd)); !*got.Made {
		t.Fatalf("the start call after the program was found: %+v", got)
	}
	e.awaitRun(run1, "to complete", func(v model.RunView) bool { return v.Status == model.RunCompleted })
}

// ---- the routes and the two listeners -------------------------------------------

// The start call and the draft check are not there on loopback; a run's plain creation, today's
// start route and the draft route are not there on the remote listener.
func TestRunRoutesOfOneListenerOnly(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	e.plan(nil)
	x, _ := e.l.api(apiX)
	const gate = `{"error":"not found"}`
	for _, rq := range [][3]string{{"PUT", "/api/runs/" + run1, runBody(e.cwd)}, {"GET", "/api/runs/check?agent=claude&cwd=" + e.cwd, ""}} {
		if out := e.expect(404, rq[0], rq[1], rq[2]); strings.TrimSpace(out) != gate {
			t.Errorf("%s %s on loopback: %s", rq[0], rq[1], out)
		}
	}
	draft := e.newRun()
	for _, rq := range [][3]string{
		{"POST", "/api/runs", `{"group":"` + model.Ungrouped + `"}`},
		{"POST", "/api/runs/" + draft.ID + "/start", `{"goal":"Look around."}`},
		{"PUT", "/api/runs/" + draft.ID + "/draft", `{"text":"a goal"}`},
		{"GET", "/api/runs", ""},
	} {
		if status, out := x.Do(rq[0], rq[1], rq[2]); status != 404 || strings.TrimSpace(string(out)) != gate {
			t.Errorf("%s %s on the remote listener: %d %s", rq[0], rq[1], status, out)
		}
	}
	if got := e.rs.Views(); len(got) != 1 || got[0].Status != model.RunDraft || len(e.runFolders()) != 1 {
		t.Fatalf("the runs afterwards: %+v", got)
	}
}

// Every run route of the table serves an API client, on its own run and on one it did not make.
func TestRunTableRoutesServeAnAPIClient(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	e.plan(nil)
	x, _ := e.l.api(apiX)
	y, _ := e.l.api(apiY)
	startRun(t, x, run1, 200, "", runBody(e.cwd))
	e.awaitRun(run1, "to complete", func(v model.RunView) bool { return v.Status == model.RunCompleted })
	called := map[string]bool{"PUT /api/runs/{id}": true}
	task := e.detail(run1).Tasks[0].ID
	// call asks for the route as the client c and returns the status and the answer.
	call := func(c *bridgetest.Page, route string, body any) (int, obj) {
		t.Helper()
		if !slices.Contains(RemoteRoutes, route) {
			t.Fatalf("%s is no route of the table", route)
		}
		called[route] = true
		method, path, _ := strings.Cut(route, " ")
		for _, kv := range [][2]string{{"{id}", run1}, {"{tid}", task}, {"{n}", "1"}, {"{v}", "1"}} {
			path = strings.Replace(path, kv[0], kv[1], 1)
		}
		if route == "GET /api/runs/check" {
			path += "?agent=claude&cwd=" + e.cwd
		}
		status, out := c.Do(method, path, body)
		if strings.TrimSpace(string(out)) == `{"error":"not found"}` {
			t.Fatalf("%s: the gate's answer", route)
		}
		return status, decode[obj](t, string(out))
	}
	want := func(c *bridgetest.Page, route string, body any, status int) obj {
		t.Helper()
		got, out := call(c, route, body)
		if got != status {
			t.Fatalf("%s as %s: status %d, want %d (%v)", route, c.ID, got, status, out)
		}
		return out
	}
	for _, c := range []*bridgetest.Page{x, y} { // Y did not make the run
		if got := want(c, "GET /api/runs/{id}", nil, 200); got["id"] != run1 || got["status"] != "completed" {
			t.Fatalf("the run: %v", got)
		}
		if got := want(c, "GET /api/runs/{id}/detail", nil, 200); got["run"] != run1 || len(got["tasks"].([]any)) != 1 {
			t.Fatalf("the detail: %v", got)
		}
		if got := want(c, "GET /api/runs/{id}/goal", nil, 200); !strings.Contains(fmt.Sprint(got), "Look around.") {
			t.Fatalf("the goal: %v", got)
		}
		if got := want(c, "GET /api/runs/{id}/tasks/{tid}/brief", nil, 200); !strings.Contains(fmt.Sprint(got), "Look at the folder") {
			t.Fatalf("the brief: %v", got)
		}
		if got := want(c, "GET /api/runs/{id}/tasks/{tid}/attempts/{n}/report", nil, 200); !strings.Contains(fmt.Sprint(got), "Nothing is in the folder.") {
			t.Fatalf("the report: %v", got)
		}
		if got := want(c, "GET /api/runs/{id}/notes/{v}", nil, 200); !strings.Contains(fmt.Sprint(got), "Done means") {
			t.Fatalf("the notes: %v", got)
		}
		call(c, "GET /api/runs/{id}/tasks/{tid}/attempts/{n}/changes", nil) // a run without git has none
		want(c, "GET /api/runs/{id}/delivery", nil, 200)
		want(c, "GET /api/runs/check", nil, 200)
	}
	if got := e.s.Bridge.Followers(editorbridge.Run(run1)); !slices.Contains(got, apiX) || !slices.Contains(got, apiY) {
		t.Fatalf("the followers of the run after the reads of its detail: %v", got)
	}
	want(y, "POST /api/runs/{id}/unfollow", nil, 200)
	if got := e.s.Bridge.Followers(editorbridge.Run(run1)); !slices.Contains(got, apiX) || slices.Contains(got, apiY) {
		t.Fatalf("the followers of the run after Y's unfollow: %v", got)
	}
	// What a finished run refuses, with today's statuses.
	want(x, "POST /api/runs/{id}/stop", nil, 409)
	want(x, "POST /api/runs/{id}/resume", nil, 409)
	call(x, "POST /api/runs/{id}/apply", nil)
	if got := want(y, "PATCH /api/runs/{id}", obj{"name": "By another client"}, 200); got["name"] != "By another client" {
		t.Fatalf("the rename: %v", got)
	}
	want(x, "POST /api/runs/{id}/archive", nil, 200)
	if v, _ := e.rs.View(run1); !v.Archived {
		t.Fatal("the run is not archived")
	}
	want(x, "POST /api/runs/{id}/unarchive", nil, 200)
	e.reach(x, y)
	want(y, "DELETE /api/runs/{id}", nil, 200)
	if _, err := e.rs.View(run1); err == nil {
		t.Fatal("the run is still there after the delete")
	}
	// The removal is told to the client with the mark, and not to the one that deleted it.
	xs := upTo(t, x, "run_removed", run1)
	if evs := e.reach(x, y); count(append(xs, evs[0]...), "run_removed", run1) != 1 || count(evs[1], "run_removed") != 0 {
		t.Errorf("after the delete X was sent %v, Y %v", types(append(xs, evs[0]...)), types(evs[1]))
	}
	// A run that is not there: each handler's own 404.
	if status, out := call(x, "GET /api/runs/{id}", nil); status != 404 {
		t.Errorf("the read of a deleted run: %d %v", status, out)
	}
	for _, route := range RemoteRoutes {
		if strings.Contains(route, " /api/runs/") && !called[route] {
			t.Errorf("the route %s of the table was not called", route)
		}
	}
}

// ---- the rename-only patch and the defaults (AC43) -------------------------------

// A patch from the remote listener changes the name alone; a start call, a rename, a stop and a
// resume record no defaults.
func TestRunRenameOnlyAndNoDefaults(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	e.fake.Script(func(t *agenttest.Turn) { t.Say("Looking."); t.Hang() })
	p := e.page("P")
	x, _ := e.l.api(apiX)
	y, _ := e.l.api(apiY)
	before := e.defaults("")
	startRun(t, x, run1, 200, "", runBody(e.cwd))
	group := e.remoteGroups()[0]
	seeded := e.defaults("")
	if e.defaults(group) != before {
		t.Fatalf("the defaults after the start call:\nbefore %s\nafter  %s", before, seeded)
	}
	e.awaitRun(run1, "to run", func(v model.RunView) bool { return v.Status == model.RunRunning })
	path := "/api/runs/" + run1
	was, _ := e.rs.View(run1)
	e.reach(p, x, y)
	for _, body := range []string{
		`{"group":"` + model.Ungrouped + `"}`, `{"agent":"cursor"}`, `{"tiers":{"deep":{"model":"sonnet"}}}`, `{"cwd":"/tmp"}`,
		`{"settings":{"maxTurns":3}}`, `{"other":1}`, `{}`, `{"name":"A name","group":"` + model.Ungrouped + `"}`,
		`{"name":"A name","other":1}`, `{"Name":"A name"}`, `{"name":null}`, `{"name":7}`,
	} {
		status, out := x.Do("PATCH", path, body)
		if got := decode[refusal](t, string(out)); status != 400 || got.Code != "rename_only" || got.Error != "only a run's name can be changed from another server" {
			t.Errorf("the patch %s: %d %s", body, status, out)
		}
	}
	if status, out := x.Do("PATCH", path, `[`); status != 400 {
		t.Errorf("a patch that is no JSON: %d %s", status, out)
	}
	if now, _ := e.rs.View(run1); now.Name != was.Name || now.Group != was.Group || now.Agent != was.Agent || now.Cwd != was.Cwd ||
		now.Tiers != was.Tiers || now.Settings != was.Settings {
		t.Fatalf("the run after the refused patches: %+v, was %+v", now, was)
	}
	for _, evs := range e.reach(p, x, y) {
		for _, raw := range only(evs, "run") {
			if v := decode[struct{ Run model.RunView }](t, raw).Run; v.Name != was.Name || v.Group != was.Group || v.Cwd != was.Cwd {
				t.Errorf("a refused patch sent the run as %+v", v)
			}
		}
	}
	// The name alone: the page and the client with the mark are told.
	if v := decode[model.RunView](t, string(do(t, x, "PATCH", path, `{"name":"Renamed from afar"}`))); v.Name != "Renamed from afar" || !v.UserNamed {
		t.Fatalf("the rename: %+v", v)
	}
	e.awaitRun(run1, "to be renamed", func(v model.RunView) bool { return v.Name == "Renamed from afar" })
	evs := e.reach(p, x, y)
	if count(evs[0], "run", "Renamed from afar") == 0 || count(evs[1], "run", "Renamed from afar") == 0 || len(evs[2]) != 0 {
		t.Errorf("after the rename the page was sent %v, X %v, Y %v", types(evs[0]), types(evs[1]), evs[2])
	}
	// A stop and a resume by the client.
	if v := decode[model.RunView](t, string(do(t, x, "POST", path+"/stop", nil))); v.ID != run1 {
		t.Fatalf("the stop: %+v", v)
	}
	e.awaitRun(run1, "to stop", func(v model.RunView) bool { return v.Status == model.RunStopped })
	if v := decode[model.RunView](t, string(do(t, x, "POST", path+"/resume", nil))); v.Status != model.RunRunning {
		t.Fatalf("the resume: %+v", v)
	}
	if after := e.defaults(""); after != seeded {
		t.Errorf("the defaults after a rename, a stop and a resume:\nbefore %s\nafter  %s", seeded, after)
	}
	// The page's patch is as it was: the owner moves the run, which keeps its mark.
	if v := e.view(200, "PATCH", path, `{"group":"`+model.Ungrouped+`"}`); v.Group != model.Ungrouped {
		t.Fatalf("the owner's move: %+v", v)
	}
	if mark, _ := e.rs.ClientOf(run1); mark != apiX {
		t.Fatalf("the mark after the move: %q", mark)
	}
	if after := e.defaults(""); after != seeded {
		t.Errorf("the defaults after the owner's move:\nbefore %s\nafter  %s", seeded, after)
	}
	do(t, x, "POST", path+"/stop", nil)
	e.awaitRun(run1, "to stop again", func(v model.RunView) bool { return v.Status == model.RunStopped })
}

// ---- the draft check --------------------------------------------------------------

func TestRunDraftCheckRoute(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	p := e.page("P")
	x, _ := e.l.api(apiX)
	before := e.defaults("")
	repo := agenttest.NewRepo(t)
	repo.Write("a.txt", "one")
	repo.Commit("a file")
	clean := decode[obj](t, string(do(t, x, "GET", "/api/runs/check?agent=claude&cwd="+repo.Dir(), nil)))
	repo.Write("b.txt", "untracked")
	empty := agenttest.NewRepo(t)
	named := filepath.Join(t.TempDir(), filepath.Base(e.a.DataDir), "work")
	if err := os.MkdirAll(named, 0o755); err != nil {
		t.Fatal(err)
	}
	if clean["git"] != true || clean["dirty"] != false || clean["blocked"] != "" || clean["cwd"] != repo.Dir() {
		t.Errorf("a clean repository: %v", clean)
	}
	for _, c := range []struct {
		name, agent, cwd string
		missing, git     bool
		dirty            bool
		blocked          string // part of the sentence; "" = nothing blocks
	}{
		{"a repository with an untracked file", "claude", repo.Dir(), false, true, true, ""},
		{"a plain folder", "claude", e.cwd, false, false, false, ""},
		{"a missing folder", "claude", filepath.Join(e.cwd, "gone"), true, false, false, ""},
		{"a repository with no commit", "claude", empty.Dir(), false, true, false, "commit"},
		{"no agent", "", e.cwd, false, false, false, "agent"},
		{"the data folder's name in the path", "claude", named, false, false, false, "folder"},
	} {
		status, out := x.Do("GET", "/api/runs/check?agent="+c.agent+"&cwd="+c.cwd, nil)
		if status != 200 {
			t.Fatalf("%s: %d %s", c.name, status, out)
		}
		if keys := keysOf(t, string(out)); !slices.Equal(keys, []string{"blocked", "cwd", "dirty", "folderMissing", "git"}) {
			t.Errorf("%s: the fields %v", c.name, keys)
		}
		got := decode[struct {
			Cwd, Blocked              string
			FolderMissing, Git, Dirty bool
		}](t, string(out))
		if got.FolderMissing != c.missing || got.Git != c.git || got.Dirty != c.dirty || (got.Blocked != "") != (c.blocked != "") ||
			!strings.Contains(got.Blocked, c.blocked) || got.Cwd == "" || filepath.Base(got.Cwd) != filepath.Base(c.cwd) {
			t.Errorf("%s: %s", c.name, out)
		}
	}
	for _, q := range []string{"agent=claude", "agent=claude&cwd=%20", "agent=gpt&cwd=" + e.cwd, ""} {
		status, out := x.Do("GET", "/api/runs/check?"+q, nil)
		if got := decode[refusal](t, string(out)); status != 400 || got.Code != "bad_request" || got.Error == "" {
			t.Errorf("the draft check with %q: %d %s", q, status, out)
		}
	}
	e.nothing("the draft checks", p, x)
	if after := e.defaults(""); after != before {
		t.Errorf("the defaults changed:\nbefore %s\nafter  %s", before, after)
	}
}

// ---- the group "Remote" (AC45) ----------------------------------------------------

// The first start call makes the group "Remote" at the top level, and the runs of both clients
// sit in it. The page is told of the group; no API client is.
func TestRunsOfAPIClientsSitInTheRemoteGroup(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	e.fake.Script(func(t *agenttest.Turn) { t.Say("Looking."); t.Hang() })
	p := e.page("P")
	x, _ := e.l.api(apiX)
	y, _ := e.l.api(apiY)
	startRun(t, x, run1, 409, "folder_missing", runBody(filepath.Join(e.cwd, "gone")))
	e.nothing("a refused start call", p, x, y)
	one := startRun(t, x, run1, 200, "", runBody(e.cwd))
	two := startRun(t, y, run2, 200, "", runBody(e.cwd))
	groups := e.remoteGroups()
	if len(groups) != 1 || one.Run.Group != groups[0] || two.Run.Group != groups[0] {
		t.Fatalf("the groups named Remote %v; the runs are in %q and %q", groups, one.Run.Group, two.Run.Group)
	}
	for _, id := range []string{run1, run2} {
		e.awaitRun(id, "to run", func(v model.RunView) bool { return v.Status == model.RunRunning })
	}
	evs := e.reach(p, x, y)
	if count(evs[0], "groups", groups[0]) != 1 || count(evs[0], "run", run1) == 0 || count(evs[0], "run", run2) == 0 {
		t.Errorf("the page was sent %v", types(evs[0]))
	}
	for i, c := range []*bridgetest.Page{x, y} {
		apiOnly(t, c, evs[i+1])
		if n := count(evs[i+1], "groups") + count(evs[i+1], "defaults"); n != 0 {
			t.Errorf("%s was sent %v", c.ID, types(evs[i+1]))
		}
	}
	// The page's state: one top-level group "Remote" with both runs, none ungrouped.
	st := decode[struct {
		Groups []model.Group
		Runs   []model.RunView
	}](t, e.expect(200, "GET", "/api/state", ""))
	i := slices.IndexFunc(st.Groups, func(g model.Group) bool { return g.ID == groups[0] })
	if i < 0 || st.Groups[i].Name != "Remote" || st.Groups[i].Parent != "" || len(st.Runs) != 2 || st.Runs[0].Group != groups[0] || st.Runs[1].Group != groups[0] {
		t.Fatalf("the page's state: groups %+v, runs %+v", st.Groups, st.Runs)
	}
	// An API client's state has no groups. Its runs are read from the service: the snapshot's
	// "runs" is filled by another task.
	for _, c := range []*bridgetest.Page{x, y} {
		if keys := keysOf(t, string(do(t, c, "GET", "/api/state", nil))); slices.Contains(keys, "groups") || slices.Contains(keys, "defaults") {
			t.Errorf("the state of %s has the keys %v", c.ID, keys)
		}
	}
	if xs, ys := e.rs.ViewsOf(apiX), e.rs.ViewsOf(apiY); len(xs) != 1 || xs[0].ID != run1 || len(ys) != 1 || ys[0].ID != run2 {
		t.Fatalf("the runs by mark: X %+v, Y %+v", xs, ys)
	}
	startRun(t, x, run3, 400, "group_refused", runBody(e.cwd, "group", groups[0]))
	if len(e.rs.List()) != 2 {
		t.Fatalf("a start call with a group made a run")
	}
}

// ---- the events of a run (AC41) ---------------------------------------------------

// stepper is a script whose orchestrator sets the notes and speaks once per step; any other
// agent speaks and waits.
type stepper struct {
	t    *testing.T
	e    *apiRunEnv
	gate chan struct{}
	did  chan struct{}
	n    int
}

func newStepper(t *testing.T, e *apiRunEnv) *stepper {
	s := &stepper{t: t, e: e, gate: make(chan struct{}), did: make(chan struct{}, 64)}
	e.fake.Script(func(turn *agenttest.Turn) {
		if !isOrchestrator(turn) {
			turn.Say("At work.")
			turn.Hang()
			return
		}
		turn.Say("Started.")
		for i := 1; ; i++ {
			select {
			case <-s.gate:
			case <-turn.Interrupted():
				return
			}
			turn.Call("set_notes", map[string]any{"notes": fmt.Sprintf("The notes, step %d.", i)})
			turn.Say(fmt.Sprintf("said %d", i))
			s.did <- struct{}{}
		}
	})
	return s
}

// step lets the orchestrator do one step, and returns when the page A, which follows the run,
// was sent the run_detail of the detail's version after the step: what the run service queued
// up to it is sent to everyone.
func (s *stepper) step(run string) string {
	s.t.Helper()
	select {
	case s.gate <- struct{}{}:
	case <-time.After(20 * time.Second):
		s.t.Fatal("the orchestrator did not take the step")
	}
	select {
	case <-s.did:
	case <-time.After(20 * time.Second):
		s.t.Fatal("the orchestrator did not end the step")
	}
	s.n++
	d, err := s.e.rs.Detail(run)
	if err != nil {
		s.t.Fatal(err)
	}
	s.e.await("the run_detail of the step", func(evs []runTestEvent) bool { return slices.Contains(versions(rawOf(evs), run), int(d.Version)) })
	return fmt.Sprintf("said %d", s.n)
}

func rawOf(evs []runTestEvent) []string {
	out := make([]string, len(evs))
	for i, ev := range evs {
		out[i] = ev.Raw
	}
	return out
}

// gone waits until the client no longer follows the run: the server noticed its stream's end.
func (e *apiRunEnv) gone(client, run string) {
	e.t.Helper()
	for deadline := time.Now().Add(5 * time.Second); slices.Contains(e.s.Bridge.Followers(editorbridge.Run(run)), client); {
		if time.Now().After(deadline) {
			e.t.Fatalf("%s still follows %s", client, run)
		}
		time.Sleep(time.Millisecond)
	}
}

// run and run_removed go to the pages and to the client with the mark; run_detail and
// run_activity to who read the detail; the events of a run agent's chat to who read that chat.
func TestRunEventsOfAnAPIClient(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	st := newStepper(t, e)
	p := e.page("P")
	x, _ := e.l.api(apiX)
	y, _ := e.l.api(apiY)
	content := []string{"run_detail", "run_activity"}
	none := func(what string, evs []string, typs ...string) {
		t.Helper()
		if got := only(evs, typs...); len(got) != 0 {
			t.Errorf("%s: sent %v", what, got)
		}
	}

	startRun(t, x, run1, 200, "", runBody(e.cwd))
	e.awaitRun(run1, "to run", func(v model.RunView) bool { return v.Status == model.RunRunning })
	detail := e.detail(run1) // the page A follows the run
	// The run is running a moment before its first turn is recorded.
	for deadline := time.Now().Add(10 * time.Second); len(detail.Turns) == 0 && time.Now().Before(deadline); detail = e.detail(run1) {
		time.Sleep(time.Millisecond)
	}
	if detail.Version < 1 || len(detail.Turns) != 1 {
		t.Fatalf("the detail after the start: %+v", detail)
	}
	orch := detail.Turns[0].Agent
	evs := e.reach(p, x, y)
	if count(evs[0], "run", run1, `"status":"running"`) == 0 || count(evs[1], "run", run1, `"status":"running"`) == 0 || len(evs[2]) != 0 {
		t.Errorf("at the start the page was sent %v, X %v, Y %v", types(evs[0]), types(evs[1]), evs[2])
	}
	none("the page P, which read no detail", evs[0], content...)
	none("X before its read of the detail", evs[1], content...)

	// Nobody but the page A follows: a step reaches no API client.
	st.step(run1)
	evs = e.reach(x, y)
	none("X before its read of the detail", evs[0], content...)
	if len(evs[1]) != 0 {
		t.Errorf("Y was sent %v", evs[1])
	}
	// Y reads the detail and the agent's chat: it follows both, with no mark on either.
	dy := decode[model.RunDetail](t, string(do(t, y, "GET", "/api/runs/"+run1+"/detail", nil)))
	do(t, y, "GET", "/api/chats/"+orch+"/items", nil)
	e.expect(200, "GET", "/api/chats/"+orch+"/items", "") // the page A too
	said := st.step(run1)
	ys := upTo(t, y, "chat_items", orch, said)
	e.await("the agent's chat_items at the page", func(evs []runTestEvent) bool {
		return count(rawOf(evs), "chat_items", orch, said) != 0
	})
	evs = e.reach(x, y, p)
	evs[1] = append(ys, evs[1]...)
	none("X before its read of the detail", evs[0], content...)
	none("X, which has the run's mark and did not read the agent's chat", evs[0], "chat", "branch_state", "chat_items", "tree")
	none("the page P, which read neither", evs[2], append(content, "chat_items", "tree")...)
	yv := versions(evs[1], run1)
	if len(yv) == 0 || yv[0] != int(dy.Version)+1 {
		t.Errorf("Y read the detail at version %d and was then sent the versions %v", dy.Version, yv)
	}
	none("Y, which has no mark", evs[1], "run", "run_removed")

	// X reads the detail: from then on both get the same versions in the same order.
	dx := decode[model.RunDetail](t, string(do(t, x, "GET", "/api/runs/"+run1+"/detail", nil)))
	st.step(run1)
	st.step(run1)
	evs = e.reach(x, y)
	xv, yv := versions(evs[0], run1), versions(evs[1], run1)
	if len(xv) < 2 || xv[0] != int(dx.Version)+1 || !slices.IsSorted(xv) || len(yv) < len(xv) || !slices.Equal(yv[len(yv)-len(xv):], xv) {
		t.Errorf("X read the detail at version %d; X was sent the versions %v, Y %v", dx.Version, xv, yv)
	}
	if ax, ay := only(evs[0], "run_activity"), only(evs[1], "run_activity"); len(ay) < len(ax) || !slices.Equal(ay[len(ay)-len(ax):], ax) {
		t.Errorf("the run_activity events of the two followers differ:\nX %v\nY %v", ax, ay)
	}
	apiOnly(t, x, evs[0])
	apiOnly(t, y, evs[1])

	// A new stream of Y follows nothing until the detail is read again.
	y.Close()
	e.gone(apiY, run1)
	y, _ = e.l.api(apiY)
	st.step(run1)
	evs = e.reach(x, y)
	if len(versions(evs[0], run1)) == 0 || len(evs[1]) != 0 {
		t.Errorf("after Y's new stream X was sent the versions %v, Y %v", versions(evs[0], run1), evs[1])
	}
	do(t, y, "GET", "/api/runs/"+run1+"/detail", nil)
	st.step(run1)
	evs = e.reach(x, y)
	if len(versions(evs[1], run1)) == 0 || !slices.Equal(versions(evs[0], run1), versions(evs[1], run1)) {
		t.Errorf("after Y's second read X was sent the versions %v, Y %v", versions(evs[0], run1), versions(evs[1], run1))
	}
	// After X's unfollow, no more for X.
	do(t, x, "POST", "/api/runs/"+run1+"/unfollow", nil)
	e.reach(x, y)
	st.step(run1)
	evs = e.reach(x, y)
	none("X after its unfollow", evs[0], content...)
	if len(versions(evs[1], run1)) == 0 {
		t.Errorf("Y, which still follows, was sent %v", types(evs[1]))
	}

	// The owner deletes the run: the pages and the client with the mark are told, the follower
	// without the mark is not.
	e.expect(200, "DELETE", "/api/runs/"+run1, "")
	ps := upTo(t, p, "run_removed", run1)
	xs := upTo(t, x, "run_removed", run1)
	evs = e.reach(p, x, y)
	if count(append(ps, evs[0]...), "run_removed", run1) != 1 || count(append(xs, evs[1]...), "run_removed", run1) != 1 {
		t.Errorf("after the delete the page was sent %v, X %v", types(append(ps, evs[0]...)), types(append(xs, evs[1]...)))
	}
	none("Y, a follower without the mark, at the delete", evs[2], "run_removed", "run")
	quiet(t, "after the delete", y)
	if got := e.s.Bridge.Followers(editorbridge.Run(run1)); len(got) != 0 {
		t.Errorf("the followers of the removed run: %v", got)
	}
}

// ---- beside a page, and a chat on the run (AC13, 2.7) ------------------------------

// A page holds a board and follows the chat of a run's agent. An API client connects, starts a
// run, makes a chat on it with a first message and stops that chat: the page keeps its board and
// its events. The creation call that names a run puts the chat on the run.
func TestAPIClientsRunBesideAPage(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	said, next := make(chan struct{}, 8), make(chan struct{})
	e.fake.Script(func(t *agenttest.Turn) {
		if !isOrchestrator(t) {
			t.Say("At work.")
			t.Hang()
			return
		}
		t.Say("first")
		said <- struct{}{}
		select {
		case <-next:
		case <-t.Interrupted():
			return
		}
		t.Say("second")
		t.Hang()
	})
	p := e.page("P")
	bd, _ := e.boardChat(p) // the page made the board, so it holds it
	_, rev := take(t, p, bd.ID, false)
	written(t, p, bd.ID, rev, drawing("one"))
	own := e.newRun()
	e.view(200, "POST", "/api/runs/"+own.ID+"/start", `{"goal":"Look around."}`)
	<-said
	orch := decode[model.RunDetail](t, string(do(t, p, "GET", "/api/runs/"+own.ID+"/detail", nil))).Turns[0].Agent
	open(t, p, orch)
	upTo(t, p, "run", own.ID)
	e.reach(p)

	// The connects, the start call, the chat on the run, the stop of that chat.
	x, _ := e.l.api(apiX)
	if got := e.reach(p)[0]; len(got) != 0 {
		t.Fatalf("at the API client's connect the page was sent %v", got)
	}
	startRun(t, x, run1, 200, "", runBody(e.cwd))
	e.awaitRun(run1, "to run", func(v model.RunView) bool { return v.Status == model.RunRunning })
	before := e.defaults("")
	got := start(t, x, 200, startBody(chat1, t.TempDir(), "run", run1)) // the call's folder is ignored
	if !got.Started || !got.Sent || got.Chat == nil || got.Chat.Run != run1 || got.Chat.Group != "" || got.Chat.Cwd != e.cwd {
		t.Fatalf("the creation call on the run: %+v", got)
	}
	if mark, err := e.cm.ClientOf(chat1); err != nil || mark != apiX {
		t.Fatalf("the mark of the chat on the run: %q, %v", mark, err)
	}
	if again := start(t, x, 200, startBody(chat1, e.cwd, "run", run1)); !again.Started || again.Sent {
		t.Fatalf("the repeat of the creation call: %+v", again)
	}
	do(t, x, "GET", "/api/chats/"+chat1+"/items", nil)
	do(t, x, "POST", "/api/chats/"+chat1+"/interrupt", nil)
	stX := decode[struct{ Chats []model.ChatView }](t, string(do(t, x, "GET", "/api/state", nil)))
	if len(stX.Chats) != 1 || stX.Chats[0].ID != chat1 || stX.Chats[0].Run != run1 {
		t.Fatalf("the client's chats: %+v", stX.Chats)
	}
	// What the creation call refuses: a run that is not there, another run for the same chat id.
	if got := start(t, x, 404, startBody(chat2, "", "run", run3, "cwd", nil)); got.Started || got.Chat != nil {
		t.Fatalf("the creation call on a missing run: %+v", got)
	}
	if got := start(t, x, 409, startBody(chat1, "", "run", own.ID, "cwd", nil)); got.Code != "id_taken" {
		t.Fatalf("the repeat that names another run: %+v", got)
	}
	if after := e.defaults(""); after != before {
		t.Errorf("the defaults after the chat on the run:\nbefore %s\nafter  %s", before, after)
	}

	// Meanwhile the page still writes its board and gets the events of the agent's chat.
	written(t, p, bd.ID, rev+1, drawing("two"))
	close(next)
	ps := upTo(t, p, "chat_items", orch, "second")
	ps = append(ps, e.reach(p)[0]...)
	for _, typ := range []string{"release_request", "superseded", "held", "server_stopping"} {
		if n := count(ps, typ); n != 0 {
			t.Errorf("the page was sent %d %s", n, typ)
		}
	}
	if count(ps, "run", run1) == 0 || count(ps, "chat", chat1) == 0 || count(ps, "chat_items", chat1) != 0 {
		t.Errorf("the page, which lists the client's run and chat and follows neither, was sent %v", types(ps))
	}
	e.holder(bd.ID, "P")
	written(t, p, bd.ID, rev+2, drawing("three"))
	xs := e.reach(x)[0]
	apiOnly(t, x, xs)
	for _, raw := range xs {
		if strings.Contains(raw, own.ID) || strings.Contains(raw, orch) || strings.Contains(raw, bd.ID) {
			t.Errorf("the API client was sent %s", raw)
		}
	}
	if count(xs, "run", run1) == 0 || count(xs, "chat", chat1) == 0 || count(xs, "chat_items", chat1) == 0 {
		t.Errorf("X was sent %v", types(xs))
	}

	// An archived run takes no new chat.
	do(t, x, "POST", "/api/runs/"+run1+"/archive", nil)
	if v, _ := e.rs.View(run1); !v.Archived {
		t.Fatal("the run is not archived")
	}
	if got := start(t, x, 409, startBody(chat2, "", "run", run1, "cwd", nil)); got.Started || got.Chat != nil {
		t.Fatalf("the creation call on an archived run: %+v", got)
	}
	e.holder(bd.ID, "P")
	e.expect(200, "POST", "/api/runs/"+own.ID+"/stop", "")
	e.awaitRun(own.ID, "to stop", func(v model.RunView) bool { return v.Status == model.RunStopped })
}

// ---- what the reviews found (T66 F3, F4) ---------------------------------------------

// An API client's read of a run waits for a start call of that id that is under way, and then
// finds the run the call made. A page's read does not wait.
func TestRemoteRunReadWaitsForAStartCall(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	req := decode[runs.StartReq](t, runBody(e.cwd))
	req.ID, req.Client = run1, apiX
	in, release := make(chan struct{}), make(chan struct{})
	req.Place = func() (string, error) {
		close(in)
		<-release
		return e.a.RemoteGroup()
	}
	started := make(chan error, 1)
	go func() {
		_, err := e.rs.StartCall(req)
		started <- err
	}()
	<-in
	type answer struct {
		status int
		body   string
	}
	read := make(chan answer, 1)
	go func() {
		status, out := e.l.try(apiX, testSecret, "GET", "/api/runs/"+run1)
		read <- answer{status, out}
	}()
	// The page's read is answered at once, and so is the API client's read of another id and of
	// a string that is no run id.
	e.expect(404, "GET", "/api/runs/"+run1, "")
	for _, id := range []string{run2, "nope"} {
		if status, out := e.l.call(apiX, testSecret, "GET", "/api/runs/"+id, ""); status != 404 {
			t.Fatalf("the read of %s during the start call of another id: %d %s", id, status, out)
		}
	}
	select {
	case a := <-read:
		t.Fatalf("the read did not wait for the start call: %d %s", a.status, a.body)
	case <-time.After(300 * time.Millisecond):
	}
	close(release)
	if err := <-started; err != nil {
		t.Fatalf("the start call: %v", err)
	}
	select {
	case a := <-read:
		if v := decode[model.RunView](t, a.body); a.status != 200 || v.ID != run1 || v.Status == model.RunDraft {
			t.Fatalf("the read after the start call: %d %s", a.status, a.body)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the read was not answered after the start call")
	}
}

// A read of a run's detail or an unfollow that states the id of a client of the other listener
// starts and ends nothing.
func TestRunFollowIsOfTheListenersKind(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	newStepper(t, e)
	e.page(pageUUID)
	x, _ := e.l.api(apiX)
	startRun(t, x, run1, 200, "", runBody(e.cwd))
	path := "/api/runs/" + run1
	followers := func(what string, want ...string) {
		t.Helper()
		slices.Sort(want)
		if got := e.s.Bridge.Followers(editorbridge.Run(run1)); !slices.Equal(got, want) {
			t.Fatalf("followers after %s: %v, want %v", what, got, want)
		}
	}
	if status, out := e.doAs(apiX, "GET", path+"/detail", ""); status != 200 {
		t.Fatalf("the loopback read with the API client's id: %d %s", status, out)
	}
	if status, out := e.l.call(pageUUID, testSecret, "GET", path+"/detail", ""); status != 200 {
		t.Fatalf("the remote read with the page's id: %d %s", status, out)
	}
	followers("the reads that state the other kind's id")
	e.doAs(pageUUID, "GET", path+"/detail", "")
	do(t, x, "GET", path+"/detail", nil)
	followers("each client's own read", pageUUID, apiX)
	if status, out := e.l.call(pageUUID, testSecret, "POST", path+"/unfollow", ""); status != 200 {
		t.Fatalf("the remote unfollow with the page's id: %d %s", status, out)
	}
	followers("a remote unfollow that states the page's id", pageUUID, apiX)
	// A failed read ends the follow of its own kind only.
	e.s.Bridge.Follow(apiX, editorbridge.Run(run2))
	e.s.Bridge.Follow(pageUUID, editorbridge.Run(run2))
	e.doAs(apiX, "GET", "/api/runs/"+run2+"/detail", "")
	e.l.call(pageUUID, testSecret, "GET", "/api/runs/"+run2+"/detail", "")
	if got := e.s.Bridge.Followers(editorbridge.Run(run2)); len(got) != 2 {
		t.Fatalf("followers after failed reads that state the other kind's id: %v", got)
	}
	do(t, x, "POST", path+"/unfollow", nil)
	followers("the API client's unfollow", pageUUID)
}

// The mark of a run that is started again after its delete routes through the bridge: the
// client that started it is sent the run's events and lists it, another client gets nothing.
// The delete comes before the start call, and at once with it.
func TestRunMarkSurvivesDeleteThenStart(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	newStepper(t, e) // the run stays running
	x, _ := e.l.api(apiX)
	y, _ := e.l.api(apiY)
	body := runBody(e.cwd)
	listed := func(c *bridgetest.Page) bool {
		t.Helper()
		st := decode[struct{ Runs []model.RunView }](t, string(do(t, c, "GET", "/api/state", nil)))
		return slices.ContainsFunc(st.Runs, func(v model.RunView) bool { return v.ID == run1 })
	}
	startRun(t, x, run1, 200, "", body)
	for round := 0; round < 10; round++ {
		if round%2 == 0 {
			do(t, x, "DELETE", "/api/runs/"+run1, nil)
			if got := startRun(t, x, run1, 200, "", body); !*got.Made {
				t.Fatalf("round %d: the start call after the delete made nothing", round)
			}
		} else {
			// At once: the start call finds the run or makes it again after the delete.
			deleted := make(chan int, 1)
			go func() {
				status, _ := e.l.try(apiX, testSecret, "DELETE", "/api/runs/"+run1)
				deleted <- status
			}()
			startRun(t, x, run1, 200, "", body)
			if status := <-deleted; status != 200 {
				t.Fatalf("round %d: the delete: %d", round, status)
			}
			if _, err := e.rs.View(run1); err != nil { // the delete came second
				if got := startRun(t, x, run1, 200, "", body); !*got.Made {
					t.Fatalf("round %d: the start call after the delete made nothing", round)
				}
			}
		}
		name := fmt.Sprintf("renamed %d", round)
		e.expect(200, "PATCH", "/api/runs/"+run1, `{"name":"`+name+`"}`)
		upTo(t, x, "run", run1, name)
		if !listed(x) {
			t.Fatalf("round %d: the state of the client that started the run does not list it", round)
		}
		if listed(y) {
			t.Fatalf("round %d: the state of another client lists the run", round)
		}
		if evs := e.reach(x, y); len(evs[1]) != 0 {
			t.Fatalf("round %d: the other client was sent %v", round, evs[1])
		}
	}
}

// run_activity reaches the client that read the run's detail, and no other.
func TestRunActivityReachesAFollower(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnvOn(t, quickTicks{}) // the test waits for a tick
	st := newStepper(t, e)
	x, _ := e.l.api(apiX)
	y, _ := e.l.api(apiY)
	startRun(t, y, run1, 200, "", runBody(e.cwd)) // Y has the mark and reads no detail
	e.awaitRun(run1, "to run", func(v model.RunView) bool { return v.Status == model.RunRunning })
	e.detail(run1) // the page A follows: its events tell when a step was sent
	st.step(run1)
	if evs := e.reach(x, y); len(only(evs[0], "run_activity", "run_detail")) != 0 || len(only(evs[1], "run_activity", "run_detail")) != 0 {
		t.Fatalf("before a read of the detail X was sent %v, Y %v", types(evs[0]), types(evs[1]))
	}
	do(t, x, "GET", "/api/runs/"+run1+"/detail", nil)
	st.step(run1)
	// The engine's ticker sends it, within two seconds of the step's tool call (sooner here).
	xs := upTo(t, x, "run_activity", run1)
	evs := e.reach(x, y)
	if got := only(evs[1], "run_activity", "run_detail"); len(got) != 0 {
		t.Errorf("Y, which read no detail, was sent %v", got)
	}
	apiOnly(t, x, append(xs, evs[0]...))
}

// A group "Remote" that cannot be made is the server's fault: 500, nothing started, no folder.
func TestRunStartCallGroupCannotBeMade(t *testing.T) {
	t.Parallel()
	if os.Getuid() == 0 {
		t.Skip("root writes to a folder without the write bit")
	}
	e := newAPIRunEnv(t)
	x, _ := e.l.api(apiX)
	// The state file is written beside itself: with its folder read-only the group is not made.
	if err := os.MkdirAll(filepath.Join(e.a.DataDir, "runs"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(e.a.DataDir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(e.a.DataDir, 0o700) })
	got := startRun(t, x, run1, 500, "", runBody(e.cwd))
	if *got.Started || *got.Made || got.Run != nil || got.Error == "" {
		t.Errorf("the answer: %+v", got)
	}
	// The error is the one of the group's making: of the write of the state file, and of no
	// write under runs/.
	if !strings.Contains(got.Error, filepath.Base(e.st.P.State)) || strings.Contains(got.Error, run1) {
		t.Errorf("the error is not the one of the state file's write: %s", got.Error)
	}
	if len(e.rs.List()) != 0 || len(e.runFolders()) != 0 {
		t.Errorf("the refused call left the runs %v and the folders %v", e.rs.List(), e.runFolders())
	}
	if _, err := os.Stat(e.st.P.RunWorkDir(run1)); err == nil {
		t.Error("the refused call left the run's work folder")
	}
	if status, out := x.Do("GET", "/api/runs/"+run1, nil); status != 404 {
		t.Errorf("the read after the refused call: %d %s", status, out)
	}
	if evs := e.reach(x); len(only(evs[0], "run", "run_detail", "run_removed")) != 0 {
		t.Errorf("the refused call sent X %v", evs[0])
	}
	// With the folder writable again the same call starts the run.
	os.Chmod(e.a.DataDir, 0o700)
	if got := startRun(t, x, run1, 200, "", runBody(e.cwd)); !*got.Made {
		t.Errorf("the start call after the refused one made nothing")
	}
}
