package remotes

// The tool calls a board's server asks a page of this one: the server's rpc event is passed to
// the page that holds the board under an id of the relay's own, and the page's answer is passed
// back under the server's id. There is one wait, the server's; the relay's own limit
// (Limits.BoardCall) is shorter, so the agent there gets the relay's answer and not a timeout.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// boardCallPrefix starts the ids of the passed-on calls. A bridge's own ids are "rpc_<n>", so a
// page never has two calls with one id.
const boardCallPrefix = "far_"

// noBoardWindow is the answer to a tool call that no page of this server can be asked.
const noBoardWindow = "No window of this computer has the board open."

// boardCalls is what the passed-on tool calls keep in the relay. Its zero value is ready.
type boardCalls struct {
	mu   sync.Mutex
	seq  int64
	open map[string]*boardCall // by the relay's id
}

// boardCall is a passed-on tool call that waits for its page.
type boardCall struct {
	entry string // the server that asked
	there string // the call's id there
	page  string // the page that was asked
	board string // the board the page was chosen by
	timer *time.Timer
}

// take removes the call id and returns it, nil when it is not open. only limits it to a call of
// that page; "" is any.
func (c *boardCalls) take(id, only string) *boardCall {
	c.mu.Lock()
	defer c.mu.Unlock()
	k := c.open[id]
	if k == nil || only != "" && k.page != only {
		return nil
	}
	delete(c.open, id)
	k.timer.Stop()
	return k
}

// takeAll removes and returns the open calls that match.
func (c *boardCalls) takeAll(match func(k *boardCall) bool) []*boardCall {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []*boardCall
	for id, k := range c.open {
		if match(k) {
			delete(c.open, id)
			k.timer.Stop()
			out = append(out, k)
		}
	}
	return out
}

// IsBoardCall reports whether rpcID is the id of a tool call the relay passed on to a page: an
// id of the relay's form, whether its call still waits or not. ReplyBoardCall answers both.
func (r *Relay) IsBoardCall(rpcID string) bool { return strings.HasPrefix(rpcID, boardCallPrefix) }

func notAsked() Reply {
	return jsonReply(http.StatusConflict, map[string]string{"error": "not_asked"})
}

// ReplyBoardCall takes a page's answer to a passed-on tool call: body is the page's
// {"id","result"} or {"id","error"}. Only the page that was asked may answer, and once: an
// answer that names no page is nobody's. The answer is passed to the server that asked, and the
// page gets {"ok":true} whatever that server says.
func (r *Relay) ReplyBoardCall(ctx context.Context, page, rpcID string, body []byte) Reply {
	var ans struct {
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	if err := json.Unmarshal(body, &ans); err != nil {
		return jsonReply(http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
	}
	if page == "" { // "" is any page for take: that is the timer's
		return notAsked()
	}
	k := r.calls.take(rpcID, page)
	if k == nil {
		return notAsked()
	}
	r.answerBoardCall(k, ans.Result, ans.Error)
	return okReply
}

// answerBoardCall posts the answer of the call to the server that asked: the error text, or
// the result. It waits for that server's answer, at most Limits.Call, and reads nothing from it.
func (r *Relay) answerBoardCall(k *boardCall, result json.RawMessage, errText string) {
	reply := map[string]any{"id": k.there}
	if errText != "" {
		reply["error"] = errText
	} else {
		if len(result) == 0 {
			result = json.RawMessage("null")
		}
		reply["result"] = result
	}
	body, err := json.Marshal(reply)
	if err != nil {
		return
	}
	_, _ = r.call(r.ctx, k.entry, http.MethodPost, "/api/rpc-reply", body, r.o.Limits.Call)
}

// failBoardCall answers the call with an error, in a goroutine.
func (r *Relay) failBoardCall(k *boardCall, text string) {
	r.spawn(func() { r.answerBoardCall(k, nil, text) })
}

// failBoardCalls fails the open calls that were passed to a page by its hold of the board,
// except those of the page keep: the page lost the board. It calls no server itself.
func (r *Relay) failBoardCalls(board, keep string) {
	for _, k := range r.calls.takeAll(func(k *boardCall) bool { return k.board == board && k.page != keep }) {
		r.failBoardCall(k, noBoardWindow)
	}
}

// boardCallEvent takes an rpc event of the entry's server, as it came. It is called on the
// entry's worker and must not call the server itself.
//
// The page asked is the one that holds the board the call is about: the calling chat's board
// for get_view and show_board, otherwise the target board, and the chat's board when no page
// holds the target (that page then takes the target itself). Only the boards of the entry
// count. With no such page the server is answered at once.
func (r *Relay) boardCallEvent(entry string, raw json.RawMessage) {
	var ev struct {
		ID     string          `json:"id"`
		Method json.RawMessage `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if json.Unmarshal(raw, &ev) != nil || ev.ID == "" {
		return
	}
	var p struct {
		Board  string `json:"board"`
		Name   string `json:"name"`
		Target string `json:"target"`
	}
	_ = json.Unmarshal(ev.Params, &p)
	k := &boardCall{entry: entry, there: ev.ID}
	first := p.Target
	if first == "" || p.Name == "get_view" || p.Name == "show_board" {
		first = p.Board
	}
	for _, board := range []string{first, p.Board} {
		if board == "" || r.boardOf(entry, board) == nil {
			continue
		}
		if page, held := r.o.Bridge.HolderOf(board); held {
			k.page, k.board = page, board
			break
		}
	}
	if k.page == "" {
		r.failBoardCall(k, noBoardWindow)
		return
	}
	limit := r.o.Limits.BoardCall
	c := &r.calls
	c.mu.Lock()
	c.seq++
	id := fmt.Sprintf("%s%d", boardCallPrefix, c.seq)
	if c.open == nil {
		c.open = map[string]*boardCall{}
	}
	c.open[id] = k
	k.timer = time.AfterFunc(limit, func() {
		if c.take(id, "") != nil {
			r.failBoardCall(k, fmt.Sprintf("the board's window did not answer in %s", limit))
		}
	})
	c.mu.Unlock()
	call := map[string]any{"type": "rpc", "id": id}
	if len(ev.Method) > 0 {
		call["method"] = ev.Method
	}
	if len(ev.Params) > 0 {
		call["params"] = ev.Params
	}
	if !r.o.Bridge.SendTo(k.page, call) && c.take(id, "") != nil {
		r.failBoardCall(k, noBoardWindow)
	}
}

// dropBoardCalls is step 2 of the board part of a snapshot: the tool calls of the entry that
// are open are dropped, since its server has failed them itself. It is called on the entry's
// worker and must not call the server itself.
func (r *Relay) dropBoardCalls(entry string) {
	r.calls.takeAll(func(k *boardCall) bool { return k.entry == entry })
}
