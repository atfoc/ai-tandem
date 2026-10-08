package remotes

// The board half of the relay: the records of the boards that live on other servers, what the
// relay makes of a remote server's board events, and the board steps of a snapshot.
//
// A board record has the locks of a run record: its own lock (boardRecord.mu) over a change
// with its file write and its events, and Relay.mu for the list of records. The order is
// boardRecord.mu, then Relay.mu. Its hold lock (holdMu) comes before both and is the only one
// held over a call to the board's server.
//
// Who draws on a board, the scene and the tool calls are in boardhold.go and boardcall.go, the
// operations of the pages in boardops.go: this file calls them through the hooks named there.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
)

// boardRecord is a BoardRecord in memory, with its locks and with what is kept of the board in
// memory alone.
type boardRecord struct {
	id, entry string // d.ID and d.Entry: they never change

	// mu is the record's lock: d and the fields below. It is held over a change with its file
	// write and its events, never over a call to the record's server.
	mu      sync.Mutex
	d       BoardRecord
	dirty   bool   // the file is older than d: written at the next flush
	failed  bool   // the last write failed, and that was logged
	removed bool   // dropped: no write and no event follows
	applied uint64 // counts the boards that were taken from the record's server (see take)
	lost    int    // the archive calls in a row that got no answer

	// Never on disk: what this server believes of the board's hold on its server. Both are read
	// and written with mu held, so an event of the server's stream reads them without waiting
	// for a call.
	heldThere bool   // this server holds the board there
	want      string // the page whose take waits there; "" for none

	// holdMu orders the take, the release and the re-take of the board: it is held across those
	// calls to the board's server, as followMu is for a chat's follows. It is taken before mu.
	holdMu sync.Mutex

	// rev is the last scene revision known of the board's server; 0 for none. It is read with no
	// lock and written with mu held, with d.Rev (see seen).
	rev atomic.Int64

	retaking atomic.Bool // a re-take that a save started is running (see retakeOnSave)

	pub atomic.Pointer[model.Board] // what BoardViews hands out: set by keepBoard
}

func newBoardRecord(d BoardRecord) *boardRecord {
	rec := &boardRecord{id: d.ID, entry: d.Entry, d: d}
	rec.rev.Store(d.Rev)
	rec.publish()
	return rec
}

// publish sets what BoardViews hands out. rec.mu held, or the record is not shared yet.
func (rec *boardRecord) publish() {
	v := boardViewOf(rec.d)
	rec.pub.Store(&v)
}

// view is the record's view as a page gets it, as of its last change. It takes no lock.
func (rec *boardRecord) view() model.Board { return *rec.pub.Load() }

// stamp is the mark of a call for the board that is about to be sent: what take is given.
func (rec *boardRecord) stamp() uint64 {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return rec.applied
}

// take takes the board v, which a call sent at the mark since answered with. An answer and an
// event of one board can cross: the board is taken only if none was taken since the call was
// sent, so an answer never puts an older board over a newer one. durable is what apply reports;
// the caller keeps the record and sends its event. rec.mu held.
func (rec *boardRecord) take(since uint64, v model.Board) (taken, durable bool) {
	if rec.removed || rec.applied != since {
		return false, false
	}
	rec.applied++
	return true, rec.d.apply(v, false)
}

// boardPath is the path of the board id on its server, with rest after it ("" or "/…").
func boardPath(id, rest string) string { return "/api/boards/" + url.PathEscape(id) + rest }

// ---- the records ----

// loadBoards reads the board records of the root, in Open. A record whose entry is not in the
// server list is removed with its file.
func (r *Relay) loadBoards() {
	for _, d := range r.boardFiles.load(r.o.Logf) {
		if _, ok := r.o.Servers.View(d.Entry); !ok || d.Entry == servers.LocalID {
			r.o.Logf("remotes: the board %s is removed: its server is no longer in the list", d.ID)
			if err := r.boardFiles.remove(d.ID); err != nil {
				r.o.Logf("remotes: the file of the board %s is not removed: %v", d.ID, err)
			}
			continue
		}
		rec := newBoardRecord(d)
		r.boards[d.ID] = rec
		r.boardIdx.Store(d.ID, rec)
	}
}

// boardRec is the record of the board id, nil for none.
func (r *Relay) boardRec(id string) *boardRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.boards[id]
}

