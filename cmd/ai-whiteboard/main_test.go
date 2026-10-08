package main

import (
	"bytes"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/store"
)

// TestMain points CURSOR_CONFIG_DIR at a temp folder for the whole run: every server a test starts
// adds deny rules for its data folder to the Cursor CLI config, and must not add them to the user's.
// (A server started with serverEnv gets a folder of its own; this one is for whatever is not.)
//
// The tests that start servers run in parallel, at most agenttest.SpawnBound at once on macOS: they
// mostly wait, and each starts a server, git commands and Node processes.
func TestMain(m *testing.M) {
	agenttest.FastGit()
	agenttest.LimitParallel()
	dir, err := os.MkdirTemp("", "aiwb-cmd-cursor-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Setenv("CURSOR_CONFIG_DIR", dir)
	code := m.Run()
	os.RemoveAll(dir)
	for _, b := range []*builtBinary{&plainBinary, &raceBinary} {
		if b.dir != "" {
			os.RemoveAll(b.dir)
		}
	}
	os.Exit(code)
}

func portOf(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	return srv.Listener.Addr().(*net.TCPAddr).Port
}

// freePorts are the ports freePort has given out: tests run in parallel, and two of them must not
// be given the same port before either has a server listening on it.
var freePorts = struct {
	sync.Mutex
	given map[int]bool
}{given: map[int]bool{}}

// freePort returns a port nothing listens on, and that no other test of this binary was given.
func freePort(t *testing.T) int {
	t.Helper()
	for {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := ln.Addr().(*net.TCPAddr).Port
		ln.Close()
		freePorts.Lock()
		taken := freePorts.given[port]
		freePorts.given[port] = true
		freePorts.Unlock()
		if !taken {
			return port
		}
	}
}

// builtBinary is the program built once for the whole test binary, into a temp folder that
// TestMain removes.
type builtBinary struct {
	once sync.Once
	dir  string
	path string
	err  error
}

var plainBinary, raceBinary builtBinary

func (b *builtBinary) build(t *testing.T, name string, flags ...string) string {
	t.Helper()
	b.once.Do(func() {
		if b.dir, b.err = os.MkdirTemp("", "aiwb-cmd-bin-"); b.err != nil {
			return
		}
		b.path = filepath.Join(b.dir, name)
		args := append(append([]string{"build"}, flags...), "-o", b.path, "ai-whiteboard/cmd/ai-whiteboard")
		if out, err := exec.Command("go", args...).CombinedOutput(); err != nil {
			b.err = fmt.Errorf("go %s: %v\n%s", strings.Join(args[:len(args)-3], " "), err, out)
		}
	})
	if b.err != nil {
		t.Fatal(b.err)
	}
	return b.path
}

// buildBinary returns the program built for the process-level tests; the first test that asks
// builds it.
func buildBinary(t *testing.T) string {
	t.Helper()
	return plainBinary.build(t, "ai-whiteboard")
}

// buildRaceBinary is buildBinary with the race detector built in.
func buildRaceBinary(t *testing.T) string {
	t.Helper()
	return raceBinary.build(t, "ai-whiteboard-race", "-race")
}

// serverEnv is the environment of the processes of the program that one test starts
// (serve/launch/relaunch/stop, and the children of relaunch, which inherit it): this process's,
// with the hidden AIWB_MCP_PORT override set to mcpPort, so that every server binds there instead
// of the machine-global 6006, and a Cursor CLI config folder of the test's own. The override is
// test-only: production is fixed at 6006 (plan D10), so no process test may ever touch it. It goes
// to the child through cmd.Env, not through this process's environment, so the tests can run in
// parallel.
func serverEnv(t *testing.T, mcpPort int, more ...string) []string {
	t.Helper()
	env := append(os.Environ(), "AIWB_MCP_PORT="+strconv.Itoa(mcpPort), "CURSOR_CONFIG_DIR="+t.TempDir())
	return append(env, more...)
}

// The hidden AIWB_MCP_PORT override defaults to the fixed production port; it is not a flag
// (plan D10).
func TestMCPPortSetting(t *testing.T) {
	t.Setenv("AIWB_MCP_PORT", "")
	if got := mcpPort(); got != boardapi.MCPPort {
		t.Fatalf("unset override: got %d, want %d", got, boardapi.MCPPort)
	}
	t.Setenv("AIWB_MCP_PORT", " 1234 ")
	if got := mcpPort(); got != 1234 {
		t.Fatalf("override: got %d, want 1234", got)
	}
}

// The hidden AIWB_CHAT_CAP and AIWB_APP_CAP overrides lower the cap on running turns; unset or
// invalid, the caps stay 4 per chat and 12 overall.
func TestTurnCapsSetting(t *testing.T) {
	t.Cleanup(func() { chats.SetCaps("4", "12") })
	t.Setenv("AIWB_CHAT_CAP", "")
	t.Setenv("AIWB_APP_CAP", "")
	if c, a := turnCaps(); c != 4 || a != 12 {
		t.Fatalf("unset overrides: got %d and %d, want 4 and 12", c, a)
	}
	t.Setenv("AIWB_CHAT_CAP", "many")
	t.Setenv("AIWB_APP_CAP", "0")
	if c, a := turnCaps(); c != 4 || a != 12 {
		t.Fatalf("invalid overrides: got %d and %d, want 4 and 12", c, a)
	}
	t.Setenv("AIWB_CHAT_CAP", "1")
	t.Setenv("AIWB_APP_CAP", " 2 ")
	if c, a := turnCaps(); c != 1 || a != 2 {
		t.Fatalf("overrides: got %d and %d, want 1 and 2", c, a)
	}
	if got := chats.ErrChatCap.Error(); !strings.Contains(got, "1 branch working") {
		t.Fatalf("the refusal's text with the override: %q", got)
	}
}

func paths(t *testing.T) store.Paths {
	t.Helper()
	p := store.NewPaths(t.TempDir())
	return p
}

func writeServerFile(t *testing.T, p store.Paths, port int) {
	t.Helper()
	if err := store.WriteServerFile(p, port); err != nil {
		t.Fatal(err)
	}
}

func hello(app string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/hello" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"app":%q,"version":"dev","pid":%d}`, app, os.Getpid())
	}))
}

