package remotes

// The calls of a page for a thing of a section. Each one answers with a Reply, the status and
// the JSON to write as they are: the HTTP layer decodes the request and writes what it is given.
//
// A call that is passed on is sent to the entry's server as it came, and that server's answer
// is the page's as it came, status and body, with its codes and sentences. The relay changes no
// id and reads no body. What it answers itself is one table (ready, unmade, handed):
//
//	the entry is not in the list, or is the local one    404 no_server           nothing is sent
//	the relay holds no tree of the entry                 503 server_unreachable  nothing is sent
//	that server answers 401                              503 server_unreachable
//	the answer is no JSON, or is too long                502 bad_answer
//	no answer in time, or the connection ended           504 no_answer
//
// None of them is 409: a page reads a thing again after a 409, and here it shall keep what it has.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"time"

	"ai-whiteboard/internal/servers"
)

// Reply is the answer to a page's call: the status, and the JSON body to write as it is.
type Reply struct {
	Status int
	Body   []byte
}

// Error is a call that was refused or could not be made, with what the page gets: the status,
// the code ("" for none) and the sentence. errors.Is finds its cause (ErrUnreachable,
// ErrNoAnswer), where it has one.
type Error struct {
	Status int
	Code   string
	Text   string
	cause  error
}

func (e *Error) Error() string { return e.Text }
func (e *Error) Unwrap() error { return e.cause }

// Reply is the error as the page gets it: {"error":…,"code":…}.
func (e *Error) Reply() Reply {
	body := map[string]string{"error": e.Text}
	if e.Code != "" {
		body["code"] = e.Code
	}
	return jsonReply(e.Status, body)
}

var okReply = Reply{Status: http.StatusOK, Body: []byte(`{"ok":true}`)}

// jsonReply is v as a Reply.
func jsonReply(status int, v any) Reply {
	b, err := json.Marshal(v)
	if err != nil {
		return Reply{Status: http.StatusInternalServerError, Body: []byte(`{"error":"the answer cannot be written"}`)}
	}
	return Reply{Status: status, Body: b}
}

// ---- the answers of a call that cannot be made ----

// name is the entry's name, as the user gave it.
func (r *Relay) name(entry string) string {
	if v, ok := r.o.Servers.View(entry); ok && v.Name != "" {
		return v.Name
	}
	return "The server"
}

// noServer is the answer for an id that is no entry of the server list, or is the local one.
func noServer() *Error {
	return &Error{Status: http.StatusNotFound, Code: "no_server", Text: "This server is not in the list."}
}

func (r *Relay) unreachable(entry string) *Error {
	return &Error{Status: http.StatusServiceUnavailable, Code: "server_unreachable", Text: r.name(entry) + " is not connected.", cause: ErrUnreachable}
}

// away is the answer for an entry nothing can be sent to (503 server_unreachable), in the one
// place that tells why: one whose server is too old says so, and any other is not connected, and
// is made to try now if it waits.
func (r *Relay) away(entry string) *Error {
	if v, ok := r.o.Servers.View(entry); ok && v.State == servers.StateTooOld {
		return &Error{Status: http.StatusServiceUnavailable, Code: "server_unreachable",
			Text: r.name(entry) + " is too old: update the server on that machine.", cause: ErrUnreachable}
	}
	r.o.Servers.Retry(entry)
	return r.unreachable(entry)
}

func (r *Relay) noAnswer(entry string) *Error {
	return &Error{Status: http.StatusGatewayTimeout, Code: "no_answer", Text: r.name(entry) + " did not answer.", cause: ErrNoAnswer}
}

// badAnswer is for an answer this server cannot use: it is no JSON, is too long, or is not what
// the call answers with.
func (r *Relay) badAnswer(entry string) *Error {
	return &Error{Status: http.StatusBadGateway, Code: "bad_answer", Text: r.name(entry) + " gave an answer that cannot be read."}
}

// Listed reports whether id is an entry of the server list that is not the local one: what a
// call for a thing of a section may name, whatever the entry's state.
func (r *Relay) Listed(id string) bool {
	v, ok := r.o.Servers.View(id)
	return ok && !v.Local && id != servers.LocalID
}

// Ready is the refusal of a call for a thing of the section entry before anything is sent: 404
// no_server for an id that is no entry, and 503 server_unreachable while the relay holds no tree
// of the entry (see away). nil when the call can be passed on. A route asks it before it reads
// or checks a request that it would refuse for another reason, so that the entry's state decides
// first.
func (r *Relay) Ready(entry string) *Error {
	switch {
	case !r.Listed(entry):
		return noServer()
	case !r.held(entry):
		return r.away(entry)
	}
	return nil
}

// unmade is the answer for a call that call returned an error for.
func (r *Relay) unmade(entry string, err error) *Error {
	switch {
	case errors.Is(err, ErrUnreachable):
		return r.away(entry)
	case errors.Is(err, errTooLong):
		return r.badAnswer(entry)
	}
	return r.noAnswer(entry)
}

// said is what an answer that is no success tells: its "error" and "code".
type said struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func saidIn(rep servers.Reply) said {
	var s said
	_ = json.Unmarshal(rep.Body, &s)
	return s
}

