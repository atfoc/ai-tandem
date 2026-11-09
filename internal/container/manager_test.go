package container

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/container/containertest"
)

// The Manager through the stand-in docker (internal/container/fakedocker).

func newManager(t *testing.T) (*containertest.Fake, *Manager) {
	t.Helper()
	f := containertest.New(t)
	return f, &Manager{Bin: f.Bin} // QuickTimeout: a loaded machine must not turn a call into "not running"
}

// newSpec is a spec of alias with the default image, its own folder and n mounted folders, all
// real folders of the host.
func newSpec(t *testing.T, alias string, n int) Spec {
	t.Helper()
	s := Spec{Alias: alias, Image: DefaultImage(), Dir: t.TempDir()}
	for range n {
		s.Mounts = append(s.Mounts, t.TempDir())
	}
	return s
}

// counts is how many calls of each docker command the stand-in had.
func counts(f *containertest.Fake) map[string]int {
	c := map[string]int{}
	for _, call := range f.Calls() {
		if len(call) > 0 {
			c[call[0]]++
		}
	}
	return c
}

// since is the calls of each command made after before.
func since(f *containertest.Fake, before map[string]int) map[string]int {
	d := map[string]int{}
	for k, v := range counts(f) {
		if v-before[k] != 0 {
			d[k] = v - before[k]
		}
	}
	return d
}

// standIn creates, straight through the stand-in, the container spec would be created as but
// from the image "busybox" (so that the default image need not be there), and starts it when
// running.
func standIn(t *testing.T, f *containertest.Fake, spec Spec, running bool) {
	t.Helper()
	args := CreateArgs(spec)
	args[len(args)-3] = "busybox"
	if out, err := exec.Command(f.Bin, args...).CombinedOutput(); err != nil {
		t.Fatalf("stand-in create: %v %s", err, out)
	}
	if running {
		if out, err := exec.Command(f.Bin, "start", Name(spec.Alias)).CombinedOutput(); err != nil {
			t.Fatalf("stand-in start: %v %s", err, out)
		}
	}
}

func mustEnsure(t *testing.T, m *Manager, spec Spec) (Info, bool) {
	t.Helper()
	info, created, err := m.Ensure(context.Background(), spec)
	if err != nil {
		t.Fatalf("Ensure(%s): %v", spec.Alias, err)
	}
	return info, created
}

func TestEnsureCreatesStartsAndRecreates(t *testing.T) {
	t.Parallel()
	f, m := newManager(t)
	f.AddImage(DefaultImage())
	ctx := context.Background()
	spec := newSpec(t, "a1", 2)

	// None: one create, one start.
	before := counts(f)
	info, created := mustEnsure(t, m, spec)
	if d := since(f, before); d["create"] != 1 || d["start"] != 1 || d["rm"] != 0 {
		t.Fatalf("first Ensure calls = %v", d)
	}
	if !created || info.State != StateRunning || info.Alias != "a1" || info.Spec != spec.Hash() || info.Name != Name("a1") ||
		!slices.Equal(info.Mounts, append([]string{spec.Dir}, spec.Mounts...)) {
		t.Fatalf("first Ensure = %+v created=%v", info, created)
	}
	c, ok := f.Container(Name("a1"))
	if !ok || !slices.Equal(c.Args, CreateArgs(spec)[1:]) || c.State != "running" {
		t.Fatalf("container = %+v; want args %q", c, CreateArgs(spec)[1:])
	}
	firstID := c.ID

	// Stopped behind our back, same spec: start only.
	f.SetState(Name("a1"), "exited")
	before = counts(f)
	info, created = mustEnsure(t, m, spec)
	if d := since(f, before); d["create"] != 0 || d["rm"] != 0 || d["start"] != 1 {
		t.Fatalf("Ensure of an exited container calls = %v", d)
	}
	if created || info.State != StateRunning {
		t.Fatalf("Ensure of an exited container = %+v created=%v", info, created)
	}

	// Stopped by m.Stop, same spec: start only.
	if err := m.Stop(ctx, "a1"); err != nil {
		t.Fatal(err)
	}
	before = counts(f)
	info, created = mustEnsure(t, m, spec)
	if d := since(f, before); d["create"] != 0 || d["rm"] != 0 || d["start"] != 1 {
		t.Fatalf("Ensure after Stop calls = %v", d)
	}
	if c, _ := f.Container(Name("a1")); created || info.State != StateRunning || c.ID != firstID {
		t.Fatalf("Ensure after Stop = %+v created=%v id %s→%s", info, created, firstID, c.ID)
	}

	// Running, other spec: used as it is.
	other := spec
	other.Mounts = []string{spec.Mounts[0]}
	before = counts(f)
	info, created = mustEnsure(t, m, other)
	if d := since(f, before); d["create"] != 0 || d["rm"] != 0 || d["start"] != 0 {
		t.Fatalf("Ensure of a running container with another spec calls = %v", d)
	}
	if c, _ := f.Container(Name("a1")); created || info.State != StateRunning || info.Spec != spec.Hash() || c.Labels[LabelSpec] != spec.Hash() {
		t.Fatalf("Ensure of a running container with another spec = %+v created=%v labels %v", info, created, c.Labels)
	}

	// Stopped, other spec: rm + create + start.
	if err := m.Stop(ctx, "a1"); err != nil {
		t.Fatal(err)
	}
	before = counts(f)
	info, created = mustEnsure(t, m, other)
	if d := since(f, before); d["create"] != 1 || d["rm"] != 1 || d["start"] != 1 {
		t.Fatalf("Ensure of a stopped container with another spec calls = %v", d)
	}
	c, _ = f.Container(Name("a1"))
	if !created || info.State != StateRunning || info.Spec != other.Hash() || c.Labels[LabelSpec] != other.Hash() ||
		c.Labels[LabelAlias] != "a1" || c.ID == firstID || !slices.Equal(c.Args, CreateArgs(other)[1:]) ||
		!slices.Equal(info.Mounts, []string{spec.Dir, spec.Mounts[0]}) {
		t.Fatalf("recreated = %+v created=%v container %+v", info, created, c)
	}
	if n := len(f.Containers()); n != 1 {
		t.Fatalf("%d containers, want 1", n)
	}
}

