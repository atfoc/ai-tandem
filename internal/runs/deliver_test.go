package runs

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

// The delivery of a run's result to the person's folder, with the engine and scripted agents on
// temp repositories: at the run's end, by Service.Apply, and what Service.Delivery says.

// delivStart is engEnv.run with the folder's branch on the record, as the service's Start records
// it: without it the run counts as started on a detached HEAD.
func (e *engEnv) delivStart(id string, mod func(m *model.RunMeta)) *run {
	e.t.Helper()
	r := e.run(id, mod)
	if e.repo != nil {
		branch := e.repo.Git("symbolic-ref", "-q", "--short", "HEAD")
		e.must(r, KOp, func(tx *Tx) error {
			tx.State().Git.Branch = branch
			return nil
		})
	}
	return r
}

// delivPlay is the script of a run with one writing task per entry of files ("name: content"),
// each depending on the one before; the turn after the last task ends the run with outcome.
// Gates hold what the test blocks.
func (e *engEnv) delivPlay(r *run, outcome model.RunOutcome, files ...string) {
	e.play(r, func() {
		dep := []string(nil)
		for i := range files {
			dep = []string{e.add(r, 1, fmt.Sprintf("Write file %d", i+1), true, dep...)}
		}
	}, func(m *engMsg) bool {
		if m.ID != AgentChatID(r.id, m.Name) { // an agent of another run of the test
			return false
		}
		for i, f := range files {
			if name, content, _ := strings.Cut(f, ": "); m.Name == TaskID(i+1)+"-work" {
				engWrite(e.t, m.Cwd, name, content+"\n")
			}
		}
		if m.Role == model.RoleOrchestrator && m.Name != "turn-001" {
			done := true
			for i := range files {
				done = done && r.engTaskState(TaskID(i+1)).Final()
			}
			if done && r.engState().Result == nil {
				e.finishRun(r, len(r.engTurns()), outcome)
			}
		}
		return false
	})
}

// delivEnded waits for the run to end with the status want and for its engine to return: the
// run's branches go after the entry that ends it.
func (e *engEnv) delivEnded(r *run, want model.RunStatus) {
	e.t.Helper()
	engStatus(e.t, r, want)
	engUntil(e.t, "the scheduler to return", func() bool { return e.s.eng.wait(r, 0) })
}

// delivRec is the run's recorded delivery.
func (r *run) delivRec(t testing.TB) model.RunDelivery {
	t.Helper()
	st := r.engState()
	if st.Delivery == nil {
		t.Fatalf("the run has no delivery (status %s)", st.Status)
	}
	return *st.Delivery
}

func delivJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

// delivFolder is everything a delivery could change in the person's repository: HEAD and its
// branch, the index, the status, every ref and the work trees.
func (e *engEnv) delivFolder() string {
	e.t.Helper()
	branch, _ := e.repo.GitIn(e.repo.Dir(), "symbolic-ref", "-q", "--short", "HEAD")
	return strings.Join([]string{e.repo.Git("rev-parse", "HEAD"), branch, e.repo.Git("ls-files", "--stage"),
		e.repo.Git("status", "--porcelain", "--ignored"), e.repo.Git("for-each-ref"), e.repo.Git("worktree", "list", "--porcelain")}, "\n--\n")
}

// delivRunBranches lists the branches of the run that the repository has.
func (e *engEnv) delivRunBranches(id string) string {
	e.t.Helper()
	return e.repo.Git("for-each-ref", "--format=%(refname:short)", "refs/heads/aiwb/"+id+"/")
}

// delivNothingLeft checks that nothing of the ended run is left in the repository or beside the
// app's home: no branch, no work tree, no work folder.
func (e *engEnv) delivNothingLeft(id string) {
	e.t.Helper()
	if got := e.delivRunBranches(id); got != "" {
		e.t.Errorf("branches of the run are left: %q", got)
	}
	if list := e.repo.Git("worktree", "list", "--porcelain"); strings.Count(list, "worktree ") != 1 {
		e.t.Errorf("work trees are left:\n%s", list)
	}
	if engExists(e.s.Store.P.RunWorkDir(id)) {
		e.t.Errorf("the run's work folder is left: %v", mustReadDir(e.t, e.s.Store.P.RunWorkDir(id)))
	}
}

func (e *engEnv) delivFile(rel string) string {
	b, _ := os.ReadFile(filepath.Join(e.repo.Dir(), rel))
	return string(b)
}

