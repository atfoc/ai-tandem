// The faithfulness harness (goal 6.1; plans/headless-board/engine.md section 7): the same requests sent to the board view's web target in
// Chromium (the window) and to the Node engine (`createNodeEndpoint`, the product's entry), and the answers compared:
//   * the elements, with every id replaced by its place in the scene and what is random left out; numbers equal within 0.01 are equal;
//   * the replies of each request (`created`, `updated`, `deleted`, `conflicts`, `rev`), compared the same way;
//   * the pictures: size, bounds and count exactly, then pixels: the plain share that differs at all (printed, never decides), and the
//     share that differs by more than 64 in a channel (O3: at most 1%), with a histogram and a diff picture of each;
//   * a text corpus: the width of 42 lines in each of 8 families at 4 sizes, Chromium against Node.
// Four runs, each over the cases of cases.mjs: "given" (the window works on given elements, faces loaded first: the engine path),
// "live" (the window works on the board on screen: `load`, then `apply`/`delete` on target "live"), "cold" (given elements in a page
// that has shown no board and loaded no face, a fresh page per case: a phone's hidden engine view), and the "corpus".
//
// Exit code 0: every difference is one of KNOWN below (each names the section of engine.md that explains it) and no picture has more than
// 1% of its pixels differing by more than 64. 1: a difference outside the list, a picture of another size or bounds outside the list, a
// picture over 1%, a reply that differs, or a page error. 2: it could not run (no Playwright, no build).
//
// Usage (from packages/board-engine):  npm run faithful -- [case ...] [--out <dir>] [--runs given,live,cold,corpus] [--dpr 2] [--web <dir>]
//   case ...   only these cases (trial scripts fonts frames-groups saved-board images large)
//   --out      the folder of the report: report.json and, per picture, <run>-<case>-<picture>-{chromium,node,diff}.png
//              (default out/faithful in this package, git-ignored)
//   --runs     which runs (default: all four)
//   --dpr      the window's device pixel ratio (default 1)
//   --web      a web build of the board view made before (default: built into a temp folder, as `node ../board-view/build.mjs web --out <tmp>`)
// Builds the web target and the engine itself, then runs; about 10 s in all on a 14-core Mac. Spends no money, needs no server and no network.
// Needs Playwright, which is no dependency of the repository:  npm install --no-save playwright@1.64.1 && npx playwright install chromium
// (Chromium 156 is the reference; a later `npm install` removes Playwright again.) Type stripping for ./node.mjs: Node 24, or the flag
// `--experimental-strip-types` (the npm script passes it).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./cases.mjs";
import { startChromium } from "./chromium.mjs";
import { measureCorpus } from "./corpus.mjs";
import { startNode, prepareNodeAssets } from "./node.mjs";
import { compare } from "./pictures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, "..");

// ---- what is known

/** Exactly 1%: the share of a picture's pixels that may differ by more than 64 in a channel (O3, engine.md section 10). */
const STRONG_LIMIT_PCT = 1;
/** Numbers equal within this are equal (a position, a size). */
const EPSILON = 0.01;
/** Han and kana: both sides use PingFang SC on macOS, but Chromium applies Apple's tracking table per size and Skia one ratio (engine.md section 5). */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const onMac = process.platform === "darwin";

/** The differences this system is known to have, none of them a defect of the engine's own work. Each names the section of
 *  plans/headless-board/engine.md that explains it, and the systems it holds on (the list for another system is EN8's: until it is
 *  measured, every difference there fails). A difference not matched here makes the harness exit 1.
 *    elements: `(ctx) => boolean`, ctx = { case, run, path, a, b, elA, elB }: one differing value of one element (a: Chromium, b: Node)
 *    pictures: `(ctx) => boolean`, ctx = { case, run, name, what: "size" | "bounds", a, b }
 *    corpus:   `(ctx) => boolean`, ctx = { family, group, size, line, a, b, pct }: one width of the corpus */
