package aliases_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/aliases/aliasestest"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/server"
	"ai-whiteboard/internal/usable"
)

// The service has what the server, the agent list and the chat manager ask of it.
var (
	_ server.AliasAPI = (*aliases.Service)(nil)
	_ usable.Extra    = (*aliases.Service)(nil)
	_ accounts        = (*aliases.Service)(nil)
)

// accounts is chats.Accounts without Namer (an adapter package adds it; aliases may not import
// chats).
type accounts interface {
	Spawner(a model.AgentKind) agent.Spawner
	CheckFolder(a model.AgentKind, cwd string) error
}

// mcpURL is the MCP endpoint the tests give the service.
const mcpURL = "http://host.docker.internal:6006/mcp"

// env is a service on fakes, and the fakes.
type env struct {
	t       *testing.T
	svc     *aliases.Service
	root    string
	home    string
	cont    *aliasestest.Containers
	work    *aliasestest.Work
	claudes *aliasestest.Claudes
	host    *aliasestest.Claude
	ev      *aliasestest.Events
}

// newSvc is a service on fakes, with a data folder and a home folder of its own. edit may change
// the options before New.
func newSvc(t *testing.T, edit ...func(o *aliases.Options)) *env {
	t.Helper()
	e := &env{
		t: t, root: t.TempDir(), home: t.TempDir(),
		cont: aliasestest.NewContainers(), work: aliasestest.NewWork(),
		claudes: aliasestest.NewClaudes(), host: aliasestest.NewClaude(), ev: &aliasestest.Events{},
	}
	o := aliases.Options{
		Root: e.root, Home: e.home, Containers: e.cont, Work: e.work,
		Claude: e.claudes.Factory(), Host: e.host, Broadcast: e.ev.Broadcast, MCPURL: mcpURL,
		Logf:  t.Logf,
		Waits: aliases.Waits{Stale: time.Hour},
	}
	for _, f := range edit {
		f(&o)
	}
	svc, err := aliases.New(o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Shutdown)
	e.svc = svc
	return e
}

// folder is a new folder outside the data folder, to mount.
func (e *env) folder() string { return e.t.TempDir() }

// add adds the account name with mounts, failing the test on an error.
func (e *env) add(name string, mounts ...string) aliases.View {
	e.t.Helper()
	if mounts == nil {
		mounts = []string{}
	}
	v, err := e.svc.Add(aliases.Input{Name: &name, Mounts: &mounts})
	if err != nil {
		e.t.Fatalf("Add(%q): %v", name, err)
	}
	return v
}

// edit sets the account's mounts.
func (e *env) editMounts(id string, mounts ...string) (aliases.Change, error) {
	return e.svc.Edit(id, aliases.Input{Mounts: &mounts})
}

// start makes the account's container run through its runner (as a chat's first message does)
// and returns the run.
func (e *env) start(v aliases.View) *agent.Run {
	e.t.Helper()
	r := e.svc.RunnerFor(v.Kind)
	if r == nil {
		e.t.Fatalf("no runner for %s", v.Kind)
	}
	run, err := r.Command(context.Background(), "", nil, []string{"true"})
	if err != nil {
		e.t.Fatalf("Command: %v", err)
	}
	return run
}

// record is the account's record as aliases.json has it now.
func (e *env) record(id string) (aliases.Alias, bool) {
	e.t.Helper()
	st, err := aliases.OpenStore(e.root, e.t.Logf)
	if err != nil {
		e.t.Fatal(err)
	}
	return st.Get(id)
}

// viewOf is the account's view in List (no refresh: Stale is long), failing when missing.
func (e *env) viewOf(id string) aliases.View {
	e.t.Helper()
	for _, v := range e.svc.List().Aliases {
		if v.ID == id {
			return v
		}
	}
	e.t.Fatalf("no account %s in List", id)
	return aliases.View{}
}

// stopped reports whether StopKind was called with kind.
func (e *env) stopped(kind model.AgentKind) bool { return slices.Contains(e.work.Stopped(), kind) }

var notRunning = &container.Unavailable{Kind: container.NotRunning, Reason: "Docker is not running"}

