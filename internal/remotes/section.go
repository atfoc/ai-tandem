package remotes

// A section: the tree of one entry, as its server has it, and what the relay makes of that
// server's events about it.
//
// The tree comes whole in the snapshot of every stream's start and is kept current by the
// events after it. The relay decodes both with the types of package model and adds nothing; of
// a group it drops "collapsed", which is that server's own matter. Every event is applied to
// the tree first and passed on to the pages after, with the entry's id as "server": a page that
// connects in between gets the change in its snapshot and once more as an event, never neither.
// All of it happens on the entry's worker, so the events of one entry leave in that server's
// order.

import (
	"bytes"
	"encoding/json"
	"slices"
	"time"

	"ai-whiteboard/internal/model"
)

// Tree is the tree of one server as the pages get it: in the snapshot's "sections" and in a
// section event. No list in it is nil.
type Tree struct {
	Groups   []model.Group       `json:"groups"`
	Boards   []model.Board       `json:"boards"`
	Chats    []model.ChatView    `json:"chats"`
	States   []model.BranchState `json:"states"`
	Defaults model.Defaults      `json:"defaults"`
}

// clone is the tree with lists of its own: what is handed out while the worker goes on changing
// the tree. An item of a list is never changed in place, only replaced.
func (t Tree) clone() Tree {
	return Tree{
		Groups: slices.Clone(t.Groups), Boards: slices.Clone(t.Boards), Chats: slices.Clone(t.Chats),
		States: slices.Clone(t.States), Defaults: t.Defaults,
	}
}

// sectionEvent is the "section" event: the whole tree of the entry, or null once the relay
// holds none of it.
type sectionEvent struct {
	Type   string `json:"type"`
	Server string `json:"server"`
	Tree   *Tree  `json:"tree"`
}

// maxEarly bounds the chats whose branch states are kept before their view came (section.early).
const maxEarly = 64

// stateKey names one branch of a chat.
type stateKey struct{ chat, branch string }

// section is the tree of one entry in memory, with where each item is in its list. Relay.mu
// guards it; the entry's worker alone changes it.
type section struct {
	tree   Tree
	boards map[string]int
	chats  map[string]int
	states map[stateKey]int
	// early holds the branch states of chats that are not in the tree, by chat id. A server
	// sends the state of a new chat's branch before the chat's view: the state waits here for
	// the view, and joins the tree with it.
	early map[string][]model.BranchState
	// foreign holds the ids of the chats whose view was dropped as not this build's (see
	// remoteChat). Such a chat is never in the tree, so the states of its branches are not kept
	// in early, and no page gets them. An id goes when the chat is removed, or when its view
	// comes as this build's.
	foreign map[string]bool
}

// remoteChat is a chat view as a server may send it that has runs, which this build has not: a
// chat on a run names it, a run agent's chat has a role. Neither is this build's chat (see
// ours).
type remoteChat struct {
	model.ChatView
	Run  string `json:"run"`
	Role string `json:"role"`
}

// ours reports whether the view is a chat of this build: one on no run and with no role.
func (v remoteChat) ours() bool { return v.Run == "" && v.Role == "" }

// sectionOf reads the tree of a snapshot. A chat on a run and a run agent's chat of a server that
// has runs are not taken, and a branch state belongs to a chat of the list: neither is taken
// otherwise. The snapshot's runs are not read. No list holds an id twice.
func sectionOf(raw json.RawMessage) (*section, error) {
	var snap struct {
		Groups   []model.Group       `json:"groups"`
		Boards   []model.Board       `json:"boards"`
		Chats    []remoteChat        `json:"chats"`
		States   []model.BranchState `json:"states"`
		Defaults model.Defaults      `json:"defaults"`
	}
	if err := json.Unmarshal(raw, &snap); err != nil {
		return nil, err
	}
	sec := &section{tree: Tree{Boards: []model.Board{}, Chats: []model.ChatView{}, States: []model.BranchState{}},
		boards: map[string]int{}, chats: map[string]int{}, states: map[stateKey]int{},
		early: map[string][]model.BranchState{}, foreign: map[string]bool{}}
	sec.setGroups(snap.Groups)
	sec.setDefaults(snap.Defaults)
	for _, b := range snap.Boards {
		sec.putBoard(b)
	}
	for _, v := range snap.Chats {
		if v.ours() {
			sec.putChat(v.ChatView)
		} else {
			sec.foreign[v.ID] = true
		}
	}
	for _, st := range snap.States {
		if sec.hasChat(st.Chat) {
			sec.putState(st)
		}
	}
	return sec, nil
}

