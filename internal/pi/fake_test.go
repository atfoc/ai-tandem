package pi

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
)

// Environment variables that turn the test binary into a fake `pi --mode rpc`.
const (
	envScript     = "PI_FAKE_SCRIPT"             // event lines printed the first time a prompt or abort arrives
	envStdin      = "PI_FAKE_STDIN"              // file the fake appends every stdin line to
	envArgs       = "PI_FAKE_ARGS"               // file the fake writes its cwd, arguments and env to
	envStderr     = "PI_FAKE_STDERR"             // text the fake prints to stderr when it exits
	envStartErr   = "PI_FAKE_START_STDERR"       // text the fake prints to stderr when it starts
	envExit       = "PI_FAKE_EXIT"               // set: exit at once (status 3) after the stderr, without reading stdin
	envReplies    = "PI_FAKE_REPLIES"            // JSON map command → {fail, error, data, silent} reply overrides; "command#2" overrides the second call only
	envSession    = "PI_FAKE_SESSION"            // default get_state sessionId
	envChildPid   = "PI_FAKE_CHILD_PID"          // set: start a long-lived child in the fake's group and record both pids
	envHold       = "PI_FAKE_HOLD"               // set: keep running after stdin closes (until killed)
	envPromptOnly = "PI_FAKE_SCRIPT_PROMPT_ONLY" // set: print the script on prompts only, never on aborts
	envEvery      = "PI_FAKE_SCRIPT_EVERY"       // set: print the script on every prompt, not only the first (never on aborts)
	envAtEOF      = "PI_FAKE_SCRIPT_AT_EOF"      // set: print the script when stdin closes, never on a prompt or abort
	envDeafAfter  = "PI_FAKE_DEAF_AFTER"         // a command: once the fake has answered it, it reads nothing more from stdin and stays (until killed)
)

func TestMain(m *testing.M) {
	if os.Getenv(envStdin) != "" {
		helperProcess()
		os.Exit(0)
	}
	fakesExitAtOnce()
	os.Exit(m.Run())
}

// fakesExitAtOnce sets GORACE for the processes the tests start, the fakes: a fake built with -race
// would otherwise sleep 1 s before every exit (the race detector's atexit_sleep_ms). What GORACE
// already holds is kept. The test binary itself read its GORACE when it started, so its own race
// reporting is as it was.
func fakesExitAtOnce() {
	if old := os.Getenv("GORACE"); !strings.Contains(old, "atexit_sleep_ms") {
		os.Setenv("GORACE", strings.TrimSpace(old+" atexit_sleep_ms=0"))
	}
}

// fakeReply is one scripted RPC answer; a zero reply is success with no data. Silent: the fake
// never answers the command.
type fakeReply struct {
	Fail   bool            `json:"fail"`
	Error  string          `json:"error"`
	Data   json.RawMessage `json:"data"`
	Silent bool            `json:"silent"`
}

