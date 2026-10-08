package remotes

// The calls of a page for a record, one method per route of the local server. Each one answers
// with a Reply, the status and the JSON to write as they are, or with an error whose Reply is
// ReplyOf's: the HTTP layer decodes the request and writes what it is given.
//
// A call that is passed on and cannot be made is answered by one table (unmade and refusal):
// the entry is not connected (503 server_unreachable, nothing was sent), no answer came (504
// no_answer), the answer was above the size limit (502 bad_answer), the server answered 401 (503 server_unreachable) or "no such chat" (the record is
// marked gone, 404 gone_there). None of them is 409: a page reads a chat again after a 409, and
// here it shall keep what it has. Every other answer is handed on with its status.
//
// A call that changes something is not ended by the page that asked for it: once it is sent,
// what it did there must be taken here (a record for a fork, a draft that is cleared), whether
// or not the page still waits. Such a call ends with its limit or with Close.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"sync"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/servers"
)

var (
	_ chats.RemoteServers = (*Relay)(nil)
	_ runs.Remote         = (*Relay)(nil)
)

// Reply is the answer to a page's call: the status, and the JSON body to write as it is.
type Reply struct {
	Status int
	Body   []byte
}

// Error is a call that was refused or could not be made, with what the page gets: the status,
// the code ("" for none) and the sentence. errors.Is finds its cause (ErrUnreachable,
// ErrNoAnswer, ErrGone, ErrConnected, chats.ErrNotFound, …).
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

