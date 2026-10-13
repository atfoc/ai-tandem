package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/server"
	"ai-whiteboard/internal/servers"
)

// ---- a whole server with a remote listener, for the runs of an API client -----------------------

// apiRunServer is a runServer with remote access set up on a scratch port, bound on 127.0.0.1:
// the scripted claude is its Claude program, and an API client reaches it over HTTPS with the
// secret and its client id.
type apiRunServer struct {
	*runServer
	port        int // of the remote listener
	secret, fpr string
	hc          *http.Client // trusts the listener's certificate alone
}

// apiX and apiY are the client ids of the tests' two API clients; apiPage is the id the tests
// state on loopback, where they read what the owner's page would.
const (
	apiX    = testClient
	apiY    = "8d3e6b1c-2f4a-4b7d-a9c1-0e5f6a7b8c9d"
	apiPage = "api-run-e2e-page"
)

// newAPIRunServer makes the server and starts it; the remote listener serves when it returns.
func newAPIRunServer(t *testing.T, gitEnv []string) *apiRunServer {
	t.Helper()
	srv := newRunServer(t, gitEnv)
	srv.in.setenv(loopbackBind)
	a := &apiRunServer{runServer: srv, port: freePort(t)}
	if err := os.MkdirAll(srv.in.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	setUpRemote(t, srv.in.dir, a.port)
	a.secret, a.fpr = secretOf(t, srv.in.dir), fingerprintOf(t, srv.in.dir)
	tr := pinned(a.fpr)
	t.Cleanup(tr.CloseIdleConnections)
	a.hc = &http.Client{Transport: tr, Timeout: 60 * time.Second}
	a.up(t)
	return a
}

// up starts the server and waits for its remote listener.
func (a *apiRunServer) up(t *testing.T) {
	t.Helper()
	a.start(t)
	a.in.waitListening(t)
}

// request makes one call of the API client on the remote listener and returns the status and the
// body. It holds no stream open.
func (a *apiRunServer) request(ctx context.Context, client, method, path string, body any) (int, []byte, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, fmt.Sprintf("https://127.0.0.1:%d%s", a.port, path), rd)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set(remote.SecretHeader, a.secret)
	req.Header.Set(server.ClientHeader, client)
	req.Header.Set(servers.LevelHeader, testLevel)
	if rd != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.hc.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	return resp.StatusCode, raw, err
}

// api is request for a call that must be answered; out, when not nil, gets the decoded body of
// whatever status came.
func (a *apiRunServer) api(t *testing.T, client, method, path string, body, out any) (int, string) {
	t.Helper()
	status, raw, err := a.request(context.Background(), client, method, path, body)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("%s %s: status %d, %v in %s", method, path, status, err, raw)
		}
	}
	return status, string(raw)
}

// apiStarted is the answer of the start call of before level 5.
type apiStarted struct {
	OK      bool           `json:"ok"`
	Started bool           `json:"started"`
	Made    bool           `json:"made"`
	Run     *model.RunView `json:"run"`
	Error   string         `json:"error"`
	Code    string         `json:"code"`
}

// apiStartBody is what a Claude run in cwd with this goal is made of: the body of the start call
// of before, and the parts of the page's calls that make and start a run now (apiNewRun).
func apiStartBody(cwd, goal string) map[string]any {
	return map[string]any{"agent": "claude", "tiers": tiersOn("haiku"), "cwd": cwd,
		"settings": map[string]any{"maxTurns": 12}, "goal": goal}
}

// startCall is PUT /api/runs/{id} by client: the start call of before level 5, which made a run
// and started it in one call. No listener serves it any more.
func (a *apiRunServer) startCall(t *testing.T, client, id string, body map[string]any) (int, apiStarted, string) {
	t.Helper()
	var got apiStarted
	status, raw := a.api(t, client, "PUT", "/api/runs/"+id, body, &got)
	return status, got, raw
}

// apiDraft is POST /api/runs by client: a run that has not started, in no group, with the
// choices of body (apiStartBody; its goal is left for the start).
func (a *apiRunServer) apiDraft(t *testing.T, client, name string, body map[string]any) model.RunView {
	t.Helper()
	var v model.RunView
	if status, raw := a.api(t, client, "POST", "/api/runs", map[string]any{"group": model.Ungrouped, "name": name}, &v); status != http.StatusOK || v.ID == "" || v.Status != model.RunDraft {
		t.Fatalf("the new run of %s: status %d: %s", client, status, raw)
	}
	patch := map[string]any{}
	for k, val := range body {
		if k != "goal" {
			patch[k] = val
		}
	}
	id := v.ID
	if status, raw := a.api(t, client, "PATCH", "/api/runs/"+id, patch, &v); status != http.StatusOK || v.Status != model.RunDraft || v.Blocked != "" || v.FolderMissing || v.Cwd != body["cwd"] {
		t.Fatalf("the choices of the run %s: status %d: %s", id, status, raw)
	}
	return v
}

