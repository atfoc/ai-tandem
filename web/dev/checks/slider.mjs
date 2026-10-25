// Readers and movers of the app's slider (`app/src/ui/Slider.tsx`; no dash in the name: not a check). The slider's root carries the testID given
// and `data-value` (the shown value, live while a drag moves it), `data-disabled`, `data-dragging`; its parts are `<id>-track` (role slider, the
// focusable one), `-handle`, `-value`, `-min`, `-max`, `-minus`, `-plus`, `-mark`. The track area is padded by the handle's radius, so a value v sits
// at x = left + r + (v - min) / (max - min) * (width - 2r) of the `-track` box, r = 7 px at size "sm", 12 at "touch".
//
//   sliderRead(page, id)               { value (data-value, a number), text (the value beside the track), min, max (the ends' labels), ariaNow,
//                                        ariaMin, ariaMax, ariaText, dragging, disabled }
//   sliderNow(page, id)                { value, text, dragging } in one round trip (for a read at every step of a drag)
//   xOnTrack(box, v, { min, max, r })  the page x of value v on a track box
//   sliderPoint(page, id, v, range)    { x, y } of value v on the slider's track (`range`: { min, max }), r from the handle's own width
//   sliderKeys(page, id, keys)         the track focused, then each key of `keys` pressed (Playwright's names: "ArrowRight", "PageUp", "Home", "End")
//   setByKeys(page, id, to, range)     moves the value to `to` by keys alone: Home/End when nearer, PageUp/PageDown for each `bigStep`, arrows for the rest
//   pauseOf(page)                      the delay before send in Settings > Voice (`vs-adv-pause`), in ms, as the slider shows it
//   setPause(page, ms)                 the delay set by keys (the phone and the dialog have the same slider)
//
// Read the slider whole (for the max chats' checks; the size follows the last pointer, so these read the geometry at each call):
//   sliderOf(page, id)           what the slider is now: { value (data-value), text (-value), min, max (the ends' labels), aria { min, max, now, text },
//                                disabled (data-disabled), ariaDisabled (the track's), dragging, handle { x, w } (the handle's centre and width), track (its box) }
//   sliderX(page, id, v)         the x on the page where the handle's centre sits for the value `v`: the touch area is padded by the handle's radius
//                                r, so v is at left + r + (v − min)/(max − min)·(width − 2r) (r read from the handle: 7 px at "sm", 12 at "touch"; the
//                                size follows the last pointer, so it is read each time)
//   sliderY(page, id)            the y of the track's middle
//   tapSlider(page, id, v)       a click (mouse) or tap (finger) at the place of v
//   pointer(page, "mouse"|"touch") a mouse or one finger that goes where the check says, in steps (down, move, up, cancel)
import { byTid, press } from "./sel.mjs";

export const PAUSE = { min: 100, max: 10000, step: 100, bigStep: 1000, id: "vs-adv-pause" };

