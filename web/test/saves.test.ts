// Board autosave and the role per board (src/board.ts with the real src/store.ts): a failed
// write counts as unsaved until a later write of that board succeeds; a write names the revision
// it is based on; and only a board this window holds is written. board.ts pulls in Excalidraw,
// the api and the sidebar, so it is bundled with esbuild with those stubbed; the stubs read the
// test's fake server from globalThis.__saves.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { EXPORT_PADDING } from "../src/logic/image.ts";

type Take = { state: "held" | "waiting" | "busy"; rev?: number };
type Fake = {
  scene: (id: string) => Promise<{ scene: unknown; rev: number }>;
  saveScene: (id: string, base: number, scene: any) => Promise<number>;
  take: (id: string, ifFree: boolean) => Promise<Take>;
  release: (id: string) => Promise<{ state: string }>;
  log: string[];        // what the page asked of the server, in order
  selects: unknown[][]; // the sidebar's select, as show_board calls it
  exports: any[];       // the arguments exportToBlob was called with
  png?: Uint8Array;     // the bytes exportToBlob returns
  exportError?: unknown; // exportToBlob throws this when set
  canvases: { width: number; height: number }[]; // the canvases getDimensions let exportToBlob make
};
const fake: Fake = { scene: async () => ({ scene: {}, rev: 0 }), saveScene: async (_, base) => base + 1, take: async () => ({ state: "held", rev: 0 }),
  release: async () => ({ state: "handed" }), log: [], selects: [], exports: [], canvases: [] };
(globalThis as any).__saves = fake;

const stubs: Record<string, string> = {
  "@excalidraw/excalidraw": `
    export const restoreElements = (els) => els;
    export const getSceneVersion = (els) => els.reduce((n, e) => n + (e.version ?? 1), 0);
    export const newElementWith = (e, p) => ({ ...e, ...p });
    export const convertToExcalidrawElements = (els) => els;
    // getCommonBounds: the box of x, y, width, height and points turned by angle around their centre, which is all the tests' elements have
    export const getCommonBounds = (els) => {
      const xs = [], ys = [];
      for (const e of els) {
        const pts = (e.points ?? [[0, 0], [e.width, 0], [e.width, e.height], [0, e.height]]).map(([px, py]) => [e.x + px, e.y + py]);
        const px = pts.map((p) => p[0]), py = pts.map((p) => p[1]);
        const cx = (Math.min(...px) + Math.max(...px)) / 2, cy = (Math.min(...py) + Math.max(...py)) / 2, c = Math.cos(e.angle ?? 0), n = Math.sin(e.angle ?? 0);
        for (const [x, y] of pts) { xs.push(cx + (x - cx) * c - (y - cy) * n); ys.push(cy + (x - cx) * n + (y - cy) * c); }
      }
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };
    // exportToBlob: sizes the canvas as Excalidraw 0.18 does, draws nothing: restore() drops the elements that are invisibly small
    // (a line, arrow or freedraw with under two points, any other with width and height 0), a label text goes above each frame
    // (14 px at line height 1.25, 3 px above the frame, cut to the frame's width; its width here is a guess, only its top counts),
    // and the size is that of the root elements (not inside a frame that is drawn) and the padding, through getDimensions
    export const exportToBlob = async (o) => {
      const f = globalThis.__saves;
      f.exports.push(o);
      const isFrame = (e) => e.type === "frame" || e.type === "magicframe";
      const kept = o.elements.filter((e) => (e.points ? e.points.length >= 2 : e.width !== 0 || e.height !== 0));
      const drawn = kept.flatMap((e) => {
        if (!isFrame(e)) return [e];
        const title = e.name ?? (e.type === "frame" ? "Frame" : "AI Frame");
        const label = { id: e.id + "-label", type: "text", x: e.x, y: e.y - 3 - 14 * 1.25, width: Math.min(title.length * 8, e.width), height: 14 * 1.25 };
        return [label, e];
      });
      const frames = new Set(drawn.filter(isFrame).map((e) => e.id));
      const roots = drawn.filter((e) => frames.has(e.id) || !e.frameId || !frames.has(e.frameId));
      const [x0, y0, x1, y1] = getCommonBounds(roots);
      const [w, h] = [x1 - x0 + 2 * o.exportPadding, y1 - y0 + 2 * o.exportPadding];
      f.canvases.push(o.getDimensions(w, h));
      if (f.exportError !== undefined) throw f.exportError;
      return new Blob([f.png ?? new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    };
    export const CaptureUpdateAction = {}; export const FONT_FAMILY = {}; export const ROUNDNESS = {};`,
  "./api.ts": `
    const f = globalThis.__saves;
    export class ApiError extends Error { constructor(status, msg, said = true, code) { super(msg); this.status = status; this.code = code; } }
    export const api = {
      scene: (id) => { f.log.push("read " + id); return f.scene(id); },
      saveScene: (id, base, scene) => { f.log.push("save " + id + " on " + base); return f.saveScene(id, base, scene); },
      takeBoard: (id, ifFree = false) => { f.log.push((ifFree ? "take if free " : "take ") + id); return f.take(id, ifFree); },
      releaseBoard: (id) => { f.log.push("release " + id); return f.release(id); },
    };`,
  "./Sidebar.tsx": `export const select = (...a) => { globalThis.__saves.selects.push(a); };`,
};

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(web, "src");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-saves-")), "board.mjs");
await esbuild.build({
  stdin: { contents: `export * as board from "./board.ts"; export * as store from "./store.ts"; export { ApiError } from "./api.ts";`, resolveDir: src, loader: "ts" },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{
    name: "stubs",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => (a.path in stubs ? { path: a.path, namespace: "stub" } : undefined));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
    },
  }],
});
const { board, store, ApiError } = await import(pathToFileURL(out).href);
fs.rmSync(path.dirname(out), { recursive: true, force: true });

// the expression main.tsx gives the desktop app as window.aiwbFlush
const aiwbFlush = () => board.flushAll().then(() => !board.hasPendingSaves());

const tick = () => new Promise((r) => setTimeout(r, 0));
const st = () => store.getState();
const setBoard = (b: string, o: Record<string, unknown> | null = {}) => store.setState((s: any) => {
  const { [b]: _, ...boards } = s.boards;
  return { boards: o ? { ...boards, [b]: { id: b, name: `Board ${b}`, group: "", ...o } } : boards };
});
const stored = (rev: number, version = 1) => async () =>
  ({ scene: { elements: [{ id: "e1", type: "rectangle", x: 0, y: 0, width: 10, height: 10, version }], appState: {}, files: {} }, rev });
const refusal = (code: string) => new ApiError(409, code === "stale" ? "the board was changed elsewhere" : "another window holds this board", true, code);

const quiet = console.error;
let id = 0;
/** A board on the server at the revision rev, known to the page and not asked for. */
function fresh(rev = 0) {
  const b = `b_${++id}`;
  setBoard(b);
  fake.scene = stored(rev);
  return b;
}
/** A board this window holds, loaded at the revision rev. */
async function held(rev = 0) {
  const b = fresh(rev);
  store.setRole(b, "held");
  await board.loadScene(b);
  return b;
}
let edits = 1;
const edit = (b: string) => board.sceneChanged(b, [{ id: "e1", version: ++edits }], {}, {});
/** A loaded board this window holds, with one edit waiting to be saved. */
async function edited(rev = 0) {
  const b = await held(rev);
  edit(b);
  return b;
}
const down = () => { fake.saveScene = async () => { throw new TypeError("Failed to fetch"); }; };
const up = (writes: string[]) => { fake.saveScene = async (b, base) => { writes.push(b); return base + 1; }; };
/** What the page asked of the server since the last call. */
const asked = () => fake.log.splice(0);

beforeEach(() => {
  console.error = () => {};
  fake.log.length = 0; fake.selects.length = 0; fake.exports.length = 0; fake.canvases.length = 0; fake.png = undefined; fake.exportError = undefined;
  fake.scene = stored(0); fake.saveScene = async (_, base) => base + 1;
  fake.take = async () => ({ state: "held", rev: 0 }); fake.release = async () => ({ state: "handed" });
  board.setLive(null, null);
  for (const b of Object.keys(st().boards)) board.forgetBoard(b); // what a failed test left
  board.streamOpened();
  store.setState({ boards: {}, roles: {}, dropped: {}, sceneGen: {}, outage: {}, sel: { board: null, run: null, chat: null } });
});
test.after(() => { console.error = quiet; });

test("a failed save stays pending after flushAll, so aiwbFlush gives false", async () => {
  down();
  const b = await edited();
  assert.equal(board.hasPendingSaves(), true);
  assert.equal(await aiwbFlush(), false);
  assert.equal(board.hasPendingSaves(), true);
  board.forgetBoard(b);
});

test("a flush once saveScene works again writes the board and clears it", async () => {
  down();
  const b = await edited();
  await board.flushAll();
  assert.equal(board.hasPendingSaves(), true);
  const writes: string[] = [];
  up(writes);
  await board.flush(b);
  assert.deepEqual(writes, [b]);
  assert.equal(board.hasPendingSaves(), false);
  assert.equal(await aiwbFlush(), true);
  assert.deepEqual(writes, [b]); // nothing left to write
  board.forgetBoard(b);
});

test("flushAll retries every board whose save failed", async () => {
  down();
  const a = await edited(), b = await edited();
  await board.flushAll();
  const writes: string[] = [];
  up(writes);
  assert.equal(await aiwbFlush(), true);
  assert.deepEqual(writes.sort(), [a, b].sort());
  board.forgetBoard(a); board.forgetBoard(b);
});

