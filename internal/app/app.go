// Package app ties the stores together: groups and their subgroups, moves, and the archive /
// unarchive / delete cascades across groups, boards and chats.
package app

import (
	"errors"
	"fmt"
	"slices"
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

var (
	ErrGroupNotFound = errors.New("no such group")
	ErrGroupArchived = errors.New("the group is archived")
)

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

func groupIndex(gs []model.Group, id string) int {
	return slices.IndexFunc(gs, func(g model.Group) bool { return g.ID == id })
}

// subtree returns id and the ids of every group nested in it, at any depth.
func subtree(gs []model.Group, id string) map[string]bool {
	in := map[string]bool{id: true}
	for grew := true; grew; {
		grew = false
		for _, g := range gs {
			if !in[g.ID] && g.Parent != "" && in[g.Parent] {
				in[g.ID], grew = true, true
			}
		}
	}
	return in
}

func (a *App) subtreeOf(id string) map[string]bool {
	var in map[string]bool
	a.St.Read(func(s *model.State) { in = subtree(s.Groups, id) })
	return in
}

// checkParent reports an error unless parent is a group that is not archived.
func checkParent(s *model.State, parent string) error {
	i := groupIndex(s.Groups, parent)
	if i < 0 {
		return fmt.Errorf("%w %q", ErrGroupNotFound, parent)
	}
	if s.Groups[i].Archived {
		return fmt.Errorf("%w: %s", ErrGroupArchived, s.Groups[i].Name)
	}
	return nil
}

// CreateGroup adds a group at the top level (parent "") or nested in parent. A subgroup starts
// with its parent's defaults, a top-level group with the ones used most recently anywhere.
func (a *App) CreateGroup(name, parent string) (model.Group, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "New group"
	}
	g := model.Group{ID: model.NewID("g_"), Name: name, Parent: parent}
	if err := a.St.Update(func(s *model.State) error {
		if parent != "" {
			if err := checkParent(s, parent); err != nil {
				return err
			}
		}
		s.Groups = append(s.Groups, g)
		defaults.SeedGroup(&s.Defaults, g.ID, parent)
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

// MoveGroup nests a group in parent ("" for the top level) and puts it before the group before
// in the order ("" for last). A group can't go into itself, a group nested in it, or an
// archived group. Its contents and subgroups go with it.
func (a *App) MoveGroup(id, parent, before string) error {
	if err := a.St.Update(func(s *model.State) error {
		i := groupIndex(s.Groups, id)
		if i < 0 {
			return fmt.Errorf("%w %q", ErrGroupNotFound, id)
		}
		if parent != "" {
			if subtree(s.Groups, id)[parent] {
				return errors.New("a group can't go inside itself")
			}
			if err := checkParent(s, parent); err != nil {
				return err
			}
		}
		g := s.Groups[i]
		g.Parent = parent
		rest := slices.Delete(slices.Clone(s.Groups), i, i+1)
		at := len(rest)
		switch before {
		case "":
		case id:
			at = i
		default:
			if at = groupIndex(rest, before); at < 0 {
				return fmt.Errorf("%w %q", ErrGroupNotFound, before)
			}
		}
		s.Groups = slices.Insert(rest, at, g)
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

// plainChatsIn returns the plain (non-board) chats of the groups in.
func (a *App) plainChatsIn(in map[string]bool) []model.ChatView {
	var out []model.ChatView
	for _, c := range a.Chats.Views() {
		if c.Board == "" && in[c.Group] {
			out = append(out, c)
		}
	}
	return out
}

// boardsIn returns the boards of the groups in.
func (a *App) boardsIn(in map[string]bool) []model.Board {
	var out []model.Board
	for _, b := range a.Boards.List() {
		if in[b.Group] {
			out = append(out, b)
		}
	}
	return out
}

// Archive archives a chat, a board (with its chats) or a group (with everything in it, its
// subgroups too). Every item archived by this call shares one archive op id.
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
		in := a.subtreeOf(id)
		for _, b := range a.boardsIn(in) {
			if b.Archived {
				continue
			}
			if err := a.archiveBoard(b.ID, ar); err != nil {
				return err
			}
		}
		for _, c := range a.plainChatsIn(in) {
			if c.Archived {
				continue
			}
			if err := a.archiveChat(c.ID, ar); err != nil {
				return err
			}
		}
		if err := a.St.Update(func(s *model.State) error {
			for i := range s.Groups {
				g := &s.Groups[i]
				if g.ID == id || (in[g.ID] && !g.Archived) {
					g.Archive = ar
				}
			}
			return nil
		}); err != nil {
			return err
		}
		a.broadcastGroups()
		return nil
	}
	return fmt.Errorf("unknown kind %q", k)
}

// unarchiveGroupRecord clears the archive mark of the group and of every group it is nested
// in, so it shows again; not their contents.
func (a *App) unarchiveGroupRecord(id string) error {
	changed := false
	if err := a.St.Update(func(s *model.State) error {
		for id != "" {
			i := groupIndex(s.Groups, id)
			if i < 0 {
				return nil // Ungrouped, or gone
			}
			if s.Groups[i].Archived {
				s.Groups[i].Archive = model.Archive{}
				changed = true
			}
			id = s.Groups[i].Parent
		}
		return nil
	}); err != nil {
		return err
	}
	if changed {
		a.broadcastGroups()
	}
	return nil
}

// Unarchive puts an item back where it was. A chat brings back its archived board and group
// records; a board or a group brings back exactly what was archived together with it, and the
// archived groups it is nested in.
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
		in := a.subtreeOf(id)
		if err := a.St.Update(func(s *model.State) error {
			for i := range s.Groups {
				x := &s.Groups[i]
				if x.ID == id || (op != "" && in[x.ID] && x.Archived && x.Op == op) {
					x.Archive = clear
				}
			}
			return nil
		}); err != nil {
			return err
		}
		if op != "" {
			for _, b := range a.boardsIn(in) {
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
				if !in[a.Chats.GroupOf(meta)] {
					continue
				}
				if err := a.Chats.SetArchive(cv.ID, clear); err != nil {
					return err
				}
			}
		}
		a.broadcastGroups()
		return a.unarchiveGroupRecord(g.Parent)
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

// DeleteGroup removes a group and its defaults. With deleteContents its subgroups, boards and
// plain chats are deleted too; without, they move up to the group's parent (ungrouped for a
// top-level group).
func (a *App) DeleteGroup(id string, deleteContents bool) error {
	g, err := a.group(id)
	if err != nil {
		return err
	}
	gone := map[string]bool{id: true}
	if deleteContents {
		gone = a.subtreeOf(id)
	}
	to := g.Parent
	if to == "" {
		to = model.Ungrouped
	}
	for _, b := range a.boardsIn(gone) {
		var err error
		if deleteContents {
			err = a.DeleteBoard(b.ID)
		} else {
			err = a.Boards.Move(b.ID, to)
		}
		if err != nil {
			return err
		}
	}
	for _, c := range a.plainChatsIn(gone) {
		var err error
		if deleteContents {
			err = a.DeleteChat(c.ID)
		} else {
			err = a.Chats.Move(c.ID, to)
		}
		if err != nil {
			return err
		}
	}
	if err := a.St.Update(func(s *model.State) error {
		s.Groups = slices.DeleteFunc(s.Groups, func(x model.Group) bool { return gone[x.ID] })
		for i := range s.Groups {
			if s.Groups[i].Parent == id {
				s.Groups[i].Parent = g.Parent
			}
		}
		for x := range gone {
			delete(s.Defaults.Groups, x)
		}
		return nil
	}); err != nil {
		return err
	}
	a.broadcastGroups()
	a.broadcastDefaults()
	return nil
}
