package runs

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/testset"
)

// The guards around a delivery: the result stays on a branch until it is on one of the person's
// own, a deleted run applies nothing, a scratch folder a crash left is no obstacle, a history
// that lost the run's start commit is told as it is, and a delivery of a result the run has
// moved on from is not shown.

// delivManual is a completed run with one merged task whose result waits for the person.
func delivManual(t *testing.T, id string) (e *engEnv, r *run, base, result string) {
	t.Helper()
	e = newEngEnv(t, true)
	r = e.delivStart(id, func(m *model.RunMeta) { m.Settings.ApplyResult = "manual" })
	e.s.add(r)
	e.delivPlay(r, model.Achieved, "a.txt: made by the run")
	base = e.repo.Git("rev-parse", "HEAD")
	r.startEngine()
	e.delivEnded(r, model.RunCompleted)
	return e, r, base, r.engGit().ResultHead
}

// A person who only looks at the result (on the run's branch, on a branch made from it, detached
// on it) and presses Apply has not applied it: the view does not say so while main is at the
// base, and deleting the run afterwards leaves the result on a branch.
func TestDeliverLookingIsNotApplying(t *testing.T) {
	t.Parallel()
	for _, how := range []string{"integration", "review", "detached"} {
		if !testset.Full() && how == "review" {
			continue // a whole run each
		}
		t.Run(how, func(t *testing.T) {
			t.Parallel()
			e, r, base, result := delivManual(t, "r_look")
			ib := "aiwb/r_look/integration"
			switch how {
			case "integration":
				e.repo.Git("switch", "-q", ib)
			case "review":
				e.repo.Git("switch", "-q", "-c", "review", ib)
			case "detached":
				e.repo.Git("checkout", "-q", "--detach", ib)
			}
			dry, err := e.s.Delivery(r.id)
			if err != nil || dry.State != model.DeliveryPending || dry.Reason != "other_branch" {
				t.Errorf("the dry run: %s %v", delivJSON(dry), err)
			}
			got, err := e.s.Apply(r.id, "")
			if err != nil || got.State != model.DeliveryPending || got.Reason != "other_branch" {
				t.Errorf("the apply: %s %v", delivJSON(got), err)
			}
			if v, _ := e.s.View(r.id); v.Delivery == model.DeliveryApplied || e.repo.Git("rev-parse", "main") != base {
				t.Errorf("the view says %q, main is at %s (base %s)", v.Delivery, e.repo.Git("rev-parse", "main"), base)
			}
			if e.repo.Git("rev-parse", ib) != result {
				t.Errorf("the integration branch after the apply: %q", e.delivRunBranches(r.id))
			}
			e.repo.Git("switch", "-q", "main")
			if how == "review" {
				e.repo.Git("branch", "-q", "-D", "review")
			}
			if err := e.s.Delete(r.id); err != nil {
				t.Fatal(err)
			}
			if got := e.repo.Git("for-each-ref", "--contains", result, "--format=%(refname:short)"); got != ib {
				t.Errorf("the refs that have the result after the delete: %q", got)
			}
		})
	}
}

