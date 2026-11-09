package container

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/testset"
)

func TestManagerRealDocker(t *testing.T) {
	testset.SkipUnlessFull(t, "real Docker; the stand-in docker tests of Ensure/Recreate/KillRun in this package cover the same")
	if runtime.GOOS == "windows" {
		t.Skip("accounts are unsupported on Windows")
	}
	if out, err := exec.Command("docker", "version", "--format", "{{.Server.Version}}").CombinedOutput(); err != nil {
		t.Skipf("docker version failed: %v: %s", err, out)
	}
	ctx := context.Background()
	m := &Manager{Bin: "docker"}
	image := DefaultImage()

	hadImage := exec.Command("docker", "image", "inspect", image).Run() == nil
	if !hadImage && os.Getenv("AIWB_TEST_KEEP_IMAGE") != "1" {
		t.Cleanup(func() {
			if out, err := exec.Command("docker", "rmi", image).CombinedOutput(); err != nil {
				t.Logf("docker rmi %s: %v: %s", image, err, out)
			}
		})
	}
	start := time.Now()
	if err := m.EnsureImage(ctx, image); err != nil {
		t.Fatalf("EnsureImage: %v", err)
	}
	t.Logf("EnsureImage(%s) took %v (the image was there before: %v)", image, time.Since(start).Round(time.Second), hadImage)
	if out, err := exec.Command("docker", "image", "inspect", "--format", "{{.Size}}", image).Output(); err == nil {
		t.Logf("image size: %s bytes", strings.TrimSpace(string(out)))
	}

	alias := "a_t" + randomBase36(6)
	name := Name(alias)
	t.Cleanup(func() { exec.Command("docker", "rm", "-f", name).Run() })
	root := t.TempDir()
	dir := filepath.Join(root, "aliases", alias)
	mount := t.TempDir()
	for _, d := range []string{dir, filepath.Join(dir, "home")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	spec := Spec{Alias: alias, Image: image, Dir: dir, Mounts: []string{mount}, User: fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid())}

	info, created, err := m.Ensure(ctx, spec)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if !created || info.State != StateRunning || info.Spec != spec.Hash() || info.Alias != alias || info.Image != image {
		t.Fatalf("Ensure = %+v, created %v", info, created)
	}
	if !sameHostPaths(info.Mounts, []string{dir, mount}) {
		t.Errorf("the container's mounts are %q, want exactly %q and %q", info.Mounts, dir, mount)
	}
	if out, err := exec.Command("docker", "inspect", "--format", "{{range .Mounts}}{{.Source}}\n{{end}}", name).Output(); err != nil {
		t.Errorf("docker inspect: %v", err)
	} else if got := strings.Fields(string(out)); !sameHostPaths(got, []string{dir, mount}) {
		t.Errorf("docker inspect mounts = %q", got)
	}
	// CreateArgs' "--" before the image: Docker took the image and the command as given.
	if out, err := exec.Command("docker", "inspect", "--format", "{{.Config.Image}}|{{json .Config.Cmd}}", name).Output(); err != nil {
		t.Errorf("docker inspect: %v", err)
	} else if got := strings.TrimSpace(string(out)); got != image+`|["sleep","infinity"]` {
		t.Errorf("docker inspect image|cmd = %s", got)
	}
	if again, created, err := m.Ensure(ctx, spec); err != nil || created || again.State != StateRunning {
		t.Errorf("Ensure of the running container = %+v, %v, %v", again, created, err)
	}

	env := []string{"HOME=" + filepath.Join(dir, "home")}
	out, err := m.Exec(alias, ExecOptions{Dir: dir, Env: env, RunID: NewRunID(), Argv: []string{"claude", "--version"}}).CombinedOutput()
	if err != nil {
		t.Fatalf("claude --version: %v: %s", err, out)
	}
	t.Logf("claude --version: %s", strings.TrimSpace(string(out)))

	// A run with a child that detaches into a session of its own: KillRun ends both.
	runID := NewRunID()
	run := m.Exec(alias, ExecOptions{Dir: mount, Env: env, RunID: runID, Argv: []string{"sh", "-c", "setsid sleep 1001 & exec sleep 1002"}})
	if err := run.Start(); err != nil {
		t.Fatal(err)
	}
	ended := make(chan error, 1)
	go func() { ended <- run.Wait() }()
	sleeps := func() []string {
		out, err := exec.Command("docker", "exec", name, "ps", "-eo", "args").Output()
		if err != nil {
			t.Fatalf("ps: %v", err)
		}
		var s []string
		for _, l := range strings.Split(string(out), "\n") {
			if strings.Contains(l, "sleep 100") {
				s = append(s, strings.TrimSpace(l))
			}
		}
		return s
	}
	deadline := time.Now().Add(10 * time.Second)
	for len(sleeps()) < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("the run's sleeps did not start: %q", sleeps())
		}
		time.Sleep(100 * time.Millisecond)
	}
	start = time.Now()
	if err := m.KillRun(ctx, alias, runID); err != nil {
		t.Fatalf("KillRun: %v", err)
	}
	t.Logf("KillRun took %v", time.Since(start).Round(time.Millisecond))
	select {
	case err := <-ended:
		t.Logf("the exec ended: %v", err)
	case <-time.After(10 * time.Second):
		run.Process.Kill()
		t.Fatal("the exec did not end after KillRun")
	}
	if s := sleeps(); len(s) > 0 {
		t.Errorf("after KillRun these still run: %q", s)
	}
	if err := m.KillRun(ctx, alias, runID); err != nil {
		t.Errorf("KillRun of an ended run: %v", err)
	}

	// A file written in the account's folder, by the container's user, survives Recreate.
	file := filepath.Join(dir, "kept.txt")
	if out, err := m.Exec(alias, ExecOptions{Dir: dir, Env: env, RunID: NewRunID(), Argv: []string{"sh", "-c", "echo kept > " + file}}).CombinedOutput(); err != nil {
		t.Fatalf("write a file: %v: %s", err, out)
	}
	if b, err := os.ReadFile(file); err != nil || string(b) != "kept\n" {
		t.Fatalf("the file on the host: %q, %v", b, err)
	}
	if info, err = m.Recreate(ctx, spec); err != nil || info.State != StateRunning {
		t.Fatalf("Recreate = %+v, %v", info, err)
	}
	if out, err := m.Exec(alias, ExecOptions{Dir: dir, Env: env, RunID: NewRunID(), Argv: []string{"cat", file}}).CombinedOutput(); err != nil || string(out) != "kept\n" {
		t.Errorf("the file after Recreate: %q, %v", out, err)
	}

	if err := m.Stop(ctx, alias); err != nil {
		t.Errorf("Stop: %v", err)
	}
	if info, err := m.Inspect(ctx, alias); err != nil || info.State != StateStopped {
		t.Errorf("Inspect after Stop = %+v, %v", info, err)
	}
	if err := m.Stop(ctx, alias); err != nil {
		t.Errorf("Stop of a stopped container: %v", err)
	}
	if err := m.Remove(ctx, alias); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if info, err := m.Inspect(ctx, alias); err != nil || info.State != StateNone {
		t.Errorf("Inspect after Remove = %+v, %v", info, err)
	}
	if err := m.Remove(ctx, alias); err != nil {
		t.Errorf("Remove of no container: %v", err)
	}
	if err := m.Available(); err != nil {
		t.Errorf("Available = %v", err)
	}
}

// sameHostPaths reports whether got and want are the same set of paths, a symlinked prefix
// (macOS's /var → /private/var) aside.
func sameHostPaths(got, want []string) bool {
	norm := func(ps []string) []string {
		out := make([]string, len(ps))
		for i, p := range ps {
			if r, err := filepath.EvalSymlinks(p); err == nil {
				p = r
			}
			out[i] = filepath.Clean(p)
		}
		slices.Sort(out)
		return out
	}
	return slices.Equal(norm(got), norm(want))
}

func randomBase36(n int) string {
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, n)
	for i := range b {
		k, err := rand.Int(rand.Reader, big.NewInt(int64(len(digits))))
		if err != nil {
			panic(err)
		}
		b[i] = digits[k.Int64()]
	}
	return string(b)
}
