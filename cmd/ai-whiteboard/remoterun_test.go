package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/linksim"
)

// The tests of this file are the pair of remotechat_test.go with runs. B is a section of A's
// sidebar: a run is made, changed, started, stopped, resumed, applied, read, archived and deleted
// on B from A's page, through A's routes /api/on/<entry id>/runs…, which A passes on. A keeps
// nothing of such a run: what its page shows is B's tree ("sections" of A's snapshot, the section
// event and B's list events with the entry's id as "server"), and every id is B's own. B's
// Claude program is the scripted stand-in, so a run's goal says what its orchestrator and its
// tasks' agents do, and both servers have the git environment of B's scratch repository. What
// the page reads through A is compared with what the direct API client reads at B ("B's own")
// and with what B's own page, the owner's, is shown.

// runPair is a remotePair whose B has a scratch git repository for its runs.
type runPair struct {
	*remotePair
	repo *agenttest.Repo // one commit on main: shared.txt with "colour: none" and a README
}

// connectedRunPair starts the two servers with the repository's git environment, adds B to A's
// list and waits until it is connected and A holds its tree: from then on the calls of B's
// section work. env is more in the environment of both servers: the waits a test lowers
// (clock.env).
func connectedRunPair(t *testing.T, p linksim.Profile, env ...string) *runPair {
	t.Helper()
	repo := agenttest.NewRepo(t)
	repo.Write(e2eFile, e2eBefore)
	repo.Write("README.md", "a repository\n")
	repo.Commit("the start")
	rp := &runPair{remotePair: startRemotePairIn(t, p, "", append(repo.Env(), env...)), repo: repo}
	rp.addEntry(t)
	eventually(t, 30*time.Second, "A's snapshot has the tree of "+pairName, func() bool {
		_, ok := rp.section(t)
		return ok
	})
	return rp
}

// newRepo is one more scratch repository, with one commit. Both servers are on this machine, so
// it serves as a folder of B and as a folder of A alike.
func (rp *runPair) newRepo(t *testing.T) *agenttest.Repo {
	t.Helper()
	repo, _ := e2eNoteRepo(t)
	return repo
}

// ---- B as a section of A: the calls, the tree and the events ------------------------------------

// runOn is the path on A of a call for a thing of B's section. path is the call's path at B
// ("/api/runs/…"), as the direct client and B's own page name it: the call of A's page is the
// same one under /api/on/<entry id>.
func (rp *runPair) runOn(path string) string {
	return "/api/on/" + rp.entry + strings.TrimPrefix(path, "/api")
}

// runDo makes a call of the page on A for a thing of B's section; path is the call's path at B.
func (rp *runPair) runDo(t *testing.T, method, path string, body any) answer {
	t.Helper()
	return rp.do(t, method, rp.runOn(path), body)
}

// runOK is runDo for a call that must answer 200.
func (rp *runPair) runOK(t *testing.T, method, path string, body any) answer {
	t.Helper()
	return rp.ok(t, method, rp.runOn(path), body)
}

// runRefused is runDo for a call that must be refused with this status and code.
func (rp *runPair) runRefused(t *testing.T, status int, code, method, path string, body any) answer {
	t.Helper()
	return rp.refused(t, status, code, method, rp.runOn(path), body)
}

// runRefusedAsThere is runRefused for a refusal that is B's own: the same call, made at B by the
// direct client, is answered with the same status and the same bytes. For a call that changes
// nothing when it is refused.
func (rp *runPair) runRefusedAsThere(t *testing.T, status int, code, method, path string, body any) answer {
	t.Helper()
	a := rp.runRefused(t, status, code, method, path, body)
	if b := rp.atB(t, method, path, body); b.Status != a.Status || b.Raw != a.Raw {
		t.Fatalf("%s %s: the refusal through A is not B's own:\nthrough A: %s\nat B:      %s", method, path, a, b)
	}
	return a
}

// runHere is what A's snapshot lists as this computer's own: nothing of B is ever in it.
type runHere struct {
	Groups []model.Group
	Boards []model.Board
	Chats  []model.ChatView
	Runs   []model.RunView
}

// runOwn reads what A's snapshot lists as this computer's own.
func (rp *runPair) runOwn(t *testing.T) runHere {
	t.Helper()
	var here runHere
	rp.a.must(t, pairPage, "GET", "/api/state", nil, &here)
	return here
}

// runLocalGroup makes a group of this computer on A, in the local part, and returns its id: a
// group that B does not have.
func (rp *runPair) runLocalGroup(t *testing.T, name string) string {
	t.Helper()
	var g model.Group
	rp.a.must(t, pairPage, "POST", "/api/groups", map[string]any{"name": name}, &g)
	if g.ID == "" {
		t.Fatalf("the group %q of this computer has no id", name)
	}
	if tree, _ := rp.section(t); slices.ContainsFunc(tree.Groups, func(x model.Group) bool { return x.ID == g.ID || x.Name == name }) {
		t.Fatalf("the group %q of this computer is in A's tree of %s", name, pairName)
	}
	return g.ID
}

// runNothingHere checks that A keeps nothing of B's things: none of the ids is in a list of A's
// own in its snapshot, the local route of a run answers that there is no such run, and no file
// of A's data folder but the server list holds one of the ids or of the texts.
func (rp *runPair) runNothingHere(t *testing.T, when string, ids []string, texts ...string) {
	t.Helper()
	here := rp.runOwn(t)
	for _, id := range ids {
		for _, g := range here.Groups {
			if g.ID == id {
				t.Fatalf("%s: the group %s of %s is a group of A's own", when, id, pairName)
			}
		}
		for _, b := range here.Boards {
			if b.ID == id || b.Group == id {
				t.Fatalf("%s: A's own boards hold %s of %s: %+v", when, id, pairName, b)
			}
		}
		for _, v := range here.Chats {
			if v.ID == id || v.Group == id || v.Run == id {
				t.Fatalf("%s: A's own chats hold %s of %s: %+v", when, id, pairName, v)
			}
		}
		for _, v := range here.Runs {
			if v.ID == id || v.Group == id {
				t.Fatalf("%s: A's own runs hold %s of %s: %+v", when, id, pairName, v)
			}
		}
		if strings.HasPrefix(id, "r_") {
			rp.refused(t, http.StatusNotFound, "not_found", "GET", "/api/runs/"+id, nil)
		}
	}
	if held := holders(folderFiles(t, rp.a.home), append(slices.Clone(ids), texts...)); len(held) != 0 {
		t.Fatalf("%s: files of A's data folder hold something of %s: %v", when, pairName, held)
	}
}

// runGroup makes a group on B from A's page, at the top level of B's section, and returns its
// id, which is B's. It is in A's tree of B and on the owner's page when it returns.
func (rp *runPair) runGroup(t *testing.T, name string) string {
	t.Helper()
	var g model.Group
	a := rp.runOK(t, "POST", "/api/groups", map[string]any{"name": name})
	if err := json.Unmarshal([]byte(a.Raw), &g); err != nil || g.ID == "" || g.Name != name {
		t.Fatalf("the group %q made on %s through A: %s", name, pairName, a)
	}
	has := func(l []model.Group) bool {
		return slices.ContainsFunc(l, func(x model.Group) bool { return x.ID == g.ID && x.Name == name && x.Parent == "" })
	}
	eventually(t, 10*time.Second, "the group "+name+" in A's tree of "+pairName+" and on the owner's page", func() bool {
		tree, _ := rp.section(t)
		return has(tree.Groups) && has(rp.b.pageState(t).Groups)
	})
	return g.ID
}

// runOwner opens the event stream of B's own page: what the person at B's machine is shown.
func (rp *runPair) runOwner(t *testing.T) *watcher {
	t.Helper()
	return watch(t, http.DefaultClient, strings.TrimSuffix(rp.b.in.url, "/"), apiPage, nil)
}

// runTreeBack is the tree A's page was sent for B after the mark, in the section event of the
// entry that carries one: what the page draws the section from when the server is back.
func (rp *runPair) runTreeBack(t *testing.T, mark int) remotes.Tree {
	t.Helper()
	var ev struct{ Tree *remotes.Tree }
	e := rp.page.await(t, mark, 20*time.Second, "section event with the tree of "+pairName, func(e seenEvent) bool {
		return e.holds("section", `"server":"`+rp.entry+`"`) && !strings.Contains(e.Raw, `"tree":null`)
	})
	if err := json.Unmarshal([]byte(e.Raw), &ev); err != nil || ev.Tree == nil {
		t.Fatalf("the section event of %s: %v in %s", pairName, err, clipText(e.Raw, 400))
	}
	return *ev.Tree
}

// runNoTree waits until A's page was told, after the mark, that A holds no tree of B any more
// (the section event with a null tree), and checks that A's snapshot has none.
func (rp *runPair) runNoTree(t *testing.T, mark int, limit time.Duration) {
	t.Helper()
	rp.page.awaitEvent(t, mark, limit, "section", `"server":"`+rp.entry+`"`, `"tree":null`)
	if tree, ok := rp.section(t); ok {
		t.Fatalf("A's snapshot has a tree of %s after the section event without one: %d runs", pairName, len(tree.Runs))
	}
}

// ---- runs ---------------------------------------------------------------------------------------

// runIn decodes the run view of an answer.
func runIn(t *testing.T, a answer) model.RunView {
	t.Helper()
	var v model.RunView
	if err := json.Unmarshal([]byte(a.Raw), &v); err != nil {
		t.Fatalf("no run view in %s: %v", a, err)
	}
	return v
}

// draft makes a run from A's page in the group of B's section, and puts it in the folder dir,
// with every tier on one model and twelve turns at most. The run is on B from the moment it is
// made, before it starts: B has it, in the group, and A's page is told of it by B's run event.
// B has checked the folder when it returns.
func (rp *runPair) draft(t *testing.T, group, name, dir string) model.RunView {
	t.Helper()
	mark := rp.page.mark()
	v := runIn(t, rp.runOK(t, "POST", "/api/runs", map[string]any{"group": group, "name": name}))
	if v.ID == "" || v.Status != model.RunDraft || v.Agent != model.Claude || v.Group != group || v.Name != name || !v.Started.IsZero() {
		t.Fatalf("the new run: %+v", v)
	}
	if b, there := rp.ownRun(t, v.ID); !there || b.Status != model.RunDraft || b.Group != group || b.Name != name {
		t.Fatalf("the new run at B, before its start: %+v (there: %v)", b, there)
	}
	rp.awaitRun(t, mark, 10*time.Second, v.ID, "the new run", func(v model.RunView) bool {
		return v.Status == model.RunDraft && v.Group == group && v.Name == name
	})
	v = runIn(t, rp.runOK(t, "PATCH", "/api/runs/"+v.ID, map[string]any{"cwd": dir, "tiers": tiersOn("haiku"), "settings": map[string]any{"maxTurns": 12}}))
	if v.Cwd != dir || v.FolderMissing || v.Blocked != "" || v.Status != model.RunDraft || v.Group != group {
		t.Fatalf("the run in %s on %s before its start: %+v", dir, pairName, v)
	}
	return v
}

