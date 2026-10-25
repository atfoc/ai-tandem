// S3's helpers over Settings > Voice on the phone (no dash in the name: not a check). The Voice screen is a pushed screen of the phone's
// stack (`voice-settings`, testID `vs-screen`); Add key, the pickers of Advanced, the device sheets and Remove key's question are sheets over it;
// Choose voice is a screen pushed from it (`cv-screen`). The VC checks of chunk 6 share these, so each takes a `page` and does what the person does.
//
//   openVoice(page)                  the Voice screen on top, through the real path: Settings (open already, else Home's gear, `settings.mjs`
//                                    `openSettings`, from Home: the phone has no sidebar foot) then its Voice row; waited to rest
//   stackNames(page)                 the stack's entries by name (the keys carry a counter: "settings#1")
//   voiceKeyState(page)              the screen's `data-key`: unknown | none | saved (null when the screen is not drawn)
//   openAddKey(page)                 the Add key sheet opened (the card's button with no key, the key row with one), waited to rest
//   typeKey(page, key)               the sheet's box filled
//   saveKey(page, key)               Add key opened if it is not, the key typed, Save pressed, the sheet gone and the screen in the key state
//   openChooseVoice(page)            "Choose voice" pressed, `cv-screen` at rest (the list loads on its own: `voicesLoaded`)
//   voicesLoaded(page)               waits until Choose voice has rows (or says why not)
//   pickIn(page, rowId, sheetId, { value, label, search })   the Advanced row `rowId` pressed, the P2 sheet `sheetId` open, optional `before(sheet)` (a look at the open sheet),
//                                    optional search typed, the option picked by `value` (data-value) or `label`; for a sheet without `extra`, waited until it is gone
//   sheetShown(page, id) / sheetGone(page, id)   a sheet by its testID on screen and at rest / gone
//   closeSheet(page, id)             the sheet's Done (P2 with an extra) or Cancel (P3), else the dimmed page above it
//   voiceSettings(page)              `__aiwbVoice.settings()`
//   voiceLog(url)                    the stand-in voice service's log (the mock's `voice.log()`)
//   deviceCalls(page)                `__aiwbDevices.calls()` of devices.mjs: { enumerateDevices, getUserMedia, setSinkId }
//   textOf(loc)                      the visible text of the first match, spaces folded
//   leaks(page, secret, { fields })  where `secret` is found in the page: { text, html, attrs, fields, storage } (all false when nowhere); a form box's
//                                    value is not read unless `fields`
import { mockEval, until } from "../shot.mjs";
import { IDS, byTid, press, showHome } from "./sel.mjs";
import { atRest, openRow, openSettings, stackKeys } from "./settings.mjs";

