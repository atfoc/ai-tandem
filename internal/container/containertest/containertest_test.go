package containertest_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/container/containertest"
)

type result struct {
	out, err string
	code     int
}

func run(t *testing.T, f *containertest.Fake, stdin string, args ...string) result {
	t.Helper()
	cmd := exec.Command(f.Bin, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	code := 0
	if err != nil {
		var ee *exec.ExitError
		if !errors.As(err, &ee) {
			t.Fatalf("docker %q: %v", args, err)
		}
		code = ee.ExitCode()
	}
	return result{out.String(), errb.String(), code}
}

func ok(t *testing.T, f *containertest.Fake, args ...string) string {
	t.Helper()
	r := run(t, f, "", args...)
	if r.code != 0 {
		t.Fatalf("docker %q: exit %d, stderr %q", args, r.code, r.err)
	}
	return r.out
}

func want(t *testing.T, r result, code int, stderr string) {
	t.Helper()
	if r.code != code || strings.TrimSpace(r.err) != stderr {
		t.Fatalf("got exit %d stderr %q; want exit %d stderr %q", r.code, r.err, code, stderr)
	}
}

var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// newContainer creates a running container named name with the folder dir mounted at the same path.
func newContainer(t *testing.T, f *containertest.Fake, name, dir string) string {
	t.Helper()
	f.AddImage("aiwb/claude:test")
	id := strings.TrimSpace(ok(t, f, "create", "--name", name, "--init", "--label", container.LabelAlias+"="+name,
		"-v", dir+":"+dir, "--", "aiwb/claude:test", "sleep", "infinity"))
	ok(t, f, "start", name)
	return id
}

func TestVersion(t *testing.T) {
	t.Parallel()
	f := containertest.New(t)
	if got := ok(t, f, "version", "--format", "{{.Server.Version}}"); got != "29.0.0-standin\n" {
		t.Fatalf("version = %q", got)
	}
	if calls := f.Calls(); len(calls) != 1 || !slices.Equal(calls[0], []string{"version", "--format", "{{.Server.Version}}"}) {
		t.Fatalf("calls = %q", calls)
	}
}

func TestUnknownCommand(t *testing.T) {
	t.Parallel()
	f := containertest.New(t)
	want(t, run(t, f, "", "pause", "x"), 1, "docker: unknown command: pause")
}

func TestContainerLifecycle(t *testing.T) {
	t.Parallel()
	f := containertest.New(t)
	f.AddImage("aiwb/claude:1.0")
	a, b := t.TempDir(), t.TempDir()
	id := strings.TrimSpace(ok(t, f, "create", "--name", "aiwb-alias-x", "--init",
		"--label", "aiwb.alias=x", "--label=aiwb.spec=abc", "-v", a+":"+a, "-v", b+":"+b,
		"--add-host", "host.docker.internal:host-gateway", "--user", "501:20", "--", "aiwb/claude:1.0", "sleep", "infinity"))
	if !hex64.MatchString(id) {
		t.Fatalf("id = %q", id)
	}
	c, found := f.Container("aiwb-alias-x")
	if !found || c.ID != id || c.State != "created" || !c.Init || c.User != "501:20" || c.Image != "aiwb/claude:1.0" ||
		!slices.Equal(c.Binds, []string{a + ":" + a, b + ":" + b}) || !slices.Equal(c.Cmd, []string{"sleep", "infinity"}) ||
		!slices.Equal(c.ExtraHosts, []string{"host.docker.internal:host-gateway"}) || c.Labels["aiwb.spec"] != "abc" || len(c.Args) != 18 || c.Args[0] != "--name" || c.Args[17] != "infinity" {
		t.Fatalf("container = %+v", c)
	}

	var got []map[string]any
	if err := json.Unmarshal([]byte(ok(t, f, "inspect", "--type", "container", "aiwb-alias-x")), &got); err != nil || len(got) != 1 {
		t.Fatalf("inspect: %v %v", got, err)
	}
	j := got[0]
	cfg, hc, st := j["Config"].(map[string]any), j["HostConfig"].(map[string]any), j["State"].(map[string]any)
	mounts := j["Mounts"].([]any)
	m0 := mounts[0].(map[string]any)
	if j["Id"] != id || j["Name"] != "/aiwb-alias-x" || st["Status"] != "created" || st["Running"] != false ||
		cfg["Image"] != "aiwb/claude:1.0" || cfg["User"] != "501:20" || cfg["Labels"].(map[string]any)["aiwb.alias"] != "x" ||
		hc["Init"] != true || len(hc["Binds"].([]any)) != 2 || hc["ExtraHosts"].([]any)[0] != "host.docker.internal:host-gateway" ||
		len(mounts) != 2 || m0["Type"] != "bind" || m0["Source"] != a || m0["Destination"] != a || m0["RW"] != true {
		t.Fatalf("inspect = %v", j)
	}
	if _, err := time.Parse(time.RFC3339Nano, j["Created"].(string)); err != nil {
		t.Fatalf("Created: %v", err)
	}

	// By id, and with a missing one.
	r := run(t, f, "", "inspect", "--type", "container", id, "nope")
	if err := json.Unmarshal([]byte(r.out), &got); err != nil || len(got) != 1 {
		t.Fatalf("inspect id: %q %v", r.out, err)
	}
	want(t, r, 1, "Error response from daemon: No such container: nope")
	r = run(t, f, "", "inspect", "--type", "container", "nope")
	if strings.TrimSpace(r.out) != "[]" || r.code != 1 {
		t.Fatalf("inspect missing: %+v", r)
	}

	ok(t, f, "start", "aiwb-alias-x")
	ok(t, f, "start", "aiwb-alias-x") // running already: fine
	if c, _ := f.Container("aiwb-alias-x"); c.State != "running" {
		t.Fatalf("state = %s", c.State)
	}
	ok(t, f, "stop", "-t", "3", "aiwb-alias-x")
	if c, _ := f.Container("aiwb-alias-x"); c.State != "exited" {
		t.Fatalf("state = %s", c.State)
	}
	ok(t, f, "rm", "-f", "aiwb-alias-x")
	if r := run(t, f, "", "rm", "-f", "aiwb-alias-x"); r.code != 0 || r.out != "" || r.err != "" {
		t.Fatalf("rm of a missing container: %+v", r)
	}
	if len(f.Containers()) != 0 {
		t.Fatalf("containers = %v", f.Containers())
	}
	want(t, run(t, f, "", "start", "aiwb-alias-x"), 1,
		"Error response from daemon: No such container: aiwb-alias-x\nfailed to start containers: aiwb-alias-x")
	want(t, run(t, f, "", "stop", "-t", "3", "aiwb-alias-x"), 1, "Error response from daemon: No such container: aiwb-alias-x")
	if n := len(f.CallsOf("rm")); n != 2 {
		t.Fatalf("rm calls = %d", n)
	}
}

func TestCreateRefusals(t *testing.T) {
	t.Parallel()
	f := containertest.New(t)
	d := t.TempDir()
	r := run(t, f, "", "create", "--name", "c", "aiwb/claude:9", "sleep", "infinity")
	want(t, r, 1, "Unable to find image 'aiwb/claude:9' locally\nError response from daemon: pull access denied for aiwb/claude, repository does not exist or may require 'docker login'")

	id := strings.TrimSpace(ok(t, f, "create", "--name=c", "alpine:3", "sleep", "infinity")) // pulled
	if !slices.Contains(f.Images(), "alpine:3") {
		t.Fatalf("images = %v", f.Images())
	}
	want(t, run(t, f, "", "create", "--name", "c", "alpine:3"), 1,
		`Error response from daemon: Conflict. The container name "/c" is already in use by container "`+id+`". You have to remove (or rename) that container to be able to reuse that name.`)

	missing := filepath.Join(d, "gone")
	want(t, run(t, f, "", "create", "--name", "d", "-v", missing+":"+missing, "alpine:3"), 1,
		`Error response from daemon: invalid mount config for type "bind": bind source path does not exist: `+missing)
	if len(f.Containers()) != 1 {
		t.Fatalf("containers = %v", f.Containers())
	}
}

func TestDefaultImageAfterAddOrBuild(t *testing.T) {
	t.Parallel()
	f := containertest.New(t)
	want(t, run(t, f, "", "image", "inspect", "--format", "{{.Id}}", "aiwb/claude:1"), 1, "Error response from daemon: No such image: aiwb/claude:1")
	if r := run(t, f, "", "image", "inspect", "--format", "{{.Id}}", "aiwb/claude:1"); r.out != "\n" {
		t.Fatalf("stdout = %q", r.out)
	}
	f.AddImage("aiwb/claude:1")
	if id := ok(t, f, "image", "inspect", "--format", "{{.Id}}", "aiwb/claude:1"); !strings.HasPrefix(id, "sha256:") {
		t.Fatalf("id = %q", id)
	}
	ok(t, f, "create", "--name", "a", "aiwb/claude:1", "sleep", "infinity")

	f.SetBuildDelay(200 * time.Millisecond)
	start := time.Now()
	if r := run(t, f, "FROM node:22\nRUN true\n", "build", "-t", "aiwb/claude:2", "-"); r.code != 0 {
		t.Fatalf("build: %+v", r)
	}
	if d := time.Since(start); d < 200*time.Millisecond {
		t.Fatalf("build took %v", d)
	}
	if b := f.Builds(); len(b) != 1 || b[0].Image != "aiwb/claude:2" || b[0].Dockerfile != "FROM node:22\nRUN true\n" {
		t.Fatalf("builds = %+v", b)
	}
	ok(t, f, "create", "--name", "b", "aiwb/claude:2", "sleep", "infinity")
	if imgs := f.Images(); !slices.Equal(imgs, []string{"aiwb/claude:1", "aiwb/claude:2"}) {
		t.Fatalf("images = %v", imgs)
	}
}

func TestPsFilter(t *testing.T) {
	t.Parallel()
	f := containertest.New(t)
	id1 := strings.TrimSpace(ok(t, f, "create", "--name", "a", "--label", "aiwb.alias=a", "alpine", "true"))
	id2 := strings.TrimSpace(ok(t, f, "create", "--name", "b", "--label", "aiwb.alias=b", "alpine", "true"))
	ok(t, f, "create", "--name", "other", "alpine", "true")
	got := strings.Fields(ok(t, f, "ps", "-a", "-q", "--no-trunc", "--filter", "label=aiwb.alias"))
	if slices.Sort(got); !slices.Equal(got, slices.Sorted(slices.Values([]string{id1, id2}))) {
		t.Fatalf("ps = %v", got)
	}
	if got := strings.Fields(ok(t, f, "ps", "-a", "-q", "--no-trunc", "--filter", "label=aiwb.alias=b")); !slices.Equal(got, []string{id2}) {
		t.Fatalf("ps value = %v", got)
	}
}

func TestExecDirEnvStatusStdin(t *testing.T) {
	t.Parallel()
	f := containertest.New(t)
	d, _ := filepath.EvalSymlinks(t.TempDir())
	sub := filepath.Join(d, "sub")
	os.Mkdir(sub, 0o755)
	newContainer(t, f, "c", d)

	out := ok(t, f, "exec", "-i", "-w", sub, "-e", "FOO=1", "-e", "FOO=bar", "c", "sh", "-c", `pwd; echo "$FOO"; echo "${AIWB_FAKEDOCKER_STATE-unset}"`)
	if out != sub+"\nbar\nunset\n" {
		t.Fatalf("out = %q", out)
	}
	if r := run(t, f, "", "exec", "c", "sh", "-c", "exit 7"); r.code != 7 {
		t.Fatalf("exit = %d", r.code)
	}
	if r := run(t, f, "hello\n", "exec", "-i", "c", "cat"); r.out != "hello\n" || r.code != 0 {
		t.Fatalf("cat: %+v", r)
	}
	want(t, run(t, f, "", "exec", "-w", "/etc", "c", "pwd"), 126,
		`OCI runtime exec failed: exec failed: unable to start container process: chdir to cwd ("/etc") set in config.json failed: no such file or directory`)
	want(t, run(t, f, "", "exec", "nope", "pwd"), 1, "Error response from daemon: No such container: nope")

	ok(t, f, "stop", "-t", "3", "c")
	c, _ := f.Container("c")
	want(t, run(t, f, "", "exec", "c", "pwd"), 1, "Error response from daemon: container "+c.ID+" is not running")
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

// startRun starts `sleep 30` through the run wrapper, with a detached `sleep 31` whose pid goes to
// the file pidFile, and returns the docker exec command and its wait.
func startRun(t *testing.T, f *containertest.Fake, dir, runID string, tty bool) (*exec.Cmd, chan int, int) {
	t.Helper()
	pidFile := filepath.Join(dir, runID+".pid")
	// set -m: the child gets a process group of its own, so only its AIWB_RUN finds it.
	script := `set -m; sleep 31 & echo $! > ` + pidFile + `; set +m; exec sleep 30`
	args := []string{"exec", "-i", "-w", dir, "-e", "AIWB_RUN=" + runID, "c", "/bin/sh", "-c", container.RunScript}
	if tty {
		args = append(args, container.RunTTYName, "'sh' '-c' '...'")
	} else {
		args = append(args, container.RunName)
	}
	cmd := exec.Command(f.Bin, append(args, "sh", "-c", script)...)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan int, 1)
	go func() {
		err := cmd.Wait()
		code := 0
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		}
		done <- code
	}()
	var child int
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		b, _ := os.ReadFile(pidFile)
		child, _ = strconv.Atoi(strings.TrimSpace(string(b)))
		runs := f.Runs()
		if child > 0 && len(runs) > 0 && runs[len(runs)-1].ID == runID {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the run did not start")
		}
	}
	t.Cleanup(func() { syscall.Kill(child, syscall.SIGKILL); cmd.Process.Kill() })
	return cmd, done, child
}