// ReplyOf is the answer for what Archive, Unarchive, Delete, Deletable and Move, and the same
// for runs, return: 200 {"ok":true} for nil, an *Error as it says, "no such chat" and "no such
// run" as 404, anything else as 500.
func ReplyOf(err error) Reply {
	var e *Error
	switch {
	case err == nil:
		return okReply
	case errors.As(err, &e):
		return e.Reply()
	case errors.Is(err, chats.ErrNotFound):
		return noChat().Reply()
	case errors.Is(err, runs.ErrNotFound):
		return noRun().Reply()
	}
	return jsonReply(http.StatusInternalServerError, map[string]string{"error": err.Error()})
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

func noChat() *Error {
	return &Error{Status: http.StatusNotFound, Text: chats.ErrNotFound.Error(), cause: chats.ErrNotFound}
}

func (r *Relay) unreachable(entry string) *Error {
	return &Error{Status: http.StatusServiceUnavailable, Code: "server_unreachable", Text: r.name(entry) + " is not connected.", cause: ErrUnreachable}
}

func (r *Relay) noAnswer(entry string) *Error {
	return &Error{Status: http.StatusGatewayTimeout, Code: "no_answer", Text: r.name(entry) + " did not answer.", cause: ErrNoAnswer}
}

func (r *Relay) goneThere(entry string) *Error {
	return &Error{Status: http.StatusNotFound, Code: "gone_there", Text: "This chat is no longer on " + r.name(entry) + ".", cause: ErrGone}
}

// badAnswer is for an answer this server cannot use: it is not what the call answers with.
func (r *Relay) badAnswer(entry string) *Error {
	return &Error{Status: http.StatusBadGateway, Code: "bad_answer", Text: r.name(entry) + " gave an answer that cannot be read."}
}

// unmade is the answer for a call that call returned an error for.
func (r *Relay) unmade(entry string, err error) *Error {
	switch {
	case errors.Is(err, ErrUnreachable):
		return r.unreachable(entry)
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

// errorOf is an answer that is no success as an *Error: the server's status, code and sentence.
func (r *Relay) errorOf(entry string, rep servers.Reply) *Error {
	s := saidIn(rep)
	if s.Error == "" {
		s.Error = fmt.Sprintf("%s answered with status %d.", r.name(entry), rep.Status)
	}
	return &Error{Status: rep.Status, Code: s.Code, Text: s.Error}
}

// noSuchChat reports whether the answer says that the server has no chat with the id.
func noSuchChat(rep servers.Reply) bool {
	return rep.Status == http.StatusNotFound && saidIn(rep).Error == chats.ErrNotFound.Error()
}

// refusal is the answer for the two answers of a record's server that are not handed on: 401,
// which is the entry's matter and not the chat's, and "no such chat", which marks the record
// gone. nil for every other answer.
func (r *Relay) refusal(rec *record, rep servers.Reply) *Error {
	switch {
	case rep.Status == http.StatusUnauthorized:
		return r.unreachable(rec.entry)
	case noSuchChat(rep):
		r.markGone(rec)
		return r.goneThere(rec.entry)
	}
	return nil
}

// markGone notes that the record's chat is no longer on its server, and tells the pages.
func (r *Relay) markGone(rec *record) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed || rec.d.Gone {
		return
	}
	rec.d.Gone = true
	r.keep(rec, true)
	r.emitChat(rec)
}

// do passes a call for the record on. A nil error means that rep is the server's answer, to be
// read or handed on, whatever its status.
func (r *Relay) do(ctx context.Context, rec *record, method, path string, body []byte, limit time.Duration) (servers.Reply, *Error) {
	rep, err := r.call(ctx, rec.entry, method, path, body, limit)
	if err != nil {
		return rep, r.unmade(rec.entry, err)
	}
	return rep, r.refusal(rec, rep)
}

// read is do for a read that makes the page client a follower of the chat. A chat that is gone
// has no follower.
func (r *Relay) read(ctx context.Context, rec *record, client, path string, limit time.Duration) (servers.Reply, *Error) {
	rep, err := r.follow(ctx, rec, client, http.MethodGet, path, limit)
	if err != nil {
		return rep, r.unmade(rec.entry, err)
	}
	e := r.refusal(rec, rep)
	if e != nil && errors.Is(e, ErrGone) {
		r.o.Bridge.UnfollowAs(editorbridge.KindPage, client, editorbridge.Chat(rec.id))
	}
	return rep, e
}

// handed is a server's answer as the page gets it: its status and its body. A body that is no
// JSON is not handed on.
func (r *Relay) handed(entry string, rep servers.Reply) Reply {
	if !json.Valid(rep.Body) {
		e := r.badAnswer(entry)
		if rep.Status >= 400 {
			e.Status = rep.Status
		}
		return e.Reply()
	}
	return Reply{Status: rep.Status, Body: rep.Body}
}

// pass is a call that is passed on and answered as its answer came.
func (r *Relay) pass(ctx context.Context, id, method, rest string, body []byte, limit time.Duration) Reply {
	rec := r.rec(id)
	if rec == nil {
		return noChat().Reply()
	}
	rep, e := r.do(ctx, rec, method, chatPath(id, rest), body, limit)
	if e != nil {
		return e.Reply()
	}
	return r.handed(rec.entry, rep)
}

// lasting is the context of a call that changes something: the page that asked does not end it.
func (r *Relay) lasting(context.Context) context.Context { return r.ctx }

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

// ---- the routes of a record ----

// Get serves GET /api/chats/{id}: the chat's view is read from its server, the record takes it,
// and the answer is the record's view.
func (r *Relay) Get(ctx context.Context, id string) Reply {
	rec := r.rec(id)
	if rec == nil {
		return noChat().Reply()
	}
	if e := r.readView(ctx, rec, false, false); e != nil {
		return e.Reply()
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return jsonReply(http.StatusOK, r.pageView(viewOf(rec.d)))
}

// readView reads the chat's view from its server. The record takes it unless a view of the chat
// came since the read was sent. sole says that the chat has its first branch alone (it has just
// started, or is a new fork): the view is then that branch's state too. The pages are told what
// changed: the view, and with sole the state. With always they get state and view whether or
// not anything changed, and whether or not the read worked.
func (r *Relay) readView(ctx context.Context, rec *record, sole, always bool) *Error {
	since := rec.stamp()
	v, e := r.viewThere(ctx, rec)
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed {
		return e
	}
	changed := e == nil && r.takeView(rec, since, v, sole)
	switch {
	case always, changed && sole:
		r.emit(rec)
	case changed:
		r.emitChat(rec)
	}
	return e
}

// viewThere is the chat's view as its server answers it now.
func (r *Relay) viewThere(ctx context.Context, rec *record) (model.ChatView, *Error) {
	var v model.ChatView
	rep, e := r.do(ctx, rec, http.MethodGet, chatPath(rec.id, ""), nil, r.o.Limits.Call)
	switch {
	case e != nil:
		return v, e
	case rep.Status != http.StatusOK:
		return v, r.errorOf(rec.entry, rep)
	case json.Unmarshal(rep.Body, &v) != nil || v.ID != rec.id:
		return v, r.badAnswer(rec.entry)
	}
	return v, nil
}

// takeView is the taking of a view that a call sent at the mark since answered with: see take.
// With sole the view is the first branch's state too. It reports whether the pages have
// something to be told: the caller sends the events, in this hold of rec.mu.
func (r *Relay) takeView(rec *record, since uint64, v model.ChatView, sole bool) (changed bool) {
	was := rec.d.View
	taken, durable := rec.take(since, v)
	if !taken {
		return false
	}
	changed = !sameView(was, v)
	if sole && changed {
		rec.d.setState(model.StateOf(rec.id, mainBranch, v))
	}
	r.keep(rec, durable)
	return changed || durable
}

// sameView reports whether two views of a chat as its server sent them say the same. The draft
// there is not looked at: a record's drafts are kept here.
func sameView(a, b model.ChatView) bool {
	a.Draft, b.Draft = nil, nil
	a.Created, b.Created = time.Time{}, time.Time{}
	return a == b
}

// Items serves GET /api/chats/{id}/items?branch=: the page client follows the chat, and the
// read is passed on. In the answer "state" gets the draft and the draft counter this server
// keeps for the state's branch; the rest is what came.
func (r *Relay) Items(ctx context.Context, id, client, branch string) Reply {
	rec := r.rec(id)
	if rec == nil {
		return noChat().Reply()
	}
	rep, e := r.read(ctx, rec, client, chatPath(id, "/items")+query("branch", branch), r.o.Limits.Call)
	if e != nil {
		return e.Reply()
	}
	out := r.handed(rec.entry, rep)
	if rep.Status == http.StatusOK {
		rec.mu.Lock()
		out.Body = withDraftState(out.Body, rec.d)
		rec.mu.Unlock()
	}
	return out
}

// withDraftState is the answer of an items read with the record's draft in its "state".
func withDraftState(body []byte, d Record) []byte {
	f, ok := fields(body, "state")
	if !ok || len(f["state"]) == 0 {
		return body
	}
	var st struct {
		Branch string `json:"branch"`
	}
	if json.Unmarshal(f["state"], &st) != nil {
		return body
	}
	if st.Branch == "" {
		st.Branch = mainBranch
	}
	set := map[string]json.RawMessage{"draft": nil, "draftRev": nil}
	if draft := d.Drafts[st.Branch]; draft != nil {
		set["draft"], _ = json.Marshal(draft)
	}
	if rev := d.DraftRevs[st.Branch]; rev != 0 {
		set["draftRev"], _ = json.Marshal(rev)
	}
	state, ok := setMembers(f["state"], set)
	if !ok {
		return body
	}
	out, ok := setMembers(body, map[string]json.RawMessage{"state": state})
	if !ok {
		return body
	}
	return out
}

// setMembers is the JSON object raw with its members named in set replaced by set's values, in
// their places, or left out for a nil value; a member raw does not have is added at the end.
// Every other member keeps its value as it came. ok is false when raw is no object.
func setMembers(raw []byte, set map[string]json.RawMessage) (out []byte, ok bool) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil, false
	}
	var buf bytes.Buffer
	put := func(key string, v json.RawMessage) {
		if buf.Len() == 0 {
			buf.WriteByte('{')
		} else {
			buf.WriteByte(',')
		}
		k, _ := json.Marshal(key)
		buf.Write(k)
		buf.WriteByte(':')
		buf.Write(v)
	}
	done := map[string]bool{}
	var order []string
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return nil, false
		}
		key, _ := t.(string)
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, false
		}
		if nv, named := set[key]; named {
			if !done[key] && nv != nil {
				put(key, nv)
			}
			done[key] = true
			continue
		}
		put(key, v)
	}
	for key := range set {
		if !done[key] && set[key] != nil {
			order = append(order, key)
		}
	}
	sort.Strings(order) // a fixed order: "draft" before "draftRev", as a state is written
	for _, key := range order {
		put(key, set[key])
	}
	if buf.Len() == 0 {
		buf.WriteByte('{')
	}
	buf.WriteByte('}')
	return buf.Bytes(), true
}

