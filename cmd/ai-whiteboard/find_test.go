//go:build !windows

package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/store"
)

// Each command that looks for a running server finds one of this build, through the control
// socket, and one of the build before, through its loopback port; and it does not take a stale
// server.json, another folder's server or another program for it.
func TestFindRunningThisBuild(t *testing.T) {
	t.Parallel()
	for _, serverFile := range []bool{true, false} {
		home := t.TempDir()
		asThisFolders(t, home, standInID)
		(&standIn{version: "1.2.3"}).this(t, home, serverFile)
		run, ok := findRunning(store.NewPaths(home))
		if !ok || run.build != thisBuild || run.hello.Version != "1.2.3" || run.hello.FeatureLevel != 7 || run.control != store.ControlSocketPath(home) {
			t.Fatalf("server.json written %v: %+v, %v", serverFile, run, ok)
		}
		// The folder by another path: a symlink to it is the same folder.
		link := filepath.Join(t.TempDir(), "link")
		if err := os.Symlink(home, link); err != nil {
			t.Fatal(err)
		}
		if run, ok := findRunning(store.NewPaths(link)); serverFile && (!ok || run.build != thisBuild) {
			t.Fatalf("by a link to the folder: %+v, %v", run, ok)
		}
	}
}

func TestFindRunningIgnoresWhatIsNotThisFolders(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		stand *standIn
		id    string // the folder's instance id; none when ""
	}{
		{"another folder's instance id", &standIn{instanceID: otherID}, standInID},
		{"a folder with no instance id", &standIn{}, ""},
		{"a copy of the folder", &standIn{home: filepath.Join(os.TempDir(), "aiwb-the-original")}, standInID},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			home := t.TempDir()
			if tc.id != "" {
				asThisFolders(t, home, tc.id)
			}
			tc.stand.this(t, home, true)
			if run, ok := findRunning(store.NewPaths(home)); ok {
				t.Fatalf("found %+v", run)
			}
		})
	}
	t.Run("a stale server.json and no socket", func(t *testing.T) {
		t.Parallel()
		home := t.TempDir()
		asThisFolders(t, home, standInID)
		sf := store.ServerFile{PID: 1, Port: 4748, Control: store.ControlSocketPath(home), Started: time.Now()}
		if err := store.WriteJSONAtomic(store.NewPaths(home).Server, sf, 0o600); err != nil {
			t.Fatal(err)
		}
		if run, ok := findRunning(store.NewPaths(home)); ok {
			t.Fatalf("found %+v", run)
		}
	})
	t.Run("another program on the socket", func(t *testing.T) {
		t.Parallel()
		home := t.TempDir()
		asThisFolders(t, home, standInID)
		(&standIn{}).this(t, home, false)
		// The app is not ours: the same stand-in under another name.
		other := t.TempDir()
		asThisFolders(t, other, standInID)
		ln := serveRaw(t, store.ControlSocketPath(other), `{"app":"something-else","instanceId":"`+standInID+`","dataDir":"`+other+`"}`)
		defer ln()
		if run, ok := findRunning(store.NewPaths(other)); ok {
			t.Fatalf("found %+v", run)
		}
	})
}

func TestFindRunningOlderBuild(t *testing.T) {
	t.Parallel()
	t.Run("through server.json, which has no control socket", func(t *testing.T) {
		t.Parallel()
		home := t.TempDir()
		asThisFolders(t, home, standInID)
		s := (&standIn{version: "0.9.0"}).withPid(t)
		s.older(t, home, true)
		run, ok := findRunning(store.NewPaths(home))
		if !ok || run.build != olderBuild || run.hello.Version != "0.9.0" || run.hello.Pid != s.pid || run.hello.FeatureLevel != 5 {
			t.Fatalf("%+v, %v", run, ok)
		}
	})
	t.Run("a folder that has no instance id yet", func(t *testing.T) {
		t.Parallel()
		home := t.TempDir()
		s := (&standIn{}).withPid(t)
		s.older(t, home, true)
		if run, ok := findRunning(store.NewPaths(home)); !ok || run.build != olderBuild {
			t.Fatalf("%+v, %v", run, ok)
		}
	})
	t.Run("a build that states no feature level", func(t *testing.T) {
		t.Parallel()
		home := t.TempDir()
		s := (&standIn{level: -1}).withPid(t)
		s.older(t, home, true)
		if run, ok := findRunning(store.NewPaths(home)); !ok || run.hello.FeatureLevel != 0 {
			t.Fatalf("%+v, %v", run, ok)
		}
	})
	for name, tc := range map[string]struct {
		stand *standIn
		id    string
	}{
		"another folder's instance id": {&standIn{instanceID: otherID}, standInID},
		"a copy of the folder":         {&standIn{home: filepath.Join(os.TempDir(), "aiwb-the-original")}, standInID},
		"a hello with no pid":          {&standIn{}, standInID},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			home := t.TempDir()
			asThisFolders(t, home, tc.id)
			s := tc.stand
			if name != "a hello with no pid" {
				s.withPid(t)
			}
			s.older(t, home, true)
			if run, ok := findRunning(store.NewPaths(home)); ok {
				t.Fatalf("found %+v", run)
			}
		})
	}
	t.Run("a server of this build is preferred, and a server.json with a control socket names no port", func(t *testing.T) {
		t.Parallel()
		home := t.TempDir()
		asThisFolders(t, home, standInID)
		old := (&standIn{}).withPid(t)
		old.older(t, home, true)
		(&standIn{}).this(t, home, true)
		if run, ok := findRunning(store.NewPaths(home)); !ok || run.build != thisBuild {
			t.Fatalf("%+v, %v", run, ok)
		}
	})
}

