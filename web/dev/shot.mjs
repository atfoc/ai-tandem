// The driver of the browser checks: a page of the app's web build (app/, its export) on the mock (dev/mock.mjs), in a
// headless Chromium. Playwright is no dependency of the repository: it is taken from PLAYWRIGHT,
// node_modules or the npx cache (if it is gone: npx -y playwright install chromium).
//
// By hand, against a mock that runs (DIST=/tmp/x/dist PORT=4801 node dev/mock.mjs, the dist a build for the checks, see buildAppDist):
//   node dev/shot.mjs --viewport phone --sel '{"board":"b_arch","chat":"c_board"}' --ls aiwb.theme=dark \
//     --mock 'seedUI("A2")' --eval 'return document.title' --out /tmp/x/board.png
//   --url U (default http://127.0.0.1:4801)   --viewport desktop|tablet|phone   --query Q (the page's query: gallery)
//   --wait SEL (default the app's root, APP_READY)   --size WxH (another window on the viewport's device)
//   --click SEL and --key KEY (repeatable, in that order)   --clip SEL (a screenshot of one element)   --scale N
//   --settle MS   --mock CODE (repeatable; run in the mock once the page is open, so that what it sends reaches the page)
//
// What a check (dev/checks/*.mjs, run by dev/uicheck.mjs, see dev/checks/README.md) imports:
//   check(title, body, { viewports, page })   the frame of a check: its mock, its browser, its failures and its exit code; the body
//                                 runs once at each viewport, with a page of the app on the mock and
//                                 { viewport, layout, touch, open } (see check below)
//   buildAppDist(out?)            the app's web export (app/) built into a folder outside the checkout (AD-42)
//   openApp({ url, viewport, … }) a page of the app at a viewport, with the selection and localStorage given
//   freePort()                    a port nothing listens on
//   startMock({ dist, port })     a mock of its own; mockEval(code, url) runs code in it; seed(url, ...sections) the UI seed
//   paneSize(kind, width)         the window and the saved widths that give a pane its width
//   sampleFrames(page, probe)     a value per painted frame;
//                                 dragResizer(page, selector, dx) a drag of a pane's resizer, a frame a step
//   compareShots({ a, b, … })     screenshots of still pages of two builds, compared less a region
//   holds(url, knob) and release(url, knob): the calls a knob of the mock holds, and their end
//   atRest(page, frames)          the page drew that many frames in a row with nothing changed in it
//   contrastAudit(page)           the contrast of every text and icon the page shows (or a part of it: `only`), the weakest first;
//                                 colourOf(page, selector, prop) the colour one element is drawn in, contrastOf(a, b)
//   callsOf(page): the calls the page makes; callMatcher(re, server) and callOfRequest(r): a page.route
//                                 predicate for them, and the call a request carries; hostCall(url, method, path, body, server): a call made on the mock as the page's
//                                 transport makes it
//   launchChromium(playwright)    the browser of the checks: Chromium with the fake microphone (BROWSER_ARGS: the page captures a real
//                                 stream from Chromium's fake device with no prompt, and its sounds play without a gesture);
//                                 every page of openApp has the `microphone` permission (a blocked microphone is
//                                 window.__aiwbVoice.denyMic(true) of a build for the checks, plans/voice-chats/architecture.md VC-32)
//   until(fn)                     waits for a sign, in place of a fixed time; onEnd(fn): what to undo when the process
//                                 is ended early, ending(): whether it is being; versions(): the Playwright and the
//                                 Chromium that draw the pages
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkViewports, contextOptions, isTouch, layoutOfViewport } from "./viewports.mjs";

/** The three flags of the checks' Chromium for voice (arch 13): the microphone's prompt is accepted, the device is a fake one that plays a
 *  beep, and a page may play sound before anyone touched it. */
export const BROWSER_ARGS = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"];

/** Chromium for the pages of the checks (Electron's shim of dev/electron ignores the arguments and has its own permissions). */
export const launchChromium = (playwright) => playwright.chromium.launch({ args: BROWSER_ARGS });

export const URL0 = `http://127.0.0.1:${Number(process.env.PORT || 4801)}`;
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.resolve(WEB, "../app");
const TMP = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Waits for a sign: calls fn (it may be async) until it answers something true, and answers that. After `ms` it
 *  answers what fn said last, which is not true. The bound is generous: a check that passes does not wait it out, and
 *  on a loaded machine what must happen takes several times as long. */
export async function until(fn, ms = 15000) {
  for (const end = Date.now() + ms; ; await sleep(25)) { const v = await fn(); if (v || Date.now() > end) return v; }
}

const ends = new Set();
let armed = false, over = false;
/** Registers what must be undone when the process is ended by SIGTERM, SIGINT or SIGHUP (a command's time limit, the
 *  runner's, Ctrl-C): a mock stopped, a build removed. Then every fn is run, the last registered first, and the
 *  process ends with 128 + the signal's number. Answers a function that takes fn back. */
