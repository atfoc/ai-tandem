package runs

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/model"
)

// Git and folders: a run without git, a repository it cannot use, what a delete and an archive
// leave, and the guard on where a run's files are.

// A run in a folder that is no repository: writing tasks one at a time, no checkout, no commit,
// no merge; every agent works in the folder itself, the orchestrator without the right to write.
func TestNoGitRun(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	if err := os.WriteFile(filepath.Join(h.cwd, "kept.txt"), []byte("the user's\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.had = []string{"kept.txt"}
	var writers, most atomic.Int32
	h.plan(mxPlan{
		Turn: func(a *mxTurn, n int) {
			if n == 1 {
				a.Notes()
				a.Add("Write one", true)
				a.Add("Write two", true)
				a.Add("Write three", true)
				a.Add("Report", false)
				a.Say("Three writers and a reporter.")
				return
			}
			mxFinishWhenDone(a)
		},
		Task: func(a *mxTurn, tk Task) {
			if !tk.Writes {
				// The reporter works beside a writer: only writers exclude each other.
				if !a.Until(func(l *Loaded) bool { return a.h.turnsOf("T01-work") >= 1 }) {
					return
				}
				a.Done("Reported.")
				return
			}
			n := writers.Add(1)
			if n > most.Load() {
				most.Store(n)
			}
			a.Until(func(l *Loaded) bool { return mxState(l, "T04") == model.TaskDone })
			a.Write(filepath.Join("out", strings.ToLower(tk.ID)+".txt"), "the file of "+tk.ID+"\n")
			writers.Add(-1)
			a.Done("Wrote my file.")
		},
	})
	h.guard = true
	h.newRun(nil)
	var active atomic.Int32
	h.mu.Lock()
	h.onEntry = func(l *Loaded) {
		n := int32(0)
		for _, tk := range l.Tasks {
			if tk.Writes && tk.State().Active() {
				n++
			}
		}
		if n > active.Load() {
			active.Store(n)
		}
	}
	h.mu.Unlock()
	h.begin()
	l := h.finished()
	if active.Load() != 1 || most.Load() != 1 {
		t.Errorf("writing tasks at once: %d recorded, %d seen by the agents", active.Load(), most.Load())
	}
	if l.State.Git != nil || h.view().Git {
		t.Errorf("the run records git: %+v", l.State.Git)
	}
	for _, tk := range l.Tasks {
		at := tk.Attempts[0]
		if at.Base != "" || at.Branch != "" || at.Worktree != "" || at.Head != "" || at.Merged != "" || at.MergeRound != 0 {
			t.Errorf("%s has git fields: %+v", tk.ID, at)
		}
		for _, p := range at.Phases {
			if p.K == model.TaskMerge {
				t.Errorf("%s was in phase merge", tk.ID)
			}
		}
		if _, err := h.s().Changes(h.id, tk.ID, 1); !errors.Is(err, ErrNoText) {
			t.Errorf("changes of %s: %v", tk.ID, err)
		}
		if rep, err := h.s().Report(h.id, tk.ID, 1); err != nil || rep.Report == "" {
			t.Errorf("report of %s: %v", tk.ID, err)
		}
	}
	if _, err := os.Stat(h.world().st.P.RunWork); !os.IsNotExist(err) {
		t.Errorf("the folder of the run's work is left: %v", err)
	}
	h.mu.Lock()
	spawned := slices.Clone(h.spawned)
	h.mu.Unlock()
	for _, o := range spawned {
		name := h.names[o.ChatID]
		if o.Cwd != h.cwd {
			t.Errorf("%s worked in %s", name, o.Cwd)
		}
		if orch := strings.HasPrefix(name, "turn-"); o.ReadOnly != orch || !o.Unattended {
			t.Errorf("%s was started read-only %v, unattended %v", name, o.ReadOnly, o.Unattended)
		}
	}
	want := []string{"kept.txt", "out/t01.txt", "out/t02.txt", "out/t03.txt"}
	if got := mxFiles(t, h.cwd); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("the folder holds %v, want %v", got, want)
	}
}

// A repository without a commit cannot hold a run: the start is refused with the sentence the
// view shows, and nothing is recorded.
func TestNoCommitBlocked(t *testing.T) {
	t.Parallel()
	h := newMxIn(t, func(r *agenttest.Repo) { r.Write("draft.txt", "not committed\n") })
	h.newRun(nil)
	const sentence = svcNoCommit
	v, err := h.s().View(h.id)
	if err != nil || !v.Git || v.Blocked != sentence {
		t.Fatalf("the view: git %v, blocked %q, %v", v.Git, v.Blocked, err)
	}
	_, err = h.s().Start(h.id, mxGoal)
	var be *BlockedError
	if !errors.As(err, &be) || be.Reason != sentence {
		t.Fatalf("the start answered %v", err)
	}
	if v := h.view(); v.Status != model.RunDraft || !v.Started.IsZero() {
		t.Errorf("after the refused start the run is %s", v.Status)
	}
	if h.launches() != 0 {
		t.Error("an agent was launched")
	}
	if got := mxFiles(t, h.r().dir); fmt.Sprint(got) != "[run.json]" {
		t.Errorf("the run's folder holds %v", got)
	}
	// With a first commit the same run starts.
	h.repo.Commit("first")
	h.plan(mxPlan{Turn: func(a *mxTurn, n int) { a.Finish(); a.Say("Nothing to do.") }})
	h.begin()
	h.finished()
}

// A folder with uncommitted changes: the run starts from the last commit, says so to the
// orchestrator, and leaves the user's changes alone. Its result changes a file the user has
// changed, so it is not applied: the delivery is blocked with that file, and the result stays on
// the integration branch.
func TestDirtyRepoNote(t *testing.T) {
	t.Parallel()
	h := newMxIn(t, func(r *agenttest.Repo) {
		r.Write("shared.txt", "base\n")
		r.Commit("first")
		r.Write("shared.txt", "the user's unsaved line\n")
		r.Write("scratch.txt", "the user's scratch\n")
	})
	var saw atomic.Value
	h.plan(mxPlan{
		Turn: func(a *mxTurn, n int) {
			if n == 1 {
				a.Notes()
				a.Add("One", true)
				a.Say("One task.")
				return
			}
			mxFinishWhenDone(a)
		},
		Task: func(a *mxTurn, tk Task) {
			saw.Store(a.Read("shared.txt") + "|" + a.Read("scratch.txt"))
			mxLine(a, tk)
		},
	})
	h.startRun(nil)
	l := h.finished()
	const note = "The folder had uncommitted changes when the run started. The run started from the last commit and does not see them, and the result can only be applied to the folder where it does not touch the files they are in."
	if !l.State.Git.DirtyAtStart {
		t.Error("the run did not record that the folder was dirty")
	}
	if p := h.promptsOf("turn-001"); len(p) != 1 || !strings.Contains(p[0], note) {
		t.Error("the first turn was not told of the uncommitted changes")
	}
	if p := h.promptsOf("turn-002"); len(p) != 1 || strings.Contains(p[0], note) {
		t.Error("a later turn was told of the uncommitted changes again")
	}
	if got, _ := saw.Load().(string); got != "base\n|" {
		t.Errorf("the task's checkout held %q", got)
	}
	if got := h.intFile("shared.txt"); got != "line of T01" {
		t.Errorf("shared.txt on the integration branch: %q", got)
	}
	if b, _ := os.ReadFile(filepath.Join(h.cwd, "shared.txt")); string(b) != "the user's unsaved line\n" {
		t.Errorf("the user's shared.txt: %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(h.cwd, "scratch.txt")); string(b) != "the user's scratch\n" {
		t.Errorf("the user's scratch.txt: %q", b)
	}
	if got := h.repo.Git("status", "--porcelain"); got != "M shared.txt\n?? scratch.txt" && got != " M shared.txt\n?? scratch.txt" {
		t.Errorf("the user's work tree: %q", got)
	}
	d := l.State.Delivery
	if d == nil || d.State != model.DeliveryBlocked || d.Reason != "local_changes" || fmt.Sprint(d.Files) != "[shared.txt]" || !d.Auto || d.Result != l.State.Git.ResultHead {
		t.Errorf("the delivery: %+v", d)
	}
	if h.repo.Git("rev-parse", "main") != l.State.Git.BaseRef || h.repo.Git("rev-parse", svcIntegrationBranch(h.id)) != l.State.Git.ResultHead {
		t.Error("the user's branch moved, or the result is not on the integration branch")
	}
}

// A task agent that leaves its checkout on another branch fails its task: what is on the task's
// branch is not its work, and nothing is merged.
func TestAgentLeavesAnotherBranch(t *testing.T) {
	t.Parallel()
	h := newMx(t, true)
	h.plan(mxPlan{
		Turn: func(a *mxTurn, n int) {
			if n == 1 {
				a.Notes()
				a.Add("Write a file", true)
				a.Say("One task.")
				return
			}
			if l := a.State(); l != nil && l.Tasks[0].State().Final() {
				a.Finish()
			}
			a.Say("Looked.")
		},
		Task: func(a *mxTurn, tk Task) {
			a.Write("t01.txt", "the file of T01\n")
			for _, args := range [][]string{{"checkout", "-q", "-b", "my-own-branch"}, {"add", "-A"}, {"commit", "-q", "-m", "my work"}} {
				if out, err := h.repo.GitIn(a.Cwd, args...); err != nil {
					t.Errorf("git %v: %v %s", args, err, out)
				}
			}
			a.Done("Wrote the file and committed it.")
		},
	})
	h.startRun(nil)
	l := h.finished()
	tk, _ := mxTask(l, "T01")
	at := tk.Attempts[0]
	branch := "aiwb/" + h.id + "/T01"
	if tk.State() != model.TaskFailed || at.Merged != "" || at.Head != "" ||
		!strings.Contains(at.Error, "its agent left the work tree on branch my-own-branch instead of on "+branch+"; its work was not merged") {
		t.Fatalf("the task: %s, head %q, merged %q, %q", tk.State(), at.Head, at.Merged, at.Error)
	}
	if got := h.repo.Git("rev-parse", svcIntegrationBranch(h.id)); got != l.State.Git.BaseRef {
		t.Error("the integration branch moved")
	}
	if got := h.repo.Git("rev-parse", branch); got != l.State.Git.BaseRef {
		t.Error("the task's branch moved")
	}
	if got := h.repo.Git("show", "my-own-branch:t01.txt"); got != "the file of T01" {
		t.Errorf("the agent's own branch: %q", got)
	}
}

// keepWorktrees: the checkouts of ended tasks and of the finished run stay with their branches,
// though the result is applied to the user's folder, until the run is deleted.
func TestKeepWorktrees(t *testing.T) {
	t.Parallel()
	h := newMx(t, true)
	h.plan(mxPlan{Turn: mxTwoWriters, Task: func(a *mxTurn, tk Task) {
		if tk.ID == "T02" {
			a.Write("half.txt", "half\n")
			a.Say(agentBlock("failed", "Could not.", "No."))
			return
		}
		mxWriter(a, tk)
	}})
	h.startRun(func(m *model.RunMeta) { m.Settings.KeepWorktrees = true })
	l := h.finished()
	if d := l.State.Delivery; d == nil || d.State != model.DeliveryApplied || h.repo.Git("rev-parse", "main") != l.State.Git.ResultHead {
		t.Errorf("the delivery: %+v", d)
	}
	work := h.world().st.P.RunWorkDir(h.id)
	for _, dir := range []string{"int", "orch", "T01", "T02"} {
		if _, err := os.Stat(filepath.Join(work, dir, ".git")); err != nil {
			t.Errorf("the checkout %s is gone: %v", dir, err)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(work, "T01", "t01.txt")); string(b) != "the file of T01\n" {
		t.Errorf("the kept checkout of T01 holds %q", b)
	}
	// The failed task's work is committed to its branch all the same.
	if got := h.repo.Git("show", "aiwb/"+h.id+"/T02:half.txt"); got != "half" {
		t.Errorf("the failed task's branch: %q", got)
	}
	if n := strings.Count(h.repo.Git("worktree", "list", "--porcelain"), "worktree "); n != 5 {
		t.Errorf("%d work trees listed", n)
	}
	if got, want := h.branches(), []string{"aiwb/" + h.id + "/T01", "aiwb/" + h.id + "/T02", svcIntegrationBranch(h.id), "main"}; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("branches with the kept checkouts: %v, want %v", got, want)
	}
	if err := h.s().Delete(h.id); err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(h.repo.Git("worktree", "list", "--porcelain"), "worktree "); n != 1 {
		t.Errorf("%d work trees listed after the delete", n)
	}
	if _, err := os.Stat(work); !os.IsNotExist(err) {
		t.Errorf("the checkouts' folder after the delete: %v", err)
	}
	// The result was applied: the delete leaves no branch of the run, and the user's branch is
	// where the result put it.
	if got := h.branches(); fmt.Sprint(got) != "[main]" || h.repo.Git("rev-parse", "main") != l.State.Git.ResultHead || h.repo.Git("status", "--porcelain") != "" {
		t.Errorf("branches after the delete: %v", got)
	}
}

// Deleting a run, also one that is working: its agents are ended, its chats, its checkouts, its
// task branches and its folder go. Its integration branch stays, because what was merged into it
// was not applied to the user's folder, and the user's branch and work tree are not touched.
func TestDeleteRunKeepsBranches(t *testing.T) {
	t.Parallel()
	h := newMx(t, true)
	h.plan(mxPlan{Turn: mxTwoWriters, Task: mxLine, Merge: func(a *mxTurn, tk Task) {
		if a.Gate("merge") {
			mxRefMerge(a)
		}
	}})
	h.startRun(nil)
	h.atGate("merge")
	chat, _ := h.newChat()
	if err := h.cm().Send(chat, "Hello.", "", nil); err != nil {
		t.Fatal(err)
	}
	h.wait("the chat to have answered", func() bool { return h.launches() > 0 && !h.cm().Busy(chat) })
	l := h.L()
	dir, work := h.r().dir, h.world().st.P.RunWorkDir(h.id)
	if n := strings.Count(h.repo.Git("worktree", "list", "--porcelain"), "worktree "); n < 3 {
		t.Fatalf("only %d work trees while the run works", n)
	}
	ib := svcIntegrationBranch(h.id)
	head := h.repo.Git("rev-parse", ib)
	main := h.repo.Git("rev-parse", "main")
	if err := h.s().Delete(h.id); err != nil {
		t.Fatalf("delete: %v", err)
	}
	h.noProcess("after the delete")
	if _, err := h.s().View(h.id); !errors.Is(err, ErrNotFound) {
		t.Errorf("the deleted run: %v", err)
	}
	for _, gone := range []string{dir, work, h.world().st.P.RunWork} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Errorf("%s is still there: %v", gone, err)
		}
	}
	if list := h.repo.Git("worktree", "list", "--porcelain"); strings.Count(list, "worktree ") != 1 {
		t.Errorf("work trees after the delete:\n%s", list)
	}
	if head == main {
		t.Fatal("nothing was merged when the run was deleted: the test is about a result that is kept")
	}
	want := []string{ib, "main"}
	if got := h.branches(); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("branches after the delete: %v, want %v", got, want)
	}
	if h.repo.Git("rev-parse", ib) != head || h.repo.Git("rev-parse", "main") != main || h.repo.Git("status", "--porcelain") != "" ||
		h.repo.Git("rev-parse", "--abbrev-ref", "HEAD") != "main" {
		t.Error("the delete moved a branch or touched the user's work tree")
	}
	// The kept branch holds the task that was merged before the delete.
	merged := 0
	for _, tk := range l.Tasks {
		if at := tk.Attempts[len(tk.Attempts)-1]; at.Merged != "" {
			merged++
			if got := h.repo.Git("show", ib+":shared.txt"); !strings.Contains(got, "line of "+tk.ID) {
				t.Errorf("the kept integration branch lacks the work of %s: %q", tk.ID, got)
			}
		}
	}
	if merged == 0 {
		t.Error("no task was recorded as merged")
	}
	if people, agents := h.cm().ChatsOfRun(h.id); len(people)+len(agents) != 0 {
		t.Errorf("chats of the deleted run: %d people's, %d agents'", len(people), len(agents))
	}
	if _, err := h.cm().View(chat); err == nil {
		t.Error("the chat on the deleted run is still there")
	}
	es := &h.s().eng
	h.wait("the engine's goroutines to return", func() bool {
		es.mu.Lock()
		defer es.mu.Unlock()
		return len(es.active) == 0
	})
	if err := h.s().Delete(h.id); !errors.Is(err, ErrNotFound) {
		t.Errorf("a second delete: %v", err)
	}
}

