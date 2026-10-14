package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/server"
	"ai-whiteboard/internal/store"
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
	reason := "builds the binary and starts servers; the tests of the default set that build the binary and start it are the ones that call smokeTest (harness_test.go)"
	if len(cover) > 0 {
		reason = "builds the binary and starts servers; in the default set: " + strings.Join(cover, "; ")
	}
	testset.SkipUnlessFull(t, reason)
	t.Parallel()
}

// smokeTest is serverTest for the tests of real server processes that the default set runs as
// well, so that whoever works elsewhere in the repository notices when the server no longer builds,
// starts or serves a client. Each is the cheapest test of something that no test without a server
// process covers:
//
//	TestServeOnADataFolderWithRunData        a whole server on a data folder that a build with runs left
//	TestNotSetUpRefusesThenStarts            the start that a missing set-up ends, and then the start
//	TestClientListenerServes                 the client listener of a real server, over HTTPS
//	TestSecretNewReachesAClient              the signal that makes a real server read its secret again, and `secret -new`
//	TestReloadKeepsSecretWhenUnreadable      the same signal, with a secret file that cannot be read
//	TestSetupRemoteScriptRefusesEmptyValues  a script of the server folder, run through sh
func smokeTest(t *testing.T) {
	t.Helper()
	t.Parallel()
}

// The headers of a client of the server, and the level it states: an app of level 6.
const (
	testClient = "5f0c2a7e-3b1d-4c6a-9e2f-7a8b9c0d1e2f"
	testLevel  = "6"
)

// loopbackBind is the hidden test-only override that binds a server's client listener on
// 127.0.0.1: a wildcard bind by a freshly built binary can raise the macOS firewall dialog.
const loopbackBind = "AIWB_REMOTE_BIND=127.0.0.1"

// instance is one data folder and its ports for the process-level tests, and the flags that select
// them. newInstance has set remote access up on port (name 127.0.0.1), as every server must be
// before it starts.
type instance struct {
	bin, dir string
	claude   string // the -claude flag: a program that does not exist, unless a test swaps in a fake
	cursor   string // the -cursor flag, likewise; "" leaves the flag out (`agent` on PATH)
	pi       string // the -pi flag, likewise
	port     int    // the client listener's
	mcpPort  int
	vars     []string // what environ adds to this process's environment: the MCP port, the bind, a Cursor config folder and what setenv added
	mcpURL   string   // http://localhost:<mcpPort>/mcp

	secret, fpr string // after setUp
}

// newBareInstance builds the program (once for the test binary) and picks a temp data folder, a
// free client port and a free MCP port (through the hidden test-only override, see environ). It
// does not set remote access up: a server of it refuses to start. Its servers are stopped in
// cleanup. Its caller has called serverTest (or smokeTest) first.
func newBareInstance(t *testing.T) *instance {
	t.Helper()
	bin := buildBinary(t)
	in := &instance{bin: bin, dir: t.TempDir(), claude: noClaude(t), cursor: filepath.Join(t.TempDir(), "no-agent"), pi: filepath.Join(t.TempDir(), "no-pi"), port: freePort(t), mcpPort: freePort(t)}
	in.vars = []string{"AIWB_MCP_PORT=" + strconv.Itoa(in.mcpPort), "CURSOR_CONFIG_DIR=" + t.TempDir(), loopbackBind}
	in.mcpURL = fmt.Sprintf("http://localhost:%d/mcp", in.mcpPort)
	t.Cleanup(func() {
		in.command(context.Background(), "stop").Run()
		exec.Command("pkill", "-KILL", "-f", "--", "-home "+in.dir).Run()
	})
	return in
}

// newInstance is newBareInstance with remote access set up on the instance's port, with the name
// 127.0.0.1: what `remote setup -port <port> -name 127.0.0.1` makes.
func newInstance(t *testing.T) *instance {
	t.Helper()
	in := newBareInstance(t)
	in.setUp(t)
	return in
}

// setUp makes what `remote setup -port <port> -name 127.0.0.1` makes, and reads the secret and the
// fingerprint it made.
func (in *instance) setUp(t *testing.T) {
	t.Helper()
	if _, err := remote.Setup(in.dir, remote.SetupOptions{Port: in.port, Names: []string{"127.0.0.1"}}); err != nil {
		t.Fatal(err)
	}
	in.secret, in.fpr = secretOf(t, in.dir), fingerprintOf(t, in.dir)
}

func (in *instance) paths() store.Paths { return store.NewPaths(in.dir) }

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

// command is `ai-whiteboard <command> <more> <flags>` with the instance's environment. The
// commands that start a server get the instance's flags; stop and status get -home alone.
func (in *instance) command(ctx context.Context, command string, more ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, in.bin, append(append([]string{command}, more...), in.flagsFor(command)...)...)
	cmd.Env = in.environ()
	return cmd
}

