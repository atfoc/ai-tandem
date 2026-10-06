package cursor

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"ai-whiteboard/internal/agent"
)

// cursorDataDir is the app-owned Cursor ACP data directory, a sibling of the store:
// filepath.Join(filepath.Dir(AppRoot), "cursor-acp"). If AppRoot is $HOME/<store>, that is
// $HOME/cursor-acp — outside AppRoot (Cursor tells the model about files under
// projects/<slug>/, and the app rejects permission requests that mention AppRoot via
// agent.TouchesAppDir) and not the user's default Cursor config dir. If AppRoot is empty, a
// fallback that is still not that default config dir is used.
func (s *Spawner) cursorDataDir() string {
	if s.AppRoot != "" {
		return filepath.Join(filepath.Dir(s.AppRoot), "cursor-acp")
	}
	if s.Home != "" {
		return filepath.Join(s.Home, "cursor-acp")
	}
	return filepath.Join(os.TempDir(), "aiwb-cursor-acp")
}

// dataDir is the CURSOR_DATA_DIR of one process: cursorDataDir, or "cursor-acp-ro" beside it for
// a read-only process. The hook file is one per (data dir, chat folder) and a read-only process
// has an entry no other process may get, so the two kinds never share a file, even in one folder.
func (s *Spawner) dataDir(readOnly bool) string {
	if readOnly {
		return s.cursorDataDir() + "-ro"
	}
	return s.cursorDataDir()
}

// cwdSlug is Cursor's ACP project-dir slug: every run of non-alphanumerics in the session cwd
// string (as sent in session/new, not realpath) becomes "-", then leading/trailing "-" are trimmed.
func cwdSlug(cwd string) string {
	return strings.Trim(nonAlnum.ReplaceAllString(cwd, "-"), "-")
}

var nonAlnum = regexp.MustCompile(`[^A-Za-z0-9]+`)

// taskDenyCommand is a static echo of the preToolUse deny JSON. Matcher already restricts it to
// Task; user_message is the only field the model receives.
const taskDenyCommand = `echo '{"permission":"deny","user_message":"Native subagents (the Task tool) are disabled in this chat. To delegate, use spawn_subagent (asynchronous; it returns a receipt immediately, and the app sends you the result later as a message). Do not use native Task."}'`

// readOnlyDenied is what a read-only process is told when it calls a tool that changes files.
const readOnlyDenied = "This agent is read-only: it cannot create, change or delete files or run shell commands. Use the read and search tools (Read, Grep)."

// readOnlyMatcher matches every tool a read-only process is refused: all of them, except the
// tools that only read files and the MCP tools. It names what is allowed, not what is refused, so
// that a tool Cursor adds or renames is refused until it is listed here.
//
// The names are the tool_name of Cursor's preToolUse payload (cursor-agent 2026.10.01-e373342).
// Seen in a live run: Read; Grep (a search, and a listing by glob); and, all refused, Write (a
// new file and an edit alike, and Cursor's own saving of a long tool result), Delete, Shell,
// WebSearch, WebFetch and FetchMcpResource. Read in Cursor's code and not seen: List and
// ReadLints, which only read, and that a call of an MCP tool is named "MCP:<tool>" whatever its
// server is. Which server it is only the beforeMCPExecution payload says (otherServerDeny).
const readOnlyMatcher = "^(?!(Read|Grep|List|ReadLints)$|MCP:)"

// notMCPMatcher matches every tool except the MCP tools ("MCP:<tool>").
const notMCPMatcher = "^(?!MCP:)"

// readOnlyServerDenied is what a read-only process is told when it calls a tool of an MCP server
// that is not the app's.
const readOnlyServerDenied = "This agent is read-only: of the MCP tools it can call only those of the board server."

type hookFile struct {
	Version int `json:"version"`
	Hooks   struct {
		PreToolUse []hookEntry `json:"preToolUse"`
		// Runs before a call of an MCP tool, after preToolUse. Its payload names the server:
		// "mcp_server_name" (and "mcp_server_url"), with the tool's bare name in "tool_name" and
		// its arguments as one JSON string in "tool_input".
		BeforeMCPExecution []hookEntry `json:"beforeMCPExecution,omitempty"`
	} `json:"hooks"`
}

// hookEntry is one preToolUse hook: a shell command that gets the call as JSON on stdin and
// prints its decision. Without a matcher it runs for every tool.
type hookEntry struct {
	Command    string `json:"command"`
	Matcher    string `json:"matcher,omitempty"`
	FailClosed bool   `json:"failClosed"`
}

// shellQuote quotes s as one word of a POSIX shell command.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// denyEcho is a hook command that refuses the call: an echo of the deny decision, whose
// user_message is the only text the model receives.
func denyEcho(message string) string {
	return "echo " + shellQuote(string(mustJSON(map[string]string{"permission": "deny", "user_message": message})))
}