// The branch the result was applied to is named by the person (Apply on review): the result is on
// a branch of their own, so the integration branch goes. Applied to the start branch and that
// branch moved back since: the record says applied, git says the result is nowhere else, and the
// integration branch stays when the run is deleted.
func TestDeliverIntegrationBranchGoesOnlyWhenTheResultIsElsewhere(t *testing.T) {
	t.Parallel()
	t.Run("named branch", func(t *testing.T) {
		t.Parallel()
		e, r, _, result := delivManual(t, "r_named")
		e.repo.Git("switch", "-q", "-c", "review")
		got, err := e.s.Apply(r.id, "review")
		if err != nil || got.State != model.DeliveryApplied || got.Branch != "review" || e.repo.Git("rev-parse", "review") != result {
			t.Fatalf("the apply: %s %v", delivJSON(got), err)
		}
		if e.delivRunBranches(r.id) != "" {
			t.Errorf("the run's branches: %q", e.delivRunBranches(r.id))
		}
	})
	t.Run("moved back", func(t *testing.T) {
		t.Parallel()
		e := newEngEnv(t, true)
		r := e.delivStart("r_back", func(m *model.RunMeta) { m.Settings.KeepWorktrees = true })
		e.s.add(r)
		e.delivPlay(r, model.Achieved, "a.txt: made by the run")
		base := e.repo.Git("rev-parse", "HEAD")
		r.startEngine()
		e.delivEnded(r, model.RunCompleted)
		result := r.engGit().ResultHead
		if d := r.delivRec(t); d.State != model.DeliveryApplied || d.Branch != "main" || e.repo.Git("rev-parse", "main") != result {
			t.Fatalf("the delivery: %s", delivJSON(d))
		}
		e.repo.Git("reset", "-q", "--hard", base)
		if err := e.s.Delete(r.id); err != nil {
			t.Fatal(err)
		}
		if got := e.repo.Git("for-each-ref", "--contains", result, "--format=%(refname:short)"); got != "aiwb/r_back/integration" {
			t.Errorf("the refs that have the result after the delete: %q", got)
		}
	})
	t.Run("on another branch of the person", func(t *testing.T) {
		t.Parallel()
		e, r, base, result := delivManual(t, "r_else")
		e.repo.Git("branch", "-q", "keep", result) // merged by hand, as far as git can tell
		if err := e.s.Delete(r.id); err != nil {
			t.Fatal(err)
		}
		if got := e.repo.Git("for-each-ref", "--format=%(refname:short)", "refs/heads"); got != "keep\nmain" || e.repo.Git("rev-parse", "main") != base {
			t.Errorf("branches after the delete: %q", got)
		}
	})
}

// An Apply that waited for a Delete finds the run gone and applies nothing.
func TestApplyAfterDelete(t *testing.T) {
	t.Parallel()
	t.Run("waiting", func(t *testing.T) {
		t.Parallel()
		e, r, base, _ := delivManual(t, "r_wait")
		unlock := e.s.svcLock(r.id) // the Delete has the run
		type answer struct {
			d   model.RunDelivery
			err error
		}
		apply, dry := make(chan answer, 1), make(chan answer, 1)
		go func() { d, err := e.s.Apply(r.id, ""); apply <- answer{d, err} }()
		go func() { d, err := e.s.Delivery(r.id); dry <- answer{d, err} }()
		time.Sleep(100 * time.Millisecond) // both have found the run and wait for its lock
		r.mu.Lock()
		r.gone = true
		r.mu.Unlock()
		unlock()
		for name, ch := range map[string]chan answer{"apply": apply, "dry run": dry} {
			if a := <-ch; !errors.Is(a.err, ErrNotFound) {
				t.Errorf("the %s of the deleted run: %s %v", name, delivJSON(a.d), a.err)
			}
		}
		if e.repo.Git("rev-parse", "HEAD") != base || e.repo.Git("status", "--porcelain") != "" {
			t.Error("the apply of the deleted run touched the folder")
		}
	})
	t.Run("racing", func(t *testing.T) {
		t.Parallel()
		e, r, _, result := delivManual(t, "r_race")
		var wg sync.WaitGroup
		var applyErr error
		wg.Add(2)
		go func() { defer wg.Done(); e.s.Delete(r.id) }()
		time.Sleep(5 * time.Millisecond)
		go func() { defer wg.Done(); _, applyErr = e.s.Apply(r.id, "") }()
		wg.Wait()
		if head := e.repo.Git("rev-parse", "HEAD"); applyErr != nil && head == result {
			t.Errorf("apply answered %q, and the folder has the result", applyErr)
		}
		if applyErr != nil && !errors.Is(applyErr, ErrNotFound) {
			t.Errorf("apply answered %v", applyErr)
		}
	})
}