// The run completes: its result is in the person's folder, HEAD is the result, nothing is
// uncommitted, the detail says applied, and no branch or work tree of the run is left.
func TestDeliverAtTheEnd(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.delivStart("r_auto", nil)
	e.delivPlay(r, model.Achieved, "a.txt: made by the run", "docs/b.txt: more")
	// The person's own uncommitted work that the result does not touch stays as it is.
	engWrite(t, e.repo.Dir(), "notes.txt", "mine\n")
	engWrite(t, e.repo.Dir(), "README.md", "the project, edited\n")
	r.startEngine()
	e.delivEnded(r, model.RunCompleted)

	g := r.engGit()
	head := e.repo.Git("rev-parse", "HEAD")
	if head == g.BaseRef || head != g.ResultHead || e.repo.Git("symbolic-ref", "--short", "HEAD") != "main" {
		t.Fatalf("the folder's HEAD is %s, the result %s, the base %s", head, g.ResultHead, g.BaseRef)
	}
	if e.delivFile("a.txt") != "made by the run\n" || e.delivFile("docs/b.txt") != "more\n" {
		t.Errorf("the result's files in the folder: %q %q", e.delivFile("a.txt"), e.delivFile("docs/b.txt"))
	}
	if got := e.repo.Git("status", "--porcelain"); got != "M README.md\n?? notes.txt" && got != " M README.md\n?? notes.txt" {
		t.Errorf("the folder's status: %q", got)
	}
	d, err := e.s.Detail(r.id)
	if err != nil || d.Delivery == nil {
		t.Fatalf("the detail: %+v %v", d.Delivery, err)
	}
	want := model.RunDelivery{State: model.DeliveryApplied, Auto: true, At: d.Delivery.At, Result: head, Commit: head, How: "ff", Branch: "main"}
	if delivJSON(*d.Delivery) != delivJSON(want) || d.Delivery.At == 0 {
		t.Errorf("the detail's delivery: %s, want %s", delivJSON(*d.Delivery), delivJSON(want))
	}
	if v, _ := e.s.View(r.id); v.Delivery != model.DeliveryApplied {
		t.Errorf("the view's delivery: %q", v.Delivery)
	}
	// It is part of the run_finished entry: no entry of its own.
	es := readEntries(t, r.dir)
	if last := es[len(es)-1]; last.Kind != KRunFinished || last.Patch.State == nil || last.Patch.State.Delivery == nil || engCount(engKinds(t, r), KRunDelivery) != 0 {
		t.Errorf("the last entry: %s", last.Kind)
	}
	e.delivNothingLeft(r.id)
	if engExists(e.s.Store.P.RunWork) {
		t.Error("the folder of all runs' work is left")
	}
	// What a chat on the run is told of its merged work still holds, though the branch is gone.
	if f, err := r.gitFacts(t.Context()); err != nil || f.Head != head || f.Commits != 4 { // two tasks: a commit and a merge each
		t.Errorf("gitFacts after the branch went: %+v %v", f, err)
	}

	// Asking again changes nothing and writes nothing: the record is the answer.
	before, entries := e.delivFolder(), len(es)
	for _, ask := range []func() (model.RunDelivery, error){
		func() (model.RunDelivery, error) { return e.s.Delivery(r.id) },
		func() (model.RunDelivery, error) { return e.s.Apply(r.id, "") },
	} {
		if got, err := ask(); err != nil || delivJSON(got) != delivJSON(want) {
			t.Errorf("asked again: %s %v", delivJSON(got), err)
		}
	}
	if e.delivFolder() != before || len(readEntries(t, r.dir)) != entries {
		t.Error("asking again changed the folder or the record")
	}
	// A server that stopped after the run's last entry and before its branches went leaves
	// them; the next Apply answers from the record and removes them.
	e.repo.Git("branch", "aiwb/r_auto/integration", head)
	e.repo.Git("branch", "aiwb/r_auto/T01", head+"~1")
	if got, err := e.s.Apply(r.id, ""); err != nil || delivJSON(got) != delivJSON(want) || len(readEntries(t, r.dir)) != entries {
		t.Errorf("apply with branches left: %s %v", delivJSON(got), err)
	}
	e.delivNothingLeft(r.id)
}

// The result reached the folder without a record of it: the person merged the run's branch by
// hand, or the server stopped between a fast-forward a person asked for and its entry. The dry
// run finds it there and records nothing; Apply records it as applied, how "already".
func TestApplyAfterAMergeByHand(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.delivStart("r_hand", func(m *model.RunMeta) { m.Settings.ApplyResult = "manual" })
	e.s.add(r)
	e.delivPlay(r, model.Achieved, "a.txt: made by the run")
	r.startEngine()
	e.delivEnded(r, model.RunCompleted)
	result := r.engGit().ResultHead
	e.repo.Git("merge", "-q", "--ff-only", "aiwb/r_hand/integration")
	entries := len(readEntries(t, r.dir))
	want := model.RunDelivery{State: model.DeliveryApplied, Result: result, Commit: result, How: "already", Branch: "main"}
	if dry, err := e.s.Delivery(r.id); err != nil || delivJSON(dry) != delivJSON(want) {
		t.Errorf("the dry run: %s %v, want %s", delivJSON(dry), err, delivJSON(want))
	}
	if rec := r.delivRec(t); rec.State != model.DeliveryPending || len(readEntries(t, r.dir)) != entries {
		t.Errorf("the dry run recorded something: %s", delivJSON(rec))
	}
	got, err := e.s.Apply(r.id, "")
	want.At = got.At
	if err != nil || delivJSON(got) != delivJSON(want) || got.At == 0 || delivJSON(r.delivRec(t)) != delivJSON(want) {
		t.Errorf("apply: %s %v, want %s", delivJSON(got), err, delivJSON(want))
	}
	if es := readEntries(t, r.dir); len(es) != entries+1 || es[len(es)-1].Kind != KRunDelivery {
		t.Errorf("%d entries, were %d", len(es), entries)
	}
	e.delivNothingLeft(r.id)
}

// A clean folder with a commit of the person's own made while the run worked: the result is
// merged outside the folder and the folder fast-forwards to the merge commit.
func TestDeliverMergesWithThePersonsCommits(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.delivStart("r_own", nil)
	e.delivPlay(r, model.Achieved, "a.txt: made by the run")
	e.gates.block("T01-work")
	r.startEngine()
	engUntil(t, "the task's agent", func() bool { return len(e.host.sent("T01-work")) == 1 })
	e.repo.Write("mine.txt", "mine\n")
	mine := e.repo.Commit("my own commit")
	e.gates.open("T01-work")
	e.delivEnded(r, model.RunCompleted)

	d, g := r.delivRec(t), r.engGit()
	head := e.repo.Git("rev-parse", "HEAD")
	if d.State != model.DeliveryApplied || d.How != "merge" || !d.Auto || d.Commit != head || d.Result != g.ResultHead || head == g.ResultHead {
		t.Fatalf("the delivery: %s", delivJSON(d))
	}
	if got := e.repo.Git("log", "-1", "--format=%P|%s"); got != mine+" "+g.ResultHead+`|Merge run "the run" (r_own)` {
		t.Errorf("the merge commit: %q", got)
	}
	if e.delivFile("a.txt") != "made by the run\n" || e.delivFile("mine.txt") != "mine\n" || e.repo.Git("status", "--porcelain") != "" {
		t.Errorf("the folder after the merge: %q", e.repo.Git("status", "--porcelain"))
	}
	e.delivNothingLeft(r.id)
}