func TestEnsureBuildsDefaultImageOnlyToCreate(t *testing.T) {
	t.Parallel()

	t.Run("missing", func(t *testing.T) {
		t.Parallel()
		f, m := newManager(t)
		spec := newSpec(t, "b1", 0)
		_, created := mustEnsure(t, m, spec)
		builds := f.Builds()
		if !created || len(builds) != 1 || builds[0].Image != DefaultImage() || builds[0].Dockerfile != string(Dockerfile()) {
			t.Fatalf("created=%v builds=%+v", created, builds)
		}
		bi, ci := -1, -1
		for i, c := range f.Calls() {
			switch c[0] {
			case "build":
				bi = i
			case "create":
				ci = i
			}
		}
		if bi < 0 || ci < bi {
			t.Fatalf("build at %d, create at %d: %q", bi, ci, f.Calls())
		}
		// A second Ensure of the running container builds nothing more.
		mustEnsure(t, m, spec)
		if n := len(f.CallsOf("build")); n != 1 {
			t.Fatalf("%d builds after a second Ensure", n)
		}
	})

	t.Run("running", func(t *testing.T) {
		t.Parallel()
		f, m := newManager(t)
		spec := newSpec(t, "b2", 0)
		standIn(t, f, spec, true)
		info, created := mustEnsure(t, m, spec)
		if created || info.State != StateRunning {
			t.Fatalf("Ensure = %+v created=%v", info, created)
		}
		if n := len(f.CallsOf("build")); n != 0 {
			t.Fatalf("Ensure of a running container built the image (%d builds); calls %q", n, f.Calls())
		}
	})

	t.Run("stopped same spec", func(t *testing.T) {
		t.Parallel()
		f, m := newManager(t)
		spec := newSpec(t, "b3", 0)
		standIn(t, f, spec, false)
		info, created := mustEnsure(t, m, spec)
		if created || info.State != StateRunning {
			t.Fatalf("Ensure = %+v created=%v", info, created)
		}
		if n := len(f.CallsOf("build")); n != 0 {
			t.Fatalf("Ensure that only starts built the image (%d builds); calls %q", n, f.Calls())
		}
		if n := len(f.CallsOf("create")); n != 1 { // the stand-in's own
			t.Fatalf("%d creates", n)
		}
	})

	t.Run("custom image", func(t *testing.T) {
		t.Parallel()
		f, m := newManager(t)
		spec := newSpec(t, "b4", 0)
		spec.Image = "example/img:1"
		info, created := mustEnsure(t, m, spec)
		if !created || info.State != StateRunning || info.Image != "example/img:1" {
			t.Fatalf("Ensure = %+v created=%v", info, created)
		}
		// The image is looked at and pulled before the create.
		if b, im, p := len(f.CallsOf("build")), len(f.CallsOf("image")), f.Pulls(); b != 0 || im != 1 || !slices.Equal(p, []string{"example/img:1"}) {
			t.Fatalf("custom image: %d builds, %d image inspects, pulls %q", b, im, p)
		}
		pi, ci := -1, -1
		for i, c := range f.Calls() {
			switch c[0] {
			case "pull":
				pi = i
			case "create":
				ci = i
			}
		}
		if pi < 0 || ci < pi {
			t.Fatalf("pull at %d, create at %d: %q", pi, ci, f.Calls())
		}
	})

	t.Run("running custom image", func(t *testing.T) {
		t.Parallel()
		f, m := newManager(t)
		spec := newSpec(t, "b5", 0)
		spec.Image = "example/img:1"
		standIn(t, f, spec, true)
		before := counts(f)
		if info, created := mustEnsure(t, m, spec); created || info.State != StateRunning {
			t.Fatalf("Ensure = %+v created=%v", info, created)
		}
		if d := since(f, before); d["image"] != 0 || d["pull"] != 0 || d["build"] != 0 {
			t.Fatalf("Ensure of a running container calls = %v", d)
		}
		f.SetState(Name("b5"), "exited")
		before = counts(f)
		mustEnsure(t, m, spec)
		if d := since(f, before); d["image"] != 0 || d["pull"] != 0 || d["build"] != 0 || d["start"] != 1 {
			t.Fatalf("Ensure of a stopped same-spec container calls = %v", d)
		}
	})
}

