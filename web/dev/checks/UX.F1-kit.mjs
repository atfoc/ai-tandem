// UX.F1 (ux-improvements package F1, plans/ux-improvements/PLAN.md §2 F1): the phone kit of app/src/ui on its gallery
// (`/?gallery=kit`, app/src/dev/KitGallery.tsx), at the phone (iPhone 15, touch) and the desktop (1280×800, mouse). Each section of
// the gallery is proved by its own module of kit/ (one per section file of app/src/dev/kit/), run in the gallery's order:
//   sizes    Button `touch`/`block`, IconButton `touch`, the switch's touch variant, SecretInput's eye and mono, DialogActions stacked,
//            SearchField (44 pt, 17 pt, clear and Cancel); the opt-in sizes are 44 pt (50 pt for `block`) and 17 pt text, and the
//            `md`/`sm` sizes are what they were.
//   sheets   Sheet's detents (fit: up to 50 % of the window, scrolls past; large: to the top safe area less 8 pt) and its sticky head;
//            SheetHead centred and start-aligned; ActionSheet (P1): 50 pt rows, 17 pt labels, 13 pt notes, a waiting row faded and
//            disabled, the destructive row last after a separator, no Cancel row.
//   picker   PickerSheet (P2): the chosen row's aria-checked and ✓, a tap picks and closes, Done with `extra`, search pinned past
//            eight options on the large detent, filtering, "no match" and clear.
//   forms    FormSheet (P3): Cancel · Title · Save, Save off until it can save, the guard on a dirty form (a P4 over the P3), the
//            busy and error states; ConfirmSheet (P4): tile, 20 pt title, 50 pt full-width button, Cancel, busy and error inside;
//            the shell's `confirm()` as a sheet at the phone and today's centred dialog on the desktop.
//   cells    CellGroup/Cell (P5) 48 pt cells, chevrons; PlaceBar, ContentBar (two-line title, ≤ 2 actions of 44 pt), LargeTitle.
//   toast    showToast: one `toast` with its kind, announced (aria-live polite), 48 px high with 13 px text and a 44 px action, inside
//            the window; Undo runs and hides it, a second toast replaces the first, it is gone after its time (5 s by default), and a
//            bottom bar's lift puts it above the bar; the action's text has a contrast of 4.5 in light, dark and mocha.
//   swipe    SwipeRow by finger: a left swipe shows the actions (88 pt, full height), a full swipe runs the `full` one, one row
//            open at a time, a tap elsewhere closes, nothing within 20 pt of the left edge; a mouse drag does nothing.
// Sweeps (phone only): after each section, and inside every sheet a module opens (`c.sweep`), the text is at least 13 px and every
// button, switch, menuitem and radio is at least 44 px high and wide; what the gallery marks `data-kit-small` (the `md` and `sm`
// cases of the sizes section) is left out. The gallery's own title row and theme buttons are outside the sections.
// Themes (phone only, `themes` below): dark, then the Catppuccin flavour mocha, then light again: the gallery's ground is the theme's,
// every section's text has the contrast WCAG asks (4.5:1; 3:1 for 17 px semibold and larger) against the colour behind it, and so has
// an ActionSheet and a ConfirmSheet opened on it. The behaviour of the sections is not run again per theme.
//
// Focus (phone only, `noRing`): a sheet opened by a press (ActionSheet, PickerSheet, a Menu in a Sheet) draws no focus ring on any element
//   (goal 3.1.3): the focus is inside the sheet (its root), nothing in it is `:focus-visible` with an outline, and Tab goes to a control inside it.
// Run: `cd web && npm run uicheck -- UX.F1`, or alone: node web/dev/checks/UX.F1-kit.mjs (VIEWPORT=phone, DIST=… as README.md says).
// No server of the app is needed: the gallery shows no chat.
import { check, until } from "../shot.mjs";
import * as sizes from "./kit/sizes.mjs";
import * as sheets from "./kit/sheets.mjs";
import * as picker from "./kit/picker.mjs";
import * as forms from "./kit/forms.mjs";
import * as cells from "./kit/cells.mjs";
import * as toast from "./kit/toast.mjs";
import * as swipe from "./kit/swipe.mjs";

export const viewports = ["desktop", "phone"];

const SECTIONS = { sizes, sheets, picker, forms, cells, toast, swipe };
const sel = (id) => `[data-testid="${id}"]`;

