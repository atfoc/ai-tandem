package pi

import (
	"encoding/json"
	"fmt"
	"time"

	"ai-whiteboard/internal/agent"
)

// permDecision is one answer to a pending permission ask.
type permDecision struct {
	allow  bool
	reason string
}

// permTimeout is how long an ask blocks before it is denied; a var so tests can shorten it.
var permTimeout = 10 * time.Minute

// Permission implements agent.RunHandler: the extension's tool_call hook blocks on it. The app's
// own folder is denied without a card; everything else becomes an EvPermRequest and waits for
// Decide, the process end, or the timeout. No mutex is held while blocking.
func (p *proc) Permission(toolCallID, toolName string, input json.RawMessage, sub *agent.SubIdentity) (bool, string) {
	if agent.TouchesAppDir(input, p.s.AppRoot, p.s.Home) {
		return false, agent.AppDirDenied
	}
	ch := make(chan permDecision, 1)
	p.perms.Store(toolCallID, ch)
	ev := agent.Event{Kind: agent.EvPermRequest, PermID: toolCallID, ToolID: toolCallID,
		ToolName: normalize(toolName), Input: input}
	if sub != nil {
		ev.Sub = sub.Parent // asked by a subagent: the card stays in the parent thread
	}
	p.emit(ev)
	select {
	case d := <-ch:
		return d.allow, d.reason
	case <-p.done:
		if p.perms.CompareAndDelete(toolCallID, ch) {
			p.emit(agent.Event{Kind: agent.EvToolDenied, ToolID: toolCallID})
		}
		return false, "the agent stopped before the request was answered"
	case <-time.After(permTimeout):
		p.perms.CompareAndDelete(toolCallID, ch)
		p.emit(agent.Event{Kind: agent.EvToolDenied, ToolID: toolCallID})
		return false, "the request timed out"
	}
}

// Decide answers a pending permission request. Unknown ids are an error.
func (p *proc) Decide(requestID string, allow bool) error {
	v, ok := p.perms.LoadAndDelete(requestID)
	if !ok {
		return fmt.Errorf("unknown permission request %q", requestID)
	}
	reason := ""
	if !allow {
		reason = "The user said no in AI Whiteboard."
		p.emit(agent.Event{Kind: agent.EvToolDenied, ToolID: requestID})
	}
	v.(chan permDecision) <- permDecision{allow: allow, reason: reason}
	return nil
}

// denyPending fails every open ask when the process ends, so the extension is not left blocked.
// Each ask denied this way emits EvToolDenied, like the deny and timeout paths.
func (p *proc) denyPending() {
	p.perms.Range(func(k, v any) bool {
		if p.perms.CompareAndDelete(k, v) {
			p.emit(agent.Event{Kind: agent.EvToolDenied, ToolID: k.(string)})
			select {
			case v.(chan permDecision) <- permDecision{reason: "the agent stopped"}:
			default:
			}
		}
		return true
	})
}
