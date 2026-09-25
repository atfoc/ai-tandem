// Package app ties the stores together: groups, moves, and the archive / unarchive / delete
// cascades across boards and chats.
package app

import (
	"errors"
	"fmt"
	"strings"

	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

type App struct {
	St     *store.Store
	Boards *boards.Service
	Chats  *chats.Manager
	Bridge *editorbridge.Bridge

	// Set by main; reported in the snapshot.
	Home       string // the user's home folder
	DefaultCwd string // the server's default working folder
	DataDir    string // the data folder (~/.ai-whiteboard)
}

type Snapshot struct {
	Groups     []model.Group                      `json:"groups"`
	Boards     []model.Board                      `json:"boards"`
	Chats      []model.ChatView                   `json:"chats"`
	Defaults   model.Defaults                     `json:"defaults"`
	Catalogs   map[model.AgentKind]*model.Catalog `json:"catalogs"`
	Home       string                             `json:"home"`
	DefaultCwd string                             `json:"defaultCwd"`
	DataDir    string                             `json:"dataDir"`
}

var ErrGroupNotFound = errors.New("no such group")

// Snapshot: groups, defaults and catalogs from the store; boards from Boards.List; chats from Chats.
func (a *App) Snapshot() Snapshot {
	cl := claude.Catalog
	snap := Snapshot{
		Catalogs:   map[model.AgentKind]*model.Catalog{model.Claude: &cl, model.Cursor: nil},
		Home:       a.Home,
		DefaultCwd: a.DefaultCwd,
		DataDir:    a.DataDir,
	}
	a.St.Read(func(s *model.State) {
		snap.Groups = append([]model.Group{}, s.Groups...)
		snap.Defaults = copyDefaults(s.Defaults)
		if s.Cursor != nil {
			cp := *s.Cursor
			snap.Catalogs[model.Cursor] = &cp
		}
	})
	snap.Boards = a.Boards.List()
	snap.Chats = a.Chats.Views()
	return snap
}

func copyGroupDefaults(g model.GroupDefaults) model.GroupDefaults {
	out := model.GroupDefaults{Cwd: g.Cwd}
	if g.ByAgent != nil {
		out.ByAgent = make(map[model.AgentKind]model.ModelChoice, len(g.ByAgent))
		for k, v := range g.ByAgent {
			out.ByAgent[k] = v
		}
	}
	return out
}

func copyDefaults(d model.Defaults) model.Defaults {
	out := model.Defaults{Last: copyGroupDefaults(d.Last), Groups: make(map[string]model.GroupDefaults, len(d.Groups))}
	for k, v := range d.Groups {
		out.Groups[k] = copyGroupDefaults(v)
	}
	return out
}

// ---- broadcasting ---------------------------------------------------------

func (a *App) broadcastGroups() {
	var gs []model.Group
	a.St.Read(func(s *model.State) { gs = append([]model.Group{}, s.Groups...) })
	a.Bridge.Broadcast(map[string]any{"type": "groups", "groups": gs})
}

func (a *App) broadcastDefaults() {
	var d model.Defaults
	a.St.Read(func(s *model.State) { d = copyDefaults(s.Defaults) })
	a.Bridge.Broadcast(map[string]any{"type": "defaults", "defaults": d})
}

// ---- groups ---------------------------------------------------------------

func (a *App) group(id string) (model.Group, error) {
	var g model.Group
	found := false
	a.St.Read(func(s *model.State) {
		for _, x := range s.Groups {
			if x.ID == id {
				g, found = x, true
				return
			}
		}
	})
	if !found {
		return model.Group{}, fmt.Errorf("%w %q", ErrGroupNotFound, id)
	}
	return g, nil
}

// updateGroup applies f to the group record id and saves state.json.
func (a *App) updateGroup(id string, f func(g *model.Group) error) error {
	return a.St.Update(func(s *model.State) error {
		for i := range s.Groups {
			if s.Groups[i].ID == id {
				return f(&s.Groups[i])
			}
		}
		return fmt.Errorf("%w %q", ErrGroupNotFound, id)
	})
}

func (a *App) CreateGroup(name string) (model.Group, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "New group"
	}
	g := model.Group{ID: model.NewID("g_"), Name: name}
	if err := a.St.Update(func(s *model.State) error {
		s.Groups = append(s.Groups, g)
		defaults.SeedGroup(&s.Defaults, g.ID)
		return nil
	}); err != nil {
		return model.Group{}, err
	}
	a.broadcastGroups()
	a.broadcastDefaults()
	return g, nil
}