// Archiving a run that works stops it first; an archived run cannot be resumed or changed;
// unarchiving brings it back stopped.
func TestArchiveStopsRun(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	mxOneTask(h)
	h.startRun(nil)
	h.atGate("work")
	chat, token := h.newChat()
	if err := h.cm().Send(chat, "Hello.", "", nil); err != nil {
		t.Fatal(err)
	}
	h.wait("the chat to have answered", func() bool { return !h.cm().Busy(chat) && h.turnsOf("") >= 1 })
	if err := h.s().Archive(h.id, model.Archive{Op: "op-1"}); err != nil {
		t.Fatalf("archive: %v", err)
	}
	l := h.L()
	v := h.view()
	if l.State.Status != model.RunStopped || l.State.Reason != "the run was archived" || !v.Archived || v.Op != "op-1" ||
		len(l.Stops) != 1 || l.Stops[0].Reason != model.StopUser {
		t.Fatalf("after the archive: %s (%q), archived %v, stops %+v", l.State.Status, l.State.Reason, v.Archived, l.Stops)
	}
	h.idleEngine()
	h.noProcess("after the archive") // the chat's agent too
	if cv, err := h.cm().View(chat); err != nil || !cv.Archived || cv.Op != "op-1" {
		t.Errorf("the chat on the archived run: %+v %v", cv.Archive, err)
	}
	if _, err := h.s().Resume(h.id, ResumeReq{}); !errors.Is(err, ErrArchived) {
		t.Errorf("a resume of an archived run answered %v", err)
	}
	// The chat went into the archive with its run: the endpoint refuses its token. And the run
	// refuses the call whoever makes it.
	add := map[string]any{"title": "More", "kind": "research", "writes": false, "tier": "standard", "tier_reason": "A test task.", "brief": mxBrief("Look.")}
	if text, isErr := h.call(token, "add_task", add); !isErr || text != "this chat is archived" {
		t.Errorf("add_task of an archived chat answered %q (error %v)", text, isErr)
	}
	raw, _ := json.Marshal(add)
	if text, isErr := h.s().Call(boardapi.RunCaller{Run: h.id, Chat: chat}, "add_task", raw); !isErr || text != toolArchived {
		t.Errorf("add_task on an archived run answered %q (error %v)", text, isErr)
	}
	if n := len(h.L().Tasks); n != 1 {
		t.Errorf("%d tasks", n)
	}
	if _, err := h.cm().CreateOnRun(model.Claude, h.id); err == nil {
		t.Error("a chat was made on an archived run")
	}
	// A restart leaves an archived run alone.
	h.restartQuit()
	if !h.quiet() || h.view().Status != model.RunStopped {
		t.Fatalf("after a restart the archived run is %s", h.view().Status)
	}
	if err := h.s().Unarchive(h.id); err != nil {
		t.Fatal(err)
	}
	if v := h.view(); v.Archived || v.Status != model.RunStopped || !h.quiet() {
		t.Fatalf("after the unarchive: archived %v, %s", v.Archived, v.Status)
	}
	if cv, err := h.cm().View(chat); err != nil || cv.Archived {
		t.Errorf("the chat after the unarchive: %+v %v", cv.Archive, err)
	}
	h.regate("work")
	h.resume()
	h.atGate("work")
	h.open("work")
	h.finished()
}

