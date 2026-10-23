//go:build !windows

package main

import (
	"bytes"
	"context"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/model"
)

// The retry of an agent after a temporary API error (claude-retry-api-errors-goal.md), through real
// server processes and the fake claude: the chat's agent that is retried and answers, and a
// subagent that is being retried when the server stops.

// lockedBuffer is a buffer that a test reads while a server process still writes to it.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// retryServer is one server process of an instance, started with `serve`, whose stdout and stderr
// are collected in out (the retry's log lines are written to stderr).
type retryServer struct {
	cmd    *exec.Cmd
	exited chan struct{}
	out    lockedBuffer
}

// startRetryServer starts `serve` on the instance and waits until it serves its clients.
func startRetryServer(t *testing.T, in *instance) *retryServer {
	t.Helper()
	s := &retryServer{exited: make(chan struct{})}
	s.cmd = in.command(context.Background(), "serve", "-cwd", t.TempDir(), "-cursor-cost", "/nonexistent/cursor-cost")
	s.cmd.Stdout, s.cmd.Stderr = &s.out, &s.out
	if err := s.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { s.cmd.Wait(); close(s.exited) }()
	for deadline := time.Now().Add(60 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if run, ok := in.running(); ok && run.hello.Pid == s.cmd.Process.Pid {
			if st, ok := run.statusOf(); ok && st.Client.Listening {
				return s
			}
		}
		select {
		case <-s.exited:
			t.Fatalf("the server exited while it started:\n%s", s.out.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("the server did not answer within 60 s:\n%s", s.out.String())
		}
	}
}

// retryChat makes a Claude chat as testClient and returns its id.
func retryChat(t *testing.T, in *instance) string {
	t.Helper()
	var made struct{ ID string }
	in.must(t, testClient, "POST", "/api/chats", map[string]any{"agent": "claude", "group": model.Ungrouped}, &made)
	return made.ID
}

// chatView is the chat's view as the server answers it.
func (in *instance) chatView(t *testing.T, chat string) model.ChatView {
	t.Helper()
	var cv model.ChatView
	in.must(t, testClient, "GET", "/api/chats/"+chat, nil, &cv)
	return cv
}

// chatThread is the current branch's items and subagent records of the chat.
func (in *instance) chatThread(t *testing.T, chat string) ([]model.Item, []model.Subagent) {
	t.Helper()
	var got struct {
		Items     []model.Item
		Subagents []model.Subagent
	}
	in.must(t, testClient, "GET", "/api/chats/"+chat+"/items", nil, &got)
	return got.Items, got.Subagents
}

// waitRetry polls until ok holds, for at most a minute: a bound for what must happen, not a measure.
func waitRetry(t *testing.T, what string, s *retryServer, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(60 * time.Second); !ok(); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("%s did not happen within 60 s; the server wrote:\n%s", what, s.out.String())
		}
	}
}

