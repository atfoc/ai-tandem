package remotes

// The first message of a chat on another server.
//
// Until its first message such a chat is a chat object of this server's chat manager, which
// carries its server (Local). The first message is one creation call to that server, which
// makes the chat there under the same id and sends it the message. When any answer says that
// the chat has started, a record takes the object's place (swap). What is known of a call that
// did not start the chat is kept on the object (ChatMeta.RemoteStart): "left" when the chat was
// made there and did not start, "unconfirmed" when no answer came.

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
)

// StartOutcome is what the page gets for a first message: 200, or the status with the sentence
// and the code of the refusal.
type StartOutcome struct {
	Status      int    // for the page
	Error, Code string // "" on success
}

var started = StartOutcome{Status: http.StatusOK}

// Start sends text as the first message of the chat id, which must be one that Local reports as
// unstarted on another server. On success the page is answered {"ok":true,"branch":"main"}.
//
// One call runs per id: a second one meanwhile gets 409 busy. The call is not ended by the page
// that asked: its answer decides what the chat is here, whoever still waits for it.
//
//   - A chat on a run whose record is gone (404 gone_there) or archived (409): nothing is sent
//     and nothing changes.
//   - No agent: 409 no_agent. The entry is not connected, or answers 401: 503
//     server_unreachable. Nothing changes.
//   - The answer says started (whatever its status): the swap; the page gets 200, or the
//     answer's error when the agent refused the message after its start.
//   - The answer is an error and the chat has not started: "left" when the answer holds the
//     chat, "" when it does not; the page gets the answer's status, error and code. An answer
//     that was given before the chat was looked at (bad_request, bad_id, or one that is not the
//     creation call's) says nothing of the chat: what was known stays.
//   - No answer: "unconfirmed", and the chat is read there (settle). That read waits on that
//     server while a creation call of the id is under way: started is the swap and 200;
//     unstarted is "left" and missing is "", both 502 not_sent. With no answer to the read
//     either it stays "unconfirmed": 504 start_unconfirmed. A read that says started does not
//     say which text started the chat: when a call the relay sent for the id before had
//     another text than this one, the page gets 409 first_text_kept after the swap.
//   - The answer says started and that this call sent nothing ("sent" is false): the chat had
//     started with the text of an earlier call. When a call the relay sent for the id before
//     had another text than this one (see firstText), the swap is made and the page gets 409
//     first_text_kept, so that it keeps the text. With no earlier call known, or the same
//     text, it is 200: a repeat is sent only once.
//
// An answer that says the chat has not started, or is not there, tells of this call alone: a
// call sent before that got no answer may still wait on that server and start the chat later.
// So what is kept of the text of such a call (firstText) stays through every such answer.
func (r *Relay) Start(ctx context.Context, id, text string) StartOutcome {
	unlock, ok := r.locks.start.try(id)
	if !ok {
		return StartOutcome{http.StatusConflict, "The first message of this chat is being sent.", "busy"}
	}
	defer unlock()
	if r.o.Local == nil {
		return StartOutcome{Status: http.StatusNotFound, Error: chats.ErrNotFound.Error()}
	}
	meta, ok := r.o.Local.RemoteUnstarted(id)
	if !ok {
		r.dropFirst(id) // the chat object is gone
		if r.Has(id) {  // another call started it: the page reads the chat again
			return StartOutcome{http.StatusConflict, "The chat has started. Send the message again.", "busy"}
		}
		return StartOutcome{Status: http.StatusNotFound, Error: chats.ErrNotFound.Error()}
	}
	entry := meta.Server
	if e := r.runClosed(meta.Run); e != nil {
		return outcomeOf(e)
	}
	if meta.Agent == "" {
		return StartOutcome{http.StatusConflict, "The chat has no agent: choose one of " + r.name(entry) + ".", "no_agent"}
	}
	ctx = r.lasting(ctx)
	sum := sha256.Sum256([]byte(text))
	other := r.firstOther(id, entry, sum) // read before the call: the swap drops what is kept
	rep, err := r.call(ctx, entry, http.MethodPost, "/api/chats", startBody(meta, text), r.o.Limits.Start)
	switch {
	case errors.Is(err, ErrUnreachable):
		return outcomeOf(r.unreachable(entry))
	case err != nil:
		return r.unread(ctx, meta, sum, other)
	case rep.Status == http.StatusUnauthorized:
		return outcomeOf(r.unreachable(entry))
	}
	ans, ok := readStart(rep)
	// done is the outcome of a call that found the chat started, after the swap.
	done := func() StartOutcome {
		if ans.Unsent && other {
			return StartOutcome{http.StatusConflict,
				"The first message had already arrived on " + r.name(entry) + "; this text was not sent.", "first_text_kept"}
		}
		return started
	}
	switch {
	case !ok:
		// Not an answer of the creation call. With a success status nothing is known of the
		// chat; an error was given before the call reached it.
		if rep.Status < 300 {
			return r.unread(ctx, meta, sum, other)
		}
		return outcomeOf(r.errorOf(entry, rep))
	case ans.Started && ans.Chat == nil:
		// Started, and the view is missing: it is read.
		r.firstSent(id, entry, sum)
		if out := r.unanswered(ctx, meta); out != started {
			return out
		}
		return done()
	case ans.Started:
		if !r.swap(ctx, meta, *ans.Chat, nil, true) {
			return outcomeOf(r.unreachable(entry))
		}
		if rep.Status < 300 {
			return done()
		}
		return outcomeOf(r.errorOf(entry, rep)) // the agent refused the message after its start
	case rep.Status < 300:
		return r.unread(ctx, meta, sum, other) // a success that started nothing is no answer to go by
	case ans.Chat != nil:
		r.setStart(id, model.RemoteLeft)
	case ans.Code != "bad_request" && ans.Code != "bad_id":
		r.setStart(id, "")
	}
	return outcomeOf(r.errorOf(entry, rep))
}

