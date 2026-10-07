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
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/servers"
)

// The run service is the relay's LocalRuns.
var _ LocalRuns = (*runs.Service)(nil)

// runMark is the client mark of the draft runs of the tests: it is this server's, and is not sent.
const runMark = "mark-0123456789abcdef"

// runN is the id of the n-th run of a test.
func runN(n int) string { return fmt.Sprintf("r_%08d", n) }

// draftRun gives the fake run service a draft run that will start on the rig's entry, with
// what is known of a start (state).
func (rg *rig) draftRun(id, state string) model.RunMeta {
	meta := model.RunMeta{
		ID: id, Name: "Colours", UserNamed: true, Group: "g_here", Agent: model.Claude, Cwd: "/home/standin/repo",
		Tiers: model.RunTiers{Deep: model.ModelChoice{Model: "deep-model", Effort: "high"},
			Standard: model.ModelChoice{Model: "std-model"}, Light: model.ModelChoice{Model: "light-model"}},
		Settings: model.RunSettings{MaxParallel: 4, MaxTurns: 30, MaxCost: 2.5, Setup: "make deps", Wake: "each",
			MaxIdleTurns: 3, AgentTimeoutSec: 10800, AgentRetries: 2},
		Draft: &model.Draft{Text: "typed"}, Client: runMark, Server: rg.entry, RemoteStart: state,
	}
	rg.setDraftRun(meta)
	return meta
}

func (rg *rig) setDraftRun(meta model.RunMeta) {
	rg.runs.mu.Lock()
	defer rg.runs.mu.Unlock()
	rg.runs.drafts[meta.ID] = meta
}

// runState is what the fake run service knows of the draft's start; ok is false for a draft it
// no longer has.
func (rg *rig) runState(id string) (state string, ok bool) {
	meta, ok := rg.runs.RemoteDraft(id)
	return meta.RemoteStart, ok
}

// runTold are the states SetRemoteStart was called with for the run, in order.
func (rg *rig) runTold(id string) []string {
	out := []string{}
	for _, s := range rg.runs.told(&rg.runs.starts) {
		if rest, ok := strings.CutPrefix(s, id+"="); ok {
			out = append(out, rest)
		}
	}
	return out
}

func (rg *rig) runHanded(id string) bool {
	for _, h := range rg.runs.told(&rg.runs.handed) {
		if h == id {
			return true
		}
	}
	return false
}

// runAnswerOf is the answer of the start call, as the remote server writes it.
func runAnswerOf(started, made bool, run *model.RunView, errText, code string) map[string]any {
	out := map[string]any{"started": started, "made": made}
	if run != nil {
		out["run"] = run
	}
	if errText == "" {
		out["ok"] = true
	} else {
		out["error"] = errText
		if code != "" {
			out["code"] = code
		}
	}
	return out
}

// serveRunViews makes the read of a run answer the view of that id with the status.
func serveRunViews(get *script, status model.RunStatus) {
	get.set(func(w http.ResponseWriter, r *http.Request) {
		writeAnswer(w, http.StatusOK, remoteRun(r.PathValue("id"), status))
	})
}

// noRunSecret fails the test when text holds the entry's secret or a draft's client mark.
func noRunSecret(t *testing.T, what, text string) {
	t.Helper()
	noSecret(t, what, text)
	if strings.Contains(text, runMark) {
		t.Errorf("%s holds a run's client mark: %s", what, text)
	}
}

const (
	runUnconfirmed = "Studio did not answer: it is not known whether the run started. Start again: it starts only once."
	runNotStarted  = "Studio did not answer and the run was not started. Start again."
)

