package chats

import "ai-whiteboard/internal/model"

// extraCaller is the in-memory identity of one live extra (subagent) token.
type extraCaller struct {
	chatID string
	sid    string
	kind   model.AgentKind
	model  string
	effort string
}

// Caller is the identity ResolveToken returns for a persisted chat token or a live extra token.
type Caller struct {
	Meta     model.ChatMeta
	SID      string // empty for the chat agent
	Subagent bool
	Kind     model.AgentKind
	Model    string
	Effort   string
}

// ResolveToken looks up a persisted chat token or a live extra token.
// Extra tokens return the parent chat. Unknown/empty → false.
func (m *Manager) ResolveToken(token string) (Caller, bool) {
	if token == "" {
		return Caller{}, false
	}
	m.extrasMu.Lock()
	extra, isExtra := m.extras[token]
	m.extrasMu.Unlock()
	if isExtra {
		c, err := m.get(extra.chatID)
		if err != nil {
			return Caller{}, false
		}
		c.mu.Lock()
		meta := c.meta
		c.mu.Unlock()
		return Caller{
			Meta:     meta,
			SID:      extra.sid,
			Subagent: true,
			Kind:     extra.kind,
			Model:    extra.model,
			Effort:   extra.effort,
		}, true
	}
	for _, c := range m.all() {
		c.mu.Lock()
		meta := c.meta
		c.mu.Unlock()
		if meta.Token == token {
			return Caller{
				Meta:     meta,
				SID:      "",
				Subagent: false,
				Kind:     meta.Agent,
				Model:    meta.Model,
				Effort:   meta.Effort,
			}, true
		}
	}
	return Caller{}, false
}

// ByToken finds the chat whose MCP credential is token, including a live extra token
// (which resolves to the parent chat, so board-parent sub board tools still hit the parent board).
func (m *Manager) ByToken(token string) (model.ChatMeta, bool) {
	caller, ok := m.ResolveToken(token)
	return caller.Meta, ok
}

// uniqueTokenLocked returns a fresh token not in used. extrasMu held.
func (m *Manager) uniqueTokenLocked() string {
	if m.used == nil {
		m.used = map[string]struct{}{}
	}
	for {
		tok := randHex(16)
		if _, ok := m.used[tok]; !ok {
			m.used[tok] = struct{}{}
			return tok
		}
	}
}

func (m *Manager) registerChatToken(tok string) {
	if tok == "" {
		return
	}
	m.extrasMu.Lock()
	if m.used == nil {
		m.used = map[string]struct{}{}
	}
	m.used[tok] = struct{}{}
	m.extrasMu.Unlock()
}

func (m *Manager) unregisterChatToken(tok string) {
	if tok == "" {
		return
	}
	m.extrasMu.Lock()
	delete(m.used, tok)
	m.extrasMu.Unlock()
}

// ensureToken mints a persisted chat token if c has none. c.mu held.
func (m *Manager) ensureToken(c *Chat) {
	if c.meta.Token != "" {
		m.registerChatToken(c.meta.Token)
		return
	}
	m.extrasMu.Lock()
	c.meta.Token = m.uniqueTokenLocked()
	m.extrasMu.Unlock()
	m.logSave(c)
}

// issueExtraToken mints a per-caller extra token for one app-spawned sub, in memory only.
// May be called with c.mu held (Chat.mu then extrasMu).
func (m *Manager) issueExtraToken(c *Chat, sid string, kind model.AgentKind, modelID, effort string) string {
	m.extrasMu.Lock()
	defer m.extrasMu.Unlock()
	if m.extras == nil {
		m.extras = map[string]extraCaller{}
	}
	if m.extraBySID == nil {
		m.extraBySID = map[string]string{}
	}
	tok := m.uniqueTokenLocked()
	m.extras[tok] = extraCaller{chatID: c.meta.ID, sid: sid, kind: kind, model: modelID, effort: effort}
	m.extraBySID[c.meta.ID+"/"+sid] = tok
	return tok
}

func (m *Manager) revokeExtra(chatID, sid string) {
	m.extrasMu.Lock()
	defer m.extrasMu.Unlock()
	key := chatID + "/" + sid
	tok, ok := m.extraBySID[key]
	if !ok {
		return
	}
	delete(m.extraBySID, key)
	delete(m.extras, tok)
	delete(m.used, tok)
}

func (m *Manager) revokeChatExtras(chatID string) {
	m.extrasMu.Lock()
	defer m.extrasMu.Unlock()
	for tok, e := range m.extras {
		if e.chatID == chatID {
			delete(m.extras, tok)
			delete(m.used, tok)
			delete(m.extraBySID, chatID+"/"+e.sid)
		}
	}
}
