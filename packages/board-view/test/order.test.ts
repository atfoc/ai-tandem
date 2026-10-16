// The order of the requests on the live canvas and of the messages that change which board is shown (src/endpoint.ts `inOrder`, `afterLive`): the endpoint (src/endpoint.ts)
// bundled with esbuild, `@excalidraw/excalidraw` and the React component (Board.tsx) replaced by stand-ins. `mount()` returns an element
// whose props are the store and the hooks the component would get, so the test plays the component's part: it gives the endpoint a fake
// Excalidraw API (`hooks.api`) and tells it the changes (`hooks.change`) as Excalidraw's onChange does. The real thing, in Chromium, is the
// harness's "a reader's board follows a load in place" (dev/harness.mjs).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import type { El, FromBoard, ToBoard } from "@aiwb/board-bridge/messages.ts";
import type { BoardHooks, BoardStore } from "../src/Board.tsx";

type Endpoint = { receive(m: ToBoard): void; mount: () => { props: { store: BoardStore; hooks: BoardHooks } } };
const x = globalThis as unknown as { requestAnimationFrame: (f: () => void) => void; document: unknown };
x.requestAnimationFrame = (f) => { setTimeout(f, 0); };
// `document.fonts` as a page has it, with a `load` the test holds back: a request whose text needs a face waits for it
const loads: (() => void)[] = [];
const fonts = {
  has: () => false, add: () => {},
  load: () => new Promise<unknown[]>((r) => { loads.push(() => r([])); }),
};
x.document = { fonts };

const stand = `
  export const exportToBlob = () => {}; export const getCommonBounds = () => [];
  export const convertToExcalidrawElements = (v) => v; export const newElementWith = (e, p) => ({ ...e, ...p });
  export const restoreElements = (v) => v; export const CaptureUpdateAction = { NEVER: "NEVER", IMMEDIATELY: "IMMEDIATELY" };
  export const FONT_FAMILY = { Nunito: 6 }; export const ROUNDNESS = {}; export const Excalidraw = () => null;`;
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-order-")), "endpoint.mjs");
await esbuild.build({
  entryPoints: [path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/endpoint.ts")],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{
    name: "stand-ins",
    setup(b) {
      b.onResolve({ filter: /^@excalidraw\/excalidraw$/ }, () => ({ path: "excalidraw", namespace: "stand-in" }));
      b.onResolve({ filter: /\/Board\.tsx$/ }, () => ({ path: "board", namespace: "stand-in" }));
      b.onLoad({ filter: /^excalidraw$/, namespace: "stand-in" }, () => ({ contents: stand, loader: "js" }));
      b.onLoad({ filter: /^board$/, namespace: "stand-in" }, () => ({ contents: "export const Board = () => null;", loader: "js" }));
    },
  }],
});
const { createEndpoint, CHANGED_EVERY } = await import(pathToFileURL(out).href) as { createEndpoint: (post: (m: FromBoard) => void) => Endpoint; CHANGED_EVERY: number };
fs.rmSync(path.dirname(out), { recursive: true, force: true });

const el = (id: string, version = 1, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, version, isDeleted: false, ...extra }) as unknown as El;
const file = (id: string) => ({ mimeType: "image/png", id, dataURL: "data:image/png;base64,AA==", created: 1 });
const theme = { mode: "light" as const, filter: null };
const load = (board: string, elements: El[], over: Record<string, unknown> = {}): ToBoard => ({
  t: "load", board, viewMode: false, theme, style: {}, scene: { elements, files: {}, appState: { scrollX: 1, scrollY: 2, zoom: { value: 1 } } }, ...over,
}) as ToBoard;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake Excalidraw API over a scene; `updateScene` tells onChange the way Excalidraw does. */
function fakeApi(hooks: BoardHooks, gen: () => number, scene: { elements: El[]; files: Record<string, unknown>; appState: Record<string, unknown> }) {
  const calls: { updateScene: any[]; addFiles: any[]; cleared: number } = { updateScene: [], addFiles: [], cleared: 0 };
  const api = {
    getSceneElementsIncludingDeleted: () => scene.elements,
    getAppState: () => scene.appState,
    getFiles: () => scene.files,
    updateScene(o: { elements?: El[]; appState?: Record<string, unknown> }) {
      calls.updateScene.push(o);
      if (o.elements) scene.elements = o.elements;
      if (o.appState) scene.appState = { ...scene.appState, ...o.appState };
      hooks.change(gen(), scene.elements, scene.appState, scene.files);
    },
    addFiles(fs_: { id: string }[]) { calls.addFiles.push(fs_); for (const f of fs_) scene.files[f.id] = f; },
    history: { clear: () => { calls.cleared++; } },
  };
  return { api, calls };
}


