package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
)

// What an agent's board call comes to when the window that holds the board does not answer it
// (goal unresponsive-window-goal.md, section 6), against a real server, a stand-in window that
// takes a board and then says nothing, and the stand-in for the headless writer (testdata/
// headlessstandin), which answers every call with standInAnswer.
//
// One server serves every case, each on a board, a chat and windows of its own, side by side. The
// call time is lowered through AIWB_TEST_WAITS ("calls", a tenth of the 30 s on the fast clock).
// The hand-off time is left at 10 s, so that a call that waits on a gone window ends first.

// standInAnswer is what the stand-in headless writer answers every call with.
const standInAnswer = "STANDIN: the headless writer's fixed answer"

// unansweredText is what an agent is told when a call that changes a board got no answer from the
// window that held it.
const unansweredText = boardapi.UnansweredText

// patience is the upper bound of what must happen: generous, as on a machine four times slower.
const patience = 30 * time.Second

// settle is how long a test waits to see that an event it did not expect does not come.
const settle = 400 * time.Millisecond

// A window of the cases: a stand-in page with the events it was sent, kept.
type win struct {
	*bridgetest.Page
	seen []map[string]any
}

// events are all the events the window was sent so far.
func (w *win) events() []map[string]any {
	for _, raw := range w.Drain(30 * time.Millisecond) {
		var ev map[string]any
		if json.Unmarshal([]byte(raw), &ev) == nil {
			w.seen = append(w.seen, ev)
		}
	}
	return w.seen
}

// of are the events of this type about the board.
func (w *win) of(typ, board string) (got []map[string]any) {
	for _, ev := range w.events() {
		if ev["type"] == typ && (board == "" || ev["board"] == board) {
			got = append(got, ev)
		}
	}
	return got
}

// waitFor waits up to patience for n events of the type about the board, and returns them.
func (w *win) waitFor(t *testing.T, typ, board string, n int) []map[string]any {
	t.Helper()
	for deadline := time.Now().Add(patience); ; time.Sleep(20 * time.Millisecond) {
		if got := w.of(typ, board); len(got) >= n {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("window %s: %d events %q about %s, want %d; seen %v", w.ID, len(w.of(typ, board)), typ, board, n, w.seen)
		}
	}
}

// writers are the kinds the board's writer events of the window name, in order.
func (w *win) writers(board string) (kinds []string) {
	for _, ev := range w.of("writer", board) {
		kinds = append(kinds, fmt.Sprint(ev["writer"]))
	}
	return kinds
}

var windowSeq atomic.Int64

// window connects a stand-in window to the server.
func (in *instance) window(t *testing.T) *win {
	t.Helper()
	id := fmt.Sprintf("a1b2c3d4-0000-4000-8000-%012x", windowSeq.Add(1))
	return &win{Page: in.page(t, id)}
}

// take makes the window the holder of the board.
func (in *instance) take(t *testing.T, w *win, board string) {
	t.Helper()
	var got struct{ State string }
	in.must(t, w.ID, "POST", "/api/boards/"+board+"/take", nil, &got)
	if got.State != "held" {
		t.Fatalf("window %s took %s: %q, want held", w.ID, board, got.State)
	}
}

// follow makes the window follow the board.
func (in *instance) follow(t *testing.T, w *win, board string) {
	t.Helper()
	in.must(t, w.ID, "POST", "/api/boards/"+board+"/follow", nil, nil)
}

// stored is what the server has of a board: its drawing, its revision, and who writes it ("window",
// "headless" or "").
type stored struct {
	scene  string
	rev    int64
	writer string
}

func (in *instance) stored(t *testing.T, board string) stored {
	t.Helper()
	var f struct {
		Rev    int64
		Writer string
	}
	in.must(t, testClient, "POST", "/api/boards/"+board+"/follow", nil, &f) // as a client with no stream: it follows nothing
	status, scene := in.call(t, testClient, "GET", "/api/boards/"+board+"/scene", nil, nil)
	if status != 200 {
		t.Fatalf("scene of %s: %d %s", board, status, scene)
	}
	return stored{scene, f.Rev, f.Writer}
}

