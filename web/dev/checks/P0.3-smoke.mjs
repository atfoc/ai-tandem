// Ports P0.3 (dev/checks/P0.3-smoke.mjs) to the new build: the mock's seeded states (dev/mock-ui.js, `seedUI()`: 102 of them in sections
// A1…A6, SEC, UXS2, UXH1, UXH2, UXT1, UXT2, UXC1, UXB2, UXT3 and UXC2) each show on screen where the table DRAWN below says, with no page error, at each viewport the entry names (all three by
// default). All 102 are in the table (the five of UXH2 are the phone's row actions, Archived and search: h2 chunk 7 added their rows; UXH2.archived and UXH2.search get to their screen by `phoneRun`, the gear and the Archived row, Home's search field; UXH2.away drops Studio Mac once Home has drawn, and the faded list is what it reads. The ten of UXH1 are the phone's Home: H1 chunk 4 added their rows, ux-h1-10 fixed two: UXH1.trouble drops its server once Home has drawn the list, UXH1.nested reads the board row of the group screen, not Home's under it, and `pre` and `ls` to what a state may carry: the seed's, as its header says). An entry is the new build's counterpart of the seed's `see`, its `text`, its `count` and each part of its
// `also`, and not less: a part the seed names is a part of the entry (the sweep, rn-sw-p03, wrote the ones that had stayed short, see the list of
// them below).
//   - the key of an entry is "<section>.<id>" of the seed's list ("A2.plain-started"); a key that is not in the list (a state
//     renamed or removed in dev/mock-ui.js) fails the check, and so does a state of the seed with no entry, so a table cannot go stale;
//   - `see` is a list of parts, each { tid, data?, text?, exact?, count?, last?, label?, state?, in? } or { css } (the testID and its dataSet
//     values; a part of the first match's text, or all of it with `exact`, or the last match's with `last`; how many match; a part of its aria-label;
//     "attached" for a part that is in the tree but may be hidden; `in`: the elements it is looked for in, outermost first, each { tid, data? };
//     `css`: a selector, for what the page does not draw itself, Excalidraw's own toolbar). The seed's own `see` selectors are what the old
//     build shows: they are not read.
//   - `run(page, { fail })` is a part that needs more than a locator (A3.tree reads the sidebar's outline);
//   - the state's `sel` (the page's aiwb.sel), its `mock` (code run in the mock once the page is open, undone before the next) and
//     its `act` (sel.mjs: act) are the seed's, as the old check used them; `pane` is a window and widths for a measured state, taken
//     on the desktop only (the other viewports are the devices' own);
//   - `phoneSee` / `phoneRun(page, { fail })` are where the phone differs because it has no sidebar (package H1, ux-h1-10; plans/ux-improvements/h1-design.md §2–§6, §8):
//     on the phone they stand in for `see` and `run` (`phoneRun` first, as the step that gets to the screen, then the parts of `phoneSee`); the wide entries are as they were.
//     A1.servers (the Servers button's dot, in the sheet of Home's gear: §6), A1.stream-down (this computer's Home connecting: placeholders and the state word),
//     A1.local-not-started and A1.local-too-old (the problem card: the reason and Try again; the older server and Restart server: §4.3), A1.local-other-build (a server
//     that works has no card: §4.3; the Servers row behind the gear says "another build" and offers Restart server), A3.tree (the group screens pushed one by one, with the
//     chats in the groups the seed names; the tooltips of the sidebar's rows are the wide layouts' and are not read) and SEC.sidebar (each server's chip and, on its Home, the state
//     the seed gives it: the list, the empty Home, placeholders, the card's words for Attic server, Old Mini and Cert box; "Last night's failures" two group screens down).
//   - T1 (the chat on the phone) added two optional fields for the states whose chat looks otherwise on the phone: `phoneSee` is the list of parts read
//     INSTEAD of `see` at the phone (the header there has no server pill `chat-head-server` and no `fk-tree-btn`: the sub-line `chat-head-sub` says "Claude Code
//     · folder", the state word or "Archived · folder", and the Tree is `chat-tree` with its count; goal 3.5), and `phoneAct(page)` is played INSTEAD of the
//     seed's `act` at the phone (the message's actions are not floating there: a touch hold on the reply opens the sheet `msg-sheet`, whose rows carry the
//     fork's button ids; the tree popup is opened by `chat-tree`). The desktop and the tablet read what they read before;
//   - `phone` says where the phone differs: a board and its chat are two screens of the stack there and the chat is on screen (AD-71), so
//     "board" is read on the board's screen (the stack's back first), and "board-then-chat" plays the `act` on the board's screen and goes
//     on to the chat by the Chats button and its sheet's row (the phone's board is a reader's: Edit here first for a select).
//   - `phoneSee` is the `see` at the phone viewport where the phone's composer (ux-improvements C1) draws the state otherwise: a started chat has no chip
//     row (its settings are in Chat info), so there its fixed model chip is not drawn and the composer's box is; a new chat whose server dropped has no
//     choice to hang the reason line on, and the remote bar and the empty thread's reason say it;
// What the old check does and this one does otherwise:
//   - the old one seeded each section alone and drew its states, then all together. This one draws all of them together at each viewport and
//     each section alone at the desktop (a section's states stand on what the section seeds, nothing of another);
//   - a state is open for a count of frames, not for a time (MOMENT of the old one, a second): an error thrown after the load is seen.
//     `atRest` (24 frames with nothing changed) was the wait here before and never came for a page that animates (the typing dots, the
//     presence of an agent, a spinner): it waited out its bound, 1200 frames (20 s), and its answer was not read. The states are open one
//     at a time, as the old check's: the mock has one stream for one page (`open()` of shot.mjs fails a second), and two pages would take
//     it from each other;
//   - the old one failed when the build's version was not "uicheck" (the state of another build needs a page that differs): so does this.
// A package that draws a state adds its entry in the same commit as its screen, and says in its first comment which entries it
// added (S3: A1.servers; S9: the ring of A2.plain-ctxerr, plain-remote-new, plain-remote-started, plain-remote-started-long and plain-off-started, the
// `also` of those states in the seed that names `.ctx-meter`; K5: the count of A2.plain-quotes and A2.board-quotes, the seed's `.composer .qcount`).
// rn-sw-p03 (the sweep) made the entries whole: the text of A2.plain-new-long, plain-started-long, board-long ("extended thinking"), of the
// server in the header of A2.plain-remote-* and of "is not connected" in A2.plain-off-new and plain-off-started; the model's chip of A4.fork-*;
// the five labels of A5.gaps; the groups of A3.tree and the eight sections of SEC.sidebar; A1.servers' words; the toolbar of A6.board and
// SEC.board (the canvas was only in the tree), at the tablet and, by the stack's back, at the phone; A2.board-selected at the tablet and the phone (there it reads that the selection reached no chat: B2's selection rule, boardSelectedPhone).
// S2 (the Servers screens of the phone) added UXS2.list, detail, unreachable, too-old, cert and compare: phone only (`viewports`), each pushes its
// screen by the stack's seam (sel.mjs: acts "srv-list", "srv-detail:<id>", "srv-cert:<id>") and sees the screen's testIDs (app/src/screens/servers/ids.ts).
// R1 (the rules check and the final sweep): the table was read against every section of `SECTIONS` in dev/mock-ui.js and holds the rows of the packages that
// added states since the lines above: S2 (UXS2, 6 rows), H1 (UXH1, 10), H2 (UXH2, 5), T1 (UXT1, 2), T2 (UXT2, 4), T3 (UXT3, 4), C1 (UXC1, 7), C2 (UXC2, 5) and
// B2 (UXB2, 2); they are phone-only (`viewports`) where the wide layouts keep the old screen. The board states A2.board-selected, A6.board and SEC.board, once
// B1's View-only wait, pass at the phone, the tablet and the desktop now (B1/X1: `editHere`).
import { check, dropped, mockEval, paneSize, seed, until } from "../shot.mjs";
import { act, back, byTid, longPress, openFoot, press, showHome, tidSel } from "./sel.mjs";
import { MORE } from "./composer.mjs";
import { homeOf, sideSeen } from "./side.mjs";
import { openServersScreen, ownerOf } from "./srv.mjs";
import { atRest, settingsText } from "./settings.mjs";

// Alone on a free machine one run of the three viewports takes about 840 s (phone 408, tablet 154, desktop 280: 113 states, the board and
// the drawer ones with their waits); twice that for a loaded machine. (The runner's 600 s was the cause of "it had not ended after 600 s".)
export const limit = 1700;

