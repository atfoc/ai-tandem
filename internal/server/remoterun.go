package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/remotes"
)

// The routes of a run that is on another server. This server keeps a record of such a run
// (internal/remotes) under the run's id, and a page calls /api/runs/{id}… for it as for any run,
// and /api/chats/{id}… for the chat of one of its agents. remoteFirst serves those calls from
// two tables: runRecordRoutes for a record's id, and runAgentRoutes for the id of a chat the
// relay has learned as an agent's of a record (and that has no chat record). Each table says per
// route what the call is: passed on to the run's server, answered here, or refused. The
// handlers write what the relay answers, the status and the JSON as they are.
//
// Before its start such a run is a draft of this server with a server chosen: the routes of the
// mux serve it, and its start is the relay's (see the start route in server.go).
//
// Neither table is in RemoteHandler: on the remote listener a record's id is "no such run" and
// an agent's chat "no such chat".

// runPrefix is the path every route of one run starts with, before its id.
const runPrefix = "/api/runs/"

// runOf is the run id of a path that is /api/runs/{id} or below it.
func runOf(path string) (id string, ok bool) {
	rest, ok := strings.CutPrefix(path, runPrefix)
	if !ok {
		return "", false
	}
	id, _, _ = strings.Cut(rest, "/")
	return id, id != ""
}

// below is the path of the request after the id of its run or chat: "/detail", "" for the item
// itself.
func below(r *http.Request, prefix string) string {
	return strings.TrimPrefix(r.URL.Path, prefix+r.PathValue("id"))
}

// runRecordRoutes is the table of the routes of a run record: one for every route of the mux
// under /api/runs/{id}, spelled as it is registered there (a test holds the two together). They
// are served only for an id that has a record, so s.Remotes is set.
func (s *Server) runRecordRoutes() *routeMux {
	mux := newRouteMux()
	id := func(r *http.Request) string { return r.PathValue("id") }
	client := func(r *http.Request) string { return r.Header.Get(ClientHeader) }

	// Passed on; the answer is the record's view after it took the one that came.
	mux.HandleFunc("GET /api/runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, s.Remotes.RunGet(r.Context(), id(r)))
	})
	// "group" is the record's place here; "name" is passed on; "server", "agent", "tiers", "cwd"
	// and "settings" are refused: the run has started.
	mux.HandleFunc("PATCH /api/runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		var body remotes.RunPatchReq
		if !readJSON(w, r, &body) {
			return
		}
		writeReply(w, s.Remotes.RunPatch(r.Context(), id(r), body))
	})
	// Local: a started run takes no goal draft, as a run of this server ignores it.
	mux.HandleFunc("PUT /api/runs/{id}/draft", func(w http.ResponseWriter, r *http.Request) {
		ok(w)
	})
	// Local: the run has started, which the record's view says. Nothing is sent: a page repeats
	// its start when the answer to the first one was lost, and the run starts only once.
	mux.HandleFunc("POST /api/runs/{id}/start", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, s.Remotes.StartRun(r.Context(), id(r), ""))
	})
	// Passed on with the body; the answer of a stop or a resume is the record's view after it
	// took the one that came, that of an apply the outcome as it came.
	for _, verb := range []string{"stop", "resume", "apply"} {
		mux.HandleFunc("POST /api/runs/{id}/"+verb, func(w http.ResponseWriter, r *http.Request) {
			if body, good := readOptionalBody(w, r); good {
				writeReply(w, s.Remotes.RunDo(r.Context(), id(r), verb, body))
			}
		})
	}
	// The read a page follows a run with: the follow is noted here first, then the read is
	// passed on, which makes this server a follower there.
	mux.HandleFunc("GET /api/runs/{id}/detail", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, s.Remotes.RunDetail(r.Context(), id(r), client(r)))
	})
	// The run's texts, passed on with the query and answered as they came.
	for _, text := range []string{
		"goal", "delivery", "tasks/{tid}/brief", "tasks/{tid}/attempts/{n}/report",
		"tasks/{tid}/attempts/{n}/changes", "notes/{v}",
	} {
		mux.HandleFunc("GET /api/runs/{id}/"+text, func(w http.ResponseWriter, r *http.Request) {
			writeReply(w, s.Remotes.RunRead(r.Context(), id(r), below(r, runPrefix), r.URL.RawQuery))
		})
	}
	// The mark shows at once and is passed on when the run's server can be asked; an unarchive
	// also brings back the archived groups the record is nested in.
	mux.HandleFunc("POST /api/runs/{id}/archive", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, remotes.ReplyOf(s.App.ArchiveRunRecord(r.Context(), id(r))))
	})
	mux.HandleFunc("POST /api/runs/{id}/unarchive", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, remotes.ReplyOf(s.App.UnarchiveRunRecord(r.Context(), id(r))))
	})
	// Deletes the run on its server and the record with it, the records of the chats on the run
	// too. With ?local=1 the records alone go ("Remove from this sidebar only"), which is
	// refused while the server is connected.
	mux.HandleFunc("DELETE /api/runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, remotes.ReplyOf(s.Remotes.DeleteRun(r.Context(), id(r), r.URL.Query().Get("local") == "1")))
	})
	// The page's follow ends here; when it was the last one, the bridge's hook ends this server's
	// follow on the run's server.
	mux.HandleFunc("POST /api/runs/{id}/unfollow", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, s.Remotes.RunUnfollow(id(r), client(r)))
	})
	// An API client's start call: there is none for a caller of this listener, as for every id.
	mux.HandleFunc("PUT /api/runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not found")
	})
	return mux
}

