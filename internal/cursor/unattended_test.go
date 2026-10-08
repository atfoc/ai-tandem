package cursor

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
)

// fakeArgs is the argument list the fake was started with.
func (e *env) fakeArgs(t *testing.T) []string {
	t.Helper()
	b, err := os.ReadFile(e.fake.vars["FAKE_ACP_ARGS"])
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(string(b), "\n")
}

// A chat's process is `agent acp`, as ever; an unattended one `agent --force acp`, the only form
// that stops every permission request whatever the user's approval mode is.
func TestArgvUnattended(t *testing.T) {
	t.Parallel()
	cases := []struct {
		o    agent.SpawnOptions
		want []string
	}{
		{agent.SpawnOptions{}, []string{"acp"}},
		{agent.SpawnOptions{ReadOnly: true}, []string{"acp"}},
		{agent.SpawnOptions{Unattended: true}, []string{"--force", "acp"}},
		{agent.SpawnOptions{Unattended: true, ReadOnly: true}, []string{"--force", "acp"}},
	}
	for _, c := range cases {
		e := newEnv(t, baseScript())
		a := e.spawn(t, c.o)
		until(t, a, isKind(agent.EvCatalog))
		if got := e.fakeArgs(t); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%+v: argv %q, want %q", c.o, got, c.want)
		}
	}
}

// permRequest is a session/request_permission for a shell command or, with server set, an MCP call.
func permRequest(id, cmd, server, tool string) fakeStep {
	call := map[string]any{"toolCallId": id, "title": "`" + cmd + "`", "kind": "execute", "status": "pending"}
	if server != "" {
		call = map[string]any{"toolCallId": id, "title": server + ": " + tool, "kind": "other", "status": "pending",
			"rawInput": mcpRawInput(server, tool, map[string]any{"run": "r1"})}
	}
	return step("request", map[string]any{"method": "session/request_permission", "params": map[string]any{
		"sessionId": testSessionID, "toolCall": call,
		"options": []any{
			map[string]any{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
			map[string]any{"optionId": "allow-always", "name": "Allow always", "kind": "allow_always"},
			map[string]any{"optionId": "reject-once", "name": "Reject", "kind": "reject_once"},
		},
	}})
}

// permAnswers lists the adapter's answers to the fake's requests, in order: the option ids.
func permAnswers(t *testing.T, record string) []string {
	t.Helper()
	var out []string
	for _, r := range readRecord(t, record) {
		if r.Method == "" && strings.HasPrefix(string(r.ID), `"srv-`) {
			var res struct {
				Outcome struct{ Outcome, OptionID string } `json:"outcome"`
			}
			json.Unmarshal(r.Result, &res)
			out = append(out, res.Outcome.OptionID)
		}
	}
	return out
}

// runTurn sends one message and returns the turn's permission events.
func runTurn(t *testing.T, a agent.Agent) (perms []agent.Event, all []agent.Event) {
	t.Helper()
	send(t, a, "go")
	all = until(t, a, isKind(agent.EvTurnEnd))
	for _, ev := range all {
		if ev.Kind == agent.EvPermRequest {
			perms = append(perms, ev)
		}
	}
	return perms, all
}

// Nobody answers the requests of an unattended or a read-only process, so none becomes a card:
// the adapter answers each at once. The app's folder is refused as always; beyond that an
// unattended process is allowed and a read-only one refused, also when it is unattended too.
func TestStrayPermissionRequestIsAnsweredAtOnce(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		o    agent.SpawnOptions
		want []string
	}{
		{"unattended", agent.SpawnOptions{Unattended: true}, []string{"allow-once", "reject-once", "allow-once"}},
		{"read-only", agent.SpawnOptions{ReadOnly: true}, []string{"reject-once", "reject-once", "reject-once"}},
		{"read-only and unattended", agent.SpawnOptions{ReadOnly: true, Unattended: true}, []string{"reject-once", "reject-once", "reject-once"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			s := baseScript()
			s["session/prompt"] = []fakeStep{
				permRequest("c1", "touch a.txt", "", ""),
				permRequest("c2", "cat ~/.ai-whiteboard/state.json", "", ""),
				permRequest("c3", "", "other", "thing"),
				{Result: raw(`{"stopReason":"end_turn"}`)},
			}
			e := newEnv(t, s)
			a := e.spawn(t, c.o)
			if perms, _ := runTurn(t, a); len(perms) != 0 {
				t.Fatalf("permission requests were raised: %+v", perms)
			}
			if got := permAnswers(t, e.record); !reflect.DeepEqual(got, c.want) {
				t.Errorf("answers %v, want %v", got, c.want)
			}
		})
	}
}

