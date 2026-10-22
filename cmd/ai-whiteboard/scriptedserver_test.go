//go:build !windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"testing"
	"time"
)

// scriptedServer is a real server process of an instance, started with `serve` and not detached,
// so that a test can read what it writes and end it the way a quit does. Its agents are the
// instance's: programs that do not exist, unless the test swapped in a fake.
type scriptedServer struct {
	in  *instance
	env []string // more in the server's environment

	cmd    *exec.Cmd
	exited chan struct{}
	out    serverOutput // what the server wrote, also copied to the test's stderr
}

// serverOutput keeps what a server process writes.
type serverOutput struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (o *serverOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	o.b.Write(p)
	o.mu.Unlock()
	return os.Stderr.Write(p)
}

func (o *serverOutput) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.b.String()
}

// e2eWait is how long a test waits for one step of a server. It is long because the machine may
// be busy; no step takes anywhere near it.
const e2eWait = 90 * time.Second

// start runs the server and waits until it serves its clients with its own pid.
func (s *scriptedServer) start(t *testing.T) {
	t.Helper()
	cmd := s.in.command(context.Background(), "serve", "-cwd", t.TempDir(), "-cursor-cost", "/nonexistent/cursor-cost")
	cmd.Env = append(s.in.environ(), s.env...)
	cmd.Stdout, cmd.Stderr = &s.out, &s.out
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	s.cmd, s.exited = cmd, make(chan struct{})
	go func(done chan struct{}) { cmd.Wait(); close(done) }(s.exited)
	for deadline := time.Now().Add(e2eWait); ; time.Sleep(50 * time.Millisecond) {
		if run, ok := s.in.running(); ok && run.hello.Pid == cmd.Process.Pid {
			if st, ok := run.statusOf(); ok && st.Client.Listening {
				return
			}
		}
		select {
		case <-s.exited:
			t.Fatal("the server exited while it started")
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("the server did not answer within %s", e2eWait)
		}
	}
}

// stop ends the server the way a quit does (SIGTERM) and waits for it. It does nothing when the
// server is not running.
func (s *scriptedServer) stop(t *testing.T) {
	t.Helper()
	if s.cmd == nil {
		return
	}
	select {
	case <-s.exited:
	default:
		s.cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-s.exited:
		case <-time.After(20 * time.Second):
			s.cmd.Process.Kill()
			<-s.exited
			t.Error("the server did not exit within 20 s of SIGTERM")
		}
	}
	s.cmd = nil
}

// call makes one API request as client and returns the status and the body.
func (s *scriptedServer) call(t *testing.T, client, method, path string, body, out any) (int, string) {
	t.Helper()
	return s.in.call(t, client, method, path, body, out)
}

// mcp makes one JSON-RPC call on the server's MCP endpoint with a chat's token and returns the
// result (or the error) as text.
func (s *scriptedServer) mcp(t *testing.T, token, method string, params any) string {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	req, _ := http.NewRequest("POST", s.in.mcpURL, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("mcp %s: %v", method, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return string(raw)
}

// mcpTool calls one tool on the server's MCP endpoint with a chat's token and returns the text
// of the answer and whether it is an error.
func (s *scriptedServer) mcpTool(t *testing.T, token, name string, args any) (text string, isErr bool) {
	t.Helper()
	raw := s.mcp(t, token, "tools/call", map[string]any{"name": name, "arguments": args})
	var body struct {
		Result *struct {
			Content []struct{ Text string }
			IsError bool
		}
	}
	if err := json.Unmarshal([]byte(raw), &body); err != nil || body.Result == nil {
		t.Fatalf("tools/call %s: no result in %s", name, raw)
	}
	for _, c := range body.Result.Content {
		text += c.Text
	}
	return text, body.Result.IsError
}

func clipText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
