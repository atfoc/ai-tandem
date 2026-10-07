package app

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/servers/standin"
)

// The runs of other servers in the snapshot and in the cascades of a group, on the rig of
// remote_test.go: the app has a real run service, and the relay keeps the run records.

const (
	runA = "r_aaaa0001"
	runB = "r_bbbb0002"
	runC = "r_cccc0003"
	runD = "r_dddd0004"
)

// runViews are the runs of the seeds as their server sends them: started, with its own group.
func runViews(seeds []seed) []model.RunView {
	out := []model.RunView{}
	for _, s := range seeds {
		v := model.RunView{ID: s.id, Name: "Run " + s.id[2:4], Group: "g_there", Agent: model.Claude, Cwd: "/home/standin/work",
			Created: time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC), Started: time.Date(2026, 10, 6, 9, 1, 0, 0, time.UTC), Status: model.RunStopped}
		v.Archived = s.archived
		out = append(out, v)
	}
	return out
}

func runCall(method, id, rest string) string { return method + " /api/runs/" + id + rest }

// run is the run record's view; ok is false when there is no such record.
func (f *far) run(id string) (model.RunView, bool) {
	for _, v := range f.a.Remotes.RunViews() {
		if v.ID == id {
			return v, true
		}
	}
	return model.RunView{}, false
}

// order are the calls the stand-in got since the last call of sent or order, in the order it got
// them.
func (f *far) order() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.calls
	f.calls = nil
	return out
}

// The snapshot's runs hold the run records after the runs of this server. An id that is a
// record's and a draft's of this server, as it is for a moment while a run starts on its
// server, is listed once: as the record.
func TestSnapshotWithRunRecords(t *testing.T) {
	e := newRunEnv(t)
	g := e.group("G")
	own, both := e.run(g), e.run(g)
	f := e.far(seed{id: both, group: model.Ungrouped, run: true}, seed{id: runA, group: g, run: true})
	if len(e.rs.Views()) != 2 {
		t.Fatalf("the run service has %d runs, want 2", len(e.rs.Views()))
	}

	snap := e.a.Snapshot()
	byID := map[string][]model.RunView{}
	for _, r := range snap.Runs {
		byID[r.ID] = append(byID[r.ID], r)
	}
	if len(snap.Runs) != 3 || len(byID[own]) != 1 || byID[own][0].Server != "" || byID[own][0].Status != model.RunDraft ||
		len(byID[runA]) != 1 || byID[runA][0].Server != f.entry || byID[runA][0].Group != g || byID[runA][0].Started.IsZero() ||
		len(byID[both]) != 1 || byID[both][0].Server != f.entry || byID[both][0].Group != model.Ungrouped || byID[both][0].Status != model.RunStopped {
		t.Fatalf("runs: %+v", snap.Runs)
	}
	if snap.Runs[0].ID != own {
		t.Fatalf("the runs of this server come first: %+v", snap.Runs)
	}
	raw := string(mustJSON(t, snap))
	if strings.Contains(raw, standin.DefaultSecret) || strings.Contains(raw, "g_there") {
		t.Fatalf("the snapshot holds the entry's secret or the other server's group: %s", raw)
	}
	// An API client's snapshot holds no record.
	api := string(mustJSON(t, e.a.APISnapshot("0e5ac1f3-6d2b-4b7a-8f10-9a1b2c3d4e5f")))
	for _, s := range []string{runA, both, "standin", f.entry} {
		if strings.Contains(api, s) {
			t.Errorf("the API snapshot holds %s: %s", s, api)
		}
	}
	// Without a record the snapshot is the run service's, never nil.
	e2 := newRunEnv(t)
	e2.far()
	if got := e2.a.Snapshot().Runs; got == nil || len(got) != 0 {
		t.Fatalf("the runs of an app with a relay and no run: %+v", got)
	}
}

