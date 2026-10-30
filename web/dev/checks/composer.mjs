// The readers of the composer for the checks of the new build (package K3; the counterparts of the old driver's `measureComposer`,
// `composerProbe`, `toolbarWidths` and of the seed's `see` selectors, which read the old page's classes). No dash in the name: the runner
// does not take it for a check. The testIDs of screens/composer, with their dataSet in brackets:
//   composer [chat, branch] · composer-box [readonly] · composer-input (the chip input) · composer-tools [more, meter, insert, voice] (the toolbar's
//   row) · tool [control: server | agent | folder | model | subagents] (a control of the row; a fixed folder's `lock` stands before
//   its chip) · tchip [kind, fixed, connected?] (a chip: a button, or static; the model's, "<model> · <effort>", has [effort] and opens model-menu,
//   the model and effort menu: model-menu-search, model-menu-clear, effort-seg with segment [value, on], effort-line, model-menu-row [model, on,
//   active], model-menu-empty, model-menu-held, model-menu-done, model-menu-keys; plans/model-effort-menu/design.md 3.3) · more-chip · part [part: more | meter | insert | attach | stop |
//   send | voice] (what stands in the row besides the controls) · tool-grow · ctx-meter [tone: error, compact] · send [sending] · stop · insert-btn ·
//   voice-dictate [on] · voice-speech [on] (voice's pair, Dictate and Speech mode, after the row's spacer, before the attach button: they are in `part` "voice", one
//   child of the row, and `composer-tools` says where the pair is in its `voice`: row | more) · more-row [control: dictate | speech] with more-dictate [on] and more-speech [on]
//   (the pair as two entries of the popup) · voice-problem (the popover of a voice problem) ·
//   agent-reason [tone: missing] · more-pop (the popup, over the page) with more-row [control: …] and more-insert · picker (a list) with
//   picker-search, pick-row [optionId] · dirs (the folder browser) with dir-input, dir-item, dir-use, dir-err · context-row · ctx-chip ·
//   ctx-act [kind: selection | point, on] · ctx-note · composer-err · model-notice [warn] · archived-bar ·
//   voice-notice (voice devices VD-14: the one-sentence line of a device that was missing or went away, above the box, the speech bar or the archived
//   bar; empty at rest) · speech-paused and speech-continue (the speech bar's pause sentence and its Continue).
// At the phone layout (a window under 700 px, whatever the viewport; ux-improvements C1) the composer is another tree: composer-phone-tools (the
// toolbar's row: composer-plus, a spacer, ctx-meter [compact], composer-dictate, and the primary: composer-talk while the box is empty, send once
// something is typed, stop while the agent works) in the same composer-box; the choices are tchip in composer-chip-row (a row that scrolls sideways,
// none in a started chat; no "more" chip, no popup of the row); the readers below take either toolbar (`toolsOf` in the page) and the primary is
// whichever of send / stop / composer-talk is there. `isNarrow(w)` says whether a window of w px is the phone layout.
// The phone's chip row (ux-improvements C2): `tchip` [kind: agent | folder | model | subagents, missing] in composer-chip-row, with no effort chip (the
// effort is in the model sheet; the model chip says "<model> · <effort>") and no "more" chip; a fork with no message of its own has the model chip
// alone and chip-note. Each chip opens a sheet: agent-sheet (kit PickerSheet: picker-row [value], picker-check, picker-foot; a tap picks and closes) ·
// model-sheet (model-menu-row [model = the model's id, on], effort-seg with segment [value, on], model-menu-done and model-menu-cancel; a model or
// effort pick is a draft and keeps it open, Done applies it) ·
// folder-sheet (dir-up, dir-path (a tap shows dir-input), dir-item [aria-label = the name], dir-use "Use <name>", dir-err, dir-empty, dir-browser;
// Cancel = sheet-left; a pick closes it) · sub-sheet (sub-depth with sub-opt [section, value, on], the cap's slider sub-cap (slider.mjs), sub-cap-line; Done = sheet-right). The helpers of the
// phone, all taking the page: `phoneChip(page, kind)` the chip's locator in the row; `openChoice(page, kind)` presses it and answers the sheet's locator
// once it is open; `pickModelPhone(page, id)`, `pickEffortPhone(page, effort)`, `pickAgentPhone(page, agent)`, `pickFolderPhone(page, name)`,
// `pickDepthPhone(page, n)`, `setCapPhone(page, n)` (a tap on the cap slider's track at the place of n, 1 to 100) open the sheet when it is not open, make the pick and leave the sheet as the app does (the model,
// effort, depth and cap picks keep it open, the model and effort ones a draft until Done; an agent or a folder pick closes it); `closeChoice(page)` closes the open sheet (Done, else Cancel, else a
// press on the backdrop) and waits until none is open; `openSheetKind(page)` says which is open.
import { byTid, tidSel } from "./sel.mjs";
import { tapSlider } from "./slider.mjs";

