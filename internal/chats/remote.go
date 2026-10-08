package chats

// A chat's server before its first message.
//
// A chat can run on another AI Whiteboard server (an entry of the server list). Until its first
// message it is a chat object here like any other, which carries the entry it will start on
// (ChatMeta.Server): its agent, folder, model and effort are chosen against that server's lists
// and that server's part of the defaults, and nothing of them is checked on this computer. No
// agent ever starts for it here: its first message is sent by the package that talks to the
// servers (internal/remotes), which then asks for the object to be handed over (HandOver) and
// keeps a record of the chat in its place.

import (
	"errors"
	"fmt"
	"slices"
	"sort"

	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/usable"
)

// RemoteEntry is what the chat manager needs to know of an entry of the server list.
type RemoteEntry struct {
	ID, Name, Key      string // Key: the instance id; "" until the entry's first hello
	Connected, Stopped bool   // Stopped: a state that waits for the user (servers.State.Stopped)
	HasLists           bool
	Agents             []model.AgentKind
	Catalogs           map[model.AgentKind]*model.Catalog
	Home, DefaultCwd   string
}

// RemoteServers is what the chat manager asks about the other servers. Its calls may be made
// with a chat's lock held, but for Dir, which asks the server and is called with none.
type RemoteServers interface {
	Entry(id string) (RemoteEntry, bool)
	ByKey(key string) (RemoteEntry, bool)
	Dir(entry, path string) (abs string, err error) // GET /api/dirs there; ErrServerUnreachable; a 400 there wraps agent.ErrFolderMissing
	DropLeftover(entry, chat string)                // DELETE there when connected, in the background
	// BoardOn tells of a board that lives on another server: the entry it is on, its group here
	// and whether it is archived. ok is false for a board this server keeps no record of.
	BoardOn(id string) (entry, group string, archived, ok bool)
}

var (
	ErrServerUnknown     = errors.New("no such server")
	ErrBoardLocal        = errors.New("boards and the chats on them are on this computer")
	ErrServerFixed       = errors.New("a chat on a run is on the run's server") // and one on a board of another server on the board's
	ErrServerUnusable    = errors.New("no chat can be started on that server")
	ErrServerUnreachable = errors.New("the server is not connected")
	ErrStartUnconfirmed  = errors.New("the first message may have arrived: server and agent are fixed until that is known")
	// ErrRemoteStart is what a call that would start an agent here answers for a chat that starts
	// on another server: its messages do not come this way.
	ErrRemoteStart = errors.New("the chat starts on another server")
	// ErrRunNotStarted refuses a chat on a run that will start on another server and has not
	// started: the chat would be here and its run there.
	ErrRunNotStarted = errors.New("start the run first: its chats are on the run's server")
)

// side is the server a chat's choices are made against: this computer (the zero value) or an
// entry of the server list, as it was when the side was taken.
type side struct {
	remote bool
	entry  RemoteEntry
}

// id is ChatMeta.Server of a chat on the side.
func (s side) id() string {
	if !s.remote {
		return ""
	}
	return s.entry.ID
}

// key names the side's part of the defaults; "" for an entry that has not said who it is.
func (s side) key() string {
	if !s.remote {
		return model.LocalServer
	}
	return s.entry.Key
}

// defaultCwd is the folder a chat on the side gets when nothing names one.
func (s side) defaultCwd(m *Manager) string {
	if !s.remote {
		return m.DefaultCwd
	}
	return s.entry.DefaultCwd
}

// localServer says whether server, as a request or a chat.json names it, is this computer.
func localServer(server string) bool { return server == "" || server == model.LocalServer }

// sideOf is the side of the server named server: an entry id, or one of the two names of this
// computer. With no server list every other server is unknown, in the words of before there
// were any.
func (m *Manager) sideOf(server string) (side, error) {
	if localServer(server) {
		return side{}, nil
	}
	if m.Servers == nil {
		return side{}, fmt.Errorf("unknown server %q", server)
	}
	e, ok := m.Servers.Entry(server)
	if !ok {
		return side{}, ErrServerUnknown
	}
	return side{remote: true, entry: e}, nil
}