func TestEnsureImagePullsCustomImage(t *testing.T) {
	t.Parallel()
	f, m := newManager(t)
	f.SetPullDelay(500 * time.Millisecond)
	img := "example/img:1"

	var wg sync.WaitGroup
	errs := make([]error, 5)
	for i := range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = m.EnsureImage(context.Background(), img)
		}()
	}
	deadline := time.Now().Add(3 * time.Second)
	for !m.Building(img) {
		if time.Now().After(deadline) {
			t.Fatal("Building never became true during the pull")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// A caller that gives up gets its ctx's error; the pull runs on for the others.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := m.EnsureImage(ctx, img); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("early caller: %v", err)
	}
	if !m.Building(img) {
		t.Fatal("the pull stopped when one caller gave up")
	}

	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("caller %d: %v", i, err)
		}
	}
	if m.Building(img) {
		t.Error("Building still true after the pull")
	}
	if p, n := f.Pulls(), len(f.CallsOf("pull")); !slices.Equal(p, []string{img}) || n != 1 {
		t.Fatalf("pulls = %q, %d pull calls", p, n)
	}
	if n := len(f.CallsOf("image")); n != 1 {
		t.Fatalf("%d image inspects, want 1 shared look", n)
	}
	if len(f.Builds()) != 0 {
		t.Fatalf("builds = %+v", f.Builds())
	}

	// There now: one quick look, no pull.
	before := counts(f)
	if err := m.EnsureImage(context.Background(), img); err != nil {
		t.Fatal(err)
	}
	if d := since(f, before); d["image"] != 1 || d["pull"] != 0 {
		t.Fatalf("EnsureImage of a present image calls = %v", d)
	}
}

