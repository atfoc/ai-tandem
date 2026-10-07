package app

import (
	"context"
	"errors"
	"sync"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/runs"
)

// The chats and the runs of other servers in the app's own structure. Such a chat or run is a
// record of the relay (App.Remotes): its thread or its work is on its server, and its place, a
// group of this server, is here. So a record is part of the snapshot and of what a group's
// archive, unarchive and delete reach. What is done to the chat or the run itself is the
// relay's: it shows the change here at once and passes it on to the item's server.

// withRecords adds the records to the snapshot: their views and branch states among the chats,
// and the lists of the servers. A chat becomes a record under its id (its first message), and
// the two are read one after the other: an id that has both by then is listed once, as the
// record.
func (a *App) withRecords(snap *Snapshot) {
	snap.Lists = a.Remotes.Lists()
	views, states := a.Remotes.Views(), a.Remotes.States()
	if len(views) == 0 {
		return
	}
	record := make(map[string]bool, len(views))
	for _, v := range views {
		record[v.ID] = true
	}
	local := snap.Chats[:0:0]
	for _, c := range snap.Chats {
		if !record[c.ID] {
			local = append(local, c)
		}
	}
	own := snap.States[:0:0]
	for _, st := range snap.States {
		if !record[st.Chat] {
			own = append(own, st)
		}
	}
	snap.Chats, snap.States = append(local, views...), append(own, states...)
}

// withRunRecords adds the run records to the snapshot's runs. A draft run becomes a record under
// its id (its start), and the two are read one after the other, the drafts first: an id that
// has both by then is listed once, as the record.
func (a *App) withRunRecords(snap *Snapshot) {
	views := a.Remotes.RunViews()
	if len(views) == 0 {
		return
	}
	record := make(map[string]bool, len(views))
	for _, v := range views {
		record[v.ID] = true
	}
	local := snap.Runs[:0:0]
	for _, r := range snap.Runs {
		if !record[r.ID] {
			local = append(local, r)
		}
	}
	snap.Runs = append(local, views...)
}

// record is the view of the record with this chat id.
func (a *App) record(id string) (model.ChatView, bool) {
	if a.Remotes == nil || !a.Remotes.Has(id) {
		return model.ChatView{}, false
	}
	for _, v := range a.Remotes.Views() {
		if v.ID == id {
			return v, true
		}
	}
	return model.ChatView{}, false
}

// recordsIn returns the records whose place is one of the groups in.
func (a *App) recordsIn(in map[string]bool) []model.ChatView {
	if a.Remotes == nil {
		return nil
	}
	var out []model.ChatView
	for _, v := range a.Remotes.Views() {
		if v.Run == "" && in[v.Group] {
			out = append(out, v)
		}
	}
	return out
}

// runRecord is the view of the run record with this id.
func (a *App) runRecord(id string) (model.RunView, bool) {
	if a.Remotes == nil || !a.Remotes.HasRun(id) {
		return model.RunView{}, false
	}
	for _, v := range a.Remotes.RunViews() {
		if v.ID == id {
			return v, true
		}
	}
	return model.RunView{}, false
}

// runRecordsIn returns the run records whose place is one of the groups in.
func (a *App) runRecordsIn(in map[string]bool) []model.RunView {
	if a.Remotes == nil {
		return nil
	}
	var out []model.RunView
	for _, v := range a.Remotes.RunViews() {
		if in[v.Group] {
			out = append(out, v)
		}
	}
	return out
}

// GroupState says whether the group exists and whether it is archived: what the relay asks
// before a record is moved (remotes.Options.Group).
func (a *App) GroupState(id string) (exists, archived bool) {
	a.St.Read(func(s *model.State) {
		if i := groupIndex(s.Groups, id); i >= 0 {
			exists, archived = true, s.Groups[i].Archived
		}
	})
	return exists, archived
}

// ArchiveRecord archives the chat of a record, as the user's own action. The mark shows at
// once; the relay passes it on to the chat's server now or when that server connects next.
func (a *App) ArchiveRecord(ctx context.Context, id string) error {
	if a.Remotes == nil {
		return chats.ErrNotFound
	}
	return a.Remotes.Archive(ctx, id, "")
}

// UnarchiveRecord is ArchiveRecord's reverse. As for a chat of this server, the archived groups
// the record is nested in come back with it.
func (a *App) UnarchiveRecord(ctx context.Context, id string) error {
	v, ok := a.record(id)
	if !ok {
		return chats.ErrNotFound
	}
	if err := a.Remotes.Unarchive(ctx, id); err != nil {
		return err
	}
	return a.unarchiveGroupRecord(v.Group)
}

// ArchiveRunRecord archives the run of a run record, as the user's own action. The mark shows at
// once; the relay passes it on to the run's server now or when that server connects next. That
// server stops a live run first and archives the chats on it.
func (a *App) ArchiveRunRecord(ctx context.Context, id string) error {
	if a.Remotes == nil {
		return runs.ErrNotFound
	}
	return a.Remotes.ArchiveRun(ctx, id, "")
}

