// Package aliases owns the Claude accounts of a server (an account is an alias on the board):
// their records in <data>/aliases.json, their folders <data>/aliases/<id>, saved versus applied
// mounts and image ("restart needed"), and the service that ties an account to its container
// (internal/container), its Claude (internal/claude) and the chats that run on it.
//
// An account is the agent kind model.AliasKind(id). The computer's own Claude Code is not an
// account and is never touched here, but for reading its login (auth status) for the first row.
package aliases

import (
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/model"
)

// Alias is the record of one account, as aliases.json keeps it.
type Alias struct {
	ID      string    `json:"id"` // "a_" + 8 base36 (model.NewID("a_"))
	Name    string    `json:"name"`
	Image   string    `json:"image,omitempty"` // "" = the default image (container.DefaultImage)
	Mounts  []string  `json:"mounts"`          // absolute host paths, as saved, in the order given
	Applied *Applied  `json:"applied,omitempty"`
	Created time.Time `json:"created"`
	// LastLogin is what Claude's own auth status last answered for the account: what the account
	// shows while its container is not running (no container is started just to ask). nil = never
	// asked. Views leave it out: their Login says the same.
	LastLogin *LastLogin `json:"lastLogin,omitempty"`
}

// LastLogin is one answer of auth status, kept with the account's record.
type LastLogin struct {
	LoggedIn bool      `json:"loggedIn"`
	Email    string    `json:"email,omitempty"`
	Checked  time.Time `json:"checked"`
}

// Applied is what the account's existing container was created with; nil = no container yet
// (or it was removed).
type Applied struct {
	Image string `json:"image"` // the effective image, never ""
	// Default: the container was made for the default image (the record's Image was ""), whatever
	// tag of it that was.
	Default bool     `json:"default,omitempty"`
	Mounts  []string `json:"mounts"`
}

// Kind is the account's agent kind.
func (a Alias) Kind() model.AgentKind { return model.AliasKind(a.ID) }

// EffectiveImage is the image a container of the account is created from.
func (a Alias) EffectiveImage() string {
	if a.Image != "" {
		return a.Image
	}
	return container.DefaultImage()
}

// SpecDiffers reports whether the saved image or mounts differ from the applied ones. With no
// container it is false. The account shows "Restart needed" when this is true and its container
// runs; a stopped container takes the saved spec at its next start, with no question.
//
// An account on the default image (Image "") whose container was made for the default image
// (Applied.Default), from any tag of its repository, does not differ by image: an update of the
// app changes the default tag, and the new image is used when the container is next created (a
// stopped container is, at its next start: its spec hash differs), not by asking every running
// account to restart. A container made from an image the person named does differ, even one of
// the default repository (aiwb/claude:mine): going back to the default needs a restart.
func (a Alias) SpecDiffers() bool {
	if a.Applied == nil {
		return false
	}
	return a.imageDiffers() || !sameFolders(a.Applied.Mounts, a.Mounts)
}

// imageDiffers reports whether the applied image is not the saved one (SpecDiffers). Applied is
// not nil.
func (a Alias) imageDiffers() bool {
	if a.Image == "" && a.Applied.Default && strings.HasPrefix(a.Applied.Image, container.DefaultImageRepo+":") {
		return false
	}
	return a.Applied.Image != a.EffectiveImage()
}

// Pending are the saved mounts the applied ones lack (the folders "waiting" for a restart), in
// the saved order; nil when there is no container.
func (a Alias) Pending() []string {
	if a.Applied == nil {
		return nil
	}
	var out []string
	for _, m := range a.Mounts {
		if !slices.Contains(cleaned(a.Applied.Mounts), filepath.Clean(m)) {
			out = append(out, m)
		}
	}
	return out
}

// Under reports whether dir is one of mounts or a folder under one of them.
func Under(mounts []string, dir string) bool {
	dir = filepath.Clean(dir)
	for _, m := range mounts {
		m = filepath.Clean(m)
		if dir == m || strings.HasPrefix(dir, strings.TrimSuffix(m, string(filepath.Separator))+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func cleaned(l []string) []string {
	out := make([]string, len(l))
	for i, s := range l {
		out[i] = filepath.Clean(s)
	}
	return out
}

func sameFolders(a, b []string) bool {
	x, y := cleaned(a), cleaned(b)
	slices.Sort(x)
	slices.Sort(y)
	return slices.Equal(slices.Compact(x), slices.Compact(y))
}

// The account's folder on the host, which is bind mounted at the same path in its container:
//
//	<data>/aliases/<id>/            0700
//	    claude/                     CLAUDE_CONFIG_DIR: login, sessions, settings
//	    home/                       HOME of the processes in the container
//	    mcp/<chat object>.json      the --mcp-config file of each process (0600)
//
// The computer's ~/.claude is never one of them, and never mounted.
const (
	FileName = "aliases.json" // in the data folder
	DirName  = "aliases"      // in the data folder
)

// File is the path of aliases.json in the data folder root.
func File(root string) string { return filepath.Join(root, FileName) }

// Dir is the account id's folder in the data folder root.
func Dir(root, id string) string { return filepath.Join(root, DirName, id) }

// ClaudeDir is the account's CLAUDE_CONFIG_DIR.
func ClaudeDir(root, id string) string { return filepath.Join(Dir(root, id), "claude") }

// HomeDir is the HOME of the account's processes.
func HomeDir(root, id string) string { return filepath.Join(Dir(root, id), "home") }

// MCPDir is the folder of the account's --mcp-config files.
func MCPDir(root, id string) string { return filepath.Join(Dir(root, id), "mcp") }

// Spec is what the account's container is to be created with now: its effective image, its
// folder and its saved mounts, and the person's uid:gid, so that files the agent writes in a
// mounted folder are the person's.
func (a Alias) Spec(root string) container.Spec {
	return container.Spec{Alias: a.ID, Image: a.EffectiveImage(), Dir: Dir(root, a.ID),
		Mounts: slices.Clone(a.Mounts), User: hostUser()}
}

// hostUser is "uid:gid" of this process, "" where there is none (Windows).
func hostUser() string {
	uid, gid := os.Getuid(), os.Getgid()
	if uid < 0 || gid < 0 {
		return ""
	}
	return strconv.Itoa(uid) + ":" + strconv.Itoa(gid)
}
