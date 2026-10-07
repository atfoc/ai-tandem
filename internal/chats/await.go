package chats

// AwaitStart returns when no creation call (Start) or removal of this chat id is under way: it takes
// the id's creation lock (m.ids) and releases it. An id that is not a valid chat id returns at once.
func (m *Manager) AwaitStart(id string) {
	if !chatID.MatchString(id) {
		return
	}
	m.ids.lock(id)()
}