func TestAddStoresAccount(t *testing.T) {
	e := newSvc(t)
	m := e.folder()
	v := e.add("  Claude · Work ", m)

	if v.Name != "Claude · Work" || v.Kind != model.AliasKind(v.ID) || !model.IsAlias(v.Kind) {
		t.Fatalf("view = %+v", v)
	}
	if v.Container.State != aliases.ContainerNone || v.Container.Name != container.Name(v.ID) {
		t.Errorf("container = %+v, want none", v.Container)
	}
	if v.Pending == nil || len(v.Pending) != 0 || v.RestartNeeded || v.Busy != 0 {
		t.Errorf("pending %#v, restart %v, busy %d", v.Pending, v.RestartNeeded, v.Busy)
	}
	if v.Login.Known {
		t.Errorf("login = %+v, want not known", v.Login)
	}
	if calls := e.cont.Calls(); len(calls) != 0 {
		t.Errorf("Docker calls = %v, want none", calls)
	}
	rec, ok := e.record(v.ID)
	if !ok || rec.Name != "Claude · Work" || !slices.Equal(rec.Mounts, []string{m}) || rec.Applied != nil {
		t.Fatalf("stored = %+v, %v", rec, ok)
	}
	for _, d := range []string{aliases.Dir(e.root, v.ID), aliases.ClaudeDir(e.root, v.ID),
		aliases.HomeDir(e.root, v.ID), aliases.MCPDir(e.root, v.ID)} {
		fi, err := os.Stat(d)
		if err != nil || !fi.IsDir() {
			t.Fatalf("%s: %v", d, err)
		}
		if runtime.GOOS != "windows" && fi.Mode().Perm() != 0o700 {
			t.Errorf("%s mode %v, want 0700", d, fi.Mode().Perm())
		}
	}
	l, ok := e.ev.Last()
	if !ok || e.ev.Count() != 1 || len(l.Aliases) != 1 || l.Aliases[0].ID != v.ID {
		t.Errorf("events = %d, last %+v", e.ev.Count(), l)
	}
}

func TestAddRefusals(t *testing.T) {
	e := newSvc(t)
	blank := "  "
	if _, err := e.svc.Add(aliases.Input{Name: &blank}); !errors.Is(err, aliases.ErrNoName) {
		t.Errorf("blank name: %v", err)
	}
	if _, err := e.svc.Add(aliases.Input{}); !errors.Is(err, aliases.ErrNoName) {
		t.Errorf("no name: %v", err)
	}
	name := "Work"
	missing := []string{filepath.Join(e.folder(), "nope")}
	_, err := e.svc.Add(aliases.Input{Name: &name, Mounts: &missing})
	var fe *aliases.FolderError
	if !errors.As(err, &fe) || fe.Why != "does not exist" {
		t.Errorf("missing folder: %v", err)
	}
	if n := len(e.svc.Kinds()); n != 0 {
		t.Errorf("%d accounts stored", n)
	}
	if e.ev.Count() != 0 {
		t.Errorf("%d events", e.ev.Count())
	}
	if ents, _ := os.ReadDir(filepath.Join(e.root, aliases.DirName)); len(ents) != 0 {
		t.Errorf("folders made: %v", ents)
	}
}

func TestEditRenameOnly(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work", e.folder())
	e.start(v)
	before := len(e.cont.Calls())
	name := "Personal"
	c, err := e.svc.Edit(v.ID, aliases.Input{Name: &name})
	if err != nil {
		t.Fatal(err)
	}
	if c.Restart != aliases.RestartUnchanged || c.Alias.Name != "Personal" {
		t.Fatalf("change = %+v", c)
	}
	if calls := e.cont.Calls()[before:]; len(calls) != 0 {
		t.Errorf("Docker calls %v, want none", calls)
	}
	if rec, _ := e.record(v.ID); rec.Name != "Personal" {
		t.Errorf("stored name %q", rec.Name)
	}
}

func TestEditNotFoundAndRefusals(t *testing.T) {
	e := newSvc(t)
	name := "x"
	if _, err := e.svc.Edit("a_00000000", aliases.Input{Name: &name}); !errors.Is(err, aliases.ErrNotFound) {
		t.Errorf("unknown id: %v", err)
	}
	m := e.folder()
	v := e.add("Work", m)
	blank := ""
	if _, err := e.svc.Edit(v.ID, aliases.Input{Name: &blank}); !errors.Is(err, aliases.ErrNoName) {
		t.Errorf("blank name: %v", err)
	}
	var fe *aliases.FolderError
	if _, err := e.editMounts(v.ID, m, m); !errors.As(err, &fe) || fe.Why != "is listed twice" {
		t.Errorf("twice: %v", err)
	}
	if rec, _ := e.record(v.ID); rec.Name != "Work" || !slices.Equal(rec.Mounts, []string{m}) {
		t.Errorf("record changed: %+v", rec)
	}
}

