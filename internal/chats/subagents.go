// Subagents of a chat: each in chats/<chat>/subagents/<sid>/, with its state in subagent.json and
// its own thread in items.jsonl. The manager routes events whose Sub is set here.
package chats

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
	"ai-whiteboard/internal/transcript"
)

// sub is one subagent of a chat: its state and, once needed, its thread.
type sub struct {
	meta  model.Subagent
	saved model.Subagent         // what subagent.json holds; meta != saved means a write is due
	tr    *transcript.Transcript // nil until its thread is needed (an event, or a client's fetch)
	ag    agent.Agent            // app-spawned process; nil for native
	stop  chan struct{}          // closed so the runner exits even if Events() stays open
	app   bool                   // started by SpawnSubagent (has its own process)
}

var ErrNoSubagent = errors.New("no such subagent")

func (m *Manager) subDir(chat, sid string) string {
	return filepath.Join(m.Store.P.ChatDir(chat), "subagents", sid)
}

// loadSubs reads every subagents/<sid>/subagent.json of a chat whose transcript was just loaded.
// A subagent still running belongs to a process that is gone (server restart, crash): it is marked
// stopped and written. Unreadable folders are logged and skipped. c.mu held.
func (m *Manager) loadSubs(c *Chat) {
	c.subs, c.subByTool = map[string]*sub{}, map[string]string{}
	dir := filepath.Join(m.Store.P.ChatDir(c.meta.ID), "subagents")
	ents, err := os.ReadDir(dir)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("chats: subagents of %s: %v", c.meta.ID, err)
		}
		return
	}
	for _, e := range ents {
		var sa model.Subagent
		raw, err := os.ReadFile(filepath.Join(dir, e.Name(), "subagent.json"))
		if err == nil {
			err = json.Unmarshal(raw, &sa)
		}
		if err != nil || sa.ID != e.Name() {
			log.Printf("chats: skipping subagent %s/%s: %v", c.meta.ID, e.Name(), err)
			continue
		}
		s := &sub{meta: sa, saved: sa}
		c.subs[sa.ID] = s
		if sa.Tool != "" {
			c.subByTool[sa.Tool] = sa.ID
		}
		if sa.Status == model.SubRunning {
			s.meta.Status, s.meta.Ended = model.SubStopped, m.nowMs()
			ended(s, endRestart)
			m.saveSub(c, s)
		}
	}
}

// subTr returns the subagent's thread, reading its items.jsonl the first time. c.mu held.
func (m *Manager) subTr(c *Chat, s *sub) (*transcript.Transcript, error) {
	if s.tr == nil {
		tr, err := transcript.Load(filepath.Join(m.subDir(c.meta.ID, s.meta.ID), "items.jsonl"))
		if err != nil {
			return nil, err
		}
		s.tr = tr
	}
	return s.tr, nil
}

// saveSub writes subagent.json when it changed since the last write; a failure is only logged.
// c.mu held.
func (m *Manager) saveSub(c *Chat, s *sub) {
	if err := m.writeSub(c, s); err != nil {
		log.Printf("chats: save subagent %s/%s: %v", c.meta.ID, s.meta.ID, err)
	}
}

// writeSub is saveSub for a caller that must know the record is on disk. c.mu held.
func (m *Manager) writeSub(c *Chat, s *sub) error {
	if s.meta == s.saved {
		return nil
	}
	dir := m.subDir(c.meta.ID, s.meta.ID)
	err := os.MkdirAll(dir, 0o700)
	if err == nil {
		err = store.WriteJSONAtomic(filepath.Join(dir, "subagent.json"), s.meta, 0o600)
	}
	if err != nil {
		return err
	}
	s.saved = s.meta
	return nil
}

// flushSub writes the subagent's thread and then its state. c.mu held.
func (m *Manager) flushSub(c *Chat, s *sub, all bool) {
	if s.tr != nil {
		if err := s.tr.Flush(all); err != nil {
			log.Printf("chats: flush subagent %s/%s: %v", c.meta.ID, s.meta.ID, err)
		}
	}
	m.saveSub(c, s)
}

// owner finds the thread holding tool call id: the chat's own, else a subagent's (a nested
// subagent). parent is that subagent's sid, "" for the chat's thread. c.mu held.
func (m *Manager) owner(c *Chat, id string) (tr *transcript.Transcript, parent string, ok bool) {
	if c.tr.HasTool(id) {
		return c.tr, "", true
	}
	for sid, s := range c.subs {
		if s.tr != nil && s.tr.HasTool(id) {
			return s.tr, sid, true
		}
	}
	return nil, "", false
}

