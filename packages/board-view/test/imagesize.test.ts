import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_PADDING, MAX_PIXELS, MAX_SIDE_PX, checkLimit, chooseElements, countElements, hasExtent, imageBounds, pictureSize, rootElements, withBoundText,
} from "../src/imagesize.ts";

const box = (id: string, x: number, y: number, width: number, height: number, more: Record<string, unknown> = {}) => ({ id, x, y, width, height, ...more });

test("imageBounds: the box of what is drawn, arrows by their points, rotated elements by their corners", () => {
  assert.equal(imageBounds([]), null);
  assert.deepEqual(imageBounds([box("a", 10, 20, 100, 50), box("b", -5, 0, 10, 10)]), { x: -5, y: 0, width: 115, height: 70 });
  assert.deepEqual(imageBounds([box("arrow", 100, 100, 0, 0, { points: [[0, 0], [50, -30]] })]), { x: 100, y: 70, width: 50, height: 30 });
  const turned = imageBounds([box("r", 0, 0, 100, 0, { angle: Math.PI / 2 })])!;
  assert.ok(Math.abs(turned.width) < 1e-9 && Math.abs(turned.height - 100) < 1e-9, `a line turned a quarter is as high as it was wide (${JSON.stringify(turned)})`);
});

test("hasExtent: what Excalidraw would drop has none", () => {
  assert.equal(hasExtent(box("a", 0, 0, 10, 10)), true);
  assert.equal(hasExtent(box("horizontal line", 0, 0, 10, 0)), true);
  assert.equal(hasExtent(box("vertical line", 0, 0, 0, 10)), true);
  assert.equal(hasExtent(box("a point", 5, 5, 0, 0)), false);
  assert.equal(hasExtent(box("arrow of one point", 0, 0, 0, 0, { points: [[0, 0]] })), false);
  assert.equal(hasExtent(box("arrow", 0, 0, 0, 0, { points: [[0, 0], [10, 0]] })), true);
});

test("rootElements: a child of a frame that is drawn adds nothing to the size", () => {
  const els = [box("f", 0, 0, 100, 100, { type: "frame" }), box("c", 10, 10, 500, 5, { frameId: "f" }), box("o", 200, 0, 10, 10), box("orphan", 0, 0, 1, 1, { frameId: "gone" })];
  assert.deepEqual(rootElements(els).map((e) => e.id), ["f", "o", "orphan"]);
});

test("withBoundText: the chosen elements and the text bound to them, in scene order, nothing else", () => {
  const scene = [box("a", 0, 0, 1, 1), box("ta", 0, 0, 1, 1, { containerId: "a" }), box("b", 0, 0, 1, 1), box("tb", 0, 0, 1, 1, { containerId: "b" }), box("c", 0, 0, 1, 1)];
  assert.deepEqual(withBoundText(scene, new Set(["b", "c"])).map((e) => e.id), ["b", "tb", "c"]);
  assert.deepEqual(withBoundText(scene, new Set()).map((e) => e.id), []);
  assert.equal(countElements(scene), 3, "bound text counts with its container");
});

test("chooseElements: the ids, all of them when there are none; deleted and extent-less elements are left out; nothing is EMPTY", () => {
  const scene = [box("a", 0, 0, 10, 10), box("ta", 1, 1, 5, 5, { containerId: "a" }), box("gone", 0, 0, 10, 10, { isDeleted: true }), box("dot", 0, 0, 0, 0), box("b", 20, 0, 10, 10)];
  const ids = (r: ReturnType<typeof chooseElements>) => (r.ok ? r.value.map((e) => e.id) : `${r.code}`);
  assert.deepEqual(ids(chooseElements(scene, [])), ["a", "ta", "b"], "no ids: everything that is alive and has an extent");
  assert.deepEqual(ids(chooseElements(scene, ["a"])), ["a", "ta"], "a container takes its text with it");
  assert.deepEqual(ids(chooseElements(scene, ["b", "a"])), ["a", "ta", "b"], "in scene order");
  assert.equal(ids(chooseElements(scene, ["gone"])), "EMPTY", "a deleted element is nothing");
  assert.equal(ids(chooseElements(scene, ["nope"])), "EMPTY");
  const none = chooseElements(scene, ["dot"]);
  assert.ok(!none.ok && none.code === "EMPTY" && /no extent/.test(none.message));
  assert.equal(ids(chooseElements([], [])), "EMPTY");
});

test("pictureSize: bounds and padding times scale, rounded up; the limits are the agent's", () => {
  const w = 100 + 2 * EXPORT_PADDING, h = 50 + 2 * EXPORT_PADDING;
  assert.deepEqual(pictureSize(w, h, 1), { ok: true, value: { width: 132, height: 82 } });
  assert.deepEqual(pictureSize(w, h, 1.5), { ok: true, value: { width: 198, height: 123 } });
  assert.deepEqual(pictureSize(10.2, 10.2, 1), { ok: true, value: { width: 11, height: 11 } });
  const tiny = pictureSize(100, 100, 0.001);
  assert.ok(!tiny.ok && tiny.code === "BAD_ARGS" && /smaller than 1 px/.test(tiny.message));
  const wide = pictureSize(MAX_SIDE_PX + 1, 10, 1);
  assert.ok(!wide.ok && wide.code === "TOO_LARGE" && /8193x10 px/.test(wide.message) && /8192 px on the longest side and 32 megapixels/.test(wide.message));
  assert.ok(pictureSize(MAX_SIDE_PX, 10, 1).ok, "exactly the limit is allowed");
  const area = pictureSize(7000, 5000, 1);
  assert.ok(!area.ok && area.code === "TOO_LARGE" && /35\.0 megapixels/.test(area.message));
  assert.equal(checkLimit({ width: 4000, height: MAX_PIXELS / 4000 }), null, "exactly the area is allowed");
});
