// Readers and movers of the phone's row actions (package H2, plans/ux-improvements/h2-design.md §2, §3), shared by the checks that
// change things through them (SEC.5, SEC.4, UX.H2-rows): a left swipe on a row of Home or of a group's screen (`swipe-row` with the
// buttons `swipe-action` dataSet `action` = archive | delete), the long press and its sheet (`row-sheet` dataSet {kind, key}, rows
// `action-row` dataSet `action` = open | rename | move | archive | delete), "Move to…" (`move-sheet`, rows `picker-row`), the Rename sheet
// (`rename-sheet`, `rename-input`, Save `sheet-right`), the toast (`toast`, `toast-action`) and the delete's question (`confirm-dialog`,
// `confirm-go`, `confirm-cancel`). The phone only: the wide layouts' rows act through their menus (sel.mjs `openMenu`).
import { until } from "../shot.mjs";
import { IDS, byTid, longPress, pointerDragger, press, tidSel } from "./sel.mjs";

const WAIT = 15000;

/** The row of Home (`scope` a page) or a group's screen (`scope` the locator of `group-screen`): `kind` "group" | "board" | "chat", `key` its key. */
export const rowIn = (scope, kind, key) => byTid(scope, IDS.homeRow, { kind, key }).first();

/** The names of the actions a row has now, as the page draws them: the swipe's buttons (none until the row is swiped) */
export const swipeButtons = (row) => row.locator('xpath=ancestor::*[@data-testid="swipe-row"][1]').locator('[data-testid="swipe-action"]').evaluateAll((els) => els.map((e) => e.dataset.action));

/** A left swipe with one finger over the row: `full` goes past 60 % of its width (the full swipe, which runs Archive), else far enough
 *  to settle open (past half of the buttons, short of the full swipe). The finger starts past the left edge's 20 pt. */
export async function swipeLeft(page, row, { full = false } = {}) {
  const b = await row.boundingBox();
  if (!b) throw new Error("the page does not show the row to swipe");
  const y = b.y + b.height / 2, from = { x: b.x + b.width - 24, y }, to = { x: b.x + b.width - 24 - (full ? b.width * 0.8 : 150), y };
  const d = await pointerDragger(page, { hold: 0, steps: 12 });
  await d.start(from);
  await d.move(to);
  await d.end();
}

/** Swipes the row open and answers the buttons it shows (their `action` ids, left to right), or [] when none appears. */
export async function swipeOpen(page, row) {
  await swipeLeft(page, row);
  await until(async () => (await swipeButtons(row)).length > 0, 3000);
  return swipeButtons(row);
}

/** The swipe's button `action` of an open row, pressed. */
export const pressSwipe = (page, row, action) =>
  press(page, row.locator('xpath=ancestor::*[@data-testid="swipe-row"][1]').locator(`[data-testid="swipe-action"][data-action="${action}"]`).first());

/** A long press on the row; answers the row's sheet (`row-sheet` of that row), waited for. */
export async function openRowSheet(page, row, kind, key) {
  const sheet = byTid(page, "row-sheet", { kind, key }).last();
  // (the sheet rises when the finger is lifted after the 0.5 s hold, with no move: h2-design.md H2-4)
  await until(async () => !await byTid(page, IDS.backdrop).count(), 5000); // (a sheet that was closing is gone: it takes no touch)
  await longPress(page, row);
  await sheet.waitFor({ state: "visible", timeout: WAIT }).catch(() => { throw new Error(`a long press on the ${kind} row ${key} opens no sheet`); });
  return sheet;
}

/** The `action` ids of the sheet's rows, top to bottom. */
export const sheetActions = (sheet) => byTid(sheet, "action-row").evaluateAll((els) => els.map((e) => e.dataset.action));

/** Presses the sheet's row `action`; the sheet goes (a second sheet rises after it). */
export async function pickAction(page, sheet, action) {
  await press(page, byTid(sheet, "action-row", { action }).first());
  if (!await until(async () => !await sheet.count(), 5000)) throw new Error(`the row's sheet stays after "${action}"`);
}

/** Rename… of the row through its sheet, the new name typed and saved. Answers nothing; the caller reads the call and the list. */
export async function renameThroughSheet(page, row, kind, key, to) {
  const sheet = await openRowSheet(page, row, kind, key);
  await pickAction(page, sheet, "rename");
  const form = byTid(page, "rename-sheet", { kind, key }).last();
  await form.waitFor({ state: "visible", timeout: WAIT });
  const input = byTid(form, "rename-input").first();
  await input.fill(to);
  await press(page, byTid(form, "sheet-right").first());
  if (!await until(async () => !await form.count(), 8000)) throw new Error(`the Rename sheet stays after Save of "${to}"`);
}

