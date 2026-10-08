package remotes

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/store"
)

// names are the names of what is in dir.
func names(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

func mode(t *testing.T, path string) fs.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

// TestFiles: where a record's file is and what it may be read by, and when it is written: at
// once for what must not be lost, at the next flush and at Close for a view.
func TestFiles(t *testing.T) {
	t.Parallel()
	seed := seedOf(chatA)
	rg := newRig(t, rigOpt{
		snapshot: snapshotWith(seed.View), seed: []Record{seed},
		limits: Limits{Flush: time.Hour}, // no flush but Close's
	})
	p, _ := rg.page("page-1")
	rec := rg.r.rec(chatA)
	dirty := func() bool {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		return rec.dirty
	}

	path := store.NewPaths(rg.root).RemoteChatFile(chatA)
	if rg.r.files.path(chatA) != path || path != filepath.Join(rg.root, "remote", "chats", chatA+".json") {
		t.Errorf("the file is %s", rg.r.files.path(chatA))
	}
	if got := mode(t, path); got != 0o600 {
		t.Errorf("the file's mode is %o", got)
	}
	for _, dir := range []string{filepath.Dir(path), filepath.Join(rg.root, "remote")} {
		if got := mode(t, dir); got != 0o700 {
			t.Errorf("the mode of %s is %o", dir, got)
		}
	}
	if got := names(t, filepath.Dir(path)); !reflect.DeepEqual(got, []string{chatA + ".json"}) {
		t.Errorf("the folder holds %v", got)
	}
	if d := rg.file(chatA); d.ID != chatA || d.Entry != rg.entry || d.Group != "g_here" || d.View.Status != model.StatusReady || len(d.States) != 1 {
		t.Errorf("the file after the adoption: %+v", d)
	}

	// A view alone waits for the flush.
	rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(chatA, model.StatusThinking)})
	rg.s.Send(map[string]any{"type": "branch_state", "state": model.BranchState{Chat: chatA, Branch: "b1", Status: model.StatusTool}})
	rg.barrier(p)
	if d := rg.file(chatA); d.View.Status != model.StatusReady || len(d.States) != 1 || !dirty() {
		t.Errorf("a view was written before the flush: %+v, dirty %v", d.View.Status, dirty())
	}
	// The mark is written at once, with the view of that moment.
	archived := remoteView(chatA, model.StatusWriting)
	archived.Archived = true
	rg.s.Send(map[string]any{"type": "chat", "chat": archived})
	rg.barrier(p)
	if d := rg.file(chatA); !d.Archived || d.View.Status != model.StatusWriting || len(d.States) != 2 || dirty() {
		t.Errorf("the mark is not written at once: %+v, dirty %v", d, dirty())
	}
	if got := mode(t, path); got != 0o600 {
		t.Errorf("the file's mode after a second write is %o", got)
	}
	// Close writes what waits.
	archived.Status = model.StatusStopped
	rg.s.Send(map[string]any{"type": "chat", "chat": archived})
	rg.barrier(p)
	if d := rg.file(chatA); d.View.Status != model.StatusWriting || !dirty() {
		t.Errorf("before Close: %+v, dirty %v", d, dirty())
	}
	rg.m.Close()
	rg.r.Close()
	if d := rg.file(chatA); d.View.Status != model.StatusStopped || !d.Archived || dirty() {
		t.Errorf("after Close: %+v, dirty %v", d, dirty())
	}
	if got := names(t, filepath.Dir(path)); !reflect.DeepEqual(got, []string{chatA + ".json"}) {
		t.Errorf("the folder holds %v", got)
	}
	// Neither a token nor the secret is in the file.
	b, _ := os.ReadFile(path)
	if s := strings.ToLower(string(b)); strings.Contains(s, "token") || strings.Contains(s, "secret") {
		t.Errorf("the file: %s", b)
	}
}

// TestFlush: a view that changed is in the file within the flush's time, with no other change.
func TestFlush(t *testing.T) {
	t.Parallel()
	seed := seedOf(chatA)
	rg := newRig(t, rigOpt{snapshot: snapshotWith(seed.View), seed: []Record{seed}, limits: Limits{Flush: 20 * time.Millisecond}})
	rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(chatA, model.StatusApproval)})
	rg.s.Send(map[string]any{"type": "branch_state", "state": model.BranchState{Chat: chatA, Branch: mainBranch, Status: model.StatusApproval}})
	rg.until("the view is in the file", func() bool {
		d := rg.file(chatA) // read while it is written: the file is always a whole record
		return d.View.Status == model.StatusApproval && d.States[0].Status == model.StatusApproval
	})
}

