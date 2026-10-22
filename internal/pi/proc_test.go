//go:build !windows

package pi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// Dir names the chat object's folder: pi's session files go to <Dir>/pi and the extension gets
// Dir as AIWB_CHAT_DIR. Without it the folder is <AppRoot>/chats/<ChatID>.
func TestSpawnDir(t *testing.T) {
	f := newFake(t)
	s := f.spawner()
	s.Prompt = "BOARD-PROMPT"
	dir := filepath.Join(f.dir, "elsewhere", "c9")
	a := spawn(t, s, agent.SpawnOptions{ChatID: "c9", Dir: dir, SessionID: "app-1", Cwd: t.TempDir(), BoardID: "board"})
	waitKind(t, a, agent.EvCatalog)
	inv := f.invocation(t)
	if got := flagValue(inv.Args, "--session-dir"); got != filepath.Join(dir, "pi") {
		t.Errorf("--session-dir %q, want %q", got, filepath.Join(dir, "pi"))
	}
	if inv.ChatDir != dir || inv.ChatID != "c9" {
		t.Errorf("AIWB_CHAT_DIR %q, AIWB_CHAT_ID %q", inv.ChatDir, inv.ChatID)
	}
	if got := flagValue(inv.Args, "--append-system-prompt"); got != filepath.Join(dir, "pi", "append-prompt.md") {
		t.Errorf("--append-system-prompt %q", got)
	}
	if fi, err := os.Stat(filepath.Join(dir, "pi")); err != nil || !fi.IsDir() {
		t.Errorf("the session dir was not created: %v", err)
	}
	if _, err := os.Stat(filepath.Join(f.root, "chats", "c9")); err == nil {
		t.Error("the default chat folder was created too")
	}
	f.stdinLines(t, a)

	if got := s.chatDir("c1", ""); got != filepath.Join(f.root, "chats", "c1") {
		t.Errorf("chatDir without a folder = %q", got)
	}
	if got := s.chatDir("c1", "/elsewhere"); got != "/elsewhere" {
		t.Errorf("chatDir with a folder = %q", got)
	}
	m := envMap(s.env(agent.SpawnOptions{ChatID: "c1"}, "/bin/pi", "", "", "", ""))
	if m["AIWB_CHAT_DIR"] != filepath.Join(f.root, "chats", "c1") {
		t.Errorf("AIWB_CHAT_DIR without Dir = %q", m["AIWB_CHAT_DIR"])
	}
}

