package pi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/boardtools"
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
// A read-only process gets --tools, an allowlist: pi's read tools and the app's MCP tools it may
// call (readOnlyTools). There is no bash, write or edit then, and every extension tool that is not
// named is removed too. An unattended process needs nothing more: pi never asks, the bridge
// approves every call (perm.go).
//
// A DeepSeek Flash model gets a second --append-system-prompt with the bash-timeout reminder:
// those models tend to run bash commands without a timeout and can hang a run. pi accepts the
// flag multiple times and joins the values with blank lines, so the reminder follows the board
// prompt.
func (s *Spawner) args(o agent.SpawnOptions, sessionDir, appendPromptFile string) []string {
	return s.sessionArgs(o, sessionDir, appendPromptFile, "")
}

// sessionArgs is args for a process that may start on a fork: a non-empty forkFile is the source
// session file, opened with --session instead of --session-id (o.SessionID is then ignored). The
// session dir stays the chat's own, so the fork or clone sent in the handshake writes the new
// session file there, not next to the source.
func (s *Spawner) sessionArgs(o agent.SpawnOptions, sessionDir, appendPromptFile, forkFile string) []string {
	args := []string{"--mode", "rpc", "--no-extensions"}
	if s.Extension != "" {
		args = append(args, "-e", s.Extension)
	}
	args = append(args, "--session-dir", sessionDir)
	if forkFile != "" {
		args = append(args, "--session", forkFile)
	} else if o.SessionID != "" {
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
	if o.ReadOnly {
		args = append(args, "--tools", strings.Join(readOnlyTools(o), ","))
	}
	return append(args, "--no-approve")
}

// readOnlyTools is the --tools list of a read-only process: pi's built-in tools that only read,
// and the app's MCP tools the process may call, by the names the extension registers them under.
// Those are o.MCPTools when set; else the board tools when board extras are on and the spawn
// family when this is the chat agent, as for the other agents. Without MCP there are none.
func readOnlyTools(o agent.SpawnOptions) []string {
	tools := []string{"read", "grep", "find", "ls"}
	if o.MCP == nil || o.MCP.MCPURL == "" {
		return tools
	}
	if o.MCPTools != nil {
		for _, name := range o.MCPTools {
			tools = append(tools, "mcp__board__"+name)
		}
		return tools
	}
	if o.BoardID != "" {
		for _, t := range boardtools.Tools {
			tools = append(tools, "mcp__board__"+t.Name)
		}
	}
	if !o.Subagent {
		for _, t := range boardtools.SpawnFamily {
			tools = append(tools, "mcp__board__"+t.Name)
		}
	}
	return tools
}

// chatDir is the folder of a chat object: dir when the caller names it (SpawnOptions.Dir,
// ForkSource.Dir), else <AppRoot>/chats/<chatID>. pi's session files are in its "pi" folder.
func (s *Spawner) chatDir(chatID, dir string) string {
	if dir != "" {
		return dir
	}
	return filepath.Join(s.AppRoot, "chats", chatID)
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

// mcpConfig is the Claude-compatible config object the file AIWB_MCP_CONFIG_FILE names holds; its
// single board server is the app-owned board MCP endpoint (plan R2/R3).
type mcpConfig struct {
	MCPServers map[string]mcpServerConfig `json:"mcpServers"`
}

type mcpServerConfig struct {
	Type    string            `json:"type"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
}

// boardMCPConfig builds the content of the MCP config file: the fixed MCP endpoint with this
// process's token in the Authorization header. It returns "" when MCP is unset or has no URL. extra is the
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

// mcpConfigFile is the name of the MCP config file in a chat object's folder.
const mcpConfigFile = "mcp.json"

// mcpConfigPath is where the MCP config file of o's process is: in the folder of the chat object
// (o.Dir, else <AppRoot>/chats/<ChatID>), which is under the app's folder. An app-spawned
// subagent's folder is its own, so its token has its own file.
func (s *Spawner) mcpConfigPath(o agent.SpawnOptions) string {
	return filepath.Join(s.chatDir(o.ChatID, o.Dir), mcpConfigFile)
}

// writeMCPConfig writes the MCP config file of o's process, readable by the user only, and
// reports whether o has a config at all (MCP set, with a URL). The token is in this file and not
// in the environment because the start environment of a process is readable by every process of
// the same user (ps eww), also after the extension deleted the variable. It is written at every
// start, since the token may differ from the last process's, and put in place by a rename: a
// process of the same chat that is reading it sees the old file or the new one, never half of
// one. Nothing removes it but the removal of the chat's folder.
func (s *Spawner) writeMCPConfig(o agent.SpawnOptions) (bool, error) {
	cfg := boardMCPConfig(o.MCP, s.mcpConfigExtra)
	if cfg == "" {
		return false, nil
	}
	path := s.mcpConfigPath(o)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return false, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "mcp-*.tmp") // made with mode 0600
	if err != nil {
		return false, err
	}
	_, err = tmp.WriteString(cfg)
	if err2 := tmp.Close(); err == nil {
		err = err2
	}
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	if err != nil {
		os.Remove(tmp.Name())
	}
	return err == nil, err
}

// env is the environment one chat process starts with: the server's environment without the pi
// markers or any inherited AIWB_* value, plus the per-run bridge handle and chat variables. bin is
// the resolved absolute pi path (children need it to spawn their own runs). mcpConfigFile is the
// path of the written MCP config file ("" = the process has none): the fixed endpoint and the
// token header are in that file, and the token is never in the environment, argv or a URL. Board
// extras (append-prompt path) stay board-only.
func (s *Spawner) env(o agent.SpawnOptions, bin, socketPath, runToken, appendPromptFile, mcpConfigFile string) []string {
	out := s.cleanEnv()
	out = append(out,
		"AIWB_CHAT_ID="+o.ChatID,
		"AIWB_CHAT_DIR="+s.chatDir(o.ChatID, o.Dir),
		"AIWB_PI_BIN="+bin,
	)
	if socketPath != "" {
		out = append(out, "AIWB_BRIDGE_SOCKET="+socketPath)
	}
	if runToken != "" {
		out = append(out, "AIWB_BRIDGE_RUN="+runToken)
	}
	if mcpConfigFile != "" {
		out = append(out, "AIWB_MCP_CONFIG_FILE="+mcpConfigFile)
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
