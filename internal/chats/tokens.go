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
	// Meta is the meta of the caller's own chat object. For a branch that is the branch's (its ID
	// the branch's server id), with the archive fields of its top-level chat.
	Meta     model.ChatMeta
	Chat     string // the top-level chat id (the client's id for this caller's chat)
	Branch   string // the branch whose agent calls, "main" or a branch id; a subagent's is its owner's
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
		meta, chat := m.callerMeta(c, meta)
		return Caller{
			Meta:     meta,
			Chat:     chat,
			Branch:   callerBranch(c),
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
			meta, chat := m.callerMeta(c, meta)
			return Caller{
				Meta:     meta,
				Chat:     chat,
				Branch:   callerBranch(c),
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

// callerMeta is the meta a caller of the chat object c is known by, and its top-level chat's id:
// for a branch, its own meta (a copy taken under its lock) with the archive state of its
// top-level chat, where alone it is kept. No chat's mu may be held.
func (m *Manager) callerMeta(c *Chat, meta model.ChatMeta) (model.ChatMeta, string) {
	if c.top == nil {
		return meta, meta.ID
	}
	c.top.mu.Lock()
	defer c.top.mu.Unlock()
	meta.Archive = c.top.meta.Archive
	return meta, c.top.meta.ID
}

// callerBranch is the branch id of the chat object c: "main" for a top-level chat.
func callerBranch(c *Chat) string {
	if c.branch == "" {
		return model.MainBranch
	}
	return c.branch
}

// ByToken finds the chat whose MCP credential is token, including a live extra token
// (which resolves to the parent chat, so board-parent sub board tools still hit the parent board).
// A branch's token gives the branch's meta (see Caller).
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
