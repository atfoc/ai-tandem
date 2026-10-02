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
//
// A DeepSeek Flash model gets a second --append-system-prompt with the bash-timeout reminder:
// those models tend to run bash commands without a timeout and can hang a run. pi accepts the
// flag multiple times and joins the values with blank lines, so the reminder follows the board
// prompt.
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
	if o.BoardID != "" && s.Prompt != "" && appendPromptFile != "" {
		args = append(args, "--append-system-prompt", appendPromptFile)
	}
	if isDeepSeekFlash(o.Model) {
		args = append(args, "--append-system-prompt", bashTimeoutReminder)
	}
	return append(args, "--no-approve")
}

// bashTimeoutReminder is the extra system-prompt line DeepSeek Flash models get (see args).
const bashTimeoutReminder = "Never run bash commands without timeout"

// isDeepSeekFlash reports whether a model choice names a DeepSeek Flash model: V4 Flash, V4.1
// Flash, their aliases and dated variants, and provider-qualified catalog ids such as
// "openrouter/deepseek/deepseek-v4.1-flash". The match is deliberately broad so a new DeepSeek
// Flash release keeps the reminder.
func isDeepSeekFlash(model string) bool {
	m := strings.ToLower(model)
	return strings.Contains(m, "deepseek") && strings.Contains(m, "flash")
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

// boardMCPConfig builds the AIWB_MCP_CONFIG value: the fixed MCP endpoint with this process's
// token in the Authorization header. It returns "" when MCP is unset or has no URL. extra is the
// test-only non-board server seam (see Spawner.mcpConfigExtra); it can never replace the app-owned
// "board" key.
func boardMCPConfig(mcp *agent.BoardAccess, extra map[string]mcpServerConfig) string {
	if mcp == nil || mcp.MCPURL == "" {
		return ""
	}
	servers := map[string]mcpServerConfig{
		"board": {Type: "http", URL: mcp.MCPURL, Headers: map[string]string{
			"Authorization": "Bearer " + mcp.Token}},
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
// the resolved absolute pi path (children need it to spawn their own runs). Whenever MCP is set
// the process gets the fixed endpoint and its token header inside AIWB_MCP_CONFIG; the token
// appears only there, never in argv or a URL. Board extras (append-prompt path) stay board-only.
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
	if cfg := boardMCPConfig(o.MCP, s.mcpConfigExtra); cfg != "" {
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
