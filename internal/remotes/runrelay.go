package remotes

// The run half of the relay: the records of the runs that have started on other servers, what
// the relay makes of a remote server's run events, the run steps of a snapshot, and the follows
// of a run and of its agents' chats.
//
// A run record has the locks of a chat record: its own lock (runRecord.mu) over a change with
// its file write and its events, a follow lock, and Relay.mu for the list of records and for
// the lookup of the agents' chats. The order is runRecord.mu, then Relay.mu.
//
// An agent of a run has a chat on the run's server that is in nobody's list. This server learns
// its id from the run's detail and keeps it in the run's record: the lookup (chat id -> run)
// says which chat routes and which chat events belong to a run. An id that has a chat record is
// that record's, whatever the lookup says.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/servers"
)

// LocalRuns is what the relay asks of the run service: the draft runs that have a server and
// have not started yet. *runs.Service is one.
type LocalRuns interface {
	RemoteDraft(id string) (model.RunMeta, bool)
	SetRemoteStart(id, state string) error
	HandOver(id, entry string, started model.RunView) (model.RunMeta, error)
	Reissue(id string) (model.RunView, error)
	DraftsOn(entry string) []model.RunMeta
	ServerUp(entry string)
	ResetServer(id string) error
}

// errNoRuns is adoptRun's error on a relay without Options.Runs: it keeps no run records.
var errNoRuns = errors.New("remotes: this server has no runs")

// runRecord is a RunRecord in memory, with its locks.
type runRecord struct {
	id, entry string // d.ID and d.Entry: they never change

	// mu is the record's lock: d and the fields below. It is held over a change with its file
	// write and its events, never over a call to the record's server.
	mu      sync.Mutex
	d       RunRecord
	dirty   bool   // the file is older than d: written at the next flush
	failed  bool   // the last write failed, and that was logged
	removed bool   // dropped: no write and no event follows
	held    bool   // the draft of the id is not handed over yet: no view is sent (see swapRun)
	applied uint64 // counts the views of the run that were taken from its server (see take)
	capped  bool   // an agent above maxAgents was dropped, and that was logged
	lost    int    // the archive calls in a row that got no answer

	// followMu orders the follows of the run and of its agents' chats: a read that follows holds
	// it shared while it is passed on, an unfollow call holds it alone. So an unfollow never
	// overtakes a read.
	followMu sync.RWMutex

	pub atomic.Pointer[model.RunView] // what RunViews hands out: set by keepRun
}

func newRunRecord(d RunRecord) *runRecord {
	rec := &runRecord{id: d.ID, entry: d.Entry, d: d}
	rec.publish()
	return rec
}

// publish sets what RunViews hands out. rec.mu held, or the record is not shared yet.
func (rec *runRecord) publish() {
	v := runViewOf(rec.d)
	rec.pub.Store(&v)
}

// view is the record's view as a page gets it, as of its last change. It takes no lock.
func (rec *runRecord) view() model.RunView { return *rec.pub.Load() }

// agents are the chat ids of the record's agents, sorted.
func (rec *runRecord) agents() []string {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return append([]string(nil), rec.d.Agents...)
}

// stamp is the mark of a read of the run's view that is about to be sent: what take is given.
func (rec *runRecord) stamp() uint64 {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return rec.applied
}

// take takes the view v, which a read of the run sent at the mark since answered. An answer and
// an event of one run can cross: the view is taken only if no view of the run was taken since
// the read was sent, so an answer never puts an older view over a newer one. durable is what
// apply reports; the caller keeps the record and sends its event. rec.mu held.
func (rec *runRecord) take(since uint64, v model.RunView) (taken, durable bool) {
	if rec.removed || rec.applied != since {
		return false, false
	}
	rec.applied++
	return true, rec.d.apply(v, false)
}

// runPath is the path of the run id on its server, with rest after it ("" or "/…").
func runPath(id, rest string) string { return "/api/runs/" + url.PathEscape(id) + rest }

// ---- the records ----

