package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// instance is one data folder and port for the process-level tests, and the flags that select them.
type instance struct {
	bin, dir string
	claude   string // the -claude flag: a program that does not exist, unless a test swaps in a fake
	port     int
	mcpPort  int
	url      string // http://127.0.0.1:<port>/
	mcpURL   string // http://localhost:<mcpPort>/mcp
}

// newInstance builds the program and picks a temp data folder, a free app port and a free MCP
// port (through the hidden test-only override). Its servers are stopped in cleanup.
func newInstance(t *testing.T) *instance {
	t.Helper()
	if testing.Short() {
		t.Skip("builds the binary and starts servers")
	}
	bin := buildBinary(t)
	in := &instance{bin: bin, dir: t.TempDir(), claude: noClaude(t), port: freePort(t), mcpPort: testMCPPort(t)}
	in.url = fmt.Sprintf("http://127.0.0.1:%d/", in.port)
	in.mcpURL = fmt.Sprintf("http://localhost:%d/mcp", in.mcpPort)
	t.Cleanup(func() {
		exec.Command(bin, append([]string{"stop"}, in.flags()...)...).Run()
		exec.Command("pkill", "-KILL", "-f", "--", "-home "+in.dir).Run()
	})
	return in
}

func (in *instance) flags() []string {
	return []string{"-home", in.dir, "-port", strconv.Itoa(in.port), "-client", "", "-claude", in.claude}
}

// noClaude returns the path of a Claude binary that does not exist, for the -claude flag of every
// server a test starts: no test may run the owner's installed `claude`.
func noClaude(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "no-claude")
}

// run runs `ai-whiteboard <command> <flags>` and returns its stdout; it must exit 0.
func (in *instance) run(t *testing.T, command string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, in.bin, append([]string{command}, in.flags()...)...).Output()
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
	in := newInstance(t)
	if got := in.run(t, "relaunch"); got != in.url+"\n" {
		t.Fatalf("relaunch printed %q, want the single line %q", got, in.url)
	}
	in.hello(t)
}

func TestRelaunchReplacesRunningServer(t *testing.T) {
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

	for deadline := time.Now().Add(45 * time.Second); ; time.Sleep(500 * time.Millisecond) {
		if h, ok := helloOf(httpClient(), strings.TrimSuffix(in.url, "/")); ok && h.Pid != old {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no new server answered within 45 s")
		}
	}
	waitGone(t, old)
}
