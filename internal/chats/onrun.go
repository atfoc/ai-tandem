package chats

// DeleteOnRun deletes every chat of a person whose Run is run (the unstarted chats made on a
// remote run before their first message). A run agent's own chat is never touched.
func (m *Manager) DeleteOnRun(run string) {
	people, _ := m.ChatsOfRun(run) // nothing for ""
	for _, meta := range people {
		m.Delete(meta.ID) // ErrNotFound: someone deleted it meanwhile
	}
}

// DeleteOnBoard deletes every top-level chat whose Board is board. It is for a board on another
// server whose record is gone: the chats on it here are the ones that have not started.
func (m *Manager) DeleteOnBoard(board string) {
	if board == "" {
		return
	}
	for _, meta := range m.ChatsOfBoard(board) {
		m.Delete(meta.ID) // ErrNotFound: someone deleted it meanwhile
	}
}