// With MCPTools the app's tools are the names in that list and nothing else: a call of one is
// shown under the app's tool name and approved without a card, whatever the board and subagent
// settings say; a tool of the same server that is not in the list is neither.
func TestMCPToolsList(t *testing.T) {
	t.Parallel()
	mcp := &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: boardToken}
	call := func(id, server, tool string) []fakeStep {
		return []fakeStep{
			step("update", map[string]any{"sessionUpdate": "tool_call", "toolCallId": id, "title": "MCP: tool", "kind": "other", "status": "pending", "rawInput": map[string]any{}}),
			step("update", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": id, "title": server + ": " + tool,
				"rawInput": mcpRawInput(server, tool, map[string]any{"run": "r1"})}),
		}
	}
	script := func() fakeScript {
		s := baseScript()
		var steps []fakeStep
		steps = append(steps, call("m1", "board", "get_run")...)
		steps = append(steps, call("m2", "board", "spawn_subagent")...)
		steps = append(steps, call("m3", "other", "get_run")...)
		steps = append(steps,
			permRequest("m1", "", "board", "get_run"),
			permRequest("m2", "", "board", "spawn_subagent"),
			permRequest("m3", "", "other", "get_run"),
			fakeStep{Result: raw(`{"stopReason":"end_turn"}`)})
		s["session/prompt"] = steps
		return s
	}
	names := func(all []agent.Event) []string {
		var out []string
		for _, ev := range all {
			if ev.Kind == agent.EvToolInput {
				out = append(out, ev.ToolName)
			}
		}
		return out
	}

	t.Run("a list", func(t *testing.T) {
		e := newEnv(t, script())
		a := e.spawn(t, agent.SpawnOptions{MCP: mcp, MCPTools: []string{"get_run", "list_tasks"}})
		send(t, a, "go")
		var perms, all []agent.Event
		until(t, a, func(ev agent.Event) bool {
			all = append(all, ev)
			if ev.Kind == agent.EvPermRequest {
				perms = append(perms, ev)
				a.Decide(ev.PermID, false)
			}
			return ev.Kind == agent.EvTurnEnd
		})
		if got, want := names(all), []string{"mcp__board__get_run", "board: spawn_subagent", "other: get_run"}; !reflect.DeepEqual(got, want) {
			t.Errorf("tool names %q, want %q", got, want)
		}
		for _, ev := range all {
			if ev.Kind == agent.EvToolInput && ev.ToolName == "mcp__board__get_run" {
				jsonEq(t, ev.Input, `{"run":"r1"}`)
			}
		}
		// get_run is approved by the adapter; the two others are asked about (and refused here).
		if len(perms) != 2 || perms[0].ToolID != "m2" || perms[1].ToolID != "m3" {
			t.Errorf("permission requests %+v, want those of m2 and m3", perms)
		}
		if got, want := permAnswers(t, e.record), []string{"allow-once", "reject-once", "reject-once"}; !reflect.DeepEqual(got, want) {
			t.Errorf("answers %v, want %v", got, want)
		}
	})

	t.Run("an empty list", func(t *testing.T) {
		e := newEnv(t, script())
		a := e.spawn(t, agent.SpawnOptions{MCP: mcp, BoardID: "b", MCPTools: []string{}, Unattended: true})
		perms, all := runTurn(t, a)
		if got, want := names(all), []string{"board: get_run", "board: spawn_subagent", "other: get_run"}; !reflect.DeepEqual(got, want) {
			t.Errorf("tool names %q, want %q", got, want)
		}
		if len(perms) != 0 {
			t.Errorf("an unattended process raised %+v", perms)
		}
	})

	t.Run("no list", func(t *testing.T) {
		e := newEnv(t, script())
		a := e.spawn(t, agent.SpawnOptions{MCP: mcp})
		send(t, a, "go")
		var perms, all []agent.Event
		until(t, a, func(ev agent.Event) bool {
			all = append(all, ev)
			if ev.Kind == agent.EvPermRequest {
				perms = append(perms, ev)
				a.Decide(ev.PermID, false)
			}
			return ev.Kind == agent.EvTurnEnd
		})
		// As before: the spawn family is the app's whenever MCP is attached, get_run is unknown.
		if got, want := names(all), []string{"board: get_run", "mcp__board__spawn_subagent", "other: get_run"}; !reflect.DeepEqual(got, want) {
			t.Errorf("tool names %q, want %q", got, want)
		}
		if len(perms) != 2 || perms[0].ToolID != "m1" || perms[1].ToolID != "m3" {
			t.Errorf("permission requests %+v, want those of m1 and m3", perms)
		}
	})

	// A read-only process still calls its MCP tools: the list is approved before read-only refuses.
	t.Run("read-only", func(t *testing.T) {
		e := newEnv(t, script())
		a := e.spawn(t, agent.SpawnOptions{MCP: mcp, MCPTools: []string{"get_run"}, ReadOnly: true, Unattended: true})
		if perms, _ := runTurn(t, a); len(perms) != 0 {
			t.Errorf("permission requests %+v", perms)
		}
		if got, want := permAnswers(t, e.record), []string{"allow-once", "reject-once", "reject-once"}; !reflect.DeepEqual(got, want) {
			t.Errorf("answers %v, want %v", got, want)
		}
	})
}

