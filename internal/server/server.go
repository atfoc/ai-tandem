// Package server is the HTTP API: the client API on the client listener, the MCP listener's
// handler and the control socket's. Handlers are thin: decode, call App / Chats / Boards / Relay /
// Bridge, encode, and map errors to statuses.
package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/app"
	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/usable"
)

type Server struct {
	App    *app.App
	Relay  *boardapi.Relay
	Bridge *editorbridge.Bridge

	// MCP listener identity for the control socket's /status. MCPPort/MCPURL are zero when this
	// server has no MCP listener; MCPUp reports whether it is serving (nil = down).
	MCPPort int
	MCPURL  string
	MCPUp   func() bool
	// InstanceID is this installation's id, given in hello ("" = left out). Clients is the client
	// listener (see clients.go); nil only in tests of the routes, which then serve nothing.
	InstanceID string
	Clients    *ClientListener
	// Usage returns an agent's plan usage limits (agent.UsageCache.Get); a missing agent = not available.
	Usage map[model.AgentKind]func(fresh bool) (model.PlanUsage, error)

	// beforeTake is a test's hook: the take route calls it with the board's id between its check
	// of the board and the grant. nil outside tests.
	beforeTake func(board string)
}

// ---- helpers --------------------------------------------------------------

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return false
	}
	return true
}

// rpcReplyMax is the largest body of a client's answer to a tool call. A picture is at most
// boardapi's 24 MB of base64 inside it; boardapi checks that once the body is read, so this keeps
// a body from being read without end.
const rpcReplyMax = 32 << 20

// readRPCReply reads the body of POST /api/rpc-reply, at most rpcReplyMax. A larger one is
// refused with 413, and the call it answers (its id read from the start of the body) is failed
// with the size, so that the agent hears it and does not wait out the call's timeout.
func (s *Server) readRPCReply(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, rpcReplyMax))
	var tooBig *http.MaxBytesError
	switch {
	case errors.As(err, &tooBig):
		msg := fmt.Sprintf("the answer is larger than %d MB; ask for a smaller scope or scale", rpcReplyMax>>20)
		s.failRPC(r, idAtStart(body), msg)
		writeError(w, http.StatusRequestEntityTooLarge, msg)
		return nil, false
	case err != nil:
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, false
	}
	return body, true
}

// idAtStart is the top-level "id" of the JSON object that begins head, "" if it is not in there.
// head may end in the middle of a value.
func idAtStart(head []byte) string {
	dec := json.NewDecoder(bytes.NewReader(head))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return ""
	}
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return ""
		}
		if key == "id" {
			var id string
			if dec.Decode(&id) != nil {
				return ""
			}
			return id
		}
		var skip json.RawMessage
		if dec.Decode(&skip) != nil {
			return ""
		}
	}
	return ""
}

// failRPC answers the tool call rpcID of the client with an error, as the client would have. The
// client is the request's.
func (s *Server) failRPC(r *http.Request, rpcID, msg string) {
	if rpcID == "" {
		return
	}
	s.Bridge.ReplyFrom(r.Header.Get(ClientHeader), rpcID, editorbridge.RPCReply{Error: msg})
}

// readOptionalJSON is readJSON for a body that may be empty.
func readOptionalJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, err.Error())
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) { writeErrorCode(w, status, msg, "") }

// writeErrorCode is writeError with the refusal's code (see codeOf); "" leaves it out.
func writeErrorCode(w http.ResponseWriter, status int, msg, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body := map[string]string{"error": msg}
	if code != "" {
		body["code"] = code
	}
	json.NewEncoder(w).Encode(body)
}

func ok(w http.ResponseWriter) { writeJSON(w, map[string]any{"ok": true}) }

