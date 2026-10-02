package pibridge

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
)

// ---- fakes ----------------------------------------------------------------

type fakeActivity struct {
	sub *agent.SubIdentity
	act agent.SubActivity
}

type fakeAsk struct {
	id, name string
	input    string
	sub      *agent.SubIdentity
}

type fakeHandler struct {
	mu         sync.Mutex
	allow      bool
	reason     string
	asks       []fakeAsk
	activities []fakeActivity
	notices    []string
}

func (h *fakeHandler) Permission(toolCallID, toolName string, input json.RawMessage, sub *agent.SubIdentity) (bool, string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.asks = append(h.asks, fakeAsk{id: toolCallID, name: toolName, input: string(input), sub: sub})
	return h.allow, h.reason
}

func (h *fakeHandler) Activity(sub *agent.SubIdentity, act agent.SubActivity) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.activities = append(h.activities, fakeActivity{sub: sub, act: act})
}

func (h *fakeHandler) Notice(message string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.notices = append(h.notices, message)
}

func (h *fakeHandler) recordedNotices() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.notices...)
}

func (h *fakeHandler) setAsk(allow bool, reason string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.allow, h.reason = allow, reason
}

func (h *fakeHandler) lastAsk(t *testing.T) fakeAsk {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.asks) == 0 {
		t.Fatal("no ask recorded")
	}
	return h.asks[len(h.asks)-1]
}

func (h *fakeHandler) lastActivity(t *testing.T) fakeActivity {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.activities) == 0 {
		t.Fatal("no activity recorded")
	}
	return h.activities[len(h.activities)-1]
}

// ---- helpers ---------------------------------------------------------------

func startBridge(t *testing.T) (*Bridge, string) {
	t.Helper()
	path := SocketPath(t.TempDir())
	b := New(path)
	if err := b.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(b.Close)
	return b, path
}

func registerRun(t *testing.T, b *Bridge, chatID, boardToken string, h agent.RunHandler) string {
	t.Helper()
	_, token, err := b.RegisterRun(chatID, boardToken, h)
	if err != nil {
		t.Fatalf("RegisterRun: %v", err)
	}
	return token
}

type testClient struct {
	t    *testing.T
	conn net.Conn
	br   *bufio.Reader
}

func dial(t *testing.T, path string) *testClient {
	t.Helper()
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("dial %s: %v", path, err)
	}
	t.Cleanup(func() { conn.Close() })
	return &testClient{t: t, conn: conn, br: bufio.NewReader(conn)}
}

func (c *testClient) send(v any) {
	c.t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		c.t.Fatalf("marshal: %v", err)
	}
	if _, err := c.conn.Write(append(data, '\n')); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *testClient) recv() map[string]any {
	c.t.Helper()
	if err := c.conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		c.t.Fatalf("deadline: %v", err)
	}
	line, err := c.br.ReadBytes('\n')
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(line, &m); err != nil {
		c.t.Fatalf("decode %q: %v", line, err)
	}
	return m
}

// expectClosed asserts the server closed the connection.
func (c *testClient) expectClosed() {
	c.t.Helper()
	if err := c.conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		c.t.Fatalf("deadline: %v", err)
	}
	_, err := c.br.ReadByte()
	if err == nil {
		c.t.Fatal("expected connection close, read succeeded")
	}
	if ne, ok := err.(net.Error); ok && ne.Timeout() {
		c.t.Fatal("timed out waiting for close")
	}
}

func respondOK(t *testing.T, resp map[string]any, id string) {
	t.Helper()
	if resp["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", resp["ok"], resp)
	}
	if got := resp["id"]; got != id {
		t.Fatalf("id = %v, want %q", got, id)
	}
}

// ---- tests -----------------------------------------------------------------