// Cursor's answer to session/load for an id it does not have (cursor-agent 2026.10.01).
const loadNotFound = `{"code":-32602,"message":"Invalid params","data":{"message":"Session \"` + testSessionID + `\" not found"}}`

// A resume of a session Cursor does not have fails Send with Cursor's own words, as before, and
// that error is ErrNoSession. No event says so and the process stays, for the caller to close.
func TestResumeUnknownSession(t *testing.T) {
	t.Parallel()
	e := newEnv(t, fakeScript{"session/load": {{Error: raw(loadNotFound)}}})
	a := e.spawn(t, agent.SpawnOptions{SessionID: testSessionID, Resume: true})
	err := a.Send([]agent.ContentBlock{{Text: "hi"}})
	const want = `session/load: Invalid params {"message":"Session \"` + testSessionID + `\" not found"}`
	if err == nil || err.Error() != want {
		t.Fatalf("Send error %v\nwant %s", err, want)
	}
	if !errors.Is(err, agent.ErrNoSession) {
		t.Error("the error is not ErrNoSession")
	}
	select {
	case ev := <-a.Events():
		t.Errorf("event %+v, want none", ev)
	case <-time.After(100 * time.Millisecond):
	}

	// Another failure of the load is not "no session".
	e = newEnv(t, fakeScript{"session/load": {{Error: raw(`{"code":-32603,"message":"Internal error"}`)}}})
	a = e.spawn(t, agent.SpawnOptions{SessionID: testSessionID, Resume: true})
	if err := a.Send([]agent.ContentBlock{{Text: "hi"}}); err == nil || errors.Is(err, agent.ErrNoSession) {
		t.Errorf("Send error %v, want one that is not ErrNoSession", err)
	}
}

