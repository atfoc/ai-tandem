// UX.F1-kit.mjs's section "cells" (app/src/dev/kit/cells.tsx): what it proves is listed in UX.F1-kit.mjs's header. `run(c)` gets the
// check's helpers (c.T, c.rect, c.press, c.open, c.expect, …: UX.F1-kit.mjs `body`) and calls c.fail for what is wrong.
const LIGHT_WARN = "rgb(232, 163, 23)", WARN_TEXT = "rgb(154, 103, 0)";
const CELL = '[data-testid="cell"]', row = (r) => `${CELL}[data-row="${r}"]`;

/** The box and the computed style of the smallest element in `scope` whose own text is `words`; null when there is none. */
const textOf = (c, scope, words) => c.page.evaluate(([s, w]) => {
  const root = document.querySelector(s); if (!root) return null;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.textContent.trim() !== w) continue;
    const e = n.parentElement, r = e.getBoundingClientRect(), cs = getComputedStyle(e), range = document.createRange();
    range.selectNodeContents(n);
    const g = range.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom, ink: { x: g.x, w: g.width },
      font: parseFloat(cs.fontSize), line: parseFloat(cs.lineHeight), colour: cs.color };
  }
  return null;
}, [scope, words]);

/** The colour of the nearest ground behind `words` in `scope`, and the contrast of the words against it. */
const contrastOf = (c, scope, words) => c.page.evaluate(([s, w]) => {
  const root = document.querySelector(s); if (!root) return null;
  const parse = (v) => (v.match(/[\d.]+/g) ?? []).map(Number);
  const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.textContent.trim() !== w) continue;
    const fg = getComputedStyle(n.parentElement).color;
    let bg = [255, 255, 255];
    for (let e = n.parentElement; e; e = e.parentElement) {
      const p = parse(getComputedStyle(e).backgroundColor);
      if (p.length >= 3 && (p.length === 3 || p[3] > 0.99)) { bg = p; break; }
    }
    const [hi, lo] = [lum(parse(fg)), lum(bg)].sort((a, b) => b - a);
    return { fg, ratio: (hi + 0.05) / (lo + 0.05) };
  }
  return null;
}, [scope, words]);

