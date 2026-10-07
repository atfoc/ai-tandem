package app

import (
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/model"
)

// APISnapshot is the state an API client gets: its own items and the server's lists. No group,
// no board, no defaults, no data folder, and nothing of the servers this one connects to.
type APISnapshot struct {
	Agents     []model.AgentKind                  `json:"agents"`   // the agents this server can start, never nil
	Catalogs   map[model.AgentKind]*model.Catalog `json:"catalogs"` // claude, cursor, pi; null while not known
	Home       string                             `json:"home"`
	DefaultCwd string                             `json:"defaultCwd"`
	Chats      []model.ChatView                   `json:"chats"`  // the chats with the client's mark; never nil
	States     []model.BranchState                `json:"states"` // one per branch of those chats; never nil
	Runs       []model.RunView                    `json:"runs"`   // the runs with the client's mark; never nil
}

// APISnapshot builds the snapshot of the API client with this id. It changes nothing and sends
// nothing. It is built from its own fields, never from Snapshot: what is added to the page's
// snapshot reaches no API client.
func (a *App) APISnapshot(client string) APISnapshot {
	agents := a.Agents.List()
	if agents == nil {
		agents = []model.AgentKind{}
	}
	rs := []model.RunView{}
	if a.Runs != nil {
		rs = a.Runs.ViewsOf(client)
	}
	return APISnapshot{
		Agents:     agents,
		Catalogs:   a.catalogs(),
		Home:       a.Home,
		DefaultCwd: a.DefaultCwd,
		Chats:      a.Chats.ViewsOf(client),
		States:     a.Chats.StatesOf(client),
		Runs:       rs,
	}
}

// catalogs returns each agent's model list as Snapshot gives it: Claude's built-in list until
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

// remoteGroupName is the name the group of the API clients' items is made with.
const remoteGroupName = "Remote"

// RemoteGroup returns the id of the group "Remote", where what API clients make goes. It makes
// the group, at the top level and seeded like any new group, when no id is remembered or the
// remembered group is gone or archived (by itself or with a group it is nested in). Nothing else
// makes it: no start and no set-up. The owner may rename, move, archive or delete it like any
// group.
func (a *App) RemoteGroup() (string, error) {
	a.remoteMu.Lock()
	defer a.remoteMu.Unlock()
	// kept returns the remembered group's id while that group can take a new item.
	kept := func(s *model.State) string {
		if i := groupIndex(s.Groups, s.RemoteGroup); s.RemoteGroup != "" && i >= 0 && !s.Groups[i].Archived {
			return s.RemoteGroup
		}
		return ""
	}
	var id string
	a.St.Read(func(s *model.State) { id = kept(s) })
	if id != "" {
		return id, nil
	}
	made := false
	if err := a.St.Update(func(s *model.State) error {
		if id = kept(s); id != "" {
			return nil
		}
		id, made = model.NewID("g_"), true
		s.Groups = append(s.Groups, model.Group{ID: id, Name: remoteGroupName})
		defaults.SeedGroup(&s.Defaults, id, "")
		s.RemoteGroup = id
		return nil
	}); err != nil {
		return "", err
	}
	if made {
		a.broadcastGroups()
		a.broadcastDefaults()
	}
	return id, nil
}