// A group's archive archives the run records in it and below it that are not archived, with the
// group's action, and fails for none; its unarchive brings back exactly those. A record that was
// archived on its own server belongs to no action here and stays as it is (AC33).
func TestArchiveGroupWithRunRecords(t *testing.T) {
	e := newRunEnv(t)
	g := e.group("G")
	sub := e.subgroup("Sub", g)
	own := e.run(g)
	f := e.far(seed{id: runA, group: g, run: true}, seed{id: runB, group: sub, run: true}, seed{id: runC, group: g, archived: true, run: true},
		seed{id: runD, group: model.Ungrouped, run: true}, seed{id: recA, group: sub})
	f.sent()

	e.must(e.a.Archive(KindGroup, g))
	ga := e.groupArchive(g)
	a, _ := f.run(runA)
	b, _ := f.run(runB)
	c, _ := f.run(runC)
	o, _ := f.run(runD)
	ch, _ := f.rec(recA)
	if !ga.Archived || a.Archive != ga || b.Archive != ga || ch.Archive != ga || e.view(own).Archive != ga || e.groupArchive(sub) != ga {
		t.Fatalf("after the archive: group %+v, records %+v, %+v and %+v", ga, a.Archive, b.Archive, ch.Archive)
	}
	if !c.Archived || c.Op != "" || o.Archived {
		t.Fatalf("the record archived there %+v, the one outside %+v", c.Archive, o.Archive)
	}
	if got, want := f.sent(), []string{chatCall("POST", recA, "/archive"), runCall("POST", runA, "/archive"), runCall("POST", runB, "/archive")}; !slices.Equal(got, want) {
		t.Fatalf("the stand-in got %v, want %v", got, want)
	}
	if got := e.a.Remotes.RunsArchivedWith(ga.Op); !slices.Equal(got, []string{runA, runB}) {
		t.Fatalf("archived with the group's action: %v", got)
	}

	e.must(e.a.Unarchive(KindGroup, g))
	a, _ = f.run(runA)
	b, _ = f.run(runB)
	c, _ = f.run(runC)
	if ch, _ = f.rec(recA); a.Archived || b.Archived || ch.Archived || !c.Archived || e.view(own).Archived || e.groupArchive(g).Archived {
		t.Fatalf("after the unarchive: %+v, %+v, %+v, %+v", a.Archive, b.Archive, c.Archive, ch.Archive)
	}
	if got, want := f.sent(), []string{chatCall("POST", recA, "/unarchive"), runCall("POST", runA, "/unarchive"), runCall("POST", runB, "/unarchive")}; !slices.Equal(got, want) {
		t.Fatalf("the stand-in got %v, want %v", got, want)
	}

	// A server that refuses one run's archive does not stop the group's: that run stays as it
	// is, the rest is archived.
	f.refuseWith(runCall("POST", runB, "/archive"), http.StatusConflict)
	e.must(e.a.Archive(KindGroup, g))
	a, _ = f.run(runA)
	b, _ = f.run(runB)
	if !e.groupArchive(g).Archived || !a.Archived || b.Archived || !e.view(own).Archived {
		t.Fatalf("after an archive one run's server refused: %+v, %+v", a.Archive, b.Archive)
	}
	e.must(e.a.Unarchive(KindGroup, g))
	f.refuseWith(runCall("POST", runB, "/archive"), 0)
	f.sent()

	// A record that is placed in the group while the group is archived is archived like the
	// rest: the second pass finds it.
	beforeGroupChange = func() { e.must(e.a.Remotes.MoveRun(runD, sub)) }
	defer func() { beforeGroupChange = nil }()
	e.must(e.a.Archive(KindGroup, g))
	beforeGroupChange = nil
	if o, _ = f.run(runD); o.Archive != e.groupArchive(g) || !slices.Contains(f.sent(), runCall("POST", runD, "/archive")) {
		t.Fatalf("the record placed in the group meanwhile: %+v", o.Archive)
	}
	e.must(e.a.Unarchive(KindGroup, g))
	e.must(e.a.Remotes.MoveRun(runD, model.Ungrouped))
	f.sent()

	// A server that is away does not stop it either: the marks show, and are passed on when it
	// is back. A record moved out of the group while archived stays archived at the unarchive.
	f.down()
	e.must(e.a.Archive(KindGroup, g))
	a, _ = f.run(runA)
	b, _ = f.run(runB)
	if ga = e.groupArchive(g); !ga.Archived || a.Archive != ga || b.Archive != ga {
		t.Fatalf("after an archive with the server away: %+v, %+v", a.Archive, b.Archive)
	}
	f.st.Restart()
	f.wait("the archives are passed on", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return slices.Contains(f.calls, runCall("POST", runA, "/archive")) && slices.Contains(f.calls, runCall("POST", runB, "/archive"))
	})
	e.must(e.a.Remotes.MoveRun(runB, model.Ungrouped))
	e.must(e.a.Unarchive(KindGroup, g))
	a, _ = f.run(runA)
	b, _ = f.run(runB)
	if a.Archived || !b.Archived || b.Op != ga.Op {
		t.Fatalf("after the unarchive: %+v, and the record that was moved away %+v", a.Archive, b.Archive)
	}
}

