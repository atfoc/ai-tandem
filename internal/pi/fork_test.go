package pi

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
)

// The ids of the fork tests: chat "A" holds session forkSrcSession, the fake reports forkNewSession
// after the fork, and the branch that gets the fork has a path-shaped server id.
const (
	forkSrcSession = "56a06f12-0000-4000-8000-000000000001"
	forkNewSession = "01a10361-7545-7000-8000-000000000002"
	forkBranch     = "A/branches/b1"
)

// forkSameState, given to forkFake as the "get_state#2" reply, makes the second get_state answer
// what the first did: pi still on the source session.
var forkSameState = fakeReply{Data: json.RawMessage(`"same"`)}

// forkFake is a fake pi set up for a fork start: chat A's session file exists, the first
// get_state reports it and the second one reports a new session in the branch's folder. extra
// overrides or adds replies.
func forkFake(t *testing.T, extra map[string]fakeReply, script ...string) (f *fake, s *Spawner, reg *fakeRegistry, srcFile string) {
	t.Helper()
	f = newFake(t, script...)
	srcFile = writeSessionFile(t, f.root, "A", "2026-10-04T10-00-00-000Z", forkSrcSession)
	newFile := filepath.Join(f.root, "chats", forkBranch, "pi", "2026-10-04T11-00-00-000Z_"+forkNewSession+".jsonl")
	state := func(id, file string) fakeReply {
		return fakeReply{Data: mustJSON(map[string]any{"sessionId": id, "sessionFile": file,
			"model": map[string]any{"provider": "test", "id": "test-model", "contextWindow": 1000}})}
	}
	replies := map[string]fakeReply{
		"get_state":   state(forkSrcSession, srcFile),
		"get_state#2": state(forkNewSession, newFile),
		"fork":        {Data: json.RawMessage(`{"text":"the next prompt","cancelled":false}`)},
		"clone":       {Data: json.RawMessage(`{"cancelled":false}`)},
	}
	for k, v := range extra {
		if k == "get_state#2" && string(v.Data) == string(forkSameState.Data) {
			v = replies["get_state"]
		}
		replies[k] = v
	}
	f.replies(t, replies)
	reg = &fakeRegistry{}
	s = f.spawner()
	s.Bridge = reg
	return f, s, reg, srcFile
}

