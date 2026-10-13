package remotes

import (
	"ai-whiteboard/internal/model"
)

// ServerLists is what a remote server offers for a new chat or run, as the pages get it: its
// usable agents, their model lists, its home folder and its default folder. Nothing else of a
// server is in it. The lists are kept by servers.Manager, in memory only, and stay while the
// entry is unreachable.
type ServerLists struct {
	Agents     []model.AgentKind                  `json:"agents"`
	Catalogs   map[model.AgentKind]*model.Catalog `json:"catalogs"`
	Home       string                             `json:"home"`
	DefaultCwd string                             `json:"defaultCwd"`
}

// listsOf is the entry's lists; ok is false while they are not known.
func (r *Relay) listsOf(entry string) (ServerLists, bool) {
	l, ok := r.o.Servers.Lists(entry)
	if !ok {
		return ServerLists{}, false
	}
	out := ServerLists{Agents: l.Agents, Catalogs: l.Catalogs, Home: l.Home, DefaultCwd: l.DefaultCwd}
	if out.Agents == nil {
		out.Agents = []model.AgentKind{}
	}
	if out.Catalogs == nil {
		out.Catalogs = map[model.AgentKind]*model.Catalog{}
	}
	return out, true
}

// Lists are the lists of every entry whose lists are known, by entry id: the snapshot's
// "lists". Never nil.
func (r *Relay) Lists() map[string]ServerLists {
	out := map[string]ServerLists{}
	for _, v := range r.o.Servers.Views() {
		if v.Local {
			continue
		}
		if l, ok := r.listsOf(v.ID); ok {
			out[v.ID] = l
		}
	}
	return out
}

// sendLists tells every page the entry's lists as they are now. It sends nothing while they are
// not known.
func (r *Relay) sendLists(entry string) {
	if l, ok := r.listsOf(entry); ok {
		r.o.Bridge.Broadcast(map[string]any{"type": "server_lists", "server": entry, "lists": l})
	}
}

// sendNoLists tells every page that the entry has no lists any more: it was removed.
func (r *Relay) sendNoLists(entry string) {
	r.o.Bridge.Broadcast(map[string]any{"type": "server_lists", "server": entry, "lists": nil})
}
