package aliasestest

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/model"
)

func spec(id, image string) container.Spec {
	return container.Spec{Alias: id, Image: image, Dir: "/data/aliases/" + id, Mounts: []string{"/src"}}
}

func TestEnsureBranches(t *testing.T) {
	ctx := context.Background()
	f := NewContainers()
	s := spec("a_x", "img:1")

	// None: created and started.
	info, created, err := f.Ensure(ctx, s)
	if err != nil || !created || info.State != container.StateRunning || info.Spec != s.Hash() {
		t.Fatalf("ensure none: %+v %v %v", info, created, err)
	}
	if want := []string{"ensure a_x", "create a_x", "start a_x"}; !slices.Equal(f.Calls(), want) {
		t.Fatalf("calls %v, want %v", f.Calls(), want)
	}
	if !slices.Equal(info.Mounts, []string{"/data/aliases/a_x", "/src"}) || info.Name != container.Name("a_x") || info.Image != "img:1" {
		t.Fatalf("info %+v", info)
	}

	// Running with another spec: used as it is.
	other := spec("a_x", "img:2")
	info, created, err = f.Ensure(ctx, other)
	if err != nil || created || info.Spec != s.Hash() {
		t.Fatalf("ensure running: %+v %v %v", info, created, err)
	}

	// Stopped with the same spec: started.
	f.SetState("a_x", container.StateStopped, s)
	before := f.Count("create a_x")
	info, created, err = f.Ensure(ctx, s)
	if err != nil || created || info.State != container.StateRunning || f.Count("create a_x") != before {
		t.Fatalf("ensure stopped same: %+v %v %v", info, created, err)
	}

	// Stopped with another spec: recreated.
	f.SetState("a_x", container.StateStopped, s)
	info, created, err = f.Ensure(ctx, other)
	if err != nil || !created || info.Spec != other.Hash() {
		t.Fatalf("ensure stopped other: %+v %v %v", info, created, err)
	}
	if got, _ := f.Spec("a_x"); got.Image != "img:2" {
		t.Fatalf("spec %+v", got)
	}

	// FailCreate: nothing changes.
	boom := errors.New("mount denied")
	f.FailCreate(boom)
	f.SetState("a_x", container.StateStopped, s)
	if _, _, err := f.Ensure(ctx, other); !errors.Is(err, boom) {
		t.Fatalf("err %v", err)
	}
	if f.State("a_x") != container.StateStopped {
		t.Fatalf("state %v", f.State("a_x"))
	}
}

func TestRecreateFailCreate(t *testing.T) {
	ctx := context.Background()
	f := NewContainers()
	f.SetState("a_x", container.StateRunning, spec("a_x", "img:1"))
	boom := errors.New("no such image")
	f.FailCreate(boom)
	if _, err := f.Recreate(ctx, spec("a_x", "img:2")); !errors.Is(err, boom) {
		t.Fatalf("err %v", err)
	}
	if f.State("a_x") != container.StateNone {
		t.Fatalf("state %v", f.State("a_x"))
	}
	f.FailCreate(nil)
	info, err := f.Recreate(ctx, spec("a_x", "img:2"))
	if err != nil || info.State != container.StateRunning || info.Image != "img:2" {
		t.Fatalf("recreate: %+v %v", info, err)
	}
	if n := f.Count("recreate a_x"); n != 2 {
		t.Fatalf("recreates %d", n)
	}
}

func TestUnavailable(t *testing.T) {
	ctx := context.Background()
	f := NewContainers()
	down := &container.Unavailable{Kind: container.NotRunning, Reason: "Docker is not running"}
	f.SetAvailable(down)
	if f.Available() != down || f.Refresh(ctx) != down {
		t.Fatal("available")
	}
	if _, _, err := f.Ensure(ctx, spec("a_x", "i")); err != down {
		t.Fatalf("ensure %v", err)
	}
	if err := f.KillRun(ctx, "a_x", "r1"); err != down {
		t.Fatalf("kill %v", err)
	}
	if err := f.Exec("a_x", container.ExecOptions{Argv: []string{"true"}}).Run(); err == nil {
		t.Fatal("exec ran")
	}
	f.SetAvailable(nil)
	if err := f.KillRun(ctx, "a_y", "r2"); err != nil {
		t.Fatalf("kill missing %v", err)
	}
	if !slices.Equal(f.Kills(), []string{"r2"}) {
		t.Fatalf("kills %v", f.Kills())
	}
}

