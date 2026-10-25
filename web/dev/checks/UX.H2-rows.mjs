// UX.H2 (ux-improvements package H2, plans/ux-improvements/h2-design.md §8; PLAN §3 "H2" Checks): what a row of the phone's Home can do and the sheets, the
// screen and the search that go with it, on the seed UXH2 (dev/mock-ui.js; its machines are made in dev/mock.mjs by `uxh1Make`, ids "h2_…"), at the phone, in
// the light theme (and, for one colour assertion a screen, the dark: `aiwb.theme`). One scenario per part, each against the design and the mockups
// (04 Row actions, 05 Renaming, 11 New sheet v2, 07 Settings › Archived, 09 Search):
//   swipe      a left swipe on a chat row shows Archive and Delete, 88 pt wide and as high as the row; a full swipe archives: the toast says "Archived “…”" with
//              Undo, which puts the row back at the same index; Delete asks (P4: the name in quotes, "Delete chat", Cancel): Cancel keeps the chat, the go button removes it
//   sheet      a long press opens the row's sheet on a group's screen: the head "Chat · Checkout service · Studio Mac", Open, Rename…, Move to… (its note the group),
//              Archive, and Delete chat… last and red; Move to… lists the places and moves the chat (the mock's chat is in Infra); Open opens it; a board's and
//              a group's sheet (the group screen's "…") name their kind
//   rename     from a row's sheet (Save off while the name is empty or unchanged; the whole name selected; Return saves), from a group screen's "…", and a board's
//              by the seam `window.__aiwbHome.rename("board", key)`
//   new        + New: the card says the place, Change opens the Where page (the crumb goes up, a child level, "Put it in", Done); a Chat, a Whiteboard and a Group are
//              made in the chosen group (the mock's call says where), a Group then opens the Rename sheet; + New in a group's screen starts at that group
//   archived   Settings › Archived: by server, then by group, rows at full contrast, the footer; a right swipe unarchives (a toast, the row is back on Home), a left
//              swipe's Delete asks
//   search     before typing (the recent searches with Clear and ×, recently opened), typing (BOARDS · CHATS · GROUPS with counts, the bold match, a board's chat "on
//              <board>"), the scope chips, a result opens (a board's chat with its board under it, a group's screen), no results (the server named, New chat with the
//              words in its draft), a search and an opened thing kept for the next time, and the faded results of a server that is away
//   sizes      every control 44 pt and text 13 pt on each of these screens and sheets (a hit slop counts)
//   dark       one colour assertion for each of the sheets, Archived and search: the surface is dark, its text light
// A screenshot of each part in the light theme is written to $OUT (default `<tmp>/ux-h2-rows`) for a person's look.
//
// Run: `cd web && VIEWPORT=phone npm run uicheck -- UX.H2`, or alone: VIEWPORT=phone node web/dev/checks/UX.H2-rows.mjs (DIST=… as README.md says; `ONLY=swipe,new`
// runs the named scenarios only, by hand).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { back, byTid, longPress, press, tidSel, touchDrag } from "./sel.mjs";
import { homeSeen } from "./home.mjs";
import { h2Archived, h2Dark, h2Search, h2Sheet, h2Sweep } from "./rows.mjs";

export const viewports = ["phone"];

const WAIT = 20000;
const OUT = process.env.OUT || path.join(os.tmpdir(), "ux-h2-rows");
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const J = JSON.stringify;

const STUDIO = "h2_studio", BUILD = "h2_build";
const key = (id, server = STUDIO) => `${server}~${id}`;
const PRE = `uxh1Show(["${STUDIO}", "${BUILD}"]);`;
// The scope chips (36 pt) and "Clear" are 44 pt by a hit slop, which react-native-web does not draw (the button's box is its own): the sweep leaves them out
// on this web build and reads their height at least (the chip 36 pt); on a device the hit slop is the app's own and the device flow reads it.
const SLOP = ["search-scope", "search-clear"];
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

