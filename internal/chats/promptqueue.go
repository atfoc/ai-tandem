package chats

import (
	"errors"
	"log"
	"maps"
	"slices"
	"strings"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/prompts"
)

const (
	QueueDelivery = "queue"
	SteerDelivery = "steer"
	promptWaiting = "waiting"
	promptNext    = "next"
)

var (
	ErrSteerUnsupported = errors.New("this agent does not support steering")
	ErrPromptInFlight   = errors.New("the agent is already receiving this prompt")
	ErrPromptQueueFull  = errors.New("the branch already has 20 pending prompts")
	ErrNoQueuedPrompt   = errors.New("no such queued prompt")
	ErrEmptyPrompt      = errors.New("the message is empty")
)

func pendingPrompts(c *Chat) []model.PendingPrompt {
	if c.meta.PendingPrompts == nil {
		return nil
	}
	return *c.meta.PendingPrompts
}

// Views share the queue snapshot. Every change replaces it so old events remain valid.
func setPendingPrompts(c *Chat, entries []model.PendingPrompt) {
	c.meta.PendingPrompts = nil
	if len(entries) > 0 {
		c.meta.PendingPrompts = &entries
	} else {
		c.meta.QueuePaused = false
	}
	publishPromptImages(c)
}

func publishPromptImages(c *Chat) {
	var images []model.Image
	for _, entry := range pendingPrompts(c) {
		images = append(images, entry.Images...)
	}
	index := &topOf(c).promptImages
	_, branch := splitID(c.meta.ID)
	for {
		old := index.Load()
		if len(images) == 0 && (old == nil || len((*old)[branch]) == 0) {
			return
		}
		next := make(map[string][]model.Image)
		if old != nil {
			maps.Copy(next, *old)
		}
		if len(images) > 0 {
			next[branch] = images
		} else {
			delete(next, branch)
		}
		if index.CompareAndSwap(old, &next) {
			return
		}
	}
}

func canSteer(c *Chat) bool {
	_, ok := c.ag.(agent.Steerer)
	return ok
}

func (m *Manager) SubmitPrompt(id, branch, delivery string, msg Message) (string, error) {
	c, branch, err := m.lockBranch(id, branch)
	if err != nil {
		return "", err
	}
	var out outbox
	defer func() { c.mu.Unlock(); m.send(out); m.wakePrompts(c) }()
	p := m.parentOf(c)
	switch {
	case m.down.Load():
		return "", ErrShutdown
	case p.Archived:
		return "", ErrArchived
	case p.InstructionsSent:
		return "", ErrLegacy
	case !c.meta.Locked || c.meta.Fresh:
		return "", ErrNotStarted
	case delivery == SteerDelivery && busy(c) && !canSteer(c):
		return "", ErrSteerUnsupported
	case strings.TrimSpace(msg.Text) == "" && len(msg.References) == 0 && len(msg.Images) == 0:
		return "", ErrEmptyPrompt
	}
	if _, err := m.trOf(c, &out); err != nil {
		return "", err
	}
	if !validReferences(c.tr, msg.References) {
		return "", ErrBadReference
	}
	entries := pendingPrompts(c)
	if len(entries) >= 20 {
		return "", ErrPromptQueueFull
	}
	imgs, err := m.takePromptImages(c, msg.Images)
	if err != nil {
		return "", err
	}
	if imgs != nil {
		defer m.releaseImages(imgs)
		if err := m.noImagesFor(c.meta.Agent, c.meta.Model); err != nil {
			return "", err
		}
	}
	entry := model.PendingPrompt{ID: uuid(), Text: msg.Text, Context: msg.Context,
		References: msg.References, Images: imgs.images(), Delivery: delivery}
	old, paused := c.meta.PendingPrompts, c.meta.QueuePaused
	position := len(entries)
	if delivery == SteerDelivery {
		if firstQueue := slices.IndexFunc(entries, func(p model.PendingPrompt) bool { return p.Delivery == QueueDelivery }); firstQueue >= 0 {
			position = firstQueue
		}
	}
	setPendingPrompts(c, slices.Insert(slices.Clone(entries), position, entry))
	if err := m.save(c); err != nil {
		c.meta.PendingPrompts, c.meta.QueuePaused = old, paused
		publishPromptImages(c)
		return "", err
	}
	m.dropDraft(c, m.draftRevOf(c))
	m.logSave(c)
	out.emitChat(c)
	return branch, nil
}

func (m *Manager) takePromptImages(c *Chat, named []model.Image) (*takenImages, error) {
	if len(named) == 0 {
		return nil, nil
	}
	id, _ := splitID(c.meta.ID)
	return m.takeImages(topOf(c), id, named)
}