// loadRuns reads the run records of the root, in Open. A record whose entry is not in the
// server list is removed with its file. A relay without Options.Runs reads none.
func (r *Relay) loadRuns() {
	if r.o.Runs == nil {
		return
	}
	for _, d := range r.runFiles.load(r.o.Logf) {
		if _, ok := r.o.Servers.View(d.Entry); !ok || d.Entry == servers.LocalID {
			r.o.Logf("remotes: the run %s is removed: its server is no longer in the list", d.ID)
			if err := r.runFiles.remove(d.ID); err != nil {
				r.o.Logf("remotes: the file of the run %s is not removed: %v", d.ID, err)
			}
			continue
		}
		d.Agents = r.claim(d.ID, d.Agents)
		r.runs[d.ID] = newRunRecord(d)
	}
}

// claim puts the agent chats ids of the run in the lookup and returns those it took: an id
// that is another run's agent stays that run's. Relay.mu held, or the relay is not shared yet.
func (r *Relay) claim(run string, ids []string) []string {
	var out []string
	for _, id := range cleanAgents(ids) {
		if owner, taken := r.agents[id]; taken && owner != run {
			continue
		}
		r.agents[id] = run
		out = append(out, id)
	}
	return out
}

// runRec is the record of the run id, nil for none.
func (r *Relay) runRec(id string) *runRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.runs[id]
}

// runOf is the record of the run id when it is a run of the server entry, nil otherwise: no
// server changes the record of another one's run.
func (r *Relay) runOf(entry, id string) *runRecord {
	if rec := r.runRec(id); rec != nil && rec.entry == entry {
		return rec
	}
	return nil
}

// runsOn are the run records of the entry, by id.
func (r *Relay) runsOn(entry string) []*runRecord {
	r.mu.Lock()
	var out []*runRecord
	for _, rec := range r.runs {
		if rec.entry == entry {
			out = append(out, rec)
		}
	}
	r.mu.Unlock()
	runsByID(out)
	return out
}

// allRuns are the run records, by id.
func (r *Relay) allRuns() []*runRecord {
	r.mu.Lock()
	out := make([]*runRecord, 0, len(r.runs))
	for _, rec := range r.runs {
		out = append(out, rec)
	}
	r.mu.Unlock()
	runsByID(out)
	return out
}

func runsByID(recs []*runRecord) {
	sort.Slice(recs, func(i, j int) bool { return recs[i].id < recs[j].id })
}

// HasRun reports whether a record with this run id exists.
func (r *Relay) HasRun(id string) bool { return r.runRec(id) != nil }

// AgentChat reports whether the chat id is a learned agent chat of a run record, and of which
// run. It does not look at the chat records: an id that has one is that record's (see Has).
func (r *Relay) AgentChat(chat string) (run string, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	run, ok = r.agents[chat]
	return run, ok
}

// RunViews are the views of every run record as a page gets them, sorted by id, for the
// snapshot. Never nil.
func (r *Relay) RunViews() []model.RunView {
	recs := r.allRuns()
	out := make([]model.RunView, 0, len(recs))
	for _, rec := range recs {
		out = append(out, rec.view())
	}
	return out
}

// agentRun is the record of the run whose agent the chat id is, nil when the id is no learned
// agent chat or has a chat record.
func (r *Relay) agentRun(chat string) *runRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.recs[chat] != nil {
		return nil
	}
	if run, ok := r.agents[chat]; ok {
		return r.runs[run]
	}
	return nil
}

// agentOn is agentRun for an event of the server entry: nil unless the run is that server's.
func (r *Relay) agentOn(entry, chat string) *runRecord {
	if rec := r.agentRun(chat); rec != nil && rec.entry == entry {
		return rec
	}
	return nil
}

// adoptRun makes the run record d: it is listed, so that HasRun, the routes and the events find
// it, and its file is written before any other use of it. It sends no event. The mark is
// d.Archived as given: View.Archived is not read. An error means that no record was made: an
// id that is no run id or an entry that cannot be a record's (errBadRecord), an id that has a
// record (errTaken), an entry that is not in the list or was removed (errNoEntry), a relay
// without Options.Runs (errNoRuns).
func (r *Relay) adoptRun(d RunRecord) (*runRecord, error) { return r.adoptRunAs(d, false) }