/** In the page: the first composer's box and toolbar for a frame. null while none is drawn; else how many controls of the row end past the
 *  box, by how much, whether Send is the element at its own centre, and whether the document scrolls sideways. bad: any of them. (The
 *  frame sampler sends it as text: no closure.) */
export function composerProbe() {
  const q = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);
  const box = q("composer-box"), tools = box && (q("composer-tools", box) ?? q("composer-phone-tools", box));
  if (!tools) return null;
  const right = box.getBoundingClientRect().right;
  let past = 0, by = 0;
  for (const e of tools.children) {
    if (e.dataset.testid === "tool-grow") continue;
    const over = e.getBoundingClientRect().right - right;
    if (over > 0.5) { past++; by = Math.max(by, Math.round(over)); }
  }
  const sd = q("send", tools) ?? (tools.dataset.testid === "composer-phone-tools" ? q("stop", tools) ?? q("composer-talk", tools) : null), r = sd?.getBoundingClientRect(); // (the phone's empty box shows Talk)
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
    const rows = [...kids('[data-testid="composer-tools"], [data-testid="composer-phone-tools"]').map((e) => one(e, "tools")), ...kids('[data-testid="context-row"]').map((e) => one(e, "context")), ...kids('[data-testid="fk-banner"]').map((e) => one(e, "banner"))];
    const over = rows.filter((x) => x.overBox > 0.5), sd = box.querySelector('[data-testid="send"]') ?? box.querySelector('[data-testid="composer-phone-tools"] [data-testid="stop"], [data-testid="composer-talk"]'); // (the phone's empty box shows Talk)
    let send = "none";
    if (sd) { const q = R(sd), h = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); send = h === sd || sd.contains(h) ? "ok" : h ? "covered by " + label(h) : "outside the window"; }
    return { chat: comp.dataset.chat, pane: pane?.dataset.testid ?? "", paneW: pane ? r1(R(pane).width) : 0, boxW: r1(b.width), boxOverPane: pane ? r1(b.right - R(pane).right) : 0,
      past: over.length, furthest: over.reduce((m, x) => Math.max(m, x.overBox), 0), over, send, docScroll: document.documentElement.scrollWidth - innerWidth, rows };
  });
}

/** The fit of every composer on the page (see composersInPage). */
export const measureComposer = (page) => page.evaluate(composersInPage);

/** In the page: the controls of the first composer's toolbar, left to right, each with its kind (server, agent, lock, folder, model: the
 *  chip of the model and its effort that opens their menu, model-effort: the fixed chip of both, loading, subagents, more: the chip of the popup that holds what the row has no room for, meter,
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
  "plain-fork-fresh": [{ tid: "tchip", data: { kind: "model", fixed: false } }],
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

/** What the same states draw in the phone layout (a window under 700 px; ux-improvements C1): the chips are the choices in the chip row above the box
 *  (a new chat's agent, folder, model · effort and subagents; a fork's or a move's model alone, with its note: the effort has no chip, it is in the
 *  model sheet), so a started chat has none (its settings are in Chat info), and a new chat whose server was dropped has no choice to draw the reason
 *  line beside. The rest of `SEES` is the same. */
