package remotes

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
	"ai-whiteboard/internal/store"
)

// TestRunFiles: where a run record's file is, its mode, and when it is written: at once for the
// adoption, the mark and the gone mark; a view or an agent alone waits for the flush, and Close
// writes what waits.
func TestRunFiles(t *testing.T) {
	t.Parallel()
	seed := runSeedOf(runA)
	rg := newRig(t, rigOpt{
		snapshot: snapshotWithRuns(seed.View), runSeed: []RunRecord{seed},
		limits: Limits{Flush: time.Hour}, // no flush but Close's
	})
	p, _ := rg.page("page-1")
	rec := rg.r.runRec(runA)
	dirty := func() bool {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		return rec.dirty
	}

	path := store.NewPaths(rg.root).RemoteRunFile(runA)
	if rg.r.runFiles.path(runA) != path || path != filepath.Join(rg.root, "remote", "runs", runA+".json") {
		t.Errorf("the file is %s", rg.r.runFiles.path(runA))
	}
	if got := mode(t, path); got != 0o600 {
		t.Errorf("the file's mode is %o", got)
	}
	for _, dir := range []string{filepath.Dir(path), filepath.Join(rg.root, "remote")} {
		if got := mode(t, dir); got != 0o700 {
			t.Errorf("the mode of %s is %o", dir, got)
		}
	}
	if got := names(t, filepath.Dir(path)); !reflect.DeepEqual(got, []string{runA + ".json"}) {
		t.Errorf("the folder holds %v", got)
	}
	if d := rg.runFile(runA); d.ID != runA || d.Entry != rg.entry || d.Group != "g_here" || d.View.Status != model.RunRunning || d.View.Group != "g_there" {
		t.Errorf("the file after the adoption: %+v", d)
	}

	// A view alone and a learned agent wait for the flush.
	rg.s.Send(map[string]any{"type": "run", "run": remoteRun(runA, model.RunStopping)})
	rg.s.Send(map[string]any{"type": "run_activity", "run": runA, "agents": map[string]any{agent1: map[string]any{"tools": 1}}})
	rg.barrier(p)
	if d := rg.runFile(runA); d.View.Status != model.RunRunning || len(d.Agents) != 0 || !dirty() {
		t.Errorf("a view or an agent was written before the flush: %+v, dirty %v", d, dirty())
	}
	// The mark is written at once, with the view and the agents of that moment.
	archived := remoteRun(runA, model.RunStopped)
	archived.Archived = true
	rg.s.Send(map[string]any{"type": "run", "run": archived})
	rg.barrier(p)
	if d := rg.runFile(runA); !d.Archived || d.View.Status != model.RunStopped || !reflect.DeepEqual(d.Agents, []string{agent1}) || dirty() {
		t.Errorf("the mark is not written at once: %+v, dirty %v", d, dirty())
	}
	if got := mode(t, path); got != 0o600 {
		t.Errorf("the file's mode after a second write is %o", got)
	}
	// The gone mark too.
	rg.s.Send(map[string]any{"type": "run_removed", "id": runA})
	rg.barrier(p)
	if d := rg.runFile(runA); !d.Gone || dirty() {
		t.Errorf("the gone mark is not written at once: %+v", d)
	}
	// Close writes what waits.
	rg.s.Send(map[string]any{"type": "run_activity", "run": runA, "agents": map[string]any{agent2: map[string]any{"tools": 2}}})
	rg.barrier(p)
	if d := rg.runFile(runA); len(d.Agents) != 1 || !dirty() {
		t.Errorf("before Close: %+v, dirty %v", d, dirty())
	}
	rg.m.Close()
	rg.r.Close()
	if d := rg.runFile(runA); !reflect.DeepEqual(d.Agents, []string{agent1, agent2}) || !d.Archived || !d.Gone || dirty() {
		t.Errorf("after Close: %+v, dirty %v", d, dirty())
	}
	if got := names(t, filepath.Dir(path)); !reflect.DeepEqual(got, []string{runA + ".json"}) {
		t.Errorf("the folder holds %v", got)
	}
	// Neither a token nor the secret is in the file or in a log line.
	b, _ := os.ReadFile(path)
	for _, s := range []string{string(b), strings.Join(rg.logs.all(), "\n")} {
		if low := strings.ToLower(s); strings.Contains(low, "token") || strings.Contains(low, "secret") || strings.Contains(s, standin.DefaultSecret) {
			t.Errorf("a token or the secret is in: %s", s)
		}
	}
}

