// Readers, one writer and the button (headless-board goal 6.3), with three real pages on one real server and a stand-in agent.
//
// A board has one writer at any moment and any number of readers; a reader shows the board read-only and follows the writer live;
// the button "Edit here" is the only way a page becomes the writer; the headless writer (packages/headless, a Node process the
// server starts when an agent needs a board no window holds) gives a board up to a press like a window does. The Go tests show the
// server's side with stand-in clients and the uicheck pages (HB.1) the reader's bar on the mock; this script shows all of it with the
// real pages of the app, the real server and the real headless writer. No paid model is called: the agent is the repository's
// scripted stand-in, internal/agenttest/fake-claude, which calls the board tools of the server's MCP endpoint (`[[mcp apply …]]`,
// `[[sleep …]]`).
//
// One server, S, and three pages, each served by a test host (web/dev/host.mjs) of its own, with a state folder of its own: three
// apps, with three client ids, as on three machines.
//   P1  the app on S's machine: S is its first section, "This computer"
//   P2  another machine: S is an entry of its list, reached over a link the script owns (a TCP relay: it can pull the network)
//   P3  another machine: S is an entry of its list
// S runs with the headless writer (`-headless-node` this Node, `-headless-dir packages/headless/dist`, built here when it is not)
// and with lowered waits (AIWB_TEST_WAITS): the hand-off time (`handover`, the bridge's 10 s), the time the headless writer keeps a
// board after the agent's last call (`quiet`) and how often it is looked at for the idle stop (`linger`). A page's host reads
// AIWB_APP_WAITS-style timing too: P2's reconnect backoff is short.
//
// Boards are made by the script itself through the client API with a client that has no stream (web/e2e/lib/clientapi.mjs): a board
// made so is held by nobody, which is what these checks start from. What a page shows of a board is read from its bar (`board-role`
// with `data-role` and `data-writer`, the "Edit here" button, the "Editing" mark) and from the editor itself: the elements the
// Excalidraw in the page holds, read from its React fiber (see shownBy).
//
//   (a) opening a board, switching to it, reloading the page, a connection cut and back: never makes a page the writer
//   (b) P1 presses "Edit here" and draws: P2 and P3 show each change without a reload
//   (c) a reader's drawing, paste and a direct PUT of the scene with its client id (and a stranger's) are refused; an agent call on
//       the board is answered by the writer's page and by no reader's
//   (d) P2 presses while P1 has an unsaved change: it is in the board, P2 starts from that revision, P1 says another window took over
//   (e) the headless writer holds a board (an agent's `apply` loop with `[[sleep]]` between the calls) and P3 presses: every finished
//       change is kept, a call cut by the press says so in the words of the server, and P3 is the writer
//   (e2) a call that is on its way when the press comes (a second server whose headless writer holds every `apply` before its save,
//       AIWB_HEADLESS_TEST=hold-before-save) is cut with the server's words for a board taken over in a window, and what it made is
//       not in the board (the stored revision is the one before it)
//   (f) a holder whose write is held up loses the board at the hand-off time and its late write is refused
//   (g) two pages press together: one ends as the writer, the other as a reader, and the board file is valid
//   (h) in the whole run every take a page made was a press of the script's, and no page made a write as a reader
//
// It prints one line per check and exits with 1 when a check failed (2 when it could not run). A check named in KNOWN_FAIL that
// fails is printed as KNOWN-FAIL and does not fail the script: it is a fault of the product that is reported, not one of the script.
// Not part of `npm test`. It spends no money, never touches the installed app (own binary, own data folder, free ports, the MCP
// listener too) and stops its server at the end. About 40 seconds.
//
//   cd web && npm install --no-save playwright@1.64.1 && npx playwright install chromium
//   node web/e2e/readers.e2e.mjs
//
// Environment (all optional):
//   AIWB_E2E_BIN       server binary                    (default: built into the temp folder)
//   DIST               the app's web build to serve (AIWB_E2E_CLIENT too): `cd app && npm run build:web`, then `DIST=app/dist-web`;
//                      without DIST the script builds its own into the temp folder (see twopages.e2e.mjs for the CSP it needs)
//   AIWB_E2E_NODE      the Node that runs the headless writer (default: the one that runs this script)
//   AIWB_E2E_HEADLESS  the headless writer's folder (default: packages/headless/dist, built with `node build.mjs` when it is missing)
//   AIWB_E2E_KEEP=1    keep the temp folder (server log, screenshots) after a run that passed;
//                      after a failed run it is always kept, and its path is printed
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  Link, Scratch, callOf, finish, hostApp, hostCall, hostFor, loadChromium, makeOut, onSignal, openPage as openHostPage, parseAppWaits, repo, serverBinary,
  sleep, standInAgent, waitFor, holds,
} from "./lib/rig.mjs";
import { RawClient } from "./lib/clientapi.mjs";
import * as ui from "./lib/ui.mjs";

const { q } = ui;

const OUT = makeOut("readers");

// ---- checks: one line each

// Checks that fail because of a fault of the product, by name, each with the fault in a few words.
const KNOWN_FAIL = new Map([]);

