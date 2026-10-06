package pi

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
)

func TestArgs(t *testing.T) {
	ext := &Spawner{Extension: "/ext/index.ts", Prompt: "BOARD"}
	cases := []struct {
		name        string
		s           *Spawner
		o           agent.SpawnOptions
		dir, prompt string
		want        []string
	}{
		{
			name: "plain", s: ext,
			o:   agent.SpawnOptions{ChatID: "c1", SessionID: "s1"},
			dir: "/sessions/c1", prompt: "",
			want: []string{"--mode", "rpc", "--no-extensions", "-e", "/ext/index.ts",
				"--session-dir", "/sessions/c1", "--session-id", "s1", "--no-approve"},
		},
		{
			name: "model and thinking", s: ext,
			o:   agent.SpawnOptions{SessionID: "s", Model: "deepseek/flash", Effort: "high"},
			dir: "d", prompt: "",
			want: []string{"--mode", "rpc", "--no-extensions", "-e", "/ext/index.ts",
				"--session-dir", "d", "--session-id", "s", "--model", "deepseek/flash",
				"--thinking", "high", "--append-system-prompt", "Never run bash commands without timeout",
				"--no-approve"},
		},
		{
			name: "board chat with prompt file", s: ext,
			o:   agent.SpawnOptions{SessionID: "s", BoardID: "board"},
			dir: "d", prompt: "d/append-prompt.md",
			want: []string{"--mode", "rpc", "--no-extensions", "-e", "/ext/index.ts",
				"--session-dir", "d", "--session-id", "s", "--append-system-prompt", "d/append-prompt.md",
				"--no-approve"},
		},
		{
			name: "flash model with a board prompt gets the reminder too", s: ext,
			o:   agent.SpawnOptions{SessionID: "s", BoardID: "board", Model: "openrouter/deepseek/deepseek-v4.1-flash"},
			dir: "d", prompt: "d/append-prompt.md",
			want: []string{"--mode", "rpc", "--no-extensions", "-e", "/ext/index.ts",
				"--session-dir", "d", "--session-id", "s", "--model", "openrouter/deepseek/deepseek-v4.1-flash",
				"--append-system-prompt", "d/append-prompt.md",
				"--append-system-prompt", "Never run bash commands without timeout",
				"--no-approve"},
		},
		{
			name: "non-flash model gets no reminder", s: ext,
			o:   agent.SpawnOptions{SessionID: "s", Model: "deepseek/deepseek-v4-pro"},
			dir: "d", prompt: "",
			want: []string{"--mode", "rpc", "--no-extensions", "-e", "/ext/index.ts",
				"--session-dir", "d", "--session-id", "s", "--model", "deepseek/deepseek-v4-pro",
				"--no-approve"},
		},
		{
			name: "board chat without a prompt", s: ext,
			o:   agent.SpawnOptions{BoardID: "board"},
			dir: "d", prompt: "",
			want: []string{"--mode", "rpc", "--no-extensions", "-e", "/ext/index.ts",
				"--session-dir", "d", "--no-approve"},
		},
		{
			name: "no extension, no session", s: &Spawner{},
			o:   agent.SpawnOptions{},
			dir: "d", prompt: "",
			want: []string{"--mode", "rpc", "--no-extensions", "--session-dir", "d", "--no-approve"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := c.s.args(c.o, c.dir, c.prompt)
			if !equalStrings(got, c.want) {
				t.Fatalf("args = %q\nwant %q", got, c.want)
			}
			for _, a := range got {
				if a == "--no-builtin-tools" || a == "-nbt" {
					t.Fatalf("args %q must not exclude built-in tools", got)
				}
			}
		})
	}
}

func TestIsDeepSeekFlash(t *testing.T) {
	for _, model := range []string{
		"deepseek/deepseek-v4-flash",
		"openrouter/deepseek/deepseek-v4.1-flash",
		"openrouter/deepseek/deepseek-v4-flash-0731:batch",
		"deepseek/deepseek-flash",
		"deepseek-v4-flash-vision-exp",
	} {
		if !isDeepSeekFlash(model) {
			t.Errorf("isDeepSeekFlash(%q) = false, want true", model)
		}
	}
	for _, model := range []string{
		"",
		"deepseek/deepseek-v4-pro",
		"anthropic/claude-sonnet-4",
		"google/gemini-3-flash",
	} {
		if isDeepSeekFlash(model) {
			t.Errorf("isDeepSeekFlash(%q) = true, want false", model)
		}
	}
}

