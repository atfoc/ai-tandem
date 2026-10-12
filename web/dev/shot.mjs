// The driver of the browser checks: a page of the built client on the mock (dev/runmock.mjs), in a
// headless Chromium. Playwright is no dependency of the repository: it is taken from PLAYWRIGHT,
// node_modules or the npx cache (if it is gone: npx -y playwright install chromium).
//
// By hand, against a mock that runs (DIST=/tmp/x/dist PORT=4801 PAUSED=1 node dev/runmock.mjs):
//   node dev/shot.mjs --sel '{"board":"b_arch","chat":"c_board"}' --size 1064x640 \
//     --ls 'aiwb.widths={"side":264,"panel":300}' --ls aiwb.theme=dark --mock 'seedUI("A2")' \
//     --eval 'return document.querySelector(".send").getBoundingClientRect().right' --out /tmp/x/board-300.png
//   --url U (default http://127.0.0.1:4801)   --wait SEL (default .side-tree)   --click SEL and --key KEY (repeatable, in
//   that order)   --clip SEL (a screenshot of one element)   --scale N   --settle MS   --mock CODE (repeatable; run in
//   the mock once the page is open, so that what it sends reaches the page)
//
// What a check (dev/checks/*.mjs, run by dev/uicheck.mjs) imports:
//   check(title, body)            the frame of a check: its mock, its browser, its failures and its exit code
//   buildDist(out?)               the client built into a folder outside the checkout
//   startMock({ dist, port })     a mock of its own; mockEval(code, url) runs code in it; seed(url, ...sections) the UI seed
//   openPage({ url, sel, … })     a page with the selection and localStorage given; paneSize(kind, width) its window
//   measureComposer(page)         which control passes the composer's box, whether Send can be hit, sideways scroll
//   toolbarWidths(page)           the width each control of the composer's toolbar asks for
//   startMove(page)               "Branch from here" on the first reply: a pending move; act(page, what): a seeded state's `act`
//   dragger(page)                 real drags in the sidebar, with every ending
//   toolCards(page, root)         the tool cards of a thread: each one's row and, open, its parts; openCards(page, root)
//                                 opens them all; cardsFit(page, root) what of them passes its pane
//   sampleFrames(page, probe)     a value per painted frame; composerProbe is the probe of the composer's fit;
//                                 dragResizer(page, selector, dx) a drag of a pane's resizer, a frame a step
//   compareShots({ a, b, … })     screenshots of still pages of two builds, compared less a region
//   waitsSeen(page)               what the chat on screen shows of a wait of the fork flows: the thread's messages and
//                                 lines, Send, the banner, the held controls; holds(url, knob) and release(url, knob):
//                                 the calls a knob of the mock holds, and their end
//   atRest(page, frames)          the page drew that many frames in a row with nothing changed in it
//   contrastAudit(page)           the contrast of every text and icon the page shows (or a part of it: `only`), the weakest first;
//                                 colourOf(page, selector, prop) the colour one element is drawn in, contrastOf(a, b)
//   until(fn)                     waits for a sign, in place of a fixed time; onEnd(fn): what to undo when the process
//                                 is ended early, ending(): whether it is being; versions(): the Playwright and the
//                                 Chromium that draw the pages
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const URL0 = "http://127.0.0.1:4801";
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  const browser = await (await loadPlaywright()).chromium.launch();
  try { return { playwright: versionIn(playwrightDir()), chromium: browser.version() }; } finally { await browser.close(); }
}

// ---- the build and the mock

/** Builds the client of `web` (this checkout's, or another worktree's web folder) into `out`, a folder outside the
 *  checkout, and answers `out`. web/dist is not touched: build.mjs runs in a folder of links to the sources. The version
 *  is not "dev", so that the page can show the update notice (the mock's flags.hello). nodeModules: where a worktree
 *  that has none takes its packages from. */