// A scratch folder that a killed delivery left, and that git does not know as a work tree, does
// not block the Apply that needs a merge commit. A dry run leaves it where it is.
func TestApplyWithALeftOverScratchFolder(t *testing.T) {
	t.Parallel()
	e, r, _, result := delivManual(t, "r_left")
	e.repo.Write("mine.txt", "mine\n")
	mine := e.repo.Commit("my own commit")
	scratch := filepath.Join(e.s.Store.P.RunWorkDir(r.id), "apply")
	engWrite(t, scratch, "sub/left.txt", "left by a crash\n")
	if _, err := e.s.Delivery(r.id); err != nil || !engExists(filepath.Join(scratch, "sub", "left.txt")) {
		t.Fatalf("the dry run removed the folder, or failed: %v", err)
	}
	got, err := e.s.Apply(r.id, "")
	if err != nil || got.State != model.DeliveryApplied || got.How != "merge" {
		t.Fatalf("the apply: %s %v", delivJSON(got), err)
	}
	if e.repo.Git("log", "-1", "--format=%P") != mine+" "+result || e.delivFile("a.txt") != "made by the run\n" || e.repo.Git("status", "--porcelain") != "" {
		t.Error("the folder after the apply")
	}
	if engExists(scratch) {
		t.Error("the scratch folder is left")
	}
}

// The scratch path with a work tree of the repository on it is not the service's to remove.
func TestApplyLeavesAScratchFolderThatIsAWorkTree(t *testing.T) {
	t.Parallel()
	e, r, _, _ := delivManual(t, "r_wt")
	e.repo.Write("mine.txt", "mine\n")
	e.repo.Commit("my own commit")
	scratch := filepath.Join(e.s.Store.P.RunWorkDir(r.id), "apply")
	e.repo.Git("worktree", "add", "-q", "-b", "theirs", scratch, "HEAD")
	engWrite(t, scratch, "kept.txt", "kept\n")
	got, err := e.s.Apply(r.id, "")
	if err != nil || got.State != model.DeliveryBlocked {
		t.Errorf("the apply: %s %v", delivJSON(got), err)
	}
	if b, _ := os.ReadFile(filepath.Join(scratch, "kept.txt")); string(b) != "kept\n" {
		t.Error("the work tree at the scratch path was removed")
	}
}

// The person amends the commit the run started from while the run works. The end applies nothing
// by itself and says history_changed, with either setting; the dry run says it too; a person's
// Apply applies, and brings the start commit back.
func TestDeliverHistoryChanged(t *testing.T) {
	t.Parallel()
	for _, set := range []string{"auto", "manual"} {
		t.Run(set, func(t *testing.T) {
			t.Parallel()
			e := newEngEnv(t, true)
			e.repo.Write("start.txt", "the start\n") // the start commit is not the root: amending it leaves a common history
			e.repo.Commit("the start commit")
			r := e.delivStart("r_hist", func(m *model.RunMeta) { m.Settings.ApplyResult = set })
			e.s.add(r)
			e.delivPlay(r, model.Achieved, "a.txt: made by the run")
			base := e.repo.Git("rev-parse", "HEAD")
			e.gates.block("T01-work")
			r.startEngine()
			engUntil(t, "the task's agent", func() bool { return len(e.host.sent("T01-work")) == 1 })
			e.repo.Git("commit", "-q", "--amend", "--allow-empty", "-m", "the start commit, amended")
			amended := e.repo.Git("rev-parse", "HEAD")
			e.gates.open("T01-work")
			e.delivEnded(r, model.RunCompleted)
			result := r.engGit().ResultHead

			d := r.delivRec(t)
			if d.State != model.DeliveryPending || d.Reason != "history_changed" || d.Auto != (set == "auto") || d.Result != result || d.Partial {
				t.Fatalf("the delivery at the end: %s", delivJSON(d))
			}
			if e.repo.Git("rev-parse", "HEAD") != amended || e.repo.Git("status", "--porcelain") != "" || engExists(filepath.Join(e.repo.Dir(), "a.txt")) {
				t.Error("the end touched the folder")
			}
			det, _ := e.s.Detail(r.id)
			if v, _ := e.s.View(r.id); v.Delivery != model.DeliveryPending || det.Delivery == nil || det.Delivery.Reason != "history_changed" {
				t.Errorf("the view %q, the detail %s", v.Delivery, delivJSON(det.Delivery))
			}
			if dry, err := e.s.Delivery(r.id); err != nil || delivJSON(dry) != delivJSON(model.RunDelivery{State: model.DeliveryPending, Reason: "history_changed", Result: result, Branch: "main"}) {
				t.Errorf("the dry run: %s %v", delivJSON(dry), err)
			}
			if e.repo.Git("rev-parse", "HEAD") != amended || e.repo.Git("rev-parse", "aiwb/r_hist/integration") != result {
				t.Error("the dry run changed something")
			}
			got, err := e.s.Apply(r.id, "")
			if err != nil || got.State != model.DeliveryApplied || got.How != "merge" || got.Auto {
				t.Fatalf("the apply: %s %v", delivJSON(got), err)
			}
			if e.repo.Git("log", "-1", "--format=%P") != amended+" "+result || e.repo.Git("merge-base", "--is-ancestor", base, "HEAD") != "" || e.delivFile("a.txt") != "made by the run\n" {
				t.Error("the folder after the apply")
			}
			if again, err := e.s.Delivery(r.id); err != nil || again.State != model.DeliveryApplied {
				t.Errorf("the dry run after the apply: %s %v", delivJSON(again), err)
			}
		})
	}
}

