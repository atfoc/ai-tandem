package runs

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/model"
)

func TestSvcPatchApplyResult(t *testing.T) {
	e := newSvcEnv(t)
	v, _ := e.s.Create(model.Ungrouped, "")
	if v.Settings.ApplyResult != "" {
		t.Fatalf("a new run: applyResult %q", v.Settings.ApplyResult)
	}
	for _, bad := range []string{"", "always", "Auto"} {
		if _, err := e.s.Patch(v.ID, PatchReq{Settings: &SettingsPatch{ApplyResult: svcPtr(bad), MaxTurns: svcPtr(9)}}); err == nil ||
			err.Error() != `applyResult must be "auto" or "manual"` {
			t.Fatalf("applyResult %q: %v", bad, err)
		}
	}
	// A refused patch changed nothing.
	if got, _ := e.s.View(v.ID); got.Settings != v.Settings {
		t.Fatalf("after refused patches: %+v", got.Settings)
	}
	for _, ok := range []string{"manual", "auto"} {
		got, err := e.s.Patch(v.ID, PatchReq{Settings: &SettingsPatch{ApplyResult: svcPtr(ok)}})
		if err != nil || got.Settings.ApplyResult != ok {
			t.Fatalf("applyResult %q: %+v %v", ok, got.Settings, err)
		}
	}
	// On the wire and in run.json it is `applyResult`; a start keeps it.
	e.s.Patch(v.ID, PatchReq{Settings: &SettingsPatch{ApplyResult: svcPtr("manual")}})
	started, err := e.s.Start(v.ID, svcGoal)
	if err != nil || started.Settings.ApplyResult != "manual" {
		t.Fatalf("start: %+v %v", started.Settings, err)
	}
	r, _ := e.s.run(v.ID)
	if b, _ := json.Marshal(svcMetaOnDisk(t, r).Settings); !strings.Contains(string(b), `"applyResult":"manual"`) {
		t.Fatalf("run.json's settings: %s", b)
	}
	if b, _ := json.Marshal(model.DefaultRunSettings()); strings.Contains(string(b), "applyResult") {
		t.Fatalf("the default settings: %s", b)
	}
}