// TestRunStartTable: every row of the table of the start call's answers.
func TestRunStartTable(t *testing.T) {
	rg := newRig(t, rigOpt{})
	put := rg.script("PUT /api/runs/{id}")
	get := rg.script("GET /api/runs/{id}")
	serveRunViews(get, model.RunRunning)
	p, _ := rg.page("page-1")

	rows := []struct {
		name    string
		prior   string // RemoteStart before the call
		status  int    // the answer of the start call
		started bool
		made    bool
		run     string // "": no view; "own": the run's; "other": another run's
		raw     any    // the answer, when it is not the start call's shape
		errText string
		code    string

		want      int // the page's status
		wantCode  string
		wantText  string
		swapped   bool
		wantState string
		wantTold  []string
	}{
		{name: "200 started", status: 200, started: true, made: true, run: "own", want: 200, swapped: true},
		{name: "an error that says started", status: 500, started: true, made: true, run: "own", errText: "the engine failed after the start",
			want: 200, swapped: true},
		{name: "a repeat of a started run", prior: model.RemoteUnconfirmed, status: 200, started: true, run: "own", want: 200, swapped: true},
		{name: "409 folder_missing", prior: model.RemoteUnconfirmed, status: 409, errText: "folder not found: /nowhere", code: "folder_missing",
			want: 409, wantCode: "folder_missing", wantText: "folder not found: /nowhere", wantTold: []string{""}},
		{name: "agent_missing reaches the page (AC44)", status: 409, errText: "the agent's program was not found: pi is not installed on this server", code: "agent_missing",
			want: 409, wantCode: "agent_missing", wantText: "the agent's program was not found: pi is not installed on this server", wantTold: []string{}},
		{name: "409 blocked", prior: model.RemoteUnconfirmed, status: 409, errText: "the folder has no commit yet", code: "blocked",
			want: 409, wantCode: "blocked", wantText: "the folder has no commit yet", wantTold: []string{""}},
		{name: "400 bad_choice", prior: model.RemoteUnconfirmed, status: 400, errText: "unknown model", code: "bad_choice",
			want: 400, wantCode: "bad_choice", wantText: "unknown model", wantTold: []string{""}},
		{name: "500", prior: model.RemoteUnconfirmed, status: 500, errText: "disk full",
			want: 500, wantText: "disk full", wantTold: []string{""}},
		{name: "bad_request says nothing of the run", prior: model.RemoteUnconfirmed, status: 400, errText: "a value is missing", code: "bad_request",
			want: 400, wantCode: "bad_request", wantText: "a value is missing", wantState: model.RemoteUnconfirmed, wantTold: []string{}},
		{name: "bad_id says nothing of the run", prior: model.RemoteUnconfirmed, status: 400, errText: "bad id", code: "bad_id",
			want: 400, wantCode: "bad_id", wantText: "bad id", wantState: model.RemoteUnconfirmed, wantTold: []string{}},
		{name: "group_refused says nothing of the run", prior: model.RemoteUnconfirmed, status: 400, errText: "an API client cannot name a group", code: "group_refused",
			want: 400, wantCode: "group_refused", wantText: "an API client cannot name a group", wantState: model.RemoteUnconfirmed, wantTold: []string{}},
		{name: "a server without run routes", prior: model.RemoteUnconfirmed, status: 404, raw: map[string]string{"error": "not found"},
			want: 409, wantCode: "runs_unsupported", wantText: "Studio cannot run runs: update it.", wantState: model.RemoteUnconfirmed, wantTold: []string{}},
		{name: "an error that is not the start call's", prior: model.RemoteUnconfirmed, status: 403, raw: map[string]string{"error": "bad host"},
			want: 403, wantText: "bad host", wantState: model.RemoteUnconfirmed, wantTold: []string{}},
		{name: "started, with the view of another run", status: 200, started: true, made: true, run: "other",
			want: 502, wantCode: "bad_answer", wantText: "Studio gave an answer that cannot be read.",
			wantState: model.RemoteUnconfirmed, wantTold: []string{model.RemoteUnconfirmed}},
	}
	for i, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			id := runN(i)
			rg.draftRun(id, row.prior)
			view := remoteRun(id, model.RunRunning)
			if row.run == "other" {
				view = remoteRun(runB, model.RunRunning)
			}
			var run *model.RunView
			if row.run != "" {
				run = &view
			}
			if row.raw != nil {
				put.answer(row.status, row.raw)
			} else {
				put.answer(row.status, runAnswerOf(row.started, row.made, run, row.errText, row.code))
			}
			before := put.count()
			rep := rg.r.StartRun(context.Background(), id, "Make it red and blue")
			if put.count() != before+1 {
				t.Errorf("%d start calls", put.count()-before)
			}
			if q := put.last(t); q.Method != http.MethodPut || q.URI != "/api/runs/"+id {
				t.Errorf("the start call: %s %s", q.Method, q.URI)
			}
			evs := rg.barrier(p)[0]
			state, draft := rg.runState(id)
			if row.swapped {
				b := body(t, rep)
				if rep.Status != http.StatusOK || b["id"] != id || b["group"] != "g_here" || b["server"] != rg.entry || b["status"] != "running" ||
					b["draft"] != nil || b["start"] != nil || b["was"] != nil {
					t.Errorf("the answer: %d %s", rep.Status, rep.Body)
				}
				if draft || !rg.runHanded(id) || !rg.r.HasRun(id) {
					t.Fatalf("no swap: a draft %v, handed over %v, a record %v", draft, rg.runHanded(id), rg.r.HasRun(id))
				}
				if d := rg.runFile(id); d.Entry != rg.entry || d.Group != "g_here" || d.View.Group != "g_there" || d.View.Status != model.RunRunning || d.Archived || d.Gone {
					t.Errorf("the record: %+v", d)
				}
				if got := types(evs); !reflect.DeepEqual(got, []string{"run"}) || field(evs[0], "run", "id") != id || field(evs[0], "run", "server") != rg.entry {
					t.Errorf("the page got %v", evs)
				}
				return
			}
			refused(t, "the answer", rep, row.want, row.wantCode, row.wantText)
			if !draft || state != row.wantState || rg.r.HasRun(id) || rg.runHanded(id) || !reflect.DeepEqual(rg.runTold(id), row.wantTold) {
				t.Errorf("after the call: a draft %v in the state %q, told %v, a record %v, handed over %v",
					draft, state, rg.runTold(id), rg.r.HasRun(id), rg.runHanded(id))
			}
			if len(evs) != 0 {
				t.Errorf("the page got %v", evs)
			}
		})
	}

	// The start call: the seven values, with no id, no group and nothing else of the draft.
	first := put.calls()[0]
	var sent map[string]any
	if err := json.Unmarshal([]byte(first.Body), &sent); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"name": "Colours", "userNamed": true, "agent": "claude", "cwd": "/home/standin/repo", "goal": "Make it red and blue",
		"tiers": map[string]any{"deep": map[string]any{"model": "deep-model", "effort": "high"},
			"standard": map[string]any{"model": "std-model"}, "light": map[string]any{"model": "light-model"}},
		"settings": map[string]any{"maxParallel": 4.0, "maxTurns": 30.0, "maxCost": 2.5, "setup": "make deps", "wake": "each", "applyResult": "auto"},
	}
	if !reflect.DeepEqual(sent, want) {
		t.Errorf("the start call's body: %s", first.Body)
	}
	for _, c := range put.calls() {
		noRunSecret(t, "a start call", c.Body)
	}
	b, err := os.ReadFile(rg.r.runFiles.path(runN(0)))
	if err != nil {
		t.Fatal(err)
	}
	noRunSecret(t, "the record's file", string(b))

	// 401 is the entry's matter: nothing is known of the run. (Last: the entry is then not connected.)
	id := runN(len(rows))
	rg.draftRun(id, model.RemoteUnconfirmed)
	put.answer(http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
	refused(t, "401", rg.r.StartRun(context.Background(), id, "Go"), http.StatusServiceUnavailable, "server_unreachable", "Studio is not connected.")
	if state, ok := rg.runState(id); !ok || state != model.RemoteUnconfirmed || len(rg.runTold(id)) != 0 {
		t.Errorf("after a 401: state %q, told %v", state, rg.runTold(id))
	}
	noRunSecret(t, "the log", strings.Join(rg.logs.all(), "\n"))
}

// TestRunStartNotSent: the calls that send nothing.
func TestRunStartNotSent(t *testing.T) {
	rec := runSeedOf(runA)
	rg := newRig(t, rigOpt{snapshot: snapshotWithRuns(rec.View), runSeed: []RunRecord{rec}})
	put := rg.script("PUT /api/runs/{id}")
	ctx := context.Background()

	refused(t, "a run nobody has", rg.r.StartRun(ctx, runN(1), "Go"), http.StatusNotFound, "", "no such run")
	// A record's run has started: the answer is its view.
	if rep := rg.r.StartRun(ctx, runA, "Go"); rep.Status != http.StatusOK || body(t, rep)["id"] != runA || body(t, rep)["server"] != rg.entry {
		t.Errorf("the start of a record: %d %s", rep.Status, rep.Body)
	}
	// A draft that a cut swap left under a record's id is handed over on the way.
	rg.draftRun(runA, model.RemoteUnconfirmed)
	if rep := rg.r.StartRun(ctx, runA, "Go"); rep.Status != http.StatusOK || body(t, rep)["id"] != runA || !rg.runHanded(runA) || len(rg.runTold(runA)) != 0 {
		t.Errorf("the start of a record with a draft left: %d %s, handed over %v", rep.Status, rep.Body, rg.runHanded(runA))
	}
	rg.draftRun(runN(2), "")
	refused(t, "a blank goal", rg.r.StartRun(ctx, runN(2), " \n\t"), http.StatusBadRequest, "", runs.ErrNoGoal.Error())
	archived := rg.draftRun(runN(3), "")
	archived.Archived = true
	rg.setDraftRun(archived)
	refused(t, "an archived draft", rg.r.StartRun(ctx, runN(3), "Go"), http.StatusConflict, "", runs.ErrArchived.Error())
	bare := rg.draftRun(runN(4), "")
	bare.Agent = ""
	rg.setDraftRun(bare)
	refused(t, "a draft with no agent", rg.r.StartRun(ctx, runN(4), "Go"), http.StatusConflict, "no_agent", "The run has no agent: choose one of Studio.")
	// An id of another form is the id of no run there, and of no record here.
	rg.draftRun("r_UPPER001", "")
	refused(t, "an id of another form", rg.r.StartRun(ctx, "r_UPPER001", "Go"), http.StatusBadRequest, "bad_id", runs.ErrBadID.Error())

	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	rg.draftRun(runN(5), model.RemoteUnconfirmed)
	refused(t, "while not connected", rg.r.StartRun(ctx, runN(5), "Go"), http.StatusServiceUnavailable, "server_unreachable", "Studio is not connected.")
	if state, ok := rg.runState(runN(5)); !ok || state != model.RemoteUnconfirmed {
		t.Errorf("after a call that was not sent: %q, %v", state, ok)
	}
	if put.count() != 0 || len(rg.runs.told(&rg.runs.starts)) != 0 || !reflect.DeepEqual(rg.runs.told(&rg.runs.handed), []string{runA}) {
		t.Errorf("%d start calls, told %v", put.count(), rg.runs.told(&rg.runs.starts))
	}
}

