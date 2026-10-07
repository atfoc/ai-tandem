package remotes

// Archive, unarchive and delete of a record.
//
// The archive mark of a chat is its server's (Record.Archived, as last received). A change made
// here is recorded first (Record.Pending) and shows at once; then it is passed on. When the
// server cannot be asked the change stays pending, and is passed on when the entry connects
// next (step 8 of a snapshot), where it wins over the mark the snapshot tells.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
)

// Archive archives the record's chat: by the user, or as part of the archive action op of a
// group ("" makes a new id). The mark shows at once, and the change is passed on to the chat's
// server when it is connected; else, or without an answer, it stays pending and nil is
// returned all the same. A record that is archived already keeps its mark and its action. The
// error is chats.ErrNotFound for no record, or an *Error when the server refused the change,
// which is then undone here.
func (r *Relay) Archive(ctx context.Context, id, op string) error {
	if op == "" {
		op = model.NewID("a_")
	}
	return r.setArchived(ctx, id, pendingArchive, op)
}

// Unarchive is Archive's reverse, with the same rules.
func (r *Relay) Unarchive(ctx context.Context, id string) error {
	return r.setArchived(ctx, id, pendingUnarchive, "")
}

func (r *Relay) setArchived(ctx context.Context, id, change, op string) error {
	rec := r.rec(id)
	if rec == nil {
		return chats.ErrNotFound
	}
	rec.mu.Lock()
	if rec.removed {
		rec.mu.Unlock()
		return chats.ErrNotFound
	}
	if viewOf(rec.d).Archived != (change == pendingArchive) {
		rec.d.Pending, rec.d.Op = change, op
		r.keep(rec, true)
		r.emitChat(rec)
	}
	rec.lost = 0 // the user's action is tried anew
	rec.mu.Unlock()
	return r.passArchive(ctx, rec)
}

// ArchivedWith are the ids of the records that the archive action op archived and that are
// still archived by it, sorted: what a group's unarchive brings back. A mark that was made on
// the chat's own server belongs to no action here.
func (r *Relay) ArchivedWith(op string) []string {
	ids := []string{}
	if op == "" {
		return ids
	}
	for _, rec := range r.all() {
		if v := rec.pub.Load().view; v.Archived && v.Op == op {
			ids = append(ids, rec.id)
		}
	}
	return ids
}

// passArchive passes the record's pending archive change on, if it has one. One runs at a time
// per record, and each sends what is pending when its turn comes, so the server gets the
// changes in the order they were made. nil is returned when the change was confirmed, and when
// it stays pending: the entry is not connected, did not answer, or cannot say (401, a 5xx).
// Any other refusal undoes the change here and is returned. A call that got no answer is made
// again in the background while the entry stays connected (see archiveLost).
func (r *Relay) passArchive(ctx context.Context, rec *record) error {
	defer r.locks.archive.lock(rec.id)()
	rec.mu.Lock()
	change, gone := rec.d.Pending, rec.d.Gone || rec.removed
	rec.mu.Unlock()
	if change == "" || gone {
		return nil // nothing to pass on, or nowhere: a gone chat's change waits for its return
	}
	rep, err := r.call(ctx, rec.entry, http.MethodPost, chatPath(rec.id, "/"+change), nil, r.o.Limits.Call)
	r.archiveLost(rec, err)
	if err != nil {
		return nil
	}
	var refused *Error
	switch {
	case rep.Status == http.StatusOK:
	case noSuchChat(rep):
		r.markGone(rec)
		return nil
	case rep.Status == http.StatusUnauthorized || rep.Status >= 500:
		r.o.Logf("remotes: the %s of the chat %s stays pending: its server answered %d", change, rec.id, rep.Status)
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
	r.keep(rec, true)
	r.emitChat(rec)
	if refused != nil {
		return refused
	}
	return nil
}

// archiveTries is the number of archive calls that are made in a row for one record, each
// without an answer, while its entry stays connected.
const archiveTries = 3

// archiveLost takes the end of an archive call of the record, err being what call returned.
// With no answer on an entry that is still connected the change would stay pending until the
// next connect or the user's next archive action on the record, while the page shows it as
// made. So the change is passed on again after Limits.Call, in the background: archiveTries
// calls in a row at most. An answer, an entry that is not connected, a connect and the user's
// next action start the count anew.
func (r *Relay) archiveLost(rec *record, err error) {
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
		case <-time.After(r.o.Limits.Call):
		}
		if !r.connected(rec.entry) {
			return // the next connect passes it on
		}
		if err := r.passArchive(r.ctx, rec); err != nil {
			r.o.Logf("remotes: the archive change of the chat %s was refused by its server: %v", rec.id, err)
		}
	})
}