let failed = 0, known = 0, passed = 0;
function check(name, pass, detail = "") {
  const isKnown = !pass && KNOWN_FAIL.has(name);
  if (pass) passed++; else if (isKnown) known++; else failed++;
  const d = (typeof detail === "string" ? detail : JSON.stringify(detail) ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  console.log(`${pass ? "ok  " : isKnown ? "KNOWN-FAIL" : "FAIL"} - ${name}${isKnown ? `  [${KNOWN_FAIL.get(name)}]` : ""}${d ? `  (${d})` : ""}`);
  return pass;
}
// step runs one part; a part that cannot go on is one failed check, and the next part still runs.
async function step(name, fn) {
  console.log(`# ${name}`);
  try { await fn(); }
  catch (e) {
    check(`${name}: the step ran to its end`, false, e.message);
    await Promise.all(pages.map((p, i) => shot(p, `failed-${name.slice(1, 2)}-p${i + 1}`)));
  }
}

// ---- the scratch server and the three apps

// The server of this script: the headless writer, and the waits lowered.
const HANDOVER = 4000; // ms: the bridge's hand-off time (10 s) as the server is run here; the headless writer yields in four fifths of it
class Server extends Scratch {
  get env() { return { ...super.env, AIWB_TEST_WAITS: `handover=${HANDOVER}ms,quiet=2s,linger=500ms` }; }
  get flags() { return [...super.flags, "-headless-node", process.env.AIWB_E2E_NODE || process.execPath, "-headless-dir", headlessDir()]; }
}
function headlessDir() {
  const dir = path.resolve(process.env.AIWB_E2E_HEADLESS || path.join(repo, "packages/headless/dist"));
  if (!fs.existsSync(path.join(dir, "headless.mjs")) && !process.env.AIWB_E2E_HEADLESS) {
    execFileSync(process.execPath, ["build.mjs"], { cwd: path.join(repo, "packages/headless"), stdio: ["ignore", "inherit", "inherit"] });
  }
  return dir;
}

let S = null;
let S2 = null;         // a second server, for (e2) alone
let host1 = null, host2 = null, host3 = null;
let link = null;       // P2's way to S
let raw = null;        // the script's own client, with no stream
const ENTRY = {};      // S's id in the list of P2 and of P3
const own = (key) => String(key ?? "").split("~").pop(); // a thing's own id, of the page's key of it

async function addServer(host, server = S) {
  const added = await hostApp(host, "servers.add", { force: true, form: { name: "S", address: `https://127.0.0.1:${server.port}`, secret: server.secret, selfSigned: true, pin: server.fingerprint } });
  if (added.status !== 200 || !added.json?.saved) throw new Error(`${host.name}'s host could not add S: ${JSON.stringify(added)}`);
  return added.json.server.id;
}

async function prepare() {
  S = new Server({ out: OUT, bin: serverBinary(OUT), agent: standInAgent(OUT), tag: "s", name: "S" });
  await S.setUp();
  host1 = await hostFor({ out: OUT, name: "p1", local: S });
  await S.launch(); // (found, not started again, by the host that runs the same command)
  link = await new Link(S.port).open();
  const backoff = parseAppWaits("backoff=2s");
  host2 = await hostFor({ out: OUT, name: "p2", extra: { dial: link.dial, timing: backoff } });
  host3 = await hostFor({ out: OUT, name: "p3", extra: { timing: backoff } });
  ENTRY[2] = await addServer(host2);
  ENTRY[3] = await addServer(host3);
  raw = new RawClient(S);
}

// ---- the pages

let browser = null;
const pages = [];
const shot = (page, label) => page.screenshot({ path: path.join(OUT, `${label}.png`) }).catch(() => {});
const nameOf = (p) => `P${p.n}`;
async function openPage(n, host) {
  const page = await openHostPage(browser, host, { viewport: { width: 1400, height: 900 }, timeout: 8000, wait: q.rootVisible });
  page.n = n;
  page.server = n === 1 ? "local" : ENTRY[n];
  page.presses = 0; // the "Edit here" presses the script made in this page
  await page.waitForSelector(ui.treeWait, { timeout: 20000 });
  await ui.stateOfSection(page, page.server).filter({ hasText: /^Connected$/ }).waitFor({ timeout: 90000 });
  pages.push(page);
  return page;
}

const sel = ui.selection;
/** Whether the page has the board (by its own id) on screen. */
const onScreen = async (p, board) => own((await sel(p)).board) === board;

// The bar over the canvas: { role, writer, text, button } or null when there is none (the writer's small mark has no bar).
const bar = (p) => p.locator(q.boardRole);
const barOf = async (p) => {
  const b = bar(p);
  if (!(await b.count())) return null;
  return b.first().evaluate((el, take) => ({ role: el.dataset.role, writer: el.dataset.writer, text: el.innerText.replace(/\s+/g, " ").trim(), button: !!el.querySelector(take) }), q.boardTake).catch(() => null);
};
const editing = (p) => p.locator(q.boardEditing).isVisible().catch(() => false);
/** The page is the writer of the board on screen: the mark, no bar. */
const isWriter = async (p) => (await editing(p)) && !(await bar(p).count());
/** The page shows the board as a reader (the bar and its button, no mark). */
const isReader = async (p) => { const b = await barOf(p); return !!b && b.button && b.role !== "held" && !(await editing(p)); };
const roleWords = async (p) => `${nameOf(p)}: ${JSON.stringify(await barOf(p))}${(await editing(p)) ? " [Editing]" : ""}`;
const DROPPED = "A change made here was not saved in time and was dropped.";
const droppedNote = (p) => p.locator(q.boardRoleDropped);

// The words of the bar (rolebar.ts).
const TEXT = {
  nobody: "View only.",
  window: "View only. Another window is editing this board.",
  agent: "View only. An agent is editing this board.",
  lost: "Another window took over this board. View only.",
};

/** Opens a board's row in the page (a click on a row selects the board and never takes it). */
async function show(p, board) {
  if (!(await onScreen(p, board))) await ui.openRow(p, ui.rowOf(p, "board", names.get(board)));
  await waitFor(`${nameOf(p)} shows board ${names.get(board)}`, async () => (await onScreen(p, board)) && !!(await barOf(p) || await editing(p)), { timeout: 20000 });
  await p.locator(`${q.boardCanvas}[data-state="ready"]`).waitFor({ timeout: 20000 });
}
/** The press of the button: the only thing the script does to make a page a writer. */
async function press(p) {
  p.presses++;
  await ui.click(p, p.locator(q.boardTake));
}
const becomesWriter = (p, what, timeout = 30000) => waitFor(what ?? `${nameOf(p)} is the writer`, () => isWriter(p), { timeout });
const sees = async (p, text, timeout = 15000) => holds(`${nameOf(p)} says "${text}"`, async () => (await barOf(p))?.text === text, { timeout });
/** The bar's text starts with `text` (the dropped note, when there is one, comes after the button). */
const seesStart = async (p, text, timeout = 15000) => holds(`${nameOf(p)} says "${text}"`, async () => (await barOf(p))?.text.startsWith(text), { timeout });

// ---- the boards

const names = new Map(); // board id -> its name in the sidebar
async function newBoard(name) {
  const b = await raw.newBoard(name);
  names.set(b.id, name);
  await waitFor(`every page's sidebar shows "${name}"`, async () => (await Promise.all(pages.map((p) => ui.rowOf(p, "board", name).count()))).every((n) => n === 1));
  return b.id;
}
// The board's file on disk: the live elements, the rectangles among them, and each element with its version.
function elements(board) {
  try {
    const scene = JSON.parse(fs.readFileSync(path.join(S.home, "boards", board, "drawing.excalidraw"), "utf8"));
    return (scene.elements ?? []).filter((e) => !e.isDeleted);
  } catch { return []; }
}
const rectangles = (board) => elements(board).filter((e) => e.type === "rectangle");
const has = (board, id) => elements(board).some((e) => e.id === id);
const drawn = (board) => elements(board).map((e) => [e.id, e.version]);
/** The drawing is still what `was` held: no element is gone or back at an older version, and none was added. */
const unchanged = (board, was) => { const now = new Map(drawn(board)); return now.size === was.length && was.every(([id, v]) => (now.get(id) ?? -1) >= v); };
const fileValid = (board) => { try { const s = JSON.parse(fs.readFileSync(path.join(S.home, "boards", board, "drawing.excalidraw"), "utf8")); return Array.isArray(s.elements); } catch { return false; } };
const sceneRev = async (board) => (await raw.scene(board)).rev;
/** What the server says of a board: { rev, writer } by a follow of this page's own client (the page follows it on screen anyway). */
const serverView = async (p, board) => (await hostCall(p.host, p.server, "POST", `/api/boards/${board}/follow`)).json;

// What a page's canvas holds: the elements of the Excalidraw in the page (not deleted), as [id, version]. They are read from the
// editor itself (the React fiber of its root: Excalidraw has no DOM for an element), so "shows the change" is exact, and independent
// of the page's own scroll and zoom, which a reader keeps and which differ from page to page.
const shownBy = (p) => p.evaluate(() => {
  const el = document.querySelector(".excalidraw");
  const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber"));
  for (let f = key ? el[key] : null; f; f = f.return) {
    const n = f.stateNode;
    if (n && typeof n === "object" && n.scene && typeof n.scene.getNonDeletedElements === "function") return n.scene.getNonDeletedElements().map((e) => [e.id, e.version]);
  }
  return null;
});
/** The page's canvas holds exactly the board's file: the same elements at the same versions. */
const sameAsFile = (list, board) => {
  const file = new Map(drawn(board));
  return !!list && list.length === file.size && list.every(([id, v]) => file.get(id) === v);
};
/** Waits until the page's canvas is the file's drawing; true, or the sentence of what was last seen. */
async function showsFile(p, board, what, timeout = 20000) {
  let last = "";
  const ok = await holds(`${nameOf(p)} shows ${what}`, async () => { const l = await shownBy(p); last = `${nameOf(p)} holds ${l?.length ?? "no"} elements, the file ${drawn(board).length}`; return sameAsFile(l, board); }, { timeout });
  return ok === true ? true : `${ok} (${last})`;
}

// scribble draws a rectangle on the canvas at a fraction of its size and waits for nothing.
const TOOLBAR = '[data-testid="toolbar-rectangle"]';
async function scribble(page, fx, fy) {
  const b = await page.locator(q.boardCanvas).boundingBox();
  await page.keyboard.press("Escape");
  await page.locator("label", { has: page.locator(TOOLBAR) }).click();
  const x = b.x + b.width * fx, y = b.y + b.height * fy;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 4 });
  await page.mouse.move(x + 120, y + 70, { steps: 4 });
  await page.mouse.up();
}
// drawRect draws a rectangle and waits until a new rectangle is in the board's file; returns its id.
async function drawRect(page, board, fx, fy) {
  const before = new Set(rectangles(board).map((e) => e.id));
  await scribble(page, fx, fy);
  return (await waitFor("the new rectangle is in the board's file", () => rectangles(board).find((e) => !before.has(e.id)) ?? null, { timeout: 10000 })).id;
}

