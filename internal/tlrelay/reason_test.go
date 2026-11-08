package tlrelay

import (
	"context"
	"strings"
	"testing"

	"ai-whiteboard/internal/headless"
)

type noBridge struct{}

func (noBridge) Known(string) bool    { return false }
func (noBridge) SetAway(string)       {}
func (noBridge) HoldsAny(string) bool { return false }
func (noBridge) HasCalls(string) bool { return false }

// The reason in the open's 503 and in the agent's UNAVAILABLE text is the manager's reason alone,
// without its "the board host is not available: " (a real manager with the board host's options and
// a bundle folder that does not exist: no process is started).
func TestReasonOfBoardHostManager(t *testing.T) {
	t.Parallel()
	m := headless.New(noBridge{}, headless.Listener{Secret: func() string { return "" }}, headless.Options{
		Program: "boardhost.mjs", Folder: "boardhost", Name: "board host", NodeEnv: "AIWB_BOARDHOST_NODE",
		Node: "/nonexistent/node", Dir: t.TempDir() + "/missing"})
	defer m.Close()
	_, err := m.Ensure(context.Background())
	if err == nil {
		t.Fatal("Ensure worked without a bundle")
	}
	got := reasonOf(err)
	if strings.Contains(got, "not available") || got == "" {
		t.Fatalf("reasonOf(%q) = %q, want the reason without the manager's prefix", err, got)
	}
	if text := UnavailableText(got); strings.Count(text, "board host") != 1 {
		t.Fatalf("UnavailableText = %q, names the board host more than once", text)
	}
}