// An uncommitted change to a file the result changes blocks the automatic apply and leaves the
// folder exactly as it was; a dry run says the same and changes and records nothing; when the
// person has committed, Apply merges.
func TestDeliverBlockedThenApply(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	e.repo.Write("big.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n")
	e.repo.Commit("a longer file")
	r := e.delivStart("r_block", nil)
	e.play(r, func() { e.add(r, 1, "Add a line", true) }, func(m *engMsg) bool {
		switch m.Name {
		case "T01-work":
			engWrite(t, m.Cwd, "big.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11 by the run\n")
			engWrite(t, m.Cwd, "new.txt", "new\n")
		case "turn-002":
			e.finishRun(r, 2, model.Achieved)
		}
		return false
	})
	engWrite(t, e.repo.Dir(), "big.txt", "1 mine\n2\n3\n4\n5\n6\n7\n8\n9\n10\n")
	before := e.delivFolder()
	r.startEngine()
	e.delivEnded(r, model.RunCompleted)

	g := r.engGit()
	d := r.delivRec(t)
	want := model.RunDelivery{State: model.DeliveryBlocked, Reason: "local_changes", Auto: true, At: d.At, Result: g.ResultHead, Branch: "main", Files: []string{"big.txt"}}
	if delivJSON(d) != delivJSON(want) || d.At == 0 {
		t.Fatalf("the delivery: %s, want %s", delivJSON(d), delivJSON(want))
	}
	// The folder is as it was, but for the run's integration and task branch.
	ib := "aiwb/r_block/integration"
	if got := e.delivRunBranches(r.id); got != "aiwb/r_block/T01\n"+ib {
		t.Errorf("the run's branches: %q", got)
	}
	e.repo.Git("branch", "-D", "aiwb/r_block/T01")
	saved := e.repo.Git("rev-parse", ib)
	e.repo.Git("update-ref", "-d", "refs/heads/"+ib)
	if e.delivFolder() != before || e.delivFile("big.txt") != "1 mine\n2\n3\n4\n5\n6\n7\n8\n9\n10\n" || engExists(filepath.Join(e.repo.Dir(), "new.txt")) {
		t.Errorf("the blocked delivery changed the folder:\n%s\nbefore:\n%s", e.delivFolder(), before)
	}
	e.repo.Git("update-ref", "refs/heads/"+ib, saved)
	if engExists(e.s.Store.P.RunWorkDir(r.id)) {
		t.Error("the run's work folder is left")
	}

	// The dry run: the same answer, nothing changed, nothing recorded.
	before, entries := e.delivFolder(), len(readEntries(t, r.dir))
	dry, err := e.s.Delivery(r.id)
	want.Auto, want.At = false, 0
	if err != nil || delivJSON(dry) != delivJSON(want) {
		t.Errorf("the dry run: %s %v, want %s", delivJSON(dry), err, delivJSON(want))
	}
	// Apply by hand is refused the same way, and is one run_delivery entry.
	got, err := e.s.Apply(r.id, "")
	want.At = got.At
	if err != nil || delivJSON(got) != delivJSON(want) || got.At == 0 {
		t.Errorf("apply with the change in the way: %s %v", delivJSON(got), err)
	}
	if es := readEntries(t, r.dir); len(es) != entries+1 || es[len(es)-1].Kind != KRunDelivery || e.delivFolder() != before {
		t.Errorf("after the refused apply: %d entries (were %d), folder changed %v", len(es), entries, e.delivFolder() != before)
	}
	if det, _ := e.s.Detail(r.id); det.Delivery == nil || delivJSON(*det.Delivery) != delivJSON(want) {
		t.Errorf("the detail after the refused apply: %s", delivJSON(det.Delivery))
	}

	// The person commits; the dry run now expects the apply to work and still changes nothing.
	e.repo.Git("add", "big.txt")
	mine := e.repo.Commit("my line")
	before, entries = e.delivFolder(), len(readEntries(t, r.dir))
	dry, err = e.s.Delivery(r.id)
	if err != nil || delivJSON(dry) != delivJSON(model.RunDelivery{State: model.DeliveryPending, Reason: "manual", Result: g.ResultHead, Branch: "main"}) {
		t.Errorf("the dry run after the commit: %s %v", delivJSON(dry), err)
	}
	if e.delivFolder() != before || len(readEntries(t, r.dir)) != entries || engExists(e.s.Store.P.RunWorkDir(r.id)) {
		t.Errorf("the dry run changed something:\n%s\nbefore:\n%s", e.delivFolder(), before)
	}
	if n := strings.Count(e.repo.Git("worktree", "list", "--porcelain"), "worktree "); n != 1 {
		t.Errorf("%d work trees after the dry run", n)
	}

	got, err = e.s.Apply(r.id, "")
	head := e.repo.Git("rev-parse", "HEAD")
	if err != nil || got.State != model.DeliveryApplied || got.How != "merge" || got.Auto || got.Commit != head || got.Result != g.ResultHead || got.Partial {
		t.Fatalf("apply after the commit: %s %v", delivJSON(got), err)
	}
	if e.repo.Git("log", "-1", "--format=%P") != mine+" "+g.ResultHead || e.repo.Git("status", "--porcelain") != "" ||
		e.delivFile("big.txt") != "1 mine\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11 by the run\n" || e.delivFile("new.txt") != "new\n" {
		t.Errorf("the folder after the apply: %q", e.delivFile("big.txt"))
	}
	if rec := r.delivRec(t); delivJSON(rec) != delivJSON(got) {
		t.Errorf("the record: %s", delivJSON(rec))
	}
	e.delivNothingLeft(r.id)
	// The record survives a restart.
	r = e.reload(r.id)
	if det, err := e.s.Detail(r.id); err != nil || det.Delivery == nil || delivJSON(*det.Delivery) != delivJSON(got) {
		t.Errorf("the detail after a restart: %s %v", delivJSON(det.Delivery), err)
	}
}

