// The readers of the composer for the checks of the new build (package K3; the counterparts of the old driver's `measureComposer`,
// `composerProbe`, `toolbarWidths` and of the seed's `see` selectors, which read the old page's classes). No dash in the name: the runner
// does not take it for a check. The testIDs of screens/composer, with their dataSet in brackets:
//   composer [chat, branch] · composer-box [readonly] · composer-input (the chip input) · composer-tools [more, meter, insert, voice] (the toolbar's
//   row) · tool [control: server | agent | folder | model | effort | subagents] (a control of the row; a fixed folder's `lock` stands before
//   its chip) · tchip [kind, fixed, connected?] (a chip: a button, or static) · more-chip · part [part: more | meter | insert | attach | stop |
//   send | voice] (what stands in the row besides the controls) · tool-grow · ctx-meter [tone: error, compact] · send [sending] · stop · insert-btn ·
//   voice-dictate [on] · voice-speech [on] (voice's pair, Dictate and Speech mode, after the row's spacer, before the attach button: they are in `part` "voice", one
//   child of the row, and `composer-tools` says where the pair is in its `voice`: row | more) · more-row [control: dictate | speech] with more-dictate [on] and more-speech [on]
//   (the pair as two entries of the popup) · voice-problem (the popover of a voice problem) ·
//   agent-reason [tone: missing] · more-pop (the popup, over the page) with more-row [control: …] and more-insert · picker (a list) with
//   picker-search, pick-row [optionId] · dirs (the folder browser) with dir-input, dir-item, dir-use, dir-err · context-row · ctx-chip [ref] ·
//   ctx-act [kind: selection | point, on] · ctx-note · mention-pop with mention-item [board] · composer-err · model-notice [warn] · archived-bar.
import { byTid, tidSel } from "./sel.mjs";

/** In the page: the first composer's box and toolbar for a frame. null while none is drawn; else how many controls of the row end past the
 *  box, by how much, whether Send is the element at its own centre, and whether the document scrolls sideways. bad: any of them. (The
 *  frame sampler sends it as text: no closure.) */
export function composerProbe() {
  const q = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);
  const box = q("composer-box"), tools = box && q("composer-tools", box);
  if (!tools) return null;
  const right = box.getBoundingClientRect().right;
  let past = 0, by = 0;
  for (const e of tools.children) {
    if (e.dataset.testid === "tool-grow") continue;
    const over = e.getBoundingClientRect().right - right;
    if (over > 0.5) { past++; by = Math.max(by, Math.round(over)); }
  }
  const sd = q("send", tools), r = sd?.getBoundingClientRect();
  const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
  const send = !sd || hit === sd || sd.contains(hit), scroll = document.documentElement.scrollWidth - innerWidth;
  return { bad: past > 0 || !send || scroll > 0, past, by, send, scroll, box: Math.round(box.getBoundingClientRect().width) };
}

/** In the page: every composer shown, with each child of its toolbar row and of its context row against its box. past: how many end right of
 *  the box's border edge; furthest: by how many px at most; send: "ok" when Send is the element at its own centre; docScroll: how far the
 *  document scrolls sideways. */