// The storage guard. The feature's order says: "All task definitions and every other piece of
// run state live in that folder, not in the cwd of the agents." After the whole reference run
// with its chat: every file of the run is under {home}/runs/<id>/; the agents' chats are in its
// agents folder and the person's chat in its chats folder; {home}/chats is empty; no agent ever
// found a file in its working directory that neither the repository nor an agent put there; and
// no message to any agent names the home folder. While the run goes, the copies its agents can
// read are in ctx/ beside its checkouts, outside the home and outside the user's folder. When it
// has finished, its result is applied to the user's repository: the user's branch is at the
// result, the folder holds the result's files with nothing uncommitted, the git dir has changed
// only by what a fast-forward changes (and holds objects and the lock file), no branch and no
// work-tree record of the run is left, and nothing of the run is left beside the home. A run with
// keepWorktrees keeps its checkouts and the branches they are on.
func TestRunFilesStayInRunFolder(t *testing.T) {
	t.Parallel()
	for _, keep := range []bool{false, true} {
		t.Run(fmt.Sprintf("git,keepWorktrees=%v", keep), func(t *testing.T) {
			t.Parallel()
			h := newMx(t, true)
			h.guard = true
			gitDir := filepath.Join(h.repo.Dir(), ".git")
			before := mxFiles(t, gitDir)
			was := map[string]string{}
			for _, f := range before {
				b, _ := os.ReadFile(filepath.Join(gitDir, f))
				was[f] = string(b)
			}
			copies := h.watchCopies()
			h.startRun(func(m *model.RunMeta) { m.Settings.KeepWorktrees = keep })
			l := h.waitStatus(model.RunCompleted, model.RunStalled, model.RunError)
			if l.State.Status != model.RunCompleted || !mxMergeAgentRan(l) {
				t.Fatalf("the reference run: %s\n%s", l.State.Status, h.dump())
			}
			h.noAgentProcess("when the run is finished")
			h.guardHome(l)
			copies()

			// The user's repository: its branch is at the result and its folder holds the result.
			d := l.State.Delivery
			if d == nil || d.State != model.DeliveryApplied || d.How != "ff" || !d.Auto || d.Commit != l.State.Git.ResultHead || d.Branch != "main" {
				t.Fatalf("the delivery: %+v", d)
			}
			if det, err := h.s().Detail(h.id); err != nil || det.Delivery == nil || det.Delivery.State != model.DeliveryApplied {
				t.Errorf("the detail's delivery: %+v %v", det.Delivery, err)
			}
			if got := mxFiles(t, h.repo.Dir(), ".git"); fmt.Sprint(got) != "[README.md chat.txt shared.txt t01.txt t02.txt]" {
				t.Errorf("the repository's folder holds %v", got)
			}
			if b, _ := os.ReadFile(filepath.Join(h.repo.Dir(), "shared.txt")); !strings.Contains(string(b), "line of T01") || !strings.Contains(string(b), "line of T02") || strings.Contains(string(b), "base") {
				t.Errorf("the user's shared.txt: %q", b)
			}
			if h.repo.Git("status", "--porcelain") != "" || h.repo.Git("rev-parse", "--abbrev-ref", "HEAD") != "main" ||
				h.repo.Git("rev-parse", "main") != l.State.Git.ResultHead || l.State.Git.ResultHead == l.State.Git.BaseRef {
				t.Errorf("the user's branch is at %s, the result is %s; status %q", h.repo.Git("rev-parse", "main"), l.State.Git.ResultHead, h.repo.Git("status", "--porcelain"))
			}
			// The run's branches go after the entry that ends the run; kept checkouts keep theirs.
			prefix := "aiwb/" + h.id + "/"
			h.idleEngine()
			for _, b := range h.branches() {
				switch {
				case b == "main":
				case !strings.HasPrefix(b, prefix):
					t.Errorf("a branch that is not the run's: %s", b)
				case !keep:
					t.Errorf("a branch of the run is left after its result was applied: %s", b)
				}
			}
			if keep && len(h.branches()) < 3 {
				t.Errorf("the branches of the kept checkouts: %v", h.branches())
			}
			// Its git dir: objects, the lock file, what a fast-forward of main changes, and with
			// keepWorktrees the run's branches and work-tree records.
			moved := map[string]bool{"ORIG_HEAD": true, "index": true, "logs/HEAD": true, "logs/refs/heads/main": true, "refs/heads/main": true}
			for _, f := range mxFiles(t, gitDir) {
				switch {
				case strings.HasPrefix(f, "objects/"):
				case strings.HasPrefix(f, "refs/heads/"+prefix), strings.HasPrefix(f, "logs/refs/heads/"+prefix), strings.HasPrefix(f, "worktrees/"):
					if !keep {
						t.Errorf("the run left %s in the repository's git dir", f)
					}
				case f == "aiwb-runs.lock", moved[f]:
				default:
					old, had := was[f]
					now, _ := os.ReadFile(filepath.Join(gitDir, f))
					if !had {
						t.Errorf("the run made %s in the repository's git dir", f)
					} else if old != string(now) {
						t.Errorf("the run changed %s in the repository's git dir", f)
					}
				}
			}
			// The checkouts: nothing in them but the repository's files and what the agents wrote.
			work := h.world().st.P.RunWorkDir(h.id)
			ents, _ := os.ReadDir(work)
			if keep != (len(ents) > 0) {
				t.Errorf("%d checkouts are left with keepWorktrees %v", len(ents), keep)
			}
			for _, e := range ents {
				if e.Name() == "ctx" {
					t.Error("the copies for the agents are left beside the kept checkouts")
					continue
				}
				for _, f := range h.strangers(filepath.Join(work, e.Name())) {
					t.Errorf("the checkout %s holds %s, which nobody wrote", e.Name(), f)
				}
			}
			// The test's own folder holds the home and nothing else: the folder of the run's
			// work went with the run's end, unless its checkouts are kept.
			for _, e := range mustReadDir(t, h.root) {
				if e != "aiwb-mx-data" && !(keep && e == "aiwb-run-work") {
					t.Errorf("beside the home folder there is %s", e)
				}
			}
			if keep {
				if got := mustReadDir(t, h.world().st.P.RunWork); fmt.Sprint(got) != "["+h.id+"]" {
					t.Errorf("the folder of the runs' work holds %v", got)
				}
			}
		})
	}
	t.Run("no git", func(t *testing.T) {
		t.Parallel()
		h := newMx(t, false)
		h.guard = true
		if err := os.WriteFile(filepath.Join(h.cwd, "kept.txt"), []byte("the user's\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		h.had = []string{"kept.txt"}
		copies := h.watchCopies()
		h.startRun(nil)
		l := h.waitStatus(model.RunCompleted, model.RunStalled, model.RunError)
		if l.State.Status != model.RunCompleted {
			t.Fatalf("the reference run: %s\n%s", l.State.Status, h.dump())
		}
		h.noAgentProcess("when the run is finished")
		h.guardHome(l)
		copies()
		if d := l.State.Delivery; d == nil || d.State != model.DeliveryNone || d.Reason != "no_git" {
			t.Errorf("the delivery of a run without git: %+v", d)
		}
		want := []string{"chat.txt", "kept.txt", "shared.txt", "t01.txt", "t02.txt"}
		if got := mxFiles(t, h.cwd); fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("the folder holds %v, want %v", got, want)
		}
		for _, f := range h.strangers(h.cwd) {
			t.Errorf("the folder holds %s, which nobody wrote", f)
		}
		for _, e := range mustReadDir(t, h.root) {
			if e != "aiwb-mx-data" && e != "plain-folder" {
				t.Errorf("beside the home folder there is %s", e)
			}
		}
	})
}

// watchCopies looks, at every entry of a run that is going and has an attempt, for the copies
// its agents can read: <RunWork>/<run>/ctx beside the checkouts, with the goal, the brief of
// every task and the report of every attempt that has one, equal to the records and holding
// nothing else. The function it returns reports what was wrong, and fails when nothing was seen.
func (h *mx) watchCopies() func() {
	var mu sync.Mutex
	var bad []string
	seen, reports := 0, 0
	h.mu.Lock()
	h.onEntry = func(l *Loaded) {
		if !l.State.Status.Live() || l.State.Result != nil || !slices.ContainsFunc(l.Tasks, func(t Task) bool { return len(t.Attempts) > 0 }) {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		fail := func(format string, args ...any) {
			bad = append(bad, fmt.Sprintf("entry %d: ", l.Version)+fmt.Sprintf(format, args...))
		}
		p := h.world().st.P
		rec, dir := p.RunDir(h.id), filepath.Join(p.RunWorkDir(h.id), "ctx")
		want := map[string]string{"goal.md": fileGoal}
		for _, t := range l.Tasks {
			want["briefs/"+t.ID+".md"] = briefRel(t.ID, t.BriefRev)
			for _, a := range t.Attempts {
				if _, err := os.Stat(filepath.Join(rec, reportRel(t.ID, a.N))); err == nil {
					want[fmt.Sprintf("reports/%s.a%d.md", t.ID, a.N)] = reportRel(t.ID, a.N)
					reports++
				}
			}
		}
		for c, r := range want {
			copy_, err := os.ReadFile(filepath.Join(dir, c))
			record, _ := os.ReadFile(filepath.Join(rec, r))
			if err != nil || string(copy_) != string(record) {
				fail("the copy %s is not the record %s (%v)", c, r, err)
			}
		}
		_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			rel, _ := filepath.Rel(dir, path)
			if _, ok := want[filepath.ToSlash(rel)]; !ok {
				fail("ctx holds %s", rel)
			}
			return nil
		})
		if h.repo != nil {
			if _, err := os.Stat(filepath.Join(p.RunWorkDir(h.id), "int", ".git")); err != nil {
				fail("the copies are not beside the integration checkout: %v", err)
			}
		}
		seen++
	}
	h.mu.Unlock()
	return func() {
		h.t.Helper()
		mu.Lock()
		defer mu.Unlock()
		for _, b := range bad {
			h.t.Error(b)
		}
		if seen == 0 || reports == 0 {
			h.t.Errorf("the copies were looked at %d times while the run was going, with %d reports", seen, reports)
		}
	}
}

