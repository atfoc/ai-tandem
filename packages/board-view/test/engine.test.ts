// The requests on given elements (src/engine.ts) over a stand-in for Excalidraw: the module is bundled with esbuild, so the test
// proves what engine.ts itself does (the live target refused, the reply mapping of `answer`, the elements a request hands back); the
// real Excalidraw runs the same code in dev/harness.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import type { El, EngineOp, FromBoard } from "@aiwb/board-bridge/messages.ts";

const stand = `
  export const exportToBlob = () => {}; export const getCommonBounds = () => [];
  export const convertToExcalidrawElements = (v) => v; export const newElementWith = (e, p) => ({ ...e, ...p });
  export const restoreElements = (v) => v.map((e) => ({ ...e, restored: true }));
  export const CaptureUpdateAction = { NEVER: "NEVER", IMMEDIATELY: "IMMEDIATELY" }; export const FONT_FAMILY = { Nunito: 6 }; export const ROUNDNESS = {};`;
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-engine-")), "engine.mjs");
await esbuild.build({
  entryPoints: [path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/engine.ts")],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{
    name: "stand-ins",
    setup(b) {
      b.onResolve({ filter: /^@excalidraw\/excalidraw$/ }, () => ({ path: "excalidraw", namespace: "stand-in" }));
      b.onLoad({ filter: /^excalidraw$/, namespace: "stand-in" }, () => ({ contents: stand, loader: "js" }));
    },
  }],
});
const engine = await import(pathToFileURL(out).href) as typeof import("../src/engine.ts");
fs.rmSync(path.dirname(out), { recursive: true, force: true });
const { engineOps, request, answer, elementsEngine } = engine;

const el = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, version: 1, isDeleted: false, ...extra }) as unknown as El;
const replies = async (id: number, op: EngineOp, run?: (op: EngineOp) => unknown) => {
  const posted: FromBoard[] = [];
  await (run ? answer(id, op, (m) => posted.push(m), run) : answer(id, op, (m) => posted.push(m)));
  return posted;
};

test("engineOps: the four requests on given elements", () => {
  assert.deepEqual(Object.keys(engineOps).sort(), ["apply", "delete", "export", "restore"]);
});

test("elementsEngine: updateScene replaces the elements, and nothing is selected", () => {
  const e = elementsEngine([el("a")]);
  e.updateScene({ elements: [el("b")] });
  assert.deepEqual(e.elements().map((x) => x.id), ["b"]);
  assert.deepEqual(e.getAppState(), { selectedElementIds: {} });
});

test("restore: the elements restored", async () => {
  const v = await request({ op: "restore", elements: [el("a")] }) as { elements: { id: string; restored?: boolean }[] };
  assert.deepEqual(v.elements.map((x) => [x.id, x.restored]), [["a", true]]);
});

test("delete on given elements: the elements come back, the one asked for deleted", async () => {
  const v = await request({ op: "delete", target: { elements: [el("a"), el("b")] }, refs: [{ id: "a" }], cascade: false, rev: 3 } as never) as { elements: El[] };
  assert.deepEqual(v.elements.map((x) => [x.id, x.isDeleted]), [["a", true], ["b", false]]);
});

test("a live target is NO_BOARD for apply, delete and export", async () => {
  for (const op of [
    { op: "apply", target: "live", params: {}, rev: 1 },
    { op: "delete", target: "live", refs: [], cascade: false, rev: 1 },
    { op: "export", target: "live", ids: [], scale: 1, background: true },
  ] as const) {
    await assert.rejects(request(op as never), { code: "NO_BOARD", message: "no board is shown" });
  }
});

test("answer: a value is res ok, an RpcError its code and message, anything else FAILED", async () => {
  const op = { op: "restore", elements: [] } as EngineOp;
  assert.deepEqual(await replies(1, op), [{ t: "res", id: 1, ok: true, value: { elements: [] } }]);
  assert.deepEqual(await replies(2, { op: "apply", target: "live", params: {}, rev: 1 } as EngineOp), [{ t: "res", id: 2, ok: false, code: "NO_BOARD", message: "no board is shown" }]);
  assert.deepEqual(await replies(3, op, () => { throw new Error("boom"); }), [{ t: "res", id: 3, ok: false, code: "FAILED", message: "boom" }]);
  assert.deepEqual(await replies(4, op, () => Promise.reject("plain")), [{ t: "res", id: 4, ok: false, code: "FAILED", message: "plain" }]);
});

test("answer: snapshot needs a screen, so by default it is NO_BOARD", async () => {
  assert.deepEqual(await replies(5, { op: "snapshot" }), [{ t: "res", id: 5, ok: false, code: "NO_BOARD", message: "no board is shown" }]);
});
