import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingPerms, permClock, permTitle, permWhat, permWho } from "../src/logic/permwords.ts";
import type { Item } from "../src/types.ts";

const perm = (toolName: string, more: Partial<Item> = {}): Item => ({ kind: "perm", requestId: toolName, toolName, input: {}, ...more });

test("pendingPerms: the perm items with no answer at or after the end of the copied part", () => {
  const items: Item[] = [perm("Bash", { decided: "allow" }), { kind: "text", text: "x" }, perm("Edit"), perm("Bash", { decided: "" }), perm("Write", { decided: "deny" }), perm("Delete")];
  assert.deepEqual(pendingPerms(items, 0).map((p) => p.index), [2, 3, 5]);
  assert.deepEqual(pendingPerms(items, 3).map((p) => p.index), [3, 5]);
  assert.deepEqual(pendingPerms([null, undefined, perm("Bash")], 0).map((p) => p.index), [2]);
  assert.deepEqual(pendingPerms(items, 9), []);
});

test("permWho: the tool in words, the agent or the subagent as the subject", () => {
  for (const [tool, does] of [["Bash", "run a command"], ["bash", "run a command"], ["powershell", "run a command"], ["Edit", "edit a file"], ["MultiEdit", "edit a file"],
    ["NotebookEdit", "edit a file"], ["write", "edit a file"], ["Write", "edit a file"], ["Delete", "delete a file"], ["WebFetch", "fetch a page"],
    ["WebSearch", "search the web"], ["mcp__board__apply", "use the board"], ["Grep", "use Grep"]]) {
    assert.equal(permWho(perm(tool), "Claude"), `Claude wants to ${does}`, tool);
  }
  assert.equal(permWho(perm("Bash", { subagent: "s1" }), "Claude", "Audit the cart"), "Subagent “Audit the cart” wants to run a command");
  assert.equal(permWho(perm("Bash", { subagent: "s1" }), "Claude"), "Subagent “Subagent” wants to run a command");
  assert.equal(permWho(perm(""), "Cursor"), "Cursor wants to use a tool");
});

test("permTitle and permWhat read the input", () => {
  assert.equal(permTitle(perm("Bash", { input: { description: " Push the fix branch " } })), "Push the fix branch");
  assert.equal(permTitle(perm("Bash", { input: { command: "ls" } })), "");
  assert.equal(permTitle(perm("Bash", { input: undefined })), "");
  assert.equal(permWhat(perm("Bash", { input: { command: "git push" } })), "git push");
  assert.equal(permWhat(perm("Edit", { input: { file_path: "/a/b.go" } })), "/a/b.go");
  assert.equal(permWhat(perm("WebFetch", { input: { url: "https://x.y" } })), "https://x.y");
  assert.equal(permWhat(perm("NotebookEdit", { input: { notebook_path: "n.ipynb" } })), "n.ipynb");
  assert.equal(permWhat(perm("Grep", { input: {} })), "");
});

test("permClock: the local clock, minutes padded", () => {
  assert.equal(permClock(new Date(2026, 9, 23, 14, 3).getTime()), "14:03");
  assert.equal(permClock(new Date(2026, 9, 23, 9, 7).getTime()), "9:07");
});