// start is the page's start of the run through A.
func (rp *runPair) start(t *testing.T, run, goal string) answer {
	t.Helper()
	return rp.runDo(t, "POST", "/api/runs/"+run+"/start", map[string]any{"goal": goal})
}

// startRun is draft and its start, which must answer with the started run, in its group.
func (rp *runPair) startRun(t *testing.T, group, name, dir, goal string) string {
	t.Helper()
	d := rp.draft(t, group, name, dir)
	a := rp.start(t, d.ID, goal)
	if v := runIn(t, a); a.Status != http.StatusOK || v.ID != d.ID || v.Group != group || v.Started.IsZero() || v.Status == model.RunDraft {
		t.Fatalf("the start of %s through A: %s", d.ID, a)
	}
	return d.ID
}

// throughRun is the run's view as A answers it: a read that is passed on to B.
func (rp *runPair) throughRun(t *testing.T, run string) model.RunView {
	t.Helper()
	return runIn(t, rp.runOK(t, "GET", "/api/runs/"+run, nil))
}

// runListed is the run's view in a list of runs, which must hold it once at most.
func runListed(t *testing.T, where string, l []model.RunView, run string) (model.RunView, bool) {
	t.Helper()
	n := 0
	var found model.RunView
	for _, v := range l {
		if v.ID == run {
			found, n = v, n+1
		}
	}
	if n > 1 {
		t.Fatalf("%s lists the run %s %d times", where, run, n)
	}
	return found, n == 1
}

// listedRun is the run's view in A's tree of B.
func (rp *runPair) listedRun(t *testing.T, run string) (model.RunView, bool) {
	t.Helper()
	tree, _ := rp.section(t)
	return runListed(t, "A's tree of "+pairName, tree.Runs, run)
}

// ownerRun is the run's view in the snapshot of B's own page.
func (rp *runPair) ownerRun(t *testing.T, run string) (model.RunView, bool) {
	t.Helper()
	return runListed(t, "the owner's page", rp.b.pageState(t).Runs, run)
}

// ownRun is the run's view at B, as the direct client reads it; ok is false when B has no such
// run.
func (rp *runPair) ownRun(t *testing.T, run string) (v model.RunView, ok bool) {
	t.Helper()
	a := rp.atB(t, "GET", "/api/runs/"+run, nil)
	switch a.Status {
	case http.StatusOK:
		return runIn(t, a), true
	case http.StatusNotFound:
		return v, false
	}
	t.Fatalf("the run %s at B: %s", run, a)
	return v, false
}

// awaitOwnRun reads the run at B until ok accepts its view.
func (rp *runPair) awaitOwnRun(t *testing.T, run, what string, ok func(model.RunView) bool) model.RunView {
	t.Helper()
	for deadline := time.Now().Add(e2eWait); ; time.Sleep(50 * time.Millisecond) {
		v, there := rp.ownRun(t, run)
		if there && ok(v) {
			return v
		}
		if time.Now().After(deadline) {
			t.Fatalf("the run %s at B never was %s: %+v (there: %v)", run, what, v, there)
		}
	}
}

// ended waits until the run is no longer live at B.
func (rp *runPair) ended(t *testing.T, run string) model.RunView {
	t.Helper()
	return rp.awaitOwnRun(t, run, "ended", func(v model.RunView) bool { return !v.Status.Live() && v.Status != model.RunDraft })
}

// achieved waits until the run has ended at B, which must be completed with the goal achieved.
func (rp *runPair) achieved(t *testing.T, run string) model.RunView {
	t.Helper()
	v := rp.ended(t, run)
	if v.Status != model.RunCompleted || v.Outcome != model.Achieved {
		t.Fatalf("the run %s ended at B as %s (%s), outcome %q; its detail:\n%s", run, v.Status, v.Reason, v.Outcome, clipText(rp.atB(t, "GET", "/api/runs/"+run+"/detail", nil).Raw, 6000))
	}
	return v
}

// runOf is the view in a run event, and the entry the event names as its server: B's entry in
// an event of A's page, none in an event of B's own streams.
func runOf(e seenEvent) (v model.RunView, server string) {
	var ev struct {
		Server string
		Run    model.RunView
	}
	json.Unmarshal([]byte(e.Raw), &ev)
	return ev.Run, ev.Server
}

// runAwait waits until the watcher was sent a run event of this run that names server as its
// server and whose view ok accepts.
func runAwait(t *testing.T, w *watcher, server string, mark int, limit time.Duration, run, what string, ok func(model.RunView) bool) model.RunView {
	t.Helper()
	v, _ := runOf(w.await(t, mark, limit, "run event of "+run+" with "+what, func(e seenEvent) bool {
		if e.Type != "run" {
			return false
		}
		v, from := runOf(e)
		return v.ID == run && from == server && ok(v)
	}))
	return v
}

// awaitRun waits until A's page was sent a run event of this run of B's section, with the
// entry's id as its server, whose view ok accepts.
func (rp *runPair) awaitRun(t *testing.T, mark int, limit time.Duration, run, what string, ok func(model.RunView) bool) model.RunView {
	t.Helper()
	return runAwait(t, rp.page, rp.entry, mark, limit, run, what, ok)
}

// runJSON is a run view as a JSON value to compare.
func runJSON(t *testing.T, v model.RunView) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// sameRun reads the run at B, through A, in A's tree of B and on the owner's page until B's view
// is at rest and the two lists have it, and compares them: what A answers and lists, and what
// the owner is shown, is B's view, whole. The run must be in the group. It returns A's view.
func (rp *runPair) sameRun(t *testing.T, run, group, when string) model.RunView {
	t.Helper()
	var a, b, listed, owner model.RunView
	for deadline := time.Now().Add(15 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		var there, again bool
		var b2 model.RunView
		b, there = rp.ownRun(t, run)
		a = rp.throughRun(t, run)
		listed, _ = rp.listedRun(t, run)
		owner, _ = rp.ownerRun(t, run)
		b2, again = rp.ownRun(t, run)
		if !there || !again {
			t.Fatalf("%s: B has no run %s", when, run)
		}
		if at := runJSON(t, b); at == runJSON(t, b2) && runJSON(t, listed) == at && runJSON(t, owner) == at {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: the views of %s do not come to rest:\nat B:        %s\nthen:        %s\nA's tree:    %s\nthe owner's: %s",
				when, run, runJSON(t, b), runJSON(t, b2), runJSON(t, listed), runJSON(t, owner))
		}
	}
	if x, y := runJSON(t, a), runJSON(t, b); x != y {
		t.Fatalf("%s: the run %s through A is not B's own:\nthrough A: %s\nat B:      %s", when, run, x, y)
	}
	if a.Group != group {
		t.Fatalf("%s: the run %s is in the group %q of %s, want %q", when, run, a.Group, pairName, group)
	}
	return a
}

// AC43 and goal 3.4, the start: a run made in B's section is on B from the moment it is made,
// before it starts, with its goal and its settings, in the group it was made in, for A's page and
// for B's owner alike. Started through A's routes it runs on B and ends with both colours on main
// of B's scratch repository. Nothing of the run ever ran on A, and A keeps nothing of it. On the
// good and on the poor link.
func TestRemoteRunStart(t *testing.T) {
	serverTest(t, "TestSectionCallPassedOn, TestSectionEvents (internal/remotes)", "TestSectionRoutesPassOn (internal/server)")
	for _, link := range []struct {
		name string
		p    linksim.Profile
	}{{"good link", linksim.Good}, {"poor link", linksim.Poor}} {
		t.Run(link.name, func(t *testing.T) {
			t.Parallel() // each link has its own pair
			remoteRunStart(t, link.p)
		})
	}
}

func remoteRunStart(t *testing.T, p linksim.Profile) {
	const first = "Paint the shared file in both colours." // the first line of e2eGoal
	const typed = "A goal that is still being typed."
	rp := connectedRunPair(t, p)
	owner := rp.runOwner(t)
	g := rp.runGroup(t, "Work")
	mark, om := rp.page.mark(), owner.mark()
	d := rp.draft(t, g, "Both colours", rp.repo.Dir())
	if !d.Git || d.Dirty || d.Tiers.Deep.Model != "haiku" || d.Settings.MaxTurns != 12 {
		t.Fatalf("the run in B's repository before its start: %+v", d)
	}
	run := d.ID
	// The owner's page is told of the run a client made, in the group it was made in.
	runAwait(t, owner, "", om, 10*time.Second, run, "the new run", func(v model.RunView) bool {
		return v.Status == model.RunDraft && v.Group == g && v.Name == "Both colours"
	})
	// A set-up command, and the goal as far as it is typed: both are B's from here on.
	if v := runIn(t, rp.runOK(t, "PATCH", "/api/runs/"+run, map[string]any{"settings": map[string]any{"maxTurns": 12, "setup": "true"}})); v.Settings.Setup != "true" || v.Settings.MaxTurns != 12 {
		t.Fatalf("the run with a set-up command: %+v", v.Settings)
	}
	rp.runOK(t, "PUT", "/api/runs/"+run+"/draft", map[string]any{"text": typed})
	rp.awaitRun(t, mark, 10*time.Second, run, "the typed goal", func(v model.RunView) bool { return v.Draft != nil && v.Draft.Text == typed })
	if v := rp.sameRun(t, run, g, "before the start"); v.Status != model.RunDraft || !v.Started.IsZero() || v.Draft == nil || v.Draft.Text != typed ||
		v.Settings.Setup != "true" || v.Cwd != rp.repo.Dir() || v.Tiers.Deep.Model != "haiku" {
		t.Fatalf("the run on %s before its start: %+v, want it unstarted with its goal and its settings", pairName, v)
	}
	// It is a run of B alone, and no agent was started for it yet.
	if left := rp.b.runFolders(t); !slices.Equal(left, []string{run}) {
		t.Fatalf("folders under B's runs before the start: %v, want %s alone", left, run)
	}
	if n := rp.b.orchestrators(t, first); n != 0 {
		t.Fatalf("%d orchestrators at B before the start", n)
	}
	rp.runNothingHere(t, "before the start", []string{run, g}, "Both colours", typed)

	started := time.Now()
	a := rp.start(t, run, e2eGoal(t))
	v := runIn(t, a)
	if a.Status != http.StatusOK || v.ID != run || v.Group != g || v.Status != model.RunRunning || v.Started.IsZero() || v.Draft != nil {
		t.Fatalf("the start through A: %s", a)
	}
	t.Logf("the start through A was answered after %v", time.Since(started).Round(time.Millisecond))
	rp.awaitRun(t, mark, 10*time.Second, run, "the start", func(v model.RunView) bool {
		return v.Group == g && !v.Started.IsZero()
	})
	runAwait(t, owner, "", om, 10*time.Second, run, "the start", func(v model.RunView) bool { return v.Group == g && !v.Started.IsZero() })
	if left := rp.b.runFolders(t); !slices.Equal(left, []string{run}) {
		t.Fatalf("folders under B's runs: %v, want %s alone", left, run)
	}

	rp.achieved(t, run)
	done := rp.awaitRun(t, mark, 30*time.Second, run, "the end", func(v model.RunView) bool { return v.Status == model.RunCompleted })
	if done.Outcome != model.Achieved || done.Group != g || done.Counts.Done != 3 {
		t.Fatalf("the page's last run event: %+v", done)
	}
	rp.awaitRun(t, mark, 30*time.Second, run, "the delivery", func(v model.RunView) bool { return v.Delivery == model.DeliveryApplied })
	t.Logf("the run ended %v after its start, in %d turns", time.Since(started).Round(100*time.Millisecond), done.Turns)
	if v := rp.sameRun(t, run, g, "after the end"); v.Status != model.RunCompleted || v.Delivery != model.DeliveryApplied || v.Draft != nil {
		t.Fatalf("the ended run through A: %+v", v)
	}

	// The result is in B's repository, on main, with nothing uncommitted.
	if got := rp.repo.Git("show", "main:"+e2eFile); got != e2eResolved {
		t.Fatalf("main:%s in B's repository: %q, want %q", e2eFile, got, e2eResolved)
	}
	if st := rp.repo.Git("status", "--porcelain"); st != "" {
		t.Fatalf("B's work tree is not clean:\n%s", st)
	}

	// One run was started, on B; A started no agent at all, and keeps nothing of the run.
	if n := rp.b.orchestrators(t, first); n != 1 {
		t.Fatalf("%d orchestrators at B, want 1", n)
	}
	for _, l := range rp.a.fakeLines(t) {
		if l.agent() {
			t.Fatalf("A started an agent's process: %v in %s", l.Start, l.Cwd)
		}
	}
	if ents, _ := os.ReadDir(rp.a.work); len(ents) != 0 {
		t.Fatalf("%d checkouts on A", len(ents))
	}
	rp.runNothingHere(t, "after the end", []string{run, g}, "Both colours", typed, first)
	if strings.Contains(rp.a.out.String()+rp.b.out.String(), "DATA RACE") {
		t.Fatal("a server reported a data race")
	}
}

