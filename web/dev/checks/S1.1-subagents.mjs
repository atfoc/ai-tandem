// Proves that the Subagents chip (plans/subagent-depth.md, P1 to P6) is a control of the fitted toolbar like the
// others, and that its popover keeps open through a pick wherever the chip is. In a wide page it is in the row: a
// pick is saved, the popover stays open, the chip says the new settings and stays in the row though it is wider now
// (the others leave before it), and Esc closes the popover alone. In a narrow page it is in the "more" popup: the
// popover opens from there inside the window, a pick is saved with the popover and the popup still open, Esc closes
// the popover first and the popup next. On a started chat the chip is fixed and opens nothing; in the default panel
// beside a board, where the row has no room for it, a fixed chip on the default settings is not drawn at all, and
// the toolbar has no "more" chip for it. Nor does it take the meter's text: in a panel of 430 px, where the row is
// whole with that text (in the default one the attach button takes the room of it), the chip is not drawn either.
import { act, check, mockEval, openPage, paneSize, seed, until } from "../shot.mjs";

const HEIGHT = 640;
const CHIP = ".composer .sub-chip", POP = ".composer .sub-pop", MORE = ".composer .more-chip", MOREPOP = ".composer .more-pop";

await check("S1.1 the Subagents chip in the toolbar's row and in the \"more\" popup", async ({ url, browser, fail, note }) => {
  const states = await seed(url, "A2");
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const frame = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  const open = async (s, width) => {
    const errors = [];
    const { ctx, page } = await openPage({ url, browser, errors, sel: s.sel, ...paneSize(s.pane[0], width, HEIGHT), wait: ".composer-box .send" });
    await act(page, s.act);
    await page.evaluate(() => document.fonts.ready);
    await frame(page);
    return { ctx, page, errors };
  };
  const close = async ({ ctx, errors }, name) => { for (const e of errors) fail(`${name}: page error: ${e}`); await ctx.close(); };
  /** In the page: where the chip is, what it says, and whether its popover is open and inside the window. */
  const at = (page) => page.evaluate(([chip, pop]) => {
    const c = document.querySelector(chip), p = document.querySelector(pop), r = p?.getBoundingClientRect();
    return { where: !c ? "" : c.closest(".more-pop") ? "popup" : "row", says: c?.textContent.replace(/▾/g, "").trim() ?? "", fixed: !!c?.matches(".static"),
      open: !!p, inside: !!r && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      marked: [...(p?.querySelectorAll('[aria-checked="true"]') ?? [])].map((e) => e.textContent.replace("✓", "").trim()).join(","), more: !!document.querySelector(".composer .more-pop") };
  }, [CHIP, POP]);
  const pick = (page, row) => page.locator(`${POP} [role="radio"]`, { hasText: row }).first().click();
  const saved = (code) => until(() => mockEval(code, url), 8000);

  { // in the row of a wide page
    const p = await open(state("plain-new"), 900), name = "a new chat in a 900 px page";
    let now = await at(p.page);
    if (now.where !== "row" || now.fixed || now.says !== "Subagents1 level") fail(`${name}: the chip is ${JSON.stringify(now)}`);
    await p.page.locator(CHIP).click();
    if (!await until(async () => (await at(p.page)).open, 5000)) fail(`${name}: a click on the chip opened no popover`);
    if ((await at(p.page)).marked !== "1 level,100") fail(`${name}: the popover marks ${(await at(p.page)).marked}`);
    await pick(p.page, "3 levels");
    if (!await saved('return chats.c_A2_new.subDepth === 3;')) fail(`${name}: the depth was not saved`);
    await pick(p.page, /^25$/);
    if (!await saved('return chats.c_A2_new.subCap === 25;')) fail(`${name}: the cap was not saved`);
    if (!await until(async () => (await at(p.page)).says === "Subagents3 levels · 25 at once", 5000)) fail(`${name}: the chip says "${(await at(p.page)).says}"`);
    await frame(p.page);
    now = await at(p.page);
    if (!now.open || now.marked !== "3 levels,25") fail(`${name}: after two picks the popover is ${now.open ? "open" : "closed"} and marks ${now.marked}`);
    if (now.where !== "row") fail(`${name}: the chip left the row with its popover open`);
    await pick(p.page, "Off");
    if (!await saved('return chats.c_A2_new.subOff === true;')) fail(`${name}: Off was not saved`);
    if (!await until(() => p.page.locator(`${POP} .sub-pop-cap.off`).count(), 5000)) fail(`${name}: with depth Off the "Running at once" section is not greyed`);
    await p.page.keyboard.press("Escape");
    if (!await until(async () => !(await at(p.page)).open, 5000)) fail(`${name}: Esc did not close the popover`);
    if (await p.page.locator(".composer .send.stop").count()) fail(`${name}: Esc reached the composer`);
    await close(p, name);
    note("in the row: two picks saved with the popover open, the wider chip still in the row, Off greys the cap, Esc closes the popover");
  }
  await seed(url, "A2");
  { // in the "more" popup of a narrow page
    const p = await open(state("plain-new"), 400), name = "a new chat in a 400 px page";
    if (await p.page.locator(CHIP).count()) fail(`${name}: the chip is drawn with the popup closed`);
    await p.page.locator(MORE).click();
    if (!await until(async () => (await at(p.page)).where === "popup", 5000)) fail(`${name}: the chip is not in the "more" popup: ${JSON.stringify(await at(p.page))}`);
    await p.page.locator(`${MOREPOP} .sub-chip`).click();
    if (!await until(async () => (await at(p.page)).open, 5000)) fail(`${name}: a click on the chip in the popup opened no popover`);
    if (!(await at(p.page)).inside) fail(`${name}: the popover is not inside the window`);
    await pick(p.page, "2 levels");
    if (!await saved('return chats.c_A2_new.subDepth === 2;')) fail(`${name}: the depth was not saved`);
    await pick(p.page, /^10$/);
    if (!await saved('return chats.c_A2_new.subCap === 10;')) fail(`${name}: the cap was not saved`);
    if (!await until(async () => (await at(p.page)).says === "Subagents2 levels · 10 at once", 5000)) fail(`${name}: the chip says "${(await at(p.page)).says}"`);
    await frame(p.page);
    const now = await at(p.page);
    if (!now.open || !now.more || now.where !== "popup" || now.marked !== "2 levels,10") fail(`${name}: after two picks: ${JSON.stringify(now)}`);
    await p.page.keyboard.press("Escape");
    if (!await until(async () => { const x = await at(p.page); return !x.open && x.more; }, 5000)) fail(`${name}: the first Esc did not close the popover alone: ${JSON.stringify(await at(p.page))}`);
    await p.page.keyboard.press("Escape");
    if (!await until(async () => !(await at(p.page)).more, 5000)) fail(`${name}: the second Esc did not close the "more" popup`);
    await close(p, name);
    note("in the \"more\" popup: the popover opens inside the window, two picks saved with popover and popup open, Esc closes the popover, then the popup");
  }
  await seed(url, "A2");
  { // fixed on a started chat
    const p = await open(state("plain-started"), 900), name = "a started chat in a 900 px page";
    const now = await at(p.page);
    if (now.where !== "row" || !now.fixed) fail(`${name}: the chip is ${JSON.stringify(now)}`);
    await p.page.locator(CHIP).click();
    await frame(p.page);
    if ((await at(p.page)).open) fail(`${name}: the fixed chip opened a popover`);
    await close(p, name);
    // (400 px is the default panel, where the attach button has the room of the meter's text; at 430 px the row has
    // all of its controls and that text, with less to spare than the chip is wide)
    for (const [width, panel, whole] of [[400, "a started chat in the default panel beside a board", false], [430, "a started chat in a 430 px panel beside a board", true]]) {
      const q = await open(state("board-started"), width);
      if (await q.page.locator(CHIP).count() || await q.page.locator(MORE).count()) fail(`${panel}: ${await q.page.locator(CHIP).count()} Subagents chips and ${await q.page.locator(MORE).count()} "more" chips`);
      if (whole && await q.page.locator(".composer .ctx-meter.compact").count()) fail(`${panel}: the meter is cut to its ring`);
      await close(q, panel);
    }
    note("a started chat: the chip is fixed and opens nothing; in the default panel a fixed chip on the default settings is not drawn, and costs no \"more\" chip, nor the meter's text where the row has it");
  }
});
