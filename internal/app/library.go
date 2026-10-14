package app

import (
	"ai-whiteboard/internal/library"
	"ai-whiteboard/internal/model"
)

// The prompt library of this server (Library) is read and changed by every client. A client gets
// it in its snapshot (APISnapshot.Library) and, after every change, in an "own_library" event.

// ownName is the name this server's library has in GET /api/library.
const ownName = "This computer"

// OpenLibrary opens this server's library in the data folder root (see library.Open) and sends
// its "own_library" event after every change.
func (a *App) OpenLibrary(root string) error {
	st, err := library.Open(root, func(t library.Tree) {
		a.Bridge.Broadcast(library.Own{Type: library.EventOwn, Groups: t.Groups, Prompts: t.Prompts})
	})
	if err != nil {
		return err
	}
	a.Library = st
	return nil
}

// OwnLibrary is this server's library as GET /api/library gives it; ok is false without one.
func (a *App) OwnLibrary() (v library.View, ok bool) {
	if a.Library == nil {
		return library.View{}, false
	}
	t := a.Library.Tree()
	return library.View{Server: model.LocalServer, Name: ownName, Connected: true, Groups: t.Groups, Prompts: t.Prompts}, true
}
