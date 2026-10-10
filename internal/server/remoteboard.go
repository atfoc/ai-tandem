package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
)

// The routes of a board that is on another server. This server keeps a record of such a board
// (internal/remotes) under the board's id, and a page calls /api/boards/{id}… for it as for any
// board: remoteFirst serves those calls from boardRecordRoutes, which says per route what a
// record's call is: passed on to the board's server, answered here, or refused. The drawing
// stays on the board's server; which page of this server draws is the bridge's matter here,
// and the relay keeps this server's hold there equal to it.
//
// Two routes of a board name no id in their path: the creation, whose body names the server,
// and a page's answer to a tool call, whose body names the call. remoteFirst peeks into those
// bodies (peekBoardRoute) and gives every request that is not a remote board's on to the mux.
//
// None of it is in RemoteHandler: on the remote listener a record's id is "no such board".

// boardPrefix is the path every route of one board starts with, before its id.
const boardPrefix = "/api/boards/"

// remoteSceneMax is the size limit of a drawing a page saves on a board of another server: the
// limit of that server's remote listener, and of the answers this one reads from it, so what
// was saved can be read back. A board of this server has no limit.
const remoteSceneMax = 32 << 20

// boardOf is the board id of a path that is /api/boards/{id} or below it.
func boardOf(path string) (id string, ok bool) {
	rest, ok := strings.CutPrefix(path, boardPrefix)
	if !ok {
		return "", false
	}
	id, _, _ = strings.Cut(rest, "/")
	return id, id != ""
}

