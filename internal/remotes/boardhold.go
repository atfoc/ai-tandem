package remotes

// Who draws on a board that lives on another server, and its scene.
//
// The rule: this server's bridge alone decides which of its pages holds the board, and the relay
// keeps this server's hold on the board's server equal to "some page here holds it". This server
// is one client there, so that server never sees the pages.
//
// The take, the release and the re-take of one board are ordered by the record's holdMu, which
// is held across their calls to the board's server. What the record believes of that server
// (heldThere, want) is under the record's lock, so the events of the server's stream read and
// change it on the entry's worker with no call in between: what such an event has to ask of the
// server runs in a goroutine, under holdMu.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"time"

	"ai-whiteboard/internal/editorbridge"
)

// sceneRevHeader carries the scene's revision on the answer of a scene read.
const sceneRevHeader = "X-AIWB-Scene-Rev"

// boardHolds is what the hold chain keeps in the relay. Its zero value is ready.
type boardHolds struct {
	mu sync.Mutex
	// streams counts the snapshots of each entry: the streams this server had there. A hold
	// that a call was granted lasts as long as the stream the call was sent under, so an answer
	// that comes after the next snapshot tells nothing of the hold.
	streams map[string]uint64
}

// stream is the count of the entry's snapshots so far.
func (h *boardHolds) stream(entry string) uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.streams[entry]
}

// next counts a snapshot of the entry.
func (h *boardHolds) next(entry string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.streams == nil {
		h.streams = map[string]uint64{}
	}
	h.streams[entry]++
}

// roleEvent is a role event of the board as a page gets it.
func roleEvent(typ, board string) map[string]any {
	return map[string]any{"type": typ, "board": board}
}

func heldEvent(board string, rev int64) map[string]any {
	return map[string]any{"type": "held", "board": board, "rev": rev}
}

// seen keeps the scene revision n when it is above the one known: the revisions of a board only
// grow, and two answers may be taken in either order. The record's file gets it at the next
// flush, so that a take that is granted here alone after a restart names it. rec.mu held.
func (rec *boardRecord) seen(n int64) {
	if n <= rec.rev.Load() {
		return
	}
	rec.rev.Store(n)
	if !rec.removed {
		rec.d.Rev = n
		rec.dirty = true
	}
}

// sawRev is seen for a caller that does not hold rec.mu.
func (rec *boardRecord) sawRev(n int64) {
	rec.mu.Lock()
	rec.seen(n)
	rec.mu.Unlock()
}

// holdTries is the number of calls that are made in a row for a re-take or a release that gets
// no answer, each r.again after the one before, as for an archive change (archiveTries).
const holdTries = archiveTries

// boardArchivedThere is what a board's server says of a take of an archived board, with 409.
const boardArchivedThere = "the board is archived"

// takeState is the answer of a take: {"state":…}, with the revision for "held".
func takeState(state string, rev int64) Reply {
	if state == "held" {
		return jsonReply(http.StatusOK, map[string]any{"state": state, "rev": rev})
	}
	return jsonReply(http.StatusOK, map[string]any{"state": state})
}

func unknownClient() Reply {
	return jsonReply(http.StatusConflict, map[string]string{"error": editorbridge.ErrUnknownClient.Error()})
}

