package remotes

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

// TestRunViewOf: the view of a run record as a page gets it. The place, the entry and the mark
// are this server's; what belongs to a draft is cleared; the rest is what came.
func TestRunViewOf(t *testing.T) {
	t.Parallel()
	cost := 1.5
	there := remoteRun(runA, model.RunStalled)
	there.Archive = model.Archive{Archived: true, Op: "a_there"}
	there.Server, there.Start, there.Was, there.Dirty, there.Gone = "s_there", model.RemoteUnconfirmed, "r_was00000", true, true
	there.Draft, there.TierDefaults = &model.Draft{Text: "typed there"}, &model.RunTiers{}
	there.Counts, there.Attention, there.Cost, there.Turns = model.RunCounts{Done: 2, Failed: 1}, 3, &cost, 4
	there.Reason, there.StalledBy, there.Blocked, there.FolderMissing = "No progress.", model.StalledIdle, "blocked there", true
	rec := RunRecord{ID: runB, Entry: "s_entry", Group: "g_here", View: there}

	v := runViewOf(rec)
	if v.ID != runB || v.Group != "g_here" || v.Server != "s_entry" {
		t.Errorf("id, group, server: %q %q %q", v.ID, v.Group, v.Server)
	}
	if v.Gone || v.Archived || v.Op != "" {
		t.Errorf("gone %v, archived %v, op %q: they are the record's, never the view's", v.Gone, v.Archived, v.Op)
	}
	if v.Draft != nil || v.TierDefaults != nil || v.Start != "" || v.Was != "" || v.Dirty {
		t.Errorf("what belongs to a draft is not cleared: %+v", v)
	}
	if v.Status != model.RunStalled || v.Counts != there.Counts || v.Attention != 3 || v.Cost != &cost || v.Turns != 4 ||
		v.Reason != there.Reason || v.StalledBy != model.StalledIdle || v.Blocked != "blocked there" || !v.FolderMissing ||
		v.Name != there.Name || v.Cwd != there.Cwd || !v.Git || !v.Created.Equal(there.Created) || !v.Started.Equal(there.Started) {
		t.Errorf("the rest is not what came: %+v", v)
	}
	if rec.View.Group != "g_there" || rec.View.Draft == nil || rec.View.Op != "a_there" {
		t.Error("runViewOf changed the record's view")
	}

	// The mark: the record's, or the target of the change that is pending. The action is the
	// record's.
	for _, c := range []struct {
		archived bool
		pending  string
		want     bool
	}{
		{false, "", false}, {true, "", true},
		{false, pendingArchive, true}, {true, pendingArchive, true},
		{true, pendingUnarchive, false}, {false, pendingUnarchive, false},
	} {
		rec.Archived, rec.Pending, rec.Op = c.archived, c.pending, "a_here"
		if v := runViewOf(rec); v.Archived != c.want || v.Op != "a_here" {
			t.Errorf("archived %v, pending %q: the view has %v, %q", c.archived, c.pending, v.Archived, v.Op)
		}
	}
	rec.Gone = true
	if !runViewOf(rec).Gone {
		t.Error("a gone record's view is not gone")
	}

	// As JSON: none of the cleared keys, and no key of the other server's place.
	b, _ := json.Marshal(runViewOf(RunRecord{ID: runB, Entry: "s_entry", Group: model.Ungrouped, View: there}))
	var keys map[string]any
	_ = json.Unmarshal(b, &keys)
	for _, k := range []string{"archiveOp", "archived", "draft", "tierDefaults", "start", "was", "dirty", "gone"} {
		if _, has := keys[k]; has {
			t.Errorf("the view has %q: %s", k, b)
		}
	}
	if strings.Contains(string(b), "g_there") || strings.Contains(string(b), "s_there") || strings.Contains(string(b), "a_there") {
		t.Errorf("the other server's group, entry or action is in the view: %s", b)
	}
}

// TestRunApply: the rules of a view that came from the run's server are those of a chat record.
func TestRunApply(t *testing.T) {
	t.Parallel()
	view := func(archived bool) model.RunView {
		v := remoteRun(runA, model.RunStopped)
		v.Archived = archived
		return v
	}
	for _, c := range []struct {
		name             string
		rec              RunRecord
		archived, snap   bool
		wantArchived     bool
		wantOp, wantPend string
		durable          bool
	}{
		{"a view alone", RunRecord{}, false, false, false, "", "", false},
		{"a mark from there", RunRecord{}, true, false, true, "", "", true},
		{"the mark is taken off there", RunRecord{Archived: true, Op: "a_x"}, false, false, false, "", "", true},
		{"an event confirms the pending archive", RunRecord{Pending: pendingArchive, Op: "a_x"}, true, false, true, "a_x", "", true},
		{"an event before the archive arrived", RunRecord{Pending: pendingArchive, Op: "a_x"}, false, false, false, "a_x", pendingArchive, false},
		{"an event confirms the pending unarchive", RunRecord{Archived: true, Pending: pendingUnarchive, Op: "a_x"}, false, false, false, "", "", true},
		{"a pending archive wins at a snapshot", RunRecord{Pending: pendingArchive, Op: "a_x"}, false, true, false, "a_x", pendingArchive, false},
		{"a pending unarchive wins at a snapshot", RunRecord{Archived: true, Pending: pendingUnarchive, Op: "a_x"}, true, true, true, "a_x", pendingUnarchive, false},
		{"a snapshot's mark with nothing pending", RunRecord{}, true, true, true, "", "", true},
		{"a gone run is there again", RunRecord{Gone: true}, false, false, false, "", "", true},
		{"a gone run is in the snapshot again", RunRecord{Gone: true}, false, true, false, "", "", true},
	} {
		rec := c.rec
		rec.View = remoteRun(runA, model.RunRunning)
		durable := rec.apply(view(c.archived), c.snap)
		if rec.Archived != c.wantArchived || rec.Op != c.wantOp || rec.Pending != c.wantPend || rec.Gone || durable != c.durable {
			t.Errorf("%s: archived %v, op %q, pending %q, gone %v, durable %v", c.name, rec.Archived, rec.Op, rec.Pending, rec.Gone, durable)
		}
		if rec.View.Status != model.RunStopped {
			t.Errorf("%s: the view is not taken", c.name)
		}
	}
}