// TestRunStartNoAnswer: the start call gets no answer to go by, and the read settles it.
func TestRunStartNoAnswer(t *testing.T) {
	rg := newRig(t, rigOpt{limits: Limits{Start: 150 * time.Millisecond, Settle: 150 * time.Millisecond}})
	put := rg.script("PUT /api/runs/{id}")
	get := rg.script("GET /api/runs/{id}")
	_, release := put.hang()
	defer release()
	ctx := context.Background()

	t.Run("the run has started there", func(t *testing.T) {
		id := runN(1)
		rg.draftRun(id, "")
		serveRunViews(get, model.RunRunning)
		if rep := rg.r.StartRun(ctx, id, "Go"); rep.Status != http.StatusOK || body(t, rep)["id"] != id {
			t.Errorf("the answer: %d %s", rep.Status, rep.Body)
		}
		if !rg.r.HasRun(id) || !rg.runHanded(id) || !reflect.DeepEqual(rg.runTold(id), []string{model.RemoteUnconfirmed}) {
			t.Errorf("a record %v, handed over %v, told %v", rg.r.HasRun(id), rg.runHanded(id), rg.runTold(id))
		}
		if q := get.calls()[0]; q.URI != "/api/runs/"+id {
			t.Errorf("the settle read: %+v", q)
		}
	})
	t.Run("the run is not there", func(t *testing.T) {
		id := runN(2)
		rg.draftRun(id, "")
		get.answer(http.StatusNotFound, map[string]string{"error": "no such run"})
		refused(t, "the answer", rg.r.StartRun(ctx, id, "Go"), http.StatusBadGateway, "not_started", runNotStarted)
		if state, ok := rg.runState(id); !ok || state != "" || rg.r.HasRun(id) ||
			!reflect.DeepEqual(rg.runTold(id), []string{model.RemoteUnconfirmed, ""}) {
			t.Errorf("state %q, told %v", state, rg.runTold(id))
		}
	})
	t.Run("the read gets no answer either", func(t *testing.T) {
		id := runN(3)
		rg.draftRun(id, "")
		_, free := get.hang()
		defer free()
		start := time.Now()
		refused(t, "the answer", rg.r.StartRun(ctx, id, "Go"), http.StatusGatewayTimeout, "start_unconfirmed", runUnconfirmed)
		if took := time.Since(start); took < 300*time.Millisecond || took > 3*time.Second {
			t.Errorf("the two limits took %v", took)
		}
		if state, ok := rg.runState(id); !ok || state != model.RemoteUnconfirmed || rg.r.HasRun(id) {
			t.Errorf("state %q, a draft %v", state, ok)
		}
	})
	t.Run("a read that tells nothing definite", func(t *testing.T) {
		for i, answer := range []func(w http.ResponseWriter, r *http.Request){
			func(w http.ResponseWriter, r *http.Request) { // a draft under the id
				writeAnswer(w, http.StatusOK, remoteRun(r.PathValue("id"), model.RunDraft))
			},
			func(w http.ResponseWriter, r *http.Request) { // another run
				writeAnswer(w, http.StatusOK, remoteRun(runB, model.RunRunning))
			},
			func(w http.ResponseWriter, r *http.Request) { // a 404 that is not "no such run"
				writeAnswer(w, http.StatusNotFound, map[string]string{"error": "not found"})
			},
			func(w http.ResponseWriter, r *http.Request) {
				writeAnswer(w, http.StatusInternalServerError, map[string]string{"error": "boom"})
			},
		} {
			id := runN(10 + i)
			rg.draftRun(id, "")
			get.set(answer)
			refused(t, fmt.Sprintf("read %d", i), rg.r.StartRun(ctx, id, "Go"), http.StatusGatewayTimeout, "start_unconfirmed", runUnconfirmed)
			if state, ok := rg.runState(id); !ok || state != model.RemoteUnconfirmed || rg.r.HasRun(id) {
				t.Errorf("read %d: state %q, a draft %v, a record %v", i, state, ok, rg.r.HasRun(id))
			}
		}
	})
	t.Run("a success that tells nothing", func(t *testing.T) {
		id := runN(4)
		rg.draftRun(id, "")
		put.answer(http.StatusOK, map[string]any{"ok": true})
		serveRunViews(get, model.RunRunning)
		if rep := rg.r.StartRun(ctx, id, "Go"); rep.Status != http.StatusOK || !rg.r.HasRun(id) ||
			!reflect.DeepEqual(rg.runTold(id), []string{model.RemoteUnconfirmed}) {
			t.Errorf("the answer: %d %s, a record %v, told %v", rep.Status, rep.Body, rg.r.HasRun(id), rg.runTold(id))
		}
	})
	t.Run("a success that started nothing", func(t *testing.T) {
		id := runN(5)
		rg.draftRun(id, "")
		put.answer(http.StatusOK, runAnswerOf(false, false, nil, "", ""))
		get.answer(http.StatusNotFound, map[string]string{"error": "no such run"})
		refused(t, "the answer", rg.r.StartRun(ctx, id, "Go"), http.StatusBadGateway, "not_started", runNotStarted)
	})
	t.Run("started without the run", func(t *testing.T) {
		id := runN(6)
		rg.draftRun(id, "")
		put.answer(http.StatusOK, runAnswerOf(true, true, nil, "", ""))
		serveRunViews(get, model.RunStopped)
		rep := rg.r.StartRun(ctx, id, "Go")
		if rep.Status != http.StatusOK || body(t, rep)["status"] != "stopped" || !rg.r.HasRun(id) || !rg.runHanded(id) {
			t.Errorf("the answer: %d %s, a record %v", rep.Status, rep.Body, rg.r.HasRun(id))
		}
	})
}

