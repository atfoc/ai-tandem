package app

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/store"
)

// runEnv is an app with runs, wired as main wires it, on scripted agents.
type runEnv struct {
	*env
	rs   *runs.Service
	fake *agenttest.Fake
}

func newRunEnv(t *testing.T) *runEnv {
	t.Helper()
	root := filepath.Join(t.TempDir(), "aiwb-app-data") // a run refuses a folder whose path holds the data folder's name
	st, err := store.Open(store.NewPaths(root))
	if err != nil {
		t.Fatal(err)
	}
	br := editorbridge.New(func() any { return nil })
	bds := boards.New(st, br)
	cwd := t.TempDir()
	fake := agenttest.New(model.Claude)
	rs := runs.New(runs.Deps{Store: st, Emit: br, DefaultCwd: cwd, HaltWait: 300 * time.Millisecond})
	cm := chats.New(chats.Deps{Store: st, Bridge: br, Boards: bds, Runs: rs, DefaultCwd: cwd,
		Spawners: map[model.AgentKind]agent.Spawner{model.Claude: fake}})
	rs.Chats = cm
	a := &App{St: st, Boards: bds, Chats: cm, Runs: rs, Bridge: br, DataDir: root}
	t.Cleanup(func() {
		rs.Shutdown(5 * time.Second)
		cm.Shutdown()
	})
	return &runEnv{env: &env{t: t, st: st, a: a}, rs: rs, fake: fake}
}

func (e *runEnv) run(group string) string {
	e.t.Helper()
	v, err := e.rs.Create(group, "")
	if err != nil {
		e.t.Fatal(err)
	}
	return v.ID
}

func (e *runEnv) view(id string) model.RunView {
	e.t.Helper()
	v, err := e.rs.View(id)
	if err != nil {
		e.t.Fatal(err)
	}
	return v
}

// The snapshot always has a list of runs, and a kind's calls answer "no such run" without runs.
func TestSnapshotRunsWithoutARunService(t *testing.T) {
	e := newEnv(t)
	raw, err := json.Marshal(e.a.Snapshot())
	if err != nil || !strings.Contains(string(raw), `"runs":[]`) {
		t.Fatalf("the snapshot of an app without runs: %s, %v", raw, err)
	}
	for name, err := range map[string]error{"archive": e.a.Archive(KindRun, "r_1"), "unarchive": e.a.Unarchive(KindRun, "r_1"), "delete": e.a.DeleteRun("r_1")} {
		if !errors.Is(err, runs.ErrNotFound) {
			t.Errorf("%s of a run in an app without runs: %v", name, err)
		}
	}
	g := e.group("G")
	e.must(e.a.Archive(KindGroup, g))
	e.must(e.a.Unarchive(KindGroup, g))
	e.must(e.a.DeleteGroup(g, true))
}

