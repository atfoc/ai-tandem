// R1's rules walker (no dash in the name: not a check; the check is UX.R1-rules.mjs). The rules of ux-improvements goal 3.1 that hold on
// every phone screen (goal 6.2), read from the page of each screen of goal 6.1 that a recipe reaches through the real navigation, and a
// failure that names the control. PLAN §3 "R1".
//
// A recipe (the groups are in ./rules/*.mjs, each exporting `recipes`; a folder, so the runner takes none of them for a check):
//   {
//     id: "home.four",               group.name; R1_GROUP=home runs the recipes whose id starts with "home."
//     goal: "3.2 · 10a Home v2",     the goal's section and the mockup (by its board title): what coverage.md cites
//     seed: ["UXH1"],                the mock's sections (seedUI); recipes are run in order, the mock restarted when the seed changes
//     state: "UXH1.four",            a state of the seed ("<section>.<id>", or the id alone) (its `pre` before the page, its `ls` and `sel` on the page, its `mock` after), as UX.H1 opens one
//     ls, sel,                       more of the page's storage and selection (aiwb.theme is the walker's)
//     mock: "code",                  run in the mock once the page is open (after the state's)
//     prepare: async (h) => {},      before the page opens (h.url, h.mockEval): what a recipe sets up in the mock (a library, a key)
//     wait: '[data-testid="home"]',  what shows that the page has drawn (default: Home or a content screen)
//     steps: [                       each a screen (or a state of one) reached from the one before, then audited
//       { name: "list",
//         go: async (page, h) => {},  the person's way there: presses, holds, typing (sel.mjs and the areas' helpers)
//         ready: "selector",          waited for after `go` (visible), then the page is let settle
//         rules: { canvas: true },    rules that hold here only: canvas (nothing app-made over Excalidraw's canvas), text17 (default on)
//         skip: ["target"],           rules not read on this step, each with a reason in `why`
//         allow: [{ rule: "target", match: /home-gear/, why: "…" }],   a known exception, matched against the control's name and what failed.
//                                     Only for a reason the goal gives (a link inside a sentence, Excalidraw's own); a real defect too large to
//                                     fix here has a `why` that starts with "DEFECT": it is printed on every run and counted in report.json
//                                     `defects`, never silent. R1_ALL=1 prints every allowed finding too
//         autosend: true,             this screen is Settings › Voice: the one place "Auto-send" may be said
//         check: async (page, h) => {}, a behaviour on this screen (h.fail(line)): what a locator cannot say (delete asks, Undo restores in place)
//       },
//     ],
//     todo: "V1 is not merged",      a recipe that cannot run yet: it is listed as skipped with this reason, never as passed
//     themes: ["light"],             the themes it runs in (default both)
//   }
// A recipe's `go` throws when the way is not there (a press that finds nothing): that is a failure of the recipe, named, and the walker goes
// on with the next recipe.
//
// The rules (each failure line is `<theme> <recipe>/<step>: <rule>: <control> — <what>`; the control is named by its testID and dataSet, the
// nearest ancestor's testID, its role and its label or text):
//   target    every control (a button, link, switch, menu item, tab, input, a focusable element) shown and not covered is 44 × 44 pt or more:
//             its box, widened by its hit slop (react-native-web draws none: read from React's own props, or from a `data-hit="t,r,b,l"` a
//             part writes). A link inside a sentence is not a control of its own here (it is the sentence's line height).
//   text      every text shown is 13 pt or more (secondary text, goal 3.1.1)
//   text17    the controls, lists, sheets and the composer's box use 17 pt (action and picker rows, cells, Home's rows, bars' titles, sheet titles,
//             the search field, the composer's box) and a chat's reading body 16 pt with a line height of 1.5 (goal 3.1.1)
//   words     no desktop word or mark: ⌘, ⌥, Ctrl, "right-click", Esc (goal 3.1.3), in the text and in the labels a screen reader reads;
//             nor the words the goal replaced ("Waiting for you", "Needs attention")
//   title     no `title` attribute (a hover title) on the phone (goal 3.1.3)
//   focus     no focus ring (goal 3.1.3): no element that matches :focus-visible draws an outline or a ring
//   label     every control has a label for a screen reader (goal 4.7)
//   stop      "Stop" is only for stopping the agent (goal 3.7.2): a control labelled Stop is the composer's `stop`
//   sheet     every sheet has its subject in its head: a `sheet-head` with a `sheet-title`, or a P4's `confirm-title` (goal 3.1.4, 6.2)
//   danger    a destructive row (Delete…, Remove…, Clear…, or drawn red) is the last row of its sheet or screen, and red (goal 3.1.4)
//   cancel    no P1 (a sheet of action rows) has a Cancel row (goal 3.1.4)
//   state     a state word (`state-word`) says the words of packages/core/src/logic/statewords.ts for its key (goal 3.1.3, 6.2)
//   autosend  "Auto-send" is said on Settings › Voice (a step with `autosend: true`) and on no other screen (goal 3.7.3)
//   canvas    (steps with rules.canvas) nothing app-made over the board's canvas: every point of a grid over Excalidraw's canvas reaches an
//             element of Excalidraw's own (goal 3.4, 4.4)
import fs from "node:fs";
import path from "node:path";
import { BOARD_WORDS, CHAT_WORDS, SERVER_WORDS } from "../../../packages/core/src/logic/statewords.ts";
import { mockEval, seed, until } from "../shot.mjs";
import { byTid, tidSel } from "./sel.mjs";