// adoptRunAs is adoptRun for a record that is held from its first moment on, with held: the
// pages get no view of it until the swap that made it lets go (see swapRun).
func (r *Relay) adoptRunAs(d RunRecord, held bool) (*runRecord, error) {
	if r.o.Runs == nil {
		return nil, errNoRuns
	}
	if !runs.ValidID(d.ID) || d.Entry == "" || d.Entry == servers.LocalID {
		return nil, errBadRecord
	}
	if _, ok := r.o.Servers.View(d.Entry); !ok {
		return nil, errNoEntry
	}
	rec := newRunRecord(d)
	rec.held = held
	rec.mu.Lock()
	defer rec.mu.Unlock()
	r.mu.Lock()
	var err error
	switch {
	case r.left[d.Entry]:
		err = errNoEntry
	case r.runs[d.ID] != nil:
		err = errTaken
	default:
		rec.d.Agents = r.claim(d.ID, d.Agents)
		r.runs[d.ID] = rec
	}
	r.mu.Unlock()
	if err != nil {
		return nil, err
	}
	r.writeRun(rec)
	return rec, nil
}

// dropRun removes the run record with its file and its learned agents. It sends no event: see
// removeRun. rec.mu held.
func (r *Relay) dropRun(rec *runRecord) {
	if rec.removed {
		return
	}
	rec.removed = true
	// The file goes first: a new record of the id can be adopted only once this one is unlisted.
	if err := r.runFiles.remove(rec.id); err != nil {
		r.o.Logf("remotes: the file of the run %s is not removed: %v", rec.id, err)
	}
	r.mu.Lock()
	if r.runs[rec.id] == rec {
		delete(r.runs, rec.id)
	}
	for _, a := range rec.d.Agents {
		if r.agents[a] == rec.id {
			delete(r.agents, a)
		}
	}
	r.mu.Unlock()
}

// removeRun removes the run record with its file and its learned agents, and tells every page
// that the run is no more (run_removed): the bridge then forgets the run's follows, and the
// follows of its agents' chats are forgotten here. Nothing is sent to the run's server.
func (r *Relay) removeRun(rec *runRecord) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed {
		return
	}
	r.dropRun(rec)
	r.forgetAgents(rec)
	r.o.Bridge.SendRun(rec.id, map[string]any{"type": "run_removed", "id": rec.id})
}

// forgetAgents drops every follow of the chats of the record's agents. rec.mu held.
func (r *Relay) forgetAgents(rec *runRecord) {
	for _, a := range rec.d.Agents {
		r.o.Bridge.Forget(editorbridge.Chat(a))
	}
}

// keepRun is called after every change of rec.d: what RunViews hands out is set, and the file
// is written at once when durable is set, else at the next flush. rec.mu held.
func (r *Relay) keepRun(rec *runRecord, durable bool) {
	if rec.removed {
		return
	}
	rec.publish()
	if durable {
		r.writeRun(rec)
	} else {
		rec.dirty = true
	}
}

// writeRun writes the record's file. A write that fails is logged once and tried again at every
// flush; a record above the size limit is not written. rec.mu held.
func (r *Relay) writeRun(rec *runRecord) {
	if err := r.runFiles.save(rec.d); err != nil {
		if !rec.failed {
			r.o.Logf("remotes: the run %s is not written: %v", rec.id, err)
		}
		// A record that is too large is not tried again until it changes.
		rec.dirty, rec.failed = !errors.Is(err, errTooLarge), true
		return
	}
	rec.dirty, rec.failed = false, false
}

// flushRuns writes the run records whose view or agents changed since their last write.
func (r *Relay) flushRuns() {
	for _, rec := range r.allRuns() {
		rec.mu.Lock()
		if rec.dirty && !rec.removed {
			r.writeRun(rec)
		}
		rec.mu.Unlock()
	}
}

// emitRun sends the record's view to every page. rec.mu held, as for every emit of a record:
// the events of one run leave in the order of its changes. Nothing is sent of a record that is
// held: the pages still have the draft, and the swap sends the view when the draft has gone.
func (r *Relay) emitRun(rec *runRecord) {
	if rec.held {
		return
	}
	r.o.Bridge.SendRun(rec.id, map[string]any{"type": "run", "run": runViewOf(rec.d)})
}

// takeRun takes the view v, which a read or a call for the run sent at the mark since (stamp)
// answered: see take. When the view was taken and what a page gets changed by it, the pages get
// the record's view. It reports whether the view was taken.
func (r *Relay) takeRun(rec *runRecord, since uint64, v model.RunView) (taken bool) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	was := rec.view()
	taken, durable := rec.take(since, v)
	if !taken {
		return false
	}
	r.keepRun(rec, durable)
	if durable || !sameRun(was, rec.view()) {
		r.emitRun(rec)
	}
	return true
}

