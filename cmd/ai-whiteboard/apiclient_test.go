//go:build !windows

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/store"
)

// waitLog waits up to 5 s for the server's log to hold line.
func waitLog(t *testing.T, dir, line string) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if strings.Contains(serverLog(t, dir), line) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the log lacks %q:\n%s", line, serverLog(t, dir))
		}
	}
}

// itemsOf reads the chat's items as the client c, which follows the chat from then on.
func itemsOf(t *testing.T, c *bridgetest.Page, chat string) []model.Item {
	t.Helper()
	status, out := c.Do("GET", "/api/chats/"+chat+"/items", nil)
	if status != http.StatusOK {
		t.Fatalf("the items of %s: %d %s", chat, status, out)
	}
	var got struct{ Items []model.Item }
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	return got.Items
}

// awaitItems reads the chat's items every 100 ms, for up to 30 s, until ok says they are what
// the test waits for.
func awaitItems(t *testing.T, c *bridgetest.Page, chat, what string, ok func([]model.Item) bool) []model.Item {
	t.Helper()
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		items := itemsOf(t, c, chat)
		if ok(items) {
			return items
		}
		if time.Now().After(deadline) {
			raw, _ := json.Marshal(items)
			t.Fatalf("the chat's items never showed %s: %s", what, raw)
		}
	}
}

func ok200(t *testing.T, c *bridgetest.Page, method, path string, body any) map[string]any {
	t.Helper()
	status, out := c.Do(method, path, body)
	if status != http.StatusOK {
		t.Fatalf("%s %s by %s: %d %s", method, path, c.ID, status, out)
	}
	var got map[string]any
	json.Unmarshal(out, &got)
	return got
}

func typesOf(evs []string) (types []string) {
	for _, raw := range evs {
		var e struct{ Type string }
		json.Unmarshal([]byte(raw), &e)
		types = append(types, e.Type)
	}
	return types
}

// apiListEvents and apiFollowEvents are what an API client's stream may hold after its hello and
// snapshot: the list events, which go to every client, and the content events of what the client
// follows. No event of the server's own pages is among them.
var (
	apiListEvents   = []string{"groups", "defaults", "board", "board_removed", "chat", "chat_removed", "branch_state", "catalog", "agents", "own_library"}
	apiFollowEvents = []string{"tree", "chat_items", "sub", "sub_items"}
)

