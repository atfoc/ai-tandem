package pi

import (
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
)

func TestArgs(t *testing.T) {
	board := &agent.BoardAccess{Token: "tok"}
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
				"--thinking", "high", "--no-approve"},
		},
		{
			name: "board chat with prompt file", s: ext,
			o:   agent.SpawnOptions{SessionID: "s", Board: board},
			dir: "d", prompt: "d/append-prompt.md",
			want: []string{"--mode", "rpc", "--no-extensions", "-e", "/ext/index.ts",
				"--session-dir", "d", "--session-id", "s", "--append-system-prompt", "d/append-prompt.md",
				"--no-approve"},
		},
		{
			name: "board chat without a prompt", s: ext,
			o:   agent.SpawnOptions{Board: board},
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

// TestEnvBoardMCPConfig pins the run-scoped AIWB_MCP_CONFIG contract (A1/A2,
// R3, R-leak): only a board chat with a minted run token and a usable MCP URL
// gets the config, the URL keeps the board endpoint's scheme+host with the run
// token as the path credential, and the board token appears nowhere in the env.
func TestEnvBoardMCPConfig(t *testing.T) {
	const boardToken = "board-secret-token"
	s := &Spawner{AppRoot: "/app"}
	board := &agent.BoardAccess{
		MCPURL: "http://127.0.0.1:45231/mcp/" + boardToken,
		Token:  boardToken,
	}

	env := s.env(agent.SpawnOptions{ChatID: "c1", Board: board}, "/bin/pi", "/sock", "run-9", "")
	m := envMap(env)
	want := `{"mcpServers":{"board":{"type":"http","url":"http://127.0.0.1:45231/mcp/run-9"}}}`
	if got := m["AIWB_MCP_CONFIG"]; got != want {
		t.Fatalf("AIWB_MCP_CONFIG = %q\nwant %q", got, want)
	}
	for _, kv := range env {
		if strings.Contains(kv, boardToken) {
			t.Fatalf("board token leaked into the env: %q", kv)
		}
	}

	// A plain chat gets no config even with a run token.
	m = envMap(s.env(agent.SpawnOptions{ChatID: "c1"}, "/bin/pi", "/sock", "run-9", ""))
	if _, ok := m["AIWB_MCP_CONFIG"]; ok {
		t.Errorf("plain chat got AIWB_MCP_CONFIG %q", m["AIWB_MCP_CONFIG"])
	}

	// A board chat without a minted run token gets no config.
	m = envMap(s.env(agent.SpawnOptions{ChatID: "c1", Board: board}, "/bin/pi", "/sock", "", ""))
	if _, ok := m["AIWB_MCP_CONFIG"]; ok {
		t.Errorf("board chat without a run token got AIWB_MCP_CONFIG %q", m["AIWB_MCP_CONFIG"])
	}

	// A board chat with no MCP URL gets no config.
	m = envMap(s.env(agent.SpawnOptions{ChatID: "c1", Board: &agent.BoardAccess{Token: boardToken}},
		"/bin/pi", "/sock", "run-9", ""))
	if _, ok := m["AIWB_MCP_CONFIG"]; ok {
		t.Errorf("board chat without an MCP URL got AIWB_MCP_CONFIG %q", m["AIWB_MCP_CONFIG"])
	}

	// An unparseable MCP URL is skipped instead of injecting a broken config.
	m = envMap(s.env(agent.SpawnOptions{ChatID: "c1", Board: &agent.BoardAccess{
		MCPURL: "http://[::1]:namedport/mcp/" + boardToken, Token: boardToken}},
		"/bin/pi", "/sock", "run-9", ""))
	if _, ok := m["AIWB_MCP_CONFIG"]; ok {
		t.Errorf("board chat with an unparseable MCP URL got AIWB_MCP_CONFIG %q", m["AIWB_MCP_CONFIG"])
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
