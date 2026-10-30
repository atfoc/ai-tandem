// The readers and the moves of the fork screens for the checks of the new build (package S8; the counterparts of `waitsSeen`, `startMove` and the
// `.fk-*` reads of the old checks). No dash in the name: the runner does not take it for a check. testIDs of screens/fork: on a message `fk-act`
// (dataSet kind: branchEdit | branch | forkEdit | fork | label; `title` is the tooltip, `aria-disabled` the hold; a mouse shows them in `fk-acts` over the
// hovered message, a finger in the menu `fk-more` opens), `fk-marker`, `fk-label-tag`, `fk-label-field`, `fk-label-input`; in the header `fk-crumb`,
// `fk-alert` (kind asks | failed | quiet), `fk-tree-btn`; above the composer `fk-banner` (sending) with `fk-banner-text` and `fk-back`; the popup
// `tree-popup` with `fk-nav`, `fk-nav-sub`, `fk-filter`, `fk-search`, `fk-rows`, `fk-row` (dataSet kind, end, on, path, held, mark), `fk-text`, `fk-tag`,
// `fk-model`, `fk-mark`, `fk-stop`, `fk-here`, `fk-end`, `fk-fork-link`, `fk-loose-head`, `fk-none`, `fk-ctx-item`, `fk-ctx-note`, `fk-nav-foot` with
// `fk-held` or `fk-foot-text`, `fk-folder-agents`, `fk-close`. Every control of a message's extras has a testID that starts with `fk-`: `msgText` leaves
// them out of what a message says.
import { until } from "../shot.mjs";
import { byTid, hold, hover, layoutNow, longPress, press, touchNow } from "./sel.mjs";

export const WAIT = 15000;

/** The notice of a failed call (the confirm dialog with only Close): its title, read, and the dialog closed. */
export async function notice(page) {
  const d = byTid(page, "confirm-dialog").first();
  await d.waitFor({ state: "visible", timeout: WAIT });
  const title = await d.getAttribute("aria-label");
  // the dialog's Close is its last button; the phone's confirm sheet has it as `confirm-cancel`
  await press(page, (await byTid(d, "confirm-cancel").count()) ? byTid(d, "confirm-cancel") : byTid(d, "btn").last());
  await until(async () => !(await byTid(page, "confirm-dialog").count()));
  return title;
}

/** The testIDs of the composer (K3), which the old checks read by class: the package that draws the composer names them here. */
export const COMPOSER_IDS = { input: "composer-input", send: "send", stop: "stop", err: "composer-err" }; // (the model chip, which says the effort too, is `tchip` with dataSet kind "model": composerSeen)

/** What a message says: its text with the controls of the fork extras (`fk-…`) left out. */
const MSG_TEXT = `(e) => { const c = e.cloneNode(true); c.querySelectorAll('[data-testid^="fk-"]').forEach((x) => x.remove()); return (c.textContent ?? "").replace(/\\s+/g, " ").trim(); }`;

/** In the page, as text: what the thread's messages are, in the order they are on screen: [{ who, text, sending, live }]. */
const MSGS_IN_PAGE = `(() => {
  const words = ${MSG_TEXT};
  return [...document.querySelectorAll('[data-testid="msg"]')].map((e) => ({ e, top: e.getBoundingClientRect().top })).sort((a, b) => a.top - b.top)
    .map(({ e }) => ({ who: e.dataset.role === "user" ? "user" : "agent", text: words(e), sending: !!e.dataset.sending, live: e.dataset.item !== undefined }));
})()`;

/** The messages the thread draws, in the order they are on screen: [{ who, text, sending, live }]. */
export const msgsSeen = (page) => page.evaluate(MSGS_IN_PAGE);

/** What the chat on screen shows of a wait of the fork flows: the thread's messages and lines, the banner and its Back, the header's alerts, and (once the
 *  composer is K3's and `composer` is true) Send, the pickers, the box and the error under it. One read of the page, so that what is said of a wait is of one
 *  frame. */
