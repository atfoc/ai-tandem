// UX.F1-kit.mjs's section "picker" (app/src/dev/kit/picker.tsx): what it proves is listed in UX.F1-kit.mjs's header. `run(c)` gets the
// check's helpers (c.T, c.rect, c.press, c.open, c.expect, …: UX.F1-kit.mjs `body`) and calls c.fail for what is wrong.
// The picker is phone-only in the app, but the sheet itself is drawn at every width, so this runs on the desktop viewport too.
const SHEET = '[data-testid="picker-sheet"]';
const ROW = `${SHEET} [data-testid="picker-row"]`;
const SEARCH = `${SHEET} [data-testid="search-field"]`;

export async function run(c) {
  const { page, T, rect, rects, win, near, expect, until, open, text, press, touch } = c;
  const noSheet = () => until(async () => !(await T("picker-sheet").count()));
  /** Closes the sheet that is open by Esc (or the dimmed page), and waits until none is left. */
  const closeSheet = async (what) => {
    if (await T("picker-sheet").count()) await page.keyboard.press("Escape");
    if (!(await noSheet())) {
      const b = T("overlay-backdrop").last();
      if (await b.count()) await b.click({ position: { x: 4, y: 4 }, force: true }).catch(() => {});
    }
    expect(await noSheet(), `${what}: the sheet did not close`);
  };
  const last = () => text("kit-picker-last");
  const opened = async (name) => {
    await open(name);
    const ok = await until(async () => { const r = await rect(SHEET); return r && r.h > 60; });
    if (!ok) c.fail(`${name}: no picker sheet after ${name} was pressed`);
    // the sheet rises for a moment: measure it once it has stopped
    else await c.settled(SHEET);
    // a mouse left over the button must not light a row under it
    if (ok && !touch) await page.mouse.move(1, 1);
    return ok;
  };
  /** Each row of the sheet: its value, aria, background, opacity and its text lines (the ✓ left out) with their font size. */
  const rows = () => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((row) => {
    const out = [];
    const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = n.textContent.trim();
      if (!t || t === "✓") continue;
      out.push({ text: t, px: parseFloat(getComputedStyle(n.parentElement).fontSize) });
    }
    const cs = getComputedStyle(row), r = row.getBoundingClientRect();
    return {
      value: row.getAttribute("data-value"), checked: row.getAttribute("aria-checked"), disabled: row.getAttribute("aria-disabled"),
      role: row.getAttribute("role"), bg: cs.backgroundColor, opacity: parseFloat(cs.opacity), h: r.height, y: r.y,
      check: !!row.querySelector('[data-testid="picker-check"]'), checkText: row.querySelector('[data-testid="picker-check"]')?.textContent ?? null,
      lines: out, outline: cs.outlineStyle,
    };
  }), ROW);
  const clear = (bg) => bg === "rgba(0, 0, 0, 0)" || bg === "transparent";
  const tap = async (value) => { await press(page.locator(`${ROW}[data-value="${value}"]`)); };
  const heads = () => page.evaluate((s) => [...document.querySelectorAll(`${s} [data-testid="menu-head"]`)].map((e) => e.textContent.trim()), SHEET);
  const half = (await win()).h * 0.5;

  // ---- a short picker: fit detent, no search, the chosen row, a note, a disabled row
  if (await opened("picker-short")) {
    await c.sweep(SHEET, "picker-short");
    expect((await text("sheet-title")) === "Language", `short: the title is "${await text("sheet-title")}"`);
    expect((await text("sheet-sub")) === "What you speak in speech mode", `short: the sub-line is "${await text("sheet-sub")}"`);
    const s = await rect(SHEET), t0 = await rect('[data-testid="sheet-title"]');
    expect(!!s && !!t0 && near(t0.x + t0.w / 2, s.x + s.w / 2, 4), "short: the title is not centred");
    expect(!!s && s.h <= half + 2, `short: the sheet is ${s?.h} px high, over half the window (${half})`);
    expect(!(await rect(SEARCH)), "short: a picker of four options has a search field");
    expect(!(await T("sheet-left").count()) && !(await T("sheet-right").count()), "short: the head has a Cancel or a Done");
    expect((await c.minFontPx(SHEET)) >= 13, `short: text in the sheet is ${await c.minFontPx(SHEET)} px, under 13`);

    const rs = await rows();
    expect(rs.length === 4, `short: ${rs.length} rows, not 4`);
    for (const r of rs) {
      expect(r.h >= 49.5, `short: row ${r.value} is ${r.h} px high, under 50`);
      expect(r.lines[0]?.px === 17, `short: the label of ${r.value} is ${r.lines[0]?.px} px, not 17`);
      if (r.lines[1]) expect(r.lines[1].px >= 13, `short: the second line of ${r.value} is ${r.lines[1].px} px, under 13`);
      expect(r.checked === "true" || r.checked === "false", `short: ${r.value} has aria-checked ${r.checked}`);
    }
    expect(rs.filter((r) => r.checked === "true").map((r) => r.value).join() === "english", `short: the rows checked are ${rs.filter((r) => r.checked === "true").map((r) => r.value)}, not english`);
    const on = rs.find((r) => r.value === "english"), off = rs.filter((r) => r.value !== "english");
    expect(!!on?.check && on.checkText === "✓", "short: the chosen row has no ✓");
    expect(off.every((r) => !r.check), "short: a row that is not chosen has a ✓");
    expect(!!on && !clear(on.bg), `short: the chosen row has no tint (${on?.bg})`);
    expect(off.every((r) => clear(r.bg)), `short: a row that is not chosen is tinted (${off.map((r) => r.bg)})`);
    expect(!!on && on.outline !== "solid", `short: the chosen row has an outline (${on?.outline})`);
    expect(rs.find((r) => r.value === "auto")?.lines[1]?.text === "Recognises the language as you talk", "short: a row's note is not its second line");
    const dis = rs.find((r) => r.value === "swahili");
    expect(dis?.disabled === "true" && dis.lines[1]?.text === "Not available offline", `short: the disabled row is ${JSON.stringify(dis)}`);
    expect(!!dis && dis.opacity < 1, `short: the disabled row is not dimmed (opacity ${dis?.opacity})`);
    expect(rs.filter((r) => r.disabled === "true").length === 1, "short: another row than the disabled one is aria-disabled");

    // a press on the disabled row does nothing
    const d = (await rects(`${ROW}[data-value="swahili"]`))[0];
    if (touch) await page.touchscreen.tap(d.x + d.w / 2, d.y + d.h / 2); else await page.mouse.click(d.x + d.w / 2, d.y + d.h / 2);
    await page.waitForTimeout(300);
    expect((await last()) === "closed" && (await T("picker-sheet").count()) === 1, `short: a press on the disabled row did something (last: ${await last()})`);
    // a tap picks and closes
    await tap("german");
    expect(await until(async () => (await last()) === "picker-short:german"), `short: a tap on Deutsch left "${await last()}" in the readout`);
    expect(await noSheet(), "short: the sheet did not close after a row was tapped");
    // reopened, the chosen row is the new one
    if (await opened("picker-short")) {
      const again = (await rows()).filter((r) => r.checked === "true").map((r) => r.value).join();
      expect(again === "german", `short: after the pick the row checked is ${again}, not german`);
      await closeSheet("short");
    }
  }

  // ---- a long picker: large detent, a search pinned in the head, sections, filtering
  if (await opened("picker-long")) {
    await c.sweep(SHEET, "picker-long");
    const w = await win();
    const s = await until(async () => { const r = await rect(SHEET); return r && near(r.y, 8, 2) ? r : null; });
    const sh = await rect(SHEET);
    expect(!!s, `long: the sheet's top is at ${sh?.y}, not 8 px under the window's top (a safe area of 0)`);
    expect(!!sh && near(sh.h, w.h - 8, 2), `long: the sheet is ${sh?.h} px high, not the window (${w.h}) less the safe area and 8`);
    const field = await rect(SEARCH), head = await rect(`${SHEET} [data-testid="sheet-head"]`);
    expect(!!field && field.h >= 43.5, `long: the search field is ${field?.h} px high, under 44`);
    expect(!!field && !!head && field.y >= head.bottom - 1, "long: the search field is not under the head");
    expect((await c.fontPx(SEARCH)) === 17, `long: the search text is ${await c.fontPx(SEARCH)} px, not 17`);
    expect(await page.evaluate((s) => document.querySelector(s)?.getAttribute("placeholder"), SEARCH) === "Search models", "long: the placeholder is not the one given");
    const rs0 = await rows();
    expect(rs0.length === 15, `long: ${rs0.length} rows, not 15`);
    expect(rs0.filter((r) => r.checked === "true").map((r) => r.value).join() === "claude-sonnet", "long: the chosen row is not claude-sonnet");
    expect((await heads()).join() === "Anthropic,OpenAI,Google", `long: the headings are ${(await heads()).join()}`);
    expect(rs0.find((r) => r.value === "claude-opus")?.lines[1]?.text === "The most capable", "long: the note of Claude Opus is missing");

    // the search stays where it is while the list scrolls
    const scroller = () => page.evaluate(() => {
      for (let e = document.querySelector('[data-testid="sheet-body"]'); e; e = e.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1) return true;
      }
      return false;
    });
    expect(await scroller(), "long: the list does not scroll");
    expect(await page.evaluate((s) => {
      const f = document.querySelector(s); const body = document.querySelector('[data-testid="sheet-body"]');
      for (let e = body; e; e = e.parentElement) if (/auto|scroll/.test(getComputedStyle(e).overflowY) && e.contains(f)) return true;
      return false;
    }, SEARCH) === false, "long: the search field is inside the scrolling box");
    const y0 = (await rect(SEARCH)).y, row0 = (await rects(ROW))[0].y;
    await page.evaluate(() => {
      for (let e = document.querySelector('[data-testid="sheet-body"]'); e; e = e.parentElement) if (e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(e).overflowY)) { e.scrollTop = e.scrollHeight; return; }
    });
    expect(await until(async () => (await rects(ROW))[0].y < row0 - 20), "long: the list did not scroll");
    expect(near((await rect(SEARCH)).y, y0, 1), `long: the search field moved from ${y0} to ${(await rect(SEARCH)).y} as the list scrolled`);

    // typing filters; a heading without a match goes; case does not matter; the note counts
    const input = page.locator(SEARCH);
    await input.fill("GPT");
    expect(await until(async () => (await rects(ROW)).length === 5), `long: "GPT" leaves ${(await rects(ROW)).length} rows, not 5`);
    expect((await heads()).join() === "OpenAI", `long: after "GPT" the headings are ${(await heads()).join()}`);
    await input.fill("capable");
    expect(await until(async () => (await rects(ROW)).length === 1), `long: "capable" (a note) leaves ${(await rects(ROW)).length} rows, not 1`);
    expect((await heads()).join() === "Anthropic", `long: after "capable" the headings are ${(await heads()).join()}`);
    // nothing found
    await input.fill("zzz");
    expect(await until(async () => !!(await rect('[data-testid="picker-empty"]'))), "long: no picker-empty for a query with no match");
    expect((await text("picker-empty")) === "No match for “zzz”", `long: the empty line says "${await text("picker-empty")}"`);
    expect((await rects(ROW)).length === 0 && (await heads()).length === 0, "long: rows or headings are left with no match");
    expect((await c.fontPx('[data-testid="picker-empty"] *')) >= 13, "long: the empty line is under 13 px");
    // clear empties the query and brings the list back
    await press(page.locator(`${SHEET} [data-testid="search-clear"]`));
    expect(await until(async () => (await input.inputValue()) === ""), `long: Clear left "${await input.inputValue()}" in the field`);
    expect(await until(async () => (await rects(ROW)).length === 15 && !(await rect('[data-testid="picker-empty"]'))), "long: the list did not come back after Clear");
    expect((await heads()).length === 3, "long: the headings did not come back after Clear");
    // a tap on a filtered row picks and closes
    await input.fill("haiku");
    expect(await until(async () => (await rects(ROW)).length === 1), "long: \"haiku\" does not leave one row");
    await tap("claude-haiku");
    expect(await until(async () => (await last()) === "picker-long:claude-haiku"), `long: a tap on Claude Haiku left "${await last()}" in the readout`);
    expect(await noSheet(), "long: the sheet did not close after a row was tapped");
    // closed, it opens with an empty query
    if (await opened("picker-long")) {
      expect((await page.locator(SEARCH).inputValue()) === "" && (await rects(ROW)).length === 15, "long: the query was kept after the sheet closed");
      await closeSheet("long");
    }
  }

  // ---- a picker with extra controls: a tap picks without closing, Done closes
  if (await opened("picker-extra")) {
    await c.sweep(SHEET, "picker-extra");
    const s = await rect(SHEET);
    expect(!!s && s.h <= half + 2, `extra: the sheet is ${s?.h} px high, over half the window (${half})`);
    expect(!(await rect(SEARCH)), "extra: a picker told not to search has a search field");
    expect(!(await T("sheet-left").count()), "extra: a Cancel is in the head");
    const done = await rect('[data-testid="sheet-right"]');
    expect((await text("sheet-right")) === "Done" && !!done && done.w >= 43.5 && done.h >= 43.5, `extra: the head's right is "${await text("sheet-right").catch(() => "")}" ${done?.w}×${done?.h}, not a 44 pt Done`);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="sheet-right"] *')).fontWeight) >= 600, "extra: Done is not strong");
    const ex = await rect('[data-testid="picker-extra"]'), list = await rects(ROW);
    expect(!!ex && list.length === 4 && ex.y >= list[3].bottom - 1, "extra: the extra controls are not under the list");
    await tap("claude-sonnet");
    expect(await until(async () => (await last()) === "picker-extra:claude-sonnet"), `extra: a tap on Claude Sonnet left "${await last()}" in the readout`);
    await page.waitForTimeout(300);
    expect((await T("picker-sheet").count()) === 1, "extra: the sheet closed after a tap although it has extra controls");
    expect(await until(async () => (await rows()).filter((r) => r.checked === "true").map((r) => r.value).join() === "claude-sonnet"), "extra: the checked row did not move to the one tapped");
    await press(T("kit-effort-high"));
    expect(await until(async () => (await last()) === "effort:high"), `extra: a tap on the effort left "${await last()}" in the readout`);
    expect((await T("picker-sheet").count()) === 1, "extra: the sheet closed after a tap on an extra control");
    await press(T("sheet-right"));
    expect(await noSheet(), "extra: Done did not close the sheet");
  }
}