func mustReadDir(t testing.TB, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
	}
	return names
}

// guardHome checks the home folder after a reference run: the run's files, the chats' folders,
// and the messages the agents got.
func (h *mx) guardHome(l *Loaded) {
	t := h.t
	t.Helper()
	p := h.world().st.P
	if got := mxFiles(t, p.Chats); len(got) != 0 {
		t.Errorf("{home}/chats holds %v", got)
	}
	if ents, _ := os.ReadDir(p.Chats); len(ents) != 0 {
		t.Errorf("{home}/chats holds %d folders", len(ents))
	}
	if got := mustReadDir(t, p.Runs); fmt.Sprint(got) != "["+h.id+"]" {
		t.Errorf("{home}/runs holds %v", got)
	}
	dir := p.RunDir(h.id)
	people, agents := h.cm().ChatsOfRun(h.id)
	if len(people) != 1 || len(agents) != len(l.Agents) {
		t.Fatalf("%d chats of people and %d of agents; the run has %d agents", len(people), len(agents), len(l.Agents))
	}
	// Every agent's chat is in agents/<chat id>/, the person's in chats/<chat id>/.
	for _, a := range l.Agents {
		for _, f := range []string{"chat.json", "items.jsonl"} {
			if _, err := os.Stat(filepath.Join(dir, "agents", a.ID, f)); err != nil {
				t.Errorf("agent %s: %v", a.Name, err)
			}
		}
	}
	if got := mustReadDir(t, filepath.Join(dir, "agents")); len(got) != len(l.Agents) {
		t.Errorf("agents/ holds %d folders for %d agents", len(got), len(l.Agents))
	}
	if got := mustReadDir(t, filepath.Join(dir, "chats")); fmt.Sprint(got) != "["+people[0].ID+"]" {
		t.Errorf("chats/ holds %v, the chat is %s", got, people[0].ID)
	}
	if _, err := os.Stat(filepath.Join(dir, "chats", people[0].ID, "chat.json")); err != nil {
		t.Error(err)
	}
	// The run's own files: the record, the goal, the notes, and per task its briefs, reports and
	// changes.
	for _, f := range mxFiles(t, dir, "agents", "chats") {
		ok := slices.Contains([]string{"run.json", "goal.md", fileJournal, "state.json", "tasks.json", "turns.json", "agents.json"}, f) ||
			strings.HasPrefix(f, "notes/v") || strings.HasPrefix(f, "tasks/T")
		if !ok {
			t.Errorf("the run's folder holds %s", f)
		}
	}
	for _, tk := range l.Tasks {
		for _, f := range []string{briefRel(tk.ID, 1), reportRel(tk.ID, 1)} {
			if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
				t.Errorf("%s: %v", tk.ID, err)
			}
		}
	}
	// No message to any agent names the home folder or a file of the run's record.
	h.mu.Lock()
	prompts := slices.Clone(h.prompts)
	h.mu.Unlock()
	if len(prompts) < len(l.Agents)+1 {
		t.Errorf("only %d messages were seen for %d agents and a chat", len(prompts), len(l.Agents))
	}
	for _, pr := range prompts {
		for _, bad := range []string{h.home, filepath.Base(h.home), fileJournal, "tasks.json", "agents.json", "turns.json", "state.json", "run.json", "/runs/" + h.id} {
			if strings.Contains(pr.Text, bad) {
				t.Errorf("a message to %q names %s", pr.Name, bad)
			}
		}
	}
}
