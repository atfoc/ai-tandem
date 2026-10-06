import { test } from "node:test";
import assert from "node:assert/strict";
import { toolVerb, toolDone, runTool, statusText, waitingText, rowLine, dotState } from "../src/logic/labels.ts";

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
    ["list_subagent_models", {}, "Listing subagent models"],
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
    ["list_subagent_models", {}, undefined, "Listed subagent models"],
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

const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 3 };
const SENT_ONE = "1 subagent result not sent yet. It goes to the agent after your next message.";
const SENT_TWO = "2 subagent results not sent yet. They go to the agent after your next message.";

test("waitingText: what an idle chat waits on", () => {
  // neither
  assert.equal(waitingText({ status: "ready" }), "");
  assert.equal(waitingText({ status: "ready", subsRunning: 0, subsOwed: 0 }), "");
  // subagents still running
  assert.equal(waitingText({ status: "ready", subsRunning: 1 }), "Waiting on 1 subagent");
  assert.equal(waitingText({ status: "ready", subsRunning: 3 }), "Waiting on 3 subagents");
  // results the agent has not been sent
  assert.equal(waitingText({ status: "ready", subsOwed: 1 }), SENT_ONE);
  assert.equal(waitingText({ status: "ready", subsOwed: 2 }), SENT_TWO);
  // both
  assert.equal(waitingText({ status: "ready", subsRunning: 2, subsOwed: 1 }), "Waiting on 2 subagents. " + SENT_ONE);
  assert.equal(waitingText({ status: "ready", subsRunning: 1, subsOwed: 2 }), "Waiting on 1 subagent. " + SENT_TWO);
  // a busy chat says what its agent does, not what it waits on
  for (const status of ["thinking", "writing", "tool", "approval"] as const) {
    assert.equal(waitingText({ status, subsRunning: 2, subsOwed: 1 }), "", status);
  }
  // not busy, whatever the status: the thread's line shows under a stopped chat too
  assert.equal(waitingText({ status: "stopped", subsOwed: 1 }), SENT_ONE);
  assert.equal(waitingText({ status: "error", subsOwed: 2 }), SENT_TWO);
  // an archived chat takes no message
  assert.equal(waitingText({ status: "ready", subsOwed: 1, archived: true }), "");
});

test("statusText: an idle chat says what it waits on", () => {
  assert.equal(statusText({ status: "ready", usage, subsRunning: 1 }), "Waiting on 1 subagent");
  assert.equal(statusText({ status: "ready", usage, subsRunning: 2 }), "Waiting on 2 subagents");
  assert.equal(statusText({ status: "ready", usage, subsOwed: 1 }), SENT_ONE);
  assert.equal(statusText({ status: "ready", usage, subsOwed: 2 }), SENT_TWO);
  assert.equal(statusText({ status: "ready", usage, subsRunning: 2, subsOwed: 2 }), "Waiting on 2 subagents. " + SENT_TWO);
  // neither: as before
  assert.equal(statusText({ status: "ready", usage, subsRunning: 0, subsOwed: 0 }), "Idle");
  assert.equal(statusText({ status: "ready", usage: { ...usage, turns: 0 } }), "Ready");
  // busy: what it shows today, with subagents running or results owed
  assert.equal(statusText({ status: "thinking", usage, subsRunning: 2, subsOwed: 1 }), "Thinking…");
  assert.equal(statusText({ status: "writing", usage, subsRunning: 2 }), "Writing…");
  assert.equal(statusText({ status: "tool", statusTool: "Bash", usage, subsRunning: 2 }), "Running a command…");
  assert.equal(statusText({ status: "approval", usage, subsRunning: 2 }), "Needs your approval");
  // the louder states keep their word; the thread's line carries the rest
  assert.equal(statusText({ status: "stopped", usage, subsOwed: 1 }), "Stopped");
  assert.equal(statusText({ status: "error", usage, subsOwed: 1 }), "Can't start");
});