// statusOf maps an error to its status: not found → 404; a model or effort that can't be chosen
// → 400; archived, locked, folder missing, busy, a context window too small → 409; file system and process errors → 500; anything else → fallback (400 where the
// call validates the request's input, 500 where it does not).
func statusOf(err error, fallback int) int {
	switch {
	case errors.Is(err, boards.ErrNotFound), errors.Is(err, chats.ErrNotFound),
		errors.Is(err, chats.ErrNoSubagent), errors.Is(err, chats.ErrNoBranch), errors.Is(err, app.ErrGroupNotFound),
		errors.Is(err, chats.ErrNoImage):
		return http.StatusNotFound
	case errors.Is(err, chats.ErrImageTooLarge):
		return http.StatusRequestEntityTooLarge
	case errors.Is(err, chats.ErrImageType):
		return http.StatusUnsupportedMediaType
	case errors.Is(err, chats.ErrBadReference), errors.Is(err, chats.ErrBadLabel), errors.Is(err, chats.ErrBadPoint),
		errors.Is(err, chats.ErrBadChoice), errors.Is(err, chats.ErrBadID),
		errors.Is(err, chats.ErrSubRange),
		errors.Is(err, chats.ErrImageID), errors.Is(err, chats.ErrImageLimit), errors.Is(err, chats.ErrImageModel):
		return http.StatusBadRequest
	case errors.Is(err, boards.ErrArchived), errors.Is(err, chats.ErrArchived),
		errors.Is(err, chats.ErrLegacy), errors.Is(err, chats.ErrLocked), errors.Is(err, agent.ErrFolderMissing),
		errors.Is(err, chats.ErrBusy), errors.Is(err, chats.ErrNotStarted), errors.Is(err, app.ErrGroupArchived),
		errors.Is(err, chats.ErrWindow),
		errors.Is(err, usable.ErrMissing), errors.Is(err, usable.ErrNone), errors.Is(err, chats.ErrAgentFixed), errors.Is(err, chats.ErrIDTaken),
		errors.Is(err, chats.ErrSubFixed),
		errors.Is(err, chats.ErrImageCap), errors.Is(err, chats.ErrImageMissing):
		return http.StatusConflict
	case errors.Is(err, chats.ErrChatCap), errors.Is(err, chats.ErrAppCap):
		// Not 409: a client takes a 409 on a message as "stale, wait for the turn's end".
		return http.StatusTooManyRequests
	}
	var pe *fs.PathError
	var le *os.LinkError
	var se *os.SyscallError
	var ee *exec.ExitError
	var xe *exec.Error
	if errors.As(err, &pe) || errors.As(err, &le) || errors.As(err, &se) || errors.As(err, &ee) || errors.As(err, &xe) {
		return http.StatusInternalServerError
	}
	return fallback
}

// codeOf is the "code" of a refusal a client tells apart from the others with the same status:
// "busy", "cap", "bad_point", "window", "agent_missing" and "no_agent"; the ones about images
// (images.go): "image_too_large", "image_type", "image_cap", "image_id", "image_missing",
// "image_limit" and "image_model"; and "not_found" for a chat, a board or a group that is not
// there, which tells "the thing the call names is gone" from a part of it that is missing (a
// branch, a subagent, an image: other codes, or none). Every other error has none.
func codeOf(err error) string {
	switch {
	case errors.Is(err, chats.ErrImageTooLarge):
		return "image_too_large"
	case errors.Is(err, chats.ErrImageType):
		return "image_type"
	case errors.Is(err, chats.ErrImageCap):
		return "image_cap"
	case errors.Is(err, chats.ErrImageID):
		return "image_id"
	case errors.Is(err, chats.ErrImageMissing):
		return "image_missing"
	case errors.Is(err, chats.ErrImageLimit):
		return "image_limit"
	case errors.Is(err, chats.ErrImageModel):
		return "image_model"
	case errors.Is(err, chats.ErrBusy):
		return "busy"
	case errors.Is(err, chats.ErrChatCap), errors.Is(err, chats.ErrAppCap):
		return "cap"
	case errors.Is(err, chats.ErrBadPoint):
		return "bad_point"
	case errors.Is(err, chats.ErrWindow):
		return "window"
	case errors.Is(err, usable.ErrMissing):
		return "agent_missing"
	case errors.Is(err, usable.ErrNone):
		return "no_agent"
	case errors.Is(err, chats.ErrNotFound), errors.Is(err, boards.ErrNotFound), errors.Is(err, app.ErrGroupNotFound):
		return "not_found"
	}
	return ""
}

// fail writes err with the status statusOf gives it and the code codeOf gives it. A message
// refused for images the chat does not hold names them, as "images".
func fail(w http.ResponseWriter, err error, fallback int) {
	var missing *chats.MissingImages
	if errors.As(err, &missing) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(statusOf(err, fallback))
		json.NewEncoder(w).Encode(map[string]any{"error": err.Error(), "code": codeOf(err), "images": missing.IDs})
		return
	}
	writeErrorCode(w, statusOf(err, fallback), err.Error(), codeOf(err))
}

// replaceRefused answers a draft call with ?replace=, and reports that it did: no draft is
// replaced whatever its counter is. A draft is saved on the counter it was typed on, and nothing
// is stored for this call.
func replaceRefused(w http.ResponseWriter, r *http.Request) bool {
	if !r.URL.Query().Has("replace") {
		return false
	}
	writeErrorCode(w, http.StatusBadRequest, "a draft is not replaced: save it on the counter it was typed on", "replace_refused")
	return true
}

