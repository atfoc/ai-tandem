package aliases_test

import (
	"context"
	"errors"
	"os/exec"
	"slices"
	"sync"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/container"
)

func TestCommandEnsuresAndExecs(t *testing.T) {
	e := newSvc(t)
	m := e.folder()
	v := e.add("Work", m)
	want := exec.Command("echo", "from exec")
	e.cont.ExecProgram(func(string, container.ExecOptions) *exec.Cmd { return want })

	run, err := e.svc.RunnerFor(v.Kind).Command(context.Background(), m,
		[]string{"A=1", "CLAUDE_CONFIG_DIR=/evil"}, []string{"claude", "-p", "hi"})
	if err != nil {
		t.Fatal(err)
	}
	if run.Cmd != want {
		t.Error("Cmd is not what Exec gave")
	}
	if e.cont.Count("create "+v.ID) != 1 || e.cont.Count("start "+v.ID) != 1 {
		t.Errorf("calls %v", e.cont.Calls())
	}
	if rec, _ := e.record(v.ID); rec.Applied == nil || !slices.Equal(rec.Applied.Mounts, []string{m}) ||
		rec.Applied.Image != container.DefaultImage() {
		t.Errorf("applied %+v", rec.Applied)
	}
	execs := e.cont.Execs()
	if len(execs) != 1 {
		t.Fatalf("execs %v", execs)
	}
	o := execs[0]
	if o.Dir != m || !slices.Equal(o.Argv, []string{"claude", "-p", "hi"}) || o.RunID != run.ID {
		t.Errorf("exec %+v, run id %q", o, run.ID)
	}
	wantEnv := []string{
		"A=1", "CLAUDE_CONFIG_DIR=/evil",
		"CLAUDE_CONFIG_DIR=" + aliases.ClaudeDir(e.root, v.ID),
		"HOME=" + aliases.HomeDir(e.root, v.ID),
		"CLAUDE_CODE_DISABLE_AUTO_MEMORY=1",
		"DISABLE_AUTOUPDATER=1",
		"AIWB_RUN=" + run.ID,
	}
	if !slices.Equal(o.Env, wantEnv) {
		t.Errorf("env\n got %q\nwant %q", o.Env, wantEnv)
	}
	if got := e.viewOf(v.ID).Container.State; got != aliases.ContainerRunning {
		t.Errorf("container %s", got)
	}
}

// Each run has an id of its own (container.NewRunID), the same in AIWB_RUN, in the exec's
// RunID, in Run.ID and in the KillRun its Kill makes.
func TestCommandRunIDs(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work")
	first, second := e.start(v), e.start(v)
	if first.ID == "" || second.ID == "" || first.ID == second.ID {
		t.Fatalf("run ids %q and %q, want two different ones", first.ID, second.ID)
	}
	execs := e.cont.Execs()
	if len(execs) != 2 {
		t.Fatalf("execs %v", execs)
	}
	for i, run := range []*agent.Run{first, second} {
		o := execs[i]
		if o.RunID != run.ID {
			t.Errorf("run %d: exec RunID %q, Run.ID %q", i, o.RunID, run.ID)
		}
		if tag := "AIWB_RUN=" + run.ID; !slices.Contains(o.Env, tag) || o.Env[len(o.Env)-1] != tag {
			t.Errorf("run %d: env %q, want %s last", i, o.Env, tag)
		}
		if err := run.Kill(); err != nil {
			t.Fatal(err)
		}
		if k := e.cont.Kills(); len(k) != i+1 || k[i] != run.ID {
			t.Errorf("run %d: kills %q, want %q last", i, k, run.ID)
		}
		if e.cont.Count("kill "+v.ID+" "+run.ID) != 1 {
			t.Errorf("run %d: calls %v", i, e.cont.Calls())
		}
	}
}

func TestCommandDefaultDirIsAccountFolder(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work")
	e.start(v)
	if o := e.cont.Execs()[0]; o.Dir != aliases.Dir(e.root, v.ID) {
		t.Errorf("dir %q", o.Dir)
	}
}

func TestCommandKill(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work")
	run := e.start(v)
	if err := run.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := run.Kill(); err != nil { // again: KillRun again, no panic
		t.Fatal(err)
	}
	if k := e.cont.Kills(); run.ID == "" || len(k) != 2 || k[0] != run.ID || k[1] != run.ID {
		t.Errorf("kills %q of run %q", k, run.ID)
	}
	if e.cont.Count("kill "+v.ID) != 2 {
		t.Errorf("calls %v", e.cont.Calls())
	}
}

func TestCommandDockerUnavailable(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work")
	e.cont.SetAvailable(notRunning)
	_, err := e.svc.RunnerFor(v.Kind).Command(context.Background(), "", nil, []string{"claude"})
	if !errors.Is(err, notRunning) {
		t.Fatalf("err = %v", err)
	}
	if len(e.cont.Execs()) != 0 || e.cont.Count("ensure") != 0 {
		t.Errorf("calls %v", e.cont.Calls())
	}
}

func TestCommandCreateFailure(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work")
	why := "mounts denied: the path is not shared from the host"
	e.cont.FailCreate(errors.New(why))
	_, err := e.svc.RunnerFor(v.Kind).Command(context.Background(), "", nil, []string{"claude"})
	if err == nil || err.Error() != why {
		t.Fatalf("err = %v", err)
	}
	if len(e.cont.Execs()) != 0 {
		t.Error("exec after a failed create")
	}
	got := e.viewOf(v.ID).Container
	if got.State != aliases.ContainerError || got.Reason != why {
		t.Errorf("container %+v", got)
	}
}

