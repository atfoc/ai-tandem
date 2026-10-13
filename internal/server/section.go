package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path"
	"slices"
	"strconv"
	"strings"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/servers"
)

// The routes of a section: the things of another server of the server list. A page names such a
// thing by two values, the id of the server's entry and the thing's id on that server, and calls
//
//	/api/on/{server}/<the path of the same call for a thing of this server, after /api>
//
// for it, with the method, the query and the body of that call. This server keeps nothing of
// such a thing but the tree its relay holds in memory (internal/remotes), so a route here is
// one of three: passed on to the entry's server as it came and answered as that server
// answered, answered here (who follows a chat or a run, which page holds a board), or refused
// here. sectionRoutes is the table; a path under the prefix that is no row of it is 404, and
// nothing is sent for it.
//
// The entry decides before anything else, in every row: an id that is no entry is 404
// "no_server". Its state decides next, in every row but three: an entry whose tree the relay
// does not hold, because it is not connected or too old, is 503 "server_unreachable". The three
// are the unfollow of a chat and of a run, the release of a board, and the reveal of a board's
// file, which is refused in every state.
//
// None of it is in RemoteHandler: this server passes nothing on for its own API clients. The
// routes /api/chats/…, /api/boards/…, /api/runs/… and /api/groups/… are for the things of this
// server alone, whatever the id.

// sectionPrefix is the path every route of a section starts with, before the entry's id.
const sectionPrefix = "/api/on/"

// sectionSceneMax is the size limit of a drawing a page saves on a board of a section: the
// limit of that server's remote listener, and of the answers this one reads from it, so what
// was saved can be read back. A board of this server has no limit.
const sectionSceneMax = 32 << 20

// sectionCall is one call of a page for a thing of a section.
type sectionCall struct {
	rm    *remotes.Relay // never nil: without a relay no id is an entry
	entry string         // the id of the entry, as the path names it
	page  string         // the client that calls
	there string         // the path of the same call on the entry's server, with the query
}

type sectionHandler func(w http.ResponseWriter, r *http.Request, c sectionCall)

// sectionTable registers the rows of the table of a section's routes. A row is spelled as the
// route of the same call for a thing of this server, without /api: "POST /chats/{id}/messages".
type sectionTable struct {
	s   *Server
	mux *routeMux
}

// row registers a route that the entry's state decides first: h is called only while the relay
// holds the entry's tree. The check reads nothing of the request's body.
func (t sectionTable) row(pattern string, h sectionHandler) {
	t.always(pattern, func(w http.ResponseWriter, r *http.Request, c sectionCall) {
		if e := c.rm.Ready(c.entry); e != nil {
			writeReply(w, e.Reply())
			return
		}
		h(w, r, c)
	})
}

// always registers a route that is served in every state of the entry: h is called for an id
// that is an entry of the server list, and any other id is 404 "no_server", as in every row.
func (t sectionTable) always(pattern string, h sectionHandler) {
	method, rest, _ := strings.Cut(pattern, " ")
	t.mux.HandleFunc(method+" "+sectionPrefix+"{server}"+rest, func(w http.ResponseWriter, r *http.Request) {
		c := sectionCall{rm: t.s.Remotes, entry: r.PathValue("server"), page: r.Header.Get(ClientHeader), there: pathThere(r)}
		if c.rm == nil || !c.rm.Listed(c.entry) { // without a relay no entry but the local one is known
			writeNoServer(w)
			return
		}
		h(w, r, c)
	})
}

// pathThere is the path of a section's call on the entry's server: what the request's path has
// after the prefix and the entry's id, as it came, with /api in front and the query behind.
func pathThere(r *http.Request) string {
	_, rest, _ := strings.Cut(strings.TrimPrefix(r.URL.EscapedPath(), sectionPrefix), "/")
	p := "/api/" + rest
	if r.URL.RawQuery != "" {
		p += "?" + r.URL.RawQuery
	}
	return p
}

// writeNoServer answers a call that names no entry of the server list.
func writeNoServer(w http.ResponseWriter) {
	writeErrorCode(w, http.StatusNotFound, "This server is not in the list.", "no_server")
}

// writeReply writes the relay's answer: its status and its JSON body.
func writeReply(w http.ResponseWriter, rep remotes.Reply) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(rep.Status)
	w.Write(rep.Body)
}

