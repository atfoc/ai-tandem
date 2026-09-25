package agent

import (
	"encoding/json"
	"path/filepath"
	"strings"
)

const AppDirDenied = "AI Whiteboard does not allow agents to touch its own folder. Use the board tools."

// TouchesAppDir reports whether a tool input (command, path, url…) refers to the app's folder.
// root is the absolute data folder. It checks the raw JSON text for root, for "~/"+rel(home, root),
// and for the folder's base name (".ai-whiteboard").
func TouchesAppDir(input json.RawMessage, root, home string) bool {
	if len(input) == 0 || root == "" {
		return false
	}
	raw := string(input)
	// JSON may escape "/" as "\/"; check the unescaped form too.
	texts := []string{raw, strings.ReplaceAll(raw, `\/`, "/")}
	root = filepath.Clean(root)
	needles := []string{root}
	if home != "" {
		if rel, err := filepath.Rel(filepath.Clean(home), root); err == nil && rel != "." && !strings.HasPrefix(rel, "..") {
			needles = append(needles, "~/"+rel)
		}
	}
	if base := filepath.Base(root); base != "/" && base != "." {
		needles = append(needles, base)
	}
	for _, t := range texts {
		for _, n := range needles {
			if strings.Contains(t, n) {
				return true
			}
		}
	}
	return false
}
