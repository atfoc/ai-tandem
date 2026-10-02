package boardapi

import (
	"bytes"
	"log"
	"strings"
	"sync"
	"testing"
	"time"
)

// captureLog redirects the standard logger for the test and returns the buffer it writes to.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	oldOut, oldFlags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	t.Cleanup(func() { log.SetOutput(oldOut); log.SetFlags(oldFlags) })
	return &buf
}

// A tools/call writes exactly one structured access line: the old separate "board tool" detail
// line is gone, the arguments are left out, and the credential never appears.
func TestToolCallLogsOneStructuredLine(t *testing.T) {
	e := newEnv(t)
	buf := captureLog(t)
	// No browser client is connected in this env, so the call answers at once with an error.
	e.fixed("Bearer "+e.token, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_board","arguments":{"secret":"hunter2"}}}`)
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("got %d log lines, want 1:\n%s", len(lines), buf.String())
	}
	line := lines[0]
	for _, want := range []string{"mcp tools/call", "chat=" + short(e.chat), `tool="read_board"`, "outcome=error"} {
		if !strings.Contains(line, want) {
			t.Fatalf("log line %q does not contain %q", line, want)
		}
	}
	for _, bad := range []string{e.token, "hunter2", "secret"} {
		if strings.Contains(line, bad) {
			t.Fatalf("log line %q leaks %q", line, bad)
		}
	}
}

// initialize writes one line with the client name/version and resolves the chat; an unknown
// credential is logged as unknown, never with the credential itself.
func TestInitializeLogsChatAndClient(t *testing.T) {
	e := newEnv(t)
	buf := captureLog(t)
	body := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"probe","version":"9.9"}}}`
	e.fixed("Bearer "+e.token, body)
	e.fixed("Bearer bogus-credential-value", body)
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d log lines, want 2:\n%s", len(lines), buf.String())
	}
	if !strings.Contains(lines[0], "chat="+short(e.chat)) ||
		!strings.Contains(lines[0], `client="probe"`) || !strings.Contains(lines[0], `version="9.9"`) {
		t.Fatalf("known initialize line %q", lines[0])
	}
	if !strings.Contains(lines[1], "chat=unknown") {
		t.Fatalf("unknown initialize line %q", lines[1])
	}
	if strings.Contains(lines[1], "bogus-credential-value") || strings.Contains(lines[0], e.token) {
		t.Fatalf("initialize lines leak the credential:\n%s", buf.String())
	}
}

// The contact log is read by the status endpoint on the concurrent 4747 listener while MCP
// requests record to it; run under -race this proves the guard.
func TestContactLogConcurrent(t *testing.T) {
	var l ContactLog
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				l.recordInit("k", "chat", "client", "1")
				l.recordCall("k", "chat", "tool", "ok")
				_ = l.Snapshot()
			}
		}()
	}
	wg.Wait()
	if got := len(l.Snapshot()); got != 1 {
		t.Fatalf("entries %d, want 1", got)
	}
}

// Snapshot returns the last contact per chat, most recent first. Three entries with pinned
// timestamps make the order explicit, so map iteration order cannot decide the result.
func TestContactLogSnapshotOrdersMostRecentFirst(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var l ContactLog
	l.m = map[string]Contact{
		"a": {Chat: "mid", Method: "initialize", At: base.Add(2 * time.Second)},
		"b": {Chat: "newest", Method: "tools/call", At: base.Add(3 * time.Second)},
		"c": {Chat: "oldest", Method: "initialize", At: base.Add(1 * time.Second)},
	}
	got := l.Snapshot()
	want := []string{"newest", "mid", "oldest"}
	if len(got) != len(want) {
		t.Fatalf("got %d contacts, want %d: %+v", len(got), len(want), got)
	}
	for i, w := range want {
		if got[i].Chat != w {
			t.Fatalf("contact %d = %q, want %q (full order %+v)", i, got[i].Chat, w, got)
		}
	}
}
