package pi

import (
	"encoding/json"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"ai-whiteboard/internal/agent"
)

// piMarkerEnv is the pi process-marker environment that must not leak into an app-run pi
// process: a server started from inside a pi session would otherwise poison the app's runs (the
// installed spawn-subagent extension, for one, silently disables itself on PI_SUBAGENT=1).
var piMarkerEnv = map[string]bool{
	"PI_SUBAGENT":        true,
	"PI_SESSION_ID":      true,
	"PI_SESSION_FILE":    true,
	"PI_PROVIDER":        true,
	"PI_MODEL":           true,
	"PI_REASONING_LEVEL": true,
	"PI_CODING_AGENT":    true,
	"AI_AGENT":           true,
}

// args are the command-line arguments for one chat process.
//
// --session-id is only in pi's --help, not in its usage or RPC docs, so it may disappear in a
// future pi. The documented fallback is the always-passed per-chat --session-dir plus a tracked
// --session <path> from get_state.sessionFile (or --continue); keeping the dir on every spawn is
// what keeps that fallback open.
//
// Built-in tools are deliberately not excluded (no --no-builtin-tools): the extension's tool_call
// hook gates them with permission cards. --no-extensions keeps user extensions out; the explicit
// -e loads only the app's extension.
func (s *Spawner) args(o agent.SpawnOptions, sessionDir, appendPromptFile string) []string {
	args := []string{"--mode", "rpc", "--no-extensions"}
	if s.Extension != "" {
		args = append(args, "-e", s.Extension)
	}
	args = append(args, "--session-dir", sessionDir)
	if o.SessionID != "" {
		args = append(args, "--session-id", o.SessionID)
	}
	if o.Model != "" {
		args = append(args, "--model", o.Model)
	}
	if o.Effort != "" {
		args = append(args, "--thinking", o.Effort)
	}
	if o.Board != nil && s.Prompt != "" && appendPromptFile != "" {
		args = append(args, "--append-system-prompt", appendPromptFile)
	}
	return append(args, "--no-approve")
}

// cleanEnv is the server's environment without the pi markers or any inherited AIWB_* value: a
// server started from inside a pi session must not leak its markers into the app's runs.
func (s *Spawner) cleanEnv() []string {
	out := make([]string, 0, len(os.Environ()))
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(k, "AIWB_") || piMarkerEnv[k] {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// mcpConfig is the Claude-compatible config object AIWB_MCP_CONFIG carries; its single board
// server is the app-owned board MCP endpoint (plan R2/R3).
type mcpConfig struct {
	MCPServers map[string]mcpServerConfig `json:"mcpServers"`
}

type mcpServerConfig struct {
	Type string `json:"type"`
	URL  string `json:"url"`
}

// boardMCPConfig builds the AIWB_MCP_CONFIG value for a board chat: the board endpoint's
// scheme+host with the board-token path segment replaced by the run token, so the URL is
// run-scoped and the board token never reaches the pi process (R3, R-leak). It returns "" when
// the chat has no board access, no run token was minted, or the base URL is empty; an
// unparseable non-empty URL is skipped with a server-side log rather than silently hiding the
// misconfiguration. extra is the test-only non-board server seam (see Spawner.mcpConfigExtra);
// it can never replace the app-owned "board" key.
func boardMCPConfig(board *agent.BoardAccess, runToken, chatID string, extra map[string]mcpServerConfig) string {
	if board == nil || runToken == "" || board.MCPURL == "" {
		return ""
	}
	u, err := url.Parse(board.MCPURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		log.Printf("pi: chat %s has an unusable board MCP URL %q; AIWB_MCP_CONFIG not injected", chatID, board.MCPURL)
		return ""
	}
	servers := map[string]mcpServerConfig{
		"board": {Type: "http", URL: u.Scheme + "://" + u.Host + "/mcp/" + url.PathEscape(runToken)},
	}
	for key, spec := range extra {
		if key == "board" {
			continue
		}
		servers[key] = spec
	}
	raw, err := json.Marshal(mcpConfig{MCPServers: servers})
	if err != nil {
		log.Printf("pi: chat %s: cannot encode the board MCP config: %v", chatID, err)
		return ""
	}
	return string(raw)
}

// env is the environment one chat process starts with: the server's environment without the pi
// markers or any inherited AIWB_* value, plus the per-run bridge and chat variables. bin is the
// resolved absolute pi path (children need it to spawn their own runs). Board chats whose run was
// registered also get the run-scoped AIWB_MCP_CONFIG; plain chats (and board chats without a run
// token or a usable MCP URL) get none (plan D/R3).
func (s *Spawner) env(o agent.SpawnOptions, bin, socketPath, runToken, appendPromptFile string) []string {
	out := s.cleanEnv()
	out = append(out,
		"AIWB_CHAT_ID="+o.ChatID,
		"AIWB_CHAT_DIR="+filepath.Join(s.AppRoot, "chats", o.ChatID),
		"AIWB_PI_BIN="+bin,
	)
	if socketPath != "" {
		out = append(out, "AIWB_BRIDGE_SOCKET="+socketPath)
	}
	if runToken != "" {
		out = append(out, "AIWB_BRIDGE_RUN="+runToken)
	}
	if cfg := boardMCPConfig(o.Board, runToken, o.ChatID, s.mcpConfigExtra); cfg != "" {
		out = append(out, "AIWB_MCP_CONFIG="+cfg)
	}
	if o.Model != "" {
		out = append(out, "AIWB_MODEL="+o.Model)
	}
	if o.Effort != "" {
		out = append(out, "AIWB_THINKING="+o.Effort)
	}
	if appendPromptFile != "" {
		out = append(out, "AIWB_APPEND_PROMPT="+appendPromptFile)
	}
	return out
}
