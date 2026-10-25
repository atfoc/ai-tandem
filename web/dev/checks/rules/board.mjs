// R1's recipes of the board (rules.mjs says what a recipe is): goal 3.4, 3.1.2, 4.4, 6.1, 6.2 and the mockups "01 Board", "Board states", "Chats sheet",
// "Point at", "Add selection" (the board's bar in each state, the bottom row, Excalidraw's menu trimmed, Clear, the Chats sheet, a board chat, the
// pick bar). One seed, UXB2: the board "Checkout flow" with five shapes (four labelled) and the chat "Draw the request flow" on it. Each recipe reaches
// the board by Home's own rows (sel.mjs `openBoard`) and goes on by presses, as UX.B1-board and UX.B2-pick do. The canvas is the board's: every board
// step has `rules: { canvas: true }` (nothing app-made over Excalidraw's canvas); a sheet, a confirm or a toast that is raised over the screen on
// purpose is allowed with the goal's reason; the docked orb (`voice-orb`) is the board's voice control (V1), and the voice card is read by rules/voice.mjs.
import { callMatcher, mockEval } from "../../shot.mjs";
import { back, byTid, openBoard, press, tidSel, touchDrag } from "../sel.mjs";
import { LIVE } from "../boarddraw.mjs";

const BOARD = "b_UXB2", CHAT = "c_UXB2", TITLE = "Checkout flow";
const READY = tidSel("board-canvas", { board: BOARD, state: "ready" });
const CANVAS = { canvas: true };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const J = JSON.stringify;

const UNDO_WRITER = `writer(${J(BOARD)}, ""); return 1;`;
const UNDO_ARCHIVE = `delete boards.${BOARD}.archived; delete boards.${BOARD}.archiveOp; send({ type: "board", board: boards.${BOARD} }); return 1;`;
const BUSY = `setSession(${J(CHAT)}, "main", { status: "tool", statusTool: "Bash" }); return 1;`;
const UNDO_DRAFT = `${UNDO_WRITER.replace("return 1;", "")} setSession(${J(CHAT)}, "main", { draft: undefined }); return 1;`;
const UNDO_BUSY = `setSession(${J(CHAT)}, "main", { status: "ready", statusTool: undefined }); return 1;`;

// ---- what the goal draws over the canvas on purpose, and what is V1's
const SHEET = { rule: "canvas", match: /toast/, why: "goal 3.4: another window taking the board is said by a toast with Edit here; it goes away" };
const PICK = { rule: "canvas", match: /pick-border|pick-pin/, why: "goal 3.4: the accent border of a wait and its 600 ms pin are drawn over the board by the goal" };

// ---- the board, in the page
/** The board by Home's rows, and its canvas drawn. */
async function goBoard(page) {
  await openBoard(page, BOARD);
  await page.waitForSelector(READY, { timeout: 20000 });
}
const barWord = (page) => byTid(page, "board-bar").locator(tidSel("state-word")).first();
/** The state word on the bar must be `key` saying `text` (a string, or a pattern). */
async function wordIs(page, h, what, key, text) {
  const w = barWord(page);
  await w.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const got = await w.getAttribute("data-word").catch(() => null), said = ((await w.innerText().catch(() => "")) ?? "").trim();
  if (got !== key) h.fail(`${what}: the bar's state word is ${J(got)}, not ${J(key)}`);
  else if (typeof text === "string" ? said !== text : !text.test(said)) h.fail(`${what}: the bar's state word says ${J(said)}, not ${text}`);
}
const rectOf = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; });
const view = (page) => page.evaluate(() => window.__aiwbView?.() ?? null);
const settled = async (page) => { // (the view has stopped moving)
  let last = J(await view(page));
  for (let i = 0; i < 20; i++) { await sleep(250); const now = J(await view(page)); if (now === last) return; last = now; }
};
/** The page point of a shape's middle (the canvas, the board's view and the scene's coordinates). */
async function where(page, id) {
  const v = await view(page), c = await page.locator(".excalidraw canvas.interactive").first().boundingBox();
  const e = await mockEval(`return scenes[${J(BOARD)}].scene.elements.find((x) => x.id === ${J(id)});`, page.__url);
  return { x: c.x + (e.x + e.width / 2 + v.scrollX) * v.zoom, y: c.y + (e.y + e.height / 2 + v.scrollY) * v.zoom };
}
/** Edit here, pressed and waited for (the writer's signs: the button gone and the canvas that can be drawn on). */
async function toEdit(page) {
  const take = byTid(page, "board-take").first();
  await take.waitFor({ state: "visible", timeout: 20000 });
  await press(page, take);
  await page.waitForSelector(LIVE, { timeout: 20000 });
  await take.waitFor({ state: "detached", timeout: 20000 });
}
/** Selects exactly the two shapes with Excalidraw's own tools: a tap on the first, the shift key and a click on the second. */
async function selectTwo(page, a, b) {
  const A = await where(page, a), B = await where(page, b);
  await page.touchscreen.tap(A.x, A.y);
  await sleep(250);
  await page.keyboard.down("Shift");
  await page.mouse.click(B.x, B.y);
  await page.keyboard.up("Shift");
  await sleep(400);
}