func TestEnsureImagePullFails(t *testing.T) {
	t.Parallel()
	f, m := newManager(t)
	img := "example/missing:1"
	f.FailOn("pull", "Error response from daemon: manifest for example/missing:1 not found: manifest unknown")
	err := m.EnsureImage(context.Background(), img)
	var de *Error
	if !errors.As(err, &de) || de.Op != "pull" || !strings.HasPrefix(de.Line, "Pulling the image "+img+" failed:\n") ||
		!strings.Contains(de.Line, "manifest unknown") {
		t.Fatalf("failed pull: %T %v", err, err)
	}
	if _, ok := IsUnavailable(err); ok {
		t.Fatalf("a failed pull is an *Unavailable: %v", err)
	}
	if m.Building(img) {
		t.Error("Building true after a failed pull")
	}

	// Ensure returns it and creates nothing; Recreate returns it and leaves the old container.
	spec := newSpec(t, "p1", 0)
	spec.Image = img
	if _, created, err := m.Ensure(context.Background(), spec); !errors.As(err, &de) || de.Op != "pull" || created {
		t.Fatalf("Ensure: created=%v %v", created, err)
	}
	if n := len(f.CallsOf("create")); n != 0 {
		t.Fatalf("%d creates after a failed pull", n)
	}
	standIn(t, f, spec, true)
	if _, err := m.Recreate(context.Background(), spec); !errors.As(err, &de) || de.Op != "pull" {
		t.Fatalf("Recreate: %v", err)
	}
	if c, ok := f.Container(Name("p1")); !ok || c.State != "running" || len(f.CallsOf("rm")) != 0 {
		t.Fatalf("the container after a Recreate whose pull failed: %+v %v", c, ok)
	}

	// The next call tries again.
	f.FailOn("pull", "")
	if err := m.EnsureImage(context.Background(), img); err != nil {
		t.Fatalf("second EnsureImage: %v", err)
	}
	if n := len(f.CallsOf("pull")); n != 4 {
		t.Fatalf("%d pull calls, want 4", n)
	}
}

func TestEnsureImageDefaultIsNeverPulled(t *testing.T) {
	t.Parallel()
	f, m := newManager(t)
	if err := m.EnsureImage(context.Background(), DefaultImage()); err != nil {
		t.Fatal(err)
	}
	if n, b := len(f.CallsOf("pull")), len(f.Builds()); n != 0 || b != 1 {
		t.Fatalf("%d pulls, %d builds", n, b)
	}
}

func TestEnsureConcurrent(t *testing.T) {
	t.Parallel()

	t.Run("one account", func(t *testing.T) {
		t.Parallel()
		f, m := newManager(t)
		f.AddImage(DefaultImage())
		spec := newSpec(t, "c1", 1)
		var wg sync.WaitGroup
		errs := make([]error, 10)
		infos := make([]Info, 10)
		for i := range 10 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				infos[i], _, errs[i] = m.Ensure(context.Background(), spec)
			}()
		}
		wg.Wait()
		for i := range 10 {
			if errs[i] != nil || infos[i].State != StateRunning {
				t.Errorf("caller %d: %+v %v", i, infos[i], errs[i])
			}
		}
		if n := len(f.CallsOf("create")); n != 1 {
			t.Fatalf("%d creates, want 1", n)
		}
	})

	t.Run("three accounts", func(t *testing.T) {
		t.Parallel()
		f, m := newManager(t)
		f.AddImage(DefaultImage())
		specs := []Spec{newSpec(t, "c1", 0), newSpec(t, "c2", 0), newSpec(t, "c3", 0)}
		var wg sync.WaitGroup
		errs := make([]error, len(specs))
		for i, s := range specs {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, _, errs[i] = m.Ensure(context.Background(), s)
			}()
		}
		wg.Wait()
		for i, err := range errs {
			if err != nil {
				t.Errorf("Ensure %s: %v", specs[i].Alias, err)
			}
		}
		if n := len(f.CallsOf("create")); n != 3 {
			t.Fatalf("%d creates, want 3", n)
		}
		for _, c := range f.Containers() {
			if c.State != "running" {
				t.Errorf("%s is %s", c.Name, c.State)
			}
		}
	})
}

func TestEnsureImageSingleflight(t *testing.T) {
	t.Parallel()
	f, m := newManager(t)
	f.SetBuildDelay(500 * time.Millisecond)
	img := DefaultImage()

	var wg sync.WaitGroup
	errs := make([]error, 5)
	for i := range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = m.EnsureImage(context.Background(), img)
		}()
	}
	deadline := time.Now().Add(3 * time.Second)
	for !m.Building(img) {
		if time.Now().After(deadline) {
			t.Fatal("Building never became true")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// A caller that gives up gets its ctx's error; the build runs on for the others.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := m.EnsureImage(ctx, img); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("early caller: %v", err)
	}
	if !m.Building(img) {
		t.Fatal("the build stopped when one caller gave up")
	}

	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("caller %d: %v", i, err)
		}
	}
	if m.Building(img) {
		t.Error("Building still true after the build")
	}
	if b := f.Builds(); len(b) != 1 || b[0].Image != img {
		t.Fatalf("builds = %+v", b)
	}
	if !slices.Contains(f.Images(), img) {
		t.Fatalf("images = %v", f.Images())
	}
}