func outcomeOf(e *Error) StartOutcome {
	return StartOutcome{Status: e.Status, Error: e.Text, Code: e.Code}
}

// runClosed is the refusal of a first message for a chat on the run: its record is gone there,
// or is archived or being archived. nil for a chat on no run, and for a run without a record:
// its server answers for that one.
func (r *Relay) runClosed(run string) *Error {
	if run == "" {
		return nil
	}
	rec := r.runRec(run)
	if rec == nil {
		return nil
	}
	switch v := rec.view(); {
	case v.Gone:
		return r.runGoneThere(rec.entry)
	case v.Archived:
		return &Error{Status: http.StatusConflict, Text: chats.ErrRunArchived.Error(), cause: chats.ErrRunArchived}
	}
	return nil
}

// startBody is the body of the creation call for the chat meta: the one place it is made. A
// chat on a run names the run, which is on that server under the same id.
func startBody(meta model.ChatMeta, text string) []byte {
	b, _ := json.Marshal(struct {
		ID        string          `json:"id"`
		Agent     model.AgentKind `json:"agent"`
		Cwd       string          `json:"cwd"`
		Model     string          `json:"model"`
		Effort    string          `json:"effort"`
		Name      string          `json:"name"`
		UserNamed bool            `json:"userNamed"`
		Text      string          `json:"text"`
		Run       string          `json:"run,omitempty"`
	}{meta.ID, meta.Agent, meta.Cwd, meta.Model, meta.Effort, meta.Name, meta.UserNamed, text, meta.Run})
	return b
}

// startAnswer is the answer of the creation call. An error answer can say that the chat has
// started, so "started" and "chat" are read before the status. Unsent is set when the answer
// says that this call put no message into the thread ("sent" is false).
type startAnswer struct {
	Started bool
	Unsent  bool
	Chat    *model.ChatView
	Code    string
}

