package chats

import (
	"errors"
	"fmt"
	"log"
	"path/filepath"
	"slices"
	"strings"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/transcript"
)

// SpawnSubRequest is one app-spawned subagent. Every spawn is async; there is no Background flag.
type SpawnSubRequest struct {
	Prompt      string
	Description string
	Kind        model.AgentKind // empty = the chat's kind
	Model       string          // empty = the chat's current model
	Effort      string          // empty = the chat's current effort
}

// SpawnValueError is a model or effort that spawn_subagent rejected against a known model list.
type SpawnValueError struct {
	Kind   model.AgentKind // the agent whose list was checked
	Model  string          // the model that was checked: the one named, the chat's own, or the default the spawn resolved
	Effort string          // the rejected effort; empty when the model itself is unknown
	text   string
}

func (e *SpawnValueError) Error() string { return e.text }

// unknownModelError is the error for a model that is not in kind's list.
func unknownModelError(kind model.AgentKind, id string) *SpawnValueError {
	return &SpawnValueError{Kind: kind, Model: id,
		text: fmt.Sprintf("unknown model %q: not in the %s model list", id, kind)}
}

// noEffortError is the error for an effort that cm, a model in kind's list, does not offer. It
// names the efforts cm does take.
func noEffortError(kind model.AgentKind, cm *model.CatalogModel, effort string) *SpawnValueError {
	takes := "no effort, so omit effort"
	if len(cm.Efforts) > 0 {
		takes = strings.Join(cm.Efforts, ", ")
		if slices.Contains(cm.Efforts, cm.DefaultEffort) {
			takes += fmt.Sprintf(" (default %s)", cm.DefaultEffort)
		}
	}
	return &SpawnValueError{Kind: kind, Model: cm.ID, Effort: effort,
		text: fmt.Sprintf("%s has no effort %q: checked against the %s model list; %s takes %s", cm.ID, effort, kind, cm.ID, takes)}
}

// SpawnSubagent starts one independent agent process and returns a receipt without waiting for it
// to finish. Validation and lifecycle errors start nothing. chatID is the server id of the
// caller's own chat object (a branch's for a branch), here and in WaitSubagents and StopSubagent:
// they are never re-routed to the current branch.
func (m *Manager) SpawnSubagent(chatID string, req SpawnSubRequest) (model.Subagent, error) {
	var out outbox
	c, err := m.lock(chatID)
	if err != nil {
		return model.Subagent{}, err
	}
	unlock := func() { c.mu.Unlock(); m.send(out) }
	if _, err := m.trOf(c, &out); err != nil {
		unlock()
		return model.Subagent{}, err
	}
	if p := m.parentOf(c); p.Archived {
		unlock()
		return model.Subagent{}, ErrArchived
	} else if p.InstructionsSent {
		unlock()
		return model.Subagent{}, ErrLegacy
	}
	if req.Prompt == "" {
		unlock()
		return model.Subagent{}, errors.New("prompt is required")
	}
	kind, modelID, effort, err := m.resolveSubSpawn(c, req)
	if err != nil {
		unlock()
		return model.Subagent{}, err
	}

	sid := randHex(6)
	s := &sub{
		meta: model.Subagent{
			ID:          sid,
			Kind:        kind,
			Model:       modelID,
			Effort:      effort,
			Description: req.Description,
			Prompt:      req.Prompt,
			Background:  true,
			Status:      model.SubRunning,
			Started:     m.nowMs(),
		},
		tr:   transcript.New(filepath.Join(m.subDir(c.meta.ID, sid), "items.jsonl")),
		stop: make(chan struct{}),
		app:  true,
	}
	c.subs[sid] = s
	canon := canonicalSpawnArgs(req)
	if toolID := findOldestSpawnClaim(c, canon); toolID != "" {
		s.meta.Tool = toolID
		if c.subByTool == nil {
			c.subByTool = map[string]string{}
		}
		c.subByTool[toolID] = sid
		m.link(c, c.tr, "", toolID, sid, &out)
	}
	m.saveSub(c, s)
	out.emitSub(c, s.meta)
	out.emitCounts(c)
	sa := s.meta
	opts := m.subSpawnOptions(c, sid, kind, modelID, effort)
	prompt := req.Prompt
	unlock() // receipt before the process starts, so the caller never waits on it

	if sa.Tool == "" {
		tool, gone := m.retrySpawnClaim(chatID, sid, canon)
		if gone {
			log.Printf("chats: spawn %s/%s: chat deleted; cancelling unlinked subagent", chatID, sid)
			return sa, nil
		}
		sa.Tool = tool
	}

	sp := m.Spawners[kind]
	if sp == nil {
		failed := m.finishAppSub(chatID, sid, model.SubFailed, fmt.Sprintf("no spawner for agent %q", kind), endSpawnFailed)
		return failed, fmt.Errorf("no spawner for agent %q", kind)
	}
	ag, err := sp.Spawn(opts)
	if err != nil {
		msg := err.Error()
		if errors.Is(err, ErrFolderMissing) {
			msg = folderMissingText(opts.Cwd)
		}
		failed := m.finishAppSub(chatID, sid, model.SubFailed, msg, endSpawnFailed)
		return failed, err
	}

	c, err = m.lock(chatID)
	if err != nil {
		go ag.Close()
		return sa, err
	}
	s = c.subs[sid]
	if s == nil || s.meta.Status != model.SubRunning {
		cur := sa
		if s != nil {
			cur = s.meta
		}
		c.mu.Unlock()
		go ag.Close()
		return cur, nil
	}
	s.ag = ag
	stop := s.stop
	c.mu.Unlock()
	go m.runSub(c, sid, prompt, ag, stop)
	return sa, nil
}

