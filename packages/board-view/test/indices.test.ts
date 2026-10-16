// validIndices (src/indices.ts): the run of elements whose fractional index is missing or not above the one before gets indices
// between its neighbours; valid indices are left alone, and only invalid elements reach `withIndex`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validIndices } from "../src/indices.ts";

type E = { id: string; index?: string | null; version: number };
const els = (...ix: (string | null | undefined)[]): E[] => ix.map((index, n) => ({ id: `e${n}`, index, version: 1 }));
const run = (list: E[]) => {
  const touched: string[] = [];
  const out = validIndices(list, (e, index) => { touched.push(e.id); return { ...e, index, version: e.version + 1 }; });
  return { out, touched };
};
const increasing = (list: E[]) => list.every((e, n) => typeof e.index === "string" && (n === 0 || e.index! > list[n - 1].index!));

test("valid indices are untouched", () => {
  const list = els("a0", "a1", "a2", "b00");
  const { out, touched } = run(list);
  assert.deepEqual(touched, []);
  assert.deepEqual(out, list);
  assert.deepEqual(run([]).out, []);
});

test("a trailing run after a valid one becomes strictly increasing above it", () => {
  const { out, touched } = run(els("a0", "a1", "a0", "a1"));
  assert.deepEqual(touched, ["e2", "e3"]);
  assert.ok(increasing(out));
  assert.deepEqual(out.slice(0, 2).map((e) => e.index), ["a0", "a1"]);
  assert.deepEqual(out.map((e) => e.version), [1, 1, 2, 2]);
});

test("a run in the middle goes between its neighbours", () => {
  const { out, touched } = run(els("a0", "a5", "a1", "a9", "b1"));
  assert.deepEqual(touched, ["e2"]);
  assert.ok(increasing(out), JSON.stringify(out.map((e) => e.index)));
  assert.deepEqual([out[0].index, out[1].index, out[3].index, out[4].index], ["a0", "a5", "a9", "b1"]);
});

test("a run in the middle: the next valid index is the upper bound", () => {
  const { out, touched } = run(els("a0", "a1", null, undefined, "a2"));
  assert.deepEqual(touched, ["e2", "e3"]);
  assert.ok(increasing(out));
  assert.ok(out[2].index! > "a1" && out[3].index! < "a2");
  assert.deepEqual([out[0].index, out[1].index, out[4].index], ["a0", "a1", "a2"]);
});

test("all null (or missing) become strictly increasing", () => {
  const { out, touched } = run(els(null, undefined, null));
  assert.deepEqual(touched, ["e0", "e1", "e2"]);
  assert.ok(increasing(out));
});

test("an upper bound that is not above the lower one is not used", () => {
  const { out, touched } = run(els("a3", "a1", "a2", "a0"));
  assert.deepEqual(touched, ["e1", "e2", "e3"]);
  assert.ok(increasing(out));
  assert.equal(out[0].index, "a3");
});

test("the input list and its elements are not changed", () => {
  const list = els("a0", "a0", null);
  const copy = JSON.parse(JSON.stringify(list));
  run(list);
  assert.deepEqual(list, copy);
});
