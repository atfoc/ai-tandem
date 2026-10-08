package claude

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// probeFake sets up the fake for a probe: it answers initialize from the plain fixture.
func probeFake(t *testing.T) (f *fake, runs string) {
	t.Helper()
	f = newFake(t)
	runs = filepath.Join(f.dir, "runs.jsonl")
	t.Setenv(envRuns, runs)
	fixture, _ := filepath.Abs(filepath.Join("testdata", "initialize.json"))
	t.Setenv(envInit, fixture)
	return f, runs
}

type fakeRun struct {
	Pid  int
	Args []string
}

func readRuns(t *testing.T, path string) []fakeRun {
	t.Helper()
	fh, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	defer fh.Close()
	var out []fakeRun
	sc := bufio.NewScanner(fh)
	for sc.Scan() {
		var r fakeRun
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

// noneAlive fails the test if any recorded fake process still exists.
func noneAlive(t *testing.T, runs []fakeRun) {
	t.Helper()
	for _, r := range runs {
		if err := syscall.Kill(r.Pid, 0); !errors.Is(err, syscall.ESRCH) {
			t.Errorf("process %d (%v) is still there: %v", r.Pid, r.Args, err)
		}
	}
}

func isAuth(r fakeRun) bool { return len(r.Args) > 0 && r.Args[0] == "auth" }

func TestProbeSuccess(t *testing.T) {
	f, runsFile := probeFake(t)
	cat, err := f.spawner().Catalog(10 * time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.Models) != 11 || cat.Default.Model != "sonnet" {
		t.Errorf("catalog: %d rows, default %+v", len(cat.Models), cat.Default)
	}
	runs := readRuns(t, runsFile)
	if len(runs) != 2 || !isAuth(runs[0]) || isAuth(runs[1]) {
		t.Fatalf("runs %+v, want the sign-in check and then the probe", runs)
	}
	if got, want := strings.Join(runs[1].Args, " "), strings.Join(ProbeArgs(), " "); got != want {
		t.Errorf("probe args %q, want %q", got, want)
	}
	const literal = "-p --input-format stream-json --output-format stream-json --verbose --no-session-persistence --strict-mcp-config"
	if got := strings.Join(runs[1].Args, " "); got != literal {
		t.Errorf("probe args %q, want %q", got, literal)
	}
	if got := strings.Join(ProbeArgs(), " "); got != literal {
		t.Errorf("ProbeArgs() = %q, want %q", got, literal)
	}
	for _, a := range runs[1].Args {
		if a == "--model" || a == "--session-id" || a == "--resume" {
			t.Errorf("probe passes %s", a)
		}
	}
	noneAlive(t, runs)
}

// The probe's stdin holds one line, the initialize request (acceptance 4).
func TestProbeStdinIsTheInitializeRequestOnly(t *testing.T) {
	f, _ := probeFake(t)
	if _, err := f.spawner().Catalog(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(f.stdin)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("stdin = %q, want one line", b)
	}
	var req struct {
		Type      string         `json:"type"`
		RequestID string         `json:"request_id"`
		Request   map[string]any `json:"request"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &req); err != nil {
		t.Fatal(err)
	}
	if req.Type != "control_request" || req.Request["subtype"] != "initialize" || req.RequestID == "" || len(req.Request) != 1 {
		t.Errorf("stdin line %s", lines[0])
	}
}

// probeShortTimeouts are the Catalog timeouts that a test which waits a whole timeout out tries
// first. The two fake processes of a probe start in about 20 ms on a quiet machine.
var probeShortTimeouts = []time.Duration{300 * time.Millisecond, 1200 * time.Millisecond}

// probeLoadedTimeout is the last Catalog timeout such a test tries: long enough for the fake
// processes to start on a machine that is busy with several whole test suites at once. It only
// costs its time when the machine is that slow.
const probeLoadedTimeout = 15 * time.Second

// waitsOutProbeTimeout runs a test that waits a whole Catalog timeout out: first with the short
// timeouts, then with full, the test's own timeout, and each time the machine was too slow (run
// says so by returning false: what has to happen before the timeout did not) with the next longer
// one. The last is probeLoadedTimeout: in the run with it, short is false and run must not give up.
func waitsOutProbeTimeout(t *testing.T, full time.Duration, run func(timeout time.Duration, short bool) bool) {
	t.Helper()
	for _, d := range append(append([]time.Duration(nil), probeShortTimeouts...), full) {
		if run(d, true) {
			return
		}
		t.Logf("%s was too short on this machine now", d)
	}
	run(probeLoadedTimeout, false)
}

// atMost is the upper bound of a test that waits a timeout out: bound, the one of the test's full
// timeout, in every attempt, and more only for a timeout so long that the wait itself passes it.
func atMost(bound, timeout time.Duration) time.Duration {
	return max(bound, timeout+5*time.Second)
}

// signInTimedOut reports whether Catalog failed because the timeout ended in the sign-in check.
func signInTimedOut(err error) bool {
	return err != nil && strings.Contains(err.Error(), "claude auth status: no answer within")
}

func TestProbeNoAnswerTimesOut(t *testing.T) {
	// The full timeout is long enough for the sign-in check and the start of the probe on a busy
	// machine; when it was not (the fake's two runs are not both recorded), a longer one follows.
	waitsOutProbeTimeout(t, 3*time.Second, func(timeout time.Duration, short bool) bool {
		f, runsFile := probeFake(t)
		t.Setenv(envInit, "") // the fake reads stdin and never answers
		start := time.Now()
		_, err := f.spawner().Catalog(timeout)
		d := time.Since(start)
		runs := readRuns(t, runsFile)
		if short && (signInTimedOut(err) || len(runs) < 2) {
			return false
		}
		if err == nil || !strings.Contains(err.Error(), "did not report its models") {
			t.Fatalf("err = %v, want the probe's own timeout", err)
		}
		if d > atMost(8*time.Second, timeout) {
			t.Errorf("took %s", d)
		}
		if len(runs) != 2 {
			t.Errorf("runs %+v, want the sign-in check and the probe", runs)
		}
		noneAlive(t, runs)
		return true
	})
}

func TestProbeNonZeroExit(t *testing.T) {
	f, runsFile := probeFake(t)
	t.Setenv(envExit, "1")
	t.Setenv(envStderr, "boom: not today\nsecond line")
	_, err := f.spawner().Catalog(10 * time.Second)
	if err == nil || !strings.Contains(err.Error(), "boom: not today") || strings.Contains(err.Error(), "second line") {
		t.Fatalf("err = %v, want the first stderr line", err)
	}
	noneAlive(t, readRuns(t, runsFile))
}

func TestProbeMissingBinary(t *testing.T) {
	s := (&fake{}).spawner()
	s.Bin = filepath.Join(t.TempDir(), "no-such-claude")
	if _, err := s.Catalog(5 * time.Second); err == nil {
		t.Fatal("no error for a binary that does not exist")
	}
}

func TestProbeErrorAnswerAndUnusableList(t *testing.T) {
	f, runsFile := probeFake(t)
	bad := filepath.Join(f.dir, "bad.json")
	os.WriteFile(bad, []byte(`{"type":"control_response","response":{"subtype":"success","request_id":"x","response":{"models":[]}}}`), 0o644)
	t.Setenv(envInit, bad)
	if _, err := f.spawner().Catalog(10 * time.Second); err == nil {
		t.Fatal("an empty list was accepted")
	}
	os.WriteFile(bad, []byte(`{"type":"control_response","response":{"subtype":"error","request_id":"x","error":"nope"}}`), 0o644)
	if _, err := f.spawner().Catalog(10 * time.Second); err == nil || !strings.Contains(err.Error(), "nope") {
		t.Fatalf("err = %v", err)
	}
	noneAlive(t, readRuns(t, runsFile))
}

func TestProbeSignedOut(t *testing.T) {
	f, runsFile := probeFake(t)
	t.Setenv(envAuth, "1")
	t.Setenv(envStderr, "Not logged in")
	_, err := f.spawner().Catalog(10 * time.Second)
	if err == nil || !strings.Contains(err.Error(), "Not logged in") {
		t.Fatalf("err = %v", err)
	}
	runs := readRuns(t, runsFile)
	if len(runs) != 1 || !isAuth(runs[0]) {
		t.Errorf("runs %+v, want the sign-in check only", runs)
	}
	if _, err := os.Stat(f.stdin); err == nil {
		t.Error("the initialize process was started")
	}
	noneAlive(t, runs)
}

// The probe runs in the temp folder, and ends its process by closing stdin, not by the kill after
// the grace.
func TestProbeFolderAndStdinClosedAfterAnswer(t *testing.T) {
	f, _ := probeFake(t)
	// With a grace far above the two fake exits (about 2 s under -race), a process that only ended
	// by the kill would take the whole grace.
	old := probeKillGrace
	probeKillGrace = 20 * time.Second
	t.Cleanup(func() { probeKillGrace = old })
	start := time.Now()
	if _, err := f.spawner().Catalog(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d >= 10*time.Second {
		t.Errorf("took %s: stdin was not closed after the answer", d)
	}
	b, err := os.ReadFile(f.args)
	if err != nil {
		t.Fatal(err)
	}
	var rec struct{ Cwd string }
	if err := json.Unmarshal(b, &rec); err != nil {
		t.Fatal(err)
	}
	got, _ := filepath.EvalSymlinks(rec.Cwd)
	want, _ := filepath.EvalSymlinks(os.TempDir())
	if got == "" || got != want {
		t.Errorf("probe folder %q, want the temp folder %q", rec.Cwd, os.TempDir())
	}
}

// Only the answer carrying the probe's own request id counts.
func TestProbeIgnoresAnswerForAnotherRequest(t *testing.T) {
	waitsOutProbeTimeout(t, 3*time.Second, func(timeout time.Duration, short bool) bool {
		f, runsFile := probeFake(t)
		t.Setenv(envWrong, "1")
		start := time.Now()
		_, err := f.spawner().Catalog(timeout)
		runs := readRuns(t, runsFile)
		// The short timeout only counts when the fake had the request (it answers right after it
		// recorded it) well before the timeout: the probe had the wrong answer and went on waiting.
		if short && (signInTimedOut(err) || len(runs) < 2 || !requestRecordedBy(f, start.Add(timeout-150*time.Millisecond))) {
			return false
		}
		if err == nil || !strings.Contains(err.Error(), "did not report its models") {
			t.Fatalf("err = %v, want the probe's own timeout", err)
		}
		if len(runs) != 2 {
			t.Errorf("runs %+v, want the sign-in check and the probe", runs)
		}
		noneAlive(t, runs)
		return true
	})
}

// requestRecordedBy reports whether the fake recorded the initialize request, and did so by the time given.
func requestRecordedBy(f *fake, by time.Time) bool {
	b, err := os.ReadFile(f.stdin)
	if err != nil || !strings.Contains(string(b), `"initialize"`) {
		return false
	}
	fi, err := os.Stat(f.stdin)
	return err == nil && !fi.ModTime().After(by)
}

// An answer line larger than the default scanner limit (64 KB) is read.
func TestProbeReadsALargeAnswer(t *testing.T) {
	f, _ := probeFake(t)
	t.Setenv(envPad, "200000")
	cat, err := f.spawner().Catalog(10 * time.Second)
	if err != nil || len(cat.Models) != 11 {
		t.Fatalf("catalog %v, err %v", cat, err)
	}
}

// A descendant that keeps the pipes open after the process ends does not keep Catalog waiting
// past its timeout: not in the sign-in check, not in the probe. It is killed with the group.
func TestProbeDescendantHoldingPipes(t *testing.T) {
	for _, name := range []string{"probe", "signin"} {
		t.Run(name, func(t *testing.T) {
			// The full timeout is long enough for the sign-in check to answer and for the probe's
			// process to start its child on a machine that is busy with the other packages' tests
			// (two seconds were not, with three suites at once); each of the two steps may take the
			// whole of it. An attempt counts only when the child was started; the bound on Catalog
			// is the one of the full timeout in every attempt, far below the 30 s of the hold.
			const full = 5 * time.Second
			waitsOutProbeTimeout(t, full, func(timeout time.Duration, short bool) bool {
				f, _ := probeFake(t)
				pidFile := filepath.Join(f.dir, "child.pid")
				s := f.spawner()
				if name == "probe" {
					// The sign-in check answers at once; only the probe process holds the pipes. Both
					// are the fake itself and not a script written here: the system checks a new
					// script when it is first run, one at a time for the whole machine, which took
					// more than the full timeout with four suites at once.
					t.Setenv(envHold, "")
					t.Setenv(envPHold, pidFile)
				} else {
					t.Setenv(envHold, pidFile)
				}
				start := time.Now()
				_, err := s.Catalog(timeout)
				d := time.Since(start)
				b, rerr := os.ReadFile(pidFile)
				pid, _ := strconv.Atoi(string(b))
				if short && (rerr != nil || pid == 0) { // the timeout ended before the child was there
					return false
				}
				if d > atMost(2*full+2*time.Second, timeout) {
					t.Errorf("Catalog took %s", d)
				}
				if err == nil {
					t.Fatal("no error")
				}
				if rerr != nil {
					t.Fatalf("the fake started no child: %v (%v)", rerr, err)
				}
				waitDead(t, pid)
				return true
			})
		})
	}
}

func waitDead(t *testing.T, pid int) {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			return
		}
	}
	syscall.Kill(pid, syscall.SIGKILL)
	t.Errorf("descendant %d is still running", pid)
}

// writeScript writes a shell script that stands in for `claude` and runs it once, with the one
// argument "warm", for which it exits at once. The system checks a new script when it is first
// run, one at a time for the whole machine: about 0.1 s alone, and seconds when other test suites
// write and run scripts of their own. That wait is taken here, where no timeout runs.
func writeScript(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("#!/bin/sh\nif [ \"$1\" = warm ]; then exit 0; fi\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command(path, "warm").CombinedOutput(); err != nil {
		t.Fatalf("%s warm: %v: %s", path, err, out)
	}
}

// A sign-in check that exits 0 while a descendant still holds its stderr is a success: the probe
// goes on, and the descendant is gone afterwards.
func TestProbeSignInSuccessWithDescendantHoldingStderr(t *testing.T) {
	f, runsFile := probeFake(t)
	pidFile := filepath.Join(f.dir, "child.pid")
	path := filepath.Join(f.dir, "claude-signin-holding")
	writeScript(t, path, "if [ \"$1\" = auth ]; then sleep 30 >/dev/null & echo $! > "+pidFile+
		"; exit 0; fi\nexec "+os.Args[0]+" \"$@\"\n")
	s := f.spawner()
	s.Bin = path
	// The check waits the reap grace out for the descendant, which holds stderr for 30 s: nothing
	// has to happen within it, so a short one changes nothing but the wait.
	old := probeReapGrace
	probeReapGrace = 50 * time.Millisecond
	t.Cleanup(func() { probeReapGrace = old })
	cat, err := s.Catalog(10 * time.Second)
	if err != nil || len(cat.Models) != 11 {
		t.Fatalf("catalog %v, err %v", cat, err)
	}
	if runs := readRuns(t, runsFile); len(runs) != 1 || isAuth(runs[0]) {
		t.Errorf("runs %+v, want the probe's run after the sign-in check", runs)
	}
	b, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("the check started no descendant: %v", err)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	waitDead(t, pid)
}
