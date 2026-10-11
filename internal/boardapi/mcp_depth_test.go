package boardapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ai-whiteboard/internal/boardtools"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

// limits gives chats the subagent settings a chat is started with: they are written to each
// chat.json, and a new manager, which the relay then uses, reads them.
func (e *env) limits(depth, limit int, ids ...string) {
	e.t.Helper()
	m := e.relay.Chats
	for _, id := range ids {
		path := filepath.Join(m.Store.P.ChatDir(id), "chat.json")
		raw, err := os.ReadFile(path)
		if err != nil {
			e.t.Fatal(err)
		}
		var meta model.ChatMeta
		if err := json.Unmarshal(raw, &meta); err != nil {
			e.t.Fatal(err)
		}
		meta.Subagents = &model.SubLimits{Depth: depth, Cap: limit}
		if err := store.WriteJSONAtomic(path, meta, 0o600); err != nil {
			e.t.Fatal(err)
		}
	}
	nm := chats.New(chats.Deps{Store: m.Store, Bridge: e.relay.Bridge, Boards: e.relay.Boards, DefaultCwd: m.DefaultCwd, MCPURL: m.MCPURL, Spawners: m.Spawners})
	if err := nm.Load(); err != nil {
		e.t.Fatal(err)
	}
	e.relay.Chats = nm
}

// A chat whose subagents are off is listed no spawn tool, with a board or without, and a call of
// one is refused with the reason and starts nothing.
func TestDepthOffListsAndRunsNoSpawnFamily(t *testing.T) {
	e := newEnv(t)
	plain, plainTok := e.createPlain()
	e.limits(0, 100, e.chat, plain)

	if got := e.listNames(e.token); !joinEq(got, namesOf(boardtools.Tools)) {
		t.Fatalf("a board chat with subagents off is listed %v", got)
	}
	if got := e.listNames(plainTok); len(got) != 0 {
		t.Fatalf("a plain chat with subagents off is listed %v", got)
	}
	for _, tok := range []string{e.token, plainTok} {
		for _, name := range namesOf(boardtools.SpawnFamily) {
			text, isErr, status := e.toolsCall(tok, name, probeArgs(name))
			if status != 200 || !isErr || text != name+" is not available: subagents are off in this chat" {
				t.Fatalf("%s with subagents off: %q isErr=%v status=%d", name, text, isErr, status)
			}
		}
	}
	if n := e.claude.count(); n != 0 {
		t.Fatalf("%d processes started", n)
	}
}

// A spawn over the chat's cap is answered as an error that names the cap, and starts nothing.
func TestSpawnOverTheCapIsRefused(t *testing.T) {
	e := newEnv(t)
	e.limits(1, 1, e.chat)
	if text, isErr, _ := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"one"}`); isErr {
		t.Fatalf("the first spawn: %q", text)
	}
	text, isErr, status := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"two"}`)
	if status != 200 || !isErr || !strings.Contains(text, "cap on running subagents is 1") || !strings.Contains(text, "not queued") {
		t.Fatalf("a spawn over the cap: %q isErr=%v status=%d", text, isErr, status)
	}
	if n := e.claude.count(); n != 1 {
		t.Fatalf("%d processes started, want the first subagent's alone", n)
	}
}
