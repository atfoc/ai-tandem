// R1's recipes of Home and the rows (rules.mjs says what a recipe is): goal 3.2 and 3.3, the mockups "10a to 10d Home v2", "02 The stack and the
// back", "08 Empty Home and first run", "04 Row actions", "05 Renaming", "11 New sheet v2", "07 Settings › Archived", "09 Search".
// Seeds: UXH1 (the servers and states of Home: dev/mock-ui.js) and UXH2 (rows, sheets, New, Archived, search). Each screen is reached the way
// UX.H1-home, UX.H2-rows and UX.F2-stack reach it (presses, holds, swipes, typing); the stack seam only reads.
import { until } from "../../shot.mjs";
import { homeSeen } from "../home.mjs";
import { swipeButtons, swipeLeft } from "../rows.mjs";
import { RULES } from "../rules.mjs";
import { back, byTid, hold, longPress, press, tidSel, touchDrag } from "../sel.mjs";

const UNDO_H1 = "setServerState('local', 'connected'); uxh1Reset();";
const J = JSON.stringify;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const STUDIO = "h2_studio", key = (id) => `${STUDIO}~${id}`;
const H1_STUDIO = "h1_studio", H1_ATTIC = "h1_attic";
const H1_ALL = ["h1_studio", "h1_build", "h1_attic", "h1_cert"];
const NOLOCAL = "aiwb.uicheck.nolocal";
const placeH1 = (server, groups = []) => ({ [NOLOCAL]: "1", "aiwb.home": J({ server, groups: groups.map((g) => `${server}~${g}`) }) });

const homeReady = tidSel("home", { state: "list" });

// ---- shared moves

/** Sheets and pickers closed the way a person closes them: a tap on the dimmed page above the sheet (the grabber, a swipe down and Back too). */
async function closeOverlays(page) {
  for (let i = 0; i < 5 && await byTid(page, "overlay-backdrop").count(); i++) {
    const bb = await byTid(page, "overlay-backdrop").last().boundingBox();
    if (!bb) break;
    await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + 12);
    await sleep(500);
  }
  await until(async () => !await byTid(page, "overlay-backdrop").count(), 4000);
}
/** A finger held on a row until its sheet is up (the sheet rises on the release, h2-design.md H2-4). */
const holdRow = async (page, kind, id) => { await longPress(page, byTid(page, "home-row", { kind, key: key(id) }).last(), { ms: 700 }); };
const sheetUp = (page) => byTid(page, "row-sheet").last();
const rowKeys = async (page, kind) => (await homeSeen(page)).rows.filter((r) => !kind || r.kind === kind).map((r) => r.key);
const stackOf = (page) => page.evaluate(() => window.__aiwbStack.entries().map((e) => `${e.route}:${e.key}`));
/** The kinds of the stack, "home > group > chat" (the entries' routes). */
const routes = async (page) => (await page.evaluate(() => window.__aiwbStack.entries().map((e) => String(e.route)))).join(" > ");
const topShown = async (page, id) => byTid(page, id).last().isVisible().catch(() => false);
const waitTop = async (page, what, id, ms = 15000) => { if (!await until(() => topShown(page, id), ms)) throw new Error(`${what}: ${id} is not drawn`); };
const waitRoutes = async (page, what, want) => {
  if (!await until(async () => (await routes(page)) === want, 12000)) throw new Error(`${what}: the stack is "${await routes(page)}", not "${want}"`);
};

/** Goal 3.2: every row is 60 pt and says no "…" or "+" (what the sheets hold, not the row). */
async function rowsPlain(page, h, what, root) {
  const v = await homeSeen(page, root);
  for (const r of v.rows) {
    if (r.height < 59.5) h.fail(`${what}: the row "${r.name}" is ${r.height.toFixed(1)} pt high; a row is 60 pt`);
    if (/[…+]/.test(r.name + r.sub)) h.fail(`${what}: the row "${r.name}" says "${r.name} | ${r.sub}": no "…" or "+" in a row`);
  }
  const marks = await page.evaluate(() => [...document.querySelectorAll('[data-testid="home-row"]')].filter((e) => e.getBoundingClientRect().height > 0 && [...e.querySelectorAll('[role="button"]')].some((b) => /^(…|\.\.\.|\+|More)$/.test((b.getAttribute("aria-label") || b.innerText || "").trim()))).length);
  if (marks) h.fail(`${what}: ${marks} row(s) hold a "…" or "+" control`);
}

