import { test } from "node:test";
import assert from "node:assert/strict";
import { ENGINE_OPS } from "../src/messages.ts";
import type { ApplyValue, EngineValues, ExportValue, SnapshotValue } from "../src/messages.ts";
import {
  parseFromBoard, validateApplyValue, validateDeleteValue, validateEngineValue, validateExportValue, validateFromBoard,
  validateRestoreValue, validateSnapshotValue,
} from "../src/validate.ts";

// ---- one valid value of every request (typed, so the validators and the types are held to each other)

const rect = { id: "r1", type: "rectangle", version: 3, x: 0, y: 0, width: 100, height: 50, isDeleted: false };
const gone = { id: "r2", type: "rectangle", version: 4, x: 0, y: 0, width: 10, height: 10, isDeleted: true };
const files = { f1: { id: "f1", mimeType: "image/png", dataURL: "data:image/png;base64,AAAA", created: 1 } };

const apply: ApplyValue = {
  created: { a: "id-a", "#1": "id-b" },
  updated: ["r1"],
  deleted: ["r2"],
  conflicts: [{ ref: { key: "k" }, expectedVersion: 2, actualVersion: 5 }, { ref: { id: "r9" }, expectedVersion: 1 }],
  rev: 4,
};
const exported: ExportValue = { png: "iVBORw0KGgo=", width: 232, height: 182, bounds: { x: -3.5, y: 10, width: 200, height: 150 }, count: 2 };
const snapshot: SnapshotValue = {
  board: "b1", elements: [rect, gone], files,
  appState: { scrollX: -20, scrollY: 12.5, zoom: { value: 1.5 }, viewBackgroundColor: "#ffffff" },
  style: { currentItemStrokeColor: "#1e1e1e", currentItemFontFamily: 6, currentItemStartArrowhead: null },
};
const values = {
  apply,
  delete: { ...apply, elements: [rect, gone] },
  restore: { elements: [rect] },
  export: exported,
  snapshot,
} satisfies EngineValues;

const ok = (r: { ok: boolean }, what: string) => assert.equal(r.ok, true, `${what}: ${(r as { error?: string }).error}`);
const bad = (r: { ok: boolean }, what: string) => assert.equal(r.ok, false, `${what} was accepted`);
const copy = <T>(v: T): T => structuredClone(v);

test("every request has a value sample", () => {
  assert.deepEqual(Object.keys(values).sort(), [...ENGINE_OPS].sort());
});

for (const [op, value] of Object.entries(values)) {
  test(`value of "${op}": accepted, and the same after a round trip through JSON, also inside a res`, () => {
    ok(validateEngineValue(op as keyof EngineValues, value), "the sample");
    const back = JSON.parse(JSON.stringify(value));
    assert.deepEqual(back, value);
    ok(validateEngineValue(op as keyof EngineValues, back), "after JSON");
    const res = parseFromBoard(JSON.stringify({ t: "res", id: 3, ok: true, value }));
    ok(res, "inside a res");
  });

  test(`value of "${op}": a key missing, an unknown key, a wrong kind of value are rejected`, () => {
    const required = Object.keys(value).filter((k) => !(op === "delete" && k === "elements") && !(op === "apply" && k === "elements"));
    for (const k of required) {
      const without = copy(value) as Record<string, unknown>;
      delete without[k];
      bad(validateEngineValue(op as keyof EngineValues, without), `${op} without ${k}`);
      const wrong = copy(value) as Record<string, unknown>;
      wrong[k] = Symbol.for("not json");
      bad(validateEngineValue(op as keyof EngineValues, wrong), `${op} with ${k} a symbol`);
    }
    const extra = copy(value) as Record<string, unknown>;
    extra.url = "https://example.com";
    bad(validateEngineValue(op as keyof EngineValues, extra), `${op} with an extra key`);
    for (const v of [null, undefined, "x", 1, [], () => 1]) bad(validateEngineValue(op as keyof EngineValues, v), `${op} as ${String(v)}`);
  });
}

