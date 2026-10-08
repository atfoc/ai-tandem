package remotes

// The calls of a page for a run record and for the chat of one of its agents, one method per
// route of the local server. Each one answers with a Reply, the status and the JSON to write
// as they are.
//
// A call that is passed on and cannot be made is answered by the table of a chat record's calls
// (see ops.go), with the run's words: the entry is not connected (503 server_unreachable,
// nothing was sent), no answer came (504 no_answer), the answer was above the size limit (502
// bad_answer), the server answered 401 (503 server_unreachable) or exactly "no such run" (the
// record is marked gone, 404 gone_there). Every other answer is handed on with its status: "no
// such task" and "nothing recorded yet" say nothing of the run. A run view in an answer that
// names another run than the one asked for is not taken: 502 bad_answer.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/servers"
)

// ---- the answers of a call that cannot be made ----

func noRun() *Error {
	return &Error{Status: http.StatusNotFound, Text: runs.ErrNotFound.Error(), cause: runs.ErrNotFound}
}

func (r *Relay) runGoneThere(entry string) *Error {
	return &Error{Status: http.StatusNotFound, Code: "gone_there", Text: "This run is no longer on " + r.name(entry) + ".", cause: ErrGone}
}

// noSuchRun reports whether the answer says that the server has no run with the id.
func noSuchRun(rep servers.Reply) bool {
	return rep.Status == http.StatusNotFound && saidIn(rep).Error == runs.ErrNotFound.Error()
}

// runRefusal is the answer for the two answers of a run record's server that are not handed on:
// 401, which is the entry's matter and not the run's, and "no such run", which marks the record
// gone. nil for every other answer.
func (r *Relay) runRefusal(rec *runRecord, rep servers.Reply) *Error {
	switch {
	case rep.Status == http.StatusUnauthorized:
		return r.unreachable(rec.entry)
	case noSuchRun(rep):
		r.markRunGone(rec)
		return r.runGoneThere(rec.entry)
	}
	return nil
}

// runDo passes a call for the run record on. A nil error means that rep is the server's answer,
// to be read or handed on, whatever its status.
func (r *Relay) runDo(ctx context.Context, rec *runRecord, method, path string, body []byte, limit time.Duration) (servers.Reply, *Error) {
	rep, err := r.call(ctx, rec.entry, method, path, body, limit)
	if err != nil {
		return rep, r.unmade(rec.entry, err)
	}
	return rep, r.runRefusal(rec, rep)
}

// runReply is 200 with the record's view, as a page gets it.
func (r *Relay) runReply(rec *runRecord) Reply {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return jsonReply(http.StatusOK, runViewOf(rec.d))
}

// takeAnswer takes the run's view that a call sent at the mark since answered with, rep being a
// 200. A body that is no view of this run is not taken.
func (r *Relay) takeAnswer(rec *runRecord, since uint64, rep servers.Reply) *Error {
	var v model.RunView
	if json.Unmarshal(rep.Body, &v) != nil || v.ID != rec.id {
		return r.badAnswer(rec.entry)
	}
	r.takeRun(rec, since, v)
	return nil
}

// readRun reads the run's view from its server. The record takes it unless a view of the run
// came since the read was sent; the pages are told if it changed what they get.
func (r *Relay) readRun(ctx context.Context, rec *runRecord) *Error {
	since := rec.stamp()
	rep, e := r.runDo(ctx, rec, http.MethodGet, runPath(rec.id, ""), nil, r.o.Limits.Call)
	switch {
	case e != nil:
		return e
	case rep.Status != http.StatusOK:
		return r.errorOf(rec.entry, rep)
	}
	return r.takeAnswer(rec, since, rep)
}

// withQuery is path with the query of a page's request, read and written again: "" adds nothing.
func withQuery(path, rawQuery string) string {
	q, _ := url.ParseQuery(rawQuery) // what cannot be read is left out
	if len(q) == 0 {
		return path
	}
	return path + "?" + q.Encode()
}

// under is the path rest ("/a/b") as it is sent, when its parts match want: a part of want that
// is "" stands for one value, which is escaped. ok is false for any other path.
func under(rest string, want ...string) (path string, ok bool) {
	parts := strings.Split(strings.TrimPrefix(rest, "/"), "/")
	if !strings.HasPrefix(rest, "/") || len(parts) != len(want) {
		return "", false
	}
	for i, p := range parts {
		if p == "" || (want[i] != "" && want[i] != p) {
			return "", false
		}
		path += "/" + url.PathEscape(p)
	}
	return path, true
}

var notFound = Reply{Status: http.StatusNotFound, Body: []byte(`{"error":"not found"}`)}

// ---- the routes of a run record ----

// RunGet serves GET /api/runs/{id}: the run's view is read from its server, the record takes
// it, and the answer is the record's view.
func (r *Relay) RunGet(ctx context.Context, id string) Reply {
	rec := r.runRec(id)
	if rec == nil {
		return noRun().Reply()
	}
	if e := r.readRun(ctx, rec); e != nil {
		return e.Reply()
	}
	return r.runReply(rec)
}