// apiStart is POST /api/runs/{id}/start by client, with the answer decoded when it is a 200.
func (a *apiRunServer) apiStart(t *testing.T, client, id, goal string) (int, model.RunView, string) {
	t.Helper()
	status, raw, err := a.request(context.Background(), client, "POST", "/api/runs/"+id+"/start", map[string]any{"goal": goal})
	if err != nil {
		t.Fatalf("the start of %s: %v", id, err)
	}
	var v model.RunView
	if status == http.StatusOK {
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatalf("the start of %s: %v in %s", id, err, raw)
		}
	}
	return status, v, string(raw)
}

// apiNewRun makes a run as a client does at level 5, with the page's calls: the run that has not
// started, its choices, and its start with the goal of body. It returns the running run.
func (a *apiRunServer) apiNewRun(t *testing.T, client, name string, body map[string]any) model.RunView {
	t.Helper()
	id := a.apiDraft(t, client, name, body).ID
	goal, _ := body["goal"].(string)
	status, v, raw := a.apiStart(t, client, id, goal)
	if status != http.StatusOK || v.ID != id || v.Status != model.RunRunning || v.Group != model.Ungrouped {
		t.Fatalf("the start of %s: status %d: %s", id, status, raw)
	}
	return v
}

// waitEnded reads the run on the remote listener, with no stream, until it is no longer live.
func (a *apiRunServer) waitEnded(t *testing.T, client, run string) model.RunView {
	t.Helper()
	for deadline := time.Now().Add(e2eWait); ; time.Sleep(100 * time.Millisecond) {
		var v model.RunView
		if status, raw := a.api(t, client, "GET", "/api/runs/"+run, nil, &v); status != http.StatusOK {
			t.Fatalf("the run %s: status %d: %s", run, status, raw)
		}
		if !v.Status.Live() && v.Status != model.RunDraft {
			return v
		}
		if time.Now().After(deadline) {
			t.Fatalf("the run %s is still %s after %s", run, v.Status, e2eWait)
		}
	}
}

// waitAchieved is waitEnded for a run that must end completed, with the outcome achieved.
func (a *apiRunServer) waitAchieved(t *testing.T, client, run string) model.RunView {
	t.Helper()
	v := a.waitEnded(t, client, run)
	if v.Status != model.RunCompleted || v.Outcome != model.Achieved {
		b, _ := json.MarshalIndent(a.detail(t, apiPage, run), "", " ")
		t.Fatalf("the run ended as %s (%s), outcome %q; its detail:\n%s", v.Status, v.Reason, v.Outcome, b)
	}
	return v
}

// orchestrators counts, in the stand-in's log, the first turns of an orchestrator whose goal
// starts with the line first: the number of runs with that goal that were started.
func (a *apiRunServer) orchestrators(t *testing.T, first string) int {
	t.Helper()
	n := 0
	for _, l := range a.fakeLines(t) {
		if text, ok := l.message(); ok && strings.Contains(text, e2eOnTurn1) && !strings.Contains(text, e2eOnTask) && strings.Contains(text, first) {
			n++
		}
	}
	return n
}

// runFolders lists the folders under <home>/runs.
func (a *apiRunServer) runFolders(t *testing.T) []string {
	t.Helper()
	ents, err := os.ReadDir(filepath.Join(a.home, "runs"))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
	}
	return names
}

// stateGroups is the names of the groups in the data folder's state.json; none without the file.
func (a *apiRunServer) stateGroups(t *testing.T) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(a.home, "state.json"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var st struct{ Groups []struct{ Name string } }
	if err := json.Unmarshal(b, &st); err != nil {
		t.Fatalf("state.json: %v in %s", err, b)
	}
	var names []string
	for _, g := range st.Groups {
		names = append(names, g.Name)
	}
	return names
}

// apiPageState is what the owner's page reads on loopback: the groups and the runs.
type apiPageState struct {
	Groups []model.Group
	Runs   []model.RunView
}

func (a *apiRunServer) pageState(t *testing.T) apiPageState {
	t.Helper()
	var st apiPageState
	a.must(t, apiPage, "GET", "api/state", nil, &st)
	return st
}

// apiState is GET /api/state of an API client: the server's groups, runs and chats.
type apiState struct {
	Groups []model.Group
	Runs   []model.RunView
	Chats  []model.ChatView
}

func (a *apiRunServer) apiState(t *testing.T, client string) apiState {
	t.Helper()
	var st apiState
	if status, raw := a.api(t, client, "GET", "/api/state", nil, &st); status != http.StatusOK {
		t.Fatalf("the API state of %s: status %d: %s", client, status, raw)
	}
	return st
}

// apiStream is the open event stream of an API client, with every event it was sent so far.
type apiStream struct {
	*bridgetest.Page
	Snapshot map[string]any // the stream's snapshot event
	got      []string
}

// stream opens the event stream of client on the remote listener and reads its hello and snapshot.
func (a *apiRunServer) stream(t *testing.T, client string) *apiStream {
	t.Helper()
	s := &apiStream{Page: apiClient(t, a.port, a.fpr, a.secret, client)}
	s.Snapshot = s.Welcome()
	return s
}

