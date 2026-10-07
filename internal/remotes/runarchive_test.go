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

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/servers"
)

// runArchiveRoutes makes the stand-in answer the archive and the unarchive of every run with 200.
func runArchiveRoutes(rg *rig) (archive, unarchive *script) {
	archive, unarchive = rg.script("POST /api/runs/{id}/archive"), rg.script("POST /api/runs/{id}/unarchive")
	archive.answer(http.StatusOK, map[string]bool{"ok": true})
	unarchive.answer(http.StatusOK, map[string]bool{"ok": true})
	return archive, unarchive
}

// TestRunArchiveConnected: archive and unarchive of a run record whose server answers.
func TestRunArchiveConnected(t *testing.T) {
	rg := seededRuns(t, rigOpt{limits: Limits{Call: 100 * time.Millisecond, Start: 3 * time.Second}}, runA, runB)
	archive, unarchive := runArchiveRoutes(rg)
	ctx := context.Background()
	p, _ := rg.page("page-1")

	// The call waits Limits.Start: that server stops a live run first.
	archive.set(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		writeAnswer(w, http.StatusOK, map[string]bool{"ok": true})
	})
	if err := rg.r.ArchiveRun(ctx, runA, "a_1"); err != nil {
		t.Fatalf("an archive: %v", err)
	}
	if q := archive.last(t); q.Method != http.MethodPost || q.URI != "/api/runs/"+runA+"/archive" || q.Body != "" {
		t.Errorf("the server got %+v", q)
	}
	for _, what := range []string{"at once", "confirmed"} {
		if ev := p.Expect("run"); field(ev, "run", "id") != runA || field(ev, "run", "archived") != true || field(ev, "run", "archiveOp") != "a_1" {
			t.Errorf("the mark %s: %v", what, ev)
		}
	}
	if d := rg.runFile(runA); !d.Archived || d.Pending != "" || d.Op != "a_1" {
		t.Errorf("the record: %+v", d)
	}
	if got := rg.r.RunsArchivedWith("a_1"); !reflect.DeepEqual(got, []string{runA}) {
		t.Errorf("RunsArchivedWith: %v", got)
	}
	if got := rg.r.RunsArchivedWith(""); got == nil || len(got) != 0 {
		t.Errorf("RunsArchivedWith of no action: %v", got)
	}
	// A record that is archived keeps its mark and its action; nothing is sent.
	archive.answer(http.StatusOK, map[string]bool{"ok": true})
	sent := archive.count()
	if err := rg.r.ArchiveRun(ctx, runA, "a_2"); err != nil || rg.runFile(runA).Op != "a_1" || archive.count() != sent {
		t.Errorf("a second archive: %v, %+v", err, rg.runFile(runA))
	}
	// The user's own archive makes an action id.
	if err := rg.r.ArchiveRun(ctx, runB, ""); err != nil || !strings.HasPrefix(rg.runFile(runB).Op, "a_") {
		t.Errorf("an archive by the user: %v, %+v", err, rg.runFile(runB))
	}
	p.Expect("run")
	p.Expect("run")

	if err := rg.r.UnarchiveRun(ctx, runA); err != nil {
		t.Fatalf("an unarchive: %v", err)
	}
	if q := unarchive.last(t); q.URI != "/api/runs/"+runA+"/unarchive" {
		t.Errorf("the server got %+v", q)
	}
	for range 2 {
		if ev := p.Expect("run"); field(ev, "run", "archived") != nil || field(ev, "run", "archiveOp") != nil {
			t.Errorf("the unarchive: %v", ev)
		}
	}
	if d := rg.runFile(runA); d.Archived || d.Pending != "" || d.Op != "" {
		t.Errorf("the record after the unarchive: %+v", d)
	}

	// A refusal there undoes the change and is returned.
	archive.answer(http.StatusConflict, map[string]string{"error": "the run cannot be archived now", "code": "not_now"})
	err := rg.r.ArchiveRun(ctx, runA, "a_3")
	var e *Error
	if !errors.As(err, &e) || e.Status != http.StatusConflict || e.Code != "not_now" || e.Text != "the run cannot be archived now" {
		t.Errorf("a refused archive: %v", err)
	}
	refused(t, "a refused archive as an answer", ReplyOf(err), http.StatusConflict, "not_now", "the run cannot be archived now")
	if ev := p.Expect("run"); field(ev, "run", "archived") != true {
		t.Errorf("the mark at once: %v", ev)
	}
	if ev := p.Expect("run"); field(ev, "run", "archived") != nil || field(ev, "run", "archiveOp") != nil {
		t.Errorf("the mark undone: %v", ev)
	}
	if d := rg.runFile(runA); d.Archived || d.Pending != "" || d.Op != "" {
		t.Errorf("the record after the refusal: %+v", d)
	}
	// A server that cannot say leaves the change pending; its event of the change confirms it.
	archive.answer(http.StatusInternalServerError, map[string]string{"error": "boom"})
	if err := rg.r.ArchiveRun(ctx, runA, "a_4"); err != nil {
		t.Errorf("an archive the server fails: %v", err)
	}
	p.Expect("run")
	if d := rg.runFile(runA); d.Archived || d.Pending != pendingArchive || d.Op != "a_4" {
		t.Errorf("the record after a 500: %+v", d)
	}
	there := remoteRun(runA, model.RunStopped)
	there.Archived = true
	rg.s.Send(map[string]any{"type": "run", "run": there})
	p.Expect("run")
	if d := rg.runFile(runA); !d.Archived || d.Pending != "" || d.Op != "a_4" {
		t.Errorf("the record after the server's event: %+v", d)
	}
	// "no such run": the record is gone there, and the change waits for its return.
	unarchive.answer(http.StatusNotFound, map[string]string{"error": "no such run"})
	if err := rg.r.UnarchiveRun(ctx, runA); err != nil {
		t.Errorf("an unarchive of a run that is gone: %v", err)
	}
	if d := rg.runFile(runA); !d.Gone || d.Pending != pendingUnarchive {
		t.Errorf("the record of a run that is gone: %+v", d)
	}
	// No record.
	err = rg.r.ArchiveRun(ctx, runN(9), "")
	if !errors.Is(err, runs.ErrNotFound) || ReplyOf(err).Status != http.StatusNotFound {
		t.Errorf("an archive without a record: %v", err)
	}
	refused(t, "an unarchive without a record", ReplyOf(rg.r.UnarchiveRun(ctx, runN(9))), http.StatusNotFound, "", "no such run")
	noSecret(t, "the log", strings.Join(rg.logs.all(), "\n"))
}

