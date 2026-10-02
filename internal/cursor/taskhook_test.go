package cursor

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
)

func TestCwdSlug(t *testing.T) {
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

func fakeCursorDataDir(t *testing.T) string {
	t.Helper()
	path := os.Getenv("FAKE_ACP_CURSOR_DATA_DIR")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read child CURSOR_DATA_DIR: %v", err)
	}
	return string(b)
}

func assertIsolatedHook(t *testing.T, e *env) {
	t.Helper()
	got := fakeCursorDataDir(t)
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

	path := filepath.Join(got, "projects", cwdSlug(e.cwd), ".cursor", "hooks.json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read hook: %v", err)
	}
	var doc taskHookFile
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("hooks.json: %v\n%s", err, b)
	}
	if doc.Version != 1 {
		t.Fatalf("version %d", doc.Version)
	}
	if len(doc.Hooks.PreToolUse) != 1 {
		t.Fatalf("preToolUse %d entries", len(doc.Hooks.PreToolUse))
	}
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
	if !strings.Contains(h.Command, "spawn_subagent") || !strings.Contains(h.Command, "wait_subagents") {
		t.Fatalf("command missing spawn family: %s", h.Command)
	}

	defaultHook := filepath.Join(e.home, ".cursor", "projects", cwdSlug(e.cwd), ".cursor", "hooks.json")
	if _, err := os.Stat(defaultHook); !os.IsNotExist(err) {
		t.Fatalf("wrote hook under default Cursor config dir: %v", err)
	}
}

func TestSpawnPlainIsolatesCursorDataDirAndWritesTaskHook(t *testing.T) {
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{})
	until(t, a, isKind(agent.EvCatalog))
	assertIsolatedHook(t, e)
}

func TestSpawnBoardIsolatesCursorDataDirAndWritesTaskHook(t *testing.T) {
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{
		MCP:     &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: boardToken},
		BoardID: "board",
	})
	until(t, a, isKind(agent.EvCatalog))
	assertIsolatedHook(t, e)
}

func TestSpawnSubagentIsolatesCursorDataDirAndWritesTaskHook(t *testing.T) {
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{Subagent: true})
	until(t, a, isKind(agent.EvCatalog))
	assertIsolatedHook(t, e)
}

func TestCatalogProbeDoesNotIsolate(t *testing.T) {
	e := newEnv(t, baseScript())
	if _, err := e.s.Catalog(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	if got, parent := fakeCursorDataDir(t), os.Getenv("CURSOR_DATA_DIR"); got != parent {
		t.Fatalf("probe CURSOR_DATA_DIR=%q, parent has %q", got, parent)
	}
	hook := filepath.Join(e.s.cursorDataDir(), "projects", cwdSlug(os.TempDir()), ".cursor", "hooks.json")
	if _, err := os.Stat(hook); !os.IsNotExist(err) {
		t.Fatalf("probe wrote Task hook: %v", err)
	}
}