// Tree serves GET /api/chats/{id}/tree: a read that follows, answered as it came.
func (r *Relay) Tree(ctx context.Context, id, client string) Reply {
	return r.followed(ctx, id, client, "/tree")
}

// SubItems serves GET /api/chats/{id}/subagents/{sid}/items?branch=: a read that follows,
// answered as it came.
func (r *Relay) SubItems(ctx context.Context, id, client, branch, sub string) Reply {
	return r.followed(ctx, id, client, "/subagents/"+url.PathEscape(sub)+"/items"+query("branch", branch))
}

func (r *Relay) followed(ctx context.Context, id, client, rest string) Reply {
	rec := r.rec(id)
	if rec == nil {
		return noChat().Reply()
	}
	rep, e := r.read(ctx, rec, client, chatPath(id, rest), r.o.Limits.Call)
	if e != nil {
		return e.Reply()
	}
	return r.handed(rec.entry, rep)
}

// Context serves GET /api/chats/{id}/context?branch=&fresh=: passed on. With fresh the agent is
// asked, which may have to start.
func (r *Relay) Context(ctx context.Context, id, branch string, fresh bool) Reply {
	limit, f := r.o.Limits.Call, ""
	if fresh {
		limit, f = r.o.Limits.Start, "1"
	}
	return r.pass(ctx, id, http.MethodGet, "/context"+query("branch", branch, "fresh", f), nil, limit)
}

