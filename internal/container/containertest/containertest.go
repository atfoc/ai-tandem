// Package containertest gives a test its own stand-in docker program
// (internal/container/fakedocker): a wrapper script that runs the stand-in with a state folder of
// the test's, and the knobs and records of that state.
package containertest

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// Fake is one test's stand-in docker.
type Fake struct {
	Bin string // the docker program to give the code under test: a wrapper script in t.TempDir()
	Dir string // the stand-in's state folder

	t   testing.TB
	bin string // the stand-in binary the wrapper runs
}

// Mode is how the stand-in answers every call.
type Mode string

const (
	ModeOK      Mode = ""        // as Docker does
	ModeMissing Mode = "missing" // there is no docker program: Bin does not exist
	ModeFail    Mode = "fail"    // every call fails with a daemon error
	ModeSlow    Mode = "slow"    // every call first sleeps (SetSlow, default 30s)
	ModeDown    Mode = "down"    // every call fails as when the daemon is not running
)

// Build is one `docker build`: the image tagged and the Dockerfile read from stdin.
type Build struct {
	Image, Dockerfile string
}

// Container is one container as the stand-in has it.
type Container struct {
	ID, Name, State string // State: created, running, exited
	Labels          map[string]string
	Image           string
	Binds           []string // "src:dst" in the order given
	User            string
	Init            bool
	ExtraHosts      []string
	Cmd             []string
	Args            []string // the create args after "create"
}

// Run is one run started through the run wrapper (container.RunName or RunTTYName). Pgid is the
// host process group it runs in; Live says it has not ended (or been killed) yet.
type Run struct {
	ID, Container string
	Pgid          int
	TTY, Live     bool
}

var (
	buildOnce sync.Once
	builtBin  string
	buildErr  string
)

// New gives the test its own stand-in docker: Bin is the path of a per-test wrapper script (in
// t.TempDir()) that runs the stand-in with its own state folder; give Bin as the docker program.
// It skips the test on Windows. The stand-in is built once per test binary.
func New(t testing.TB) *Fake {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the stand-in docker runs on Unix only")
	}
	buildOnce.Do(buildStandIn)
	if buildErr != "" {
		t.Fatalf("building the stand-in docker: %s", buildErr)
	}
	base := t.TempDir()
	f := &Fake{Bin: filepath.Join(base, "docker"), Dir: filepath.Join(base, "state"), t: t, bin: builtBin}
	if err := os.Mkdir(f.Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	f.writeWrapper()
	return f
}

func shq(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func (f *Fake) writeWrapper() {
	script := "#!/bin/sh\nAIWB_FAKEDOCKER_STATE=" + shq(f.Dir) + " exec " + shq(f.bin) + " \"$@\"\n"
	tmp := f.Bin + ".tmp"
	if err := os.WriteFile(tmp, []byte(script), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.Rename(tmp, f.Bin); err != nil {
		f.t.Fatal(err)
	}
}

// moduleRoot is the folder of go.mod, found from this file's path, else from the working folder.
func moduleRoot() string {
	if _, file, _, ok := runtime.Caller(0); ok {
		root := filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(file))))
		if _, err := os.Stat(filepath.Join(root, "go.mod")); err == nil {
			return root
		}
	}
	dir, _ := os.Getwd()
	for d := dir; ; d = filepath.Dir(d) {
		if _, err := os.Stat(filepath.Join(d, "go.mod")); err == nil {
			return d
		}
		if filepath.Dir(d) == d {
			return dir
		}
	}
}

func goTool() string {
	p := filepath.Join(runtime.GOROOT(), "bin", "go")
	if _, err := os.Stat(p); err == nil {
		return p
	}
	if p, err := exec.LookPath("go"); err == nil {
		return p
	}
	return "go"
}

// buildStandIn builds the stand-in into a temp file of one folder per module and renames it to
// that folder's fixed name: concurrent test binaries replace it atomically, nothing piles up, and
// what runs is always what this test binary built.
func buildStandIn() {
	root := moduleRoot()
	h := sha256.Sum256([]byte(root))
	dir := filepath.Join(os.TempDir(), "aiwb-fakedocker-"+hex.EncodeToString(h[:4]))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		buildErr = err.Error()
		return
	}
	tmp, err := os.CreateTemp(dir, "fakedocker-*.tmp")
	if err != nil {
		buildErr = err.Error()
		return
	}
	tmp.Close()
	defer os.Remove(tmp.Name())
	cmd := exec.Command(goTool(), "build", "-o", tmp.Name(), "ai-whiteboard/internal/container/fakedocker")
	cmd.Dir = root
	if out, err := cmd.CombinedOutput(); err != nil {
		buildErr = err.Error() + "\n" + string(out)
		return
	}
	final := filepath.Join(dir, "fakedocker")
	if err := os.Rename(tmp.Name(), final); err != nil {
		buildErr = err.Error()
		return
	}
	builtBin = final
}

// SetMode sets how the stand-in answers. ModeMissing removes Bin; any other mode puts it back.
func (f *Fake) SetMode(m Mode) {
	if m == ModeMissing {
		if err := os.Remove(f.Bin); err != nil && !os.IsNotExist(err) {
			f.t.Fatal(err)
		}
	} else if _, err := os.Stat(f.Bin); err != nil {
		f.writeWrapper()
	}
	f.update(func(s *state) { s.Mode = string(m) })
}