// noteGoal is the goal of a run with one writing task, which writes file after the directives
// before; first is the goal's first line, which names the run in the stand-in's log.
func noteGoal(t *testing.T, first, file, before string) string {
	t.Helper()
	return apiGoal(t, first, "", file, before)
}

// agentOf reads the run's detail through A, which makes the page follow the run, and returns the
// chat id of the first agent with this role.
func (rp *runPair) agentOf(t *testing.T, run string, role model.AgentRole) string {
	t.Helper()
	for deadline := time.Now().Add(e2eWait); ; time.Sleep(50 * time.Millisecond) {
		var d model.RunDetail
		a := rp.runOK(t, "GET", "/api/runs/"+run+"/detail", nil)
		if err := json.Unmarshal([]byte(a.Raw), &d); err != nil || d.Run != run {
			t.Fatalf("the detail of %s through A: %v in %s", run, err, clipText(a.Raw, 400))
		}
		for chat, ag := range d.Agents {
			if ag.Role == role {
				return chat
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("the run %s has no %s agent: %+v", run, role, d.Agents)
		}
	}
}

// sameBytes reads path, a path at B, at B and through A until both answers are the same bytes
// with the status 200: what A hands on is what B answered. It returns them.
func (rp *runPair) sameBytes(t *testing.T, path, when string) string {
	t.Helper()
	var a, b answer
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		b = rp.atB(t, "GET", path, nil)
		a = rp.runDo(t, "GET", path, nil)
		if a.Status == http.StatusOK && b.Status == http.StatusOK && a.Raw == b.Raw {
			return a.Raw
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: %s through A is not B's own:\nthrough A: %d %s\nat B:      %d %s", when, path, a.Status, clipText(a.Raw, 1500), b.Status, clipText(b.Raw, 1500))
		}
	}
}

// rawsOf is the events after the mark of this type that hold the texts, as the bytes that came.
func (w *watcher) rawsOf(mark int, typ string, texts ...string) []string {
	var out []string
	for _, e := range w.of(mark, typ, texts...) {
		out = append(out, e.Raw)
	}
	return out
}

// runThere is an event of A's page for a chat or a run of B's section as B sent it: the event
// with its first member, the entry's id as "server", taken away. ok is false for an event that
// does not begin with it.
func (rp *runPair) runThere(raw string) (there string, ok bool) {
	rest, ok := strings.CutPrefix(raw, `{"server":"`+rp.entry+`",`)
	return "{" + rest, ok
}

// sameEvents waits until the page on A and the direct client of B were sent the same events of
// this type that hold the texts, in the same order, and at least one that last accepts as the
// final one: each event of the page names B's entry as its server and is, but for that, B's
// event byte for byte. Each side is counted from its own mark: both followed the item while
// nothing was sent. With no last, events that may not come at all are compared: the two sides
// must be level, with none too. It returns how many there were.
func (rp *runPair) sameEvents(t *testing.T, direct *watcher, pm, dm int, last func(raw string) bool, typ string, texts ...string) int {
	t.Helper()
	var p, d []string
	for deadline := time.Now().Add(20 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		p, d = nil, direct.rawsOf(dm, typ, texts...)
		for _, raw := range rp.page.rawsOf(pm, typ, texts...) {
			there, ok := rp.runThere(raw)
			if !ok {
				t.Fatalf("a %s event of A's page with %q does not name %s as its server: %s", typ, texts, pairName, clipText(raw, 300))
			}
			p = append(p, there)
		}
		if slices.Equal(p, d) && (last == nil || (len(p) > 0 && last(p[len(p)-1]))) {
			return len(p)
		}
		if time.Now().After(deadline) {
			break
		}
	}
	clip := func(l []string) []string {
		out := make([]string, len(l))
		for i, raw := range l {
			out[i] = clipText(raw, 160)
		}
		return out
	}
	t.Fatalf("the %s events with %q: the page on A was sent %d, the direct client of B %d, and they are not the same:\nthrough A: %q\nat B:      %q",
		typ, texts, len(p), len(d), clip(p), clip(d))
	return 0
}