func TestEnsureImageFailedBuildRetries(t *testing.T) {
	t.Parallel()
	f, m := newManager(t)
	img := DefaultImage()
	f.FailOn("build", "boom")
	err := m.EnsureImage(context.Background(), img)
	var de *Error
	if !errors.As(err, &de) || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("failed build: %T %v", err, err)
	}
	if m.Building(img) {
		t.Error("Building true after a failed build")
	}
	f.FailOn("build", "")
	if err := m.EnsureImage(context.Background(), img); err != nil {
		t.Fatalf("second EnsureImage: %v", err)
	}
	if n := len(f.CallsOf("build")); n != 2 {
		t.Fatalf("%d build calls, want 2", n)
	}
	if b := f.Builds(); len(b) != 1 {
		t.Fatalf("builds = %+v", b)
	}
}

func TestRecreateStopRemove(t *testing.T) {
	t.Parallel()
	f, m := newManager(t)
	f.AddImage(DefaultImage())
	ctx := context.Background()
	spec := newSpec(t, "r1", 1)
	bystander := newSpec(t, "r2", 0)
	mustEnsure(t, m, spec)
	mustEnsure(t, m, bystander)
	bc, _ := f.Container(Name("r2"))
	checkBystander := func(what string) {
		t.Helper()
		c, ok := f.Container(Name("r2"))
		if !ok || c.ID != bc.ID || c.State != "running" || c.Labels[LabelSpec] != bc.Labels[LabelSpec] {
			t.Fatalf("%s changed the other account's container: %+v (was %+v)", what, c, bc)
		}
	}

	keep := filepath.Join(spec.Dir, "keep.txt")
	if err := os.WriteFile(keep, []byte("kept"), 0o644); err != nil {
		t.Fatal(err)
	}
	old, _ := f.Container(Name("r1"))
	changed := spec
	changed.Mounts = append(changed.Mounts, t.TempDir())
	before := counts(f)
	info, err := m.Recreate(ctx, changed)
	if err != nil {
		t.Fatal(err)
	}
	if d := since(f, before); d["rm"] != 1 || d["create"] != 1 || d["start"] != 1 {
		t.Fatalf("Recreate calls = %v", d)
	}
	c, _ := f.Container(Name("r1"))
	if info.State != StateRunning || info.Spec != changed.Hash() || c.Labels[LabelSpec] != changed.Hash() || c.ID == old.ID {
		t.Fatalf("Recreate = %+v container %+v", info, c)
	}
	if b, err := os.ReadFile(keep); err != nil || string(b) != "kept" {
		t.Fatalf("the file in the account's folder: %q %v", b, err)
	}
	checkBystander("Recreate")

	// Recreate with no container: create + start.
	fresh := newSpec(t, "r3", 0)
	before = counts(f)
	info, err = m.Recreate(ctx, fresh)
	if err != nil || info.State != StateRunning || info.Spec != fresh.Hash() {
		t.Fatalf("Recreate of none = %+v %v", info, err)
	}
	if d := since(f, before); d["create"] != 1 || d["start"] != 1 {
		t.Fatalf("Recreate of none calls = %v", d)
	}
	checkBystander("Recreate of none")

	// Stop: running → exited; again and missing are no error.
	if err := m.Stop(ctx, "r1"); err != nil {
		t.Fatal(err)
	}
	if c, _ := f.Container(Name("r1")); c.State != "exited" {
		t.Fatalf("after Stop: %s", c.State)
	}
	if i, err := m.Inspect(ctx, "r1"); err != nil || i.State != StateStopped {
		t.Fatalf("Inspect after Stop = %+v %v", i, err)
	}
	if err := m.Stop(ctx, "r1"); err != nil {
		t.Fatalf("Stop again: %v", err)
	}
	if err := m.Stop(ctx, "nobody"); err != nil {
		t.Fatalf("Stop of none: %v", err)
	}
	checkBystander("Stop")

	// Remove: running → gone; again is no error.
	if err := m.Remove(ctx, "r3"); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.Container(Name("r3")); ok {
		t.Fatal("r3 still there after Remove")
	}
	if i, err := m.Inspect(ctx, "r3"); err != nil || i.State != StateNone {
		t.Fatalf("Inspect after Remove = %+v %v", i, err)
	}
	if err := m.Remove(ctx, "r3"); err != nil {
		t.Fatalf("Remove again: %v", err)
	}
	checkBystander("Remove")
	if err := m.Available(); err != nil {
		t.Fatalf("Available = %v", err)
	}
}