// A stopped run whose partial result was applied, resumed, and stopped again after another task
// was merged: the record keeps the old delivery, and the detail and the view do not show it. The
// dry run says what is true, and an Apply is shown again.
func TestDeliverStaleAfterResume(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.delivStart("r_stale", nil)
	e.s.add(r)
	e.delivPlay(r, model.Achieved, "a.txt: one", "b.txt: two", "c.txt: three")
	e.gates.block("T02-work")
	e.gates.block("T03-work")
	r.startEngine()
	engUntil(t, "the second task's agent", func() bool { return len(e.host.sent("T02-work")) == 1 })
	stop := Halting{Status: model.RunStopped, Reason: "stopped by the user", Stop: model.StopUser}
	if err := r.halt(stop); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunStopped)
	ib := "aiwb/r_stale/integration"
	half := e.repo.Git("rev-parse", ib)
	got, err := e.s.Apply(r.id, "")
	if err != nil || got.State != model.DeliveryApplied || got.Result != half {
		t.Fatalf("the apply of the stopped run: %s %v", delivJSON(got), err)
	}
	if v, _ := e.s.View(r.id); v.Delivery != model.DeliveryApplied {
		t.Errorf("the view after the apply: %q", v.Delivery)
	}

	e.clock.Advance(time.Second) // what is merged from here on is merged after the apply
	e.gates.open("T02-work")
	if err := r.resume(); err != nil {
		t.Fatal(err)
	}
	engUntil(t, "the third task's agent", func() bool { return len(e.host.sent("T03-work")) == 1 })
	if err := r.halt(stop); err != nil {
		t.Fatal(err)
	}
	engStatus(t, r, model.RunStopped)
	more := e.repo.Git("rev-parse", ib)
	if more == half || e.repo.Git("rev-parse", "HEAD") != half {
		t.Fatalf("the result did not move, or the folder did: %s %s", more, half)
	}
	if d := r.delivRec(t); d.State != model.DeliveryApplied || d.Result != half {
		t.Errorf("the record: %s", delivJSON(d))
	}
	det, _ := e.s.Detail(r.id)
	if v, _ := e.s.View(r.id); v.Delivery != "" || det.Delivery != nil {
		t.Errorf("the stopped run shows the delivery of an older result: view %q, detail %s", v.Delivery, delivJSON(det.Delivery))
	}
	if ctx := e.s.ChatContext(r.id); strings.Contains(ctx, "was applied to your working folder") {
		t.Errorf("the chat context: %s", ctx)
	}
	if dry, err := e.s.Delivery(r.id); err != nil || delivJSON(dry) != delivJSON(model.RunDelivery{State: model.DeliveryPending, Reason: "halted", Result: more, Branch: "main", Partial: true}) {
		t.Errorf("the dry run: %s %v", delivJSON(dry), err)
	}
	got, err = e.s.Apply(r.id, "")
	if err != nil || got.State != model.DeliveryApplied || got.Result != more || e.repo.Git("rev-parse", "HEAD") != more {
		t.Fatalf("the second apply: %s %v", delivJSON(got), err)
	}
	det, _ = e.s.Detail(r.id)
	if v, _ := e.s.View(r.id); v.Delivery != model.DeliveryApplied || det.Delivery == nil || det.Delivery.Result != more {
		t.Errorf("after the second apply: view %q, detail %s", v.Delivery, delivJSON(det.Delivery))
	}
}