const last = (page, id, part = "") => byTid(page, id + part).last();
const text = async (loc) => ((await loc.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();

export async function sliderRead(page, id) {
  const root = last(page, id), track = last(page, id, "-track");
  const num = async (loc, a) => { const v = await loc.getAttribute(a); return v === null ? null : Number(v); };
  return {
    value: await num(root, "data-value"),
    text: await text(last(page, id, "-value")),
    min: await text(last(page, id, "-min")),
    max: await text(last(page, id, "-max")),
    ariaNow: await num(track, "aria-valuenow"),
    ariaMin: await num(track, "aria-valuemin"),
    ariaMax: await num(track, "aria-valuemax"),
    ariaText: await track.getAttribute("aria-valuetext"),
    dragging: (await root.getAttribute("data-dragging")) === "true",
    disabled: (await root.getAttribute("data-disabled")) === "true",
  };
}

/** The three things a drag shows, read in one call: the root's `data-value` and `data-dragging`, and the text beside the track. */
export const sliderNow = (page, id) => page.evaluate((id) => {
  const all = document.querySelectorAll(`[data-testid="${id}"]`), root = all[all.length - 1];
  const values = document.querySelectorAll(`[data-testid="${id}-value"]`), v = values[values.length - 1];
  return root ? { value: Number(root.getAttribute("data-value")), text: (v?.textContent ?? "").trim(), dragging: root.getAttribute("data-dragging") === "true" } : null;
}, id);

/** The page x of the value `v` on a `-track` box of a slider with the ends `min` and `max` and a handle of radius `r`. */
export const xOnTrack = (box, v, { min, max, r }) => box.x + r + ((v - min) / (max - min)) * (box.width - 2 * r);

/** The page point of value `v` on the slider's track (the middle of its height). The handle's radius is its own width / 2. */
export async function sliderPoint(page, id, v, { min = PAUSE.min, max = PAUSE.max } = {}) {
  await last(page, id, "-track").scrollIntoViewIfNeeded();
  const box = await last(page, id, "-track").boundingBox(), h = await last(page, id, "-handle").boundingBox();
  if (!box || !h) throw new Error(`the slider ${id} is not drawn`);
  return { x: xOnTrack(box, v, { min, max, r: h.width / 2 }), y: box.y + box.height / 2 };
}

export async function sliderKeys(page, id, keys) {
  await last(page, id, "-track").focus();
  for (const k of keys) await page.keyboard.press(k);
}

/** The keys that take the value `from` to `to`: from where it is, or from an end by Home / End, whichever takes fewer. */
export function keysFor(from, to, { min = PAUSE.min, max = PAUSE.max, step = PAUSE.step, bigStep = PAUSE.bigStep } = {}) {
  const walk = (start) => {
    const keys = [];
    let v = start;
    while (Math.abs(to - v) >= bigStep) { keys.push(to > v ? "PageUp" : "PageDown"); v += to > v ? bigStep : -bigStep; }
    while (v !== to) { keys.push(to > v ? "ArrowRight" : "ArrowLeft"); v += to > v ? step : -step; }
    return keys;
  };
  return [walk(from), ["Home", ...walk(min)], ["End", ...walk(max)]].sort((a, b) => a.length - b.length)[0];
}

export async function setByKeys(page, id, to, range) {
  const from = (await sliderRead(page, id)).value;
  await sliderKeys(page, id, keysFor(from, to, range));
}

export const pauseOf = async (page) => (await sliderRead(page, PAUSE.id)).value;
export const setPause = (page, ms) => setByKeys(page, PAUSE.id, ms);

export const trackOf = (page, id) => byTid(page, `${id}-track`);

export const sliderOf = (page, id) => page.evaluate((id) => {
  const q = (s) => document.querySelector(`[data-testid="${id}${s}"]`);
  const root = q(""), track = q("-track"), handle = q("-handle");
  if (!root || !track) return null;
  const tb = track.getBoundingClientRect(), hb = handle?.getBoundingClientRect();
  return {
    value: Number(root.dataset.value), text: q("-value")?.textContent ?? "", min: q("-min")?.textContent ?? "", max: q("-max")?.textContent ?? "",
    aria: { min: Number(track.getAttribute("aria-valuemin")), max: Number(track.getAttribute("aria-valuemax")), now: Number(track.getAttribute("aria-valuenow")), text: track.getAttribute("aria-valuetext") },
    disabled: root.dataset.disabled, ariaDisabled: track.getAttribute("aria-disabled"), dragging: root.dataset.dragging,
    handle: hb ? { x: hb.left + hb.width / 2, w: hb.width, y: hb.top + hb.height / 2 } : null,
    track: { x: tb.left, y: tb.top, width: tb.width, height: tb.height },
    minus: q("-minus") ? { disabled: q("-minus").getAttribute("aria-disabled") === "true" || q("-minus").hasAttribute("disabled"), h: q("-minus").getBoundingClientRect().height, w: q("-minus").getBoundingClientRect().width } : null,
    plus: q("-plus") ? { disabled: q("-plus").getAttribute("aria-disabled") === "true" || q("-plus").hasAttribute("disabled"), h: q("-plus").getBoundingClientRect().height, w: q("-plus").getBoundingClientRect().width } : null,
  };
}, id);

export async function sliderX(page, id, v, { min = 1, max = 100 } = {}) {
  const s = await sliderOf(page, id);
  const r = s.handle.w / 2;
  return s.track.x + r + ((v - min) / (max - min)) * (s.track.width - 2 * r);
}
export async function sliderY(page, id) { const s = await sliderOf(page, id); return s.track.y + s.track.height / 2; }

/** A press on the track at the place of `v` (a click with a mouse, a tap with a finger). */
export async function tapSlider(page, id, v, opts) {
  // (a list that has just saved a depth draws its slider again: take the place when the track is there and has stopped moving)
  let box = null, again = null;
  for (let i = 0; i < 50 && !(box && again && box.x === again.x && box.y === again.y && box.width === again.width); i++) {
    box = await trackOf(page, id).boundingBox();
    await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
    again = await trackOf(page, id).boundingBox();
  }
  if (!box) throw new Error(`the track of ${id} is not on the page`);
  const x = await sliderX(page, id, v, opts), y = await sliderY(page, id);
  await press(page, trackOf(page, id), { position: { x: x - box.x, y: y - box.y } });
}

// ---- a pointer that goes where the check says, step by step (so that a check can read the page in the middle of a drag)
const sessions = new WeakMap();
const frames = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
const nap = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** The pointer of a kind on a page: "mouse" (page.mouse: any viewport) or "touch" (one finger, by the DevTools protocol: the tablet and the phone).
 *    down(p)         press at p = { x, y }
 *    move(p)         go to p in `steps` steps (a frame is drawn at the end); call it again for the next stop
 *    up()            release where the pointer is
 *    cancel()        the system takes a finger away (touchCancel); a mouse: Escape, then release
 *  The slider takes no hold before a drag (the sheet's pull is on its handle alone), so a finger moves at once. */
export async function pointer(page, kind, { steps = 10 } = {}) {
  const touch = kind === "touch";
  if (touch && !sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  const c = touch ? sessions.get(page) : null;
  let at = null;
  const pts = (p) => [{ x: p.x, y: p.y, id: 1 }];
  return {
    kind,
    async down(p) {
      at = p;
      if (touch) await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(p) });
      else { await page.mouse.move(p.x, p.y); await page.mouse.down(); }
      await frames(page);
    },
    async move(p, n = steps) {
      for (let i = 1; i <= n; i++) {
        const q = { x: at.x + ((p.x - at.x) * i) / n, y: at.y + ((p.y - at.y) * i) / n };
        if (touch) await c.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(q) }); else await page.mouse.move(q.x, q.y);
        await nap(8);
      }
      at = p;
      await frames(page);
    },
    async up() {
      if (touch) await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); else await page.mouse.up();
      await frames(page);
    },
    async cancel() {
      if (touch) await c.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      else { await page.keyboard.press("Escape"); await page.mouse.up(); }
      await frames(page);
    },
  };
}