// readPassed reads the body of a call that is passed on, to send it as it came: it is not
// looked at here. A call without a body is passed on without one (nil).
func readPassed(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	b, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, false
	}
	if len(b) == 0 {
		b = nil
	}
	return b, true
}

// lasting is the context of a call that changes something on the entry's server: the page that
// asked does not end it by going away, since what the call changed there shows in the tree
// whether or not its answer is read. Its time limit ends it.
func lasting(r *http.Request) context.Context { return context.WithoutCancel(r.Context()) }

// sectionFirst serves every request whose path is under the prefix of a section's routes from
// the table, and gives every other request to next.
func (s *Server) sectionFirst(next http.Handler) http.Handler {
	table := s.sectionRoutes()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path+"/" != sectionPrefix && !strings.HasPrefix(r.URL.Path, sectionPrefix) {
			next.ServeHTTP(w, r)
			return
		}
		// A path the mux would redirect is no row, and nor is a row's path with another method.
		if p := r.URL.EscapedPath(); path.Clean(p) != p {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		if _, pattern := table.Handler(r); pattern == "" {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		table.ServeHTTP(w, r)
	})
}

// The time limit of a call that is passed on: a field of remotes.Limits.
type sectionLimit int

const (
	withinCall   sectionLimit = iota // a call that starts nothing
	withinStart                      // a call that can wait for an agent's start, or for a live run to stop
	withinDelete                     // a delete that waits for agents and checkouts
)

func (l sectionLimit) of(limits remotes.Limits) time.Duration {
	switch l {
	case withinStart:
		return limits.Start
	case withinDelete:
		return limits.Delete
	}
	return limits.Call
}

// sectionPassed are the rows that are passed on with nothing looked at here, each with the time
// limit of its call. The rows this server has a part in are in sectionRoutes: a message among
// them, which is passed on within the limit of a start and has an answer of its own for no
// answer.
var sectionPassed = []struct {
	pattern string
	limit   sectionLimit
}{
	{"POST /groups", withinCall},
	{"POST /groups/{id}/move", withinCall},
	{"DELETE /groups/{id}", withinDelete},
	{"POST /groups/{id}/archive", withinStart},
	{"POST /groups/{id}/unarchive", withinCall},

	{"POST /chats", withinCall},
	{"GET /chats/{id}", withinCall},
	{"PATCH /chats/{id}", withinCall},
	{"POST /chats/{id}/interrupt", withinCall},
	{"POST /chats/{id}/permission", withinCall},
	{"POST /chats/{id}/open", withinStart},
	{"POST /chats/{id}/fork", withinStart},
	{"POST /chats/{id}/archive", withinCall},
	{"POST /chats/{id}/unarchive", withinCall},
	{"PUT /chats/{id}/label", withinCall},
	{"DELETE /chats/{id}", withinCall},

	{"POST /runs", withinCall},
	{"GET /runs/{id}", withinCall},
	{"PATCH /runs/{id}", withinCall},
	{"PUT /runs/{id}/draft", withinCall},
	{"POST /runs/{id}/start", withinStart},
	{"POST /runs/{id}/stop", withinStart},
	{"POST /runs/{id}/resume", withinStart},
	{"POST /runs/{id}/apply", withinStart},
	{"GET /runs/{id}/delivery", withinCall},
	{"GET /runs/{id}/goal", withinCall},
	{"GET /runs/{id}/tasks/{tid}/brief", withinCall},
	{"GET /runs/{id}/tasks/{tid}/attempts/{n}/report", withinCall},
	{"GET /runs/{id}/tasks/{tid}/attempts/{n}/changes", withinCall},
	{"GET /runs/{id}/notes/{v}", withinCall},
	{"POST /runs/{id}/archive", withinStart},
	{"POST /runs/{id}/unarchive", withinStart},
	{"DELETE /runs/{id}", withinDelete},

	{"POST /boards/{id}/rename", withinCall},
	{"POST /boards/{id}/archive", withinCall},
	{"POST /boards/{id}/unarchive", withinCall},
	{"POST /boards/{id}/seen", withinCall},
	{"PATCH /boards/{id}", withinCall},
	{"DELETE /boards/{id}", withinCall},
}

