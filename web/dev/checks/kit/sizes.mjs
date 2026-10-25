// UX.F1-kit.mjs's section "sizes" (app/src/dev/kit/sizes.tsx): what it proves is listed in UX.F1-kit.mjs's header. `run(c)` gets the
// check's helpers (c.T, c.rect, c.press, c.open, c.expect, …: UX.F1-kit.mjs `body`) and calls c.fail for what is wrong.
//   Button: `touch` is 44 px high with 17 px text, `block` 50 px high, as wide as the section and 17 px, `md` and `sm` keep 13 and 12 px.
//   IconButton: `touch` 44 × 44, `md` 26 × 26. Switch: 44 × 44 holder, role switch, aria-checked flips on a press.
//   SecretInput: hidden (a password box) until the eye is pressed, then the typed text, in a monospace family.
//   DialogActions stacked: one above the other, the danger one first, both as wide as their container.
//   SearchField: 44 px high, 17 px text, the clear button shows with a word and empties the box, Cancel shows and clears and leaves.
// Every press writes `kit-sizes-last`.
export async function run(c) {
  const { T, rect, rects, fontPx, minFontPx, press, near, expect, until, page } = c;
  const last = async () => ((await T("kit-sizes-last").first().textContent()) ?? "").trim();
  const said = (what) => until(async () => (await last()) === what);
  const css = (id) => `[data-testid="${id}"]`;
  const section = css("kit-section-sizes");
  await T("kit-section-sizes").scrollIntoViewIfNeeded();

  // ---- Button
  for (const [id, h, px, name] of [["kit-btn-touch", 44, 17, "touch"], ["kit-btn-block", 50, 17, "block"]]) {
    await T(id).scrollIntoViewIfNeeded();
    const r = await rect(css(id));
    if (!expect(!!r, `Button ${name} is not on the gallery`)) continue;
    expect(r.h >= h - 0.5, `Button ${name} is ${r.h} px high, not at least ${h}`);
    expect(await minFontPx(css(id)) === px, `Button ${name}'s label is ${await minFontPx(css(id))} px, not ${px}`);
  }
  const block = await rect(css("kit-btn-block")), sec = await rect(section);
  if (block && sec) expect(near(block.w, sec.w, 2), `Button block is ${block.w} px wide, its section ${sec.w}: it does not fill it`);
  expect(await minFontPx(css("kit-btn-md")) === 13, `Button md's label is ${await minFontPx(css("kit-btn-md"))} px, not 13`);
  expect(await minFontPx(css("kit-btn-sm")) === 12, `Button sm's label is ${await minFontPx(css("kit-btn-sm"))} px, not 12`);
  for (const [id, what] of [["kit-btn-touch", "btn-touch"], ["kit-btn-block", "btn-block"], ["kit-btn-md", "btn-md"], ["kit-btn-sm", "btn-sm"]]) {
    await T(id).scrollIntoViewIfNeeded();
    await press(T(id));
    expect(await said(what), `a press on ${id} wrote "${await last()}", not "${what}"`);
  }

  // ---- IconButton
  const it = await rect(css("kit-icon-touch")), im = await rect(css("kit-icon-md"));
  if (expect(!!it, "IconButton touch is not on the gallery")) expect(it.w >= 43.5 && it.h >= 43.5, `IconButton touch is ${it.w} × ${it.h} px, not at least 44 × 44`);
  if (expect(!!im, "IconButton md is not on the gallery")) expect(near(im.w, 26, 0.5) && near(im.h, 26, 0.5), `IconButton md is ${im.w} × ${im.h} px, not 26 × 26`);
  await press(T("kit-icon-touch"));
  expect(await said("icon-touch"), `a press on the touch IconButton wrote "${await last()}"`);
  await press(T("kit-icon-md"));
  expect(await said("icon-md"), `a press on the md IconButton wrote "${await last()}"`);

  // ---- Switch
  const sw = T("kit-switch-touch").locator('[role="switch"]').first();
  await sw.scrollIntoViewIfNeeded();
  const sr = await sw.boundingBox();
  if (expect(!!sr, "the touch Switch has no element with role switch")) {
    expect(sr.width >= 43.5 && sr.height >= 43.5, `the touch Switch is ${sr.width} × ${sr.height} px, not at least 44 × 44`);
    expect(await sw.getAttribute("aria-checked") === "false", `the touch Switch starts with aria-checked ${await sw.getAttribute("aria-checked")}, not false`);
    await press(sw);
    expect(await until(async () => (await sw.getAttribute("aria-checked")) === "true"), "a press did not turn the touch Switch on (aria-checked)");
    expect(await said("switch on"), `turning the Switch on wrote "${await last()}"`);
    await press(sw);
    expect(await until(async () => (await sw.getAttribute("aria-checked")) === "false"), "a second press did not turn the touch Switch off (aria-checked)");
    expect(await said("switch off"), `turning the Switch off wrote "${await last()}"`);
  }

  // ---- SecretInput
  const secret = T("kit-secret").first();
  await secret.scrollIntoViewIfNeeded();
  await secret.fill("s3cret");
  const kind = () => secret.evaluate((e) => e.getAttribute("type") ?? "");
  expect(await kind() === "password", `the secret box is type "${await kind()}" before the eye is pressed, not a password`);
  expect(await secret.inputValue() === "s3cret", `the secret box holds "${await secret.inputValue()}", not what was typed`);
  const eye = T("kit-secret-eye").first();
  expect(await eye.getAttribute("aria-label") === "Show secret", `the eye is labelled "${await eye.getAttribute("aria-label")}", not "Show secret"`);
  const er = await eye.boundingBox();
  if (er) expect(er.width >= 43.5 && er.height >= 43.5, `the eye is ${er.width} × ${er.height} px, not at least 44 × 44`);
  await press(eye);
  expect(await said("secret shown"), `a press on the eye wrote "${await last()}"`);
  expect(await until(async () => (await kind()) !== "password"), "the secret is still a password box after the eye was pressed");
  expect(await secret.inputValue() === "s3cret", `the shown secret is "${await secret.inputValue()}", not "s3cret"`);
  expect(await eye.getAttribute("aria-label") === "Hide secret", `the eye is labelled "${await eye.getAttribute("aria-label")}" while the secret is shown, not "Hide secret"`);
  const family = await secret.evaluate((e) => getComputedStyle(e).fontFamily);
  expect(/mono|menlo|courier|consolas/i.test(family), `the secret box's font family is "${family}", not a monospace one`);
  await press(eye);
  expect(await until(async () => (await kind()) === "password"), "the secret is not hidden again by a second press on the eye");

  // ---- DialogActions stacked
  await T("kit-actions-stacked").scrollIntoViewIfNeeded();
  const box = await rect(css("kit-actions-stacked"));
  const btns = await rects(`${css("kit-actions-stacked")} ${css("btn")}`);
  const labels = await page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => (e.textContent ?? "").trim()), `${css("kit-actions-stacked")} ${css("btn")}`);
  if (expect(btns.length === 2, `the stacked actions hold ${btns.length} buttons, not 2`)) {
    expect(btns[0].bottom <= btns[1].y + 1, "the stacked actions are not one above the other");
    expect(labels[0] === "Remove server" && labels[1] === "Cancel", `the stacked actions read ${JSON.stringify(labels)}, not the primary (Remove server) first and Cancel last`);
    for (const b of btns) expect(box && near(b.w, box.w, 2), `a stacked button is ${b.w} px wide, its container ${box?.w}`);
    expect(btns.every((b) => b.h >= 49.5), `a stacked button is under 50 px high (${btns.map((b) => b.h).join(", ")})`);
  }
  await press(T("kit-actions-stacked").locator(css("btn")).nth(0));
  expect(await said("stacked remove"), `a press on the stacked primary wrote "${await last()}"`);
  await press(T("kit-actions-stacked").locator(css("btn")).nth(1));
  expect(await said("stacked cancel"), `a press on the stacked Cancel wrote "${await last()}"`);

  // ---- SearchField
  const inSearch = (id) => T("kit-search").locator(css(id)).first();
  const field = inSearch("search-field");
  await field.scrollIntoViewIfNeeded();
  const fr = await field.boundingBox();
  if (expect(!!fr, "the search field is not on the gallery")) expect(fr.height >= 43.5, `the search field is ${fr.height} px high, not at least 44`);
  expect(await fontPx(`${css("kit-search")} ${css("search-field")}`) === 17, `the search field's text is ${await fontPx(`${css("kit-search")} ${css("search-field")}`)} px, not 17`);
  expect(await T("kit-search").locator(css("search-clear")).count() === 0, "the clear button shows in an empty search field");
  expect(await T("kit-search").locator(css("search-cancel")).count() === 0, "Cancel shows before the search field has the focus");
  await field.fill("abc");
  expect(await until(async () => (await T("kit-search").locator(css("search-clear")).count()) === 1), "typing did not show the clear button");
  const clear = inSearch("search-clear");
  const cr = await clear.boundingBox();
  if (cr) expect(cr.width >= 43.5 && cr.height >= 43.5, `the clear button is ${cr.width} × ${cr.height} px, not at least 44 × 44`);
  expect(await clear.getAttribute("aria-label") === "Clear search", `the clear button is labelled "${await clear.getAttribute("aria-label")}", not "Clear search"`);
  await press(clear);
  expect(await until(async () => (await field.inputValue()) === ""), "the clear button did not empty the search field");
  expect(await until(async () => (await T("kit-search").locator(css("search-clear")).count()) === 0), "the clear button stays after the search field was emptied");
  await field.fill("abc");
  const cancel = inSearch("search-cancel");
  expect(await until(async () => (await T("kit-search").locator(css("search-cancel")).count()) === 1), "Cancel did not show beside a search field in use");
  const cn = await cancel.boundingBox();
  if (cn) expect(cn.height >= 43.5 && cn.width >= 43.5, `Cancel is ${cn.width} × ${cn.height} px, not at least 44 × 44`);
  expect(await fontPx(`${css("kit-search")} ${css("search-cancel")} *`) === 17, `Cancel's text is ${await fontPx(`${css("kit-search")} ${css("search-cancel")} *`)} px, not 17`);
  await press(cancel);
  expect(await said("search cancel"), `a press on Cancel wrote "${await last()}"`);
  expect(await until(async () => (await field.inputValue()) === ""), "Cancel did not empty the search field");
  expect(await until(async () => (await T("kit-search").locator(css("search-cancel")).count()) === 0), "Cancel stays after it was pressed");
  expect(await until(async () => !(await field.evaluate((e) => e === document.activeElement))), "the search field keeps the focus after Cancel");
}
