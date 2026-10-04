package boardapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/boardtools"
	"ai-whiteboard/internal/model"
)

func (e *env) toolsCall(token, name, args string) (text string, isErr bool, status int) {
	e.t.Helper()
	body := fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":%q,"arguments":%s}}`, name, args)
	resp, out := e.mcp(token, body)
	if resp.StatusCode != http.StatusOK {
		return "", false, resp.StatusCode
	}
	text, isErr = callResult(e.t, out)
	return text, isErr, resp.StatusCode
}

func (e *env) listNames(token string) []string {
	e.t.Helper()
	resp, out := e.mcp(token, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if resp.StatusCode != http.StatusOK {
		e.t.Fatalf("tools/list status %d", resp.StatusCode)
	}
	raw := out["result"].(map[string]any)["tools"].([]any)
	names := make([]string, len(raw))
	for i, x := range raw {
		names[i] = x.(map[string]any)["name"].(string)
	}
	return names
}

func (e *env) listSchemas(token string) []map[string]any {
	e.t.Helper()
	_, out := e.mcp(token, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	raw := out["result"].(map[string]any)["tools"].([]any)
	outSchemas := make([]map[string]any, len(raw))
	for i, x := range raw {
		outSchemas[i] = x.(map[string]any)
	}
	return outSchemas
}

func (e *env) createPlain() (id, token string) {
	e.t.Helper()
	v, err := e.relay.Chats.Create(model.Claude, model.Ungrouped, "")
	if err != nil {
		e.t.Fatal(err)
	}
	return v.ID, e.chatToken(v.ID)
}

func (e *env) chatToken(id string) string {
	e.t.Helper()
	raw, err := os.ReadFile(filepath.Join(e.relay.Chats.Store.P.ChatDir(id), "chat.json"))
	if err != nil {
		e.t.Fatal(err)
	}
	var meta model.ChatMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		e.t.Fatal(err)
	}
	if meta.Token == "" {
		e.t.Fatal("empty token")
	}
	return meta.Token
}

func (e *env) startParent(chatID string) *fakeAgent {
	e.t.Helper()
	if err := e.relay.Chats.Send(chatID, "delegate", "", nil); err != nil {
		e.t.Fatal(err)
	}
	waitFor(e.t, "parent process", func() bool { return e.claude.count() >= 1 })
	return e.claude.last(e.t)
}

func (e *env) emitSpawnItem(parent *fakeAgent, toolID, input string) {
	e.t.Helper()
	parent.emit(e.t, agent.Event{
		Kind: agent.EvToolStart, ToolID: toolID, ToolName: "mcp__board__spawn_subagent",
		Input: json.RawMessage(input),
	})
}

func (e *env) items(id string) []model.Item {
	e.t.Helper()
	_, items, _, err := e.relay.Chats.Items(id)
	if err != nil {
		e.t.Fatal(err)
	}
	return items
}

func (e *env) sub(id, sid string) model.Subagent {
	e.t.Helper()
	_, _, subs, err := e.relay.Chats.Items(id)
	if err != nil {
		e.t.Fatal(err)
	}
	for _, sa := range subs {
		if sa.ID == sid {
			return sa
		}
	}
	e.t.Fatalf("no subagent %s", sid)
	return model.Subagent{}
}

func receiptSid(t *testing.T, text string) string {
	t.Helper()
	const prefix = "spawned subagent "
	if !strings.HasPrefix(text, prefix) {
		t.Fatalf("receipt %q", text)
	}
	rest := strings.TrimPrefix(text, prefix)
	sid, _, ok := strings.Cut(rest, " ")
	if !ok || sid == "" {
		t.Fatalf("receipt %q", text)
	}
	return sid
}

func waitFor(t *testing.T, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !f() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func namesOf(tools []boardtools.Tool) []string {
	out := make([]string, len(tools))
	for i, t := range tools {
		out[i] = t.Name
	}
	return out
}

func TestToolsListMatrix(t *testing.T) {
	e := newEnv(t)
	if got := namesOf(boardtools.SpawnFamily); !joinEq(got, []string{"spawn_subagent", "stop_subagent"}) {
		t.Fatalf("spawn family %v, want spawn_subagent and stop_subagent alone", got)
	}
	boardSpawn := append(namesOf(boardtools.Tools), namesOf(boardtools.SpawnFamily)...)

	if got := e.listNames(e.token); !joinEq(got, boardSpawn) {
		t.Fatalf("board chat agent: %v, want %v", got, boardSpawn)
	}

	_, plainTok := e.createPlain()
	if got := e.listNames(plainTok); !joinEq(got, namesOf(boardtools.SpawnFamily)) {
		t.Fatalf("plain chat agent: %v", got)
	}

	text, isErr, status := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"board child"}`)
	if status != 200 || isErr {
		t.Fatalf("board spawn %q isErr=%v status=%d", text, isErr, status)
	}
	boardSid := receiptSid(t, text)
	boardExtra := e.claude.last(t).opts.MCP.Token
	if got := e.listNames(boardExtra); !joinEq(got, namesOf(boardtools.Tools)) {
		t.Fatalf("board-parent sub: %v", got)
	}

	text, isErr, status = e.toolsCall(plainTok, "spawn_subagent", `{"prompt":"plain child"}`)
	if status != 200 || isErr {
		t.Fatalf("plain spawn %q isErr=%v status=%d", text, isErr, status)
	}
	plainExtra := e.claude.last(t).opts.MCP.Token
	if got := e.listNames(plainExtra); len(got) != 0 {
		t.Fatalf("plain-parent sub: %v", got)
	}

	if got := e.listNames(""); len(got) != 0 {
		t.Fatalf("missing token: %v", got)
	}
	if got := e.listNames("definitely-not-a-token"); len(got) != 0 {
		t.Fatalf("unknown token: %v", got)
	}
	if err := e.relay.Chats.StopSubagent(e.chat, boardSid); err != nil {
		t.Fatal(err)
	}
	if got := e.listNames(boardExtra); len(got) != 0 {
		t.Fatalf("revoked token: %v", got)
	}
}

func joinEq(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestSpawnSchemaHasNoBackground(t *testing.T) {
	e := newEnv(t)
	for _, tl := range e.listSchemas(e.token) {
		if tl["name"] != "spawn_subagent" {
			continue
		}
		schema := tl["inputSchema"].(map[string]any)
		props, _ := schema["properties"].(map[string]any)
		if _, ok := props["background"]; ok {
			t.Fatal("spawn_subagent schema has background")
		}
		if _, ok := props["prompt"]; !ok {
			t.Fatal("spawn_subagent schema missing prompt")
		}
		return
	}
	t.Fatal("spawn_subagent not listed")
}

func TestSpawnNoClientSucceeds(t *testing.T) {
	e := newEnv(t)
	start := time.Now()
	text, isErr, status := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"board"}`)
	if status != 200 || isErr || strings.Contains(text, "board isn't open") {
		t.Fatalf("board spawn %q isErr=%v status=%d", text, isErr, status)
	}
	sid := receiptSid(t, text)
	if !strings.Contains(text, "running") {
		t.Fatalf("receipt %q", text)
	}
	if time.Since(start) > time.Second {
		t.Fatal("spawn did not return immediately")
	}
	if sa := e.sub(e.chat, sid); sa.Status != model.SubRunning {
		t.Fatalf("subagent %+v", sa)
	}

	_, plainTok := e.createPlain()
	text, isErr, status = e.toolsCall(plainTok, "spawn_subagent", `{"prompt":"plain"}`)
	if status != 200 || isErr || strings.Contains(text, "board isn't open") {
		t.Fatalf("plain spawn %q isErr=%v status=%d", text, isErr, status)
	}
	receiptSid(t, text)
}