// boardOf is the record of the board id when it is a board of the server entry, nil otherwise:
// no server changes the record of another one's board.
func (r *Relay) boardOf(entry, id string) *boardRecord {
	if rec := r.boardRec(id); rec != nil && rec.entry == entry {
		return rec
	}
	return nil
}

// boardsOn are the board records of the entry, by id.
func (r *Relay) boardsOn(entry string) []*boardRecord {
	r.mu.Lock()
	var out []*boardRecord
	for _, rec := range r.boards {
		if rec.entry == entry {
			out = append(out, rec)
		}
	}
	r.mu.Unlock()
	boardsByID(out)
	return out
}

// allBoards are the board records, by id.
func (r *Relay) allBoards() []*boardRecord {
	r.mu.Lock()
	out := make([]*boardRecord, 0, len(r.boards))
	for _, rec := range r.boards {
		out = append(out, rec)
	}
	r.mu.Unlock()
	boardsByID(out)
	return out
}

func boardsByID(recs []*boardRecord) {
	sort.Slice(recs, func(i, j int) bool { return recs[i].id < recs[j].id })
}

// HasBoard reports whether a record with this board id exists.
func (r *Relay) HasBoard(id string) bool { return r.boardRec(id) != nil }

// BoardOn tells of a board that lives on another server: the entry it is on, its group here and
// whether it is archived, as a page sees it. ok is false for a board the relay keeps no record of.
func (r *Relay) BoardOn(id string) (entry, group string, archived, ok bool) {
	rec := r.boardRec(id)
	if rec == nil {
		return "", "", false, false
	}
	v := rec.view()
	return rec.entry, v.Group, v.Archived, true
}

// BoardViews are the views of every board record as a page gets them, sorted by id, for the
// snapshot. Never nil.
func (r *Relay) BoardViews() []model.Board {
	recs := r.allBoards()
	out := make([]model.Board, 0, len(recs))
	for _, rec := range recs {
		out = append(out, rec.view())
	}
	return out
}

// BoardView is the view of the board record id as a page gets it.
func (r *Relay) BoardView(id string) (model.Board, bool) {
	rec := r.boardRec(id)
	if rec == nil {
		return model.Board{}, false
	}
	return rec.view(), true
}

// BoardRev is the last scene revision known of the board's server, 0 when none is known yet. ok
// is false for a board without a record. It takes no lock: it is the bridge's SceneRev for a
// board on another server, which the bridge calls with its own lock held.
func (r *Relay) BoardRev(id string) (rev int64, ok bool) {
	v, ok := r.boardIdx.Load(id)
	if !ok {
		return 0, false
	}
	return v.(*boardRecord).rev.Load(), true
}

// makingBoard notes that a creation call for the board id is on its way to a server. Until done
// is called no record is adopted for the id from an event or a snapshot: the board's event can
// overtake the creation's answer, and the record is the creation's to make, in the group the
// page chose.
func (r *Relay) makingBoard(id string) (done func()) {
	r.mu.Lock()
	r.making[id]++
	r.mu.Unlock()
	return func() {
		r.mu.Lock()
		if r.making[id]--; r.making[id] <= 0 {
			delete(r.making, id)
		}
		r.mu.Unlock()
	}
}

// adoptBoard makes the board record d: it is listed, so that HasBoard, the routes and the
// events find it, and its file is written before any other use of it. It sends no event. The
// mark is d.Archived as given: View.Archived is not read. An error means that no record was
// made: an id that is no board id or an entry that cannot be a record's (errBadRecord), an id
// that has a record (errTaken), an entry that is not in the list or was removed (errNoEntry).
func (r *Relay) adoptBoard(d BoardRecord) (*boardRecord, error) {
	if !validBoardID(d.ID) || d.Entry == "" || d.Entry == servers.LocalID {
		return nil, errBadRecord
	}
	if _, ok := r.o.Servers.View(d.Entry); !ok {
		return nil, errNoEntry
	}
	if d.Group == "" {
		d.Group = model.Ungrouped
	}
	rec := newBoardRecord(d)
	rec.mu.Lock()
	defer rec.mu.Unlock()
	r.mu.Lock()
	var err error
	switch {
	case r.left[d.Entry]:
		err = errNoEntry
	case r.boards[d.ID] != nil:
		err = errTaken
	default:
		r.boards[d.ID] = rec
		r.boardIdx.Store(d.ID, rec)
	}
	r.mu.Unlock()
	if err != nil {
		return nil, err
	}
	r.writeBoard(rec)
	return rec, nil
}