/** The steps of a screen that other chunks audit (a chat, a board): the stack is what the step is for. */
const OTHERS = { skip: RULES, why: "this step reads the stack's landing; the chat and the board screens are audited by their own recipes (chat.*, board.*)" };

// ---- UXH1: Home

const recipesH1 = [
  { id: "home.one", goal: "3.2 · 10a Home v2 (one server)", seed: ["UXH1"], state: "UXH1.one", undo: UNDO_H1, wait: homeReady,
    steps: [{ name: "list", check: async (page, h) => rowsPlain(page, h, "Home") }] },
  { id: "home.four", goal: "3.2 · 10a Home v2", seed: ["UXH1"], state: "UXH1.four", undo: UNDO_H1, wait: homeReady,
    steps: [
      { name: "list", check: async (page, h) => rowsPlain(page, h, "Home") },
      // a chip held opens the server's sheet (goal 3.2: "A server's sheet")
      { name: "server-sheet", go: async (page) => { await hold(page, byTid(page, "server-chip", { server: H1_STUDIO }), { until: byTid(page, "srv-sheet").last() }); }, ready: tidSel("srv-sheet") },
    ] },
  { id: "home.kinds", goal: "3.2 · 10c Home v2 (a dot and a count)", seed: ["UXH1"], state: "UXH1.kinds", undo: UNDO_H1, wait: homeReady,
    steps: [{ name: "list", check: async (page, h) => rowsPlain(page, h, "Home") }] },
  { id: "home.nested", goal: "3.2 · 02 The stack and the back (a group three deep)", seed: ["UXH1"], state: "UXH1.nested", undo: UNDO_H1, wait: tidSel("group-screen"),
    steps: [
      { name: "refunds", check: async (page, h) => rowsPlain(page, h, "Refunds") },
      // holding the back lists the stack (goal 3.1.2)
      { name: "stack-sheet", go: async (page) => { await hold(page, byTid(page, "nav-back").last(), { until: byTid(page, "stack-sheet").last() }); }, ready: tidSel("stack-sheet"),
        check: async (page, h) => {
          const rows = await byTid(page, "picker-row").evaluateAll((es) => es.map((e) => e.dataset.value));
          if (rows.length < 4) h.fail(`the stack sheet lists ${rows.length} screens (${rows.join(", ")}); Refunds is Home › Checkout service › Payments › Refunds`);
        } },
      { name: "payments", go: async (page) => { await closeOverlays(page); await press(page, byTid(page, "nav-back").last()); }, ready: tidSel("group-screen", { key: `${H1_STUDIO}~g_payments` }),
        check: async (page, h) => rowsPlain(page, h, "Payments") },
    ] },
  { id: "home.empty-group", goal: "3.2 · 10d Home v2 (an empty group)", seed: ["UXH1"], state: "UXH1.empty-group", undo: UNDO_H1, wait: tidSel("group-empty"),
    steps: [
      { name: "screen" },
      { name: "new-sheet", go: async (page) => { await press(page, byTid(page, "home-empty-new").first()); }, ready: tidSel("home-new-sheet") },
    ] },
  { id: "home.connecting", goal: "3.2 · 10b Home v2 (connecting)", seed: ["UXH1"], state: "UXH1.connecting", undo: UNDO_H1, wait: tidSel("home", { state: "connecting" }),
    steps: [{ name: "placeholders" }] },
  // the card above the faded list: the state's own knob drops Attic once Home has drawn its list, so the recipe does it in its step
  { id: "home.trouble", goal: "3.2 · 10b Home v2 (a problem on the selected server)", seed: ["UXH1"], undo: UNDO_H1, ls: placeH1(H1_ATTIC), wait: homeReady,
    prepare: async (h) => { await h.mockEval(`uxh1Show(${J(H1_ALL)}, { connected: [${J(H1_ATTIC)}] });`); },
    steps: [{ name: "card-and-faded-list", go: async (page, h) => { await h.mockEval("await uxh1DropAttic();"); }, ready: tidSel("problem-card"),
      check: async (page, h) => rowsPlain(page, h, "the faded list") }] },
  { id: "home.cert", goal: "3.2 · 10b Home v2 (certificate changed)", seed: ["UXH1"], state: "UXH1.cert", undo: UNDO_H1, wait: tidSel("home", { state: "trouble" }),
    steps: [{ name: "card" }] },
  { id: "home.empty-server", goal: "3.2 · 08 Empty Home and first run (an empty server)", seed: ["UXH1"], state: "UXH1.empty-server", undo: UNDO_H1, wait: tidSel("home", { state: "empty" }),
    steps: [{ name: "empty" }] },
  { id: "home.none", goal: "3.2 · 08 Empty Home and first run (first run)", seed: ["UXH1"], state: "UXH1.none", undo: UNDO_H1, wait: tidSel("first-run"),
    steps: [{ name: "first-run" }] },
];

