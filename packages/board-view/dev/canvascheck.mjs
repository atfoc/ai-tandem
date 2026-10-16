// The canvas theme in real engines: what the board view's two pages draw on the canvas under each theme, read back from
// screenshots in Chromium and WebKit, and held to the model and to each other. The phone page (dist-webview/board.html from file://, as a
// web view loads it) and the desktop page (the web target in a page under the web build's CSP) draw the same boards under the
// same `theme` messages the app sends (mode, filter and chrome of every theme of CANVAS_THEMES), at one viewport, scale 1.
//   1. swatch board: solid rectangles in the anchors (#ffffff, #1e1e1e), every palette colour (open-color shades 0 2 4 6 8 of eleven
//      colours, the five bronzes) and the empty ground; the pixel at each centre is read from the screenshot;
//   2. per engine and theme: (a) desktop page vs `shown()` of @aiwb/core (today's model against the engine); (b) phone page anchors
//      vs `shown()`, at most 3/255 per channel, FAIL otherwise; (c) phone page palette vs `phoneShown()` of src/phonetheme.ts (skipped
//      with a note while that file is not there); (d) phone vs desktop palette in OKLCH, the family criterion of section 4 of
//      plans/excalidraw-optimization/replacement.md (|dL| <= 0.06; coloured today, C >= 0.05: hue within 30 degrees, chroma >= 0.25 of
//      today's): every colour that fails is listed, a finding, not a FAIL;
//   3. chrome untouched: the toolbar, the zoom island and the menu button of the phone page equal the desktop page's, to 1/255;
//   4. live switch: the phone page, one board loaded once, `theme` messages through every theme and back to plain light, no reload: the
//      anchors are those of step 2 (1/255), plain light shows the stored colours exactly and has no `.aiwb-canvas-layer`; no `changed`
//      is posted by a theme switch or by `unload`;
//   5. get_image unchanged: an `export` request in plain light and in every theme returns the same bytes on each page, and the same
//      on the two pages (a difference between the pages is reported, then only the themes are compared);
//   6. --sheets: contact sheets, one PNG per engine and theme: three boards (default colours only, every palette colour, a board with a
//      picture), today (desktop page) on the left, new (phone page) on the right.
// Exit code 1 on a FAIL (anchors, chrome, live switch, changed, export), 2 when it cannot start.
// Usage: npm run build:webview && node dev/canvascheck.mjs [--engines chromium,webkit] [--themes dark,mocha] [--out <dir>] [--sheets]
//   (dist-webview is built here when missing; the web target is built into a temp folder; --out also keeps the screenshots of the
//   sheets' boards; --themes narrows the themes while a fix is tried)
// Needs Playwright with both engines (no dependency of the repository: `cd web && npm install --no-save playwright@1.64.1 &&
// npx playwright install chromium webkit`); found as the harness finds it. No server, no network, nothing paid.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { csp as webBuildCsp } from "../../../app/scripts/export-web.mjs";
import { validateToBoard } from "@aiwb/board-bridge/validate.ts";
import { CANVAS_THEMES, canvasFilter, shown } from "@aiwb/core/logic/canvastheme.ts";
import { chromeOf } from "@aiwb/core/logic/canvaschrome.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, "..");
const dist = path.join(pkg, "dist-webview");
const t0 = Date.now();

// ---- arguments

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const ENGINES = (arg("--engines") ?? "chromium,webkit").split(",").filter(Boolean);
const THEMES = (arg("--themes") ?? CANVAS_THEMES.join(",")).split(",").filter(Boolean);
const SHEETS = argv.includes("--sheets");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-canvascheck-"));
const OUT = arg("--out") ? path.resolve(arg("--out")) : path.join(tmp, "out");
fs.mkdirSync(OUT, { recursive: true });
for (const t of THEMES) if (!CANVAS_THEMES.includes(t)) { console.error(`unknown theme ${t}`); process.exit(2); }

// ---- the model of the phone page (src/phonetheme.ts, from the branch that has it)