// applyResult manual: the run's end applies nothing and the result waits; Apply brings it in.
func TestDeliverManual(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.delivStart("r_manual", func(m *model.RunMeta) { m.Settings.ApplyResult = "manual" })
	e.delivPlay(r, model.Achieved, "a.txt: made by the run")
	before := e.repo.Git("rev-parse", "HEAD")
	r.startEngine()
	e.delivEnded(r, model.RunCompleted)

	g := r.engGit()
	if d := r.delivRec(t); delivJSON(d) != delivJSON(model.RunDelivery{State: model.DeliveryPending, Reason: "manual", Result: g.ResultHead}) {
		t.Fatalf("the delivery: %s", delivJSON(d))
	}
	if e.repo.Git("rev-parse", "HEAD") != before || e.repo.Git("status", "--porcelain") != "" || engExists(filepath.Join(e.repo.Dir(), "a.txt")) {
		t.Error("the folder changed though the result is applied by hand")
	}
	if got := e.delivRunBranches(r.id); got != "aiwb/r_manual/T01\naiwb/r_manual/integration" {
		t.Errorf("the run's branches: %q", got)
	}
	if v, _ := e.s.View(r.id); v.Delivery != model.DeliveryPending {
		t.Errorf("the view's delivery: %q", v.Delivery)
	}
	got, err := e.s.Apply(r.id, "")
	if err != nil || got.State != model.DeliveryApplied || got.How != "ff" || got.Auto || got.Commit != g.ResultHead || got.Branch != "main" || got.Partial || got.At == 0 {
		t.Fatalf("apply: %s %v", delivJSON(got), err)
	}
	if e.repo.Git("rev-parse", "HEAD") != g.ResultHead || e.delivFile("a.txt") != "made by the run\n" || e.repo.Git("status", "--porcelain") != "" {
		t.Error("the folder after the apply")
	}
	e.delivNothingLeft(r.id)
}

// The run gives up: nothing is applied by itself, and what was finished can be applied by hand.
func TestDeliverGaveUp(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.delivStart("r_gave", nil)
	e.delivPlay(r, model.NotAchieved, "a.txt: half of it")
	before := e.repo.Git("rev-parse", "HEAD")
	r.startEngine()
	e.delivEnded(r, model.RunGaveUp)

	g := r.engGit()
	if d := r.delivRec(t); delivJSON(d) != delivJSON(model.RunDelivery{State: model.DeliveryPending, Reason: "not_achieved", Result: g.ResultHead, Partial: true}) {
		t.Fatalf("the delivery: %s", delivJSON(d))
	}
	if e.repo.Git("rev-parse", "HEAD") != before || engExists(filepath.Join(e.repo.Dir(), "a.txt")) {
		t.Error("the folder changed though the run gave up")
	}
	if dry, err := e.s.Delivery(r.id); err != nil || dry.State != model.DeliveryPending || dry.Reason != "not_achieved" || !dry.Partial || dry.Branch != "main" {
		t.Errorf("the dry run: %s %v", delivJSON(dry), err)
	}
	got, err := e.s.Apply(r.id, "")
	if err != nil || got.State != model.DeliveryApplied || got.How != "ff" || !got.Partial || got.Commit != g.ResultHead {
		t.Fatalf("apply: %s %v", delivJSON(got), err)
	}
	if e.delivFile("a.txt") != "half of it\n" || e.repo.Git("status", "--porcelain") != "" {
		t.Error("the folder after the apply")
	}
	e.delivNothingLeft(r.id)
}

// A run that changed nothing has nothing to apply, whatever its setting.
func TestDeliverNoChanges(t *testing.T) {
	t.Parallel()
	for _, mode := range []string{"auto", "manual"} {
		t.Run(mode, func(t *testing.T) {
			t.Parallel()
			e := newEngEnv(t, true)
			r := e.delivStart("r_none", func(m *model.RunMeta) { m.Settings.ApplyResult = mode })
			e.play(r, nil, func(m *engMsg) bool {
				if m.Name == "turn-001" {
					e.finishRun(r, 1, model.Achieved)
				}
				return false
			})
			before := e.repo.Git("rev-parse", "HEAD")
			r.startEngine()
			e.delivEnded(r, model.RunCompleted)
			if d := r.delivRec(t); d.State != model.DeliveryNone || d.Reason != "no_changes" || d.Partial || d.Result != "" {
				t.Errorf("the delivery: %s", delivJSON(d))
			}
			if got, err := e.s.Apply(r.id, ""); err != nil || got.State != model.DeliveryNone || got.Reason != "no_changes" {
				t.Errorf("apply: %s %v", delivJSON(got), err)
			}
			if e.repo.Git("rev-parse", "HEAD") != before {
				t.Error("HEAD moved")
			}
		})
	}
}

// A run without git works in the folder itself: there is nothing to apply, and nothing is
// recorded when a person asks.
func TestDeliverNoGit(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.delivStart("r_nogit", nil)
	e.play(r, nil, func(m *engMsg) bool {
		if m.Name == "turn-001" {
			e.finishRun(r, 1, model.Achieved)
		}
		return false
	})
	r.startEngine()
	e.delivEnded(r, model.RunCompleted)
	want := delivJSON(model.RunDelivery{State: model.DeliveryNone, Reason: "no_git"})
	if d := r.delivRec(t); delivJSON(d) != want {
		t.Errorf("the delivery: %s", delivJSON(d))
	}
	if det, _ := e.s.Detail(r.id); det.Delivery == nil || delivJSON(*det.Delivery) != want {
		t.Errorf("the detail: %s", delivJSON(det.Delivery))
	}
	entries := len(readEntries(t, r.dir))
	if got, err := e.s.Apply(r.id, ""); err != nil || delivJSON(got) != want {
		t.Errorf("apply: %s %v", delivJSON(got), err)
	}
	if got, err := e.s.Delivery(r.id); err != nil || delivJSON(got) != want {
		t.Errorf("the dry run: %s %v", delivJSON(got), err)
	}
	if len(readEntries(t, r.dir)) != entries {
		t.Error("an entry was written for a run without git")
	}
}