// appDirGuard is the hook command that refuses every tool call whose payload names the app's
// folder by its base name, the same test as agent.TouchesAppDir. It is needed because Cursor does
// not ask before each call (its approval mode "unrestricted", or --force): its shell would
// otherwise read the app's data, which the permission-request check then never sees and the
// Read/Write deny rules of cli-config.json do not cover. A call that does not name the folder
// gets no decision ({}), so whatever else decides about it still does.
//
// The payload also carries the session's workspace_roots and transcript_path, so the command
// would refuse every call of a process whose chat folder or data dir has the base name in its
// path: ok is false then, and when there is no app folder to guard. The match is on the payload's
// text: a base name that JSON writes with an escape (a quote, a backslash) would not be found.
func (s *Spawner) appDirGuard(dataDir, cwd string) (command string, ok bool) {
	if s.AppRoot == "" {
		return "", false
	}
	base := filepath.Base(filepath.Clean(s.AppRoot))
	if base == "/" || base == "." {
		return "", false
	}
	for _, path := range []string{cwd, dataDir} {
		if strings.Contains(path, base) {
			return "", false
		}
		if real, err := filepath.EvalSymlinks(path); err == nil && strings.Contains(real, base) {
			return "", false
		}
	}
	return "if grep -q -F -e " + shellQuote(base) + "; then " + denyEcho(agent.AppDirDenied) + "; else echo '{}'; fi", true
}

// boardServer is how the beforeMCPExecution payload names the app's MCP server (mcpServers gives
// it the name "board"). The payload is one line of JSON without spaces, and the tool's arguments
// are a string inside it, whose quotes are escaped: so no argument can spell this.
const boardServer = `"mcp_server_name":"board"`

// otherServerDeny is a beforeMCPExecution hook command: it refuses, with message, the call of a
// tool of an MCP server that is not the app's; with a needle only when the payload contains it.
// A payload that names no server in the way boardServer is written gets no decision: the command
// refuses only what it can see is another server's, since the payload's shape was read in
// Cursor's code, not seen (where Cursor loads no MCP server but the app's, none can be tried).
func otherServerDeny(message, needle string) string {
	other := `*'"mcp_server_name":"'*`
	if needle != "" {
		other = "*" + shellQuote(needle) + "*"
	}
	return `p=$(cat); case "$p" in *` + shellQuote(boardServer) + `*) echo '{}';; ` + other + `) ` + denyEcho(message) + `;; *) echo '{}';; esac`
}

// writeHooks writes <dataDir>/projects/<slug(cwd)>/.cursor/hooks.json for the process of o, with
// fail-closed preToolUse hooks: the deny of Task, the app-folder guard (appDirGuard) and, for a
// read-only process, the deny of every tool but the reading ones and the MCP tools. cwd is the
// exact string sent in session/new (o.Cwd), not its realpath. Several denies of one call add up:
// Cursor refuses a call that any hook refuses.
//
// The guard is for file and shell tools. An unattended process's guard leaves the MCP tools out:
// a run's agent writes about the project it works on to the app's own tools (notes, tasks), and
// that project can be one whose files name the app's folder. Which calls the app's server may
// take the server decides. preToolUse does not say whose an MCP tool is, so the tools of other
// MCP servers get the guard, and a read-only process their refusal, in beforeMCPExecution. A
// chat's file is as it always was.
func (s *Spawner) writeHooks(dataDir string, o agent.SpawnOptions) error {
	dir := filepath.Join(dataDir, "projects", cwdSlug(o.Cwd), ".cursor")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	var doc hookFile
	doc.Version = 1
	doc.Hooks.PreToolUse = []hookEntry{{Command: taskDenyCommand, Matcher: "^Task$", FailClosed: true}}
	if guard, ok := s.appDirGuard(dataDir, o.Cwd); ok {
		entry := hookEntry{Command: guard, FailClosed: true}
		if o.Unattended {
			entry.Matcher = notMCPMatcher
			base := filepath.Base(filepath.Clean(s.AppRoot))
			doc.Hooks.BeforeMCPExecution = append(doc.Hooks.BeforeMCPExecution,
				hookEntry{Command: otherServerDeny(agent.AppDirDenied, base), FailClosed: true})
		}
		doc.Hooks.PreToolUse = append(doc.Hooks.PreToolUse, entry)
	}
	if o.ReadOnly {
		doc.Hooks.PreToolUse = append(doc.Hooks.PreToolUse,
			hookEntry{Command: denyEcho(readOnlyDenied), Matcher: readOnlyMatcher, FailClosed: true})
		doc.Hooks.BeforeMCPExecution = append(doc.Hooks.BeforeMCPExecution,
			hookEntry{Command: otherServerDeny(readOnlyServerDenied, ""), FailClosed: true})
	}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	return writeHookFile(filepath.Join(dir, "hooks.json"), b)
}

// writeHookFile makes path hold exactly b. Every process of one kind in one chat folder shares
// the file and each start writes it, while Cursor obeys no hook at all when it reads the file
// empty: so a file that already holds b is left alone, and any other is replaced in one step (a
// rename), never emptied and filled.
func writeHookFile(path string, b []byte) error {
	if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, b) {
		return nil
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "hooks-*.tmp")
	if err != nil {
		return err
	}
	_, err = tmp.Write(b)
	if err == nil {
		err = tmp.Chmod(0o644)
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	if err != nil {
		os.Remove(tmp.Name())
	}
	return err
}