func (m *Manager) RemovePrompt(id, branch, prompt string) error {
	c, _, err := m.lockBranch(id, branch)
	if err != nil {
		return err
	}
	var out outbox
	defer func() { c.mu.Unlock(); m.send(out); m.wakePrompts(c) }()
	entries := pendingPrompts(c)
	for i, entry := range entries {
		if entry.ID != prompt {
			continue
		}
		if entry.State == promptWaiting && !c.meta.QueuePaused {
			return ErrPromptInFlight
		}
		old, paused := c.meta.PendingPrompts, c.meta.QueuePaused
		setPendingPrompts(c, slices.Delete(slices.Clone(entries), i, i+1))
		if err := m.save(c); err != nil {
			c.meta.PendingPrompts, c.meta.QueuePaused = old, paused
			publishPromptImages(c)
			return err
		}
		out.emitChat(c)
		return nil
	}
	return ErrNoQueuedPrompt
}

func (m *Manager) ResumePrompts(id, branch string) error {
	c, _, err := m.lockBranch(id, branch)
	if err != nil {
		return err
	}
	var out outbox
	defer func() { c.mu.Unlock(); m.send(out); m.wakePrompts(c) }()
	if m.down.Load() {
		return ErrShutdown
	}
	if p := m.parentOf(c); p.Archived || p.InstructionsSent {
		if p.Archived {
			return ErrArchived
		}
		return ErrLegacy
	}
	if _, err := m.trOf(c, &out); err != nil {
		return err
	}
	entries := slices.Clone(pendingPrompts(c))
	if len(entries) == 0 || !c.meta.QueuePaused {
		return nil
	}
	// An unconfirmed steer from a stopped process can now go as a follow-up.
	for i := range entries {
		if entries[i].State == promptWaiting {
			if c.ag != nil {
				return ErrPromptInFlight
			}
			entries[i].State = promptNext
		}
	}
	old, paused := c.meta.PendingPrompts, c.meta.QueuePaused
	setPendingPrompts(c, entries)
	c.meta.QueuePaused = false
	if err := m.save(c); err != nil {
		c.meta.PendingPrompts, c.meta.QueuePaused = old, paused
		publishPromptImages(c)
		return err
	}
	out.emitChat(c)
	return nil
}

func pausePrompts(c *Chat) bool {
	if len(pendingPrompts(c)) == 0 || c.meta.QueuePaused {
		return false
	}
	c.meta.QueuePaused = true
	return true
}

func promptOwnsTurn(c *Chat) bool {
	if c.meta.QueuePaused {
		return false
	}
	if next, _ := nextPrompt(c); next >= 0 {
		return true
	}
	for _, entry := range pendingPrompts(c) {
		if entry.State == promptWaiting {
			return true
		}
	}
	return false
}

// A steer outranks queued follow-ups. One provider handoff at a time keeps
// its acknowledgement unambiguous and leaves the remaining entries editable.
func nextPrompt(c *Chat) (int, bool) {
	entries := pendingPrompts(c)
	if c.meta.QueuePaused || len(entries) == 0 {
		return -1, false
	}
	for _, entry := range entries {
		if entry.State == promptWaiting {
			return -1, false
		}
	}
	for i, entry := range entries {
		if entry.Delivery == SteerDelivery {
			if !busy(c) && !retrying(c) {
				return i, false
			}
			if entry.State != promptNext && inTurn(c) && c.meta.TurnActive && canSteer(c) && c.retry == nil {
				return i, true
			}
			return -1, false
		}
	}
	if busy(c) || retrying(c) {
		return -1, false
	}
	return 0, false
}

func (m *Manager) wakePrompts(c *Chat) {
	c.mu.Lock()
	m.kickPrompts(c)
	c.mu.Unlock()
}

// kickPrompts is called with c.mu held. Agent I/O runs outside that lock and
// outside the event pump, which must remain available to read its acknowledgements.
func (m *Manager) kickPrompts(c *Chat) {
	if m.down.Load() || c.deleted || c.unlisted || c.promptWorker {
		return
	}
	if p := m.parentOf(c); p.Archived || p.InstructionsSent {
		return
	}
	if i, _ := nextPrompt(c); i < 0 {
		return
	}
	c.promptWorker = true
	id, branch := splitID(c.meta.ID)
	go m.runPrompt(c, id, branch)
}

