package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// fakeAgent is a stand-in for `claude` and `agent` that records its pid and its child's pid in
// $AIWB_FAKE_PIDS, then waits on a child that runs until it is killed. A one-shot `claude -p` (the
// chat namer, /usage) answers at once, like the real one. The child's command line names this test's folder,
// so the test can tell its processes from any other.
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
// Claude chat, a Cursor chat and the Cursor model-list probe the server starts at startup.
func TestStopEndsAgentProcesses(t *testing.T) {
	in := newInstance(t)
	fakes := t.TempDir()
	for name, body := range map[string]string{"claude": fakeAgent, "agent": fakeAgent, "fake-child": fakeChild} {
		if err := os.WriteFile(filepath.Join(fakes, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	pidFile := filepath.Join(fakes, "pids")
	t.Cleanup(func() { killOurs(t, fakes, readPids(pidFile)) })

	serve := exec.Command(in.bin, append([]string{"serve", "-cwd", t.TempDir(),
		"-cursor-cost", filepath.Join(fakes, "no-cursor-cost")}, in.flags()...)...)
	serve.Env = append(os.Environ(), "PATH="+fakes+":"+os.Getenv("PATH"), "AIWB_FAKE_PIDS="+pidFile)
	serve.Stdout, serve.Stderr = os.Stderr, os.Stderr
	if err := serve.Start(); err != nil {
		t.Fatal(err)
	}
	served := make(chan struct{})
	go func() { serve.Wait(); close(served) }()
	for deadline := time.Now().Add(20 * time.Second); !isOurs(httpClient(), strings.TrimSuffix(in.url, "/")); time.Sleep(100 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the server did not answer within 20 s")
		}
	}

	const client = "stop-agents-test"
	activate(t, in.url, client)
	for _, kind := range []string{"claude", "cursor"} {
		var chat struct{ ID string }
		postJSON(t, in.url+"api/chats", client, map[string]any{"agent": kind, "group": "__ungrouped__"}, &chat)
		// A Cursor chat's send waits for a handshake the fake never answers: do not wait for it.
		go func() {
			if resp, err := post(in.url+"api/chats/"+chat.ID+"/messages", client, map[string]any{"text": "hello"}); err == nil {
				resp.Body.Close()
			}
		}()
	}
	var pids []int
	for deadline := time.Now().Add(10 * time.Second); len(pids) < 6; time.Sleep(100 * time.Millisecond) {
		// Two chats and the model-list probe, each an agent and its child.
		if time.Now().After(deadline) {
			t.Fatalf("fake agents recorded pids %v, want 3 agents and their children", pids)
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
	in := newInstance(t)
	fakes := t.TempDir()
	if err := os.WriteFile(filepath.Join(fakes, "pi"), []byte(fakePi), 0o755); err != nil {
		t.Fatal(err)
	}
	pidFile := filepath.Join(fakes, "pi-pids")
	t.Cleanup(func() { killOurs(t, fakes, readPids(pidFile)) })

	serve := exec.Command(in.bin, append([]string{"serve", "-cwd", t.TempDir(),
		"-pi", filepath.Join(fakes, "pi"),
		"-cursor-cost", filepath.Join(fakes, "no-cursor-cost")}, in.flags()...)...)
	serve.Env = append(os.Environ(), "PI_FAKE_PIDS="+pidFile)
	serve.Stdout, serve.Stderr = os.Stderr, os.Stderr
	if err := serve.Start(); err != nil {
		t.Fatal(err)
	}
	served := make(chan struct{})
	go func() { serve.Wait(); close(served) }()
	for deadline := time.Now().Add(20 * time.Second); !isOurs(httpClient(), strings.TrimSuffix(in.url, "/")); time.Sleep(100 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the server did not answer within 20 s")
		}
	}

	const client = "stop-pi-test"
	activate(t, in.url, client)
	var chat struct{ ID string }
	postJSON(t, in.url+"api/chats", client, map[string]any{"agent": "pi", "group": "__ungrouped__"}, &chat)
	postJSON(t, in.url+"api/chats/"+chat.ID+"/messages", client, map[string]any{"text": "hello"}, nil)

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

// activate connects to the server's events as client and waits until it is the active client.
// The connection stays open until the test ends.
func activate(t *testing.T, base, client string) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, "GET", base+"api/events?client="+client, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(nil, 1<<20)
	for active := false; !active; {
		if !sc.Scan() {
			t.Fatalf("events ended before the client was active: %v", sc.Err())
		}
		var ev map[string]any
		if line, ok := strings.CutPrefix(sc.Text(), "data: "); ok && json.Unmarshal([]byte(line), &ev) == nil {
			active = ev["type"] == "hello" && ev["active"] == true
		}
	}
	go io.Copy(io.Discard, resp.Body) // keep reading so the server never blocks on this client
}

// post posts body as JSON to url as client.
func post(url, client string, body any) (*http.Response, error) {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-AIWB-Client", client)
	return (&http.Client{Timeout: 30 * time.Second}).Do(req)
}

// postJSON posts body as JSON to url as client; the answer must be 200. It decodes the answer
// into out when out is not nil.
func postJSON(t *testing.T, url, client string, body, out any) {
	t.Helper()
	resp, err := post(url, client, body)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST %s: status %d", url, resp.StatusCode)
	}
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatal(err)
		}
	}
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