export const viewports = ["desktop", "tablet", "phone"];

const SECTION = (server) => ({ tid: "side-section", data: { server } });
/** T1: the phone's counterparts of the wide layouts' header and message actions (the entries' `phoneSee` and `phoneAct`). The header's sub-line says what the
 *  server pill said at the wide layouts, where the chat lives; a remote chat shows agent · folder there, and its server is in Chat info (T3), not asserted here. */
const SUB = (text) => ({ tid: "chat-head-sub", text });
const SHEET_ROW = (action) => ({ in: [{ tid: "msg-sheet" }], tid: "action-row", data: { action } });
/** A touch hold on the first line of the first reply (not the middle of a block, which may be a link or a table): the message sheet opens. The thread is a
 *  virtual list that measures its rows as they appear, so a hold that comes before the rows have settled can land beside the words: the hold is made again. */
async function holdReply(page) {
  const reply = byTid(page, "msg", { role: "assistant" }).first();
  const sheet = byTid(page, "msg-sheet").first();
  await reply.waitFor({ state: "visible", timeout: 15000 });
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForTimeout(500);
    await reply.scrollIntoViewIfNeeded();
    const at = await reply.locator('[data-testid="md-p"]').first().evaluate((e) => {
      const r = [...e.getClientRects()].find((q) => q.width > 8 && q.height > 8) ?? e.getBoundingClientRect();
      return { x: r.x + Math.min(r.width / 2, 60), y: r.y + Math.min(r.height / 2, 10) };
    });
    await longPress(page, at);
    if (await sheet.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) return;
  }
  throw new Error("a touch hold on the first reply did not open the message sheet (msg-sheet)");
}
/** The header's Tree pressed and the popup's rows waited for (fork.mjs openTree presses the wide header's button). */
async function pressTree(page) {
  await press(page, byTid(page, "chat-tree").first());
  await byTid(page, "fk-row").first().waitFor({ state: "visible", timeout: 15000 });
}
const TOOLBAR = ".excalidraw:not(.excalidraw--view-mode) .App-toolbar"; // (Excalidraw's own, as the old check had it)

/** A3.tree: the five chats of the seed are in the groups it names (the seed's `also`): a chat is a row of the group it is in, and its row says
 *  so in its title; a group's title is the path of its names. The outline is the sidebar's (side.mjs). */
async function treeShape(page, { fail }) {
  const seen = await sideSeen(page, "local");
  if (!seen.there) return fail("A3.tree: this computer's section is not drawn");
  const stack = [];
  const at = new Map(); // name of a chat -> { path, title }
  seen.outline.forEach((line, i) => {
    const depth = (line.length - line.trimStart().length) / 2, [kind, ...rest] = line.trim().split(" "), name = rest.join(" ");
    stack.length = depth;
    if (kind === "group") { stack[depth] = name; if (seen.titles[i] !== stack.join(" / ")) fail(`A3.tree: the group ${name} has the title "${seen.titles[i]}", not "${stack.join(" / ")}"`); }
    else if (kind === "chat" && !at.has(name)) at.set(name, { path: stack.slice(), title: seen.titles[i] });
  });
  for (const [name, path] of [["Chat A", ["Shop"]], ["Chat B", ["Shop", "Sub"]], ["Chat O", ["Other"]], ["Chat M", ["Other", "Mid"]], ["Loose", []]]) {
    const c = at.get(name);
    if (!c) fail(`A3.tree: no row for "${name}"`);
    else if (c.path.join(" / ") !== path.join(" / ")) fail(`A3.tree: "${name}" is in ${c.path.length ? c.path.join(" / ") : "no group"}, not ${path.length ? path.join(" / ") : "no group"}`);
    else if (!c.title.startsWith(`${name} —`)) fail(`A3.tree: the row of "${name}" has the title "${c.title}", not "${name} —…"`);
  }
}


// ---- the phone's counterparts (package H1: the phone has no sidebar, Home and its group screens are its list; plans/ux-improvements/h1-design.md §2–§6, §8)
const WAIT = 15000;
const J = JSON.stringify;

/** The phone's Home, showing the server `server` (an entry id), once it has drawn something of that server (rows, or its state's body). */
async function homeOn(page, server) {
  await showHome(page, server);
  await page.waitForSelector(tidSel("home", { server }), { timeout: WAIT });
}

/** Presses the row of the group `name` on the screen `scope` (Home when null, else a group's key) and waits for that group's screen; answers its key. */
async function intoGroup(page, scope, name, fail, key) {
  const here = await homeOf(page, scope);
  const row = here.rows.find((r) => r.kind === "group" && r.name === name);
  if (!row) { fail(`${key}: ${scope ? "the screen of " + scope : "Home"} has no row of the group "${name}" (it lists ${J(here.outline)})`); return null; }
  const r = byTid(page, "home-row", { kind: "group", key: row.key });
  await r.last().scrollIntoViewIfNeeded();
  await press(page, r.last());
  await page.waitForSelector(tidSel("group-screen", { key: row.key }), { timeout: WAIT });
  return row.key;
}

/** A1.servers on the phone: the Servers button's dot has no counterpart there; the foot is behind the gear, in Settings, whose Servers row says in its sub-line
 *  which server is not connected (or how many need attention), in the warn (amber) colour. */
async function serversRowPhone(page, { fail }) {
  await showHome(page);
  await press(page, byTid(page, "home-gear").first());
  await atRest(page, "settings-screen");
  let said = {};
  const got = await until(async () => { said = await settingsText(page); return /not connected|need attention/.test(said.servers?.sub ?? ""); }, 10000);
  if (!got) return fail(`A1.servers: Settings' Servers row says ${JSON.stringify(said.servers)}, not a line that names a server not connected ("<name> not connected", or "n need attention" for several)`);
  const colour = said.servers.subColour, [r, g, b] = (colour?.match(/\d+/g) ?? []).map(Number);
  const other = Object.entries(said).find(([row, v]) => row !== "servers" && v.subColour && v.sub)?.[1].subColour;
  if (!(r > b + 60 && r >= g) || colour === other) fail(`A1.servers: Settings' Servers line "${said.servers.sub}" is ${colour}, not the warn colour (the other lines are ${other})`);
}

/** A2.board-selected on the phone (B2, the selection rule): three shapes are selected on the board, and the phone puts them in no chat by itself and does not
 *  offer to: the chat (reached by the Chats button and its sheet's row) has no "+ Add 3 selected" and no chip for them in its context row or its box, and the
 *  "+" sheet's `selection` row ("Add selection") is the one place that knows: its note counts "3 shapes selected on the board". So the phone cannot see "3 selected"
 *  as the wide layouts do (their `see`); it sees the board under the chat, ready, and that the selection reached nowhere. */
async function boardSelectedPhone(page, { fail }) {
  await page.waitForTimeout(500);
  if (await byTid(page, "ctx-act", { kind: "selection" }).count()) fail("A2.board-selected: the phone's chat offers \"+ Add 3 selected\": the selection goes to no chat by itself");
  if (await byTid(page, "ctx-chip", { kind: "selection" }).count() || await byTid(page, "composer-input").locator(tidSel("ref-chip")).count()) fail("A2.board-selected: the selection is in the phone's chat (a chip) without being added");
  await press(page, byTid(page, "composer-plus").first());
  const row = byTid(page, "action-row", { action: "selection" }).first();
  if (!await until(() => row.count(), 10000)) return fail("A2.board-selected: the phone's \"+\" sheet has no selection row");
  const said = (await row.innerText()).replace(/\s+/g, " ").trim();
  if (!/^Add selection\b/.test(said) || !/3 shapes selected on the board/.test(said)) fail(`A2.board-selected: the phone's selection row reads "${said}", not "Add selection" with "3 shapes selected on the board"`);
  await page.keyboard.press("Escape");
}