func (m *Manager) runPrompt(c *Chat, id, branch string) {
	err := m.prepareOf(func() (*Chat, error) { return m.branchChat(id, branch) }, noProcess)
	c.mu.Lock()
	defer func() {
		c.promptWorker = false
		m.kickPrompts(c)
		c.mu.Unlock()
	}()
	if m.down.Load() || c.deleted {
		return
	}
	if err != nil {
		m.pausePromptDelivery(c)
		return
	}
	if p := m.parentOf(c); p.Archived || p.InstructionsSent {
		return
	}
	i, steering := nextPrompt(c)
	if i < 0 {
		return
	}
	entry := pendingPrompts(c)[i]
	imgs, err := m.takePromptImages(c, entry.Images)
	if err != nil {
		m.pausePromptDelivery(c)
		return
	}
	defer m.releaseImages(imgs)
	if !steering {
		// sendOnPrompt releases c.mu and records the queue removal with the turn.
		_, err := m.sendOnPrompt(c, entry.Text, entry.Context, entry.References, imgs, entry.ID)
		c.mu.Lock()
		if err != nil {
			m.pausePromptDelivery(c)
		}
		return
	}
	pictures, err := m.imageBlocks(imgs)
	if err != nil {
		m.pausePromptDelivery(c)
		return
	}
	var blocks []agent.ContentBlock
	if context := m.promptContext(c, entry.Context); context != "" {
		blocks = append(blocks, agent.ContentBlock{Text: context})
	}
	blocks = append(blocks, pictures...)
	blocks = append(blocks, agent.ContentBlock{Text: withReferences(entry.References, entry.Text)})
	steerer := c.ag.(agent.Steerer)
	gen := c.gen
	c.steerTurnEnded = false
	m.changePrompt(c, entry.ID, promptWaiting, false)
	var out outbox
	out.emitChat(c)
	c.mu.Unlock()
	m.send(out)
	err = steerer.Steer(entry.ID, blocks)
	c.mu.Lock()
	if c.gen != gen || c.deleted || m.down.Load() {
		return
	}
	if err != nil || c.steerTurnEnded {
		// A definite rejection can be sent after the current turn. Ambiguous
		// transport failures are paused to avoid sending the same prompt twice.
		if errors.Is(err, agent.ErrSteerUnavailable) && m.changePrompt(c, entry.ID, promptNext, false) {
			var changed outbox
			changed.emitChat(c)
			c.mu.Unlock()
			m.send(changed)
			c.mu.Lock()
		} else if !errors.Is(err, agent.ErrSteerUnavailable) && steerPending(c, entry.ID) {
			m.pausePromptDelivery(c)
		}
	}
}

func steerPending(c *Chat, id string) bool {
	return slices.ContainsFunc(pendingPrompts(c), func(p model.PendingPrompt) bool {
		return p.ID == id && p.State == promptWaiting
	})
}

func (m *Manager) promptContext(c *Chat, context string) string {
	if c.meta.Board == "" {
		return ""
	}
	if context != "" {
		return context
	}
	name := c.meta.Board
	if bd, ok := m.Boards.Get(c.meta.Board); ok {
		name = bd.Name
	}
	return prompts.BoardContext(name, c.meta.Board)
}

// pausePromptDelivery is called by the worker with c.mu held and returns with it held.
func (m *Manager) pausePromptDelivery(c *Chat) {
	if !c.deleted && !m.down.Load() && pausePrompts(c) {
		m.logSave(c)
		var out outbox
		out.emitChat(c)
		c.mu.Unlock()
		m.send(out)
		c.mu.Lock()
	}
}

// changePrompt updates one queued entry, leaving the save to the caller when
// it is part of committing a send. State changes are persisted before handoff.
func (m *Manager) changePrompt(c *Chat, id, state string, remove bool) bool {
	for i, p := range pendingPrompts(c) {
		if p.ID != id {
			continue
		}
		entries := slices.Clone(pendingPrompts(c))
		if remove {
			entries = slices.Delete(entries, i, i+1)
		} else {
			entries[i].State = state
		}
		setPendingPrompts(c, entries)
		if !remove {
			m.logSave(c)
		}
		return true
	}
	return false
}

func (m *Manager) consumeSteer(c *Chat, id string, out *outbox) {
	for _, p := range pendingPrompts(c) {
		if p.ID != id || p.State != promptWaiting {
			continue
		}
		if imgs, err := m.takePromptImages(c, p.Images); err == nil {
			m.markSent(imgs)
			m.releaseImages(imgs)
		}
		newTurn := !inTurn(c)
		if newTurn {
			c.meta.TurnActive = true // Claude can pick up the message in its own next turn.
		}
		out.emitItems(c, c.tr.AddPendingUser(p.ID, p.Text, m.promptContext(c, p.Context), p.References, p.Images, newTurn))
		if err := c.tr.Flush(false); err != nil {
			log.Printf("chats: flush %s: %v", c.meta.ID, err)
		}
		m.changePrompt(c, id, "", true)
		m.logSave(c)
		out.emitChat(c)
		return
	}
}

func (m *Manager) finishPromptTurn(c *Chat, ev agent.Event, out *outbox) {
	if ev.Kind == agent.EvExit || ev.Aborted || ev.Error != "" {
		if pausePrompts(c) {
			m.logSave(c)
			out.emitChat(c)
		}
		return
	}
	// Claude retains accepted input and can start its own next turn. Other
	// adapters report pickup before turn end, or return an explicit rejection.
	// If neither arrived, wait for the handoff result before leaving it paused.
	if !model.IsClaude(c.meta.Agent) {
		for _, p := range pendingPrompts(c) {
			if p.State == promptWaiting {
				if c.promptWorker {
					c.steerTurnEnded = true
				} else if pausePrompts(c) {
					m.logSave(c)
					out.emitChat(c)
				}
				return
			}
		}
	}
}
