//go:build !windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/app"
	"ai-whiteboard/internal/model"
)

// Run with AIWB_CODEX_E2E=1 and a logged-in Codex CLI on PATH.
func TestLiveCodexGitWorkerThroughWhiteboard(t *testing.T) {
	if os.Getenv("AIWB_CODEX_E2E") != "1" {
		t.Skip("set AIWB_CODEX_E2E=1 to run against the real Codex CLI")
	}
	bin, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("codex is not installed")
	}
	if !agenttest.HasNode() {
		t.Skip("node is required for the scripted parent agent")
	}
	t.Parallel()

	repo := t.TempDir()
	git := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git(repo, "init")
	git(repo, "-c", "user.name=Whiteboard Smoke", "-c", "user.email=smoke@example.invalid",
		"-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Base")
	base := git(repo, "rev-parse", "HEAD")
	probe := filepath.Join(repo, ".git", "whiteboard-worker-smoke")

	in := newInstance(t)
	in.claude, in.codex = agenttest.FakeClaude(t), bin
	srv := &scriptedServer{in: in}
	srv.start(t)
	t.Cleanup(func() { srv.stop(t) })
	p := in.page(t, testClient)
	made := ok200(t, p, "POST", "/api/chats", map[string]any{
		"agent": "claude", "group": model.Ungrouped,
	})
	id := made["id"].(string)
	path := "/api/chats/" + id
	in.must(t, testClient, "PATCH", path, map[string]any{"cwd": repo}, nil)
	args, err := json.Marshal(map[string]any{
		"agent": "codex", "git": true, "description": "Git worker smoke test",
		"prompt": fmt.Sprintf(`Run the following shell commands from your current directory, using normal sandbox permissions. The first command should report a permission error. Do not request approval. Report the branch and commit hash.
if (printf probe > %q) 2>/dev/null; then echo "Unexpected write to parent Git metadata"; exit 1; fi
git switch -c whiteboard-smoke &&
printf 'committed by a Whiteboard worker\n' > worker.txt &&
git add -- worker.txt &&
git -c user.name='Whiteboard Smoke' -c user.email=smoke@example.invalid -c commit.gpgsign=false commit -m 'Worker smoke commit' &&
git rev-parse HEAD`, probe),
	})
	if err != nil {
		t.Fatal(err)
	}
	if reply := in.say(t, id, "[[mcp spawn_subagent "+string(args)+"]]"); !strings.Contains(reply, "in Git clone") {
		t.Fatalf("orchestrator did not get the Git clone receipt: %q", reply)
	}
	var worker model.Subagent
	var thread struct{ Subagents []model.Subagent }
	in.must(t, testClient, "GET", path+"/items", nil, &thread)
	if len(thread.Subagents) != 1 {
		t.Fatalf("expected one worker, got %+v", thread.Subagents)
	}
	sid := thread.Subagents[0].ID
	for deadline := time.Now().Add(2 * time.Minute); ; time.Sleep(150 * time.Millisecond) {
		var sub struct{ Items []model.Item }
		in.must(t, testClient, "GET", path+"/subagents/"+sid+"/items", nil, &sub)
		for _, item := range sub.Items {
			if item.Kind == "perm" {
				t.Fatalf("the Git worker asked for approval: %+v", item)
			}
		}
		in.must(t, testClient, "GET", path+"/items", nil, &thread)
		worker = thread.Subagents[0]
		if worker.Status == model.SubCompleted {
			break
		}
		if worker.Status != model.SubRunning {
			t.Fatalf("worker ended as %s: %s\n%+v", worker.Status, worker.Error, sub.Items)
		}
		if time.Now().After(deadline) {
			t.Fatalf("worker did not finish: %+v", sub.Items)
		}
	}
	if _, err := os.Stat(probe); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("parent Git metadata probe should be absent: %v", err)
	}
	git(repo, "fetch", "--no-tags", "--", worker.GitWorkspace.Path, "refs/heads/whiteboard-smoke")
	if got := git(repo, "rev-parse", "FETCH_HEAD^"); got != base {
		t.Fatalf("fetched commit parent = %s, want %s", got, base)
	}
	if got := git(repo, "show", "FETCH_HEAD:worker.txt"); got != "committed by a Whiteboard worker" {
		t.Fatalf("fetched worker.txt = %q", got)
	}
	if got := git(repo, "rev-parse", "HEAD"); got != base {
		t.Fatalf("parent checkout moved to %s", got)
	}
	t.Logf("fetched worker branch whiteboard-smoke at %s without an approval request", git(repo, "rev-parse", "FETCH_HEAD"))
}

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