test("forgetBoard on a board with a failed save clears it", async () => {
  down();
  const b = await edited();
  await board.flushAll();
  assert.equal(board.hasPendingSaves(), true);
  board.forgetBoard(b);
  assert.equal(board.hasPendingSaves(), false);
  assert.equal(await aiwbFlush(), true);
});

test("an archived or removed board with a failed save is not pending", async () => {
  down();
  const a = await edited(), r = await edited();
  await board.flushAll();
  assert.equal(board.hasPendingSaves(), true);
  setBoard(a, { archived: true });
  setBoard(r, null);
  assert.equal(board.hasPendingSaves(), false);
  const writes: string[] = [];
  up(writes);
  assert.equal(await aiwbFlush(), true);
  assert.deepEqual(writes, []); // never written
  board.forgetBoard(a); board.forgetBoard(r);
});

test("a later successful write clears a failure; a later failed one sets it again", async () => {
  down();
  const b = await edited();
  await board.flush(b);
  assert.equal(board.hasPendingSaves(), true);
  const writes: string[] = [];
  up(writes);
  edit(b);
  await board.flush(b);
  assert.equal(board.hasPendingSaves(), false);
  down();
  edit(b);
  await board.flush(b);
  assert.equal(board.hasPendingSaves(), true);
  board.forgetBoard(b);
});

// ---- the scene revision (AC42)

test("a save names the revision the scene was read at, then the one the server answered", async () => {
  const b = await edited(4);
  fake.saveScene = async (_, base) => base + 3; // the server's word, whatever it is
  asked();
  await board.flush(b);
  edit(b);
  await board.flush(b);
  assert.deepEqual(asked(), [`save ${b} on 4`, `save ${b} on 7`]);
  assert.equal(board.scenes.get(b).base, 10);
  board.forgetBoard(b);
});

test("a stale save drops the edit and reads the scene again: nothing newer is overwritten", async () => {
  const b = await edited(4);
  const gen = st().sceneGen[b] ?? 0;
  fake.saveScene = async () => { throw refusal("stale"); };
  await board.flush(b);
  assert.equal(board.hasPendingSaves(), false);
  assert.equal(board.scenes.has(b), false);      // the scene the edit was made on is gone
  assert.deepEqual([st().roles[b], st().dropped[b]], ["held", true]); // still this window's board; the canvas says what was dropped
  assert.equal(st().sceneGen[b], gen + 1);       // the canvas reads again
  asked();
  await board.flush(b);                          // the dropped edit is never written again
  assert.deepEqual(asked(), []);
  assert.equal(await aiwbFlush(), true);

  fake.scene = stored(9, 50);                    // what the other window stored
  const sc = await board.loadScene(b);
  assert.deepEqual([sc.base, sc.elements[0].version], [9, 50]);
  const writes: string[] = [];
  up(writes);
  asked();
  edit(b);
  await board.flush(b);
  assert.deepEqual(asked(), [`save ${b} on 9`]);
  board.forgetBoard(b);
});

// ---- the role per board (AC39)

test("a board this window does not hold is never written", async () => {
  const writes: string[] = [];
  up(writes);
  for (const role of [null, "taking", "other", "lost"]) {
    const b = await edited();
    store.setRole(b, role);
    await board.flush(b);
    assert.equal(board.hasPendingSaves(), false, `${role}`); // the desktop app's flush does not wait for it
    assert.equal(await aiwbFlush(), true, `${role}`);
    board.forgetBoard(b);
  }
  assert.deepEqual(writes, []);
});

test("a save refused with not_holder: the board is another window's, and the edit is dropped", async () => {
  const b = await edited(2), other = await edited(5);
  fake.saveScene = async (x, base) => { if (x === b) throw refusal("not_holder"); return base + 1; };
  await board.flushAll();
  assert.deepEqual([st().roles[b], st().dropped[b], board.scenes.has(b)], ["other", true, false]);
  assert.deepEqual([st().roles[other], st().dropped[other], board.scenes.get(other).base], ["held", undefined, 6]); // the other board is untouched
  assert.equal(board.hasPendingSaves(), false);
  asked();
  await board.flushAll();
  assert.deepEqual(asked(), []);
  board.forgetBoard(b); board.forgetBoard(other);
});

test("each board has its own role: taking one, finding another busy, waiting for it and getting it", async () => {
  const a = fresh(), b = fresh();
  fake.take = async (x, ifFree) => (x === a ? { state: "held", rev: 0 } : ifFree ? { state: "busy" } : { state: "waiting" });
  await board.takeBoard(a);
  await board.takeBoard(b, true);
  assert.deepEqual([st().roles[a], st().roles[b]], ["held", "other"]);
  await board.takeBoard(b); // "Use here": the window that holds it is asked
  assert.deepEqual([st().roles[a], st().roles[b]], ["held", "taking"]);
  board.granted(b, 3);      // the `held` event, once it let go
  assert.deepEqual([st().roles[a], st().roles[b]], ["held", "held"]);
  assert.deepEqual(asked(), [`take ${a}`, `take if free ${b}`, `take ${b}`]);
  board.forgetBoard(a); board.forgetBoard(b);
});

test("an archived or unknown board is not asked for", async () => {
  const b = fresh();
  setBoard(b, { archived: true });
  await board.takeBoard(b);
  await board.takeBoard("b_none", true);
  assert.deepEqual([asked(), st().roles[b]], [[], undefined]);
});

test("one take runs per board: a take if free joins it, a take does not join a take if free", async () => {
  const b = fresh();
  let answer!: (a: Take) => void;
  fake.take = () => new Promise((r) => { answer = r; });
  const first = board.takeBoard(b, true);
  assert.equal(board.takeBoard(b, true), first);
  const strong = board.takeBoard(b);
  assert.notEqual(strong, first);
  assert.equal(board.takeBoard(b, true), strong);
  assert.deepEqual(asked(), [`take if free ${b}`, `take ${b}`]);
  answer({ state: "held", rev: 0 });
  await strong;
  assert.equal(st().roles[b], "held");
});

test("a take that fails leaves the role as it was", async () => {
  const b = fresh();
  store.setRole(b, "other");
  fake.take = async () => { throw new TypeError("Failed to fetch"); };
  await board.takeBoard(b);
  assert.equal(st().roles[b], "other");
});

test("release_request: the one board's pending save is written, then it is let go; the others wait as before", async () => {
  const a = await edited(1), b = await edited(1);
  asked();
  await board.handOver(a);
  assert.deepEqual(asked(), [`save ${a} on 1`, `release ${a}`]); // written before the release, and b not at all
  assert.equal(board.hasPendingSaves(), true); // b's edit still waits
  board.boardLost(a);                          // the `superseded` that follows the release
  assert.deepEqual([st().roles[a], st().dropped[a], st().roles[b]], ["lost", undefined, "held"]); // nothing was dropped: it was saved in time
  assert.equal(board.scenes.get(a).base, 2);   // the saved scene is kept, for a grant at that revision
  await board.flush(b);
  assert.deepEqual(asked(), [`save ${b} on 1`]);
  board.forgetBoard(a); board.forgetBoard(b);
});

test("a release answered free (who asked went away): the board is asked for again, if free, and not written in between", async () => {
  const b = await held(1);
  fake.release = async () => ({ state: "free" });
  let answer!: (a: Take) => void;
  fake.take = () => new Promise((r) => { answer = r; });
  asked();
  await board.handOver(b);
  assert.equal(st().roles[b], undefined);
  edit(b);
  await board.flush(b);
  assert.deepEqual(asked(), [`release ${b}`, `take if free ${b}`]); // no write: the server holds it for nobody
  answer({ state: "held", rev: 1 });
  await tick(); await tick();
  assert.deepEqual([st().roles[b], asked()], ["held", [`save ${b} on 1`]]); // the edit made meanwhile is saved by the grant
  board.forgetBoard(b);
});

test("superseded: that board is lost with its unsaved edit; the stream's other boards are as before, and aiwbFlush is true", async () => {
  const a = await edited(1), b = await edited(1);
  down(); // a's write could not be made in time
  await board.flush(a);
  const writes: string[] = [];
  up(writes);
  const gen = st().sceneGen[a] ?? 0;
  board.boardLost(a);
  assert.deepEqual([st().roles[a], st().dropped[a], board.scenes.has(a)], ["lost", true, false]);
  assert.equal(st().sceneGen[a], gen + 1);
  assert.deepEqual([st().roles[b], st().dropped[b], board.scenes.has(b)], ["held", undefined, true]);
  assert.equal(board.hasPendingSaves(), true); // b's own edit
  assert.equal(await aiwbFlush(), true);       // the desktop app can close: the lost board holds nothing back
  assert.deepEqual(writes, [b]);               // and a's dropped edit is never written
  board.forgetBoard(a); board.forgetBoard(b);
});

test("a write that is on its way when the board is lost changes nothing when it answers", async () => {
  const b = await edited(1);
  let refuse!: (e: unknown) => void;
  fake.saveScene = () => new Promise((_, reject) => { refuse = reject; });
  const writing = board.flush(b);
  board.boardLost(b);
  assert.deepEqual([st().roles[b], st().dropped[b]], ["lost", true]);
  refuse(refusal("not_holder"));
  await writing;
  assert.equal(st().roles[b], "lost"); // not "other": the newer word stays
  assert.equal(board.hasPendingSaves(), false);
  board.forgetBoard(b);
});

test("a lost board's saved scene is kept for a grant at its revision, and read again at another", async () => {
  const b = await held(4);
  board.boardLost(b);
  assert.deepEqual([st().roles[b], st().dropped[b], board.scenes.has(b)], ["lost", undefined, true]);
  asked();
  board.granted(b, 4); // "Use here", and nothing was stored meanwhile
  await board.loadScene(b);
  assert.deepEqual([st().roles[b], asked()], ["held", []]);

  board.boardLost(b);
  const gen = st().sceneGen[b] ?? 0;
  board.granted(b, 6); // the other window drew
  assert.deepEqual([st().roles[b], st().dropped[b], board.scenes.has(b), st().sceneGen[b]], ["held", undefined, false, gen + 1]);
  fake.scene = stored(6, 9);
  assert.equal((await board.loadScene(b)).base, 6);
  assert.deepEqual(asked(), [`read ${b}`]);
  board.forgetBoard(b);
});