// pump takes in the events that wait and those that arrive until none came for quiet.
func (s *apiStream) pump(quiet time.Duration) {
	s.got = append(s.got, s.Drain(quiet)...)
}

// apiEvent reports whether raw is an event of this type that holds every one of the texts.
func apiEvent(raw, typ string, holds ...string) bool {
	var e struct{ Type string }
	if json.Unmarshal([]byte(raw), &e) != nil || e.Type != typ {
		return false
	}
	for _, h := range holds {
		if !strings.Contains(raw, h) {
			return false
		}
	}
	return true
}

// of returns the events so far of this type that hold every one of the texts.
func (s *apiStream) of(typ string, holds ...string) []string {
	var out []string
	for _, raw := range s.got {
		if apiEvent(raw, typ, holds...) {
			out = append(out, raw)
		}
	}
	return out
}

// await waits until the stream was sent an event of this type that holds the texts.
func (s *apiStream) await(t *testing.T, typ string, holds ...string) string {
	t.Helper()
	for deadline := time.Now().Add(e2eWait); ; {
		if evs := s.of(typ, holds...); len(evs) > 0 {
			return evs[0]
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s was sent no %s event with %q within %s; it was sent %v", s.ID, typ, holds, e2eWait, typesOf(s.got))
		}
		s.pump(100 * time.Millisecond)
	}
}

// apiGoal is the goal of a run with one writing task: first is its first line, which names the
// run in the stand-in's log; turn1 is what the orchestrator's first turn does before it adds the
// task (a sleep, say); the task's agent writes file after the directives before (a sleep too).
func apiGoal(t *testing.T, first, turn1, file, before string) string {
	t.Helper()
	return first + "\n" +
		"[[if " + e2eOnTurn1 + "]] " + turn1 + " " +
		`[[mcp set_notes {"notes":"Done means: the file is written. T01 writes it."}]] ` +
		e2eAddTask(t, "Write the file", e2eFileWriter(file, "written by the run", before), "implement", true) + " " +
		e2eFinish
}

// apiHeld is the before of apiGoal for a run that stays running: its one task only waits.
const apiHeld = "<<sleep 600>>"

// ---- the tests ----------------------------------------------------------------------------------