export function onEnd(fn) {
  if (!armed) for (const [signal, n] of [["SIGTERM", 15], ["SIGINT", 2], ["SIGHUP", 1]]) process.once(signal, async () => {
    over = true;
    for (const f of [...ends].reverse()) await Promise.resolve().then(f).catch(() => {});
    process.exit(128 + n);
  });
  armed = true;
  ends.add(fn);
  return () => { ends.delete(fn); };
}
/** Whether such an end has begun: what fails from then on is the end's doing, and nothing new is started. */
export const ending = () => over;

const versionIn = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version; } catch { return ""; } };
/** The folder of the Playwright used: PLAYWRIGHT, node_modules, or the newest one of the npx cache. */
function playwrightDir() {
  const dirs = [process.env.PLAYWRIGHT, path.join(WEB, "node_modules/playwright")].filter(Boolean);
  const npx = path.join(os.homedir(), ".npm/_npx");
  if (fs.existsSync(npx)) dirs.push(...fs.readdirSync(npx).map((d) => path.join(npx, d, "node_modules/playwright")).sort((a, b) => versionIn(b).localeCompare(versionIn(a), "en", { numeric: true })));
  const dir = dirs.find((d) => fs.existsSync(path.join(d, "index.mjs")));
  if (!dir) throw new Error("playwright not found in:\n  " + dirs.join("\n  ") + "\nrun once: npx -y playwright install chromium");
  return dir;
}

export async function loadPlaywright() { return await import(pathToFileURL(path.join(playwrightDir(), "index.mjs")).href); }

/** What draws the pages: { playwright, chromium }, their versions. The widths of the fixture and every screenshot are
 *  this Chromium's. */
export async function versions() {
  const browser = await launchChromium(await loadPlaywright());
  try { return { playwright: versionIn(playwrightDir()), chromium: browser.version() }; } finally { await browser.close(); }
}

// ---- the build and the mock

/** Builds the app's web export (app/: `npm run build:web`, AD-40) into `out`, a folder outside the checkout, and answers
 *  `out`. app/dist-web is not touched. The version is "uicheck" (the page shows no update notice on version
 *  "dev"). A run of uicheck builds once and gives the folder to every check (DIST). */
export function buildAppDist(out = fs.mkdtempSync(path.join(TMP, "aiwb-app-dist-")), { app = APP, version = "uicheck", connectSelf = true } = {}) {
  // (connectSelf: the page's CSP also has connect-src 'self', which the page needs to reach the mock it is served from; the
  // shipped build, the one the window loads, keeps 'none': app/scripts/export-web.mjs)
  try { execFileSync("npm", ["run", "build:web", "--", "--output-dir", out, ...(connectSelf ? ["--connect-self"] : [])], { cwd: app, env: { ...process.env, EXPO_PUBLIC_AIWB_VERSION: version, CI: "1" }, stdio: "pipe", maxBuffer: 64 << 20 }); }
  catch (e) { throw new Error("the build of the app failed:\n" + (e.stdout?.toString() ?? "").split("\n").slice(-25).join("\n") + (e.stderr?.toString() || e.message)); }
  return out;
}

/** A port nothing listens on at this moment. */
export function freePort() {
  return new Promise((ok, no) => {
    const server = net.createServer();
    server.once("error", no);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => ok(port)); });
  });
}

/** Starts a mock that serves `dist` on `port`, and answers once it listens. script: another build's mock.
 *  stop() ends it; restart() ends it and starts it anew, with nothing seeded. It
 *  is stopped too when the process is ended early (onEnd). down(): whether it has ended by itself (an error thrown in
 *  it), asked of the mock, since a call fails before the end of its process is heard of; log(): what it has printed. */
export async function startMock({ dist, port, env = {}, script = path.join(WEB, "dev/mock.mjs") }) {
  if (!dist || !port) throw new Error("startMock needs a dist folder and a port");
  const url = `http://127.0.0.1:${port}`;
  let proc, log = "", ended = Promise.resolve(), off = () => {}, gone = false, stopped = false;
  const stop = async () => { stopped = true; proc?.kill(); await ended; };
  const start = async () => {
    await stop();
    off(); off = onEnd(stop);
    const p = (proc = spawn(process.execPath, [script], { env: { ...process.env, DIST: dist, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] }));
    gone = stopped = false;
    log = "";
    p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
    ended = new Promise((ok) => p.on("exit", () => { if (p === proc) gone = true; ok(); }));
    for (let i = 0; i < 600 && !gone; i++) { // (half a minute at most: it listens within a second, and ends at once when the port is taken)
      // (the pid tells this mock from another server that holds the port)
      if (await fetch(url + "/mock/state").then((r) => r.json()).then((h) => h.pid === p.pid, () => false)) return;
      await sleep(50);
    }
    await stop(); off();
    throw new Error(`the mock did not start on port ${port}:\n${log}`);
  };
  await start();
  const down = async () => {
    if (!gone && !stopped && !await fetch(url + "/mock/state", { signal: AbortSignal.timeout(5000) }).then(() => true, () => false)) await Promise.race([ended, sleep(5000)]);
    return gone && !stopped;
  };
  return { url, port, dist, stop: async () => { await stop(); off(); }, restart: start, log: () => log, down };
}