func TestEnsureCreateRefused(t *testing.T) {
	t.Parallel()
	f, m := newManager(t)
	f.AddImage(DefaultImage())
	spec := newSpec(t, "e1", 0)
	f.FailOn("create", "Error response from daemon: Mounts denied: The path /x is not shared from the host")
	_, created, err := m.Ensure(context.Background(), spec)
	var de *Error
	if !errors.As(err, &de) || !strings.Contains(err.Error(), "/x") {
		t.Fatalf("Ensure: %T %v", err, err)
	}
	if _, ok := IsUnavailable(err); ok {
		t.Fatalf("a refused create is an *Unavailable: %v", err)
	}
	if created {
		t.Error("created=true after a refused create")
	}
	if err := m.Available(); err != nil {
		t.Errorf("Available after a refused create = %v", err)
	}
}

func TestEnsureStartFails(t *testing.T) {
	t.Parallel()
	f, m := newManager(t)
	f.AddImage(DefaultImage())
	spec := newSpec(t, "e2", 0)
	f.FailOn("start", "Error response from daemon: cannot start: boom")
	_, created, err := m.Ensure(context.Background(), spec)
	var de *Error
	if !errors.As(err, &de) || !strings.Contains(err.Error(), "boom") || !created {
		t.Fatalf("Ensure: created=%v %T %v", created, err, err)
	}
	if c, ok := f.Container(Name("e2")); !ok || c.State != "created" || c.Labels[LabelSpec] != spec.Hash() {
		t.Fatalf("container after the failed start = %+v", c)
	}
	f.FailOn("start", "")
	before := counts(f)
	info, created := mustEnsure(t, m, spec)
	if d := since(f, before); d["create"] != 0 || d["rm"] != 0 || d["start"] != 1 {
		t.Fatalf("second Ensure calls = %v", d)
	}
	if created || info.State != StateRunning {
		t.Fatalf("second Ensure = %+v created=%v", info, created)
	}
}

func TestExecThroughStandIn(t *testing.T) {
	t.Parallel()
	f, m := newManager(t)
	f.AddImage(DefaultImage())
	spec := newSpec(t, "x1", 1)
	mustEnsure(t, m, spec)
	mount := spec.Mounts[0]
	real, err := filepath.EvalSymlinks(mount)
	if err != nil {
		t.Fatal(err)
	}

	for _, tty := range []bool{false, true} {
		id := NewRunID()
		cmd := m.Exec("x1", ExecOptions{Dir: mount, Env: []string{"FOO=bar"}, RunID: id, TTY: tty,
			Argv: []string{"sh", "-c", "pwd; echo $FOO $AIWB_RUN; cat"}})
		cmd.Stdin = strings.NewReader("hi")
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("tty=%v: %v %s", tty, err, out)
		}
		lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
		if len(lines) != 3 || (lines[0] != mount && lines[0] != real) || lines[1] != "bar "+id || lines[2] != "hi" {
			t.Fatalf("tty=%v: output %q", tty, out)
		}
		var found bool
		for _, r := range f.Runs() {
			if r.ID == id {
				found = true
				if r.TTY != tty || r.Container != Name("x1") || r.Live {
					t.Fatalf("tty=%v: run %+v", tty, r)
				}
			}
		}
		if !found {
			t.Fatalf("tty=%v: run %s not recorded: %+v", tty, id, f.Runs())
		}
	}

	// A working folder outside the mounts.
	cmd := m.Exec("x1", ExecOptions{Dir: t.TempDir(), RunID: NewRunID(), Argv: []string{"true"}})
	err = cmd.Run()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 126 {
		t.Fatalf("Exec outside the mounts: %v", err)
	}
}

