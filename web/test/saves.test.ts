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

type Take = { state: "held" | "waiting" | "busy"; rev?: number };
type Fake = {
  scene: (id: string) => Promise<{ scene: unknown; rev: number }>;
  saveScene: (id: string, base: number, scene: any) => Promise<number>;
  take: (id: string, ifFree: boolean) => Promise<Take>;
  release: (id: string) => Promise<{ state: string }>;
  log: string[];        // what the page asked of the server, in order
  selects: unknown[][]; // the sidebar's select, as show_board calls it
};
const fake: Fake = { scene: async () => ({ scene: {}, rev: 0 }), saveScene: async (_, base) => base + 1, take: async () => ({ state: "held", rev: 0 }),
  release: async () => ({ state: "handed" }), log: [], selects: [] };
(globalThis as any).__saves = fake;

const stubs: Record<string, string> = {
  "@excalidraw/excalidraw": `
    export const restoreElements = (els) => els;
    export const getSceneVersion = (els) => els.reduce((n, e) => n + (e.version ?? 1), 0);
    export const newElementWith = (e, p) => ({ ...e, ...p });
    export const convertToExcalidrawElements = (els) => els;
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
  fake.log.length = 0; fake.selects.length = 0;
  fake.scene = stored(0); fake.saveScene = async (_, base) => base + 1;
  fake.take = async () => ({ state: "held", rev: 0 }); fake.release = async () => ({ state: "handed" });
  for (const b of Object.keys(st().boards)) board.forgetBoard(b); // what a failed test left
  board.streamOpened();
  store.setState({ boards: {}, roles: {}, dropped: {}, sceneGen: {}, sel: { board: null, run: null, chat: null } });
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