const KNOWN = {
  elements: [
    {
      id: "cjk-text", section: "5", systems: ["darwin"],
      why: "Han and kana text on macOS is up to 1.3% wider in Chromium (Apple's tracking table per size) than in Skia (one ratio at every size)",
      // a text with Han or kana in it, its size or place (a bound text is placed from its size); never the words it was cut into
      matches: ({ path: p, a, b, elA }) => onMac && elA?.type === "text" && CJK.test(String(elA.originalText ?? elA.text ?? ""))
        && /^(x|y|width|height)$/.test(p) && typeof a === "number" && typeof b === "number" && Math.abs(a - b) / Math.max(Math.abs(a), 1) <= 0.02,
    },
  ],
  pictures: [
    {
      id: "cjk-picture", section: "5 and 6", systems: ["darwin"],
      why: "a picture of CJK text is as wide as the text: 0.3 px of width of a Han line becomes a pixel of the picture's width and 0.3 px of its bounds",
      matches: ({ case: c, name, what, a, b }) => onMac && c === "scripts" && name === "cjk-row"
        && (what === "size" ? Math.abs(a[0] - b[0]) <= 2 && a[1] === b[1] : Object.keys(a).every((k) => Math.abs(a[k] - b[k]) <= 1)),
    },
  ],
  corpus: [
    {
      id: "cjk-width", section: "5", systems: ["darwin"],
      why: "Han and kana widths on macOS differ by 0.06% to 1.3% (the same tracking table as above), in every family",
      matches: ({ line, pct }) => onMac && CJK.test(line) && pct <= 1.5,
    },
    {
      id: "cascadia-fallback", section: "5", systems: ["darwin"],
      why: "Cascadia (deprecated, no new element gets it) in emoji, Arabic, Hebrew and Thai: CoreText's cascade for a monospace font is not the general one",
      matches: ({ family, group, pct }) => onMac && family === "Cascadia" && ["emoji", "rtl", "other"].includes(group) && pct <= 35,
    },
    {
      id: "liberation-symbols", section: "5", systems: ["darwin"],
      why: "one symbol line in Liberation Sans (♥ ☺ ✔︎ ⚠ in a font that has some of them itself)",
      matches: ({ family, group, line, pct }) => onMac && family === "Liberation Sans" && group === "emoji" && /[♥☺✔⚠]/u.test(line) && pct <= 3,
    },
  ],
};

// ---- the command line

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const valued = new Set(["--out", "--runs", "--dpr", "--web"]);
const only = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
const outDir = path.resolve(flag("--out") ?? path.join(pkg, "out", "faithful"));
const dpr = Number(flag("--dpr") ?? 1);
const RUNS = ["given", "live", "cold", "corpus"];
const runs = (flag("--runs") ?? RUNS.join(",")).split(",");
const cases = CASES.filter((c) => !only.length || only.includes(c.name));
if (runs.some((r) => !RUNS.includes(r)) || (only.length && cases.length !== only.length) || !(dpr > 0)) {
  console.error(`usage: faithful.mjs [${CASES.map((c) => c.name).join("|")} ...] [--out <dir>] [--runs ${RUNS.join(",")}] [--dpr 2] [--web <dir>]`);
  process.exit(2);
}

let playwright;
try {
  playwright = await import("playwright");
} catch {
  console.error("faithful: Playwright is not installed (it is no dependency of the repository):\n  cd packages/board-engine && npm install --no-save playwright@1.64.1 && npx playwright install chromium");
  process.exit(2);
}

