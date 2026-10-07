package chats

// DeleteOnRun deletes every chat of a person whose Run is run (the unstarted chats made on a
// remote run before their first message). A run agent's own chat is never touched.
func (m *Manager) DeleteOnRun(run string) {
	people, _ := m.ChatsOfRun(run) // nothing for ""
	for _, meta := range people {
		m.Delete(meta.ID) // ErrNotFound: someone deleted it meanwhile
	}
}
