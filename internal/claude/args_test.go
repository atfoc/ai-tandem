package claude

import (
	"slices"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/boardtools"
)

var (
	_ agent.Spawner = (*Spawner)(nil)
	_ agent.Agent   = (*proc)(nil)
)

var testSpawner = &Spawner{Bin: "claude", AppRoot: "/Users/me/.ai-whiteboard", Home: "/Users/me", Prompt: "WHITEBOARD PROMPT"}

// flag returns the value after name in args, and whether name is there.
func flag(args []string, name string) (string, bool) {
	i := slices.Index(args, name)
	if i < 0 {
		return "", false
	}
	if i+1 < len(args) {
		return args[i+1], true
	}
	return "", true
}

func TestArgsPlainChat(t *testing.T) {
	mcp := &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: "tok"}
	args := testSpawner.Args(agent.SpawnOptions{SessionID: "s1", Cwd: "/tmp", Model: "sonnet", Effort: "high", MCP: mcp})
	if v, ok := flag(args, "--append-system-prompt"); !ok {
		t.Errorf("plain chat missing --append-system-prompt: %q", args)
	} else if strings.Contains(v, "WHITEBOARD PROMPT") {
		t.Errorf("plain chat has whiteboard body: %q", v)
	}
	want := `{"mcpServers":{"board":{"type":"http","url":"http://localhost:6006/mcp","headers":{"Authorization":"Bearer tok"}}}}`
	if v, _ := flag(args, "--mcp-config"); v != want {
		t.Errorf("--mcp-config = %q\n          want %q", v, want)
	}
	checkAllowed(t, args, boardtools.SpawnFamily, boardtools.Tools)
	if v, _ := flag(args, "--session-id"); v != "s1" {
		t.Errorf("--session-id = %q", v)
	}
	if _, ok := flag(args, "--resume"); ok {
		t.Errorf("new chat has --resume")
	}
	if v, _ := flag(args, "--model"); v != "sonnet" {
		t.Errorf("--model = %q", v)
	}
	if v, _ := flag(args, "--effort"); v != "high" {
		t.Errorf("--effort = %q", v)
	}
	checkCommon(t, args)
}

func TestArgsBoardChat(t *testing.T) {
	mcp := &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: "tok"}
	args := testSpawner.Args(agent.SpawnOptions{SessionID: "s2", Resume: true, Cwd: "/tmp", Model: "opus", MCP: mcp, BoardID: "b"})
	if v, _ := flag(args, "--append-system-prompt"); !strings.Contains(v, "WHITEBOARD PROMPT") {
		t.Errorf("--append-system-prompt missing whiteboard: %q", v)
	}
	want := `{"mcpServers":{"board":{"type":"http","url":"http://localhost:6006/mcp","headers":{"Authorization":"Bearer tok"}}}}`
	if v, _ := flag(args, "--mcp-config"); v != want {
		t.Errorf("--mcp-config = %q\n          want %q", v, want)
	}
	checkAllowed(t, args, append(append([]boardtools.Tool{}, boardtools.Tools...), boardtools.SpawnFamily...), nil)
	if v, _ := flag(args, "--resume"); v != "s2" {
		t.Errorf("--resume = %q", v)
	}
	if _, ok := flag(args, "--session-id"); ok {
		t.Errorf("resumed chat has --session-id")
	}
	if _, ok := flag(args, "--effort"); ok {
		t.Errorf("no effort chosen, but --effort is there")
	}
	checkCommon(t, args)
}

func TestArgsSubProcessBoardParent(t *testing.T) {
	mcp := &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: "sub-tok"}
	args := testSpawner.Args(agent.SpawnOptions{SessionID: "s4", Cwd: "/tmp", Model: "sonnet", MCP: mcp, BoardID: "b", Subagent: true})
	if _, ok := flag(args, "--mcp-config"); !ok {
		t.Errorf("sub process missing --mcp-config: %q", args)
	}
	if v, _ := flag(args, "--append-system-prompt"); !strings.Contains(v, "WHITEBOARD PROMPT") {
		t.Errorf("--append-system-prompt missing whiteboard: %q", v)
	}
	checkAllowed(t, args, boardtools.Tools, boardtools.SpawnFamily)
	checkCommon(t, args)
}

func TestArgsSubProcessPlainParent(t *testing.T) {
	mcp := &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: "sub-tok"}
	args := testSpawner.Args(agent.SpawnOptions{SessionID: "s5", Cwd: "/tmp", Model: "sonnet", MCP: mcp, Subagent: true})
	if _, ok := flag(args, "--mcp-config"); !ok {
		t.Errorf("sub process missing --mcp-config: %q", args)
	}
	if v, ok := flag(args, "--append-system-prompt"); !ok {
		t.Errorf("plain-parent sub missing --append-system-prompt: %q", args)
	} else if strings.Contains(v, "WHITEBOARD PROMPT") {
		t.Errorf("plain-parent sub has whiteboard body: %q", v)
	}
	if _, ok := flag(args, "--allowedTools"); ok {
		t.Errorf("plain-parent sub has --allowedTools: %q", args)
	}
	checkCommon(t, args)
}