// TakeBoard is a page's take of the board.
//
// While a page of this server holds the board, the take is the bridge's alone: the hand-off
// between two pages changes nothing on the board's server. A free board is taken on its server
// first, for the page: "held" there gives the page the board here, "waiting" leaves the page as
// the one the server's held event is for. While the server is not connected a free board is
// granted here alone, and the return squares it (boardsBack).
func (r *Relay) TakeBoard(ctx context.Context, page, id string, ifFree bool) Reply {
	rec := r.boardRec(id)
	if rec == nil {
		return noBoard().Reply()
	}
	rec.holdMu.Lock()
	defer rec.holdMu.Unlock()
	if _, held := r.o.Bridge.HolderOf(id); held || !r.connected(rec.entry) {
		return r.takeHere(rec, page, ifFree, held)
	}
	if !r.o.Bridge.Known(page) {
		return unknownClient()
	}
	rec.mu.Lock()
	old := rec.want
	rec.want = page
	rec.mu.Unlock()
	if old != "" && old != page {
		r.o.Bridge.SendTo(old, roleEvent("superseded", id))
	}
	var body []byte
	if ifFree {
		body = []byte(`{"ifFree":true}`)
	}
	var ans struct {
		State string `json:"state"`
		Rev   int64  `json:"rev"`
	}
	for try := 0; ; try++ {
		stream := r.holds.stream(rec.entry)
		rep, e := r.doBoard(r.lasting(ctx), rec, http.MethodPost, "/take", body, r.o.Limits.Call)
		if e != nil {
			r.unwant(rec, page)
			switch {
			case errors.Is(e, ErrUnreachable): // nothing was sent: the server is not connected after all
				return r.takeHere(rec, page, ifFree, false)
			case errors.Is(e, ErrNoAnswer): // the server may have given the board
				r.spawn(func() { r.releaseUnused(rec, true, 1) })
			}
			return e.Reply()
		}
		if rep.Status != http.StatusOK {
			r.unwant(rec, page)
			return r.handed(rec.entry, rep)
		}
		ans.State, ans.Rev = "", 0
		if json.Unmarshal(rep.Body, &ans) != nil {
			r.unwant(rec, page)
			return r.badAnswer(rec.entry).Reply()
		}
		if ans.State != "held" || r.holdGranted(rec, stream, ans.Rev, page) {
			break
		}
		// A hold that was granted under a stream that ended since is no hold: asked once more,
		// and after that the take is one that got no answer.
		if try > 0 {
			r.unwant(rec, page)
			r.spawn(func() { r.releaseUnused(rec, true, 1) })
			return r.noAnswer(rec.entry).Reply()
		}
	}
	switch ans.State {
	case "held":
		state, _, err := r.o.Bridge.TakeBoard(page, id, false)
		if err != nil { // the page's stream ended meanwhile
			r.releaseThere(rec, 1)
			return unknownClient()
		}
		return takeState(state, rec.rev.Load())
	case "busy":
		r.unwant(rec, page)
		return takeState("busy", 0)
	case "waiting": // the page stays the one the server's held event is for
		return takeState("waiting", 0)
	}
	r.unwant(rec, page)
	return r.badAnswer(rec.entry).Reply()
}

// holdGranted takes the server's "held" at the revision rev, which answered a take that was sent
// under the entry's stream number stream: the record counts on the hold, unless that stream
// ended since. A snapshot counts its stream before it clears the holds (boardsNewStream), so the
// check and the hold are one step under rec.mu. page is the page whose wait there ends by it,
// "" for none.
func (r *Relay) holdGranted(rec *boardRecord, stream uint64, rev int64, page string) bool {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if r.holds.stream(rec.entry) != stream {
		return false
	}
	rec.seen(rev)
	rec.heldThere = true
	if page != "" && rec.want == page {
		rec.want = ""
	}
	return true
}

// takeHere is a take that this server's bridge answers alone: a page here holds the board
// (held), or the board's server is not connected. rec.holdMu held.
//
// The server may have connected since the caller looked, with a snapshot that found no page
// holding the board yet: the board is then taken there in a goroutine, as at a return.
func (r *Relay) takeHere(rec *boardRecord, page string, ifFree, held bool) Reply {
	state, _, err := r.o.Bridge.TakeBoard(page, rec.id, ifFree)
	if err != nil {
		return unknownClient()
	}
	if !held { // no page waits on a server that is not connected
		rec.mu.Lock()
		old := rec.want
		rec.want = ""
		rec.mu.Unlock()
		if old != "" && old != page {
			r.o.Bridge.SendTo(old, roleEvent("superseded", rec.id))
		}
		if r.connected(rec.entry) {
			r.spawn(func() { r.retake(rec) })
		}
	}
	return takeState(state, rec.rev.Load())
}

// unwant ends the page's wait for the board on its server, unless another page waits by now.
func (r *Relay) unwant(rec *boardRecord, page string) {
	rec.mu.Lock()
	if rec.want == page {
		rec.want = ""
	}
	rec.mu.Unlock()
}

// releaseThere releases the board on its server and reports whether the server handed it to
// somebody who waited there. Whatever comes of the call, this server no longer counts on the
// hold. rec.holdMu held.
//
// With no answer the server may still count this one as the holder, for as long as the stream
// lasts. So while the entry stays connected the release is made again after r.again, in the
// background, if no page here holds the board or waits for it by then: holdTries calls in a
// row at most, of which this one is number try.
func (r *Relay) releaseThere(rec *boardRecord, try int) (handed bool) {
	rec.mu.Lock()
	rec.heldThere = false
	rec.mu.Unlock()
	rep, e := r.doBoard(r.ctx, rec, http.MethodPost, "/release", nil, r.o.Limits.Unfollow)
	if e != nil && errors.Is(e, ErrNoAnswer) && try < holdTries && r.connected(rec.entry) {
		r.spawn(func() {
			if r.waitAgain(rec.entry) {
				r.releaseUnused(rec, true, try+1)
			}
		})
	}
	if e != nil || rep.Status != http.StatusOK {
		return false
	}
	var ans struct {
		State string `json:"state"`
	}
	_ = json.Unmarshal(rep.Body, &ans)
	return ans.State == "handed"
}

