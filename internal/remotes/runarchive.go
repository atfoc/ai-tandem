package remotes

// Archive, unarchive, delete and move of a run record. The rules are the chat record's (see
// archive.go): the archive mark of a run is its server's (RunRecord.Archived, as last
// received); a change made here is recorded first (RunRecord.Pending) and shows at once; then
// it is passed on. The chats on the run are archived and brought back by the run's server:
// their records take the mark from that server's events, and nothing is passed on for them.

import (
	"context"
	"errors"
	"net/http"
	"time"

	"ai-whiteboard/internal/model"
)

// ArchiveRun archives the record's run: by the user, or as part of the archive action op of a
// group ("" makes a new id). The mark shows at once, and the change is passed on to the run's
// server when it is connected; else, or without an answer, it stays pending and nil is
// returned all the same. A record that is archived already keeps its mark and its action. The
// error is an *Error: 404 "no such run" for no record, or what the server refused the change
// with, which is then undone here.
func (r *Relay) ArchiveRun(ctx context.Context, id, op string) error {
	if op == "" {
		op = model.NewID("a_")
	}
	return r.setRunArchived(ctx, id, pendingArchive, op)
}

// UnarchiveRun is ArchiveRun's reverse, with the same rules.
func (r *Relay) UnarchiveRun(ctx context.Context, id string) error {
	return r.setRunArchived(ctx, id, pendingUnarchive, "")
}

func (r *Relay) setRunArchived(ctx context.Context, id, change, op string) error {
	rec := r.runRec(id)
	if rec == nil {
		return noRun()
	}
	rec.mu.Lock()
	if rec.removed {
		rec.mu.Unlock()
		return noRun()
	}
	if runViewOf(rec.d).Archived != (change == pendingArchive) {
		rec.d.Pending, rec.d.Op = change, op
		r.keepRun(rec, true)
		r.emitRun(rec)
	}
	rec.lost = 0 // the user's action is tried anew
	rec.mu.Unlock()
	if err := r.passRunArchive(ctx, rec); err != nil {
		return err
	}
	return nil
}

// RunsArchivedWith are the ids of the run records that the archive action op archived and that
// are still archived by it, sorted: what a group's unarchive brings back. A mark that was made
// on the run's own server belongs to no action here.
func (r *Relay) RunsArchivedWith(op string) []string {
	ids := []string{}
	if op == "" {
		return ids
	}
	for _, rec := range r.allRuns() {
		if v := rec.view(); v.Archived && v.Op == op {
			ids = append(ids, rec.id)
		}
	}
	return ids
}