// Send serves POST /api/chats/{id}/messages?branch= for a record; body is the request's JSON,
// passed on as it is. An archived record is refused here, and nothing is sent. When the server
// took the message, the draft of the branch it was put on is cleared. No answer is 504
// send_unknown: the page keeps the text.
func (r *Relay) Send(ctx context.Context, id, branch string, body []byte) Reply {
	rec := r.rec(id)
	if rec == nil {
		return noChat().Reply()
	}
	if e := r.archived(rec); e != nil {
		return e.Reply()
	}
	rep, e := r.do(r.lasting(ctx), rec, http.MethodPost, chatPath(id, "/messages")+query("branch", branch), body, r.o.Limits.Start)
	if e != nil {
		if errors.Is(e, ErrNoAnswer) {
			e.Code, e.Text = "send_unknown", r.name(rec.entry)+" did not answer: it is not known whether the message arrived."
		}
		return e.Reply()
	}
	if rep.Status == http.StatusOK {
		var ans struct {
			Branch string `json:"branch"`
		}
		_ = json.Unmarshal(rep.Body, &ans)
		if ans.Branch == "" {
			ans.Branch = mainBranch
		}
		r.clearDraft(rec, ans.Branch)
	}
	return r.handed(rec.entry, rep)
}

// archived is the refusal of a send or a change of model, effort or folder for a record that is
// archived, or is being archived; nil for one that is not.
func (r *Relay) archived(rec *record) *Error {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if viewOf(rec.d).Archived {
		return &Error{Status: http.StatusConflict, Text: chats.ErrArchived.Error(), cause: chats.ErrArchived}
	}
	return nil
}

// Interrupt serves POST /api/chats/{id}/interrupt?branch=: passed on.
func (r *Relay) Interrupt(ctx context.Context, id, branch string) Reply {
	return r.pass(r.lasting(ctx), id, http.MethodPost, "/interrupt"+query("branch", branch), nil, r.o.Limits.Call)
}