// A secret file that cannot be read at the signal: the server keeps the old secret and says so in
// its log without the file's content. No reload is counted, and only a reload closes streams.
func TestReloadKeepsSecretWhenUnreadable(t *testing.T) {
	smokeTest(t)
	in := newInstance(t)
	secret := in.secret
	in.launchJSON(t, "launch")
	in.waitServing(t)
	pid := in.hello(t).Pid

	if err := os.WriteFile(remote.FilesIn(in.dir).Secret, []byte("not a secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(pid, syscall.SIGUSR1); err != nil {
		t.Fatal(err)
	}
	waitLog(t, in.dir, "Remote listener: the secret was not read again, the old one stays: ")
	in.helloOK(t, secret)
	if status, _ := in.getWith(t, "/api/state", secret, "", testLevel); status != http.StatusOK {
		t.Fatalf("the old secret after the signal: status %d, want it still accepted", status)
	}
	if st, _ := in.waitServing(t).statusOf(); st.Client.SecretReloads != 0 {
		t.Fatalf("secretReloads = %d, want 0", st.Client.SecretReloads)
	}
	log := serverLog(t, in.dir)
	noSecret(t, secret, log)
	if strings.Contains(log, "not a secret") {
		t.Fatalf("the log holds the file's content:\n%s", log)
	}
}

// `secret -new` for another data folder, whose server.json names this folder's server: that
// server is not signalled and keeps its secret. The status of that folder does not report this
// server either.
func TestSecretNewOfAnotherFolderLeavesTheServer(t *testing.T) {
	serverTest(t, "TestSecretNewGate, TestFindRunningIgnoresWhatIsNotThisFolders (this package)")
	in := newInstance(t)
	secret := in.secret
	in.launchJSON(t, "launch")
	in.waitServing(t)

	other := t.TempDir()
	if _, _, code := own(t, "remote", "setup", "-home", other); code != 0 {
		t.Fatalf("set-up: code %d", code)
	}
	asThisFolders(t, other, standInID)
	sf := readServerFile(t, in.dir)
	if err := store.WriteJSONAtomic(store.NewPaths(other).Server, sf, 0o600); err != nil { // names this folder's control socket
		t.Fatal(err)
	}
	_, errOut, code := own(t, "secret", "-new", "-home", other)
	if code != 0 || errOut != "The new secret takes effect at the server's next start.\n" {
		t.Fatalf("code %d, stderr %q", code, errOut)
	}
	in.helloOK(t, secret)
	if st, _ := in.waitServing(t).statusOf(); st.Client.SecretReloads != 0 {
		t.Fatalf("secretReloads = %d, want 0", st.Client.SecretReloads)
	}
	if log := serverLog(t, in.dir); strings.Contains(log, "secret was read again") || strings.Contains(log, "asked to read the secret") {
		t.Fatalf("the server was signalled:\n%s", log)
	}
	out, _, _ := own(t, "status", "-home", other)
	if !strings.HasPrefix(out, "Running: no server\n") {
		t.Fatalf("status of the other folder:\n%s", out)
	}
	out, _, _ = own(t, "status", "-home", in.dir)
	if !strings.HasPrefix(out, "Running: this build ") {
		t.Fatalf("status of the server's folder:\n%s", out)
	}
}

// `secret -new` and `status` for a copy of the running server's data folder, which carries its
// instance id and its server.json (which names the original's control socket): the server is the
// original's, not the copy's. It is not signalled and keeps its secret, and the status of the copy
// reports no server.
func TestSecretNewOfACopiedFolderLeavesTheServer(t *testing.T) {
	serverTest(t, "TestSecretNewGate, TestFindRunningIgnoresWhatIsNotThisFolders (this package)")
	in := newInstance(t)
	secret := in.secret
	in.launchJSON(t, "launch")
	in.waitServing(t)

	dup := filepath.Join(t.TempDir(), "copy")
	if err := os.MkdirAll(dup, 0o700); err != nil {
		t.Fatal(err)
	}
	// Everything a copy of the folder carries but the sockets, which cp does not copy.
	if b, err := exec.Command("cp", "-Rp", in.dir+"/.", dup).CombinedOutput(); err != nil && !strings.Contains(string(b), "control.sock") && !strings.Contains(string(b), "bridge.sock") {
		t.Fatalf("cp -Rp: %v\n%s", err, b)
	}
	// What makes the copy look like the server's folder is there.
	if sf, ok := store.ReadServerFile(store.NewPaths(dup)); !ok || sf.Control != sockPath(in.dir) {
		t.Fatalf("the copy's server.json: %+v, read %v, want the control socket %s", sf, ok, sockPath(in.dir))
	}
	if a, b := remoteFiles(t, dup)["instance-id"], remoteFiles(t, in.dir)["instance-id"]; a == "" || a != b {
		t.Fatalf("the copy's instance id %q, the original's %q", a, b)
	}

	out, errOut, code := own(t, "secret", "-new", "-home", dup)
	if code != 0 || errOut != "The new secret takes effect at the server's next start.\n" {
		t.Fatalf("code %d, stderr %q", code, errOut)
	}
	if fresh := secretOf(t, dup); out != fresh+"\n" || fresh == secret || secretOf(t, in.dir) != secret {
		t.Fatalf("the copy's secret was not replaced alone: stdout %q", out)
	}
	in.helloOK(t, secret)
	if st, _ := in.waitServing(t).statusOf(); st.Client.SecretReloads != 0 {
		t.Fatalf("secretReloads = %d, want 0", st.Client.SecretReloads)
	}
	if log := serverLog(t, in.dir); strings.Contains(log, "secret was read again") || strings.Contains(log, "asked to read the secret") {
		t.Fatalf("the server was signalled:\n%s", log)
	}
	out, _, _ = own(t, "status", "-home", dup)
	if !strings.HasPrefix(out, "Running: no server\n") {
		t.Fatalf("status of the copy:\n%s", out)
	}
	out, _, _ = own(t, "status", "-home", in.dir)
	if !strings.HasPrefix(out, "Running: this build ") {
		t.Fatalf("status of the server's folder:\n%s", out)
	}
}

// Across processes: a real server with the stand-in agent, a client that holds a board, and a
// second client that makes a chat, sends its first message, reads it, answers a permission ask,
// sends a second message and stops it. The first keeps its board and saves it meanwhile. Each
// sees what the other made: the second the first's board, the first the second's chat, in the
// group it was made in. Both are clients of the same kind, over HTTPS with the secret.
func TestTwoClientsBesideEachOther(t *testing.T) {
	serverTest(t, "TestAPIClientsTakeNothingFromAPage, TestTableRoutesServeAnAPIClient, TestEventsOfAnAPIClient (internal/server)")
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH (the fake claude is a Node script)")
	}
	in := newInstance(t)
	in.claude = agenttest.FakeClaude(t)
	secret := in.secret
	in.launchJSON(t, "launch")
	in.waitServing(t)

	// The page makes a board, which it then holds, and saves it once.
	p := in.page(t, "2a6d4c1e-8f3b-4d7a-b5c9-1e0f2d3c4b5a")
	p.Welcome()
	board, _ := ok200(t, p, "POST", "/api/boards", map[string]any{"name": "b", "group": model.Ungrouped})["id"].(string)
	if board == "" {
		t.Fatal("the new board has no id")
	}
	took := ok200(t, p, "POST", "/api/boards/"+board+"/take", map[string]any{"ifFree": false})
	if took["state"] != "held" {
		t.Fatalf("the page's take: %v", took)
	}
	rev := int64(took["rev"].(float64))
	save := func(element string) {
		t.Helper()
		scene := `{"type":"excalidraw","version":2,"elements":[{"id":"` + element + `","type":"rectangle"}],"appState":{},"files":{}}`
		got := ok200(t, p, "PUT", fmt.Sprintf("/api/boards/%s/scene?rev=%d", board, rev), scene)
		if got["ok"] != true || got["rev"] != float64(rev+1) {
			t.Fatalf("the page's save on revision %d: %v", rev, got)
		}
		rev++
	}
	save("one")
	p.Drain(300 * time.Millisecond)

	// The API client connects: its snapshot is the server's tree, the page's board in it, and
	// the page is sent nothing.
	c := in.page(t, testClient)
	snap := c.Welcome()
	groups, hasGroups := snap["groups"].([]any)
	boards, _ := snap["boards"].([]any)
	if !hasGroups || len(groups) != 0 || len(snap["chats"].([]any)) != 0 || len(boards) != 1 || boards[0].(map[string]any)["id"] != board {
		t.Fatalf("the API client's snapshot: %v", snap)
	}
	if _, has := snap["defaults"]; !has {
		t.Fatalf("the API client's snapshot has no defaults: %v", snap)
	}
	// (A catalog that finishes loading just now goes to every client, whoever connects.)
	for _, typ := range typesOf(p.Drain(300 * time.Millisecond)) {
		if typ != "catalog" && typ != "agents" {
			t.Fatalf("at the API client's connect the page was sent %s", typ)
		}
	}

	// The chat is made with the page's call, in no group, and is given its folder; the first
	// message, with a permission ask in it, is the message call.
	const chat = "c3e1f5a7-9b2d-4e6f-8a1c-3d5e7f9a1b2c"
	cwd := t.TempDir()
	made := ok200(t, c, "POST", "/api/chats", map[string]any{"id": chat, "agent": "claude", "group": model.Ungrouped})
	if made["id"] != chat || made["group"] != model.Ungrouped || made["locked"] == true {
		t.Fatalf("the new chat: %v", made)
	}
	for _, gone := range []string{"started", "sent", "chat"} {
		if _, has := made[gone]; has {
			t.Fatalf("the new chat's answer has %q, a field of the creation call of before: %v", gone, made)
		}
	}
	ok200(t, c, "PATCH", "/api/chats/"+chat, map[string]any{"cwd": cwd})
	if sent := ok200(t, c, "POST", "/api/chats/"+chat+"/messages", map[string]any{"text": `first [[ask Bash {"command":"ls"}]]`}); sent["ok"] != true {
		t.Fatalf("the first message: %v", sent)
	}
	items := awaitItems(t, c, chat, "the permission ask", func(items []model.Item) bool {
		return len(items) > 0 && items[len(items)-1].Kind == "perm"
	})
	ask := items[len(items)-1]
	if ask.ToolName != "Bash" || ask.RequestID == "" || ask.Decided != "" || items[0].Kind != "user" {
		raw, _ := json.Marshal(items)
		t.Fatalf("the items at the ask: %s", raw)
	}
	save("two") // while the agent waits for the API client's answer
	ok200(t, c, "POST", "/api/chats/"+chat+"/permission", map[string]any{"requestId": ask.RequestID, "allow": true})
	ended := func(turns int, text string) func([]model.Item) bool {
		return func(items []model.Item) bool {
			n, has := 0, false
			for _, it := range items {
				if it.Kind == "end" {
					n++
				}
				has = has || strings.Contains(it.Text, text)
			}
			return n >= turns && has
		}
	}
	awaitItems(t, c, chat, "the reply after the answer", ended(1, "ask Bash -> allow"))

	// A second message, stopped while the agent sleeps.
	ok200(t, c, "POST", "/api/chats/"+chat+"/messages", map[string]any{"text": "second [[sleep 30]]"})
	save("three")
	sent := time.Now()
	ok200(t, c, "POST", "/api/chats/"+chat+"/interrupt", nil)
	items = awaitItems(t, c, chat, "the end of the stopped turn", ended(2, "second"))
	if d := time.Since(sent); d > 20*time.Second {
		t.Fatalf("the stopped turn ended after %v: the stop did not reach the agent", d)
	}
	for _, it := range items {
		if strings.Contains(it.Text, "FAKE(") && strings.Contains(it.Text, "second") {
			t.Fatalf("the stopped turn was answered: %q", it.Text)
		}
	}
	save("four")

	// The page: its board is its own still, and it was told of the chat, for which no group was
	// made.
	held := ok200(t, p, "POST", "/api/boards/"+board+"/take", map[string]any{"ifFree": true})
	if held["state"] != "held" || held["rev"] != float64(rev) {
		t.Fatalf("the page's hold after the API client's work: %v, want held at revision %d", held, rev)
	}
	if b, err := os.ReadFile(store.NewPaths(in.dir).BoardFile(board)); err != nil || !strings.Contains(string(b), `"four"`) {
		t.Fatalf("the board on disk: %s (%v)", b, err)
	}
	ps := typesOf(p.Drain(500 * time.Millisecond))
	count := func(types []string, typ string) (n int) {
		for _, got := range types {
			if got == typ {
				n++
			}
		}
		return n
	}
	for _, typ := range []string{"release_request", "superseded", "server_stopping", "groups"} {
		if count(ps, typ) != 0 {
			t.Errorf("the page was sent %s: %v", typ, ps)
		}
	}
	if count(ps, "chat") == 0 || count(ps, "chat_items") != 0 {
		t.Errorf("the page, which lists the chat and does not follow it, was sent %v", ps)
	}
	// The API client: the chat's list and content events, and no event of a page alone.
	cs := typesOf(c.Drain(500 * time.Millisecond))
	if count(cs, "chat") == 0 || count(cs, "chat_items") == 0 || count(cs, "branch_state") == 0 {
		t.Errorf("the API client was sent %v", cs)
	}
	for _, typ := range cs {
		if !slices.Contains(apiListEvents, typ) && !slices.Contains(apiFollowEvents, typ) {
			t.Errorf("the API client was sent %s", typ)
		}
	}

	// Both states list the chat, in no group, and no group was made for it; the server's log
	// holds no secret.
	state := ok200(t, c, "GET", "/api/state", nil)
	other := ok200(t, p, "GET", "/api/state", nil)
	for who, st := range map[string]map[string]any{"the second client": state, "the first client": other} {
		chats, _ := st["chats"].([]any)
		groups, _ := st["groups"].([]any)
		if len(chats) != 1 || chats[0].(map[string]any)["id"] != chat || chats[0].(map[string]any)["group"] != model.Ungrouped || len(groups) != 0 {
			t.Fatalf("the state of %s: chats %v, groups %v; want the one chat in no group and no group", who, st["chats"], st["groups"])
		}
	}
	noSecret(t, secret, serverLog(t, in.dir))
}