// RunDetail serves GET /api/runs/{id}/detail: the page client follows the run, the read is
// passed on, the agents the answer names are learned, and the answer is the bytes that came.
func (r *Relay) RunDetail(ctx context.Context, id, client string) Reply {
	rec := r.runRec(id)
	if rec == nil {
		return noRun().Reply()
	}
	rep, err := r.followRun(ctx, rec, client, http.MethodGet, runPath(id, "/detail"), r.o.Limits.Call)
	if err != nil {
		return r.unmade(rec.entry, err).Reply()
	}
	if e := r.runRefusal(rec, rep); e != nil {
		if errors.Is(e, ErrGone) {
			r.o.Bridge.UnfollowAs(editorbridge.KindPage, client, editorbridge.Run(id))
		}
		return e.Reply()
	}
	if rep.Status == http.StatusOK {
		r.learnDetail(rec, rep.Body)
	}
	return r.handed(rec.entry, rep)
}

// RunRead serves the reads of a run's texts, rest being the path after the id: /goal,
// /delivery, /tasks/{tid}/brief, /tasks/{tid}/attempts/{n}/report, …/changes and /notes/{v}.
// Each is passed on with the request's query and answered as it came. Any other rest is 404.
func (r *Relay) RunRead(ctx context.Context, id, rest, rawQuery string) Reply {
	rec := r.runRec(id)
	if rec == nil {
		return noRun().Reply()
	}
	var path string
	for _, want := range [][]string{
		{"goal"}, {"delivery"}, {"notes", ""}, {"tasks", "", "brief"},
		{"tasks", "", "attempts", "", "report"}, {"tasks", "", "attempts", "", "changes"},
	} {
		if p, ok := under(rest, want...); ok {
			path = p
		}
	}
	if path == "" {
		return notFound
	}
	rep, e := r.runDo(ctx, rec, http.MethodGet, withQuery(runPath(id, path), rawQuery), nil, r.o.Limits.Call)
	if e != nil {
		return e.Reply()
	}
	return r.handed(rec.entry, rep)
}

// RunDo serves POST /api/runs/{id}/stop, /resume and /apply (verb), with the request's body
// passed on as it is. After a stop or a resume the record takes the answer's view, and the
// answer is the record's view; the answer of an apply is handed on as it came. The call is not
// ended by the page that asked.
func (r *Relay) RunDo(ctx context.Context, id, verb string, body []byte) Reply {
	rec := r.runRec(id)
	if rec == nil {
		return noRun().Reply()
	}
	if verb != "stop" && verb != "resume" && verb != "apply" {
		return notFound
	}
	if len(bytes.TrimSpace(body)) == 0 {
		body = nil
	}
	since := rec.stamp()
	rep, e := r.runDo(r.lasting(ctx), rec, http.MethodPost, runPath(id, "/"+verb), body, r.o.Limits.Start)
	switch {
	case e != nil:
		return e.Reply()
	case verb == "apply" || rep.Status != http.StatusOK:
		return r.handed(rec.entry, rep)
	}
	if e := r.takeAnswer(rec, since, rep); e != nil {
		return e.Reply()
	}
	return r.runReply(rec)
}

// RunPatchReq is the body of PATCH /api/runs/{id}. The five raw members are a draft's choices:
// a record's run has started, so naming any of them is refused.
type RunPatchReq struct {
	Name, Group                         *string
	Server, Agent, Tiers, Cwd, Settings json.RawMessage
}

// named reports whether a member of a patch was given a value.
func named(raw json.RawMessage) bool {
	raw = bytes.TrimSpace(raw)
	return len(raw) > 0 && !bytes.Equal(raw, []byte("null"))
}

// RunPatch serves PATCH /api/runs/{id} for a run record. The group is the run's place here: it
// must exist and not be archived, and nothing is sent for it. The name is passed on, and the
// record takes the answer's view. Server, agent, tiers, folder and settings are fixed: the run
// has started (409, nothing sent). Nothing is changed when any part is refused here, and the
// place is not changed when the server refuses the name. The answer is the record's view.
func (r *Relay) RunPatch(ctx context.Context, id string, p RunPatchReq) Reply {
	rec := r.runRec(id)
	if rec == nil {
		return noRun().Reply()
	}
	for _, raw := range []json.RawMessage{p.Server, p.Agent, p.Tiers, p.Cwd, p.Settings} {
		if named(raw) {
			return (&Error{Status: http.StatusConflict, Text: runs.ErrStarted.Error(), cause: runs.ErrStarted}).Reply()
		}
	}
	if p.Group != nil {
		if e := r.groupFor(*p.Group); e != nil {
			return e.Reply()
		}
	}
	if p.Name != nil {
		body, _ := json.Marshal(map[string]string{"name": *p.Name})
		since := rec.stamp()
		rep, e := r.runDo(r.lasting(ctx), rec, http.MethodPatch, runPath(id, ""), body, r.o.Limits.Call)
		switch {
		case e != nil:
			return e.Reply()
		case rep.Status != http.StatusOK:
			return r.handed(rec.entry, rep)
		}
		if e := r.takeAnswer(rec, since, rep); e != nil {
			return e.Reply()
		}
	}
	if p.Group != nil {
		if err := r.MoveRun(id, *p.Group); err != nil {
			return ReplyOf(err)
		}
	}
	return r.runReply(rec)
}

