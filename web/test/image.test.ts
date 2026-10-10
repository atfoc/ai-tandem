import { test } from "node:test";
import assert from "node:assert/strict";
import { parseImageArgs, parseRect, parseRefs, defaultScope, insideRect, idsInsideRect, withBoundText, hasExtent, imageBounds, pixelSize, checkLimit, resultText, countElements, MAX_SIDE_PX, MAX_PIXELS, EXPORT_PADDING } from "../src/logic/image.ts";

const ok = (a: unknown) => { const p = parseImageArgs(a); assert.equal(p.ok, true, JSON.stringify(a)); return (p as any).value; };
const bad = (a: unknown) => { const p = parseImageArgs(a); assert.equal(p.ok, false, JSON.stringify(a)); assert.equal((p as any).code, "BAD_ARGS"); return (p as any).message as string; };

test("arguments: defaults, scale clamped to 2, scope kept as given", () => {
  assert.deepEqual(ok(undefined), { scope: undefined, scale: 1, background: true });
  assert.deepEqual(ok({}), { scope: undefined, scale: 1, background: true });
  assert.deepEqual(ok({ scope: "all", scale: 1.5, background: false }), { scope: "all", scale: 1.5, background: false });
  assert.equal(ok({ scale: 2 }).scale, 2);
  assert.equal(ok({ scale: 7 }).scale, 2);
  assert.equal(ok({ scale: 0.25 }).scale, 0.25);
  for (const scope of ["selection", "all", "refs", "rect"]) assert.equal(ok({ scope }).scope, scope);
  assert.deepEqual(ok({ scope: null, scale: null, background: null }), { scope: undefined, scale: 1, background: true });
});

test("arguments: a scale that is not a number above 0, a non-boolean background, an unknown scope are BAD_ARGS", () => {
  for (const scale of [0, -1, "2", NaN, Infinity, true, {}]) assert.match(bad({ scale }), /scale/, String(scale));
  assert.match(bad({ background: "yes" }), /background/);
  assert.match(bad({ background: 0 }), /background/);
  assert.match(bad({ scope: "page" }), /scope must be one of selection, all, refs, rect/);
  assert.match(bad({ scope: 3 }), /scope/);
});

test("bounds: boxes, arrows by their points, none for no elements", () => {
  assert.equal(imageBounds([]), null);
  assert.deepEqual(imageBounds([{ x: 10, y: 20, width: 100, height: 50 }, { x: -5, y: 0, width: 10, height: 10 }]), { x: -5, y: 0, width: 115, height: 70 });
  assert.deepEqual(imageBounds([{ x: 100, y: 100, width: 0, height: 0, points: [[0, 0], [50, -30], [80, 40]] }]), { x: 100, y: 70, width: 80, height: 70 });
});

test("pixel size: bounds and padding on both sides, times scale, rounded up", () => {
  const b = { x: 0, y: 0, width: 100, height: 50 };
  assert.deepEqual(pixelSize(b, 1), { width: 100 + 2 * EXPORT_PADDING, height: 50 + 2 * EXPORT_PADDING });
  assert.deepEqual(pixelSize(b, 2), { width: 2 * (100 + 2 * EXPORT_PADDING), height: 2 * (50 + 2 * EXPORT_PADDING) });
  assert.deepEqual(pixelSize({ x: 0, y: 0, width: 10.2, height: 10 }, 1.5, 0), { width: 16, height: 15 });
});

test("limit: a side over 8192 px or an area over 32 megapixels is TOO_LARGE, naming the size and the limit", () => {
  assert.equal(checkLimit({ width: MAX_SIDE_PX, height: 100 }), null);
  assert.equal(checkLimit({ width: 5600, height: 5600 }), null); // 31.4 MP
  const side = checkLimit({ width: MAX_SIDE_PX + 1, height: 10 })!;
  assert.equal(side.code, "TOO_LARGE");
  assert.match(side.message, /8193x10 px/);
  assert.match(side.message, /8192 px on the longest side and 32 megapixels/);
  assert.match(side.message, /smaller scope/);
  assert.match(side.message, /smaller scale/);
  assert.equal(MAX_PIXELS, 32_000_000);
  assert.equal(checkLimit({ width: 6000, height: 6000 })!.code, "TOO_LARGE");
  assert.match(checkLimit({ width: 6000, height: 6000 })!.message, /36\.0 megapixels/);
});