/** Runs code inside the mock (an async function body): `chats`, `items`, `boards`, `groups`, `flags`, `send`, `snapshot`,
 *  `seedUI`, … are in scope. Answers what the code returned. */
export async function mockEval(code, url = URL0) {
  const r = await fetch(url + "/mock/eval", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const j = await r.json();
  if (!j.ok) throw new Error("mock eval failed: " + (j.error ?? JSON.stringify(j)));
  return j.r;
}

/** Seeds the UI states (dev/mock-ui.js): every section, or the ones named ("A2", "A3", …). Answers the seed's
 *  list of states, each with where the page shows it: { id, section, sel, see, … }. */
export const seed = (url, ...sections) => mockEval(`return seedUI(${sections.map((s) => JSON.stringify(s)).join(", ")});`, url);

// ---- pages

/** What a context gets before any page script runs: the selection (`aiwb.sel`) and localStorage given, set once (not again when
 *  the page reloads), and, for `still`, the style that stops every animation (see STILL). */
async function seedContext(ctx, sel, ls, still) {
  const store = { ...ls };
  if (sel) store["aiwb.sel"] = JSON.stringify({ board: null, chat: null, ...sel });
  await ctx.addInitScript((kv) => { if (sessionStorage.getItem("__seeded")) return; for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); sessionStorage.setItem("__seeded", "1"); }, store);
  if (still) await ctx.addInitScript((css) => {
    const add = () => { const st = document.createElement("style"); st.textContent = css; document.documentElement.append(st); };
    if (document.documentElement) add(); else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); add(); } }).observe(document, { childList: true });
  }, STILL);
}

/** What shows that the app has drawn: its root view (the testID `app-root`, kept by the shell). A page that opens a
 *  screen of its own (the gallery) says its own `wait`. */
export const APP_READY = '[data-testid="app-root"]';

/** A page of the app at a viewport (dev/viewports.mjs), on the mock at `url` (its folder served is the web export), the
 *  page of a check. viewport: "desktop" | "tablet" | "phone" (the device's window and touch);
 *  query: the page's query without the "?" ("gallery"); sel, ls, scheme, clock, still, errors, browser: as below; size:
 *  another window [w, h] on the viewport's device; scale: another device scale factor; wait: a selector to wait for
 *  (APP_READY by default, "" for none). The caller closes the context, or the browser when it gave none. */
export async function openApp({ url = URL0, viewport = "desktop", query = "", sel, ls = {}, wait = APP_READY, size, scale, browser, errors = [], clock, still = false, scheme } = {}) {
  if (dropped.has(url)) { const id = dropped.get(url); dropped.delete(url); await mockEval(`setServerState(${JSON.stringify(id)}, "connected");`, url).catch(() => {}); }
  const playwright = await loadPlaywright();
  browser ??= await launchChromium(playwright);
  const ctx = await browser.newContext({ ...contextOptions(playwright, viewport, { size, scale, scheme }), permissions: ["microphone"] });
  await seedContext(ctx, sel, ls, still);
  const page = await ctx.newPage();
  if (clock !== undefined) await page.clock.setFixedTime(clock);
  page.on("pageerror", (e) => { errors.push(e.message); console.error("pageerror:", e.message); });
  await page.goto(`${url}/${query ? "?" + query : ""}`, { waitUntil: "domcontentloaded" });
  if (wait) await page.waitForSelector(wait, { timeout: 30000 });
  return { browser, ctx, page, errors };
}

// What keeps a page still for a picture: every animation is one round of no length, so it ends as it starts, where a
// screenshot with `animations: "disabled"` would leave it (one with `forwards` at its end, another at the element's
// own style). The screenshot's own stop is not enough: an element that has pulsed, as the sidebar's status dot does,
// is drawn in one of two ways afterwards, two pixels of its edge apart, whatever is done to it then (on a loaded
// machine one comparison of four differed by them).
const STILL = "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; transition-duration: 0s !important; transition-delay: 0s !important }";

const SIDE = 264;
/** The window and the saved widths that give a pane its width: "panel", the chat panel beside a board (the stage
 *  keeps 500 px); "page", a plain chat's page; "stage", a board's stage with no panel. */
export function paneSize(kind, width, height = 640) {
  const panel = kind === "panel";
  return { size: [SIDE + width + (panel ? 500 : 0), height], ls: { "aiwb.widths": JSON.stringify({ side: SIDE, panel: panel ? width : 400 }) } };
}

/** The server a state has dropped, by the mock's address: put back when the next page opens on that mock (openApp). */
export const dropped = new Map();

/** How many calls a knob of the mock holds (flags[knob] with `hold`): a check waits for it with until(), as the sign
 *  that the page's call has reached the mock. */
export const holds = (url, knob) => mockEval(`return flags.${knob}?.held?.length ?? 0;`, url);

/** Lets go the calls a knob of the mock holds, after `first` (code run in the mock just before: what the call is
 *  answered with: flags.send.refuse = { status: 429, code: "cap", error: "…" }). Answers how many it let go. */
