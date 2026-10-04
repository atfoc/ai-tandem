package cursor

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
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
// Task; user_message is the only field the model receives.
const taskDenyCommand = `echo '{"permission":"deny","user_message":"Native subagents (the Task tool) are disabled in this chat. To delegate, use spawn_subagent (asynchronous; it returns a receipt immediately, and the app sends you the result later as a message). Do not use native Task."}'`

type taskHookFile struct {
	Version int `json:"version"`
	Hooks   struct {
		PreToolUse []taskHook `json:"preToolUse"`
	} `json:"hooks"`
}

type taskHook struct {
	Command    string `json:"command"`
	Matcher    string `json:"matcher"`
	FailClosed bool   `json:"failClosed"`
}

// writeTaskHook writes <dataDir>/projects/<slug(cwd)>/.cursor/hooks.json with a fail-closed
// preToolUse deny of Task. cwd is the exact string sent in session/new (o.Cwd), not its realpath.
func writeTaskHook(dataDir, cwd string) error {
	dir := filepath.Join(dataDir, "projects", cwdSlug(cwd), ".cursor")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	var doc taskHookFile
	doc.Version = 1
	doc.Hooks.PreToolUse = []taskHook{{
		Command:    taskDenyCommand,
		Matcher:    "^Task$",
		FailClosed: true,
	}}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	return os.WriteFile(filepath.Join(dir, "hooks.json"), b, 0o644)
}