// holdRequests holds back the page's calls that `match` picks (they wait in `held`) until off(), which lets them go and ends the hold.
async function holdRequests(p, match) {
  const held = [];
  let open = false;
  const mine = (u) => { const c = callOf(u.href); return !!c && c.method !== "APP"; };
  const handler = async (route) => {
    const c = callOf(route.request().url());
    if (!open && c && match(c)) await new Promise((go) => held.push(go));
    await route.continue().catch(() => {});
  };
  await p.route(mine, handler);
  return { held, off: async () => { open = true; for (const go of held.splice(0)) go(); await p.unroute(mine, handler).catch(() => {}); } };
}
// delayRequests lets the calls that `match` picks go on only `ms` later.
async function delayRequests(p, match, ms) {
  const mine = (u) => { const c = callOf(u.href); return !!c && c.method !== "APP"; };
  const handler = async (route) => {
    const c = callOf(route.request().url());
    if (c && match(c)) await sleep(ms);
    await route.continue().catch(() => {});
  };
  await p.route(mine, handler);
  return { off: () => p.unroute(mine, handler).catch(() => {}) };
}
const isCall = (r, method, pathname) => { const c = callOf(r.url()); return !!c && c.method === method && c.path.split("?")[0] === pathname; };
const callPath = (c) => c.path.split("?")[0];
/** The calls of a page that change a board or its holder: a write of a scene, a take, a release, a reply to the server's rpc. */
const changing = (c) => (c.method === "PUT" && /^\/api\/boards\/[^/]+\/scene$/.test(callPath(c))) || (c.method === "POST" && /^\/api\/boards\/[^/]+\/(take|release)$/.test(callPath(c))) || (c.method === "POST" && callPath(c) === "/api/rpc-reply");
const countOf = (p, pred) => p.calls.filter(pred).length;
const takesOf = (p) => countOf(p, (c) => c.method === "POST" && /^\/api\/boards\/[^/]+\/take$/.test(callPath(c)));
const savesOf = (p, board) => p.calls.filter((c) => c.method === "PUT" && callPath(c) === `/api/boards/${board}/scene`);
const repliesOf = (p) => countOf(p, (c) => c.method === "POST" && callPath(c) === "/api/rpc-reply");

// ---- the agent

/** The create items of an apply: `n` rectangles named `<prefix><from>`…, in a row, inside the default view of the canvas; with `label`,
 *  each has a text (the engine measures it, which takes its time). */