test("rowLine: a sidebar row's second line", () => {
  const settings = "~/code · Sonnet";
  // an idle row with nothing to say shows its settings
  assert.equal(rowLine({ status: "ready", usage }, settings), settings);
  assert.equal(rowLine({ status: "ready", usage, subsRunning: 0, subsOwed: 0 }, settings), settings);
  // an idle row with something to say shows it in place of the settings, in the status text's words
  assert.equal(rowLine({ status: "ready", usage, subsRunning: 2 }, settings), "Waiting on 2 subagents");
  assert.equal(rowLine({ status: "ready", usage, subsOwed: 1 }, settings), SENT_ONE);
  for (const c of [{ status: "ready", usage, subsRunning: 1, subsOwed: 2 }, { status: "ready", usage, subsRunning: 3 }] as const) {
    assert.equal(rowLine(c, settings), statusText(c));
  }
  // as before
  assert.equal(rowLine({ status: "thinking", usage, subsRunning: 2 }, settings), "Thinking…");
  assert.equal(rowLine({ status: "approval", usage }, settings), "Needs your approval");
  assert.equal(rowLine({ status: "stopped", usage, subsOwed: 1 }, settings), "Stopped");
  assert.equal(rowLine({ status: "error", usage, error: "Folder not found" }, settings), "Folder not found");
  assert.equal(rowLine({ status: "error", usage }, settings), "Can't start");
  assert.equal(rowLine({ status: "ready", usage, subsOwed: 1, archived: true }, settings), settings);
});

test("dotState: the quiet waiting state of a sidebar row", () => {
  assert.equal(dotState({ status: "ready", usage }), "ready");
  assert.equal(dotState({ status: "ready", usage, subsRunning: 1 }), "waiting");
  assert.equal(dotState({ status: "ready", usage, subsOwed: 1 }), "waiting");
  assert.equal(dotState({ status: "ready", usage, subsOwed: 1, archived: true }), "ready");
  assert.equal(dotState({ status: "thinking", usage, subsRunning: 1 }), "thinking");
  assert.equal(dotState({ status: "approval", usage, subsRunning: 1 }), "approval");
  assert.equal(dotState({ status: "stopped", usage, subsOwed: 1 }), "stopped");
  assert.equal(dotState({ status: "error", usage, subsOwed: 1 }), "error");
});

// The eleven run tools with the input fields of the data contract: [tool, input, while it runs, once done].
const RUN_TOOL_CASES: [string, any, string, string][] = [
  ["get_run", { offset: 2 }, "Reading the run", "Read the run"],
  ["get_task", { id: "T07", part: "report", attempt: 2, offset: 0 }, "Reading task T07", "Read task T07"],
  ["get_agent", { agent: "T11-work", last: 15 }, "Reading agent T11-work", "Read agent T11-work"],
  ["get_notes", { version: 3, offset: 0 }, "Reading the notes", "Read the notes"],
  ["set_notes", { notes: "Keep the e2e script green." }, "Writing the notes", "Wrote the notes"],
  ["add_task", { title: "Document the fork tree", brief: "Write docs/fork-tree.md", kind: "docs", writes: true, depends_on: ["T07"] },
    "Adding a task: Document the fork tree", "Added a task: Document the fork tree"],
  ["update_task", { id: "T12", title: "A new title" }, "Updating task T12", "Updated task T12"],
  ["cancel_task", { id: "T99", reason: "Not needed." }, "Cancelling task T99", "Cancelled task T99"],
  ["retry_task", { id: "T07", reason: "Another pass." }, "Retrying task T07", "Retried task T07"],
  ["edit_notes", { heading: "Decisions", text: "- Keep the fork tree flat." }, "Editing the notes: Decisions", "Edited the notes: Decisions"],
  ["wait_for", { tasks: ["T02", "T03"] }, "Waiting for T02, T03", "Will wait for T02, T03"],
  ["finish_run", { outcome: "achieved", summary: "All done." }, "Finishing the run", "Finished the run"],
  ["tell_orchestrator", { text: "Keep the e2e script green." }, "Telling the orchestrator", "Told the orchestrator"],
];

test("run tools: every one, running and done", () => {
  assert.equal(RUN_TOOL_CASES.length, 13);
  for (const [tool, input, running, done] of RUN_TOOL_CASES) {
    const name = "mcp__board__" + tool;
    assert.equal(toolVerb(name, input, names), running, tool);
    assert.equal(toolDone(name, input, "ok", names), done, tool);
    assert.equal(toolDone(name, input, undefined), done, tool + " without a result");
    assert.equal(runTool(name, input, false), running, tool);
    assert.equal(runTool(name, input, true), done, tool);
  }
});