export const release = (url, knob, first = "") => mockEval(`${first}; return release(${JSON.stringify(knob)});`, url);

// ---- frames

/** Samples the page once per frame, after the frame is painted, until stop() is called: probe is a function run in
 *  the page (no closure: it is sent as text) that answers a value for the frame, or null for a frame that does not
 *  count. stop() answers { frames, values, bad }: the frames seen, the values that were not null, and those of them
 *  with a true `bad`.
 *  The sample is a task posted at "user-blocking" from the frame's requestAnimationFrame callback. It runs after that
 *  frame's layout, observers and paint and before any task the page queued in them, so it reads what was painted: a
 *  sampler inside the callback reads a state the frame's observers still change (it fails a correct build), and a
 *  plain message posted from it runs after React's own task has repaired a wrong one (it passes a wrong build).
 *  fromLoad: the sampler is also put into every page loaded from now on, before its scripts: a reload is sampled from
 *  its first frame. */
export async function sampleFrames(page, probe = composerProbe, { fromLoad = false } = {}) {
  const install = `(() => {
    const probe = ${probe.toString()};
    const s = (window.__frames = { on: true, frames: 0, values: [] });
    const tick = () => {
      if (!s.on) return;
      scheduler.postTask(() => { if (!s.on) return; s.frames++; let v; try { v = probe(); } catch (e) { v = { bad: true, error: String(e) }; } if (v !== null && v !== undefined) s.values.push(v); }, { priority: "user-blocking" });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`;
  if (fromLoad) await page.addInitScript(install);
  await page.evaluate(install);
  return {
    async stop() {
      const r = await page.evaluate(() => { const s = window.__frames; s.on = false; return { frames: s.frames, values: s.values }; });
      return { ...r, bad: r.values.filter((v) => v && v.bad) };
    },
  };
}

/** Drags a pane's resizer (`selector` names it: a testID's) by dx px, one pointer move a frame, as a
 *  hand does it: the pane is drawn at every width on the way. */
export async function dragResizer(page, selector, dx, step = 6) {
  const b = await page.locator(selector).boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let d = step; d <= Math.abs(dx); d += step) { await page.mouse.move(x + Math.sign(dx) * d, y); await page.evaluate(() => new Promise((ok) => requestAnimationFrame(ok))); }
  await page.mouse.move(x + dx, y); await page.mouse.up();
  await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
}

// ---- what can be read: the contrast of every text and icon of a page

/** In the page: every text and every icon that is drawn, with the contrast of its colour against what is behind it,
 *  the weakest first: [{ kind: "text" | "icon", what, where, fg, bg, ratio }]. A text is a text node's element; an
 *  icon is an svg, by the paint of its shapes (the best of them: an icon of two colours is read by one). Behind an
 *  element is what the page has under its middle, the lowest first, each background laid over the one below (so a
 *  hint that floats over the canvas is read against the canvas, not against its parent); for an element whose middle
 *  is scrolled out of sight or takes no pointer, the backgrounds of its ancestors. An opacity fades the colour toward
 *  that. canvas: the colour [r, g, b] a canvas shows where nothing is drawn on it (the page cannot read it).
 *  Left out: what a canvas draws, what is not shown, a control that is disabled, and what `skip` (selectors) names;
 *  with `only` (selectors), everything that is not inside an element one of them names.
 *  It does not know of a background that is an image: there a check reads the pair itself (colourOf). */