const rects = (prefix, from, n, label = "") => Array.from({ length: n }, (_, i) => ({ type: "rectangle", key: `${prefix}${from + i}`, x: 60 + ((from + i) % 9) * 120, y: 100 + Math.floor((from + i) / 9) * 90, width: 100, height: 60, ...(label ? { label } : {}) }));
/** A message that makes the stand-in agent apply `per` rectangles with a label in each call, `n` calls, `gap` seconds apart. */
const loopMessage = (prefix, n, per, gap) => Array.from({ length: n }, (_, i) => `[[mcp apply ${JSON.stringify({ create: rects(prefix, i * per, per, `agent ${i}`) })}]]${i < n - 1 ? ` [[sleep ${gap}]]` : ""}`).join(" ");
/** The tool results of a chat so far, by tool name. */
async function toolResults(chat, tool, client = raw) {
  const r = await client.call("GET", `/api/chats/${chat}/items`);
  return (r.json?.items ?? []).filter((i) => i.kind === "tool" && i.name === `mcp__board__${tool}`).map((i) => String(i.result ?? ""));
}
const done = (text) => text.includes('"created"');
/** Waits for the turn of a chat to end: its `end` item. */
const turnOver2 = (client, chat, timeout = 60000) => waitFor("the agent's turn is over", async () => (await client.call("GET", `/api/chats/${chat}/items`)).json?.items?.some((i) => i.kind === "end"), { timeout, every: 200 });
const turnOver = (chat, timeout = 60000) => turnOver2(raw, chat, timeout);
const TAKEN_START = "The board was taken over in a window while this call ran";

// ---- (a) opening, switching, reloading, a cut connection: nobody becomes the writer

async function stepA(p1, p2, p3, B) {
  B.a = await newBoard("board-a");
  B.x = await newBoard("board-x");
  for (const p of [p1, p2, p3]) await show(p, B.a);
  const looks = await Promise.all([p1, p2, p3].map(async (p) => [await barOf(p), await editing(p)]));
  check("opened, the board is a reader's in each page: the bar says \"View only.\" and offers \"Edit here\"",
    looks.every(([b, e]) => b && b.role === "none" && b.writer === "none" && b.text === `${TEXT.nobody} Edit here` && b.button && !e), looks);
  check("each page's bar has the button, and the canvas is in view mode", (await Promise.all([p1, p2, p3].map((p) => p.locator(`${q.boardCanvas} .excalidraw--view-mode`).count()))).every((n) => n > 0));
  check("the server has no writer for the board", (await serverView(p1, B.a)).writer === "", await serverView(p1, B.a));

  // switching: to another board and back, in each page
  for (const p of [p1, p2, p3]) { await show(p, B.x); await show(p, B.a); }
  check("after switching to another board and back no page is the writer", (await Promise.all([p1, p2, p3].map(isReader))).every(Boolean), await roleWords(p1));
  check("the other board, shown and left, was taken by no page either", (await serverView(p2, B.x)).writer === "" && (await serverView(p3, B.a)).writer === "");

  // reloading the page of P3: the app starts again with the board still selected
  const stored = drawn(B.a), rev = await sceneRev(B.a);
  await p3.reload();
  await p3.waitForSelector(ui.treeWait, { timeout: 20000 });
  await ui.stateOfSection(p3, p3.server).filter({ hasText: /^Connected$/ }).waitFor({ timeout: 60000 });
  await show(p3, B.a);
  check("after P3 loaded its page anew, the board it shows is still a reader's", await isReader(p3), await roleWords(p3));

  // the connection of P2 cut and back
  link.set("cut");
  await holds("P2's section of S says S is not connected", async () => (await ui.stateOfSection(p2, p2.server).innerText().catch(() => "Connected")).trim() !== "Connected", { timeout: 30000 });
  link.set("pass");
  await ui.stateOfSection(p2, p2.server).filter({ hasText: /^Connected$/ }).waitFor({ timeout: 60000 });
  await sleep(1000); // (a page that was to take the board by itself would have asked by now)
  check("after P2's connection was cut and came back, P2 still shows a reader's bar", await isReader(p2), await roleWords(p2));
  check("nothing took the board: the server has no writer, the file and its revision are as they were",
    (await serverView(p1, B.a)).writer === "" && unchanged(B.a, stored) && (await sceneRev(B.a)) === rev, { writer: (await serverView(p1, B.a)).writer, rev: [rev, await sceneRev(B.a)] });
  check("no page asked for the board: no take, no release, no write in any page", pages.every((p) => takesOf(p) === 0 && countOf(p, changing) === 0), pages.map((p) => `${nameOf(p)} ${takesOf(p)}/${countOf(p, changing)}`));
}

// ---- (b) a press, and a reader follows

async function stepB(p1, p2, p3, B) {
  await show(p1, B.a);
  await press(p1);
  await becomesWriter(p1);
  check("P1 pressed \"Edit here\": it is the writer, the bar is gone and its mark says Editing", await isWriter(p1), await roleWords(p1));
  const said = await Promise.all([p2, p3].map((p) => sees(p, `${TEXT.window} Edit here`)));
  check("P2 and P3 say another window is editing this board, and keep the button", said.every((s) => s === true), said);
  check("the server says a window writes", (await serverView(p2, B.a)).writer === "window", await serverView(p2, B.a));
  await p2.evaluate(() => { window.__mark = "same page"; });
  await p3.evaluate(() => { window.__mark = "same page"; });
  const watched = [p2, p3].map((p) => p.calls.length);
  const r1 = await drawRect(p1, B.a, 0.3, 0.3);
  const first = await Promise.all([p2, p3].map((p) => showsFile(p, B.a, "P1's first rectangle")));
  check("P1 draws a rectangle: P2 and P3 show it", first.every((x) => x === true) && (await shownBy(p2)).some(([id]) => id === r1) && (await shownBy(p3)).some(([id]) => id === r1), first);
  const r2 = await drawRect(p1, B.a, 0.55, 0.3);
  const second = await Promise.all([p2, p3].map((p) => showsFile(p, B.a, "P1's second rectangle")));
  check("P1 draws another: both readers show it too", second.every((x) => x === true), second);
  check("neither reader loaded its page again", (await Promise.all([p2, p3].map((p) => p.evaluate(() => window.__mark)))).every((m) => m === "same page"));
  check("the readers are still readers and made no change of their own", (await isReader(p2)) && (await isReader(p3)) && [p2, p3].every((p, i) => p.calls.slice(watched[i]).filter(changing).length === 0), await roleWords(p2));
  check("both rectangles are in the file", has(B.a, r1) && has(B.a, r2) && rectangles(B.a).length === 2);
}

