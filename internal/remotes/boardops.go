package remotes

// The operations of a page on a board that lives on another server: its creation, its name,
// its place here, its archive mark and its end. The rules of the archive mark are a run
// record's (see runarchive.go): the mark is the board's server's (BoardRecord.Archived, as last
// received); a change made here is recorded first (BoardRecord.Pending) and shows at once; then
// it is passed on. The chats on the board are archived, brought back and deleted by the board's
// server: their records follow that server's events.
//
// A call that is passed on and cannot be made is answered as doBoard says (boardrelay.go).

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
)

// ErrNoBoard is the cause of the answer for a board id without a record.
var ErrNoBoard = errNoBoard

// boardOps is what the operations on a board keep in the relay. Its zero value is ready.
type boardOps struct {
	mu      sync.Mutex
	local   func(id string) bool // whether a board of this server has the id; nil: none has
	archive idLocks              // the passing on of a board record's archive change: one at a time, in order
}

// SetLocalBoards gives the relay the boards of this server: has reports whether one of them has
// the id, so that a board made on another server gets an id none of them has. It is called
// before the server list starts.
func (r *Relay) SetLocalBoards(has func(id string) bool) {
	r.bops.mu.Lock()
	defer r.bops.mu.Unlock()
	r.bops.local = has
}

// newBoardID makes the id of a new board: one that no board of this server and no record has.
func (r *Relay) newBoardID() string {
	r.bops.mu.Lock()
	local := r.bops.local
	r.bops.mu.Unlock()
	for {
		id := model.NewID("b_")
		if validBoardID(id) && !r.HasBoard(id) && (local == nil || !local(id)) {
			return id
		}
	}
}

// noBoards is the answer for a server that has no board routes: the 404 of a route that is not
// there.
func (r *Relay) noBoards(entry string) *Error {
	return &Error{Status: http.StatusBadGateway, Code: "no_boards", Text: r.name(entry) + " does not serve boards. Update it."}
}

// CreateBoard makes a board on the server entry and its record in the local group. This server
// makes the id, and the board has the same one there. The entry must be connected (503
// server_unreachable, nothing is made). A creation call that gets no answer is made once more,
// within Limits.Settle: it is safe, since the server answers a repeat with the board as it is.
// Still none is 504 no_answer and no record; a board that was made all the same gets its record
// from the server's next event or snapshot, in the ungrouped area. An id the server refuses as
// taken (409 id_taken) is replaced once. A server without board routes is 502 no_boards. Any
// other refusal is the server's, with its status, text and code. The answer is the record's
// view; the pages got it as a board event before.
func (r *Relay) CreateBoard(ctx context.Context, entry, name, group string) (model.Board, *Error) {
	if e := r.groupFor(group); e != nil {
		return model.Board{}, e
	}
	if v, ok := r.o.Servers.View(entry); !ok || v.Local {
		return model.Board{}, &Error{Status: http.StatusBadRequest, Text: chats.ErrServerUnknown.Error(), cause: chats.ErrServerUnknown}
	}
	if !r.connected(entry) {
		return model.Board{}, r.unreachable(entry)
	}
	body, _ := json.Marshal(map[string]string{"name": name})
	for try := 0; ; try++ {
		v, taken, e := r.createCall(r.lasting(ctx), entry, r.newBoardID(), group, body)
		if taken && try == 0 {
			continue // one new id
		}
		return v, e
	}
}