// AC43, the run table of flow 5.2: one case per row of what each action on a run of B's section
// does, through A's routes, with B's own view and the owner's beside it.
func TestRemoteRunActions(t *testing.T) {
	serverTest(t, "TestSectionCallPassedOn, TestSectionEvents, TestSectionRunAgentChat (internal/remotes)", "TestSectionRoutesPassOn (internal/server)")
	rp := connectedRunPair(t, linksim.Good)
	g, other := rp.runGroup(t, "Work"), rp.runGroup(t, "Other")
	direct := rp.direct(t)
	// A repository for each run, made by the test and not by a case: B still tidies a run's
	// branches when the case that ran it has ended.
	heldRepo, slowRepo, manualRepo, readRepo := rp.newRepo(t), rp.newRepo(t), rp.newRepo(t), rp.newRepo(t)

	// A run that stays running: its one task only waits.
	skip := rp.b.fakeMessages(t)
	held := rp.startRun(t, g, "Held", heldRepo.Dir(), e2eHeldGoal(t))
	rp.b.waitFakeMessage(t, skip, e2eOnTask)

	t.Run("move", func(t *testing.T) {
		mark := rp.page.mark()
		if v := runIn(t, rp.runOK(t, "PATCH", "/api/runs/"+held, map[string]any{"group": other})); v.Group != other {
			t.Fatalf("the moved run: %+v", v)
		}
		rp.awaitRun(t, mark, 5*time.Second, held, "the new group", func(v model.RunView) bool { return v.Group == other })
		rp.sameRun(t, held, other, "after the move")
		// A group B does not have is B's refusal, and a group of A's own is no group of B.
		rp.runRefusedAsThere(t, http.StatusNotFound, "not_found", "PATCH", "/api/runs/"+held, map[string]any{"group": "g_nosuchgr"})
		rp.runRefusedAsThere(t, http.StatusNotFound, "not_found", "PATCH", "/api/runs/"+held, map[string]any{"group": rp.runLocalGroup(t, "A group of this computer")})
		// Nothing moves between servers: a patch that names a server is refused by B.
		rp.runRefusedAsThere(t, http.StatusBadRequest, "server_refused", "PATCH", "/api/runs/"+held, map[string]any{"server": servers.LocalID})
		rp.sameRun(t, held, other, "after the refused moves")
	})

	t.Run("rename", func(t *testing.T) {
		mark := rp.page.mark()
		if v := runIn(t, rp.runOK(t, "PATCH", "/api/runs/"+held, map[string]any{"name": "Renamed there"})); v.Name != "Renamed there" || v.Group != other {
			t.Fatalf("the renamed run: %+v", v)
		}
		rp.awaitRun(t, mark, 5*time.Second, held, "the new name", func(v model.RunView) bool { return v.Name == "Renamed there" })
		if b, _ := rp.ownRun(t, held); b.Name != "Renamed there" || !b.UserNamed {
			t.Fatalf("the run at B after the rename: %+v", b)
		}
		// What a started run's choices are is fixed: B refuses them, and A hands its refusal on.
		for _, body := range []map[string]any{{"cwd": rp.repo.Dir()}, {"agent": "claude"}, {"settings": map[string]any{"maxTurns": 3}}} {
			a := rp.runDo(t, "PATCH", "/api/runs/"+held, body)
			if b := rp.atB(t, "PATCH", "/api/runs/"+held, body); a.Status != http.StatusConflict || a.Status != b.Status || a.Raw != b.Raw {
				t.Fatalf("the change %v of a started run: through A %s, at B %s, want B's 409", body, a, b)
			}
		}
		if v := rp.sameRun(t, held, other, "after the rename"); v.Cwd != heldRepo.Dir() || v.Settings.MaxTurns != 12 {
			t.Fatalf("the run after the refused changes: %+v", v)
		}
	})

	// Stop and resume while a task's agent works; the page and the direct client both follow the
	// run from before the stop, and are sent the same run_detail events to its end.
	var slow string
	var pm, dm int
	t.Run("stop", func(t *testing.T) {
		skip := rp.b.fakeMessages(t)
		slow = rp.startRun(t, g, "Stop and resume", slowRepo.Dir(), noteGoal(t, "Stop it and resume it.", "slow.txt", "<<sleep 6>>"))
		rp.b.waitFakeMessage(t, skip, e2eOnTask)
		rp.runOK(t, "GET", "/api/runs/"+slow+"/detail", nil) // the page follows the run
		if a := rp.atB(t, "GET", "/api/runs/"+slow+"/detail", nil); a.Status != http.StatusOK {
			t.Fatalf("the detail at B: %s", a)
		}
		pm, dm = rp.page.mark(), direct.mark()
		mark := rp.page.mark()
		began := time.Now()
		v := runIn(t, rp.runOK(t, "POST", "/api/runs/"+slow+"/stop", nil))
		if (v.Status != model.RunStopping && v.Status != model.RunStopped) || v.Group != g {
			t.Fatalf("the answer of the stop through A: %+v", v)
		}
		stopped := rp.awaitRun(t, mark, 30*time.Second, slow, "stopped", func(v model.RunView) bool { return v.Status == model.RunStopped })
		if stopped.Reason == "" {
			t.Fatalf("the page's event of the stop: %+v", stopped)
		}
		if b := rp.ended(t, slow); b.Status != model.RunStopped {
			t.Fatalf("the run at B after the stop: %+v", b)
		}
		rp.sameRun(t, slow, g, "after the stop")
		if got := slowRepo.Git("rev-parse", "main"); got != slowRepo.Git("rev-list", "--max-parents=0", "main") {
			t.Fatalf("B's main moved before the run ended: %s", got)
		}
		t.Logf("stopped %v after the stop through A", time.Since(began).Round(time.Millisecond))
	})

	t.Run("resume", func(t *testing.T) {
		mark := rp.page.mark()
		am, adm := rp.page.mark(), direct.mark() // the run is stopped: no agent of it does anything
		if v := runIn(t, rp.runOK(t, "POST", "/api/runs/"+slow+"/resume", nil)); v.Status != model.RunRunning || v.Reason != "" {
			t.Fatalf("the answer of the resume through A: %+v", v)
		}
		rp.achieved(t, slow)
		rp.awaitRun(t, mark, 30*time.Second, slow, "the delivery", func(v model.RunView) bool {
			return v.Status == model.RunCompleted && v.Delivery == model.DeliveryApplied
		})
		if v := rp.sameRun(t, slow, g, "after the end"); v.Counts.Done != 1 || v.Outcome != model.Achieved {
			t.Fatalf("the ended run through A: %+v", v)
		}
		if got := slowRepo.Git("show", "main:slow.txt"); got != "written by the run" {
			t.Fatalf("main:slow.txt in B's repository: %q", got)
		}
		// The events of the run's detail, from the stop to the end, are B's bytes for both.
		var d model.RunDetail
		if err := json.Unmarshal([]byte(rp.sameBytes(t, "/api/runs/"+slow+"/detail", "after the end")), &d); err != nil || d.Version == 0 {
			t.Fatalf("the detail after the end: %v", err)
		}
		lastVersion := fmt.Sprintf(`"version":%d`, d.Version)
		n := rp.sameEvents(t, direct, pm, dm, func(raw string) bool { return strings.Contains(raw, lastVersion) }, "run_detail", slow)
		// What the run's agents did meanwhile came to both as well, when B told of any.
		acts := rp.sameEvents(t, direct, am, adm, nil, "run_activity", slow)
		t.Logf("the page on A and the direct client of B were each sent the same %d run_detail events, up to version %d, and the same %d run_activity events", n, d.Version, acts)
	})

	// What the run view reads on demand is what B answers, byte for byte.
	t.Run("detail, goal, brief, report, changes, notes, delivery", func(t *testing.T) {
		for _, c := range []struct{ path, holds string }{
			{"/detail", `"tasks":[{`},
			{"/goal", "Stop it and resume it."},
			{"/tasks/T01/brief", "Write slow.txt"},
			{"/tasks/T01/attempts/1/report", "report"},
			{"/tasks/T01/attempts/1/changes", "slow.txt"},
			{"/notes/1", "Done means"},
			{"/delivery", `"applied"`},
		} {
			if raw := rp.sameBytes(t, "/api/runs/"+slow+c.path, "the ended run"); !strings.Contains(raw, c.holds) {
				t.Errorf("%s through A lacks %q: %s", c.path, c.holds, clipText(raw, 600))
			}
		}
		// A text the run does not have is B's refusal, and says nothing about the run itself: it
		// is not the "not_found" of a run that is gone.
		for _, path := range []string{"/tasks/T99/brief", "/tasks/T01/attempts/7/report", "/notes/99"} {
			a, b := rp.runDo(t, "GET", "/api/runs/"+slow+path, nil), rp.atB(t, "GET", "/api/runs/"+slow+path, nil)
			if a.Status != b.Status || a.Raw != b.Raw || a.Status < 400 || a.Code == "not_found" {
				t.Errorf("%s: through A %s, at B %s", path, a, b)
			}
		}
	})

	// A run whose result waits for the person: the apply through A brings it into B's folder.
	t.Run("apply with applyResult manual", func(t *testing.T) {
		repo := manualRepo
		base := repo.Git("rev-parse", "main")
		d := rp.draft(t, g, "Apply by hand", repo.Dir())
		if v := runIn(t, rp.runOK(t, "PATCH", "/api/runs/"+d.ID, map[string]any{"settings": map[string]any{"maxTurns": 12, "applyResult": "manual"}})); v.Settings.ApplyResult != "manual" {
			t.Fatalf("the run with the manual apply: %+v", v.Settings)
		}
		mark := rp.page.mark()
		if a := rp.start(t, d.ID, noteGoal(t, "Apply it by hand.", "manual.txt", "")); a.Status != http.StatusOK {
			t.Fatalf("the start: %s", a)
		}
		run := d.ID
		if b := rp.achieved(t, run); b.Settings.ApplyResult != "manual" {
			t.Fatalf("the run's settings at B: %+v", b.Settings)
		}
		rp.awaitRun(t, mark, 30*time.Second, run, "the pending delivery", func(v model.RunView) bool { return v.Delivery == model.DeliveryPending })
		rp.sameRun(t, run, g, "before the apply")
		var del model.RunDelivery
		if err := json.Unmarshal([]byte(rp.sameBytes(t, "/api/runs/"+run+"/delivery", "before the apply")), &del); err != nil ||
			del.State != model.DeliveryPending || del.Reason != "manual" || del.Branch != "main" {
			t.Fatalf("the dry run through A: %+v, %v", del, err)
		}
		if head, st := repo.Git("rev-parse", "main"), repo.Git("status", "--porcelain"); head != base || st != "" {
			t.Fatalf("B's folder before the apply: main is %s (was %s), status %q", head, base, st)
		}
		mark = rp.page.mark()
		a := rp.runOK(t, "POST", "/api/runs/"+run+"/apply", map[string]any{})
		del = model.RunDelivery{}
		if err := json.Unmarshal([]byte(a.Raw), &del); err != nil || del.State != model.DeliveryApplied || del.How != "ff" || del.Auto || del.Commit == "" {
			t.Fatalf("the apply through A: %s", a)
		}
		if head, st := repo.Git("rev-parse", "main"), repo.Git("status", "--porcelain"); head != del.Commit || st != "" {
			t.Fatalf("B's folder after the apply: main is %s, the delivery's commit %s, status %q", head, del.Commit, st)
		}
		if got := repo.Git("show", "main:manual.txt"); got != "written by the run" {
			t.Fatalf("main:manual.txt in B's repository: %q", got)
		}
		rp.awaitRun(t, mark, 10*time.Second, run, "the applied delivery", func(v model.RunView) bool { return v.Delivery == model.DeliveryApplied })
		if v := rp.sameRun(t, run, g, "after the apply"); v.Delivery != model.DeliveryApplied {
			t.Fatalf("the run after the apply: %+v", v)
		}
	})

	// The transcript of a task's agent, read while it works: the page reads it through A and
	// the direct client at B, and both are sent the same chat_items from then on.
	t.Run("an agent's transcript", func(t *testing.T) {
		skip := rp.b.fakeMessages(t)
		run := rp.startRun(t, g, "A run to read", readRepo.Dir(), noteGoal(t, "Read its agent.", "read.txt", "<<sleep 4>>"))
		rp.b.waitFakeMessage(t, skip, e2eOnTask)
		agent := rp.agentOf(t, run, model.RoleTask)
		pm, dm := rp.page.mark(), direct.mark()
		began := time.Now()
		before := rp.through(t, agent) // the page follows the agent's chat
		t.Logf("the agent's items through A: %d items after %v", len(before), time.Since(began).Round(time.Millisecond))
		rp.own(t, agent) // and the direct client does
		// The chat of a run's agent is read-only for everyone: B's refusal, handed on.
		for _, c := range []struct {
			method, path string
			body         map[string]any
		}{
			{"POST", "/messages", map[string]any{"text": "not for an agent"}}, {"POST", "/interrupt", nil},
			{"PATCH", "", map[string]any{"name": "Not for an agent"}}, {"PATCH", "", map[string]any{"model": "sonnet"}},
			{"PATCH", "", map[string]any{"group": g}}, {"POST", "/archive", nil}, {"DELETE", "", nil},
		} {
			a, b := rp.runDo(t, c.method, "/api/chats/"+agent+c.path, c.body), rp.atB(t, c.method, "/api/chats/"+agent+c.path, c.body)
			if a.Status != http.StatusConflict || !strings.Contains(a.Error, "one of a run's agents") || a.Status != b.Status || a.Raw != b.Raw {
				t.Fatalf("%s %s %v of a run agent's chat: through A %s, at B %s, want B's 409", c.method, c.path, c.body, a, b)
			}
		}
		rp.achieved(t, run)
		n := rp.sameEvents(t, direct, pm, dm, func(raw string) bool { return strings.Contains(raw, `"kind":"end"`) }, "chat_items", agent)
		th := rp.same(t, agent, "after the run")
		if len(th) <= len(before) || !th.has(t, "Write read.txt") {
			t.Fatalf("the agent's thread after the run: %s", joinThread(th))
		}
		rp.sameBytes(t, "/api/chats/"+agent, "after the run")
		// The agent's chat is in nobody's list: not in A's tree of B, and not on the owner's page.
		if _, ok := rp.listed(t, agent); ok {
			t.Fatalf("the agent's chat is in A's tree of %s", pairName)
		}
		t.Logf("the page on A and the direct client of B were each sent the same %d chat_items events of the agent's chat", n)
	})

	// "+" on the run: a chat of the person on the run is made on B at once, on the run, and its
	// first message starts it there.
	var chat string
	t.Run("plus on the run", func(t *testing.T) {
		chat = rp.runChatOn(t, held, heldRepo.Dir()).ID
		rp.send(t, chat, "A word on the run.")
		if b, ok := rp.ownView(t, chat); !ok || b.Run != held || !b.Locked || b.Cwd != heldRepo.Dir() {
			t.Fatalf("the chat at B: %+v (there: %v)", b, ok)
		}
		rp.turns(t, chat, 1)
		if th := rp.same(t, chat, "after its first turn"); th.users(t, "A word on the run.") != 1 {
			t.Fatalf("the thread of the chat on the run: %s", joinThread(th))
		}
		eventually(t, 10*time.Second, "the started chat on the run in A's tree", func() bool {
			l, ok := rp.listed(t, chat)
			return ok && l.Run == held && l.Locked
		})
	})

	t.Run("archive of a live run", func(t *testing.T) {
		if b, _ := rp.ownRun(t, held); !b.Status.Live() {
			t.Fatalf("the run is not live before its archive: %+v", b)
		}
		mark := rp.page.mark()
		began := time.Now()
		rp.runOK(t, "POST", "/api/runs/"+held+"/archive", nil)
		// The archived mark reaches the page in B's run event, with B's archive action, and the
		// run stays in its group.
		shown := rp.awaitRun(t, mark, 5*time.Second, held, "the archived mark", func(v model.RunView) bool { return v.Archived })
		if shown.Op == "" || shown.Group != other {
			t.Fatalf("the page's event of the archive: %+v", shown)
		}
		// B stopped the run and archived it, and the chats on it with it.
		b := rp.awaitOwnRun(t, held, "archived and halted", func(v model.RunView) bool { return v.Archived && !v.Status.Live() })
		if b.Status != model.RunStopped || b.Op != shown.Op {
			t.Fatalf("the archived run at B: %+v, want it stopped by the action %q", b, shown.Op)
		}
		t.Logf("the live run was stopped and archived at B %v after the archive through A", time.Since(began).Round(time.Millisecond))
		eventually(t, 10*time.Second, "the chat on the run is archived on both sides", func() bool {
			bc, _ := rp.ownView(t, chat)
			ac, ok := rp.listed(t, chat)
			return ok && bc.Archived && ac.Archived
		})
		if v := rp.sameRun(t, held, other, "after the archive"); !v.Archived || v.Status != model.RunStopped || v.Op != shown.Op {
			t.Fatalf("the archived run through A: %+v (B's action is %q)", v, shown.Op)
		}
	})

	t.Run("unarchive", func(t *testing.T) {
		mark := rp.page.mark()
		rp.runOK(t, "POST", "/api/runs/"+held+"/unarchive", nil)
		rp.awaitRun(t, mark, 5*time.Second, held, "no archived mark", func(v model.RunView) bool { return !v.Archived })
		if b := rp.awaitOwnRun(t, held, "unarchived", func(v model.RunView) bool { return !v.Archived }); b.Status != model.RunStopped {
			t.Fatalf("the unarchived run at B: %+v", b)
		}
		eventually(t, 10*time.Second, "the chat on the run is back on both sides", func() bool {
			bc, there := rp.ownView(t, chat)
			ac, ok := rp.listed(t, chat)
			return ok && there && !bc.Archived && !ac.Archived
		})
		if v := rp.sameRun(t, held, other, "after the unarchive"); v.Archived || v.Op != "" {
			t.Fatalf("the unarchived run through A: %+v", v)
		}
	})

	t.Run("delete", func(t *testing.T) {
		mark := rp.page.mark()
		began := time.Now()
		from := `"server":"` + rp.entry + `"`
		rp.runOK(t, "DELETE", "/api/runs/"+held, nil)
		gone := rp.page.awaitEvent(t, mark, 5*time.Second, "run_removed", held, from)
		t.Logf("the run was deleted %v after the delete through A", time.Since(began).Round(time.Millisecond))
		// The chat on the run went first.
		if evs := rp.page.of(mark, "chat_removed", chat, from); len(evs) != 1 || evs[0].At.After(gone.At) {
			t.Fatalf("the chat_removed events of the chat on the run: %v", evs)
		}
		if _, there := rp.ownRun(t, held); there {
			t.Fatal("B still has the deleted run")
		}
		if _, there := rp.ownView(t, chat); there {
			t.Fatal("B still has the chat on the deleted run")
		}
		// It left A's tree with B's event, and the owner's page: no row of it stays behind.
		if _, ok := rp.listedRun(t, held); ok {
			t.Fatalf("the deleted run is still in A's tree of %s", pairName)
		}
		if _, ok := rp.ownerRun(t, held); ok {
			t.Fatal("the deleted run is still on the owner's page")
		}
		if _, ok := rp.listed(t, chat); ok {
			t.Fatalf("the chat on the deleted run is still in A's tree of %s", pairName)
		}
		// A call for what is gone there is B's answer that it is not there.
		for _, c := range []struct{ method, path string }{
			{"GET", "/api/runs/" + held}, {"GET", "/api/runs/" + held + "/detail"}, {"POST", "/api/runs/" + held + "/stop"},
			{"DELETE", "/api/runs/" + held}, {"GET", "/api/chats/" + chat},
		} {
			rp.runRefusedAsThere(t, http.StatusNotFound, "not_found", c.method, c.path, nil)
		}
		if left := heldRepo.Git("for-each-ref", "--format=%(refname:short)", "refs/heads/aiwb/"); left != "" {
			t.Fatalf("branches of the deleted run in B's repository:\n%s", left)
		}
		if left := rp.b.runFolders(t); slices.Contains(left, held) {
			t.Fatalf("B's run folders after the delete: %v", left)
		}
	})
}