// stickySide is the side of the sticky server of group: the group's, then the ungrouped
// group's, each skipped when no entry has its key or the entry waits for the user; else this
// computer.
func (m *Manager) stickySide(group string) side {
	if m.Servers == nil {
		return side{}
	}
	var d model.Defaults
	m.Store.Read(func(s *model.State) { d = defaults.Copy(s.Defaults) })
	var found RemoteEntry
	key := defaults.Server(d, group, func(k string) bool {
		if k == model.LocalServer {
			return true
		}
		e, ok := m.Servers.ByKey(k)
		if ok && !e.Stopped {
			found = e
		}
		return ok && !e.Stopped
	})
	if key == model.LocalServer {
		return side{}
	}
	return side{remote: true, entry: found}
}

// newSide is the side the chat n asks for starts on. A chat with a client mark is on this
// computer: an API client's chat is never passed on. A chat on a run is on the run's server
// (ErrServerFixed for another), a chat on a board on the board's: this computer (ErrBoardLocal),
// or the entry boardOn for a board of another server (ErrServerFixed), whatever the sticky server
// of the board's group. Any other chat is on the server it names, which must
// be one a chat can be started on (ErrServerUnusable), else on the sticky server of group.
func (m *Manager) newSide(n NewChat, ri *RunInfo, board bool, boardOn, group string) (side, error) {
	switch {
	case n.Client != "":
		if !localServer(n.Server) {
			return side{}, fmt.Errorf("unknown server %q", n.Server)
		}
		return side{}, nil
	case ri != nil:
		if n.Server != "" && !sameServer(n.Server, ri.Server) {
			return side{}, ErrServerFixed
		}
		return m.sideOf(ri.Server)
	case board && boardOn != "":
		if n.Server != "" && !sameServer(n.Server, boardOn) {
			return side{}, ErrServerFixed
		}
		return m.sideOf(boardOn)
	case board:
		if !localServer(n.Server) {
			return side{}, ErrBoardLocal
		}
		return side{}, nil
	case n.Server != "":
		on, err := m.sideOf(n.Server)
		if err == nil && on.remote && on.entry.Stopped {
			err = ErrServerUnusable
		}
		return on, err
	}
	return m.stickySide(group), nil
}

// remoteBoard asks the server list of the board id: the entry of the server it is on, its group
// here and whether it is archived. ok is false with no server list, and for a board that list
// keeps no record of. A board of this server is not asked for here: Boards has it.
func (m *Manager) remoteBoard(id string) (entry, group string, archived, ok bool) {
	if m.Servers == nil {
		return "", "", false, false
	}
	if entry, group, archived, ok = m.Servers.BoardOn(id); !ok || entry == "" {
		return "", "", false, false
	}
	return entry, group, archived, true
}

// boardServer is the entry of the server the board id is on, "" for this computer: a board of
// this server, and one nobody knows.
func (m *Manager) boardServer(id string) string {
	if _, ok := m.Boards.Get(id); ok {
		return ""
	}
	entry, _, _, _ := m.remoteBoard(id)
	return entry
}

// sameServer says whether a and b name one server.
func sameServer(a, b string) bool {
	return a == b || localServer(a) && localServer(b)
}

// configSide is the side the chat object c is on once req is done, and whether that is another
// server than it is on now. p is the meta of c's top-level chat. c.mu held.
//
// A server req names must be one of the list (ErrServerUnknown); for a chat on a board it must
// be the board's: this computer (ErrBoardLocal), or the entry of a board on another server
// (ErrServerFixed); for a chat on a run the run's (ErrServerFixed), and another
// one than the chat has must not wait for the user (ErrServerUnusable). A chat with a client
// mark stays here: any other server is unknown to it, as before there were any. Whether the
// chat may change its server at all is the caller's to say.
func (m *Manager) configSide(c *Chat, p model.ChatMeta, req ConfigReq) (on side, moved bool, err error) {
	if req.Server == "" {
		on, err = m.sideOf(c.meta.Server)
		return on, false, err
	}
	if p.Client != "" && !localServer(req.Server) {
		return side{}, false, fmt.Errorf("unknown server %q", req.Server)
	}
	if on, err = m.sideOf(req.Server); err != nil {
		return side{}, false, err
	}
	if p.Board != "" {
		switch entry := m.boardServer(p.Board); {
		case entry != "" && !sameServer(req.Server, entry):
			return side{}, false, ErrServerFixed
		case entry == "" && on.remote:
			return side{}, false, ErrBoardLocal
		}
	}
	if p.Run != "" {
		if ri, _ := m.runOf(p.Run); !sameServer(req.Server, ri.Server) {
			return side{}, false, ErrServerFixed
		}
	}
	moved = on.id() != c.meta.Server
	if moved && on.remote && on.entry.Stopped {
		return side{}, false, ErrServerUnusable
	}
	return on, moved, nil
}

