package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/server"
	"ai-whiteboard/internal/servers"
)

// ---- a whole server with a scripted agent ---------------------------------------------------

// scriptedServer is a real server process whose agents do what their messages say: a data folder
// with a name of its own, the scripted claude of agenttest as its Claude program, no Cursor and
// no pi.
//
// With AIWB_E2E_RACE=1 in the environment the server itself is built with the race detector (go
// test -race only covers the test's own code), and a race it reports fails the test.
type scriptedServer struct {
	in      *instance
	home    string   // the data folder
	env     []string // more in the server's environment
	fakeLog string   // one JSON line per start of the fake claude and per line it was sent

	cmd    *exec.Cmd
	exited chan struct{}
	out    serverOutput // what the server wrote, also copied to the test's stderr
}

// serverOutput keeps what a server process writes.
type serverOutput struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (o *serverOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	o.b.Write(p)
	o.mu.Unlock()
	return os.Stderr.Write(p)
}

func (o *serverOutput) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.b.String()
}

// newScriptedServer builds the program and picks the folders and ports; start runs it. env is
// added to the server's environment.
func newScriptedServer(t *testing.T, env []string) *scriptedServer {
	t.Helper()
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH (the fake claude is a Node script)")
	}
	in := newInstance(t)
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	in.dir = filepath.Join(base, "aiwb-e2e-data")
	in.claude = agenttest.FakeClaude(t)
	in.cursor, in.pi = "/nonexistent/agent", "/nonexistent/pi"
	if os.Getenv("AIWB_E2E_RACE") != "" {
		in.bin = buildRaceBinary(t)
	}
	s := &scriptedServer{in: in, home: in.dir, env: env,
		fakeLog: filepath.Join(t.TempDir(), "fake-claude.jsonl")}
	t.Cleanup(func() {
		s.stop(t)
		// What a server that was killed, or a test that failed half way, left behind.
		if left := s.fakes(t); len(left) > 0 {
			t.Logf("ending %d fake claude processes that were left", len(left))
			s.endFakes(t, left)
		}
	})
	return s
}

// start runs the server and waits until it answers with its own pid.
func (s *scriptedServer) start(t *testing.T) {
	t.Helper()
	cmd := s.in.command(context.Background(), "serve", "-cwd", t.TempDir(), "-cursor-cost", "/nonexistent/cursor-cost")
	cmd.Env = append(append(s.in.environ(), s.env...), "FAKE_CLAUDE_LOG="+s.fakeLog)
	cmd.Stdout, cmd.Stderr = &s.out, &s.out
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	s.cmd, s.exited = cmd, make(chan struct{})
	go func(done chan struct{}) { cmd.Wait(); close(done) }(s.exited)
	for deadline := time.Now().Add(e2eWait); ; time.Sleep(50 * time.Millisecond) {
		if h, ok := helloOf(httpClient(), strings.TrimSuffix(s.in.url, "/")); ok && h.Pid == cmd.Process.Pid {
			return
		}
		select {
		case <-s.exited:
			t.Fatal("the server exited while it started")
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("the server did not answer within %s", e2eWait)
		}
	}
}

// stop ends the server the way a quit does (SIGTERM) and waits for it. It does nothing when the
// server is not running.
func (s *scriptedServer) stop(t *testing.T) {
	t.Helper()
	if s.cmd == nil {
		return
	}
	select {
	case <-s.exited:
	default:
		s.cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-s.exited:
		case <-time.After(20 * time.Second):
			s.cmd.Process.Kill()
			<-s.exited
			t.Error("the server did not exit within 20 s of SIGTERM")
		}
	}
	s.cmd = nil
	if strings.Contains(s.out.String(), "WARNING: DATA RACE") {
		t.Error("the server reported a data race (see its output above)")
	}
}

// kill ends the server the way a crash does (SIGKILL of its own process, nothing else) and waits
// until the process is gone. The agent processes it had started are left running: fakes lists
// them before the kill, endFakes ends them after it.
func (s *scriptedServer) kill(t *testing.T) {
	t.Helper()
	if s.cmd == nil {
		t.Fatal("kill: the server is not running")
	}
	s.cmd.Process.Kill()
	select {
	case <-s.exited:
	case <-time.After(e2eWait):
		t.Fatalf("the server did not exit within %s of SIGKILL", e2eWait)
	}
	s.cmd = nil
}

// fakeProc is a running fake claude process of this server.
type fakeProc struct {
	Pid int
	Cmd string // its command line
}

// agent reports whether the process is a chat's agent: those are started with a session. The
// model-list probe of a server's start is not.
func (p fakeProc) agent() bool {
	return strings.Contains(p.Cmd, " --session-id ") || strings.Contains(p.Cmd, " --resume ")
}

