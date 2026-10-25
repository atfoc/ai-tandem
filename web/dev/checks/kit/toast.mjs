// UX.F1-kit.mjs's section "toast" (app/src/dev/kit/toast.tsx): what it proves is listed in UX.F1-kit.mjs's header. `run(c)` gets the
// check's helpers (c.T, c.rect, c.press, c.open, c.expect, …: UX.F1-kit.mjs `body`) and calls c.fail for what is wrong.
//   - the toast is one `toast` with the kind, its text, `aria-live="polite"` (on it or above it), 48 px high, its text 13 px or more,
//     its action 44 × 44 or more, inside the window (16 px at the sides on the phone, above the bottom edge);
//   - Undo runs the action and takes the toast away; a second toast replaces the first; a short one goes within 6 s; the default
//     time is over by 9 s and not before 3 s; the lift of a bottom bar puts the toast above the bar;
//   - the action's text has a contrast of 4.5 or more on the toast in the light, the dark and the mocha theme.
import { until } from "../../shot.mjs";

const TOAST = '[data-testid="toast"]';

/** The contrast (WCAG) of the action's text on the toast's background, from the colours the page draws. */
const contrast = (c) => c.page.evaluate(() => {
  const toast = document.querySelector('[data-testid="toast"]'), action = document.querySelector('[data-testid="toast-action"]');
  if (!toast || !action) return null;
  const parse = (css) => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
  const label = [...action.querySelectorAll("*")].find((e) => e.textContent.trim() && !e.children.length) ?? action;
  const fg = lum(parse(getComputedStyle(label).color)), bg = lum(parse(getComputedStyle(toast).backgroundColor));
  return { ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05), bg: getComputedStyle(toast).backgroundColor };
});