export function buildDist(out = fs.mkdtempSync(path.join(TMP, "aiwb-dist-")), { web = WEB, version = "uicheck", nodeModules = path.join(web, "node_modules") } = {}) {
  const work = fs.mkdtempSync(path.join(TMP, "aiwb-build-"));
  try {
    fs.symlinkSync(path.join(web, "src"), path.join(work, "src"));
    fs.symlinkSync(nodeModules, path.join(work, "node_modules"));
    fs.copyFileSync(path.join(web, "index.html"), path.join(work, "index.html"));
    fs.cpSync(path.join(web, "public"), path.join(work, "public"), { recursive: true });
    try { execFileSync(process.execPath, [path.join(web, "build.mjs")], { cwd: work, env: { ...process.env, AIWB_VERSION: version }, stdio: "pipe" }); }
    catch (e) { throw new Error("the build failed:\n" + (e.stderr?.toString() || e.message)); }
    fs.rmSync(out, { recursive: true, force: true });
    fs.cpSync(path.join(work, "dist"), out, { recursive: true });
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  return out;
}

/** Starts a mock that serves `dist` on `port`, its timers stopped unless paused is false, and answers once it listens.
 *  script: another build's runmock.mjs. stop() ends it; restart() ends it and starts it anew, with nothing seeded. It
 *  is stopped too when the process is ended early (onEnd). down(): whether it has ended by itself (an error thrown in
 *  it), asked of the mock, since a call fails before the end of its process is heard of; log(): what it has printed. */
export async function startMock({ dist, port, paused = true, env = {}, script = path.join(WEB, "dev/runmock.mjs") }) {
  if (!dist || !port) throw new Error("startMock needs a dist folder and a port");
  const url = `http://127.0.0.1:${port}`;
  let proc, log = "", ended = Promise.resolve(), off = () => {}, gone = false, stopped = false;
  const stop = async () => { stopped = true; proc?.kill(); await ended; };
  const start = async () => {
    await stop();
    off(); off = onEnd(stop);
    const p = (proc = spawn(process.execPath, [script], { env: { ...process.env, DIST: dist, PORT: String(port), ...(paused ? { PAUSED: "1" } : {}), ...env }, stdio: ["ignore", "pipe", "pipe"] }));
    gone = stopped = false;
    log = "";
    p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
    ended = new Promise((ok) => p.on("exit", () => { if (p === proc) gone = true; ok(); }));
    for (let i = 0; i < 600 && !gone; i++) { // (half a minute at most: it listens within a second, and ends at once when the port is taken)
      // (the pid tells this mock from another server that holds the port)
      if (await fetch(url + "/api/hello").then((r) => r.json()).then((h) => h.pid === p.pid, () => false)) return;
      await sleep(50);
    }
    await stop(); off();
    throw new Error(`the mock did not start on port ${port}:\n${log}`);
  };
  await start();
  const down = async () => {
    if (!gone && !stopped && !await fetch(url + "/api/hello", { signal: AbortSignal.timeout(5000) }).then(() => true, () => false)) await Promise.race([ended, sleep(5000)]);
    return gone && !stopped;
  };
  return { url, port, dist, stop: async () => { await stop(); off(); }, restart: start, log: () => log, down };
}

/** Runs code inside the mock (an async function body): `chats`, `items`, `runs`, `boards`, `flags`, `send`, `snapshot`,
 *  `seedUI`, … are in scope. Answers what the code returned. */
export async function mockEval(code, url = URL0) {
  const r = await fetch(url + "/mock/eval", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const j = await r.json();
  if (!j.ok) throw new Error("mock eval failed: " + (j.error ?? JSON.stringify(j)));
  return j.r;
}

/** Seeds the UI states (dev/runmock-ui.js): every section, or the ones named ("A2", "A3", …). Answers the seed's
 *  list of states, each with where the page shows it: { id, section, sel, see, … }. */
export const seed = (url, ...sections) => mockEval(`return seedUI(${sections.map((s) => JSON.stringify(s)).join(", ")});`, url);

// ---- pages

/** A page on the mock with the selection and localStorage given (set once, before the page's scripts; with no saved
 *  theme the page follows the system's, which is light here). errors collects the page's errors. clock: the page's
 *  time stands at that moment (ms). still: no animation or transition runs in the page, each is over as it starts,
 *  from the page's first frame (for a picture: see STILL). scheme: the system's theme, "light" or "dark". The caller
 *  closes the context, or the browser when it gave none. */
export async function openPage({ url = URL0, sel, size = [1280, 800], ls = {}, wait = ".side-tree", scale = 1, browser, errors = [], clock, still = false, scheme } = {}) {
  browser ??= await (await loadPlaywright()).chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: scale, ...(scheme ? { colorScheme: scheme } : {}) });
  const store = { ...ls };
  if (sel) store["aiwb.sel"] = JSON.stringify({ board: null, run: null, chat: null, ...sel });
  await ctx.addInitScript((kv) => { if (sessionStorage.getItem("__seeded")) return; for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); sessionStorage.setItem("__seeded", "1"); }, store);
  if (still) await ctx.addInitScript((css) => {
    const add = () => { const st = document.createElement("style"); st.textContent = css; document.documentElement.append(st); };
    if (document.documentElement) add(); else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); add(); } }).observe(document, { childList: true });
  }, STILL);
  const page = await ctx.newPage();
  if (clock !== undefined) await page.clock.setFixedTime(clock);
  page.on("pageerror", (e) => { errors.push(e.message); console.error("pageerror:", e.message); });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  if (wait) await page.waitForSelector(wait, { timeout: 15000 });
  return { browser, ctx, page, errors };
}

// What keeps a page still for a picture: every animation is one round of no length, so it ends as it starts, where a
// screenshot with `animations: "disabled"` would leave it (one with `forwards` at its end, another at the element's
// own style). The screenshot's own stop is not enough: an element that has pulsed, as the sidebar's status dot does,
// is drawn in one of two ways afterwards, two pixels of its edge apart, whatever is done to it then (on a loaded
// machine one comparison of four differed by them).
const STILL = "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; transition-duration: 0s !important; transition-delay: 0s !important }";