// sectionRoutes is the table of a section's routes.
func (s *Server) sectionRoutes() *routeMux {
	t := sectionTable{s: s, mux: newRouteMux()}
	id := func(r *http.Request) string { return r.PathValue("id") }

	// Passed on: the method, the path, the query and the body go as they came, and the answer
	// comes back as that server gave it. A read ends with the page that asked.
	for _, row := range sectionPassed {
		method, _, _ := strings.Cut(row.pattern, " ")
		t.row(row.pattern, func(w http.ResponseWriter, r *http.Request, c sectionCall) {
			if method == http.MethodGet {
				writeReply(w, c.rm.Pass(r.Context(), c.entry, method, c.there, nil, row.limit.of(c.rm.Limits())))
				return
			}
			if body, good := readPassed(w, r); good {
				writeReply(w, c.rm.Pass(lasting(r), c.entry, method, c.there, body, row.limit.of(c.rm.Limits())))
			}
		})
	}

	// What fills a chat's context window: passed on. With fresh=1 the agent is asked, which may
	// have to start.
	t.row("GET /chats/{id}/context", func(w http.ResponseWriter, r *http.Request, c sectionCall) {
		limit := c.rm.Limits().Call
		if r.URL.Query().Get("fresh") == "1" {
			limit = c.rm.Limits().Start
		}
		writeReply(w, c.rm.Pass(r.Context(), c.entry, http.MethodGet, c.there, nil, limit))
	})

	// Passed on, but for "collapsed": whether a group shows collapsed is each page's own matter
	// and is sent to no server, so a body that has the key is refused here whatever its value.
	t.row("PATCH /groups/{id}", func(w http.ResponseWriter, r *http.Request, c sectionCall) {
		body, good := readPassed(w, r)
		if !good {
			return
		}
		if hasKey(body, "collapsed") {
			writeErrorCode(w, http.StatusBadRequest, "whether a group of another server shows collapsed is kept by the page alone", "collapsed_refused")
			return
		}
		writeReply(w, c.rm.Pass(lasting(r), c.entry, http.MethodPatch, c.there, body, c.rm.Limits().Call))
	})

	// The reads a page follows a chat or a run with: the page follows the thing here from before
	// the read is passed on, and the read makes this server a follower there.
	for _, read := range []string{"items", "tree", "subagents/{sid}/items"} {
		t.row("GET /chats/{id}/"+read, func(w http.ResponseWriter, r *http.Request, c sectionCall) {
			writeReply(w, c.rm.FollowChat(r.Context(), c.entry, c.page, id(r), c.there))
		})
	}
	t.row("GET /runs/{id}/detail", func(w http.ResponseWriter, r *http.Request, c sectionCall) {
		writeReply(w, c.rm.FollowRun(r.Context(), c.entry, c.page, id(r), c.there))
	})
	// The page's follow ends here, in every state of the entry; when it was the last one, the
	// relay ends this server's follow there.
	t.always("POST /chats/{id}/unfollow", func(w http.ResponseWriter, r *http.Request, c sectionCall) {
		writeReply(w, c.rm.UnfollowChat(c.entry, c.page, id(r)))
	})
	t.always("POST /runs/{id}/unfollow", func(w http.ResponseWriter, r *http.Request, c sectionCall) {
		writeReply(w, c.rm.UnfollowRun(c.entry, c.page, id(r)))
	})

	// A message is passed on with its body, a target too. Its images are the chat's server's to
	// check, the limits and the model too. Only the form of their ids is checked here, before
	// anything is sent: 400 "image_id", as a chat of this server answers for such an id. Images
	// that are no list are refused the same way: they name nothing that could be checked.
	t.row("POST /chats/{id}/messages", func(w http.ResponseWriter, r *http.Request, c sectionCall) {
		body, good := readPassed(w, r)
		if !good {
			return
		}
		body, _, bad, err := checkedImages(body)
		if err != nil || len(bad) > 0 {
			fail(w, chats.ErrImageID, http.StatusBadRequest)
			return
		}
		writeReply(w, c.rm.PassMessage(lasting(r), c.entry, c.there, body))
	})
	// The draft is the chat's server's, and so are its counter and the answer, "stale" too, and
	// "missing" for the images the chat does not hold there. Only the form of the ids of its
	// "images" is checked here, before they are passed on (checkedImages): an id of another form
	// is looked up nowhere, so it is left out of what is passed on and named in the answer's
	// "missing" (withMissing), as a chat of this server does with it. A draft that names no
	// image goes on as it came, byte for byte.
	t.row("PUT /chats/{id}/draft", func(w http.ResponseWriter, r *http.Request, c sectionCall) {
		if replaceRefused(w, r) {
			return
		}
		body, good := readPassed(w, r)
		if !good {
			return
		}
		body, named, bad, err := checkedImages(body)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		rep := c.rm.Pass(lasting(r), c.entry, http.MethodPut, c.there, body, c.rm.Limits().Call)
		writeReply(w, withMissing(rep, named, bad))
	})
	s.sectionImageRoutes(t)

	// The new board is made there and is given to this server, which gives it to the page that
	// made it, as a board of this server is given to its maker.
	t.row("POST /boards", func(w http.ResponseWriter, r *http.Request, c sectionCall) {
		if body, good := readPassed(w, r); good {
			writeReply(w, c.rm.CreateBoard(lasting(r), c.entry, c.page, body))
		}
	})
	// Who draws: the bridge decides among the pages of this server, and the relay keeps this
	// server's hold on the board's server equal to "a page here holds it".
	t.row("POST /boards/{id}/take", func(w http.ResponseWriter, r *http.Request, c sectionCall) {
		var body struct{ IfFree bool }
		if !readOptionalJSON(w, r, &body) {
			return
		}
		writeReply(w, c.rm.TakeBoard(c.entry, c.page, id(r), body.IfFree))
	})
	// In every state of the entry: a page lets go of a board whose server is away, too.
	t.always("POST /boards/{id}/release", func(w http.ResponseWriter, r *http.Request, c sectionCall) {
		writeReply(w, c.rm.ReleaseBoard(c.entry, c.page, id(r)))
	})
	// The drawing is read from the board's server, with its revision in SceneRevHeader.
	t.row("GET /boards/{id}/scene", func(w http.ResponseWriter, r *http.Request, c sectionCall) {
		rep, rev := c.rm.Scene(r.Context(), c.entry, id(r))
		if rep.Status == http.StatusOK {
			w.Header().Set(SceneRevHeader, strconv.FormatInt(rev, 10))
		}
		writeReply(w, rep)
	})
	// The drawing of the page that holds the board here is passed on at the revision ?rev=. It
	// is read whole, up to sectionSceneMax.
	t.row("PUT /boards/{id}/scene", func(w http.ResponseWriter, r *http.Request, c sectionCall) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, sectionSceneMax))
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
		writeReply(w, c.rm.SaveScene(c.entry, c.page, id(r), base, body))
	})
	// Refused in every state of the entry: the board's file is on its server.
	t.always("POST /boards/{id}/reveal", func(w http.ResponseWriter, r *http.Request, c sectionCall) {
		writeErrorCode(w, http.StatusBadRequest, "A board on another server has no file on this computer", "not_here")
	})
	return t.mux
}