// readStart reads the answer of a creation call. ok is false for one that does not say whether
// the chat has started: it is no answer of that call.
func readStart(rep servers.Reply) (ans startAnswer, ok bool) {
	var raw struct {
		Started *bool           `json:"started"`
		Sent    *bool           `json:"sent"`
		Chat    *model.ChatView `json:"chat"`
		Code    string          `json:"code"`
	}
	if json.Unmarshal(rep.Body, &raw) != nil || raw.Started == nil {
		return ans, false
	}
	return startAnswer{Started: *raw.Started, Unsent: raw.Sent != nil && !*raw.Sent, Chat: raw.Chat, Code: raw.Code}, true
}

// firstText is what the relay keeps of the creation calls it sent for a chat that has not
// started: the SHA-256 of the text of the last one. It tells a repeat of a first message from a
// first message with another text, when the server answers that the chat had started before
// (see Start), and a draft that was changed since from the text sent, at a swap no page waits
// for (see keptDraft). It is kept from a call that was sent and whose text may have arrived.
//
// No answer but "started" ends that: a snapshot that lacks the chat or lists it as not started,
// a read that finds it missing or not started, and a later call's answer that it has not
// started can all overtake a creation call that still waits on a server which was halted, and
// that call starts the chat afterwards. So it is forgotten only by the swap, when the chat
// object is gone, when the chat is no longer an unstarted chat of the entry the text was sent
// to (forgetFirsts; until then it is not read for another entry), and with the entry. That is
// safe for a chat that never arrived: its next creation call is answered "started, sent", and
// the swap forgets the text. It is in memory alone, never in a file.
type firstText struct {
	entry string // the entry the calls were sent to
	sum   [sha256.Size]byte
	mixed bool // the calls sent had more than one text: which one arrived is not known
}

// firstSent keeps the text of a creation call that was sent for the chat id to the entry. What
// is kept of calls to another entry, which the chat was on before, is replaced.
func (r *Relay) firstSent(id, entry string, sum [sha256.Size]byte) {
	r.fmu.Lock()
	defer r.fmu.Unlock()
	was, had := r.firsts[id]
	r.firsts[id] = firstText{entry: entry, sum: sum, mixed: had && was.entry == entry && (was.mixed || was.sum != sum)}
}

// firstOther reports whether a creation call was sent for the chat id to the entry before with
// another text than the one of sum.
func (r *Relay) firstOther(id, entry string, sum [sha256.Size]byte) bool {
	r.fmu.Lock()
	defer r.fmu.Unlock()
	was, had := r.firsts[id]
	return had && was.entry == entry && (was.mixed || was.sum != sum)
}

// dropFirst forgets the creation calls of the chat id.
func (r *Relay) dropFirst(id string) {
	r.takeFirst(id)
}

// takeFirst forgets the creation calls of the chat id and gives what was kept of them; had is
// false when nothing was.
func (r *Relay) takeFirst(id string) (was firstText, had bool) {
	r.fmu.Lock()
	defer r.fmu.Unlock()
	was, had = r.firsts[id]
	delete(r.firsts, id)
	return was, had
}

// sent reports whether the draft d is the text of the creation calls: a first message is its
// text alone, and a page sends it trimmed. With more than one text sent it is never known to be.
func (f firstText) sent(d *model.Draft) bool {
	if f.mixed || len(d.References) > 0 {
		return false
	}
	return sha256.Sum256([]byte(d.Text)) == f.sum || sha256.Sum256([]byte(strings.TrimSpace(d.Text))) == f.sum
}

// forgetFirsts forgets the creation calls that were sent to the entry: of every chat with all,
// else of those that the chat manager no longer has as unstarted chats on the entry.
func (r *Relay) forgetFirsts(entry string, all bool) {
	r.fmu.Lock()
	var ids []string
	for id, f := range r.firsts {
		if f.entry == entry {
			ids = append(ids, id)
		}
	}
	r.fmu.Unlock()
	for _, id := range ids {
		if !all && r.o.Local != nil {
			if meta, ok := r.o.Local.RemoteUnstarted(id); ok && meta.Server == entry {
				continue
			}
		}
		r.dropFirstOf(id, entry)
	}
}