// SetSlow sets how long ModeSlow sleeps before each answer (default 30s).
func (f *Fake) SetSlow(d time.Duration) { f.update(func(s *state) { s.Slow = d }) }

// SetBuildDelay sets how long `docker build` takes (default 0).
func (f *Fake) SetBuildDelay(d time.Duration) { f.update(func(s *state) { s.BuildDelay = d }) }

// SetPullDelay sets how long `docker pull` takes (default 0).
func (f *Fake) SetPullDelay(d time.Duration) { f.update(func(s *state) { s.PullDelay = d }) }

// FailOn makes every call of the command cmd ("create", "start", "stop", "rm", "exec", "inspect",
// "build", "pull", "version", "ps", "image") print line on stderr and exit 1. An empty line clears it.
func (f *Fake) FailOn(cmd, line string) {
	f.update(func(s *state) {
		if line == "" {
			delete(s.FailOn, cmd)
			return
		}
		if s.FailOn == nil {
			s.FailOn = map[string]string{}
		}
		s.FailOn[cmd] = line
	})
}

// AddImage makes image present, as if it had been pulled or built.
func (f *Fake) AddImage(image string) {
	f.update(func(s *state) {
		if s.Images == nil {
			s.Images = map[string]string{}
		}
		img := normImage(image)
		h := sha256.Sum256([]byte(img))
		s.Images[img] = "sha256:" + hex.EncodeToString(h[:])
	})
}

// Images is every image present, sorted (an image named without a tag has ":latest").
func (f *Fake) Images() []string {
	s := f.read()
	var out []string
	for img := range s.Images {
		out = append(out, img)
	}
	slices.Sort(out)
	return out
}

// Builds is every `docker build`, in order.
func (f *Fake) Builds() []Build {
	var out []Build
	for _, b := range f.read().Builds {
		out = append(out, Build{Image: b.Image, Dockerfile: b.Dockerfile})
	}
	return out
}

// Pulls is every `docker pull` that succeeded, the image as named, in order.
func (f *Fake) Pulls() []string { return slices.Clone(f.read().Pulls) }

// Containers is every container, sorted by name.
func (f *Fake) Containers() []Container {
	var out []Container
	for _, c := range f.read().Containers {
		out = append(out, Container{
			ID: c.ID, Name: c.Name, State: c.State, Labels: c.Labels, Image: c.Image, Binds: c.Binds,
			User: c.User, Init: c.Init, ExtraHosts: c.ExtraHosts, Cmd: c.Cmd, Args: c.Args,
		})
	}
	slices.SortFunc(out, func(a, b Container) int { return strings.Compare(a.Name, b.Name) })
	return out
}

// Container is the container named name.
func (f *Fake) Container(name string) (Container, bool) {
	for _, c := range f.Containers() {
		if c.Name == name {
			return c, true
		}
	}
	return Container{}, false
}

// SetState puts the container named name in state ("created", "running", "exited"), as if it had
// changed behind the server's back; its runs are killed when the state is not "running". A
// missing container fails the test.
func (f *Fake) SetState(name, st string) {
	f.t.Helper()
	found := false
	f.update(func(s *state) {
		c := s.Find(name)
		if c == nil {
			return
		}
		found = true
		c.State = st
		if st != "running" {
			s.KillRuns(c.Name)
		}
	})
	if !found {
		f.t.Fatalf("stand-in docker: no container %q", name)
	}
}

// Calls is every invocation's args (without the program name), in order.
func (f *Fake) Calls() [][]string {
	f.t.Helper()
	c, err := calls(f.Dir)
	if err != nil {
		f.t.Fatalf("stand-in docker calls: %v", err)
	}
	return c
}

// CallsOf is the calls whose first arg is cmd ("exec", "create", ...).
func (f *Fake) CallsOf(cmd string) [][]string {
	var out [][]string
	for _, c := range f.Calls() {
		if len(c) > 0 && c[0] == cmd {
			out = append(out, c)
		}
	}
	return out
}

// Runs is every run started through the run wrapper, in order. A run whose process group is gone
// is not Live, even when its stand-in did not live to record the end.
func (f *Fake) Runs() []Run {
	var out []Run
	for _, r := range f.read().Runs {
		out = append(out, Run{ID: r.ID, Container: r.Container, Pgid: r.Pgid, TTY: r.TTY, Live: r.Live && groupAlive(r.Pgid)})
	}
	return out
}

// Kills is the run ids the kill wrapper (container.KillName) was run for, in order.
func (f *Fake) Kills() []string { return slices.Clone(f.read().Kills) }

func (f *Fake) read() *state {
	f.t.Helper()
	s, err := readState(f.Dir)
	if err != nil {
		f.t.Fatalf("stand-in docker state: %v", err)
	}
	return s
}

func (f *Fake) update(fn func(*state)) {
	f.t.Helper()
	if err := updateState(f.Dir, func(s *state) error { fn(s); return nil }); err != nil {
		f.t.Fatalf("stand-in docker state: %v", err)
	}
}