// createCall makes the creation call for the board id and, when it made the board, the record.
// taken says that the server refused the id as taken: e is that answer.
func (r *Relay) createCall(ctx context.Context, entry, id, group string, body []byte) (v model.Board, taken bool, e *Error) {
	// Until the record is made, the board's event from the server adopts nothing: it can
	// overtake the answer.
	done := r.makingBoard(id)
	defer done()
	rep, err := r.call(ctx, entry, http.MethodPut, boardPath(id, ""), body, r.o.Limits.Call)
	if errors.Is(err, ErrNoAnswer) {
		rep, err = r.call(ctx, entry, http.MethodPut, boardPath(id, ""), body, r.o.Limits.Settle)
	}
	switch {
	case err != nil:
		return v, false, r.unmade(entry, err)
	case rep.Status == http.StatusUnauthorized:
		return v, false, r.unreachable(entry)
	case noRunRoutes(rep):
		return v, false, r.noBoards(entry)
	case rep.Status == http.StatusConflict && saidIn(rep).Code == "id_taken":
		return v, true, r.errorOf(entry, rep)
	case rep.Status != http.StatusOK:
		return v, false, r.errorOf(entry, rep)
	}
	var ans struct {
		Board *model.Board `json:"board"`
	}
	if json.Unmarshal(rep.Body, &ans) != nil || ans.Board == nil || ans.Board.ID != id {
		return v, false, r.badAnswer(entry)
	}
	rec, aerr := r.adoptBoard(BoardRecord{ID: id, Entry: entry, Group: group, Archived: ans.Board.Archived, View: *ans.Board})
	switch {
	case errors.Is(aerr, errNoEntry):
		return v, false, r.unreachable(entry) // the entry was removed meanwhile
	case aerr != nil:
		r.o.Logf("remotes: the board %s was made on the server %s and gets no record: %v", id, entry, aerr)
		return v, false, &Error{Status: http.StatusInternalServerError, Text: "the board's record could not be made: " + aerr.Error()}
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if !rec.removed {
		r.emitBoard(rec)
	}
	return boardViewOf(rec.d), false, nil
}

// boardReply is 200 with the record's view, as a page gets it.
func (r *Relay) boardReply(rec *boardRecord) Reply {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return jsonReply(http.StatusOK, boardViewOf(rec.d))
}

// RenameBoard serves POST /api/boards/{id}/rename; body is the request's JSON, passed on. The
// name is the board's server's: while that server is not connected the rename is refused (503
// server_unreachable). The record takes the answer's board, and the answer is the record's
// view. The call is not ended by the page that asked.
func (r *Relay) RenameBoard(ctx context.Context, id string, body []byte) Reply {
	rec := r.boardRec(id)
	if rec == nil {
		return noBoard().Reply()
	}
	since := rec.stamp()
	rep, e := r.doBoard(r.lasting(ctx), rec, http.MethodPost, "/rename", body, r.o.Limits.Call)
	switch {
	case e != nil:
		return e.Reply()
	case rep.Status != http.StatusOK:
		return r.handed(rec.entry, rep)
	}
	var v model.Board
	if json.Unmarshal(rep.Body, &v) != nil || v.ID != id {
		return r.badAnswer(rec.entry).Reply()
	}
	r.takeBoardView(rec, since, v)
	return r.boardReply(rec)
}

// MoveBoard puts the board record in the group, its place in this server's sidebar, and tells
// the pages. The group is not checked: PatchBoard does that for a page's move, and the delete
// of a group moves its records to the parent with this. Nothing is sent to the board's server,
// so it works while that server is not connected.
func (r *Relay) MoveBoard(id, group string) error {
	rec := r.boardRec(id)
	if rec == nil {
		return noBoard()
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed {
		return noBoard()
	}
	if rec.d.Group != group {
		rec.d.Group = group
		r.keepBoard(rec, true)
		r.emitBoard(rec)
	}
	return nil
}

// PatchBoard serves PATCH /api/boards/{id} for a board record: the group is the board's place
// here. It must exist and not be archived.
func (r *Relay) PatchBoard(id, group string) Reply {
	if !r.HasBoard(id) {
		return noBoard().Reply()
	}
	if e := r.groupFor(group); e != nil {
		return e.Reply()
	}
	return ReplyOf(r.MoveBoard(id, group))
}

// ArchiveBoard archives the record's board: by the user, or as part of the archive action op of
// a group ("" makes a new id). The mark shows at once, and the change is passed on to the
// board's server when it is connected; else, or without an answer, it stays pending and nil is
// returned all the same. A record that is archived already keeps its mark and its action. The
// error is an *Error: 404 "no such board" for no record, or what the server refused the change
// with, which is then undone here.
func (r *Relay) ArchiveBoard(ctx context.Context, id, op string) error {
	if op == "" {
		op = model.NewID("a_")
	}
	return r.setBoardArchived(ctx, id, pendingArchive, op)
}

// UnarchiveBoard is ArchiveBoard's reverse, with the same rules.
func (r *Relay) UnarchiveBoard(ctx context.Context, id string) error {
	return r.setBoardArchived(ctx, id, pendingUnarchive, "")
}

func (r *Relay) setBoardArchived(ctx context.Context, id, change, op string) error {
	rec := r.boardRec(id)
	if rec == nil {
		return noBoard()
	}
	rec.mu.Lock()
	if rec.removed {
		rec.mu.Unlock()
		return noBoard()
	}
	if boardViewOf(rec.d).Archived != (change == pendingArchive) {
		rec.d.Pending, rec.d.Op = change, op
		r.keepBoard(rec, true)
		r.emitBoard(rec)
	}
	rec.lost = 0 // the user's action is tried anew
	rec.mu.Unlock()
	if err := r.passBoardArchive(ctx, rec); err != nil {
		return err
	}
	return nil
}

// BoardsArchivedWith are the ids of the board records that the archive action op archived and
// that are still archived by it, sorted: what a group's unarchive brings back. A mark that was
// made on the board's own server belongs to no action here.
func (r *Relay) BoardsArchivedWith(op string) []string {
	ids := []string{}
	if op == "" {
		return ids
	}
	for _, rec := range r.allBoards() {
		if v := rec.view(); v.Archived && v.Op == op {
			ids = append(ids, rec.id)
		}
	}
	return ids
}

// passBoardArchive passes the board record's pending archive change on, if it has one. One runs
// at a time per record, and each sends what is pending when its turn comes, so the server gets
// the changes in the order they were made. nil is returned when the change was confirmed, and
// when it stays pending: the entry is not connected, did not answer, or cannot say (401, a
// 5xx). Any other refusal undoes the change here and is returned. A call that got no answer is
// made again in the background while the entry stays connected (see boardArchiveLost).
func (r *Relay) passBoardArchive(ctx context.Context, rec *boardRecord) *Error {
	defer r.bops.archive.lock(rec.id)()
	rec.mu.Lock()
	change, gone := rec.d.Pending, rec.d.Gone || rec.removed
	rec.mu.Unlock()
	if change == "" || gone {
		return nil // nothing to pass on, or nowhere: a gone board's change waits for its return
	}
	rep, err := r.call(ctx, rec.entry, http.MethodPost, boardPath(rec.id, "/"+change), nil, r.o.Limits.Call)
	r.boardArchiveLost(rec, err)
	if err != nil {
		return nil
	}
	var refused *Error
	switch {
	case rep.Status == http.StatusOK:
	case noSuchBoard(rep):
		r.markBoardGone(rec)
		return nil
	case rep.Status == http.StatusUnauthorized || rep.Status >= 500:
		r.o.Logf("remotes: the %s of the board %s stays pending: its server answered %d", change, rec.id, rep.Status)
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
	r.keepBoard(rec, true)
	r.emitBoard(rec)
	return refused
}

// boardArchiveLost takes the end of an archive call of the board record, err being what call
// returned: with no answer on an entry that is still connected the change is passed on again
// after Limits.Call, in the background, archiveTries calls in a row at most (see archiveLost).
func (r *Relay) boardArchiveLost(rec *boardRecord, err error) {
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
		case <-time.After(r.again):
		}
		if !r.connected(rec.entry) {
			return // the next connect passes it on
		}
		if e := r.passBoardArchive(r.ctx, rec); e != nil {
			r.o.Logf("remotes: the archive change of the board %s was refused by its server: %v", rec.id, e)
		}
	})
}