/** A1.local-other-build on the phone: this computer's server works, so Home has no problem card (§4.3); its restart is the Servers row's, behind the gear (§6). */
async function otherBuildPhone(page, { fail }) {
  await homeOn(page, "local");
  if (!await until(async () => (await homeOf(page)).state === "list", 10000)) fail(`A1.local-other-build: of another build, Home shows ${J((await homeOf(page)).state)}, not its list`);
  if (await byTid(page, "problem-card").count()) fail("A1.local-other-build: Home draws a problem card for a server that works");
  // (S2's screens: the list's row of this computer (`srv-row`, dataSet server "local") and its detail, whose owner's things offer Restart server; the screens do not say "another build": the server works, so the word is Connected)
  await openServersScreen(page);
  const row = byTid(page, "srv-row", { server: "local" }).first();
  await row.waitFor({ state: "visible", timeout: WAIT });
  await press(page, row);
  const own = ownerOf(page);
  await own.facts.waitFor({ state: "visible", timeout: WAIT });
  if (!await until(async () => (await own.buttons()).includes("Restart server"), 8000)) fail(`A1.local-other-build: this computer's detail offers ${J(await own.buttons())}, no Restart server`);
  if (await own.word() !== "connected") fail(`A1.local-other-build: this computer's detail says "${await own.word()}": its server works, so connected`);
}

/** A3.tree on the phone: the five chats of the seed are in the groups it names. Home lists this computer's top level (the groups Shop and Other, the
 *  loose chat), each group is a pushed screen with its subgroups and chats (§3); a row has no tooltip on the phone (the sidebar's titles are the wide
 *  layouts'), so the path is proven by the screens one has to push to reach the chat, and by the group screen's place line, which ends in the group's name. */
async function treeShapePhone(page, { fail }) {
  await homeOn(page, "local");
  const names = async (scope, kind) => (await homeOf(page, scope)).rows.filter((r) => r.kind === kind).map((r) => r.name);
  const has = async (scope, kind, name, where) => { if (!(await names(scope, kind)).includes(name)) fail(`A3.tree: ${where} has no ${kind} "${name}" (it lists ${J(await names(scope, kind))})`); };
  await has(null, "chat", "Loose", "Home (no group)");
  // (each group is reached from Home again, from the bottom of the stack, by the rows pressed one after the other)
  const path = async (names) => { await showHome(page, "local"); let scope = null; for (const n of names) { scope = await intoGroup(page, scope, n, fail, "A3.tree"); if (!scope) return null; } return scope; };
  const shop = await path(["Shop"]);
  if (shop) await has(shop, "chat", "Chat A", "the group Shop");
  const sub = await path(["Shop", "Sub"]);
  if (sub) await has(sub, "chat", "Chat B", "the group Shop / Sub");
  const o = await path(["Other"]);
  if (o) await has(o, "chat", "Chat O", "the group Other");
  const mid = await path(["Other", "Mid"]);
  if (mid) await has(mid, "chat", "Chat M", "the group Other / Mid");
  const leaf = await path(["Other", "Mid", "Leaf"]); // (three deep: the sidebar's group of depth 2)
  if (leaf) { const h = await homeOf(page, leaf); if (h.title !== "Leaf") fail(`A3.tree: the screen of Other / Mid / Leaf has the title "${h.title}", not "Leaf"`); if (!/Other › Mid/.test(h.place)) fail(`A3.tree: the screen of Leaf says "${h.place}" under its title, not a place through Other › Mid`); }
}

/** SEC.sidebar on the phone: each server of the seed is a chip, and on its Home is in the state the seed gives it (the card's words for s_away, s_old and
 *  s_cert, the empty Home for s_empty, placeholders for s_wait); s_studio's "Last night's failures" is two group screens down (Renders > Nightly). */
async function serversPhone(page, { fail }) {
  const k = "SEC.sidebar";
  const chip = (s) => byTid(page, "server-chip", { server: s }).first();
  const on = async (server, want, what) => {
    await homeOn(page, server);
    const ok = async () => { const h = await homeOf(page); return h.server === server && Object.entries(want).every(([f, v]) => J(h[f]) === J(v)); };
    if (!await until(ok, 10000)) { const h = await homeOf(page); fail(`${k}: ${what}: Home shows ${J(Object.fromEntries(Object.keys(want).map((f) => [f, h[f]])))}, not ${J(want)}`); }
    return homeOf(page);
  };
  const cardSays = async (text) => { const c = byTid(page, "problem-card").first(); await c.waitFor({ state: "visible", timeout: 10000 }).catch(() => {}); return until(async () => ((await c.textContent().catch(() => "")) ?? "").includes(text), 5000); };
  for (const s of ["s_studio", "s_empty", "s_wait", "s_away", "s_old", "s_cert"]) if (!await chip(s).count()) fail(`${k}: Home has no chip of the server ${s}`);
  await on("s_studio", { state: "list", word: "connected" }, "Studio Mac (Connected)");
  // "Last night's failures" in the groups Renders > Nightly (the seed's `also`: two groups down)
  const renders = await intoGroup(page, null, "Renders", fail, k), nightly = renders ? await intoGroup(page, renders, "Nightly", fail, k) : null;
  if (nightly) { const night = (await homeOf(page, nightly)).rows.find((r) => r.kind === "chat" && r.key === "s_studio~c_night"); if (night?.name !== "Last night's failures") fail(`${k}: the screen of Renders > Nightly has no chat row s_studio~c_night "Last night's failures" (it lists ${J((await homeOf(page, nightly)).rows.map((r) => [r.key, r.name]))})`); }
  const e = await on("s_empty", { state: "empty", word: "connected" }, "Empty box (Nothing on this server yet)");
  if (!e.empty || e.rows.length) fail(`${k}: Empty box: Home draws ${e.rows.length} rows and ${e.empty ? "an" : "no"} empty body`);
  const w = await on("s_wait", { state: "connecting", word: "connecting" }, "Slow link (Connecting)");
  if (!w.placeholders) fail(`${k}: Slow link: Home draws no placeholder rows while the server connects`);
  await on("s_away", { state: "trouble", word: "unreachable" }, "Attic server (not connected)");
  if (!await cardSays("Its boards and chats come back when it does")) fail(`${k}: Attic server: the card does not say its chats come back when the server does`);
  await on("s_old", { state: "trouble", word: "too-old" }, "Old Mini (Too old)");
  if (!await cardSays("Update the server on that computer")) fail(`${k}: Old Mini: the card does not say to update the server`);
  if (!await cardSays("0.9.1")) fail(`${k}: Old Mini: the card does not name the version 0.9.1`);
  await on("s_cert", { state: "trouble" }, "Cert box (Certificate changed)");
  if (!await cardSays("certificate changed") || !await byTid(page, "problem-review").count()) fail(`${k}: Cert box: the card does not say the certificate changed, with Review`);
}

/** The states the new build draws. key: "<section>.<id>"; value: { see: [parts], viewports?: where it applies }. */
/** B2: starts the wait of the seeded chat for a point (`kind` "point") or for shapes ("select") by the seam of the build made for the checks (app/src/screens/board/pickseam.ts). */
const pickAct = (kind) => async (page) => {
  await byTid(page, "composer-input").first().waitFor({ state: "visible", timeout: 15000 });
  await page.evaluate(([k, chat]) => (k === "point" ? window.__aiwbPick.startPick(chat) : window.__aiwbPick.startSelect(chat)), [kind, "c_UXB2"]);
};

