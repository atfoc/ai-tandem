package container

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
)

// A tiny docker of the tests of docker.go: a shell script that does what the file "mode" next to
// it says. The full stand-in docker (internal/container/fakedocker) is for the tests of Ensure,
// Recreate and the runs.
const scriptDocker = `#!/bin/sh
mode=$(cat "$(dirname "$0")/mode" 2>/dev/null)
case $mode in
down) echo "failed to connect to the docker API at unix:///x/docker.sock; check if the path is correct and if the daemon is running: dial unix /x/docker.sock: connect: no such file or directory" >&2; exit 1;;
daemon) echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1;;
slow) sleep 5; exit 0;;
fail) printf 'Error response from daemon: mounts denied: \nThe path /x is not shared from the host and is not known to Docker.\n' >&2; echo "Run 'docker $1 --help' for more information" >&2; exit 1;;
esac
case $1 in
version) echo 29.0.0;;
inspect) echo '[]'; echo "Error response from daemon: No such container: $4" >&2; exit 1;;
*) exit 0;;
esac
`

type scriptDockerT struct {
	t   *testing.T
	dir string
	bin string
}

func newScriptDocker(t *testing.T) *scriptDockerT {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the test docker is a shell script; accounts are unsupported on Windows")
	}
	d := &scriptDockerT{t: t, dir: t.TempDir()}
	d.bin = filepath.Join(d.dir, "docker")
	if err := os.WriteFile(d.bin, []byte(scriptDocker), 0o755); err != nil {
		t.Fatal(err)
	}
	return d
}

func (d *scriptDockerT) setMode(mode string) {
	d.t.Helper()
	tmp := filepath.Join(d.dir, "mode.tmp")
	if err := os.WriteFile(tmp, []byte(mode), 0o644); err != nil {
		d.t.Fatal(err)
	}
	if err := os.Rename(tmp, filepath.Join(d.dir, "mode")); err != nil {
		d.t.Fatal(err)
	}
}

func wantKind(t *testing.T, what string, err error, kind string) {
	t.Helper()
	u, ok := IsUnavailable(err)
	if !ok || u.Kind != kind {
		t.Fatalf("%s: %#v, want an *Unavailable of kind %s", what, err, kind)
	}
}

func TestDockerNotInstalled(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unsupported on Windows")
	}
	m := &Manager{Bin: filepath.Join(t.TempDir(), "no-docker")}
	err := m.Refresh(context.Background())
	wantKind(t, "Refresh", err, NotInstalled)
	if err.Error() != "Docker is not installed" {
		t.Errorf("reason %q", err)
	}
	wantKind(t, "Available", m.Available(), NotInstalled)
	_, err = m.Inspect(context.Background(), "a_x")
	wantKind(t, "Inspect", err, NotInstalled)

	m = &Manager{Bin: "aiwb-no-such-docker-program"} // looked up on PATH
	wantKind(t, "Refresh of a program not on PATH", m.Refresh(context.Background()), NotInstalled)
}

func TestDockerNotRunning(t *testing.T) {
	d := newScriptDocker(t)
	m := &Manager{Bin: d.bin}
	for _, mode := range []string{"down", "daemon"} {
		d.setMode(mode)
		err := m.Refresh(context.Background())
		wantKind(t, mode, err, NotRunning)
		if err.Error() != "Docker is not running" {
			t.Errorf("%s: reason %q", mode, err)
		}
	}
	d.setMode("ok")
	if err := m.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh with Docker back = %v", err)
	}
	if m.Available() != nil {
		t.Fatalf("Available = %v", m.Available())
	}
}

func TestDockerSlowIsNotRunning(t *testing.T) {
	d := newScriptDocker(t)
	d.setMode("slow")
	m := &Manager{Bin: d.bin, Timeout: 200 * time.Millisecond}
	start := time.Now()
	err := m.Refresh(context.Background())
	took := time.Since(start)
	wantKind(t, "Refresh of a docker that does not answer", err, NotRunning)
	if took > 1500*time.Millisecond {
		t.Errorf("Refresh took %v", took)
	}
	start = time.Now()
	_, err = m.Inspect(context.Background(), "a_x")
	wantKind(t, "Inspect", err, NotRunning)
	if took := time.Since(start); took > 1500*time.Millisecond {
		t.Errorf("Inspect took %v", took)
	}
}

func TestDockerOtherError(t *testing.T) {
	d := newScriptDocker(t)
	m := &Manager{Bin: d.bin}
	d.setMode("ok")
	if err := m.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	d.setMode("fail")
	_, err := m.Inspect(context.Background(), "a_x")
	var de *Error
	if !errors.As(err, &de) {
		t.Fatalf("Inspect = %#v, want an *Error", err)
	}
	want := "Error response from daemon: mounts denied: The path /x is not shared from the host and is not known to Docker."
	if de.Op != "inspect" || de.Error() != want {
		t.Errorf("Error = {%q, %q}, want {inspect, %q}", de.Op, de.Error(), want)
	}
	if m.Available() != nil {
		t.Errorf("an error that is Docker's answer changed Available to %v", m.Available())
	}
	// docker version answering with an error is a Failed Unavailable.
	err = m.Refresh(context.Background())
	wantKind(t, "Refresh", err, Failed)
	if err.Error() != want {
		t.Errorf("Failed reason %q", err)
	}
}