// peekBoardRoute serves the two routes of a remote board that name no id in their path, and
// reports whether it did. Otherwise the request is the mux's, with its body as it came (an answer's
// body is read up to rpcReplyMax, as the mux's handler reads it).
//
//   - POST /api/boards whose "server" is an entry of the server list: the board is made there
//     (see createBoardThere). No "server", or "local", is a board of this server.
//   - POST /api/rpc-reply whose "id" is a tool call the relay passed on to a page: the answer
//     goes to the board's server. Any other id is a call of this server's own bridge.
func (s *Server) peekBoardRoute(w http.ResponseWriter, r *http.Request) (served bool) {
	if s.Remotes == nil || r.Method != http.MethodPost || (r.URL.Path != "/api/boards" && r.URL.Path != "/api/rpc-reply") {
		return false
	}
	var body []byte
	if r.URL.Path == "/api/rpc-reply" {
		var read bool
		if body, read = s.readRPCReply(w, r); !read {
			return true // too large, or unreadable: answered
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
	} else {
		var err error
		body, err = io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		if err != nil {
			return false // the mux's handler meets the same end of the body
		}
	}
	var named struct {
		ID     string `json:"id"`
		Server string `json:"server"`
		Name   string `json:"name"`
		Group  string `json:"group"`
	}
	if json.Unmarshal(body, &named) != nil {
		return false // refused by the mux's handler, as before
	}
	client := r.Header.Get(ClientHeader)
	switch {
	case r.URL.Path == "/api/rpc-reply" && s.Remotes.IsBoardCall(named.ID):
		writeReply(w, s.Remotes.ReplyBoardCall(r.Context(), client, named.ID, body))
	case r.URL.Path == "/api/boards" && named.Server != "" && named.Server != model.LocalServer:
		s.createBoardThere(w, r, named.Server, named.Name, named.Group)
	default:
		return false
	}
	return true
}

// createBoardThere makes a board on the server entry, in the group of this one: the relay makes
// the id and the record. As for a board of this server, the page that creates the board takes
// it, if it is free; what that take answers is not the creation's matter. The answer is the
// board as a page gets it.
func (s *Server) createBoardThere(w http.ResponseWriter, r *http.Request, entry, name, group string) {
	bd, e := s.Remotes.CreateBoard(r.Context(), entry, name, group)
	if e != nil {
		writeReply(w, e.Reply())
		return
	}
	s.Remotes.TakeBoard(r.Context(), r.Header.Get(ClientHeader), bd.ID, true)
	writeJSON(w, bd)
}

// boardRecordRoutes is the table of the routes of a board record: one for every route of the
// mux under /api/boards/{id}, spelled as it is registered there (a test holds the two together).
// They are served only for an id that has a record, so s.Remotes is set.
func (s *Server) boardRecordRoutes() *routeMux {
	mux := newRouteMux()
	id := func(r *http.Request) string { return r.PathValue("id") }
	client := func(r *http.Request) string { return r.Header.Get(ClientHeader) }

	// The drawing is read from the board's server, with its revision in SceneRevHeader.
	mux.HandleFunc("GET /api/boards/{id}/scene", func(w http.ResponseWriter, r *http.Request) {
		body, rev, e := s.Remotes.Scene(r.Context(), id(r))
		if e != nil {
			writeReply(w, e.Reply())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set(SceneRevHeader, strconv.FormatInt(rev, 10))
		w.Write(body)
	})
	// The drawing of the page that holds the board here is passed on at the revision ?rev=. It
	// is read whole, up to remoteSceneMax. While the board's server cannot be asked the answer
	// is 503, and the page keeps the edit.
	mux.HandleFunc("PUT /api/boards/{id}/scene", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, remoteSceneMax))
		var tooLarge *http.MaxBytesError
		switch {
		case errors.As(err, &tooLarge):
			writeErrorCode(w, http.StatusRequestEntityTooLarge, "the drawing is larger than 32 MB", "too_large")
			return
		case err != nil:
			writeError(w, http.StatusBadRequest, err.Error())
			return
		case !r.URL.Query().Has("rev"):
			writeError(w, http.StatusBadRequest, "rev is missing")
			return
		}
		base, err := strconv.ParseInt(r.URL.Query().Get("rev"), 10, 64)
		if err != nil || base < 0 {
			writeError(w, http.StatusBadRequest, "rev is not a number")
			return
		}
		writeReply(w, s.Remotes.SaveScene(r.Context(), client(r), id(r), base, body))
	})
	// Who draws: the bridge decides among the pages of this server, and the relay keeps this
	// server's hold on the board's server equal to "a page here holds it".
	mux.HandleFunc("POST /api/boards/{id}/take", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ IfFree bool }
		if !readOptionalJSON(w, r, &body) {
			return
		}
		writeReply(w, s.Remotes.TakeBoard(r.Context(), client(r), id(r), body.IfFree))
	})
	mux.HandleFunc("POST /api/boards/{id}/release", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, s.Remotes.ReleaseBoard(r.Context(), client(r), id(r)))
	})
	// Passed on with its body: the name is the board's server's, so it is refused while that
	// server is not connected. The answer is the record's view.
	mux.HandleFunc("POST /api/boards/{id}/rename", func(w http.ResponseWriter, r *http.Request) {
		if body, good := readBody(w, r); good {
			writeReply(w, s.Remotes.RenameBoard(r.Context(), id(r), body))
		}
	})
	// Local: "group" is the record's place here. Nothing is sent.
	mux.HandleFunc("PATCH /api/boards/{id}", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Group string }
		if !readJSON(w, r, &body) {
			return
		}
		writeReply(w, s.Remotes.PatchBoard(id(r), body.Group))
	})
	// The mark shows at once and is passed on when the board's server can be asked; an unarchive
	// also brings back the archived groups the record is nested in.
	mux.HandleFunc("POST /api/boards/{id}/archive", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, remotes.ReplyOf(s.App.ArchiveBoardRecord(r.Context(), id(r))))
	})
	mux.HandleFunc("POST /api/boards/{id}/unarchive", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, remotes.ReplyOf(s.App.UnarchiveBoardRecord(r.Context(), id(r))))
	})
	mux.HandleFunc("POST /api/boards/{id}/seen", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, s.Remotes.SeenBoard(r.Context(), id(r)))
	})
	// Deletes the board on its server and the record with it; refused while that server is not
	// connected. With ?local=1 the record alone goes ("Remove from this sidebar"), which is
	// refused while the server is connected.
	mux.HandleFunc("DELETE /api/boards/{id}", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, remotes.ReplyOf(s.App.DeleteBoardRecord(r.Context(), id(r), r.URL.Query().Get("local") == "1")))
	})
	// Refused: the board's file is on its server.
	mux.HandleFunc("POST /api/boards/{id}/reveal", func(w http.ResponseWriter, r *http.Request) {
		writeErrorCode(w, http.StatusBadRequest, "A board on another server has no file on this computer", "not_here")
	})
	// An API client's creation call: there is none for a caller of this listener, as for every id.
	mux.HandleFunc("PUT /api/boards/{id}", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not found")
	})
	return mux
}