await check("UX.H2 the phone's row actions, rename, + New, Archived and search", async ({ url, open, fail, note }) => {
  fs.mkdirSync(OUT, { recursive: true });

  /** The page's `aiwb.home` (Home's saved place) and the rest of the localStorage a scenario starts with. */
  const lsOf = (groupIds = [], more = {}) => ({ "aiwb.uicheck.nolocal": "1", "aiwb.home": J({ server: STUDIO, groups: groupIds.map((g) => key(g)) }), ...more });
  /** What the mock's machine `server` holds, read by `expr` (code run on it: `chats`, `groups`, `boards`, …). */
  const world = (expr, server = STUDIO) => mockEval(`return onServer(${J(server)}, () => ${expr});`, url);

  /** Runs `body` on a page opened on a fresh seed: Home of Studio Mac (`ls` another place, `theme` the dark one), the page closed and the servers put back after. */
  const scenario = async (id, body, { ls = lsOf(), theme = "light", home = true, ready } = {}) => {
    if (ONLY && !ONLY.includes(id.split(":")[0])) return;
    const tag = `${theme} ${id}`;
    const bad = (line) => fail(`${tag}: ${line}`);
    await seed(url, "UXH2");
    await mockEval(PRE, url);
    const o = await open({ ls: { ...ls, "aiwb.theme": theme }, wait: "" });
    const { page } = o;
    try {
      const ok = async (fn) => { try { return await fn(); } catch { return false; } };
      const wait = async (what, fn, ms = WAIT) => { const v = await until(() => ok(fn), ms); if (!v) bad(what); return !!v; };
      const shown = (tid, data) => ok(() => byTid(page, tid, data).first().isVisible());
      const count = (tid, data) => byTid(page, tid, data).count();
      const seen = (root) => homeSeen(page, root);
      const shot = async (name = "") => { await sleep(450); await page.screenshot({ path: path.join(OUT, `${id.replace(/:/g, "-")}${name ? "-" + name : ""}-${theme}.png`) }); };
      const calls = callsOf(page);
      await wait("the page is not in the " + theme + " theme", () => page.evaluate((t) => document.documentElement.dataset.theme === t, theme), 5000);
      if (home) await wait("Home never shows its list", async () => { const v = await seen(); return v.server === STUDIO && v.state === "list" || !!v.key; });
      if (ready) await ready({ page, wait, shown });
      /** The sizes of what a screen or a sheet draws: text 13 pt, targets 44 pt. */
      const sweep = async (css, what) => { const lines = await h2Sweep(page, css, { slop: SLOP }); if (lines.length) bad(`sizes of ${what}: ${lines.slice(0, 5).join("; ")}${lines.length > 5 ? ` … (${lines.length})` : ""}`); };
      /** The surface of `css` is dark and its text light (the dark theme's colours). */
      const dark = async (css, what) => { const d = await h2Dark(page, css); if (!d.dark || !d.light) bad(`${what} is not drawn in the dark theme: background rgb(${d.bg}), text rgb(${d.fg})`); };
      await body({ page, wait, shown, count, seen, shot, bad, ok, sweep, dark, calls });
    } catch (e) { bad(String(e.message).split("\n")[0]); }
    await o.ctx.close();
    await mockEval("uxh1Reset();", url);
  };

  // ---- readers and moves shared by the scenarios
  const rowKeys = async (seen, kind) => (await seen()).rows.filter((r) => !kind || r.kind === kind).map((r) => r.key);
  const homeRow = (page, id, kind = "chat") => byTid(page, "home-row", { kind, key: key(id) }).last();
  const swipeRow = (page, id, kind = "chat") => page.locator(`${tidSel("swipe-row")}:has(${tidSel("home-row", { kind, key: key(id) })})`).last();
  /** A swipe on a row by a finger: from `a` to `b` shares of the row's width, at its height's middle. */
  const swipe = async (page, row, a, b) => {
    await row.scrollIntoViewIfNeeded();
    const r = await row.boundingBox();
    await touchDrag(page, { x: r.x + r.width * a, y: r.y + r.height / 2 }, { x: r.x + r.width * b, y: r.y + r.height / 2 }, { hold: 0 });
  };
  const rect = (loc) => loc.boundingBox();
  const near = (a, b, d = 1.5) => Math.abs(a - b) <= d;
  /** The buttons a swipe-row shows: [{ action, label, w, h }]. */
  const buttonsOf = (row) => row.locator(tidSel("swipe-action")).evaluateAll((es) => es.map((e) => ({ action: e.dataset.action, label: (e.innerText ?? "").trim(), w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })));
  const toastOf = (page) => byTid(page, "toast").first().evaluate((e) => ({ text: (e.querySelector('[data-testid="toast-text"]')?.innerText ?? e.innerText).trim(), action: (e.querySelector('[data-testid="toast-action"]')?.innerText ?? "").trim() }));
  const typeInto = async (page, input, words) => { await input.fill(words); };
  /** A finger held on a row until its sheet is up, then taken off the way the system does when a sheet opens under it (a cancel: a release would press what the
   *  sheet drew under the finger, its backdrop). */
  const holdRow = (page, row) => longPress(page, row, { ms: 700 }); // (the sheet rises on the release after the hold: h2-design.md H2-4)
  const pressRow = async (page, tid, action) => press(page, byTid(page, tid, { action }).last());

  // ============================================================ swipe
  for (const theme of ["light"]) {
    await scenario("swipe", async ({ page, wait, shown, seen, shot, bad, ok, sweep }) => {
      const chats = async () => rowKeys(seen, "chat");
      const before = await chats();
      if (before.join() !== [key("c_regex"), key("c_env"), key("c_flaky")].join()) bad(`Home lists the chats ${J(before)}`);

      // two buttons, 88 pt wide, the row's height
      const row = swipeRow(page, "c_flaky");
      await swipe(page, row, 0.7, 0.3);
      const open2 = await wait("a swipe left on a chat row did not show two buttons", async () => (await buttonsOf(row)).length === 2);
      await sleep(500); // (the row slides open)
      if (open2) {
        const bs = await buttonsOf(row), rh = (await rect(row)).height;
        if (bs.map((b) => b.action).join() !== "archive,delete" || bs.map((b) => b.label).join() !== "Archive,Delete") bad(`the buttons are ${J(bs.map((b) => [b.action, b.label]))}, not Archive and Delete`);
        if (!bs.every((b) => near(b.w, 88) && near(b.h, rh))) bad(`the buttons are ${J(bs.map((b) => [b.w, b.h]))}, not 88 pt wide and ${rh} high (the row's height)`);
        await shot("open");
      }

      // Delete asks: Cancel keeps the chat
      await press(page, byTid(page, "swipe-action", { action: "delete" }).last());
      if (await wait("Delete did not ask", () => shown("confirm-dialog"))) {
        const t = await byTid(page, "confirm-title").first().innerText(), go = await byTid(page, "confirm-go").first().innerText(), cancel = await byTid(page, "confirm-cancel").first().innerText();
        if (t.trim() !== "Delete “Fix the flaky cart test”?") bad(`the question says ${J(t)}, not 'Delete “Fix the flaky cart test”?'`);
        if (go.trim() !== "Delete chat") bad(`the go button says ${J(go)}, not "Delete chat"`);
        if (cancel.trim() !== "Cancel") bad(`the other button says ${J(cancel)}, not "Cancel"`);
        const body = await byTid(page, "confirm-body").first().innerText().catch(() => "");
        if (!/removed on Studio Mac, for everyone who uses that server/.test(body) || !/archive it/.test(body)) bad(`the question's words are ${J(body)}`);
        await sweep(tidSel("confirm-dialog"), "the delete question");
        await shot("delete");
        await press(page, byTid(page, "confirm-cancel").first());
        await wait("Cancel did not close the question", async () => !(await shown("confirm-dialog")));
        if ((await world("typeof chats.c_flaky")) !== "object") bad("Cancel deleted the chat");
        if ((await chats()).join() !== before.join()) bad(`after Cancel Home lists ${J(await chats())}`);
      }
      // a full swipe archives: the toast says so and has Undo, which puts the row back at the same index
      const env = swipeRow(page, "c_env");
      await swipe(page, env, 0.9, 0.05);
      if (await wait("a full swipe left did not show the toast", () => shown("toast"))) {
        const t = await toastOf(page);
        if (t.text !== "Archived “Rename the env vars”") bad(`the toast says ${J(t.text)}, not "Archived “Rename the env vars”"`);
        if (t.action !== "Undo") bad(`the toast's action says ${J(t.action)}, not "Undo"`);
        await sweep(tidSel("toast"), "the toast");
        await shot("archived");
        if ((await world("chats.c_env.archived === true")) !== true) bad("a full swipe did not archive the chat on its server");
        if ((await chats()).includes(key("c_env"))) bad("the archived chat is still on Home");
        await press(page, byTid(page, "toast-action").first());
        await wait(`Undo did not put the row back at its index: Home lists ${J((await chats()).map((k) => k.split("~")[1]))}`, async () => (await chats()).join() === before.join());
        if ((await world("chats.c_env.archived === true")) === true) bad("Undo did not unarchive the chat on its server");
      }

      // Delete, confirmed, removes the chat
      const flaky = swipeRow(page, "c_flaky");
      await swipe(page, flaky, 0.7, 0.3);
      await wait("a swipe left on the second chat did not show its buttons", async () => (await buttonsOf(flaky)).length === 2);
      await press(page, byTid(page, "swipe-action", { action: "delete" }).last());
      if (await wait("Delete did not ask the second time", () => shown("confirm-dialog"))) {
        await press(page, byTid(page, "confirm-go").first());
        await wait("the go button did not remove the chat from Home", async () => !(await chats()).includes(key("c_flaky")));
        if ((await world("typeof chats.c_flaky")) !== "undefined") bad("the go button did not delete the chat on its server");
      }
    }, { theme });
  }

  // ============================================================ sheet
  const sheetOf = (page) => byTid(page, "row-sheet");
  const itemsOf = (v) => v.items.map((i) => i.action).join();
  await scenario("sheet", async ({ page, wait, shown, seen, shot, bad, ok, sweep }) => {
    await wait("Checkout service's screen is not drawn", async () => (await seen()).key === key("g_checkout"));

    // a long press on a chat opens its sheet
    await holdRow(page, homeRow(page, "c_stock"));
    if (await wait("a long press on a chat row did not open its sheet", () => shown("row-sheet"))) {
      const v = await h2Sheet(page, sheetOf(page));
      const at = await sheetOf(page).first().evaluate((e) => ({ kind: e.dataset.kind, key: e.dataset.key }));
      if (at.kind !== "chat" || at.key !== key("c_stock")) bad(`the sheet is for ${J(at)}`);
      if (v.title !== "Stock reservation bug") bad(`the sheet's title is ${J(v.title)}`);
      if (v.sub !== "Chat · Checkout service · Studio Mac") bad(`the sheet's sub-line is ${J(v.sub)}, not "Chat · Checkout service · Studio Mac"`);
      if (itemsOf(v) !== "open,rename,move,archive,delete") bad(`the sheet's rows are [${itemsOf(v)}], not [open,rename,move,archive,delete]`);
      const label = (a) => v.items.find((i) => i.action === a);
      if (label("open")?.label !== "Open" || label("rename")?.label !== "Rename…" || label("move")?.label !== "Move to…" || label("archive")?.label !== "Archive") bad(`the rows say ${J(v.items.map((i) => i.label))}`);
      if (label("move")?.note !== "Checkout service ›") bad(`Move to… says ${J(label("move")?.note)} at its right, not "Checkout service ›" (the group the chat is in)`);
      if (label("delete")?.label !== "Delete chat…" || label("delete")?.tone !== "danger") bad(`the last row is ${J(label("delete"))}: "Delete chat…", red`);
      if (v.items.at(-1)?.action !== "delete") bad("Delete is not the last row");
      for (const i of v.items) if (i.height < 49.5) bad(`the row ${i.action} is ${i.height} high, not 50 or more`);
      await sweep(tidSel("row-sheet"), "the row's sheet");
      await shot("sheet");

      // Move to… lists the places and moves the chat
      await pressRow(page, "action-row", "move");
      if (await wait("Move to… did not open the places", () => shown("move-sheet"))) {
        const m = await byTid(page, "move-sheet").first().evaluate((e) => ({
          title: (e.querySelector('[data-testid="sheet-title"]')?.innerText ?? "").trim(), sub: (e.querySelector('[data-testid="sheet-sub"]')?.innerText ?? "").trim(),
          rows: [...e.querySelectorAll('[data-testid="picker-row"]')].map((r) => ({ value: r.dataset.value, label: r.innerText.replace(/\s+/g, " ").trim(), checked: !!r.querySelector('[data-testid="picker-check"]') })),
        }));
        if (m.title !== "Move to" || m.sub !== "Stock reservation bug is in Checkout service") bad(`the places' head says ${J([m.title, m.sub])}`);
        const want = ["Not in a group", "Checkout service", "Checkout service › Payments", "Infra"];
        if (m.rows.map((r) => r.label.replace(/\s*✓$/, "")).join("|") !== want.join("|")) bad(`the places are ${J(m.rows.map((r) => r.label))}, not ${J(want)}`);
        if (m.rows.find((r) => r.checked)?.value !== key("g_checkout")) bad(`the ticked place is ${J(m.rows.find((r) => r.checked))}, not Checkout service`);
        await sweep(tidSel("move-sheet"), "the places");
        await shot("move");
        await press(page, byTid(page, "picker-row", { value: key("g_infra") }).first());
        await wait("Move to… Infra did not move the chat on its server", async () => (await world("chats.c_stock.group")) === "g_infra");
        await wait("the moved chat is still on Checkout service's screen", async () => !(await rowKeys(seen, "chat")).includes(key("c_stock")));
        await wait("the places did not close after the pick", async () => !(await shown("move-sheet")));
      }
    }

    // Open opens the chat
    await holdRow(page, homeRow(page, "c_audit"));
    if (await wait("a long press on the second chat did not open its sheet", () => shown("row-sheet"))) {
      await pressRow(page, "action-row", "open");
      await wait("Open did not open the chat", () => shown("chat-head"));
      await back(page);
    }

    // a board's sheet names its kind and its delete
    await wait("Checkout service's screen is not back", async () => (await seen()).key === key("g_checkout"));
    await holdRow(page, homeRow(page, "b_cart", "board"));
    if (await wait("a long press on a board row did not open its sheet", () => shown("row-sheet"))) {
      const v = await h2Sheet(page, sheetOf(page));
      if (v.sub !== "Whiteboard · Checkout service · Studio Mac") bad(`the board's sub-line is ${J(v.sub)}`);
      if (v.items.at(-1)?.label !== "Delete whiteboard…") bad(`the board's last row says ${J(v.items.at(-1)?.label)}, not "Delete whiteboard…"`);
      await press(page, byTid(page, "overlay-backdrop").last()).catch(() => {});
      await wait("a press outside did not close the sheet", async () => !(await shown("row-sheet")));
    }

    // the group screen's "…" opens the sheet of the group
    await press(page, byTid(page, "group-more").last());
    if (await wait("the group screen's … did not open a sheet", () => shown("row-sheet"))) {
      const v = await h2Sheet(page, sheetOf(page)), at = await sheetOf(page).first().evaluate((e) => e.dataset.kind);
      if (at !== "group" || v.title !== "Checkout service" || v.sub !== "Group · Studio Mac") bad(`the group's sheet is ${J([at, v.title, v.sub])}`);
      if (v.items.find((i) => i.action === "move")?.note !== "Top level ›") bad(`the group's Move to… says ${J(v.items.find((i) => i.action === "move")?.note)}, not "Top level ›"`);
      if (v.items.at(-1)?.label !== "Delete group…") bad(`the group's last row says ${J(v.items.at(-1)?.label)}`);
    }
  }, { ls: lsOf(["g_checkout"]) });

  // ============================================================ rename
  const renameOf = (page) => byTid(page, "rename-sheet");
  const saveOn = async (page) => (await byTid(page, "sheet-right").first().getAttribute("aria-disabled")) !== "true" && !(await byTid(page, "sheet-right").first().isDisabled());
  await scenario("rename", async ({ page, count, wait, shown, seen, shot, bad, ok, sweep, dark }) => {
    // from a row's sheet
    await holdRow(page, homeRow(page, "c_flaky"));
    await wait("a long press did not open the sheet", () => shown("row-sheet"));
    await pressRow(page, "action-row", "rename");
    if (await wait("Rename… did not open the rename sheet", () => shown("rename-sheet"))) {
      const at = await renameOf(page).first().evaluate((e) => ({ kind: e.dataset.kind, key: e.dataset.key })), input = byTid(page, "rename-input").first();
      if (at.kind !== "chat" || at.key !== key("c_flaky")) bad(`the rename sheet is for ${J(at)}`);
      const v = await h2Sheet(page, renameOf(page));
      if (v.title !== "Rename chat" || v.sub !== "Studio Mac") bad(`the rename sheet's head is ${J([v.title, v.sub])}, not ["Rename chat", "Studio Mac"]`);
      await wait("the field does not hold the chat's name", async () => (await input.inputValue()) === "Fix the flaky cart test");
      await sleep(600);
      const sel = await input.evaluate((e) => ({ focused: document.activeElement === e, from: e.selectionStart, to: e.selectionEnd, len: e.value.length, fs: parseFloat(getComputedStyle(e).fontSize), h: e.getBoundingClientRect().height }));
      if (!sel.focused || sel.from !== 0 || sel.to !== sel.len) bad(`the name is not all selected in the focused field: ${J(sel)}`);
      if (sel.h < 43.5 || sel.fs < 17) bad(`the field is ${sel.h} high with ${sel.fs} px text, not 44 and 17`);
      if (await saveOn(page)) bad("Save is on while the name is unchanged");
      await input.fill("Fix the flaky cart test "); // (a space more: the name is trimmed, so it is the same)
      if (await saveOn(page)) bad("Save is on for the same name with a space after it");
      await press(page, byTid(page, "rename-clear").first());
      await wait("the clear button did not empty the field", async () => (await input.inputValue()) === "");
      if (await count("rename-clear")) bad("the clear button is still there with the field empty");
      if (await saveOn(page)) bad("Save is on with an empty name");
      await page.keyboard.press("Enter");
      await sleep(300);
      if (!(await shown("rename-sheet"))) bad("Return closed the sheet with Save off");
      await input.fill("Fix the cart test");
      if (!(await wait("Save did not come on for a new name", () => saveOn(page), 5000))) { /* reported */ }
      const label = await byTid(page, "rename-clear").first().getAttribute("aria-label").catch(() => null);
      if (label !== "Clear name") bad(`the clear button is labelled ${J(label)}, not "Clear name"`);
      await sweep(tidSel("rename-sheet"), "the rename sheet");
      await shot("rename");
      await page.keyboard.press("Enter");
      await wait("Return did not close the sheet", async () => !(await shown("rename-sheet")));
      if ((await world("chats.c_flaky.name")) !== "Fix the cart test") bad(`Return did not rename the chat on its server: ${J(await world("chats.c_flaky.name"))}`);
      await wait("the renamed chat's row says the old name", async () => (await seen()).rows.some((r) => r.key === key("c_flaky") && r.name === "Fix the cart test"));
    }

    // a board's, by the seam of the page
    if (!(await page.evaluate(() => typeof window.__aiwbHome?.rename === "function"))) { bad("the page has no seam window.__aiwbHome.rename"); return; }
    await page.evaluate((k) => window.__aiwbHome.rename("board", k), key("b_orders"));
    if (await wait("the seam's rename did not open the sheet for a board", () => shown("rename-sheet"))) {
      const v = await h2Sheet(page, renameOf(page)), input = byTid(page, "rename-input").first();
      if (v.title !== "Rename whiteboard" || v.sub !== "Studio Mac") bad(`the board's rename sheet says ${J([v.title, v.sub])}`);
      if ((await input.inputValue()) !== "Orders data model") bad(`the board's name field holds ${J(await input.inputValue())}`);
      await input.fill("Orders model");
      await press(page, byTid(page, "sheet-right").first());
      await wait("Save did not close the board's sheet", async () => !(await shown("rename-sheet")));
      if ((await world("boards.b_orders.name")) !== "Orders model") bad(`Save did not rename the board on its server: ${J(await world("boards.b_orders.name"))}`);
    }
  });

  // from the group screen's "…"
  await scenario("rename:group", async ({ page, wait, shown, seen, shot, bad }) => {
    await wait("Checkout service's screen is not drawn", async () => (await seen()).key === key("g_checkout"));
    await press(page, byTid(page, "group-more").last());
    await wait("… did not open the sheet", () => shown("row-sheet"));
    await pressRow(page, "action-row", "rename");
    if (await wait("Rename… did not open the rename sheet", () => shown("rename-sheet"))) {
      const v = await h2Sheet(page, renameOf(page)), input = byTid(page, "rename-input").first();
      if (v.title !== "Rename group" || v.sub !== "Studio Mac") bad(`the group's rename sheet says ${J([v.title, v.sub])}`);
      if ((await input.inputValue()) !== "Checkout service") bad(`the group's name field holds ${J(await input.inputValue())}`);
      await input.fill("Checkout");
      await press(page, byTid(page, "sheet-right").first());
      await wait("Save did not close the group's sheet", async () => !(await shown("rename-sheet")));
      if ((await world("groups.find((g) => g.id === 'g_checkout').name")) !== "Checkout") bad("Save did not rename the group on its server");
      await wait("the group's screen does not show the new name", async () => (await seen()).title === "Checkout");
    }
  }, { ls: lsOf(["g_checkout"]) });


  // ============================================================ new
  const newSheet = (page) => byTid(page, "home-new-sheet");
  const newData = (page) => newSheet(page).first().evaluate((e) => ({ page: e.dataset.page, group: e.dataset.group, text: (e.innerText ?? "").replace(/\s+/g, " ").trim() }));
  const crumbsOf = (page) => byTid(page, "new-crumb").evaluateAll((es) => es.map((e) => ({ group: e.dataset.group, name: e.innerText.trim(), button: e.getAttribute("role") === "button" })));
  const putOf = (page) => byTid(page, "new-put").first().evaluate((e) => ({ group: e.dataset.group, text: e.innerText.replace(/\s+/g, " ").trim() }));
  const levelsOf = (page) => byTid(page, "new-level").evaluateAll((es) => es.map((e) => ({ group: e.dataset.group, name: e.innerText.trim() })));
  /** + New, the card, Change, one level down and Put it in Checkout service: the sheet is on its first page again with the group chosen. */
  const chooseCheckout = async (page, { wait, shown, bad, tour = false, shot, sweep }) => {
    await press(page, byTid(page, "home-new").first());
    if (!await wait("+ New did not open the sheet", () => shown("home-new-sheet"))) return false;
    const first = await newData(page);
    if (first.page !== "what" || first.group !== "") bad(`the New sheet starts as ${J(first)}, not the first page with no group`);
    if (tour) {
      const t = first.text.toLowerCase();
      for (const w of ["new", "where", "studio mac", "not in a group", "change", "what to make", "chat", "talk to an agent", "whiteboard", "a board agents can draw on", "group", "name it next", "a chat on a board starts from the board"]) if (!t.includes(w)) bad(`the New sheet does not say "${w}": ${J(first.text)}`);
      const card = await byTid(page, "new-where").first().innerText();
      if (!/Studio Mac/.test(card) || !/not in a group/.test(card)) bad(`the card says ${J(card)}, not the server and "not in a group"`);
      for (const id of ["new-change", "new-chat", "new-board", "new-group"]) if (!await shown(id)) bad(`${id} is not drawn`);
      await sweep(tidSel("home-new-sheet"), "the New sheet");
      await shot("new");
    }
    await press(page, byTid(page, "new-where").first());
    if (!await wait("Change did not open the Where page", async () => (await newData(page)).page === "where")) return false;
    if (tour) {
      const head = await newSheet(page).first().evaluate((e) => ({ left: e.querySelector('[data-testid="sheet-left"]')?.innerText.trim(), title: e.querySelector('[data-testid="sheet-title"]')?.innerText.trim(), right: e.querySelector('[data-testid="sheet-right"]')?.innerText.trim() }));
      if (head.left !== "‹ New" || head.title !== "Where" || head.right !== "Done") bad(`the Where page's head is ${J(head)}, not ‹ New · Where · Done`);
      const text = (await newData(page)).text;
      if (!text.includes("Things are made on the server Home shows")) bad(`the Where page does not say which server things are made on: ${J(text)}`);
      let c = await crumbsOf(page);
      if (c.map((x) => x.name).join() !== "Studio Mac" || c[0].button) bad(`the crumb at the top is ${J(c)}, not "Studio Mac" alone and plain`);
      let p = await putOf(page);
      if (p.text !== "Put it at the top of Studio Mac ✓") bad(`the Put row says ${J(p.text)}, not "Put it at the top of Studio Mac ✓"`);
      let l = await levelsOf(page);
      if (l.map((x) => x.name).join() !== "Checkout service,Infra") bad(`the groups at the top are ${J(l.map((x) => x.name))}, not Checkout service and Infra (an archived group is not offered)`);
      if (!(await newData(page)).text.toLowerCase().includes("groups in studio mac")) bad("the groups' heading does not say \"Groups in Studio Mac\"");
      await sweep(tidSel("home-new-sheet"), "the Where page");
      await shot("where");
      await press(page, byTid(page, "new-level", { group: key("g_checkout") }).first());
      await wait("a child level did not open", async () => (await crumbsOf(page)).length === 2);
      c = await crumbsOf(page);
      if (c.map((x) => x.name).join() !== "Studio Mac,Checkout service" || !c[0].button || c[1].button) bad(`the crumb one level down is ${J(c)}`);
      p = await putOf(page);
      if (p.text !== "Put it in Checkout service") bad(`the Put row one level down says ${J(p.text)}, not "Put it in Checkout service" (not chosen yet: no ✓)`);
      l = await levelsOf(page);
      if (l.map((x) => x.name).join() !== "Payments") bad(`the groups in Checkout service are ${J(l.map((x) => x.name))}, not Payments`);
      await press(page, byTid(page, "new-level", { group: key("g_payments") }).first());
      await wait("a second level did not open", async () => (await crumbsOf(page)).length === 3);
      await press(page, byTid(page, "new-crumb", { group: "" }).first());
      await wait("the crumb did not go up to the top", async () => (await crumbsOf(page)).length === 1);
      await press(page, byTid(page, "new-level", { group: key("g_checkout") }).first());
      await wait("Checkout service did not open again", async () => (await crumbsOf(page)).length === 2);
    } else {
      await press(page, byTid(page, "new-level", { group: key("g_checkout") }).first());
      await wait("a child level did not open", async () => (await crumbsOf(page)).length === 2);
    }
    await press(page, byTid(page, "new-put", { group: key("g_checkout") }).first());
    if (!await wait("Put it in did not go back to the first page", async () => (await newData(page)).page === "what")) return false;
    const chosen = await newData(page), card = await byTid(page, "new-where").first().innerText();
    if (chosen.group !== key("g_checkout") || !/Checkout service/.test(card) || !/the group you chose/.test(card)) bad(`after Put it in the sheet is ${J([chosen.group, card])}, not Checkout service, "the group you chose"`);
    if (tour) {
      await press(page, byTid(page, "new-where").first());
      await wait("Change did not open the Where page the second time", async () => (await newData(page)).page === "where");
      const p = await putOf(page);
      if (p.text !== "Put it in Checkout service ✓") bad(`the chosen level says ${J(p.text)}, not "Put it in Checkout service ✓"`);
      await press(page, byTid(page, "sheet-right").first());
      await wait("Done did not go back to the first page", async () => (await newData(page)).page === "what");
      if ((await newData(page)).group !== key("g_checkout")) bad("Done lost the chosen group");
    }
    return true;
  };
  const postsTo = (calls, re) => calls.filter((c) => c.method === "POST" && re.test(c.path) && c.server === STUDIO);
  await scenario("new:tour", async (c) => {
    const { page, calls, note: _n } = c;
    if (!await chooseCheckout(page, { ...c, tour: true })) return;
    await press(page, byTid(page, "new-chat").first());
    await c.wait("Chat did not close the sheet and open a chat", async () => !(await c.shown("home-new-sheet")) && await c.shown("chat-head"));
    const made = postsTo(calls, /\/chats$/);
    if (made.length !== 1) c.bad(`${made.length} calls made a chat: ${J(calls.map((x) => [x.method, x.path, x.body]))}`);
    else if (JSON.stringify(made[0].body).includes("g_checkout") === false) c.bad(`the call that made the chat is ${J(made[0].body)}: it does not name the group g_checkout`);
    if ((await world("Object.values(chats).filter((c) => c.group === 'g_checkout' && !c.archived).length")) !== 3) c.bad("the chat is not in Checkout service on its server");
  });
  await scenario("new:board", async (c) => {
    const { page, calls } = c;
    if (!await chooseCheckout(page, c)) return;
    await press(page, byTid(page, "new-board").first());
    await c.wait("Whiteboard did not close the sheet and open a board", async () => !(await c.shown("home-new-sheet")) && await c.shown("board-bar"));
    const made = postsTo(calls, /\/boards$/);
    if (made.length !== 1 || JSON.stringify(made[0].body).includes("g_checkout") === false) c.bad(`the calls that made a board are ${J(made.map((x) => x.body))}, not one naming g_checkout`);
    if ((await world("Object.values(boards).filter((b) => b.group === 'g_checkout' && !b.archived).length")) !== 3) c.bad("the board is not in Checkout service on its server");
  });
  await scenario("new:group", async (c) => {
    const { page, calls, wait, shown, bad, sweep } = c;
    if (!await chooseCheckout(page, c)) return;
    await press(page, byTid(page, "new-group").first());
    await wait("Group did not close the sheet and open the Rename sheet", async () => !(await shown("home-new-sheet")) && await shown("rename-sheet"));
    const made = postsTo(calls, /\/groups$/);
    if (made.length !== 1 || JSON.stringify(made[0].body).includes("g_checkout") === false) bad(`the calls that made a group are ${J(made.map((x) => x.body))}, not one naming g_checkout as its parent`);
    const v = await h2Sheet(page, renameOf(page));
    if (v.title !== "Rename group") bad(`the sheet after Group says ${J(v.title)}, not "Rename group"`);
    if (v.sub !== "Checkout service · Studio Mac") bad(`the new group's place is ${J(v.sub)}, not "Checkout service · Studio Mac"`);
    await byTid(page, "rename-input").first().fill("Refunds");
    await press(page, byTid(page, "sheet-right").first());
    await wait("Save did not close the Rename sheet", async () => !(await shown("rename-sheet")));
    if ((await world("groups.filter((g) => g.name === 'Refunds' && g.parent === 'g_checkout').length")) !== 1) bad("the new group is not named Refunds inside Checkout service on its server");
  });
  // + New on a group's screen starts at that group
  await scenario("new:group-screen", async ({ page, wait, shown, seen, bad }) => {
    await wait("Checkout service's screen is not drawn", async () => (await seen()).key === key("g_checkout"));
    await press(page, byTid(page, "group-new").last());
    if (await wait("+ New on a group's screen did not open the sheet", () => shown("home-new-sheet"))) {
      const d = await newData(page), card = await byTid(page, "new-where").first().innerText();
      if (d.group !== key("g_checkout") || !/Checkout service/.test(card) || !/the group you are in/.test(card)) bad(`the sheet opened in the group is ${J([d.group, card])}, not Checkout service, "the group you are in"`);
    }
  }, { ls: lsOf(["g_checkout"]) });


  // ============================================================ archived
  /** Home's gear, Settings, its Archived row: the screen is up. */
  const openArchived = async (page, { wait, shown }) => {
    await press(page, byTid(page, "home-gear").first());
    if (!await wait("the gear did not push Settings", () => shown("settings-screen"))) return false;
    await press(page, byTid(page, "settings-row", { row: "archived" }).last());
    return wait("the Archived row did not push the Archived screen", () => shown("archived-screen"));
  };
  const rowsOf = (v, server, group) => v.servers.find((x) => x.server === server)?.sections.find((x) => x.group === (group === "" ? "" : key(group, server)));
  await scenario("archived", async ({ page, wait, shown, count, seen, shot, bad, ok, sweep }) => {
    if (!await openArchived(page, { wait, shown })) return;
    await sleep(500);
    let v = await h2Archived(page);
    if (v.servers.map((x) => `${x.server}:${x.name}:${x.word}`).join() !== `${STUDIO}:Studio Mac:Connected,${BUILD}:Build box:Connected`) bad(`the servers are ${J(v.servers.map((x) => [x.server, x.name, x.word]))}, not Studio Mac and Build box, each Connected`);
    const top = rowsOf(v, STUDIO, ""), co = rowsOf(v, STUDIO, "g_checkout"), notes = rowsOf(v, BUILD, "g_notes");
    const names = (sec) => sec?.rows.map((r) => `${r.kind}:${r.name}`).join(" | ");
    if (names(top) !== "group:Old experiments | chat:Scratch ideas") bad(`Studio Mac's ungrouped archived things are [${names(top)}], not [group:Old experiments | chat:Scratch ideas]`);
    if (top?.heading) bad(`the ungrouped section has the head ${J(top.heading)}`);
    if (co?.heading !== "CHECKOUT SERVICE" || names(co) !== "board:Retired sketch | chat:Old pricing notes") bad(`under Checkout service: ${J([co?.heading, names(co)])}, not CHECKOUT SERVICE [board:Retired sketch | chat:Old pricing notes]`);
    if (notes?.heading !== "RELEASE NOTES" || names(notes) !== "chat:Old changelog draft") bad(`under Build box: ${J([notes?.heading, names(notes)])}, not RELEASE NOTES [chat:Old changelog draft]`);
    if (v.servers.flatMap((x) => x.sections).flatMap((x) => x.rows).some((r) => r.name === "Experiment log")) bad("a chat archived with its group (the same archive) is listed on its own: it comes back with the group");
    if (co && co.count !== co.rows.length) bad(`the section says ${co.count}, it has ${co.rows.length} rows`);
    const og = top?.rows.find((r) => r.kind === "group");
    if (og?.sub !== "1 chat") bad(`the archived group's sub-line is ${J(og?.sub)}, not "1 chat"`);
    for (const r of v.servers.flatMap((x) => x.sections).flatMap((x) => x.rows)) {
      if (!r.archived) bad(`the row ${r.name} does not say it is archived`);
      if (r.height < 60) bad(`the row ${r.name} is ${r.height} high; a row is 60 or more`);
      if (/archived|Mon|Tue|Wed|Thu|Fri|Sat|Sun|\d{1,2}:\d{2}|ago/.test(r.sub)) bad(`the row ${r.name} says a time or a date: ${J(r.sub)}`);
    }
    const dim = await byTid(page, "home-row", { archived: "true" }).evaluateAll((es) => es.map((e) => +getComputedStyle(e).opacity));
    if (dim.some((o) => o < 1)) bad(`an archived row is faded (opacity ${J(dim)}): they are drawn at full contrast`);
    if (v.foot !== "Archived chats are read-only. Unarchive one to continue it.") bad(`the footer says ${J(v.foot)}`);
    if (v.none) bad(`"${v.none}" is shown with things archived`);
    await sweep(tidSel("archived-screen"), "Archived");
    await shot("archived");

    // a right swipe shows Unarchive (accent), a left swipe Delete
    const sw = (id) => page.locator(`${tidSel("swipe-row")}:has(${tidSel("home-row", { key: key(id) })})`).last();
    const pricing = sw("c_pricing");
    await swipe(page, pricing, 0.2, 0.55);
    if (await wait("a right swipe did not show Unarchive", async () => (await buttonsOf(pricing)).length === 1)) {
      await sleep(500);
      const b = (await buttonsOf(pricing))[0], rh = (await rect(pricing)).height;
      if (b.action !== "unarchive" || b.label !== "Unarchive" || !near(b.w, 88) || !near(b.h, rh)) bad(`the right swipe shows ${J(b)}, not Unarchive 88 pt wide and ${rh} high`);
    }
    await swipe(page, pricing, 0.7, 0.3); // (a left swipe from the open state closes it and opens Delete: or a second swipe does)
    await swipe(page, pricing, 0.7, 0.3);
    await wait("a left swipe did not show Delete", async () => (await buttonsOf(pricing)).some((b) => b.action === "delete"));
    await press(page, byTid(page, "swipe-action", { action: "delete" }).last());
    if (await wait("Delete on an archived row did not ask", () => shown("confirm-dialog"))) {
      const t = await byTid(page, "confirm-title").first().innerText();
      if (t.trim() !== "Delete “Old pricing notes”?") bad(`the question says ${J(t)}`);
      await press(page, byTid(page, "confirm-cancel").first());
      await wait("Cancel did not close the question", async () => !(await shown("confirm-dialog")));
      if ((await world("typeof chats.c_pricing")) !== "object" || (await world("chats.c_pricing.archived")) !== true) bad("Cancel changed the archived chat");
    }

    // a full right swipe unarchives: the toast with Undo, the row leaves the list and is back on Home
    const scratch = sw("c_scratch");
    await swipe(page, scratch, 0.2, 0.95);
    if (await wait("a full right swipe did not show the toast", () => shown("toast"))) {
      const t = await toastOf(page);
      if (t.text !== "Unarchived “Scratch ideas”" || t.action !== "Undo") bad(`the toast says ${J(t)}, not "Unarchived “Scratch ideas”" with Undo`);
      if ((await world("chats.c_scratch.archived === true")) === true) bad("the swipe did not unarchive the chat on its server");
      await wait("the row did not leave Archived", async () => !(await h2Archived(page)).servers.some((x) => x.sections.some((s) => s.rows.some((r) => r.name === "Scratch ideas"))));
    }
    await back(page); await back(page);
    await wait("the backs did not return to Home", async () => (await seen()).state === "list" && !(await shown("archived-screen")));
    if (!(await seen()).rows.some((r) => r.key === key("c_scratch") && r.kind === "chat")) bad("the unarchived chat is not on Home");
  });
  // (nothing archived anywhere: the empty line) and a server that is away
  await scenario("archived:away", async ({ page, wait, shown, bad, sweep }) => {
    await mockEval(`await uxh2Away(${J(BUILD)});`, url);
    await wait("Build box did not go away on the page", async () => (await page.evaluate(() => document.body.innerText)).length > 0);
    if (!await openArchived(page, { wait, shown })) return;
    await sleep(500);
    const v = await h2Archived(page), b = v.servers.find((x) => x.server === BUILD);
    if (!b || b.sections.length) bad(`Build box (away) lists ${J(b)}: its heading and one line, no rows`);
    const line = await byTid(page, "archived-server", { server: BUILD }).first().evaluate((e) => (e.nextElementSibling?.innerText ?? "").trim());
    if (line !== "Its archived chats show when it is connected.") bad(`under Build box the line says ${J(line)}`);
    if (!/Unreachable|Offline|Not connected/i.test(b?.word ?? "")) bad(`Build box's state word is ${J(b?.word)}`);
  });

  // ============================================================ search
  /** The stack's backs until only Home is left (a board's chat sits over its board over its group's screen). */
  const toHome = async (page) => { for (let i = 0; i < 5 && (await page.evaluate(() => window.__aiwbStack.entries().length)) > 1; i++) { await back(page); await sleep(400); } };
  const searchField = (page) => byTid(page, "search-field").first();
  const openSearch = async (page, { wait, shown }) => {
    await press(page, byTid(page, "home-search").first());
    return wait("Home's search field did not open the search", () => shown("search"));
  };
  const typeQuery = async (page, q, wait) => { await searchField(page).fill(q); return wait(`typing ${J(q)} did not leave the recent state`, async () => (await h2Search(page)).field === q && (await h2Search(page)).state !== "recent"); };
  const RECENTS = { "aiwb.search.recent": J(["checkout", "regex"]), "aiwb.search.opened": J([{ key: key("c_regex"), kind: "chat" }, { key: key("b_flow"), kind: "board" }]) };
  await scenario("search", async ({ page, wait, shown, seen, shot, bad, sweep }) => {
    if (!await openSearch(page, { wait, shown })) return;
    await sleep(400);
    let v = await h2Search(page);
    if (v.state !== "recent" || v.scope !== "all") bad(`the search starts as ${J([v.state, v.scope])}, not [recent, all]`);
    if (v.recent.join() !== "checkout,regex" || !v.clear) bad(`the recent searches are ${J(v.recent)} with Clear ${v.clear}, not [checkout, regex] and Clear`);
    if (v.scopes.map((c) => `${c.label}${c.selected ? "*" : ""}`).join() !== "All*,Boards,Chats") bad(`the scope chips are ${J(v.scopes)}, not All* Boards Chats`);
    const opened = v.rows.map((r) => `${r.kind}:${r.name}|${r.sub}`).join(" ; ");
    if (opened !== "chat:Regex for promo codes|Studio Mac ; board:Checkout flow|Studio Mac › Checkout service") bad(`the recently opened are [${opened}]`);
    if (v.rows.some((r) => r.bold)) bad("a recently opened row has a bold part with nothing typed");
    if (v.sections.length) bad(`the empty search has sections ${J(v.sections)}`);
    const text = (await page.locator(tidSel("search")).last().innerText()).toUpperCase();
    for (const w of ["RECENT SEARCHES", "CLEAR", "RECENTLY OPENED"]) if (!text.includes(w)) bad(`the empty search does not say ${w}: ${J(text)}`);
    if (!(await searchField(page).evaluate((e) => document.activeElement === e))) bad("the search field has no focus");
    await sweep(tidSel("search"), "the empty search");
    await shot("recent");
    await press(page, byTid(page, "search-recent-remove", { words: "regex" }).first());
    await wait("× did not remove the recent search", async () => (await h2Search(page)).recent.join() === "checkout");
    await press(page, byTid(page, "search-recent", { words: "checkout" }).first());
    await wait("a press on a recent search did not search for it", async () => { const x = await h2Search(page); return x.field === "checkout" && x.state === "results"; });

    // typing: sections with counts, bold match, a board's chat "on <board>"
    v = await h2Search(page);
    if (v.sections.map((x) => `${x.section}:${x.count}`).join() !== "boards:1,chats:2,groups:1") bad(`the sections are ${J(v.sections)}, not boards:1 chats:2 groups:1`);
    const row = (id) => v.rows.find((r) => r.key === key(id));
    const b = row("b_flow"), a = row("c_audit"), d = row("c_flow"), g = row("g_checkout");
    if (!b || b.kind !== "board" || b.bold !== "Checkout" || b.sub !== "Studio Mac › Checkout service") bad(`the board result is ${J(b)}: "Checkout flow", "Checkout" bold, "Studio Mac › Checkout service"`);
    if (!a || a.bold !== "checkout" || a.sub !== "Studio Mac › Checkout service") bad(`the chat result is ${J(a)}: "checkout" bold, "Studio Mac › Checkout service"`);
    if (!d || d.sub !== "Studio Mac › on Checkout flow" || d.bold !== "checkout") bad(`the chat on a board is ${J(d)}: "Studio Mac › on Checkout flow"`);
    if (!g || g.kind !== "group" || !/^Studio Mac › ?.*·|^Studio Mac · /.test(g.sub) && !/^Studio Mac/.test(g.sub)) bad(`the group result is ${J(g)}`);
    if (v.rows.some((r) => r.height < 60)) bad(`a result is under 60 high: ${J(v.rows.map((r) => r.height))}`);
    if (v.rows.some((r) => r.stale || r.opacity < 1)) bad("a result of a live server is faded");
    await sweep(tidSel("search"), "the results");
    await shot("results");

    // the scope chips
    const scope = async (name, want) => {
      await press(page, byTid(page, "search-scope", { scope: name }).first());
      await wait(`the ${name} chip did not leave [${want}]`, async () => (await h2Search(page)).sections.map((x) => x.section).join() === want);
      const x = await h2Search(page);
      if (x.scope !== name || x.scopes.find((c) => c.selected)?.scope !== name) bad(`the ${name} chip did not become the selected one: ${J([x.scope, x.scopes])}`);
    };
    await scope("boards", "boards"); await scope("chats", "chats"); await scope("all", "boards,chats,groups");

    // a board's chat opens with its board under it
    await press(page, byTid(page, "search-row", { key: key("c_flow") }).first());
    if (await wait("a board chat's result did not open the chat", () => shown("chat-head"))) {
      const entries = await page.evaluate(() => window.__aiwbStack.entries());
      const kinds = entries.map((e) => `${e.route}`).join(" > ");
      if (!entries.some((e) => /board/.test(`${e.route}${e.key}`)) || entries.at(-1)?.route === entries[0]?.route && entries.length < 2) bad(`the stack is ${J(entries)}: a board chat opens with its board under it`);
      if (entries.length < 2 || !/board/.test(`${entries.at(-2)?.route}${entries.at(-2)?.key}`)) bad(`the screen under the chat is ${J(entries.at(-2))}, not its board (stack: ${kinds})`);
      if (await shown("search")) bad("the search is still open under the chat");
    }
    await toHome(page);
    await wait("the backs did not return to Home", async () => (await seen()).state === "list");

    // a group result shows that group's screen
    await openSearch(page, { wait, shown });
    await typeQuery(page, "checkout", wait);
    await press(page, byTid(page, "search-row", { kind: "group" }).first());
    await wait("a group result did not show the group's screen", async () => (await seen()).key === key("g_checkout"));
    if (await shown("search")) bad("the search stays open over the group's screen");
    // (a search that opened something is kept: the recent searches show it)
    await toHome(page);
    await openSearch(page, { wait, shown });
    v = await h2Search(page);
    if (v.recent[0] !== "checkout") bad(`the recent searches are ${J(v.recent)}: the word of the search that opened a result comes first`);
  }, { ls: lsOf([], RECENTS) });

  await scenario("search:none", async ({ page, wait, shown, bad, sweep, shot }) => {
    if (!await openSearch(page, { wait, shown })) return;
    await typeQuery(page, "kubernetes", wait);
    const v = await h2Search(page);
    if (v.state !== "none") bad(`the state is ${J(v.state)}, not "none"`);
    if (!v.none.includes("No boards or chats match “kubernetes”") || !v.none.includes("Searched Studio Mac.")) bad(`the answer is ${J(v.none)}, not 'No boards or chats match “kubernetes”' and "Searched Studio Mac."`);
    const btn = byTid(page, "search-new-chat").first();
    if ((await btn.innerText()).trim() !== "New chat “kubernetes”") bad(`the button says ${J(await btn.innerText())}`);
    await sweep(tidSel("search"), "the empty answer");
    await shot("none");
    await press(page, btn);
    if (await wait("New chat did not open a chat", () => shown("chat-head"))) {
      await wait("the new chat's draft is not the words searched for", async () => (await byTid(page, "composer-input").first().evaluate((e) => e.value ?? e.innerText)).trim() === "kubernetes");
    }
  });

  await scenario("search:kept", async ({ page, wait, shown, seen, bad }) => {
    if (!await openSearch(page, { wait, shown })) return;
    await typeQuery(page, "promo", wait);
    await press(page, byTid(page, "search-row", { key: key("c_regex") }).first());
    await wait("the result did not open", () => shown("chat-head"));
    await toHome(page);
    await wait("the back did not return to Home", async () => (await seen()).state === "list");
    await openSearch(page, { wait, shown });
    await sleep(400);
    const v = await h2Search(page);
    if (v.recent.join() !== "promo") bad(`after one search the recent searches are ${J(v.recent)}, not [promo]`);
    if (v.rows.map((r) => r.key).join() !== key("c_regex")) bad(`after opening a chat the recently opened are ${J(v.rows.map((r) => r.name))}, not [Regex for promo codes]`);
  });

  // a server that is away: its results stay, faded
  await scenario("search:away", async ({ page, wait, shown, seen, bad, shot, sweep }) => {
    await mockEval(`await uxh2Away(${J(STUDIO)});`, url);
    await wait("Home did not come to trouble", async () => (await seen()).state === "trouble");
    if (!await openSearch(page, { wait, shown })) return;
    await typeQuery(page, "checkout", wait);
    const v = await h2Search(page);
    if (v.rows.length !== 4) bad(`the faded search finds ${v.rows.length} results, not the 4 of the last sync`);
    for (const r of v.rows) {
      if (!r.stale || r.opacity > 0.6) bad(`the result ${r.name} is ${r.stale ? "" : "not "}stale with opacity ${r.opacity}`);
      if (!/^● Studio Mac · /.test(r.sub)) bad(`the faded result ${r.name} says ${J(r.sub)}, not "● Studio Mac · <its state>"`);
    }
    await shot("away");
    await press(page, byTid(page, "search-row", { key: key("b_flow") }).first());
    if (await wait("a press on a faded result shows no toast", () => shown("toast"))) {
      const t = await toastOf(page);
      if (!t.text.includes("Studio Mac is offline")) bad(`the toast says ${J(t.text)}`);
    }
    if (!await shown("search")) bad("a press on a faded result closed the search");
    if (await shown("chat-head") || await shown("board-bar")) bad("a press on a faded result opened something");
  });

  // ============================================================ dark
  await scenario("dark", async ({ page, wait, shown, seen, bad, dark }) => {
    await holdRow(page, homeRow(page, "c_flaky"));
    if (await wait("the row's sheet did not open", () => shown("row-sheet"))) {
      await sleep(500); await dark(tidSel("row-sheet"), "the row's sheet");
      await pressRow(page, "action-row", "rename");
      if (await wait("the rename sheet did not open", () => shown("rename-sheet"))) { await sleep(500); await dark(tidSel("rename-sheet"), "the rename sheet"); await press(page, byTid(page, "sheet-left").first()); await wait("Cancel did not close the rename sheet", async () => !(await shown("rename-sheet"))); }
    }
    await press(page, byTid(page, "home-new").first());
    if (await wait("the New sheet did not open", () => shown("home-new-sheet"))) { await sleep(500); await dark(tidSel("home-new-sheet"), "the New sheet"); await page.keyboard.press("Escape"); await wait("Esc did not close the New sheet", async () => !(await shown("home-new-sheet"))); }
    await press(page, byTid(page, "home-search").first());
    if (await wait("the search did not open", () => shown("search"))) { await sleep(400); await dark(tidSel("search"), "the search"); await searchField(page).fill("x"); /* (Cancel of an empty, focused field is unmounted by the blur a touch's compatibility mouse-down causes, before its click: search with a word typed) */ await press(page, byTid(page, "search-cancel").first()); await wait("Cancel did not close the search", async () => !(await shown("search"))); }
    if (await openArchived(page, { wait, shown })) { await sleep(400); await dark(tidSel("archived-screen"), "Archived"); }
  }, { theme: "dark" });

  note(`screenshots are in ${OUT}`);
}, { viewports, page: false });
