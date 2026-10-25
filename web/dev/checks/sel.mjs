// The selector and navigation helpers of the browser checks of the new build (AD-80). A check of dev/checks imports from
// here what the checks of the retired page did with class names and the paths of one layout; README.md of this folder says how to write a check.
//
//   tidSel(id, data?)            the CSS selector of `testID` id, with the `dataSet` values (data-<key>="…") given
//   byTid(root, id, data?)       the locator of those elements under root (a page or a locator); tell a list of the same
//                                thing apart by `data`, by .filter({ hasText }) or by .nth()
//   layoutNow(page)              "phone" | "tablet" | "desktop": the layout the window's width gives now (it follows a resize)
//   touchNow(page)               whether the page has a finger and no mouse
//   press(page, locator, opts?)  a click with a mouse, a tap with a finger (tap and click are the same call in a check)
//   hover(page, locator)         the pointer over it; nothing on a touch viewport, which has no hover
//   longPress(page, locator, { ms })   a finger held on it (a touch viewport; a mouse held on the desktop)
//   hold(page, locator, { ms, until })   a finger held on it and taken off by a cancel, as the system does when a sheet opens under it (a
//                                release would press the sheet's backdrop where the finger was, and close it): for a long press that opens a sheet
//   openChat(page, key, { timeout }), openBoard(...)   open that chat or board by its key (the selection key the seeds have:
//                                "c_plain", "s_studio~c_plain") through the path of the layout, and wait for it to show. On the phone
//                                that is Home's path (package H1): the thing's server chosen by its chip, its groups pushed one by
//                                one, its row pressed; a chat on a board through its board and the board's Chats
//   showHome(page, server?)      the phone's Home on screen (back through the stack), showing `server` (an entry id) when given
//   openFoot(page, id)           a control of the sidebar's foot ("servers-btn", "library-btn", "settings-btn", "theme-btn",
//                                "side-archived"): pressed in the foot on the wide layouts, through Home's gear and
//                                Settings' row for it on the phone (Servers, Library, Voice, Archived; Appearance for "theme-btn")
//   back(page)                   the stack's back on the phone (true when there was one); nothing on the wide layouts (false)
//   openMenu(page, target, ...items)   press a button (its testID, or a locator), wait for the menu it opens, press the
//                                items named, each in the menu the one before opened; answers the menu left open, if any
//   pointerDragger(page)         a drag by the pointer of the viewport, step by step: start(from), move(to), end(), cancel()
//   mouseDrag, touchDrag, dragTo(page, from, to)   the same in one call (from and to: a locator or a point)
//   act(page, what)              what a seeded state asks the page to do first (the `act` of dev/mock-ui.js): "drop:<entry id>",
//                                and the ones the packages add to `acts`
//
// These assume the testIDs of IDS below, which the screens of Track S draw. The first package that draws one of them
// checks it matches; a screen that names it otherwise changes IDS here, in the same commit. The check dev/checks/L0-harness.mjs
// proves the helpers against a stand-in page that draws the contract at the three layouts.
import { dropped, mockEval, until } from "../shot.mjs";
import { layoutOfWidth } from "../viewports.mjs";

/** The testIDs the navigation helpers use, and the `dataSet` keys they read. */
export const IDS = {
  tree: "side-tree",              // the sidebar's tree (the wide layouts; the phone has Home instead)
  row: "side-row",                // a row of a chat or a board: dataSet { kind: "chat" | "board", key }; aria-selected="true" when it is the open one (the wide layouts)
  home: "home",                   // the phone's Home (H1): dataSet { server: the entry id it shows, state: "first-run" | "connecting" | "trouble" | "empty" | "list" }
  homeRow: "home-row",            // a row of Home or a group screen: dataSet { kind: "group" | "board" | "chat", key, server, attention, count }
  chip: "server-chip",            // a server chip of Home: dataSet { server, word, selected: "true" | "false" }
  groupScreen: "group-screen",    // a group pushed as a screen: dataSet { key }
  gear: "home-gear",              // Home's gear (Settings)
  chatsSheet: "chats-sheet",      // a board's Chats sheet (B1): rows "chats-row" with dataSet { chat, voice }
  chatsSheetRow: "chats-row",
  show: "side-show",              // the control that shows a hidden sidebar (the wide layouts)
  back: "nav-back",               // the stack's back button (the phone)
  chatHead: "chat-head",          // the header of an open chat (all layouts)
  thread: "thread",               // the open chat's thread (its rows are drawn once its list is here; a "wait-line" with dataSet wait "load" stands in for them until then)
  boardBar: "board-bar",          // the bar of an open board (all layouts)
  sectionState: "side-section-state", // a section's state: dataSet { server, tone: "ok" | "wait" | "bad" }
  menu: "menu",                   // a menu (ui/Menu, in a popover or a sheet)
  menuItem: "menu-item",          // its items (told apart by text)
  backdrop: "overlay-backdrop",
};