export function composersInPage() {
  const R = (e) => e.getBoundingClientRect(), r1 = (n) => Math.round(n * 10) / 10;
  const id = (e) => e.dataset?.testid ?? "";
  const label = (e) => (id(e) + (e.dataset.part ? ":" + e.dataset.part : "") + (e.dataset.control ? ":" + e.dataset.control : "") || e.tagName.toLowerCase()) +
    (e.textContent.trim() ? ` "${e.textContent.trim().replace(/\s+/g, " ").slice(0, 28)}"` : "");
  return [...document.querySelectorAll('[data-testid="composer"]')].map((comp) => {
    const box = comp.querySelector('[data-testid="composer-box"]');
    if (!box) return { chat: comp.dataset.chat, none: true };
    const pane = comp.closest('[data-testid="board-panel"], [data-testid="chat-page"], [data-testid="board-stage"]'), b = R(box);
    const kids = (sel) => [...(comp.querySelector(sel)?.children ?? [])].filter((e) => id(e) !== "tool-grow");
    const one = (e, row) => ({ row, el: label(e), w: r1(R(e).width), overBox: r1(R(e).right - b.right) });
    const rows = [...kids('[data-testid="composer-tools"]').map((e) => one(e, "tools")), ...kids('[data-testid="context-row"]').map((e) => one(e, "context")), ...kids('[data-testid="fk-banner"]').map((e) => one(e, "banner"))];
    const over = rows.filter((x) => x.overBox > 0.5), sd = box.querySelector('[data-testid="send"]');
    let send = "none";
    if (sd) { const q = R(sd), h = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); send = h === sd || sd.contains(h) ? "ok" : h ? "covered by " + label(h) : "outside the window"; }
    return { chat: comp.dataset.chat, pane: pane?.dataset.testid ?? "", paneW: pane ? r1(R(pane).width) : 0, boxW: r1(b.width), boxOverPane: pane ? r1(b.right - R(pane).right) : 0,
      past: over.length, furthest: over.reduce((m, x) => Math.max(m, x.overBox), 0), over, send, docScroll: document.documentElement.scrollWidth - innerWidth, rows };
  });
}

/** The fit of every composer on the page (see composersInPage). */
export const measureComposer = (page) => page.evaluate(composersInPage);

/** In the page: the controls of the first composer's toolbar, left to right, each with its kind (server, agent, lock, folder, model, effort,
 *  model-effort: the fixed chip of both, loading, subagents, more: the chip of the popup that holds what the row has no room for, meter,
 *  insert, attach, stop, send), its label, whether it is a fixed chip, its width and its own margin (the lock has one); gap: the row's;
 *  chrome: what the box takes besides the row (padding and border); sum: the controls with their margins and the gaps between them on one
 *  line, the row's spacer among them at no width; reason: the line under the controls, when the toolbar has one. A control's wrapper in the
 *  row (the `tool` of a folder with its lock) is taken apart: the lock and the chip are two controls with the row's gap between them. */
function toolbarInPage() {
  const tools = document.querySelector('[data-testid="composer"] [data-testid="composer-tools"]');
  if (!tools) return null;
  const r1 = (n) => Math.round(n * 10) / 10, box = tools.closest('[data-testid="composer-box"]'), cs = getComputedStyle(box);
  const id = (e) => e.dataset?.testid ?? "";
  const flat = [];
  for (const e of tools.children) {
    if (id(e) === "agent-reason") continue;
    if (id(e) === "tool") flat.push(...e.children); else flat.push(e);
  }
  const kindOf = (e) => {
    if (id(e) === "tool-grow") return "grow";
    if (id(e) === "lock") return "lock";
    if (id(e) === "part") return e.dataset.part;
    const chip = id(e) === "tchip" ? e : e.querySelector('[data-testid="tchip"], [data-testid="ctx-meter"]');
    if (!chip) return "other";
    const kind = chip.dataset.kind;
    if (kind === "model") return chip.dataset.fixed === "true" ? (chip.textContent.includes("Loading models") ? "loading" : "model-effort") : "model";
    return kind;
  };
  const controls = flat.filter((e) => id(e) !== "tool-grow").map((e) => {
    const chip = id(e) === "tchip" ? e : e.querySelector('[data-testid="tchip"], [data-testid="ctx-meter"]');
    const m = getComputedStyle(e), margin = r1((parseFloat(m.marginLeft) || 0) + (parseFloat(m.marginRight) || 0));
    return { kind: kindOf(e), label: (chip ?? e).textContent.replace(/▾/g, "").replace(/\s+/g, " ").trim(), fixed: chip?.dataset?.fixed === "true", w: r1(e.getBoundingClientRect().width), margin };
  });
  const gap = parseFloat(getComputedStyle(tools).columnGap) || 0;
  const chrome = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"].reduce((n, k) => n + parseFloat(cs[k]), 0);
  return { controls, gap, chrome: r1(chrome), sum: r1(controls.reduce((n, c) => n + c.w + c.margin, 0) + gap * controls.length), reason: tools.querySelector('[data-testid="agent-reason"]')?.textContent ?? "" };
}

