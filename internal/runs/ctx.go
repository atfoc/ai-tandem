package runs

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// The readable copies of a run: its agents are refused everything under the app's home, so the
// goal, the briefs and the reports they may read are copied to <RunWork>/<run>/ctx/, beside the
// run's checkouts (and there in a run without git too):
//
//	ctx/goal.md
//	ctx/briefs/<task>.md           the current revision
//	ctx/reports/<task>.a<N>.md     the report of attempt N
//
// Folders are 0700 and files 0400. The records under the run's folder stay the truth: a copy is
// only ever written from them, and replaced as a whole. ctxSync writes all of them at every
// engine start, commit mirrors the briefs and reports of its entry, readable writes the one it is
// asked for when it is missing or differs, and ctxRemove takes the folder when the run finishes
// or is deleted. It is kept while the run is halted: resumed agents use it.

type ctxKind int

const (
	ctxGoal ctxKind = iota
	ctxBrief
	ctxReport
)

// ctxDir is the folder of the run's readable copies: <RunWork>/<run>/ctx. The goal is at
// ctxDir()/goal.md, briefs are at ctxDir()/briefs/<id>.md, reports at ctxDir()/reports/<id>.a<N>.md.
func (r *run) ctxDir() string { return filepath.Join(r.svc.Store.P.RunWorkDir(r.id), "ctx") }

func ctxGoalRel() string             { return "goal.md" }
func ctxBriefRel(task string) string { return filepath.Join("briefs", task+".md") }
func ctxReportRel(task string, attempt int) string {
	return filepath.Join("reports", fmt.Sprintf("%s.a%d.md", task, attempt))
}

// readable is the path of the copy an agent of the run can read: the goal, the current brief of
// task, or the report of attempt n of task. It writes the copy when it is missing or differs
// from the record. ok is false when the record has no such text or the copy cannot be written:
// the caller then puts the text in the prompt or leaves it out. It locks r.mu itself: never call
// it with r.mu held.
func (r *run) readable(kind ctxKind, task string, attempt int) (path string, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.gone {
		return "", false
	}
	var rel, text string
	var err error
	switch kind {
	case ctxGoal:
		rel = ctxGoalRel()
		text, err = readGoal(r.dir)
	case ctxBrief:
		if !safeID(task) || r.loadLocked() != nil {
			return "", false
		}
		rev, has := r.ctxRev(task)
		if !has {
			return "", false
		}
		rel = ctxBriefRel(task)
		text, err = readBrief(r.dir, task, rev)
	case ctxReport:
		rel = ctxReportRel(task, attempt)
		text, err = readReport(r.dir, task, attempt)
	default:
		return "", false
	}
	if err != nil {
		return "", false
	}
	if err := r.ctxPut(rel, []byte(text)); err != nil {
		log.Printf("runs: the readable copy %s of %s: %v", rel, r.id, err)
		return "", false
	}
	return filepath.Join(r.ctxDir(), rel), true
}

// ctxSync writes every copy from the records: the goal, the current brief of every task and
// every report there is. Every engine start calls it (prepare); it makes the run's work folder
// when there is none, which is the case in a run without git. It locks r.mu itself. The error is
// the first copy that could not be written; the others are written all the same.
func (r *run) ctxSync() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.gone {
		return ErrNotFound
	}
	if err := r.loadLocked(); err != nil {
		return err
	}
	if err := os.MkdirAll(r.ctxDir(), 0o700); err != nil {
		return err
	}
	var first error
	put := func(rel, text string, err error) {
		if errors.Is(err, ErrNoText) {
			return
		}
		if err == nil {
			err = r.ctxPut(rel, []byte(text))
		}
		if err != nil && first == nil {
			first = fmt.Errorf("%s: %w", rel, err)
		}
	}
	text, err := readGoal(r.dir)
	put(ctxGoalRel(), text, err)
	for _, t := range r.L.Tasks {
		id := t.ID
		if !safeID(id) {
			continue
		}
		text, err := readBrief(r.dir, id, t.BriefRev)
		put(ctxBriefRel(id), text, err)
		for _, a := range t.Attempts {
			text, err := readReport(r.dir, id, a.N)
			put(ctxReportRel(id, a.N), text, err)
		}
	}
	return first
}