// The snapshot lists the runs and the chats people have on them, never a run agent's chat; the
// defaults it carries are copies, the run defaults too.
func TestSnapshotRuns(t *testing.T) {
	e := newRunEnv(t)
	g := e.group("G")
	id := e.run(g)
	chat, err := e.a.Chats.CreateOnRun(model.Claude, id)
	e.must(err)
	if _, err := e.a.Chats.CreateOwned(chats.OwnedSpec{ID: "agent-1", Run: id, Role: model.RoleTask, Name: "T01-work",
		Agent: model.Claude, Model: "sonnet", Cwd: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	snap := e.a.Snapshot()
	if len(snap.Runs) != 1 || snap.Runs[0].ID != id || snap.Runs[0].Status != model.RunDraft {
		t.Fatalf("the snapshot's runs: %+v", snap.Runs)
	}
	if len(snap.Chats) != 1 || snap.Chats[0].ID != chat.ID || snap.Chats[0].Run != id {
		t.Fatalf("the snapshot's chats: %+v", snap.Chats)
	}

	e.must(e.st.Update(func(s *model.State) error {
		defaults.RecordRun(&s.Defaults, g, model.LocalServer, model.RunDefaults{Agent: model.Claude, MaxParallel: 3, MaxTurns: 40, Setup: "make deps", SetupCwd: "/repo",
			Tiers: &model.RunTiers{Deep: model.ModelChoice{Model: "opus"}}})
		defaults.RecordRun(&s.Defaults, model.Ungrouped, model.LocalServer, model.RunDefaults{Agent: model.Cursor, MaxParallel: 2, MaxTurns: 10})
		return nil
	}))
	snap = e.a.Snapshot()
	got, ungrouped := snap.Defaults.Groups[g].On(model.LocalServer).Run, snap.Defaults.Groups[model.Ungrouped].On(model.LocalServer).Run
	if got == nil || got.MaxParallel != 3 || got.Setup != "make deps" || ungrouped == nil || ungrouped.Agent != model.Cursor {
		t.Fatalf("the snapshot's run defaults: %+v, %+v", got, ungrouped)
	}
	got.MaxParallel, got.Tiers.Deep.Model, ungrouped.MaxTurns = 99, "changed", 99
	e.st.Read(func(s *model.State) {
		in, un := s.Defaults.Groups[g].On(model.LocalServer).Run, s.Defaults.Groups[model.Ungrouped].On(model.LocalServer).Run
		if in.MaxParallel != 3 || in.Tiers.Deep.Model != "opus" || un.MaxTurns != 10 {
			t.Error("changing the snapshot's run defaults changed the store's")
		}
	})
}

// Delete of a group: its runs move up with the rest, or go with it.
func TestDeleteGroupWithRuns(t *testing.T) {
	e := newRunEnv(t)
	top := e.group("top")
	mid := e.subgroup("mid", top)
	low := e.subgroup("low", mid)
	inMid, inLow := e.run(mid), e.run(low)
	chat, err := e.a.Chats.CreateOnRun(model.Claude, inLow)
	e.must(err)

	e.must(e.a.DeleteGroup(mid, false))
	if e.view(inMid).Group != top || e.view(inLow).Group != low {
		t.Fatalf("kept: the group's run is in %s, the subgroup's in %s", e.view(inMid).Group, e.view(inLow).Group)
	}
	if got := e.a.Chats.GroupOf(model.ChatMeta{Run: inLow}); got != low {
		t.Fatalf("the group of a chat on the run: %s", got)
	}
	e.must(e.a.DeleteGroup(top, true))
	for _, id := range []string{inMid, inLow} {
		if _, err := e.rs.View(id); !errors.Is(err, runs.ErrNotFound) {
			t.Errorf("run %s after its group was deleted with its contents: %v", id, err)
		}
	}
	if _, err := e.a.Chats.View(chat.ID); !errors.Is(err, chats.ErrNotFound) {
		t.Errorf("the chat on a deleted run: %v", err)
	}
	if e.a.Snapshot().Runs == nil || len(e.a.Snapshot().Runs) != 0 {
		t.Errorf("the snapshot's runs after the delete: %+v", e.a.Snapshot().Runs)
	}
}

// A group's archive reaches its subtree's runs and their chats with one action; a chat of a run
// brings its run and the groups above back, and not the run's other chats.
func TestArchiveGroupWithRuns(t *testing.T) {
	e := newRunEnv(t)
	top := e.group("top")
	sub := e.subgroup("sub", top)
	r1, r2, early := e.run(top), e.run(sub), e.run(sub)
	c1, err := e.a.Chats.CreateOnRun(model.Claude, r2)
	e.must(err)
	c2, err := e.a.Chats.CreateOnRun(model.Claude, r2)
	e.must(err)
	e.must(e.a.Archive(KindRun, early))
	e.must(e.a.Archive(KindGroup, top))

	op := e.view(r1).Op
	chatOf := func(id string) model.ChatView {
		v, err := e.a.Chats.View(id)
		e.must(err)
		return v
	}
	if op == "" || !e.view(r1).Archived || !e.view(r2).Archived || e.view(r2).Op != op || e.view(early).Op == op ||
		!chatOf(c1.ID).Archived || chatOf(c1.ID).Op != op || chatOf(c2.ID).Op != op {
		t.Fatalf("after the group's archive: %+v %+v %+v, chats %+v %+v", e.view(r1).Archive, e.view(r2).Archive, e.view(early).Archive,
			chatOf(c1.ID).Archive, chatOf(c2.ID).Archive)
	}

	// One chat of the run: it, its run and both groups come back; the other chat and run do not.
	e.must(e.a.Unarchive(KindChat, c1.ID))
	if chatOf(c1.ID).Archived || e.view(r2).Archived || !chatOf(c2.ID).Archived || !e.view(r1).Archived {
		t.Fatalf("after unarchiving a chat of a run: chat %v, its run %v, the other chat %v, the other run %v",
			chatOf(c1.ID).Archived, e.view(r2).Archived, chatOf(c2.ID).Archived, e.view(r1).Archived)
	}
	for _, g := range e.a.Snapshot().Groups {
		if g.Archived {
			t.Errorf("group %s is still archived", g.Name)
		}
	}

	// The group again, and back: exactly what this action took comes back (the run that came back
	// and its chat). What an earlier action archived keeps that action: the other run and chat of
	// the first group archive, and the run archived by itself.
	e.must(e.a.Archive(KindGroup, top))
	if again := e.view(r2).Op; again == op || chatOf(c1.ID).Op != again || e.view(r1).Op != op || chatOf(c2.ID).Op != op {
		t.Fatalf("the second archive: run %q (the first was %q), its chat %q, the other run %q, the other chat %q",
			again, op, chatOf(c1.ID).Op, e.view(r1).Op, chatOf(c2.ID).Op)
	}
	e.must(e.a.Unarchive(KindGroup, top))
	if e.view(r2).Archived || chatOf(c1.ID).Archived || !e.view(r1).Archived || !chatOf(c2.ID).Archived || !e.view(early).Archived {
		t.Fatalf("after the group's unarchive: run %v, its chat %v; of earlier actions: run %v, chat %v, run %v",
			e.view(r2).Archived, chatOf(c1.ID).Archived, e.view(r1).Archived, chatOf(c2.ID).Archived, e.view(early).Archived)
	}

	// A run's own unarchive brings back the groups it is in.
	e.must(e.a.Archive(KindGroup, top))
	e.must(e.a.Unarchive(KindRun, r2))
	for _, g := range e.a.Snapshot().Groups {
		if g.Archived {
			t.Errorf("group %s is still archived after a run in it came back", g.Name)
		}
	}
	if e.view(r2).Archived || !e.view(r1).Archived {
		t.Errorf("after unarchiving one run: it %v, the other %v", e.view(r2).Archived, e.view(r1).Archived)
	}
}

// A run that does not stop in time refuses its archive; the group's archive goes on with the
// rest and reports it.
func TestArchiveGroupMeetsARunThatDoesNotStop(t *testing.T) {
	e := newRunEnv(t)
	release := make(chan struct{})
	working := make(chan struct{}, 4)
	e.fake.Script(func(t *agenttest.Turn) { // an agent that does not let go when it is interrupted
		working <- struct{}{}
		<-release
	})
	g := e.group("G")
	stuck, other := e.run(g), e.run(g)
	if _, err := e.rs.Start(stuck, "Look around."); err != nil {
		t.Fatal(err)
	}
	<-working

	err := e.a.Archive(KindGroup, g)
	if !errors.Is(err, runs.ErrStopping) {
		t.Fatalf("the group's archive: %v, want the run's ErrStopping", err)
	}
	if e.view(stuck).Archived || !e.view(other).Archived {
		t.Errorf("the run that does not stop is archived: %v; the other run: %v", e.view(stuck).Archived, e.view(other).Archived)
	}
	for _, x := range e.a.Snapshot().Groups {
		if x.ID == g && (!x.Archived || x.Op != e.view(other).Op) {
			t.Errorf("the group after its archive: %+v", x.Archive)
		}
	}
	if err := e.a.Archive(KindRun, stuck); !errors.Is(err, runs.ErrStopping) {
		t.Errorf("the run's own archive while it does not stop: %v", err)
	}

	// Once the agent lets go the run stops, and its archive works.
	close(release)
	for deadline := time.Now().Add(20 * time.Second); e.view(stuck).Status.Live(); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the run did not stop")
		}
	}
	e.must(e.a.Archive(KindRun, stuck))
	if v := e.view(stuck); !v.Archived || v.Status != model.RunStopped {
		t.Errorf("the run after its archive: %+v", v)
	}
}

