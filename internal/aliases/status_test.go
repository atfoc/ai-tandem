package aliases_test

import (
	"errors"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/model"
)

func TestCheckFolderNoContainerUsesSavedMounts(t *testing.T) {
	e := newSvc(t)
	m := e.folder()
	v := e.add("Work", m)
	if err := e.svc.CheckFolder(v.Kind, m); err != nil {
		t.Errorf("mount: %v", err)
	}
	if err := e.svc.CheckFolder(v.Kind, filepath.Join(m, "a", "b")); err != nil {
		t.Errorf("nested: %v", err)
	}
	other := e.folder()
	err := e.svc.CheckFolder(v.Kind, other)
	var me *aliases.MountError
	if !errors.As(err, &me) || me.Pending || me.Account != "Work" || me.Folder != other {
		t.Fatalf("other folder: %#v", err)
	}
	if err.Error() != "This folder isn't mounted in Work — Add it in Settings" {
		t.Errorf("sentence %q", err.Error())
	}
	if len(e.cont.Calls()) != 0 {
		t.Errorf("Docker calls %v", e.cont.Calls())
	}
}

func TestCheckFolderRunningWithPendingSpec(t *testing.T) {
	e := newSvc(t)
	m1, m2, m3 := e.folder(), e.folder(), e.folder()
	v := e.add("Work", m1)
	e.start(v)
	e.work.SetBusy(v.Kind, 1)
	if c, _ := e.editMounts(v.ID, m1, m2); c.Restart != aliases.RestartBusy {
		t.Fatalf("change = %+v", c)
	}
	if err := e.svc.CheckFolder(v.Kind, filepath.Join(m1, "sub")); err != nil {
		t.Errorf("applied: %v", err)
	}
	err := e.svc.CheckFolder(v.Kind, m2)
	var me *aliases.MountError
	if !errors.As(err, &me) || !me.Pending {
		t.Fatalf("saved only: %#v", err)
	}
	if err.Error() != "Restart Work to use this folder" {
		t.Errorf("sentence %q", err.Error())
	}
	err = e.svc.CheckFolder(v.Kind, m3)
	if !errors.As(err, &me) || me.Pending {
		t.Fatalf("neither: %#v", err)
	}
	if err.Error() != "This folder isn't mounted in Work — Add it in Settings" {
		t.Errorf("sentence %q", err.Error())
	}

	// Once stopped, the next start takes the saved mounts: they are what counts.
	e.work.SetBusy(v.Kind, 0)
	if _, err := e.svc.Stop(v.ID, false); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.CheckFolder(v.Kind, m2); err != nil {
		t.Errorf("saved, stopped: %v", err)
	}
}

func TestCheckFolderUnknownKind(t *testing.T) {
	e := newSvc(t)
	for _, k := range []model.AgentKind{model.Claude, model.AliasKind("a_00000000"), "claude:nope"} {
		if err := e.svc.CheckFolder(k, e.folder()); !errors.Is(err, aliases.ErrRemoved) {
			t.Errorf("%s: %v", k, err)
		}
		if err := e.svc.Check(k); !errors.Is(err, aliases.ErrRemoved) {
			t.Errorf("Check %s: %v", k, err)
		}
		if n := e.svc.Name(k); n != "" {
			t.Errorf("Name %s = %q", k, n)
		}
	}
}

func TestKindsNameCheck(t *testing.T) {
	e := newSvc(t)
	a := e.add("Work")
	b := e.add("Personal")
	if k := e.svc.Kinds(); !slices.Equal(k, []model.AgentKind{a.Kind, b.Kind}) {
		t.Errorf("Kinds = %v", k)
	}
	if n := e.svc.Name(b.Kind); n != "Personal" {
		t.Errorf("Name = %q", n)
	}
	if err := e.svc.Check(a.Kind); !errors.Is(err, aliases.ErrNotLoggedIn) {
		t.Errorf("not logged in: %v", err)
	}
	e.cont.SetAvailable(notRunning)
	err := e.svc.Check(a.Kind)
	if u, ok := container.IsUnavailable(err); !ok || u.Reason != "Docker is not running" {
		t.Errorf("Docker down: %v", err)
	}
}

func TestCheckLoggedInAfterEnsure(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work")
	e.claudes.For(v.ID).SetAuth(claude.Auth{LoggedIn: true, Email: "w@example.com"}, nil)
	e.start(v) // the first start in this run asks the login
	e.ev.WaitFor(t, 2*time.Second, func(l aliases.List) bool {
		return l.Aliases[0].Login.LoggedIn && l.Aliases[0].Login.Email == "w@example.com"
	})
	if err := e.svc.Check(v.Kind); err != nil {
		t.Errorf("Check: %v", err)
	}
	rec, _ := e.record(v.ID)
	if rec.LastLogin == nil || !rec.LastLogin.LoggedIn || rec.LastLogin.Email != "w@example.com" {
		t.Errorf("last login %+v", rec.LastLogin)
	}
}

