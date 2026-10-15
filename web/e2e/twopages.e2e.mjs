// Two real pages on one server (plans/multiple-remote-servers.md, phase 7: AC39, AC42, AC38), each in an app of its own.
//
// Each board is held by one page at a time and only its holder writes it; a stored drawing and a
// chat's draft have a revision, which a write names; a page of another origin reaches nothing. The Go
// tests show that with stand-in clients, and web/e2e/app.e2e.mjs (steps 9a to 9e) with real pages but
// beside real paid agents. This script shows it with two real pages in a headless Chrome (Playwright)
// and with no agent at all: no chat is ever sent a message.
//
// There is one server, S. Each page is served by a test host (web/dev/host.mjs) of its own, with a state folder
// of its own: another app, with another client id, as on two machines.
//   P1  the app on S's machine: S is its first section, "This computer", which its host finds or starts with the
//       server program (--local-bin).
//   P2  the app on another machine: S is an entry of its server list, a section "S", reached over a link the script
//       owns (a TCP relay, so that the script can pull the network while S goes on).
//
// It spends no money: the server is started with no Claude, no Cursor and no pi. It never touches
// the installed app: the script builds its own binary into a temp folder, sets a server up there, runs it on a temp
// data folder and on free ports (the MCP listener too), and stops it at the end. Not part of `npm test`.
//
//   cd web && npm install --no-save playwright && npx playwright install chromium
//   node web/e2e/twopages.e2e.mjs
//
//   (a) P1 makes board A, P2 makes board B, each draws: both drawings are saved, no take-over.
//   (b) P1 draws on A and P2 opens A at once: P1's edit is written before the board is let go; P1
//       shows the panel on A only and draws on a third board; "Use here" shows the stored drawing.
//   (c) T11 X1: a page that lost a board takes it back; its older drawing is not written.
//   (d) T11 X3 (b): the holder's write is held up; the taker waits the hand-over delay, the late
//       write is refused.
//   (e) T11 X5: the holder's connection to S is cut, another page works on the board, the connection returns.
//   (f) a page load takes only a free board.
//   (g) T11 X4: one chat in both pages; a draft save on an older draft is refused.
//   (h) a page of another origin posts to a host: refused, and nothing is made or taken.
//
// It prints one line per check and exits with 1 when a check failed (2 when it could not run). A
// check named in KNOWN_FAIL that fails is printed as KNOWN-FAIL and does not fail the script: it
// is a fault of the product that is reported, not one of the script.
//
// Environment (all optional):
//   AIWB_E2E_BIN       server binary                    (default: built into the temp folder)
//   DIST               the app's web build to serve (AIWB_E2E_CLIENT too): `cd app && npm run build:web`, then `DIST=app/dist-web`;
//                      without DIST the script builds its own into the temp folder. The host serves the page over plain HTTP and
//                      the page calls it from its own address, so the page's CSP needs `connect-src 'self'`
//                      (app/scripts/export-web.mjs `--connect-self`): an export that has it is used as it is, the shipped one
//                      (`connect-src 'none'`) is copied into the temp folder with that one change, and DIST itself is not touched
//   AIWB_E2E_KEEP=1    keep the temp folder (server log, screenshots) after a run that passed;
//                      after a failed run it is always kept, and its path is printed
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  Link, Scratch, callOf, finish, hostApp, hostCall, hostFor, loadChromium, makeOut, onSignal, openPage as openHostPage, parseAppWaits, serverBinary, sleep, waitFor, holds,
} from "./lib/rig.mjs";
import * as ui from "./lib/ui.mjs";

const { q } = ui;

// Everything the run makes: the binary, the data folder, the work folder, the log, screenshots.
const OUT = makeOut("twopages");

// ---- checks: one line each

// Checks that fail because of a fault of the product, by name, each with the fault in a few words.
const KNOWN_FAIL = new Map([]);