// writeSessionFile creates a pi session file of a chat, named as pi names it.
func writeSessionFile(t *testing.T, root, chatID, stamp, sessionID string) string {
	t.Helper()
	dir := filepath.Join(root, "chats", chatID, "pi")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, stamp+"_"+sessionID+".jsonl")
	if err := os.WriteFile(path, []byte(`{"type":"session"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func forkOptions(t *testing.T) agent.SpawnOptions {
	return agent.SpawnOptions{ChatID: forkBranch, SessionID: "ignored-app-id", Cwd: t.TempDir(),
		Model: "test/test-model", Effort: "medium", BoardID: "board"}
}

// noProcess fails the test when the fake was started.
func (f *fake) noProcess(t *testing.T) {
	t.Helper()
	if _, err := os.Stat(f.args); err == nil {
		t.Error("a process was started")
	}
}

func TestSpawnForkAtTurn(t *testing.T) {
	f, s, reg, srcFile := forkFake(t, map[string]fakeReply{
		"get_fork_messages": {Data: json.RawMessage(`{"messages":[{"entryId":"0efdb07e","text":"one"},{"entryId":"aa11bb22","text":"new"}]}`)},
	}, `{"type":"agent_settled"}`)
	a, id, err := s.SpawnFork(forkOptions(t), agent.ForkSource{ChatID: "A", SessionID: forkSrcSession,
		Point: "0efdb07e", Next: "b85ebc6a"})
	if err != nil {
		t.Fatalf("SpawnFork: %v", err)
	}
	t.Cleanup(a.Close)
	if id != forkNewSession {
		t.Fatalf("session id %q, want the one the second get_state reported", id)
	}

	inv := f.invocation(t)
	sessionDir := filepath.Join(f.root, "chats", "A", "branches", "b1", "pi")
	if got := flagValue(inv.Args, "--session"); got != srcFile {
		t.Errorf("--session %q, want the source file %q", got, srcFile)
	}
	if got := flagValue(inv.Args, "--session-dir"); got != sessionDir {
		t.Errorf("--session-dir %q, want %q", got, sessionDir)
	}
	if contains(inv.Args, "--session-id") {
		t.Errorf("a fork start passed --session-id: %q", inv.Args)
	}
	if flagValue(inv.Args, "--model") != "test/test-model" || flagValue(inv.Args, "--thinking") != "medium" ||
		flagValue(inv.Args, "--append-system-prompt") != filepath.Join(sessionDir, "append-prompt.md") ||
		inv.Args[len(inv.Args)-1] != "--no-approve" {
		t.Errorf("args %q, want the rest as an ordinary start builds it", inv.Args)
	}
	// The path-shaped chat id reaches the bridge run and the environment unchanged.
	if got := reg.regs(); !equalStrings(got, []string{forkBranch}) {
		t.Errorf("registered %q, want the branch's server id", got)
	}
	if inv.ChatID != forkBranch || inv.ChatDir != filepath.Join(f.root, "chats", "A", "branches", "b1") || inv.BridgeRun != "run-7" {
		t.Errorf("env chat %q dir %q run %q", inv.ChatID, inv.ChatDir, inv.BridgeRun)
	}

	// The handshake is over: the new id and one catalog are waiting.
	if ev := next(t, a); ev.Kind != agent.EvSession || ev.SessionID != forkNewSession {
		t.Fatalf("first event %+v, want EvSession with the fork's id", ev)
	}
	if ev := next(t, a); ev.Kind != agent.EvCatalog || ev.Catalog == nil {
		t.Fatalf("second event %+v, want EvCatalog", ev)
	}
	// From here on it is an ordinary chat process: its turns report their point.
	if err := a.Send([]agent.ContentBlock{{Text: "hi"}}); err != nil {
		t.Fatal(err)
	}
	if ev := waitKind(t, a, agent.EvTurnEnd); ev.Point != "aa11bb22" {
		t.Fatalf("turn end %+v, want the point of the fork's own turn", ev)
	}

	lines := f.stdinLines(t, a)
	want := []string{"get_state", "fork", "get_state", "get_available_models", "set_model", "set_thinking_level",
		"prompt", "get_session_stats", "get_fork_messages"}
	if got := commandTypes(lines); !equalStrings(got, want) {
		t.Fatalf("commands %q\nwant %q", got, want)
	}
	if lines[1]["entryId"] != "b85ebc6a" {
		t.Errorf("fork %v, want entryId b85ebc6a", lines[1])
	}
}

// forkMessagesReply is a get_fork_messages answer listing user messages with these entry ids.
func forkMessagesReply(ids ...string) fakeReply {
	msgs := make([]map[string]string, 0, len(ids))
	for _, id := range ids {
		msgs = append(msgs, map[string]string{"entryId": id, "text": "said"})
	}
	return fakeReply{Data: mustJSON(map[string]any{"messages": msgs})}
}

// A fork's process gets its MCP config the way an ordinary start does: in the file of its own
// folder (the branch's), never in the environment.
func TestSpawnForkMCPConfigFile(t *testing.T) {
	const tok = "fork-mcp-token"
	f, s, _, _ := forkFake(t, map[string]fakeReply{
		"get_fork_messages": {Data: json.RawMessage(`{"messages":[{"entryId":"0efdb07e","text":"one"},{"entryId":"aa11bb22","text":"new"}]}`)},
	}, `{"type":"agent_settled"}`)
	o := forkOptions(t)
	o.MCP = &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: tok}
	a, _, err := s.SpawnFork(o, agent.ForkSource{ChatID: "A", SessionID: forkSrcSession,
		Point: "0efdb07e", Next: "b85ebc6a"})
	if err != nil {
		t.Fatalf("SpawnFork: %v", err)
	}
	t.Cleanup(a.Close)
	path := filepath.Join(f.root, "chats", "A", "branches", "b1", "mcp.json")
	if got := f.invocation(t).mcpFileConfig(t, path, tok); !strings.Contains(got, "Bearer "+tok) {
		t.Fatalf("the fork's mcp.json = %q", got)
	}
}

func TestSpawnForkAtEndClones(t *testing.T) {
	// The source holds nothing past the point: its last user message is the point's.
	f, s, _, srcFile := forkFake(t, map[string]fakeReply{"get_fork_messages": forkMessagesReply("0efdb07e", "59b265f9")})
	// At the end of the source there is no next mark; one that is given is not used.
	for _, next := range []string{"", "b85ebc6a"} {
		a, id, err := s.SpawnFork(forkOptions(t), agent.ForkSource{ChatID: "A", SessionID: forkSrcSession,
			Point: "59b265f9", Next: next, End: true})
		if err != nil {
			t.Fatalf("SpawnFork: %v", err)
		}
		if id != forkNewSession {
			t.Fatalf("session id %q", id)
		}
		if got := flagValue(f.invocation(t).Args, "--session"); got != srcFile {
			t.Errorf("--session %q, want %q", got, srcFile)
		}
		lines := f.stdinLines(t, a)
		want := []string{"get_state", "get_fork_messages", "clone", "get_state", "get_available_models", "set_model", "set_thinking_level"}
		if got := commandTypes(lines); !equalStrings(got, want) {
			t.Fatalf("commands %q\nwant %q", got, want)
		}
		if _, ok := lines[2]["entryId"]; ok {
			t.Errorf("clone carried an entry id: %v", lines[2])
		}
	}
}

// The end of the source is found by the chat manager before the start: a message the source took
// since then is in the file pi opens. The fork is then made before that message, not as a clone.
func TestSpawnForkAtEndCutsAtItsPoint(t *testing.T) {
	f, s, _, _ := forkFake(t, map[string]fakeReply{
		"get_fork_messages": forkMessagesReply("0efdb07e", "59b265f9", "c41d07aa", "d52e18bb")})
	a, id, err := s.SpawnFork(forkOptions(t), agent.ForkSource{ChatID: "A", SessionID: forkSrcSession,
		Point: "59b265f9", End: true})
	if err != nil {
		t.Fatalf("SpawnFork: %v", err)
	}
	if id != forkNewSession {
		t.Fatalf("session id %q", id)
	}
	lines := f.stdinLines(t, a)
	want := []string{"get_state", "get_fork_messages", "fork", "get_state", "get_available_models", "set_model", "set_thinking_level"}
	if got := commandTypes(lines); !equalStrings(got, want) {
		t.Fatalf("commands %q\nwant %q", got, want)
	}
	if lines[2]["entryId"] != "c41d07aa" {
		t.Errorf("fork %v, want the entry id of the message after the point, c41d07aa", lines[2])
	}
}

// A point with no next mark and no end: the turn after it is running in the source, which has
// its user message in the file but no mark for it yet. The fork is made before that message, and
// then checked to end at the point before the model commands run.
func TestSpawnForkFromRunningSource(t *testing.T) {
	f, s, _, srcFile := forkFake(t, map[string]fakeReply{
		"get_fork_messages":   forkMessagesReply("0efdb07e", "59b265f9", "c41d07aa"), // the source, turn 3 running
		"get_fork_messages#2": forkMessagesReply("0efdb07e", "59b265f9"),             // the fork
	})
	a, id, err := s.SpawnFork(forkOptions(t), agent.ForkSource{ChatID: "A", SessionID: forkSrcSession, Point: "59b265f9"})
	if err != nil {
		t.Fatalf("SpawnFork: %v", err)
	}
	if id != forkNewSession {
		t.Fatalf("session id %q", id)
	}
	if got := flagValue(f.invocation(t).Args, "--session"); got != srcFile {
		t.Errorf("--session %q, want %q", got, srcFile)
	}
	lines := f.stdinLines(t, a)
	want := []string{"get_state", "get_fork_messages", "fork", "get_state", "get_fork_messages",
		"get_available_models", "set_model", "set_thinking_level"}
	if got := commandTypes(lines); !equalStrings(got, want) {
		t.Fatalf("commands %q\nwant %q", got, want)
	}
	if lines[2]["entryId"] != "c41d07aa" {
		t.Errorf("fork %v, want the entry id of the running turn's message, c41d07aa", lines[2])
	}
}

// The point is the source's last user message when the fork's process opens the file (the next
// turn's message is not written yet): a clone, checked the same way.
func TestSpawnForkFromRunningSourceClones(t *testing.T) {
	f, s, _, _ := forkFake(t, map[string]fakeReply{"get_fork_messages": forkMessagesReply("0efdb07e", "59b265f9")})
	a, _, err := s.SpawnFork(forkOptions(t), agent.ForkSource{ChatID: "A", SessionID: forkSrcSession, Point: "59b265f9"})
	if err != nil {
		t.Fatalf("SpawnFork: %v", err)
	}
	want := []string{"get_state", "get_fork_messages", "clone", "get_state", "get_fork_messages",
		"get_available_models", "set_model", "set_thinking_level"}
	if got := commandTypes(f.stdinLines(t, a)); !equalStrings(got, want) {
		t.Fatalf("commands %q\nwant %q", got, want)
	}
}

// The check of a fork from a running source: a fork that does not end at the point fails, and so
// does one whose end cannot be read. Nothing of it stays (forkFails).
func TestSpawnForkFromRunningSourceChecked(t *testing.T) {
	src := agent.ForkSource{ChatID: "A", SessionID: forkSrcSession, Point: "59b265f9"}
	atPoint := forkMessagesReply("0efdb07e", "59b265f9")
	cloned := []string{"get_state", "get_fork_messages", "clone", "get_state", "get_fork_messages"}
	cases := []struct {
		name    string
		replies map[string]fakeReply
		want    string   // in the error
		cmds    []string // the commands pi read
	}{
		// The source appended a turn between the lookup and the clone, and the clone took it in.
		{"the source appended a turn", map[string]fakeReply{"get_fork_messages": atPoint,
			"get_fork_messages#2": forkMessagesReply("0efdb07e", "59b265f9", "c41d07aa")},
			`ends at "c41d07aa", not at the point "59b265f9"`, cloned},
		{"the fork was cut too early", map[string]fakeReply{"get_fork_messages": forkMessagesReply("0efdb07e", "59b265f9", "c41d07aa"),
			"get_fork_messages#2": forkMessagesReply("0efdb07e")},
			`ends at "0efdb07e", not at the point "59b265f9"`,
			[]string{"get_state", "get_fork_messages", "fork", "get_state", "get_fork_messages"}},
		// pi does not list the point: the clone holds whatever the source held, the running turn too.
		{"point not among the messages", map[string]fakeReply{"get_fork_messages": forkMessagesReply("0efdb07e", "c41d07aa")},
			`ends at "c41d07aa", not at the point "59b265f9"`, cloned},
		{"messages not answered", map[string]fakeReply{"get_fork_messages": atPoint,
			"get_fork_messages#2": {Fail: true, Error: "nope"}}, "cannot check where the fork ends: nope", cloned},
		{"messages never answered", map[string]fakeReply{"get_fork_messages": {Fail: true, Error: "nope"}},
			"cannot check where the fork ends: nope", cloned},
		{"no messages", map[string]fakeReply{"get_fork_messages": atPoint, "get_fork_messages#2": {}},
			"pi listed no messages", cloned},
		{"empty list", map[string]fakeReply{"get_fork_messages": atPoint, "get_fork_messages#2": forkMessagesReply()},
			"pi listed no messages", cloned},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err, cmds, _ := forkFails(t, c.replies, src, 0)
			if !strings.HasPrefix(err.Error(), "pi fork: ") || !strings.Contains(err.Error(), c.want) {
				t.Errorf("error %q, want one holding %q", err, c.want)
			}
			if !equalStrings(cmds, c.cmds) {
				t.Errorf("commands %q\nwant %q", cmds, c.cmds)
			}
		})
	}
}

// A fork at the source's end is not checked: with End, a fork that holds more than the point's
// turn, or whose messages pi does not list, starts as it did.
func TestSpawnForkAtEndIsNotChecked(t *testing.T) {
	for name, second := range map[string]fakeReply{
		"more than the point": forkMessagesReply("0efdb07e", "59b265f9", "c41d07aa"),
		"not answered":        {Fail: true, Error: "nope"},
	} {
		t.Run(name, func(t *testing.T) {
			f, s, _, _ := forkFake(t, map[string]fakeReply{
				"get_fork_messages": forkMessagesReply("0efdb07e", "59b265f9"), "get_fork_messages#2": second})
			a, _, err := s.SpawnFork(forkOptions(t), agent.ForkSource{ChatID: "A", SessionID: forkSrcSession,
				Point: "59b265f9", End: true})
			if err != nil {
				t.Fatalf("SpawnFork: %v", err)
			}
			want := []string{"get_state", "get_fork_messages", "clone", "get_state", "get_available_models", "set_model", "set_thinking_level"}
			if got := commandTypes(f.stdinLines(t, a)); !equalStrings(got, want) {
				t.Fatalf("commands %q\nwant %q", got, want)
			}
		})
	}
}

// Without a way to tell what follows the point, the end of the source is a clone, as it was.
func TestSpawnForkAtEndClonesWhenPointUnknown(t *testing.T) {
	cases := []struct {
		name  string
		point string
		reply fakeReply
		want  []string // the commands up to the clone
	}{
		{"no point recorded", "", forkMessagesReply("0efdb07e", "59b265f9"), []string{"get_state", "clone"}},
		{"point not among the messages", "ffffffff", forkMessagesReply("0efdb07e", "59b265f9"), []string{"get_state", "get_fork_messages", "clone"}},
		{"no messages", "59b265f9", fakeReply{}, []string{"get_state", "get_fork_messages", "clone"}},
		{"messages not answered", "59b265f9", fakeReply{Fail: true, Error: "nope"}, []string{"get_state", "get_fork_messages", "clone"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f, s, _, _ := forkFake(t, map[string]fakeReply{"get_fork_messages": c.reply})
			a, _, err := s.SpawnFork(forkOptions(t), agent.ForkSource{ChatID: "A", SessionID: forkSrcSession,
				Point: c.point, End: true})
			if err != nil {
				t.Fatalf("SpawnFork: %v", err)
			}
			got := commandTypes(f.stdinLines(t, a))
			if len(got) < len(c.want) || !equalStrings(got[:len(c.want)], c.want) {
				t.Fatalf("commands %q\nwant them to start with %q", got, c.want)
			}
		})
	}
}

func TestSpawnForkNoProcessErrors(t *testing.T) {
	t.Run("missing source file", func(t *testing.T) {
		f, s, reg, srcFile := forkFake(t, nil)
		if err := os.Remove(srcFile); err != nil {
			t.Fatal(err)
		}
		a, id, err := s.SpawnFork(forkOptions(t), agent.ForkSource{ChatID: "A", SessionID: forkSrcSession, Next: "b85ebc6a"})
		if err == nil || !strings.Contains(err.Error(), forkSrcSession) || a != nil || id != "" {
			t.Fatalf("SpawnFork = %v, %q, %v; want an error naming the session", a, id, err)
		}
		f.noProcess(t)
		if got := reg.regs(); len(got) != 0 {
			t.Errorf("registered %q for a fork that never started", got)
		}
	})
	t.Run("another chat's session", func(t *testing.T) {
		f, s, _, _ := forkFake(t, nil)
		if _, _, err := s.SpawnFork(forkOptions(t), agent.ForkSource{ChatID: "B", SessionID: forkSrcSession, End: true}); err == nil {
			t.Fatal("SpawnFork found a session file in a chat that has none")
		}
		f.noProcess(t)
	})
	t.Run("no point and no next mark", func(t *testing.T) {
		f, s, reg, _ := forkFake(t, nil)
		a, id, err := s.SpawnFork(forkOptions(t), agent.ForkSource{ChatID: "A", SessionID: forkSrcSession})
		if err == nil || err.Error() != "pi: no fork point after that turn" || a != nil || id != "" {
			t.Fatalf("SpawnFork = %v, %q, %v", a, id, err)
		}
		f.noProcess(t)
		if got := reg.regs(); len(got) != 0 {
			t.Errorf("registered %q for a fork that never started", got)
		}
	})
	t.Run("missing folder", func(t *testing.T) {
		f, s, _, _ := forkFake(t, nil)
		o := forkOptions(t)
		o.Cwd = filepath.Join(o.Cwd, "gone")
		if _, _, err := s.SpawnFork(o, agent.ForkSource{ChatID: "A", SessionID: forkSrcSession, End: true}); err != agent.ErrFolderMissing {
			t.Fatalf("SpawnFork error %v, want ErrFolderMissing", err)
		}
		f.noProcess(t)
	})
}

// forkFails runs a fork start that must fail after its process started, and checks the process
// (and what it started) is gone when SpawnFork returns, the bridge run is deregistered, and the
// model commands never ran. It returns the error, the commands pi read and the source file.
func forkFails(t *testing.T, extra map[string]fakeReply, src agent.ForkSource, timeout time.Duration) (error, []string, string) {
	t.Helper()
	err, cmds, srcFile, _ := forkFailsAfter(t, extra, src, timeout, "")
	return err, cmds, srcFile
}

// forkFailsAfter is forkFails for a start that fails because its time box ends: with need set, a
// box that ended before pi read the command need (the fake had not got that far) does not count.
// ok is then false and nothing else was checked.
func forkFailsAfter(t *testing.T, extra map[string]fakeReply, src agent.ForkSource, timeout time.Duration, need string) (err error, cmds []string, srcFile string, ok bool) {
	t.Helper()
	f, s, reg, srcFile := forkFake(t, extra)
	s.forkTimeout = timeout
	pidFile := filepath.Join(f.dir, "child.json")
	t.Setenv(envChildPid, pidFile)
	a, id, err := s.SpawnFork(forkOptions(t), src)
	if err == nil {
		a.Close()
		t.Fatal("SpawnFork succeeded")
	}
	if a != nil || id != "" {
		t.Fatalf("a failed SpawnFork returned %v, %q", a, id)
	}
	if need != "" && !f.readCommand(need) {
		return err, nil, srcFile, false
	}
	parent, child := childPids(t, pidFile)
	if syscall.Kill(parent, 0) == nil {
		t.Errorf("pi (pid %d) is still running after SpawnFork returned", parent)
	}
	waitPidsGone(t, parent, child)
	if got := reg.regs(); !equalStrings(got, []string{forkBranch}) {
		t.Errorf("registered %q, want the branch's server id", got)
	}
	if got := reg.deregs(); len(got) == 0 || got[0] != "run-7" {
		t.Errorf("deregistered %q, want the fork's run", got)
	}
	got := commandTypes(f.recorded(t))
	for _, c := range got {
		if c == "set_model" || c == "set_thinking_level" {
			t.Errorf("commands %q: a model command ran in a failed fork", got)
		}
	}
	return err, got, srcFile, true
}

func TestSpawnForkFailures(t *testing.T) {
	at := agent.ForkSource{ChatID: "A", SessionID: forkSrcSession, Point: "0efdb07e", Next: "b85ebc6a"}
	t.Run("fork rejected", func(t *testing.T) {
		err, cmds, _ := forkFails(t, map[string]fakeReply{"fork": {Fail: true, Error: "Invalid entry ID for forking"}}, at, 0)
		if err.Error() != "pi fork: Invalid entry ID for forking" {
			t.Errorf("error %q", err)
		}
		if !equalStrings(cmds, []string{"get_state", "fork"}) {
			t.Errorf("commands %q", cmds)
		}
	})
	t.Run("clone rejected", func(t *testing.T) {
		end := at
		end.End = true
		err, cmds, _ := forkFails(t, map[string]fakeReply{"clone": {Fail: true, Error: "This session has not been saved yet."}}, end, 0)
		if err.Error() != "pi fork: This session has not been saved yet." {
			t.Errorf("error %q", err)
		}
		if !equalStrings(cmds, []string{"get_state", "get_fork_messages", "clone"}) {
			t.Errorf("commands %q", cmds)
		}
	})
	t.Run("fork cancelled", func(t *testing.T) {
		err, cmds, _ := forkFails(t, map[string]fakeReply{"fork": {Data: json.RawMessage(`{"text":"x","cancelled":true}`)}}, at, 0)
		if !strings.HasPrefix(err.Error(), "pi fork: ") || !strings.Contains(err.Error(), "cancelled") {
			t.Errorf("error %q", err)
		}
		if !equalStrings(cmds, []string{"get_state", "fork"}) {
			t.Errorf("commands %q", cmds)
		}
	})
	t.Run("still on the source", func(t *testing.T) {
		// The second get_state answers like the first: the source's file. forkSameState makes the
		// fake repeat its first answer.
		err, cmds, _ := forkFails(t, map[string]fakeReply{"get_state#2": forkSameState}, at, 0)
		if !strings.Contains(err.Error(), "still on the source session") {
			t.Errorf("error %q", err)
		}
		if !equalStrings(cmds, []string{"get_state", "fork", "get_state"}) {
			t.Errorf("commands %q", cmds)
		}
	})
	t.Run("pi opened another session", func(t *testing.T) {
		other := fakeReply{Data: json.RawMessage(`{"sessionId":"new-empty","sessionFile":"/tmp/elsewhere.jsonl","model":{"provider":"test","id":"test-model"}}`)}
		err, cmds, _ := forkFails(t, map[string]fakeReply{"get_state": other}, at, 0)
		if !strings.Contains(err.Error(), "not the source session") {
			t.Errorf("error %q", err)
		}
		if !equalStrings(cmds, []string{"get_state"}) {
			t.Errorf("commands %q: nothing may be sent to a session that is not the source", cmds)
		}
	})
	t.Run("fork never answered", func(t *testing.T) {
		// pi has to start and read the fork command within the time box. A box that ended before
		// that does not count and a longer one follows; the last holds on a machine that is busy
		// with several whole test suites, only costs its time there, and is still well below the
		// handshake's own time box.
		boxes := []time.Duration{300 * time.Millisecond, 1200 * time.Millisecond, 5 * time.Second, 10 * time.Second}
		for i, box := range boxes {
			need := "fork"
			if i == len(boxes)-1 {
				need = ""
			}
			start := time.Now()
			err, cmds, _, ok := forkFailsAfter(t, map[string]fakeReply{"fork": {Silent: true}}, at, box, need)
			if !ok {
				t.Logf("%s was too short on this machine now", box)
				continue
			}
			if !strings.Contains(err.Error(), fmt.Sprintf("did not confirm the fork within %s", box)) {
				t.Errorf("error %q", err)
			}
			if took := time.Since(start); took < box || took > handshakeTimeout/2 {
				t.Errorf("SpawnFork took %s, want the shortened time box", took)
			}
			if !equalStrings(cmds, []string{"get_state", "fork"}) {
				t.Errorf("commands %q", cmds)
			}
			break
		}
	})
}

func TestFindSessionFile(t *testing.T) {
	root := t.TempDir()
	s := &Spawner{AppRoot: root}
	old := writeSessionFile(t, root, forkBranch, "2026-10-01T10-00-00-000Z", "s1")
	newer := writeSessionFile(t, root, forkBranch, "2026-10-02T10-00-00-000Z", "s1")
	writeSessionFile(t, root, forkBranch, "2026-10-03T10-00-00-000Z", "xs1x")
	writeSessionFile(t, root, forkBranch, "2026-10-03T10-00-00-000Z", "other-s1")
	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}
	if got, err := s.findSessionFile(s.chatDir(forkBranch, ""), "s1"); err != nil || got != newer {
		t.Fatalf("findSessionFile = %q, %v; want the newest match %q", got, err, newer)
	}
	if err := os.Chtimes(newer, past.Add(-time.Hour), past.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if got, err := s.findSessionFile(s.chatDir(forkBranch, ""), "s1"); err != nil || got != old {
		t.Fatalf("findSessionFile = %q, %v; want %q, now the newest", got, err, old)
	}
	for _, id := range []string{"", "s2", "1"} {
		if got, err := s.findSessionFile(s.chatDir(forkBranch, ""), id); err == nil {
			t.Errorf("findSessionFile(%q) = %q, want an error", id, got)
		}
	}
	if _, err := s.findSessionFile(s.chatDir("no-chat", ""), "s1"); err == nil || !strings.Contains(err.Error(), "s1") {
		t.Errorf("missing folder: error %v, want one naming the session", err)
	}
}

func TestDiscardForkDoesNothing(t *testing.T) {
	root := t.TempDir()
	s := &Spawner{AppRoot: root}
	file := writeSessionFile(t, root, forkBranch, "2026-10-01T10-00-00-000Z", "s1")
	s.DiscardFork("s1")
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("DiscardFork touched the session file: %v", err)
	}
}