// Apply and the dry run are refused for a run that is going, a draft, an archived run and a run
// that does not exist.
func TestApplyRefusals(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	if _, err := e.s.Apply("r_nope", ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("apply of no run: %v", err)
	}
	if _, err := e.s.Delivery("r_nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("the dry run of no run: %v", err)
	}
	draft := e.draft("r_draft")
	e.s.add(draft)
	if _, err := e.s.Apply(draft.id, ""); !errors.Is(err, ErrNotStarted) {
		t.Errorf("apply of a draft: %v", err)
	}
	if _, err := e.s.Delivery(draft.id); !errors.Is(err, ErrNotStarted) {
		t.Errorf("the dry run of a draft: %v", err)
	}

	r := e.delivStart("r_live", nil)
	e.s.add(r)
	e.delivPlay(r, model.Achieved, "a.txt: made by the run")
	e.gates.block("turn-002")
	r.startEngine()
	engUntil(t, "the second turn", func() bool { return len(e.host.sent("turn-002")) == 1 })
	before := e.delivFolder()
	if _, err := e.s.Apply(r.id, ""); !errors.Is(err, ErrLive) {
		t.Errorf("apply of a run that is going: %v", err)
	}
	if _, err := e.s.Delivery(r.id); !errors.Is(err, ErrLive) {
		t.Errorf("the dry run of a run that is going: %v", err)
	}
	if ErrLive.Error() != "the run is still going: its result can be applied when it has ended or is stopped" {
		t.Errorf("ErrLive: %q", ErrLive)
	}
	if e.delivFolder() != before || engCount(engKinds(t, r), KRunDelivery) != 0 {
		t.Error("a refused apply changed the folder or the record")
	}
	// Stopping: still live.
	if err := r.halt(Halting{Status: model.RunStopped, Stop: model.StopUser}); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunStopped)
	e.gates.open("turn-002")

	// Archived: the dry run answers, Apply does not.
	if err := e.s.Archive(r.id, model.Archive{}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.Apply(r.id, ""); !errors.Is(err, ErrArchived) {
		t.Errorf("apply of an archived run: %v", err)
	}
	if d, err := e.s.Delivery(r.id); err != nil || d.State != model.DeliveryPending || d.Reason != "halted" || !d.Partial {
		t.Errorf("the dry run of an archived run: %s %v", delivJSON(d), err)
	}
	if e.delivFolder() != before {
		t.Error("the folder changed")
	}
}

// A stopped run: what it has merged so far is applied by hand as a partial result, its branches
// stay because the run goes on, and when it is resumed and completes the folder fast-forwards
// from there.
func TestApplyPartialThenResume(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.delivStart("r_part", nil)
	e.s.add(r)
	e.delivPlay(r, model.Achieved, "a.txt: the first half", "b.txt: the second half")
	e.gates.block("T02-work")
	r.startEngine()
	engUntil(t, "the second task's agent", func() bool { return len(e.host.sent("T02-work")) == 1 })
	if err := r.halt(Halting{Status: model.RunStopped, Reason: "stopped by the user", Stop: model.StopUser}); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunStopped)
	g := r.engGit()
	ib := "aiwb/r_part/integration"
	half := e.repo.Git("rev-parse", ib)
	if st := r.engState(); st.Delivery != nil {
		t.Errorf("a halt recorded a delivery: %s", delivJSON(st.Delivery))
	}
	if dry, err := e.s.Delivery(r.id); err != nil || delivJSON(dry) != delivJSON(model.RunDelivery{State: model.DeliveryPending, Reason: "halted", Result: half, Branch: "main", Partial: true}) {
		t.Errorf("the dry run of the stopped run: %s %v", delivJSON(dry), err)
	}

	got, err := e.s.Apply(r.id, "")
	if err != nil || got.State != model.DeliveryApplied || got.How != "ff" || !got.Partial || got.Auto || got.Result != half || got.Commit != half || half == g.BaseRef {
		t.Fatalf("apply of the stopped run: %s %v", delivJSON(got), err)
	}
	if e.repo.Git("rev-parse", "HEAD") != half || e.delivFile("a.txt") != "the first half\n" || engExists(filepath.Join(e.repo.Dir(), "b.txt")) || e.repo.Git("status", "--porcelain") != "" {
		t.Error("the folder after the partial apply")
	}
	// The run is not over: its branches and checkouts stay.
	if e.repo.Git("rev-parse", ib) != half || !engExists(r.engIntDir(g)) || !strings.Contains(e.delivRunBranches(r.id), "aiwb/r_part/T02") {
		t.Errorf("the run's branches after the partial apply: %q", e.delivRunBranches(r.id))
	}
	if det, _ := e.s.Detail(r.id); det.Delivery == nil || delivJSON(*det.Delivery) != delivJSON(got) {
		t.Errorf("the detail of the stopped run: %s", delivJSON(det.Delivery))
	}
	if again, err := e.s.Delivery(r.id); err != nil || delivJSON(again) != delivJSON(got) {
		t.Errorf("the dry run after the partial apply: %s %v", delivJSON(again), err)
	}

	e.gates.open("T02-work")
	if err := r.resume(); err != nil {
		t.Fatal(err)
	}
	// A live run shows no delivery, though the record keeps the last one.
	if det, _ := e.s.Detail(r.id); det.Status.Live() && det.Delivery != nil {
		t.Errorf("a live run shows a delivery: %s", delivJSON(det.Delivery))
	}
	e.delivEnded(r, model.RunCompleted)
	d := r.delivRec(t)
	head := e.repo.Git("rev-parse", "HEAD")
	if d.State != model.DeliveryApplied || d.How != "ff" || !d.Auto || d.Partial || d.Commit != head || head == half || head != r.engGit().ResultHead {
		t.Fatalf("the delivery at the end: %s", delivJSON(d))
	}
	if e.repo.Git("merge-base", "HEAD", half) != half {
		t.Error("the end did not go on from the partial result")
	}
	if e.delivFile("b.txt") != "the second half\n" || e.repo.Git("status", "--porcelain") != "" {
		t.Error("the folder at the end")
	}
	e.delivNothingLeft(r.id)
}