// ---- UXH2: rows, sheets, New, Archived, search

const recipesH2 = [
  { id: "home.rows", goal: "3.3 · 04 Row actions", seed: ["UXH2"], state: "UXH2.rows", wait: homeReady,
    steps: [
      { name: "list", check: async (page, h) => rowsPlain(page, h, "Home") },
      // a left swipe shows Archive and Delete (88 pt, the row's height)
      { name: "swiped-open", go: async (page, h) => {
          h.chatsBefore = await rowKeys(page, "chat");
          const row = byTid(page, "home-row", { kind: "chat", key: key("c_flaky") }).first();
          await swipeLeft(page, row);
          if (!await until(async () => (await swipeButtons(row)).length === 2, 5000)) throw new Error("a swipe left on a chat row shows no two buttons");
        },
        check: async (page, h) => {
          const row = byTid(page, "home-row", { kind: "chat", key: key("c_flaky") }).first();
          const got = (await swipeButtons(row)).join();
          if (got !== "archive,delete") h.fail(`the swipe shows [${got}], not Archive and Delete`);
        } },
      // Delete asks (P4); Cancel leaves the row
      { name: "delete-asks", go: async (page) => { await press(page, byTid(page, "swipe-action", { action: "delete" }).last()); }, ready: tidSel("confirm-dialog"),
        check: async (page, h) => {
          const t = (await byTid(page, "confirm-title").first().innerText()).trim();
          if (t !== "Delete “Fix the flaky cart test”?") h.fail(`Delete asks ${J(t)}, not 'Delete “Fix the flaky cart test”?'`);
        } },
      { name: "delete-cancelled", go: async (page) => { await press(page, byTid(page, "confirm-cancel").first()); await until(async () => !await byTid(page, "confirm-dialog").count(), 5000); },
        ready: tidSel("home-row", { kind: "chat", key: key("c_flaky") }),
        check: async (page, h) => {
          const now = await rowKeys(page, "chat");
          if (now.join() !== h.chatsBefore.join()) h.fail(`after Cancel the chats are ${J(now)}, not ${J(h.chatsBefore)}: Cancel leaves the row where it was`);
        } },
      // Archive does not ask: the row goes at once and the toast offers Undo
      { name: "archived-toast", go: async (page, h) => {
          h.chatsBefore = await rowKeys(page, "chat");
          h.confirmSeen = false;
          const row = byTid(page, "home-row", { kind: "chat", key: key("c_env") }).first();
          await swipeLeft(page, row, { full: true });
          h.confirmSeen = await until(() => byTid(page, "confirm-dialog").count().then((n) => n > 0), 800);
        }, ready: tidSel("toast"),
        check: async (page, h) => {
          if (h.confirmSeen) h.fail("Archive asked: only Delete asks");
          if ((await rowKeys(page, "chat")).includes(key("c_env"))) h.fail("the archived chat is still on Home");
          const t = (await byTid(page, "toast").first().innerText()).replace(/\s+/g, " ");
          if (!/Archived “Rename the env vars”/.test(t) || !/Undo/.test(t)) h.fail(`the toast says ${J(t)}, not 'Archived “Rename the env vars”' with Undo`);
        } },
      { name: "undone", go: async (page) => { await press(page, byTid(page, "toast-action").first()); },
        ready: tidSel("home-row", { kind: "chat", key: key("c_env") }),
        check: async (page, h) => {
          await sleep(400);
          const now = await rowKeys(page, "chat");
          if (now.join() !== h.chatsBefore.join()) h.fail(`Undo put the rows in the order ${J(now.map((k) => k.split("~")[1]))}, not ${J(h.chatsBefore.map((k) => k.split("~")[1]))}: the row comes back in the same place`);
        } },
      // the long press: a chat's P1 sheet, Move to…, Rename (P3), the delete question from the sheet
      { name: "chat-sheet", go: async (page) => { await holdRow(page, "chat", "c_flaky"); }, ready: tidSel("row-sheet") },
      { name: "move-to", go: async (page) => { await press(page, byTid(page, "action-row", { action: "move" }).last()); }, ready: tidSel("move-sheet") },
      { name: "rename", go: async (page) => { await closeOverlays(page); await holdRow(page, "chat", "c_flaky"); await byTid(page, "row-sheet").last().waitFor({ state: "visible", timeout: 10000 });
          await press(page, byTid(page, "action-row", { action: "rename" }).last()); }, ready: tidSel("rename-sheet") },
      { name: "delete-from-sheet", go: async (page) => {
          await press(page, byTid(page, "sheet-left").first()); await until(async () => !await byTid(page, "rename-sheet").count(), 5000); await closeOverlays(page);
          await holdRow(page, "chat", "c_flaky"); await byTid(page, "row-sheet").last().waitFor({ state: "visible", timeout: 10000 });
          await press(page, byTid(page, "action-row", { action: "delete" }).last()); }, ready: tidSel("confirm-dialog"),
        check: async (page, h) => {
          await press(page, byTid(page, "confirm-cancel").first());
          await until(async () => !await byTid(page, "confirm-dialog").count(), 5000);
          if (!(await rowKeys(page, "chat")).includes(key("c_flaky"))) h.fail("Cancel of the sheet's Delete removed the chat");
        } },
      { name: "board-sheet", go: async (page) => { await closeOverlays(page); await holdRow(page, "board", "b_orders"); }, ready: tidSel("row-sheet") },
      { name: "group-sheet", go: async (page) => { await closeOverlays(page); await holdRow(page, "group", "g_checkout"); }, ready: tidSel("row-sheet") },
      // + New and its Where page
      { name: "new-sheet", go: async (page) => { await closeOverlays(page); await press(page, byTid(page, "home-new").first()); }, ready: tidSel("home-new-sheet", { page: "what" }) },
      { name: "where-page", go: async (page) => { await press(page, byTid(page, "new-where").first()); }, ready: tidSel("home-new-sheet", { page: "where" }) },
      { name: "where-level", go: async (page) => { await press(page, byTid(page, "new-level", { group: key("g_checkout") }).first()); }, ready: tidSel("new-put", { group: key("g_checkout") }) },
    ] },
  { id: "home.board-swipe", goal: "3.3 · 04 Row actions (a board)", seed: ["UXH2"], state: "UXH2.group", wait: tidSel("group-screen", { key: key("g_checkout") }),
    steps: [
      { name: "group-screen", check: async (page, h) => rowsPlain(page, h, "Checkout service") },
      // boards swipe the same way: Archive does not ask, Undo puts the board back at its index
      { name: "board-archived-toast", go: async (page, h) => {
          h.boardsBefore = await rowKeys(page, "board");
          h.confirmSeen = false;
          const row = byTid(page, "home-row", { kind: "board", key: key("b_flow") }).first();
          await swipeLeft(page, row, { full: true });
          h.confirmSeen = await until(() => byTid(page, "confirm-dialog").count().then((n) => n > 0), 800);
        }, ready: tidSel("toast"),
        check: async (page, h) => {
          if (h.confirmSeen) h.fail("archiving a board asked: only Delete asks");
          if ((await rowKeys(page, "board")).includes(key("b_flow"))) h.fail("the archived board is still on the group's screen");
          const t = (await byTid(page, "toast").first().innerText()).replace(/\s+/g, " ");
          if (!/Archived “Checkout flow”/.test(t) || !/Undo/.test(t)) h.fail(`the toast says ${J(t)}, not 'Archived “Checkout flow”' with Undo`);
        } },
      { name: "board-undone", go: async (page) => { await press(page, byTid(page, "toast-action").first()); }, ready: tidSel("home-row", { kind: "board", key: key("b_flow") }),
        check: async (page, h) => {
          await sleep(400);
          const now = await rowKeys(page, "board");
          if (now.join() !== h.boardsBefore.join()) h.fail(`Undo put the boards in the order ${J(now.map((k) => k.split("~")[1]))}, not ${J(h.boardsBefore.map((k) => k.split("~")[1]))}: the board comes back in the same place`);
        } },
      { name: "board-delete-asks", go: async (page) => {
          await swipeLeft(page, byTid(page, "home-row", { kind: "board", key: key("b_flow") }).first());
          await until(async () => (await swipeButtons(byTid(page, "home-row", { kind: "board", key: key("b_flow") }).first())).length === 2, 5000);
          await press(page, byTid(page, "swipe-action", { action: "delete" }).last()); }, ready: tidSel("confirm-dialog"),
        check: async (page, h) => {
          await press(page, byTid(page, "confirm-cancel").first());
          await until(async () => !await byTid(page, "confirm-dialog").count(), 5000);
          if (!(await rowKeys(page, "board")).includes(key("b_flow"))) h.fail("Cancel of a board's Delete removed the board");
        } },
      { name: "group-more-sheet", go: async (page) => { await press(page, byTid(page, "group-more").last()); }, ready: tidSel("row-sheet") },
      { name: "group-new-sheet", go: async (page) => { await closeOverlays(page); await press(page, byTid(page, "group-new").last()); }, ready: tidSel("home-new-sheet") },
    ] },
  { id: "home.search", goal: "3.3 · 09 Search", seed: ["UXH2"], state: "UXH2.search", wait: homeReady,
    steps: [
      { name: "focused-recent", go: async (page) => { await press(page, byTid(page, "home-search").first()); }, ready: tidSel("search", { state: "recent" }) },
      { name: "typed-results", go: async (page) => { await byTid(page, "search-field").first().fill("checkout"); }, ready: tidSel("search", { state: "results" }),
        check: async (page, h) => {
          const bold = await page.evaluate(() => [...document.querySelectorAll('[data-testid="search-row"] *')].filter((e) => !e.children.length && +getComputedStyle(e).fontWeight >= 600 && /heckout/.test(e.textContent)).length);
          if (!bold) h.fail("a result has no bold match for “checkout”");
        } },
      { name: "scope-boards", go: async (page) => { await press(page, byTid(page, "search-scope", { scope: "boards" }).first()); }, ready: tidSel("search-section", { section: "boards" }) },
      { name: "no-results", go: async (page) => { await byTid(page, "search-field").first().fill("kubernetes"); }, ready: tidSel("search-none"),
        check: async (page, h) => {
          const t = (await byTid(page, "search-none").first().innerText()).replace(/\s+/g, " ");
          if (!/No boards or chats match “kubernetes”/.test(t)) h.fail(`the empty answer says ${J(t)}`);
          const b = (await byTid(page, "search-new-chat").first().innerText()).trim();
          if (b !== "New chat “kubernetes”") h.fail(`the offer says ${J(b)}, not 'New chat “kubernetes”'`);
        } },
    ] },
  { id: "home.archived", goal: "3.3 · 07 Settings › Archived", seed: ["UXH2"], state: "UXH2.archived", wait: homeReady,
    steps: [
      { name: "list", go: async (page) => { await press(page, byTid(page, "home-gear").first()); await waitTop(page, "the gear", "settings-screen");
          await sleep(500); await press(page, byTid(page, "settings-row", { row: "archived" }).last()); }, ready: tidSel("archived-screen"),
        check: async (page, h) => rowsPlain(page, h, "Archived", page.locator(tidSel("archived-screen")).last()) },
      { name: "swiped-right-unarchive", go: async (page) => { await sleep(400);
          const row = byTid(page, "home-row", { key: key("c_pricing") }).first();
          const b = await row.boundingBox();
          await touchDrag(page, { x: b.x + b.width * 0.2, y: b.y + b.height / 2 }, { x: b.x + b.width * 0.55, y: b.y + b.height / 2 }, { hold: 0 });
          await until(async () => (await swipeButtons(row)).includes("unarchive"), 4000); }, ready: tidSel("swipe-action", { action: "unarchive" }) },
      // (from the right-open state a left swipe closes it, the next opens Delete: the finger goes over the stationary swipe-row's width)
      { name: "swiped-left-delete", go: async (page) => {
          const row = byTid(page, "home-row", { key: key("c_pricing") }).first();
          const box = await page.locator(`${tidSel("swipe-row")}:has(${tidSel("home-row", { key: key("c_pricing") })})`).last().boundingBox();
          for (let i = 0; i < 2 && !(await swipeButtons(row)).includes("delete"); i++) {
            await touchDrag(page, { x: box.x + box.width * 0.7, y: box.y + box.height / 2 }, { x: box.x + box.width * 0.3, y: box.y + box.height / 2 }, { hold: 0 });
            await sleep(600);
          }
          await until(async () => (await swipeButtons(row)).includes("delete"), 4000); }, ready: tidSel("swipe-action", { action: "delete" }) },
      { name: "delete-asks", go: async (page) => { await press(page, byTid(page, "swipe-action", { action: "delete" }).last()); }, ready: tidSel("confirm-dialog"),
        check: async (page) => { await press(page, byTid(page, "confirm-cancel").first()); await until(async () => !await byTid(page, "confirm-dialog").count(), 5000); } },
    ] },
];

