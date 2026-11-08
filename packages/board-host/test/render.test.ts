// get_image on a new board (package H3, render.ts): scopes, the size and its cap (decision O4), the frame drawn with what it
// holds, and every refusal. Boards are built with createShapes/createBindings directly.
// (first: the page before any tldraw module, as in src/bin.ts)
import "../src/node/install-page.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Canvas, loadImage } from "skia-canvas";
import { b64Vecs } from "@tldraw/tlschema";
import { createShapeId, toRichText, type Editor, type TLShapeId } from "tldraw";
import { loadRuntime } from "../src/node/runtime.ts";
import { ToolError } from "../src/agent.ts";
import { getImage, MAX_PICTURE_SIDE, PICTURE_PADDING } from "../src/render.ts";
import { STICKY_TYPE } from "../src/schema.ts";

const BOARD = { id: "b1", name: "Plan" };
const rt = await loadRuntime();
const editors: Editor[] = [];
after(() => { for (const e of editors) e.dispose(); });
function newEditor(): Editor {
  const e = rt.createEditor();
  editors.push(e);
  return e;
}

const ids = {
  sticky: createShapeId("sticky"), geo: createShapeId("geo"), text: createShapeId("text"), arrow: createShapeId("arrow"),
  frame: createShapeId("frame"), childA: createShapeId("childA"), childB: createShapeId("childB"), draw: createShapeId("draw"),
};

/** One element of each type: sticky, geo with text, text, an arrow bound to two shapes, a frame holding two shapes, a pen stroke. */
function fullBoard(editor: Editor) {
  editor.run(() => {
    editor.createShapes([
      { id: ids.sticky, type: STICKY_TYPE, x: 0, y: 0, meta: { key: "s1" }, props: { richText: toRichText("A sticky") } } as any,
      { id: ids.geo, type: "geo", x: 300, y: 0, meta: { key: "g1" }, props: { geo: "rectangle", w: 200, h: 100, richText: toRichText("A labelled box") } },
      { id: ids.text, type: "text", x: 0, y: 260, props: { richText: toRichText("Free text") } },
      { id: ids.arrow, type: "arrow", x: 0, y: 0, props: { start: { x: 100, y: 100 }, end: { x: 400, y: 50 } } },
      { id: ids.frame, type: "frame", x: 600, y: 0, meta: { key: "f1" }, props: { w: 300, h: 250, name: "Frame" } },
      { id: ids.childA, type: "geo", parentId: ids.frame, x: 40, y: 60, props: { geo: "rectangle", w: 80, h: 80, color: "red", fill: "fill", fillColor: "red" } },
      { id: ids.childB, type: "geo", parentId: ids.frame, x: 180, y: 60, props: { geo: "ellipse", w: 80, h: 80, color: "blue", fill: "fill", fillColor: "blue" } },
      {
        id: ids.draw, type: "draw", x: 0, y: 400,
        props: { isPen: true, isComplete: true, segments: [{ type: "free", path: b64Vecs.encodePoints([{ x: 0, y: 0, z: 0.5 }, { x: 60, y: 40, z: 0.5 }, { x: 120, y: 0, z: 0.5 }, { x: 200, y: 50, z: 0.5 }]) }] },
      },
    ]);
    const end = (terminal: "start" | "end", toId: TLShapeId) => ({
      type: "arrow" as const, fromId: ids.arrow, toId,
      props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
    });
    editor.createBindings([end("start", ids.sticky), end("end", ids.geo)] as any);
  });
}

function pngSize(png: Buffer) {
  assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

async function pixels(b64: string) {
  const img = await loadImage(Buffer.from(b64, "base64"));
  const c = new Canvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  const at = (x: number, y: number) => { const i = (Math.round(y) * img.width + Math.round(x)) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
  const bg = at(0, 0);
  const diff = (p: number[]) => Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) + Math.abs(p[3] - bg[3]);
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) if (diff([data[i], data[i + 1], data[i + 2], data[i + 3]]) > 48) ink++;
  return { width: img.width, height: img.height, at, bg, inked: (x: number, y: number) => diff(at(x, y)) > 48, share: ink / (img.width * img.height) };
}

/** The bounds the text names. */
function textBounds(text: string) {
  const m = /bounds x=(-?\d+) y=(-?\d+) w=(\d+) h=(\d+)/.exec(text);
  assert.ok(m, text);
  return { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
}

async function refusal(p: Promise<unknown>, code: string, message?: string | RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof ToolError, String(e));
    assert.equal(e.code, code, e.message);
    if (typeof message === "string") assert.equal(e.message, message);
    else if (message) assert.match(e.message, message);
    return true;
  });
}