// A stopped run whose partial result was applied and that ends without merging anything more:
// the result is in the folder already, also when the end would not apply by itself.
func TestDeliverAlreadyThereWhenTheRunGivesUp(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.delivStart("r_same", nil)
	e.s.add(r)
	e.delivPlay(r, model.NotAchieved, "a.txt: all there is")
	e.gates.block("turn-002")
	r.startEngine()
	engUntil(t, "the second turn", func() bool { return len(e.host.sent("turn-002")) == 1 })
	if err := r.halt(Halting{Status: model.RunStopped, Stop: model.StopUser}); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunStopped)
	if got, err := e.s.Apply(r.id, ""); err != nil || got.State != model.DeliveryApplied || !got.Partial {
		t.Fatalf("apply: %s %v", delivJSON(got), err)
	}
	head := e.repo.Git("rev-parse", "HEAD")
	e.gates.open("turn-002")
	if err := r.resume(); err != nil {
		t.Fatal(err)
	}
	e.delivEnded(r, model.RunGaveUp)
	d := r.delivRec(t)
	if d.State != model.DeliveryApplied || d.How != "already" || d.Auto || !d.Partial || d.Commit != head || d.Result != head || e.repo.Git("rev-parse", "HEAD") != head {
		t.Errorf("the delivery at the end: %s", delivJSON(d))
	}
	e.delivNothingLeft(r.id)
}

// The folder is on another branch than at the start: nothing is applied by itself, and not by
// hand either until the request names that branch; then the result is merged into it and the
// branch the run started on stays where it was.
func TestDeliverOnAnotherBranch(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.delivStart("r_other", nil)
	e.delivPlay(r, model.Achieved, "a.txt: made by the run")
	e.gates.block("T01-work")
	r.startEngine()
	engUntil(t, "the task's agent", func() bool { return len(e.host.sent("T01-work")) == 1 })
	e.repo.Git("checkout", "-q", "-b", "side")
	e.repo.Write("side.txt", "side\n")
	side := e.repo.Commit("on the side")
	e.gates.open("T01-work")
	e.delivEnded(r, model.RunCompleted)

	g := r.engGit()
	want := model.RunDelivery{State: model.DeliveryPending, Reason: "other_branch", Auto: true, Result: g.ResultHead, Branch: "side"}
	d := r.delivRec(t)
	want.At = d.At
	if delivJSON(d) != delivJSON(want) {
		t.Fatalf("the delivery: %s, want %s", delivJSON(d), delivJSON(want))
	}
	before := e.delivFolder()
	want.Auto = false
	for _, named := range []string{"", "main", "HEAD"} {
		got, err := e.s.Apply(r.id, named)
		want.At = got.At
		if err != nil || delivJSON(got) != delivJSON(want) {
			t.Errorf("apply naming %q: %s %v", named, delivJSON(got), err)
		}
	}
	if e.delivFolder() != before {
		t.Error("the folder changed before the branch was named")
	}
	got, err := e.s.Apply(r.id, "side")
	head := e.repo.Git("rev-parse", "HEAD")
	if err != nil || got.State != model.DeliveryApplied || got.How != "merge" || got.Branch != "side" || got.Commit != head {
		t.Fatalf("apply naming the branch: %s %v", delivJSON(got), err)
	}
	if e.repo.Git("log", "-1", "--format=%P") != side+" "+g.ResultHead || e.repo.Git("rev-parse", "main") != g.BaseRef ||
		e.repo.Git("symbolic-ref", "--short", "HEAD") != "side" || e.delivFile("a.txt") != "made by the run\n" || e.repo.Git("status", "--porcelain") != "" {
		t.Error("the folder after the apply onto the other branch")
	}
	e.delivNothingLeft(r.id)
}

// A detached HEAD at the start and at the end: the result is applied, and the integration branch
// stays, because no branch of the person's holds the result.
func TestDeliverDetached(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	e.repo.Git("checkout", "-q", "--detach")
	r := e.run("r_det", nil) // no branch on the record: started detached
	e.delivPlay(r, model.Achieved, "a.txt: made by the run")
	r.startEngine()
	e.delivEnded(r, model.RunCompleted)
	d, g := r.delivRec(t), r.engGit()
	if d.State != model.DeliveryApplied || d.How != "ff" || d.Branch != "" || e.repo.Git("rev-parse", "HEAD") != g.ResultHead {
		t.Fatalf("the delivery: %s", delivJSON(d))
	}
	if got := e.delivRunBranches(r.id); got != "aiwb/r_det/integration" {
		t.Errorf("the run's branches: %q", got)
	}
	// Deleting the run keeps it too: nothing else names the result.
	e.s.add(r)
	if err := e.s.Delete(r.id); err != nil {
		t.Fatal(err)
	}
	if got := e.delivRunBranches(r.id); got != "aiwb/r_det/integration" || e.repo.Git("rev-parse", got) != g.ResultHead {
		t.Errorf("the run's branches after the delete: %q", got)
	}
}