// A session that loads without a single user message holds no turn: with NeedHistory that is
// ErrNoSession; without it the resume goes on as before. One replayed user message is a history.
func TestResumeNeedHistory(t *testing.T) {
	t.Parallel()
	userChunk := step("update", map[string]any{"sessionUpdate": "user_message_chunk", "content": map[string]any{"type": "text", "text": "the task"}})
	agentChunk := step("update", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "old"}})
	endTurn := fakeStep{Result: raw(`{"stopReason":"end_turn"}`)}
	empty := fakeScript{"session/load": {{Cursor: true}}, "session/prompt": {endTurn}}
	// What the agent wrote is no history without the message that asked for it.
	headless := fakeScript{"session/load": {agentChunk, {Cursor: true}}, "session/prompt": {endTurn}}
	held := fakeScript{"session/load": {userChunk, agentChunk, {Cursor: true}}, "session/prompt": {endTurn}}

	for name, script := range map[string]fakeScript{"nothing replayed": empty, "no user message replayed": headless} {
		e := newEnv(t, script)
		a := e.spawn(t, agent.SpawnOptions{SessionID: testSessionID, Resume: true, NeedHistory: true})
		err := a.Send([]agent.ContentBlock{{Text: "continue"}})
		if !errors.Is(err, agent.ErrNoSession) || !strings.Contains(err.Error(), testSessionID) {
			t.Errorf("%s, NeedHistory: Send error %v, want ErrNoSession naming the session", name, err)
		}
		if _, ok := find(readRecord(t, e.record), "session/prompt"); ok {
			t.Errorf("%s, NeedHistory: the prompt was sent", name)
		}
	}

	e := newEnv(t, empty)
	a := e.spawn(t, agent.SpawnOptions{SessionID: testSessionID, Resume: true})
	send(t, a, "continue")
	if end := until(t, a, isKind(agent.EvTurnEnd)); end[len(end)-1].Error != "" {
		t.Errorf("without NeedHistory: turn end %+v", end[len(end)-1])
	}

	e = newEnv(t, held)
	a = e.spawn(t, agent.SpawnOptions{SessionID: testSessionID, Resume: true, NeedHistory: true})
	send(t, a, "continue")
	evs := until(t, a, isKind(agent.EvTurnEnd))
	if end := evs[len(evs)-1]; end.Error != "" || end.NoSession {
		t.Errorf("a session with history: turn end %+v", end)
	}
	for _, ev := range evs {
		if ev.Kind == agent.EvTextDelta {
			t.Errorf("the replay reached the chat: %+v", ev)
		}
	}
}

// fakeChildren reads the two pids the fake wrote (FAKE_ACP_CHILDREN): the child in the fake's
// process group and the one that leads a group of its own. Both are ended when the test ends,
// each by its own pid and only while it is still a sleeping copy of the test binary.
func fakeChildren(t *testing.T, file string) (inGroup, ownGroup int) {
	t.Helper()
	for deadline := time.Now().Add(mustHappen); ; time.Sleep(5 * time.Millisecond) {
		b, _ := os.ReadFile(file)
		if n, _ := fmt.Sscan(string(b), &inGroup, &ownGroup); n == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the fake did not start its children")
		}
	}
	t.Cleanup(func() {
		for _, pid := range []int{inGroup, ownGroup} {
			if alive(pid) {
				syscall.Kill(pid, syscall.SIGKILL)
			}
		}
	})
	return inGroup, ownGroup
}

// alive reports whether pid is a running copy of the test binary: `kill -0` finds it, it is no
// zombie, and it is not another program that got the number.
func alive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	out, err := exec.Command("ps", "-o", "stat=,comm=", "-p", strconv.Itoa(pid)).Output()
	f := strings.Fields(string(out))
	return err == nil && len(f) >= 2 && !strings.HasPrefix(f[0], "Z") && filepath.Base(f[len(f)-1]) == filepath.Base(os.Args[0])
}