// The calls of before level 5 are gone and leave nothing: the start call, the draft check, the
// make of a chat and a client's creation of a board are not served, on the remote listener (404)
// and on the server's own port, and neither they nor the refusals of the page's calls leave a
// run, a chat, a board or a group. The run a client then makes with the page's calls is in no
// group: no group "Remote" is made for it.
func TestAPIRunCallsOfBeforeLeaveNothing(t *testing.T) {
	serverTest(t, "TestRemoteServesOnlyTheTable, TestRunTableRoutesServeAnAPIClient (internal/server)")
	repo, _ := e2eNoteRepo(t)
	a := newAPIRunServer(t, repo.Env())
	const first = "Refused, then accepted."
	goal := apiGoal(t, first, "", "refused.txt", apiHeld)
	body := apiStartBody(repo.Dir(), goal)

	// The calls that are gone. On the remote listener they are outside the table; the draft check
	// is now a read of the run "check", which is not there.
	gone := model.NewID("r_")
	if status, got, raw := a.startCall(t, apiX, gone, body); status != http.StatusNotFound || got.Started || got.Made || got.OK || got.Run != nil {
		t.Errorf("the start call of before: status %d: %s; want 404", status, raw)
	}
	var refusal struct{ Error, Code string }
	for _, c := range []struct {
		name, method, path string
		body               any
		code               string
	}{
		{"the draft check", "GET", "/api/runs/check?cwd=" + repo.Dir(), nil, "not_found"},
		{"the make of a chat", "PUT", "/api/chats/" + apiY, map[string]any{"agent": "claude", "cwd": repo.Dir()}, ""},
		{"a client's creation of a board", "PUT", "/api/boards/b_abcdefgh", map[string]any{"name": "A board"}, ""},
	} {
		refusal.Error, refusal.Code = "", ""
		if status, raw := a.api(t, apiX, c.method, c.path, c.body, &refusal); status != http.StatusNotFound || refusal.Code != c.code || refusal.Error == "" {
			t.Errorf("%s: status %d: %s; want 404 with the code %q", c.name, status, raw, c.code)
		}
	}
	// The creation call of before, a chat with its first message in one call: the body is the
	// page's now, which reads no text and wants a place.
	if status, raw := a.api(t, apiX, "POST", "/api/chats", map[string]any{"id": apiY, "agent": "claude", "cwd": repo.Dir(), "text": "A first message."}, nil); status != http.StatusBadRequest {
		t.Errorf("the creation call of before: status %d: %s; want 400", status, raw)
	}
	// On the server's own port, for a page with a stream: no route takes these calls either.
	page := a.follow(t, apiPage)
	for _, c := range []struct {
		name, path string
		body       any
	}{
		{"the start call of before", "api/runs/" + gone, body},
		{"the make of a chat", "api/chats/" + apiY, map[string]any{"agent": "claude", "cwd": repo.Dir()}},
		{"a client's creation of a board", "api/boards/b_abcdefgh", map[string]any{"name": "A board"}},
	} {
		if status, raw := a.call(t, apiPage, "PUT", c.path, c.body, nil); status != http.StatusNotFound && status != http.StatusMethodNotAllowed {
			t.Errorf("%s on the server's own port: status %d: %s; want no route for it", c.name, status, raw)
		}
	}
	nothing := func(when string) {
		t.Helper()
		if left := a.runFolders(t); len(left) != 0 {
			t.Errorf("folders under %s/runs %s: %v", a.home, when, left)
		}
		if ents, _ := os.ReadDir(a.work); len(ents) != 0 {
			t.Errorf("%d entries in %s %s", len(ents), a.work, when)
		}
		if groups := a.stateGroups(t); len(groups) != 0 {
			t.Errorf("groups in state.json %s: %v", when, groups)
		}
		if st := a.pageState(t); len(st.Groups) != 0 || len(st.Runs) != 0 {
			t.Errorf("the page's state %s: groups %+v, runs %+v", when, st.Groups, st.Runs)
		}
		if st := a.apiState(t, apiX); len(st.Groups) != 0 || len(st.Runs) != 0 || len(st.Chats) != 0 {
			t.Errorf("the API client's state %s: %+v", when, st)
		}
	}
	nothing("after the calls of before")
	if status, raw := a.api(t, apiX, "POST", "/api/runs", map[string]any{"group": "g_12345678", "name": "Nowhere"}, &refusal); status != http.StatusNotFound || refusal.Code != "not_found" {
		t.Errorf("a run in a group that is not there: status %d: %s; want 404 not_found", status, raw)
	}
	nothing("after a run for a group that is not there")

	// The run that has not started, and what is refused of it: each refusal leaves it as it was.
	draft := a.apiDraft(t, apiX, "Asked for by a client", body)
	id := draft.ID
	if draft.Group != model.Ungrouped || draft.Name != "Asked for by a client" {
		t.Fatalf("the run that has not started: %+v", draft)
	}
	for _, c := range []struct {
		name, method, path string
		body               map[string]any
		status             int
		code               string
	}{
		{"a server in the patch", "PATCH", "/api/runs/" + id, map[string]any{"name": "Renamed", "server": "local"}, 400, "server_refused"},
		{"an empty server in the patch, in capitals", "PATCH", "/api/runs/" + id, map[string]any{"name": "Renamed", "SERVER": ""}, 400, "server_refused"},
		{"a folder that is none", "PATCH", "/api/runs/" + id, map[string]any{"cwd": filepath.Join(t.TempDir(), "no-such-folder")}, 400, ""},
		{"a folder inside the data folder", "PATCH", "/api/runs/" + id, map[string]any{"cwd": a.home}, 400, ""},
		{"a group that is not there", "PATCH", "/api/runs/" + id, map[string]any{"group": "g_12345678"}, 404, "not_found"},
		{"a start with a blank goal", "POST", "/api/runs/" + id + "/start", map[string]any{"goal": "  \n"}, 400, ""},
		{"a start of a run that is not there", "POST", "/api/runs/" + gone + "/start", map[string]any{"goal": goal}, 404, "not_found"},
	} {
		refusal.Error, refusal.Code = "", ""
		if status, raw := a.api(t, apiX, c.method, c.path, c.body, &refusal); status != c.status || refusal.Code != c.code || refusal.Error == "" {
			t.Errorf("%s: status %d: %s; want %d with the code %q", c.name, status, raw, c.status, c.code)
		}
		var now model.RunView
		if status, raw := a.api(t, apiY, "GET", "/api/runs/"+id, nil, &now); status != http.StatusOK || now.Status != model.RunDraft ||
			now.Name != draft.Name || now.Cwd != draft.Cwd || now.Group != draft.Group {
			t.Errorf("after %s the run is: status %d: %s", c.name, status, raw)
		}
	}
	if left := a.runFolders(t); !slices.Equal(left, []string{id}) {
		t.Errorf("folders under %s/runs after the refusals: %v, want %s alone", a.home, left, id)
	}
	if n := a.orchestrators(t, first); n != 0 {
		t.Errorf("%d orchestrators were started by refused calls", n)
	}

	// The start: the run works on this server, in no group, for the page and for every client.
	status, started, raw := a.apiStart(t, apiX, id, goal)
	if status != http.StatusOK || started.ID != id || started.Status != model.RunRunning || started.Group != model.Ungrouped {
		t.Fatalf("the start: status %d: %s", status, raw)
	}
	a.waitFakeMessage(t, 0, first)
	page.waitRun(t, id, e2eWait, "to run", func(v model.RunView) bool { return v.Status == model.RunRunning })
	st := a.pageState(t)
	if len(st.Groups) != 0 || len(st.Runs) != 1 || st.Runs[0].ID != id || st.Runs[0].Group != model.Ungrouped {
		t.Fatalf("the page's state after the start: groups %+v, runs %+v", st.Groups, st.Runs)
	}
	for _, client := range []string{apiX, apiY} {
		if st := a.apiState(t, client); len(st.Groups) != 0 || len(st.Runs) != 1 || st.Runs[0].ID != id || st.Runs[0].Status != model.RunRunning {
			t.Errorf("the state of the client %s after the start: groups %+v, runs %+v", client, st.Groups, st.Runs)
		}
	}
	if groups := a.stateGroups(t); len(groups) != 0 {
		t.Errorf("groups in state.json after the start: %v, want none", groups)
	}
	if left := a.runFolders(t); !slices.Equal(left, []string{id}) {
		t.Errorf("folders under %s/runs after the start: %v, want %s alone", a.home, left, id)
	}
}