export async function waitsSeen(page, { composer = false } = {}) {
  const read = await page.evaluate(`(() => {
    const text = (e) => (e?.textContent ?? "").replace(/\\s+/g, " ").trim();
    // (title: the hover title, or at the phone layout, which has none (ux-improvements 3.1.3), the control's accessible name, which says the reason a held control is off)
    const ctl = (e) => (e ? { disabled: e.getAttribute("aria-disabled") === "true" || e.disabled === true, title: e.getAttribute("title") || e.getAttribute("aria-label") || "", text: text(e) || (e.getAttribute("aria-label") ?? "") } : null);
    const top = (e) => e.getBoundingClientRect().top;
    const all = (sel) => [...document.querySelectorAll(sel)].sort((a, b) => top(a) - top(b));
    return {
      lines: all('[data-testid="wait-line"]').map((l) => [l.dataset.wait, text(l)]),
      typing: all('[data-testid="typing"]').map(text),
      empty: !!document.querySelector('[data-testid="empty-thread"]'),
      banner: text(document.querySelector('[data-testid="fk-banner-text"]')),
      back: ctl(document.querySelector('[data-testid="fk-back"]')),
      alerts: [...document.querySelectorAll('[data-testid="chat-head"] [data-testid="fk-alert"]')].map((a) => ({ ...ctl(a), kind: a.dataset.kind })),
      msgs: ${MSGS_IN_PAGE},
    };
  })()`);
  return { ...read, ...(composer ? await composerSeen(page) : {}) };
}

/** The composer's part of waitsSeen (K3's ids, COMPOSER_IDS). A chip that is disabled while a change is saved has `aria-disabled`; a Send that waits has `disabled`. */
export function composerSeen(page) {
  return page.evaluate(`(() => {
    const ids = ${JSON.stringify(COMPOSER_IDS)};
    const q = (id) => document.querySelector('[data-testid="' + id + '"]');
    const text = (e) => (e?.textContent ?? "").replace(/\\s+/g, " ").trim();
    // (label: the accessible name, which is all a control says at the phone layout: it has no hover title)
    const ctl = (e) => (e ? { disabled: e.getAttribute("aria-disabled") === "true" || e.disabled === true, title: e.getAttribute("title") ?? "", text: text(e), label: e.getAttribute("aria-label") ?? "" } : null);
    // (a chip of the toolbar's row, or of the open "more" popup: the first of its kind)
    const chip = (kind) => document.querySelector('[data-testid="tchip"][data-kind="' + kind + '"]');
    const send = q(ids.send), model = chip("model"), effort = chip("effort");
    // (the phone layout, ux-improvements C1/C2: one primary button, Talk while the box is empty - so a Send that waits, with the box emptied by the send, is
    // not drawn: the wait is told by the thread's line and the banner; the model chip has no fixed look, it takes no press (disabled), with the pick's words)
    const phone = !!q("composer-phone-tools"), talk = q("composer-talk");
    return {
      phone, talk: ctl(talk),
      send: send ? { ...ctl(send), spin: send.dataset.sending === "true" } : null,
      stop: !!q(ids.stop), model: ctl(model), fixed: model?.dataset.fixed === "true", effort: ctl(effort), more: !!q("more-chip"),
      held: text(q("chip-held")),
      box: (q(ids.input)?.value ?? text(q(ids.input))), err: text(q(ids.err)),
    };
  })()`);
}

/** The first message of a role that the thread draws, as a locator (a virtual list keeps no order in the page: the one with the least place in the thread). */
export async function firstMsg(page, role = "assistant") {
  await byTid(page, "msg", { role }).first().waitFor({ state: "visible", timeout: WAIT });
  const item = await page.evaluate((role) => Math.min(...[...document.querySelectorAll(`[data-testid="msg"][data-role="${role}"][data-item]`)].map((e) => +e.dataset.item)), role);
  return byTid(page, "msg", { item }).first();
}

