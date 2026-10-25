// S1's helpers over the phone's Settings screens (no dash in the name: not a check). Settings is a screen of the phone's stack that
// Home's gear pushes; Appearance and About are pushed from its rows. The theme is chosen in Appearance (the Theme rows and the
// flavour sheet), where the wide layouts keep the sidebar foot's `theme-btn` menu.
//
//   atRest(page, id)           waits for the screen on top with that testID to be visible and still (a pushed screen slides in)
//   openSettings(page)         pushes Settings (Home's gear when it is there, else the uicheck build's seam) and waits for it at rest
//   openRow(page, row)         presses Settings' row (servers, library, archived, voice, appearance, about) and waits for its screen
//   openAppearance(page)       Settings (pushed when not on screen) › Appearance, at rest; it does nothing when Appearance is on top
//   pickTheme(page, pref)      light | dark | system by the Theme rows, a flavour (latte, frappe, macchiato, mocha) by the flavour sheet
//   openFlavours(page)         the flavour row pressed: the sheet, waited to be open
//   pickFlavour(page, f)       the flavour sheet's row for f pressed (the sheet closes), waited to be gone
//   closeFlavours(page)       the flavour sheet closed by a press on the dimmed page above it (Esc if that does not), waited to be gone
//   readAppearance(page)      Appearance as it is now, the sheet opened and closed: { checkedRows, ticks, flavour: {attr, text}, sheet: [{value, text, checked}], marked }
//   themeNow(page)             { theme, flavour, bg, saved }: <html>'s data-theme and data-flavour, its background, the kv key `aiwb.theme`
//   rowsOf(page)               Appearance's theme rows as { theme, checked } in the order drawn
//   stackKeys(page)            the keys of the phone's stack (the uicheck build's seam)
//   settingsText(page)         { servers: {text, warn}, … }: the second line or value each Settings row says
import { byTid, press, tidSel } from "./sel.mjs";

const WAIT = 15000;

/** The screen on top with the testID, visible and not moving (its left edge the same in two frames). */
export async function atRest(page, id, timeout = WAIT) {
  await byTid(page, id).last().waitFor({ state: "visible", timeout });
  const key = "__atRest_" + id;
  await page.waitForFunction(([id, key]) => {
    const all = document.querySelectorAll(`[data-testid="${id}"]`), e = all[all.length - 1];
    if (!e) return false;
    const r = e.getBoundingClientRect(), pos = Math.round(r.left) + ":" + Math.round(r.top);
    const still = window[key] === pos;
    window[key] = pos;
    return still && r.width > 0 && document.documentElement.scrollWidth <= innerWidth;
  }, [id, key], { timeout, polling: "raf" });
}

const onTop = (page, id) => byTid(page, id).last().isVisible().catch(() => false);

export const stackKeys = (page) => page.evaluate(() => window.__aiwbStack.entries().map((e) => e.key));

/** Settings pushed, from Home's gear when the page has it, else through the uicheck build's seam, and waited for at rest. */
export async function openSettings(page) {
  const gear = byTid(page, "home-gear").first();
  if (await gear.isVisible().catch(() => false)) await press(page, gear);
  else await page.evaluate(() => window.__aiwbStack.push("settings", {}));
  await atRest(page, "settings-screen");
}

/** A row of Settings pressed; its screen (a placeholder is `settings-placeholder` with the row's name, a real one has its own testID). */
export async function openRow(page, row, screenId) {
  await press(page, byTid(page, "settings-row", { row }).last());
  if (screenId) await atRest(page, screenId);
}

/** Appearance on top, whatever is on screen: Settings is pushed when it is not, and Appearance from it. */
export async function openAppearance(page) {
  if (await onTop(page, "appearance-screen")) return;
  if (!(await onTop(page, "settings-screen"))) await openSettings(page);
  await openRow(page, "appearance", "appearance-screen");
}

export async function openFlavours(page) {
  await openAppearance(page);
  await press(page, byTid(page, "flavour-row").last());
  await byTid(page, "flavour-sheet").last().waitFor({ state: "visible", timeout: WAIT });
  // (the sheet slides up: its rows are read once they are still and inside the window)
  await atRest(page, "picker-row");
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('[data-testid="flavour-sheet"] [data-testid="picker-row"]')];
    return rows.length > 0 && rows.every((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  }, null, { timeout: WAIT });
}