// ---- after a reconnect (plan lines 530-535): the stream came back, and with it nothing is held

/** A held board with an edit the cut kept from being saved, and the stream back; the board is on screen or not. */
async function cut(rev: number, onScreen: boolean) {
  const b = await edited(rev);
  down();
  await board.flush(b); // refused or unreachable while the stream was away
  board.streamOpened();
  assert.equal(st().roles[b], undefined);
  store.setState({ sel: { board: onScreen ? b : null, run: null, chat: null } });
  asked();
  return b;
}

test("a scene read that is on its way when the board is granted is not kept: the scene is read again, and the first save names the granted revision", async () => {
  const b = fresh();
  store.setRole(b, "taking"); // another window holds it; this one clicked it and reads its scene meanwhile
  const reads: ((rev: number, version: number) => void)[] = [];
  fake.scene = () => new Promise((resolve) => { reads.push((rev, version) => stored(rev, version)().then(resolve)); });
  const loaded = board.loadScene(b);
  await tick();
  assert.deepEqual(asked(), [`read ${b}`]);
  board.granted(b, 5); // the holder wrote its last edit (revision 5) and let go, before the read was answered
  assert.equal(st().roles[b], "held");
  reads[0](4, 1); // the read lands at the older revision
  await tick();
  assert.deepEqual(asked(), [`read ${b}`]); // read again
  assert.equal(board.scenes.has(b), false);
  reads[1](5, 2);
  const sc = await loaded; // who waited for the scene gets the stored one
  assert.deepEqual([sc.base, sc.elements[0].version, board.scenes.get(b) === sc], [5, 2, true]);
  edit(b);
  await board.flush(b);
  assert.deepEqual(asked(), [`save ${b} on 5`]); // not refused as stale: the first strokes are kept
  assert.equal(st().dropped[b], undefined);
  board.forgetBoard(b);
});

test("opening a free board reads its scene once: a read on its way that lands at the granted revision is kept", async () => {
  const pending = () => {
    const reads: ((rev: number, version?: number) => void)[] = [];
    let answer!: (a: Take) => void;
    fake.scene = () => new Promise((resolve) => { reads.push((rev, version = 1) => stored(rev, version)().then(resolve)); });
    fake.take = () => new Promise((r) => { answer = r; });
    return { reads, grant: (rev: number) => answer({ state: "held", rev }) };
  };
  const b = fresh();
  const x = pending();
  const took = board.takeBoard(b);   // the click on its row: nobody holds it
  const loaded = board.loadScene(b); // its canvas
  await tick();
  x.grant(7); // the take is answered while the read is on its way
  await took;
  assert.equal(st().roles[b], "held");
  x.reads[0](7);
  await tick();
  assert.deepEqual([board.scenes.has(b), asked()], [true, [`take ${b}`, `read ${b}`]]); // kept, and not read again
  const sc = await loaded;
  assert.deepEqual([sc.base, board.scenes.get(b) === sc], [7, true]);
  fake.saveScene = async (_, base) => base + 1;
  edit(b);
  await board.flush(b);
  assert.deepEqual(asked(), [`save ${b} on 7`]);
  // a read that lands at an older revision than the grant is of before the last write: it is made again
  const c = fresh();
  const y = pending();
  const took2 = board.takeBoard(c);
  const loaded2 = board.loadScene(c);
  await tick();
  y.grant(7);
  await took2;
  y.reads[0](6);
  await tick();
  assert.equal(board.scenes.has(c), false);
  y.reads[1](7, 2);
  const sc2 = await loaded2;
  assert.deepEqual([sc2.base, sc2.elements[0].version, asked()], [7, 2, [`take ${c}`, `read ${c}`, `read ${c}`]]);
  // a later read of a board granted before is judged by nothing: no grant came while it was on its way
  board.boardLost(c);
  board.forgetBoard(c); setBoard(c);
  fake.scene = stored(9);
  assert.equal((await board.loadScene(c)).base, 9);
  assert.deepEqual(asked(), [`read ${c}`]);
  board.forgetBoard(b); board.forgetBoard(c);
});

test("a scene read that is on its way when the kept scene is dropped is not kept either", async () => {
  const b = await edited(3);
  const reads: ((rev: number) => void)[] = [];
  fake.scene = () => new Promise((resolve) => { reads.push((rev) => stored(rev)().then(resolve)); });
  board.boardLost(b); // the unsaved edit goes with its scene, and the canvas reads the stored one
  asked();
  const loaded = board.loadScene(b);
  await tick();
  board.granted(b, 4); // no scene kept: nothing to forget, and the read on its way is void
  reads[0](3);
  await tick();
  assert.equal(board.scenes.has(b), false);
  reads[1](4);
  assert.equal((await loaded).base, 4);
  assert.deepEqual(asked(), [`read ${b}`, `read ${b}`]);
  // a read that nothing made void is kept as it lands, and made once
  const c = fresh(7);
  const [x, y] = await Promise.all([board.loadScene(c), board.loadScene(c)]);
  assert.deepEqual([x === y, x.base, asked()], [true, 7, [`read ${c}`]]);
  // one that fails while void is not made again: its error is the answer
  const d = fresh();
  fake.scene = async () => { await tick(); throw new ApiError(404, "no such board"); };
  const failed = board.loadScene(d);
  board.granted(d, 1);
  await assert.rejects(failed, /no board with id/);
  assert.deepEqual(asked(), [`read ${d}`]);
  board.forgetBoard(b); board.forgetBoard(c); board.forgetBoard(d);
});

test("after a reconnect nothing is written before the board is granted again", async () => {
  const b = await cut(3, true);
  const writes: string[] = [];
  up(writes);
  edit(b);
  await board.flush(b);
  assert.deepEqual(writes, []);
  board.forgetBoard(b);
});

test("reconnect, the board is not free: the role is other, the pending edit is dropped, the panel says so", async () => {
  for (const onScreen of [true, false]) {
    const b = await cut(3, onScreen);
    const writes: string[] = [];
    up(writes);
    fake.take = async () => ({ state: "busy" });
    board.takeAfterSnapshot();
    await tick(); await tick();
    assert.deepEqual(asked(), [`take if free ${b}`]);
    assert.deepEqual([st().roles[b], st().dropped[b], board.scenes.has(b)], ["other", true, false]);
    assert.equal(await aiwbFlush(), true);
    assert.deepEqual(writes, []);
    board.forgetBoard(b);
  }
});

test("reconnect, the board is free at the same revision: the pending edit is saved", async () => {
  const b = await cut(3, false);
  const writes: string[] = [];
  up(writes);
  fake.take = async () => ({ state: "held", rev: 3 });
  board.takeAfterSnapshot();
  await tick(); await tick();
  assert.deepEqual(asked(), [`take if free ${b}`, `save ${b} on 3`]);
  assert.deepEqual([st().roles[b], st().dropped[b], board.scenes.get(b).base], ["held", undefined, 4]);
  assert.equal(board.hasPendingSaves(), false);
  board.forgetBoard(b);
});

test("reconnect, the board is free at another revision: the pending edit is dropped, with a note on the canvas", async () => {
  const b = await cut(3, true);
  const gen = st().sceneGen[b] ?? 0;
  const writes: string[] = [];
  up(writes);
  fake.take = async () => ({ state: "held", rev: 5 }); // another window stored twice while this one was away
  board.takeAfterSnapshot();
  await tick(); await tick();
  assert.deepEqual(asked(), [`take if free ${b}`]);
  assert.deepEqual(writes, []);                                           // the newer drawing is not overwritten
  assert.deepEqual([st().roles[b], st().dropped[b]], ["held", true]);     // held with dropped: Canvas.tsx shows the note
  assert.deepEqual([board.scenes.has(b), st().sceneGen[b]], [false, gen + 1]); // and reads the stored scene
  assert.equal(await aiwbFlush(), true);
  board.forgetBoard(b);
});

test("after a reconnect a board that showed the panel is not asked for: the window that held it is the one to get it back", async () => {
  for (const role of ["other", "lost"]) {
    const b = fresh();
    store.setRole(b, role);
    board.streamOpened();
    store.setState({ sel: { board: b, run: null, chat: null } });
    asked();
    board.takeAfterSnapshot();
    await tick();
    assert.deepEqual([asked(), st().roles[b]], [[], role]);
    await board.takeBoard(b); // "Use here" takes it all the same
    assert.deepEqual([asked(), st().roles[b]], [[`take ${b}`], "held"]);
  }
});

test("after a snapshot only the board on screen and the boards with an unsaved edit are asked for, each if free", async () => {
  const shown = fresh(), clean = await held(1), dirty = await cut(1, false), mine = await held(1);
  fresh(); // a board never opened
  store.setRole(clean, "held"); board.streamOpened(); // clean: held before the cut, nothing unsaved, off screen
  store.setRole(mine, "held");                        // granted already on the new stream
  store.setState({ sel: { board: shown, run: null, chat: null } });
  fake.take = async () => ({ state: "busy" });
  asked();
  board.takeAfterSnapshot();
  await tick(); await tick();
  assert.deepEqual(asked().sort(), [`take if free ${shown}`, `take if free ${dirty}`].sort());
  assert.deepEqual([st().roles[shown], st().roles[clean], st().roles[mine]], ["other", undefined, "held"]);
  for (const b of [shown, clean, dirty, mine]) board.forgetBoard(b);
});