func TestKillRun(t *testing.T) {
	t.Parallel()
	f, m := newManager(t)
	f.AddImage(DefaultImage())
	ctx := context.Background()
	spec := newSpec(t, "k1", 0)
	mustEnsure(t, m, spec)

	id := NewRunID()
	cmd := m.Exec("k1", ExecOptions{Dir: spec.Dir, RunID: id, Argv: []string{"sh", "-c", "sleep 30 & exec sleep 31"}})
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()
	t.Cleanup(func() { cmd.Process.Kill() })

	deadline := time.Now().Add(3 * time.Second)
	for {
		live := false
		for _, r := range f.Runs() {
			if r.ID == id && r.Live {
				live = true
			}
		}
		if live {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the run never showed up live: %+v", f.Runs())
		}
		time.Sleep(10 * time.Millisecond)
	}

	start := time.Now()
	if err := m.KillRun(ctx, "k1", id); err != nil {
		t.Fatalf("KillRun: %v", err)
	}
	if d := time.Since(start); d > time.Second {
		t.Errorf("KillRun took %v", d)
	}
	select {
	case err := <-waited:
		if err == nil {
			t.Fatal("the killed run exited 0")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the killed run's docker exec did not end")
	}
	if k := f.Kills(); !slices.Equal(k, []string{id}) {
		t.Fatalf("Kills = %q", k)
	}
	for _, r := range f.Runs() {
		if r.ID == id && r.Live {
			t.Fatalf("run still live: %+v", r)
		}
	}

	if err := m.KillRun(ctx, "k1", id); err != nil {
		t.Fatalf("KillRun of an ended run: %v", err)
	}
	if err := m.KillRun(ctx, "nobody", NewRunID()); err != nil {
		t.Fatalf("KillRun in a missing container: %v", err)
	}
	before := len(f.CallsOf("exec"))
	if err := m.KillRun(ctx, "k1", ""); err != nil {
		t.Fatalf("KillRun of no run: %v", err)
	}
	if n := len(f.CallsOf("exec")); n != before {
		t.Fatalf("KillRun of no run called docker exec (%d → %d)", before, n)
	}
}

func TestExecFakeClaude(t *testing.T) {
	t.Parallel()
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH")
	}
	f, m := newManager(t)
	f.AddImage(DefaultImage())
	spec := newSpec(t, "fc1", 1)
	mustEnsure(t, m, spec)
	claude := agenttest.FakeClaude(t)

	cmd := m.Exec("fc1", ExecOptions{Dir: spec.Mounts[0], RunID: NewRunID(),
		Argv: []string{claude, "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"}})
	cmd.WaitDelay = 2 * time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill() })
	msg := `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello there"}]}}` + "\n"
	if _, err := stdin.Write([]byte(msg)); err != nil {
		t.Fatal(err)
	}

	lines := make(chan string)
	go func() {
		defer close(lines)
		sc := bufio.NewScanner(stdout)
		sc.Buffer(nil, 1<<20)
		for sc.Scan() {
			lines <- sc.Text()
		}
	}()
	timeout := time.After(10 * time.Second)
	var result string
	for result == "" {
		select {
		case l, ok := <-lines:
			if !ok {
				t.Fatal("stdout closed before a result line")
			}
			var j struct{ Type, Result string }
			if err := json.Unmarshal([]byte(l), &j); err != nil {
				t.Fatalf("not a JSON line: %q", l)
			}
			if j.Type == "result" {
				result = j.Result
			}
		case <-timeout:
			t.Fatal("no result line in 10 s")
		}
	}
	if !strings.Contains(result, "hello there") {
		t.Fatalf("result = %q", result)
	}
	stdin.Close()
	for range lines {
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("fake claude after stdin closed: %v", err)
	}
}

func TestAvailabilityThroughStandIn(t *testing.T) {
	t.Parallel()
	f := containertest.New(t)
	// Only the slow case uses a short limit: under the load of `go test ./...` a stand-in call
	// may take longer than 300ms, which would read as "not running" in the other cases.
	m := &Manager{Bin: f.Bin}
	quick := &Manager{Bin: f.Bin, Timeout: 300 * time.Millisecond}
	ctx := context.Background()

	kind := func(err error) string {
		if u, ok := IsUnavailable(err); ok {
			return u.Kind
		}
		if err != nil {
			return "error: " + err.Error()
		}
		return ""
	}

	f.SetMode(containertest.ModeDown)
	if err := m.Refresh(ctx); kind(err) != NotRunning {
		t.Fatalf("down: %v", err)
	}
	f.SetMode(containertest.ModeMissing)
	if err := m.Refresh(ctx); kind(err) != NotInstalled || err.Error() != "Docker is not installed" {
		t.Fatalf("missing: %v", err)
	}
	f.SetMode(containertest.ModeSlow)
	f.SetSlow(3 * time.Second)
	start := time.Now()
	if err := quick.Refresh(ctx); kind(err) != NotRunning {
		t.Fatalf("slow: %v", err)
	}
	if d := time.Since(start); d >= 1500*time.Millisecond {
		t.Fatalf("slow Refresh took %v", d)
	}
	f.SetMode(containertest.ModeFail)
	if err := m.Refresh(ctx); kind(err) != Failed || err.Error() != "Error response from daemon: stand-in docker failure" {
		t.Fatalf("fail: %v", err)
	}
	f.SetMode(containertest.ModeOK)
	if err := m.Refresh(ctx); err != nil {
		t.Fatalf("ok: %v", err)
	}
	if err := m.Available(); err != nil {
		t.Fatalf("Available: %v", err)
	}
}