// passPending is step 8 of a snapshot: every archive change of the entry's records that is not
// confirmed is passed on. It runs in a goroutine of its own.
func (r *Relay) passPending(ctx context.Context, entry string) {
	for _, rec := range r.on(entry) {
		if ctx.Err() != nil {
			return
		}
		rec.mu.Lock()
		rec.lost = 0 // a connect: tried anew
		rec.mu.Unlock()
		if err := r.passArchive(ctx, rec); err != nil {
			r.o.Logf("remotes: the archive change of the chat %s was refused by its server: %v", rec.id, err)
		}
	}
}

// Delete deletes the record's chat on its server, and the record with it: the pages get
// chat_removed. A record that is gone is removed with no call. No answer is 504, and the record
// stays; an entry that is not connected is 503.
//
// With localOnly ("Remove from this sidebar only") the record alone is removed and nothing is
// sent. That is accepted when the entry is not connected or the chat is gone there; else it is
// 409 server_connected.
func (r *Relay) Delete(ctx context.Context, id string, localOnly bool) error {
	rec := r.rec(id)
	if rec == nil {
		return chats.ErrNotFound
	}
	rec.mu.Lock()
	gone := rec.d.Gone
	rec.mu.Unlock()
	switch {
	case gone:
	case localOnly:
		if r.connected(rec.entry) {
			return &Error{Status: http.StatusConflict, Code: "server_connected",
				Text: r.name(rec.entry) + " is connected: delete the chat there.", cause: ErrConnected}
		}
	default:
		rep, err := r.call(r.lasting(ctx), rec.entry, http.MethodDelete, chatPath(id, ""), nil, r.o.Limits.Call)
		switch {
		case err != nil:
			return r.unmade(rec.entry, err)
		case rep.Status == http.StatusUnauthorized:
			return r.unreachable(rec.entry)
		case rep.Status != http.StatusOK && rep.Status != http.StatusNotFound:
			return r.errorOf(rec.entry, rep)
		}
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if !rec.removed {
		r.drop(rec)
		r.emitRemoved(id)
	}
	return nil
}

// Deletable is the check before a group is deleted with its contents: groups are the ids of the
// group and of every group below it. A record in one of them, of a chat or of a run, that is
// not gone and whose entry is not connected cannot be deleted on its server, so nothing may be
// deleted at all: 409 server_unreachable, with a sentence that names the chat or the run and
// the server. nil says that every record in the groups can be asked for.
func (r *Relay) Deletable(groups map[string]bool) error {
	for _, rec := range r.all() {
		v := rec.pub.Load().view
		if !groups[v.Group] || v.Gone || r.connected(rec.entry) {
			continue
		}
		name := v.Name
		if name == "" {
			name = "New chat"
		}
		return &Error{Status: http.StatusConflict, Code: "server_unreachable", cause: ErrUnreachable,
			Text: fmt.Sprintf("Nothing was deleted: “%s” is on %s, which is not connected.", name, r.name(rec.entry))}
	}
	for _, rec := range r.allRuns() {
		v := rec.view()
		if !groups[v.Group] || v.Gone || r.connected(rec.entry) {
			continue
		}
		name := v.Name
		if name == "" {
			name = "New run"
		}
		return &Error{Status: http.StatusConflict, Code: "server_unreachable", cause: ErrUnreachable,
			Text: fmt.Sprintf("Nothing was deleted: “%s” is on %s, which is not connected.", name, r.name(rec.entry))}
	}
	return nil
}
