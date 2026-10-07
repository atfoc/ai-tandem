package chats

import (
	"path/filepath"
	"strings"
)

// Known reports whether id is the id of something this manager has: a chat object it holds (a
// chat, a branch, a fork, a run agent's chat), or a chat folder on disk, in chats/ or under a
// run, loaded or not. It is for whoever is given an id by another server and must not keep
// anything of its own under the id of a chat here. An id that cannot name a folder (empty, a
// path, "." or "..") is known only as a chat object.
func (m *Manager) Known(id string) bool {
	if _, err := m.get(id); err == nil {
		return true
	}
	if id == "" || id == "." || id == ".." || strings.ContainsAny(id, `/\`) || filepath.Base(id) != id {
		return false
	}
	return m.idTaken(id)
}