// Permission serves POST /api/chats/{id}/permission?branch=; body is the request's JSON, passed on.
func (r *Relay) Permission(ctx context.Context, id, branch string, body []byte) Reply {
	return r.pass(r.lasting(ctx), id, http.MethodPost, "/permission"+query("branch", branch), body, r.o.Limits.Call)
}

// OpenChat serves POST /api/chats/{id}/open?branch=: passed on. The agent may have to start.
func (r *Relay) OpenChat(ctx context.Context, id, branch string) Reply {
	return r.pass(r.lasting(ctx), id, http.MethodPost, "/open"+query("branch", branch), nil, r.o.Limits.Start)
}

// Label serves PUT /api/chats/{id}/label; body is the request's JSON, passed on.
func (r *Relay) Label(ctx context.Context, id string, body []byte) Reply {
	return r.pass(r.lasting(ctx), id, http.MethodPut, "/label", body, r.o.Limits.Call)
}

// Unfollow serves POST /api/chats/{id}/unfollow: the page client's follow ends here. When it
// was the chat's last one, the bridge tells the relay, which ends this server's follow there
// (see Unfollowed).
func (r *Relay) Unfollow(id, client string) Reply {
	r.o.Bridge.UnfollowAs(editorbridge.KindPage, client, editorbridge.Chat(id))
	return okReply
}

// PatchReq is the body of PATCH /api/chats/{id}.
type PatchReq struct {
	Name               *string
	Group              *string
	Server             string
	Agent              model.AgentKind
	Model, Effort, Cwd string
}