// boardsPending is step 4 of the board part of a snapshot: the archive changes of the entry's
// board records that are not confirmed are passed on. It is called on the entry's worker and
// must not call the server itself: it starts a goroutine (Relay.spawn) for that.
func (r *Relay) boardsPending(entry string) {
	r.spawn(func() { r.passPendingBoards(r.ctx, entry) })
}

func (r *Relay) passPendingBoards(ctx context.Context, entry string) {
	for _, rec := range r.boardsOn(entry) {
		if ctx.Err() != nil {
			return
		}
		rec.mu.Lock()
		rec.lost = 0 // a connect: tried anew
		rec.mu.Unlock()
		if e := r.passBoardArchive(ctx, rec); e != nil {
			r.o.Logf("remotes: the archive change of the board %s was refused by its server: %v", rec.id, e)
		}
	}
}

// DeleteBoard deletes the record's board on its server, and the record with it: the records of
// the chats on the board go first, each with its chat_removed, then the pages get
// board_removed. A record that is gone is removed with no call, and so is one whose server
// answers that it has no such board. An entry that is not connected is 503 server_unreachable,
// and the record stays; no answer is 504, and the record stays too: if that server deleted the
// board all the same, its board_removed removes the record.
//
// With localOnly ("Remove from this sidebar") the records alone are removed and nothing is
// sent. That is accepted when the entry is not connected or the board is gone there; else it is
// 409 server_connected. The error is an *Error.
func (r *Relay) DeleteBoard(ctx context.Context, id string, localOnly bool) error {
	rec := r.boardRec(id)
	if rec == nil {
		return noBoard()
	}
	switch {
	case rec.view().Gone:
	case localOnly:
		if r.connected(rec.entry) {
			return &Error{Status: http.StatusConflict, Code: "server_connected",
				Text: r.name(rec.entry) + " is connected: delete the whiteboard there.", cause: ErrConnected}
		}
	default:
		rep, e := r.doBoard(r.lasting(ctx), rec, http.MethodDelete, "", nil, r.o.Limits.Call)
		switch {
		case e != nil && errors.Is(e, ErrGone): // not there: only the record is left to remove
		case e != nil:
			return e
		case rep.Status != http.StatusOK:
			return r.errorOf(rec.entry, rep)
		}
	}
	for _, c := range r.all() {
		c.mu.Lock()
		if !c.removed && c.entry == rec.entry && c.d.View.Board == id {
			r.drop(c)
			r.emitRemoved(c.id)
		}
		c.mu.Unlock()
	}
	r.removeBoard(rec)
	// A page that drew on the board holds nothing from here on.
	r.o.Bridge.LoseBoard(id)
	return nil
}

// SeenBoard serves POST /api/boards/{id}/seen: that the user has opened the board is passed on.
func (r *Relay) SeenBoard(ctx context.Context, id string) Reply {
	rec := r.boardRec(id)
	if rec == nil {
		return noBoard().Reply()
	}
	rep, e := r.doBoard(ctx, rec, http.MethodPost, "/seen", nil, r.o.Limits.Call)
	if e != nil {
		return e.Reply()
	}
	return r.handed(rec.entry, rep)
}