async function body({ page, viewport, layout, fail, note }) {
  const touch = viewport !== "desktop";
  const T = (id) => page.locator(sel(id));
  /** The box of the first element `css` names, in CSS px, or null. */
  const rect = (css) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom } : null; }, css);
  /** The boxes of every element `css` names. */
  const rects = (css) => page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; }), css);
  /** The computed font size (px) of the first element `css` names (a Text of react-native-web carries its own size). */
  const fontPx = (css) => page.evaluate((s) => { const e = document.querySelector(s); return e ? parseFloat(getComputedStyle(e).fontSize) : null; }, css);
  /** The smallest font size (px) of the visible text inside `css`. */
  const minFontPx = (css) => page.evaluate((s) => {
    let min = Infinity;
    for (const root of document.querySelectorAll(s)) {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!n.textContent.trim() || !n.parentElement) continue;
        const r = n.parentElement.getBoundingClientRect(); if (!r.width || !r.height) continue;
        min = Math.min(min, parseFloat(getComputedStyle(n.parentElement).fontSize));
      }
    }
    return min === Infinity ? null : min;
  }, css);
  const text = async (id) => ((await T(id).first().textContent()) ?? "").trim();
  const press = (loc, opts) => (touch ? loc.tap(opts) : loc.click(opts));
  /** Opens a case of the gallery by its button `kit-open-<name>`. */
  const open = async (name) => { const b = T(`kit-open-${name}`).first(); await b.scrollIntoViewIfNeeded(); await press(b); };
  const win = () => page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
  const expect = (ok, what) => { if (!ok) fail(what); return ok; };
  /** Waits until the box of the first element `css` names is the same in two animation frames ~100 ms apart (a sheet rises, fades and
   *  settles), then gives it; null when it never settles (or is not there) within `ms`. */
  const settled = (css, ms = 8000) => page.evaluate(([s, limit]) => new Promise((done) => {
    const box = () => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height] : null; };
    const frame = () => new Promise((f) => requestAnimationFrame(f));
    const end = Date.now() + limit;
    (async () => {
      while (Date.now() < end) {
        await frame();
        const a = box();
        await new Promise((w) => setTimeout(w, 100));
        await frame();
        const b = box();
        if (a && b && a.every((v, i) => Math.abs(v - b[i]) <= 0.5)) { const [x, y, w, h] = b; return done({ x, y, w, h, right: x + w, bottom: y + h }); }
      }
      done(null);
    })();
  }), [css, ms]);
  /** At the phone: the text inside `root` (every element it names) is at least 13 px and every button, switch, menuitem and radio at
   *  least 44 × 44, but what has `data-kit-small` on it or above it. `what` names the place in a failure. Does nothing elsewhere. */
  const sweep = async (root, what) => {
    if (viewport !== "phone") return;
    const bad = await page.evaluate((rootCss) => {
      const out = [];
      const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
      const roots = [...document.querySelectorAll(rootCss)];
      if (!roots.length) return ["nothing to sweep: no element matches"];
      for (const el of roots) {
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const p = n.parentElement;
          if (!n.textContent.trim() || !p || p.closest("[data-kit-small]") || !seen(p)) continue;
          const px = parseFloat(getComputedStyle(p).fontSize);
          if (px < 13) out.push(`text "${n.textContent.trim().slice(0, 30)}" is ${px} px`);
        }
        for (const b of el.querySelectorAll('[role="button"],[role="switch"],[role^="menuitem"],[role="radio"],button')) {
          if (b.closest("[data-kit-small]") || !seen(b)) continue;
          const r = b.getBoundingClientRect();
          if (r.width < 43.5 || r.height < 43.5) out.push(`${b.getAttribute("role") ?? b.tagName.toLowerCase()} "${(b.getAttribute("aria-label") ?? b.textContent ?? "").trim().slice(0, 30)}" [${b.getAttribute("data-testid") ?? ""}] is ${Math.round(r.width * 10) / 10} × ${Math.round(r.height * 10) / 10}`);
        }
      }
      return out;
    }, root);
    if (bad.length) fail(`sweep ${what ?? root}: ${[...new Set(bad)].slice(0, 6).join("; ")}${bad.length > 6 ? ` … (${bad.length})` : ""}`);
  };
  /** The contrast of the visible text inside `root` against the colour behind it: 4.5:1, 3:1 for 17 px at weight 600 and over (and for
   *  24 px). Faded rows (aria-disabled) are left out: a disabled control is exempt. `what` names the place in a failure. */
  const contrast = async (root, what) => {
    const res = await page.evaluate((rootCss) => {
      const cv = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      const parse = (css) => {
        const m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(css.trim());
        if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : +m[4]];
        cv.clearRect(0, 0, 1, 1); cv.fillStyle = "#000"; cv.fillStyle = css; cv.fillRect(0, 0, 1, 1);
        const d = cv.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255];
      };
      const over = (top, under) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1); };
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const bad = []; let counted = 0; let worst = Infinity;
      for (const el of document.querySelectorAll(rootCss)) {
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const p = n.parentElement, s = n.textContent.trim();
          if (!s || !p || p.closest('[aria-disabled="true"]')) continue;
          const r = p.getBoundingClientRect(); if (!r.width || !r.height) continue;
          const cs = getComputedStyle(p); if (cs.visibility === "hidden") continue;
          // the colour behind: the translucent layers up to the first opaque one, laid over each other from below; and the opacity above
          const layers = []; let opacity = 1, unknown = false;
          for (let e = p; e; e = e.parentElement) {
            const st = getComputedStyle(e);
            opacity *= parseFloat(st.opacity);
            if (st.backgroundImage !== "none") { unknown = true; break; }
            const bg = parse(st.backgroundColor);
            if (bg[3] > 0) { layers.push(bg); if (bg[3] >= 1) break; }
          }
          if (unknown) continue;
          let ground = layers.length && layers.at(-1)[3] >= 1 ? layers.pop() : [255, 255, 255, 1];
          while (layers.length) ground = over(layers.pop(), ground);
          const fg0 = parse(cs.color); fg0[3] *= opacity;
          const fg = over(fg0, ground);
          const px = parseFloat(cs.fontSize), large = (px >= 17 && parseInt(cs.fontWeight, 10) >= 600) || px >= 24;
          const need = large ? 3 : 4.5, got = ratio(fg, ground);
          counted++; worst = Math.min(worst, got - need);
          if (got < need) bad.push(`"${s.slice(0, 24)}" (${px} px${large ? " semibold" : ""}) ${got.toFixed(2)}:1, needs ${need}`);
        }
      }
      return { bad, counted };
    }, root);
    if (!res.counted) fail(`contrast ${what ?? root}: no text found to measure`);
    else if (res.bad.length) fail(`contrast ${what ?? root}: ${[...new Set(res.bad)].slice(0, 6).join("; ")}${res.bad.length > 6 ? ` … (${res.bad.length})` : ""}`);
  };
  const c = { page, viewport, layout, touch, fail, note, T, sel, rect, rects, fontPx, minFontPx, text, press, open, win, near, expect, until, settled, sweep, contrast };

  expect(await until(async () => (await text("gallery-layout")) === layout), `the kit gallery says the layout is ${await text("gallery-layout")}, not ${layout}`);
  for (const [name, m] of Object.entries(SECTIONS)) {
    if (!(await T(`kit-section-${name}`).count())) { fail(`the gallery has no section ${name}`); continue; }
    try { await m.run(c); } catch (e) { fail(`${name}: ${e?.stack ?? e}`); }
    await T(`kit-section-${name}`).scrollIntoViewIfNeeded();
    await sweep(sel(`kit-section-${name}`), `section ${name}`);
  }
  if (viewport === "phone") { await noRing(c); await themes(c); }
}

