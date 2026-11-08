//go:build !windows

package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/tlrelay"
)

// The board host's flags are the server's and launch's, passed on as given, like the headless
// writer's (TestHeadlessFlags).
func TestBoardhostFlags(t *testing.T) {
	t.Parallel()
	o := parseFlags("launch", []string{"-home", "/data/x", "-boardhost-node", "/opt/node", "-boardhost-dir=/opt/boardhost", "-boardhost-quiet", "90s"})
	want := []string{"-home", "/data/x", "-boardhost-dir=/opt/boardhost", "-boardhost-node=/opt/node", "-boardhost-quiet=1m30s"}
	if !slices.Equal(o.serveArgs, want) || o.boardhostNode != "/opt/node" || o.boardhostDir != "/opt/boardhost" || o.boardhostQuiet != 90*time.Second {
		t.Fatalf("serveArgs %q, node %q, dir %q, quiet %v; want %q", o.serveArgs, o.boardhostNode, o.boardhostDir, o.boardhostQuiet, want)
	}
	back := parseFlags("serve", o.serveArgs)
	if back.boardhostNode != o.boardhostNode || back.boardhostDir != o.boardhostDir || back.boardhostQuiet != o.boardhostQuiet {
		t.Fatalf("serve read %q %q %v back", back.boardhostNode, back.boardhostDir, back.boardhostQuiet)
	}
	o = parseFlags("serve", []string{"-home", "/data/x"})
	if o.boardhostNode != "" || o.boardhostDir != "" || o.boardhostQuiet != 60*time.Second || !slices.Equal(o.serveArgs, []string{"-home", "/data/x"}) {
		t.Fatalf("defaults: node %q, dir %q, quiet %v, serveArgs %q", o.boardhostNode, o.boardhostDir, o.boardhostQuiet, o.serveArgs)
	}
}

// -boardhost-quiet must be above 0: the program ends with 2 and says so.
func TestBoardhostQuietMustBePositive(t *testing.T) {
	t.Parallel()
	if os.Getenv("AIWB_TEST_BAD_BHQUIET") == "1" {
		parseFlags("serve", []string{"-home", t.TempDir(), "-boardhost-quiet", "0s"})
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run", "^TestBoardhostQuietMustBePositive$")
	cmd.Env = append(os.Environ(), "AIWB_TEST_BAD_BHQUIET=1")
	out, err := cmd.CombinedOutput()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 2 || !strings.Contains(string(out), "-boardhost-quiet 0s: the time must be above 0") {
		t.Fatalf("a quiet time of 0: %v\n%s", err, out)
	}
}

// The board host's manager is the headless writer's made with the board host's names, the flags and
// the room quiet (30 s); quiet= of AIWB_TEST_WAITS lowers the relay's quiet to it and the room quiet
// to half of it, and hstart and linger are the headless writer's.
func TestBoardhostOptions(t *testing.T) {
	t.Parallel()
	flags := options{boardhostNode: "/opt/node", boardhostDir: "/opt/boardhost", boardhostQuiet: 90 * time.Second}
	got := (testWaits{}).boardhostOptions(flags)
	if got.Program != "boardhost.mjs" || got.Folder != "boardhost" || got.Name != "board host" || got.NodeEnv != "AIWB_BOARDHOST_NODE" ||
		got.Node != "/opt/node" || got.Dir != "/opt/boardhost" || got.Quiet != 30*time.Second || got.StartLimit != 0 || got.Linger != 0 {
		t.Fatalf("without the waits: %+v", got)
	}
	if q := (testWaits{}).boardhostQuiet(flags); q != 90*time.Second {
		t.Fatalf("the relay's quiet without the waits: %v", q)
	}
	w := testWaits{quiet: 6 * time.Second, hstart: 4 * time.Second, linger: 200 * time.Millisecond}
	got = w.boardhostOptions(flags)
	if got.Quiet != 3*time.Second || got.StartLimit != 4*time.Second || got.Linger != 200*time.Millisecond {
		t.Fatalf("with the waits: %+v", got)
	}
	if q := w.boardhostQuiet(flags); q != 6*time.Second {
		t.Fatalf("the relay's quiet with the waits: %v", q)
	}
}

// `status -json` tells what the server tells under "boardhost", and null for a server that tells
// nothing; `status` says it in words.
func TestStatusJSONBoardhost(t *testing.T) {
	t.Parallel()
	run := func(t *testing.T, s *standIn) (string, string) {
		t.Helper()
		home := t.TempDir()
		own(t, "remote", "setup", "-home", home, "-port", "5099", "-name", "wb.example")
		asThisFolders(t, home, standInID)
		s.withPid(t).this(t, home, true)
		jsonOut, _, code := own(t, "status", "-json", "-home", home)
		if code != 0 {
			t.Fatalf("status -json: code %d: %s", code, jsonOut)
		}
		words, _, _ := own(t, "status", "-home", home)
		return jsonOut, words
	}
	boardhostOf := func(t *testing.T, out string) any {
		t.Helper()
		var r struct{ Running map[string]any }
		if err := json.Unmarshal([]byte(out), &r); err != nil {
			t.Fatal(err)
		}
		b, has := r.Running["boardhost"]
		if !has {
			t.Fatalf("running has no boardhost: %s", out)
		}
		return b
	}
	for name, c := range map[string]struct {
		status tlrelay.Status
		words  string
	}{
		"running": {tlrelay.Status{Available: true, Running: true, PID: 4243, Sessions: 2,
			Calls: map[string]*tlrelay.Counts{"apply": {OK: 3, Timeout: 1}}, ScreenCalls: 1}, "Board host: running (pid 4243, 2 sessions)\n"},
		"available":   {tlrelay.Status{Available: true, Calls: map[string]*tlrelay.Counts{}}, "Board host: available, not running\n"},
		"unavailable": {tlrelay.Status{Reason: "node is not on the PATH", Calls: map[string]*tlrelay.Counts{}}, "Board host: not available: node is not on the PATH\n"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			jsonOut, words := run(t, &standIn{version: "1.2.3", listening: true, port: 5123, boardhost: c.status})
			var want map[string]any
			wantRaw, _ := json.Marshal(c.status)
			json.Unmarshal(wantRaw, &want)
			got, _ := boardhostOf(t, jsonOut).(map[string]any)
			if !reflect.DeepEqual(got, want) || len(got) != 7 || !strings.Contains(words, c.words) {
				t.Fatalf("boardhost %v, want %v (all seven fields); status:\n%s", got, want, words)
			}
		})
	}
	t.Run("a server that tells nothing", func(t *testing.T) {
		t.Parallel()
		jsonOut, words := run(t, &standIn{version: "1.2.3", listening: true, port: 5123})
		if b := boardhostOf(t, jsonOut); b != nil || strings.Contains(words, "Board host") {
			t.Fatalf("boardhost %v; status:\n%s", b, words)
		}
	})
}