// UpdateGroup renames (trimmed, non-empty) and/or collapses a group. nil leaves a field alone.
func (a *App) UpdateGroup(id string, name *string, collapsed *bool) error {
	var n string
	if name != nil {
		n = strings.TrimSpace(*name)
		if n == "" {
			return errors.New("group name is empty")
		}
	}
	if err := a.updateGroup(id, func(g *model.Group) error {
		if name != nil {
			g.Name = n
		}
		if collapsed != nil {
			g.Collapsed = *collapsed
		}
		return nil
	}); err != nil {
		return err
	}
	a.broadcastGroups()
	return nil
}

// ReorderGroups puts the groups in the order of ids, which must be a permutation of the group ids.
func (a *App) ReorderGroups(ids []string) error {
	if err := a.St.Update(func(s *model.State) error {
		if len(ids) != len(s.Groups) {
			return errors.New("the order must list every group exactly once")
		}
		byID := make(map[string]model.Group, len(s.Groups))
		for _, g := range s.Groups {
			byID[g.ID] = g
		}
		out := make([]model.Group, 0, len(ids))
		for _, id := range ids {
			g, ok := byID[id]
			if !ok {
				return errors.New("the order must list every group exactly once")
			}
			delete(byID, id)
			out = append(out, g)
		}
		s.Groups = out
		return nil
	}); err != nil {
		return err
	}
	a.broadcastGroups()
	return nil
}

// ---- moves ----------------------------------------------------------------

// MoveBoard moves a board; its chats follow, since their group is the board's.
func (a *App) MoveBoard(id, group string) error { return a.Boards.Move(id, group) }

// MoveChat moves a plain chat.
func (a *App) MoveChat(id, group string) error { return a.Chats.Move(id, group) }

// ---- archive --------------------------------------------------------------

type Kind string

const (
	KindGroup Kind = "group"
	KindBoard Kind = "board"
	KindChat  Kind = "chat"
)

// archiveChat stops the chat's agent and archives it with ar.
func (a *App) archiveChat(id string, ar model.Archive) error {
	a.Chats.Stop(id)
	return a.Chats.SetArchive(id, ar)
}

// archiveBoard archives the board's not yet archived chats and the board with ar.
func (a *App) archiveBoard(id string, ar model.Archive) error {
	for _, c := range a.Chats.ChatsOfBoard(id) {
		if c.Archived {
			continue
		}
		if err := a.archiveChat(c.ID, ar); err != nil {
			return err
		}
	}
	return a.Boards.SetArchive(id, ar)
}

// plainChatsOf returns the plain (non-board) chats of a group.
func (a *App) plainChatsOf(group string) []model.ChatView {
	var out []model.ChatView
	for _, c := range a.Chats.Views() {
		if c.Board == "" && c.Group == group {
			out = append(out, c)
		}
	}
	return out
}

func (a *App) boardsOf(group string) []model.Board {
	var out []model.Board
	for _, b := range a.Boards.List() {
		if b.Group == group {
			out = append(out, b)
		}
	}
	return out
}

// Archive archives a chat, a board (with its chats) or a group (with everything in it). Every
// item archived by this call shares one archive op id.
func (a *App) Archive(k Kind, id string) error {
	ar := model.Archive{Archived: true, Op: model.NewID("a_")}
	switch k {
	case KindChat:
		if _, err := a.Chats.View(id); err != nil {
			return err
		}
		return a.archiveChat(id, ar)
	case KindBoard:
		if _, ok := a.Boards.Get(id); !ok {
			return boards.ErrNotFound
		}
		return a.archiveBoard(id, ar)
	case KindGroup:
		if _, err := a.group(id); err != nil {
			return err
		}
		for _, b := range a.boardsOf(id) {
			if b.Archived {
				continue
			}
			if err := a.archiveBoard(b.ID, ar); err != nil {
				return err
			}
		}
		for _, c := range a.plainChatsOf(id) {
			if c.Archived {
				continue
			}
			if err := a.archiveChat(c.ID, ar); err != nil {
				return err
			}
		}
		if err := a.updateGroup(id, func(g *model.Group) error { g.Archive = ar; return nil }); err != nil {
			return err
		}
		a.broadcastGroups()
		return nil
	}
	return fmt.Errorf("unknown kind %q", k)
}

