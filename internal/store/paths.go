// Package store owns the data folder (~/.ai-whiteboard): its layout, state.json and server.json.
package store

import (
	"os"
	"path/filepath"
	"strings"
)

// Paths is where everything lives. Root is ~/.ai-whiteboard unless -home says otherwise (tests).
type Paths struct {
	Root    string // ~/.ai-whiteboard
	Boards  string // Root/boards
	Chats   string // Root/chats
	Runs    string // Root/runs
	RunWork string // <parent of Root>/aiwb-run-work: the checkouts run agents work in; never inside Root
	State   string // Root/state.json
	Server  string // Root/server.json
	// RemoteChats holds what this server keeps of the chats that run on other servers, one file
	// each (Root/remote/chats). It is created on first use, not by Open.
	RemoteChats string
	// RemoteRuns holds what this server keeps of the runs that run on other servers, one file
	// each (Root/remote/runs). It is created on first use, not by Open.
	RemoteRuns string
	// RemoteBoards holds what this server keeps of the boards that live on other servers, one
	// file each (Root/remote/boards). It is created on first use, not by Open.
	RemoteBoards string
}

func NewPaths(root string) Paths {
	return Paths{Root: root, Boards: filepath.Join(root, "boards"), Chats: filepath.Join(root, "chats"),
		Runs: filepath.Join(root, "runs"), RunWork: filepath.Join(filepath.Dir(filepath.Clean(root)), "aiwb-run-work"),
		State: filepath.Join(root, "state.json"), Server: filepath.Join(root, "server.json"),
		RemoteChats: filepath.Join(root, "remote", "chats"), RemoteRuns: filepath.Join(root, "remote", "runs"),
		RemoteBoards: filepath.Join(root, "remote", "boards")}
}

func (p Paths) BoardDir(id string) string  { return filepath.Join(p.Boards, id) }
func (p Paths) BoardFile(id string) string { return filepath.Join(p.Boards, id, "drawing.excalidraw") }
func (p Paths) ChatDir(id string) string   { return filepath.Join(p.Chats, id) }

// RemoteChatFile is the file of the remote chat id (RemoteChats/<id>.json).
func (p Paths) RemoteChatFile(id string) string { return filepath.Join(p.RemoteChats, id+".json") }

// RemoteRunFile is the file of the remote run id (RemoteRuns/<id>.json).
func (p Paths) RemoteRunFile(id string) string { return filepath.Join(p.RemoteRuns, id+".json") }

// RemoteBoardFile is the file of the remote board id (RemoteBoards/<id>.json).
func (p Paths) RemoteBoardFile(id string) string { return filepath.Join(p.RemoteBoards, id+".json") }

// RunDir is a run's folder: run.json, the journal, the checkpoint and text files, and the folders
// of its chats.
func (p Paths) RunDir(id string) string { return filepath.Join(p.Runs, id) }

// RunChatDir is the folder of a chat object that belongs to a run: one of the run's agents
// (agent true: Runs/<run>/agents/<id>) or a person's chat on the run (Runs/<run>/chats/<id>).
func (p Paths) RunChatDir(run string, agent bool, id string) string {
	if agent {
		return filepath.Join(p.Runs, run, "agents", id)
	}
	return filepath.Join(p.Runs, run, "chats", id)
}

// RunWorkDir is where a run's checkouts are made (RunWork/<run>). It is outside Root, because an
// agent's working folder cannot be inside the app's own; it is created on first use, not by Open.
func (p Paths) RunWorkDir(run string) string { return filepath.Join(p.RunWork, run) }

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