func waitGone(t *testing.T, what string, pid int) {
	t.Helper()
	for deadline := time.Now().Add(mustHappen); alive(pid); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("%s (%d) is still running", what, pid)
		}
	}
}

// closeAndCount closes the process and returns its exit events and how long Close took.
func closeAndCount(t *testing.T, a agent.Agent) (exits []agent.Event, took time.Duration) {
	t.Helper()
	start := time.Now()
	a.Close()
	took = time.Since(start)
	timeout := time.After(mustHappen)
	for {
		select {
		case ev, ok := <-a.Events():
			if !ok {
				return exits, took
			}
			if ev.Kind == agent.EvExit {
				exits = append(exits, ev)
			}
		case <-timeout:
			t.Fatal("events not closed after Close")
		}
	}
}

// Close ends everything in the process's group, not the process alone: what Cursor leaves there
// (its worker-server, language servers) would otherwise stay. A chat's process keeps what it
// started in other groups; an unattended one's Close ends those too. Either way there is one exit.
func TestCloseEndsTheGroup(t *testing.T) {
	// Not parallel with the other tests, as every test here that times Close: only its own cases
	// run at the same moment.
	//
	// SIGTERM ends everything here, so the time after it is not needed: a Close that waited it
	// out is told from one that did not by closeBox.
	setGrace(t, &closeTermGrace, graceNotNeeded)
	cases := []struct {
		name       string
		o          agent.SpawnOptions
		stay       bool // the process does not exit when stdin closes, like `agent acp`
		ownGroupGo bool
	}{
		{"a chat", agent.SpawnOptions{}, false, false},
		{"a chat whose process stays", agent.SpawnOptions{}, true, false},
		{"unattended", agent.SpawnOptions{Unattended: true}, false, true},
		{"unattended, the process stays", agent.SpawnOptions{Unattended: true}, true, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, baseScript())
			pidFile := filepath.Join(t.TempDir(), "pids")
			e.fake.set(t, "FAKE_ACP_CHILDREN", pidFile)
			if c.stay {
				e.fake.set(t, "FAKE_ACP_STAY", "1")
			}
			a := e.spawn(t, c.o)
			until(t, a, isKind(agent.EvCatalog))
			inGroup, ownGroup := fakeChildren(t, pidFile)
			leader := a.(*proc).conn.cmd.Process.Pid
			if !alive(inGroup) || !alive(ownGroup) {
				t.Fatal("the fake's children are not running")
			}

			exits, took := closeAndCount(t, a)
			if len(exits) != 1 {
				t.Errorf("%d exit events, want 1", len(exits))
			} else if c.stay && !strings.Contains(exits[0].ExitErr, "terminated") {
				t.Errorf("exit %q, want the process ended by SIGTERM", exits[0].ExitErr)
			}
			if took > closeBox {
				t.Errorf("Close took %s", took)
			}
			if syscall.Kill(leader, 0) == nil && alive(leader) {
				t.Errorf("the process (%d) is still running", leader)
			}
			waitGone(t, "the child in the process's group", inGroup)
			if errors.Is(syscall.Kill(-leader, 0), nil) {
				t.Errorf("the process group %d still has members", leader)
			}
			if c.ownGroupGo {
				waitGone(t, "the child that leads a group of its own", ownGroup)
			} else if !alive(ownGroup) {
				t.Error("Close of a chat's process ended a group it does not own")
			}
			// A second Close does nothing and does not wait.
			start := time.Now()
			a.Close()
			if d := time.Since(start); d > closeBox {
				t.Errorf("a second Close took %s", d)
			}
		})
	}
}

