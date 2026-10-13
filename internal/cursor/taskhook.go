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

// cwdSlug is Cursor's ACP project-dir slug: every run of non-alphanumerics in the session cwd
// string (as sent in session/new, not realpath) becomes "-", then leading/trailing "-" are trimmed.
func cwdSlug(cwd string) string {
	return strings.Trim(nonAlnum.ReplaceAllString(cwd, "-"), "-")
}

var nonAlnum = regexp.MustCompile(`[^A-Za-z0-9]+`)

// taskDenyCommand is a static echo of the preToolUse deny JSON. Matcher already restricts it to
// Task; user_message is the only field the model receives. The file is one for every process in
// a chat's folder, so the text cannot say whether the process that reads it has the spawn family
// (a chat whose subagents are off and a subagent at the deepest level have none).
const taskDenyCommand = `echo '{"permission":"deny","user_message":"Native subagents (the Task tool) are disabled in this chat. To delegate, use spawn_subagent if you have that tool (asynchronous; it returns a receipt immediately, and the app sends you the result later as a message). Do not use native Task."}'`

type hookFile struct {
	Version int `json:"version"`
	Hooks   struct {
		PreToolUse []hookEntry `json:"preToolUse"`
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
// not ask before each call (its approval mode "unrestricted"): its shell would otherwise read the
// app's data, which the permission-request check then never sees and the Read/Write deny rules of
// cli-config.json do not cover. A call that does not name the folder gets no decision ({}), so
// whatever else decides about it still does.
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

// writeHooks writes <dataDir>/projects/<slug(cwd)>/.cursor/hooks.json, with fail-closed
// preToolUse hooks: the deny of Task and the app-folder guard (appDirGuard). cwd is the exact
// string sent in session/new (SpawnOptions.Cwd), not its realpath. Several denies of one call add
// up: Cursor refuses a call that any hook refuses.
func (s *Spawner) writeHooks(dataDir, cwd string) error {
	dir := filepath.Join(dataDir, "projects", cwdSlug(cwd), ".cursor")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	var doc hookFile
	doc.Version = 1
	doc.Hooks.PreToolUse = []hookEntry{{Command: taskDenyCommand, Matcher: "^Task$", FailClosed: true}}
	if guard, ok := s.appDirGuard(dataDir, cwd); ok {
		doc.Hooks.PreToolUse = append(doc.Hooks.PreToolUse, hookEntry{Command: guard, FailClosed: true})
	}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	return writeHookFile(filepath.Join(dir, "hooks.json"), b)
}

// writeHookFile makes path hold exactly b. Every process in one chat folder shares the file and
// each start writes it, while Cursor obeys no hook at all when it reads the file empty: so a file
// that already holds b is left alone, and any other is replaced in one step (a rename), never
// emptied and filled.
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
