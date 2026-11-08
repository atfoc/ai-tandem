package tlrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"ai-whiteboard/internal/model"
)

// Body limits (design 2.2).
const (
	maxSmallBody    = 1 << 20   // open, close
	maxSyncBody     = 32 << 20  // sync, out
	maxSnapshotBody = 128 << 20 // PUT snapshot
)

// Mount adds the routes of design 2.2 to mux. clientHeader names the header that carries the
// caller's client id; the server's client handler in front has checked the secret and the level.
func (r *Relay) Mount(mux interface {
	HandleFunc(string, func(http.ResponseWriter, *http.Request))
}, clientHeader string) {
	h := func(f func(http.ResponseWriter, *http.Request, string)) func(http.ResponseWriter, *http.Request) {
		return func(w http.ResponseWriter, req *http.Request) {
			client := req.Header.Get(clientHeader)
			if client == "" {
				writeError(w, http.StatusBadRequest, "bad_request", "no client id")
				return
			}
			f(w, req, client)
		}
	}
	mux.HandleFunc("POST /api/tl/{id}/open", h(r.handleOpen))
	mux.HandleFunc("POST /api/tl/{id}/sync", h(r.handleSync))
	mux.HandleFunc("POST /api/tl/{id}/close", h(r.handleClose))
	mux.HandleFunc("POST /api/tl-host/out", h(r.handleOut))
	mux.HandleFunc("GET /api/tl/{id}/snapshot", h(r.handleSnapshotGet))
	mux.HandleFunc("PUT /api/tl/{id}/snapshot", h(r.handleSnapshotPut))
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"code": code, "error": msg})
}

func writeOK(w http.ResponseWriter) { writeJSON(w, map[string]any{"ok": true}) }

// tlBoard answers 404 or 409 and returns false unless id names a new board.
func (r *Relay) tlBoard(w http.ResponseWriter, id string) (model.Board, bool) {
	b, ok := r.boards.Get(id)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "no such board")
		return b, false
	}
	if b.Kind != model.KindTL {
		writeError(w, http.StatusConflict, "not_tl", "this board is not a new board")
		return b, false
	}
	return b, true
}

// readBody reads the body within limit; on failure it answers 413 or 400 and returns false.
func readBody(w http.ResponseWriter, req *http.Request, limit int64) ([]byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, req.Body, limit))
	if err != nil {
		var mb *http.MaxBytesError
		if errors.As(err, &mb) {
			writeError(w, http.StatusRequestEntityTooLarge, "too_large", "the body is too large")
		} else {
			writeError(w, http.StatusBadRequest, "bad_request", "the body could not be read")
		}
		return nil, false
	}
	return body, true
}

// decodeBody reads a JSON body within limit into v; on failure it answers and returns false. An
// empty body leaves v as it is.
func decodeBody(w http.ResponseWriter, req *http.Request, limit int64, v any) bool {
	body, ok := readBody(w, req, limit)
	if !ok {
		return false
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return true
	}
	if err := json.Unmarshal(body, v); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "the body is not valid JSON: "+err.Error())
		return false
	}
	return true
}

// isArray reports whether raw is present and its first non-space byte is '['. Nothing else of the
// messages is looked at (goal 4.7).
func isArray(raw json.RawMessage) bool {
	t := bytes.TrimLeft(raw, " \t\r\n")
	return len(t) > 0 && t[0] == '['
}

func (r *Relay) handleOpen(w http.ResponseWriter, req *http.Request, client string) {
	id := req.PathValue("id")
	b, ok := r.tlBoard(w, id)
	if !ok {
		return
	}
	if b.Archived {
		writeError(w, http.StatusConflict, "archived", "the board is archived")
		return
	}
	var body struct{}
	if !decodeBody(w, req, maxSmallBody, &body) {
		return
	}
	host := r.getHost()
	if host == nil {
		writeError(w, http.StatusServiceUnavailable, "board_host_unavailable", noHostReason)
		return
	}
	ctx, cancel := context.WithTimeout(req.Context(), r.openTimeout)
	defer cancel()

	var s *session
	for try := 0; try < 2 && s == nil; try++ {
		hostID, err := host.Ensure(ctx) // never under r.mu
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "board_host_unavailable", reasonOf(err))
			return
		}
		r.mu.Lock()
		// A window without a stream could never be told of the session, and no ClientEnded would drop it.
		if !r.bridge.Known(client) {
			r.mu.Unlock()
			writeError(w, http.StatusConflict, "no_stream", "this client has no event stream open")
			return
		}
		// The host may have died between Ensure and here: register only with the current, connected host.
		if hostID != "" && hostID == r.hostID && r.bridge.Known(hostID) {
			s, _ = r.addLocked(id, client, hostID)
		}
		r.mu.Unlock()
	}
	if s == nil {
		writeError(w, http.StatusServiceUnavailable, "board_host_unavailable", "the board host stopped while the board was opened")
		return
	}
	// The board may have been archived or deleted while the host started. BoardGone is called after
	// the store changed, so a BoardGone that ran before the registration shows here.
	if b, ok := r.boards.Get(id); !ok || b.Archived || b.Kind != model.KindTL {
		r.mu.Lock()
		if r.sessions[s.id] == s {
			r.closeToHostLocked(s)
		}
		r.mu.Unlock()
		if !ok {
			writeError(w, http.StatusNotFound, "not_found", "no such board")
		} else if b.Kind != model.KindTL {
			writeError(w, http.StatusConflict, "not_tl", "this board is not a new board")
		} else {
			writeError(w, http.StatusConflict, "archived", "the board is archived")
		}
		return
	}
	writeJSON(w, map[string]string{"session": s.id})
}

