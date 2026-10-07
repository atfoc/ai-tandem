package server

import (
	"errors"
	"net/http"

	"ai-whiteboard/internal/servers"
)

// The server list: the routes behind the Servers dialog. They are on the loopback listener only
// (none is in RemoteRoutes), and the ones that change something are non-GET routes under /api, so
// the guard's known-client rule covers them. No answer holds a secret: a servers.View has no
// field for one, and a test's result does not repeat what was sent.

// serverForm is the body of an add, an edit and a test: a field that is missing is nil. In an
// edit and in the test of a saved entry a nil field keeps the stored value, and so does an empty
// secret.
type serverForm struct {
	Name       *string `json:"name"`
	Address    *string `json:"address"`
	Secret     *string `json:"secret"`
	SelfSigned *bool   `json:"selfSigned"`
	Pin        *string `json:"pin"`
	Force      bool    `json:"force"`
}

func (f serverForm) patch() servers.Patch {
	return servers.Patch{Name: f.Name, Address: f.Address, Secret: f.Secret, SelfSigned: f.SelfSigned, Pin: f.Pin}
}

func (f serverForm) input() servers.Input {
	str := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	return servers.Input{Name: str(f.Name), Address: str(f.Address), Secret: str(f.Secret),
		SelfSigned: f.SelfSigned != nil && *f.SelfSigned, Pin: str(f.Pin)}
}

// serverSaved is the answer of an add and an edit. A test that did not pass is no error: it
// answers 200 with saved false and the result, which says why.
type serverSaved struct {
	Saved  bool            `json:"saved"`
	Server *servers.View   `json:"server,omitempty"`
	Result *servers.Result `json:"result,omitempty"`
}

// serverFail writes an error of the server list. local is what the local entry's refusal says
// cannot be done with this computer ("edited", "removed", …).
func serverFail(w http.ResponseWriter, err error, local string) {
	var dup *servers.DuplicateError
	switch {
	case errors.Is(err, servers.ErrLocalEntry):
		writeErrorCode(w, http.StatusConflict, "this computer cannot be "+local, "local_entry")
	case errors.Is(err, servers.ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, servers.ErrBadName):
		writeErrorCode(w, http.StatusBadRequest, err.Error(), "bad_name")
	case errors.Is(err, servers.ErrBadAddress):
		writeErrorCode(w, http.StatusBadRequest, err.Error(), "bad_address")
	case errors.Is(err, servers.ErrBadSecret):
		writeErrorCode(w, http.StatusBadRequest, err.Error(), "bad_secret")
	case errors.Is(err, servers.ErrBadPin):
		writeErrorCode(w, http.StatusBadRequest, err.Error(), "bad_pin")
	case errors.As(err, &dup):
		writeErrorCode(w, http.StatusConflict, err.Error(), "duplicate")
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

// serverBodyMax is the most a body of a server-list route may hold.
const serverBodyMax = 64 << 10

// limitBody makes the read of r's body fail past serverBodyMax.
func limitBody(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, serverBodyMax)
}

// serverRoutes registers the routes of the server list. Without a manager (Servers is nil) the
// list is the local entry alone and every other route answers 404.
func (s *Server) serverRoutes(mux interface {
	HandleFunc(string, func(http.ResponseWriter, *http.Request))
}) {
	// with wraps a route that needs the manager.
	with := func(h func(m *servers.Manager, w http.ResponseWriter, r *http.Request)) func(http.ResponseWriter, *http.Request) {
		return func(w http.ResponseWriter, r *http.Request) {
			if s.Servers == nil {
				writeError(w, http.StatusNotFound, servers.ErrNotFound.Error())
				return
			}
			h(s.Servers, w, r)
		}
	}
	saved := func(w http.ResponseWriter, v servers.View, done bool, res *servers.Result, err error, local string) {
		if err != nil {
			serverFail(w, err, local)
			return
		}
		out := serverSaved{Saved: done, Result: res}
		if done {
			out.Server = &v
		}
		writeJSON(w, out)
	}

	mux.HandleFunc("GET /api/servers", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"servers": s.Servers.Views(), "notice": s.Servers.Notice()})
	})
	mux.HandleFunc("POST /api/servers", with(func(m *servers.Manager, w http.ResponseWriter, r *http.Request) {
		limitBody(w, r)
		var in serverForm
		if !readJSON(w, r, &in) {
			return
		}
		v, done, res, err := m.Add(r.Context(), in.input(), in.Force)
		saved(w, v, done, res, err, "added")
	}))
	mux.HandleFunc("PATCH /api/servers/{id}", with(func(m *servers.Manager, w http.ResponseWriter, r *http.Request) {
		limitBody(w, r)
		var in serverForm
		if !readJSON(w, r, &in) {
			return
		}
		v, done, res, err := m.Edit(r.Context(), r.PathValue("id"), in.patch(), in.Force)
		saved(w, v, done, res, err, "edited")
	}))
	mux.HandleFunc("DELETE /api/servers/{id}", with(func(m *servers.Manager, w http.ResponseWriter, r *http.Request) {
		if err := m.Remove(r.PathValue("id")); err != nil {
			serverFail(w, err, "removed")
			return
		}
		ok(w)
	}))
	mux.HandleFunc("GET /api/servers/{id}/items", with(func(m *servers.Manager, w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if _, found := m.View(id); !found {
			serverFail(w, servers.ErrNotFound, "")
			return
		}
		chats, runs := 0, 0
		if m.Counts != nil {
			chats, runs = m.Counts(id)
		}
		writeJSON(w, map[string]int{"chats": chats, "runs": runs})
	}))
	mux.HandleFunc("POST /api/servers/test", with(func(m *servers.Manager, w http.ResponseWriter, r *http.Request) {
		limitBody(w, r)
		var in serverForm
		if !readJSON(w, r, &in) {
			return
		}
		f := in.input()
		writeJSON(w, m.Test(r.Context(), servers.Target{Address: f.Address, Secret: f.Secret, SelfSigned: f.SelfSigned, Pin: f.Pin}))
	}))
	mux.HandleFunc("POST /api/servers/{id}/test", with(func(m *servers.Manager, w http.ResponseWriter, r *http.Request) {
		limitBody(w, r)
		var in serverForm
		if !readOptionalJSON(w, r, &in) {
			return
		}
		res, err := m.TestSaved(r.Context(), r.PathValue("id"), in.patch())
		if err != nil {
			serverFail(w, err, "tested")
			return
		}
		writeJSON(w, res)
	}))
	mux.HandleFunc("POST /api/servers/{id}/accept", with(func(m *servers.Manager, w http.ResponseWriter, r *http.Request) {
		limitBody(w, r)
		var in struct {
			Fingerprint string `json:"fingerprint"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		v, err := m.Accept(r.PathValue("id"), in.Fingerprint)
		if err != nil {
			serverFail(w, err, "accepted")
			return
		}
		writeJSON(w, map[string]any{"server": v})
	}))
}