// dropFirstOf forgets the creation calls of the chat id when they were sent to the entry: a
// call sent to another entry meanwhile is kept.
func (r *Relay) dropFirstOf(id, entry string) {
	r.fmu.Lock()
	defer r.fmu.Unlock()
	if r.firsts[id].entry == entry {
		delete(r.firsts, id)
	}
}

// unread is the end of a creation call with the text of sum that got no answer: the text is
// kept and the chat is read (unanswered). other says that a call sent for the chat before had
// another text, as firstOther told before this one was kept. A read that finds the chat started
// then does not tell which of the texts arrived, so the page keeps this one.
func (r *Relay) unread(ctx context.Context, meta model.ChatMeta, sum [sha256.Size]byte, other bool) StartOutcome {
	r.firstSent(meta.ID, meta.Server, sum)
	out := r.unanswered(ctx, meta)
	if out == started && other {
		return StartOutcome{http.StatusConflict, "The chat has started on " + r.name(meta.Server) +
			"; it is not known which of the two texts arrived, so this text is kept here.", "first_text_kept"}
	}
	return out
}

// unanswered is the end of a creation call that got no answer: it is not known whether the first
// message arrived, and the chat is read on its server to learn it. A read that does not find the
// chat started sets the mark and leaves what is kept of the text: it can overtake a creation
// call that still waits there (see firstText).
func (r *Relay) unanswered(ctx context.Context, meta model.ChatMeta) StartOutcome {
	id, entry := meta.ID, meta.Server
	name := r.name(entry)
	unconfirmed := StartOutcome{http.StatusGatewayTimeout,
		name + " did not answer: it is not known whether the first message arrived. Send again: it is sent only once.", "start_unconfirmed"}
	notSent := StartOutcome{http.StatusBadGateway, name + " did not answer and the message was not sent. Send again.", "not_sent"}

	r.setStart(id, model.RemoteUnconfirmed)
	rep, err := r.call(ctx, entry, http.MethodGet, chatPath(id, ""), nil, r.o.Limits.Settle)
	if err != nil {
		return unconfirmed
	}
	switch rep.Status {
	case http.StatusOK:
		var v model.ChatView
		if json.Unmarshal(rep.Body, &v) != nil || v.ID != id {
			return unconfirmed
		}
		if v.Locked {
			if !r.swap(ctx, meta, v, nil, true) {
				return outcomeOf(r.unreachable(entry))
			}
			return started
		}
		r.setStart(id, model.RemoteLeft)
		return notSent
	case http.StatusNotFound:
		r.setStart(id, "")
		return notSent
	}
	return unconfirmed
}

// setStart records what is known of the chat's first message on the unstarted chat. It leaves
// what is kept of the chat's creation calls as it is, whatever the state: no state says that
// the text of an earlier call cannot arrive any more (see firstText).
func (r *Relay) setStart(id, state string) {
	if err := r.o.Local.SetRemoteStart(id, state); err != nil && !errors.Is(err, chats.ErrNotFound) {
		r.o.Logf("remotes: the state %q of the first message of the chat %s is not kept: %v", state, id, err)
	}
}

