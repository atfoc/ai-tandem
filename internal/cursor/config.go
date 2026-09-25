package cursor

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"ai-whiteboard/internal/store"
)

// configPath is $CURSOR_CONFIG_DIR/cli-config.json when that variable is set,
// else ~/.cursor/cli-config.json.
func configPath() (string, error) {
	if dir := os.Getenv("CURSOR_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "cli-config.json"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".cursor", "cli-config.json"), nil
}

// EnsureDenyRules adds deny rules for the app's folder to the user's Cursor CLI config
// (~/.cursor/cli-config.json, or $CURSOR_CONFIG_DIR/cli-config.json), keeping every other key.
func EnsureDenyRules(root string) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil // Cursor not set up; nothing to add
	}
	if err != nil {
		return err
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var cfg map[string]any
	if err := json.Unmarshal(b, &cfg); err != nil {
		return err // never overwrite a config we cannot read
	}
	if cfg == nil {
		cfg = map[string]any{}
	}
	var perms map[string]any
	switch p := cfg["permissions"].(type) {
	case nil:
		perms = map[string]any{"allow": []any{}, "deny": []any{}}
		cfg["permissions"] = perms
	case map[string]any:
		perms = p
	default:
		return fmt.Errorf("%s: \"permissions\" is not an object", path)
	}
	var deny []any
	switch d := perms["deny"].(type) {
	case nil:
		deny = []any{} // "deny" must exist (research gotcha)
	case []any:
		deny = d
	default:
		return fmt.Errorf("%s: \"permissions.deny\" is not a list", path)
	}
	have := map[string]bool{}
	for _, r := range deny {
		if s, ok := r.(string); ok {
			have[s] = true
		}
	}
	added := false
	for _, rule := range []string{"Read(" + root + "/**)", "Write(" + root + "/**)"} {
		if !have[rule] {
			deny = append(deny, rule)
			have[rule] = true
			added = true
		}
	}
	if !added {
		return nil
	}
	perms["deny"] = deny
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	return store.WriteFileAtomic(path, out, info.Mode().Perm())
}
