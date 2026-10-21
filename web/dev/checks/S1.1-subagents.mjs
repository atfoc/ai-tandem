// Proves that the Subagents chip (plans/subagent-depth.md, P1 to P6) is a control of the fitted toolbar like the others, and that its list
// keeps open through a pick wherever the chip is (package S7; C-SS-02 to C-SS-10, C-TX-16, C-TX-17, C-TX-24, C-TX-27, C-CH-20, C-NC-10). In a wide
// page it is in the row: a pick is saved, the list stays open, the chip says the new settings and stays in the row though it is wider now (the
// others leave before it), and Esc closes the list alone. In a narrow page it is in the "more" popup: the list opens from there inside the
// window, a pick is saved with the list and the popup still open, Esc closes the list first and the popup next. On a started chat the chip is
// fixed and opens nothing; in the default panel beside a board, where the row has no room for it, a fixed chip on the default settings is not
// drawn at all, and the toolbar has no "more" chip for it. Nor does it take the meter's text: in a panel of 430 px, where the row is whole with
// that text (in the default one the attach button takes the room of it), the chip is not drawn either.
// Ports dev/checks/S1.1-subagents.mjs: its states, widths, picks and assertions, at the three viewports. Deviations, each from the layout:
//   - the pages are the pane's width as K3's ports open them (composer.mjs openAt): a window under 700 px is the phone layout (AD-72), so the
//     narrow page of 400 px is a phone-layout chat at every viewport, where the list is a sheet over the "more" popup's sheet; the popover
//     form of the list from "more" (the wide layouts) is read on the desktop in the panel beside a board (board-new, 400 px), which is new;
//   - the phone's chat screen is as wide as the window, so the wide page of the old check (900 px) is held by the desktop and the tablet only;
//   - new, no old check proved them: a press outside closes the list, the focus is on the current depth as the list opens, the arrows go
//     through the rows that take a pick, and the focus returns to the chip as the list closes (C-SS-03, C-SS-06, C-CH-20).
import { check, mockEval, seed, until } from "../shot.mjs";
import { MORE, POP, chip, frame, openAt, playable } from "./composer.mjs";
import { byTid, press, tidSel } from "./sel.mjs";

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
  const at = (page) => page.evaluate(({ chipSel, popSel, moreSel, optSel }) => {
    const c = document.querySelector(chipSel), p = document.querySelector(popSel), r = p?.getBoundingClientRect();
    return { where: !c ? "" : c.closest(moreSel) ? "popup" : "row", says: c?.textContent.replace(/▾/g, "").trim() ?? "", fixed: c?.dataset.fixed === "true",
      open: !!p, inside: !!r && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
      marked: [...(p?.querySelectorAll(`${optSel}[aria-checked="true"]`) ?? [])].map((e) => e.textContent.replace("✓", "").trim()).join(","), more: !!document.querySelector(moreSel) };
  }, { chipSel: tidSel("tchip", { kind: "subagents" }), popSel: tidSel("sub-pop"), moreSel: tidSel("more-pop"), optSel: tidSel("sub-opt") });
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
    await pick(p.page, "cap", 25, fail, name);
    if (!await saved('return chats.c_A2_new.subCap === 25;')) fail(`${name}: the cap was not saved`);
    if (!await until(async () => (await at(p.page)).says === "Subagents3 levels · 25 at once", 5000)) fail(`${name}: the chip says "${(await at(p.page)).says}"`);
    await frame(p.page);
    now = await at(p.page);
    if (!now.open || now.marked !== "3 levels,25") fail(`${name}: after two picks the list is ${now.open ? "open" : "closed"} and marks ${now.marked}`);
    if (now.where !== "row") fail(`${name}: the chip left the row with its list open`);
    // the arrows go through the rows that take a pick, of both sections, and wrap (C-SS-06)
    const arrow = async (from, key) => { await opt(p.page, ...from).focus(); await p.page.keyboard.press(key); const f = await focused(p.page); return `${f.section}:${f.value}`; };
    for (const [from, key, to] of [[["cap", 25], "ArrowUp", "cap:10"], [["cap", 25], "ArrowDown", "cap:50"], [["cap", 100], "ArrowDown", "depth:0"], [["depth", 0], "ArrowUp", "cap:100"]]) {
      const got = await arrow(from, key);
      if (got !== to) fail(`${name}: ${key} from ${from.join(" ")} went to ${got}, not to ${to}`);
    }
    await pick(p.page, "depth", 0, fail, name);
    if (!await saved('return chats.c_A2_new.subOff === true;')) fail(`${name}: Off was not saved`);
    if (!await until(() => byTid(p.page, "sub-pop-cap", { off: true }).count(), 5000)) fail(`${name}: with depth Off the "Running at once" section is not greyed`);
    // with depth Off the cap's rows take no pick and the arrows pass them over
    const wrap = await arrow(["depth", 0], "ArrowUp");
    if (wrap !== "depth:3") fail(`${name}: with depth Off ArrowUp from Off went to ${wrap}, not to the last row that takes a pick (depth:3)`);
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
    note("in the row: two picks saved with the list open, the focus on the current depth, the wider chip still in the row, the arrows, Off greys the cap, Esc and a press outside close the list and the focus returns to the chip");
  }
  await seed(url, "A2");
  { // in the "more" popup of a narrow page
    const p = await openAt(open, state("plain-new"), layout, 400), name = "a new chat in a 400 px page";
    if (await CHIP(p.page).count()) fail(`${name}: the chip is drawn with the popup closed`);
    await press(p.page, p.page.locator(MORE));
    if (!await until(async () => (await at(p.page)).where === "popup", 5000)) fail(`${name}: the chip is not in the "more" popup: ${JSON.stringify(await at(p.page))}`);
    await press(p.page, CHIP(p.page));
    if (!await until(async () => (await at(p.page)).open, 5000)) fail(`${name}: a press on the chip in the popup opened no list`);
    if (!(await settled(p.page)).inside) fail(`${name}: the list is not inside the window`);
    await pick(p.page, "depth", 2, fail, name);
    if (!await saved('return chats.c_A2_new.subDepth === 2;')) fail(`${name}: the depth was not saved`);
    await pick(p.page, "cap", 10, fail, name);
    if (!await saved('return chats.c_A2_new.subCap === 10;')) fail(`${name}: the cap was not saved`);
    if (!await until(async () => (await at(p.page)).says === "Subagents2 levels · 10 at once", 5000)) fail(`${name}: the chip says "${(await at(p.page)).says}"`);
    await frame(p.page);
    const now = await at(p.page);
    if (!now.open || !now.more || now.where !== "popup" || now.marked !== "2 levels,10") fail(`${name}: after two picks: ${JSON.stringify(now)}`);
    await p.page.keyboard.press("Escape");
    if (!await until(async () => { const x = await at(p.page); return !x.open && x.more; }, 5000)) fail(`${name}: the first Esc did not close the list alone: ${JSON.stringify(await at(p.page))}`);
    await p.page.keyboard.press("Escape");
    if (!await until(async () => !(await at(p.page)).more, 5000)) fail(`${name}: the second Esc did not close the "more" popup`);
    await close(p);
    note(`in the "more" popup${layout === "desktop" ? "" : " (a sheet)"}: the list opens inside the window, two picks saved with list and popup open, Esc closes the list, then the popup`);
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
    if (!wide && await p.page.locator(MORE).count()) await press(p.page, p.page.locator(MORE)); // (the chip is in the "more" popup of the narrow page)
    const now = await at(p.page);
    if ((wide && now.where !== "row") || !now.fixed || (!wide && now.says !== "Subagents2 levels · 25 at once")) fail(`${name}: the chip is ${JSON.stringify(now)}`);
    if (now.fixed) {
      await press(p.page, CHIP(p.page)).catch(() => {}); // (a fixed chip is no button: a press on it reaches nothing)
      await frame(p.page);
      if ((await at(p.page)).open) fail(`${name}: the fixed chip opened a list`);
    }
    await close(p);
    // (400 px is the default panel, where the attach button has the room of the meter's text and voice's pair has room beside the controls; at
    // 430 px the row has all of its controls and that text, with less to spare than the pair is wide: the pair goes into the "more" popup, which
    // brings the chip, the meter's text gives its room to the chip, and the fixed chip on the default settings is in the popup with the pair)
    for (const [width, panel, pair] of [[400, "a started chat in the default panel beside a board", false], [430, "a started chat in a 430 px panel beside a board", true]]) {
      const q = await openAt(open, state("board-started"), layout, width);
      const chips = await CHIP(q.page).count(), mores = await q.page.locator(MORE).count();
      if (chips || mores !== (pair ? 1 : 0)) fail(`${panel}: ${chips} Subagents chips in the row and ${mores} "more" chips`);
      if (pair) {
        await press(q.page, q.page.locator(MORE));
        if (!await until(() => q.page.locator(POP).count(), 5000)) fail(`${panel}: the "more" chip opens no popup`);
        else {
          const rows = await byTid(q.page.locator(POP), "more-row").evaluateAll((es) => es.map((e) => e.dataset.control));
          if (!rows.includes("dictate") || !rows.includes("speech")) fail(`${panel}: the popup holds ${rows}, not the pair`);
          if (!await CHIP(q.page.locator(POP)).count()) fail(`${panel}: the fixed Subagents chip is not in the popup with the pair`);
        }
      }
      await close(q);
    }
    note("a started chat: the chip is fixed and opens nothing; in the default panel a fixed chip on the default settings is not drawn, and costs no \"more\" chip; where voice's pair has no room beside the controls it is in the popup, with the chip");
  }
}, { viewports, page: false });
