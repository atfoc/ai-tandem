package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
)

// What the routes of RemoteRoutes do for an API client, a caller on the remote listener, where
// that differs from what they do for a page. RemoteHandler has checked the secret, the Host and
// the client id before any of this runs: the id in X-AIWB-Client is a valid one, and not the
// server's own.

// apiEvents is GET /api/events on the remote listener: the stream of the API client whose id the
// header holds. A "client" in the query, which the stream of a page is named by, must be the same
// id or absent. The stream begins with hello and the API snapshot (app.APISnapshot), its fields
// inline in the snapshot event.
func (s *Server) apiEvents(w http.ResponseWriter, r *http.Request) {
	id := r.Header.Get(ClientHeader)
	if q := r.URL.Query(); q.Has("client") && q.Get("client") != id {
		writeErrorCode(w, http.StatusBadRequest, "bad client id", "bad_client")
		return
	}
	// ReloadSecret closes the streams that are open when it runs. This request's secret may have
	// been checked before the reload and its stream be recorded after: such a stream gets no
	// snapshot and ends at once. The snapshot function runs once the stream is recorded, with
	// the bridge's lock held, which the close of the streams takes too.
	call, _ := r.Context().Value(remoteKey{}).(remoteCall)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	s.Bridge.ServeAPI(w, r.WithContext(ctx), id, func() any {
		if rm := s.Remote; rm == nil || rm.secretGen.Load() != call.secretGen {
			cancel()
			return nil
		}
		return s.App.APISnapshot(id)
	})
}

// apiStart is POST /api/chats on the remote listener, the creation call: it finds the caller's
// chat with the id or makes it in the group "Remote" (or on the run, or on the board), gives it the call's values
// and sends it the first message (chats.Manager.Start). The call can be repeated: of any number
// of calls with one id one sends.
//
// Body: {"id", "agent", "cwd", "model", "effort", "name", "userNamed", "text", "run", "board"}.
// id, agent and text are required, cwd too unless run is given. A body that names a group, a
// board that is not the caller's (or is archived), or both a run and a board is refused before
// anything else.
//
// Every answer, an error too, holds {"started", "sent", "chat"}: whether the caller's chat has
// had its first message, whether this call put the message into the thread, and the chat when
// the caller has one with this id after the call. A success adds "ok": true, an error "error"
// and, where a client tells it from others, "code".
func (s *Server) apiStart(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID            string
		Agent         model.AgentKind
		Cwd           string
		Model, Effort string
		Name          string
		UserNamed     bool
		Text          string
		Run           string
		Board, Group  string
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeStart(w, http.StatusBadRequest, chats.StartResult{}, err.Error(), "bad_request")
		return
	}
	if body.Board != "" && body.Run != "" {
		writeStart(w, http.StatusBadRequest, chats.StartResult{}, "a chat is on a run or on a board, not on both", "bad_request")
		return
	}
	// A board must be one the caller made, and not archived (apiboards.go).
	if body.Board != "" && !s.marked(r, body.Board) {
		writeStart(w, http.StatusBadRequest, chats.StartResult{}, boardRefused, "board_refused")
		return
	}
	if body.Group != "" {
		writeStart(w, http.StatusBadRequest, chats.StartResult{}, "an API client cannot name a group", "group_refused")
		return
	}
	res, err := s.App.Chats.Start(chats.StartReq{
		ID: body.ID, Client: r.Header.Get(ClientHeader), Run: body.Run, Board: body.Board,
		Agent: body.Agent, Cwd: body.Cwd, Model: body.Model, Effort: body.Effort,
		Name: body.Name, UserNamed: body.UserNamed, Text: body.Text,
		Place: s.App.RemoteGroup,
	})
	if err != nil {
		// An error of the send is the server's or the agent's, not the request's.
		fallback := http.StatusBadRequest
		if res.Tried {
			fallback = http.StatusInternalServerError
		}
		// The board went, or was archived, after the check above.
		if body.Board != "" && (errors.Is(err, boards.ErrNotFound) || errors.Is(err, boards.ErrArchived)) {
			writeStart(w, http.StatusBadRequest, res, boardRefused, "board_refused")
			return
		}
		writeStart(w, statusOf(err, fallback), res, err.Error(), startCode(err))
		return
	}
	writeStart(w, http.StatusOK, res, "", "")
}

// boardRefused is the text of the refusal "board_refused": of the creation call and of a fork.
const boardRefused = "an API client cannot make a chat on a board"

// startCode is the "code" of a refused creation call: the codes of this call alone, and codeOf's.
func startCode(err error) string {
	switch {
	case errors.Is(err, chats.ErrStartValue):
		return "bad_request"
	case errors.Is(err, chats.ErrBadID):
		return "bad_id"
	case errors.Is(err, chats.ErrIDTaken):
		return "id_taken"
	case errors.Is(err, agent.ErrFolderMissing):
		return "folder_missing"
	case errors.Is(err, chats.ErrBadChoice):
		return "bad_choice"
	}
	return codeOf(err)
}

// writeStart writes the answer of a creation call; errText "" is a success.
func writeStart(w http.ResponseWriter, status int, res chats.StartResult, errText, code string) {
	out := map[string]any{"started": res.Started, "sent": res.Sent}
	if res.Exists {
		out["chat"] = res.Chat
	}
	if errText == "" {
		out["ok"] = true
	} else {
		out["error"] = errText
		if code != "" {
			out["code"] = code
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(out)
}
