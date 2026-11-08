// The board host's node runtime (package H0): the editor on linkedom measures as Chromium does (the reference cases of
// reference.ts), pictures come out of resvg with the size the export promises, the jsdom fallback gives the same results,
// and rooms are loaded with their clock shifted past every saved clock (decision O3).
// (Every tldraw export leaves a 5 s timer behind, ExportDelay's uncleared `sleep(maxExportDelayMs)`: harmless in the host's
// process, but it would hold this file open for 5 s; the package's test script passes --test-force-exit.)
// (first: the page before any tldraw module, as in src/bin.ts)
import "../src/node/install-page.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { TLSocketRoom } from "@tldraw/sync-core";
import { Canvas, loadImage } from "skia-canvas";
import { createShapeId, toRichText, type Editor } from "tldraw";
import { runCorpus } from "../../board-tl/src/model/corpus.ts";
import { loadRuntime } from "../src/node/runtime.ts";
import { exportPng } from "../src/node/export.ts";
import { restoreSnapshot, snapshotForRestore } from "../src/restore.ts";
import { createRooms } from "../src/rooms.ts";
import { boardSchema, type BoardRecord } from "../src/schema.ts";
import { CHROMIUM_REFERENCE } from "./reference.ts";

const REFERENCE_IDS = Object.keys(CHROMIUM_REFERENCE);
/** A few corpus cases for comparing the two DOMs: every kind once. */
const DOM_CASES = ["raw:mixed:sans:22:120", "note:long:sans:m", "note:longword:draw:l", "geo:cjk:serif:m", "geoellipse:emoji:mono:m", "text:accented:sans:m", "textfixed:hyphens:sans:m", "arrow:long", "frame:mixed"];

test("the page is linkedom by default, and jsdom is never loaded", async () => {
  const rt = await loadRuntime();
  assert.equal(rt.dom, "linkedom");
  assert.equal(rt.fonts, 16);
  assert.equal(Object.keys(rt.fontAssetUrls()).length, 16);
  const cache = createRequire(import.meta.url).cache;
  assert.ok(!Object.keys(cache).some((k) => /[\\/]jsdom[\\/]/.test(k)), "jsdom was required");
  assert.equal(await loadRuntime(), rt, "loadRuntime is idempotent");
});

test("notes and geo shapes store what Chromium stored (growY, fontSizeAdjustment)", async () => {
  const rt = await loadRuntime();
  const editor = rt.createEditor();
  try {
    const got = runCorpus(editor, { only: (id) => REFERENCE_IDS.includes(id) });
    assert.deepEqual(got, CHROMIUM_REFERENCE);
  } finally {
    editor.dispose();
  }
});

/** The PNG's size from its IHDR. */
function pngSize(png: Buffer) {
  assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function smallBoard(editor: Editor) {
  const ids = { note: createShapeId("n"), geo: createShapeId("g"), text: createShapeId("t"), arrow: createShapeId("a"), frame: createShapeId("f") };
  editor.run(() => {
    editor.createShape({ id: ids.note, type: "note", x: 0, y: 0, props: { richText: toRichText("A note") } });
    editor.createShape({ id: ids.geo, type: "geo", x: 300, y: 0, props: { geo: "rectangle", w: 200, h: 100, richText: toRichText("A rectangle with a label") } });
    editor.createShape({ id: ids.text, type: "text", x: 0, y: 260, props: { richText: toRichText("Free text") } });
    editor.createShape({ id: ids.arrow, type: "arrow", x: 0, y: 0, props: { start: { x: 200, y: 100 }, end: { x: 300, y: 50 } } });
    editor.createShape({ id: ids.frame, type: "frame", x: 600, y: 0, props: { w: 200, h: 150, name: "Frame" } });
  });
  return ids;
}

test("exportPng: the size the export's bounds and the scale give, and something drawn", async () => {
  const rt = await loadRuntime();
  const editor = rt.createEditor();
  try {
    smallBoard(editor);
    const padding = 16, scale = 2;
    const r = await exportPng(editor, undefined, { padding, scale, background: true });
    assert.ok(r);
    const bounds = editor.getCurrentPageBounds()!;
    const expected = { width: Math.floor((bounds.w + 2 * padding) * scale), height: Math.floor((bounds.h + 2 * padding) * scale) };
    assert.deepEqual({ width: r.width, height: r.height }, expected);
    assert.deepEqual(pngSize(r.png), expected);

    // drawn on a canvas: pixels that are not the background (the corner's colour)
    const img = await loadImage(r.png);
    const c = new Canvas(r.width, r.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, r.width, r.height).data;
    const bg = [data[0], data[1], data[2]];
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 48) ink++;
    }
    const share = ink / (r.width * r.height);
    assert.ok(share > 0.02, `only ${(share * 100).toFixed(2)}% of the pixels are drawn`);
    // no text and no HTML left in the SVG it was made from
    assert.doesNotMatch(r.svg, /<foreignObject|<text[\s>]/);
  } finally {
    editor.dispose();
  }
});

