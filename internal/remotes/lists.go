package remotes

import (
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
)

// ServerLists is what a remote server offers for a new chat, as the pages get it: its usable
// agents, their model lists, its home folder and its default folder. Nothing else of a server
// is in it. The lists are kept by servers.Manager, in memory only, and stay while the entry is
// unreachable.
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

// Lists are the lists of every entry whose lists are known, by entry id. Never nil.
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

// entryOf is a remote entry as the chat manager sees it.
func (r *Relay) entryOf(v servers.View) (chats.RemoteEntry, bool) {
	if v.Local {
		return chats.RemoteEntry{}, false
	}
	e := chats.RemoteEntry{
		ID: v.ID, Name: v.Name, Key: v.InstanceID,
		Connected: v.State == servers.StateConnected, Stopped: v.State.Stopped(),
	}
	if l, ok := r.o.Servers.Lists(v.ID); ok {
		e.HasLists = true
		e.Agents, e.Catalogs, e.Home, e.DefaultCwd = l.Agents, l.Catalogs, l.Home, l.DefaultCwd
	}
	return e, true
}

// Entry is the remote entry with this id; ok is false for the local entry and for an unknown
// id. It takes no lock of the relay: the chat manager calls it with a chat's lock held.
func (r *Relay) Entry(id string) (chats.RemoteEntry, bool) {
	if id == servers.LocalID {
		return chats.RemoteEntry{}, false
	}
	v, ok := r.o.Servers.View(id)
	if !ok {
		return chats.RemoteEntry{}, false
	}
	return r.entryOf(v)
}

// ByKey is the remote entry whose server has the instance id key; ok is false for this server's
// own id and for one no entry has. Like Entry it takes no lock of the relay.
func (r *Relay) ByKey(key string) (chats.RemoteEntry, bool) {
	v, ok := r.o.Servers.ByInstance(key)
	if !ok {
		return chats.RemoteEntry{}, false
	}
	return r.entryOf(v)
}
