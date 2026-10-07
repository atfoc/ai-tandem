package runs

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/usable"
)

// Tests of the run service for an API client: the start call, the client mark, the draft check.
// They run on the package's test doubles (svcEnv): a model of the engine, a recording emitter.

const (
	apiID     = "r_start001"
	apiClient = "c-one"
	apiGroup  = "g_remote"
)

// apiEnv is a svcEnv whose service has the mark hook, and an emitter that writes into one log
// with it: what was told and sent, in the order it happened.
type apiEnv struct {
	*svcEnv
	mu     sync.Mutex
	log    []string      // "mark <run> <client>" and svcKinds of every event sent
	places int           // how often place was asked
	hold   time.Duration // how long the emitter holds a `run_removed` before it is sent
}

// apiEmitter is the emitter of an apiEnv: it notes the event, then hands it to the recorder.
type apiEmitter struct{ e *apiEnv }

func (m apiEmitter) Broadcast(ev any) { m.SendRun("", ev) }

func (m apiEmitter) SendRun(run string, ev any) {
	if _, ok := ev.(svcRemovedEvent); ok {
		m.e.mu.Lock()
		hold := m.e.hold
		m.e.mu.Unlock()
		time.Sleep(hold)
	}
	m.e.note(svcKinds([]any{ev})[0])
	m.e.emit.SendRun(run, ev)
}

func newAPIEnv(t testing.TB) *apiEnv {
	t.Helper()
	e := &apiEnv{svcEnv: newSvcEnv(t)}
	e.hook()
	// The group place gives exists, as the server's does: a start call asks again for one that is gone.
	svcGroupAdd(t, e.s, model.Group{ID: apiGroup, Name: "Remote"})
	return e
}

// hook puts the mark hook and the emitter into the Service the env has now, before any run exists.
func (e *apiEnv) hook() {
	e.s.Emit = apiEmitter{e}
	e.s.Mark = func(run, client string) { e.note("mark " + run + " " + client) }
}

// restart is a server restart with the hook set before the runs are loaded.
func (e *apiEnv) restart() {
	e.t.Helper()
	e.boot()
	e.wire()
	e.hook()
	if err := e.s.Load(); err != nil {
		e.t.Fatal(err)
	}
}

func (e *apiEnv) note(what string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.log = append(e.log, what)
}

// logged is the log so far, the queue sent first.
func (e *apiEnv) logged() []string {
	e.s.svcFlush()
	e.mu.Lock()
	defer e.mu.Unlock()
	return slices.Clone(e.log)
}

// marks is the mark calls of the log.
func (e *apiEnv) marks() []string {
	var out []string
	for _, l := range e.logged() {
		if strings.HasPrefix(l, "mark ") {
			out = append(out, l)
		}
	}
	return out
}

// place is a StartReq's Place: the group apiGroup, counted.
func (e *apiEnv) place() (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.places++
	return apiGroup, nil
}

func (e *apiEnv) placed() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.places
}

// req is a start call that is accepted: Claude on sonnet in the env's folder.
func (e *apiEnv) req(id string) StartReq {
	return StartReq{ID: id, Client: apiClient, Agent: model.Claude, Tiers: tiersAll("sonnet", ""), Cwd: e.cwd, Goal: svcGoal, Place: e.place}
}

// defaults is the store's defaults as they are in memory and the state file as it is on disk.
func (e *apiEnv) defaults() string {
	e.t.Helper()
	var b []byte
	e.s.Store.Read(func(st *model.State) { b, _ = json.Marshal(st.Defaults) })
	file, err := os.ReadFile(e.s.Store.P.State)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		e.t.Fatal(err)
	}
	return string(b) + "\n" + string(file)
}

// runDirs is the names in the data folder's runs folder.
func (e *apiEnv) runDirs() []string {
	e.t.Helper()
	ents, err := os.ReadDir(e.s.Store.P.Runs)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		e.t.Fatal(err)
	}
	var out []string
	for _, ent := range ents {
		out = append(out, ent.Name())
	}
	return out
}

// locks is how many creation locks the service keeps.
func (e *apiEnv) locks() int {
	e.s.starts.mu.Lock()
	defer e.s.starts.mu.Unlock()
	return len(e.s.starts.m)
}

// nothing checks that a refused start call left nothing: no folder, no run, no mark, no event, no
// engine start, no creation lock, and the defaults as they were.
func (e *apiEnv) nothing(defaultsBefore string) {
	e.t.Helper()
	if got := e.runDirs(); len(got) != 0 {
		e.t.Errorf("folders under runs/: %v", got)
	}
	if got := e.s.Views(); len(got) != 0 {
		e.t.Errorf("runs in the service: %+v", got)
	}
	if got := e.logged(); len(got) != 0 {
		e.t.Errorf("marks and events: %v", got)
	}
	if got := e.fake.called(); len(got) != 0 {
		e.t.Errorf("engine calls: %v", got)
	}
	if n := e.locks(); n != 0 {
		e.t.Errorf("%d creation locks left", n)
	}
	if got := e.defaults(); got != defaultsBefore {
		e.t.Errorf("the defaults changed:\n%s\nbefore:\n%s", got, defaultsBefore)
	}
}

// A start with a given id makes the run and starts it: the view, run.json, the goal, the detail,
// one engine start, one group request, and the mark told before the `run` event.
func TestStartCallMakesAndStartsTheRun(t *testing.T) {
	e := newAPIEnv(t)
	before := e.defaults()
	req := e.req(apiID)
	req.Settings = SettingsPatch{MaxTurns: svcPtr(12), Setup: svcPtr(" npm ci ")}
	res, err := e.s.StartCall(req)
	if err != nil {
		t.Fatal(err)
	}
	want := model.DefaultRunSettings()
	want.MaxTurns, want.Setup = 12, "npm ci"
	v := res.Run
	if !res.Started || !res.Made || v.ID != apiID || v.Group != apiGroup || v.Status != model.RunRunning || v.Name != "Port the importer" ||
		v.UserNamed || v.Agent != model.Claude || v.Cwd != e.cwd || v.Settings != want || v.Started.IsZero() || v.Draft != nil || v.TierDefaults != nil {
		t.Fatalf("the answer: %+v", res)
	}
	if got, err := e.s.View(apiID); err != nil || !svcSameJSON(got, v) {
		t.Fatalf("the view: %+v %v", got, err)
	}
	r, _ := e.s.run(apiID)
	if m := svcMetaOnDisk(t, r); m.Client != apiClient || m.Group != apiGroup || m.Started.IsZero() || m.Git || m.Tiers != v.Tiers || m.Settings != want {
		t.Fatalf("run.json: %+v", m)
	}
	if b, _ := os.ReadFile(filepath.Join(r.dir, fileMeta)); !strings.Contains(string(b), `"client": "`+apiClient+`"`) {
		t.Fatalf("run.json has no client:\n%s", b)
	}
	if g, err := e.s.Goal(apiID); err != nil || g.Text != svcGoal {
		t.Fatalf("the goal: %+v %v", g, err)
	}
	if d, err := e.s.Detail(apiID); err != nil || d.Version != 1 {
		t.Fatalf("the detail: version %d, %v", d.Version, err)
	}
	if c, err := e.s.ClientOf(apiID); err != nil || c != apiClient {
		t.Fatalf("ClientOf: %q %v", c, err)
	}
	// Entry 1's `run_detail` goes by follow and nobody can follow yet; the mark is told before the
	// run's `run` event, the one that goes by mark.
	if got, want := e.logged(), []string{"run_detail 1", "mark " + apiID + " " + apiClient, "run"}; !slices.Equal(got, want) {
		t.Fatalf("told and sent: %v, want %v", got, want)
	}
	if as := e.emit.sentAs(); !slices.Equal(as, []string{apiID, apiID}) {
		t.Fatalf("the events were sent as events of %v", as)
	}
	if evs := svcRunEvents(e.allEvents(), apiID); len(evs) != 1 || evs[0].Status != model.RunRunning || evs[0].Group != apiGroup {
		t.Fatalf("the run event: %+v", evs)
	}
	if got := e.fake.called(); !slices.Equal(got, []string{"start " + apiID}) {
		t.Fatalf("engine calls: %v", got)
	}
	if e.placed() != 1 || e.locks() != 0 {
		t.Fatalf("%d group requests, %d creation locks left", e.placed(), e.locks())
	}
	if got := e.defaults(); got != before {
		t.Fatalf("the defaults changed:\n%s", got)
	}
}

