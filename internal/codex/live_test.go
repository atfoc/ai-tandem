//go:build !windows

package codex

// Real-CLI test. It talks to the real, logged-in `codex` with one tiny turn, so it only runs when
// the caller opts in:
//
//	AIWB_CODEX_E2E=1 go test -count=1 -v -run TestLive ./internal/codex/
//
// It exists because the profile bug it guards (a config that defines Tandem's permission profile
// but names no default: thread/start succeeds and the first turn fails with "failed to load
// workspace requirements: invalid input parameter") cannot be seen against the fake server.
// The app folder and the working folder are temp dirs; a missing binary skips the test.

import (
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
)

func TestLiveTurnWithTandemProfile(t *testing.T) {
	if os.Getenv("AIWB_CODEX_E2E") != "1" {
		t.Skip("set AIWB_CODEX_E2E=1 to run against the real Codex CLI")
	}
	if _, err := exec.LookPath("codex"); err != nil {
		t.Skip("codex is not installed")
	}
	s := &Spawner{AppRoot: t.TempDir()}
	a, err := s.Spawn(agent.SpawnOptions{Cwd: t.TempDir(), Effort: "low"})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if err := a.Send([]agent.ContentBlock{{Text: "Reply with the single word OK. Do not run any commands."}}); err != nil {
		t.Fatal(err)
	}

	var text strings.Builder
	timer := time.NewTimer(2 * time.Minute)
	defer timer.Stop()
	for {
		select {
		case e, ok := <-a.Events():
			if !ok {
				t.Fatal("Codex exited before the turn ended")
			}
			switch e.Kind {
			case agent.EvTextDelta, agent.EvText:
				text.WriteString(e.Text)
			case agent.EvExit:
				t.Fatalf("Codex exited: %s", e.ExitErr)
			case agent.EvTurnEnd:
				if e.Error != "" {
					t.Fatalf("turn failed: %s", e.Error)
				}
				if !strings.Contains(text.String(), "OK") {
					t.Fatalf("reply = %q, want it to contain OK", text.String())
				}
				return
			}
		case <-timer.C:
			t.Fatal("no turn end within 2 minutes")
		}
	}
}