// TestRunArchiveTriedAgain: an archive call that gets no answer on an entry that stays connected
// is made again, with no reconnect and no action of the user: three calls in a row at most.
func TestRunArchiveTriedAgain(t *testing.T) {
	rg := seededRuns(t, rigOpt{limits: Limits{Call: 150 * time.Millisecond, Start: 150 * time.Millisecond}}, runA)
	archive, unarchive := runArchiveRoutes(rg)
	ctx := context.Background()
	var calls atomic.Int32
	archive.set(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			<-r.Context().Done() // the first call is swallowed
			return
		}
		writeAnswer(w, http.StatusOK, map[string]bool{"ok": true})
	})
	if err := rg.r.ArchiveRun(ctx, runA, "a_again"); err != nil {
		t.Errorf("an archive without an answer: %v", err)
	}
	if d := rg.runFile(runA); d.Archived || d.Pending != pendingArchive || d.Op != "a_again" {
		t.Errorf("the record after the call without an answer: %+v", d)
	}
	if got := rg.r.RunsArchivedWith("a_again"); !reflect.DeepEqual(got, []string{runA}) {
		t.Errorf("RunsArchivedWith of a pending archive: %v", got)
	}
	rg.until("the archive is passed on again", func() bool {
		d := rg.runFile(runA)
		return d.Archived && d.Pending == "" && d.Op == "a_again"
	})
	if n := archive.count(); n != 2 {
		t.Errorf("%d archive calls, want 2", n)
	}
	if n := rg.local.upCount(); n != 1 {
		t.Errorf("the entry connected %d times: the second call was a reconnect's", n)
	}
	// A server that never answers gets three calls, and no more.
	_, free := unarchive.hang()
	defer free()
	if err := rg.r.UnarchiveRun(ctx, runA); err != nil {
		t.Errorf("an unarchive without an answer: %v", err)
	}
	rg.until("the unarchive is sent three times", func() bool { return unarchive.count() == archiveTries })
	time.Sleep(4 * 150 * time.Millisecond)
	if n := unarchive.count(); n != archiveTries {
		t.Errorf("%d unarchive calls, want %d", n, archiveTries)
	}
	if d := rg.runFile(runA); !d.Archived || d.Pending != pendingUnarchive {
		t.Errorf("the record after three calls without an answer: %+v", d)
	}
}

