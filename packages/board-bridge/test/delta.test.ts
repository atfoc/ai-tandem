import { test } from "node:test";
import assert from "node:assert/strict";
import type { El, FromBoard } from "../src/messages.ts";
import { applyDelta, createBaseline, filesAdded } from "../src/delta.ts";
import { validateFromBoard } from "../src/validate.ts";

const el = (id: string, version = 1, more: Record<string, unknown> = {}): El => ({ id, type: "rectangle", x: 0, y: 0, version, isDeleted: false, ...more });
const ids = (els: readonly El[]) => els.map((e) => e.id);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

test("a baseline of the scene it was made from differs from nothing", () => {
  const scene = [el("a"), el("b", 3)];
  assert.equal(createBaseline(scene).diff(scene), null);
  assert.equal(createBaseline().diff([]), null);
});

test("the delta holds the elements whose version differs, new and deleted ones among them, and no order while the ids stand", () => {
  const base = [el("a"), el("b"), el("c")];
  const b = createBaseline(base);
  const now = [el("a"), el("b", 2, { x: 9 }), el("c", 2, { isDeleted: true })];
  assert.deepEqual(b.diff(now), { elements: [now[1], now[2]] });
});

test("a new id brings the order; so does a move; so does an id that is gone", () => {
  const b = createBaseline([el("a"), el("b")]);
  assert.deepEqual(b.diff([el("a"), el("b"), el("n")]), { elements: [el("n")], order: ["a", "b", "n"] });
  assert.deepEqual(b.diff([el("b"), el("a")]), { elements: [], order: ["b", "a"] });
  assert.deepEqual(b.diff([el("a")]), { elements: [], order: ["a"] });
});

test("set makes the scene the baseline", () => {
  const b = createBaseline([el("a")]);
  const next = [el("a", 2), el("b")];
  assert.ok(b.diff(next));
  b.set(next);
  assert.equal(b.diff(next), null);
});

test("applyDelta replaces by id, appends new ids, and follows `order`", () => {
  const prev = [el("a"), el("b"), el("c")];
  assert.deepEqual(applyDelta(prev, { elements: [el("b", 2)] }).map((e) => e.version), [1, 2, 1]);
  assert.deepEqual(ids(applyDelta(prev, { elements: [el("n")] })), ["a", "b", "c", "n"]);
  assert.deepEqual(ids(applyDelta(prev, { elements: [el("n")], order: ["n", "c", "a", "b"] })), ["n", "c", "a", "b"]);
  assert.deepEqual(ids(applyDelta(prev, { elements: [], order: ["a", "c"] })), ["a", "c"], "an id order no longer names is dropped");
  assert.deepEqual(ids(applyDelta(prev, { elements: [], order: ["a", "zz", "c"] })), ["a", "c"], "an id nobody has is left out");
  assert.deepEqual(prev.map((e) => e.version), [1, 1, 1], "the mirror it was given is not changed");
});

test("filesAdded: the files the view has not told", () => {
  const files = { f1: { id: "f1" }, f2: { id: "f2" } };
  assert.deepEqual(filesAdded(files, new Set(["f1"])), { f2: { id: "f2" } });
  assert.deepEqual(filesAdded(files, new Set(["f1", "f2"])), {});
});

// The view's side and the app's side, over JSON, as a drawing goes: load, then a `changed` after each step. The mirror equals the
// view's own scene after every one.
test("a mirror fed with load and the `changed` of a scripted drawing equals the scene", () => {
  let scene: El[] = [el("r1"), el("r2"), el("r3")];                 // the view's scene (what Excalidraw has)
  const files: Record<string, Record<string, unknown>> = { f0: { id: "f0" } };
  const baseline = createBaseline(scene);
  const told = new Set(Object.keys(files));
  let mirror = clone(scene);                                        // the app's copy, from `load`
  const mirrorFiles = clone(files);
  let sent = 0, bytes = 0;

  const step = (what: string, change: () => void) => {
    change();
    const d = baseline.diff(scene), added = filesAdded(files, told);
    if (!d && !Object.keys(added).length) return; // nothing to tell
    const m: FromBoard = {
      t: "changed", board: "b", elements: d?.elements ?? [], ...(d?.order ? { order: d.order } : {}),
      ...(Object.keys(added).length ? { files: added as never } : {}), appState: {}, style: {},
    };
    const wire = JSON.parse(JSON.stringify(m)); // what crosses the web view
    const v = validateFromBoard(wire);
    assert.ok(v.ok, `${what}: ${v.ok ? "" : v.error}`);
    baseline.set(scene); for (const k of Object.keys(files)) told.add(k);
    const got = v.value as Extract<FromBoard, { t: "changed" }>;
    mirror = applyDelta(mirror, got);
    Object.assign(mirrorFiles, got.files);
    sent++; bytes += JSON.stringify(wire).length;
    assert.deepEqual(mirror, clone(scene), `${what}: the mirror is the scene`);
    assert.deepEqual(mirrorFiles, files, `${what}: the mirror has the files`);
  };

  step("draw a rectangle", () => { scene = [...scene, el("n1", 1, { x: 40 })]; });
  step("move it", () => { scene = scene.map((e) => (e.id === "n1" ? { ...e, x: 80, version: 2 } : e)); });
  step("draw many strokes", () => { for (let i = 0; i < 20; i++) scene = [...scene, el(`s${i}`, 1, { points: [[0, 0], [i, i]] })]; });
  step("a picture is added", () => { files.f1 = { id: "f1", dataURL: "data:image/png;base64,AAAA" }; scene = [...scene, el("img", 1, { type: "image", fileId: "f1" })]; });
  step("delete one (Excalidraw keeps it)", () => { scene = scene.map((e) => (e.id === "r2" ? { ...e, isDeleted: true, version: 2 } : e)); });
  step("bring one to the front", () => { const r1 = scene.find((e) => e.id === "r1")!; scene = [...scene.filter((e) => e !== r1), { ...r1, version: 2 }]; });
  step("send one to the back (several versions change)", () => { scene = [{ ...scene.at(-1)!, version: 3 }, ...scene.slice(0, -1)]; });
  step("an id leaves the scene", () => { scene = scene.filter((e) => e.id !== "s3"); });
  step("nothing changed", () => { scene = [...scene]; });
  step("a second picture, the first one stays", () => { files.f2 = { id: "f2", dataURL: "data:image/png;base64,BBBB" }; scene = [...scene, el("img2", 1, { type: "image", fileId: "f2" })]; });

  assert.equal(sent, 9, "nine changes were told, the tenth step changed nothing");
  assert.deepEqual(ids(mirror), ids(scene));
  assert.ok(bytes < JSON.stringify({ elements: scene, files }).length * sent, "a delta is smaller than the whole scene");
});