// dropBoard removes the board record with its file. It sends no event: see removeBoard.
// rec.mu held.
func (r *Relay) dropBoard(rec *boardRecord) {
	if rec.removed {
		return
	}
	rec.removed = true
	// The file goes first: a new record of the id can be adopted only once this one is unlisted.
	if err := r.boardFiles.remove(rec.id); err != nil {
		r.o.Logf("remotes: the file of the board %s is not removed: %v", rec.id, err)
	}
	r.mu.Lock()
	if r.boards[rec.id] == rec {
		delete(r.boards, rec.id)
		r.boardIdx.Delete(rec.id)
	}
	r.mu.Unlock()
}

// removeBoard removes the board record with its file and tells every page that the board is no
// more (board_removed). Nothing is sent to the board's server. It reports false for a record
// that was removed already.
func (r *Relay) removeBoard(rec *boardRecord) bool {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed {
		return false
	}
	r.dropBoard(rec)
	r.emitBoardRemoved(rec.id)
	return true
}

// keepBoard is called after every change of rec.d: what BoardViews hands out is set, and the
// file is written at once when durable is set, else at the next flush. rec.mu held.
func (r *Relay) keepBoard(rec *boardRecord, durable bool) {
	if rec.removed {
		return
	}
	rec.publish()
	if durable {
		r.writeBoard(rec)
	} else {
		rec.dirty = true
	}
}

// writeBoard writes the record's file. A write that fails is logged once and tried again at
// every flush; a record above the size limit is not written. rec.mu held.
func (r *Relay) writeBoard(rec *boardRecord) {
	if err := r.boardFiles.save(rec.d); err != nil {
		if !rec.failed {
			r.o.Logf("remotes: the board %s is not written: %v", rec.id, err)
		}
		// A record that is too large is not tried again until it changes.
		rec.dirty, rec.failed = !errors.Is(err, errTooLarge), true
		return
	}
	rec.dirty, rec.failed = false, false
}

// flushBoards writes the board records whose view changed since their last write.
func (r *Relay) flushBoards() {
	for _, rec := range r.allBoards() {
		rec.mu.Lock()
		if rec.dirty && !rec.removed {
			r.writeBoard(rec)
		}
		rec.mu.Unlock()
	}
}

// takeBoardView takes the board v, which a call for the board sent at the mark since (stamp)
// answered with: see take. When the board was taken and what a page gets changed by it, the
// pages get the record's view. It reports whether the board was taken.
func (r *Relay) takeBoardView(rec *boardRecord, since uint64, v model.Board) (taken bool) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	was := rec.view()
	taken, durable := rec.take(since, v)
	if !taken {
		return false
	}
	r.keepBoard(rec, durable)
	if durable || !sameBoard(was, rec.view()) {
		r.emitBoard(rec)
	}
	return true
}

// sameBoard reports whether two views of a board as a page gets them are the same event.
func sameBoard(a, b model.Board) bool {
	x, errA := json.Marshal(a)
	y, errB := json.Marshal(b)
	return errA == nil && errB == nil && bytes.Equal(x, y)
}

// markBoardGone notes that the record's board is no longer on its server, and tells the pages:
// the board stays listed, marked gone, until the user removes it here.
func (r *Relay) markBoardGone(rec *boardRecord) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed || rec.d.Gone {
		return
	}
	rec.applied++
	rec.d.Gone = true
	r.keepBoard(rec, true)
	r.emitBoard(rec)
}

// ---- events for the pages ----

// boardSender is the bridge once it routes the events of a board by the board: it gives them
// to every page, and to an API client only for the boards that carry its mark.
type boardSender interface {
	SendBoard(board string, ev any)
}

// sendBoard sends an event of the board id: with the bridge's SendBoard when it has one, to
// everyone otherwise.
func (r *Relay) sendBoard(id string, ev any) {
	if s, ok := any(r.o.Bridge).(boardSender); ok {
		s.SendBoard(id, ev)
		return
	}
	r.o.Bridge.Broadcast(ev)
}

