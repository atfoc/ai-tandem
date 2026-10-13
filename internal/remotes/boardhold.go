package remotes

// Who draws on a board of a section, and its drawing.
//
// The rule: this server's bridge alone decides which of its pages holds the board, and the relay
// keeps this server's hold on the board's server equal to "some page here holds it". This server
// is one client there, so that server never sees the pages. The bridge names the board by the
// entry's id and the board's (editorbridge.BoardOn), and so does everything here: a board of one
// section and a board of another, or of this server, with the same id are not the same board.
//
// What the relay keeps of a board is in memory alone (board), and outlives the entry's tree: a
// page that holds a board when its server drops keeps holding it here, and when the tree is back
// the board is taken there again for that page (boardsBack).
//
// The take, the release and the re-take of one board are ordered by the board's holdMu, which
// is held across their calls to the board's server. What the relay believes of that server
// (heldThere, want) is under the board's lock, so the events of the server's stream read and
// change it on the entry's worker with no call in between: what such an event has to ask of the
// server runs in a goroutine, under holdMu.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"ai-whiteboard/internal/editorbridge"
)

// SceneRevHeader carries the drawing's revision on the answer of a read of it.
const SceneRevHeader = "X-AIWB-Scene-Rev"

// holdTries is the number of calls that are made in a row for a re-take or a release that gets
// no answer, each Relay.again after the one before.
const holdTries = 3

// boardArchivedThere is what a board's server says of a take of an archived board, with 409.
const boardArchivedThere = "the board is archived"

// board is what the relay keeps of one board of a section, from the first take of it by a page
// here until its entry is removed.
type board struct {
	entry, id string
	key       string // editorbridge.BoardOn(entry, id): the board's name in the bridge

	// holdMu orders the take, the release and the re-take of the board: it is held across those
	// calls to the board's server. It is taken before mu.
	holdMu sync.Mutex

	// mu guards what this server believes of the board's hold on its server. It is held over no
	// call to that server, so an event of the server's stream reads the fields without waiting
	// for one.
	mu        sync.Mutex
	heldThere bool   // this server holds the board there
	want      string // the page whose take waits there; "" for none
	removed   bool   // the board's entry was removed: nothing more is asked or sent for it

	// rev is the last revision of the drawing known of the board's server; 0 for none. It is read
	// and written with no lock.
	rev atomic.Int64

	retaking atomic.Bool // a re-take that a save started is running (see retakeOnSave)
}

// seen keeps the revision n when it is above the one known: the revisions of a board only grow,
// and two answers may be taken in either order.
func (b *board) seen(n int64) {
	for {
		old := b.rev.Load()
		if n <= old || b.rev.CompareAndSwap(old, n) {
			return
		}
	}
}

// boardOf is what the relay keeps of the board id of the section entry, nil for nothing.
func (r *Relay) boardOf(entry, id string) *board {
	if v, ok := r.boards.Load(editorbridge.BoardOn(entry, id)); ok {
		return v.(*board)
	}
	return nil
}

// boardFor is boardOf for a board that is about to be taken: what is kept of it begins here.
func (r *Relay) boardFor(entry, id string) *board {
	key := editorbridge.BoardOn(entry, id)
	v, _ := r.boards.LoadOrStore(key, &board{entry: entry, id: id, key: key})
	return v.(*board)
}

// boardsOn are the boards of the entry the relay keeps something of.
func (r *Relay) boardsOn(entry string) []*board {
	var out []*board
	r.boards.Range(func(_, v any) bool {
		if b := v.(*board); b.entry == entry {
			out = append(out, b)
		}
		return true
	})
	return out
}

// BoardRev is the last revision of the drawing known of the server of the board with this key
// (editorbridge.BoardOn), 0 when none is known yet. ok is false for a board the relay keeps
// nothing of. It takes no lock: it is the bridge's SceneRev for a board of a section, which the
// bridge calls with its own lock held.
func (r *Relay) BoardRev(key string) (rev int64, ok bool) {
	v, ok := r.boards.Load(key)
	if !ok {
		return 0, false
	}
	return v.(*board).rev.Load(), true
}

// roleEvent is a role event of the board id of the section entry as a page gets it: the shape of
// the bridge's own for such a board.
func roleEvent(typ, entry, id string) map[string]any {
	return map[string]any{"type": typ, "server": entry, "board": id}
}

