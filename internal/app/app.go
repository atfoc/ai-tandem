// Package app ties the stores together: groups and their subgroups, moves, and the archive /
// unarchive / delete cascades across groups, boards, chats and runs, the chats and runs of other
// servers included (remote.go).
package app

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/store"
	"ai-whiteboard/internal/usable"
)

type App struct {
	St     *store.Store
	Boards *boards.Service
	Chats  *chats.Manager
	Runs   *runs.Service // nil: an app without runs
	Bridge *editorbridge.Bridge

	// Servers is the list of remote servers; nil: this computer alone.
	Servers *servers.Manager
	// Remotes holds the chats of those servers, each a record with a place in a group of this
	// one (see remote.go); nil: none.
	Remotes *remotes.Relay

	Agents *usable.Set // nil: every kind of agent is usable

	// Set by main; reported in the snapshot.
	Home       string // the user's home folder
	DefaultCwd string // the server's default working folder
	DataDir    string // the data folder (~/.ai-whiteboard)

	remoteMu sync.Mutex // one RemoteGroup at a time: the group is announced before its id is used
}

type Snapshot struct {
	Groups     []model.Group                      `json:"groups"`
	Boards     []model.Board                      `json:"boards"`
	Servers    []servers.View                     `json:"servers"`
	Chats      []model.ChatView                   `json:"chats"`  // without the chats of runs' agents; with the chats of other servers
	States     []model.BranchState                `json:"states"` // one per branch of every chat in Chats, main included
	Lists      map[string]remotes.ServerLists     `json:"lists"`  // what each other server offers for a new chat, by entry id; never nil
	Runs       []model.RunView                    `json:"runs"`   // with the runs of other servers
	Defaults   model.Defaults                     `json:"defaults"`
	Catalogs   map[model.AgentKind]*model.Catalog `json:"catalogs"`
	Agents     []model.AgentKind                  `json:"agents"` // the agents this server can start, never nil
	Home       string                             `json:"home"`
	DefaultCwd string                             `json:"defaultCwd"`
	DataDir    string                             `json:"dataDir"`
}

var (
	ErrGroupNotFound = errors.New("no such group")
	ErrGroupArchived = errors.New("the group is archived")
)

// Snapshot: groups, defaults and catalogs from the store; boards from Boards.List, and those of
// other servers from Remotes; chats and their branches' states from Chats, and those of other
// servers and the servers' lists from Remotes; runs from Runs, and those of other servers from
// Remotes. They are read one after the other, not at one moment.
func (a *App) Snapshot() Snapshot {
	cl := claude.Catalog
	snap := Snapshot{
		Catalogs: map[model.AgentKind]*model.Catalog{
			model.Claude: &cl,
			model.Cursor: nil, // known only after Cursor reports its list
			model.Pi:     nil, // known only after pi reports its list
		},
		Agents:     a.Agents.List(),
		Home:       a.Home,
		DefaultCwd: a.DefaultCwd,
		DataDir:    a.DataDir,
	}
	a.St.Read(func(s *model.State) {
		snap.Groups = append([]model.Group{}, s.Groups...)
		snap.Defaults = defaults.Copy(s.Defaults)
		for _, kind := range []model.AgentKind{model.Claude, model.Cursor, model.Pi} {
			if c := s.Catalog(kind); c != nil {
				cp := *c
				snap.Catalogs[kind] = &cp
			}
		}
	})
	snap.Boards = a.Boards.List()
	if a.Remotes != nil {
		a.withBoardRecords(&snap)
	}
	snap.Servers = a.Servers.Views()
	snap.Chats = a.Chats.Views()
	snap.States = a.Chats.States()
	snap.Lists = map[string]remotes.ServerLists{}
	if a.Remotes != nil {
		a.withRecords(&snap)
	}
	snap.Runs = []model.RunView{}
	if a.Runs != nil {
		snap.Runs = a.Runs.Views()
	}
	if a.Remotes != nil {
		a.withRunRecords(&snap)
	}
	return snap
}

// ---- broadcasting ---------------------------------------------------------

func (a *App) broadcastGroups() {
	var gs []model.Group
	a.St.Read(func(s *model.State) { gs = append([]model.Group{}, s.Groups...) })
	a.Bridge.Broadcast(map[string]any{"type": "groups", "groups": gs})
}

func (a *App) broadcastDefaults() {
	var d model.Defaults
	a.St.Read(func(s *model.State) { d = defaults.Copy(s.Defaults) })
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
// with a copy of its parent's defaults, a top-level group with a copy of the ungrouped group's.
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
	KindRun   Kind = "run"
)

// archiveChat archives the chat with ar and stops its agent. The archive state is set first: from
// then on no message is accepted, so the Stop ends whatever a Send started before it, and nothing
// starts after the Stop.
func (a *App) archiveChat(id string, ar model.Archive) error {
	err := a.Chats.SetArchive(id, ar)
	a.Chats.Stop(id)
	return err
}

