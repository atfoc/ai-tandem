// UX.F1-kit.mjs's section "sheets" (app/src/dev/kit/sheets.tsx): what it proves is listed in UX.F1-kit.mjs's header. `run(c)` gets the
// check's helpers (c.T, c.rect, c.press, c.open, c.expect, …: UX.F1-kit.mjs `body`) and calls c.fail for what is wrong.
// The Sheet is a sheet at every width, so this runs on the desktop viewport too.
const DANGER_LIGHT = "rgb(224, 49, 49)"; // tokens.ts `danger` of the light theme

export async function run(c) {
  const { page, T, rect, rects, win, near, expect, until, open, text, press } = c;
  const noSheet = () => until(async () => !(await T("sheet").count()) && !(await T("action-sheet").count()));
  /** Closes the sheet that is open by the dimmed page, and waits until none is left. */
  const closeSheet = async (what) => {
    if (await T("sheet").count() + await T("action-sheet").count()) await page.keyboard.press("Escape");
    if (!(await noSheet())) {
      const b = T("overlay-backdrop").last();
      if (await b.count()) await b.click({ position: { x: 4, y: 4 }, force: true }).catch(() => {});
    }
    expect(await noSheet(), `${what}: the sheet did not close`);
  };
  const last = () => text("kit-sheets-last");
  const opened = async (name, id) => {
    await open(name);
    if (!expect(await until(async () => !!(await rect(id))), `${name}: no ${id} after ${name} was pressed`)) return false;
    await c.settled(id); // (the sheet rises: measure it once it has stopped)
    return true;
  };
  /** The texts of the rows' lines in DOM order, with their font size and colour: [{ label, note, labelPx, notePx }] per `action-row` of `root`. */
  const lines = (root) => page.evaluate((r) => [...document.querySelectorAll(`${r} [data-testid="action-row"]`)].map((row) => {
    const out = [];
    const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent.trim()) continue;
      const cs = getComputedStyle(n.parentElement);
      out.push({ text: n.textContent.trim(), px: parseFloat(cs.fontSize), colour: cs.color });
    }
    return { action: row.getAttribute("data-action"), aria: row.getAttribute("aria-disabled"), lines: out };
  }), root);

  // ---- P1, the action sheet: head, 50 pt rows, 17 pt labels, 13 pt notes, a waiting row, the destructive row last
  if (await opened("action", '[data-testid="action-sheet"]')) {
    const sheet = '[data-testid="action-sheet"]';
    await c.sweep(sheet, "action");
    expect((await text("sheet-title")) === "Checkout service", `action: the head's title is "${await text("sheet-title")}"`);
    expect((await text("sheet-sub")) === "Group · 3 boards · 6 chats", `action: the head's sub is "${await text("sheet-sub")}"`);
    const title = await rect('[data-testid="sheet-title"]'), tile = await page.evaluate(() => {
      const h = document.querySelector('[data-testid="sheet-head"]'); const kids = h ? [...h.children] : [];
      const r = kids[0]?.getBoundingClientRect(); return r ? { w: r.width, h: r.height, right: r.right } : null;
    });
    expect(!!tile && tile.w >= 36 && tile.w <= 40.5 && near(tile.w, tile.h, 1), `action: the head's tile is ${JSON.stringify(tile)}, not a 36–40 pt square`);
    expect(!!tile && title.x >= tile.right, `action: the title (x ${title.x}) is not after the tile (right ${tile?.right})`);
    expect((await page.evaluate((s) => document.querySelector(s)?.textContent ?? "", sheet)).search(/cancel/i) < 0, "action: the sheet has a Cancel");
    expect(((await c.minFontPx(sheet)) ?? 0) >= 13, `action: text in the sheet is ${await c.minFontPx(sheet)} px, under 13`);

    const rows = await rects(`${sheet} [data-testid="action-row"]`);
    expect(rows.length === 5, `action: ${rows.length} rows, not 5`);
    for (const [i, r] of rows.entries()) expect(r.h >= 49.5, `action: row ${i + 1} is ${r.h} px high, under 50`);
    const ls = await lines(sheet);
    for (const r of ls) {
      expect(r.lines[0]?.px === 17, `action: the label of ${r.action} is ${r.lines[0]?.px} px, not 17`);
      if (r.lines[1]) expect(r.lines[1].px >= 13, `action: the second line of ${r.action} is ${r.lines[1].px} px, under 13`);
    }
    expect(ls.find((r) => r.action === "new-board")?.lines[1]?.text === "Opens on the board", "action: a row's note is not its second line");
    const wait = ls.find((r) => r.action === "archive");
    expect(wait?.aria === "true" && wait.lines[1]?.text === "Waits for the agent to stop", `action: the waiting row is ${JSON.stringify(wait)}`);
    // the destructive row: last in the DOM and on the page, after a separator, in red
    const ids = ls.map((r) => r.action);
    expect(ids.at(-1) === "delete", `action: the rows are ${ids.join(", ")}: the destructive one is not last`);
    const sep = await rects(`${sheet} [data-testid="menu-sep"]`);
    expect(sep.length === 1 && sep[0].y > rows[3].y && sep[0].bottom <= rows[4].y + 1, "action: no separator between the list and the destructive row");
    expect(rows.every((r, i) => !i || r.y > rows[i - 1].y), "action: the rows are not in order down the sheet");
    const theme = await text("gallery-theme");
    const red = ls.find((r) => r.action === "delete")?.lines[0]?.colour;
    if (theme === "light") expect(red === DANGER_LIGHT, `action: the destructive label is ${red}, not ${DANGER_LIGHT}`);
    else expect(red !== ls[0].lines[0].colour, `action: the destructive label is not in another colour than the others (${red})`);
    // a press on the waiting row does nothing
    const w = rows[3];
    if (c.touch) await page.touchscreen.tap(w.x + w.w / 2, w.y + w.h / 2); else await page.mouse.click(w.x + w.w / 2, w.y + w.h / 2);
    await page.waitForTimeout(300);
    expect((await last()) === "closed" && (await T("action-sheet").count()) === 1, `action: a press on the waiting row did something (last: ${await last()})`);
    // a press on a row writes its id and closes the sheet
    await press(page.locator(`${sheet} [data-action="rename"]`));
    expect(await until(async () => (await last()) === "rename"), `action: a press on Rename left "${await last()}" in the readout`);
    expect(await noSheet(), "action: the sheet did not close after a row was pressed");
  }

  // ---- the quick row
  if (await opened("action-quick", '[data-testid="action-sheet"]')) {
    const sheet = '[data-testid="action-sheet"]';
    await c.sweep(sheet, "action-quick");
    const q = await rect(`${sheet} [data-testid="action-quick"]`);
    expect(!!q, "action-quick: no quick row");
    const btns = await rects(`${sheet} [data-testid="action-quick"] [data-testid="action-row"]`);
    expect(btns.length === 4, `action-quick: ${btns.length} quick buttons, not 4`);
    for (const [i, b] of btns.entries()) {
      expect(b.w >= 63.5 && b.h >= 59.5, `action-quick: button ${i + 1} is ${b.w}×${b.h}, under 64×60`);
      expect(q && b.y >= q.y - 1 && b.bottom <= q.bottom + 1, `action-quick: button ${i + 1} is outside the row`);
    }
    expect(btns.every((b, i) => !i || (b.x > btns[i - 1].x && near(b.y, btns[0].y, 1))), "action-quick: the buttons are not in one row");
    const px = await page.evaluate((s) => [...document.querySelectorAll(`${s} [data-testid="action-quick"] [data-testid="action-row"]`)].map((b) => {
      const t = [...b.querySelectorAll("div,span")].filter((e) => e.children.length === 0 && e.textContent.trim()).pop();
      return { px: t ? parseFloat(getComputedStyle(t).fontSize) : null, bg: getComputedStyle(b).backgroundColor, below: t ? t.getBoundingClientRect().y > b.querySelector("svg").getBoundingClientRect().y : false };
    }), sheet);
    for (const [i, b] of px.entries()) {
      expect(b.px >= 13, `action-quick: label ${i + 1} is ${b.px} px, under 13`);
      expect(b.bg !== "rgba(0, 0, 0, 0)" && b.bg !== "transparent", `action-quick: button ${i + 1} has no background`);
      expect(b.below, `action-quick: the icon of button ${i + 1} is not above its label`);
    }
    const list = await rects(`${sheet} [data-testid="menu"] [data-testid="action-row"]`);
    expect(list.length === 3 && list.every((r) => r.y > btns[0].bottom), `action-quick: ${list.length} list rows, not 3 under the quick row`);
    await press(page.locator(`${sheet} [data-testid="action-quick"] [data-action="quote"]`));
    expect(await until(async () => (await last()) === "quote"), `action-quick: a press on Quote left "${await last()}" in the readout`);
    expect(await noSheet(), "action-quick: the sheet did not close after a quick button was pressed");
  }

  // ---- the detents
  const half = (await win()).h * 0.5;
  /** The scrolling box of the sheet's body: the nearest scrollable ancestor of `sheet-body`. */
  const scroller = () => page.evaluate(() => {
    for (let e = document.querySelector('[data-testid="sheet-body"]'); e; e = e.parentElement) {
      const o = getComputedStyle(e).overflowY;
      if ((o === "auto" || o === "scroll") && e.scrollHeight > e.clientHeight + 1) return { scrollHeight: e.scrollHeight, clientHeight: e.clientHeight, scrolls: true };
    }
    const b = document.querySelector('[data-testid="sheet-body"]');
    return { scrollHeight: b?.scrollHeight ?? 0, clientHeight: b?.parentElement?.clientHeight ?? 0, scrolls: false };
  });
  if (await opened("fit-long", '[data-testid="sheet"]')) {
    await c.sweep('[data-testid="sheet"]', "fit-long");
    const s = await until(async () => { const r = await rect('[data-testid="sheet"]'); return r && r.h > 100 ? r : null; });
    expect(!!s && s.h <= half + 2, `fit-long: the sheet is ${s?.h} px high, over half the window (${half})`);
    const sc = await scroller();
    expect(sc.scrolls, `fit-long: the body does not scroll: ${JSON.stringify(sc)}`);
    expect(!!(await rect('[data-testid="sheet-body"]')) && (await rect('[data-testid="sheet-body"]')).h > sc.clientHeight, "fit-long: the body is not taller than its window");
    await closeSheet("fit-long");
  }
  if (await opened("fit-short", '[data-testid="sheet"]')) {
    const s = await until(async () => { const r = await rect('[data-testid="sheet"]'); return r && r.h > 50 ? r : null; });
    expect(!!s && s.h < half, `fit-short: the sheet is ${s?.h} px high, not under half the window (${half})`);
    expect(!(await scroller()).scrolls, "fit-short: two rows scroll");
    await closeSheet("fit-short");
  }
  if (await opened("large", '[data-testid="sheet"]')) {
    await c.sweep('[data-testid="sheet"]', "large");
    const w = await win();
    const top = await until(async () => { const r = await rect('[data-testid="sheet"]'); return r && near(r.y, 8, 2) ? r : null; });
    const s = await rect('[data-testid="sheet"]');
    expect(!!top, `large: the sheet's top is at ${s?.y}, not 8 px under the window's top (a safe area of 0)`);
    expect(!!s && near(s.bottom, w.h, 2), `large: the sheet's bottom is at ${s?.bottom}, not the window's (${w.h})`);
    const head0 = await rect('[data-testid="sheet-head"]');
    const t0 = await rect('[data-testid="sheet-title"]');
    expect(!!s && !!t0 && near(t0.x + t0.w / 2, s.x + s.w / 2, 4), `large: the centred title's middle is at ${t0 && t0.x + t0.w / 2}, the sheet's at ${s && s.x + s.w / 2}`);
    expect(!!(await rect('[data-testid="sheet-left"]')) && !!(await rect('[data-testid="sheet-right"]')), "large: the head has no Cancel and Save");
    for (const id of ["sheet-left", "sheet-right"]) { const r = await rect(`[data-testid="${id}"]`); expect(!!r && r.w >= 43.5 && r.h >= 43.5, `large: ${id} is ${r?.w}×${r?.h}, under 44`); }
    const sc = await scroller();
    expect(sc.scrolls, `large: the body does not scroll: ${JSON.stringify(sc)}`);
    await page.evaluate(() => {
      for (let e = document.querySelector('[data-testid="sheet-body"]'); e; e = e.parentElement) if (e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(e).overflowY)) { e.scrollTop = e.scrollHeight; return; }
    });
    expect(await until(async () => (await page.evaluate(() => { for (let e = document.querySelector('[data-testid="sheet-body"]'); e; e = e.parentElement) if (e.scrollTop > 0) return e.scrollTop; return 0; })) > 0), "large: the body did not scroll");
    const head1 = await rect('[data-testid="sheet-head"]');
    expect(!!head0 && !!head1 && near(head0.y, head1.y, 1), `large: the head moved from ${head0?.y} to ${head1?.y} as the body scrolled`);
    await closeSheet("large");
  }
  if (await opened("head-start", '[data-testid="sheet"]')) {
    await c.sweep('[data-testid="sheet"]', "head-start");
    const title = await rect('[data-testid="sheet-title"]'), tile = await rect('[data-testid="kit-head-tile"]'), sub = await rect('[data-testid="sheet-sub"]');
    expect(!!title && !!tile && title.x > tile.right, `head-start: the title (x ${title?.x}) is not after the tile (right ${tile?.right})`);
    expect(!!title && !!sub && near(title.x, sub.x, 1) && sub.y > title.y, "head-start: the sub-line is not under the title");
    const s = await rect('[data-testid="sheet"]');
    expect(!!title && !!s && title.x < s.x + s.w / 2, "head-start: the title is not at the start");
    await closeSheet("head-start");
  }
}
