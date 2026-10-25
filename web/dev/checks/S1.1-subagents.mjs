// Proves that the Subagents chip (plans/subagent-depth.md, P1 to P6) is a control of the fitted toolbar like the others, and that its list
// keeps open through a pick wherever the chip is (package S7; C-SS-02 to C-SS-10, C-TX-16, C-TX-17, C-TX-24, C-TX-27, C-CH-20, C-NC-10). In a wide
// page it is in the row: a pick is saved, the list stays open, the chip says the new settings and stays in the row though it is wider now (the
// others leave before it), and Esc closes the list alone. In a narrow page it is in the "more" popup: the list opens from there inside the
// window, a pick is saved with the list and the popup still open, Esc closes the list first and the popup next. On a started chat the chip is
// fixed and opens nothing; in a panel of 400 or 430 px beside a board, where the row keeps voice's pair longest (core's composerfit), the controls
// leave for the "more" popup and the fixed chip on the default settings is drawn there, not in the row.
// Ports dev/checks/S1.1-subagents.mjs: its states, widths, picks and assertions, at the three viewports. Deviations, each from the layout:
//   - the pages are the pane's width as K3's ports open them (composer.mjs openAt): a window under 700 px is the phone layout (AD-72), so the
//     narrow page of 400 px is a phone-layout chat at every viewport, where the list is a sheet over the "more" popup's sheet; the popover
//     form of the list from "more" (the wide layouts) is read on the desktop in the panel beside a board (board-new, 400 px), which is new;
//   - the phone's chat screen is as wide as the window, so the wide page of the old check (900 px) is held by the desktop and the tablet only;
//   - new, no old check proved them: a press outside closes the list, the focus is on the current depth as the list opens, the arrows go
//     through the rows that take a pick, and the focus returns to the chip as the list closes (C-SS-03, C-SS-06, C-CH-20).
//   - "Running at once" is a slider since small-improvements (goal 3.3), no longer rows or segments: the pick is a tap on its track (slider.mjs),
//     the marks read the depth rows' ✓ and the slider's data-value, ↑/↓ go from the last depth row to the slider's track and back (a slider with
//     verticalKeys off leaves them to the menu), ←/→ on the track change the cap by one with one PATCH each, and depth Off greys the slider
//     (data-disabled, aria-disabled; no key and no −/+ moves it, no call). SI.3 proves the slider itself.
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { MORE, POP, chip, closeChoice, frame, openAt, openChoice, phoneChip, pickDepthPhone, playable, setCapPhone } from "./composer.mjs";
import { byTid, press, tidSel } from "./sel.mjs";
import { sliderOf, tapSlider, trackOf } from "./slider.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const CHIP = (page) => chip(page, "subagents");
const opt = (page, section, value) => byTid(page, "sub-opt", { section, value });
/** A press on a row of the list. The list is drawn once: a row is told apart by its section and value alone (a list that is drawn in two places
 *  for a moment as it opens inside the "more" popup, or as the popup moves it, is waited out). */
const pick = async (page, section, value, fail, name) => {
  if (!await until(async () => (await opt(page, section, value).count()) === 1, 5000)) fail(`${name}: ${await opt(page, section, value).count()} rows of the list are ${section} ${value}, not one`);
  await press(page, opt(page, section, value).first());
};
// The pane the row has room for the chip in: the desktop's page of 900 px, the tablet's window of 810 px (under 820 the sidebar starts hidden).
const WIDE = { desktop: 900, tablet: 810 };