/** The widths the controls of the page's composer toolbar ask for (see toolbarInPage); null with no composer. */
export const toolbarWidths = (page) => page.evaluate(toolbarInPage);

/** What the seed's `see` of each A2 state is on the new build: [{ tid, data?, text?, state? }] (the counterpart of the selector the seed gives
 *  for the old page). What the composer does not draw itself (the banner of a move: S8; the header's tree button and
 *  the warning bar: S4's) is not here. */
export const SEES = {
  "plain-started": [{ tid: "tchip", data: { kind: "model", fixed: true } }],
  "plain-new": [{ tid: "tchip", data: { kind: "agent" } }],
  "plain-new-long": [{ tid: "tchip", data: { kind: "model" }, text: "extended thinking" }],
  "plain-started-long": [{ tid: "tchip", data: { kind: "model", fixed: true }, text: "extended thinking" }],
  "plain-busy": [{ tid: "stop" }],
  "plain-ctxerr": [{ tid: "ctx-meter", data: { tone: "error" } }],
  "plain-quotes": [{ tid: "composer-box" }, { tid: "qcount", data: { n: 2 } }],
  "plain-remote-new": [{ tid: "chat-head-server" }],
  "plain-remote-started": [{ tid: "chat-head-server" }],
  "plain-remote-started-long": [{ tid: "chat-head-server" }],
  "plain-move": [{ tid: "composer-box" }],
  "plain-move-long": [{ tid: "composer-box" }],
  "plain-loading": [{ tid: "tchip", data: { kind: "model", fixed: true }, text: "Loading models" }],
  "plain-noagent": [{ tid: "agent-reason", text: "Choose an agent" }],
  "plain-noagent-installed": [{ tid: "agent-reason", data: { tone: "missing" }, text: "No agent is installed on Bare box" }],
  "plain-off-new": [{ tid: "agent-reason", data: { tone: "missing" } }],
  "plain-off-started": [{ tid: "composer-box" }, { tid: "ctx-meter" }],
  "plain-fork-fresh": [{ tid: "tchip", data: { kind: "effort" } }],
  "plain-fork-notice": [{ tid: "model-notice", text: "Another model" }],
  "plain-branches": [{ tid: "composer-box" }],
  "board-started": [{ tid: "tchip", data: { kind: "model", fixed: true } }],
  "board-new": [{ tid: "tchip", data: { kind: "agent" } }],
  "board-quotes": [{ tid: "composer-box" }, { tid: "qcount", data: { n: 2 } }],
  "board-long": [{ tid: "tchip", data: { kind: "model", fixed: true }, text: "extended thinking" }],
  "board-move": [{ tid: "composer-box" }],
  "board-longname": [{ tid: "ctx-chip", text: "second draft" }],
  "board-selected": [{ tid: "ctx-act", data: { kind: "selection" }, text: "3 selected" }],
  "board-busy": [{ tid: "stop" }],
};

/** The chip of a kind in the toolbar's row (or in the open "more" popup, after the row's): `byTid(page, "tchip", { kind })`. */
export const chip = (page, kind, data = {}) => byTid(page, "tchip", { kind, ...data });

/** The locator of the "more" chip and the popup, the row the popup has for a control. */
export const MORE = tidSel("more-chip"), POP = tidSel("more-pop");
export const moreRow = (page, control) => byTid(page, "more-row", { control });

// ---- opening a seeded state

import { paneSize } from "../shot.mjs";
import { act } from "./sel.mjs";

export const SIDE = 264, RAIL = 40, HEIGHT = 640;