func heldEvent(entry, id string, rev int64) map[string]any {
	return map[string]any{"type": "held", "server": entry, "board": id, "rev": rev}
}

// tellBoard sends a role event of the board to one page.
func (r *Relay) tellBoard(b *board, page, typ string) {
	r.o.Bridge.SendTo(page, roleEvent(typ, b.entry, b.id))
}

// tellHeld sends the page that holds the board here its held event, at the revision rev.
func (r *Relay) tellHeld(b *board, page string, rev int64) {
	r.o.Bridge.SendTo(page, heldEvent(b.entry, b.id, rev))
}

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

// TakeBoard serves POST …/boards/{id}/take for a board of the section entry: the page's take.
// The answer is 200 {"state":"held"|"waiting"|"busy","rev"?}, as for a board of this server.
//
// While a page of this server holds the board, the take is the bridge's alone: the hand-over
// between two pages changes nothing on the board's server. Otherwise the board is taken on its
// server, for the page: "held" there gives the page the board here, at that server's revision,
// "busy" is the page's answer, and "waiting" leaves the page as the one that server's later held
// or superseded is for.
//
// While the relay holds no tree of the entry nothing is taken, here or there: 503
// server_unreachable (404 no_server for no entry). A page with no stream here is 409
// "unknown_client". A refusal of that server is the page's as it came, a 404 not_found for a
// board that is gone among them; 504 no_answer and 502 bad_answer are as for Pass. The take is
// not ended by the page that asked: what that server grants must be taken here.
func (r *Relay) TakeBoard(entry, page, id string, ifFree bool) Reply {
	if e := r.Ready(entry); e != nil {
		return e.Reply()
	}
	b := r.boardFor(entry, id)
	b.holdMu.Lock()
	defer b.holdMu.Unlock()
	if _, held := r.o.Bridge.HolderOf(b.key); held {
		state, _, err := r.o.Bridge.TakeBoard(page, b.key, ifFree)
		if err != nil {
			return unknownClient()
		}
		return takeState(state, b.rev.Load())
	}
	if !r.o.Bridge.Known(page) {
		return unknownClient()
	}
	b.mu.Lock()
	old := b.want
	b.want = page
	b.mu.Unlock()
	if old != "" && old != page {
		r.tellBoard(b, old, "superseded")
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
		stream := r.stream(entry)
		rep, e := r.do(r.ctx, entry, http.MethodPost, boardPath(id, "/take"), body, r.o.Limits.Call)
		if e != nil {
			r.unwant(b, page)
			if errors.Is(e, ErrNoAnswer) { // the server may have given the board
				r.spawn(func() { r.releaseUnused(b, true, 1) })
			}
			return e.Reply()
		}
		if rep.Status != http.StatusOK {
			r.unwant(b, page)
			return r.handed(entry, rep)
		}
		ans.State, ans.Rev = "", 0
		if json.Unmarshal(rep.Body, &ans) != nil {
			r.unwant(b, page)
			return r.badAnswer(entry).Reply()
		}
		if ans.State != "held" || r.holdGranted(b, stream, ans.Rev, page) {
			break
		}
		// A hold that was granted under a stream that ended since is no hold: asked once more,
		// and after that the take is one that got no answer.
		if try > 0 {
			r.unwant(b, page)
			r.spawn(func() { r.releaseUnused(b, true, 1) })
			return r.noAnswer(entry).Reply()
		}
	}
	switch ans.State {
	case "held":
		state, _, err := r.o.Bridge.TakeBoard(page, b.key, false)
		if err != nil { // the page's stream ended meanwhile
			r.releaseThere(b, 1)
			return unknownClient()
		}
		return takeState(state, b.rev.Load())
	case "busy":
		r.unwant(b, page)
		return takeState("busy", 0)
	case "waiting": // the page stays the one the server's held event is for
		return takeState("waiting", 0)
	}
	r.unwant(b, page)
	return r.badAnswer(entry).Reply()
}