test("the named validators are the validator by op", () => {
  ok(validateApplyValue(values.apply), "apply");
  ok(validateDeleteValue(values.delete), "delete");
  ok(validateRestoreValue(values.restore), "restore");
  ok(validateExportValue(values.export), "export");
  ok(validateSnapshotValue(values.snapshot), "snapshot");
  bad(validateExportValue(values.snapshot), "a snapshot as an export");
  bad(validateSnapshotValue(values.export), "an export as a snapshot");
  bad(validateEngineValue("fetch" as keyof EngineValues, {}), "an unknown request");
  bad(validateEngineValue("constructor" as keyof EngineValues, {}), "a request named like an Object member");
});

test("export: the picture and its numbers", () => {
  ok(validateExportValue({ ...exported, bounds: { x: 0, y: 0, width: 0, height: 0 } }), "an empty box (a vertical line has width 0)");
  for (const [what, v] of [
    ["an empty png", { ...exported, png: "" }],
    ["a png that is a number", { ...exported, png: 7 }],
    ["a width of 0", { ...exported, width: 0 }],
    ["a negative height", { ...exported, height: -1 }],
    ["a width that is not finite", { ...exported, width: Infinity }],
    ["bounds with a negative width", { ...exported, bounds: { ...exported.bounds, width: -1 } }],
    ["bounds with NaN", { ...exported, bounds: { ...exported.bounds, x: NaN } }],
    ["bounds with an extra key", { ...exported, bounds: { ...exported.bounds, z: 1 } }],
    ["a count of 1.5", { ...exported, count: 1.5 }],
    ["a negative count", { ...exported, count: -1 }],
  ] as [string, unknown][]) bad(validateExportValue(v), what);
  const r = validateExportValue({ ...exported, width: 0 });
  assert.equal(!r.ok && r.error, "value.width: not a number above 0");
});

test("snapshot: the scene, limited to what a board file keeps", () => {
  ok(validateSnapshotValue({ ...snapshot, elements: [], files: {}, appState: {}, style: {} }), "an empty scene");
  for (const [what, v] of [
    ["an appState with a key a board file does not keep", { ...snapshot, appState: { ...snapshot.appState, selectedElementIds: { r1: true } } }],
    ["an appState with a zoom of 0", { ...snapshot, appState: { zoom: { value: 0 } } }],
    ["an element with no id", { ...snapshot, elements: [{ version: 1 }] }],
    ["a file that is not an object", { ...snapshot, files: { f1: "data" } }],
    ["a style key that is not a currentItem", { ...snapshot, style: { theme: "dark" } }],
    ["an empty board", { ...snapshot, board: "" }],
    ["no board", { ...snapshot, board: undefined }],
    ["a function in an element", { ...snapshot, elements: [{ id: "a", version: 1, f() {} }] }],
  ] as [string, unknown][]) bad(validateSnapshotValue(v), what);
});

test("apply and delete: the result of applyChanges, and the scene only when the target was given elements", () => {
  ok(validateApplyValue({ created: {}, updated: [], deleted: [], conflicts: [], rev: 0 }), "nothing happened");
  for (const [what, v] of [
    ["created with a value that is not an id", { ...apply, created: { a: 1 } }],
    ["created that is a list", { ...apply, created: ["a"] }],
    ["updated with a number", { ...apply, updated: [1] }],
    ["a conflict with no expected version", { ...apply, conflicts: [{ ref: { id: "a" } }] }],
    ["a conflict with a ref of two keys", { ...apply, conflicts: [{ ref: { id: "a", key: "b" }, expectedVersion: 1 }] }],
    ["a rev of -1", { ...apply, rev: -1 }],
    ["elements that are not elements", { ...apply, elements: [{ id: "a" }] }],
  ] as [string, unknown][]) bad(validateApplyValue(v), what);
});

test("a res of the view still carries any JSON as its value: the values are checked by the op, not by res", () => {
  ok(validateFromBoard({ t: "res", id: 1, ok: true, value: { anything: [1] } }), "res with a loose value");
  bad(validateExportValue({ anything: [1] }), "the same value as an export");
});