let phone = null;
try { phone = await import("../src/phonetheme.ts"); } catch (e) {
  if (!/Cannot find module|ERR_MODULE_NOT_FOUND/.test(String(e?.code ?? e?.message ?? e))) throw e;
}
const NOTES = [];
if (!phone) NOTES.push("src/phonetheme.ts is not on this branch: (c), the model of the phone page, is skipped (both pages draw today's SVG filter)");

// ---- Playwright

function findPlaywright() {
  const require = createRequire(import.meta.url);
  const dirs = [process.env.PLAYWRIGHT, path.join(pkg, "../../web/node_modules/playwright")].filter(Boolean);
  try { dirs.push(path.join(execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: pkg, encoding: "utf8" }).trim(), "../web/node_modules/playwright")); } catch { /* not a checkout */ }
  const npx = path.join(os.homedir(), ".npm/_npx");
  if (fs.existsSync(npx)) dirs.push(...fs.readdirSync(npx).map((d) => path.join(npx, d, "node_modules/playwright")));
  try { return require("playwright"); } catch { /* try the folders */ }
  for (const d of dirs) if (fs.existsSync(path.join(d, "package.json"))) return require(d);
  throw new Error("playwright not found in:\n  " + dirs.join("\n  ") + "\nrun once: cd web && npm install --no-save playwright@1.64.1 && npx playwright install chromium webkit");
}

// ---- pixels: a PNG decoded here (the screenshot is what a person sees)

function decodePng(buf) {
  let at = 8, w = 0, h = 0, colour = 0; const idat = [];
  while (at < buf.length) {
    const n = buf.readUInt32BE(at), type = buf.toString("latin1", at + 4, at + 8);
    if (type === "IHDR") { w = buf.readUInt32BE(at + 8); h = buf.readUInt32BE(at + 12); colour = buf[at + 17]; if (buf[at + 16] !== 8) throw new Error("a PNG that is not 8 bits"); }
    if (type === "IDAT") idat.push(buf.subarray(at + 8, at + 8 + n));
    at += 12 + n;
  }
  const bpp = colour === 6 ? 4 : colour === 2 ? 3 : 0;
  if (!bpp) throw new Error(`a PNG of colour type ${colour}`);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, data = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? data[dst + i - bpp] : 0, b = y ? data[dst - stride + i] : 0, c = i >= bpp && y ? data[dst - stride + i - bpp] : 0;
      let v = raw[src + i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      data[dst + i] = v & 255;
    }
  }
  return { w, h, at: (x, y) => [data[y * stride + x * bpp], data[y * stride + x * bpp + 1], data[y * stride + x * bpp + 2]] };
}

function writePng(w, h, rgb) { // 8-bit RGB, no filter
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, "latin1"); data.copy(b, 8);
    b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const hexOf = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const maxErr = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

// ---- OKLCH