// runChatOn makes a chat of the person on a run of B's section, from A's page: the chat is on B
// at once, on the run and in the run's folder dir, and has not started. It returns A's answer.
func (rp *runPair) runChatOn(t *testing.T, run, dir string) model.ChatView {
	t.Helper()
	var v model.ChatView
	a := rp.runOK(t, "POST", "/api/chats", map[string]any{"agent": "claude", "run": run})
	if err := json.Unmarshal([]byte(a.Raw), &v); err != nil || v.ID == "" || v.Run != run || v.Cwd != dir || v.Locked {
		t.Fatalf("the chat made on the run %s of %s: %s", run, pairName, a)
	}
	if made, there := rp.ownView(t, v.ID); !there || made.Run != run || made.Locked || made.Cwd != dir {
		t.Fatalf("the chat at B before its first message: %+v (there: %v)", made, there)
	}
	eventually(t, 10*time.Second, "the chat on the run in A's tree of "+pairName, func() bool {
		l, ok := rp.listed(t, v.ID)
		return ok && l.Run == run && !l.Locked
	})
	return v
}

// restore lets the link carry again after a stall or a cut and waits for A's connection and
// for B's tree at the page. It returns how long the connection took.
func (rp *runPair) restore(t *testing.T) time.Duration {
	t.Helper()
	mark := rp.page.mark()
	rp.link.Stall(false, false)
	rp.link.Uncut()
	d := rp.back(t, 60*time.Second)
	rp.treeBack(t, mark)
	return d
}

// AC43 and goal 3.4, the refusals: a make or a start that B refuses reaches the page as B said
// it. A refused make makes nothing, here or there; a refused start leaves the run one that has
// not started, on B, and starts no orchestrator there.
func TestRemoteRunRefusals(t *testing.T) {
	serverTest(t, "TestSectionCallPassedOn (internal/remotes)", "TestSectionCallsOfAConnectedEntry (internal/server)")
	rp := connectedRunPair(t, linksim.Good)
	g := rp.runGroup(t, "Work")
	// stays checks that the run has not started after a refused start.
	stays := func(t *testing.T, run, when string) model.RunView {
		t.Helper()
		v := rp.throughRun(t, run) // B is asked about the folder again
		if v.Status != model.RunDraft || v.Group != g || !v.Started.IsZero() {
			t.Fatalf("%s: the run: %+v", when, v)
		}
		if l, ok := rp.listedRun(t, run); !ok || l.Status != model.RunDraft {
			t.Fatalf("%s: the run in A's tree: %+v (listed: %v)", when, l, ok)
		}
		return v
	}

	t.Run("a make that B cannot take", func(t *testing.T) {
		before, _ := rp.section(t)
		for _, body := range []map[string]any{
			{"group": "g_nosuchgr", "name": "Nowhere"},                                    // no group of B
			{"group": rp.runLocalGroup(t, "A group of this computer"), "name": "Nowhere"}, // a group of A's own is none of B
		} {
			rp.runRefusedAsThere(t, http.StatusNotFound, "not_found", "POST", "/api/runs", body)
		}
		rp.runRefusedAsThere(t, http.StatusBadRequest, "", "POST", "/api/runs", map[string]any{"name": "In no group at all"})
		time.Sleep(300 * time.Millisecond) // an event of a run that was made after all would have come
		if after, _ := rp.section(t); len(after.Runs) != len(before.Runs) {
			t.Fatalf("A's tree of %s after the refused makes: %d runs, %d before them", pairName, len(after.Runs), len(before.Runs))
		}
		if left := rp.b.runFolders(t); len(left) != len(before.Runs) {
			t.Fatalf("B's run folders after the refused makes: %v", left)
		}
		if here := rp.runOwn(t); len(here.Runs) != 0 {
			t.Fatalf("A's own runs after the refused makes: %+v", here.Runs)
		}
	})

	t.Run("a missing folder", func(t *testing.T) {
		dir := filepath.Join(rp.folder(t, "", ""), "work")
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		d := rp.draft(t, g, "No folder", dir)
		if err := os.Remove(dir); err != nil {
			t.Fatal(err)
		}
		const first = "Never started: no folder."
		body := map[string]any{"goal": noteGoal(t, first, "never.txt", "")}
		a := rp.runDo(t, "POST", "/api/runs/"+d.ID+"/start", body)
		if b := rp.atB(t, "POST", "/api/runs/"+d.ID+"/start", body); a.Status != http.StatusConflict || !strings.Contains(a.Error, dir) || a.Status != b.Status || a.Raw != b.Raw {
			t.Fatalf("the start in a folder that is gone: through A %s, at B %s, want B's 409 with the folder", a, b)
		}
		if v := stays(t, d.ID, "after the refusal"); !v.FolderMissing {
			t.Fatalf("the run after the refusal: %+v, want the folder missing", v)
		}
		// A change to a folder B does not have is refused by B's check, with the folder, in B's
		// words: A adds no code of its own.
		if a := rp.runRefusedAsThere(t, http.StatusBadRequest, "", "PATCH", "/api/runs/"+d.ID, map[string]any{"cwd": dir + "-other"}); !strings.Contains(a.Error, dir+"-other") {
			t.Fatalf("the change to a missing folder: %s", a)
		}
		if v := stays(t, d.ID, "after the refused change"); v.Cwd != dir {
			t.Fatalf("the run's folder after the refused change: %q, want %q", v.Cwd, dir)
		}
		if n := rp.b.orchestrators(t, first); n != 0 {
			t.Fatalf("%d orchestrators at B", n)
		}
	})

	t.Run("the Claude program is gone", func(t *testing.T) {
		d := rp.draft(t, g, "No program", rp.repo.Dir())
		away := rp.b.in.claude + ".away"
		if err := os.Rename(rp.b.in.claude, away); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Rename(away, rp.b.in.claude) })
		const first = "Not started: no program."
		goal := noteGoal(t, first, "program.txt", "")
		a := rp.start(t, d.ID, goal)
		if b := rp.atB(t, "POST", "/api/runs/"+d.ID+"/start", map[string]any{"goal": goal}); a.Status != http.StatusConflict || !strings.Contains(a.Error, "program was not found") || a.Status != b.Status || a.Raw != b.Raw {
			t.Fatalf("the start with B's Claude program gone: through A %s, at B %s, want B's 409 with its reason", a, b)
		}
		v := stays(t, d.ID, "after the refusal")
		if v.Blocked != a.Error {
			t.Fatalf("the run's view after the refusal says %q, the refusal %q", v.Blocked, a.Error)
		}
		t.Logf("the refusal through A: %d %s %q; the run's blocked: %q", a.Status, a.Code, a.Error, v.Blocked)
		if n := rp.b.orchestrators(t, first); n != 0 {
			t.Fatalf("%d orchestrators at B", n)
		}
		// With the program back the same run starts.
		if err := os.Rename(away, rp.b.in.claude); err != nil {
			t.Fatal(err)
		}
		var again answer
		eventually(t, 30*time.Second, "the start with the program back", func() bool {
			again = rp.start(t, d.ID, goal)
			return again.Status == http.StatusOK
		})
		if v := runIn(t, again); v.ID != d.ID || v.Started.IsZero() {
			t.Fatalf("the start with the program back: %s", again)
		}
		rp.achieved(t, d.ID)
		if n := rp.b.orchestrators(t, first); n != 1 {
			t.Fatalf("%d orchestrators at B, want 1", n)
		}
	})
}