// TestRunSettleAtSnapshot: step 3 of a snapshot for the draft runs of the entry.
func TestRunSettleAtSnapshot(t *testing.T) {
	startedID, absentID, quietID, cutID, madeID, recID, lostID, busyID := runN(1), runN(2), runN(3), runN(4), runN(5), runN(6), runN(7), runN(8)
	other := "r_other001"
	rec, lost := runSeedOf(recID), runSeedOf(lostID)
	rec.View.Cwd = "/home/standin/kept"
	snap := snapshotWithRuns(remoteRun(startedID, model.RunStopped), remoteRun(cutID, model.RunRunning),
		remoteRun(madeID, model.RunDraft), remoteRun(recID, model.RunRunning), remoteRun(busyID, model.RunRunning))

	var get *script
	var free func()
	rg := newRig(t, rigOpt{snapshot: snap, runSeed: []RunRecord{rec, lost}, hold: true, wire: func(rg *rig) {
		get = rg.script("GET /api/runs/{id}")
		get.answer(http.StatusNotFound, map[string]string{"error": "no such run"})
		rg.draftRun(startedID, model.RemoteUnconfirmed)
		rg.draftRun(absentID, model.RemoteUnconfirmed)
		rg.draftRun(quietID, "") // nothing of it ever left, and it is not there: it is told nothing
		rg.draftRun(cutID, "")   // no mark, and it has started there
		rg.draftRun(madeID, model.RemoteUnconfirmed)
		rg.draftRun(recID, "") // a swap was cut after its first step
		rg.draftRun(lostID, model.RemoteUnconfirmed)
		rg.draftRun(busyID, model.RemoteUnconfirmed)
		away := rg.draftRun(other, model.RemoteUnconfirmed)
		away.Server = "s_000000000000" // a draft of another entry
		rg.setDraftRun(away)
		free, _ = rg.r.locks.runStart.try(busyID) // its start is being made right now
		// A goal that is kept for a draft that is gone is forgotten, one of a draft that stays is not.
		rg.r.keepGoal("r_gone0001", rg.entry, [32]byte{1})
		rg.r.keepGoal(busyID, rg.entry, [32]byte{2})
	}})
	defer free()
	p, _ := rg.page("page-1")
	rg.start()

	for _, id := range []string{startedID, cutID} {
		if _, draft := rg.runState(id); draft || !rg.r.HasRun(id) || !rg.runHanded(id) || len(rg.runTold(id)) != 0 {
			t.Fatalf("the run %s that has started there: a draft %v, a record %v, handed over %v, told %v",
				id, draft, rg.r.HasRun(id), rg.runHanded(id), rg.runTold(id))
		}
	}
	if d := rg.runFile(startedID); d.View.Status != model.RunStopped || d.Group != "g_here" || d.Entry != rg.entry {
		t.Errorf("the record: %+v", d)
	}
	// The draft with the mark that the snapshot does not have is read there, off the worker: the
	// snapshot says nothing of a start that is under way.
	rg.until("the draft that is not there is settled by a read", func() bool {
		state, _ := rg.runState(absentID)
		return state == "" && !rg.r.Starting(absentID)
	})
	for id, want := range map[string]string{absentID: "", quietID: "", madeID: model.RemoteUnconfirmed, busyID: model.RemoteUnconfirmed, other: model.RemoteUnconfirmed} {
		if state, ok := rg.runState(id); !ok || state != want || rg.r.HasRun(id) || rg.runHanded(id) {
			t.Errorf("the draft %s: state %q, a draft %v, a record %v", id, state, ok, rg.r.HasRun(id))
		}
	}
	if got := rg.runTold(absentID); !reflect.DeepEqual(got, []string{""}) {
		t.Errorf("the draft that is not there was told %v", got)
	}
	for _, id := range []string{quietID, madeID, busyID, other} {
		if got := rg.runTold(id); len(got) != 0 {
			t.Errorf("the draft %s was told %v", id, got)
		}
	}
	// A draft that has a record is handed over with the record's view, and nothing else.
	for _, id := range []string{recID, lostID} {
		if _, draft := rg.runState(id); draft || !rg.runHanded(id) || !rg.r.HasRun(id) || len(rg.runTold(id)) != 0 {
			t.Errorf("the draft %s with a record: a draft %v, handed over %v, told %v", id, draft, rg.runHanded(id), rg.runTold(id))
		}
	}
	rg.runs.mu.Lock()
	for i, id := range rg.runs.handed {
		if id == recID && rg.runs.views[i].ID != recID {
			t.Errorf("the record's view was not handed over: %+v", rg.runs.views[i])
		}
	}
	rg.runs.mu.Unlock()
	if v := rg.r.runRec(lostID).view(); !v.Gone {
		t.Errorf("the record the snapshot does not have: %+v", v)
	}
	if calls := get.calls(); len(calls) != 1 || calls[0].URI != "/api/runs/"+absentID {
		t.Errorf("settling at a snapshot read %+v, want the draft with the mark that is not there", calls)
	}
	if rg.r.goalOther("r_gone0001", rg.entry, [32]byte{9}) || !rg.r.goalOther(busyID, rg.entry, [32]byte{9}) {
		t.Error("the goals kept after the snapshot")
	}
	// The page: the lists, the two swaps, then the return with the four records.
	var evs []map[string]any
	for range 8 {
		evs = append(evs, p.Next())
	}
	want := []string{"server_lists", "run", "run", "server_back", "run", "run", "run", "run"}
	if got := types(evs); !reflect.DeepEqual(got, want) {
		t.Fatalf("the page got %v", got)
	}
	if field(evs[1], "run", "id") != startedID || field(evs[1], "run", "status") != "stopped" || field(evs[2], "run", "id") != cutID {
		t.Errorf("the swaps: %v\n%v", evs[1], evs[2])
	}
}

// TestRunStartOnce: of any number of start calls at once for one run, one is sent.
func TestRunStartOnce(t *testing.T) {
	rg := newRig(t, rigOpt{})
	put := rg.script("PUT /api/runs/{id}")
	get := rg.script("GET /api/runs/{id}")
	serveRunViews(get, model.RunRunning)
	rg.draftRun(runA, "")
	view := remoteRun(runA, model.RunRunning)
	hold := make(chan struct{})
	put.set(func(w http.ResponseWriter, r *http.Request) {
		<-hold
		writeAnswer(w, http.StatusOK, runAnswerOf(true, true, &view, "", ""))
	})

	const n = 24
	out := make(chan Reply, n)
	for range n {
		go func() { out <- rg.r.StartRun(context.Background(), runA, "Go") }()
	}
	for range n - 1 {
		refused(t, "a call while another is under way", <-out, http.StatusConflict, "busy", "The run is being started.")
	}
	close(hold)
	if rep := <-out; rep.Status != http.StatusOK {
		t.Errorf("the call that was sent: %d %s", rep.Status, rep.Body)
	}
	if put.count() != 1 {
		t.Errorf("%d start calls, want 1", put.count())
	}
	// The run has started: a start that comes now is answered with the record's view.
	if rep := rg.r.StartRun(context.Background(), runA, "Go"); rep.Status != http.StatusOK || body(t, rep)["id"] != runA || put.count() != 1 {
		t.Errorf("a start for a started run: %d %s, %d calls", rep.Status, rep.Body, put.count())
	}
}

// TestRunSwapOrder: the swap as a page sees it, and its order here: the record is there before
// the run service lets go of the draft, and the read after it never puts an older view over a
// newer one.
func TestRunSwapOrder(t *testing.T) {
	rg := newRig(t, rigOpt{})
	put := rg.script("PUT /api/runs/{id}")
	get := rg.script("GET /api/runs/{id}")
	p, _ := rg.page("page-1")

	var mu sync.Mutex
	recordFirst := map[string]bool{}
	rg.runs.mu.Lock()
	rg.runs.onHand = func(id string) {
		mu.Lock()
		defer mu.Unlock()
		recordFirst[id] = rg.r.HasRun(id) && len(rg.r.RunViews()) > 0
	}
	rg.runs.mu.Unlock()

	start := func(id string) []map[string]any {
		t.Helper()
		rg.draftRun(id, "")
		view := remoteRun(id, model.RunRunning)
		put.answer(http.StatusOK, runAnswerOf(true, true, &view, "", ""))
		if rep := rg.r.StartRun(context.Background(), id, "Go"); rep.Status != http.StatusOK {
			t.Fatalf("the answer: %d %s", rep.Status, rep.Body)
		}
		return rg.barrier(p)[0]
	}

	// The read after the swap tells what the answer told: one event.
	serveRunViews(get, model.RunRunning)
	evs := start(runN(1))
	if got := types(evs); !reflect.DeepEqual(got, []string{"run"}) {
		t.Fatalf("the page got %v", got)
	}
	run := evs[0]["run"]
	if field(run, "id") != runN(1) || field(run, "group") != "g_here" || field(run, "server") != rg.entry || field(run, "status") != "running" ||
		field(run, "started") == nil || field(run, "draft") != nil || field(run, "start") != nil || field(run, "was") != nil || field(run, "tierDefaults") != nil {
		t.Errorf("the view: %v", run)
	}

	// The read tells more than the answer did: the events before the record was there were dropped.
	serveRunViews(get, model.RunStopped)
	evs = start(runN(2))
	if got := types(evs); !reflect.DeepEqual(got, []string{"run", "run"}) ||
		field(evs[0], "run", "status") != "running" || field(evs[1], "run", "status") != "stopped" {
		t.Fatalf("the page got %v", evs)
	}

	// An event of the run is applied while the read is under way: the read's older view is not taken.
	get.set(func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		newer := remoteRun(id, model.RunRunning)
		newer.Turns = 7
		rg.s.Send(map[string]any{"type": "run", "run": newer})
		for end := time.Now().Add(wait); time.Now().Before(end); time.Sleep(2 * time.Millisecond) {
			if rec := rg.r.runRec(id); rec != nil && rec.view().Turns == 7 {
				break
			}
		}
		older := remoteRun(id, model.RunRunning)
		older.Turns = 3
		writeAnswer(w, http.StatusOK, older)
	})
	evs = start(runN(3))
	if got := types(evs); !reflect.DeepEqual(got, []string{"run", "run"}) || field(evs[1], "run", "turns") != 7.0 {
		t.Fatalf("the page got %v", evs)
	}
	if v := rg.r.runRec(runN(3)).view(); v.Turns != 7 {
		t.Errorf("the record took the read's older view: %+v", v)
	}

	mu.Lock()
	defer mu.Unlock()
	for _, id := range []string{runN(1), runN(2), runN(3)} {
		if !recordFirst[id] {
			t.Errorf("the draft %s was handed over before its record was there", id)
		}
	}
	rg.runs.mu.Lock()
	defer rg.runs.mu.Unlock()
	if v := rg.runs.views[0]; v.ID != runN(1) || v.Cwd != "/home/standin/work" || v.Group != "g_there" {
		t.Errorf("HandOver got the view %+v", v)
	}
	if get.count() != 3 {
		t.Errorf("%d reads after three swaps", get.count())
	}
}