const SIDE = 264;
/** The window and the saved widths that give a pane its width: "panel", the chat panel beside a board or a run (the
 *  stage keeps 500 px); "page", a plain chat's page; "stage", a run's or a board's stage with no panel. */
export function paneSize(kind, width, height = 640) {
  const panel = kind === "panel";
  return { size: [SIDE + width + (panel ? 500 : 0), height], ls: { "aiwb.widths": JSON.stringify({ side: SIDE, panel: panel ? width : 400 }) } };
}

// ---- the composer's fit (G1 §Q2 "Method")

/** In the page: every composer shown, with each child of .composer-tools, .context-row and .fk-banner against the
 *  .composer-box. past: how many of them end right of the box's border edge; furthest: by how many px at most; send:
 *  "ok" when Send is the element at its own centre; docScroll: how far the document scrolls sideways. */
function composersInPage() {
  const R = (e) => e.getBoundingClientRect(), r1 = (n) => Math.round(n * 10) / 10;
  const label = (e) => (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).join(".") : e.tagName.toLowerCase()) +
    (e.textContent.trim() ? ` "${e.textContent.trim().replace(/\s+/g, " ").slice(0, 28)}"` : "");
  return [...document.querySelectorAll(".composer")].map((comp) => {
    const box = comp.querySelector(".composer-box");
    if (!box) return { cls: comp.className, none: true };
    const pane = comp.closest(".board-panel, .chat-page, .run-stage, .board-stage"), b = R(box);
    const kids = (sel) => [...(comp.querySelector(sel)?.children ?? [])].filter((e) => !e.matches(".grow, .menu-backdrop"));
    const one = (e, row) => ({ row, el: label(e), w: r1(R(e).width), overBox: r1(R(e).right - b.right) });
    const rows = [...kids(".composer-tools").map((e) => one(e, "tools")), ...kids(".context-row").map((e) => one(e, "context")), ...kids(".fk-banner").map((e) => one(e, "banner"))];
    const over = rows.filter((x) => x.overBox > 0.5), sd = box.querySelector(".send:not(.stop)");
    let send = "none";
    if (sd) { const q = R(sd), h = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); send = h === sd || sd.contains(h) ? "ok" : h ? "covered by " + label(h) : "outside the window"; }
    return { cls: comp.className, pane: pane?.className.split(" ")[0] ?? "", paneW: pane ? r1(R(pane).width) : 0, boxW: r1(b.width), boxOverPane: pane ? r1(b.right - R(pane).right) : 0,
      past: over.length, furthest: over.reduce((m, x) => Math.max(m, x.overBox), 0), over, send, docScroll: document.documentElement.scrollWidth - innerWidth, rows };
  });
}

/** The fit of every composer on the page (see composersInPage). */
export const measureComposer = (page) => page.evaluate(composersInPage);

/** In the page: the controls of the first composer's toolbar, left to right, each with its kind (server, agent, lock,
 *  folder, model, effort, model-effort: the fixed chip of both, loading, subagents, more: the chip of the popup that holds what
 *  the row has no room for, meter, stop, send; the goal composer's tiers and limits), its label, whether it is a fixed chip, its width and its own margin (the lock has one); composer: "chat"
 *  or "goal"; gap: the row's; chrome: what the box takes besides the row (padding and border); sum: the controls with
 *  their margins and the gaps between them on one line, the row's spacer among them at no width; reason: the line
 *  under the controls, when the toolbar has one.
 *  Each control has the width it asks for: none is squeezed, as the lock is in a row that overflows. */