const editor = newEditor();
fullBoard(editor);

test("scope all: every element, the size (bounds + 2 × 32) × scale rounded, something drawn", async () => {
  const t0 = performance.now();
  const r = await getImage(editor, {}, BOARD);
  const cold = performance.now() - t0;
  assert.equal(r.image.mimeType, "image/png");
  const b = editor.getCurrentPageBounds()!;
  assert.equal(r.text, `scope all, bounds x=${Math.round(b.x)} y=${Math.round(b.y)} w=${Math.round(b.w)} h=${Math.round(b.h)} (board coordinates), 8 elements, "Plan" (b1)`);
  // export.ts promises round((bounds + 2 × padding) × scale), with the bounds passed exactly
  assert.deepEqual(pngSize(Buffer.from(r.image.data, "base64")), { width: Math.round(b.w + 2 * PICTURE_PADDING), height: Math.round(b.h + 2 * PICTURE_PADDING) });
  const px = await pixels(r.image.data);
  assert.ok(px.share > 0.03, `only ${(px.share * 100).toFixed(2)}% drawn`);
  assert.equal(px.bg[3], 255, "the background is opaque");
  // the red child of the frame, at its page place (680, 100) + the padding - the bounds' origin
  assert.ok(px.inked(680 - b.x + 32, 100 - b.y + 32));

  const t1 = performance.now();
  const r2 = await getImage(editor, { scale: 2 }, BOARD);
  const warm = performance.now() - t1;
  assert.deepEqual(pngSize(Buffer.from(r2.image.data, "base64")), { width: Math.round((b.w + 64) * 2), height: Math.round((b.h + 64) * 2) });
  assert.doesNotMatch(r2.text, /drawn at scale/, "scale 2 on a small board is honoured");
  console.log(`# small board (${Math.round(b.w)}×${Math.round(b.h)}): first ${cold.toFixed(0)} ms, warm at scale 2 ${warm.toFixed(0)} ms`);

  const t2 = performance.now();
  await getImage(editor, {}, BOARD);
  console.log(`# small board warm at scale 1: ${(performance.now() - t2).toFixed(0)} ms`);
});

test("background false: the corners are transparent", async () => {
  const r = await getImage(editor, { background: false, scale: 0.5 }, BOARD);
  const px = await pixels(r.image.data);
  for (const [x, y] of [[0, 0], [px.width - 1, 0], [0, px.height - 1], [px.width - 1, px.height - 1]]) assert.equal(px.at(x, y)[3], 0, `corner ${x},${y}`);
  assert.ok(px.share > 0.03);
});

test("scope refs of a frame: the frame and what it holds", async () => {
  const r = await getImage(editor, { scope: "refs", refs: [{ id: ids.frame }] }, BOARD);
  const fb = editor.getShapePageBounds(ids.frame)!;
  assert.deepEqual(textBounds(r.text), { x: 600, y: 0, w: 300, h: 250 });
  assert.match(r.text, /, 3 elements, /);
  const px = await pixels(r.image.data);
  assert.equal(px.width, Math.round(fb.w + 64));
  assert.equal(px.height, Math.round(fb.h + 64));
  // the picture's background is the canvas's, not the frame's fill (tldraw's lone-frame export is not used), with padding
  assert.ok(!px.inked(5, 5));
  // the children: the red square at frame (40..120, 60..140), the blue circle at (180..260, 60..140)
  const red = px.at(32 + 80, 32 + 100), blue = px.at(32 + 220, 32 + 100);
  assert.ok(red[0] > 150 && red[2] < 120, `red child: ${red}`);
  assert.ok(blue[2] > 150 && blue[0] < 120, `blue child: ${blue}`);
  // the frame's own outline is drawn (its left edge at x = 32)
  assert.ok([31, 32, 33].some((x) => px.inked(x, 32 + 200)), "the frame's border");
});

test("scope refs by key, and by an id without its prefix", async () => {
  const r = await getImage(editor, { scope: "refs", refs: [{ key: "s1" }, { key: "g1" }] }, BOARD);
  assert.deepEqual(textBounds(r.text), { x: 0, y: 0, w: 500, h: 200 });
  assert.match(r.text, /^scope refs, .*, 2 elements, "Plan" \(b1\)$/);
  const r2 = await getImage(editor, { scope: "refs", refs: [{ id: "geo" }] }, BOARD);
  assert.match(r2.text, /bounds x=300 y=0 w=200 h=100 .*, 1 element, /);
});

