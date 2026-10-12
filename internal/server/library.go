package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"ai-whiteboard/internal/library"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers"
)

// The prompt library: the routes behind the library popup and the insert popup. A page talks to
// this server only: it reads the libraries of every server in one list and names the server in
// each call that changes one, by the id the server has in the server list ("local" = this
// computer). The shapes are in package library (View, Group, Prompt, the bodies and the events).
//
//	GET    /api/library                        → libraryList
//	POST   /api/library/{server}/groups        library.NewGroup     → groupReply
//	PATCH  /api/library/{server}/groups/{id}   library.GroupChange  → groupReply
//	DELETE /api/library/{server}/groups/{id}                        → {"ok":true}
//	POST   /api/library/{server}/prompts       library.NewPrompt    → promptReply
//	PATCH  /api/library/{server}/prompts/{id}  library.PromptChange → promptReply
//	DELETE /api/library/{server}/prompts/{id}                       → {"ok":true}
//
// The list is also the snapshot's "libraries", and after every change the pages get the changed
// library whole in a "library" event (library.Event): a page needs no read after a call.
//
// On the loopback listener the routes that change something are non-GET routes under /api, so
// the guard's known-client rule covers them. The library's own server checks every rule of the
// library. A call that breaks one is refused with {"error": <a sentence the popup shows>,
// "code": <a library.Code…>}; the status is libraryStatus's.
//
// A call for another server is passed on to that server over the connection this one holds to
// it (remotes.RemoteLibrary), and that server checks the rules. Beside its refusals such a call
// has three answers of its own, each with a sentence to show: 503 "server_unreachable" (the
// server is not connected: its library cannot be changed until it is back), 504 "no_answer" and
// 502 (its answer cannot be used).
//
// The routes are on the remote listener too (RemoteRoutes): there they are what an API client
// may do with this server's own library, and with no other. Its list holds that one library,
// without the notice, and {server} must be "local". The API client gets the library by itself,
// in its snapshot and in "own_library" events (app.APISnapshot).

// libraryList is the answer of GET /api/library.
type libraryList struct {
	Libraries []library.View `json:"libraries"` // this computer's first; never null
}

// groupReply is the answer of a call that makes or changes a group: the group as it is now.
type groupReply struct {
	Group library.Group `json:"group"`
}

// promptReply is the answer of a call that makes or changes a prompt: the prompt as it is now.
type promptReply struct {
	Prompt library.Prompt `json:"prompt"`
}

// CodeNoServer is the code of a library call that names a server which has no library here.
const CodeNoServer = "no_server"

// libraryBodyMax is the most a body of a library route may hold: a text of library.MaxText
// characters, whatever the characters and however they are escaped, is below it.
const libraryBodyMax = 2 << 20

// libraryStatus is the status of a refusal, by its code.
func libraryStatus(code string) int {
	switch code {
	case library.CodeNotFound, library.CodeNoGroup:
		return http.StatusNotFound
	case library.CodeNameTaken, library.CodeBadMove, library.CodeFull, library.CodeTooDeep:
		return http.StatusConflict
	case library.CodeTextTooLong:
		return http.StatusRequestEntityTooLarge
	}
	return http.StatusBadRequest // bad_name, bad_text
}

// libraryFail writes an error of a library: a refusal with its sentence and code, a call to
// another server that could not be made as it says itself (remotes.Error), anything else (the
// file could not be written) as 500.
func libraryFail(w http.ResponseWriter, err error) {
	var r *library.Refusal
	if errors.As(err, &r) {
		writeErrorCode(w, libraryStatus(r.Code), r.Text, r.Code)
		return
	}
	var re *remotes.Error
	if errors.As(err, &re) {
		writeReply(w, re.Reply())
		return
	}
	writeError(w, http.StatusInternalServerError, err.Error())
}

// readLibraryBody reads the body of a library route into v, at most libraryBodyMax of it.
func readLibraryBody(w http.ResponseWriter, r *http.Request, v any) bool {
	err := json.NewDecoder(http.MaxBytesReader(w, r.Body, libraryBodyMax)).Decode(v)
	var tooBig *http.MaxBytesError
	switch {
	case errors.As(err, &tooBig):
		writeErrorCode(w, http.StatusRequestEntityTooLarge, "This is more than a prompt can hold.", library.CodeTextTooLong)
		return false
	case err != nil:
		writeError(w, http.StatusBadRequest, err.Error())
		return false
	}
	return true
}