func TestStopSubagentReceipt(t *testing.T) {
	e := newEnv(t)
	parent := e.startParent(e.chat)
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd}) // idle, with a live process
	text, isErr, _ := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"go"}`)
	if isErr {
		t.Fatalf("spawn %q", text)
	}
	sid := receiptSid(t, text)
	waitFor(t, "child", func() bool { return e.claude.count() >= 2 })
	child := e.claude.last(t)
	stopped, isErr, status := e.toolsCall(e.token, "stop_subagent", fmt.Sprintf(`{"sid":%q}`, sid))
	if status != 200 || isErr || !strings.Contains(stopped, sid) || !strings.Contains(stopped, "stopped") {
		t.Fatalf("stop %q isErr=%v status=%d", stopped, isErr, status)
	}
	waitFor(t, "child closed", func() bool { return child.isClosed() })

	// The parent asked and has the receipt: nothing is owed and no message goes to it.
	if sa := e.sub(e.chat, sid); sa.Status != model.SubStopped || sa.Delivery != model.SubNotOwed {
		t.Fatalf("subagent %+v", sa)
	}
	if n := len(parent.sent()); n != 1 {
		t.Fatalf("%d sends to the parent", n)
	}
	for _, it := range e.items(e.chat) {
		if it.Kind == "subresult" {
			t.Fatalf("result row %+v", it)
		}
	}
}

func TestSpawnClaimFIFOMCP(t *testing.T) {
	e := newEnv(t)
	parent := e.startParent(e.chat)
	args := `{"prompt":"same"}`
	e.emitSpawnItem(parent, "t1", args)
	e.emitSpawnItem(parent, "t2", args)

	var wg sync.WaitGroup
	var text1, text2 string
	var err1, err2 bool
	wg.Add(2)
	go func() {
		defer wg.Done()
		text1, err1, _ = e.toolsCall(e.token, "spawn_subagent", args)
	}()
	go func() {
		defer wg.Done()
		text2, err2, _ = e.toolsCall(e.token, "spawn_subagent", args)
	}()
	wg.Wait()
	if err1 || err2 {
		t.Fatalf("spawn errors %q %q", text1, text2)
	}
	sid1, sid2 := receiptSid(t, text1), receiptSid(t, text2)
	if sid1 == sid2 {
		t.Fatal("same sid")
	}
	items := e.items(e.chat)
	linked := map[string]string{}
	for _, it := range items {
		if it.ToolID == "t1" || it.ToolID == "t2" {
			linked[it.ToolID] = it.Subagent
		}
	}
	if linked["t1"] == "" || linked["t2"] == "" {
		t.Fatalf("FIFO links %+v", linked)
	}
	if linked["t1"] == linked["t2"] {
		t.Fatal("both items claimed by one sid")
	}
	got := map[string]bool{sid1: true, sid2: true}
	if !got[linked["t1"]] || !got[linked["t2"]] {
		t.Fatalf("receipts %q %q links %+v", sid1, sid2, linked)
	}
}

func TestSubagentSpawnFamilyRejected(t *testing.T) {
	e := newEnv(t)
	text, isErr, _ := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"parent"}`)
	if isErr {
		t.Fatalf("parent spawn %q", text)
	}
	waitFor(t, "child", func() bool { return e.claude.count() >= 1 })
	extra := e.claude.last(t).opts.MCP.Token
	before := e.claude.count()
	for _, name := range []string{"spawn_subagent", "stop_subagent"} {
		args := `{"prompt":"nope"}`
		if name == "stop_subagent" {
			args = `{"sid":"x"}`
		}
		got, isErr, status := e.toolsCall(extra, name, args)
		if status != 200 || !isErr || strings.Contains(got, "board isn't open") {
			t.Fatalf("%s: %q isErr=%v status=%d", name, got, isErr, status)
		}
		if !strings.Contains(got, "not available to subagents") {
			t.Fatalf("%s text %q", name, got)
		}
	}
	// The removed polling tool is no tool at all, for a subagent as for a chat's agent.
	got, isErr, status := e.toolsCall(extra, "wait_subagents", `{"sids":["x"],"timeout":0}`)
	if status != 200 || !isErr || got != "unknown tool wait_subagents" {
		t.Fatalf("wait_subagents from a subagent: %q isErr=%v status=%d", got, isErr, status)
	}
	if e.claude.count() != before {
		t.Fatal("subagent spawn-family started a process")
	}
}