// ---- (c) no change from a reader

async function stepC(p1, p2, p3, B) {
  await show(p2, B.a);
  const stored = drawn(B.a), rev = await sceneRev(B.a);
  const shownBefore = (await shownBy(p2)).length;
  const watched = pages.map((p) => p.calls.length);

  // by the pointer and the keys: a tool key and a drag on the canvas
  const box = await p2.locator(q.boardCanvas).boundingBox();
  await p2.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.8);
  await p2.keyboard.press("r");
  await p2.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7);
  await p2.mouse.down();
  await p2.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8, { steps: 5 });
  await p2.mouse.up();
  check("a reader has no drawing tools, and its drag on the canvas draws nothing", (await p2.locator(TOOLBAR).count()) === 0 && (await shownBy(p2)).length === shownBefore && sameAsFile(await shownBy(p2), B.a), { before: shownBefore, after: (await shownBy(p2)).length, file: drawn(B.a).length });

  // a paste: Excalidraw's clipboard format, and plain text
  await p2.evaluate(() => {
    const target = document.querySelector(".excalidraw") ?? document.body;
    const clip = JSON.stringify({ type: "excalidraw/clipboard", elements: [{ type: "rectangle", id: "pasted-by-a-reader", x: 400, y: 400, width: 100, height: 60, version: 1, versionNonce: 1, isDeleted: false, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity: 100, angle: 0, groupIds: [], frameId: null, roundness: null, boundElements: null, updated: 1, link: null, locked: false, seed: 1, index: "a9" }], files: {} });
    for (const data of [clip, "typed by a reader"]) {
      const dt = new DataTransfer();
      dt.setData("text/plain", data);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      (document.activeElement ?? target).dispatchEvent(ev);
      document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }
  });
  await sleep(1500); // (longer than the page's save delay: a page that kept an edit has sent it by now)
  check("a reader's paste is never written: the page sent no write", p2.calls.slice(watched[1]).filter(changing).length === 0, p2.calls.slice(watched[1]).filter(changing).map((c) => `${c.method} ${c.path}`));

  // directly: a write of the scene with the reader's own client id, and a stranger's
  const scene = (await raw.scene(B.a)).scene;
  const grown = { ...scene, elements: [...scene.elements, { ...scene.elements[0], id: "forged-by-a-reader", version: 1, versionNonce: 7 }] };
  const asP2 = await new RawClient(S, host2.client.clientId).call("PUT", `/api/boards/${B.a}/scene?rev=${rev}`, grown);
  check("a PUT of the scene with P2's own client id is refused: 409 not_holder", asP2.status === 409 && asP2.json?.code === "not_holder", { status: asP2.status, body: asP2.json ?? asP2.text });
  const asStranger = await new RawClient(S).call("PUT", `/api/boards/${B.a}/scene?rev=${rev}`, grown);
  check("so is one from a client the server never saw", asStranger.status === 409 && asStranger.json?.code === "not_holder", { status: asStranger.status, body: asStranger.json ?? asStranger.text });
  const asP3 = await new RawClient(S, host3.client.clientId).call("PUT", `/api/boards/${B.a}/scene?rev=${rev}`, grown);
  check("and one from P3, the other reader", asP3.status === 409 && asP3.json?.code === "not_holder", { status: asP3.status, body: asP3.json ?? asP3.text });
  const reply = await new RawClient(S, host2.client.clientId).call("POST", "/api/rpc-reply", { id: "1", result: "forged" });
  check("an answer to a call nobody asked P2 is refused", reply.status >= 400, { status: reply.status, body: reply.json ?? reply.text });
  const asHolder = await new RawClient(S, host1.client.clientId).call("PUT", `/api/boards/${B.a}/scene?rev=${rev - 1}`, grown);
  check("while the writer's own write on an older revision is refused as stale", asHolder.status === 409 && asHolder.json?.code === "stale", { status: asHolder.status, body: asHolder.json ?? asHolder.text });

  // an agent call on the board: answered by the window that writes it, by no reader
  const chat = B.chatA = await raw.newChat(B.a);
  const answered = [repliesOf(p1), repliesOf(p2), repliesOf(p3)];
  await raw.send(chat, `[[mcp apply ${JSON.stringify({ create: rects("c", 0, 1) })}]]`);
  await turnOver(chat);
  const results = await toolResults(chat, "apply");
  check("an agent's apply on the board is answered, by the writer's page", results.length === 1 && done(results[0]) && repliesOf(p1) === answered[0] + 1, { results, replies: [repliesOf(p1), repliesOf(p2), repliesOf(p3)] });
  check("no reader answered it, and the readers show the agent's rectangle",
    repliesOf(p2) === answered[1] && repliesOf(p3) === answered[2] && (await showsFile(p2, B.a, "the agent's rectangle")) === true && (await showsFile(p3, B.a, "the agent's rectangle")) === true, [repliesOf(p2), repliesOf(p3)]);

  const now = await sceneRev(B.a);
  const agentElements = elements(B.a).filter((e) => e.id === "pasted-by-a-reader" || e.id === "forged-by-a-reader");
  check("no reader's change is in the file, and the revision moved only by the agent's one save",
    agentElements.length === 0 && rectangles(B.a).length === stored.length + 1 && now === rev + 1, { rev: [rev, now], elements: elements(B.a).length });
  check("P2 and P3 sent no write at all", [p2, p3].every((p) => p.calls.filter(changing).length === 0), [p2, p3].map((p) => p.calls.filter(changing).length));
}

// ---- (d) a press while the writer has an unsaved change