// StopSubagent terminates one app-spawned process. Unknown or already-final sids are an error.
func (m *Manager) StopSubagent(chatID, sid string) error {
	var out outbox
	c, err := m.lock(chatID)
	if err != nil {
		return err
	}
	if _, err := m.trOf(c, &out); err != nil {
		c.mu.Unlock()
		m.send(out)
		return err
	}
	s, ok := c.subs[sid]
	if !ok {
		c.mu.Unlock()
		m.send(out)
		return ErrNoSubagent
	}
	if s.meta.Status != model.SubRunning {
		c.mu.Unlock()
		m.send(out)
		return fmt.Errorf("subagent %s is %s", sid, s.meta.Status)
	}
	var toClose []agent.Agent
	if s.ag != nil {
		m.denySubPerms(c, s)
		toClose = append(toClose, s.ag)
		s.ag = nil
	}
	s.meta.Status, s.meta.Ended = model.SubStopped, m.nowMs()
	ended(s, endStopTool)
	leftApproval := m.endSub(c, s, &out)
	m.revokeExtra(c.meta.ID, sid)
	closeStop(s)
	var d *carry
	if leftApproval {
		d = m.deliver(c, &out)
	}
	out.emitCounts(c)
	c.mu.Unlock()
	m.send(out)
	closeAgents(toClose)
	m.handOff(c, d)
	return nil
}