// save writes the board's drawing as the window, based on rev, and returns the status and the code
// of a refusal.
func (in *instance) save(t *testing.T, w *win, board string, rev int64, scene string) (int, string) {
	t.Helper()
	status, body := w.Do("PUT", fmt.Sprintf("/api/boards/%s/scene?rev=%d", board, rev), []byte(scene))
	var refused struct{ Code string }
	json.Unmarshal(body, &refused)
	return status, refused.Code
}

// chatOn makes another chat on the board.
func (in *instance) chatOn(t *testing.T, board string) string {
	t.Helper()
	var made struct{ ID string }
	in.must(t, testClient, "POST", "/api/chats", map[string]any{"agent": "claude", "board": board}, &made)
	in.must(t, testClient, "PATCH", "/api/chats/"+made.ID, map[string]any{"cwd": t.TempDir()}, nil)
	return made.ID
}

// sayAsync is say on a goroutine: the reply comes on the channel, "" when the turn did not end.
func (in *instance) sayAsync(t *testing.T, chat, text string) <-chan string {
	ch := make(chan string, 1)
	go func() {
		reply := ""
		defer func() { ch <- reply }()
		reply = in.say(t, chat, text)
	}()
	return ch
}

// timed runs f and returns how long it took.
func timed(f func()) time.Duration {
	start := time.Now()
	f()
	return time.Since(start)
}

// unansweredServer is the server of the cases: the fake claude, the headless writer's stand-in with
// a quiet time long enough to hold a board for the whole test, and the call time lowered. silent is
// the file the stand-in reads the boards it must not answer from; out is where it notes its rpcs.
type unansweredServer struct {
	*instance
	calls  time.Duration
	out    string
	silent string
}

func newUnansweredServer(t *testing.T) *unansweredServer {
	t.Helper()
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH (the fake claude is a Node script)")
	}
	standIn := buildStandIn(t)
	s := &unansweredServer{instance: newInstance(t), calls: fast.of(30 * time.Second), out: t.TempDir()}
	s.claude = agenttest.FakeClaude(t)
	s.silent = filepath.Join(t.TempDir(), "silent")
	s.setenv("STANDIN_OUT="+s.out, "STANDIN_SILENT="+s.silent,
		"AIWB_TEST_WAITS="+strings.TrimPrefix(fast.env(t, "calls", "linger"), "AIWB_TEST_WAITS="))
	if got := s.run(t, "launch", "-headless-node", standIn, "-headless-dir", standInBundle(t)); !strings.Contains(got, "running") {
		t.Fatalf("launch: %s", got)
	}
	s.waitServing(t)
	return s
}

// headlessCalls are the calls the stand-in headless writer was given about the board, as
// "tool read_board <board>" lines.
func (s *unansweredServer) headlessCalls(t *testing.T, board string) (calls []string) {
	t.Helper()
	for _, line := range readLines(t, filepath.Join(s.out, "rpcs")) {
		if strings.HasSuffix(line, " "+board) {
			calls = append(calls, line)
		}
	}
	return calls
}

// A case: a board with a chat, a window that took it and saved a drawing on it, and a reader that
// follows it.
type unansweredCase struct {
	*unansweredServer
	board, chat string
	w, r        *win
	before      stored // what is stored once the window has saved
}

const savedScene = `{"saved":"first"}`

// newCase makes a case. The window w holds the board, at revision 1.
func (s *unansweredServer) newCase(t *testing.T) *unansweredCase {
	t.Helper()
	c := &unansweredCase{unansweredServer: s}
	c.board, c.chat = s.boardChat(t)
	c.w, c.r = s.window(t), s.window(t)
	s.take(t, c.w, c.board)
	if status, code := s.save(t, c.w, c.board, 0, savedScene); status != 200 {
		t.Fatalf("the first save: %d %s", status, code)
	}
	s.follow(t, c.r, c.board)
	c.before = s.stored(t, c.board)
	if c.before.scene != savedScene || c.before.rev != 1 || c.before.writer != "window" {
		t.Fatalf("before: %+v", c.before)
	}
	return c
}

