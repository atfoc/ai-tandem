// A `load` of the board that is shown is carried out in place (D6b of plans/headless-board/architecture.md): the endpoint (src/endpoint.ts)
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
x.document = {};

const stand = `
  export const exportToBlob = () => {}; export const getCommonBounds = () => [];
  export const convertToExcalidrawElements = (v) => v; export const newElementWith = (e, p) => ({ ...e, ...p });
  export const restoreElements = (v) => v; export const CaptureUpdateAction = { NEVER: "NEVER", IMMEDIATELY: "IMMEDIATELY" };
  export const FONT_FAMILY = { Nunito: 6 }; export const ROUNDNESS = {}; export const Excalidraw = () => null;`;
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-inplace-")), "endpoint.mjs");
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
let fake: ReturnType<typeof fakeApi>;
const draw = async () => { // the first load of a board, as Excalidraw draws it: the api, then the first onChange
  const g = store.get().shown!.gen;
  scene = { elements: [...(store.get().shown!.initialData as { elements: El[] }).elements], files: {}, appState: { scrollX: 1, scrollY: 2, zoom: { value: 1 }, width: 800, height: 600, selectedElementIds: {} } };
  fake = fakeApi(hooks, () => g, scene);
  hooks.api(g, fake.api);
  hooks.change(g, scene.elements, scene.appState, scene.files);
  await wait(20);
};
beforeEach(() => {
  sent = [];
  ep = createEndpoint((m) => { sent.push(m); });
  ({ store, hooks } = ep.mount().props);
});
const count = (t: string) => sent.filter((m) => m.t === t).length;

test("a load of the board that is shown is applied in place: the same Excalidraw (its key), updateScene with no undo step, loaded again", async () => {
  ep.receive(load("b1", [el("a"), el("b")]));
  const first = store.get().shown!;
  await draw();
  assert.equal(count("loaded"), 1);
  scene.appState.scrollX = 500; scene.appState.scrollY = 600; scene.appState.zoom = { value: 2 }; // the reader scrolled and zoomed
  sent.length = 0;

  ep.receive(load("b1", [el("a", 2), el("b"), el("c")], { viewMode: true, theme: { mode: "dark", filter: null }, style: { currentItemStrokeColor: "#e03131" } }));
  const now = store.get();
  assert.equal(now.shown, first, "the shown board is the very object it was: Excalidraw is not keyed anew");
  assert.equal(now.shown!.gen, first.gen);
  assert.equal(fake.calls.updateScene.length, 1, "updateScene once");
  const u = fake.calls.updateScene[0];
  assert.deepEqual(u.elements.map((e: El) => e.id), ["a", "b", "c"]);
  assert.equal(u.captureUpdate, "NEVER", "no undo step");
  assert.equal(fake.calls.cleared, 1, "the undo stacks of the old scene are dropped");
  assert.equal("scrollX" in u.appState || "zoom" in u.appState, false, "scroll and zoom are not sent: the reader's stay");
  assert.equal(scene.appState.scrollX, 500); assert.deepEqual(scene.appState.zoom, { value: 2 });
  assert.equal(u.appState.viewBackgroundColor, "#ffffff");
  assert.equal(u.appState.currentItemStrokeColor, "#e03131", "the style of the message");
  assert.equal(now.viewMode, true, "viewMode of the message"); assert.equal(now.theme.mode, "dark", "theme of the message");
  await wait(40);
  assert.equal(count("loaded"), 1, "loaded is posted again");
  assert.equal(sent.find((m) => m.t === "loaded")!.t === "loaded" && (sent.find((m) => m.t === "loaded") as { board: string }).board, "b1");
});

test("an in-place load resets the baseline to the loaded scene: the update itself causes no `changed`, a later edit is a delta from it", async () => {
  ep.receive(load("b1", [el("a"), el("b")]));
  await draw();
  sent.length = 0;
  ep.receive(load("b1", [el("a", 5), el("b"), el("c", 3)]));
  await wait(CHANGED_EVERY + 150);
  assert.equal(count("changed"), 0, "the update caused no `changed`");
  // the person (or an agent) now edits `c`: the delta is against the loaded scene, not the one before it
  const next = scene.elements.map((e) => (e.id === "c" ? { ...e, version: 4 } : e));
  scene.elements = next;
  hooks.change(store.get().shown!.gen, next, scene.appState, scene.files);
  await wait(CHANGED_EVERY + 150);
  const changed = sent.filter((m) => m.t === "changed") as Extract<FromBoard, { t: "changed" }>[];
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0].elements.map((e) => [e.id, e.version]), [["c", 4]], "only the edit");
  assert.equal(changed[0].order, undefined);
});

test("an in-place load adds the files that are not there yet, and only those; the selection loses elements that are gone", async () => {
  ep.receive(load("b1", [el("a"), el("b")], { scene: { elements: [el("a"), el("b")], files: { f1: file("f1") }, appState: {} } }));
  await draw();
  scene.files.f1 = file("f1");
  scene.appState.selectedElementIds = { a: true, b: true };
  sent.length = 0;
  ep.receive(load("b1", [el("a")], { scene: { elements: [el("a")], files: { f1: file("f1"), f2: file("f2") }, appState: {} } }));
  assert.deepEqual(fake.calls.addFiles.map((l: { id: string }[]) => l.map((f) => f.id)), [["f2"]], "f2 only");
  assert.deepEqual(fake.calls.updateScene[0].appState.selectedElementIds, { a: true });
  await wait(CHANGED_EVERY + 150);
  assert.equal(count("changed"), 0, "the files of the message are the baseline's: nothing to tell");
});

test("a load of another board, or after unload, is a new Excalidraw as before", async () => {
  ep.receive(load("b1", [el("a")]));
  const first = store.get().shown!;
  await draw();
  ep.receive(load("b2", [el("z")]));
  assert.notEqual(store.get().shown!.gen, first.gen, "another board: a new gen");
  assert.equal(fake.calls.updateScene.length, 0);
  await draw();
  ep.receive({ t: "unload" });
  ep.receive(load("b2", [el("z")]));
  assert.ok(store.get().shown!.gen > first.gen + 1, "after unload: a new gen again");
  assert.equal(fake.calls.updateScene.length, 0, "and no update in place on the old API");
});

test("a load of the shown board before Excalidraw is up (no api yet) is a new start", async () => {
  ep.receive(load("b1", [el("a")]));
  const first = store.get().shown!;
  ep.receive(load("b1", [el("a", 2)]));
  assert.equal(store.get().shown!.gen, first.gen + 1);
});