const WAIT = 15000;
const SETTLE = 4000; // (what a menu's pick has to show by: a few frames, with the room of a machine four times slower)
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const attr = (k) => k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()); // (react-native-web writes dataSet.camelCase as data-camel-case)

/** The CSS selector of the elements with `testID` id, each `data` key (the dataSet) equal to its value. */
export function tidSel(id, data = {}) {
  return `[data-testid=${JSON.stringify(id)}]` + Object.entries(data).map(([k, v]) => `[data-${attr(k)}=${JSON.stringify(String(v))}]`).join("");
}

/** The locator of the elements with `testID` id under `root`, a page or a locator. */
export const byTid = (root, id, data) => root.locator(tidSel(id, data));

// ---- the viewport, as the page itself says

/** The layout the window's width gives now (app/src/ui/breakpoints.ts), so a check that resizes the window follows it. */
export const layoutNow = (page) => layoutOfWidth(page.viewportSize().width);

const touches = new WeakMap();
/** Whether the page has a finger and no mouse (a context with `hasTouch`: the tablet and the phone). */
export async function touchNow(page) {
  if (!touches.has(page)) touches.set(page, await page.evaluate(() => navigator.maxTouchPoints > 0));
  return touches.get(page);
}

/** A click with a mouse, a tap with a finger. */
export async function press(page, locator, opts) {
  return (await touchNow(page)) ? locator.tap(opts) : locator.click(opts);
}

/** The pointer over the element (what shows on hover appears); a touch viewport has no hover, so nothing is done there. */
export async function hover(page, locator) {
  if (!(await touchNow(page))) await locator.hover();
}

const cdps = new WeakMap();
/** The DevTools session a page's touch events go through (Playwright's touchscreen has a tap, no hold and no drag). */
async function cdp(page) {
  if (!cdps.has(page)) cdps.set(page, await page.context().newCDPSession(page));
  return cdps.get(page);
}