test("a reconnect keeps what is known of the other windows, and drops what this one held or waited for", async () => {
  const [h, t, o, l] = [fresh(), fresh(), fresh(), fresh()];
  store.setRole(h, "held"); store.setRole(t, "taking"); store.setRole(o, "other"); store.setRole(l, "lost");
  board.streamOpened();
  assert.deepEqual([st().roles[h], st().roles[t], st().roles[o], st().roles[l]], [undefined, undefined, "other", "lost"]);
});

test("the answer of a take made before a reconnect is not taken: that hold went with the stream", async () => {
  const b = fresh();
  let answer!: (a: Take) => void;
  fake.take = () => new Promise((r) => { answer = r; });
  const taking = board.takeBoard(b);
  board.streamOpened();
  answer({ state: "held", rev: 0 });
  await taking;
  assert.equal(st().roles[b], undefined);
  fake.take = async () => ({ state: "held", rev: 0 }); // and the next take is a new one
  await board.takeBoard(b, true);
  assert.equal(st().roles[b], "held");
});

test("a take's `waiting` that arrives after the `held` event does not undo the grant", async () => {
  const b = fresh();
  let answer!: (a: Take) => void;
  fake.take = () => new Promise((r) => { answer = r; });
  const taking = board.takeBoard(b);
  board.granted(b, 2);
  answer({ state: "waiting" });
  await taking;
  assert.equal(st().roles[b], "held");
});

// ---- a board on another server (Board.server): the outage and the return

const away = (code = "server_unreachable") => { fake.saveScene = async () => { throw new ApiError(503, "Studio is not connected.", true, code); }; };
/** A loaded board on the server s_1 this window holds, with one edit that the server's absence kept from being saved. */
async function outage(rev: number, code?: string) {
  const b = fresh(rev);
  setBoard(b, { server: "s_1" });
  store.setRole(b, "held");
  await board.loadScene(b);
  edit(b);
  away(code);
  await board.flush(b);
  asked();
  return b;
}

test("a save answered 503 keeps the edit and sets the outage, for either code", async () => {
  for (const code of ["server_unreachable", "not_held_there"]) {
    const b = await outage(3, code);
    assert.deepEqual([st().outage[b], st().roles[b], st().dropped[b], board.scenes.has(b)], [true, "held", undefined, true]);
    assert.equal(board.hasPendingSaves(), true);
    edit(b); // the canvas stays in use: the next change is tried, and kept again
    await board.flush(b);
    assert.deepEqual(asked(), [`save ${b} on 3`]);
    assert.deepEqual([st().outage[b], board.scenes.get(b).base], [true, 3]);
    board.forgetBoard(b);
    assert.equal(st().outage[b], undefined);
  }
});

test("a save answered 504 (the link broke while it was on its way) keeps the edit and sets the outage", async () => {
  const b = fresh(3);
  setBoard(b, { server: "s_1" });
  store.setRole(b, "held");
  await board.loadScene(b);
  edit(b);
  fake.saveScene = async () => { throw new ApiError(504, "Studio did not answer.", true, "no_answer"); };
  await board.flush(b);
  assert.deepEqual([st().outage[b], st().roles[b], st().dropped[b], board.scenes.has(b)], [true, "held", undefined, true]);
  assert.equal(board.hasPendingSaves(), true);
  board.forgetBoard(b);
  const l = await edited(3); // a local board: no banner
  await board.flush(l);
  assert.deepEqual([st().outage[l], board.hasPendingSaves()], [undefined, true]);
  board.forgetBoard(l);
});

test("a 503 for a local board, and a save that got no answer, raise no banner", async () => {
  const b = await edited(3);
  away();
  await board.flush(b);
  assert.deepEqual([st().outage[b], board.hasPendingSaves()], [undefined, true]);
  board.forgetBoard(b);
  const r = fresh(3);
  setBoard(r, { server: "s_1" });
  store.setRole(r, "held");
  await board.loadScene(r);
  edit(r);
  down();
  await board.flush(r);
  assert.deepEqual([st().outage[r], board.hasPendingSaves()], [undefined, true]);
  board.forgetBoard(r);
});

test("`held` at the same revision saves the edit and clears the outage", async () => {
  const b = await outage(3);
  const writes: string[] = [];
  up(writes);
  board.granted(b, 3);
  await tick(); await tick();
  assert.deepEqual(asked(), [`save ${b} on 3`]);
  assert.deepEqual(writes, [b]);
  assert.deepEqual([st().outage[b], st().roles[b], st().dropped[b], board.scenes.get(b).base], [undefined, "held", undefined, 4]);
  assert.equal(board.hasPendingSaves(), false);
  board.forgetBoard(b);
});

test("`held` at another revision drops the edit with the outage notice", async () => {
  const b = await outage(3);
  const gen = st().sceneGen[b] ?? 0;
  const writes: string[] = [];
  up(writes);
  board.granted(b, 5); // the board was changed on its server meanwhile
  await tick(); await tick();
  assert.deepEqual(asked(), []);
  assert.deepEqual(writes, []);
  assert.deepEqual([st().roles[b], st().dropped[b], st().outage[b]], ["held", true, undefined]);
  assert.equal(board.droppedInOutage(b), true); // Canvas.tsx: droppedText(true, name)
  assert.deepEqual([board.scenes.has(b), st().sceneGen[b]], [false, gen + 1]);
  assert.equal(await aiwbFlush(), true);
  board.forgetBoard(b);
  assert.equal(board.droppedInOutage(b), false);
});

test("a drop with no outage keeps the plain notice, also after one with an outage", async () => {
  const b = await outage(3);
  board.granted(b, 5);
  assert.equal(board.droppedInOutage(b), true);
  store.setDropped(b, false);
  fake.scene = stored(5);
  await board.loadScene(b);
  edit(b);
  fake.saveScene = async () => { throw refusal("stale"); };
  await board.flush(b);
  assert.deepEqual([st().dropped[b], board.droppedInOutage(b)], [true, false]);
  board.forgetBoard(b);
});

test("under an outage `stale` and `not_holder` drop the edit and clear the outage", async () => {
  for (const code of ["stale", "not_holder"]) {
    const b = await outage(3);
    fake.saveScene = async () => { throw refusal(code); };
    await board.flush(b);
    assert.deepEqual([st().dropped[b], st().outage[b], board.scenes.has(b), st().roles[b]], [true, undefined, false, code === "stale" ? "held" : "other"]);
    assert.equal(await aiwbFlush(), true);
    board.forgetBoard(b);
  }
});

test("superseded under an outage: the panel, and the edit is kept, unwritten, without the dropped text", async () => {
  const b = await outage(3);
  const writes: string[] = [];
  up(writes);
  board.boardLost(b); // the board's server answered `busy` at the return: the board is merely open there
  assert.deepEqual([st().roles[b], st().dropped[b], board.scenes.has(b)], ["lost", undefined, true]); // TakeoverPanel: no DROPPED_TEXT
  await board.flushAll();
  await tick();
  assert.deepEqual([asked(), writes], [[], []]); // a board that is not held is never written
  assert.equal(await aiwbFlush(), true);
  assert.equal(board.scenes.has(b), true);
  board.forgetBoard(b);
  assert.equal(st().outage[b], undefined);
});

test("superseded under an outage, then \"Use here\" at the same revision: the kept edit is saved, and the outage cleared", async () => {
  const b = await outage(3);
  board.boardLost(b);
  const writes: string[] = [];
  up(writes);
  fake.take = async () => ({ state: "held", rev: 3 });
  await board.takeBoard(b);
  await tick(); await tick();
  assert.deepEqual(asked(), [`take ${b}`, `save ${b} on 3`]);
  assert.deepEqual(writes, [b]);
  assert.deepEqual([st().roles[b], st().dropped[b], st().outage[b], board.scenes.get(b).base], ["held", undefined, undefined, 4]);
  assert.equal(board.hasPendingSaves(), false);
  board.forgetBoard(b);
});

test("superseded under an outage, then \"Use here\" at another revision: the kept edit is dropped with the outage notice", async () => {
  const b = await outage(3);
  board.boardLost(b);
  const gen = st().sceneGen[b] ?? 0;
  const writes: string[] = [];
  up(writes);
  fake.take = async () => ({ state: "waiting" });
  await board.takeBoard(b);
  assert.deepEqual([st().roles[b], st().dropped[b], board.scenes.has(b)], ["taking", undefined, true]);
  board.granted(b, 5); // the `held` event: the board was drawn on at its server meanwhile
  await tick(); await tick();
  assert.deepEqual(asked(), [`take ${b}`]);
  assert.deepEqual(writes, []);
  assert.deepEqual([st().roles[b], st().dropped[b], st().outage[b]], ["held", true, undefined]);
  assert.equal(board.droppedInOutage(b), true); // Canvas.tsx: droppedText(true, name)
  assert.deepEqual([board.scenes.has(b), st().sceneGen[b]], [false, gen + 1]);
  board.forgetBoard(b);
});

test("an edit kept at the loss stays kept when a take if free finds the board busy (server_back), and is saved at the grant", async () => {
  const b = await outage(3);
  board.boardLost(b);
  store.setState({ sel: { board: b, run: null, chat: null } });
  fake.take = async () => ({ state: "busy" });
  board.serverBack("s_1");
  await tick(); await tick();
  assert.deepEqual(asked(), [`take if free ${b}`]);
  assert.deepEqual([st().roles[b], st().dropped[b], board.scenes.has(b)], ["other", undefined, true]);
  const writes: string[] = [];
  up(writes);
  board.granted(b, 3);
  await tick(); await tick();
  assert.deepEqual([writes, st().roles[b], st().outage[b]], [[b], "held", undefined]);
  board.forgetBoard(b);
});

