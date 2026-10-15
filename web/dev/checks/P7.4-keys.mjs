// P7.4 ported (AD-80; package K1): ⌘L and ⌘⇧L as they were, the board-reference half of web/dev/checks/P7.4-keys.mjs, at desktop (mouse)
// and tablet (touch, with a hardware keyboard). Its assertions are the old check's for "a chat beside a board whose canvas can be
// edited", on the gallery's stand-in for the board (`/?gallery`, app/src/dev/ChipGallery.tsx: three rectangles to select, a layer to
// pick a point on, the context row's "+ Selection" and "+ Point" buttons, the chip input), since the app has no chat screen yet:
//   ⌘L with nothing selected says "Select something on the board first" (for 2.5 s) and puts nothing in, and "+ Selection" is off;
//   with three shapes selected the button reads "+ 3 selected" and ⌘L puts them into the message as one chip reading 3;
//   ⌘⇧L waits for a point on the board (the layer over it, "+ Point" lit), ⌘⇧L again or Esc ends the wait, a press on the board puts
//   the point's chip into the message (a second chip, another than the first) and ends the wait;
//   the keys take the key (they are prevented: the page's own ⌘L does not run); a box that takes nothing (read-only) takes no chip by
//   key or button.
// What is not here, because its part of the app is not built: the plain chat half (⌘L quoting the selected text, the notice
// "Select text in a message to quote it", the quote's box and its count) is K5's with the quotes; the composer's fit with a
// chip and the notice is K3's (P0.6); that the key does not reach Excalidraw (no shape of the stored drawing is locked, and
// its proof with the panel away) is the board's (B4), whose canvas the gallery does not have; "beside the sidebar and beside the
// rail" is the app shell's (U3). Where the chip input itself is proved is L4-chips.mjs.
//
// Alone, from the repository root (the runner of `npm run uicheck` runs this file the same way):
//   node web/dev/checks/P7.4-keys.mjs        (see web/dev/standalone.mjs for DIST, PORT and VIEWPORT)
import { until } from "../shot.mjs";
import { standalone } from "../standalone.mjs";

export const viewports = ["desktop", "tablet"];

const tid = (id) => `[data-testid="${id}"]`;
const BOX = tid("composer-input"), CHIP = `${BOX} ${tid("ref-chip")}`;

export async function body({ page, viewport, fail }) {
  const touch = viewport !== "desktop";
  const T = (id) => page.locator(tid(id));
  const press = (loc) => (touch ? loc.tap() : loc.click());
  const key = (shift) => page.keyboard.press(shift ? "ControlOrMeta+Shift+l" : "ControlOrMeta+l");
  /** In the page: the chips of the box, whether a point is waited for, the point button's state, the note. */
  const seen = () => page.evaluate(([chip, layer, point, note, selection]) => {
    const text = (e) => (e?.textContent ?? "").replace(/\s+/g, " ").trim(), p = document.querySelector(point), s = document.querySelector(selection);
    return { chips: [...document.querySelectorAll(chip)].map((c) => `${c.dataset.kind}: ${text(c)}`), picking: !!document.querySelector(layer), lit: p?.dataset.on === "true", note: text(document.querySelector(note)), selection: text(s), selectionOff: s?.getAttribute("aria-disabled") === "true" };
  }, [CHIP, tid("pick-layer"), tid("ctx-point"), tid("gallery-chip-note"), tid("ctx-selection")]);
  const shows = async (name, want) => {
    let s;
    if (!await until(async () => want((s = await seen())), 10000)) fail(`${viewport}: ${name}: the page shows ${JSON.stringify(s)}`);
    return s;
  };
  // a Locator's tap/click on the box focuses it, as a user does before the keys
  await T("composer-input").scrollIntoViewIfNeeded();
  await press(T("composer-input"));

  // ⌘L with nothing selected
  const at = await seen();
  if (at.chips.length || !at.selectionOff || at.selection !== "+ Selection") fail(`${viewport}: the board starts with ${JSON.stringify(at)}: no chip, and "+ Selection" off`);
  await key(false);
  await shows("⌘L with nothing selected", (s) => s.note === "Select something on the board first" && !s.chips.length);
  if (!await until(async () => !(await seen()).note, 6000)) fail(`${viewport}: the notice "Select something on the board first" stays (it goes after 2.5 s)`);

  // three shapes selected: the button, then ⌘L
  for (const shape of await T("gallery-shape").all()) await press(shape);
  await shows("three shapes selected", (s) => s.selection === "+ 3 selected" && !s.selectionOff);
  await key(false);
  const one = await shows("⌘L with three shapes selected", (s) => s.chips.length === 1);
  if (!/3/.test(one.chips[0] ?? "") || !one.chips[0].startsWith("selection")) fail(`${viewport}: the reference of three selected shapes reads "${one.chips[0]}"`);

  // ⌘⇧L: on, off by the key, on, off by Esc, on, and a press on the board
  for (const [what, act, on] of [["⌘⇧L", () => key(true), true], ["⌘⇧L again", () => key(true), false], ["⌘⇧L", () => key(true), true], ["Esc", () => page.keyboard.press("Escape"), false], ["⌘⇧L", () => key(true), true]]) {
    await act();
    await shows(`${what}: ${on ? "a point is waited for" : "no point is waited for"}`, (s) => s.picking === on && s.lit === on);
  }
  const box = await page.locator(tid("pick-layer")).boundingBox();
  const at2 = { x: box.x + box.width / 2, y: box.y + box.height / 3 };
  if (touch) await page.touchscreen.tap(at2.x, at2.y); else await page.mouse.click(at2.x, at2.y);
  const two = await shows("a press on the board", (s) => s.chips.length === 2 && !s.picking && !s.lit);
  if (two.chips[0] !== one.chips[0] || two.chips[1] === one.chips[0] || !/^point: \(-?\d+, -?\d+\)$/.test(two.chips[1])) fail(`${viewport}: after the press the message has ${JSON.stringify(two.chips)}`);

  // the buttons do what the keys do
  await press(T("ctx-point"));
  await shows("+ Point", (s) => s.picking && s.lit);
  await press(T("ctx-point"));
  await shows("+ Point again", (s) => !s.picking && !s.lit);
  await press(T("ctx-selection"));
  await shows("+ 3 selected", (s) => s.chips.length === 3);

  // the key is taken: the page's own ⌘L does not run
  const prevented = await page.evaluate(() => new Promise((ok) => {
    const seen = [];
    const h = (e) => seen.push(e.defaultPrevented);
    window.addEventListener("keydown", h);
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "l", code: "KeyL", metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
    window.removeEventListener("keydown", h);
    ok(seen);
  }));
  if (prevented.some((p) => !p)) fail(`${viewport}: ⌘L was left to the page (its default was not prevented)`);

  // a box that takes nothing takes no chip, by key or button
  const held = (await seen()).chips.length;
  await press(T("gallery-chip-readonly"));
  await until(async () => (await T("gallery-chip-mode").textContent()) === "read-only");
  await key(false);
  await press(T("ctx-selection"));
  await new Promise((ok) => setTimeout(ok, 300));
  if ((await seen()).chips.length !== held) fail(`${viewport}: a read-only box took a chip: ${JSON.stringify((await seen()).chips)}`);
  await press(T("gallery-chip-readonly"));
}

await standalone(import.meta.url, "P7.4", viewports, body);
