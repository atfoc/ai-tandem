package pi

import (
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
	t.Setenv("AIWB_SOMETHING", "x")
	t.Setenv("UNRELATED", "keep")

	s := &Spawner{AppRoot: "/app"}
	env := s.env(agent.SpawnOptions{ChatID: "c1", Model: "deepseek/flash", Effort: "low"},
		"/bin/pi", "/sock", "run-1", "/app/chats/c1/pi/append-prompt.md")
	m := envMap(env)

	for _, k := range []string{"PI_SUBAGENT", "PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER",
		"PI_MODEL", "PI_REASONING_LEVEL", "PI_CODING_AGENT", "AI_AGENT", "AIWB_SOMETHING", "AIWB_MCP_CONFIG"} {
		if _, ok := m[k]; ok {
			t.Errorf("%s survived the sanitizing env", k)
		}
	}
	want := map[string]string{
		"UNRELATED":          "keep",
		"AIWB_CHAT_ID":       "c1",
		"AIWB_CHAT_DIR":      "/app/chats/c1",
		"AIWB_PI_BIN":        "/bin/pi",
		"AIWB_BRIDGE_SOCKET": "/sock",
		"AIWB_BRIDGE_RUN":    "run-1",
		"AIWB_MODEL":         "deepseek/flash",
		"AIWB_THINKING":      "low",
		"AIWB_APPEND_PROMPT": "/app/chats/c1/pi/append-prompt.md",
	}
	for k, v := range want {
		if m[k] != v {
			t.Errorf("%s = %q, want %q", k, m[k], v)
		}
	}

	// Fields that are not set stay absent.
	m = envMap(s.env(agent.SpawnOptions{ChatID: "c2"}, "/bin/pi", "", "", ""))
	for _, k := range []string{"AIWB_BRIDGE_SOCKET", "AIWB_BRIDGE_RUN", "AIWB_MODEL", "AIWB_THINKING", "AIWB_APPEND_PROMPT", "AIWB_MCP_CONFIG"} {
		if _, ok := m[k]; ok {
			t.Errorf("%s set although it was not written", k)
		}
	}
}

// TestEnvBoardMCPConfig pins the shared MCP contract: whenever MCP is set the process
// gets the fixed endpoint URL plus its token in the Authorization header inside
// AIWB_MCP_CONFIG; the token appears only there, never elsewhere in the env and never in argv.
func TestEnvBoardMCPConfig(t *testing.T) {
	const boardToken = "board-secret-token"
	s := &Spawner{AppRoot: "/app"}
	mcp := &agent.BoardAccess{
		MCPURL: "http://localhost:6006/mcp",
		Token:  boardToken,
	}

	env := s.env(agent.SpawnOptions{ChatID: "c1", MCP: mcp, BoardID: "board"}, "/bin/pi", "/sock", "run-9", "")
	m := envMap(env)
	want := `{"mcpServers":{"board":{"type":"http","url":"http://localhost:6006/mcp","headers":{"Authorization":"Bearer board-secret-token"}}}}`
	if got := m["AIWB_MCP_CONFIG"]; got != want {
		t.Fatalf("AIWB_MCP_CONFIG = %q\nwant %q", got, want)
	}
	for _, kv := range env {
		if strings.Contains(kv, boardToken) && !strings.HasPrefix(kv, "AIWB_MCP_CONFIG=") {
			t.Fatalf("board token leaked outside AIWB_MCP_CONFIG: %q", kv)
		}
	}

	// MCP unset → no config even with a run handle.
	m = envMap(s.env(agent.SpawnOptions{ChatID: "c1"}, "/bin/pi", "/sock", "run-9", ""))
	if _, ok := m["AIWB_MCP_CONFIG"]; ok {
		t.Errorf("MCP unset got AIWB_MCP_CONFIG %q", m["AIWB_MCP_CONFIG"])
	}

	// MCP set, no board extras → config present.
	m = envMap(s.env(agent.SpawnOptions{ChatID: "c1", MCP: mcp}, "/bin/pi", "/sock", "run-9", ""))
	if got := m["AIWB_MCP_CONFIG"]; got != want {
		t.Errorf("MCP set without board extras: AIWB_MCP_CONFIG = %q, want %q", got, want)
	}

	// The config no longer depends on a minted run handle: MCP with a URL gets
	// it even without one.
	m = envMap(s.env(agent.SpawnOptions{ChatID: "c1", MCP: mcp}, "/bin/pi", "/sock", "", ""))
	if got := m["AIWB_MCP_CONFIG"]; got != want {
		t.Errorf("MCP without a run handle: AIWB_MCP_CONFIG = %q, want %q", got, want)
	}

	// MCP with no URL gets no config.
	m = envMap(s.env(agent.SpawnOptions{ChatID: "c1", MCP: &agent.BoardAccess{Token: boardToken}},
		"/bin/pi", "/sock", "run-9", ""))
	if _, ok := m["AIWB_MCP_CONFIG"]; ok {
		t.Errorf("MCP without a URL got AIWB_MCP_CONFIG %q", m["AIWB_MCP_CONFIG"])
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
