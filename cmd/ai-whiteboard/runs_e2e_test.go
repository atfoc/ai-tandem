package main

import (
	"bufio"
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
	"ai-whiteboard/internal/model"
)

// ---- a whole server for the tests of runs ---------------------------------------------------

// runServer is a real server process for the tests of runs: a data folder with a name of its own
// (it becomes a part of what the agents may not touch, and a run refuses a folder whose path
// holds it), the scripted claude of agenttest as its Claude program, no Cursor and no pi, and a
// git environment that reads none of the user's config. Its checkouts go next to the data
// folder, inside the test's temp folder.
//
// With AIWB_E2E_RACE=1 in the environment the server itself is built with the race detector (go
// test -race only covers the test's own code), and a race it reports fails the test.
type runServer struct {
	in      *instance
	home    string // the data folder
	work    string // where the checkouts of runs go: <parent of home>/aiwb-run-work
	gitEnv  []string
	fakeLog string // one JSON line per start of the fake claude and per line it was sent

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

// newRunServer builds the program and picks the folders and ports; start runs it. gitEnv is added
// to the server's environment (agenttest.Repo.Env()).
func newRunServer(t *testing.T, gitEnv []string) *runServer {
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
	s := &runServer{in: in, home: in.dir, work: filepath.Join(base, "aiwb-run-work"), gitEnv: gitEnv,
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
func (s *runServer) start(t *testing.T) {
	t.Helper()
	cmd := s.in.command(context.Background(), "serve", "-cwd", t.TempDir(), "-cursor-cost", "/nonexistent/cursor-cost")
	cmd.Env = append(append(s.in.environ(), s.gitEnv...), "FAKE_CLAUDE_LOG="+s.fakeLog)
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
func (s *runServer) stop(t *testing.T) {
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
func (s *runServer) kill(t *testing.T) {
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

// agent reports whether the process is an agent's (a chat's or a run agent's): those are started
// with a session. The model-list probe of a server's start is not.
func (p fakeProc) agent() bool {
	return strings.Contains(p.Cmd, " --session-id ") || strings.Contains(p.Cmd, " --resume ")
}

// fakes lists the fake claude processes of this server that are running now: the processes whose
// command line names the server's own copy of the script, which is in this test's temp folder. No
// other process on the machine has that path, so nothing of anyone else's is ever listed. The
// server itself (the path is its -claude flag) and zombies are left out.
func (s *runServer) fakes(t *testing.T) []fakeProc {
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
func (s *runServer) agentFakes(t *testing.T) []fakeProc {
	t.Helper()
	return slices.DeleteFunc(s.fakes(t), func(p fakeProc) bool { return !p.agent() })
}

// waitNoFakes waits until no fake claude process of this server is running (agents: no agent's
// process, while the server runs and may be asking for its model list); what names the moment in
// the failure. A process that was closed is given the time to go, not more.
func (s *runServer) waitNoFakes(t *testing.T, agents bool, limit time.Duration, what string) {
	t.Helper()
	for deadline := time.Now().Add(limit); ; time.Sleep(50 * time.Millisecond) {
		left := s.fakes(t)
		if agents {
			left = slices.DeleteFunc(left, func(p fakeProc) bool { return !p.agent() })
		}
		if len(left) == 0 {
			return
		}
		if time.Now().After(deadline) {
			var lines []string
			for _, p := range left {
				lines = append(lines, fmt.Sprintf("%d %s", p.Pid, clipText(p.Cmd, 300)))
			}
			t.Fatalf("%s: %d fake claude processes are still running after %s:\n%s", what, len(left), limit, strings.Join(lines, "\n"))
		}
	}
}

// endFakes kills the given processes, each only while it still is one of this server's fake
// claude processes (a pid may have been given to another process since), and waits until they
// are gone.
func (s *runServer) endFakes(t *testing.T, procs []fakeProc) {
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

// fakeLine is one line of the fake claude's log: the start of a process (Start: its arguments,
// Cwd: its working directory) or a line it was sent (Stdin).
type fakeLine struct {
	Pid   int
	Start []string
	Cwd   string
	Stdin *struct {
		Type    string
		Message struct{ Content []struct{ Text string } }
	}
}

// agent reports whether the line is the start of an agent's process (see fakeProc.agent).
func (l fakeLine) agent() bool {
	return slices.Contains(l.Start, "--session-id") || slices.Contains(l.Start, "--resume")
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
func (s *runServer) fakeLines(t *testing.T) []fakeLine {
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
func (s *runServer) fakeMessages(t *testing.T) int {
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
func (s *runServer) waitFakeMessage(t *testing.T, skip int, text string) (pid int, message string) {
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
// gets the decoded body of a 200; it is emptied first, so that a field the answer leaves out (a
// run's reason, say) is not left over from an earlier call.
func (s *runServer) call(t *testing.T, client, method, path string, body, out any) (int, string) {
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
func (s *runServer) must(t *testing.T, client, method, path string, body, out any) {
	t.Helper()
	if status, raw := s.call(t, client, method, path, body, out); status != http.StatusOK {
		t.Fatalf("%s %s: status %d: %s", method, path, status, raw)
	}
}

// mcp makes one JSON-RPC call on the server's MCP endpoint with a chat's token and returns the
// result (or the error) as text.
func (s *runServer) mcp(t *testing.T, token, method string, params any) string {
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

// runEvent is one event of the server's stream.
type runEvent struct {
	Type string
	Raw  json.RawMessage
}

// runEvents is the active client of a test: it holds GET /api/events open and keeps every event.
type runEvents struct {
	Client string
	close  func() // ends the connection, as a client that goes away

	mu   sync.Mutex
	evs  []runEvent
	from int           // wait looks at the events from this one on (skip moves it)
	more chan struct{} // closed and replaced whenever an event arrives
	err  error         // set when the stream ended
}

// follow connects as client, waits for its hello, and keeps reading until the test
// ends (or the server does, or close is called). Like the app's client it tells a server that is
// stopping that it has nothing left to write.
func (s *runServer) follow(t *testing.T, client string) *runEvents {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, "GET", s.in.url+"api/events?client="+client, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	e := &runEvents{Client: client, close: cancel, more: make(chan struct{})}
	go func() {
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(nil, 64<<20)
		for sc.Scan() {
			line, ok := strings.CutPrefix(sc.Text(), "data: ")
			if !ok {
				continue
			}
			var head struct{ Type string }
			if json.Unmarshal([]byte(line), &head) != nil {
				continue
			}
			e.mu.Lock()
			e.evs = append(e.evs, runEvent{Type: head.Type, Raw: json.RawMessage(line)})
			close(e.more)
			e.more = make(chan struct{})
			e.mu.Unlock()
			if head.Type == "server_stopping" {
				// The app's client answers this when it has written its pending changes; a server
				// that gets no answer waits two seconds for it before it goes down.
				go func() {
					req, _ := http.NewRequest("POST", s.in.url+"api/client/flushed", nil)
					req.Header.Set("X-AIWB-Client", client)
					if resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req); err == nil {
						resp.Body.Close()
					}
				}()
			}
		}
		e.mu.Lock()
		e.err = fmt.Errorf("the event stream ended: %v", sc.Err())
		close(e.more)
		e.more = make(chan struct{})
		e.mu.Unlock()
	}()
	e.wait(t, e2eWait, "the client's hello", func(evs []runEvent) bool {
		return slices.ContainsFunc(evs, func(ev runEvent) bool { return ev.Type == "hello" })
	})
	return e
}

// skip makes the waits that follow look only at the events that arrive from now on: a test calls
// it before it asks for a change, so that an earlier event of the same kind does not answer.
func (e *runEvents) skip() {
	e.mu.Lock()
	e.from = len(e.evs)
	e.mu.Unlock()
}

// e2eSnapshot is what a test reads of the `snapshot` event, the state a client gets when it
// becomes the active one.
type e2eSnapshot struct {
	Runs  []model.RunView
	Chats []model.ChatView
}

// snapshot waits for the client's first `snapshot` event and returns it.
func (e *runEvents) snapshot(t *testing.T) e2eSnapshot {
	t.Helper()
	var snap e2eSnapshot
	e.wait(t, e2eWait, "the snapshot", func([]runEvent) bool {
		for _, ev := range e.all() {
			if ev.Type == "snapshot" {
				if err := json.Unmarshal(ev.Raw, &snap); err != nil {
					t.Fatalf("the snapshot: %v in %s", err, clipText(string(ev.Raw), 600))
				}
				return true
			}
		}
		return false
	})
	return snap
}

// all is every event so far.
func (e *runEvents) all() []runEvent {
	e.mu.Lock()
	defer e.mu.Unlock()
	return slices.Clone(e.evs)
}

// of returns the events of one type, decoded into T.
func eventsOf[T any](t *testing.T, e *runEvents, typ string) []T {
	t.Helper()
	var out []T
	for _, ev := range e.all() {
		if ev.Type != typ {
			continue
		}
		var v T
		if err := json.Unmarshal(ev.Raw, &v); err != nil {
			t.Fatalf("event %s: %v in %s", typ, err, ev.Raw)
		}
		out = append(out, v)
	}
	return out
}

// wait blocks until ok holds for the events so far (those after the last skip); what names it in
// the failure.
func (e *runEvents) wait(t *testing.T, limit time.Duration, what string, ok func(evs []runEvent) bool) {
	t.Helper()
	deadline := time.After(limit)
	for {
		e.mu.Lock()
		evs, more, err := slices.Clone(e.evs[e.from:]), e.more, e.err
		e.mu.Unlock()
		if ok(evs) {
			return
		}
		if err != nil {
			t.Fatalf("waiting for %s: %v", what, err)
		}
		select {
		case <-more:
		case <-deadline:
			tail := evs
			if len(tail) > 12 {
				tail = tail[len(tail)-12:]
			}
			var lines []string
			for _, ev := range tail {
				lines = append(lines, clipText(string(ev.Raw), 300))
			}
			t.Fatalf("waiting for %s: nothing after %s. The last events:\n%s", what, limit, strings.Join(lines, "\n"))
		}
	}
}

// waitRun blocks until a view of the run satisfies ok, and returns that view: the view of a `run`
// event, or the one in the `snapshot` of a client that connected when the run was there already.
func (e *runEvents) waitRun(t *testing.T, run string, limit time.Duration, what string, ok func(v model.RunView) bool) model.RunView {
	t.Helper()
	var got model.RunView
	e.wait(t, limit, "run "+run+" "+what, func(evs []runEvent) bool {
		for _, ev := range evs {
			var views []model.RunView
			switch ev.Type {
			case "run":
				var m struct{ Run model.RunView }
				if json.Unmarshal(ev.Raw, &m) == nil {
					views = []model.RunView{m.Run}
				}
			case "snapshot":
				var m e2eSnapshot
				if json.Unmarshal(ev.Raw, &m) == nil {
					views = m.Runs
				}
			}
			for _, v := range views {
				if v.ID == run && ok(v) {
					got = v
					return true
				}
			}
		}
		return false
	})
	return got
}

// waitChat blocks until the chat, which was sent a message after the last skip, has worked on it
// and is ready again. A chat that ends in an error or stopped fails the test.
func (e *runEvents) waitChat(t *testing.T, chat string) {
	t.Helper()
	var bad model.ChatView
	e.wait(t, e2eWait, "chat "+chat+" to answer", func(evs []runEvent) bool {
		busy := false
		for _, ev := range evs {
			var m struct{ Chat model.ChatView }
			if ev.Type != "chat" || json.Unmarshal(ev.Raw, &m) != nil || m.Chat.ID != chat {
				continue
			}
			switch m.Chat.Status {
			case model.StatusReady:
				if busy {
					return true
				}
			case model.StatusError, model.StatusStopped:
				bad = m.Chat
				return true
			default:
				busy = true
			}
		}
		return false
	})
	if bad.ID != "" {
		t.Fatalf("chat %s ended as %s: %s", chat, bad.Status, bad.Error)
	}
}

func clipText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// lastText is the last text an agent wrote in the chat id, read over HTTP (which also starts the
// chat's events for a run agent).
func (s *runServer) lastText(t *testing.T, client, chat string) string {
	t.Helper()
	var got struct{ Items []model.Item }
	s.must(t, client, "GET", "api/chats/"+chat+"/items", nil, &got)
	for i := len(got.Items) - 1; i >= 0; i-- {
		if got.Items[i].Kind == "text" {
			return got.Items[i].Text
		}
	}
	return ""
}

// filesUnder lists the files below dir, relative to it, without what skip names (a folder's base
// name).
func filesUnder(t *testing.T, dir string, skip ...string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && slices.Contains(skip, d.Name()) {
			return filepath.SkipDir
		}
		if !d.IsDir() {
			rel, _ := filepath.Rel(dir, path)
			out = append(out, rel)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// ---- the script of the fake claude -----------------------------------------------------------

// The fake claude does what the message it gets says. A run's goal reaches every orchestrator
// turn and every task, a task's brief reaches its agent and its merge agent, so each part of the
// script is behind an [[if …]] that only that kind of message satisfies:
//
//	"This is turn 1."                          the orchestrator's first turn
//	"Nothing is running and nothing can start" the orchestrator's turn when every task has ended
//	"You have one task."                       a task's work agent
//	"You are resolving a merge conflict"       a merge agent
//
// Inside the JSON of an [[mcp …]] directive the nested ones are spelled <<…>>.
const (
	e2eOnTurn1   = "This is turn 1."
	e2eOnIdle    = "Nothing is running and nothing can start"
	e2eOnTask    = "You have one task."
	e2eOnMerge   = "You are resolving a merge conflict"
	e2eFile      = "shared.txt"
	e2eBefore    = "colour: none\n"
	e2eResolved  = "colour: red and blue"
	e2eBoardTool = "list_boards"
)

// e2eWriter is the brief of a writing task that sets the one line of the shared file to colour.
// Its work agent first asks the endpoint what it may call (and calls what it may not), waits so
// that both writers have branched before either merges, and writes; a merge agent writes the
// line that keeps both. The work costs a cent, the merge three.
func e2eWriter(colour string) string {
	return "Set the colour line of " + e2eFile + " to " + colour + ", and change nothing else in the repository. " +
		"<<if " + e2eOnTask + ">> <<tools>> <<mcp get_run {}>> <<mcp " + e2eBoardTool + " {}>> <<sleep 1.5>> <<write " + e2eFile + " colour: " + colour + ">> <<cost 0.01>> " +
		"<<if " + e2eOnMerge + ">> <<write " + e2eFile + " " + e2eResolved + ">> <<cost 0.03>> <<if>> <<block completed>>"
}

// e2eAddTask is the directive that adds a task with the add_task tool. The brief may hold nested
// directives, spelled <<…>>.
func e2eAddTask(t *testing.T, title, brief, kind string, writes bool, deps ...string) string {
	t.Helper()
	args := map[string]any{"title": title, "brief": brief, "kind": kind, "writes": writes, "tier": "standard", "tier_reason": "A build or a later task checks it."}
	if len(deps) > 0 {
		args["depends_on"] = deps
	}
	b, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	// json.Marshal writes < and > as escapes, and orders a map's keys by name: depends_on (the
	// array) is not the last, so the directive does not end in "]]]".
	js := strings.NewReplacer(`\u003c`, "<", `\u003e`, ">").Replace(string(b))
	if strings.Contains(js, "]]") {
		t.Fatalf("the arguments would end the directive early: %s", js)
	}
	return "[[mcp add_task " + js + "]]"
}

// e2eFinish is the end of every goal here: the turn that starts when nothing is left running
// finishes the run as achieved.
const e2eFinish = "[[if " + e2eOnIdle + "]] " + `[[mcp finish_run {"outcome":"achieved","summary":"Everything the goal asked for is there."}]] [[if]]`

// e2eGoal is the goal of the reference run: two writing tasks that change the same line of one
// file, a reporting task that depends on both, and the end.
func e2eGoal(t *testing.T) string {
	t.Helper()
	return "Paint the shared file in both colours.\n" +
		"[[if " + e2eOnTurn1 + "]] [[tools]] [[cost 0.02]] " +
		`[[mcp set_notes {"notes":"Done means: shared.txt names both colours. T01 and T02 write, T03 reports."}]] ` +
		e2eAddTask(t, "Paint it red", e2eWriter("red"), "implement", true) + " " +
		e2eAddTask(t, "Paint it blue", e2eWriter("blue"), "implement", true) + " " +
		e2eAddTask(t, "Report the colours", "Read "+e2eFile+" and report what its colour line says, without changing anything. <<block completed>>", "verify", false, "T01", "T02") + " " +
		e2eFinish
}

// e2eFileWriter is the brief of a writing task that writes text and a line break to file, after
// directives of its own (before: a sleep, say).
func e2eFileWriter(file, text, before string) string {
	return "Write " + file + ", and change nothing else. " +
		"<<if " + e2eOnTask + ">> " + before + " <<write " + file + " " + text + ">> <<cost 0.01>> <<block completed>>"
}

// The run that the stop, quit and crash tests halt in the middle: one writing task whose agent
// waits e2eSlow seconds before it writes, every time it is launched. The fake logs the message
// before it starts to wait, and a test acts at once when it sees that line, so the halt arrives
// while the agent works; the agent that is launched again after the halt waits once more, in
// full, so the wait is what these tests take longest over. The halt is there within some 0.1 s of
// the line on a machine that runs a dozen of these tests at once (a kill, which first lists the
// processes, is the slowest), so 3 s leave it thirty times that.
const (
	e2eSlow     = "3" // seconds
	e2eNote     = "note.txt"
	e2eNoteText = "the note of the run"
)

func e2eSlowGoal(t *testing.T) string {
	t.Helper()
	return "Write the note.\n" +
		"[[if " + e2eOnTurn1 + "]] " +
		`[[mcp set_notes {"notes":"Done means: note.txt holds the note. T01 writes it."}]] ` +
		e2eAddTask(t, "Write the note", e2eFileWriter(e2eNote, e2eNoteText, "<<sleep "+e2eSlow+">>"), "implement", true) + " " +
		e2eFinish
}

// e2eWait is how long a test waits for one step of a server or of a run. It is long because the
// machine may be busy; no step takes anywhere near it.
const e2eWait = 90 * time.Second

// e2eGone is how long a process that was closed may take to be gone.
const e2eGone = 15 * time.Second

// newRun makes a run named name in the folder cwd, starts it with goal, and returns its id.
func (s *runServer) newRun(t *testing.T, client, name, cwd, goal string) string {
	t.Helper()
	var v model.RunView
	s.must(t, client, "POST", "api/runs", map[string]any{"group": model.Ungrouped, "name": name}, &v)
	run := v.ID
	s.must(t, client, "PATCH", "api/runs/"+run, map[string]any{"cwd": cwd, "tiers": tiersOn("haiku"), "settings": map[string]any{"maxTurns": 12}}, &v)
	if v.Blocked != "" || v.Cwd != cwd || v.FolderMissing {
		t.Fatalf("the run in %s: %+v", cwd, v)
	}
	s.must(t, client, "POST", "api/runs/"+run+"/start", map[string]any{"goal": goal}, &v)
	if v.Status != model.RunRunning {
		t.Fatalf("the started run: %+v", v)
	}
	return run
}

// detail is GET /api/runs/{id}/detail.
func (s *runServer) detail(t *testing.T, client, run string) model.RunDetail {
	t.Helper()
	var d model.RunDetail
	s.must(t, client, "GET", "api/runs/"+run+"/detail", nil, &d)
	return d
}

// waitCompleted waits until the run is no longer live, and returns its view and its detail. The
// run must have ended completed, with the outcome achieved; else the test fails with the detail.
func (s *runServer) waitCompleted(t *testing.T, ev *runEvents, run string) (model.RunView, model.RunDetail) {
	t.Helper()
	done := ev.waitRun(t, run, e2eWait, "to end", func(v model.RunView) bool { return !v.Status.Live() && v.Status != model.RunDraft })
	d := s.detail(t, ev.Client, run)
	if done.Status != model.RunCompleted || done.Outcome != model.Achieved || d.Status != model.RunCompleted {
		b, _ := json.MarshalIndent(d, "", " ")
		t.Fatalf("the run ended as %s (%s), outcome %q; its detail:\n%s", done.Status, done.Reason, done.Outcome, b)
	}
	return done, d
}

// stopClean stops the server and checks that none of its fake claude processes is left.
func (s *runServer) stopClean(t *testing.T) {
	t.Helper()
	s.stop(t)
	s.waitNoFakes(t, false, e2eGone, "after the server stopped")
}

// ---- the test ----------------------------------------------------------------------------------

// A whole run on a whole server: the orchestrator's first turn sets the notes and adds two
// writing tasks that change the same line and a reporting task that depends on both; the second
// writer to merge conflicts, a merge agent resolves it; the last turn finishes the run, and its
// result is applied to the person's folder.
func TestRunEndToEnd(t *testing.T) {
	serverTest(t, "TestRunE2ENoGit (a whole server and a run) (this package)", "TestMergeConflictResolvedByAgent (internal/runs)")
	repo := agenttest.NewRepo(t)
	repo.Write(e2eFile, e2eBefore)
	base := repo.Commit("the shared file")
	srv := newRunServer(t, repo.Env())
	srv.start(t)
	const client = "run-e2e-test"
	ev := srv.follow(t, client)

	// A run in the repository, started with the scripted goal.
	var v model.RunView
	srv.must(t, client, "POST", "api/runs", map[string]any{"group": model.Ungrouped, "name": "Both colours"}, &v)
	run := v.ID
	if v.Status != model.RunDraft || v.Agent != model.Claude || v.Tiers.Deep.Model == "" {
		t.Fatalf("the new run: %+v", v)
	}
	srv.must(t, client, "PATCH", "api/runs/"+run, map[string]any{"cwd": repo.Dir(), "tiers": tiersOn("haiku"), "settings": map[string]any{"maxTurns": 12}}, &v)
	if !v.Git || v.Blocked != "" || v.Cwd != repo.Dir() || v.Settings.MaxTurns != 12 {
		t.Fatalf("the run in the repository: %+v", v)
	}
	// The client has the run open: reading its detail makes it follow the run, so that it is sent
	// every run_detail event from the first. A draft has no detail to give yet.
	if code, body := srv.call(t, client, "GET", "api/runs/"+run+"/detail", nil, nil); code != http.StatusConflict {
		t.Fatalf("the detail of a draft: %d %s", code, body)
	}
	started := time.Now()
	srv.must(t, client, "POST", "api/runs/"+run+"/start", map[string]any{"goal": e2eGoal(t)}, &v)
	if v.Status != model.RunRunning || v.Started.IsZero() || v.Draft != nil || !v.Git {
		t.Fatalf("the started run: %+v", v)
	}

	done := ev.waitRun(t, run, 60*time.Second, "to end", func(v model.RunView) bool { return !v.Status.Live() && v.Status != model.RunDraft })
	t.Logf("the run ended as %s after %s, %d turns", done.Status, time.Since(started).Round(100*time.Millisecond), done.Turns)
	var d model.RunDetail
	srv.must(t, client, "GET", "api/runs/"+run+"/detail", nil, &d)
	if done.Status != model.RunCompleted || done.Outcome != model.Achieved {
		b, _ := json.MarshalIndent(d, "", " ")
		t.Fatalf("the run ended as %s (%s), outcome %q; its detail:\n%s", done.Status, done.Reason, done.Outcome, b)
	}
	if done.Counts.Done != 3 || done.Counts.Failed+done.Counts.Cancelled != 0 {
		t.Errorf("the tasks by state: %+v", done.Counts)
	}

	// The detail's versions arrived in order, one event per entry, and the last is the detail's.
	type detailEvent struct {
		Run     string
		Version int64
	}
	var versions []int64
	for _, e := range eventsOf[detailEvent](t, ev, "run_detail") {
		if e.Run == run {
			versions = append(versions, e.Version)
		}
	}
	for i, n := range versions {
		if n != int64(i+1) {
			t.Fatalf("run_detail versions are not 1, 2, 3, …: %v", versions)
		}
	}
	// The run's end is the last entry; the event of it may still be on its way.
	ev.wait(t, 10*time.Second, "the last run_detail event", func([]runEvent) bool {
		es := eventsOf[detailEvent](t, ev, "run_detail")
		return len(es) > 0 && es[len(es)-1].Version >= d.Version
	})
	if d.Version < int64(len(versions)) || d.Status != model.RunCompleted || d.Result == nil || d.Result.Outcome != model.Achieved {
		t.Errorf("the detail: version %d after %d events, status %s, result %+v", d.Version, len(versions), d.Status, d.Result)
	}

	// Every task is done; exactly one of the writers met a conflict, and a merge agent resolved it.
	if len(d.Tasks) != 3 {
		t.Fatalf("%d tasks, want 3", len(d.Tasks))
	}
	conflicts := 0
	for _, task := range d.Tasks {
		if len(task.Attempts) != 1 || task.Attempts[0].Outcome != model.TaskDone {
			t.Errorf("task %s: %+v", task.ID, task.Attempts)
			continue
		}
		a := task.Attempts[0]
		switch {
		case !task.Writes:
			if a.Head != "" || a.Merged != "" || a.Agents.Merge != "" {
				t.Errorf("the reporting task %s has changes: %+v", task.ID, a)
			}
		case a.Head == "" || a.Merged == "":
			t.Errorf("the writing task %s is not merged: %+v", task.ID, a)
		case len(a.Conflicts) > 0:
			conflicts++
			if !slices.Equal(a.Conflicts, []string{e2eFile}) || a.Agents.Merge == "" || d.Agents[a.Agents.Merge].Status != model.AgentDone {
				t.Errorf("the conflict of %s: %v, merge agent %+v", task.ID, a.Conflicts, d.Agents[a.Agents.Merge])
			}
		}
	}
	if conflicts != 1 {
		t.Errorf("%d writers met a conflict, want 1", conflicts)
	}
	if len(d.Notes) != 1 || len(d.Turns) < 2 || d.Turns[0].Reason != "start" || d.Turns[len(d.Turns)-1].Status != "done" {
		t.Errorf("notes %+v, turns %+v", d.Notes, d.Turns)
	}

	// What the agents cost, as each process reported it: two cents for the first turn, one for
	// each writer, three for the merge, nothing for the rest.
	cost := func(c *float64) int {
		if c == nil {
			return -1
		}
		return int(*c*10000 + 0.5)
	}
	if got := cost(done.Cost); got != 700 || done.CostPartial {
		t.Errorf("the run's cost: %v (partial %v), want 0.07", done.Cost, done.CostPartial)
	}
	if got := cost(d.Agents[d.Turns[0].Agent].Cost); got != 200 {
		t.Errorf("the first turn's cost: %d/10000, want 0.02", got)
	}
	for _, task := range d.Tasks {
		a := task.Attempts[0]
		want := 0
		if task.Writes {
			want = 100
		}
		if got := cost(d.Agents[a.Agents.Work].Cost); got != want {
			t.Errorf("the cost of %s's work agent: %d/10000, want %d", task.ID, got, want)
		}
		if a.Agents.Merge != "" {
			want += 300
			if got := cost(d.Agents[a.Agents.Merge].Cost); got != 300 {
				t.Errorf("the cost of %s's merge agent: %d/10000, want 300", task.ID, got)
			}
		}
		if got := cost(a.Cost); got != want {
			t.Errorf("the cost of %s: %d/10000, want %d", task.ID, got, want)
		}
	}

	// The result has both tasks' work and no conflict marker.
	branch := "aiwb/" + run + "/integration"
	if d.Git == nil || d.Git.IntegrationBranch != branch || d.Git.BaseRef != base || d.Git.ResultHead == "" || d.Git.ResultHead == base || d.Git.Branch != "main" {
		t.Fatalf("the detail's git: %+v, want base %s, branch %s and a result", d.Git, base, branch)
	}
	result := d.Git.ResultHead
	log := repo.Git("log", "--format=%s", result)
	for _, want := range []string{"Merge T01: Paint it red", "Merge T02: Paint it blue", "the shared file"} {
		if !strings.Contains(log, want) {
			t.Errorf("git log of the result has no %q:\n%s", want, log)
		}
	}
	for _, task := range d.Tasks {
		if a := task.Attempts[0]; task.Writes && a.Head != "" {
			if _, err := repo.GitIn(repo.Dir(), "merge-base", "--is-ancestor", a.Head, result); err != nil {
				t.Errorf("the commit of %s (%s) is not in the result", task.ID, a.Head)
			}
		}
	}
	if got := repo.Git("show", result+":"+e2eFile); got != e2eResolved {
		t.Errorf("%s of the result: %q, want %q", e2eFile, got, e2eResolved)
	}
	if out, err := repo.GitIn(repo.Dir(), "grep", "-n", "-e", "^<<<<<<<", "-e", "^>>>>>>>", "-e", "^=======$", result, "--"); err == nil {
		t.Errorf("conflict markers in the result:\n%s", out)
	}
	// The result is in the person's folder: its branch is at the result, nothing is uncommitted,
	// the file holds both colours, the run says so, and no branch of the run is left.
	if done.Delivery != model.DeliveryApplied {
		t.Errorf("the view's delivery when the run ended: %q", done.Delivery)
	}
	e2eApplied(t, srv, repo, client, run, d, "ff")
	if b, err := os.ReadFile(filepath.Join(repo.Dir(), e2eFile)); err != nil || string(b) != e2eResolved+"\n" {
		t.Errorf("the person's %s: %q, %v", e2eFile, b, err)
	}
	// Nothing of the run's state is in the repository folder: its one file, and git's own.
	if got := filesUnder(t, repo.Dir(), ".git"); !slices.Equal(got, []string{e2eFile}) {
		t.Errorf("files in the repository folder: %v", got)
	}

	// Where the chats are: none in chats/, every agent's under the run's folder.
	if ents, _ := os.ReadDir(filepath.Join(srv.home, "chats")); len(ents) != 0 {
		t.Errorf("%d entries in the data folder's chats/, want none", len(ents))
	}
	runDir := filepath.Join(srv.home, "runs", run)
	if len(d.Agents) < 6 { // two turns at least, three work agents, one merge agent
		t.Errorf("%d agents, want at least 6", len(d.Agents))
	}
	for id, a := range d.Agents {
		if _, err := os.Stat(filepath.Join(runDir, "agents", id, "chat.json")); err != nil {
			t.Errorf("the chat of agent %s: %v", a.Name, err)
		}
		if a.Status != model.AgentDone {
			t.Errorf("agent %s is %s", a.Name, a.Status)
		}
	}
	for _, name := range []string{"run.json", "journal.jsonl", "state.json", "goal.md"} {
		if _, err := os.Stat(filepath.Join(runDir, name)); err != nil {
			t.Errorf("the run's folder: %v", err)
		}
	}
	// The snapshot lists the run and none of its agents' chats.
	var snap struct {
		Runs  []model.RunView
		Chats []model.ChatView
	}
	srv.must(t, client, "GET", "api/state", nil, &snap)
	if len(snap.Runs) != 1 || snap.Runs[0].ID != run || snap.Runs[0].Status != model.RunCompleted || len(snap.Chats) != 0 {
		t.Errorf("the snapshot: runs %+v, chats %+v", snap.Runs, snap.Chats)
	}

	// What the endpoint listed and refused, per role. The orchestrator's first turn printed its
	// tools/list; so did every writer, which then called a run tool and a board tool.
	orch := srv.lastText(t, client, d.Turns[0].Agent)
	if want := "tools -> [get_run, get_task, get_agent, get_notes, set_notes, edit_notes, add_task, update_task, cancel_task, retry_task, wait_for, finish_run]"; !strings.Contains(orch, want) {
		_, tail, _ := strings.Cut(orch, "\ntools ->")
		t.Errorf("the orchestrator's tools/list is not the twelve orchestrator tools:\ntools ->%s", clipText(tail, 400))
	}
	for _, id := range []string{"T01", "T02"} {
		var rep model.AttemptReport
		srv.must(t, client, "GET", "api/runs/"+run+"/tasks/"+id+"/attempts/1/report", nil, &rep)
		for _, want := range []string{
			"tools -> [spawn_subagent, stop_subagent, list_subagent_models]",
			"get_run -> get_run is not available to this agent",
			e2eBoardTool + " -> " + e2eBoardTool + " is not available on this chat",
			"write " + e2eFile + " -> written",
		} {
			if !strings.Contains(rep.Report, want) {
				t.Errorf("the report of %s has no %q:\n%s", id, want, rep.Report)
			}
		}
		if rep.Outcome != "completed" {
			t.Errorf("the report of %s: outcome %q", id, rep.Outcome)
		}
	}

	// The checkouts are gone when the run has ended; nothing of the run is left running.
	if ents, _ := os.ReadDir(filepath.Join(srv.work, run)); len(ents) != 0 {
		var names []string
		for _, e := range ents {
			names = append(names, e.Name())
		}
		t.Errorf("checkouts left in %s: %v", filepath.Join(srv.work, run), names)
	}
	if trees := repo.Git("worktree", "list", "--porcelain"); strings.Count(trees, "worktree ") != 1 {
		t.Errorf("work trees left in the repository:\n%s", trees)
	}
	srv.stop(t)
	if out, _ := exec.Command("pgrep", "-f", srv.in.claude).Output(); strings.TrimSpace(string(out)) != "" {
		t.Errorf("fake claude processes left after the server stopped: %s", strings.Join(strings.Fields(string(out)), " "))
	}
	t.Logf("%d agents, %d journal entries, %s", len(d.Agents), d.Version, strconv.Quote(strings.ReplaceAll(log, "\n", " | ")))
}

// e2eApplied checks that the result of the ended run is in the person's folder: the detail d and
// the view say applied with how, the folder's branch main is at the result with nothing
// uncommitted, and the repository has no branch and no work tree of the run. The branches go
// after the entry that ends the run, so they are waited for.
func e2eApplied(t *testing.T, srv *runServer, repo *agenttest.Repo, client, run string, d model.RunDetail, how string) {
	t.Helper()
	del := d.Delivery
	if del == nil || del.State != model.DeliveryApplied || del.How != how || del.Result != d.Git.ResultHead || del.Branch != "main" || del.Partial || del.At == 0 {
		t.Fatalf("the detail's delivery: %+v, want applied (%s) of %s", del, how, d.Git.ResultHead)
	}
	var v model.RunView
	srv.must(t, client, "GET", "api/runs/"+run, nil, &v)
	if v.Delivery != model.DeliveryApplied {
		t.Errorf("the view's delivery: %q", v.Delivery)
	}
	head, cur := repo.Git("rev-parse", "main"), repo.Git("rev-parse", "--abbrev-ref", "HEAD")
	if head != del.Commit || cur != "main" || (how == "ff") != (head == d.Git.ResultHead) {
		t.Errorf("the person's branch: main is %s, HEAD is on %q; the delivery's commit is %s, the result %s", head, cur, del.Commit, d.Git.ResultHead)
	}
	if _, err := repo.GitIn(repo.Dir(), "merge-base", "--is-ancestor", d.Git.ResultHead, "main"); err != nil {
		t.Errorf("the result %s is not in the person's branch", d.Git.ResultHead)
	}
	if st := repo.Git("status", "--porcelain"); st != "" {
		t.Errorf("the person's work tree is not clean after the result was applied:\n%s", st)
	}
	left := ""
	for deadline := time.Now().Add(e2eGone); ; time.Sleep(50 * time.Millisecond) {
		if left = repo.Git("for-each-ref", "--format=%(refname:short)", "refs/heads/aiwb/"+run+"/"); left == "" || time.Now().After(deadline) {
			break
		}
	}
	if left != "" {
		t.Errorf("branches of the run left after its result was applied:\n%s", left)
	}
	if trees := repo.Git("worktree", "list", "--porcelain"); strings.Count(trees, "worktree ") != 1 {
		t.Errorf("work trees left in the repository:\n%s", trees)
	}
	if ents, _ := os.ReadDir(filepath.Join(srv.work, run)); len(ents) != 0 {
		t.Errorf("%d entries left in %s", len(ents), filepath.Join(srv.work, run))
	}
}

// The automatic apply is blocked by a file of the person's that is in the way: the run ends
// completed with the folder exactly as it was and the result on its branch; the dry run and an
// Apply say the same; when the person has moved the file, Apply brings the result in, and a
// server that starts again still says so.
func TestRunE2EApplyAfterBlocked(t *testing.T) {
	serverTest(t, "TestDeliverBlockedThenApply (internal/runs)", "TestRunApplyRefusalsAndNoGit (internal/server)")
	repo, base := e2eNoteRepo(t)
	srv := newRunServer(t, repo.Env())
	srv.start(t)
	const client = "run-e2e-apply"
	ev := srv.follow(t, client)
	// The person's own file, not committed, where the run will write its note.
	const mine = "the person's own note\n"
	if err := os.WriteFile(filepath.Join(repo.Dir(), e2eNote), []byte(mine), 0o644); err != nil {
		t.Fatal(err)
	}
	goal := "Write the note.\n" +
		"[[if " + e2eOnTurn1 + "]] " +
		`[[mcp set_notes {"notes":"Done means: note.txt holds the note. T01 writes it."}]] ` +
		e2eAddTask(t, "Write the note", e2eFileWriter(e2eNote, e2eNoteText, ""), "implement", true) + " " +
		e2eFinish
	run := srv.newRun(t, client, "Apply by hand", repo.Dir(), goal)
	done, d := srv.waitCompleted(t, ev, run)

	// Blocked: the folder is as it was, the result is on the integration branch.
	branch := "aiwb/" + run + "/integration"
	blocked := func(when string, del *model.RunDelivery, auto bool) {
		t.Helper()
		if del == nil || del.State != model.DeliveryBlocked || del.Reason != "local_changes" || !slices.Equal(del.Files, []string{e2eNote}) ||
			del.Auto != auto || del.Result != d.Git.ResultHead || del.Branch != "main" || del.Commit != "" {
			t.Fatalf("%s: the delivery is %+v, want blocked by %s", when, del, e2eNote)
		}
		if b, err := os.ReadFile(filepath.Join(repo.Dir(), e2eNote)); err != nil || string(b) != mine {
			t.Fatalf("%s: the person's %s: %q, %v", when, e2eNote, b, err)
		}
		if head, st := repo.Git("rev-parse", "main"), repo.Git("status", "--porcelain"); head != base || st != "?? "+e2eNote {
			t.Fatalf("%s: main is %s (was %s), status %q", when, head, base, st)
		}
		if got := repo.Git("rev-parse", branch); got != d.Git.ResultHead || got == base {
			t.Fatalf("%s: %s is at %s, the result is %s", when, branch, got, d.Git.ResultHead)
		}
	}
	if done.Delivery != model.DeliveryBlocked {
		t.Errorf("the view's delivery when the run ended: %q", done.Delivery)
	}
	blocked("when the run ended", d.Delivery, true)
	if trees := repo.Git("worktree", "list", "--porcelain"); strings.Count(trees, "worktree ") != 1 {
		t.Errorf("work trees left in the repository:\n%s", trees)
	}
	var del model.RunDelivery
	srv.must(t, client, "GET", "api/runs/"+run+"/delivery", nil, &del)
	blocked("the dry run", &del, false)
	if got := srv.detail(t, client, run); got.Version != d.Version {
		t.Errorf("the dry run wrote an entry: version %d, was %d", got.Version, d.Version)
	}
	srv.must(t, client, "POST", "api/runs/"+run+"/apply", map[string]any{}, &del)
	blocked("an apply with the file in the way", &del, false)

	// The person moves the file away; the dry run expects the apply to work, and it does.
	if err := os.Rename(filepath.Join(repo.Dir(), e2eNote), filepath.Join(t.TempDir(), e2eNote)); err != nil {
		t.Fatal(err)
	}
	srv.must(t, client, "GET", "api/runs/"+run+"/delivery", nil, &del)
	if del.State != model.DeliveryPending || del.Reason != "manual" || del.Branch != "main" || del.Result != d.Git.ResultHead {
		t.Fatalf("the dry run with nothing in the way: %+v", del)
	}
	if head, st := repo.Git("rev-parse", "main"), repo.Git("status", "--porcelain"); head != base || st != "" {
		t.Fatalf("the dry run changed the folder: main is %s (was %s), status %q", head, base, st)
	}
	ev.skip()
	srv.must(t, client, "POST", "api/runs/"+run+"/apply", map[string]any{"branch": "main"}, &del)
	if del.State != model.DeliveryApplied || del.How != "ff" || del.Auto || del.Commit != d.Git.ResultHead {
		t.Fatalf("the apply: %+v", del)
	}
	after := srv.detail(t, client, run)
	e2eApplied(t, srv, repo, client, run, after, "ff")
	if b, err := os.ReadFile(filepath.Join(repo.Dir(), e2eNote)); err != nil || string(b) != e2eNoteText+"\n" {
		t.Errorf("the person's %s after the apply: %q, %v", e2eNote, b, err)
	}
	// Clients are told: the view and the detail's patch carry the delivery.
	ev.waitRun(t, run, e2eWait, "to say that its result is applied", func(v model.RunView) bool { return v.Delivery == model.DeliveryApplied })
	type deliveryEvent struct {
		Run   string
		Patch struct{ Delivery *model.RunDelivery }
	}
	ev.wait(t, 10*time.Second, "the run_detail event of the apply", func([]runEvent) bool {
		return slices.ContainsFunc(eventsOf[deliveryEvent](t, ev, "run_detail"), func(e deliveryEvent) bool {
			return e.Run == run && e.Patch.Delivery != nil && e.Patch.Delivery.State == model.DeliveryApplied
		})
	})

	// A server that starts again reads it from the run's folder.
	srv.stop(t)
	srv.start(t)
	srv.follow(t, client)
	again := srv.detail(t, client, run)
	if again.Delivery == nil || again.Delivery.State != model.DeliveryApplied || again.Delivery.Commit != del.Commit || again.Delivery.At != del.At {
		t.Errorf("the delivery after a restart: %+v, want %+v", again.Delivery, del)
	}
	srv.must(t, client, "POST", "api/runs/"+run+"/apply", nil, &del)
	if del.State != model.DeliveryApplied || del.How != "ff" || srv.detail(t, client, run).Version != again.Version {
		t.Errorf("a second apply: %+v", del)
	}
	srv.stopClean(t)
}

// ---- halts in the middle of a run -----------------------------------------------------------

// e2eNoteRepo is a repository with one commit for a run of e2eSlowGoal; base is that commit.
func e2eNoteRepo(t *testing.T) (repo *agenttest.Repo, base string) {
	t.Helper()
	repo = agenttest.NewRepo(t)
	repo.Write("README.md", "a repository\n")
	return repo, repo.Commit("the start")
}

// e2eHaltedAtWork checks the detail of a run of e2eSlowGoal that is halted, by a stop of reason,
// while the agent of its one task worked: the stop is open, the task's attempt has not ended, its
// agent is interrupted after one launch, and no agent is recorded as running.
func e2eHaltedAtWork(t *testing.T, d model.RunDetail, reason model.StopReason) {
	t.Helper()
	if d.Status != model.RunStopped || len(d.Stops) != 1 || d.Stops[0].Reason != reason || d.Stops[0].At == 0 || d.Stops[0].ResumedAt != 0 {
		t.Errorf("the halted run: status %s, stops %+v; want stopped and one open stop of reason %s", d.Status, d.Stops, reason)
	}
	if len(d.Tasks) != 1 || len(d.Tasks[0].Attempts) != 1 {
		t.Fatalf("the halted run's tasks: %+v", d.Tasks)
	}
	a := d.Tasks[0].Attempts[0]
	work := d.Agents[a.Agents.Work]
	if a.Outcome != "" || work.Status != model.AgentInterrupted || len(work.Launches) != 1 || work.Launches[0].EndedAt == 0 {
		t.Fatalf("the halt did not come while the task's agent worked: attempt outcome %q, agent %+v", a.Outcome, work)
	}
	for _, ag := range d.Agents {
		if ag.Status == model.AgentRunning {
			t.Errorf("agent %s is recorded as running in a halted run", ag.Name)
		}
	}
}

// e2eNoteDone checks the end of a run of e2eSlowGoal that was halted once, by a stop of reason,
// while its task's agent worked, and went on: one stop that was resumed, the one attempt of the
// task done and merged by an agent that was launched twice, the note in the result and in the
// person's folder, whose branch is at the result, and no checkout or branch of the run left.
func e2eNoteDone(t *testing.T, srv *runServer, repo *agenttest.Repo, client, base, run string, done model.RunView, d model.RunDetail, reason model.StopReason) {
	t.Helper()
	if done.Counts.Done != 1 || done.Counts.Failed+done.Counts.Cancelled != 0 {
		t.Errorf("the tasks by state: %+v", done.Counts)
	}
	if len(d.Stops) != 1 || d.Stops[0].Reason != reason || d.Stops[0].At == 0 || d.Stops[0].ResumedAt < d.Stops[0].At {
		t.Errorf("the run's stops: %+v, want one of reason %s that was resumed", d.Stops, reason)
	}
	if len(d.Tasks) != 1 || len(d.Tasks[0].Attempts) != 1 {
		t.Fatalf("the run's tasks: %+v", d.Tasks)
	}
	a := d.Tasks[0].Attempts[0]
	if a.Outcome != model.TaskDone || a.Head == "" || a.Merged == "" {
		t.Errorf("the task's attempt: %+v", a)
	}
	work := d.Agents[a.Agents.Work]
	if work.Status != model.AgentDone || len(work.Launches) != 2 || work.Launches[0].Error != "" || work.Launches[1].Error != "" {
		t.Errorf("the task's agent: %+v; want done after two launches, the one the halt ended and the one that went on", work)
	}
	for _, ag := range d.Agents {
		if ag.Status != model.AgentDone {
			t.Errorf("agent %s is %s", ag.Name, ag.Status)
		}
	}
	if d.Git == nil || d.Git.BaseRef != base || d.Git.ResultHead == "" {
		t.Fatalf("the detail's git: %+v", d.Git)
	}
	if got := repo.Git("show", d.Git.ResultHead+":"+e2eNote); got != e2eNoteText {
		t.Errorf("%s of the result: %q, want %q", e2eNote, got, e2eNoteText)
	}
	e2eApplied(t, srv, repo, client, run, d, "ff")
	if b, err := os.ReadFile(filepath.Join(repo.Dir(), e2eNote)); err != nil || string(b) != e2eNoteText+"\n" {
		t.Errorf("the person's %s: %q, %v", e2eNote, b, err)
	}
}

// Stop and Resume over HTTP while a task's agent works: the stop answers stopping, the run then
// says stopped and none of its agent processes is left; the resume takes the run to its end.
func TestRunE2EStopResume(t *testing.T) {
	serverTest(t, "TestStopRestartResume (internal/runs)", "TestRunStopResumeAndLimit (internal/server)")
	repo, base := e2eNoteRepo(t)
	srv := newRunServer(t, repo.Env())
	srv.start(t)
	const client = "run-e2e-stop"
	ev := srv.follow(t, client)
	run := srv.newRun(t, client, "Stop and resume", repo.Dir(), e2eSlowGoal(t))
	working, _ := srv.waitFakeMessage(t, 0, e2eOnTask)

	var v model.RunView
	ev.skip()
	srv.must(t, client, "POST", "api/runs/"+run+"/stop", nil, &v)
	if v.Status != model.RunStopping {
		t.Fatalf("the answer of the stop: status %s (%s), want stopping", v.Status, v.Reason)
	}
	stopped := ev.waitRun(t, run, e2eWait, "to stop", func(v model.RunView) bool { return !v.Status.Live() })
	if stopped.Status != model.RunStopped || stopped.Reason == "" {
		t.Fatalf("after the stop the run is %s (%q), want stopped with a reason", stopped.Status, stopped.Reason)
	}
	e2eHaltedAtWork(t, srv.detail(t, client, run), model.StopUser)
	// The server lives on; the run's agent processes do not, the one of the task's agent least.
	srv.waitNoFakes(t, true, e2eGone, "after the run stopped")
	if slices.ContainsFunc(srv.fakes(t), func(p fakeProc) bool { return p.Pid == working }) {
		t.Errorf("the process of the task's agent (%d) is still running after the stop", working)
	}

	ev.skip()
	srv.must(t, client, "POST", "api/runs/"+run+"/resume", nil, &v)
	if v.Status != model.RunRunning || v.Reason != "" {
		t.Fatalf("the answer of the resume: status %s (%q), want running", v.Status, v.Reason)
	}
	done, d := srv.waitCompleted(t, ev, run)
	e2eNoteDone(t, srv, repo, client, base, run, done, d, model.StopUser)
	srv.stopClean(t)
}

// An orderly quit (SIGTERM) while a task's agent works: the server closes its agents and records
// the halt; started again on the same data folder it continues the run by itself, to its end.
func TestRunE2ESigtermContinues(t *testing.T) {
	serverTest(t, "TestRestartAtEveryStep (its orderly quits) (internal/runs)")
	repo, base := e2eNoteRepo(t)
	srv := newRunServer(t, repo.Env())
	srv.start(t)
	const client = "run-e2e-quit"
	ev := srv.follow(t, client)
	run := srv.newRun(t, client, "Quit and continue", repo.Dir(), e2eSlowGoal(t))
	srv.waitFakeMessage(t, 0, e2eOnTask)

	srv.stopClean(t)
	sent := srv.fakeMessages(t)

	// Nobody asks for a resume: the run is running again when the server first answers.
	srv.start(t)
	ev = srv.follow(t, client)
	snap := ev.snapshot(t)
	if len(snap.Runs) != 1 || snap.Runs[0].ID != run || snap.Runs[0].Status != model.RunRunning {
		t.Fatalf("the runs in the snapshot after the restart: %+v; want run %s running", snap.Runs, run)
	}
	done, d := srv.waitCompleted(t, ev, run)
	e2eNoteDone(t, srv, repo, client, base, run, done, d, model.StopAppQuit)
	// The task's agent was sent its instructions again by the server that continued the run.
	if got := srv.fakeMessages(t); got <= sent {
		t.Errorf("%d messages to agents after the restart, %d before it: nothing was launched again", got, sent)
	}
	srv.stopClean(t)
}

// e2eCrashReason is what a run says that the server found live when it started: the server
// before it died without recording a halt.
const e2eCrashReason = "the app ended unexpectedly while the run was working; resume it when you are ready"

// A crash (SIGKILL) while a task's agent works: the next server shows the run stopped with the
// crash sentence and launches nothing; the run goes on when it is resumed.
func TestRunE2EKillWaitsForResume(t *testing.T) {
	serverTest(t, "TestBootAfterCrash, TestBootAfterCrashWaits (internal/runs)")
	repo, base := e2eNoteRepo(t)
	srv := newRunServer(t, repo.Env())
	srv.start(t)
	const client = "run-e2e-crash"
	srv.follow(t, client)
	run := srv.newRun(t, client, "Crash and resume", repo.Dir(), e2eSlowGoal(t))
	working, _ := srv.waitFakeMessage(t, 0, e2eOnTask)

	// What the server has running is recorded before the kill, by pid, and ended after it: a
	// killed server leaves its agents' processes behind.
	orphans := srv.fakes(t)
	if !slices.ContainsFunc(orphans, func(p fakeProc) bool { return p.Pid == working && p.agent() }) {
		t.Fatalf("the process of the task's agent (%d) is not running before the kill: %+v", working, orphans)
	}
	srv.kill(t)
	srv.endFakes(t, orphans)
	srv.waitNoFakes(t, false, e2eGone, "after the crash")
	sent := srv.fakeMessages(t)

	// The next server: the run is stopped, with the crash sentence, in the snapshot and by itself.
	srv.start(t)
	ev := srv.follow(t, client)
	snap := ev.snapshot(t)
	if len(snap.Runs) != 1 || snap.Runs[0].ID != run || snap.Runs[0].Status != model.RunStopped || snap.Runs[0].Reason != e2eCrashReason {
		t.Fatalf("the runs in the snapshot after the crash: %+v; want run %s stopped with %q", snap.Runs, run, e2eCrashReason)
	}
	var v model.RunView
	srv.must(t, client, "GET", "api/runs/"+run, nil, &v)
	if v.Status != model.RunStopped || v.Reason != e2eCrashReason || v.Blocked != "" {
		t.Fatalf("the run after the crash: status %s, reason %q, blocked %q", v.Status, v.Reason, v.Blocked)
	}
	e2eHaltedAtWork(t, srv.detail(t, client, run), model.StopAppQuit)
	// Nothing is launched: the server has started (the run's part of that comes before its first
	// answer) and has sent its snapshot, and no agent has a process or was sent a message.
	if got := srv.fakeMessages(t); got != sent {
		t.Errorf("%d messages to agents after the restart, %d before it: the stopped run launched something", got, sent)
	}
	if left := srv.agentFakes(t); len(left) != 0 {
		t.Errorf("agent processes of a run that waits for its resume: %+v", left)
	}

	ev.skip()
	srv.must(t, client, "POST", "api/runs/"+run+"/resume", nil, &v)
	if v.Status != model.RunRunning || v.Reason != "" {
		t.Fatalf("the answer of the resume: status %s (%q), want running", v.Status, v.Reason)
	}
	// The first message since the crash is the one the resume causes.
	if _, msg := srv.waitFakeMessage(t, sent, ""); !strings.Contains(msg, e2eOnTask) {
		t.Errorf("the first message after the resume is not the task's: %s", clipText(msg, 300))
	}
	done, d := srv.waitCompleted(t, ev, run)
	e2eNoteDone(t, srv, repo, client, base, run, done, d, model.StopAppQuit)
	srv.stopClean(t)
}

// ---- a person's chat on a run -------------------------------------------------------------------

// e2eChatTools is tools/list for a person's chat on a run: the nine run tools of a chat, then
// the spawn family.
var e2eChatTools = []string{"get_run", "get_task", "get_agent", "get_notes", "add_task", "update_task", "cancel_task", "retry_task", "tell_orchestrator",
	"spawn_subagent", "stop_subagent", "list_subagent_models"}

const e2eChatFile = "chat.txt"

// e2eHeldGoal is the goal of a run that stays running until someone cancels its first task: T01
// only waits, far longer than the test runs.
func e2eHeldGoal(t *testing.T) string {
	t.Helper()
	return "Write what the chat asks for.\n" +
		"[[if " + e2eOnTurn1 + "]] " +
		`[[mcp set_notes {"notes":"Done means: the chat's file is written. T01 only waits for the chat."}]] ` +
		e2eAddTask(t, "Wait for the chat", "Wait; change nothing. <<if "+e2eOnTask+">> <<sleep 600>> <<block completed>>", "research", false) + " " +
		e2eFinish
}

// mcpTool calls one tool on the server's MCP endpoint with a chat's token and returns the text
// of the answer and whether it is an error.
func (s *runServer) mcpTool(t *testing.T, token, name string, args any) (text string, isErr bool) {
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

// A person's chat on a run that is going: where it is kept, what it may call and what it is
// refused, a task it adds, and how the snapshot lists it.
func TestRunE2EChatOnRun(t *testing.T) {
	serverTest(t, "TestChatOnARunRoutes (internal/server)", "TestRunChatStorageAndRestart (internal/chats)", "TestToolChatOps (internal/runs)")
	repo, base := e2eNoteRepo(t)
	srv := newRunServer(t, repo.Env())
	srv.start(t)
	const client = "run-e2e-chat"
	ev := srv.follow(t, client)
	run := srv.newRun(t, client, "A chat on the run", repo.Dir(), e2eHeldGoal(t))
	srv.waitFakeMessage(t, 0, e2eOnTask) // T01's agent waits: the run stays running
	var running model.RunView
	srv.must(t, client, "GET", "api/runs/"+run, nil, &running)

	// The chat: no group, no board, no role, the run's folder; kept under the run, not in chats/.
	var chat model.ChatView
	srv.must(t, client, "POST", "api/chats", map[string]any{"agent": "claude", "run": run}, &chat)
	if chat.ID == "" || chat.Run != run || chat.Role != "" || chat.Group != "" || chat.Board != "" || chat.Cwd != repo.Dir() {
		t.Fatalf("the chat on the run: %+v", chat)
	}
	chatDir := filepath.Join(srv.home, "runs", run, "chats", chat.ID)
	var meta struct{ Token, Run string }
	if b, err := os.ReadFile(filepath.Join(chatDir, "chat.json")); err != nil || json.Unmarshal(b, &meta) != nil || meta.Token == "" || meta.Run != run {
		t.Fatalf("the chat's chat.json in %s: %v, token %q, run %q", chatDir, err, meta.Token, meta.Run)
	}

	// What the endpoint lists for the chat's token, and what it refuses it: the orchestrator's two.
	var listed struct {
		Result struct{ Tools []struct{ Name string } }
	}
	if raw := srv.mcp(t, meta.Token, "tools/list", map[string]any{}); json.Unmarshal([]byte(raw), &listed) != nil {
		t.Fatalf("tools/list: %s", raw)
	}
	var names []string
	for _, tool := range listed.Result.Tools {
		names = append(names, tool.Name)
	}
	if !slices.Equal(names, e2eChatTools) {
		t.Errorf("tools/list for the chat: %v\nwant %v", names, e2eChatTools)
	}
	refused := map[string]string{}
	for name, args := range map[string]any{
		"set_notes":  map[string]any{"notes": "the chat's own notes"},
		"finish_run": map[string]any{"outcome": "achieved", "summary": "the chat says so"},
	} {
		text, isErr := srv.mcpTool(t, meta.Token, name, args)
		// The refusal is of the caller, not of the moment: it says whose tool this is.
		if !isErr || !strings.Contains(text, "orchestrator") {
			t.Errorf("%s by the chat: isError %v, %q; want a refusal that names the orchestrator", name, isErr, text)
		}
		refused[name] = text
	}
	if text, isErr := srv.mcpTool(t, meta.Token, e2eBoardTool, map[string]any{}); !isErr {
		t.Errorf("%s by the chat was not refused: %q", e2eBoardTool, text)
	}

	// A message to the chat: its agent lists its tools, reads the run, adds a task, tries the two
	// tools it does not have, and cancels the task that only waits.
	script := "Add a task that writes my file. [[tools]] [[mcp get_run {}]] " +
		e2eAddTask(t, "Write the chat's file", e2eFileWriter(e2eChatFile, "asked for in the chat", ""), "implement", true) + " " +
		`[[mcp set_notes {"notes":"the chat's own notes"}]] [[mcp finish_run {"outcome":"achieved","summary":"the chat says so"}]] ` +
		`[[mcp cancel_task {"id":"T01","reason":"the chat has had its say"}]]`
	ev.skip()
	srv.must(t, client, "POST", "api/chats/"+chat.ID+"/messages", map[string]any{"text": script}, nil)
	ev.waitChat(t, chat.ID)
	reply := srv.lastText(t, client, chat.ID)
	for _, want := range []string{
		"tools -> [" + strings.Join(e2eChatTools, ", ") + "]\n",
		"\nget_run -> Run " + running.Name + ": running",
		"\nadd_task -> ",
		"\nset_notes -> " + refused["set_notes"],
		"\nfinish_run -> " + refused["finish_run"],
		"\ncancel_task -> Cancelled T01.",
	} {
		if !strings.Contains(reply, want) {
			t.Errorf("the chat's reply has no %q:\n%s", want, reply)
		}
	}

	// The task the chat added starts when its reply has ended, and the run goes to its end.
	done, d := srv.waitCompleted(t, ev, run)
	if done.Counts.Done != 1 || done.Counts.Cancelled != 1 || done.Counts.Failed != 0 {
		t.Errorf("the tasks by state: %+v, want one done and one cancelled", done.Counts)
	}
	if len(d.Tasks) != 2 || len(d.Tasks[0].Attempts) != 1 || len(d.Tasks[1].Attempts) != 1 {
		t.Fatalf("the run's tasks: %+v", d.Tasks)
	}
	held, added := d.Tasks[0], d.Tasks[1]
	if a := held.Attempts[0]; a.Outcome != model.TaskCancelled || a.Cancel == nil || a.Cancel.Chat != chat.ID {
		t.Errorf("the task that waited: %+v, want cancelled by chat %s", a, chat.ID)
	}
	if a := added.Attempts[0]; added.ID != "T02" || added.AddedBy != chat.ID || !added.Writes || a.Outcome != model.TaskDone || a.Merged == "" {
		t.Errorf("the task the chat added: %+v, want T02 added by chat %s, done and merged", added, chat.ID)
	}
	if got := repo.Git("show", d.Git.ResultHead+":"+e2eChatFile); got != "asked for in the chat" {
		t.Errorf("%s of the result: %q", e2eChatFile, got)
	}
	// The refused calls changed nothing: the notes are the orchestrator's one version, and the
	// run's result is the orchestrator's.
	if len(d.Notes) != 1 || d.Notes[0].Chat != "" || d.Result == nil || d.Result.Turn == 0 {
		t.Errorf("notes %+v, result %+v; want one version by the orchestrator and its result", d.Notes, d.Result)
	}
	ops := map[string]int{}
	for _, op := range d.ChatOps {
		if op.Chat != chat.ID {
			t.Errorf("an op of another chat: %+v", op)
		}
		if op.Error == "" {
			ops[op.Op]++
		}
	}
	if ops["add_task"] != 1 || ops["cancel_task"] != 1 || ops["set_notes"] != 0 || ops["finish_run"] != 0 {
		t.Errorf("the chat's accepted changes: %v, want one add_task and one cancel_task", ops)
	}

	// Where the chat is: its folder under the run, nothing in chats/, not among the run's agents.
	if st, err := os.Stat(chatDir); err != nil || !st.IsDir() {
		t.Errorf("the chat's folder %s: %v", chatDir, err)
	}
	if ents, _ := os.ReadDir(filepath.Join(srv.home, "runs", run, "chats")); len(ents) != 1 {
		t.Errorf("%d entries in the run's chats/, want the one chat", len(ents))
	}
	if ents, _ := os.ReadDir(filepath.Join(srv.home, "chats")); len(ents) != 0 {
		t.Errorf("%d entries in the data folder's chats/, want none", len(ents))
	}
	if _, ok := d.Agents[chat.ID]; ok {
		t.Errorf("the person's chat is listed among the run's agents")
	}
	// The run's result was applied to the repository: the file the chat asked for is there.
	if d.Git == nil || d.Git.BaseRef != base {
		t.Errorf("the detail's git: %+v, want the base %s", d.Git, base)
	}
	e2eApplied(t, srv, repo, client, run, d, "ff")
	if got := filesUnder(t, repo.Dir(), ".git"); !slices.Equal(got, []string{"README.md", e2eChatFile}) {
		t.Errorf("files in the repository folder: %v", got)
	}

	// A client that connects now gets the run and the chat, with its run, and no agent's chat.
	ev.close()
	snap := srv.follow(t, client+"-again").snapshot(t)
	if len(snap.Runs) != 1 || snap.Runs[0].ID != run || snap.Runs[0].Status != model.RunCompleted {
		t.Errorf("the runs in the snapshot: %+v", snap.Runs)
	}
	if len(snap.Chats) != 1 || snap.Chats[0].ID != chat.ID || snap.Chats[0].Run != run {
		t.Errorf("the chats in the snapshot: %+v; want the one chat on run %s", snap.Chats, run)
	}
	for _, c := range snap.Chats {
		if c.Role != "" {
			t.Errorf("an agent's chat in the snapshot: %s (%s)", c.ID, c.Role)
		}
	}
	srv.stopClean(t)
}

// ---- a run without git ---------------------------------------------------------------------------

// A run in a folder that is no git repository: every agent works in the folder itself, the
// writing tasks one after the other, and the run leaves in it what its tasks wrote and nothing
// else.
//
// This is the test of a whole server that the default set runs too (smokeTest).
func TestRunE2ENoGit(t *testing.T) {
	smokeTest(t)
	// The repository is only here for its environment, which keeps git from the user's config.
	srv := newRunServer(t, agenttest.NewRepo(t).Env())
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(base, "plain-folder")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "kept.txt"), []byte("here before the run\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv.start(t)
	const client = "run-e2e-nogit"
	ev := srv.follow(t, client)

	goal := "Write two files.\n" +
		"[[if " + e2eOnTurn1 + "]] " +
		`[[mcp set_notes {"notes":"Done means: one.txt and two.txt are written. T01 and T02 write, T03 reports."}]] ` +
		e2eAddTask(t, "Write the first file", e2eFileWriter("one.txt", "the first", "<<sleep 0.5>>"), "implement", true) + " " +
		e2eAddTask(t, "Write the second file", e2eFileWriter("sub/two.txt", "the second", "<<sleep 0.5>>"), "implement", true) + " " +
		e2eAddTask(t, "Report the files", "Say which files are there, without changing anything. <<block completed>>", "verify", false, "T01", "T02") + " " +
		e2eFinish
	run := srv.newRun(t, client, "No git", folder, goal)
	var v model.RunView
	srv.must(t, client, "GET", "api/runs/"+run, nil, &v)
	if v.Git || v.Blocked != "" || v.Cwd != folder {
		t.Fatalf("the run in a plain folder: git %v, blocked %q, cwd %s", v.Git, v.Blocked, v.Cwd)
	}

	done, d := srv.waitCompleted(t, ev, run)
	if done.Git || d.Git != nil {
		t.Errorf("a run without git says git: view %v, detail %+v", done.Git, d.Git)
	}
	// Its agents worked in the folder itself: there is nothing to apply.
	if done.Delivery != model.DeliveryNone || d.Delivery == nil || d.Delivery.State != model.DeliveryNone || d.Delivery.Reason != "no_git" {
		t.Errorf("the delivery of a run without git: view %q, detail %+v", done.Delivery, d.Delivery)
	}
	if done.Counts.Done != 3 || done.Counts.Failed+done.Counts.Cancelled != 0 || len(d.Tasks) != 3 {
		t.Fatalf("the tasks by state: %+v (%d tasks)", done.Counts, len(d.Tasks))
	}
	for _, task := range d.Tasks {
		if len(task.Attempts) != 1 || task.Attempts[0].Outcome != model.TaskDone {
			t.Fatalf("task %s: %+v", task.ID, task.Attempts)
		}
		if a := task.Attempts[0]; a.Branch != "" || a.Base != "" || a.Head != "" || a.Merged != "" || a.Agents.Merge != "" {
			t.Errorf("task %s of a run without git has git facts: %+v", task.ID, a)
		}
	}
	// The two writers did not work at the same time.
	if a, b := d.Tasks[0].Attempts[0], d.Tasks[1].Attempts[0]; a.StartedAt < b.EndedAt && b.StartedAt < a.EndedAt {
		t.Errorf("the writing tasks overlapped: T01 %d–%d, T02 %d–%d", a.StartedAt, a.EndedAt, b.StartedAt, b.EndedAt)
	}

	// What is in the folder: what was there, what the tasks wrote, nothing else.
	if got, want := filesUnder(t, folder), []string{"kept.txt", "one.txt", "sub/two.txt"}; !slices.Equal(got, want) {
		t.Errorf("files in the folder: %v, want %v", got, want)
	}
	for name, want := range map[string]string{"kept.txt": "here before the run\n", "one.txt": "the first\n", "sub/two.txt": "the second\n"} {
		if b, err := os.ReadFile(filepath.Join(folder, name)); err != nil || string(b) != want {
			t.Errorf("%s: %q, %v; want %q", name, b, err, want)
		}
	}
	// Every agent of the run worked in the folder itself, and no checkout was made for it.
	agents := 0
	for _, l := range srv.fakeLines(t) {
		if !l.agent() {
			continue
		}
		agents++
		if l.Cwd != folder {
			t.Errorf("an agent's process was started in %s, want %s", l.Cwd, folder)
		}
	}
	if agents < len(d.Agents) || len(d.Agents) < 5 { // two turns at least, three work agents
		t.Errorf("%d agent processes for %d agents, want at least 5 agents and a process for each", agents, len(d.Agents))
	}
	if ents, err := os.ReadDir(srv.work); err == nil && len(ents) != 0 {
		t.Errorf("%d entries in %s for a run without git", len(ents), srv.work)
	}
	if ents, _ := os.ReadDir(filepath.Join(srv.home, "chats")); len(ents) != 0 {
		t.Errorf("%d entries in the data folder's chats/, want none", len(ents))
	}
	srv.stopClean(t)
}

// tiersOn is the PATCH body part that puts every tier of a run on one model.
func tiersOn(id string) map[string]any {
	on := map[string]any{"model": id}
	return map[string]any{"deep": on, "standard": on, "light": on}
}
