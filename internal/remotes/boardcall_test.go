package remotes

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
)

// toolCall is an rpc event as a board's server sends it.
func toolCall(id, name, board, target string) map[string]any {
	params := map[string]any{"chat": chatA, "branch": mainBranch, "board": board, "name": name, "args": map[string]any{"n": 1}}
	if target != "" {
		params["target"] = target
	}
	return map[string]any{"type": "rpc", "id": id, "method": "tool", "params": params}
}

// answers are the tool call answers the server got, each as its JSON object.
func answers(t *testing.T, th *there, n int) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, l := range th.wait("reply", n) {
		var m map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(l, "reply ")), &m); err != nil {
			t.Fatalf("the answer %q: %v", l, err)
		}
		out = append(out, m)
	}
	return out
}

// take makes the page the holder of the board, on both servers.
func take(t *testing.T, rg *rig, p *bridgetest.Page, id string) {
	t.Helper()
	wantReply(t, "take", rg.r.TakeBoard(t.Context(), p.ID, id, false), http.StatusOK, map[string]any{"state": "held"})
}

// TestBoardCall: a tool call of the board's server goes to the page that holds the board, under
// an id of the relay's own, and the page's answer goes back under the server's id.
func TestBoardCall(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA, boardB)
	ctx := t.Context()
	p1, _ := rg.page("page-1")
	p2, _ := rg.page("page-2")
	take(t, rg, p1, boardA)

	rg.s.Send(toolCall("rpc_5", "draw", boardA, ""))
	ev := role(t, p1, "rpc")
	id, _ := ev["id"].(string)
	if id != "far_1" || ev["method"] != "tool" || field(ev, "params", "board") != boardA || field(ev, "params", "args", "n") != 1.0 || len(ev) != 4 {
		t.Fatalf("the page's call: %v", ev)
	}
	if !rg.r.IsBoardCall(id) || rg.r.IsBoardCall("rpc_5") {
		t.Error("IsBoardCall does not tell the relay's ids from the bridge's")
	}
	// Only the page that was asked may answer, and once.
	answer := []byte(`{"id":"far_1","result":{"shapes":[1,2]}}`)
	wantReply(t, "another page", rg.r.ReplyBoardCall(ctx, p2.ID, id, answer), http.StatusConflict, map[string]any{"error": "not_asked"})
	wantReply(t, "no JSON", rg.r.ReplyBoardCall(ctx, p1.ID, id, []byte(`{`)), http.StatusBadRequest, nil)
	if got := th.calls("reply"); got != nil {
		t.Fatalf("the server was answered: %v", got)
	}
	wantReply(t, "the page asked", rg.r.ReplyBoardCall(ctx, p1.ID, id, answer), http.StatusOK, map[string]any{"ok": true})
	wantReply(t, "a second answer", rg.r.ReplyBoardCall(ctx, p1.ID, id, answer), http.StatusConflict, map[string]any{"error": "not_asked"})
	wantReply(t, "an unknown id", rg.r.ReplyBoardCall(ctx, p1.ID, "far_99", answer), http.StatusConflict, map[string]any{"error": "not_asked"})
	want := map[string]any{"id": "rpc_5", "result": map[string]any{"shapes": []any{1.0, 2.0}}}
	if got := answers(t, th, 1); !reflect.DeepEqual(got[0], want) {
		t.Errorf("the server got %v, want %v", got[0], want)
	}

	// An error of the page is passed on as one.
	rg.s.Send(toolCall("rpc_6", "draw", boardA, ""))
	id, _ = role(t, p1, "rpc")["id"].(string)
	wantReply(t, "an error", rg.r.ReplyBoardCall(ctx, p1.ID, id, []byte(`{"id":"far_2","error":"no such shape"}`)), http.StatusOK, nil)
	if got := answers(t, th, 2); !reflect.DeepEqual(got[1], map[string]any{"id": "rpc_6", "error": "no such shape"}) {
		t.Errorf("the server got %v", got[1])
	}

	// Which page: the holder of the target, but of the chat's board for a call about the view,
	// and when nobody holds the target.
	rg.s.Send(toolCall("rpc_7", "draw", boardA, boardB))
	if ev := role(t, p1, "rpc"); field(ev, "params", "target") != boardB {
		t.Errorf("the call for a target nobody holds: %v", ev)
	}
	take(t, rg, p2, boardB)
	rg.s.Send(toolCall("rpc_8", "draw", boardA, boardB))
	role(t, p2, "rpc")
	rg.s.Send(toolCall("rpc_9", "get_view", boardA, boardB))
	role(t, p1, "rpc")
	rg.s.Send(toolCall("rpc_10", "show_board", boardA, boardB))
	role(t, p1, "rpc")
	noRole(t, rg, p1, p2)

	// No page holds the board, or the board is not the entry's: answered at once.
	rg.s.Send(toolCall("rpc_11", "draw", boardC, ""))
	if got := answers(t, th, 3); !reflect.DeepEqual(got[2], map[string]any{"id": "rpc_11", "error": noBoardWindow}) {
		t.Errorf("the server got %v", got[2])
	}
	rg.r.boardCallEvent("s_other", mustJSON(t, toolCall("rpc_12", "draw", boardA, "")))
	rg.r.boardCallEvent(rg.entry, json.RawMessage(`{"params":{"board":"`+boardA+`"}}`)) // no id: no call
	noRole(t, rg, p1, p2)

	// The page loses the board: its calls by that board fail at once, the others stay.
	wantReply(t, "release", rg.r.ReleaseBoard(ctx, p2.ID, boardB), http.StatusOK, map[string]any{"state": "free"})
	if got := answers(t, th, 4); !reflect.DeepEqual(got[3], map[string]any{"id": "rpc_8", "error": noBoardWindow}) {
		t.Errorf("the server got %v", got[3])
	}
	// The page's stream ends: so do the calls that waited for it.
	p1.Close()
	seen := map[any]bool{}
	for _, m := range answers(t, th, 7)[4:] {
		if m["error"] != noBoardWindow {
			t.Errorf("the server got %v", m)
		}
		seen[m["id"]] = true
	}
	if !seen["rpc_7"] || !seen["rpc_9"] || !seen["rpc_10"] || len(seen) != 3 {
		t.Errorf("the calls that failed: %v", seen)
	}
	time.Sleep(quiet)
	if got := th.calls("reply"); len(got) != 7 {
		t.Errorf("the server got %d answers: %v", len(got), got)
	}
}

