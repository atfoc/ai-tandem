package pi

import (
	"log"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

const (
	maxProgress       = 8 << 10 // bounded EvSub progress text
	maxQueuedActivity = 1024    // bounded queue for activity that arrived before its parent tool card
)

// queuedActivity is one child frame held until the tool call that started the child has been
// announced (see Activity).
type queuedActivity struct {
	sub *agent.SubIdentity
	act agent.SubActivity
}

// Activity implements agent.RunHandler: one child-activity frame forwarded by the extension over
// the bridge is mapped onto the subagent's thread.
//
// Nested children race the parent's stream: a grandchild's first frame can reach the bridge
// before the adapter has emitted the inner Agent tool card the manager's owner search needs. Any
// activity whose parent tool id has not been announced yet is queued and flushed when that id
// appears in an outgoing EvToolStart (from any source).
func (p *proc) Activity(sub *agent.SubIdentity, act agent.SubActivity) {
	if sub == nil || sub.Parent == "" {
		p.emitActivity(sub, act)
		return
	}
	p.subMu.Lock()
	if p.announced == nil {
		p.announced = map[string]bool{}
	}
	if !p.announced[sub.Parent] {
		if len(p.subQueue) >= maxQueuedActivity {
			dropped := p.subQueue[0]
			p.subQueue = p.subQueue[1:]
			log.Printf("pi: dropped queued subagent activity for unannounced tool %q (%s)", dropped.sub.Parent, dropped.act.Type)
		}
		p.subQueue = append(p.subQueue, queuedActivity{sub: sub, act: act})
		p.subMu.Unlock()
		return
	}
	p.subMu.Unlock()
	p.emitActivity(sub, act)
}

// announceTool records a tool call id that now has a card and flushes the activity waiting for it.
func (p *proc) announceTool(id string) {
	if id == "" {
		return
	}
	p.subMu.Lock()
	if p.announced == nil {
		p.announced = map[string]bool{}
	}
	p.announced[id] = true
	p.subMu.Unlock()
	p.flushActivities(id)
}

// flushActivities emits every queued activity of one parent, in arrival order.
func (p *proc) flushActivities(parent string) {
	p.subMu.Lock()
	var ready []queuedActivity
	rest := make([]queuedActivity, 0, len(p.subQueue))
	for _, q := range p.subQueue {
		if q.sub != nil && q.sub.Parent == parent {
			ready = append(ready, q)
		} else {
			rest = append(rest, q)
		}
	}
	if len(ready) == 0 {
		p.subMu.Unlock()
		return
	}
	p.subQueue = rest
	p.subMu.Unlock()
	for _, q := range ready {
		p.emitActivity(q.sub, q.act)
	}
}

// emitActivity maps one frame and emits it, announcing nested tool starts.
func (p *proc) emitActivity(sub *agent.SubIdentity, act agent.SubActivity) {
	p.emitEvents(mapActivity(sub, act))
}

// mapActivity turns one SubActivity into agent events. Sub is the immediate parent's tool call
// id: the subagent's own events carry it into that subagent's thread.
func mapActivity(sub *agent.SubIdentity, act agent.SubActivity) []agent.Event {
	parent, child := "", act.ID
	if sub != nil {
		parent = sub.Parent
		if sub.Child != "" {
			child = sub.Child
		}
	}
	switch act.Type {
	case "start":
		bg := act.Background
		return []agent.Event{{Kind: agent.EvSub, Sub: parent, SubInfo: &agent.SubInfo{
			ID: child, Type: act.AgentType, Description: act.Description, Prompt: act.Prompt,
			Model: act.Model, Background: &bg, Status: model.SubRunning}}}

	case "thinking":
		return []agent.Event{{Kind: agent.EvThinking, Sub: parent}}

	case "text":
		return []agent.Event{{Kind: agent.EvTextDelta, Sub: parent, Text: act.Text}}

	case "tool_start":
		return []agent.Event{{Kind: agent.EvToolStart, Sub: parent, ToolID: act.ID, ToolName: normalize(act.Name)}}

	case "tool_input":
		return []agent.Event{{Kind: agent.EvToolInput, Sub: parent, ToolID: act.ID,
			ToolName: normalize(act.Name), Input: act.Input}}

	case "tool_result":
		return []agent.Event{{Kind: agent.EvToolResult, Sub: parent, ToolID: act.ID,
			Result: act.Result, IsError: act.IsError}}

	case "usage":
		return []agent.Event{{Kind: agent.EvSub, Sub: parent, SubInfo: &agent.SubInfo{
			Tokens: act.Tokens, Window: act.Window, ToolUses: act.ToolUses}}}

	case "progress":
		return []agent.Event{{Kind: agent.EvSub, Sub: parent, SubInfo: &agent.SubInfo{
			Progress: boundProgress(act.Text)}}}

	case "done":
		return []agent.Event{{Kind: agent.EvSub, Sub: parent, SubInfo: &agent.SubInfo{
			Status: subStatus(act.Status), Summary: act.Summary, Error: act.Error,
			Tokens: act.Tokens, Window: act.Window, ToolUses: act.ToolUses}}}
	}
	return nil
}

// subStatus maps a done frame's status to the app's final states; "" for anything else.
func subStatus(s string) model.SubStatus {
	switch s {
	case "completed":
		return model.SubCompleted
	case "failed":
		return model.SubFailed
	case "stopped", "killed", "cancelled":
		return model.SubStopped
	}
	return ""
}

// boundProgress bounds accumulated progress text, keeping the latest bytes.
func boundProgress(s string) string {
	if len(s) <= maxProgress {
		return s
	}
	return s[len(s)-maxProgress:]
}