test("superseded with no outage drops the unsaved edit as before: a board on another server, and a local one that got a 503", async () => {
  const r = fresh(3);
  setBoard(r, { server: "s_1" });
  store.setRole(r, "held");
  await board.loadScene(r);
  edit(r);
  down(); // no answer at all: no outage
  await board.flush(r);
  board.boardLost(r);
  assert.deepEqual([st().roles[r], st().dropped[r], st().outage[r], board.scenes.has(r)], ["lost", true, undefined, false]);
  assert.equal(board.droppedInOutage(r), false);
  board.forgetBoard(r);
  const l = await edited(3);
  away();
  await board.flush(l);
  board.boardLost(l);
  assert.deepEqual([st().roles[l], st().dropped[l], board.scenes.has(l)], ["lost", true, false]);
  board.forgetBoard(l);
});

test("a scene read answered 503 rejects with it, and keeps nothing", async () => {
  const b = fresh();
  setBoard(b, { server: "s_1" });
  fake.scene = async () => { throw new ApiError(503, "Studio is not connected.", true, "server_unreachable"); };
  await assert.rejects(board.loadScene(b), (e: any) => e instanceof ApiError && e.status === 503);
  assert.equal(board.scenes.has(b), false);
});

test("server_back: the board on screen of that server is read again when no scene is kept, and asked for if free", async () => {
  const b = fresh(3);
  setBoard(b, { server: "s_1" });
  store.setState({ sel: { board: b, run: null, chat: null } });
  const gen = st().sceneGen[b] ?? 0;
  fake.take = async () => ({ state: "held", rev: 3 });
  board.serverBack("s_2"); // another server: nothing
  assert.deepEqual([asked(), st().sceneGen[b] ?? 0], [[], gen]);
  board.serverBack("s_1");
  await tick(); await tick();
  assert.deepEqual(asked(), [`take if free ${b}`]);
  assert.deepEqual([st().sceneGen[b], st().roles[b]], [gen + 1, "held"]);
  board.forgetBoard(b);
});

test("server_back: a kept scene is not read again, a held board not asked for, a board off screen and a local one left alone", async () => {
  const b = await outage(3);
  store.setState({ sel: { board: b, run: null, chat: null } });
  const gen = st().sceneGen[b] ?? 0;
  board.serverBack("s_1");
  await tick();
  assert.deepEqual([asked(), st().sceneGen[b] ?? 0, st().outage[b]], [[], gen, true]); // the `held` event of the return decides
  store.setState({ sel: { board: null, run: null, chat: null } });
  store.setRole(b, null);
  board.serverBack("s_1");
  assert.deepEqual(asked(), []);
  board.forgetBoard(b);
  const l = fresh();
  store.setState({ sel: { board: l, run: null, chat: null } });
  board.serverBack("local"); board.serverBack("s_1");
  assert.deepEqual(asked(), []);
});

// ---- board tools: the server names the target and asks the window that holds it

/** Runs body with the long timers (the store's busy mark) held, so the test does not wait for them. */
async function withoutLongTimers(body: () => Promise<void>) {
  const real = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: () => void, ms = 0, ...more: unknown[]) => (ms >= 1000 ? 0 : real(fn, ms, ...more));
  try { await body(); } finally { globalThis.setTimeout = real; }
}

test("a tool call works on params.target, not on a board the page resolves", async () => {
  await withoutLongTimers(async () => {
    const own = await held(), target = await held();
    const call = (name: string, o: Record<string, unknown> = {}) => board.runTool({ chat: "c_1", branch: "main", board: own, name, args: { board: "b_nonsense" }, ...o });
    const text: string = await call("read_board", { target });
    assert.match(text, new RegExp(`^Board ${target} `));
    await assert.rejects(call("read_board"), { code: "NO_BOARD" });           // the server always names it
    await assert.rejects(call("list_boards"), { code: "UNKNOWN_TOOL" });      // the server answers these itself
    await assert.rejects(call("create_board", { target }), { code: "UNKNOWN_TOOL" });
    assert.equal(await call("show_board", { target }), `showing Board ${target}`);
    assert.deepEqual(fake.selects, [[{ board: target, run: null, chat: null }, { ifFree: true }]]);
    board.forgetBoard(own); board.forgetBoard(target);
  });
});

test("a tool call for a board this window was given without being told asks for it first; one it does not hold is refused", async () => {
  await withoutLongTimers(async () => {
    const made = fresh(7); // the server gives a new board to the window that made it
    fake.take = async () => ({ state: "held", rev: 7 });
    const call = (target: string) => board.runTool({ chat: "c_1", branch: "main", board: made, target, name: "read_board", args: {} });
    await call(made);
    assert.deepEqual(asked(), [`take if free ${made}`, `read ${made}`]);
    assert.equal(st().roles[made], "held");

    const theirs = fresh();
    fake.take = async () => ({ state: "busy" });
    await assert.rejects(call(theirs), { code: "NOT_HOLDER" });
    assert.deepEqual(asked(), [`take if free ${theirs}`]); // nothing of it is read
    board.forgetBoard(made); board.forgetBoard(theirs);
  });
});

// ---- get_image, with exportToBlob stubbed: the pixels are not asserted, what it is given and what comes back are

const rect = (id: string, x: number, y: number, width: number, height: number, o: Record<string, unknown> = {}) =>
  ({ id, type: "rectangle", x, y, width, height, version: 1, isDeleted: false, ...o });
/** A board this window holds, whose stored scene is els. */
async function heldWith(els: unknown[], appState: unknown = {}, files: unknown = {}) {
  const b = fresh();
  fake.scene = async () => ({ scene: { elements: els, appState, files }, rev: 0 });
  store.setRole(b, "held");
  await board.loadScene(b);
  return b;
}
const image = (b: string, args: unknown = {}, o: Record<string, unknown> = {}) =>
  board.runTool({ chat: "c_1", branch: "main", board: b, target: b, name: "get_image", args, ...o });

test("get_image returns the text with the bounds and the count, and the PNG as base64", async () => {
  await withoutLongTimers(async () => {
    fake.png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const b = await heldWith([
      rect("a", 100, 50, 200, 100),
      { id: "t", type: "text", x: 110, y: 60, width: 50, height: 20, version: 1, containerId: "a", text: "hi" }, // bound text: counts with its container
      { id: "arr", type: "arrow", x: 300, y: 100, width: 100, height: 200, points: [[0, 0], [100, 200]], version: 1 },
      rect("gone", -900, -900, 5, 5, { isDeleted: true }),
    ], { viewBackgroundColor: "#ffeecc" }, { f1: { id: "f1" } });
    const r = await image(b);
    assert.equal(typeof r, "object");
    const { text, image: img } = r as any;
    assert.equal(text, `scope all, bounds x=100 y=50 w=300 h=250 (board coordinates), 2 elements, Board ${b} (${b})`);
    assert.deepEqual(img, { mimeType: "image/png", data: Buffer.from(fake.png).toString("base64") });
    assert.deepEqual(asked(), [`read ${b}`]);
    board.forgetBoard(b);
  });
});

test("get_image gives exportToBlob the live elements, the scene's files and the options, without the canvas", async () => {
  await withoutLongTimers(async () => {
    const files = { f1: { id: "f1", dataURL: "data:" } };
    const b = await heldWith([rect("a", 0, 0, 10, 10), rect("gone", 0, 0, 10, 10, { isDeleted: true })], { viewBackgroundColor: "#ffeecc" }, files);
    assert.equal(st().sel.board === b, false); // not on screen
    await image(b, { scale: 1.5, background: false });
    assert.equal(fake.exports.length, 1);
    const o = fake.exports[0];
    assert.deepEqual(o.elements.map((e: any) => e.id), ["a"]);
    assert.equal(o.files, files);
    assert.equal(o.mimeType, "image/png");
    assert.equal(o.appState.exportBackground, false);
    assert.equal(o.appState.viewBackgroundColor, "#ffeecc");
    assert.equal(typeof o.exportPadding, "number");
    assert.deepEqual(o.getDimensions(100, 40), { width: 150, height: 60, scale: 1.5 });
    await image(b); // defaults
    assert.equal(fake.exports[1].appState.exportBackground, true);
    assert.deepEqual(fake.exports[1].getDimensions(100, 40), { width: 100, height: 40, scale: 1 });
    board.forgetBoard(b);
  });
});

test("get_image: scale above 2 is used as 2; a bad scale, background or scope is BAD_ARGS", async () => {
  await withoutLongTimers(async () => {
    const b = await heldWith([rect("a", 0, 0, 10, 10)]);
    await image(b, { scale: 5 });
    assert.deepEqual(fake.exports[0].getDimensions(10, 10), { width: 20, height: 20, scale: 2 });
    for (const args of [{ scale: 0 }, { scale: -1 }, { scale: "2" }, { scale: NaN }, { background: "no" }, { scope: "nope" }])
      await assert.rejects(image(b, args), { code: "BAD_ARGS" }, JSON.stringify(args));
    await image(b, { scope: "all" });
    assert.equal(fake.exports.length, 2); // the failures drew nothing
    board.forgetBoard(b);
  });
});

test("get_image: an empty board, or one of only deleted elements, is EMPTY and draws nothing", async () => {
  await withoutLongTimers(async () => {
    const empty = await heldWith([]);
    const deleted = await heldWith([rect("a", 0, 0, 10, 10, { isDeleted: true })]);
    await assert.rejects(image(empty), { code: "EMPTY" });
    await assert.rejects(image(deleted), { code: "EMPTY" });
    assert.equal(fake.exports.length, 0);
    board.forgetBoard(empty); board.forgetBoard(deleted);
  });
});

