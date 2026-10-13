package server

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
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
// service has sent what it queued. A client makes, sets up and starts a run with the page's
// routes, and reaches every run of the server.

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
	l.set(e.s)
	l.serve(e.s)
	return &apiRunEnv{runEnv: e, l: l}
}

// runIDForm is the form of a run id the server makes.
var runIDForm = regexp.MustCompile(`^r_[0-9a-z]{8}$`)

// draftRunBy is the client's new run, which has not started: the page's call, on the listener
// the client is on. It is in no group, with what the server gives a new run.
func draftRunBy(t *testing.T, c *bridgetest.Page) model.RunView {
	t.Helper()
	v := decode[model.RunView](t, string(do(t, c, "POST", "/api/runs", obj{"group": model.Ungrouped})))
	if !runIDForm.MatchString(v.ID) || v.Status != model.RunDraft {
		t.Fatalf("the new run of %s: %+v", c.ID, v)
	}
	return v
}

// startedRunBy is draftRunBy and the run's start with the goal "Look around.": the page's two
// calls. It returns the run's id.
func startedRunBy(t *testing.T, c *bridgetest.Page) string {
	t.Helper()
	id := draftRunBy(t, c).ID
	if v := decode[model.RunView](t, string(do(t, c, "POST", "/api/runs/"+id+"/start", obj{"goal": "Look around."}))); v.ID != id || v.Status == model.RunDraft || v.Started.IsZero() {
		t.Fatalf("the start of %s by %s: %+v", id, c.ID, v)
	}
	return id
}