// failDraft is fail for a draft call: a branch the chat does not have has a code of its own
// there, "no_branch", which tells it from a chat that is not there.
func failDraft(w http.ResponseWriter, err error) {
	if errors.Is(err, chats.ErrNoBranch) {
		writeErrorCode(w, statusOf(err, http.StatusInternalServerError), err.Error(), "no_branch")
		return
	}
	fail(w, err, http.StatusInternalServerError)
}

// follow notes that the request's client follows it; unfollow ends a follow.
func (s *Server) follow(r *http.Request, it editorbridge.Item) bool {
	return s.Bridge.Follow(r.Header.Get(ClientHeader), it)
}

func (s *Server) unfollow(r *http.Request, it editorbridge.Item) {
	s.Bridge.Unfollow(r.Header.Get(ClientHeader), it)
}

// unfollowMissing ends the follow a read of the chat {id} noted before it read, when err says
// there is no such chat: nothing would ever end the follow of a chat that is not there.
func (s *Server) unfollowMissing(r *http.Request, err error) {
	if errors.Is(err, chats.ErrNotFound) {
		s.unfollow(r, editorbridge.Chat(r.PathValue("id")))
	}
}

// branchOf is the branch a session call is for: ?branch=<branch id>, "main" for main; without it
// "", the chat's current branch.
func branchOf(r *http.Request) string { return r.URL.Query().Get("branch") }

// checkGroup rejects "" (the ungrouped area is "__ungrouped__").
func checkGroup(w http.ResponseWriter, group string) bool {
	if group == "" {
		writeError(w, http.StatusBadRequest, `group is empty (use "`+model.Ungrouped+`" for ungrouped)`)
		return false
	}
	return true
}

// expandDir resolves ~ and relative paths and checks the result is a directory (prototype).
func expandDir(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, _ := os.UserHomeDir()
		p = filepath.Join(home, strings.TrimPrefix(p, "~"))
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	if st, err := os.Stat(abs); err != nil || !st.IsDir() {
		return "", fmt.Errorf("%s is not a directory", abs)
	}
	return abs, nil
}

// ---- routes ---------------------------------------------------------------

// MCPHandler is the handler of the second, MCP-only listener: it serves exactly POST /mcp,
// guarded by the loopback Host check for mcpPort. The credential travels in the Authorization
// header and no CORS headers are added. This listener serves no /api/* routes.
func (s *Server) MCPHandler(mcpPort int) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /mcp", s.Relay.ServeFixedMCP)
	return guard(mcpPort, mux)
}