// fakes lists the fake claude processes of this server that are running now: the processes whose
// command line names the server's own copy of the script, which is in this test's temp folder. No
// other process on the machine has that path, so nothing of anyone else's is ever listed. The
// server itself (the path is its -claude flag) and zombies are left out.
func (s *scriptedServer) fakes(t *testing.T) []fakeProc {
	t.Helper()
	out, err := exec.Command("ps", "-axww", "-o", "pid=,stat=,command=").Output()
	if err != nil {
		t.Fatalf("ps: %v", err)
	}
	var procs []fakeProc
	for _, line := range strings.Split(string(out), "\n") {
		pidText, rest, _ := strings.Cut(strings.TrimSpace(line), " ")
		stat, cmd, _ := strings.Cut(strings.TrimSpace(rest), " ")
		cmd = strings.TrimSpace(cmd)
		pid, err := strconv.Atoi(pidText)
		if err != nil || pid <= 1 || strings.HasPrefix(stat, "Z") {
			continue
		}
		if !strings.Contains(cmd, s.in.claude) || strings.HasPrefix(cmd, s.in.bin+" ") {
			continue
		}
		procs = append(procs, fakeProc{Pid: pid, Cmd: cmd})
	}
	return procs
}

// agentFakes is fakes without the processes that are no agent's.
func (s *scriptedServer) agentFakes(t *testing.T) []fakeProc {
	t.Helper()
	return slices.DeleteFunc(s.fakes(t), func(p fakeProc) bool { return !p.agent() })
}

// endFakes kills the given processes, each only while it still is one of this server's fake
// claude processes (a pid may have been given to another process since), and waits until they
// are gone.
func (s *scriptedServer) endFakes(t *testing.T, procs []fakeProc) {
	t.Helper()
	ours := func(pid int) bool {
		return slices.ContainsFunc(s.fakes(t), func(p fakeProc) bool { return p.Pid == pid })
	}
	for _, p := range procs {
		if ours(p.Pid) {
			syscall.Kill(p.Pid, syscall.SIGKILL)
		}
	}
	for deadline := time.Now().Add(e2eWait); ; time.Sleep(50 * time.Millisecond) {
		if !slices.ContainsFunc(procs, func(p fakeProc) bool { return ours(p.Pid) }) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("fake claude processes of %v are still running %s after SIGKILL", procs, e2eWait)
		}
	}
}

// fakeLine is one line of the fake claude's log: the start of a process or a line it was sent
// (Stdin).
type fakeLine struct {
	Pid   int
	Stdin *struct {
		Type    string
		Message struct{ Content []struct{ Text string } }
	}
}

// fakeDirective matches what the fake claude reads as a directive: [[verb …]] up to the next
// "]]", or <<verb …>>.
var fakeDirective = regexp.MustCompile(`\[\[\w+\s*(?:[^\]]|\][^\]])*\]\]|<<\w+\s*[^>]*>>`)

// message is the text of the message the line sent to a process, without its directives: what
// the fake claude's [[if TEXT]] looks at. ok is false for any other line.
func (l fakeLine) message() (text string, ok bool) {
	if l.Stdin == nil || l.Stdin.Type != "user" {
		return "", false
	}
	var parts []string
	for _, c := range l.Stdin.Message.Content {
		parts = append(parts, c.Text)
	}
	return fakeDirective.ReplaceAllString(strings.Join(parts, "\n"), ""), true
}

// fakeLines reads the fake claude's log. A last line that is still being written is left out.
func (s *scriptedServer) fakeLines(t *testing.T) []fakeLine {
	t.Helper()
	b, err := os.ReadFile(s.fakeLog)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var lines []fakeLine
	for _, raw := range bytes.Split(b, []byte("\n")) {
		var l fakeLine
		if len(raw) > 0 && json.Unmarshal(raw, &l) == nil {
			lines = append(lines, l)
		}
	}
	return lines
}

// fakeMessages counts the messages agents were sent, according to the fake claude's log.
func (s *scriptedServer) fakeMessages(t *testing.T) int {
	t.Helper()
	n := 0
	for _, l := range s.fakeLines(t) {
		if _, ok := l.message(); ok {
			n++
		}
	}
	return n
}