// holdGranted takes the server's "held" at the revision rev, which answered a take that was sent
// under the entry's stream number stream: the relay counts on the hold, unless that stream ended
// since. The end of a stream is counted before the holds are cleared (boardsStreamEnded), so the
// check and the hold are one step under b.mu. page is the page whose wait there ends by it, ""
// for none.
func (r *Relay) holdGranted(b *board, stream uint64, rev int64, page string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.removed || r.stream(b.entry) != stream {
		return false
	}
	b.seen(rev)
	b.heldThere = true
	if page != "" && b.want == page {
		b.want = ""
	}
	return true
}

// unwant ends the page's wait for the board on its server, unless another page waits by now.
func (r *Relay) unwant(b *board, page string) {
	b.mu.Lock()
	if b.want == page {
		b.want = ""
	}
	b.mu.Unlock()
}

// releaseThere releases the board on its server and reports whether the server handed it to
// somebody who waited there. Whatever comes of the call, this server no longer counts on the
// hold. b.holdMu held.
//
// With no answer the server may still count this one as the holder, for as long as the stream
// lasts. So while the entry stays connected the release is made again after r.again, in the
// background, if no page here holds the board or waits for it by then: holdTries calls in a
// row at most, of which this one is number try.
func (r *Relay) releaseThere(b *board, try int) (handed bool) {
	b.mu.Lock()
	b.heldThere = false
	b.mu.Unlock()
	rep, e := r.do(r.ctx, b.entry, http.MethodPost, boardPath(b.id, "/release"), nil, r.o.Limits.Unfollow)
	if e != nil && errors.Is(e, ErrNoAnswer) && try < holdTries && r.held(b.entry) {
		r.spawn(func() {
			if r.waitAgain(b.entry) {
				r.releaseUnused(b, true, try+1)
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
func (r *Relay) releaseUnused(b *board, force bool, try int) {
	b.holdMu.Lock()
	defer b.holdMu.Unlock()
	if _, held := r.o.Bridge.HolderOf(b.key); held {
		return
	}
	b.mu.Lock()
	unused := b.want == "" && (force || b.heldThere) && !b.removed
	b.mu.Unlock()
	if unused {
		r.releaseThere(b, try)
	}
}

// waitAgain waits r.again and reports whether the entry's tree is held after it, and the relay
// not closed. It is for a goroutine of spawn.
func (r *Relay) waitAgain(entry string) bool {
	select {
	case <-r.ctx.Done():
		return false
	case <-time.After(r.again):
	}
	return r.held(entry)
}

// ReleaseBoard serves POST …/boards/{id}/release for a board of the section entry: the page's
// release. The answer is 200 {"state":"handed"|"free"|"none"} in every state of the entry, and
// 404 no_server for an id that is no entry. The board's server is told only when the release
// left the board with no page here and this server holds it there: it then is released there
// too, and when that server handed it to somebody who waited there, the page is sent superseded
// and answered "handed", as by a hand-over here. While the entry is not connected nothing is
// sent: that server forgot the hold with the stream.
func (r *Relay) ReleaseBoard(entry, page, id string) Reply {
	if !r.Listed(entry) {
		return noServer().Reply()
	}
	key := editorbridge.BoardOn(entry, id)
	b := r.boardOf(entry, id)
	if b == nil { // never taken through the relay: no page holds it
		return jsonReply(http.StatusOK, map[string]string{"state": r.o.Bridge.ReleaseBoard(page, key)})
	}
	b.holdMu.Lock()
	defer b.holdMu.Unlock()
	state := r.o.Bridge.ReleaseBoard(page, key)
	if state == "free" {
		b.mu.Lock()
		there := b.heldThere
		b.mu.Unlock()
		if there && r.releaseThere(b, 1) {
			r.tellBoard(b, page, "superseded")
			state = "handed"
		}
	}
	return jsonReply(http.StatusOK, map[string]string{"state": state})
}

// BoardFree is the function for Bridge.OnBoardFree: the board with this key ended with no
// holder here. For a board of a section (a key of editorbridge.BoardOn) the tool calls that wait
// for a page that no longer holds the board fail, and a board that is still free here is
// released on its server. A key of a board of this server is not the relay's and is left alone.
func (r *Relay) BoardFree(key string) {
	entry, id := editorbridge.SplitBoard(key)
	if entry == "" {
		return
	}
	holder, _ := r.o.Bridge.HolderOf(key)
	r.failBoardCalls(key, holder)
	if b := r.boardOf(entry, id); b != nil {
		r.releaseUnused(b, false, 1)
	}
}

// boardRoleEvent takes held, release_request and superseded of the entry's server, as they
// came. It is called on the entry's worker and must not call the server itself.
func (r *Relay) boardRoleEvent(entry, typ string, raw json.RawMessage) {
	var ev struct {
		Board string `json:"board"`
		Rev   int64  `json:"rev"`
	}
	if json.Unmarshal(raw, &ev) != nil || ev.Board == "" || !r.held(entry) {
		return
	}
	b := r.boardOf(entry, ev.Board)
	if b == nil {
		if typ == "superseded" {
			return
		}
		b = r.boardFor(entry, ev.Board) // a board that server gave this one and no page here asked for
	}
	release := false
	b.mu.Lock()
	holder, held := r.o.Bridge.HolderOf(b.key)
	switch typ {
	case "held":
		b.seen(ev.Rev)
		switch {
		case b.removed:
		case held: // the server tells the revision again
			b.heldThere = true
			r.tellHeld(b, holder, ev.Rev)
		case b.want != "": // the hand-over there ended: the page that waited gets the board
			page := b.want
			b.want = ""
			state, _, err := r.o.Bridge.TakeBoard(page, b.key, false)
			if err != nil { // the page is gone
				release = true
				break
			}
			b.heldThere = true
			if state == "held" { // else a page took the board here meanwhile, and the bridge hands it over
				r.tellHeld(b, page, ev.Rev)
			}
		default:
			release = true
		}
	case "release_request":
		if held {
			// The page flushes and releases here, which releases there.
			r.tellBoard(b, holder, "release_request")
		} else {
			release = true
		}
	case "superseded":
		b.heldThere = false
		if held {
			r.o.Bridge.LoseBoard(b.key) // the holder, and a page that waits for it here, get superseded
		}
		if b.want != "" {
			r.tellBoard(b, b.want, "superseded")
			b.want = ""
		}
	}
	b.mu.Unlock()
	if release {
		r.spawn(func() { r.releaseUnused(b, true, 1) })
	}
}

// boardsStreamEnded is the board part of a stream's end: the entry's server holds nothing for
// this one any more, and no page waits there. The relay has counted the stream's end before, so
// a "held" that was asked under that stream is never counted on (holdGranted). The tool calls
// of the entry that are open are dropped, since its server has failed them itself. It is called
// on the entry's worker, before the pages are told of the tree.
func (r *Relay) boardsStreamEnded(entry string) {
	for _, b := range r.boardsOn(entry) {
		b.mu.Lock()
		b.heldThere = false
		if b.want != "" {
			r.tellBoard(b, b.want, "superseded")
			b.want = ""
		}
		b.mu.Unlock()
	}
	r.dropBoardCalls(entry)
}

// boardsBack is the board part of a tree's arrival. It is called on the entry's worker, after
// the pages got the tree, and must not call the server itself: each board a page here holds is
// taken there again, if free, in a goroutine.
func (r *Relay) boardsBack(entry string) {
	for _, b := range r.boardsOn(entry) {
		if _, held := r.o.Bridge.HolderOf(b.key); held {
			r.spawn(func() { r.retake(b) })
		}
	}
}

// boardLetGo takes a board of the entry from the pages here: its server removed it (gone) or
// archived it. The page that holds it and a page that waits for it get superseded, and nothing
// is held or waited for there any more. It is called on the entry's worker.
func (r *Relay) boardLetGo(entry, id string, gone bool) {
	b := r.boardOf(entry, id)
	if b == nil {
		return
	}
	b.mu.Lock()
	if gone {
		b.heldThere = false
	}
	if b.want != "" {
		r.tellBoard(b, b.want, "superseded")
		b.want = ""
	}
	b.mu.Unlock()
	r.o.Bridge.LoseBoard(b.key)
}

// dropBoards is the board part of an entry's removal: what the relay keeps of its boards goes,
// and the pages that hold or wait for one get superseded.
func (r *Relay) dropBoards(entry string) {
	for _, b := range r.boardsOn(entry) {
		b.mu.Lock()
		b.removed, b.heldThere = true, false
		want := b.want
		b.want = ""
		b.mu.Unlock()
		if want != "" {
			r.tellBoard(b, want, "superseded")
		}
		r.o.Bridge.LoseBoard(b.key)
		r.boards.CompareAndDelete(b.key, b)
	}
	r.dropBoardCalls(entry)
}

// retakeOnSave starts the re-take of the board for a save that found the board not held on its
// server: one at a time for a board, with its repeats, however many saves ask.
func (r *Relay) retakeOnSave(b *board) {
	if !b.retaking.CompareAndSwap(false, true) {
		return
	}
	if !r.spawn(func() {
		defer b.retaking.Store(false)
		r.retake(b)
	}) {
		b.retaking.Store(false)
	}
}

// retake takes the board on its server again, if it is free there, for the page that holds it
// here: see retakeOnce. A take that told nothing is made again after r.again while the entry's
// tree is held, holdTries calls in a row at most; after that the next save of the page, or the
// next tree, starts it anew. It is for a goroutine of spawn: the board's hold lock is not held
// while it waits.
func (r *Relay) retake(b *board) {
	for try := 1; r.retakeOnce(b) && try < holdTries; try++ {
		if !r.waitAgain(b.entry) {
			return // the next tree takes it
		}
	}
}

// retakeOnce is one take of retake, and reports whether it is to be made again. "held" is
// passed to the page with the server's revision, which lets the page decide: at the revision
// its edit is based on it saves, at another it drops the edit. A board that is held there by
// another, or is archived or gone, is taken from the page, which gets superseded. Every other
// end tells nothing of the board, the server's unknown_client among them (this server's stream
// there is not open at that moment): all stays as it is, and the take is to be made again.
func (r *Relay) retakeOnce(b *board) (again bool) {
	b.holdMu.Lock()
	defer b.holdMu.Unlock()
	for try := 0; try < 2; try++ {
		if _, held := r.o.Bridge.HolderOf(b.key); !held {
			return false
		}
		b.mu.Lock()
		done := b.heldThere || b.removed
		b.mu.Unlock()
		if done {
			return false
		}
		stream := r.stream(b.entry)
		rep, e := r.do(r.ctx, b.entry, http.MethodPost, boardPath(b.id, "/take"), []byte(`{"ifFree":true}`), r.o.Limits.Call)
		if e != nil {
			return errors.Is(e, ErrNoAnswer)
		}
		var ans struct {
			State string `json:"state"`
			Rev   int64  `json:"rev"`
		}
		_ = json.Unmarshal(rep.Body, &ans)
		switch {
		case rep.Status == http.StatusOK && ans.State == "held":
			if !r.holdGranted(b, stream, ans.Rev, "") {
				continue // granted under a stream that ended since
			}
			// The holder as it is now: the board may have gone to another page here. If no
			// page is left, BoardFree waits for holdMu and releases.
			if page, held := r.o.Bridge.HolderOf(b.key); held {
				r.tellHeld(b, page, ans.Rev)
			}
			return false
		case rep.Status == http.StatusOK && ans.State == "busy",
			notFound(rep),
			rep.Status == http.StatusConflict && saidIn(rep).Error == boardArchivedThere:
			r.o.Bridge.LoseBoard(b.key)
			return false
		default:
			return true
		}
	}
	return true
}

// CreateBoard serves POST …/boards for the section entry: body is the request's JSON, passed on
// as Pass does within Limits.Call, and the answer is that server's. That server gives a new
// board to the client that made it, which is this server: the page that asked is given it here,
// by a take of its own, whose answer is not the creation's matter. When that take gives the page
// nothing, as for a page whose stream ended while the board was made, no page here holds the
// board, and it is let go there.
func (r *Relay) CreateBoard(ctx context.Context, entry, page string, body []byte) Reply {
	rep, e := r.do(ctx, entry, http.MethodPost, "/api/boards", body, r.o.Limits.Call)
	if e != nil {
		return e.Reply()
	}
	var made struct {
		ID string `json:"id"`
	}
	if rep.Status == http.StatusOK && json.Unmarshal(rep.Body, &made) == nil && made.ID != "" {
		r.TakeBoard(entry, page, made.ID, true)
		b := r.boardFor(entry, made.ID)
		if _, held := r.o.Bridge.HolderOf(b.key); !held {
			r.spawn(func() { r.releaseUnused(b, true, 1) })
		}
	}
	return r.handed(entry, rep)
}

// Scene serves GET …/boards/{id}/scene for a board of the section entry: the drawing is read
// from its server within Limits.Scene. An answer of 200 is the drawing, and rev its revision
// there, for the header SceneRevHeader; one without a revision is 502 bad_answer. Every other
// answer is as for Pass, and rev is then 0.
func (r *Relay) Scene(ctx context.Context, entry, id string) (rep Reply, rev int64) {
	got, e := r.do(ctx, entry, http.MethodGet, boardPath(id, "/scene"), nil, r.o.Limits.Scene)
	if e != nil {
		return e.Reply(), 0
	}
	rep = r.handed(entry, got)
	if got.Status != http.StatusOK || rep.Status != http.StatusOK {
		return rep, 0
	}
	rev, err := strconv.ParseInt(got.Header.Get(SceneRevHeader), 10, 64)
	if err != nil || rev < 0 {
		return r.badAnswer(entry).Reply(), 0
	}
	if b := r.boardOf(entry, id); b != nil {
		b.seen(rev)
	}
	return rep, rev
}

// notHolder is the refusal of a save by a page that does not hold the board.
func notHolder(text string) Reply {
	return (&Error{Status: http.StatusConflict, Code: "not_holder", Text: text}).Reply()
}

// notHeldThere is the refusal of a save while this server does not hold the board on its
// server. It is a 503: the page keeps its edit, and the held event of the re-take decides.
func (r *Relay) notHeldThere(entry string) Reply {
	return (&Error{Status: http.StatusServiceUnavailable, Code: "not_held_there",
		Text: "The board is being taken again on " + r.name(entry) + "."}).Reply()
}

// SaveScene serves PUT …/boards/{id}/scene?rev=N for a board of the section entry: the drawing
// the page saves at the revision base is passed on within Limits.Scene. Only the page that
// holds the board here may save (409 not_holder), and only while this server holds the board on
// its server: while the entry is not connected the save is 503 server_unreachable, and after
// its return the board is first taken there again (503 not_held_there until then). The page
// keeps its edit after any 503. The server checks the holder and the revision itself, and its
// answer is the page's: 200 {"rev"}, or 409 stale with its revision.
//
// But for one answer: "not_holder" there means that this server lost the hold and has not
// learnt of it yet, not that the page lost the board, so the page gets the 503 of a board that
// is not held there. That refusal starts the re-take, whose end tells the page by the revision,
// or by superseded, what becomes of its edit. The save is not ended by the page that asked: the
// revision it made there is taken here.
func (r *Relay) SaveScene(entry, page, id string, base int64, body []byte) Reply {
	if !r.Listed(entry) {
		return noServer().Reply()
	}
	key := editorbridge.BoardOn(entry, id)
	switch holder, held := r.o.Bridge.HolderOf(key); {
	case !held:
		return notHolder("this window does not hold the board")
	case holder != page:
		return notHolder("another window holds this board")
	}
	if base < 0 {
		return jsonReply(http.StatusBadRequest, map[string]string{"error": "rev is not a number"})
	}
	if e := r.Ready(entry); e != nil {
		return e.Reply()
	}
	b := r.boardFor(entry, id)
	b.mu.Lock()
	there := b.heldThere
	b.mu.Unlock()
	if !there {
		r.retakeOnSave(b)
		return r.notHeldThere(entry)
	}
	stream := r.stream(entry)
	rep, e := r.do(r.ctx, entry, http.MethodPut, boardPath(id, "/scene")+"?rev="+strconv.FormatInt(base, 10), body, r.o.Limits.Scene)
	if e != nil {
		return e.Reply()
	}
	if rep.Status == http.StatusOK {
		var ans struct {
			Rev int64 `json:"rev"`
		}
		if json.Unmarshal(rep.Body, &ans) == nil {
			b.seen(ans.Rev)
		}
		// The board may have gone to another page here since the check above, with a grant
		// that named the revision before this write: that holder is told the new one.
		r.o.Bridge.Regrant(key, page)
	}
	if rep.Status == http.StatusConflict && saidIn(rep).Code == "not_holder" {
		b.mu.Lock()
		if r.stream(entry) == stream { // else the hold is one of a newer stream
			b.heldThere = false
		}
		b.mu.Unlock()
		r.retakeOnSave(b)
		return r.notHeldThere(entry)
	}
	return r.handed(entry, rep)
}