func TestEditNoContainerDeferred(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work", e.folder())
	m2 := e.folder()
	c, err := e.editMounts(v.ID, m2)
	if err != nil {
		t.Fatal(err)
	}
	if c.Restart != aliases.RestartDeferred || c.Alias.Applied != nil || c.Alias.RestartNeeded {
		t.Fatalf("change = %+v", c)
	}
	if rec, _ := e.record(v.ID); !slices.Equal(rec.Mounts, []string{m2}) || rec.Applied != nil {
		t.Errorf("record = %+v", rec)
	}
	if e.cont.Count("recreate") != 0 || e.cont.Count("create") != 0 {
		t.Errorf("calls %v", e.cont.Calls())
	}
}

func TestEditStoppedDeferredThenEnsureApplies(t *testing.T) {
	e := newSvc(t)
	m1, m2 := e.folder(), e.folder()
	v := e.add("Work", m1)
	e.start(v)
	sp, _ := e.cont.Spec(v.ID)
	e.cont.SetState(v.ID, container.StateStopped, sp)

	c, err := e.editMounts(v.ID, m2)
	if err != nil {
		t.Fatal(err)
	}
	if c.Restart != aliases.RestartDeferred || c.Alias.RestartNeeded || len(c.Alias.Pending) != 0 {
		t.Fatalf("change = %+v", c)
	}
	if e.cont.Count("recreate") != 0 || e.cont.Count("create "+v.ID) != 1 {
		t.Fatalf("calls %v", e.cont.Calls())
	}
	if rec, _ := e.record(v.ID); !slices.Equal(rec.Applied.Mounts, []string{m1}) {
		t.Fatalf("applied %+v, want the old mounts until the next start", rec.Applied)
	}

	e.start(v) // the next ensure makes it from the saved spec
	if e.cont.Count("create "+v.ID) != 2 {
		t.Fatalf("calls %v, want a second create", e.cont.Calls())
	}
	rec, _ := e.record(v.ID)
	if rec.Applied == nil || !slices.Equal(rec.Applied.Mounts, []string{m2}) {
		t.Errorf("applied = %+v, want %v", rec.Applied, []string{m2})
	}
	if got, _ := e.cont.Spec(v.ID); !slices.Equal(got.Mounts, []string{m2}) {
		t.Errorf("container mounts %v", got.Mounts)
	}
}

func TestEditRunningIdleRecreates(t *testing.T) {
	e := newSvc(t)
	m1, m2 := e.folder(), e.folder()
	v := e.add("Work", m1)
	e.start(v)

	c, err := e.editMounts(v.ID, m1, m2)
	if err != nil {
		t.Fatal(err)
	}
	if c.Restart != aliases.RestartDone || c.Alias.RestartNeeded || len(c.Alias.Pending) != 0 {
		t.Fatalf("change = %+v", c)
	}
	if !e.stopped(v.Kind) {
		t.Error("StopKind not called")
	}
	if n := e.cont.Count("recreate " + v.ID); n != 1 {
		t.Errorf("%d recreates", n)
	}
	rec, _ := e.record(v.ID)
	if rec.Applied == nil || !slices.Equal(rec.Applied.Mounts, []string{m1, m2}) {
		t.Errorf("applied = %+v", rec.Applied)
	}
	if c.Alias.Container.State != aliases.ContainerRunning {
		t.Errorf("container %+v", c.Alias.Container)
	}
}

