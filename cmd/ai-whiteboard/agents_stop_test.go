package main

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
)

// fakeAgent is a stand-in for `claude` and `agent` that records its pid and its child's pid in
// $AIWB_FAKE_PIDS, then waits on a child that runs until it is killed. A one-shot `claude -p` (the
// chat namer, /usage) answers at once, like the real one. The child's command line names this
// test's folder, so the test can tell its processes from any other.
const fakeAgent = `#!/bin/sh
if [ "$1" = "-p" ] && [ "$2" != "--input-format" ]; then echo "Fake title"; exit 0; fi
"$(dirname "$0")/fake-child" &
echo "$$ $!" >> "$AIWB_FAKE_PIDS"
wait
`

const fakeChild = `#!/bin/sh
while :; do sleep 1; done
`

// Stopping the server ends every agent process it started, with the agent's own children: a
// Claude chat, a Cursor chat, the Claude sign-in check (`auth status`, the first step of its
// model-list probe) and the Cursor model-list probe the server starts at startup.
func TestStopEndsAgentProcesses(t *testing.T) {
	serverTest(t, "TestCloseEndsTheTree (internal/claude)", "TestCloseEndsTheGroup (internal/cursor)", "TestSignalGroup (internal/agent)")
	in := newInstance(t)
	fakes := t.TempDir()
	in.claude = filepath.Join(fakes, "claude")
	in.cursor = "" // `agent` on PATH, which is the fake below
	for name, body := range map[string]string{"claude": fakeAgent, "agent": fakeAgent, "fake-child": fakeChild} {
		if err := os.WriteFile(filepath.Join(fakes, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	pidFile := filepath.Join(fakes, "pids")
	t.Cleanup(func() { killOurs(t, fakes, readPids(pidFile)) })

	serve := in.command(context.Background(), "serve", "-cwd", t.TempDir(),
		"-cursor-cost", filepath.Join(fakes, "no-cursor-cost"))
	serve.Env = append(in.environ(), "PATH="+fakes+":"+os.Getenv("PATH"), "AIWB_FAKE_PIDS="+pidFile)
	serve.Stdout, serve.Stderr = os.Stderr, os.Stderr
	if err := serve.Start(); err != nil {
		t.Fatal(err)
	}
	served := make(chan struct{})
	go func() { serve.Wait(); close(served) }()
	waitServes(t, in, serve.Process.Pid, 60*time.Second)

	const client = testClient
	in.activate(t, client)
	for _, kind := range []string{"claude", "cursor"} {
		var chat struct{ ID string }
		in.must(t, client, "POST", "/api/chats", map[string]any{"agent": kind, "group": "__ungrouped__"}, &chat)
		// A Cursor chat's send waits for a handshake the fake never answers: do not wait for it.
		go func() {
			in.request(context.Background(), client, "POST", "/api/chats/"+chat.ID+"/messages", map[string]any{"text": "hello"})
		}()
	}
	var pids []int
	// A bound for what must happen, not a measure: the fakes are scripts this test has just
	// written, and on a loaded machine their first starts take seconds.
	for deadline := time.Now().Add(60 * time.Second); len(pids) < 8; time.Sleep(20 * time.Millisecond) {
		// Two chats, the Claude sign-in check and the Cursor probe, each an agent and its child.
		// The fakes never answer, so the check and the probe run until the stop.
		if time.Now().After(deadline) {
			t.Fatalf("fake agents recorded pids %v, want 4 agents and their children", pids)
		}
		pids = readPids(pidFile)
	}
	for _, pid := range pids {
		if !runningOurs(fakes, pid) {
			t.Fatalf("fake agent process %d is not running before the stop", pid)
		}
	}

	in.run(t, "stop")
	select {
	case <-served:
	case <-time.After(15 * time.Second):
		t.Fatal("the server process did not exit within 15 s of the stop")
	}
	for deadline := time.Now().Add(3 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		var left []int
		for _, pid := range pids {
			if runningOurs(fakes, pid) {
				left = append(left, pid)
			}
		}
		if len(left) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("after the server stopped, fake agent processes %v of %v are still running", left, pids)
		}
	}
}

// Stopping the server ends the background command a waiting Claude chat has started, although it
// runs detached, in a group of its own, and the stand-in's process is waiting on it: the chat's
// process is closed with the server and the command goes with it. The command is told from every
// other process by its sleep time, which only this run uses.
func TestStopEndsBackgroundCommands(t *testing.T) {
	serverTest(t, "TestEndAllEndsAdoptedGroups (internal/agent)", "TestCloseEndsTheTree (internal/claude)")
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH (the fake claude is a Node script)")
	}
	in := newInstance(t)
	in.claude = agenttest.FakeClaude(t)
	pidFile := filepath.Join(t.TempDir(), "bgpids")
	secs := fmt.Sprintf("60.%06d", 100000+rand.Intn(900000))
	in.setenv("FAKE_CLAUDE_BGPIDS=" + pidFile)
	t.Cleanup(func() { // a failing test leaves no sleep behind
		for _, pid := range readPids(pidFile) {
			syscall.Kill(-pid, syscall.SIGKILL)
		}
	})

	serve := in.command(context.Background(), "serve", "-cwd", t.TempDir())
	serve.Stdout, serve.Stderr = os.Stderr, os.Stderr
	if err := serve.Start(); err != nil {
		t.Fatal(err)
	}
	served := make(chan struct{})
	go func() { serve.Wait(); close(served) }()
	waitServes(t, in, serve.Process.Pid, 60*time.Second)

	const client = testClient
	in.activate(t, client)
	var chat struct{ ID string }
	in.must(t, client, "POST", "/api/chats", map[string]any{"agent": "claude", "group": "__ungrouped__"}, &chat)
	in.must(t, client, "POST", "/api/chats/"+chat.ID+"/messages", map[string]any{"text": "[[bg " + secs + "]]"}, nil)

	var pids []int
	// A bound for what must happen, not a measure: node and the shell start slowly on a loaded machine.
	for deadline := time.Now().Add(60 * time.Second); len(pids) < 1; time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("the stand-in started no background command (pids %v)", pids)
		}
		pids = readPids(pidFile)
	}
	// The shell's pid is written as it starts; the sleep is its child a moment later.
	for deadline := time.Now().Add(60 * time.Second); len(sleepingFor(secs)) != 1; time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("sleep %s runs as %v before the stop, want one", secs, sleepingFor(secs))
		}
	}

	in.run(t, "stop")
	select {
	case <-served:
	case <-time.After(15 * time.Second):
		t.Fatal("the server process did not exit within 15 s of the stop")
	}
	for deadline := time.Now().Add(15 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		left := sleepingFor(secs)
		if syscall.Kill(-pids[0], 0) == syscall.ESRCH && len(left) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("after the server stopped, the background command is still there: group %d (ESRCH expected), sleep %s as %v", pids[0], secs, left)
		}
	}
}