// A process that exits by itself when stdin closes and leaves nothing gets no signal at all: its
// exit is clean.
func TestCloseCleanExit(t *testing.T) {
	// Not parallel: it times Close.
	//
	// Close goes on as soon as the process has exited, so neither wait is needed in full. With
	// the usual 300 ms for stdin, a fake that is slow to exit on a loaded machine would get the
	// SIGTERM this test says it does not get.
	setGrace(t, &closeStdinGrace, graceNotNeeded)
	setGrace(t, &closeTermGrace, graceNotNeeded)
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{Unattended: true})
	until(t, a, isKind(agent.EvCatalog))
	exits, took := closeAndCount(t, a)
	if len(exits) != 1 || exits[0].ExitErr != "" {
		t.Errorf("exit events %+v, want one without an error", exits)
	}
	// Well under either wait: Close sat neither out.
	if took > closeBox {
		t.Errorf("Close took %s", took)
	}
}

// latePid waits for the pid the fake wrote once its stdin had closed (FAKE_ACP_LATE). The process
// is ended when the test ends, while it is still a sleeping copy of the test binary.
func latePid(t *testing.T, file string) int {
	t.Helper()
	pid := 0
	for deadline := time.Now().Add(mustHappen); ; time.Sleep(5 * time.Millisecond) {
		b, _ := os.ReadFile(file)
		if n, _ := fmt.Sscan(string(b), &pid); n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the fake did not start its late child")
		}
	}
	t.Cleanup(func() {
		if alive(pid) {
			syscall.Kill(pid, syscall.SIGKILL)
		}
	})
	return pid
}

// A turn that is still running starts commands until the process ends: one started after Close
// began (here once stdin had closed) is found too, by the look before the signal, and ended.
func TestCloseEndsACommandStartedLate(t *testing.T) {
	// Not parallel: it times Close.
	//
	// SIGTERM ends the process and the command, so the time after it is not needed. The time for
	// stdin is waited out in full, as the process stays, and inside it the fake has to start the
	// command: Close looks for it when that time is over. A command started later than that is
	// not one this test is about, so such a round does not count (waitsOutBox).
	setGrace(t, &closeTermGrace, graceNotNeeded)
	waitsOutBox(t, closeStdinGrace, 20*time.Second, func(box time.Duration, short bool) bool {
		setGrace(t, &closeStdinGrace, box)
		e := newEnv(t, baseScript())
		late := filepath.Join(t.TempDir(), "late")
		e.fake.set(t, "FAKE_ACP_LATE", late)
		e.fake.set(t, "FAKE_ACP_STAY", "1")
		a := e.spawn(t, agent.SpawnOptions{Unattended: true})
		until(t, a, isKind(agent.EvCatalog))

		begun := time.Now()
		exits, took := closeAndCount(t, a)
		pid := latePid(t, late)
		// The fake writes the file once the command runs: written before the time for stdin was
		// over, the command was there when Close looked.
		if fi, err := os.Stat(late); short && (err != nil || fi.ModTime().After(begun.Add(box))) {
			return false
		}
		if len(exits) != 1 || !strings.Contains(exits[0].ExitErr, "terminated") {
			t.Errorf("exit events %+v, want one of a process ended by SIGTERM", exits)
		}
		if took > box+closeBox {
			t.Errorf("Close took %s", took)
		}
		waitGone(t, "the command started after Close began", pid)
		return true
	})
}

// An unattended process is told to stop its turn before it is ended, as Claude's is; a chat's
// process is not.
func TestCloseInterruptsAnUnattendedProcess(t *testing.T) {
	t.Parallel()
	for _, unattended := range []bool{true, false} {
		e := newEnv(t, baseScript())
		a := e.spawn(t, agent.SpawnOptions{Unattended: unattended})
		until(t, a, isKind(agent.EvCatalog))
		send(t, a, "go")
		until(t, a, isKind(agent.EvTurnEnd))
		closeAndCount(t, a)
		rs := readRecord(t, e.record)
		if _, ok := find(rs, "session/cancel"); ok != unattended {
			t.Errorf("unattended %v: session/cancel sent = %v", unattended, ok)
		}
		if unattended && methods(rs)[len(methods(rs))-1] != "session/cancel" {
			t.Errorf("the cancel is not the last thing sent: %q", methods(rs))
		}
	}
}

