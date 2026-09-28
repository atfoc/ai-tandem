// Board autosave (src/board.ts): a failed write counts as unsaved until a later
// write of that board succeeds. board.ts pulls in Excalidraw, the store, the api
// and the sidebar, so it is bundled with esbuild with those stubbed; the stubs
// read the test's fake boards and saveScene from globalThis.__saves.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

type Fake = { boards: Record<string, { id: string; archived?: boolean }>; saveScene: (id: string, scene: unknown) => Promise<unknown> };
const fake: Fake = { boards: {}, saveScene: async () => ({}) };
(globalThis as any).__saves = fake;

const stubs: Record<string, string> = {
  "@excalidraw/excalidraw": `
    export const restoreElements = (els) => els;
    export const getSceneVersion = (els) => els.reduce((n, e) => n + (e.version ?? 1), 0);
    export const newElementWith = (e, p) => ({ ...e, ...p });
    export const convertToExcalidrawElements = (els) => els;
    export const CaptureUpdateAction = {}; export const FONT_FAMILY = {}; export const ROUNDNESS = {};`,
  "./store.ts": `
    export const getState = () => ({ boards: globalThis.__saves.boards, chats: {}, groups: {}, sel: {}, view: {} });
    export const flash = () => {}; export const markBusy = () => {};`,
  "./api.ts": `
    export class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
    export const api = {
      scene: async () => ({ elements: [{ id: "e1", version: 1 }], appState: {}, files: {} }),
      saveScene: (id, scene) => globalThis.__saves.saveScene(id, scene),
    };`,
  "./Sidebar.tsx": `export const select = () => {};`,
};

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-saves-")), "board.mjs");
await esbuild.build({
  entryPoints: [path.join(web, "src/board.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{
    name: "stubs",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => (a.path in stubs ? { path: a.path, namespace: "stub" } : undefined));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
    },
  }],
});
const board = await import(pathToFileURL(out).href);
fs.rmSync(path.dirname(out), { recursive: true, force: true });

// the expression main.tsx gives the desktop app as window.aiwbFlush
const aiwbFlush = () => board.flushAll().then(() => !board.hasPendingSaves());

const quiet = console.error;
let id = 0;
/** A loaded board with one edit waiting to be saved. */
async function edited() {
  const b = `b_${++id}`;
  fake.boards[b] = { id: b };
  await board.loadScene(b);
  board.sceneChanged(b, [{ id: "e1", version: 2 }], {}, {});
  return b;
}
const down = () => { fake.saveScene = async () => { throw new TypeError("Failed to fetch"); }; };
const up = (writes: string[]) => { fake.saveScene = async (b) => { writes.push(b); return {}; }; };

beforeEach(() => { console.error = () => {}; });
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
  fake.boards[a].archived = true;
  delete fake.boards[r];
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
  board.sceneChanged(b, [{ id: "e1", version: 3 }], {}, {});
  await board.flush(b);
  assert.equal(board.hasPendingSaves(), false);
  down();
  board.sceneChanged(b, [{ id: "e1", version: 4 }], {}, {});
  await board.flush(b);
  assert.equal(board.hasPendingSaves(), true);
  board.forgetBoard(b);
});
