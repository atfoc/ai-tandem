package chats

import "ai-whiteboard/internal/model"

// AgentName is the name the person reads for the agent kind a (usable.Set.Name): "Claude Code",
// "Cursor", "pi", or a Claude account's own name.
func (m *Manager) AgentName(a model.AgentKind) string { return m.Agents.Name(a) }