// ---- comparing

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
/** Where two normalised values differ: [path, a, b]. Numbers equal within EPSILON count as equal. */
function differences(a, b, p = "", out = []) {
  if (typeof a === "number" && typeof b === "number") { if (Math.abs(a - b) > EPSILON) out.push([p, a, b]); return out; }
  if (Array.isArray(a) && Array.isArray(b)) { if (a.length !== b.length) out.push([`${p}.length`, a.length, b.length]); for (let i = 0; i < Math.min(a.length, b.length); i++) differences(a[i], b[i], `${p}[${i}]`, out); return out; }
  if (a && b && typeof a === "object" && typeof b === "object") { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[k], b[k], p ? `${p}.${k}` : k, out); return out; }
  if (a !== b) out.push([p, a, b]);
  return out;
}
/** Each id of a reply replaced by its place in that side's final scene, then the replies compared. */
const place = (els) => { const m = new Map(els.map((e, i) => [e.id, `#${i}`])); return (log) => JSON.parse(JSON.stringify(log), (k, v) => (typeof v === "string" && m.has(v) ? m.get(v) : v)); };

/** Every string of a case, so the faces its text needs can be loaded first. */
const textOf = (c) => JSON.stringify([c.steps, c.scene ? c.scene().elements.map((e) => e.text ?? "") : []]).replace(/\\n/g, "\n");
const FAMILY_STRINGS = ["Virgil", "Helvetica", "Cascadia", "Excalifont, Xiaolai", "Nunito", "Lilita One", "Comic Shanns", "Liberation Sans"].map((f) => `20px ${f}, Segoe UI Emoji`);
const EMPTY_SCENE = { elements: [], files: {}, appState: {} };

/** One case on one side: `side.req` answers a request. `live`: the window's board on screen (`load`, `apply` on target "live", the
 *  scene from `snapshot`); otherwise the elements are given with every request, as the app's board side sends them. */