// routeSub applies an event of a subagent (ev.Sub = the Agent/Task tool call that started it).
// The first event for a tool call creates the subagent: its folder, subagent.json and the link on
// the tool item. Events for a tool call no thread holds are dropped. c.mu held. After unlock the
// caller hands off the returned delivery: one starts when the subagent ended with the chat's last
// open permission request and results are owed (nil when none started).
func (m *Manager) routeSub(c *Chat, ev agent.Event, out *outbox) *carry {
	sid, ok := c.subByTool[ev.Sub]
	if !ok {
		otr, parent, found := m.owner(c, ev.Sub)
		if !found {
			return nil
		}
		sid = randHex(6)
		s := &sub{meta: model.Subagent{ID: sid, Tool: ev.Sub, Parent: parent, Status: model.SubRunning, Started: m.nowMs()},
			tr: transcript.New(filepath.Join(m.subDir(c.meta.ID, sid), "items.jsonl"))}
		c.subs[sid], c.subByTool[ev.Sub] = s, sid
		m.link(c, otr, parent, ev.Sub, sid, out)
	}
	s := c.subs[sid]
	before := s.meta
	switch {
	case ev.Kind == agent.EvSub:
		if ev.SubInfo != nil && patchSub(&s.meta, ev.SubInfo, m.nowMs()) {
			ended(s, endNative)
			if m.endSub(c, s, out) {
				return m.deliver(c, out)
			}
			return nil
		}
	case s.meta.Status != model.SubRunning:
		return nil // late lines of an ended subagent
	default:
		tr, err := m.subTr(c, s)
		if err != nil {
			log.Printf("chats: subagent %s/%s: %v", c.meta.ID, sid, err)
			return nil
		}
		ev.Sub = ""
		ups := tr.Apply(ev)
		out.emitSubItems(c, sid, tr.Version(), ups)
		if ev.Kind == agent.EvToolResult || ev.Kind == agent.EvToolDenied {
			m.flushSub(c, s, false)
		}
	}
	if !ok {
		m.saveSub(c, s) // a new subagent: its folder and subagent.json exist from its first event
	}
	if !ok || s.meta != before {
		out.emitSub(c, s.meta)
	}
	return nil
}

// link puts the new subagent's sid on its tool item, writes that item and sends it. c.mu held.
func (m *Manager) link(c *Chat, otr *transcript.Transcript, parent, tool, sid string, out *outbox) {
	ups := otr.LinkSubagent(tool, sid)
	if err := otr.Flush(false); err != nil {
		log.Printf("chats: flush %s: %v", c.meta.ID, err)
	}
	if parent == "" {
		out.emitItems(c, ups)
	} else {
		out.emitSubItems(c, parent, otr.Version(), ups)
	}
}

// endSub finishes a subagent that just reached a final status: its open text is closed, its last
// text kept for the row, its thread and state written and sent. The permission requests it still
// has open are closed as denied in the chat's thread, and only there: nothing is left to answer
// (a stop path has told a live process no before this, denySubPerms). It reports whether that took
// the chat out of approval; a caller that may start a turn then checks for owed results (deliver),
// after endSub has returned, so the turn carries this subagent's finished record. c.mu held.
func (m *Manager) endSub(c *Chat, s *sub, out *outbox) (leftApproval bool) {
	if c.tr != nil {
		before := view(c)
		leftApproval = m.permsClosed(c, before, c.tr.DenyPerms(s.meta.ID), out)
	}
	if tr, err := m.subTr(c, s); err == nil {
		ups := tr.CloseOpen()
		s.meta.Last = tr.LastText()
		out.emitSubItems(c, s.meta.ID, tr.Version(), ups)
	}
	m.flushSub(c, s, false)
	out.emitSub(c, s.meta)
	return leftApproval
}

// subErrorNote closes s's own thread with the error note a chat's thread gets when its turn ends
// with an error. Nothing else of a subagent's turn end is applied to its thread. The note is
// written with the thread when s is finished (endSub). c.mu held.
func (m *Manager) subErrorNote(c *Chat, s *sub, text string, out *outbox) {
	tr, err := m.subTr(c, s)
	if err != nil {
		log.Printf("chats: subagent %s/%s: %v", c.meta.ID, s.meta.ID, err)
		return
	}
	ups := append(tr.CloseOpen(), tr.AddNote("error", text)...)
	out.emitSubItems(c, s.meta.ID, tr.Version(), ups)
}