func TestUnknownRunTokenClosesWithoutDispatch(t *testing.T) {
	h := &fakeHandler{allow: true}
	b, path := startBridge(t)
	registerRun(t, b, "chat-1", "board-token-1", h)

	// A frame naming an unknown run is closed without dispatch.
	c := dial(t, path)
	c.send(map[string]any{"kind": "ask", "run": "0123456789abcdef0123456789abcdef", "id": "x", "name": "bash"})
	c.expectClosed()

	// A missing token is also unknown.
	c2 := dial(t, path)
	c2.send(map[string]any{"kind": "ask", "id": "y", "name": "bash"})
	c2.expectClosed()

	if asks := h.snapshotAsks(); len(asks) != 0 {
		t.Fatalf("handler saw asks for an unknown token: %+v", asks)
	}
}

func TestResolveBoardToken(t *testing.T) {
	b, _ := startBridge(t)
	token := registerRun(t, b, "chat-1", "board-token-1", nil)

	if got, ok := b.ResolveBoardToken(token); !ok || got != "board-token-1" {
		t.Fatalf("registered = %q, %v; want board-token-1, true", got, ok)
	}
	if got, ok := b.ResolveBoardToken("0123456789abcdef0123456789abcdef"); ok || got != "" {
		t.Fatalf("unknown = %q, %v; want empty, false", got, ok)
	}
	if got, ok := b.ResolveBoardToken(""); ok || got != "" {
		t.Fatalf("empty = %q, %v; want empty, false", got, ok)
	}

	// A plain chat registers with an empty board token but still resolves.
	plain := registerRun(t, b, "chat-2", "", nil)
	if got, ok := b.ResolveBoardToken(plain); !ok || got != "" {
		t.Fatalf("plain chat = %q, %v; want empty, true", got, ok)
	}

	b.DeregisterRun(token)
	if got, ok := b.ResolveBoardToken(token); ok || got != "" {
		t.Fatalf("after deregister = %q, %v; want empty, false", got, ok)
	}
}

func TestAskAllowAndDeny(t *testing.T) {
	h := &fakeHandler{allow: true}
	b, path := startBridge(t)
	token := registerRun(t, b, "chat-1", "board-token-1", h)
	c := dial(t, path)

	c.send(map[string]any{"kind": "ask", "run": token, "id": "ask1", "name": "bash", "input": map[string]any{"command": "ls"}})
	resp := c.recv()
	if resp["ok"] != true || resp["id"] != "ask1" || resp["allow"] != true {
		t.Fatalf("allow response = %v", resp)
	}
	ask := h.lastAsk(t)
	if ask.id != "ask1" || ask.name != "bash" || ask.input != `{"command":"ls"}` || ask.sub != nil {
		t.Fatalf("ask = %+v", ask)
	}

	h.setAsk(false, "the user said no")
	sub := &agent.SubIdentity{Parent: "p1", Depth: 1, Child: "child-1"}
	c.send(map[string]any{"kind": "ask", "run": token, "id": "ask2", "name": "write", "input": map[string]any{"path": "x"}, "sub": sub})
	resp = c.recv()
	if resp["ok"] != true || resp["id"] != "ask2" || resp["allow"] != false || resp["reason"] != "the user said no" {
		t.Fatalf("deny response = %v", resp)
	}
	ask = h.lastAsk(t)
	if ask.id != "ask2" || ask.sub == nil || *ask.sub != *sub {
		t.Fatalf("ask with sub = %+v (sub %+v)", ask, ask.sub)
	}
}