func TestInspectMissing(t *testing.T) {
	d := newScriptDocker(t)
	d.setMode("ok")
	m := &Manager{Bin: d.bin}
	info, err := m.Inspect(context.Background(), "a_x")
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != "aiwb-alias-a_x" || info.State != StateNone {
		t.Errorf("Inspect of a missing container = %+v", info)
	}
	if m.Available() != nil {
		t.Errorf("Available after a missing container = %v", m.Available())
	}
}

func TestDockerCallerGivesUp(t *testing.T) {
	d := newScriptDocker(t)
	d.setMode("slow")
	m := &Manager{Bin: d.bin, Timeout: 10 * time.Second}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := m.Inspect(ctx, "a_x")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Inspect = %v, want the context's error", err)
	}
	if took := time.Since(start); took > 1500*time.Millisecond {
		t.Errorf("Inspect took %v", took)
	}
	if u, _ := IsUnavailable(m.Available()); u == nil || u.Reason != "Docker has not been looked at yet" {
		t.Errorf("a caller that gave up stored %v", m.Available())
	}
}

// watchRecorder records what Watch tells.
type watchRecorder struct {
	mu  sync.Mutex
	got []error
	ch  chan error
}

func newWatchRecorder() *watchRecorder { return &watchRecorder{ch: make(chan error, 100)} }

func (r *watchRecorder) changed(err error) {
	r.mu.Lock()
	r.got = append(r.got, err)
	r.mu.Unlock()
	r.ch <- err
}

func (r *watchRecorder) next(t *testing.T, what string) error {
	t.Helper()
	select {
	case err := <-r.ch:
		return err
	case <-time.After(5 * time.Second):
		t.Fatalf("Watch told no change: %s", what)
		return nil
	}
}

func (r *watchRecorder) none(t *testing.T, what string, wait time.Duration) {
	t.Helper()
	select {
	case err := <-r.ch:
		t.Fatalf("Watch told %v: %s", err, what)
	case <-time.After(wait):
	}
}

func TestWatchLooks(t *testing.T) {
	d := newScriptDocker(t)
	d.setMode("ok")
	m := &Manager{Bin: d.bin} // QuickTimeout: a loaded machine must not turn "ok" into "not running"
	r := newWatchRecorder()
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() { m.Watch(50*time.Millisecond, stop, r.changed); close(done) }()

	if err := r.next(t, "the first look"); err != nil {
		t.Fatalf("first look told %v, want nil", err)
	}
	r.none(t, "nothing changed", 200*time.Millisecond)
	d.setMode("down")
	wantKind(t, "Docker went down", r.next(t, "Docker went down"), NotRunning)
	d.setMode("ok")
	if err := r.next(t, "Docker came back"); err != nil {
		t.Fatalf("Docker came back told %v", err)
	}
	close(stop)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Watch did not return once stop was closed")
	}
}

func TestWatchToldOfOtherCalls(t *testing.T) {
	d := newScriptDocker(t)
	d.setMode("ok")
	m := &Manager{Bin: d.bin} // QuickTimeout: a loaded machine must not turn "ok" into "not running"
	r1, r2 := newWatchRecorder(), newWatchRecorder()
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for _, r := range []*watchRecorder{r1, r2} {
		wg.Add(1)
		go func() { defer wg.Done(); m.Watch(time.Hour, stop, r.changed) }()
	}
	for _, r := range []*watchRecorder{r1, r2} {
		if err := r.next(t, "the first look"); err != nil {
			t.Fatalf("first look told %v", err)
		}
	}

	d.setMode("down")
	_, err := m.Inspect(context.Background(), "a_x")
	wantKind(t, "Inspect", err, NotRunning)
	for _, r := range []*watchRecorder{r1, r2} {
		wantKind(t, "a failing Inspect", r.next(t, "a failing Inspect"), NotRunning)
	}
	_, err = m.Inspect(context.Background(), "a_x") // the same answer again: no change
	wantKind(t, "Inspect", err, NotRunning)
	r1.none(t, "the same answer again", 100*time.Millisecond)

	d.setMode("ok")
	if _, err := m.Inspect(context.Background(), "a_x"); err != nil {
		t.Fatal(err)
	}
	for _, r := range []*watchRecorder{r1, r2} {
		if err := r.next(t, "a succeeding Inspect"); err != nil {
			t.Fatalf("a succeeding Inspect told %v", err)
		}
	}
	close(stop)
	wg.Wait()
}

func TestNoContainerIsNoError(t *testing.T) {
	d := newScriptDocker(t)
	d.setMode("ok")
	m := &Manager{Bin: d.bin}
	if err := m.KillRun(context.Background(), "a_x", ""); err != nil {
		t.Errorf("KillRun of no run = %v", err)
	}
	if _, _, err := m.Ensure(context.Background(), Spec{Alias: "a_x", Image: "img"}); err == nil {
		t.Errorf("Ensure of a spec with no folder succeeded")
	}
}