const centre = async (locator) => {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  if (!b) throw new Error("the page does not show the element to act on");
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const pointOf = (x) => ("x" in x && "y" in x ? Promise.resolve(x) : centre(x));

/** A finger held on the element for `ms` (700: past the 500 ms of a long press); a mouse button held on the desktop. The press
 *  is released afterwards; what the hold opened (a menu, a drag) stays. */
export async function longPress(page, locator, { ms = 700 } = {}) {
  const p = await pointOf(locator);
  if (await touchNow(page)) {
    const c = await cdp(page);
    await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
    await sleep(ms);
    await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await sleep(ms);
    await page.mouse.up();
  }
}

/** A finger held on the element for `ms`, then (after `until`, a locator, is visible, if given) taken off by a touchCancel: what the hold
 *  opened stays (a sheet that opened under the finger is not pressed through by a release). A touch viewport only. */
export async function hold(page, locator, { ms = 800, until: shown } = {}) {
  const p = await pointOf(locator), c = await cdp(page);
  await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
  await sleep(ms);
  if (shown) await shown.waitFor({ state: "visible", timeout: SETTLE }).catch(() => {});
  await c.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
}

// ---- dragging

/** A drag by the pointer of the viewport, step by step, so that a check can look at the page in the middle of it (the drop mark).
 *  A mouse presses and the drag starts at once; a finger is held first (`hold` ms, past the 300 ms of the long press), then moves.
 *    start(from)   press (and hold) at `from`: a locator (its middle) or { x, y }
 *    move(to)      go to `to` in `steps` steps (10), the page drawing between them; call it again for the next stop
 *    end()         release where the pointer is
 *    cancel()      end the touch the way the system does (a finger that is lifted off the screen, a mouse released after Escape)
 *  The one-shot forms below do all of them. */
export async function pointerDragger(page, { steps = 10, hold = 450 } = {}) {
  const touch = await touchNow(page), c = touch ? await cdp(page) : null;
  let at = null;
  const touchPoint = (p) => [{ x: p.x, y: p.y, id: 1 }];
  const frame = () => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  return {
    touch,
    async start(from) {
      at = await pointOf(from);
      if (touch) { await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touchPoint(at) }); await sleep(hold); }
      else { await page.mouse.move(at.x, at.y); await page.mouse.down(); }
      await frame();
    },
    async move(to) {
      const end = await pointOf(to);
      for (let i = 1; i <= steps; i++) {
        const p = { x: at.x + ((end.x - at.x) * i) / steps, y: at.y + ((end.y - at.y) * i) / steps };
        if (touch) await c.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touchPoint(p) }); else await page.mouse.move(p.x, p.y);
        await sleep(8);
      }
      at = end;
      await frame();
    },
    async end() {
      if (touch) await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); else await page.mouse.up();
      await frame();
    },
    async cancel() {
      if (touch) await c.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      else { await page.keyboard.press("Escape"); await page.mouse.up(); }
      await frame();
    },
  };
}

/** A drag with the mouse from `from` to `to` (a locator or a point), in steps, whatever the viewport. */
export async function mouseDrag(page, from, to, { steps = 10 } = {}) {
  const a = await pointOf(from), b = await pointOf(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps); await sleep(8); }
  await page.mouse.up();
}

/** A drag with one finger: held at `from` (`hold` ms, past the long press), then moved to `to` in steps, then lifted. */
export async function touchDrag(page, from, to, { steps = 10, hold = 450 } = {}) {
  const c = await cdp(page), a = await pointOf(from), b = await pointOf(to);
  const at = (p) => [{ x: p.x, y: p.y, id: 1 }];
  await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(a) });
  await sleep(hold);
  for (let i = 1; i <= steps; i++) { await c.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at({ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }) }); await sleep(8); }
  await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** A drag by the pointer of the viewport: touchDrag on a touch viewport, mouseDrag on the desktop. */
export async function dragTo(page, from, to, opts) {
  return (await touchNow(page)) ? touchDrag(page, from, to, opts) : mouseDrag(page, from, to, opts);
}

// ---- navigating

/** Brings the list on screen: on the phone, Home (back through the stack to it; the sidebar is the wide layouts'); on the wide layouts, the
 *  sidebar shown if it was hidden. Answers the list: the sidebar's tree, or Home. */
export async function showList(page) {
  if (layoutNow(page) === "phone") return showHome(page);
  const tree = byTid(page, IDS.tree).first();
  if (!(await tree.isVisible())) await press(page, byTid(page, IDS.show).first());
  await tree.waitFor({ state: "visible", timeout: WAIT });
  return tree;
}

/** The phone's Home on screen, back through the stack to it, showing the server `server` (an entry id: "local" for this computer's, the
 *  mock's id for another) when it is given: its chip is pressed when the chips are drawn and another is the selected one. */
export async function showHome(page, server) {
  const home = byTid(page, IDS.home).first();
  for (let i = 0; i < 8 && !(await home.isVisible()); i++) if (!(await back(page))) break;
  await home.waitFor({ state: "visible", timeout: WAIT });
  if (server && (await home.getAttribute("data-server")) !== server) {
    const chip = byTid(page, IDS.chip, { server }).first();
    await chip.waitFor({ state: "visible", timeout: WAIT }).catch(() => { throw new Error(`Home has no chip of the server "${server}"`); });
    await press(page, chip);
    await page.waitForSelector(tidSel(IDS.home, { server }), { timeout: WAIT });
  }
  return home;
}

