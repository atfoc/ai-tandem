package app

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/defaults"
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

// startCall makes the run of an API client as its start call does, in the group "Remote".
func (e *runEnv) startCall(client, id string) model.RunView {
	e.t.Helper()
	mc := model.ModelChoice{Model: "sonnet"}
	res, err := e.rs.StartCall(runs.StartReq{ID: id, Client: client, Agent: model.Claude,
		Tiers: model.RunTiers{Deep: mc, Standard: mc, Light: mc}, Cwd: e.t.TempDir(), Goal: "Look around.", Place: e.a.RemoteGroup})
	if err != nil || !res.Started || !res.Made {
		e.t.Fatalf("the start call of %s: %+v, %v", id, res, err)
	}
	return res.Run
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

// clientOf is the run's client mark.
func (e *runEnv) clientOf(id string) string {
	e.t.Helper()
	c, err := e.rs.ClientOf(id)
	if err != nil {
		e.t.Fatal(err)
	}
	return c
}

// defaultsNow is the store's defaults as they are in memory.
func (e *runEnv) defaultsNow() string {
	var b []byte
	e.st.Read(func(s *model.State) { b, _ = json.Marshal(s.Defaults) })
	return string(b)
}

// The group "Remote" with a run in it, deleted alone, deleted with its contents and archived:
// the owner's cascades reach the run as any run's, and the next start call makes a new group.
func TestRemoteGroupWithRuns(t *testing.T) {
	e := newRunEnv(t)
	e.hold()

	// The first start call makes the group, at the top level, with the run in it.
	first := e.startCall(clientX, "r_00000001")
	g1 := first.Group
	if ids := e.named(remoteGroupName); len(ids) != 1 || ids[0] != g1 || g1 == model.Ungrouped {
		t.Fatalf("the groups named Remote after the first start call: %v, the run is in %q", ids, g1)
	}
	// A second client's run sits in the same group.
	if v := e.startCall(clientY, "r_00000002"); v.Group != g1 {
		t.Fatalf("the second client's run is in %q, want %q", v.Group, g1)
	}
	e.must(e.a.DeleteRun("r_00000002"))

	// Deleted alone: the run moves to the ungrouped group, keeps its mark and goes on.
	e.must(e.a.DeleteGroup(g1, false))
	if v := e.view(first.ID); v.Group != model.Ungrouped || v.Status != model.RunRunning || e.clientOf(first.ID) != clientX {
		t.Fatalf("the run after its group was deleted alone: group %q, status %s, mark %q", v.Group, v.Status, e.clientOf(first.ID))
	}
	if vs := e.a.APISnapshot(clientX).Runs; len(vs) != 1 || vs[0].ID != first.ID || vs[0].Group != model.Ungrouped {
		t.Fatalf("the client's runs after the group was deleted alone: %+v", vs)
	}
	second := e.startCall(clientX, "r_00000003")
	g2 := second.Group
	if ids := e.named(remoteGroupName); g2 == g1 || g2 == model.Ungrouped || len(ids) != 1 || ids[0] != g2 {
		t.Fatalf("after the delete alone the next run is in %q (the first group was %q); groups named Remote: %v", g2, g1, ids)
	}
	if v := e.view(first.ID); v.Group != model.Ungrouped {
		t.Fatalf("the moved run after the next start call is in %q", v.Group)
	}

	// Deleted with its contents: the run is removed, the one outside the group stays.
	e.must(e.a.DeleteGroup(g2, true))
	if _, err := e.rs.View(second.ID); !errors.Is(err, runs.ErrNotFound) {
		t.Fatalf("the run after its group was deleted with its contents: %v", err)
	}
	if vs := e.a.APISnapshot(clientX).Runs; len(vs) != 1 || vs[0].ID != first.ID {
		t.Fatalf("the client's runs after the group was deleted with its contents: %+v", vs)
	}
	third := e.startCall(clientX, "r_00000004")
	g3 := third.Group
	if ids := e.named(remoteGroupName); g3 == g1 || g3 == g2 || g3 == model.Ungrouped || len(ids) != 1 || ids[0] != g3 {
		t.Fatalf("after the delete with contents the next run is in %q (before: %q, %q); groups named Remote: %v", g3, g1, g2, ids)
	}

	// Archived: the run is archived and halted, with its mark; the next start call makes a new
	// group and leaves the archived one as it is.
	e.must(e.a.Archive(KindGroup, g3))
	if v := e.view(third.ID); !v.Archived || v.Status != model.RunStopped || v.Group != g3 || v.Op == "" || v.Op != e.groupArchive(g3).Op ||
		e.clientOf(third.ID) != clientX {
		t.Fatalf("the run after its group's archive: %+v, status %s, group %q, mark %q", v.Archive, v.Status, v.Group, e.clientOf(third.ID))
	}
	fourth := e.startCall(clientX, "r_00000005")
	g4 := fourth.Group
	if ids := e.named(remoteGroupName); g4 == g3 || g4 == g2 || g4 == g1 || g4 == model.Ungrouped || len(ids) != 2 {
		t.Fatalf("after the archive the next run is in %q (the archived group is %q); groups named Remote: %v", g4, g3, ids)
	}
	if v := e.view(fourth.ID); v.Archived || v.Status != model.RunRunning {
		t.Fatalf("the run in the new group: archived %v, status %s", v.Archived, v.Status)
	}
	if v := e.view(third.ID); !v.Archived || v.Group != g3 || !e.groupArchive(g3).Archived {
		t.Fatalf("the archived run after the next start call: archived %v, group %q; its group archived %v", v.Archived, v.Group, e.groupArchive(g3).Archived)
	}
	// A repeat of the archived run's start call finds it and makes no group.
	again, err := e.rs.StartCall(runs.StartReq{ID: third.ID, Client: clientX, Agent: model.Claude, Cwd: t.TempDir(), Goal: "Again.", Place: e.a.RemoteGroup})
	if err != nil || !again.Started || again.Made || !again.Run.Archived || len(e.named(remoteGroupName)) != 2 {
		t.Fatalf("a repeat for the archived run: %+v, %v; groups named Remote: %v", again, err, e.named(remoteGroupName))
	}
	// The group is still the remembered one: a further run joins it.
	if v := e.startCall(clientY, "r_00000006"); v.Group != g4 {
		t.Fatalf("a further run is in %q, want %q", v.Group, g4)
	}
}

// A run of an API client that the owner moved to a group with sticky run defaults records and
// changes none: not by its stop, its resume, its rename, or the owner's chat on it.
func TestRunOfAnAPIClientLeavesTheDefaults(t *testing.T) {
	e := newRunEnv(t)
	e.hold()
	g := e.group("G")
	sticky := model.RunDefaults{Agent: model.Cursor, MaxParallel: 3, MaxTurns: 40, Setup: "make deps", SetupCwd: "/repo",
		Tiers: &model.RunTiers{Deep: model.ModelChoice{Model: "opus"}}}
	e.must(e.st.Update(func(s *model.State) error {
		defaults.RecordRun(&s.Defaults, g, model.LocalServer, sticky)
		return nil
	}))
	before := e.defaultsNow()

	// The start call adds the new group's seed and nothing else.
	v := e.startCall(clientX, "r_00000001")
	e.st.Read(func(s *model.State) {
		if _, ok := s.Defaults.Groups[v.Group]; !ok {
			t.Errorf("the group %q has no seed", v.Group)
		}
		if s.Defaults.Groups[v.Group].On(model.LocalServer).Run != nil {
			t.Errorf("the start call recorded run defaults in its group: %+v", s.Defaults.Groups[v.Group].On(model.LocalServer).Run)
		}
		if un := s.Defaults.Groups[model.Ungrouped]; un.On(model.LocalServer).Run != nil {
			t.Errorf("the start call recorded run defaults in the ungrouped group: %+v", un.On(model.LocalServer).Run)
		}
	})
	if !strings.Contains(before, `"make deps"`) || !strings.Contains(e.defaultsNow(), `"make deps"`) {
		t.Fatalf("the sticky run defaults are not in the store: %s", e.defaultsNow())
	}
	seeded := e.defaultsNow()

	same := func(after string) {
		t.Helper()
		if got := e.defaultsNow(); got != seeded {
			t.Fatalf("the defaults after %s:\n%s\nwant\n%s", after, got, seeded)
		}
	}
	e.must(e.rs.Move(v.ID, g))
	if got := e.view(v.ID); got.Group != g || e.clientOf(v.ID) != clientX {
		t.Fatalf("the moved run: group %q, mark %q", got.Group, e.clientOf(v.ID))
	}
	same("the move")

	if _, err := e.rs.Stop(v.ID); err != nil {
		t.Fatal(err)
	}
	e.status(v.ID, model.RunStopped)
	same("the stop")

	if _, err := e.rs.Resume(v.ID, runs.ResumeReq{}); err != nil {
		t.Fatal(err)
	}
	e.status(v.ID, model.RunRunning)
	same("the resume")

	name := "Renamed by the owner"
	if got, err := e.rs.Patch(v.ID, runs.PatchReq{Name: &name}); err != nil || got.Name != name {
		t.Fatalf("the rename: %+v, %v", got, err)
	}
	same("the rename")

	// The owner's chat on the run: no mark, no group of its own, and a first message.
	chat, err := e.a.Chats.CreateOnRun(model.Claude, v.ID)
	e.must(err)
	same("the owner's chat on the run")
	e.must(e.a.Chats.Send(chat.ID, "How far is it?", "", nil))
	if got := e.a.Chats.GroupOf(model.ChatMeta{Run: v.ID}); got != g {
		t.Fatalf("the group of the chat on the run: %q, want %q", got, g)
	}
	if vs := e.a.APISnapshot(clientX).Chats; len(vs) != 0 {
		t.Fatalf("the owner's chat on the run is in the client's snapshot: %+v", vs)
	}
	same("the chat's first message")

	// The sticky values are the ones recorded before, and the run still has its own.
	e.st.Read(func(s *model.State) {
		rd := s.Defaults.Groups[g].On(model.LocalServer).Run
		if rd == nil || rd.Agent != model.Cursor || rd.MaxParallel != 3 || rd.MaxTurns != 40 || rd.Setup != "make deps" || rd.Tiers.Deep.Model != "opus" {
			t.Errorf("the group's run defaults: %+v", rd)
		}
	})
	if got := e.view(v.ID); got.Agent != model.Claude || got.Tiers.Deep.Model != "sonnet" || got.Settings.MaxTurns == 40 {
		t.Errorf("the run took values of its new group: agent %s, tiers %+v, settings %+v", got.Agent, got.Tiers, got.Settings)
	}
}

// The API snapshot's runs are the client's own: nobody else's, the owner's neither; a list that
// is never null, with and without a run service.
func TestAPISnapshotRuns(t *testing.T) {
	// An app without runs.
	bare := newEnv(t)
	snap := bare.a.APISnapshot(clientX)
	if raw := mustJSON(t, snap); snap.Runs == nil || !strings.Contains(string(raw), `"runs":[]`) {
		t.Fatalf("the API snapshot of an app without runs: %s", raw)
	}

	e := newRunEnv(t)
	e.hold()
	for _, c := range []string{clientX, clientY, ""} {
		snap := e.a.APISnapshot(c)
		if raw := mustJSON(t, snap); snap.Runs == nil || !strings.Contains(string(raw), `"runs":[]`) {
			t.Fatalf("the API snapshot of client %q with no run: %s", c, raw)
		}
	}

	owner := e.run(e.group("G")) // the owner's draft: nobody's
	x1 := e.startCall(clientX, "r_0000000b")
	y1 := e.startCall(clientY, "r_0000000a")
	x2 := e.startCall(clientX, "r_0000000c")
	ids := func(c string) string {
		t.Helper()
		snap := e.a.APISnapshot(c)
		if snap.Runs == nil {
			t.Fatalf("the runs of client %q are null", c)
		}
		var out []string
		for _, v := range snap.Runs {
			out = append(out, v.ID)
		}
		return strings.Join(out, " ")
	}
	if got, want := ids(clientX), x1.ID+" "+x2.ID; got != want {
		t.Fatalf("X's runs: %q, want %q", got, want)
	}
	if got := ids(clientY); got != y1.ID {
		t.Fatalf("Y's runs: %q, want %q", got, y1.ID)
	}
	if got := ids(""); got != "" {
		t.Fatalf("the runs of no client: %q", got)
	}
	if got := ids("5d0a3f52-1c0e-4a3b-9c6d-2f1e0d9c8b7a"); got != "" {
		t.Fatalf("the runs of a client with none: %q", got)
	}
	if all := e.a.Snapshot().Runs; len(all) != 4 {
		t.Fatalf("the page's snapshot has %d runs, want 4 (%s among them)", len(all), owner)
	}

	// The view is the run's own, as the page gets it; what the owner does shows in it.
	got := e.a.APISnapshot(clientX).Runs[0]
	if want := e.view(x1.ID); got.Status != model.RunRunning || got.Group != want.Group || got.Name != want.Name || got.Group == model.Ungrouped {
		t.Fatalf("X's first run in the snapshot: %+v, the run's view: %+v", got, want)
	}
	var keys []map[string]json.RawMessage
	raw := mustJSON(t, e.a.APISnapshot(clientX).Runs)
	if err := json.Unmarshal(raw, &keys); err != nil || len(keys) != 2 {
		t.Fatalf("X's runs as JSON: %s, %v", raw, err)
	}
	if _, has := keys[0]["client"]; has {
		t.Errorf("a run's view carries the mark: %s", raw)
	}
	e.must(e.a.Archive(KindRun, x1.ID))
	if v := e.a.APISnapshot(clientX).Runs[0]; v.ID != x1.ID || !v.Archived {
		t.Fatalf("X's archived run in the snapshot: %+v", v)
	}
	e.must(e.a.DeleteRun(x1.ID))
	e.must(e.a.DeleteRun(y1.ID))
	if got := ids(clientX); got != x2.ID {
		t.Fatalf("X's runs after a delete: %q, want %q", got, x2.ID)
	}
	if snap := e.a.APISnapshot(clientY); snap.Runs == nil || len(snap.Runs) != 0 || !strings.Contains(string(mustJSON(t, snap)), `"runs":[]`) {
		t.Fatalf("Y's runs after its only run was deleted: %+v", snap.Runs)
	}
}