let failed = 0, known = 0, passed = 0;
function check(name, pass, detail = "") {
  const isKnown = !pass && KNOWN_FAIL.has(name);
  if (pass) passed++; else if (isKnown) known++; else failed++;
  const d = (typeof detail === "string" ? detail : JSON.stringify(detail) ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
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

// ---- the scratch server and the two apps

let S = null;      // the one server
let host1 = null;  // P1's app: S is this computer
let host2 = null;  // P2's app: S is an entry of its list, behind the link
let link = null;
let ENTRY = "";    // S's id in P2's list
const own = (key) => String(key ?? "").split("~").pop(); // a thing's own id, of the page's key of it

async function prepare() {
  const bin = serverBinary(OUT);
  // (no agent exists for this server)
  S = new Scratch({ out: OUT, bin, agent: null, tag: "s", name: "S" });
  await S.setUp();
  host1 = await hostFor({ out: OUT, name: "p1", local: S });
  await S.launch(); // (found, not started again, by the host that runs the same command)
  link = await new Link(S.port).open();
  // P2's backoff is short, so that its return after a cut is seen in seconds
  host2 = await hostFor({ out: OUT, name: "p2", extra: { dial: link.dial, timing: parseAppWaits("backoff=2s") } });
  const added = await hostApp(host2, "servers.add", { force: true, form: { name: "S", address: `https://127.0.0.1:${S.port}`, secret: S.secret, selfSigned: true, pin: S.fingerprint } });
  if (added.status !== 200 || !added.json?.saved) throw new Error(`P2's host could not add S: ${JSON.stringify(added)}`);
  ENTRY = added.json.server.id;
}

const state = async () => (await hostCall(host1, "local", "GET", "/api/state")).json;

// ---- the pages

let browser = null;
const pages = [];
// openPage opens the page of a host in a browser context of its own and keeps the page's uncaught exceptions.
async function openPage(host, local) {
  const page = await openHostPage(browser, host, { viewport: { width: 1400, height: 900 }, timeout: 8000, wait: q.rootVisible });
  page.local = local;
  // The take-over panel may come and go between two looks, so the page itself remembers it.
  await page.addInitScript((panel) => {
    window.__takeoverSeen = 0;
    const look = () => { if (document.querySelector(panel)) window.__takeoverSeen++; };
    new MutationObserver(look).observe(document, { childList: true, subtree: true });
  }, q.takeover);
  await page.reload();
  await page.waitForSelector(ui.treeWait, { timeout: 20000 });
  // S's section fills when the host's connection to S has read its snapshot.
  await ui.stateOfSection(page, local ? "local" : ENTRY).filter({ hasText: /^Connected$/ }).waitFor({ timeout: 90000 });
  pages.push(page);
  return page;
}
const shot = (page, label) => page.screenshot({ path: path.join(OUT, `${label}.png`) }).catch(() => {});
const sel = ui.selection;
const menuItem = (page, text) => page.locator(q.menuItem, { hasText: text });
const takeover = async (page) => ({ now: await page.locator(q.takeover).count(), seen: await page.evaluate(() => window.__takeoverSeen) });
/** What S's section of a page says of the connection. */
const sectionState = (page) => ui.stateOfSection(page, page.local ? "local" : ENTRY).innerText().then((t) => t.trim(), () => "");

// The shapes toolbar is drawn only for the page that holds the board: any other page has the panel in the canvas's place.
const TOOLBAR = '[data-testid="toolbar-rectangle"]';
const DROPPED = "A change made here was not saved in time and was dropped.";
const SAVE_WAIT = 1200; // longer than the page's save delay: a page that had something to write has sent it by then
const panel = (p) => p.locator(q.takeover);
// (the heading says "Open in another window" for a board of this computer, and "In use elsewhere" for one of another machine)
const panelHead = (p) => panel(p).getByRole("heading", { name: /^(Open in another window|In use elsewhere)$/ });
const useHere = (p) => ui.button(panel(p), "Use here");
const canvasText = (p) => p.locator(q.boardCanvas).innerText().then((t) => t.slice(0, 200), () => "(no board on screen)");
const holdsBoard = async (p) => await p.locator(TOOLBAR).isVisible() && (await panel(p).count()) === 0;
/** Whether the page has the board (by its own id) on screen. */
const onScreen = async (p, board) => own((await sel(p)).board) === board;

// elements: the live elements in the board's file on disk; rectangles: the rectangles among them.
function elements(board) {
  try {
    const scene = JSON.parse(fs.readFileSync(path.join(S.home, "boards", board, "drawing.excalidraw"), "utf8"));
    return (scene.elements ?? []).filter((e) => !e.isDeleted);
  } catch { return []; }
}
const rectangles = (board) => elements(board).filter((e) => e.type === "rectangle");
const has = (board, id) => elements(board).some((e) => e.id === id);
// drawn: what a stored drawing holds, each element with its version. unchanged: the drawing is
// still what `was` held: no element is gone or back at an older version, and none was added. A
// page that wrote an older drawing over a newer one, or an edit that was to be dropped, shows as
// one of these.
const drawn = (board) => elements(board).map((e) => [e.id, e.version]);
const unchanged = (board, was) => { const now = new Map(drawn(board)); return now.size === was.length && was.every(([id, v]) => (now.get(id) ?? -1) >= v); };
// sceneRev: the revision the server stores a board's drawing at, read through the client API.
const sceneRev = async (board) => (await hostCall(host1, "local", "GET", `/api/boards/${board}/scene`)).rev;

// newBoard makes a board through the page's menu (the sidebar's "+" on S's own page, S's section's "+" on the other) and
// gives it a name of its own in the box the sidebar opens for it (unnamed, every new board is "whiteboard").
const names = new Map(); // board id -> its name in the sidebar
async function newBoard(page, name) {
  const before = new Set((await state()).boards.map((b) => b.id));
  if (page.local) {
    await ui.click(page, page.locator(q.newBtn));
    await ui.click(page, menuItem(page, /^\s*New whiteboard\s*$/));
  } else {
    await ui.plus(page, ui.sectionById(page, ENTRY).locator(q.sectionHead), "Whiteboard");
  }
  const id = await waitFor("the page selects its new board", async () => { const b = own((await sel(page)).board); return b && !before.has(b) ? b : null; });
  await page.locator(q.boardCanvas).waitFor();
  await page.locator(TOOLBAR).waitFor({ state: "attached", timeout: 20000 });
  const box = page.locator(`${q.boardRow} ${q.nameInput}`);
  await box.waitFor();
  await box.fill(name);
  await box.press("Enter");
  names.set(id, name);
  await waitFor(`every page's sidebar shows "${name}"`, async () => (await Promise.all(pages.map((p) => boardRow(p, id).count()))).every((n) => n === 1));
  return id;
}
const boardRow = (page, board) => ui.rowOf(page, "board", names.get(board));
// scribble draws a rectangle on the canvas at a fraction of its size and waits for nothing.
// Not near the left edge or the top: the editor's own panels are there.
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
// drawable waits until the board is on screen in the page and the page's to draw on.
const drawable = (p, board, what, timeout = 20000) => waitFor(what, async () => (await onScreen(p, board)) && await holdsBoard(p), { timeout });
// holdOn makes the page the holder of a board, with the board on screen: a click on its row asks
// for it, and "Use here" where the panel shows.
async function holdOn(p, board) {
  if (!(await onScreen(p, board))) await ui.openRow(p, boardRow(p, board));
  await waitFor(`board ${board} is on screen and the page's to draw on`, async () => {
    if ((await onScreen(p, board)) && await holdsBoard(p)) return true;
    if (await useHere(p).isVisible()) await useHere(p).click().catch(() => {});
    return false;
  }, { timeout: 20000, every: 200 });
}
// stage is the start of a hand-off: `holder` draws on the board, and `other` has it on screen behind the panel.
async function stage(holder, other, board) {
  const staged = async () => (await onScreen(other, board)) && await panelHead(other).isVisible() && (await onScreen(holder, board)) && await holdsBoard(holder);
  if (await staged()) return;
  await holdOn(other, board);
  await holdOn(holder, board);
  await panelHead(other).waitFor({ timeout: 15000 });
}
// holdRequests holds back the page's calls that `match` picks (they wait in `held`) until off(), which lets them go and
// ends the hold; letOne() lets the oldest go and holds the next. match gets { server, method, path } of the call.
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
  return { held, letOne: () => held.shift()?.(), off: async () => { open = true; for (const go of held.splice(0)) go(); await p.unroute(mine, handler).catch(() => {}); } };
}
/** The call a response answers, when it is a PUT of a board's scene / a draft, and so on: the call's own method, not the page's POST to the host. */
const isCall = (r, method, pathname) => { const c = callOf(r.url()); return !!c && c.method === method && c.path.split("?")[0] === pathname; };
// cutOff cuts a page off, as when its connection dies: the link between its app and S is cut, so S sees its stream end
// and frees what it held, and the page's section of S says that S is not connected. The app then tries again until the
// link is back.
async function cutOff(p) {
  link.set("cut");
  const said = await holds("the page's section of S says that S is not connected", async () => (await sectionState(p)) !== "Connected", { timeout: 30000 });
  check("the page that is cut off shows its section of S as not connected", said === true, await sectionState(p));
}

// ---- (a) two boards at once

async function stepA(p1, p2, B) {
  check("each page's app states a client id of its own", /^[0-9a-f-]{36}$/.test(host1.client.clientId) && /^[0-9a-f-]{36}$/.test(host2.client.clientId) && host1.client.clientId !== host2.client.clientId, `${host1.client.clientId} and ${host2.client.clientId}`);
  B.a = await newBoard(p1, "board-a");
  B.b = await newBoard(p2, "board-b");
  const rev0 = { a: await sceneRev(B.a), b: await sceneRev(B.b) };
  const [ra, rb] = await Promise.all([drawRect(p1, B.a, 0.3, 0.3), drawRect(p2, B.b, 0.3, 0.3)]);
  check("P1's rectangle is in board A's file and P2's in board B's, each in its own only",
    has(B.a, ra) && has(B.b, rb) && !has(B.a, rb) && !has(B.b, ra) && rectangles(B.a).length === 1 && rectangles(B.b).length === 1,
    `A: ${rectangles(B.a).length} rectangles, B: ${rectangles(B.b).length}`);
  const rev1 = { a: await sceneRev(B.a), b: await sceneRev(B.b) };
  check("the stored revision of each board rose", rev1.a > rev0.a && rev1.b > rev0.b, { before: rev0, after: rev1 });
  await sleep(500);
  const t1 = await takeover(p1), t2 = await takeover(p2);
  check("neither page shows or showed the take-over panel", t1.now === 0 && t1.seen === 0 && t2.now === 0 && t2.seen === 0, { p1: t1, p2: t2 });
  check("both pages can go on drawing", await holdsBoard(p1) && await holdsBoard(p2));
}

// ---- (b) a take of a held board

async function stepB(p1, p2, B) {
  await holdOn(p1, B.a);
  await holdOn(p2, B.b);
  // What P1 sends about A, in order: the board is let go only after the edit is written.
  const scenePath = `/api/boards/${B.a}/scene`;
  const sent = [];
  const onResponse = (r) => { if (isCall(r, "PUT", scenePath)) sent.push(`saved ${r.status()}`); };
  const onRequest = (q) => { const c = callOf(q.url()); if (c && c.method === "POST" && c.path.split("?")[0] === `/api/boards/${B.a}/release`) sent.push("release"); };
  p1.on("response", onResponse);
  p1.on("request", onRequest);
  try {
    const before = new Set(elements(B.a).map((e) => e.id));
    await scribble(p1, 0.5, 0.6);
    const savedAlready = elements(B.a).some((e) => !before.has(e.id));
    await ui.openRow(p2, boardRow(p2, B.a)); // a click on a board asks for it
    await panelHead(p1).waitFor({ timeout: 15000 }).catch(() => {});
    const r1 = rectangles(B.a).find((e) => !before.has(e.id));
    check("P1, which held A, shows the take-over panel, and its rectangle is in the file by then",
      await panelHead(p1).isVisible() && !!r1, `${savedAlready ? "the rectangle was saved before P2 asked" : "the rectangle was not yet saved when P2 asked"}; P1: ${await canvasText(p1)}`);
    await drawable(p2, B.a, "P2 has A and can draw on it");
    check("P1's rectangle is in the file when P2's toolbar shows", !!r1 && has(B.a, r1.id), `${rectangles(B.a).length} rectangles`);
    const saves = sent.filter((x) => x.startsWith("saved"));
    check("P1's edit was written and accepted before P1 let the board go",
      saves.length > 0 && saves.every((x) => x === "saved 200") && sent.includes("release") && sent.lastIndexOf("saved 200") < sent.indexOf("release"), sent);
    check("P1's panel tells of no dropped change", (await panel(p1).locator(q.takeoverDropped).count()) === 0, await canvasText(p1));

    // P2 draws on the stored drawing: what it saves next holds P1's edit too.
    const r2 = await drawRect(p2, B.a, 0.65, 0.3);
    check("after P2 drew on A the file has the rectangles of both pages", has(B.a, r1?.id) && has(B.a, r2), `${rectangles(B.a).length} rectangles`);

    // "Use here" takes the board back: the canvas shows the stored drawing, not the one P1 kept.
    const stored = drawn(B.a);
    await ui.click(p1, useHere(p1));
    await drawable(p1, B.a, 'after "Use here" P1 draws on A');
    await panelHead(p2).waitFor({ timeout: 15000 }).catch(() => {});
    check("P2 shows the panel in its turn", await panelHead(p2).isVisible(), await canvasText(p2));
    await sleep(SAVE_WAIT);
    check("taking the board back wrote no older drawing over the stored one", unchanged(B.a, stored), { before: stored, after: drawn(B.a) });
    // A save writes the whole canvas: after one more rectangle the file holds what P1's canvas holds.
    const r3 = await drawRect(p1, B.a, 0.3, 0.75);
    const now = rectangles(B.a).map((e) => e.id);
    check('"Use here" showed the stored drawing: P1\'s canvas, saved with one more rectangle, is the file\'s rectangles and that one',
      now.length === stored.length + 1 && [r1?.id, r2, r3].every((id) => now.includes(id)), `the file had ${stored.length} elements, P1's canvas wrote ${now.length} rectangles`);

    // The panel is for A only. P2 takes A again; P1, with the panel on A, makes a third board and
    // draws on it. (A click on A's row would ask for A, as "Use here" does: P1 does not go back.)
    await ui.click(p2, useHere(p2));
    await drawable(p2, B.a, "P2 has A again");
    await panelHead(p1).waitFor({ timeout: 15000 }).catch(() => {});
    check("P1 shows the panel on A again", await panelHead(p1).isVisible(), await canvasText(p1));
    B.c = await newBoard(p1, "board-c");
    const rc = await drawRect(p1, B.c, 0.3, 0.3);
    await sleep(300);
    check("P1 draws on a third board, which shows no panel", has(B.c, rc) && rectangles(B.c).length === 1 && await holdsBoard(p1) && (await onScreen(p1, B.c)), await canvasText(p1));
    check("P1's work on the third board took nothing from P2, which still draws on A", await holdsBoard(p2) && (await onScreen(p2, B.a)) && unchanged(B.a, drawn(B.a)) && rectangles(B.a).length === now.length, await canvasText(p2));
  } finally { p1.off("response", onResponse); p1.off("request", onRequest); }
}

// ---- (c) T11 X1: a page that lost a board takes it back

async function stepC(p1, p2, B) {
  await stage(p2, p1, B.a);
  await holdOn(p1, B.a); // P2 keeps the drawing as it was, behind the panel
  await panelHead(p2).waitFor({ timeout: 15000 }).catch(() => {});
  check("P2 lost A and shows the panel", await panelHead(p2).isVisible(), await canvasText(p2));
  const x = await drawRect(p1, B.a, 0.5, 0.15);
  const stored = drawn(B.a), rev = await sceneRev(B.a);
  await ui.click(p2, useHere(p2));
  await drawable(p2, B.a, "P2 has A back");
  await sleep(SAVE_WAIT);
  check("the drawing P2 kept was not written: the file is the newer one, with x", unchanged(B.a, stored) && has(B.a, x) && (await sceneRev(B.a)) === rev, { before: stored.length, after: drawn(B.a).length });
  check("nothing was dropped: P2's canvas shows no note", (await p2.locator(q.canvasNote).count()) === 0, await canvasText(p2));
  const y = await drawRect(p2, B.a, 0.8, 0.6);
  check("P2 drew y on the newer drawing: the file has x and y", has(B.a, x) && has(B.a, y) && rectangles(B.a).length === stored.length + 1 && (await sceneRev(B.a)) > rev, `${rectangles(B.a).length} rectangles, revision ${rev} -> ${await sceneRev(B.a)}`);
}

// ---- (d) T11 X3 (b): the holder's write is held up for longer than the hand-over delay (10 s for a client of the API)

async function stepD(p1, p2, B) {
  await stage(p2, p1, B.a);
  let stored = drawn(B.a);
  const scenePath = `/api/boards/${B.a}/scene`;
  const hold = await holdRequests(p2, (c) => c.method === "PUT" && c.path.split("?")[0] === scenePath);
  try {
    await scribble(p2, 0.35, 0.5); // pending: its write will wait in the hold
    const t0 = Date.now();
    await ui.click(p1, useHere(p1));
    const taking = panel(p1).getByText("Taking over from the other window…");
    await taking.waitFor({ timeout: 2500 }).catch(() => {});
    check("while the holder is asked, P1 says it is taking over", await taking.isVisible(), await canvasText(p1));
    await drawable(p1, B.a, "P1 gets A without the holder's answer", 30000);
    const took = Date.now() - t0;
    check("P1 can draw only after the silent holder's wait (2500 ms at least), with P2's write still on its way", took >= 2500 && hold.held.length > 0, { ms: took, held: hold.held.length });
    await panelHead(p2).waitFor({ timeout: 15000 }).catch(() => {});
    const line = panel(p2).locator(q.takeoverDropped);
    check("P2 shows the panel, which says its change was dropped", await panelHead(p2).isVisible() && (await line.count()) === 1 && (await line.innerText()).trim() === DROPPED, await canvasText(p2));
    check("the file is as before: P2's rectangle was not written", unchanged(B.a, stored), { before: stored.length, after: drawn(B.a).length });
    const qd = await drawRect(p1, B.a, 0.45, 0.4);
    stored = drawn(B.a);
    const rev = await sceneRev(B.a);
    // The write arrives late.
    const late = p2.waitForResponse((r) => isCall(r, "PUT", scenePath), { timeout: 15000 });
    await hold.off();
    const res = await late;
    const body = await res.json().catch(() => ({}));
    check("the held write, released, is refused: another window holds the board", res.status() === 409 && body.code === "not_holder", { status: res.status(), body });
    await sleep(300);
    check("the file lacks P2's rectangle and the revision is unchanged by the late write", unchanged(B.a, stored) && (await sceneRev(B.a)) === rev && has(B.a, qd), { revision: [rev, await sceneRev(B.a)], elements: [stored.length, drawn(B.a).length] });
    // P2 takes the board back, and nothing else is done.
    await ui.click(p2, useHere(p2));
    await drawable(p2, B.a, 'after "Use here" P2 draws on A again');
    await sleep(SAVE_WAIT);
    check("taking the board back put nothing of the dropped edit into the file", unchanged(B.a, stored) && (await sceneRev(B.a)) === rev, { revision: [rev, await sceneRev(B.a)] });
  } finally { await hold.off(); }
}

// ---- (e) T11 X5: the holder's connection is cut, another page works on the board, the connection returns

async function stepE(p1, p2, B) {
  await stage(p2, p1, B.a);
  try {
    const before = drawn(B.a);
    await cutOff(p2);
    await scribble(p2, 0.45, 0.8); // an edit made while cut off: its write fails
    await sleep(SAVE_WAIT);
    check("P2's edit made while cut off is not in the file", unchanged(B.a, before), { before: before.length, after: drawn(B.a).length });
    await ui.click(p1, useHere(p1));
    await drawable(p1, B.a, "P1 takes A, which the server freed when P2's stream ended");
    const w = await drawRect(p1, B.a, 0.8, 0.15);
    const stored = drawn(B.a), rev = await sceneRev(B.a);
    link.set("pass");
    const back = await waitFor("back on the server, P2 shows the panel for A", async () =>
      await panelHead(p2).isVisible() && (await sectionState(p2)) === "Connected", { timeout: 45000 }).catch(() => false);
    check("P2 comes back and shows the panel", back === true, await canvasText(p2));
    check("P2's panel says its change was dropped", (await panel(p2).locator(q.takeoverDropped).count()) === 1, await canvasText(p2));
    await sleep(SAVE_WAIT);
    check("P2 took nothing back: P1 still draws on A", await holdsBoard(p1) && (await onScreen(p1, B.a)), await canvasText(p1));
    check("the file has w and not P2's edit, at the revision P1 wrote", unchanged(B.a, stored) && (await sceneRev(B.a)) === rev && has(B.a, w), { revision: [rev, await sceneRev(B.a)], elements: [stored.length, drawn(B.a).length] });
  } finally { link.set("pass"); }
}

// ---- (f) a page load takes only a free board

async function stepF(p1, p2, B) {
  await stage(p1, p2, B.a);
  const stored = drawn(B.a), rev = await sceneRev(B.a);
  const id = host2.client.clientId;
  await p2.reload();
  await p2.waitForSelector("#root *:visible", { timeout: 15000 });
  await panelHead(p2).waitFor({ timeout: 15000 }).catch(() => {});
  check("after its reload P2 has A on screen behind the panel", (await onScreen(p2, B.a)) && await panelHead(p2).isVisible(), await canvasText(p2));
  await sleep(SAVE_WAIT);
  check("P1 shows no panel and still draws on A", await holdsBoard(p1) && (await onScreen(p1, B.a)), await canvasText(p1));
  check("the file and its revision are unchanged", unchanged(B.a, stored) && (await sceneRev(B.a)) === rev, { revision: [rev, await sceneRev(B.a)] });
  check("the reloaded page is still the same app: its client id is the one it had", host2.client.clientId === id && id !== host1.client.clientId, `${id} -> ${host2.client.clientId}`);
  const r = await drawRect(p1, B.a, 0.55, 0.45);
  check("P1's next write is accepted", has(B.a, r) && (await sceneRev(B.a)) > rev);
}

// ---- (g) T11 X4: a draft changed in another page is not overwritten

async function stepG(p1, p2) {
  // A chat with no agent's turn: P1 makes it, P2 opens it from the sidebar.
  const beforeChats = new Set((await state()).chats.map((c) => c.id));
  await ui.click(p1, p1.locator(q.newBtn));
  await ui.click(p1, menuItem(p1, /^\s*New chat\s*$/));
  const chat = await waitFor("P1 selects its new chat", async () => { const c = own((await sel(p1)).chat); return c && !beforeChats.has(c) ? c : null; });
  const row = p2.locator(q.chatRow);
  await waitFor("P2's sidebar has one chat", async () => (await row.count()) === 1);
  await ui.openRow(p2, row);
  await waitFor("P2 selects the chat", async () => own((await sel(p2)).chat) === chat);
  const ta = ui.box(p1), tb = ui.box(p2);
  await ta.waitFor();
  await tb.waitFor();

  const chatJSON = path.join(S.home, "chats", chat, "chat.json");
  const stored = () => { try { const m = JSON.parse(fs.readFileSync(chatJSON, "utf8")); return { text: m.drafts?.main?.text ?? "", rev: m.draftRevs?.main ?? 0 }; } catch { return { text: "", rev: -1 }; } };
  const saved = (text, what) => waitFor(what, () => { const s = stored(); return s.text === text ? s : null; }, { timeout: 10000 });
  const text = async (t) => (await t.innerText()).trim();
  const shows = (t, want) => waitFor(`the composer shows "${want}"`, async () => (await text(t)) === want, { timeout: 10000 }).then(() => true, () => false);
  const draftPath = `/api/chats/${chat}/draft`;
  const isDraftPut = (r) => isCall(r, "PUT", draftPath);

  await ta.fill("one");
  const d1 = await saved("one", 'P1\'s draft "one" is stored');
  check('P1 types "one" and P2\'s composer shows it', await shows(tb, "one"), await text(tb));
  await tb.fill("two");
  const d2 = await saved("two", 'P2\'s draft "two" is stored');
  check('P2 types "two" and P1\'s composer shows it', await shows(ta, "two"), await text(ta));
  check("the draft's counter rose", d2.rev > d1.rev, { before: d1, after: d2 });

  // A save that reaches the server after the other page's, with nothing typed since.
  let hold = await holdRequests(p1, (c) => c.method === "PUT" && c.path.split("?")[0] === draftPath);
  const puts = []; // P1's saves, as answered: the counter each named and the status
  const onResponse = (r) => { if (isDraftPut(r)) puts.push({ base: Number(new URL(callOf(r.url()).path, "http://x").searchParams.get("rev")), status: r.status() }); };
  try {
    await ta.fill("late text of P1");
    await waitFor("P1's save is on its way", () => hold.held.length === 1, { timeout: 5000, every: 50 });
    await tb.fill("newer text of P2");
    const d4 = await saved("newer text of P2", "P2's draft is stored meanwhile");
    check("P1 keeps its own text while its save is on its way", (await text(ta)) === "late text of P1", await text(ta));
    // The held save is let go, and what P1 sends next is held in its turn.
    const late = p1.waitForResponse(isDraftPut, { timeout: 15000 });
    hold.letOne();
    const res = await late;
    const body = await res.json().catch(() => ({}));
    check("P1's held save, released, is refused as stale and answered with the stored draft and its counter", res.status() === 409 && body.code === "stale" && body.rev === d4.rev && body.draft?.text === d4.text, { status: res.status(), body });
    await sleep(600); // longer than the composer's save delay
    check("the stored draft is P2's and P1's composer keeps P1's own text", stored().text === d4.text && stored().rev === d4.rev && (await text(ta)) === "late text of P1", { stored: stored(), p1: await text(ta) });
    // The page's rule (packages/core/src/logic/drafts.ts, DraftSaver): a refused save keeps its text, which was
    // typed after the draft it was based on, and saves it again on the counter the refusal gave.
    await waitFor("P1 saves its kept text again", () => hold.held.length === 1, { timeout: 5000, every: 50 }).catch(() => {});
    const again = p1.waitForResponse(isDraftPut, { timeout: 15000 });
    const resaves = hold.held.length;
    await hold.off();
    const res2 = resaves ? await again : (again.catch(() => {}), null);
    const base2 = res2 ? Number(new URL(callOf(res2.url()).path, "http://x").searchParams.get("rev")) : null;
    const d4b = await saved("late text of P1", "P1's kept text is stored").catch(() => stored());
    check("P1 then saves its kept text on the counter the refusal gave, and it is accepted: the last save wins", res2?.status() === 200 && base2 === d4.rev && d4b.text === "late text of P1" && d4b.rev === d4.rev + 1, { status: res2?.status(), base: base2, stored: d4b });
    check("P2, where nothing was typed since, shows that draft", await shows(tb, "late text of P1"), await text(tb));

    // The same with P1 typing on while its save is on its way: what was typed stays.
    hold = await holdRequests(p1, (c) => c.method === "PUT" && c.path.split("?")[0] === draftPath);
    p1.on("response", onResponse);
    await ta.fill("P1 types on");
    await waitFor("P1's save is on its way", () => hold.held.length === 1, { timeout: 5000, every: 50 });
    await tb.fill("P2 again");
    const d5 = await saved("P2 again", "P2's draft is stored meanwhile");
    await ta.fill("P1 types on and on");
    await sleep(600); // longer than the composer's save delay: the next save waits for the one on its way
    check("with P1's save still held, the stored draft is P2's and P1's composer keeps P1's own text", stored().text === "P2 again" && (await text(ta)) === "P1 types on and on", { stored: stored(), p1: await text(ta) });
    await hold.off();
    const d6 = await saved("P1 types on and on", "what P1 typed since is stored");
    check("after the refusal P1's composer still has what was typed since", (await text(ta)) === "P1 types on and on", await text(ta));
    await waitFor("both saves of P1 are answered", () => puts.length >= 2, { timeout: 5000 }).catch(() => {});
    check("the save on the older draft was refused, and the next one named the stored draft's counter",
      puts.length === 2 && puts[0].status === 409 && puts[1].status === 200 && puts[1].base === d5.rev && d6.rev === d5.rev + 1, { puts, stored: [d5, d6] });
    check("P2, where nothing was typed since, shows it", await shows(tb, d6.text), await text(tb));
  } finally { p1.off("response", onResponse); await hold.off(); }
}

// ---- (h) a page of another origin

async function stepH(p1, p2, B) {
  await holdOn(p1, B.a);
  const rev = await sceneRev(B.a);
  const boardsBefore = (await state()).boards.length;
  const dir = path.join(OUT, "other-origin");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>another origin</title>");
  const other = http.createServer((q, s) => { s.writeHead(200, { "Content-Type": "text/html" }); s.end(fs.readFileSync(path.join(dir, "index.html"))); });
  await new Promise((ok, no) => { other.once("error", no); other.listen(0, "127.0.0.1", ok); });
  const origin = `http://127.0.0.1:${other.address().port}`;
  const ctx = await browser.newContext();
  try {
    const foreign = await ctx.newPage();
    const base = host1.url.replace(/\/$/, "");
    const answers = [];
    foreign.on("response", (r) => { const u = new URL(r.url()); if (u.origin === base && u.pathname.startsWith("/host/")) answers.push(`${r.request().method()} ${callOf(r.url())?.path ?? u.pathname} ${r.status()}`); });
    await foreign.goto(origin + "/");
    // The host holds the secrets of its app and passes the page's calls on: a page of another origin is not its page.
    // Without a custom header a POST needs no preflight; with one the browser asks first, and the host allows no other origin.
    const calls = [`/host/call?server=local&method=POST&path=${encodeURIComponent("/api/boards")}`, `/host/call?server=local&method=POST&path=${encodeURIComponent(`/api/boards/${B.a}/take`)}`, "/host/app/servers.list", "/host/events"];
    const did = await foreign.evaluate(async ({ base, calls }) => {
      const plain = [];
      for (const p of calls) {
        plain.push(await fetch(base + p, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ name: "forged", new: true }) })
          .then((r) => r.type, (e) => `failed: ${e.message}`));
      }
      const withHeader = [];
      for (const p of calls) {
        withHeader.push(await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", "X-AIWB-Client": "forged" }, body: JSON.stringify({ name: "forged", new: true }) })
          .then((r) => `answered ${r.status}`, () => "rejected"));
      }
      // the stream, which the page of the host reads with EventSource
      const stream = await new Promise((done) => { const es = new EventSource(base + "/host/events"); es.onmessage = () => { es.close(); done("read"); }; es.onerror = () => { es.close(); done("refused"); }; setTimeout(() => { es.close(); done("silent"); }, 3000); });
      return { plain, withHeader, stream };
    }, { base, calls });
    const refused = await waitFor("every post without the header is answered", () => calls.slice(0, 3).every((p) => answers.some((a) => a.startsWith("POST "))), { timeout: 5000 }).catch(() => false);
    check("the host answers the other origin's posts without the client header 403 and does what they ask for nowhere", refused === true && answers.filter((a) => a.startsWith("POST")).every((a) => a.endsWith(" 403")), answers);
    check("the other origin's page reads nothing of those answers", did.plain.every((t) => t === "opaque"), did.plain);
    check("with a custom header its fetches are rejected by the browser: the host allows no other origin", did.withHeader.every((t) => t === "rejected"), did.withHeader);
    check("the other origin's page reads none of the stream of events", did.stream !== "read", did.stream);
    await sleep(500);
    check("no board was made", (await state()).boards.length === boardsBefore, `${boardsBefore} -> ${(await state()).boards.length}`);
    check("A's holder is unchanged: P1 shows no panel and still draws on it", await holdsBoard(p1) && (await onScreen(p1, B.a)), await canvasText(p1));
    const r = await drawRect(p1, B.a, 0.4, 0.3);
    check("P1's next write is accepted: nothing was taken or written meanwhile", has(B.a, r) && (await sceneRev(B.a)) === rev + 1, { before: rev, after: await sceneRev(B.a) });
  } finally {
    await ctx.close().catch(() => {});
    await new Promise((done) => other.close(done));
  }
}