func waitCode(t *testing.T, done chan int) int {
	t.Helper()
	select {
	case c := <-done:
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("the run did not end")
		return 0
	}
}

func waitGone(t *testing.T, pid int) {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); alive(pid); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("process %d is still alive", pid)
		}
	}
}

func TestRunAndKill(t *testing.T) {
	t.Parallel()
	f := containertest.New(t)
	d, _ := filepath.EvalSymlinks(t.TempDir())
	newContainer(t, f, "c", d)
	runID := container.NewRunID()
	_, done, child := startRun(t, f, d, runID, false)

	runs := f.Runs()
	if len(runs) != 1 || runs[0].ID != runID || runs[0].Container != "c" || runs[0].TTY || !runs[0].Live || runs[0].Pgid <= 1 {
		t.Fatalf("runs = %+v", runs)
	}
	if pg, err := syscall.Getpgid(child); err != nil || pg == runs[0].Pgid {
		t.Fatalf("the detached child: pgid %d (run's %d), %v", pg, runs[0].Pgid, err)
	}
	ok(t, f, "exec", "c", "/bin/sh", "-c", container.KillScript, container.KillName, runID)
	if code := waitCode(t, done); code != 137 {
		t.Fatalf("run exit = %d, want 137", code)
	}
	waitGone(t, child) // a zombie until init reaps it at worst; kill -0 then fails soon
	if k := f.Kills(); !slices.Equal(k, []string{runID}) {
		t.Fatalf("kills = %v", k)
	}
	if r := f.Runs(); r[0].Live {
		t.Fatalf("run still live: %+v", r)
	}
	// An ended or unknown run is no error.
	ok(t, f, "exec", "c", "/bin/sh", "-c", container.KillScript, container.KillName, runID)
	ok(t, f, "exec", "c", "/bin/sh", "-c", container.KillScript, container.KillName, "rnope")
}