// TestRunStartIDTaken: 409 id_taken gives the draft a new id, and the call is made once more.
func TestRunStartIDTaken(t *testing.T) {
	rg := newRig(t, rigOpt{})
	put := rg.script("PUT /api/runs/{id}")
	get := rg.script("GET /api/runs/{id}")
	serveRunViews(get, model.RunRunning)
	ctx := context.Background()
	var mu sync.Mutex
	taken := map[string]bool{}
	take := func(ids ...string) {
		mu.Lock()
		defer mu.Unlock()
		for _, id := range ids {
			taken[id] = true
		}
	}
	put.set(func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		mu.Lock()
		refuse := taken[id]
		mu.Unlock()
		if refuse {
			writeAnswer(w, http.StatusConflict, runAnswerOf(false, false, nil, "a run with this id already exists", "id_taken"))
			return
		}
		view := remoteRun(id, model.RunRunning)
		writeAnswer(w, http.StatusOK, runAnswerOf(true, true, &view, "", ""))
	})
	uris := func() []string {
		var out []string
		for _, c := range put.calls() {
			out = append(out, c.URI)
		}
		return out
	}

	// One new id, one repeat, the same goal.
	take(runN(1))
	rg.draftRun(runN(1), model.RemoteUnconfirmed)
	rg.runs.mu.Lock()
	rg.runs.next = []string{runN(2)}
	rg.runs.mu.Unlock()
	rep := rg.r.StartRun(ctx, runN(1), "Go on")
	if rep.Status != http.StatusOK || body(t, rep)["id"] != runN(2) || !rg.r.HasRun(runN(2)) || rg.r.HasRun(runN(1)) || !rg.runHanded(runN(2)) {
		t.Errorf("the answer: %d %s", rep.Status, rep.Body)
	}
	if got := rg.runs.told(&rg.runs.reissued); !reflect.DeepEqual(got, []string{runN(1) + ">" + runN(2)}) {
		t.Errorf("reissued: %v", got)
	}
	if got := uris(); !reflect.DeepEqual(got, []string{"/api/runs/" + runN(1), "/api/runs/" + runN(2)}) {
		t.Errorf("the start calls: %v", got)
	}
	if c := put.calls(); c[0].Body != c[1].Body || !strings.Contains(c[1].Body, `"goal":"Go on"`) {
		t.Errorf("the repeat's body: %s", c[1].Body)
	}

	// A second id_taken is handed on: no third call, no second new id.
	take(runN(3), runN(4))
	rg.draftRun(runN(3), "")
	rg.runs.mu.Lock()
	rg.runs.next = []string{runN(4), runN(5)}
	rg.runs.mu.Unlock()
	refused(t, "a second id_taken", rg.r.StartRun(ctx, runN(3), "Go on"), http.StatusConflict, "id_taken", "a run with this id already exists")
	if got := rg.runs.told(&rg.runs.reissued); len(got) != 2 || put.count() != 4 {
		t.Errorf("reissued %v, %d calls", got, put.count())
	}
	if state, ok := rg.runState(runN(4)); !ok || state != "" || rg.r.HasRun(runN(4)) {
		t.Errorf("the draft after two refusals: %q, %v", state, ok)
	}

	// No new id can be made: the refusal is handed on, and nothing of the call is there.
	take(runN(6))
	rg.draftRun(runN(6), model.RemoteUnconfirmed)
	rg.runs.mu.Lock()
	rg.runs.next = nil
	rg.runs.mu.Unlock()
	refused(t, "no new id", rg.r.StartRun(ctx, runN(6), "Go on"), http.StatusConflict, "id_taken", "a run with this id already exists")
	if state, ok := rg.runState(runN(6)); !ok || state != "" || put.count() != 5 {
		t.Errorf("the draft: %q, %v, %d calls", state, ok, put.count())
	}
}

