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
	t.Setenv("AIWB_REMOTE_BIND", "127.0.0.1")
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

// apiStarted is the answer of a start call.
type apiStarted struct {
	OK      bool           `json:"ok"`
	Started bool           `json:"started"`
	Made    bool           `json:"made"`
	Run     *model.RunView `json:"run"`
	Error   string         `json:"error"`
	Code    string         `json:"code"`
}

// apiStartBody is the body of a start call for a Claude run in cwd with this goal.
func apiStartBody(cwd, goal string) map[string]any {
	return map[string]any{"agent": "claude", "tiers": tiersOn("haiku"), "cwd": cwd,
		"settings": map[string]any{"maxTurns": 12}, "goal": goal}
}

// startCall is PUT /api/runs/{id} by client.
func (a *apiRunServer) startCall(t *testing.T, client, id string, body map[string]any) (int, apiStarted, string) {
	t.Helper()
	var got apiStarted
	status, raw := a.api(t, client, "PUT", "/api/runs/"+id, body, &got)
	return status, got, raw
}

// mustStart is a start call that has to answer 200 with the run started.
func (a *apiRunServer) mustStart(t *testing.T, client, id string, body map[string]any) apiStarted {
	t.Helper()
	status, got, raw := a.startCall(t, client, id, body)
	if status != http.StatusOK || !got.OK || !got.Started || got.Run == nil || got.Run.ID != id {
		t.Fatalf("the start call of %s: status %d: %s", id, status, raw)
	}
	return got
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

// apiState is GET /api/state of an API client: its own runs and chats.
type apiState struct {
	Runs  []model.RunView
	Chats []model.ChatView
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

// A refused start call leaves nothing: no folder under <home>/runs, no group in state.json, no
// run and no group in the page's state. The start call that is accepted afterwards makes the
// group "Remote" and the one folder, which shows that the checks before it looked at the right
// places.
func TestAPIRunRefusedStartLeavesNothing(t *testing.T) {
	repo, _ := e2eNoteRepo(t)
	a := newAPIRunServer(t, repo.Env())
	goal := apiGoal(t, "Refused, then accepted.", "", "refused.txt", apiHeld)
	with := func(k string, v any) map[string]any {
		body := apiStartBody(repo.Dir(), goal)
		body[k] = v
		return body
	}
	id := model.NewID("r_")
	for _, c := range []struct {
		name, id string
		body     map[string]any
		status   int
		code     string
	}{
		{"a missing folder", id, with("cwd", filepath.Join(t.TempDir(), "no-such-folder")), 409, "folder_missing"},
		{"an agent the server lacks", id, with("agent", "pi"), 409, "agent_missing"},
		{"a named group", id, with("group", "g_12345678"), 400, "group_refused"},
		{"a blank goal", id, with("goal", "  \n"), 400, "bad_request"},
		{"a tier without a model", id, with("tiers", map[string]any{"deep": map[string]any{"model": "haiku"}}), 400, "bad_choice"},
		{"a folder inside the data folder", id, with("cwd", a.home), 400, ""},
		{"an id in upper case", "r_ABCDEFGH", apiStartBody(repo.Dir(), goal), 400, "bad_id"},
		{"an id that is a UUID", apiY, apiStartBody(repo.Dir(), goal), 400, "bad_id"},
		{"an id that leaves the folder", "..%2F..%2Fetc", apiStartBody(repo.Dir(), goal), 400, "bad_id"},
	} {
		status, got, raw := a.startCall(t, apiX, c.id, c.body)
		if status != c.status || got.Code != c.code || got.Started || got.Made || got.OK || got.Run != nil || got.Error == "" {
			t.Errorf("%s: status %d, %s; want %d with the code %q, started false and no run", c.name, status, raw, c.status, c.code)
		}
	}

	if left := a.runFolders(t); len(left) != 0 {
		t.Errorf("folders under %s/runs after the refusals: %v", a.home, left)
	}
	if ents, _ := os.ReadDir(a.work); len(ents) != 0 {
		t.Errorf("%d entries in %s after the refusals", len(ents), a.work)
	}
	if groups := a.stateGroups(t); len(groups) != 0 {
		t.Errorf("groups in state.json after the refusals: %v", groups)
	}
	if st := a.pageState(t); len(st.Groups) != 0 || len(st.Runs) != 0 {
		t.Errorf("the page's state after the refusals: groups %+v, runs %+v", st.Groups, st.Runs)
	}
	if st := a.apiState(t, apiX); len(st.Runs) != 0 {
		t.Errorf("the API client's runs after the refusals: %+v", st.Runs)
	}
	if status, raw := a.api(t, apiX, "GET", "/api/runs/"+id, nil, nil); status != http.StatusNotFound {
		t.Errorf("a read of the refused id: status %d: %s", status, raw)
	}
	if n := a.orchestrators(t, "Refused, then accepted."); n != 0 {
		t.Errorf("%d orchestrators were started by refused calls", n)
	}

	// The same id is free: the accepted call makes the run, its folder and the group.
	if got := a.mustStart(t, apiX, id, apiStartBody(repo.Dir(), goal)); !got.Made || got.Run.Status != model.RunRunning {
		t.Fatalf("the accepted call: %+v, run %+v", got, got.Run)
	}
	if left := a.runFolders(t); !slices.Equal(left, []string{id}) {
		t.Errorf("folders under %s/runs after the accepted call: %v, want %s alone", a.home, left, id)
	}
	st := a.pageState(t)
	if len(st.Groups) != 1 || st.Groups[0].Name != "Remote" || len(st.Runs) != 1 || st.Runs[0].ID != id || st.Runs[0].Group != st.Groups[0].ID {
		t.Fatalf("the page's state after the accepted call: groups %+v, runs %+v", st.Groups, st.Runs)
	}
	for deadline := time.Now().Add(e2eGone); ; time.Sleep(50 * time.Millisecond) {
		if groups := a.stateGroups(t); slices.Equal(groups, []string{"Remote"}) {
			break
		} else if time.Now().After(deadline) {
			t.Fatalf("groups in state.json after the accepted call: %v, want Remote alone", groups)
		}
	}
}

// 24 start calls at once with one id start one orchestrator. A call whose request the client
// cancels right after it was sent, repeated three times, starts one run too.
func TestAPIRunStartCallsStartOneRun(t *testing.T) {
	repo, _ := e2eNoteRepo(t)
	a := newAPIRunServer(t, repo.Env())

	const calls, first = 24, "Started by many calls at once."
	id := model.NewID("r_")
	body := apiStartBody(repo.Dir(), apiGoal(t, first, "", "many.txt", ""))
	type answer struct {
		status int
		got    apiStarted
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
			status, raw, err := a.request(context.Background(), apiX, "PUT", "/api/runs/"+id, body)
			if err != nil {
				answers[i].raw = err.Error()
				return
			}
			answers[i].status, answers[i].raw = status, string(raw)
			json.Unmarshal(raw, &answers[i].got)
		}()
	}
	close(gate)
	wg.Wait()
	made := 0
	for i, ans := range answers {
		if ans.status != http.StatusOK || !ans.got.OK || !ans.got.Started || ans.got.Run == nil || ans.got.Run.ID != id {
			t.Fatalf("call %d of %d at once: status %d: %s", i+1, calls, ans.status, ans.raw)
		}
		if ans.got.Made {
			made++
		}
	}
	if made != 1 {
		t.Errorf("%d of the %d calls at once say they made the run, want 1", made, calls)
	}
	a.waitAchieved(t, apiX, id)
	if n := a.orchestrators(t, first); n != 1 {
		t.Errorf("the %d calls at once started %d orchestrators, want 1", calls, n)
	}
	if left := a.runFolders(t); !slices.Equal(left, []string{id}) {
		t.Errorf("folders under %s/runs: %v, want %s alone", a.home, left, id)
	}

	// The cut call: the client gives up as soon as the request is written.
	const cutFirst = "Started by a call that was cut."
	cut := model.NewID("r_")
	body = apiStartBody(repo.Dir(), apiGoal(t, cutFirst, "", "cut.txt", ""))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	wrote := false
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{WroteRequest: func(httptrace.WroteRequestInfo) {
		wrote = true
		cancel()
	}})
	status, _, err := a.request(ctx, apiX, "PUT", "/api/runs/"+cut, body)
	if !wrote {
		t.Fatalf("the cut call was not sent: status %d, %v", status, err)
	}
	t.Logf("the cut call: status %d, error %v", status, err)
	made = 0
	for i := range 3 {
		if got := a.mustStart(t, apiX, cut, body); got.Made {
			made++
		} else if i == 0 {
			t.Log("the cut call had made the run: the first repeat found it")
		}
	}
	if made > 1 {
		t.Errorf("%d of the three repeats say they made the run", made)
	}
	a.waitAchieved(t, apiX, cut)
	if n := a.orchestrators(t, cutFirst); n != 1 {
		t.Errorf("the cut call and its three repeats started %d orchestrators, want 1", n)
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
	if st := a.apiState(t, apiX); len(st.Runs) != 2 {
		t.Errorf("the API client's runs: %+v, want the two", st.Runs)
	}
	a.stopClean(t)
}

// A clean restart of the server while the run of an API client works: the run continues by
// itself, the repeat of its start call answers started and not made and starts nothing, and the
// run is its client's still.
func TestAPIRunCleanRestart(t *testing.T) {
	repo, base := e2eNoteRepo(t)
	a := newAPIRunServer(t, repo.Env())
	id := model.NewID("r_")
	body := apiStartBody(repo.Dir(), e2eSlowGoal(t))
	if got := a.mustStart(t, apiX, id, body); !got.Made || got.Run.Status != model.RunRunning {
		t.Fatalf("the start call: %+v, run %+v", got, got.Run)
	}
	a.waitFakeMessage(t, 0, e2eOnTask)

	a.stopClean(t)
	sent := a.fakeMessages(t)
	a.up(t)

	got := a.mustStart(t, apiX, id, body)
	if got.Made || got.Run.Status != model.RunRunning {
		t.Fatalf("the repeat after the restart: made %v, the run %s (%s); want not made and running", got.Made, got.Run.Status, got.Run.Reason)
	}
	// The mark was read from the run's folder: the run is X's, and another client's call is refused.
	if st := a.apiState(t, apiX); len(st.Runs) != 1 || st.Runs[0].ID != id {
		t.Errorf("X's runs after the restart: %+v", st.Runs)
	}
	if st := a.apiState(t, apiY); len(st.Runs) != 0 {
		t.Errorf("Y's runs after the restart: %+v", st.Runs)
	}
	if status, other, raw := a.startCall(t, apiY, id, body); status != http.StatusConflict || other.Code != "id_taken" || other.Started || other.Run != nil {
		t.Errorf("Y's call with the id of X's run: status %d: %s", status, raw)
	}

	done := a.waitAchieved(t, apiX, id)
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

// A run to its end with no client connected: the API client closes its stream after the start
// call, and no page was ever there. The run completes and applies its result to the scratch
// repository; the snapshot of a new stream lists it as completed.
func TestAPIRunEndsWithNoClient(t *testing.T) {
	repo := agenttest.NewRepo(t)
	repo.Write(e2eFile, e2eBefore)
	repo.Commit("the shared file")
	a := newAPIRunServer(t, repo.Env())

	x := a.stream(t, apiX)
	if runs, _ := x.Snapshot["runs"].([]any); runs == nil || len(runs) != 0 {
		t.Fatalf("the first snapshot's runs: %v, want an empty list", x.Snapshot["runs"])
	}
	id := model.NewID("r_")
	if got := a.mustStart(t, apiX, id, apiStartBody(repo.Dir(), e2eGoal(t))); !got.Made {
		t.Fatalf("the start call: %+v", got)
	}
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

	x = a.stream(t, apiX)
	raw, _ := json.Marshal(x.Snapshot["runs"])
	var listed []model.RunView
	if err := json.Unmarshal(raw, &listed); err != nil || len(listed) != 1 || listed[0].ID != id ||
		listed[0].Status != model.RunCompleted || listed[0].Outcome != model.Achieved {
		t.Fatalf("the runs in the new stream's snapshot: %s (%v); want %s completed", raw, err, id)
	}
	if got := a.mustStart(t, apiX, id, apiStartBody(repo.Dir(), e2eGoal(t))); got.Made || got.Run.Status != model.RunCompleted {
		t.Errorf("a repeat after the end: made %v, the run %s", got.Made, got.Run.Status)
	}
	if n := a.orchestrators(t, "Paint the shared file in both colours."); n != 1 {
		t.Errorf("%d orchestrators were started, want 1", n)
	}
	a.stopClean(t)
}

// Two API clients: X, whose start call made the run, is sent `run`; Y is not. Both read the
// detail and are sent the same `run_detail` events from then on. X reads the orchestrator's chat
// and is sent its `chat_items`; Y, which did not read it, is sent none.
func TestAPIRunTwoClients(t *testing.T) {
	repo, _ := e2eNoteRepo(t)
	a := newAPIRunServer(t, repo.Env())
	x, y := a.stream(t, apiX), a.stream(t, apiY)

	// The orchestrator's first turn waits before it does anything, so that a client can read its
	// chat while it is at work; the task then only waits, and the run stays running.
	const first = "Watched by two clients."
	id := model.NewID("r_")
	a.mustStart(t, apiX, id, apiStartBody(repo.Dir(), apiGoal(t, first, "[[sleep 5]]", "two.txt", apiHeld)))
	x.await(t, "run", id, `"status":"running"`)

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

	// The first turn goes on and adds the task; X then stops the run.
	a.waitFakeMessage(t, 0, e2eOnTask)
	x.await(t, "chat_items", orch)
	var v model.RunView
	if status, raw := a.api(t, apiX, "POST", "/api/runs/"+id+"/stop", nil, &v); status != http.StatusOK {
		t.Fatalf("X's stop: status %d: %s", status, raw)
	}
	x.await(t, "run", id, `"status":"stopped"`)
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
	// By mark: `run` for X alone. By follow: the chat's events for X alone.
	if n := len(y.of("run")) + len(y.of("run_removed")); n != 0 {
		t.Errorf("Y, which did not make the run, was sent %d run events: %v", n, typesOf(y.got))
	}
	if n := len(y.of("chat_items")) + len(y.of("chat")); n != 0 {
		t.Errorf("Y, which did not read the orchestrator's chat, was sent %d events of a chat: %v", n, typesOf(y.got))
	}
	for _, s := range []*apiStream{x, y} {
		for _, typ := range typesOf(s.got) {
			if typ == "groups" || typ == "defaults" {
				t.Errorf("%s was sent %s", s.ID, typ)
			}
		}
	}
	if st := a.apiState(t, apiY); len(st.Runs) != 0 {
		t.Errorf("Y's runs: %+v", st.Runs)
	}
	if n := a.orchestrators(t, first); n != 1 {
		t.Errorf("%d orchestrators were started, want 1", n)
	}
}

// A chat on the run that the start call made, created by the API client with a first message: the
// client reads the chat, and the stand-in's reply reaches it afterwards as `chat_items`.
func TestAPIRunChatOnTheRun(t *testing.T) {
	repo, _ := e2eNoteRepo(t)
	a := newAPIRunServer(t, repo.Env())
	x := a.stream(t, apiX)
	id := model.NewID("r_")
	a.mustStart(t, apiX, id, apiStartBody(repo.Dir(), apiGoal(t, "A run to talk about.", "", "talk.txt", apiHeld)))
	a.waitFakeMessage(t, 0, e2eOnTask) // T01's agent waits: the run stays running

	const chat, word = "c3e1f5a7-9b2d-4e6f-8a1c-3d5e7f9a1b2c", "A word on the run."
	var made struct {
		OK, Started, Sent bool
		Chat              *model.ChatView
	}
	status, raw := x.Do("POST", "/api/chats", map[string]any{"id": chat, "agent": "claude", "run": id, "text": word + " [[sleep 5]]"})
	if err := json.Unmarshal(raw, &made); status != http.StatusOK || err != nil || !made.OK || !made.Started || !made.Sent || made.Chat == nil {
		t.Fatalf("the creation call: status %d: %s", status, raw)
	}
	if c := made.Chat; c.ID != chat || c.Run != id || c.Group != "" || c.Cwd != repo.Dir() {
		t.Fatalf("the chat on the run: %+v; want it on %s, in no group, in the run's folder", c, id)
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
	x.await(t, "chat", chat) // by mark

	// The chat is the client's, on the run, kept under the run's folder.
	st := a.apiState(t, apiX)
	if len(st.Chats) != 1 || st.Chats[0].ID != chat || st.Chats[0].Run != id || len(st.Runs) != 1 || st.Runs[0].ID != id {
		t.Errorf("X's state: chats %+v, runs %+v", st.Chats, st.Runs)
	}
	if _, err := os.Stat(filepath.Join(a.home, "runs", id, "chats", chat, "chat.json")); err != nil {
		t.Errorf("the chat's folder under the run: %v", err)
	}
	if st := a.apiState(t, apiY); len(st.Chats) != 0 || len(st.Runs) != 0 {
		t.Errorf("Y's state: chats %+v, runs %+v", st.Chats, st.Runs)
	}
}