/** Types `text` into the composer and sends it with ⌘Enter / Ctrl+Enter (Enter is a line break at every layout). */
export async function typeAndSend(page, text) {
  const box = byTid(page, COMPOSER_IDS.input).first();
  await box.click();
  await page.keyboard.type(text);
  await page.keyboard.press("ControlOrMeta+Enter");
}

/** Sends `text` as the composer's Send does: through the box when the composer is drawn (`composer`), else through the hook a build for the checks has
 *  (screens/fork/index.ts). */
export async function send(page, chat, text, { composer = false } = {}) {
  if (composer) return typeAndSend(page, text);
  await page.evaluate(([c, t]) => { void window.__aiwbSend(c, t); }, [chat, text]); // (not awaited: the call may be held)
}

// ---- a message's actions

/** Waits until a locator stands still (a sheet rises for a moment, and a press with `force` does not wait for it). */
export async function still(locator) {
  let last = "";
  await until(async () => { const b = JSON.stringify(await locator.boundingBox().catch(() => null)); const done = b === last && b !== "null"; last = b; return done; }, 4000);
}

/** Opens the actions of the message `msg` (a locator): a mouse hovers it, a finger taps its "⋯", a phone's finger holds it (a touch viewport whose page last felt a mouse, as a
 *  check that clicked, shows the bar of a mouse). Answers { scope, close }: where the actions are, and a function that closes what was opened. */
export async function openActs(page, msg) {
  await msg.scrollIntoViewIfNeeded();
  if (layoutNow(page) === "phone" && await touchNow(page)) { // (no "⋯" on the phone: a finger's hold on the message opens its sheet, whose rows are the actions;
    // a mouse in a window of the phone's width, the desktop's, has the hover bar as on the wide layouts: ux-improvements C1)
    // (until the list has laid the row out, its rows are hidden from the pointer: the finger would land on nothing)
    await until(() => msg.evaluate((el) => { const b = el.getBoundingClientRect(), at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return !!at && el.contains(at); }), 10000);
    // (the finger is lifted by a touchCancel once the sheet is up, not by a touchEnd: a release is a tap on whatever stands under the finger, and on a long thread the
    // message held is in the lower part of the screen, where the rising sheet's rows are. The app does not press a row on that release (18 holds of 520 to 800 ms on a
    // 300-turn thread showed none), so this is the check's own care: its finger presses no row however slow the machine draws the sheet)
    const sheet = byTid(page, "msg-sheet").last();
    await hold(page, msg, { ms: 600, until: sheet });
    await sheet.waitFor({ state: "visible", timeout: WAIT });
    await still(sheet);
    return { scope: sheet, sheet: true, close: () => closeSheet(page) };
  }
  if (await touchNow(page) && await byTid(msg, "fk-more").count()) {
    await press(page, byTid(msg, "fk-more").first());
    const menu = byTid(page, "menu").last();
    await menu.waitFor({ state: "visible", timeout: WAIT });
    await still(menu);
    return { scope: menu, close: async () => { await page.keyboard.press("Escape"); await until(async () => !(await byTid(page, "menu").count()), 3000); } };
  }
  await msg.hover();
  await byTid(msg, "fk-act").first().waitFor({ state: "attached", timeout: WAIT });
  return { scope: msg, bar: true, close: async () => {} };
}

/** Closes the message sheet by its backdrop. The finger that held the message may still count as down for a moment, and a press on the backdrop in that
 *  grace closes nothing (as with the Quote sheet): it is pressed again until the sheet is gone. */
async function closeSheet(page) {
  await until(async () => {
    if (!await byTid(page, "msg-sheet").count()) return true;
    await press(page, byTid(page, "overlay-backdrop").last(), { position: { x: 4, y: 4 } });
    await page.waitForTimeout(300);
    return !await byTid(page, "msg-sheet").count();
  }, 8000);
}