async function runCase(side, c, live = false) {
  const t0 = performance.now();
  const scene = c.scene ? c.scene() : EMPTY_SCENE;
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

// ---- the run

const failures = []; // { run, case, kind, message }
const knownSeen = new Map(); // known id -> number of times
const fail = (run, c, kind, message) => { failures.push({ run, case: c, kind, message }); console.log(`  FAIL ${kind}: ${message}`); };
const known = (list, id) => { knownSeen.set(id, (knownSeen.get(id) ?? 0) + 1); return list.find((k) => k.id === id); };
const clip = (v, n = 44) => String(JSON.stringify(v) ?? v).slice(0, n);

fs.mkdirSync(outDir, { recursive: true });
const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aiwb-faithful-"));
let chromium = null, node = null;
const report = { when: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version, dpr, runs, cases: {}, corpus: null, failures, known: {} };
try {
  let webDir = flag("--web") && path.resolve(flag("--web"));
  if (!webDir) {
    webDir = path.join(temp, "web");
    process.stdout.write("building the web target of the board view ... ");
    const t = Date.now();
    execFileSync(process.execPath, [path.join(pkg, "..", "board-view", "build.mjs"), "web", "--out", webDir], { stdio: ["ignore", "ignore", "inherit"] });
    console.log(`${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
  const assets = path.join(temp, "engine");
  await prepareNodeAssets(assets);
  chromium = await startChromium({ playwright, webDir, deviceScaleFactor: dpr });
  node = await startNode(assets);
  report.chromium = chromium.version;
  report.engine = node.version;
  console.log(`Chromium ${chromium.version} (dpr ${dpr}) vs Node ${process.version}, ${node.version}, on ${report.platform}`);

  // the Node side does not depend on the run: each case once
  const nodeResults = new Map();
  const nodeOf = async (c) => { if (!nodeResults.has(c.name)) nodeResults.set(c.name, await runCase(node, c)); return nodeResults.get(c.name); };

  /** A page that has shown a board (Excalidraw put its faces in document.fonts), with the faces of the case's text loaded. */
  const warmPage = async (c) => { const p = await chromium.newPage(); await p.load("warm", EMPTY_SCENE); await p.warm(FAMILY_STRINGS, textOf(c)); return p; };

  for (const run of runs.filter((r) => r !== "corpus")) {
    console.log(`\n== ${run}: ${{ given: "the window works on given elements, faces loaded first", live: "the window works on the board on screen", cold: "the window works on given elements in a page that has shown no board" }[run]}`);
    report.cases[run] = {};
    // one page for all the cases of given and live (a window that has shown a board and goes on), a fresh one per case when cold
    const shared = run === "cold" ? null : await chromium.newPage();
    if (shared) await shared.load("warm", EMPTY_SCENE);
    for (const c of cases) {
      const page = shared ?? (await chromium.newPage());
      if (shared) await shared.warm(FAMILY_STRINGS, textOf(c));
      const A = await runCase(page, c, run === "live"), B = await nodeOf(c);
      if (!shared) await page.close();
      const na = normalise(A.els), nb = normalise(B.els);
      const diffs = differences(na, nb);
      const perEl = new Map();
      for (const d of diffs) { const i = Number(/^\[(\d+)\]/.exec(d[0])?.[1] ?? -1); if (!perEl.has(i)) perEl.set(i, []); perEl.get(i).push(d); }
      const logSame = JSON.stringify(place(A.els)(A.log)) === JSON.stringify(place(B.els)(B.log));
      const r = { desc: c.desc, elements: na.length, live: na.filter((e) => !e.isDeleted).length, differingElements: 0, knownElements: 0, diffs: [], resultsSame: logSame, logWindow: A.log, logNode: B.log, ms: { chromium: A.ms, node: B.ms }, pictures: {} };
      if (!logSame) r.replyDiffs = differences(place(A.els)(A.log), place(B.els)(B.log)).slice(0, 20);

      // the elements: a differing element is known if every one of its differing values is
      const lines = [];
      for (const [i, ds] of perEl) {
        const unknown = [];
        for (const d of ds) {
          const rel = i >= 0 ? d[0].replace(/^\[\d+\]\.?/, "") : d[0];
          const k = KNOWN.elements.find((k) => k.systems.includes(process.platform) && k.matches({ case: c.name, run, path: rel, a: d[1], b: d[2], elA: na[i], elB: nb[i] }));
          if (k) known(KNOWN.elements, k.id); else unknown.push(d);
          r.diffs.push({ element: i, path: rel, window: d[1], node: d[2], known: k?.id ?? null });
        }
        const what = `#${i} ${na[i]?.type ?? "?"}${na[i]?.text ? ` ${JSON.stringify(String(na[i].text).slice(0, 24))}` : ""}`;
        if (unknown.length) {
          r.differingElements++;
          lines.push(`  ${what}: ${unknown.slice(0, 4).map((d) => `${d[0].replace(/^\[\d+\]\.?/, "") || "(element)"} ${clip(d[1])} vs ${clip(d[2])}`).join("; ")}${unknown.length > 4 ? ` (+${unknown.length - 4})` : ""}`);
        } else r.knownElements++;
      }
      const same = r.elements - r.differingElements - r.knownElements;
      console.log(`\n${c.name}: ${r.elements} elements (${r.live} live), ${same} identical${r.knownElements ? `, ${r.knownElements} known to differ` : ""}${r.differingElements ? `, ${r.differingElements} DIFFER` : ""}, replies ${logSame ? "same" : "DIFFER"}; apply ${A.ms.apply.toFixed(0)} / ${B.ms.apply.toFixed(0)} ms, export ${A.ms.export.toFixed(0)} / ${B.ms.export.toFixed(0)} ms`);
      for (const l of lines.slice(0, 12)) console.log(l);
      if (lines.length > 12) console.log(`  ... ${lines.length - 12} more elements`);
      if (r.differingElements) failures.push({ run, case: c.name, kind: "elements", message: `${r.differingElements} of ${r.elements} elements differ outside the known list` });
      if (r.differingElements) console.log(`  FAIL elements: ${r.differingElements} differ outside the known list`);
      if (!logSame) fail(run, c.name, "replies", `the replies differ: ${JSON.stringify(r.replyDiffs.slice(0, 3)).slice(0, 300)}`);

      // the pictures
      for (const [name, pa] of Object.entries(A.pictures)) {
        const pb = B.pictures[name];
        if (pa.error || pb.error) {
          r.pictures[name] = { window: pa.error ?? "ok", node: pb.error ?? "ok" };
          if (pa.error !== pb.error) fail(run, c.name, "picture", `${name}: ${pa.error ?? "ok"} / ${pb.error ?? "ok"}`);
          else console.log(`  picture ${name}: both fail with ${pa.error}`);
          continue;
        }
        const cmp = await compare(pa.png, pb.png);
        const prefix = `${run}-${c.name}-${name.replace(/[^\w.+-]/g, "_")}`;
        fs.writeFileSync(path.join(outDir, `${prefix}-chromium.png`), Buffer.from(pa.png, "base64"));
        fs.writeFileSync(path.join(outDir, `${prefix}-node.png`), Buffer.from(pb.png, "base64"));
        if (cmp.diffPng) fs.writeFileSync(path.join(outDir, `${prefix}-diff.png`), cmp.diffPng);
        const boundsSame = differences(pa.bounds, pb.bounds).length === 0;
        const countSame = pa.count === pb.count;
        r.pictures[name] = { size: { window: [pa.width, pa.height], node: [pb.width, pb.height] }, bounds: { window: pa.bounds, node: pb.bounds }, boundsSame, count: [pa.count, pb.count], sameSize: cmp.sameSize,
          anyPct: cmp.anyPct ?? null, strongPct: cmp.strongPct ?? null, histogram: cmp.histogram ?? null };
        console.log(`  picture ${name}: ${pa.width}x${pa.height} / ${pb.width}x${pb.height}, bounds ${boundsSame ? "same" : "DIFFER"}, count ${pa.count}/${pb.count}` +
          (cmp.sameSize ? `, pixels differing ${cmp.anyPct.toFixed(2)}%, by more than 64: ${cmp.strongPct.toFixed(2)}%  [${Object.entries(cmp.histogram).map(([k, v]) => `${k}:${v}`).join(" ")}]` : ", pixels: n/a (sizes differ)"));
        if (!cmp.sameSize) {
          const k = KNOWN.pictures.find((k) => k.systems.includes(process.platform) && k.matches({ case: c.name, run, name, what: "size", a: [pa.width, pa.height], b: [pb.width, pb.height] }));
          if (k) { known(KNOWN.pictures, k.id); r.pictures[name].knownSize = k.id; console.log(`  known (section ${k.section}): ${k.id}`); }
          else fail(run, c.name, "picture-size", `${name}: ${pa.width}x${pa.height} vs ${pb.width}x${pb.height}`);
        }
        if (!boundsSame) {
          const k = KNOWN.pictures.find((k) => k.systems.includes(process.platform) && k.matches({ case: c.name, run, name, what: "bounds", a: pa.bounds, b: pb.bounds }));
          if (k) { known(KNOWN.pictures, k.id); r.pictures[name].knownBounds = k.id; console.log(`  known (section ${k.section}): ${k.id}: bounds ${JSON.stringify(pa.bounds)} vs ${JSON.stringify(pb.bounds)}`); }
          else fail(run, c.name, "picture-bounds", `${name}: ${JSON.stringify(pa.bounds)} vs ${JSON.stringify(pb.bounds)}`);
        }
        if (!countSame) fail(run, c.name, "picture-count", `${name}: ${pa.count} vs ${pb.count} elements drawn`);
        if (cmp.sameSize && cmp.strongPct > STRONG_LIMIT_PCT) fail(run, c.name, "picture-pixels", `${name}: ${cmp.strongPct.toFixed(2)}% of the pixels differ by more than 64 (limit ${STRONG_LIMIT_PCT}%)`);
      }
      report.cases[run][c.name] = r;
    }
    if (shared) await shared.close();
  }

  if (runs.includes("corpus")) {
    console.log("\n== corpus: the width of 42 lines in 8 families at 4 sizes, Chromium (faces loaded) against Node");
    const page = await chromium.newPage();
    await page.load("warm", EMPTY_SCENE);
    const widths = await measureCorpus(page, node);
    await page.close();
    const cell = {}; // family|group -> { n, exact, known, max }
    const unknown = [];
    for (const w of widths) {
      const k = `${w.family}|${w.group}`;
      const c = (cell[k] ??= { n: 0, exact: 0, known: 0, unknown: 0, maxPct: 0 });
      c.n++;
      const d = Math.abs(w.a - w.b);
      if (d <= EPSILON) { c.exact++; continue; }
      const pct = (100 * d) / w.a;
      c.maxPct = Math.max(c.maxPct, pct);
      const hit = KNOWN.corpus.find((k) => k.systems.includes(process.platform) && k.matches({ ...w, pct }));
      if (hit) { known(KNOWN.corpus, hit.id); c.known++; } else { c.unknown++; unknown.push({ ...w, pct }); }
    }
    const families = Object.keys(widths.reduce((o, w) => ((o[w.family] = 1), o), {}));
    const groups = Object.keys(widths.reduce((o, w) => ((o[w.group] = 1), o), {}));
    console.log("group".padEnd(10) + families.map((f) => f.slice(0, 15).padStart(19)).join(""));
    for (const g of groups) console.log(g.padEnd(10) + families.map((f) => { const c = cell[`${f}|${g}`]; return `${c.exact}/${c.n}${c.unknown ? ` !${c.unknown}` : ""} ${c.maxPct.toFixed(2)}%`.padStart(19); }).join(""));
    const exact = Object.values(cell).reduce((s, c) => s + c.exact, 0), knownN = Object.values(cell).reduce((s, c) => s + c.known, 0);
    console.log(`total: ${exact}/${widths.length} equal within ${EPSILON} px, ${knownN} differ and are known (cell: lines equal / lines, "!n" differing outside the list, the largest difference)`);
    unknown.sort((a, b) => b.pct - a.pct);
    for (const u of unknown.slice(0, 12)) console.log(`  ${u.pct.toFixed(2)}% ${u.size}px ${u.family} ${clip(u.line, 40)} ${u.a.toFixed(2)} vs ${u.b.toFixed(2)}`);
    if (unknown.length) fail("corpus", "corpus", "corpus-width", `${unknown.length} widths differ outside the known list (largest ${unknown[0].pct.toFixed(2)}%: ${unknown[0].size}px ${unknown[0].family} ${clip(unknown[0].line, 30)})`);
    report.corpus = { widths: widths.length, equal: exact, known: knownN, unknown: unknown.length, cells: cell, unknownWidths: unknown.slice(0, 50) };
  }

  if (chromium.errors.length) {
    console.log("\npage errors:", chromium.errors);
    fail("all", "-", "page-error", `${chromium.errors.length} page errors: ${chromium.errors[0].slice(0, 200)}`);
  }
} finally {
  await node?.close();
  await chromium?.close();
  fs.rmSync(temp, { recursive: true, force: true });
}

// ---- the report

const allKnown = [...KNOWN.elements, ...KNOWN.pictures, ...KNOWN.corpus];
for (const [id, n] of knownSeen) report.known[id] = { times: n, section: allKnown.find((k) => k.id === id)?.section, why: allKnown.find((k) => k.id === id)?.why };
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 1));
console.log(`\nreport and diff pictures: ${outDir}`);
if (knownSeen.size) {
  console.log("known differences met (engine.md section):");
  for (const [id, n] of knownSeen) console.log(`  ${id} (${allKnown.find((k) => k.id === id).section}) x${n}: ${allKnown.find((k) => k.id === id).why}`);
}
if (failures.length) {
  console.log(`\nFAILED: ${failures.length} difference${failures.length > 1 ? "s" : ""} outside the known list:`);
  for (const f of failures) console.log(`  [${f.run}] ${f.case}: ${f.kind}: ${f.message}`);
  process.exit(1);
}
console.log("\nOK: every difference is a known one, and no picture has more than 1% of its pixels differing by more than 64");
