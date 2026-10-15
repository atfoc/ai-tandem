// get_image's drawing part on the view's side (src/export.ts) over a stand-in for Excalidraw's exportToBlob: what the old page's
// web/test/saves.test.ts proved of the old page's board.ts's getImage that the app's side (packages/core/test/board/image.test.ts) leaves to the
// view: the picture is drawn after the fonts are ready (also when the fonts promise rejects), padded by EXPORT_PADDING, sized and limited
// on the size Excalidraw measures (before the canvas exists), and a failure of the drawing is a RENDER_FAILED text error. The module is
// bundled with esbuild, `@excalidraw/excalidraw` replaced by the stand-in the tests drive through `globalThis.__excalidraw`.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { EXPORT_PADDING, MAX_SIDE_PX } from "../src/imagesize.ts";

type ExportOptions = { exportPadding: number; getDimensions: (w: number, h: number) => { width: number; height: number; scale: number }; elements: { id: string }[] };
const x = globalThis as unknown as {
  __excalidraw: { exportToBlob: (o: ExportOptions) => Promise<Blob>; getCommonBounds: (els: unknown[]) => number[] };
  FileReader: unknown;
  document: unknown;
};

// a FileReader for Node: the blob as a data: address
x.FileReader = class {
  result: unknown = null; error: unknown = null; onload: () => void = () => {}; onerror: () => void = () => {};
  readAsDataURL(blob: Blob) { void blob.arrayBuffer().then((b) => { this.result = "data:image/png;base64," + Buffer.from(b).toString("base64"); this.onload(); }); }
};

const stand = `
  export const exportToBlob = (o) => globalThis.__excalidraw.exportToBlob(o);
  export const getCommonBounds = (els) => globalThis.__excalidraw.getCommonBounds(els);
  export const convertToExcalidrawElements = (v) => v; export const newElementWith = (v) => v;
  export const CaptureUpdateAction = {}; export const FONT_FAMILY = {}; export const ROUNDNESS = {};`;
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-export-")), "export.mjs");
await esbuild.build({
  entryPoints: [path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/export.ts")],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{
    name: "excalidraw",
    setup(b) {
      b.onResolve({ filter: /^@excalidraw\/excalidraw$/ }, () => ({ path: "excalidraw", namespace: "stand-in" }));
      b.onLoad({ filter: /.*/, namespace: "stand-in" }, () => ({ contents: stand, loader: "js" }));
    },
  }],
});
const { exportPicture } = await import(pathToFileURL(out).href) as { exportPicture: (i: unknown) => Promise<{ png: string; width: number; height: number; bounds: { x: number; y: number; width: number; height: number }; count: number }> };
fs.rmSync(path.dirname(out), { recursive: true, force: true });

const box = (id: string, x0: number, y0: number, width: number, height: number) => ({ id, type: "rectangle", x: x0, y: y0, width, height });
const input = (o: Record<string, unknown> = {}) => ({ elements: [box("a", 10, 20, 100, 50)], files: {}, ids: [], scale: 1, background: true, ...o });
let drawn: ExportOptions[];
beforeEach(() => {
  drawn = [];
  // Excalidraw measures the elements with the padding (here: the box and the padding on every side), asks getDimensions for the picture's size, and draws it
  x.__excalidraw = {
    getCommonBounds: (els) => { const e = els as { x: number; y: number; width: number; height: number }[]; return [Math.min(...e.map((v) => v.x)), Math.min(...e.map((v) => v.y)), Math.max(...e.map((v) => v.x + v.width)), Math.max(...e.map((v) => v.y + v.height))]; },
    exportToBlob: async (o) => {
      drawn.push(o);
      o.getDimensions(100 + 2 * o.exportPadding, 50 + 2 * o.exportPadding);
      return new Blob(["png bytes"], { type: "image/png" });
    },
  };
  x.document = {};
});

test("get_image waits for the fonts to be ready before it draws, and draws also when the fonts promise rejects", async () => {
  let ready!: () => void;
  x.document = { fonts: { ready: new Promise<void>((r) => { ready = r; }) } };
  const picture = exportPicture(input());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(drawn.length, 0, "nothing is drawn while the fonts load");
  ready();
  const got = await picture;
  assert.equal(drawn.length, 1);
  assert.equal(got.png, Buffer.from("png bytes").toString("base64"), "the PNG as base64 with no data: prefix");
  // a fonts promise that rejects is no reason not to draw
  x.document = { fonts: { ready: Promise.reject(new Error("no fonts")) } };
  await exportPicture(input());
  assert.equal(drawn.length, 2);
  // and a document with no font API draws at once
  x.document = {};
  await exportPicture(input());
  assert.equal(drawn.length, 3);
});

test("get_image pads the picture by EXPORT_PADDING: the bounds in the answer are what is drawn, the padding left out", async () => {
  const got = await exportPicture(input({ scale: 2 }));
  assert.equal(drawn[0].exportPadding, EXPORT_PADDING);
  assert.deepEqual([got.width, got.height], [2 * (100 + 2 * EXPORT_PADDING), 2 * (50 + 2 * EXPORT_PADDING)], "the picture is the measured size times the scale");
  assert.deepEqual(got.bounds, { x: 10, y: 20, width: 100, height: 50 }, "the bounds are the elements' box, not the padded picture");
  assert.equal(got.count, 1);
});

test("get_image: the limit is checked on the size Excalidraw measures, before the canvas exists", async () => {
  x.__excalidraw.exportToBlob = async (o) => { drawn.push(o); o.getDimensions(MAX_SIDE_PX + 1, 10); return new Blob(["never"]); };
  await assert.rejects(exportPicture(input()), (e: unknown) => (e as { code?: string }).code === "TOO_LARGE" && /limit|large|side/i.test((e as Error).message), "the refusal of the measuring is the answer, with its code");
  assert.equal(drawn.length, 1, "Excalidraw was asked once, and refused before it made a canvas");
  // a scale that would make the picture under 1 px on a side is the agent's BAD_ARGS
  x.__excalidraw.exportToBlob = async (o) => { o.getDimensions(10, 10); return new Blob(["never"]); };
  await assert.rejects(exportPicture(input({ scale: 0.001 })), (e: unknown) => (e as { code?: string }).code === "BAD_ARGS");
});

test("get_image: an exportToBlob that throws is a RENDER_FAILED text error, not a bare rejection; elements with no extent are EMPTY and nothing is drawn", async () => {
  x.__excalidraw.exportToBlob = async () => { throw new Error("canvas exploded"); };
  await assert.rejects(exportPicture(input()), (e: unknown) => (e as { code?: string }).code === "RENDER_FAILED" && /canvas exploded/.test((e as Error).message));
  drawn.length = 0;
  x.__excalidraw.exportToBlob = async (o) => { drawn.push(o); return new Blob(["x"]); };
  await assert.rejects(exportPicture(input({ elements: [box("dot", 5, 5, 0, 0)], ids: ["dot"] })), (e: unknown) => (e as { code?: string }).code === "EMPTY");
  assert.equal(drawn.length, 0, "no request to draw");
});