const sheetGone = (page) => page.waitForFunction(() => !document.querySelector('[data-testid="flavour-sheet"]'), null, { timeout: WAIT });

export async function pickFlavour(page, flavour) {
  if (!(await onTop(page, "flavour-sheet"))) await openFlavours(page);
  await press(page, byTid(page, "flavour-sheet").last().locator(tidSel("picker-row", { value: flavour })).first());
  await sheetGone(page);
}

export async function closeFlavours(page) {
  if (!(await onTop(page, "flavour-sheet"))) return;
  await page.touchscreen.tap(page.viewportSize().width / 2, 30);
  await sheetGone(page).catch(async () => { await page.keyboard.press("Escape"); });
  await sheetGone(page);
}

export async function pickTheme(page, pref) {
  if (["latte", "frappe", "macchiato", "mocha"].includes(pref)) return pickFlavour(page, pref);
  await openAppearance(page);
  await press(page, byTid(page, "theme-row", { theme: pref }).last());
}

/** What the page is in now. */
export const themeNow = (page) => page.evaluate(() => ({
  theme: document.documentElement.dataset.theme ?? null,
  flavour: document.documentElement.dataset.flavour ?? null,
  bg: getComputedStyle(document.documentElement).backgroundColor,
  saved: localStorage.getItem("aiwb.theme"),
}));

/** The theme rows as drawn, with the one that is checked. */
export const rowsOf = (page) => page.evaluate(() => {
  const screen = [...document.querySelectorAll('[data-testid="appearance-screen"]')].pop();
  return [...(screen?.querySelectorAll('[data-testid="theme-row"]') ?? [])].map((e) => ({ theme: e.dataset.theme, checked: e.dataset.checked, tick: e.textContent.includes("✓") }));
});

/** Appearance as it is now: the Theme rows that are checked (and whether the ✓ is drawn on exactly those), the flavour row (its data-flavour and its words),
 *  and the flavour sheet's rows in the order drawn, with the ones aria-checked. The sheet is opened for it and closed again. */
export async function readAppearance(page) {
  await openAppearance(page);
  const rows = await rowsOf(page);
  const flavour = await page.evaluate(() => {
    const e = [...document.querySelectorAll('[data-testid="flavour-row"]')].pop();
    return { attr: e?.dataset.flavour ?? null, text: e?.innerText.replace(/\s+/g, " ").trim() ?? "" };
  });
  await openFlavours(page);
  const sheet = await page.evaluate(() => {
    const s = [...document.querySelectorAll('[data-testid="flavour-sheet"]')].pop();
    return [...s.querySelectorAll('[data-testid="picker-row"]')].map((e) => ({ value: e.dataset.value, text: e.innerText.replace(/\s+/g, " ").trim(), checked: e.getAttribute("aria-checked") }));
  });
  await closeFlavours(page);
  return {
    themes: rows.map((r) => r.theme), checkedRows: rows.filter((r) => r.checked === "true").map((r) => r.theme), ticks: rows.every((r) => (r.checked === "true") === r.tick),
    flavour, sheet, marked: sheet.filter((r) => r.checked === "true").map((r) => r.value),
  };
}

/** What each Settings row says at its second line or at its right, and whether that line is the amber warning colour. */
export const settingsText = (page) => page.evaluate(() => {
  const screen = [...document.querySelectorAll('[data-testid="settings-screen"]')].pop();
  const out = {};
  for (const e of screen?.querySelectorAll('[data-testid="settings-row"]') ?? []) {
    const value = e.querySelector('[data-testid="cell-value"]');
    const texts = [...e.querySelectorAll("div")].filter((d) => d.children.length === 0 && d.textContent.trim());
    const label = texts[0]?.textContent.trim() ?? "";
    const sub = texts.slice(1).find((d) => d !== value)?.textContent.trim() ?? "";
    const subEl = texts.slice(1).find((d) => d !== value);
    out[e.dataset.row] = { label, value: value?.textContent.trim() ?? "", sub, subColour: subEl ? getComputedStyle(subEl).color : null };
  }
  return out;
});