/** The names of the stack's entries ("settings#1" is the first push of "settings"). */
export const stackNames = async (page) => (await stackKeys(page)).map((k) => k.replace(/#\d+$/, ""));

const WAIT = 15000;

export const textOf = async (loc) => ((await loc.first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();

export const voiceKeyState = (page) => byTid(page, "vs-screen").last().getAttribute("data-key", { timeout: 1000 }).catch(() => null);

/** The Voice screen on top. */
export async function openVoice(page) {
  const keys = await stackNames(page);
  // (Home's gear pushes Settings, and Settings' Voice row pushes Voice; with a screen over Home the gear is covered, so Home is brought back first)
  if (keys.at(-1) !== "settings") {
    await showHome(page);
    await openSettings(page);
  }
  await openRow(page, "voice");
  await atRest(page, "vs-screen", WAIT);
  await until(async () => (await voiceKeyState(page)) !== "unknown", WAIT);
}

export async function sheetShown(page, id) {
  await byTid(page, id).last().waitFor({ state: "visible", timeout: WAIT });
  await page.waitForFunction((id) => {
    const all = document.querySelectorAll(`[data-testid="${id}"]`), e = all[all.length - 1];
    if (!e) return false;
    const r = e.getBoundingClientRect(), pos = Math.round(r.top) + ":" + Math.round(r.height);
    const still = window.__sheetRest === pos;
    window.__sheetRest = pos;
    return still && r.top >= 0 && r.bottom <= innerHeight + 1;
  }, id, { timeout: WAIT, polling: "raf" });
}

export const sheetGone = (page, id) => page.waitForFunction((id) => !document.querySelector(`[data-testid="${id}"]`), id, { timeout: WAIT });

/** The sheet closed the way its head says: Done or Cancel, else the dimmed page above it. */
export async function closeSheet(page, id) {
  const sheet = byTid(page, id).last();
  const left = sheet.locator('[data-testid="sheet-left"]'), right = sheet.locator('[data-testid="sheet-right"]');
  const done = right.filter({ hasText: "Done" });
  if (await done.count()) await press(page, done.first());
  else if (await left.count()) await press(page, left.first());
  else await page.touchscreen.tap(page.viewportSize().width / 2, 30);
  await sheetGone(page, id);
}

export async function openAddKey(page) {
  const card = byTid(page, "vs-add-key").last();
  if (await card.isVisible().catch(() => false)) await press(page, card);
  else await press(page, byTid(page, "vs-key-row").last());
  await sheetShown(page, "vs-key-sheet");
  await atRest(page, "vs-key");
}

export const typeKey = (page, key) => byTid(page, "vs-key").last().fill(key);

/** Key typed and saved through the sheet; the screen is in the key state when it returns. */
export async function saveKey(page, key) {
  if (!(await byTid(page, "vs-key-sheet").count())) await openAddKey(page);
  await typeKey(page, key);
  await press(page, byTid(page, "sheet-right").last());
  await sheetGone(page, "vs-key-sheet");
  await until(async () => (await voiceKeyState(page)) === "saved", WAIT);
  await atRest(page, "vs-screen", WAIT);
}

export async function voicesLoaded(page) {
  await page.waitForFunction(() => document.querySelector('[data-testid="cv-row"],[data-testid="cv-failed"],[data-testid="cv-none"]'), null, { timeout: WAIT });
}

export async function openChooseVoice(page) {
  await press(page, byTid(page, "vs-choose-voice").last());
  await atRest(page, "cv-screen", WAIT);
}

export async function pickIn(page, rowId, sheetId, { value, label, search, before } = {}) {
  await press(page, byTid(page, rowId).last());
  await sheetShown(page, sheetId);
  const sheet = byTid(page, sheetId).last();
  if (before) await before(sheet);
  if (search !== undefined) await sheet.locator('[data-testid="search-field"]').fill(search);
  const option = value !== undefined ? sheet.locator(`[data-testid="picker-row"][data-value=${JSON.stringify(value)}]`) : sheet.locator('[data-testid="picker-row"]').filter({ hasText: label });
  await press(page, option.first());
  if (!(await byTid(page, "picker-extra").count())) await sheetGone(page, sheetId);
}

export const voiceSettings = (page) => page.evaluate(() => window.__aiwbVoice.settings());
export const voiceLog = (url) => mockEval("return voice.log();", url);
export const deviceCalls = (page) => page.evaluate(() => window.__aiwbDevices.calls());

/** Where `secret` can be seen in the page: its text, its markup (testIDs, labels and data attributes included) and its storage. The value of a form
 *  box is left out: the box of Add key holds the typed key on purpose while the sheet is open (`fields: true` reads the boxes too). */
export const leaks = (page, secret, { fields = false } = {}) => page.evaluate(([k, fields]) => {
  const clone = document.documentElement.cloneNode(true);
  for (const e of clone.querySelectorAll("input, textarea")) e.removeAttribute("value");
  return {
    text: document.body.innerText.includes(k),
    html: clone.outerHTML.includes(k),
    attrs: [...document.querySelectorAll("*")].some((e) => [...e.attributes].some((a) => a.value.includes(k) && !(a.name === "value" && !fields && /^(INPUT|TEXTAREA)$/.test(e.tagName)))),
    fields: fields && [...document.querySelectorAll("input, textarea")].some((e) => e.value.includes(k)),
    storage: [localStorage, sessionStorage].some((s) => Object.keys(s).some((n) => n.includes(k) || (s.getItem(n) ?? "").includes(k))),
  };
}, [secret, fields]);

export { IDS };