func TestCommandConcurrentOneCreate(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work")
	r := e.svc.RunnerFor(v.Kind)
	release := e.cont.BlockEnsure()
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := r.Command(context.Background(), "", nil, []string{"claude"})
			errs <- err
		}()
	}
	release()
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Error(err)
		}
	}
	if n := e.cont.Count("create " + v.ID); n != 1 {
		t.Errorf("%d creates: %v", n, e.cont.Calls())
	}
	if n := len(e.cont.Execs()); n != 8 {
		t.Errorf("%d execs", n)
	}
}

func TestCommandRemoved(t *testing.T) {
	e := newSvc(t)
	v := e.add("Work")
	r := e.svc.RunnerFor(v.Kind)
	if err := e.svc.Remove(v.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Command(context.Background(), "", nil, []string{"claude"}); !errors.Is(err, aliases.ErrRemoved) {
		t.Errorf("err = %v", err)
	}
}

func TestCommandOldSpecFolderRefused(t *testing.T) {
	e := newSvc(t)
	m1, m2, m3 := e.folder(), e.folder(), e.folder()
	v := e.add("Work", m1)
	e.start(v)
	e.work.SetBusy(v.Kind, 1)
	if c, _ := e.editMounts(v.ID, m1, m2); c.Restart != aliases.RestartBusy {
		t.Fatalf("change %+v", c)
	}
	r := e.svc.RunnerFor(v.Kind)
	_, err := r.Command(context.Background(), m2, nil, []string{"claude"})
	var me *aliases.MountError
	if !errors.As(err, &me) || !me.Pending || me.Folder != m2 || me.Account != "Work" {
		t.Fatalf("saved only: %#v", err)
	}
	if _, err := r.Command(context.Background(), m3, nil, []string{"claude"}); !errors.As(err, &me) || me.Pending {
		t.Fatalf("neither: %#v", err)
	}
	if _, err := r.Command(context.Background(), m1, nil, []string{"claude"}); err != nil {
		t.Errorf("applied: %v", err)
	}
	if _, err := r.Command(context.Background(), aliases.MCPDir(e.root, v.ID), nil, []string{"claude"}); err != nil {
		t.Errorf("account folder: %v", err)
	}
	if e.cont.Count("recreate") != 0 {
		t.Error("recreated")
	}
}

func TestShutdownKillsLiveRuns(t *testing.T) {
	e := newSvc(t)
	a := e.add("Work")
	b := e.add("Personal")
	ra := e.start(a)
	rb := e.start(b)
	done := e.start(a)
	done.Kill() // ended before: not killed again
	if ids := []string{ra.ID, rb.ID, done.ID}; slices.Contains(ids, "") || len(slices.Compact(slices.Sorted(slices.Values(ids)))) != 3 {
		t.Fatalf("run ids %q, want three different ones", ids)
	}
	before := len(e.cont.Kills())

	e.svc.Shutdown()
	kills := e.cont.Kills()[before:]
	if len(kills) != 2 || !slices.Contains(kills, ra.ID) || !slices.Contains(kills, rb.ID) {
		t.Errorf("kills %q", kills)
	}
	if e.cont.Count("kill "+a.ID) != 2 || e.cont.Count("kill "+b.ID) != 1 {
		t.Errorf("calls %v", e.cont.Calls())
	}
	e.svc.Shutdown() // again: nothing
	if len(e.cont.Kills()) != before+2 {
		t.Error("second Shutdown killed again")
	}
}

func TestSpawnerOfAccount(t *testing.T) {
	e := newSvc(t, func(o *aliases.Options) { o.Prompt = "the prompt" })
	v := e.add("Work")
	sp, ok := e.svc.Spawner(v.Kind).(*claude.Spawner)
	if !ok {
		t.Fatalf("Spawner = %T", e.svc.Spawner(v.Kind))
	}
	if sp.Bin != "claude" || sp.AppRoot != e.root || sp.Home != "" || sp.Prompt != "the prompt" ||
		sp.MCPURL != mcpURL || sp.MCPDir != aliases.MCPDir(e.root, v.ID) || sp.Runner == nil {
		t.Errorf("spawner %+v", sp)
	}
	if again := e.svc.Spawner(v.Kind); again != sp {
		t.Error("spawner not kept")
	}
	if e.svc.RunnerFor(v.Kind) != sp.Runner {
		t.Error("RunnerFor is not the spawner's runner")
	}
	if d := e.svc.DirOf(v.Kind); d != aliases.Dir(e.root, v.ID) {
		t.Errorf("DirOf = %q", d)
	}
	if sp := e.svc.Spawner("claude:a_00000000"); sp != nil {
		t.Errorf("unknown kind: %#v", sp)
	}
	// The account's Claude is made of that spawner.
	if _, err := e.svc.Logout(v.ID); err != nil {
		t.Fatal(err)
	}
	// The account's Claude is made of a copy of that spawner whose runner is not refused while
	// the account restarts (its own runs: auth status, login, logout).
	own := e.claudes.Spawner(v.ID)
	if own == nil || own == sp || own.Runner == nil || own.Runner == sp.Runner {
		t.Fatalf("Claude made of %+v", own)
	}
	if own.Bin != sp.Bin || own.AppRoot != sp.AppRoot || own.Home != sp.Home || own.Prompt != sp.Prompt ||
		own.MCPURL != sp.MCPURL || own.MCPDir != sp.MCPDir {
		t.Errorf("Claude's spawner %+v, chats' %+v", own, sp)
	}
}