/** The controls the actions of one message are: [{ kind, text, disabled, title }] (after openActs). */
export function actsIn(page, scope) {
  // (the phone's sheet: a row per action, its `action` the fork's kind; the quick row's Copy, Quote and Select text are not fork actions; a row that
  // must wait says why in its note, which stands in for the tooltip of the wide layouts)
  return scope.locator('[data-testid="fk-act"], [data-testid="action-row"]').evaluateAll((els) => els.filter((b) => !["copy", "quote", "select"].includes(b.dataset.action)).map((b) => {
    const disabled = b.getAttribute("aria-disabled") === "true" || b.disabled === true;
    const label = (b.getAttribute("aria-label") ?? b.textContent ?? "").trim();
    const row = b.getAttribute("data-testid") === "action-row";
    if (!row) return { kind: b.dataset.kind, text: label, disabled, title: b.getAttribute("title") ?? "" };
    const [name, ...why] = label.split(". "); // (the row's label is "Branch. <why it waits>")
    return { kind: b.dataset.action, text: name, disabled, title: disabled ? why.join(". ") : "" };
  }));
}

/** Every fork action of every message the thread draws, message by message in order (the old `acts`: a mouse's bar shows while the pointer is over its
 *  message, a finger's menu while it is open, so each message is opened in turn). Read aloud (`kind: "read"`, voice's, VC.5 proves it) stands in the same
 *  bar and menu on every message that has words, and is left out here: these checks are about what forking offers. */
export async function actsSeen(page) {
  const items = (await page.evaluate(`[...document.querySelectorAll('[data-testid="msg"][data-item]')].map((e) => +e.dataset.item).sort((a, b) => a - b)`));
  const out = [];
  for (const i of items) {
    const msg = byTid(page, "msg", { item: i }).first();
    const opened = await openActs(page, msg).catch(() => null);
    if (!opened) continue; // (a message with no actions)
    out.push(...(await actsIn(page, opened.scope)).filter((a) => a.kind !== "read"));
    await opened.close();
  }
  return out;
}

/** Presses one action of a message: `kind` on the message `msg`. opts: the press's (`{ force: true }` for a control that is disabled: the press does nothing).
 *  What a finger opened (the menu) is closed again when the press did not close it. */
export async function pressAct(page, msg, kind, opts) {
  const { scope, bar, sheet, close } = await openActs(page, msg);
  const target = (sheet ? byTid(scope, "action-row", { action: kind }) : byTid(scope, "fk-act", { kind })).first();
  await target.waitFor({ state: "visible", timeout: WAIT });
  if (bar) await target.click(opts); else await press(page, target, opts); // (the bar is a mouse's: a tap on it would make the page feel a finger and take it away)
  if (await byTid(page, "menu").count() || await byTid(page, "msg-sheet").count()) await close(); // (a row of the sheet closes it itself; one that waits does not)
}

/** "Branch" on the first reply: the chat has a pending move, with its banner. */
export async function startMove(page) {
  await pressAct(page, await firstMsg(page), "branch");
  await byTid(page, "fk-banner").first().waitFor({ state: "visible", timeout: 5000 });
}

// ---- the tree popup

/** The Tree button of the header pressed, and the popup's rows waited for. */
export async function openTree(page) {
  await press(page, byTid(page, layoutNow(page) === "phone" ? "chat-tree" : "fk-tree-btn").first()); // (the phone's header has the content bar's Tree)
  await byTid(page, "fk-row").first().waitFor({ state: "visible", timeout: WAIT });
}

export async function closeTree(page) {
  await press(page, byTid(page, layoutNow(page) === "phone" ? "fk-done" : "fk-close").first()); // (the phone's sheet has Done in its head)
  await until(async () => !(await byTid(page, "fk-nav").count()));
}