// localDone waits until a run of this computer has ended on A, which must be with its goal
// achieved.
func (rp *runPair) localDone(t *testing.T, run string) model.RunView {
	t.Helper()
	for deadline := time.Now().Add(e2eWait); ; time.Sleep(100 * time.Millisecond) {
		v := runIn(t, rp.ok(t, "GET", "/api/runs/"+run, nil))
		if !v.Status.Live() && v.Status != model.RunDraft {
			if v.Status != model.RunCompleted || v.Outcome != model.Achieved {
				t.Fatalf("the run %s of this computer ended as %+v", run, v)
			}
			return v
		}
		if time.Now().After(deadline) {
			t.Fatalf("the run %s of this computer is still %s", run, v.Status)
		}
	}
}

// AC43, AC12 and goal 3.7 to 3.9, the outage: B is stopped for 60 s while a task of a run works
// and the run's view is on screen (for 6 s, with the back-off of A's connection on the fast clock
// as well: see TestRemoteChatOutage), and in a second run restarted at once. While B is away its
// section has no tree, every call for one of its runs answers at once that the server is not
// connected, nothing can be made on it, and a run of this computer works meanwhile. After the
// return the page is sent B's tree again, with the run as B has it now; B went on with the run by
// itself; and a read of the run's detail follows it again, level with B to its end.
func TestRemoteRunOutage(t *testing.T) {
	serverTest(t, "TestSectionStates (internal/remotes)", "TestServerDropsWithAChatAndARunFollowed (internal/server)", "TestConnReconnects (internal/servers)")
	rp := connectedRunPair(t, linksim.Good, fast.env(t, "backoff"))
	g := rp.runGroup(t, "Work")
	hereRepo := rp.newRepo(t) // for the runs of this computer
	ended := rp.startRun(t, g, "Ended before", rp.repo.Dir(), noteGoal(t, "Ended before the outage.", "ended.txt", ""))
	rp.achieved(t, ended)
	rp.sameRun(t, ended, g, "before the outage")

	down := func(t *testing.T, name string, repo *agenttest.Repo, away time.Duration) {
		file := name + ".txt"
		skip := rp.b.fakeMessages(t)
		run := rp.startRun(t, g, "Through "+name, repo.Dir(), noteGoal(t, "Through the outage: "+name+".", file, "<<sleep 6>>"))
		rp.b.waitFakeMessage(t, skip, e2eOnTask)
		rp.runOK(t, "GET", "/api/runs/"+run+"/detail", nil) // the run is on screen
		rp.sameRun(t, run, g, "before the outage")
		made := len(rp.b.runFolders(t))
		mark := rp.page.mark()
		rp.b.stop(t)
		exited := time.Now()
		rp.waitState(t, servers.StateUnreachable, 2*time.Second)
		rp.page.await(t, mark, 2*time.Second, "server_state event: unreachable", func(e seenEvent) bool {
			return e.holds("server_state", rp.entry, `"unreachable"`)
		})
		// The section has no tree from here on: no row, no last view.
		rp.runNoTree(t, mark, 10*time.Second)

		// Every call for a thing of the section answers at once that B is not connected.
		whileAway := func(when string) {
			t.Helper()
			if v := rp.entryView(t); v.State != servers.StateUnreachable {
				t.Fatalf("%s: %s is %q", when, pairName, v.State)
			}
			if _, ok := rp.section(t); ok {
				t.Fatalf("%s: A's snapshot has a tree of %s", when, pairName)
			}
			start := time.Now()
			for _, c := range []struct {
				method, path string
				body         any
			}{
				{"POST", "/api/runs/" + run + "/stop", nil}, {"POST", "/api/runs/" + run + "/resume", nil}, {"GET", "/api/runs/" + run + "/detail", nil},
				{"GET", "/api/runs/" + run, nil}, {"GET", "/api/runs/" + run + "/goal", nil}, {"DELETE", "/api/runs/" + run, nil},
				{"PATCH", "/api/runs/" + run, map[string]any{"name": "Renamed while away"}}, {"POST", "/api/runs/" + run + "/archive", nil},
				{"GET", "/api/runs/" + ended, nil}, {"GET", "/api/runs/" + ended + "/detail", nil},
				// Nothing can be made on a server that is not connected.
				{"POST", "/api/runs", map[string]any{"group": g, "name": "Made while away"}},
			} {
				if a := rp.runRefused(t, http.StatusServiceUnavailable, "server_unreachable", c.method, c.path, c.body); !strings.Contains(a.Error, pairName) {
					t.Fatalf("%s: %s %s: %s", when, c.method, c.path, a)
				}
			}
			// The page's follow ended with the tree; letting go of it is answered here.
			if a := rp.runOK(t, "POST", "/api/runs/"+run+"/unfollow", nil); !strings.Contains(a.Raw, `"ok":true`) {
				t.Fatalf("%s: the unfollow: %s", when, a)
			}
			if d := time.Since(start); d > 2*time.Second {
				t.Fatalf("%s: the refusals took %v", when, d)
			}
		}
		whileAway("while B is away")
		// A run of this computer, from "New run" to its end, while B is away.
		here := rp.a.newRun(t, pairPage, "Here, "+name, hereRepo.Dir(), noteGoal(t, "A run of this computer: "+name+".", "here-"+file, ""))
		if v := rp.localDone(t, here); v.Counts.Done != 1 {
			t.Fatalf("the run of this computer: %+v", v)
		}
		if got := hereRepo.Git("show", "main:here-"+file); got != "written by the run" {
			t.Fatalf("main:here-%s on this computer: %q", file, got)
		}
		time.Sleep(time.Until(exited.Add(away)))
		whileAway(fmt.Sprintf("after %s without B", away))

		mark = rp.page.mark()
		rp.b.up(t)
		back := rp.back(t, 45*time.Second)
		rp.treeBack(t, mark)
		// The tree that came is B's as it is now: both runs, and nothing that was asked for while
		// B was away.
		if _, ok := rp.listedRun(t, run); !ok {
			t.Fatalf("A's tree of %s after the return lacks the run %s", pairName, run)
		}
		if left := rp.b.runFolders(t); len(left) != made {
			t.Fatalf("B's run folders after the return: %v, want the %d of before the outage", left, made)
		}
		if b, _ := rp.ownRun(t, run); b.Name != "Through "+name || b.Archived {
			t.Fatalf("the run at B after the return: %+v", b)
		}
		// The page's follow of the run ended with the tree: it reads the run on screen again when
		// the tree is back, and follows it from there.
		if evs := rp.page.of(mark, "run_detail", run); len(evs) != 0 {
			t.Fatalf("the page was sent %d run_detail events of a run it no longer follows", len(evs))
		}
		rp.runOK(t, "GET", "/api/runs/"+run+"/detail", nil)
		rp.achieved(t, run) // B went on with it by itself
		done := rp.awaitRun(t, mark, 30*time.Second, run, "the end", func(v model.RunView) bool {
			return v.Status == model.RunCompleted && v.Delivery == model.DeliveryApplied
		})
		if done.Group != g {
			t.Fatalf("the page's event of the end: %+v", done)
		}
		rp.sameRun(t, run, g, "after the return")
		rp.sameRun(t, ended, g, "after the return")
		var d model.RunDetail
		if err := json.Unmarshal([]byte(rp.sameBytes(t, "/api/runs/"+run+"/detail", "after the return")), &d); err != nil || d.Status != model.RunCompleted || len(d.Stops) != 1 || d.Stops[0].ResumedAt == 0 {
			t.Fatalf("the detail after the return: %v, status %s, stops %+v", err, d.Status, d.Stops)
		}
		rp.page.awaitEvent(t, mark, 10*time.Second, "run_detail", run, `"server":"`+rp.entry+`"`, fmt.Sprintf(`"version":%d`, d.Version))
		if got := repo.Git("show", "main:"+file); got != "written by the run" {
			t.Fatalf("main:%s in B's repository: %q", file, got)
		}
		t.Logf("AC12, %s: connected again %v after B answered (%v after B's process was gone); the run ended at version %d and the page was sent it",
			name, back.Round(time.Millisecond), time.Since(exited).Round(time.Millisecond), d.Version)
	}

	stoppedRepo, restartedRepo := rp.newRepo(t), rp.newRepo(t)
	t.Run("stopped for 60 s", func(t *testing.T) { down(t, "stopped", stoppedRepo, fast.of(60*time.Second)) })
	t.Run("restarted", func(t *testing.T) { down(t, "restarted", restartedRepo, 0) })
}