function toolbarInPage() {
  const tools = document.querySelector(".composer .composer-tools");
  if (!tools) return null;
  const r1 = (n) => Math.round(n * 10) / 10, box = tools.closest(".composer-box"), cs = getComputedStyle(box);
  const whole = document.createElement("style");
  whole.textContent = ".composer-tools { flex-wrap: nowrap !important } .composer-tools > * { flex-shrink: 0 !important; max-width: none !important }";
  document.head.append(whole);
  const all = [...tools.children].filter((e) => !e.matches(".agent-reason, .menu-backdrop"));
  const kindOf = (e) => {
    if (e.matches(".send.stop")) return "stop";
    if (e.matches(".send")) return "send";
    if (e.tagName.toLowerCase() === "svg") return "lock";
    const chip = e.matches(".tchip, .ctx-meter") ? e : e.querySelector(".tchip, .ctx-meter");
    if (!chip) return "other";
    if (chip.matches(".ctx-meter")) return "meter";
    if (chip.matches(".more-chip")) return "more";
    const t = chip.getAttribute("title") ?? "";
    if (chip.querySelector(".run-tiers-label")) return "tiers";
    if (t.startsWith("Run settings")) return "limits";
    if (t.startsWith("Server")) return "server";
    if (t.startsWith("Agent")) return "agent";
    if (t.startsWith("Model and effort") || t.startsWith("Starting the agent")) return "model-effort";
    if (t.startsWith("Model")) return "model";
    if (t.startsWith("Effort")) return "effort";
    if (t.startsWith("Subagents")) return "subagents";
    if (/^(Working directory|Folder)/.test(t)) return "folder";
    return chip.textContent.includes("Loading models") ? "loading" : "other";
  };
  const controls = all.filter((e) => !e.matches(".grow")).map((e) => {
    const chip = e.matches(".tchip, .ctx-meter") ? e : e.querySelector(".tchip, .ctx-meter");
    const m = getComputedStyle(e), margin = r1((parseFloat(m.marginLeft) || 0) + (parseFloat(m.marginRight) || 0));
    return { kind: kindOf(e), label: (chip ?? e).textContent.replace(/▾/g, "").replace(/\s+/g, " ").trim(), fixed: !!chip?.matches(".static"), w: r1(e.getBoundingClientRect().width), margin };
  });
  const gap = parseFloat(getComputedStyle(tools).columnGap) || 0;
  const chrome = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"].reduce((n, k) => n + parseFloat(cs[k]), 0);
  whole.remove();
  return { composer: tools.closest(".run-composer") ? "goal" : "chat", controls, gap, chrome: r1(chrome), sum: r1(controls.reduce((n, c) => n + c.w + c.margin, 0) + gap * (all.length - 1)), reason: tools.querySelector(".agent-reason")?.textContent ?? "" };
}

/** The widths the controls of the page's composer toolbar ask for (see toolbarInPage); null with no composer. */
export const toolbarWidths = (page) => page.evaluate(toolbarInPage);

/** "Branch from here" on the first reply of the thread: the chat has a pending move, with its banner. */
export async function startMove(page) {
  await page.locator(".thread .msg.assistant").first().hover();
  await page.locator(".thread .msg.assistant .fk-act.k-branch").first().click({ timeout: 5000 });
  await page.waitForSelector(".fk-banner", { timeout: 5000 });
}

/** What a seeded state asks the page to do before it shows (its `act`, dev/runmock-ui.js). */
export async function act(page, what) {
  switch (what) {
    case undefined: return;
    case "move": return startMove(page);
    case "hover": return page.locator(".thread .msg.assistant").first().hover();
    case "tree": return page.locator(".chat-head .fk-tree-btn").click();
    case "drawer": return page.locator(".thread .subagent").first().click();
    case "select": { // every shape of the board: a click gives the canvas the keys
      await page.waitForSelector(".excalidraw:not(.excalidraw--view-mode) canvas.interactive", { timeout: 10000 });
      const box = await page.locator(".excalidraw canvas.interactive").boundingBox();
      await page.mouse.click(box.x + box.width - 40, box.y + box.height - 40);
      return page.keyboard.press("ControlOrMeta+a");
    }
  }
  throw new Error(`no act "${what}"`);
}

// ---- tool cards

/** In the page: the tool cards under `root`, in order. Each: cls (its classes), label, hint (the line beside the
 *  label), open, and the open card's parts as they are drawn:
 *    { part: "path", path, title, counts, lines }          the file, "+1 −1", "9 lines"
 *    { part: "text", title, failed, lead, text, left, coloured, box }   title: "Command", "Output · failed", …; text: the
 *                                                           texts of its blocks (two when it is cut); left: "⋯ 2,980
 *                                                           lines left out"; coloured: how many coloured spans
 *    { part: "change", title, rows, left, box }            rows: " same", "-removed", "+added", "@⋯ 60 unchanged lines"
 *    { part: "note", text }      { part: "more", text }    "⋯ 18 more edits"
 *  box: [clientHeight, scrollHeight, clientWidth, scrollWidth] of the part's own box. */
function cardsInPage(rootSel) {
  const root = document.querySelector(rootSel);
  if (!root) return null;
  const text = (e) => e?.textContent ?? "", box = (e) => (e ? [e.clientHeight, e.scrollHeight, e.clientWidth, e.scrollWidth] : null);
  return [...root.querySelectorAll(".tool")].map((t) => {
    const detail = t.querySelector(":scope > .tool-detail");
    return { cls: t.className.trim().split(/\s+/), label: text(t.querySelector(".tool-label")), hint: text(t.querySelector(".tool-hint")), open: !!detail,
      parts: [...(detail?.children ?? [])].map((p) => {
        if (p.matches(".tool-path")) return { part: "path", path: text(p.querySelector(".tool-path-name")), title: p.title, counts: text(p.querySelector(".tool-counts")), lines: text(p.querySelector(".tool-lines")) };
        if (p.matches(".tool-note")) return { part: "note", text: text(p) };
        if (p.matches(".tool-omit")) return { part: "more", text: text(p.querySelector("span")) };
        const title = text(p.querySelector(".tool-sub")), diff = p.querySelector(".tool-diff"), body = p.querySelector(".tool-text");
        if (diff) return { part: "change", title, left: text(diff.querySelector(".tool-omit span")), box: box(diff),
          rows: [...diff.querySelectorAll(".diff-row")].map((r) => (r.matches(".skip") ? "@" + text(r) : (r.matches(".add") ? "+" : r.matches(".del") ? "-" : " ") + text(r.querySelector(".diff-text")))) };
        return { part: "text", title, failed: p.matches(".failed"), lead: text(p.querySelector(".tool-lead")), text: [...(body?.querySelectorAll("pre") ?? [])].map(text),
          left: text(body?.querySelector(".tool-omit span")), coloured: body?.querySelectorAll('code.hljs span[class^="hljs-"]').length ?? 0, box: box(body) };
      }) };
  });
}