func TestFindRunningOurServerViaServerFile(t *testing.T) {
	srv := hello("ai-whiteboard")
	defer srv.Close()
	p := paths(t)
	port := portOf(t, srv)
	writeServerFile(t, p, port)

	url, ok := findRunning(p, freePort(t))
	if !ok {
		t.Fatal("findRunning = false, want true")
	}
	if want := fmt.Sprintf("http://127.0.0.1:%d/", port); url != want {
		t.Fatalf("url = %q, want %q", url, want)
	}
}

func TestFindRunningOurServerViaPortFlag(t *testing.T) {
	srv := hello("ai-whiteboard")
	defer srv.Close()
	p := paths(t) // no server.json
	if _, ok := findRunning(p, portOf(t, srv)); !ok {
		t.Fatal("findRunning = false, want true")
	}
}

func TestFindRunningStaleServerFile(t *testing.T) {
	p := paths(t)
	writeServerFile(t, p, freePort(t))
	if url, ok := findRunning(p, freePort(t)); ok {
		t.Fatalf("findRunning = %q, true; want false for a stale server.json", url)
	}
}

func TestFindRunningOtherProgram(t *testing.T) {
	other := hello("something-else")
	defer other.Close()
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "<html>hi</html>")
	}))
	defer plain.Close()

	p := paths(t)
	writeServerFile(t, p, portOf(t, other))
	if _, ok := findRunning(p, portOf(t, plain)); ok {
		t.Fatal("findRunning = true, want false for another program on the port")
	}
	if _, ok := findRunning(paths(t), portOf(t, other)); ok {
		t.Fatal("findRunning = true, want false for another program answering /api/hello")
	}
}