// lateRun makes beforeGroupChange add a run to the group once, as a start does that checked its
// group just before the group is deleted or archived. It returns where the run's id is put.
func lateRun(e *runEnv, group string) *string {
	id := new(string)
	beforeGroupChange = func() {
		beforeGroupChange = nil
		*id = e.run(group)
	}
	e.t.Cleanup(func() { beforeGroupChange = nil })
	return id
}

// A run placed in a group between the listing of the group's contents and its removal goes the
// way of the rest: no run is left in a group that is gone.
func TestDeleteGroupTakesARunPlacedDuringTheDelete(t *testing.T) {
	e := newRunEnv(t)
	top := e.group("top")
	kept := e.subgroup("kept", top)
	late := lateRun(e, kept)
	e.must(e.a.DeleteGroup(kept, false))
	if *late == "" || e.view(*late).Group != top {
		t.Fatalf("kept: the late run %q is in %q, want %q", *late, e.view(*late).Group, top)
	}

	gone := e.subgroup("gone", top)
	late = lateRun(e, gone)
	e.must(e.a.DeleteGroup(gone, true))
	if _, err := e.rs.View(*late); *late == "" || !errors.Is(err, runs.ErrNotFound) {
		t.Fatalf("with contents: the late run %q after the delete: %v", *late, err)
	}
	groups := map[string]bool{model.Ungrouped: true}
	e.st.Read(func(s *model.State) {
		for _, g := range s.Groups {
			groups[g.ID] = true
		}
	})
	for _, r := range e.rs.List() {
		if !groups[r.Group] {
			t.Errorf("run %s names the group %s, which is gone", r.ID, r.Group)
		}
	}
}

// The same at the archive of a group: no unarchived run in an archived group.
func TestArchiveGroupTakesARunPlacedDuringTheArchive(t *testing.T) {
	e := newRunEnv(t)
	g := e.group("G")
	first := e.run(g)
	late := lateRun(e, g)
	e.must(e.a.Archive(KindGroup, g))
	if *late == "" {
		t.Fatal("the hook did not run")
	}
	for _, id := range []string{first, *late} {
		if !e.view(id).Archived {
			t.Errorf("run %s is not archived in its archived group", id)
		}
	}
	if a, b := e.view(first).Op, e.view(*late).Op; a == "" || a != b {
		t.Errorf("the archive ops of the two runs: %q and %q", a, b)
	}
}