// Patch serves PATCH /api/chats/{id}?branch= for a record. The group is the chat's place here:
// it must exist and not be archived, and nothing is sent for it. The name, and model, effort
// and folder of the branch, are passed on in one call; the three are refused for an archived
// record. Server and agent are fixed: the chat has started. Nothing is changed when any part is
// refused here, and the place is not changed when the server refuses its part. The answer is
// {"ok":true,"chat":…} with the record's view.
func (r *Relay) Patch(ctx context.Context, id, branch string, p PatchReq) Reply {
	rec := r.rec(id)
	if rec == nil {
		return noChat().Reply()
	}
	if p.Server != "" || p.Agent != "" {
		return (&Error{Status: http.StatusConflict, Text: chats.ErrAgentFixed.Error(), cause: chats.ErrAgentFixed}).Reply()
	}
	if p.Group != nil {
		if e := r.groupFor(*p.Group); e != nil {
			return e.Reply()
		}
	}
	there := map[string]string{}
	if p.Model != "" || p.Effort != "" || p.Cwd != "" {
		if e := r.archived(rec); e != nil {
			return e.Reply()
		}
		for k, v := range map[string]string{"model": p.Model, "effort": p.Effort, "cwd": p.Cwd} {
			if v != "" {
				there[k] = v
			}
		}
	}
	if p.Name != nil {
		there["name"] = *p.Name
	}
	if len(there) > 0 {
		body, _ := json.Marshal(there)
		since := rec.stamp()
		rep, e := r.do(r.lasting(ctx), rec, http.MethodPatch, chatPath(id, "")+query("branch", branch), body, r.o.Limits.Call)
		if e != nil {
			return e.Reply()
		}
		if rep.Status != http.StatusOK {
			return r.handed(rec.entry, rep)
		}
		var ans struct {
			Chat *model.ChatView `json:"chat"`
		}
		if json.Unmarshal(rep.Body, &ans) == nil && ans.Chat != nil && ans.Chat.ID == id {
			rec.mu.Lock()
			if r.takeView(rec, since, *ans.Chat, false) {
				r.emitChat(rec)
			}
			rec.mu.Unlock()
		}
	}
	if p.Group != nil {
		if err := r.Move(id, *p.Group); err != nil {
			return ReplyOf(err)
		}
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return jsonReply(http.StatusOK, map[string]any{"ok": true, "chat": r.pageView(viewOf(rec.d))})
}

// groupFor is the refusal of a group as a record's place: one that is not named, does not
// exist or is archived.
func (r *Relay) groupFor(group string) *Error {
	switch {
	case group == "":
		return &Error{Status: http.StatusBadRequest, Text: `group is empty (use "` + model.Ungrouped + `" for ungrouped)`}
	case group == model.Ungrouped || r.o.Group == nil:
		return nil
	}
	switch exists, archived := r.o.Group(group); {
	case !exists:
		return &Error{Status: http.StatusNotFound, Text: "no such group"}
	case archived:
		return &Error{Status: http.StatusConflict, Text: "the group is archived"}
	}
	return nil
}

// Move puts the record in the group, its place in this server's sidebar, and tells the pages.
// The group is not checked: Patch does that for a page's move, and the delete of a group moves
// its records to the parent with this. Nothing is sent to the chat's server.
func (r *Relay) Move(id, group string) error {
	rec := r.rec(id)
	if rec == nil {
		return chats.ErrNotFound
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed {
		return chats.ErrNotFound
	}
	if rec.d.Group != group {
		rec.d.Group = group
		r.keep(rec, true)
		r.emitChat(rec)
	}
	return nil
}

// Fork serves POST /api/chats/{id}/fork; body is the request's JSON, passed on. The server
// makes the fork and answers its view. A record is made for it: in the source's place, with the
// answer's draft (the message of "Fork and edit") as the draft of its first branch. Its view is
// then read once, since its first events came before the record was there. The answer is the
// fork's view as this server keeps it.
func (r *Relay) Fork(ctx context.Context, id string, body []byte) Reply {
	rec := r.rec(id)
	if rec == nil {
		return noChat().Reply()
	}
	ctx = r.lasting(ctx)
	rep, e := r.do(ctx, rec, http.MethodPost, chatPath(id, "/fork"), body, r.o.Limits.Start)
	if e != nil {
		return e.Reply()
	}
	if rep.Status != http.StatusOK {
		return r.handed(rec.entry, rep)
	}
	var v model.ChatView
	if json.Unmarshal(rep.Body, &v) != nil || v.ID == "" || v.ID == id {
		return r.badAnswer(rec.entry).Reply()
	}
	// The other server names the fork. An id that is a chat's here would put the record in that
	// chat's place: its routes and its row would be the fork's.
	if r.o.Local != nil && validID(v.ID) && r.o.Local.Known(v.ID) {
		r.o.Logf("remotes: no record is made for the fork %q of the chat %s: the id is a chat's here", v.ID, id)
		return r.badAnswer(rec.entry).Reply()
	}
	rec.mu.Lock()
	d := Record{ID: v.ID, Entry: rec.entry, Group: rec.d.Group, Run: rec.d.Run, View: v,
		States: []model.BranchState{model.StateOf(v.ID, mainBranch, v)}}
	rec.mu.Unlock()
	if v.Draft != nil {
		draft := *v.Draft
		d.Drafts = map[string]*model.Draft{mainBranch: &draft}
		d.DraftRevs = map[string]int64{mainBranch: 1}
	}
	fork, err := r.adopt(d)
	if err != nil {
		r.o.Logf("remotes: no record is made for the fork %q of the chat %s: %v", short(v.ID), id, err)
		return r.badAnswer(rec.entry).Reply()
	}
	// The read sends the fork's state and view; when it fails they are the answer's, which the
	// fork's next event corrects.
	_ = r.readView(ctx, fork, true, true)
	fork.mu.Lock()
	defer fork.mu.Unlock()
	return jsonReply(http.StatusOK, r.pageView(viewOf(fork.d)))
}

// short is an id cut for a log line.
func short(id string) string {
	if len(id) > 64 {
		return id[:64]
	}
	return id
}

// ---- the routes that take the entry ----

// Dirs serves GET /api/dirs?path=&server=<entry> for a remote entry: the folders there, as that
// server answers. An entry that is not in the list is 404 "no such server".
func (r *Relay) Dirs(ctx context.Context, entry, path string) Reply {
	return r.passEntry(ctx, entry, "/api/dirs"+query("path", path), r.o.Limits.Dirs)
}

// Usage serves GET /api/usage/{agent}?fresh=&server=<entry> for a remote entry: the agent's
// plan usage there, as that server answers.
func (r *Relay) Usage(ctx context.Context, entry, agent string, fresh bool) Reply {
	f := ""
	if fresh {
		f = "1"
	}
	return r.passEntry(ctx, entry, "/api/usage/"+url.PathEscape(agent)+query("fresh", f), r.o.Limits.Usage)
}

func (r *Relay) passEntry(ctx context.Context, entry, path string, limit time.Duration) Reply {
	if _, ok := r.Entry(entry); !ok {
		return (&Error{Status: http.StatusNotFound, Text: chats.ErrServerUnknown.Error(), cause: chats.ErrServerUnknown}).Reply()
	}
	rep, err := r.call(ctx, entry, http.MethodGet, path, nil, limit)
	switch {
	case err != nil:
		return r.unmade(entry, err).Reply()
	case rep.Status == http.StatusUnauthorized:
		return r.unreachable(entry).Reply()
	}
	return r.handed(entry, rep)
}

// ---- what the chat manager asks (chats.RemoteServers) ----

// Dir is the folder path names on the entry's server, absolute, as that server says:
// chats.ErrServerUnreachable when the entry is not connected, and an error that is
// agent.ErrFolderMissing to errors.Is, with that server's sentence, when it is no folder there.
func (r *Relay) Dir(entry, path string) (abs string, err error) {
	rep, err := r.call(r.ctx, entry, http.MethodGet, "/api/dirs"+query("path", path), nil, r.o.Limits.Dirs)
	switch {
	case errors.Is(err, ErrUnreachable):
		return "", chats.ErrServerUnreachable
	case err != nil:
		return "", r.unmade(entry, err)
	case rep.Status == http.StatusUnauthorized:
		return "", chats.ErrServerUnreachable
	case rep.Status == http.StatusBadRequest:
		return "", fmt.Errorf("%w: %s", agent.ErrFolderMissing, r.errorOf(entry, rep).Text)
	case rep.Status != http.StatusOK:
		return "", r.errorOf(entry, rep)
	}
	var ans struct {
		Path string `json:"path"`
	}
	if json.Unmarshal(rep.Body, &ans) != nil || ans.Path == "" {
		return "", r.badAnswer(entry)
	}
	return ans.Path, nil
}

// DropLeftover deletes, on the entry's server, a chat that a first message left there
// unstarted: in the background, and only when the entry is connected. A failure is logged; the
// chat then stays there.
func (r *Relay) DropLeftover(entry, chat string) {
	if !validID(chat) || !r.connected(entry) {
		return
	}
	r.spawn(func() {
		// Not through call: an entry that is not connected is not woken for this.
		rep, err := r.o.Servers.Do(r.ctx, entry, http.MethodDelete, chatPath(chat, ""), nil, r.o.Limits.Call)
		switch {
		case err == nil && (rep.Status == http.StatusOK || rep.Status == http.StatusNotFound), r.ctx.Err() != nil:
		case err != nil:
			r.o.Logf("remotes: the unstarted chat %s is not deleted on the server %s: no answer", chat, entry)
		default:
			r.o.Logf("remotes: the unstarted chat %s is not deleted on the server %s: status %d", chat, entry, rep.Status)
		}
	})
}

// ---- what the run service asks (runs.Remote; Entry and ByKey are in lists.go) ----

// CheckDraft is the draft check of the entry's server: what a draft run of the agent a in the
// folder cwd would show on that machine. It waits Limits.Check at most. The error is
// chats.ErrServerUnreachable when the entry is not connected, runs.ErrRunsUnsupported for a
// server that has no run routes, and else an *Error with the server's sentence or with what
// kept the answer away.
func (r *Relay) CheckDraft(entry string, a model.AgentKind, cwd string) (runs.DraftFacts, error) {
	var facts runs.DraftFacts
	rep, err := r.call(r.ctx, entry, http.MethodGet, "/api/runs/check"+query("agent", string(a), "cwd", cwd), nil, r.o.Limits.Check)
	switch {
	case errors.Is(err, ErrUnreachable):
		return facts, chats.ErrServerUnreachable
	case err != nil:
		return facts, r.unmade(entry, err)
	case rep.Status == http.StatusUnauthorized:
		return facts, chats.ErrServerUnreachable
	case noRunRoutes(rep):
		return facts, runs.ErrRunsUnsupported
	case rep.Status != http.StatusOK:
		return facts, r.errorOf(entry, rep)
	}
	if json.Unmarshal(rep.Body, &facts) != nil || facts.Cwd == "" {
		return runs.DraftFacts{}, r.badAnswer(entry)
	}
	return facts, nil
}

// RunInfo is what a chat on the run needs of a run record: its place and mark here, its folder,
// its agent kind, what its deep tier runs on, and its server. ok is false for an id without a
// record and for a record that is gone. It only looks up: the chat manager and the run service
// call it with a lock held.
func (r *Relay) RunInfo(run string) (chats.RunInfo, bool) {
	rec := r.runRec(run)
	if rec == nil {
		return chats.RunInfo{}, false
	}
	v := rec.view()
	if v.Gone {
		return chats.RunInfo{}, false
	}
	return chats.RunInfo{Group: v.Group, Archived: v.Archived, Cwd: v.Cwd, Agent: v.Agent,
		Model: v.Tiers.Deep.Model, Effort: v.Tiers.Deep.Effort, Server: rec.entry}, true
}

// DropRun deletes, on the entry's server, the run that a start call may have made there for a
// draft that was deleted here: in the background, and only when the entry is connected. A
// failure is logged; the run then stays there.
func (r *Relay) DropRun(entry, run string) {
	r.dropGoal(run) // the draft is gone
	if !runs.ValidID(run) || !r.connected(entry) {
		return
	}
	r.spawn(func() {
		// Not through call: an entry that is not connected is not woken for this.
		rep, err := r.o.Servers.Do(r.ctx, entry, http.MethodDelete, runPath(run, ""), nil, r.o.Limits.RunDelete)
		switch {
		case err == nil && (rep.Status == http.StatusOK || rep.Status == http.StatusNotFound), r.ctx.Err() != nil:
		case err != nil:
			r.o.Logf("remotes: the run %s of a deleted draft is not deleted on the server %s: no answer", run, entry)
		default:
			r.o.Logf("remotes: the run %s of a deleted draft is not deleted on the server %s: status %d", run, entry, rep.Status)
		}
	})
}

// ---- locks by chat id ----

// opLocks are the locks of the operations that must not run twice at once for one chat or run.
type opLocks struct {
	start      idLocks // the first message of a chat: its creation call, or its settling
	archive    idLocks // the passing on of a record's archive change: one at a time, in order
	runStart   idLocks // the start of a run: its start call, or its settling
	runArchive idLocks // the passing on of a run record's archive change
}

// idLocks is a lock per id. The zero value is ready.
type idLocks struct {
	mu   sync.Mutex
	held map[string]*idLock
}

type idLock struct {
	mu sync.Mutex
	n  int // holders and waiters
}

// lock takes the id's lock, waiting for it.
func (l *idLocks) lock(id string) (unlock func()) {
	unlock, _ = l.take(id, true)
	return unlock
}

// try takes the id's lock unless it is held.
func (l *idLocks) try(id string) (unlock func(), ok bool) { return l.take(id, false) }

// busy reports whether the id's lock is held now.
func (l *idLocks) busy(id string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.held[id] != nil
}

func (l *idLocks) take(id string, wait bool) (unlock func(), ok bool) {
	l.mu.Lock()
	k := l.held[id]
	if k != nil && !wait {
		l.mu.Unlock()
		return nil, false
	}
	if k == nil {
		if l.held == nil {
			l.held = map[string]*idLock{}
		}
		k = &idLock{}
		l.held[id] = k
	}
	k.n++
	l.mu.Unlock()
	k.mu.Lock()
	return func() {
		k.mu.Unlock()
		l.mu.Lock()
		if k.n--; k.n == 0 {
			delete(l.held, id)
		}
		l.mu.Unlock()
	}, true
}