test("result text: one line with the scope, the bounds, the element count and the board", () => {
  assert.equal(resultText("all", { x: 10.4, y: -20.6, width: 300.2, height: 99.5 }, 3, "flows (b_1)"), "scope all, bounds x=10 y=-21 w=300 h=100 (board coordinates), 3 elements, flows (b_1)");
  assert.equal(resultText("selection", { x: 0, y: 0, width: 1, height: 1 }, 1, "a (b_2)"), "scope selection, bounds x=0 y=0 w=1 h=1 (board coordinates), 1 element, a (b_2)");
});

test("default scope: the selection only when the board is on screen and something is selected, else all; a given scope stays", () => {
  const table: [Parameters<typeof defaultScope>, string][] = [
    [[undefined, true, 2], "selection"],
    [[undefined, true, 0], "all"],
    [[undefined, false, 2], "all"],
    [[undefined, false, 0], "all"],
    [["all", true, 2], "all"],
    [["selection", false, 0], "selection"],
    [["refs", true, 2], "refs"],
    [["rect", false, 0], "rect"],
  ];
  for (const [args, want] of table) assert.equal(defaultScope(...args), want, JSON.stringify(args));
});

test("rect argument: finite numbers, width and height above 0, else BAD_ARGS", () => {
  assert.deepEqual(parseRect({ x: -5, y: 0, width: 10, height: 0.5, extra: 1 }), { ok: true, value: { x: -5, y: 0, width: 10, height: 0.5 } });
  for (const r of [undefined, null, "x", {}, { x: 0, y: 0, width: 10 }, { x: 0, y: 0, width: 0, height: 5 }, { x: 0, y: 0, width: 5, height: -1 },
    { x: NaN, y: 0, width: 5, height: 5 }, { x: 0, y: Infinity, width: 5, height: 5 }, { x: "0", y: 0, width: 5, height: 5 }, { x: 0, y: 0, width: 5, height: null }]) {
    const p = parseRect(r) as any;
    assert.equal(p.ok, false, JSON.stringify(r));
    assert.equal(p.code, "BAD_ARGS");
    assert.match(p.message, /rect/);
  }
});

test("refs argument: a non-empty list of {key} or {id}, else BAD_ARGS", () => {
  const refs = [{ key: "a" }, { id: "b_1" }];
  assert.deepEqual(parseRefs(refs), { ok: true, value: refs });
  for (const r of [undefined, null, [], "a", { key: "a" }, [{}], [{ key: "" }], [{ id: 3 }], [{ key: "a" }, null], ["a"]]) {
    const p = parseRefs(r) as any;
    assert.equal(p.ok, false, JSON.stringify(r));
    assert.equal(p.code, "BAD_ARGS");
  }
});

// the rect is x=100 y=100 w=200 h=100, so its edges are x 100..300 and y 100..200
const R = { x: 100, y: 100, width: 200, height: 100 };
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
test("rect containment: completely inside is in; sticking out on any side, or only touching from outside, is not", () => {
  const table: [string, any, boolean][] = [
    ["well inside", box(120, 120, 50, 50), true],
    ["exactly the rect", box(100, 100, 200, 100), true],
    ["flush with an edge, inside", box(100, 150, 50, 20), true],
    ["sticks out left", box(99, 120, 50, 50), false],
    ["sticks out right by 1", box(251, 120, 50, 50), false],
    ["sticks out top", box(120, 99, 50, 50), false],
    ["sticks out bottom", box(120, 151, 50, 50), false],
    ["touches the right edge from outside", box(300, 120, 50, 50), false],
    ["touches the left edge from outside", box(50, 120, 50, 50), false],
    ["touches the bottom edge from outside", box(120, 200, 50, 50), false],
    ["touches the corner from outside", box(300, 200, 10, 10), false],
    ["far away", box(1000, 1000, 5, 5), false],
    ["bigger than the rect", box(0, 0, 1000, 1000), false],
    ["arrow, every point inside", { ...box(110, 110, 0, 0), points: [[0, 0], [50, 20], [100, 60]] }, true],
    ["arrow, one point out right", { ...box(110, 110, 0, 0), points: [[0, 0], [50, 20], [200, 60]] }, false],
    ["arrow, one point out above", { ...box(110, 110, 0, 0), points: [[0, 0], [50, -20], [100, 60]] }, false],
    ["arrow, box inside but a point out (its width field lies)", { ...box(110, 110, 10, 10), points: [[0, 0], [300, 0]] }, false],
  ];
  for (const [what, e, want] of table) assert.equal(insideRect(e, R), want, what);
});