// TestWriteThatFails: a write that fails is logged once and tried again at every flush; the
// pages and the snapshot have the change meanwhile.
func TestWriteThatFails(t *testing.T) {
	t.Parallel()
	seed := seedOf(chatA)
	var fail atomic.Bool
	rg := newRig(t, rigOpt{snapshot: snapshotWith(seed.View), seed: []Record{seed}, wire: func(rg *rig) {
		write := rg.r.files.write
		rg.r.files.write = func(path string, b []byte) error {
			if fail.Load() {
				return errors.New("the disk is full")
			}
			return write(path, b)
		}
	}})
	p, _ := rg.page("page-1")
	fail.Store(true)
	archived := remoteView(chatA, model.StatusReady)
	archived.Archived = true
	rg.s.Send(map[string]any{"type": "chat", "chat": archived})
	if ev := p.Expect("chat"); field(ev, "chat", "archived") != true {
		t.Errorf("the page's event: %v", ev)
	}
	time.Sleep(quiet) // several flushes
	if rg.file(chatA).Archived || !rg.r.Views()[0].Archived {
		t.Error("the file has the change, or the snapshot does not")
	}
	if n := rg.logs.count("is not written"); n != 1 {
		t.Errorf("%d log lines for the failing write: %v", n, rg.logs.all())
	}
	fail.Store(false)
	rg.until("the write is made again", func() bool { return rg.file(chatA).Archived })
}

// TestRecordTooLarge: a record above the size a load reads is never written: the file that is
// there stays, the pages have the change, and the failure is logged once.
func TestRecordTooLarge(t *testing.T) {
	t.Parallel()
	f := newFiles(t.TempDir())
	small := seedWith(chatB, "s_entry")
	if err := f.save(small); err != nil {
		t.Fatal(err)
	}
	large := small
	large.View.Name = strings.Repeat("x", maxRecord)
	if err := f.save(large); !errors.Is(err, errTooLarge) {
		t.Errorf("the save of a record that is too large: %v", err)
	}
	if got, err := f.read(chatB); err != nil || got.View.Name != small.View.Name {
		t.Errorf("the file after it: %q, %v", got.View.Name, err)
	}
	if got := names(t, f.dir); !reflect.DeepEqual(got, []string{chatB + ".json"}) {
		t.Errorf("the folder holds %v", got)
	}

	seed := seedOf(chatA)
	var writes atomic.Int32 // of a file above half the limit
	rg := newRig(t, rigOpt{snapshot: snapshotWith(seed.View), seed: []Record{seed}, wire: func(rg *rig) {
		write := rg.r.files.write
		rg.r.files.write = func(path string, b []byte) error {
			if len(b) > maxRecord/2 {
				writes.Add(1)
			}
			return write(path, b)
		}
	}})
	huge := remoteView(chatA, model.StatusReady)
	huge.Name, huge.Archived = strings.Repeat("y", maxRecord), true // the mark: written at once
	raw, _ := json.Marshal(map[string]any{"type": "chat", "chat": huge})
	rg.r.event(rg.entry, "chat", raw)
	time.Sleep(quiet) // several flushes
	if n := writes.Load(); n != 0 {
		t.Errorf("%d writes of a record that is too large", n)
	}
	if d := rg.file(chatA); d.Archived || d.View.Name != seed.View.Name {
		t.Errorf("the file holds the change: archived %v, a name of %d bytes", d.Archived, len(d.View.Name))
	}
	if v := rg.r.Views()[0]; !v.Archived || len(v.Name) != maxRecord {
		t.Error("the pages do not have the change")
	}
	if n := rg.logs.count("is not written"); n != 1 {
		t.Errorf("%d log lines for the record that is too large: %v", n, rg.logs.all())
	}
	rec := rg.r.rec(chatA)
	rec.mu.Lock()
	again := rec.dirty
	rec.mu.Unlock()
	if again {
		t.Error("a record that is too large is put together again at every flush")
	}
	// The next view that fits is written.
	rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(chatA, model.StatusApproval)})
	rg.until("the record is written again", func() bool { return rg.file(chatA).View.Status == model.StatusApproval })
}

