package remotes

// The start of a run on another server.
//
// Until its start such a run is a draft run of this server's run service, which carries its
// server (LocalRuns). The start is one start call to that server, which makes the run there
// under the same id and starts it. When any answer says that the run has started, a run record
// takes the draft's place (swapRun). A start call that got no answer leaves a mark on the draft
// (RunMeta.RemoteStart is "unconfirmed") until a read, a snapshot or an event of the run tells
// what became of it.
//
// While the start lock of an id is held (opLocks.runStart: a start call, or the settling of one,
// is under way) the run service changes none of the draft's choices and does not delete it
// (Starting). The swap is the net below that: a draft that was changed or deleted all the same
// is not started (see swapRun).

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/servers"
)

// StartRun serves POST /api/runs/{id}/start for a draft run on another server: goal is sent in
// one start call (PUT /api/runs/{id} there). The id of a run record is answered with the
// record's view and nothing is sent: the run has started.
//
// One call runs per id: a second one meanwhile gets 409 busy. The call is not ended by the page
// that asked: its answer decides what the run is here, whoever still waits for it.
//
//   - Before the call: a blank goal is 400, an archived draft 409, a draft with no agent 409
//     no_agent, an entry that is not connected 503 server_unreachable. Nothing changes.
//   - The answer says started and holds the run (whatever its status): the swap; the page gets
//     200 and the record's view.
//   - 409 id_taken: the draft gets a new id (LocalRuns.Reissue) and the call is made once more
//     with it. What that call answers is taken by this list; a second id_taken is handed on.
//   - Any other error that says the run has not started: the draft's mark is cleared, and the
//     page gets the answer's status, error and code. An answer that was given before the id was
//     looked at (bad_request, bad_id, group_refused), or that is not the start call's, says
//     nothing of the run: what was known stays. Of those a 404 "not found" is a server without
//     run routes (409 runs_unsupported), and a 401 is 503 server_unreachable.
//   - No answer, a success that does not say started, or started without the run: the mark
//     "unconfirmed", and the run is read there (settleRun). That read waits on that server
//     while a start call of the id is under way, so its answer is definite: started is the swap
//     and 200; "no such run" clears the mark, 502 not_started. With no answer to the read
//     either the mark stays: 504 start_unconfirmed.
//   - The run has started, and the draft was put on another server or deleted while the call
//     was under way: no record is made, the run is deleted on that server, and the page gets 409
//     run_changed (see swapRun).
//   - The answer says started and that this call did not make the run ("made" is false): the
//     run had started with the goal of an earlier call. When the start call sent last for the
//     id had another goal than this one (see goalSent), the swap is made and the page gets 409
//     goal_kept, so that it keeps the text. With no earlier call known, or the same goal, it is
//     200: a repeat starts the run only once.
func (r *Relay) StartRun(ctx context.Context, id, goal string) Reply {
	unlock, ok := r.locks.runStart.try(id)
	if !ok {
		return runBusy().Reply()
	}
	defer unlock()
	if rec := r.runRec(id); rec != nil {
		r.handOverLeft(rec)
		return r.runReply(rec)
	}
	if r.o.Runs == nil {
		return noRun().Reply()
	}
	meta, ok := r.o.Runs.RemoteDraft(id)
	if !ok {
		r.dropGoal(id) // the draft is gone
		if rec := r.runRec(id); rec != nil {
			return r.runReply(rec) // another call started it
		}
		return noRun().Reply()
	}
	entry := meta.Server
	switch {
	case strings.TrimSpace(goal) == "":
		return (&Error{Status: http.StatusBadRequest, Text: runs.ErrNoGoal.Error(), cause: runs.ErrNoGoal}).Reply()
	case meta.Archived:
		return (&Error{Status: http.StatusConflict, Text: runs.ErrArchived.Error(), cause: runs.ErrArchived}).Reply()
	case meta.Agent == "":
		return (&Error{Status: http.StatusConflict, Code: "no_agent",
			Text: "The run has no agent: choose one of " + r.name(entry) + "."}).Reply()
	case !runs.ValidID(id):
		// Never sent: the id is the run's id there, and the id of the record.
		return (&Error{Status: http.StatusBadRequest, Code: "bad_id", Text: runs.ErrBadID.Error(), cause: runs.ErrBadID}).Reply()
	}
	ctx = r.lasting(ctx)
	out, taken := r.startCall(ctx, meta, goal)
	if !taken {
		return out
	}
	// The id is taken there by what a deleted run left: nothing of this call is there. The draft
	// gets a new id, which the pages follow through the event's "was", and the call is repeated.
	next, err := r.o.Runs.Reissue(id)
	if err != nil {
		r.o.Logf("remotes: the draft run %s gets no new id after its id was refused: %v", id, err)
		r.setRunStart(id, "")
		return out
	}
	unlockNext, ok := r.locks.runStart.try(next.ID)
	if !ok {
		return runBusy().Reply()
	}
	defer unlockNext()
	meta, ok = r.o.Runs.RemoteDraft(next.ID)
	if !ok || meta.Server != entry {
		return noRun().Reply()
	}
	// A second refusal of the id is handed on: the new draft has no mark.
	out, _ = r.startCall(ctx, meta, goal)
	return out
}

