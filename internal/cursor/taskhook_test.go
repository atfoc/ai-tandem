package cursor

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
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
	assertGuardMatcher(t, doc, dataDir, cwd, appRoot, "")
}

// assertGuardMatcher is assertGuard for a guard with the given matcher ("" = every tool).
func assertGuardMatcher(t *testing.T, doc hookFile, dataDir, cwd, appRoot, matcher string) {
	t.Helper()
	if len(doc.Hooks.PreToolUse) < 2 {
		t.Fatalf("preToolUse %d entries, want the guard after Task's", len(doc.Hooks.PreToolUse))
	}
	h := doc.Hooks.PreToolUse[1]
	if h.Matcher != matcher {
		t.Fatalf("the guard has the matcher %q, want %q", h.Matcher, matcher)
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

// A read-only process has a hook file of its own, in a data dir of its own: besides the two
// entries of every process, one that refuses every tool that changes files. A process that may
// write and runs in the same folder keeps its file, whichever of the two starts last.
func TestReadOnlyHookFileAndDataDir(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{})
	until(t, a, isKind(agent.EvCatalog))
	b := e.spawn(t, agent.SpawnOptions{ReadOnly: true})
	until(t, b, isKind(agent.EvCatalog))

	ro := e.s.cursorDataDir() + "-ro"
	if filepath.Base(ro) != "cursor-acp-ro" || filepath.Dir(ro) != filepath.Dir(e.s.cursorDataDir()) {
		t.Fatalf("read-only data dir %q", ro)
	}
	if got := e.fakeCursorDataDir(t); got != ro {
		t.Fatalf("CURSOR_DATA_DIR of the read-only process %q, want %q", got, ro)
	}
	if got := e.s.dataDir(true); got != ro {
		t.Fatalf("dataDir(true) = %q, want %q", got, ro)
	}

	doc := readHooks(t, ro, e.cwd)
	if len(doc.Hooks.PreToolUse) != 3 {
		t.Fatalf("read-only preToolUse %d entries, want 3", len(doc.Hooks.PreToolUse))
	}
	if doc.Hooks.PreToolUse[0].Matcher != "^Task$" {
		t.Fatalf("first entry %+v, want Task's", doc.Hooks.PreToolUse[0])
	}
	assertGuard(t, doc, ro, e.cwd, e.s.AppRoot)
	h := doc.Hooks.PreToolUse[2]
	if h.Matcher != "^(?!(Read|Grep|List|ReadLints)$|MCP:)" {
		t.Fatalf("read-only matcher %q", h.Matcher)
	}
	perm, msg := runHook(t, h.Command, payload(e.cwd, ro, "Write", map[string]string{"file_path": "a.txt"}))
	if perm != "deny" || !strings.Contains(msg, "read-only") || !strings.Contains(msg, "Read") {
		t.Fatalf("read-only hook decided %q %q", perm, msg)
	}
	// Tools of MCP servers other than the app's are refused where the server is known.
	if n := len(doc.Hooks.BeforeMCPExecution); n != 1 {
		t.Fatalf("beforeMCPExecution %d entries, want the read-only one", n)
	}
	assertOtherServersRefused(t, doc.Hooks.BeforeMCPExecution[0], readOnlyServerDenied)

	// The writing process's file is untouched: no read-only entry, here or after a later start.
	for i := 0; i < 2; i++ {
		if doc := readHooks(t, e.s.cursorDataDir(), e.cwd); len(doc.Hooks.PreToolUse) != 2 {
			t.Fatalf("the writing process's hook file has %d entries, want 2", len(doc.Hooks.PreToolUse))
		}
		c := e.spawn(t, agent.SpawnOptions{ReadOnly: true})
		until(t, c, isKind(agent.EvCatalog))
	}
}

// A run's orchestrator is read-only and unattended at once: it has the read-only entry and the
// read-only data dir like any read-only process.
func TestReadOnlyUnattendedHookFileAndDataDir(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{ReadOnly: true, Unattended: true})
	until(t, a, isKind(agent.EvCatalog))

	ro := e.s.cursorDataDir() + "-ro"
	if got := e.fakeCursorDataDir(t); got != ro {
		t.Fatalf("CURSOR_DATA_DIR %q, want %q", got, ro)
	}
	doc := readHooks(t, ro, e.cwd)
	if len(doc.Hooks.PreToolUse) != 3 {
		t.Fatalf("preToolUse %d entries, want 3", len(doc.Hooks.PreToolUse))
	}
	assertGuardMatcher(t, doc, ro, e.cwd, e.s.AppRoot, notMCPMatcher)
	h := doc.Hooks.PreToolUse[2]
	if h.Matcher != readOnlyMatcher {
		t.Fatalf("third entry %+v, want the read-only one", h)
	}
	if perm, msg := runHook(t, h.Command, payload(e.cwd, ro, "Write", map[string]string{"file_path": "a.txt"})); perm != "deny" || msg != readOnlyDenied {
		t.Fatalf("read-only hook decided %q %q", perm, msg)
	}
	if n := len(doc.Hooks.BeforeMCPExecution); n != 2 {
		t.Fatalf("beforeMCPExecution %d entries, want the guard's and the read-only one", n)
	}
	assertOtherServersRefused(t, doc.Hooks.BeforeMCPExecution[1], readOnlyServerDenied)
	if _, err := os.Stat(filepath.Join(e.s.cursorDataDir(), "projects", cwdSlug(e.cwd), ".cursor", "hooks.json")); !os.IsNotExist(err) {
		t.Fatalf("the read-only process wrote the hook file of the writing ones: %v", err)
	}
}