async function stepD(p1, p2, p3, B) {
  await show(p2, B.a);
  await show(p1, B.a);
  // P1's write is late: the change P1 draws is not in the board yet when P2 presses
  const delay = await delayRequests(p1, (c) => c.method === "PUT" && callPath(c) === `/api/boards/${B.a}/scene`, 1500);
  const sent = [];
  const onResponse = (r) => { if (isCall(r, "PUT", `/api/boards/${B.a}/scene`)) sent.push(`saved ${r.status()}`); };
  const onRequest = (r) => { const c = callOf(r.url()); if (c && c.method === "POST" && callPath(c) === `/api/boards/${B.a}/release`) sent.push("release"); };
  p1.on("response", onResponse);
  p1.on("request", onRequest);
  try {
    const before = new Set(elements(B.a).map((e) => e.id));
    const rev0 = await sceneRev(B.a);
    await scribble(p1, 0.3, 0.6);
    const pendingThen = !elements(B.a).some((e) => !before.has(e.id));
    await press(p2);
    await becomesWriter(p2, "P2 is the writer", 30000);
    const r1 = rectangles(B.a).find((e) => !before.has(e.id));
    check("P2 pressed while P1's change was on its way: P2 is the writer", await isWriter(p2) && pendingThen, `${pendingThen ? "P1's change was not yet in the file when P2 pressed" : "P1's change was already in the file: the late write did not hold"}; ${await roleWords(p2)}`);
    check("P1's change is in the board", !!r1, `${rectangles(B.a).length} rectangles`);
    check("P1's change was written and accepted before P1 let the board go", sent.includes("saved 200") && sent.includes("release") && sent.indexOf("saved 200") < sent.indexOf("release") && !sent.some((x) => x.startsWith("saved 4")), sent);
    const said = await sees(p1, `${TEXT.lost} Edit here`);
    check("P1 says \"Another window took over this board.\" and offers the button", said === true && (await barOf(p1)).role === "lost", await roleWords(p1));
    check("P1 tells of no dropped change: its change was saved", (await droppedNote(p1).count()) === 0);
    check("P3 says another window is editing", (await sees(p3, `${TEXT.window} Edit here`)) === true, await roleWords(p3));
    const rev1 = await sceneRev(B.a);
    check("the revision rose by P1's save", rev1 === rev0 + 1, [rev0, rev1]);
    // P2 started from that revision: its first write is accepted on it, and holds both rectangles
    const base = savesOf(p2, B.a).length;
    const r2 = await drawRect(p2, B.a, 0.6, 0.6);
    const puts = savesOf(p2, B.a).slice(base);
    check("P2's first write is accepted on the revision after P1's save and the file has both rectangles",
      puts.length > 0 && puts.every((c) => c.status === 200) && has(B.a, r1?.id) && has(B.a, r2) && (await sceneRev(B.a)) > rev1, { puts: puts.map((c) => `${c.status}`), rects: rectangles(B.a).length });
    check("P1 and P3 show the file's drawing", (await showsFile(p1, B.a, "the file's drawing")) === true && (await showsFile(p3, B.a, "the file's drawing")) === true);
  } finally { p1.off("response", onResponse); p1.off("request", onRequest); await delay.off(); }
}

// ---- (e) the headless writer yields to a press

async function stepE(p1, p2, p3, B) {
  B.h = await newBoard("board-h");
  for (const p of [p1, p2, p3]) await show(p, B.h);
  const chat = B.chatH = await raw.newChat(B.h);
  const N = 12, PER = 8, GAP = 0.05; // 12 calls of 8 labelled rectangles, one right after the other: a call is on its way when the press comes
  const replies0 = pages.map(repliesOf);
  await raw.send(chat, loopMessage("h", N, PER, GAP));
  const said = await sees(p3, `${TEXT.agent} Edit here`, 60000);
  check("the agent works on the board no window holds: every page says an agent is editing it, and offers the button",
    said === true && (await sees(p1, `${TEXT.agent} Edit here`)) === true && (await sees(p2, `${TEXT.agent} Edit here`)) === true, said === true ? await roleWords(p1) : said);
  check("the server says the headless writer writes it", (await serverView(p3, B.h)).writer === "headless", await serverView(p3, B.h));
  const status = (await S.status()).running?.headless;
  check("the server's status says the headless writer runs and holds a board", status?.running === true && status?.boards >= 1, status);
  await waitFor("the agent has finished some changes", () => rectangles(B.h).length >= PER, { timeout: 60000, every: 50 });
  const live = await holds("P3 shows the agent's first changes", async () => ((await shownBy(p3)) ?? []).length >= PER, { timeout: 20000 });
  const liveIds = new Set(elements(B.h).map((e) => e.id));
  check("P3, a reader, shows the agent's changes as they are made, without a reload: what it holds is what the agent has written",
    live === true && (await shownBy(p3)).every(([id]) => liveIds.has(id)), { shown: (await shownBy(p3))?.length, file: elements(B.h).length });

  const keptAtPress = rectangles(B.h).length / PER;
  const takes = takesOf(p3);
  await press(p3);
  await becomesWriter(p3, "P3 is the writer after the press", 30000);
  check("P3 pressed: it is the writer", await isWriter(p3) && takesOf(p3) === takes + 1, await roleWords(p3));
  await turnOver(chat, 120000);
  const results = await toolResults(chat, "apply");
  const finished = results.filter(done), cut = results.filter((t) => !done(t));
  check("every call of the agent either finished or was cut with the server's words for a board taken over in a window",
    results.length === N && cut.every((t) => t.includes(TAKEN_START)), { calls: results.length, finished: finished.length, cut: cut.map((t) => t.slice(0, 120)) });
  // (a change answered by a window is written after the window's save delay, not before its reply: the file catches up)
  await holds("the file has the rectangles of every finished call", () => rectangles(B.h).length >= finished.length * PER, { timeout: 15000, every: 100 });
  await sleep(700);
  const rectsNow = rectangles(B.h).length;
  check("every change that finished is in the board, and nothing else: the file has the rectangles of each finished call, whole", rectsNow === finished.length * PER && finished.length >= keptAtPress, { file: rectsNow, finished: finished.length, atPress: keptAtPress });
  check("the file is valid and the stored revision is the last save's", fileValid(B.h) && (await sceneRev(B.h)) >= finished.length);
  const mine = pages.map(repliesOf);
  check("the agent's calls after the press went on in the window that writes now: P3 answered them, P1 and P2 none",
    mine[2] - replies0[2] > 0 && mine[2] - replies0[2] <= N - keptAtPress && mine[0] === replies0[0] && mine[1] === replies0[1], { before: replies0, after: mine, atPress: keptAtPress });
  check("P1 and P2 say another window is editing, and show the board as P3 does",
    (await sees(p1, `${TEXT.window} Edit here`)) === true && (await sees(p2, `${TEXT.window} Edit here`)) === true && (await showsFile(p1, B.h, "the board P3 writes")) === true && (await showsFile(p2, B.h, "the board P3 writes")) === true, await roleWords(p1));
  check("the server says a window writes it", (await serverView(p1, B.h)).writer === "window", await serverView(p1, B.h));
  // P3 goes on from the agent's drawing
  const r = await drawRect(p3, B.h, 0.5, 0.8);
  check("P3 draws on the agent's board: its write is accepted and the file has the agent's changes and P3's", has(B.h, r) && rectangles(B.h).length === rectsNow + 1, rectangles(B.h).length);
  // the headless writer let go of what it had and, after its quiet time, stops
  const idle = await holds("the headless writer holds no board and stops", async () => { const h = (await S.status()).running?.headless; return !h?.running || h.boards === 0; }, { timeout: 30000, every: 500 });
  check("the headless writer, yielded, holds no board and stops after the quiet time", idle === true, (await S.status()).running?.headless);
  const byWindow = mine[2] - replies0[2];
  console.log(`# (e) the press came after ${keptAtPress} of ${N} calls: the headless writer answered ${finished.length - byWindow} (the one on its way too, when it was), P3 ${byWindow}, ${cut.length} were cut by the press`);
}

