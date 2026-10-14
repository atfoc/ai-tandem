package app

import (
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/library"
	"ai-whiteboard/internal/model"
)

// APISnapshot is the state a client gets: the server's whole tree (its groups, boards, chats and
// defaults, archived ones included) and the server's lists. No data folder.
type APISnapshot struct {
	Agents     []model.AgentKind                  `json:"agents"`   // the agents this server can start, never nil
	Catalogs   map[model.AgentKind]*model.Catalog `json:"catalogs"` // claude, cursor, pi; null while not known
	Home       string                             `json:"home"`
	DefaultCwd string                             `json:"defaultCwd"`
	Groups     []model.Group                      `json:"groups"`   // every group, in the server's order; never nil
	Defaults   model.Defaults                     `json:"defaults"` // what the server remembers per group
	Boards     []model.Board                      `json:"boards"`   // every board; never nil
	Chats      []model.ChatView                   `json:"chats"`    // every chat; never nil
	States     []model.BranchState                `json:"states"`   // one per branch of those chats; never nil
	// Library is this server's own prompt library, which every client reads and changes
	// (the library routes of server.ClientRoutes); null for a server without one. After every
	// change the client gets it whole in an "own_library" event (library.Own).
	Library *library.Tree `json:"library"`
	// LibraryNotice says why the library's file was set aside at the server's start; left out
	// when it was not.
	LibraryNotice string `json:"libraryNotice,omitempty"`
}

// APISnapshot builds the snapshot of a client: the same for every one of them. It changes
// nothing and sends nothing.
func (a *App) APISnapshot() APISnapshot {
	agents := a.Agents.List()
	if agents == nil {
		agents = []model.AgentKind{}
	}
	snap := APISnapshot{
		Agents:     agents,
		Catalogs:   a.catalogs(),
		Home:       a.Home,
		DefaultCwd: a.DefaultCwd,
		Boards:     a.Boards.List(),
		Chats:      a.Chats.Views(),
		States:     a.Chats.States(),
	}
	a.St.Read(func(s *model.State) {
		snap.Groups = append([]model.Group{}, s.Groups...)
		snap.Defaults = defaults.Copy(s.Defaults)
	})
	if a.Library != nil {
		t := a.Library.Tree()
		snap.Library = &t
		snap.LibraryNotice = a.Library.Notice()
	}
	return snap
}

// catalogs returns each agent's model list as the snapshot gives it: Claude's built-in list until
// it reported one, nil for Cursor and pi until they did.
func (a *App) catalogs() map[model.AgentKind]*model.Catalog {
	cl := claude.Catalog
	out := map[model.AgentKind]*model.Catalog{model.Claude: &cl, model.Cursor: nil, model.Pi: nil}
	a.St.Read(func(s *model.State) {
		for kind := range out {
			if c := s.Catalog(kind); c != nil {
				cp := *c
				out[kind] = &cp
			}
		}
	})
	return out
}