// setGrace changes one of the waits of Close (or outputGrace) until the test ends. These are
// package variables: a test that calls it does not run in parallel, and calls it before it
// starts a process, so that the process is closed before the value is put back.
func setGrace(t *testing.T, grace *time.Duration, d time.Duration) {
	t.Helper()
	old := *grace
	*grace = d
	t.Cleanup(func() { *grace = old })
}

// How a test proves that Close did not sit out a wait it had no need of. The usual waits are a
// few hundred milliseconds to 3 s, and on a machine busy starting processes a Close that needs
// none of them can take that long too (it starts `ps`, and a signalled process has to get to
// run). So the test makes the wait in question graceNotNeeded, which costs a correct Close
// nothing, as it goes on as soon as what it waits for has happened, and bounds Close at closeBox:
// generous for the machine, and far from the wait.
const (
	graceNotNeeded = mustHappen
	closeBox       = mustHappen / 3
)

// What does not end on SIGTERM is killed, and only after the time it was given: the process gets
// SIGTERM first, and SIGKILL goes to its whole group, not to the process alone.
func TestCloseKillsWhatOutlivesSIGTERM(t *testing.T) {
	// The process stays whatever it is given, so Close waits the times before the kill out in
	// full. The wait for stdin and the one for the rest of the group decide nothing here. The
	// kill ends everything, so the time after it is not needed (closeBox tells). The time after
	// SIGTERM is what the test is about. Inside it the process, which is running and has its
	// handler installed, has to note the signal, and on a loaded machine half a second can be
	// too short for that: a round in which it noted none does not count (waitsOutBox), so a
	// Close that sends no SIGTERM fails in the last round.
	setGrace(t, &closeStdinGrace, 20*time.Millisecond)
	setGrace(t, &closeRestGrace, 20*time.Millisecond)
	setGrace(t, &closeKillGrace, graceNotNeeded)
	waitsOutBox(t, 500*time.Millisecond, 20*time.Second, func(box time.Duration, short bool) bool {
		setGrace(t, &closeTermGrace, box)
		e := newEnv(t, baseScript())
		pidFile := filepath.Join(t.TempDir(), "pids")
		trap := filepath.Join(t.TempDir(), "trap")
		e.fake.set(t, "FAKE_ACP_CHILDREN", pidFile)
		e.fake.set(t, "FAKE_ACP_TRAP", trap)
		e.fake.set(t, "FAKE_ACP_STAY", "1")
		a := e.spawn(t, agent.SpawnOptions{})
		until(t, a, isKind(agent.EvCatalog))
		inGroup, _ := fakeChildren(t, pidFile)
		leader := a.(*proc).conn.cmd.Process.Pid

		exits, took := closeAndCount(t, a)
		if len(exits) != 1 || !strings.Contains(exits[0].ExitErr, "killed") {
			t.Errorf("exit events %+v, want one that says killed", exits)
		}
		if took < closeTermGrace || took > closeTermGrace+closeBox {
			t.Errorf("Close took %s, want the %s after SIGTERM and not the time after the kill", took, closeTermGrace)
		}
		if alive(leader) {
			t.Errorf("the process (%d) is still running", leader)
		}
		waitGone(t, "the child in the process's group, which SIGTERM does not end", inGroup)
		noted, _ := os.ReadFile(trap)
		if short && len(noted) == 0 {
			return false
		}
		if strings.TrimSpace(string(noted)) != "TERM" {
			t.Errorf("the process noted %q, want one SIGTERM before it was killed", noted)
		}
		return true
	})
}