/** A message row of the tree: by its text (a part of it) and kind ("user" | "text"). */
export const treeRow = (page, kind, has) => byTid(page, "fk-row", { kind }).filter({ hasText: has }).first();
/** The row an end of a branch (`end`: its id) is drawn on. */
export const endRow = (page, end) => byTid(page, "fk-row", { end }).first();

/** What opens the chat at a row: a double click with a mouse, a tap to pick and a tap on the picked row with a finger; on the phone one tap opens it. */
export async function openRow(page, row) {
  if (layoutNow(page) === "phone") await press(page, row);
  else if (await touchNow(page)) {
    if ((await row.getAttribute("aria-selected")) !== "true") await press(page, row);
    await press(page, row);
  } else await row.dblclick();
}

/** A row's menu: a right click with a mouse, the "⋯" at its end with a finger (the long press of a row is for a device: a touch the browser's tools send
 *  does not reach the long press of react-native-web's Pressable); waits for its items. On the phone a hold on the row opens its action sheet (`fk-row-sheet`), and the
 *  tree behind it is not drawn while it is open (one sheet at a time). */
export async function menuOfRow(page, row) {
  if (layoutNow(page) === "phone") {
    await longPress(page, row);
    const sheet = byTid(page, "fk-row-sheet").last();
    await sheet.waitFor({ state: "visible", timeout: WAIT });
    await still(sheet);
    return;
  }
  if (await touchNow(page)) await press(page, byTid(row, "fk-row-more").first()); else await row.click({ button: "right" });
  await byTid(page, "menu").last().waitFor({ state: "visible", timeout: WAIT });
  await still(byTid(page, "menu").last());
}

/** In the page: the open tree. rows: its message rows, with whether each is marked as disabled (its text, which is what a press opens: the row's Stop stays a live
 *  control) and its title; menu: the items of its row menu (on the phone the rows of the row's action sheet, whose reason is the row's second line: `title`; the tree
 *  itself is not drawn while it is open, so `rows` is then empty); stops: its Stop buttons; foot: the line under the rows (the phone has none). */
export function treeSeen(page) {
  return page.evaluate(`(() => {
    const text = (e) => (e?.textContent ?? "").replace(/\\s+/g, " ").trim();
    const nav = document.querySelector('[data-testid="fk-nav"]');
    const sheet = document.querySelector('[data-testid="fk-row-sheet"]');
    if (!nav && !sheet) return null;
    const menu = document.querySelector('[data-testid="menu"][aria-label="Row actions"]');
    const rowOf = (b) => {
      const label = (b.getAttribute("aria-label") ?? "").trim(), disabled = b.getAttribute("aria-disabled") === "true";
      return { text: label, disabled, title: disabled ? text(b).slice(label.length).trim() : "" };
    };
    if (!nav) return { rows: [], menu: [...sheet.querySelectorAll('[data-testid="action-row"]')].map(rowOf), stops: [], foot: "" };
    return {
      rows: [...nav.querySelectorAll('[data-testid="fk-row"]:not([data-kind="fork"])')].map((r) => {
        const t = r.querySelector('[data-testid="fk-text"]');
        return { text: text(t), disabled: r.dataset.held === "true" && t?.getAttribute("aria-disabled") === "true", title: r.getAttribute("title") ?? "" };
      }),
      menu: [...(sheet?.querySelectorAll('[data-testid="action-row"]') ?? [])].map(rowOf).concat([...(menu?.querySelectorAll('[data-testid="fk-ctx-item"]') ?? [])].map((b) => ({ text: b.getAttribute("aria-label") ?? text(b), disabled: b.getAttribute("aria-disabled") === "true", title: b.getAttribute("title") ?? "" }))),
      stops: [...nav.querySelectorAll('[data-testid="fk-stop"]')].map((b) => ({ disabled: b.getAttribute("aria-disabled") === "true" })),
      foot: text(nav.querySelector('[data-testid="fk-nav-foot"]')),
    };
  })()`);
}
