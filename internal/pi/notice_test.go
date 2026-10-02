package pi

import (
	"fmt"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
)

// TestNoticeLogsWithRunContext pins the A8 server-side log: the notice reaches
// the pi adapter and is logged with the chat and run context.
func TestNoticeLogsWithRunContext(t *testing.T) {
	var lines []string
	old := noticeLog
	noticeLog = func(format string, args ...any) {
		lines = append(lines, fmt.Sprintf(format, args...))
	}
	defer func() { noticeLog = old }()

	p := &proc{o: agent.SpawnOptions{ChatID: "chat-1"}, runToken: "run-abc"}
	p.Notice(`server "board" failed: MCP initialize failed: connect ECONNREFUSED`)
	if len(lines) != 1 {
		t.Fatalf("notice log lines = %d, want 1 (%v)", len(lines), lines)
	}
	line := lines[0]
	if !strings.Contains(line, "chat=chat-1") {
		t.Fatalf("notice log line %q lacks the chat id", line)
	}
	if !strings.Contains(line, "run=run-abc") {
		t.Fatalf("notice log line %q lacks the bridge run handle", line)
	}
	if !strings.Contains(line, `server "board" failed`) {
		t.Fatalf("notice log line %q lacks the message", line)
	}

	// An empty message is a no-op.
	p.Notice("")
	if len(lines) != 1 {
		t.Fatalf("empty notice logged %d lines, want 1", len(lines))
	}
}
