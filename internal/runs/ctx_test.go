package runs

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"ai-whiteboard/internal/model"
)

// ctxModes checks the modes under a run's ctx folder: folders 0700, files 0400, and no temporary
// file left.
func ctxModes(t *testing.T, dir string) {
	t.Helper()
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		want := fs.FileMode(0o400)
		if d.IsDir() {
			want = 0o700
		}
		if info.Mode().Perm() != want {
			t.Errorf("%s has mode %o, want %o", path, info.Mode().Perm(), want)
		}
		if filepath.Ext(path) == ".tmp" {
			t.Errorf("a temporary file is left: %s", path)
		}
		return nil
	})
	if err != nil {
		t.Error(err)
	}
}

// ctxFile is a copy's text; "" with a test error when it cannot be read.
func ctxFile(t *testing.T, r *run, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(r.ctxDir(), rel))
	if err != nil {
		t.Errorf("the copy %s: %v", rel, err)
	}
	return string(b)
}

// The copies agents can read, through a whole run with and without git: they equal the records
// after a task is added, after its brief is updated and after its report is written; readable
// writes them again when the folder is deleted; the folder is kept while the run is halted and
// goes when it finished, with the run's work folder when nothing else is in it.
func TestCtxCopies(t *testing.T) {
	t.Parallel()
	for _, git := range []bool{true, false} {
		t.Run(fmt.Sprintf("git=%v", git), func(t *testing.T) {
			t.Parallel()
			h := newMx(t, git)
			h.plan(mxPlan{
				Turn: func(a *mxTurn, n int) {
					if n == 1 {
						a.Add("Look", false)
						a.Say("One task.")
						return
					}
					if mxAllDone(a.State()) && !a.Gate("end") {
						return
					}
					mxFinishWhenDone(a)
				},
				Task: func(a *mxTurn, tk Task) {
					if !a.Gate("work") {
						return
					}
					a.Done("Looked.")
				},
			})
			h.startRun(nil)
			h.atGate("work")
			r := h.r()
			p := h.world().st.P
			dir := filepath.Join(p.RunWorkDir(h.id), "ctx")
			if r.ctxDir() != dir {
				t.Fatalf("ctxDir is %s, want %s", r.ctxDir(), dir)
			}

			// The goal and the brief of the task that was added.
			goal, err := readGoal(r.dir)
			if err != nil || goal == "" {
				t.Fatalf("the goal: %q, %v", goal, err)
			}
			brief, err := readBrief(r.dir, "T01", 1)
			if err != nil || brief == "" {
				t.Fatalf("the brief: %q, %v", brief, err)
			}
			if got := ctxFile(t, r, "goal.md"); got != goal {
				t.Errorf("the copy of the goal: %q", got)
			}
			if got := ctxFile(t, r, "briefs/T01.md"); got != brief {
				t.Errorf("the copy of the brief: %q", got)
			}
			if path, ok := r.readable(ctxGoal, "", 0); !ok || path != filepath.Join(dir, "goal.md") {
				t.Errorf("readable goal: %s, %v", path, ok)
			}
			if path, ok := r.readable(ctxBrief, "T01", 0); !ok || path != filepath.Join(dir, "briefs", "T01.md") {
				t.Errorf("readable brief: %s, %v", path, ok)
			}
			// Nothing for what the record does not have.
			if path, ok := r.readable(ctxReport, "T01", 1); ok || path != "" {
				t.Errorf("readable of a report that is not written: %s, %v", path, ok)
			}
			for _, c := range []struct {
				kind    ctxKind
				task    string
				attempt int
			}{{ctxBrief, "T09", 0}, {ctxBrief, "../T01", 0}, {ctxReport, "T09", 1}, {ctxReport, "../T01", 1}, {ctxKind(9), "T01", 1}} {
				if path, ok := r.readable(c.kind, c.task, c.attempt); ok || path != "" {
					t.Errorf("readable(%d, %q, %d): %s, %v", c.kind, c.task, c.attempt, path, ok)
				}
			}
			if ents, _ := os.ReadDir(filepath.Join(dir, "reports")); len(ents) != 0 {
				t.Errorf("reports/ holds %d files before any report", len(ents))
			}
			ctxModes(t, dir)

			// A new revision of the brief: the copy is the new one, over a read-only file.
			next := "Look twice, and say what you saw.\n"
			if _, err := r.commit(KOp, func(tx *Tx) error {
				tk := tx.Task("T01")
				tk.BriefRev++
				tk.Briefs = append(tk.Briefs, model.BriefRev{Rev: tk.BriefRev, At: tx.Now(), Size: toolChars(next)})
				tx.File(briefRel("T01", tk.BriefRev), []byte(next))
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if got := ctxFile(t, r, "briefs/T01.md"); got != next {
				t.Errorf("the copy of the brief after an update: %q", got)
			}
			if rec, _ := readBrief(r.dir, "T01", 1); rec != brief {
				t.Errorf("revision 1 of the brief changed: %q", rec)
			}
			ctxModes(t, dir)

			// A copy that differs is written again from the record, and so is a folder that is gone.
			if err := os.Chmod(filepath.Join(dir, "goal.md"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "goal.md"), []byte("something else"), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, ok := r.readable(ctxGoal, "", 0); !ok || ctxFile(t, r, "goal.md") != goal {
				t.Error("readable did not write a copy that differed again")
			}
			if err := os.RemoveAll(dir); err != nil {
				t.Fatal(err)
			}
			if path, ok := r.readable(ctxBrief, "T01", 0); !ok || ctxFile(t, r, "briefs/T01.md") != next {
				t.Errorf("readable after the folder was deleted: %s, %v", path, ok)
			}
			if _, ok := r.readable(ctxGoal, "", 0); !ok || ctxFile(t, r, "goal.md") != goal {
				t.Error("readable did not write the goal after the folder was deleted")
			}
			ctxModes(t, dir)

			// Halted: the copies stay, a resumed agent reads them. The next engine start writes
			// what is missing.
			h.stopRun()
			h.idleEngine()
			if got := ctxFile(t, r, "briefs/T01.md"); got != next {
				t.Errorf("the copy of the brief while the run is halted: %q", got)
			}
			if err := os.Remove(filepath.Join(dir, "goal.md")); err != nil {
				t.Fatal(err)
			}
			h.regate("work")
			h.resume()
			h.atGate("work")
			if got := ctxFile(t, r, "goal.md"); got != goal {
				t.Errorf("the copy of the goal after the resume: %q", got)
			}

			// The report, when the task has ended.
			h.open("work")
			h.atGate("end")
			tk, at := h.task("T01")
			if tk.State() != model.TaskDone {
				t.Fatalf("T01 is %s\n%s", tk.State(), h.dump())
			}
			report, err := readReport(r.dir, "T01", at.N)
			if err != nil || report == "" {
				t.Fatalf("the report: %q, %v", report, err)
			}
			rel := fmt.Sprintf("reports/T01.a%d.md", at.N)
			if got := ctxFile(t, r, rel); got != report {
				t.Errorf("the copy of the report: %q, the record %q", got, report)
			}
			if path, ok := r.readable(ctxReport, "T01", at.N); !ok || path != filepath.Join(dir, filepath.FromSlash(rel)) {
				t.Errorf("readable report: %s, %v", path, ok)
			}
			if _, ok := r.readable(ctxReport, "T01", at.N+1); ok {
				t.Error("readable of an attempt that does not exist")
			}
			ctxModes(t, dir)
			// Nothing of it is in the folder the run works in.
			if _, err := os.Stat(filepath.Join(h.cwd, "ctx")); !os.IsNotExist(err) {
				t.Errorf("a ctx folder in the user's folder: %v", err)
			}

			// Finished: the copies go, and the work folder with them.
			h.open("end")
			h.finished()
			for _, gone := range []string{dir, p.RunWorkDir(h.id), p.RunWork} {
				if _, err := os.Stat(gone); !os.IsNotExist(err) {
					t.Errorf("%s is left after the run finished: %v", gone, err)
				}
			}
			// The records are where they were.
			if rec, _ := readReport(r.dir, "T01", at.N); rec != report {
				t.Errorf("the report's record after the finish: %q", rec)
			}
			if rec, _ := readBrief(r.dir, "T01", 2); rec != next {
				t.Errorf("the brief's record after the finish: %q", rec)
			}
		})
	}
}

// keepWorktrees: the copies go when the run finishes, the run's work folder stays, also when
// nothing is left in it; the delete takes it.
func TestCtxKeepWorktrees(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	mxOneTask(h)
	h.startRun(func(m *model.RunMeta) { m.Settings.KeepWorktrees = true })
	h.atGate("work")
	p := h.world().st.P
	work := p.RunWorkDir(h.id)
	if _, err := os.Stat(filepath.Join(work, "ctx", "briefs", "T01.md")); err != nil {
		t.Errorf("a run without git has no copy of the brief: %v", err)
	}
	h.open("work")
	h.finished()
	if _, err := os.Stat(filepath.Join(work, "ctx")); !os.IsNotExist(err) {
		t.Errorf("ctx is left after the run finished: %v", err)
	}
	if _, err := os.Stat(work); err != nil {
		t.Errorf("the work folder of a run that keeps its worktrees: %v", err)
	}
	if err := h.s().Delete(h.id); err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{work, p.RunWork} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Errorf("%s is left after the delete: %v", gone, err)
		}
	}
}

// ctxSync writes every copy from the records, and commit mirrors nothing into a folder that is
// not there: a run that has no engine yet, or has finished, gets no ctx folder from an entry.
func TestCtxSync(t *testing.T) {
	e := newEngEnv(t, false)
	r := e.run("r_ctx", nil)
	e.add(r, 1, "one", false)
	e.add(r, 1, "two", false)
	if _, err := os.Stat(r.ctxDir()); !os.IsNotExist(err) {
		t.Fatalf("a commit made the ctx folder: %v", err)
	}
	if err := writeReport(r.dir, "T02", 1, "the report of T02\n"); err != nil {
		t.Fatal(err)
	}
	if err := r.ctxSync(); err != nil {
		t.Fatal(err)
	}
	goal, _ := readGoal(r.dir)
	if got := ctxFile(t, r, "goal.md"); got != goal || goal == "" {
		t.Errorf("the copy of the goal: %q", got)
	}
	for _, id := range []string{"T01", "T02"} {
		brief, err := readBrief(r.dir, id, 1)
		if err != nil {
			t.Fatal(err)
		}
		if got := ctxFile(t, r, "briefs/"+id+".md"); got != brief {
			t.Errorf("the copy of the brief of %s: %q", id, got)
		}
	}
	ctxModes(t, r.ctxDir())
	// Only attempts the record has get a copy of their report.
	tk, _ := r.engTask("T02")
	want := len(tk.Attempts) > 0
	if _, err := os.Stat(filepath.Join(r.ctxDir(), "reports", "T02.a1.md")); want != (err == nil) {
		t.Errorf("the copy of a report (the task has %d attempts): %v", len(tk.Attempts), err)
	}
	if path, ok := r.readable(ctxReport, "T02", 1); !ok || ctxFile(t, r, "reports/T02.a1.md") != "the report of T02\n" {
		t.Errorf("readable report: %s, %v", path, ok)
	}
	// A second sync changes nothing and fails on nothing that is read-only.
	if err := r.ctxSync(); err != nil {
		t.Errorf("a second ctxSync: %v", err)
	}
	r.ctxRemove()
	for _, gone := range []string{r.ctxDir(), e.s.Store.P.RunWorkDir(r.id), e.s.Store.P.RunWork} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Errorf("%s is left after ctxRemove: %v", gone, err)
		}
	}
}
