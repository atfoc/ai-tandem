package claude

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
)

// Environment variables that turn the test binary into a fake `claude`.
const (
	envScript = "CLAUDE_FAKE_SCRIPT" // file whose lines the fake prints to stdout
	envStdin  = "CLAUDE_FAKE_STDIN"  // file the fake appends every stdin line to
	envArgs   = "CLAUDE_FAKE_ARGS"   // file the fake writes its cwd and arguments to
	envStderr = "CLAUDE_FAKE_STDERR" // text the fake prints to stderr before exiting
)

func TestMain(m *testing.M) {
	if os.Getenv(envScript) != "" {
		helperProcess()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// helperProcess is the fake `claude`: it prints the scripted lines, records
// stdin until it is closed, then exits. It only runs as a child of the tests.
func helperProcess() {
	cwd, _ := os.Getwd()
	rec, _ := json.Marshal(map[string]any{"cwd": cwd, "args": os.Args[1:], "noMemory": os.Getenv("CLAUDE_CODE_DISABLE_AUTO_MEMORY")})
	os.WriteFile(os.Getenv(envArgs), rec, 0o644)
	script, err := os.ReadFile(os.Getenv(envScript))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	os.Stdout.Write(script)
	out, err := os.Create(os.Getenv(envStdin))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	for sc.Scan() {
		out.Write(append(sc.Bytes(), '\n'))
		out.Sync()
	}
	out.Close()
	if msg := os.Getenv(envStderr); msg != "" {
		fmt.Fprintln(os.Stderr, msg)
	}
}

type fake struct {
	dir   string
	stdin string
	args  string
}

// newFake sets up the fake process with the given stdout lines.
func newFake(t *testing.T, lines ...string) *fake {
	t.Helper()
	dir := t.TempDir()
	f := &fake{dir: dir, stdin: filepath.Join(dir, "stdin.jsonl"), args: filepath.Join(dir, "args.json")}
	script := filepath.Join(dir, "script.jsonl")
	if err := os.WriteFile(script, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(envScript, script)
	t.Setenv(envStdin, f.stdin)
	t.Setenv(envArgs, f.args)
	return f
}

func (f *fake) spawner() *Spawner {
	return &Spawner{Bin: os.Args[0], AppRoot: "/Users/me/.ai-whiteboard", Home: "/Users/me", Prompt: "P"}
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

// stdinLines waits for the process to end and returns what it read on stdin.
func (f *fake) stdinLines(t *testing.T, a agent.Agent) []map[string]any {
	t.Helper()
	a.Close()
	for {
		ev := next(t, a)
		if ev.Kind == agent.EvExit {
			if ev.ExitErr != "" {
				t.Errorf("exit error %q", ev.ExitErr)
			}
			break
		}
		t.Errorf("unexpected event %+v", ev)
	}
	if _, ok := <-a.Events(); ok {
		t.Error("events not closed after EvExit")
	}
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

// skipInit checks that the first stdin line is the initialize control request and drops it.
func skipInit(t *testing.T, lines []map[string]any) []map[string]any {
	t.Helper()
	if len(lines) == 0 || lines[0]["type"] != "control_request" || obj(lines[0]["request"])["subtype"] != "initialize" {
		t.Fatalf("stdin = %v, want the initialize request first", lines)
	}
	return lines[1:]
}

func response(m map[string]any) map[string]any {
	r := obj(obj(m["response"])["response"])
	return r
}

func TestPermissionFlow(t *testing.T) {
	f := newFake(t,
		`{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"touch ~/.ai-whiteboard/x"},"tool_use_id":"toolu_1"}}`,
		`{"type":"control_request","request_id":"r2","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"touch a.txt","description":"Create empty file a.txt"},"tool_use_id":"toolu_2"}}`,
	)
	cwd := t.TempDir()
	a, err := f.spawner().Spawn(agent.SpawnOptions{SessionID: "s1", Cwd: cwd, Model: "sonnet"})
	if err != nil {
		t.Fatal(err)
	}
	ev := next(t, a)
	if ev.Kind != agent.EvPermRequest || ev.PermID != "r2" || ev.ToolName != "Bash" || ev.ToolID != "toolu_2" {
		t.Fatalf("first event %+v, want EvPermRequest r2 (r1 touches the app folder)", ev)
	}
	if !jsonEqual(ev.Input, json.RawMessage(`{"command":"touch a.txt","description":"Create empty file a.txt"}`)) {
		t.Errorf("input %s", ev.Input)
	}
	if err := a.Decide("r2", true); err != nil {
		t.Fatal(err)
	}
	if err := a.Decide("r2", true); err == nil {
		t.Error("second Decide on the same request did not fail")
	}
	if err := a.Decide("r1", true); err == nil {
		t.Error("Decide on the guarded request did not fail")
	}
	lines := skipInit(t, f.stdinLines(t, a))
	if len(lines) != 2 {
		t.Fatalf("stdin = %v, want 2 lines", lines)
	}
	d := obj(lines[0]["response"])
	if lines[0]["type"] != "control_response" || d["request_id"] != "r1" || d["subtype"] != "success" ||
		response(lines[0])["behavior"] != "deny" || response(lines[0])["message"] != agent.AppDirDenied {
		t.Errorf("r1 answer %v, want a deny with AppDirDenied", lines[0])
	}
	d = obj(lines[1]["response"])
	if d["request_id"] != "r2" || response(lines[1])["behavior"] != "allow" {
		t.Errorf("r2 answer %v, want allow", lines[1])
	}
	if in := obj(response(lines[1])["updatedInput"]); in["command"] != "touch a.txt" || in["description"] != "Create empty file a.txt" {
		t.Errorf("updatedInput %v", response(lines[1])["updatedInput"])
	}

	var rec struct {
		Cwd      string
		Args     []string
		NoMemory string
	}
	b, _ := os.ReadFile(f.args)
	json.Unmarshal(b, &rec)
	realCwd, _ := filepath.EvalSymlinks(cwd)
	if gotCwd, _ := filepath.EvalSymlinks(rec.Cwd); gotCwd != realCwd {
		t.Errorf("process cwd %q, want %q", rec.Cwd, cwd)
	}
	if v, _ := flag(rec.Args, "--session-id"); v != "s1" {
		t.Errorf("process args %q", rec.Args)
	}
	if rec.NoMemory != "1" {
		t.Errorf("CLAUDE_CODE_DISABLE_AUTO_MEMORY = %q, want 1", rec.NoMemory)
	}
}

func TestDenyAndUnsupportedControl(t *testing.T) {
	f := newFake(t,
		`{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -rf x"},"tool_use_id":"toolu_1"}}`,
		`{"type":"control_request","request_id":"r2","request":{"subtype":"something_else"}}`,
	)
	a, err := f.spawner().Spawn(agent.SpawnOptions{SessionID: "s1", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if ev := next(t, a); ev.Kind != agent.EvPermRequest || ev.PermID != "r1" {
		t.Fatalf("event %+v", ev)
	}
	if err := a.Decide("r1", false); err != nil {
		t.Fatal(err)
	}
	lines := skipInit(t, f.stdinLines(t, a))
	if len(lines) != 2 {
		t.Fatalf("stdin = %v", lines)
	}
	// the unsupported request is answered by the read loop, before the user decides
	if r := obj(lines[0]["response"]); r["subtype"] != "error" || r["request_id"] != "r2" || r["error"] != "unsupported control request" {
		t.Errorf("unsupported answer %v", lines[0])
	}
	if r := response(lines[1]); r["behavior"] != "deny" || r["message"] != "The user said no in AI Whiteboard." {
		t.Errorf("deny answer %v", lines[1])
	}
}

func TestStreamSendInterrupt(t *testing.T) {
	f := newFake(t,
		`not json`,
		`{"type":"system","subtype":"status","status":"requesting"}`,
		`{"type":"control_response","response":{"subtype":"success","request_id":"int_1","response":{"still_queued":[]}}}`,
		`{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming"}`,
	)
	a, err := f.spawner().Spawn(agent.SpawnOptions{SessionID: "s1", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if ev := next(t, a); ev.Kind != agent.EvThinking {
		t.Fatalf("event %+v, want EvThinking", ev)
	}
	if ev := next(t, a); ev.Kind != agent.EvUsage {
		t.Fatalf("event %+v, want EvUsage", ev)
	}
	if ev := next(t, a); ev.Kind != agent.EvTurnEnd || !ev.Aborted {
		t.Fatalf("event %+v, want an aborted EvTurnEnd", ev)
	}
	if err := a.Send([]agent.ContentBlock{{Text: "<ui-context>x</ui-context>"}, {Text: "hello"}}); err != nil {
		t.Fatal(err)
	}
	if err := a.Interrupt(); err != nil {
		t.Fatal(err)
	}
	lines := skipInit(t, f.stdinLines(t, a))
	if len(lines) != 2 {
		t.Fatalf("stdin = %v", lines)
	}
	b, _ := json.Marshal(lines[0])
	want := `{"message":{"content":[{"text":"<ui-context>x</ui-context>","type":"text"},{"text":"hello","type":"text"}],"role":"user"},"type":"user"}`
	if !jsonEqual(b, json.RawMessage(want)) {
		t.Errorf("send line %s\nwant %s", b, want)
	}
	if lines[1]["type"] != "control_request" || obj(lines[1]["request"])["subtype"] != "interrupt" ||
		!strings.HasPrefix(str(lines[1]["request_id"]), "int_") {
		t.Errorf("interrupt line %v", lines[1])
	}
}

func TestSpawnSendsInitialize(t *testing.T) {
	f := newFake(t)
	a, err := f.spawner().Spawn(agent.SpawnOptions{SessionID: "s1", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	lines := f.stdinLines(t, a)
	if len(lines) != 1 {
		t.Fatalf("stdin = %v, want the initialize request only", lines)
	}
	id := str(lines[0]["request_id"])
	if !strings.HasPrefix(id, "init_") {
		t.Errorf("request_id %q, want init_…", id)
	}
	b, _ := json.Marshal(lines[0])
	want := `{"type":"control_request","request_id":"` + id + `","request":{"subtype":"initialize","agentProgressSummaries":true,"forwardSubagentText":true}}`
	if !jsonEqual(b, json.RawMessage(want)) {
		t.Errorf("initialize line %s\nwant %s", b, want)
	}
}

func TestSubagentPermission(t *testing.T) {
	f := newFake(t,
		`{"type":"system","subtype":"task_started","task_id":"a1","tool_use_id":"toolu_T","description":"Look around","task_type":"local_agent","subagent_type":"general-purpose","prompt":"ls"}`,
		`{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"toolu_S","agent_id":"a1"}}`,
		`{"type":"control_request","request_id":"r2","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"pwd"},"tool_use_id":"toolu_P"}}`,
	)
	a, err := f.spawner().Spawn(agent.SpawnOptions{SessionID: "s1", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if ev := next(t, a); ev.Kind != agent.EvSub || ev.Sub != "toolu_T" {
		t.Fatalf("event %+v, want EvSub toolu_T", ev)
	}
	if ev := next(t, a); ev.Kind != agent.EvPermRequest || ev.PermID != "r1" || ev.Sub != "toolu_T" {
		t.Fatalf("event %+v, want EvPermRequest r1 with Sub toolu_T", ev)
	}
	if ev := next(t, a); ev.Kind != agent.EvPermRequest || ev.PermID != "r2" || ev.Sub != "" {
		t.Fatalf("event %+v, want EvPermRequest r2 with no Sub", ev)
	}
	a.Decide("r1", false)
	a.Decide("r2", false)
	if lines := skipInit(t, f.stdinLines(t, a)); len(lines) != 2 {
		t.Errorf("stdin = %v, want 2 answers", lines)
	}
}

func TestExitErrorFromStderr(t *testing.T) {
	f := newFake(t)
	t.Setenv(envStderr, "  something broke  ")
	a, err := f.spawner().Spawn(agent.SpawnOptions{SessionID: "s1", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	a.Close()
	ev := next(t, a)
	if ev.Kind != agent.EvExit || ev.ExitErr != "something broke" {
		t.Errorf("event %+v, want EvExit with the trimmed stderr", ev)
	}
}

func TestMissingFolder(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "started")
	f := newFake(t)
	t.Setenv(envArgs, marker) // the fake writes this file as soon as it runs
	a, err := f.spawner().Spawn(agent.SpawnOptions{SessionID: "s1", Cwd: filepath.Join(t.TempDir(), "gone")})
	if !errors.Is(err, agent.ErrFolderMissing) || a != nil {
		t.Fatalf("Spawn = %v, %v; want nil, ErrFolderMissing", a, err)
	}
	time.Sleep(200 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Error("a process was started")
	}
}