test("scope rect: only what lies completely inside (a frame's child by its own bounds)", async () => {
  // the sticky (0..200) and the geo (300..500); the arrow between them too; not the text (y 260) nor the frame
  const r = await getImage(editor, { scope: "rect", rect: { x: -10, y: -10, width: 520, height: 230 } }, BOARD);
  assert.match(r.text, /, 3 elements, /);
  assert.deepEqual(textBounds(r.text), { x: 0, y: 0, w: 500, h: 200 });
  // the red child alone, its frame not completely inside
  const r2 = await getImage(editor, { scope: "rect", rect: { x: 630, y: 50, width: 100, height: 100 } }, BOARD);
  assert.match(r2.text, /bounds x=640 y=60 w=80 h=80 .*, 1 element, /);
});

test("the cap: a board 5000 px wide is drawn 2000 px wide, and the text names the scale", async () => {
  const e = newEditor();
  e.createShapes([
    { type: "geo", x: 0, y: 0, props: { w: 200, h: 200, fill: "solid" } },
    { type: "geo", x: 4800, y: 300, props: { w: 200, h: 200, fill: "solid" } },
  ]);
  const t0 = performance.now();
  const r = await getImage(e, { scale: 2 }, BOARD);
  const ms = performance.now() - t0;
  const { width, height } = pngSize(Buffer.from(r.image.data, "base64"));
  assert.ok(Math.abs(width - MAX_PICTURE_SIDE) <= 1, `width ${width}`);
  const s = MAX_PICTURE_SIDE / 5064;
  assert.ok(Math.abs(height - 564 * s) <= 1, `height ${height}`);
  assert.equal(r.text, `scope all, bounds x=0 y=0 w=5000 h=500 (board coordinates), 2 elements, "Plan" (b1), drawn at scale 0.395 (the board host's limit is 2000 px on the longest side)`);
  console.log(`# capped board (5000×500 → ${width}×${height}): ${ms.toFixed(0)} ms`);
});

test("refusals", async () => {
  await refusal(getImage(editor, { scale: 0 }, BOARD), "BAD_ARGS", "scale must be a number above 0 (at most 2), not 0");
  await refusal(getImage(editor, { scale: "big" }, BOARD), "BAD_ARGS", 'scale must be a number above 0 (at most 2), not "big"');
  await refusal(getImage(editor, { background: "no" }, BOARD), "BAD_ARGS", 'background must be true or false, not "no"');
  await refusal(getImage(editor, { scope: "page" }, BOARD), "BAD_ARGS", 'scope must be one of selection, all, refs, rect, not "page"');
  await refusal(getImage(editor, { scope: "rect", rect: { x: 0, y: 0, width: 0, height: 10 } }, BOARD), "BAD_ARGS",
    'scope rect needs rect {x, y, width, height} in board coordinates: finite numbers, width and height above 0, not {"x":0,"y":0,"width":0,"height":10}');
  await refusal(getImage(editor, { scope: "rect" }, BOARD), "BAD_ARGS", /^scope rect needs rect/);
  await refusal(getImage(editor, { scope: "refs", refs: [] }, BOARD), "BAD_ARGS", "scope refs needs refs: a list of {key} or {id}");
  await refusal(getImage(editor, { scope: "refs", refs: [{ name: "x" }] }, BOARD), "BAD_ARGS", 'each ref must be {key} or {id}, not {"name":"x"}');
  await refusal(getImage(editor, { scope: "selection" }, BOARD), "NO_SELECTION", "no window's selection is known to the board host; use scope all, refs or rect");
  await refusal(getImage(editor, { scope: "refs", refs: [{ key: "s1" }, { key: "nope" }] }, BOARD), "UNKNOWN_REF", '{"key":"nope"} names no element of this board');
  await refusal(getImage(editor, { scope: "refs", refs: [{ id: "shape:gone" }] }, BOARD), "UNKNOWN_REF", '{"id":"shape:gone"} names no element of this board');
  await refusal(getImage(editor, { scope: "rect", rect: { x: 5000, y: 5000, width: 10, height: 10 } }, BOARD), "EMPTY",
    "no element on Plan lies completely inside x=5000 y=5000 w=10 h=10; use read_board for where things are");
  await refusal(getImage(newEditor(), {}, BOARD), "EMPTY", "Plan has no elements to draw");

  const far = newEditor();
  far.createShapes([
    { type: "geo", x: 0, y: 0, props: { w: 100, h: 100 } },
    { type: "geo", x: 30_000, y: 0, props: { w: 100, h: 100 } },
  ]);
  await refusal(getImage(far, {}, BOARD), "TOO_LARGE",
    "the picture would be 30164×164 px at scale 1; the board host draws at most 2000 px on the longest side, which would need scale 0.0663 (below 0.1); ask for a smaller scope (refs or rect)");
});