// TestRunArchivePending: an archive made while the server is away stays pending, wins over the
// snapshot of the return and is then passed on.
func TestRunArchivePending(t *testing.T) {
	rg := seededRuns(t, rigOpt{}, runA, runB)
	archive, unarchive := runArchiveRoutes(rg)
	ctx := context.Background()
	p, _ := rg.page("page-1")

	// runB is archived and confirmed; its unarchive will be the pending change.
	if err := rg.r.ArchiveRun(ctx, runB, "a_b"); err != nil {
		t.Fatal(err)
	}
	p.Expect("run")
	p.Expect("run")

	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	if err := rg.r.ArchiveRun(ctx, runA, "a_down"); err != nil {
		t.Errorf("an archive while the server is away: %v", err)
	}
	if err := rg.r.UnarchiveRun(ctx, runB); err != nil {
		t.Errorf("an unarchive while the server is away: %v", err)
	}
	if ev := p.Expect("run"); field(ev, "run", "id") != runA || field(ev, "run", "archived") != true || field(ev, "run", "archiveOp") != "a_down" {
		t.Errorf("the mark does not show at once: %v", ev)
	}
	if ev := p.Expect("run"); field(ev, "run", "id") != runB || field(ev, "run", "archived") != nil {
		t.Errorf("the unarchive does not show at once: %v", ev)
	}
	if a, b := rg.runFile(runA), rg.runFile(runB); a.Pending != pendingArchive || a.Archived || a.Op != "a_down" ||
		b.Pending != pendingUnarchive || !b.Archived || b.Op != "" {
		t.Errorf("the records while the server is away: %+v\n%+v", a, b)
	}
	before := archive.count() + unarchive.count()

	// The return: the snapshot tells the marks as that server has them, the reverse of what is
	// pending. The pending changes win, and are passed on.
	a, b := remoteRun(runA, model.RunStopped), remoteRun(runB, model.RunStopped)
	b.Archived, b.Op = true, "a_there"
	rg.s.SetSnapshot(snapshotWithRuns(a, b))
	rg.s.Restart()
	rg.returned(2)
	var evs []map[string]any
	for range 4 {
		evs = append(evs, p.Next())
	}
	if got, want := types(evs), []string{"server_lists", "server_back", "run", "run"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the events of the return: %v", got)
	}
	if field(evs[2], "run", "archived") != true || field(evs[2], "run", "archiveOp") != "a_down" || field(evs[3], "run", "archived") != nil {
		t.Errorf("the snapshot's marks won over the pending changes: %v\n%v", evs[2], evs[3])
	}
	rg.until("the pending changes are passed on", func() bool { return archive.count()+unarchive.count() == before+2 })
	if q := archive.last(t); q.URI != "/api/runs/"+runA+"/archive" {
		t.Errorf("the archive that was passed on: %+v", q)
	}
	if q := unarchive.last(t); q.URI != "/api/runs/"+runB+"/unarchive" {
		t.Errorf("the unarchive that was passed on: %+v", q)
	}
	rg.until("the changes are confirmed", func() bool {
		a, b := rg.runFile(runA), rg.runFile(runB)
		return a.Pending == "" && a.Archived && a.Op == "a_down" && b.Pending == "" && !b.Archived
	})

	// Another return: nothing is pending, so nothing is passed on.
	a.Archived = true
	rg.s.SetSnapshot(snapshotWithRuns(a, remoteRun(runB, model.RunStopped)))
	rg.s.DropStreams()
	rg.returned(3)
	time.Sleep(quiet)
	if got := archive.count() + unarchive.count(); got != before+2 {
		t.Errorf("a return with nothing pending passed %d changes on", got-before-2)
	}
	if d := rg.runFile(runA); !d.Archived || d.Op != "a_down" {
		t.Errorf("the record after the second return: %+v", d)
	}
}