// The archive and the unarchive of one run record: the unarchive brings back the archived groups
// the record is nested in, as that of a run of this server does, and nothing else in them.
func TestArchiveOfOneRunRecord(t *testing.T) {
	e := newRunEnv(t)
	g := e.group("G")
	sub := e.subgroup("Sub", g)
	own := e.run(g)
	f := e.far(seed{id: runA, group: sub, run: true}, seed{id: runB, group: g, run: true})
	e.must(e.a.Archive(KindGroup, g))

	e.must(e.a.UnarchiveRunRecord(context.Background(), runA))
	a, _ := f.run(runA)
	b, _ := f.run(runB)
	if a.Archived || !b.Archived || e.groupArchive(g).Archived || e.groupArchive(sub).Archived || !e.view(own).Archived {
		t.Fatalf("after the unarchive of one record: %+v, %+v, groups %+v %+v", a.Archive, b.Archive, e.groupArchive(g), e.groupArchive(sub))
	}
	// The user's own archive of one record is an action of its own.
	e.must(e.a.ArchiveRunRecord(context.Background(), runA))
	if a, _ = f.run(runA); !a.Archived || a.Op == "" || a.Op == b.Op || e.groupArchive(sub).Archived {
		t.Fatalf("after the archive of one record: %+v", a.Archive)
	}
	// No record with the id.
	for _, err := range []error{e.a.ArchiveRunRecord(context.Background(), own), e.a.UnarchiveRunRecord(context.Background(), own),
		e.a.ArchiveRunRecord(context.Background(), "r_none0000")} {
		if !errors.Is(err, runs.ErrNotFound) {
			t.Errorf("a run of this server as a record: %v", err)
		}
	}
	// The run routes of this server do not reach a record: an API client calls them too.
	for name, err := range map[string]error{"archive": e.a.Archive(KindRun, runB), "unarchive": e.a.Unarchive(KindRun, runB), "delete": e.a.DeleteRun(runB)} {
		if !errors.Is(err, runs.ErrNotFound) {
			t.Errorf("%s of a record through the run service: %v", name, err)
		}
	}
	if b, ok := f.run(runB); !ok || !b.Archived {
		t.Error("the record was changed through the routes of this server's runs")
	}
	// Without a relay there is no record.
	if err := newEnv(t).a.ArchiveRunRecord(context.Background(), runA); !errors.Is(err, runs.ErrNotFound) {
		t.Errorf("without a relay: %v", err)
	}
	if err := newEnv(t).a.UnarchiveRunRecord(context.Background(), runA); !errors.Is(err, runs.ErrNotFound) {
		t.Errorf("without a relay: %v", err)
	}
}