// AC34, the run half, and goal 3.4: a chat made on a run of B's section is on B, on the run and
// in the run's folder, from the moment it is made; its first message starts it there, and it may
// call the run's tools.
func TestRemoteRunChat(t *testing.T) {
	serverTest(t, "TestSectionCallPassedOn (internal/remotes)", "TestSectionRoutesPassOn (internal/server)")
	rp := connectedRunPair(t, linksim.Good)
	g := rp.runGroup(t, "Work")
	skip := rp.b.fakeMessages(t)
	run := rp.startRun(t, g, "A run to talk about", rp.repo.Dir(), e2eHeldGoal(t))
	rp.b.waitFakeMessage(t, skip, e2eOnTask)

	// It is made at B at once, on the run, and has not started.
	v := rp.runChatOn(t, run, rp.repo.Dir())
	if v.Model != "haiku" {
		t.Fatalf("the chat made on the run: %+v; want the deep tier's model", v)
	}
	chat := v.ID

	// The first message, an ordinary one, starts it at B, on the run.
	rp.send(t, chat, "A word on the run.")
	b, there := rp.ownView(t, chat)
	if !there || b.Run != run || b.Cwd != rp.repo.Dir() || !b.Locked || b.Group != "" {
		t.Fatalf("the chat at B: %+v (there: %v); want it on the run, in the run's folder", b, there)
	}
	if _, err := os.Stat(filepath.Join(rp.b.home, "runs", run, "chats", chat, "chat.json")); err != nil {
		t.Fatalf("the chat's folder under the run at B: %v", err)
	}
	rp.turns(t, chat, 1)
	if th := rp.same(t, chat, "after its first turn"); th.users(t, "A word on the run.") != 1 || !th.has(t, "FAKE(haiku): ") {
		t.Fatalf("the thread of the chat on the run: %s", joinThread(th))
	}
	eventually(t, 10*time.Second, "the started chat on the run in A's tree", func() bool {
		l, ok := rp.listed(t, chat)
		return ok && l.Run == run && l.Locked
	})
	// And it is a chat of the run for B's agent: it may call the run's tools.
	rp.send(t, chat, "What is the run? [[mcp get_run {}]]")
	rp.turns(t, chat, 2)
	if th := rp.same(t, chat, "after a call of a run tool"); !th.has(t, "Wait for the chat") {
		t.Fatalf("the chat's get_run does not list the run's task: %s", joinThread(th))
	}
	// A kept nothing of the chat or of the run, and started no agent for either.
	rp.runNothingHere(t, "after the chat's turns", []string{run, chat, g}, "A word on the run.")
	if left := rp.a.agentFakes(t); len(left) != 0 {
		t.Fatalf("A started an agent for a chat on %s: %v", pairName, left)
	}
	rp.runOK(t, "POST", "/api/runs/"+run+"/stop", nil)
	rp.ended(t, run)
}

// AC27 and goal 3.12: an entry with a run that works is removed. Its section goes, with the run
// in it, and nothing of that server can be reached from this app any more; B, which is told
// nothing, still has the run and takes it to its end.
func TestRemoteRunRemoval(t *testing.T) {
	serverTest(t, "TestSectionOfAnEntryThatIsRemoved (internal/remotes)", "TestSectionEventAtConnectDropAndRemoval (internal/server)")
	rp := connectedRunPair(t, linksim.Good)
	g := rp.runGroup(t, "Work")
	const first = "It goes on without A."
	skip := rp.b.fakeMessages(t)
	run := rp.startRun(t, g, "Stays there", rp.repo.Dir(), noteGoal(t, first, "goes-on.txt", "<<sleep 5>>"))
	rp.b.waitFakeMessage(t, skip, e2eOnTask)
	paths := []string{"/api/runs/" + run, "/api/runs/" + run + "/detail", "/api/runs/" + run + "/goal"}
	// AC6: B's secret is in nothing A sent or answers, with the run on B and after the removal.
	noSecret := func(when string) {
		t.Helper()
		rp.noSecret(t, rp.page)
		for _, path := range paths {
			if _, raw := rp.a.call(t, pairPage, "GET", rp.runOn(path), nil, nil); strings.Contains(raw, rp.b.secret) {
				t.Fatalf("%s: B's secret is in the answer of GET %s through A: %s", when, path, clipText(raw, 400))
			}
		}
	}
	if v := rp.throughRun(t, run); v.Status == model.RunDraft {
		t.Fatalf("the run through A before the removal: %+v", v)
	}
	rp.runOK(t, "GET", "/api/runs/"+run+"/detail", nil)
	if _, ok := rp.listedRun(t, run); !ok {
		t.Fatalf("A's tree of %s lacks the run before the removal", pairName)
	}
	noSecret("before the removal")
	mark := rp.page.mark()
	rp.ok(t, "DELETE", "/api/servers/"+rp.entry, nil)
	// The section goes: the page is told that A holds no tree of the entry, and the entry is in
	// no list.
	rp.page.awaitEvent(t, mark, 5*time.Second, "section", `"server":"`+rp.entry+`"`, `"tree":null`)
	rp.page.awaitEvent(t, mark, 5*time.Second, "servers")
	for _, c := range []struct{ method, path string }{
		{"GET", paths[0]}, {"GET", paths[1]}, {"GET", paths[2]}, {"POST", "/api/runs/" + run + "/stop"}, {"DELETE", "/api/runs/" + run},
		{"POST", "/api/runs"},
	} {
		rp.runRefused(t, http.StatusNotFound, "no_server", c.method, c.path, map[string]any{"group": g, "name": "For no server"})
	}
	// The local routes never knew the run.
	rp.refused(t, http.StatusNotFound, "not_found", "GET", "/api/runs/"+run, nil)
	var st struct {
		Runs     []model.RunView
		Servers  []servers.View
		Sections map[string]json.RawMessage
	}
	rp.a.must(t, pairPage, "GET", "/api/state", nil, &st)
	if len(st.Servers) != 1 || st.Servers[0].ID != servers.LocalID {
		t.Fatalf("A's servers after the removal: %+v", st.Servers)
	}
	if len(st.Runs) != 0 || st.Sections == nil || len(st.Sections) != 0 {
		t.Fatalf("A's runs and sections after the removal: %+v, %v", st.Runs, st.Sections)
	}
	noSecret("after the removal")

	// B was told nothing: it has the run, unchanged, and takes it to its end.
	if b := rp.achieved(t, run); b.Archived || b.Counts.Done != 1 || b.Group != g || b.Name != "Stays there" {
		t.Fatalf("the run at B after the removal: %+v", b)
	}
	if got := rp.repo.Git("show", "main:goes-on.txt"); got != "written by the run" {
		t.Fatalf("main:goes-on.txt in B's repository: %q", got)
	}
	if n := rp.b.orchestrators(t, first); n != 1 {
		t.Fatalf("%d orchestrators at B, want 1", n)
	}
	if left := rp.b.runFolders(t); !slices.Equal(left, []string{run}) {
		t.Fatalf("B's run folders: %v, want %s alone", left, run)
	}
	// And A's data folder holds nothing of it.
	if held := holders(folderFiles(t, rp.a.home), []string{run, g, "Stays there", first, rp.b.secret}); len(held) != 0 {
		t.Fatalf("files of A's data folder hold something of %s after the removal: %v", pairName, held)
	}
}

// AC29 and AC44, a server that lost its agent: B's Claude program goes away while B is connected.
// A's page is told B's lists with no agent within 35 s. A chat or a run that names the agent is
// then refused by B with its own reason, which A hands on, and nothing is made.
// B looks its programs up on the fastest clock, every second for every 30 s; the 35 s are the bound.
func TestRemoteRunNoAgentProgram(t *testing.T) {
	serverTest(t, "TestAgentsReachPages (internal/remotes)", "TestAgentsEventUpdatesView (internal/servers)", "TestListFollowsThePath (internal/usable)")
	rp := connectedRunPair(t, linksim.Good, fastest.env(t, "agents"))
	g := rp.runGroup(t, "Work")
	agentsOf := func(e seenEvent) (agents []model.AgentKind, ok bool) {
		var ev struct {
			Server string
			Lists  *struct{ Agents []model.AgentKind }
		}
		if e.Type != "server_lists" || json.Unmarshal([]byte(e.Raw), &ev) != nil || ev.Server != rp.entry || ev.Lists == nil {
			return nil, false
		}
		return ev.Lists.Agents, true
	}
	var made model.ChatView
	if a := rp.runOK(t, "POST", "/api/chats", map[string]any{"group": g}); json.Unmarshal([]byte(a.Raw), &made) != nil || made.ID == "" || made.Agent != model.Claude || made.Group != g {
		t.Fatalf("a chat made on %s with its program there: %s", pairName, a)
	}
	d := rp.draft(t, g, "With the program", rp.repo.Dir())

	mark := rp.page.mark()
	away := rp.b.in.claude + ".away"
	if err := os.Rename(rp.b.in.claude, away); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Rename(away, rp.b.in.claude) })
	began := time.Now()
	rp.page.await(t, mark, 35*time.Second, "server_lists event of "+pairName+" with no agent", func(e seenEvent) bool {
		agents, ok := agentsOf(e)
		return ok && len(agents) == 0
	})
	t.Logf("the page was told %s has no agent %v after its program was gone", pairName, time.Since(began).Round(10*time.Millisecond))
	if l, ok := rp.state(t).Lists[rp.entry]; !ok || len(l.Agents) != 0 {
		t.Fatalf("%s's agents in A's snapshot: %v (lists there: %v), want none", pairName, l.Agents, ok)
	}
	if v := rp.entryView(t); v.State != servers.StateConnected {
		t.Fatalf("%s is %q with its program gone, want connected", pairName, v.State)
	}
	// The section still shows B's tree, and what B refuses is refused as B says it.
	before, ok := rp.section(t)
	if !ok {
		t.Fatalf("A holds no tree of %s with its program gone", pairName)
	}
	a := rp.runRefusedAsThere(t, http.StatusConflict, "agent_missing", "POST", "/api/chats", map[string]any{"agent": "claude", "group": g})
	t.Logf("a chat for the agent that is gone, through A: %s", a)
	body := map[string]any{"goal": noteGoal(t, "Never started: no program.", "never.txt", "")}
	s := rp.runDo(t, "POST", "/api/runs/"+d.ID+"/start", body)
	if b := rp.atB(t, "POST", "/api/runs/"+d.ID+"/start", body); s.Status != http.StatusConflict || s.Error == "" || s.Status != b.Status || s.Raw != b.Raw {
		t.Fatalf("the start of a run with B's program gone: through A %s, at B %s, want B's 409", s, b)
	}
	time.Sleep(300 * time.Millisecond) // an event of a chat that was made after all would have come
	after, _ := rp.section(t)
	if len(after.Chats) != len(before.Chats) || len(after.Runs) != len(before.Runs) {
		t.Fatalf("A's tree of %s after the refusals: %d chats and %d runs, %d and %d before them", pairName, len(after.Chats), len(after.Runs), len(before.Chats), len(before.Runs))
	}
	if v, _ := rp.ownRun(t, d.ID); v.Status != model.RunDraft {
		t.Fatalf("the run at B after its refused start: %+v", v)
	}
	if here := rp.runOwn(t); len(here.Chats) != 0 || len(here.Runs) != 0 {
		t.Fatalf("A's own chats and runs after the refusals: %+v, %+v", here.Chats, here.Runs)
	}
}