await check("S1.1 the Subagents chip in the toolbar's row and in the \"more\" popup", async ({ url, layout, open, fail, note }) => {
  const states = (await seed(url, "A2")).filter((s) => playable(s, layout));
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const close = async ({ ctx }) => { await ctx.close(); };
  /** In the page: where the chip is, what it says, and whether its list is open and inside the window. */
  const at = (page) => page.evaluate(({ chipSel, popSel, moreSel, optSel, capSel }) => {
    const c = document.querySelector(chipSel), p = document.querySelector(popSel), r = p?.getBoundingClientRect();
    return { where: !c ? "" : c.closest(moreSel) ? "popup" : "row", says: c?.textContent.replace(/▾/g, "").trim() ?? "", fixed: c?.dataset.fixed === "true",
      open: !!p, inside: !!r && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
      marked: [...(p?.querySelectorAll(`${optSel}[aria-checked="true"]`) ?? [])].map((e) => e.textContent.replace("✓", "").trim()).concat(p?.querySelector(capSel)?.dataset.value ?? "").join(","), more: !!document.querySelector(moreSel) };
  }, { chipSel: tidSel("tchip", { kind: "subagents" }), popSel: tidSel("sub-pop"), moreSel: tidSel("more-pop"), optSel: tidSel("sub-opt"), capSel: tidSel("sub-cap") });
  /** The list has come to rest (a sheet rises into the window), then whether it is inside. */
  const settled = async (page) => {
    let last = "";
    await until(async () => { const b = await byTid(page, "sub-pop").first().boundingBox().catch(() => null); const now = JSON.stringify(b); const still = now === last && !!b; last = now; return still; }, 4000);
    return at(page);
  };
  const saved = (code) => until(() => mockEval(code, url), 8000);
  const focused = (page) => page.evaluate(() => { const e = document.activeElement; return { id: e?.dataset?.testid ?? "", section: e?.dataset?.section ?? "", value: e?.dataset?.value ?? "", kind: e?.dataset?.kind ?? "", checked: e?.getAttribute("aria-checked") ?? "" }; });

  if (layout !== "phone") { // in the row of a wide page
    const p = await openAt(open, state("plain-new"), layout, WIDE[layout]), name = `a new chat in a ${WIDE[layout]} px ${layout === "desktop" ? "page" : "window"}`;
    const calls = callsOf(p.page), capCalls = () => calls.filter((c) => c.method === "PATCH" && c.body && "subCap" in c.body).map((c) => c.body.subCap);
    let now = await at(p.page);
    if (now.where !== "row" || now.fixed || now.says !== "Subagents1 level") fail(`${name}: the chip is ${JSON.stringify(now)}`);
    await press(p.page, CHIP(p.page));
    if (!await until(async () => (await at(p.page)).open, 5000)) fail(`${name}: a press on the chip opened no list`);
    now = await settled(p.page);
    if (now.marked !== "1 level,100") fail(`${name}: the list marks ${now.marked}`);
    if (!now.inside) fail(`${name}: the list is not inside the window`);
    // the focus is on the current depth, so the arrows and Enter work at once (C-SS-03)
    if (!await until(async () => { const f = await focused(p.page); return f.id === "sub-opt" && f.section === "depth" && f.checked === "true"; }, 3000)) fail(`${name}: the focus is not on the current depth as the list opens: ${JSON.stringify(await focused(p.page))}`);
    await pick(p.page, "depth", 3, fail, name);
    if (!await saved('return chats.c_A2_new.subDepth === 3;')) fail(`${name}: the depth was not saved`);
    await tapSlider(p.page, "sub-cap", 25); // (the cap is a slider: a tap on its track at the place of 25)
    if (!await saved('return chats.c_A2_new.subCap === 25;')) fail(`${name}: the cap was not saved`);
    if (capCalls().join() !== "25") fail(`${name}: a tap on the slider made the cap calls [${capCalls()}], not one with 25`);
    if (!await until(async () => (await at(p.page)).says === "Subagents3 levels · 25 at once", 5000)) fail(`${name}: the chip says "${(await at(p.page)).says}"`);
    await frame(p.page);
    now = await at(p.page);
    if (!now.open || now.marked !== "3 levels,25") fail(`${name}: after two picks the list is ${now.open ? "open" : "closed"} and marks ${now.marked}`);
    if (now.where !== "row") fail(`${name}: the chip left the row with its list open`);
    // the arrows go through the rows that take a pick and the slider, and wrap (C-SS-06): from the last depth row ↓ goes to the slider's track, from
    // the track ↓ to the first depth row (a slider leaves ↑/↓ to the menu), and ↑ the other way round
    const SLIDER = "slider";
    const arrow = async (from, key) => {
      if (from === SLIDER) await trackOf(p.page, "sub-cap").focus(); else await opt(p.page, ...from).focus();
      await p.page.keyboard.press(key);
      const f = await focused(p.page);
      return f.id === "sub-cap-track" ? SLIDER : `${f.section}:${f.value}`;
    };
    for (const [from, key, to] of [[["depth", 2], "ArrowUp", "depth:1"], [["depth", 1], "ArrowDown", "depth:2"], [["depth", 3], "ArrowDown", SLIDER], [SLIDER, "ArrowDown", "depth:0"], [SLIDER, "ArrowUp", "depth:3"], [["depth", 0], "ArrowUp", SLIDER]]) {
      const got = await arrow(from, key);
      if (got !== to) fail(`${name}: ${key} from ${Array.isArray(from) ? from.join(" ") : from} went to ${got}, not to ${to}`);
    }
    if (capCalls().join() !== "25") fail(`${name}: the arrows ↑/↓ through the list made cap calls: [${capCalls()}]`);
    // ← and → on the track change the cap by one, one call each (the slider keeps them; the menu's own keys are ↑/↓)
    await trackOf(p.page, "sub-cap").focus();
    await p.page.keyboard.press("ArrowRight");
    if (!await saved('return chats.c_A2_new.subCap === 26;')) fail(`${name}: → on the slider did not save 26`);
    await p.page.keyboard.press("ArrowLeft");
    if (!await saved('return chats.c_A2_new.subCap === 25;')) fail(`${name}: ← on the slider did not save 25`);
    if (!await until(async () => capCalls().join() === "25,26,25" && (await sliderOf(p.page, "sub-cap")).value === 25, 5000)) fail(`${name}: → and ← made the cap calls [${capCalls()}] and the slider says ${(await sliderOf(p.page, "sub-cap")).value}, not 25,26,25 and 25`);
    await pick(p.page, "depth", 0, fail, name);
    if (!await saved('return chats.c_A2_new.subOff === true;')) fail(`${name}: Off was not saved`);
    if (!await until(() => byTid(p.page, "sub-pop-cap", { off: true }).count(), 5000)) fail(`${name}: with depth Off the "Running at once" section is not greyed`);
    {
      // with depth Off the slider is greyed, out of the tab order, and nothing moves it: keys and − / + do nothing and make no call
      if (!await until(async () => (await sliderOf(p.page, "sub-cap")).disabled === "true", 5000)) fail(`${name}: with depth Off the slider's data-disabled is "${(await sliderOf(p.page, "sub-cap")).disabled}", not "true"`);
      const off = await sliderOf(p.page, "sub-cap"), before = capCalls().length;
      if (off.ariaDisabled !== "true") fail(`${name}: with depth Off the track's aria-disabled is ${off.ariaDisabled}, not "true"`);
      await trackOf(p.page, "sub-cap").focus().catch(() => {});
      for (const k of ["ArrowRight", "ArrowLeft", "End", "Home", "PageUp"]) await p.page.keyboard.press(k);
      await byTid(p.page, "sub-cap-plus").click({ force: true, timeout: 3000 }).catch(() => {});
      await byTid(p.page, "sub-cap-minus").click({ force: true, timeout: 3000 }).catch(() => {});
      await frame(p.page); await p.page.waitForTimeout(300);
      const after = await sliderOf(p.page, "sub-cap");
      if (after.value !== 25 || capCalls().length !== before) fail(`${name}: with depth Off the keys and −/+ moved the slider to ${after.value} / made ${capCalls().length - before} calls`);
    }
    // with depth Off the cap's rows take no pick and the arrows pass them over
    const wrap = await arrow(["depth", 0], "ArrowUp");
    if (wrap !== "depth:3") fail(`${name}: with depth Off ArrowUp from Off went to ${wrap}, not to the last row that takes a pick (depth:3: the greyed slider is passed over)`);
    await p.page.keyboard.press("Escape");
    if (!await until(async () => !(await at(p.page)).open, 5000)) fail(`${name}: Esc did not close the list`);
    if (await byTid(p.page, "stop").count()) fail(`${name}: Esc reached the composer`);
    // closing hands the focus back to the chip (C-SS-06)
    if (!await until(async () => (await focused(p.page)).kind === "subagents", 3000)) fail(`${name}: the focus is not on the chip after Esc: ${JSON.stringify(await focused(p.page))}`);
    // a press outside closes it too (C-CH-20); the press is not also acted on
    await press(p.page, CHIP(p.page));
    if (!await until(async () => (await at(p.page)).open, 5000)) fail(`${name}: a second press on the chip opened no list`);
    await settled(p.page);
    await press(p.page, byTid(p.page, "overlay-backdrop").first(), { position: { x: 3, y: 3 } });
    if (!await until(async () => !(await at(p.page)).open, 5000)) fail(`${name}: a press outside did not close the list`);
    await close(p);
    note("in the row: a depth row and a tap on the slider saved with the list open (one call), the focus on the current depth, the wider chip still in the row, ↑/↓ between the depth rows and the slider, ←/→ one call each, Off greys the slider and nothing moves it, Esc and a press outside close the list and the focus returns to the chip");
  }
  await seed(url, "A2");
  // (a page under 700 px is the phone layout at every viewport, and the phone's chips are in its chip row with no "more" popup (package C2): the
  // narrow page is read at the phone viewport alone, and the popup's popover form is read below in the panel beside a board)
  if (layout === "phone") { // in the chip row of a narrow page: the chip opens the sheet "Subagents"
    const p = await openAt(open, state("plain-new"), layout, 400), name = "a new chat in a 400 px page";
    const chipSays = async () => ((await phoneChip(p.page, "subagents").textContent()) ?? "").replace(/⌄/g, "").trim();
    if (await p.page.locator(MORE).count() || await p.page.locator(POP).count()) fail(`${name}: the phone has a "more" chip or popup`);
    if (!await phoneChip(p.page, "subagents").count()) fail(`${name}: the chip row has no Subagents chip`);
    else {
      if (await chipSays() !== "Subagents · 1 level") fail(`${name}: the chip says "${await chipSays()}", not "Subagents · 1 level"`);
      await openChoice(p.page, "subagents");
      const sheet = byTid(p.page, "sub-sheet");
      if (await byTid(p.page, "sub-pop").count()) fail(`${name}: the popover form of the list is drawn at the phone layout`);
      const marked = async () => (await sheet.locator(`${tidSel("sub-opt")}[data-on="true"]`).evaluateAll((es) => es.map((e) => `${e.dataset.section}:${e.dataset.value}`))).concat(`cap:${(await sliderOf(p.page, "sub-cap")).value}`).join(",");
      if (await marked() !== "depth:1,cap:100") fail(`${name}: the sheet marks ${await marked()}, not depth:1,cap:100`);
      await pickDepthPhone(p.page, 2);
      if (!await saved('return chats.c_A2_new.subDepth === 2;')) fail(`${name}: the depth was not saved`);
      await setCapPhone(p.page, 25);
      if (!await saved('return chats.c_A2_new.subCap === 25;')) fail(`${name}: the cap was not saved`);
      if (!await until(async () => (await chipSays()) === "Subagents · 2 levels · 25 at once", 5000)) fail(`${name}: the chip says "${await chipSays()}", not "Subagents · 2 levels · 25 at once"`);
      await frame(p.page);
      if (!await byTid(p.page, "sub-sheet").count() || await marked() !== "depth:2,cap:25") fail(`${name}: after two picks the sheet is ${await byTid(p.page, "sub-sheet").count() ? "open" : "closed"} and marks ${await marked()}`);
      // Off greys the cap (the slider takes no move: no key, no −/+, no call)
      await pickDepthPhone(p.page, 0);
      if (!await saved('return chats.c_A2_new.subOff === true;')) fail(`${name}: Off was not saved`);
      if (!await until(() => byTid(p.page, "sub-cap", { disabled: "true" }).count(), 5000)) fail(`${name}: with depth Off the "Running at once" control is not greyed`);
      if ((await sliderOf(p.page, "sub-cap")).ariaDisabled !== "true") fail(`${name}: with depth Off the slider's track is not aria-disabled`);
      const calls = callsOf(p.page);
      await trackOf(p.page, "sub-cap").focus().catch(() => {});
      for (const k of ["ArrowRight", "End"]) await p.page.keyboard.press(k);
      await byTid(p.page, "sub-cap-plus").click({ force: true, timeout: 3000 }).catch(() => {});
      await frame(p.page); await p.page.waitForTimeout(300);
      if ((await sliderOf(p.page, "sub-cap")).value !== 25 || calls.some((c) => c.method === "PATCH")) fail(`${name}: with depth Off the keys and + moved the slider or made a call`);
      // Done closes the sheet, and the chip stays in the row with the saved words
      await closeChoice(p.page);
      if (await byTid(p.page, "sub-sheet").count()) fail(`${name}: Done did not close the sheet`);
      if (!await until(async () => /^Subagents · Off/.test(await chipSays()), 5000)) fail(`${name}: after Done the chip says "${await chipSays()}"`);
    }
    await close(p);
    note("at the phone layout: the Subagents chip is in the chip row (no \"more\" popup), its sheet opens inside the window, a depth pick and a tap on the cap slider saved with the sheet open and the chip following, Off greys the slider (nothing moves it), Done closes it");
  }
  if (layout === "desktop") { // the popover form of the list, from the popup of a panel beside a board
    await seed(url, "A2");
    const p = await openAt(open, state("board-new"), layout, 400), name = "a new chat in a 400 px panel beside a board";
    await press(p.page, p.page.locator(MORE));
    if (!await until(async () => (await at(p.page)).where === "popup", 5000)) fail(`${name}: the chip is not in the "more" popup: ${JSON.stringify(await at(p.page))}`);
    await press(p.page, CHIP(p.page));
    if (!await until(async () => (await at(p.page)).open, 5000)) fail(`${name}: a press on the chip in the popup opened no list`);
    const now = await settled(p.page);
    if (!now.inside) fail(`${name}: the popover is not inside the window`);
    if (await byTid(p.page, "sheet").count()) fail(`${name}: the list is a sheet on the desktop layout`);
    await pick(p.page, "depth", 2, fail, name);
    if (!await saved('return chats.c_A2_board_new.subDepth === 2;')) fail(`${name}: the depth was not saved`);
    await p.page.keyboard.press("Escape");
    if (!await until(async () => { const x = await at(p.page); return !x.open && x.more; }, 5000)) fail(`${name}: the first Esc did not close the popover alone: ${JSON.stringify(await at(p.page))}`);
    await p.page.keyboard.press("Escape");
    if (!await until(async () => !(await at(p.page)).more, 5000)) fail(`${name}: the second Esc did not close the "more" popup`);
    await close(p);
    note("in the \"more\" popup of a panel beside a board: the list is a popover inside the window, a pick saved, Esc closes the popover, then the popup");
  }
  await seed(url, "A2");
  { // fixed on a started chat
    const wide = layout !== "phone";
    // (the phone's window holds no room for a fixed chip on the default settings, which the row leaves out: that chat has other settings)
    if (!wide) await mockEval("chats.c_plain.subDepth = 2; chats.c_plain.subCap = 25;", url);
    const p = await openAt(open, state("plain-started"), layout, wide ? WIDE[layout] : 400), name = `a started chat in a ${wide ? WIDE[layout] + " px " + (layout === "desktop" ? "page" : "window") : "400 px page"}`;
    // (the phone: a started chat has no chip row at all, so no Subagents chip, fixed or not, and no "more" chip)
    if (!wide && (await byTid(p.page, "composer-chip-row").count() || await byTid(p.page, "tchip").count() || await p.page.locator(MORE).count())) fail(`${name}: a started chat has a chip row (${await byTid(p.page, "composer-chip-row").count()}), ${await byTid(p.page, "tchip").count()} chips and ${await p.page.locator(MORE).count()} "more" chips at the phone layout: it has none`);
    const now = wide ? await at(p.page) : { fixed: false };
    if (wide && (now.where !== "row" || !now.fixed)) fail(`${name}: the chip is ${JSON.stringify(now)}`);
    if (now.fixed) {
      await press(p.page, CHIP(p.page)).catch(() => {}); // (a fixed chip is no button: a press on it reaches nothing)
      await frame(p.page);
      if ((await at(p.page)).open) fail(`${name}: the fixed chip opened a list`);
    }
    await close(p);
    // (the panel beside a board is the desktop's alone: a window of 400 px is the phone layout at the other viewports. Since the composer keeps
    // voice's pair longest (core's composerfit), the pair stays in the row beside the attach button at both widths, and what leaves for the "more"
    // popup are the controls: the fixed chip on the default settings is among them, drawn in the popup with the folder and the model)
    for (const [width, panel] of layout === "desktop" ? [[400, "a started chat in the default panel beside a board"], [430, "a started chat in a 430 px panel beside a board"]] : []) {
      const q = await openAt(open, state("board-started"), layout, width);
      const chips = await CHIP(q.page).count(), mores = await q.page.locator(MORE).count();
      if (chips || mores !== 1) fail(`${panel}: ${chips} Subagents chips in the row and ${mores} "more" chips`);
      const pair = await q.page.locator(`${tidSel("voice-dictate")}, ${tidSel("voice-speech")}`).count();
      if (pair !== 2) fail(`${panel}: ${pair} of voice's pair in the row, not two`);
      await press(q.page, q.page.locator(MORE));
      if (!await until(() => q.page.locator(POP).count(), 5000)) fail(`${panel}: the "more" chip opens no popup`);
      else {
        const rows = await byTid(q.page.locator(POP), "more-row").evaluateAll((es) => es.map((e) => e.dataset.control));
        if (rows.includes("dictate") || rows.includes("speech")) fail(`${panel}: the popup holds ${rows}: voice's pair left the row`);
        if (!await CHIP(q.page.locator(POP)).count()) fail(`${panel}: the fixed Subagents chip is not in the popup`);
      }
      await close(q);
    }
    note("a started chat: the chip is fixed and opens nothing; in a panel beside a board (the desktop's) voice's pair stays in the row and the fixed chip on the default settings is in the \"more\" popup");
  }
}, { viewports, page: false });