// swap puts a record in the place of the unstarted chat meta, which has started on its server
// with the view v. The order is fixed:
//
//  1. The record is adopted, so that routes and events find it: in the chat's place here, with
//     the chat's draft counters, the first branch's raised by one for the message that was sent,
//     and no draft.
//  2. The chat manager records the chat's values as defaults and retires its object. The record
//     takes what the object had at that moment (inherit): the draft counters, which the saves
//     that came during the creation call raised, and, when no page waits, a draft that is not
//     the text sent. That draft is a change of its own, on the next counter: the record of
//     step 1 can be read before this step, with no draft, and a page takes a draft only on a
//     counter it has not seen.
//  3. The pages get the branch's state, then the chat's view.
//  4. The view is read once from the server: the events of the chat that came before the record
//     was there were dropped, so the view of the answer may be old. With states, the chat's
//     states as a snapshot just told them, nothing is read.
//  5. The pages that follow the chat are told to load it again (chat_reload).
//
// asked says that a page waits for the outcome (Start): it clears or keeps its text by the
// answer, so the record gets no draft. With no page waiting (a snapshot, an event) the text of
// the chat's box is the object's stored draft alone: see keptDraft.
//
// It reports false when no record could be made: the entry was removed meanwhile.
func (r *Relay) swap(ctx context.Context, meta model.ChatMeta, v model.ChatView, states []model.BranchState, asked bool) bool {
	id, read := meta.ID, states == nil
	if read {
		states = []model.BranchState{model.StateOf(id, mainBranch, v)}
	}
	rec, err := r.adopt(Record{ID: id, Entry: meta.Server, Group: meta.Group, Run: meta.Run, View: v, States: states, DraftRevs: startRevs(meta)})
	if errors.Is(err, errTaken) {
		rec, err = r.rec(id), nil // the record is there: the object alone is left to go
	}
	if err != nil || rec == nil {
		r.o.Logf("remotes: no record is made for the started chat %s: %v", id, err)
		return false
	}
	first, had := r.takeFirst(id)
	handed, err := r.o.Local.HandOver(id)
	if err != nil {
		r.o.Logf("remotes: the chat %s has started on its server and is not handed over: %v", id, err)
	}
	if handed.ID != id {
		handed = meta // no object was there to hand over: what was read of it before stands
	}
	var draft *model.Draft
	if !asked && had && first.entry == meta.Server { // a text sent to another entry is not this chat's
		draft = keptDraft(first, handed)
	}
	rec.mu.Lock()
	if !rec.removed {
		r.inherit(rec, handed, draft)
		r.emit(rec)
	}
	rec.mu.Unlock()
	if read {
		_ = r.readView(ctx, rec, true, false) // a failure leaves the answer's view, which the next event corrects
	}
	r.o.Bridge.SendChat(id, false, map[string]any{"type": "chat_reload", "chat": id})
	return true
}

// startRevs are the draft counters of the record that takes the place of the chat meta: the
// chat's, the first branch's raised by one for the message that was sent. A draft the record
// keeps from the chat raises the first branch's by one more (inherit).
func startRevs(meta model.ChatMeta) map[string]int64 {
	revs := make(map[string]int64, len(meta.DraftRevs)+1)
	for b, n := range meta.DraftRevs {
		revs[b] = n
	}
	revs[mainBranch]++
	return revs
}

// keptDraft is the draft of the first branch that a record keeps from its chat object, handed
// over as the meta handed, when the swap is made with no page waiting for it and first is kept
// of the chat's creation calls: the object's stored draft when that is another text than the
// one sent. The person changed the text after a first message that got no answer, and the chat
// started with the text of that message: what they typed since stays in the box. nil for the
// text that was sent, which goes as a sent message's draft does.
func keptDraft(first firstText, handed model.ChatMeta) *model.Draft {
	d := handed.Drafts[mainBranch]
	if d == nil || (d.Text == "" && len(d.References) == 0) || first.sent(d) {
		return nil
	}
	return d
}

// inherit gives the record what its chat object had when it was handed over as the meta handed:
// every draft counter is raised to the object's (startRevs), never lowered, so that a page that
// saved a draft on the object during the creation call names a counter the record takes. draft,
// when not nil, becomes the draft of the first branch, unless the record has one, on the
// counter after that one: the record was there to be read without the draft (swap, step 1), so
// the draft is a change of its own, which a page that read the record meanwhile takes. The
// file is written when anything changed; no event is sent. rec.mu held.
func (r *Relay) inherit(rec *record, handed model.ChatMeta, draft *model.Draft) (changed bool) {
	for b, n := range startRevs(handed) {
		if rec.d.DraftRevs[b] < n {
			if rec.d.DraftRevs == nil {
				rec.d.DraftRevs = map[string]int64{}
			}
			rec.d.DraftRevs[b], changed = n, true
		}
	}
	if draft != nil && rec.d.Drafts[mainBranch] == nil {
		if rec.d.Drafts == nil {
			rec.d.Drafts = map[string]*model.Draft{}
		}
		if rec.d.DraftRevs == nil {
			rec.d.DraftRevs = map[string]int64{}
		}
		rec.d.DraftRevs[mainBranch]++
		rec.d.Drafts[mainBranch], changed = draft, true
	}
	if changed {
		r.keep(rec, true)
	}
	return changed
}