// ---- (e2) a call that is on its way when the press comes is cut, in the server's words

// A second server whose headless writer holds every `apply` before its save (AIWB_HEADLESS_TEST=hold-before-save, the writer's test
// knob: it prints `HOLD apply` and waits): a call that is certain to be on its way when the press comes. The press is a take of an app
// whose page shows no board; the board is the agent's, and no window ever shows it.
class Holding extends Server {
  get env() { return { ...super.env, AIWB_HEADLESS_TEST: "hold-before-save" }; }
}
async function stepE2() {
  S2 = new Holding({ out: OUT, bin: S.bin, agent: S.agent, tag: "s2", name: "S2" });
  await S2.setUp();
  await S2.launch();
  const raw2 = new RawClient(S2);
  const host4 = await hostFor({ out: OUT, name: "p4" });
  let page4 = null;
  try {
    const entry = await addServer(host4, S2);
    // (a host connects to a server for the page that shows it: the page is open and shows no board)
    page4 = await openHostPage(browser, host4, { viewport: { width: 1400, height: 900 }, timeout: 8000, wait: ui.treeWait });
    await ui.stateOfSection(page4, entry).filter({ hasText: /^Connected$/ }).waitFor({ timeout: 90000 });
    const board = await raw2.newBoard("board-held");
    const chat = await raw2.newChat(board.id);
    await raw2.send(chat, `[[mcp apply ${JSON.stringify({ create: rects("t", 0, 1, "on its way") })}]]`);
    await waitFor("the headless writer has the call and holds it before its save (HOLD apply in the log)", () => fs.readFileSync(S2.log, "utf8").includes("HOLD apply"), { timeout: 60000, every: 100 });
    const rev0 = (await raw2.scene(board.id)).rev;
    const t0 = Date.now();
    const asked = await hostCall(host4, entry, "POST", `/api/boards/${board.id}/take`, {});
    check("the press on the board the headless writer works on is answered: wait for the hand-off", asked.status === 200 && asked.json?.state === "waiting", asked);
    await turnOver2(raw2, chat);
    const took = Date.now() - t0;
    const results = await toolResults(chat, "apply", raw2);
    check("the call that was on its way is cut, with the server's words for a board taken over in a window, at the headless writer's hand-off time",
      results.length === 1 && results[0].includes(TAKEN_START) && took >= HANDOVER * 0.5, { ms: took, result: results[0]?.slice(0, 160) });
    const view = (await hostCall(host4, entry, "POST", `/api/boards/${board.id}/follow`)).json;
    check("the board went to the window that pressed", view?.writer === "window", view);
    const file = (() => { try { return JSON.parse(fs.readFileSync(path.join(S2.home, "boards", board.id, "drawing.excalidraw"), "utf8")); } catch { return null; } })();
    const made = (file?.elements ?? []).filter((e) => !e.isDeleted).length;
    const rev = (await raw2.scene(board.id)).rev;
    // (the knob stops the call between its change and its save: the change is in progress, neither finished nor failed cleanly, so the
    //  hand-over does not write it, and the revision is the one before it)
    check("the board is valid and holds nothing of the cut call (no element, the revision the one before it)",
      !!file && made === 0 && rev === rev0, { rev: [rev0, rev], elements: made });
  } finally { await page4?.ctx.close().catch(() => {}); await host4.close().catch(() => {}); }
}

// ---- (f) a holder whose write is held up loses the board at the hand-off time

async function stepF(p1, p2, p3, B) {
  // P2 holds A (from (d)); P3 comes back to A, a reader
  await show(p3, B.a);
  await show(p2, B.a);
  if (!(await isWriter(p2))) { await press(p2); await becomesWriter(p2); }
  const stored = drawn(B.a);
  const hold = await holdRequests(p2, (c) => c.method === "PUT" && callPath(c) === `/api/boards/${B.a}/scene`);
  try {
    await scribble(p2, 0.35, 0.35); // pending: its write waits in the hold
    await waitFor("P2's write is on its way", () => hold.held.length > 0, { timeout: 8000, every: 50 });
    const t0 = Date.now();
    await press(p3);
    const taking = await holds("P3 says it is taking over", async () => (await barOf(p3))?.role === "taking", { timeout: 2500 });
    check("while the holder is asked, P3 says it is taking over", taking === true, await roleWords(p3));
    await becomesWriter(p3, "P3 is the writer without the holder's answer", 30000);
    const took = Date.now() - t0;
    check(`P3 became the writer only at the hand-off time (${HANDOVER} ms), with P2's write still on its way`, took >= HANDOVER * 0.8 && hold.held.length > 0, { ms: took, held: hold.held.length });
    const said = await seesStart(p2, `${TEXT.lost} Edit here`);
    check("P2 says another window took over this board and says its change was dropped", said === true && (await droppedNote(p2).count()) === 1 && (await droppedNote(p2).innerText()).trim() === DROPPED, await roleWords(p2));
    check("the file is as before: P2's rectangle was not written", unchanged(B.a, stored), { before: stored.length, after: drawn(B.a).length });
    const qd = await drawRect(p3, B.a, 0.45, 0.45);
    const afterQ = drawn(B.a), rev = await sceneRev(B.a);
    // the write arrives late
    const late = p2.waitForResponse((r) => isCall(r, "PUT", `/api/boards/${B.a}/scene`), { timeout: 15000 });
    await hold.off();
    const res = await late;
    const body = await res.json().catch(() => ({}));
    check("the held write, released, is refused: another window holds the board", res.status() === 409 && body.code === "not_holder", { status: res.status(), body });
    await sleep(500);
    check("the file lacks P2's rectangle and the revision is unchanged by the late write", unchanged(B.a, afterQ) && (await sceneRev(B.a)) === rev && has(B.a, qd), { revision: [rev, await sceneRev(B.a)], elements: [afterQ.length, drawn(B.a).length] });
    check("P2 is a reader and made no new take", (await isReader(p2)) && (await serverView(p2, B.a)).writer === "window", await roleWords(p2));
  } finally { await hold.off(); }
}