/** The tool cards of a thread (see cardsInPage): root is ".thread", ".sub-drawer-body", … null with no such element. */
export const toolCards = (page, root = ".thread") => page.evaluate(cardsInPage, root);

/** Opens every closed tool card under root, the first one first. */
export async function openCards(page, root = ".thread") {
  const closed = page.locator(`${root} .tool:not(:has(> .tool-detail)) > .tool-row`);
  for (let n = await closed.count(); n > 0; n--) await closed.first().click();
  await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
}

/** In the page: what of the tool cards under `root` (a thread) passes its pane. cards: how many; width: the thread's
 *  own; wide: the cards that begin or end outside the thread's content box; out: the elements of a card that end past
 *  the card (each as its class and by how many px); sideways: the boxes of a card that scroll sideways; scroll: by how
 *  much the thread and the document scroll sideways. bad: any of them. */
function cardsFitInPage(rootSel) {
  const root = document.querySelector(rootSel);
  if (!root) return null;
  const R = (e) => e.getBoundingClientRect(), cs = getComputedStyle(root), r = R(root), r1 = (n) => Math.round(n * 10) / 10;
  const left = r.left + root.clientLeft + parseFloat(cs.paddingLeft), right = r.left + root.clientLeft + root.clientWidth - parseFloat(cs.paddingRight);
  const name = (e) => e.tagName.toLowerCase() + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).join(".") : "");
  const cards = [...root.querySelectorAll(".tool")], wide = [], out = [], sideways = [];
  for (const [i, t] of cards.entries()) {
    const q = R(t);
    if (q.left < left - 0.5 || q.right > right + 0.5) wide.push(`card ${i + 1}: ${r1(q.left - left)} to +${r1(q.right - right)}`);
    for (const e of t.querySelectorAll("*")) { const over = R(e).right - q.right; if (over > 0.5) out.push(`card ${i + 1} ${name(e)} +${r1(over)}`); }
    for (const e of t.querySelectorAll(".tool-text, .tool-diff, .tool-detail, .tool-row")) if (e.scrollWidth > e.clientWidth) sideways.push(`card ${i + 1} ${name(e)} +${e.scrollWidth - e.clientWidth}`);
  }
  const scroll = Math.max(0, root.scrollWidth - root.clientWidth) + Math.max(0, document.documentElement.scrollWidth - innerWidth);
  return { cards: cards.length, width: r1(r.width), wide, out, sideways, scroll, bad: wide.length + out.length + sideways.length + scroll > 0 };
}

/** Whether the tool cards of a thread lie inside it (see cardsFitInPage). */
export const cardsFit = (page, root = ".thread") => page.evaluate(cardsFitInPage, root);

// ---- real drags in the sidebar (G2 §4): a press and a move start the page's own dragstart, which
// Input.setInterceptDrags hands over; Input.dispatchDragEvent then feeds Blink's drag-target code, which fires
// dragenter, dragleave (with relatedTarget), dragover and drop, and after a drop dragend. There is no OS drag
// session: Esc and leaving the window are stood in for by dragCancel, which gives the page dragend alone.

/** A dragger for the page's sidebar.
 *    row(name), head(name, fx, fy)   the centre of a row, a point of a group's header (fy 0.2: its upper half)
 *    start(p)                        presses on p and moves: false when the page started no drag
 *    over(p)                         the pointer lingers on p (three dragovers)
 *    drop(), cancel()                the endings: a drop where the pointer is; Esc or leaving the window
 *    drawn()                         the page has drawn what it made of the last event
 *    click(p)                        a plain click
 *    lit()                           what is lit now: ["group(Shop).drop [VISIBLE]", "head(Mid).drop-before [hidden by :has]", …]
 *    groupOf(name)                   the group a row is in ("" when ungrouped, null with no such row)
 *    parentOf(name)                  the group a group is in ("" at the top level)
 *  The endings G2 lists are these calls in a row: a drop (over, drop), a drop on a header's upper half
 *  (over(head(n, 0.3, 0.2)), drop), Esc (cancel), a release outside every zone (over(dragger.OUTSIDE), drop), the
 *  dragged node removed in mid-drag (mockEval that removes it, then over and drop).
 *  No call waits a fixed time. Each answers when the page has drawn what it made of the event (two frames: React
 *  commits what a handler set a task later), an ending also when the calls it made of the server were answered. What
 *  must come after that (a row in another group, a row gone) is waited for by the check, with until(). */