// hasKey reports whether the JSON object body has the key, in whatever case its letters are:
// the server that decodes the body takes any.
func hasKey(body []byte, key string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil {
		return false
	}
	for k := range fields {
		if strings.EqualFold(k, key) {
			return true
		}
	}
	return false
}

// imagesOf are the values the JSON object body has under "images", a draft's or a message's,
// by the key as the body spells it: the server that decodes it takes any case. fields is the
// whole object, nil when the body is none.
func imagesOf(body []byte) (keys []string, fields map[string]json.RawMessage) {
	if json.Unmarshal(body, &fields) != nil {
		return nil, nil
	}
	for k := range fields {
		if strings.EqualFold(k, "images") {
			keys = append(keys, k)
		}
	}
	return keys, fields
}

// checkedImages reads the images the body of a draft save or of a message names, and returns
// the body as it is passed on to the chat's server. An image id from outside is checked for its
// form before it is passed on (chats.FormedImages): named are the images as the server that
// decodes the body takes them, and bad the ids that have not the form of one, each once: those
// among named first, then those under a spelling of the key that server does not take, which
// refuse a message as the others do and which no draft save's answer names, since no draft
// would have held them. A body that names no image is passed on as it came. One that does is
// passed on as the same object with one "images", the named ones whose id is good: nothing a
// page wrote under that key, in whatever spelling, reaches another server unchecked. err is for
// images that cannot be read: a value that is no list of images.
func checkedImages(body []byte) (out []byte, named []model.Image, bad []string, err error) {
	keys, fields := imagesOf(body)
	if len(keys) == 0 {
		return body, nil, nil, nil
	}
	var b struct{ Images []model.Image }
	if err := json.Unmarshal(body, &b); err != nil {
		return nil, nil, nil, err
	}
	good, bad := chats.FormedImages(b.Images)
	for _, k := range keys {
		var spelled []model.Image
		if err := json.Unmarshal(fields[k], &spelled); err != nil {
			return nil, nil, nil, err
		}
		_, more := chats.FormedImages(spelled)
		for _, id := range more {
			if !slices.Contains(bad, id) {
				bad = append(bad, id)
			}
		}
		delete(fields, k)
	}
	if good == nil {
		good = []model.Image{}
	}
	if fields["images"], err = json.Marshal(good); err != nil {
		return nil, nil, nil, err
	}
	if out, err = json.Marshal(fields); err != nil {
		return nil, nil, nil, err
	}
	return out, b.Images, bad, nil
}