export async function run(c) {
  const { T, expect, until: wait } = c;
  const count = () => c.page.locator(TOAST).count();
  const gone = (ms = 6000) => wait(async () => (await count()) === 0, ms);
  const nowMs = () => Date.now();

  // The toast with Undo.
  await c.open("toast-undo");
  expect(await wait(async () => (await count()) === 1), "toast: the toast with Undo did not appear, or not once");
  expect(await T("toast").getAttribute("data-kind") === "archived", `toast: its kind is ${await T("toast").getAttribute("data-kind")}, not archived`);
  expect((await c.text("toast-text")) === "Archived “Fix the flaky cart test”", `toast: its text is "${await c.text("toast-text")}"`);
  expect(await c.page.evaluate((s) => document.querySelector(s)?.closest("[aria-live]")?.getAttribute("aria-live"), TOAST) === "polite", "toast: it is not a polite live region (aria-live)");
  expect(await c.page.evaluate((s) => document.querySelector(s)?.closest("[role=status]") != null, TOAST), "toast: it has no role status");
  // The size is measured once it has risen (it fades and rises in for 180 ms).
  await wait(async () => { const r = await c.rect(TOAST); return r && (await c.page.evaluate((s) => getComputedStyle(document.querySelector(s)).opacity, TOAST)) === "1"; });
  const r = await c.rect(TOAST), a = await c.rect('[data-testid="toast-action"]'), w = await c.win();
  if (expect(r && a, "toast: the toast or its action has no box")) {
    expect(r.h >= 48 - 0.5, `toast: ${r.h.toFixed(1)} px high, not 48`);
    expect(a.w >= 44 - 0.5 && a.h >= 44 - 0.5, `toast: the action is ${a.w.toFixed(1)} × ${a.h.toFixed(1)} px, not 44 × 44`);
    expect(r.x >= -0.5 && r.right <= w.w + 0.5 && r.bottom <= w.h + 0.5, `toast: the box is outside the window (${JSON.stringify(r)} in ${w.w}×${w.h})`);
    if (c.touch) expect(r.x >= 16 - 0.5 && w.w - r.right >= 16 - 0.5, `toast: the side margins are ${r.x.toFixed(1)} and ${(w.w - r.right).toFixed(1)} px, not 16`);
    expect(r.w <= 560 + 0.5, `toast: ${r.w.toFixed(1)} px wide, not 560 at most`);
    expect(r.bottom < w.h, `toast: its bottom ${r.bottom.toFixed(1)} is not above the window's bottom ${w.h}`);
  }
  const min = await c.minFontPx(TOAST);
  expect(min !== null && min >= 13, `toast: the smallest text in it is ${min} px, not 13`);

  // Undo runs and takes the toast away.
  await c.press(T("toast-action").first());
  expect(await wait(async () => (await c.text("kit-toast-last")) === "undo"), `toast: after Undo the readout says "${await c.text("kit-toast-last")}", not undo`);
  expect(await gone(), "toast: the toast is still there after Undo");

  // A second toast replaces the first.
  await c.open("toast-undo");
  await wait(async () => (await count()) === 1);
  await c.open("toast-plain");
  await wait(async () => (await T("toast").first().getAttribute("data-kind")) === "back-online");
  expect((await count()) === 1, `toast: ${await count()} toasts after a second one, not 1`);
  expect(await T("toast-action").count() === 0, "toast: the plain toast has an action");
  await c.press(T("kit-hide-toast").first());
  expect(await gone(), "toast: Hide toast did not take it away");

  // The short one: shown at once, gone within 6 s.
  const t0 = nowMs();
  await c.open("toast-short");
  const seen = await wait(async () => (await count()) === 1, 3000);
  if (!seen && nowMs() - t0 > 1200) c.note("toast: the short toast was over before the check looked (a slow machine)");
  else expect(seen, "toast: the short toast did not appear");
  expect(await gone(6000), "toast: the short toast (1.5 s) is still there after 6 s");

  // The default time: there at 3 s, gone by 9 s.
  const t1 = nowMs();
  await c.open("toast-plain");
  await wait(async () => (await count()) === 1);
  const left = 3000 - (nowMs() - t1);
  if (left > 0) await new Promise((res) => setTimeout(res, left));
  if (nowMs() - t1 > 4500) c.note("toast: the default time was not measured at 3 s (a slow machine)");
  else expect((await count()) === 1, "toast: the default toast was gone at 3 s");
  expect(await gone(Math.max(1000, 9000 - (nowMs() - t1))), "toast: the default toast is still there after 9 s");

  // The lift of a bottom bar.
  await c.open("toast-lift");
  expect(await wait(async () => (await c.rect('[data-testid="kit-toast-bar"]')) !== null), "toast: the fake bar did not appear");
  const barTop = (await c.rect('[data-testid="kit-toast-bar"]'))?.y;
  await c.open("toast-plain");
  await wait(async () => (await count()) === 1);
  await wait(async () => { const t = await c.rect(TOAST); return t && t.bottom <= barTop + 0.5; });
  const lifted = await c.rect(TOAST);
  expect(lifted && barTop !== undefined && lifted.bottom <= barTop + 0.5, `toast: with a bar of 120 points the toast's bottom is ${lifted?.bottom} and the bar's top ${barTop}`);
  await c.press(T("kit-hide-toast").first());
  await gone();
  await c.open("toast-lift");
  expect(await wait(async () => (await c.rect('[data-testid="kit-toast-bar"]')) === null), "toast: the fake bar did not go");

  // The action's contrast in every theme.
  let before = null;
  for (const theme of ["light", "dark", "mocha"]) {
    await c.press(T(`gallery-theme-${theme}`).first());
    await c.open("toast-undo");
    expect(await wait(async () => { const k = await contrast(c); return k && k.bg !== before; }), `toast: ${theme}: the toast did not change its colour`);
    const k = await contrast(c);
    expect(k && k.ratio >= 4.5, `toast: ${theme}: the action's text has a contrast of ${k?.ratio?.toFixed(2)} on the toast, not 4.5`);
    before = k?.bg ?? before;
    await c.press(T("kit-hide-toast").first());
    await gone();
  }
  await c.press(T("gallery-theme-light").first());
}