// setGroups makes groups the section's whole group list, in that order, without "collapsed".
func (sec *section) setGroups(groups []model.Group) []model.Group {
	out := make([]model.Group, len(groups))
	for i, g := range groups {
		g.Collapsed = false
		out[i] = g
	}
	sec.tree.Groups = out
	return out
}

func (sec *section) setDefaults(d model.Defaults) model.Defaults {
	if d.Groups == nil {
		d.Groups = map[string]model.GroupDefaults{}
	}
	sec.tree.Defaults = d
	return d
}

// putBoard, putChat and putState replace the item with the same id in its list, or add
// it where that server's own list has it: a board and a chat by the time they were made and
// then by id, so a new one is last; a branch state behind the states of its chat, which
// stand by the chat's id. A list of a snapshot, which that server sorted so, stays as it came.
func (sec *section) putBoard(b model.Board) {
	if i, ok := sec.boards[b.ID]; ok {
		sec.tree.Boards[i] = b
		return
	}
	sec.tree.Boards = placed(sec.tree.Boards, b, func(x model.Board) bool { return madeAfter(x.Created, x.ID, b.Created, b.ID) })
	indexed(sec.boards, sec.tree.Boards, func(x model.Board) string { return x.ID })
}

func (sec *section) putChat(v model.ChatView) {
	if i, ok := sec.chats[v.ID]; ok {
		sec.tree.Chats[i] = v
		return
	}
	sec.tree.Chats = placed(sec.tree.Chats, v, func(x model.ChatView) bool { return madeAfter(x.Created, x.ID, v.Created, v.ID) })
	indexed(sec.chats, sec.tree.Chats, func(x model.ChatView) string { return x.ID })
}

func (sec *section) putState(st model.BranchState) {
	k := stateKey{st.Chat, st.Branch}
	if i, ok := sec.states[k]; ok {
		sec.tree.States[i] = st
		return
	}
	sec.tree.States = placed(sec.tree.States, st, func(x model.BranchState) bool { return x.Chat > st.Chat })
	indexed(sec.states, sec.tree.States, func(x model.BranchState) stateKey { return stateKey{x.Chat, x.Branch} })
}

// madeAfter reports whether the thing made at a with the id aID stands behind the one made at b
// with the id bID in a list of its server: the older one first, and of two of one time the one
// with the smaller id.
func madeAfter(a time.Time, aID string, b time.Time, bID string) bool {
	if c := a.Compare(b); c != 0 {
		return c > 0
	}
	return aID > bID
}

// placed is list with v in front of the first item that stands behind it, at the end with none:
// where a new item of a list in its server's order goes, and the one after another of a
// snapshot, which is looked at from the end.
func placed[T any](list []T, v T, behind func(T) bool) []T {
	at := len(list)
	for at > 0 && behind(list[at-1]) {
		at--
	}
	return slices.Insert(list, at, v)
}

// indexed makes at the place of every item of list, by its key. Only the last item is new to at
// when at has all the others.
func indexed[T any, K comparable](at map[K]int, list []T, key func(T) K) {
	if n := len(list); len(at) == n-1 {
		if _, has := at[key(list[n-1])]; !has {
			at[key(list[n-1])] = n - 1
			return
		}
	}
	clear(at)
	for i, x := range list {
		at[key(x)] = i
	}
}

func (sec *section) hasChat(id string) bool {
	_, ok := sec.chats[id]
	return ok
}

// dropBoard and dropChat take the item out of its list and report whether it was
// there. A chat's branch states go with it.
func (sec *section) dropBoard(id string) bool {
	if _, ok := sec.boards[id]; !ok {
		return false
	}
	sec.tree.Boards = slices.DeleteFunc(sec.tree.Boards, func(b model.Board) bool { return b.ID == id })
	clear(sec.boards)
	for i, b := range sec.tree.Boards {
		sec.boards[b.ID] = i
	}
	return true
}