func TestNoticeRoutedToHandlerAndUnknownKindErrors(t *testing.T) {
	h := &fakeHandler{}
	b, path := startBridge(t)
	token := registerRun(t, b, "chat-1", "board-token-1", h)
	c := dial(t, path)

	// A notice frame reaches the handler and answers ok:true.
	c.send(map[string]any{
		"kind": "notice", "run": token, "id": "notice-1",
		"error": `server "board" failed: MCP initialize failed: connect ECONNREFUSED`,
	})
	respondOK(t, c.recv(), "notice-1")
	notices := h.recordedNotices()
	if len(notices) != 1 || notices[0] != `server "board" failed: MCP initialize failed: connect ECONNREFUSED` {
		t.Fatalf("handler notices = %q, want the frame message", notices)
	}

	// The notice is not mistaken for an ask/activity/tool frame.
	h.mu.Lock()
	asks := len(h.asks)
	activities := len(h.activities)
	h.mu.Unlock()
	if asks != 0 {
		t.Fatalf("notice produced %d asks", asks)
	}
	if activities != 0 {
		t.Fatalf("notice produced %d activities", activities)
	}

	// An unknown kind is still refused with the exact error string.
	c.send(map[string]any{"kind": "bogus", "run": token, "id": "bad-1"})
	resp := c.recv()
	if resp["ok"] != false || resp["id"] != "bad-1" || resp["error"] != "unknown kind bogus" {
		t.Fatalf("unknown kind response = %v", resp)
	}
}

// TestToolFrameRetired pins the Phase 5 retirement: the UDS "tool" frame no
// longer exists in the frozen contract, so the bridge refuses it like any
// unknown kind and never dispatches it (A11). ask/activity/abort/notice remain
// covered by the other bridge tests.
func TestToolFrameRetired(t *testing.T) {
	h := &fakeHandler{}
	b, path := startBridge(t)
	token := registerRun(t, b, "chat-1", "board-token-1", h)
	c := dial(t, path)

	c.send(map[string]any{"kind": "tool", "run": token, "id": "tool-1", "name": "list_boards", "input": map[string]any{}})
	resp := c.recv()
	if resp["ok"] != false || resp["id"] != "tool-1" || resp["error"] != "unknown kind tool" {
		t.Fatalf("tool frame response = %v, want unknown kind tool", resp)
	}

	h.mu.Lock()
	asks, activities, notices := len(h.asks), len(h.activities), len(h.notices)
	h.mu.Unlock()
	if asks != 0 || activities != 0 || notices != 0 {
		t.Fatalf("retired tool frame reached the handler: asks=%d activities=%d notices=%d", asks, activities, notices)
	}
}

func TestActivityRoutedWithSubIdentity(t *testing.T) {
	h := &fakeHandler{}
	b, path := startBridge(t)
	token := registerRun(t, b, "chat-1", "board-token-1", h)
	c := dial(t, path)

	sub := map[string]any{"parent": "tool-9", "depth": 2, "child": "child-9"}
	c.send(map[string]any{
		"kind": "activity", "run": token, "id": "ev1", "sub": sub,
		"event": map[string]any{"type": "text", "id": "m1", "text": "hello"},
	})
	respondOK(t, c.recv(), "ev1")
	act := h.lastActivity(t)
	if act.sub == nil || act.sub.Parent != "tool-9" || act.sub.Depth != 2 || act.sub.Child != "child-9" {
		t.Fatalf("sub = %+v", act.sub)
	}
	if act.act.Type != "text" || act.act.ID != "m1" || act.act.Text != "hello" {
		t.Fatalf("activity = %+v", act.act)
	}

	// A malformed event answers ok:false and never reaches the handler.
	c.send(map[string]any{"kind": "activity", "run": token, "id": "ev2", "event": "oops"})
	resp := c.recv()
	if resp["ok"] != false || resp["id"] != "ev2" || !strings.Contains(resp["error"].(string), "bad activity") {
		t.Fatalf("bad activity response = %v", resp)
	}
	if len(h.activities) != 1 {
		t.Fatalf("handler activities = %d, want 1", len(h.activities))
	}
}