// emitBoard sends the record's view to every page. rec.mu held, as for every emit of a record:
// the events of one board leave in the order of its changes.
func (r *Relay) emitBoard(rec *boardRecord) {
	r.sendBoard(rec.id, map[string]any{"type": "board", "board": boardViewOf(rec.d)})
}

// emitBoardRemoved tells every page that the board id is no more, after its record was dropped.
func (r *Relay) emitBoardRemoved(id string) {
	r.sendBoard(id, map[string]any{"type": "board_removed", "id": id})
}

// ---- events of a remote server ----

// boardEvent takes one event of the entry's server that tells of a board: the board itself
// (board, board_removed), who draws on it (held, release_request, superseded) and a tool call
// for a page (rpc). It runs on the entry's worker and does no I/O.
func (r *Relay) boardEvent(entry, typ string, raw json.RawMessage) {
	switch typ {
	case "board":
		r.boardChanged(entry, raw)
	case "board_removed":
		r.boardGone(entry, raw)
	case "held", "release_request", "superseded":
		r.boardRoleEvent(entry, typ, raw)
	case "rpc":
		r.boardCallEvent(entry, raw)
	}
}

// boardChanged takes a board: its record keeps it, and the pages get the record's view. A board
// without a record is adopted.
func (r *Relay) boardChanged(entry string, raw json.RawMessage) {
	var ev struct {
		Board model.Board `json:"board"`
	}
	if json.Unmarshal(raw, &ev) != nil {
		return
	}
	rec := r.boardOf(entry, ev.Board.ID)
	if rec == nil {
		if rec = r.adoptFrom(entry, ev.Board); rec == nil {
			return
		}
		rec.mu.Lock()
		defer rec.mu.Unlock()
		if !rec.removed {
			r.emitBoard(rec)
		}
		return
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed {
		return
	}
	rec.applied++
	r.keepBoard(rec, rec.d.apply(ev.Board, false))
	r.emitBoard(rec)
}

// boardGone takes a board's removal on its server: the record goes, and the pages are told.
func (r *Relay) boardGone(entry string, raw json.RawMessage) {
	var ev struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &ev) != nil {
		return
	}
	if rec := r.boardOf(entry, ev.ID); rec != nil {
		r.removeBoard(rec)
	}
}

// adoptFrom makes the record of a board the entry's server tells of and this server has no
// record of: one an agent made there with create_board, or one whose creation answer was lost.
// Its place is the group of the record of the board it came from (Origin), else the ungrouped
// area. It sends no event. nil says that no record was made: the id has a record of another
// entry or is being created (makingBoard), or it cannot be a record's.
func (r *Relay) adoptFrom(entry string, v model.Board) *boardRecord {
	group := model.Ungrouped
	r.mu.Lock()
	taken := r.boards[v.ID] != nil || r.making[v.ID] > 0
	if origin := r.boards[v.Origin]; origin != nil && origin.entry == entry {
		group = origin.view().Group
	}
	r.mu.Unlock()
	if taken {
		return nil
	}
	rec, err := r.adoptBoard(BoardRecord{ID: v.ID, Entry: entry, Group: group, Archived: v.Archived, View: v})
	if err != nil {
		id := v.ID
		if len(id) > 64 {
			id = id[:64]
		}
		if r.tell("board " + id) {
			r.o.Logf("remotes: the board %q of the server %s gets no record here: %v", id, entry, err)
		}
		return nil
	}
	r.emitBoardChats(v.ID)
	return rec
}

