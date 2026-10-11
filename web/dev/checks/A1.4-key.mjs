// Proves A1.4, its browser part: ⌘B (Ctrl+B off macOS) hides and shows the sidebar and reaches nothing else. With the
// keys in an editable canvas, no listener of the document hears its keydown, which is where Excalidraw listens, and
// the shapes stay selected; with the caret in the composer's box the box does not hear it, keeps its text, its
// caret and the focus. The browser's own action is cancelled, and a key held down toggles once. Under a dialog (the
// confirm dialog, the Servers dialog, the chat's tree) it does nothing and is left alone, shown or hidden; ⌘⇧B is
// still the tree's and toggles no sidebar. That the desktop app's menu does not take ⌘B is checked by hand.
import { act, check, openPage, seed, until } from "../shot.mjs";

await check("A1.4 ⌘B reaches neither the canvas nor the composer, and does nothing under a dialog", async ({ url, browser, fail, note }) => {
  await seed(url, "A1");
  const frames = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  const side = (page) => page.evaluate(() => ({ hidden: !!document.querySelector(".app > .side-rail") && !document.querySelector(".app > .side-pane").getClientRects().length, saved: localStorage.getItem("aiwb.side") }));
  const isHidden = async (page) => (await side(page)).hidden;
  /** Every keydown from now on, as three listeners hear it: the window first (after the page's own listener there,
   *  so it knows whether that one cancelled it), the document, and the element `at`. */
  const listen = (page, at) => page.evaluate((at) => {
    const heard = (window.__keys = { window: [], document: [], at: [] });
    const say = (e) => `${e.metaKey ? "⌘" : ""}${e.ctrlKey ? "⌃" : ""}${e.shiftKey ? "⇧" : ""}${e.code}${e.repeat ? " repeat" : ""}${e.defaultPrevented ? " cancelled" : ""}`;
    window.addEventListener("keydown", (e) => heard.window.push(say(e)), true);
    for (const capture of [true, false]) document.addEventListener("keydown", (e) => heard.document.push(say(e)), capture);
    if (at) document.querySelector(at).addEventListener("keydown", (e) => heard.at.push(say(e)));
  }, at);
  /** What they heard since the last call. */
  const heard = (page) => page.evaluate(() => { const k = window.__keys, was = { window: k.window, document: k.document, at: k.at }; Object.assign(k, { window: [], document: [], at: [] }); return was; });
  const B = (list) => list.filter((k) => k.includes("KeyB"));
  const open = async (o, body) => {
    const errors = [];
    const { ctx, page } = await openPage({ url, browser, errors, ...o });
    try { await body(page); } finally { for (const e of errors) fail(`page error: ${e}`); await ctx.close(); }
  };
  /** One press of the key that must toggle: the sidebar is then `want`, and the keydown went no further than the window. */
  const toggle = async (page, name, want, hasAt) => {
    await page.keyboard.press("ControlOrMeta+b");
    if (!await until(async () => await isHidden(page) === want, 10000)) fail(`${name}: ⌘B did not ${want ? "hide" : "show"} the sidebar`);
    const k = await heard(page);
    if (B(k.window).length !== 1 || !B(k.window)[0].endsWith("cancelled")) fail(`${name}: the window heard ${JSON.stringify(B(k.window))} for one ⌘B: not one keydown, cancelled`);
    if (B(k.document).length) fail(`${name}: the document heard ⌘B (${B(k.document).join(", ")}): the canvas listens there`);
    if (hasAt && B(k.at).length) fail(`${name}: the element with the focus heard ⌘B (${B(k.at).join(", ")})`);
  };

  // ---- the canvas of a board this window may edit, its three shapes selected
  await open({ sel: { board: "b_ui" } }, async (page) => {
    await act(page, "select");
    const picked = page.locator(".excalidraw .selected-shape-actions");
    const selected = await until(() => picked.count(), 10000);
    if (!selected) note("(the canvas shows no panel of the selected shapes: that they stay selected is not checked)");
    await listen(page);
    await page.keyboard.press("Shift");
    const first = await heard(page);
    if (!first.document.some((k) => k.includes("Shift"))) return fail(`the canvas: a key pressed there is not heard at the document (${JSON.stringify(first)}): the check would hear no ⌘B either`);
    await toggle(page, "the canvas", true);
    await toggle(page, "the canvas, hidden", false);
    await toggle(page, "the canvas, again", true);
    await frames(page);
    if (selected && !await picked.count()) fail("the canvas: the shapes are no longer selected after ⌘B");
    // a key held down: the keydowns that repeat toggle nothing
    await page.keyboard.down("ControlOrMeta");
    for (let i = 0; i < 4; i++) await page.keyboard.down("b");
    await page.keyboard.up("b"); await page.keyboard.up("ControlOrMeta");
    await frames(page);
    const held = await heard(page);
    if (B(held.window).length !== 4 || B(held.window).filter((k) => k.includes("repeat")).length !== 3) fail(`the canvas: four keydowns of a held ⌘B were heard as ${JSON.stringify(B(held.window))}`);
    if (await isHidden(page)) fail("the canvas: ⌘B held down toggled the sidebar more than once");
    if (B(held.document).length) fail(`the canvas: the document heard a repeated ⌘B (${B(held.document).join(", ")})`);
    note(`the canvas${selected ? ", three shapes selected" : ""}: ⌘B hid and showed the sidebar, cancelled, and the document heard no keydown of it`);
  });

  // ---- the composer's box
  await open({ sel: { chat: "c_plain" } }, async (page) => {
    const box = page.locator(".chat-page .composer .composer-input");
    await box.click();
    await page.keyboard.type("abc");
    await listen(page, ".chat-page .composer .composer-input");
    const state = () => box.evaluate((b) => ({ text: b.textContent, html: b.innerHTML, focus: document.activeElement === b, caret: getSelection().rangeCount ? getSelection().getRangeAt(0).endOffset : -1 }));
    for (const [name, want] of [["the composer", true], ["the composer, hidden", false]]) {
      await toggle(page, name, want, true);
      await frames(page);
      const s = await state();
      if (s.text !== "abc" || /<(b|strong)\b/i.test(s.html)) fail(`${name}: after ⌘B the box holds ${JSON.stringify(s.html)}`);
      if (!s.focus || s.caret !== 3) fail(`${name}: after ⌘B the box ${s.focus ? "has" : "has lost"} the focus, its caret at ${s.caret}`);
    }
    await page.keyboard.type("d");
    if (!await until(async () => (await state()).text === "abcd", 5000)) fail(`the composer: typing on after ⌘B gave ${JSON.stringify((await state()).text)}, not "abcd"`);
    note("the composer's box: ⌘B hid and showed the sidebar; the box heard no keydown of it and kept its text, its caret and the focus");
  });

  // ---- under a dialog: nothing, and the key is left alone
  await open({ sel: { chat: "c_plain" } }, async (page) => {
    await listen(page);
    /** ⌘B while `dialog` is open: the sidebar stays as it is, nothing is saved, the keydown is not cancelled. */
    const under = async (name, dialog) => {
      if (!await until(() => page.locator(dialog).isVisible(), 10000)) return fail(`${name}: it did not open`);
      const before = await side(page);
      await heard(page);
      await page.keyboard.press("ControlOrMeta+b");
      await frames(page);
      const after = await side(page), k = await heard(page);
      if (after.hidden !== before.hidden || after.saved !== before.saved) fail(`${name}: ⌘B under it ${after.hidden ? "hid" : "showed"} the sidebar (saved: ${JSON.stringify(after.saved)})`);
      if (B(k.window).length !== 1 || B(k.window)[0].includes("cancelled")) fail(`${name}: ⌘B under it was heard as ${JSON.stringify(B(k.window))}: not one keydown, left alone`);
      if (!await page.locator(dialog).isVisible()) fail(`${name}: ⌘B closed it`);
      await page.keyboard.press("Escape");
      if (!await until(async () => await page.locator(dialog).count() === 0, 10000)) fail(`${name}: Esc did not close it`);
    };
    const row = page.locator(".side-row.is-chat.on");
    await row.hover();
    await row.locator('.icon-btn[title="More"]').click();
    await page.locator(".side .menu .menu-item", { hasText: "Delete" }).click();
    await under("the confirm dialog", '.dialog[role="dialog"]');
    await page.locator(".side-foot .servers-btn").click();
    await under("the Servers dialog", '.servers-dialog[role="dialog"]');

    await page.keyboard.press("ControlOrMeta+Shift+b");
    if ((await side(page)).saved !== null) fail(`⌘⇧B saved the sidebar as ${JSON.stringify((await side(page)).saved)}: it is the tree's key`);
    await under("the chat's tree", '.fk-nav[role="dialog"]');

    // the same with the sidebar hidden: it stays hidden
    await toggle(page, "after the dialogs", true);
    await page.keyboard.press("ControlOrMeta+Shift+b");
    await under("the chat's tree, sidebar hidden", '.fk-nav[role="dialog"]');
    if (!await isHidden(page)) fail("the tree showed the hidden sidebar");
    await toggle(page, "after the tree", false);
    note("under the confirm dialog, the Servers dialog and the chat's tree ⌘B did nothing and was not cancelled; ⌘⇧B opened the tree and toggled nothing");
  });
});