// settleStarts is step 3 of a snapshot: every unstarted chat on the entry is settled from the
// snapshot's chats, whatever is known of its first message: a creation call that was under way
// when this server's process ended left no mark on the chat. There and started: the swap, with
// the snapshot's view and states. There and not started: "left", so that a later delete or
// change of server drops it there. Not there: "", and a chat that had "" already is told
// nothing. Neither is an answer to a call: a creation call that still waits for its agent there
// lists the chat as not started, and one that still waits in a server that was halted is not
// listed at all, so what is kept of the text of an earlier call stays in both (see firstText);
// only that of a chat that is no longer an unstarted chat of the entry goes (forgetFirsts). A
// chat that has a record already, from a swap that was cut after its first step, is
// handed over, its record takes the object's draft counters (inherit), and nothing else. A chat
// whose first message is being sent right now is left to that call. It runs on the entry's
// worker and asks the server nothing.
func (r *Relay) settleStarts(entry string, snap *snapshot) {
	if r.o.Local == nil {
		return
	}
	r.forgetFirsts(entry, false)
	for _, m := range r.o.Local.UnstartedOn(entry) {
		unlock, ok := r.locks.start.try(m.ID)
		if !ok {
			continue
		}
		if rec := r.rec(m.ID); rec != nil {
			handed, err := r.o.Local.HandOver(m.ID)
			if err != nil && !errors.Is(err, chats.ErrNotFound) {
				r.o.Logf("remotes: the chat %s has a record and is not handed over: %v", m.ID, err)
			}
			if handed.ID == m.ID {
				rec.mu.Lock()
				if !rec.removed && r.inherit(rec, handed, nil) {
					r.emit(rec)
				}
				rec.mu.Unlock()
			}
		} else if meta, ok := r.o.Local.RemoteUnstarted(m.ID); ok && meta.Server == entry {
			switch v, there := snap.chat(meta.ID); {
			case there && v.Locked:
				r.swap(r.ctx, meta, v, snap.states(meta.ID, v), false)
			case there:
				r.setStart(meta.ID, model.RemoteLeft)
			case meta.RemoteStart != "":
				r.setStart(meta.ID, "")
			}
		}
		unlock()
	}
}

// starting reports whether a first message of the chat id may be on its way to the entry: a
// creation call or a settling of it is under way, or it is an unstarted chat of the entry. The
// events of such a chat come before its record.
func (r *Relay) starting(entry, id string) bool {
	if r.locks.start.busy(id) {
		return true
	}
	if r.o.Local == nil {
		return false
	}
	meta, ok := r.o.Local.RemoteUnstarted(id)
	return ok && meta.Server == entry
}

// startedEvent takes a chat event of the entry for a chat that has no record: when the chat is
// an unstarted chat of the entry and the view says that it has started there, the record takes
// its place (swap, which reads the view). That settles a first message whose outcome was not
// learned and that a snapshot found not started yet. A chat whose first message is being sent
// right now is left to that call. It reports whether the swap was made; it runs on the entry's
// worker.
func (r *Relay) startedEvent(entry string, v model.ChatView) bool {
	if r.o.Local == nil || !v.Locked || r.Has(v.ID) {
		return false
	}
	if meta, ok := r.o.Local.RemoteUnstarted(v.ID); !ok || meta.Server != entry {
		return false
	}
	unlock, ok := r.locks.start.try(v.ID)
	if !ok {
		return false
	}
	defer unlock()
	meta, ok := r.o.Local.RemoteUnstarted(v.ID)
	if !ok || meta.Server != entry {
		return false
	}
	return r.swap(r.ctx, meta, v, nil, false)
}
