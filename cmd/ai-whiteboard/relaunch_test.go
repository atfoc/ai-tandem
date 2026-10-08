package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/testset"
)

// serverTest is the first line of every test that starts server processes. Such a test is in the
// full set only (it builds the binary and starts servers; the few that are in the default set too
// call smokeTest), and runs in parallel with the others: each has its own data folder, ports and
// environment (newInstance, instance.vars), and they mostly wait. cover names the tests of the
// default set that cover the same behaviour without a server process; without it the reason says
// where the default set has tests of the real binary at all.
func serverTest(t *testing.T, cover ...string) {
	t.Helper()
	reason := "builds the binary and starts servers; the tests of the default set that build the binary and start it are the six that call smokeTest (relaunch_test.go), TestRunE2ENoGit a whole server among them"
	if len(cover) > 0 {
		reason = "builds the binary and starts servers; in the default set: " + strings.Join(cover, "; ")
	}
	testset.SkipUnlessFull(t, reason)
	t.Parallel()
}

// smokeTest is serverTest for the tests of real server processes that the default set runs as
// well, so that whoever works elsewhere in the repository notices when the server no longer builds,
// starts or takes a run to its end. Each is the cheapest test of something that no test without a
// server process covers:
//
//	TestRunE2ENoGit                          a whole server and a run: some 2.5 s, no git repository
//	TestRemoteListenerServes                 the remote listener of a real server, over HTTPS
//	TestRemoteRunGroupServer                 two real servers, one an entry of the other's list
//	TestReloadKeepsSecretWhenUnreadable      the signal that makes a real server read its secret again
//	TestStartCheckComesBeforeTheBinds        a start that the check of remote access ends
//	TestSetupRemoteScriptRefusesEmptyValues  a script of the server folder, run through sh
func smokeTest(t *testing.T) {
	t.Helper()
	t.Parallel()
}

// instance is one data folder and port for the process-level tests, and the flags that select them.
type instance struct {
	bin, dir string
	claude   string // the -claude flag: a program that does not exist, unless a test swaps in a fake
	cursor   string // the -cursor flag, likewise; "" leaves the flag out (`agent` on PATH)
	pi       string // the -pi flag, likewise
	port     int
	mcpPort  int
	vars     []string // what environ adds to this process's environment: the MCP port, a Cursor config folder and what setenv added
	url      string   // http://127.0.0.1:<port>/
	mcpURL   string   // http://localhost:<mcpPort>/mcp
}

// newInstance builds the program (once for the test binary) and picks a temp data folder, a free
// app port and a free MCP port (through the hidden test-only override, see environ). Its servers are
// stopped in cleanup. Its caller has called serverTest (or smokeTest) first.
func newInstance(t *testing.T) *instance {
	t.Helper()
	bin := buildBinary(t)
	in := &instance{bin: bin, dir: t.TempDir(), claude: noClaude(t), cursor: filepath.Join(t.TempDir(), "no-agent"), pi: filepath.Join(t.TempDir(), "no-pi"), port: freePort(t), mcpPort: freePort(t)}
	in.vars = []string{"AIWB_MCP_PORT=" + strconv.Itoa(in.mcpPort), "CURSOR_CONFIG_DIR=" + t.TempDir()}
	in.url = fmt.Sprintf("http://127.0.0.1:%d/", in.port)
	in.mcpURL = fmt.Sprintf("http://localhost:%d/mcp", in.mcpPort)
	t.Cleanup(func() {
		in.command(context.Background(), "stop").Run()
		exec.Command("pkill", "-KILL", "-f", "--", "-home "+in.dir).Run()
	})
	return in
}

// environ is the environment of every process of the program this test starts (see serverEnv):
// this process's as it is now, with the instance's MCP port and Cursor config folder and what the
// test added with setenv. A later value of a name wins.
func (in *instance) environ() []string {
	return append(os.Environ(), in.vars...)
}

// setenv adds NAME=value pairs to the environment of every process the instance starts from now
// on. It is the tests' t.Setenv: the value is the server's alone, so the test can run in parallel.
func (in *instance) setenv(pairs ...string) {
	in.vars = append(in.vars, pairs...)
}