function oklch([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [r, g, b].map(lin);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, C: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}
/** Why a colour fails the family criterion of the design (section 4), or null. `today` and `now` are rgb. */
function family(today, now) {
  const a = oklch(today), b = oklch(now), why = [];
  if (Math.abs(a.L - b.L) > 0.06) why.push(`dL ${(b.L - a.L).toFixed(3)}`);
  if (a.C >= 0.05) {
    const dh = Math.abs(((b.h - a.h + 540) % 360) - 180);
    if (dh > 30) why.push(`hue ${dh.toFixed(0)}°`);
    if (b.C < 0.25 * a.C) why.push(`C ${a.C.toFixed(3)}→${b.C.toFixed(3)}`);
  }
  return why.length ? why.join(", ") : null;
}

// ---- the colours

const require = createRequire(import.meta.url);
const OC = require("open-color");
const FAMILIES = ["gray", "red", "pink", "grape", "violet", "blue", "cyan", "teal", "green", "yellow", "orange"];
const BRONZE = ["#f8f1ee", "#eaddd7", "#d2bab0", "#a18072", "#846358"];
const ROWS = [["#ffffff", "#1e1e1e"], ...FAMILIES.map((f) => [0, 2, 4, 6, 8].map((i) => OC[f][i])), BRONZE];
const ANCHORS = ["#ffffff", "#1e1e1e"];
const PALETTE = ROWS.slice(1).flat();
const SW = { w: 60, h: 40, gx: 66, gy: 46, x0: 110, y0: 110 }; // swatch size, pitch and origin, in scene = screen coordinates (zoom 1, no scroll)
const centre = (row, col) => [SW.x0 + col * SW.gx + SW.w / 2, SW.y0 + row * SW.gy + SW.h / 2];
const SPOTS = new Map(); // colour -> [x, y] of its swatch's centre
ROWS.forEach((r, i) => r.forEach((c, j) => SPOTS.set(c, centre(i, j))));
const GROUND = [900, 420]; // away from the swatches, the toolbar and the corner buttons

// ---- the boards

const el = (id, type, x, y, w, h, extra = {}) => ({ id, type, x, y, width: w, height: h, version: 1, roughness: 0, roundness: null, opacity: 100, ...extra });
const swatchElements = () => ROWS.flatMap((r, i) => r.map((c, j) => el(`sw-${c}`, "rectangle", SW.x0 + j * SW.gx, SW.y0 + i * SW.gy, SW.w, SW.h,
  { backgroundColor: c, fillStyle: "solid", strokeColor: "transparent", strokeWidth: 1 })));

// the PNG of the picture board: a colourful gradient on the left, a photo-like pattern (smooth blobs and a fine grain) on the right
function picturePng() {
  const w = 240, h = 160, rgb = Buffer.alloc(w * h * 3); let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const hsl = (hh, s, l) => { const k = (n) => (n + hh / 30) % 12, a = s * Math.min(l, 1 - l), f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c;
    if (x < w / 2) c = hsl((x / (w / 2)) * 330, 0.85, 0.35 + 0.4 * (1 - y / h));
    else {
      const u = x / w, v = y / h, n = (rnd() - 0.5) * 18;
      const r = 120 + 90 * Math.sin(u * 9 + v * 3) + 40 * Math.sin(v * 17), g = 140 + 80 * Math.sin(u * 5 - v * 7 + 1) + 30 * Math.cos(u * 23), b = 110 + 90 * Math.cos(u * 6 + v * 9) + 50 * Math.sin((u + v) * 13);
      c = [r + n, g + n, b + n].map((q) => Math.max(0, Math.min(255, Math.round(q))));
    }
    rgb.set(c, (y * w + x) * 3);
  }
  return writePng(w, h, rgb);
}

/** The scenes (elements through the page's own `restore`/`apply`, so they carry Excalidraw's defaults), made once. */
async function makeScenes(pg) {
  const restore = async (elements) => (await pg.ok({ op: "restore", elements })).elements;
  const appState = { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: "#ffffff" };
  const swatches = { elements: await restore(swatchElements()), files: {}, appState };
  // (i) only the defaults: the stroke #1e1e1e, no fill; and the quick-pick fills
  const made = (await pg.ok({ op: "apply", target: { elements: [] }, rev: 1, params: { create: [
    { type: "rectangle", key: "r", x: 120, y: 130, width: 200, height: 110 },
    { type: "ellipse", key: "e", x: 360, y: 130, width: 200, height: 110 },
    { type: "diamond", key: "d", x: 600, y: 120, width: 200, height: 130 },
    { type: "arrow", key: "a", x: 120, y: 300, points: [[0, 0], [220, 60]] },
    { type: "line", key: "l", x: 380, y: 300, points: [[0, 0], [90, 70], [180, 0]] },
    { type: "text", key: "t", x: 640, y: 300, text: "Hello, board" },
    { type: "rectangle", key: "f1", x: 120, y: 450, width: 150, height: 90, backgroundColor: "#ffc9c9", fillStyle: "solid" },
    { type: "rectangle", key: "f2", x: 300, y: 450, width: 150, height: 90, backgroundColor: "#b2f2bb", fillStyle: "solid" },
    { type: "rectangle", key: "f3", x: 480, y: 450, width: 150, height: 90, backgroundColor: "#a5d8ff", fillStyle: "solid" },
    { type: "rectangle", key: "f4", x: 660, y: 450, width: 150, height: 90, backgroundColor: "#ffec99", fillStyle: "solid", strokeColor: "#f08c00" },
    { type: "rectangle", key: "s1", x: 120, y: 580, width: 150, height: 80, strokeColor: "#e03131" },
    { type: "ellipse", key: "s2", x: 300, y: 580, width: 150, height: 80, strokeColor: "#2f9e44" },
    { type: "diamond", key: "s3", x: 480, y: 575, width: 150, height: 90, strokeColor: "#1971c2" },
    { type: "text", key: "s4", x: 670, y: 600, text: "Red", strokeColor: "#e03131" },
  ] } })).elements;
  const free = await restore([el("free", "freedraw", 380, 380, 180, 40, { points: Array.from({ length: 24 }, (_, i) => [i * 7.5, 20 + 18 * Math.sin(i / 2.5)]), pressures: [], simulatePressure: true, strokeColor: "#1e1e1e", strokeWidth: 2 })]);
  const defaults = { elements: [...made, ...free], files: {}, appState };
  // (iii) a picture
  const dataURL = "data:image/png;base64," + picturePng().toString("base64");
  const files = { pic1: { id: "pic1", mimeType: "image/png", dataURL, created: 1 } };
  const pictures = { elements: await restore([
    el("img1", "image", 130, 130, 360, 240, { fileId: "pic1", status: "saved", scale: [1, 1] }),
    el("img2", "image", 540, 130, 240, 160, { fileId: "pic1", status: "saved", scale: [1, 1] }),
    el("box1", "rectangle", 540, 320, 240, 100, { backgroundColor: "#a5d8ff", fillStyle: "solid", strokeColor: "#1971c2" }),
  ]), files, appState };
  return { swatches, defaults, pictures };
}

// ---- one page, spoken to by messages

class Pg {
  constructor(kind, page, watch) { this.kind = kind; this.page = page; this.watch = watch; this.id = 1; }
  out() { return this.page.evaluate(() => window.__out); }
  async send(m) {
    const v = validateToBoard(m);
    if (!v.ok) throw new Error(`${this.kind}: invalid message ${m.t}: ${v.error}`);
    await this.page.evaluate((m) => window.__sendRaw(m), m);
  }
  async until(want, what, from = 0, timeout = 30000) {
    const t = Date.now();
    for (;;) {
      const out = await this.out(), at = out.findIndex((m, i) => i >= from && want(m));
      if (at >= 0) return out[at];
      if (Date.now() - t > timeout) throw new Error(`${this.kind}: no ${what} within ${timeout} ms; got ${JSON.stringify(out.slice(from).map((m) => m.t))}`);
      await this.page.waitForTimeout(40);
    }
  }
  async ok(op) {
    const id = this.id++, from = (await this.out()).length;
    await this.send({ t: "req", id, op });
    const res = await this.until((m) => m.t === "res" && m.id === id, `reply to ${op.op}`, from);
    if (!res.ok) throw new Error(`${this.kind}: ${op.op} failed: ${res.code} ${res.message}`);
    return res.value;
  }
  async load(board, scene, theme) {
    const from = (await this.out()).length;
    await this.send({ t: "load", board, viewMode: false, theme, style: {}, scene });
    await this.until((m) => m.t === "loaded" && m.board === board, "loaded", from);
  }
  /** A screenshot of the page, decoded, once the pixels at `spots` stop changing. */
  async shoot(spots = [GROUND, SPOTS.get("#1e1e1e")]) {
    let prev = null, img;
    await this.page.waitForTimeout(200);
    for (let i = 0; i < 12; i++) {
      const png = await this.page.screenshot();
      img = decodePng(png); img.png = png;
      const now = JSON.stringify(spots.map(([x, y]) => img.at(x, y)));
      if (now === prev) return img;
      prev = now;
      await this.page.waitForTimeout(150);
    }
    return img;
  }
}

async function openPages(browser, site) {
  const pages = {};
  for (const kind of ["phone", "desktop"]) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const watch = { console: [], csp: [] };
    page.on("console", (m) => { if (m.type() === "error") watch.console.push(m.text()); });
    page.on("pageerror", (e) => watch.console.push(`pageerror: ${e.message}`));
    if (kind === "phone") {
      await page.addInitScript(() => {
        window.__out = [];
        window.ReactNativeWebView = { postMessage: (text) => window.__out.push(JSON.parse(text)) };
        window.__sendRaw = (m) => window.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(m) }));
      });
      await page.goto(pathToFileURL(path.join(dist, "board.html")).href);
    } else await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    const pg = new Pg(kind, page, watch);
    await pg.until((m) => m.t === "ready", "ready");
    pages[kind] = pg;
  }
  return pages;
}