// runFolders is the names in the data folder's runs folder.
func (e *apiRunEnv) runFolders() (names []string) {
	entries, _ := os.ReadDir(filepath.Join(e.a.DataDir, "runs"))
	for _, en := range entries {
		names = append(names, en.Name())
	}
	return names
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

// itemVersions is the versions of the chat_items events of the chat among evs, in order.
func itemVersions(evs []string, chat string) (out []int) {
	for _, raw := range only(evs, "chat_items") {
		var ev struct {
			Chat    string
			Version int
		}
		if json.Unmarshal([]byte(raw), &ev) == nil && ev.Chat == chat {
			out = append(out, ev.Version)
		}
	}
	return out
}

// ---- a run that has not started, and its start -----------------------------------

// A client makes a run as the server's own page does: POST /api/runs answers the run, a draft,
// in the place the call names. It is on the server from then on, for everyone, with its goal
// being typed and its settings, and POST /api/runs/{id}/start starts it. A call that is refused
// makes nothing.
func TestRunMadeAndStartedByAnAPIClient(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	e.plan(nil)
	p := e.page("P")
	x, _ := e.l.api(apiX)
	y, _ := e.l.api(apiY)
	g := decode[model.Group](t, e.expect(200, "POST", "/api/groups", `{"name":"Mine"}`))
	e.reach(p, x, y)

	// The refusals are the page's own.
	for _, c := range []struct {
		what   string
		status int
		code   string
		body   string
	}{
		{"no group", 400, "", `{}`},
		{"a group that is not there", 404, "not_found", `{"group":"g_nowhere1"}`},
		{"a name that is too long", 400, "", `{"group":"` + g.ID + `","name":"` + strings.Repeat("n", 81) + `"}`},
		{"JSON that cannot be read", 400, "", `{"group":`},
	} {
		status, out := x.Do("POST", "/api/runs", c.body)
		if got := decode[refusal](t, string(out)); status != c.status || got.Code != c.code || got.Error == "" {
			t.Errorf("a new run with %s: %d %s, want %d and the code %q", c.what, status, out, c.status, c.code)
		}
		if ps, pout := p.Do("POST", "/api/runs", c.body); ps != status || string(pout) != string(out) {
			t.Errorf("a new run with %s: the page was answered %d %s, the client %d %s", c.what, ps, pout, status, out)
		}
	}
	if runs, folders := e.rs.List(), e.runFolders(); len(runs) != 0 || len(folders) != 0 {
		t.Fatalf("the refused calls left %d runs and the folders %v", len(runs), folders)
	}
	if evs := e.reach(p, x, y); len(evs[0])+len(evs[1])+len(evs[2]) != 0 {
		t.Fatalf("the refused calls sent %v", evs)
	}

	// The new run: a draft in the group named, with what the server gives a new run.
	v := decode[model.RunView](t, string(do(t, x, "POST", "/api/runs", obj{"group": g.ID, "name": "  Port   the importer "})))
	if !runIDForm.MatchString(v.ID) || v.Status != model.RunDraft || v.Group != g.ID || v.Name != "Port the importer" || !v.UserNamed ||
		v.Agent != model.Claude || v.Cwd != e.cwd || v.Tiers.Deep.Model == "" || v.TierDefaults == nil || !v.Started.IsZero() {
		t.Fatalf("the new run: %+v", v)
	}
	path := "/api/runs/" + v.ID
	e.st.Read(func(s *model.State) {
		if len(s.Groups) != 1 || s.RemoteGroup != "" {
			t.Fatalf("the groups after the client's run: %+v, the group remembered as Remote %q", s.Groups, s.RemoteGroup)
		}
	})
	// The goal being typed has no counter: the last save wins, whoever saves.
	do(t, x, "PUT", path+"/draft", obj{"text": "Look"})
	do(t, y, "PUT", path+"/draft", obj{"text": "Look around"})
	if got := e.view(200, "GET", path, ""); got.Draft == nil || got.Draft.Text != "Look around" || got.Status != model.RunDraft {
		t.Fatalf("the goal being typed, as the owner's page reads it: %+v", got)
	}
	// Everyone lists the run that has not started: the page, the client that made it and the other.
	for who, c := range map[string]*bridgetest.Page{"the page": p, "X": x, "Y": y} {
		st := decode[struct{ Runs []model.RunView }](t, string(do(t, c, "GET", "/api/state", nil)))
		if len(st.Runs) != 1 || st.Runs[0].ID != v.ID || st.Runs[0].Status != model.RunDraft || st.Runs[0].Draft == nil || st.Runs[0].Draft.Text != "Look around" {
			t.Fatalf("the runs in the state of %s: %+v", who, st.Runs)
		}
	}
	// And everyone was told of it, and of its goal: the run's events come from its queue.
	for _, c := range []*bridgetest.Page{p, x, y} {
		if got := upTo(t, c, "run", v.ID, `"text":"Look around"`); count(got, "run", v.ID, `"status":"draft"`, g.ID, "Port the importer") == 0 {
			t.Errorf("of the new run and its goal %s was sent %v", c.ID, types(got))
		}
	}

	// The start: refused without a goal, as for a page, and then made by the other client.
	status, out := y.Do("POST", path+"/start", obj{"goal": "  "})
	if got := decode[refusal](t, string(out)); status != 400 || got.Error != runs.ErrNoGoal.Error() {
		t.Fatalf("a start without a goal: %d %s", status, out)
	}
	started := decode[model.RunView](t, string(do(t, y, "POST", path+"/start", obj{"goal": "Look around."})))
	if started.ID != v.ID || started.Status == model.RunDraft || started.Started.IsZero() || started.Draft != nil {
		t.Fatalf("the start: %+v", started)
	}
	e.awaitRun(v.ID, "to complete", func(v model.RunView) bool { return v.Status == model.RunCompleted })
	// A second start is refused, whoever asks.
	status, out = x.Do("POST", path+"/start", obj{"goal": "Again."})
	if got := decode[refusal](t, string(out)); status != 409 || got.Error != runs.ErrStarted.Error() {
		t.Fatalf("a second start: %d %s", status, out)
	}
	// Everyone is told of the run's start and of its end.
	for _, c := range []*bridgetest.Page{p, x, y} {
		if got := upTo(t, c, "run", v.ID, `"status":"completed"`); count(got, "run", v.ID, `"status":"running"`) == 0 {
			t.Errorf("of the run's start %s was sent %v", c.ID, types(got))
		}
	}
	if len(e.runFolders()) != 1 {
		t.Fatalf("the run folders: %v", e.runFolders())
	}
}

// ---- the routes and the two listeners -------------------------------------------

// The start call and the draft check, which existed for a client alone, are on neither listener;
// a run's plain creation, its start route and its draft route are a client's too.
func TestRunRoutesThatLeftAndThatCame(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	e.plan(nil)
	x, _ := e.l.api(apiX)
	const gate = `{"error":"not found"}`
	const startCall = `{"agent":"claude","cwd":"/","goal":"Look around.","tiers":{"deep":{"model":"opus"},"standard":{"model":"opus"},"light":{"model":"sonnet"}}}`
	// The start call: no route. For a client the table says so. (On the server's own port it
	// is asked in TestRemoteServesOnlyTheTable, of a server that serves the client files, as an
	// installed one does: this one serves none.)
	if status, out := x.Do("PUT", "/api/runs/r_aaaaaaa1", startCall); status != 404 || strings.TrimSpace(string(out)) != gate {
		t.Errorf("the start call on the remote listener: %d %s", status, out)
	}
	if status, out := e.do("PUT", "/api/runs/r_aaaaaaa1", startCall); status == 200 {
		t.Errorf("the start call on loopback: %d %s", status, out)
	}
	// The draft check: its path is now the read of a run named "check", which is none.
	const noRun = `{"code":"not_found","error":"no such run"}`
	if status, out := x.Do("GET", "/api/runs/check?agent=claude&cwd="+e.cwd, nil); status != 404 || strings.TrimSpace(string(out)) != noRun {
		t.Errorf("the draft check on the remote listener: %d %s", status, out)
	}
	if out := e.expect(404, "GET", "/api/runs/check?agent=claude&cwd="+e.cwd, ""); strings.TrimSpace(out) != noRun {
		t.Errorf("the draft check on loopback: %s", out)
	}
	if got := e.rs.Views(); len(got) != 0 || len(e.runFolders()) != 0 {
		t.Fatalf("the calls that left made the runs %+v", got)
	}

	// What came: the creation, the goal being typed and the start. A list of the runs is no route.
	draft := draftRunBy(t, x)
	do(t, x, "PUT", "/api/runs/"+draft.ID+"/draft", obj{"text": "a goal"})
	if v := decode[model.RunView](t, string(do(t, x, "POST", "/api/runs/"+draft.ID+"/start", obj{"goal": "Look around."}))); v.ID != draft.ID || v.Status == model.RunDraft {
		t.Fatalf("the start: %+v", v)
	}
	if status, out := x.Do("GET", "/api/runs", nil); status != 404 || strings.TrimSpace(string(out)) != gate {
		t.Errorf("GET /api/runs on the remote listener: %d %s", status, out)
	}
	e.awaitRun(draft.ID, "to complete", func(v model.RunView) bool { return v.Status == model.RunCompleted })
	if got := e.rs.Views(); len(got) != 1 || len(e.runFolders()) != 1 {
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
	called := map[string]bool{}
	var run1, task string
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
	// X makes the run and types its goal; Y, which did not make it, starts it.
	made := want(x, "POST /api/runs", obj{"group": model.Ungrouped}, 200)
	run1, _ = made["id"].(string)
	if run1 == "" || made["status"] != "draft" {
		t.Fatalf("the new run: %v", made)
	}
	want(x, "PUT /api/runs/{id}/draft", obj{"text": "Look around."}, 200)
	if got := want(y, "POST /api/runs/{id}/start", obj{"goal": "Look around."}, 200); got["id"] != run1 || got["status"] == "draft" {
		t.Fatalf("the start: %v", got)
	}
	e.awaitRun(run1, "to complete", func(v model.RunView) bool { return v.Status == model.RunCompleted })
	task = e.detail(run1).Tasks[0].ID
	for _, c := range []*bridgetest.Page{x, y} {
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
	// The removal is told to every client: the one that made the run and the one that deleted it.
	xs, ys := upTo(t, x, "run_removed", run1), upTo(t, y, "run_removed", run1)
	if evs := e.reach(x, y); count(append(xs, evs[0]...), "run_removed", run1) != 1 || count(append(ys, evs[1]...), "run_removed", run1) != 1 {
		t.Errorf("after the delete X was sent %v, Y %v", types(append(xs, evs[0]...)), types(append(ys, evs[1]...)))
	}
	// A run that is not there: each handler's own 404, with the code that says the run is gone.
	for _, route := range []string{"GET /api/runs/{id}", "GET /api/runs/{id}/detail", "PATCH /api/runs/{id}", "PUT /api/runs/{id}/draft",
		"POST /api/runs/{id}/start", "POST /api/runs/{id}/stop", "POST /api/runs/{id}/archive", "DELETE /api/runs/{id}"} {
		if status, out := call(x, route, obj{"name": "n", "goal": "g", "text": "t"}); status != 404 || out["code"] != "not_found" || out["error"] != runs.ErrNotFound.Error() {
			t.Errorf("%s of a deleted run: %d %v, want 404 not_found", route, status, out)
		}
	}
	for _, route := range RemoteRoutes {
		if isRunRoute(route) && !called[route] {
			t.Errorf("the route %s of the table was not called", route)
		}
	}
}

// ---- the patch of a run (V4) -------------------------------------------------------

// A patch from the remote listener is the page's whole patch: name and group in every status,
// agent, tiers, folder and settings until the run starts. A body that names a server is refused,
// and nothing is changed.
func TestRunPatchOfAnAPIClient(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	e.fake.Script(func(t *agenttest.Turn) { t.Say("Looking."); t.Hang() })
	p := e.page("P")
	x, _ := e.l.api(apiX)
	y, _ := e.l.api(apiY)
	g := decode[model.Group](t, e.expect(200, "POST", "/api/groups", `{"name":"Mine"}`))
	run1 := draftRunBy(t, x).ID
	path := "/api/runs/" + run1
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	e.reach(p, x, y)

	// The whole patch, in one call and by the client that did not make the run.
	v := decode[model.RunView](t, string(do(t, y, "PATCH", path, obj{"name": "Named afar", "group": g.ID, "cwd": dir,
		"tiers": obj{"light": obj{"model": "opus"}}, "settings": obj{"maxTurns": 3, "maxParallel": 2}})))
	if v.Name != "Named afar" || !v.UserNamed || v.Group != g.ID || v.Cwd != dir || v.Tiers.Light.Model != "opus" || v.Settings.MaxTurns != 3 || v.Settings.MaxParallel != 2 || v.Status != model.RunDraft {
		t.Fatalf("the patch: %+v", v)
	}
	was, _ := e.rs.View(run1)
	for _, c := range []*bridgetest.Page{p, x, y} {
		upTo(t, c, "run", run1, "Named afar", g.ID, dir) // everyone is told
	}
	// A server: refused, whatever its value and its letters, and the rest of the body is not
	// applied. What a page's patch is refused for, a client's is too.
	for _, c := range []struct {
		status     int
		code, body string
	}{
		{400, "server_refused", `{"server":"local"}`},
		{400, "server_refused", `{"server":""}`},
		{400, "server_refused", `{"name":"Renamed","server":null}`},
		{400, "server_refused", `{"name":"Renamed","Server":"s_0123456789ab"}`},
		{400, "", `{"settings":{"maxParallel":17}}`},
		{400, "", `{"agent":"gpt"}`},
		{404, "not_found", `{"group":"g_nowhere1"}`},
		{400, "", `[`},
	} {
		status, out := x.Do("PATCH", path, c.body)
		if got := decode[refusal](t, string(out)); status != c.status || got.Code != c.code || got.Error == "" {
			t.Errorf("the patch %s: %d %s, want %d and the code %q", c.body, status, out, c.status, c.code)
		}
	}
	if now, _ := e.rs.View(run1); now.Name != was.Name || now.Group != was.Group || now.Agent != was.Agent || now.Cwd != was.Cwd ||
		now.Tiers != was.Tiers || now.Settings != was.Settings {
		t.Fatalf("the run after the refused patches: %+v, was %+v", now, was)
	}
	for _, evs := range e.reach(p, x, y) {
		if n := count(evs, "run", "Renamed"); n != 0 {
			t.Errorf("a refused patch sent the run with its name: %v", only(evs, "run"))
		}
	}

	// Started: the name and the group still, by a client as by the page; the rest is fixed.
	do(t, x, "POST", path+"/start", obj{"goal": "Look around."})
	e.awaitRun(run1, "to run", func(v model.RunView) bool { return v.Status == model.RunRunning })
	if v := decode[model.RunView](t, string(do(t, x, "PATCH", path, `{"name":"Renamed from afar","group":"`+model.Ungrouped+`"}`))); v.Name != "Renamed from afar" || !v.UserNamed || v.Group != model.Ungrouped {
		t.Fatalf("the rename and the move of the started run: %+v", v)
	}
	e.awaitRun(run1, "to be renamed", func(v model.RunView) bool { return v.Name == "Renamed from afar" })
	for _, c := range []*bridgetest.Page{p, x, y} {
		upTo(t, c, "run", run1, "Renamed from afar") // everyone is told
	}
	for _, body := range []string{`{"agent":"cursor"}`, `{"tiers":{"deep":{"model":"sonnet"}}}`, `{"cwd":"/tmp"}`, `{"settings":{"maxTurns":4}}`} {
		status, out := x.Do("PATCH", path, body)
		if got := decode[refusal](t, string(out)); status != 409 || got.Error != runs.ErrStarted.Error() {
			t.Errorf("the patch %s of a started run: %d %s", body, status, out)
		}
		if ps, pout := p.Do("PATCH", path, body); ps != status || string(pout) != string(out) {
			t.Errorf("the patch %s of a started run: the page was answered %d %s, the client %d %s", body, ps, pout, status, out)
		}
	}
	// A stop and a resume by the client.
	if v := decode[model.RunView](t, string(do(t, x, "POST", path+"/stop", nil))); v.ID != run1 {
		t.Fatalf("the stop: %+v", v)
	}
	e.awaitRun(run1, "to stop", func(v model.RunView) bool { return v.Status == model.RunStopped })
	if v := decode[model.RunView](t, string(do(t, y, "POST", path+"/resume", nil))); v.Status != model.RunRunning {
		t.Fatalf("the resume: %+v", v)
	}
	do(t, x, "POST", path+"/stop", nil)
	e.awaitRun(run1, "to stop again", func(v model.RunView) bool { return v.Status == model.RunStopped })
}

// ---- what the draft check said (V4) ------------------------------------------------

// The view of a run that has not started says of its folder what the draft check said: whether
// it is there, whether it is a git work tree, whether that has changes that are not committed,
// and why the run cannot start as set up. A client reads it with the run.
func TestDraftRunViewSaysWhatTheCheckSaid(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	p := e.page("P")
	x, _ := e.l.api(apiX)
	repo := agenttest.NewRepo(t)
	repo.Write("a.txt", "one")
	repo.Commit("a file")
	run1 := draftRunBy(t, x).ID
	path := "/api/runs/" + run1
	// at puts the run in the folder and returns the view a client then reads.
	at := func(cwd string) model.RunView {
		t.Helper()
		do(t, x, "PATCH", path, obj{"cwd": cwd})
		v := decode[model.RunView](t, string(do(t, x, "GET", path, nil)))
		if v.Status != model.RunDraft || v.TierDefaults == nil || filepath.Base(v.Cwd) != filepath.Base(cwd) {
			t.Fatalf("the draft in %s: %+v", cwd, v)
		}
		return v
	}
	if clean := at(repo.Dir()); !clean.Git || clean.Dirty || clean.Blocked != "" || clean.FolderMissing {
		t.Errorf("a clean repository: %+v", clean)
	}
	repo.Write("b.txt", "untracked")
	empty := agenttest.NewRepo(t)
	gone := filepath.Join(t.TempDir(), "gone")
	if err := os.Mkdir(gone, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name, cwd    string
		missing, git bool
		dirty        bool
		blocked      string // part of the sentence; "" = nothing blocks
		before       func()
	}{
		{"a repository with an untracked file", repo.Dir(), false, true, true, "", nil},
		{"a plain folder", e.cwd, false, false, false, "", nil},
		{"a repository with no commit", empty.Dir(), false, true, false, "commit", nil},
		{"a folder that went missing", gone, true, false, false, "", func() { os.Remove(gone) }},
	} {
		do(t, x, "PATCH", path, obj{"cwd": c.cwd})
		if c.before != nil {
			c.before()
		}
		// The owner's page reads the same.
		for who, out := range map[string]string{"X": string(do(t, x, "GET", path, nil)), "the page": string(do(t, p, "GET", path, nil))} {
			got := decode[model.RunView](t, out)
			if got.FolderMissing != c.missing || got.Git != c.git || got.Dirty != c.dirty || (got.Blocked != "") != (c.blocked != "") ||
				!strings.Contains(got.Blocked, c.blocked) || filepath.Base(got.Cwd) != filepath.Base(c.cwd) {
				t.Errorf("%s, as %s reads it: %s", c.name, who, out)
			}
		}
	}
	if len(e.rs.List()) != 1 {
		t.Errorf("the runs: %+v", e.rs.List())
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

// run and run_removed go to the pages and to every client; run_detail and run_activity to who
// read the detail; the events of a run agent's chat to who read that chat.
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

	run1 := startedRunBy(t, x)
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
	// The list events: the page, the client that made the run and the one that did not, alike.
	var lists [3][]string
	for i, c := range []*bridgetest.Page{p, x, y} {
		lists[i] = upTo(t, c, "run", run1, `"status":"running"`)
	}
	evs := e.reach(p, x, y)
	for i, who := range []string{"the page P", "X", "Y"} {
		got := append(lists[i], evs[i]...)
		if count(got, "run", run1, `"status":"draft"`) == 0 || count(got, "run", run1, `"status":"running"`) == 0 {
			t.Errorf("at the start %s was sent %v", who, types(got))
		}
		none(who+", which read no detail", got, content...)
		none(who+", which read no chat of an agent", got, "chat", "branch_state", "chat_items", "tree")
		if i > 0 && !slices.Equal(only(got, "run"), only(append(lists[0], evs[0]...), "run")) {
			t.Errorf("the run events of %s are not the page's:\n%v\n%v", who, only(got, "run"), only(append(lists[0], evs[0]...), "run"))
		}
	}

	// Nobody but the page A follows: a step reaches no API client.
	st.step(run1)
	evs = e.reach(x, y)
	none("X before its read of the detail", evs[0], content...)
	none("Y before its read of the detail", evs[1], content...)
	// Y reads the detail and the agent's chat: it follows both.
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
	none("X, which made the run and did not read the agent's chat", evs[0], "chat", "branch_state", "chat_items", "tree")
	none("the page P, which read neither", evs[2], append(content, "chat_items", "tree")...)
	yv := versions(evs[1], run1)
	if len(yv) == 0 || yv[0] != int(dy.Version)+1 {
		t.Errorf("Y read the detail at version %d and was then sent the versions %v", dy.Version, yv)
	}

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
	if len(versions(evs[0], run1)) == 0 || len(only(evs[1], content...)) != 0 {
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

	// The owner deletes the run: the pages and every client are told, a follower or not.
	e.expect(200, "DELETE", "/api/runs/"+run1, "")
	ps := upTo(t, p, "run_removed", run1)
	xs := upTo(t, x, "run_removed", run1)
	ys = upTo(t, y, "run_removed", run1)
	evs = e.reach(p, x, y)
	if count(append(ps, evs[0]...), "run_removed", run1) != 1 || count(append(xs, evs[1]...), "run_removed", run1) != 1 || count(append(ys, evs[2]...), "run_removed", run1) != 1 {
		t.Errorf("after the delete the page was sent %v, X %v, Y %v", types(append(ps, evs[0]...)), types(append(xs, evs[1]...)), types(append(ys, evs[2]...)))
	}
	quiet(t, "after the delete", y)
	if got := e.s.Bridge.Followers(editorbridge.Run(run1)); len(got) != 0 {
		t.Errorf("the followers of the removed run: %v", got)
	}
}

// ---- beside a page, and a chat on the run (AC13, 2.7) ------------------------------

// A page holds a board and follows the chat of a run's agent. An API client connects, makes and
// starts a run, makes a chat on it with a first message and stops that chat: the page keeps its
// board and its events. The new chat that names a run is on the run.
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
	before := append(upTo(t, p, "run", own.ID), e.reach(p)[0]...)

	// The connect, the client's run, the chat on the run, the stop of that chat.
	x, _ := e.l.api(apiX)
	// The page's own run goes on by itself meanwhile, at its own pace: the engine records that the
	// agent's session exists once the agent has its message, so that entry of the run's log may
	// come after the agent's first words, and those words reach the page that follows the chat a
	// moment after they are in the thread. An entry that is new to the page, of the log of its run
	// or of the thread of that run's agent, is no connect's doing: the connect itself sends the
	// page nothing, and nothing a second time.
	at := e.reach(p)[0]
	for _, raw := range at {
		if typ := typeOf(raw); (typ != "run_detail" || !strings.Contains(raw, own.ID)) && (typ != "chat_items" || !strings.Contains(raw, orch)) {
			t.Fatalf("at the API client's connect the page was sent %v", at)
		}
	}
	for what, vs := range map[string][]int{
		"the log of its run":            versions(append(before, at...), own.ID),
		"the thread of the run's agent": itemVersions(append(before, at...), orch),
	} {
		if !slices.IsSorted(vs) || len(slices.Compact(slices.Clone(vs))) != len(vs) {
			t.Fatalf("up to the API client's connect the page was sent the versions %v of %s; at the connect %v", vs, what, at)
		}
	}
	run1 := startedRunBy(t, x)
	e.awaitRun(run1, "to run", func(v model.RunView) bool { return v.Status == model.RunRunning })
	got := unstartedBy(t, x, chat1, "group", nil, "run", run1)
	if got.Run != run1 || got.Group != "" || got.Cwd != e.cwd {
		t.Fatalf("the new chat on the run: %+v", got)
	}
	if out := do(t, x, "GET", "/api/chats/"+chat1, nil); strings.Contains(string(out), `"client"`) {
		t.Fatalf("the chat on the run is served with a client mark: %s", out)
	}
	// The client reads the thread before its first message, so it follows the chat from before the
	// agent's first words, and it stops the chat once the agent is at work.
	do(t, x, "GET", "/api/chats/"+chat1+"/items", nil)
	do(t, x, "POST", "/api/chats/"+chat1+"/messages", obj{"text": "the first message"})
	xs := upTo(t, x, "chat_items", chat1, "At work.")
	do(t, x, "POST", "/api/chats/"+chat1+"/interrupt", nil)
	stX := decode[struct {
		Chats []model.ChatView
		Runs  []model.RunView
	}](t, string(do(t, x, "GET", "/api/state", nil)))
	// The client lists the chat on its run and the chat on the page's board, and both runs; the
	// chat of a run's agent is in no list.
	if len(stX.Chats) != 2 || !slices.ContainsFunc(stX.Chats, func(v model.ChatView) bool { return v.ID == chat1 && v.Run == run1 && v.Locked }) ||
		len(stX.Runs) != 2 || slices.ContainsFunc(stX.Chats, func(v model.ChatView) bool { return v.ID == orch }) {
		t.Fatalf("the client's chats %+v and runs %+v", stX.Chats, stX.Runs)
	}
	// What the new chat is refused for, as for a page: a run that is not there, and an id that
	// is taken, on whatever run.
	status, out := x.Do("POST", "/api/chats", obj{"id": chat2, "agent": "claude", "run": "r_ccccccc3"})
	if refused := decode[refusal](t, string(out)); status != 404 || refused.Error == "" {
		t.Fatalf("a new chat on a run that is not there: %d %s", status, out)
	}
	status, out = x.Do("POST", "/api/chats", obj{"id": chat1, "agent": "claude", "run": own.ID})
	if refused := decode[refusal](t, string(out)); status != 409 || refused.Error == "" {
		t.Fatalf("a new chat with a taken id on another run: %d %s", status, out)
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
	xs = append(xs, e.reach(x)[0]...)
	apiOnly(t, x, xs)
	// The client is sent nothing of what is in the page's run and in its agent's chat, which it
	// does not follow, and nothing about the board's holder.
	for _, raw := range only(xs, "run_detail", "run_activity", "chat_items", "tree", "held", "release_request", "superseded", "rpc") {
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
	status, out = x.Do("POST", "/api/chats", obj{"id": chat2, "agent": "claude", "run": run1})
	if refused := decode[refusal](t, string(out)); status != 409 || refused.Error == "" {
		t.Fatalf("a new chat on an archived run: %d %s", status, out)
	}
	if _, err := e.cm.View(chat2); err == nil {
		t.Fatal("the refused calls made a chat")
	}
	e.holder(bd.ID, "P")
	e.expect(200, "POST", "/api/runs/"+own.ID+"/stop", "")
	e.awaitRun(own.ID, "to stop", func(v model.RunView) bool { return v.Status == model.RunStopped })
}

// ---- what the reviews found (T66 F3, F4) ---------------------------------------------

// A read of a run's detail or an unfollow that states the id of a client of the other listener
// starts and ends nothing.
func TestRunFollowIsOfTheListenersKind(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	newStepper(t, e)
	e.page(pageUUID)
	x, _ := e.l.api(apiX)
	run1 := startedRunBy(t, x)
	const run2 = "r_bbbbbbb2" // no run
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

// run_activity reaches the client that read the run's detail, and no other: not the client that
// made the run either.
func TestRunActivityReachesAFollower(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnvOn(t, quickTicks{}) // the test waits for a tick
	st := newStepper(t, e)
	x, _ := e.l.api(apiX)
	y, _ := e.l.api(apiY)
	run1 := startedRunBy(t, y) // Y made the run and reads no detail
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
	apiOnly(t, y, evs[1])
}