// helperProcess is the fake pi: it records its invocation, prints the scripted event lines the
// first time a prompt or abort arrives, and answers RPC commands with the scripted replies while
// it keeps running until stdin closes.
func helperProcess() {
	cwd, _ := os.Getwd()
	rec, _ := json.Marshal(map[string]any{
		"cwd": cwd, "args": os.Args[1:],
		"PI_SUBAGENT":          os.Getenv("PI_SUBAGENT"),
		"AI_AGENT":             os.Getenv("AI_AGENT"),
		"PI_MODEL":             os.Getenv("PI_MODEL"),
		"AIWB_CHAT_ID":         os.Getenv("AIWB_CHAT_ID"),
		"AIWB_CHAT_DIR":        os.Getenv("AIWB_CHAT_DIR"),
		"AIWB_PI_BIN":          os.Getenv("AIWB_PI_BIN"),
		"AIWB_BRIDGE_SOCKET":   os.Getenv("AIWB_BRIDGE_SOCKET"),
		"AIWB_BRIDGE_RUN":      os.Getenv("AIWB_BRIDGE_RUN"),
		"AIWB_MODEL":           os.Getenv("AIWB_MODEL"),
		"AIWB_THINKING":        os.Getenv("AIWB_THINKING"),
		"AIWB_APPEND_PROMPT":   os.Getenv("AIWB_APPEND_PROMPT"),
		"AIWB_MCP_CONFIG":      os.Getenv("AIWB_MCP_CONFIG"),
		"AIWB_MCP_CONFIG_FILE": os.Getenv("AIWB_MCP_CONFIG_FILE"),
		"env":                  os.Environ(),
	})
	os.WriteFile(os.Getenv(envArgs), rec, 0o644)

	if msg := os.Getenv(envStartErr); msg != "" {
		fmt.Fprintln(os.Stderr, msg)
	}
	if os.Getenv(envExit) != "" {
		if msg := os.Getenv(envStderr); msg != "" {
			fmt.Fprintln(os.Stderr, msg)
		}
		os.Exit(3)
	}
	if f := os.Getenv(envChildPid); f != "" {
		child := exec.Command("sleep", "300")
		if err := child.Start(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		rec, _ := json.Marshal(map[string]int{"parent": os.Getpid(), "child": child.Process.Pid})
		os.WriteFile(f, rec, 0o644)
	}
	out, err := os.Create(os.Getenv(envStdin))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	defer out.Close()

	replies := map[string]fakeReply{}
	if f := os.Getenv(envReplies); f != "" {
		b, _ := os.ReadFile(f)
		json.Unmarshal(b, &replies)
	}
	var script []string
	if f := os.Getenv(envScript); f != "" {
		b, _ := os.ReadFile(f)
		for _, l := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
			if l != "" {
				script = append(script, l)
			}
		}
	}
	printed := false
	calls := map[string]int{}
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		line := append([]byte(nil), sc.Bytes()...)
		out.Write(append(line, '\n'))
		out.Sync()
		var cmd struct{ Type, ID string }
		if json.Unmarshal(line, &cmd) != nil {
			continue
		}
		every := os.Getenv(envEvery) != ""
		if (cmd.Type == "prompt" || (cmd.Type == "abort" && os.Getenv(envPromptOnly) == "" && !every)) && (!printed || every) && os.Getenv(envAtEOF) == "" {
			printed = true
			for _, l := range script {
				fmt.Fprintln(os.Stdout, l)
			}
		}
		calls[cmd.Type]++
		reply, ok := replies[fmt.Sprintf("%s#%d", cmd.Type, calls[cmd.Type])]
		if !ok {
			reply, ok = replies[cmd.Type]
		}
		if !ok {
			reply = defaultFakeReply(cmd.Type)
		}
		if reply.Silent {
			continue
		}
		resp := map[string]any{"type": "response", "id": cmd.ID, "command": cmd.Type, "success": !reply.Fail}
		if reply.Error != "" {
			resp["error"] = reply.Error
		}
		if reply.Data != nil {
			resp["data"] = reply.Data
		}
		b, _ := json.Marshal(resp)
		os.Stdout.Write(append(b, '\n'))
		if cmd.Type == os.Getenv(envDeafAfter) {
			for {
				time.Sleep(time.Hour)
			}
		}
	}
	if os.Getenv(envAtEOF) != "" {
		for _, l := range script {
			fmt.Fprintln(os.Stdout, l)
		}
	}
	if os.Getenv(envHold) != "" {
		for {
			time.Sleep(time.Hour)
		}
	}
	if msg := os.Getenv(envStderr); msg != "" {
		fmt.Fprintln(os.Stderr, msg)
	}
}

// defaultFakeReply is what the fake answers when a test does not override a command.
func defaultFakeReply(command string) fakeReply {
	session := os.Getenv(envSession)
	if session == "" {
		session = "fake-session"
	}
	switch command {
	case "get_state":
		data, _ := json.Marshal(map[string]any{
			"sessionId": session, "sessionFile": "/tmp/" + session + ".jsonl",
			"model": map[string]any{"provider": "test", "id": "test-model", "name": "Test Model",
				"reasoning": true, "contextWindow": 1000},
		})
		return fakeReply{Data: data}
	case "get_available_models":
		return fakeReply{Data: json.RawMessage(`{"models":[{"id":"test-model","name":"Test Model","provider":"test","reasoning":true,"thinkingLevelMap":{"minimal":null,"medium":"medium"},"contextWindow":1000}]}`)}
	case "get_session_stats":
		return fakeReply{Data: json.RawMessage(`{"contextUsage":{"tokens":300,"contextWindow":1000}}`)}
	}
	return fakeReply{}
}

type fake struct {
	dir   string // the fake's own files
	root  string // the app data root handed to the spawner
	stdin string
	args  string
}

