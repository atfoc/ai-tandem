package server

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
)

// The routes of a chat that is on another server. This server keeps a record of such a chat
// (internal/remotes) under the chat's id, and a page calls /api/chats/{id}… for it as for any
// chat: remoteFirst sits in front of the routes of the loopback listener and serves those calls
// from recordRoutes, which says per route what a record's call is: passed on to the chat's
// server, answered here, or refused. Each handler decodes the request and writes what the relay
// answers, the status and the JSON as they are.
//
// It is not in RemoteHandler: this server passes nothing on for its own API clients, so on the
// remote listener a record's id is "no such chat". The routes of a run on another server are in
// remoterun.go.

// remoteFirst serves a request whose path is /api/chats/{id} or below it from recordRoutes when
// the id is a record's, and from runAgentRoutes when it is the chat of an agent of a run record;
// one whose path is /api/runs/{id} or below it from runRecordRoutes when the id is a run
// record's (see remoterun.go). It gives every other request to next.
func (s *Server) remoteFirst(next http.Handler) http.Handler {
	records, runRecords, runAgents := s.recordRoutes(), s.runRecordRoutes(), s.runAgentRoutes()
	table := func(path string) http.Handler {
		if s.Remotes == nil {
			return next
		}
		if id, ok := chatOf(path); ok {
			if s.Remotes.Has(id) {
				return records
			}
			if _, agent := s.Remotes.AgentChat(id); agent {
				return runAgents
			}
		} else if id, ok := runOf(path); ok && s.Remotes.HasRun(id) {
			return runRecords
		}
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		table(r.URL.Path).ServeHTTP(w, r)
	})
}

// chatPrefix is the path every route of one chat starts with, before its id.
const chatPrefix = "/api/chats/"

// chatOf is the chat id of a path that is /api/chats/{id} or below it.
func chatOf(path string) (id string, ok bool) {
	rest, ok := strings.CutPrefix(path, chatPrefix)
	if !ok {
		return "", false
	}
	id, _, _ = strings.Cut(rest, "/")
	return id, id != ""
}

// writeReply writes the relay's answer: its status and its JSON body.
func writeReply(w http.ResponseWriter, rep remotes.Reply) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(rep.Status)
	w.Write(rep.Body)
}

// readBody reads a request's JSON body to pass it on as it is; one that is no JSON is refused
// here, as readJSON does.
func readBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	b, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, false
	}
	if !json.Valid(b) {
		writeError(w, http.StatusBadRequest, "the body is not JSON")
		return nil, false
	}
	return b, true
}