// resolveSubSpawn picks kind/model/effort. Explicit values are validated like Configure against
// the requested kind's catalog. Inherited values fall back to new-chat defaults when they do not
// fit, and always when the requested kind is not the chat's and no model was named: a model
// is inherited only by a subagent of the chat's own kind, even if the other kind lists the same id;
// a named effort there is validated against the model the rebase yields. c.mu held.
func (m *Manager) resolveSubSpawn(c *Chat, req SpawnSubRequest) (kind model.AgentKind, modelID, effort string, err error) {
	kind = req.Kind
	if kind == "" {
		kind = c.meta.Agent
	}
	if kind != model.Claude && kind != model.Cursor && kind != model.Pi {
		return "", "", "", fmt.Errorf("unknown agent %q", kind)
	}
	cat := m.catalog(kind)
	explicitModel := req.Model != ""
	explicitEffort := req.Effort != ""
	modelID, effort = c.meta.Model, c.meta.Effort
	if explicitModel {
		modelID = req.Model
	}
	if explicitEffort {
		effort = req.Effort
	}

	if explicitModel {
		cm, err := findModel(cat, modelID)
		if err != nil {
			return "", "", "", unknownModelError(kind, modelID)
		}
		if !explicitEffort && cm != nil && !slices.Contains(cm.Efforts, effort) {
			effort = ""
			if len(cm.Efforts) > 0 {
				effort = cm.DefaultEffort
			}
		}
	}
	// With no model named on a cross-kind spawn the chat's model is not used (below), so a named
	// effort is checked only against the rebased model.
	rebased := !explicitModel && cat != nil && kind != c.meta.Agent
	if explicitEffort && !rebased {
		cm, err := findModel(cat, modelID)
		if err != nil && explicitModel {
			return "", "", "", unknownModelError(kind, modelID)
		}
		if cm != nil && !slices.Contains(cm.Efforts, effort) {
			return "", "", "", noEffortError(kind, cm, effort)
		}
	}

	unfit := false
	if cat != nil {
		cm, mErr := findModel(cat, modelID)
		if !explicitModel && (mErr != nil || kind != c.meta.Agent) {
			unfit = true
		}
		if !explicitEffort && cm != nil && effort != "" && !slices.Contains(cm.Efforts, effort) {
			unfit = true
		}
	}
	if unfit {
		var d model.Defaults
		m.Store.Read(func(s *model.State) { d = s.Defaults })
		_, mc := defaults.Resolve(d, m.GroupOf(c.meta), kind, c.meta.Cwd, cat)
		if !explicitModel {
			modelID = mc.Model
		}
		if !explicitEffort {
			effort = mc.Effort
		}
		if explicitEffort {
			cm, err := findModel(cat, modelID)
			if err != nil {
				return "", "", "", unknownModelError(kind, modelID)
			}
			if cm != nil && !slices.Contains(cm.Efforts, effort) {
				return "", "", "", noEffortError(kind, cm, effort)
			}
		}
	}
	return kind, modelID, effort, nil
}

func (m *Manager) subSpawnOptions(c *Chat, sid string, kind model.AgentKind, modelID, effort string) agent.SpawnOptions {
	m.ensureToken(c)
	opts := agent.SpawnOptions{
		ChatID:   c.meta.ID + "/subagents/" + sid,
		Resume:   false,
		Cwd:      c.meta.Cwd,
		Model:    modelID,
		Effort:   m.effortFor(kind, modelID, effort),
		MCP:      &agent.BoardAccess{MCPURL: m.MCPURL, Token: m.issueExtraToken(c, sid, kind, modelID, effort)},
		BoardID:  c.meta.Board,
		Subagent: true,
	}
	if kind == model.Claude || kind == model.Pi {
		opts.SessionID = uuid()
	}
	return opts
}

func (m *Manager) finishAppSub(chatID, sid string, status model.SubStatus, errText string, why subEnding) model.Subagent {
	var out outbox
	c, err := m.lock(chatID)
	if err != nil {
		return model.Subagent{}
	}
	s := c.subs[sid]
	if s == nil {
		c.mu.Unlock()
		return model.Subagent{}
	}
	var toClose []agent.Agent
	var d *carry
	if s.meta.Status == model.SubRunning {
		var ag agent.Agent
		if ag, d = m.finalizeAppSub(c, s, status, errText, why, &out); ag != nil {
			toClose = []agent.Agent{ag}
		}
	}
	meta := s.meta
	out.emitCounts(c)
	c.mu.Unlock()
	m.send(out)
	closeAgents(toClose)
	m.handOff(c, d)
	return meta
}

// finalizeAppSub marks s finished; why decides whether the parent is owed its result. The owed
// results are delivered at once when the parent can take them: because this one became owed, or
// because s ended with the chat's last open permission request. c.mu held. After unlock the caller
// Closes the returned agent and hands off the returned delivery (nil when none started).
func (m *Manager) finalizeAppSub(c *Chat, s *sub, status model.SubStatus, errText string, why subEnding, out *outbox) (agent.Agent, *carry) {
	if s.meta.Status != model.SubRunning {
		return nil, nil
	}
	s.meta.Status, s.meta.Ended = status, m.nowMs()
	if errText != "" {
		s.meta.Error = errText
	}
	ended(s, why)
	leftApproval := m.endSub(c, s, out)
	m.revokeExtra(c.meta.ID, s.meta.ID)
	ag := s.ag
	s.ag = nil
	var d *carry
	if leftApproval || s.meta.Delivery == model.SubOwed {
		d = m.deliver(c, out)
	}
	return ag, d
}