/** Goal 3.1.3, phone only: no focus ring is ever drawn. A sheet that opens by a press (an ActionSheet, a PickerSheet, a Menu in a Sheet)
 *  must not leave its first row focus-visible with an outline; no element inside it may be both `:focus-visible` and outlined. (X1 chunk 1:
 *  ui/modal.web.tsx used to focus the first tabbable of every overlay, which Chromium draws a ring on.) */
async function noRing(c) {
  const { page, T, until, settled, expect } = c;
  const probe = (root) => page.evaluate((rootCss) => {
    const info = (e) => {
      const cs = getComputedStyle(e);
      return `${e.tagName.toLowerCase()}[${e.getAttribute("data-testid") ?? e.getAttribute("role") ?? ""}] focus-visible=${e.matches(":focus-visible")} outline=${cs.outlineStyle} ${cs.outlineWidth}`;
    };
    const ringed = (e) => e.matches(":focus-visible") && getComputedStyle(e).outlineStyle !== "none" && parseFloat(getComputedStyle(e).outlineWidth) > 0;
    const sheet = document.querySelector(rootCss), at = document.activeElement;
    const bad = [];
    if (at && at !== document.body && ringed(at)) bad.push(`the focused element ${info(at)}`);
    for (const e of sheet?.querySelectorAll("*") ?? []) if (ringed(e)) bad.push(info(e));
    return { bad, at: at ? info(at) : "none", inside: !!sheet && !!at && (sheet.contains(at) || !!at.closest('[aria-modal="true"]')) };
  }, root);
  const cases = [["action", '[data-testid="action-sheet"]', "ActionSheet"], ["picker-short", '[aria-modal="true"] [role="radio"], [aria-modal="true"]', "PickerSheet"], ["fit-long", '[data-testid="sheet"]', "Menu in a Sheet"]];
  // How the sheet is opened decides what Chromium's :focus-visible heuristic says about a script's focus(): by a touch (the opener keeps a
  // non-visible focus), by the keyboard (Enter on the focused opener: the next script focus is visible), and with nothing focused (a
  // script's click on a blurred opener: the case of a sheet opened from a control that takes no focus, or whose focus is gone).
  const ways = {
    touch: async (b) => { await b.scrollIntoViewIfNeeded(); await b.tap(); },
    keyboard: async (b) => { await b.scrollIntoViewIfNeeded(); await b.focus(); await page.keyboard.press("Enter"); },
    nothing: async (b) => { await b.scrollIntoViewIfNeeded(); await b.evaluate((e) => { e.blur(); e.click(); }); },
  };
  for (const [way, openIt] of Object.entries(ways)) for (const [name, css, what] of cases) {
    await openIt(T(`kit-open-${name}`).first());
    const root = name === "picker-short" ? '[aria-modal="true"]' : css;
    if (!expect(await until(async () => !!(await c.rect(root))), `focus ring (${way}): no ${what} after ${name} was pressed`)) continue;
    await settled(root);
    const r = await probe(root);
    expect(!r.bad.length, `focus ring (${way}): ${what} opened with a ring: ${r.bad.slice(0, 3).join("; ")}`);
    expect(r.inside, `focus ring (${way}): ${what} opened and the focus is not in it (${r.at})`);
    await page.keyboard.press("Tab");
    const after = await page.evaluate((s) => { const e = document.activeElement, root = document.querySelector(s); return { inside: !!root && !!e && root.contains(e) && e !== root, name: e ? `${e.tagName.toLowerCase()}[${e.getAttribute("data-testid") ?? ""}]` : "none" }; }, root);
    expect(after.inside, `focus ring (${way}): ${what}: Tab from the opened sheet did not go to a control inside it (${after.name})`);
    await page.keyboard.press("Escape");
    expect(await until(async () => !(await c.rect(root))), `focus ring (${way}): ${what} did not close on Esc`);
  }
}

