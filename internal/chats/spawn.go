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
	Model       string          // empty = the chat's model when Kind is the chat's and it still fits the list, else a new-chat default
	Effort      string          // empty = the chat's effort for a named model or the chat's own unless the list rules it out, else a default
	// From is the sid of the subagent that calls; "" = the chat's agent. The new subagent is its:
	// recorded with it as Parent, linked from the spawn call in its thread, and where Kind, Model
	// and Effort say "the chat's" above, it is the caller's own that is meant.
	From string
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

// folderMissingError is ErrFolderMissing with the text the subagent's row shows, so the calling
// agent reads the same as the row.
type folderMissingError struct{ text string }

func (e *folderMissingError) Error() string { return e.text }
func (e *folderMissingError) Unwrap() error { return ErrFolderMissing }

// SpawnSubagent starts one independent agent process and returns a receipt without waiting for it
// to finish. Validation and lifecycle errors start nothing, and neither do the chat's two
// subagent settings (sublimits.go): a caller at the chat's deepest level, or any caller of a chat
// whose subagents are off, is refused (*SubDepthError), and so is a spawn that would take the
// chat over its cap on running subagents (*SubCapError). chatID is the server id of the caller's
// own chat object (a branch's for a branch), here and in StopSubagent: they are never re-routed
// to the current branch.
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
	// Shutdown ends the subagents it finds on the chat, in a hold of this lock (see Manager.down).
	// One recorded before that is ended there: its process, if it starts later, is closed below.
	if m.down.Load() {
		unlock()
		return model.Subagent{}, ErrShutdown
	}
	// A run's agent calls this from inside its turn. Its token outlives the process (it is revoked
	// with the chat), so a call that comes once the run has stopped the agent (StopOwned), or the
	// turn has ended, would start a subagent nothing in the run stops any more.
	if c.role != "" && !turnRunning(c) {
		unlock()
		return model.Subagent{}, ErrTurnOver
	}
	// The caller: the chat's agent, or one of its subagents that still runs (its token is
	// revoked when it ends, so another is a call that raced with its end).
	var from *sub
	if req.From != "" {
		if from = c.subs[req.From]; from == nil || !from.app || from.meta.Status != model.SubRunning {
			unlock()
			return model.Subagent{}, errors.New("the calling subagent has ended")
		}
	}
	depth, limit := subLimits(c)
	level := subLevel(c, req.From) + 1 // the level the new subagent would be at
	if level > depth {
		unlock()
		return model.Subagent{}, &SubDepthError{Level: level - 1, Depth: depth}
	}
	if req.Prompt == "" {
		unlock()
		return model.Subagent{}, errors.New("prompt is required")
	}
	kind, modelID, effort, err := m.resolveSubSpawn(c, spawnBaseOf(c, from), req)
	if err != nil {
		unlock()
		return model.Subagent{}, err
	}
	// The chat's cap on running subagents, last of the refusals: counting and recording the new
	// one are one step under c.mu, so two spawns at once cannot both take the last place. A
	// refused spawn leaves no record and starts no process, and is not queued.
	if n := runningAppSubs(c); limit > 0 && n >= limit {
		unlock()
		return model.Subagent{}, &SubCapError{Cap: limit, Running: n}
	}

	sid := randHex(6)
	s := &sub{
		meta: model.Subagent{
			ID:          sid,
			Kind:        kind,
			Model:       modelID,
			Effort:      effort,
			Parent:      req.From,
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
	if !m.tryClaim(c, sid, canon, &out) {
		m.saveSub(c, s)
		out.emitSub(c, s.meta)
	}
	out.emitCounts(c)
	sa := s.meta
	opts := m.subSpawnOptions(c, sid, level >= depth, kind, modelID, effort)
	prompt := req.Prompt
	unlock() // the claim retry and Spawn run unlocked; the receipt is returned after both

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
		if errors.Is(err, ErrFolderMissing) {
			err = &folderMissingError{text: folderMissingText(opts.Cwd)}
		}
		failed := m.finishAppSub(chatID, sid, model.SubFailed, err.Error(), endSpawnFailed)
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

// ErrNotStarter is what stop_subagent answers a caller that names a subagent it did not start.
var ErrNotStarter = errors.New("that subagent was not started by you: stop_subagent stops only the subagents you started yourself")

// StopSubagent terminates one subagent the chat's agent started. Unknown or already-final sids
// are an error.
func (m *Manager) StopSubagent(chatID, sid string) error { return m.StopSubagentBy(chatID, "", sid) }

// StopSubagentBy is StopSubagent for the caller by: the sid of a subagent, "" for the chat's
// agent. A caller stops only what it started itself (ErrNotStarter for another's, the chat's
// agent included: it stops a subagent of a subagent by stopping the one it started). Every
// subagent below the stopped one is stopped with it.
func (m *Manager) StopSubagentBy(chatID, by, sid string) error {
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
	if s.meta.Parent != by {
		c.mu.Unlock()
		m.send(out)
		return ErrNotStarter
	}
	if s.meta.Status != model.SubRunning {
		c.mu.Unlock()
		m.send(out)
		return fmt.Errorf("subagent %s is %s", sid, s.meta.Status)
	}
	var aft after
	ag, leftApproval := m.stopSub(c, s, endStopTool, &out)
	aft.close = append(aft.close, ag)
	if m.stopBelow(c, s, &out, &aft) || leftApproval {
		aft.add(m.deliver(c, &out))
	}
	out.emitCounts(c)
	c.mu.Unlock()
	m.send(out)
	m.finish(c, &aft)
	return nil
}

// spawnBase is whose agent, model and effort a spawn takes where it names none: the chat's for
// a spawn of the chat's agent, the calling subagent's for a spawn of a subagent.
type spawnBase struct {
	kind          model.AgentKind
	model, effort string
}

// spawnBaseOf is the base of a spawn by from, nil for the chat's agent. c.mu held.
func spawnBaseOf(c *Chat, from *sub) spawnBase {
	if from != nil {
		return spawnBase{from.meta.Kind, from.meta.Model, from.meta.Effort}
	}
	return spawnBase{c.meta.Agent, c.meta.Model, c.meta.Effort}
}

// resolveSubSpawn picks kind/model/effort. Explicit values are validated like Configure against
// the requested kind's catalog. Inherited values are the caller's (base: the chat's, or those of
// the subagent that spawns). They fall back to new-chat defaults when they do not
// fit, and always when the requested kind is not the caller's and no model was named: a model
// is inherited only by a subagent of the caller's own kind, even if the other kind lists the same id;
// a named effort there is validated against the model the rebase yields. That holds while the
// other kind's catalog is unknown too: the defaults are then the model the user last picked for
// that kind, or none, so the agent uses its own. c.mu held.
func (m *Manager) resolveSubSpawn(c *Chat, base spawnBase, req SpawnSubRequest) (kind model.AgentKind, modelID, effort string, err error) {
	kind = req.Kind
	if kind == "" {
		kind = base.kind
	}
	if kind != model.Claude && kind != model.Cursor && kind != model.Pi {
		return "", "", "", fmt.Errorf("unknown agent %q", kind)
	}
	if m.Agents.Check(kind) != nil {
		return "", "", "", notUsableError(kind, m.Agents.List())
	}
	cat := m.catalog(kind)
	explicitModel := req.Model != ""
	explicitEffort := req.Effort != ""
	modelID, effort = base.model, base.effort
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
	// With no model named on a cross-kind spawn the caller's model is not used (below), so a named
	// effort is checked only against the rebased model.
	rebased := !explicitModel && cat != nil && kind != base.kind
	if explicitEffort && !rebased {
		cm, err := findModel(cat, modelID)
		if err != nil && explicitModel {
			return "", "", "", unknownModelError(kind, modelID)
		}
		if cm != nil && !slices.Contains(cm.Efforts, effort) {
			return "", "", "", noEffortError(kind, cm, effort)
		}
	}

	unfit := !explicitModel && kind != base.kind
	if cat != nil {
		cm, mErr := findModel(cat, modelID)
		if !explicitModel && mErr != nil {
			unfit = true
		}
		if !explicitEffort && cm != nil && effort != "" && !slices.Contains(cm.Efforts, effort) {
			unfit = true
		}
	}
	if unfit {
		var d model.Defaults
		if c.meta.Client == "" { // a chat with a client mark reads no defaults: the catalog's default
			m.Store.Read(func(s *model.State) { d = s.Defaults })
		}
		_, mc := defaults.Resolve(d, m.GroupOf(c.meta), model.LocalServer, kind, c.meta.Cwd, cat)
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

// notUsableError is the tool error for a subagent of a kind the server cannot use, the chat's own
// included: can lists the ones it can.
func notUsableError(kind model.AgentKind, can []model.AgentKind) error {
	names := make([]string, len(can))
	for i, a := range can {
		names[i] = string(a)
	}
	list := strings.Join(names, ", ")
	if list == "" {
		list = "none"
	}
	return fmt.Errorf("agent %q cannot be used on this server: its program was not found. Usable: %s", kind, list)
}

// subSpawnOptions are the options the process of c's subagent sid starts with; leaf says that
// it is at the chat's deepest level and so has no spawn family. c.mu held.
func (m *Manager) subSpawnOptions(c *Chat, sid string, leaf bool, kind model.AgentKind, modelID, effort string) agent.SpawnOptions {
	m.ensureToken(c)
	opts := agent.SpawnOptions{
		ChatID:   c.meta.ID + "/subagents/" + sid,
		Resume:   false,
		Cwd:      c.meta.Cwd,
		Model:    modelID,
		Effort:   m.effortFor(kind, modelID, effort),
		MCP:      &agent.BoardAccess{MCPURL: m.MCPURL, Token: m.issueExtraToken(c, sid, subLevel(c, sid), kind, modelID, effort)},
		BoardID:  c.meta.Board,
		Subagent: true,
		NoSpawn:  leaf,
	}
	if kind == model.Claude || kind == model.Pi {
		opts.SessionID = uuid()
	}
	opts.Dir = m.chatDir(opts.ChatID)
	runOptions(c, &opts, true)
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
	var aft after
	m.finalizeAppSub(c, s, status, errText, why, &out, &aft)
	meta := s.meta
	out.emitCounts(c)
	c.mu.Unlock()
	m.send(out)
	m.finish(c, &aft)
	return meta
}

// finalizeAppSub marks s finished; why decides whether whoever started it is owed its result.
// Every subagent below s is stopped with it (stopBelow): one that ends has nobody left to receive
// their results, and one that finishes has none running. The owed results are delivered at once
// when their reader can take them: the subagent that started s, when it waits (deliverSub); the
// chat's agent, because the result of s became owed to it or because s, or one below it, ended
// with the chat's last open permission request (deliver). A subagent that waited for s alone and
// is owed nothing for it has nothing left to wait for (waitOver). It does nothing to a subagent that is
// final. c.mu held. After unlock the caller does what aft holds (finish): the processes to close
// and the deliveries to hand off.
func (m *Manager) finalizeAppSub(c *Chat, s *sub, status model.SubStatus, errText string, why subEnding, out *outbox, aft *after) {
	if s.meta.Status != model.SubRunning {
		return
	}
	s.meta.Status, s.meta.Ended, s.meta.Waiting = status, m.nowMs(), false
	if errText != "" {
		s.meta.Error = errText
	}
	ended(s, why)
	leftApproval := m.endSub(c, s, out)
	m.revokeExtra(c.meta.ID, s.meta.ID)
	aft.close = append(aft.close, s.ag)
	s.ag = nil
	if m.stopBelow(c, s, out, aft) {
		leftApproval = true
	}
	owed := s.meta.Delivery == model.SubOwed
	if p := c.subs[s.meta.Parent]; p != nil {
		if owed {
			aft.add(m.deliverSub(c, p, out))
		} else {
			m.waitOver(c, p, out, aft)
		}
	}
	if leftApproval || (owed && s.meta.Parent == "") {
		aft.add(m.deliver(c, out))
	}
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

// handleSubEv applies one event of the process of c's app-spawned subagent sid. A subagent's
// process has as many turns as it takes: the one its prompt starts, and one for each message that
// carries it results of subagents it started (deliverSub). A turn that ends cleanly while
// subagents it started still run, or while a result is owed to it, leaves it waiting (subWaits);
// any other end of a turn, and a clean end with nothing below, finishes it.
func (m *Manager) handleSubEv(c *Chat, sid string, ev agent.Event) {
	var out outbox
	var aft after
	c.mu.Lock()
	defer func() {
		out.emitCounts(c)
		c.mu.Unlock()
		m.send(out)
		m.finish(c, &aft)
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
		aft.add(m.routeSub(c, ev, &out))
		return
	}
	before := s.meta
	if s.carry != nil && (modelOutput(ev) || ev.Kind == agent.EvThinking) {
		s.carry.quiet++ // its process is in a turn: not silent (subUnread)
	}
	if s.meta.Status == model.SubRunning && modelOutput(ev) {
		if s.carry != nil {
			s.carry.settled = true // the results it carries are delivered
		}
		s.meta.Waiting = false // a turn its process began by itself: it is working again
	}

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
		if c.role != "" {
			// Nobody answers for a run agent's subagent either (see denyAtOnce).
			ups = append(ups, denyAtOnce(c, sid, ev.PermID)...)
			if err := c.tr.Flush(false); err != nil {
				log.Printf("chats: flush %s: %v", c.meta.ID, err)
			}
		}
		out.emitItems(c, ups)
		if view(c) != beforeView {
			out.emitChat(c)
		}
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
		if costSubEnd(c, s, ev) {
			m.logSave(c) // the chat's cost is in chat.json; a subagent's record does not hold it
		}
		st, why, errText := model.SubCompleted, endTurn, ev.Error
		switch {
		case ev.Aborted:
			st, why = model.SubStopped, endAborted
		case ev.Error != "":
			why = endTurnError
			m.subErrorNote(c, s, ev.Error, &out)
		case s.carry != nil && !s.carry.settled && s.meta.Kind == model.Pi:
			// A turn that carried results and ended with no reply: on pi a failed turn can look
			// like it (see endCarry), and a subagent's results are not tried again.
			st, why, errText = model.SubFailed, endFailed, "its turn ended with no reply: the subagent results were not received"
			m.subErrorNote(c, s, "The subagent's turn ended with no reply: the subagent results were not received.", &out)
		case s.carry != nil && ev.SelfBegun:
			// The turn that ended is one its process began by itself, not the one of the results
			// it was handed: it is not finished before it has had that one (subUnread).
			m.subUnread(c, s, &out)
			return
		default:
			if m.subTurnOver(c, s, &out, &aft) {
				return
			}
		}
		m.finalizeAppSub(c, s, st, errText, why, &out, &aft)
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
		if !before.Waiting && costSubLost(c, s.meta.Kind) { // it ended in a turn without a turn end
			m.logSave(c)
		}
		m.finalizeAppSub(c, s, st, msg, why, &out, &aft)
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
		if len(c.pendingLinks) > 0 {
			m.reconcileSpawnLinks(c, &out) // a subagent this one spawned may wait for this item
		}
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
