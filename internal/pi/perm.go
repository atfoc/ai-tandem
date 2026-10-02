package pi

import (
	"encoding/json"
	"fmt"

	"ai-whiteboard/internal/agent"
)

// Permission implements agent.RunHandler: the extension's tool_call hook blocks on it. pi tool
// calls are always approved — the app shows no permission cards, so the ask is answered with an
// allow immediately. The one refusal left is the app's own folder: a tool whose input touches it
// is denied without a card (agent.AppDirDenied), so an agent can never read or write the app's
// data, boards or chat files. No mutex is held here.
func (p *proc) Permission(toolCallID, toolName string, input json.RawMessage, sub *agent.SubIdentity) (bool, string) {
	if agent.TouchesAppDir(input, p.s.AppRoot, p.s.Home) {
		return false, agent.AppDirDenied
	}
	return true, ""
}

// Decide satisfies agent.Agent. Nothing raises permission asks for pi anymore, so every request
// id is unknown; the method stays for the other agents' permission flows.
func (p *proc) Decide(requestID string, allow bool) error {
	return fmt.Errorf("unknown permission request %q", requestID)
}