// TestRunFlush: a view that changed is in the file within the flush's time, with no other change.
func TestRunFlush(t *testing.T) {
	t.Parallel()
	seed := runSeedOf(runA)
	rg := newRig(t, rigOpt{snapshot: snapshotWithRuns(seed.View), runSeed: []RunRecord{seed}})
	rg.s.Send(map[string]any{"type": "run", "run": remoteRun(runA, model.RunStalled)})
	rg.until("the view is flushed", func() bool { return rg.runFile(runA).View.Status == model.RunStalled })
}

// TestRunWriteThatFails: a write that fails is logged once and made again at a flush; the pages
// have the change meanwhile.
func TestRunWriteThatFails(t *testing.T) {
	t.Parallel()
	seed := runSeedOf(runA)
	var fail atomic.Bool
	rg := newRig(t, rigOpt{snapshot: snapshotWithRuns(seed.View), runSeed: []RunRecord{seed}, wire: func(rg *rig) {
		write := rg.r.runFiles.write
		rg.r.runFiles.write = func(path string, b []byte) error {
			if fail.Load() {
				return errors.New("the disk is full")
			}
			return write(path, b)
		}
	}})
	p, _ := rg.page("page-1")
	fail.Store(true)
	archived := remoteRun(runA, model.RunStopped)
	archived.Archived = true
	rg.s.Send(map[string]any{"type": "run", "run": archived})
	if ev := p.Expect("run"); field(ev, "run", "archived") != true {
		t.Errorf("the page's event: %v", ev)
	}
	time.Sleep(quiet) // several flushes
	if rg.runFile(runA).Archived || !rg.r.RunViews()[0].Archived {
		t.Error("the file has the change, or the snapshot does not")
	}
	if n := rg.logs.count("is not written"); n != 1 {
		t.Errorf("%d log lines for the failing write: %v", n, rg.logs.all())
	}
	fail.Store(false)
	rg.until("the write is made again", func() bool { return rg.runFile(runA).Archived })

	// A record above the size a load reads is never written: the file that is there stays.
	f := newRunFiles(t.TempDir())
	small := runSeedOf(runB)
	small.Entry = "s_entry"
	if err := f.save(small); err != nil {
		t.Fatal(err)
	}
	large := small
	large.View.Name = strings.Repeat("x", maxRecord)
	if err := f.save(large); !errors.Is(err, errTooLarge) {
		t.Errorf("the save of a record that is too large: %v", err)
	}
	if got, err := f.read(runB); err != nil || got.View.Name != small.View.Name {
		t.Errorf("the file after it: %q, %v", got.View.Name, err)
	}
	// An id of another form is never a file's name.
	for _, id := range []string{"", chatA, "r_AAAA0001", "../r_aaaa0001", "r_aaaa00012"} {
		bad := small
		bad.ID = id
		if err := f.save(bad); err == nil {
			t.Errorf("the record %q was saved", id)
		}
		if err := f.remove(id); err != nil {
			t.Errorf("remove %q: %v", id, err)
		}
	}
	if got := names(t, f.dir); !reflect.DeepEqual(got, []string{runB + ".json"}) {
		t.Errorf("the folder holds %v", got)
	}
}