export async function run(c) {
  const { T, page, rect, rects, fontPx, minFontPx, near, expect, press, until } = c;
  const SUB = "3 connected · 1 paused", LONG = "Fix the flaky cart test in the checkout service before Friday";
  const light = T("gallery-theme-light").first();
  await light.scrollIntoViewIfNeeded(); await press(light);
  await T("kit-section-cells").first().scrollIntoViewIfNeeded();
  expect(await until(async () => (await rects(CELL)).length === 5), "cells: the gallery should show five cells");

  // the sizes
  for (const [i, r] of (await rects(CELL)).entries()) expect(r.h >= 47.5, `cells: cell ${i} is ${r.h} px high, under 48`);
  for (const name of ["servers", "library", "archived", "version", "remove"]) {
    const label = { servers: "Servers", library: "Prompt library", archived: "Archived", version: "Version", remove: "Remove server" }[name];
    const t = await textOf(c, row(name), label);
    expect(t && t.font === 17, `cells: the label of ${name} is ${t?.font} px, not 17`);
  }
  const sub = await textOf(c, row("servers"), SUB);
  expect(sub && sub.font >= 13, `cells: the sub-line is ${sub?.font} px, under 13`);
  expect(await fontPx(`${CELL} [data-testid="cell-value"]`) >= 13, "cells: a value is under 13 px");
  expect(await minFontPx(CELL) >= 13, `cells: some text of a cell is under 13 px (${await minFontPx(CELL)})`);

  // the chevrons: the cells that push have one, the plain fact has none
  for (const name of ["servers", "library", "archived", "remove"]) expect(await page.locator(`${row(name)} svg`).count() === 1, `cells: ${name} pushes and has no chevron`);
  expect(await page.locator(`${row("version")} svg`).count() === 0, "cells: the Version cell is a plain fact and has a chevron");
  expect(await page.locator(`${row("version")} [data-testid="cell-value"]`).count() === 1, "cells: the Version cell shows no value");

  // the separators: between the cells of a card, none after the last, and inset to where the words begin
  const SEP = '[data-testid="cell-separator"]';
  const groups = await page.locator('[data-testid="cell-group"]').count();
  expect(groups === 2, `cells: ${groups} groups, not 2`);
  expect(await page.locator(`${SEP}`).count() === 3, `cells: ${await page.locator(SEP).count()} separators, not 3 (2 + 1)`);
  for (const name of ["archived", "remove"]) expect(await page.locator(`${row(name)} ${SEP}`).count() === 0, `cells: ${name} is the last of its card and has a separator`);
  for (const name of ["servers", "library", "version"]) expect(await page.locator(`${row(name)} ${SEP}`).count() === 1, `cells: ${name} has no separator under it`);
  const sep = await rect(`${row("servers")} ${SEP}`), cell = await rect(row("servers"));
  expect(sep && cell && sep.x >= cell.x + 15 && near(sep.bottom, cell.bottom, 1.5) && sep.h <= 1.5, `cells: the separator is not an inset hairline at the cell's foot: ${JSON.stringify({ sep, cell })}`);

  // the warning's text is warnText, not the amber of the marks
  const warn = await textOf(c, row("servers"), SUB);
  expect(warn && warn.colour !== LIGHT_WARN, `cells: the warning sub-line is the light theme's amber ${LIGHT_WARN}`);
  expect(warn && warn.colour === WARN_TEXT, `cells: the warning sub-line is ${warn?.colour}, not ${WARN_TEXT}`);
  const lightRatio = await contrastOf(c, row("servers"), SUB);
  expect(lightRatio && lightRatio.ratio >= 4.5, `cells: the warning sub-line is ${lightRatio?.ratio.toFixed(2)}:1 in the light theme`);

  // a press
  await press(page.locator(row("library")));
  expect(await until(async () => (await c.text("kit-cells-last")) === "library"), `cells: a press on Prompt library wrote "${await c.text("kit-cells-last")}"`);
  await press(page.locator(row("servers")));
  expect(await until(async () => (await c.text("kit-cells-last")) === "servers"), `cells: a press on Servers wrote "${await c.text("kit-cells-last")}"`);

  // PlaceBar: the title in the middle of the bar, whatever the back holds
  const bar = await rect('[data-testid="kit-placebar"] [data-testid="place-bar"]'), title = await textOf(c, '[data-testid="kit-placebar"] [data-testid="place-bar"]', "Settings");
  expect(bar && title && bar.h >= 51.5, `placebar: the bar is ${bar?.h} px high, under 52`);
  expect(bar && title && near(title.ink.x + title.ink.w / 2, bar.x + bar.w / 2, 2), `placebar: the title's centre is ${title && title.ink.x + title.ink.w / 2}, the bar's ${bar && bar.x + bar.w / 2}`);
  expect(title && title.font === 17, `placebar: the title is ${title?.font} px, not 17`);
  const back = await rect('[data-testid="kit-place-back"]');
  expect(back && back.h >= 44 && back.w >= 44 && back.x >= bar.x + 7, `placebar: the back is ${back?.w}×${back?.h} at ${back?.x}`);
  await press(T("kit-place-back").first());
  expect(await until(async () => (await c.text("kit-cells-last")) === "place-back"), "placebar: the back did not press");

  // ContentBar: a long name keeps its two lines, the sub is under it, the actions keep their 44 pt and the title stays out of their way
  const cbar = await rect('[data-testid="kit-contentbar"] [data-testid="content-bar"]');
  const name = await page.evaluate(() => { const e = document.querySelector('[data-testid="kit-contentbar"] [data-testid="bar-title"]'), r = e.getBoundingClientRect(), p = e.parentElement.getBoundingClientRect(); return { h: r.height, line: parseFloat(getComputedStyle(e).lineHeight), font: parseFloat(getComputedStyle(e).fontSize), right: p.right, text: e.textContent }; });
  expect(name.text === LONG, `contentbar: the title says "${name.text}"`);
  expect(name.font === 17, `contentbar: the title is ${name.font} px, not 17`);
  expect(name.h >= 2 * name.line - 2, `contentbar: the title is ${name.h} px high, under two lines (${name.line} each): cut to one line`);
  const fadeBox = await rect('[data-testid="kit-contentbar"] [data-testid="bar-title-fade"]');
  const fadeImage = await page.evaluate(() => { const e = document.querySelector('[data-testid="kit-contentbar"] [data-testid="bar-title-fade"]'); return e ? getComputedStyle(e).backgroundImage : ""; });
  expect(fadeBox && fadeImage.includes("linear-gradient"), `contentbar: the title that needs more than two lines has no fade at its end (${fadeBox ? fadeImage : "no element"})`);
  const nameBox = await rect('[data-testid="kit-contentbar"] [data-testid="bar-title"]'), subBox = await rect('[data-testid="kit-contentbar"] [data-testid="bar-sub"]');
  expect(nameBox && subBox && subBox.y >= nameBox.bottom - 1, `contentbar: the sub-line (${subBox?.y}) is not under the title (${nameBox?.bottom})`);
  expect(subBox && (await fontPx('[data-testid="kit-contentbar"] [data-testid="bar-sub"]')) === 13, "contentbar: the sub-line is not 13 px");
  const subLook = await textOf(c, '[data-testid="kit-contentbar"]', "Needs your approval");
  expect(subLook && subLook.colour === WARN_TEXT, `contentbar: the warning sub-line is ${subLook?.colour}, not ${WARN_TEXT}`);
  for (const [id, last] of [["kit-action-board", false], ["kit-action-more", true]]) {
    const a = await rect(`[data-testid="${id}"]`);
    expect(a && a.w >= 44 && a.h >= 44, `contentbar: ${id} is ${a?.w}×${a?.h}, under 44×44`);
    expect(a && cbar && a.right <= cbar.right + 0.5 && (!last || cbar.right - a.right <= 12), `contentbar: ${id} ends ${cbar && a && cbar.right - a.right} px from the bar's right end`);
    expect(a && name.right <= a.x + 1, `contentbar: the title block (to ${name.right}) overlaps ${id} (from ${a?.x})`);
  }
  const cback = await page.locator('[data-testid="kit-contentbar"] [data-testid="kit-place-back"]').first().boundingBox();
  expect(cback && cback.width >= 44 && cback.height >= 44, `contentbar: the back is ${cback?.width}×${cback?.height}`);

  // LargeTitle
  const large = await textOf(c, '[data-testid="kit-largetitle"]', "Home");
  expect(large && large.font === 34, `largetitle: the title is ${large?.font} px, not 34`);
  expect(await rect('[data-testid="kit-largetitle"] [data-testid="large-title"]') !== null, "largetitle: no large-title");

  // the warning text keeps 4.5:1 on the cell in the dark theme and in Mocha, then the light theme is back
  const seen = new Set([warn.colour]);
  for (const [theme, expected] of [["dark", "rgb(240, 181, 69)"], ["mocha", "rgb(249, 226, 175)"]]) {
    const b = T(`gallery-theme-${theme}`).first();
    await b.scrollIntoViewIfNeeded(); await press(b);
    await T("kit-section-cells").first().scrollIntoViewIfNeeded();
    expect(await until(async () => (await textOf(c, row("servers"), SUB))?.colour === expected), `cells: in ${theme} the warning sub-line is ${(await textOf(c, row("servers"), SUB))?.colour}, not ${expected}`);
    const r = await contrastOf(c, row("servers"), SUB);
    expect(r && r.ratio >= 4.5, `cells: in ${theme} the warning sub-line is ${r?.ratio.toFixed(2)}:1 on its cell`);
    seen.add(expected);
  }
  expect(seen.size === 3, "cells: the warning text is the same colour in every theme");
  await light.scrollIntoViewIfNeeded(); await press(light);
  expect(await until(async () => (await textOf(c, row("servers"), SUB))?.colour === WARN_TEXT), "cells: the light theme did not come back");
}
