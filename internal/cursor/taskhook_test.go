package cursor

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
)

func TestCwdSlug(t *testing.T) {
	t.Parallel()
	cases := []struct{ in, want string }{
		{"/Users/x/proj", "Users-x-proj"},
		{"/tmp/ctd/ws", "tmp-ctd-ws"},
		{"//foo--bar!!", "foo-bar"},
		{"/tmp/ctd/ws/", "tmp-ctd-ws"},
	}
	for _, tc := range cases {
		if got := cwdSlug(tc.in); got != tc.want {
			t.Errorf("cwdSlug(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestCursorDataDir(t *testing.T) {
	t.Parallel()
	s := &Spawner{AppRoot: filepath.Join("/Users/x", "store")}
	if got, want := s.cursorDataDir(), filepath.Join("/Users/x", "cursor-acp"); got != want {
		t.Fatalf("with AppRoot: %q, want %q", got, want)
	}
	s = &Spawner{Home: "/tmp/h"}
	if got, want := s.cursorDataDir(), filepath.Join("/tmp/h", "cursor-acp"); got != want {
		t.Fatalf("empty AppRoot with Home: %q, want %q", got, want)
	}
	s = &Spawner{}
	got := s.cursorDataDir()
	if got == "" || filepath.Base(got) != "aiwb-cursor-acp" {
		t.Fatalf("empty AppRoot and Home: %q", got)
	}
	if strings.Contains(got, string(filepath.Separator)+".cursor") || strings.HasSuffix(got, ".cursor") {
		t.Fatalf("fallback is the default Cursor config dir: %q", got)
	}
}

func (e *env) fakeCursorDataDir(t *testing.T) string {
	t.Helper()
	path := e.fake.vars["FAKE_ACP_CURSOR_DATA_DIR"]
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read child CURSOR_DATA_DIR: %v", err)
	}
	return string(b)
}

// readHooks reads the hook file of a chat folder under a data dir.
func readHooks(t *testing.T, dataDir, cwd string) hookFile {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dataDir, "projects", cwdSlug(cwd), ".cursor", "hooks.json"))
	if err != nil {
		t.Fatalf("read hook: %v", err)
	}
	var doc hookFile
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("hooks.json: %v\n%s", err, b)
	}
	if doc.Version != 1 {
		t.Fatalf("version %d", doc.Version)
	}
	for _, h := range doc.Hooks.PreToolUse {
		if !h.FailClosed {
			t.Fatalf("a hook is not fail-closed: %+v", h)
		}
	}
	return doc
}

// runHook runs a hook command as Cursor does, with the call's payload on stdin, and returns the
// decision it prints.
func runHook(t *testing.T, command, payload string) (permission, message string) {
	t.Helper()
	cmd := exec.Command("sh", "-c", command)
	cmd.Stdin = strings.NewReader(payload)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("hook command %s: %v", command, err)
	}
	var d struct {
		Permission  string `json:"permission"`
		UserMessage string `json:"user_message"`
	}
	if err := json.Unmarshal(out, &d); err != nil {
		t.Fatalf("hook command %s printed %q: %v", command, out, err)
	}
	return d.Permission, d.UserMessage
}

// payload is a preToolUse payload as Cursor writes it, cut down to the fields that carry paths.
func payload(cwd, dataDir, tool string, input any) string {
	return string(mustMarshal(map[string]any{
		"hook_event_name": "preToolUse", "tool_name": tool, "tool_input": input,
		"workspace_roots": []string{cwd},
		"transcript_path": filepath.Join(dataDir, "projects", cwdSlug(cwd), "agent-transcripts", "t.jsonl"),
	}))
}

