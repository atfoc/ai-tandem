package container

import (
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func TestSpecHash(t *testing.T) {
	a := Spec{Alias: "a_k3j2m9x0", Image: "aiwb/claude:1", Dir: "/d/aliases/a_k3j2m9x0", Mounts: []string{"/w/one", "/w/two"}}
	b := a
	b.Mounts = []string{"/w/two/", "/w/one", "/w/one"}
	if a.Hash() != b.Hash() {
		t.Errorf("the order, a trailing slash or a repeat of the mounts changed the hash")
	}
	for name, c := range map[string]Spec{
		"image":  {Alias: a.Alias, Image: "other", Dir: a.Dir, Mounts: a.Mounts},
		"mounts": {Alias: a.Alias, Image: a.Image, Dir: a.Dir, Mounts: []string{"/w/one"}},
		"user":   {Alias: a.Alias, Image: a.Image, Dir: a.Dir, Mounts: a.Mounts, User: "501:20"},
		"dir":    {Alias: a.Alias, Image: a.Image, Dir: "/e", Mounts: a.Mounts},
	} {
		if c.Hash() == a.Hash() {
			t.Errorf("another %s gives the same hash", name)
		}
	}
	if Name("a_k3j2m9x0") != "aiwb-alias-a_k3j2m9x0" {
		t.Errorf("Name = %q", Name("a_k3j2m9x0"))
	}
}

func TestCreateArgs(t *testing.T) {
	spec := Spec{Alias: "a_k3j2m9x0", Image: "aiwb/claude:1", Dir: "/d/aliases/a_k3j2m9x0",
		Mounts: []string{"/w/one", "/w/two/", "/w/one/", "/d/aliases/a_k3j2m9x0/", "/w/three"}, User: "501:20"}
	want := []string{"create", "--name", "aiwb-alias-a_k3j2m9x0", "--init",
		"--label", "aiwb.alias=a_k3j2m9x0", "--label", "aiwb.spec=" + spec.Hash(),
		"-v", "/d/aliases/a_k3j2m9x0:/d/aliases/a_k3j2m9x0",
		"-v", "/w/one:/w/one", "-v", "/w/two:/w/two", "-v", "/w/three:/w/three",
		"--add-host", "host.docker.internal:host-gateway", "--user", "501:20",
		"--", "aiwb/claude:1", "sleep", "infinity"}
	if got := CreateArgs(spec); !slices.Equal(got, want) {
		t.Errorf("CreateArgs =\n%q\nwant\n%q", got, want)
	}

	spec = Spec{Alias: "a_x", Image: "img", Dir: "/d/a_x"}
	want = []string{"create", "--name", "aiwb-alias-a_x", "--init",
		"--label", "aiwb.alias=a_x", "--label", "aiwb.spec=" + spec.Hash(),
		"-v", "/d/a_x:/d/a_x", "--add-host", "host.docker.internal:host-gateway", "--", "img", "sleep", "infinity"}
	if got := CreateArgs(spec); !slices.Equal(got, want) {
		t.Errorf("CreateArgs without user or mounts =\n%q\nwant\n%q", got, want)
	}

	// An image that looks like an option stays the image: "--" comes right before it.
	for _, img := range []string{"--privileged", "-v=/:/host"} {
		got := CreateArgs(Spec{Alias: "a_x", Image: img, Dir: "/d/a_x", User: "1:1"})
		if n := len(got); n < 4 || !slices.Equal(got[n-4:], []string{"--", img, "sleep", "infinity"}) || slices.Index(got, "--") != n-4 {
			t.Errorf("CreateArgs with image %q = %q", img, got)
		}
	}
}

func TestExecArgs(t *testing.T) {
	m := &Manager{Bin: "/no/such/docker"}
	argv := []string{"claude", "-p", "it's a \"test\"", "two  spaces"}
	head := []string{"/no/such/docker", "exec", "-i", "-w", "/w/one", "-e", "HOME=/d/home", "-e", "X=a b", "-e", "AIWB_RUN=r0123456789abcdef", "aiwb-alias-a_x"}
	for _, c := range []struct {
		name string
		o    ExecOptions
		want []string
	}{
		{"run", ExecOptions{Dir: "/w/one", Env: []string{"HOME=/d/home", "X=a b"}, RunID: "r0123456789abcdef", Argv: argv},
			append(append(slices.Clone(head), "/bin/sh", "-c", RunScript, "aiwb-run"), argv...)},
		{"tty", ExecOptions{Dir: "/w/one", Env: []string{"HOME=/d/home", "X=a b"}, RunID: "r0123456789abcdef", Argv: argv, TTY: true},
			append(append(slices.Clone(head), "/bin/sh", "-c", RunScript, "aiwb-run-tty",
				`'claude' '-p' 'it'\''s a "test"' 'two  spaces'`), argv...)},
		{"no dir", ExecOptions{RunID: "r1", Argv: []string{"claude", "--version"}},
			[]string{"/no/such/docker", "exec", "-i", "-e", "AIWB_RUN=r1", "aiwb-alias-a_x", "/bin/sh", "-c", RunScript, "aiwb-run", "claude", "--version"}},
		{"no run id", ExecOptions{Dir: "/w", Env: []string{"A=1"}, Argv: []string{"claude", "--version"}, TTY: true},
			[]string{"/no/such/docker", "exec", "-i", "-w", "/w", "-e", "A=1", "aiwb-alias-a_x", "claude", "--version"}},
	} {
		cmd := m.Exec("a_x", c.o)
		if !slices.Equal(cmd.Args, c.want) {
			t.Errorf("%s: Args =\n%q\nwant\n%q", c.name, cmd.Args, c.want)
		}
		if !slices.Equal(cmd.Env, os.Environ()) {
			t.Errorf("%s: Env is not this process's environment", c.name)
		}
		if cmd.Process != nil {
			t.Errorf("%s: the command was started", c.name)
		}
	}
}

func TestExecQuoteRunsInShell(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no /bin/sh")
	}
	argv := []string{"printf", "%s|", "it's a \"test\"", "two  spaces", "$HOME"}
	out, err := exec.Command("/bin/sh", "-c", "eval \"$1\"", "sh", shellQuote(argv)).Output()
	if err != nil {
		t.Fatal(err)
	}
	if want := `it's a "test"|two  spaces|$HOME|`; string(out) != want {
		t.Errorf("the quoted command printed %q, want %q", out, want)
	}
}