export const RULES = ["target", "text", "text17", "words", "title", "focus", "label", "stop", "sheet", "danger", "cancel", "state", "autosend", "canvas"];

/** The words of each state key (statewords.ts), for the page: { key: text }; the keys whose words carry a number or a name are patterns. */
export const STATE_TEXT = Object.fromEntries([...Object.values(SERVER_WORDS), ...Object.values(CHAT_WORDS), ...Object.values(BOARD_WORDS)].map((w) => [w.key, w.text]));
export const STATE_PATTERN = { subagents: "^Waiting on \\d+ subagents?$", working: "^.+ is working…$" };

/** What every screen allows, with the reason (a control of Excalidraw's own is not the app's: goal 4.4). Each { rule, match, why }. */
export const ALLOW = [];

/** The rules read on one screen of the page now. Answers [{ rule, control, what }]. `opts`: { canvas, text17 } (booleans), the state words. */
export async function audit(page, opts = {}) {
  return page.evaluate(auditInPage, { canvas: !!opts.canvas, text17: opts.text17 !== false, stateText: STATE_TEXT, statePattern: STATE_PATTERN });
}

/** In the page: the rules of the screen on top. Plain JavaScript (evaluated as it is). */
function auditInPage(o) {
  const out = [];
  const add = (rule, el, what) => out.push({ rule, control: nameOf(el), what });
  const MIN = 43.5, TEXT = 13; // (sub-pixel: a 44 pt part measures 43.5 in some layouts, as UX.S4's checks found)
  const vw = innerWidth, vh = innerHeight;
  const tidOf = (e) => e?.getAttribute?.("data-testid") ?? "";
  const clean = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  const short = (s, n = 32) => { s = clean(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const excal = (e) => !!e.closest(".excalidraw, .excalidraw-modal-container, .excalidraw-tooltip");

  function dataOf(e) {
    const d = Object.entries(e.dataset ?? {}).filter(([k]) => k !== "testid").slice(0, 3).map(([k, v]) => `${k}=${short(v, 24)}`);
    return d.length ? `[${d.join(" ")}]` : "";
  }
  /** The control's name: its testID and dataSet (or its tag and role), what it says, and the testID it is in. */
  function nameOf(e) {
    if (!e) return "(page)";
    const id = tidOf(e), role = e.getAttribute("role") ?? "";
    const label = e.getAttribute("aria-label") || e.getAttribute("placeholder") || e.innerText || e.textContent || "";
    let inside = "";
    for (let p = e.parentElement; p && !inside; p = p.parentElement) if (tidOf(p) && tidOf(p) !== id) inside = tidOf(p) + dataOf(p);
    return `${id ? id + dataOf(e) : e.tagName.toLowerCase() + (role ? `[role=${role}]` : "")}${label.trim() ? ` "${short(label)}"` : ""}${inside ? ` in ${inside}` : ""}`;
  }
  const styleOf = (e) => getComputedStyle(e);
  /** Drawn: in the tree, of some size, not hidden, not transparent, not under aria-hidden, and inside the window. */
  function shown(e) {
    if (!e.isConnected || e.closest('[aria-hidden="true"], [inert]')) return false;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return false;
    for (let p = e; p && p !== document.body; p = p.parentElement) {
      const s = styleOf(p);
      if (s.visibility === "hidden" || s.display === "none" || +s.opacity < 0.05) return false;
    }
    return true;
  }
  /** Not covered: the point at the middle of the part of it inside the window reaches it (or something inside it). */
  function onTop(e) {
    const r = e.getBoundingClientRect();
    const x = (Math.max(r.left, 0) + Math.min(r.right, vw)) / 2, y = (Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2;
    const at = document.elementFromPoint(x, y);
    return !!at && (e === at || e.contains(at) || at.contains(e) && at.getBoundingClientRect().width <= r.width + 1);
  }
  /** The hit slop React gave the element (react-native-web draws none): `data-hit="t,r,b,l"`, or the `hitSlop` prop of the component
   *  that rendered it (React's fiber, up to the next element of the page). */
  function slopOf(e) {
    const d = e.getAttribute("data-hit");
    if (d) { const [t, r = t, b = t, l = r] = d.split(",").map(Number); return { t, r, b, l }; }
    const key = Object.keys(e).find((k) => k.startsWith("__reactFiber$"));
    let f = key ? e[key] : null;
    for (let i = 0; f && i < 12; i++, f = f.return) {
      if (i > 0 && typeof f.type === "string") break; // (the next element of the page: its props are its own)
      const s = f.memoizedProps?.hitSlop;
      if (s != null) return typeof s === "number" ? { t: s, r: s, b: s, l: s } : { t: s.top ?? 0, r: s.right ?? 0, b: s.bottom ?? 0, l: s.left ?? 0 };
    }
    return { t: 0, r: 0, b: 0, l: 0 };
  }

  // ---- controls: target, label, stop
  const CONTROL = '[role="button"],[role="link"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="switch"],[role="checkbox"],[role="radio"],[role="tab"],[role="option"],a[href],button,input:not([type="hidden"]),textarea,select,[tabindex="0"]';
  const controls = [...document.querySelectorAll(CONTROL)].filter((e) => !excal(e) && shown(e) && onTop(e));
  const seenControl = new Set();
  for (const e of controls) {
    // (a control inside another control of the same box is one target: the outer one is measured)
    const outer = e.parentElement?.closest(CONTROL);
    if (outer && controls.includes(outer)) {
      const a = e.getBoundingClientRect(), b = outer.getBoundingClientRect();
      if (Math.abs(a.width - b.width) < 2 && Math.abs(a.height - b.height) < 2) continue;
    }
    const r = e.getBoundingClientRect(), s = slopOf(e);
    const inline = (e.tagName === "A" || e.getAttribute("role") === "link") && styleOf(e).display.startsWith("inline");
    const w = r.width + s.l + s.r, h = r.height + s.t + s.b;
    if (!inline && (w < MIN || h < MIN)) {
      const n = nameOf(e);
      if (!seenControl.has(n)) { seenControl.add(n); add("target", e, `${Math.round(w * 10) / 10} × ${Math.round(h * 10) / 10} pt${s.t + s.r + s.b + s.l ? ` (box ${Math.round(r.width)} × ${Math.round(r.height)} with its hit slop)` : ""}, not 44 × 44`); }
    }
    const label = clean(e.getAttribute("aria-label") || e.innerText || e.getAttribute("placeholder") || e.getAttribute("aria-labelledby") && document.getElementById(e.getAttribute("aria-labelledby"))?.innerText || e.value || "");
    if (!label) add("label", e, "has no label for a screen reader");
    if (/^stop\b/i.test(label) && tidOf(e) !== "stop") add("stop", e, `says "${short(label)}": "Stop" is only for stopping the agent (the composer's \`stop\`)`);
  }

  // ---- text: 13 pt and more; 17 / 16 where the goal says
  const texts = new Map();
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const p = n.parentElement;
    if (!p || !clean(n.textContent) || excal(p) || p.closest("script, style, noscript, title") || !shown(p) || !onTop(p) && !onTopAny(p)) continue;
    const px = parseFloat(styleOf(p).fontSize);
    if (px < TEXT - 0.01) {
      const k = nameOf(p) + px;
      if (!texts.has(k)) { texts.set(k, 1); add("text", p, `"${short(n.textContent, 24)}" is ${px} pt, not 13 or more`); }
    }
  }
  function onTopAny(p) { // (a text partly covered: any of five points reaches it)
    const r = p.getBoundingClientRect();
    return [[0.5, 0.5], [0.15, 0.5], [0.85, 0.5], [0.5, 0.2], [0.5, 0.8]].some(([fx, fy]) => { const a = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy); return !!a && (p === a || p.contains(a)); });
  }
  if (o.text17) {
    /** The largest text size of the element's own words (the label, not a second line under it). */
    const biggest = (e) => Math.max(0, ...[...e.querySelectorAll("*"), e].filter((x) => [...x.childNodes].some((c) => c.nodeType === 3 && clean(c.textContent))).map((x) => parseFloat(styleOf(x).fontSize)));
    const RAMP = [
      ['[data-testid="action-row"]', 17, "an action row's label", (e) => !e.closest('[data-testid="action-quick"]')],
      ['[data-testid="picker-row"]', 17, "a picker row's label"],
      ['[data-testid="cell"], [data-testid="settings-row"]', 17, "a cell's label"],
      ['[data-testid="home-row-name"]', 17, "a row's name"],
      ['[data-testid="bar-title"], [data-testid="chat-head-name"]', 17, "a bar's title"],
      ['[data-testid="sheet-title"]', 17, "a sheet's title"],
      ['[data-testid="search-field"] input, [data-testid="home-search"] input', 17, "a search field's text", null, true],
      ['[data-testid="composer-input"]', 17, "the composer's box", null, true],
    ];
    for (const [css, px, what, keep, field] of RAMP) {
      for (const e of document.querySelectorAll(css)) {
        if (excal(e) || !shown(e) || !onTop(e) || keep && !keep(e)) continue;
        const size = field ? parseFloat(styleOf(e).fontSize) : biggest(e);
        if (size && size < px - 0.01) add("text17", e, `${what} is ${size} pt, not ${px}`);
      }
    }
    for (const e of document.querySelectorAll('[data-testid="md-p"]')) {
      if (!shown(e) || !onTop(e)) continue;
      const s = styleOf(e), px = parseFloat(s.fontSize), lh = parseFloat(s.lineHeight);
      if (px < 15.99) add("text17", e, `a chat's reading body is ${px} pt, not 16`);
      else if (lh && lh / px < 1.49) add("text17", e, `a chat's reading body has a line height of ${Math.round((lh / px) * 100) / 100}, not 1.5`);
    }
  }

  // ---- words, titles, focus rings
  const DESKTOP = /⌘|⌥|\bCtrl\b|\bCmd\b|right[- ]click|\bEsc\b|\bEscape\b|keyboard shortcut/i;
  const REPLACED = /\bWaiting for you\b|\bNeeds attention\b/;
  /** The person's own words (a message, a draft, a name they typed) are not the app's: the thread's messages and fields' values are skipped. */
  const theirs = (e) => !!e.closest('[data-testid="msg"], [data-testid="md-p"], [data-testid="thread"] pre, input, textarea, [contenteditable="true"]');
  const said = new Set();
  const walk2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk2.nextNode(); n; n = walk2.nextNode()) {
    const p = n.parentElement, t = n.textContent ?? "";
    if (!p || excal(p) || theirs(p) || !(DESKTOP.test(t) || REPLACED.test(t)) || !shown(p)) continue;
    const k = nameOf(p);
    if (!said.has(k)) { said.add(k); add("words", p, `says "${short(t, 40)}": ${REPLACED.test(t) ? "a word the goal replaced" : "a desktop word"}`); }
  }
  for (const e of document.querySelectorAll("[aria-label], [placeholder]")) {
    const t = (e.getAttribute("aria-label") ?? "") + " " + (e.getAttribute("placeholder") ?? "");
    if (excal(e) || !(DESKTOP.test(t) || REPLACED.test(t)) || !shown(e)) continue;
    add("words", e, `its label says "${short(t, 40)}"`);
  }
  for (const e of document.querySelectorAll("[title]")) {
    if (excal(e) || !clean(e.getAttribute("title")) || e.tagName === "IFRAME" || !e.closest("body")) continue;
    add("title", e, `has the hover title "${short(e.getAttribute("title"), 40)}"`);
  }
  for (const e of document.querySelectorAll(":focus-visible")) {
    if (excal(e)) continue;
    const s = styleOf(e);
    const ring = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
    const glow = s.boxShadow && s.boxShadow !== "none" && !(e.matches("input, textarea"));
    if (ring || glow) add("focus", e, `draws a focus ring (${ring ? `outline ${s.outlineWidth} ${s.outlineStyle}` : `box-shadow ${s.boxShadow}`})`);
  }

  // ---- sheets: the head, the destructive row, no Cancel row
  const RED = (c) => { const m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/.exec(c); if (!m) return false; const [r, g, b] = [+m[1], +m[2], +m[3]]; return r > 140 && r > g * 1.35 && r > b * 1.15; };
  const DANGER = /^(Delete|Remove|Clear|Erase|Forget)\b/;
  const labelOf = (e) => clean(e.getAttribute("aria-label") || e.innerText || "");
  const wordsColour = (e) => { const x = [...e.querySelectorAll("*")].find((c) => [...c.childNodes].some((n) => n.nodeType === 3 && clean(n.textContent))) ?? e; return styleOf(x).color; };
  /** The rows of a list (a sheet's or a screen's), in order: action rows (not the quick row), menu items, cells that act. */
  const rowsIn = (root) => [...root.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [data-testid="action-row"], [data-testid="cell"][role="button"], [data-testid="settings-row"]')]
    .filter((e, i, all) => !e.closest('[data-testid="action-quick"]') && all.indexOf(e) === i && shown(e) && !all.some((x) => x !== e && x.contains(e)));
  function dangerRule(root, where) {
    const rows = rowsIn(root);
    rows.forEach((e, i) => {
      const words = labelOf(e), red = RED(wordsColour(e));
      if (!(DANGER.test(words) || red)) return;
      if (i !== rows.length - 1) add("danger", e, `a destructive row is not the last of ${where} (${rows.length - 1 - i} after it: "${short(labelOf(rows[rows.length - 1]))}")`);
      if (!red) add("danger", e, `a destructive row is not drawn red (${wordsColour(e)})`);
    });
  }
  /** A sheet (ui/Sheet.tsx): the box around its grabber and its body. */
  const sheetOf = (h) => { let p = h.parentElement; while (p && (!p.querySelector('[data-testid="sheet-body"]') || p.getBoundingClientRect().width < 1)) p = p.parentElement; return p; };
  const sheets = [...new Set([...document.querySelectorAll('[data-testid="sheet-handle"]')].map(sheetOf))].filter((s) => s && s !== document.body && shown(s));
  for (const s of sheets) {
    const title = s.querySelector('[data-testid="sheet-head"] [data-testid="sheet-title"]') ?? s.querySelector('[data-testid="confirm-title"]');
    if (!title || !clean(title.innerText)) add("sheet", s, "has no head with a title (a `sheet-head` with a `sheet-title`, or a P4's `confirm-title`)");
    dangerRule(s, "its sheet");
    const p1 = s.querySelector('[data-testid="action-row"]');
    for (const r of rowsIn(s)) if (p1 && /^cancel$/i.test(labelOf(r))) add("cancel", r, "a P1 sheet has a Cancel row (the grabber, a tap outside, a swipe down and Back close it)");
  }
  if (!sheets.length) { // (a screen: its own rows, the one on top)
    const screens = [...document.querySelectorAll('[data-testid="pushed-screen"]')].filter(shown);
    const top = screens[screens.length - 1];
    if (top && onTopAny(top)) dangerRule(top, "its screen");
  }

  // ---- state words
  for (const e of document.querySelectorAll('[data-testid="state-word"]')) {
    if (!shown(e)) continue;
    const key = e.dataset.word ?? "", text = clean(e.getAttribute("aria-label") || e.innerText);
    const want = o.stateText[key], pat = o.statePattern[key];
    if (want === undefined && !pat) add("state", e, `the key "${key}" is not in statewords.ts`);
    else if (want !== undefined ? text !== want : !new RegExp(pat).test(text)) add("state", e, `says "${text}" for "${key}", not "${want ?? pat}"`);
  }

  // ---- the canvas
  let canvasFound = null;
  if (o.canvas) {
    const cv = [...document.querySelectorAll(".excalidraw canvas")].filter(shown).sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
    if (!cv) out.push({ rule: "canvas", control: "(page)", what: "no Excalidraw canvas is drawn" });
    else {
      const r = cv.getBoundingClientRect();
      canvasFound = { x: r.x, y: r.y, w: r.width, h: r.height };
      const over = new Map();
      // (the canvas's area is between the board's bar and its bottom row, goal 3.4: the row, Excalidraw's footer with the app's inset, the orb
      // and Edit here, or the pick bar in its place, is the board's chrome and stands over the canvas's own element by design)
      const edge = (css, side) => [...document.querySelectorAll(css)].filter(shown).map((e) => e.getBoundingClientRect()[side]);
      const L = Math.max(r.left, 0), R = Math.min(r.right, vw);
      const T = Math.max(r.top, 0, ...edge('[data-testid="board-bar"]', "bottom"));
      const B = Math.min(r.bottom, vh, ...edge('[data-testid="board-row"], [data-testid="pick-bar"]', "top"));
      canvasFound.area = { top: T, bottom: B };
      // (a sheet, a confirm and their dimmed backdrop are raised over the screen on purpose and go away: goal 3.1.4; the canvas is under them)
      const raised = (e) => sheets.some((sh) => sh.contains(e)) || !!e.closest('[data-testid="overlay-backdrop"]');
      const nameAt = (at) => { let n = at; while (n && !tidOf(n) && n !== document.body) n = n.parentElement; return n ?? at; };
      for (let i = 0; i < 12; i++) for (let j = 0; j < 20; j++) {
        const x = L + 2 + (R - L - 4) * (i / 11), y = T + 2 + (B - T - 4) * (j / 19);
        const at = document.elementFromPoint(x, y);
        if (!at || excal(at) || raised(at)) continue;
        const named = nameAt(at), k = nameOf(named);
        if (!over.has(k)) over.set(k, { e: named, x: Math.round(x), y: Math.round(y) });
      }
      // (what the pointer goes through, pointer-events none, is not reached by a point: an element of the app with something to see, text, a
      // background or a border, inside the area)
      for (const e of document.querySelectorAll("body *")) {
        if (excal(e) || e.contains(cv) || raised(e) || !shown(e)) continue;
        const q = e.getBoundingClientRect(), st = styleOf(e);
        if (q.right <= L + 1 || q.left >= R - 1 || q.bottom <= T + 1 || q.top >= B - 1 || st.pointerEvents !== "none") continue;
        const ink = [...e.childNodes].some((c) => c.nodeType === 3 && clean(c.textContent)) || !/rgba\(0, 0, 0, 0\)|transparent/.test(st.backgroundColor) || parseFloat(st.borderTopWidth) > 0 && !/rgba\(0, 0, 0, 0\)/.test(st.borderTopColor);
        if (!ink) continue;
        const named = nameAt(e), k = nameOf(named);
        if (!over.has(k)) over.set(k, { e: named, x: Math.round(q.x), y: Math.round(q.y) });
      }
      for (const [, v] of over) add("canvas", v.e, `is drawn over the board's canvas (at ${v.x}, ${v.y})`);
    }
  }

  const words = clean(document.body.innerText);
  return { found: out, read: { controls: controls.length, sheets: sheets.length }, autosend: /auto-send/i.test(words) || [...document.querySelectorAll("[aria-label]")].some((e) => shown(e) && /auto-send/i.test(e.getAttribute("aria-label"))), canvas: canvasFound };
}

/** Lets a screen come to rest: two frames with no change of the place of the screen on top, and the fonts loaded. */
export async function settle(page, ms = 4000) {
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForFunction(() => {
    const all = document.querySelectorAll('[data-testid="pushed-screen"], [data-testid="sheet-handle"], [data-testid="home"], [data-testid="chat-head"], [data-testid="board-bar"]');
    const e = all[all.length - 1];
    if (!e) return true;
    const r = (e.parentElement ?? e).getBoundingClientRect(), pos = `${Math.round(r.left)}:${Math.round(r.top)}:${Math.round(r.width)}:${Math.round(r.height)}`;
    const still = window.__r1Settle === pos;
    window.__r1Settle = pos;
    return still;
  }, null, { timeout: ms, polling: 120 }).catch(() => {});
  await page.waitForTimeout(150);
}

/** The recipes of every group (./rules/*.mjs), in the order of the files and, inside each, as written. */
export async function loadRecipes(dir = path.join(path.dirname(new URL(import.meta.url).pathname), "rules")) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) {
    const m = await import(path.join(dir, f));
    for (const r of m.recipes ?? []) out.push({ ...r, file: `rules/${f}` });
  }
  const ids = new Set();
  for (const r of out) { if (ids.has(r.id)) throw new Error(`two recipes are "${r.id}"`); ids.add(r.id); }
  return out;
}