// ctxMirror copies the files of a committed entry that are a brief or a report; commit calls it
// with r.mu held, after the entry is applied. A brief is copied only when it is the task's
// current revision. Nothing is written while the run has no ctx folder (before its first engine
// start, after it finished): ctxSync and readable make it. Best effort: a failure is logged.
func (r *run) ctxMirror(files []txFile) {
	if len(files) == 0 {
		return
	}
	if _, err := os.Stat(r.ctxDir()); err != nil {
		return
	}
	for _, f := range files {
		rel, ok := r.ctxRelOf(f.rel)
		if !ok {
			continue
		}
		if err := r.ctxPut(rel, f.data); err != nil {
			log.Printf("runs: the readable copy %s of %s: %v", rel, r.id, err)
		}
	}
}

// ctxRelOf is where the copy of a file of the run's folder goes (rel as Tx.File takes it); ok is
// false for a file that has no copy. Called with r.mu held.
func (r *run) ctxRelOf(rel string) (string, bool) {
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) != 3 || parts[0] != "tasks" || !safeID(parts[1]) {
		return "", false
	}
	task, name := parts[1], parts[2]
	var n int
	if _, err := fmt.Sscanf(name, "brief.r%d.md", &n); err == nil && briefRel(task, n) == filepath.ToSlash(rel) {
		if rev, has := r.ctxRev(task); !has || rev != n {
			return "", false
		}
		return ctxBriefRel(task), true
	}
	if _, err := fmt.Sscanf(name, "a%d.report.md", &n); err == nil && reportRel(task, n) == filepath.ToSlash(rel) {
		return ctxReportRel(task, n), true
	}
	return "", false
}

// ctxRev is the current revision of a task's brief. Called with r.mu held.
func (r *run) ctxRev(task string) (int, bool) {
	if r.L == nil {
		return 0, false
	}
	for _, t := range r.L.Tasks {
		if t.ID == task {
			return t.BriefRev, true
		}
	}
	return 0, false
}

// ctxPut makes the copy rel hold data: nothing is written when it does already, otherwise a new
// file (0400, in a folder 0700) replaces it atomically. Called with r.mu held, which is what
// keeps two writers off the same temporary file.
func (r *run) ctxPut(rel string, data []byte) error {
	if !filepath.IsLocal(rel) {
		return fmt.Errorf("%q is not a path inside the folder of the run's copies", rel)
	}
	path := filepath.Join(r.ctxDir(), rel)
	if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, data) {
		if st, err := os.Stat(path); err == nil && st.Mode().Perm() == 0o400 {
			return nil
		}
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// A read-only file cannot be written again, and neither can what a crash left of one: the
	// new text goes to a fresh file that is renamed over the old one.
	tmp := filepath.Join(dir, "."+filepath.Base(path)+".tmp")
	if err := os.Remove(tmp); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.WriteFile(tmp, data, 0o400); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Chmod(tmp, 0o400); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// ctxRemove removes the run's readable copies: when the run finishes (engFinish, with the
// checkouts) and when it is deleted (removeCheckouts). The run's work folder goes too when that
// left it empty, and the folder of all runs' work with its last run, unless the run keeps its
// worktrees. A failure is logged: the folder goes when the run is deleted. It locks r.mu itself.
func (r *run) ctxRemove() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := os.RemoveAll(r.ctxDir()); err != nil {
		log.Printf("runs: remove the readable copies of %s: %v", r.id, err)
		return
	}
	if r.meta.Settings.KeepWorktrees {
		return
	}
	// Both fail when the folder is not empty, which is what is wanted.
	if os.Remove(r.svc.Store.P.RunWorkDir(r.id)) == nil {
		os.Remove(r.svc.Store.P.RunWork)
	}
}