test("get_image: a picture above the limit is TOO_LARGE with the limit named, and no canvas is made", async () => {
  await withoutLongTimers(async () => {
    const wide = await heldWith([rect("a", 0, 0, 9000, 10)]);
    await assert.rejects(image(wide), (e: any) => e.code === "TOO_LARGE" && /8192/.test(e.message) && /smaller scope/.test(e.message));
    const area = await heldWith([rect("a", 0, 0, 6000, 6000)]); // 6032x6032 = 36 MP, each side within 8192
    await assert.rejects(image(area), (e: any) => e.code === "TOO_LARGE" && /32 megapixels/.test(e.message));
    const half = await heldWith([rect("a", 0, 0, 4100, 100)]); // 4132 px wide: fine at scale 1, 8264 at scale 2
    await assert.rejects(image(half, { scale: 2 }), { code: "TOO_LARGE" });
    assert.equal(fake.canvases.length, 0);
    await image(half);
    assert.deepEqual(fake.canvases, [{ width: 4132, height: 132, scale: 1 }]);
    board.forgetBoard(wide); board.forgetBoard(area); board.forgetBoard(half);
  });
});

test("get_image: the limit is checked on the size Excalidraw measures, and the bounds in the text are that size", async () => {
  await withoutLongTimers(async () => {
    // a frame at the top of a board: its name is drawn above it, so the box is taller than the elements' (here by 20.5, which the
    // stand-in works out as Excalidraw does)
    const frame = { id: "fr", type: "frame", x: 0, y: 100, width: 200, height: 100, version: 1, isDeleted: false, name: "Plan" };
    const b = await heldWith([frame, rect("in", 10, 110, 50, 50, { frameId: "fr" })]);
    const r = await image(b) as any;
    assert.match(r.text, /bounds x=0 y=80 w=200 h=121 \(board coordinates\), 2 elements/); // y 79.5 (100 - 20.5), rounded
    assert.deepEqual(fake.canvases, [{ width: 232, height: 153, scale: 1 }]); // 152.5 rounded up
    board.forgetBoard(b);
  });
});

test("get_image: an AI frame (magicframe) is measured like a frame: its name is above it and its children are clipped", async () => {
  await withoutLongTimers(async () => {
    const frame = { id: "mf", type: "magicframe", x: 0, y: 100, width: 200, height: 100, version: 1, isDeleted: false, name: null };
    const b = await heldWith([frame, rect("out", 150, 150, 20000, 20, { frameId: "mf" })]);
    const r = await image(b) as any;
    assert.match(r.text, /bounds x=0 y=80 w=200 h=121 /);
    assert.deepEqual(fake.canvases, [{ width: 232, height: 153, scale: 1 }]);
    board.forgetBoard(b);
  });
});

test("get_image: a child of a frame that sticks out of it does not stretch the picture, as Excalidraw clips it", async () => {
  await withoutLongTimers(async () => {
    const frame = { id: "fr", type: "frame", x: 0, y: 0, width: 200, height: 100, version: 1, isDeleted: false, name: "F" };
    const b = await heldWith([frame, rect("out", 150, 50, 20000, 20, { frameId: "fr" })]); // 20000 wide: would be TOO_LARGE by its own box
    const r = await image(b) as any;
    assert.match(r.text, /bounds x=0 y=-20 w=200 h=121 /); // the frame and its name above it (20.5); the child adds nothing
    assert.deepEqual(fake.canvases, [{ width: 232, height: 153, scale: 1 }]);
    board.forgetBoard(b);
  });
});

test("get_image: a scale that would make the picture under 1 px on a side is BAD_ARGS, and any other is rounded up to whole pixels", async () => {
  await withoutLongTimers(async () => {
    const b = await heldWith([rect("a", 0, 0, 10, 10)]);
    await assert.rejects(image(b, { scale: 0.02 }), { code: "BAD_ARGS", message: /smaller than 1 px.*larger scale/ }); // 42 x 0.02 = 0.84 px
    assert.equal(fake.canvases.length, 0);
    await image(b, { scale: 0.15 }); // 6.3 px: seven
    assert.deepEqual(fake.canvases, [{ width: 7, height: 7, scale: 0.15 }]);
    board.forgetBoard(b);
  });
});

test("get_image on a board this window does not hold is NOT_HOLDER, and on an unknown board NO_BOARD", async () => {
  await withoutLongTimers(async () => {
    const theirs = fresh();
    fake.take = async () => ({ state: "busy" });
    await assert.rejects(image(theirs), { code: "NOT_HOLDER" });
    await assert.rejects(image("b_unknown"), { code: "NO_BOARD" });
    assert.equal(fake.exports.length, 0);
    board.forgetBoard(theirs);
  });
});

// ---- get_image: the scopes refs, rect and selection

/** A fake canvas for the board b: it shows els, has selected the ids, and records every write to it. */
function goLive(b: string, els: any[], selected: string[] = [], files: unknown = { live: true }) {
  const selectedElementIds = Object.fromEntries(selected.map((i) => [i, true]));
  const calls: string[] = [];
  const api = {
    getAppState: () => ({ selectedElementIds, viewBackgroundColor: "#112233" }),
    getSceneElementsIncludingDeleted: () => els,
    getFiles: () => files,
    updateScene: () => { calls.push("updateScene"); },
    scrollToContent: () => { calls.push("scrollToContent"); },
  };
  board.setLive(b, api);
  store.setState({ sel: { board: b, run: null, chat: null } });
  return { api, calls, selectedElementIds };
}
const idsOf = (n = 0) => fake.exports[n].elements.map((e: any) => e.id);
/** A scene of: boxes a (with a label ta, key "A") and b (key "B"), an arrow ab between them with a label tab, and c far away. */
const scene = () => [
  rect("a", 0, 0, 100, 50, { customData: { key: "A" } }),
  { id: "ta", type: "text", x: 10, y: 10, width: 20, height: 10, version: 1, isDeleted: false, containerId: "a", text: "A" },
  rect("b", 300, 0, 100, 50, { customData: { key: "B" } }),
  { id: "ab", type: "arrow", x: 100, y: 25, width: 200, height: 0, points: [[0, 0], [200, 0]], version: 1, isDeleted: false, startBinding: { elementId: "a" }, endBinding: { elementId: "b" } },
  { id: "tab", type: "text", x: 180, y: 10, width: 20, height: 10, version: 1, isDeleted: false, containerId: "ab", text: "to" },
  rect("c_long_id_0001", 1000, 1000, 40, 40, { customData: { key: "C" } }),
  rect("gone", 0, 0, 10, 10, { isDeleted: true, customData: { key: "G" } }),
];

test("get_image refs: a key and an id in one call draw exactly those elements and their bound text", async () => {
  await withoutLongTimers(async () => {
    const b = await heldWith(scene());
    const r = await image(b, { scope: "refs", refs: [{ key: "A" }, { id: "c_long_id_0001" }] }) as any;
    assert.deepEqual(idsOf(), ["a", "ta", "c_long_id_0001"]);
    assert.equal(r.text, `scope refs, bounds x=0 y=0 w=1040 h=1040 (board coordinates), 2 elements, Board ${b} (${b})`);
    assert.equal(r.image.mimeType, "image/png");
    await image(b, { scope: "refs", refs: [{ id: "ab" }] }); // an arrow brings its label, not the boxes it joins
    assert.deepEqual(idsOf(1), ["ab", "tab"]);
    board.forgetBoard(b);
  });
});

test("get_image refs: an id shortened to a unique prefix works as in apply; an ambiguous or unknown one is UNKNOWN_REF", async () => {
  await withoutLongTimers(async () => {
    const b = await heldWith(scene());
    await image(b, { scope: "refs", refs: [{ id: "c_long" }] });
    assert.deepEqual(idsOf(), ["c_long_id_0001"]);
    await assert.rejects(image(b, { scope: "refs", refs: [{ id: "zz" }] }), { code: "UNKNOWN_REF", message: /\{"id":"zz"\}/ });
    await assert.rejects(image(b, { scope: "refs", refs: [{ id: "t" }] }), { code: "UNKNOWN_REF" }); // ta, tab: not unique
    assert.equal(fake.exports.length, 1);
    board.forgetBoard(b);
  });
});

test("get_image refs: any ref that matches nothing is UNKNOWN_REF, naming it, and nothing is drawn; a deleted element does not match", async () => {
  await withoutLongTimers(async () => {
    const b = await heldWith(scene());
    await assert.rejects(image(b, { scope: "refs", refs: [{ key: "A" }, { key: "nope" }, { id: "b" }] }),
      (e: any) => e.code === "UNKNOWN_REF" && /\{"key":"nope"\}/.test(e.message) && !/"A"/.test(e.message) && /read_board/.test(e.message));
    await assert.rejects(image(b, { scope: "refs", refs: [{ key: "G" }] }), { code: "UNKNOWN_REF" });
    await assert.rejects(image(b, { scope: "refs", refs: [{ id: "gone" }] }), { code: "UNKNOWN_REF" });
    assert.equal(fake.exports.length, 0);
    board.forgetBoard(b);
  });
});

test("get_image refs: no refs, or a ref without key and id, is BAD_ARGS", async () => {
  await withoutLongTimers(async () => {
    const b = await heldWith(scene());
    for (const args of [{ scope: "refs" }, { scope: "refs", refs: [] }, { scope: "refs", refs: "A" }, { scope: "refs", refs: [{}] }, { scope: "refs", refs: [{ key: "A" }, 3] }])
      await assert.rejects(image(b, args), { code: "BAD_ARGS" }, JSON.stringify(args));
    assert.equal(fake.exports.length, 0);
    board.forgetBoard(b);
  });
});