// A repeat does nothing, whatever its values; the id of a run that is not the caller's started
// run is taken.
func TestStartCallRepeatAndTakenIDs(t *testing.T) {
	e := newAPIEnv(t)
	first, err := e.s.StartCall(e.req(apiID))
	if err != nil {
		t.Fatal(err)
	}
	log := e.logged()

	other := e.req(apiID)
	other.Cwd, other.Goal, other.Agent, other.Name, other.UserNamed = filepath.Join(e.cwd, "missing"), "Another goal entirely.", model.Pi, "Mine", true
	other.Tiers = model.RunTiers{}
	res, err := e.s.StartCall(other)
	if err != nil || !res.Started || res.Made || !svcSameJSON(res.Run, first.Run) {
		t.Fatalf("a repeat with other values: %+v %v", res, err)
	}
	if got := e.logged(); !slices.Equal(got, log) {
		t.Fatalf("a repeat told or sent something: %v", got)
	}
	if got := e.fake.called(); len(got) != 1 || e.placed() != 1 {
		t.Fatalf("a repeat: engine calls %v, %d group requests", got, e.placed())
	}

	// In every status, archived included.
	if err := e.s.Archive(apiID, model.Archive{Archived: true}); err != nil {
		t.Fatal(err)
	}
	if res, err := e.s.StartCall(e.req(apiID)); err != nil || !res.Started || res.Made || !res.Run.Archived {
		t.Fatalf("a repeat for an archived run: %+v %v", res, err)
	}

	// Another client's call with that id.
	theirs := e.req(apiID)
	theirs.Client = "c-two"
	if res, err := e.s.StartCall(theirs); !errors.Is(err, ErrIDTaken) || res.Started || res.Made || res.Run.ID != "" {
		t.Fatalf("another client's call: %+v %v", res, err)
	}

	// The owner's draft and the owner's started run.
	draft := e.draft("r_ownerdrf")
	metaBefore := svcMetaOnDisk(t, draft)
	e.started("r_ownerrun")
	e.events()
	for _, id := range []string{"r_ownerdrf", "r_ownerrun"} {
		if res, err := e.s.StartCall(e.req(id)); !errors.Is(err, ErrIDTaken) || res.Started {
			t.Fatalf("%s: %+v %v", id, res, err)
		}
	}
	if m := svcMetaOnDisk(t, draft); !svcSameJSON(m, metaBefore) || draft.viewNow().Status != model.RunDraft {
		t.Fatalf("the owner's draft changed: %+v", m)
	}
	if evs := e.events(); len(evs) != 0 || e.placed() != 1 || len(e.marks()) != 1 || e.locks() != 0 {
		t.Fatalf("refused calls: events %v, %d group requests, marks %v, %d locks", svcKinds(evs), e.placed(), e.marks(), e.locks())
	}

	// A draft with the caller's mark (no start call makes one) is not started: taken.
	meta := svcMetaOnDisk(t, draft)
	meta.ID, meta.Client = "r_markdrft", apiClient
	if err := writeMeta(e.s.Store.P.RunDir(meta.ID), meta); err != nil {
		t.Fatal(err)
	}
	e.s.add(newRun(e.s, meta))
	if res, err := e.s.StartCall(e.req(meta.ID)); !errors.Is(err, ErrIDTaken) || res.Started {
		t.Fatalf("an unstarted run with the caller's mark: %+v %v", res, err)
	}
}

// Load tells the mark of every run that has one, before the run is in the service; a repeat after
// the restart finds the run.
func TestStartCallMarkAtLoad(t *testing.T) {
	e := newAPIEnv(t)
	if _, err := e.s.StartCall(e.req(apiID)); err != nil {
		t.Fatal(err)
	}
	e.started("r_ownerrun")
	e.s.svcFlush()
	e.mu.Lock()
	e.log = nil
	e.mu.Unlock()

	e.boot()
	e.wire()
	e.hook()
	inService := true
	e.s.Mark = func(run, client string) {
		_, err := e.s.run(run)
		inService = err == nil
		e.note("mark " + run + " " + client)
	}
	if err := e.s.Load(); err != nil {
		t.Fatal(err)
	}
	if got := e.marks(); !slices.Equal(got, []string{"mark " + apiID + " " + apiClient}) || inService {
		t.Fatalf("marks at load: %v (the run was in the service: %v)", got, inService)
	}
	if c, err := e.s.ClientOf(apiID); err != nil || c != apiClient {
		t.Fatalf("ClientOf after the restart: %q %v", c, err)
	}
	res, err := e.s.StartCall(e.req(apiID))
	if err != nil || !res.Started || res.Made || res.Run.Status != model.RunRunning {
		t.Fatalf("a repeat after the restart: %+v %v", res, err)
	}
	// The one engine start is the first call's, before the restart.
	if got := e.fake.called(); !slices.Equal(got, []string{"start " + apiID}) {
		t.Fatalf("engine calls: %v", got)
	}
}

// 24 calls at once, in a git repository, make one run and leave no creation lock.
func TestStartCallManyAtOnce(t *testing.T) {
	repo := agenttest.NewRepo(t)
	repo.Write("README.md", "hello\n")
	head := repo.Commit("first")
	e := newAPIEnv(t)
	e.s.GitEnv = repo.Env()
	before := e.defaults()

	const n = 24
	var wg sync.WaitGroup
	res := make([]StartResult, n)
	errs := make([]error, n)
	begin := make(chan struct{})
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := e.req(apiID)
			req.Cwd = repo.Dir()
			<-begin
			res[i], errs[i] = e.s.StartCall(req)
		}()
	}
	close(begin)
	wg.Wait()
	made := 0
	for i := range n {
		if errs[i] != nil || !res[i].Started || res[i].Run.ID != apiID || !res[i].Run.Git || res[i].Run.Status != model.RunRunning {
			t.Fatalf("call %d: %+v %v", i, res[i], errs[i])
		}
		if res[i].Made {
			made++
		}
	}
	if made != 1 || e.placed() != 1 {
		t.Fatalf("%d calls made a run, %d group requests", made, e.placed())
	}
	if got := e.fake.called(); !slices.Equal(got, []string{"start " + apiID}) {
		t.Fatalf("engine calls: %v", got)
	}
	if got, want := e.logged(), []string{"run_detail 1", "mark " + apiID + " " + apiClient, "run"}; !slices.Equal(got, want) {
		t.Fatalf("told and sent: %v, want %v", got, want)
	}
	r, _ := e.s.run(apiID)
	if g := svcState(t, r).State.Git; g == nil || g.IntegrationBranch != "aiwb/"+apiID+"/integration" || g.BaseRef != head {
		t.Fatalf("entry 1's git: %+v", g)
	}
	if got := e.runDirs(); !slices.Equal(got, []string{apiID}) || len(e.s.Views()) != 1 || e.locks() != 0 {
		t.Fatalf("folders %v, %d runs, %d creation locks left", got, len(e.s.Views()), e.locks())
	}
	if got := e.defaults(); got != before {
		t.Fatalf("the defaults changed:\n%s", got)
	}
}

