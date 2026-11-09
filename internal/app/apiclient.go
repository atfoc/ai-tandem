package app

import (
	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/library"
	"ai-whiteboard/internal/model"
)

// APISnapshot is the state a client gets: the server's whole tree (its groups, boards, chats and
// defaults, archived ones included) and the server's lists. No data folder.
type APISnapshot struct {
	Agents     []model.AgentKind                  `json:"agents"`   // the agents this server can start, never nil
	Catalogs   map[model.AgentKind]*model.Catalog `json:"catalogs"` // claude, cursor, pi and every Claude account; null while not known
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
	// Aliases are the server's Claude accounts, as GET /api/aliases answers them; after every
	// change the client gets them whole in an "aliases" event. Left out by a server without them.
	Aliases *aliases.List `json:"aliases,omitempty"`
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
	if a.Aliases != nil {
		l := a.Aliases.List()
		snap.Aliases = &l
	}
	if a.Library != nil {
		t := a.Library.Tree()
		snap.Library = &t
		snap.LibraryNotice = a.Library.Notice()
	}
	return snap
}

// catalogs returns each agent's model list as the snapshot gives it: Claude's built-in list until
// it reported one, nil for Cursor and pi until they did. Every Claude account (a.Agents.Accounts,
// usable or not) has its own entry, under its kind: the list it reported, else Claude's built-in
// list, as the computer's own Claude Code.
func (a *App) catalogs() map[model.AgentKind]*model.Catalog {
	out := map[model.AgentKind]*model.Catalog{model.Claude: builtinClaude(), model.Cursor: nil, model.Pi: nil}
	for _, kind := range a.Agents.Accounts() {
		out[kind] = builtinClaude()
	}
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

// builtinClaude is a copy of Claude Code's built-in model list.
func builtinClaude() *model.Catalog {
	cl := claude.Catalog
	return &cl
}
