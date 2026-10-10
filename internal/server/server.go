// Package server is the HTTP API (the prototype main.go's handlers). Handlers are thin: decode,
// call App / Chats / Boards / Relay / Bridge, encode, and map errors to statuses.
package server

import (
	"bytes"
	"context"
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
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/app"
	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/rungit"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/usable"
)

type Server struct {
	App    *app.App
	Relay  *boardapi.Relay
	Bridge *editorbridge.Bridge
	Client string // static client folder, "" = none
	Port   int

	// Servers is the list of the remote servers this one connects to (see servers.go); nil = the
	// local entry alone, and no route to change the list.
	Servers *servers.Manager
	// Remotes holds the chats of those servers and passes a page's calls for them on (see
	// remotechat.go); nil = none: every chat is this server's.
	Remotes *remotes.Relay

	// MCP listener identity for GET /api/mcp/status. MCPPort/MCPURL are zero when this server
	// has no MCP listener; MCPUp reports whether it is serving (nil = down).
	MCPPort int
	MCPURL  string
	MCPUp   func() bool
	// InstanceID is this installation's id, given in hello ("" = left out). Remote is the remote
	// listener (see remote.go); nil = remote access is off.
	InstanceID string
	Remote     *Remote
	// Usage returns an agent's plan usage limits (agent.UsageCache.Get); a missing agent = not available.
	Usage map[model.AgentKind]func(fresh bool) (model.PlanUsage, error)
	// Restart starts `relaunch` of this program detached, for POST /api/restart; it must not stop
	// this server itself. An error wrapping ErrBinaryMissing means the program is gone (the app was
	// moved or deleted). nil = restart not available.
	Restart func() error

	// beforeTake is a test's hook: the take route calls it with the board's id between its check
	// of the board and the grant. nil outside tests.
	beforeTake func(board string)
	// awaitLimit is awaitStartLimit for this server; 0 = awaitStartLimit. Shorter in a test.
	awaitLimit time.Duration
}

// ErrBinaryMissing is what Restart reports when this server's program is no longer on disk.
var ErrBinaryMissing = errors.New("binary_missing")

// webVersion is the version of the web client on disk: version.json ({"version": "<v>"}) in the
// client folder, "dev" when there is no client folder or the file is missing or unreadable.
func (s *Server) webVersion() string {
	if s.Client == "" {
		return "dev"
	}
	b, err := os.ReadFile(filepath.Join(s.Client, "version.json"))
	if err != nil {
		return "dev"
	}
	var v struct{ Version string }
	if json.Unmarshal(b, &v) != nil || v.Version == "" {
		return "dev"
	}
	return v.Version
}

// ---- helpers --------------------------------------------------------------

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return false
	}
	return true
}

// rpcReplyMax is the largest body of a page's answer to a tool call. A picture is at most
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