// assertGuard checks the app-folder guard of a hook file: the entry after Task's, for every tool.
// It refuses a call that names the app's folder and decides nothing about any other.
func assertGuard(t *testing.T, doc hookFile, dataDir, cwd, appRoot string) {
	t.Helper()
	if len(doc.Hooks.PreToolUse) < 2 {
		t.Fatalf("preToolUse %d entries, want the guard after Task's", len(doc.Hooks.PreToolUse))
	}
	h := doc.Hooks.PreToolUse[1]
	if h.Matcher != "" {
		t.Fatalf("the guard has the matcher %q, want none", h.Matcher)
	}
	for _, input := range []any{
		map[string]string{"command": "cat " + appRoot + "/state.json"},
		map[string]string{"command": "ls ~/" + filepath.Base(appRoot)},
		map[string]string{"file_path": filepath.Join(appRoot, "chats", "c1", "transcript.json")},
	} {
		if perm, msg := runHook(t, h.Command, payload(cwd, dataDir, "Shell", input)); perm != "deny" || msg != agent.AppDirDenied {
			t.Errorf("guard on %v: %q %q, want deny with AppDirDenied", input, perm, msg)
		}
	}
	for _, input := range []any{
		map[string]string{"command": "git status"},
		map[string]string{"file_path": filepath.Join(cwd, "a.txt"), "content": "it's \"quoted\"\n"},
	} {
		if perm, msg := runHook(t, h.Command, payload(cwd, dataDir, "Write", input)); perm != "" || msg != "" {
			t.Errorf("guard on %v: %q %q, want no decision", input, perm, msg)
		}
	}
}

func assertIsolatedHook(t *testing.T, e *env) {
	t.Helper()
	got := e.fakeCursorDataDir(t)
	want := e.s.cursorDataDir()
	if got != want {
		t.Fatalf("CURSOR_DATA_DIR=%q, want %q", got, want)
	}
	if got == filepath.Join(e.home, ".cursor") {
		t.Fatal("CURSOR_DATA_DIR is the default Cursor config dir")
	}
	if e.s.AppRoot != "" && (got == e.s.AppRoot || strings.HasPrefix(got, e.s.AppRoot+string(os.PathSeparator))) {
		t.Fatalf("CURSOR_DATA_DIR %q is under AppRoot %q", got, e.s.AppRoot)
	}

	doc := readHooks(t, got, e.cwd)
	if len(doc.Hooks.PreToolUse) != 2 {
		t.Fatalf("preToolUse %d entries, want Task's and the app-folder guard", len(doc.Hooks.PreToolUse))
	}
	assertGuard(t, doc, got, e.cwd, e.s.AppRoot)
	h := doc.Hooks.PreToolUse[0]
	if h.Matcher != "^Task$" {
		t.Fatalf("matcher %q", h.Matcher)
	}
	if !h.FailClosed {
		t.Fatal("failClosed is not true")
	}
	if !strings.Contains(h.Command, "user_message") {
		t.Fatalf("command missing user_message: %s", h.Command)
	}
	if !strings.Contains(h.Command, `"permission":"deny"`) {
		t.Fatalf("command missing deny: %s", h.Command)
	}
	if !strings.Contains(h.Command, "spawn_subagent") || strings.Contains(h.Command, "wait_subagents") {
		t.Fatalf("command does not point at spawn_subagent alone: %s", h.Command)
	}
	// The command is a shell echo of one single-quoted JSON object: what the model reads is its
	// user_message, which says the result arrives on its own.
	payload, ok := strings.CutPrefix(h.Command, "echo '")
	payload, ok2 := strings.CutSuffix(payload, "'")
	var deny struct {
		Permission  string `json:"permission"`
		UserMessage string `json:"user_message"`
	}
	if !ok || !ok2 || strings.Contains(payload, "'") || json.Unmarshal([]byte(payload), &deny) != nil {
		t.Fatalf("command is not an echo of one quoted JSON object: %s", h.Command)
	}
	if deny.Permission != "deny" || !strings.Contains(deny.UserMessage, "the app sends you the result later as a message") {
		t.Fatalf("deny message %+v", deny)
	}

	defaultHook := filepath.Join(e.home, ".cursor", "projects", cwdSlug(e.cwd), ".cursor", "hooks.json")
	if _, err := os.Stat(defaultHook); !os.IsNotExist(err) {
		t.Fatalf("wrote hook under default Cursor config dir: %v", err)
	}
}