func TestEditRunningBusyThenRestart(t *testing.T) {
	e := newSvc(t)
	m1, m2 := e.folder(), e.folder()
	v := e.add("Work", m1)
	e.start(v)
	e.work.SetBusy(v.Kind, 2)

	c, err := e.editMounts(v.ID, m1, m2)
	if err != nil {
		t.Fatal(err)
	}
	if c.Restart != aliases.RestartBusy || c.Busy != 2 {
		t.Fatalf("change = %+v", c)
	}
	if !c.Alias.RestartNeeded || !slices.Equal(c.Alias.Pending, []string{m2}) || c.Alias.Busy != 2 {
		t.Errorf("view restart %v pending %v busy %d", c.Alias.RestartNeeded, c.Alias.Pending, c.Alias.Busy)
	}
	if e.cont.Count("recreate") != 0 || e.stopped(v.Kind) {
		t.Fatalf("calls %v, stopped %v", e.cont.Calls(), e.work.Stopped())
	}

	c, err = e.svc.Restart(v.ID, false)
	if err != nil || c.Restart != aliases.RestartBusy || c.Busy != 2 {
		t.Fatalf("restart without force = %+v, %v", c, err)
	}
	if e.cont.Count("recreate") != 0 {
		t.Fatal("recreated without force")
	}

	c, err = e.svc.Restart(v.ID, true)
	if err != nil || c.Restart != aliases.RestartDone {
		t.Fatalf("restart with force = %+v, %v", c, err)
	}
	if !e.stopped(v.Kind) || e.cont.Count("recreate "+v.ID) != 1 {
		t.Errorf("stopped %v, calls %v", e.work.Stopped(), e.cont.Calls())
	}
	if c.Alias.RestartNeeded || c.Alias.Pending == nil || len(c.Alias.Pending) != 0 {
		t.Errorf("view restart %v pending %#v", c.Alias.RestartNeeded, c.Alias.Pending)
	}
	if rec, _ := e.record(v.ID); !slices.Equal(rec.Applied.Mounts, []string{m1, m2}) {
		t.Errorf("applied = %+v", rec.Applied)
	}
}

func TestRestartNotRunningDeferred(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work", e.folder())
	c, err := e.svc.Restart(v.ID, true)
	if err != nil || c.Restart != aliases.RestartDeferred {
		t.Fatalf("restart = %+v, %v", c, err)
	}
	if e.cont.Count("recreate") != 0 {
		t.Error("recreated")
	}
	if _, err := e.svc.Restart("a_00000000", false); !errors.Is(err, aliases.ErrNotFound) {
		t.Errorf("unknown: %v", err)
	}
	e.cont.SetAvailable(notRunning)
	if _, err := e.svc.Restart(v.ID, false); !errors.Is(err, notRunning) {
		t.Errorf("Docker down: %v", err)
	}
}

func TestEditDockerUnavailableDeferred(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work", e.folder())
	e.start(v)
	e.cont.SetAvailable(notRunning)
	c, err := e.editMounts(v.ID, e.folder())
	if err != nil {
		t.Fatal(err)
	}
	if c.Restart != aliases.RestartDeferred {
		t.Fatalf("change = %+v", c)
	}
	if c.Alias.Container.State != aliases.ContainerUnavailable || c.Alias.Container.Reason != "Docker is not running" {
		t.Errorf("container %+v", c.Alias.Container)
	}
}

func TestEditBackToAppliedUnchanged(t *testing.T) {
	e := newSvc(t)
	m1, m2 := e.folder(), e.folder()
	v := e.add("Work", m1)
	e.start(v)
	e.work.SetBusy(v.Kind, 1)
	if c, _ := e.editMounts(v.ID, m1, m2); c.Restart != aliases.RestartBusy {
		t.Fatalf("change = %+v", c)
	}
	c, err := e.editMounts(v.ID, m1)
	if err != nil {
		t.Fatal(err)
	}
	if c.Restart != aliases.RestartUnchanged || c.Alias.RestartNeeded {
		t.Fatalf("change = %+v", c)
	}
	if e.cont.Count("recreate") != 0 {
		t.Error("recreated")
	}
}

func TestEditRecreateFails(t *testing.T) {
	e := newSvc(t)
	m1, m2 := e.folder(), e.folder()
	v := e.add("Work", m1)
	e.start(v)
	why := m2 + " is not shared from the host and is not known to Docker"
	e.cont.FailCreate(errors.New(why))

	_, err := e.editMounts(v.ID, m1, m2)
	if err == nil || err.Error() != why {
		t.Fatalf("err = %v", err)
	}
	got := e.viewOf(v.ID)
	if got.Container.State != aliases.ContainerError || got.Container.Reason != why {
		t.Errorf("container %+v", got.Container)
	}
	if rec, _ := e.record(v.ID); rec.Applied != nil {
		t.Errorf("applied = %+v, want nil (the container is gone)", rec.Applied)
	}
	if l, _ := e.ev.Last(); l.Aliases[0].Container.State != aliases.ContainerError {
		t.Errorf("last event container %+v", l.Aliases[0].Container)
	}

	e.cont.FailCreate(nil)
	e.start(v)
	if got := e.viewOf(v.ID); got.Container.State != aliases.ContainerRunning || got.Container.Reason != "" {
		t.Errorf("after a good start: %+v", got.Container)
	}
}