// hookPath is the hook file of a chat folder under a data dir.
func hookPath(dataDir, cwd string) string {
	return filepath.Join(dataDir, "projects", cwdSlug(cwd), ".cursor", "hooks.json")
}

// Every start writes the hook file all processes of its kind in the folder share, and Cursor
// obeys no hook when it reads the file empty. So a start that would write what is there leaves
// the file alone, and one that changes it replaces it in one step: no reader sees it half-written.
func TestHookFileIsNotRewritten(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{Unattended: true})
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
	b := e.spawn(t, agent.SpawnOptions{Unattended: true})
	until(t, b, isKind(agent.EvCatalog))
	second, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(first, second) || !second.ModTime().Equal(first.ModTime()) {
		t.Error("a second start with the same options wrote the hook file again")
	}

	// Other content replaces the file: it is a new file under the old name, never the old one
	// emptied and filled.
	if err := e.s.writeHooks(e.s.cursorDataDir(), agent.SpawnOptions{Cwd: e.cwd, ReadOnly: true}); err != nil {
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
	if doc := readHooks(t, e.s.cursorDataDir(), e.cwd); len(doc.Hooks.PreToolUse) != 3 {
		t.Errorf("%d entries after the change, want 3", len(doc.Hooks.PreToolUse))
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
	dir := s.dataDir(false)
	write := func(readOnly bool) {
		if err := s.writeHooks(dir, agent.SpawnOptions{Cwd: cwd, ReadOnly: readOnly}); err != nil {
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
		name          string
		appRoot, cwd  string
		wantGuard     bool
		readOnly      bool
		wantReadEntry bool
	}{
		{"the usual layout", filepath.Join(root, "a", ".ai-whiteboard"), filepath.Join(root, "work"), true, false, false},
		{"the chat folder has the name in its path", filepath.Join(root, "b", "wb"), filepath.Join(root, "b", "wb-notes"), false, false, false},
		{"the data dir has the name in its path", filepath.Join(root, "acp", "c"), filepath.Join(root, "work"), false, false, false},
		{"no app folder", "", filepath.Join(root, "work"), false, false, false},
		{"read-only without a guard", "", filepath.Join(root, "work"), false, true, true},
	}
	for _, c := range cases {
		if err := os.MkdirAll(c.cwd, 0o755); err != nil {
			t.Fatal(err)
		}
		s := &Spawner{AppRoot: c.appRoot, Home: filepath.Join(root, "home")}
		o := agent.SpawnOptions{Cwd: c.cwd, ReadOnly: c.readOnly}
		dir := s.dataDir(o.ReadOnly)
		if err := s.writeHooks(dir, o); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		doc := readHooks(t, dir, c.cwd)
		want := 1
		if c.wantGuard {
			want++
		}
		if c.wantReadEntry {
			want++
		}
		if len(doc.Hooks.PreToolUse) != want || doc.Hooks.PreToolUse[0].Matcher != "^Task$" {
			t.Errorf("%s: entries %+v, want %d", c.name, doc.Hooks.PreToolUse, want)
			continue
		}
		if c.wantGuard {
			assertGuard(t, doc, dir, c.cwd, c.appRoot)
		}
		if c.wantReadEntry && doc.Hooks.PreToolUse[1].Matcher != readOnlyMatcher {
			t.Errorf("%s: second entry %+v, want the read-only one", c.name, doc.Hooks.PreToolUse[1])
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
	if _, ok := s.appDirGuard(s.dataDir(false), link); ok {
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
		command, ok := s.appDirGuard(s.dataDir(false), cwd)
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

// mcpPayload is a beforeMCPExecution payload as Cursor builds it (read in the code of cursor-agent
// 2026.10.01-e373342: the tool's bare name, its arguments as one JSON string, the server's name
// and, for a server with a URL, the URL twice), written as Cursor writes a payload: on one line,
// without spaces. A server started by a command has "command" in place of the URLs.
func mcpPayload(server, url, tool string, args any) string {
	p := map[string]any{
		"conversation_id": "c1", "generation_id": "g1", "model": "gpt-5.4-nano",
		"hook_event_name": "beforeMCPExecution", "cursor_version": "2026.10.01-e373342",
		"workspace_roots": []string{"/tmp/data/projects/tmp-work"}, "transcript_path": nil,
		"tool_name": tool, "tool_input": string(mustMarshal(args)), "mcp_server_name": server,
	}
	if url != "" {
		p["mcp_server_url"], p["url"] = url, url
	} else {
		p["command"] = "npx some-server"
	}
	return string(mustMarshal(p))
}

// assertOtherServersRefused checks a beforeMCPExecution entry that refuses the tools of every
// MCP server but the app's.
func assertOtherServersRefused(t *testing.T, h hookEntry, message string) {
	t.Helper()
	if h.Matcher != "" || !h.FailClosed {
		t.Fatalf("entry %+v, want one for every MCP tool that fails closed", h)
	}
	const boardURL = "http://localhost:6006/mcp"
	notes := map[string]string{"notes": `see "mcp_server_name":"other" and .ai-whiteboard/runs`}
	for name, p := range map[string]string{
		"a tool of the app's server":         mcpPayload("board", boardURL, "get_run", map[string]string{}),
		"the app's tool, text names another": mcpPayload("board", boardURL, "set_notes", notes),
		"a payload that names no server":     `{"hook_event_name":"beforeMCPExecution","tool_name":"x","tool_input":"{}"}`,
		"a payload written another way":      `{"mcp_server_name": "other", "tool_name": "x"}`,
	} {
		if perm, msg := runHook(t, h.Command, p); perm != "" || msg != "" {
			t.Errorf("%s: %q %q, want no decision", name, perm, msg)
		}
	}
	// The arguments are a string inside the payload: what they say does not make a server the app's.
	spoof := map[string]string{"text": `"mcp_server_name":"board"`}
	for name, p := range map[string]string{
		"another server with a URL":        mcpPayload("usersrv", "http://127.0.0.1:9/mcp", "user_ping", map[string]string{"text": "p"}),
		"another server with a command":    mcpPayload("files", "", "write_file", map[string]string{"path": "a.txt"}),
		"another server, text names board": mcpPayload("usersrv", "http://127.0.0.1:9/mcp", "user_ping", spoof),
	} {
		if perm, msg := runHook(t, h.Command, p); perm != "deny" || msg != message {
			t.Errorf("%s: %q %q, want deny with %q", name, perm, msg, message)
		}
	}
}

// The names Cursor's preToolUse payload gave in live runs (cursor-agent 2026.10.01-e373342, with
// GPT-5.4 Nano and Claude Haiku 4.5), and the ones read in its code only.
var (
	seenReadTools  = []string{"Read", "Grep"}
	codeReadTools  = []string{"List", "ReadLints"}
	seenOtherTools = []string{"Write", "Delete", "Shell", "WebSearch", "WebFetch", "FetchMcpResource", "ListMcpResources"}
	codeOtherTools = []string{"Task", "Fetch", "WriteShellStdin", "ComputerUse", "RecordScreen"}
	mcpTools       = []string{"MCP:get_run", "MCP:set_notes", "MCP:user_ping"}
)

// The read-only matcher refuses every tool but the reading ones and the MCP tools: also a tool
// nobody has heard of, and one whose name only begins or ends like an allowed one.
func TestReadOnlyMatcher(t *testing.T) {
	t.Parallel()
	// The matcher is a JavaScript expression (Go's regexp has no lookahead), so its two parts are
	// read out of it here; node, where there is one, evaluates it as Cursor does (below).
	inner, ok := strings.CutPrefix(readOnlyMatcher, "^(?!(")
	names, ok2 := strings.CutSuffix(inner, ")$|MCP:)")
	if !ok || !ok2 || strings.ContainsAny(names, "()^$.*+?[]\\") {
		t.Fatalf("the matcher %q is not ^(?!(<names>)$|MCP:)", readOnlyMatcher)
	}
	allowed := strings.Split(names, "|")
	if want := append(append([]string{}, seenReadTools...), codeReadTools...); !reflect.DeepEqual(allowed, want) {
		t.Errorf("the matcher lets %q through, want %q", allowed, want)
	}
	refused := func(name string) bool { return !contains(allowed, name) && !strings.HasPrefix(name, "MCP:") }
	for _, name := range append(append([]string{}, seenReadTools...), codeReadTools...) {
		if refused(name) {
			t.Errorf("%s is refused", name)
		}
	}
	for _, name := range mcpTools {
		if refused(name) {
			t.Errorf("%s is refused", name)
		}
	}
	unknown := []string{"Edit", "StrReplace", "EditNotebook", "ApplyPatch", "Reader", "ReadLintsX", "XRead", "Grep2", "mcp:get_run", "XMCP:get_run", "MCP", ""}
	for _, name := range append(append(append([]string{}, seenOtherTools...), codeOtherTools...), unknown...) {
		if !refused(name) {
			t.Errorf("%q is not refused", name)
		}
	}
}

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

func TestHookMatchersAsCursorEvaluatesThem(t *testing.T) {
	t.Parallel()
	var all []string
	for _, group := range [][]string{seenReadTools, codeReadTools, seenOtherTools, codeOtherTools, mcpTools,
		{"Edit", "StrReplace", "Reader", "XRead", "ReadLintsX", "mcp:get_run", "XMCP:get_run", "MCP", ""}} {
		all = append(all, group...)
	}
	got := jsMatches(t, []string{readOnlyMatcher, notMCPMatcher, "^Task$"}, all)

	sorted := func(ss []string) []string { out := append([]string{}, ss...); sort.Strings(out); return out }
	var wantRefused, wantGuarded []string
	for _, name := range all {
		if !strings.HasPrefix(name, "MCP:") {
			wantGuarded = append(wantGuarded, name)
			if !contains(seenReadTools, name) && !contains(codeReadTools, name) {
				wantRefused = append(wantRefused, name)
			}
		}
	}
	if !reflect.DeepEqual(sorted(got[readOnlyMatcher]), sorted(wantRefused)) {
		t.Errorf("the read-only matcher matches %q\nwant %q", sorted(got[readOnlyMatcher]), sorted(wantRefused))
	}
	if !reflect.DeepEqual(sorted(got[notMCPMatcher]), sorted(wantGuarded)) {
		t.Errorf("the guard's matcher matches %q\nwant %q", sorted(got[notMCPMatcher]), sorted(wantGuarded))
	}
	if !reflect.DeepEqual(got["^Task$"], []string{"Task"}) {
		t.Errorf("Task's matcher matches %q", got["^Task$"])
	}
}

// chatHookFile is the hook file of a chat whose app folder is named .ai-whiteboard, byte for
// byte as it was before run agents got theirs.
const chatHookFile = `{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "command": "echo '{\"permission\":\"deny\",\"user_message\":\"Native subagents (the Task tool) are disabled in this chat. To delegate, use spawn_subagent (asynchronous; it returns a receipt immediately, and the app sends you the result later as a message). Do not use native Task.\"}'",
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

// The guard is for file and shell tools. A chat's guard runs for every tool, as ever, and its
// hook file has not changed by a byte. An unattended process's guard leaves the MCP tools out,
// so that a run's agent can write about a project that names the app's folder to the app's own
// tools; the tools of other MCP servers keep the guard, where the server is known.
func TestGuardLeavesOutTheAppsMCPTools(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	cwd := filepath.Join(root, "work")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	s := &Spawner{AppRoot: filepath.Join(root, "me", ".ai-whiteboard"), Home: filepath.Join(root, "me")}
	file := func(o agent.SpawnOptions) (hookFile, string) {
		o.Cwd = cwd
		dir := s.dataDir(o.ReadOnly)
		if err := s.writeHooks(dir, o); err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(hookPath(dir, cwd))
		if err != nil {
			t.Fatal(err)
		}
		return readHooks(t, dir, cwd), string(b)
	}
	mcp := &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: boardToken}

	for _, o := range []agent.SpawnOptions{{}, {MCP: mcp}, {MCP: mcp, BoardID: "b"}, {MCP: mcp, Subagent: true}, {MCP: mcp, MCPTools: []string{"get_run"}}} {
		doc, raw := file(o)
		if raw != chatHookFile {
			t.Errorf("%+v: a chat's hook file changed:\n%s", o, raw)
		}
		assertGuard(t, doc, s.dataDir(false), cwd, s.AppRoot)
	}
	// A read-only process that is not unattended keeps the guard for every tool.
	if doc, _ := file(agent.SpawnOptions{ReadOnly: true}); doc.Hooks.PreToolUse[1].Matcher != "" {
		t.Errorf("the guard of a read-only process that is not unattended: %+v", doc.Hooks.PreToolUse[1])
	}

	for _, o := range []agent.SpawnOptions{{Unattended: true}, {Unattended: true, MCP: mcp, MCPTools: []string{"spawn_subagent"}}, {Unattended: true, ReadOnly: true, MCP: mcp}} {
		doc, _ := file(o)
		assertGuardMatcher(t, doc, s.dataDir(o.ReadOnly), cwd, s.AppRoot, notMCPMatcher)
		if len(doc.Hooks.BeforeMCPExecution) == 0 {
			t.Fatalf("%+v: no beforeMCPExecution entry", o)
		}
		h := doc.Hooks.BeforeMCPExecution[0]
		if h.Matcher != "" || !h.FailClosed {
			t.Fatalf("%+v: entry %+v, want one for every MCP tool that fails closed", o, h)
		}
		named := map[string]string{"notes": "the data is in .ai-whiteboard/runs, at " + s.AppRoot}
		for name, p := range map[string]string{
			"the app's tool, naming the folder":     mcpPayload("board", "http://localhost:6006/mcp", "set_notes", named),
			"another server, not naming the folder": mcpPayload("files", "", "read_file", map[string]string{"path": "a.txt"}),
		} {
			if perm, msg := runHook(t, h.Command, p); perm != "" || msg != "" {
				t.Errorf("%+v, %s: %q %q, want no decision", o, name, perm, msg)
			}
		}
		other := mcpPayload("files", "", "read_file", map[string]string{"path": s.AppRoot + "/state.json"})
		if perm, msg := runHook(t, h.Command, other); perm != "deny" || msg != agent.AppDirDenied {
			t.Errorf("%+v, another server naming the folder: %q %q, want deny with AppDirDenied", o, perm, msg)
		}
	}
	// Without a guard there is nothing to keep for the other servers either.
	plain := &Spawner{}
	if err := plain.writeHooks(filepath.Join(root, "acp"), agent.SpawnOptions{Cwd: cwd, Unattended: true}); err != nil {
		t.Fatal(err)
	}
	if doc := readHooks(t, filepath.Join(root, "acp"), cwd); len(doc.Hooks.PreToolUse) != 1 || len(doc.Hooks.BeforeMCPExecution) != 0 {
		t.Errorf("without an app folder: %+v", doc.Hooks)
	}
}