// TestRunGoalKept: a start call that finds the run started by an earlier call with another goal
// makes the swap and tells the page that its text was not sent.
func TestRunGoalKept(t *testing.T) {
	rg := newRig(t, rigOpt{limits: Limits{Start: 150 * time.Millisecond, Settle: 150 * time.Millisecond}})
	put := rg.script("PUT /api/runs/{id}")
	get := rg.script("GET /api/runs/{id}")
	ctx := context.Background()
	const kept = "Studio had already started the run with the earlier goal; this text was not sent."
	// lost makes a start call with the goal that gets no answer; the read answers as read says.
	lost := func(id, goal string, definite bool) {
		t.Helper()
		_, free := put.hang()
		defer free()
		want, release := http.StatusGatewayTimeout, func() {}
		if definite {
			want = http.StatusBadGateway
			get.answer(http.StatusNotFound, map[string]string{"error": "no such run"})
		} else {
			_, release = get.hang()
		}
		defer release()
		if rep := rg.r.StartRun(ctx, id, goal); rep.Status != want {
			t.Fatalf("the lost call: %d %s", rep.Status, rep.Body)
		}
	}
	// repeat makes a start call that is answered "started" for the run the server already has.
	repeat := func(id, goal string, made bool) Reply {
		t.Helper()
		view := remoteRun(id, model.RunRunning)
		put.answer(http.StatusOK, runAnswerOf(true, made, &view, "", ""))
		serveRunViews(get, model.RunRunning)
		return rg.r.StartRun(ctx, id, goal)
	}

	rg.draftRun(runN(1), "")
	lost(runN(1), "The first goal", false)
	refused(t, "another goal", repeat(runN(1), "A second goal", false), http.StatusConflict, "goal_kept", kept)
	if _, draft := rg.runState(runN(1)); draft || !rg.r.HasRun(runN(1)) || !rg.runHanded(runN(1)) {
		t.Error("the swap was not made for a goal that was kept")
	}

	rg.draftRun(runN(2), "")
	lost(runN(2), "The first goal", false)
	if rep := repeat(runN(2), "The first goal", false); rep.Status != http.StatusOK || !rg.r.HasRun(runN(2)) {
		t.Errorf("a repeat with the same goal: %d %s", rep.Status, rep.Body)
	}

	rg.draftRun(runN(3), model.RemoteUnconfirmed) // a call of an earlier process: no goal is known
	if rep := repeat(runN(3), "Any goal", false); rep.Status != http.StatusOK {
		t.Errorf("a repeat with no earlier call known: %d %s", rep.Status, rep.Body)
	}

	rg.draftRun(runN(4), "")
	lost(runN(4), "The first goal", true) // a definite "not started" drops the goal
	if rep := repeat(runN(4), "A second goal", false); rep.Status != http.StatusOK {
		t.Errorf("a repeat after a definite refusal: %d %s", rep.Status, rep.Body)
	}

	rg.draftRun(runN(5), "")
	lost(runN(5), "The first goal", false)
	rg.r.DropRun(rg.entry, runN(5)) // the draft goes
	if rep := repeat(runN(5), "A second goal", false); rep.Status != http.StatusOK {
		t.Errorf("a repeat after the draft went: %d %s", rep.Status, rep.Body)
	}

	rg.draftRun(runN(6), "")
	lost(runN(6), "The first goal", false)
	if rep := repeat(runN(6), "A second goal", true); rep.Status != http.StatusOK {
		t.Errorf("a call that made the run itself: %d %s", rep.Status, rep.Body)
	}
	// The last call sent counts: a goal that was sent again is the one that is kept.
	rg.draftRun(runN(7), "")
	lost(runN(7), "The first goal", false)
	lost(runN(7), "A second goal", false)
	if rep := repeat(runN(7), "A second goal", false); rep.Status != http.StatusOK {
		t.Errorf("a repeat of the last goal sent: %d %s", rep.Status, rep.Body)
	}
	for _, c := range put.calls() {
		noRunSecret(t, "a start call", c.Body)
	}
	noRunSecret(t, "the log", strings.Join(rg.logs.all(), "\n"))
}

// TestCheckDraft: the draft check of an entry, as the run service asks it.
func TestCheckDraft(t *testing.T) {
	rg := newRig(t, rigOpt{limits: Limits{Check: 150 * time.Millisecond}})
	check := rg.script("GET /api/runs/check")
	facts := runs.DraftFacts{Cwd: "/home/standin/repo", Git: true, Dirty: true, Blocked: "the folder has no commit yet"}
	check.answer(http.StatusOK, facts)
	if got, err := rg.r.CheckDraft(rg.entry, model.Claude, "~/repo"); err != nil || got != facts {
		t.Errorf("the check: %+v, %v", got, err)
	}
	if q := check.last(t); q.Method != http.MethodGet || q.URI != "/api/runs/check?agent=claude&cwd=~%2Frepo" && q.URI != "/api/runs/check?agent=claude&cwd=%7E%2Frepo" {
		t.Errorf("the server got %+v", q)
	}
	check.answer(http.StatusOK, runs.DraftFacts{Cwd: "/home/standin/none", FolderMissing: true})
	if got, err := rg.r.CheckDraft(rg.entry, "", "/home/standin/none"); err != nil || !got.FolderMissing || got.Git {
		t.Errorf("a missing folder: %+v, %v", got, err)
	}
	if q := check.last(t); q.URI != "/api/runs/check?cwd=%2Fhome%2Fstandin%2Fnone" {
		t.Errorf("a check with no agent: %+v", q)
	}
	// A server without run routes.
	check.set(nil)
	if _, err := rg.r.CheckDraft(rg.entry, model.Claude, "/x"); !errors.Is(err, runs.ErrRunsUnsupported) {
		t.Errorf("404 not found: %v", err)
	}
	// A refusal is the server's sentence; an answer that is no check is not taken.
	check.answer(http.StatusBadRequest, map[string]string{"error": "a draft check needs a folder", "code": "bad_request"})
	var e *Error
	if _, err := rg.r.CheckDraft(rg.entry, model.Claude, "/x"); !errors.As(err, &e) || e.Status != http.StatusBadRequest || e.Text != "a draft check needs a folder" {
		t.Errorf("a refusal: %v", err)
	}
	check.answer(http.StatusOK, map[string]string{"ok": "yes"})
	if _, err := rg.r.CheckDraft(rg.entry, model.Claude, "/x"); !errors.As(err, &e) || e.Code != "bad_answer" {
		t.Errorf("an answer that is no check: %v", err)
	}
	// No answer: the check ends within its own short limit.
	_, free := check.hang()
	defer free()
	start := time.Now()
	if _, err := rg.r.CheckDraft(rg.entry, model.Claude, "/x"); !errors.Is(err, ErrNoAnswer) || errors.Is(err, chats.ErrServerUnreachable) {
		t.Errorf("a check without an answer: %v", err)
	}
	if took := time.Since(start); took < 100*time.Millisecond || took > 2*time.Second {
		t.Errorf("a check without an answer took %v", took)
	}
	// Not connected: nothing is sent.
	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	sent := check.count()
	if _, err := rg.r.CheckDraft(rg.entry, model.Claude, "/x"); !errors.Is(err, chats.ErrServerUnreachable) || check.count() != sent {
		t.Errorf("a check while not connected: %v", err)
	}
	noRunSecret(t, "the log", strings.Join(rg.logs.all(), "\n"))
}

// TestRunInfoAndDropRun: what the chat manager and the run service get of a run record, and the
// delete of the run a deleted draft may have left.
func TestRunInfoAndDropRun(t *testing.T) {
	a, b := runSeedOf(runA), runSeedOf(runB)
	a.View.Tiers.Deep = model.ModelChoice{Model: "deep-model", Effort: "high"}
	b.Gone = true
	rg := newRig(t, rigOpt{snapshot: snapshotWithRuns(a.View), runSeed: []RunRecord{a, b}})
	del := rg.script("DELETE /api/runs/{id}")
	del.answer(http.StatusOK, map[string]bool{"ok": true})

	want := chats.RunInfo{Group: "g_here", Cwd: "/home/standin/work", Agent: model.Claude, Model: "deep-model", Effort: "high", Server: rg.entry}
	if got, ok := rg.r.RunInfo(runA); !ok || got != want {
		t.Errorf("RunInfo: %+v, %v", got, ok)
	}
	if _, ok := rg.r.RunInfo(runB); ok {
		t.Error("RunInfo of a gone record")
	}
	if _, ok := rg.r.RunInfo(runN(1)); ok {
		t.Error("RunInfo without a record")
	}
	// The mark that shows is the mark a chat on the run goes by: a pending archive too.
	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	if err := rg.r.ArchiveRun(context.Background(), runA, "a_1"); err != nil {
		t.Fatal(err)
	}
	if got, ok := rg.r.RunInfo(runA); !ok || !got.Archived {
		t.Errorf("RunInfo of a run that is being archived: %+v, %v", got, ok)
	}
	// Not connected: nothing is sent for a deleted draft.
	rg.r.DropRun(rg.entry, runN(2))
	rg.s.Restart()
	rg.returned(2)
	rg.r.DropRun(rg.entry, "r_UPPER001")
	rg.r.DropRun(rg.entry, runN(3))
	rg.until("the run of the deleted draft is deleted there", func() bool { return del.count() == 1 })
	time.Sleep(quiet)
	if q := del.calls(); len(q) != 1 || q[0].URI != "/api/runs/"+runN(3) {
		t.Errorf("the deletes: %+v", q)
	}
}