// (scenario 1) A Claude chat whose turn the API refuses with a login failure is started again by
// the server, on its own, and the second attempt answers: the person sees the retry, then an idle
// chat with the agent's reply, and the server's log tells both steps.
func TestServerRetriesALoginFailure(t *testing.T) {
	serverTest(t, "TestChatRetriesATemporaryError (internal/chats)", "TestFakeClaudeAPIError (internal/agenttest)")
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH (the fake claude is a Node script)")
	}
	in := newInstance(t)
	in.claude = agenttest.FakeClaude(t)
	in.setenv("FAKE_CLAUDE_STATE="+t.TempDir(), "AIWB_TEST_WAITS="+strings.TrimPrefix(fast.env(t, "retry"), "AIWB_TEST_WAITS="))
	s := startRetryServer(t, in)
	in.activate(t, testClient)

	chat := retryChat(t, in)
	in.must(t, testClient, "POST", "/api/chats/"+chat+"/messages", map[string]any{"text": "[[apierror authentication_failed 1]] hello"}, nil)

	// The pause is short on the fast clock, so look often and keep the view in which it was seen.
	var retrying model.ChatView
	var seen bool
	waitRetry(t, "the chat's status retrying", s, func() bool {
		cv := in.chatView(t, chat)
		if cv.Status == model.StatusRetrying {
			retrying, seen = cv, true
		}
		return seen
	})
	if retrying.Retry.Attempt != 1 || retrying.Retry.Of != 4 || retrying.Retry.Kind != "login" {
		t.Fatalf("the view while waiting: %+v, want status retrying with a login retry, attempt 1 of 4\n%s", retrying, s.out.String())
	}

	// The retried turn answers: the chat is idle again, with no retry.
	waitRetry(t, "the chat idle again", s, func() bool {
		cv := in.chatView(t, chat)
		return cv.Status == model.StatusReady && cv.Retry == (model.Retry{})
	})
	items, _ := in.chatThread(t, chat)
	note, reply := -1, -1
	for i, it := range items {
		switch {
		case it.Kind == "note" && strings.Contains(it.Text, "Trying again in about"):
			if note < 0 {
				note = i
			}
		case it.Kind == "text" && strings.HasPrefix(it.Text, "FAKE("):
			if reply < 0 {
				reply = i
			}
		}
	}
	if note < 0 || reply < note {
		t.Fatalf("items: the retry note is at %d and the reply at %d, want the note first\n%+v", note, reply, items)
	}
	log := s.out.String()
	for _, want := range []string{"attempt 1/4 in", "attempt 1/4 answered"} {
		if !strings.Contains(log, want) {
			t.Errorf("the server's stderr has no %q:\n%s", want, log)
		}
	}
}

// (scenario 9) A subagent that is waiting out the pause before a retry when the server stops is
// paused by the stop, with its session kept, and is still paused when the server runs again: the
// stop did not make it a failure, and nothing started it again.
func TestServerStopDuringRetryPausesSubagent(t *testing.T) {
	serverTest(t, "TestShutdownDuringBackoffPauses (internal/chats)", "TestCrashDuringBackoffPauses (internal/chats)")
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH (the fake claude is a Node script)")
	}
	in := newInstance(t)
	in.claude = agenttest.FakeClaude(t)
	// The production waits: the first pause is 20 s, so the stop comes while it runs.
	in.setenv("FAKE_CLAUDE_STATE=" + t.TempDir())
	s := startRetryServer(t, in)
	in.activate(t, testClient)

	chat := retryChat(t, in)
	in.must(t, testClient, "POST", "/api/chats/"+chat+"/messages", map[string]any{
		"text": `[[mcp spawn_subagent {"prompt":"<<apierror authentication_failed 9>>","description":"lead"}]]`}, nil)
	waitRetry(t, "the subagent running with retry attempt 1", s, func() bool {
		_, subs := in.chatThread(t, chat)
		return len(subs) == 1 && subs[0].Status == model.SubRunning && subs[0].Retry.Attempt == 1
	})

	in.run(t, "stop")
	select {
	case <-s.exited:
	case <-time.After(30 * time.Second):
		t.Fatalf("the server did not exit within 30 s of the stop:\n%s", s.out.String())
	}
	s = startRetryServer(t, in)
	in.activate(t, testClient)

	_, subs := in.chatThread(t, chat)
	if len(subs) != 1 {
		t.Fatalf("subagents after the restart: %+v, want one", subs)
	}
	sub := subs[0]
	if sub.Status != model.SubPaused || sub.Cause != model.CauseRetryingAtStop || sub.ErrorKind != "login" ||
		sub.Session == "" || !strings.Contains(sub.Error, "401") || sub.Retry != (model.Retry{}) {
		t.Fatalf("the subagent after the stop: status %q, cause %q, errorKind %q, session %q, error %q, retry %+v\nwant paused, retrying-at-stop, login, a session and the 401 text\n%s",
			sub.Status, sub.Cause, sub.ErrorKind, sub.Session, sub.Error, sub.Retry, s.out.String())
	}
}