/** Where a thing sits, as the page's store has it (the seam of screens/home/seam.ts, uicheck builds): { server, groups (keys, outermost
 *  first), board (the board a chat is on, or null) }. */
async function pathOf(page, kind, key) {
  await page.waitForFunction(() => !!window.__aiwbHome, null, { timeout: WAIT });
  return page.evaluate(([kind, key]) => window.__aiwbHome.placeOf(kind, key), [kind, key]);
}

/** On the phone: Home of the thing's server, its groups pushed one by one (each row pressed, its screen waited for), then its row pressed. */
async function openOnPhone(page, kind, key, timeout) {
  const path = await pathOf(page, kind, key);
  const target = path.board ? { kind: "board", key: path.board } : { kind, key };
  // (a screen of the path may be open already: Home is shown again, from the bottom of the stack, so that the path is the one pressed)
  await showHome(page, path.server);
  let scope = byTid(page, IDS.home).first();
  for (const g of path.groups) {
    const row = byTid(scope, IDS.homeRow, { kind: "group", key: g }).first();
    await row.waitFor({ state: "attached", timeout }).catch(() => { throw new Error(`the phone's list has no row of the group "${g}" on the way to ${kind} "${key}"`); });
    await row.scrollIntoViewIfNeeded();
    await press(page, row);
    scope = byTid(page, IDS.groupScreen, { key: g }).last();
    await scope.waitFor({ state: "visible", timeout: WAIT });
  }
  const row = byTid(scope, IDS.homeRow, target).first();
  await row.waitFor({ state: "attached", timeout }).catch(() => { throw new Error(`the phone's list has no ${target.kind} row "${target.key}"`); });
  await row.scrollIntoViewIfNeeded();
  await press(page, row);
  if (path.board && kind === "chat") {
    await byTid(page, IDS.boardBar).first().waitFor({ state: "visible", timeout: WAIT });
    await openBoardChat(page, path.board, key);
  }
}

/** On the phone, the chat `chat` of the open board `board`: its row in the board's Chats sheet (B1) when the bar's Chats opens one;
 *  before that sheet exists, the selection is set through the stack's seam (screens/shell/phone/seam.ts), which gives the same stack. */
export async function openBoardChat(page, board, chat) {
  const chats = byTid(page, "board-chats").first();
  if (await chats.isVisible()) {
    await press(page, chats);
    const sheet = byTid(page, IDS.chatsSheet).last();
    if (await sheet.waitFor({ state: "visible", timeout: SETTLE }).then(() => true, () => false)) {
      const row = byTid(sheet, IDS.chatsSheetRow, { chat }).first();
      if (await row.waitFor({ state: "visible", timeout: SETTLE }).then(() => true, () => false)) { await press(page, row); return; }
      await page.keyboard.press("Escape"); // (no row for it: close the sheet and take the seam below)
    }
  }
  await page.evaluate(([board, chat]) => window.__aiwbStack.select({ board, chat }), [board, chat]);
}

/** Settings' row for each foot control, and the text of the cell a placeholder screen holds for it (S1's placeholders: Servers, Library and
 *  Voice hold a cell that opens the dialog; a package's own screen has none, and the row's screen is the destination: Archived's is H2's own
 *  `archived-screen`, with no switch on the phone). */
const FOOT_ROW = { "servers-btn": ["servers", "Open servers"], "library-btn": ["library", "Open prompt library"], "settings-btn": ["voice", "Open voice settings"],
  "side-archived": ["archived", null], "theme-btn": ["appearance", null] };
const FOOT_PLACEHOLDER = { servers: "servers", library: "library", voice: "voice-settings" }; // (a row -> the placeholder's `screen`)