// The server stops between the fast-forward and the run_finished entry: the journal has no such
// entry and the folder is at the result. The next start finishes the run and finds the result
// there.
func TestFinishAfterACrashBetweenApplyAndEntry(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.delivStart("r_crash", nil)
	e.delivPlay(r, model.Achieved, "a.txt: made by the run")
	e.gates.block("turn-002")
	r.startEngine()
	engUntil(t, "the second turn", func() bool { return len(e.host.sent("turn-002")) == 1 })
	r = e.restart(r.id) // the server is gone; the run is recorded as running
	e.finishRun(r, 2, model.Achieved)
	g, meta := r.engGit(), r.engMeta()
	head := e.repo.Git("rev-parse", "aiwb/r_crash/integration")
	// What engFinish did before the server died: the delivery, and nothing after it.
	if d := r.delivAtEnd(t.Context(), g, meta, model.RunCompleted, head); d.State != model.DeliveryApplied || d.How != "ff" {
		t.Fatalf("the delivery before the crash: %s", delivJSON(d))
	}
	if e.repo.Git("rev-parse", "HEAD") != head || engCount(engKinds(t, r), KRunFinished) != 0 || r.engSt() != model.RunRunning {
		t.Fatal("the state at the crash is not the one the test is about")
	}

	r = e.reload(r.id)
	e.s.Boot()
	e.delivEnded(r, model.RunCompleted)
	d := r.delivRec(t)
	want := model.RunDelivery{State: model.DeliveryApplied, Auto: true, At: d.At, Result: head, Commit: head, How: "already", Branch: "main"}
	if delivJSON(d) != delivJSON(want) {
		t.Errorf("the delivery after the restart: %s, want %s", delivJSON(d), delivJSON(want))
	}
	if e.repo.Git("rev-parse", "HEAD") != head || e.repo.Git("status", "--porcelain") != "" || e.delivFile("a.txt") != "made by the run\n" {
		t.Error("the folder after the restart")
	}
	if ks := engKinds(t, r); engCount(ks, KRunFinished) != 1 || engCount(ks, KRunDelivery) != 0 {
		t.Errorf("entries: %v", ks)
	}
	e.delivNothingLeft(r.id)
	// And once more: a finished run is left alone.
	r = e.reload(r.id)
	e.s.Boot()
	if got := r.viewNow(); got.Status != model.RunCompleted || got.Delivery != model.DeliveryApplied {
		t.Errorf("after a second restart: %s %q", got.Status, got.Delivery)
	}
}

// Two runs that started from the same commit of one repository end one after the other: the
// first fast-forwards the folder, the second is merged with it, and the folder holds both.
func TestDeliverTwoRunsOnOneRepository(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	one := e.delivStart("r_one", nil)
	two := e.delivStart("r_two", nil)
	e.delivPlay(one, model.Achieved, "one.txt: of the first run")
	one.startEngine()
	e.delivEnded(one, model.RunCompleted)
	first := e.repo.Git("rev-parse", "HEAD")
	if d := one.delivRec(t); d.State != model.DeliveryApplied || d.How != "ff" || d.Commit != first {
		t.Fatalf("the first run's delivery: %s", delivJSON(d))
	}
	e.delivPlay(two, model.Achieved, "two.txt: of the second run")
	two.startEngine()
	e.delivEnded(two, model.RunCompleted)
	d := two.delivRec(t)
	head := e.repo.Git("rev-parse", "HEAD")
	if d.State != model.DeliveryApplied || d.How != "merge" || d.Commit != head || d.Result != two.engGit().ResultHead {
		t.Fatalf("the second run's delivery: %s", delivJSON(d))
	}
	if e.repo.Git("log", "-1", "--format=%P|%s") != first+" "+d.Result+`|Merge run "the run" (r_two)` {
		t.Errorf("the merge commit: %q", e.repo.Git("log", "-1", "--format=%P|%s"))
	}
	if e.delivFile("one.txt") != "of the first run\n" || e.delivFile("two.txt") != "of the second run\n" || e.repo.Git("status", "--porcelain") != "" {
		t.Error("the folder does not hold both results")
	}
	e.delivNothingLeft(one.id)
	e.delivNothingLeft(two.id)
	if got := e.repo.Git("for-each-ref", "--format=%(refname:short)", "refs/heads"); got != "main" {
		t.Errorf("branches: %q", got)
	}
}

// Two runs whose results change the same line: the second is blocked with the file, nothing of
// the conflict reaches the folder, and its integration branch stays for a merge by hand.
func TestDeliverConflictWithAnotherRun(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	one := e.delivStart("r_c1", nil)
	two := e.delivStart("r_c2", nil)
	e.delivPlay(one, model.Achieved, "f.txt: of the first run")
	one.startEngine()
	e.delivEnded(one, model.RunCompleted)
	before := e.delivFolder()
	e.delivPlay(two, model.Achieved, "f.txt: of the second run")
	two.startEngine()
	e.delivEnded(two, model.RunCompleted)
	d := two.delivRec(t)
	if d.State != model.DeliveryBlocked || d.Reason != "conflict" || fmt.Sprint(d.Files) != "[f.txt]" || !d.Auto {
		t.Fatalf("the second run's delivery: %s", delivJSON(d))
	}
	if got := e.delivRunBranches(two.id); got != "aiwb/r_c2/T01\naiwb/r_c2/integration" {
		t.Errorf("the second run's branches: %q", got)
	}
	e.repo.Git("branch", "-D", "aiwb/r_c2/T01", "aiwb/r_c2/integration")
	if e.delivFolder() != before || e.delivFile("f.txt") != "of the first run\n" {
		t.Error("the conflict reached the folder")
	}
	if engExists(e.s.Store.P.RunWorkDir(two.id)) {
		t.Error("the scratch work tree or the work folder is left")
	}
}