// On the legacy port, 4747 in production, with no server.json. legacyPort is one value for the
// process, so this test does not run in parallel with the others.
func TestFindRunningOnTheLegacyPort(t *testing.T) {
	home := t.TempDir()
	asThisFolders(t, home, standInID)
	s := (&standIn{version: "0.9.0"}).withPid(t)
	s.older(t, home, false)
	run, ok := findRunning(store.NewPaths(home))
	if !ok || run.build != olderBuild || run.hello.Version != "0.9.0" {
		t.Fatalf("%+v, %v", run, ok)
	}
	if run, ok := findRunning(store.NewPaths(t.TempDir())); ok && run.hello.Pid == s.pid {
		t.Fatalf("another folder, which has no instance id, found %+v", run)
	}
}

// ---- launch ----------------------------------------------------------------------------------

// launch finds the server running and writes its address and fingerprint; with -json one line for
// the app; for a server of the build before, which it never stops, the words that offer the restart.
func TestLaunchFindsTheRunningServer(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	asThisFolders(t, home, standInID)
	s := &standIn{version: "1.2.3", listening: true, port: 5123, fingerprint: "AB:CD:EF"}
	s.withPid(t).this(t, home, true)

	var out, errOut bytes.Buffer
	if code := launch(options{paths: store.NewPaths(home)}, &out, &errOut); code != 0 || errOut.Len() != 0 ||
		out.String() != "AI Whiteboard is running.\nAddress: https://127.0.0.1:5123\nFingerprint: AB:CD:EF\n" {
		t.Fatalf("code %d, stdout %q, stderr %q", code, out.String(), errOut.String())
	}

	out.Reset()
	if code := launch(options{paths: store.NewPaths(home), json: true}, &out, &errOut); code != 0 || errOut.Len() != 0 {
		t.Fatalf("-json: code %d, stderr %q", code, errOut.String())
	}
	var got map[string]any
	if err := json.Unmarshal(out.Bytes(), &got); err != nil || bytes.Count(out.Bytes(), []byte("\n")) != 1 {
		t.Fatalf("-json wrote %q (%v)", out.String(), err)
	}
	want := map[string]any{"state": "running", "address": "https://127.0.0.1:5123", "fingerprint": "AB:CD:EF", "version": "1.2.3",
		"featureLevel": float64(7), "instanceId": standInID, "pid": float64(s.pid), "home": home}
	if len(got) != len(want) {
		t.Errorf("-json fields %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("-json %s = %v, want %v", k, got[k], v)
		}
	}
	if !s.alive() {
		t.Fatal("launch ended the running server")
	}
}

func TestLaunchKeepsTheOlderBuild(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	asThisFolders(t, home, standInID)
	s := (&standIn{version: "0.9.0"}).withPid(t)
	s.older(t, home, true)

	var out, errOut bytes.Buffer
	if code := launch(options{paths: store.NewPaths(home)}, &out, &errOut); code != 0 || errOut.Len() != 0 {
		t.Fatalf("code %d, stderr %q", code, errOut.String())
	}
	want := "An AI Whiteboard server of an older build (version 0.9.0, pid " + strconv.Itoa(s.pid) + ") is running. Restart it with: \"" + exePath() + "\" relaunch -home \"" + home + "\"\n"
	if out.String() != want {
		t.Fatalf("stdout %q, want %q", out.String(), want)
	}
	out.Reset()
	launch(options{paths: store.NewPaths(home), json: true}, &out, &errOut)
	wantJSON := `{"state":"old_build","version":"0.9.0","featureLevel":5,"pid":` + strconv.Itoa(s.pid) + `,"home":` + jsonString(home) + "}\n"
	if out.String() != wantJSON {
		t.Fatalf("-json wrote %q, want %q", out.String(), wantJSON)
	}
	if !s.alive() {
		t.Fatal("launch stopped the server of the build before")
	}
}