func TestSpawnPlainIsolatesCursorDataDirAndWritesTaskHook(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{})
	until(t, a, isKind(agent.EvCatalog))
	assertIsolatedHook(t, e)
}

func TestSpawnBoardIsolatesCursorDataDirAndWritesTaskHook(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{
		MCP:     &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: boardToken},
		BoardID: "board",
	})
	until(t, a, isKind(agent.EvCatalog))
	assertIsolatedHook(t, e)
}

func TestSpawnSubagentIsolatesCursorDataDirAndWritesTaskHook(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{Subagent: true})
	until(t, a, isKind(agent.EvCatalog))
	assertIsolatedHook(t, e)
}

func TestCatalogProbeDoesNotIsolate(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	if _, err := e.s.Catalog(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	if got, parent := e.fakeCursorDataDir(t), os.Getenv("CURSOR_DATA_DIR"); got != parent {
		t.Fatalf("probe CURSOR_DATA_DIR=%q, parent has %q", got, parent)
	}
	hook := filepath.Join(e.s.cursorDataDir(), "projects", cwdSlug(os.TempDir()), ".cursor", "hooks.json")
	if _, err := os.Stat(hook); !os.IsNotExist(err) {
		t.Fatalf("probe wrote Task hook: %v", err)
	}
}

// hookPath is the hook file of a chat folder under a data dir.
func hookPath(dataDir, cwd string) string {
	return filepath.Join(dataDir, "projects", cwdSlug(cwd), ".cursor", "hooks.json")
}

// Every start writes the hook file all processes in the folder share, and Cursor
// obeys no hook when it reads the file empty. So a start that would write what is there leaves
// the file alone, and one that changes it replaces it in one step: no reader sees it half-written.
func TestHookFileIsNotRewritten(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{})
	until(t, a, isKind(agent.EvCatalog))
	path := hookPath(e.s.cursorDataDir(), e.cwd)
	first, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	content, _ := os.ReadFile(path)
	if first.Mode().Perm() != 0o644 {
		t.Errorf("mode %v, want 0644", first.Mode().Perm())
	}

	// The file's time would show a rewrite in place.
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	first, _ = os.Stat(path)
	b := e.spawn(t, agent.SpawnOptions{})
	until(t, b, isKind(agent.EvCatalog))
	second, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(first, second) || !second.ModTime().Equal(first.ModTime()) {
		t.Error("a second start wrote the hook file again")
	}

	// Other content (the guard of an app folder with another name) replaces the file: it is a new
	// file under the old name, never the old one emptied and filled.
	other := &Spawner{AppRoot: filepath.Join(filepath.Dir(e.s.AppRoot), "other-store"), Home: e.s.Home}
	if err := other.writeHooks(e.s.cursorDataDir(), e.cwd); err != nil {
		t.Fatal(err)
	}
	third, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(second, third) {
		t.Error("changed content was written into the file in place")
	}
	if got, _ := os.ReadFile(path); string(got) == string(content) {
		t.Error("the content did not change")
	}
	if doc := readHooks(t, e.s.cursorDataDir(), e.cwd); len(doc.Hooks.PreToolUse) != 2 || !strings.Contains(doc.Hooks.PreToolUse[1].Command, "other-store") {
		t.Errorf("entries after the change %+v, want Task's and the other folder's guard", doc.Hooks.PreToolUse)
	}
	left, _ := filepath.Glob(filepath.Join(filepath.Dir(path), "*"))
	if len(left) != 1 {
		t.Errorf("files beside the hook file: %q", left)
	}
}

