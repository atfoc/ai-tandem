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
//   openChat(page, key, { timeout }), openBoard(...)   open that chat or board by its key (the selection key the seeds have:
//                                "c_plain", "s_studio~c_plain") through the path of the layout, and wait for it to show
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
  tree: "side-tree",              // the sidebar's tree (on the phone it is the first screen of the stack)
  row: "side-row",                // a row of a chat or a board: dataSet { kind: "chat" | "board", key }; aria-selected="true" when it is the open one (the wide layouts)
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

/** Brings the list of the sidebar on screen: on the phone, back through the stack to it; on the wide layouts, the sidebar shown
 *  if it was hidden. */
export async function showList(page) {
  const tree = byTid(page, IDS.tree).first();
  if (layoutNow(page) === "phone") {
    for (let i = 0; i < 6 && !(await tree.isVisible()); i++) if (!(await back(page))) break;
  } else if (!(await tree.isVisible())) await press(page, byTid(page, IDS.show).first());
  await tree.waitFor({ state: "visible", timeout: WAIT });
  return tree;
}

/** The stack's back on the phone: pressed when it is there, answers true; the wide layouts have none and answer false. */
export async function back(page) {
  const b = byTid(page, IDS.back).last();
  if (!(await b.isVisible())) return false;
  await press(page, b);
  return true;
}

async function openRow(page, kind, key, head, { timeout = WAIT } = {}) {
  const tree = await showList(page);
  const row = byTid(tree, IDS.row, { kind, key }).first();
  await row.waitFor({ state: "attached", timeout }).catch(() => { throw new Error(`the sidebar has no ${kind} row "${key}" (a collapsed group or section keeps its rows out)`); });
  await row.scrollIntoViewIfNeeded();
  await press(page, row);
  // (a wide layout keeps the list on screen: the row says it is the open one; the phone replaces the list by the screen)
  if (layoutNow(page) !== "phone") await page.waitForSelector(tidSel(IDS.row, { kind, key }) + '[aria-selected="true"]', { timeout: WAIT });
  await byTid(page, head).first().waitFor({ state: "visible", timeout: WAIT });
}

/** Opens the chat `key` from the sidebar by the path of the layout (the list is shown, the row pressed) and waits for its header. A row that
 *  is not drawn within `timeout` ms (15 s by default: a list may draw late) is an error that names it. */
export const openChat = (page, key, opts) => openRow(page, "chat", key, IDS.chatHead, opts);

/** Opens the board `key` from the sidebar by the path of the layout and waits for its bar. */
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
    await page.waitForSelector(".excalidraw:not(.excalidraw--view-mode) canvas.interactive", { timeout: WAIT });
    const box = await page.locator(".excalidraw canvas.interactive").boundingBox();
    await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.7);
    await page.keyboard.press("ControlOrMeta+a");
  },
};

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
