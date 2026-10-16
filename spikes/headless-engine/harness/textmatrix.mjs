// Fonts per script (goal 7.1): every font family Excalidraw offers x a text per script, measured by Excalidraw's own text path
// (an `apply` that creates a text element; its width and height are what the board stores), in Chromium (the board view, its
// faces loaded) and in the Node engine on each canvas library (a child process per library, the library is fixed at load).
// Usage: node textmatrix.mjs [--json out.json]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { startChromium } from "./chromium.mjs";
import { SCRIPTS, FAMILIES, familyString } from "./probe-fallback.mjs";

const op = (text, fontFamily) => ({ op: "apply", target: { elements: [] }, rev: 1, params: { create: [{ type: "text", key: "t", x: 0, y: 0, text, fontFamily, fontSize: 20 }] } });

if (process.argv[2] === "--child") {
  const { startNode } = await import("./node.mjs");
  const n = await startNode();
  const out = {};
  for (const [f, id] of Object.entries(FAMILIES)) { out[f] = {}; for (const [k, t] of Object.entries(SCRIPTS)) { const r = await n.req(op(t, id)); out[f][k] = r.ok ? [r.value.elements[0].width, r.value.elements[0].height] : [NaN, NaN]; } }
  process.stdout.write(JSON.stringify({ lib: n.canvas, out }));
  process.exit(0);
}

const c = await startChromium();
await c.load("b", { elements: [], files: {}, appState: {} });
await c.warm(Object.keys(FAMILIES).map((f) => `20px ${familyString(f)}`), Object.values(SCRIPTS).join(""));
const ref = {};
for (const [f, id] of Object.entries(FAMILIES)) { ref[f] = {}; for (const [k, t] of Object.entries(SCRIPTS)) { const r = await c.req(op(t, id)); ref[f][k] = [r.value.elements[0].width, r.value.elements[0].height]; } }
const chromiumVersion = c.version;
await c.close();
const libs = ["skia", "napi"].map((L) => JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--child"], { env: { ...process.env, AIWB_CANVAS: L }, encoding: "utf8" })));

const rel = (a, b) => Math.abs(a - b) / Math.max(1e-9, Math.abs(b));
console.log(`Chromium ${chromiumVersion}; widths in px at 20px; each cell: chromium | ${libs.map((l) => l.lib).join(" | ")} (difference)`);
const summary = {};
for (const l of libs) summary[l.lib] = { exact: 0, within1pct: 0, n: 0, worst: [0, ""] , heightsEqual: 0 };
console.log("script".padEnd(11) + Object.keys(FAMILIES).map((f) => f.slice(0, 14).padStart(30)).join(""));
for (const k of Object.keys(SCRIPTS)) {
  let line = k.padEnd(11);
  for (const f of Object.keys(FAMILIES)) {
    const w = ref[f][k][0];
    const cells = libs.map((l) => { const x = l.out[f][k][0], d = x - w; const s = summary[l.lib]; s.n++; if (Math.abs(d) < 0.01) s.exact++; if (rel(x, w) <= 0.01) s.within1pct++; if (Math.abs(rel(x, w)) > s.worst[0]) s.worst = [rel(x, w), `${f}/${k}`]; if (l.out[f][k][1] === ref[f][k][1]) s.heightsEqual++; return Math.abs(d) < 0.01 ? "=" : d.toFixed(1); });
    line += `${w.toFixed(1)} ${cells.join(" ")}`.padStart(30);
  }
  console.log(line);
}
for (const [lib, s] of Object.entries(summary)) console.log(`${lib}: ${s.exact}/${s.n} widths within 0.01 px, ${s.within1pct}/${s.n} within 1%, heights equal ${s.heightsEqual}/${s.n}; worst ${(s.worst[0] * 100).toFixed(1)}% (${s.worst[1]})`);
const j = process.argv.indexOf("--json");
if (j > 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify({ chromium: chromiumVersion, scripts: SCRIPTS, ref, libs }, null, 1));