export const SEES_PHONE = {
  "plain-started": [{ tid: "composer-box" }],
  "plain-started-long": [{ tid: "composer-box" }],
  "board-started": [{ tid: "composer-box" }],
  "board-long": [{ tid: "composer-box" }],
  "plain-off-new": [{ tid: "composer-box" }],
  // (the phone's chip is one kind of chip, `fixed: false` (ChipRow.tsx PhoneChip), disabled while the catalog is not here: the wide toolbar's
  // "fixed" chip, one that never opens a popup, has no phone counterpart; goal 4.10)
  "plain-loading": [{ tid: "tchip", data: { kind: "model" }, text: "Loading models" }],
  // (a fork with no message of its own has the model chip alone, with its note; the effort is in the model sheet)
  "plain-fork-fresh": [{ tid: "tchip", data: { kind: "model" } }, { tid: "chip-note", text: "Only the model can change" }],
  // (the phone's header (T1's PhoneHeader) has no `chat-head-server`: its sub-line, `chat-head-sub`)
  "plain-remote-new": [{ tid: "chat-head-sub" }],
  "plain-remote-started": [{ tid: "chat-head-sub" }],
  "plain-remote-started-long": [{ tid: "chat-head-sub" }],
};

/** The `SEES` of a state: at the phone layout (`phone`) with the phone's own where it draws otherwise. */
export const seesOf = (id, phone) => (phone && SEES_PHONE[id]) || SEES[id] || [{ tid: "composer-box" }];

/** The chip of a kind in the toolbar's row (or in the open "more" popup, after the row's): `byTid(page, "tchip", { kind })`. */
export const chip = (page, kind, data = {}) => byTid(page, "tchip", { kind, ...data });

/** The locator of the "more" chip and the popup, the row the popup has for a control. */
export const MORE = tidSel("more-chip"), POP = tidSel("more-pop");
export const moreRow = (page, control) => byTid(page, "more-row", { control });

// ---- the wide layouts' model and effort menu (plans/model-effort-menu/design.md 2.5; the testIDs: the header)

/** The model and effort menu (the desktop's and the tablet's popover), and its search field. */
export const MENU = tidSel("model-menu"), MENU_SEARCH = tidSel("model-menu-search");
const MENU_MS = 8000;

/** Opens the model and effort menu from the model chip, the row's or the "more" popup's (the popup is opened first when the chip is in it);
 *  answers the menu's locator once it is open. */
export async function openModelMenu(page) {
  const menu = page.locator(MENU);
  // (open, or opening: its chip was pressed and says so)
  if (await menu.count() || await page.locator(`${tidSel("tchip", { kind: "model" })}[aria-expanded="true"]`).count()) { await menu.first().waitFor({ state: "visible", timeout: MENU_MS }); return menu; }
  const inRow = byTid(page, "composer-tools").locator(tidSel("tchip", { kind: "model", fixed: "false" }));
  if (!await inRow.count() && !await page.locator(POP).count() && await page.locator(MORE).count()) {
    await press(page, page.locator(MORE).first());
    await page.locator(POP).first().waitFor({ state: "visible", timeout: MENU_MS });
  }
  await press(page, page.locator(tidSel("tchip", { kind: "model", fixed: "false" })).first());
  await menu.first().waitFor({ state: "visible", timeout: MENU_MS });
  return menu;
}

/** Drafts in the model and effort menu (opened from the chip when it is not open) and applies the draft with Done: `model` a model's id (its
 *  row's data-model) or `text` what its row says (a string or a RegExp), then `effort` an effort's id (its segment's value); waits until the
 *  menu is closed. */
