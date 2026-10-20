package boardapi

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
)

// quick is the call time of the tests below: short, because a test waits it out. What must happen
// is waited for up to bridgetest.Wait.
const quick = 200 * time.Millisecond

// setCallTimeout lowers the call time for one test. The tests that call it are not parallel.
func setCallTimeout(t *testing.T, d time.Duration) {
	old := callTimeout
	callTimeout = d
	t.Cleanup(func() { callTimeout = old })
}

// toolLog collects the names of the tools a stand-in page was asked.
type toolLog struct {
	mu    sync.Mutex
	names []string
}

func (a *toolLog) add(name string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.names = append(a.names, name)
}

func (a *toolLog) list() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.names...)
}

// silentWindow connects a window P1 that holds the chat's board and never answers, and the
// background editor's page H, which answers every call with the text "away:<tool>" (an object with
// a picture for get_image).
func silentWindow(e *env) (p1, h *bridgetest.Page, hLog *toolLog) {
	e.away()
	pages := e.connect("P1", "H")
	e.take("P1", e.board.ID)
	hLog = &toolLog{}
	pages["H"].OnRPC(func(params map[string]any) (any, string) {
		name := params["name"].(string)
		hLog.add(name)
		if name == "get_image" {
			return map[string]any{"text": "away:get_image", "image": map[string]any{"mimeType": "image/png", "data": "AAAA"}}, ""
		}
		return "away:" + name, ""
	})
	return pages["P1"], pages["H"], hLog
}

// A read that a window holding the board does not answer is given again, once, to the background
// editor, which holds the board by then; the agent gets the board and is told nothing of the window.
func TestUnansweredReadIsGivenAgainToTheAwayEditor(t *testing.T) {
	setCallTimeout(t, quick)
	for _, tool := range []string{"read_board", "get_image"} {
		t.Run(tool, func(t *testing.T) {
			e := newEnv(t)
			_, _, hLog := silentWindow(e)

			start := time.Now()
			res := e.relay.CallResult(e.token, tool, json.RawMessage(`{}`))
			if res.IsErr || res.Text != "away:"+tool {
				t.Fatalf("got %+v", res)
			}
			if tool == "get_image" && (res.Image == nil || res.Image.Data != "AAAA") {
				t.Fatalf("no picture: %+v", res)
			}
			if time.Since(start) < quick {
				t.Fatal("the window's call ended before its time")
			}
			if got := hLog.list(); len(got) != 1 || got[0] != tool {
				t.Fatalf("the editor was asked %v", got)
			}
			if id, held := e.relay.Bridge.HolderOf(e.board.ID); !held || id != "H" {
				t.Fatalf("holder of the board is %q, %v; the window must have lost it", id, held)
			}
			if ensured, timedOut := e.relay.Away.(*fakeAway).counts(); ensured != 1 || timedOut != 0 {
				t.Fatalf("Ensure %d times, CallTimedOut %d times", ensured, timedOut)
			}
		})
	}
}

// A call that changes the board is not given again: the agent is told what happened, and the
// background editor is not asked. The next call of either kind goes to the editor at once.
func TestUnansweredChangeIsNotRepeatedAndTheNextCallIsAway(t *testing.T) {
	setCallTimeout(t, 2*time.Second)
	for _, tool := range []string{"apply", "delete_elements"} {
		t.Run(tool, func(t *testing.T) {
			e := newEnv(t)
			_, h, hLog := silentWindow(e)
			callTimeout = quick // the window's silence is waited out for this long only

			res := e.relay.CallResult(e.token, tool, json.RawMessage(`{}`))
			if !res.IsErr || res.Text != UnansweredText {
				t.Fatalf("got %+v", res)
			}
			h.ExpectNone(50 * time.Millisecond)
			if got := hLog.list(); len(got) != 0 {
				t.Fatalf("the editor was asked %v", got)
			}
			if _, held := e.relay.Bridge.HolderOf(e.board.ID); held {
				t.Fatal("the board is still held")
			}

			callTimeout = 2 * time.Second
			for _, next := range []string{"read_board", "apply", "get_image", "delete_elements"} {
				start := time.Now()
				res := e.relay.CallResult(e.token, next, json.RawMessage(`{}`))
				if res.IsErr || res.Text != "away:"+next {
					t.Fatalf("%s after: %+v", next, res)
				}
				if time.Since(start) > 1500*time.Millisecond {
					t.Fatalf("%s after took %v", next, time.Since(start))
				}
			}
		})
	}
}

