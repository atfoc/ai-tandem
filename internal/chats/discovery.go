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
	return m.SpawnDefaultsFor(chatID, "", kind)
}

// SpawnDefaultsFor is SpawnDefaults for a spawn by the chat's subagent from ("" = the chat's
// agent): what is omitted is then taken from that subagent, not from the chat. A subagent that
// is unknown or has no process of its own (a native one) is ErrNoSubagent.
func (m *Manager) SpawnDefaultsFor(chatID, from string, kind model.AgentKind) (resolved model.AgentKind, modelID, effort string, err error) {
	c, err := m.lock(chatID)
	if err != nil {
		return "", "", "", err
	}
	defer c.mu.Unlock()
	var caller *sub
	if from != "" {
		// A subagent that calls runs, so the chat's subagents are loaded.
		if caller = c.subs[from]; caller == nil || !caller.app {
			return "", "", "", ErrNoSubagent
		}
	}
	return m.resolveSubSpawn(c, spawnBaseOf(c, caller), SpawnSubRequest{Kind: kind})
}