func TestHookFileIsNeverSeenEmpty(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	cwd := filepath.Join(root, "work")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	s := &Spawner{AppRoot: filepath.Join(root, "home", ".ai-whiteboard"), Home: filepath.Join(root, "home")}
	// The same data dir and another guard: the content of the one file differs.
	renamed := &Spawner{AppRoot: filepath.Join(root, "home", "other-store"), Home: s.Home}
	dir := s.cursorDataDir()
	write := func(other bool) {
		w := s
		if other {
			w = renamed
		}
		if err := w.writeHooks(dir, cwd); err != nil {
			t.Error(err)
		}
	}
	write(false)
	path := hookPath(dir, cwd)

	stop, bad := make(chan struct{}), make(chan string, 1)
	reads := 0
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
			}
			b, err := os.ReadFile(path)
			reads++
			var doc hookFile
			if err != nil || json.Unmarshal(b, &doc) != nil || len(doc.Hooks.PreToolUse) < 2 {
				select {
				case bad <- fmt.Sprintf("read %d: error %v, content %q", reads, err, b):
				default:
				}
				return
			}
		}
	}()
	// Two writers, as two processes starting at once, with content that changes every time.
	var wg sync.WaitGroup
	for w := 0; w < 2; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				write(i%2 == w)
			}
		}()
	}
	wg.Wait()
	close(stop)
	<-done
	select {
	case msg := <-bad:
		t.Fatalf("a reader saw the hook file empty or cut short: %s", msg)
	default:
	}
	if reads < 100 {
		t.Fatalf("only %d reads ran beside the writes", reads)
	}
	left, _ := filepath.Glob(filepath.Join(filepath.Dir(path), "*"))
	if len(left) != 1 {
		t.Errorf("files beside the hook file: %q", left)
	}
}

// The guard matches the whole payload, which names the chat folder and the data dir: where one of
// them has the app folder's base name in its path, the guard would refuse every call, so it is
// left out. So it is when there is no app folder.
func TestAppDirGuardLeftOut(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	cases := []struct {
		name         string
		appRoot, cwd string
		wantGuard    bool
	}{
		{"the usual layout", filepath.Join(root, "a", ".ai-whiteboard"), filepath.Join(root, "work"), true},
		{"the chat folder has the name in its path", filepath.Join(root, "b", "wb"), filepath.Join(root, "b", "wb-notes"), false},
		{"the data dir has the name in its path", filepath.Join(root, "acp", "c"), filepath.Join(root, "work"), false},
		{"no app folder", "", filepath.Join(root, "work"), false},
	}
	for _, c := range cases {
		if err := os.MkdirAll(c.cwd, 0o755); err != nil {
			t.Fatal(err)
		}
		s := &Spawner{AppRoot: c.appRoot, Home: filepath.Join(root, "home")}
		dir := s.cursorDataDir()
		if err := s.writeHooks(dir, c.cwd); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		doc := readHooks(t, dir, c.cwd)
		want := 1
		if c.wantGuard {
			want++
		}
		if len(doc.Hooks.PreToolUse) != want || doc.Hooks.PreToolUse[0].Matcher != "^Task$" {
			t.Errorf("%s: entries %+v, want %d", c.name, doc.Hooks.PreToolUse, want)
			continue
		}
		if c.wantGuard {
			assertGuard(t, doc, dir, c.cwd, c.appRoot)
		}
	}

	// A chat folder that is a link into such a path counts by where it leads.
	appRoot := filepath.Join(root, "d", "store-x")
	target := filepath.Join(root, "d", "store-x-work")
	link := filepath.Join(root, "link")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	s := &Spawner{AppRoot: appRoot}
	if _, ok := s.appDirGuard(s.cursorDataDir(), link); ok {
		t.Error("the guard is there for a chat folder that links into a path with the name")
	}
}

// The folder's name is one word of the shell command whatever it contains.
func TestAppDirGuardQuotesTheName(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	for _, base := range []string{"it's data $HOME `id`", "-e x", "a b; touch " + filepath.Join(root, "pwned")} {
		s := &Spawner{AppRoot: filepath.Join(root, "apps", base)}
		cwd := filepath.Join(root, "work")
		command, ok := s.appDirGuard(s.cursorDataDir(), cwd)
		if !ok {
			t.Fatalf("%q: no guard", base)
		}
		if perm, _ := runHook(t, command, `{"tool_input":{"command":"ls"}}`); perm != "" {
			t.Errorf("%q: an unrelated call got %q", base, perm)
		}
		if perm, msg := runHook(t, command, "cat "+base+"/x"); perm != "deny" || msg != agent.AppDirDenied {
			t.Errorf("%q: a call naming the folder got %q %q", base, perm, msg)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "pwned")); err == nil {
		t.Error("the folder's name ran as a command")
	}
}

