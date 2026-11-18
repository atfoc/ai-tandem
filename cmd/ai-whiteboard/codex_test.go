//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"ai-whiteboard/internal/app"
	"ai-whiteboard/internal/model"
)

func TestCodexChatThroughServer(t *testing.T) {
	serverTest(t, "Codex adapter tests (internal/codex)")
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required for the Codex app-server stand-in")
	}

	in := newInstance(t)
	in.codex = filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(in.codex, []byte(fakeCodexServer), 0o700); err != nil {
		t.Fatal(err)
	}
	srv := &scriptedServer{in: in}
	srv.start(t)
	t.Cleanup(func() { srv.stop(t) })

	p := in.page(t, testClient)
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		var snap app.APISnapshot
		in.must(t, testClient, "GET", "/api/state", nil, &snap)
		if !slices.Contains(snap.Agents, model.Codex) {
			t.Fatalf("Codex missing from agents %v", snap.Agents)
		}
		if c := snap.Catalogs[model.Codex]; c != nil {
			if c.Default.Model != "codex-test" || c.Default.Effort != "medium" {
				t.Fatalf("Codex catalog default %+v", c.Default)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Codex catalog was never published")
		}
	}

	made := ok200(t, p, "POST", "/api/chats", map[string]any{"agent": "codex", "group": model.Ungrouped})
	id, ok := made["id"].(string)
	if !ok || made["agent"] != "codex" || made["model"] != "codex-test" {
		t.Fatalf("new Codex chat: %v", made)
	}
	path := "/api/chats/" + id
	ok200(t, p, "POST", path+"/messages", map[string]string{"text": "hello"})
	items := awaitItems(t, p, id, "the Codex permission request", func(items []model.Item) bool {
		return len(items) > 0 && items[len(items)-1].Kind == "perm"
	})
	ask := items[len(items)-1]
	if ask.ToolName != "Bash" || ask.RequestID == "" {
		t.Fatalf("permission request: %+v", ask)
	}
	ok200(t, p, "POST", path+"/permission", map[string]any{"requestId": ask.RequestID, "allow": true})
	items = awaitItems(t, p, id, "the completed Codex turn", func(items []model.Item) bool {
		return len(items) > 0 && items[len(items)-1].Kind == "end"
	})
	if items[len(items)-1].Point != "first-turn" {
		t.Fatalf("the completed Codex turn: %+v", items[len(items)-1])
	}
	fork := ok200(t, p, "POST", path+"/fork", map[string]any{"branch": "main", "at": len(items)})
	if fork["id"] == id || fork["agent"] != "codex" {
		t.Fatalf("Codex fork: %v", fork)
	}
}

const fakeCodexServer = `#!/usr/bin/env node
const readline = require("node:readline");
const line = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const notify = (method, params) => line({method, params});
readline.createInterface({input: process.stdin}).on("line", (raw) => {
  const {id, method, params, result} = JSON.parse(raw);
  const reply = (result) => line({id, result});
  switch (method) {
    case "initialize":
    case "thread/name/set":
      reply({});
      break;
    case "model/list":
      reply({data: [{model: "codex-test", isDefault: true, defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{reasoningEffort: "medium"}]}]});
      break;
    case "thread/start":
      if (params.model !== "codex-test") process.exit(2);
      reply({thread: {id: "source-thread"}, activePermissionProfile: {id: "tandem"}});
      break;
    case "turn/start": {
      const {threadId} = params;
      reply({turn: {id: "first-turn"}});
      notify("turn/started", {threadId, turn: {id: "first-turn"}});
      line({id: "approve-test", method: "item/commandExecution/requestApproval", params: {
        threadId, turnId: "first-turn", itemId: "command", command: "echo hello"
      }});
      break;
    }
    case "thread/fork":
      if (params.threadId !== "source-thread" || params.lastTurnId !== "first-turn") process.exit(3);
      reply({thread: {id: "fork-thread"}, activePermissionProfile: {id: "tandem"}});
      break;
    case undefined:
      if (id === "approve-test") {
        if (result?.decision !== "accept") process.exit(4);
        notify("turn/completed", {threadId: "source-thread", turn: {id: "first-turn", status: "completed"}});
      }
      break;
  }
});
`
