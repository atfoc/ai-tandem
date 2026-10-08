package remotes

import (
	"context"
	"errors"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
)

// archiveRoutes makes the stand-in serve the archive and the unarchive of a chat from scripts.
func archiveRoutes(rg *rig) (archive, unarchive *script) {
	archive, unarchive = rg.script("POST /api/chats/{id}/archive"), rg.script("POST /api/chats/{id}/unarchive")
	archive.answer(http.StatusOK, map[string]bool{"ok": true})
	unarchive.answer(http.StatusOK, map[string]bool{"ok": true})
	return archive, unarchive
}

// TestArchiveConnected: an archive and an unarchive with the server connected.
func TestArchiveConnected(t *testing.T) {
	t.Parallel()
	rg := seeded(t, rigOpt{}, chatA, chatB)
	archive, unarchive := archiveRoutes(rg)
	ctx := context.Background()
	p, _ := rg.page("page-1")

	if err := rg.r.Archive(ctx, chatA, "a_group1"); err != nil {
		t.Fatal(err)
	}
	if q := archive.last(t); q.URI != "/api/chats/"+chatA+"/archive" || q.Body != "" {
		t.Errorf("the server got %+v", q)
	}
	if d := rg.file(chatA); !d.Archived || d.Pending != "" || d.Op != "a_group1" {
		t.Errorf("the record: %+v", d)
	}
	// The mark shows at once, before the server is asked, and stays with the confirmation.
	for range 2 {
		if ev := p.Expect("chat"); field(ev, "chat", "archived") != true || field(ev, "chat", "archiveOp") != "a_group1" {
			t.Errorf("the pages were told %v", ev)
		}
	}
	// The server's own event of the change tells the same.
	there := remoteView(chatA, model.StatusReady)
	there.Archived, there.Op = true, "a_there"
	rg.s.Send(map[string]any{"type": "chat", "chat": there})
	if ev := p.Expect("chat"); field(ev, "chat", "archived") != true || field(ev, "chat", "archiveOp") != "a_group1" {
		t.Errorf("after the server's event: %v", ev)
	}

	// An archive of an archived record keeps its action and sends nothing.
	sent := archive.count()
	if err := rg.r.Archive(ctx, chatA, "a_other"); err != nil || archive.count() != sent || rg.file(chatA).Op != "a_group1" {
		t.Errorf("a second archive: %v, %d sent, op %q", err, archive.count()-sent, rg.file(chatA).Op)
	}
	// With no action named, a new id.
	if err := rg.r.Archive(ctx, chatB, ""); err != nil || !strings.HasPrefix(rg.file(chatB).Op, "a_") {
		t.Errorf("an archive by the user: %v, op %q", err, rg.file(chatB).Op)
	}
	p.Expect("chat")
	p.Expect("chat")

	// ArchivedWith: the records an action archived.
	if got := rg.r.ArchivedWith("a_group1"); !reflect.DeepEqual(got, []string{chatA}) {
		t.Errorf("ArchivedWith: %v", got)
	}
	if got := rg.r.ArchivedWith("a_none"); len(got) != 0 || got == nil {
		t.Errorf("ArchivedWith of no action: %v", got)
	}
	if got := rg.r.ArchivedWith(""); len(got) != 0 {
		t.Errorf("ArchivedWith of the empty action: %v", got)
	}

	if err := rg.r.Unarchive(ctx, chatA); err != nil {
		t.Fatal(err)
	}
	if q := unarchive.last(t); q.URI != "/api/chats/"+chatA+"/unarchive" {
		t.Errorf("the server got %+v", q)
	}
	if d := rg.file(chatA); d.Archived || d.Pending != "" || d.Op != "" {
		t.Errorf("the record after the unarchive: %+v", d)
	}
	for range 2 {
		if ev := p.Expect("chat"); field(ev, "chat", "archived") != nil || field(ev, "chat", "archiveOp") != nil {
			t.Errorf("the pages were told %v", ev)
		}
	}
	if got := rg.r.ArchivedWith("a_group1"); len(got) != 0 {
		t.Errorf("ArchivedWith after the unarchive: %v", got)
	}
	if err := rg.r.Archive(ctx, "1c000000-0000-4000-8000-00000000000c", ""); !errors.Is(err, chats.ErrNotFound) {
		t.Errorf("an archive without a record: %v", err)
	}

	// A change the server refuses is undone here, and the refusal is the caller's.
	archive.answer(http.StatusConflict, map[string]string{"error": "the chat cannot be archived"})
	err := rg.r.Archive(ctx, chatA, "")
	var e *Error
	if !errors.As(err, &e) || e.Status != http.StatusConflict || e.Text != "the chat cannot be archived" {
		t.Errorf("a refused archive: %v", err)
	}
	if d := rg.file(chatA); d.Archived || d.Pending != "" || d.Op != "" {
		t.Errorf("the record after a refused archive: %+v", d)
	}
}