export async function pickInMenu(page, { model, text, effort } = {}) {
  const menu = await openModelMenu(page);
  if (model || text) {
    const rows = byTid(menu, "model-menu-row", model ? { model } : {});
    await press(page, (text ? rows.filter({ hasText: text }) : rows).first());
  }
  if (effort) {
    const seg = byTid(menu, "effort-seg");
    await press(page, byTid(seg, "segment", { value: effort }));
    await byTid(seg, "segment", { value: effort, on: "true" }).waitFor({ state: "attached", timeout: MENU_MS });
  }
  await press(page, byTid(menu, "model-menu-done"));
  await menu.first().waitFor({ state: "detached", timeout: MENU_MS });
}

/** In the page: the open model and effort menu as it is drawn, or null: the search's text and whether it has the focus, the drafted model's
 *  id (the row with data-on), the efforts of the effort control with the one drafted, the effort line's text, the rows' models in their order,
 *  whether Done is enabled, the empty line, the key hints. */
export const menuOf = (page) => page.evaluate(() => {
  const m = document.querySelector('[data-testid="model-menu"]');
  if (!m) return null;
  const q = (id) => m.querySelector(`[data-testid="${id}"]`), all = (id) => [...m.querySelectorAll(`[data-testid="${id}"]`)];
  const search = q("model-menu-search"), done = q("model-menu-done");
  return {
    query: search?.value ?? null, focused: !!search && document.activeElement === search,
    model: all("model-menu-row").find((r) => r.dataset.on === "true")?.dataset.model ?? "",
    rows: all("model-menu-row").map((r) => r.dataset.model),
    efforts: all("segment").map((s) => s.dataset.value), effort: all("segment").find((s) => s.dataset.on === "true")?.dataset.value ?? "",
    line: q("effort-line")?.textContent ?? "",
    done: !!done && done.getAttribute("aria-disabled") !== "true" && !done.hasAttribute("disabled"),
    empty: !!q("model-menu-empty"), keys: q("model-menu-keys")?.textContent ?? "",
  };
});

// ---- the phone's chips and their sheets (ux-improvements C2; the header says what each sheet holds)

/** The sheet each phone chip opens. */
export const CHOICE_SHEETS = { agent: "agent-sheet", folder: "folder-sheet", model: "model-sheet", subagents: "sub-sheet" };
const SETTLE_MS = 8000; // (a sheet rises, and a pick is saved by the mock: seconds, not frames)

/** The chip of a kind (agent | folder | model | subagents) in the phone's chip row. */
export const phoneChip = (page, kind) => byTid(byTid(page, "composer-chip-row"), "tchip", { kind });

/** Which of the four sheets is open ("agent" | "folder" | "model" | "subagents"), or "" when none. */
export async function openSheetKind(page) {
  for (const [kind, id] of Object.entries(CHOICE_SHEETS)) if (await byTid(page, id).count()) return kind;
  return "";
}

/** Presses the chip of a kind in the chip row and waits for its sheet; answers the sheet's locator. */
export async function openChoice(page, kind) {
  const id = CHOICE_SHEETS[kind];
  if (!id) throw new Error(`no sheet for the chip kind ${kind}`);
  await press(page, phoneChip(page, kind));
  const sheet = byTid(page, id);
  await sheet.waitFor({ state: "visible", timeout: SETTLE_MS });
  return sheet;
}

/** The sheet of a kind, opened from its chip when it is not open. */
const sheetOf = async (page, kind) => ((await byTid(page, CHOICE_SHEETS[kind]).count()) ? byTid(page, CHOICE_SHEETS[kind]) : openChoice(page, kind));

/** Taps the model `id` (its row's data-model) in the model sheet; the sheet stays open, the model drafted (Done applies it: closeChoice). */
export async function pickModelPhone(page, id) {
  const sheet = await sheetOf(page, "model");
  await press(page, byTid(sheet, "model-menu-row", { model: id }));
  await byTid(sheet, "model-menu-row", { model: id, on: "true" }).waitFor({ state: "attached", timeout: SETTLE_MS });
}