func (sec *section) dropChat(id string) bool {
	delete(sec.early, id)
	delete(sec.foreign, id)
	if _, ok := sec.chats[id]; !ok {
		return false
	}
	sec.tree.Chats = slices.DeleteFunc(sec.tree.Chats, func(v model.ChatView) bool { return v.ID == id })
	clear(sec.chats)
	for i, v := range sec.tree.Chats {
		sec.chats[v.ID] = i
	}
	sec.tree.States = slices.DeleteFunc(sec.tree.States, func(st model.BranchState) bool { return st.Chat == id })
	clear(sec.states)
	for i, st := range sec.tree.States {
		sec.states[stateKey{st.Chat, st.Branch}] = i
	}
	return true
}

// keepEarly keeps the state of a branch of a chat that is not in the tree until the chat's view
// comes. The chats it keeps states of are bounded: over the bound all are dropped, and a chat
// whose view comes after that has its states from its next change on.
func (sec *section) keepEarly(st model.BranchState) {
	states, known := sec.early[st.Chat]
	if !known && len(sec.early) >= maxEarly {
		clear(sec.early)
	}
	for i := range states {
		if states[i].Branch == st.Branch {
			states[i] = st
			return
		}
	}
	sec.early[st.Chat] = append(states, st)
}

// Sections are the trees the relay holds, by entry id: the snapshot's "sections". An entry has
// a key only while its connection is up and its snapshot was read. Never nil. It takes the
// relay's lock alone, which is held over no I/O and no call of the bridge: the page's snapshot
// calls it with the bridge's lock held.
func (r *Relay) Sections() map[string]Tree {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]Tree, len(r.sections))
	for entry, sec := range r.sections {
		out[entry] = sec.tree.clone()
	}
	return out
}

// held reports whether the relay holds the entry's tree.
func (r *Relay) held(entry string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sections[entry] != nil
}

// change runs f on the entry's section under the relay's lock, and reports false, running
// nothing, when no tree of the entry is held: an event of a thing of a section is applied and
// sent only while its tree is.
func (r *Relay) change(entry string, f func(sec *section)) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	sec := r.sections[entry]
	if sec == nil {
		return false
	}
	f(sec)
	return true
}

// listEvent takes an event that changes the entry's tree: the tree takes it, and the pages get
// it with the entry's id as "server". The event a page gets is made from what the tree took, so
// the two agree.
func (r *Relay) listEvent(entry, typ string, raw json.RawMessage) {
	var ev struct {
		Groups   []model.Group      `json:"groups"`
		Defaults *model.Defaults    `json:"defaults"`
		Board    *model.Board       `json:"board"`
		Chat     *remoteChat        `json:"chat"`
		State    *model.BranchState `json:"state"`
		ID       string             `json:"id"`
	}
	if json.Unmarshal(raw, &ev) != nil {
		return
	}
	b := r.o.Bridge
	out := map[string]any{"type": typ, "server": entry}
	switch typ {
	case "groups":
		if r.change(entry, func(sec *section) { out["groups"] = sec.setGroups(ev.Groups) }) {
			b.BroadcastOn(entry, out)
		}
	case "defaults":
		if ev.Defaults == nil {
			return
		}
		if r.change(entry, func(sec *section) { out["defaults"] = sec.setDefaults(*ev.Defaults) }) {
			b.BroadcastOn(entry, out)
		}
	case "board":
		if ev.Board == nil || ev.Board.ID == "" {
			return
		}
		out["board"] = *ev.Board
		if r.change(entry, func(sec *section) { sec.putBoard(*ev.Board) }) {
			b.SendBoardOn(entry, ev.Board.ID, out)
			if ev.Board.Archived {
				r.boardLetGo(entry, ev.Board.ID, false)
			}
		}
	case "board_removed":
		if ev.ID == "" {
			return
		}
		out["id"] = ev.ID
		if r.change(entry, func(sec *section) { sec.dropBoard(ev.ID) }) {
			b.SendBoardOn(entry, ev.ID, out)
			r.boardLetGo(entry, ev.ID, true)
		}
	case "chat":
		if ev.Chat == nil || ev.Chat.ID == "" {
			return
		}
		r.chatEvent(entry, *ev.Chat, out)
	case "branch_state":
		if ev.State == nil || ev.State.Chat == "" {
			return
		}
		st := *ev.State
		if st.Branch == "" {
			st.Branch = mainBranch
		}
		out["state"] = st
		listed, foreign := false, false
		if r.change(entry, func(sec *section) {
			if listed = sec.hasChat(st.Chat); listed {
				sec.putState(st)
			} else if sec.foreign[st.Chat] {
				foreign = true // a chat that is not this build's: nothing keeps its states, no page gets them
			} else {
				sec.keepEarly(st)
			}
		}) && !foreign {
			// The state of a chat that is not in the tree goes to the pages that follow the chat.
			b.SendChatOn(entry, st.Chat, !listed, out)
		}
	case "chat_removed":
		if ev.ID == "" {
			return
		}
		out["id"] = ev.ID
		listed := false
		if r.change(entry, func(sec *section) { listed = sec.dropChat(ev.ID) }) {
			b.SendChatOn(entry, ev.ID, !listed, out)
		}
	}
}