// TestLoad: Open reads the folder. A file that is no record is skipped and logged, and stays; a
// record whose entry is not in the list is removed.
func TestLoad(t *testing.T) {
	t.Parallel()
	a := seedOf(chatA)
	a.Archived, a.Op, a.Pending = true, "a_here", pendingUnarchive
	a.Drafts, a.DraftRevs = map[string]*model.Draft{mainBranch: {Text: "for main"}}, map[string]int64{mainBranch: 4, "b1": 2}
	a.View.Archived = true
	rg := newRig(t, rigOpt{snapshot: snapshotWith(a.View), seed: []Record{a}, wire: func(rg *rig) {
		// The pending change is passed on at the connect: the server cannot take it now, so it stays.
		rg.s.Handle("POST /api/chats/{id}/unarchive", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusServiceUnavailable)
		})
	}})
	rg.s.Send(map[string]any{"type": "branch_state", "state": model.BranchState{Chat: chatA, Branch: "b1", Status: model.StatusTool}})
	rg.until("the branch's state is taken", func() bool { return len(rg.r.States()) == 2 })
	views, states := rg.r.Views(), rg.r.States()
	rg.m.Close()
	rg.r.Close()

	dir := rg.r.files.dir
	put := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	record := func(d Record) string {
		b, _ := json.Marshal(d)
		return string(b)
	}
	put("broken.json", `{"id":"broken","entry":`)
	put(chatB+".json", record(seedWith("another-id", rg.entry)))
	put("no-entry.json", record(seedWith("no-entry", "")))
	put("bad name.json", record(seedWith("bad name", rg.entry)))
	put("left.json", record(seedWith("left", "s_000000000000")))
	put("local.json", record(seedWith("local", servers.LocalID)))
	put(".cut.json.tmp", `{"id":"cu`)
	put("notes.txt", "not a record")
	if err := os.Mkdir(filepath.Join(dir, "folder.json"), 0o700); err != nil {
		t.Fatal(err)
	}

	// The list is read again, as at a start: the entry is in it.
	m, err := servers.Open(servers.Options{Root: rg.root, LocalID: testLocalID, Timing: fastTiming()})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	var log logs
	r, err := Open(Options{Root: rg.root, Servers: m, Bridge: rg.b, Logf: log.printf})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if got := r.Views(); !reflect.DeepEqual(got, views) {
		t.Errorf("the views after a load:\n%+v\nwant\n%+v", got, views)
	}
	if got := r.States(); !reflect.DeepEqual(got, states) {
		t.Errorf("the states after a load:\n%+v\nwant\n%+v", got, states)
	}
	if v := r.Views()[0]; v.Archived || v.Op != "a_here" || v.Draft == nil || v.DraftRev != 4 || v.Server != rg.entry {
		t.Errorf("the loaded record's view: %+v", v)
	}
	if chats, _ := r.Counts(rg.entry); chats != 1 || !r.Has(chatA) || r.Has("left") || r.Has("another-id") || r.Has(chatB) || r.Has("local") {
		t.Errorf("the records after a load: %d", chats)
	}
	want := []string{"bad name.json", "broken.json", "folder.json", "no-entry.json", "notes.txt", chatA + ".json", chatB + ".json"}
	if got := names(t, dir); !sameSet(got, want) {
		t.Errorf("the folder after a load: %v, want %v", got, want)
	}
	for _, name := range []string{"broken.json", chatB + ".json", "no-entry.json", "bad name.json"} {
		if log.count(name+" is skipped") != 1 {
			t.Errorf("no log line for %s: %v", name, log.all())
		}
	}
	for _, id := range []string{"left", "local"} {
		if log.count("the chat "+id+" is removed") != 1 {
			t.Errorf("no log line for the record %s: %v", id, log.all())
		}
	}
	if len(log.all()) != 6 {
		t.Errorf("the log: %v", log.all())
	}
	// A folder that is not there is no records and no error.
	empty, err := Open(Options{Root: t.TempDir(), Servers: m, Bridge: rg.b, Logf: log.printf})
	if err != nil || len(empty.Views()) != 0 || empty.Views() == nil || empty.States() == nil || len(log.all()) != 6 {
		t.Errorf("Open on an empty root: %v, %v", err, log.all())
	}
	empty.Close()
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	in := map[string]bool{}
	for _, s := range a {
		in[s] = true
	}
	for _, s := range b {
		if !in[s] {
			return false
		}
	}
	return true
}