// TestBoardCallReplyOfNobody: an answer that names no page answers no call. "No page" is "any
// page" only for the relay's own timer.
func TestBoardCallReplyOfNobody(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA)
	ctx := t.Context()
	p, _ := rg.page("page-1")
	take(t, rg, p, boardA)
	rg.s.Send(toolCall("rpc_8", "draw", boardA, ""))
	id, _ := role(t, p, "rpc")["id"].(string)
	wantReply(t, "an answer of no page", rg.r.ReplyBoardCall(ctx, "", id, []byte(`{"result":"forged"}`)), http.StatusConflict, map[string]any{"error": "not_asked"})
	wantReply(t, "the page's answer", rg.r.ReplyBoardCall(ctx, p.ID, id, []byte(`{"result":"drawn"}`)), http.StatusOK, map[string]any{"ok": true})
	want := map[string]any{"id": "rpc_8", "result": "drawn"}
	if got := answers(t, th, 1); !reflect.DeepEqual(got[0], want) {
		t.Errorf("the server got %v, want %v", got[0], want)
	}
}

// TestBoardCallTimeout: a page that does not answer within Limits.BoardCall is answered for.
func TestBoardCallTimeout(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{limits: Limits{BoardCall: 50 * time.Millisecond}}, boardA)
	p, _ := rg.page("page-1")
	take(t, rg, p, boardA)
	rg.s.Send(toolCall("rpc_3", "draw", boardA, ""))
	id, _ := role(t, p, "rpc")["id"].(string)
	want := map[string]any{"id": "rpc_3", "error": "the board's window did not answer in 50ms"}
	if got := answers(t, th, 1); !reflect.DeepEqual(got[0], want) {
		t.Errorf("the server got %v, want %v", got[0], want)
	}
	wantReply(t, "a late answer", rg.r.ReplyBoardCall(t.Context(), p.ID, id, []byte(`{"result":1}`)), http.StatusConflict, map[string]any{"error": "not_asked"})
	time.Sleep(quiet)
	if got := th.calls("reply"); len(got) != 1 {
		t.Errorf("the server got %v", got)
	}
	if DefaultLimits.BoardCall != 25*time.Second {
		t.Errorf("the limit outside the tests is %v", DefaultLimits.BoardCall)
	}
}

// TestBoardCallDropped: a new snapshot of the entry drops its open calls, since the server has
// failed them itself.
func TestBoardCallDropped(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA)
	p, _ := rg.page("page-1")
	take(t, rg, p, boardA)
	rg.s.Send(toolCall("rpc_3", "draw", boardA, ""))
	id, _ := role(t, p, "rpc")["id"].(string)
	rg.s.DropStreams()
	rg.returned(2)
	wantReply(t, "an answer after the return", rg.r.ReplyBoardCall(t.Context(), p.ID, id, []byte(`{"result":1}`)), http.StatusConflict, map[string]any{"error": "not_asked"})
	p.Close() // nor is the call failed as one of a page that lost the board
	time.Sleep(quiet)
	if got := th.calls("reply"); got != nil {
		t.Errorf("the server got %v", got)
	}
}