func TestEnv(t *testing.T) {
	t.Setenv("PI_SUBAGENT", "1")
	t.Setenv("PI_SESSION_ID", "inherited")
	t.Setenv("PI_SESSION_FILE", "/x")
	t.Setenv("PI_PROVIDER", "p")
	t.Setenv("PI_MODEL", "m")
	t.Setenv("PI_REASONING_LEVEL", "high")
	t.Setenv("PI_CODING_AGENT", "true")
	t.Setenv("AI_AGENT", "pi")
	t.Setenv("AIWB_BRIDGE_RUN", "inherited-run")
	t.Setenv("AIWB_MCP_CONFIG", `{"mcpServers":{"board":{"type":"http","url":"http://127.0.0.1:1/mcp/inherited"}}}`)
	t.Setenv("AIWB_MCP_CONFIG_FILE", "/inherited/mcp.json")
	t.Setenv("AIWB_SOMETHING", "x")
	t.Setenv("UNRELATED", "keep")

	s := &Spawner{AppRoot: "/app"}
	env := s.env(agent.SpawnOptions{ChatID: "c1", Model: "deepseek/flash", Effort: "low"},
		"/bin/pi", "/sock", "run-1", "/app/chats/c1/pi/append-prompt.md", "/app/chats/c1/mcp.json")
	m := envMap(env)

	for _, k := range []string{"PI_SUBAGENT", "PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER",
		"PI_MODEL", "PI_REASONING_LEVEL", "PI_CODING_AGENT", "AI_AGENT", "AIWB_SOMETHING", "AIWB_MCP_CONFIG"} {
		if _, ok := m[k]; ok {
			t.Errorf("%s survived the sanitizing env", k)
		}
	}
	want := map[string]string{
		"UNRELATED":            "keep",
		"AIWB_CHAT_ID":         "c1",
		"AIWB_CHAT_DIR":        "/app/chats/c1",
		"AIWB_PI_BIN":          "/bin/pi",
		"AIWB_BRIDGE_SOCKET":   "/sock",
		"AIWB_BRIDGE_RUN":      "run-1",
		"AIWB_MODEL":           "deepseek/flash",
		"AIWB_THINKING":        "low",
		"AIWB_APPEND_PROMPT":   "/app/chats/c1/pi/append-prompt.md",
		"AIWB_MCP_CONFIG_FILE": "/app/chats/c1/mcp.json",
	}
	for k, v := range want {
		if m[k] != v {
			t.Errorf("%s = %q, want %q", k, m[k], v)
		}
	}

	// Fields that are not set stay absent.
	m = envMap(s.env(agent.SpawnOptions{ChatID: "c2"}, "/bin/pi", "", "", "", ""))
	for _, k := range []string{"AIWB_BRIDGE_SOCKET", "AIWB_BRIDGE_RUN", "AIWB_MODEL", "AIWB_THINKING", "AIWB_APPEND_PROMPT", "AIWB_MCP_CONFIG", "AIWB_MCP_CONFIG_FILE"} {
		if _, ok := m[k]; ok {
			t.Errorf("%s set although it was not written", k)
		}
	}
}