export async function dragger(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.setInterceptDrags", { enabled: true });
  await page.evaluate(() => {
    const nameOf = (g) => g?.querySelector(":scope > .side-group-head .side-group-name")?.textContent;
    window.__row = (name) => [...document.querySelectorAll(".side-row")].find((r) => r.querySelector(".side-name")?.textContent === name);
    window.__head = (name) => [...document.querySelectorAll(".side-group-head")].find((h) => h.querySelector(".side-group-name")?.textContent === name);
    window.__lit = () => [...document.querySelectorAll(".drop, .drop-before")].map((e) =>
      (e.classList.contains("side-loose") ? "loose" : e.classList.contains("side-group") ? "group(" + nameOf(e) + ")" : "head(" + nameOf(e.parentElement) + ")")
      + (e.classList.contains("drop-before") ? ".drop-before" : ".drop") + (getComputedStyle(e).boxShadow === "none" ? " [hidden by :has]" : " [VISIBLE]"));
    window.__groupOf = (el) => (el ? nameOf(el.parentElement?.closest(".side-group")) ?? "" : null);
  });
  const point = async (what, name, fx, fy) => {
    const p = await page.evaluate(([what, name, fx, fy]) => {
      const e = (what === "row" ? window.__row : window.__head)(name);
      if (!e) return null;
      e.scrollIntoView({ block: "nearest" });
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width * fx, y: r.top + r.height * fy };
    }, [what, name, fx, fy]);
    if (!p) throw new Error(`the sidebar has no ${what === "row" ? "row" : "group"} "${name}"`);
    return p;
  };
  const mouse = (type, p, buttons = 1) => cdp.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: 1 });
  const dragEvent = (type, p) => cdp.send("Input.dispatchDragEvent", { type, x: p.x, y: p.y, data });
  let data = null, last = null, calls = 0;
  page.on("request", (r) => { if (r.method() !== "GET") calls++; });
  for (const over of ["requestfinished", "requestfailed"]) page.on(over, (r) => { if (r.method() !== "GET") calls--; });
  const drawn = () => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  const end = async (type) => { await dragEvent(type, last); await mouse("mouseReleased", last, 0); await drawn(); await until(() => calls <= 0); await drawn(); };
  return {
    drawn,
    OUTSIDE: { x: page.viewportSize().width - 200, y: page.viewportSize().height / 2 },
    row: (name) => point("row", name, 0.5, 0.5),
    head: (name, fx = 0.3, fy = 0.5) => point("head", name, fx, fy),
    async start(p) {
      await mouse("mouseMoved", p, 0); await mouse("mousePressed", p);
      // (a drag that starts is told within milliseconds; the bound is for a page that starts none)
      const got = new Promise((ok) => { const t = setTimeout(() => ok(null), 10000); cdp.once("Input.dragIntercepted", (e) => { clearTimeout(t); ok(e.data); }); });
      await mouse("mouseMoved", { x: p.x + 6, y: p.y + 3 }); await mouse("mouseMoved", { x: p.x + 14, y: p.y + 6 });
      data = await got; last = p;
      if (data) await dragEvent("dragEnter", { x: p.x + 14, y: p.y + 6 });
      else await mouse("mouseReleased", p, 0);
      return !!data;
    },
    // (a real drag sends dragover over and over, and React commits what one set a moment later)
    async over(p) { last = p; for (let i = 0; i < 3; i++) { await dragEvent("dragOver", { x: p.x + i, y: p.y }); await drawn(); } },
    drop: () => end("drop"),
    cancel: () => end("dragCancel"),
    async click(p) { await mouse("mouseMoved", p, 0); await mouse("mousePressed", p); await mouse("mouseReleased", p, 0); await drawn(); },
    lit: () => page.evaluate(() => window.__lit()),
    groupOf: (name) => page.evaluate((n) => window.__groupOf(window.__row(n)), name),
    parentOf: (name) => page.evaluate((n) => window.__groupOf(window.__head(n)?.parentElement), name),
  };
}

// ---- the waits of the fork flows

/** In the page: what the chat on screen shows of a wait.
 *    msgs      the thread's messages, top to bottom: { who: "user" | "agent", text, sending: the pending look of a
 *              message on its way, live: it is an item of the list (it can be quoted, branched from, forked) }
 *    lines     the wait lines at the thread's foot: [kind, text], kind "send" | "load" | "open" | "pick" | "fork"
 *    typing    the thread's own status lines ("Thinking…", "Starting the agent…")
 *    empty     the empty thread's state is drawn
 *    send      Send: { disabled, title, spin: a spinner in the place of its arrow }; stop: Stop is drawn
 *    banner    the banner's text, "" with none; back: its Back, as a control
 *    alerts    the header's alerts about other branches, as controls
 *    model, effort   the toolbar's model chip (a picker, or the fixed chip) and its effort picker, as controls; fixed:
 *              the model chip is the fixed one
 *    acts      the fork actions of the thread's messages, as controls with their kind ("branch", "branchEdit", "fork",
 *              "forkEdit", "label")
 *    box, err  the composer's text, and the error under it
 *  A control is { disabled (the attribute, or aria-disabled), title, text }, null when it is not drawn. */