// TestRunArchivedThere: a mark made on the run's own server is taken, belongs to no archive
// action here, and is kept at a reconnect, where nothing is sent for it.
func TestRunArchivedThere(t *testing.T) {
	rg := seededRuns(t, rigOpt{}, runA)
	archive, unarchive := runArchiveRoutes(rg)
	p, _ := rg.page("page-1")

	there := remoteRun(runA, model.RunStopped)
	there.Archived, there.Op = true, "a_there"
	rg.s.Send(map[string]any{"type": "run", "run": there})
	if ev := p.Expect("run"); field(ev, "run", "archived") != true || field(ev, "run", "archiveOp") != nil {
		t.Errorf("the pages were told %v", ev)
	}
	rg.until("the mark is written", func() bool { return rg.runFile(runA).Archived })
	if d := rg.runFile(runA); d.Op != "" || d.Pending != "" {
		t.Errorf("the record: %+v", d)
	}
	if got := rg.r.RunsArchivedWith("a_there"); len(got) != 0 {
		t.Errorf("the server's own action counts as one of this server's: %v", got)
	}
	rg.s.SetSnapshot(snapshotWithRuns(there))
	rg.s.DropStreams()
	rg.returned(2)
	var evs []map[string]any
	for range 3 {
		evs = append(evs, p.Next())
	}
	if field(evs[2], "run", "archived") != true || field(evs[2], "run", "archiveOp") != nil {
		t.Errorf("after the reconnect: %v", evs[2])
	}
	time.Sleep(quiet)
	if d := rg.runFile(runA); !d.Archived || d.Op != "" || d.Pending != "" || archive.count()+unarchive.count() != 0 {
		t.Errorf("the record after the reconnect: %+v, %d changes sent", d, archive.count()+unarchive.count())
	}
}