// A draft in a git folder says whether the folder has uncommitted changes; nothing else does.
func TestSvcDraftDirty(t *testing.T) {
	repo := agenttest.NewRepo(t)
	repo.Write("a.txt", "one\n")
	repo.Write(".gitignore", "ignored.txt\n")
	repo.Commit("first")
	e := newSvcEnv(t)
	e.s.GitEnv = repo.Env()
	v, _ := e.s.Create(model.Ungrouped, "")
	view := func() model.RunView {
		t.Helper()
		// A fresh look at the folder, as a client's refresh gets it.
		got, err := e.s.Patch(v.ID, PatchReq{Cwd: svcPtr(repo.Dir())})
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	wire := func(v model.RunView) string { b, _ := json.Marshal(v); return string(b) }

	if got := view(); got.Dirty || !got.Git || strings.Contains(wire(got), `"dirty"`) {
		t.Fatalf("a clean folder: %s", wire(got))
	}
	repo.Write("ignored.txt", "x\n")
	if got := view(); got.Dirty {
		t.Fatal("an ignored file makes the folder dirty")
	}
	repo.Write("a.txt", "two\n")
	if got := view(); !got.Dirty || !strings.Contains(wire(got), `"dirty":true`) {
		t.Fatalf("an unstaged change: %s", wire(got))
	}
	repo.Git("checkout", "--", "a.txt")
	if got := view(); got.Dirty {
		t.Fatal("clean again")
	}
	repo.Write("new.txt", "untracked\n")
	if got := view(); !got.Dirty || got.Blocked != "" {
		t.Fatalf("an untracked file: %s", wire(got))
	}
	repo.Git("add", "new.txt")
	if got := view(); !got.Dirty {
		t.Fatal("a staged file")
	}

	// A plain folder is never dirty.
	if got, _ := e.s.Patch(v.ID, PatchReq{Cwd: svcPtr(t.TempDir())}); got.Dirty || got.Git {
		t.Fatalf("a plain folder: %s", wire(got))
	}
	// The started run does not say it: the start recorded it instead.
	view()
	started, err := e.s.Start(v.ID, svcGoal)
	if err != nil || started.Dirty {
		t.Fatalf("the started run: %s %v", wire(started), err)
	}
	r, _ := e.s.run(v.ID)
	if g := svcState(t, r).State.Git; g == nil || !g.DirtyAtStart {
		t.Fatalf("git: %+v", g)
	}
}

func TestSvcStartRecordsBranch(t *testing.T) {
	t.Run("on a branch", func(t *testing.T) {
		repo := agenttest.NewRepo(t)
		repo.Write("a.txt", "one\n")
		repo.Commit("first")
		repo.Git("checkout", "-q", "-b", "feature/x")
		e := newSvcEnv(t)
		e.s.GitEnv = repo.Env()
		v, r, err := svcStartIn(t, e, repo.Dir(), svcGoal)
		if err != nil {
			t.Fatal(err)
		}
		if g := svcState(t, r).State.Git; g == nil || g.Branch != "feature/x" {
			t.Fatalf("git: %+v", g)
		}
		d, _ := e.s.Detail(v.ID)
		if b, _ := json.Marshal(d.Git); d.Git == nil || d.Git.Branch != "feature/x" || !strings.Contains(string(b), `"branch":"feature/x"`) {
			t.Fatalf("detail: %s", b)
		}
		// It survives a restart.
		e.restart()
		if d, _ := e.s.Detail(v.ID); d.Git == nil || d.Git.Branch != "feature/x" {
			t.Fatalf("detail after a restart: %+v", d.Git)
		}
	})
	t.Run("a detached HEAD", func(t *testing.T) {
		repo := agenttest.NewRepo(t)
		repo.Write("a.txt", "one\n")
		head := repo.Commit("first")
		repo.Git("checkout", "-q", "--detach", head)
		e := newSvcEnv(t)
		e.s.GitEnv = repo.Env()
		v, r, err := svcStartIn(t, e, repo.Dir(), svcGoal)
		if err != nil {
			t.Fatal(err)
		}
		if g := svcState(t, r).State.Git; g == nil || g.Branch != "" || g.BaseRef != head {
			t.Fatalf("git: %+v", g)
		}
		d, _ := e.s.Detail(v.ID)
		if b, _ := json.Marshal(d.Git); strings.Contains(string(b), `"branch"`) {
			t.Fatalf("detail: %s", b)
		}
	})
	t.Run("a folder below the top", func(t *testing.T) {
		repo := agenttest.NewRepo(t)
		repo.Write("services/api/main.go", "package main\n")
		repo.Commit("first")
		repo.Git("checkout", "-q", "-b", "api")
		e := newSvcEnv(t)
		e.s.GitEnv = repo.Env()
		_, r, err := svcStartIn(t, e, filepath.Join(repo.Dir(), "services", "api"), svcGoal)
		if err != nil {
			t.Fatal(err)
		}
		if g := svcState(t, r).State.Git; g == nil || g.Branch != "api" {
			t.Fatalf("git: %+v", g)
		}
	})
}

func TestSvcNoCommitText(t *testing.T) {
	const want = "this repository has no commit yet: commit your files (or `git commit --allow-empty -m init` in an empty folder), then start the run"
	repo := agenttest.NewRepo(t)
	e := newSvcEnv(t)
	e.s.GitEnv = repo.Env()
	_, r, err := svcStartIn(t, e, repo.Dir(), svcGoal)
	var be *BlockedError
	if !errors.As(err, &be) || be.Reason != want {
		t.Fatalf("start: %v", err)
	}
	if v := r.viewNow(); v.Blocked != want || v.Dirty || v.Status != model.RunDraft {
		t.Fatalf("the view: %+v", v)
	}
	// What the text says works.
	repo.Git("commit", "-q", "--allow-empty", "-m", "init")
	if v, err := e.s.Start(r.id, svcGoal); err != nil || v.Status != model.RunRunning {
		t.Fatalf("after the empty commit: %+v %v", v, err)
	}
}

// The work folder holds the copies agents read in a run without git too, so its path is checked
// there as well.
func TestSvcWorkFolderPathChecked(t *testing.T) {
	// The data folder is named "aiwb": the work folder beside it (aiwb-run-work) has that name in
	// its path, the run's own folder does not.
	te := &testEnv{t: t, root: filepath.Join(t.TempDir(), "aiwb"), cwd: t.TempDir(), clock: agenttest.NewClock(testStart), emit: &recEmitter{}}
	te.boot()
	e := &svcEnv{testEnv: te, host: newSvcHost(), fake: &svcFake{stops: true}}
	e.wire()
	dir := t.TempDir()
	if strings.Contains(dir, "aiwb") {
		t.Fatalf("the test's folder %s has the data folder's name in it", dir)
	}
	_, r, err := svcStartIn(t, e, dir, svcGoal)
	work := e.s.Store.P.RunWorkDir(r.id)
	want := "the data folder's name (aiwb) is part of this run's folder or of the place its checkouts go (" + work + "); agents could not work there"
	var be *BlockedError
	if !errors.As(err, &be) || be.Reason != want {
		t.Fatalf("start in a plain folder: %v", err)
	}
	if v := r.viewNow(); v.Git || v.Blocked != want || v.Status != model.RunDraft {
		t.Fatalf("the view: %+v", v)
	}
	if _, err := os.Stat(work); err == nil {
		t.Fatal("the work folder was made")
	}
}

// A run_delivery entry puts the delivery into the state: it is on the detail and the event's
// patch, its state is on the view, and both a replay of the journal and a checkpoint keep it.
func TestRunDeliveryEntry(t *testing.T) {
	e := newSvcEnv(t)
	wire := func(v any) string { b, _ := json.Marshal(v); return string(b) }

	// A draft has none.
	draft := e.draft("r_draft")
	draft.mu.Lock()
	draft.refreshView()
	draft.mu.Unlock()
	if s := wire(draft.viewNow()); strings.Contains(s, `"delivery"`) {
		t.Fatalf("a draft's view: %s", s)
	}

	// Nor has a live run, and one that halts without an attempt.
	r := e.in("r_del", model.RunStopped)
	d, err := e.s.Detail(r.id)
	if err != nil || d.Delivery != nil || strings.Contains(wire(d), `"delivery"`) || strings.Contains(wire(r.viewNow()), `"delivery"`) {
		t.Fatalf("a halted run with no attempt: %s %v", wire(d), err)
	}

	del := model.RunDelivery{State: model.DeliveryBlocked, Reason: "local_changes", At: 1234, Result: "abc123", Branch: "main",
		Files: []string{"a.txt", "b/c.txt"}, More: 2, Partial: true}
	e.events()
	v := e.must(r, KRunDelivery, func(tx *Tx) error {
		c := del
		tx.State().Delivery = &c
		return nil
	})
	es := readEntries(t, r.dir)
	if last := es[len(es)-1]; last.Kind != KRunDelivery || last.V != v || last.Patch.State == nil || last.Patch.State.Delivery == nil {
		t.Fatalf("the entry: %+v", last)
	}
	check := func(when string) {
		t.Helper()
		d, err := e.s.Detail(r.id)
		if err != nil || d.Delivery == nil || wire(*d.Delivery) != wire(del) {
			t.Fatalf("%s: the detail's delivery: %s %v", when, wire(d.Delivery), err)
		}
		got, _ := e.s.View(r.id)
		if got.Delivery != model.DeliveryBlocked || !strings.Contains(wire(got), `"delivery":"blocked"`) {
			t.Fatalf("%s: the view: %s", when, wire(got))
		}
	}
	check("after the entry")
	if !strings.Contains(wire(del), `{"state":"blocked","reason":"local_changes","at":1234,"result":"abc123","branch":"main","files":["a.txt","b/c.txt"],"more":2,"partial":true}`) {
		t.Fatalf("on the wire: %s", wire(del))
	}
	// The event carries it.
	var sent *model.RunDelivery
	for _, ev := range e.events() {
		if de, ok := ev.(detailEvent); ok && de.Version == v {
			sent = de.Patch.Delivery
		}
	}
	if sent == nil || wire(*sent) != wire(del) {
		t.Fatalf("the run_detail event: %s", wire(sent))
	}
	// What clients got is not the record: changing it changes nothing.
	d, _ = e.s.Detail(r.id)
	d.Delivery.Files[0] = "changed"
	check("after a client's copy changed")

	// Replayed from the journal: the entry is past the last checkpoint.
	if got, info, err := loadRecord(r.dir); err != nil || info.Replayed == 0 || got.State.Delivery == nil || wire(*got.State.Delivery) != wire(del) {
		t.Fatalf("replayed: %+v %+v %v", got.State.Delivery, info, err)
	}
	e.restart()
	r, _ = e.s.run("r_del")
	check("after a restart that replays the journal")

	// From the checkpoint alone.
	if err := r.load(); err != nil {
		t.Fatal(err)
	}
	if err := r.checkpoint(); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(r.dir, fileState))
	var sf StateFile
	if err := json.Unmarshal(b, &sf); err != nil || sf.State.Delivery == nil || wire(*sf.State.Delivery) != wire(del) {
		t.Fatalf("state.json: %+v %v", sf.State.Delivery, err)
	}
	if got, info, err := loadRecord(r.dir); err != nil || info.Replayed != 0 || got.State.Delivery == nil || wire(*got.State.Delivery) != wire(del) {
		t.Fatalf("from the checkpoint: %+v %+v %v", got.State.Delivery, info, err)
	}
	e.restart()
	r, _ = e.s.run("r_del")
	// The view is built from state.json's head before the record is read.
	if got, _ := e.s.View(r.id); got.Delivery != model.DeliveryBlocked {
		t.Fatalf("the view from the checkpoint's head: %+v", got)
	}
	check("after a restart from the checkpoint")

	// A run that is going again shows none, though the record keeps the last attempt; when it
	// halts again the patch sends it again.
	before := svcState(t, r).State
	live := cloneState(before)
	live.Status = model.RunRunning
	if deliveryOf(live) != nil || ViewOf(svcMetaOnDisk(t, r), &live, Summary{}, Facts{}).Delivery != "" {
		t.Fatal("a live run shows a delivery")
	}
	l := Loaded{State: live}
	if d := l.Detail(r.id, nil); d.Delivery != nil {
		t.Fatalf("a live run's detail: %+v", d.Delivery)
	}
	if w := WirePatch(before, Patch{State: &live}, nil); w.Delivery != nil {
		t.Fatalf("the patch of a resume: %+v", w.Delivery)
	}
	if w := WirePatch(live, Patch{State: &before}, nil); w.Delivery == nil || wire(*w.Delivery) != wire(del) {
		t.Fatalf("the patch of the halt after it: %+v", w.Delivery)
	}
	// An entry that leaves it as it is does not send it again.
	same := cloneState(before)
	same.Reason = "other"
	if w := WirePatch(before, Patch{State: &same}, nil); w.Delivery != nil {
		t.Fatalf("an unchanged delivery was sent: %+v", w.Delivery)
	}
}
