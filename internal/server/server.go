// Package server is the HTTP API (the prototype main.go's handlers). Handlers are thin: decode,
// call App / Chats / Boards / Relay / Bridge, encode, and map errors to statuses.
package server

import (
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
	"ai-whiteboard/internal/rungit"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/version"
)

type Server struct {
	App    *app.App
	Relay  *boardapi.Relay
	Bridge *editorbridge.Bridge
	Client string // static client folder, "" = none
	Port   int
	// MCP listener identity for GET /api/mcp/status. MCPPort/MCPURL are zero when this server
	// has no MCP listener; MCPUp reports whether it is serving (nil = down).
	MCPPort int
	MCPURL  string
	MCPUp   func() bool
	// Usage returns an agent's plan usage limits (agent.UsageCache.Get); a missing agent = not available.
	Usage map[model.AgentKind]func(fresh bool) (model.PlanUsage, error)
	// Restart starts `relaunch` of this program detached, for POST /api/restart; it must not stop
	// this server itself. An error wrapping ErrBinaryMissing means the program is gone (the app was
	// moved or deleted). nil = restart not available.
	Restart func() error
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

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func ok(w http.ResponseWriter) { writeJSON(w, map[string]any{"ok": true}) }

// statusOf maps an error to its status: not found → 404; archived, locked, folder missing,
// busy, a run in a state the call does not fit, a run agent's chat → 409; file system and process
// errors → 500; anything else → fallback (400 where the call validates the request's input, 500
// where it does not).
func statusOf(err error, fallback int) int {
	var blocked *runs.BlockedError
	switch {
	case errors.Is(err, boards.ErrNotFound), errors.Is(err, chats.ErrNotFound),
		errors.Is(err, chats.ErrNoSubagent), errors.Is(err, chats.ErrNoBranch), errors.Is(err, app.ErrGroupNotFound),
		errors.Is(err, runs.ErrNotFound), errors.Is(err, runs.ErrNoTask), errors.Is(err, runs.ErrNoAttempt),
		errors.Is(err, runs.ErrNoVersion), errors.Is(err, runs.ErrNoText), errors.Is(err, runs.ErrGroup),
		errors.Is(err, chats.ErrNoRun):
		return http.StatusNotFound
	case errors.Is(err, chats.ErrBadReference), errors.Is(err, chats.ErrBadLabel), errors.Is(err, chats.ErrBadPoint):
		return http.StatusBadRequest
	case errors.Is(err, boards.ErrArchived), errors.Is(err, chats.ErrArchived),
		errors.Is(err, chats.ErrLegacy), errors.Is(err, chats.ErrLocked), errors.Is(err, agent.ErrFolderMissing),
		errors.Is(err, chats.ErrBusy), errors.Is(err, chats.ErrNotStarted), errors.Is(err, app.ErrGroupArchived),
		errors.Is(err, chats.ErrRunAgent), errors.Is(err, chats.ErrRunArchived),
		errors.Is(err, runs.ErrArchived), errors.Is(err, runs.ErrStarted), errors.Is(err, runs.ErrNotStarted),
		errors.Is(err, runs.ErrFinished), errors.Is(err, runs.ErrNotHalted), errors.Is(err, runs.ErrNotRunning),
		errors.Is(err, runs.ErrStopping), errors.Is(err, runs.ErrLimit), errors.Is(err, runs.ErrGroupArchived),
		errors.Is(err, runs.ErrLive),
		errors.As(err, &blocked):
		return http.StatusConflict
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

// fail writes err with the status statusOf gives it.
func fail(w http.ResponseWriter, err error, fallback int) {
	writeError(w, statusOf(err, fallback), err.Error())
}

// checkGroup rejects "" (the ungrouped area is "__ungrouped__").
func checkGroup(w http.ResponseWriter, group string) bool {
	if group == "" {
		writeError(w, http.StatusBadRequest, `group is empty (use "`+model.Ungrouped+`" for ungrouped)`)
		return false
	}
	return true
}

// clientOf returns the client id of an /api/client/* or /api/rpc-reply request: the body's
// "client", or else the X-AIWB-Client header.
func clientOf(r *http.Request, body string) string {
	if body != "" {
		return body
	}
	return r.Header.Get(ClientHeader)
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
const dirsGitWait = 5 * time.Second

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

// Handler builds the mux of the HTTP API, wrapped in guard().
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	a := s.App

	// ---- client and events ----
	mux.HandleFunc("GET /api/hello", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"app": "ai-whiteboard", "version": version.Version, "pid": os.Getpid(),
			"webVersion": s.webVersion()})
	})
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
	mux.HandleFunc("GET /api/events", s.Bridge.ServeSSE)
	mux.HandleFunc("POST /api/client/release", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Client string }
		if !readOptionalJSON(w, r, &body) {
			return
		}
		id := clientOf(r, body.Client)
		if !activeOrPending(s.Bridge, id) {
			writeError(w, http.StatusConflict, "not_active")
			return
		}
		s.Bridge.Release(id)
		ok(w)
	})
	mux.HandleFunc("POST /api/client/flushed", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Client string }
		if !readOptionalJSON(w, r, &body) {
			return
		}
		if !activeOrPending(s.Bridge, clientOf(r, body.Client)) {
			writeError(w, http.StatusConflict, "not_active")
			return
		}
		s.Bridge.Flushed()
		ok(w)
	})
	mux.HandleFunc("POST /api/rpc-reply", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID     string `json:"id"`
			Client string `json:"client"`
			editorbridge.RPCReply
		}
		if !readJSON(w, r, &body) {
			return
		}
		if !activeOrPending(s.Bridge, clientOf(r, body.Client)) {
			writeError(w, http.StatusConflict, "not_active")
			return
		}
		s.Bridge.Reply(body.ID, body.RPCReply)
		ok(w)
	})
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
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
		writeJSON(w, bd)
	})
	mux.HandleFunc("GET /api/boards/{id}/scene", func(w http.ResponseWriter, r *http.Request) {
		b, err := a.Boards.Scene(r.PathValue("id"))
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(b)
	})
	mux.HandleFunc("PUT /api/boards/{id}/scene", func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := a.Boards.Save(r.PathValue("id"), b); err != nil {
			fail(w, err, http.StatusBadRequest)
			return
		}
		ok(w)
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
	mux.HandleFunc("POST /api/chats", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Agent model.AgentKind
			Group string
			Board string
			Run   string
		}
		if !readJSON(w, r, &body) {
			return
		}
		if body.Run != "" {
			cv, err := a.Chats.CreateOnRun(body.Agent, body.Run)
			if err != nil {
				fail(w, err, http.StatusBadRequest)
				return
			}
			writeJSON(w, cv)
			return
		}
		if body.Board == "" && !checkGroup(w, body.Group) {
			return
		}
		cv, err := a.Chats.Create(body.Agent, body.Group, body.Board)
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
	// "branch" in the answer is the branch served. For the chat of a run's agent this also starts
	// its chat events to the client: the watch comes first, so no change between the two is lost.
	mux.HandleFunc("GET /api/chats/{id}/items", func(w http.ResponseWriter, r *http.Request) {
		a.Chats.Watch(r.PathValue("id"))
		branch, v, items, subs, err := a.Chats.ItemsOf(r.PathValue("id"), r.URL.Query().Get("branch"))
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		if items == nil {
			items = []model.Item{}
		}
		if subs == nil {
			subs = []model.Subagent{}
		}
		writeJSON(w, map[string]any{"branch": branch, "version": v, "items": items, "subagents": subs})
	})
	mux.HandleFunc("GET /api/chats/{id}/subagents/{sid}/items", func(w http.ResponseWriter, r *http.Request) {
		v, items, err := a.Chats.SubItemsOf(r.PathValue("id"), r.URL.Query().Get("branch"), r.PathValue("sid"))
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		if items == nil {
			items = []model.Item{}
		}
		writeJSON(w, map[string]any{"version": v, "items": items})
	})
	// What fills the chat's context window, by category. ?fresh=1 asks the agent even when the
	// kept split is current.
	mux.HandleFunc("GET /api/chats/{id}/context", func(w http.ResponseWriter, r *http.Request) {
		split, err := a.Chats.ContextSplit(r.PathValue("id"), r.URL.Query().Get("fresh") == "1")
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, split)
	})
	// The chat's whole tree: every branch's messages and replies, and the labels. It reads the
	// branches' files and loads nothing.
	mux.HandleFunc("GET /api/chats/{id}/tree", func(w http.ResponseWriter, r *http.Request) {
		tv, err := a.Chats.Tree(r.PathValue("id"))
		if err != nil {
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
	// Makes a new chat holding a branch's first "at" items, in a session forked there. With
	// "message", that user message is left out and becomes the new chat's draft (Fork and edit).
	mux.HandleFunc("POST /api/chats/{id}/fork", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Branch  string
			At      *int
			Message *int
		}
		if !readJSON(w, r, &body) {
			return
		}
		if body.At == nil {
			writeError(w, http.StatusBadRequest, "at is missing")
			return
		}
		v, err := a.Chats.Fork(r.PathValue("id"), chats.ForkReq{Branch: body.Branch, At: *body.At, Message: body.Message})
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, v)
	})
	mux.HandleFunc("POST /api/chats/{id}/open", func(w http.ResponseWriter, r *http.Request) {
		if err := a.Chats.Open(r.PathValue("id")); err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		ok(w)
	})
	// Sends a message on the chat's current branch. With "target" it goes to a point of one of the
	// chat's branches instead: that branch is carried on, or a new branch starts there. A target
	// names its point: without "at" it is refused.
	mux.HandleFunc("POST /api/chats/{id}/messages", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Text, Context string
			References    []model.Reference
			Target        *struct {
				Branch string
				At     *int
				New    bool
			}
		}
		if !readJSON(w, r, &body) {
			return
		}
		if body.Target != nil && body.Target.At == nil {
			writeError(w, http.StatusBadRequest, "at is missing")
			return
		}
		var err error
		if tg := body.Target; tg != nil {
			err = a.Chats.SendTo(r.PathValue("id"), chats.Target{Branch: tg.Branch, At: *tg.At, New: tg.New}, body.Text, body.Context, body.References)
		} else {
			err = a.Chats.Send(r.PathValue("id"), body.Text, body.Context, body.References)
		}
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		ok(w)
	})
	mux.HandleFunc("PUT /api/chats/{id}/draft", func(w http.ResponseWriter, r *http.Request) {
		var body model.Draft
		if !readJSON(w, r, &body) {
			return
		}
		if err := a.Chats.SetDraft(r.PathValue("id"), body); err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		ok(w)
	})
	mux.HandleFunc("PATCH /api/chats/{id}", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name               *string
			Group              *string
			Model, Effort, Cwd string
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
		if body.Model != "" || body.Effort != "" || body.Cwd != "" {
			req := chats.ConfigReq{Model: body.Model, Effort: body.Effort, Cwd: body.Cwd}
			if err := a.Chats.Configure(id, req); err != nil {
				fail(w, err, http.StatusBadRequest)
				return
			}
		}
		ok(w)
	})
	mux.HandleFunc("POST /api/chats/{id}/interrupt", func(w http.ResponseWriter, r *http.Request) {
		if err := a.Chats.Interrupt(r.PathValue("id")); err != nil {
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
		if err := a.Chats.Decide(r.PathValue("id"), body.Subagent, body.RequestID, body.Allow); err != nil {
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
	// folder is inside a git work tree: what decides whether a run there works with git.
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

	if s.Client != "" {
		mux.Handle("/", clientFiles(s.Client))
	}
	return guard(s.Bridge, s.Port, mux)
}

// ---- runs -------------------------------------------------------------------

// runRoutes adds the routes of runs: thin handlers on runs.Service, and on the app for what
// cascades (delete; archive and unarchive are in the table of every kind). A server whose app has
// no runs answers each with 404.
func (s *Server) runRoutes(mux *http.ServeMux) {
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
		v, err := rs.View(id)
		view(w, v, err, http.StatusInternalServerError)
	})
	// Name and group in every status; agent, tiers, cwd and settings until the run starts.
	handle("PATCH /api/runs/{id}", func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string) {
		var body runs.PatchReq
		if !readJSON(w, r, &body) {
			return
		}
		v, err := rs.Patch(id, body)
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
	// Answers when the start is recorded, before any agent runs.
	handle("POST /api/runs/{id}/start", func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string) {
		var body struct{ Goal string }
		if !readJSON(w, r, &body) {
			return
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
		d, err := rs.Detail(id)
		if err != nil {
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
}