// runAgentRoutes is the table of the routes of the chat of an agent of a run record: one for
// every route of the mux under /api/chats/{id} (a test holds the two together). A person reads
// such a chat and follows it; nothing else is done to it, here as on the run's own server. They
// are served only for an id the relay knows as such a chat, so s.Remotes is set.
func (s *Server) runAgentRoutes() *routeMux {
	mux := newRouteMux()
	id := func(r *http.Request) string { return r.PathValue("id") }
	client := func(r *http.Request) string { return r.Header.Get(ClientHeader) }

	// Passed on, as it came.
	mux.HandleFunc("GET /api/chats/{id}", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, s.Remotes.AgentView(r.Context(), id(r)))
	})
	// The three reads a page follows a chat with: the follow is noted here first, then the read
	// is passed on with its query.
	for _, read := range []string{"items", "tree", "subagents/{sid}/items"} {
		mux.HandleFunc("GET /api/chats/{id}/"+read, func(w http.ResponseWriter, r *http.Request) {
			writeReply(w, s.Remotes.AgentRead(r.Context(), id(r), client(r), below(r, chatPrefix), r.URL.RawQuery))
		})
	}
	mux.HandleFunc("GET /api/chats/{id}/context", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, s.Remotes.AgentContext(r.Context(), id(r), r.URL.RawQuery))
	})
	// The page's follow ends here; the bridge's hook does the rest.
	mux.HandleFunc("POST /api/chats/{id}/unfollow", func(w http.ResponseWriter, r *http.Request) {
		writeReply(w, s.Remotes.AgentUnfollow(id(r), client(r)))
	})
	// Refused, and nothing is sent: the chat is a run's agent's.
	for _, pat := range []string{
		"POST /api/chats/{id}/messages", "POST /api/chats/{id}/interrupt", "POST /api/chats/{id}/permission",
		"POST /api/chats/{id}/open", "PUT /api/chats/{id}/label", "PUT /api/chats/{id}/draft",
		"PATCH /api/chats/{id}", "POST /api/chats/{id}/fork", "POST /api/chats/{id}/archive",
		"POST /api/chats/{id}/unarchive", "DELETE /api/chats/{id}",
	} {
		mux.HandleFunc(pat, func(w http.ResponseWriter, r *http.Request) {
			fail(w, chats.ErrRunAgent, http.StatusConflict)
		})
	}
	return mux
}

// readOptionalBody is readBody for a body that may be empty: nil then.
func readOptionalBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	b, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, false
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return nil, true
	}
	if !json.Valid(b) {
		writeError(w, http.StatusBadRequest, "the body is not JSON")
		return nil, false
	}
	return b, true
}
