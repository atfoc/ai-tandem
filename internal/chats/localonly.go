package chats

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"slices"

	"ai-whiteboard/internal/model"
)

// keptFor is the one thing read of a chat.json that ChatMeta does not have: the server an
// earlier version of the app kept an unstarted chat for. It is read by LocalOnly and never
// written.
type keptFor struct {
	Server string `json:"server"`
}

// LocalOnly makes the chats an earlier version of the app kept here for another server chats of
// this computer. Such a chat never had a message: it was to start on that server, and its
// chat.json names it ("server"). It is called once at every start, after Load and before a page
// is served; with no such chat it reads the chat.json of each chat that has not started and
// changes nothing.
//
// Each of those chats gets the agent, folder, model, effort and subagent settings a new chat in
// its place starts with here, and keeps its id, name, place, draft and archive mark. One on a
// board that is not a board of this computer (boardHere says false) has nowhere to be: it is
// deleted, with its folder. So the boards must be loaded before the call. boardHere may be nil: no
// board is here then.
//
// local are the ids of the chats that were put here, deleted of those that were deleted, both
// sorted. A chat that could not be written or deleted is logged and left for the next start; err
// is the first such error.
func (m *Manager) LocalOnly(boardHere func(id string) bool) (local, deleted []string, err error) {
	failed := func(id string, e error) {
		log.Printf("chats: %s is not put on this computer: %v", id, e)
		if err == nil {
			err = e
		}
	}
	for _, c := range m.all() {
		c.mu.Lock()
		meta := c.meta
		skip := c.top != nil || c.deleted || c.unlisted || meta.Locked || meta.ForkedFrom != ""
		c.mu.Unlock()
		if skip {
			continue
		}
		raw, e := os.ReadFile(filepath.Join(m.chatDir(meta.ID), "chat.json"))
		if e != nil {
			continue // nothing on disk names a server
		}
		var old keptFor
		if json.Unmarshal(raw, &old) != nil || old.Server == "" {
			continue
		}
		if meta.Board != "" && (boardHere == nil || !boardHere(meta.Board)) {
			if e := m.Delete(meta.ID); e != nil {
				failed(meta.ID, e)
				continue
			}
			deleted = append(deleted, meta.ID)
			continue
		}
		if e := m.putHere(c); e != nil {
			failed(meta.ID, e)
			continue
		}
		local = append(local, meta.ID)
	}
	slices.Sort(local)
	slices.Sort(deleted)
	return local, deleted, err
}

// putHere gives the chat object c, which has not started, what a new chat in its place starts
// with: agent, folder, model, effort and subagent settings. chat.json is written and the view
// sent.
func (m *Manager) putHere(c *Chat) error {
	var out outbox
	c.mu.Lock()
	group := m.GroupOf(c.meta)
	a := m.startAgent(group)
	cwd, mc := m.startChoice(group, a)
	sub := m.subStartLimits(group)
	c.meta.Agent, c.meta.Model, c.meta.Effort, c.meta.SessionID = a, mc.Model, mc.Effort, sessionFor(a)
	c.meta.Cwd, c.meta.Subagents = cwd, &sub
	if c.errText != "" || c.folderMissing {
		// What a start that failed left is of the agent or the folder before.
		c.folderMissing = false
		c.errText = ""
		if tr, err := m.trOf(c, &out); err == nil {
			tr.SetStatus(model.StatusReady)
		}
	}
	err := m.save(c)
	out.emitChat(c)
	c.mu.Unlock()
	m.send(out)
	return err
}