// 24 starts at once of one run that has not started, by two clients, start one orchestrator:
// one is answered with the running run, the others are refused. A start whose request the
// client cancels right after it was sent starts the run once or not at all, and the run's view
// says which.
func TestAPIRunStartsAtOnceStartOneRun(t *testing.T) {
	serverTest(t, "TestSvcStartInAGitRepository (a second start is refused) (internal/runs)", "TestRunTableRoutesServeAnAPIClient (internal/server)")
	repo, _ := e2eNoteRepo(t)
	a := newAPIRunServer(t, repo.Env())

	const calls, first = 24, "Started by many calls at once."
	goal := apiGoal(t, first, "", "many.txt", "")
	id := a.apiDraft(t, apiX, "Many starts", apiStartBody(repo.Dir(), goal)).ID
	type answer struct {
		status int
		raw    string
	}
	answers := make([]answer, calls)
	var wg sync.WaitGroup
	gate := make(chan struct{})
	for i := range answers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-gate
			client := []string{apiX, apiY}[i%2]
			status, raw, err := a.request(context.Background(), client, "POST", "/api/runs/"+id+"/start", map[string]any{"goal": goal})
			if err != nil {
				answers[i].raw = err.Error()
				return
			}
			answers[i].status, answers[i].raw = status, string(raw)
		}()
	}
	close(gate)
	wg.Wait()
	started := 0
	for i, ans := range answers {
		switch ans.status {
		case http.StatusOK:
			var v model.RunView
			if err := json.Unmarshal([]byte(ans.raw), &v); err != nil || v.ID != id || v.Status != model.RunRunning {
				t.Fatalf("call %d of %d at once: status 200: %s", i+1, calls, ans.raw)
			}
			started++
		case http.StatusConflict:
		default:
			t.Fatalf("call %d of %d at once: status %d: %s; want 200 or 409", i+1, calls, ans.status, ans.raw)
		}
	}
	if started != 1 {
		t.Errorf("%d of the %d calls at once were answered with the started run, want 1", started, calls)
	}
	a.waitAchieved(t, apiX, id)
	if n := a.orchestrators(t, first); n != 1 {
		t.Errorf("the %d calls at once started %d orchestrators, want 1", calls, n)
	}
	if left := a.runFolders(t); !slices.Equal(left, []string{id}) {
		t.Errorf("folders under %s/runs: %v, want %s alone", a.home, left, id)
	}

	// The cut start: the client gives up as soon as the request is written, and reads the run to
	// learn what became of it.
	const cutFirst = "Started by a call that was cut."
	goal = apiGoal(t, cutFirst, "", "cut.txt", "")
	cut := a.apiDraft(t, apiX, "A cut start", apiStartBody(repo.Dir(), goal)).ID
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	wrote := false
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{WroteRequest: func(httptrace.WroteRequestInfo) {
		wrote = true
		cancel()
	}})
	status, _, err := a.request(ctx, apiX, "POST", "/api/runs/"+cut+"/start", map[string]any{"goal": goal})
	if !wrote {
		t.Fatalf("the cut start was not sent: status %d, %v", status, err)
	}
	t.Logf("the cut start: status %d, error %v", status, err)
	// The server may still be at the cut start: the starts that follow are refused while it is
	// (409), and one is taken only if the cut one started nothing.
	taken := 0
	for deadline := time.Now().Add(e2eWait); ; time.Sleep(50 * time.Millisecond) {
		var v model.RunView
		if status, raw := a.api(t, apiX, "GET", "/api/runs/"+cut, nil, &v); status != http.StatusOK {
			t.Fatalf("the read of the run after the cut start: status %d: %s", status, raw)
		}
		if v.Status != model.RunDraft {
			break
		}
		switch status, _, raw := a.apiStart(t, apiX, cut, goal); status {
		case http.StatusOK:
			taken++
		case http.StatusConflict:
		default:
			t.Fatalf("the start after the cut one: status %d: %s", status, raw)
		}
		if time.Now().After(deadline) {
			t.Fatalf("the run %s has not started %s after the cut start", cut, e2eWait)
		}
	}
	if taken == 0 {
		t.Log("the cut start had started the run")
	}
	for range 3 {
		if status, _, raw := a.apiStart(t, apiY, cut, goal); status != http.StatusConflict {
			t.Errorf("a start of the started run: status %d: %s; want 409", status, raw)
		}
	}
	a.waitAchieved(t, apiX, cut)
	if n := a.orchestrators(t, cutFirst); n != 1 {
		t.Errorf("the cut start and the starts after it started %d orchestrators, want 1", n)
	}
	if n := a.orchestrators(t, first); n != 1 {
		t.Errorf("the first run has %d orchestrators now", n)
	}
	left, want := a.runFolders(t), []string{id, cut}
	slices.Sort(left)
	slices.Sort(want)
	if !slices.Equal(left, want) {
		t.Errorf("folders under %s/runs: %v, want %v", a.home, left, want)
	}
	for _, client := range []string{apiX, apiY} {
		if st := a.apiState(t, client); len(st.Runs) != 2 {
			t.Errorf("the runs of the client %s: %+v, want the two", client, st.Runs)
		}
	}
	a.stopClean(t)
}