// TestArchiveNoAnswer: an archive the server does not answer stays pending, and that is no failure.
func TestArchiveNoAnswer(t *testing.T) {
	t.Parallel()
	rg := seeded(t, rigOpt{limits: Limits{Call: 150 * time.Millisecond}}, chatA)
	archive, _ := archiveRoutes(rg)
	_, free := archive.hang()
	defer free()
	p, _ := rg.page("page-1")
	if err := rg.r.Archive(context.Background(), chatA, "a_late"); err != nil {
		t.Errorf("an archive without an answer: %v", err)
	}
	if d := rg.file(chatA); d.Archived || d.Pending != pendingArchive || d.Op != "a_late" {
		t.Errorf("the record after an archive without an answer: %+v", d)
	}
	if ev := p.Expect("chat"); field(ev, "chat", "archived") != true || field(ev, "chat", "archiveOp") != "a_late" {
		t.Errorf("the pages were told %v", ev)
	}
	// The server's event of the change, which did arrive, confirms it.
	there := remoteView(chatA, model.StatusReady)
	there.Archived = true
	rg.s.Send(map[string]any{"type": "chat", "chat": there})
	p.Expect("chat")
	if d := rg.file(chatA); !d.Archived || d.Pending != "" || d.Op != "a_late" {
		t.Errorf("the record after the server's event: %+v", d)
	}
}

// TestArchiveTriedAgain: an archive call that gets no answer on an entry that stays connected is
// made again, with no reconnect and no action of the user: three calls in a row at most.
func TestArchiveTriedAgain(t *testing.T) {
	t.Parallel()
	// The calls that get no answer end at once, and the wait before the next one is short: no
	// limit is waited out, and the calls that are answered have the usual limits.
	const again = 20 * time.Millisecond
	rg := seeded(t, rigOpt{again: again}, chatA)
	archive, unarchive := archiveRoutes(rg)
	ctx := context.Background()
	var calls atomic.Int32
	archive.set(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			panic(http.ErrAbortHandler) // the first call gets no answer
		}
		writeAnswer(w, http.StatusOK, map[string]bool{"ok": true})
	})
	if err := rg.r.Archive(ctx, chatA, "a_again"); err != nil {
		t.Errorf("an archive without an answer: %v", err)
	}
	if d := rg.file(chatA); d.Archived || d.Pending != pendingArchive {
		t.Errorf("the record after the call without an answer: %+v", d)
	}
	rg.until("the archive is passed on again", func() bool {
		d := rg.file(chatA)
		return d.Archived && d.Pending == "" && d.Op == "a_again"
	})
	if n := archive.count(); n != 2 {
		t.Errorf("%d archive calls, want 2", n)
	}
	if n := rg.local.upCount(); n != 1 {
		t.Errorf("the entry connected %d times: the second call was a reconnect's", n)
	}

	// A server that never answers gets three calls, and no more.
	unarchive.drop()
	if err := rg.r.Unarchive(ctx, chatA); err != nil {
		t.Errorf("an unarchive without an answer: %v", err)
	}
	rg.until("the unarchive is sent three times", func() bool { return unarchive.count() == archiveTries })
	time.Sleep(quiet) // several times the wait before a next call
	if n := unarchive.count(); n != archiveTries {
		t.Errorf("%d unarchive calls, want %d", n, archiveTries)
	}
	if d := rg.file(chatA); !d.Archived || d.Pending != pendingUnarchive {
		t.Errorf("the record after three calls without an answer: %+v", d)
	}
	// The user's next action is tried anew.
	if err := rg.r.Archive(ctx, chatA, ""); err != nil { // it is archived there: nothing is pending
		t.Error(err)
	}
	if err := rg.r.Unarchive(ctx, chatA); err != nil {
		t.Error(err)
	}
	rg.until("the next unarchive is tried three times too", func() bool { return unarchive.count() == 2*archiveTries })
}