// Close returns although something the process started, and Close does not end, holds the
// process's output open: the exit is reported, once, and the survivor stays.
func TestCloseDoesNotWaitForASurvivor(t *testing.T) {
	// The process exits when its stdin closes. Its output never ends, so Close then waits each
	// of its times out in full for something that cannot happen: none of the others decides
	// anything here, shorter or longer. Inside the time for stdin the process has to exit, or it
	// gets the SIGTERM and its exit is not the clean one this test wants; that time is the usual
	// one first, and a round in which it was too short for the fake does not count (waitsOutBox).
	setGrace(t, &closeTermGrace, 200*time.Millisecond)
	setGrace(t, &closeRestGrace, 50*time.Millisecond)
	setGrace(t, &closeKillGrace, 100*time.Millisecond)
	setGrace(t, &outputGrace, 100*time.Millisecond)
	waitsOutBox(t, closeStdinGrace, 20*time.Second, func(box time.Duration, short bool) bool {
		setGrace(t, &closeStdinGrace, box)
		e := newEnv(t, baseScript())
		pidFile := filepath.Join(t.TempDir(), "pids")
		e.fake.set(t, "FAKE_ACP_CHILDREN", pidFile)
		e.fake.set(t, "FAKE_ACP_HOLD", "1")
		a := e.spawn(t, agent.SpawnOptions{})
		until(t, a, isKind(agent.EvCatalog))
		_, ownGroup := fakeChildren(t, pidFile)

		exits, took := closeAndCount(t, a)
		if short && len(exits) == 1 && strings.Contains(exits[0].ExitErr, "terminated") {
			return false
		}
		if len(exits) != 1 || exits[0].ExitErr != "" {
			t.Errorf("exit events %+v, want one without an error", exits)
		}
		// The survivor holds the output for fakeStays, which is far longer than this.
		if limit := box + closeBox; took > limit {
			t.Errorf("Close took %s, want at most %s", took, limit)
		}
		if !alive(ownGroup) {
			t.Error("Close of a chat's process ended a group it does not own")
		}
		return true
	})
}

// Send waits for the handshake. A Close while Cursor does not answer it ends that wait: Send
// returns an error and Close returns, whether or not the process exits when its stdin closes.
func TestCloseReleasesABlockedSend(t *testing.T) {
	// Not parallel with the other tests (it times Close); its cases run at the same moment.
	//
	// A process that stays ends on SIGTERM, so the time after it is not needed: a Close that
	// waited it out, and held Send for as long, is told by closeBox.
	setGrace(t, &closeTermGrace, graceNotNeeded)
	hang := []fakeStep{{Hang: true}}
	cases := []struct {
		name   string
		script fakeScript
		o      agent.SpawnOptions
		stay   bool
	}{
		{"no answer to initialize", fakeScript{"initialize": hang}, agent.SpawnOptions{}, false},
		{"no answer to initialize, the process stays", fakeScript{"initialize": hang}, agent.SpawnOptions{Unattended: true}, true},
		{"no answer to session/new", fakeScript{"session/new": hang}, agent.SpawnOptions{Unattended: true}, false},
		{"no answer to session/new, the process stays", fakeScript{"session/new": hang}, agent.SpawnOptions{}, true},
		{"no answer to session/load", fakeScript{"session/load": hang}, agent.SpawnOptions{SessionID: testSessionID, Resume: true, Unattended: true}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, c.script)
			if c.stay {
				e.fake.set(t, "FAKE_ACP_STAY", "1")
			}
			a := e.spawn(t, c.o)
			sent := make(chan error, 1)
			go func() { sent <- a.Send([]agent.ContentBlock{{Text: "hi"}}) }()
			select {
			case err := <-sent:
				t.Fatalf("Send returned %v before Close", err)
			case <-time.After(300 * time.Millisecond):
			}

			closed := make(chan struct{})
			go func() { a.Close(); close(closed) }()
			limit := time.After(closeBox)
			select {
			case err := <-sent:
				if err == nil {
					t.Error("Send returned no error")
				}
			case <-limit:
				t.Fatal("Send did not return after Close")
			}
			select {
			case <-closed:
			case <-limit:
				t.Fatal("Close did not return")
			}
			for range a.Events() {
			}
		})
	}
}
