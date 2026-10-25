// P0.6 ported (AD-80; package K3): the fixture of toolbar widths, written again for the new build (pixel fixtures are not compared with the
// old page's): app/test/fixtures/composer-widths.json holds the width of every toolbar control of every seeded state of section A2, as the
// page draws them now: each chip with its name capped, in a pane wide enough for the whole row, and the three controls a narrow toolbar has
// beside them (the "more" chip, the meter cut to its ring, the error meter cut to its icon). A chip with a short name is as wide as G1
// measured it (G1 §Q2); one with a long name is as wide as its cap lets it be, where G1 measured it whole. Ports dev/checks/P0.6-widths.mjs
// with its states, G1's numbers and its assertions; the reader is composer.mjs' (a control's wrapper in the row is taken apart: a folder's lock
// and its chip are two controls). The states with a pending move (`act` "move") are played with S8's Branch action (`acts.move`). Desktop only: the widths are those of a window, and the other
// viewports' devices have their own (the fit at them is A2.2's). The three narrow controls are shown by the board's panel at 300 px: a chat page of that
// width is a window under 700 px, the phone layout (ux-improvements C1), whose row has no "more" chip and whose ring is a 44 pt target, so the page's
// widths of the fixture (every row of it is a wide row) are not shown there; the panel is the wide layout at every width. (The error meter's icon has no panel state: it is read on the page of plain-ctxerr at 300 px, where the phone draws the same icon, CtxError's.)
//   WRITE=1 PORT=4900 node web/dev/checks/P0.6-widths.mjs    writes the fixture from the page as it is
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { check, seed, until } from "../shot.mjs";
import { SEES, countOf, frame, openState, playable, toolbarWidths } from "./composer.mjs";
import { tidSel } from "./sel.mjs";

export const viewports = ["desktop"];

const FIXTURE = fileURLToPath(new URL("../../../app/test/fixtures/composer-widths.json", import.meta.url));
const NEAR = 1.5, NEAR_G1 = 3; // px: the same page drawn again; another day's fonts
// G1's cases (G1 §Q2) whose names are short: the seeded states that are one of them, with the sum G1 measured for the chips and gaps on one
// line. (G1's long-name and long-server cases, sums of 520 to 1034, have capped chips now.) (G1 measured an unstarted chat with the server's
// chip, 108 px as a choice and 91.6 as a fixed one, which a chat on this computer no longer has: the chip and its gap are taken off its two
// sums, 545 and 528.6.)
const G1_SUMS = { "plain-started": 338.5, "plain-quotes": 338.5, "plain-ctxerr": 349, "plain-busy": 370.5, "plain-move": 412.7, "plain-new": 433,
  "board-started": 338.5, "board-quotes": 338.5, "board-longname": 338.5, "board-move": 412.7, "board-new": 433 };
// G1's chip widths: [state, kind, whether the chip is a fixed one, width]
const G1_CHIPS = [
  ["plain-new", "agent", false, 115.2], ["plain-new", "folder", false, 70.2], ["plain-started", "folder", true, 53.8], ["plain-new", "model", false, 77.3], ["plain-new", "effort", false, 90.4],
  ["plain-started", "model-effort", true, 97.4], ["plain-new", "meter", false, 28], ["plain-started", "meter", false, 125.3], ["plain-ctxerr", "meter", false, 135.8],
  ["plain-started", "send", false, 28], ["plain-busy", "stop", false, 28], ["plain-started", "lock", false, 10]];
// The chips with a long name, each as wide as its name's cap lets it be (screens/composer/Chip.tsx: 160 pt, the model choice's 76):
// [state, kind, fixed, width, what G1 measured for it uncapped].
const CAPPED = [["plain-new-long", "folder", false, 202.4, 337], ["plain-new-long", "model", false, 102.4, 302.6], ["plain-started-long", "folder", true, 186, 320.6], ["plain-started-long", "model-effort", true, 170, 319.9],
  ["plain-remote-new", "server", true, 170, 188], ["plain-remote-started", "server", true, 170, 188]]; // (the server's chip is a fixed one, started or not)
// What a narrow toolbar has beside its chips: [the fixture's field, the state and the page's width that show it, its selector]
const NARROW = [["more", "board-new", 300, tidSel("more-chip")], ["ring", "board-started", 300, `${tidSel("ctx-meter")}[data-compact]:not([data-tone="error"])`], ["icon", "plain-ctxerr", 300, `${tidSel("ctx-meter")}[data-compact][data-tone="error"]`]];