// ---- back landings (goal 3.1.2, 6.2): the stack from each way in, read from the seam; the screens of the chat and the board are other recipes'
const recipesBack = [
  { id: "home.back-landings", goal: "3.1.2 · 02 The stack and the back", seed: ["UXH2"], state: "UXH2.rows", wait: homeReady,
    steps: [
      { name: "from-a-row", ...OTHERS,
        go: async (page) => {
          await press(page, byTid(page, "home-row", { kind: "group", key: key("g_checkout") }).first());
          await waitTop(page, "the group", "group-screen");
          await press(page, byTid(page, "home-row", { kind: "chat", key: key("c_audit") }).last());
          await waitTop(page, "the chat", "chat-head");
        },
        check: async (page, h) => {
          const s = await routes(page);
          if (!/^home > group[^>]* > chat/.test(s)) h.fail(`a chat opened from a row has the stack "${s}", not home > group > chat`);
        } },
      { name: "back-to-group", ...OTHERS, go: async (page) => { await back(page); await waitTop(page, "the group screen", "group-screen"); },
        check: async (page, h) => { const s = await routes(page); if (!/^home > group[^>]*$/.test(s)) h.fail(`the back from the chat lands on "${s}", not its group's screen`); } },
      { name: "back-to-home", ...OTHERS, go: async (page) => { await back(page); await waitTop(page, "Home", "home"); },
        check: async (page, h) => { const s = await routes(page); if (s !== "home") h.fail(`the back from the group lands on "${s}", not Home`); } },
      // a swipe from the left edge goes back on a place screen and on a chat (goal 3.1.2); a browser has no platform edge swipe: what the page draws is asserted
      { name: "edge-swipe-on-a-chat", ...OTHERS,
        go: async (page) => {
          await press(page, byTid(page, "home-row", { kind: "chat", key: key("c_regex") }).first());
          await waitTop(page, "the chat", "chat-head");
          await sleep(500);
          await touchDrag(page, { x: 2, y: 400 }, { x: 260, y: 410 }, { hold: 0, steps: 14 });
          await sleep(900);
        },
        check: async (page, h) => {
          if (await topShown(page, "chat-head")) h.note("the edge swipe on a chat does nothing in the browser build (the platform's own swipe is a device matter, goal 6.3)");
        } },
    ] },
  { id: "home.back-from-search", goal: "3.1.2 · 09 Search (the stack from a result)", seed: ["UXH2"], state: "UXH2.search", wait: homeReady,
    steps: [
      { name: "chat-result", ...OTHERS,
        go: async (page) => {
          await press(page, byTid(page, "home-search").first()); await byTid(page, "search").last().waitFor({ state: "visible", timeout: 10000 });
          await byTid(page, "search-field").first().fill("audit");
          await byTid(page, "search-row", { key: key("c_audit") }).first().waitFor({ state: "visible", timeout: 10000 });
          await press(page, byTid(page, "search-row", { key: key("c_audit") }).first());
          await waitTop(page, "the chat", "chat-head");
        },
        check: async (page, h) => { const s = await routes(page); if (!/^home > group[^>]* > chat/.test(s)) h.fail(`a chat found by search has the stack "${s}", the same as from a row: home > group > chat`); } },
      { name: "back-from-result", ...OTHERS, go: async (page) => { await back(page); await waitTop(page, "the group screen", "group-screen"); },
        check: async (page, h) => { const s = await routes(page); if (!/^home > group[^>]*$/.test(s)) h.fail(`the back from a found chat lands on "${s}", not its group`); } },
      { name: "board-chat-result", ...OTHERS,
        go: async (page) => {
          await back(page); await waitTop(page, "Home", "home");
          await press(page, byTid(page, "home-search").first()); await byTid(page, "search").last().waitFor({ state: "visible", timeout: 10000 });
          await byTid(page, "search-field").first().fill("Draft the checkout");
          await byTid(page, "search-row", { key: key("c_flow") }).first().waitFor({ state: "visible", timeout: 10000 });
          const sub = await byTid(page, "search-row", { key: key("c_flow") }).first().innerText();
          if (!/on Checkout flow/.test(sub)) throw new Error(`a chat found through its board says ${J(sub.replace(/\s+/g, " "))}, not "on Checkout flow"`);
          await press(page, byTid(page, "search-row", { key: key("c_flow") }).first());
          await waitTop(page, "the chat", "chat-head");
        },
        check: async (page, h) => { const s = await routes(page); if (!/ > board[^>]* > chat/.test(s)) h.fail(`a chat on a board found by search has the stack "${s}": its board is under it`); } },
      { name: "back-to-the-board", ...OTHERS, go: async (page) => { await back(page); await waitTop(page, "the board", "board-bar"); },
        check: async (page, h) => { const s = await routes(page); if (!/ > board[^>]*$/.test(s)) h.fail(`the back from a board's chat lands on "${s}", not the board`); } },
      { name: "group-result", ...OTHERS,
        go: async (page) => {
          for (let i = 0; i < 5 && await routes(page) !== "home"; i++) { await back(page); await sleep(500); }
          await press(page, byTid(page, "home-search").first()); await byTid(page, "search").last().waitFor({ state: "visible", timeout: 10000 });
          await byTid(page, "search-field").first().fill("checkout");
          await press(page, byTid(page, "search-row", { kind: "group" }).first());
          await waitTop(page, "the group screen", "group-screen");
        },
        check: async (page, h) => { const s = await routes(page); if (!/^home > group[^>]*$/.test(s)) h.fail(`a group result opens "${s}", not Home on that group`); } },
    ] },
  // a server that is away: Home's faded list and the faded results (the last recipe: the mock is reseeded after it)
  { id: "home.away", goal: "3.2 · 10b Home v2 / 3.3 · 09 Search (a server away)", seed: ["UXH2"], state: "UXH2.rows", fresh: true, wait: homeReady,
    steps: [
      { name: "faded-list", go: async (page, h) => { await h.mockEval('await uxh2Away("h2_studio");'); }, ready: tidSel("home", { state: "trouble" }) },
      { name: "faded-results", go: async (page) => { await press(page, byTid(page, "home-search").first()); await byTid(page, "search").last().waitFor({ state: "visible", timeout: 10000 });
          await byTid(page, "search-field").first().fill("checkout"); }, ready: tidSel("search-row", { key: key("b_flow") }) },
    ] },
];

export const recipes = [...recipesH1, ...recipesH2, ...recipesBack];