test("get_image rect: only elements completely inside are drawn, arrows by every point; none inside is EMPTY", async () => {
  await withoutLongTimers(async () => {
    const b = await heldWith(scene());
    const at = (x: number, y: number, width: number, height: number) => ({ scope: "rect", rect: { x, y, width, height } });
    // a and its label fit; the arrow starts at x=100 and runs to 300, b is at 300..400
    const r = await image(b, at(-10, -10, 120, 80)) as any;
    assert.deepEqual(idsOf(0), ["a", "ta"]);
    assert.equal(r.text, `scope rect, bounds x=0 y=0 w=100 h=50 (board coordinates), 1 element, Board ${b} (${b})`);
    await image(b, at(0, 0, 400, 50)); // exactly the box around a, the arrow and b: all of them fit, c does not
    assert.deepEqual(idsOf(1), ["a", "ta", "b", "ab", "tab"]);
    await image(b, at(0, 0, 399, 50)); // b sticks out by 1
    assert.deepEqual(idsOf(2), ["a", "ta", "ab", "tab"]);
    await image(b, at(0, 0, 250, 50)); // the arrow's end point is outside
    assert.deepEqual(idsOf(3), ["a", "ta"]);
    await image(b, at(100, 0, 200, 50)); // a ends at x=100 and touches the rect from outside
    assert.deepEqual(idsOf(4), ["ab", "tab"]);
    const n = fake.exports.length;
    await assert.rejects(image(b, at(100, 0, 150, 50)), { code: "EMPTY" }); // the arrow sticks out; a and b only touch / lie outside
    await assert.rejects(image(b, at(5000, 5000, 10, 10)), { code: "EMPTY" });
    await assert.rejects(image(b, at(-1000, -1000, 5, 5)), { code: "EMPTY" });
    assert.equal(fake.exports.length, n);
    board.forgetBoard(b);
  });
});

test("get_image rect: a missing or invalid rect is BAD_ARGS", async () => {
  await withoutLongTimers(async () => {
    const b = await heldWith(scene());
    const rects: unknown[] = [undefined, {}, { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: 10, height: -1 }, { x: NaN, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: Infinity, height: 10 }, { x: "0", y: 0, width: 10, height: 10 }];
    for (const rect of rects) await assert.rejects(image(b, { scope: "rect", rect }), { code: "BAD_ARGS" }, JSON.stringify(rect));
    assert.equal(fake.exports.length, 0);
    board.forgetBoard(b);
  });
});

test("get_image selection: draws the selected elements of the board on screen, with the bound text of the selected containers", async () => {
  await withoutLongTimers(async () => {
    const els = scene();
    const b = await heldWith(els);
    goLive(b, els, ["b", "ab", "gone", "nothing"]); // a deleted or unknown id in the selection draws nothing
    const r = await image(b, { scope: "selection" }) as any;
    assert.deepEqual(idsOf(), ["b", "ab", "tab"]);
    assert.equal(r.text, `scope selection, bounds x=100 y=0 w=300 h=50 (board coordinates), 2 elements, Board ${b} (${b})`);
    assert.equal(fake.exports[0].appState.viewBackgroundColor, "#112233"); // the live canvas' state and files
    assert.deepEqual(fake.exports[0].files, { live: true });
    board.forgetBoard(b);
  });
});

test("get_image selection: a selected frame is drawn alone; its children are not added", async () => {
  await withoutLongTimers(async () => {
    const els = [{ id: "fr", type: "frame", x: 0, y: 0, width: 200, height: 200, version: 1, isDeleted: false }, rect("kid", 10, 10, 20, 20, { frameId: "fr" })];
    const b = await heldWith(els);
    goLive(b, els, ["fr"]);
    await image(b, { scope: "selection" });
    assert.deepEqual(idsOf(), ["fr"]);
    board.forgetBoard(b);
  });
});