func TestCheckLoggedInAfterWatch(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work")
	e.claudes.For(v.ID).SetAuth(claude.Auth{LoggedIn: true, Email: "w@example.com"}, nil)
	e.host.SetAuth(claude.Auth{LoggedIn: true, Email: "me@example.com"}, nil)
	e.cont.SetState(v.ID, container.StateRunning, v.Alias.Spec(e.root))
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		e.svc.Watch(time.Hour, stop)
	}()
	defer func() { close(stop); <-done }()
	l := e.ev.WaitFor(t, 2*time.Second, func(l aliases.List) bool {
		return l.Aliases[0].Login.LoggedIn && l.Host.LoggedIn
	})
	if l.Host.Email != "me@example.com" || l.Aliases[0].Container.State != aliases.ContainerRunning {
		t.Errorf("list %+v", l)
	}
	if err := e.svc.Check(v.Kind); err != nil {
		t.Errorf("Check: %v", err)
	}
	if e.cont.Count("ensure") != 0 {
		t.Errorf("calls %v", e.cont.Calls())
	}

	// Docker goes away and comes back: each change is broadcast.
	e.cont.SetAvailable(notRunning)
	e.ev.WaitFor(t, 2*time.Second, func(l aliases.List) bool { return !l.Docker.OK })
	e.cont.SetAvailable(nil)
	e.ev.WaitFor(t, 2*time.Second, func(l aliases.List) bool {
		return l.Docker.OK && l.Aliases[0].Container.State == aliases.ContainerRunning
	})
}

func TestCheckUsesLastLoginOfRecord(t *testing.T) {
	root := t.TempDir()
	st, err := aliases.OpenStore(root, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	id := model.NewID("a_")
	err = st.Put(aliases.Alias{ID: id, Name: "Work", Mounts: []string{}, Created: time.Now(),
		LastLogin: &aliases.LastLogin{LoggedIn: true, Email: "w@example.com", Checked: time.Now()}})
	if err != nil {
		t.Fatal(err)
	}
	e := newSvc(t, func(o *aliases.Options) { o.Root = root })
	e.root = root
	if err := e.svc.Check(model.AliasKind(id)); err != nil {
		t.Errorf("Check: %v", err)
	}
	v := e.viewOf(id)
	if !v.Login.Known || !v.Login.LoggedIn || v.Login.Email != "w@example.com" || v.LastLogin != nil {
		t.Errorf("view login %+v, last login %+v", v.Login, v.LastLogin)
	}
}

func TestListDockerUnavailable(t *testing.T) {
	e := newSvc(t)
	e.add("Work")
	e.add("Personal")
	e.cont.SetAvailable(&container.Unavailable{Kind: container.NotInstalled, Reason: "Docker is not installed"})
	l := e.svc.List()
	if l.Docker.OK || l.Docker.Kind != container.NotInstalled || l.Docker.Reason != "Docker is not installed" {
		t.Errorf("docker %+v", l.Docker)
	}
	if l.DefaultImage != container.DefaultImage() {
		t.Errorf("default image %q", l.DefaultImage)
	}
	for _, v := range l.Aliases {
		if v.Container.State != aliases.ContainerUnavailable || v.Container.Reason != "Docker is not installed" {
			t.Errorf("%s: %+v", v.Name, v.Container)
		}
	}
}

func TestListEmptyIsNotNil(t *testing.T) {
	e := newSvc(t)
	if l := e.svc.List(); l.Aliases == nil || !l.Docker.OK || l.Host.Known {
		t.Errorf("list %+v", l)
	}
}

func TestListPreparingAndBusy(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work")
	e.cont.SetBuilding(container.DefaultImage(), true)
	e.work.SetBusy(v.Kind, 3)
	got := e.viewOf(v.ID)
	if got.Container.State != aliases.ContainerPreparing {
		t.Errorf("container %+v", got.Container)
	}
	if got.Busy != 3 {
		t.Errorf("busy %d", got.Busy)
	}
}

func TestListStaleRefresh(t *testing.T) {
	e := newSvc(t, func(o *aliases.Options) { o.Waits.Stale = time.Nanosecond })
	stopped := e.add("Stopped")
	running := e.add("Running")
	e.cont.SetState(stopped.ID, container.StateStopped, stopped.Alias.Spec(e.root))
	e.cont.SetState(running.ID, container.StateRunning, running.Alias.Spec(e.root))
	e.claudes.For(stopped.ID).SetAuth(claude.Auth{LoggedIn: true, Email: "s@example.com"}, nil)
	e.claudes.For(running.ID).SetAuth(claude.Auth{LoggedIn: true, Email: "r@example.com"}, nil)
	e.host.SetAuth(claude.Auth{LoggedIn: true, Email: "me@example.com"}, nil)

	l := e.svc.List() // answers at once from the cache
	if l.Aliases[0].Container.State != aliases.ContainerNone || l.Host.Known {
		t.Errorf("first answer %+v", l)
	}
	l = e.ev.WaitFor(t, 2*time.Second, func(l aliases.List) bool {
		return l.Host.LoggedIn && l.Aliases[1].Login.LoggedIn
	})
	if l.Host.Email != "me@example.com" || l.Aliases[1].Login.Email != "r@example.com" {
		t.Errorf("list %+v", l)
	}
	if l.Aliases[0].Container.State != aliases.ContainerStopped || l.Aliases[0].Login.Known {
		t.Errorf("stopped account %+v", l.Aliases[0])
	}
	if e.cont.Count("ensure") != 0 || e.cont.Count("start") != 0 {
		t.Errorf("calls %v: a refresh started a container", e.cont.Calls())
	}
	if n := e.claudes.For(stopped.ID).StatusCalls(); n != 0 {
		t.Errorf("auth status asked %d times of a stopped account", n)
	}
}

func TestReadyOnFirstRun(t *testing.T) {
	ready := make(chan model.AgentKind, 4)
	e := newSvc(t, func(o *aliases.Options) { o.Ready = func(k model.AgentKind) { ready <- k } })
	v := e.add("Work")
	e.start(v)
	e.start(v)
	select {
	case k := <-ready:
		if k != v.Kind {
			t.Errorf("Ready(%s)", k)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no Ready")
	}
	select {
	case k := <-ready:
		t.Errorf("Ready again (%s)", k)
	case <-time.After(50 * time.Millisecond):
	}
}