// boardSnapshot is the board part of a snapshot, after the holds of the stream before were
// cleared (boardsNewStream) and the pages were told that the entry is back (server_back). raw is the snapshot. It runs on the entry's worker and does no I/O: what
// has to call the server is started by the hooks, in goroutines of their own.
//
//  1. Every board record of the entry takes the snapshot's board, where a pending archive
//     change stays; a record the snapshot lacks is marked gone; a board without a record is
//     adopted. A snapshot that names no boards at all (a server that does not serve them)
//     changes no record.
//  2. The tool calls that were open are dropped: the server has failed them itself.
//  3. The pages get the view of every record of the entry.
//  4. The archive changes that are not confirmed are passed on (boardsPending).
//  5. The pages that waited for a board there are told, and the boards that pages hold here
//     are taken there again (boardsBack).
func (r *Relay) boardSnapshot(entry string, raw json.RawMessage) {
	var snap struct {
		Boards *[]model.Board `json:"boards"`
	}
	if err := json.Unmarshal(raw, &snap); err != nil {
		r.o.Logf("remotes: the boards of the snapshot of the server %s cannot be read: %v", entry, err)
	} else if snap.Boards != nil {
		there := make(map[string]model.Board, len(*snap.Boards))
		for _, v := range *snap.Boards {
			there[v.ID] = v
		}
		for _, rec := range r.boardsOn(entry) {
			rec.mu.Lock()
			if !rec.removed {
				rec.applied++
				if v, ok := there[rec.id]; ok {
					r.keepBoard(rec, rec.d.apply(v, true))
				} else {
					durable := !rec.d.Gone
					rec.d.Gone = true
					r.keepBoard(rec, durable)
				}
			}
			rec.mu.Unlock()
			delete(there, rec.id)
		}
		for _, v := range *snap.Boards { // in the snapshot's order: a board comes after the one it came from
			if _, fresh := there[v.ID]; fresh {
				delete(there, v.ID)
				r.adoptFrom(entry, v)
			}
		}
	}
	r.dropBoardCalls(entry)
	for _, rec := range r.boardsOn(entry) {
		rec.mu.Lock()
		if !rec.removed {
			r.emitBoard(rec)
		}
		rec.mu.Unlock()
	}
	r.boardsPending(entry)
	r.boardsBack(entry)
}

// removedBoards is the board part of an entry's removal: its board records go with their files,
// and the pages are told. Relay.left has the entry already, so no record is adopted for it.
func (r *Relay) removedBoards(entry string) {
	for _, rec := range r.boardsOn(entry) {
		r.removeBoard(rec)
	}
}

// boardsDeletable is the board part of Deletable: a board record in one of the groups that is
// not gone and whose entry is not connected cannot be deleted on its server.
func (r *Relay) boardsDeletable(groups map[string]bool) error {
	for _, rec := range r.allBoards() {
		v := rec.view()
		if !groups[v.Group] || v.Gone || r.connected(rec.entry) {
			continue
		}
		name := v.Name
		if name == "" {
			name = "Untitled"
		}
		return &Error{Status: http.StatusConflict, Code: "server_unreachable", cause: ErrUnreachable,
			Text: fmt.Sprintf("Nothing was deleted: “%s” is on %s, which is not connected.", name, r.name(rec.entry))}
	}
	return nil
}

// ---- calls to a board's server ----

// errNoBoard is the cause of the answer for a board id without a record.
var errNoBoard = errors.New("no such board")

func noBoard() *Error {
	return &Error{Status: http.StatusNotFound, Text: errNoBoard.Error(), cause: errNoBoard}
}

// boardGoneThere is the answer for a board its server no longer has.
func (r *Relay) boardGoneThere(entry string) *Error {
	return &Error{Status: http.StatusNotFound, Code: "gone_there", Text: "This whiteboard is no longer on " + r.name(entry) + ".", cause: ErrGone}
}

// noSuchBoard reports whether the answer says that the server has no board with the id, or none
// that is this server's.
func noSuchBoard(rep servers.Reply) bool {
	return rep.Status == http.StatusNotFound && saidIn(rep).Error == errNoBoard.Error()
}

// doBoard passes a call for the board record on: method and rest ("" or "/…") after the board's
// path there. A nil error means that rep is the server's answer, to be read or handed on (see
// handed), whatever its status. Two answers are not handed on: 401, which is the entry's matter
// and not the board's (503 server_unreachable), and "no such board", which marks the record
// gone (404 gone_there). It takes no lock of the record but rec.mu, for the gone mark.
func (r *Relay) doBoard(ctx context.Context, rec *boardRecord, method, rest string, body []byte, limit time.Duration) (servers.Reply, *Error) {
	rep, err := r.call(ctx, rec.entry, method, boardPath(rec.id, rest), body, limit)
	switch {
	case err != nil:
		return rep, r.unmade(rec.entry, err)
	case rep.Status == http.StatusUnauthorized:
		return rep, r.unreachable(rec.entry)
	case noSuchBoard(rep):
		r.markBoardGone(rec)
		return rep, r.boardGoneThere(rec.entry)
	}
	return rep, nil
}