const seedKey = (r) => JSON.stringify(r.seed ?? []);
const matches = (a, f) => (a.rule === f.rule || a.rule === "*") && (a.match === undefined || (a.match instanceof RegExp ? a.match.test(f.control + " " + f.what) : String(f.control).includes(a.match)));

/** Runs the recipes in the themes, in the check's body (`c`: url, mock, open, fail, note). Answers { screens, failures, skipped, report }.
 *  R1_GROUP (comma list of id prefixes) and R1_THEME narrow a run; R1_OUT names the folder of the report (report.json) and the pictures. */
export async function runRecipes(c, recipes, { themes = ["light", "dark"], out } = {}) {
  const want = (process.env.R1_GROUP ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const onlyTheme = process.env.R1_THEME;
  const picked = recipes.filter((r) => !want.length || want.some((w) => r.id === w || r.id.startsWith(w.endsWith(".") ? w : w + ".") || r.id.startsWith(w)));
  const report = { screens: [], skipped: [], failures: [], defects: [] };
  if (out) fs.mkdirSync(out, { recursive: true });
  let seeded = null, states = [];
  for (const theme of themes.filter((t) => !onlyTheme || t === onlyTheme)) {
    for (const r of picked) {
      if (!(r.themes ?? themes).includes(theme)) continue;
      if (r.todo) { if (theme === (onlyTheme ?? themes[0])) { report.skipped.push({ id: r.id, why: r.todo }); c.note(`skipped ${r.id}: ${r.todo}`); } continue; }
      const tag = `${theme} ${r.id}`;
      const bad = (line) => { report.failures.push(`${tag}: ${line}`); c.fail(`${tag}: ${line}`); };
      if (seeded !== seedKey(r) || r.fresh) {
        if (seeded !== null && c.mock) await c.mock.restart();
        states = (r.seed ?? []).length ? await seed(c.url, ...r.seed) : [];
        seeded = seedKey(r);
      }
      const [sec, sid] = r.state?.includes(".") ? r.state.split(".") : [null, r.state];
      const s = r.state ? states.find((x) => x.id === sid && (!sec || x.section === sec)) : null;
      if (r.state && !s) { bad(`the seed ${seedKey(r)} has no state "${r.state}"`); continue; }
      let o;
      try {
        if (s?.pre) await mockEval(s.pre, c.url);
        const h0 = { url: c.url, mockEval: (code) => mockEval(code, c.url), theme };
        if (r.prepare) await r.prepare(h0);
        o = await c.open({ ls: { ...(s?.ls ?? {}), ...(r.ls ?? {}), "aiwb.theme": theme }, ...(s?.sel || r.sel ? { sel: r.sel ?? s.sel } : {}), wait: "" });
        const { page } = o;
        if (s?.mock) await mockEval(s.mock, c.url);
        if (r.mock) await mockEval(r.mock, c.url);
        const ready = r.wait ?? `${tidSel("home")}, ${tidSel("chat-head")}, ${tidSel("board-bar")}`;
        await page.locator(ready).locator("visible=true").first().waitFor({ timeout: 30000 }); // (a list: any one of them shown)
        if (!await until(() => page.evaluate((t) => document.documentElement.dataset.theme === t, theme), 8000)) bad(`the page is not in the ${theme} theme`);
        const h = { ...h0, page, fail: bad, note: c.note, state: s, byTid: (id, d) => byTid(page, id, d) };
        for (const step of r.steps ?? [{ name: "screen" }]) {
          const where = `${step.name}`;
          try {
            if (step.go) await step.go(page, h);
            if (step.ready) await page.locator(step.ready).locator("visible=true").last().waitFor({ timeout: 20000 });
            await settle(page);
          } catch (e) { bad(`${where}: the way there failed: ${String(e?.message ?? e).split("\n")[0]}`); break; }
          const seen = await audit(page, { canvas: !!step.rules?.canvas, text17: step.rules?.text17 });
          const allow = [...ALLOW, ...(r.allow ?? []), ...(step.allow ?? [])];
          const skip = new Set(step.skip ?? []);
          const kept = seen.found.filter((f) => !skip.has(f.rule) && !allow.some((a) => matches(a, f)));
          for (const f of kept) bad(`${where}: ${f.rule}: ${f.control} — ${f.what}`);
          for (const f of seen.found.filter((f) => !kept.includes(f))) {
            const a = allow.find((a) => matches(a, f));
            if (a && /^DEFECT/.test(a.why ?? "")) { report.defects.push(`${tag}: ${where}: ${f.rule}: ${f.control} — ${f.what} (${a.why})`); c.note(`left: ${tag}: ${where}: ${f.rule}: ${f.control} — ${a.why}`); }
            else if (process.env.R1_ALL) c.note(`allowed: ${tag}: ${where}: ${f.rule}: ${f.control} — ${f.what}${a ? ` (${a.why})` : " (skipped rule)"}`);
          }
          if (!skip.has("autosend")) {
            if (seen.autosend && !step.autosend) bad(`${where}: autosend: "Auto-send" is said here; it is only in Settings › Voice`);
            if (!seen.autosend && step.autosend) bad(`${where}: autosend: Settings › Voice does not say "Auto-send"`);
          }
          if (out) await page.screenshot({ path: path.join(out, `${r.id}.${step.name}.${theme}.png`.replace(/[^\w.-]+/g, "_")) }).catch(() => {});
          if (step.check) { try { await step.check(page, h); } catch (e) { bad(`${where}: ${String(e?.message ?? e).split("\n")[0]}`); } }
          report.screens.push({ id: r.id, step: step.name, theme, goal: r.goal, found: kept.length, allowed: seen.found.length - kept.length, read: seen.read });
        }
      } catch (e) { bad(`the page: ${String(e?.message ?? e).split("\n")[0]}`); }
      await o?.ctx.close().catch(() => {});
      if (s?.undo) await mockEval(s.undo, c.url).catch(() => {});
      if (r.undo) await mockEval(r.undo, c.url).catch(() => {});
    }
  }
  if (out) fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 1));
  return report;
}
