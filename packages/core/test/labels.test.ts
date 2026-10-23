import { test } from "node:test";
import assert from "node:assert/strict";
import { toolVerb, toolDone, statusText, waitingText, rowLine, dotState, otherBranches, otherBranchesText, alertsOf, alertText } from "../src/logic/labels.ts";

const names = (id: string) => ({ b_arch0001: "arch", b_flow0001: "flows" } as Record<string, string>)[id];
const on = { board: "b_flow0001" };

test("board tools: running labels", () => {
  const cases: [string, any, string][] = [
    ["list_boards", {}, "Listing boards"],
    ["read_board", on, "Reading flows"],
    ["read_board", {}, "Reading this board"],
    ["get_view", {}, "Looking at your view"],
    ["get_image", on, "Looking at flows"],
    ["get_image", {}, "Looking at this board"],
    ["apply", on, "Editing flows"],
    ["apply", {}, "Editing this board"],
    ["delete_elements", on, "Deleting on flows"],
    ["delete_elements", null, "Deleting on this board"],
    ["create_board", { name: "ideas" }, "Creating ideas"],
    ["show_board", on, "Showing flows"],
    ["show_board", { board: "b_unknown" }, "Showing b_unknown"],
    ["wait_subagents", {}, "Waiting for subagents"],
    ["stop_subagent", {}, "Stopping subagent"],
    ["resume_subagent", {}, "Resuming subagent"],
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
    ["get_image", on, "bounds x=0 ...", "Looked at flows"],
    ["get_image", {}, undefined, "Looked at this board"],
    ["apply", on, "not json", "Edited flows"],
    ["delete_elements", on, JSON.stringify({ deleted: ["a", "b"] }), "Deleted 2 on flows"],
    ["create_board", { name: "ideas" }, "created ideas (b_x)", "Created ideas"],
    ["show_board", on, "showing flows", "Showed flows"],
    ["show_board", {}, "showing arch", "Showed this board"],
    ["wait_subagents", {}, undefined, "Waited for subagents"],
    ["stop_subagent", {}, undefined, "Stopped subagent"],
    ["resume_subagent", {}, undefined, "Resumed subagent"],
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

test("Cursor's delete", () => {
  assert.equal(toolVerb("Delete", { file_path: "/a/b/old.ts" }), "Deleting old.ts");
  assert.equal(toolDone("Delete", { file_path: "/a/b/old.ts", old_string: "gone\n" }, ""), "Deleted old.ts");
  assert.equal(toolVerb("Delete", {}), "Deleting a file");
  assert.equal(toolDone("Delete", {}, ""), "Deleted a file");
  assert.equal(toolVerb("Delete", null), "Deleting a file");
  assert.equal(toolDone("Delete", undefined, undefined), "Deleted a file");
  // A thread from before the tool had its name holds the call under its title, with rawInput as the input.
  assert.equal(toolVerb("Delete `/a/b/old.ts`", { path: "/a/b/old.ts" }), "Delete `/a/b/old.ts`");
  assert.equal(toolDone("Delete `/a/b/old.ts`", { path: "/a/b/old.ts" }, ""), "Delete `/a/b/old.ts`");
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

test("statusText, rowLine and dotState: a chat whose agent is retried", () => {
  const now = 9_000_000;
  const retry = { attempt: 1, of: 4, kind: "login", at: now + 40_000 };
  const c = { status: "retrying" as const, usage, retry };
  assert.equal(statusText(c, undefined, now), "Retrying in 40 s · 1 of 4");
  assert.equal(statusText({ ...c, retry: { ...retry, at: now - 1 } }, undefined, now), "Retrying · 1 of 4");
  assert.equal(statusText({ status: "retrying", usage }), "Retrying", "no retry on the view");
  assert.equal(rowLine(c, "settings", undefined, now), "Retrying in 40 s · 1 of 4");
  assert.equal(rowLine({ ...c, working: 1 }, "settings", undefined, now), "Retrying in 40 s · 1 of 4", "before the count of other branches");
  assert.equal(rowLine({ ...c, approvals: 1 }, "settings", undefined, now), "Needs your approval");
  assert.equal(dotState(c), "thinking");
});

const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 3 };
const SENT_ONE = "1 subagent result not sent yet. It goes to the agent after your next message.";
const SENT_TWO = "2 subagent results not sent yet. They go to the agent after your next message.";
// A waiting chat refuses messages: its results go out when its current or next turn ends.
const WAIT_ONE = "1 subagent result not sent yet. It goes to the agent when its current or next turn ends.";
const WAIT_TWO = "2 subagent results not sent yet. They go to the agent when its current or next turn ends.";

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
  // a chat that waits for its background work says so first; the subagent parts follow as for an idle chat
  assert.equal(waitingText({ status: "waiting" }), "Waiting for background work");
  assert.equal(waitingText({ status: "waiting", subsRunning: 2 }), "Waiting for background work. Waiting on 2 subagents");
  assert.equal(waitingText({ status: "waiting", subsRunning: 1, subsOwed: 1 }), "Waiting for background work. Waiting on 1 subagent. " + WAIT_ONE);
  assert.equal(waitingText({ status: "waiting", subsOwed: 2 }), "Waiting for background work. " + WAIT_TWO);
  assert.equal(statusText({ status: "waiting", usage, subsOwed: 1 }), "Waiting for background work. " + WAIT_ONE);
  assert.equal(waitingText({ status: "waiting", archived: true }), "");
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
  // a chat that waits for its background work
  assert.equal(statusText({ status: "waiting", usage }), "Waiting for background work");
  assert.equal(statusText({ status: "waiting", usage, subsRunning: 2 }), "Waiting for background work. Waiting on 2 subagents");
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
  // a chat that waits for its background work, with the muted dot
  assert.equal(rowLine({ status: "waiting", usage }, settings), "Waiting for background work");
  assert.equal(dotState({ status: "waiting", usage }), "waiting");
  assert.equal(dotState({ status: "waiting", usage, working: 1 }), "waiting");
  assert.equal(dotState({ status: "waiting", usage, approvals: 1 }), "approval");
  // as before
  assert.equal(rowLine({ status: "thinking", usage, subsRunning: 2 }, settings), "Thinking…");
  assert.equal(rowLine({ status: "approval", usage }, settings), "Needs your approval");
  assert.equal(rowLine({ status: "stopped", usage, subsOwed: 1 }, settings), "Stopped");
  assert.equal(rowLine({ status: "error", usage, error: "Folder not found" }, settings), "Folder not found");
  assert.equal(rowLine({ status: "error", usage }, settings), "Can't start");
  assert.equal(rowLine({ status: "ready", usage, subsOwed: 1, archived: true }, settings), settings);
  // an approval on any branch comes first, also when the current branch does something else
  assert.equal(rowLine({ status: "ready", usage, working: 1, approvals: 1 }, settings), "Needs your approval");
  assert.equal(rowLine({ status: "thinking", usage, working: 2, approvals: 1 }, settings), "Needs your approval");
  assert.equal(rowLine({ status: "stopped", usage, working: 1, approvals: 1 }, settings), "Needs your approval");
  assert.equal(rowLine({ status: "ready", usage, subsRunning: 2, working: 3, approvals: 2 }, settings), "Needs your approval");
  // the current branch is busy: its own status text, whatever the other branches do
  assert.equal(rowLine({ status: "writing", usage, working: 3 }, settings), "Writing…");
  assert.equal(rowLine({ status: "approval", usage, working: 1, approvals: 1 }, settings), "Needs your approval");
  // the current branch is not busy and other branches work
  assert.equal(rowLine({ status: "ready", usage, working: 1 }, settings), "1 branch working");
  assert.equal(rowLine({ status: "ready", usage, working: 2 }, settings), "2 branches working");
  assert.equal(rowLine({ status: "ready", usage, subsRunning: 1, working: 2 }, settings), "2 branches working");
  assert.equal(rowLine({ status: "stopped", usage, working: 1 }, settings), "1 branch working");
  // none working: as without the counts
  assert.equal(rowLine({ status: "ready", usage, working: 0, approvals: 0 }, settings), settings);
  assert.equal(rowLine({ status: "stopped", usage, working: 0 }, settings), "Stopped");
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
  // an approval on any branch comes first
  assert.equal(dotState({ status: "ready", usage, working: 1, approvals: 1 }), "approval");
  assert.equal(dotState({ status: "writing", usage, working: 2, approvals: 1 }), "approval");
  assert.equal(dotState({ status: "stopped", usage, working: 1, approvals: 1 }), "approval");
  assert.equal(dotState({ status: "error", usage, working: 1, approvals: 1 }), "approval");
  // then the current branch's status when it is busy
  assert.equal(dotState({ status: "tool", usage, working: 3 }), "tool");
  // then other branches working, before a current branch that stopped or can't start (as rowLine) and the quiet waiting state
  assert.equal(dotState({ status: "stopped", usage, working: 1 }), "thinking");
  assert.equal(dotState({ status: "error", usage, working: 1 }), "thinking");
  assert.equal(dotState({ status: "stopped", usage, working: 0 }), "stopped");
  assert.equal(dotState({ status: "error", usage, working: 0 }), "error");
  assert.equal(dotState({ status: "ready", usage, working: 2 }), "thinking");
  assert.equal(dotState({ status: "ready", usage, subsOwed: 1, working: 1 }), "thinking");
  // none working: as without the counts
  assert.equal(dotState({ status: "ready", usage, working: 0, approvals: 0 }), "ready");
  assert.equal(dotState({ status: "ready", usage, subsRunning: 1, working: 0 }), "waiting");
});

test("otherBranches: the branches other than the one shown that wait for approval or work", () => {
  const st = (branch: string, status: string) => ({ branch, status: status as "ready" });
  assert.deepEqual(otherBranches([], "main"), { asks: null, failed: null, working: 0 });
  assert.deepEqual(otherBranches([st("main", "ready"), st("b1", "ready"), st("b2", "stopped"), st("b3", "error")], "main"), { asks: null, failed: "b3", working: 0 });
  // the branch shown is not another one, whatever it does
  assert.deepEqual(otherBranches([st("main", "approval"), st("b1", "ready")], "main"), { asks: null, failed: null, working: 0 });
  assert.deepEqual(otherBranches([st("main", "tool"), st("b1", "ready")], "main"), { asks: null, failed: null, working: 0 });
  // the same records seen from another branch
  assert.deepEqual(otherBranches([st("main", "approval"), st("b1", "ready")], "b1"), { asks: "main", failed: null, working: 0 });
  assert.deepEqual(otherBranches([st("main", "tool"), st("b1", "ready")], "b1"), { asks: null, failed: null, working: 1 });
  // working: in a turn, not waiting for approval; the first approval is the one named
  assert.deepEqual(otherBranches([st("main", "ready"), st("b1", "thinking"), st("b2", "writing"), st("b3", "tool")], "main"), { asks: null, failed: null, working: 3 });
  assert.deepEqual(otherBranches([st("main", "ready"), st("b1", "thinking"), st("b2", "approval"), st("b3", "approval")], "main"), { asks: "b2", failed: null, working: 1 });
});

test("dotState and rowLine agree when the current branch stopped or can't start and another works", () => {
  const settings = "Sonnet · default";
  for (const status of ["stopped", "error"] as const) {
    assert.equal(dotState({ status, usage, working: 1 }), "thinking");
    assert.equal(rowLine({ status, usage, working: 1 }, settings), "1 branch working");
  }
});

test("otherBranches: failed is the first other branch whose status is error", () => {
  const st = (branch: string, status: string) => ({ branch, status: status as "ready" });
  assert.equal(otherBranches([st("main", "ready"), st("b1", "stopped"), st("b2", "error"), st("b3", "error")], "main").failed, "b2");
  assert.equal(otherBranches([st("main", "error"), st("b1", "ready")], "main").failed, null); // the branch shown is not another one
  assert.deepEqual(otherBranches([st("main", "error"), st("b1", "tool"), st("b2", "approval")], "b1"), { asks: "b2", failed: "main", working: 0 });
});

test("otherBranchesText: the approval by the branch's name, else the error, else how many others work", () => {
  const name = (b: string) => (b === "b2" ? "redis" : b);
  assert.equal(otherBranchesText({ asks: null, failed: null, working: 0 }, name), "");
  assert.equal(otherBranchesText({ asks: null, failed: null, working: 1 }, name), "1 other branch working");
  assert.equal(otherBranchesText({ asks: null, failed: null, working: 3 }, name), "3 other branches working");
  assert.equal(otherBranchesText({ asks: "b2", failed: null, working: 0 }, name), "Approval needed on “redis”");
  assert.equal(otherBranchesText({ asks: "b2", failed: null, working: 2 }, name), "Approval needed on “redis”"); // the approval comes first
  assert.equal(otherBranchesText({ asks: null, failed: "b2", working: 0 }, name), "Error on “redis”");
  assert.equal(otherBranchesText({ asks: null, failed: "b2", working: 2 }, name), "Error on “redis”"); // the error comes before the count
  assert.equal(otherBranchesText({ asks: "b1", failed: "b2", working: 2 }, name), "Approval needed on “b1”");
});

test("alertsOf: the approval alone; the error with the count of the others that work after it; else the count", () => {
  assert.deepEqual(alertsOf({ asks: null, failed: null, working: 0 }), []);
  assert.deepEqual(alertsOf({ asks: null, failed: null, working: 2 }), ["working"]);
  assert.deepEqual(alertsOf({ asks: null, failed: "b2", working: 0 }), ["failed"]);
  assert.deepEqual(alertsOf({ asks: null, failed: "b2", working: 2 }), ["failed", "working"]); // an error does not hide the count
  assert.deepEqual(alertsOf({ asks: "b1", failed: null, working: 2 }), ["asks"]);
  assert.deepEqual(alertsOf({ asks: "b1", failed: "b2", working: 2 }), ["asks"]); // the approval comes before both
  // from the records: an errored branch left alone while two others work
  const st = (branch: string, status: string) => ({ branch, status: status as "ready" });
  assert.deepEqual(alertsOf(otherBranches([st("main", "ready"), st("b1", "error"), st("b2", "tool"), st("b3", "writing")], "main")), ["failed", "working"]);
});

test("alertText: each alert's own line", () => {
  const name = (b: string) => (b === "b2" ? "redis" : b);
  const o = { asks: null, failed: "b2", working: 2 };
  assert.deepEqual(alertsOf(o).map((k) => alertText(o, k, name)), ["Error on “redis”", "2 other branches working"]);
  assert.equal(alertText({ asks: null, failed: "b2", working: 1 }, "working", name), "1 other branch working");
  assert.equal(alertText({ asks: "b1", failed: "b2", working: 1 }, "asks", name), "Approval needed on “b1”");
});

test("statusText: a fork without a message whose agent starts says so, not what a turn would", () => {
  assert.equal(statusText({ status: "thinking", usage, fresh: true }), "Starting the agent…");
  assert.equal(statusText({ status: "tool", statusTool: "Bash", usage, fresh: true }), "Starting the agent…");
  assert.equal(statusText({ status: "writing", usage, fresh: true }), "Starting the agent…");
  // not busy: as any chat
  assert.equal(statusText({ status: "ready", usage, fresh: true }), "Idle");
  assert.equal(statusText({ status: "stopped", usage, fresh: true }), "Stopped");
  assert.equal(statusText({ status: "error", usage, fresh: true }), "Can't start");
  // not fresh: as before
  assert.equal(statusText({ status: "thinking", usage, fresh: false }), "Thinking…");
  assert.equal(statusText({ status: "thinking", usage }), "Thinking…");
  // the sidebar row follows; its dot stays the busy one
  assert.equal(rowLine({ status: "thinking", usage, fresh: true }, "Fable · High"), "Starting the agent…");
  assert.equal(rowLine({ status: "thinking", usage, fresh: true, working: 1 }, "Fable · High"), "Starting the agent…");
  assert.equal(dotState({ status: "thinking", usage, fresh: true }), "thinking");
});

test("a tool of the board server the labels do not name: its short name; another server's: the generic label", () => {
  assert.equal(toolVerb("mcp__board__some_future_tool", { id: "T07" }), "some_future_tool");
  assert.equal(toolDone("mcp__board__some_future_tool", { id: "T07" }, "ok"), "some_future_tool");
  assert.equal(toolVerb("mcp__other__cancel_task", {}), "other · cancel task");
  assert.equal(toolDone("mcp__other__cancel_task", { id: "T1" }, "ok"), "other · cancel task");
  // a bare name is no tool of the board server
  assert.equal(toolDone("cancel_task", {}, "ok"), "cancel_task");
});