// A clean restart of the server while the run a client started works: the run continues by
// itself, a second start is refused and starts nothing, and the run is everyone's, as before the
// restart: the client that made it and another one both list it.
func TestAPIRunCleanRestart(t *testing.T) {
	serverTest(t, "TestRunTableRoutesServeAnAPIClient (internal/server)", "TestStopRestartResume (internal/runs)")
	repo, base := e2eNoteRepo(t)
	a := newAPIRunServer(t, repo.Env())
	body := apiStartBody(repo.Dir(), e2eSlowGoal(t))
	id := a.apiNewRun(t, apiX, "Across a restart", body).ID
	a.waitFakeMessage(t, 0, e2eOnTask)

	a.stopClean(t)
	sent := a.fakeMessages(t)
	a.up(t)

	for _, client := range []string{apiX, apiY} {
		if st := a.apiState(t, client); len(st.Runs) != 1 || st.Runs[0].ID != id || st.Runs[0].Group != model.Ungrouped || len(st.Groups) != 0 {
			t.Errorf("the state of the client %s after the restart: groups %+v, runs %+v", client, st.Groups, st.Runs)
		}
		if status, _, raw := a.apiStart(t, client, id, e2eSlowGoal(t)); status != http.StatusConflict {
			t.Errorf("a start by %s after the restart: status %d: %s; want 409", client, status, raw)
		}
	}

	done := a.waitAchieved(t, apiY, id)
	e2eNoteDone(t, a.runServer, repo, apiPage, base, id, done, a.detail(t, apiPage, id), model.StopAppQuit)
	if now := a.fakeMessages(t); now <= sent {
		t.Errorf("%d messages to agents after the restart, %d before it: nothing was launched again", now, sent)
	}
	if n := a.orchestrators(t, "Write the note."); n != 1 {
		t.Errorf("the run's first turn was sent %d times, want once", n)
	}
	if left := a.runFolders(t); !slices.Equal(left, []string{id}) {
		t.Errorf("folders under %s/runs: %v, want %s alone", a.home, left, id)
	}
	a.stopClean(t)
}

// A run to its end with no client connected: the API client closes its stream after the start,
// and no page was ever there. The run completes and applies its result to the scratch
// repository; the snapshot of a new stream lists it as completed.
func TestAPIRunEndsWithNoClient(t *testing.T) {
	serverTest(t, "TestAPIClientWithNoPage, TestStartOutlivesThePageThatAsked (internal/server)", "TestRunE2ENoGit (this package)")
	repo := agenttest.NewRepo(t)
	repo.Write(e2eFile, e2eBefore)
	repo.Commit("the shared file")
	a := newAPIRunServer(t, repo.Env())

	x := a.stream(t, apiX)
	if runs, _ := x.Snapshot["runs"].([]any); runs == nil || len(runs) != 0 {
		t.Fatalf("the first snapshot's runs: %v, want an empty list", x.Snapshot["runs"])
	}
	id := a.apiNewRun(t, apiX, "With nobody there", apiStartBody(repo.Dir(), e2eGoal(t))).ID
	x.await(t, "run", id, `"status":"running"`)
	x.Close()

	// Nothing asks the server anything while the run works: the test watches the repository.
	file := filepath.Join(repo.Dir(), e2eFile)
	for deadline := time.Now().Add(e2eWait); ; time.Sleep(100 * time.Millisecond) {
		if b, _ := os.ReadFile(file); strings.TrimSpace(string(b)) == e2eResolved {
			break
		}
		if time.Now().After(deadline) {
			b, _ := os.ReadFile(file)
			t.Fatalf("%s reads %q after %s, want %q", file, b, e2eWait, e2eResolved)
		}
	}
	done := a.waitAchieved(t, apiX, id)
	if done.Delivery != model.DeliveryApplied {
		t.Errorf("the run's delivery: %q, want applied", done.Delivery)
	}
	if got := repo.Git("show", "main:"+e2eFile); got != e2eResolved {
		t.Errorf("%s on the repository's branch: %q, want %q", e2eFile, got, e2eResolved)
	}
	if st := repo.Git("status", "--porcelain"); st != "" {
		t.Errorf("the repository's work tree after the result was applied:\n%s", st)
	}
	a.waitNoFakes(t, true, e2eGone, "after the run ended")

	// Another client's new stream: the run is in its snapshot too.
	y := a.stream(t, apiY)
	raw, _ := json.Marshal(y.Snapshot["runs"])
	var listed []model.RunView
	if err := json.Unmarshal(raw, &listed); err != nil || len(listed) != 1 || listed[0].ID != id ||
		listed[0].Status != model.RunCompleted || listed[0].Outcome != model.Achieved {
		t.Fatalf("the runs in the new stream's snapshot: %s (%v); want %s completed", raw, err, id)
	}
	if status, _, raw := a.apiStart(t, apiX, id, e2eGoal(t)); status != http.StatusConflict {
		t.Errorf("a start after the end: status %d: %s; want 409", status, raw)
	}
	if n := a.orchestrators(t, "Paint the shared file in both colours."); n != 1 {
		t.Errorf("%d orchestrators were started, want 1", n)
	}
	a.stopClean(t)
}

