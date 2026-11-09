package aliases_test

// Regression tests of the fixes of correctness review 1 (Stream H).

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/container"
)

// within fails the test when f does not return within a few seconds: what must not wait on an
// image build or a lock held across one.
func within(t *testing.T, what string, f func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		f()
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatalf("%s waited (for the image?)", what)
	}
}

// Review finding #1: a create whose start fails (Docker Desktop's "mounts denied") leaves a
// container made from the saved spec: it is recorded as applied, so the next start, which only
// starts it, leaves "restart needed", the pending folders and the folder checks right.
func TestAppliedRecordedWhenTheStartFails(t *testing.T) {
	e := newSvc(t)
	m, n := e.folder(), e.folder()
	v := e.add("Work", m)
	e.cont.FailStart(errors.New("mounts denied"))
	if _, err := e.svc.RunnerFor(v.Kind).Command(context.Background(), m, nil, []string{"true"}); err == nil {
		t.Fatal("Command with a failing start: no error")
	}
	want := &aliases.Applied{Image: container.DefaultImage(), Default: true, Mounts: []string{m}}
	if rec, _ := e.record(v.ID); !reflect.DeepEqual(rec.Applied, want) {
		t.Fatalf("applied after a failed start = %+v, want %+v", rec.Applied, want)
	}

	e.cont.FailStart(nil)
	e.start(v)
	if n := e.cont.Count("create " + v.ID); n != 1 {
		t.Fatalf("%d creates, want the stopped container started: %v", n, e.cont.Calls())
	}
	if rec, _ := e.record(v.ID); !reflect.DeepEqual(rec.Applied, want) {
		t.Fatalf("applied after the start = %+v, want %+v", rec.Applied, want)
	}

	// A folder added while agents work waits for a restart: pending, and refused as pending.
	e.work.SetBusy(v.Kind, 1)
	if c, err := e.editMounts(v.ID, m, n); err != nil || c.Restart != aliases.RestartBusy {
		t.Fatalf("edit: %+v %v", c, err)
	}
	if got := e.viewOf(v.ID); !got.RestartNeeded || !slices.Equal(got.Pending, []string{n}) {
		t.Errorf("view: restart needed %v, pending %v", got.RestartNeeded, got.Pending)
	}
	var me *aliases.MountError
	if err := e.svc.CheckFolder(v.Kind, n); !errors.As(err, &me) || !me.Pending {
		t.Errorf("CheckFolder(new folder) = %v, want pending", err)
	}
	if err := e.svc.CheckFolder(v.Kind, m); err != nil {
		t.Errorf("CheckFolder(applied folder) = %v", err)
	}
}

// Review finding #1, the robust half: a container found labelled with the saved spec's hash is
// what Applied says, whoever made it; a container found gone drops Applied.
func TestAppliedFollowsTheContainersLabel(t *testing.T) {
	e := newSvc(t)
	m := e.folder()
	v := e.add("Work", m)
	a, _ := e.record(v.ID)
	if a.Applied != nil {
		t.Fatalf("applied before any container = %+v", a.Applied)
	}
	e.cont.SetState(v.ID, container.StateRunning, a.Spec(e.root))
	e.start(v)
	want := &aliases.Applied{Image: container.DefaultImage(), Default: true, Mounts: []string{m}}
	if rec, _ := e.record(v.ID); !reflect.DeepEqual(rec.Applied, want) {
		t.Fatalf("applied = %+v, want %+v", rec.Applied, want)
	}

	e.cont.SetState(v.ID, container.StateNone, container.Spec{})
	if c, err := e.svc.Restart(v.ID, false); err != nil || c.Restart != aliases.RestartDeferred {
		t.Fatalf("restart: %+v %v", c, err)
	}
	if rec, _ := e.record(v.ID); rec.Applied != nil {
		t.Errorf("applied with no container = %+v", rec.Applied)
	}
}

// Review findings #2 and #6: while the image of a container to be made is built or pulled,
// no lock of the account is held: Edit, Restart, Stop and List answer at once, and a chat's run
// (whose chat's lock is held) gives up within Waits.Run with ErrPreparing. Prepare, which the
// chat manager calls with no lock held, waits for the image and makes the container.
func TestImageWaitHoldsNoLock(t *testing.T) {
	e := newSvc(t, func(o *aliases.Options) { o.Waits.Run = 300 * time.Millisecond })
	m := e.folder()
	v := e.add("Work", m)
	e.claudes.For(v.ID).SetAuth(claude.Auth{LoggedIn: true, Email: "w@example.com"}, nil)
	e.start(v)
	e.ev.WaitFor(t, 2*time.Second, func(l aliases.List) bool { return l.Aliases[0].Login.LoggedIn })
	if c, err := e.svc.Stop(v.ID, false); err != nil || c.Restart != aliases.RestartDone {
		t.Fatalf("stop: %+v %v", c, err)
	}
	n := e.folder()
	if c, err := e.editMounts(v.ID, m, n); err != nil || c.Restart != aliases.RestartDeferred {
		t.Fatalf("edit: %+v %v", c, err)
	}

	release := e.cont.BlockImage()
	defer release()
	images := e.cont.Count("image ")
	prepared := make(chan error, 1)
	go func() { prepared <- e.svc.Prepare(v.Kind) }()
	for deadline := time.Now().Add(2 * time.Second); e.cont.Count("image ") == images; time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("Prepare did not wait for the image")
		}
	}

	name := "Work 2"
	within(t, "Edit (rename)", func() {
		if _, err := e.svc.Edit(v.ID, aliases.Input{Name: &name}); err != nil {
			t.Errorf("rename: %v", err)
		}
	})
	within(t, "Restart", func() { e.svc.Restart(v.ID, false) })
	within(t, "Stop", func() { e.svc.Stop(v.ID, false) })
	within(t, "List", func() { e.svc.List() })
	within(t, "a chat's run", func() {
		_, err := e.svc.RunnerFor(v.Kind).Command(context.Background(), m, nil, []string{"true"})
		if !errors.Is(err, aliases.ErrPreparing) {
			t.Errorf("a chat's run while the image is built: %v, want ErrPreparing", err)
		}
	})
	select {
	case err := <-prepared:
		t.Fatalf("Prepare returned before the image was there: %v", err)
	default:
	}

	release()
	select {
	case err := <-prepared:
		if err != nil {
			t.Fatalf("Prepare: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Prepare did not return once the image was there")
	}
	if st := e.cont.State(v.ID); st != container.StateRunning {
		t.Fatalf("container %s after Prepare", st)
	}
	if rec, _ := e.record(v.ID); rec.Applied == nil || !slices.Equal(rec.Applied.Mounts, []string{m, n}) {
		t.Errorf("applied = %+v", rec.Applied)
	}
	within(t, "a chat's run once prepared", func() { e.start(v) })
	if err := e.svc.Prepare(v.Kind); err != nil { // runs already: at once, no Docker call
		t.Errorf("Prepare of a running container: %v", err)
	}
}