function waitsInPage() {
  const text = (e) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
  const ctl = (e) => (e ? { disabled: e.disabled === true || e.getAttribute("aria-disabled") === "true", title: e.getAttribute("title") ?? "", text: text(e) || (e.getAttribute("data-text") ?? "") } : null);
  const thread = document.querySelector(".thread:not(.read-only)"), all = (sel) => [...(thread?.querySelectorAll(sel) ?? [])];
  const send = document.querySelector(".composer .send:not(.stop)");
  const model = document.querySelector('.composer .model-pick > button.tchip, .composer .tchip.static[title^="Starting the agent"], .composer .tchip.static[title^="Model and effort"]');
  return {
    msgs: all(":scope > .msg").map((m) => ({ who: m.classList.contains("user") ? "user" : "agent", text: text(m.querySelector(":scope > .md") ?? m), sending: m.classList.contains("sending"), live: m.hasAttribute("data-item") })),
    lines: all(":scope > .wait-line").map((l) => [l.dataset.wait, text(l)]),
    typing: all(":scope > .typing").map(text),
    empty: !!thread?.querySelector(".empty-thread"),
    send: send ? { ...ctl(send), spin: !!send.querySelector(".spin") } : null,
    stop: !!document.querySelector(".composer .send.stop"),
    banner: text(document.querySelector(".fk-banner .fk-banner-text")),
    back: ctl(document.querySelector(".fk-banner button")),
    alerts: [...document.querySelectorAll(".chat-head .fk-alert")].map(ctl),
    model: ctl(model), fixed: !!model?.classList.contains("static"),
    effort: ctl(document.querySelector('.composer button.tchip[title^="Effort"]')),
    acts: all(".fk-act").map((b) => ({ kind: [...b.classList].find((c) => c.startsWith("k-"))?.slice(2) ?? "", ...ctl(b) })),
    box: text(document.querySelector(".composer .composer-input")),
    err: text(document.querySelector(".composer .composer-err")),
  };
}

/** What the chat on screen shows of a wait of the fork flows (see waitsInPage). */
export const waitsSeen = (page) => page.evaluate(waitsInPage);

/** How many calls a knob of the mock holds (flags[knob] with `hold`): a check waits for it with until(), as the sign
 *  that the page's call has reached the mock. */
export const holds = (url, knob) => mockEval(`return flags.${knob}?.held?.length ?? 0;`, url);

/** Lets go the calls a knob of the mock holds, after `first` (code run in the mock just before: what the call is
 *  answered with: flags.send.refuse = { status: 429, code: "cap", error: "…" }). Answers how many it let go. */
export const release = (url, knob, first = "") => mockEval(`${first}; return release(${JSON.stringify(knob)});`, url);

// ---- frames

/** A probe for sampleFrames: the composer's fit in one frame. null while no chat composer is drawn; else how many
 *  controls of the toolbar end past the box, by how much, whether Send is the element at its own centre, and whether
 *  the document scrolls sideways. bad: any of them. */
export function composerProbe() {
  const box = document.querySelector(".composer:not(.run-composer) .composer-box"), tools = box?.querySelector(".composer-tools");
  if (!tools) return null;
  const right = box.getBoundingClientRect().right;
  let past = 0, by = 0;
  for (const e of tools.children) {
    if (e.matches(".grow, .menu-backdrop")) continue;
    const over = e.getBoundingClientRect().right - right;
    if (over > 0.5) { past++; by = Math.max(by, Math.round(over)); }
  }
  const sd = tools.querySelector(".send:not(.stop)"), q = sd?.getBoundingClientRect();
  const hit = q ? document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2) : null;
  const send = !sd || hit === sd || sd.contains(hit), scroll = document.documentElement.scrollWidth - innerWidth;
  return { bad: past > 0 || !send || scroll > 0, past, by, send, scroll, box: Math.round(box.getBoundingClientRect().width) };
}

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

/** Drags a pane's resizer (".board-panel .resizer", ".side-pane .resizer") by dx px, one pointer move a frame, as a
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
 *    a, b    a build each: a DIST folder (a mock is started for it on `port`, one after the other, timers stopped), a
 *            URL of a server that runs, or { dist, script } for a build served by another runmock.mjs
 *    pages   [{ name, sel, size, ls, wait, scheme, seed: [sections], mock: code run in the mock once the page is open, omit,
 *            style: CSS added to the page in both builds before it is shot }]
 *    omit    selectors of regions left out of every page's comparison (a page's own `omit` adds to them): what they
 *            cover in either build is not compared
 *  Still pages: the caret is hidden and no animation runs (openPage's `still`); the pages' clock stands at `clock`, and
 *  the mocks tell their times from it (T0), so that a label that tells a time is the same in both. clock: null leaves
 *  both on the real time, for a runmock.mjs from before T0. A page is shot once, when it has come to rest (atRest);
 *  one that does not fails the comparison. */