// sleepingFor is the pids of the live `sleep SECONDS` processes in the machine's process list.
func sleepingFor(seconds string) []int {
	out, err := exec.Command("ps", "-axo", "pid=,stat=,command=").Output()
	if err != nil {
		return nil
	}
	var pids []int
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) == 4 && f[2] == "sleep" && f[3] == seconds && !strings.HasPrefix(f[1], "Z") {
			if pid, err := strconv.Atoi(f[0]); err == nil {
				pids = append(pids, pid)
			}
		}
	}
	return pids
}

// fakePi is a stand-in for `pi --mode rpc`: it answers the boot version probe, the one-shot
// namer (-p) and the RPC handshake/prompt, and — only for a chat run (--session-dir) — starts a
// long-lived child in its own process group, recording both pids. Stopping the server must reap
// the group: the pi process and the child.
const fakePi = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9-fake"; exit 0; fi
for a in "$@"; do
  if [ "$a" = "-p" ]; then echo "Fake pi title"; exit 0; fi
done
case " $* " in
  *" --session-dir "*)
    sleep 300 &
    echo "$$ $!" >> "$PI_FAKE_PIDS"
    ;;
esac
while IFS= read -r line; do
  type=$(printf '%s' "$line" | sed -n 's/.*"type":"\([^"]*\)".*/\1/p')
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
  case "$type" in
    get_state) printf '{"type":"response","id":"%s","command":"get_state","success":true,"data":{"sessionId":"pi-fake","sessionFile":"/tmp/pi-fake.jsonl","model":{"provider":"test","id":"test-model","contextWindow":1000}}}\n' "$id" ;;
    get_available_models) printf '{"type":"response","id":"%s","command":"get_available_models","success":true,"data":{"models":[{"id":"test-model","name":"Test Model","provider":"test","reasoning":false,"contextWindow":1000}]}}\n' "$id" ;;
    *) printf '{"type":"response","id":"%s","command":"%s","success":true}\n' "$id" "$type" ;;
  esac