function contrastInPage({ skip = [], only = [], canvas = [255, 255, 255] } = {}) {
  const parse = (c) => {
    let m = /^rgba?\(([^)]+)\)$/.exec(c);
    if (m) { const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
    m = /^color\(srgb ([^)]+)\)$/.exec(c);
    if (m) { const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]; }
    return null;
  };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const lum = (c) => { const [r, g, b] = c.slice(0, 3).map((v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const hex = (c) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const name = (e) => e.tagName.toLowerCase() + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).join(".") : "");
  const where = (e) => { const out = []; for (let x = e; x && out.length < 3 && x !== document.body; x = x.parentElement) out.unshift(name(x)); return out.join(" > "); };
  const left = (e) => !!e.closest(["canvas", "[disabled]", "[aria-disabled=true]", ...skip].join(", ")) || (only.length > 0 && !e.closest(only.join(", ")));
  const shown = (e) => { const cs = getComputedStyle(e); if (cs.visibility !== "visible" || !e.getClientRects().length) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  /** What is behind e's own content, and how much of e shows through the opacities above it. */
  const behind = (e) => {
    const chain = []; for (let x = e; x; x = x.parentElement) chain.unshift(x);
    const r = e.getBoundingClientRect(), stack = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2), at = stack.indexOf(e);
    let bg = [255, 255, 255, 1], opacity = 1;
    for (const x of at < 0 ? chain : stack.slice(at).reverse()) {
      if (x.tagName === "CANVAS") { bg = [...canvas, 1]; continue; }
      const c = parse(getComputedStyle(x).backgroundColor); if (c && c[3] > 0) bg = over(c, bg);
    }
    for (const x of chain) opacity *= Number(getComputedStyle(x).opacity);
    return { bg, opacity };
  };
  const seen = (e, colour) => { const { bg, opacity } = behind(e); const c = over(colour, bg); return { fg: over([c[0], c[1], c[2], opacity], bg), bg }; };
  const rows = [], done = new Set();
  const add = (kind, e, what, fg, bg) => {
    const key = [kind, what, hex(fg), hex(bg), where(e)].join("|");
    if (done.has(key)) return; done.add(key);
    rows.push({ kind, what, where: where(e), fg: hex(fg), bg: hex(bg), ratio: Math.floor(ratio(fg, bg) * 100) / 100 });
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const e = n.parentElement, text = n.nodeValue.trim();
    if (!text || !e || e.closest("svg, script, style, noscript") || left(e) || !shown(e)) continue;
    const r = document.createRange(); r.selectNodeContents(n);
    if (![...r.getClientRects()].some((b) => b.width > 0 && b.height > 0)) continue;
    const c = parse(getComputedStyle(e).color); if (!c) continue;
    const { fg, bg } = seen(e, c);
    add("text", e, text.replace(/\s+/g, " ").slice(0, 32), fg, bg);
  }
  for (const svg of document.querySelectorAll("svg")) {
    if (left(svg) || !shown(svg)) continue;
    let best = null;
    for (const sh of svg.querySelectorAll("path, circle, rect, line, polyline, polygon, ellipse")) {
      const cs = getComputedStyle(sh);
      for (const paint of [cs.stroke, cs.fill]) {
        const c = parse(paint); if (!c || c[3] === 0) continue;
        const { fg, bg } = seen(sh, c), q = ratio(fg, bg);
        if (!best || q > best.q) best = { fg, bg, q };
      }
    }
    if (best) add("icon", svg, svg.getAttribute("aria-label") || svg.closest("[title], [aria-label]")?.getAttribute("title") || svg.closest("[aria-label]")?.getAttribute("aria-label") || "icon", best.fg, best.bg);
  }
  return rows.sort((a, b) => a.ratio - b.ratio);
}

/** The contrast of everything a page shows (contrastInPage), the weakest first. skip: selectors left out; only:
 *  selectors of the parts that are read, when it is not the whole page; canvas: the colour of an empty canvas,
 *  [r, g, b]. */
export const contrastAudit = (page, { skip = [], only = [], canvas } = {}) => page.evaluate(contrastInPage, { skip, only, canvas });

/** In the page: the colour an element is drawn in, as [r, g, b] of 0 to 255 with every alpha laid over what is
 *  behind it. prop: "color", "backgroundColor", "borderTopColor", …; pseudo: "::after" for a pseudo-element's. */
function colourInPage({ selector, prop = "color", pseudo = null }) {
  const e = document.querySelector(selector);
  if (!e) return null;
  const parse = (c) => {
    let m = /^rgba?\(([^)]+)\)$/.exec(c);
    if (m) { const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
    m = /^color\(srgb ([^)]+)\)$/.exec(c);
    if (m) { const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]; }
    return null;
  };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  // what is behind: the ancestors' backgrounds; for a pseudo-element or a text, the element's own too
  const chain = []; for (let x = prop === "backgroundColor" && !pseudo ? e.parentElement : e; x; x = x.parentElement) chain.unshift(x);
  let bg = [255, 255, 255, 1];
  for (const x of chain) { const c = parse(getComputedStyle(x).backgroundColor); if (c && c[3] > 0) bg = over(c, bg); }
  const c = parse(getComputedStyle(e, pseudo)[prop]);
  return c ? over(c, bg).slice(0, 3).map((v) => Math.round(v)) : null;
}
export const colourOf = (page, selector, prop = "color", pseudo = null) => page.evaluate(colourInPage, { selector, prop, pseudo });