/** Move to… of the row through its sheet, the place named by its label in the picker ("Not in a group", "Renders", "Renders › Nightly"). Answers the labels offered. */
export async function moveThroughSheet(page, row, kind, key, place) {
  const sheet = await openRowSheet(page, row, kind, key);
  await pickAction(page, sheet, "move");
  const picker = byTid(page, "move-sheet").last();
  await picker.waitFor({ state: "visible", timeout: WAIT });
  const rows = byTid(picker, "picker-row");
  const offered = (await rows.allTextContents()).map((t) => t.replace(/✓/g, "").trim());
  const at = offered.indexOf(place);
  if (at < 0) throw new Error(`"Move to…" offers ${JSON.stringify(offered)}, not "${place}"`);
  await press(page, rows.nth(at));
  if (!await until(async () => !await picker.count(), 8000)) throw new Error(`the Move to picker stays after "${place}"`);
  return offered;
}

// ---------------------------------------------------------------- Settings › Archived and the "+ New" sheet

// H2's readers over testIDs (no dash in the name: not a check): `archivedSeen`, what Settings › Archived shows now, and `newSheetSeen`, what
// the "+ New" sheet shows now (plans/ux-improvements/h2-design.md §4, §5). The counterparts of home.mjs's `homeSeen`.

/** Settings › Archived as it is now (the screen on top; the page must show it): 
 *    { servers: [{ server, text: the heading's name and state word }], sections: [{ server, group, count, heading }], rows: [{ kind, key, server, name, sub, archived }],
 *      empty: text | null, foot: text | null }
 *  `rows` are in the order drawn; `heading` is a section's upper-case head ("" for the one with none). */
export async function archivedSeen(page) {
  const at = byTid(page, "archived-screen").last();
  return at.evaluate((el) => {
    const q = (s) => [...el.querySelectorAll(s)];
    const tid = (id) => `[data-testid="${id}"]`;
    const text = (e) => (e?.innerText ?? "").replace(/\s+/g, " ").trim();
    return {
      servers: q(tid("archived-server")).map((s) => ({ server: s.dataset.server, text: text(s) })),
      sections: q(tid("archived-section")).map((s) => ({ server: s.dataset.server, group: s.dataset.group, count: Number(s.dataset.count), heading: text(s).replace(/\s*\d+$/, "") })),
      rows: q(tid("home-row")).map((r) => ({
        kind: r.dataset.kind, key: r.dataset.key, server: r.dataset.server, name: text(r.querySelector(tid("home-row-name"))), sub: text(r.querySelector(tid("home-row-sub"))),
        archived: r.dataset.archived === "true",
      })),
      empty: el.querySelector(tid("archived-empty")) ? text(el.querySelector(tid("archived-empty"))) : null,
      foot: el.querySelector(tid("archived-foot")) ? text(el.querySelector(tid("archived-foot"))) : null,
    };
  });
}

/** The names of the things Settings › Archived lists, in the order drawn. */
export const archivedNames = async (page) => (await archivedSeen(page)).rows.map((r) => r.name);

/** The "+ New" sheet as it is now (the one on top), or null when none is drawn:
 *    { page: "what" | "where", group, where?: text (page 1's card), tiles: [id] (new-chat, new-board, new-group in the order drawn),
 *      crumbs: [{ group, text }], put?: { group, text, chosen }, levels: [{ group, text }] } */
export async function newSheetSeen(page) {
  const sheet = byTid(page, "home-new-sheet").last();
  if (!await sheet.isVisible().catch(() => false)) return null;
  return sheet.evaluate((el) => {
    const q = (s) => [...el.querySelectorAll(s)];
    const tid = (id) => `[data-testid="${id}"]`;
    const text = (e) => (e?.innerText ?? "").replace(/\s+/g, " ").trim();
    const put = el.querySelector(tid("new-put"));
    return {
      page: el.dataset.page, group: el.dataset.group ?? "",
      where: el.querySelector(tid("new-where")) ? text(el.querySelector(tid("new-where"))) : undefined,
      tiles: ["new-chat", "new-board", "new-group"].filter((id) => el.querySelector(tid(id))),
      crumbs: q(tid("new-crumb")).map((c) => ({ group: c.dataset.group, text: text(c) })),
      put: put ? { group: put.dataset.group, text: text(put), chosen: /✓/.test(put.innerText) } : undefined,
      levels: q(tid("new-level")).map((l) => ({ group: l.dataset.group, text: text(l) })),
    };
  });
}

/** Presses Home's (or a group screen's) "+ New" and waits for the sheet's first page. */
export async function openNew(page) {
  await press(page, byTid(page, "home-new").last());
  await byTid(page, "home-new-sheet").last().waitFor({ state: "visible", timeout: 15000 });
}

