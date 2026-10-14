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
	List                 // every client
	Content              // the clients that follow the item
)

// Per says what kind of item an event type is about.
type Per int

const (
	PerNone Per = iota // no chat and no board
	PerChat
	PerBoard
)

// Rule is one row of the event table.
type Rule struct {
	Class Class
	Per   Per
}

// Events is the event table: every type a server sends, by its "type". Broadcast, SendChat
// and SendBoard route by it. A type that is missing here goes to no client, and is logged.
var Events = map[string]Rule{
	"hello":           {Class: Role},
	"snapshot":        {Class: Role},
	"release_request": {Class: Role},
	"superseded":      {Class: Role},
	"held":            {Class: Role},
	"rpc":             {Class: Role},
	"server_stopping": {Class: Role},

	"groups":        {Class: List},
	"defaults":      {Class: List},
	"board":         {Class: List, Per: PerBoard},
	"board_removed": {Class: List, Per: PerBoard},
	"catalog":       {Class: List},
	"agents":        {Class: List},

	// This server's prompt library (package library).
	"own_library": {Class: List},

	"chat":         {Class: List, Per: PerChat},
	"chat_removed": {Class: List, Per: PerChat},
	"branch_state": {Class: List, Per: PerChat},
	"tree":         {Class: Content, Per: PerChat},
	"chat_items":   {Class: Content, Per: PerChat},
	"sub":          {Class: Content, Per: PerChat},
	"sub_items":    {Class: Content, Per: PerChat},
}

// Item names a chat or a board: what a client follows and what a per-item event is about.
type Item struct{ Kind, ID string }

// Chat is the item of a top-level chat.
func Chat(id string) Item { return Item{Kind: "chat", ID: id} }

// Board is the item of a board. It is not followed.
func Board(id string) Item { return Item{Kind: "board", ID: id} }

// Broadcast sends ev, an event about no chat and no board, to the clients its type is for. It
// never blocks.
func (b *Bridge) Broadcast(ev any) {
	b.route(ev, PerNone, Item{}, false)
}

// SendChat sends ev, an event of the top-level chat with this id. It never blocks.
func (b *Bridge) SendChat(chat string, ev any) {
	b.route(ev, PerChat, Chat(chat), false)
}

// SendBoard sends ev, an event of the board with this id: to every client.
// It never blocks.
func (b *Bridge) SendBoard(board string, ev any) {
	b.route(ev, PerBoard, Board(board), false)
}

// route marshals ev once and queues it for the clients the table names. per and it say which
// send function was called: a type of no item goes by its class whichever that was; a type of
// another kind of item, a role type and a type outside the table go to no client, and are logged
// once.
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
			log.Printf("editorbridge: event %q was sent outside the event table: it goes to no client", typ)
		}
		return
	}
	for _, c := range b.clients {
		if rule.Per != PerNone && (rule.Class == Content || unlisted) && !c.follows[it] {
			continue
		}
		b.sendRawLocked(c, msg)
	}
	if typ == "chat_removed" || typ == "board_removed" {
		b.forgetLocked(it)
	}
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
	if c := b.clients[clientID]; c != nil {
		delete(c.follows, it)
	}
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
// chat_removed or board_removed sent through SendChat or SendBoard.
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