// ---- the theme messages (what the app sends: core/board/side.ts themeOf)

const themeMsg = (t) => t === null ? { mode: "light", filter: null } : { mode: t === "latte" ? "light" : "dark", filter: canvasFilter(t), chrome: t === "dark" ? null : chromeOf(t) };
const LIGHT = themeMsg(null);

// ---- the checks

const failures = [], findings = [];
const fail = (s) => failures.push(s);
const rows = [];

const readColours = (img, colours) => Object.fromEntries(colours.map((c) => [c, img.at(...SPOTS.get(c))]));

async function chromeRegions(pg) {
  return pg.page.evaluate(() => ["App-toolbar", "zoom-actions", "main-menu-trigger"].map((c) => {
    const e = document.querySelector("." + c)?.getBoundingClientRect();
    return e ? { c, x: Math.ceil(e.left), y: Math.ceil(e.top), w: Math.floor(e.width), h: Math.floor(e.height) } : { c };
  }));
}

async function runEngine(name, pw, site, scenes, sheetShots) {
  const browser = await pw[name].launch();
  try {
    const pages = await openPages(browser, site);
    scenes.value ??= await makeScenes(pages.phone);
    const sc = scenes.value;
    const R = {}; // theme -> { phone: {colour: rgb}, desktop: {...}, ground }
    for (const t of THEMES) {
      const row = { engine: name, theme: t, notes: [], fails: [] };
      R[t] = {};
      const shots = {};
      for (const kind of ["phone", "desktop"]) {
        const pg = pages[kind];
        await pg.load(`swatch-${t}`, sc.swatches, themeMsg(t));
        const img = await pg.shoot();
        shots[kind] = img;
        R[t][kind] = { ...readColours(img, [...ANCHORS, ...PALETTE]), ground: img.at(...GROUND) };
        R[t][kind + "Regions"] = await chromeRegions(pg);
      }
      const P = R[t].phone, D = R[t].desktop;
      const anchors = [...ANCHORS, "ground"];
      const model = (c) => rgbOf(shown(t, c === "ground" ? "#ffffff" : c));
      // (a) the desktop page against today's model
      const aA = Math.max(...anchors.map((c) => maxErr(D[c], model(c)))), aP = Math.max(...PALETTE.map((c) => maxErr(D[c], model(c))));
      // (b) the phone page's anchors against today's model
      const bA = Math.max(...anchors.map((c) => maxErr(P[c], model(c))));
      if (aA > 3) row.fails.push(`desktop anchors off the model by ${aA}/255`);
      if (bA > 3) row.fails.push(`phone anchors off \`shown\` by ${bA}/255 (${anchors.filter((c) => maxErr(P[c], model(c)) > 3).map((c) => `${c}: ${hexOf(P[c])} for ${hexOf(model(c))}`).join("; ")})`);
      // (c) the phone page against the model of the phone page
      let cP = null;
      if (phone) {
        const f = canvasFilter(t);
        const plan = phone.phoneCanvas(f);
        row.kind = plan.kind;
        if (plan.kind === "fallback") row.notes.push(`phoneCanvas: fallback (${plan.why})`);
        cP = Math.max(...[...anchors, ...PALETTE].map((c) => maxErr(P[c], rgbOf(phone.phoneShown(f, c === "ground" ? "#ffffff" : c)))));
      }
      // (d) the family criterion, phone against desktop
      const dFails = PALETTE.map((c) => [c, family(D[c], P[c])]).filter(([, why]) => why);
      // 3. chrome: the islands of the phone page against the desktop page's
      let chromeMax = 0;
      for (let i = 0; i < 3; i++) {
        const a = R[t].phoneRegions[i], b = R[t].desktopRegions[i];
        if (!a.w || JSON.stringify(a) !== JSON.stringify(b)) { row.fails.push(`chrome: ${a.c} is ${JSON.stringify(a)} on the phone page and ${JSON.stringify(b)} on the desktop page`); continue; }
        // (inside the rounded corners: they show the canvas under the island, which a theme changes on purpose)
        for (let y = a.y + 8; y < a.y + a.h - 8; y++) for (let x = a.x + 8; x < a.x + a.w - 8; x++) chromeMax = Math.max(chromeMax, maxErr(shots.phone.at(x, y), shots.desktop.at(x, y)));
      }
      if (chromeMax > 1) row.fails.push(`chrome differs by ${chromeMax}/255`);
      Object.assign(row, { aA, aP, bA, cP, dFails, chromeMax });
      rows.push(row);
      if (sheetShots) sheetShots.push({ engine: name, theme: t, board: "palette", ...Object.fromEntries(["phone", "desktop"].map((k) => [k, shots[k].png])) });
    }

    // 4. live switch on the phone page, 5. exports on both pages
    const live = { fails: [] };
    const ph = pages.phone;
    await ph.load("live", sc.swatches, LIGHT);
    await ph.page.waitForTimeout(800);
    const loadedAt = (await ph.out()).length;
    const order = [...THEMES, ...[...THEMES].reverse(), null];
    const exportOf = async (pg) => (await pg.ok({ op: "export", target: "live", ids: [], scale: 1, background: true })).png;
    const exports = { phone: [], desktop: [] };
    let switches = 0;
    for (const t of order) {
      await ph.send({ t: "theme", theme: t === null ? LIGHT : themeMsg(t) });
      const img = await ph.shoot();
      switches++;
      const got = { ink: img.at(...SPOTS.get("#1e1e1e")), white: img.at(...SPOTS.get("#ffffff")) };
      const layers = await ph.page.evaluate(() => document.querySelectorAll(".aiwb-canvas-layer").length);
      if (t === null) {
        if (maxErr(got.ink, rgbOf("#1e1e1e")) || maxErr(got.white, [255, 255, 255])) live.fails.push(`plain light shows ${hexOf(got.ink)} and ${hexOf(got.white)}, not the stored colours`);
        if (layers) live.fails.push(`plain light still has ${layers} .aiwb-canvas-layer`);
      } else if (THEMES.includes(t)) {
        const want = R[t].phone;
        if (maxErr(got.ink, want["#1e1e1e"]) > 1 || maxErr(got.white, want["#ffffff"]) > 1) live.fails.push(`switch to ${t}: ink ${hexOf(got.ink)} white ${hexOf(got.white)}, after a load they are ${hexOf(want["#1e1e1e"])} ${hexOf(want["#ffffff"])}`);
      }
      exports.phone.push([t, await exportOf(ph)]);
    }
    const changed = (await ph.out()).slice(loadedAt).filter((m) => m.t === "changed").length;
    if (changed) live.fails.push(`${changed} \`changed\` after the theme switches`);
    const mark = (await ph.out()).length;
    await ph.send({ t: "unload" });
    await ph.page.waitForTimeout(800);
    const afterUnload = (await ph.out()).slice(mark).filter((m) => m.t === "changed").length;
    if (afterUnload) live.fails.push(`${afterUnload} \`changed\` after unload`);

    const dk = pages.desktop;
    await dk.load("live", sc.swatches, LIGHT);
    await dk.page.waitForTimeout(800);
    for (const t of order) {
      await dk.send({ t: "theme", theme: t === null ? LIGHT : themeMsg(t) });
      await dk.page.waitForTimeout(200);
      exports.desktop.push([t, await exportOf(dk)]);
    }
    const exp = { fails: [], notes: [] };
    for (const kind of ["phone", "desktop"]) {
      const set = new Set(exports[kind].map(([, png]) => png));
      if (set.size !== 1) exp.fails.push(`${kind}: the image differs between theme states (${set.size} different)`);
    }
    if (exports.phone[0][1] !== exports.desktop[0][1]) exp.notes.push("the two pages' images differ (bytes), whatever the theme");
    for (const row of rows.filter((r) => r.engine === name)) Object.assign(row, { live: live.fails, exp: exp.fails, expNotes: exp.notes, switches });
    for (const kind of ["phone", "desktop"]) {
      const bad = pages[kind].watch.console;
      if (bad.length) findings.push(`${name} ${kind}: console errors: ${[...new Set(bad)].slice(0, 2).join(" | ").slice(0, 300)}`);
    }

    // 6. the sheets' other two boards
    if (sheetShots) {
      for (const t of THEMES) for (const [board, scene] of [["defaults", sc.defaults], ["pictures", sc.pictures]]) {
        const shot = { engine: name, theme: t, board };
        for (const kind of ["phone", "desktop"]) {
          await pages[kind].load(`${board}-${t}`, scene, themeMsg(t));
          await pages[kind].page.waitForTimeout(board === "pictures" ? 600 : 300);
          shot[kind] = (await pages[kind].shoot([GROUND, [200, 200], [300, 300], [500, 250]])).png;
        }
        sheetShots.push(shot);
      }
    }
  } finally { await browser.close(); }
}