// The ground of each theme the gallery can show (tokens.ts `bg`; the flavour's from core/logic/flavours.ts), and the <html> `data-flavour`.
const GROUNDS = { light: "rgb(255, 255, 255)", dark: "rgb(28, 28, 33)", mocha: "rgb(30, 30, 46)" };
const SHOWN = { light: "light", dark: "dark", mocha: "dark" }; // (what `gallery-theme` reads: a flavour sits on light or dark)

/** Dark, the flavour mocha, and light again: the ground, and the contrast of every section's text, of an ActionSheet and of a ConfirmSheet. */
async function themes(c) {
  const { page, T, sel, press, open, text, expect, until, settled, contrast } = c;
  const ground = () => page.evaluate(() => {
    for (let e = document.querySelector('[data-testid="kit-gallery"]'); e; e = e.parentElement) { const bg = getComputedStyle(e).backgroundColor; if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg; }
    return null;
  });
  const flavour = () => page.evaluate(() => document.documentElement.dataset.flavour ?? "");
  const noSheet = () => until(async () => !(await T("action-sheet").count()) && !(await T("confirm-sheet").count()));
  const closeSheet = async () => { await page.keyboard.press("Escape"); await noSheet(); };
  await T("kit-gallery").evaluate((e) => e.scrollTo?.(0, 0)).catch(() => {});
  for (const theme of ["dark", "mocha", "light"]) {
    await press(T(`gallery-theme-${theme}`));
    if (!expect(await until(async () => (await ground()) === GROUNDS[theme]), `theme ${theme}: the gallery's ground is ${await ground()}, not ${GROUNDS[theme]}`)) continue;
    expect((await text("gallery-theme")) === SHOWN[theme], `theme ${theme}: the readout says "${await text("gallery-theme")}", not "${SHOWN[theme]}"`);
    expect((await flavour()) === (theme === "mocha" ? "mocha" : ""), `theme ${theme}: <html> has the flavour "${await flavour()}"`);
    if (theme === "light") break;
    await contrast('[data-testid^="kit-section-"]', `${theme}: sections`);
    await open("action");
    if (await settled('[data-testid="action-sheet"]')) await contrast('[data-testid="action-sheet"]', `${theme}: ActionSheet`);
    else c.fail(`theme ${theme}: no ActionSheet to measure`);
    await closeSheet();
    await open("confirm");
    if (await settled('[data-testid="confirm-sheet"]')) await contrast('[data-testid="confirm-sheet"]', `${theme}: ConfirmSheet`);
    else c.fail(`theme ${theme}: no ConfirmSheet to measure`);
    await closeSheet();
    expect(await noSheet(), `theme ${theme}: a sheet was left open`);
  }
}

await check("UX.F1 the phone kit of ui/ on its gallery", body, { viewports, page: { query: "gallery=kit", wait: sel("kit-gallery") } });