type syncBody struct {
	Session  string          `json:"session"`
	Messages json.RawMessage `json:"messages"`
}

func (r *Relay) handleSync(w http.ResponseWriter, req *http.Request, client string) {
	id := req.PathValue("id")
	if _, ok := r.tlBoard(w, id); !ok {
		return
	}
	var body syncBody
	if !decodeBody(w, req, maxSyncBody, &body) {
		return
	}
	if !isArray(body.Messages) {
		writeError(w, http.StatusBadRequest, "bad_request", "messages must be an array")
		return
	}
	status, code, msg := r.relaySync(id, client, body)
	if status != http.StatusOK {
		writeError(w, status, code, msg)
		return
	}
	writeOK(w)
}

// relaySync sends a window's messages to the host of its session.
func (r *Relay) relaySync(board, client string, body syncBody) (status int, code, msg string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.sessions[body.Session]
	if s == nil || s.window != client || s.board != board {
		return http.StatusGone, "no_session", "no such session"
	}
	// A session of an older host, or of a host whose stream is gone: the window reopens.
	if s.host != r.hostID || !r.bridge.Known(s.host) ||
		!r.bridge.SendTo(s.host, syncEvent{Type: "tl_sync", Board: board, Session: s.id, Messages: body.Messages}) {
		r.closeToHostLocked(s)
		return http.StatusGone, "no_session", "the board host is gone"
	}
	return http.StatusOK, "", ""
}

func (r *Relay) handleClose(w http.ResponseWriter, req *http.Request, client string) {
	id := req.PathValue("id")
	if _, ok := r.tlBoard(w, id); !ok {
		return
	}
	var body struct {
		Session string `json:"session"`
	}
	if !decodeBody(w, req, maxSmallBody, &body) {
		return
	}
	r.mu.Lock()
	if s := r.sessions[body.Session]; s != nil && s.window == client && s.board == id {
		r.closeToHostLocked(s)
	}
	r.mu.Unlock()
	writeOK(w)
}

type outBody struct {
	Out []struct {
		Session  string          `json:"session"`
		Messages json.RawMessage `json:"messages"`
	} `json:"out"`
	Closed []struct {
		Session string `json:"session"`
		Reason  string `json:"reason"`
	} `json:"closed"`
}

// isHost reports whether client is the current board host.
func (r *Relay) isHost(client string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return client != "" && client == r.hostID
}

func notHost(w http.ResponseWriter) {
	writeError(w, http.StatusForbidden, "not_board_host", "only the board host may call this")
}

func (r *Relay) handleOut(w http.ResponseWriter, req *http.Request, client string) {
	if !r.isHost(client) {
		notHost(w)
		return
	}
	var body outBody
	if !decodeBody(w, req, maxSyncBody, &body) {
		return
	}
	for _, o := range body.Out {
		if !isArray(o.Messages) {
			writeError(w, http.StatusBadRequest, "bad_request", "messages must be an array")
			return
		}
	}
	gone, ok := r.relayOut(client, body)
	if !ok {
		notHost(w)
		return
	}
	writeJSON(w, map[string]any{"gone": gone})
}

// relayOut sends the host's messages to the sessions' windows and applies its closes. It returns the
// sessions Go no longer knows, and false when client is no longer the board host.
func (r *Relay) relayOut(client string, body outBody) ([]string, bool) {
	gone := []string{}
	r.mu.Lock()
	defer r.mu.Unlock()
	if client != r.hostID { // replaced while the body was read
		return nil, false
	}
	for _, o := range body.Out {
		s := r.sessions[o.Session]
		if s == nil || s.host != client {
			gone = append(gone, o.Session)
			continue
		}
		if !r.bridge.SendTo(s.window, syncEvent{Type: "tl_sync", Board: s.board, Session: s.id, Messages: o.Messages}) {
			// The window's stream is gone (its ClientEnded comes too): Go forgets the session, the host closes it.
			delete(r.sessions, s.id)
			gone = append(gone, o.Session)
		}
	}
	for _, c := range body.Closed {
		if s := r.sessions[c.Session]; s != nil && s.host == client {
			r.closeToWindowLocked(s, c.Reason)
		}
	}
	return gone, true
}

func (r *Relay) handleSnapshotGet(w http.ResponseWriter, req *http.Request, client string) {
	if !r.isHost(client) {
		notHost(w)
		return
	}
	id := req.PathValue("id")
	if _, ok := r.tlBoard(w, id); !ok {
		return
	}
	data, ok, err := r.boards.SnapshotAt(id)
	if err != nil {
		r.logf("tl: snapshot of %s could not be read: %v", id, err)
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if !ok {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

func (r *Relay) handleSnapshotPut(w http.ResponseWriter, req *http.Request, client string) {
	if !r.isHost(client) {
		notHost(w)
		return
	}
	id := req.PathValue("id")
	if _, ok := r.tlBoard(w, id); !ok { // an archived board is allowed: a last save may come after the archive
		return
	}
	body, ok := readBody(w, req, maxSnapshotBody)
	if !ok {
		return
	}
	if !json.Valid(body) {
		writeError(w, http.StatusBadRequest, "bad_json", "the snapshot is not valid JSON")
		return
	}
	if err := r.boards.SaveSnapshot(id, body); err != nil {
		r.logf("tl: snapshot of %s could not be saved: %v", id, err)
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeOK(w)
}
