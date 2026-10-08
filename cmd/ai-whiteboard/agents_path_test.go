package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

// agentsEvent waits until the page is sent an agents event and returns its list. It makes no
// call: what the server finds, it finds by looking again on its own.
func agentsEvent(t *testing.T, p *bridgetest.Page, limit time.Duration) []string {
	t.Helper()
	for deadline := time.Now().Add(limit); ; {
		for _, raw := range p.Drain(200 * time.Millisecond) {
			var ev struct {
				Type   string
				Agents []string
			}
			if json.Unmarshal([]byte(raw), &ev) == nil && ev.Type == "agents" {
				if ev.Agents == nil {
					t.Fatalf("page %s: an agents event without a list: %s", p.ID, raw)
				}
				return ev.Agents
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("page %s was sent no agents event within %s", p.ID, limit)
		}
	}
}

// refusedCall checks that the page's call is refused with 409 and the code.
func refusedCall(t *testing.T, p *bridgetest.Page, code, method, path string, body any) {
	t.Helper()
	status, out := p.Do(method, path, body)
	var r struct{ Error, Code string }
	json.Unmarshal(out, &r)
	if status != 409 || r.Code != code || r.Error == "" {
		t.Fatalf("%s %s: %d %s, want 409 with the code %q", method, path, status, out, code)
	}
}

// AC44: the agents a server can use are the ones whose programs are on its PATH, looked up
// again while it runs, and every client is told of a change. The server is started with the
// default program names and a PATH that has none of them; then the stand-in agent appears there
// as "claude", and is removed again.
func TestUsableAgentsFollowThePath(t *testing.T) {
	serverTest(t, "TestListFollowsThePath, TestWatchCallsOncePerChange (internal/usable)", "TestAgentsEventReachesAClient, TestAgentOutsideTheUsableOnes (internal/server)")
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH (the fake claude is a Node script)")
	}
	in := newInstance(t)
	in.setenv(fastest.env(t, "agents")) // the test waits for two look-ups: 1 s apart, for 30 s
	in.claude = "claude"                // the default name: every command of the test finds it on PATH or not at all
	scratch, nodeDir := t.TempDir(), t.TempDir()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	// node alone, not its folder: that one may hold the owner's installed agents.
	if err := os.Symlink(node, filepath.Join(nodeDir, "node")); err != nil {
		t.Fatal(err)
	}
	path := "PATH=" + scratch + ":" + nodeDir + ":/usr/bin:/bin"
	for _, name := range []string{"claude", "agent", "pi"} {
		for _, dir := range []string{"/usr/bin", "/bin"} {
			if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
				t.Skipf("%s/%s exists: the test needs a PATH without the agents' programs", dir, name)
			}
		}
	}

	serve := exec.Command(in.bin, append([]string{"serve", "-cwd", t.TempDir(),
		"-cursor-cost", filepath.Join(scratch, "no-cursor-cost")}, in.flags()...)...)
	serve.Env = append(in.environ(), path)
	serve.Stdout, serve.Stderr = os.Stderr, os.Stderr
	if err := serve.Start(); err != nil {
		t.Fatal(err)
	}
	served := make(chan struct{})
	go func() { serve.Wait(); close(served) }()
	// The start has no limit that a loaded machine could decide: the wait ends when the server
	// answers or its process is gone, and the two minutes only keep a hung start from the
	// timeout of the whole test binary.
	for deadline := time.Now().Add(2 * time.Minute); !isOurs(httpClient(), strings.TrimSuffix(in.url, "/")); time.Sleep(100 * time.Millisecond) {
		select {
		case <-served:
			t.Fatal("the server process ended before it answered")
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("the server did not answer within 2 minutes")
		}
	}
	if pid := in.hello(t).Pid; pid != serve.Process.Pid {
		t.Fatalf("the server that answers has the pid %d, the one started %d", pid, serve.Process.Pid)
	}

	base := strings.TrimSuffix(in.url, "/")
	p, q := bridgetest.Connect(t, base, "6f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f"), bridgetest.Connect(t, base, "7a2f3e4d-5c6b-4d7e-9f80-1b2c3d4e5f60")
	for _, pg := range []*bridgetest.Page{p, q} {
		if got, _ := pg.Welcome()["agents"].([]any); got == nil || len(got) != 0 {
			t.Fatalf("page %s: the snapshot's agents %v, want none", pg.ID, got)
		}
	}
	stateAgents := func() []string {
		t.Helper()
		var snap struct{ Agents []string }
		status, out := p.Do("GET", "/api/state", nil)
		if status != 200 || json.Unmarshal(out, &snap) != nil || snap.Agents == nil {
			t.Fatalf("GET /api/state: %d, agents %v", status, snap.Agents)
		}
		return snap.Agents
	}
	newChat := func(body map[string]any) string {
		t.Helper()
		body["group"] = model.Ungrouped
		id, _ := ok200(t, p, "POST", "/api/chats", body)["id"].(string)
		if id == "" {
			t.Fatal("the new chat has no id")
		}
		return id
	}

	// No program: no agent, and a chat's first message is refused.
	if got := stateAgents(); len(got) != 0 {
		t.Fatalf("the agents with none on PATH: %v", got)
	}
	none := newChat(map[string]any{})
	refusedCall(t, p, "no_agent", "POST", "/api/chats/"+none+"/messages", map[string]any{"text": "hello"})
	p.Drain(300 * time.Millisecond)
	q.Drain(300 * time.Millisecond)

	// The program appears: the server finds it by itself, and tells both streams.
	fake, err := os.ReadFile(agenttest.FakeClaude(t))
	if err != nil {
		t.Fatal(err)
	}
	claude := filepath.Join(scratch, "claude")
	if err := os.WriteFile(claude, fake, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, pg := range []*bridgetest.Page{p, q} {
		if got := agentsEvent(t, pg, 35*time.Second); !slices.Equal(got, []string{"claude"}) {
			t.Fatalf("page %s: the agents event %v, want claude alone", pg.ID, got)
		}
	}
	if got := stateAgents(); !slices.Equal(got, []string{"claude"}) {
		t.Fatalf("the agents with claude on PATH: %v", got)
	}
	if pid := in.hello(t).Pid; pid != serve.Process.Pid {
		t.Fatalf("the server's pid is %d after the change, was %d", pid, serve.Process.Pid)
	}

	// An agent whose program is not there is refused wherever it is chosen.
	cwd := t.TempDir()
	chat := newChat(map[string]any{"agent": "claude", "cwd": cwd})
	waiting := newChat(map[string]any{"agent": "claude", "cwd": cwd})
	refusedCall(t, p, "agent_missing", "POST", "/api/chats", map[string]any{"group": model.Ungrouped, "agent": "cursor"})
	refusedCall(t, p, "agent_missing", "PATCH", "/api/chats/"+waiting, map[string]any{"agent": "cursor"})
	draft, _ := ok200(t, p, "POST", "/api/runs", map[string]any{"group": model.Ungrouped})["id"].(string)
	if draft == "" {
		t.Fatal("the draft run has no id")
	}
	refusedCall(t, p, "agent_missing", "PATCH", "/api/runs/"+draft, map[string]any{"agent": "cursor"})

	// A message is answered by the program found; the chat's tools name that agent alone.
	ok200(t, p, "POST", "/api/chats/"+chat+"/messages", map[string]any{"text": "hello"})
	awaitItems(t, p, chat, "the end of the turn", func(items []model.Item) bool {
		return len(items) > 1 && items[len(items)-1].Kind == "end"
	})
	var meta struct{ Token string }
	if b, err := os.ReadFile(filepath.Join(store.NewPaths(in.dir).ChatDir(chat), "chat.json")); err != nil || json.Unmarshal(b, &meta) != nil || meta.Token == "" {
		t.Fatalf("the chat's chat.json: %v, token %q", err, meta.Token)
	}
	mcp := &runServer{in: in}
	var listed struct {
		Result struct {
			Tools []struct {
				Name        string
				InputSchema struct {
					Properties map[string]struct{ Enum []string }
				}
			}
		}
	}
	if raw := mcp.mcp(t, meta.Token, "tools/list", map[string]any{}); json.Unmarshal([]byte(raw), &listed) != nil {
		t.Fatalf("tools/list: %s", raw)
	}
	enums := map[string][]string{}
	for _, tool := range listed.Result.Tools {
		if a, has := tool.InputSchema.Properties["agent"]; has {
			enums[tool.Name] = a.Enum
		}
	}
	for _, name := range []string{"spawn_subagent", "list_subagent_models"} {
		if !slices.Equal(enums[name], []string{"claude"}) {
			t.Fatalf("%s lists the agents %v, want claude alone (all: %v)", name, enums[name], enums)
		}
		text, isErr := mcp.mcpTool(t, meta.Token, name, map[string]any{"agent": "pi", "prompt": "do it"})
		if !isErr || !strings.Contains(text, `agent "pi" cannot be used on this server`) {
			t.Fatalf("%s for pi: error %v, %q", name, isErr, text)
		}
	}
	p.Drain(300 * time.Millisecond)
	q.Drain(300 * time.Millisecond)

	// The program goes: both streams are told, and nothing starts any more.
	if err := os.Remove(claude); err != nil {
		t.Fatal(err)
	}
	for _, pg := range []*bridgetest.Page{p, q} {
		if got := agentsEvent(t, pg, 35*time.Second); len(got) != 0 {
			t.Fatalf("page %s: the agents event %v, want none", pg.ID, got)
		}
	}
	if got := stateAgents(); len(got) != 0 {
		t.Fatalf("the agents after the program was removed: %v", got)
	}
	refusedCall(t, p, "agent_missing", "POST", "/api/chats/"+waiting+"/messages", map[string]any{"text": "hello"})
	refusedCall(t, p, "no_agent", "POST", "/api/chats/"+newChat(map[string]any{})+"/messages", map[string]any{"text": "hello"})
	if pid := in.hello(t).Pid; pid != serve.Process.Pid {
		t.Fatalf("the server's pid is %d at the end, was %d", pid, serve.Process.Pid)
	}

	in.run(t, "stop")
	select {
	case <-served:
	case <-time.After(15 * time.Second):
		t.Fatal("the server process did not exit within 15 s of the stop")
	}
}