await check("P0.6 the fixture of toolbar widths, with the chips' caps", async ({ url, layout, open, fail, note }) => {
  const states = {}, gaps = new Set(), chromes = new Set(), narrow = {};
  const seeded = (await seed(url, "A2")).filter((s) => playable(s, layout));
  for (const [field, id, width, sel] of NARROW) {
    const s = seeded.find((x) => x.id === id);
    const { page, ctx } = await openState(open, s, layout, width);
    narrow[field] = await page.locator(sel).first().evaluate((e) => Math.round(e.getBoundingClientRect().width * 10) / 10, null, { timeout: 8000 }).catch(() => null);
    if (narrow[field] === null) fail(`${id} at ${width} px: nothing matches ${sel}, the toolbar's ${field}`);
    await ctx.close();
  }
  for (const s of seeded) {
    // (a pane wide enough for every row: a plain chat's column is 780 px at most, which the long names with the Subagents chip pass, so the
    // column is let as wide as its page while it is measured)
    const { page, ctx } = await openState(open, s, layout, s.pane[0] === "panel" ? 760 : 1400);
    // (and the composer's own side padding is taken away: with it a panel at its most, 760 px, has no room for the six choices of a new chat
    // on a board with the Insert button and the attach button; the controls are as wide with it as without)
    await page.addStyleTag({ content: `${tidSel("chat")} { max-width: none !important } ${tidSel("composer")} { padding-left: 0 !important; padding-right: 0 !important }` });
    const parts = SEES[s.id] ?? [{ tid: "composer-box" }];
    for (const p of parts) if (!await until(async () => (await countOf(page, p)) > 0, 10000)) fail(`${s.id}: nothing matches ${JSON.stringify(p)}`);
    await page.waitForTimeout(100);
    await page.evaluate(() => document.fonts.ready);
    await frame(page); // the toolbar is fitted to the wider row
    const t = await toolbarWidths(page);
    await ctx.close();
    if (t.controls.some((c) => c.kind === "other")) fail(`${s.id}: a control of the toolbar has no kind: ${JSON.stringify(t.controls.filter((c) => c.kind === "other"))}`);
    gaps.add(t.gap); chromes.add(t.chrome);
    states[s.id] = { ...(s.id in G1_SUMS ? { g1: s.id } : {}), pane: s.pane[0], chat: s.sel.chat, sum: t.sum, ...(t.reason ? { reason: true } : {}), controls: t.controls.map((c) => ({ kind: c.kind, label: c.label, ...(c.fixed ? { fixed: true } : {}), w: c.w, ...(c.margin ? { margin: c.margin } : {}) })) };
  }
  if (gaps.size !== 1 || chromes.size !== 1) fail(`the toolbars do not share one gap and one box chrome: gaps ${[...gaps]}, chromes ${[...chromes]}`);
  const now = {
    about: "The width each control of a composer's toolbar asks for, in px, per seeded state of section A2 (web/dev/mock-ui.js), as the web build of the app (app/) draws it in headless Chromium with the system font. Written by `WRITE=1 node web/dev/checks/P0.6-widths.mjs`, which also fails when the page no longer agrees with this file. A chip's name is capped (a chat toolbar's: 160, the model choice's 76), and each state is measured in a pane wide enough for all of its controls.",
    gap: [...gaps][0], chrome: [...chromes][0], ...narrow,
    legend: "gap: between two controls of the toolbar (its spacer is one of them, at no width); chrome: the box's padding and border, so a row of `sum` px needs a box of sum + chrome; more: the chip that opens the popup of the controls the row has no room for; ring: the context meter cut to its ring; icon: the error meter cut to its icon. A state: g1, the name of G1's case it is, where its names are short; pane, where it is shown; sum, its controls and gaps on one line; reason, it has a line under its controls; controls, left to right: kind, label, fixed (a chip that takes no pick), w, and margin where the control has one of its own (the lock): it needs w + margin.",
    states,
  };

  // G1 measured the toolbar before it had the Subagents chip, the Insert button, the attach button and voice's pair (Dictate and Speech mode, one
  // child of the row: kind "voice"): its sums are held against the row without them and their gaps.
  const g1Sum = (st) => Math.round((st.sum - st.controls.filter((c) => c.kind === "subagents" || c.kind === "insert" || c.kind === "voice" || c.kind === "attach").reduce((n, c) => n + c.w + now.gap, 0)) * 10) / 10;
  for (const [id, sum] of Object.entries(G1_SUMS)) {
    if (!states[id]) { if (seeded.some((s) => s.id === id)) fail(`the seed has no state for G1's case ${id}`); continue; }
    if (Math.abs(g1Sum(states[id]) - sum) > NEAR_G1) fail(`${id}: the controls and gaps are ${g1Sum(states[id])} px on one line${states[id].sum === g1Sum(states[id]) ? "" : " without the Subagents chip, the Insert button, voice's pair and the attach button"}; G1 measured ${sum}`);
  }
  for (const [id, kind, fixed, w, g1] of CAPPED) {
    const c = states[id]?.controls.find((x) => x.kind === kind && !!x.fixed === fixed);
    if (!c) fail(`${id}: no ${fixed ? "fixed " : ""}${kind} control to hold against its cap`);
    else if (Math.abs(c.w - w) > NEAR) fail(`${id}: the ${fixed ? "fixed " : ""}${kind} control "${c.label}" is ${c.w} px wide; with its name capped it is ${w} (G1 measured ${g1} for it whole)`);
  }
  // nothing of the toolbar is in the "more" popup while it is measured: a row has every control of its state
  for (const [id, st] of Object.entries(states)) if (st.controls.some((c) => c.kind === "more")) fail(`${id}: the pane it is measured in has no room for all of its controls: ${st.controls.map((c) => c.kind).join(" ")}`);
  for (const [id, kind, fixed, w] of G1_CHIPS) {
    const c = states[id]?.controls.find((x) => x.kind === kind && !!x.fixed === fixed);
    if (!c) fail(`${id}: no ${fixed ? "fixed " : ""}${kind} control to hold against G1's ${w} px`);
    else if (Math.abs(c.w - w) > NEAR_G1) fail(`${id}: the ${fixed ? "fixed " : ""}${kind} control "${c.label}" is ${c.w} px wide, G1 measured ${w}`);
  }
  if (now.gap !== 4) fail(`the toolbar's gap is ${now.gap} px, G1 measured 4`);

  if (process.env.WRITE) { fs.writeFileSync(FIXTURE, JSON.stringify(now, null, 1).replace(/\{\n\s+"kind": ("[^"]*"),\n\s+"label": ("(?:[^"\\]|\\.)*"),\n(?:\s+"fixed": (true),\n)?\s+"w": ([\d.]+)(?:,\n\s+"margin": ([\d.]+))?\n\s+\}/g, (_, k, l, f, w, m) => `{ "kind": ${k}, "label": ${l},${f ? ' "fixed": true,' : ""} "w": ${w}${m ? `, "margin": ${m}` : ""} }`) + "\n"); note(`wrote ${FIXTURE}`); }
  if (!fs.existsSync(FIXTURE)) return fail(`${FIXTURE} is not there: write it with WRITE=1`);
  const kept = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  if (kept.gap !== now.gap || kept.chrome !== now.chrome) fail(`the fixture has gap ${kept.gap} and chrome ${kept.chrome}, the page ${now.gap} and ${now.chrome}`);
  for (const [field] of NARROW) if (!(Math.abs(kept[field] - now[field]) <= NEAR)) fail(`the toolbar's ${field} is ${now[field]} px wide, the fixture has ${kept[field]}`);
  for (const id of new Set([...Object.keys(kept.states), ...Object.keys(states)])) {
    const a = kept.states[id], b = states[id];
    if (!a || !b) { fail(`${id}: ${a ? "in the fixture and not seeded (or not shown)" : "seeded and not in the fixture"}`); continue; }
    const kinds = (x) => x.controls.map((c) => c.kind + (c.fixed ? "*" : "")).join(" ");
    if (kinds(a) !== kinds(b)) { fail(`${id}: the fixture has the controls ${kinds(a)}, the page ${kinds(b)}`); continue; }
    for (const [i, c] of b.controls.entries()) if (Math.abs(c.w - a.controls[i].w) > NEAR || c.label !== a.controls[i].label || (c.margin ?? 0) !== (a.controls[i].margin ?? 0)) fail(`${id}: the ${c.kind} control "${c.label}" is ${c.w} px wide, the fixture has "${a.controls[i].label}" at ${a.controls[i].w}`);
  }
  note(`${Object.keys(states).length} states, ${Object.values(states).reduce((n, s) => n + s.controls.length, 0)} controls; gap ${now.gap}, box chrome ${now.chrome}; "more" ${now.more}, the ring ${now.ring}, the icon ${now.icon}`);
}, { viewports, page: false });