test("rect scope: ids inside, bound text follows its container and is not tested alone", () => {
  const scene = [
    { id: "in", ...box(120, 120, 50, 50) },
    { id: "label", ...box(10, 10, 5, 5), containerId: "in" },       // far away, but bound to one inside
    { id: "out", ...box(250, 120, 100, 50) },
    { id: "outLabel", ...box(120, 120, 5, 5), containerId: "out" }, // inside the rect, bound to one outside
  ];
  assert.deepEqual([...idsInsideRect(scene, R)], ["in"]);
  assert.deepEqual(withBoundText(scene, idsInsideRect(scene, R)).map((e) => e.id), ["in", "label"]);
});

test("bound text: added for chosen containers (shapes and arrows) in scene order, nothing else", () => {
  const scene = [
    { id: "a", ...box(0, 0, 10, 10) },
    { id: "ta", ...box(0, 0, 5, 5), containerId: "a" },
    { id: "arrow", ...box(0, 0, 10, 10), points: [[0, 0], [10, 10]] },
    { id: "tarrow", ...box(0, 0, 5, 5), containerId: "arrow" },
    { id: "b", ...box(50, 0, 10, 10) },           // bound to by the arrow, not chosen: not added
    { id: "frame", ...box(0, 0, 100, 100) },
    { id: "child", ...box(1, 1, 5, 5), frameId: "frame" },
    { id: "loose", ...box(0, 0, 5, 5), containerId: "b" },
  ];
  assert.deepEqual(withBoundText(scene, new Set(["arrow", "a"])).map((e) => e.id), ["a", "ta", "arrow", "tarrow"]);
  assert.deepEqual(withBoundText(scene, new Set(["frame"])).map((e) => e.id), ["frame"]); // a frame's children are not added
  assert.deepEqual(withBoundText(scene, new Set(["loose"])).map((e) => e.id), ["loose"]); // a label chosen on its own stays
  assert.deepEqual(withBoundText(scene, new Set()), []);
});

test("count: bound text is not counted on its own", () => {
  assert.equal(countElements([{}, { containerId: "a" }, { containerId: null }, { containerId: undefined }]), 3);
});