func (in *instance) flagsFor(command string) []string {
	switch command {
	case "stop", "status", "secret", "remote":
		return []string{"-home", in.dir}
	}
	return in.flags()
}

// flags are the flags that select the instance's data folder and agent programs.
func (in *instance) flags() []string {
	flags := []string{"-home", in.dir, "-claude", in.claude, "-pi", in.pi}
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
func (in *instance) run(t *testing.T, command string, more ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	out, err := in.command(ctx, command, more...).Output()
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

// ends runs `ai-whiteboard <command> <flags>`, which must end by itself, and returns its output
// and exit code.
func (in *instance) ends(t *testing.T, command string, more ...string) (stdout, stderr string, code int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var out, errOut bytes.Buffer
	cmd := in.command(ctx, command, more...)
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err := cmd.Run()
	var ee *exec.ExitError
	switch {
	case ctx.Err() != nil:
		t.Fatalf("%s did not end within 60 s\n%s", command, errOut.String())
	case errors.As(err, &ee):
		code = ee.ExitCode()
	case err != nil:
		t.Fatalf("%s: %v", command, err)
	}
	return out.String(), errOut.String(), code
}

// launchJSON runs `launch -json` (or relaunch) and returns the one line it wrote, decoded.
func (in *instance) launchJSON(t *testing.T, command string) launchOut {
	t.Helper()
	out := in.run(t, command, "-json")
	var l launchOut
	if err := json.Unmarshal([]byte(out), &l); err != nil || strings.Count(out, "\n") != 1 {
		t.Fatalf("%s -json wrote %q (%v), want one JSON line", command, out, err)
	}
	return l
}

// exe is the binary's path as a message writes it: symlinks resolved.
func (in *instance) exe(t *testing.T) string {
	t.Helper()
	exe, err := filepath.EvalSymlinks(in.bin)
	if err != nil {
		t.Fatal(err)
	}
	return exe
}

// noServer checks what a start that ended must leave: nothing accepts on the client port and
// there is no server.json and no control socket.
func (in *instance) noServer(t *testing.T) {
	t.Helper()
	if listening(in.port) {
		t.Fatalf("something accepts on the client port %d", in.port)
	}
	in.noServerFiles(t)
}

// noServerFiles checks that there is no server.json and no control socket.
func (in *instance) noServerFiles(t *testing.T) {
	t.Helper()
	for _, name := range []string{"server.json", "control.sock"} {
		if _, err := os.Lstat(filepath.Join(in.dir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s: %v, want none", name, err)
		}
	}
}

// listening reports whether something accepts connections on the local port.
func listening(port int) bool {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// running is findRunning for the instance's data folder.
func (in *instance) running() (runningServer, bool) { return findRunning(in.paths()) }

// waitServing waits up to 60 s for a server of this build to serve its clients, and returns it.
func (in *instance) waitServing(t *testing.T) runningServer {
	t.Helper()
	for deadline := time.Now().Add(60 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if run, ok := in.running(); ok && run.build == thisBuild {
			if st, ok := run.statusOf(); ok && st.Client.Listening {
				return run
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no server serves clients for %s", in.dir)
		}
	}
}

// hello is the running server's hello from the control socket; it must answer.
func (in *instance) hello(t *testing.T) helloReply {
	t.Helper()
	run, ok := in.running()
	if !ok {
		t.Fatalf("no server runs for %s", in.dir)
	}
	return run.hello
}

// helloMap is the whole answer of the control socket's /hello.
func (in *instance) helloMap(t *testing.T) map[string]any {
	t.Helper()
	run, ok := in.running()
	if !ok {
		t.Fatalf("no server runs for %s", in.dir)
	}
	var h map[string]any
	if !controlGet(run.control, "/hello", 5*time.Second, &h) {
		t.Fatal("the control socket does not answer /hello")
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

// ---- a client of the client listener -------------------------------------------------------------

// pinned is a transport that accepts the certificate with this fingerprint alone: it is
// self-signed, so it is pinned and not verified.
func pinned(fingerprint string) *http.Transport {
	return &http.Transport{ForceAttemptHTTP2: true, TLSClientConfig: &tls.Config{
		InsecureSkipVerify: true,
		VerifyConnection: func(cs tls.ConnectionState) error {
			if got := remote.Fingerprint(cs.PeerCertificates[0].Raw); got != fingerprint {
				return fmt.Errorf("the certificate's fingerprint is %s, want %s", got, fingerprint)
			}
			return nil
		},
	}}
}

// base is the client listener's address.
func (in *instance) base() string { return fmt.Sprintf("https://127.0.0.1:%d", in.port) }

// options is how a client with this id reaches the client listener: over HTTPS with the
// certificate pinned, and the secret, its id and its level in their headers.
func (in *instance) options(t *testing.T, id string) bridgetest.Options {
	t.Helper()
	tr := pinned(in.fpr)
	t.Cleanup(tr.CloseIdleConnections)
	return bridgetest.Options{HTTP: &http.Client{Transport: tr},
		Header: map[string]string{server.SecretHeader: in.secret, server.ClientHeader: id, server.LevelHeader: testLevel}}
}

// page opens the event stream of the client id on the client listener.
func (in *instance) page(t *testing.T, id string) *bridgetest.Page {
	t.Helper()
	return bridgetest.ConnectWith(t, in.base(), id, in.options(t, id))
}

// request makes one call of the client on the client listener and returns the status and the
// body. It holds no stream open.
func (in *instance) request(ctx context.Context, client, method, path string, body any) (int, []byte, error) {
	return requestAt(ctx, in.base(), in.fpr, in.secret, client, testLevel, method, path, body)
}

// requestAt is request on a listener at base (https://127.0.0.1:<port>) whose certificate has
// the fingerprint: with the secret, the client id and, when level is not "", its level.
func requestAt(ctx context.Context, base, fingerprint, secret, client, level, method, path string, body any) (int, []byte, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+"/"+strings.TrimPrefix(path, "/"), rd)
	if err != nil {
		return 0, nil, err
	}
	if secret != "" {
		req.Header.Set(server.SecretHeader, secret)
	}
	if client != "" {
		req.Header.Set(server.ClientHeader, client)
	}
	if level != "" {
		req.Header.Set(server.LevelHeader, level)
	}
	if rd != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	tr := pinned(fingerprint)
	defer tr.CloseIdleConnections()
	resp, err := (&http.Client{Transport: tr, Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	return resp.StatusCode, raw, err
}

// call makes one request as client and returns the status and the body. out, when not nil, gets
// the decoded body of a 200; it is emptied first, so that a field the answer leaves out is not
// left over from an earlier call.
func (in *instance) call(t *testing.T, client, method, path string, body, out any) (int, string) {
	t.Helper()
	status, raw, err := in.request(context.Background(), client, method, path, body)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	if out != nil && status == http.StatusOK {
		if p := reflect.ValueOf(out); p.Kind() == reflect.Pointer && !p.IsNil() {
			p.Elem().SetZero()
		}
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("%s %s: %v in %s", method, path, err, raw)
		}
	}
	return status, string(raw)
}

// must is call for a request that has to answer 200.
func (in *instance) must(t *testing.T, client, method, path string, body, out any) {
	t.Helper()
	if status, raw := in.call(t, client, method, path, body, out); status != http.StatusOK {
		t.Fatalf("%s %s: status %d: %s", method, path, status, raw)
	}
}

// activate opens the event stream of the client and waits for its hello. The stream stays open
// until the test ends; the client answers the server's `server_stopping` with the flush, as the
// app does, so that a stop does not wait for it.
func (in *instance) activate(t *testing.T, client string) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, "GET", in.base()+"/api/events?client="+client, nil)
	req.Header.Set(server.SecretHeader, in.secret)
	req.Header.Set(server.ClientHeader, client)
	req.Header.Set(server.LevelHeader, testLevel)
	tr := pinned(in.fpr)
	t.Cleanup(tr.CloseIdleConnections)
	resp, err := (&http.Client{Transport: tr}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("the event stream: status %d", resp.StatusCode)
	}
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
	go in.flushWhenStopping(client, sc) // keeps reading, so the server never blocks on this client
}

// flushWhenStopping reads the rest of client's event stream and, like the app, answers the
// server's `server_stopping` with POST /api/client/flushed: it has no board changes left to write.
// A server that gets no answer waits two seconds for it before it goes down.
func (in *instance) flushWhenStopping(client string, events *bufio.Scanner) {
	for events.Scan() {
		var ev struct{ Type string }
		line, ok := strings.CutPrefix(events.Text(), "data: ")
		if !ok || json.Unmarshal([]byte(line), &ev) != nil || ev.Type != "server_stopping" {
			continue
		}
		go in.request(context.Background(), client, "POST", "/api/client/flushed", map[string]any{})
	}
}

// serverLog is the text of server.log in dir.
func serverLog(t *testing.T, dir string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "server.log"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// sockPath is store.ControlSocketPath for root.
func sockPath(root string) string { return store.ControlSocketPath(root) }

// readServerFile is the data folder's server.json; it must be there.
func readServerFile(t *testing.T, root string) store.ServerFile {
	t.Helper()
	sf, ok := store.ReadServerFile(store.NewPaths(root))
	if !ok {
		t.Fatalf("no server.json in %s", root)
	}
	return sf
}