// routes builds the mux of the client API, without the checks ClientHandler puts in front of it.
// Every route of it is a row of ClientRoutes, and the other way round.
func (s *Server) routes() *routeMux {
	mux := newRouteMux()
	a := s.App

	// ---- client and events ----
	mux.HandleFunc("GET /api/hello", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, s.hello())
	})
	mux.HandleFunc("GET /api/events", s.apiEvents)
	// The client of each call below is the one of its X-AIWB-Client header, which ClientHandler
	// has checked: a "client" in a body is ignored.
	//
	// The client's answer to server_stopping: its pending saves are written.
	mux.HandleFunc("POST /api/client/flushed", func(w http.ResponseWriter, r *http.Request) {
		s.Bridge.FlushedBy(r.Header.Get(ClientHeader))
		ok(w)
	})
	// The answer to an rpc event, taken only from the client that was asked.
	mux.HandleFunc("POST /api/rpc-reply", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID string `json:"id"`
			editorbridge.RPCReply
		}
		raw, read := s.readRPCReply(w, r)
		if !read {
			return
		}
		if err := json.NewDecoder(bytes.NewReader(raw)).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if !s.Bridge.ReplyFrom(r.Header.Get(ClientHeader), body.ID, body.RPCReply) {
			writeError(w, http.StatusConflict, "not_asked")
			return
		}
		ok(w)
	})
	// Takes the board for the client. "held" with the scene's revision: the board was free or the
	// client's already. "waiting": another client holds it and was asked to release; a held event
	// follows. With {"ifFree": true} a board held elsewhere is left there: "busy".
	mux.HandleFunc("POST /api/boards/{id}/take", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ IfFree bool }
		if !readOptionalJSON(w, r, &body) {
			return
		}
		id := r.PathValue("id")
		bd, found := a.Boards.Get(id)
		if !found {
			fail(w, boards.ErrNotFound, http.StatusInternalServerError)
			return
		}
		if bd.Archived {
			fail(w, boards.ErrArchived, http.StatusInternalServerError)
			return
		}
		if s.beforeTake != nil {
			s.beforeTake(id)
		}
		state, rev, err := s.Bridge.TakeBoard(r.Header.Get(ClientHeader), id, body.IfFree)
		if err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		if state == "held" {
			// An archive or a delete that ran between the check above and the grant found no
			// holder to ask: the board is read again, and a hold of one that is gone or archived
			// is given back.
			bd, found := a.Boards.Get(id)
			if !found || bd.Archived {
				s.Bridge.ReleaseBoard(r.Header.Get(ClientHeader), id)
				if !found {
					fail(w, boards.ErrNotFound, http.StatusInternalServerError)
				} else {
					fail(w, boards.ErrArchived, http.StatusInternalServerError)
				}
				return
			}
			writeJSON(w, map[string]any{"state": state, "rev": rev})
			return
		}
		writeJSON(w, map[string]any{"state": state})
	})
	// Ends the client's hold: "handed" (to the client that waited for the board), "free", or
	// "none" (the client did not hold it). With {"ifIdle": true}, a board nobody waits for, on
	// which the client has a board call open, is kept: "kept", and nothing changes.
	mux.HandleFunc("POST /api/boards/{id}/release", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			IfIdle bool `json:"ifIdle"`
		}
		if !readOptionalJSON(w, r, &body) {
			return
		}
		writeJSON(w, map[string]any{"state": s.Bridge.ReleaseBoardIf(r.Header.Get(ClientHeader), r.PathValue("id"), body.IfIdle)})
	})
	// The client follows the board from now on: its scene and writer events reach it. The answer
	// is the stored revision and the writer ("window", "headless" or ""), so that the client need
	// not wait for an event to know them. A board followed again stays so; an archived one may be
	// followed.
	mux.HandleFunc("POST /api/boards/{id}/follow", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if _, found := a.Boards.Get(id); !found {
			fail(w, boards.ErrNotFound, http.StatusInternalServerError)
			return
		}
		rev, writer, followed := s.Bridge.FollowBoard(r.Header.Get(ClientHeader), id)
		if !followed { // no open stream: nothing to follow with, the answer is the same
			rev, writer = a.Boards.Rev(id), s.Bridge.WriterOf(id)
		}
		writeJSON(w, map[string]any{"rev": rev, "writer": writer})
	})
	// Ends the follow of a board; a board that was not followed is no error.
	mux.HandleFunc("POST /api/boards/{id}/unfollow", func(w http.ResponseWriter, r *http.Request) {
		s.unfollow(r, editorbridge.Board(r.PathValue("id")))
		ok(w)
	})
	// Ends the events of a chat that a read started for the client (see the reads).
	mux.HandleFunc("POST /api/chats/{id}/unfollow", func(w http.ResponseWriter, r *http.Request) {
		s.unfollow(r, editorbridge.Chat(r.PathValue("id")))
		ok(w)
	})
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, a.APISnapshot())
	})

	s.libraryRoutes(mux)

	// ---- groups ----
	mux.HandleFunc("POST /api/groups", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Name, Parent string }
		if !readJSON(w, r, &body) {
			return
		}
		g, err := a.CreateGroup(body.Name, body.Parent)
		if err != nil {
			fail(w, err, http.StatusBadRequest)
			return
		}
		writeJSON(w, g)
	})
	mux.HandleFunc("POST /api/groups/{id}/move", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Parent, Before string }
		if !readJSON(w, r, &body) {
			return
		}
		if err := a.MoveGroup(r.PathValue("id"), body.Parent, body.Before); err != nil {
			fail(w, err, http.StatusBadRequest)
			return
		}
		ok(w)
	})
	// A body with "collapsed" is refused (400, "collapsed_refused").
	mux.HandleFunc("PATCH /api/groups/{id}", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Name *string }
		if collapsedRefused(w, r) {
			return
		}
		if !readJSON(w, r, &body) {
			return
		}
		if err := a.UpdateGroup(r.PathValue("id"), body.Name); err != nil {
			fail(w, err, http.StatusBadRequest)
			return
		}
		ok(w)
	})
	mux.HandleFunc("DELETE /api/groups/{id}", func(w http.ResponseWriter, r *http.Request) {
		var del bool
		switch r.URL.Query().Get("contents") {
		case "delete":
			del = true
		case "keep":
		default:
			writeError(w, http.StatusBadRequest, "contents must be delete or keep")
			return
		}
		if err := a.DeleteGroup(r.PathValue("id"), del); err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		ok(w)
	})

	// archive / unarchive for every kind
	for _, k := range []struct {
		path string
		kind app.Kind
	}{{"groups", app.KindGroup}, {"boards", app.KindBoard}, {"chats", app.KindChat}} {
		mux.HandleFunc("POST /api/"+k.path+"/{id}/archive", func(w http.ResponseWriter, r *http.Request) {
			if err := a.Archive(k.kind, r.PathValue("id")); err != nil {
				fail(w, err, http.StatusInternalServerError)
				return
			}
			ok(w)
		})
		mux.HandleFunc("POST /api/"+k.path+"/{id}/unarchive", func(w http.ResponseWriter, r *http.Request) {
			if err := a.Unarchive(k.kind, r.PathValue("id")); err != nil {
				fail(w, err, http.StatusInternalServerError)
				return
			}
			ok(w)
		})
	}

	// ---- boards ----
	// A body with "server" is refused (400, "server_refused").
	mux.HandleFunc("POST /api/boards", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name  string
			Group string
			New   bool
		}
		if apiServerRefused(w, r) {
			return
		}
		if !readJSON(w, r, &body) || !checkGroup(w, body.Group) {
			return
		}
		bd, err := a.Boards.Create(body.Name, body.Group, body.New)
		if err != nil {
			fail(w, err, http.StatusBadRequest)
			return
		}
		s.Bridge.TakeBoard(r.Header.Get(ClientHeader), bd.ID, true) // the client that creates a board holds it
		writeJSON(w, bd)
	})
	// The drawing, with its revision in the header SceneRevHeader.
	mux.HandleFunc("GET /api/boards/{id}/scene", func(w http.ResponseWriter, r *http.Request) {
		b, rev, err := a.Boards.SceneAt(r.PathValue("id"))
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set(SceneRevHeader, strconv.FormatInt(rev, 10))
		w.Write(b)
	})
	// Writes the drawing. Only the client that holds the board may (code "not_holder"), and ?rev=
	// names the revision the drawing is based on, the one of its read or of its last accepted
	// write: on another one nothing is written (code "stale", with the stored revision).
	mux.HandleFunc("PUT /api/boards/{id}/scene", func(w http.ResponseWriter, r *http.Request) {
		b, fits := readScene(w, r)
		if !fits {
			return
		}
		id := r.PathValue("id")
		holder, held := s.Bridge.HolderOf(id)
		if held && holder != r.Header.Get(ClientHeader) {
			writeErrorCode(w, http.StatusConflict, "another window holds this board", "not_holder")
			return
		}
		if !r.URL.Query().Has("rev") {
			writeError(w, http.StatusBadRequest, "rev is missing")
			return
		}
		base, err := strconv.ParseInt(r.URL.Query().Get("rev"), 10, 64)
		if err != nil || base < 0 {
			writeError(w, http.StatusBadRequest, "rev is not a number")
			return
		}
		// Nobody holds the board. One that is unknown or archived is refused as that below.
		if bd, found := a.Boards.Get(id); !held && found && !bd.Archived {
			writeErrorCode(w, http.StatusConflict, "this window does not hold the board", "not_holder")
			return
		}
		rev, err := a.Boards.SaveAt(id, base, b)
		var stale boards.StaleError
		if errors.As(err, &stale) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(map[string]any{"error": err.Error(), "code": "stale", "rev": stale.Rev})
			return
		}
		if err != nil {
			fail(w, err, http.StatusBadRequest)
			return
		}
		// The board may have gone to another client since the check above, with a grant that
		// named the revision before this write: that holder is told the new one.
		s.Bridge.Regrant(id, r.Header.Get(ClientHeader))
		// The followers read the scene when they like: the event names the revision only.
		s.Bridge.SendBoard(id, map[string]any{"type": "scene", "board": id, "rev": rev})
		writeJSON(w, map[string]any{"ok": true, "rev": rev})
	})
	mux.HandleFunc("POST /api/boards/{id}/rename", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Name string }
		if !readJSON(w, r, &body) {
			return
		}
		bd, err := a.Boards.Rename(r.PathValue("id"), body.Name)
		if err != nil {
			fail(w, err, http.StatusBadRequest)
			return
		}
		writeJSON(w, bd)
	})
	mux.HandleFunc("PATCH /api/boards/{id}", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Group string }
		if !readJSON(w, r, &body) || !checkGroup(w, body.Group) {
			return
		}
		if err := a.MoveBoard(r.PathValue("id"), body.Group); err != nil {
			fail(w, err, http.StatusBadRequest)
			return
		}
		ok(w)
	})
	mux.HandleFunc("POST /api/boards/{id}/seen", func(w http.ResponseWriter, r *http.Request) {
		if err := a.Boards.Seen(r.PathValue("id")); err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		ok(w)
	})
	mux.HandleFunc("DELETE /api/boards/{id}", func(w http.ResponseWriter, r *http.Request) {
		if noRecord(w, r) {
			return
		}
		if err := a.DeleteBoard(r.PathValue("id")); err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		ok(w)
	})
	// ---- chats ----
	// A new chat in a group or on a board. The chat is this server's: a body with "server",
	// whatever its value, is refused (400 "server_refused") and nothing is made, and the first
	// message is the message call.
	mux.HandleFunc("POST /api/chats", func(w http.ResponseWriter, r *http.Request) {
		if apiServerRefused(w, r) {
			return
		}
		var body struct {
			ID    string
			Agent model.AgentKind
			Group string
			Board string
		}
		if !readJSON(w, r, &body) {
			return
		}
		if body.Board == "" && !checkGroup(w, body.Group) {
			return
		}
		cv, err := a.Chats.CreateChat(chats.NewChat{ID: body.ID, Agent: body.Agent, Group: body.Group, Board: body.Board})
		if err != nil {
			fail(w, err, http.StatusBadRequest)
			return
		}
		writeJSON(w, cv)
	})
	mux.HandleFunc("GET /api/chats/{id}", func(w http.ResponseWriter, r *http.Request) {
		cv, err := a.Chats.View(r.PathValue("id"))
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, cv)
	})
	// The thread of one branch of the chat: ?branch=<branch id>, without it the current branch.
	// "branch" in the answer is the branch served, "state" its state record as of these items. The
	// read also starts the chat's content events to the client: the follow comes first, so no
	// change between the two is lost.
	mux.HandleFunc("GET /api/chats/{id}/items", func(w http.ResponseWriter, r *http.Request) {
		s.follow(r, editorbridge.Chat(r.PathValue("id")))
		t, err := a.Chats.ThreadOf(r.PathValue("id"), branchOf(r))
		if err != nil {
			s.unfollowMissing(r, err)
			fail(w, err, http.StatusInternalServerError)
			return
		}
		if t.Items == nil {
			t.Items = []model.Item{}
		}
		if t.Subagents == nil {
			t.Subagents = []model.Subagent{}
		}
		writeJSON(w, map[string]any{"branch": t.Branch, "version": t.Version, "items": t.Items, "subagents": t.Subagents, "state": t.State})
	})
	mux.HandleFunc("GET /api/chats/{id}/subagents/{sid}/items", func(w http.ResponseWriter, r *http.Request) {
		s.follow(r, editorbridge.Chat(r.PathValue("id")))
		v, items, err := a.Chats.SubItemsOf(r.PathValue("id"), branchOf(r), r.PathValue("sid"))
		if err != nil {
			s.unfollowMissing(r, err) // a missing subagent of a chat that exists keeps the follow
			fail(w, err, http.StatusInternalServerError)
			return
		}
		if items == nil {
			items = []model.Item{}
		}
		writeJSON(w, map[string]any{"version": v, "items": items})
	})
	// What fills the context window of one branch of the chat (?branch=), by category. ?fresh=1
	// asks the agent even when the kept split is current.
	mux.HandleFunc("GET /api/chats/{id}/context", func(w http.ResponseWriter, r *http.Request) {
		split, err := a.Chats.ContextSplitOf(r.PathValue("id"), branchOf(r), r.URL.Query().Get("fresh") == "1")
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, split)
	})
	// The chat's whole tree: every branch's messages and replies, and the labels. It reads the
	// branches' files and loads nothing.
	mux.HandleFunc("GET /api/chats/{id}/tree", func(w http.ResponseWriter, r *http.Request) {
		s.follow(r, editorbridge.Chat(r.PathValue("id")))
		tv, err := a.Chats.Tree(r.PathValue("id"))
		if err != nil {
			s.unfollowMissing(r, err)
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, tv)
	})
	// Names a message or a reply; blank text removes the name. Answers all the chat's labels.
	mux.HandleFunc("PUT /api/chats/{id}/label", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Branch string
			Item   *int
			Text   string
		}
		if !readJSON(w, r, &body) {
			return
		}
		if body.Item == nil {
			writeError(w, http.StatusBadRequest, "item is missing")
			return
		}
		labels, err := a.Chats.SetLabel(r.PathValue("id"), body.Branch, *body.Item, body.Text)
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"labels": labels})
	})
	// Makes a new chat holding a branch's first "at" items, in a session forked there, on the
	// branch's model and effort unless "model" or "effort" name others. With
	// "message", that user message is left out and becomes the new chat's draft (Fork and edit).
	mux.HandleFunc("POST /api/chats/{id}/fork", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Branch  string
			At      *int
			Message *int
			Model   string
			Effort  string
		}
		if !readJSON(w, r, &body) {
			return
		}
		if body.At == nil {
			writeError(w, http.StatusBadRequest, "at is missing")
			return
		}
		v, err := a.Chats.Fork(r.PathValue("id"), chats.ForkReq{Branch: body.Branch, At: *body.At, Message: body.Message, Model: body.Model, Effort: body.Effort})
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, v)
	})
	mux.HandleFunc("POST /api/chats/{id}/open", func(w http.ResponseWriter, r *http.Request) {
		if err := a.Chats.OpenOf(r.PathValue("id"), branchOf(r)); err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		ok(w)
	})
	// Sends a message on the chat's current branch. With ?branch= it goes to the end of that branch,
	// whatever its length, and the branch becomes the current one. With "target" it goes to a point
	// of one of the chat's branches instead: that branch is carried on, or a new branch starts
	// there. A target names its point: without "at" it is refused, and so is one with ?branch=.
	// A target that starts a new branch may name its "model" and "effort"; one that carries a
	// branch on may not (409).
	// Busy (409) is the branch's the message goes to; the chat's other branches may be working.
	// The answer names the branch the message was put on: {"ok":true,"branch":"<branch id>"},
	// "main" for main, the new id for a new branch, and without ?branch= and "target" the branch
	// that was current when the message was sent.
	// The first message of a chat a client made is this same call: the agent starts here.
	// "images" are the images the message carries, as a draft holds them; only "id" and "name"
	// are looked at. A message is refused, and nothing is left of it, for an id of the wrong form
	// (400 "image_id"), for images the chat does not hold (409 "image_missing", which names them
	// in "images"), for more images or more bytes than a message takes (400 "image_limit") and
	// for a model that takes no images (400 "image_model": the target's model when it names one).
	mux.HandleFunc("POST /api/chats/{id}/messages", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Text, Context string
			References    []model.Reference
			Images        []model.Image
			Target        *struct {
				Branch string
				At     *int
				New    bool
				Model  string
				Effort string
			}
		}
		if !readJSON(w, r, &body) {
			return
		}
		if body.Target != nil && body.Target.At == nil {
			writeError(w, http.StatusBadRequest, "at is missing")
			return
		}
		branch := branchOf(r)
		if body.Target != nil && branch != "" {
			writeError(w, http.StatusBadRequest, "branch and target together")
			return
		}
		msg := chats.Message{Text: body.Text, Context: body.Context, References: body.References, Images: body.Images}
		var to *chats.Target // nil: the chat's current branch
		if tg := body.Target; tg != nil {
			to = &chats.Target{Branch: tg.Branch, At: *tg.At, New: tg.New, Model: tg.Model, Effort: tg.Effort}
		} else if branch != "" {
			to = &chats.Target{Branch: branch, End: true}
		}
		on, err := a.Chats.SendMessage(r.PathValue("id"), to, msg) // on: the branch the message was put on
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"ok": true, "branch": on})
	})
	// Saves the draft of one branch (?branch=, without it the current one); an empty draft is
	// none. rev is the counter of the draft this one was typed on (ChatView.DraftRev,
	// BranchState.DraftRev; 0 when there is none yet): a save on an older one is refused (409,
	// "stale", with the stored counter and draft). A branch the chat does not have is 404,
	// "no_branch". Whichever client saves, they save into one draft, and the counter decides.
	//
	// With ?replace= the call is refused (400 "replace_refused") and nothing is stored.
	mux.HandleFunc("PUT /api/chats/{id}/draft", func(w http.ResponseWriter, r *http.Request) {
		if replaceRefused(w, r) {
			return
		}
		var body model.Draft
		if !readJSON(w, r, &body) {
			return
		}
		base, err := strconv.ParseInt(r.URL.Query().Get("rev"), 10, 64)
		if !r.URL.Query().Has("rev") {
			writeError(w, http.StatusBadRequest, "rev is missing")
			return
		}
		if err != nil || base < 0 {
			writeError(w, http.StatusBadRequest, "rev is not a number")
			return
		}
		// The draft may have "images": only "id" and "name" of each are looked at. One the chat
		// does not hold is left out of the draft, and "missing" names those left out.
		rev, stored, missing, err := a.Chats.SaveDraft(r.PathValue("id"), branchOf(r), base, body)
		if errors.Is(err, chats.ErrStaleDraft) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(map[string]any{"error": err.Error(), "code": "stale", "rev": rev, "draft": stored})
			return
		}
		if err != nil {
			failDraft(w, err)
			return
		}
		out := map[string]any{"ok": true, "rev": rev}
		if len(missing) > 0 {
			out["missing"] = missing
		}
		writeJSON(w, out)
	})
	s.imageRoutes(mux)
	// "name" and "group" are the chat's; "agent", "model", "effort" and "cwd" go to one
	// branch (?branch=), as do "subDepth" (0 to 3, 0 = no subagents) and "subCap" (1 to 100), the
	// subagent settings: a number, absent = unchanged, a chat's that has not started and is neither
	// a fork nor a branch (409 otherwise), and refused outside the range (400).
	// The answer holds the chat as it is after the change. A body with "server", whatever its
	// value, is refused (400, "server_refused") before anything is written: a chat's server is
	// the one it was made on.
	mux.HandleFunc("PATCH /api/chats/{id}", func(w http.ResponseWriter, r *http.Request) {
		if apiServerRefused(w, r) {
			return
		}
		var body struct {
			Name               *string
			Group              *string
			Agent              model.AgentKind
			Model, Effort, Cwd string
			SubDepth, SubCap   *int
		}
		if !readJSON(w, r, &body) {
			return
		}
		if body.Group != nil && !checkGroup(w, *body.Group) {
			return
		}
		id := r.PathValue("id")
		if body.Name != nil {
			if err := a.Chats.Rename(id, *body.Name, true); err != nil {
				fail(w, err, http.StatusBadRequest)
				return
			}
		}
		if body.Group != nil {
			if err := a.MoveChat(id, *body.Group); err != nil {
				fail(w, err, http.StatusBadRequest)
				return
			}
		}
		if body.Agent != "" || body.Model != "" || body.Effort != "" || body.Cwd != "" || body.SubDepth != nil || body.SubCap != nil {
			req := chats.ConfigReq{Agent: body.Agent, Model: body.Model, Effort: body.Effort, Cwd: body.Cwd,
				SubDepth: body.SubDepth, SubCap: body.SubCap}
			if err := a.Chats.ConfigureOf(id, branchOf(r), req); err != nil {
				// A cwd that is no folder has the code the first message's refusal has:
				// agent.ErrFolderMissing, and the chat manager's plain sentence of expandDir.
				_, here := expandDir(body.Cwd)
				if errors.Is(err, agent.ErrFolderMissing) || (body.Cwd != "" && here != nil && here.Error() == err.Error()) {
					writeErrorCode(w, statusOf(err, http.StatusBadRequest), err.Error(), "folder_missing")
					return
				}
				fail(w, err, http.StatusBadRequest)
				return
			}
		}
		cv, err := a.Chats.View(id)
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"ok": true, "chat": cv})
	})
	mux.HandleFunc("POST /api/chats/{id}/interrupt", func(w http.ResponseWriter, r *http.Request) {
		if err := a.Chats.InterruptOf(r.PathValue("id"), branchOf(r)); err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		ok(w)
	})
	mux.HandleFunc("POST /api/chats/{id}/permission", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			RequestID string `json:"requestId"`
			Subagent  string `json:"subagent"` // who asked, as the card says; none = the chat's own agent
			Allow     bool   `json:"allow"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		if err := a.Chats.DecideOf(r.PathValue("id"), branchOf(r), body.Subagent, body.RequestID, body.Allow); err != nil {
			fail(w, err, http.StatusBadRequest)
			return
		}
		ok(w)
	})
	mux.HandleFunc("DELETE /api/chats/{id}", func(w http.ResponseWriter, r *http.Request) {
		if noRecord(w, r) {
			return
		}
		if err := a.DeleteChat(r.PathValue("id")); err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		ok(w)
	})

	// Folder browser for the working-directory picker of a chat: the folders of this machine.
	mux.HandleFunc("GET /api/dirs", func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Query().Get("path")
		if p == "" {
			p = a.DefaultCwd
		}
		abs, err := expandDir(p)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		// A client does not list the app's own folder: the names there are the ids of every chat
		// and board.
		if a.Chats.Store.P.Contains(abs) {
			writeError(w, http.StatusBadRequest, chats.ErrAppFolder.Error())
			return
		}
		ents, _ := os.ReadDir(abs)
		dirs := []string{}
		for _, e := range ents {
			if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
				dirs = append(dirs, e.Name())
			}
		}
		writeJSON(w, map[string]any{"path": abs, "parent": filepath.Dir(abs), "dirs": dirs})
	})

	// An agent's plan usage limits, run on request and not stored. ?fresh=1 skips the cache.
	mux.HandleFunc("GET /api/usage/{agent}", func(w http.ResponseWriter, r *http.Request) {
		get := s.Usage[model.AgentKind(r.PathValue("agent"))]
		if get == nil {
			writeError(w, http.StatusNotFound, "usage not available")
			return
		}
		u, err := get(r.URL.Query().Get("fresh") == "1")
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, u)
	})

	return mux
}