// withMissing is the answer rep of a draft save that the chat's server took, with the ids bad
// added to its "missing": they were named by the save and left out here, as that server leaves
// out an image the chat does not hold. The ids stand in the order the save named them (named),
// each once, and after them what that server names and the save did not. It is the one place
// the two are joined; an answer that is no success, or names no bad id, is rep as it came.
func withMissing(rep remotes.Reply, named []model.Image, bad []string) remotes.Reply {
	var ans map[string]json.RawMessage
	if len(bad) == 0 || rep.Status != http.StatusOK || json.Unmarshal(rep.Body, &ans) != nil || ans == nil {
		return rep
	}
	var there, missing []string
	_ = json.Unmarshal(ans["missing"], &there)
	for _, im := range named {
		if (slices.Contains(there, im.ID) || slices.Contains(bad, im.ID)) && !slices.Contains(missing, im.ID) {
			missing = append(missing, im.ID)
		}
	}
	for _, id := range there { // one that server names and the save did not
		if !slices.Contains(missing, id) {
			missing = append(missing, id)
		}
	}
	ans["missing"], _ = json.Marshal(missing)
	body, err := json.Marshal(ans)
	if err != nil {
		return rep
	}
	return remotes.Reply{Status: rep.Status, Body: body}
}

// ---- what the routes of this server's own things do with another server ----

// onAskedEntry serves a read of a page that names another server than this one with
// ?server=<entry id>, and reports whether it did: GET /api/dirs and GET /api/usage/{agent} ask
// about a machine, not about a thing of a section, so they are not under the prefix. call is
// the relay's call for the entry, and its answer is the page's as it came. No "server", or
// "local", is this machine, and so is every read of an API client, whose "server" is ignored.
func (s *Server) onAskedEntry(w http.ResponseWriter, r *http.Request, call func(rm *remotes.Relay, entry string) remotes.Reply) bool {
	entry := r.URL.Query().Get("server")
	if fromRemote(r) || entry == "" || entry == model.LocalServer {
		return false
	}
	if s.Remotes == nil { // no entry but the local one is known
		writeError(w, http.StatusNotFound, servers.ErrNotFound.Error())
		return true
	}
	writeReply(w, call(s.Remotes, entry))
	return true
}

// serverRefused answers a call for a thing of this server whose body names another server, and
// reports that it did: a thing is made on another server, and changed there, by the routes of
// that server's section, and nothing moves between servers. No "server", or "local", is this
// server.
func serverRefused(w http.ResponseWriter, server string) bool {
	if server == "" || server == model.LocalServer {
		return false
	}
	writeErrorCode(w, http.StatusBadRequest, "this call is for this computer: a thing of another server is reached under "+sectionPrefix+"<server>", "server_refused")
	return true
}

// readRunPatch reads a page's body of PATCH /api/runs/{id} into p, and reports whether it did:
// one that names another server is refused, as serverRefused says.
func readRunPatch(w http.ResponseWriter, r *http.Request, p *runs.PatchReq) bool {
	var body struct {
		runs.PatchReq
		Server string `json:"server"`
	}
	if !readJSON(w, r, &body) || serverRefused(w, body.Server) {
		return false
	}
	*p = body.PatchReq
	return true
}

// noRecord answers a delete with ?local=1, and reports that it did: this server keeps no record
// of a thing of another server that could be removed alone, and a thing of its own is deleted
// whole or not at all.
func noRecord(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Query().Get("local") != "1" {
		return false
	}
	writeErrorCode(w, http.StatusBadRequest, "there is no record to remove: nothing of another server is kept here", "no_record")
	return true
}