// TestRunDelete: the delete of a record's run, with the chats on it.
func TestRunDelete(t *testing.T) {
	ids := []string{runN(1), runN(2), runN(3), runN(4), runN(5)}
	on1a, on1b, on3, free := seedOf(chatN(1)), seedOf(chatN(2)), seedOf(chatN(3)), seedOf(chatN(4))
	on1a.Run, on1a.Group, on1b.Run, on1b.Group, on3.Run, on3.Group = ids[0], "", ids[0], "", ids[2], ""
	snap := snapshotWith(on1a.View, on1b.View, on3.View, free.View)
	o := rigOpt{limits: Limits{Call: 100 * time.Millisecond, RunDelete: time.Second}, seed: []Record{on1a, on1b, on3, free}}
	var views []model.RunView
	for _, id := range ids {
		d := runSeedOf(id)
		o.runSeed, views = append(o.runSeed, d), append(views, d.View)
	}
	snap["runs"] = views
	o.snapshot = snap
	rg := newRig(t, o)
	ctx := context.Background()
	p, _ := rg.page("page-1")
	del := rg.script("DELETE /api/runs/{id}")
	chatDel := rg.script("DELETE /api/chats/{id}")
	gone := func(id string) bool {
		_, err := os.Stat(rg.r.runFiles.path(id))
		return os.IsNotExist(err) && !rg.r.HasRun(id)
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

	// 200 there, after longer than Limits.Call (the call waits Limits.RunDelete): the records of
	// the chats on the run go first, then the unstarted chats on it, then the run's record.
	del.set(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		writeAnswer(w, http.StatusOK, map[string]bool{"ok": true})
	})
	if err := rg.r.DeleteRun(ctx, ids[0], false); err != nil || !gone(ids[0]) {
		t.Fatalf("a delete: %v, gone %v", err, gone(ids[0]))
	}
	if q := del.last(t); q.Method != http.MethodDelete || q.URI != "/api/runs/"+ids[0] {
		t.Errorf("the server got %+v", q)
	}
	var evs []map[string]any
	for range 3 {
		evs = append(evs, p.Next())
	}
	if got := types(evs); !reflect.DeepEqual(got, []string{"chat_removed", "chat_removed", "run_removed"}) ||
		evs[0]["id"] != on1a.ID || evs[1]["id"] != on1b.ID || evs[2]["id"] != ids[0] {
		t.Errorf("the pages were told %v", evs)
	}
	if rg.r.Has(on1a.ID) || rg.r.Has(on1b.ID) || !rg.r.Has(on3.ID) || !rg.r.Has(free.ID) {
		t.Error("the chat records after the delete of their run")
	}
	rg.local.mu.Lock()
	if !reflect.DeepEqual(rg.local.onRuns, []string{ids[0]}) {
		t.Errorf("DeleteOnRun was called for %v", rg.local.onRuns)
	}
	rg.local.mu.Unlock()
	if chatDel.count() != 0 {
		t.Errorf("%d deletes of chats were sent: the run's server deletes them", chatDel.count())
	}
	// 404 there: the same.
	del.answer(http.StatusNotFound, map[string]string{"error": "no such run"})
	if err := rg.r.DeleteRun(ctx, ids[1], false); err != nil || !gone(ids[1]) {
		t.Errorf("a delete of a run that is not there: %v, gone %v", err, gone(ids[1]))
	}
	p.Expect("run_removed")

	// "Remove from this sidebar only" is refused while the server is connected and has the run.
	sent := del.count()
	err := rg.r.DeleteRun(ctx, ids[2], true)
	check("local only while connected", err, http.StatusConflict, "server_connected")
	if !errors.Is(err, ErrConnected) || err.Error() != "Studio is connected: delete the run there." || gone(ids[2]) || del.count() != sent {
		t.Errorf("local only while connected: %v, gone %v", err, gone(ids[2]))
	}
	// Another answer: the server's status and sentence, and the record stays.
	del.answer(http.StatusInternalServerError, map[string]string{"error": "boom"})
	err = rg.r.DeleteRun(ctx, ids[2], false)
	check("a delete the server fails", err, http.StatusInternalServerError, "")
	if err.Error() != "boom" || gone(ids[2]) || !rg.r.Has(on3.ID) {
		t.Errorf("a delete the server fails: %v, gone %v", err, gone(ids[2]))
	}
	// No answer: 504, and the record stays.
	_, release := del.hang()
	defer release()
	err = rg.r.DeleteRun(ctx, ids[2], false)
	check("a delete without an answer", err, http.StatusGatewayTimeout, "no_answer")
	if !errors.Is(err, ErrNoAnswer) || gone(ids[2]) || !rg.r.Has(on3.ID) {
		t.Errorf("a delete without an answer: %v, gone %v", err, gone(ids[2]))
	}
	p.ExpectNone(quiet)

	// A record that is gone there is removed with no call, local only or not.
	rg.s.Send(map[string]any{"type": "run_removed", "id": ids[3]})
	rg.s.Send(map[string]any{"type": "run_removed", "id": ids[4]})
	p.Expect("run")
	p.Expect("run")
	sent = del.count()
	if err := rg.r.DeleteRun(ctx, ids[3], true); err != nil || !gone(ids[3]) {
		t.Errorf("local only for a gone record: %v", err)
	}
	if err := rg.r.DeleteRun(ctx, ids[4], false); err != nil || !gone(ids[4]) || del.count() != sent {
		t.Errorf("a delete of a gone record: %v, %d sent", err, del.count()-sent)
	}
	p.Expect("run_removed")
	p.Expect("run_removed")

	// Not connected: 503 and the record stays; local only is accepted, the chat records on the
	// run go too, and nothing is sent.
	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	err = rg.r.DeleteRun(ctx, ids[2], false)
	check("a delete while not connected", err, http.StatusServiceUnavailable, "server_unreachable")
	if !errors.Is(err, ErrUnreachable) || err.Error() != "Studio is not connected." || gone(ids[2]) {
		t.Errorf("a delete while not connected: %v, gone %v", err, gone(ids[2]))
	}
	if err := rg.r.DeleteRun(ctx, ids[2], true); err != nil || !gone(ids[2]) || rg.r.Has(on3.ID) || !rg.r.Has(free.ID) {
		t.Errorf("local only while not connected: %v, gone %v", err, gone(ids[2]))
	}
	if ev := p.Expect("chat_removed"); ev["id"] != on3.ID {
		t.Errorf("the pages were told %v", ev)
	}
	if ev := p.Expect("run_removed"); ev["id"] != ids[2] {
		t.Errorf("the pages were told %v", ev)
	}
	err = rg.r.DeleteRun(ctx, ids[2], false)
	if !errors.Is(err, runs.ErrNotFound) || ReplyOf(err).Status != http.StatusNotFound {
		t.Errorf("a delete without a record: %v", err)
	}
	if _, n := rg.r.Counts(rg.entry); n != 0 {
		t.Errorf("%d run records are left", n)
	}
	noSecret(t, "the log", strings.Join(rg.logs.all(), "\n"))
}