/** Whether the state can be played at a layout ("move" is a pending move started from a message's Branch action: `acts.move` of sel.mjs): "select" selects all the shapes of the canvas with a click and ⌘A, which a mouse does (the
 *  desktop); the tablet's touch has no such select-all, and the phone does not show the canvas under the chat. */
export const playable = (s, layout = "desktop") => !(s.act === "select" && layout !== "desktop");

/** The width of the window that gives a chat page `w` px: a window under 700 px is the phone layout (AD-72), whose chat screen is as wide
 *  as the window, with no sidebar beside it; from 700 px the sidebar is beside the page (wide layouts) and the window is that much wider. */
export const pageWindow = (w) => (w < 700 ? w : SIDE + w);

/** Opens a seeded state at a width: on the desktop in a window and with saved widths that give its pane (a panel beside a board, a chat
 *  page) that width (the pane is `s.pane[0]`); on the tablet and the phone the device's own width is what the layout has, so none is set.
 *  Its `act` is played, and the fonts are ready. The page is the composer's: `wait` is Send. */
export async function openState(open, s, layout, width, o = {}) {
  const base = layout === "desktop" && width ? paneSize(s.pane[0], width, HEIGHT) : {};
  // (the desktop layout starts at 1100 px, so a panel beside a board in a narrower window than that is the tablet layout's)
  const win = base.size ? { ...base, size: [s.pane[0] === "page" ? pageWindow(width) : Math.max(1100, base.size[0]), HEIGHT] } : base;
  const p = await open({ sel: s.sel, ...win, wait: tidSel("send"), ...o });
  if (s.act === "select") await p.page.waitForSelector(tidSel("board-canvas", { state: "ready" }), { timeout: 30000 }); // (the shapes are drawn before they are selected)
  await act(p.page, s.act);
  await p.page.evaluate(() => document.fonts.ready);
  await frame(p.page); // (the toolbar is fitted to what the state has made of it)
  return p;
}

/** A frame, after layout and paint (two animation frames). */
export const frame = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));

/** The probe of A2.2 and P7.3 for a frame: composerProbe's, and beside it whether the "more" popup is open, how many rows it holds, how many
 *  chips the row has, whether the meter is cut to its ring, whether an overlay is open (a list, the folder's browser, the "more" popup:
 *  each has a backdrop over the page, so Send is not within reach in that frame), by how many px a control ends past the row itself, and
 *  how wide the narrower of Stop and Send is. (The sampler sends its probe as text.) */
export const fitProbe = { toString: () => `() => {
  const v = (${composerProbe})();
  if (!v) return null;
  const q = (id, root = document) => root.querySelector('[data-testid="' + id + '"]');
  const t = q("composer-tools"), kids = [...t.children].filter((e) => e.dataset.testid !== "tool-grow");
  return { ...v, more: !!q("more-pop"), held: document.querySelectorAll('[data-testid="more-pop"] [data-testid="more-row"]').length,
    chips: t.querySelectorAll('[data-testid="tchip"]:not([data-kind="more"])').length, ring: !!t.querySelector('[data-testid="ctx-meter"][data-compact]'),
    list: !!q("overlay-backdrop"), hidden: !!q("side-rail"),
    out: Math.round(Math.max(...kids.map((e) => e.getBoundingClientRect().right - t.getBoundingClientRect().right)) * 10) / 10,
    send: Math.min(...[...t.querySelectorAll('[data-testid="send"], [data-testid="stop"]')].map((e) => e.getBoundingClientRect().width)) };
}` };

/** In the page: the toolbar's row as one measurement at rest (A2.2's `row`): how far apart the centres of its controls are, how far the
 *  furthest ends past the row, and the widths of Stop and Send. */
