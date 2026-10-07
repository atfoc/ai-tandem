package store

import (
	"path/filepath"
	"strings"
)

// InRunWork reports whether path is RunWork or inside it, after resolving ~, symlinks and ".."
// (as Contains does for Root). The names in RunWork are the ids of the runs.
func (p Paths) InRunWork(path string) bool {
	abs := resolve(expandHome(path))
	work := resolve(p.RunWork)
	return abs == work || strings.HasPrefix(abs, work+string(filepath.Separator))
}