// notFound reports whether the answer says that the thing the call names is not on that server:
// a 404 with the code "not_found". Every other 404 is of a part of the thing, or of a route.
func notFound(rep servers.Reply) bool {
	return rep.Status == http.StatusNotFound && saidIn(rep).Code == "not_found"
}

// handed is a server's answer as the page gets it: its status and its body. Two answers are not
// handed on: 401, which is the entry's matter and not the thing's (503 server_unreachable), and a
// body that is no JSON (502 bad_answer).
func (r *Relay) handed(entry string, rep servers.Reply) Reply {
	switch {
	case rep.Status == http.StatusUnauthorized:
		return r.unreachable(entry).Reply()
	case !json.Valid(rep.Body):
		return r.badAnswer(entry).Reply()
	}
	return Reply{Status: rep.Status, Body: rep.Body}
}

// do passes a call for a thing of the section entry on. A nil error means that rep is the
// server's answer, to be read or handed on (handed), whatever its status.
func (r *Relay) do(ctx context.Context, entry, method, path string, body []byte, limit time.Duration) (servers.Reply, *Error) {
	if e := r.Ready(entry); e != nil {
		return servers.Reply{}, e
	}
	rep, err := r.call(ctx, entry, method, path, body, limit)
	if err != nil {
		return rep, r.unmade(entry, err)
	}
	return rep, nil
}

// Pass passes a page's call for a thing of the section entry on to that entry's server, and
// answers as that server answered: its status and its JSON body, its codes and sentences, a 404
// not_found for a thing that is gone there among them. pathAndQuery is the path of the call on
// that server, as for its own page ("/api/chats/<id>/label"), with the query; body is the
// request's, or nil. limit is one of Limits. The call ends with ctx.
//
// What the relay answers itself: 404 no_server for an entry that is not in the list or is the
// local one, 503 server_unreachable while the entry is not connected or is too old (nothing was
// sent) and for an answer of 401, 502 bad_answer for an answer that is no JSON or is too long,
// and 504 no_answer when none came within limit or the connection ended.
func (r *Relay) Pass(ctx context.Context, entry, method, pathAndQuery string, body []byte, limit time.Duration) Reply {
	rep, e := r.do(ctx, entry, method, pathAndQuery, body, limit)
	if e != nil {
		return e.Reply()
	}
	return r.handed(entry, rep)
}

// PassMessage is Pass for POST …/messages, within Limits.Start. A message that was sent and got
// no answer may have arrived: that is 504 send_unknown in the place of no_answer, and the page
// keeps the text.
func (r *Relay) PassMessage(ctx context.Context, entry, pathAndQuery string, body []byte) Reply {
	rep, e := r.do(ctx, entry, http.MethodPost, pathAndQuery, body, r.o.Limits.Start)
	if e != nil {
		if errors.Is(e, ErrNoAnswer) {
			e.Code, e.Text = "send_unknown", r.name(entry)+" did not answer: it is not known whether the message arrived."
		}
		return e.Reply()
	}
	return r.handed(entry, rep)
}

// query is "?k=v&…" of the pairs kv whose value is not empty, "" for none.
func query(kv ...string) string {
	q := url.Values{}
	for i := 0; i+1 < len(kv); i += 2 {
		if kv[i+1] != "" {
			q.Set(kv[i], kv[i+1])
		}
	}
	if len(q) == 0 {
		return ""
	}
	return "?" + q.Encode()
}

// chatPath is the path of the chat id on its server, with rest after it ("" or "/…").
func chatPath(id, rest string) string { return "/api/chats/" + url.PathEscape(id) + rest }

// runPath is the path of the run id on its server, with rest after it.
func runPath(id, rest string) string { return "/api/runs/" + url.PathEscape(id) + rest }

// boardPath is the path of the board id on its server, with rest after it.
func boardPath(id, rest string) string { return "/api/boards/" + url.PathEscape(id) + rest }

// ---- the routes that name the entry in the query ----

// Dirs serves GET /api/dirs?path=&server=<entry> for a remote entry: the folders there, as that
// server answers. An entry that is not in the list is 404 "no such server". The others are
// those of Pass, but that a connected entry is asked whether or not its tree is held.
func (r *Relay) Dirs(ctx context.Context, entry, path string) Reply {
	return r.passEntry(ctx, entry, "/api/dirs"+query("path", path), r.o.Limits.Dirs)
}

// Usage serves GET /api/usage/{agent}?fresh=&server=<entry> for a remote entry: the agent's
// plan usage there, as that server answers. Its other answers are those of Dirs.
func (r *Relay) Usage(ctx context.Context, entry, agent string, fresh bool) Reply {
	f := ""
	if fresh {
		f = "1"
	}
	return r.passEntry(ctx, entry, "/api/usage/"+url.PathEscape(agent)+query("fresh", f), r.o.Limits.Usage)
}

func (r *Relay) passEntry(ctx context.Context, entry, path string, limit time.Duration) Reply {
	if !r.Listed(entry) {
		return (&Error{Status: http.StatusNotFound, Text: servers.ErrNotFound.Error(), cause: servers.ErrNotFound}).Reply()
	}
	rep, err := r.call(ctx, entry, http.MethodGet, path, nil, limit)
	if err != nil {
		return r.unmade(entry, err).Reply()
	}
	return r.handed(entry, rep)
}