// ---- the sheets

async function composeSheets(pw, shots) {
  const files = [];
  for (const name of ENGINES) {
    const browser = await pw[name].launch();
    try {
      const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 })).newPage();
      for (const t of THEMES) {
        const mine = ["defaults", "palette", "pictures"].map((b) => shots.find((s) => s.engine === name && s.theme === t && s.board === b));
        let png;
        for (const scale of [0.5, 0.42, 0.35, 0.3, 0.25]) {
          const w = Math.round(1000 * scale), h = Math.round(800 * scale);
          const cell = (s, k) => `<img width="${w}" height="${h}" src="data:image/png;base64,${s[k].toString("base64")}">`;
          await page.setViewportSize({ width: 2 * w + 18, height: 3 * (h + 6) + 30 });
          await page.setContent(`<body style="margin:0;background:#777;font:12px sans-serif;color:#fff"><div style="display:grid;grid-template-columns:${w}px ${w}px;gap:6px;padding:6px 6px 0">
            <div>${name} · ${t} · today (desktop page)</div><div>new (phone page)</div>${mine.map((s) => cell(s, "desktop") + cell(s, "phone")).join("")}</div></body>`);
          await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
          png = await page.screenshot();
          if (png.length <= 250 * 1024) break;
        }
        const file = path.join(OUT, `sheet-${name}-${t}.png`);
        fs.writeFileSync(file, png);
        files.push(`${file} (${Math.round(png.length / 1024)} KB)`);
      }
    } finally { await browser.close(); }
  }
  return files;
}