func runBusy() *Error {
	return &Error{Status: http.StatusConflict, Code: "busy", Text: runs.ErrStarting.Error(), cause: runs.ErrStarting}
}

// runChanged is the answer of a start whose draft was changed or deleted while it was made.
func (r *Relay) runChanged(entry string) *Error {
	return &Error{Status: http.StatusConflict, Code: "run_changed",
		Text: "The run was changed while it was being started; it was not started on " + r.name(entry) + "."}
}

// Starting reports whether the start of the run id is being made right now: its start call, or
// the settling of one, is under way (runs.Remote). It only looks up.
func (r *Relay) Starting(id string) bool { return r.locks.runStart.busy(id) }

// startCall makes one start call for the draft meta and takes its answer. taken says that the
// server refused the id as taken (409 id_taken): nothing was changed here, and out is that
// answer as the page gets it.
func (r *Relay) startCall(ctx context.Context, meta model.RunMeta, goal string) (out Reply, taken bool) {
	id, entry := meta.ID, meta.Server
	sum := sha256.Sum256([]byte(goal))
	other := r.goalOther(id, entry, sum) // read before the call: the swap drops what is kept
	rep, err := r.call(ctx, entry, http.MethodPut, runPath(id, ""), runStartBody(meta, goal), r.o.Limits.Start)
	switch {
	case errors.Is(err, ErrUnreachable):
		return r.unreachable(entry).Reply(), false
	case err != nil:
		r.keepGoal(id, entry, sum)
		out, _ := r.settleRun(ctx, meta)
		return out, false
	case rep.Status == http.StatusUnauthorized:
		return r.unreachable(entry).Reply(), false
	}
	ans, ok := readRunStart(rep)
	// done is the answer of a call that found the run started, after the swap.
	done := func(rec *runRecord) Reply {
		if ans.Unmade && other {
			return (&Error{Status: http.StatusConflict, Code: "goal_kept",
				Text: r.name(entry) + " had already started the run with the earlier goal; this text was not sent."}).Reply()
		}
		return r.runReply(rec)
	}
	switch {
	case !ok && rep.Status < 300:
		// A success that is not the start call's: nothing is known of the run.
		r.keepGoal(id, entry, sum)
		out, _ := r.settleRun(ctx, meta)
		return out, false
	case !ok && noRunRoutes(rep):
		return (&Error{Status: http.StatusConflict, Code: "runs_unsupported", Text: r.name(entry) + " cannot run runs: update it.",
			cause: runs.ErrRunsUnsupported}).Reply(), false
	case !ok:
		return r.errorOf(entry, rep).Reply(), false // given before the call reached the run
	case ans.Started && ans.Run == nil:
		// Started, and the view is missing: it is read.
		r.keepGoal(id, entry, sum)
		out, rec := r.settleRun(ctx, meta)
		if rec != nil {
			return done(rec), false
		}
		return out, false
	case ans.Started && ans.Run.ID != id:
		// Started, with the view of another run: no record is made of it. What is there under
		// the id is settled by the next start or the next snapshot.
		r.o.Logf("remotes: the start of the run %s was answered with the view of the run %q", id, short(ans.Run.ID))
		r.keepGoal(id, entry, sum)
		r.setRunStart(id, model.RemoteUnconfirmed)
		return r.badAnswer(entry).Reply(), false
	case ans.Started:
		rec, e := r.swapRun(ctx, meta, *ans.Run, true)
		if e != nil {
			return e.Reply(), false
		}
		return done(rec), false
	case rep.Status < 300:
		// A success that started nothing is no answer to go by.
		r.keepGoal(id, entry, sum)
		out, _ := r.settleRun(ctx, meta)
		return out, false
	case rep.Status == http.StatusConflict && ans.Code == "id_taken":
		r.dropGoal(id)
		return r.errorOf(entry, rep).Reply(), true
	case ans.Code != "bad_request" && ans.Code != "bad_id" && ans.Code != "group_refused":
		r.setRunStart(id, "")
	}
	return r.errorOf(entry, rep).Reply(), false
}