// ---- main

let code = 0;
onSignal(async () => { await browser?.close().catch(() => {}); await host1?.close().catch(() => {}); await host2?.close().catch(() => {}); await link?.close(); if (S) await S.stop(); });
try {
  await prepare();
  console.log(`# server on https://127.0.0.1:${S.port}, P1's app on ${host1.url}, P2's on ${host2.url}, files in ${OUT}`);
  browser = await (await loadChromium()).launch({ headless: true });
  const p1 = await openPage(host1, true);
  const p2 = await openPage(host2, false);
  const B = {}; // the boards: a (P1's), b (P2's), c (P1's third)
  await step("(a) two pages work on two boards at once", () => stepA(p1, p2, B));
  if (!B.a || !B.b) throw new Error("the two boards were not made: nothing else can be checked");
  await step("(b) a page takes a board another page holds", () => stepB(p1, p2, B));
  await step("(c) X1: a page that lost a board takes it back", () => stepC(p1, p2, B));
  await step("(d) X3 b: a holder that cannot write its pending edit in time", () => stepD(p1, p2, B));
  await step("(e) X5: a page whose connection is cut, with another page at work when it returns", () => stepE(p1, p2, B));
  await step("(f) a page load takes only a free board", () => stepF(p1, p2, B));
  await step("(g) X4: a draft changed in another page is not overwritten", () => stepG(p1, p2));
  await step("(h) a page of another origin gets nothing", () => stepH(p1, p2, B));
  // A refused write and a cut connection are in the pages' consoles by design: only exceptions are checked.
  check("no page threw an uncaught exception", p1.errors.filter((e) => e.startsWith("uncaught")).length === 0 && p2.errors.filter((e) => e.startsWith("uncaught")).length === 0, [...p1.errors, ...p2.errors].filter((e) => e.startsWith("uncaught")).slice(0, 5).join(" ; "));
  code = failed ? 1 : 0;
} catch (e) {
  console.log(`FAIL - the script could not go on: ${e.stack || e}`);
  code = 2;
} finally {
  if (browser) await browser.close().catch(() => {});
  await host1?.close().catch(() => {});
  await host2?.close().catch(() => {});
  await link?.close();
}
const pid = S?.info?.pid;
if (pid && !S.pids.includes(pid)) S.pids.push(pid);
// Another process that clears the temp folder while this runs takes the boards' files with it.
if (S && !check("the scratch folder is still whole", fs.existsSync(S.log) && fs.existsSync(path.join(S.home, "boards")), OUT) && !code) code = 1;
const end = S ? await finish([S]) : { alive: [], free: true };
if (S && !check("the server is stopped and its port is free", end.free && end.alive.length === 0, `port ${S.port}; processes left: ${end.alive.join(", ") || "none"}`) && !code) code = 1;
if (code === 0 && process.env.AIWB_E2E_KEEP !== "1") fs.rmSync(OUT, { recursive: true, force: true });
else console.log(`# files kept in ${OUT}`);
console.log(`# ${passed} checks passed, ${failed} failed, ${known} known failures`);
console.log(code === 0 ? "# passed" : code === 2 ? "# could not run to the end" : `# failed (${failed} checks)`);
process.exit(code);