// TestArchivePending: an archive made while the server is away stays pending, wins over the
// snapshot of the return and is then passed on.
func TestArchivePending(t *testing.T) {
	t.Parallel()
	rg := seeded(t, rigOpt{}, chatA, chatB)
	archive, unarchive := archiveRoutes(rg)
	ctx := context.Background()
	p, _ := rg.page("page-1")

	// chatB is archived and confirmed; its unarchive will be the pending change.
	if err := rg.r.Archive(ctx, chatB, "a_b"); err != nil {
		t.Fatal(err)
	}
	p.Expect("chat")
	p.Expect("chat")

	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	if err := rg.r.Archive(ctx, chatA, "a_down"); err != nil {
		t.Errorf("an archive while the server is away: %v", err)
	}
	if err := rg.r.Unarchive(ctx, chatB); err != nil {
		t.Errorf("an unarchive while the server is away: %v", err)
	}
	if ev := p.Expect("chat"); field(ev, "chat", "id") != chatA || field(ev, "chat", "archived") != true || field(ev, "chat", "archiveOp") != "a_down" {
		t.Errorf("the mark does not show at once: %v", ev)
	}
	if ev := p.Expect("chat"); field(ev, "chat", "id") != chatB || field(ev, "chat", "archived") != nil {
		t.Errorf("the unarchive does not show at once: %v", ev)
	}
	if a, b := rg.file(chatA), rg.file(chatB); a.Pending != pendingArchive || a.Archived || a.Op != "a_down" ||
		b.Pending != pendingUnarchive || !b.Archived || b.Op != "" {
		t.Errorf("the records while the server is away: %+v\n%+v", a, b)
	}
	if got := rg.r.ArchivedWith("a_down"); !reflect.DeepEqual(got, []string{chatA}) {
		t.Errorf("ArchivedWith of a pending archive: %v", got)
	}
	before := archive.count() + unarchive.count()

	// The return: the snapshot tells the marks as that server has them, the reverse of what is
	// pending. The pending changes win, and are passed on.
	a, b := remoteView(chatA, model.StatusReady), remoteView(chatB, model.StatusReady)
	b.Archived, b.Op = true, "a_there"
	rg.s.SetSnapshot(snapshotWith(a, b))
	rg.s.Restart()
	rg.returned(2)
	var evs []map[string]any
	for range 6 {
		evs = append(evs, p.Next())
	}
	if got, want := types(evs), []string{"server_lists", "server_back", "branch_state", "chat", "branch_state", "chat"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the events of the return: %v", got)
	}
	if field(evs[3], "chat", "archived") != true || field(evs[3], "chat", "archiveOp") != "a_down" || field(evs[5], "chat", "archived") != nil {
		t.Errorf("the snapshot's marks won over the pending changes: %v\n%v", evs[3], evs[5])
	}
	rg.until("the pending changes are passed on", func() bool { return archive.count()+unarchive.count() == before+2 })
	if q := archive.last(t); q.URI != "/api/chats/"+chatA+"/archive" {
		t.Errorf("the archive that was passed on: %+v", q)
	}
	if q := unarchive.last(t); q.URI != "/api/chats/"+chatB+"/unarchive" {
		t.Errorf("the unarchive that was passed on: %+v", q)
	}
	rg.until("the changes are confirmed", func() bool {
		a, b := rg.file(chatA), rg.file(chatB)
		return a.Pending == "" && a.Archived && a.Op == "a_down" && b.Pending == "" && !b.Archived
	})

	// Another return: nothing is pending, so nothing is passed on.
	a.Archived = true
	rg.s.SetSnapshot(snapshotWith(a, remoteView(chatB, model.StatusReady)))
	rg.s.DropStreams()
	rg.returned(3)
	time.Sleep(quiet)
	if got := archive.count() + unarchive.count(); got != before+2 {
		t.Errorf("a return with nothing pending passed %d changes on", got-before-2)
	}
	if d := rg.file(chatA); !d.Archived || d.Op != "a_down" {
		t.Errorf("the record after the second return: %+v", d)
	}
}