// Two API clients: X makes the run and starts it, and both are sent the same `run` events. Both
// read the detail and are sent the same `run_detail` events from then on. X reads the
// orchestrator's chat and is sent its `chat_items`; Y, which did not read it, is sent none.
func TestAPIRunTwoClients(t *testing.T) {
	serverTest(t, "TestRunEventsOfAnAPIClient, TestRunTableRoutesServeAnAPIClient (internal/server)")
	repo, _ := e2eNoteRepo(t)
	a := newAPIRunServer(t, repo.Env())
	x, y := a.stream(t, apiX), a.stream(t, apiY)

	// The orchestrator's first turn waits before it does anything, so that a client can read its
	// chat while it is at work; the task then only waits, and the run stays running.
	const first = "Watched by two clients."
	id := a.apiNewRun(t, apiX, "Two clients", apiStartBody(repo.Dir(), apiGoal(t, first, "[[sleep 5]]", "two.txt", apiHeld))).ID
	x.await(t, "run", id, `"status":"running"`)
	y.await(t, "run", id, `"status":"running"`)

	// Both read the detail, X the orchestrator's chat too.
	var orch string
	var dx model.RunDetail
	for deadline := time.Now().Add(e2eWait); orch == ""; time.Sleep(50 * time.Millisecond) {
		if status, raw := x.Do("GET", "/api/runs/"+id+"/detail", nil); status != http.StatusOK || json.Unmarshal(raw, &dx) != nil {
			t.Fatalf("X's read of the detail: status %d: %s", status, raw)
		}
		for chat, ag := range dx.Agents {
			if ag.Role == model.RoleOrchestrator {
				orch = chat
			}
		}
		if orch == "" && time.Now().After(deadline) {
			t.Fatalf("the run has no orchestrator after %s: %+v", e2eWait, dx.Agents)
		}
	}
	// The detail lists the orchestrator before its chat exists: the chat is made just after.
	for deadline := time.Now().Add(e2eWait); ; time.Sleep(50 * time.Millisecond) {
		status, raw := x.Do("GET", "/api/chats/"+orch+"/items", nil)
		if status == http.StatusOK {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the items of %s after %s: %d %s", orch, e2eWait, status, raw)
		}
	}
	var dy model.RunDetail
	if status, raw := y.Do("GET", "/api/runs/"+id+"/detail", nil); status != http.StatusOK || json.Unmarshal(raw, &dy) != nil || dy.Run != id {
		t.Fatalf("Y's read of the detail: status %d: %s", status, raw)
	}
	from := max(dx.Version, dy.Version)

	// The first turn goes on and adds the task; Y, which did not make the run, then stops it.
	a.waitFakeMessage(t, 0, e2eOnTask)
	x.await(t, "chat_items", orch)
	var v model.RunView
	if status, raw := a.api(t, apiY, "POST", "/api/runs/"+id+"/stop", nil, &v); status != http.StatusOK {
		t.Fatalf("Y's stop: status %d: %s", status, raw)
	}
	x.await(t, "run", id, `"status":"stopped"`)
	y.await(t, "run", id, `"status":"stopped"`)
	x.pump(time.Second)
	y.pump(time.Second)

	// The same run_detail events, in the same order, for both.
	later := func(s *apiStream) (versions []int64, raws []string) {
		for _, raw := range s.of("run_detail", id) {
			var e struct{ Version int64 }
			if json.Unmarshal([]byte(raw), &e); e.Version > from {
				versions, raws = append(versions, e.Version), append(raws, raw)
			}
		}
		return versions, raws
	}
	xv, xr := later(x)
	yv, yr := later(y)
	if len(xv) == 0 || !slices.Equal(xv, yv) || !slices.Equal(xr, yr) {
		t.Errorf("the run_detail events after version %d: X was sent the versions %v, Y %v", from, xv, yv)
	}
	if !slices.IsSorted(xv) {
		t.Errorf("X's run_detail versions are out of order: %v", xv)
	}
	// To every client: the same `run` events, from the run that has not started to the stopped
	// one. By follow: the chat's events for X alone.
	xruns, yruns := x.of("run", id), y.of("run", id)
	if len(xruns) < 3 || !slices.Equal(xruns, yruns) || !strings.Contains(xruns[0], `"status":"draft"`) {
		t.Errorf("the run events: X was sent %d, Y %d; want the same ones, the first of a run that has not started:\n%s\n%s",
			len(xruns), len(yruns), strings.Join(xruns, "\n"), strings.Join(yruns, "\n"))
	}
	if n := len(y.of("chat_items")) + len(y.of("chat")); n != 0 {
		t.Errorf("Y, which did not read the orchestrator's chat, was sent %d events of a chat: %v", n, typesOf(y.got))
	}
	for _, s := range []*apiStream{x, y} {
		for _, typ := range typesOf(s.got) {
			if !slices.Contains(apiListEvents, typ) && !slices.Contains(apiFollowEvents, typ) {
				t.Errorf("%s was sent %s", s.ID, typ)
			}
		}
	}
	for _, client := range []string{apiX, apiY} {
		if st := a.apiState(t, client); len(st.Runs) != 1 || st.Runs[0].ID != id || st.Runs[0].Status != model.RunStopped {
			t.Errorf("the runs of the client %s: %+v", client, st.Runs)
		}
	}
	if n := a.orchestrators(t, first); n != 1 {
		t.Errorf("%d orchestrators were started, want 1", n)
	}
}

