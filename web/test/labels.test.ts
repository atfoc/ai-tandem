import { test } from "node:test";
import assert from "node:assert/strict";
import { toolVerb, toolDone, statusText } from "../src/logic/labels.ts";

const names = (id: string) => ({ b_arch0001: "arch", b_flow0001: "flows" } as Record<string, string>)[id];
const on = { board: "b_flow0001" };

test("board tools: running labels", () => {
  const cases: [string, any, string][] = [
    ["list_boards", {}, "Listing boards"],
    ["read_board", on, "Reading flows"],
    ["read_board", {}, "Reading this board"],
    ["get_view", {}, "Looking at your view"],
    ["apply", on, "Editing flows"],
    ["apply", {}, "Editing this board"],
    ["delete_elements", on, "Deleting on flows"],
    ["delete_elements", null, "Deleting on this board"],
    ["create_board", { name: "ideas" }, "Creating ideas"],
    ["show_board", on, "Showing flows"],
    ["show_board", { board: "b_unknown" }, "Showing b_unknown"],
    ["wait_subagents", {}, "Waiting for subagents"],
    ["stop_subagent", {}, "Stopping subagent"],
  ];
  for (const [tool, input, want] of cases) {
    assert.equal(toolVerb("mcp__board__" + tool, input, names), want, tool);
  }
});

test("board tools: done labels", () => {
  const cases: [string, any, string | undefined, string][] = [
    ["list_boards", {}, "arch (b_arch0001)", "Listed boards"],
    ["read_board", on, "rectangle ...", "Read flows"],
    ["read_board", {}, "rectangle ...", "Read this board"],
    ["get_view", {}, "viewport ...", "Looked at your view"],
    ["apply", on, "not json", "Edited flows"],
    ["delete_elements", on, JSON.stringify({ deleted: ["a", "b"] }), "Deleted 2 on flows"],
    ["create_board", { name: "ideas" }, "created ideas (b_x)", "Created ideas"],
    ["show_board", on, "showing flows", "Showed flows"],
    ["show_board", {}, "showing arch", "Showed this board"],
    ["wait_subagents", {}, undefined, "Waited for subagents"],
    ["stop_subagent", {}, undefined, "Stopped subagent"],
  ];
  for (const [tool, input, result, want] of cases) {
    assert.equal(toolDone("mcp__board__" + tool, input, result, names), want, tool);
  }
});

test("apply result +3 ~1", () => {
  const result = JSON.stringify({ board: "arch", id: "b_arch0001", created: { a: "1", b: "2", c: "3" }, updated: ["x"] });
  assert.equal(toolDone("mcp__board__apply", {}, result, names), "Edited arch · +3 ~1");
  const conflicts = JSON.stringify({ board: "arch", created: {}, updated: [], conflicts: ["x", "y"] });
  assert.equal(toolDone("mcp__board__apply", {}, conflicts, names), "Edited arch · 2 conflicts");
});

test("Claude's own tools", () => {
  assert.equal(toolVerb("Bash", { command: "ls -la", description: "List files" }), "List files");
  assert.equal(toolDone("Bash", { command: "ls -la", description: "List files" }, "x"), "List files");
  assert.equal(toolVerb("Bash", { command: "ls -la" }), "Running `ls -la`");
  assert.equal(toolDone("Bash", { command: "ls -la" }, "x"), "Ran `ls -la`");
  assert.equal(toolVerb("Bash", {}), "Running a command");
  assert.equal(toolVerb("Read", { file_path: "/a/b/main.go" }), "Reading main.go");
  assert.equal(toolDone("Read", { file_path: "/a/b/main.go" }, "x"), "Read main.go");
  assert.equal(toolVerb("Edit", { file_path: "/a/b/c.ts" }), "Editing c.ts");
  assert.equal(toolDone("Edit", { file_path: "/a/b/c.ts" }, "x"), "Edited c.ts");
  assert.equal(toolVerb("Grep", { pattern: "TODO" }), "Searching for TODO");
  assert.equal(toolDone("Grep", { pattern: "TODO" }, "x"), "Searched for TODO");
  assert.equal(toolVerb("WebFetch", { url: "https://example.com/a/b" }), "Fetching example.com");
  assert.equal(toolDone("WebFetch", { url: "https://example.com/a/b" }, "x"), "Fetched example.com");
  assert.equal(toolVerb("Task", { description: "find the bug" }), "Subagent working: find the bug");
  assert.equal(toolDone("Task", { description: "find the bug" }, "x"), "Subagent finished: find the bug");
});

test("Pi's own tools", () => {
  assert.equal(toolVerb("read", { path: "/a/b/main.go" }), "Reading main.go");
  assert.equal(toolDone("read", { path: "/a/b/main.go" }, "x"), "Read main.go");
  assert.equal(toolVerb("read", {}), "Reading a file");
  assert.equal(toolVerb("bash", { command: "ls -la" }), "Running `ls -la`");
  assert.equal(toolDone("bash", { command: "ls -la" }, "x"), "Ran `ls -la`");
  assert.equal(toolVerb("bash", {}), "Running a command");
  assert.equal(toolVerb("edit", { path: "/a/b/c.ts" }), "Editing c.ts");
  assert.equal(toolDone("edit", { path: "/a/b/c.ts" }, "x"), "Edited c.ts");
  assert.equal(toolVerb("write", { path: "/a/b/out.txt" }), "Writing out.txt");
  assert.equal(toolDone("write", { path: "/a/b/out.txt" }, "x"), "Wrote out.txt");
  assert.equal(toolVerb("grep", { pattern: "TODO" }), "Searching for TODO");
  assert.equal(toolDone("grep", { pattern: "TODO" }, "x"), "Searched for TODO");
  assert.equal(toolVerb("find", { pattern: "*.ts" }), "Finding files *.ts");
  assert.equal(toolDone("find", { pattern: "*.ts" }, "x"), "Found files *.ts");
  assert.equal(toolVerb("ls", { path: "/a/b" }), "Listing b");
  assert.equal(toolDone("ls", { path: "/a/b" }, "x"), "Listed b");
  assert.equal(toolVerb("ls", {}), "Listing a directory");
});

test("other MCP servers", () => {
  assert.equal(toolVerb("mcp__github__create_issue", {}), "github · create issue");
  assert.equal(toolDone("mcp__github__create_issue", {}, "x"), "github · create issue");
});

test("statusText", () => {
  const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
  assert.equal(statusText({ status: "ready", usage }), "Ready");
  assert.equal(statusText({ status: "ready", usage: { ...usage, turns: 2 } }), "Idle");
  assert.equal(statusText({ status: "thinking", usage }), "Thinking…");
  assert.equal(statusText({ status: "writing", usage }), "Writing…");
  assert.equal(statusText({ status: "tool", statusTool: "mcp__board__read_board", usage }), "Reading this board…");
  assert.equal(statusText({ status: "tool", statusTool: "Bash", usage }), "Running a command…");
  assert.equal(statusText({ status: "approval", usage }), "Needs your approval");
  assert.equal(statusText({ status: "stopped", usage }), "Stopped");
  assert.equal(statusText({ status: "error", usage }), "Can't start");
});