// A read that no window answers, on a server with no background editor, is told the old text after
// its second go: the board isn't open.
func TestUnansweredReadWithNoAwayEditor(t *testing.T) {
	setCallTimeout(t, quick)
	for _, tool := range []string{"read_board", "get_image"} {
		t.Run(tool, func(t *testing.T) {
			e := newEnv(t)
			e.connect("P1")
			e.take("P1", e.board.ID)
			text, isErr := e.relay.Call(e.token, tool, json.RawMessage(`{}`))
			if !isErr || text != NoClientText {
				t.Fatalf("got %q isErr=%v", text, isErr)
			}
			if _, held := e.relay.Bridge.HolderOf(e.board.ID); held {
				t.Fatal("the window still holds the board")
			}
		})
	}
}

// When the background editor cannot run, a read that a window did not answer is told so, with the
// text of every other call that the editor cannot take.
func TestUnansweredReadWhenTheAwayEditorCannotRun(t *testing.T) {
	setCallTimeout(t, quick)
	e := newEnv(t)
	away := e.away()
	e.connect("P1")
	e.take("P1", e.board.ID)
	away.err = errors.New("no node")
	text, isErr := e.relay.Call(e.token, "read_board", json.RawMessage(`{}`))
	if !isErr || text != NoEditorText {
		t.Fatalf("got %q isErr=%v", text, isErr)
	}
}

// A read that a window did not answer, and that a second window that took the board did not answer
// either, is not given a third time: the agent is told that the read did not finish and changed
// nothing.
func TestUnansweredReadIsGivenOnlyTwice(t *testing.T) {
	setCallTimeout(t, quick)
	e := newEnv(t)
	e.away()
	pages := e.connect("P1", "P2", "H")
	e.take("P1", e.board.ID)
	// P2 asks for the board while P1 holds it; it gets it when P1 loses it, and does not answer.
	if state, _, err := e.relay.Bridge.TakeBoard("P2", e.board.ID, false); err != nil || state != "waiting" {
		t.Fatalf("take: %q %v", state, err)
	}
	res := e.relay.CallResult(e.token, "read_board", json.RawMessage(`{}`))
	if !res.IsErr || res.Text != UnansweredReadText {
		t.Fatalf("got %+v", res)
	}
	pages["H"].ExpectNone(50 * time.Millisecond)
}

// A window that answers in time keeps the board, and the call is not given twice.
func TestAnsweredInTimeIsUnchanged(t *testing.T) {
	setCallTimeout(t, 2*time.Second)
	e := newEnv(t)
	e.away()
	pages := e.connect("P1", "H")
	e.take("P1", e.board.ID)
	var got toolLog
	pages["P1"].OnRPC(func(params map[string]any) (any, string) {
		got.add(params["name"].(string))
		time.Sleep(quick)
		return "win", ""
	})
	for _, tool := range []string{"read_board", "get_image", "apply"} {
		if text, isErr := e.relay.Call(e.token, tool, json.RawMessage(`{}`)); isErr || text != "win" {
			t.Fatalf("%s: %q isErr=%v", tool, text, isErr)
		}
	}
	if names := got.list(); len(names) != 3 {
		t.Fatalf("the window was asked %v", names)
	}
	if id, held := e.relay.Bridge.HolderOf(e.board.ID); !held || id != "P1" {
		t.Fatalf("holder = %q, %v", id, held)
	}
	pages["H"].ExpectNone(50 * time.Millisecond)
}

// A read that was given again to the background editor and that it does not answer is cut by the
// call time as any call of the editor is: the editor is told, so that it is stopped.
func TestUnansweredReadThenSilentAwayEditorIsReported(t *testing.T) {
	setCallTimeout(t, quick)
	e := newEnv(t)
	away := e.away()
	e.connect("P1", "H") // neither answers
	e.take("P1", e.board.ID)
	res := e.relay.CallResult(e.token, "read_board", json.RawMessage(`{}`))
	if !res.IsErr || !strings.HasPrefix(res.Text, "the board did not answer tool in ") {
		t.Fatalf("got %+v", res)
	}
	if ensured, timedOut := away.counts(); ensured != 1 || timedOut != 1 {
		t.Fatalf("Ensure %d times, CallTimedOut %d times", ensured, timedOut)
	}
}