// ---- (g) two presses together

async function stepG(p1, p2, p3, B) {
  for (const p of [p1, p2, p3]) await show(p, B.a);
  if (!(await isWriter(p3))) { await press(p3); await becomesWriter(p3); }
  const stored = drawn(B.a);
  await Promise.all([press(p1), press(p2)]);
  const settled = await holds("one page is the writer and the other two are readers", async () => {
    const w = await Promise.all([p1, p2, p3].map(isWriter));
    const r = await Promise.all([p1, p2, p3].map(isReader));
    return w.filter(Boolean).length === 1 && r.filter(Boolean).length === 2;
  }, { timeout: 30000 });
  const roles = await Promise.all(pages.map(roleWords));
  check("two pages pressed together: one ends as the writer, the other two as readers", settled === true, roles);
  const writer = (await Promise.all([p1, p2, p3].map(async (p) => ((await isWriter(p)) ? p : null)))).find(Boolean);
  const readers = [p1, p2, p3].filter((p) => p !== writer);
  check("no page stays \"taking\"", (await Promise.all([p1, p2, p3].map(async (p) => (await barOf(p))?.role))).every((r) => r !== "taking"), roles);
  check("the readers say another window is editing, and the server agrees", (await Promise.all(readers.map(async (p) => (await barOf(p))?.writer))).every((w) => w === "window") && (await serverView(readers[0], B.a)).writer === "window", roles);
  check("the board file is valid and nothing was lost or changed by the hand-offs", fileValid(B.a) && unchanged(B.a, stored), { before: stored.length, after: drawn(B.a).length });
  let shown = [];
  const r = await drawRect(writer, B.a, 0.6, 0.2);
  check(`the writer (${nameOf(writer)}) draws: its write is accepted and both readers show it`,
    has(B.a, r) && (shown = await Promise.all(readers.map((p) => showsFile(p, B.a, "the writer's rectangle")))).every((x) => x === true) && fileValid(B.a), shown);
}

// ---- (h) the whole run

async function stepH(p1, p2, p3) {
  const takes = pages.map((p) => `${nameOf(p)} ${takesOf(p)}/${p.presses}`);
  check("every take a page made was a press of the script: pages took no board by themselves", pages.every((p) => takesOf(p) === p.presses), takes);
  check("no page threw an uncaught exception", pages.every((p) => p.errors.filter((e) => e.startsWith("uncaught")).length === 0), pages.flatMap((p) => p.errors).filter((e) => e.startsWith("uncaught")).slice(0, 5).join(" ; "));
}

// ---- main

let code = 0;
onSignal(async () => { await browser?.close().catch(() => {}); await host1?.close().catch(() => {}); await host2?.close().catch(() => {}); await host3?.close().catch(() => {}); await link?.close(); if (S) await S.stop(); if (S2) await S2.stop(); });
try {
  await prepare();
  console.log(`# server on https://127.0.0.1:${S.port}, files in ${OUT}`);
  browser = await (await loadChromium()).launch({ headless: true });
  const p1 = await openPage(1, host1), p2 = await openPage(2, host2), p3 = await openPage(3, host3);
  const B = {}; // the boards: a (the main one), x (another), h (the agent's)
  await step("(a) opening, switching, reloading, a cut connection: nobody becomes the writer", () => stepA(p1, p2, p3, B));
  if (!B.a) throw new Error("the board was not made: nothing else can be checked");
  await step("(b) a press makes the writer, and the readers follow it", () => stepB(p1, p2, p3, B));
  await step("(c) a reader changes nothing, by any route", () => stepC(p1, p2, p3, B));
  await step("(d) a press while the writer has a change not yet written", () => stepD(p1, p2, p3, B));
  await step("(e) the headless writer yields to a press", () => stepE(p1, p2, p3, B));
  await step("(e2) a call on its way when the press comes is cut", () => stepE2());
  await step("(f) a holder that does not release loses the board at the hand-off time", () => stepF(p1, p2, p3, B));
  await step("(g) two pages press together", () => stepG(p1, p2, p3, B));
  await step("(h) the whole run", () => stepH(p1, p2, p3));
  code = failed ? 1 : 0;
} catch (e) {
  console.log(`FAIL - the script could not go on: ${e.stack || e}`);
  code = 2;
} finally {
  if (browser) await browser.close().catch(() => {});
  await host1?.close().catch(() => {});
  await host2?.close().catch(() => {});
  await host3?.close().catch(() => {});
  await link?.close();
}
const servers = [S, S2].filter(Boolean);
for (const s of servers) if (s.info?.pid && !s.pids.includes(s.info.pid)) s.pids.push(s.info.pid);
if (S && !check("the scratch folder is still whole", fs.existsSync(S.log) && fs.existsSync(path.join(S.home, "boards")), OUT) && !code) code = 1;
const end = servers.length ? await finish(servers) : { alive: [], free: true };
if (S && !check("the servers are stopped and their ports are free", end.free && end.alive.length === 0, `ports ${servers.map((s) => s.port).join(", ")}; processes left: ${end.alive.join(", ") || "none"}`) && !code) code = 1;
if (code === 0 && process.env.AIWB_E2E_KEEP !== "1") fs.rmSync(OUT, { recursive: true, force: true });
else console.log(`# files kept in ${OUT}`);
console.log(`# ${passed} checks passed, ${failed} failed, ${known} known failures`);
console.log(code === 0 ? "# passed" : code === 2 ? "# could not run to the end" : `# failed (${failed} checks)`);
process.exit(code);