// runStartBody is the body of the start call for the draft meta: the one place it is made. It
// names no id and no group: the id is the path's, and the group is that server's choice.
func runStartBody(meta model.RunMeta, goal string) []byte {
	type settings struct {
		MaxParallel int     `json:"maxParallel"`
		MaxTurns    int     `json:"maxTurns"`
		MaxCost     float64 `json:"maxCost"`
		Setup       string  `json:"setup"`
		Wake        string  `json:"wake"`
		ApplyResult string  `json:"applyResult"`
	}
	set := meta.Settings
	if set.Wake == "" {
		set.Wake = model.DefaultRunSettings().Wake
	}
	if set.ApplyResult == "" {
		set.ApplyResult = "auto"
	}
	b, _ := json.Marshal(struct {
		Name      string          `json:"name"`
		UserNamed bool            `json:"userNamed"`
		Agent     model.AgentKind `json:"agent"`
		Tiers     model.RunTiers  `json:"tiers"`
		Cwd       string          `json:"cwd"`
		Settings  settings        `json:"settings"`
		Goal      string          `json:"goal"`
	}{meta.Name, meta.UserNamed, meta.Agent, meta.Tiers, meta.Cwd,
		settings{set.MaxParallel, set.MaxTurns, set.MaxCost, set.Setup, set.Wake, set.ApplyResult}, goal})
	return b
}

// runStartAnswer is the answer of the start call. An error answer can say that the run has
// started, so "started" and "run" are read before the status. Unmade is set when the answer
// says that this call did not make the run ("made" is false).
type runStartAnswer struct {
	Started bool
	Unmade  bool
	Run     *model.RunView
	Code    string
}

// readRunStart reads the answer of a start call. ok is false for one that does not say whether
// the run has started: it is no answer of that call.
func readRunStart(rep servers.Reply) (ans runStartAnswer, ok bool) {
	var raw struct {
		Started *bool          `json:"started"`
		Made    *bool          `json:"made"`
		Run     *model.RunView `json:"run"`
		Code    string         `json:"code"`
	}
	if json.Unmarshal(rep.Body, &raw) != nil || raw.Started == nil {
		return ans, false
	}
	return runStartAnswer{Started: *raw.Started, Unmade: raw.Made != nil && !*raw.Made, Run: raw.Run, Code: raw.Code}, true
}

// noRunRoutes reports whether the answer is the one of a server that has no run routes: the
// 404 of a route that is not there.
func noRunRoutes(rep servers.Reply) bool {
	return rep.Status == http.StatusNotFound && saidIn(rep).Error == "not found"
}

// goalSent is what the relay keeps of the start calls it sent for a draft run: the SHA-256 of
// the goal of the last one. It tells a repeat of a start from a start with another goal, when
// the server answers that the run had started before (see StartRun). It is kept from a call
// that was sent and whose goal may have arrived, until something definite is known: the swap,
// an answer or a read that says the run has not started, or the end of the draft. It is in
// memory alone, never in a file.
type goalSent struct {
	entry string
	sum   [sha256.Size]byte
}

// keepGoal keeps the goal of a start call that was sent for the run id.
func (r *Relay) keepGoal(id, entry string, sum [sha256.Size]byte) {
	r.fmu.Lock()
	defer r.fmu.Unlock()
	r.goals[id] = goalSent{entry: entry, sum: sum}
}

// goalOther reports whether the start call sent last for the run id, to the entry, had another
// goal than the one of sum.
func (r *Relay) goalOther(id, entry string, sum [sha256.Size]byte) bool {
	r.fmu.Lock()
	defer r.fmu.Unlock()
	was, had := r.goals[id]
	return had && was.entry == entry && was.sum != sum
}

// dropGoal forgets the start calls of the run id.
func (r *Relay) dropGoal(id string) {
	r.fmu.Lock()
	defer r.fmu.Unlock()
	delete(r.goals, id)
}

// forgetGoals forgets the start calls of the entry's draft runs: of every one with all, else of
// those that the run service no longer has as drafts on the entry.
func (r *Relay) forgetGoals(entry string, all bool) {
	r.fmu.Lock()
	var ids []string
	for id, g := range r.goals {
		if g.entry == entry {
			ids = append(ids, id)
		}
	}
	r.fmu.Unlock()
	for _, id := range ids {
		if !all && r.o.Runs != nil {
			if meta, ok := r.o.Runs.RemoteDraft(id); ok && meta.Server == entry {
				continue
			}
		}
		r.dropGoal(id)
	}
}

