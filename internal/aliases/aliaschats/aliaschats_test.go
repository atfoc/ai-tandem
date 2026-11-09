package aliaschats_test

import (
	"os/exec"
	"runtime"
	"slices"
	"testing"
	"time"

	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/aliases/aliaschats"
	"ai-whiteboard/internal/aliases/aliasestest"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/model"
)

var _ func(*aliases.Service) chats.Accounts = aliaschats.Accounts

// newSvc is a service on the fakes whose Exec runs script with /bin/sh on this computer, and
// one account of it.
func newSvc(t *testing.T, script string) (*aliases.Service, *aliasestest.Containers, aliases.View) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("runs /bin/sh")
	}
	cont := aliasestest.NewContainers()
	cont.ExecProgram(func(alias string, o container.ExecOptions) *exec.Cmd {
		return exec.Command("/bin/sh", "-c", script)
	})
	svc, err := aliases.New(aliases.Options{
		Root: t.TempDir(), Home: t.TempDir(), Containers: cont, Work: aliasestest.NewWork(),
		Claude: aliasestest.NewClaudes().Factory(), Logf: t.Logf, Waits: aliases.Waits{Stale: time.Hour},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Shutdown)
	name, mounts := "Work", []string{}
	v, err := svc.Add(aliases.Input{Name: &name, Mounts: &mounts})
	if err != nil {
		t.Fatal(err)
	}
	return svc, cont, v
}

func TestNamerRunsInTheContainer(t *testing.T) {
	svc, cont, v := newSvc(t, `echo "  Fix the login bug."`)
	n := aliaschats.Accounts(svc).Namer(v.Kind)
	if n == nil {
		t.Fatal("no namer for an account")
	}
	title, err := n.Name("the login fails")
	if err != nil || title != "Fix the login bug" {
		t.Fatalf("Name: %q, %v", title, err)
	}
	execs := cont.Execs()
	if len(execs) != 1 {
		t.Fatalf("%d execs, want 1", len(execs))
	}
	o := execs[0]
	if o.Dir != svc.DirOf(v.Kind) || len(o.Argv) == 0 || o.Argv[0] != "claude" {
		t.Fatalf("exec: dir %q argv %q, want dir %q and claude", o.Dir, o.Argv, svc.DirOf(v.Kind))
	}
	if i := slices.Index(o.Argv, "--model"); i < 0 || i+1 >= len(o.Argv) || o.Argv[i+1] != "haiku" {
		t.Fatalf("argv %q has no --model haiku", o.Argv)
	}
	if !slices.Equal(o.Argv[1:], chats.ClaudeNamer{}.Args("the login fails")) {
		t.Fatalf("argv %q, want claude and ClaudeNamer's", o.Argv)
	}
	if o.RunID == "" || !slices.Contains(o.Env, "AIWB_RUN="+o.RunID) {
		t.Fatalf("exec run id %q, env %q", o.RunID, o.Env)
	}
	if k := cont.Kills(); !slices.Equal(k, []string{o.RunID}) {
		t.Fatalf("kills %q, want the run %q once", k, o.RunID)
	}
}

func TestNamerNoUsableTitle(t *testing.T) {
	for _, script := range []string{`printf '   \n'`, `printf '%070d\n' 0`, `echo partial; exit 3`} {
		svc, cont, v := newSvc(t, script)
		if title, err := aliaschats.Accounts(svc).Namer(v.Kind).Name("x"); err == nil {
			t.Fatalf("%s: title %q, want an error", script, title)
		}
		if len(cont.Kills()) != 1 {
			t.Fatalf("%s: kills %q, want one", script, cont.Kills())
		}
	}
}

func TestNamerTimeout(t *testing.T) {
	svc, cont, v := newSvc(t, `exec sleep 30`)
	n := aliaschats.WithTimeout(aliaschats.Accounts(svc).Namer(v.Kind), 200*time.Millisecond)
	start := time.Now()
	if title, err := n.Name("x"); err == nil {
		t.Fatalf("title %q, want the time limit", title)
	}
	if d := time.Since(start); d > 10*time.Second {
		t.Fatalf("Name took %v", d)
	}
	if len(cont.Kills()) != 1 {
		t.Fatalf("kills %q, want one", cont.Kills())
	}
}

func TestRemovedAndUnknownKinds(t *testing.T) {
	svc, _, v := newSvc(t, `echo Title`)
	acc := aliaschats.Accounts(svc)
	if err := svc.Remove(v.ID); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []model.AgentKind{v.Kind, model.AliasKind("a_nothere")} {
		if n := acc.Namer(kind); n != nil {
			t.Fatalf("%s: namer %#v, want nil", kind, n)
		}
		if sp := acc.Spawner(kind); sp != nil {
			t.Fatalf("%s: spawner %#v, want nil", kind, sp)
		}
		if err := acc.CheckFolder(kind, "/tmp"); err != aliases.ErrRemoved {
			t.Fatalf("%s: CheckFolder %v, want ErrRemoved", kind, err)
		}
	}
}