// The names Cursor's preToolUse payload gave in live runs (cursor-agent 2026.10.01-e373342, with
// GPT-5.4 Nano and Claude Haiku 4.5), and the ones read in its code only.
var (
	seenReadTools  = []string{"Read", "Grep"}
	codeReadTools  = []string{"List", "ReadLints"}
	seenOtherTools = []string{"Write", "Delete", "Shell", "WebSearch", "WebFetch", "FetchMcpResource", "ListMcpResources"}
	codeOtherTools = []string{"Task", "Fetch", "WriteShellStdin", "ComputerUse", "RecordScreen"}
)

// jsMatches evaluates matchers as Cursor does (new RegExp(matcher).test(name)) and returns, per
// matcher, the names it matches. The test is skipped where there is no node.
func jsMatches(t *testing.T, matchers, names []string) map[string][]string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("no node to evaluate a JavaScript expression")
	}
	const script = `const [ms, ns] = JSON.parse(process.argv[1]); const out = {};
for (const m of ms) out[m] = ns.filter(n => new RegExp(m).test(n)); console.log(JSON.stringify(out));`
	b, err := exec.Command(node, "-e", script, string(mustMarshal([]any{matchers, names}))).Output()
	if err != nil {
		t.Fatalf("node: %v", err)
	}
	var out map[string][]string
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("node printed %q: %v", b, err)
	}
	return out
}

// Task's matcher matches the Task tool and no other, not even one whose name only begins or ends
// like it.
func TestHookMatchersAsCursorEvaluatesThem(t *testing.T) {
	t.Parallel()
	var all []string
	for _, group := range [][]string{seenReadTools, codeReadTools, seenOtherTools, codeOtherTools,
		{"MCP:read_board", "MCP:user_ping", "Tasks", "XTask", "task", "MCP:Task", ""}} {
		all = append(all, group...)
	}
	if got := jsMatches(t, []string{"^Task$"}, all); !reflect.DeepEqual(got["^Task$"], []string{"Task"}) {
		t.Errorf("Task's matcher matches %q", got["^Task$"])
	}
}

// chatHookFile is the hook file of a chat whose app folder is named .ai-whiteboard, byte for
// byte.
const chatHookFile = `{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "command": "echo '{\"permission\":\"deny\",\"user_message\":\"Native subagents (the Task tool) are disabled in this chat. To delegate, use spawn_subagent if you have that tool (asynchronous; it returns a receipt immediately, and the app sends you the result later as a message). Do not use native Task.\"}'",
        "matcher": "^Task$",
        "failClosed": true
      },
      {
        "command": "if grep -q -F -e '.ai-whiteboard'; then echo '{\"permission\":\"deny\",\"user_message\":\"AI Whiteboard does not allow agents to touch its own folder. Use the board tools.\"}'; else echo '{}'; fi",
        "failClosed": true
      }
    ]
  }
}
`

// The hook file is these two entries and nothing else, and its guard runs for every tool, the MCP
// tools included.
func TestHookFileContent(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	cwd := filepath.Join(root, "work")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	s := &Spawner{AppRoot: filepath.Join(root, "me", ".ai-whiteboard"), Home: filepath.Join(root, "me")}
	dir := s.cursorDataDir()
	if err := s.writeHooks(dir, cwd); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(hookPath(dir, cwd))
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != chatHookFile {
		t.Errorf("the hook file:\n%s", b)
	}
	assertGuard(t, readHooks(t, dir, cwd), dir, cwd, s.AppRoot)
}
