package editorbridge

import (
	"bytes"
	"encoding/json"
	"log"
	"sort"
)

// Class says which clients an event type is for.
type Class int

const (
	Role    Class = iota // the one client concerned; only the bridge sends these
	List                 // every client that has the item in its list
	Content              // the clients that follow the item
)

// Per says what kind of item an event type is about.
type Per int

const (
	PerNone Per = iota // no chat, no run and no board
	PerChat
	PerRun
	PerBoard
)

// Rule is one row of the event table. PagesOnly types reach no client of another kind: route
// does not read the field, the other kind's allow-list (APIEvents) leaves these types out, and a
// test holds the two tables together.
type Rule struct {
	Class     Class
	Per       Per
	PagesOnly bool
}

// Events is the event table: every type a server sends, by its "type". Broadcast, SendChat,
// SendRun and SendBoard route by it. A type that is missing here goes to every page, and is logged.
var Events = map[string]Rule{
	"hello":           {Class: Role},
	"snapshot":        {Class: Role},
	"release_request": {Class: Role},
	"superseded":      {Class: Role},
	"held":            {Class: Role},
	"rpc":             {Class: Role},
	"server_stopping": {Class: Role},

	"groups":        {Class: List, PagesOnly: true},
	"defaults":      {Class: List, PagesOnly: true},
	"board":         {Class: List, Per: PerBoard},
	"board_removed": {Class: List, Per: PerBoard},
	"catalog":       {Class: List},
	"agents":        {Class: List},
	"servers":       {Class: List, PagesOnly: true},
	"server_state":  {Class: List, PagesOnly: true},
	"server_lists":  {Class: List, PagesOnly: true},
	"server_back":   {Class: List, PagesOnly: true},

	"chat":         {Class: List, Per: PerChat},
	"chat_removed": {Class: List, Per: PerChat},
	"branch_state": {Class: List, Per: PerChat},
	"tree":         {Class: Content, Per: PerChat},
	"chat_items":   {Class: Content, Per: PerChat},
	"sub":          {Class: Content, Per: PerChat},
	"sub_items":    {Class: Content, Per: PerChat},
	"chat_reload":  {Class: Content, Per: PerChat, PagesOnly: true},

	"run":          {Class: List, Per: PerRun},
	"run_removed":  {Class: List, Per: PerRun},
	"run_detail":   {Class: Content, Per: PerRun},
	"run_activity": {Class: Content, Per: PerRun},
}

// APIEvents is the allow-list of an API client: the list and content types it is sent at all.
// A type added to Events alone reaches no API client.
var APIEvents = map[string]bool{
	"chat": true, "chat_items": true, "chat_removed": true, "branch_state": true, "tree": true,
	"sub": true, "sub_items": true, "catalog": true, "agents": true,
	"run": true, "run_removed": true, "run_detail": true, "run_activity": true,
	"board": true, "board_removed": true,
}

// Item names a chat, a run or a board: what a client follows and what a per-item event is about.
type Item struct{ Kind, ID string }

// Chat is the item of a top-level chat.
func Chat(id string) Item { return Item{Kind: "chat", ID: id} }

// Run is the item of a run.
func Run(id string) Item { return Item{Kind: "run", ID: id} }

// Board is the item of a board. It carries a client mark and is not followed.
func Board(id string) Item { return Item{Kind: "board", ID: id} }

// Broadcast sends ev, an event about no chat, no run and no board, to the clients its type is for. It
// never blocks.
func (b *Bridge) Broadcast(ev any) {
	b.route(ev, PerNone, Item{}, false)
}

// SendChat sends ev, an event of the top-level chat with this id. unlisted is true for a run
// agent's chat, which is in nobody's list: all its events go to its followers only. It never
// blocks.
func (b *Bridge) SendChat(chat string, unlisted bool, ev any) {
	b.route(ev, PerChat, Chat(chat), unlisted)
}

// SendRun sends ev, an event of the run with this id. It never blocks.
func (b *Bridge) SendRun(run string, ev any) {
	b.route(ev, PerRun, Run(run), false)
}

// SendBoard sends ev, an event of the board with this id: to every page, and to the API client
// whose mark the board carries. It never blocks.
func (b *Bridge) SendBoard(board string, ev any) {
	b.route(ev, PerBoard, Board(board), false)
}

// MarkBoard records the client mark of a board: SetMark for Board(board).
func (b *Bridge) MarkBoard(board, client string) {
	b.SetMark(Board(board), client)
}

// route marshals ev once and queues it for the clients the table names. per and it say which
// send function was called: a type of no item goes by its class whichever that was; a type of
// another kind of item, a role type and a type outside the table go to every page and to no
// other kind, so that a mistake shows as too much and never as a stale page.
func (b *Bridge) route(ev any, per Per, it Item, unlisted bool) {
	msg, err := json.Marshal(ev)
	if err != nil {
		return
	}
	typ := typeOf(ev, msg)
	rule, known := Events[typ]
	fits := known && rule.Class != Role && (rule.Per == PerNone || rule.Per == per)

	b.mu.Lock()
	defer b.mu.Unlock()
	if !fits {
		if !b.logged[typ] {
			b.logged[typ] = true
			log.Printf("editorbridge: event %q was sent outside the event table: it goes to every page", typ)
		}
		for _, c := range b.clients {
			if c.kind == KindPage {
				b.sendRawLocked(c, msg)
			}
		}
		return
	}
	for _, c := range b.clients {
		k := b.kinds[c.kind]
		if !k.allow(typ) {
			continue
		}
		switch {
		case rule.Per == PerNone:
		case rule.Class == Content || unlisted:
			if !c.follows[it] {
				continue
			}
		default:
			if !k.lists(c, it) {
				continue
			}
		}
		b.sendRawLocked(c, msg)
	}
	if typ == "chat_removed" || typ == "run_removed" || typ == "board_removed" {
		b.forgetLocked(it)
		delete(b.marks, it) // after the send: the client with the mark was told
	}
}