// stopSubs marks every subagent still running as stopped (nested ones included: they are all in
// c.subs). App-spawned processes are detached and returned so the caller can Close them after
// unlock. Stopping them is never a reason to start a turn. c.mu held.
func (m *Manager) stopSubs(c *Chat, out *outbox) []agent.Agent {
	return m.stopRunningSubs(c, out, false)
}

// stopAppSubs is Shutdown/Interrupt: only app-spawned running subs, so native rows stay as they are.
// c.mu held.
func (m *Manager) stopAppSubs(c *Chat, out *outbox) []agent.Agent {
	return m.stopRunningSubs(c, out, true)
}

func (m *Manager) stopRunningSubs(c *Chat, out *outbox, appOnly bool) []agent.Agent {
	var ags []agent.Agent
	for _, s := range c.subs {
		if s.meta.Status != model.SubRunning {
			continue
		}
		if appOnly && !s.app {
			continue
		}
		if s.ag != nil {
			m.denySubPerms(c, s)
			ags = append(ags, s.ag)
			s.ag = nil
		}
		s.meta.Status, s.meta.Ended = model.SubStopped, m.nowMs()
		ended(s, endParent)
		m.endSub(c, s, out)
		if s.app {
			m.revokeExtra(c.meta.ID, s.meta.ID)
		}
		closeStop(s)
	}
	return ags
}

// denySubPerms tells s's process no for every permission request of s still open in the chat's
// thread. Their cards are closed when s is finished (endSub). c.mu held.
func (m *Manager) denySubPerms(c *Chat, s *sub) {
	if c.tr == nil || s.ag == nil {
		return
	}
	_, items := c.tr.Snapshot()
	for _, it := range items {
		if it.Kind == "perm" && it.Decided == "" && it.Subagent == s.meta.ID {
			_ = s.ag.Decide(it.RequestID, false)
		}
	}
}

func closeStop(s *sub) {
	if s.stop == nil {
		return
	}
	close(s.stop)
	s.stop = nil
}

func closeAgents(ags []agent.Agent) {
	for _, ag := range ags {
		if ag != nil {
			go ag.Close()
		}
	}
}

// patchSub applies p to sa and reports whether sa just reached a final status. A Status is taken
// only while sa is running, so the first final status wins (a later "completed" never overwrites
// "stopped"); the other fields are still applied (a final usage read, a summary).
func patchSub(sa *model.Subagent, p *agent.SubInfo, now int64) bool {
	set := func(dst *string, v string) {
		if v != "" {
			*dst = v
		}
	}
	set(&sa.AgentID, p.ID)
	set(&sa.Type, p.Type)
	set(&sa.Description, p.Description)
	set(&sa.Prompt, p.Prompt)
	set(&sa.Model, p.Model)
	set(&sa.Error, p.Error)
	set(&sa.Summary, p.Summary)
	set(&sa.Progress, p.Progress)
	if p.Background != nil {
		sa.Background = *p.Background
	}
	if p.Tokens > 0 {
		sa.Tokens = p.Tokens
	}
	if p.Window > 0 {
		sa.Window = p.Window
	}
	if p.ToolUses > 0 {
		sa.ToolUses = p.ToolUses
	}
	if p.Status != "" && p.Status != model.SubRunning && sa.Status == model.SubRunning {
		sa.Status, sa.Ended = p.Status, now
		return true
	}
	return false
}

// SubItems returns a subagent's thread and its version, reading its items.jsonl the first time.
func (m *Manager) SubItems(chat, sid string) (int, []model.Item, error) {
	var out outbox
	c, err := m.lock(chat)
	if err != nil {
		return 0, nil, err
	}
	defer func() { c.mu.Unlock(); m.send(out) }()
	if _, err := m.trOf(c, &out); err != nil {
		return 0, nil, err
	}
	s, ok := c.subs[sid]
	if !ok {
		return 0, nil, ErrNoSubagent
	}
	tr, err := m.subTr(c, s)
	if err != nil {
		return 0, nil, err
	}
	v, items := tr.Snapshot()
	return v, items, nil
}

// emitSub queues a subagent's state. c.mu held.
func (o *outbox) emitSub(c *Chat, sa model.Subagent) {
	*o = append(*o, map[string]any{"type": "sub", "chat": c.meta.ID, "subagent": sa})
}

// emitSubItems queues the changed items of a subagent's thread, if any. c.mu held.
func (o *outbox) emitSubItems(c *Chat, sid string, version int, ups []transcript.Update) {
	if len(ups) > 0 {
		*o = append(*o, map[string]any{"type": "sub_items", "chat": c.meta.ID, "sub": sid, "version": version, "updates": ups})
	}
}
