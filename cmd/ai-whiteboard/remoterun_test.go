package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/linksim"
)

// The tests of this file are the pair of remotechat_test.go with runs: a run is a draft on A, the
// local server, with B as its server; its start is one start call to B; from then on A keeps a
// record of it and passes its routes on. B's Claude program is the scripted stand-in, so a run's
// goal says what its orchestrator and its tasks' agents do, and both servers have the git
// environment of B's scratch repository. What the page reads through A is compared with what the
// direct API client reads at B ("B's own").

// runPair is a remotePair whose B has a scratch git repository for its runs.
type runPair struct {
	*remotePair
	repo *agenttest.Repo // one commit on main: shared.txt with "colour: none" and a README
}

// connectedRunPair starts the two servers with the repository's git environment, adds B to A's
// list and waits until it is connected.
func connectedRunPair(t *testing.T, p linksim.Profile) *runPair {
	t.Helper()
	if testing.Short() {
		t.Skip("builds the binary and starts two servers")
	}
	repo := agenttest.NewRepo(t)
	repo.Write(e2eFile, e2eBefore)
	repo.Write("README.md", "a repository\n")
	repo.Commit("the start")
	rp := &runPair{remotePair: startRemotePairIn(t, p, "", repo.Env()), repo: repo}
	rp.addEntry(t)
	return rp
}

// newRepo is one more scratch repository, with one commit. Both servers are on this machine, so
// it serves as a folder of B and as a folder of A alike.
func (rp *runPair) newRepo(t *testing.T) *agenttest.Repo {
	t.Helper()
	repo, _ := e2eNoteRepo(t)
	return repo
}

// runIn decodes the run view of an answer.
func runIn(t *testing.T, a answer) model.RunView {
	t.Helper()
	var v model.RunView
	if err := json.Unmarshal([]byte(a.Raw), &v); err != nil {
		t.Fatalf("no run view in %s: %v", a, err)
	}
	return v
}

// draft makes a draft run on A in the group, puts it on B and in the folder dir, with every tier
// on one model and twelve turns at most. B has checked the folder when it returns.
func (rp *runPair) draft(t *testing.T, group, name, dir string) model.RunView {
	t.Helper()
	v := runIn(t, rp.ok(t, "POST", "/api/runs", map[string]any{"group": group, "name": name}))
	// A new run starts on the server its group last started one on: B, once a run was started here.
	if v.ID == "" || v.Status != model.RunDraft || (v.Server != "" && v.Server != rp.entry) {
		t.Fatalf("the new run: %+v", v)
	}
	if v = runIn(t, rp.ok(t, "PATCH", "/api/runs/"+v.ID, map[string]any{"server": rp.entry})); v.Server != rp.entry || v.Agent != model.Claude {
		t.Fatalf("the draft run on %s: %+v", pairName, v)
	}
	v = runIn(t, rp.ok(t, "PATCH", "/api/runs/"+v.ID, map[string]any{"cwd": dir, "tiers": tiersOn("haiku"), "settings": map[string]any{"maxTurns": 12}}))
	if v.Cwd != dir || v.FolderMissing || v.Blocked != "" || v.Server != rp.entry || v.Status != model.RunDraft {
		t.Fatalf("the draft run in %s on %s: %+v", dir, pairName, v)
	}
	return v
}

// start is the page's start of the run through A.
func (rp *runPair) start(t *testing.T, run, goal string) answer {
	t.Helper()
	return rp.do(t, "POST", "/api/runs/"+run+"/start", map[string]any{"goal": goal})
}

// startRun is draft and its start, which must answer with the started run as a run of B.
func (rp *runPair) startRun(t *testing.T, group, name, dir, goal string) string {
	t.Helper()
	d := rp.draft(t, group, name, dir)
	a := rp.start(t, d.ID, goal)
	if v := runIn(t, a); a.Status != http.StatusOK || v.ID != d.ID || v.Server != rp.entry || v.Group != group || v.Started.IsZero() || v.Status == model.RunDraft {
		t.Fatalf("the start of %s through A: %s", d.ID, a)
	}
	return d.ID
}

// throughRun is the run's view as A answers it (for a started run, a read that is passed on to B).
func (rp *runPair) throughRun(t *testing.T, run string) model.RunView {
	t.Helper()
	return runIn(t, rp.ok(t, "GET", "/api/runs/"+run, nil))
}

// listedRun is the run's view in A's snapshot.
func (rp *runPair) listedRun(t *testing.T, run string) (model.RunView, bool) {
	t.Helper()
	var st struct{ Runs []model.RunView }
	rp.a.must(t, pairPage, "GET", "/api/state", nil, &st)
	n := 0
	var found model.RunView
	for _, v := range st.Runs {
		if v.ID == run {
			found, n = v, n+1
		}
	}
	if n > 1 {
		t.Fatalf("A's snapshot lists the run %s %d times", run, n)
	}
	return found, n == 1
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

// runOf is the view in a run event.
func runOf(e seenEvent) model.RunView {
	var ev struct{ Run model.RunView }
	json.Unmarshal([]byte(e.Raw), &ev)
	return ev.Run
}

// awaitRun waits until the page was sent a run event of this run whose view ok accepts.
func (w *watcher) awaitRun(t *testing.T, mark int, limit time.Duration, run, what string, ok func(model.RunView) bool) model.RunView {
	t.Helper()
	return runOf(w.await(t, mark, limit, "run event of "+run+" with "+what, func(e seenEvent) bool {
		if e.Type != "run" {
			return false
		}
		v := runOf(e)
		return v.ID == run && ok(v)
	}))
}

// asRecord is a run view of B as A's record shows it, as a JSON value to compare: the place and
// the archive action are A's own, and what only a draft has is left out.
func asRecord(t *testing.T, v model.RunView) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	json.Unmarshal(b, &m)
	for _, k := range []string{"group", "server", "archiveOp", "draft", "tierDefaults", "dirty", "start", "was"} {
		delete(m, k)
	}
	b, _ = json.Marshal(m)
	return string(b)
}

// sameRun reads the run at B and through A until B's view is at rest, and compares the two: what
// A answers and lists is B's view with A's place and B's entry. It returns A's view.
func (rp *runPair) sameRun(t *testing.T, run, group, when string) model.RunView {
	t.Helper()
	var a, b, listed model.RunView
	for deadline := time.Now().Add(15 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		var there, again bool
		var b2 model.RunView
		b, there = rp.ownRun(t, run)
		a = rp.throughRun(t, run)
		listed, _ = rp.listedRun(t, run)
		b2, again = rp.ownRun(t, run)
		if !there || !again {
			t.Fatalf("%s: B has no run %s", when, run)
		}
		if asRecord(t, b) == asRecord(t, b2) && asRecord(t, listed) == asRecord(t, a) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: the views of %s do not come to rest: at B %s, then %s; A lists %s", when, run, asRecord(t, b), asRecord(t, b2), asRecord(t, listed))
		}
	}
	if x, y := asRecord(t, a), asRecord(t, b); x != y {
		t.Fatalf("%s: the run %s through A is not B's own:\nthrough A: %s\nat B:      %s", when, run, x, y)
	}
	for _, v := range []model.RunView{a, listed} {
		if v.Server != rp.entry || v.Group != group || v.Gone || v.Start != "" || v.Draft != nil {
			t.Fatalf("%s: the run %s on A: %+v, want it in %s on %s", when, run, v, group, pairName)
		}
	}
	return a
}

// recordFile and draftFolder are where A keeps a run of B and a run of its own.
func (rp *runPair) recordFile(run string) string {
	return filepath.Join(rp.a.home, "remote", "runs", run+".json")
}
func (rp *runPair) draftFolder(run string) string { return filepath.Join(rp.a.home, "runs", run) }

// isRecord checks that A keeps the run as a record and no longer as a run of its own.
func (rp *runPair) isRecord(t *testing.T, run, when string) {
	t.Helper()
	if _, err := os.Stat(rp.recordFile(run)); err != nil {
		t.Fatalf("%s: the record's file of %s: %v", when, run, err)
	}
	if _, err := os.Stat(rp.draftFolder(run)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("%s: the draft's folder of %s is still there (%v)", when, run, err)
	}
}

// isDraft checks that A keeps the run as a draft of its own and has no record of it.
func (rp *runPair) isDraft(t *testing.T, run, when string) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(rp.draftFolder(run), "run.json")); err != nil {
		t.Fatalf("%s: the draft's run.json of %s: %v", when, run, err)
	}
	if _, err := os.Stat(rp.recordFile(run)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("%s: A has a record's file of %s (%v)", when, run, err)
	}
}

// nothingAtB checks that B has no run folder, no group and no run in its page's state.
func (rp *runPair) nothingAtB(t *testing.T, when string) {
	t.Helper()
	if left := rp.b.runFolders(t); len(left) != 0 {
		t.Fatalf("%s: folders under B's runs: %v", when, left)
	}
	if groups := rp.b.stateGroups(t); len(groups) != 0 {
		t.Fatalf("%s: groups in B's state.json: %v", when, groups)
	}
	if st := rp.b.pageState(t); len(st.Groups) != 0 || len(st.Runs) != 0 {
		t.Fatalf("%s: B's page state: groups %+v, runs %+v", when, st.Groups, st.Runs)
	}
}

// AC43, the start: a run chosen and started through A's routes runs on B and ends with both
// colours on main of B's scratch repository. Before the start B has nothing of it; after it A
// has a record in place of the draft, and nothing of the run ever ran on A. On the good and on
// the poor link.
func TestRemoteRunStart(t *testing.T) {
	for _, link := range []struct {
		name string
		p    linksim.Profile
	}{{"good link", linksim.Good}, {"poor link", linksim.Poor}} {
		t.Run(link.name, func(t *testing.T) { remoteRunStart(t, link.p) })
	}
}

