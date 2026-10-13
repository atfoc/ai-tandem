package app

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/runs"
)

// hold makes every agent work until it is interrupted, so a started run stays running. A test
// that ends with a run's agent at work stops the app here, in main's order, and waits until no
// chat of a run's agent has a process: the chat manager's Shutdown closes the processes and does
// not wait for what it makes of their exit, and the chat's files are written once more, which
// must be over before the test's folder is removed.
func (e *runEnv) hold() {
	e.fake.Script(func(t *agenttest.Turn) { t.Hang() })
	e.t.Cleanup(func() {
		e.rs.Shutdown(5 * time.Second)
		e.a.Chats.Shutdown()
		for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(5 * time.Millisecond) {
			left := ""
			for _, r := range e.rs.List() {
				_, agents := e.a.Chats.ChatsOfRun(r.ID)
				for _, c := range agents {
					if st, _ := e.a.Chats.OwnedState(c.ID); st.HasProcess {
						left = c.ID
					}
				}
			}
			if left == "" {
				return
			}
			if time.Now().After(deadline) {
				e.t.Errorf("the agent of the chat %s still has its process after the shutdown", left)
				return
			}
		}
	})
}

// status waits until the run has this status.
func (e *runEnv) status(id string, want model.RunStatus) {
	e.t.Helper()
	for deadline := time.Now().Add(20 * time.Second); e.view(id).Status != want; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			e.t.Fatalf("run %s is %s, want %s", id, e.view(id).Status, want)
		}
	}
}

// The API snapshot's runs are every run of the server, as the page gets them: the one that has
// not started with its goal's draft, the started, the archived; a list that is never null, with
// and without a run service.
func TestAPISnapshotRuns(t *testing.T) {
	t.Parallel()
	// An app without runs.
	bare := newEnv(t)
	snap := bare.a.APISnapshot()
	if raw := mustJSON(t, snap); snap.Runs == nil || !strings.Contains(string(raw), `"runs":[]`) {
		t.Fatalf("the API snapshot of an app without runs: %s", raw)
	}

	e := newRunEnv(t)
	e.hold()
	snap = e.a.APISnapshot()
	if raw := mustJSON(t, snap); snap.Runs == nil || !strings.Contains(string(raw), `"runs":[]`) {
		t.Fatalf("the API snapshot with no run: %s", raw)
	}

	g := e.group("G")
	draft := e.run(g)
	e.must(e.rs.SetDraft(draft, model.Draft{Text: "Look around."}))
	going := e.run(model.Ungrouped)
	mc := model.ModelChoice{Model: "sonnet"}
	agent, cwd := model.Claude, t.TempDir()
	tier := func() *runs.TierPatch { return &runs.TierPatch{Model: &mc.Model} }
	if _, err := e.rs.Patch(going, runs.PatchReq{Agent: &agent, Cwd: &cwd, Tiers: &runs.TiersPatch{Deep: tier(), Standard: tier(), Light: tier()}}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.rs.Start(going, "Look around."); err != nil {
		t.Fatal(err)
	}
	e.status(going, model.RunRunning)
	shelved := e.run(g)
	e.must(e.a.Archive(KindRun, shelved))

	x := e.a.APISnapshot()
	if !reflect.DeepEqual(x.Runs, e.a.Snapshot().Runs) {
		t.Fatalf("the runs of the API snapshot differ from the page's:\nAPI  %s\npage %s", mustJSON(t, x.Runs), mustJSON(t, e.a.Snapshot().Runs))
	}
	runsByID := map[string]model.RunView{}
	for _, v := range x.Runs {
		runsByID[v.ID] = v
	}
	if len(x.Runs) != 3 || runsByID[draft].Status != model.RunDraft || runsByID[draft].Group != g ||
		runsByID[draft].Draft == nil || runsByID[draft].Draft.Text != "Look around." ||
		runsByID[going].Status != model.RunRunning || !runsByID[shelved].Archived {
		t.Fatalf("runs %s", mustJSON(t, x.Runs))
	}
	var keys []map[string]json.RawMessage
	if err := json.Unmarshal(mustJSON(t, x.Runs), &keys); err != nil || len(keys) != 3 {
		t.Fatalf("the runs as JSON: %s, %v", mustJSON(t, x.Runs), err)
	}
	for _, k := range keys {
		if _, has := k["client"]; has {
			t.Errorf("a run's view says who made it: %s", mustJSON(t, x.Runs))
		}
	}
	// What anyone does shows in it.
	e.must(e.a.DeleteRun(draft))
	if after := e.a.APISnapshot().Runs; len(after) != 2 {
		t.Fatalf("the runs after a delete: %s", mustJSON(t, after))
	}
}