func TestStopRunningIdle(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work", e.folder())
	e.start(v)
	c, err := e.svc.Stop(v.ID, false)
	if err != nil || c.Restart != aliases.RestartDone {
		t.Fatalf("stop = %+v, %v", c, err)
	}
	if e.cont.Count("stop "+v.ID) != 1 || e.cont.State(v.ID) != container.StateStopped {
		t.Errorf("calls %v", e.cont.Calls())
	}
	if c.Alias.Container.State != aliases.ContainerStopped {
		t.Errorf("container %+v", c.Alias.Container)
	}
}

func TestStopBusyThenForce(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work", e.folder())
	e.start(v)
	e.work.SetBusy(v.Kind, 3)
	c, err := e.svc.Stop(v.ID, false)
	if err != nil || c.Restart != aliases.RestartBusy || c.Busy != 3 {
		t.Fatalf("stop = %+v, %v", c, err)
	}
	if e.cont.Count("stop") != 0 || e.stopped(v.Kind) {
		t.Fatal("stopped without force")
	}
	c, err = e.svc.Stop(v.ID, true)
	if err != nil || c.Restart != aliases.RestartDone {
		t.Fatalf("forced stop = %+v, %v", c, err)
	}
	if !e.stopped(v.Kind) || e.cont.State(v.ID) != container.StateStopped {
		t.Errorf("stopped %v, state %v", e.work.Stopped(), e.cont.State(v.ID))
	}
}

func TestStopNotRunning(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work", e.folder())
	c, err := e.svc.Stop(v.ID, false)
	if err != nil || c.Restart != aliases.RestartDone {
		t.Fatalf("stop = %+v, %v", c, err)
	}
	if e.cont.Count("stop") != 0 {
		t.Error("stop called")
	}
	e.cont.SetAvailable(notRunning)
	_, err = e.svc.Stop(v.ID, false)
	if u, ok := container.IsUnavailable(err); !ok || u.Kind != container.NotRunning {
		t.Errorf("Docker down: %v", err)
	}
}

func TestRemove(t *testing.T) {
	e := newSvc(t)
	m := e.folder()
	v := e.add("Work", m)
	other := e.add("Other")
	e.start(v)
	events := e.ev.Count()

	if err := e.svc.Remove(v.ID); err != nil {
		t.Fatal(err)
	}
	if e.cont.Count("remove "+v.ID) != 1 || e.cont.State(v.ID) != container.StateNone {
		t.Errorf("calls %v", e.cont.Calls())
	}
	if !e.stopped(v.Kind) {
		t.Error("StopKind not called")
	}
	if _, err := os.Stat(aliases.Dir(e.root, v.ID)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("folder left: %v", err)
	}
	if _, ok := e.record(v.ID); ok {
		t.Error("record left")
	}
	if e.ev.Count() <= events {
		t.Error("no event")
	}
	if l, _ := e.ev.Last(); len(l.Aliases) != 1 || l.Aliases[0].ID != other.ID {
		t.Errorf("last event %+v", l.Aliases)
	}
	if err := e.svc.Check(v.Kind); !errors.Is(err, aliases.ErrRemoved) {
		t.Errorf("Check: %v", err)
	}
	if err := e.svc.CheckFolder(v.Kind, m); !errors.Is(err, aliases.ErrRemoved) {
		t.Errorf("CheckFolder: %v", err)
	}
	if sp := e.svc.Spawner(v.Kind); sp != nil {
		t.Errorf("Spawner = %#v, want an untyped nil", sp)
	}
	if r := e.svc.RunnerFor(v.Kind); r != nil {
		t.Errorf("RunnerFor = %#v", r)
	}
	if d := e.svc.DirOf(v.Kind); d != "" {
		t.Errorf("DirOf = %q", d)
	}
	if k := e.svc.Kinds(); !slices.Equal(k, []model.AgentKind{other.Kind}) {
		t.Errorf("Kinds = %v", k)
	}
	if err := e.svc.Remove(v.ID); !errors.Is(err, aliases.ErrNotFound) {
		t.Errorf("second remove: %v", err)
	}
}