// Each refusal leaves no folder, run, group request, mark, event or engine start, and the
// defaults as they were.
func TestStartCallRefusalsLeaveNothing(t *testing.T) {
	blocked := func(reason string) func(error) bool {
		return func(err error) bool {
			var be *BlockedError
			return errors.As(err, &be) && be.Reason == reason
		}
	}
	is := func(target error) func(error) bool {
		return func(err error) bool { return errors.Is(err, target) }
	}
	cases := []struct {
		name   string
		change func(t *testing.T, e *apiEnv, req *StartReq)
		ok     func(error) bool
		places int
	}{
		{name: "a missing folder", change: func(t *testing.T, e *apiEnv, req *StartReq) { req.Cwd = filepath.Join(e.cwd, "gone") },
			ok: func(err error) bool {
				return errors.Is(err, chats.ErrFolderMissing) && strings.HasSuffix(err.Error(), string(filepath.Separator)+"gone")
			}},
		{name: "a file as the folder", change: func(t *testing.T, e *apiEnv, req *StartReq) {
			req.Cwd = filepath.Join(e.cwd, "a-file")
			if err := os.WriteFile(req.Cwd, []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
		}, ok: is(chats.ErrFolderMissing)},
		{name: "the app's own folder", change: func(t *testing.T, e *apiEnv, req *StartReq) {
			req.Cwd = filepath.Join(e.s.Store.P.Root, "inside")
			if err := os.MkdirAll(req.Cwd, 0o700); err != nil {
				t.Fatal(err)
			}
		}, ok: is(chats.ErrAppFolder)},
		{name: "an agent the server lacks", change: func(t *testing.T, e *apiEnv, req *StartReq) {
			e.s.Agents = svcAgents(map[string]bool{"claude": true})
			req.Agent = model.Pi
		}, ok: func(err error) bool {
			var me *usable.MissingError
			return errors.Is(err, usable.ErrMissing) && errors.As(err, &me) && me.Agent == model.Pi && me.Bin == "pi"
		}},
		{name: "an unknown agent kind", change: func(t *testing.T, e *apiEnv, req *StartReq) { req.Agent = "gpt" },
			ok: func(err error) bool { return err != nil && err.Error() == `unknown agent "gpt"` }},
		{name: "a model the catalog lacks", change: func(t *testing.T, e *apiEnv, req *StartReq) { req.Tiers.Light.Model = "nope" },
			ok: func(err error) bool {
				return errors.Is(err, ErrUnknownModel) && err.Error() == `unknown model "nope" (tier light)`
			}},
		{name: "a tier without a model", change: func(t *testing.T, e *apiEnv, req *StartReq) { req.Tiers.Deep.Model = "" }, ok: is(ErrNoModel)},
		{name: "a blank goal", change: func(t *testing.T, e *apiEnv, req *StartReq) { req.Goal = " \n\t" }, ok: is(ErrNoGoal)},
		{name: "a setting out of range", change: func(t *testing.T, e *apiEnv, req *StartReq) { req.Settings.MaxParallel = svcPtr(17) },
			ok: func(err error) bool { return err != nil && err.Error() == "maxParallel must be between 1 and 16" }},
		{name: "a name of 81 characters that is the user's", change: func(t *testing.T, e *apiEnv, req *StartReq) {
			req.Name, req.UserNamed = strings.Repeat("n", 81), true
		}, ok: is(errLongName)},
		{name: "a repository with no commit", change: func(t *testing.T, e *apiEnv, req *StartReq) {
			repo := agenttest.NewRepo(t)
			e.s.GitEnv = repo.Env()
			req.Cwd = repo.Dir()
		}, ok: blocked(svcNoCommit)},
		{name: "a group that cannot be made", change: func(t *testing.T, e *apiEnv, req *StartReq) {
			req.Place = func() (string, error) {
				e.place()
				return "", errors.New("the group cannot be made")
			}
		}, ok: func(err error) bool { return err != nil && err.Error() == "the group cannot be made" }, places: 1},
		{name: "no client", change: func(t *testing.T, e *apiEnv, req *StartReq) { req.Client = "" }, ok: is(ErrStartValue)},
		{name: "no agent", change: func(t *testing.T, e *apiEnv, req *StartReq) { req.Agent = "" }, ok: is(ErrStartValue)},
		{name: "a blank folder", change: func(t *testing.T, e *apiEnv, req *StartReq) { req.Cwd = "  " }, ok: is(ErrStartValue)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := newAPIEnv(t)
			// The owner has defaults of their own, which no refused call may touch.
			if err := e.s.Store.Update(func(st *model.State) error {
				st.Defaults.Groups = map[string]model.GroupDefaults{model.Ungrouped: {}}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			req := e.req(apiID)
			c.change(t, e, &req)
			before := e.defaults()
			res, err := e.s.StartCall(req)
			if !c.ok(err) || res.Started || res.Made || res.Run.ID != "" {
				t.Fatalf("the answer: %+v, error %v", res, err)
			}
			if e.placed() != c.places {
				t.Errorf("%d group requests, want %d", e.placed(), c.places)
			}
			e.nothing(before)
			if _, err := e.s.View(apiID); !errors.Is(err, ErrNotFound) {
				t.Errorf("a read of the id: %v", err)
			}
		})
	}
}

// A write that fails leaves nothing.
func TestStartCallFailedWriteLeavesNothing(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes into a read-only folder")
	}
	e := newAPIEnv(t)
	runsDir := e.s.Store.P.Runs
	if err := os.MkdirAll(runsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(runsDir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(runsDir, 0o700) })
	before := e.defaults()
	res, err := e.s.StartCall(e.req(apiID))
	if err == nil || !errors.Is(err, os.ErrPermission) || res.Started || res.Made {
		t.Fatalf("the answer: %+v, error %v", res, err)
	}
	if e.placed() != 1 {
		t.Fatalf("%d group requests", e.placed())
	}
	e.nothing(before)

	// The disk fails just before run.json: the record is written, the commit point is not reached.
	// One `run_detail` was sent by then; nothing else is left.
	os.Chmod(runsDir, 0o700)
	dir := e.s.Store.P.RunDir(apiID)
	if err := os.MkdirAll(filepath.Join(dir, fileMeta), 0o700); err != nil { // run.json cannot be written over a folder
		t.Fatal(err)
	}
	if res, err := e.s.StartCall(e.req(apiID)); !errors.Is(err, ErrIDTaken) || res.Started {
		t.Fatalf("a folder as run.json: %+v %v", res, err)
	}
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	// run.json's temporary file is a folder: the last write of the start fails.
	req := e.req(apiID)
	req.Place = func() (string, error) {
		e.place()
		return apiGroup, os.MkdirAll(filepath.Join(dir, fileMeta+".tmp", "x"), 0o700)
	}
	res, err = e.s.StartCall(req)
	if err == nil || res.Started || res.Made {
		t.Fatalf("a failed write of run.json: %+v, error %v", res, err)
	}
	if got := e.runDirs(); len(got) != 0 || len(e.s.Views()) != 0 || len(e.marks()) != 0 || len(e.fake.called()) != 0 || e.locks() != 0 {
		t.Fatalf("after the failed write: folders %v, %d runs, marks %v, engine calls %v", got, len(e.s.Views()), e.marks(), e.fake.called())
	}
	if got := e.logged(); !slices.Equal(got, []string{"run_detail 1"}) {
		t.Fatalf("sent: %v", got)
	}
	if got := e.defaults(); got != before {
		t.Fatalf("the defaults changed:\n%s", got)
	}
	// The id is free again.
	if res, err := e.s.StartCall(e.req(apiID)); err != nil || !res.Made {
		t.Fatalf("a start call after the failed one: %+v %v", res, err)
	}
}

// What a start call left when the server ended under it is no run, and the repeat removes it and
// makes the run. A folder with a run.json or with anything else in it is taken and not touched.
func TestStartCallLeftoverOfACutCall(t *testing.T) {
	// files is the folder's content: path below it → bytes ("" for a folder).
	listing := func(t *testing.T, dir string) map[string]string {
		t.Helper()
		out := map[string]string{}
		err := filepath.Walk(dir, func(path string, fi os.FileInfo, err error) error {
			if err != nil || path == dir {
				return err
			}
			rel, _ := filepath.Rel(dir, path)
			if fi.IsDir() {
				out[rel] = ""
				return nil
			}
			b, err := os.ReadFile(path)
			out[rel] = string(b)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	put := func(t *testing.T, dir string, files map[string]string) {
		t.Helper()
		for rel, text := range files {
			path := filepath.Join(dir, rel)
			if text == "" {
				if err := os.MkdirAll(path, 0o700); err != nil {
					t.Fatal(err)
				}
				continue
			}
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}

	t.Run("the leftover is removed by the repeat", func(t *testing.T) {
		for name, files := range map[string]map[string]string{
			"the goal and the journal":       {fileGoal: "An older goal.\n", fileJournal: `{"v":1,"t":1,"kind":"run_started"}` + "\n"},
			"with a checkpoint":              {fileGoal: "An older goal.\n", fileJournal: `{"v":1}` + "\n", fileState: "{}\n", fileTasks: "{}\n", fileTurns: "{}\n", fileAgents: "{}\n"},
			"cut in the write of run.json":   {fileGoal: "An older goal.\n", fileJournal: `{"v":1}` + "\n", fileState: "{}\n", fileMeta + ".tmp": "{"},
			"cut in the write of the goal":   {"." + fileGoal + ".tmp": "An ol"},
			"an empty folder of that name":   {},
			"cut in the write of state.json": {fileGoal: "An older goal.\n", fileJournal: `{"v":1}` + "\n", "." + fileState + ".tmp": "{"},
		} {
			t.Run(name, func(t *testing.T) {
				e := newAPIEnv(t)
				dir := e.s.Store.P.RunDir(apiID)
				if err := os.MkdirAll(dir, 0o700); err != nil {
					t.Fatal(err)
				}
				put(t, dir, files)
				e.restart() // Load skips the folder
				if got := e.s.Views(); len(got) != 0 {
					t.Fatalf("the leftover was loaded: %+v", got)
				}
				if _, err := e.s.View(apiID); !errors.Is(err, ErrNotFound) {
					t.Fatalf("a read of the id: %v", err)
				}
				res, err := e.s.StartCall(e.req(apiID))
				if err != nil || !res.Started || !res.Made {
					t.Fatalf("the repeat: %+v %v", res, err)
				}
				if g, err := e.s.Goal(apiID); err != nil || g.Text != svcGoal {
					t.Fatalf("the goal: %+v %v", g, err)
				}
				r, _ := e.s.run(apiID)
				if es := readEntries(t, r.dir); len(es) != 1 || es[0].Kind != KRunStarted {
					t.Fatalf("the journal: %+v", es)
				}
				for rel := range listing(t, dir) {
					if strings.HasSuffix(rel, ".tmp") {
						t.Fatalf("%s is left in the run's folder", rel)
					}
				}
				// And it is a run after the next restart.
				e.restart()
				if v, err := e.s.View(apiID); err != nil || v.Status != model.RunRunning {
					t.Fatalf("after a restart: %+v %v", v, err)
				}
			})
		}
	})

	t.Run("another folder is taken and not touched", func(t *testing.T) {
		for name, files := range map[string]map[string]string{
			"an unreadable run.json":       {fileMeta: "{", fileGoal: "An older goal.\n"},
			"the run.json of another id":   {fileMeta: `{"id":"r_other000","name":"x","group":"ungrouped"}` + "\n"},
			"a chats folder":               {"chats": "", fileGoal: "An older goal.\n", fileJournal: `{"v":1}` + "\n"},
			"a file a start does not make": {fileGoal: "An older goal.\n", "notes.txt": "mine\n"},
			"a folder named as the goal":   {fileGoal: ""},
			"an attempt's text":            {fileJournal: `{"v":1}` + "\n", "tasks/T1/brief.1.md": "Do it.\n"},
		} {
			t.Run(name, func(t *testing.T) {
				e := newAPIEnv(t)
				dir := e.s.Store.P.RunDir(apiID)
				put(t, dir, files)
				e.restart()
				before, defs := listing(t, dir), e.defaults()
				res, err := e.s.StartCall(e.req(apiID))
				if !errors.Is(err, ErrIDTaken) || res.Started || res.Made {
					t.Fatalf("the answer: %+v %v", res, err)
				}
				if after := listing(t, dir); !svcSameJSON(after, before) {
					t.Fatalf("the folder changed: %v, was %v", after, before)
				}
				if got := e.s.Views(); len(got) != 0 || e.placed() != 0 || len(e.logged()) != 0 || len(e.fake.called()) != 0 || e.locks() != 0 || e.defaults() != defs {
					t.Fatalf("the refused call left something: runs %+v, %d group requests, log %v", got, e.placed(), e.logged())
				}
			})
		}
	})

	t.Run("a file with the id's name", func(t *testing.T) {
		e := newAPIEnv(t)
		if err := os.MkdirAll(e.s.Store.P.Runs, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(e.s.Store.P.RunDir(apiID), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if res, err := e.s.StartCall(e.req(apiID)); !errors.Is(err, ErrIDTaken) || res.Started {
			t.Fatalf("the answer: %+v %v", res, err)
		}
		if b, err := os.ReadFile(e.s.Store.P.RunDir(apiID)); err != nil || string(b) != "x" {
			t.Fatalf("the file: %q %v", b, err)
		}
	})
}

// An id of another form is refused before anything is looked at.
func TestStartCallIDsOfOtherForms(t *testing.T) {
	e := newAPIEnv(t)
	before := e.defaults()
	bad := []string{"", "r_", "r_ABCDEFGH", "r_Abcdefgh", "r_1234567", "r_123456789", "../../etc", "r_/../etc0", "a/b", "r_ab/cdefg", "r_ab.cdefg",
		"r_abcdefg.", "..", ".", "c_abcdefgh", "x_12345678", "R_abcdefgh", "rabcdefghi", "123e4567-e89b-42d3-a456-426614174000", "r_abcdefgh\n",
		"r_abcdefg\n", " r_abcdefg", " r_abcdefgh", "r_abcdefgh ", "r_abcdéfg", "r_abcdefgé", "r_abc\x00efgh", "r_abc defg", "r_abc-defg", "r_abc_defg",
		"check", "r_%2e%2e%2f1"}
	for _, id := range bad {
		if ValidID(id) {
			t.Errorf("ValidID(%q)", id)
		}
		req := e.req(id)
		if res, err := e.s.StartCall(req); !errors.Is(err, ErrBadID) || res.Started || res.Made {
			t.Errorf("id %q: %+v %v", id, res, err)
		}
	}
	if e.placed() != 0 {
		t.Errorf("%d group requests", e.placed())
	}
	e.nothing(before)
	if ents, _ := os.ReadDir(filepath.Dir(e.root)); len(ents) != 1 {
		t.Errorf("beside the data folder: %v", ents)
	}
	for _, id := range []string{"r_abcdefgh", "r_00000000", "r_zzzzzzzz", "r_0a1b2c3d", model.NewID("r_")} {
		if !ValidID(id) {
			t.Errorf("!ValidID(%q)", id)
		}
	}
}

// The name: the user's is kept, else the goal names the run, else the given name, else "New run".
// The settings are the call's on top of the built-in ones.
func TestStartCallNameAndSettings(t *testing.T) {
	e := newAPIEnv(t)
	// The owner's group has sticky run settings; a start call takes none of them.
	if err := e.s.Store.Update(func(st *model.State) error {
		st.Defaults.Groups = map[string]model.GroupDefaults{apiGroup: {Servers: map[string]model.ServerDefaults{
			model.LocalServer: {Run: &model.RunDefaults{Agent: model.Claude, MaxParallel: 3, MaxTurns: 7, MaxCost: 2, Setup: "make", SetupCwd: e.cwd}},
		}}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	const noName = "---\n\n42\n" // a goal with no line that names a run
	cases := []struct {
		id, name string
		user     bool
		goal     string
		want     string
		wantUser bool
	}{
		{"r_name0001", "  My run  ", true, svcGoal, "My run", true},
		{"r_name0002", "Their label", false, svcGoal, "Port the importer", false},
		{"r_name0003", "", false, svcGoal, "Port the importer", false},
		{"r_name0004", "Their label", false, noName, "Their label", false},
		{"r_name0005", "", false, noName, DefaultName, false},
		{"r_name0006", strings.Repeat("n", 81), false, noName, DefaultName, false},
	}
	for _, c := range cases {
		req := e.req(c.id)
		req.Name, req.UserNamed, req.Goal = c.name, c.user, c.goal
		res, err := e.s.StartCall(req)
		if err != nil || res.Run.Name != c.want || res.Run.UserNamed != c.wantUser || res.Run.Settings != model.DefaultRunSettings() {
			t.Errorf("%s: name %q (the user's: %v), settings %+v, %v", c.id, res.Run.Name, res.Run.UserNamed, res.Run.Settings, err)
		}
	}
	for _, name := range []string{"", "   ", "a\x07b"} {
		req := e.req("r_name0009")
		req.Name, req.UserNamed = name, true
		if res, err := e.s.StartCall(req); err == nil || res.Started {
			t.Errorf("a user's name %q: %+v %v", name, res, err)
		}
	}

	req := e.req("r_set00001")
	req.Settings = SettingsPatch{MaxParallel: svcPtr(2), MaxTurns: svcPtr(500), MaxCost: svcPtr(1.5), Setup: svcPtr("npm ci"), Wake: svcPtr("idle"), ApplyResult: svcPtr("manual")}
	res, err := e.s.StartCall(req)
	want := model.DefaultRunSettings()
	want.MaxParallel, want.MaxTurns, want.MaxCost, want.Setup, want.Wake, want.ApplyResult = 2, 500, 1.5, "npm ci", "idle", "manual"
	if err != nil || res.Run.Settings != want {
		t.Fatalf("the settings: %+v %v", res.Run.Settings, err)
	}
	// A folder with ~ or a relative path is resolved on this machine.
	req = e.req("r_cwd00001")
	req.Cwd = e.cwd + string(filepath.Separator) + "." + string(filepath.Separator)
	if res, err := e.s.StartCall(req); err != nil || res.Run.Cwd != e.cwd {
		t.Fatalf("the folder: %q %v", res.Run.Cwd, err)
	}
}

// A run with a client mark reads no defaults and records none, on any path.
func TestStartCallNoDefaults(t *testing.T) {
	t.Run("a start call, the owner's move, a stop and a resume", func(t *testing.T) {
		e := newAPIEnv(t)
		svcGroupAdd(t, e.s, model.Group{ID: "g_one", Name: "One"})
		svcGroupAdd(t, e.s, model.Group{ID: apiGroup, Name: "Remote"})
		// The owner's own run gives g_one sticky run defaults.
		own, err := e.s.Create("g_one", "")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.s.Patch(own.ID, PatchReq{Settings: &SettingsPatch{MaxParallel: svcPtr(3)}}); err != nil {
			t.Fatal(err)
		}
		if _, err := e.s.Start(own.ID, svcGoal); err != nil {
			t.Fatal(err)
		}
		before := e.defaults()
		if !strings.Contains(before, `"maxParallel":3`) {
			t.Fatalf("the owner's start recorded no run defaults:\n%s", before)
		}
		e.events()

		req := e.req(apiID)
		req.Agent, req.Tiers = model.Pi, tiersAll("some-model", "high")
		req.Settings = SettingsPatch{MaxParallel: svcPtr(5), Setup: svcPtr("make deps")}
		if _, err := e.s.StartCall(req); err != nil {
			t.Fatal(err)
		}
		check := func(after string) {
			t.Helper()
			if got := e.defaults(); got != before {
				t.Fatalf("the defaults changed after %s:\n%s\nbefore:\n%s", after, got, before)
			}
			if kinds := svcKinds(e.events()); slices.Contains(kinds, "defaults") {
				t.Fatalf("a defaults event after %s: %v", after, kinds)
			}
		}
		check("the start call")
		if err := e.s.Move(apiID, "g_one"); err != nil {
			t.Fatal(err)
		}
		check("the move")
		if c, _ := e.s.ClientOf(apiID); c != apiClient {
			t.Fatalf("the moved run's mark: %q", c)
		}
		if v, err := e.s.Stop(apiID); err != nil || v.Status != model.RunStopped {
			t.Fatalf("stop: %+v %v", v, err)
		}
		check("the stop")
		if v, err := e.s.Resume(apiID, ResumeReq{}); err != nil || v.Status != model.RunRunning {
			t.Fatalf("resume: %+v %v", v, err)
		}
		check("the resume")
		if _, err := e.s.Patch(apiID, PatchReq{Name: svcPtr("Renamed")}); err != nil {
			t.Fatal(err)
		}
		check("the rename")
		// The agent of a run with a mark cannot be changed: such a run is always started.
		if _, err := e.s.Patch(apiID, PatchReq{Agent: svcPtr(model.Claude)}); !errors.Is(err, ErrStarted) {
			t.Fatalf("a patch of the agent: %v", err)
		}
		check("the refused patch")
		// A new draft of the owner in the run's group takes the owner's defaults, not the run's.
		if v, err := e.s.Create("g_one", ""); err != nil || v.Agent != model.Claude || v.Settings.MaxParallel != 3 || v.Settings.Setup != "" {
			t.Fatalf("the owner's next draft: %+v %v", v, err)
		}
	})

	t.Run("Start of a draft with a mark records none", func(t *testing.T) {
		e := newAPIEnv(t)
		meta := model.RunMeta{ID: "r_markdrft", Name: DefaultName, Group: model.Ungrouped, Created: e.clock.Now(), Agent: model.Claude,
			Tiers: tiersAll("sonnet", ""), Cwd: e.cwd, Settings: model.DefaultRunSettings(), Client: apiClient}
		if err := writeMeta(e.s.Store.P.RunDir(meta.ID), meta); err != nil {
			t.Fatal(err)
		}
		e.s.add(newRun(e.s, meta))
		before := e.defaults()
		v, err := e.s.Start(meta.ID, svcGoal)
		if err != nil || v.Status != model.RunRunning {
			t.Fatalf("start: %+v %v", v, err)
		}
		if got := e.defaults(); got != before {
			t.Fatalf("the defaults changed:\n%s", got)
		}
		if kinds := svcKinds(e.events()); slices.Contains(kinds, "defaults") || !slices.Contains(kinds, "run") {
			t.Fatalf("events: %v", kinds)
		}
		if got := e.fake.called(); !slices.Equal(got, []string{"start " + meta.ID}) {
			t.Fatalf("engine calls: %v", got)
		}
		// The same draft without a mark records them: the guard is the mark.
		own := e.draft("r_owndraft")
		if _, err := e.s.Start(own.id, svcGoal); err != nil {
			t.Fatal(err)
		}
		if got := e.defaults(); got == before {
			t.Fatal("the owner's start recorded no defaults")
		}
		if kinds := svcKinds(e.events()); !slices.Contains(kinds, "defaults") {
			t.Fatalf("events of the owner's start: %v", kinds)
		}
	})

	t.Run("the facts give no tier defaults for a mark", func(t *testing.T) {
		e := newAPIEnv(t)
		meta := model.RunMeta{ID: "r_facts001", Group: model.Ungrouped, Agent: model.Claude, Cwd: e.cwd}
		if f, _ := e.s.svcFacts(meta, svcRec{}); f.TierDefaults == (model.RunTiers{}) {
			t.Fatal("a draft without a mark has no tier defaults")
		}
		meta.Client = apiClient
		if f, _ := e.s.svcFacts(meta, svcRec{}); f.TierDefaults != (model.RunTiers{}) || f.FolderMissing || f.Blocked != "" {
			t.Fatalf("the facts for a mark: %+v", f)
		}
	})
}

// ViewsOf and ClientOf give one client's runs; ViewsOf takes no run's lock.
func TestViewsOfAndClientOf(t *testing.T) {
	e := newAPIEnv(t)
	if got := e.s.ViewsOf(apiClient); got == nil || len(got) != 0 {
		t.Fatalf("ViewsOf with no runs: %#v", got)
	}
	start := func(id, client string) {
		t.Helper()
		req := e.req(id)
		req.Client = client
		if _, err := e.s.StartCall(req); err != nil {
			t.Fatal(err)
		}
		e.clock.Advance(time.Second)
	}
	start("r_zzzzzzz1", apiClient)
	start("r_two00001", "c-two")
	start("r_aaaaaaa1", apiClient)
	e.started("r_ownerrun")
	e.draft("r_ownerdrf")

	ids := func(vs []model.RunView) []string {
		out := []string{}
		for _, v := range vs {
			out = append(out, v.ID)
		}
		return out
	}
	if got := ids(e.s.ViewsOf(apiClient)); !slices.Equal(got, []string{"r_zzzzzzz1", "r_aaaaaaa1"}) {
		t.Fatalf("ViewsOf(%s): %v", apiClient, got)
	}
	if got := ids(e.s.ViewsOf("c-two")); !slices.Equal(got, []string{"r_two00001"}) {
		t.Fatalf("ViewsOf(c-two): %v", got)
	}
	for _, c := range []string{"", "c-three"} {
		if got := e.s.ViewsOf(c); got == nil || len(got) != 0 {
			t.Fatalf("ViewsOf(%q): %#v", c, got)
		}
	}
	if b, _ := json.Marshal(e.s.ViewsOf("")); string(b) != "[]" {
		t.Fatalf("ViewsOf of nobody as JSON: %s", b)
	}
	if len(e.s.Views()) != 5 {
		t.Fatalf("Views: %d runs", len(e.s.Views()))
	}
	for id, want := range map[string]string{"r_zzzzzzz1": apiClient, "r_two00001": "c-two", "r_ownerrun": "", "r_ownerdrf": ""} {
		if c, err := e.s.ClientOf(id); err != nil || c != want {
			t.Errorf("ClientOf(%s): %q %v", id, c, err)
		}
	}
	if _, err := e.s.ClientOf("r_nosuch00"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ClientOf of no run: %v", err)
	}
	// The mark is not in the view.
	if b, _ := json.Marshal(e.s.ViewsOf(apiClient)); strings.Contains(string(b), apiClient) {
		t.Fatalf("the view carries the mark: %s", b)
	}

	// Another goroutine holds a run's lock: ViewsOf and ClientOf return all the same.
	r, _ := e.s.run("r_zzzzzzz1")
	r.mu.Lock()
	done := make(chan int, 1)
	go func() {
		n := len(e.s.ViewsOf(apiClient))
		e.s.ClientOf("r_zzzzzzz1")
		done <- n
	}()
	select {
	case n := <-done:
		r.mu.Unlock()
		if n != 2 {
			t.Fatalf("ViewsOf under a run's lock: %d runs", n)
		}
	case <-time.After(5 * time.Second):
		r.mu.Unlock()
		t.Fatal("ViewsOf waits for a run's lock")
	}
}

// A delete that arrives while a start call of that id is under way waits for it and then removes
// what it made.
func TestStartCallDeleteWaitsForIt(t *testing.T) {
	e := newAPIEnv(t)
	inPlace, release := make(chan struct{}), make(chan struct{})
	req := e.req(apiID)
	req.Place = func() (string, error) {
		close(inPlace)
		<-release
		return e.place()
	}
	type answer struct {
		res StartResult
		err error
	}
	started, deleted := make(chan answer, 1), make(chan error, 1)
	go func() {
		res, err := e.s.StartCall(req)
		started <- answer{res, err}
	}()
	<-inPlace
	go func() { deleted <- e.s.Delete(apiID) }()
	// The delete waits on the creation lock: the start call holds it, the delete is its one waiter.
	svcWait(t, "the delete to wait on the creation lock", func() bool {
		e.s.starts.mu.Lock()
		defer e.s.starts.mu.Unlock()
		k := e.s.starts.m[apiID]
		return k != nil && k.n == 2
	})
	select {
	case err := <-deleted:
		t.Fatalf("the delete did not wait: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	if len(e.s.Views()) != 0 {
		t.Fatal("the run is listed before its commit point")
	}
	close(release)
	a := <-started
	if a.err != nil || !a.res.Started || !a.res.Made {
		t.Fatalf("the start call: %+v %v", a.res, a.err)
	}
	if err := <-deleted; err != nil {
		t.Fatalf("the delete: %v", err)
	}
	// The run's `run` event is sent unless the delete was there first; `run_removed` is the last.
	got := e.logged()
	withRun := []string{"run_detail 1", "mark " + apiID + " " + apiClient, "run", "run_removed"}
	without := []string{"run_detail 1", "mark " + apiID + " " + apiClient, "run_removed"}
	if !slices.Equal(got, withRun) && !slices.Equal(got, without) {
		t.Fatalf("told and sent: %v", got)
	}
	if dirs := e.runDirs(); len(dirs) != 0 || len(e.s.Views()) != 0 || e.locks() != 0 {
		t.Fatalf("after the delete: folders %v, %d runs, %d creation locks", dirs, len(e.s.Views()), e.locks())
	}
	if _, err := e.s.View(apiID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a read of the id: %v", err)
	}
	if err := e.s.Delete(apiID); !errors.Is(err, ErrNotFound) || e.locks() != 0 {
		t.Fatalf("a delete of no run: %v, %d creation locks", err, e.locks())
	}
}

// A start call after a delete of that id sets the mark only after the old `run_removed` was sent:
// whoever routes the events drops the id's mark after that event.
func TestStartCallAfterDeleteSetsTheMarkAfterRunRemoved(t *testing.T) {
	e := newAPIEnv(t)
	if _, err := e.s.StartCall(e.req(apiID)); err != nil {
		t.Fatal(err)
	}
	e.s.svcFlush()
	e.mu.Lock()
	e.hold = 100 * time.Millisecond
	e.mu.Unlock()
	if err := e.s.Delete(apiID); err != nil {
		t.Fatal(err)
	}
	res, err := e.s.StartCall(e.req(apiID))
	if err != nil || !res.Started || !res.Made {
		t.Fatalf("the start call after the delete: %+v %v", res, err)
	}
	mark := "mark " + apiID + " " + apiClient
	want := []string{"run_detail 1", mark, "run", "run_removed", "run_detail 1", mark, "run"}
	if got := e.logged(); !slices.Equal(got, want) {
		t.Fatalf("told and sent: %v\nwant %v", got, want)
	}
	if evs := svcRunEvents(e.allEvents(), apiID); len(evs) != 2 || evs[1].Status != model.RunRunning {
		t.Fatalf("the run events: %+v", evs)
	}
	if c, err := e.s.ClientOf(apiID); err != nil || c != apiClient || e.locks() != 0 {
		t.Fatalf("the new run: mark %q, %v, %d creation locks", c, err, e.locks())
	}
}

// The creation lock: one holder per id at a time, other ids go on, and no entry stays.
func TestIDLocks(t *testing.T) {
	var l idLocks
	unlockA := l.lock("a")
	unlockB := l.lock("b") // another id does not wait
	var mu sync.Mutex
	inside, most := 0, 0
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer l.lock("a")()
			mu.Lock()
			inside++
			most = max(most, inside)
			mu.Unlock()
			time.Sleep(time.Millisecond)
			mu.Lock()
			inside--
			mu.Unlock()
		}()
	}
	svcWait(t, "16 waiters", func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		return l.m["a"].n == 17
	})
	mu.Lock()
	if inside != 0 {
		t.Fatal("a waiter got the lock while it was held")
	}
	mu.Unlock()
	unlockA()
	wg.Wait()
	unlockB()
	if most != 1 || len(l.m) != 0 {
		t.Fatalf("%d holders at once, %d entries left", most, len(l.m))
	}
}

// The draft check: what a draft of an agent in a folder would show, with nothing written.
func TestCheckDraft(t *testing.T) {
	e := newAPIEnv(t)
	// The group's defaults name a model: the draft check reads none of it.
	if err := e.s.Store.Update(func(st *model.State) error {
		st.Defaults.Groups = map[string]model.GroupDefaults{model.Ungrouped: {}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	dirty := agenttest.NewRepo(t)
	dirty.Write("a.txt", "one\n")
	dirty.Commit("first")
	dirty.Write("new.txt", "untracked\n")
	clean := agenttest.NewRepo(t)
	clean.Write("a.txt", "one\n")
	clean.Commit("first")
	if err := os.MkdirAll(filepath.Join(clean.Dir(), "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	unborn := agenttest.NewRepo(t)
	e.s.GitEnv = dirty.Env()
	file := filepath.Join(e.cwd, "a-file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := e.defaults()
	home, _ := os.UserHomeDir()

	cases := []struct {
		name  string
		agent model.AgentKind
		cwd   string
		setup func()
		want  DraftFacts
	}{
		{name: "a repository with an untracked file", agent: model.Claude, cwd: dirty.Dir(), want: DraftFacts{Cwd: dirty.Dir(), Git: true, Dirty: true}},
		{name: "a clean repository, a folder below its top", agent: model.Cursor, cwd: filepath.Join(clean.Dir(), "sub"),
			want: DraftFacts{Cwd: filepath.Join(clean.Dir(), "sub"), Git: true}},
		{name: "a plain folder", agent: model.Claude, cwd: e.cwd, want: DraftFacts{Cwd: e.cwd}},
		{name: "a plain folder, written with a dot", agent: model.Pi, cwd: " " + e.cwd + "/./ ", want: DraftFacts{Cwd: e.cwd}},
		{name: "a missing folder", agent: model.Claude, cwd: filepath.Join(e.cwd, "gone"), want: DraftFacts{Cwd: filepath.Join(e.cwd, "gone"), FolderMissing: true}},
		{name: "a missing folder below the home folder", agent: model.Claude, cwd: "~/no-such-folder-of-the-draft-check",
			want: DraftFacts{Cwd: filepath.Join(home, "no-such-folder-of-the-draft-check"), FolderMissing: true}},
		{name: "a file", agent: model.Claude, cwd: file, want: DraftFacts{Cwd: file, FolderMissing: true}},
		{name: "a repository with no commit", agent: model.Claude, cwd: unborn.Dir(), want: DraftFacts{Cwd: unborn.Dir(), Git: true, Blocked: svcNoCommit}},
		{name: "no agent, none usable", agent: "", cwd: e.cwd, setup: func() { e.s.Agents = svcAgents(map[string]bool{}) },
			want: DraftFacts{Cwd: e.cwd, Blocked: usable.ErrNone.Error()}},
		{name: "no agent, one usable", agent: "", cwd: e.cwd, setup: func() { e.s.Agents = svcAgents(map[string]bool{"pi": true}) },
			want: DraftFacts{Cwd: e.cwd, Blocked: usable.ErrUnchosen.Error()}},
		{name: "an agent whose program is not found", agent: model.Cursor, cwd: e.cwd,
			setup: func() { e.s.Bins = map[model.AgentKind]string{model.Cursor: "no-such-program-of-the-draft-check"} },
			want:  DraftFacts{Cwd: e.cwd, Blocked: "Cursor's program was not found: install it, then start the run"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e.s.Agents, e.s.Bins = nil, nil
			if c.setup != nil {
				c.setup()
			}
			got, err := e.s.CheckDraft(c.agent, c.cwd)
			if err != nil || got != c.want {
				t.Fatalf("CheckDraft(%q, %q) = %+v, %v\nwant %+v", c.agent, c.cwd, got, err, c.want)
			}
		})
	}
	e.s.Agents, e.s.Bins = nil, nil

	t.Run("the data folder's name in the path", func(t *testing.T) {
		// A folder outside the data folder whose path holds the data folder's name.
		dir := filepath.Join(t.TempDir(), filepath.Base(e.root)+"-copy")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		got, err := e.s.CheckDraft(model.Claude, dir)
		if err != nil || got.Cwd != dir || got.FolderMissing || got.Git || got.Dirty || !strings.HasPrefix(got.Blocked, "the data folder's name ("+filepath.Base(e.root)+") is part of") {
			t.Fatalf("CheckDraft: %+v %v", got, err)
		}
		// The data folder itself.
		got, err = e.s.CheckDraft(model.Claude, e.root)
		if err != nil || got.Cwd != e.root || !strings.HasPrefix(got.Blocked, "the data folder's name (") {
			t.Fatalf("CheckDraft of the data folder: %+v %v", got, err)
		}
	})

	t.Run("refused values", func(t *testing.T) {
		for _, c := range []struct {
			agent model.AgentKind
			cwd   string
		}{{model.Claude, ""}, {model.Claude, " \t"}, {"gpt", e.cwd}, {"Claude", e.cwd}, {"", ""}} {
			if got, err := e.s.CheckDraft(c.agent, c.cwd); !errors.Is(err, ErrStartValue) || got != (DraftFacts{}) {
				t.Errorf("CheckDraft(%q, %q) = %+v, %v", c.agent, c.cwd, got, err)
			}
		}
	})

	t.Run("every field is in the JSON", func(t *testing.T) {
		b, err := json.Marshal(DraftFacts{})
		if err != nil || string(b) != `{"cwd":"","folderMissing":false,"git":false,"dirty":false,"blocked":""}` {
			t.Fatalf("%s %v", b, err)
		}
	})

	// Nothing was written, sent, told or started, and no run was made.
	e.nothing(before)
	if _, err := os.Stat(e.s.Store.P.RunWorkDir(svcCheckID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the draft check's work folder: %v", err)
	}
	if e.placed() != 0 {
		t.Fatalf("%d group requests", e.placed())
	}
}

// The model's error names the sentinel and keeps its text.
func TestUnknownModelIsASentinel(t *testing.T) {
	_, err := svcModel(&model.Catalog{Models: []model.CatalogModel{{ID: "a"}}}, "x")
	if !errors.Is(err, ErrUnknownModel) || err.Error() != `unknown model "x"` {
		t.Fatalf("svcModel: %v", err)
	}
}

// A run made by a start call is the real engine's like any other: it runs to its end, with and
// without git, and the mark is told before the engine's first agent.
func TestStartCallRunsOnTheEngine(t *testing.T) {
	for _, git := range []bool{false, true} {
		t.Run(fmt.Sprintf("git %v", git), func(t *testing.T) {
			t.Parallel()
			e := newEngEnv(t, git)
			var mu sync.Mutex
			var told []string
			e.s.Mark = func(run, client string) {
				mu.Lock()
				defer mu.Unlock()
				told = append(told, "mark "+run+" "+client)
			}
			e.host.setOn(func(m *engMsg) {
				mu.Lock()
				told = append(told, m.Name)
				mu.Unlock()
				if m.Name == "turn-001" {
					r, err := e.s.run(apiID)
					if err != nil {
						t.Errorf("the run is not in the service when its first agent runs: %v", err)
						return
					}
					e.finishRun(r, 1, model.Achieved)
					m.Say("Nothing to do.")
				}
			})
			res, err := e.s.StartCall(StartReq{ID: apiID, Client: apiClient, Agent: model.Claude, Tiers: tiersAll("sonnet", ""), Cwd: e.cwd, Goal: svcGoal})
			if err != nil || !res.Started || !res.Made || res.Run.Git != git || res.Run.Group != model.Ungrouped {
				t.Fatalf("the start call: %+v %v", res, err)
			}
			r, _ := e.s.run(apiID)
			engStatus(t, r, model.RunCompleted)
			mu.Lock()
			got := slices.Clone(told)
			mu.Unlock()
			if want := []string{"mark " + apiID + " " + apiClient, "turn-001"}; !slices.Equal(got, want) {
				t.Fatalf("told and run: %v, want %v", got, want)
			}
			again, err := e.s.StartCall(StartReq{ID: apiID, Client: apiClient, Agent: model.Pi, Cwd: "/nowhere"})
			if err != nil || !again.Started || again.Made || again.Run.Status != model.RunCompleted || again.Run.Outcome != model.Achieved {
				t.Fatalf("a repeat after the end: %+v %v", again, err)
			}
			if vs := e.s.ViewsOf(apiClient); len(vs) != 1 || vs[0].Status != model.RunCompleted {
				t.Fatalf("ViewsOf: %+v", vs)
			}
		})
	}
}

// An id whose earlier run left a branch in the folder's repository, or a work folder, makes no
// run: the new run's checkout would be made on what was left. Once that is gone the call succeeds.
func TestStartCallRefusesAnIDThatLeftABranchOrAWorkFolder(t *testing.T) {
	setup := func(t *testing.T) (*apiEnv, *agenttest.Repo, StartReq) {
		repo := agenttest.NewRepo(t)
		repo.Write("README.md", "hello\n")
		repo.Commit("first")
		e := newAPIEnv(t)
		e.s.GitEnv = repo.Env()
		req := e.req(apiID)
		req.Cwd = repo.Dir()
		return e, repo, req
	}
	t.Run("a branch", func(t *testing.T) {
		e, repo, req := setup(t)
		// What a deleted run with an unapplied result leaves: its integration branch, ahead of HEAD.
		branch := svcIntegrationBranch(apiID)
		repo.Git("checkout", "-q", "-b", branch)
		repo.Write("old.txt", "the deleted run's work\n")
		repo.Commit("the deleted run's result")
		repo.Git("checkout", "-q", "-")
		head := repo.Git("rev-parse", "HEAD")
		if n := repo.Git("rev-list", "--count", "HEAD.."+branch); n != "1" {
			t.Fatalf("the branch is %s commits ahead of HEAD", n)
		}
		before := e.defaults()
		if res, err := e.s.StartCall(req); !errors.Is(err, ErrIDTaken) || res.Started || res.Made {
			t.Fatalf("with the branch left: %+v %v", res, err)
		}
		e.nothing(before)
		if e.placed() != 0 {
			t.Errorf("the group was asked for %d times", e.placed())
		}
		// Another id in the same repository is not held up by it.
		other := req
		other.ID = "r_start002"
		if res, err := e.s.StartCall(other); err != nil || !res.Made {
			t.Fatalf("another id: %+v %v", res, err)
		}
		if err := e.s.Delete(other.ID); err != nil {
			t.Fatal(err)
		}

		repo.Git("branch", "-D", branch)
		res, err := e.s.StartCall(req)
		if err != nil || !res.Started || !res.Made || !res.Run.Git {
			t.Fatalf("with the branch deleted: %+v %v", res, err)
		}
		r, _ := e.s.run(apiID)
		if g := r.engGit(); g == nil || g.BaseRef != head {
			t.Fatalf("the run's git: %+v, HEAD %s", g, head)
		}
	})
	t.Run("the work folder", func(t *testing.T) {
		for _, git := range []bool{true, false} {
			e, _, req := setup(t)
			if !git {
				req.Cwd = e.cwd
			}
			work := e.s.Store.P.RunWorkDir(apiID)
			if err := os.MkdirAll(filepath.Join(work, "int"), 0o700); err != nil {
				t.Fatal(err)
			}
			before := e.defaults()
			if res, err := e.s.StartCall(req); !errors.Is(err, ErrIDTaken) || res.Started || res.Made {
				t.Fatalf("git %v, with the work folder left: %+v %v", git, res, err)
			}
			e.nothing(before)
			if e.placed() != 0 {
				t.Errorf("git %v: the group was asked for %d times", git, e.placed())
			}
			if _, err := os.Stat(filepath.Join(work, "int")); err != nil {
				t.Fatalf("git %v: the work folder was touched: %v", git, err)
			}
			if err := os.RemoveAll(work); err != nil {
				t.Fatal(err)
			}
			if res, err := e.s.StartCall(req); err != nil || !res.Made || res.Run.Git != git {
				t.Fatalf("git %v, with the work folder gone: %+v %v", git, res, err)
			}
		}
	})
}

// The owner deletes or archives the group a start call was given while the run is in no list: the
// call asks for a group once more and the run ends in that one.
func TestStartCallGroupGoneUnderIt(t *testing.T) {
	drop := func(st *model.State, id string) {
		st.Groups = slices.DeleteFunc(st.Groups, func(g model.Group) bool { return g.ID == id })
	}
	archive := func(st *model.State, id string) {
		for i := range st.Groups {
			if st.Groups[i].ID == id {
				st.Groups[i].Archived = true
			}
		}
	}
	for name, lose := range map[string]func(st *model.State, id string){"deleted": drop, "archived": archive} {
		t.Run(name, func(t *testing.T) {
			e := newAPIEnv(t)
			asked := 0
			// place is the server's: the group "Remote", made when there is none that can be used.
			place := func() (string, error) {
				asked++
				id := fmt.Sprintf("g_remote%d", asked)
				svcGroupAdd(t, e.s, model.Group{ID: id, Name: "Remote"})
				if asked == 1 {
					// The owner's click, in the window in which the run is in no list.
					if err := e.s.Store.Update(func(st *model.State) error { lose(st, id); return nil }); err != nil {
						t.Fatal(err)
					}
				}
				return id, nil
			}
			req := e.req(apiID)
			req.Place = place
			res, err := e.s.StartCall(req)
			if err != nil || !res.Started || !res.Made {
				t.Fatalf("the start call: %+v %v", res, err)
			}
			if asked != 2 {
				t.Fatalf("the group was asked for %d times", asked)
			}
			v, err := e.s.View(apiID)
			if err != nil {
				t.Fatal(err)
			}
			if exists, archived := e.s.svcGroup(v.Group); v.Group != "g_remote2" || res.Run.Group != v.Group || !exists || archived {
				t.Fatalf("the run's group: %q (the answer's %q), exists %v, archived %v", v.Group, res.Run.Group, exists, archived)
			}
			r, _ := e.s.run(apiID)
			if m := svcMetaOnDisk(t, r); m.Group != v.Group || m.Started.IsZero() {
				t.Fatalf("run.json: %+v", m)
			}
			// One `run` event, and it has the group the run is in.
			want := []string{"run_detail 1", "mark " + apiID + " " + apiClient, "run"}
			if got := e.logged(); !slices.Equal(got, want) {
				t.Fatalf("told and sent: %v", got)
			}
			if evs := svcRunEvents(e.allEvents(), apiID); len(evs) != 1 || evs[0].Group != v.Group {
				t.Fatalf("the run events: %+v", evs)
			}
		})
	}
	// The second group is gone as well: the run is left where it was, started.
	t.Run("twice", func(t *testing.T) {
		e := newAPIEnv(t)
		asked := 0
		req := e.req(apiID)
		req.Place = func() (string, error) {
			asked++
			return "g_nosuch", nil
		}
		res, err := e.s.StartCall(req)
		if err != nil || !res.Made || asked != 2 || res.Run.Group != "g_nosuch" {
			t.Fatalf("the start call: %+v %v, asked %d times", res, err, asked)
		}
	})
}

// AwaitStart waits for a start call of the id that is under way, and leaves no lock entry.
func TestAwaitStart(t *testing.T) {
	e := newAPIEnv(t)
	inPlace, release := make(chan struct{}), make(chan struct{})
	req := e.req(apiID)
	req.Place = func() (string, error) {
		close(inPlace)
		<-release
		return e.place()
	}
	started := make(chan error, 1)
	go func() {
		_, err := e.s.StartCall(req)
		started <- err
	}()
	<-inPlace
	awaited := make(chan struct{})
	go func() {
		e.s.AwaitStart(apiID)
		close(awaited)
	}()
	svcWait(t, "AwaitStart to wait on the creation lock", func() bool {
		e.s.starts.mu.Lock()
		defer e.s.starts.mu.Unlock()
		k := e.s.starts.m[apiID]
		return k != nil && k.n == 2
	})
	// Another id, and an id of another form, do not wait.
	e.s.AwaitStart("r_start002")
	select {
	case <-awaited:
		t.Fatal("AwaitStart did not wait for the start call")
	case <-time.After(30 * time.Millisecond):
	}
	if _, err := e.s.View(apiID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a read under the start call: %v", err)
	}
	close(release)
	select {
	case <-awaited:
	case <-time.After(10 * time.Second):
		t.Fatal("AwaitStart did not return after the start call")
	}
	if v, err := e.s.View(apiID); err != nil || v.ID != apiID {
		t.Fatalf("a read after AwaitStart: %+v %v", v, err)
	}
	if err := <-started; err != nil {
		t.Fatal(err)
	}
	if n := e.locks(); n != 0 {
		t.Fatalf("%d creation locks left", n)
	}
	// An id of another form returns at once and makes no entry, also while such an entry is held.
	for _, id := range []string{"", "r_", "R_START001", "r_start0011", "../r_start001", strings.Repeat("x", 1<<16)} {
		unlock := e.s.starts.lock(id)
		done := make(chan struct{})
		go func() {
			e.s.AwaitStart(id)
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatalf("AwaitStart(%.20q) waited", id)
		}
		e.s.starts.mu.Lock()
		n := e.s.starts.m[id].n
		e.s.starts.mu.Unlock()
		unlock()
		if n != 1 || e.locks() != 0 {
			t.Fatalf("AwaitStart(%.20q): %d on the entry, %d entries left", id, n, e.locks())
		}
	}
}