// ---- Excalidraw's menu (its DOM: the walker skips its controls)
const TRIGGER = '[data-testid="main-menu-trigger"]', MENU = ".dropdown-menu";
async function openMenu(page) {
  await press(page, page.locator(TRIGGER).first());
  await page.locator(MENU).first().waitFor({ state: "visible", timeout: 15000 });
  await sleep(300);
}
async function closeMenu(page) { // (a press on the menu's button again closes it)
  if (await page.locator(MENU).count()) await press(page, page.locator(TRIGGER).first());
  await page.locator(MENU).first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
}
const readMenu = (page) => page.evaluate(() => {
  const m = document.querySelector(".dropdown-menu"), c = m.querySelector(".dropdown-menu-container");
  return { title: m.querySelector(".dropdown-menu-group-title")?.textContent.trim() ?? null,
    items: [...m.querySelectorAll(".dropdown-menu-item")].map((e) => ({ text: e.querySelector(".dropdown-menu-item__text")?.textContent.trim() ?? e.textContent.trim(), tid: e.dataset.testid ?? "", colour: getComputedStyle(e.querySelector(".dropdown-menu-item__text") ?? e).color })),
    kids: [...c.children].map((k) => ({ group: k.classList.contains("dropdown-menu-group"), own: k.classList.contains("dropdown-menu-item") ? k.textContent.trim() : null })) };
});
/** Every row of the menu is reached by a finger: not under the bottom row (`board-row`) nor under anything of the app: the docked orb and the voice card are the app's, and a menu row they cover is a finding. */
const menuCovered = (page) => page.evaluate(() => {
  const row = document.querySelector('[data-testid="board-row"]'), top = row ? row.getBoundingClientRect().top : innerHeight;
  return [...document.querySelectorAll(".dropdown-menu .dropdown-menu-item")].map((e) => {
    const r = e.getBoundingClientRect(), at = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + r.height / 2, innerHeight - 1));
    const ok = !!at && (e === at || e.contains(at));
    const by = !ok ? (at?.closest('[data-testid="voice-orb"], [data-testid="voice-card"]')?.dataset.testid ?? null) : null;
    return { text: e.textContent.trim(), under: r.bottom > top + 0.5, covered: !ok, by };
  }).filter((x) => x.under || x.covered);
});
async function checkMenu(page, h, who, want) {
  const m = await readMenu(page);
  const texts = m.items.map((i) => i.text);
  if (m.title !== TITLE) h.fail(`${who}'s menu: its group is titled ${J(m.title)}, not the board's name ${J(TITLE)}`);
  if (texts.join("|") !== want.join("|")) h.fail(`${who}'s menu offers [${texts.join(", ")}], not [${want.join(", ")}]`);
  for (const c of await menuCovered(page)) h.fail(`${who}'s menu: the row ${J(c.text)} is ${c.under ? "under the bottom row" : c.by ? `covered by the ${c.by}` : "covered by something of the app"}`);
  return m;
}
const redOf = (css) => { const m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/.exec(css); if (!m) return false; const [r, g, b] = [+m[1], +m[2], +m[3]]; return r > 140 && r > g * 1.35 && r > b * 1.15; };

const READER_MENU = ["Find on the board", "Fit the whole board", "Export image…", "Share image…"];