// A chat on the run a client started, made by the client with the page's call and given its
// first message with the message call: the client reads the chat, and the stand-in's reply
// reaches it afterwards as `chat_items`. Another client lists the chat and the run too.
func TestAPIRunChatOnTheRun(t *testing.T) {
	serverTest(t, "TestAPIClientsRunBesideAPage, TestRunAgentsChatBesideAPIClients (internal/server)")
	repo, _ := e2eNoteRepo(t)
	a := newAPIRunServer(t, repo.Env())
	x := a.stream(t, apiX)
	id := a.apiNewRun(t, apiX, "A run to talk about", apiStartBody(repo.Dir(), apiGoal(t, "A run to talk about.", "", "talk.txt", apiHeld))).ID
	a.waitFakeMessage(t, 0, e2eOnTask) // T01's agent waits: the run stays running

	const chat, word = "c3e1f5a7-9b2d-4e6f-8a1c-3d5e7f9a1b2c", "A word on the run."
	var made model.ChatView
	status, raw := x.Do("POST", "/api/chats", map[string]any{"id": chat, "agent": "claude", "run": id})
	if err := json.Unmarshal(raw, &made); status != http.StatusOK || err != nil {
		t.Fatalf("the new chat: status %d: %s", status, raw)
	}
	if made.ID != chat || made.Run != id || made.Group != "" || made.Cwd != repo.Dir() || made.Locked {
		t.Fatalf("the chat on the run: %+v; want it on %s, in no group, in the run's folder", made, id)
	}
	if status, raw := x.Do("POST", "/api/chats/"+chat+"/messages", map[string]any{"text": word + " [[sleep 5]]"}); status != http.StatusOK {
		t.Fatalf("the first message: status %d: %s", status, raw)
	}

	// The client reads the chat while its agent still waits: the reply is not there yet.
	for _, it := range itemsOf(t, x.Page, chat) {
		if strings.Contains(it.Text, "FAKE(") {
			t.Fatalf("the reply was there before the client read the chat: %q", it.Text)
		}
	}
	x.pump(100 * time.Millisecond)
	before := len(x.of("chat_items", chat, "FAKE("))
	reply := x.await(t, "chat_items", chat, "FAKE(", word)
	if before != 0 {
		t.Errorf("the reply's chat_items came before the client read the chat")
	}
	if strings.Contains(reply, "[[sleep") {
		t.Errorf("the reply holds the directive: %s", clipText(reply, 300))
	}
	x.await(t, "chat", chat) // a list event: to every client

	// The chat is on the run, kept under the run's folder, and everyone's.
	for _, client := range []string{apiX, apiY} {
		st := a.apiState(t, client)
		if len(st.Chats) != 1 || st.Chats[0].ID != chat || st.Chats[0].Run != id || len(st.Runs) != 1 || st.Runs[0].ID != id {
			t.Errorf("the state of the client %s: chats %+v, runs %+v", client, st.Chats, st.Runs)
		}
	}
	if _, err := os.Stat(filepath.Join(a.home, "runs", id, "chats", chat, "chat.json")); err != nil {
		t.Errorf("the chat's folder under the run: %v", err)
	}
}