// The delete of a group with its contents deletes the runs of its records on their servers
// first, after the chats of its chat records, then what is this server's; without its contents
// the records move up (AC33).
func TestDeleteGroupWithRunRecords(t *testing.T) {
	e := newRunEnv(t)
	top := e.group("Top")
	g := e.subgroup("G", top)
	sub := e.subgroup("Sub", g)
	own := e.run(g)
	f := e.far(seed{id: runA, group: g, run: true}, seed{id: runB, group: sub, run: true}, seed{id: runC, group: top, run: true},
		seed{id: recA, group: sub})
	f.sent()

	// A run that cannot be deleted there: nothing of this server is deleted.
	f.refuseWith(runCall("DELETE", runB, ""), http.StatusInternalServerError)
	err := e.a.DeleteGroup(g, true)
	var re *remotes.Error
	if !errors.As(err, &re) || re.Status != http.StatusInternalServerError {
		t.Fatalf("a delete one server refused: %v", err)
	}
	if _, err := e.rs.View(own); err != nil {
		t.Fatalf("this server's run after the refused delete: %v", err)
	}
	if _, ok := f.run(runB); !ok || len(e.named("G")) != 1 || len(e.named("Sub")) != 1 {
		t.Fatal("something of this server was deleted although a run's server refused")
	}
	f.refuseWith(runCall("DELETE", runB, ""), 0)
	// The chats are deleted there before the runs, and the work ends at the first refusal.
	if got, want := f.order(), []string{chatCall("DELETE", recA, ""), runCall("DELETE", runA, ""), runCall("DELETE", runB, "")}; !slices.Equal(got, want) {
		t.Fatalf("the calls of the refused delete: %v, want %v", got, want)
	}

	// Without the contents: the group's records move to its parent, and nothing is sent.
	e.must(e.a.DeleteGroup(sub, false))
	if b, _ := f.run(runB); b.Group != g || len(f.sent()) != 0 || len(e.named("Sub")) != 0 {
		t.Fatalf("after the delete of the subgroup alone: the record is in %q", b.Group)
	}

	// With the contents: the runs are deleted there, the records go, then the rest. A record
	// that is placed in the group meanwhile is deleted too.
	beforeGroupChange = func() { e.must(e.a.Remotes.MoveRun(runC, g)) }
	defer func() { beforeGroupChange = nil }()
	e.must(e.a.DeleteGroup(g, true))
	beforeGroupChange = nil
	got := f.sent()
	if !slices.Contains(got, runCall("DELETE", runB, "")) || !slices.Contains(got, runCall("DELETE", runC, "")) {
		t.Fatalf("the stand-in got %v", got)
	}
	_, hasB := f.run(runB)
	_, hasC := f.run(runC)
	if _, err := e.rs.View(own); hasB || hasC || !errors.Is(err, runs.ErrNotFound) || len(e.named("G")) != 0 {
		t.Fatalf("after the delete: records %v %v, the run %v", hasB, hasC, err)
	}
	for _, v := range e.a.Remotes.RunViews() {
		if v.Group == g || v.Group == sub {
			t.Errorf("the record %s is left in a group that is gone", v.ID)
		}
	}
}

// A record that is placed in a group while the group is deleted without its contents moves up
// like the rest; one that cannot be deleted on its server in the second pass moves up too, and
// the delete says so.
func TestDeleteGroupWithALateRunRecord(t *testing.T) {
	e := newRunEnv(t)
	top := e.group("Top")
	g := e.subgroup("G", top)
	f := e.far(seed{id: runA, group: model.Ungrouped, run: true}, seed{id: runB, group: model.Ungrouped, run: true})
	defer func() { beforeGroupChange = nil }()

	beforeGroupChange = func() { e.must(e.a.Remotes.MoveRun(runA, g)) }
	e.must(e.a.DeleteGroup(g, false))
	if a, _ := f.run(runA); a.Group != top || len(f.sent()) != 0 {
		t.Fatalf("the late record after the delete of the group alone: in %q", a.Group)
	}

	g2 := e.subgroup("G2", top)
	f.refuseWith(runCall("DELETE", runB, ""), http.StatusInternalServerError)
	beforeGroupChange = func() { e.must(e.a.Remotes.MoveRun(runB, g2)) }
	err := e.a.DeleteGroup(g2, true)
	var re *remotes.Error
	if !errors.As(err, &re) || re.Status != http.StatusInternalServerError {
		t.Fatalf("the delete with a late record its server keeps: %v", err)
	}
	if b, ok := f.run(runB); !ok || b.Group != top || len(e.named("G2")) != 0 {
		t.Fatalf("the late record that could not be deleted: %+v, %v", b, ok)
	}
}