// freeWait is how long the client that holds a board has to write its pending changes before the
// board is archived or deleted. Shorter in tests.
var freeWait = 3 * time.Second

// freeBoards frees the boards at the same time, so that clients that do not answer cost one wait
// and not one each.
func (a *App) freeBoards(ids []string) {
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a.Bridge.FreeBoard(id, freeWait)
		}()
	}
	wg.Wait()
}

// archiveBoard archives the board's not yet archived chats and the board with ar.
func (a *App) archiveBoard(id string, ar model.Archive) error {
	a.Bridge.FreeBoard(id, freeWait) // the client that holds it writes its pending changes first
	for _, c := range a.Chats.ChatsOfBoard(id) {
		if c.Archived {
			continue
		}
		if err := a.archiveChat(c.ID, ar); err != nil {
			return err
		}
	}
	if err := a.Boards.SetArchive(id, ar); err != nil {
		return err
	}
	a.Bridge.FreeBoard(id, 0) // a client may have taken the board while its chats were archived
	return nil
}

// plainChatsIn returns the plain chats of the groups in: the ones on no board and on no run.
func (a *App) plainChatsIn(in map[string]bool) []model.ChatView {
	var out []model.ChatView
	for _, c := range a.Chats.Views() {
		if c.Board == "" && c.Run == "" && in[c.Group] {
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

// runsIn returns the runs of the groups in, oldest first.
func (a *App) runsIn(in map[string]bool) []model.RunMeta {
	if a.Runs == nil {
		return nil
	}
	var out []model.RunMeta
	for _, r := range a.Runs.List() {
		if in[r.Group] {
			out = append(out, r)
		}
	}
	return out
}

// errNoRuns is what a call about a run answers in an app without runs.
func (a *App) errNoRuns() error {
	if a.Runs == nil {
		return runs.ErrNotFound
	}
	return nil
}

// Archive archives a chat, a board (with its chats), a run (stopped first when it works; with the
// chats people have on it) or a group (with everything in it, its subgroups too, and the chats and
// runs of other servers that have their place there). Every item archived by this call shares one
// archive op id.
//
// A run that has not stopped in time refuses (runs.ErrStopping). A group goes on without that run:
// everything else in it is archived, the group too, and the error is returned.
func (a *App) Archive(k Kind, id string) error {
	ar := model.Archive{Archived: true, Op: model.NewID("a_")}
	switch k {
	case KindRun:
		if err := a.errNoRuns(); err != nil {
			return err
		}
		return a.Runs.Archive(id, ar)
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
		var free []string
		for _, b := range a.boardsIn(in) {
			if !b.Archived {
				free = append(free, b.ID)
			}
		}
		a.freeBoards(free)
		tried := map[string]bool{}
		stopping, err := a.archiveGroups(in, ar, tried)
		if err != nil {
			return err
		}
		if beforeGroupChange != nil {
			beforeGroupChange()
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
		// A start that checked its group before the mark may have placed its run, chat or board
		// there since the listing above: what appeared is archived like the rest.
		late, err := a.archiveGroups(in, ar, tried)
		a.broadcastGroups()
		if err != nil {
			return err
		}
		return errors.Join(stopping, late)
	}
	return fmt.Errorf("unknown kind %q", k)
}

// archiveGroups archives with ar the boards, plain chats, records (of chats and of runs) and runs
// of the groups in that are not archived. stopping names the runs that have not stopped in time (runs.ErrStopping) and
// stay. tried takes the runs it asked, and a run that is in it already is not asked again.
func (a *App) archiveGroups(in map[string]bool, ar model.Archive, tried map[string]bool) (stopping, err error) {
	for _, b := range a.boardsIn(in) {
		if b.Archived {
			continue
		}
		if err := a.archiveBoard(b.ID, ar); err != nil {
			return nil, err
		}
	}
	for _, c := range a.plainChatsIn(in) {
		if c.Archived {
			continue
		}
		if err := a.archiveChat(c.ID, ar); err != nil {
			return nil, err
		}
	}
	a.archiveRecords(in, ar)
	for _, r := range a.runsIn(in) {
		if r.Archived || tried[r.ID] {
			continue
		}
		tried[r.ID] = true
		switch err := a.Runs.Archive(r.ID, ar); {
		case errors.Is(err, runs.ErrStopping):
			stopping = errors.Join(stopping, fmt.Errorf("%s: %w", r.Name, err))
		case err != nil && !errors.Is(err, runs.ErrNotFound):
			return nil, err
		}
	}
	return stopping, nil
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

// Unarchive puts an item back where it was. A chat brings back its archived board or run and group
// records; a board, a run or a group brings back exactly what was archived together with it, and
// the archived groups it is nested in. A run that comes back is not resumed. A chat or a run of
// another server that a group's archive archived comes back with the group; one that was archived
// on its own server does not.
func (a *App) Unarchive(k Kind, id string) error {
	clear := model.Archive{}
	switch k {
	case KindRun:
		if err := a.errNoRuns(); err != nil {
			return err
		}
		if err := a.Runs.Unarchive(id); err != nil {
			return err
		}
		ri, ok := a.Runs.RunOf(id)
		if !ok {
			return runs.ErrNotFound
		}
		return a.unarchiveGroupRecord(ri.Group)
	case KindChat:
		cv, err := a.Chats.View(id)
		if err != nil {
			return err
		}
		if err := a.Chats.SetArchive(id, clear); err != nil {
			return err
		}
		group := cv.Group
		if cv.Run != "" {
			// A chat on a run: the run's record comes back, not the run's other chats.
			group = model.Ungrouped
			if a.Runs != nil {
				if ri, ok := a.Runs.RunOf(cv.Run); ok {
					group = ri.Group
					switch _, there := a.runRecord(cv.Run); {
					case !ri.Archived:
					case there:
						// A run of another server comes back there, with what its server
						// archived together with it: nothing of it is this server's to bring back.
						if err := a.Remotes.UnarchiveRun(context.Background(), cv.Run); err != nil {
							return err
						}
					default:
						if err := a.Runs.UnarchiveAlone(cv.Run); err != nil {
							return err
						}
					}
				}
			}
		} else if cv.Board != "" {
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
				meta := model.ChatMeta{Board: cv.Board, Run: cv.Run, Group: cv.Group}
				if !in[a.Chats.GroupOf(meta)] {
					continue
				}
				if err := a.Chats.SetArchive(cv.ID, clear); err != nil {
					return err
				}
			}
			a.unarchiveRecords(in, op)
			for _, r := range a.runsIn(in) {
				if !r.Archived || r.Op != op {
					continue
				}
				if err := a.Runs.Unarchive(r.ID); err != nil && !errors.Is(err, runs.ErrNotFound) {
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
	a.Bridge.FreeBoard(id, freeWait) // as at an archive
	for _, c := range a.Chats.ChatsOfBoard(id) {
		if err := a.Chats.Delete(c.ID); err != nil && !errors.Is(err, chats.ErrNotFound) {
			return err
		}
	}
	if err := a.Boards.Delete(id); err != nil {
		return err
	}
	a.Bridge.FreeBoard(id, 0) // as at an archive
	return nil
}

// DeleteRun stops the run and removes it for good, with its agents' chats and the chats people
// have on it. Its branches in the repository stay.
func (a *App) DeleteRun(id string) error {
	if err := a.errNoRuns(); err != nil {
		return err
	}
	return a.Runs.Delete(id)
}

// DeleteGroup removes a group and its defaults. With deleteContents its subgroups, boards, plain
// chats and runs are deleted too; without, they move up to the group's parent (ungrouped for a
// top-level group).
//
// The chats and the runs of other servers that have their place there are deleted on their
// servers first, or moved up. While one of those servers is not connected nothing is deleted (an
// error of the relay: 409 server_unreachable), and neither is anything of this server once a chat
// or a run could not be deleted there.
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
	if deleteContents {
		if err := a.deleteRecords(gone); err != nil {
			return err
		}
		var free []string
		for _, b := range a.boardsIn(gone) {
			free = append(free, b.ID)
		}
		a.freeBoards(free)
	} else if err := a.moveRecords(gone, to); err != nil {
		return err
	}
	if err := a.emptyGroups(gone, to, deleteContents); err != nil {
		return err
	}
	if beforeGroupChange != nil {
		beforeGroupChange()
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
	// A start that checked its group before the removal may have placed its run, chat or board
	// there since the listing above: what appeared is deleted or moved like the rest. So is a
	// record that a start on another server made of a draft run or a chat of these groups.
	err = errors.Join(a.emptyGroups(gone, to, deleteContents), a.lateRecords(gone, to, deleteContents))
	a.broadcastGroups()
	a.broadcastDefaults()
	return err
}

// beforeGroupChange is called, in a test, between the listing of a group's contents and the
// group's removal or archive.
var beforeGroupChange func()

// emptyGroups deletes the boards, plain chats and runs of the groups gone, or moves them to the
// group to.
func (a *App) emptyGroups(gone map[string]bool, to string, deleteContents bool) error {
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
	for _, r := range a.runsIn(gone) {
		var err error
		if deleteContents {
			err = a.DeleteRun(r.ID)
		} else {
			err = a.Runs.Move(r.ID, to)
		}
		if err != nil && !errors.Is(err, runs.ErrNotFound) {
			return err
		}
	}
	return nil
}
