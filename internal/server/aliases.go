package server

import (
	"net/http"

	"ai-whiteboard/internal/aliases"
)

// AliasAPI is what the client API's account routes call (goal §3.8; the shapes are
// internal/aliases/api.go). *aliases.Service has it. A method answers once what it was asked is
// done (a recreate included); one that waits on a person (a busy container) answers at once with
// aliases.RestartBusy instead. Every change it makes is also sent as the "aliases" event.
type AliasAPI interface {
	List() aliases.List
	Add(in aliases.Input) (aliases.View, error)
	Edit(id string, in aliases.Input) (aliases.Change, error)
	Remove(id string) error
	Restart(id string, force bool) (aliases.Change, error)
	Stop(id string, force bool) (aliases.Change, error)
	Login(id string) (aliases.LoginAnswer, error)
	LoginCode(id, code string) (aliases.LoginAnswer, error)
	CancelLogin(id string) error
	Logout(id string) (aliases.View, error)
}

// aliasRoutes registers the account routes of the client API. They are rows of ClientRoutes.
func (s *Server) aliasRoutes(mux *routeMux) {
	// with answers 501 on a server that has no accounts, and otherwise runs h with them.
	with := func(h func(a AliasAPI, w http.ResponseWriter, r *http.Request)) func(http.ResponseWriter, *http.Request) {
		return func(w http.ResponseWriter, r *http.Request) {
			if s.Aliases == nil {
				writeError(w, http.StatusNotImplemented, "Claude accounts are not available on this server")
				return
			}
			h(s.Aliases, w, r)
		}
	}
	answer := func(w http.ResponseWriter, v any, err error) {
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, v)
	}

	mux.HandleFunc("GET /api/aliases", with(func(a AliasAPI, w http.ResponseWriter, r *http.Request) {
		writeJSON(w, a.List())
	}))
	mux.HandleFunc("POST /api/aliases", with(func(a AliasAPI, w http.ResponseWriter, r *http.Request) {
		var in aliases.Input
		if !readJSON(w, r, &in) {
			return
		}
		v, err := a.Add(in)
		answer(w, v, err)
	}))
	mux.HandleFunc("PATCH /api/aliases/{id}", with(func(a AliasAPI, w http.ResponseWriter, r *http.Request) {
		var in aliases.Input
		if !readJSON(w, r, &in) {
			return
		}
		c, err := a.Edit(r.PathValue("id"), in)
		answer(w, c, err)
	}))
	mux.HandleFunc("DELETE /api/aliases/{id}", with(func(a AliasAPI, w http.ResponseWriter, r *http.Request) {
		answer(w, map[string]any{}, a.Remove(r.PathValue("id")))
	}))
	mux.HandleFunc("POST /api/aliases/{id}/restart", with(func(a AliasAPI, w http.ResponseWriter, r *http.Request) {
		f, ok := readForce(w, r)
		if !ok {
			return
		}
		c, err := a.Restart(r.PathValue("id"), f)
		answer(w, c, err)
	}))
	mux.HandleFunc("POST /api/aliases/{id}/stop", with(func(a AliasAPI, w http.ResponseWriter, r *http.Request) {
		f, ok := readForce(w, r)
		if !ok {
			return
		}
		c, err := a.Stop(r.PathValue("id"), f)
		answer(w, c, err)
	}))
	mux.HandleFunc("POST /api/aliases/{id}/login", with(func(a AliasAPI, w http.ResponseWriter, r *http.Request) {
		l, err := a.Login(r.PathValue("id"))
		answer(w, l, err)
	}))
	mux.HandleFunc("POST /api/aliases/{id}/login/code", with(func(a AliasAPI, w http.ResponseWriter, r *http.Request) {
		var c aliases.Code
		if !readJSON(w, r, &c) {
			return
		}
		l, err := a.LoginCode(r.PathValue("id"), c.Code)
		answer(w, l, err)
	}))
	mux.HandleFunc("DELETE /api/aliases/{id}/login", with(func(a AliasAPI, w http.ResponseWriter, r *http.Request) {
		answer(w, map[string]any{}, a.CancelLogin(r.PathValue("id")))
	}))
	mux.HandleFunc("POST /api/aliases/{id}/logout", with(func(a AliasAPI, w http.ResponseWriter, r *http.Request) {
		v, err := a.Logout(r.PathValue("id"))
		answer(w, v, err)
	}))
}

// readForce reads the body of restart and stop: {"force": true}; no body is force false.
func readForce(w http.ResponseWriter, r *http.Request) (force, ok bool) {
	if r.ContentLength == 0 {
		return false, true
	}
	var f aliases.Force
	if !readJSON(w, r, &f) {
		return false, false
	}
	return f.Force, true
}
