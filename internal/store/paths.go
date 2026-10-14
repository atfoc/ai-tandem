// Package store owns the data folder (~/.ai-whiteboard): its layout, state.json and server.json.
package store

import (
	"crypto/sha256"
	"encoding/hex"
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

// serverListFile is the name of the server list file an earlier version of the app kept in the
// data folder. A file that could not be read was renamed beside it as serverListFile +
// ".unreadable-<time>".
const serverListFile = "servers.json"

// RemoveServerList removes the server list of an earlier version of the app, servers.json in
// the data folder, with the copies of it that were set aside as unreadable: a server keeps no
// list of servers, and the secrets in it are the app's now. removed is false when there was
// nothing. Nothing else is touched.
func RemoveServerList(p Paths) (removed bool, err error) {
	names, err := filepath.Glob(filepath.Join(p.Root, serverListFile+".unreadable-*"))
	if err != nil {
		return false, err
	}
	names = append(names, filepath.Join(p.Root, serverListFile))
	var first error
	for _, name := range names {
		err := os.Remove(name)
		switch {
		case errors.Is(err, fs.ErrNotExist):
		case err != nil:
			if first == nil {
				first = err
			}
		default:
			removed = true
		}
	}
	return removed, first
}

// controlFallbackPrefix starts the name of ControlSocketPath's fallback folder; 16 hex digits follow it.
const controlFallbackPrefix = "aiwb-"

// ControlSocketPath is where the server's control socket is: <root>/control.sock, and when that
// path is longer than 100 bytes (a Unix socket path holds 104 on macOS) a short path under
// os.TempDir() keyed by a hash of root, so that a restart reuses it. The folder of the short path
// is the caller's to make, owner-only, and to remove again with RemoveControlSocket.
func ControlSocketPath(root string) string {
	path := filepath.Join(root, "control.sock")
	if len(path) <= 100 {
		return path
	}
	sum := sha256.Sum256([]byte(root))
	return filepath.Join(os.TempDir(), controlFallbackPrefix+hex.EncodeToString(sum[:8]), "control.sock")
}

// RemoveControlSocket removes the control socket file at path and its fallback folder, as
// RemoveControlFolder does.
func RemoveControlSocket(path string) {
	os.Remove(path)
	RemoveControlFolder(path)
}

// RemoveControlFolder removes the folder of the control socket at path when it is a fallback
// folder of ControlSocketPath (directly under os.TempDir(), named aiwb-<16 hex>) and is empty:
// another file in it (the extension bridge's socket, a running server's socket) keeps it. The data
// folder is never removed.
func RemoveControlFolder(path string) {
	dir := filepath.Dir(path)
	name := filepath.Base(dir)
	if filepath.Dir(dir) != filepath.Clean(os.TempDir()) || len(name) != len(controlFallbackPrefix)+16 || name[:len(controlFallbackPrefix)] != controlFallbackPrefix {
		return
	}
	if _, err := hex.DecodeString(name[len(controlFallbackPrefix):]); err != nil {
		return
	}
	os.Remove(dir) // fails, as wanted, when something else is in it
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