// bPage makes a call of B's own page: on B's loopback listener, as the person at B would, with
// the page's event stream open while the call is made.
func (rp *runPair) bPage(t *testing.T, method, path string, body any) answer {
	t.Helper()
	w := rp.runOwner(t)
	defer w.close()
	status, raw := rp.b.call(t, apiPage, method, path, body, nil)
	a := answer{Status: status, Raw: raw}
	json.Unmarshal([]byte(raw), &a)
	a.Status, a.Raw = status, raw
	return a
}

// Goal 3.3, 3.5 and 3.9, what is done on B's own page: an archive made there shows on A by B's
// run event. During a cut of the link the section has no tree, and the owner renames the run and
// deletes another, one that has not started and was on screen on A. When the link carries again
// the tree that comes is B's as it is now: the run archived, with its new name, and without the
// deleted one, which leaves no row behind and is answered as no longer there.
func TestRemoteRunArchivedThere(t *testing.T) {
	serverTest(t, "TestSectionEvents (internal/remotes)", "TestSectionEventAtConnectDropAndRemoval, TestServerDropsWithAChatAndARunFollowed (internal/server)")
	rp := connectedRunPair(t, linksim.Good)
	g := rp.runGroup(t, "Work")
	run := rp.startRun(t, g, "Archived there", rp.repo.Dir(), noteGoal(t, "Archived on its own server.", "there.txt", ""))
	rp.achieved(t, run)
	if v := rp.sameRun(t, run, g, "before the archive"); v.Archived {
		t.Fatalf("the run is archived before its archive: %+v", v)
	}
	// A run that has not started, which the owner deletes while A is cut off; its view is on
	// screen on A. A run that has not started has no detail yet: that is B's refusal.
	deleted := rp.draft(t, g, "Deleted there", rp.repo.Dir()).ID
	rp.throughRun(t, deleted)
	rp.runRefusedAsThere(t, http.StatusConflict, "", "GET", "/api/runs/"+deleted+"/detail", nil)

	mark := rp.page.mark()
	if a := rp.bPage(t, "POST", "/api/runs/"+run+"/archive", nil); a.Status != http.StatusOK {
		t.Fatalf("the archive on B's own page: %s", a)
	}
	there := rp.awaitRun(t, mark, 5*time.Second, run, "the archived mark", func(v model.RunView) bool { return v.Archived })
	if there.Group != g || there.Op == "" {
		t.Fatalf("the page's event of the archive made at %s: %+v", pairName, there)
	}
	if v := rp.sameRun(t, run, g, "after the archive"); !v.Archived || v.Op != there.Op {
		t.Fatalf("the run through A after the archive made at %s: %+v", pairName, v)
	}

	mark = rp.page.mark()
	rp.link.Cut()
	rp.waitState(t, servers.StateUnreachable, 40*time.Second)
	rp.runNoTree(t, mark, 10*time.Second)
	for _, id := range []string{run, deleted} {
		rp.runRefused(t, http.StatusServiceUnavailable, "server_unreachable", "GET", "/api/runs/"+id, nil)
	}
	const renamed = "Renamed during the cut"
	if a := rp.bPage(t, "PATCH", "/api/runs/"+run, map[string]any{"name": renamed}); a.Status != http.StatusOK {
		t.Fatalf("the rename on B's own page: %s", a)
	}
	if a := rp.bPage(t, "DELETE", "/api/runs/"+deleted, nil); a.Status != http.StatusOK {
		t.Fatalf("the delete on B's own page: %s", a)
	}
	mark = rp.page.mark()
	rp.restore(t)
	// The page is sent the tree in the section event: it holds the run as B has it now, and not
	// the run that is gone.
	sent := rp.runTreeBack(t, mark)
	if v, ok := runListed(t, "the section event", sent.Runs, run); !ok || !v.Archived || v.Name != renamed || v.Group != g || len(sent.Runs) != 1 {
		t.Fatalf("the runs of the tree the page was sent after the cut: %+v, want the one run, archived and renamed", sent.Runs)
	}
	if !slices.ContainsFunc(sent.Groups, func(x model.Group) bool { return x.ID == g && x.Name == "Work" }) {
		t.Fatalf("the groups of the tree the page was sent after the cut: %+v", sent.Groups)
	}
	if v := rp.sameRun(t, run, g, "after the cut"); !v.Archived || v.Op != there.Op || v.Name != renamed {
		t.Fatalf("the run through A after the cut: %+v, want it archived and renamed", v)
	}
	if b, there := rp.ownRun(t, run); !there || !b.Archived {
		t.Fatalf("the run at B after the cut: %+v (there: %v)", b, there)
	}
	// The run that was deleted there is in no tree, and a read of what was on screen is B's
	// answer that it is not there. No event had to say so: the tree that came is without it.
	if _, ok := rp.listedRun(t, deleted); ok {
		t.Fatalf("the run deleted at %s during the cut is in A's tree after it", pairName)
	}
	for _, path := range []string{"/api/runs/" + deleted + "/detail", "/api/runs/" + deleted} {
		rp.runRefusedAsThere(t, http.StatusNotFound, "not_found", "GET", path, nil)
	}
	if evs := rp.page.of(mark, "run_removed", deleted); len(evs) != 0 {
		t.Fatalf("the page was sent %d run_removed events of a run that was deleted while A was cut off", len(evs))
	}
}

// Goal 3.4 and contract 3.5, a make and a start whose answers are lost: B's answers wait, so the
// call arrives and B does what it asks, and the link is cut before A is told. The call answers
// 504 no_answer. When the link carries again the run is in B's tree like anything else, made
// once and started once: nothing looked for it and nothing was deleted on its account, and a
// repeat of the start is B's refusal.
func TestRemoteRunNoAnswer(t *testing.T) {
	serverTest(t, "TestSectionServerDropsInACall (internal/remotes)", "TestSectionCallsThatGetNoAnswer (internal/server)")
	rp := connectedRunPair(t, linksim.Good)
	g := rp.runGroup(t, "Work")
	// lost makes a call for B's section with B's answers held back, waits until B did what it
	// asks, and cuts the link: the call must answer 504 no_answer. The link carries again and
	// A's page has B's tree when it returns.
	lost := func(what, method, path string, body any, done func() bool) {
		t.Helper()
		rp.link.Stall(true, false) // what B sends waits
		sent := rp.later(method, rp.runOn(path), body)
		eventually(t, 30*time.Second, what+" arrived at B", done)
		select {
		case a := <-sent:
			t.Fatalf("%s was answered while B's answers wait: %s", what, a)
		case <-time.After(300 * time.Millisecond):
		}
		mark := rp.page.mark()
		rp.link.Cut()
		a := took(t, what, sent, 20*time.Second)
		if a.Status != http.StatusGatewayTimeout || a.Code != "no_answer" || !strings.Contains(a.Error, pairName) {
			t.Fatalf("%s whose answer was lost: %s, want 504 no_answer", what, a)
		}
		rp.waitState(t, servers.StateUnreachable, 40*time.Second)
		rp.runNoTree(t, mark, 10*time.Second)
		rp.restore(t)
	}

	const name = "Made unheard"
	lost("the make", "POST", "/api/runs", map[string]any{"group": g, "name": name}, func() bool { return len(rp.b.runFolders(t)) == 1 })
	// The page was never told the run's id: it finds the run in B's tree, as it finds any other.
	tree, _ := rp.section(t)
	made := slices.DeleteFunc(slices.Clone(tree.Runs), func(v model.RunView) bool { return v.Name != name })
	if len(made) != 1 || len(tree.Runs) != 1 || made[0].Status != model.RunDraft || made[0].Group != g {
		t.Fatalf("A's tree of %s after the make whose answer was lost: %+v, want the one run, unstarted", pairName, tree.Runs)
	}
	run := made[0].ID
	rp.sameRun(t, run, g, "after the lost make")
	if v := runIn(t, rp.runOK(t, "PATCH", "/api/runs/"+run, map[string]any{"cwd": rp.repo.Dir(), "tiers": tiersOn("haiku"), "settings": map[string]any{"maxTurns": 12}})); v.Cwd != rp.repo.Dir() || v.Blocked != "" {
		t.Fatalf("the run in B's repository before its start: %+v", v)
	}

	const first = "Started unheard."
	goal := map[string]any{"goal": noteGoal(t, first, "unheard.txt", "")}
	lost("the start", "POST", "/api/runs/"+run+"/start", goal, func() bool {
		v, _ := rp.ownRun(t, run)
		return !v.Started.IsZero() && v.Status != model.RunDraft
	})
	if l, ok := rp.listedRun(t, run); !ok || l.Started.IsZero() || l.Status == model.RunDraft || l.Group != g {
		t.Fatalf("the run in A's tree after the start whose answer was lost: %+v (listed: %v)", l, ok)
	}
	rp.achieved(t, run)
	if v := rp.sameRun(t, run, g, "after the lost start"); v.Status != model.RunCompleted || v.Name != name {
		t.Fatalf("the run after the lost start: %+v", v)
	}
	// A repeat of the start, by a page that was told nothing, is B's refusal and starts nothing.
	a := rp.runDo(t, "POST", "/api/runs/"+run+"/start", goal)
	if b := rp.atB(t, "POST", "/api/runs/"+run+"/start", goal); a.Status != http.StatusConflict || a.Status != b.Status || a.Raw != b.Raw {
		t.Fatalf("a repeat of the start: through A %s, at B %s, want B's 409", a, b)
	}
	if n := rp.b.orchestrators(t, first); n != 1 {
		t.Fatalf("%d orchestrators at B, want 1", n)
	}
	if left := rp.b.runFolders(t); !slices.Equal(left, []string{run}) {
		t.Fatalf("B's run folders: %v, want %s alone", left, run)
	}
	if got := rp.repo.Git("show", "main:unheard.txt"); got != "written by the run" {
		t.Fatalf("main:unheard.txt in B's repository: %q", got)
	}
	rp.runNothingHere(t, "after the lost answers", []string{run, g}, name, first)
}