test("rotated elements: bounds, pixel estimate and containment use the rotated box", () => {
  const deg = (d: number) => (d * Math.PI) / 180;
  const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} != ${b}`);
  // a 200x100 rectangle turned 45 degrees: (200+100)/sqrt(2) = 212.13 on both sides, around the same centre
  const r = { x: 100, y: 50, width: 200, height: 100, angle: deg(45) };
  const b = imageBounds([r])!;
  near(b.width, 300 / Math.SQRT2, "width"); near(b.height, 300 / Math.SQRT2, "height");
  near(b.x + b.width / 2, 200, "centre x"); near(b.y + b.height / 2, 100, "centre y");
  // Chrome exports it at 244x244 with the 16 padding on both sides; the unrotated estimate was 232x132
  const px = pixelSize(b, 1);
  assert.ok(Math.abs(px.width - 244) <= 1 && Math.abs(px.height - 244) <= 1, JSON.stringify(px));
  const bare = pixelSize(b, 1, 0);
  assert.ok(Math.abs(bare.width - 212) <= 1 && Math.abs(bare.height - 212) <= 1, JSON.stringify(bare));
  // a quarter turn swaps the sides; no angle or angle 0 changes nothing
  const q = imageBounds([{ ...r, angle: deg(90) }])!;
  near(q.width, 100, "quarter width"); near(q.height, 200, "quarter height");
  assert.deepEqual(imageBounds([{ ...r, angle: 0 }]), { x: 100, y: 50, width: 200, height: 100 });
  assert.deepEqual(imageBounds([{ ...r, angle: undefined }]), { x: 100, y: 50, width: 200, height: 100 });
  // an arrow turns by its points around the centre of their box
  const a = imageBounds([{ x: 0, y: 0, width: 100, height: 0, points: [[0, 0], [100, 0]], angle: deg(90) }])!;
  near(a.width, 0, "arrow width"); near(a.height, 100, "arrow height"); near(a.x, 50, "arrow x"); near(a.y, -50, "arrow y");
  // containment follows the rotated box: the unrotated one fits in this rect, the rotated one sticks out
  const fits = { x: 90, y: 40, width: 220, height: 120 };
  assert.equal(insideRect({ ...r, angle: 0 }, fits), true);
  assert.equal(insideRect(r, fits), false);
  assert.equal(insideRect(r, { x: 80, y: -10, width: 240, height: 220 }), true);
});

test("rotated text, ellipse and diamond: the rotated box, never smaller than Excalidraw's own picture", () => {
  const deg = (d: number) => (d * Math.PI) / 180;
  // text is a box like any other: 60x20 turned 30 degrees is 60cos30+20sin30 by 60sin30+20cos30
  const t = imageBounds([{ x: 100, y: 50, width: 60, height: 20, angle: deg(30) }])!;
  assert.ok(Math.abs(t.width - (60 * Math.cos(deg(30)) + 20 * Math.sin(deg(30)))) < 1e-6, String(t.width));
  assert.ok(Math.abs(t.height - (60 * Math.sin(deg(30)) + 20 * Math.cos(deg(30)))) < 1e-6, String(t.height));
  assert.ok(Math.abs(t.x + t.width / 2 - 130) < 1e-6 && Math.abs(t.y + t.height / 2 - 60) < 1e-6);
  const q = imageBounds([{ x: 100, y: 50, width: 60, height: 20, angle: deg(90) }])!;
  assert.ok(Math.abs(q.width - 20) < 1e-6 && Math.abs(q.height - 60) < 1e-6);
  // an ellipse and a diamond are judged by their rotated rectangle, which is larger than the shape that is drawn:
  // Chrome with Excalidraw 0.18.1 draws 200x100 at 45deg as 190x190 and at 30deg (diamond) as 205x132, padding included
  const ell = pixelSize(imageBounds([{ x: 100, y: 50, width: 200, height: 100, angle: deg(45) }])!, 1);
  assert.ok(ell.width >= 190 && ell.height >= 190, JSON.stringify(ell));
  const dia = pixelSize(imageBounds([{ x: 100, y: 50, width: 200, height: 100, angle: deg(30) }])!, 1);
  assert.ok(dia.width >= 205 && dia.height >= 132, JSON.stringify(dia));
});

test("hasExtent: what Excalidraw drops before it sizes the picture has none; a straight line has", () => {
  const box = (w: number, h: number, o = {}) => ({ x: 10, y: 10, width: w, height: h, ...o });
  assert.equal(hasExtent(box(0, 0)), false);
  assert.equal(hasExtent(box(0, 0, { angle: 1 })), false);
  assert.equal(hasExtent(box(50, 50)), true);
  assert.equal(hasExtent(box(0, 50)), true); // a vertical extent only
  assert.equal(hasExtent(box(50, 0)), true);
  assert.equal(hasExtent(box(-50, -20)), true); // dragged up and left
  // lines: horizontal and vertical are drawn, and so is a dot of two points close together
  assert.equal(hasExtent(box(200, 0, { points: [[0, 0], [200, 0]] })), true);
  assert.equal(hasExtent(box(0, 200, { points: [[0, 0], [0, 200]], angle: Math.PI / 2 })), true);
  assert.equal(hasExtent(box(0.1, 0.1, { points: [[0, 0], [0.1, 0.1]] })), true);
  // fewer than two points, or two equal points, draw nothing
  assert.equal(hasExtent(box(0, 0, { points: [] })), false);
  assert.equal(hasExtent(box(0, 0, { points: [[0, 0]] })), false);
  assert.equal(hasExtent(box(0, 0, { points: [[0, 0], [0, 0]] })), false);
});