// libraryCalls are the calls that change one library: of this computer's (*library.Store) or of
// another server's (*remotes.RemoteLibrary). An error is a *library.Refusal, a *remotes.Error or
// a failure of the file system.
type libraryCalls interface {
	CreateGroup(name, parent string) (library.Group, error)
	ChangeGroup(id string, c library.GroupChange) (library.Group, error)
	DeleteGroup(id string) error
	CreatePrompt(name, parent, text string) (library.Prompt, error)
	ChangePrompt(id string, c library.PromptChange) (library.Prompt, error)
	DeletePrompt(id string) error
}

// libraryOf returns the library the call changes: the one of the server {server} of its path.
// A call for a server that has no library here is refused: one that is not in the list, one
// that offers none, one that has not connected since this server started. An API client reaches
// this server's own library only.
func (s *Server) libraryOf(w http.ResponseWriter, r *http.Request) (libraryCalls, bool) {
	id := r.PathValue("server")
	switch {
	case id == servers.LocalID:
		if s.App.Library != nil {
			return s.App.Library, true
		}
	case fromRemote(r) || s.Remotes == nil:
	default:
		if l, ok := s.Remotes.Library(r.Context(), id); ok {
			return l, true
		}
	}
	writeErrorCode(w, http.StatusNotFound, "This server has no prompt library here.", CodeNoServer)
	return nil, false
}

// libraryListOf is the list of the libraries for the caller: all of them for a page, this
// server's own for an API client, without the notice, which names the data folder.
func (s *Server) libraryListOf(r *http.Request) libraryList {
	if !fromRemote(r) {
		return libraryList{Libraries: s.App.Libraries()}
	}
	out := libraryList{Libraries: []library.View{}}
	if own, ok := s.App.OwnLibrary(); ok {
		own.Notice = ""
		out.Libraries = append(out.Libraries, own)
	}
	return out
}

// libraryRoutes registers the routes of the prompt library.
func (s *Server) libraryRoutes(mux interface {
	HandleFunc(string, func(http.ResponseWriter, *http.Request))
}) {
	// with wraps a route that changes the library of {server}.
	with := func(h func(l libraryCalls, w http.ResponseWriter, r *http.Request)) func(http.ResponseWriter, *http.Request) {
		return func(w http.ResponseWriter, r *http.Request) {
			if l, found := s.libraryOf(w, r); found {
				h(l, w, r)
			}
		}
	}
	group := func(w http.ResponseWriter, g library.Group, err error) {
		if err != nil {
			libraryFail(w, err)
			return
		}
		writeJSON(w, groupReply{Group: g})
	}
	prompt := func(w http.ResponseWriter, p library.Prompt, err error) {
		if err != nil {
			libraryFail(w, err)
			return
		}
		writeJSON(w, promptReply{Prompt: p})
	}
	deleted := func(w http.ResponseWriter, err error) {
		if err != nil {
			libraryFail(w, err)
			return
		}
		ok(w)
	}

	mux.HandleFunc("GET /api/library", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, s.libraryListOf(r))
	})
	mux.HandleFunc("POST /api/library/{server}/groups", with(func(l libraryCalls, w http.ResponseWriter, r *http.Request) {
		var in library.NewGroup
		if !readLibraryBody(w, r, &in) {
			return
		}
		g, err := l.CreateGroup(in.Name, in.Parent)
		group(w, g, err)
	}))
	mux.HandleFunc("PATCH /api/library/{server}/groups/{id}", with(func(l libraryCalls, w http.ResponseWriter, r *http.Request) {
		var in library.GroupChange
		if !readLibraryBody(w, r, &in) {
			return
		}
		g, err := l.ChangeGroup(r.PathValue("id"), in)
		group(w, g, err)
	}))
	mux.HandleFunc("DELETE /api/library/{server}/groups/{id}", with(func(l libraryCalls, w http.ResponseWriter, r *http.Request) {
		deleted(w, l.DeleteGroup(r.PathValue("id")))
	}))
	mux.HandleFunc("POST /api/library/{server}/prompts", with(func(l libraryCalls, w http.ResponseWriter, r *http.Request) {
		var in library.NewPrompt
		if !readLibraryBody(w, r, &in) {
			return
		}
		p, err := l.CreatePrompt(in.Name, in.Parent, in.Text)
		prompt(w, p, err)
	}))
	mux.HandleFunc("PATCH /api/library/{server}/prompts/{id}", with(func(l libraryCalls, w http.ResponseWriter, r *http.Request) {
		var in library.PromptChange
		if !readLibraryBody(w, r, &in) {
			return
		}
		p, err := l.ChangePrompt(r.PathValue("id"), in)
		prompt(w, p, err)
	}))
	mux.HandleFunc("DELETE /api/library/{server}/prompts/{id}", with(func(l libraryCalls, w http.ResponseWriter, r *http.Request) {
		deleted(w, l.DeletePrompt(r.PathValue("id")))
	}))
}
