// The Node side of the faithfulness harness: the product's own entry (`createNodeEndpoint` of ../src/node.ts) on an assets folder made
// by `copyEngineAssets`, asked with the same `req` messages as the window. Importing it needs Node's type stripping (Node 24 has it on;
// on 22.6+ run with --experimental-strip-types, which `npm run faithful` passes).
import { copyEngineAssets, createNodeEndpoint } from "../src/node.ts";

/** Starts the engine on `assets` (made by `prepareNodeAssets`); `req(op)` answers with the `res` message, as the window's does. */
export async function startNode(assets) {
  const waiting = new Map();
  let version = "";
  let next = 0;
  const endpoint = await createNodeEndpoint((m) => {
    if (m.t === "ready") version = m.version;
    if (m.t === "res") { waiting.get(m.id)?.(m); waiting.delete(m.id); }
  }, { assets, warn: (t) => console.error(t) });
  return {
    /** "excalidraw 0.18.1; skia-canvas 4.0.0" */
    version,
    req: (op) => new Promise((resolve) => { const id = ++next; waiting.set(id, resolve); endpoint.receive({ t: "req", id, op }); }),
    /** What the stand-in page's canvas (the engine's own, after the endpoint started) measures for each text in each font string. */
    measure: (fonts, texts) => { const c = document.createElement("canvas").getContext("2d"); return fonts.map((f) => { c.font = f; return texts.map((t) => c.measureText(t).width); }); },
    close: () => endpoint.close(),
  };
}

/** Writes the assets folder for this machine into `dir` (builds dist/engine.mjs first if it is missing or stale). */
export const prepareNodeAssets = (dir) => copyEngineAssets(dir, { os: process.platform, arch: process.arch });