// TestRunLoad: Open reads the run records and builds the lookup of their agents' chats again. A
// bad file is skipped, logged and left; what a cut write left is removed; a record whose entry
// is not in the list is removed with its file.
func TestRunLoad(t *testing.T) {
	t.Parallel()
	a, b := runSeedOf(runA), runSeedOf(runB)
	a.Agents = []string{agent1, agent2}
	a.Archived, a.Op, a.View.Archived = true, "a_here", true // archived from here, and confirmed there
	rg := newRig(t, rigOpt{snapshot: snapshotWithRuns(a.View, b.View), runSeed: []RunRecord{a, b}})
	entry, dir := rg.entry, rg.r.runFiles.dir
	rg.m.Close()
	rg.r.Close()

	write := func(name string, v any) {
		t.Helper()
		raw, ok := v.(string)
		if !ok {
			b, err := json.Marshal(v)
			if err != nil {
				t.Fatal(err)
			}
			raw = string(b)
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	const (
		runBad    = "r_bad00001"
		runOther  = "r_cccc0003"
		runLeft   = "r_eeee0005"
		runMessy  = "r_ffff0006"
		runNoHost = "r_gggg0007"
	)
	write(runBad+".json", `{"id":`)
	write(runOther+".json", a)                                        // it holds another record
	write("not-a-run.json", RunRecord{ID: "not-a-run", Entry: entry}) // no run id
	write(chatA+".json", RunRecord{ID: chatA, Entry: entry})
	write(runNoHost+".json", RunRecord{ID: runNoHost})
	write(runLeft+".json", RunRecord{ID: runLeft, Entry: "s_left", Group: "g_here", View: remoteRun(runLeft, model.RunRunning)})
	write("r_dddd0004.json.tmp", `{"id":"r_dddd`)
	// Agents as no write of this server leaves them: not sorted, twice, of another form, and one
	// that is another run's.
	write(runMessy+".json", RunRecord{ID: runMessy, Entry: entry, Group: "g_here", View: remoteRun(runMessy, model.RunRunning),
		Agents: []string{"zz-agent", agent1, "../x", "aa-agent", "zz-agent"}})

	rg2 := newRig(t, rigOpt{root: rg.root, hold: true})
	if rg2.entry != entry {
		t.Fatalf("the entry is %s, was %s", rg2.entry, entry)
	}
	var ids []string
	for _, v := range rg2.r.RunViews() {
		ids = append(ids, v.ID)
	}
	if !reflect.DeepEqual(ids, []string{runA, runB, runMessy}) {
		t.Fatalf("the records after the load: %v", ids)
	}
	for _, id := range []string{runBad, runOther, runLeft, runNoHost, "not-a-run", chatA} {
		if rg2.r.HasRun(id) {
			t.Errorf("HasRun(%s)", id)
		}
	}
	if v := rg2.r.RunViews()[0]; !v.Archived || v.Op != "a_here" || v.Group != "g_here" || v.Server != entry || v.Status != model.RunRunning {
		t.Errorf("the first record after the load: %+v", v)
	}
	// The lookup: the agents of every record, each one of one run.
	for chat, want := range map[string]string{agent1: runA, agent2: runA, "zz-agent": runMessy, "aa-agent": runMessy} {
		if run, ok := rg2.r.AgentChat(chat); !ok || run != want {
			t.Errorf("AgentChat(%s): %q, %v, want %s", chat, run, ok, want)
		}
	}
	if _, ok := rg2.r.AgentChat("../x"); ok {
		t.Error("an id of another form is an agent chat")
	}
	if got := rg2.r.runRec(runMessy).agents(); !reflect.DeepEqual(got, []string{"aa-agent", "zz-agent"}) {
		t.Errorf("the agents of the record with a messy list: %v", got)
	}
	if chats, runs := rg2.r.Counts(entry); chats != 0 || runs != 3 {
		t.Errorf("Counts after the load: %d, %d", chats, runs)
	}

	// The folder: the bad files stay, the cut write and the record of the entry that left are gone.
	want := []string{chatA + ".json", "not-a-run.json", runA + ".json", runB + ".json", runBad + ".json", runOther + ".json", runMessy + ".json", runNoHost + ".json"}
	if got := names(t, dir); !sameSet(got, want) {
		t.Errorf("the folder holds %v, want %v", got, want)
	}
	for _, part := range []string{runBad + ".json is skipped", runOther + ".json is skipped", "not-a-run.json is skipped",
		chatA + ".json is skipped", runNoHost + ".json is skipped", "the run " + runLeft + " is removed"} {
		if rg2.logs.count(part) != 1 {
			t.Errorf("no log line, or more than one, with %q: %v", part, rg2.logs.all())
		}
	}

	// A relay of a server without runs reads none, and leaves the files.
	rg2.m.Close()
	rg2.r.Close()
	rg3 := newRig(t, rigOpt{root: rg.root, hold: true, noRuns: true})
	if rg3.r.HasRun(runA) || len(rg3.r.RunViews()) != 0 || rg3.r.RunViews() == nil {
		t.Error("a relay without a run service has run records")
	}
	if _, ok := rg3.r.AgentChat(agent1); ok {
		t.Error("a relay without a run service has agent chats")
	}
	if _, runs := rg3.r.Counts(entry); runs != 0 {
		t.Errorf("Counts without a run service: %d runs", runs)
	}
	if got := names(t, dir); !sameSet(got, want) {
		t.Errorf("the folder after it holds %v", got)
	}
}

// TestAdoptRun: a run record is made for an id of the form of a run id that has none, on an
// entry of the list: its file is written and HasRun knows it. Anything else is refused, and
// nothing is written.
func TestAdoptRun(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{})
	p, _ := rg.page("page-1")
	first := runSeedOf(runA)
	first.Entry, first.Agents = rg.entry, []string{agent2, agent1, agent1}
	rec, err := rg.r.adoptRun(first)
	if err != nil || rec == nil || !rg.r.HasRun(runA) {
		t.Fatalf("adoptRun: %v", err)
	}
	if d := rg.runFile(runA); d.ID != runA || d.Entry != rg.entry || !reflect.DeepEqual(d.Agents, []string{agent1, agent2}) {
		t.Errorf("the file of the adopted record: %+v", d)
	}
	if run, ok := rg.r.AgentChat(agent1); !ok || run != runA {
		t.Errorf("AgentChat after the adoption: %q, %v", run, ok)
	}
	if got := rg.r.RunViews(); len(got) != 1 || got[0].ID != runA || got[0].Group != "g_here" || got[0].Server != rg.entry {
		t.Errorf("RunViews after the adoption: %+v", got)
	}
	p.ExpectNone(quiet) // an adoption sends no event

	for _, c := range []struct {
		name string
		d    RunRecord
		want error
	}{
		{"an id that has a record", RunRecord{ID: runA, Entry: rg.entry}, errTaken},
		{"no id", RunRecord{Entry: rg.entry}, errBadRecord},
		{"a chat's id", RunRecord{ID: chatA, Entry: rg.entry}, errBadRecord},
		{"capital letters", RunRecord{ID: "r_AAAA0001", Entry: rg.entry}, errBadRecord},
		{"too short", RunRecord{ID: "r_aaaa001", Entry: rg.entry}, errBadRecord},
		{"too long", RunRecord{ID: "r_aaaa00012", Entry: rg.entry}, errBadRecord},
		{"a path", RunRecord{ID: "../r_aaaa0", Entry: rg.entry}, errBadRecord},
		{"no entry", RunRecord{ID: runB}, errBadRecord},
		{"the local entry", RunRecord{ID: runB, Entry: servers.LocalID}, errBadRecord},
		{"an entry that is not in the list", RunRecord{ID: runB, Entry: "s_none"}, errNoEntry},
	} {
		if rec, err := rg.r.adoptRun(c.d); !errors.Is(err, c.want) || rec != nil {
			t.Errorf("%s: %v, want %v", c.name, err, c.want)
		}
	}
	if rg.r.HasRun(runB) || rg.r.HasRun(chatA) || rg.r.HasRun("") {
		t.Error("a refused record is known")
	}
	if got := names(t, rg.r.runFiles.dir); !reflect.DeepEqual(got, []string{runA + ".json"}) {
		t.Errorf("the folder holds %v", got)
	}

	// An agent that is another run's stays that run's.
	second := runSeedOf(runB)
	second.Agents = []string{agent1, "another-agent"}
	rg.adoptRun(second)
	if run, _ := rg.r.AgentChat(agent1); run != runA {
		t.Errorf("the agent of the first run is now %s's", run)
	}
	if d := rg.runFile(runB); !reflect.DeepEqual(d.Agents, []string{"another-agent"}) {
		t.Errorf("the agents of the second record: %v", d.Agents)
	}

	// Dropped: the file, the id and the agents go, and the id can be adopted again.
	rec.mu.Lock()
	rg.r.dropRun(rec)
	rg.r.dropRun(rec)
	rec.mu.Unlock()
	if _, ok := rg.r.AgentChat(agent1); ok || rg.r.HasRun(runA) {
		t.Error("a dropped record is known, or its agent is")
	}
	if run, _ := rg.r.AgentChat("another-agent"); run != runB {
		t.Error("the drop took another record's agent")
	}
	if got := names(t, rg.r.runFiles.dir); !reflect.DeepEqual(got, []string{runB + ".json"}) {
		t.Errorf("the folder after the drop holds %v", got)
	}
	p.ExpectNone(quiet) // a drop sends no event
	first.Agents = nil
	rg.adoptRun(first)
	// A change of a dropped record is not written, and puts no file back.
	rec.mu.Lock()
	rec.d.Gone = true
	rg.r.keepRun(rec, true)
	rec.mu.Unlock()
	if rg.runFile(runA).Gone {
		t.Error("a dropped record was written over its successor")
	}

	// A server without runs keeps no record.
	none := newRig(t, rigOpt{noRuns: true, hold: true})
	if rec, err := none.r.adoptRun(RunRecord{ID: runA, Entry: none.entry}); !errors.Is(err, errNoRuns) || rec != nil || none.r.HasRun(runA) {
		t.Errorf("adoptRun without a run service: %v", err)
	}
	if _, err := os.Stat(none.r.runFiles.dir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the folder of a server without runs: %v", err)
	}
}