// newFake sets up a fake pi with the given event lines printed on the first prompt or abort.
func newFake(t *testing.T, script ...string) *fake {
	t.Helper()
	dir := t.TempDir()
	f := &fake{dir: dir, root: filepath.Join(dir, "app"),
		stdin: filepath.Join(dir, "stdin.jsonl"), args: filepath.Join(dir, "args.json")}
	scriptPath := filepath.Join(dir, "script.jsonl")
	if err := os.WriteFile(scriptPath, []byte(strings.Join(script, "\n")), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(envScript, scriptPath)
	t.Setenv(envStdin, f.stdin)
	t.Setenv(envArgs, f.args)
	return f
}

// replies overrides the fake's answers per command.
func (f *fake) replies(t *testing.T, replies map[string]fakeReply) {
	t.Helper()
	raw, err := json.Marshal(replies)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(f.dir, "replies.json")
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(envReplies, path)
}

func (f *fake) spawner() *Spawner {
	return &Spawner{Bin: os.Args[0], AppRoot: f.root, Home: f.dir, Prompt: "P"}
}

// spawn starts a chat process and closes it when the test ends.
func spawn(t *testing.T, s *Spawner, o agent.SpawnOptions) agent.Agent {
	t.Helper()
	a, err := s.Spawn(o)
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(a.Close)
	return a
}

// next waits for the next event.
func next(t *testing.T, a agent.Agent) agent.Event {
	t.Helper()
	select {
	case ev, ok := <-a.Events():
		if !ok {
			t.Fatal("events closed")
		}
		return ev
	case <-time.After(10 * time.Second):
		t.Fatal("no event within 10 s")
	}
	return agent.Event{}
}

// waitKind reads until an event of the given kind arrives.
func waitKind(t *testing.T, a agent.Agent, kind agent.EventKind) agent.Event {
	t.Helper()
	for {
		ev := next(t, a)
		if ev.Kind == kind {
			return ev
		}
		if ev.Kind == agent.EvExit {
			t.Fatalf("process exited before event %v: %+v", kind, ev)
		}
	}
}

// readArgs returns what the fake recorded about its invocation.
type invocation struct {
	Cwd          string
	Args         []string
	PiSubagent   string `json:"PI_SUBAGENT"`
	AIAgent      string `json:"AI_AGENT"`
	PiModel      string `json:"PI_MODEL"`
	ChatID       string `json:"AIWB_CHAT_ID"`
	ChatDir      string `json:"AIWB_CHAT_DIR"`
	PiBin        string `json:"AIWB_PI_BIN"`
	BridgeSocket string `json:"AIWB_BRIDGE_SOCKET"`
	BridgeRun    string `json:"AIWB_BRIDGE_RUN"`
	Model        string `json:"AIWB_MODEL"`
	Thinking     string `json:"AIWB_THINKING"`
	AppendPrompt string `json:"AIWB_APPEND_PROMPT"`
	MCPConfig    string `json:"AIWB_MCP_CONFIG"`
	MCPFile      string `json:"AIWB_MCP_CONFIG_FILE"`
	Env          []string
}

// mcpFileConfig checks how the invocation got its MCP config and returns the file's content: the
// path wantPath in AIWB_MCP_CONFIG_FILE, a file only the user can read, no AIWB_MCP_CONFIG, and
// neither the token nor the word "Bearer" in the arguments or the environment.
func (inv invocation) mcpFileConfig(t *testing.T, wantPath, token string) string {
	t.Helper()
	if inv.MCPConfig != "" {
		t.Errorf("AIWB_MCP_CONFIG is set: %q", inv.MCPConfig)
	}
	if inv.MCPFile != wantPath {
		t.Fatalf("AIWB_MCP_CONFIG_FILE = %q, want %q", inv.MCPFile, wantPath)
	}
	assertNoToken(t, token, inv.Args, inv.Env)
	return readMCPFile(t, wantPath)
}

// readMCPFile returns the content of an MCP config file after checking that only the user can read
// it and that its folder holds no left-over temp file.
func readMCPFile(t *testing.T, path string) string {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("the MCP config file: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("the MCP config file has mode %o, want 600", fi.Mode().Perm())
	}
	if left, _ := filepath.Glob(filepath.Join(filepath.Dir(path), "mcp-*.tmp")); len(left) != 0 {
		t.Errorf("temp files left beside the MCP config file: %q", left)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// assertNoToken fails when an argument or an environment entry holds the token or "Bearer".
func assertNoToken(t *testing.T, token string, args, env []string) {
	t.Helper()
	for _, v := range append(append([]string{}, args...), env...) {
		if strings.Contains(v, "Bearer") || (token != "" && strings.Contains(v, token)) {
			t.Fatalf("the MCP token is in the arguments or the environment: %q", v)
		}
	}
}

func (f *fake) invocation(t *testing.T) invocation {
	t.Helper()
	b, err := os.ReadFile(f.args)
	if err != nil {
		t.Fatal(err)
	}
	var rec invocation
	if err := json.Unmarshal(b, &rec); err != nil {
		t.Fatal(err)
	}
	return rec
}

// stdinLines closes the process, waits for its exit and returns the commands it read.
func (f *fake) stdinLines(t *testing.T, a agent.Agent) []map[string]any {
	t.Helper()
	a.Close()
	for {
		ev := next(t, a)
		if ev.Kind == agent.EvExit {
			break
		}
	}
	if _, ok := <-a.Events(); ok {
		t.Error("events not closed after EvExit")
	}
	return f.recorded(t)
}

// recorded returns the commands the fake has read so far (all of them once it has exited).
func (f *fake) recorded(t *testing.T) []map[string]any {
	t.Helper()
	b, err := os.ReadFile(f.stdin)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if l == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("stdin line %q: %v", l, err)
		}
		out = append(out, m)
	}
	return out
}

// readCommand reports whether the fake has read a command of the given type.
func (f *fake) readCommand(typ string) bool {
	b, err := os.ReadFile(f.stdin)
	if err != nil {
		return false
	}
	for _, l := range strings.Split(string(b), "\n") {
		var cmd struct{ Type string }
		if json.Unmarshal([]byte(l), &cmd) == nil && cmd.Type == typ {
			return true
		}
	}
	return false
}

// waitCommand waits until the fake has read a command of the given type.
func (f *fake) waitCommand(t *testing.T, typ string) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		if f.readCommand(typ) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("pi read no %s command within 10 s", typ)
		}
	}
}