func remoteRunStart(t *testing.T, p linksim.Profile) {
	rp := connectedRunPair(t, p)
	g := rp.group(t, "Work")
	mark := rp.page.mark()
	d := rp.draft(t, g, "Both colours", rp.repo.Dir())
	if !d.Git || d.Dirty || d.Tiers.Deep.Model != "haiku" || d.Settings.MaxTurns != 12 {
		t.Fatalf("the draft run in B's repository: %+v", d)
	}
	run := d.ID
	// A set-up command, which the next new run of the group is offered again.
	if v := runIn(t, rp.ok(t, "PATCH", "/api/runs/"+run, map[string]any{"settings": map[string]any{"maxTurns": 12, "setup": "true"}})); v.Settings.Setup != "true" || v.Settings.MaxTurns != 12 {
		t.Fatalf("the draft with a set-up command: %+v", v.Settings)
	}
	// The draft is this server's alone.
	rp.isDraft(t, run, "before the start")
	rp.nothingAtB(t, "before the start")
	if _, there := rp.ownRun(t, run); there {
		t.Fatal("B has the run before its start")
	}

	started := time.Now()
	a := rp.start(t, run, e2eGoal(t))
	v := runIn(t, a)
	if a.Status != http.StatusOK || v.ID != run || v.Server != rp.entry || v.Group != g || v.Status != model.RunRunning || v.Started.IsZero() || v.Draft != nil || v.Start != "" {
		t.Fatalf("the start through A: %s", a)
	}
	t.Logf("the start through A was answered after %v", time.Since(started).Round(time.Millisecond))
	rp.isRecord(t, run, "after the start")
	rp.page.awaitRun(t, mark, 10*time.Second, run, "the start", func(v model.RunView) bool {
		return v.Server == rp.entry && v.Group == g && !v.Started.IsZero()
	})
	if left := rp.b.runFolders(t); !slices.Equal(left, []string{run}) {
		t.Fatalf("folders under B's runs: %v, want %s alone", left, run)
	}
	if st := rp.b.pageState(t); len(st.Groups) != 1 || st.Groups[0].Name != "Remote" || len(st.Runs) != 1 || st.Runs[0].ID != run || st.Runs[0].Group != st.Groups[0].ID {
		t.Fatalf("B's page state after the start: groups %+v, runs %+v", st.Groups, st.Runs)
	}

	rp.achieved(t, run)
	done := rp.page.awaitRun(t, mark, 30*time.Second, run, "the end", func(v model.RunView) bool { return v.Status == model.RunCompleted })
	if done.Outcome != model.Achieved || done.Server != rp.entry || done.Group != g || done.Counts.Done != 3 {
		t.Fatalf("the page's last run event: %+v", done)
	}
	rp.page.awaitRun(t, mark, 30*time.Second, run, "the delivery", func(v model.RunView) bool { return v.Delivery == model.DeliveryApplied })
	t.Logf("the run ended %v after its start, in %d turns", time.Since(started).Round(100*time.Millisecond), done.Turns)
	if v := rp.sameRun(t, run, g, "after the end"); v.Status != model.RunCompleted || v.Delivery != model.DeliveryApplied {
		t.Fatalf("the ended run through A: %+v", v)
	}

	// The result is in B's repository, on main, with nothing uncommitted.
	if got := rp.repo.Git("show", "main:"+e2eFile); got != e2eResolved {
		t.Fatalf("main:%s in B's repository: %q, want %q", e2eFile, got, e2eResolved)
	}
	if st := rp.repo.Git("status", "--porcelain"); st != "" {
		t.Fatalf("B's work tree is not clean:\n%s", st)
	}
	// AC43, what a new run starts with: "New run" in the group is on the server of the run started
	// last there, with that run's agent, tiers, folder and set-up command, and B checked the
	// folder. With this computer chosen instead, the folder is this computer's.
	next := runIn(t, rp.ok(t, "POST", "/api/runs", map[string]any{"group": g}))
	if next.Status != model.RunDraft || next.Server != rp.entry || next.Agent != model.Claude || next.Cwd != rp.repo.Dir() || next.FolderMissing || next.Blocked != "" ||
		next.Tiers.Deep.Model != "haiku" || next.Tiers.Standard.Model != "haiku" || next.Tiers.Light.Model != "haiku" || next.Settings.Setup != "true" || next.Settings.MaxTurns != 12 {
		t.Fatalf("the next new run of the group: %+v; want it on %s in %s, on haiku, with the set-up command", next, pairName, rp.repo.Dir())
	}
	// The creation asks B nothing; the page's read of the draft does, and has B's git facts.
	if v := rp.throughRun(t, next.ID); !v.Git || v.Dirty || v.FolderMissing || v.Blocked != "" || v.Cwd != rp.repo.Dir() || v.Server != rp.entry {
		t.Fatalf("the new run as the page reads it: %+v; want %s's facts of %s: a clean git folder", v, pairName, rp.repo.Dir())
	}
	var here struct{ DefaultCwd string }
	rp.a.must(t, pairPage, "GET", "/api/state", nil, &here)
	if here.DefaultCwd == "" || here.DefaultCwd == rp.repo.Dir() {
		t.Fatalf("A's default folder: %q", here.DefaultCwd)
	}
	if v := runIn(t, rp.ok(t, "PATCH", "/api/runs/"+next.ID, map[string]any{"server": servers.LocalID})); v.Server != "" || v.Cwd != here.DefaultCwd {
		t.Fatalf("the new run with this computer chosen: on %q in %q, want this computer and %q", v.Server, v.Cwd, here.DefaultCwd)
	}
	rp.ok(t, "DELETE", "/api/runs/"+next.ID, nil)

	// One run was started, on B; A started no agent at all.
	if n := rp.b.orchestrators(t, "Paint the shared file in both colours."); n != 1 {
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

// agentOf reads the run's detail through A, which teaches A the chats of the run's agents and
// makes the page follow the run, and returns the chat id of the first agent with this role.
func (rp *runPair) agentOf(t *testing.T, run string, role model.AgentRole) string {
	t.Helper()
	for deadline := time.Now().Add(e2eWait); ; time.Sleep(50 * time.Millisecond) {
		var d model.RunDetail
		a := rp.ok(t, "GET", "/api/runs/"+run+"/detail", nil)
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

// sameBytes reads path at B and through A until both answers are the same bytes with the status
// 200: what A hands on is what B answered. It returns them.
func (rp *runPair) sameBytes(t *testing.T, path, when string) string {
	t.Helper()
	var a, b answer
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		b = rp.atB(t, "GET", path, nil)
		a = rp.do(t, "GET", path, nil)
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

// sameEvents waits until the page on A and the direct client of B were sent the same events of
// this type that hold the texts, byte for byte and in the same order, and at least one that
// last accepts as the final one. Each side is counted from its own mark: both followed the item
// while nothing was sent. It returns how many there were.
func (rp *runPair) sameEvents(t *testing.T, direct *watcher, pm, dm int, last func(raw string) bool, typ string, texts ...string) int {
	t.Helper()
	var p, d []string
	for deadline := time.Now().Add(20 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		p, d = rp.page.rawsOf(pm, typ, texts...), direct.rawsOf(dm, typ, texts...)
		if len(p) > 0 && slices.Equal(p, d) && last(p[len(p)-1]) {
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

// AC43, the run table of flow 5.2: one case per row of what each action on a remote run does,
// through A's routes, with B's own view beside it.
func TestRemoteRunActions(t *testing.T) {
	rp := connectedRunPair(t, linksim.Good)
	g, other := rp.group(t, "Work"), rp.group(t, "Other")
	direct := rp.direct(t)
	// A repository for each run, made by the test and not by a case: B still tidies a run's
	// branches when the case that ran it has ended.
	heldRepo, slowRepo, manualRepo, readRepo := rp.newRepo(t), rp.newRepo(t), rp.newRepo(t), rp.newRepo(t)

	// A draft is this server's alone: B is asked about its folder and is told nothing else.
	t.Run("the draft is local only", func(t *testing.T) {
		d := rp.draft(t, g, "Only here", rp.repo.Dir())
		rp.ok(t, "PUT", "/api/runs/"+d.ID+"/draft", map[string]any{"text": "a goal in the making"})
		if v := runIn(t, rp.ok(t, "PATCH", "/api/runs/"+d.ID, map[string]any{"name": "Still only here"})); v.Name != "Still only here" || v.Server != rp.entry {
			t.Fatalf("the renamed draft: %+v", v)
		}
		v, ok := rp.listedRun(t, d.ID)
		if !ok || v.Status != model.RunDraft || v.Server != rp.entry || v.Group != g || v.Draft == nil || v.Draft.Text != "a goal in the making" || !v.Git {
			t.Fatalf("the draft in A's list: %+v (listed: %v)", v, ok)
		}
		rp.isDraft(t, d.ID, "the draft")
		rp.nothingAtB(t, "with a draft on A")
		if _, there := rp.ownRun(t, d.ID); there {
			t.Fatal("B has the draft run")
		}
		// A chat cannot be made on it: its chats will be on the run's server.
		rp.refused(t, http.StatusConflict, "run_not_started", "POST", "/api/chats", map[string]any{"agent": "claude", "run": d.ID})
		rp.ok(t, "DELETE", "/api/runs/"+d.ID, nil)
		if _, ok := rp.listedRun(t, d.ID); ok {
			t.Fatal("the deleted draft is still listed")
		}
		rp.nothingAtB(t, "after the draft's delete")
	})

	// A run that stays running: its one task only waits.
	skip := rp.b.fakeMessages(t)
	held := rp.startRun(t, g, "Held", heldRepo.Dir(), e2eHeldGoal(t))
	rp.b.waitFakeMessage(t, skip, e2eOnTask)
	there, _ := rp.ownRun(t, held)
	if there.Group == "" || there.Group == g || there.Group == other {
		t.Fatalf("the run's group at B: %q", there.Group)
	}

	t.Run("move", func(t *testing.T) {
		mark := rp.page.mark()
		if v := runIn(t, rp.ok(t, "PATCH", "/api/runs/"+held, map[string]any{"group": other})); v.Group != other || v.Server != rp.entry {
			t.Fatalf("the moved run: %+v", v)
		}
		rp.page.awaitRun(t, mark, 5*time.Second, held, "the new group", func(v model.RunView) bool { return v.Group == other })
		// The place is A's own: B's view keeps its group, and B was told nothing.
		if b, _ := rp.ownRun(t, held); b.Group != there.Group {
			t.Fatalf("the run's group at B after the move on A: %q, was %q", b.Group, there.Group)
		}
		rp.sameRun(t, held, other, "after the move")
		rp.refused(t, http.StatusNotFound, "", "PATCH", "/api/runs/"+held, map[string]any{"group": "g_nosuchgr"})
		rp.sameRun(t, held, other, "after a move to no group")
	})

	t.Run("rename", func(t *testing.T) {
		mark := rp.page.mark()
		if v := runIn(t, rp.ok(t, "PATCH", "/api/runs/"+held, map[string]any{"name": "Renamed there"})); v.Name != "Renamed there" || v.Group != other {
			t.Fatalf("the renamed run: %+v", v)
		}
		rp.page.awaitRun(t, mark, 5*time.Second, held, "the new name", func(v model.RunView) bool { return v.Name == "Renamed there" })
		if b, _ := rp.ownRun(t, held); b.Name != "Renamed there" || !b.UserNamed {
			t.Fatalf("the run at B after the rename: %+v", b)
		}
		// What a started run's choices are is fixed: A refuses them and sends nothing.
		for _, body := range []map[string]any{{"cwd": rp.repo.Dir()}, {"server": servers.LocalID}, {"agent": "claude"}, {"settings": map[string]any{"maxTurns": 3}}} {
			if a := rp.do(t, "PATCH", "/api/runs/"+held, body); a.Status != http.StatusConflict {
				t.Fatalf("the change %v of a started run: %s, want 409", body, a)
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
		rp.ok(t, "GET", "/api/runs/"+slow+"/detail", nil) // the page follows the run
		if a := rp.atB(t, "GET", "/api/runs/"+slow+"/detail", nil); a.Status != http.StatusOK {
			t.Fatalf("the detail at B: %s", a)
		}
		pm, dm = rp.page.mark(), direct.mark()
		mark := rp.page.mark()
		began := time.Now()
		v := runIn(t, rp.ok(t, "POST", "/api/runs/"+slow+"/stop", nil))
		if (v.Status != model.RunStopping && v.Status != model.RunStopped) || v.Server != rp.entry || v.Group != g {
			t.Fatalf("the answer of the stop through A: %+v", v)
		}
		stopped := rp.page.awaitRun(t, mark, 30*time.Second, slow, "stopped", func(v model.RunView) bool { return v.Status == model.RunStopped })
		if stopped.Reason == "" || stopped.Server != rp.entry {
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
		if v := runIn(t, rp.ok(t, "POST", "/api/runs/"+slow+"/resume", nil)); v.Status != model.RunRunning || v.Reason != "" || v.Server != rp.entry {
			t.Fatalf("the answer of the resume through A: %+v", v)
		}
		rp.achieved(t, slow)
		rp.page.awaitRun(t, mark, 30*time.Second, slow, "the delivery", func(v model.RunView) bool {
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
		t.Logf("the page on A and the direct client of B were each sent the same %d run_detail events, up to version %d", n, d.Version)
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
		// A text the run does not have is B's refusal, and says nothing about the run itself.
		for _, path := range []string{"/tasks/T99/brief", "/tasks/T01/attempts/7/report", "/notes/99"} {
			a, b := rp.do(t, "GET", "/api/runs/"+slow+path, nil), rp.atB(t, "GET", "/api/runs/"+slow+path, nil)
			if a.Status != b.Status || a.Raw != b.Raw || a.Status < 400 {
				t.Errorf("%s: through A %s, at B %s", path, a, b)
			}
		}
		if v, _ := rp.listedRun(t, slow); v.Gone {
			t.Fatal("the run is marked gone after a text it does not have")
		}
	})

	// A run whose result waits for the person: the apply through A brings it into B's folder.
	t.Run("apply with applyResult manual", func(t *testing.T) {
		repo := manualRepo
		base := repo.Git("rev-parse", "main")
		d := rp.draft(t, g, "Apply by hand", repo.Dir())
		if v := runIn(t, rp.ok(t, "PATCH", "/api/runs/"+d.ID, map[string]any{"settings": map[string]any{"maxTurns": 12, "applyResult": "manual"}})); v.Settings.ApplyResult != "manual" {
			t.Fatalf("the draft with the manual apply: %+v", v.Settings)
		}
		mark := rp.page.mark()
		if a := rp.start(t, d.ID, noteGoal(t, "Apply it by hand.", "manual.txt", "")); a.Status != http.StatusOK {
			t.Fatalf("the start: %s", a)
		}
		run := d.ID
		if b := rp.achieved(t, run); b.Settings.ApplyResult != "manual" {
			t.Fatalf("the run's settings at B: %+v", b.Settings)
		}
		rp.page.awaitRun(t, mark, 30*time.Second, run, "the pending delivery", func(v model.RunView) bool { return v.Delivery == model.DeliveryPending })
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
		a := rp.ok(t, "POST", "/api/runs/"+run+"/apply", map[string]any{})
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
		rp.page.awaitRun(t, mark, 10*time.Second, run, "the applied delivery", func(v model.RunView) bool { return v.Delivery == model.DeliveryApplied })
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
		for _, c := range []struct{ method, path string }{
			{"POST", "/messages"}, {"POST", "/interrupt"}, {"PATCH", ""}, {"POST", "/archive"}, {"DELETE", ""},
		} {
			if a := rp.do(t, c.method, "/api/chats/"+agent+c.path, map[string]any{"text": "not for an agent"}); a.Status != http.StatusConflict || !strings.Contains(a.Error, "one of a run's agents") {
				t.Fatalf("%s %s of a run agent's chat: %s, want 409", c.method, c.path, a)
			}
		}
		rp.achieved(t, run)
		n := rp.sameEvents(t, direct, pm, dm, func(raw string) bool { return strings.Contains(raw, `"kind":"end"`) }, "chat_items", agent)
		th := rp.same(t, agent, "after the run")
		if len(th) <= len(before) || !th.has(t, "Write read.txt") {
			t.Fatalf("the agent's thread after the run: %s", joinThread(th))
		}
		rp.sameBytes(t, "/api/chats/"+agent, "after the run")
		// The agent's chat is no chat of A's list, and A keeps no record of it.
		if _, ok := rp.listed(t, agent); ok {
			t.Fatal("the agent's chat is in A's list of chats")
		}
		if _, err := os.Stat(filepath.Join(rp.a.home, "remote", "chats", agent+".json")); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("A keeps a chat record of the agent's chat (%v)", err)
		}
		t.Logf("the page on A and the direct client of B were each sent the same %d chat_items events of the agent's chat", n)
	})

	// "+" on the run: a chat of the person on the run, made on A and started at B on the run.
	var chat string
	t.Run("plus on the run", func(t *testing.T) {
		var v model.ChatView
		rp.a.must(t, pairPage, "POST", "/api/chats", map[string]any{"agent": "claude", "run": held}, &v)
		if v.ID == "" || v.Run != held || v.Server != rp.entry || v.Cwd != heldRepo.Dir() || v.Locked {
			t.Fatalf("the chat made on the run: %+v", v)
		}
		chat = v.ID
		rp.send(t, chat, "A word on the run.")
		if b, ok := rp.ownView(t, chat); !ok || b.Run != held || !b.Locked || b.Cwd != heldRepo.Dir() {
			t.Fatalf("the chat at B: %+v (there: %v)", b, ok)
		}
		rp.turns(t, chat, 1)
		if th := rp.same(t, chat, "after its first turn"); th.users(t, "A word on the run.") != 1 {
			t.Fatalf("the thread of the chat on the run: %s", joinThread(th))
		}
		if l, ok := rp.listed(t, chat); !ok || l.Run != held || l.Server != rp.entry || !l.Locked {
			t.Fatalf("the chat on the run in A's list: %+v (listed: %v)", l, ok)
		}
	})

	t.Run("archive of a live run", func(t *testing.T) {
		if b, _ := rp.ownRun(t, held); !b.Status.Live() {
			t.Fatalf("the run is not live before its archive: %+v", b)
		}
		mark := rp.page.mark()
		began := time.Now()
		rp.ok(t, "POST", "/api/runs/"+held+"/archive", nil)
		// The mark shows at once on A, with A's own action.
		shown := rp.page.awaitRun(t, mark, 5*time.Second, held, "the archived mark", func(v model.RunView) bool { return v.Archived })
		if shown.Op == "" || shown.Group != other {
			t.Fatalf("the page's event of the archive: %+v", shown)
		}
		// B stopped the run and archived it, and the chats on it with it.
		b := rp.awaitOwnRun(t, held, "archived and halted", func(v model.RunView) bool { return v.Archived && !v.Status.Live() })
		if b.Status != model.RunStopped {
			t.Fatalf("the archived run at B: %+v", b)
		}
		t.Logf("the live run was stopped and archived at B %v after the archive through A", time.Since(began).Round(time.Millisecond))
		eventually(t, 10*time.Second, "the chat on the run is archived on both sides", func() bool {
			bc, _ := rp.ownView(t, chat)
			ac, ok := rp.listed(t, chat)
			return ok && bc.Archived && ac.Archived
		})
		eventually(t, 10*time.Second, "A's record has the stopped run", func() bool {
			v, _ := rp.listedRun(t, held)
			return v.Archived && v.Status == model.RunStopped && v.Op == shown.Op
		})
		if v := rp.throughRun(t, held); !v.Archived || v.Op != shown.Op || v.Op == b.Op {
			t.Fatalf("the archived run through A: %+v (B's action is %q)", v, b.Op)
		}
	})

	t.Run("unarchive", func(t *testing.T) {
		mark := rp.page.mark()
		rp.ok(t, "POST", "/api/runs/"+held+"/unarchive", nil)
		rp.page.awaitRun(t, mark, 5*time.Second, held, "no archived mark", func(v model.RunView) bool { return !v.Archived })
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
		rp.ok(t, "DELETE", "/api/runs/"+held, nil)
		gone := rp.page.awaitEvent(t, mark, 5*time.Second, "run_removed", held)
		t.Logf("the run was deleted %v after the delete through A", time.Since(began).Round(time.Millisecond))
		// The chat records on the run went first.
		if evs := rp.page.of(mark, "chat_removed", chat); len(evs) != 1 || evs[0].At.After(gone.At) {
			t.Fatalf("the chat_removed events of the chat on the run: %v", evs)
		}
		if _, there := rp.ownRun(t, held); there {
			t.Fatal("B still has the deleted run")
		}
		if _, there := rp.ownView(t, chat); there {
			t.Fatal("B still has the chat on the deleted run")
		}
		if _, ok := rp.listedRun(t, held); ok {
			t.Fatal("the deleted run is still in A's list")
		}
		if _, ok := rp.listed(t, chat); ok {
			t.Fatal("the chat on the deleted run is still in A's list")
		}
		for _, file := range []string{rp.recordFile(held), filepath.Join(rp.a.home, "remote", "chats", chat+".json")} {
			if _, err := os.Stat(file); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("%s after the delete: %v", file, err)
			}
		}
		for _, path := range []string{"/api/runs/" + held, "/api/runs/" + held + "/detail", "/api/chats/" + chat} {
			if a := rp.do(t, "GET", path, nil); a.Status != http.StatusNotFound {
				t.Fatalf("GET %s through A after the delete: %s", path, a)
			}
		}
		if left := heldRepo.Git("for-each-ref", "--format=%(refname:short)", "refs/heads/aiwb/"); left != "" {
			t.Fatalf("branches of the deleted run in B's repository:\n%s", left)
		}
		if left := rp.b.runFolders(t); slices.Contains(left, held) {
			t.Fatalf("B's run folders after the delete: %v", left)
		}
	})
}

// restore lets the link carry again after a stall or a cut and waits for A's connection and the
// page's server_back. It returns how long the connection took.
func (rp *runPair) restore(t *testing.T) time.Duration {
	t.Helper()
	mark := rp.page.mark()
	rp.link.Stall(false, false)
	rp.link.Uncut()
	d := rp.back(t, 60*time.Second)
	rp.page.awaitEvent(t, mark, 10*time.Second, "server_back", rp.entry)
	return d
}

// unconfirmed checks that the run is a draft on A whose start got no answer: listed and answered
// so, with its server and its choices fixed.
func (rp *runPair) unconfirmed(t *testing.T, run, when string) {
	t.Helper()
	began := time.Now()
	a := rp.ok(t, "GET", "/api/runs/"+run, nil)
	if v := runIn(t, a); v.Start != "unconfirmed" || v.Status != model.RunDraft || v.Server != rp.entry || !v.Started.IsZero() {
		t.Fatalf("%s: the run through A: %s, want a draft whose start is unconfirmed", when, a)
	}
	// Nothing is asked of B while the start is not known: the read answers at once.
	if d := time.Since(began); d > 2*time.Second {
		t.Fatalf("%s: the read of the unconfirmed draft took %v", when, d)
	}
	if v, ok := rp.listedRun(t, run); !ok || v.Start != "unconfirmed" || v.Status != model.RunDraft {
		t.Fatalf("%s: the run in A's list: %+v (listed: %v)", when, v, ok)
	}
	rp.isDraft(t, run, when)
	for _, body := range []map[string]any{{"server": servers.LocalID}, {"cwd": rp.work}, {"agent": "claude"}, {"tiers": tiersOn("sonnet")}, {"settings": map[string]any{"maxTurns": 3}}} {
		rp.refused(t, http.StatusConflict, "start_unconfirmed", "PATCH", "/api/runs/"+run, body)
	}
}

// AC43, a start that gets no answer: B's answers wait, so the start call arrives, B starts the
// run, and A is told nothing. The start answers 504 start_unconfirmed, the draft says so and its
// server cannot be changed. After a cut and the return the run is a record on A and one run at
// B: once with the start repeated twice by the page, once with no repeat at all.
func TestRemoteRunNoAnswer(t *testing.T) {
	rp := connectedRunPair(t, linksim.Good)
	g := rp.group(t, "Work")
	repeated, settled := rp.newRepo(t), rp.newRepo(t)

	// The limits run out with the link still up: 45 s for the start call, then the settle read.
	t.Run("repeated twice", func(t *testing.T) {
		const first = "Started with no answer, then repeated."
		goal := noteGoal(t, first, "repeated.txt", "")
		d := rp.draft(t, g, "No answer", repeated.Dir())
		run := d.ID
		rp.link.Stall(true, false) // what B sends waits
		began := time.Now()
		sent := rp.later("POST", "/api/runs/"+run+"/start", map[string]any{"goal": goal})
		rp.awaitOwnRun(t, run, "started", func(v model.RunView) bool { return v.Status != model.RunDraft })
		// While the start call is under way the draft can be read: the check of its folder has a
		// short limit of its own.
		read := time.Now()
		if v := runIn(t, rp.ok(t, "GET", "/api/runs/"+run, nil)); v.Status != model.RunDraft || v.Server != rp.entry {
			t.Fatalf("the draft while its start is under way: %+v", v)
		}
		readTook := time.Since(read)
		if readTook > 8*time.Second {
			t.Fatalf("the read of the draft while its start is under way took %v", readTook)
		}
		a := took(t, "the start", sent, 80*time.Second)
		if a.Status != http.StatusGatewayTimeout || a.Code != "start_unconfirmed" || !strings.Contains(a.Error, pairName) {
			t.Fatalf("the start whose answer never came: %s, want 504 start_unconfirmed", a)
		}
		t.Logf("504 start_unconfirmed %v after the start (the read of the draft meanwhile took %v); %s is %q", time.Since(began).Round(100*time.Millisecond),
			readTook.Round(time.Millisecond), pairName, rp.entryView(t).State)
		rp.unconfirmed(t, run, "after the lost answer")

		rp.link.Cut()
		rp.waitState(t, servers.StateUnreachable, 40*time.Second)
		// A repeat while B cannot be reached sends nothing and settles nothing.
		rp.refused(t, http.StatusServiceUnavailable, "server_unreachable", "POST", "/api/runs/"+run+"/start", map[string]any{"goal": goal})
		rp.unconfirmed(t, run, "after a repeat without a connection")

		// The return, with the page repeating its start as soon as the link carries again: the
		// first repeat that reaches B, or the snapshot of the connection, makes the run a record.
		mark := rp.page.mark()
		rp.link.Stall(false, false)
		rp.link.Uncut()
		var how []string
		for i, deadline := 0, time.Now().Add(60*time.Second); i < 2; {
			a := rp.start(t, run, goal)
			if a.Status == http.StatusServiceUnavailable && time.Now().Before(deadline) {
				time.Sleep(50 * time.Millisecond)
				continue
			}
			v := runIn(t, a)
			if a.Status != http.StatusOK || v.ID != run || v.Server != rp.entry || v.Group != g || v.Started.IsZero() || v.Start != "" {
				t.Fatalf("repeat %d of the start: %s", i+1, a)
			}
			how = append(how, string(v.Status))
			i++
		}
		rp.page.awaitRun(t, mark, 10*time.Second, run, "the start", func(v model.RunView) bool { return v.Server == rp.entry && !v.Started.IsZero() && v.Start == "" })
		rp.isRecord(t, run, "after the repeats")
		rp.back(t, 30*time.Second)
		rp.achieved(t, run)
		if v := rp.sameRun(t, run, g, "after the repeats"); v.Status != model.RunCompleted {
			t.Fatalf("the run after the repeats: %+v", v)
		}
		if n := rp.b.orchestrators(t, first); n != 1 {
			t.Fatalf("%d orchestrators at B after the start and two repeats, want 1", n)
		}
		if left := rp.b.runFolders(t); !slices.Equal(left, []string{run}) {
			t.Fatalf("B's run folders: %v, want %s alone", left, run)
		}
		if got := repeated.Git("show", "main:repeated.txt"); got != "written by the run" {
			t.Fatalf("main:repeated.txt in B's repository: %q", got)
		}
		t.Logf("two repeats after the return answered 200 (%v); one orchestrator at B, the run a record on A", how)
	})

	// The link is cut while the start call waits: the call ends at once, and the run is settled
	// by the snapshot of the next connection with no repeat by anyone.
	t.Run("without a repeat", func(t *testing.T) {
		const first = "Started with no answer, never repeated."
		d := rp.draft(t, g, "Settled alone", settled.Dir())
		run := d.ID
		rp.link.Stall(true, false)
		sent := rp.later("POST", "/api/runs/"+run+"/start", map[string]any{"goal": noteGoal(t, first, "settled.txt", "<<sleep 3>>")})
		rp.awaitOwnRun(t, run, "started", func(v model.RunView) bool { return v.Status != model.RunDraft })
		select {
		case a := <-sent:
			t.Fatalf("the start was answered while B's answers wait: %s", a)
		case <-time.After(300 * time.Millisecond):
		}
		rp.link.Cut()
		a := took(t, "the start", sent, 20*time.Second)
		if a.Status != http.StatusGatewayTimeout || a.Code != "start_unconfirmed" || !strings.Contains(a.Error, pairName) {
			t.Fatalf("the start whose answer was lost: %s, want 504 start_unconfirmed", a)
		}
		rp.unconfirmed(t, run, "after the lost answer")
		mark := rp.page.mark()
		back := rp.restore(t)
		v := rp.page.awaitRun(t, mark, 10*time.Second, run, "the start", func(v model.RunView) bool { return !v.Started.IsZero() })
		if v.Server != rp.entry || v.Group != g || v.Start != "" || v.Draft != nil {
			t.Fatalf("the run's event at the reconnect: %+v", v)
		}
		rp.isRecord(t, run, "after the reconnect")
		rp.achieved(t, run)
		rp.sameRun(t, run, g, "after the reconnect")
		if n := rp.b.orchestrators(t, first); n != 1 {
			t.Fatalf("%d orchestrators at B, want 1", n)
		}
		if got := settled.Git("show", "main:settled.txt"); got != "written by the run" {
			t.Fatalf("main:settled.txt in B's repository: %q", got)
		}
		t.Logf("settled as started at the reconnect, %v after the link was back, with no repeat; one orchestrator at B", back.Round(time.Millisecond))
	})
}

// AC43, the refusals: a start call that B refuses leaves the draft a draft of this server, with
// B's reason in the answer, and leaves nothing at B: no run folder and no group "Remote".
func TestRemoteRunRefusals(t *testing.T) {
	rp := connectedRunPair(t, linksim.Good)
	g := rp.group(t, "Work")
	// stays checks the draft after a refused start.
	stays := func(t *testing.T, run, when string) model.RunView {
		t.Helper()
		v := rp.throughRun(t, run) // B is asked about the folder again
		if v.Status != model.RunDraft || v.Start != "" || v.Server != rp.entry || v.Group != g || !v.Started.IsZero() {
			t.Fatalf("%s: the draft: %+v", when, v)
		}
		if l, ok := rp.listedRun(t, run); !ok || l.Status != model.RunDraft || l.Server != rp.entry {
			t.Fatalf("%s: the draft in A's list: %+v (listed: %v)", when, l, ok)
		}
		rp.isDraft(t, run, when)
		rp.nothingAtB(t, when)
		if _, there := rp.ownRun(t, run); there {
			t.Fatalf("%s: B has the run", when)
		}
		return v
	}

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
		a := rp.start(t, d.ID, noteGoal(t, first, "never.txt", ""))
		if a.Status != http.StatusConflict || a.Code != "folder_missing" || !strings.Contains(a.Error, dir) {
			t.Fatalf("the start in a folder that is gone: %s, want 409 folder_missing with the folder", a)
		}
		if v := stays(t, d.ID, "after the refusal"); !v.FolderMissing {
			t.Fatalf("the draft after the refusal: %+v, want the folder missing", v)
		}
		// A change to a folder B does not have is refused by B's check, with the folder.
		if a := rp.refused(t, http.StatusConflict, "folder_missing", "PATCH", "/api/runs/"+d.ID, map[string]any{"cwd": dir + "-other"}); !strings.Contains(a.Error, dir+"-other") {
			t.Fatalf("the change to a missing folder: %s", a)
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
		if a.Status != http.StatusConflict || (a.Code != "blocked" && a.Code != "agent_missing") || a.Error == "" {
			t.Fatalf("the start with B's Claude program gone: %s, want 409 with B's reason", a)
		}
		// B's own answer to a start call says the same.
		status, own, raw := rp.b.startCall(t, pairDirect, model.NewID("r_"), apiStartBody(rp.repo.Dir(), goal))
		if status != a.Status || own.Code != a.Code || own.Error != a.Error || own.Started {
			t.Fatalf("B's own refusal: %d %s; through A: %s", status, raw, a)
		}
		v := stays(t, d.ID, "after the refusal")
		t.Logf("the refusal through A: %d %s %q; the draft's blocked: %q", a.Status, a.Code, a.Error, v.Blocked)
		if n := rp.b.orchestrators(t, first); n != 0 {
			t.Fatalf("%d orchestrators at B", n)
		}
		// With the program back the same draft starts, under the same id.
		if err := os.Rename(away, rp.b.in.claude); err != nil {
			t.Fatal(err)
		}
		var again answer
		eventually(t, 30*time.Second, "the start with the program back", func() bool {
			again = rp.start(t, d.ID, goal)
			return again.Status == http.StatusOK
		})
		if v := runIn(t, again); v.ID != d.ID || v.Server != rp.entry || v.Started.IsZero() {
			t.Fatalf("the start with the program back: %s", again)
		}
		rp.isRecord(t, d.ID, "after the start")
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
			if v.Status != model.RunCompleted || v.Outcome != model.Achieved || v.Server != "" {
				t.Fatalf("the run %s of this computer ended as %+v", run, v)
			}
			return v
		}
		if time.Now().After(deadline) {
			t.Fatalf("the run %s of this computer is still %s", run, v.Status)
		}
	}
}

// AC43 and AC12, the outage: B is stopped for 60 s while a task of a run works, and in a second
// run restarted at once. The record stays listed as last seen, a stop and a read answer at once
// that the server is not connected, and a run of this computer works meanwhile. After the
// return B goes on with the run by itself; the record's view and the detail through A are B's.
func TestRemoteRunOutage(t *testing.T) {
	rp := connectedRunPair(t, linksim.Good)
	g := rp.group(t, "Work")
	hereRepo := rp.newRepo(t) // for the runs of this computer
	ended := rp.startRun(t, g, "Ended before", rp.repo.Dir(), noteGoal(t, "Ended before the outage.", "ended.txt", ""))
	rp.achieved(t, ended)
	rp.sameRun(t, ended, g, "before the outage")

	down := func(t *testing.T, name string, repo *agenttest.Repo, away time.Duration) {
		file := name + ".txt"
		skip := rp.b.fakeMessages(t)
		run := rp.startRun(t, g, "Through "+name, repo.Dir(), noteGoal(t, "Through the outage: "+name+".", file, "<<sleep 6>>"))
		rp.b.waitFakeMessage(t, skip, e2eOnTask)
		rp.ok(t, "GET", "/api/runs/"+run+"/detail", nil) // the run is on screen
		seen := rp.sameRun(t, run, g, "before the outage")
		mark := rp.page.mark()
		rp.b.stop(t)
		exited := time.Now()
		rp.waitState(t, servers.StateUnreachable, 2*time.Second)
		rp.page.await(t, mark, 2*time.Second, "server_state event: unreachable", func(e seenEvent) bool {
			return e.holds("server_state", rp.entry, `"unreachable"`)
		})

		// The records stay listed; what is passed on answers at once; nothing is marked gone.
		whileAway := func(when string) {
			t.Helper()
			if v := rp.entryView(t); v.State != servers.StateUnreachable {
				t.Fatalf("%s: %s is %q", when, pairName, v.State)
			}
			for _, id := range []string{run, ended} {
				if v, ok := rp.listedRun(t, id); !ok || v.Server != rp.entry || v.Group != g || v.Gone || v.Started.IsZero() {
					t.Fatalf("%s: the run %s in A's list: %+v (listed: %v)", when, id, v, ok)
				}
			}
			if v, _ := rp.listedRun(t, run); v.Name != seen.Name || v.Cwd != seen.Cwd || v.Status == model.RunDraft {
				t.Fatalf("%s: the run in A's list: %+v, last seen as %+v", when, v, seen)
			}
			start := time.Now()
			for _, c := range []struct{ method, path string }{
				{"POST", "/stop"}, {"POST", "/resume"}, {"GET", "/detail"}, {"GET", ""}, {"GET", "/goal"}, {"DELETE", ""},
			} {
				if a := rp.refused(t, http.StatusServiceUnavailable, "server_unreachable", c.method, "/api/runs/"+run+c.path, nil); !strings.Contains(a.Error, pairName) {
					t.Fatalf("%s: %s %s: %s", when, c.method, c.path, a)
				}
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
		rp.page.awaitEvent(t, mark, 10*time.Second, "server_back", rp.entry)
		// The page reads the run on screen again at server_back, and follows it from there.
		rp.ok(t, "GET", "/api/runs/"+run+"/detail", nil)
		rp.achieved(t, run) // B went on with it by itself
		done := rp.page.awaitRun(t, mark, 30*time.Second, run, "the end", func(v model.RunView) bool {
			return v.Status == model.RunCompleted && v.Delivery == model.DeliveryApplied
		})
		if done.Server != rp.entry || done.Group != g || done.Gone {
			t.Fatalf("the page's event of the end: %+v", done)
		}
		rp.sameRun(t, run, g, "after the return")
		rp.sameRun(t, ended, g, "after the return")
		var d model.RunDetail
		if err := json.Unmarshal([]byte(rp.sameBytes(t, "/api/runs/"+run+"/detail", "after the return")), &d); err != nil || d.Status != model.RunCompleted || len(d.Stops) != 1 || d.Stops[0].ResumedAt == 0 {
			t.Fatalf("the detail after the return: %v, status %s, stops %+v", err, d.Status, d.Stops)
		}
		rp.page.awaitEvent(t, mark, 10*time.Second, "run_detail", run, fmt.Sprintf(`"version":%d`, d.Version))
		if got := repo.Git("show", "main:"+file); got != "written by the run" {
			t.Fatalf("main:%s in B's repository: %q", file, got)
		}
		t.Logf("AC12, %s: connected again %v after B answered (%v after B's process was gone); the run ended at version %d and the page was sent it",
			name, back.Round(time.Millisecond), time.Since(exited).Round(time.Millisecond), d.Version)
	}

	stoppedRepo, restartedRepo := rp.newRepo(t), rp.newRepo(t)
	t.Run("stopped for 60 s", func(t *testing.T) { down(t, "stopped", stoppedRepo, 60*time.Second) })
	t.Run("restarted", func(t *testing.T) { down(t, "restarted", restartedRepo, 0) })
}

// AC34, the run half: a chat made on a remote run is on the run's server and in the run's
// folder, and no other server can be chosen for it; its first message makes it at B on the run;
// and A's defaults are what they were.
func TestRemoteRunChat(t *testing.T) {
	rp := connectedRunPair(t, linksim.Good)
	g := rp.group(t, "Work")
	skip := rp.b.fakeMessages(t)
	run := rp.startRun(t, g, "A run to talk about", rp.repo.Dir(), e2eHeldGoal(t))
	rp.b.waitFakeMessage(t, skip, e2eOnTask)
	defaults := func() string {
		t.Helper()
		var st struct{ Defaults json.RawMessage }
		rp.a.must(t, pairPage, "GET", "/api/state", nil, &st)
		return string(st.Defaults)
	}
	// sticky is the group's sticky server in those defaults; goes is where "+" in the group puts
	// a new chat.
	sticky := func(raw string) string {
		t.Helper()
		var d model.Defaults
		if err := json.Unmarshal([]byte(raw), &d); err != nil {
			t.Fatalf("A's defaults: %v in %s", err, raw)
		}
		return d.Groups[g].Server
	}
	goes := func() string {
		t.Helper()
		var made model.ChatView
		rp.a.must(t, pairPage, "POST", "/api/chats", map[string]any{"group": g}, &made)
		rp.ok(t, "DELETE", "/api/chats/"+made.ID, nil)
		return made.Server
	}
	// The run's start made B the group's server. A chat of this computer in the group, with one
	// message, makes it this computer again: a chat on the run that recorded B would show.
	if s := sticky(defaults()); s == "" || s == servers.LocalID {
		t.Fatalf("the group's sticky server after the run's start: %q, want %s's", s, pairName)
	}
	if on := goes(); on != rp.entry {
		t.Fatalf("a new chat of the group after the run's start is on %q, want %s", on, pairName)
	}
	var local model.ChatView
	rp.a.must(t, pairPage, "POST", "/api/chats", map[string]any{"agent": "claude", "group": g, "server": servers.LocalID}, &local)
	if local.ID == "" || local.Server != "" {
		t.Fatalf("the chat of this computer: %+v", local)
	}
	rp.ok(t, "PATCH", "/api/chats/"+local.ID, map[string]any{"cwd": rp.work})
	rp.send(t, local.ID, "here first")
	eventually(t, 20*time.Second, "the reply of this computer's agent", func() bool {
		th, _ := threadOf(rp.ok(t, "GET", "/api/chats/"+local.ID+"/items", nil).Raw)
		return th.ends() >= 1
	})
	before := defaults()
	if !strings.Contains(before, rp.repo.Dir()) {
		t.Fatalf("A's defaults after the run's start do not hold its folder: %s", before)
	}
	if s := sticky(before); s != servers.LocalID {
		t.Fatalf("the group's sticky server after a message on this computer: %q, want %q", s, servers.LocalID)
	}
	if on := goes(); on != "" {
		t.Fatalf("a new chat of the group after a message on this computer is on %q, want this computer", on)
	}
	if again := defaults(); again != before {
		t.Fatalf("a chat made and deleted unstarted changed A's defaults:\nbefore: %s\nafter:  %s", before, again)
	}

	var v model.ChatView
	rp.a.must(t, pairPage, "POST", "/api/chats", map[string]any{"agent": "claude", "run": run}, &v)
	if v.ID == "" || v.Run != run || v.Server != rp.entry || v.Cwd != rp.repo.Dir() || v.Locked || v.Model != "haiku" {
		t.Fatalf("the chat made on the run: %+v; want it on %s, in the run's folder, with the deep tier's model", v, pairName)
	}
	chat := v.ID
	// Its server is the run's: this computer cannot be chosen, and neither can a server that is
	// not in the list.
	rp.refused(t, http.StatusConflict, "server_fixed", "PATCH", "/api/chats/"+chat, map[string]any{"server": servers.LocalID})
	if a := rp.do(t, "PATCH", "/api/chats/"+chat, map[string]any{"server": "s_000000000000"}); a.Status < 400 {
		t.Fatalf("the chat on the run moved to a server of no entry: %s", a)
	}
	if a := rp.do(t, "POST", "/api/chats", map[string]any{"agent": "claude", "run": run, "server": servers.LocalID}); a.Status == http.StatusOK {
		var made model.ChatView
		json.Unmarshal([]byte(a.Raw), &made)
		if made.Server != rp.entry {
			t.Fatalf("a chat made on the run with this computer as its server: %s", a)
		}
		rp.ok(t, "DELETE", "/api/chats/"+made.ID, nil)
	}
	if got := rp.view(t, chat); got.Server != rp.entry || got.Run != run || got.Locked {
		t.Fatalf("the chat after the refused changes: %+v", got)
	}
	if _, there := rp.ownView(t, chat); there {
		t.Fatal("B has the chat before its first message")
	}

	// The first message makes it at B, on the run.
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
	l, ok := rp.listed(t, chat)
	if !ok || l.Run != run || l.Server != rp.entry || !l.Locked || l.Start != "" {
		t.Fatalf("the chat on the run in A's list: %+v (listed: %v)", l, ok)
	}
	if _, err := os.Stat(filepath.Join(rp.a.home, "remote", "chats", chat+".json")); err != nil {
		t.Fatalf("the record's file of the chat: %v", err)
	}
	if a := rp.do(t, "PATCH", "/api/chats/"+chat, map[string]any{"server": servers.LocalID}); a.Status != http.StatusConflict {
		t.Fatalf("a change of the started chat's server: %s, want 409", a)
	}
	// The chat recorded nothing: A's defaults are what the run's start left.
	if after := defaults(); after != before {
		t.Fatalf("A's defaults changed with the chat on the run:\nbefore: %s\nafter:  %s", before, after)
	}
	if on := goes(); on != "" {
		t.Fatalf("a new chat of the group after the chat on the run is on %q, want this computer as before", on)
	}
	// And it is a chat of the run for B's agent: it may call the run's tools.
	rp.send(t, chat, "What is the run? [[mcp get_run {}]]")
	rp.turns(t, chat, 2)
	if th := rp.same(t, chat, "after a call of a run tool"); !th.has(t, "Wait for the chat") {
		t.Fatalf("the chat's get_run does not list the run's task: %s", joinThread(th))
	}
	rp.ok(t, "POST", "/api/runs/"+run+"/stop", nil)
	rp.ended(t, run)
}

// AC27: an entry with one run record and one draft run is removed. The confirmation counts one
// run; the record goes with run_removed; the draft is a run of this computer again; and B, which
// is told nothing, still has the run and takes it to its end.
func TestRemoteRunRemoval(t *testing.T) {
	rp := connectedRunPair(t, linksim.Good)
	g := rp.group(t, "Work")
	hereRepo := rp.newRepo(t)
	const first = "It goes on without A."
	skip := rp.b.fakeMessages(t)
	run := rp.startRun(t, g, "Stays there", rp.repo.Dir(), noteGoal(t, first, "goes-on.txt", "<<sleep 5>>"))
	rp.b.waitFakeMessage(t, skip, e2eOnTask)
	d := rp.draft(t, g, "Not started", rp.repo.Dir())
	rp.ok(t, "PUT", "/api/runs/"+d.ID+"/draft", map[string]any{"text": "a goal that stays"})

	var counts struct{ Chats, Runs int }
	rp.a.must(t, pairPage, "GET", "/api/servers/"+rp.entry+"/items", nil, &counts)
	if counts.Chats != 0 || counts.Runs != 1 {
		t.Fatalf("the confirmation's counts: %+v, want one run and no chat", counts)
	}
	// AC6: B's secret is in nothing A sent or answers, with the run on B and after the removal.
	noSecret := func(when string) {
		t.Helper()
		rp.noSecret(t, rp.page)
		for _, id := range []string{run, d.ID} {
			for _, path := range []string{"", "/detail", "/goal"} {
				if _, raw := rp.a.call(t, pairPage, "GET", "/api/runs/"+id+path, nil, nil); strings.Contains(raw, rp.b.secret) {
					t.Fatalf("%s: B's secret is in the answer of GET /api/runs/%s%s through A: %s", when, id, path, clipText(raw, 400))
				}
			}
		}
	}
	if v := rp.throughRun(t, run); v.Server != rp.entry || v.Status == model.RunDraft {
		t.Fatalf("the run through A before the removal: %+v", v)
	}
	rp.ok(t, "GET", "/api/runs/"+run+"/detail", nil)
	noSecret("before the removal")
	mark := rp.page.mark()
	rp.ok(t, "DELETE", "/api/servers/"+rp.entry, nil)
	rp.page.awaitEvent(t, mark, 5*time.Second, "run_removed", run)
	if _, err := os.Stat(rp.recordFile(run)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the record's file after the removal: %v", err)
	}
	for _, path := range []string{"", "/detail"} {
		if a := rp.do(t, "GET", "/api/runs/"+run+path, nil); a.Status != http.StatusNotFound {
			t.Fatalf("GET %s of the removed record through A: %s", path, a)
		}
	}
	// The draft is back on this computer, with its goal.
	v := rp.page.awaitRun(t, mark, 5*time.Second, d.ID, "this computer as its server", func(v model.RunView) bool { return v.Server == "" })
	if v.Status != model.RunDraft || v.Group != g || v.Start != "" {
		t.Fatalf("the draft's event after the removal: %+v", v)
	}
	if evs := rp.page.of(mark, "run_removed", d.ID); len(evs) != 0 {
		t.Fatalf("the draft was removed: %v", evs)
	}
	var st struct {
		Runs    []model.RunView
		Servers []servers.View
	}
	rp.a.must(t, pairPage, "GET", "/api/state", nil, &st)
	if len(st.Servers) != 1 || st.Servers[0].ID != servers.LocalID {
		t.Fatalf("A's servers after the removal: %+v", st.Servers)
	}
	if len(st.Runs) != 1 || st.Runs[0].ID != d.ID || st.Runs[0].Server != "" || st.Runs[0].Draft == nil || st.Runs[0].Draft.Text != "a goal that stays" {
		t.Fatalf("A's runs after the removal: %+v, want the draft alone, on this computer", st.Runs)
	}
	rp.isDraft(t, d.ID, "after the removal")
	noSecret("after the removal")
	// It starts here: a run of this computer, in a folder of this computer.
	if v := runIn(t, rp.ok(t, "PATCH", "/api/runs/"+d.ID, map[string]any{"cwd": hereRepo.Dir(), "tiers": tiersOn("haiku")})); v.Server != "" || v.Cwd != hereRepo.Dir() || v.Blocked != "" {
		t.Fatalf("the draft in a folder of this computer: %+v", v)
	}
	if a := rp.start(t, d.ID, noteGoal(t, "Started here after the removal.", "here.txt", "")); a.Status != http.StatusOK || runIn(t, a).Server != "" {
		t.Fatalf("the start on this computer: %s", a)
	}
	rp.localDone(t, d.ID)
	if got := hereRepo.Git("show", "main:here.txt"); got != "written by the run" {
		t.Fatalf("main:here.txt on this computer: %q", got)
	}

	// B was told nothing: it has the run, takes it to its end, and never had the draft.
	if b := rp.achieved(t, run); b.Archived || b.Counts.Done != 1 {
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
}

// AC33: the delete of a group that holds a remote run, while the run's server is stopped,
// deletes nothing and says which run and which server. With the server back it deletes the run
// there too.
func TestRemoteRunGroupDelete(t *testing.T) {
	rp := connectedRunPair(t, linksim.Good)
	kept := rp.group(t, "Kept")
	run := rp.startRun(t, kept, "Kept run", rp.repo.Dir(), noteGoal(t, "A run in a group.", "kept.txt", ""))
	rp.achieved(t, run)
	rp.sameRun(t, run, kept, "before B's stop")
	var here model.ChatView
	rp.a.must(t, pairPage, "POST", "/api/chats", map[string]any{"agent": "claude", "group": kept, "server": servers.LocalID}, &here)

	rp.b.stop(t)
	rp.waitState(t, servers.StateUnreachable, 2*time.Second)
	a := rp.refused(t, http.StatusConflict, "server_unreachable", "DELETE", "/api/groups/"+kept+"?contents=delete", nil)
	if !strings.Contains(a.Error, pairName) || !strings.Contains(a.Error, "Nothing was deleted") || !strings.Contains(a.Error, "Kept run") {
		t.Fatalf("the refusal of the group's delete: %s", a)
	}
	st := rp.state(t)
	if !slices.ContainsFunc(st.Groups, func(gr struct{ ID string }) bool { return gr.ID == kept }) {
		t.Fatal("the group is gone after the refused delete")
	}
	if !slices.ContainsFunc(st.Chats, func(v model.ChatView) bool { return v.ID == here.ID && v.Group == kept }) {
		t.Fatal("the chat of this computer in the group is gone after the refused delete")
	}
	if v, ok := rp.listedRun(t, run); !ok || v.Group != kept || v.Server != rp.entry || v.Gone {
		t.Fatalf("the run after the refused delete: %+v (listed: %v)", v, ok)
	}
	if _, err := os.Stat(rp.recordFile(run)); err != nil {
		t.Fatalf("the record's file after the refused delete: %v", err)
	}

	rp.b.up(t)
	rp.back(t, 45*time.Second)
	if b, there := rp.ownRun(t, run); !there || b.Status != model.RunCompleted {
		t.Fatalf("the run at B after the refused delete: %+v (there: %v)", b, there)
	}
	// With B connected the same delete takes the run there too.
	mark := rp.page.mark()
	rp.ok(t, "DELETE", "/api/groups/"+kept+"?contents=delete", nil)
	rp.page.awaitEvent(t, mark, 10*time.Second, "run_removed", run)
	if _, there := rp.ownRun(t, run); there {
		t.Fatal("B still has the run of the deleted group")
	}
	st = rp.state(t)
	if slices.ContainsFunc(st.Groups, func(gr struct{ ID string }) bool { return gr.ID == kept }) {
		t.Fatal("the group is still there")
	}
	if _, ok := rp.listedRun(t, run); ok {
		t.Fatal("the run of the deleted group is still listed")
	}
}

// A is killed with SIGKILL while the start call of a run is under way: B has started the run,
// and A's run.json says nothing of a start, since the mark is written only when a call has
// ended. A's next start settles the draft from the snapshot of its connection: the run is a
// record, the draft is gone, and B has one orchestrator.
func TestRemoteRunKilledInAStart(t *testing.T) {
	rp := connectedRunPair(t, linksim.Good)
	g := rp.group(t, "Work")
	const first = "Cut by a kill."
	goal := noteGoal(t, first, "killed.txt", "<<sleep 4>>")
	d := rp.draft(t, g, "Killed in its start", rp.repo.Dir())
	run := d.ID
	rp.link.Stall(true, false) // what B sends waits: the start call stays under way at A
	sent := rp.later("POST", "/api/runs/"+run+"/start", map[string]any{"goal": goal})
	rp.awaitOwnRun(t, run, "started", func(v model.RunView) bool { return v.Status != model.RunDraft })
	select {
	case a := <-sent:
		t.Fatalf("the start was answered while B's answers wait: %s", a)
	case <-time.After(300 * time.Millisecond):
	}
	rp.a.kill(t)
	if a := took(t, "the start", sent, 10*time.Second); a.Status != 0 {
		t.Fatalf("the start of a killed server was answered: %s", a)
	}
	meta, err := os.ReadFile(filepath.Join(rp.draftFolder(run), "run.json"))
	if err != nil {
		t.Fatalf("the draft's file after the kill: %v", err)
	}
	if strings.Contains(string(meta), "remoteStart") {
		t.Fatalf("the kill came after the call had ended: run.json has a mark: %s", meta)
	}
	if _, err := os.Stat(rp.recordFile(run)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("A has a record's file after the kill (%v)", err)
	}

	rp.link.Stall(false, false)
	rp.a.start(t)
	rp.page = watch(t, http.DefaultClient, strings.TrimSuffix(rp.a.in.url, "/"), pairPage, nil)
	back := rp.back(t, 60*time.Second)
	eventually(t, 10*time.Second, "the run is listed as a started run of B", func() bool {
		v, ok := rp.listedRun(t, run)
		return ok && v.Server == rp.entry && !v.Started.IsZero() && v.Start == "" && v.Group == g && v.Draft == nil
	})
	eventually(t, 10*time.Second, "the draft's folder is gone and the record's file is there", func() bool {
		_, draft := os.Stat(rp.draftFolder(run))
		_, rec := os.Stat(rp.recordFile(run))
		return errors.Is(draft, fs.ErrNotExist) && rec == nil
	})
	// A repeat by the page finds the record and sends nothing.
	if a := rp.start(t, run, goal); a.Status != http.StatusOK || runIn(t, a).Server != rp.entry || runIn(t, a).Started.IsZero() {
		t.Fatalf("a repeat of the start after A's restart: %s", a)
	}
	rp.achieved(t, run)
	if v := rp.sameRun(t, run, g, "after A's restart"); v.Status != model.RunCompleted {
		t.Fatalf("the run after A's restart: %+v", v)
	}
	if n := rp.b.orchestrators(t, first); n != 1 {
		t.Fatalf("%d orchestrators at B, want 1", n)
	}
	if left := rp.b.runFolders(t); !slices.Equal(left, []string{run}) {
		t.Fatalf("B's run folders: %v, want %s alone", left, run)
	}
	if got := rp.repo.Git("show", "main:killed.txt"); got != "written by the run" {
		t.Fatalf("main:killed.txt in B's repository: %q", got)
	}
	for _, l := range rp.a.fakeLines(t) {
		if l.agent() {
			t.Fatalf("A started an agent's process: %v", l.Start)
		}
	}
	t.Logf("killed with the start call under way; connected %v after A's start; the run is a record, the draft is gone, one orchestrator at B", back.Round(time.Millisecond))
}

// A new id after 409 id_taken: B's repository has a leftover branch of the draft's id, so B
// refuses that id. A gives the draft a new one and makes the call once more: the page is sent
// `run` with the new id and `was`, then `run_removed` of the old id, and the run starts under
// the new id.
func TestRemoteRunIDTaken(t *testing.T) {
	rp := connectedRunPair(t, linksim.Good)
	g := rp.group(t, "Work")
	const first = "Started under a new id."
	d := rp.draft(t, g, "Taken", rp.repo.Dir())
	old := d.ID
	rp.ok(t, "PUT", "/api/runs/"+old+"/draft", map[string]any{"text": "typed before the start"})
	leftover := "aiwb/" + old + "/integration"
	rp.repo.Git("branch", leftover)
	// B itself refuses the id.
	if status, got, raw := rp.b.startCall(t, pairDirect, old, apiStartBody(rp.repo.Dir(), "A goal.")); status != http.StatusConflict || got.Code != "id_taken" || got.Started {
		t.Fatalf("B's own answer for the id with a leftover branch: %d %s, want 409 id_taken", status, raw)
	}
	rp.nothingAtB(t, "after B's refusal")

	mark := rp.page.mark()
	a := rp.start(t, old, noteGoal(t, first, "new-id.txt", ""))
	v := runIn(t, a)
	if a.Status != http.StatusOK || v.ID == "" || v.ID == old || v.Server != rp.entry || v.Group != g || v.Started.IsZero() || v.Was != "" || v.Name != "Taken" {
		t.Fatalf("the start of a draft whose id is taken at B: %s, want the run started under a new id", a)
	}
	run := v.ID
	// The page's stream: the draft under its new id with `was`, the old id removed, the start.
	moved := rp.page.await(t, mark, 5*time.Second, "run event with was", func(e seenEvent) bool { return e.Type == "run" && runOf(e).Was == old })
	if m := runOf(moved); m.ID != run || m.Status != model.RunDraft || m.Server != rp.entry || m.Group != g || m.Draft == nil || m.Draft.Text != "typed before the start" {
		t.Fatalf("the run event with was: %+v", m)
	}
	removed := rp.page.awaitEvent(t, mark, 5*time.Second, "run_removed", old)
	startedEv := rp.page.await(t, mark, 5*time.Second, "run event of the started run", func(e seenEvent) bool {
		return e.Type == "run" && runOf(e).ID == run && !runOf(e).Started.IsZero()
	})
	var order []string
	for _, e := range rp.page.since(mark) {
		for what, raw := range map[string]string{"was": moved.Raw, "removed": removed.Raw, "started": startedEv.Raw} {
			if e.Raw == raw && !slices.Contains(order, what) { // the swap sends the started run twice
				order = append(order, what)
			}
		}
	}
	if !slices.Equal(order, []string{"was", "removed", "started"}) {
		t.Fatalf("the order of the page's events: %v, want was, removed, started", order)
	}
	if evs := rp.page.of(mark, "run_removed", run); len(evs) != 0 {
		t.Fatalf("the new id was removed: %v", evs)
	}
	if runOf(startedEv).Was != "" {
		t.Fatalf("the started run's event carries was: %s", startedEv.Raw)
	}

	// A: the record under the new id, nothing under the old one.
	rp.isRecord(t, run, "after the start")
	for _, file := range []string{rp.draftFolder(old), rp.recordFile(old)} {
		if _, err := os.Stat(file); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("%s after the start under a new id: %v", file, err)
		}
	}
	if _, ok := rp.listedRun(t, old); ok {
		t.Fatal("the old id is still in A's list")
	}
	if a := rp.do(t, "GET", "/api/runs/"+old, nil); a.Status != http.StatusNotFound {
		t.Fatalf("the old id through A: %s", a)
	}
	// B: one run, under the new id; the old id is still refused, its branch untouched.
	if _, there := rp.ownRun(t, old); there {
		t.Fatal("B has a run under the old id")
	}
	rp.achieved(t, run)
	rp.sameRun(t, run, g, "after the end")
	if left := rp.b.runFolders(t); !slices.Equal(left, []string{run}) {
		t.Fatalf("B's run folders: %v, want %s alone", left, run)
	}
	if n := rp.b.orchestrators(t, first); n != 1 {
		t.Fatalf("%d orchestrators at B, want 1", n)
	}
	if got := rp.repo.Git("show", "main:new-id.txt"); got != "written by the run" {
		t.Fatalf("main:new-id.txt in B's repository: %q", got)
	}
	// The run's own branches go after its result was applied; the leftover is not B's to touch.
	eventually(t, e2eGone, "the leftover branch alone in B's repository", func() bool {
		return rp.repo.Git("for-each-ref", "--format=%(refname:short)", "refs/heads/aiwb/") == leftover
	})
	t.Logf("409 id_taken for %s: the run started as %s after one more call", old, run)
}

// AC29 and AC44, a server that lost its agent: B's Claude program goes away while B is connected.
// A's page is told B's lists with no agent within 35 s, and a chat then made on B has no agent.
func TestRemoteRunNoAgentProgram(t *testing.T) {
	rp := connectedRunPair(t, linksim.Good)
	g := rp.group(t, "Work")
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
	rp.a.must(t, pairPage, "POST", "/api/chats", map[string]any{"group": g, "server": rp.entry}, &made)
	if made.Server != rp.entry || made.Agent != model.Claude {
		t.Fatalf("a chat made on %s with its program there: %+v", pairName, made)
	}

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
	rp.a.must(t, pairPage, "POST", "/api/chats", map[string]any{"group": g, "server": rp.entry}, &made)
	if made.ID == "" || made.Server != rp.entry || made.Agent != "" {
		t.Fatalf("a chat made on %s with its program gone: %+v, want it there with no agent", pairName, made)
	}
}

// AC31: "New run" and "+" in a group start with the server the group's last first message went
// to. After a chat of the group started on B both are on B; in another group both are on this
// computer.
func TestRemoteRunGroupServer(t *testing.T) {
	rp := connectedRunPair(t, linksim.Good)
	g, other := rp.group(t, "Work"), rp.group(t, "Other")
	for _, gr := range []string{g, other} {
		if v := runIn(t, rp.ok(t, "POST", "/api/runs", map[string]any{"group": gr})); v.Server != "" {
			t.Fatalf("a new run before any first message is on %q", v.Server)
		}
	}
	rp.startChat(t, g, "hi")
	for _, c := range []struct{ group, want string }{{g, rp.entry}, {other, ""}} {
		v := runIn(t, rp.ok(t, "POST", "/api/runs", map[string]any{"group": c.group}))
		if v.ID == "" || v.Status != model.RunDraft || v.Group != c.group || v.Server != c.want {
			t.Fatalf("the new run of the group %s: %+v, want its server %q", c.group, v, c.want)
		}
		var chat model.ChatView
		rp.a.must(t, pairPage, "POST", "/api/chats", map[string]any{"group": c.group}, &chat)
		if chat.ID == "" || chat.Group != c.group || chat.Server != c.want || chat.Locked {
			t.Fatalf("the new chat of the group %s: %+v, want its server %q", c.group, chat, c.want)
		}
	}
}

// bPage makes a call of B's own page: on B's loopback listener, as the person at B would, with
// the page's event stream open while the call is made.
func (rp *runPair) bPage(t *testing.T, method, path string, body any) answer {
	t.Helper()
	w := watch(t, http.DefaultClient, strings.TrimSuffix(rp.b.in.url, "/"), apiPage, nil)
	defer w.close()
	status, raw := rp.b.call(t, apiPage, method, path, body, nil)
	a := answer{Status: status, Raw: raw}
	json.Unmarshal([]byte(raw), &a)
	a.Status, a.Raw = status, raw
	return a
}

// AC43, the archive row of flow 5.2 while B is away and from B's side: an archive made on A while
// B is stopped shows at once, with A's action, and is carried out at B when it is back, with no
// further call. An archive made on B's own page shows on A without an action of A's, and stays
// through a cut of the link.
func TestRemoteRunArchiveAway(t *testing.T) {
	rp := connectedRunPair(t, linksim.Good)
	g := rp.group(t, "Work")
	second := rp.newRepo(t)
	r1 := rp.startRun(t, g, "Archived while away", rp.repo.Dir(), noteGoal(t, "Archived while its server was away.", "one.txt", ""))
	r2 := rp.startRun(t, g, "Archived there", second.Dir(), noteGoal(t, "Archived on its own server.", "two.txt", ""))
	for _, run := range []string{r1, r2} {
		rp.achieved(t, run)
		if v := rp.sameRun(t, run, g, "before the archives"); v.Archived {
			t.Fatalf("the run %s is archived before its archive: %+v", run, v)
		}
	}

	rp.b.stop(t)
	rp.waitState(t, servers.StateUnreachable, 2*time.Second)
	mark := rp.page.mark()
	rp.ok(t, "POST", "/api/runs/"+r1+"/archive", nil)
	shown := rp.page.awaitRun(t, mark, 5*time.Second, r1, "the archived mark", func(v model.RunView) bool { return v.Archived })
	if shown.Op == "" || shown.Server != rp.entry || shown.Group != g || shown.Gone {
		t.Fatalf("the page's event of the archive made while %s is away: %+v, want A's action in it", pairName, shown)
	}
	if v, ok := rp.listedRun(t, r1); !ok || !v.Archived || v.Op != shown.Op {
		t.Fatalf("the run in A's list after the archive: %+v (listed: %v)", v, ok)
	}
	if v, ok := rp.listedRun(t, r2); !ok || v.Archived {
		t.Fatalf("the other run in A's list: %+v (listed: %v)", v, ok)
	}
	// B is back: A sends the archive that waited, and the test calls nothing for it.
	rp.b.up(t)
	began := time.Now()
	if b := rp.awaitOwnRun(t, r1, "archived", func(v model.RunView) bool { return v.Archived }); b.Status != model.RunCompleted {
		t.Fatalf("the run at B after the archive that waited: %+v", b)
	}
	t.Logf("the archive made while %s was away was carried out there %v after its return", pairName, time.Since(began).Round(10*time.Millisecond))
	rp.back(t, 45*time.Second)
	if v := rp.sameRun(t, r1, g, "after the return"); !v.Archived || v.Op != shown.Op {
		t.Fatalf("the run through A after the return: %+v, want it archived by the action %q", v, shown.Op)
	}
	if b, _ := rp.ownRun(t, r2); b.Archived {
		t.Fatalf("the other run at B: %+v", b)
	}

	// The archive on B's own page.
	mark = rp.page.mark()
	if a := rp.bPage(t, "POST", "/api/runs/"+r2+"/archive", nil); a.Status != http.StatusOK {
		t.Fatalf("the archive on B's own page: %s", a)
	}
	there := rp.page.awaitRun(t, mark, 5*time.Second, r2, "the archived mark", func(v model.RunView) bool { return v.Archived })
	if there.Op != "" || there.Server != rp.entry || there.Group != g {
		t.Fatalf("the page's event of the archive made at %s: %+v, want no action of A's", pairName, there)
	}
	rp.link.Cut()
	rp.waitState(t, servers.StateUnreachable, 40*time.Second)
	if v, ok := rp.listedRun(t, r2); !ok || !v.Archived || v.Op != "" {
		t.Fatalf("the run in A's list through the cut: %+v (listed: %v)", v, ok)
	}
	rp.restore(t)
	for run, op := range map[string]string{r1: shown.Op, r2: ""} {
		if v := rp.sameRun(t, run, g, "after the cut"); !v.Archived || v.Op != op {
			t.Fatalf("the run %s through A after the cut: %+v, want it archived with the action %q", run, v, op)
		}
		if v, ok := rp.listedRun(t, run); !ok || !v.Archived || v.Op != op {
			t.Fatalf("the run %s in A's list after the cut: %+v (listed: %v)", run, v, ok)
		}
		if b, there := rp.ownRun(t, run); !there || !b.Archived {
			t.Fatalf("the run %s at B after the cut: %+v (there: %v)", run, b, there)
		}
	}
}

// AC43, the delete row of flow 5.2, "Remove from this sidebar only": refused while the run's
// server is connected; with the server stopped it removes A's record alone, and B still has the
// run when it is back; and for a run that is gone at B it removes the record.
func TestRemoteRunSidebarOnly(t *testing.T) {
	rp := connectedRunPair(t, linksim.Good)
	g := rp.group(t, "Work")
	second := rp.newRepo(t)
	r1 := rp.startRun(t, g, "Off this sidebar", rp.repo.Dir(), noteGoal(t, "Removed from one sidebar only.", "one.txt", ""))
	r2 := rp.startRun(t, g, "Deleted there", second.Dir(), noteGoal(t, "Deleted on its own server.", "two.txt", ""))
	for _, run := range []string{r1, r2} {
		rp.achieved(t, run)
		rp.sameRun(t, run, g, "before the deletes")
	}

	// Connected: the run is deleted on its server or not at all.
	if a := rp.refused(t, http.StatusConflict, "server_connected", "DELETE", "/api/runs/"+r1+"?local=1", nil); !strings.Contains(a.Error, pairName) {
		t.Fatalf("the refusal while %s is connected: %s", pairName, a)
	}
	rp.isRecord(t, r1, "after the refusal")
	if _, ok := rp.listedRun(t, r1); !ok {
		t.Fatal("the run is not listed after the refused removal")
	}

	// B stopped: the plain delete cannot be made, and the record alone can go.
	rp.b.stop(t)
	rp.waitState(t, servers.StateUnreachable, 2*time.Second)
	mark := rp.page.mark()
	rp.refused(t, http.StatusServiceUnavailable, "server_unreachable", "DELETE", "/api/runs/"+r1, nil)
	rp.isRecord(t, r1, "after the delete that could not be made")
	if evs := rp.page.of(mark, "run_removed", r1); len(evs) != 0 {
		t.Fatalf("the page was told the run is removed after a refused delete: %v", evs)
	}
	rp.ok(t, "DELETE", "/api/runs/"+r1+"?local=1", nil)
	rp.page.awaitEvent(t, mark, 5*time.Second, "run_removed", r1)
	if _, err := os.Stat(rp.recordFile(r1)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the record's file after the removal from this sidebar: %v", err)
	}
	for _, path := range []string{"", "/detail"} {
		if a := rp.do(t, "GET", "/api/runs/"+r1+path, nil); a.Status != http.StatusNotFound {
			t.Fatalf("GET %s of the removed record through A: %s, want 404", path, a)
		}
	}
	if _, ok := rp.listedRun(t, r1); ok {
		t.Fatal("the removed record is still in A's list")
	}
	if v, ok := rp.listedRun(t, r2); !ok || v.Gone {
		t.Fatalf("the other run in A's list: %+v (listed: %v)", v, ok)
	}

	// B is back and was told nothing: it has the run, and the run's result is in its repository.
	rp.b.up(t)
	rp.back(t, 45*time.Second)
	if b, there := rp.ownRun(t, r1); !there || b.Status != model.RunCompleted || b.Cwd != rp.repo.Dir() || b.Archived {
		t.Fatalf("the run at B after its removal from A's sidebar: %+v (there: %v)", b, there)
	}
	if got := rp.repo.Git("show", "main:one.txt"); got != "written by the run" {
		t.Fatalf("main:one.txt in B's repository: %q", got)
	}
	if left := rp.b.runFolders(t); !slices.Contains(left, r1) || !slices.Contains(left, r2) {
		t.Fatalf("B's run folders after its return: %v, want both runs", left)
	}
	// The connection's snapshot does not bring the record back.
	rp.sameRun(t, r2, g, "after the return")
	if _, ok := rp.listedRun(t, r1); ok {
		t.Fatal("the removed record is listed again after B's return")
	}
	if _, err := os.Stat(rp.recordFile(r1)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the record's file after B's return: %v", err)
	}

	// Gone: the run is deleted on B's own page. A marks its record, and the record can go.
	mark = rp.page.mark()
	if a := rp.bPage(t, "DELETE", "/api/runs/"+r2, nil); a.Status != http.StatusOK {
		t.Fatalf("the delete on B's own page: %s", a)
	}
	if _, there := rp.ownRun(t, r2); there {
		t.Fatal("B still has the run deleted on its own page")
	}
	rp.page.awaitRun(t, mark, 10*time.Second, r2, "the gone mark", func(v model.RunView) bool { return v.Gone })
	if v, ok := rp.listedRun(t, r2); !ok || !v.Gone || v.Server != rp.entry || v.Group != g {
		t.Fatalf("the run deleted at B in A's list: %+v (listed: %v), want it listed as gone", v, ok)
	}
	rp.isRecord(t, r2, "while the run is gone")
	if v := rp.entryView(t); v.State != servers.StateConnected {
		t.Fatalf("%s is %q, want connected", pairName, v.State)
	}
	rp.ok(t, "DELETE", "/api/runs/"+r2+"?local=1", nil)
	rp.page.awaitEvent(t, mark, 5*time.Second, "run_removed", r2)
	if _, err := os.Stat(rp.recordFile(r2)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the record's file of the gone run after its removal: %v", err)
	}
	if _, ok := rp.listedRun(t, r2); ok {
		t.Fatal("the gone run is still in A's list after its removal")
	}
}

// AC44, a draft run whose server is away: with B stopped the draft says that B is not connected,
// it cannot start and its folder cannot be changed, and its agent and what was typed stay. With B
// back the draft is not blocked, an agent B does not have is refused, and the run starts.
func TestRemoteRunDraftAway(t *testing.T) {
	rp := connectedRunPair(t, linksim.Good)
	g := rp.group(t, "Work")
	const first = "Started after its server came back."
	goal := noteGoal(t, first, "away.txt", "")
	d := rp.draft(t, g, "Waits for its server", rp.repo.Dir())
	run := d.ID
	rp.ok(t, "PUT", "/api/runs/"+run+"/draft", map[string]any{"text": goal})

	rp.b.stop(t)
	rp.waitState(t, servers.StateUnreachable, 2*time.Second)
	away := time.Now()
	blocked := func(v model.RunView) bool {
		return strings.Contains(v.Blocked, pairName) && strings.Contains(v.Blocked, "not connected")
	}
	var v model.RunView
	eventually(t, 2*time.Second, "the draft blocked by "+pairName+" not being connected", func() bool {
		v = rp.throughRun(t, run)
		return blocked(v)
	})
	t.Logf("the draft's blocked %v after %s was shown as not connected: %q", time.Since(away).Round(time.Millisecond), pairName, v.Blocked)
	if v.Status != model.RunDraft || v.Server != rp.entry || v.Start != "" || v.Draft == nil || v.Draft.Text != goal {
		t.Fatalf("the draft while %s is away: %+v, want it on %s with its text", pairName, v, pairName)
	}
	if l, ok := rp.listedRun(t, run); !ok || !blocked(l) || l.Server != rp.entry {
		t.Fatalf("the draft in A's list while %s is away: %+v (listed: %v)", pairName, l, ok)
	}
	began := time.Now()
	for _, c := range []struct {
		method, path string
		body         any
	}{
		{"PATCH", "", map[string]any{"cwd": rp.work}},
		{"POST", "/start", map[string]any{"goal": goal}},
	} {
		if a := rp.refused(t, http.StatusServiceUnavailable, "server_unreachable", c.method, "/api/runs/"+run+c.path, c.body); !strings.Contains(a.Error, pairName) {
			t.Fatalf("%s %s while %s is away: %s", c.method, c.path, pairName, a)
		}
	}
	// The agent: nothing can be asked of B, so an agent its last list lacks is refused, and the
	// stored one stays, with the reason the draft cannot start.
	rp.refused(t, http.StatusConflict, "agent_missing", "PATCH", "/api/runs/"+run, map[string]any{"agent": "pi"})
	if v := runIn(t, rp.ok(t, "PATCH", "/api/runs/"+run, map[string]any{"agent": "claude"})); v.Agent != model.Claude || !blocked(v) {
		t.Fatalf("the draft's own agent set again while %s is away: %+v, want it kept and the draft blocked", pairName, v)
	}
	if took := time.Since(began); took > 2*time.Second {
		t.Fatalf("the refusals while %s is away took %v", pairName, took)
	}
	if v := rp.throughRun(t, run); v.Status != model.RunDraft || v.Start != "" || v.Agent != model.Claude || v.Draft == nil || v.Draft.Text != goal || !blocked(v) {
		t.Fatalf("the draft after the refusals: %+v, want it as it was, with its text", v)
	}
	rp.isDraft(t, run, "after the refusals")

	rp.b.up(t)
	rp.back(t, 45*time.Second)
	rp.nothingAtB(t, "after B's return")
	eventually(t, 10*time.Second, "the draft is not blocked", func() bool {
		v = rp.throughRun(t, run)
		return v.Blocked == ""
	})
	if v.Status != model.RunDraft || v.Server != rp.entry || v.FolderMissing || !v.Git || v.Draft == nil || v.Draft.Text != goal {
		t.Fatalf("the draft after %s's return: %+v", pairName, v)
	}
	rp.refused(t, http.StatusConflict, "agent_missing", "PATCH", "/api/runs/"+run, map[string]any{"agent": "pi"})
	a := rp.start(t, run, goal)
	if s := runIn(t, a); a.Status != http.StatusOK || s.ID != run || s.Server != rp.entry || s.Started.IsZero() || s.Agent != model.Claude {
		t.Fatalf("the start after %s's return: %s", pairName, a)
	}
	rp.isRecord(t, run, "after the start")
	rp.achieved(t, run)
	if n := rp.b.orchestrators(t, first); n != 1 {
		t.Fatalf("%d orchestrators at B, want 1", n)
	}
	if got := rp.repo.Git("show", "main:away.txt"); got != "written by the run" {
		t.Fatalf("main:away.txt in B's repository: %q", got)
	}
}

// A start made while B's process is frozen: the start call is in B's socket and gets no answer,
// so A answers 504 start_unconfirmed after its limit and has marked B unreachable. Then B goes
// on: it takes the call and starts the run, while A connects again. Whichever comes first, the
// snapshot of the connection or the start at B, the run ends up a record on A with nothing
// called on A but reads of its snapshot, and one run at B, which takes it to its end.
func TestRemoteRunFrozenStart(t *testing.T) {
	rp := connectedRunPair(t, linksim.Good)
	g := rp.group(t, "Work")
	const first = "Started while its server was frozen."
	goal := noteGoal(t, first, "frozen.txt", "")
	d := rp.draft(t, g, "Frozen in its start", rp.repo.Dir())
	run := d.ID
	rp.ok(t, "PUT", "/api/runs/"+run+"/draft", map[string]any{"text": goal})
	mark := rp.page.mark()

	rp.freezeB(t)
	began := time.Now()
	a := took(t, "the start", rp.later("POST", "/api/runs/"+run+"/start", map[string]any{"goal": goal}), 80*time.Second)
	if a.Status != http.StatusGatewayTimeout || a.Code != "start_unconfirmed" || !strings.Contains(a.Error, pairName) {
		t.Fatalf("the start at a frozen B: %s, want 504 start_unconfirmed", a)
	}
	t.Logf("504 start_unconfirmed %v after the start; %s is %q", time.Since(began).Round(100*time.Millisecond), pairName, rp.entryView(t).State)
	if v := rp.throughRun(t, run); v.Start != "unconfirmed" || v.Status != model.RunDraft || v.Server != rp.entry {
		t.Fatalf("the run after the lost answer: %+v, want a draft whose start is unconfirmed", v)
	}
	rp.isDraft(t, run, "after the lost answer")

	// B goes on. From here nothing is called on A but GET /api/state.
	rp.continueB(t)
	continued := time.Now()
	started := func() bool {
		v, ok := rp.listedRun(t, run)
		return ok && v.Server == rp.entry && v.Group == g && !v.Started.IsZero() && v.Status != model.RunDraft && v.Start == "" && v.Draft == nil && !v.Gone
	}
	eventually(t, 30*time.Second, "the run is listed as a started run of "+pairName, started)
	t.Logf("listed as started %v after B went on", time.Since(continued).Round(10*time.Millisecond))
	eventually(t, 5*time.Second, "the draft's folder is gone and the record's file is there", func() bool {
		_, draft := os.Stat(rp.draftFolder(run))
		_, rec := os.Stat(rp.recordFile(run))
		return errors.Is(draft, fs.ErrNotExist) && rec == nil
	})
	if v := rp.page.awaitRun(t, mark, 5*time.Second, run, "the start", func(v model.RunView) bool { return !v.Started.IsZero() && v.Status != model.RunDraft }); v.Server != rp.entry || v.Group != g || v.Start != "" || v.Draft != nil {
		t.Fatalf("the page's event of the started run: %+v", v)
	}

	// B has the run once and takes it to its end; A lists it to the end and never removed it.
	if left := rp.b.runFolders(t); !slices.Equal(left, []string{run}) {
		t.Fatalf("B's run folders: %v, want %s alone", left, run)
	}
	rp.achieved(t, run)
	if n := rp.b.orchestrators(t, first); n != 1 {
		t.Fatalf("%d orchestrators at B, want 1", n)
	}
	if left := rp.b.runFolders(t); !slices.Equal(left, []string{run}) {
		t.Fatalf("B's run folders at the end: %v, want %s alone", left, run)
	}
	if got := rp.repo.Git("show", "main:frozen.txt"); got != "written by the run" {
		t.Fatalf("main:frozen.txt in B's repository: %q", got)
	}
	eventually(t, 30*time.Second, "the run is listed as completed", func() bool {
		v, ok := rp.listedRun(t, run)
		return ok && v.Status == model.RunCompleted
	})
	if !started() {
		v, ok := rp.listedRun(t, run)
		t.Fatalf("the run in A's list at the end: %+v (listed: %v)", v, ok)
	}
	rp.isRecord(t, run, "at the end")
	if evs := rp.page.of(mark, "run_removed", run); len(evs) != 0 {
		t.Fatalf("the page was told the run is removed: %v", evs)
	}
	for _, e := range rp.page.of(mark, "run") {
		if v := runOf(e); v.ID != run && v.Was == run {
			t.Fatalf("the run was given a new id: %s", clipText(e.Raw, 400))
		}
	}
	for _, l := range rp.a.fakeLines(t) {
		if l.agent() {
			t.Fatalf("A started an agent's process: %v", l.Start)
		}
	}
}