// TestRunStartEndsAfterTheSnapshot: a start call got no answer, and the server finishes the
// start after this server took its snapshot. The server lists a run only when its start is
// done, so the snapshot does not have it: the draft keeps its mark while the read of the run
// tells nothing, and the run's event makes the swap.
func TestRunStartEndsAfterTheSnapshot(t *testing.T) {
	rg := newRig(t, rigOpt{limits: Limits{Start: 150 * time.Millisecond, Settle: 150 * time.Millisecond}})
	put := rg.script("PUT /api/runs/{id}")
	get := rg.script("GET /api/runs/{id}")
	del := rg.script("DELETE /api/runs/{id}")
	_, release := put.hang()
	defer release()
	_, free := get.hang()
	defer free()
	p, _ := rg.page("page-1")
	id := runN(1)
	rg.draftRun(id, "")

	// 1. The start gets no answer, and the read after it none either.
	refused(t, "the start", rg.r.StartRun(context.Background(), id, "Go"), http.StatusGatewayTimeout, "start_unconfirmed", runUnconfirmed)
	// 2. The stream drops and returns, with a snapshot that does not have the run. The read that
	// settles the draft hangs: the mark stays.
	rg.s.DropStreams()
	rg.returned(2)
	rg.until("the snapshot's read of the run has ended", func() bool { return get.count() == 2 && !rg.r.Starting(id) })
	if state, ok := rg.runState(id); !ok || state != model.RemoteUnconfirmed || rg.r.HasRun(id) ||
		!reflect.DeepEqual(rg.runTold(id), []string{model.RemoteUnconfirmed}) {
		t.Fatalf("after the snapshot without the run: state %q, a draft %v, told %v", state, ok, rg.runTold(id))
	}
	p.Expect("server_lists") // the snapshot's
	p.Expect("server_back")
	if evs := rg.barrier(p)[0]; len(evs) != 0 {
		t.Fatalf("the page got %v", evs)
	}
	// 3. The server has finished the start: its event of the run makes the swap, with no read.
	view := remoteRun(id, model.RunRunning)
	view.Turns = 2
	rg.s.Send(map[string]any{"type": "run", "run": view})
	evs := rg.barrier(p)[0]
	if got := types(evs); !reflect.DeepEqual(got, []string{"run"}) {
		t.Fatalf("the page got %v", evs)
	}
	if run := evs[0]["run"]; field(run, "id") != id || field(run, "started") == nil || field(run, "status") != "running" ||
		field(run, "turns") != 2.0 || field(run, "server") != rg.entry || field(run, "group") != "g_here" || field(run, "start") != nil {
		t.Errorf("the view: %v", run)
	}
	if _, draft := rg.runState(id); draft || !rg.r.HasRun(id) || !rg.runHanded(id) || rg.r.Starting(id) {
		t.Errorf("after the run's event: a draft %v, a record %v, handed over %v", draft, rg.r.HasRun(id), rg.runHanded(id))
	}
	if d := rg.runFile(id); d.Entry != rg.entry || d.Group != "g_here" || d.View.Turns != 2 {
		t.Errorf("the record: %+v", d)
	}
	if get.count() != 2 || del.count() != 0 || put.count() != 1 {
		t.Errorf("the swap at an event: %d reads, %d deletes, %d start calls", get.count(), del.count(), put.count())
	}
	// The events that follow are the record's.
	view.Status = model.RunStopped
	rg.s.Send(map[string]any{"type": "run", "run": view})
	if evs := rg.barrier(p)[0]; len(evs) != 1 || field(evs[0], "run", "status") != "stopped" {
		t.Errorf("the next event of the run: %v", evs)
	}
}

// TestRunSettledByARead: what the read of a draft with the mark, which the snapshot does not
// have, makes of each answer, and that a draft without the mark is asked nothing of.
func TestRunSettledByARead(t *testing.T) {
	startedID, absentID, quietID := runN(1), runN(2), runN(3)
	var get *script
	rg := newRig(t, rigOpt{hold: true, wire: func(rg *rig) {
		get = rg.script("GET /api/runs/{id}")
		get.set(func(w http.ResponseWriter, r *http.Request) {
			if id := r.PathValue("id"); id == startedID {
				writeAnswer(w, http.StatusOK, remoteRun(id, model.RunStopped))
				return
			}
			writeAnswer(w, http.StatusNotFound, map[string]string{"error": "no such run"})
		})
		rg.draftRun(startedID, model.RemoteUnconfirmed)
		rg.draftRun(absentID, model.RemoteUnconfirmed)
		rg.draftRun(quietID, "")
		rg.r.keepGoal(startedID, rg.entry, [32]byte{1})
		rg.r.keepGoal(absentID, rg.entry, [32]byte{2})
	}})
	p, _ := rg.page("page-1")
	rg.start()
	rg.until("the two drafts with the mark are settled", func() bool {
		state, _ := rg.runState(absentID)
		return rg.r.HasRun(startedID) && state == "" && !rg.r.Starting(startedID) && !rg.r.Starting(absentID)
	})
	// Started there: the swap, and the view is read once more as after every swap of a call.
	if _, draft := rg.runState(startedID); draft || !rg.runHanded(startedID) || rg.runFile(startedID).View.Status != model.RunStopped {
		t.Errorf("the draft that has started there: a draft %v, handed over %v", draft, rg.runHanded(startedID))
	}
	// Not there: the mark is cleared, and the goal that was kept for it is forgotten.
	if state, ok := rg.runState(absentID); !ok || state != "" || rg.r.HasRun(absentID) || !reflect.DeepEqual(rg.runTold(absentID), []string{""}) ||
		rg.r.goalOther(absentID, rg.entry, [32]byte{9}) {
		t.Errorf("the draft that is not there: state %q, a draft %v, told %v", state, ok, rg.runTold(absentID))
	}
	// No mark: nothing is asked and nothing is told.
	if state, ok := rg.runState(quietID); !ok || state != "" || len(rg.runTold(quietID)) != 0 {
		t.Errorf("the draft without a mark: state %q, a draft %v, told %v", state, ok, rg.runTold(quietID))
	}
	for _, c := range get.calls() {
		if c.URI == "/api/runs/"+quietID {
			t.Errorf("the draft without a mark was read: %+v", c)
		}
	}
	// The page: the first barrier ends at the lists of the snapshot, the second one at the first.
	runEvents := 0
	for _, ev := range append(rg.barrier(p)[0], rg.barrier(p)[0]...) {
		if ev["type"] == "run" && field(ev, "run", "id") == startedID && field(ev, "run", "status") == "stopped" {
			runEvents++
		}
	}
	if runEvents == 0 {
		t.Error("the page got no event of the run that the read found started")
	}
}

