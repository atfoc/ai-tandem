package chats

import (
	"errors"
	"fmt"
	"log"
	"path/filepath"
	"slices"
	"time"

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

// SubWaitResult is one sid's status as WaitSubagents saw it.
type SubWaitResult struct {
	ID      string
	Status  model.SubStatus
	Summary string
	Last    string
	Error   string
}

// SpawnSubagent starts one independent agent process and returns a receipt without waiting for it
// to finish. Validation and lifecycle errors start nothing.
func (m *Manager) SpawnSubagent(chatID string, req SpawnSubRequest) (model.Subagent, error) {
	var out outbox
	c, err := m.lock(chatID)
	if err != nil {
		return model.Subagent{}, err
	}
	if _, err := m.trOf(c, &out); err != nil {
		c.mu.Unlock()
		m.send(out)
		return model.Subagent{}, err
	}
	if c.meta.Archived {
		c.mu.Unlock()
		return model.Subagent{}, ErrArchived
	}
	if c.meta.InstructionsSent {
		c.mu.Unlock()
		return model.Subagent{}, ErrLegacy
	}
	if req.Prompt == "" {
		c.mu.Unlock()
		return model.Subagent{}, errors.New("prompt is required")
	}
	kind, modelID, effort, err := m.resolveSubSpawn(c, req)
	if err != nil {
		c.mu.Unlock()
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
		done: make(chan struct{}),
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
	sa := s.meta
	opts := m.subSpawnOptions(c, sid, kind, modelID, effort)
	prompt := req.Prompt
	c.mu.Unlock()
	m.send(out) // receipt before the process starts, so the caller never waits on it

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
		failed := m.finishAppSub(chatID, sid, model.SubFailed, fmt.Sprintf("no spawner for agent %q", kind))
		return failed, fmt.Errorf("no spawner for agent %q", kind)
	}
	ag, err := sp.Spawn(opts)
	if err != nil {
		msg := err.Error()
		if errors.Is(err, ErrFolderMissing) {
			msg = folderMissingText(opts.Cwd)
		}
		failed := m.finishAppSub(chatID, sid, model.SubFailed, msg)
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

// WaitSubagents blocks until every named sub finishes or timeout elapses. Timeout 0 polls.
// Unknown sids still get a result; an unknown chat is an error. Does not hold Chat.mu while waiting.
func (m *Manager) WaitSubagents(chatID string, sids []string, timeout time.Duration) ([]SubWaitResult, error) {
	results, dones, err := m.subWaitSnapshot(chatID, sids)
	if err != nil {
		return nil, err
	}
	if timeout <= 0 {
		return results, nil
	}
	deadline := time.Now().Add(timeout)
	for _, d := range dones {
		if d == nil {
			continue
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		select {
		case <-d:
		case <-time.After(remaining):
		}
	}
	results, _, err = m.subWaitSnapshot(chatID, sids)
	return results, err
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
		return ErrNoSubagent
	}
	if s.meta.Status != model.SubRunning {
		c.mu.Unlock()
		return fmt.Errorf("subagent %s is %s", sid, s.meta.Status)
	}
	var toClose []agent.Agent
	if s.ag != nil {
		m.denySubPerms(c, s, &out)
		toClose = append(toClose, s.ag)
		s.ag = nil
	}
	s.meta.Status, s.meta.Ended = model.SubStopped, m.nowMs()
	m.endSub(c, s, &out)
	m.revokeExtra(c.meta.ID, sid)
	closeDone(s)
	closeStop(s)
	c.mu.Unlock()
	m.send(out)
	closeAgents(toClose)
	return nil
}

func (m *Manager) subWaitSnapshot(chatID string, sids []string) ([]SubWaitResult, []<-chan struct{}, error) {
	var out outbox
	c, err := m.lock(chatID)
	if err != nil {
		return nil, nil, err
	}
	if _, err := m.trOf(c, &out); err != nil {
		c.mu.Unlock()
		m.send(out)
		return nil, nil, err
	}
	results := make([]SubWaitResult, len(sids))
	dones := make([]<-chan struct{}, len(sids))
	for i, sid := range sids {
		s, ok := c.subs[sid]
		if !ok {
			results[i] = SubWaitResult{ID: sid, Error: ErrNoSubagent.Error()}
			continue
		}
		results[i] = SubWaitResult{
			ID:      s.meta.ID,
			Status:  s.meta.Status,
			Summary: s.meta.Summary,
			Last:    s.meta.Last,
			Error:   s.meta.Error,
		}
		if s.meta.Status == model.SubRunning && s.done != nil {
			dones[i] = s.done
		}
	}
	c.mu.Unlock()
	m.send(out)
	return results, dones, nil
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
			return "", "", "", err
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
			return "", "", "", err
		}
		if cm != nil && !slices.Contains(cm.Efforts, effort) {
			return "", "", "", fmt.Errorf("%s has no effort %q", modelID, effort)
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
				return "", "", "", err
			}
			if cm != nil && !slices.Contains(cm.Efforts, effort) {
				return "", "", "", fmt.Errorf("%s has no effort %q", modelID, effort)
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

func (m *Manager) finishAppSub(chatID, sid string, status model.SubStatus, errText string) model.Subagent {
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
	if s.meta.Status == model.SubRunning {
		if ag := m.finalizeAppSub(c, s, status, errText, &out); ag != nil {
			toClose = []agent.Agent{ag}
		}
	}
	meta := s.meta
	c.mu.Unlock()
	m.send(out)
	closeAgents(toClose)
	return meta
}

// finalizeAppSub marks s finished. c.mu held. The caller Closes the returned agent after unlock.
func (m *Manager) finalizeAppSub(c *Chat, s *sub, status model.SubStatus, errText string, out *outbox) agent.Agent {
	if s.meta.Status != model.SubRunning {
		return nil
	}
	s.meta.Status, s.meta.Ended = status, m.nowMs()
	if errText != "" {
		s.meta.Error = errText
	}
	m.endSub(c, s, out)
	m.revokeExtra(c.meta.ID, s.meta.ID)
	ag := s.ag
	s.ag = nil
	closeDone(s)
	return ag
}

func (m *Manager) runSub(c *Chat, sid, prompt string, ag agent.Agent, stop <-chan struct{}) {
	if err := ag.Send([]agent.ContentBlock{{Text: prompt}}); err != nil {
		m.finishAppSub(c.meta.ID, sid, model.SubFailed, err.Error())
		return
	}
	ch := ag.Events()
	for {
		select {
		case <-stop:
			return
		case ev, ok := <-ch:
			if !ok {
				m.finishAppSub(c.meta.ID, sid, model.SubStopped, "process ended")
				return
			}
			m.handleSubEv(c, sid, ev)
		}
	}
}

func (m *Manager) handleSubEv(c *Chat, sid string, ev agent.Event) {
	var out outbox
	var toClose []agent.Agent
	c.mu.Lock()
	defer func() {
		c.mu.Unlock()
		m.send(out)
		closeAgents(toClose)
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
		m.routeSub(c, ev, &out)
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
		st := model.SubCompleted
		if ev.Aborted {
			st = model.SubStopped
		}
		if ag := m.finalizeAppSub(c, s, st, ev.Error, &out); ag != nil {
			toClose = append(toClose, ag)
		}
		return
	case agent.EvExit:
		if s.meta.Status != model.SubRunning {
			return
		}
		st := model.SubStopped
		msg := ev.ExitErr
		if msg != "" {
			st = model.SubFailed
		} else {
			msg = "process ended"
		}
		if ag := m.finalizeAppSub(c, s, st, msg, &out); ag != nil {
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
