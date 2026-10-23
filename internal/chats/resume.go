// The resume of a paused or stopped subagent (design D12): its parent starts it again on its
// recorded session, through startSub, with "carry on" and every result it is owed.
package chats

import (
	"errors"
	"fmt"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// ErrNotStarterResume is what resume_subagent answers a caller that names a subagent it did not start.
var ErrNotStarterResume = errors.New("that subagent was not started by you: resume_subagent resumes only the subagents you started yourself")

// ResumeSubagent is ResumeSubagentBy for the chat's agent.
func (m *Manager) ResumeSubagent(chatID, sid string) (model.Subagent, error) {
	return m.ResumeSubagentBy(chatID, "", sid)
}

// ResumeSubagentBy starts the paused or stopped subagent sid again on its recorded session, with
// its recorded agent, model and effort and the credentials of a new subagent, and returns a
// receipt without waiting for it. by is the caller: the sid of a subagent, "" for the chat's agent;
// a caller resumes only what it started itself. It is held to the limits of SpawnSubagent: the
// chat archived or shutting down, and the cap on running subagents (the depth needs no check: a
// subagent's level is fixed, and its parent has the spawn family). A start that fails leaves the
// subagent as it was.
func (m *Manager) ResumeSubagentBy(chatID, by, sid string) (model.Subagent, error) {
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
	if m.down.Load() {
		unlock()
		return model.Subagent{}, ErrShutdown
	}
	if by != "" {
		if from := c.subs[by]; from == nil || !from.app || from.meta.Status != model.SubRunning {
			unlock()
			return model.Subagent{}, errors.New("the calling subagent has ended")
		}
	}
	s := c.subs[sid]
	if s == nil {
		unlock()
		return model.Subagent{}, ErrNoSubagent
	}
	if s.meta.Parent != by {
		unlock()
		return model.Subagent{}, ErrNotStarterResume
	}
	if err := resumeRefusal(s); err != nil {
		unlock()
		return model.Subagent{}, err
	}
	depth, limit := subLimits(c)
	if n := runningAppSubs(c); limit > 0 && n >= limit {
		unlock()
		return model.Subagent{}, &SubCapError{Cap: limit, Running: n, Resume: true}
	}

	prev, wasApp := s.meta, s.app
	s.meta.Status, s.meta.Ended, s.meta.Delivery = model.SubRunning, 0, ""
	s.meta.Error, s.meta.ErrorKind, s.meta.Cause = "", "", ""
	s.meta.Retry, s.meta.Waiting = model.Retry{}, false
	s.app, s.listed = true, nil
	m.saveSub(c, s)
	out.emitSub(c, s.meta)
	out.emitCounts(c)
	sa := s.meta
	opts := m.subSpawnOptions(c, sid, subLevel(c, sid) >= depth, s.meta.Kind, s.meta.Model, s.meta.Effort, s.meta.Session, true)
	unlock()

	err = m.startSub(chatID, sid, sa.Kind, opts, func(c *Chat, s *sub, out *outbox) ([]agent.ContentBlock, bool) {
		if s.meta.Status != model.SubRunning || s.ag != nil {
			return nil, false
		}
		return m.resumeBlocks(c, s, prev, out), true
	})
	if err != nil {
		var out outbox
		if c, lerr := m.lock(chatID); lerr == nil {
			if s := c.subs[sid]; s != nil && s.meta.Status == model.SubRunning && s.ag == nil {
				s.meta, s.app = prev, wasApp
				m.saveSub(c, s)
				out.emitSub(c, s.meta)
				out.emitCounts(c)
			}
			c.mu.Unlock()
			m.send(out)
		}
		return model.Subagent{}, fmt.Errorf("subagent %s could not be started again: %v; it is %s as before", sid, err, prev.Status)
	}
	return sa, nil
}

// resumeRefusal is the sentence for a subagent that cannot be resumed, nil for one that can.
func resumeRefusal(s *sub) error {
	sa := s.meta
	switch {
	case sa.Kind == "":
		return fmt.Errorf("subagent %s was not started by the app: it cannot be resumed", sa.ID)
	case sa.NotCarried:
		return fmt.Errorf("subagent %s was not carried over into this chat: it cannot be resumed here", sa.ID)
	case sa.Status == model.SubRunning && s.retry != nil:
		return fmt.Errorf("subagent %s is running: it is being retried after a temporary error (attempt %d of %d); only a paused or stopped subagent can be resumed",
			sa.ID, sa.Retry.Attempt, sa.Retry.Of)
	case sa.Status == model.SubRunning:
		return fmt.Errorf("subagent %s is running: only a paused or stopped subagent can be resumed", sa.ID)
	case sa.Status == model.SubCompleted || sa.Status == model.SubFailed:
		return fmt.Errorf("subagent %s has finished (%s): a finished subagent cannot be resumed; start a new one if more work is needed", sa.ID, sa.Status)
	case sa.Session == "":
		return fmt.Errorf("subagent %s cannot be resumed: its session was not recorded (it was started before the app kept subagent sessions)", sa.ID)
	}
	return nil
}

// resumeBlocks is the first message of a resumed subagent s, which was prev: the carry-on block,
// then the results it is owed (taken now, so s.carry holds them), then the list of the subagents it
// started that are paused or stopped, which it may resume in turn (goal 4.6; subCarryOnRest).
// c.mu held.
func (m *Manager) resumeBlocks(c *Chat, s *sub, prev model.Subagent, out *outbox) []agent.ContentBlock {
	blocks := []agent.ContentBlock{{Text: carryOnResumeBlock(prev)}}
	return append(blocks, m.subCarryOnRest(c, s, out)...)
}