func TestExpand(t *testing.T) {
	for in, want := range map[string]string{"~": "/h", "~/.x": "/h/.x", "/abs": "/abs", "rel": "rel"} {
		if got := expand(in, "/h"); got != want {
			t.Errorf("expand(%q) = %q, want %q", in, got, want)
		}
	}
}

// No command means serve, inside an app bundle too: the Electron app always passes launch.
func TestCommand(t *testing.T) {
	for _, c := range []struct {
		args []string
		cmd  string
		rest int
	}{
		{nil, "serve", 0},
		{[]string{}, "serve", 0},
		{[]string{"-port", "1"}, "serve", 2},
		{[]string{"serve", "-port", "1"}, "serve", 2},
		{[]string{"launch"}, "launch", 0},
		{[]string{"relaunch", "-port", "1"}, "relaunch", 2},
		{[]string{"stop", "-home", "/x"}, "stop", 2},
	} {
		cmd, rest := command(c.args)
		if cmd != c.cmd || len(rest) != c.rest {
			t.Errorf("command(%q) = %q, %q; want %q with %d args", c.args, cmd, rest, c.cmd, c.rest)
		}
	}
}

func TestLaunchPrintsRunningServerURL(t *testing.T) {
	srv := hello("ai-whiteboard")
	defer srv.Close()
	port := portOf(t, srv)
	var out bytes.Buffer
	launch(options{port: port, paths: paths(t)}, nil, &out)
	if got, want := out.String(), fmt.Sprintf("http://127.0.0.1:%d/\n", port); got != want {
		t.Fatalf("launch wrote %q, want %q", got, want)
	}
}

// launch never stops a server, whatever its version: the page offers the restart.
func TestLaunchKeepsServerOfAnotherVersion(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"app":"ai-whiteboard","version":"v0.0.1-old","webVersion":"v9.9.9-new","pid":%d}`, os.Getpid())
	}))
	defer srv.Close()
	port := portOf(t, srv)
	var out bytes.Buffer
	launch(options{port: port, paths: paths(t)}, nil, &out)
	if got, want := out.String(), fmt.Sprintf("http://127.0.0.1:%d/\n", port); got != want {
		t.Fatalf("launch wrote %q, want %q", got, want)
	}
	if h, ok := helloOf(httpClient(), srv.URL); !ok || h.Version != "v0.0.1-old" {
		t.Fatalf("server no longer answers: %+v %v", h, ok)
	}
}

func TestResourcesFor(t *testing.T) {
	for exe, want := range map[string]string{
		"/Applications/AI Whiteboard.app/Contents/MacOS/ai-whiteboard": "/Applications/AI Whiteboard.app/Contents/Resources",
		"/repo/bin/ai-whiteboard":                                      "",
		"/x/Contents/MacOS/ai-whiteboard":                              "", // not inside a .app
		"/x/A.app/Contents/bin/ai-whiteboard":                          "",
	} {
		if got := resourcesFor(exe); got != want {
			t.Errorf("resourcesFor(%q) = %q, want %q", exe, got, want)
		}
	}
}

func TestUsePath(t *testing.T) {
	t.Setenv("PATH", "/usr/bin:/bin:/extra")
	usePath("/opt/homebrew/bin:/usr/bin")
	if got, want := os.Getenv("PATH"), "/opt/homebrew/bin:/usr/bin:/bin:/extra"; got != want {
		t.Errorf("PATH = %q, want %q", got, want)
	}
	usePath("")
	if got, want := os.Getenv("PATH"), "/opt/homebrew/bin:/usr/bin:/bin:/extra"; got != want {
		t.Errorf("empty login PATH changed PATH to %q", got)
	}
}