// ---- the chat on the board
const input = (page) => byTid(page, "composer-input").first();
const boxText = (page) => input(page).evaluate((e) => (e.value ?? e.innerText ?? e.textContent ?? "").replace(/[​ ]/g, " ").replace(/\n$/, ""));
/** The chat of the board by the Chats button and the sheet's row. */
async function openChatFromSheet(page, chat = CHAT) {
  await press(page, byTid(page, "board-chats").first());
  await byTid(page, "chats-sheet").first().waitFor({ state: "visible", timeout: 15000 });
  await sleep(500); // (the sheet rises)
  await press(page, byTid(page, "chats-row", { chat }).first());
  await byTid(page, "chat-head").first().waitFor({ state: "visible", timeout: 15000 });
  await input(page).waitFor({ state: "visible", timeout: 15000 });
}
async function typeDraft(page, text) {
  await press(page, input(page));
  await page.waitForFunction(() => document.activeElement?.dataset?.testid === "composer-input", null, { timeout: 15000 });
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text);
}
async function plusRow(page, action) {
  await press(page, byTid(page, "composer-plus").first());
  const row = byTid(page, "action-row", { action }).first();
  await row.waitFor({ state: "visible", timeout: 15000 });
  await press(page, row);
}
const chips = (page, kind) => byTid(page, "ctx-chip", { kind });
/** What a chat's draft holds of the board, wherever it is kept: a point or a selection is a tag in the draft's text (`<point …>`, `<selection ids=…>`; the chip is
 *  drawn from it) and a quote of an item is a `references` entry. Read in the page's storage (`aiwb.draft.<chat>:<branch>`) and in the mock's copy of the draft. */
async function draftRefs(page, h) {
  const count = (d) => ((d?.references ?? []).length) + (String(d?.text ?? "").match(/<(point|selection)\b/g) ?? []).length;
  const own = await page.evaluate(([chat, src]) => { const count = new Function("d", src);
    return Object.entries(localStorage).filter(([k]) => k.startsWith("aiwb.draft.") && k.includes(chat)).map(([k, v]) => { try { return { k, refs: count(JSON.parse(v)) }; } catch { return { k, refs: -1 }; } }); },
    [CHAT, `return (${count.toString()})(d);`]);
  const server = await mockEval(`const d = chats[${J(CHAT)}]?.draft; return ((d?.references ?? []).length) + (String(d?.text ?? "").match(/<(point|selection)\\b/g) ?? []).length;`, h.url);
  return { own, server };
}