// releaseUnused releases the board on its server when no page here holds it or waits for it
// there. It is for a goroutine: it waits for the take or the release that is running. Without
// force it does so only for a board this server believes it holds there; with force also for
// one the server has told is this server's. try is the number of the release: see releaseThere.
func (r *Relay) releaseUnused(rec *boardRecord, force bool, try int) {
	rec.holdMu.Lock()
	defer rec.holdMu.Unlock()
	if _, held := r.o.Bridge.HolderOf(rec.id); held {
		return
	}
	rec.mu.Lock()
	unused := rec.want == "" && (force || rec.heldThere) && !rec.removed
	rec.mu.Unlock()
	if unused {
		r.releaseThere(rec, try)
	}
}

// waitAgain waits r.again and reports whether the entry is connected after it, and the relay
// not closed. It is for a goroutine of spawn.
func (r *Relay) waitAgain(entry string) bool {
	select {
	case <-r.ctx.Done():
		return false
	case <-time.After(r.again):
	}
	return r.connected(entry)
}

// ReleaseBoard is a page's release of the board. The board's server is told only when the
// release left the board with no page here: it then is released there too, and when that server
// handed it to somebody who waited there, the page is sent superseded, as by a hand-off here.
func (r *Relay) ReleaseBoard(ctx context.Context, page, id string) Reply {
	rec := r.boardRec(id)
	if rec == nil {
		return noBoard().Reply()
	}
	rec.holdMu.Lock()
	defer rec.holdMu.Unlock()
	state := r.o.Bridge.ReleaseBoard(page, id)
	if state == "free" {
		rec.mu.Lock()
		there := rec.heldThere
		rec.mu.Unlock()
		if there && r.releaseThere(rec, 1) {
			r.o.Bridge.SendTo(page, roleEvent("superseded", id))
			state = "handed"
		}
	}
	return jsonReply(http.StatusOK, map[string]string{"state": state})
}

// BoardFree is the function for Bridge.OnBoardFree: a board ended with no holder here. The tool
// calls that wait for a page that no longer holds the board fail, and a board that is still
// free here is released on its server.
func (r *Relay) BoardFree(board string) {
	rec := r.boardRec(board)
	if rec == nil {
		return
	}
	holder, _ := r.o.Bridge.HolderOf(board)
	r.failBoardCalls(board, holder)
	r.releaseUnused(rec, false, 1)
}

// boardRoleEvent takes held, release_request and superseded of the entry's server, as they
// came. It is called on the entry's worker and must not call the server itself.
func (r *Relay) boardRoleEvent(entry, typ string, raw json.RawMessage) {
	var ev struct {
		Board string `json:"board"`
		Rev   int64  `json:"rev"`
	}
	if json.Unmarshal(raw, &ev) != nil {
		return
	}
	rec := r.boardOf(entry, ev.Board)
	if rec == nil {
		return
	}
	release := false
	rec.mu.Lock()
	holder, held := r.o.Bridge.HolderOf(rec.id)
	switch typ {
	case "held":
		rec.seen(ev.Rev)
		switch {
		case rec.removed:
		case held: // the server tells the revision again
			rec.heldThere = true
			r.o.Bridge.SendTo(holder, heldEvent(rec.id, ev.Rev))
		case rec.want != "": // the hand-off there ended: the page that waited gets the board
			page := rec.want
			rec.want = ""
			state, _, err := r.o.Bridge.TakeBoard(page, rec.id, false)
			if err != nil { // the page is gone
				release = true
				break
			}
			rec.heldThere = true
			if state == "held" { // else a page took the board here meanwhile, and the bridge hands it over
				r.o.Bridge.SendTo(page, heldEvent(rec.id, ev.Rev))
			}
		default:
			release = true
		}
	case "release_request":
		if held {
			// The page flushes and releases here, which releases there.
			r.o.Bridge.SendTo(holder, roleEvent("release_request", rec.id))
		} else {
			release = true
		}
	case "superseded":
		rec.heldThere = false
		if held {
			r.o.Bridge.LoseBoard(rec.id) // the holder, and a page that waits for it here, get superseded
		}
		if rec.want != "" {
			r.o.Bridge.SendTo(rec.want, roleEvent("superseded", rec.id))
			rec.want = ""
		}
	}
	rec.mu.Unlock()
	if release {
		r.spawn(func() { r.releaseUnused(rec, true, 1) })
	}
}