// ---- run

if (!fs.existsSync(path.join(dist, "board.html"))) {
  console.log("dist-webview/ is not built: building it");
  execFileSync(process.execPath, [path.join(pkg, "build.mjs"), "webview"], { stdio: "inherit" });
}
const site = path.join(tmp, "site");
fs.mkdirSync(site, { recursive: true });
execFileSync(process.execPath, [path.join(pkg, "build.mjs"), "web", "--out", path.join(site, "board")], { stdio: "ignore" });
fs.writeFileSync(path.join(site, "driver.js"), `
  window.__out = [];
  window.__mounted = window.aiwbBoardView.mount(document.getElementById("root"), (m) => { window.__out.push(JSON.parse(JSON.stringify(m))); }, { testID: "board" });
  window.__sendRaw = (m) => window.__mounted.receive(m);`);
fs.writeFileSync(path.join(site, "index.html"), `<!doctype html><html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${webBuildCsp}">
<style>html, body, #root { height: 100%; margin: 0; overflow: hidden; }</style>
<link rel="stylesheet" href="./board/board.css"><script src="./board/board.js" defer></script>
<div id="root"></div><script src="./driver.js" defer></script></html>`);

// (the desktop page is served from 127.0.0.1: WebKit does not let a page from file:// load its fonts from file://)
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = http.createServer((req, res) => {
  const file = path.join(site, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(site + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(fs.readFileSync(file));
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));

const pw = findPlaywright();
const scenes = {}, sheetShots = SHEETS ? [] : null;
let crashed = false;
try {
  for (const name of ENGINES) await runEngine(name, pw, site, scenes, sheetShots);
} catch (e) { crashed = true; console.error(e.stack ?? e); }

// ---- the report

const e1 = (v) => (v === null ? "  - " : String(v).padStart(3));
const mark = (r) => (r.fails.length ? "FAIL" : "ok");
console.log("\nreal-engine canvas check (err = largest channel error /255)");
console.log("engine    theme      | desktop vs shown: anch palette | phone: anch vs shown | palette vs model | family fails | chrome | live | export");
for (const r of rows) {
  console.log(`${r.engine.padEnd(9)} ${r.theme.padEnd(10)} | ${" ".repeat(16)}${e1(r.aA)}    ${e1(r.aP)}    | ${" ".repeat(6)}${e1(r.bA)} ${r.bA > 3 ? "FAIL" : "  ok"}       | ${" ".repeat(7)}${e1(r.cP)}      | ${String(r.dFails.length).padStart(7)}      | ${String(r.chromeMax).padStart(3)} ${r.chromeMax > 1 ? "FAIL" : "ok"} | ${r.live?.length ? "FAIL" : "  ok"} | ${r.exp?.length ? "FAIL" : "ok"}`);
}
const lines = [];
for (const r of rows) {
  for (const f of r.fails) lines.push(`FAIL ${r.engine} ${r.theme}: ${f}`);
  if (r.dFails.length) lines.push(`family ${r.engine} ${r.theme} (${r.kind ?? "today's filter"}): ` + r.dFails.map(([c, why]) => `${c} ${why}`).join("; "));
  for (const n of r.notes) lines.push(`note ${r.engine} ${r.theme}: ${n}`);
}
for (const name of ENGINES) {
  const r = rows.find((x) => x.engine === name);
  if (!r) continue;
  for (const f of r.live ?? []) lines.push(`FAIL ${name} live switch: ${f}`);
  for (const f of r.exp ?? []) lines.push(`FAIL ${name} export: ${f}`);
  for (const f of r.expNotes ?? []) lines.push(`note ${name} export: ${f}`);
}
for (const f of findings) lines.push(`note ${f}`);
for (const n of NOTES) lines.push(`note ${n}`);
if (lines.length) console.log("\n" + lines.join("\n"));
for (const r of rows) for (const f of [...r.fails, ...(r.live ?? []), ...(r.exp ?? [])]) fail(f);

if (SHEETS && sheetShots && !crashed) {
  const files = await composeSheets(pw, sheetShots);
  console.log("\ncontact sheets (today left, new right; boards: defaults, palette, picture):\n  " + files.join("\n  "));
}
const bad = crashed || failures.length > 0;
console.log(`\ncanvascheck: ${bad ? "FAILED" : "ok"} (${Math.round((Date.now() - t0) / 1000)} s)`);
if (!bad && !arg("--out")) fs.rmSync(tmp, { recursive: true, force: true }); else console.log(`(kept in ${tmp})`);
server.close();
process.exit(bad ? 1 : 0);