func TestSpawnFamilyValidationAndUnknown(t *testing.T) {
	e := newEnv(t)
	text, isErr, status := e.toolsCall(e.token, "spawn_subagent", `{}`)
	if status != 200 || !isErr || !strings.Contains(text, "prompt") {
		t.Fatalf("missing prompt %q isErr=%v status=%d", text, isErr, status)
	}
	text, isErr, status = e.toolsCall(e.token, "spawn_subagent", `{"prompt":"x","agent":"nope"}`)
	if status != 200 || !isErr || !strings.Contains(text, "agent") {
		t.Fatalf("bad agent %q isErr=%v status=%d", text, isErr, status)
	}
	if e.claude.count() != 0 {
		t.Fatal("invalid spawn started a process")
	}
	text, isErr, status = e.toolsCall(e.token, "wait_subagents", `{"sids":["x"],"timeout":0}`)
	if status != 200 || !isErr || text != "unknown tool wait_subagents" {
		t.Fatalf("wait_subagents %q isErr=%v status=%d", text, isErr, status)
	}
	text, isErr, status = e.toolsCall(e.token, "stop_subagent", `{}`)
	if status != 200 || !isErr || !strings.Contains(text, "sid") {
		t.Fatalf("missing sid %q", text)
	}
	text, isErr, status = e.toolsCall(e.token, "rm_rf", `{}`)
	if status != 200 || !isErr || text != "unknown tool rm_rf" {
		t.Fatalf("unknown tool %q isErr=%v status=%d", text, isErr, status)
	}
	text, isErr, status = e.toolsCall("nope", "spawn_subagent", `{"prompt":"x"}`)
	if status != 200 || !isErr || text != "unknown board token" {
		t.Fatalf("unknown token %q isErr=%v status=%d", text, isErr, status)
	}
}

