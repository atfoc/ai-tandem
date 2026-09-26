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
	args := testSpawner.Args(agent.SpawnOptions{SessionID: "s1", Cwd: "/tmp", Model: "sonnet", Effort: "high"})
	for _, f := range []string{"--append-system-prompt", "--mcp-config", "--allowedTools"} {
		if _, ok := flag(args, f); ok {
			t.Errorf("plain chat has %s: %q", f, args)
		}
	}
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
	board := &agent.BoardAccess{MCPURL: "http://127.0.0.1:4000/mcp/tok", Token: "tok"}
	args := testSpawner.Args(agent.SpawnOptions{SessionID: "s2", Resume: true, Cwd: "/tmp", Model: "opus", Board: board})
	if v, _ := flag(args, "--append-system-prompt"); v != "WHITEBOARD PROMPT" {
		t.Errorf("--append-system-prompt = %q", v)
	}
	if v, _ := flag(args, "--mcp-config"); v != `{"mcpServers":{"board":{"type":"http","url":"http://127.0.0.1:4000/mcp/tok"}}}` {
		t.Errorf("--mcp-config = %q", v)
	}
	allowed, _ := flag(args, "--allowedTools")
	names := strings.Split(allowed, ",")
	if len(names) != len(boardtools.Tools) {
		t.Errorf("--allowedTools has %d tools, want %d: %q", len(names), len(boardtools.Tools), allowed)
	}
	for _, tool := range boardtools.Tools {
		if !slices.Contains(names, "mcp__board__"+tool.Name) {
			t.Errorf("--allowedTools misses %s", tool.Name)
		}
	}
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
	if v, _ := flag(args, "--disallowedTools"); v != want {
		t.Errorf("--disallowedTools = %q, want %q", v, want)
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