// settleRun is the end of a start call that got no answer to go by: it is not known whether the
// run started, and the run is read on its server to learn it. rec is the record when the read
// found the run started and the swap was made; out is then 200 with the record's view.
func (r *Relay) settleRun(ctx context.Context, meta model.RunMeta) (out Reply, rec *runRecord) {
	id, entry := meta.ID, meta.Server
	name := r.name(entry)
	unconfirmed := (&Error{Status: http.StatusGatewayTimeout, Code: "start_unconfirmed",
		Text: name + " did not answer: it is not known whether the run started. Start again: it starts only once."}).Reply()

	r.setRunStart(id, model.RemoteUnconfirmed)
	rep, err := r.call(ctx, entry, http.MethodGet, runPath(id, ""), nil, r.o.Limits.Settle)
	if err != nil {
		return unconfirmed, nil
	}
	switch {
	case rep.Status == http.StatusOK:
		var v model.RunView
		if json.Unmarshal(rep.Body, &v) != nil || v.ID != id || !v.Status.Started() {
			return unconfirmed, nil
		}
		rec, e := r.swapRun(ctx, meta, v, true)
		if e != nil {
			return e.Reply(), nil
		}
		return r.runReply(rec), rec
	case noSuchRun(rep):
		r.setRunStart(id, "")
		return (&Error{Status: http.StatusBadGateway, Code: "not_started",
			Text: name + " did not answer and the run was not started. Start again."}).Reply(), nil
	}
	return unconfirmed, nil
}

// setRunStart records what is known of the draft's start on the draft: "" or "unconfirmed". ""
// is definite: no goal of an earlier call is there. A draft that has the mark already is told
// nothing: no write and no event.
func (r *Relay) setRunStart(id, state string) {
	if state != model.RemoteUnconfirmed {
		r.dropGoal(id)
	}
	if meta, ok := r.o.Runs.RemoteDraft(id); !ok || meta.RemoteStart == state {
		return
	}
	if err := r.o.Runs.SetRemoteStart(id, state); err != nil && !errors.Is(err, runs.ErrNotFound) {
		r.o.Logf("remotes: the state %q of the start of the run %s is not kept: %v", state, id, err)
	}
}

// swapRun puts a run record in the place of the draft meta, which has started on its server
// with the view v. The caller holds the id's start lock. The order is fixed:
//
//  1. The record is adopted, so that routes and events find it: in the draft's place here. It
//     is held: it takes what comes of its run, and the pages get nothing of it yet.
//  2. The run service records the run's values as defaults and retires the draft, which must
//     still be a draft on the record's server. It sends no run_removed: the id stays, and the
//     pages take the record's view for it.
//  3. The pages get the record's view.
//  4. With read, the view is read once from the server: the events of the run that came before
//     the record was there were dropped, so the view of the answer may be old. It is taken
//     only if no event of the run was applied since the read was sent, and the pages are told
//     if it changed anything. A snapshot's view and an event's need no read.
//
// The pages need no other event: their view of the run changes with "started".
//
// The run service may have no such draft at step 2: it was put on another server, or deleted,
// between the moment meta was read and the answer. The start lock keeps the run service from
// that (Starting) but for the change that was under way when the lock was taken. The run is
// then not started as far as this server goes: the record is taken back with no event (none
// was sent), the run is deleted on its server as for a deleted draft whose start may have
// arrived (DropRun), and the error is 409 run_changed. A record that was there before this
// call is not taken back: both are left, and that is logged.
//
// The error is set when there is no record: besides the above, 503 when the entry was removed
// meanwhile.
func (r *Relay) swapRun(ctx context.Context, meta model.RunMeta, v model.RunView, read bool) (*runRecord, *Error) {
	id, entry := meta.ID, meta.Server
	rec, err := r.adoptRunAs(RunRecord{ID: id, Entry: entry, Group: meta.Group, Archived: v.Archived, View: v}, true)
	adopted := err == nil
	if errors.Is(err, errTaken) {
		rec, err = r.runRec(id), nil // the record is there: the draft alone is left to go
	}
	if err != nil || rec == nil {
		r.o.Logf("remotes: no record is made for the started run %s: %v", id, err)
		return nil, r.unreachable(entry)
	}
	r.dropGoal(id)
	switch _, err := r.o.Runs.HandOver(id, rec.entry, v); {
	case err == nil:
	case adopted && errors.Is(err, runs.ErrNotFound):
		rec.mu.Lock()
		r.dropRun(rec)
		rec.mu.Unlock()
		r.o.Logf("remotes: the run %s was changed or deleted while it was being started: it is not started, and is deleted on the server %s", id, entry)
		r.DropRun(entry, id)
		return nil, r.runChanged(entry)
	default:
		r.o.Logf("remotes: the run %s has started on its server and is not handed over: %v", id, err)
	}
	rec.mu.Lock()
	rec.held = false
	if !rec.removed {
		r.emitRun(rec)
	}
	rec.mu.Unlock()
	if read {
		_ = r.readRun(ctx, rec) // a failure leaves the answer's view, which the next event corrects
	}
	return rec, nil
}