func TestSpawnFamilyNoClientText(t *testing.T) {
	e := newEnv(t)
	start := time.Now()
	text, isErr, _ := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"go"}`)
	if isErr || text == NoClientText || time.Since(start) > time.Second {
		t.Fatalf("spawn hit the bridge: %q isErr=%v", text, isErr)
	}
	sid := receiptSid(t, text)
	if sa := e.sub(e.chat, sid); sa.Status != model.SubRunning {
		t.Fatalf("subagent %+v", sa)
	}
	text, isErr, _ = e.toolsCall(e.token, "stop_subagent", fmt.Sprintf(`{"sid":%q}`, sid))
	if isErr || text == NoClientText {
		t.Fatalf("stop hit the bridge: %q", text)
	}
}

func TestBoardToolsOnPlainChatAgent(t *testing.T) {
	e := newEnv(t)
	_, tok := e.createPlain()
	start := time.Now()
	text, isErr, status := e.toolsCall(tok, "list_boards", `{}`)
	if status != 200 || !isErr {
		t.Fatalf("got %q isErr=%v status=%d", text, isErr, status)
	}
	if text == NoClientText || strings.HasPrefix(text, "The board isn't open") {
		t.Fatalf("plain board tool hit the bridge: %q", text)
	}
	if time.Since(start) > time.Second {
		t.Fatal("did not fail at once")
	}
}

func TestBoardToolsFromBoardParentSubUseBridge(t *testing.T) {
	e := newEnv(t)
	text, isErr, _ := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"draw"}`)
	if isErr {
		t.Fatalf("spawn %q", text)
	}
	waitFor(t, "child", func() bool { return e.claude.count() >= 1 })
	extra := e.claude.last(t).opts.MCP.Token
	got, isErr, status := e.toolsCall(extra, "read_board", `{}`)
	if status != 200 || !isErr || got != NoClientText {
		t.Fatalf("sub board tool %q isErr=%v status=%d, want NoClientText", got, isErr, status)
	}
}

func TestSpawnNoConcurrencyCap(t *testing.T) {
	e := newEnv(t)
	enter := make(chan struct{}, 2)
	gate := make(chan struct{})
	e.relay.Chats.Spawners[model.Claude] = &gatedSpawner{inner: e.claude, enter: enter, gate: gate}

	var wg sync.WaitGroup
	var text1, text2 string
	var err1, err2 bool
	wg.Add(2)
	go func() {
		defer wg.Done()
		text1, err1, _ = e.toolsCall(e.token, "spawn_subagent", `{"prompt":"one"}`)
	}()
	go func() {
		defer wg.Done()
		text2, err2, _ = e.toolsCall(e.token, "spawn_subagent", `{"prompt":"two"}`)
	}()
	for i := 0; i < 2; i++ {
		select {
		case <-enter:
		case <-time.After(5 * time.Second):
			t.Fatal("spawn POSTs serialized")
		}
	}
	close(gate)
	wg.Wait()
	if err1 || err2 {
		t.Fatalf("spawn errors %q %q", text1, text2)
	}
	if receiptSid(t, text1) == receiptSid(t, text2) {
		t.Fatal("same sid")
	}
}

func TestSpawnArchivedAndLegacy(t *testing.T) {
	e := newEnv(t)
	if err := e.relay.Chats.SetArchive(e.chat, model.Archive{Archived: true, Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	text, isErr, status := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"x"}`)
	if status != 200 || !isErr || text != "this chat is archived" {
		t.Fatalf("archived spawn %q isErr=%v status=%d", text, isErr, status)
	}
	if e.claude.count() != 0 {
		t.Fatal("archived spawn started a process")
	}

	e2 := newEnv(t)
	markLegacyAndReload(t, e2)
	text, isErr, status = e2.toolsCall(e2.token, "spawn_subagent", `{"prompt":"x"}`)
	if status != 200 || !isErr || text != "this chat used the old board connection" {
		t.Fatalf("legacy spawn %q isErr=%v status=%d", text, isErr, status)
	}
	if e2.claude.count() != 0 {
		t.Fatal("legacy spawn started a process")
	}
}