// sameRun reports whether two views of a run as a page gets them are the same event.
func sameRun(a, b model.RunView) bool {
	x, errA := json.Marshal(a)
	y, errB := json.Marshal(b)
	return errA == nil && errB == nil && bytes.Equal(x, y)
}

// markRunGone notes that the record's run is no longer on its server, and tells the pages: the
// run stays listed, marked gone, until the user removes it here. The follows of the run and of
// its agents' chats are forgotten: nothing follows a run that is gone.
func (r *Relay) markRunGone(rec *runRecord) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed {
		return
	}
	rec.applied++
	if !rec.d.Gone {
		rec.d.Gone = true
		r.keepRun(rec, true)
		r.emitRun(rec)
	}
	r.o.Bridge.Forget(editorbridge.Run(rec.id))
	r.forgetAgents(rec)
}

// ---- the agents' chats ----

// learn notes that the chats ids are those of agents of the record's run. An id is not taken
// when it is not of the known form, has a chat record, is a chat of this server or is another
// run's agent. A record keeps maxAgents of them: more are dropped, and that is logged once. The
// record is written at the next flush.
func (r *Relay) learn(rec *runRecord, ids []string) {
	if len(ids) == 0 {
		return
	}
	var fresh []string
	r.mu.Lock()
	for _, id := range ids {
		if _, known := r.agents[id]; !known && validID(id) && r.recs[id] == nil {
			fresh = append(fresh, id)
		}
	}
	r.mu.Unlock()
	if len(fresh) == 0 {
		return
	}
	sort.Strings(fresh)
	rec.mu.Lock()
	full := len(rec.d.Agents) >= maxAgents
	rec.mu.Unlock()
	if !full && r.o.Local != nil {
		// Asked with no lock held. Such an id is never an agent's: its events would reach the
		// pages that follow the chat of this server.
		own := fresh[:0]
		for _, id := range fresh {
			if !r.o.Local.Known(id) {
				own = append(own, id)
			}
		}
		fresh = own
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed {
		return
	}
	added := false
	for _, id := range fresh {
		if len(rec.d.Agents) >= maxAgents {
			if !rec.capped {
				rec.capped = true
				r.o.Logf("remotes: the run %s has %d agent chats here: more are dropped", rec.id, maxAgents)
			}
			break
		}
		r.mu.Lock()
		_, taken := r.agents[id]
		if !taken {
			r.agents[id] = rec.id
		}
		r.mu.Unlock()
		if !taken && rec.d.addAgent(id) {
			added = true
		}
	}
	if added {
		r.keepRun(rec, false)
	}
}

// learnDetail learns the agents of the record's run from the answer of its detail read
// (GET /api/runs/{id}/detail): the keys of "agents".
func (r *Relay) learnDetail(rec *runRecord, body []byte) {
	var d struct {
		Agents map[string]json.RawMessage `json:"agents"`
	}
	if json.Unmarshal(body, &d) == nil {
		r.learn(rec, keysOf(d.Agents))
	}
}

// agentsIn are the chat ids of the agents a run_detail event (the keys of patch.agents) or a
// run_activity event (the keys of agents) names.
func agentsIn(typ string, raw json.RawMessage) []string {
	var ev struct {
		Agents map[string]json.RawMessage `json:"agents"`
		Patch  struct {
			Agents map[string]json.RawMessage `json:"agents"`
		} `json:"patch"`
	}
	if json.Unmarshal(raw, &ev) != nil {
		return nil
	}
	if typ == "run_detail" {
		return keysOf(ev.Patch.Agents)
	}
	return keysOf(ev.Agents)
}

func keysOf(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// ---- the events of a remote server ----

// runEvent takes a run's view: the record keeps it, and the pages get the record's view. The
// view of a run without a record is dropped, unless it settles a draft run (startedRun): the
// first one of every start comes before the record is made.
func (r *Relay) runEvent(entry string, raw json.RawMessage) {
	var ev struct {
		Run model.RunView `json:"run"`
	}
	if json.Unmarshal(raw, &ev) != nil {
		return
	}
	rec := r.runOf(entry, ev.Run.ID)
	if rec == nil {
		if !r.startedRun(entry, ev.Run) {
			r.unknownRun(entry, "run", ev.Run.ID)
		}
		return
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed {
		return
	}
	rec.applied++
	r.keepRun(rec, rec.d.apply(ev.Run, false))
	r.emitRun(rec)
}

// runRemovedEvent takes a run's removal on its server. It is not passed on: the record stays,
// marked gone, until the user removes it here.
func (r *Relay) runRemovedEvent(entry string, raw json.RawMessage) {
	var ev struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &ev) != nil {
		return
	}
	rec := r.runOf(entry, ev.ID)
	if rec == nil {
		r.unknownRun(entry, "run_removed", ev.ID)
		return
	}
	r.markRunGone(rec)
}

// runContentEvent hands a run_detail or run_activity event on as it came: the bridge gives it
// to the run's followers alone. The agents it names are learned first, so that a page that
// reads one of them on getting the event finds its routes. The pages read "type" and "run"
// themselves, so an event that names either twice, or otherwise than it was routed by, is
// dropped.
func (r *Relay) runContentEvent(entry, typ string, raw json.RawMessage) {
	f, ok := fields(raw, "type", "run")
	if !ok || text(f["type"]) != typ {
		return
	}
	id := text(f["run"])
	rec := r.runOf(entry, id)
	if rec == nil {
		r.unknownRun(entry, typ, id)
		return
	}
	r.learn(rec, agentsIn(typ, raw))
	r.o.Bridge.SendRun(id, raw)
}

// agentEvent hands an event of a run agent's chat on as it came, to the chat's followers alone:
// such a chat is in nobody's list. key is the member that names the chat: an event that names
// it or "type" twice, or has another type than it was routed by, is dropped.
func (r *Relay) agentEvent(typ, key, chat string, raw json.RawMessage) {
	if f, ok := fields(raw, "type", key); !ok || text(f["type"]) != typ {
		return
	}
	r.o.Bridge.SendChat(chat, true, raw)
}

// unknownRun counts an event of a run the entry has no record of, and logs it once a minute per
// id. Nothing is logged for a draft run of the entry: the first events of a start come before
// the record.
func (r *Relay) unknownRun(entry, typ, id string) {
	r.droppedRuns.Add(1)
	if r.o.Runs != nil {
		if meta, ok := r.o.Runs.RemoteDraft(id); ok && meta.Server == entry {
			return
		}
	}
	if len(id) > 64 {
		id = id[:64]
	}
	if r.tell("run " + id) {
		r.o.Logf("remotes: an event %q of the run %q from the server %s is dropped: it has no record here", typ, id, entry)
	}
}

// ---- the run steps of a snapshot, and an entry's removal ----

// snapshotRuns is the run part of step 2 of a snapshot: every run record of the entry takes
// what the snapshot tells of its run. A pending archive change stays; a run the snapshot does
// not have is gone.
func (r *Relay) snapshotRuns(entry string, snap *snapshot) {
	for _, rec := range r.runsOn(entry) {
		rec.mu.Lock()
		if !rec.removed {
			rec.applied++
			if v, ok := snap.run(rec.id); ok {
				r.keepRun(rec, rec.d.apply(v, true))
			} else {
				durable := !rec.d.Gone
				rec.d.Gone = true
				r.keepRun(rec, durable)
			}
		}
		rec.mu.Unlock()
	}
}

// forgetRuns is the run part of step 4 of a snapshot: the pages' follows of the entry's runs
// and of their agents' chats end, since the server follows nothing for this one on its new
// stream.
func (r *Relay) forgetRuns(recs []*runRecord) {
	for _, rec := range recs {
		r.o.Bridge.Forget(editorbridge.Run(rec.id))
		for _, a := range rec.agents() {
			r.o.Bridge.Forget(editorbridge.Chat(a))
		}
	}
}

// emitRuns is the run part of step 6 of a snapshot: the view of every run record of the entry.
func (r *Relay) emitRuns(recs []*runRecord) {
	for _, rec := range recs {
		rec.mu.Lock()
		if !rec.removed {
			r.emitRun(rec)
		}
		rec.mu.Unlock()
	}
}

// removedRuns is the run part of an entry's removal: its run records go with their files, and
// the pages are told. The unstarted chats people made on such a run go with it, as at its
// delete: they would be chats on no run. Relay.left has the entry already, so no record is
// adopted for it.
func (r *Relay) removedRuns(entry string) {
	for _, rec := range r.runsOn(entry) {
		if r.o.Local != nil {
			r.o.Local.DeleteOnRun(rec.id)
		}
		r.removeRun(rec)
	}
}

// resetDrafts puts every draft run on the removed entry back on this computer.
func (r *Relay) resetDrafts(entry string) {
	r.forgetGoals(entry, true)
	if r.o.Runs == nil {
		return
	}
	for _, meta := range r.o.Runs.DraftsOn(entry) {
		if err := r.o.Runs.ResetServer(meta.ID); err != nil {
			r.o.Logf("remotes: the run %s is not put back on this computer: %v", meta.ID, err)
		}
	}
}

// ---- follows ----

// followRun passes a read of the record's run on for the page client, which follows the run
// from here on: the record's follow lock is held shared over the follow and the call. The read
// makes this server a follower there. When client has no stream here, so that no page's follow
// will ever end, the follow there is ended after the read, unless a page follows the run.
func (r *Relay) followRun(ctx context.Context, rec *runRecord, client, method, path string, limit time.Duration) (servers.Reply, error) {
	rec.followMu.RLock()
	followed := r.o.Bridge.FollowAs(editorbridge.KindPage, client, editorbridge.Run(rec.id))
	rep, err := r.call(ctx, rec.entry, method, path, nil, limit)
	rec.followMu.RUnlock()
	if !followed && !errors.Is(err, ErrUnreachable) {
		r.spawn(func() { r.unfollowRun(rec) })
	}
	return rep, err
}

// followAgent is followRun for a read of the chat of an agent of the record's run: the page
// client follows that chat, under its run's follow lock.
func (r *Relay) followAgent(ctx context.Context, rec *runRecord, chat, client, method, path string, limit time.Duration) (servers.Reply, error) {
	rec.followMu.RLock()
	followed := r.o.Bridge.FollowAs(editorbridge.KindPage, client, editorbridge.Chat(chat))
	rep, err := r.call(ctx, rec.entry, method, path, nil, limit)
	rec.followMu.RUnlock()
	if !followed && !errors.Is(err, ErrUnreachable) {
		r.spawn(func() { r.unfollowAgent(rec, chat) })
	}
	return rep, err
}

// unfollowRun makes the unfollow call for the record's run, with the follow lock held alone.
func (r *Relay) unfollowRun(rec *runRecord) {
	r.unfollowThere(rec, editorbridge.Run(rec.id), runPath(rec.id, "/unfollow"), "run "+rec.id)
}

// unfollowAgent makes the unfollow call for the chat of an agent of the record's run, with the
// run's follow lock held alone.
func (r *Relay) unfollowAgent(rec *runRecord, chat string) {
	r.unfollowThere(rec, editorbridge.Chat(chat), chatPath(chat, "/unfollow"), "run agent's chat "+chat)
}

// unfollowThere tells the record's server to end this server's follow of it, unless a page
// follows it again by now or the run is gone or removed: nothing follows those.
func (r *Relay) unfollowThere(rec *runRecord, it editorbridge.Item, path, what string) {
	rec.followMu.Lock()
	defer rec.followMu.Unlock()
	if r.o.Bridge.Followed(it) || rec.view().Gone || r.runRec(rec.id) != rec {
		return
	}
	// Not through call: an entry that is not connected follows nothing, and is not woken for this.
	rep, err := r.o.Servers.Do(r.ctx, rec.entry, http.MethodPost, path, nil, r.o.Limits.Unfollow)
	switch {
	case err == nil && (rep.Status == http.StatusOK || rep.Status == http.StatusNotFound),
		errors.Is(err, servers.ErrNotConnected), errors.Is(err, servers.ErrNotFound), r.ctx.Err() != nil:
	case err != nil:
		r.o.Logf("remotes: the unfollow of the %s got no answer", what)
	default:
		r.o.Logf("remotes: the unfollow of the %s was answered with %d", what, rep.Status)
	}
}

// unfollowedRun is Unfollowed for an item that is no chat record's: a run with a record, or
// the chat of a learned agent of one.
func (r *Relay) unfollowedRun(it editorbridge.Item) {
	switch it {
	case editorbridge.Run(it.ID):
		if rec := r.runRec(it.ID); rec != nil {
			r.spawn(func() { r.unfollowRun(rec) })
		}
	case editorbridge.Chat(it.ID):
		if rec := r.agentRun(it.ID); rec != nil {
			r.spawn(func() { r.unfollowAgent(rec, it.ID) })
		}
	}
}
