package app

import (
	"ai-whiteboard/internal/library"
	"ai-whiteboard/internal/servers"
)

// The prompt libraries the pages get: this computer's own (Library), first, and after it those
// of the servers of the server list that offer one, in the list's order (the relay keeps a copy
// of each, see remotes.Relay.Libraries). Each is a library.View under its server's id. The pages
// read the list in the snapshot ("libraries") and with GET /api/library, and get one "library"
// event for every library that changes.
//
// An API client gets this computer's library alone: in its snapshot (APISnapshot.Library) and,
// after every change, in an "own_library" event.

// OpenLibrary opens this computer's library in the data folder root (see library.Open) and
// sends its events after every change: "library" to the pages, "own_library" to the API clients.
func (a *App) OpenLibrary(root string) error {
	st, err := library.Open(root, func(t library.Tree) {
		a.Bridge.Broadcast(library.Event{Type: library.EventLibrary, Library: a.localLibrary(t)})
		a.Bridge.Broadcast(library.Own{Type: library.EventOwn, Groups: t.Groups, Prompts: t.Prompts})
	})
	if err != nil {
		return err
	}
	a.Library = st
	return nil
}

// Libraries is the list of the libraries, this computer's first; never nil. Without a library
// of this computer (Library is nil) it starts with the first server's.
func (a *App) Libraries() []library.View {
	out := []library.View{}
	if own, ok := a.OwnLibrary(); ok {
		out = append(out, own)
	}
	if a.Remotes != nil {
		out = append(out, a.Remotes.Libraries()...)
	}
	return out
}

// OwnLibrary is this computer's library as a page gets it; ok is false without one.
func (a *App) OwnLibrary() (v library.View, ok bool) {
	if a.Library == nil {
		return library.View{}, false
	}
	return a.localLibrary(a.Library.Tree()), true
}

// localLibrary is this computer's library, with the content t, as a page gets it.
func (a *App) localLibrary(t library.Tree) library.View {
	return library.View{Server: servers.LocalID, Name: servers.LocalName, Connected: true,
		Notice: a.Library.Notice(), Groups: t.Groups, Prompts: t.Prompts}
}