export async function compareShots({ a, b, pages, omit = [], port, out, clock = Date.UTC(2026, 0, 15, 12), browser }) {
  const own = !browser;
  browser ??= await (await loadPlaywright()).chromium.launch();
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
        const { ctx, page } = await openPage({ url, sel: p.sel, size: p.size, ls: p.ls, wait: p.wait, scheme: p.scheme, browser, clock: clock ?? undefined, still: true });
        try {
          if (p.mock) await mockEval(p.mock, url);
          if (p.style) await page.addStyleTag({ content: p.style });
          await page.evaluate(() => document.fonts.ready);
          if (!await atRest(page)) throw new Error(`the page "${p.name}" did not come to rest: its document kept changing, or it kept loading`);
          const file = path.join(dir, `${p.name}-${tag}.png`);
          const png = await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
          const rects = await page.evaluate((sels) => sels.flatMap((s) => [...document.querySelectorAll(s)]).map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }), [...omit, ...(p.omit ?? [])]);
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
      const r = await page.evaluate(async ([pa, pb, rects]) => {
        const load = async (b64) => { const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode(); return img; };
        const [ia, ib] = [await load(pa), await load(pb)];
        if (ia.width !== ib.width || ia.height !== ib.height) return { pixels: ia.width * ia.height, differing: ia.width * ia.height, sizes: [[ia.width, ia.height], [ib.width, ib.height]] };
        const data = (img) => { const c = new OffscreenCanvas(img.width, img.height), g = c.getContext("2d"); g.drawImage(img, 0, 0); for (const [x, y, w, h] of rects) g.clearRect(Math.floor(x), Math.floor(y), Math.ceil(w) + 1, Math.ceil(h) + 1); return g.getImageData(0, 0, img.width, img.height).data; };
        const da = data(ia), db = data(ib);
        let differing = 0;
        for (let k = 0; k < da.length; k += 4) if (da[k] !== db[k] || da[k + 1] !== db[k + 1] || da[k + 2] !== db[k + 2] || da[k + 3] !== db[k + 3]) differing++;
        return { pixels: da.length / 4, differing };
      }, [sa[i].png, sb[i].png, [...sa[i].rects, ...sb[i].rects]]);
      result.push({ name: p.name, ...r, a: sa[i].file, b: sb[i].file });
    }
    await page.close();
    return result;
  } finally { off(); await tidy(); }
}

// ---- the frame of a check

/** Runs one check (a file of dev/checks). body gets { url, browser, mock, dist, fail, note }: the mock is the check's
 *  own, started on PORT with the build in DIST (built now when DIST is not set), or the one that runs at MOCK; fail(line)
 *  records a failure and goes on, a throw ends the check; note(line) prints a line of the result. The process ends
 *  with 1 and a line "FAIL <title>: <what failed>" for each failure, or with 0 and "ok <title>". A mock that has ended
 *  by itself is a failure, told with the end of what it printed: the calls after its end say only "fetch failed". A
 *  promise that fails with nobody waiting for it (a call the check left open when its mock ended) fails the check the
 *  same way, where it would end the process with nothing tidied up. Ended early (onEnd), it closes its browser, stops
 *  its mock and removes the build it made, as at its own end. */
export async function check(title, body) {
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
    const dist = process.env.DIST || (process.env.MOCK ? "" : (built = buildDist()));
    mock = process.env.MOCK ? null : await startMock({ dist, port: Number(process.env.PORT || 4801) });
    browser = await (await loadPlaywright()).chromium.launch();
    await body({ url: mock?.url ?? process.env.MOCK, browser, mock, dist, fail: (line) => { failures.push(line); }, note: (line) => console.log(`     ${line}`) });
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
  const { browser, page } = await openPage({ url, sel: o.sel ? JSON.parse(o.sel) : undefined, size: (o.size ?? "1280x800").split("x").map(Number), ls: o.ls, wait: o.wait ?? ".side-tree", scale: Number(o.scale ?? 1) });
  try {
    for (const code of o.mock) console.error("mock:", JSON.stringify(await mockEval(code, url))); // after the page is open, so that `send` reaches it
    for (const s of o.click) { await page.click(s); await page.waitForTimeout(200); }
    for (const k of o.key) { await page.keyboard.press(k); await page.waitForTimeout(200); }
    await page.waitForTimeout(Number(o.settle ?? 400));
    if (o.eval) console.log(JSON.stringify(await page.evaluate(`(async () => { ${/\breturn\b/.test(o.eval) ? o.eval : `return (${o.eval})`} })()`), null, 1));
    if (o.out) { await (o.clip ? page.locator(o.clip).first() : page).screenshot({ path: o.out }); console.error("screenshot:", o.out); }
  } finally { await browser.close(); }
}