// loopbackBind is the hidden test-only override that binds a server's remote listener on
// 127.0.0.1: a wildcard bind by a freshly built binary can raise the macOS firewall dialog.
const loopbackBind = "AIWB_REMOTE_BIND=127.0.0.1"

// command is `ai-whiteboard <command> <more> <flags>` with the instance's environment.
func (in *instance) command(ctx context.Context, command string, more ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, in.bin, append(append([]string{command}, more...), in.flags()...)...)
	cmd.Env = in.environ()
	return cmd
}

func (in *instance) flags() []string {
	flags := []string{"-home", in.dir, "-port", strconv.Itoa(in.port), "-client", "", "-claude", in.claude, "-pi", in.pi}
	if in.cursor != "" {
		flags = append(flags, "-cursor", in.cursor)
	}
	return flags
}

// noClaude returns the path of a Claude binary that does not exist, for the -claude flag of every
// server a test starts: no test may run the owner's installed `claude`. The -cursor and -pi flags
// get such a path too, so that a server neither starts the installed Cursor agent or pi nor
// behaves differently on a machine that has them.
func noClaude(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "no-claude")
}

// run runs `ai-whiteboard <command> <flags>` and returns its stdout; it must exit 0.
func (in *instance) run(t *testing.T, command string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	out, err := in.command(ctx, command).Output()
	if err != nil {
		var stderr string
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			stderr = string(ee.Stderr)
		}
		t.Fatalf("%s: %v\n%s", command, err, stderr)
	}
	return string(out)
}

// hello returns the running server's /api/hello answer; it must answer.
func (in *instance) hello(t *testing.T) helloReply {
	t.Helper()
	h, ok := helloOf(httpClient(), strings.TrimSuffix(in.url, "/"))
	if !ok {
		t.Fatalf("no server answers at %s", in.url)
	}
	return h
}

// waitGone waits up to 5 s for process pid to be gone.
func waitGone(t *testing.T, pid int) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			return
		}
	}
	t.Fatalf("old server pid %d still running", pid)
}

func TestRelaunchWithNoServerIsLaunch(t *testing.T) {
	serverTest(t)
	in := newInstance(t)
	if got := in.run(t, "relaunch"); got != in.url+"\n" {
		t.Fatalf("relaunch printed %q, want the single line %q", got, in.url)
	}
	in.hello(t)
}

func TestRelaunchReplacesRunningServer(t *testing.T) {
	serverTest(t)
	in := newInstance(t)
	if got := in.run(t, "launch"); got != in.url+"\n" {
		t.Fatalf("launch printed %q", got)
	}
	old := in.hello(t).Pid

	if got := in.run(t, "relaunch"); got != in.url+"\n" {
		t.Fatalf("relaunch printed %q, want the single line %q", got, in.url)
	}
	if pid := in.hello(t).Pid; pid == old {
		t.Fatalf("/api/hello still reports the old pid %d", old)
	}
	waitGone(t, old)
}

// POST /api/restart from the active client starts relaunch; a new server takes over.
func TestRestartEndpoint(t *testing.T) {
	serverTest(t, "TestRestart, TestRestartBinaryMissing (internal/server)")
	in := newInstance(t)
	in.run(t, "launch")
	old := in.hello(t).Pid

	const client = "restart-test"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", in.url+"api/events?client="+client, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(nil, 1<<20)
	for active := false; !active; {
		if !sc.Scan() {
			t.Fatalf("events ended before the client's hello: %v", sc.Err())
		}
		var ev map[string]any
		if line, ok := strings.CutPrefix(sc.Text(), "data: "); ok && json.Unmarshal([]byte(line), &ev) == nil {
			active = ev["type"] == "hello"
		}
	}
	go flushWhenStopping(in.url, client, sc)

	req, _ = http.NewRequest("POST", in.url+"api/restart", nil)
	req.Header.Set("X-AIWB-Client", client)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("restart: status %d, want 202", res.StatusCode)
	}

	for deadline := time.Now().Add(45 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if h, ok := helloOf(httpClient(), strings.TrimSuffix(in.url, "/")); ok && h.Pid != old {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no new server answered within 45 s")
		}
	}
	waitGone(t, old)
}
