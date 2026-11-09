package aliases_test

import (
	"context"
	"errors"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/model"
)

// loggedIn is a service whose Changed calls are counted, and one account of it with a running
// container, logged in (Check is nil), mounting m.
func loggedIn(t *testing.T) (e *env, v aliases.View, m string, changed *atomic.Int32) {
	t.Helper()
	changed = &atomic.Int32{}
	e = newSvc(t, func(o *aliases.Options) { o.Changed = func() { changed.Add(1) } })
	m = e.folder()
	v = e.add("Work", m)
	e.claudes.For(v.ID).SetAuth(claude.Auth{LoggedIn: true, Email: "w@example.com"}, nil)
	e.start(v)
	e.ev.WaitFor(t, 2*time.Second, func(l aliases.List) bool { return l.Aliases[0].Login.LoggedIn })
	if err := e.svc.Check(v.Kind); err != nil {
		t.Fatalf("Check before: %v", err)
	}
	return e, v, m, changed
}

// While Restart, Edit or Stop ends an account's processes and recreates or stops its container,
// new runs are refused (Check and the runner): they would start in the old container and be
// killed a moment later. The mark is broadcast when set and when cleared.
func TestRestartingRefusesNewRuns(t *testing.T) {
	for _, c := range []struct {
		name  string
		busy  int
		op    func(e *env, v aliases.View, m string) (aliases.Change, error)
		state container.State
	}{
		{"forced restart", 2, func(e *env, v aliases.View, _ string) (aliases.Change, error) {
			return e.svc.Restart(v.ID, true)
		}, container.StateRunning},
		{"edit that restarts", 0, func(e *env, v aliases.View, m string) (aliases.Change, error) {
			return e.editMounts(v.ID, m, e.folder())
		}, container.StateRunning},
		{"forced stop", 1, func(e *env, v aliases.View, _ string) (aliases.Change, error) {
			return e.svc.Stop(v.ID, true)
		}, container.StateStopped},
	} {
		t.Run(c.name, func(t *testing.T) {
			e, v, m, changed := loggedIn(t)
			e.work.SetBusy(v.Kind, c.busy)
			before := changed.Load()
			execs := len(e.cont.Execs())
			var during struct {
				check, run error
				changed    int32
				execs      int
			}
			e.work.OnStop(func(kind model.AgentKind) {
				during.check = e.svc.Check(kind)
				_, during.run = e.svc.RunnerFor(kind).Command(context.Background(), m, nil, []string{"claude"})
				during.changed = changed.Load()
				during.execs = len(e.cont.Execs())
			})
			ch, err := c.op(e, v, m)
			if err != nil || ch.Restart != aliases.RestartDone {
				t.Fatalf("change %+v, %v", ch, err)
			}
			if !e.stopped(v.Kind) {
				t.Fatal("StopKind not called")
			}
			if !errors.Is(during.check, aliases.ErrRestarting) {
				t.Errorf("Check during: %v", during.check)
			} else if during.check.Error() != "The account's container is restarting; try again in a moment" {
				t.Errorf("sentence %q", during.check.Error())
			}
			if !errors.Is(during.run, aliases.ErrRestarting) {
				t.Errorf("Command during: %v", during.run)
			}
			if during.execs != execs {
				t.Errorf("an exec during the restart: %d, then %d", execs, during.execs)
			}
			if during.changed <= before {
				t.Error("no Changed once the mark was set")
			}
			if changed.Load() <= during.changed {
				t.Error("no Changed once the mark was cleared")
			}
			if e.cont.State(v.ID) != c.state {
				t.Errorf("container %s, want %s", e.cont.State(v.ID), c.state)
			}

			// After: back to normal, and a run goes (starting a stopped container).
			e.work.OnStop(nil)
			if err := e.svc.Check(v.Kind); err != nil {
				t.Errorf("Check after: %v", err)
			}
			if _, err := e.svc.RunnerFor(v.Kind).Command(context.Background(), m, nil, []string{"claude"}); err != nil {
				t.Errorf("Command after: %v", err)
			}
		})
	}
}

// A recreate that fails clears the mark all the same.
func TestRestartingClearedOnFailure(t *testing.T) {
	e, v, m, _ := loggedIn(t)
	e.cont.FailCreate(errors.New("mounts denied"))
	var during error
	e.work.OnStop(func(kind model.AgentKind) { during = e.svc.Check(kind) })
	if _, err := e.svc.Restart(v.ID, true); err == nil {
		t.Fatal("restart did not fail")
	}
	if !errors.Is(during, aliases.ErrRestarting) {
		t.Errorf("Check during: %v", during)
	}
	if err := e.svc.Check(v.Kind); errors.Is(err, aliases.ErrRestarting) {
		t.Errorf("Check after a failed restart: %v", err)
	}
	e.cont.FailCreate(nil)
	if _, err := e.svc.RunnerFor(v.Kind).Command(context.Background(), m, nil, []string{"claude"}); err != nil {
		t.Errorf("Command after: %v", err)
	}
}