// While the server of one run record is not connected, the delete of a group with its contents
// deletes nothing: not what is on the servers that are connected, and nothing here.
func TestDeleteGroupWithARunsServerAway(t *testing.T) {
	e := newRunEnv(t)
	g := e.group("G")
	sub := e.subgroup("Sub", g)
	own := e.run(sub)
	chat := e.chat(g, "")
	f := e.far(seed{id: runA, group: sub, run: true})
	f.down()

	err := e.a.DeleteGroup(g, true)
	var re *remotes.Error
	if !errors.As(err, &re) || re.Status != http.StatusConflict || re.Code != "server_unreachable" ||
		re.Text != "Nothing was deleted: “Run aa” is on Studio, which is not connected." || !errors.Is(err, remotes.ErrUnreachable) {
		t.Fatalf("the delete: %v", err)
	}
	if _, err := e.rs.View(own); err != nil {
		t.Fatalf("this server's run: %v", err)
	}
	if _, err := e.a.Chats.View(chat); err != nil || len(e.named("G")) != 1 || len(e.named("Sub")) != 1 {
		t.Fatalf("something of this server was deleted: %v", err)
	}
	if _, ok := f.run(runA); !ok {
		t.Fatal("the record was deleted")
	}
	// Without the contents nothing is asked of the server: the record moves up.
	e.must(e.a.DeleteGroup(sub, false))
	if a, _ := f.run(runA); a.Group != g {
		t.Fatalf("the record is in %q after its group was deleted alone", a.Group)
	}
	// A record whose run is gone there stands in nobody's way; here the server is back and has
	// the run no more.
	f.st.SetSnapshot(standin.DefaultSnapshot())
	f.st.Restart()
	f.wait("the record is gone", func() bool { a, _ := f.run(runA); return a.Gone })
	f.sent()
	e.must(e.a.DeleteGroup(g, true))
	if _, ok := f.run(runA); ok || len(f.sent()) != 0 || len(e.named("G")) != 0 {
		t.Fatal("after the delete with a gone record: the record or the group is there, or the server was asked")
	}
}

// The unarchive of a chat a person has on a run of another server brings the run's record back
// with it, through the relay: the run service knows no such run.
func TestUnarchiveOfAChatOnARunRecord(t *testing.T) {
	e := newRunEnv(t)
	g := e.group("G")
	f := e.far(seed{id: runA, group: g, run: true})
	c, err := e.a.Chats.CreateOnRun(model.Claude, runA)
	e.must(err)
	if c.Run != runA || c.Server != f.entry {
		t.Fatalf("the chat on the run: %+v", c)
	}
	e.must(e.a.Archive(KindChat, c.ID))
	e.must(e.a.Archive(KindGroup, g))
	f.sent()

	e.must(e.a.Unarchive(KindChat, c.ID))
	a, _ := f.run(runA)
	if a.Archived || e.chatArchive(c.ID).Archived || e.groupArchive(g).Archived {
		t.Fatalf("after the chat's unarchive: the run %+v, the chat %+v, the group %+v", a.Archive, e.chatArchive(c.ID), e.groupArchive(g))
	}
	if got, want := f.sent(), []string{runCall("POST", runA, "/unarchive")}; !slices.Equal(got, want) {
		t.Fatalf("the stand-in got %v, want %v", got, want)
	}
}