func TestHelloAbortAndDeregister(t *testing.T) {
	h := &fakeHandler{}
	b, path := startBridge(t)
	token := registerRun(t, b, "chat-1", "board-token-1", h)

	c1 := dial(t, path)
	c1.send(map[string]any{"kind": "hello", "run": token, "id": "hello"})
	respondOK(t, c1.recv(), "hello")
	c2 := dial(t, path)
	c2.send(map[string]any{"kind": "hello", "run": token, "id": "hello2"})
	respondOK(t, c2.recv(), "hello2")

	b.AbortRun(token)
	for i, c := range []*testClient{c1, c2} {
		resp := c.recv()
		if resp["kind"] != "abort" || resp["run"] != token {
			t.Fatalf("conn %d abort frame = %v", i, resp)
		}
	}

	b.DeregisterRun(token)
	c1.expectClosed()
	c2.expectClosed()

	// The old token is gone: a fresh connection is closed without dispatch.
	c3 := dial(t, path)
	c3.send(map[string]any{"kind": "hello", "run": token, "id": "hello3"})
	c3.expectClosed()
}

func TestReRegisterReplacesPreviousRun(t *testing.T) {
	h := &fakeHandler{}
	b, path := startBridge(t)
	old := registerRun(t, b, "chat-1", "board-token-old", h)

	c := dial(t, path)
	c.send(map[string]any{"kind": "hello", "run": old, "id": "hello"})
	respondOK(t, c.recv(), "hello")

	fresh := registerRun(t, b, "chat-1", "board-token-new", h)
	if fresh == old {
		t.Fatal("re-registration reused the old token")
	}
	c.expectClosed()

	// The new token works and abort reaches its connections.
	c2 := dial(t, path)
	c2.send(map[string]any{"kind": "hello", "run": fresh, "id": "hello2"})
	respondOK(t, c2.recv(), "hello2")
	b.AbortRun(fresh)
	if resp := c2.recv(); resp["kind"] != "abort" {
		t.Fatalf("abort frame = %v", resp)
	}
	// Aborting the replaced token is a no-op.
	b.AbortRun(old)
}

func TestCloseRemovesSocketAndIsIdempotent(t *testing.T) {
	b, path := startBridge(t)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("socket missing before Close: %v", err)
	}
	b.Close()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("socket still present after Close: %v", err)
	}
	b.Close() // safe twice

	if conn, err := net.Dial("unix", path); err == nil {
		conn.Close()
		t.Fatal("dial succeeded after Close")
	}
}

func TestSocketAndParentDirModes(t *testing.T) {
	_, path := startBridge(t)
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat socket: %v", err)
	}
	if got := fi.Mode().Perm(); got != 0o600 {
		t.Fatalf("socket mode = %o, want 600", got)
	}
	di, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatalf("stat dir: %v", err)
	}
	if got := di.Mode().Perm(); got != 0o700 {
		t.Fatalf("dir mode = %o, want 700", got)
	}
}

func TestStaleSocketFileIsReplaced(t *testing.T) {
	dir := t.TempDir()
	path := SocketPath(dir)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}

	b := New(path)
	if err := b.Start(); err != nil {
		t.Fatalf("Start over stale file: %v", err)
	}
	t.Cleanup(b.Close)
	token := registerRun(t, b, "chat-1", "bt", nil)

	c := dial(t, path)
	c.send(map[string]any{"kind": "hello", "run": token, "id": "h"})
	respondOK(t, c.recv(), "h")
}

func TestSocketPathFallback(t *testing.T) {
	short := t.TempDir()
	if got, want := SocketPath(short), filepath.Join(short, "bridge.sock"); got != want {
		t.Fatalf("short root path = %q, want %q", got, want)
	}

	long := filepath.Join(t.TempDir(), strings.Repeat("a", 200))
	got := SocketPath(long)
	if got == filepath.Join(long, "bridge.sock") {
		t.Fatal("long root did not fall back")
	}
	if got != SocketPath(long) {
		t.Fatal("fallback path is not deterministic")
	}
	if len(got) > 100 {
		t.Fatalf("fallback path too long: %d bytes", len(got))
	}
	if !strings.HasPrefix(got, os.TempDir()) {
		t.Fatalf("fallback %q is not under os.TempDir %q", got, os.TempDir())
	}
	if !strings.HasPrefix(filepath.Base(filepath.Dir(got)), "aiwb-") {
		t.Fatalf("fallback dir %q lacks aiwb- prefix", filepath.Dir(got))
	}
}