func TestStopKillsRuns(t *testing.T) {
	t.Parallel()
	f := containertest.New(t)
	d, _ := filepath.EvalSymlinks(t.TempDir())
	newContainer(t, f, "c", d)
	_, done, child := startRun(t, f, d, container.NewRunID(), true)
	if r := f.Runs(); !r[0].TTY {
		t.Fatalf("runs = %+v", r)
	}
	ok(t, f, "stop", "-t", "3", "c")
	if code := waitCode(t, done); code != 137 {
		t.Fatalf("run exit = %d", code)
	}
	waitGone(t, child)
}

func TestModes(t *testing.T) {
	t.Parallel()
	f := containertest.New(t)
	f.SetMode(containertest.ModeFail)
	want(t, run(t, f, "", "version", "--format", "{{.Server.Version}}"), 1, "Error response from daemon: stand-in docker failure")
	f.SetMode(containertest.ModeDown)
	want(t, run(t, f, "", "ps", "-a", "-q"), 1, "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory")

	f.SetMode(containertest.ModeSlow)
	f.SetSlow(300 * time.Millisecond)
	start := time.Now()
	ok(t, f, "version", "--format", "{{.Server.Version}}")
	if d := time.Since(start); d < 300*time.Millisecond || d > 3*time.Second {
		t.Fatalf("slow took %v", d)
	}

	f.SetMode(containertest.ModeMissing)
	if _, err := os.Stat(f.Bin); !os.IsNotExist(err) {
		t.Fatalf("Bin is there: %v", err)
	}
	if err := exec.Command(f.Bin, "version").Run(); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("run of a missing Bin: %v", err)
	}
	f.SetMode(containertest.ModeOK)
	ok(t, f, "version", "--format", "{{.Server.Version}}")

	f.FailOn("create", "Error response from daemon: disk full")
	want(t, run(t, f, "", "create", "--name", "x", "alpine"), 1, "Error response from daemon: disk full")
	ok(t, f, "version")
	f.FailOn("create", "")
	ok(t, f, "create", "--name", "x", "alpine")
	if n := len(f.CallsOf("create")); n != 2 {
		t.Fatalf("create calls = %d", n)
	}
}

