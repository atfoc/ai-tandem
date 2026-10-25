import { test } from "node:test";
import assert from "node:assert/strict";
import { capRows, exitCode, foldOf, groupSummary, headLine, lastLines, readOnlyStep, rowNumber, unifiedText } from "../src/logic/steps.ts";
import { numbered } from "../src/logic/linediff.ts";
import type { Item } from "../src/types.ts";

const tool = (name: string, more: Partial<Item> = {}): Item => ({ kind: "tool", toolId: name, name, input: {}, result: "ok", ...more });

test("a finished read folds; a failed, denied or running one, a command and a message do not", () => {
  assert.equal(foldOf(tool("Read")), "steps");
  assert.equal(foldOf(tool("mcp__board__read_board")), "steps");
  assert.equal(readOnlyStep(tool("Read", { isError: true })), false);
  assert.equal(readOnlyStep(tool("Grep", { denied: true })), false);
  assert.equal(readOnlyStep(tool("Glob", { result: undefined })), false);
  assert.equal(foldOf(tool("Bash")), null);
  assert.equal(foldOf(tool("Edit")), null);
  assert.equal(foldOf({ kind: "text", text: "hi" }), null);
});

test("a call that started a subagent folds into its run's card, running or not", () => {
  assert.equal(foldOf(tool("Task", { result: undefined })), "subagents");
  assert.equal(foldOf(tool("Agent")), "subagents");
  assert.equal(foldOf(tool("mcp__board__spawn_subagent")), "subagents");
});

test("the exit code is read from the three agents' own words, or there is none", () => {
  const out = (result: unknown) => exitCode(tool("Bash", { result: result as string }));
  assert.equal(out("FAIL\nExit code 1"), 1);
  assert.equal(out("Exit code 127\nbash: nope: command not found"), 127);
  assert.equal(out("some output\n\nCommand exited with code 2\n"), 2);
  assert.equal(out("--- FAIL: TestX\nFAIL\nexit status 3"), 3);
  assert.equal(out("all good"), null);
  assert.equal(out(""), null);
  assert.equal(out(undefined), null);
  assert.equal(out("it said exit status 4 in the middle\nand went on"), null);
});

test("the last lines of a text and how many it has", () => {
  assert.deepEqual(lastLines("a\nb\nc\nd", 2), { text: "c\nd", shown: 2, total: 4 });
  assert.deepEqual(lastLines("a\nb\n", 6), { text: "a\nb", shown: 2, total: 2 });
  assert.deepEqual(lastLines("", 6), { text: "", shown: 0, total: 0 });
});

test("a folded run says its verb once, or tells each call", () => {
  assert.equal(groupSummary(["Read coupon.go", "Read cart.go", "Read coupon_test.go"]), "Read coupon.go, cart.go, coupon_test.go");
  assert.equal(groupSummary(["Read coupon.go", "Searched for x"]), "Read coupon.go · Searched for x");
  assert.equal(groupSummary(["Listed boards", "Listed boards"]), "Listed boards");
});

test("the rows of all the changes of a card are capped together", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => i);
  assert.deepEqual(capRows([rows(4), rows(4), rows(4)], 10), { changes: [rows(4), rows(4), rows(2)], left: 2 });
  assert.deepEqual(capRows([rows(12)], 10), { changes: [rows(10)], left: 2 });
  assert.deepEqual(capRows([rows(3), rows(3)], 10), { changes: [rows(3), rows(3)], left: 0 });
  assert.deepEqual(capRows([rows(10), rows(3)], 10), { changes: [rows(10)], left: 3 });
});

test("a change's head line, its number column and its copied text", () => {
  const rows = numbered([{ kind: "skip", count: 5 }, { kind: "same", text: "a" }, { kind: "del", text: "b" }, { kind: "add", text: "c" }, { kind: "add", text: "d" }], { a: 40, b: 40 });
  assert.equal(headLine(rows), 46);
  assert.deepEqual(rows.map(rowNumber), [40, 45, 46, 46, 47]);
  assert.equal(headLine([{ kind: "same", text: "a" }]), null);
  assert.equal(unifiedText([rows]), "@@ 5 unchanged lines @@\n a\n-b\n+c\n+d");
});