/** A control of the sidebar's foot (its testID: "servers-btn", "library-btn", "settings-btn", "theme-btn", "side-archived"), pressed: in
 *  the foot on the wide layouts (the sidebar shown first). On the phone Home's gear pushes Settings and the control is reached through its
 *  row: Servers (`servers-btn`), Library (`library-btn`), Voice (`settings-btn`), Archived (`side-archived`: H2's `archived-screen` is the destination, answered as its locator), Appearance (`theme-btn`: the
 *  screen at rest, nothing pressed beyond it; the theme is chosen there). While the row's screen is S1's placeholder, its cell ("Open
 *  servers", "Open prompt library", "Open voice settings") or switch is pressed, the same action as the foot's control; once a package
 *  registers the screen, the screen is the destination. A build without S1 (the gear opens the stop-gap sheet that holds the foot) keeps
 *  the old path. `press: false` leaves the last control (the cell, the switch, the foot's button) unpressed, for a caller that reads it first.
 *  Answers the control's locator (the screen for `theme-btn` and `side-archived`, which has no control on the phone; the row when the destination is a screen of its own). */
export async function openFoot(page, id, { press: pressIt = true } = {}) {
  if (layoutNow(page) !== "phone") {
    await showList(page);
    const control = byTid(page, id).last();
    await control.waitFor({ state: "visible", timeout: WAIT });
    if (pressIt) await press(page, control);
    return control;
  }
  await showHome(page);
  await press(page, byTid(page, IDS.gear).first());
  const shown = page.locator(`${tidSel("settings-screen")}, ${tidSel("home-settings-stopgap")}`).locator("visible=true").last();
  await shown.waitFor({ state: "visible", timeout: WAIT });
  if (!await byTid(page, "settings-screen").last().isVisible()) { // (the stop-gap sheet)
    const control = byTid(page, id).last();
    await control.waitFor({ state: "visible", timeout: WAIT });
    if (pressIt) await press(page, control);
    return control;
  }
  const { atRest, openRow } = await import("./settings.mjs"); // (settings.mjs imports this file)
  await atRest(page, "settings-screen");
  const [row, cell] = FOOT_ROW[id] ?? [];
  if (!row) throw new Error(`openFoot: no Settings row for "${id}"`);
  if (row === "appearance") {
    await openRow(page, row, "appearance-screen");
    return byTid(page, "appearance-screen").last();
  }
  const rowLoc = byTid(page, "settings-row", { row }).last();
  await rowLoc.waitFor({ state: "visible", timeout: WAIT });
  await press(page, rowLoc);
  if (row === "archived") { // (H2's own screen: the phone has no "Show archived" switch)
    await atRest(page, "archived-screen");
    return byTid(page, "archived-screen").last();
  }
  if (row === "servers") { // (S2's list is the destination: pushed, not a placeholder)
    await byTid(page, "srv-list").last().waitFor({ state: "visible", timeout: WAIT });
    return rowLoc;
  }
  const place = byTid(page, "settings-placeholder", { screen: FOOT_PLACEHOLDER[row] }).last();
  if (!await place.waitFor({ state: "visible", timeout: SETTLE }).then(() => true, () => false)) return rowLoc; // (a screen of its own)
  await atRest(page, "settings-placeholder");
  const control = cell ? place.getByText(cell, { exact: true }).first() : place.locator('[role="switch"]').first();
  await control.waitFor({ state: "visible", timeout: WAIT });
  // (the switch sits in a Cell with no press of its own, drawn aria-disabled: Playwright takes the switch for disabled too, so it is pressed forced, where the finger is)
  if (pressIt) await press(page, control, cell ? undefined : { force: true });
  return control;
}

/** The stack's back on the phone: pressed when it is there, answers true; the wide layouts have none and answer false. */
export async function back(page) {
  const b = byTid(page, IDS.back).last();
  if (!(await b.isVisible())) return false;
  await press(page, b);
  return true;
}

async function openRow(page, kind, key, head, { timeout = WAIT } = {}) {
  if (layoutNow(page) === "phone") {
    await openOnPhone(page, kind, key, timeout);
    await byTid(page, head).first().waitFor({ state: "visible", timeout: WAIT });
    return;
  }
  const tree = await showList(page);
  const row = byTid(tree, IDS.row, { kind, key }).first();
  await row.waitFor({ state: "attached", timeout }).catch(() => { throw new Error(`the sidebar has no ${kind} row "${key}" (a collapsed group or section keeps its rows out)`); });
  await row.scrollIntoViewIfNeeded();
  await press(page, row);
  // (a wide layout keeps the list on screen: the row says it is the open one)
  await page.waitForSelector(tidSel(IDS.row, { kind, key }) + '[aria-selected="true"]', { timeout: WAIT });
  await byTid(page, head).first().waitFor({ state: "visible", timeout: WAIT });
}