// handOverLeft hands over the draft that is left under the record's id, if there is one: a swap
// that was cut after its first step adopted the record and did not retire the draft. The run
// service gets the record's view, and the pages are told nothing: they have the record's. A
// draft on another server than the record's is not this record's draft, and is left alone.
func (r *Relay) handOverLeft(rec *runRecord) {
	if r.o.Runs == nil {
		return
	}
	if meta, ok := r.o.Runs.RemoteDraft(rec.id); !ok || meta.Server != rec.entry {
		return
	}
	rec.mu.Lock()
	v := rec.d.View
	rec.mu.Unlock()
	if _, err := r.o.Runs.HandOver(rec.id, rec.entry, v); err != nil && !errors.Is(err, runs.ErrNotFound) {
		r.o.Logf("remotes: the run %s has a record and is not handed over: %v", rec.id, err)
	}
}

// startedRun takes a run's view that the entry sent for a run without a record: when the run
// is a draft run of the entry and the view says that it has started there, the record takes
// its place (swapRun, with the event's view and no read: what comes after it on the stream is
// applied after it). That settles a start whose outcome was not learned and that a snapshot
// found not started yet: the server lists a run only when its start is done. A draft whose
// start is being made right now is left to that call. It reports whether the swap was made; it
// runs on the entry's worker and asks the server nothing.
func (r *Relay) startedRun(entry string, v model.RunView) bool {
	if r.o.Runs == nil || !v.Status.Started() || r.HasRun(v.ID) {
		return false
	}
	if meta, ok := r.o.Runs.RemoteDraft(v.ID); !ok || meta.Server != entry {
		return false
	}
	unlock, ok := r.locks.runStart.try(v.ID)
	if !ok {
		return false
	}
	defer unlock()
	meta, ok := r.o.Runs.RemoteDraft(v.ID)
	if !ok || meta.Server != entry || r.HasRun(v.ID) {
		return false
	}
	rec, _ := r.swapRun(r.ctx, meta, v, false)
	return rec != nil
}

// settleRunStarts is step 3 of a snapshot for runs: every draft run on the entry is settled
// from the snapshot's runs, whatever is known of its start: a start call that was under way
// when this server's process ended left no mark on the draft. There and started: the swap,
// with the snapshot's view and no read. A draft that has a record already, from a swap that
// was cut after its first step, is handed over and nothing else. A draft whose start is being
// made right now is left to that call.
//
// Not there says nothing definite: the server lists a run only when its start is done, so a
// snapshot that was taken during the start does not have it. A draft with the mark is
// therefore settled by the read of the run, which waits on that server while a start of the id
// is under way (settleRun): started is the swap, "no such run" clears the mark, and anything
// else leaves it. A draft without the mark is told nothing; if its run has started after all,
// the run's next event says so (startedRun).
//
// It runs on the entry's worker and asks the server nothing itself: each read is made off the
// worker, and holds the id's start lock until it has ended.
func (r *Relay) settleRunStarts(entry string, snap *snapshot) {
	if r.o.Runs == nil {
		return
	}
	r.forgetGoals(entry, false)
	for _, m := range r.o.Runs.DraftsOn(entry) {
		unlock, ok := r.locks.runStart.try(m.ID)
		if !ok {
			continue
		}
		if rec := r.runRec(m.ID); rec != nil {
			r.handOverLeft(rec)
		} else if meta, ok := r.o.Runs.RemoteDraft(m.ID); ok && meta.Server == entry {
			switch v, there := snap.run(meta.ID); {
			case there && v.Status.Started():
				r.swapRun(r.ctx, meta, v, false)
			case there:
				// A draft there under the id: it is not this one's start, and says nothing of it.
			case meta.RemoteStart != "":
				if r.spawn(func() {
					defer unlock()
					r.settleRun(r.ctx, meta)
				}) {
					continue // the read has the start lock from here on
				}
			default:
				r.dropGoal(meta.ID)
			}
		}
		unlock()
	}
}