// waitFakeMessage waits until a fake claude process has been sent a message that contains text
// outside its directives (the condition of the fake's [[if TEXT]]), not counting the first skip
// messages, and returns the process and the message. The fake logs a message before it carries
// it out, so from here on the process is at its first directive.
func (s *scriptedServer) waitFakeMessage(t *testing.T, skip int, text string) (pid int, message string) {
	t.Helper()
	for deadline := time.Now().Add(e2eWait); ; time.Sleep(20 * time.Millisecond) {
		n := 0
		for _, l := range s.fakeLines(t) {
			msg, ok := l.message()
			if !ok {
				continue
			}
			if n++; n > skip && strings.Contains(msg, text) {
				return l.Pid, msg
			}
		}
		select {
		case <-s.exited:
			t.Fatalf("the server exited before an agent was sent a message with %q", text)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("no agent was sent a message with %q within %s (%d messages so far)", text, e2eWait, n)
		}
	}
}

// call makes one API request as client and returns the status and the body. out, when not nil,
// gets the decoded body of a 200; it is emptied first, so that a field the answer leaves out is
// not left over from an earlier call.
func (s *scriptedServer) call(t *testing.T, client, method, path string, body, out any) (int, string) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, s.in.url+strings.TrimPrefix(path, "/"), rd)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-AIWB-Client", client)
	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if out != nil && resp.StatusCode == http.StatusOK {
		if p := reflect.ValueOf(out); p.Kind() == reflect.Pointer && !p.IsNil() {
			p.Elem().SetZero()
		}
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("%s %s: %v in %s", method, path, err, raw)
		}
	}
	return resp.StatusCode, string(raw)
}

// must is call for a request that has to answer 200.
func (s *scriptedServer) must(t *testing.T, client, method, path string, body, out any) {
	t.Helper()
	if status, raw := s.call(t, client, method, path, body, out); status != http.StatusOK {
		t.Fatalf("%s %s: status %d: %s", method, path, status, raw)
	}
}

// mcp makes one JSON-RPC call on the server's MCP endpoint with a chat's token and returns the
// result (or the error) as text.
func (s *scriptedServer) mcp(t *testing.T, token, method string, params any) string {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	req, _ := http.NewRequest("POST", s.in.mcpURL, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("mcp %s: %v", method, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return string(raw)
}

// mcpTool calls one tool on the server's MCP endpoint with a chat's token and returns the text
// of the answer and whether it is an error.
func (s *scriptedServer) mcpTool(t *testing.T, token, name string, args any) (text string, isErr bool) {
	t.Helper()
	raw := s.mcp(t, token, "tools/call", map[string]any{"name": name, "arguments": args})
	var body struct {
		Result *struct {
			Content []struct{ Text string }
			IsError bool
		}
	}
	if err := json.Unmarshal([]byte(raw), &body); err != nil || body.Result == nil {
		t.Fatalf("tools/call %s: no result in %s", name, raw)
	}
	for _, c := range body.Result.Content {
		text += c.Text
	}
	return text, body.Result.IsError
}

func clipText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// e2eWait is how long a test waits for one step of a server. It is long because the machine may
// be busy; no step takes anywhere near it.
const e2eWait = 90 * time.Second

// ---- a whole server with a remote listener, for an API client -----------------------------------

// apiServer is a scriptedServer with remote access set up on a scratch port, bound on 127.0.0.1:
// the scripted claude is its Claude program, and an API client reaches it over HTTPS with the
// secret and its client id.
type apiServer struct {
	*scriptedServer
	port        int // of the remote listener
	secret, fpr string
	hc          *http.Client // trusts the listener's certificate alone
}

// apiX and apiY are the client ids of the tests' two API clients.
const (
	apiX = testClient
	apiY = "8d3e6b1c-2f4a-4b7d-a9c1-0e5f6a7b8c9d"
)

// up starts the server and waits for its remote listener.
func (a *apiServer) up(t *testing.T) {
	t.Helper()
	a.start(t)
	a.in.waitListening(t)
}

// request makes one call of the API client on the remote listener and returns the status and the
// body. It holds no stream open.
func (a *apiServer) request(ctx context.Context, client, method, path string, body any) (int, []byte, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, fmt.Sprintf("https://127.0.0.1:%d%s", a.port, path), rd)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set(remote.SecretHeader, a.secret)
	req.Header.Set(server.ClientHeader, client)
	req.Header.Set(servers.LevelHeader, testLevel)
	if rd != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.hc.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	return resp.StatusCode, raw, err
}

// api is request for a call that must be answered; out, when not nil, gets the decoded body of
// whatever status came.
func (a *apiServer) api(t *testing.T, client, method, path string, body, out any) (int, string) {
	t.Helper()
	status, raw, err := a.request(context.Background(), client, method, path, body)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("%s %s: status %d, %v in %s", method, path, status, err, raw)
		}
	}
	return status, string(raw)
}
