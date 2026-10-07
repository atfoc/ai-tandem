package remotes

import (
	"errors"
	"sort"
	"sync"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/runs"
)

// The chat manager is the relay's Local, and the relay is half of the chat manager's RemoteServers.
var (
	_ Local = (*chats.Manager)(nil)
	_       = interface {
		Entry(id string) (chats.RemoteEntry, bool)
		ByKey(key string) (chats.RemoteEntry, bool)
	}((*Relay)(nil))
)

// fakeRuns stands in for the run service: it keeps draft runs that have a server and notes what
// it is told.
type fakeRuns struct {
	mu       sync.Mutex
	drafts   map[string]model.RunMeta // the draft runs, by id
	starts   []string                 // "id=state" for every SetRemoteStart
	handed   []string                 // the ids HandOver was called for
	views    []model.RunView          // the views HandOver was given
	reissued []string                 // "old>new" for every Reissue
	next     []string                 // the ids Reissue hands out, in order
	ups      []string                 // the entries ServerUp was called for
	resets   []string                 // the ids ResetServer was called for
	onUp     func(entry string)
	onHand   func(id string)
	lost     map[string]bool // the ids HandOver answers runs.ErrNotFound for: the draft changed
}

var errNoDraft = errors.New("no such draft run")

// draft adds a draft run on the entry.
func (f *fakeRuns) draft(id, entry, state string) model.RunMeta {
	f.mu.Lock()
	defer f.mu.Unlock()
	meta := model.RunMeta{ID: id, Name: "Run " + id, Group: "g_here", Agent: model.Claude, Cwd: "/home/standin/work", Server: entry, RemoteStart: state}
	f.drafts[id] = meta
	return meta
}

func (f *fakeRuns) RemoteDraft(id string) (model.RunMeta, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	meta, ok := f.drafts[id]
	return meta, ok && meta.Server != ""
}

func (f *fakeRuns) SetRemoteStart(id, state string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	meta, ok := f.drafts[id]
	if !ok {
		return errNoDraft
	}
	meta.RemoteStart = state
	f.drafts[id] = meta
	f.starts = append(f.starts, id+"="+state)
	return nil
}

// HandOver is the run service's: runs.ErrNotFound unless the id is a draft on the entry.
func (f *fakeRuns) HandOver(id, entry string, started model.RunView) (model.RunMeta, error) {
	f.mu.Lock()
	meta, ok := f.drafts[id]
	ok = ok && meta.Server == entry && !f.lost[id]
	if ok {
		delete(f.drafts, id)
	}
	f.handed, f.views = append(f.handed, id), append(f.views, started)
	on := f.onHand
	f.mu.Unlock()
	if on != nil {
		on(id)
	}
	if !ok {
		return model.RunMeta{}, runs.ErrNotFound
	}
	return meta, nil
}

func (f *fakeRuns) Reissue(id string) (model.RunView, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	meta, ok := f.drafts[id]
	if !ok || len(f.next) == 0 {
		return model.RunView{}, errNoDraft
	}
	delete(f.drafts, id)
	meta.ID, meta.RemoteStart, f.next = f.next[0], "", f.next[1:]
	f.drafts[meta.ID] = meta
	f.reissued = append(f.reissued, id+">"+meta.ID)
	return model.RunView{ID: meta.ID, Name: meta.Name, Group: meta.Group, Agent: meta.Agent, Cwd: meta.Cwd, Server: meta.Server, Was: id}, nil
}

func (f *fakeRuns) DraftsOn(entry string) []model.RunMeta {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []model.RunMeta
	for _, meta := range f.drafts {
		if meta.Server == entry {
			out = append(out, meta)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (f *fakeRuns) ServerUp(entry string) {
	f.mu.Lock()
	f.ups = append(f.ups, entry)
	on := f.onUp
	f.mu.Unlock()
	if on != nil {
		on(entry)
	}
}

func (f *fakeRuns) ResetServer(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.resets = append(f.resets, id)
	if meta, ok := f.drafts[id]; ok {
		meta.Server, meta.RemoteStart = "", ""
		f.drafts[id] = meta
	}
	return nil
}

// told is a copy of one of the lists the fake keeps, read under its lock.
func (f *fakeRuns) told(list *[]string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), (*list)...)
}