func (m *Manager) runSub(c *Chat, sid, prompt string, ag agent.Agent, stop <-chan struct{}) {
	if err := ag.Send([]agent.ContentBlock{{Text: prompt}}); err != nil {
		m.finishAppSub(c.meta.ID, sid, model.SubFailed, err.Error(), endFailed)
		return
	}
	ch := ag.Events()
	for {
		select {
		case <-stop:
			return
		case ev, ok := <-ch:
			if !ok {
				m.finishAppSub(c.meta.ID, sid, model.SubStopped, "process ended", endGone)
				return
			}
			m.handleSubEv(c, sid, ev)
		}
	}
}

func (m *Manager) handleSubEv(c *Chat, sid string, ev agent.Event) {
	var out outbox
	var toClose []agent.Agent
	var d *carry
	c.mu.Lock()
	defer func() {
		out.emitCounts(c)
		c.mu.Unlock()
		m.send(out)
		closeAgents(toClose)
		m.handOff(c, d)
	}()
	if c.deleted || c.tr == nil {
		return
	}
	s := c.subs[sid]
	if s == nil {
		return
	}
	// Nested native Task/Agent rows emit EvSub (and other events) with Sub = that tool id.
	// They must not patch or complete this app-spawned process; route them like pump does.
	// EvPermRequest still lands on the parent transcript with the app-spawned sid.
	if ev.Sub != "" && ev.Kind != agent.EvPermRequest {
		d = m.routeSub(c, ev, &out)
		return
	}
	before := s.meta

	switch ev.Kind {
	case agent.EvSub:
		return // adapters never emit EvSub for the app-spawned process itself
	case agent.EvPermRequest:
		if s.meta.Status != model.SubRunning {
			return
		}
		ev.Sub = sid
		beforeView := view(c)
		ups := c.tr.Apply(ev)
		out.emitItems(c, ups)
		if view(c) != beforeView {
			out.emitChat(c)
		}
		return
	case agent.EvSession:
		if s.meta.Status != model.SubRunning {
			return
		}
		if ev.SessionID != "" {
			s.meta.AgentID = ev.SessionID
		}
	case agent.EvUsage:
		if s.meta.Status != model.SubRunning {
			return
		}
		if ev.CtxIn != 0 {
			s.meta.Tokens = ev.CtxIn
		}
		if ev.CtxWindow != 0 {
			s.meta.Window = ev.CtxWindow
		}
	case agent.EvCatalog:
		return
	case agent.EvTurnEnd:
		if s.meta.Status != model.SubRunning {
			return
		}
		st, why := model.SubCompleted, endTurn
		if ev.Aborted {
			st, why = model.SubStopped, endAborted
		} else if ev.Error != "" {
			why = endTurnError
			m.subErrorNote(c, s, ev.Error, &out)
		}
		var ag agent.Agent
		if ag, d = m.finalizeAppSub(c, s, st, ev.Error, why, &out); ag != nil {
			toClose = append(toClose, ag)
		}
		return
	case agent.EvExit:
		if s.meta.Status != model.SubRunning {
			return
		}
		st, why := model.SubStopped, endGone
		msg := ev.ExitErr
		if msg != "" {
			st, why = model.SubFailed, endFailed
		} else {
			msg = "process ended"
		}
		var ag agent.Agent
		if ag, d = m.finalizeAppSub(c, s, st, msg, why, &out); ag != nil {
			toClose = append(toClose, ag)
		}
		return
	default:
		if s.meta.Status != model.SubRunning {
			return
		}
		tr, err := m.subTr(c, s)
		if err != nil {
			log.Printf("chats: subagent %s/%s: %v", c.meta.ID, sid, err)
			return
		}
		ev.Sub = ""
		ups := tr.Apply(ev)
		out.emitSubItems(c, sid, tr.Version(), ups)
		if ev.Kind == agent.EvToolResult || ev.Kind == agent.EvToolDenied {
			m.flushSub(c, s, false)
		}
	}
	if s.meta != before {
		m.saveSub(c, s)
		out.emitSub(c, s.meta)
	}
}