func TestSetState(t *testing.T) {
	t.Parallel()
	f := containertest.New(t)
	d, _ := filepath.EvalSymlinks(t.TempDir())
	newContainer(t, f, "c", d)
	_, done, _ := startRun(t, f, d, container.NewRunID(), false)
	f.SetState("c", "exited")
	if code := waitCode(t, done); code != 137 {
		t.Fatalf("run exit = %d", code)
	}
	if c, _ := f.Container("c"); c.State != "exited" {
		t.Fatalf("state = %s", c.State)
	}
}

func TestConcurrentCreates(t *testing.T) {
	t.Parallel()
	f := containertest.New(t)
	var wg sync.WaitGroup
	var mu sync.Mutex
	succeeded := 0
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := exec.Command(f.Bin, "create", "--name", "same", "alpine", "true").Run(); err == nil {
				mu.Lock()
				succeeded++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if succeeded != 1 || len(f.Containers()) != 1 || len(f.CallsOf("create")) != 8 {
		t.Fatalf("succeeded %d, containers %d, calls %d", succeeded, len(f.Containers()), len(f.CallsOf("create")))
	}
}

func TestCreateEndOfOptions(t *testing.T) {
	t.Parallel()
	f := containertest.New(t)
	d := t.TempDir()

	// "--" ends the options: what follows is the image and the command.
	ok(t, f, "create", "--name", "a", "--init", "--label", "k=v", "-v", d+":"+d, "--user", "1:2", "--", "alpine:3", "sleep", "infinity")
	c, found := f.Container("a")
	if !found || c.Image != "alpine:3" || !slices.Equal(c.Cmd, []string{"sleep", "infinity"}) || !c.Init || c.User != "1:2" ||
		c.Labels["k"] != "v" || !slices.Equal(c.Binds, []string{d + ":" + d}) {
		t.Fatalf("container = %+v", c)
	}

	// An image that looks like an option, after "--", is an image (and not a valid reference).
	for _, img := range []string{"--privileged", "-v=/:/host"} {
		want(t, run(t, f, "", "create", "--name", "b", "--", img, "sleep", "1"), 125, "docker: invalid reference format.")
	}
	// An unknown option before "--" is still refused.
	want(t, run(t, f, "", "create", "--name", "b", "--privileged", "--", "alpine:3"), 125, "unknown flag: --privileged")
	if cs := f.Containers(); len(cs) != 1 {
		t.Fatalf("containers = %+v", cs)
	}
}

func TestPullAndImageInspect(t *testing.T) {
	t.Parallel()
	f := containertest.New(t)
	inspect := func(img string) result {
		return run(t, f, "", "image", "inspect", "--format", "{{.Id}}", "--", img)
	}
	want(t, inspect("example/img:1"), 1, "Error response from daemon: No such image: example/img:1")

	f.SetPullDelay(200 * time.Millisecond)
	start := time.Now()
	ok(t, f, "pull", "--", "example/img:1")
	if d := time.Since(start); d < 200*time.Millisecond {
		t.Fatalf("pull took %v", d)
	}
	if id := ok(t, f, "image", "inspect", "--format", "{{.Id}}", "--", "example/img:1"); !strings.HasPrefix(id, "sha256:") {
		t.Fatalf("id = %q", id)
	}
	if p := f.Pulls(); !slices.Equal(p, []string{"example/img:1"}) {
		t.Fatalf("pulls = %q", p)
	}
	f.SetPullDelay(0)

	// The default image's repository is never in a registry.
	want(t, run(t, f, "", "pull", "aiwb/claude:9"), 1,
		"Error response from daemon: pull access denied for aiwb/claude, repository does not exist or may require 'docker login'")
	want(t, run(t, f, "", "pull", "--", "--privileged"), 1, "invalid reference format")
	want(t, run(t, f, "", "pull", "--all-tags", "x"), 125, "unknown flag: --all-tags")

	// An image create pulled is there for image inspect.
	ok(t, f, "create", "--name", "c", "--", "busybox", "true")
	if id := ok(t, f, "image", "inspect", "--format", "{{.Id}}", "busybox"); !strings.HasPrefix(id, "sha256:") {
		t.Fatalf("id = %q", id)
	}

	f.FailOn("pull", "Error response from daemon: toomanyrequests")
	want(t, run(t, f, "", "pull", "example/img:2"), 1, "Error response from daemon: toomanyrequests")
	if p := f.Pulls(); len(p) != 1 || len(f.CallsOf("pull")) != 5 {
		t.Fatalf("pulls = %q, calls %q", p, f.CallsOf("pull"))
	}
}