// TestArchivedThere: a mark made on the chat's own server is taken, belongs to no archive action
// here, and is kept at a reconnect, where nothing is sent for it.
func TestArchivedThere(t *testing.T) {
	t.Parallel()
	rg := seeded(t, rigOpt{}, chatA)
	archive, unarchive := archiveRoutes(rg)
	p, _ := rg.page("page-1")

	there := remoteView(chatA, model.StatusReady)
	there.Archived, there.Op = true, "a_there"
	rg.s.Send(map[string]any{"type": "chat", "chat": there})
	if ev := p.Expect("chat"); field(ev, "chat", "archived") != true || field(ev, "chat", "archiveOp") != nil {
		t.Errorf("the pages were told %v", ev)
	}
	rg.until("the mark is written", func() bool { return rg.file(chatA).Archived })
	if d := rg.file(chatA); d.Op != "" || d.Pending != "" {
		t.Errorf("the record: %+v", d)
	}
	if got := rg.r.ArchivedWith("a_there"); len(got) != 0 {
		t.Errorf("the server's own action counts as one of this server's: %v", got)
	}

	rg.s.SetSnapshot(snapshotWith(there))
	rg.s.DropStreams()
	rg.returned(2)
	var evs []map[string]any
	for range 4 {
		evs = append(evs, p.Next())
	}
	if field(evs[3], "chat", "archived") != true || field(evs[3], "chat", "archiveOp") != nil {
		t.Errorf("after the reconnect: %v", evs[3])
	}
	time.Sleep(quiet)
	if d := rg.file(chatA); !d.Archived || d.Op != "" || d.Pending != "" || archive.count()+unarchive.count() != 0 {
		t.Errorf("the record after the reconnect: %+v, %d changes sent", d, archive.count()+unarchive.count())
	}
}

// TestDelete: the delete of a record's chat.
func TestDelete(t *testing.T) {
	t.Parallel()
	ids := []string{chatN(1), chatN(2), chatN(3), chatN(4), chatN(5)}
	rg := seeded(t, rigOpt{limits: Limits{Call: 150 * time.Millisecond}}, ids...)
	ctx := context.Background()
	p, _ := rg.page("page-1")
	del := rg.script("DELETE /api/chats/{id}")
	gone := func(id string) bool {
		_, err := os.Stat(rg.r.files.path(id))
		return os.IsNotExist(err) && !rg.r.Has(id)
	}
	check := func(what string, err error, status int, code string) {
		t.Helper()
		var e *Error
		if !errors.As(err, &e) || e.Status != status || e.Code != code {
			t.Errorf("%s: %v", what, err)
		}
		if rep := ReplyOf(err); rep.Status != status || body(t, rep)["error"] == "" {
			t.Errorf("%s as an answer: %d %s", what, rep.Status, rep.Body)
		}
	}

	// 200 there: the record and its file go, and the pages are told.
	del.answer(http.StatusOK, map[string]bool{"ok": true})
	if err := rg.r.Delete(ctx, ids[0], false); err != nil || !gone(ids[0]) {
		t.Errorf("a delete: %v, gone %v", err, gone(ids[0]))
	}
	if q := del.last(t); q.URI != "/api/chats/"+ids[0] {
		t.Errorf("the server got %+v", q)
	}
	if ev := p.Expect("chat_removed"); ev["id"] != ids[0] {
		t.Errorf("the pages were told %v", ev)
	}
	// 404 there: the same.
	del.answer(http.StatusNotFound, map[string]string{"error": "no such chat"})
	if err := rg.r.Delete(ctx, ids[1], false); err != nil || !gone(ids[1]) {
		t.Errorf("a delete of a chat that is not there: %v, gone %v", err, gone(ids[1]))
	}
	p.Expect("chat_removed")

	// "Remove from this sidebar only" is refused while the server is connected and has the chat.
	sent := del.count()
	err := rg.r.Delete(ctx, ids[2], true)
	check("local only while connected", err, http.StatusConflict, "server_connected")
	if !errors.Is(err, ErrConnected) || gone(ids[2]) || del.count() != sent {
		t.Errorf("local only while connected: %v, gone %v", err, gone(ids[2]))
	}
	// Another answer: the server's status and sentence, and the record stays.
	del.answer(http.StatusInternalServerError, map[string]string{"error": "boom"})
	err = rg.r.Delete(ctx, ids[2], false)
	check("a delete the server fails", err, http.StatusInternalServerError, "")
	if err.Error() != "boom" || gone(ids[2]) {
		t.Errorf("a delete the server fails: %v, gone %v", err, gone(ids[2]))
	}
	// No answer: 504, and the record stays.
	_, free := del.hang()
	defer free()
	err = rg.r.Delete(ctx, ids[2], false)
	check("a delete without an answer", err, http.StatusGatewayTimeout, "no_answer")
	if !errors.Is(err, ErrNoAnswer) || gone(ids[2]) {
		t.Errorf("a delete without an answer: %v, gone %v", err, gone(ids[2]))
	}
	p.ExpectNone(quiet)

	// A record that is gone there is removed with no call, local only or not.
	rg.s.Send(map[string]any{"type": "chat_removed", "id": ids[3]})
	rg.s.Send(map[string]any{"type": "chat_removed", "id": ids[4]})
	p.Expect("chat")
	p.Expect("chat")
	sent = del.count()
	if err := rg.r.Delete(ctx, ids[3], true); err != nil || !gone(ids[3]) {
		t.Errorf("local only for a gone record: %v", err)
	}
	if err := rg.r.Delete(ctx, ids[4], false); err != nil || !gone(ids[4]) || del.count() != sent {
		t.Errorf("a delete of a gone record: %v, %d sent", err, del.count()-sent)
	}
	p.Expect("chat_removed")
	p.Expect("chat_removed")

	// Not connected: 503 and the record stays; local only is accepted, and nothing is sent.
	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	err = rg.r.Delete(ctx, ids[2], false)
	check("a delete while not connected", err, http.StatusServiceUnavailable, "server_unreachable")
	if !errors.Is(err, ErrUnreachable) || err.Error() != "Studio is not connected." || gone(ids[2]) {
		t.Errorf("a delete while not connected: %v, gone %v", err, gone(ids[2]))
	}
	if err := rg.r.Delete(ctx, ids[2], true); err != nil || !gone(ids[2]) {
		t.Errorf("local only while not connected: %v, gone %v", err, gone(ids[2]))
	}
	if ev := p.Expect("chat_removed"); ev["id"] != ids[2] {
		t.Errorf("the pages were told %v", ev)
	}
	if err := rg.r.Delete(ctx, ids[2], false); !errors.Is(err, chats.ErrNotFound) || ReplyOf(err).Status != http.StatusNotFound {
		t.Errorf("a delete without a record: %v", err)
	}
	if n, _ := rg.r.Counts(rg.entry); n != 0 {
		t.Errorf("%d records are left", n)
	}
	if rep := ReplyOf(nil); rep.Status != http.StatusOK || string(rep.Body) != `{"ok":true}` {
		t.Errorf("ReplyOf(nil): %d %s", rep.Status, rep.Body)
	}
}