func TestArgsNoMCPOmitsConfig(t *testing.T) {
	args := testSpawner.Args(agent.SpawnOptions{SessionID: "s6", Cwd: "/tmp", Model: "sonnet"})
	for _, f := range []string{"--mcp-config", "--allowedTools"} {
		if _, ok := flag(args, f); ok {
			t.Errorf("MCP unset has %s: %q", f, args)
		}
	}
	if v, ok := flag(args, "--append-system-prompt"); !ok {
		t.Errorf("MCP unset missing --append-system-prompt: %q", args)
	} else if strings.Contains(v, "WHITEBOARD PROMPT") {
		t.Errorf("MCP unset has whiteboard body: %q", v)
	}
	checkCommon(t, args)
}

func checkAllowed(t *testing.T, args []string, want []boardtools.Tool, refuse []boardtools.Tool) {
	t.Helper()
	allowed, ok := flag(args, "--allowedTools")
	if !ok {
		t.Fatalf("--allowedTools missing: %q", args)
	}
	names := strings.Split(allowed, ",")
	if len(names) != len(want) {
		t.Errorf("--allowedTools has %d tools, want %d: %q", len(names), len(want), allowed)
	}
	for _, tool := range want {
		if !slices.Contains(names, "mcp__board__"+tool.Name) {
			t.Errorf("--allowedTools misses %s", tool.Name)
		}
	}
	for _, tool := range refuse {
		if slices.Contains(names, "mcp__board__"+tool.Name) {
			t.Errorf("--allowedTools has %s", tool.Name)
		}
	}
}

func TestArgsHaikuHasNoEffort(t *testing.T) {
	args := testSpawner.Args(agent.SpawnOptions{SessionID: "s3", Cwd: "/tmp", Model: "haiku", Effort: "high"})
	if _, ok := flag(args, "--effort"); ok {
		t.Errorf("haiku has --effort: %q", args)
	}
	checkCommon(t, args)
}

func checkCommon(t *testing.T, args []string) {
	t.Helper()
	if v, _ := flag(args, "--permission-mode"); v != "auto" {
		t.Errorf("--permission-mode = %q", v)
	}
	if v, _ := flag(args, "--permission-prompt-tool"); v != "stdio" {
		t.Errorf("--permission-prompt-tool = %q", v)
	}
	if _, ok := flag(args, "--forward-subagent-text"); !ok {
		t.Errorf("--forward-subagent-text missing: %q", args)
	}
	want := "Read(~/.ai-whiteboard/**),Edit(~/.ai-whiteboard/**),Write(~/.ai-whiteboard/**),Bash(*.ai-whiteboard*)"
	if v, _ := flag(args, "--disallowedTools"); v != want+",Task,Agent" {
		t.Errorf("--disallowedTools = %q, want %q", v, want+",Task,Agent")
	}
	v, ok := flag(args, "--append-system-prompt")
	if !ok {
		t.Errorf("--append-system-prompt missing: %q", args)
	} else {
		if !strings.Contains(v, "spawn_subagent") {
			t.Errorf("steering paragraph missing spawn_subagent: %q", v)
		}
		if !strings.Contains(v, "wait_subagents") {
			t.Errorf("steering paragraph missing wait_subagents: %q", v)
		}
	}
	for _, f := range []string{"--strict-mcp-config", "--setting-sources", "--disable-slash-commands", "--system-prompt", "--tools"} {
		if _, ok := flag(args, f); ok {
			t.Errorf("isolation flag %s present: %q", f, args)
		}
	}
}

func TestAppDirRules(t *testing.T) {
	cases := []struct {
		root, home string
		want       []string
	}{
		{"/Users/me/.ai-whiteboard", "/Users/me",
			[]string{"Read(~/.ai-whiteboard/**)", "Edit(~/.ai-whiteboard/**)", "Write(~/.ai-whiteboard/**)", "Bash(*.ai-whiteboard*)"}},
		{"/Users/me/data/wb", "/Users/me/",
			[]string{"Read(~/data/wb/**)", "Edit(~/data/wb/**)", "Write(~/data/wb/**)", "Bash(*wb*)"}},
		{"/var/lib/.ai-whiteboard", "/Users/me",
			[]string{"Read(//var/lib/.ai-whiteboard/**)", "Edit(//var/lib/.ai-whiteboard/**)", "Write(//var/lib/.ai-whiteboard/**)", "Bash(*.ai-whiteboard*)"}},
		{"/Users/meow/.ai-whiteboard", "/Users/me",
			[]string{"Read(//Users/meow/.ai-whiteboard/**)", "Edit(//Users/meow/.ai-whiteboard/**)", "Write(//Users/meow/.ai-whiteboard/**)", "Bash(*.ai-whiteboard*)"}},
	}
	for _, c := range cases {
		if got := AppDirRules(c.root, c.home); !slices.Equal(got, c.want) {
			t.Errorf("AppDirRules(%q, %q) = %q, want %q", c.root, c.home, got, c.want)
		}
	}
}