// recordRoutes is the table of the routes of a record: one for every route of the mux under
// /api/chats/{id}, spelled as it is registered there (a test holds the two together). They are
// served only for an id that has a record, so s.Remotes is set.
func (s *Server) recordRoutes() *routeMux {
	mux := newRouteMux()
	id := func(r *http.Request) string { return r.PathValue("id") }
	client := func(r *http.Request) string { return r.Header.Get(ClientHeader) }

	// Passed on; the answer is the record's view after it took the one that came.
	mux.HandleFunc("GET /api/chats/{id}", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, s.Remotes.Get(r.Context(), id(r)))
	})
	// The three reads a page follows a chat with: the follow is noted here first, then the read
	// is passed on, which makes this server a follower there.
	mux.HandleFunc("GET /api/chats/{id}/items", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, s.Remotes.Items(r.Context(), id(r), client(r), branchOf(r)))
	})
	mux.HandleFunc("GET /api/chats/{id}/tree", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, s.Remotes.Tree(r.Context(), id(r), client(r)))
	})
	mux.HandleFunc("GET /api/chats/{id}/subagents/{sid}/items", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, s.Remotes.SubItems(r.Context(), id(r), client(r), branchOf(r), r.PathValue("sid")))
	})
	mux.HandleFunc("GET /api/chats/{id}/context", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, s.Remotes.Context(r.Context(), id(r), branchOf(r), r.URL.Query().Get("fresh") == "1"))
	})
	// Passed on with its body, a target too; an archived record is refused here.
	mux.HandleFunc("POST /api/chats/{id}/messages", func(w http.ResponseWriter, r *http.Request) {
		if body, good := readBody(w, r); good {
			writeReply(w, s.Remotes.Send(r.Context(), id(r), branchOf(r), body))
		}
	})
	mux.HandleFunc("POST /api/chats/{id}/interrupt", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, s.Remotes.Interrupt(r.Context(), id(r), branchOf(r)))
	})
	mux.HandleFunc("POST /api/chats/{id}/permission", func(w http.ResponseWriter, r *http.Request) {
		if body, good := readBody(w, r); good {
			writeReply(w, s.Remotes.Permission(r.Context(), id(r), branchOf(r), body))
		}
	})
	mux.HandleFunc("POST /api/chats/{id}/open", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, s.Remotes.OpenChat(r.Context(), id(r), branchOf(r)))
	})
	mux.HandleFunc("PUT /api/chats/{id}/label", func(w http.ResponseWriter, r *http.Request) {
		if body, good := readBody(w, r); good {
			writeReply(w, s.Remotes.Label(r.Context(), id(r), body))
		}
	})
	// Local: the draft is this server's, with its counter (see the route of a chat of this
	// server for rev).
	mux.HandleFunc("PUT /api/chats/{id}/draft", func(w http.ResponseWriter, r *http.Request) {
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
		writeReply(w, s.Remotes.SetDraft(id(r), branchOf(r), base, body))
	})
	// "group" is the record's place here; "name", "model", "effort" and "cwd" are passed on;
	// "server" and "agent" are refused: the chat has started.
	mux.HandleFunc("PATCH /api/chats/{id}", func(w http.ResponseWriter, r *http.Request) {
		var body remotes.PatchReq
		if !readJSON(w, r, &body) {
			return
		}
		writeReply(w, s.Remotes.Patch(r.Context(), id(r), branchOf(r), body))
	})
	// Passed on; the fork gets a record of its own in the source's place.
	mux.HandleFunc("POST /api/chats/{id}/fork", func(w http.ResponseWriter, r *http.Request) {
		if body, good := readBody(w, r); good {
			writeReply(w, s.Remotes.Fork(r.Context(), id(r), body))
		}
	})
	// The mark shows at once and is passed on when the chat's server can be asked; an unarchive
	// also brings back the archived groups the record is nested in.
	mux.HandleFunc("POST /api/chats/{id}/archive", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, remotes.ReplyOf(s.App.ArchiveRecord(r.Context(), id(r))))
	})
	mux.HandleFunc("POST /api/chats/{id}/unarchive", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, remotes.ReplyOf(s.App.UnarchiveRecord(r.Context(), id(r))))
	})
	// Deletes the chat on its server and the record with it. With ?local=1 the record alone goes
	// ("Remove from this sidebar only"), which is refused while the server is connected.
	mux.HandleFunc("DELETE /api/chats/{id}", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, remotes.ReplyOf(s.Remotes.Delete(r.Context(), id(r), r.URL.Query().Get("local") == "1")))
	})
	// The page's follow ends here; when it was the last one, the bridge's hook ends this server's
	// follow on the chat's server.
	mux.HandleFunc("POST /api/chats/{id}/unfollow", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, s.Remotes.Unfollow(id(r), client(r)))
	})
	return mux
}

// firstAlone is the refusal of a first message that is more than its text.
const firstAlone = "the first message of a chat on another server is its text alone: it takes no target, branch, context or references"

// startThere is POST /api/chats/{id}/messages for a chat of this server that has not started
// and whose server is another one (meta): the message is that server's creation call, one call
// that makes the chat there and sends the text. alone says that the request holds nothing but
// the text; such a chat has nothing to quote or to branch from, so anything else is refused.
// On success the chat is a record from now on, under the same id.
func (s *Server) startThere(w http.ResponseWriter, r *http.Request, meta model.ChatMeta, text string, alone bool) {
	if !alone {
		writeError(w, http.StatusBadRequest, firstAlone)
		return
	}
	if meta.Archived {
		fail(w, chats.ErrArchived, http.StatusInternalServerError)
		return
	}
	out := s.Remotes.Start(r.Context(), meta.ID, text)
	if out.Status != http.StatusOK {
		writeErrorCode(w, out.Status, out.Error, out.Code)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "branch": "main"})
}

// entryOf is the entry of the server list a request of a page asks about with ?server=, when
// that is another server than this one. An API client asks about this machine only: its
// "server" is ignored.
func (s *Server) entryOf(r *http.Request) (entry string, there bool) {
	if fromRemote(r) {
		return "", false
	}
	entry = r.URL.Query().Get("server")
	return entry, entry != "" && entry != model.LocalServer
}

// onEntry writes the answer of a call that is passed on to an entry's server: what it answered,
// as it came. Without a relay no entry but the local one is known.
func (s *Server) onEntry(w http.ResponseWriter, call func(rm *remotes.Relay) remotes.Reply) {
	if s.Remotes == nil {
		writeError(w, http.StatusNotFound, chats.ErrServerUnknown.Error())
		return
	}
	writeReply(w, call(s.Remotes))
}