// SetMark records the client mark of it: the id of the API client that made the item, in whose
// list the item then is. "" removes it. Whoever makes or loads the item calls it before the
// item's first event. The mark ends when the item's chat_removed, run_removed or board_removed
// was sent; Forget keeps it. A follow of the item is left as it is: a client may follow an id before it is made.
func (b *Bridge) SetMark(it Item, client string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if client == "" {
		delete(b.marks, it)
		return
	}
	b.marks[it] = client
}

// MarkOf returns the client mark of it, "" for none.
func (b *Bridge) MarkOf(it Item) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.marks[it]
}

// typeOf returns the "type" of an event. msg is its JSON.
func typeOf(ev any, msg []byte) string {
	switch e := ev.(type) {
	case map[string]any:
		s, _ := e["type"].(string)
		return s
	case event:
		s, _ := e["type"].(string)
		return s
	}
	// A struct: read keys up to "type", which the events have first.
	dec := json.NewDecoder(bytes.NewReader(msg))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return ""
	}
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return ""
		}
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return ""
		}
		if key == "type" {
			var s string
			_ = json.Unmarshal(v, &s)
			return s
		}
	}
	return ""
}

// Follow notes that the client follows it, so that the item's content events reach it. It
// reports false, and starts no follow, when the id has no open stream. A follow ends with the
// client's stream, by Unfollow or by Forget.
func (b *Bridge) Follow(clientID string, it Item) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	c := b.clients[clientID]
	if c == nil {
		return false
	}
	c.follows[it] = true
	return true
}

// Unfollow ends the client's follow of it, if there is one.
func (b *Bridge) Unfollow(clientID string, it Item) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if c := b.clients[clientID]; c != nil && c.follows[it] {
		delete(c.follows, it)
		b.unfollowedLocked([]Item{it})
	}
}

// FollowAs is Follow for a caller of a known kind: when clientID's record is of another kind it
// does nothing and returns false.
func (b *Bridge) FollowAs(kind Kind, clientID string, it Item) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	c := b.clients[clientID]
	if c == nil || c.kind != kind {
		return false
	}
	c.follows[it] = true
	return true
}

// UnfollowAs is Unfollow under the same rule.
func (b *Bridge) UnfollowAs(kind Kind, clientID string, it Item) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if c := b.clients[clientID]; c != nil && c.kind == kind && c.follows[it] {
		delete(c.follows, it)
		b.unfollowedLocked([]Item{it})
	}
}

// OnUnfollowed is called, never under the bridge's lock and from a goroutine of its own, with the
// items that lost their last follower by Unfollow or by a stream's end. Not by Forget.
//
// A follower is a client of any kind. There is one call for each Unfollow, UnfollowAs or ended
// record that left an item with no follower, and none with an empty list. The calls of two such
// events may run in either order, and an item may be followed again by the time f runs: f asks
// Followed for what holds now. Nil sets no hook.
func (b *Bridge) OnUnfollowed(f func(items []Item)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.unfollowed = f
}

// unfollowedLocked hands the hook those of items, whose follows of one client just ended, that
// no client follows now.
func (b *Bridge) unfollowedLocked(items []Item) {
	if b.unfollowed == nil {
		return
	}
	var lost []Item
	for _, it := range items {
		if !b.followedLocked(it) {
			lost = append(lost, it)
		}
	}
	if len(lost) == 0 {
		return
	}
	sort.Slice(lost, func(i, j int) bool {
		if lost[i].Kind != lost[j].Kind {
			return lost[i].Kind < lost[j].Kind
		}
		return lost[i].ID < lost[j].ID
	})
	go b.unfollowed(lost)
}

// Followers returns the ids of the clients that follow it, sorted.
func (b *Bridge) Followers(it Item) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	var ids []string
	for id, c := range b.clients {
		if c.follows[it] {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// Followed reports whether any client follows it.
func (b *Bridge) Followed(it Item) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.followedLocked(it)
}

func (b *Bridge) followedLocked(it Item) bool {
	for _, c := range b.clients {
		if c.follows[it] {
			return true
		}
	}
	return false
}

// Forget drops every follow of it: the item was removed. The bridge calls it itself after a
// chat_removed, run_removed or board_removed sent through SendChat, SendRun or SendBoard. The item's client mark stays
// until that event was sent.
func (b *Bridge) Forget(it Item) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.forgetLocked(it)
}

func (b *Bridge) forgetLocked(it Item) {
	for _, c := range b.clients {
		delete(c.follows, it)
	}
}
