package chats

import "ai-whiteboard/internal/model"

// SpawnCatalog is the model list spawn_subagent validates kind against: the stored list, else
// (Claude only) the built-in one, else nil when the list is not known yet (Cursor's and pi's until
// the agent has reported it). The result is a shallow copy; callers must not modify its slices.
func (m *Manager) SpawnCatalog(kind model.AgentKind) *model.Catalog {
	return m.catalog(kind)
}

// SpawnDefaults is the agent, model and effort spawn_subagent would record for chat chatID when
// agent kind is requested (empty = the chat's own) and model and effort are omitted. It reads
// state and starts nothing.
func (m *Manager) SpawnDefaults(chatID string, kind model.AgentKind) (resolved model.AgentKind, modelID, effort string, err error) {
	c, err := m.lock(chatID)
	if err != nil {
		return "", "", "", err
	}
	defer c.mu.Unlock()
	return m.resolveSubSpawn(c, SpawnSubRequest{Kind: kind})
}