// A fork's source session file is looked for in the source's own folder when ForkSource names
// one, and the fork's session goes to the new chat object's folder.
func TestSpawnForkDirs(t *testing.T) {
	f := newFake(t)
	srcDir := filepath.Join(f.dir, "elsewhere", "A")
	dstDir := filepath.Join(f.dir, "elsewhere", "B")
	if err := os.MkdirAll(filepath.Join(srcDir, "pi"), 0o700); err != nil {
		t.Fatal(err)
	}
	srcFile := filepath.Join(srcDir, "pi", "2026-10-04T10-00-00-000Z_"+forkSrcSession+".jsonl")
	if err := os.WriteFile(srcFile, []byte(`{"type":"session"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	newFile := filepath.Join(dstDir, "pi", "2026-10-04T11-00-00-000Z_"+forkNewSession+".jsonl")
	state := func(id, file string) fakeReply {
		return fakeReply{Data: mustJSON(map[string]any{"sessionId": id, "sessionFile": file,
			"model": map[string]any{"provider": "test", "id": "test-model", "contextWindow": 1000}})}
	}
	f.replies(t, map[string]fakeReply{
		"get_state":   state(forkSrcSession, srcFile),
		"get_state#2": state(forkNewSession, newFile),
		"clone":       {Data: json.RawMessage(`{"cancelled":false}`)},
	})
	s := f.spawner()

	// The same session id under the default folder of the same chat id is not the source.
	writeSessionFile(t, f.root, "A", "2026-10-04T09-00-00-000Z", forkSrcSession)

	a, id, err := s.SpawnFork(agent.SpawnOptions{ChatID: "B", Dir: dstDir, Cwd: t.TempDir()},
		agent.ForkSource{ChatID: "A", Dir: srcDir, SessionID: forkSrcSession, End: true})
	if err != nil {
		t.Fatalf("SpawnFork: %v", err)
	}
	t.Cleanup(a.Close)
	if id != forkNewSession {
		t.Errorf("session id %q", id)
	}
	inv := f.invocation(t)
	if got := flagValue(inv.Args, "--session"); got != srcFile {
		t.Errorf("--session %q, want the file in the source's folder %q", got, srcFile)
	}
	if got := flagValue(inv.Args, "--session-dir"); got != filepath.Join(dstDir, "pi") {
		t.Errorf("--session-dir %q, want %q", got, filepath.Join(dstDir, "pi"))
	}

	// A folder that does not hold the session: the file is missing, wherever else it may be.
	_, _, err = s.SpawnFork(agent.SpawnOptions{ChatID: "x", Cwd: t.TempDir()},
		agent.ForkSource{ChatID: "A", Dir: filepath.Join(f.dir, "nowhere"), SessionID: forkSrcSession, End: true})
	if err == nil || !strings.Contains(err.Error(), "missing") {
		t.Errorf("SpawnFork from a folder without the session: %v", err)
	}
}

// The turn end carries the cost get_session_stats reports: the whole session's so far.
func TestSettledCost(t *testing.T) {
	// A real answer of pi 0.85.1 (MiniMax-M2.7), the session file's path cut.
	const stats = `"success":true,"data":{"sessionFile":"/x.jsonl","sessionId":"9e8665de","userMessages":2,"assistantMessages":5,"toolCalls":4,"toolResults":4,"totalMessages":11,` +
		`"tokens":{"input":1236,"output":571,"cacheRead":9216,"cacheWrite":2155,"total":13178},"cost":0.0024170850000000002,"contextUsage":{"tokens":2855,"contextWindow":204800,"percent":1.39}}`
	p, w := unitProc()
	p.translateLine([]byte(`{"type":"agent_settled"}`))
	answer(t, p, w, 0, stats)
	answer(t, p, w, 1, forkMessages("0efdb07e"))
	got := drainEvents(p)
	want := []agent.Event{
		{Kind: agent.EvUsage, CtxIn: 2855, CtxWindow: 204800},
		{Kind: agent.EvTurnEnd, Point: "0efdb07e", CostUSD: 0.0024170850000000002, HasCost: true,
			CumTokens: model.TokenCount{In: 1236, Out: 571, CacheRead: 9216, CacheWrite: 2155}, HasTokens: true},
	}
	if !eventsEqual(got, want) {
		t.Fatalf("events %s\nwant %s", dump(got), dump(want))
	}

	// The answers the other way round, and an aborted turn: the cost is on the end all the same.
	p, w = unitProc()
	p.abortPending = true
	p.translateLine([]byte(`{"type":"agent_settled"}`))
	answer(t, p, w, 1, forkMessages("0efdb07e"))
	answer(t, p, w, 0, stats)
	if end := turnEnd(t, drainEvents(p)); !end.Aborted || !end.HasCost || end.CostUSD != 0.0024170850000000002 {
		t.Errorf("aborted turn end %+v", end)
	}

	// A cost of 0 that pi reported (a failed provider call) is a report; no cost field is none,
	// and neither is a failed request.
	for body, has := range map[string]bool{
		`"success":true,"data":{"cost":0}`:                                true,
		`"success":true,"data":{"contextUsage":{"tokens":1}}`:             false,
		`"success":true,"data":{"cost":null}`:                             false,
		`"success":false,"error":"no stats","data":{"cost":0.5}`:          false,
		`"success":true,"data":{"cost":"much"}`:                           false,
		`"success":true,"data":{"cost":0.25,"contextUsage":{"tokens":1}}`: true,
	} {
		p, w := unitProc()
		p.translateLine([]byte(`{"type":"agent_settled"}`))
		answer(t, p, w, 0, body)
		answer(t, p, w, 1, forkMessages("0efdb07e"))
		if end := turnEnd(t, drainEvents(p)); end.HasCost != has || (!has && end.CostUSD != 0) {
			t.Errorf("stats %s: turn end %+v, want HasCost %v", body, end, has)
		}
	}

	// The tokens are reported by themselves: with no cost they are still on the end, and an answer
	// without them reports none.
	for body, want := range map[string]agent.Event{
		`"success":true,"data":{"tokens":{"input":3,"output":4,"cacheRead":5,"cacheWrite":6,"total":18}}`: {CumTokens: model.TokenCount{In: 3, Out: 4, CacheRead: 5, CacheWrite: 6}, HasTokens: true},
		`"success":true,"data":{"cost":0.25,"tokens":null}`:                                               {},
		`"success":false,"error":"no stats","data":{"tokens":{"input":3}}`:                                {},
	} {
		p, w := unitProc()
		p.translateLine([]byte(`{"type":"agent_settled"}`))
		answer(t, p, w, 0, body)
		answer(t, p, w, 1, forkMessages("0efdb07e"))
		if end := turnEnd(t, drainEvents(p)); end.HasTokens != want.HasTokens || end.CumTokens != want.CumTokens {
			t.Errorf("stats %s: turn end %+v, want tokens %+v", body, end, want.CumTokens)
		}
	}
}

// Close ends a Send that has not returned, whatever it waits for: the handshake pi does not
// answer, or the write of a prompt pi does not read. Send returns an error within Close's two
// grace periods, also when pi does not exit as its stdin closes.
func TestCloseReleasesABlockedSend(t *testing.T) {
	old := killGrace()
	killGraceNanos.Store(int64(150 * time.Millisecond))
	t.Cleanup(func() { killGraceNanos.Store(int64(old)) })

	cases := []struct {
		name  string
		setup func(t *testing.T, f *fake)
		text  string
		last  string // the last command pi reads: after it Send waits
	}{
		{"no answer to get_state", func(t *testing.T, f *fake) {
			f.replies(t, map[string]fakeReply{"get_state": {Silent: true}})
		}, "hi", "get_state"},
		{"no answer to get_state, pi stays", func(t *testing.T, f *fake) {
			f.replies(t, map[string]fakeReply{"get_state": {Silent: true}})
			t.Setenv(envHold, "1")
		}, "hi", "get_state"},
		{"no answer to the prompt", func(t *testing.T, f *fake) {
			f.replies(t, map[string]fakeReply{"prompt": {Silent: true}})
			t.Setenv(envHold, "1")
		}, "hi", "prompt"},
		// Far more than a pipe holds: the write itself waits.
		{"the prompt is not read", func(t *testing.T, f *fake) {
			t.Setenv(envDeafAfter, "get_available_models")
		}, strings.Repeat("x", 4<<20), "get_available_models"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFake(t)
			c.setup(t, f)
			a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
			sent := make(chan error, 1)
			go func() { sent <- a.Send([]agent.ContentBlock{{Text: c.text}}) }()
			// Once pi has read its last command Send is where it waits (or a write away from it),
			// so the wait that shows it does not return starts there and not at the process start.
			f.waitCommand(t, c.last)
			select {
			case err := <-sent:
				t.Fatalf("Send returned %v before Close", err)
			case <-time.After(100 * time.Millisecond):
			}

			closed := make(chan struct{})
			go func() { a.Close(); close(closed) }()
			limit := time.After(2 * time.Second)
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
			exits := 0
			for ev := range a.Events() {
				if ev.Kind == agent.EvExit {
					exits++
				}
			}
			if exits != 1 {
				t.Errorf("%d exit events, want 1", exits)
			}
		})
	}
}