// ---------------------------------------------------------------- UX.H2-rows's readers (prefixed h2): a sheet, Archived, search, the size sweep, dark

const text = (e) => (e?.innerText ?? e?.textContent ?? "").replace(/\s+/g, " ").trim();

/** The sheet `root` (a locator of one sheet: row-sheet, rename-sheet, home-new-sheet, move-sheet, confirm-sheet, …) as it reads now:
 *    { title, sub, items: [{ action, label, note, tone }], height }
 *  `title`/`sub` are the head's two lines; `items` the ActionSheet's rows (`action-row`) with their `data-action`, label (the row's text without its
 *  note) and the note at the right (13 pt muted), `tone` "danger" when the row's text is red-ish (its colour has more red than green and blue). */
export async function h2Sheet(page, root) {
  return root.first().evaluate((el) => {
    const q = (s) => [...el.querySelectorAll(s)];
    const tid = (id) => `[data-testid="${id}"]`;
    const txt = (e) => (e?.innerText ?? "").replace(/\s+/g, " ").trim();
    const red = (e) => { const m = /rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/.exec(getComputedStyle(e).color); return !!m && +m[1] > 150 && +m[1] > +m[2] + 60 && +m[1] > +m[3] + 60; };
    return {
      title: txt(el.querySelector(tid("sheet-title"))), sub: txt(el.querySelector(tid("sheet-sub"))), height: el.getBoundingClientRect().height,
      items: q(tid("action-row")).map((r) => {
        const spans = [...r.querySelectorAll("div,span")].filter((s) => s.children.length === 0 && txt(s));
        return { action: r.dataset.action, label: txt(spans[0] ?? r), note: spans.length > 1 ? txt(spans[spans.length - 1]) : "", tone: spans.some(red) ? "danger" : "", height: r.getBoundingClientRect().height };
      }),
    };
  });
}

/** Settings › Archived as it reads now: { servers: [{ server, name, word, sections: [{ group, heading, count, rows: [{ kind, key, name, sub, height }] }], away }], none, foot }.
 *  A heading is the section's text without its count; a server with no list of its own says `away` (the line under its heading). */
export async function h2Archived(page) {
  return page.locator(tidSel("archived-screen")).last().evaluate((el) => {
    const tid = (id) => `[data-testid="${id}"]`;
    const txt = (e) => (e?.innerText ?? "").replace(/\s+/g, " ").trim();
    const out = [];
    let cur = null, sec = null;
    // (the blocks are siblings in document order: a server heading, then its sections' heads and rows)
    for (const n of el.querySelectorAll(`${tid("archived-server")}, ${tid("archived-section")}, ${tid("home-row")}`)) {
      if (n.matches(tid("archived-server"))) { cur = { server: n.dataset.server, name: txt(n.firstElementChild), word: txt(n.querySelector(tid("state-word"))), sections: [], away: "" }; out.push(cur); sec = null; }
      else if (n.matches(tid("archived-section"))) { sec = { group: n.dataset.group, heading: txt(n).replace(/\s*\d+$/, ""), count: Number(n.dataset.count), rows: [] }; cur?.sections.push(sec); }
      else if (sec) sec.rows.push({ kind: n.dataset.kind, key: n.dataset.key, archived: n.dataset.archived === "true", name: txt(n.querySelector(tid("home-row-name"))), sub: txt(n.querySelector(tid("home-row-sub"))), height: n.getBoundingClientRect().height });
    }
    for (const s of out) { const h = el.querySelector(`${tid("archived-server")}[data-server="${s.server}"]`); const next = h?.nextElementSibling; if (next && !next.querySelector(tid("home-row")) && /connected/i.test(txt(next))) s.away = txt(next); }
    return { servers: out, none: txt(el.querySelector(tid("archived-empty"))), foot: txt(el.querySelector(tid("archived-foot"))) };
  });
}

/** Home's search as it reads now:
 *    { scope, state, field, scopes: [{ scope, selected }], recent: [words], clear: bool, sections: [{ section, count }],
 *      rows: [{ kind, key, server, stale, name, bold, sub, opacity, height }], none: text }
 *  `bold` is the part of the name in weight 600 or more (the matched part), "" when the name has none; `opacity` the row's own (a faded hit: below 0.6). */