/** Taps the effort `effort` in the model sheet's effort control; the sheet stays open, the effort drafted (Done applies it: closeChoice). */
export async function pickEffortPhone(page, effort) {
  const sheet = await sheetOf(page, "model");
  const seg = byTid(sheet, "effort-seg");
  await press(page, byTid(seg, "segment", { value: effort }));
  await byTid(seg, "segment", { value: effort, on: "true" }).waitFor({ state: "attached", timeout: SETTLE_MS });
}

/** Taps the agent `agent` ("claude" | "cursor" | "pi") in the agent sheet; the sheet closes with the pick. */
export async function pickAgentPhone(page, agent) {
  const sheet = await sheetOf(page, "agent");
  await press(page, byTid(sheet, "picker-row", { value: agent }));
  await sheet.waitFor({ state: "detached", timeout: SETTLE_MS });
}

/** In the folder sheet, taps the folder `name` of the list and then "Use <name>"; the sheet closes with the pick. */
export async function pickFolderPhone(page, name) {
  const sheet = await sheetOf(page, "folder");
  await press(page, sheet.locator(`${tidSel("dir-item")}[aria-label=${JSON.stringify(name)}]`).first());
  await press(page, byTid(sheet, "dir-use").filter({ hasText: `Use ${name}` }).first());
  await sheet.waitFor({ state: "detached", timeout: SETTLE_MS });
}

/** Taps the depth `n` in the subagents sheet (section "depth"; 0 is Off); the sheet stays open. */
export async function pickDepthPhone(page, n) { return pickSubOpt(page, "depth", n); }
/** Sets the cap `n` (1 to 100, "Running at once") on the subagents sheet's slider with a tap on its track at the place of n; the sheet stays open. */
export async function setCapPhone(page, n) {
  const sheet = await sheetOf(page, "subagents");
  await tapSlider(page, "sub-cap", n);
  await byTid(sheet, "sub-cap", { value: n }).waitFor({ state: "attached", timeout: SETTLE_MS });
}
async function pickSubOpt(page, section, n) {
  const sheet = await sheetOf(page, "subagents");
  await press(page, byTid(sheet, "sub-opt", { section, value: n }));
  await byTid(sheet, "sub-opt", { section, value: n, on: "true" }).waitFor({ state: "attached", timeout: SETTLE_MS });
}

/** Closes the sheet that is open (Done, else Cancel, else a press on the backdrop above the sheet) and waits until none is. (The model sheet's
 *  Done applies its draft, model-menu-done; its Cancel is model-menu-cancel.) */
export async function closeChoice(page) {
  const kind = await openSheetKind(page);
  if (!kind) return;
  const done = page.locator(`${tidSel("sheet-right")}, ${tidSel("model-menu-done")}`), cancel = page.locator(`${tidSel("sheet-left")}, ${tidSel("model-menu-cancel")}`);
  if (await done.count()) await press(page, done.first());
  else if (await cancel.count()) await press(page, cancel.first());
  else await press(page, byTid(page, "overlay-backdrop").last(), { position: { x: 5, y: 5 } });
  if (!await until(async () => !(await openSheetKind(page)), SETTLE_MS)) throw new Error(`the ${kind} sheet did not close`);
}

// ---- opening a seeded state

import { paneSize, until } from "../shot.mjs";
import { act, press } from "./sel.mjs";

export const SIDE = 264, RAIL = 40, HEIGHT = 640;

/** Whether a window of `w` px is the phone layout (AD-72: under 700 px, whatever the viewport it is opened on). */
export const isNarrow = (w) => w < 700;

/** Whether the state can be played at a layout ("move" is a pending move started from a message's Branch action: `acts.move` of sel.mjs): "select" selects all the shapes of the canvas with a click and ⌘A, which a mouse does (the
 *  desktop); the tablet's touch has no such select-all, and the phone does not show the canvas under the chat. */