// commandTypes is the type of every recorded command, in order.
func commandTypes(lines []map[string]any) []string {
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		out = append(out, str(l["type"]))
	}
	return out
}

func flagValue(args []string, flag string) string {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag {
			return args[i+1]
		}
	}
	return ""
}

// childPids decodes the parent and child pid the fake recorded.
func childPids(t *testing.T, path string) (int, int) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var rec struct {
		Parent int `json:"parent"`
		Child  int `json:"child"`
	}
	if err := json.Unmarshal(b, &rec); err != nil {
		t.Fatal(err)
	}
	if rec.Parent <= 1 || rec.Child <= 1 {
		t.Fatalf("recorded pids %+v, want both", rec)
	}
	return rec.Parent, rec.Child
}

// waitPidsGone polls until every pid answers ESRCH.
func waitPidsGone(t *testing.T, pids ...int) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		var left []int
		for _, pid := range pids {
			if syscall.Kill(pid, 0) == nil {
				left = append(left, pid)
			}
		}
		if len(left) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("processes %v still alive", left)
		}
	}
}

// ---- pure-translation helpers ---------------------------------------------

func translateStr(t *testing.T, p *proc, line string) []agent.Event {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		t.Fatalf("bad test line %s: %v", line, err)
	}
	return p.translate(m)
}

// memWriteCloser captures commands written to a unit proc's stdin.
type memWriteCloser struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (m *memWriteCloser) Write(b []byte) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.buf.Write(b)
}

func (m *memWriteCloser) Close() error { return nil }

func (m *memWriteCloser) commands(t *testing.T) []map[string]any {
	t.Helper()
	m.mu.Lock()
	raw := m.buf.String()
	m.mu.Unlock()
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(raw), "\n") {
		if l == "" {
			continue
		}
		var cmd map[string]any
		if err := json.Unmarshal([]byte(l), &cmd); err != nil {
			t.Fatalf("command line %q: %v", l, err)
		}
		out = append(out, cmd)
	}
	return out
}

// unitProc is a proc with its events channel and a capturing RPC writer, for tests that do not
// start a process. Its ready channel is closed: the handshake is considered done.
func unitProc() (*proc, *memWriteCloser) {
	w := &memWriteCloser{}
	p := &proc{events: make(chan agent.Event, 32), ready: make(chan struct{}), done: make(chan struct{}), s: &Spawner{}}
	close(p.ready)
	p.rpc = newRPC(w, p.translateLine)
	return p, w
}

// drainEvents reads whatever is buffered right now.
func drainEvents(p *proc) []agent.Event {
	var out []agent.Event
	for {
		select {
		case ev := <-p.events:
			out = append(out, ev)
		default:
			return out
		}
	}
}

// eventsEqual compares events, with JSON inputs compared by meaning.
func eventsEqual(a, b []agent.Event) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		x, y := a[i], b[i]
		if !jsonEqual(x.Input, y.Input) {
			return false
		}
		x.Input, y.Input = nil, nil
		if !reflect.DeepEqual(x, y) {
			return false
		}
	}
	return true
}

func jsonEqual(a, b json.RawMessage) bool {
	if len(a) == 0 || len(b) == 0 {
		return len(a) == len(b)
	}
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
}

func dump(evs []agent.Event) string {
	b, _ := json.Marshal(evs)
	return string(b)
}

// mustJSON marshals a test value.
func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