// UnarchiveRunRecord is ArchiveRunRecord's reverse. As for a run of this server, the archived
// groups the record is nested in come back with it.
func (a *App) UnarchiveRunRecord(ctx context.Context, id string) error {
	v, ok := a.runRecord(id)
	if !ok {
		return runs.ErrNotFound
	}
	if err := a.Remotes.UnarchiveRun(ctx, id); err != nil {
		return err
	}
	return a.unarchiveGroupRecord(v.Group)
}

// eachRecord calls f for every id at the same time, so that servers that do not answer cost one
// wait and not one each.
func eachRecord(ids []string, f func(id string)) {
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			f(id)
		}()
	}
	wg.Wait()
}

// archiveRecords archives, as part of the archive action ar, every record of the groups in that
// is not archived: the chats and the runs. It fails for none: a server that cannot be asked gets
// the change when it connects next, and one that refuses it keeps its chat or run as it is.
func (a *App) archiveRecords(in map[string]bool, ar model.Archive) {
	var ids []string
	run := map[string]bool{}
	for _, v := range a.recordsIn(in) {
		if !v.Archived {
			ids = append(ids, v.ID)
		}
	}
	for _, v := range a.runRecordsIn(in) {
		if !v.Archived {
			ids, run[v.ID] = append(ids, v.ID), true
		}
	}
	eachRecord(ids, func(id string) {
		if run[id] {
			_ = a.Remotes.ArchiveRun(context.Background(), id, ar.Op)
			return
		}
		_ = a.Remotes.Archive(context.Background(), id, ar.Op)
	})
}

// unarchiveRecords brings back the records of the groups in that the archive action op
// archived, chats and runs. A mark made on an item's own server belongs to no action here and
// stays.
func (a *App) unarchiveRecords(in map[string]bool, op string) {
	if a.Remotes == nil || op == "" {
		return
	}
	with, run := map[string]bool{}, map[string]bool{}
	for _, id := range a.Remotes.ArchivedWith(op) {
		with[id] = true
	}
	for _, id := range a.Remotes.RunsArchivedWith(op) {
		with[id], run[id] = true, true
	}
	var ids []string
	for _, v := range a.recordsIn(in) {
		if with[v.ID] && !run[v.ID] {
			ids = append(ids, v.ID)
		}
	}
	for _, v := range a.runRecordsIn(in) {
		if run[v.ID] {
			ids = append(ids, v.ID)
		}
	}
	eachRecord(ids, func(id string) {
		if run[id] {
			_ = a.Remotes.UnarchiveRun(context.Background(), id)
			return
		}
		_ = a.Remotes.Unarchive(context.Background(), id)
	})
}

// deleteRecords deletes the chats and the runs of the records of the groups in on their servers,
// and the records with them: the chats first, then the runs. An item whose server is not
// connected could not be deleted, so the check comes before anything is deleted
// (remotes.Relay.Deletable); after it the first failure ends the work. The caller deletes
// nothing of its own before this has returned nil.
func (a *App) deleteRecords(in map[string]bool) error {
	if a.Remotes == nil {
		return nil
	}
	if err := a.Remotes.Deletable(in); err != nil {
		return err
	}
	for _, v := range a.recordsIn(in) {
		if err := a.Remotes.Delete(context.Background(), v.ID, false); err != nil && !errors.Is(err, chats.ErrNotFound) {
			return err
		}
	}
	for _, v := range a.runRecordsIn(in) {
		if err := a.Remotes.DeleteRun(context.Background(), v.ID, false); err != nil && !errors.Is(err, runs.ErrNotFound) {
			return err
		}
	}
	return nil
}

// moveRecords puts the records of the groups in, chats and runs, into the group to. Nothing is
// sent for it: a record's place is this server's alone.
func (a *App) moveRecords(in map[string]bool, to string) error {
	for _, v := range a.recordsIn(in) {
		if err := a.Remotes.Move(v.ID, to); err != nil && !errors.Is(err, chats.ErrNotFound) {
			return err
		}
	}
	for _, v := range a.runRecordsIn(in) {
		if err := a.Remotes.MoveRun(v.ID, to); err != nil && !errors.Is(err, runs.ErrNotFound) {
			return err
		}
	}
	return nil
}

// lateRecords is the second pass of a group's delete for the records: a draft run or a chat
// that started on its server since the first pass is a record now, in a group that is gone. It
// is deleted on its server like the rest, or moved to the group to. What could not be deleted
// is moved there too, so that no record stays in a group that is not there; the error says so.
func (a *App) lateRecords(gone map[string]bool, to string, deleteContents bool) error {
	if a.Remotes == nil {
		return nil
	}
	var err error
	if deleteContents {
		err = a.deleteRecords(gone)
	}
	return errors.Join(err, a.moveRecords(gone, to))
}