func TestBlockEnsure(t *testing.T) {
	f := NewContainers()
	release := f.BlockEnsure()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, _, err := f.Ensure(ctx, spec("a_x", "i")); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err %v", err)
	}
	done := make(chan error)
	go func() {
		_, _, err := f.Ensure(context.Background(), spec("a_x", "i"))
		done <- err
	}()
	time.Sleep(10 * time.Millisecond)
	release()
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestWatch(t *testing.T) {
	f := NewContainers()
	stop := make(chan struct{})
	got := make(chan error, 10)
	ended := make(chan struct{})
	go func() {
		f.Watch(time.Second, stop, func(err error) { got <- err })
		close(ended)
	}()
	// Wait for Watch to be registered.
	for {
		f.mu.Lock()
		n := len(f.watchers)
		f.mu.Unlock()
		if n == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	next := func() error {
		select {
		case err := <-got:
			return err
		case <-time.After(time.Second):
			t.Fatal("no callback")
			return nil
		}
	}
	f.SetAvailable(errors.New("down"))
	if err := next(); err == nil || err.Error() != "down" {
		t.Fatalf("got %v", err)
	}
	f.SetAvailable(errors.New("down")) // same text: no change
	f.SetAvailable(errors.New("other"))
	if err := next(); err == nil || err.Error() != "other" {
		t.Fatalf("got %v", err)
	}
	f.SetAvailable(nil)
	if err := next(); err != nil {
		t.Fatalf("got %v", err)
	}
	close(stop)
	<-ended
	if len(got) != 0 {
		t.Fatalf("extra callbacks: %d", len(got))
	}
}

func TestExecDefault(t *testing.T) {
	f := NewContainers()
	out, err := f.Exec("a_x", container.ExecOptions{Argv: []string{"sh", "-c", "echo $FOO"}, Env: []string{"FOO=bar"}, Dir: t.TempDir()}).Output()
	if err != nil || strings.TrimSpace(string(out)) != "bar" {
		t.Fatalf("out %q err %v", out, err)
	}
	if len(f.Execs()) != 1 || f.Count("exec a_x") != 1 {
		t.Fatalf("execs %v calls %v", f.Execs(), f.Calls())
	}
}

func TestLogin(t *testing.T) {
	ctx := context.Background()
	c := NewClaude()
	run, err := c.StartLogin(ctx)
	if err != nil || run.URL() != "https://claude.ai/oauth/authorize?state=fake" {
		t.Fatalf("start %v", err)
	}
	r, _ := run.Code(ctx, "bad")
	if r.State != claude.LoginWaiting || r.Error != "Invalid code" {
		t.Fatalf("bad code %+v", r)
	}
	r, _ = run.Code(ctx, "good-code")
	if r.State != claude.LoginLoggedIn {
		t.Fatalf("good code %+v", r)
	}
	select {
	case <-run.Done():
	default:
		t.Fatal("not done")
	}
	if a, _ := c.AuthStatus(ctx); !a.LoggedIn || a.Email != "work@example.com" {
		t.Fatalf("auth %+v", a)
	}
	r, _ = run.Code(ctx, "good-code")
	if r.State != claude.LoginFailed {
		t.Fatalf("after end %+v", r)
	}
	l := c.Logins()[0]
	if l.Cancelled() || !slices.Equal(l.Codes(), []string{"bad", "good-code", "good-code"}) {
		t.Fatalf("login %v %v", l.Cancelled(), l.Codes())
	}

	// Cancel and End.
	run2, _ := c.StartLogin(ctx)
	run2.Cancel()
	run2.Cancel()
	<-run2.Done()
	if !c.Logins()[1].Cancelled() {
		t.Fatal("not cancelled")
	}
	run3, _ := c.StartLogin(ctx)
	c.Logins()[2].End()
	<-run3.Done()
	run3.Cancel()
	if c.Logins()[2].Cancelled() {
		t.Fatal("end counted as cancel")
	}

	// Delay honours ctx.
	run4, _ := c.StartLogin(ctx)
	c.Logins()[3].SetCodeDelay(time.Second)
	short, cancel := context.WithTimeout(ctx, 10*time.Millisecond)
	defer cancel()
	if _, err := run4.Code(short, "good-code"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("delay err %v", err)
	}

	// Logout and failures.
	if err := c.Logout(ctx); err != nil {
		t.Fatal(err)
	}
	if a, _ := c.AuthStatus(ctx); a.LoggedIn || c.LogoutCalls() != 1 || c.StatusCalls() != 2 {
		t.Fatalf("after logout %+v", a)
	}
	boom := errors.New("boom")
	c.FailStart(boom)
	if _, err := c.StartLogin(ctx); err != boom {
		t.Fatalf("fail start %v", err)
	}
}

func TestClaudesFactory(t *testing.T) {
	cs := NewClaudes()
	sp := &claude.Spawner{}
	got := cs.Factory()(aliases.Alias{ID: "a_x"}, sp)
	if got != aliases.Claude(cs.For("a_x")) || cs.Spawner("a_x") != sp || cs.Spawner("a_y") != nil {
		t.Fatal("factory")
	}
}

func TestEvents(t *testing.T) {
	var e Events
	e.Broadcast(map[string]any{"type": "other", "x": 1})
	e.Broadcast(map[string]any{"type": aliases.EventAliases, "aliases": aliases.List{
		DefaultImage: "img",
		Aliases:      []aliases.View{{Alias: aliases.Alias{ID: "a_x", Name: "Work"}}},
	}})
	e.Broadcast(struct {
		Type    string       `json:"type"`
		Aliases aliases.List `json:"aliases"`
	}{aliases.EventAliases, aliases.List{Docker: aliases.DockerState{OK: true}}})
	if e.Count() != 2 || len(e.Raw()) != 3 {
		t.Fatalf("count %d raw %d", e.Count(), len(e.Raw()))
	}
	if l := e.Lists()[0]; l.DefaultImage != "img" || len(l.Aliases) != 1 || l.Aliases[0].Name != "Work" {
		t.Fatalf("list %+v", l)
	}
	if l, ok := e.Last(); !ok || !l.Docker.OK {
		t.Fatalf("last %+v", l)
	}
	l := e.WaitFor(t, time.Second, func(l aliases.List) bool { return l.DefaultImage == "img" })
	if l.Aliases[0].ID != "a_x" {
		t.Fatal("waitfor")
	}
	go func() {
		time.Sleep(10 * time.Millisecond)
		e.Broadcast(map[string]any{"type": aliases.EventAliases, "aliases": aliases.List{DefaultImage: "late"}})
	}()
	e.WaitFor(t, time.Second, func(l aliases.List) bool { return l.DefaultImage == "late" })
}

func TestWorkOnStop(t *testing.T) {
	w := NewWork()
	w.SetBusy("claude:a_x", 2)
	var seen []string
	w.OnStop(func(kind model.AgentKind) {
		// Called before StopKind records: the kind still works, and w can be asked.
		seen = append(seen, string(kind)+" "+strconv.Itoa(w.Busy(kind)))
	})
	w.StopKind("claude:a_x")
	if !slices.Equal(seen, []string{"claude:a_x 2"}) || w.Busy("claude:a_x") != 0 ||
		!slices.Equal(w.Stopped(), []model.AgentKind{"claude:a_x"}) {
		t.Fatalf("seen %q, busy %d, stopped %v", seen, w.Busy("claude:a_x"), w.Stopped())
	}
	w.OnStop(nil)
	w.StopKind("claude:a_y")
	if len(seen) != 1 || len(w.Stopped()) != 2 {
		t.Fatalf("after OnStop(nil): seen %q, stopped %v", seen, w.Stopped())
	}
}