test("get_image selection: nothing selected, or the board is not on screen, is NO_SELECTION naming all, refs and rect", async () => {
  await withoutLongTimers(async () => {
    const els = scene();
    const b = await heldWith(els);
    const names = (e: any) => e.code === "NO_SELECTION" && /scope all, refs or rect/.test(e.message);
    await assert.rejects(image(b, { scope: "selection" }), (e: any) => names(e) && /not on the user's screen/.test(e.message)); // stored scene only
    goLive(b, els, []);
    await assert.rejects(image(b, { scope: "selection" }), (e: any) => names(e) && /nothing is selected/.test(e.message));
    goLive(b, els, ["a"]);
    store.setState({ sel: { board: "b_other", run: null, chat: null } }); // the canvas is the board's but the user looks at another board
    await assert.rejects(image(b, { scope: "selection" }), (e: any) => names(e) && /not on the user's screen/.test(e.message));
    board.setLive("b_other", {} as any); // another board's canvas is on screen
    store.setState({ sel: { board: b, run: null, chat: null } });
    await assert.rejects(image(b, { scope: "selection" }), names);
    assert.equal(fake.exports.length, 0);
    board.forgetBoard(b);
  });
});

test("get_image default scope: the selection when the board is on screen and something is selected, else all; the text says which", async () => {
  await withoutLongTimers(async () => {
    const els = scene();
    const b = await heldWith(els);
    const text = async (args: unknown = {}) => ((await image(b, args)) as any).text as string;
    assert.match(await text(), /^scope all, /); // not on screen
    goLive(b, els, []);
    assert.match(await text(), /^scope all, /); // on screen, nothing selected
    assert.deepEqual(idsOf(1), ["a", "ta", "b", "ab", "tab", "c_long_id_0001"]);
    goLive(b, els, ["c_long_id_0001"]);
    assert.match(await text(), /^scope selection, .* 1 element, /);
    assert.deepEqual(idsOf(2), ["c_long_id_0001"]);
    assert.match(await text({ scope: "all" }), /^scope all, /); // an explicit scope wins over the selection
    assert.equal(idsOf(3).length, 6);
    store.setState({ sel: { board: "b_other", run: null, chat: null } });
    assert.match(await text(), /^scope all, /); // the canvas is still this board's, but the user looks at another one
    board.forgetBoard(b);
  });
});

test("get_image: all, refs and rect work on a board that is not on screen (its stored scene), while another board is live", async () => {
  await withoutLongTimers(async () => {
    const mine = await heldWith(scene());
    const other = await heldWith([rect("o", 0, 0, 10, 10)]);
    goLive(other, [rect("o", 0, 0, 10, 10)], ["o"]);
    await image(mine, { scope: "all" });
    await image(mine, { scope: "refs", refs: [{ key: "B" }] });
    await image(mine, { scope: "rect", rect: { x: 0, y: 0, width: 120, height: 60 } });
    await image(mine); // default: this board has no selection, whatever is selected on the other one
    assert.deepEqual([0, 1, 2, 3].map((i) => idsOf(i).length), [6, 1, 2, 6]);
    assert.deepEqual(idsOf(1), ["b"]);
    board.forgetBoard(mine); board.forgetBoard(other);
  });
});

test("get_image leaves the scene, its version, the selection and the autosave state alone", async () => {
  await withoutLongTimers(async () => {
    const els = scene();
    const b = await heldWith(els);
    const live = goLive(b, els, ["a", "b"]);
    const before = { elements: JSON.stringify(els), version: board.scenes.get(b).version, rev: board.scenes.get(b).rev, selected: JSON.stringify(live.selectedElementIds) };
    asked();
    for (const args of [{}, { scope: "all" }, { scope: "selection" }, { scope: "refs", refs: [{ key: "C" }] }, { scope: "rect", rect: { x: 0, y: 0, width: 500, height: 100 } }])
      await image(b, args);
    for (const args of [{ scope: "refs", refs: [{ key: "X" }] }, { scope: "rect", rect: { x: 9e3, y: 9e3, width: 1, height: 1 } }])
      await assert.rejects(image(b, args));
    assert.equal(JSON.stringify(els), before.elements);
    assert.equal(board.scenes.get(b).version, before.version);
    assert.equal(board.scenes.get(b).rev, before.rev);
    assert.equal(JSON.stringify(live.selectedElementIds), before.selected);
    assert.deepEqual(live.calls, []); // no updateScene, no scrollToContent on the canvas
    assert.equal(board.hasPendingSaves(), false);
    await tick();
    assert.deepEqual(asked(), []); // nothing was saved or read
    assert.equal(fake.exports.length, 5);
    board.forgetBoard(b);
  });
});

test("get_image: an exportToBlob that throws is a RENDER_FAILED text error, not a bare rejection", async () => {
  await withoutLongTimers(async () => {
    const b = await heldWith(scene());
    const was = fake.png;
    fake.exportError = new Error("canvas is tainted");
    try {
      await assert.rejects(image(b), (e: any) => e.code === "RENDER_FAILED" && e.message === "the picture could not be drawn: canvas is tainted");
      fake.exportError = "plain string";
      await assert.rejects(image(b), { code: "RENDER_FAILED", message: "the picture could not be drawn: plain string" });
    } finally { fake.exportError = undefined; fake.png = was; }
    // the page turns it into the error text "RENDER_FAILED: ..." (conn.ts answer): the shape is {code, message}
    await image(b); // and the next call works
    board.forgetBoard(b);
  });
});

test("get_image waits for document.fonts.ready before it draws, and survives a fonts promise that rejects", async () => {
  await withoutLongTimers(async () => {
    const b = await heldWith(scene());
    const had = Object.getOwnPropertyDescriptor(globalThis, "document");
    try {
      let ready!: () => void;
      (globalThis as any).document = { fonts: { ready: new Promise<void>((r) => { ready = r; }) } };
      const p = image(b);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(fake.exports.length, 0); // still waiting for the fonts
      ready();
      await p;
      assert.equal(fake.exports.length, 1);
      (globalThis as any).document = { fonts: { ready: Promise.reject(new Error("no fonts")) } };
      await image(b);
      assert.equal(fake.exports.length, 2);
    } finally {
      if (had) Object.defineProperty(globalThis, "document", had); else delete (globalThis as any).document;
    }
    board.forgetBoard(b);
  });
});

test("get_image: a board that leaves the screen while the fonts load still draws the selection it took", async () => {
  await withoutLongTimers(async () => {
    const els = scene();
    const b = await heldWith(els);
    goLive(b, els, ["a"]);
    const had = Object.getOwnPropertyDescriptor(globalThis, "document");
    try {
      let ready!: () => void;
      (globalThis as any).document = { fonts: { ready: new Promise<void>((r) => { ready = r; }) } };
      const p = image(b);
      await new Promise((r) => setTimeout(r, 20));
      board.setLive(null, null); // the user switched boards
      ready();
      const r = await p as any;
      assert.match(r.text, /^scope selection, /);
      assert.deepEqual(idsOf(), ["a", "ta"]);
      assert.deepEqual(fake.exports[0].files, { live: true });
    } finally {
      if (had) Object.defineProperty(globalThis, "document", had); else delete (globalThis as any).document;
    }
    board.forgetBoard(b);
  });
});

test("get_image pads the picture by EXPORT_PADDING", async () => {
  await withoutLongTimers(async () => {
    const b = await heldWith(scene());
    await image(b);
    assert.equal(fake.exports[0].exportPadding, EXPORT_PADDING);
    board.forgetBoard(b);
  });
});

// ---- get_image: rotated elements, elements without extent, the UNKNOWN_REF wording

test("get_image: a rotated element is sized, reported and tested for containment by its rotated box", async () => {
  await withoutLongTimers(async () => {
    const b = await heldWith([rect("r", 100, 50, 200, 100, { angle: Math.PI / 4 })]);
    const t = ((await image(b)) as any).text as string;
    assert.match(t, /bounds x=94 y=-6 w=212 h=212 /); // not x=100 y=50 w=200 h=100
    // the limit is judged on the rotated size: 6000x100 turned 45deg is 4346 px a side, 18.9 MP; at 1.5x 6519 px a side and 42.5 MP
    const big = await heldWith([rect("r", 0, 0, 6000, 100, { angle: Math.PI / 4 })]);
    await image(big);
    await assert.rejects(image(big, { scale: 1.5 }), (e: any) => e.code === "TOO_LARGE" && /6519x6519 px/.test(e.message));
    // rect: the unrotated box fits in it, the rotated one does not
    const n = fake.exports.length;
    await assert.rejects(image(b, { scope: "rect", rect: { x: 90, y: 40, width: 220, height: 120 } }), { code: "EMPTY" });
    await image(b, { scope: "rect", rect: { x: 80, y: -10, width: 240, height: 220 } });
    assert.equal(fake.exports.length, n + 1);
    board.forgetBoard(b); board.forgetBoard(big);
  });
});

test("get_image: chosen elements that are all zero-size are EMPTY and exportToBlob is not called", async () => {
  await withoutLongTimers(async () => {
    const els = [rect("dot", 10, 10, 0, 0, { customData: { key: "DOT" } }), rect("dot2", 40, 40, 0, 0), rect("box", 500, 500, 50, 50)];
    const b = await heldWith(els);
    await assert.rejects(image(b, { scope: "refs", refs: [{ key: "DOT" }] }), { code: "EMPTY", message: /no extent/ });
    await assert.rejects(image(b, { scope: "rect", rect: { x: 0, y: 0, width: 20, height: 20 } }), { code: "EMPTY", message: /no extent/ });
    assert.equal(fake.exports.length, 0);
    const live = goLive(b, els, ["dot"]);
    await assert.rejects(image(b, { scope: "selection" }), { code: "EMPTY", message: /no extent/ });
    assert.equal(fake.exports.length, 0);
    assert.deepEqual(live.calls, []);
    // two zero-size elements far apart are still nothing: their positions are not an extent
    await assert.rejects(image(b, { scope: "refs", refs: [{ id: "dot" }, { id: "dot2" }] }), { code: "EMPTY", message: /no extent/ });
    assert.equal(fake.exports.length, 0);
    await image(b, { scope: "refs", refs: [{ id: "box" }] });
    assert.equal(fake.exports.length, 1);
    board.forgetBoard(b);
  });
});

test("get_image: a zero-size element among real ones is not drawn, not measured and not counted", async () => {
  await withoutLongTimers(async () => {
    // the dot sits far from the 50x50 box; Excalidraw draws only the box (82x82), and so must the bounds, the limit and the count say
    const els = [
      rect("dot", 10, 10, 0, 0),
      { id: "a1", type: "arrow", x: 5000, y: 5000, width: 0, height: 0, points: [[0, 0], [0, 0]], version: 1, isDeleted: false }, // two equal points draw nothing
      { id: "p1", type: "freedraw", x: 9000, y: 9000, width: 0, height: 0, points: [[0, 0]], version: 1, isDeleted: false },
      rect("box", 500, 500, 50, 50),
    ];
    const b = await heldWith(els);
    const r = (await image(b, { scope: "all" })) as any;
    assert.match(r.text, /^scope all, bounds x=500 y=500 w=50 h=50 \(board coordinates\), 1 element, /);
    assert.deepEqual(fake.exports[0].elements.map((e: any) => e.id), ["box"]);
    // the same through refs and through rect, which holds the dot too
    const r2 = (await image(b, { scope: "refs", refs: [{ id: "dot" }, { id: "box" }] })) as any;
    assert.match(r2.text, /bounds x=500 y=500 w=50 h=50 .*, 1 element, /);
    const r3 = (await image(b, { scope: "rect", rect: { x: 0, y: 0, width: 600, height: 600 } })) as any;
    assert.match(r3.text, /bounds x=500 y=500 w=50 h=50 .*, 1 element, /);
    assert.deepEqual(fake.exports.map((x: any) => x.elements.map((e: any) => e.id)), [["box"], ["box"], ["box"]]);
    // the picture is judged on what is drawn: with the dot counted it would be 100000 px a side and refused, the box alone is 82
    const far = await heldWith([rect("d", 0, 0, 0, 0), rect("far", 100000, 100000, 50, 50)]);
    const r4 = (await image(far)) as any;
    assert.match(r4.text, /bounds x=100000 y=100000 w=50 h=50 /);
    board.forgetBoard(b); board.forgetBoard(far);
  });
});

test("get_image: a straight line has an extent in one direction, so it passes the EMPTY check and is drawn", async () => {
  await withoutLongTimers(async () => {
    const line = (id: string, points: number[][], o = {}) => ({ id, type: "line", x: 100, y: 50, width: Math.max(...points.map((p) => p[0])), height: Math.max(...points.map((p) => p[1])), points, version: 1, isDeleted: false, ...o });
    const b = await heldWith([line("h", [[0, 0], [200, 0]]), line("v", [[0, 0], [0, 120]], { x: 400 }), line("turned", [[0, 0], [200, 0]], { y: 300, angle: Math.PI / 2 })]);
    const h = (await image(b, { scope: "refs", refs: [{ id: "h" }] })) as any;
    assert.match(h.text, /bounds x=100 y=50 w=200 h=0 .*, 1 element, /);
    const v = (await image(b, { scope: "refs", refs: [{ id: "v" }] })) as any;
    assert.match(v.text, /bounds x=400 y=50 w=0 h=120 .*, 1 element, /);
    const t = (await image(b, { scope: "refs", refs: [{ id: "turned" }] })) as any;
    assert.match(t.text, /bounds x=200 y=200 w=0 h=200 .*, 1 element, /); // a horizontal line turned a quarter is vertical
    assert.equal(fake.exports.length, 3);
    board.forgetBoard(b);
  });
});

test("get_image: rotated text is measured by its rotated box", async () => {
  await withoutLongTimers(async () => {
    const text = { id: "t1", type: "text", x: 100, y: 50, width: 60, height: 20, text: "Hello", angle: Math.PI / 6, version: 1, isDeleted: false };
    const b = await heldWith([text]);
    // 60x20 turned 30deg: 61.96 x 47.32, around the centre (130, 60)
    assert.match(((await image(b)) as any).text, /bounds x=99 y=36 w=62 h=47 .*, 1 element, /);
    // rect: the unrotated 60x20 fits in this one, the rotated box does not
    await assert.rejects(image(b, { scope: "rect", rect: { x: 100, y: 50, width: 60, height: 20 } }), { code: "EMPTY" });
    await image(b, { scope: "rect", rect: { x: 95, y: 30, width: 70, height: 60 } });
    board.forgetBoard(b);
  });
});

test("get_image refs: an ambiguous id prefix says ambiguous, a missing one says no element matches, both can be in one message", async () => {
  await withoutLongTimers(async () => {
    const b = await heldWith(scene());
    await assert.rejects(image(b, { scope: "refs", refs: [{ id: "t" }] }),
      (e: any) => e.code === "UNKNOWN_REF" && /\{"id":"t"\} is ambiguous/.test(e.message) && !/no element/.test(e.message));
    await assert.rejects(image(b, { scope: "refs", refs: [{ id: "zz" }] }),
      (e: any) => e.code === "UNKNOWN_REF" && /no element on .* matches \{"id":"zz"\}/.test(e.message) && !/ambiguous/.test(e.message));
    await assert.rejects(image(b, { scope: "refs", refs: [{ id: "t" }, { id: "zz" }, { key: "nope" }] }),
      (e: any) => /no element on .* matches \{"id":"zz"\}, \{"key":"nope"\}/.test(e.message) && /\{"id":"t"\} is ambiguous/.test(e.message));
    assert.equal(fake.exports.length, 0);
    board.forgetBoard(b);
  });
});
