package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"ai-whiteboard/internal/boards"
)

// The boards of an API client, a caller on the remote listener: it makes a board with an id of
// its own making, which carries its mark (model.Board.Client), and reaches no other board. Take,
// release, the drawing and the answer to an rpc event are the routes a page calls, behind the
// gate ownBoard.

// SceneMax is the largest drawing an API client may write. A page's write has no cap.
const SceneMax = 32 << 20

// marked reports whether the board id is one the caller, an API client, may make a chat on: it
// exists, is not archived and carries the caller's mark.
func (s *Server) marked(r *http.Request, id string) bool {
	bd, found := s.App.Boards.Get(id)
	return found && !bd.Archived && bd.Client == r.Header.Get(ClientHeader)
}

// ownBoard is the gate of the board routes with an {id}: an API client reaches only the boards
// with its mark. A board that does not exist, B's own or another client's is answered 404, the
// same for all three, and false is returned. A page passes.
func (s *Server) ownBoard(w http.ResponseWriter, r *http.Request) bool {
	if !fromRemote(r) {
		return true
	}
	if bd, found := s.App.Boards.Get(r.PathValue("id")); found && bd.Client == r.Header.Get(ClientHeader) {
		return true
	}
	writeError(w, http.StatusNotFound, "no such board")
	return false
}

// apiMakeBoard is PUT /api/boards/{id}, on the remote listener only: it makes the caller's board
// with this id in the group "Remote", with the caller's mark, or finds the one it made before
// ("made": false, the name untouched). It takes nothing: the client takes the board when it
// wants it.
//
// Body: {"name"}; an "id" must be the path's, a "group" is refused.
func (s *Server) apiMakeBoard(w http.ResponseWriter, r *http.Request) {
	if !fromRemote(r) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var body struct{ ID, Name, Group string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErrorCode(w, http.StatusBadRequest, err.Error(), "bad_request")
		return
	}
	id := r.PathValue("id")
	if !boards.ValidID(id) || (body.ID != "" && body.ID != id) {
		writeErrorCode(w, http.StatusBadRequest, boards.ErrBadID.Error(), "bad_id")
		return
	}
	if body.Group != "" {
		writeErrorCode(w, http.StatusBadRequest, "an API client cannot name a group", "group_refused")
		return
	}
	// Before the group is asked for: a name that is refused makes no group.
	if _, err := boards.CleanName(body.Name); body.Name != "" && err != nil {
		writeErrorCode(w, http.StatusBadRequest, err.Error(), "bad_request")
		return
	}
	// Only a free id asks for the group: a creation that is refused or repeated makes none. Make
	// decides about an id that exists, and looks at no group then.
	group := ""
	if old, found := s.App.Boards.Get(id); found {
		group = old.Group
	} else {
		var err error
		if group, err = s.App.RemoteGroup(); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	bd, made, err := s.App.Boards.Make(boards.NewBoard{ID: id, Name: body.Name, Group: group, Client: r.Header.Get(ClientHeader)})
	switch {
	case errors.Is(err, boards.ErrBadID):
		writeErrorCode(w, http.StatusBadRequest, err.Error(), "bad_id")
	case errors.Is(err, boards.ErrIDTaken):
		writeErrorCode(w, http.StatusConflict, err.Error(), "id_taken")
	case err != nil:
		fail(w, err, http.StatusInternalServerError)
	default:
		writeJSON(w, map[string]any{"ok": true, "made": made, "board": bd})
	}
}

// readScene reads the drawing of a write. An API client's is cut at SceneMax: a larger one is
// answered 413 and false is returned.
func readScene(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body := r.Body
	if fromRemote(r) {
		body = http.MaxBytesReader(w, body, SceneMax)
	}
	b, err := io.ReadAll(body)
	var large *http.MaxBytesError
	switch {
	case errors.As(err, &large):
		writeErrorCode(w, http.StatusRequestEntityTooLarge, "the drawing is larger than 32 MB", "too_large")
	case err != nil:
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		return b, true
	}
	return nil, false
}