func TestNewRunID(t *testing.T) {
	re := regexp.MustCompile(`^r[0-9a-f]{16}$`)
	seen := map[string]bool{}
	for range 1000 {
		id := NewRunID()
		if !re.MatchString(id) {
			t.Fatalf("NewRunID = %q", id)
		}
		if seen[id] {
			t.Fatalf("NewRunID repeated %q", id)
		}
		seen[id] = true
	}
}

func TestAvailableBeforeAnyLook(t *testing.T) {
	m := &Manager{Bin: "/no/such/docker"}
	u, ok := IsUnavailable(m.Available())
	if runtime.GOOS == "windows" {
		if !ok || u.Kind != Unsupported {
			t.Fatalf("Available on Windows = %v", m.Available())
		}
		return
	}
	if !ok || u.Kind != NotRunning || u.Reason != "Docker has not been looked at yet" {
		t.Fatalf("Available before any look = %#v", m.Available())
	}
}

func TestDockerfile(t *testing.T) {
	d := string(Dockerfile())
	for _, s := range []string{"FROM node:22-bookworm-slim", "@anthropic-ai/claude-code", "util-linux", "bsdutils", "procps", "DISABLE_AUTOUPDATER=1"} {
		if !strings.Contains(d, s) {
			t.Errorf("the Dockerfile has no %q", s)
		}
	}
}