// TestEnvBoardMCPConfig pins the shared MCP contract: whenever MCP is set (with a URL) the config,
// the fixed endpoint URL plus the token in the Authorization header, is written to mcp.json in the
// chat's folder, readable by the user only, and the process gets its path in AIWB_MCP_CONFIG_FILE.
// The token is never in the environment and never in argv.
func TestEnvBoardMCPConfig(t *testing.T) {
	const boardToken = "board-secret-token"
	root := t.TempDir()
	s := &Spawner{AppRoot: root}
	mcp := &agent.BoardAccess{
		MCPURL: "http://localhost:6006/mcp",
		Token:  boardToken,
	}
	// start's steps: write the file, then build the environment with its path.
	start := func(o agent.SpawnOptions, runToken string) (map[string]string, []string) {
		t.Helper()
		file := ""
		ok, err := s.writeMCPConfig(o)
		if err != nil {
			t.Fatalf("writeMCPConfig: %v", err)
		}
		if ok {
			file = s.mcpConfigPath(o)
		}
		env := s.env(o, "/bin/pi", "/sock", runToken, "", file)
		assertNoToken(t, boardToken, s.sessionArgs(o, filepath.Join(s.chatDir(o.ChatID, o.Dir), "pi"), "", ""), env)
		return envMap(env), env
	}
	want := `{"mcpServers":{"board":{"type":"http","url":"http://localhost:6006/mcp","headers":{"Authorization":"Bearer board-secret-token"}}}}`
	path := filepath.Join(root, "chats", "c1", "mcp.json")

	m, _ := start(agent.SpawnOptions{ChatID: "c1", MCP: mcp, BoardID: "board"}, "run-9")
	if m["AIWB_MCP_CONFIG_FILE"] != path {
		t.Fatalf("AIWB_MCP_CONFIG_FILE = %q, want %q", m["AIWB_MCP_CONFIG_FILE"], path)
	}
	if _, ok := m["AIWB_MCP_CONFIG"]; ok {
		t.Errorf("AIWB_MCP_CONFIG is set: %q", m["AIWB_MCP_CONFIG"])
	}
	if got := readMCPFile(t, path); got != want {
		t.Fatalf("mcp.json = %q\nwant %q", got, want)
	}
	if fi, err := os.Stat(filepath.Dir(path)); err != nil || fi.Mode().Perm() != 0o700 {
		t.Errorf("the chat folder: %v, %v, want mode 700", fi, err)
	}

	// MCP unset → no config even with a run handle.
	m, _ = start(agent.SpawnOptions{ChatID: "c2"}, "run-9")
	if _, ok := m["AIWB_MCP_CONFIG_FILE"]; ok {
		t.Errorf("MCP unset got AIWB_MCP_CONFIG_FILE %q", m["AIWB_MCP_CONFIG_FILE"])
	}
	if _, err := os.Stat(filepath.Join(root, "chats", "c2")); err == nil {
		t.Error("MCP unset: a chat folder was made for a config file")
	}

	// MCP set, no board extras → config present. The config does not depend on a minted run
	// handle either. Every start writes the file again: the token may be another one.
	next := &agent.BoardAccess{MCPURL: mcp.MCPURL, Token: "the-next-token"}
	m, _ = start(agent.SpawnOptions{ChatID: "c1", MCP: next}, "")
	if m["AIWB_MCP_CONFIG_FILE"] != path {
		t.Errorf("MCP without a run handle: AIWB_MCP_CONFIG_FILE = %q, want %q", m["AIWB_MCP_CONFIG_FILE"], path)
	}
	if got := readMCPFile(t, path); !strings.Contains(got, "Bearer the-next-token") || strings.Contains(got, boardToken) {
		t.Errorf("the second start did not replace the file: %q", got)
	}

	// The folder the caller names (an app-spawned subagent's, a branch's) holds its own file.
	sub := filepath.Join(root, "chats", "c1", "subagents", "s1")
	m, _ = start(agent.SpawnOptions{ChatID: "c1/subagents/s1", Dir: sub, MCP: mcp, Subagent: true}, "run-9")
	if m["AIWB_MCP_CONFIG_FILE"] != filepath.Join(sub, "mcp.json") {
		t.Errorf("subagent AIWB_MCP_CONFIG_FILE = %q", m["AIWB_MCP_CONFIG_FILE"])
	}
	if got := readMCPFile(t, filepath.Join(sub, "mcp.json")); got != want {
		t.Errorf("subagent mcp.json = %q", got)
	}
	if got := readMCPFile(t, path); !strings.Contains(got, "the-next-token") {
		t.Errorf("the subagent's start wrote the parent's file: %q", got)
	}

	// MCP with no URL gets no config.
	m, _ = start(agent.SpawnOptions{ChatID: "c3", MCP: &agent.BoardAccess{Token: boardToken}}, "run-9")
	if _, ok := m["AIWB_MCP_CONFIG_FILE"]; ok {
		t.Errorf("MCP without a URL got AIWB_MCP_CONFIG_FILE %q", m["AIWB_MCP_CONFIG_FILE"])
	}
}

func envMap(env []string) map[string]string {
	m := map[string]string{}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		m[k] = v
	}
	return m
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
