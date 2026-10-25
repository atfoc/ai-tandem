// L1 (new in the app, AD-80; package U2): the primitives of app/src/ui on the gallery (`/?gallery`, app/src/dev/Gallery.tsx),
// at desktop (1280×800, mouse), tablet (iPad Pro 11, touch) and phone (iPhone 15, touch). It has no old check to port.
//   Layout: the layout the gallery reports is the viewport's (desktop, tablet, phone), and follows a resize (600 wide: phone,
//   900: tablet); the pointer is "mouse" on desktop and "touch" after a tap on the touch viewports.
//   Overlays: the layout decides the form of an Overlay: a sheet on the phone (it rises from the bottom edge and spans the window),
//   a popover hung from its anchor (menu) or a dialog in the middle (dialog) on tablet and desktop; the direct Popover, Dialog and
//   Sheet are what they are at every width. Each opens (by press, and by Enter on a focused opener), closes on Esc, on the dimmed
//   page or backdrop, and by its own Cancel, and hands the focus back to its opener; while open, the focus stays inside it through 12
//   Tab and 12 Shift+Tab presses. A confirm dialog over an open popover closes first on Esc and leaves the popover. A popover
//   in a window too low for it stays inside the window; a sheet is closed by a swipe down on its handle. "Back" (the Android
//   back button) is the Modal's onRequestClose, which on web is Esc: it has no browser form, and Maestro (V) presses it on a device.
//   Menu: choices are role menuitemradio with aria-checked, a disabled item does nothing and says so, the arrow keys move the focus
//   (skipping the disabled), the rows of a sheet are at least 44 points tall (at the phone 50, with a 17 pt label).
//   Controls: Button and IconButton press, a disabled button does not, `title` is the tooltip on web and the accessibility label.
//   Resizer: absent on the phone; on desktop (mouse) and tablet (touch) a drag moves the pane by the distance, stops at the pane's
//   minimum, maximum and the `room` it is given, reports the final width once, and a double click (tap) resets it.
//   Keys: a key down reaches the keys port. Theme: the surfaces take the tokens of the theme (dark: #1c1c21).
//   Picture: a lazy <img> that loads, and the broken tile for an image that cannot be had.
//   Fence (B-TH-17): a tool card whose item throws as it is drawn (a getter) says "Couldn't show this tool call." with the cause and nothing else of the page
//   goes; the card of another item (the mended one) is drawn again; the gallery's section "Guard" is that card, and the card's fence is the thread's own.
//
// Run: `cd web && npm run uicheck -- L1` (the web build is made once for the run), or alone as README.md of this folder says:
//   node web/dev/checks/L1-primitives.mjs                       (VIEWPORT=phone for one viewport, DIST=/tmp/x/dist for a build made before)
// No server of the app is needed: the gallery shows no chat (the mock only serves the build).
import { check, until } from "../shot.mjs";
import { mouseDrag, touchDrag } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const tid = (id) => `[data-testid="${id}"]`;