// TestAtomicWrite: a file is replaced whole. A reader never finds a part of a record, and no
// temporary file is left.
func TestAtomicWrite(t *testing.T) {
	t.Parallel()
	f := newFiles(t.TempDir())
	small, large := seedOf(chatA), seedOf(chatA)
	small.Entry, large.Entry = "s_entry", "s_entry"
	large.View.Name = strings.Repeat("a long name ", 20000)
	if err := f.save(small); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := range 200 {
			d := small
			if i%2 == 0 {
				d = large
			}
			if err := f.save(d); err != nil {
				t.Error(err)
				return
			}
		}
	}()
	for reads := 0; ; reads++ {
		d, err := f.read(chatA)
		if err != nil {
			t.Fatalf("read %d found no whole record: %v", reads, err)
		}
		if n := len(d.View.Name); n != len(small.View.Name) && n != len(large.View.Name) {
			t.Fatalf("read %d found a name of %d bytes", reads, n)
		}
		select {
		case <-done:
			if got := names(t, f.dir); !reflect.DeepEqual(got, []string{chatA + ".json"}) {
				t.Errorf("the folder holds %v", got)
			}
			if err := f.remove(chatA); err != nil || len(names(t, f.dir)) != 0 {
				t.Errorf("remove: %v", err)
			}
			if err := f.remove(chatA); err != nil {
				t.Errorf("remove of a file that is not there: %v", err)
			}
			return
		default:
		}
	}
}

// TestAdopt: what makes a record, and what is refused with nothing written.
func TestAdopt(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{})
	for name, d := range map[string]Record{
		"an id that is a path": seedWith("../"+chatA, rg.entry),
		"no id":                seedWith(chatA, rg.entry),
		"no entry":             seedWith(chatA, ""),
		"the local entry":      seedWith(chatA, servers.LocalID),
		"an entry of no list":  seedWith(chatA, "s_000000000000"),
	} {
		if name == "no id" {
			d.ID = ""
		}
		if rec, err := rg.r.adopt(d); err == nil || rec != nil {
			t.Errorf("%s: adopted", name)
		}
	}
	if _, err := os.Stat(rg.r.files.dir); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("the folder was made for nothing: %v", err)
	}
	if rg.r.Has(chatA) || len(rg.r.Views()) != 0 {
		t.Error("a refused record is listed")
	}

	d := seedWith(chatA, rg.entry)
	d.States = nil
	rec, err := rg.r.adopt(d)
	if err != nil || rec == nil || rec.id != chatA || rec.entry != rg.entry {
		t.Fatalf("adopt: %+v, %v", rec, err)
	}
	if !rg.r.Has(chatA) || rg.r.rec(chatA) != rec || rg.r.of(rg.entry, chatA) != rec || rg.r.of("s_other", chatA) != nil {
		t.Error("the adopted record is not found")
	}
	if b, _ := os.ReadFile(rg.r.files.path(chatA)); !strings.Contains(string(b), `"states": []`) {
		t.Errorf("the file of the adopted record: %s", b)
	}
	if v := rg.r.Views(); len(v) != 1 || v[0].Server != rg.entry {
		t.Errorf("Views after the adoption: %+v", v)
	}
	if _, err := rg.r.adopt(seedWith(chatA, rg.entry)); !errors.Is(err, errTaken) {
		t.Errorf("a second record of one id: %v", err)
	}

	// drop: the record and its file are gone, and the id is free again.
	rec.mu.Lock()
	rg.r.drop(rec)
	rg.r.drop(rec)
	rg.r.keep(rec, true) // a late change of a dropped record writes nothing
	rec.mu.Unlock()
	if rg.r.Has(chatA) || len(names(t, rg.r.files.dir)) != 0 {
		t.Error("the dropped record is left")
	}
	if _, err := rg.r.adopt(seedWith(chatA, rg.entry)); err != nil {
		t.Errorf("a record of a freed id: %v", err)
	}
}