export async function h2Search(page) {
  return page.locator(tidSel("search")).last().evaluate((el) => {
    const q = (s) => [...el.querySelectorAll(s)];
    const tid = (id) => `[data-testid="${id}"]`;
    const txt = (e) => (e?.innerText ?? "").replace(/\s+/g, " ").trim();
    const field = el.querySelector(tid("search-field"));
    return {
      scope: el.dataset.scope, state: el.dataset.state, field: field?.value ?? "",
      scopes: q(tid("search-scope")).map((c) => ({ scope: c.dataset.scope, selected: c.dataset.selected === "true", label: txt(c) })),
      recent: q(tid("search-recent")).map((r) => r.dataset.words),
      clear: !!el.querySelector(tid("search-clear")),
      sections: q(tid("search-section")).map((s) => ({ section: s.dataset.section, count: Number(s.dataset.count) })),
      rows: q(tid("search-row")).map((r) => {
        const name = r.firstElementChild?.nextElementSibling?.firstElementChild;
        const bold = [...(name?.querySelectorAll("*") ?? [])].filter((s) => s.children.length === 0 && +getComputedStyle(s).fontWeight >= 600).map((s) => s.textContent).join("");
        const lines = [...r.querySelectorAll("div")].filter((d) => d.children.length === 0 && txt(d));
        return { kind: r.dataset.kind, key: r.dataset.key, server: r.dataset.server, stale: r.dataset.stale === "true", name: txt(name), bold, sub: txt(lines[lines.length - 1]), opacity: Number(getComputedStyle(r).opacity), height: r.getBoundingClientRect().height };
      }),
      none: txt(el.querySelector(tid("search-none"))),
    };
  });
}

/** At the phone: the text inside every element `roots` (a CSS selector) matches is at least 13 px, and every button the elements hold has a target of 44 × 44
 *  or more (but the testIDs in `slop`, which a hit slop widens on a device and react-native-web does not draw). A target is the element's box, or, where the page widens it with a hit slop (react-native-web), the box that answers the pointer: the points
 *  21.5 px above, below, left and right of its centre still reach it. Answers the lines that fail (each names what is wrong). */
export async function h2Sweep(page, roots, { slop = [] } = {}) {
  return page.evaluate(([css, slop]) => {
    const out = [];
    const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden" && +getComputedStyle(e).opacity > 0; };
    const els = [...document.querySelectorAll(css)];
    if (!els.length) return ["nothing to sweep: no element matches " + css];
    const reach = (b, dx, dy) => { const r = b.getBoundingClientRect(), p = document.elementFromPoint(r.x + r.width / 2 + dx, r.y + r.height / 2 + dy); return !!p && b.contains(p); };
    for (const el of els) {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const p = n.parentElement;
        if (!n.textContent.trim() || !p || !seen(p) || p.closest("[data-kit-small]")) continue;
        const px = parseFloat(getComputedStyle(p).fontSize);
        if (px < 13) out.push(`text "${n.textContent.trim().slice(0, 30)}" is ${px} px`);
      }
      for (const b of el.querySelectorAll('[role="button"],[role="switch"],[role^="menuitem"],[role="radio"],button')) {
        if (!seen(b) || b.closest("[data-kit-small]") || slop.includes(b.getAttribute("data-testid"))) continue;
        const r = b.getBoundingClientRect();
        const w = r.width >= 43.5 || (reach(b, -21.5, 0) && reach(b, 21.5, 0)), h = r.height >= 43.5 || (reach(b, 0, -21.5) && reach(b, 0, 21.5));
        if (!w || !h) out.push(`${b.getAttribute("role") ?? b.tagName.toLowerCase()} "${(b.getAttribute("aria-label") ?? b.textContent ?? "").trim().slice(0, 30)}" [${b.getAttribute("data-testid") ?? ""}] is ${Math.round(r.width * 10) / 10} × ${Math.round(r.height * 10) / 10}`);
      }
    }
    return [...new Set(out)];
  }, [roots, slop]);
}

/** Whether the surface behind the element `css` matches is dark (the dark theme drew it) and its text light: { dark, light, bg, fg }. The surface is the first
 *  ancestor (itself included) whose background is not transparent. */
export async function h2Dark(page, css) {
  return page.locator(css).first().evaluate((el) => {
    const parse = (c) => { const m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[, /]+([\d.]+))?/.exec(c); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : [0, 0, 0, 0]; };
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    let s = el; while (s && parse(getComputedStyle(s).backgroundColor)[3] < 0.5) s = s.parentElement;
    const bg = s ? parse(getComputedStyle(s).backgroundColor) : [255, 255, 255, 1];
    const word = [...el.querySelectorAll("*")].find((e) => e.children.length === 0 && (e.textContent ?? "").trim()) ?? el;
    const fg = parse(getComputedStyle(word).color);
    return { dark: lum(bg) < 0.2, light: lum(fg) > 0.35, bg: bg.slice(0, 3).join(","), fg: fg.slice(0, 3).join(",") };
  });
}