/** The body of the check at one viewport. */
async function body({ page, viewport, layout, fail }) {
  const touch = viewport !== "desktop";
  const T = (id) => page.locator(tid(id));
  const win = () => page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const rect = (sel) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom } : null; }, sel);
  const text = async (id) => ((await T(id).first().textContent()) ?? "").trim();
  const press = (loc, opts) => (touch ? loc.tap(opts) : loc.click(opts));
  const closed = () => until(async () => !(await T("popover").count()) && !(await T("dialog").count()) && !(await T("sheet").count()), 15000);
  /** Whether the focus is inside the overlay that is open (the modal wrapper react-native-web draws). */
  const focusInside = () => page.evaluate(() => { const a = document.activeElement; const m = [...document.querySelectorAll('[aria-modal="true"]')].pop(); return !!a && !!m && m.contains(a); });
  const forms = () => page.evaluate(() => ["popover", "dialog", "sheet"].filter((k) => document.querySelector(`[data-testid="${k}"]`)));
  const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
  const expect = (ok, what) => { if (!ok) fail(what); return ok; };

  // ---- layout and pointer
  expect(await text("gallery-layout") === layout, `the layout is ${layout}, the gallery says ${await text("gallery-layout")}`);
  if (touch) await press(T("gallery-btn"));
  expect(await text("gallery-pointer") === (touch ? "touch" : "mouse"), `the pointer is ${touch ? "touch" : "mouse"}, the gallery says ${await text("gallery-pointer")}`);

  // ---- controls
  await press(T("gallery-btn"));
  expect(await until(async () => (await text("gallery-last")) === "default"), "a press on Button did not reach its handler");
  const disabled = T("gallery-btn-disabled");
  expect(await disabled.getAttribute("aria-disabled") === "true", "a disabled Button does not say aria-disabled");
  await disabled.click({ force: true }).catch(() => {});
  expect(await text("gallery-last") !== "disabled button", "a disabled Button was pressed");
  const icon = T("gallery-icon-btn");
  expect(await icon.getAttribute("aria-label") === "Hide the sidebar", "IconButton has no accessibility label from its title");
  // (the phone has no hover title (ux-improvements 3.1.3): its label alone says what the button is; the wide layouts keep the tooltip)
  if (viewport === "phone") expect(await icon.getAttribute("title") === null, "IconButton has a hover title at the phone layout");
  else expect(await icon.getAttribute("title") === "Hide the sidebar", "IconButton has no tooltip (title) on web");
  await press(icon);
  expect(await until(async () => (await text("gallery-last")) === "icon button"), "a press on IconButton did not reach its handler");

  // ---- keys port
  await page.keyboard.press("Meta+b");
  expect(await until(async () => (await text("gallery-key")) === "b+meta"), "the keys port did not give ⌘B");

  // ---- picture
  const img = page.locator('img[data-testid="picture"]');
  await img.scrollIntoViewIfNeeded();
  expect(await until(() => img.evaluate((e) => e.complete && e.naturalWidth > 0)), "the picture did not load");
  expect(await img.getAttribute("loading") === "lazy", "the picture is not a lazy <img>");
  const broken = page.locator('[data-testid="picture"][data-state="broken"]');
  expect(await broken.count() === 1 && await broken.getAttribute("aria-label") === "Missing image", "the picture that cannot be had does not show the broken tile with its name");

  // ---- a fence (B-TH-17): a tool card whose item cannot be drawn costs its own card, with the cause; the rest stays; another item draws it again
  // (the gallery draws that card only with `fence` in its address, which this check's page has: the other checks of the gallery allow no console error)
  const fence = T("guard-fail");
  await fence.first().scrollIntoViewIfNeeded();
  const fenced = (await fence.first().textContent().catch(() => "")) ?? "";
  expect(fenced.includes("Couldn't show this tool call.") && fenced.includes("The input of this call is broken."), `a tool card that cannot be drawn says "${fenced}", not "Couldn't show this tool call." and the cause`);
  expect(await fence.count() === 1 && await T("tool-card").count() === 0, "the broken tool card is drawn as well as the fence's line, or the fence is drawn more than once");
  expect(await text("gallery-guard-after") === "Drawn after the card." && await T("gallery").count() === 1, "the rest of the page went with the card that could not be drawn");
  await press(T("gallery-guard-toggle"));
  expect(await until(async () => !(await fence.count()) && (await T("tool-card").count()) === 1), "the card that was mended (another item) is not drawn again");
  expect((await text("tool-label")).includes("ls"), `the mended card says "${await text("tool-label")}": it is not the call of the new item`);
  await press(T("gallery-guard-toggle"));
  expect(await until(() => fence.count()), "the item that cannot be drawn is not fenced a second time");

  // ---- an overlay: how it opens, what it looks like, what closes it
  /** Opens the overlay `id` (gallery-open-<id>) by a press, or by Enter on the focused opener. */
  const open = async (id, how = "press") => {
    const opener = T(`gallery-open-${id}`);
    if (how === "enter") { await opener.focus(); await page.keyboard.press("Enter"); } else await press(opener);
  };
  const shown = async (kind) => until(async () => (await T(kind).count()) === 1 && (await forms()).length === 1 && (await forms())[0] === kind, 15000);
  const closeWays = {
    esc: () => page.keyboard.press("Escape"),
    backdrop: () => press(T("overlay-backdrop"), { position: { x: 4, y: 4 } }),
  };

  /** One overlay through its life: opens as `kind`, passes `look`, keeps the focus, closes every way and gives the focus back. */
  async function life(id, kind, look) {
    for (const way of ["esc", "backdrop", "enter-esc"]) {
      const what = `${id} as ${kind} (${way})`;
      await open(id, way === "enter-esc" ? "enter" : "press");
      if (!expect(await shown(kind), `${what}: it did not open as ${kind}; the page has ${(await forms()).join(", ") || "no overlay"}`)) { await page.keyboard.press("Escape"); await closed(); continue; }
      if (way === "esc") await look?.();
      expect(await until(focusInside), `${what}: the focus is not inside the overlay when it opens`);
      if (way === "esc") {
        for (let i = 0; i < 12; i++) { await page.keyboard.press("Tab"); if (!await focusInside()) { fail(`${what}: Tab ${i + 1} took the focus out of the overlay`); break; } }
        for (let i = 0; i < 12; i++) { await page.keyboard.press("Shift+Tab"); if (!await focusInside()) { fail(`${what}: Shift+Tab ${i + 1} took the focus out of the overlay`); break; } }
      }
      await closeWays[way === "backdrop" ? "backdrop" : "esc"]();
      expect(await closed(), `${what}: it did not close`);
      if (way === "enter-esc") expect(await until(() => page.evaluate((s) => document.activeElement?.matches(s), tid(`gallery-open-${id}`))), `${what}: the focus did not go back to its opener`);
    }
  }

  const sheetLook = async () => {
    const w = await win();
    expect(await until(async () => { const r = await rect(tid("sheet")); return r && near(r.bottom, w.h, 1.5); }), "the sheet did not rise to the bottom edge of the window");
    const r = await rect(tid("sheet"));
    expect(r && near(r.x, 0, 1) && near(r.w, w.w, 1), `the sheet does not span the window (x ${r?.x}, width ${r?.w} of ${w.w})`);
    expect(await T("sheet-handle").count() === 1, "the sheet has no handle");
  };
  const popoverLook = async () => {
    await until(() => page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="popover"]')).opacity === "1")); // (placed once measured)
    const w = await win(), a = await rect(tid("gallery-open-overlay-menu")), r = await rect(tid("popover"));
    expect(r && r.x >= 0 && r.right <= w.w && r.y >= 0 && r.bottom <= w.h, "the popover is not inside the window");
    // it hangs from its anchor: below it by 4 points, its left edge on the anchor's
    if (a && r && (await T("gallery-open-overlay-menu").count())) expect(near(r.x, a.x, 2) && near(r.y, a.bottom + 4, 3), `the popover is not at its anchor (popover ${r?.x},${r?.y}, anchor ${a?.x},${a?.bottom})`);
  };
  const dialogLook = async () => {
    const w = await win(), r = await rect(tid("dialog"));
    expect(r && near(r.x + r.w / 2, w.w / 2, 2) && near(r.y + r.h / 2, w.h / 2, 2), "the dialog is not in the middle of the window");
    expect(r && r.w <= 420 + 1, `the dialog is wider than 420 points (${r?.w})`);
  };

  // by the layout
  await life("overlay-menu", viewport === "phone" ? "sheet" : "popover", viewport === "phone" ? sheetLook : popoverLook);
  await life("overlay-dialog", viewport === "phone" ? "sheet" : "dialog", viewport === "phone" ? sheetLook : dialogLook);
  // each form, at every width
  await life("popover", "popover", async () => { await until(() => page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="popover"]')).opacity === "1")); const r = await rect(tid("popover")), w = await win(); expect(r && r.x >= 0 && r.right <= w.w && r.bottom <= w.h, "the popover is not inside the window"); });
  await life("dialog", "dialog", dialogLook);
  await life("sheet", "sheet", sheetLook);

  // the dialog's own buttons: the default action has the focus, Cancel closes, Ok acts
  await open("dialog");
  await shown("dialog");
  expect(await until(() => page.evaluate((s) => document.activeElement?.matches(s), tid("gallery-dialog-ok"))), "the dialog's default action does not have the focus");
  await press(T("gallery-dialog-cancel"));
  expect(await closed(), "Cancel did not close the dialog");
  await open("dialog"); await shown("dialog");
  await press(T("gallery-dialog-ok"));
  expect(await closed() && await until(async () => (await text("gallery-last")) === "ok"), "Ok did not act and close the dialog");

  // ---- a menu: choices, a disabled item, arrow keys, the rows' height, a pick that closes
  await open("popover"); await shown("popover");
  const light = page.getByRole("menuitemradio", { name: "Light" }), dark = page.getByRole("menuitemradio", { name: "Dark" });
  expect(await light.getAttribute("aria-checked") === "true" && await dark.getAttribute("aria-checked") === "false", "the choices do not start with Light checked");
  await press(dark);
  expect(await until(async () => await dark.getAttribute("aria-checked") === "true" && await light.getAttribute("aria-checked") === "false"), "a press on a choice did not move the check");
  expect(await T("popover").count() === 1, "a choice closed the menu (it must not close by itself)");
  const row = await rect('[role="menuitem"]');
  expect(row && row.h < 44, `a menu row of a popover is ${row?.h} tall (a sheet's rows are at least 44, a popover's are not)`);
  const off = page.getByRole("menuitem", { name: "Not available" });
  expect(await off.getAttribute("aria-disabled") === "true", "a disabled item does not say aria-disabled");
  await off.click({ force: true }).catch(() => {});
  expect(await text("gallery-last") !== "disabled", "a disabled item was pressed");
  // the arrow keys: from the first item down through the items; the disabled one is passed over; the last wraps to the first
  const names = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
  await page.getByRole("menuitemradio", { name: "Light" }).focus();
  const order = [];
  for (let i = 0; i < 6; i++) { await page.keyboard.press("ArrowDown"); order.push(await names()); }
  expect(order.join("|") === "Dark|New chat|New whiteboard|Delete…|Light|Dark", `ArrowDown walks ${order.join(" > ")} (expected Dark > New chat > New whiteboard > Delete… > Light > Dark)`);
  await page.keyboard.press("ArrowUp");
  expect(await names() === "Light", "ArrowUp did not go back to Light");
  await page.keyboard.press("End");
  expect(await names() === "Delete…", "End did not go to the last item");
  await page.keyboard.press("Home");
  expect(await names() === "Light", "Home did not go to the first item");
  // a confirm over the popover: Esc closes the confirm and leaves the popover; Esc again closes the popover
  await press(page.getByRole("menuitem", { name: "Delete…" }));
  expect(await until(async () => (await page.locator('[role="dialog"][aria-label="Delete this?"]').count()) === 1), "Delete… did not open the confirm dialog");
  expect(await until(focusInside) && await page.evaluate(() => document.activeElement?.closest('[aria-modal="true"]')?.getAttribute("aria-label") === "Delete this?"), "the focus is not in the confirm dialog that is on top");
  await page.keyboard.press("Escape");
  expect(await until(async () => (await page.locator('[role="dialog"][aria-label="Delete this?"]').count()) === 0), "Esc did not close the confirm dialog");
  expect(await T("popover").count() === 1, "Esc closed the popover under the confirm as well: only the one on top closes");
  await page.keyboard.press("Escape");
  expect(await closed(), "the second Esc did not close the popover");
  // the rows of a sheet are tall enough for a finger
  await open("sheet"); await shown("sheet");
  const tall = await rect('[role="menuitem"]');
  expect(tall && tall.h >= 44, `a menu row of a sheet is ${tall?.h} tall (at least 44)`);
  if (viewport === "phone") {
    // the phone's look of a Menu in a sheet (F1): 50 pt rows with a 17 pt label
    expect(tall && tall.h >= 49.5, `a menu row of a sheet at the phone is ${tall?.h} tall (at least 50)`);
    const px = await page.evaluate(() => { const e = [...document.querySelectorAll('[data-testid="sheet"] [role="menuitem"] *')].find((n) => !n.children.length && n.textContent.trim()); return e ? parseFloat(getComputedStyle(e).fontSize) : null; });
    expect(px === 17, `a menu row's label in a sheet at the phone is ${px} px, not 17`);
  }
  await page.keyboard.press("Escape"); await closed();
  // a pick that closes
  await open("popover"); await shown("popover");
  await press(page.getByRole("menuitem", { name: "New chat" }));
  expect(await closed() && await until(async () => (await text("gallery-last")) === "new chat"), "New chat did not act and close the menu");

  // ---- the sheet is closed by a swipe down on its handle
  await open("sheet"); await shown("sheet"); await sheetLook();
  const h = await rect(tid("sheet-handle"));
  if (h) {
    const from = { x: h.x + h.w / 2, y: h.y + h.h / 2 };
    if (touch) await touchDrag(page, from, { x: from.x, y: from.y + 240 }, { hold: 0 }); else await mouseDrag(page, from, { x: from.x, y: from.y + 240 });
    expect(await closed(), "a swipe down on the sheet's handle did not close it");
  } else fail("the sheet has no handle to drag");

  // ---- the theme
  await press(T("gallery-theme-dark"));
  expect(await until(async () => (await text("gallery-theme")) === "dark"), "Dark did not change the theme");
  await open("popover"); await shown("popover");
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="popover"]')).backgroundColor);
  expect(bg === "rgb(28, 28, 33)", `the popover in the dark theme is ${bg} (the token bg is #1c1c21)`);
  await page.keyboard.press("Escape"); await closed();
  await press(T("gallery-theme-light"));
  await until(async () => (await text("gallery-theme")) === "light");

  // ---- the resizer
  const resizer = T("resizer");
  if (viewport === "phone") expect(await resizer.count() === 0, "the phone layout draws a resizer");
  else {
    await resizer.scrollIntoViewIfNeeded();
    expect(await resizer.count() === 1 && await resizer.getAttribute("role") === "separator" && await resizer.getAttribute("aria-valuenow") === "264", "the resizer is not a separator reporting the pane's width 264");
    if (!touch) expect(await resizer.evaluate((e) => getComputedStyle(e).cursor) === "col-resize", "the resizer has no col-resize cursor");
    const width = async () => Number(await text("gallery-pane-width"));
    const saved = async () => Number(await text("gallery-pane-saved"));
    const drag = async (dx) => {
      const r = await rect(tid("resizer"));
      const from = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      if (touch) await touchDrag(page, from, { x: from.x + dx, y: from.y }, { hold: 0 }); else await mouseDrag(page, from, { x: from.x + dx, y: from.y });
    };
    await drag(100);
    expect(await until(async () => (await width()) === 364 && (await saved()) === 364), `a drag of +100 gave the width ${await width()} (saved ${await saved()}); expected 364`);
    await drag(-60);
    expect(await until(async () => (await width()) === 304 && (await saved()) === 304), `a drag of -60 gave the width ${await width()}; expected 304`);
    await drag(500);
    expect(await until(async () => (await width()) === 400 && (await saved()) === 400), `a drag past the room gave the width ${await width()}; expected 400 (room)`);
    await drag(-900);
    expect(await until(async () => (await width()) === 200 && (await saved()) === 200), `a drag past the minimum gave the width ${await width()}; expected 200`);
    expect(await resizer.getAttribute("aria-valuenow") === "200", "the resizer does not report the new width");
    const r = await rect(tid("resizer"));
    const at = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    if (touch) { await page.touchscreen.tap(at.x, at.y); await sleep(60); await page.touchscreen.tap(at.x, at.y); } else await page.mouse.dblclick(at.x, at.y);
    expect(await until(async () => (await width()) === 264 && (await saved()) === 264), `a double ${touch ? "tap" : "click"} gave the width ${await width()}; expected the default 264`);
  }

  // ---- the layout follows the window (desktop only: the other viewports are the devices' own)
  if (viewport === "desktop") {
    await page.setViewportSize({ width: 600, height: 800 });
    expect(await until(async () => (await text("gallery-layout")) === "phone"), "a window 600 wide is not the phone layout");
    await open("overlay-menu");
    expect(await shown("sheet"), "an Overlay menu in a window 600 wide is not a sheet");
    await page.keyboard.press("Escape"); await closed();
    await page.setViewportSize({ width: 900, height: 800 });
    expect(await until(async () => (await text("gallery-layout")) === "tablet"), "a window 900 wide is not the tablet layout");
    await open("overlay-menu");
    expect(await shown("popover"), "an Overlay menu in a window 900 wide is not a popover");
    await page.keyboard.press("Escape"); await closed();
    // a window too low for the menu: the popover stays inside it and scrolls
    await page.setViewportSize({ width: 1280, height: 260 });
    await open("popover"); await shown("popover");
    const w = await win(), r = await rect(tid("popover"));
    expect(r && r.y >= 0 && r.bottom <= w.h + 0.5 && r.x >= 0 && r.right <= w.w, `in a window 260 high the popover is outside it (top ${r?.y}, bottom ${r?.bottom} of ${w.h})`);
    await page.keyboard.press("Escape"); await closed();
    await page.setViewportSize({ width: 1280, height: 800 });
  }
}

await check("L1 the primitives of ui/ on the gallery", body, { viewports, page: { query: "gallery&fence", wait: tid("gallery") }, allowConsole: [/this tool call could not be shown/, /The above error occurred/, /The input of this call is broken/] }); // (the fence logs what it caught)