export const DRAWN = {
  // ---- the chat view (S4): the header, the thread, its empty state and the warning of a server that is away. The composer's parts of
  // these states (their `see` in the seed) are K3's, the tool and permission cards S6's, the tree and the fork actions S8's: each adds
  // them to its entry (A4.turns, A4.two-branches and A4.remote-turns have an `act` of S8's: it adds them with the act).
  "A2.plain-started": { see: [{ tid: "chat-head", text: "Why is the build slow" }, { tid: "msg", data: { role: "user" } }, { tid: "msg", data: { role: "assistant" } }, { tid: "tchip", data: { kind: "model", fixed: true } }],
    phoneSee: [{ tid: "chat-head", text: "Why is the build slow" }, { tid: "msg", data: { role: "user" } }, { tid: "msg", data: { role: "assistant" } }, { tid: "composer-box" }, { tid: "composer-phone-tools" }] },
  "A2.plain-new": { see: [{ tid: "chat-head" }, { tid: "empty-thread" }, { tid: "suggestion", count: 2 }, { tid: "tchip", data: { kind: "agent" } }] },
  "A2.plain-new-long": { see: [{ tid: "chat-head" }, { tid: "empty-thread" }, { tid: "suggestion", count: 2 }, { tid: "composer-box" }, { tid: "tchip", data: { kind: "model", fixed: false }, text: "extended thinking" }] },
  "A2.plain-started-long": { see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "composer-box" }, { tid: "tchip", data: { kind: "model", fixed: true }, text: "extended thinking" }],
    phoneSee: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "composer-box" }, { tid: "composer-phone-tools" }] },
  "A2.plain-busy": { see: [{ tid: "chat-head" }, { tid: "typing" }, { tid: "stop" }] },
  "A2.plain-ctxerr": { see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "ctx-meter", data: { error: true }, text: "Context unavailable" }] }, // S9: the ring's error meter
  "A2.plain-quotes": { see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "composer-box" }, { tid: "qcount", data: { n: 2 }, text: "❝ 2" }] }, // K5: the count of the draft's two quotes
  "A2.plain-remote-new": { see: [{ tid: "chat-head-server", text: "lab-gpu-box.tailnet-1234.ts.net" }, { tid: "empty-thread" }, { tid: "ctx-meter" }], phoneSee: [SUB("Claude Code"), { tid: "empty-thread" }, { tid: "ctx-meter" }] },
  "A2.plain-remote-started": { see: [{ tid: "chat-head-server", text: "lab-gpu-box.tailnet-1234.ts.net" }, { tid: "msg" }, { tid: "ctx-meter" }], phoneSee: [SUB("Claude Code"), { tid: "msg" }, { tid: "ctx-meter" }] },
  "A2.plain-remote-started-long": { see: [{ tid: "chat-head-server", text: "lab-gpu-box.tailnet-1234.ts.net" }, { tid: "msg" }, { tid: "ctx-meter" }], phoneSee: [SUB("Claude Code"), { tid: "msg" }, { tid: "ctx-meter" }] },
  "A2.plain-loading": { see: [{ tid: "chat-head-server" }, { tid: "tchip", data: { kind: "model", fixed: true }, text: "Loading models" }], phoneSee: [SUB("Cursor"), { tid: "tchip", data: { kind: "model", fixed: false }, text: "Loading models" }] }, // (the phone's chip row: the model chip says so and takes no press)
  "A2.plain-noagent": { see: [{ tid: "chat-head" }, { tid: "empty-reason", text: "Choose an agent to send a message." }, { tid: "agent-reason", text: "Choose an agent" }] },
  "A2.plain-noagent-installed": { see: [{ tid: "chat-head-server" }, { tid: "empty-reason", text: "No agent is installed on Bare box" }, { tid: "agent-reason", data: { tone: "missing" }, text: "No agent is installed on Bare box" }], phoneSee: [{ tid: "chat-head-sub" }, { tid: "composer-block", data: { kind: "noagent", place: "box" }, text: "No agent is installed on Bare box" }] },
  "A2.plain-off-new": { see: [{ tid: "remote-bar", data: { kind: "off" } }, { tid: "empty-thread" }, { tid: "empty-reason", text: "is not connected: nothing can be sent or changed until it is back." }, { tid: "agent-reason", data: { tone: "missing" }, text: "lab-gpu-box.tailnet-1234.ts.net is not connected" }],
    // T3: no bar under the thread on the phone (goal 3.5: said once, in the composer's place: the block, not the empty thread); the header's sub-line says "offline"
    phoneSee: [SUB("offline"), { tid: "empty-thread" }, { tid: "composer-block", data: { kind: "offline", place: "toolbar" }, text: "is offline" }, { tid: "composer-box" }] },
  "A2.plain-off-started": { see: [{ tid: "remote-bar", data: { kind: "off" } }, { tid: "remote-bar-text", text: "lab-gpu-box.tailnet-1234.ts.net is not connected" }, { tid: "msg" }, { tid: "ctx-meter" }, { tid: "composer-box" }],
    phoneSee: [SUB("offline"), { tid: "msg" }, { tid: "composer-box" }] }, // T3: no bar on the phone
  "A2.plain-fork-fresh": { see: [{ tid: "chat-head" }, { tid: "forked-from" }, { tid: "tchip", data: { kind: "model", fixed: false } }], // (the model and its effort: one chip)
    phoneSee: [{ tid: "chat-head" }, { tid: "forked-from" }, { tid: "tchip", data: { kind: "model" } }, { tid: "chip-note", text: "Only the model can change" }] }, // (C2: the phone's row has no effort chip: the model chip alone, "<model> · <effort>", and its note)
  "A2.plain-fork-notice": { see: [{ tid: "chat-head" }, { tid: "forked-from" }, { tid: "model-notice", text: "Another model" }] },
  // (the wide header's branch crumb `fk-crumb` has no phone counterpart: the phone names no branch in its header, the Tree button carries the count)
  "A2.plain-branches": { see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "fk-tree-btn", data: { count: 2 } }, { tid: "fk-crumb" }, { tid: "composer-box" }], phoneSee: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "chat-tree", data: { count: 2 } }, { tid: "composer-box" }] },
  "A2.board-started": { see: [{ tid: "chat-head" }, { tid: "empty-thread" }, { tid: "suggestion", count: 3 }, { tid: "tchip", data: { kind: "model", fixed: true } }],
    phoneSee: [{ tid: "chat-head" }, { tid: "empty-thread" }, { tid: "suggestion", count: 3 }, { tid: "composer-box" }, { tid: "composer-phone-tools" }] },
  "A2.board-new": { see: [{ tid: "chat-head" }, { tid: "empty-thread" }, { tid: "suggestion", count: 3 }, { tid: "tchip", data: { kind: "agent" } }] },
  "A2.board-quotes": { see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "composer-box" }, { tid: "qcount", data: { n: 2 }, text: "❝ 2" }] },
  "A2.board-long": { see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "composer-box" }, { tid: "tchip", data: { kind: "model", fixed: true }, text: "extended thinking" }],
    phoneSee: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "composer-box" }, { tid: "composer-phone-tools" }] },
  "A2.board-longname": { see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "ctx-chip", text: "second draft" }] },
  "A4.fork-claude": { see: [{ tid: "chat-head" }, { tid: "forked-from" }, { tid: "tchip", data: { kind: "model", fixed: false } }] },
  "A4.fork-cursor": { see: [{ tid: "chat-head" }, { tid: "forked-from" }, { tid: "tchip", data: { kind: "model", fixed: false } }] },
  "A4.fork-pi": { see: [{ tid: "chat-head" }, { tid: "forked-from" }, { tid: "tchip", data: { kind: "model", fixed: false } }] },
  // T1 (the chat on the phone): the long chat with its three branches and every block of Markdown, and the chat with none
  "UXT1.thread": { see: [{ tid: "chat-head" }, { tid: "msg", data: { role: "assistant" } }, { tid: "md-table", count: 1 }, { tid: "md-code", count: 1 }, { tid: "md-link", count: 1 }] },
  "UXT1.plain": { see: [{ tid: "chat-head" }, { tid: "msg", data: { role: "user" } }] },
  // T3 (Chat info and what it opens): the started chat with two images and two branches, the archived chat, and a chat of another server with a request that waits (the last as its server drops)
  "UXT3.chat": { see: [{ tid: "chat-head", text: "Fix the flaky cart test" }, { tid: "msg", data: { role: "user" } }, { tid: "image-thumb", count: 2 }] },
  "UXT3.archived": { see: [{ tid: "chat-head", text: "Old refund spike" }, { tid: "msg", data: { role: "user" } }] },
  "UXT3.remote": { see: [{ tid: "chat-head", text: "Check the staging deploy" }, { tid: "msg", data: { role: "user" } }, { tid: "perm", data: { state: "pending" }, count: 1 }] },
  "UXT3.remote-off": { see: [{ tid: "chat-head", text: "Check the staging deploy" }, { tid: "msg", data: { role: "user" } }] },
  // ux T2: the phone reads the parts of its own cards (a step, a folded group, the who-line, the dock's neighbours, the subagents' card); UX.T2-tools checks their shapes
  "UXT2.steps": { see: [{ tid: "chat-head" }, { tid: "msg", data: { role: "assistant" } }], phoneSee: [{ tid: "chat-head" }, { tid: "step", data: { failed: true, open: true } }, { tid: "step-exit", text: "exit code 1" }, { tid: "step-group", data: { count: 3 } }] },
  "UXT2.perm": { see: [{ tid: "chat-head" }, { tid: "perm", data: { state: "pending" } }], phoneSee: [SUB("Needs your approval"), { tid: "perm-who", text: "Claude wants to run a command" }, { tid: "perm-command" }, { tid: "perm-allow" }] },
  "UXT2.busy": { see: [{ tid: "chat-head" }, { tid: "perm", data: { state: "allow" } }], phoneSee: [{ tid: "chat-head" }, { tid: "perm-folded", text: "Allowed" }, { tid: "typing" }] },
  "UXT2.subs": { see: [{ tid: "chat-head" }, { tid: "sub-row" }], phoneSee: [{ tid: "chat-head" }, { tid: "sub-card", data: { count: 4, running: 2 } }, { tid: "sub-row" }, { tid: "sub-report-row" }] },
  "A6.code": { see: [{ tid: "chat-head" }, { tid: "md-code", count: 4 }] },
  // S6, the cards: the tool items of the three agents, the incomplete ones, the large, the wide and the malformed (A5), and the chat with
  // a permission request that waits and two that were decided (A6.cards). A5.sub is a card in the subagent's drawer: S7's.
  "A5.claude": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 9 }, { tid: "tool-card", data: { kind: "edit" }, count: 3 }] },
  "A5.cursor": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 11 }] },
  "A5.pi": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 6 }] },
  "A5.gaps": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 5 }, { tid: "tool-card", data: { running: true }, count: 3 }, { tid: "tool-card", data: { err: true }, count: 2 },
    // the labels of the five (the seed's `also`): the two that failed and the three that run
    { in: [{ tid: "tool-card", data: { err: true } }], tid: "tool-label", exact: "Build", count: 1 }, { in: [{ tid: "tool-card", data: { err: true } }], tid: "tool-label", exact: "Editing sum.go — denied", count: 1 },
    { in: [{ tid: "tool-card", data: { running: true } }], tid: "tool-label", exact: "…", count: 1 }, { in: [{ tid: "tool-card", data: { running: true } }], tid: "tool-label", exact: "Run the tests…", count: 1 },
    { in: [{ tid: "tool-card", data: { running: true } }], tid: "tool-label", exact: "Writing a file…", count: 1 }] },
  "A5.big": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 4 }] },
  "A5.wide": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 6 }] },
  "A5.panel": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 6 }] },
  "A5.junk": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 15 }], phoneSee: [{ tid: "chat-head" }, { tid: "tool-card" }] }, // T2: the phone's list mounts the rows near the window only (A5.3 counts them in a tall one)
  "A5.sub": { see: [{ tid: "sub-row", state: "attached" }, { tid: "sub-drawer-body" }, { tid: "tool-card", count: 2 }], phoneSee: [{ tid: "sub-screen" }, { tid: "sub-steps", data: { open: false } }] }, // S7: the drawer of a subagent, opened by the state's act
  "A6.cards": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 2 }, { tid: "perm", count: 3 }, { tid: "perm", data: { state: "pending" }, count: 1 }, { tid: "perm-allow" }, { tid: "perm-deny" }] },
  "SEC.chat": { see: [{ tid: "chat-head-server", text: "Studio Mac" }, { tid: "msg", data: { role: "user" }, text: "render queue" }], phoneSee: [SUB("Claude Code"), { tid: "msg", data: { role: "user" }, text: "render queue" }] },
  "SEC.chat-away": { see: [{ tid: "remote-bar", data: { kind: "off" } }, { tid: "remote-bar-text", text: "Studio Mac is not connected" }], phoneSee: [SUB("Studio Mac · offline")] }, // T3: no bar on the phone
  // S8: the fork parts of the chat view: the banner of a pending move (the composer's parts of these states are K3's), the actions of a message, the header's
  // Tree button with its count, the chat tree popup (their `act` is in sel.mjs: move, hover, tree)
  "A2.plain-move": { see: [{ tid: "chat-head" }, { tid: "fk-banner" }, { tid: "fk-back" }] },
  "A2.plain-move-long": { see: [{ tid: "chat-head" }, { tid: "fk-banner" }, { tid: "fk-back" }] },
  "A2.board-move": { see: [{ tid: "chat-head" }, { tid: "fk-banner" }, { tid: "fk-back" }] },
  "A4.turns": { see: [{ tid: "msg", data: { role: "assistant" } }, { tid: "fk-act", data: { kind: "branch" } }], phoneAct: holdReply, phoneSee: [{ tid: "msg", data: { role: "assistant" } }, { tid: "msg-sheet" }, SHEET_ROW("branch")] },
  "A4.remote-turns": { see: [{ tid: "chat-head-server" }, { tid: "fk-act", data: { kind: "branch" } }], phoneAct: holdReply, phoneSee: [SUB("Claude Code"), SHEET_ROW("branch")] },
  "A4.two-branches": { see: [{ tid: "fk-nav-sub", text: "2 branches" }, { tid: "fk-row", count: 6 }, { tid: "fk-here" }], phoneAct: pressTree, phoneSee: [{ tid: "fk-nav-sub", text: "2 branches" }, { tid: "fk-row", count: 6 }, { tid: "fk-here" }] },
  "A6.tree-popup": { see: [{ tid: "fk-nav-sub", text: "2 branches" }, { tid: "fk-row", count: 6 }], phoneAct: pressTree, phoneSee: [{ tid: "fk-nav-sub", text: "2 branches" }, { tid: "fk-row", count: 6 }] },
  // (the phone's counterparts, `phoneSee` / `phoneRun`: where the phone has no sidebar the state is read on Home, h1-design.md §2–§6; the wide entries stay as they are)
  "A1.servers": { see: [{ tid: "servers-btn", data: { dot: true }, label: "not connected" }, { tid: "servers-dot" }], // S3: the Servers button's dot (the dialog: L7)
    phoneRun: serversRowPhone, phoneSee: [{ tid: "settings-row", data: { row: "servers" } }] }, // (the foot is behind Home's gear, in Settings: the Servers row's sub-line names the server not connected, in the warn tone)
  // "A2.plain-started": { see: [{ tid: "composer" }, { tid: "chat-head", text: "A plain chat" }] },
  // S1, the sidebar:
  // (phone: this computer's chip and Home say it is connecting, with placeholders for rows; the problem card for a start that failed, the reason as its text and
  // Try again (§4.3); the card for an older server, Restart server; "another build" works, so Home has no card (§4.3) and the Servers row behind the gear says it)
  "A1.stream-down": { see: [{ tid: "side-section-state", data: { server: "local", tone: "wait" }, text: "Connecting…" }],
    phoneSee: [{ tid: "home", data: { state: "connecting", server: "local" } }, { in: [{ tid: "home-sub" }], tid: "state-word", data: { word: "connecting" }, text: "Connecting" }, { tid: "home-placeholder" }] }, // (with the stream down the other servers are not listed: no chips, the one-server line says the word)
  "A1.local-other-build": { see: [{ tid: "side-section-extra", text: "another build" }, { in: [{ tid: "side-section-extra" }], tid: "btn", text: "Restart server" }],
    phoneRun: otherBuildPhone, phoneSee: [] },
  "A1.local-not-started": { see: [{ tid: "side-section-reason", text: "not set up" }, { in: [{ tid: "side-section-extra" }], tid: "btn", text: "Retry" }],
    phoneSee: [{ tid: "home", data: { state: "trouble", server: "local" } }, { in: [{ tid: "problem-card", data: { server: "local" } }], tid: "problem-reason", text: "not set up" }, { in: [{ tid: "problem-card", data: { server: "local" } }], tid: "problem-retry", text: "Try again" }] },
  "A1.local-too-old": { see: [{ tid: "side-section-line", text: "older than the app" }, { in: [{ tid: "side-section-extra" }], tid: "btn", text: "Restart server" }],
    phoneSee: [{ tid: "home", data: { state: "trouble", server: "local" } }, { tid: "problem-card", data: { server: "local", word: "too-old" }, text: "runs an older server" }, { in: [{ tid: "problem-card" }], tid: "problem-restart", text: "Restart server" }] },
  // (the seed's `also`: the chats in the groups the tree names: `treeShape`)
  "A3.tree": { see: [{ tid: "side-group-head", data: { depth: 2 }, text: "Leaf" }, { tid: "side-row", data: { kind: "chat" } }], run: treeShape, phoneSee: [], phoneRun: treeShapePhone },
  "SEC.sidebar": { see: [{ tid: "side-section", data: { server: "s_studio", tone: "ok" } }, { in: [SECTION("s_studio"), { tid: "side-group" }, { tid: "side-group" }], tid: "side-row", data: { kind: "chat", key: "s_studio~c_night" }, text: "Last night's failures" },
    // the other sections, each in the state the seed gives it (the seed's `also`)
    { in: [SECTION("s_studio")], tid: "side-section-state", text: "Connected" }, { in: [SECTION("s_empty")], tid: "side-section-line", text: "Nothing on this server yet." },
    { in: [SECTION("s_wait")], tid: "side-section-state", text: "Connecting" }, { in: [SECTION("s_away")], tid: "side-section-line", text: "when the server is back" },
    { in: [SECTION("s_old")], tid: "side-section-state", text: "Too old" }, { in: [SECTION("s_old")], tid: "side-section-line", text: "Update the server on that machine." },
    { in: [SECTION("s_old")], tid: "side-section-line", last: true, text: "0.9.1" }, { in: [SECTION("s_cert")], tid: "side-section-state", text: "Certificate changed" }],
    phoneSee: [], phoneRun: serversPhone }, // (phone: each server's chip, and on its Home the state the seed gives it, §2 and §4)
  // B4: the board's canvas, drawn by the view (state "ready"). On the phone a board and its chat are two screens of the stack and the chat is the one on
  // screen (AD-71), so the canvas of a state that names a chat is in the tree and not on screen there: a state whose point is the board (A6.board, SEC.board,
  // and the selection of A2.board-selected) goes `phone: "board"`, to the board's screen by the stack's back (and, for the selection, on to the chat by the Chats button and the sheet's row; the select presses Edit here first).
  "A2.board-selected": { see: [{ tid: "board-canvas", data: { board: "b_ui", state: "ready" }, state: "attached" }, { tid: "ctx-act", data: { kind: "selection" }, text: "3 selected" }], phone: "board-then-chat", edit: true,
    phoneSee: [{ tid: "board-canvas", data: { board: "b_ui", state: "ready" }, state: "attached" }, { tid: "context-row" }], phoneRun: boardSelectedPhone }, // (phone: no "3 selected" there, B2's selection rule: boardSelectedPhone) // (the select is the keyboard's ⌘A: a tablet or a phone with a keyboard, as P7.4-board's)
  // (A2.board-busy: the agent's presence is on the canvas, which is a screen under the chat on the phone, so there it is in the tree, as the seed's chat is what the state is about)
  "A2.board-busy": { see: [{ tid: "chat-head" }, { tid: "typing" }, { tid: "board-canvas", data: { board: "b_A2" }, state: "attached" }, { tid: "presence", state: "attached", wide: true }, { tid: "stop" }] },
  "A6.board": { see: [{ tid: "board-canvas", data: { board: "b_ui", state: "ready" } }, { css: TOOLBAR }], phone: "board", edit: true },
  "SEC.board": { see: [{ tid: "board-canvas", data: { board: "s_studio~b_loose", state: "ready" } }, { css: TOOLBAR }], phone: "board", edit: true },
  // ---- S2: the Servers screens of the phone (dev/mock-ui.js UXS2; the screens are pushed on the stack, so these are the phone's states only)
  "UXS2.list": { viewports: ["phone"], see: [{ tid: "srv-list" }, { tid: "srv-row", data: { server: "s_certbox", word: "cert-changed" } }] },
  "UXS2.detail": { viewports: ["phone"], see: [{ tid: "srv-facts", data: { server: "s_build", place: "screen" } }, { tid: "srv-version", text: "1.8.2" }] },
  "UXS2.unreachable": { viewports: ["phone"], see: [{ tid: "srv-facts", data: { server: "s_attic", place: "screen" } }, { tid: "srv-why", text: "Connection refused" }] },
  "UXS2.too-old": { viewports: ["phone"], see: [{ tid: "srv-facts", data: { server: "s_mini", place: "screen" } }, { tid: "srv-update" }] },
  "UXS2.cert": { viewports: ["phone"], see: [{ tid: "srv-facts", data: { server: "s_certbox", place: "screen" } }, { tid: "srv-cert-notice" }] },
  "UXS2.compare": { viewports: ["phone"], see: [{ tid: "srv-cert", data: { server: "s_certbox" } }, { tid: "srv-fp-now", data: { tone: "bad" } }, { tid: "srv-fp-old" }] },
  // UX.C1 (package C1, the phone's composer): the states of the seed's section UXC1, drawn at the phone only (the wide composer's states are A2's)
  "UXC1.new": { viewports: ["phone"], see: [{ tid: "chat-head" }, { tid: "empty-thread" }, { tid: "composer-chip-row" }, { tid: "composer-phone-tools" }, { tid: "composer-plus", label: "Add to message" }, { tid: "composer-talk" }] },
  "UXC1.started": { viewports: ["phone"], see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "composer-phone-tools" }, { tid: "composer-dictate" }, { tid: "composer-talk" }, { tid: "ctx-meter" }] },
  "UXC1.busy": { viewports: ["phone"], see: [{ tid: "chat-head" }, { tid: "typing" }, { tid: "composer-phone-tools" }, { tid: "stop" }] },
  "UXC1.amber": { viewports: ["phone"], see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "composer-phone-tools" }, { tid: "ctx-meter" }] },
  "UXC1.board-new": { viewports: ["phone"], see: [{ tid: "chat-head" }, { tid: "empty-thread" }, { tid: "composer-chip-row" }, { tid: "context-row" }, { tid: "ctx-chip", data: { kind: "board" }, text: "Pipeline" }] },
  "UXC1.board-started": { viewports: ["phone"], see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "context-row" }, { tid: "ctx-chip", data: { kind: "board" }, text: "Pipeline" }, { tid: "composer-phone-tools" }] },
  "UXC1.board-draft": { viewports: ["phone"], see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "context-row" }, { tid: "ctx-chip", data: { kind: "board" }, text: "Pipeline" }, { tid: "ctx-chip", data: { kind: "ref" }, text: "Roadmap" }, { tid: "qcount", data: { n: 2 }, text: "2 quotes" }] },
  // UX.C2 (package C2, the phone's chip row and pickers): the states of the seed's section UXC2, drawn at the phone only
  "UXC2.new": { viewports: ["phone"], see: [{ tid: "chat-head" }, { tid: "empty-thread" }, { tid: "composer-chip-row" }, { tid: "tchip", data: { kind: "agent" } }, { tid: "tchip", data: { kind: "folder" } }, { tid: "tchip", data: { kind: "model" } }, { tid: "tchip", data: { kind: "subagents" } }, { tid: "starters" }, { tid: "config-hint" }] },
  "UXC2.missing": { viewports: ["phone"], see: [{ tid: "chat-head" }, { tid: "composer-chip-row" }, { tid: "tchip", data: { kind: "agent", missing: "true" } }, { tid: "agent-reason", text: "is not installed" }] },
  "UXC2.fork": { viewports: ["phone"], see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "composer-chip-row" }, { tid: "tchip", data: { kind: "model" } }, { tid: "chip-note", text: "Only the model can change" }] },
  "UXC2.pi": { viewports: ["phone"], see: [{ tid: "chat-head" }, { tid: "empty-thread" }, { tid: "composer-chip-row" }, { tid: "tchip", data: { kind: "model" } }, { tid: "tchip", data: { kind: "agent" }, label: "Pi" }] },
  "UXC2.started": { viewports: ["phone"], see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "composer-phone-tools" }, { tid: "composer-input" }] },
  // UX.V1-voice (package V1, the phone's blocked composer and voice on a board): the states of the seed's section UXV1, drawn at the phone only
  "UXV1.draft": { viewports: ["phone"], see: [{ tid: "chat-head", text: "Staging rollout" }, { tid: "composer-box", text: "Reply to Dana about the staging rollout" }, { tid: "composer-phone-tools" }] },
  "UXV1.draft-off": { viewports: ["phone"], see: [{ tid: "chat-head", text: "Staging rollout" }, { tid: "composer-block", data: { kind: "offline", place: "toolbar" }, text: "Design Mac is offline" }, { tid: "composer-box", text: "Reply to Dana about the staging rollout" }, { tid: "block-servers" }] },
  "UXV1.arch": { viewports: ["phone"], see: [{ tid: "chat-head", text: "Old pricing notes" }, { tid: "composer-block", data: { kind: "archived", place: "box" }, text: "This chat is archived." }, { tid: "unarchive" }] },
  "UXV1.arch-off": { viewports: ["phone"], see: [{ tid: "chat-head", text: "Old changelog" }, { tid: "composer-block", data: { kind: "archived", place: "box" }, text: "Design Mac is offline" }] },
  "UXV1.legacy": { viewports: ["phone"], see: [{ tid: "chat-head", text: "Before the new connection" }, { tid: "composer-block", data: { kind: "legacy", place: "box" }, text: "old board connection" }] },
  "UXV1.legacy-board": { viewports: ["phone"], see: [{ tid: "chat-head", text: "Old board chat" }, { tid: "composer-block", data: { kind: "legacy", place: "box" }, text: "old board connection" }, { tid: "block-newchat" }] },
  "UXV1.noagent": { viewports: ["phone"], see: [{ tid: "chat-head", text: "Nothing here" }, { tid: "composer-block", data: { kind: "noagent", place: "box" }, text: "No agent is installed on Bare box." }] },
  "UXV1.toosmall": { viewports: ["phone"], see: [{ tid: "chat-head", text: "Fork on pi" }, { tid: "composer-block", data: { kind: "toosmall", place: "above" }, text: "too small a context window" }, { tid: "block-pick-model" }, { tid: "composer-box" }] },
  "UXV1.gone": { viewports: ["phone"], see: [{ tid: "chat-head", text: "Gone soon" }, { tid: "composer-block", data: { kind: "gone", place: "toolbar" }, text: "no longer on Design Mac" }] },
  "UXV1.plain": { viewports: ["phone"], see: [{ tid: "chat-head", text: "Plain" }, { tid: "msg" }, { tid: "composer-phone-tools" }, { tid: "composer-dictate" }, { tid: "composer-talk" }] },
  "UXV1.board": { viewports: ["phone"], see: [{ tid: "board-canvas", data: { board: "b_ui", state: "ready" } }, { tid: "board-orb-slot" }, { tid: "voice-orb", label: "Talk" }], phone: "board", edit: true },
  // H1, the phone's Home (seed UXH1; the wide layouts draw the sidebar, so the phone only). A state's `pre` (the servers listed) and `ls` (this
  // computer hidden by the build's knob, Home's saved place) are the seed's, as P0.3 opens it; the entries hold each part of the seed's `see` and `also`
  "UXH1.one": { viewports: ["phone"], see: [{ tid: "home", data: { state: "list" } }, { tid: "home-sub", text: "Studio Mac" }] },
  "UXH1.four": { viewports: ["phone"], see: [{ tid: "home", data: { state: "list" } }, { tid: "server-chips" }, { tid: "server-chip", count: 4 }, { tid: "home-row", data: { kind: "group", attention: "count" }, text: "Checkout service" }] },
  "UXH1.connecting": { viewports: ["phone"], see: [{ tid: "home", data: { state: "connecting" } }, { tid: "home-placeholder" }] },
  "UXH1.trouble": { viewports: ["phone"], see: [{ tid: "home", data: { state: "trouble" } }, { tid: "problem-card", text: "Attic" }, { tid: "home-list", data: { stale: "true" } }] },
  "UXH1.cert": { viewports: ["phone"], see: [{ tid: "home", data: { state: "trouble" } }, { tid: "problem-card", data: { word: "cert-changed" } }, { tid: "problem-review" }] },
  "UXH1.kinds": { viewports: ["phone"], see: [{ tid: "home", data: { state: "list" } }, { tid: "home-row", data: { kind: "group", attention: "count", count: "2" }, text: "Release prep" },
    { tid: "home-row", data: { kind: "board", attention: "none" }, text: "Load test" }, { tid: "home-row", data: { kind: "board", attention: "dot" }, text: "Deploy plan" }] },
  "UXH1.nested": { viewports: ["phone"], see: [{ tid: "group-screen", data: { key: "h1_studio~g_refunds" } }, { in: [{ tid: "group-screen", data: { key: "h1_studio~g_refunds" } }], tid: "home-row", data: { kind: "board" }, text: "Refund rules" }] /* (scoped: Home under the pushed screen has board rows of its own, first in the tree, not on screen) */ },
  "UXH1.empty-group": { viewports: ["phone"], see: [{ tid: "group-screen", data: { key: "h1_release~g_scratch" } }, { tid: "group-empty" }, { tid: "home-empty-new" }] },
  "UXH1.empty-server": { viewports: ["phone"], see: [{ tid: "home", data: { state: "empty" } }, { tid: "home-empty-chat" }, { tid: "home-empty-board" }] },
  "UXH1.none": { viewports: ["phone"], see: [{ tid: "first-run" }, { tid: "first-run-add" }, { tid: "first-run-scan" }] },
  // H2, the phone's row actions, Archived and search (seed UXH2, h2 chunk 7; the phone only): `pre` lists Studio Mac and Build box, `ls` is Home's place (and the search's two lists)
  "UXH2.rows": { viewports: ["phone"], see: [{ tid: "home", data: { server: "h2_studio", state: "list" } }, { tid: "home-row", data: { kind: "group" }, text: "Checkout service" }, { tid: "home-row", data: { kind: "board" }, text: "Orders data model" }, { tid: "home-row", data: { kind: "chat" }, text: "Regex for promo codes" }] },
  "UXH2.group": { viewports: ["phone"], see: [{ tid: "group-screen", data: { key: "h2_studio~g_checkout" } }, { in: [{ tid: "group-screen", data: { key: "h2_studio~g_checkout" } }], tid: "home-row", data: { kind: "board" }, text: "Cart redesign" }, { in: [{ tid: "group-screen", data: { key: "h2_studio~g_checkout" } }], tid: "home-row", data: { kind: "chat" }, text: "Audit the checkout flow" }] },
  "UXH2.archived": { viewports: ["phone"], phoneRun: async (page) => { await press(page, byTid(page, "home-gear").first()); await byTid(page, "settings-row", { row: "archived" }).last().waitFor({ state: "visible", timeout: LIMIT }); await press(page, byTid(page, "settings-row", { row: "archived" }).last()); }, phoneSee: [{ tid: "archived-screen" }, { tid: "archived-server", count: 2 }, { tid: "home-row", data: { archived: "true", kind: "chat" }, text: "Scratch ideas" }, { tid: "archived-foot", text: "Archived chats are read-only" }], see: [] },
  "UXH2.search": { viewports: ["phone"], phoneRun: async (page) => { await press(page, byTid(page, "home-search").first()); }, phoneSee: [{ tid: "search", data: { state: "recent" } }, { tid: "search-recent", count: 2 }, { tid: "search-row", count: 2 }, { tid: "search-scope", count: 3 }], see: [] },
  "UXH2.away": { viewports: ["phone"], see: [{ tid: "home", data: { server: "h2_studio", state: "trouble" } }, { tid: "home-list", data: { stale: "true" } }] },
  // UX.B2 (package B2, Point at and Add selection on the phone): the board while the chat waits for a point / for shapes (the seed's section UXB2: the chat is opened,
  // then window.__aiwbPick starts the wait, as the "+" sheet's rows do; the app takes the user to the board's screen, where the pick bar is drawn)
  "UXB2.point": { viewports: ["phone"], phoneAct: pickAct("point"), see: [], phoneSee: [{ tid: "pick-bar", data: { kind: "point" }, text: "Tap a spot on the board" }, { tid: "pick-cancel", text: "Cancel" }, { tid: "state-word", data: { word: "picking" }, text: "Picking a point" }, { tid: "pick-border" }] },
  "UXB2.select": { viewports: ["phone"], phoneAct: pickAct("select"), see: [], phoneSee: [{ tid: "pick-bar", data: { kind: "select" }, text: "Select items" }, { tid: "pick-take", text: "Edit here" }, { tid: "state-word", data: { word: "selecting" }, text: "Selecting for the chat" }, { tid: "pick-border" }] },
};