// A server that was never set up is not started: launch fails with the check's message, which
// names the set-up command, and starts nothing.
func TestLaunchOfAFolderNeverSetUp(t *testing.T) {
	t.Parallel()
	home := filepath.Join(t.TempDir(), "data")
	var out, errOut bytes.Buffer
	if code := launch(options{paths: store.NewPaths(home), serveArgs: []string{"-home", home}}, &out, &errOut); code != 1 || out.Len() != 0 {
		t.Fatalf("code %d, stdout %q", code, out.String())
	}
	want := "AI Whiteboard: the server was not started\nAI Whiteboard is not set up on this machine. Set it up once with: \"" + exePath() + "\" remote setup -home \"" + home + "\"\n"
	if errOut.String() != want {
		t.Fatalf("stderr %q, want %q", errOut.String(), want)
	}
	if entries, _ := os.ReadDir(home); len(entries) != 0 {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		// The launch lock is the only thing the folder may hold.
		if len(names) != 1 || names[0] != "launch.lock" {
			t.Fatalf("the folder holds %v after a launch that started nothing", names)
		}
	}
}

// relaunch refuses before it stops anything when the new server could not start.
func TestRelaunchRefusesBeforeItStopsAnything(t *testing.T) {
	t.Parallel()
	home := t.TempDir() // running, but not set up (its files are gone)
	asThisFolders(t, home, standInID)
	s := (&standIn{listening: true}).withPid(t)
	s.this(t, home, true)
	var out, errOut bytes.Buffer
	if code := relaunch(options{paths: store.NewPaths(home)}, &out, &errOut); code != 1 || out.Len() != 0 ||
		!strings.HasPrefix(errOut.String(), "AI Whiteboard: the server was not restarted\nAI Whiteboard is not set up on this machine. Set it up once with: ") {
		t.Fatalf("code %d, stdout %q, stderr %q", code, out.String(), errOut.String())
	}
	if !s.alive() {
		t.Fatal("relaunch stopped the server although the new one could not start")
	}
}

// ---- stop ------------------------------------------------------------------------------------

func TestStopCommand(t *testing.T) {
	t.Parallel()
	t.Run("no server", func(t *testing.T) {
		t.Parallel()
		out, errOut, code := own(t, "stop", "-home", t.TempDir())
		if code != 0 || out != "AI Whiteboard is not running\n" || errOut != "" {
			t.Fatalf("code %d, stdout %q, stderr %q", code, out, errOut)
		}
	})
	t.Run("this build", func(t *testing.T) {
		t.Parallel()
		home := t.TempDir()
		asThisFolders(t, home, standInID)
		s := (&standIn{}).withPid(t)
		s.this(t, home, true)
		out, errOut, code := own(t, "stop", "-home", home)
		if code != 0 || out != "AI Whiteboard stopped\n" || errOut != "" || s.alive() {
			t.Fatalf("code %d, stdout %q, stderr %q, the process alive %v", code, out, errOut, s.alive())
		}
	})
	t.Run("the build before", func(t *testing.T) {
		t.Parallel()
		home := t.TempDir()
		asThisFolders(t, home, standInID)
		s := (&standIn{}).withPid(t)
		s.older(t, home, true)
		out, errOut, code := own(t, "stop", "-home", home)
		if code != 0 || out != "AI Whiteboard stopped\n" || errOut != "" || s.alive() {
			t.Fatalf("code %d, stdout %q, stderr %q, the process alive %v", code, out, errOut, s.alive())
		}
	})
	t.Run("a server that reports no pid", func(t *testing.T) {
		t.Parallel()
		home := t.TempDir()
		asThisFolders(t, home, standInID)
		(&standIn{}).this(t, home, true)
		_, errOut, code := own(t, "stop", "-home", home)
		if code != 1 || !strings.HasPrefix(errOut, "AI Whiteboard: cannot stop the running server\n") {
			t.Fatalf("code %d, stderr %q", code, errOut)
		}
	})
}

// ---- secret -new -------------------------------------------------------------------------------