test("run tools: long and missing arguments", () => {
  // a title is cut at 36 characters, an id at 24
  assert.equal(toolVerb("mcp__board__add_task", { title: "Rewrite the checkout flow on the new cart API" }), "Adding a task: Rewrite the checkout flow on the ne…");
  assert.equal(toolDone("mcp__board__add_task", {}, "ok"), "Added a task");
  assert.equal(toolDone("mcp__board__get_agent", { agent: "T11-work-attempt-3-merge-again" }, "ok"), "Read agent T11-work-attempt-3-merg…");
  // an argument the label does not use changes nothing
  assert.equal(toolDone("mcp__board__update_task", { id: "T12", title: "A new title" }, "ok"), "Updated task T12");
  // no input: a call whose input has not arrived, and a chat's status line (which has the name alone)
  assert.equal(toolVerb("mcp__board__get_task", null), "Reading a task");
  assert.equal(toolVerb("mcp__board__get_agent", {}), "Reading an agent");
  assert.equal(toolDone("mcp__board__retry_task", undefined, undefined), "Retried a task");
  assert.equal(toolVerb("mcp__board__cancel_task", {}), "Cancelling a task");
  assert.equal(toolVerb("mcp__board__update_task", null), "Updating a task");
  assert.equal(statusText({ status: "tool", statusTool: "mcp__board__get_task", usage }), "Reading a task…");
  assert.equal(statusText({ status: "tool", statusTool: "mcp__board__tell_orchestrator", usage }), "Telling the orchestrator…");
  assert.equal(rowLine({ status: "tool", statusTool: "mcp__board__get_run", usage }, "~/code · Sonnet"), "Reading the run…");
});

test("run tools: only the board server's own, and only the ones in the table", () => {
  // an unknown tool of the board server falls through to its raw short name
  assert.equal(runTool("mcp__board__some_future_tool", { id: "T07" }, true), null);
  assert.equal(toolVerb("mcp__board__some_future_tool", { id: "T07" }), "some_future_tool");
  assert.equal(toolDone("mcp__board__some_future_tool", { id: "T07" }, "ok"), "some_future_tool");
  // a name that every object has is not a hit
  for (const n of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]) {
    assert.equal(runTool("mcp__board__" + n, {}, false), null, n);
    assert.equal(toolVerb("mcp__board__" + n, {}), n, n);
    assert.equal(toolDone("mcp__board__" + n, {}, "ok"), n, n);
  }
  // another server's tool of the same name keeps the generic label
  assert.equal(runTool("mcp__other__get_run", {}, false), null);
  assert.equal(toolVerb("mcp__other__get_run", {}), "other · get run");
  assert.equal(toolDone("mcp__other__cancel_task", { id: "T1" }, "ok"), "other · cancel task");
  // and so does a bare name, which is no tool of the board server
  assert.equal(runTool("get_run", {}, true), null);
  assert.equal(toolDone("get_run", {}, "ok"), "get_run");
  // the board tools are untouched
  assert.equal(runTool("mcp__board__read_board", {}, false), null);
  assert.equal(toolVerb("mcp__board__read_board", {}), "Reading this board");
});

test("run tools: what the orchestrator waits for, and the section of the notes it edits", () => {
  const w = "mcp__board__wait_for", e = "mcp__board__edit_notes";
  assert.equal(runTool(w, { tasks: ["T02", "T03"], mode: "all" }, false), "Waiting for T02, T03");
  assert.equal(runTool(w, { tasks: ["T02", "T03"], mode: "any" }, false), "Waiting for the first of T02, T03");
  assert.equal(runTool(w, { tasks: ["T02", "T03"], mode: "any" }, true), "Will wait for the first of T02, T03");
  assert.equal(runTool(w, { tasks: ["T02"] }, true), "Will wait for T02");
  for (const input of [undefined, {}, { tasks: [] }, { tasks: "T02" }]) {
    assert.equal(runTool(w, input, false), "Setting what it waits for");
    assert.equal(runTool(w, input, true), "Set what it waits for");
  }
  assert.equal(runTool(e, {}, false), "Editing the notes");
  assert.equal(runTool(e, undefined, true), "Edited the notes");
  assert.equal(runTool(e, { heading: "What the review of the checkout flow found" }, true), "Edited the notes: What the review of the checkout flo…");
});