const UNDO = "delete flags.streamDown; delete flags.hello; setServerState('local', 'connected'); uxh1Reset();"; // what a state's `mock` or `pre` may have set (uxh1Reset: the servers a UXH1 state listed)
const LIMIT = 15000;
const FRAMES = 60; // (a second at 60 Hz; the frames a loaded machine draws more slowly, and the page gets as much longer)

/** The frames the page draws with the state showing: an error thrown after the load is seen by check(), which watches every page. */
const frames = (page, n = FRAMES) => page.evaluate((n) => new Promise((done) => { let i = 0; const tick = () => (++i < n ? requestAnimationFrame(tick) : done()); requestAnimationFrame(tick); }), n);

await check("P0.3 every seeded state renders", async ({ url, mock, viewport, layout, open, fail, note }) => {
  // (the build has a version of its own, not "dev": a server of another build is then told by this computer's section; buildAppDist of dev/shot.mjs gives it)
  const index = await fetch(url + "/").then((r) => r.text(), () => ""), main = index.match(/src="\.?\/?(_expo\/static\/js\/web\/index-[^"]+\.js)"/)?.[1];
  const bundle = main ? await fetch(`${url}/${main}`).then((r) => r.text(), () => "") : "";
  if (!bundle.includes('"uicheck"')) fail("the build's version is not \"uicheck\": this computer's server of another build needs a version of the page to differ from (buildAppDist of dev/shot.mjs gives it)");
  const reconnect = async () => { // (the server a state dropped is back before the next page: openApp does it too, but not for pages that open together)
    const id = dropped.get(url);
    if (id) { dropped.delete(url); await mockEval(`setServerState(${JSON.stringify(id)}, "connected");`, url); }
  };
  // One part of a state: on screen (or in the tree), its text, its count.
  const part = async (page, key, p) => {
    const where = p.css ?? `${p.in ? p.in.map((c) => tidSel(c.tid, c.data) + " ").join("") : ""}${tidSel(p.tid, p.data)}${p.exact !== undefined ? `:text-is(${JSON.stringify(p.exact)})` : ""}`;
    const name = p.css ?? `${p.in ? p.in.map((c) => c.tid + (c.data ? JSON.stringify(c.data) : "")).join(" ") + " " : ""}${p.tid}${p.data ? " " + JSON.stringify(p.data) : ""}${p.exact !== undefined ? ` "${p.exact}"` : ""}`;
    let all = page.locator(where), el = p.last ? all.last() : all.first();
    // (a chip of the toolbar that the row has no room for is in the open "more" popup, as A2.2 has it: composerfit)
    const folded = p.tid === "tchip" && !await until(async () => await all.count() > 0, 4000) && await page.locator(MORE).count() > 0;
    if (folded) {
      await press(page, page.locator(MORE));
      const pop = byTid(page, "more-pop");
      await pop.waitFor({ state: "visible", timeout: LIMIT }).catch(() => { throw new Error(`the toolbar has no ${name}, and its "more" chip opens no popup`); });
      all = pop.locator(where); el = all.first();
    }
    await el.waitFor({ state: p.state ?? "visible", timeout: LIMIT }).catch(() => { throw new Error(`nothing on screen has ${p.css ? "the selector" : "the testID"} ${name}${folded ? ' (in the toolbar, or in the "more" popup)' : ""}`); });
    if (p.text && !await until(async () => ((await el.textContent()) ?? "").includes(p.text), 5000)) fail(`${key}: ${name} says "${((await el.textContent()) ?? "").slice(0, 80)}", not "${p.text}"`);
    if (p.label && !((await el.getAttribute("aria-label")) ?? "").includes(p.label)) fail(`${key}: ${name} is labelled "${await el.getAttribute("aria-label")}", not "${p.label}"`);
    if (p.count !== undefined && !await until(async () => await all.count() === p.count, 5000)) fail(`${key}: ${await all.count()} elements match ${name}, not ${p.count}`);
    if (folded) { // (closed again: the next part is looked for in the page)
      await page.keyboard.press("Escape");
      if (!await until(async () => !await byTid(page, "more-pop").count(), 5000)) fail(`${key}: Esc did not close the "more" popup`);
    }
  };
  const show = async (s, entry, tag) => {
    const key = `${s.section}.${s.id}`, name = `${tag}: ${key}`;
    if (s.pre) await mockEval(s.pre, url); // (the seed's `pre`: run in the mock before the page loads; its `ls` is the page's localStorage before it loads)
    const o = await open({ sel: s.sel, wait: "", ...(s.ls ? { ls: s.ls } : {}), ...(s.pane && viewport === "desktop" ? paneSize(s.pane[0], Math.max(s.pane[1], 480)) : {}) });
    try {
      // (UXH1.trouble and UXH2.away drop their server once Home has drawn the list: the app keeps that last copy, faded; dropped before, there is nothing to fade)
      if (s.mock?.includes("uxh1DropAttic") || s.mock?.includes("uxh2Away")) await o.page.waitForSelector(tidSel("home-row"), { state: "attached", timeout: LIMIT });
      if (s.mock) await mockEval(s.mock, url);
      const onBoard = layout === "phone" && entry.phone;
      if (onBoard) { // (the chat is the screen: back to the board's)
        await byTid(o.page, "chat-head").first().waitFor({ state: "visible", timeout: LIMIT });
        if (!await back(o.page)) throw new Error("the phone's stack has no back from the chat to the board");
        await byTid(o.page, "board-bar").first().waitFor({ state: "visible", timeout: LIMIT });
      }
      if (s.act === "select" || entry.edit) await o.page.waitForSelector(tidSel("board-canvas", { state: "ready" }), { timeout: LIMIT }); // (the shapes are drawn before they are selected, as composer.mjs openState)
      if (entry.edit) { // (a board opens as a reader's, in view mode, whatever the layout: Edit here (the bar's, on the phone the bottom row's) takes it, and then the canvas can be drawn on)
        await press(o.page, byTid(o.page, "board-take").first());
        await o.page.waitForSelector(".excalidraw:not(.excalidraw--view-mode) canvas.interactive", { timeout: LIMIT });
      }
      if (layout === "phone" && entry.phoneAct) await entry.phoneAct(o.page); // (T1: the phone's own way to the same state)
      else await act(o.page, s.act);
      if (onBoard === "board-then-chat") {
        await press(o.page, byTid(o.page, "board-chats").first()); // (the phone's Chats button opens the sheet, whose row opens the chat)
        await press(o.page, byTid(o.page, "chats-row", { chat: s.sel.chat }).first());
        await byTid(o.page, "chat-head").first().waitFor({ state: "visible", timeout: LIMIT });
      }
      const phoned = layout === "phone" && entry.phoneSee; // (the entry has a counterpart for the phone: it is read instead of `see` and `run`)
      const failed = { fail: (line) => fail(line.replace(/^([A-Z0-9]+\.[\w-]+)/, `${tag}: $1`)) };
      if (phoned) await entry.phoneRun?.(o.page, failed);
      for (const p of phoned ? entry.phoneSee : entry.see) if (!(p.wide && layout === "phone")) await part(o.page, name, p); // (`wide`: a part the phone does not draw)
      if (!phoned) await entry.run?.(o.page, failed);
      await frames(o.page);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await o.ctx.close();
  };
  // A seed's states, those the table names drawn, one after the other.
  const draw = async (states, tag) => {
    let drawn = 0;
    for (const s of states) {
      const entry = DRAWN[`${s.section}.${s.id}`];
      if (!entry || (entry.viewports && !entry.viewports.includes(viewport))) continue;
      drawn++;
      if (s.mock || s.pre || s.act?.startsWith("drop:")) {
        if (s.mock || s.pre) { await mock?.restart(); await seed(url, ...(tag === "alone" ? [s.section] : [])); }
        await reconnect();
        await show(s, entry, tag);
        await reconnect();
        if (s.mock || s.pre) await mockEval(UNDO, url);
        continue;
      }
      await show(s, entry, tag);
    }
    return drawn;
  };
  const states = await seed(url);
  const keys = new Set(states.map((s) => `${s.section}.${s.id}`));
  if (states.length !== keys.size) fail("the seed's list has two states with one key");
  for (const key of Object.keys(DRAWN)) if (!keys.has(key)) fail(`${key} is not a state of the seed (dev/mock-ui.js): a state renamed or removed, or a mistyped key`);
  for (const key of keys) if (!DRAWN[key]) fail(`${key} is a state of the seed with no entry in DRAWN: add what the build draws of it, or why it cannot (the seed's see, text, count and also are what the old build shows)`);
  const drawn = await draw(states, "together");
  note(`${drawn} of ${states.length} seeded states are drawn by the new build at ${layout}`);
  if (viewport === "desktop") { // each section on a mock of its own: a section's states stand on what it seeds
    let alone = 0;
    for (const section of [...new Set(states.map((s) => s.section))]) {
      await mock?.restart();
      const own = await seed(url, section);
      if (!own.length || own.some((s) => s.section !== section)) fail(`seedUI("${section}") answered ${own.length} states, ${own.filter((s) => s.section !== section).length} of another section`);
      alone += await draw(own, "alone");
    }
    note(`${alone} states alone, each section on a mock of its own`);
  }
}, { viewports, page: false });