export const playable = (s, layout = "desktop") => !(s.act === "select" && layout !== "desktop");

/** The width of the window that gives a chat page `w` px: a window under 700 px is the phone layout (AD-72), whose chat screen is as wide
 *  as the window, with no sidebar beside it; from 700 px the sidebar is beside the page (wide layouts) and the window is that much wider. */
export const pageWindow = (w) => (w < 700 ? w : SIDE + w);

/** States whose composer is V1's block in the phone layout (goal 3.7): there is no toolbar, no chip row and no Send, and the block says why. The "noagent" block stands in
 *  the box's place (no box either, and the empty thread does not repeat it); the "offline" block stands in the toolbar's place, under the read-only box with the
 *  draft. `narrow`: the window is the phone layout (a viewport of the phone, or a window under 700 px); from 700 px the wide composer is drawn, as for the others. */
export const BLOCKED = {
  "plain-noagent-installed": { kind: "noagent", place: "box", says: "No agent is installed on Bare box" },
  "plain-off-new": { kind: "offline", place: "toolbar", says: "is offline" },
  "plain-off-started": { kind: "offline", place: "toolbar", says: "is offline" },
};
export const blocked = (s, narrow) => (narrow ? BLOCKED[s.id] : undefined);

/** Holds what a blocked state draws instead of the toolbar: V1's block of its kind in its place, saying why, once, and no Send or toolbar beside it (and no box, input or
 *  Send beside a block in the box's place; the box with a block in the toolbar's). Answers whether it held. */
export async function blockHeld(page, fail, name, b) {
  const block = byTid(page, "composer-block", { kind: b.kind, place: b.place });
  if (!await until(async () => (await block.count()) === 1, 10000)) return fail(`${name}: the phone's composer block is not the one ${b.kind} block in the ${b.place}'s place (${await block.count()})`), false;
  const text = await block.first().textContent();
  if (!text.includes(b.says)) return fail(`${name}: the ${b.kind} block says ${JSON.stringify(text)}, not "${b.says}"`), false;
  const drawn = async (id) => byTid(page, id).count();
  if (await drawn("send") || await drawn("composer-phone-tools")) return fail(`${name}: the phone draws Send or its toolbar beside the ${b.kind} block`), false;
  if (b.place === "box" ? await drawn("composer-box") || await drawn("composer-input") : !await drawn("composer-box")) return fail(`${name}: the phone ${b.place === "box" ? "draws the box or its input beside the block in the box's place" : "has no box (with the draft) over the block in the toolbar's place"}`), false;
  return true;
}

/** Opens a seeded state at a width: on the desktop in a window and with saved widths that give its pane (a panel beside a board, a chat
 *  page) that width (the pane is `s.pane[0]`); on the tablet and the phone the device's own width is what the layout has, so none is set.
 *  Its `act` is played, and the fonts are ready. The page is the composer's: `wait` is Send, in the phone layout (the phone viewport, or a window
 *  under 700 px on any viewport) the box (its empty box shows Talk, not Send: ux-improvements C1). */