// RunUnfollow serves POST /api/runs/{id}/unfollow: the page client's follow ends here. When it
// was the run's last one, the bridge tells the relay, which ends this server's follow there
// (see Unfollowed).
func (r *Relay) RunUnfollow(id, client string) Reply {
	r.o.Bridge.UnfollowAs(editorbridge.KindPage, client, editorbridge.Run(id))
	return okReply
}

// ---- the routes of a run agent's chat ----

// A run's agent is listed in the run's detail a moment before its chat can be read on the
// run's server. While that server answers "no such chat" for an agent's chat and the run is
// live, the read is made again every agentEvery, for agentWait at most; then the 404 is handed
// on. Nothing is marked gone by it.
const (
	agentEvery = 250 * time.Millisecond
	agentWait  = 2 * time.Second
)

// agentRead passes a read of the chat of a run's agent on and answers as it came. With follow
// the page client follows the chat, under its run's follow lock. With patient the read is
// repeated while the chat is not there yet (see agentEvery).
func (r *Relay) agentRead(ctx context.Context, chat, client, path string, limit time.Duration, follow, patient bool) Reply {
	rec := r.agentRun(chat)
	if rec == nil {
		return noChat().Reply()
	}
	for began := time.Now(); ; {
		var rep servers.Reply
		var err error
		if follow {
			rep, err = r.followAgent(ctx, rec, chat, client, http.MethodGet, path, limit)
		} else {
			rep, err = r.call(ctx, rec.entry, http.MethodGet, path, nil, limit)
		}
		switch {
		case err != nil:
			return r.unmade(rec.entry, err).Reply()
		case rep.Status == http.StatusUnauthorized:
			return r.unreachable(rec.entry).Reply()
		case !noSuchChat(rep):
			return r.handed(rec.entry, rep)
		}
		again := patient && time.Since(began)+r.agentEvery <= r.agentWait
		if v := rec.view(); v.Gone || !v.Status.Live() {
			again = false
		}
		if again {
			select {
			case <-ctx.Done():
				again = false
			case <-r.ctx.Done():
				again = false
			case <-time.After(r.agentEvery):
			}
		}
		if !again {
			if follow { // a chat that is not there has no follower
				r.o.Bridge.UnfollowAs(editorbridge.KindPage, client, editorbridge.Chat(chat))
			}
			return r.handed(rec.entry, rep)
		}
	}
}

// AgentView serves GET /api/chats/{id} for the chat of a run's agent: passed on, as it came.
func (r *Relay) AgentView(ctx context.Context, chat string) Reply {
	return r.agentRead(ctx, chat, "", chatPath(chat, ""), r.o.Limits.Call, false, true)
}

// AgentRead serves the reads of the chat of a run's agent that follow it, rest being the path
// after the id: /items, /tree and /subagents/{sid}/items. Each is passed on with the request's
// query and answered as it came. Any other rest is 404.
func (r *Relay) AgentRead(ctx context.Context, chat, client, rest, rawQuery string) Reply {
	var path string
	for _, want := range [][]string{{"items"}, {"tree"}, {"subagents", "", "items"}} {
		if p, ok := under(rest, want...); ok {
			path = p
		}
	}
	if path == "" {
		if r.agentRun(chat) == nil {
			return noChat().Reply()
		}
		return notFound
	}
	return r.agentRead(ctx, chat, client, withQuery(chatPath(chat, path), rawQuery), r.o.Limits.Call, true, path == "/items")
}

// AgentContext serves GET /api/chats/{id}/context for the chat of a run's agent: passed on with
// the request's query. With fresh the agent is asked, which may have to start.
func (r *Relay) AgentContext(ctx context.Context, chat, rawQuery string) Reply {
	limit := r.o.Limits.Call
	if q, _ := url.ParseQuery(rawQuery); q.Get("fresh") != "" {
		limit = r.o.Limits.Start
	}
	return r.agentRead(ctx, chat, "", withQuery(chatPath(chat, "/context"), rawQuery), limit, false, false)
}

// AgentUnfollow serves POST /api/chats/{id}/unfollow for the chat of a run's agent: the page
// client's follow ends here; the bridge's hook does the rest (see Unfollowed).
func (r *Relay) AgentUnfollow(chat, client string) Reply {
	r.o.Bridge.UnfollowAs(editorbridge.KindPage, client, editorbridge.Chat(chat))
	return okReply
}