// boardsNewStream is the first step of a snapshot for the boards: the entry's server holds
// nothing for this one on its new stream. The stream is counted first and the holds are cleared
// after, so a "held" that was asked under the stream before is never counted on (holdGranted).
// It is called on the entry's worker, before the pages are told that the entry is back: a save
// that a page sends on that news meets no hold of the stream before.
func (r *Relay) boardsNewStream(entry string) {
	r.holds.next(entry)
	for _, rec := range r.boardsOn(entry) {
		rec.mu.Lock()
		rec.heldThere = false
		rec.mu.Unlock()
	}
}

// boardsBack is the last step of the board part of a snapshot. It is called on the entry's
// worker, after the pages got the records' views, and must not call the server itself.
//
// No page waits there any more: the stream it waited under ended. Each board a page here holds
// is taken there again, if free, in a goroutine.
func (r *Relay) boardsBack(entry string) {
	for _, rec := range r.boardsOn(entry) {
		rec.mu.Lock()
		if rec.want != "" {
			r.o.Bridge.SendTo(rec.want, roleEvent("superseded", rec.id))
			rec.want = ""
		}
		rec.mu.Unlock()
		if _, held := r.o.Bridge.HolderOf(rec.id); held {
			r.spawn(func() { r.retake(rec) })
		}
	}
}

// retakeOnSave starts the re-take of the board for a save that found the board not held on its
// server: one at a time for a record, with its repeats, however many saves ask.
func (r *Relay) retakeOnSave(rec *boardRecord) {
	if !rec.retaking.CompareAndSwap(false, true) {
		return
	}
	if !r.spawn(func() {
		defer rec.retaking.Store(false)
		r.retake(rec)
	}) {
		rec.retaking.Store(false)
	}
}

// retake takes the board on its server again, if it is free there, for the page that holds it
// here: see retakeOnce. A take that told nothing is made again after r.again while the entry
// stays connected, holdTries calls in a row at most; after that the next save of the page, or
// the next snapshot, starts it anew. It is for a goroutine of spawn: the record's hold lock is
// not held while it waits.
func (r *Relay) retake(rec *boardRecord) {
	for try := 1; r.retakeOnce(rec) && try < holdTries; try++ {
		if !r.connected(rec.entry) || !r.waitAgain(rec.entry) {
			return // the next snapshot takes it
		}
	}
}

// retakeOnce is one take of retake, and reports whether it is to be made again. "held" is
// passed to the page with the server's revision, which lets the page decide: at the revision
// its edit is based on it saves, at another it drops the edit. A board that is held there by
// another, or is archived or gone, is taken from the page. Every other end tells nothing of the
// board, the server's unknown_client among them (this server's stream there is not open at that
// moment): all stays as it is, and the take is to be made again.
func (r *Relay) retakeOnce(rec *boardRecord) (again bool) {
	rec.holdMu.Lock()
	defer rec.holdMu.Unlock()
	for try := 0; try < 2; try++ {
		if _, held := r.o.Bridge.HolderOf(rec.id); !held {
			return false
		}
		rec.mu.Lock()
		done := rec.heldThere || rec.removed
		rec.mu.Unlock()
		if done {
			return false
		}
		stream := r.holds.stream(rec.entry)
		rep, e := r.doBoard(r.ctx, rec, http.MethodPost, "/take", []byte(`{"ifFree":true}`), r.o.Limits.Call)
		if e != nil {
			if errors.Is(e, ErrGone) {
				r.o.Bridge.LoseBoard(rec.id)
			}
			return errors.Is(e, ErrNoAnswer)
		}
		var ans struct {
			State string `json:"state"`
			Rev   int64  `json:"rev"`
		}
		_ = json.Unmarshal(rep.Body, &ans)
		switch {
		case rep.Status == http.StatusOK && ans.State == "held":
			if !r.holdGranted(rec, stream, ans.Rev, "") {
				continue // granted under a stream that ended since
			}
			// The holder as it is now: the board may have gone to another page here. If no
			// page is left, BoardFree waits for holdMu and releases.
			if page, held := r.o.Bridge.HolderOf(rec.id); held {
				r.o.Bridge.SendTo(page, heldEvent(rec.id, ans.Rev))
			}
			return false
		case rep.Status == http.StatusOK && ans.State == "busy",
			rep.Status == http.StatusConflict && saidIn(rep).Error == boardArchivedThere:
			r.o.Bridge.LoseBoard(rec.id)
			return false
		default:
			return true
		}
	}
	return true
}