// mainBranch is the id of a chat's first branch.
const mainBranch = "main"

// chatEvent takes a chat's view. A view that names a run or has a role is not a chat of this
// build (see remoteChat): it never enters the tree, and no page gets it; the section notes the
// id, so that the states of that chat's branches are not kept. Any other view is the tree's; the branch states that came before the view of a new chat join the tree with it, and
// the pages get them first, as that server sent them.
func (r *Relay) chatEvent(entry string, rc remoteChat, out map[string]any) {
	if !rc.ours() {
		// Only the section's own lock is taken: nothing is sent and the tree does not change.
		r.change(entry, func(sec *section) {
			delete(sec.early, rc.ID)
			sec.foreign[rc.ID] = true
		})
		return
	}
	v := rc.ChatView
	out["chat"] = v
	var early []model.BranchState
	if !r.change(entry, func(sec *section) {
		delete(sec.foreign, v.ID)
		if !sec.hasChat(v.ID) {
			early = sec.early[v.ID]
			delete(sec.early, v.ID)
		}
		sec.putChat(v)
		for _, st := range early {
			sec.putState(st)
		}
	}) {
		return
	}
	for _, st := range early {
		r.o.Bridge.SendChatOn(entry, v.ID, false, map[string]any{"type": "branch_state", "server": entry, "state": st})
	}
	r.o.Bridge.SendChatOn(entry, v.ID, false, out)
}

// contentEvent hands a content event of a chat on as it came, with the entry's id as "server":
// the bridge gives it to the followers of the chat alone. The pages read "type", "chat" and
// "server" themselves, so an event that names the type or the chat twice, or otherwise than it
// was routed by, or that names a server of its own, is dropped: what the bridge routes by and
// what a page reads are then the same.
func (r *Relay) contentEvent(entry, typ string, raw json.RawMessage) {
	f, ok := fields(raw, "type", "chat", "server")
	id := text(f["chat"])
	if _, named := f["server"]; !ok || named || text(f["type"]) != typ || id == "" {
		if r.tell("content " + entry) {
			r.o.Logf("remotes: an event %q of the server %s is dropped: it cannot be passed on as it is", typ, entry)
		}
		return
	}
	if !r.held(entry) {
		return
	}
	r.o.Bridge.SendChatOn(entry, id, false, onServer(entry, raw))
}

// onServer is the JSON object raw with the member "server" before its own, which name none.
func onServer(entry string, raw json.RawMessage) json.RawMessage {
	name, _ := json.Marshal(entry)
	rest := raw[bytes.IndexByte(raw, '{')+1:]
	out := make([]byte, 0, len(raw)+len(name)+12)
	out = append(out, `{"server":`...)
	out = append(out, name...)
	out = append(out, ',')
	return append(out, rest...)
}