// TestDeletable: the check before a group is deleted with its contents.
func TestDeletable(t *testing.T) {
	t.Parallel()
	inside, unnamed, outside, goneRec := seedOf(chatN(1)), seedOf(chatN(2)), seedOf(chatN(3)), seedOf(chatN(4))
	inside.Group, inside.View.Name = "g_sub", "Plan the “launch”"
	unnamed.Group, unnamed.View.Name = "g_top", ""
	outside.Group = "g_else"
	goneRec.Group, goneRec.Gone = "g_top", true
	rg := newRig(t, rigOpt{
		snapshot: snapshotWith(inside.View, unnamed.View, outside.View),
		seed:     []Record{inside, unnamed, outside, goneRec},
	})
	tree := map[string]bool{"g_top": true, "g_sub": true}

	if err := rg.r.Deletable(tree); err != nil {
		t.Errorf("with the server connected: %v", err)
	}
	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	err := rg.r.Deletable(tree)
	var e *Error
	if !errors.As(err, &e) || e.Status != http.StatusConflict || e.Code != "server_unreachable" || !errors.Is(err, ErrUnreachable) ||
		e.Text != "Nothing was deleted: “Plan the “launch”” is on Studio, which is not connected." {
		t.Errorf("with the server away: %v", err)
	}
	// A chat with no name yet is named as the sidebar names it.
	if err := rg.r.Deletable(map[string]bool{"g_top": true}); err == nil ||
		err.Error() != "Nothing was deleted: “New chat” is on Studio, which is not connected." {
		t.Errorf("an unnamed chat: %v", err)
	}
	// Records outside the groups, and gone ones, do not stand in the way.
	if err := rg.r.Deletable(map[string]bool{"g_other": true}); err != nil {
		t.Errorf("groups without a record: %v", err)
	}
	if err := rg.r.Delete(context.Background(), unnamed.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := rg.r.Deletable(map[string]bool{"g_top": true}); err != nil {
		t.Errorf("a group with a gone record alone: %v", err)
	}
	// Move: the records of a group that is deleted without its contents go to its parent.
	if err := rg.r.Move(inside.ID, "g_top"); err != nil || rg.file(inside.ID).Group != "g_top" {
		t.Errorf("Move: %v", err)
	}
	if err := rg.r.Move(chatA, "g_top"); !errors.Is(err, chats.ErrNotFound) {
		t.Errorf("Move without a record: %v", err)
	}
}