// TestBoardCallImageResult: a get_image answer, an object with the text and the picture as base64, goes to the
// board's server unchanged under the server's id, and so does a picture of some megabytes.
func TestBoardCallImageResult(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA)
	ctx := t.Context()
	p1, _ := rg.page("page-1")
	take(t, rg, p1, boardA)

	pictures := []string{"iVBORw0KGgo=", strings.Repeat("QUJD", 1<<20)} // 8 bytes; 4 MiB of base64
	for i, data := range pictures {
		rpc := "rpc_" + string(rune('1'+i))
		rg.s.Send(toolCall(rpc, "get_image", boardA, ""))
		id, _ := role(t, p1, "rpc")["id"].(string)
		result := map[string]any{"text": "scope all, bounds x=0 y=0 w=10 h=10 (board coordinates), 1 element, a (b_1)", "image": map[string]any{"mimeType": "image/png", "data": data}}
		body := mustJSON(t, map[string]any{"id": id, "result": result})
		wantReply(t, "the page's answer", rg.r.ReplyBoardCall(ctx, p1.ID, id, body), http.StatusOK, map[string]any{"ok": true})
		lines := th.wait("reply", i+1)
		var got struct {
			ID     string
			Result json.RawMessage
		}
		if err := json.Unmarshal([]byte(strings.TrimPrefix(lines[i], "reply ")), &got); err != nil {
			t.Fatal(err)
		}
		if got.ID != rpc {
			t.Errorf("answer %d is for %q, want %q", i, got.ID, rpc)
		}
		var want json.RawMessage = mustJSON(t, result)
		var a, b any
		_ = json.Unmarshal(want, &a)
		if err := json.Unmarshal(got.Result, &b); err != nil || !reflect.DeepEqual(a, b) {
			t.Errorf("answer %d: the result changed on the way (%d bytes, want %d)", i, len(got.Result), len(want))
		}
		obj, _ := b.(map[string]any)
		img, _ := obj["image"].(map[string]any)
		if img["data"] != data || img["mimeType"] != "image/png" {
			t.Errorf("answer %d: the picture changed on the way", i)
		}
	}
}

// TestResultLimit: with the production limits (Call 15 s, Scene 60 s) a result gets what is left of the server's 30 s
// wait less the reserve for the error answer, not Limits.Call, and never less than the floor or more than Limits.Scene.
func TestResultLimit(t *testing.T) {
	t.Parallel()
	d := DefaultLimits
	if d.Call >= d.Scene {
		t.Fatalf("this test needs Call < Scene, have %v and %v", d.Call, d.Scene)
	}
	for _, c := range []struct{ elapsed, want time.Duration }{
		{0, 27 * time.Second},
		{10 * time.Second, 17 * time.Second},
		{25 * time.Second, resultFloor},
		{29 * time.Second, resultFloor},
		{time.Minute, resultFloor},
	} {
		if got := resultLimit(d.Scene, c.elapsed); got != c.want {
			t.Errorf("resultLimit(Scene, %v) = %v, want %v", c.elapsed, got, c.want)
		}
	}
	if got := resultLimit(2*time.Second, 0); got != 2*time.Second {
		t.Errorf("a Scene under what is left: %v, want Scene", got)
	}
}

// TestBoardCallResultNotDelivered: a result that the board's server does not take within the result's limit
// (Limits.Scene, not Limits.Call) is answered with an error that names its size, not left to the server's timeout.
// The limit is seconds, so that the whole result is read there before it runs out, on a slow machine too.
func TestBoardCallResultNotDelivered(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{limits: Limits{Call: time.Minute, Scene: 2 * time.Second}}, boardA)
	p, _ := rg.page("page-1")
	take(t, rg, p, boardA)
	th.set(func() {
		th.replyIn = func(r *http.Request, body []byte) { // a slow uplink: a result is not taken, an error is
			if strings.Contains(string(body), `"result"`) {
				if !json.Valid(body) {
					t.Errorf("the result was cut before the stand-in had read it (%d bytes)", len(body))
				}
				<-r.Context().Done()
			}
		}
	})
	rg.s.Send(toolCall("rpc_3", "get_image", boardA, ""))
	id, _ := role(t, p, "rpc")["id"].(string)
	answer := []byte(`{"result":{"text":"t","image":{"mimeType":"image/png","data":"` + strings.Repeat("QUJD", 1<<19) + `"}}}`)
	wantReply(t, "the page's answer", rg.r.ReplyBoardCall(t.Context(), p.ID, id, answer), http.StatusOK, map[string]any{"ok": true})
	got := answers(t, th, 2)
	if got[0]["id"] != "rpc_3" || got[0]["result"] == nil {
		t.Errorf("the first answer: %v", got[0])
	}
	want := map[string]any{"id": "rpc_3", "error": "the answer (2.0 MB) could not be sent to the board's server in time; ask for a smaller scope or scale"}
	if !reflect.DeepEqual(got[1], want) {
		t.Errorf("the second answer %v, want %v", got[1], want)
	}
}