// The service's own runs (auth status, login, logout) are not refused while the account
// restarts: a login opened then starts once the container is ready, not with an error.
func TestOwnRunsNotRefusedWhileRestarting(t *testing.T) {
	e, v, m, _ := loggedIn(t)
	own := e.claudes.Spawner(v.ID) // asked the login after the start
	if own == nil {
		t.Fatal("no Claude made")
	}
	chats := e.svc.Spawner(v.Kind).(*claude.Spawner)
	if own.Runner == chats.Runner {
		t.Fatal("the account's Claude runs on the chats' runner")
	}
	var ownErr, chatErr error
	e.work.OnStop(func(kind model.AgentKind) {
		_, ownErr = own.Runner.Command(context.Background(), m, nil, []string{"claude", "auth", "status"})
		_, chatErr = chats.Runner.Command(context.Background(), m, nil, []string{"claude"})
	})
	if _, err := e.svc.Restart(v.ID, true); err != nil {
		t.Fatal(err)
	}
	if ownErr != nil {
		t.Errorf("own run during the restart: %v", ownErr)
	}
	if !errors.Is(chatErr, aliases.ErrRestarting) {
		t.Errorf("chat run during the restart: %v", chatErr)
	}
}

// After an update of the app the default image has another tag: a running account on the
// default image, made from the old tag, needs no restart, its folders are checked against its
// saved mounts, and its runner runs; a stopped one takes the new image at its next start. A
// custom image or a change of folders still needs a restart.
func TestOldDefaultTagNeedsNoRestart(t *testing.T) {
	root := t.TempDir()
	st, err := aliases.OpenStore(root, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	e := newSvc(t, func(o *aliases.Options) { o.Root, o.Store = root, st })
	e.root = root
	m := e.folder()
	v := e.add("Work", m)
	oldTag := container.DefaultImageRepo + ":0.0.1-old"
	a, _ := st.Get(v.ID)
	a.Applied = &aliases.Applied{Image: oldTag, Default: true, Mounts: []string{m}}
	if err := st.Put(a); err != nil {
		t.Fatal(err)
	}
	oldSpec := a.Spec(root)
	oldSpec.Image = oldTag
	e.cont.SetState(v.ID, container.StateRunning, oldSpec)

	// The runner finds the container running (no recreate) and runs in a mounted folder.
	if _, err := e.svc.RunnerFor(v.Kind).Command(context.Background(), m, nil, []string{"claude"}); err != nil {
		t.Fatalf("Command: %v", err)
	}
	if e.cont.Count("create") != 0 || e.cont.Count("recreate") != 0 {
		t.Fatalf("calls %v", e.cont.Calls())
	}
	if got := e.viewOf(v.ID); got.Container.State != aliases.ContainerRunning || got.RestartNeeded || len(got.Pending) != 0 {
		t.Fatalf("view: container %s, restart needed %v, pending %v", got.Container.State, got.RestartNeeded, got.Pending)
	}
	if err := e.svc.CheckFolder(v.Kind, m); err != nil {
		t.Errorf("CheckFolder: %v", err)
	}
	// An edit that changes nothing of the spec restarts nothing.
	if c, err := e.editMounts(v.ID, m); err != nil || c.Restart != aliases.RestartUnchanged {
		t.Errorf("same mounts: %+v, %v", c, err)
	}

	// A custom image needs a restart (busy: deferred to the person).
	e.work.SetBusy(v.Kind, 1)
	mine := "mine:1"
	if c, err := e.svc.Edit(v.ID, aliases.Input{Image: &mine}); err != nil || c.Restart != aliases.RestartBusy || !c.Alias.RestartNeeded {
		t.Errorf("custom image: %+v, %v", c, err)
	}
	// Back to the default: no restart needed again.
	def := ""
	if c, err := e.svc.Edit(v.ID, aliases.Input{Image: &def}); err != nil || c.Restart != aliases.RestartUnchanged || c.Alias.RestartNeeded {
		t.Errorf("back to the default: %+v, %v", c, err)
	}
	// Another folder needs a restart.
	m2 := e.folder()
	c, err := e.editMounts(v.ID, m, m2)
	if err != nil || c.Restart != aliases.RestartBusy || !c.Alias.RestartNeeded || !slices.Equal(c.Alias.Pending, []string{m2}) {
		t.Errorf("another folder: %+v, %v", c, err)
	}
	var me *aliases.MountError
	if err := e.svc.CheckFolder(v.Kind, m2); !errors.As(err, &me) || !me.Pending {
		t.Errorf("CheckFolder of the new folder: %v", err)
	}
	if e.cont.Count("recreate") != 0 {
		t.Errorf("recreated: %v", e.cont.Calls())
	}

	// Stopped, the next start makes the container anew from the saved spec, new tag included.
	if _, err := e.editMounts(v.ID, m); err != nil {
		t.Fatal(err)
	}
	e.work.SetBusy(v.Kind, 0)
	if _, err := e.svc.Stop(v.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.RunnerFor(v.Kind).Command(context.Background(), m, nil, []string{"claude"}); err != nil {
		t.Fatalf("Command after the stop: %v", err)
	}
	if spec, _ := e.cont.Spec(v.ID); spec.Image != container.DefaultImage() {
		t.Errorf("container image %q, want %q", spec.Image, container.DefaultImage())
	}
	if rec, _ := st.Get(v.ID); rec.Applied == nil || rec.Applied.Image != container.DefaultImage() {
		t.Errorf("applied %+v", rec.Applied)
	}
}
