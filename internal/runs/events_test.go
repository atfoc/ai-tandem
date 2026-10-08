package runs

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

// The events of a run reach the clients in the order they were queued: every entry's run_detail
// in the order of the versions, and the run's view after the entry that changed it.
func TestSvcEventOrder(t *testing.T) {
	x := newToolRun(t, false)
	x.events()
	x.tick(2 * time.Second)
	// The sender sends the view as it is when it gets to a change (never older than the entry it
	// follows, possibly newer), so the test lets it get to each change before it makes the next.
	x.turnStart("start") // v2: turns, turnRunning
	x.s.svcFlush()
	x.ok("orchestrator", "add_task", toolAdd("Read the old importer", "research", false)) // v3: a count
	x.s.svcFlush()
	x.turnEnd("One task.", 0.2) // v4: turnRunning, cost
	x.s.svcFlush()
	x.s.queue(x.id, map[string]any{"type": "run_activity", "run": x.id})
	if _, err := x.s.Patch(x.id, PatchReq{Name: svcPtr("Renamed")}); err != nil {
		t.Fatal(err)
	}
	evs := x.events()
	kinds := svcKinds(evs)
	if fmt.Sprint(kinds) != "[run_detail 2 run run_detail 3 run_detail 4 run run_activity run]" {
		t.Fatalf("events: %v", kinds)
	}
	// Each `run` event is the view as it was when the sender looked: never older than the entry
	// it follows.
	views := svcRunEvents(evs, x.id)
	if views[0].Turns != 1 || views[0].TurnRunning != 1 || views[1].TurnRunning != 0 || views[1].Counts.Slot != 1 || views[1].Cost == nil || *views[1].Cost != 0.2 ||
		views[2].Name != "Renamed" {
		t.Fatalf("views: %+v", views)
	}
	// The patch of an entry is the records it touched, as clients get them.
	d := evs[2].(detailEvent)
	if d.Type != "run_detail" || d.Run != x.id || d.Version != 3 || len(d.Patch.Tasks) != 1 || d.Patch.Tasks[0].ID != "T01" || len(d.Patch.Turns) != 1 || len(d.Patch.Turns[0].Ops) != 1 {
		t.Fatalf("the patch of entry 3: %+v", d)
	}
}