export const rowOf = (page) => page.evaluate(() => {
  const tools = document.querySelector('[data-testid="composer-tools"]');
  if (!tools) return null;
  const kids = [...tools.children].filter((e) => e.dataset.testid !== "tool-grow"), mid = kids.filter((e) => e.dataset.testid !== "agent-reason").map((e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; });
  return { lines: Math.round(Math.max(...mid) - Math.min(...mid)), out: Math.round(Math.max(...kids.map((e) => e.getBoundingClientRect().right - tools.getBoundingClientRect().right)) * 10) / 10,
    send: [...tools.querySelectorAll('[data-testid="send"], [data-testid="stop"]')].map((e) => e.getBoundingClientRect().width) };
});

/** How many elements of the page match a part of `SEES` ({ tid, data?, text? }). */
export const countOf = (root, p) => { const l = byTid(root, p.tid, p.data); return (p.text ? l.filter({ hasText: p.text }) : l).count(); };

// ---- widths at every viewport

import { dragResizer } from "../shot.mjs";

/** The window (touch viewports) that gives the chat screen `w` px, as a desktop's chat page of that width: under 700 px it is the phone
 *  layout, where the chat screen is as wide as the window; its popups are sheets. */
export const touchWindow = (w) => w;

/** Opens a state at a width of its pane: the desktop's windows and saved widths (openState); on the touch viewports a window of that width
 *  on the viewport's device (the phone layout, the sheets of AD-72). */
export function openAt(open, s, layout, width, o = {}) {
  return layout === "desktop" ? openState(open, s, layout, width, o) : openState(open, s, layout, 0, { size: [touchWindow(width), HEIGHT], ...o });
}

/** Brings the pane to a width, as `openAt` opened it: the desktop's panel by its resizer, a page by the window; a touch viewport's by the window. */
export async function resizeTo(page, s, layout, width) {
  if (layout === "desktop" && s.pane[0] === "panel") {
    const now = await page.evaluate(() => document.querySelector('[data-testid="board-panel"]')?.getBoundingClientRect().width);
    if (page.viewportSize().width < SIDE + width + 500) await page.setViewportSize({ width: SIDE + width + 500, height: HEIGHT });
    await dragResizer(page, `${tidSel("board-panel")} ${tidSel("resizer")}`, width - now, 20);
  } else await page.setViewportSize({ width: layout === "desktop" ? pageWindow(width) : touchWindow(width), height: HEIGHT });
  await frame(page);
}

/** In the page: the chips of the composer's toolbar, each with the choice it is (its kind), where it is (the row, or the "more" popup),
 *  what it says and whether it has the focus; the lists open (a picker's, the folder's browser), each with where the chip it was opened from is
 *  (one list is open at a time: its chip says `aria-expanded`); whether "more" is open; where the focus is. (A2.3's `placesInPage`.) */
function placesInPage() {
  const tools = document.querySelector('[data-testid="composer-tools"]');
  if (!tools) return null;
  const q = (id, root = document) => [...root.querySelectorAll(`[data-testid="${id}"]`)];
  const pop = q("more-pop")[0], at = document.activeElement;
  const where = (c) => (pop?.contains(c) ? "popup" : "row");
  const chips = [...q("tchip", tools), ...(pop ? q("tchip", pop) : [])].filter((c) => c.dataset.kind !== "more").map((c) => ({ kind: c.dataset.kind, where: where(c), label: c.textContent.replace(/▾/g, "").trim(), focus: c === at, open: c.getAttribute("aria-expanded") === "true" }));
  const open = chips.find((c) => c.open);
  const lists = [...q("picker"), ...q("dirs")].map((m) => ({ head: m.querySelector('[data-testid="menu-head"]')?.textContent ?? (m.dataset.testid === "dirs" ? "dirs" : ""), where: open?.where ?? "" }));
  return { chips, lists, more: !!pop, focus: at?.closest?.('[data-testid="more-pop"]') ? "popup" : at?.dataset?.testid === "more-chip" ? "more" : at?.closest?.('[data-testid="composer-tools"]') ? "row" : at?.dataset?.testid ?? "" };
}

/** The places of the page's composer (see placesInPage). */
export const placesOf = (page) => page.evaluate(placesInPage);