let sent: FromBoard[];
let ep: Endpoint, store: BoardStore, hooks: BoardHooks;
let scene: { elements: El[]; files: Record<string, unknown>; appState: Record<string, unknown> };
const draw = async () => { // the first load of a board, as Excalidraw draws it: the api, then the first onChange
  const g = store.get().shown!.gen;
  scene = { elements: [...(store.get().shown!.initialData as { elements: El[] }).elements], files: {}, appState: { scrollX: 1, scrollY: 2, zoom: { value: 1 }, width: 800, height: 600, selectedElementIds: {} } };
  hooks.api(g, fakeApi(hooks, () => g, scene).api);
  hooks.change(g, scene.elements, scene.appState, scene.files);
  await wait(20);
};
beforeEach(() => {
  sent = [];
  loads.length = 0;
  ep = createEndpoint((m) => { sent.push(m); });
  ({ store, hooks } = ep.mount().props);
});
type Res = Extract<FromBoard, { t: "res" }>;
const res = (id: number) => sent.find((m) => m.t === "res" && m.id === id) as Res | undefined;
const snapshot = (id: number): ToBoard => ({ t: "req", id, op: { op: "snapshot" } }) as ToBoard;
const text = (id: number): ToBoard => ({ t: "req", id, op: { op: "apply", target: "live", rev: 1, params: { create: [{ type: "text", key: `t${id}`, text: "hi", x: 0, y: 0 }] } } }) as ToBoard;
const ids = (r: Res) => ((r as { value: { elements: El[] } }).value.elements).map((e) => e.id);

test("a snapshot and an unload in the same tick: the snapshot answers the scene, not NO_BOARD (the board is unloaded after it)", async () => {
  ep.receive(load("b1", [el("a"), el("b")]));
  await draw();
  ep.receive(snapshot(1));
  ep.receive({ t: "unload" });
  assert.equal(store.get().shown, null, "(the snapshot ran at once, so nothing was pending: unload ran at once too)");
  await wait(20);
  const r = res(1)!;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(ids(r), ["a", "b"]);
  assert.equal((r as { value: { board: string } }).value.board, "b1");
});

test("an idle snapshot runs in the same tick: the board is read before receive returns", async () => {
  ep.receive(load("b1", [el("a")]));
  await draw();
  scene.elements = [...scene.elements, el("late")];
  ep.receive(snapshot(1));
  scene.elements = [...scene.elements, el("after")]; // (a change that comes after receive returns is not in the reply)
  await wait(20);
  assert.deepEqual(ids(res(1)!), ["a", "late"]);
});

test("an apply waiting for a face, then a snapshot, then an unload: answered in order, the snapshot has the apply's element, then the board is unloaded", async () => {
  ep.receive(load("b1", [el("a")]));
  await draw();
  ep.receive(text(1));
  ep.receive(snapshot(2));
  ep.receive({ t: "unload" });
  await wait(20);
  assert.equal(res(1), undefined, "the apply waits for the face");
  assert.equal(res(2), undefined, "the snapshot does not overtake it");
  assert.notEqual(store.get().shown, null, "the unload waits behind them");
  assert.equal(loads.length, 1, "the apply asked for its face");
  loads[0]();
  await wait(20);
  const order = sent.filter((m) => m.t === "res").map((m) => (m as Res).id);
  assert.deepEqual(order, [1, 2]);
  assert.equal(res(1)!.ok, true, JSON.stringify(res(1)));
  const snap = res(2)!;
  assert.equal(snap.ok, true, JSON.stringify(snap));
  assert.equal(ids(snap).length, 2, "the snapshot has the element the apply made");
  assert.equal(store.get().shown, null, "then the board is unloaded");
});

test("a load behind a pending apply replaces the board after the apply is answered; a viewMode behind it is not lost", async () => {
  ep.receive(load("b1", [el("a")]));
  await draw();
  ep.receive(text(1));
  ep.receive(load("b2", [el("z")], { viewMode: false }));
  ep.receive({ t: "viewMode", on: true });
  assert.equal(store.get().shown!.board, "b1", "b2 waits");
  loads[0]();
  await wait(20);
  assert.equal(res(1)!.ok, true);
  assert.equal(store.get().shown!.board, "b2");
  assert.equal(store.get().viewMode, true, "the viewMode that came after the load came after it");
});

test("a request that fails does not stop the queue", async () => {
  ep.receive(load("b1", [el("a")]));
  await draw();
  ep.receive(text(1));
  ep.receive({ t: "req", id: 2, op: { op: "apply", target: "live", rev: 1, params: { update: [{ ref: { id: "nope" }, x: 1 }] } } } as ToBoard);
  ep.receive(snapshot(3));
  loads[0]();
  await wait(20);
  loads[1]?.(); // (the second apply re-measures the text the first one made: it asks for the face too)
  await wait(20);
  assert.equal(res(1)!.ok, true);
  assert.equal(res(2)!.ok, false);
  assert.equal(res(3)!.ok, true);
});