func TestWatchThroughStandIn(t *testing.T) {
	t.Parallel()
	f := containertest.New(t)
	m := &Manager{Bin: f.Bin}
	f.SetMode(containertest.ModeDown)

	changes := make(chan error, 100)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		m.Watch(50*time.Millisecond, stop, func(err error) { changes <- err })
	}()
	defer func() {
		close(stop)
		<-done
	}()

	var seen []string
	label := func(err error) string {
		if u, ok := IsUnavailable(err); ok {
			return u.Kind
		}
		if err != nil {
			return "error: " + err.Error()
		}
		return "ok"
	}
	await := func(want string) {
		t.Helper()
		timeout := time.After(3 * time.Second)
		for {
			select {
			case err := <-changes:
				l := label(err)
				if len(seen) == 0 || seen[len(seen)-1] != l {
					seen = append(seen, l)
				}
				if l == want {
					return
				}
			case <-timeout:
				t.Fatalf("waiting for %s; changes so far %q", want, seen)
			}
		}
	}
	await(NotRunning)
	f.SetMode(containertest.ModeOK)
	await("ok")
	f.SetMode(containertest.ModeMissing)
	await(NotInstalled)
	f.SetMode(containertest.ModeOK)
	await("ok")
	if want := []string{NotRunning, "ok", NotInstalled, "ok"}; !slices.Equal(seen, want) {
		t.Fatalf("changes = %q, want %q", seen, want)
	}
}

func TestEnsureWhileDown(t *testing.T) {
	t.Parallel()
	f, m := newManager(t)
	f.AddImage(DefaultImage())
	f.SetMode(containertest.ModeDown)
	_, created, err := m.Ensure(context.Background(), newSpec(t, "d1", 0))
	u, ok := IsUnavailable(err)
	if !ok || u.Kind != NotRunning || created {
		t.Fatalf("Ensure while down: created=%v %T %v", created, err, err)
	}
	a, ok := IsUnavailable(m.Available())
	if !ok || a.Kind != u.Kind || a.Reason != u.Reason {
		t.Fatalf("Available = %v, want %v", m.Available(), u)
	}
	if n := len(f.CallsOf("create")); n != 0 {
		t.Fatalf("%d creates while down", n)
	}
}

func TestList(t *testing.T) {
	t.Parallel()

	t.Run("empty", func(t *testing.T) {
		t.Parallel()
		f, m := newManager(t)
		got, err := m.List(context.Background())
		if err != nil || got == nil || len(got) != 0 {
			t.Fatalf("List = %#v %v", got, err)
		}
		if n := len(f.CallsOf("inspect")); n != 0 {
			t.Fatalf("%d inspect calls with no container", n)
		}
	})

	t.Run("two and a stranger", func(t *testing.T) {
		t.Parallel()
		f, m := newManager(t)
		f.AddImage(DefaultImage())
		mustEnsure(t, m, newSpec(t, "l1", 0))
		mustEnsure(t, m, newSpec(t, "l2", 1))
		if err := m.Stop(context.Background(), "l2"); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command(f.Bin, "create", "--name", "other", "busybox", "true").CombinedOutput(); err != nil {
			t.Fatalf("create other: %v %s", err, out)
		}
		got, err := m.List(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		byAlias := map[string]Info{}
		for _, i := range got {
			byAlias[i.Alias] = i
		}
		if len(got) != 2 || byAlias["l1"].Name != Name("l1") || byAlias["l2"].Name != Name("l2") ||
			byAlias["l1"].State != StateRunning || byAlias["l2"].State != StateStopped {
			t.Fatalf("List = %+v", got)
		}
	})
}