// agentsOn lists the agents a chat on the side can be given. nil is every kind (this computer
// with no look-up); for another server it is never nil, and empty while its lists are not known.
func (m *Manager) agentsOn(on side) []model.AgentKind {
	if !on.remote {
		return m.Agents.Refresh()
	}
	if !on.entry.HasLists {
		return []model.AgentKind{}
	}
	return append([]model.AgentKind{}, on.entry.Agents...)
}

// checkAgent says whether a chat on the side can be given the agent a: a *usable.MissingError
// when it cannot. Of another server only its list is asked, and nothing while that is not known.
func (m *Manager) checkAgent(on side, a model.AgentKind) error {
	if !on.remote {
		return m.Agents.Check(a)
	}
	if on.entry.HasLists && !slices.Contains(on.entry.Agents, a) {
		return &usable.MissingError{Agent: a}
	}
	return nil
}

// agentOn is the agent a chat on the side in group starts with when none is named: the sticky
// agent of the group for that server (defaults.Agent), and none when the side can use none or its
// list is not known. On the run ri, whose group that is, it is the same; only where no agent the
// side can use was chosen before is it the run's agent kind, when the side can use that.
func (m *Manager) agentOn(on side, group string, ri *RunInfo) model.AgentKind {
	can := m.agentsOn(on)
	var d model.Defaults
	m.Store.Read(func(s *model.State) { d = defaults.Copy(s.Defaults) })
	if ri != nil && slices.Contains(can, ri.Agent) {
		if chosen, _ := defaults.Recorded(d, group, on.key(), "", can); !chosen {
			return ri.Agent
		}
	}
	return defaults.Agent(d, group, on.key(), can)
}

// catalogOn is the model list of a on the side: this computer's (see catalog), or the one the
// entry reported, nil when it reported none: a model and an effort are then taken unchecked.
func (m *Manager) catalogOn(on side, a model.AgentKind) *model.Catalog {
	if !on.remote {
		return m.catalog(a)
	}
	return on.entry.Catalogs[a]
}

// dirOn is the folder path names on the side, absolute. Here it must be a folder (expandDir)
// outside the app's own (ErrAppFolder); on another server that server says (RemoteServers.Dir),
// so no chat's lock may be held for one.
func (m *Manager) dirOn(on side, path string) (string, error) {
	if on.remote {
		return m.Servers.Dir(on.entry.ID, path)
	}
	abs, err := expandDir(path)
	if err != nil {
		return "", err
	}
	if m.Store.P.Contains(abs) {
		return "", ErrAppFolder
	}
	return abs, nil
}

// remoteDir is a folder as the server entry gave it (see ConfigureOf); the zero value is none.
type remoteDir struct {
	entry, abs string
}

// sessionFor is the session id a chat object gets with the agent a: one of its own for Claude
// and pi, none for Cursor, which makes its own, and none without an agent.
func sessionFor(a model.AgentKind) string {
	if a == model.Claude || a == model.Pi {
		return uuid()
	}
	return ""
}

// remoteUnstarted says whether c is a chat that will start on another server: top-level, a
// person's, not started and no fork, with a server. c.mu held.
func remoteUnstarted(c *Chat) bool {
	return c.top == nil && c.role == "" && !c.meta.Locked && c.meta.ForkedFrom == "" && c.meta.Server != ""
}