/** The contrast ratio of two colours, each [r, g, b]: WCAG 2's. */
export function contrastOf(a, b) {
  const lum = (c) => { const [r, g, bl] = c.map((v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---- screenshots of two builds

/** The page has come to rest: it drew `frames` frames in a row in which nothing changed in its document and nothing
 *  was loaded. Frames and not a time: a loaded machine draws them more slowly, and the page gets as much longer.
 *  Nothing is done to the page meanwhile, and it is shot once: "screenshots until two are the same" is no sign of rest
 *  here, since a screenshot with animations disabled starts them anew. False when the page did not rest within fifty
 *  times as many frames. */
export const atRest = (page, frames = 24) => page.evaluate((frames) => new Promise((done) => {
  let quiet = 0, seen = 0;
  const stir = () => { quiet = 0; };
  const doc = new MutationObserver(stir), loads = new PerformanceObserver(stir);
  doc.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  loads.observe({ type: "resource" });
  const tick = () => { if (++quiet < frames && ++seen < frames * 50) return requestAnimationFrame(tick); doc.disconnect(); loads.disconnect(); done(quiet >= frames); };
  requestAnimationFrame(tick);
}), frames);

/** Compares screenshots of still pages of two builds and answers one entry per page: { name, pixels, differing, a, b }
 *  (a and b: the PNG files, kept in `out` when it is given).
 *    a, b    a build each: a DIST folder (a mock is started for it on `port`, one after the other), a
 *            URL of a server that runs, or { dist, script } for a build served by another build's mock
 *    pages   [{ name, sel, size, ls, wait, scheme, seed: [sections], mock: code run in the mock once the page is open, omit,
 *            style: CSS added to the page in both builds before it is shot, act: async (page) => … run before the shot (a
 *            popup opened), viewport and query: the page's viewport and query (openApp's) }]
 *    tolerance  a pixel differs when a channel of it is more than this many levels (of 255) from the other's; 0: every
 *            difference counts. The build's rounded borders are drawn one level apart by two rasters of one page
 *    omit    selectors of regions left out of every page's comparison (a page's own `omit` adds to them): what they
 *            cover in either build is not compared
 *  Still pages: the caret is hidden and no animation runs (openApp's `still`); the pages' clock stands at `clock`, and
 *  the mocks tell their times from it (T0), so that a label that tells a time is the same in both. clock: null leaves
 *  both on the real time, for a mock from before T0. A page is shot once, when it has come to rest (atRest);
 *  one that does not fails the comparison. */
export async function compareShots({ a, b, pages, omit = [], port, out, clock = Date.UTC(2026, 0, 15, 12), browser, tolerance = 0 }) {
  const own = !browser;
  browser ??= await launchChromium(await loadPlaywright());
  const dir = out ?? fs.mkdtempSync(path.join(TMP, "aiwb-shots-"));
  fs.mkdirSync(dir, { recursive: true });
  const tidy = async () => { if (own) await browser.close().catch(() => {}); if (!out) fs.rmSync(dir, { recursive: true, force: true }); };
  const off = onEnd(tidy);
  const shoot = async (side, tag) => {
    const spec = typeof side === "string" ? (/^https?:/.test(side) ? { url: side } : { dist: side }) : side;
    const mock = spec.url ? null : await startMock({ dist: spec.dist, port, script: spec.script, env: clock === null ? {} : { T0: String(clock - 1000) } });
    const url = spec.url ?? mock.url, shots = [];
    try {
      for (const p of pages) {
        if (p.seed) await seed(url, ...p.seed);
        const { ctx, page } = await openApp({ url, viewport: p.viewport, query: p.query, sel: p.sel, size: p.size, ls: p.ls, wait: p.wait, scheme: p.scheme, browser, clock: clock ?? undefined, still: true });
        try {
          if (p.mock) await mockEval(p.mock, url);
          if (p.act) await p.act(page);
          if (p.style) await page.addStyleTag({ content: p.style });
          await page.evaluate(() => document.fonts.ready);
          if (!await atRest(page)) throw new Error(`the page "${p.name}" did not come to rest: its document kept changing, or it kept loading`);
          const file = path.join(dir, `${p.name}-${tag}.png`);
          const png = await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
          // (the shot is in device pixels, the page's boxes in CSS ones: a touch viewport has a scale of 2 or 3)
          const rects = await page.evaluate((sels) => sels.flatMap((s) => [...document.querySelectorAll(s)]).map((e) => { const r = e.getBoundingClientRect(), k = devicePixelRatio; return [r.left * k, r.top * k, r.width * k, r.height * k]; }), [...omit, ...(p.omit ?? [])]);
          shots.push({ file, png: png.toString("base64"), rects });
        } finally { await ctx.close(); }
      }
    } finally { await mock?.stop(); }
    return shots;
  };
  try {
    const sa = await shoot(a, "a"), sb = await shoot(b, "b");
    const page = await browser.newPage();
    const result = [];
    for (const [i, p] of pages.entries()) {
      const r = await page.evaluate(async ([pa, pb, rects, tol]) => {
        const load = async (b64) => { const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode(); return img; };
        const [ia, ib] = [await load(pa), await load(pb)];
        if (ia.width !== ib.width || ia.height !== ib.height) return { pixels: ia.width * ia.height, differing: ia.width * ia.height, sizes: [[ia.width, ia.height], [ib.width, ib.height]] };
        // (a canvas on the CPU: one on the GPU read the same pixels of one picture differently from run to run)
        const data = (img) => { const c = new OffscreenCanvas(img.width, img.height), g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0); for (const [x, y, w, h] of rects) g.clearRect(Math.floor(x), Math.floor(y), Math.ceil(w) + 1, Math.ceil(h) + 1); return g.getImageData(0, 0, img.width, img.height).data; };
        const da = data(ia), db = data(ib);
        let differing = 0;
        for (let k = 0; k < da.length; k += 4) if (Math.abs(da[k] - db[k]) > tol || Math.abs(da[k + 1] - db[k + 1]) > tol || Math.abs(da[k + 2] - db[k + 2]) > tol || Math.abs(da[k + 3] - db[k + 3]) > tol) differing++;
        return { pixels: da.length / 4, differing };
      }, [sa[i].png, sb[i].png, [...sa[i].rects, ...sb[i].rects], tolerance]);
      result.push({ name: p.name, ...r, a: sa[i].file, b: sb[i].file });
    }
    await page.close();
    return result;
  } finally { off(); await tidy(); }
}

/** Records the calls a page makes from now on, but its event stream, its pictures and the files of the page itself:
 *  [{ server, method, path (with its query), body (parsed, when it is JSON), status (once answered) }], in the order they
 *  were made. The page sends a call to the face of the mock as POST /host/call?server=&method=&path=; a check reads
 *  where it went: server "local" for a thing of this computer, the entry id for one of a section. */
export function callsOf(page) {
  const calls = [];
  page.on("request", (r) => {
    const call = callOfRequest(r);
    if (!call) return;
    let body; try { body = r.postData() ? JSON.parse(r.postData()) : undefined; } catch { body = r.postData(); }
    const c = { ...call, body };
    calls.push(c);
    r.response().then((res) => { c.status = res?.status(); }, () => {});
  });
  return calls;
}

/** The call a page's request carries: { server, method, path } for a POST /host/call (the path is `/api/…`, with its
 *  query), null for any other request. */
export const callOfURL = (u) => (u.pathname === "/host/call" ? { server: u.searchParams.get("server"), method: u.searchParams.get("method"), path: u.searchParams.get("path") } : null);
export const callOfRequest = (r) => callOfURL(new URL(r.url()));
/** A predicate for page.route (and page.unroute, with the same function) that matches a call of the page whose
 *  "<method> <path>" matches `re`; server: the call's server ("local", an entry id), any when it is left out. */
export const callMatcher = (re, server) => (u) => { const c = callOfURL(u); return !!c && re.test(`${c.method} ${c.path}`) && (server === undefined || c.server === server); };

/** Makes a call of the client API on a server of the mock, over the face's HTTP, as a page's transport does: another
 *  client's change, or a read. Answers { status, body (parsed JSON, or the text), text }. server: "local" or an entry id. */
export async function hostCall(url, method, path, body, server = "local") {
  const r = await fetch(`${url}/host/call?server=${encodeURIComponent(server)}&method=${method}&path=${encodeURIComponent(path)}`,
    { method: "POST", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const text = await r.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, body: parsed, text, sceneRev: r.headers.get("x-aiwb-scene-rev") === null ? null : Number(r.headers.get("x-aiwb-scene-rev")) };
}

// ---- the frame of a check

/** Runs one check (a file of dev/checks). body gets { url, browser, mock, dist, fail, note }: the mock is the check's
 *  own, started on PORT with the build in DIST (built now when DIST is not set), or the one that runs at MOCK; fail(line)
 *  records a failure and goes on, a throw ends the check; note(line) prints a line of the result. The process ends
 *  with 1 and a line "FAIL <title>: <what failed>" for each failure, or with 0 and "ok <title>". A mock that has ended
 *  by itself is a failure, told with the end of what it printed: the calls after its end say only "fetch failed". A
 *  promise that fails with nobody waiting for it (a call the check left open when its mock ended) fails the check the
 *  same way, where it would end the process with nothing tidied up. Ended early (onEnd), it closes its browser, stops
 *  its mock and removes the build it made, as at its own end.
 *
 *  `viewports` (["desktop", "tablet", "phone"], the ones the check's behaviour applies to; AD-80) is required. DIST is a web
 *  export of app/ (built now, with buildAppDist, when not set; dev/checks/README.md), and the body runs once per viewport, in order, each on a mock started anew (nothing seeded) and in a fresh context, with these
 *  besides the above:
 *    viewport, layout, touch   "phone" | "tablet" | "desktop"; the layout the app picks there (the same name); whether it has a
 *                              finger and no mouse
 *    page, context             the page opened for the body (openApp with the options of `page`: query, wait, sel, ls, …) and its
 *                              context; none when the option `page` is false (a check that opens its own)
 *    open(opts)                another page on the same mock at this viewport (a new context; openApp's options, `wait` and
 *                              the others of `page` as defaults); closed when the body ends. One page at a time: the mock has one
 *                              stream, so `open` while a page is open fails the check (close the first one's context before),
 *                              unless the check asks for a second window on purpose with `beside: true`: the two then take the
 *                              stream in turn (each takes it back when its browser retries, about 3 s later, and is told the
 *                              snapshot), so what a page reads of the other's doing comes by that snapshot, not by the event
 *    fail(line), note(line)    with the viewport named in the line
 *    errors                    the messages of the console errors of every page opened here
 *  A page error (an uncaught exception) or a console error in any of those pages fails the check; `allowConsole: [/re/]` names the
 *  console errors a check causes on purpose (a server that is cut). VIEWPORT=phone runs one viewport only (by hand). */
export async function check(title, body, { viewports, page: pageOpts = {}, allowConsole = [] } = {}) {
  const failures = [];
  let mock, browser, built, done = false;
  const tidy = async () => { await browser?.close().catch(() => {}); await mock?.stop(); if (built) fs.rmSync(built, { recursive: true, force: true }); };
  const end = async () => {
    if (done || ending()) return; // (ended early: the signal's handler tidies up and ends the process)
    done = true;
    if (failures.length && await mock?.down()) failures.push(`the mock ended by itself. The end of its log:\n${mock.log().trimEnd().split("\n").slice(-12).join("\n")}`);
    await tidy();
    for (const f of failures) console.log(`FAIL ${title}: ${f}`);
    if (!failures.length) console.log(`ok   ${title}`);
    process.exit(failures.length ? 1 : 0);
  };
  onEnd(tidy);
  process.on("unhandledRejection", (e) => { failures.push(String(e?.stack ?? e)); end(); });
  try {
    if (!viewports) throw new Error(`"${title}" names no viewports`);
    let names = checkViewports(viewports, `the viewports of "${title}"`);
    if (process.env.VIEWPORT) {
      if (!names.includes(process.env.VIEWPORT)) throw new Error(`VIEWPORT=${process.env.VIEWPORT}: this check runs at ${names.join(", ")}`);
      names = [process.env.VIEWPORT];
    }
    const dist = process.env.DIST || (process.env.MOCK ? "" : (built = buildAppDist()));
    mock = process.env.MOCK ? null : await startMock({ dist, port: Number(process.env.PORT || 4801) });
    const playwright = await loadPlaywright();
    browser = await launchChromium(playwright);
    const url = mock?.url ?? process.env.MOCK;
    for (const [i, viewport] of names.entries()) {
      if (i > 0 && mock) await mock.restart();
      const say = (line) => `${viewport}: ${line}`, errors = [], contexts = [];
      const watch = (page) => {
        page.on("pageerror", (e) => { failures.push(say(`page error: ${e.message}`)); });
        // ("Failed to load resource" is the browser's line for any answer of 400 or more: a call the check makes fail on purpose is one)
        page.on("console", (m) => {
          if (m.type() !== "error" || /^Failed to load resource/.test(m.text())) return;
          errors.push(m.text());
          if (!allowConsole.some((re) => re.test(m.text()))) failures.push(say(`console error: ${m.text()}`));
        });
      };
      // (the mock, like the host of the app, has one stream for one page: a second page open at the same time takes it from the first, which
      // takes it back when the browser retries, about 3 s later, and the snapshot that follows each time remounts what the page shows)
      const open = async ({ beside = false, ...opts } = {}) => {
        if (!beside && contexts.some((c) => c.pages().length)) failures.push(say(`a page was opened while another is still open (${new Error().stack.split("\n")[2].trim()}): the mock has one stream for one page, so the two take it from each other every 3 s; close the first one (its context) before the next`));
        const o = await openApp({ url, viewport, browser, ...pageOpts, ...opts });
        contexts.push(o.ctx);
        watch(o.page);
        return o;
      };
      try {
        const first = pageOpts === false ? null : await open();
        await body({ url, browser, mock, dist, fail: (line) => { failures.push(say(line)); }, note: (line) => console.log(`     ${say(line)}`),
          viewport, layout: layoutOfViewport(viewport), touch: isTouch(viewport), page: first?.page, context: first?.ctx, open, errors, playwright });
      } catch (e) { failures.push(say(String(e?.stack ?? e))); } // (a throw ends this viewport; the others still run)
      for (const c of contexts) await c.close().catch(() => {});
    }
  } catch (e) { failures.push(String(e?.stack ?? e)); }
  await end();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), o = { ls: {}, mock: [], click: [], key: [] };
  for (let i = 0; i < a.length; i += 2) {
    const k = a[i].replace(/^--/, ""), v = a[i + 1];
    if (k === "ls") o.ls[v.slice(0, v.indexOf("="))] = v.slice(v.indexOf("=") + 1);
    else if (Array.isArray(o[k])) o[k].push(v);
    else o[k] = v;
  }
  const url = o.url ?? URL0;
  const { browser, page } = await openApp({ url, viewport: o.viewport, query: o.query, sel: o.sel ? JSON.parse(o.sel) : undefined, size: o.size ? o.size.split("x").map(Number) : undefined, ls: o.ls, wait: o.wait, scale: o.scale ? Number(o.scale) : undefined });
  try {
    for (const code of o.mock) console.error("mock:", JSON.stringify(await mockEval(code, url))); // after the page is open, so that `send` reaches it
    for (const s of o.click) { await page.click(s); await page.waitForTimeout(200); }
    for (const k of o.key) { await page.keyboard.press(k); await page.waitForTimeout(200); }
    await page.waitForTimeout(Number(o.settle ?? 400));
    if (o.eval) console.log(JSON.stringify(await page.evaluate(`(async () => { ${/\breturn\b/.test(o.eval) ? o.eval : `return (${o.eval})`} })()`), null, 1));
    if (o.out) { await (o.clip ? page.locator(o.clip).first() : page).screenshot({ path: o.out }); console.error("screenshot:", o.out); }
  } finally { await browser.close(); }
}
