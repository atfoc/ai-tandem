//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/model"
)

// imageBuildLimit bounds the server's build of the default image on its first need (about 20 s
// with Docker's caches, minutes without them).
const imageBuildLimit = 15 * time.Minute

// A Claude account in the computer's real Docker (plan §3.9, the one real-Docker test of the
// server): a server with -docker docker adds an account with a temp folder mounted and logs it in
// through the login routes, which build the default image when it is not there and run the login
// in the container (util-linux script). The account's claude is the fake claude, put in the
// mounted folder so that the container runs it (node is in the image); it reaches the MCP
// listener over Docker's own host.docker.internal (no FAKE_CLAUDE_MCP_HOST_MAP). Checked: the
// container as Docker has it (exactly the two mounts, same path on both sides; the person's
// uid:gid; the host-gateway host); a chat in the mounted folder answers and its board calls reach
// the board; the app's Stop of a chat whose turn left a detached command kills the run inside the
// running container (ps); the forced Restart makes a new container and a file in the account's
// folder survives it; the forced Stop of the account stops the container. Nothing is left behind:
// the container is removed, and the image too when the test built it (AIWB_TEST_KEEP_IMAGE=1
// keeps it).
func TestAccountInRealDocker(t *testing.T) {
	serverTest(t, "TestAccountChatsThroughTheStandInDocker, TestAccountChatAfterARestart (accounts_server_test.go) cover the same with the stand-in docker; this one uses the computer's real Docker")
	if out, err := exec.Command("docker", "version", "--format", "{{.Server.Version}}").CombinedOutput(); err != nil {
		t.Skipf("docker version failed: %v: %s", err, out)
	}
	image := container.DefaultImage() // the server is built without a version, as this test binary is
	hadImage := exec.Command("docker", "image", "inspect", image).Run() == nil
	if !hadImage && os.Getenv("AIWB_TEST_KEEP_IMAGE") != "1" {
		// Registered first, so it runs last: after the container is gone.
		t.Cleanup(func() {
			if out, err := exec.Command("docker", "rmi", image).CombinedOutput(); err != nil {
				t.Errorf("docker rmi %s: %v: %s", image, err, out)
			}
		})
	}

	a := newAccountInstance(t)
	a.instance.docker = "docker"
	// The fake claude in the folder that will be mounted: the container has it at the same path.
	mounted := realDir(t)
	fake := filepath.Join(mounted, "fake-claude")
	if raw, err := os.ReadFile(a.fake); err != nil || os.WriteFile(fake, raw, 0o755) != nil {
		t.Fatalf("the fake claude in the mounted folder: %v", err)
	}
	a.setenv("AIWB_TEST_ALIAS_CLAUDE=" + fake)

	var id string // the account's, once added
	t.Cleanup(func() {
		// The server first (its own cleanup would come later), then the account's containers.
		a.command(context.Background(), "stop").Run()
		if id == "" {
			return
		}
		filter := "label=" + container.LabelAlias + "=" + id
		out, _ := exec.Command("docker", "ps", "-a", "-q", "--filter", filter).Output()
		for _, c := range strings.Fields(string(out)) {
			if out, err := exec.Command("docker", "rm", "-f", c).CombinedOutput(); err != nil {
				t.Errorf("docker rm -f %s: %v: %s", c, err, out)
			}
		}
		if out, err := exec.Command("docker", "ps", "-a", "-q", "--filter", filter).Output(); err != nil || len(strings.TrimSpace(string(out))) > 0 {
			t.Errorf("containers of the account left after the cleanup: %q, %v", out, err)
		}
	})

	a.start(t)
	w := a.window(t)
	v := a.addAccount(t, "Real", mounted)
	id = v.ID
	kind, name, aliasDir := v.Kind, container.Name(v.ID), aliases.Dir(a.dir, v.ID)
	began := time.Now()
	a.logIn(t, id, imageBuildLimit)
	t.Logf("the login answered waiting %v after its start (the image was there before: %v)", time.Since(began).Round(time.Second), hadImage)
	a.waitFor(t, "the account usable", func() bool { return slices.Contains(a.snapshotAgents(t), kind) })

	// (1) The container as Docker has it: exactly the account's folder and the mounted one, each at
	// its own path inside, the person's uid:gid, Docker's host name of the host.
	first := inspectContainer(t, name)
	var srcs, dsts []string
	for _, m := range first.Mounts {
		srcs, dsts = append(srcs, m.Source), append(dsts, m.Destination)
	}
	if want := []string{aliasDir, mounted}; !samePaths(srcs, want) || !slices.Equal(srcs, dsts) {
		t.Fatalf("the container's mounts: sources %q, destinations %q; want exactly %q, each at the same path inside", srcs, dsts, want)
	}
	t.Logf("the container's mounts: %q", srcs)
	if want := strconv.Itoa(os.Getuid()) + ":" + strconv.Itoa(os.Getgid()); first.Config.User != want ||
		!slices.Equal(first.HostConfig.ExtraHosts, []string{"host.docker.internal:host-gateway"}) ||
		first.Config.Labels[container.LabelAlias] != id || first.Config.Image != image || !first.State.Running {
		t.Fatalf("the container: user %q, extra hosts %q, labels %v, image %q, running %v; want %s, the host-gateway host, the account's label, %s, running",
			first.Config.User, first.HostConfig.ExtraHosts, first.Config.Labels, first.Config.Image, first.State.Running, want, image)
	}

	// (2) A board chat in the mounted folder answers from the container, and its board calls reach
	// the board over host.docker.internal.
	var board struct{ ID string }
	a.must(t, testClient, "POST", "/api/boards", map[string]any{"name": "real docker", "group": model.Ungrouped}, &board)
	a.take(t, w, board.ID)
	var rpcs atomic.Int32
	w.OnRPC(func(map[string]any) (any, string) { rpcs.Add(1); return "from the window", "" })
	chat := a.accountChat(t, kind, board.ID, mounted)
	reply := a.say(t, chat, `hello [[mcp read_board {}]] [[mcp apply {"add":[]}]]`)
	for _, want := range []string{"FAKE(", "read_board -> from the window\n", "apply -> from the window\n"} {
		if !strings.Contains(reply, want) {
			t.Fatalf("the reply has no %q:\n%s\n%s", want, reply, a.s.out.String())
		}
	}
	if n := rpcs.Load(); n != 2 {
		t.Fatalf("the window was given %d board calls, want the read and the change", n)
	}

	// (3) The app's Stop of the chat while its turn's detached command runs closes the chat's
	// process: in the container that still runs, neither the process nor the command is left.
	mark := fmt.Sprintf("60.%06d", rand.IntN(1e6)) // the command's seconds, ours alone
	a.say(t, chat, "[[bg "+mark+"]]")
	ours := func() []string { // the chat's processes (its MCP config is named after it) and the command
		var lines []string
		for _, l := range strings.Split(dockerOut(t, "exec", name, "ps", "-eo", "args"), "\n") {
			if strings.Contains(l, chat) || strings.Contains(l, "sleep "+mark) {
				lines = append(lines, strings.TrimSpace(l))
			}
		}
		return lines
	}
	a.waitFor(t, "the chat's process and its command in the container", func() bool {
		l := strings.Join(ours(), "\n")
		return strings.Contains(l, chat) && strings.Contains(l, "sleep "+mark)
	})
	a.must(t, testClient, "POST", "/api/chats/"+chat+"/interrupt", nil, nil)
	stopped := time.Now()
	for left := ours(); len(left) > 0; left = ours() {
		if time.Since(stopped) > 10*time.Second {
			t.Fatalf("10 s after the Stop these still run in the container:\n%s", strings.Join(left, "\n"))
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Logf("the run's processes were gone %v after the Stop", time.Since(stopped).Round(time.Millisecond))
	if !inspectContainer(t, name).State.Running {
		t.Fatal("the chat's Stop stopped the container")
	}

	// (4) A file written in the account's folder from the container, by the person's uid, survives
	// the forced Restart, which makes a new container while a turn works.
	kept := filepath.Join(aliasDir, "kept.txt")
	dockerOut(t, "exec", name, "sh", "-c", "echo kept > "+kept)
	if b, err := os.ReadFile(kept); err != nil || string(b) != "kept\n" {
		t.Fatalf("the file on the host: %q, %v", b, err)
	}
	a.must(t, testClient, "POST", "/api/chats/"+chat+"/messages", map[string]any{"text": "[[sleep 60]]"}, nil)
	a.waitFor(t, "the turn working in the container", func() bool {
		return a.chatView(t, chat).Status != model.StatusReady && strings.Contains(strings.Join(ours(), "\n"), chat)
	})
	var ch aliases.Change
	a.must(t, testClient, "POST", "/api/aliases/"+id+"/restart", map[string]any{}, &ch)
	if ch.Restart != aliases.RestartBusy || ch.Busy != 1 {
		t.Fatalf("the Restart with a working turn: %+v, want busy 1", ch)
	}
	a.must(t, testClient, "POST", "/api/aliases/"+id+"/restart", map[string]any{"force": true}, &ch)
	if ch.Restart != aliases.RestartDone {
		t.Fatalf("the forced Restart: %+v, want done\n%s", ch, a.s.out.String())
	}
	second := inspectContainer(t, name)
	if second.ID == first.ID || !second.State.Running {
		t.Fatalf("after the Restart the container is %s (running %v), before it was %s: want a new one, running", second.ID, second.State.Running, first.ID)
	}
	if got := dockerOut(t, "exec", name, "cat", kept); got != "kept\n" {
		t.Fatalf("the file in the new container: %q", got)
	}
	a.waitFor(t, "the chat no longer working", func() bool { return a.chatView(t, chat).Status == model.StatusReady })
	if reply := a.say(t, chat, "after the restart [[mcp read_board {}]]"); !strings.Contains(reply, "read_board -> from the window\n") {
		t.Fatalf("the reply after the Restart:\n%s\n%s", reply, a.s.out.String())
	}

	// (5) The account's forced Stop while a turn works stops the container.
	a.must(t, testClient, "POST", "/api/chats/"+chat+"/messages", map[string]any{"text": "[[sleep 60]]"}, nil)
	a.waitFor(t, "the turn working in the container", func() bool {
		return a.chatView(t, chat).Status != model.StatusReady && strings.Contains(strings.Join(ours(), "\n"), chat)
	})
	a.must(t, testClient, "POST", "/api/aliases/"+id+"/stop", map[string]any{"force": true}, &ch)
	if ch.Restart != aliases.RestartDone {
		t.Fatalf("the forced Stop: %+v, want done\n%s", ch, a.s.out.String())
	}
	if c := inspectContainer(t, name); c.State.Running || c.ID != second.ID {
		t.Fatalf("after the Stop the container %s is running %v, want %s stopped", c.ID, c.State.Running, second.ID)
	}
	a.waitFor(t, "the chat no longer working", func() bool { return a.chatView(t, chat).Status == model.StatusReady })
	noSecret(t, a.secret, a.s.out.String())
}

// inspected is what the real-Docker test reads of `docker inspect <container>`.
type inspected struct {
	ID     string `json:"Id"`
	Config struct {
		User   string
		Image  string
		Labels map[string]string
	}
	HostConfig struct{ ExtraHosts []string }
	Mounts     []struct{ Source, Destination string }
	State      struct{ Running bool }
}

// inspectContainer is `docker inspect` of the container name.
func inspectContainer(t *testing.T, name string) inspected {
	t.Helper()
	var got []inspected
	if err := json.Unmarshal([]byte(dockerOut(t, "inspect", name)), &got); err != nil || len(got) != 1 {
		t.Fatalf("docker inspect %s: %v, %d containers", name, err, len(got))
	}
	return got[0]
}

// dockerOut runs the real docker with args, within a minute, and returns its stdout; it must
// exit 0.
func dockerOut(t *testing.T, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", args...).Output()
	if err != nil {
		var stderr []byte
		if ee, ok := err.(*exec.ExitError); ok {
			stderr = ee.Stderr
		}
		t.Fatalf("docker %q: %v: %s", args, err, stderr)
	}
	return string(out)
}

// samePaths reports whether got and want are the same set of paths, a symlinked prefix (macOS's
// /var → /private/var) aside.
func samePaths(got, want []string) bool {
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
	return len(got) == len(want) && slices.Equal(norm(got), norm(want))
}