// Scene reads the board's scene from its server, with its revision.
func (r *Relay) Scene(ctx context.Context, id string) (body []byte, rev int64, e *Error) {
	rec := r.boardRec(id)
	if rec == nil {
		return nil, 0, noBoard()
	}
	rep, e := r.doBoard(ctx, rec, http.MethodGet, "/scene", nil, r.o.Limits.Scene)
	if e != nil {
		return nil, 0, e
	}
	if rep.Status != http.StatusOK {
		return nil, 0, r.errorOf(rec.entry, rep)
	}
	rev, err := strconv.ParseInt(rep.Header.Get(sceneRevHeader), 10, 64)
	if err != nil || rev < 0 {
		return nil, 0, r.badAnswer(rec.entry)
	}
	rec.sawRev(rev)
	return rep.Body, rev, nil
}

// notHolder is the refusal of a scene write by a page that does not hold the board.
func notHolder(text string) Reply {
	return (&Error{Status: http.StatusConflict, Code: "not_holder", Text: text}).Reply()
}

// notHeldThere is the refusal of a save while this server does not hold the board on its
// server. It is a 503: the page keeps its edit, and the held event of the re-take decides.
func (r *Relay) notHeldThere(entry string) Reply {
	return (&Error{Status: http.StatusServiceUnavailable, Code: "not_held_there",
		Text: "The board is being taken again on " + r.name(entry) + "."}).Reply()
}

// SaveScene passes the scene the page saves at the revision base on. Only the page that holds
// the board here may save, and only while this server holds the board on its server: after the
// return of that server the board is first taken there again. The page keeps its edit after any
// 503. The server checks the holder and the revision itself, and its answer is the page's.
//
// But for one answer: "not_holder" there means that this server lost the hold and has not
// learnt of it yet (its stream there ended), not that the page lost the board, so the page gets
// the 503 of a board that is not held there. That refusal starts the re-take, whose end tells
// the page by the revision, or by superseded, what becomes of its edit.
func (r *Relay) SaveScene(ctx context.Context, page, id string, base int64, body []byte) Reply {
	rec := r.boardRec(id)
	if rec == nil {
		return noBoard().Reply()
	}
	switch holder, held := r.o.Bridge.HolderOf(id); {
	case !held:
		return notHolder("this window does not hold the board")
	case holder != page:
		return notHolder("another window holds this board")
	}
	if base < 0 {
		return jsonReply(http.StatusBadRequest, map[string]string{"error": "rev is not a number"})
	}
	if !r.connected(rec.entry) {
		return r.unreachable(rec.entry).Reply()
	}
	rec.mu.Lock()
	there := rec.heldThere
	rec.mu.Unlock()
	if !there {
		r.retakeOnSave(rec)
		return r.notHeldThere(rec.entry)
	}
	stream := r.holds.stream(rec.entry)
	rep, e := r.doBoard(r.lasting(ctx), rec, http.MethodPut, "/scene?rev="+strconv.FormatInt(base, 10), body, r.o.Limits.Scene)
	if e != nil {
		return e.Reply()
	}
	if rep.Status == http.StatusOK {
		var ans struct {
			Rev int64 `json:"rev"`
		}
		if json.Unmarshal(rep.Body, &ans) == nil {
			rec.sawRev(ans.Rev)
		}
		// The board may have gone to another page here since the check above, with a grant
		// that named the revision before this write: that holder is told the new one.
		r.o.Bridge.Regrant(id, page)
	}
	if rep.Status == http.StatusConflict && saidIn(rep).Code == "not_holder" {
		rec.mu.Lock()
		if r.holds.stream(rec.entry) == stream { // else the hold is one of a newer stream
			rec.heldThere = false
		}
		rec.mu.Unlock()
		r.retakeOnSave(rec)
		return r.notHeldThere(rec.entry)
	}
	return r.handed(rec.entry, rep)
}