// passRunArchive passes the run record's pending archive change on, if it has one. One runs at
// a time per record, and each sends what is pending when its turn comes, so the server gets the
// changes in the order they were made. The call waits Limits.Start: that server stops a live
// run before it archives it. nil is returned when the change was confirmed, and when it stays
// pending: the entry is not connected, did not answer, or cannot say (401, a 5xx). Any other
// refusal undoes the change here and is returned. A call that got no answer is made again in
// the background while the entry stays connected (see runArchiveLost).
func (r *Relay) passRunArchive(ctx context.Context, rec *runRecord) *Error {
	defer r.locks.runArchive.lock(rec.id)()
	rec.mu.Lock()
	change, gone := rec.d.Pending, rec.d.Gone || rec.removed
	rec.mu.Unlock()
	if change == "" || gone {
		return nil // nothing to pass on, or nowhere: a gone run's change waits for its return
	}
	rep, err := r.call(ctx, rec.entry, http.MethodPost, runPath(rec.id, "/"+change), nil, r.o.Limits.Start)
	r.runArchiveLost(rec, err)
	if err != nil {
		return nil
	}
	var refused *Error
	switch {
	case rep.Status == http.StatusOK:
	case noSuchRun(rep):
		r.markRunGone(rec)
		return nil
	case rep.Status == http.StatusUnauthorized || rep.Status >= 500:
		r.o.Logf("remotes: the %s of the run %s stays pending: its server answered %d", change, rec.id, rep.Status)
		return nil
	default:
		refused = r.errorOf(rec.entry, rep)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed || rec.d.Pending != change {
		return nil // changed again meanwhile: the next pass is that change's
	}
	rec.d.Pending = ""
	if refused == nil {
		rec.d.Archived = change == pendingArchive
	}
	if !rec.d.Archived {
		rec.d.Op = "" // the action that archived it is over
	}
	r.keepRun(rec, true)
	r.emitRun(rec)
	return refused
}

// runArchiveLost takes the end of an archive call of the run record, err being what call
// returned: with no answer on an entry that is still connected the change is passed on again
// after Limits.Call, in the background, archiveTries calls in a row at most (see archiveLost).
func (r *Relay) runArchiveLost(rec *runRecord, err error) {
	rec.mu.Lock()
	if !errors.Is(err, ErrNoAnswer) {
		rec.lost = 0
		rec.mu.Unlock()
		return
	}
	rec.lost++
	again := rec.lost < archiveTries && !rec.removed
	rec.mu.Unlock()
	if !again || !r.connected(rec.entry) {
		return
	}
	r.spawn(func() {
		select {
		case <-r.ctx.Done():
			return
		case <-time.After(r.again):
		}
		if !r.connected(rec.entry) {
			return // the next connect passes it on
		}
		if e := r.passRunArchive(r.ctx, rec); e != nil {
			r.o.Logf("remotes: the archive change of the run %s was refused by its server: %v", rec.id, e)
		}
	})
}

// passPendingRuns is step 8 of a snapshot for runs: every archive change of the entry's run
// records that is not confirmed is passed on. It runs in a goroutine of its own.
func (r *Relay) passPendingRuns(ctx context.Context, entry string) {
	for _, rec := range r.runsOn(entry) {
		if ctx.Err() != nil {
			return
		}
		rec.mu.Lock()
		rec.lost = 0 // a connect: tried anew
		rec.mu.Unlock()
		if e := r.passRunArchive(ctx, rec); e != nil {
			r.o.Logf("remotes: the archive change of the run %s was refused by its server: %v", rec.id, e)
		}
	}
}

// DeleteRun deletes the record's run on its server, and the record with it. The records of the
// chats on the run go first, each with its chat_removed; then the chat manager removes the
// chats on the run that have not started; then the pages get run_removed. A record that is
// gone is removed with no call. The call waits Limits.RunDelete: that server waits for the
// run's agents and checkouts. No answer is 504, and the record stays: that server deletes the
// run all the same, and its run_removed then marks the record gone. An entry that is not
// connected is 503.
//
// With localOnly ("Remove from this sidebar only") the records alone are removed and nothing
// is sent. That is accepted when the entry is not connected or the run is gone there; else it
// is 409 server_connected. The error is an *Error.
func (r *Relay) DeleteRun(ctx context.Context, id string, localOnly bool) error {
	rec := r.runRec(id)
	if rec == nil {
		return noRun()
	}
	switch {
	case rec.view().Gone:
	case localOnly:
		if r.connected(rec.entry) {
			return &Error{Status: http.StatusConflict, Code: "server_connected",
				Text: r.name(rec.entry) + " is connected: delete the run there.", cause: ErrConnected}
		}
	default:
		rep, err := r.call(r.lasting(ctx), rec.entry, http.MethodDelete, runPath(id, ""), nil, r.o.Limits.RunDelete)
		switch {
		case err != nil:
			return r.unmade(rec.entry, err)
		case rep.Status == http.StatusUnauthorized:
			return r.unreachable(rec.entry)
		case rep.Status != http.StatusOK && rep.Status != http.StatusNotFound:
			return r.errorOf(rec.entry, rep)
		}
	}
	for _, c := range r.all() {
		c.mu.Lock()
		if !c.removed && c.d.Run == id {
			r.drop(c)
			r.emitRemoved(c.id)
		}
		c.mu.Unlock()
	}
	if r.o.Local != nil {
		r.o.Local.DeleteOnRun(id)
	}
	r.removeRun(rec)
	return nil
}

// MoveRun puts the run record in the group, its place in this server's sidebar, and tells the
// pages. The group is not checked: RunPatch does that for a page's move, and the delete of a
// group moves its records to the parent with this. Nothing is sent to the run's server.
func (r *Relay) MoveRun(id, group string) error {
	rec := r.runRec(id)
	if rec == nil {
		return noRun()
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed {
		return noRun()
	}
	if rec.d.Group != group {
		rec.d.Group = group
		r.keepRun(rec, true)
		r.emitRun(rec)
	}
	return nil
}