// TestRunDeletableAndMove: the check before a group is deleted with its contents, with run
// records, and the move of a run record.
func TestRunDeletableAndMove(t *testing.T) {
	inside, unnamed, outside, goneRec := runSeedOf(runN(1)), runSeedOf(runN(2)), runSeedOf(runN(3)), runSeedOf(runN(4))
	inside.Group, inside.View.Name = "g_sub", "Paint the “fence”"
	unnamed.Group, unnamed.View.Name = "g_top", ""
	outside.Group = "g_else"
	goneRec.Group, goneRec.Gone = "g_top", true
	rg := newRig(t, rigOpt{
		snapshot: snapshotWithRuns(inside.View, unnamed.View, outside.View),
		runSeed:  []RunRecord{inside, unnamed, outside, goneRec},
	})
	p, _ := rg.page("page-1")
	tree := map[string]bool{"g_top": true, "g_sub": true}

	if err := rg.r.Deletable(tree); err != nil {
		t.Errorf("with the server connected: %v", err)
	}
	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	err := rg.r.Deletable(tree)
	var e *Error
	if !errors.As(err, &e) || e.Status != http.StatusConflict || e.Code != "server_unreachable" || !errors.Is(err, ErrUnreachable) ||
		e.Text != "Nothing was deleted: “Paint the “fence”” is on Studio, which is not connected." {
		t.Errorf("with the server away: %v", err)
	}
	if err := rg.r.Deletable(map[string]bool{"g_top": true}); err == nil ||
		err.Error() != "Nothing was deleted: “New run” is on Studio, which is not connected." {
		t.Errorf("an unnamed run: %v", err)
	}
	// Records outside the groups, and gone ones, do not stand in the way.
	if err := rg.r.Deletable(map[string]bool{"g_other": true}); err != nil {
		t.Errorf("groups without a record: %v", err)
	}
	if err := rg.r.DeleteRun(context.Background(), unnamed.ID, true); err != nil {
		t.Fatal(err)
	}
	p.Expect("run_removed")
	if err := rg.r.Deletable(map[string]bool{"g_top": true}); err != nil {
		t.Errorf("a group with a gone record alone: %v", err)
	}
	// MoveRun: the records of a group that is deleted without its contents go to its parent.
	if err := rg.r.MoveRun(inside.ID, "g_top"); err != nil || rg.runFile(inside.ID).Group != "g_top" {
		t.Errorf("MoveRun: %v", err)
	}
	if ev := p.Expect("run"); field(ev, "run", "id") != inside.ID || field(ev, "run", "group") != "g_top" {
		t.Errorf("the pages were told %v", ev)
	}
	if err := rg.r.MoveRun(inside.ID, "g_top"); err != nil {
		t.Errorf("a move to the same group: %v", err)
	}
	p.ExpectNone(quiet)
	if err := rg.r.MoveRun(runA, "g_top"); !errors.Is(err, runs.ErrNotFound) || ReplyOf(err).Status != http.StatusNotFound {
		t.Errorf("MoveRun without a record: %v", err)
	}
}