done
`

// Stopping the server ends a pi chat's process group too: the fake pi starts a child that stays
// in the same group, and both must be gone after `stop`.
func TestStopEndsPiProcesses(t *testing.T) {
	serverTest(t, "TestCloseReapsChildGroup (internal/pi)")
	in := newInstance(t)
	fakes := t.TempDir()
	if err := os.WriteFile(filepath.Join(fakes, "pi"), []byte(fakePi), 0o755); err != nil {
		t.Fatal(err)
	}
	pidFile := filepath.Join(fakes, "pi-pids")
	t.Cleanup(func() { killOurs(t, fakes, readPids(pidFile)) })

	in.pi = filepath.Join(fakes, "pi")
	serve := in.command(context.Background(), "serve", "-cwd", t.TempDir(),
		"-cursor-cost", filepath.Join(fakes, "no-cursor-cost"))
	serve.Env = append(in.environ(), "PI_FAKE_PIDS="+pidFile)
	serve.Stdout, serve.Stderr = os.Stderr, os.Stderr
	if err := serve.Start(); err != nil {
		t.Fatal(err)
	}
	served := make(chan struct{})
	go func() { serve.Wait(); close(served) }()
	waitServes(t, in, serve.Process.Pid, 20*time.Second)

	const client = testClient
	in.activate(t, client)
	var chat struct{ ID string }
	in.must(t, client, "POST", "/api/chats", map[string]any{"agent": "pi", "group": "__ungrouped__"}, &chat)
	in.must(t, client, "POST", "/api/chats/"+chat.ID+"/messages", map[string]any{"text": "hello"}, nil)

	// The fake records its own pid and its child's when the chat run starts.
	var pids []int
	for deadline := time.Now().Add(15 * time.Second); len(pids) < 2; time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("fake pi recorded pids %v, want the pi process and its child", pids)
		}
		pids = readPids(pidFile)
	}
	for _, pid := range pids {
		if !pidAlive(pid) {
			t.Fatalf("fake pi process %d is not running before the stop", pid)
		}
	}

	in.run(t, "stop")
	select {
	case <-served:
	case <-time.After(15 * time.Second):
		t.Fatal("the server process did not exit within 15 s of the stop")
	}
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		var left []int
		for _, pid := range pids {
			if pidAlive(pid) {
				left = append(left, pid)
			}
		}
		if len(left) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("after the server stopped, pi processes %v of %v are still running (ESRCH expected)", left, pids)
		}
	}
}

// pidAlive reports whether pid still exists (a zombie counts as alive: it is not ESRCH).
func pidAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

// readPids returns the pids the fake agents recorded.
func readPids(path string) []int {
	b, _ := os.ReadFile(path)
	var pids []int
	for _, f := range strings.Fields(string(b)) {
		if pid, err := strconv.Atoi(f); err == nil && pid > 1 {
			pids = append(pids, pid)
		}
	}
	return pids
}

// runningOurs reports whether pid is a live (not zombie) process whose command line names the
// folder dir, that is, one of this test's fake agents or their children.
func runningOurs(dir string, pid int) bool {
	out, err := exec.Command("ps", "-o", "stat=,command=", "-p", fmt.Sprint(pid)).Output()
	if err != nil {
		return false
	}
	stat, cmdline, _ := strings.Cut(strings.TrimSpace(string(out)), " ")
	return !strings.HasPrefix(stat, "Z") && strings.Contains(cmdline, dir)
}

// killOurs kills whichever of pids is still one of this test's processes.
func killOurs(t *testing.T, dir string, pids []int) {
	for _, pid := range pids {
		if runningOurs(dir, pid) {
			t.Logf("killing leftover fake agent process %d", pid)
			syscall.Kill(pid, syscall.SIGKILL)
		}
	}
}

// waitServes waits up to limit for the server process pid to serve its clients.
func waitServes(t *testing.T, in *instance, pid int, limit time.Duration) {
	t.Helper()
	for deadline := time.Now().Add(limit); ; time.Sleep(20 * time.Millisecond) {
		if run, ok := in.running(); ok && run.hello.Pid == pid {
			if st, ok := run.statusOf(); ok && st.Client.Listening {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("the server did not answer within %s", limit)
		}
	}
}
