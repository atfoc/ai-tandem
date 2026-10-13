// Package store owns the data folder (~/.ai-whiteboard): its layout, state.json and server.json.
package store

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Paths is where everything lives. Root is ~/.ai-whiteboard unless -home says otherwise (tests).
type Paths struct {
	Root   string // ~/.ai-whiteboard
	Boards string // Root/boards
	Chats  string // Root/chats
	State  string // Root/state.json
	Server string // Root/server.json
}

func NewPaths(root string) Paths {
	return Paths{Root: root, Boards: filepath.Join(root, "boards"), Chats: filepath.Join(root, "chats"),
		State: filepath.Join(root, "state.json"), Server: filepath.Join(root, "server.json")}
}

func (p Paths) BoardDir(id string) string  { return filepath.Join(p.Boards, id) }
func (p Paths) BoardFile(id string) string { return filepath.Join(p.Boards, id, "drawing.excalidraw") }
func (p Paths) ChatDir(id string) string   { return filepath.Join(p.Chats, id) }

// RemoveRemote removes the folder Root/remote with everything in it: an earlier version of the app
// kept there what it knew of the chats, boards and runs on other servers. Nothing is kept of them
// now, so the folder is never made again. removed is false when there was none.
func RemoveRemote(p Paths) (removed bool, err error) {
	dir := filepath.Join(p.Root, "remote")
	if _, err := os.Lstat(dir); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	return true, os.RemoveAll(dir)
}

// Contains reports whether path is Root or inside it, after resolving ~, symlinks and "..".
func (p Paths) Contains(path string) bool {
	abs := resolve(expandHome(path))
	root := resolve(p.Root)
	return abs == root || strings.HasPrefix(abs, root+string(filepath.Separator))
}

// resolve cleans path and resolves symlinks in it. When path does not exist, its deepest
// existing ancestor is resolved and the rest is joined back on, so a missing file inside a
// symlinked folder still resolves to the real location.
func resolve(path string) string {
	path = filepath.Clean(path)
	if !filepath.IsAbs(path) {
		if a, err := filepath.Abs(path); err == nil {
			path = a
		}
	}
	rest := ""
	for cur := path; ; {
		if r, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(r, rest)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return path
		}
		rest = filepath.Join(filepath.Base(cur), rest)
		cur = parent
	}
}

// expandHome expands a leading "~" (alone or followed by "/") to the user's home folder.
func expandHome(path string) string {
	if path != "~" && !strings.HasPrefix(path, "~/") {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	return filepath.Join(home, path[1:])
}