func TestRemoveDockerNotRunningRefused(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work", e.folder())
	e.cont.SetAvailable(notRunning)
	if err := e.svc.Remove(v.ID); !errors.Is(err, notRunning) {
		t.Fatalf("err = %v", err)
	}
	if _, ok := e.record(v.ID); !ok {
		t.Error("record removed")
	}
	if _, err := os.Stat(aliases.Dir(e.root, v.ID)); err != nil {
		t.Errorf("folder: %v", err)
	}
}

func TestRemoveDockerNotInstalledGoesOn(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work", e.folder())
	e.cont.SetAvailable(&container.Unavailable{Kind: container.NotInstalled, Reason: "Docker is not installed"})
	if err := e.svc.Remove(v.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.record(v.ID); ok {
		t.Error("record left")
	}
	if _, err := os.Stat(aliases.Dir(e.root, v.ID)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("folder left: %v", err)
	}
}

func TestEventsAfterEachChange(t *testing.T) {
	e := newSvc(t)
	m1, m2 := e.folder(), e.folder()
	step := func(what string, do func(), ok func(aliases.List) bool) {
		t.Helper()
		n := e.ev.Count()
		do()
		if e.ev.Count() <= n {
			t.Fatalf("%s: no event", what)
		}
		e.ev.WaitFor(t, 2*time.Second, ok)
	}
	var v aliases.View
	step("add", func() { v = e.add("Work", m1) }, func(l aliases.List) bool {
		return len(l.Aliases) == 1 && l.Aliases[0].Name == "Work"
	})
	e.start(v)
	step("edit", func() { e.editMounts(v.ID, m1, m2) }, func(l aliases.List) bool {
		a := l.Aliases[0]
		return len(a.Mounts) == 2 && a.Applied != nil && len(a.Applied.Mounts) == 2
	})
	step("restart", func() { e.svc.Restart(v.ID, false) }, func(l aliases.List) bool {
		return l.Aliases[0].Container.State == aliases.ContainerRunning
	})
	step("stop", func() { e.svc.Stop(v.ID, false) }, func(l aliases.List) bool {
		return l.Aliases[0].Container.State == aliases.ContainerStopped
	})
	step("remove", func() { e.svc.Remove(v.ID) }, func(l aliases.List) bool { return len(l.Aliases) == 0 })
	for _, raw := range e.ev.Raw() {
		if !strings.Contains(raw, `"type":"aliases"`) {
			t.Errorf("event %s", raw)
		}
	}
}

func TestLogout(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work", e.folder())
	c := e.claudes.For(v.ID)
	c.SetAuth(claude.Auth{LoggedIn: true, Email: "work@example.com"}, nil)

	got, err := e.svc.Logout(v.ID)
	if err != nil {
		t.Fatal(err)
	}
	if c.LogoutCalls() != 1 {
		t.Errorf("%d logouts", c.LogoutCalls())
	}
	if e.cont.Count("ensure "+v.ID) != 1 {
		t.Errorf("calls %v, want an ensure", e.cont.Calls())
	}
	if !got.Login.Known || got.Login.LoggedIn {
		t.Errorf("login = %+v, want known and logged out", got.Login)
	}
	if rec, _ := e.record(v.ID); rec.LastLogin == nil || rec.LastLogin.LoggedIn {
		t.Errorf("last login = %+v", rec.LastLogin)
	}

	c.FailLogout(errors.New("logout failed"))
	if _, err := e.svc.Logout(v.ID); err == nil || err.Error() != "logout failed" {
		t.Errorf("failing logout: %v", err)
	}
	e.cont.SetAvailable(notRunning)
	if _, err := e.svc.Logout(v.ID); !errors.Is(err, notRunning) {
		t.Errorf("Docker down: %v", err)
	}
	if _, err := e.svc.Logout("a_00000000"); !errors.Is(err, aliases.ErrNotFound) {
		t.Errorf("unknown: %v", err)
	}
}