// TestRunEventOfADraft: which events of a run without a record make the swap.
func TestRunEventOfADraft(t *testing.T) {
	rg := newRig(t, rigOpt{})
	get := rg.script("GET /api/runs/{id}")
	p, _ := rg.page("page-1")
	send := func(v model.RunView) []map[string]any {
		t.Helper()
		rg.s.Send(map[string]any{"type": "run", "run": v})
		return rg.barrier(p)[0]
	}
	left := func(what, id string) {
		t.Helper()
		if _, draft := rg.runState(id); !draft || rg.r.HasRun(id) || rg.runHanded(id) {
			t.Errorf("%s: a draft %v, a record %v, handed over %v", what, draft, rg.r.HasRun(id), rg.runHanded(id))
		}
	}

	// A draft there under the id says nothing of a start.
	id := runN(1)
	rg.draftRun(id, "")
	if evs := send(remoteRun(id, model.RunDraft)); len(evs) != 0 {
		t.Errorf("the page got %v", evs)
	}
	left("a draft there", id)
	// Another server's event is not this draft's.
	raw, _ := json.Marshal(map[string]any{"type": "run", "run": remoteRun(id, model.RunRunning)})
	rg.r.event("s_other", "run", raw)
	left("another server's event", id)
	// A draft of another server is not started by this one's event.
	away := rg.draftRun(runN(2), "")
	away.Server = "s_000000000000"
	rg.setDraftRun(away)
	if evs := send(remoteRun(away.ID, model.RunRunning)); len(evs) != 0 {
		t.Errorf("the page got %v", evs)
	}
	if meta, ok := rg.runs.RemoteDraft(away.ID); !ok || meta.Server != away.Server || rg.r.HasRun(away.ID) {
		t.Error("a draft of another server was taken")
	}
	// Started, with no mark on the draft: this server's process ended in the start call.
	if evs := send(remoteRun(id, model.RunRunning)); len(evs) != 1 || field(evs[0], "run", "id") != id || field(evs[0], "run", "started") == nil {
		t.Errorf("the page got %v", evs)
	}
	if _, draft := rg.runState(id); draft || !rg.r.HasRun(id) || !rg.runHanded(id) || len(rg.runTold(id)) != 0 {
		t.Errorf("the started run: a draft %v, a record %v, told %v", draft, rg.r.HasRun(id), rg.runTold(id))
	}
	if get.count() != 0 {
		t.Errorf("the swap at an event read the run %d times", get.count())
	}
}

// TestRunChangedInAStart: the run service has no draft on the entry any more when the start is
// answered (the draft was put on another server, or deleted, while the call was under way): the
// run is not started here. No record stays, the pages get nothing, the run is deleted on its
// server, and the answer is 409 run_changed.
func TestRunChangedInAStart(t *testing.T) {
	const changed = "The run was changed while it was being started; it was not started on Studio."
	rg := newRig(t, rigOpt{limits: Limits{Start: 150 * time.Millisecond, Settle: 150 * time.Millisecond}})
	put := rg.script("PUT /api/runs/{id}")
	get := rg.script("GET /api/runs/{id}")
	del := rg.script("DELETE /api/runs/{id}")
	del.answer(http.StatusOK, map[string]any{"ok": true})
	serveRunViews(get, model.RunRunning)
	p, _ := rg.page("page-1")
	lose := func(id string) {
		rg.runs.mu.Lock()
		defer rg.runs.mu.Unlock()
		if rg.runs.lost == nil {
			rg.runs.lost = map[string]bool{}
		}
		rg.runs.lost[id] = true
	}
	nothing := func(what, id string, deletes int) {
		t.Helper()
		rg.until(what+": the run is deleted on its server", func() bool { return del.count() == deletes })
		if c := del.calls()[deletes-1]; c.URI != "/api/runs/"+id {
			t.Errorf("%s: the delete: %+v", what, c)
		}
		if rg.r.HasRun(id) || len(rg.r.RunViews()) != 0 || rg.r.Starting(id) {
			t.Errorf("%s: a record is left", what)
		}
		if _, err := os.Stat(rg.r.runFiles.path(id)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s: the record's file: %v", what, err)
		}
		if evs := rg.barrier(p)[0]; len(evs) != 0 {
			t.Errorf("%s: the page got %v", what, evs)
		}
		if rg.logs.count("was changed or deleted while it was being started") != deletes {
			t.Errorf("%s: the log %v", what, rg.logs.all())
		}
	}

	// The answer says started. An event of the run that comes while the record is not the
	// pages' yet is taken and not sent.
	id := runN(1)
	rg.draftRun(id, "")
	lose(id)
	view := remoteRun(id, model.RunRunning)
	put.answer(http.StatusOK, runAnswerOf(true, true, &view, "", ""))
	rg.runs.mu.Lock()
	rg.runs.onHand = func(id string) {
		newer := remoteRun(id, model.RunRunning)
		newer.Turns = 7
		rg.s.Send(map[string]any{"type": "run", "run": newer})
		for end := time.Now().Add(wait); time.Now().Before(end); time.Sleep(2 * time.Millisecond) {
			if rec := rg.r.runRec(id); rec != nil && rec.view().Turns == 7 {
				return
			}
		}
		t.Errorf("the event of the run %s was not taken by its record", id)
	}
	rg.runs.mu.Unlock()
	refused(t, "the start", rg.r.StartRun(context.Background(), id, "Go"), http.StatusConflict, "run_changed", changed)
	nothing("started by the answer", id, 1)
	rg.runs.mu.Lock()
	rg.runs.onHand = nil
	rg.runs.mu.Unlock()
	if get.count() != 0 {
		t.Errorf("%d reads of a run that is not started here", get.count())
	}

	// No answer, and the read says started.
	id = runN(2)
	rg.draftRun(id, "")
	lose(id)
	_, release := put.hang()
	defer release()
	refused(t, "the start", rg.r.StartRun(context.Background(), id, "Go"), http.StatusConflict, "run_changed", changed)
	nothing("started by the read", id, 2)

	// A record that was there before, with a draft of another server under its id: the draft is
	// not this record's, and both are left.
	id = runN(3)
	rg.adoptRun(runSeedOf(id))
	other := rg.draftRun(id, "")
	other.Server = "s_000000000000"
	rg.setDraftRun(other)
	if rep := rg.r.StartRun(context.Background(), id, "Go"); rep.Status != http.StatusOK || body(t, rep)["id"] != id {
		t.Errorf("the start of an id with a record: %d %s", rep.Status, rep.Body)
	}
	if meta, ok := rg.runs.RemoteDraft(id); !ok || meta.Server != other.Server || !rg.r.HasRun(id) || rg.runHanded(id) || del.count() != 2 {
		t.Errorf("the draft of another server: %+v, %v, handed over %v, %d deletes", meta, ok, rg.runHanded(id), del.count())
	}
}

// TestRunStarting: the run service is told that a start is being made from the moment it is
// asked for until its answer is taken (runs.Remote).
func TestRunStarting(t *testing.T) {
	var _ runs.Remote = (*Relay)(nil)
	rg := newRig(t, rigOpt{})
	put := rg.script("PUT /api/runs/{id}")
	get := rg.script("GET /api/runs/{id}")
	serveRunViews(get, model.RunRunning)
	rg.draftRun(runA, "")
	view := remoteRun(runA, model.RunRunning)
	arrived, hold := make(chan struct{}), make(chan struct{})
	put.set(func(w http.ResponseWriter, r *http.Request) {
		close(arrived)
		<-hold
		writeAnswer(w, http.StatusOK, runAnswerOf(true, true, &view, "", ""))
	})
	if rg.r.Starting(runA) {
		t.Error("starting before the start")
	}
	out := make(chan Reply, 1)
	go func() { out <- rg.r.StartRun(context.Background(), runA, "Go") }()
	<-arrived
	if !rg.r.Starting(runA) || rg.r.Starting(runB) {
		t.Errorf("while the call is under way: %v, another run %v", rg.r.Starting(runA), rg.r.Starting(runB))
	}
	close(hold)
	if rep := <-out; rep.Status != http.StatusOK || rg.r.Starting(runA) {
		t.Errorf("after the answer: %d %s, starting %v", rep.Status, rep.Body, rg.r.Starting(runA))
	}
}
