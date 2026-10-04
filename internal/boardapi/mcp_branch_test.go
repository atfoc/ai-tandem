package boardapi

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

const (
	testBranch      = "a1b2c3d4"
	testBranchToken = "branch-token-0123456789abcdef"
)

// addBranch gives the test chat a second branch on disk (its folder with a chat.json of its own
// and the tree record naming it as the current one) and reloads the chats manager, as a restart
// does. It returns the branch's server id.
func addBranch(t *testing.T, e *env) string {
	t.Helper()
	m := e.relay.Chats
	raw, err := os.ReadFile(filepath.Join(m.Store.P.ChatDir(e.chat), "chat.json"))
	if err != nil {
		t.Fatal(err)
	}
	var top model.ChatMeta
	if err := json.Unmarshal(raw, &top); err != nil {
		t.Fatal(err)
	}
	sid := e.chat + "/branches/" + testBranch
	dir := m.Store.P.ChatDir(sid)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	meta := model.ChatMeta{ID: sid, Agent: top.Agent, Board: top.Board, Cwd: top.Cwd, Model: top.Model,
		Effort: top.Effort, Created: top.Created, Token: testBranchToken, SessionID: "ses-branch"}
	if err := store.WriteJSONAtomic(filepath.Join(dir, "chat.json"), meta, 0o600); err != nil {
		t.Fatal(err)
	}
	tree := model.Tree{Branches: []model.TreeBranch{{ID: testBranch, From: model.MainBranch, At: 0}}, Current: testBranch}
	if err := store.WriteJSONAtomic(filepath.Join(m.Store.P.ChatDir(e.chat), "tree.json"), tree, 0o600); err != nil {
		t.Fatal(err)
	}
	nm := chats.New(m.Deps)
	if err := nm.Load(); err != nil {
		t.Fatal(err)
	}
	e.relay.Chats = nm
	return sid
}

// A board tool call made by a branch's agent reaches the client under the chat's own id, which
// is the one the client knows; so does the contact log.
func TestBranchTokenCallsUnderTheChatID(t *testing.T) {
	e := newEnv(t)
	addBranch(t, e)
	got := make(chan map[string]any, 1)
	e.client(func(p map[string]any) editorbridge.RPCReply {
		got <- p
		return editorbridge.RPCReply{Result: json.RawMessage(`"ok"`)}
	})
	e.mcp(testBranchToken, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"claude","version":"1"}}}`)
	text, isErr, _ := e.toolsCall(testBranchToken, "read_board", `{}`)
	if isErr || text != "ok" {
		t.Fatalf("got %q isErr=%v", text, isErr)
	}
	if p := <-got; p["chat"] != e.chat || p["board"] != e.board.ID || p["name"] != "read_board" {
		t.Fatalf("rpc params %v", p)
	}
	// Main's own agent is the same chat to the client.
	e.toolsCall(e.token, "read_board", `{}`)
	if p := <-got; p["chat"] != e.chat {
		t.Fatalf("rpc params %v", p)
	}
	contacts := e.relay.Contacts.Snapshot()
	if len(contacts) != 1 || contacts[0].Chat != short(e.chat) || contacts[0].Client != "claude" || contacts[0].Tool != "read_board" {
		t.Fatalf("contacts %+v", contacts)
	}
	if names := e.listNames(testBranchToken); len(names) != len(e.listNames(e.token)) {
		t.Fatalf("the branch's tools %v", names)
	}
}

// The archive flag is the top-level chat's; a call with a branch's token sees it.
func TestBranchTokenArchivedChat(t *testing.T) {
	e := newEnv(t)
	addBranch(t, e)
	if err := e.relay.Chats.SetArchive(e.chat, model.Archive{Archived: true, Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	for _, tool := range []string{"list_boards", "spawn_subagent"} {
		text, isErr, _ := e.toolsCall(testBranchToken, tool, `{"prompt":"x"}`)
		if !isErr || text != "this chat is archived" {
			t.Fatalf("%s: got %q isErr=%v", tool, text, isErr)
		}
	}
	if text, isErr := e.relay.Call(testBranchToken, "list_boards", nil); !isErr || text != "this chat is archived" {
		t.Fatalf("Relay.Call: got %q isErr=%v", text, isErr)
	}
	if err := e.relay.Chats.SetArchive(e.chat, model.Archive{}); err != nil {
		t.Fatal(err)
	}
	// No client is connected: past the archive check the call fails for that reason instead.
	if text, isErr, _ := e.toolsCall(testBranchToken, "list_boards", `{}`); !isErr || text != NoClientText {
		t.Fatalf("after unarchive: got %q isErr=%v", text, isErr)
	}
}

// The spawn family addresses the caller's own chat object: a branch's subagents are the branch's.
func TestBranchTokenSpawnsUnderTheBranch(t *testing.T) {
	e := newEnv(t)
	sid := addBranch(t, e)
	text, isErr, _ := e.toolsCall(testBranchToken, "spawn_subagent", `{"prompt":"go"}`)
	if isErr {
		t.Fatalf("spawn: %q", text)
	}
	sub := receiptSid(t, text)
	m := e.relay.Chats
	if _, err := os.Stat(filepath.Join(m.Store.P.ChatDir(e.chat), "branches", testBranch, "subagents", sub, "subagent.json")); err != nil {
		t.Fatalf("the subagent's folder: %v", err)
	}
	if _, err := os.Stat(filepath.Join(m.Store.P.ChatDir(e.chat), "subagents")); !os.IsNotExist(err) {
		t.Fatalf("a subagents folder under main: %v", err)
	}
	waitFor(t, "child process", func() bool { return e.claude.count() >= 1 })
	if got := e.claude.last(t).opts.ChatID; got != sid+"/subagents/"+sub {
		t.Fatalf("the subagent's chat id %q", got)
	}
	if _, _, subs, err := m.Items(e.chat); err != nil || len(subs) != 1 || subs[0].ID != sub {
		t.Fatalf("subagents of the current branch: %+v, %v", subs, err)
	}
	if _, _, _, subs, err := m.ItemsOf(e.chat, model.MainBranch); err != nil || len(subs) != 0 {
		t.Fatalf("subagents of main: %+v, %v", subs, err)
	}
	if text, isErr, _ := e.toolsCall(testBranchToken, "stop_subagent", fmt.Sprintf(`{"sid":%q}`, sub)); isErr {
		t.Fatalf("stop: %q", text)
	}
	// Main's agent does not see the branch's subagent.
	if text, isErr, _ := e.toolsCall(e.token, "stop_subagent", fmt.Sprintf(`{"sid":%q}`, sub)); !isErr {
		t.Fatalf("stop by main: %q", text)
	}
}