test("the jsdom fallback measures as linkedom does", async () => {
  const rt = await loadRuntime();
  const editor = rt.createEditor();
  const want = DOM_CASES;
  let mine;
  try {
    mine = runCorpus(editor, { only: (id) => want.includes(id) });
  } finally {
    editor.dispose();
  }
  assert.equal(Object.keys(mine).length, want.length);
  const url = (p: string) => new URL(p, import.meta.url).href;
  const script = `
    await import(${JSON.stringify(url("../src/node/install-page.ts"))});
    const { loadRuntime } = await import(${JSON.stringify(url("../src/node/runtime.ts"))});
    const { runCorpus } = await import(${JSON.stringify(url("../../board-tl/src/model/corpus.ts"))});
    const rt = await loadRuntime();
    const want = ${JSON.stringify(want)};
    const res = runCorpus(rt.createEditor(), { only: (id) => want.includes(id) });
    process.stdout.write(JSON.stringify({ dom: rt.dom, res }));
    process.exit(0);`;
  const out = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [...process.execArgv.filter((a, i, all) => a.startsWith("--experimental") || a.startsWith("--import") || all[i - 1] === "--import"), "--input-type=module", "-e", script],
      { env: { ...process.env, AIWB_BOARDHOST_DOM: "jsdom" }, timeout: 60_000, maxBuffer: 1 << 24 },
      (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
  });
  const theirs = JSON.parse(out);
  assert.equal(theirs.dom, "jsdom");
  assert.deepEqual(theirs.res, mine);
});

test("snapshotForRestore: the clock is past every saved clock, the records are kept", () => {
  const snap = { clock: 40, documentClock: 37, tombstones: { "shape:x": 30 }, tombstoneHistoryStartsAtClock: 2, documents: [{ lastChangedClock: 12, state: { id: "a" } }, { lastChangedClock: 41, state: { id: "b" } }] } as any;
  const r = snapshotForRestore(snap);
  assert.ok(r.documentClock! > 41);
  assert.equal(r.tombstoneHistoryStartsAtClock, r.documentClock);
  assert.deepEqual(r.tombstones, {});
  assert.deepEqual(r.documents, snap.documents);
  assert.equal(restoreSnapshot(null), undefined);
});

test("rooms load through snapshotForRestore: the loaded room's clock is past every saved clock", async () => {
  // a room with some history, saved as the host saves it
  const first = new TLSocketRoom<BoardRecord, void>({ schema: boardSchema() });
  const rt = await loadRuntime();
  const editor = rt.createEditor();
  try {
    smallBoard(editor);
    const shapes = editor.store.allRecords().filter((r) => r.typeName === "shape");
    await first.updateStore((s) => { for (const r of shapes) s.put(r as any); });
    await first.updateStore((s) => { s.delete(shapes[0].id); });
  } finally {
    editor.dispose();
  }
  const saved = first.getCurrentSnapshot();
  first.close();
  const savedMax = Math.max(saved.documentClock ?? 0, saved.clock ?? 0, ...saved.documents.map((d) => d.lastChangedClock));
  assert.ok(savedMax > 0);

  const rooms = createRooms({
    store: { load: async () => JSON.stringify(saved), save: async () => {} },
    link: { queue() {}, closed() {} },
  });
  try {
    await rooms.withRoom("b1", async (h) => {
      assert.ok(h.room.getCurrentDocumentClock() > savedMax, `${h.room.getCurrentDocumentClock()} <= ${savedMax}`);
      const ids = h.room.getCurrentSnapshot().documents.map((d) => d.state.id).sort();
      assert.deepEqual(ids, saved.documents.map((d) => d.state.id).sort());
    });
  } finally {
    await rooms.shutdown(100);
  }
});
