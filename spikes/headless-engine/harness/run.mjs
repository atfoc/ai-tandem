// The faithfulness harness (goal 6.1): every case of cases.mjs in Chromium (the board view, web target) and in the Node engine,
// with the same requests; the elements compared (all but ids, seeds, nonces and times; ids mapped by scene order) and the
// pictures compared (size, bounds, pixels, goal 6.4). Writes out/harness/<case>-<picture>-{chromium,node,diff}.png and
// out/harness/report.json.
// Usage: node run.mjs [case ...] [--cold] [--dpr 2]
//   --cold: Chromium measures as a window that has loaded no face yet (no warm-up): what a window does today on first use.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startChromium } from "./chromium.mjs";
import { startNode } from "./node.mjs";
import { CASES } from "./cases.mjs";
import { compare } from "./pngs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "../out/harness");
fs.mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const cold = args.includes("--cold");
// --live: Chromium works on the board on screen (`load`, then `apply`/`delete` on target "live", the scene from `snapshot`), as
// a window does for the board the person looks at; the Node engine always works on given elements.
const liveMode = args.includes("--live");
const dpr = args.includes("--dpr") ? Number(args[args.indexOf("--dpr") + 1]) : 1;
const only = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--dpr");
const cases = CASES.filter((c) => !only.length || only.includes(c.name));

/** Every string of a case, so the faces its text needs can be loaded first. */
const textOf = (c) => JSON.stringify([c.steps, c.scene ? c.scene().elements.map((e) => e.text ?? "") : []]).replace(/\\n/g, "\n");
const FAMILY_STRINGS = ["Virgil", "Helvetica", "Cascadia", "Excalifont, Xiaolai", "Nunito", "Lilita One", "Comic Shanns", "Liberation Sans"].map((f) => `20px ${f}, Segoe UI Emoji`);

async function runCase(side, c, live = false) {
  const t0 = performance.now();
  const scene = c.scene ? c.scene() : { elements: [], files: {}, appState: {} };
  let els = [];
  const log = [];
  if (live) {
    await side.load(`live-${c.name}`, scene);
    let rev = 0;
    for (const s of c.steps) {
      const op = s.apply ? { op: "apply", target: "live", params: s.apply, rev: ++rev } : { op: "delete", target: "live", refs: s.delete.refs, cascade: s.delete.cascade, rev: ++rev };
      const r = await side.req(op);
      log.push(r.ok ? r.value : { error: `${r.code}: ${r.message}` });
    }
    els = (await side.req({ op: "snapshot" })).value.elements;
    return { els, log, pictures: {}, ms: { apply: performance.now() - t0, export: 0 } };
  }
  if (scene.elements.length) {
    const r = await side.req({ op: "restore", elements: scene.elements });
    if (!r.ok) throw new Error(`restore: ${r.code} ${r.message}`);
    els = r.value.elements;
  }
  let rev = 0;
  for (const s of c.steps) {
    const op = s.apply ? { op: "apply", target: { elements: els }, params: s.apply, rev: ++rev } : { op: "delete", target: { elements: els }, refs: s.delete.refs, cascade: s.delete.cascade, rev: ++rev };
    const r = await side.req(op);
    if (!r.ok) { log.push({ error: `${r.code}: ${r.message}` }); continue; }
    const { elements, ...res } = r.value;
    els = elements;
    log.push(res);
  }
  const tApply = performance.now() - t0;
  const keyId = (k) => els.find((e) => e.customData?.key === k && !e.isDeleted)?.id;
  const pictures = {};
  const t1 = performance.now();
  for (const p of c.pictures ?? []) {
    const r = await side.req({ op: "export", target: { elements: els, files: scene.files, appState: scene.appState }, ids: p.ids(els, keyId), scale: p.scale ?? 1, background: true });
    pictures[p.name] = r.ok ? r.value : { error: `${r.code}: ${r.message}` };
  }
  return { els, log, pictures, ms: { apply: tApply, export: performance.now() - t1 } };
}

const RANDOM = new Set(["id", "seed", "versionNonce", "updated"]);
/** The elements with every id replaced by its place in the scene (ids, group ids), and what is random left out. */
function normalise(els) {
  const ids = new Map(els.map((e, i) => [e.id, `#${i}`]));
  const groups = new Map();
  const g = (x) => { if (!groups.has(x)) groups.set(x, `g${groups.size}`); return groups.get(x); };
  const fix = (v, k) => {
    if (Array.isArray(v)) return k === "groupIds" ? v.map(g) : v.map((x) => fix(x));
    if (v && typeof v === "object") { const o = {}; for (const [kk, vv] of Object.entries(v)) if (!RANDOM.has(kk) || k === "boundElements") o[kk] = kk === "id" || kk === "elementId" ? ids.get(vv) ?? vv : fix(vv, kk); return o; }
    return typeof v === "string" && ids.has(v) && ["containerId", "frameId", "elementId"].includes(k) ? ids.get(v) : v;
  };
  return els.map((e) => { const o = {}; for (const [k, v] of Object.entries(e)) if (!RANDOM.has(k)) o[k] = fix(v, k); return o; });
}
/** Where two normalised values differ: [path, a, b, |delta| for numbers]. Numbers equal within 0.01 count as equal. */
function differences(a, b, p = "", out = []) {
  if (typeof a === "number" && typeof b === "number") { if (Math.abs(a - b) > 0.01) out.push([p, a, b, Math.abs(a - b)]); return out; }
  if (Array.isArray(a) && Array.isArray(b)) { if (a.length !== b.length) out.push([p + ".length", a.length, b.length]); for (let i = 0; i < Math.min(a.length, b.length); i++) differences(a[i], b[i], `${p}[${i}]`, out); return out; }
  if (a && b && typeof a === "object" && typeof b === "object") { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[k], b[k], p ? `${p}.${k}` : k, out); return out; }
  if (a !== b) out.push([p, a, b]);
  return out;
}