// Prepare's error is why the container cannot be made ready; an account that cannot be used is
// left to the chat manager's gate (nil).
func TestPrepareErrors(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work", e.folder())
	if err := e.svc.Prepare(v.Kind); err != nil {
		t.Errorf("Prepare of an account not logged in: %v, want nil", err)
	}
	if e.cont.Count("ensure") != 0 {
		t.Errorf("calls %v", e.cont.Calls())
	}
	e.claudes.For(v.ID).SetAuth(claude.Auth{LoggedIn: true}, nil)
	e.start(v)
	e.ev.WaitFor(t, 2*time.Second, func(l aliases.List) bool { return l.Aliases[0].Login.LoggedIn })
	e.svc.Stop(v.ID, true)
	e.svc.Edit(v.ID, aliases.Input{Mounts: &[]string{e.folder()}})
	why := errors.New("Building the image failed")
	e.cont.FailImage(why)
	if err := e.svc.Prepare(v.Kind); !errors.Is(err, why) {
		t.Errorf("Prepare with a failing build: %v", err)
	}
	if got := e.viewOf(v.ID); got.Container.State != aliases.ContainerError || got.Container.Reason != why.Error() {
		t.Errorf("container view %+v", got.Container)
	}
}

// Review finding #5: a run released (it ended by itself) is forgotten: neither Shutdown nor
// Remove starts a kill for it.
func TestReleasedRunsAreForgotten(t *testing.T) {
	e := newSvc(t)
	a := e.add("Work")
	b := e.add("Personal")
	gone := e.start(b)
	gone.Release()
	if err := e.svc.Remove(b.ID); err != nil {
		t.Fatal(err)
	}
	if kills := e.cont.Kills(); len(kills) != 0 {
		t.Errorf("Remove killed %q", kills)
	}

	ended := e.start(a)
	ended.Release()
	ended.Release() // again: harmless
	live := e.start(a)
	e.svc.Shutdown()
	if kills := e.cont.Kills(); !slices.Equal(kills, []string{live.ID}) {
		t.Errorf("Shutdown killed %q, want only %q", kills, live.ID)
	}
}

// Review finding #7: once the service is shut down, no run starts (a catalog probe that comes
// late must not leave a process in the container).
func TestNoRunAfterShutdown(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work")
	r := e.svc.RunnerFor(v.Kind)
	e.svc.Shutdown()
	if _, err := r.Command(context.Background(), "", nil, []string{"true"}); err == nil || err.Error() != "The server is shutting down" {
		t.Errorf("Command after Shutdown: %v", err)
	}
	if e.cont.Count("ensure") != 0 || e.cont.Count("exec") != 0 {
		t.Errorf("calls %v", e.cont.Calls())
	}
}

// Review finding #8: auth status, the catalog probe and the usage only use a container that
// runs; one stopped meanwhile (by the person, or outside the app) is not started again.
func TestReadOnlyRunsNeverStartAContainer(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work", e.folder())
	e.claudes.For(v.ID).SetAuth(claude.Auth{LoggedIn: true}, nil)
	e.start(v)
	e.ev.WaitFor(t, 2*time.Second, func(l aliases.List) bool { return l.Aliases[0].Login.LoggedIn })
	status := e.claudes.Spawner(v.ID) // the spawner of the auth status runs
	if status == nil {
		t.Fatal("auth status was not asked")
	}
	probe, _ := e.svc.RunningSpawner(v.Kind).(*claude.Spawner)
	if probe == nil {
		t.Fatalf("RunningSpawner = %T", e.svc.RunningSpawner(v.Kind))
	}
	a, _ := e.record(v.ID)
	e.cont.SetState(v.ID, container.StateStopped, a.Spec(e.root))
	starts, ensures := e.cont.Count("start "), e.cont.Count("ensure ")
	for what, r := range map[string]agent.Runner{"auth status": status.Runner, "probe and usage": probe.Runner} {
		if _, err := r.Command(context.Background(), "", nil, []string{"claude"}); !errors.Is(err, aliases.ErrStopped) {
			t.Errorf("%s on a stopped container: %v, want ErrStopped", what, err)
		}
	}
	if e.cont.Count("start ") != starts || e.cont.Count("ensure ") != ensures || e.cont.State(v.ID) != container.StateStopped {
		t.Errorf("the stopped container was started: %v", e.cont.Calls())
	}
	if e.svc.RunningSpawner("claude:a_00000000") != nil {
		t.Error("RunningSpawner of no account is not nil")
	}
}