// TestRunRecordShape: the keys of a run record's file, and nothing that could hold a secret: no
// journal, no detail, no token.
func TestRunRecordShape(t *testing.T) {
	t.Parallel()
	rec := RunRecord{
		ID: runA, Entry: "s_entry", Group: "g", Archived: true, Op: "a_x", Pending: pendingArchive, Gone: true,
		View: remoteRun(runA, model.RunRunning), Agents: []string{agent1},
	}
	b, err := json.Marshal(rec)
	if err != nil {
		t.Fatal(err)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(b, &keys); err != nil {
		t.Fatal(err)
	}
	want := []string{"id", "entry", "group", "archived", "archiveOp", "pending", "gone", "view", "agents"}
	if len(keys) != len(want) {
		t.Errorf("the keys of a run record: %s", b)
	}
	for _, k := range want {
		if _, ok := keys[k]; !ok {
			t.Errorf("a run record has no %q: %s", k, b)
		}
	}
	// The group is always there: a run is never without a place.
	b, _ = json.Marshal(RunRecord{ID: runA, Entry: "s_entry"})
	if !strings.Contains(string(b), `"group":""`) || strings.Contains(string(b), "agents") || strings.Contains(string(b), "pending") {
		t.Errorf("an empty run record: %s", b)
	}
	typ := reflect.TypeOf(RunRecord{})
	for i := range typ.NumField() {
		f := typ.Field(i)
		if name := strings.ToLower(f.Name + f.Tag.Get("json")); strings.Contains(name, "secret") || strings.Contains(name, "token") {
			t.Errorf("RunRecord has the field %s", f.Name)
		}
	}
	if typ.NumField() != len(want) {
		t.Errorf("RunRecord has %d fields", typ.NumField())
	}
}

// TestRunAgents: the list of a record's agents is sorted, holds each id once and maxAgents of
// them at most, and an added id never changes a list that was handed out.
func TestRunAgents(t *testing.T) {
	t.Parallel()
	var rec RunRecord
	for _, id := range []string{"c", "a", "b", "a", "d"} {
		rec.addAgent(id)
	}
	if !reflect.DeepEqual(rec.Agents, []string{"a", "b", "c", "d"}) {
		t.Errorf("the agents: %v", rec.Agents)
	}
	was := rec.Agents
	if !rec.addAgent("bb") || !reflect.DeepEqual(was, []string{"a", "b", "c", "d"}) || !reflect.DeepEqual(rec.Agents, []string{"a", "b", "bb", "c", "d"}) {
		t.Errorf("after one more: %v, the list before it: %v", rec.Agents, was)
	}
	if !rec.hasAgent("bb") || rec.hasAgent("x") || rec.hasAgent("") {
		t.Error("hasAgent")
	}

	rec = RunRecord{}
	for i := range maxAgents + 20 {
		if added := rec.addAgent(fmt.Sprintf("agent-%04d", i)); added != (i < maxAgents) {
			t.Fatalf("agent %d: added %v", i, added)
		}
	}
	if len(rec.Agents) != maxAgents || !sort.StringsAreSorted(rec.Agents) {
		t.Errorf("%d agents", len(rec.Agents))
	}
	if rec.addAgent("agent-0003") || rec.addAgent("zz") || len(rec.Agents) != maxAgents {
		t.Error("a full record took an agent")
	}

	// What a file holds is put in order: ids of another form go, each id is there once.
	many := []string{"b", "a", "b", "../x", "", "a/b", "c"}
	for i := range maxAgents {
		many = append(many, fmt.Sprintf("z-%04d", i))
	}
	got := cleanAgents(many)
	if len(got) != maxAgents || !reflect.DeepEqual(got[:4], []string{"a", "b", "c", "z-0000"}) || !sort.StringsAreSorted(got) {
		t.Errorf("cleanAgents: %d ids, %v", len(got), got[:4])
	}
	if cleanAgents(nil) != nil || cleanAgents([]string{"../x"}) != nil {
		t.Error("cleanAgents of no id is not nil")
	}
}
