import { test } from "node:test";
import assert from "node:assert/strict";
import { stepsLine, stepsSummary, subNeighbours, subScreenSub } from "../src/logic/subagents.ts";
import type { Item, Subagent } from "../src/types.ts";

const tool = (name: string, input: object = {}): Item => ({ kind: "tool", toolId: `${name}${Math.random()}`, name, input, result: "ok" });
const sa = (id: string, extra: Partial<Subagent> = {}): Subagent => ({ id, tool: `t-${id}`, status: "completed", started: Number(id.replace(/\D/g, "")) || 0, ...extra });

test("stepsSummary counts every tool call and the reads, edited files and commands among them", () => {
  const items: Item[] = [
    { kind: "text", text: "Looking." },
    tool("Read", { file_path: "/a.go" }), tool("Read", { file_path: "/b.go" }), tool("Grep", { pattern: "x" }),
    tool("Edit", { file_path: "/a.go" }), tool("Edit", { file_path: "/a.go" }), tool("Write", { file_path: "/c.go" }),
    tool("Bash", { command: "go test" }),
  ];
  assert.deepEqual(stepsSummary(items), { steps: 7, reads: 2, edits: 2, runs: 1 });
  assert.deepEqual(stepsSummary(undefined), { steps: 0, reads: 0, edits: 0, runs: 0 });
});

test("stepsLine says the steps, then at most two of read, edited and ran that are not 0", () => {
  assert.equal(stepsLine(14, { reads: 8, edits: 0, runs: 0 }), "14 steps · read 8 files");
  assert.equal(stepsLine(1, { reads: 1, edits: 0, runs: 0 }), "1 step · read 1 file");
  assert.equal(stepsLine(9, { reads: 5, edits: 2, runs: 2 }), "9 steps · read 5 files · edited 2 files");
  assert.equal(stepsLine(5, { reads: 0, edits: 1, runs: 3 }), "5 steps · edited 1 file · ran 3 commands");
  assert.equal(stepsLine(3, { reads: 0, edits: 0, runs: 0 }), "3 steps");
});

test("subScreenSub: the position in the chat's order, then the state in words", () => {
  const subs = { s1: sa("s1"), s2: sa("s2", { status: "running", waiting: true }), s3: sa("s3", { parent: "s2", status: "running" }), s4: sa("s4", { status: "failed" }) };
  assert.deepEqual(subScreenSub(subs.s1, subs), { text: "Subagent 1 of 4 · Done", tone: "wait" });
  assert.deepEqual(subScreenSub(subs.s2, subs), { text: "Subagent 2 of 4 · Waiting on 1 subagent", tone: "wait" });
  assert.deepEqual(subScreenSub(subs.s3, subs), { text: "Subagent 3 of 4 · Running", tone: "ok" });
  assert.deepEqual(subScreenSub(subs.s4, subs), { text: "Subagent 4 of 4 · Failed", tone: "bad" });
  assert.equal(subScreenSub({ ...subs.s1, status: "stopped" }, subs).text, "Subagent 1 of 4 · Stopped");
});

test("subNeighbours goes through the tree without wrapping", () => {
  const subs = { s1: sa("s1"), s2: sa("s2"), s3: sa("s3", { parent: "s1" }) };
  // the tree order is s1, s3 (started by s1), s2
  assert.deepEqual(subNeighbours(subs.s1, subs), { prev: undefined, next: subs.s3 });
  assert.deepEqual(subNeighbours(subs.s3, subs), { prev: subs.s1, next: subs.s2 });
  assert.deepEqual(subNeighbours(subs.s2, subs), { prev: subs.s3, next: undefined });
  assert.deepEqual(subNeighbours(sa("zz"), subs), {});
});