const chromium = await startChromium({ deviceScaleFactor: dpr });
const node = await startNode();
// (a board shown: Excalidraw puts its faces in document.fonts; a cold page has shown none, as a phone's hidden engine view)
if (!cold) await chromium.load("warm", { elements: [], files: {}, appState: {} });
const report = { chromium: chromium.version, canvas: node.canvas, platform: `${process.platform}-${process.arch}`, cold, dpr, cases: {} };
console.log(`Chromium ${chromium.version} (dpr ${dpr}${cold ? ", cold" : ""}) vs Node ${process.version} + ${node.canvas} on ${report.platform}`);
for (const c of cases) {
  if (!cold) await chromium.warm(FAMILY_STRINGS, textOf(c));
  const A = await runCase(chromium, c, liveMode), B = await runCase(node, c);
  const na = normalise(A.els), nb = normalise(B.els);
  const diffs = differences(na, nb);
  const perEl = new Map();
  for (const d of diffs) { const i = Number(/^\[(\d+)\]/.exec(d[0])?.[1] ?? -1); if (!perEl.has(i)) perEl.set(i, []); perEl.get(i).push(d); }
  // the replies, with each id replaced by its place in that side's final scene
  const place = (els) => { const m = new Map(els.map((e, i) => [e.id, `#${i}`])); return (log) => JSON.parse(JSON.stringify(log), (k, v) => (typeof v === "string" && m.has(v) ? m.get(v) : v)); };
  const logSame = JSON.stringify(place(A.els)(A.log)) === JSON.stringify(place(B.els)(B.log));
  const r = { desc: c.desc, elements: na.length, live: na.filter((e) => !e.isDeleted).length, differingElements: perEl.size, diffs: diffs.slice(0, 40), resultsSame: logSame, logA: A.log, logB: B.log, ms: { chromium: A.ms, node: B.ms }, pictures: {} };
  console.log(`\n${c.name}: ${r.elements} elements (${r.live} live), ${r.elements - r.differingElements}/${r.elements} identical, results ${logSame ? "same" : "DIFFER"}; apply ${A.ms.apply.toFixed(0)} ms / ${B.ms.apply.toFixed(0)} ms, export ${A.ms.export.toFixed(0)} / ${B.ms.export.toFixed(0)} ms`);
  for (const [i, ds] of perEl) console.log(`  #${i} ${na[i]?.type}${na[i]?.text ? ` "${String(na[i].text).slice(0, 30)}"` : ""}: ${ds.slice(0, 4).map((d) => `${d[0].replace(/^\[\d+\]\.?/, "")} ${JSON.stringify(d[1])?.slice(0, 40)} vs ${JSON.stringify(d[2])?.slice(0, 40)}`).join("; ")}${ds.length > 4 ? ` (+${ds.length - 4})` : ""}`);
  for (const [name, pa] of Object.entries(A.pictures)) {
    const pb = B.pictures[name];
    if (pa.error || pb.error) { console.log(`  picture ${name}: ${pa.error ?? "ok"} / ${pb.error ?? "ok"}`); r.pictures[name] = { a: pa.error, b: pb.error }; continue; }
    const cmp = await compare(pa.png, pb.png);
    const boundsSame = differences(pa.bounds, pb.bounds).length === 0;
    fs.writeFileSync(path.join(OUT, `${c.name}-${name}-chromium.png`), Buffer.from(pa.png, "base64"));
    fs.writeFileSync(path.join(OUT, `${c.name}-${name}-node.png`), Buffer.from(pb.png, "base64"));
    if (cmp.diffPng) fs.writeFileSync(path.join(OUT, `${c.name}-${name}-diff.png`), cmp.diffPng);
    r.pictures[name] = { size: [pa.width, pa.height, pb.width, pb.height], bounds: [pa.bounds, pb.bounds], boundsSame, count: [pa.count, pb.count], anyPct: cmp.anyPct, strongPct: cmp.strongPct, sameSize: cmp.sameSize };
    console.log(`  picture ${name}: ${pa.width}x${pa.height} / ${pb.width}x${pb.height}, bounds ${boundsSame ? "same" : `DIFFER ${JSON.stringify(pa.bounds)} ${JSON.stringify(pb.bounds)}`}, count ${pa.count}/${pb.count}` +
      (cmp.sameSize ? `, pixels differing ${cmp.anyPct.toFixed(2)}% (strongly ${cmp.strongPct.toFixed(2)}%)` : ", SIZE DIFFERS"));
  }
  report.cases[c.name] = r;
}
fs.writeFileSync(path.join(OUT, `report${liveMode ? "-live" : ""}${cold ? "-cold" : ""}${dpr !== 1 ? `-dpr${dpr}` : ""}.json`), JSON.stringify(report, null, 1));
if (chromium.errors.length) console.log("page errors:", chromium.errors);
await chromium.close();
