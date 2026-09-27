// Package server is the HTTP API (the prototype main.go's handlers). Handlers are thin: decode,
// call App / Chats / Boards / Relay / Bridge, encode, and map errors to statuses.
package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/app"
	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/version"
)

type Server struct {
	App    *app.App
	Relay  *boardapi.Relay
	Bridge *editorbridge.Bridge
	Client string // static client folder, "" = none
	Port   int
	// Usage returns an agent's plan usage limits (agent.UsageCache.Get); a missing agent = not available.
	Usage map[model.AgentKind]func(fresh bool) (model.PlanUsage, error)
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
// busy → 409; file system and process errors → 500; anything else → fallback (400 where the
// call validates the request's input, 500 where it does not).
func statusOf(err error, fallback int) int {
	switch {
	case errors.Is(err, boards.ErrNotFound), errors.Is(err, chats.ErrNotFound),
		errors.Is(err, chats.ErrNoSubagent), errors.Is(err, app.ErrGroupNotFound):
		return http.StatusNotFound
	case errors.Is(err, boards.ErrArchived), errors.Is(err, chats.ErrArchived),
		errors.Is(err, chats.ErrLocked), errors.Is(err, agent.ErrFolderMissing),
		errors.Is(err, chats.ErrBusy), errors.Is(err, app.ErrGroupArchived):
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

// ---- routes ---------------------------------------------------------------

// Handler builds the mux of the HTTP API, wrapped in guard().
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	a := s.App

	// ---- client and events ----
	mux.HandleFunc("GET /api/hello", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"app": "ai-whiteboard", "version": version.Version, "pid": os.Getpid()})
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

	// ---- chats ----
	mux.HandleFunc("POST /api/chats", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
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
	mux.HandleFunc("GET /api/chats/{id}/items", func(w http.ResponseWriter, r *http.Request) {
		v, items, subs, err := a.Chats.Items(r.PathValue("id"))
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
		writeJSON(w, map[string]any{"version": v, "items": items, "subagents": subs})
	})
	mux.HandleFunc("GET /api/chats/{id}/subagents/{sid}/items", func(w http.ResponseWriter, r *http.Request) {
		v, items, err := a.Chats.SubItems(r.PathValue("id"), r.PathValue("sid"))
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		if items == nil {
			items = []model.Item{}
		}
		writeJSON(w, map[string]any{"version": v, "items": items})
	})
	mux.HandleFunc("POST /api/chats/{id}/open", func(w http.ResponseWriter, r *http.Request) {
		if err := a.Chats.Open(r.PathValue("id")); err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		ok(w)
	})
	mux.HandleFunc("POST /api/chats/{id}/messages", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Text, Context string }
		if !readJSON(w, r, &body) {
			return
		}
		if err := a.Chats.Send(r.PathValue("id"), body.Text, body.Context); err != nil {
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
			Allow     bool   `json:"allow"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		if err := a.Chats.Decide(r.PathValue("id"), body.RequestID, body.Allow); err != nil {
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

	// Folder browser for the chat's working-directory picker.
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
		_, gitErr := os.Stat(filepath.Join(abs, ".git"))
		writeJSON(w, map[string]any{"path": abs, "parent": filepath.Dir(abs), "dirs": dirs, "git": gitErr == nil})
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

	// ---- agents ----
	mux.HandleFunc("/mcp/{token}", s.Relay.ServeMCP)
	mux.HandleFunc("/agent/{token}/{tool}", s.Relay.ServeCommand)

	if s.Client != "" {
		mux.Handle("/", http.FileServer(http.Dir(s.Client)))
	}
	return guard(s.Bridge, s.Port, mux)
}