// The rule of the `run` event: a view that differs in more than counters goes at once; one that
// differs only in counts, idleStreak, attention, cost or costPartial at most once per second per
// run, with the view as it is when the second is over.
func TestSvcRunEventRule(t *testing.T) {
	x := newToolRun(t, false)
	other := x.startRun("r_other001", "Another run", false)
	x.turnStart("start")
	x.tick(5 * time.Second)
	x.events()
	count := func(id string) int { return len(svcRunEvents(x.allEvents(), id)) }
	// The sender sends the view as it is when it gets to a change, so the test lets it get to
	// each change before it makes the next.
	add := func(n int) {
		x.ok("orchestrator", "add_task", toolAdd(fmt.Sprintf("Task %d", n), "research", false))
		x.s.svcFlush()
	}
	base := count(x.id)

	// The last `run` event is five seconds old: the first change of a count goes at once.
	add(1)
	if got := svcRunEvents(x.events(), x.id); len(got) != 1 || got[0].Counts.Held != 1 {
		t.Fatalf("the first count change: %+v", got)
	}
	// More of them inside the same second: nothing is sent, however many.
	add(2)
	add(3)
	x.tick(400 * time.Millisecond)
	add(4)
	x.tick(500 * time.Millisecond)
	add(5)
	if evs := x.events(); len(svcRunEvents(evs, x.id)) != 0 || len(evs) != 4 {
		t.Fatalf("inside the second: %v", svcKinds(evs))
	}
	// The other run is not held back by this one: each run has its own second.
	x.must(other, KTurnStarted, func(tx *Tx) error {
		tx.AddTurn(Turn{N: 1, Agent: "a", Reason: "start", Status: "running", StartedAt: tx.Now()})
		return nil
	})
	if got := svcRunEvents(x.events(), other.id); len(got) != 1 || got[0].Turns != 1 {
		t.Fatalf("the other run: %+v", got)
	}
	// When the second is over, one event with the view as it is then.
	x.tick(100 * time.Millisecond)
	svcWait(t, "the timer's `run` event", func() bool { return count(x.id) == base+2 })
	if got := svcRunEvents(x.events(), x.id); len(got) != 1 || got[0].Counts.Held != 5 {
		t.Fatalf("after the second: %+v", got)
	}
	// Nothing changed since: more time sends nothing.
	x.tick(3 * time.Second)
	x.s.svcFlush()
	if got := count(x.id); got != base+2 {
		t.Fatalf("%d `run` events with nothing changed", got-base)
	}
	// A change of a count and, inside the same second, one of the fields that go at once: both
	// are in that one event, and the timer that was set finds nothing left to send.
	add(6)
	add(7)
	if _, err := x.s.Patch(x.id, PatchReq{Name: svcPtr("Renamed")}); err != nil {
		t.Fatal(err)
	}
	if got := svcRunEvents(x.events(), x.id); len(got) != 2 || got[0].Counts.Held != 6 || got[1].Counts.Held != 7 || got[1].Name != "Renamed" {
		t.Fatalf("a count and a name: %+v", got)
	}
	x.tick(2 * time.Second)
	x.s.svcFlush()
	time.Sleep(20 * time.Millisecond)
	if got := svcRunEvents(x.events(), x.id); len(got) != 0 {
		t.Fatalf("after the name went out: %+v", got)
	}
	// The status, the turn and the turn that runs go at once, also right after another event.
	x.turnEnd("Seven tasks.", 0.5)
	x.s.svcFlush()
	x.turnStart("idle")
	x.s.svcFlush()
	if _, err := x.s.Stop(x.id); err != nil {
		t.Fatal(err)
	}
	got := svcRunEvents(x.events(), x.id)
	var said []string
	for _, v := range got {
		said = append(said, fmt.Sprintf("%s/%d/%d", v.Status, v.Turns, v.TurnRunning))
	}
	// The stop writes two entries back to back (stopping, then stopped: no engine runs here), which
	// the sender may get to as one.
	if all := strings.Join(said, " "); all != "running/1/0 running/2/2 stopping/2/2 stopped/2/2" && all != "running/1/0 running/2/2 stopped/2/2" {
		t.Fatalf("status and turns: %v", said)
	}
	// Tool calls that change no task change nothing in the view: no `run` event at all.
	y := newToolRun(t, false)
	y.turnStart("start")
	y.tick(5 * time.Second)
	y.events()
	y.ok("orchestrator", "set_notes", toolNotes)
	y.ok("orchestrator", "get_run", `{}`)
	y.ok("orchestrator", "get_notes", `{}`)
	if evs := y.events(); fmt.Sprint(svcKinds(evs)) != "[run_detail 3 run_detail 4 run_detail 5]" {
		t.Fatalf("reads and notes: %v", svcKinds(evs))
	}
}

// svcNosyEmitter is a client connection that looks at the runs while it is being sent an event:
// what the snapshot of a connecting client does, and more.
type svcNosyEmitter struct {
	mu   sync.Mutex
	s    *Service
	seen int
}

func (n *svcNosyEmitter) Broadcast(ev any) { n.SendRun("", ev) }

func (n *svcNosyEmitter) SendRun(run string, ev any) {
	n.mu.Lock()
	s := n.s
	n.seen++
	n.mu.Unlock()
	for _, v := range s.Views() {
		s.RunOf(v.ID)
		s.ChatContext(v.ID)
		s.Detail(v.ID) // takes the run's lock
		s.View(v.ID)
	}
}

// Nothing is sent under a run's lock, nor under the service's or the queue's: a SendRun that
// reads the runs, and so takes those locks itself, does not deadlock.
func TestSvcBroadcastTakesNoLock(t *testing.T) {
	e := newSvcEnv(t)
	nosy := &svcNosyEmitter{}
	e.s = New(Deps{Store: e.s.Store, Emit: nosy, DefaultCwd: e.cwd, Clock: e.clock}) // before anything is sent
	nosy.mu.Lock()
	nosy.s = e.s
	nosy.mu.Unlock()
	e.wire()
	x := newToolRunOn(e, "r_tools001")
	done := make(chan struct{})
	go func() {
		defer close(done)
		x.turnStart("start")
		for i := 1; i <= 20; i++ {
			x.ok("orchestrator", "add_task", toolAdd(fmt.Sprintf("Task %d", i), "research", false))
			x.ok("chat", "tell_orchestrator", `{"text":"go on"}`)
		}
		x.s.Patch(x.id, PatchReq{Name: svcPtr("Renamed")})
		x.s.Stop(x.id)
		x.s.svcFlush()
	}()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("deadlock: an event was broadcast while a lock was held")
	}
	nosy.mu.Lock()
	defer nosy.mu.Unlock()
	if nosy.seen < 45 {
		t.Fatalf("%d events were broadcast", nosy.seen)
	}
}