// The gate of `secret -new`: a server is signalled only when it is this data folder's, of a build
// that has the reload, and listening for clients. In every other case the command writes the
// secret, says on stderr what holds, exits 0 and signals nothing.
func TestSecretNewGate(t *testing.T) {
	t.Parallel()
	const (
		next     = "The new secret takes effect at the server's next start.\n"
		older    = "The running server is of an older build and cannot read a secret while it runs. " + next
		notAsked = "The running server does not listen for clients. " + next
		told     = "The running server accepts the new secret only, from now on. Its clients were disconnected and need the new secret.\n"
	)
	cases := []struct {
		name    string
		stand   *standIn
		legacy  bool
		noID    bool
		noFile  bool
		want    string
		signals bool // the process is ended by the signal
	}{
		{name: "this build, listening", stand: &standIn{listening: true, reloadsOn: true}, want: told, signals: true},
		{name: "this build, not listening", stand: &standIn{reloadsOn: true}, want: notAsked},
		{name: "this build, no server.json", stand: &standIn{listening: true, reloadsOn: true}, noFile: true, want: told, signals: true},
		{name: "this build of another folder", stand: &standIn{instanceID: otherID, listening: true, reloadsOn: true}, want: next},
		{name: "the folder has no instance id", stand: &standIn{listening: true, reloadsOn: true}, noID: true, want: next},
		{name: "this build that states no pid", stand: &standIn{listening: true}, want: older},
		{name: "the build before, listening", stand: &standIn{level: 5, listening: true, reloadsOn: true}, legacy: true, want: told, signals: true},
		{name: "the build before, not listening", stand: &standIn{level: 5, reloadsOn: true}, legacy: true, want: notAsked},
		{name: "the build before, feature level 0", stand: &standIn{level: -1, listening: true}, legacy: true, want: older},
		{name: "a copy of the folder", stand: &standIn{home: filepath.Join(os.TempDir(), "aiwb-the-original"), listening: true, reloadsOn: true}, want: next},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			home := t.TempDir()
			if _, _, code := own(t, "remote", "setup", "-home", home); code != 0 {
				t.Fatalf("set-up: code %d", code)
			}
			if !tc.noID {
				asThisFolders(t, home, standInID)
			}
			s := tc.stand
			if tc.name != "this build that states no pid" {
				s.withPid(t)
			} else {
				s.pid, s.alive = 0, func() bool { return true }
			}
			if tc.legacy {
				s.older(t, home, true)
			} else {
				s.this(t, home, !tc.noFile)
			}
			old := secretOf(t, home)

			out, errOut, code := own(t, "secret", "-new", "-home", home)
			fresh := secretOf(t, home)
			if code != 0 || out != fresh+"\n" || fresh == old {
				t.Fatalf("code %d, stdout %q", code, out)
			}
			if errOut != tc.want {
				t.Fatalf("stderr %q, want %q", errOut, tc.want)
			}
			if s.pid != 0 && s.alive() == tc.signals {
				t.Fatalf("the process was signalled: %v, want %v", !s.alive(), tc.signals)
			}
			noSecret(t, fresh, errOut)
			noSecret(t, old, errOut)
		})
	}
}

// A server that cannot be signalled, and one that takes the signal and does not confirm.
func TestSecretNewSignalNotConfirmed(t *testing.T) {
	t.Parallel()
	gate := func(t *testing.T, s *standIn) (errOut string, took time.Duration) {
		t.Helper()
		home := t.TempDir()
		if _, _, code := own(t, "remote", "setup", "-home", home); code != 0 {
			t.Fatalf("set-up: code %d", code)
		}
		asThisFolders(t, home, standInID)
		s.listening = true
		s.this(t, home, true)
		start := time.Now()
		out, errOut, code := own(t, "secret", "-new", "-home", home)
		took = time.Since(start)
		if fresh := secretOf(t, home); code != 0 || out != fresh+"\n" {
			t.Fatalf("code %d, stdout %q", code, out)
		}
		return errOut, took
	}
	t.Run("the process is gone", func(t *testing.T) {
		t.Parallel()
		// A pid that no process has or gets: the pid of one that just ended can be given to the
		// next process the machine starts, which the signal would then end.
		const gone = 1<<31 - 1
		if err := syscall.Kill(gone, 0); err != syscall.ESRCH {
			t.Fatalf("signal 0 to the pid %d: %v, want %v", gone, err, syscall.ESRCH)
		}
		want := "The running server could not be told (" + syscall.ESRCH.Error() + "). The new secret takes effect at the server's next start.\n"
		if errOut, _ := gate(t, &standIn{pid: gone, alive: func() bool { return true }}); errOut != want {
			t.Fatalf("stderr %q, want %q", errOut, want)
		}
	})
	t.Run("no confirmation", func(t *testing.T) {
		t.Parallel()
		// The signal ends the process, but the stand-in does not count a reload (reloadsOn is off).
		s := (&standIn{}).withPid(t)
		errOut, d := gate(t, s)
		if errOut != "The running server did not confirm the new secret. Restart it to be sure the old one is refused.\n" {
			t.Fatalf("stderr %q", errOut)
		}
		if d < 2500*time.Millisecond || d > 10*time.Second {
			t.Fatalf("the command waited %v for the confirmation, want about 3 s", d)
		}
	})
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