export const recipes = [
  // ---- the bar, the bottom row, the menu of a reader
  { id: "board.reader", goal: "3.4 · 01 Board (a reader)", seed: ["UXB2"],
    steps: [
      { name: "view-only", rules: CANVAS, allow: [],
        go: async (page, h) => { page.__url = h.url; await goBoard(page); },
        check: async (page, h) => {
          const bar = byTid(page, "board-bar"), back = bar.locator(tidSel("nav-back")).first();
          if ((await back.getAttribute("aria-label")) !== "Back" || ((await back.innerText()) ?? "").trim() !== "") h.fail(`the bar's back control is ${J(await back.innerText())} (label ${await back.getAttribute("aria-label")}): the chevron alone, named "Back"`);
          const title = ((await bar.locator(tidSel("bar-title")).first().innerText()) ?? "").trim();
          if (title !== TITLE) h.fail(`the bar's title is ${J(title)}, not ${J(TITLE)}`);
          await wordIs(page, h, "a reader", "view", "View only");
          for (const id of ["board-role", "board-editing", "presence", "canvas-note"]) if (await byTid(page, id).count()) h.fail(`${id} (a part of the wide layouts) is drawn over the phone's canvas`);
          const take = byTid(page, "board-take");
          if ((await take.count()) !== 1 || ((await take.innerText()) ?? "").trim() !== "Edit here") h.fail("a reader's bottom row has no single \"Edit here\"");
        } },
      { name: "menu", rules: CANVAS, allow: [SHEET], ready: MENU,
        go: async (page) => { await openMenu(page); },
        check: async (page, h) => {
          const m = await checkMenu(page, h, "a reader", READER_MENU);
          if (m.kids.some((k) => !k.group && !k.own)) h.fail("a reader's menu has a separator: it has nothing below the group");
        } },
      { name: "chats-sheet", rules: CANVAS, allow: [SHEET], ready: tidSel("chats-sheet"),
        go: async (page) => { await closeMenu(page); await press(page, byTid(page, "board-chats").first()); await sleep(500); },
        check: async (page, h) => {
          const sheet = byTid(page, "chats-sheet"), text = await sheet.innerText();
          if (!text.includes(`Chats on “${TITLE}”`)) h.fail(`the sheet's title is not Chats on “${TITLE}”: ${J(text.slice(0, 60))}`);
          const first = await sheet.locator('[data-testid="chats-new"], [data-testid="chats-row"]').first().getAttribute("data-testid");
          if (first !== "chats-new") h.fail(`the first row of the sheet is ${first}, not chats-new ("New chat on this board")`);
          for (const r of await byTid(page, "chats-row").all()) { const b = await rectOf(r); if (b.h < 43.5) h.fail(`a chat row of the sheet is ${b.h} pt high`); }
        } },
      { name: "edge-swipe", rules: CANVAS, allow: [],
        go: async (page) => { // (the sheet of the step before is closed by a tap outside it, as a person closes it)
          await page.touchscreen.tap(190, 150);
          await byTid(page, "chats-sheet").first().waitFor({ state: "detached", timeout: 5000 });
        },
        check: async (page, h) => {
          const bar = byTid(page, "board-bar");
          // a swipe from the left edge is the canvas's own pan, not Back (goal 3.1.2)
          const box = await page.locator(".excalidraw canvas.interactive").first().boundingBox();
          const y = box.y + box.height * 0.5;
          await touchDrag(page, { x: 3, y }, { x: Math.min(box.x + box.width - 8, 260), y }, { hold: 0, steps: 10 });
          await sleep(500);
          if (!(await bar.first().isVisible().catch(() => false))) h.fail("a swipe from the left edge of the board left it: the canvas needs its pans (goal 3.1.2)");
        } },
    ] },

  // ---- Edit here: taking, editing, the menu of the holder, Clear, the footer with shapes selected, a board another window took
  { id: "board.holder", goal: "3.4 · 02 Board states (Taking over, Editing, another window)", seed: ["UXB2"], undo: UNDO_WRITER,
    steps: [
      { name: "taking-over", rules: CANVAS, allow: [],
        go: async (page, h) => {
          page.__url = h.url;
          await goBoard(page);
          // the server answers the take "waiting" (the window that holds the board was asked to hand it over): "Taking over…" until `held` comes
          await page.route(callMatcher(new RegExp(`^POST .*/boards/${BOARD}/take`)), (route) => route.fulfill({ status: 200, contentType: "application/json", body: J({ state: "waiting" }) }));
          await press(page, byTid(page, "board-take").first());
        },
        ready: tidSel("board-take", { taking: "true" }),
        check: async (page, h) => {
          await wordIs(page, h, "a take on its way", "taking", "Taking over…");
          if (((await byTid(page, "board-take").innerText()) ?? "").trim() !== "Taking over…") h.fail("the button of a take on its way does not read \"Taking over…\"");
        } },
      { name: "editing", rules: CANVAS, allow: [],
        go: async (page, h) => {
          await page.unroute(callMatcher(new RegExp(`^POST .*/boards/${BOARD}/take`))).catch(() => {});
          await mockEval(`heldBoards.add(${J(BOARD)}); send({ type: "held", board: ${J(BOARD)}, rev: 1 }); return 1;`, h.url);
          await page.waitForSelector(LIVE, { timeout: 20000 });
        },
        check: async (page, h) => {
          await wordIs(page, h, "the holder", "editing", "Editing");
          if (await byTid(page, "board-take").count()) h.fail("the holder's bottom row has an Edit here");
          if (!(await byTid(page, "board-row").count())) h.fail("the holder's board has no bottom row");
        } },
      { name: "menu", rules: CANVAS, allow: [SHEET], ready: MENU,
        go: async (page) => { await openMenu(page); },
        check: async (page, h) => {
          const m = await checkMenu(page, h, "the holder", [...READER_MENU, "Clear the board…"]);
          const last = m.items.at(-1);
          if (m.kids.length !== 3 || m.kids[1].group || m.kids[1].own || m.kids[2].own !== "Clear the board…") h.fail(`the holder's menu is not the group, a separator, "Clear the board…" last (${J(m.kids)})`);
          if (!redOf(last?.colour)) h.fail(`"Clear the board…" is not drawn red (${last?.colour})`);
        } },
      { name: "clear-confirm", rules: CANVAS, allow: [SHEET], ready: tidSel("confirm-title"),
        go: async (page) => { await press(page, byTid(page, "phone-menu-clear").first()); await sleep(500); },
        check: async (page, h) => {
          const title = ((await byTid(page, "confirm-title").first().innerText()) ?? "").trim();
          if (title !== `Clear “${TITLE}”?`) h.fail(`the confirm is titled ${J(title)}, not Clear “${TITLE}”?`);
          const go = byTid(page, "confirm-go").first();
          if (((await go.innerText()) ?? "").trim() !== "Clear the board") h.fail(`the confirm's button reads ${J(await go.innerText())}, not "Clear the board"`);
          const bg = await go.evaluate((e) => { for (let x = e; x; x = x.parentElement) { const c = getComputedStyle(x).backgroundColor; if (!/rgba?\(\s*\d+,\s*\d+,\s*\d+,\s*0\)/.test(c) && c !== "transparent") return c; } return ""; });
          if (!redOf(bg)) h.fail(`the confirm's "Clear the board" is not red (${bg})`);
        } },
      { name: "footer-selected", rules: CANVAS, allow: [],
        go: async (page) => {
          await press(page, byTid(page, "confirm-cancel").first());
          await byTid(page, "confirm-dialog").first().waitFor({ state: "detached", timeout: 10000 });
          await page.mouse.click(60, page.viewportSize().height * 0.45); // (an empty place: the canvas takes the keys)
          await page.keyboard.press("ControlOrMeta+a");
          await page.locator('.App-bottom-bar [aria-label="Duplicate"]').first().waitFor({ state: "visible", timeout: 15000 });
          await sleep(700);
        },
        check: async (page, h) => { // no control of Excalidraw's footer lies under the app's bottom row
          const R = await rectOf(byTid(page, "board-row"));
          const hits = await page.evaluate(([x0, x1, y0, y1]) => [...document.querySelectorAll(".App-bottom-bar button, .App-bottom-bar input, .App-bottom-bar [role=button], .App-bottom-bar label")].map((e) => {
            const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
            return { name: (e.getAttribute("aria-label") || e.dataset.testid || e.textContent || e.tagName).trim().slice(0, 30), x: r.x, right: r.right, y: r.y, bottom: r.bottom, seen: cs.visibility !== "hidden" && cs.display !== "none" && r.width > 0 && r.height > 0 };
          }).filter((c) => c.seen && c.x < x1 - 0.5 && c.right > x0 + 0.5 && c.y < y1 - 0.5 && c.bottom > y0 + 0.5), [R.x, R.right, R.y, R.bottom]);
          for (const c of hits) h.fail(`a control of Excalidraw's footer (${J(c.name)}) lies under the bottom row`);
        } },
      { name: "another-window", rules: CANVAS, allow: [SHEET],
        go: async (page, h) => { await page.keyboard.press("Escape"); await mockEval(`writer(${J(BOARD)}, "window"); return 1;`, h.url); },
        ready: tidSel("toast", { kind: "board-lost" }),
        check: async (page, h) => {
          await wordIs(page, h, "a board another window holds", "taken", "Another window is editing");
          if (!/Edit here/.test((await byTid(page, "toast-action").first().textContent().catch(() => "")) ?? "")) h.fail("the toast of the lost board has no Edit here action");
          if (!(await byTid(page, "board-take").count())) h.fail("the window that lost the board has no Edit here in its bottom row");
        } },
    ] },

  // ---- an agent is working on the board
  { id: "board.working", goal: "3.4 · 02 Board states (Claude is working…)", seed: ["UXB2"], mock: BUSY, undo: UNDO_BUSY,
    steps: [
      { name: "working", rules: CANVAS, allow: [],
        go: async (page) => { await goBoard(page); },
        check: async (page, h) => {
          await wordIs(page, h, "a chat at work", "working", /^\S+ is working…$/);
          const chats = byTid(page, "board-chats");
          if ((await chats.getAttribute("data-busy")) !== "true") h.fail("the Chats button of a board with a chat at work is not busy");
        } },
    ] },

  // ---- an archived board: read-only (opened by the selection: an archived board is not in Home's list)
  { id: "board.archived", goal: "3.4 · 02 Board states (Archived · read-only)", seed: ["UXB2"], undo: UNDO_ARCHIVE,
    sel: { board: BOARD, chat: null }, wait: READY,
    prepare: async (h) => { await h.mockEval(`boards.${BOARD}.archived = true; boards.${BOARD}.archiveOp = "op_r1_board"; return 1;`); },
    steps: [
      { name: "archived", rules: CANVAS, allow: [],
        check: async (page, h) => {
          await wordIs(page, h, "an archived board", "archived", "Archived · read-only");
          await sleep(400);
          if (await byTid(page, "board-take").count()) h.fail("an archived board has an Edit here button");
        } },
      { name: "chats-sheet", rules: CANVAS, allow: [SHEET], ready: tidSel("chats-sheet"),
        go: async (page) => { await press(page, byTid(page, "board-chats").first()); await sleep(500); },
        check: async (page, h) => { if (await byTid(page, "chats-new").count()) h.fail("the Chats sheet of an archived board offers New chat on this board"); } },
    ] },

  // ---- the Chats sheet, a board chat full screen, New chat from the sheet
  { id: "board.chats", goal: "3.4 · 03 Chats sheet, 04 A board chat", seed: ["UXB2"],
    steps: [
      { name: "chats-sheet", rules: CANVAS, allow: [SHEET], ready: tidSel("chats-sheet"),
        go: async (page, h) => { page.__url = h.url; await goBoard(page); await press(page, byTid(page, "board-chats").first()); await sleep(500); },
        check: async (page, h) => {
          const sheet = byTid(page, "chats-sheet");
          if (!(await sheet.innerText()).includes(`Chats on “${TITLE}”`)) h.fail(`the sheet's title is not Chats on “${TITLE}”`);
          const first = await sheet.locator('[data-testid="chats-new"], [data-testid="chats-row"]').first().getAttribute("data-testid");
          if (first !== "chats-new") h.fail(`the sheet's first row is ${first}, not chats-new`);
          for (const r of await byTid(page, "chats-row").all()) { const b = await rectOf(r); if (b.h < 43.5) h.fail(`a chat row is ${b.h} pt high`); }
        } },
      { name: "board-chat", ready: tidSel("composer-input"),
        go: async (page) => { await press(page, byTid(page, "chats-row", { chat: CHAT }).first()); await byTid(page, "chat-head").first().waitFor({ state: "visible", timeout: 15000 }); },
        check: async (page, h) => {
          const head = byTid(page, "chat-head").first(), bk = head.locator(tidSel("nav-back")).first();
          if (!(await bk.count()) || ((await bk.innerText()) ?? "").trim() !== "") h.fail("the chat's back is not the chevron alone");
          const text = ((await head.innerText()) ?? "").replace(/\s+/g, " ");
          if (!text.includes("Draw the request flow")) h.fail(`the chat's bar does not say its name: ${J(text)}`);
          if (!new RegExp(`\\S+ · on ${TITLE}`).test(text)) h.fail(`the chat's bar does not say "<agent> · on ${TITLE}": ${J(text)}`);
          if (await byTid(page, "board-bar").last().isVisible().catch(() => false)) h.fail("the board's bar is on screen over the chat that is full screen");
        } },
      { name: "new-chat", ready: tidSel("composer-input"),
        go: async (page) => {
          await back(page);
          await page.waitForSelector(READY, { timeout: 20000 });
          await press(page, byTid(page, "board-chats").first());
          await byTid(page, "chats-new").first().waitFor({ state: "visible", timeout: 15000 });
          await sleep(500);
          await press(page, byTid(page, "chats-new").first());
          await byTid(page, "chat-head").first().waitFor({ state: "visible", timeout: 15000 });
        },
        check: async (page, h) => {
          const text = ((await byTid(page, "chat-head").first().innerText()) ?? "").replace(/\s+/g, " ");
          if (!new RegExp(`on ${TITLE}`).test(text)) h.fail(`a new chat from the sheet does not say "on ${TITLE}": ${J(text)}`);
          if (await byTid(page, "msg").count()) h.fail("a new chat from the sheet is not empty");
        } },
    ] },

  // ---- Back from a board chat lands on the board at the view it was left in
  { id: "board.view", goal: "3.4 · back from a board chat; 3.1.2", seed: ["UXB2"],
    steps: (() => {
      const kept = {};
      return [
        { name: "panned-and-zoomed", rules: CANVAS, allow: [],
          go: async (page, h) => {
            page.__url = h.url;
            await goBoard(page);
            await settled(page);
            const v0 = await view(page), box = await page.locator(".excalidraw canvas.interactive").first().boundingBox();
            const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            await touchDrag(page, c, { x: c.x - 70, y: c.y - 110 }, { hold: 0, steps: 10 });
            await page.mouse.move(c.x, c.y);
            await page.keyboard.down("Control"); await page.mouse.wheel(0, -300); await page.keyboard.up("Control");
            await settled(page);
            kept.before = await view(page);
            if (!v0 || !kept.before || (Math.abs(kept.before.scrollX - v0.scrollX) < 1 && Math.abs(kept.before.scrollY - v0.scrollY) < 1 && Math.abs(kept.before.zoom - v0.zoom) < 0.01)) throw new Error("the view did not move when it was panned and zoomed: the recipe cannot tell where it was left");
            await sleep(800); // (the app keeps the view once it has been still for 400 ms)
          } },
        { name: "chat", ready: tidSel("composer-input"), go: async (page) => { await openChatFromSheet(page); } },
        { name: "back-on-the-board", rules: CANVAS, allow: [],
          go: async (page) => { await back(page); await page.waitForSelector(READY, { timeout: 20000 }); await settled(page); },
          check: async (page, h) => {
            const now = await view(page), was = kept.before;
            if (!now || !was) return h.fail("no view of the board after the chat's back");
            if (Math.abs(now.scrollX - was.scrollX) > 1 || Math.abs(now.scrollY - was.scrollY) > 1 || Math.abs(now.zoom - was.zoom) > 0.01)
              h.fail(`back from the board's chat lands at ${J({ x: now.scrollX, y: now.scrollY, z: now.zoom })}, not where the board was left ${J({ x: was.scrollX, y: was.scrollY, z: was.zoom })}`);
          } },
      ];
    })() },

  // ---- Point at and Add selection
  { id: "board.pick", goal: "3.4 · 05 Point at, 06 Add selection", seed: ["UXB2"], undo: UNDO_DRAFT,
    steps: [
      { name: "chat-with-a-draft", ready: tidSel("composer-input"),
        go: async (page, h) => { page.__url = h.url; await goBoard(page); await openChatFromSheet(page); await typeDraft(page, "first second"); } },
      { name: "point-at", rules: CANVAS, allow: [PICK], ready: tidSel("pick-bar"),
        go: async (page) => { await plusRow(page, "point"); await page.waitForSelector(READY, { timeout: 20000 }); await sleep(600); },
        check: async (page, h) => {
          const bar = byTid(page, "pick-bar").first(), text = ((await bar.innerText()) ?? "").replace(/\s+/g, " ");
          if ((await bar.getAttribute("data-kind")) !== "point" || !text.includes("Tap a spot on the board")) h.fail(`the pick bar is ${J(text)}: not "Tap a spot on the board"`);
          await wordIs(page, h, "Point at", "picking", "Picking a point");
          const chats = byTid(page, "board-chats").first();
          if (!((await chats.getAttribute("aria-disabled")) === "true" || (await chats.getAttribute("disabled")) !== null || (await chats.getAttribute("data-off")) === "true")) h.fail("while a point is picked the Chats button is not dimmed and disabled");
          if (!(await byTid(page, "pick-border").count())) h.fail("the canvas has no accent border while a point is picked");
          if (await byTid(page, "board-row").count()) h.fail("the bottom row is drawn while a point is picked");
        } },
      { name: "back-cancels-the-pick", ready: tidSel("composer-input"),
        go: async (page) => { if (!(await back(page))) throw new Error("the pick bar has no back"); },
        check: async (page, h) => {
          await sleep(500);
          if ((await boxText(page)) !== "first second") h.fail(`Back from Point at left the box reading ${J(await boxText(page))}, not the draft "first second"`);
          if (await chips(page, "point").count()) h.fail("Back from Point at put a point chip into the chat");
          const st = await page.evaluate(() => window.__aiwbPick?.state?.() ?? null);
          if (st?.picking) h.fail(`Back from Point at left the wait on (${J(st)})`);
        } },
      { name: "point-chip", ready: tidSel("ctx-chip", { kind: "point" }),
        go: async (page) => {
          await plusRow(page, "point");
          await byTid(page, "pick-bar").first().waitFor({ state: "visible", timeout: 15000 });
          await page.waitForSelector(READY, { timeout: 20000 });
          await sleep(600);
          const p = await where(page, "uxb2_payments");
          await page.touchscreen.tap(p.x, p.y);
          await byTid(page, "composer-input").first().waitFor({ state: "visible", timeout: 15000 });
        },
        check: async (page, h) => {
          const text = ((await chips(page, "point").first().innerText()) ?? "").replace(/\s+/g, " ").trim();
          if (text !== "Point near Payments") h.fail(`the point chip reads ${J(text)}, not "Point near Payments"`);
        } },
      { name: "add-selection-reader", rules: CANVAS, allow: [PICK], ready: tidSel("pick-bar", { kind: "select" }),
        go: async (page) => { await plusRow(page, "selection"); await page.waitForSelector(READY, { timeout: 20000 }); },
        check: async (page, h) => {
          const text = ((await byTid(page, "pick-bar").first().innerText()) ?? "").replace(/\s+/g, " ");
          if (!text.includes("Select items")) h.fail(`the pick bar of Add selection is ${J(text)}, not "Select items"`);
          await wordIs(page, h, "Add selection", "selecting", "Selecting for the chat");
          if (((await byTid(page, "pick-take").first().innerText().catch(() => "")) ?? "").trim() !== "Edit here") h.fail("a reader's pick bar has no Edit here");
          if (await byTid(page, "pick-add").count()) h.fail("a reader's pick bar has an Add before Edit here");
        } },
      { name: "add-selection-none-selected", rules: CANVAS, allow: [PICK], ready: tidSel("pick-add"),
        go: async (page) => { await press(page, byTid(page, "pick-take").first()); await page.waitForSelector(LIVE, { timeout: 20000 }); await sleep(400); },
        check: async (page, h) => {
          const add = byTid(page, "pick-add").first();
          if (((await add.innerText()) ?? "").trim() !== "Add (0)" || ((await add.getAttribute("aria-disabled")) !== "true" && (await add.getAttribute("disabled")) === null)) h.fail("with nothing selected the pick bar's button is not a disabled \"Add (0)\"");
        } },
      { name: "add-selection-two", rules: CANVAS, allow: [PICK],
        go: async (page) => {
          await selectTwo(page, "uxb2_payments", "uxb2_inventory");
          await byTid(page, "pick-add").first().waitFor({ state: "visible", timeout: 5000 });
          await page.waitForFunction(() => /Add \(2\)/.test(document.querySelector('[data-testid="pick-add"]')?.textContent ?? ""), null, { timeout: 8000 });
        },
        check: async (page, h) => { if ((await byTid(page, "pick-add").first().getAttribute("aria-disabled")) === "true") h.fail("Add (2) is disabled"); } },
      { name: "selection-chip", ready: tidSel("ctx-chip", { kind: "selection" }),
        go: async (page) => { await press(page, byTid(page, "pick-add").first()); await byTid(page, "composer-input").first().waitFor({ state: "visible", timeout: 15000 }); },
        check: async (page, h) => {
          const text = ((await chips(page, "selection").first().innerText()) ?? "").replace(/\s+/g, " ").trim();
          if (text !== "2 shapes · Payments, Inventory") h.fail(`the selection chip reads ${J(text)}, not "2 shapes · Payments, Inventory"`);
        } },
    ] },

  // ---- a selection on the board goes to no chat by itself (goal 3.4, 6.2)
  { id: "board.selection-rule", goal: "3.4 · a selection on the board goes to no chat by itself", seed: ["UXB2"], undo: UNDO_WRITER,
    steps: [
      { name: "two-selected-on-the-board", rules: CANVAS, allow: [],
        go: async (page, h) => { page.__url = h.url; await goBoard(page); await toEdit(page); await sleep(400); await selectTwo(page, "uxb2_payments", "uxb2_inventory"); } },
      { name: "the-chat-has-nothing", ready: tidSel("composer-input"),
        go: async (page) => { await openChatFromSheet(page); await sleep(500); },
        check: async (page, h) => {
          if (await chips(page, "selection").count()) h.fail("two shapes are selected on the board and the board's chat has a selection chip");
          if (await byTid(page, "ctx-act").count()) h.fail("the board's chat offers \"Add N selected\" (ctx-act) while shapes are selected on the board");
          if (await byTid(page, "composer-input").locator(tidSel("ref-chip")).count()) h.fail("the composer's box holds a reference for the shapes selected on the board");
          const row = ((await byTid(page, "context-row").first().innerText().catch(() => "")) ?? "");
          if (/selected/i.test(row)) h.fail(`the chat's context row says ${J(row)} while shapes are selected on the board`);
          const refs = await draftRefs(page, h);
          if (refs.server !== 0 || refs.own.some((d) => d.refs !== 0)) h.fail(`the draft refs of the chat are not empty: ${J(refs)}`);
        } },
    ] },

];