// failRPC answers the tool call rpcID of the client with an error, as the page would have: a
// call of this server's bridge, or one the relay passed on to a page. The client is the request's.
func (s *Server) failRPC(r *http.Request, rpcID, msg string) {
	if rpcID == "" {
		return
	}
	client := r.Header.Get(ClientHeader)
	if s.Remotes != nil && s.Remotes.IsBoardCall(rpcID) {
		body, _ := json.Marshal(map[string]string{"id": rpcID, "error": msg})
		s.Remotes.ReplyBoardCall(r.Context(), client, rpcID, body)
		return
	}
	s.Bridge.ReplyFrom(client, rpcID, editorbridge.RPCReply{Error: msg})
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

// statusOf maps an error to its status: not found → 404; a model or effort that can't be chosen,
// a server that is not in the list → 400; archived, locked, folder missing, busy, a context window
// too small, a run in a state the call does not fit, a run agent's chat, a server that cannot be
// the chat's or the draft run's → 409; a server that is not connected → 503; file system and
// process errors → 500; anything else → fallback (400 where the call validates the request's
// input, 500 where it does not).
func statusOf(err error, fallback int) int {
	var blocked *runs.BlockedError
	switch {
	case errors.Is(err, chats.ErrServerUnreachable):
		return http.StatusServiceUnavailable
	case errors.Is(err, boards.ErrNotFound), errors.Is(err, chats.ErrNotFound),
		errors.Is(err, chats.ErrNoSubagent), errors.Is(err, chats.ErrNoBranch), errors.Is(err, app.ErrGroupNotFound),
		errors.Is(err, runs.ErrNotFound), errors.Is(err, runs.ErrNoTask), errors.Is(err, runs.ErrNoAttempt),
		errors.Is(err, runs.ErrNoVersion), errors.Is(err, runs.ErrNoText), errors.Is(err, runs.ErrGroup),
		errors.Is(err, chats.ErrNoRun):
		return http.StatusNotFound
	case errors.Is(err, chats.ErrBadReference), errors.Is(err, chats.ErrBadLabel), errors.Is(err, chats.ErrBadPoint),
		errors.Is(err, chats.ErrBadChoice), errors.Is(err, chats.ErrBadID), errors.Is(err, chats.ErrServerUnknown):
		return http.StatusBadRequest
	case errors.Is(err, boards.ErrArchived), errors.Is(err, chats.ErrArchived),
		errors.Is(err, chats.ErrLegacy), errors.Is(err, chats.ErrLocked), errors.Is(err, agent.ErrFolderMissing),
		errors.Is(err, chats.ErrBusy), errors.Is(err, chats.ErrNotStarted), errors.Is(err, app.ErrGroupArchived),
		errors.Is(err, chats.ErrWindow),
		errors.Is(err, chats.ErrRunAgent), errors.Is(err, chats.ErrRunArchived),
		errors.Is(err, runs.ErrArchived), errors.Is(err, runs.ErrStarted), errors.Is(err, runs.ErrNotStarted),
		errors.Is(err, runs.ErrFinished), errors.Is(err, runs.ErrNotHalted), errors.Is(err, runs.ErrNotRunning),
		errors.Is(err, runs.ErrStopping), errors.Is(err, runs.ErrLimit), errors.Is(err, runs.ErrGroupArchived),
		errors.Is(err, runs.ErrLive),
		errors.Is(err, usable.ErrMissing), errors.Is(err, usable.ErrNone), errors.Is(err, chats.ErrAgentFixed), errors.Is(err, chats.ErrIDTaken),
		errors.Is(err, chats.ErrBoardLocal), errors.Is(err, chats.ErrServerFixed), errors.Is(err, chats.ErrServerUnusable),
		errors.Is(err, chats.ErrStartUnconfirmed), errors.Is(err, chats.ErrRemoteStart),
		errors.Is(err, chats.ErrRunNotStarted),
		errors.Is(err, runs.ErrRunsUnsupported), errors.Is(err, runs.ErrRunHasChats),
		errors.Is(err, runs.ErrStartUnconfirmed), errors.Is(err, runs.ErrRemoteStart), errors.Is(err, runs.ErrStarting),
		errors.As(err, &blocked):
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
// "busy", "cap", "bad_point", "window", "agent_missing" and "no_agent", and the ones about a
// chat's server: "board_local", "server_fixed", "server_unusable", "server_unreachable",
// "start_unconfirmed" and "remote_start"; for a draft run's server "runs_unsupported",
// "run_has_chats", the two last ones again, and "busy" while its start is being made;
// "run_not_started" for a chat on a run that has not started on its server. Every other error
// has none.
func codeOf(err error) string {
	switch {
	case errors.Is(err, chats.ErrBoardLocal):
		return "board_local"
	case errors.Is(err, chats.ErrServerFixed):
		return "server_fixed"
	case errors.Is(err, chats.ErrServerUnusable):
		return "server_unusable"
	case errors.Is(err, chats.ErrServerUnreachable):
		return "server_unreachable"
	case errors.Is(err, chats.ErrStartUnconfirmed), errors.Is(err, runs.ErrStartUnconfirmed):
		return "start_unconfirmed"
	case errors.Is(err, chats.ErrRemoteStart), errors.Is(err, runs.ErrRemoteStart):
		return "remote_start"
	case errors.Is(err, chats.ErrRunNotStarted):
		return "run_not_started"
	case errors.Is(err, runs.ErrRunsUnsupported):
		return "runs_unsupported"
	case errors.Is(err, runs.ErrRunHasChats):
		return "run_has_chats"
	case errors.Is(err, chats.ErrBusy), errors.Is(err, runs.ErrStarting):
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
	}
	return ""
}

// fail writes err with the status statusOf gives it and the code codeOf gives it. An error of a
// call to another server says itself what the page gets (remotes.Error).
func fail(w http.ResponseWriter, err error, fallback int) {
	var re *remotes.Error
	if errors.As(err, &re) {
		writeReply(w, re.Reply())
		return
	}
	writeErrorCode(w, statusOf(err, fallback), err.Error(), codeOf(err))
}

// awaitStartLimit is how long an API client's read of a chat or run waits for a creation call or
// a removal of that id that is under way. The settle read of the server that made the call waits
// 15 s on these routes and relies on the wait, so it is not shorter. A test sets a shorter one
// for its server (Server.awaitLimit).
const awaitStartLimit = 30 * time.Second

// awaitStart runs wait (an AwaitStart) and returns when it has ended, when ctx has (the caller
// gave up) or after awaitStartLimit; the read then answers what is there. wait itself goes on
// until the call it waits for ends.
func (s *Server) awaitStart(ctx context.Context, wait func()) {
	after := awaitStartLimit
	if s.awaitLimit > 0 {
		after = s.awaitLimit
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		wait()
	}()
	limit := time.NewTimer(after)
	defer limit.Stop()
	select {
	case <-done:
	case <-ctx.Done():
	case <-limit.C:
	}
}

// kindOf is the kind of the client a request states: an API client's on the remote listener, a
// page's on the loopback one.
func kindOf(r *http.Request) editorbridge.Kind {
	if fromRemote(r) {
		return editorbridge.KindAPI
	}
	return editorbridge.KindPage
}

// follow notes that the request's client follows it, when its record is of the listener's kind:
// a page's id stated on the remote listener, or an API client's on the loopback one, follows
// nothing. unfollow ends a follow under the same rule.
func (s *Server) follow(r *http.Request, it editorbridge.Item) bool {
	return s.Bridge.FollowAs(kindOf(r), r.Header.Get(ClientHeader), it)
}

func (s *Server) unfollow(r *http.Request, it editorbridge.Item) {
	s.Bridge.UnfollowAs(kindOf(r), r.Header.Get(ClientHeader), it)
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

// dirsGitWait is how long GET /api/dirs waits for git to say whether a folder is in a work tree.
// A git that has not answered by then counts as "not in a work tree". A variable so that the
// tests can wait longer on a loaded machine (TestMain); nothing else writes it.
var dirsGitWait = 5 * time.Second

// ---- routes ---------------------------------------------------------------

// mcpStatus is GET /api/mcp/status: the MCP listener identity and the last MCP contact per
// chat (chat id, client, method/tool, outcome, time). It carries no token and no board content.
type mcpStatus struct {
	Listener mcpListener        `json:"listener"`
	Chats    []boardapi.Contact `json:"chats"`
}

type mcpListener struct {
	Port int    `json:"port"`
	URL  string `json:"url"`
	Up   bool   `json:"up"`
}

// MCPHandler is the handler of the second, MCP-only listener: it serves exactly POST /mcp,
// guarded by the loopback Host check for mcpPort. The credential travels in the Authorization
// header, so no active-client check applies and no CORS headers are added. This listener serves
// no client files and no /api/* routes (plan D2/D4).
func (s *Server) MCPHandler(mcpPort int) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /mcp", s.Relay.ServeFixedMCP)
	return guard(s.Bridge, mcpPort, mux)
}

// Handler is the handler of the loopback listener: the routes of the HTTP API, with the routes
// of the chats and the runs of other servers in front of them (remoteFirst), wrapped in guard().
func (s *Server) Handler() http.Handler { return guard(s.Bridge, s.Port, s.remoteFirst(s.routes())) }

// routes builds the mux of the HTTP API, without a guard: Handler and RemoteHandler each put
// their own checks in front of it.
func (s *Server) routes() *routeMux {
	mux := newRouteMux()
	a := s.App

	// ---- client and events ----
	mux.HandleFunc("GET /api/hello", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, s.hello(r))
	})
	mux.HandleFunc("GET /api/remote/status", s.remoteStatus)
	// The server only starts `relaunch` (stop + launch) and keeps running: relaunch stops it.
	mux.HandleFunc("POST /api/restart", func(w http.ResponseWriter, r *http.Request) {
		if s.Restart == nil {
			writeError(w, http.StatusInternalServerError, "restart not available")
			return
		}
		if err := s.Restart(); err != nil {
			if errors.Is(err, ErrBinaryMissing) {
				writeError(w, http.StatusConflict, "binary_missing")
				return
			}
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	// A page's stream; on the remote listener an API client's (apiclient.go).
	mux.HandleFunc("GET /api/events", func(w http.ResponseWriter, r *http.Request) {
		if fromRemote(r) {
			s.apiEvents(w, r)
			return
		}
		s.Bridge.ServeSSE(w, r)
	})
	// The client of each call below is the one of its X-AIWB-Client header, which guard() has
	// checked: a "client" in a body is ignored.
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
		if !s.ownBoard(w, r) {
			return
		}
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
	// "none" (the client did not hold it).
	mux.HandleFunc("POST /api/boards/{id}/release", func(w http.ResponseWriter, r *http.Request) {
		if !s.ownBoard(w, r) {
			return
		}
		writeJSON(w, map[string]any{"state": s.Bridge.ReleaseBoard(r.Header.Get(ClientHeader), r.PathValue("id"))})
	})
	// Ends the events of a chat or a run that a read started for the client (see the reads).
	mux.HandleFunc("POST /api/chats/{id}/unfollow", func(w http.ResponseWriter, r *http.Request) {
		s.unfollow(r, editorbridge.Chat(r.PathValue("id")))
		ok(w)
	})
	mux.HandleFunc("POST /api/runs/{id}/unfollow", func(w http.ResponseWriter, r *http.Request) {
		s.unfollow(r, editorbridge.Run(r.PathValue("id")))
		ok(w)
	})
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		if fromRemote(r) {
			writeJSON(w, a.APISnapshot(r.Header.Get(ClientHeader)))
			return
		}
		writeJSON(w, a.Snapshot())
	})
	// Read-only MCP diagnostics. GET is exempt from the active-client check (guard.go), so this
	// is readable from the page and with curl; it exposes no token and no board content.
	mux.HandleFunc("GET /api/mcp/status", func(w http.ResponseWriter, r *http.Request) {
		up := false
		if s.MCPUp != nil {
			up = s.MCPUp()
		}
		chats := []boardapi.Contact{}
		if s.Relay != nil {
			chats = s.Relay.Contacts.Snapshot()
		}
		writeJSON(w, mcpStatus{
			Listener: mcpListener{Port: s.MCPPort, URL: s.MCPURL, Up: up},
			Chats:    chats,
		})
	})

	s.serverRoutes(mux)

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
	mux.HandleFunc("PUT /api/groups/order", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ IDs []string }
		if !readJSON(w, r, &body) {
			return
		}
		if err := a.ReorderGroups(body.IDs); err != nil {
			fail(w, err, http.StatusBadRequest)
			return
		}
		ok(w)
	})
	mux.HandleFunc("PATCH /api/groups/{id}", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name      *string
			Collapsed *bool
		}
		if !readJSON(w, r, &body) {
			return
		}
		if err := a.UpdateGroup(r.PathValue("id"), body.Name, body.Collapsed); err != nil {
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
	}{{"groups", app.KindGroup}, {"boards", app.KindBoard}, {"chats", app.KindChat}, {"runs", app.KindRun}} {
		mux.HandleFunc("POST /api/"+k.path+"/{id}/archive", func(w http.ResponseWriter, r *http.Request) {
			if k.kind == app.KindBoard && !s.ownBoard(w, r) {
				return
			}
			if err := a.Archive(k.kind, r.PathValue("id")); err != nil {
				fail(w, err, http.StatusInternalServerError)
				return
			}
			ok(w)
		})
		mux.HandleFunc("POST /api/"+k.path+"/{id}/unarchive", func(w http.ResponseWriter, r *http.Request) {
			if k.kind == app.KindBoard && !s.ownBoard(w, r) {
				return
			}
			if err := a.Unarchive(k.kind, r.PathValue("id")); err != nil {
				fail(w, err, http.StatusInternalServerError)
				return
			}
			ok(w)
		})
	}

	// ---- boards ----
	mux.HandleFunc("POST /api/boards", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name  string
			Group string
			New   bool
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
	// An API client's creation of a board with an id of its making, on the remote listener only
	// (apiboards.go).
	mux.HandleFunc("PUT /api/boards/{id}", s.apiMakeBoard)
	// The drawing, with its revision in the header SceneRevHeader.
	mux.HandleFunc("GET /api/boards/{id}/scene", func(w http.ResponseWriter, r *http.Request) {
		if !s.ownBoard(w, r) {
			return
		}
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
		if !s.ownBoard(w, r) {
			return
		}
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
		writeJSON(w, map[string]any{"ok": true, "rev": rev})
	})
	mux.HandleFunc("POST /api/boards/{id}/rename", func(w http.ResponseWriter, r *http.Request) {
		if !s.ownBoard(w, r) {
			return
		}
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
		if !s.ownBoard(w, r) {
			return
		}
		if err := a.Boards.Seen(r.PathValue("id")); err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		ok(w)
	})
	mux.HandleFunc("DELETE /api/boards/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !s.ownBoard(w, r) {
			return
		}
		if err := a.DeleteBoard(r.PathValue("id")); err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		ok(w)
	})
	mux.HandleFunc("POST /api/boards/{id}/reveal", func(w http.ResponseWriter, r *http.Request) {
		if err := a.Boards.Reveal(r.PathValue("id")); err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		ok(w)
	})

	s.runRoutes(mux)

	// ---- chats ----
	// A new chat in a group, on a board, or on a run ({agent, run}: it has no group of its own).
	// "server" is the entry of the server list it will start on; without it the place's sticky
	// server. On the remote listener it is an API client's creation call (apiclient.go).
	mux.HandleFunc("POST /api/chats", func(w http.ResponseWriter, r *http.Request) {
		if fromRemote(r) {
			s.apiStart(w, r)
			return
		}
		var body struct {
			ID     string
			Agent  model.AgentKind
			Group  string
			Board  string
			Run    string
			Server string
		}
		if !readJSON(w, r, &body) {
			return
		}
		if body.Run == "" && body.Board == "" && !checkGroup(w, body.Group) {
			return
		}
		// The id of a chat on another server is taken too: the chat manager no longer knows it.
		if body.ID != "" && s.Remotes != nil && s.Remotes.Has(body.ID) {
			fail(w, chats.ErrIDTaken, http.StatusBadRequest)
			return
		}
		cv, err := a.Chats.CreateChat(chats.NewChat{ID: body.ID, Agent: body.Agent, Group: body.Group, Board: body.Board, Run: body.Run, Server: body.Server})
		if err != nil {
			fail(w, err, http.StatusBadRequest)
			return
		}
		writeJSON(w, cv)
	})
	mux.HandleFunc("GET /api/chats/{id}", func(w http.ResponseWriter, r *http.Request) {
		// An API client reads the chat to learn what a creation call it gave up on did: the
		// answer waits for a call still under way.
		if fromRemote(r) {
			s.awaitStart(r.Context(), func() { a.Chats.AwaitStart(r.PathValue("id")) })
		}
		cv, err := a.Chats.View(r.PathValue("id"))
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, cv)
	})
	// The thread of one branch of the chat: ?branch=<branch id>, without it the current branch.
	// "branch" in the answer is the branch served, "state" its state record as of these items. For
	// the chat of a run's agent this also starts its chat events to the client: the follow comes
	// first, so no change between the two is lost.
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
		// An API client makes a chat only on a board with its mark, by a fork too (see apiStart).
		if fromRemote(r) {
			if src, err := a.Chats.View(r.PathValue("id")); err == nil && src.Board != "" && !s.marked(r, src.Board) {
				writeErrorCode(w, http.StatusBadRequest, boardRefused, "board_refused")
				return
			}
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
	// The first message of a chat that starts on another server is that server's creation call
	// (startThere): it takes the text alone, and on a board the context with it.
	mux.HandleFunc("POST /api/chats/{id}/messages", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Text, Context string
			References    []model.Reference
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
		if !fromRemote(r) && s.Remotes != nil {
			if meta, there := a.Chats.RemoteUnstarted(r.PathValue("id")); there {
				alone := body.Target == nil && branch == "" && (body.Context == "" || meta.Board != "") && len(body.References) == 0
				s.startThere(w, r, meta, body.Text, body.Context, alone)
				return
			}
		}
		var on string // the branch the message was put on
		var err error
		if tg := body.Target; tg != nil {
			on, err = a.Chats.SendToBranch(r.PathValue("id"), chats.Target{Branch: tg.Branch, At: *tg.At, New: tg.New, Model: tg.Model, Effort: tg.Effort}, body.Text, body.Context, body.References)
		} else if branch != "" {
			on, err = a.Chats.SendToBranch(r.PathValue("id"), chats.Target{Branch: branch, End: true}, body.Text, body.Context, body.References)
		} else {
			on, err = a.Chats.SendBranch(r.PathValue("id"), body.Text, body.Context, body.References)
		}
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"ok": true, "branch": on})
	})
	mux.HandleFunc("PUT /api/chats/{id}/draft", func(w http.ResponseWriter, r *http.Request) {
		var body model.Draft
		if !readJSON(w, r, &body) {
			return
		}
		// rev is the counter of the draft this one was typed on (ChatView.DraftRev,
		// BranchState.DraftRev; 0 when there is none yet): a save on an older one is refused.
		base, err := strconv.ParseInt(r.URL.Query().Get("rev"), 10, 64)
		if !r.URL.Query().Has("rev") {
			writeError(w, http.StatusBadRequest, "rev is missing")
			return
		}
		if err != nil || base < 0 {
			writeError(w, http.StatusBadRequest, "rev is not a number")
			return
		}
		rev, stored, err := a.Chats.SetDraftOf(r.PathValue("id"), branchOf(r), base, body)
		if errors.Is(err, chats.ErrStaleDraft) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(map[string]any{"error": err.Error(), "code": "stale", "rev": rev, "draft": stored})
			return
		}
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"ok": true, "rev": rev})
	})
	// "name" and "group" are the chat's; "server", "agent", "model", "effort" and "cwd" go to one
	// branch (?branch=). The answer holds the chat as it is after the change. On the remote
	// listener a body with "group" or "server" is refused (400, "group_refused", "server_refused").
	mux.HandleFunc("PATCH /api/chats/{id}", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name               *string
			Group              *string
			Server             string
			Agent              model.AgentKind
			Model, Effort, Cwd string
		}
		if !readJSON(w, r, &body) {
			return
		}
		// An API client knows no group of this server, and the server is the one it called. It
		// is refused before anything is written.
		if fromRemote(r) && body.Group != nil {
			writeErrorCode(w, http.StatusBadRequest, "an API client cannot name a group", "group_refused")
			return
		}
		if fromRemote(r) && body.Server != "" {
			writeErrorCode(w, http.StatusBadRequest, "an API client cannot name a server", "server_refused")
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
		if body.Server != "" || body.Agent != "" || body.Model != "" || body.Effort != "" || body.Cwd != "" {
			req := chats.ConfigReq{Server: body.Server, Agent: body.Agent, Model: body.Model, Effort: body.Effort, Cwd: body.Cwd}
			if err := a.Chats.ConfigureOf(id, branchOf(r), req); err != nil {
				// A cwd that is no folder has the code the first message's refusal has: on the
				// chat's server (agent.ErrFolderMissing) and on this computer, where the chat
				// manager's refusal is the plain sentence of expandDir.
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
		if err := a.DeleteChat(r.PathValue("id")); err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		ok(w)
	})

	// Folder browser for the working-directory picker of a chat and of a run. "git" says the
	// folder is inside a git work tree: what decides whether a run there works with git. With
	// ?server=<entry> the folders are that server's, as it answers; an API client asks about this
	// machine only.
	mux.HandleFunc("GET /api/dirs", func(w http.ResponseWriter, r *http.Request) {
		if entry, there := s.entryOf(r); there {
			s.onEntry(w, func(rm *remotes.Relay) remotes.Reply {
				return rm.Dirs(r.Context(), entry, r.URL.Query().Get("path"))
			})
			return
		}
		p := r.URL.Query().Get("path")
		if p == "" {
			p = a.DefaultCwd
		}
		abs, err := expandDir(p)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		// An API client does not list the app's own folder: the names there are the ids of
		// every chat, board and run. Nor the folder of the runs' checkouts, which is outside it:
		// the names there are the ids of the runs.
		if fromRemote(r) && (a.Chats.Store.P.Contains(abs) || a.Chats.Store.P.InRunWork(abs)) {
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
		ctx, cancel := context.WithTimeout(r.Context(), dirsGitWait)
		defer cancel()
		writeJSON(w, map[string]any{"path": abs, "parent": filepath.Dir(abs), "dirs": dirs, "git": rungit.IsWorkTree(ctx, abs)})
	})

	// An agent's plan usage limits, run on request and not stored. ?fresh=1 skips the cache. With
	// ?server=<entry> they are the agent's on that server, as it answers.
	mux.HandleFunc("GET /api/usage/{agent}", func(w http.ResponseWriter, r *http.Request) {
		if entry, there := s.entryOf(r); there {
			s.onEntry(w, func(rm *remotes.Relay) remotes.Reply {
				return rm.Usage(r.Context(), entry, r.PathValue("agent"), r.URL.Query().Get("fresh") == "1")
			})
			return
		}
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

	if s.Client != "" {
		mux.Handle("/", clientFiles(s.Client))
	}
	return mux
}

// ---- runs -------------------------------------------------------------------

// runRoutes adds the routes of runs: thin handlers on runs.Service, and on the app for what
// cascades (delete; archive and unarchive are in the table of every kind). A server whose app has
// no runs answers each with 404.
func (s *Server) runRoutes(mux *routeMux) {
	a := s.App
	// handle registers h, which gets the run service and the path's run id.
	handle := func(pattern string, h func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string)) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			if a.Runs == nil {
				writeError(w, http.StatusNotFound, runs.ErrNotFound.Error())
				return
			}
			h(w, r, a.Runs, r.PathValue("id"))
		})
	}
	// view writes a call's answer: the run's view, or its error.
	view := func(w http.ResponseWriter, v model.RunView, err error, fallback int) {
		if err != nil {
			fail(w, err, fallback)
			return
		}
		writeJSON(w, v)
	}
	// number reads a path value that counts from 1 (an attempt, a notes version).
	number := func(w http.ResponseWriter, r *http.Request, name string) (int, bool) {
		n, err := strconv.Atoi(r.PathValue(name))
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, name+" must be a number, 1 or more")
			return 0, false
		}
		return n, true
	}

	handle("POST /api/runs", func(w http.ResponseWriter, r *http.Request, rs *runs.Service, _ string) {
		var body struct{ Group, Name string }
		if !readJSON(w, r, &body) {
			return
		}
		v, err := rs.Create(body.Group, body.Name)
		view(w, v, err, http.StatusBadRequest)
	})
	// The run's view, with what it says of its folder (git, folderMissing, blocked) checked again.
	handle("GET /api/runs/{id}", func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string) {
		// As the read of a chat: an API client's read waits for a start call still under way.
		if fromRemote(r) {
			s.awaitStart(r.Context(), func() { rs.AwaitStart(id) })
		}
		v, err := rs.View(id)
		view(w, v, err, http.StatusInternalServerError)
	})
	// Name and group in every status; server, agent, tiers, cwd and settings until the run starts.
	handle("PATCH /api/runs/{id}", func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string) {
		var body runs.PatchReq
		if fromRemote(r) { // an API client: the name alone (apiruns.go)
			var good bool
			if body, good = apiRunRename(w, r); !good {
				return
			}
		} else if !readJSON(w, r, &body) {
			return
		}
		v, err := rs.Patch(id, body)
		// A folder of a draft on another server is checked there: one that is none has the code
		// that server's own refusal has.
		if errors.Is(err, chats.ErrFolderMissing) {
			writeErrorCode(w, statusOf(err, http.StatusBadRequest), err.Error(), "folder_missing")
			return
		}
		view(w, v, err, http.StatusBadRequest)
	})
	// The goal being typed. A started run ignores it.
	handle("PUT /api/runs/{id}/draft", func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string) {
		var body model.Draft
		if !readJSON(w, r, &body) {
			return
		}
		if err := rs.SetDraft(id, body); err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		ok(w)
	})
	// Answers when the start is recorded, before any agent runs. The start of a draft whose
	// server is another one is that server's start call, one call that makes the run there and
	// starts it (remotes.Relay.StartRun): on success the run is a record from now on, under the
	// same id, and the answer is its view. The call goes on when the page that asked has left.
	handle("POST /api/runs/{id}/start", func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string) {
		var body struct{ Goal string }
		if !readJSON(w, r, &body) {
			return
		}
		if !fromRemote(r) && s.Remotes != nil {
			if _, there := rs.RemoteDraft(id); there {
				writeReply(w, s.Remotes.StartRun(r.Context(), id, body.Goal))
				return
			}
		}
		v, err := rs.Start(id, body.Goal)
		view(w, v, err, http.StatusBadRequest)
	})
	handle("POST /api/runs/{id}/stop", func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string) {
		v, err := rs.Stop(id)
		view(w, v, err, http.StatusInternalServerError)
	})
	// The body may raise the limit that stalled the run: {maxTurns} or {maxCost}.
	handle("POST /api/runs/{id}/resume", func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string) {
		var body runs.ResumeReq
		if !readOptionalJSON(w, r, &body) {
			return
		}
		v, err := rs.Resume(id, body)
		view(w, v, err, http.StatusBadRequest)
	})
	// Applies the result to the person's folder. The body may name the folder's branch ({branch},
	// "HEAD" for a detached one): needed when it is not the branch the run started on. An outcome
	// that is blocked or pending is an answer, not an error.
	handle("POST /api/runs/{id}/apply", func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string) {
		var body struct{ Branch string }
		if !readOptionalJSON(w, r, &body) {
			return
		}
		d, err := rs.Apply(id, body.Branch)
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, d)
	})
	// What an apply would do now: nothing changes and nothing is recorded.
	handle("GET /api/runs/{id}/delivery", func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string) {
		d, err := rs.Delivery(id)
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, d)
	})
	handle("DELETE /api/runs/{id}", func(w http.ResponseWriter, r *http.Request, _ *runs.Service, id string) {
		if err := a.DeleteRun(id); err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		ok(w)
	})

	// What the run view reads on demand.
	handle("GET /api/runs/{id}/detail", func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string) {
		s.follow(r, editorbridge.Run(id))
		d, err := rs.Detail(id)
		if err != nil {
			if errors.Is(err, runs.ErrNotFound) { // no follow of a run that is not there
				s.unfollow(r, editorbridge.Run(id))
			}
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, d)
	})
	handle("GET /api/runs/{id}/goal", func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string) {
		g, err := rs.Goal(id)
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, g)
	})
	// A task's brief: ?rev=<n>, without it the one in force.
	handle("GET /api/runs/{id}/tasks/{tid}/brief", func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string) {
		rev := 0
		if q := r.URL.Query().Get("rev"); q != "" {
			n, err := strconv.Atoi(q)
			if err != nil || n < 1 {
				writeError(w, http.StatusBadRequest, "rev must be a number, 1 or more")
				return
			}
			rev = n
		}
		b, err := rs.Brief(id, r.PathValue("tid"), rev)
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, b)
	})
	handle("GET /api/runs/{id}/tasks/{tid}/attempts/{n}/report", func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string) {
		n, good := number(w, r, "n")
		if !good {
			return
		}
		rep, err := rs.Report(id, r.PathValue("tid"), n)
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, rep)
	})
	handle("GET /api/runs/{id}/tasks/{tid}/attempts/{n}/changes", func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string) {
		n, good := number(w, r, "n")
		if !good {
			return
		}
		ch, err := rs.Changes(id, r.PathValue("tid"), n)
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, ch)
	})
	handle("GET /api/runs/{id}/notes/{v}", func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string) {
		v, good := number(w, r, "v")
		if !good {
			return
		}
		notes, err := rs.Notes(id, v)
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, notes)
	})
	// The start call and the draft check of an API client.
	s.apiRunRoutes(handle)
}