/** Opens the chat `key` by the path of the layout (the sidebar's row; on the phone Home's path) and waits for its header. A row that
 *  is not drawn within `timeout` ms (15 s by default: a list may draw late) is an error that names it. */
export const openChat = (page, key, opts) => openRow(page, "chat", key, IDS.chatHead, opts);

/** Opens the board `key` by the path of the layout and waits for its bar. */
export const openBoard = (page, key, opts) => openRow(page, "board", key, IDS.boardBar, opts);

/** Waits until a popover (`ui/Popover`) is where it hangs: it is drawn with no opacity until its anchor and its own size are measured, and a press
 *  at its place before that is a press on it. A sheet and a dialog are placed at once. */
export async function placed(menu) {
  await until(() => menu.evaluate((e) => { const p = e.closest('[data-testid="popover"]'); return !p || getComputedStyle(p).opacity !== "0"; }).catch(() => true), SETTLE);
}

/** Presses a button (`target`: a testID, or a locator), waits for the menu it opens, and presses the items named, each one in the
 *  menu the one before it opened; an item is found by its text (a part of it). Answers the menu that is left open, null when the
 *  last item closed it. On the desktop the pointer goes over the button first (a row's button shows on hover). */
export async function openMenu(page, target, ...items) {
  const button = (typeof target === "string" ? byTid(page, target) : target).first();
  await hover(page, button);
  await press(page, button);
  let menu = byTid(page, IDS.menu).last();
  await menu.waitFor({ state: "visible", timeout: WAIT });
  await placed(menu);
  for (const text of items.filter(Boolean)) {
    const before = [await byTid(page, IDS.menu).count(), await menu.innerText()];
    await press(page, menu.locator(tidSel(IDS.menuItem), { hasText: text }).first());
    // (the pick closes the menu, opens the next one in its place or beside it, or leaves it as it was, as a choice may: the first two show
    // within a few frames, so a menu that has not changed after the bound is taken for the third)
    await until(async () => {
      const now = byTid(page, IDS.menu);
      // (a menu that goes while it is read has changed: the read of its text must not wait for one that is no more)
      try { return (await now.count()) !== before[0] || !(await now.last().isVisible()) || (await now.last().innerText({ timeout: 1000 })) !== before[1]; } catch { return true; }
    }, SETTLE);
    menu = byTid(page, IDS.menu).last();
  }
  return (await menu.isVisible()) ? menu : null;
}

// ---- the states of the seed

/** What a seeded state asks the page to do before it shows (the `act` of dev/mock-ui.js): the packages that draw the state add its
 *  case here (`acts.hover = async (page) => …`). */