// Commits from many goroutines: the run_detail events still arrive in the order of the versions.
func TestSvcEventsStayInOrderUnderLoad(t *testing.T) {
	x := newToolRun(t, false)
	x.events()
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 25; i++ {
				x.chat("tell_orchestrator", `{"text":"go on"}`)
			}
		}()
	}
	wg.Wait()
	next := int64(2)
	for _, ev := range x.events() {
		if d, ok := ev.(detailEvent); ok {
			if d.Version != next {
				t.Fatalf("version %d came where %d was due", d.Version, next)
			}
			next++
		}
	}
	if next != 202 {
		t.Fatalf("%d run_detail events", next-2)
	}
}

// A deleted run: `run_removed` is its last event, and nothing about it follows, also not from a
// timer that was set for it.
func TestSvcRunRemoved(t *testing.T) {
	x := newToolRun(t, false)
	x.turnStart("start")
	x.ok("orchestrator", "add_task", toolAdd("One", "research", false))
	x.ok("orchestrator", "add_task", toolAdd("Two", "research", false)) // a timer is set for the counts
	if err := x.s.Delete(x.id); err != nil {
		t.Fatal(err)
	}
	x.r.changed() // a late mark of a worker that was on its way
	x.tick(5 * time.Second)
	time.Sleep(20 * time.Millisecond)
	evs := x.allEvents()
	last := evs[len(evs)-1]
	if rm, ok := last.(svcRemovedEvent); !ok || rm.Type != "run_removed" || rm.ID != x.id {
		t.Fatalf("the last event: %#v (%v)", last, svcKinds(evs))
	}
	if n := strings.Count(fmt.Sprint(svcKinds(evs)), "run_removed"); n != 1 {
		t.Fatalf("%d run_removed events", n)
	}
	// The same id made again (a restored folder) starts with a clean slate: its view is sent.
	d := x.draft(x.id)
	d.changed()
	if got := svcRunEvents(x.events(), x.id); len(got) == 0 || got[len(got)-1].Status != model.RunDraft {
		t.Fatalf("a run with the same id: %+v", got)
	}
}

// Every event goes out as an event of its run (SendRun), so that it reaches the clients that run
// concerns: the `run` and `run_detail` events of two runs, and the `run_removed` of a deleted one.
func TestSvcEventsNameTheirRun(t *testing.T) {
	t.Parallel()
	x := newToolRun(t, false)
	other := x.startRun("r_other001", "Another run", false)
	x.turnStart("start")
	x.ok("orchestrator", "add_task", toolAdd("One", "research", false))
	x.must(other, KTurnStarted, func(tx *Tx) error {
		tx.AddTurn(Turn{N: 1, Agent: "a", Reason: "start", Status: "running", StartedAt: tx.Now()})
		return nil
	})
	if err := x.s.Delete(x.id); err != nil {
		t.Fatal(err)
	}
	evs, runs := x.allEvents(), x.emit.sentAs()
	seen := map[string]int{}
	for i, ev := range evs {
		var kind, want string
		switch e := ev.(type) {
		case svcRunEvent:
			kind, want = "run", e.Run.ID
		case detailEvent:
			kind, want = "run_detail", e.Run
		case svcRemovedEvent:
			kind, want = "run_removed", e.ID
		default: // the defaults a start records are about no run
			continue
		}
		if runs[i] != want {
			t.Errorf("a %s event of %s was sent as an event of %q", kind, want, runs[i])
		}
		seen[kind+" "+want]++
	}
	for _, k := range []string{"run " + x.id, "run_detail " + x.id, "run_removed " + x.id, "run " + other.id, "run_detail " + other.id} {
		if seen[k] == 0 {
			t.Errorf("no %s event: %v", k, svcKinds(evs))
		}
	}
}