// unarchiveGroupRecord clears the group's own archive mark only (not its contents).
func (a *App) unarchiveGroupRecord(id string) error {
	g, err := a.group(id)
	if err != nil || !g.Archived {
		return nil // Ungrouped, or not archived: nothing to do
	}
	if err := a.updateGroup(id, func(g *model.Group) error { g.Archive = model.Archive{}; return nil }); err != nil {
		return err
	}
	a.broadcastGroups()
	return nil
}

// Unarchive puts an item back where it was. A chat brings back its archived board and group
// record; a board or a group brings back exactly what was archived together with it.
func (a *App) Unarchive(k Kind, id string) error {
	clear := model.Archive{}
	switch k {
	case KindChat:
		cv, err := a.Chats.View(id)
		if err != nil {
			return err
		}
		if err := a.Chats.SetArchive(id, clear); err != nil {
			return err
		}
		group := cv.Group
		if cv.Board != "" {
			bd, ok := a.Boards.Get(cv.Board)
			if ok {
				group = bd.Group
				if bd.Archived {
					if err := a.Boards.SetArchive(bd.ID, clear); err != nil {
						return err
					}
				}
			} else {
				group = model.Ungrouped
			}
		}
		return a.unarchiveGroupRecord(group)
	case KindBoard:
		bd, ok := a.Boards.Get(id)
		if !ok {
			return boards.ErrNotFound
		}
		op := bd.Op
		if err := a.Boards.SetArchive(id, clear); err != nil {
			return err
		}
		if op != "" {
			for _, c := range a.Chats.ChatsOfBoard(id) {
				if c.Archived && c.Op == op {
					if err := a.Chats.SetArchive(c.ID, clear); err != nil {
						return err
					}
				}
			}
		}
		return a.unarchiveGroupRecord(bd.Group)
	case KindGroup:
		g, err := a.group(id)
		if err != nil {
			return err
		}
		op := g.Op
		if err := a.updateGroup(id, func(g *model.Group) error { g.Archive = clear; return nil }); err != nil {
			return err
		}
		if op != "" {
			for _, b := range a.boardsOf(id) {
				if b.Archived && b.Op == op {
					if err := a.Boards.SetArchive(b.ID, clear); err != nil {
						return err
					}
				}
			}
			for _, cv := range a.Chats.Views() {
				if !cv.Archived || cv.Op != op {
					continue
				}
				meta := model.ChatMeta{Board: cv.Board, Group: cv.Group}
				if a.Chats.GroupOf(meta) != id {
					continue
				}
				if err := a.Chats.SetArchive(cv.ID, clear); err != nil {
					return err
				}
			}
		}
		a.broadcastGroups()
		return nil
	}
	return fmt.Errorf("unknown kind %q", k)
}

// ---- delete ---------------------------------------------------------------

func (a *App) DeleteChat(id string) error { return a.Chats.Delete(id) }

// DeleteBoard deletes the board's chats (stopping their agents), then the board and its file.
func (a *App) DeleteBoard(id string) error {
	if _, ok := a.Boards.Get(id); !ok {
		return boards.ErrNotFound
	}
	for _, c := range a.Chats.ChatsOfBoard(id) {
		if err := a.Chats.Delete(c.ID); err != nil && !errors.Is(err, chats.ErrNotFound) {
			return err
		}
	}
	return a.Boards.Delete(id)
}

// DeleteGroup removes a group and its defaults. With deleteContents its boards and plain chats
// are deleted; without, they move to ungrouped.
func (a *App) DeleteGroup(id string, deleteContents bool) error {
	if _, err := a.group(id); err != nil {
		return err
	}
	for _, b := range a.boardsOf(id) {
		var err error
		if deleteContents {
			err = a.DeleteBoard(b.ID)
		} else {
			err = a.Boards.Move(b.ID, model.Ungrouped)
		}
		if err != nil {
			return err
		}
	}
	for _, c := range a.plainChatsOf(id) {
		var err error
		if deleteContents {
			err = a.DeleteChat(c.ID)
		} else {
			err = a.Chats.Move(c.ID, model.Ungrouped)
		}
		if err != nil {
			return err
		}
	}
	if err := a.St.Update(func(s *model.State) error {
		for i := range s.Groups {
			if s.Groups[i].ID == id {
				s.Groups = append(s.Groups[:i:i], s.Groups[i+1:]...)
				break
			}
		}
		delete(s.Defaults.Groups, id)
		return nil
	}); err != nil {
		return err
	}
	a.broadcastGroups()
	a.broadcastDefaults()
	return nil
}