export const acts = {
  /** The first subagent row of the thread pressed: that subagent's drawer (beside the page, or the phone's pushed screen), drawn (S7). */
  async drawer(page) {
    await press(page, byTid(page, "sub-row").first());
    await byTid(page, "sub-drawer-body").first().waitFor({ state: "visible", timeout: WAIT });
    // (on the phone the drawer is a screen pushed over the chat, which slides in: it is read once it has come to rest)
    await page.waitForFunction(() => {
      const e = document.querySelector('[data-testid="sub-drawer"]');
      if (!e) return false;
      const left = Math.round(e.getBoundingClientRect().left), still = window.__drawerLeft === left;
      window.__drawerLeft = left;
      return still && document.documentElement.scrollWidth <= innerWidth;
    }, null, { timeout: WAIT, polling: "raf" });
  },
  /** "Branch" on the first reply: a pending move, with its banner (S8, fork.mjs). */
  async move(page) { await (await import("./fork.mjs")).startMove(page); },
  /** The actions of the first reply shown: the bar of a hovering mouse, the menu of a finger's "⋯" (left open). */
  async hover(page) {
    const f = await import("./fork.mjs");
    await f.openActs(page, await f.firstMsg(page));
  },
  /** The chat's tree popup, opened from the header's Tree button. */
  async tree(page) { await (await import("./fork.mjs")).openTree(page); },
  /** Every shape of the board's canvas (B4): a click on its empty ground gives it the keys, then select all. (Not in the corner: the
   *  help button is there, which a click opens.) */
  async select(page) {
    // (a board opens as a reader's, in view mode, until "Edit here" (board-take): the window takes the board first, then selects on the writer's canvas)
    const { LIVE, editHere } = await import("./boarddraw.mjs");
    await page.waitForSelector(`${LIVE}, [data-testid="board-take"]`, { state: "attached", timeout: WAIT });
    // (a take the check pressed itself may still be under way: give the writer's canvas a moment before pressing Edit here again)
    if (!await page.waitForSelector(LIVE, { timeout: 5000 }).then(() => true, () => false)) await editHere(page, { timeout: WAIT });
    const box = await page.locator(".excalidraw canvas.interactive").boundingBox();
    await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.7);
    await page.keyboard.press("ControlOrMeta+a");
  },
  // ---- S2 (the Servers screens of the phone): the stack pushes the registered screen, and it is drawn (the testIDs of its body are the check's)
  "srv-list": (page) => pushS2(page, "servers", {}),
  "srv-detail:s_build": (page) => pushS2(page, "server", { id: "s_build" }),
  "srv-detail:s_attic": (page) => pushS2(page, "server", { id: "s_attic" }),
  "srv-detail:s_mini": (page) => pushS2(page, "server", { id: "s_mini" }),
  "srv-detail:s_certbox": (page) => pushS2(page, "server", { id: "s_certbox" }),
  "srv-cert:s_certbox": (page) => pushS2(page, "server-cert", { id: "s_certbox" }),
  /** Settings, pushed on the phone (S1, settings.mjs): Home's gear when it is there, else the uicheck build's seam; waited at rest. */
  async openSettings(page) { await (await import("./settings.mjs")).openSettings(page); },
};

/** S2's acts: push the screen `name` (app/src/screens/servers/index.ts) by the seam of the uicheck build and wait for its place on the stack. */
async function pushS2(page, name, params) {
  await page.waitForFunction(() => !!window.__aiwbStack, null, { timeout: WAIT });
  await page.evaluate(([n, p]) => window.__aiwbStack.push(n, p), [name, params]);
  await page.waitForSelector(tidSel("pushed-screen", { screen: name }), { state: "visible", timeout: WAIT });
}

/** "drop:<entry id>": that server of the mock's list drops while the page has its chat open (a thing of a server that is not
 *  connected is on screen only so); the next page opened with openApp finds it connected again. */
export async function act(page, what) {
  if (what === undefined) return;
  if (what.startsWith("drop:")) {
    const id = what.slice(5), url = new URL(page.url()).origin;
    // (what is to stay on screen is on screen: the chat's header comes with its tree, but its thread only when the list has been fetched,
    // and a server that drops before that leaves the app no thread to keep: it draws "not connected" in the thread's place, not the bar)
    await byTid(page, IDS.chatHead).first().waitFor({ state: "visible", timeout: WAIT });
    await page.waitForFunction(({ thread, load }) => {
      const t = document.querySelector(`[data-testid="${thread}"]`);
      return !!t && !t.querySelector(`[data-testid="wait-line"][data-wait="${load}"]`) && [...t.querySelectorAll("[data-testid]")].some((e) => e.dataset.testid !== "thread-scroll");
    }, { thread: IDS.thread, load: "load" }, { timeout: WAIT }).catch(() => { throw new Error("the page does not show the chat's thread: its list did not load before the server was to drop"); });
    dropped.set(url, id);
    await mockEval(`setServerState(${JSON.stringify(id)}, "unreachable", { detail: "connection refused" });`, url);
    return page.waitForSelector(tidSel(IDS.sectionState, { server: id, tone: "bad" }), { state: "attached", timeout: WAIT }).catch(() => {}); // (attached: the sidebar may be hidden)
  }
  if (acts[what]) return acts[what](page);
  throw new Error(`no act "${what}": add it to \`acts\` in dev/checks/sel.mjs`);
}