// unchanged checks that the board has the drawing and the revision of the window's save.
func (c *unansweredCase) unchanged(t *testing.T) stored {
	t.Helper()
	got := c.stored(t, c.board)
	if got.scene != c.before.scene || got.rev != c.before.rev {
		t.Fatalf("the board was %q at revision %d, now %q at revision %d", c.before.scene, c.before.rev, got.scene, got.rev)
	}
	return got
}

// notTheWindow checks that the window no longer holds the board: the board has no writer or the
// headless writer holds it, and the window's save is refused.
func (c *unansweredCase) notTheWindow(t *testing.T, w *win) {
	t.Helper()
	if got := c.stored(t, c.board); got.writer == "window" {
		t.Fatalf("a window still writes the board: %+v", got)
	}
	if status, code := c.save(t, w, c.board, c.before.rev, `{"saved":"late"}`); status != 409 || code != "not_holder" {
		t.Fatalf("the save of window %s after it lost the board: %d %q, want 409 not_holder", w.ID, status, code)
	}
	if got := c.stored(t, c.board); got.scene != c.before.scene || got.rev != c.before.rev {
		t.Fatalf("a refused save changed the board: %+v", got)
	}
}

// A window that holds a board and does not answer a call: the goal's 6.1, 6.2 and 6.3 against a
// real server. The cases run side by side on one server; the last, a headless writer that does not
// answer, stops the writer and runs alone.
func TestUnansweredWindow(t *testing.T) {
	serverTest(t, "internal/editorbridge: TestUnansweredWindowLosesTheBoard, TestUnansweredCallLateReplyAndSaveAreIgnored, TestUnansweredAnsweredInTimeKeepsTheBoard, TestUnansweredScreenCallFreesNothing, TestUnansweredTwoCallsFreeTheBoardOnce, TestUnansweredWaiterGetsTheBoard, TestUnansweredBoardGoesToTheAwayClientAtOnce; internal/boardapi: the relay's answers to ErrUnanswered; internal/headless: TestCallTimedOutKills")
	s := newUnansweredServer(t)

	t.Run("cases", func(t *testing.T) {
		// 6.1 A gone window, a read: answered after the call time by the headless writer, the
		// window no longer holds the board, the reader was told, and the next call (a change) is
		// answered at once.
		t.Run("a read is answered by the headless writer", func(t *testing.T) {
			t.Parallel()
			c := s.newCase(t)
			var reply string
			if took := timed(func() { reply = s.say(t, c.chat, "read [[mcp read_board {}]]") }); took < s.calls {
				t.Fatalf("the read ended after %v, before the call time %v", took, s.calls)
			}
			if !strings.Contains(reply, "read_board -> "+standInAnswer) || strings.Contains(reply, "did not answer") {
				t.Fatalf("the agent was told:\n%s", reply)
			}
			if got := s.headlessCalls(t, c.board); !slices.Equal(got, []string{"tool read_board " + c.board}) {
				t.Fatalf("the headless writer was given %q", got)
			}
			c.unchanged(t)
			c.notTheWindow(t, c.w)
			c.w.waitFor(t, "superseded", c.board, 1)
			if w := c.r.waitFor(t, "writer", c.board, 1); w[0]["writer"] != "" {
				t.Fatalf("the reader was told %v first, want a board with no writer", w[0])
			}
			if slices.Contains(c.r.writers(c.board), "window") {
				t.Fatalf("the reader was told of a window: %v", c.r.writers(c.board))
			}

			// The next call of the chat is a change, and the headless writer answers it at once.
			if took := timed(func() { reply = s.say(t, c.chat, `change [[mcp apply {"add":[]}]]`) }); took >= s.calls {
				t.Fatalf("the next call waited %v for a window, the call time is %v", took, s.calls)
			}
			if !strings.Contains(reply, "apply -> "+standInAnswer) {
				t.Fatalf("the agent was told:\n%s", reply)
			}
			if n := len(c.w.of("rpc", "")); n != 1 {
				t.Fatalf("the gone window was asked %d times, want once", n)
			}
		})

		// 6.1 A gone window, a change: it fails after the call time with the text, nothing is
		// repeated, the board is as it was, and the next call (a read) is answered at once.
		t.Run("a change fails with the text and is not repeated", func(t *testing.T) {
			t.Parallel()
			c := s.newCase(t)
			var reply string
			if took := timed(func() { reply = s.say(t, c.chat, `change [[mcp apply {"add":[]}]]`) }); took < s.calls {
				t.Fatalf("the change ended after %v, before the call time %v", took, s.calls)
			}
			if !strings.Contains(reply, "apply -> "+unansweredText+"\n") || strings.Contains(reply, standInAnswer) {
				t.Fatalf("the agent was told:\n%s\nwant\n%s", reply, unansweredText)
			}
			c.unchanged(t)
			c.notTheWindow(t, c.w)
			if got := s.headlessCalls(t, c.board); len(got) != 0 {
				t.Fatalf("the change was repeated to the headless writer: %q", got)
			}
			c.w.waitFor(t, "superseded", c.board, 1)
			if w := c.r.waitFor(t, "writer", c.board, 1); w[0]["writer"] != "" {
				t.Fatalf("the reader was told %v, want a board with no writer", w[0])
			}

			if took := timed(func() { reply = s.say(t, c.chat, "read [[mcp read_board {}]]") }); took >= s.calls {
				t.Fatalf("the next call waited %v for a window, the call time is %v", took, s.calls)
			}
			if !strings.Contains(reply, "read_board -> "+standInAnswer) {
				t.Fatalf("the agent was told:\n%s", reply)
			}
			if n := len(c.w.of("rpc", "")); n != 1 {
				t.Fatalf("the gone window was asked %d times, want once", n)
			}
			c.unchanged(t)
		})

		// 6.2 A window that was only slow: its answer and its save are refused, it was told that
		// it lost the board, and the board holds nothing of it.
		t.Run("a slow window is refused", func(t *testing.T) {
			t.Parallel()
			c := s.newCase(t)
			done := s.sayAsync(t, c.chat, `change [[mcp apply {"add":[{"id":"late"}]}]]`)
			rpc := c.w.waitFor(t, "rpc", "", 1)[0]
			c.w.waitFor(t, "superseded", c.board, 1) // the call time is over
			if status, _ := c.w.Do("POST", "/api/rpc-reply", map[string]any{"id": rpc["id"], "result": "late"}); status != 409 {
				t.Fatalf("the late answer: %d, want 409", status)
			}
			if status, code := s.save(t, c.w, c.board, c.before.rev, `{"saved":"late"}`); status != 409 || code != "not_holder" {
				t.Fatalf("the late save: %d %q, want 409 not_holder", status, code)
			}
			reply := <-done
			if !strings.Contains(reply, "apply -> "+unansweredText+"\n") {
				t.Fatalf("the agent was told:\n%s", reply)
			}
			c.unchanged(t)
			c.notTheWindow(t, c.w)
			if got := s.headlessCalls(t, c.board); len(got) != 0 {
				t.Fatalf("the headless writer was given %q", got)
			}
			if n := len(c.w.of("superseded", c.board)); n != 1 {
				t.Fatalf("the slow window was told it lost the board %d times, want once", n)
			}
		})

		// 6.3 A window that answers within the call time keeps the board and its answer is returned.
		t.Run("a window that answers in time keeps the board", func(t *testing.T) {
			t.Parallel()
			c := s.newCase(t)
			c.w.OnRPC(func(map[string]any) (any, string) {
				time.Sleep(s.calls / 3)
				return "from the window", ""
			})
			for _, text := range []string{"read [[mcp read_board {}]]", `change [[mcp apply {"add":[]}]]`} {
				if reply := s.say(t, c.chat, text); !strings.Contains(reply, " -> from the window\n") {
					t.Fatalf("%s: the agent was told:\n%s", text, reply)
				}
			}
			if got := c.stored(t, c.board); got.writer != "window" {
				t.Fatalf("the writer is %q after two answers in time", got.writer)
			}
			if status, code := s.save(t, c.w, c.board, c.before.rev, `{"saved":"second"}`); status != 200 {
				t.Fatalf("the window's next save: %d %q", status, code)
			}
			if n := len(c.w.of("superseded", c.board)) + len(c.r.writers(c.board)); n != 0 {
				t.Fatalf("the window lost the board or the reader was told of a change: %v", c.r.writers(c.board))
			}
			if got := s.headlessCalls(t, c.board); len(got) != 0 {
				t.Fatalf("the headless writer was given %q", got)
			}
		})

		// 6.3 A call about a screen, given when only the gone window shows the board, is not given to
		// the headless writer and does not free the board.
		t.Run("a screen call never reaches the headless writer", func(t *testing.T) {
			t.Parallel()
			c := s.newCase(t)
			s.follow(t, c.w, c.board)
			reply := s.say(t, c.chat, "view [[mcp get_view {}]] show [[mcp show_board {}]]")
			for _, tool := range []string{"get_view", "show_board"} {
				if !strings.Contains(reply, tool+" -> "+editorbridge.ErrTimeout.Error()+" tool in ") {
					t.Fatalf("%s: the agent was told:\n%s", tool, reply)
				}
			}
			if strings.Contains(reply, standInAnswer) || strings.Contains(reply, unansweredText) {
				t.Fatalf("the agent was told:\n%s", reply)
			}
			if got := s.headlessCalls(t, c.board); len(got) != 0 {
				t.Fatalf("the headless writer was given %q", got)
			}
			if got := c.unchanged(t); got.writer != "window" {
				t.Fatalf("the writer is %q after screen calls", got.writer)
			}
			if n := len(c.w.of("superseded", c.board)); n != 0 {
				t.Fatalf("a screen call took the board from the window")
			}
			if status, code := s.save(t, c.w, c.board, c.before.rev, `{"saved":"second"}`); status != 200 {
				t.Fatalf("the window's next save: %d %q", status, code)
			}
		})

		// 6.3 Two calls waiting at once on the gone window: both end, and the board is freed once.
		t.Run("two calls on one board free it once", func(t *testing.T) {
			t.Parallel()
			c := s.newCase(t)
			other := s.chatOn(t, c.board)
			first := s.sayAsync(t, c.chat, `one [[mcp apply {"add":[]}]]`)
			second := s.sayAsync(t, other, `two [[mcp apply {"add":[]}]]`)
			rpcs := c.w.waitFor(t, "rpc", "", 2)
			for i, done := range []<-chan string{first, second} {
				if reply := <-done; !strings.Contains(reply, "apply -> "+unansweredText+"\n") {
					t.Fatalf("call %d: the agent was told:\n%s", i+1, reply)
				}
			}
			time.Sleep(settle)
			c.unchanged(t)
			c.notTheWindow(t, c.w)
			if n := len(c.w.of("superseded", c.board)); n != 1 {
				t.Fatalf("the window was told it lost the board %d times, want once", n)
			}
			if got := c.r.writers(c.board); !slices.Equal(got, []string{""}) {
				t.Fatalf("the reader was told %q, want one writer event, of a board with no writer", got)
			}
			// No call is left open: the window's answers to both are refused.
			for _, rpc := range rpcs {
				if status, _ := c.w.Do("POST", "/api/rpc-reply", map[string]any{"id": rpc["id"], "result": "late"}); status != 409 {
					t.Fatalf("the answer to %v: %d, want 409", rpc["id"], status)
				}
			}
			if reply := s.say(t, c.chat, "read [[mcp read_board {}]]"); !strings.Contains(reply, "read_board -> "+standInAnswer) {
				t.Fatalf("the next call: %s", reply)
			}
		})

		// 6.3 A person presses Edit here while a call waits on the gone window: the window that
		// asked gets the board when the call ends, once, and no call is left open.
		t.Run("a hand-off during the wait ends in one writer", func(t *testing.T) {
			t.Parallel()
			c := s.newCase(t)
			x := s.window(t)
			done := s.sayAsync(t, c.chat, `change [[mcp apply {"add":[]}]]`)
			rpc := c.w.waitFor(t, "rpc", "", 1)[0]
			var got struct{ State string }
			s.must(t, x.ID, "POST", "/api/boards/"+c.board+"/take", nil, &got)
			if got.State != "waiting" {
				t.Fatalf("the press: %q, want waiting", got.State)
			}
			reply := <-done
			if !strings.Contains(reply, "apply -> "+unansweredText+"\n") {
				t.Fatalf("the agent was told:\n%s", reply)
			}
			x.waitFor(t, "held", c.board, 1)
			c.w.waitFor(t, "superseded", c.board, 1)
			time.Sleep(settle)
			if n := len(x.of("held", c.board)); n != 1 {
				t.Fatalf("the new window was given the board %d times, want once", n)
			}
			if n := len(c.w.of("superseded", c.board)); n != 1 {
				t.Fatalf("the old window was told it lost the board %d times, want once", n)
			}
			if got := c.r.writers(c.board); !slices.Equal(got, []string{"window"}) {
				t.Fatalf("the reader was told %q, want one writer event, of a window", got)
			}
			if status, code := s.save(t, x, c.board, c.before.rev, `{"saved":"x"}`); status != 200 {
				t.Fatalf("the new window's save: %d %q", status, code)
			}
			if status, code := s.save(t, c.w, c.board, c.before.rev+1, `{"saved":"late"}`); status != 409 || code != "not_holder" {
				t.Fatalf("the old window's save: %d %q, want 409 not_holder", status, code)
			}
			if status, _ := c.w.Do("POST", "/api/rpc-reply", map[string]any{"id": rpc["id"], "result": "late"}); status != 409 {
				t.Fatalf("the answer to the call: %d, want 409", status)
			}
			if got := s.headlessCalls(t, c.board); len(got) != 0 {
				t.Fatalf("the headless writer was given %q", got)
			}
		})
	})

	// 6.3 A call given to the headless writer that does not answer: after the call time the process
	// is stopped and the agent is told as it is today; the next call starts another process. Alone,
	// because it stops the writer that the cases above use.
	t.Run("a headless writer that does not answer is stopped", func(t *testing.T) {
		board, chat := s.boardChat(t)
		if err := os.WriteFile(s.silent, []byte(board+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		done := s.sayAsync(t, chat, "read [[mcp read_board {}]]")
		var pid int
		for deadline := time.Now().Add(patience); pid == 0; time.Sleep(50 * time.Millisecond) {
			if len(s.headlessCalls(t, board)) > 0 {
				pid = s.headlessOf(t).PID
			}
			if time.Now().After(deadline) {
				t.Fatalf("the headless writer was not given the call:\n%s", serverLog(t, s.dir))
			}
		}
		reply := <-done
		if !strings.Contains(reply, "read_board -> "+editorbridge.ErrTimeout.Error()+" tool in ") || strings.Contains(reply, unansweredText) {
			t.Fatalf("the agent was told:\n%s", reply)
		}
		waitGone(t, pid)
		if h := s.headlessOf(t); h.Running {
			t.Fatalf("the headless writer still runs: %+v", h)
		}
		if err := os.WriteFile(s.silent, nil, 0o644); err != nil {
			t.Fatal(err)
		}
		if reply := s.say(t, chat, "read again [[mcp read_board {}]]"); !strings.Contains(reply, "read_board -> "+standInAnswer) {
			t.Fatalf("the next call: %s", reply)
		}
		if h := s.headlessOf(t); !h.Running || h.PID == pid {
			t.Fatalf("a new call did not start a new process: %+v, the old one was %d", h, pid)
		}
	})
	noSecret(t, s.secret, serverLog(t, s.dir))
}