// lockRemote returns the chat object of the chat id with its mu held when it is one that will
// start on another server (see remoteUnstarted), else ErrNotFound.
func (m *Manager) lockRemote(id string) (*Chat, error) {
	c, err := m.lockTop(id)
	if err != nil {
		return nil, err
	}
	if !remoteUnstarted(c) {
		c.mu.Unlock()
		return nil, ErrNotFound
	}
	return c, nil
}

// RemoteUnstarted reports whether the chat id will start on another server: an unlocked,
// top-level, unforked chat with a server. meta is its chat.json, token included: it is for
// server code and must never be serialised to a client.
func (m *Manager) RemoteUnstarted(id string) (meta model.ChatMeta, ok bool) {
	c, err := m.lockRemote(id)
	if err != nil {
		return model.ChatMeta{}, false
	}
	defer c.mu.Unlock()
	return c.meta, true
}

// UnstartedOn lists the chats that will start on the server entry, oldest first. The metas hold
// the chats' tokens (see RemoteUnstarted).
func (m *Manager) UnstartedOn(entry string) []model.ChatMeta {
	var out []model.ChatMeta
	for _, c := range m.all() {
		c.mu.Lock()
		if !c.deleted && !c.unlisted && remoteUnstarted(c) && c.meta.Server == entry {
			out = append(out, c.meta)
		}
		c.mu.Unlock()
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Created.Equal(out[j].Created) {
			return out[i].Created.Before(out[j].Created)
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// SetRemoteStart records what is known of the first message sent to the server of the chat id,
// which must be one RemoteUnstarted reports (ErrNotFound otherwise): "" (nothing is there),
// model.RemoteLeft or model.RemoteUnconfirmed. It writes chat.json and sends the chat's view,
// which tells the last of the three alone (ChatView.Start); a state the chat has already
// changes nothing.
func (m *Manager) SetRemoteStart(id, state string) error {
	switch state {
	case "", model.RemoteLeft, model.RemoteUnconfirmed:
	default:
		return fmt.Errorf("unknown state of a first message %q", state)
	}
	c, err := m.lockRemote(id)
	if err != nil {
		return err
	}
	if c.meta.RemoteStart == state {
		c.mu.Unlock()
		return nil
	}
	var out outbox
	c.meta.RemoteStart = state
	err = m.save(c)
	out.emitIdentity(c)
	c.mu.Unlock()
	m.send(out)
	return err
}

// HandOver takes the chat id, which must be one RemoteUnstarted reports (ErrNotFound otherwise),
// out of this manager: it has started on its server, and whoever calls keeps a record of it
// from here on, under the same id. meta is its chat.json as it was, token included.
//
// In one hold of the chat's lock, the chat's server, agent, folder, model and effort become the
// defaults of its group, as a first message sent here makes them (of a chat on a run the agent,
// model and effort alone, of a chat on a board all but the server, and nothing while its server's key is unknown), and the chat object is retired. Then its token and
// its folder go. Of the chat itself nothing is sent: no chat_removed, since the chat is still
// there for the clients, and what is queued for the object is dropped (see cast). The bridge is
// not told to forget it, so its followers and its mark stay. It holds the creation lock of the
// id, as remove does.
func (m *Manager) HandOver(id string) (model.ChatMeta, error) {
	defer m.ids.lock(id)()
	c, err := m.lockRemote(id)
	if err != nil {
		return model.ChatMeta{}, err
	}
	var out outbox
	meta := c.meta
	// The entry may be gone from the list by now: its key is then not known, and nothing is
	// recorded.
	if on, err := m.sideOf(meta.Server); err == nil {
		server := on.key()
		if meta.Run != "" || meta.Board != "" {
			server = "" // the run's server or the board's, not one chosen for a new chat of the group
		}
		m.recordDefaults(c, on.key(), server, meta.Agent, defaultsCwd(c, meta.Cwd), model.ModelChoice{Model: meta.Model, Effort: meta.Effort}, &out)
	}
	// What retire does, in the hold that recorded: no change of the chat falls between the two.
	c.deleted = true
	c.gone.Store(true)
	c.gen++
	if c.ag != nil { // never: nothing starts an agent for it
		c.ag.Close()
		c.ag = nil
	}
	c.carry = nil
	c.mu.Unlock()
	m.send(out)
	m.revokeChatExtras(id)
	m.unregisterChatToken(meta.Token)
	m.mu.Lock()
	if m.chats[id] == c {
		delete(m.chats, id)
	}
	m.mu.Unlock()
	if err := m.removeChatDir(id, meta.Run); err != nil {
		return meta, err
	}
	m.dropRoot(id) // after the folder: a late lookup never falls back to chats/<id>
	return meta, nil
}

// ServerUp is called when the server entry has connected and its lists are known. Every chat
// that will start on it and has no agent, or one that server cannot use, gets the agent a new
// chat in its place would (agentOn) with that agent's model and effort, and a folder when it
// has none; its view is sent. A chat whose first message may have arrived keeps what was sent.
func (m *Manager) ServerUp(entry string) {
	on, err := m.sideOf(entry)
	if err != nil || !on.remote || !on.entry.HasLists {
		return
	}
	for _, meta := range m.UnstartedOn(entry) {
		c, err := m.lockRemote(meta.ID)
		if err != nil {
			continue
		}
		var out outbox
		if c.meta.Server == entry && c.meta.RemoteStart != model.RemoteUnconfirmed &&
			(c.meta.Agent == "" || !slices.Contains(on.entry.Agents, c.meta.Agent)) {
			m.rechoose(c, on, false, &out)
		}
		c.mu.Unlock()
		m.send(out)
	}
}

// ResetServer puts the chat id, when it is one that will start on another server, on this
// computer: with the agent, folder, model and effort a new chat in its place starts with here,
// and nothing known of a first message. Its view is sent. It is for a server that left the
// list: nothing is sent to that server. ErrNotFound for an id that is no chat's; a chat that is
// on this computer already is left as it is.
func (m *Manager) ResetServer(id string) error {
	c, err := m.lockTop(id)
	if err != nil {
		return err
	}
	if !remoteUnstarted(c) {
		c.mu.Unlock()
		return nil
	}
	var out outbox
	err = m.rechoose(c, side{}, true, &out)
	c.mu.Unlock()
	m.send(out)
	return err
}

// rechoose gives the chat object c, which will start on another server, what a new chat in its
// place starts with on the side on. With all it is put on that side whole: server, agent, folder,
// model and effort, and nothing known of a first message. Without, it stays where it is and gets
// another agent, when on would give it another than it has, and a folder when it has none.
// chat.json is written and the view queued when something changed. c.mu held.
func (m *Manager) rechoose(c *Chat, on side, all bool, out *outbox) error {
	var ri *RunInfo
	if c.meta.Run != "" {
		if r, ok := m.runOf(c.meta.Run); ok {
			ri = &r
		}
	}
	group := m.GroupOf(c.meta)
	a := m.agentOn(on, group, ri)
	cwd, mc := m.startChoiceOn(on, group, a, ri, c.meta.Client != "")
	next := c.meta
	if all {
		next.Server, next.RemoteStart, next.Cwd = on.id(), "", cwd
	} else if next.Cwd == "" {
		next.Cwd = cwd
	}
	if all || a != c.meta.Agent {
		next.Agent, next.Model, next.Effort, next.SessionID = a, mc.Model, mc.Effort, sessionFor(a)
	}
	if !all && next.Agent == c.meta.Agent && next.Cwd == c.meta.Cwd {
		return nil
	}
	c.meta = next
	if c.errText != "" || c.folderMissing {
		// What a start that failed left is of the agent or the folder before.
		c.folderMissing = false
		c.errText = ""
		if tr, err := m.trOf(c, out); err == nil {
			tr.SetStatus(model.StatusReady)
		}
	}
	err := m.save(c)
	out.emitChat(c)
	return err
}

// dropLeftover asks the server of the deleted chat object top to drop the chat, when top was to
// start there and a first message was sent: the chat may be there, started or not. top may be
// nil. Its meta is read after the delete, which nothing changes any more.
func (m *Manager) dropLeftover(top *Chat) {
	if top == nil || m.Servers == nil {
		return
	}
	top.mu.Lock()
	meta, was := top.meta, remoteUnstarted(top)
	top.mu.Unlock()
	if was && meta.RemoteStart != "" {
		m.Servers.DropLeftover(meta.Server, meta.ID)
	}
}
