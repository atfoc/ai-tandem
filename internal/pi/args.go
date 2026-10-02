package pi

import (
	"encoding/json"
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
// hook still routes them through the bridge, where the adapter auto-approves them and refuses
// only inputs touching the app's own folder. --no-extensions keeps user extensions out; the explicit
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
	Type    string            `json:"type"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
}

// boardMCPConfig builds the AIWB_MCP_CONFIG value for a board chat: the fixed board MCP endpoint
// with the chat's durable board token in the Authorization header (plan D5/D16). It returns ""
// when the chat has no board access or no MCP URL. extra is the test-only non-board server seam
// (see Spawner.mcpConfigExtra); it can never replace the app-owned "board" key.
func boardMCPConfig(board *agent.BoardAccess, extra map[string]mcpServerConfig) string {
	if board == nil || board.MCPURL == "" {
		return ""
	}
	servers := map[string]mcpServerConfig{
		"board": {Type: "http", URL: board.MCPURL, Headers: map[string]string{
			"Authorization": "Bearer " + board.Token}},
	}
	for key, spec := range extra {
		if key == "board" {
			continue
		}
		servers[key] = spec
	}
	raw, err := json.Marshal(mcpConfig{MCPServers: servers})
	if err != nil { // cannot happen with the string fields this config holds
		return ""
	}
	return string(raw)
}

// env is the environment one chat process starts with: the server's environment without the pi
// markers or any inherited AIWB_* value, plus the per-run bridge handle and chat variables. bin is
// the resolved absolute pi path (children need it to spawn their own runs). Board chats get the
// fixed endpoint and the board-token header inside AIWB_MCP_CONFIG; the board token appears only
// there, never in argv or a URL. Plain chats get no board config (plan D5/D16).
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
	if cfg := boardMCPConfig(o.Board, s.mcpConfigExtra); cfg != "" {
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
