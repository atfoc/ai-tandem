package main

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
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
// It also points TMPDIR at a temp folder of its own and removes it at the end: a server whose data
// folder path is long keeps its control socket in a folder aiwb-<16 hex> of the temp folder, and a
// server that a test kills leaves that folder. Here they go with the run, not into the machine's.
// The folder is made directly under /tmp so that its path is short: the macOS temp folder's is not,
// and the fallback path under a long one would be too long for a socket.
//
// The tests that start servers run in parallel, at most agenttest.SpawnBound at once on macOS: they
// mostly wait, and each starts servers and Node processes.
func TestMain(m *testing.M) {
	agenttest.LimitParallel()
	// No test of this package looks for the build before's server on its port, where the owner's
	// own may run: the tests that look for one name the port of a stand-in.
	legacyPort = anyFreePort(nil)
	dir, err := os.MkdirTemp("", "aiwb-cmd-cursor-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Setenv("CURSOR_CONFIG_DIR", dir)
	tmp, err := os.MkdirTemp("/tmp", "aiwb-t-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Setenv("TMPDIR", tmp)
	code := m.Run()
	os.RemoveAll(dir)
	os.RemoveAll(tmp)
	for _, b := range []*builtBinary{&plainBinary, &raceBinary} {
		if b.dir != "" {
			os.RemoveAll(b.dir)
		}
	}
	os.Exit(code)
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
	return anyFreePort(t)
}

// anyFreePort is freePort for TestMain, which has no test: t is nil.
func anyFreePort(t *testing.T) int {
	for {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			if t == nil {
				panic(err)
			}
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
	return store.NewPaths(t.TempDir())
}

func TestExpand(t *testing.T) {
	for in, want := range map[string]string{"~": "/h", "~/.x": "/h/.x", "/abs": "/abs", "rel": "rel"} {
		if got := expand(in, "/h"); got != want {
			t.Errorf("expand(%q) = %q, want %q", in, got, want)
		}
	}
}

// No command means serve, inside an app bundle too.
func TestCommand(t *testing.T) {
	for _, c := range []struct {
		args []string
		cmd  string
		rest int
	}{
		{nil, "serve", 0},
		{[]string{}, "serve", 0},
		{[]string{"-home", "/x"}, "serve", 2},
		{[]string{"serve", "-home", "/x"}, "serve", 2},
		{[]string{"launch"}, "launch", 0},
		{[]string{"launch", "-json"}, "launch", 1},
		{[]string{"relaunch", "-home", "/x"}, "relaunch", 2},
		{[]string{"stop", "-home", "/x"}, "stop", 2},
		{[]string{"status", "-json"}, "status", 1},
	} {
		cmd, rest := command(c.args)
		if cmd != c.cmd || len(rest) != c.rest {
			t.Errorf("command(%q) = %q, %q; want %q with %d args", c.args, cmd, rest, c.cmd, c.rest)
		}
	}
}

// launch passes the server it starts the data folder, and the flags it was given as they were
// given and no others: the server's own defaults stay its own (its working folder is the home
// folder, where launch starts it), and -json is for launch alone.
func TestServeArgs(t *testing.T) {
	t.Parallel()
	o := parseFlags("launch", []string{"-home", "/data/x", "-json", "-claude", "/bin/fake", "-cwd=/work"})
	want := []string{"-home", "/data/x", "-claude=/bin/fake", "-cwd=/work"}
	if !slices.Equal(o.serveArgs, want) || !o.json || o.paths.Root != "/data/x" {
		t.Fatalf("serveArgs %q, json %v, root %q; want %q", o.serveArgs, o.json, o.paths.Root, want)
	}
	o = parseFlags("serve", []string{"-home", "/data/x"})
	if o.json || !slices.Equal(o.serveArgs, []string{"-home", "/data/x"}) {
		t.Fatalf("serve: serveArgs %q, json %v", o.serveArgs, o.json)
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