export async function openState(open, s, layout, width, o = {}) {
  const base = layout === "desktop" && width ? paneSize(s.pane[0], width, HEIGHT) : {};
  // (the desktop layout starts at 1100 px, so a panel beside a board in a narrower window than that is the tablet layout's)
  const win = base.size ? { ...base, size: [s.pane[0] === "page" ? pageWindow(width) : Math.max(1100, base.size[0]), HEIGHT] } : base;
  const w = (o.size ?? win.size)?.[0]; // (the window's width when this call names one; else the viewport's own)
  const narrow = layout === "phone" || (w !== undefined && isNarrow(w));
  const p = await open({ sel: s.sel, ...win, wait: tidSel(!narrow ? "send" : BLOCKED[s.id]?.place === "box" ? "composer-block" : "composer-input"), ...o });
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
  const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height }; };
  const t = q("composer-tools") ?? q("composer-phone-tools"), phone = t.dataset.testid === "composer-phone-tools", kids = [...t.children].filter((e) => e.dataset.testid !== "tool-grow");
  return { ...v, phone, more: !!q("more-pop"), held: document.querySelectorAll('[data-testid="more-pop"] [data-testid="more-row"]').length,
    chips: t.querySelectorAll('[data-testid="tchip"]:not([data-kind="more"])').length, ring: !!t.querySelector('[data-testid="ctx-meter"][data-compact]'),
    list: !!q("overlay-backdrop"), hidden: !!q("side-rail"),
    out: Math.round(Math.max(...kids.map((e) => e.getBoundingClientRect().right - t.getBoundingClientRect().right)) * 10) / 10,
    send: Math.min(...[...t.querySelectorAll('[data-testid="send"], [data-testid="stop"]')].map((e) => e.getBoundingClientRect().width)),
    // the phone's toolbar (composer-phone-tools): "+" and the primary (Talk, Send or Stop) are drawn inside the box, 44 pt targets
    ...(phone ? { plus: rect(q("composer-plus", t)), main: rect(t.querySelector('[data-testid="send"], [data-testid="stop"], [data-testid="composer-talk"]')), room: rect(q("composer-box")) } : {}) };
}` };

/** In the page: the toolbar's row as one measurement at rest (A2.2's `row`): how far apart the centres of its controls are, how far the
 *  furthest ends past the row, and the widths of Stop and Send. */
export const rowOf = (page) => page.evaluate(() => {
  const tools = document.querySelector('[data-testid="composer-tools"]') ?? document.querySelector('[data-testid="composer-phone-tools"]');
  if (!tools) return null;
  const phone = tools.dataset.testid === "composer-phone-tools";
  const kids = [...tools.children].filter((e) => e.dataset.testid !== "tool-grow"), mid = kids.filter((e) => e.dataset.testid !== "agent-reason").map((e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; });
  return { phone, lines: Math.round(Math.max(...mid) - Math.min(...mid)), out: Math.round(Math.max(...kids.map((e) => e.getBoundingClientRect().right - tools.getBoundingClientRect().right)) * 10) / 10,
    send: phone ? [] : [...tools.querySelectorAll('[data-testid="send"], [data-testid="stop"]')].map((e) => e.getBoundingClientRect().width) };
});

/** In the page: what the phone layout's composer is made of and where, against its box and its pane (null: no composer, or the wide one). plus: "+" and
 *  whether it is the element at its own centre; main: the primary (Talk, Send or Stop), the same; ring: the context ring is in the row; targets: the
 *  least height and width of the row's buttons; chipRow: the sideways-scrolling row of choices (null in a started chat): its width against the pane's and
 *  its content's, and the chips that stand in it; more: a "more" chip or popup (the phone has none); ends: how far the row's controls end past the box. */
export const phoneFitOf = (page) => page.evaluate(() => {
  const q = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);
  const comp = q("composer"), box = comp && q("composer-box", comp), tools = box && q("composer-phone-tools", box);
  if (!tools) return null;
  const R = (e) => { const r = e.getBoundingClientRect(); return { left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 }; };
  const atCentre = (e) => { const r = e.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return h === e || e.contains(h); };
  const plus = q("composer-plus", tools), main = tools.querySelector('[data-testid="send"], [data-testid="stop"], [data-testid="composer-talk"]'), ring = q("ctx-meter", tools);
  const b = box.getBoundingClientRect(), pane = comp.closest('[data-testid="chat-page"], [data-testid="board-panel"], [data-testid="board-stage"]'), rowEl = q("composer-chip-row", comp);
  const buttons = [plus, main, q("composer-dictate", tools), ring?.dataset.tone === "error" ? null : ring].filter(Boolean).map((e) => R(e));
  return { plus: plus ? { ...R(plus), ok: atCentre(plus), label: plus.getAttribute("aria-label") } : null, main: main ? { ...R(main), id: main.dataset.testid, ok: atCentre(main) } : null, ring: !!ring,
    targetH: Math.min(...buttons.map((x) => x.height)), targetW: Math.min(...buttons.map((x) => x.width)),
    chipRow: rowEl ? { width: R(rowEl).width, left: R(rowEl).left, right: R(rowEl).right, scrollWidth: rowEl.scrollWidth, chips: rowEl.querySelectorAll('[data-testid="tchip"]').length, kinds: [...rowEl.querySelectorAll('[data-testid="tchip"]')].map((c) => c.dataset.kind) } : null,
    more: !!q("more-chip") || !!q("more-pop"), paneW: pane ? R(pane).width : 0, boxW: Math.round(b.width * 10) / 10, boxLeft: Math.round(b.left * 10) / 10, boxRight: Math.round(b.right * 10) / 10,
    ends: Math.round(Math.max(...[...tools.children].filter((e) => e.dataset.testid !== "tool-grow").map((e) => e.getBoundingClientRect().right - b.right)) * 10) / 10,
    starts: Math.round(Math.min(...[...tools.children].map((e) => e.getBoundingClientRect().left - b.left)) * 10) / 10, innerWidth };
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
 *  what it says and whether it has the focus; the lists open (a picker's, the folder's browser; at the phone the chip sheets, headed by their titles), each with where the chip it was opened from is
 *  (one list is open at a time: its chip says `aria-expanded`); whether "more" is open; where the focus is; `phone`: the page has the phone layout's
 *  composer, whose chips are in the chip row. (A2.3's `placesInPage`.) */
function placesInPage() {
  const q = (id, root = document) => [...root.querySelectorAll(`[data-testid="${id}"]`)];
  // (the phone layout has the choices in the chip row above the box, none in a popup: where is always "row", `phone` is true)
  const phone = !document.querySelector('[data-testid="composer-tools"]') && !!document.querySelector('[data-testid="composer-phone-tools"]');
  const tools = document.querySelector('[data-testid="composer-tools"]') ?? document.querySelector('[data-testid="composer-chip-row"]');
  if (!tools && !phone) return null;
  const pop = q("more-pop")[0], at = document.activeElement;
  const where = (c) => (pop?.contains(c) ? "popup" : "row");
  const chips = [...(tools ? q("tchip", tools) : []), ...(pop ? q("tchip", pop) : [])].filter((c) => c.dataset.kind !== "more").map((c) => ({ kind: c.dataset.kind, where: where(c), label: c.textContent.replace(/▾/g, "").trim(), focus: c === at, open: c.getAttribute("aria-expanded") === "true" }));
  const open = chips.find((c) => c.open);
  // (the phone's lists are the chip sheets: agent-sheet, model-sheet, folder-sheet, sub-sheet, each with its title for the head)
  const sheets = ["agent-sheet", "model-sheet", "folder-sheet", "sub-sheet"].flatMap((id) => q(id));
  const lists = [...q("picker"), ...q("model-menu"), ...q("dirs"), ...sheets].map((m) => ({ head: m.querySelector('[data-testid="menu-head"], [data-testid="sheet-title"]')?.textContent ?? (m.dataset.testid === "dirs" ? "dirs" : ""), where: open?.where ?? (sheets.includes(m) ? "row" : "") }));
  return { phone, chips, lists, more: !!pop, focus: at?.closest?.('[data-testid="more-pop"]') ? "popup" : at?.dataset?.testid === "more-chip" ? "more" : at?.closest?.('[data-testid="composer-tools"], [data-testid="composer-chip-row"]') ? "row" : at?.dataset?.testid ?? "" };
}

/** The places of the page's composer (see placesInPage). */
export const placesOf = (page) => page.evaluate(placesInPage);