// Deleting a run removes its work trees and its branches; only an integration branch whose result
// is not in the person's folder stays. After a result was applied, the branch of an attempt that
// was not merged stays until the delete.
func TestDeliverDeleteKeepsOnlyAnUnappliedResult(t *testing.T) {
	t.Parallel()
	// play is a run with a merged task and a failed one that left a commit on its branch.
	play := func(e *engEnv, r *run) {
		e.play(r, func() {
			e.add(r, 1, "Works", true)
			e.add(r, 1, "Fails", true)
		}, func(m *engMsg) bool {
			switch {
			case m.Name == "T01-work":
				engWrite(t, m.Cwd, "a.txt", "made by the run\n")
			case m.Name == "T02-work":
				engWrite(t, m.Cwd, "half.txt", "half\n")
				m.Block("failed", "Could not.", "No.")
				return true
			case m.Role == model.RoleOrchestrator && r.engTaskState("T01").Final() && r.engTaskState("T02").Final() && r.engState().Result == nil:
				e.finishRun(r, len(r.engTurns()), model.Achieved)
			}
			return false
		})
	}
	t.Run("applied", func(t *testing.T) {
		t.Parallel()
		e := newEngEnv(t, true)
		r := e.delivStart("r_app", nil)
		e.s.add(r)
		play(e, r)
		r.startEngine()
		e.delivEnded(r, model.RunCompleted)
		if d := r.delivRec(t); d.State != model.DeliveryApplied {
			t.Fatalf("the delivery: %s", delivJSON(d))
		}
		head := e.repo.Git("rev-parse", "HEAD")
		// The failed attempt's branch is all that is left, and it holds what the attempt wrote.
		if got := e.delivRunBranches(r.id); got != "aiwb/r_app/T02" || e.repo.Git("show", got+":half.txt") != "half" {
			t.Errorf("the run's branches after the apply: %q", got)
		}
		if err := e.s.Delete(r.id); err != nil {
			t.Fatal(err)
		}
		if got := e.repo.Git("for-each-ref", "--format=%(refname:short)", "refs/heads"); got != "main" {
			t.Errorf("branches after the delete: %q", got)
		}
		if e.repo.Git("rev-parse", "HEAD") != head || e.repo.Git("status", "--porcelain") != "" || e.delivFile("a.txt") != "made by the run\n" {
			t.Error("the delete touched the folder")
		}
		e.delivNothingLeft(r.id)
	})
	t.Run("not applied", func(t *testing.T) {
		t.Parallel()
		e := newEngEnv(t, true)
		r := e.delivStart("r_not", func(m *model.RunMeta) { m.Settings.ApplyResult = "manual" })
		e.s.add(r)
		play(e, r)
		r.startEngine()
		e.delivEnded(r, model.RunCompleted)
		result := r.engGit().ResultHead
		if got := e.delivRunBranches(r.id); got != "aiwb/r_not/T01\naiwb/r_not/T02\naiwb/r_not/integration" {
			t.Errorf("the run's branches before the delete: %q", got)
		}
		before := e.repo.Git("rev-parse", "HEAD")
		if err := e.s.Delete(r.id); err != nil {
			t.Fatal(err)
		}
		if got := e.repo.Git("for-each-ref", "--format=%(refname:short)", "refs/heads"); got != "aiwb/r_not/integration\nmain" {
			t.Errorf("branches after the delete: %q", got)
		}
		if e.repo.Git("rev-parse", "aiwb/r_not/integration") != result || e.repo.Git("rev-parse", "HEAD") != before || e.repo.Git("status", "--porcelain") != "" {
			t.Error("the delete moved the result or touched the folder")
		}
		if list := e.repo.Git("worktree", "list", "--porcelain"); strings.Count(list, "worktree ") != 1 {
			t.Errorf("work trees after the delete:\n%s", list)
		}
	})
	t.Run("archive", func(t *testing.T) {
		t.Parallel()
		e := newEngEnv(t, true)
		r := e.delivStart("r_arch", func(m *model.RunMeta) { m.Settings.ApplyResult = "manual" })
		e.s.add(r)
		play(e, r)
		r.startEngine()
		e.delivEnded(r, model.RunCompleted)
		before := e.delivFolder()
		if err := e.s.Archive(r.id, model.Archive{}); err != nil {
			t.Fatal(err)
		}
		if e.delivFolder() != before {
			t.Error("the archive removed something from the repository")
		}
	})
}

// keepWorktrees: the result is applied, and the checkouts and the branches they are on stay.
func TestDeliverKeepsWorktreesWhenAsked(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.delivStart("r_keep", func(m *model.RunMeta) { m.Settings.KeepWorktrees = true })
	e.delivPlay(r, model.Achieved, "a.txt: made by the run")
	r.startEngine()
	e.delivEnded(r, model.RunCompleted)
	if d := r.delivRec(t); d.State != model.DeliveryApplied || d.How != "ff" || e.delivFile("a.txt") != "made by the run\n" {
		t.Fatalf("the delivery: %s", delivJSON(d))
	}
	if got := e.delivRunBranches(r.id); got != "aiwb/r_keep/T01\naiwb/r_keep/integration" {
		t.Errorf("the run's branches: %q", got)
	}
	if !engExists(r.engIntDir(r.engGit())) {
		t.Error("the integration checkout is gone")
	}
}

// An untracked file of the person's where the result adds one blocks the delivery and stays.
func TestDeliverUntrackedFileInTheWay(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.delivStart("r_way", nil)
	e.delivPlay(r, model.Achieved, "a.txt: made by the run")
	engWrite(t, e.repo.Dir(), "a.txt", "mine, untracked\n")
	r.startEngine()
	e.delivEnded(r, model.RunCompleted)
	if d := r.delivRec(t); d.State != model.DeliveryBlocked || d.Reason != "local_changes" || fmt.Sprint(d.Files) != "[a.txt]" || e.delivFile("a.txt") != "mine, untracked\n" {
		t.Errorf("the delivery: %s", delivJSON(d))
	}
}

// The folder is gone, is no repository any more, or the result cannot be read when the run ends:
// the delivery is blocked with that reason, whether the end would have applied it or not.
func TestDeliverAtEndWithoutTheFolder(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.delivStart("r_lost", nil)
	g, head := r.engGit(), e.repo.Commit("--allow-empty")
	plain := t.TempDir()
	for _, set := range []string{"auto", "manual"} {
		meta := r.engMeta()
		meta.Settings.ApplyResult = set
		for _, c := range []struct{ repo, head, reason string }{
			{filepath.Join(plain, "nowhere"), head, "folder_missing"},
			{plain, head, "not_repo"},
			{g.Repo, "", "result_missing"},
			{g.Repo, strings.Repeat("0", 40), "result_missing"},
		} {
			lost := *g
			lost.Repo = c.repo
			d := r.delivAtEnd(t.Context(), &lost, meta, model.RunCompleted, c.head)
			if d.State != model.DeliveryBlocked || d.Reason != c.reason || d.Auto != (set == "auto") || d.At == 0 {
				t.Errorf("%s, the folder %s, the result %q: %s, want blocked %s", set, c.repo, c.head, delivJSON(d), c.reason)
			}
		}
	}
	if engExists(e.s.Store.P.RunWork) {
		t.Error("a folder for the run's work was made")
	}
}
